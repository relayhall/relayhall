// GrantService.ts — object-level authority management (RH-P2.3, task 03f50650).
//
// A grant is (grantee, resource, verb) with an optional typed wildcard
// (resource_id NULL = every object of the type) and optional expiry.
// Grantees are principals or GROUPS (the 078 seam, consumed at AZ-S1 —
// design 4d961e37 §3, A17.6): a group grant reaches members by membership
// join at query time in activeGrantCondition, never by materialized rows.
// Grant MUTATION stays out of the agent plane (the /grants routes sit
// behind the root sentinel); introspection of one's own grants is
// agent-plane readable (the A12.5 pattern).
//
// NOTHING here enforces anything: the shared authorization predicate
// (RH-P2.5) is the consumer of grantsFor()/activeGrantCondition(). The
// dormant visibility columns across the tree stay dormant until it lands.
//
// Revocation is DELETE, deliberately: grants are live authority
// configuration, not history (the 070 doctrine) — no revoked_at column
// means no partial unique index, which structurally removes the
// silent-fail-open-on-upsert class the credential substrate got burned by.
// Attribution is server-written; grant changes join the board-wide audit
// log when RH-P2.7 builds it (declared deferral, as in RH-P2.1).
import { pool } from '../db/connection';
import type { PoolClient } from 'pg';
import { scopesForRole } from '../utils/identityScopes';
import { resolveActorRole } from '../utils/taskAutomationRole';
import { authorizationService, type AuthorizationActor } from './AuthorizationService';
import { principalService } from './PrincipalService';
import { feedEventService, type FeedObjectType } from './FeedEventService';
import { auditService, type AuditActor } from './AuditService';
import {
  auditAuthorityMutationRefusal,
  authorityMutationRefusalMessage,
  authorityMutationSurfacesAmong,
} from '../utils/authorityMutationSurfaces';

// SETGOV (vocabulary amendment A25.5, AUTHZ amendment AZ-A5 clause 1): the
// ratified eight-value list takes its ninth member. `078_grants_substrate.sql`
// declares this list is where future object types land - "'phase' and 'plugin'
// are seam values (their tables land later in Phase 2 / Phase 4)" - and the
// same value joins the CHECK on `grants` and on `access_profile_rules` in
// migration 109. A deliberate contract change, not a weakening: the closure
// below is stricter for `surface` than for any of the eight.
export const GRANT_RESOURCE_TYPES = [
  'task', 'phase', 'project', 'report', 'skill', 'personality', 'service', 'plugin', 'surface', 'blueprint',
] as const;
export type GrantResourceType = (typeof GRANT_RESOURCE_TYPES)[number];

export const GRANT_VERBS = ['read', 'write', 'use', 'invoke', 'admin'] as const;
export type GrantVerb = (typeof GRANT_VERBS)[number];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GrantRecord {
  id: string;
  granteeType: 'principal' | 'group';
  granteeId: string;
  resourceType: GrantResourceType;
  resourceId: string | null;
  verb: GrantVerb;
  grantedByPrincipalId: string | null;
  expiresAt: string | null;
  createdAt: string;
  /**
   * RH-LENSES-b (design 96f0bd3d s7.3): how this row came to exist -
   * `manual` for every owner-plane act (this service is the only writer of
   * one), `creation-default` for a row `ProjectService.create` wrote inside
   * a project's own transaction, and `steward` reserved, DORMANT and with no
   * v1 writer at all.
   */
  origin: 'manual' | 'creation-default' | 'steward';
}

export class GrantError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'GrantError';
  }
}

/** AZ-A12 clause 3(e): the refusal names the one representation a Group has as a grantee. */
export const GROUP_GRANTEE_MESSAGE = "A Group is granted to with granteeType 'group' and its Group id; "
  + "a Group principal is never a granteeType 'principal' grantee (AZ-A12 clause 3e).";

const err = (status: number, code: string, message: string, field?: string) =>
  new GrantError(status, code, message, field);

/** A creation policy's audit row says when no grant was written because the
 * engine already admits the grantee (E407 item 2). */
function heldMetadata(grant: GrantRecord | null): Record<string, unknown> {
  return grant ? {} : { written: false, alreadyHeld: true, rule: 'E407 item 2: the authorization engine already admits the grantee' };
}

function mapRow(row: any): GrantRecord {
  return {
    id: row.id,
    granteeType: row.grantee_type,
    granteeId: row.grantee_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id ?? null,
    verb: row.verb,
    grantedByPrincipalId: row.granted_by_principal_id ?? null,
    expiresAt: row.expires_at ?? null,
    createdAt: row.created_at,
    // Migration 128 defaults the column to 'manual', so a row read back from
    // a pre-128 database or a stubbed pool still classifies as owner-plane
    // rather than as an unlabelled value no consumer can branch on.
    origin: row.origin ?? 'manual',
  };
}

export interface CreateGrantInput {
  granteeType?: unknown;
  granteeId?: unknown;
  resourceType?: unknown;
  resourceId?: unknown;
  verb?: unknown;
  expiresAt?: unknown;
}

/**
 * AZ-A9 clause 12 (ratified 2026-10-10 (E43), card 785e1eed): the grant-kind Approval a row is
 * written for. A SEPARATE parameter, never a field of `CreateGrantInput`, so
 * no request body handed to `create` (the /grants route passes its body
 * through) can stamp a row as approval-made.
 */
export interface GrantApprovalContext {
  approvalId: string;
  requesterPrincipalId: string;
  /** `change` (card 502fb19e, E325): a change request's grant.rows apply. */
  kind: 'grant' | 'change';
}

export class GrantService {
  /** Durable account ownership on NEW objects only. Caller supplies the
   * sponsor already verified under ordered principal locks; direct humans
   * are checked here. This never backfills a historical object on read. */
  private async recordCreationAccount(client: PoolClient, type: 'task' | 'report' | 'project',
    id: string, actor: AuthorizationActor, audit: AuditActor, sponsorId?: string): Promise<void> {
    const accountId = sponsorId ?? actor.principalId;
    if (!accountId) return;
    const result = await client.query(
      "SELECT id FROM principals WHERE id=$1 AND kind='human' AND status='active' AND parent_principal_id IS NULL AND NOT legacy_identity",
      [accountId]);
    if (result.rows.length !== 1) return;
    const ownershipSql = {
      task: 'UPDATE tasks SET account_owner_principal_id=$2 WHERE id=$1 AND account_owner_principal_id IS NULL',
      report: 'UPDATE reports SET account_owner_principal_id=$2 WHERE id=$1 AND account_owner_principal_id IS NULL',
      project: 'UPDATE projects SET owner_principal_id=$2 WHERE id=$1 AND owner_principal_id IS NULL',
    };
    await client.query(ownershipSql[type], [id, accountId]);
    await auditService.record({ action: `${type}.account_ownership`, actor: audit,
      resourceType: type, resourceId: id,
      metadata: { accountPrincipalId: accountId, basis: 'authenticated-creation', creatorPrincipalId: actor.principalId } }, client);
  }

  /** Owner-approved creation policy: exactly read/write on a newly inserted
   * Project to its authenticated caller, and the Project's owner column
   * (`recordCreationAccount`, first-wins: the human creator or its chain-root
   * human sponsor), which the evaluator's owner arm reads. No management scope
   * is granted. The caller's canonical route and object caps still apply. This
   * helper is invoked only by ProjectService's creating transaction, never
   * reads/replay. Audit metadata records policy provenance; grants.provenance
   * stays unset because that column marks non-revocable assignment vehicles. */
  async createForProjectCreator(client: PoolClient, projectId: string,
    actor: AuthorizationActor, audit: AuditActor): Promise<void> {
    if (!actor.authenticated || !actor.principalId || actor.principalId !== audit.principalId
      || !UUID_PATTERN.test(projectId)) throw err(403, 'PROJECT_CREATOR_REQUIRED', 'A resolved authenticated Project creator is required');
    const ids = [...new Set([actor.principalId, ...(actor.delegation?.links.map(link => link.principalId) ?? [])])].sort();
    const locked = await client.query('SELECT id,status,legacy_identity FROM principals WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [ids]);
    if (locked.rows.length !== ids.length || locked.rows.some(row => row.status !== 'active' || row.legacy_identity)) {
      throw err(409, 'PROJECT_CREATOR_UNAVAILABLE', 'The Project creator chain cannot receive new Grants');
    }
    const sponsor = await this.creationSponsor(client, actor, audit, 'project');
    await this.recordCreationAccount(client, 'project', projectId, actor, audit, sponsor?.principalId);
    for (const verb of ['read','write'] as const) {
      const grant = await this.createUnlessHeld(client, { granteeId: actor.principalId,
        resourceType: 'project', resourceId: projectId, verb }, audit);
      await auditService.record({ action: 'project.creator_access', actor: audit,
        resourceType: 'project', resourceId: projectId,
        metadata: { policy: 'project-creator-read-write', grantId: grant?.id ?? null, granteePrincipalId: actor.principalId, verb,
          ...heldMetadata(grant) } }, client);
    }
  }

  /** Ordinary Task creation policy. The actual creator and an authenticated
   * human sponsor receive exact revocable grants, never Task roles. */
  async createForTaskCreator(client: PoolClient, taskId: string,
    actor: AuthorizationActor, audit: AuditActor): Promise<void> {
    if (!actor.authenticated || !actor.principalId || actor.principalId !== audit.principalId
      || !UUID_PATTERN.test(taskId)
      || !authorizationService.authorizeRoute(actor, 'tasks:write').allowed) {
      throw err(403, 'TASK_CREATOR_REQUIRED', 'Authenticated Task creation authority is required');
    }
    const ids = [...new Set([actor.principalId, ...(actor.delegation?.links.map(link => link.principalId) ?? [])])].sort();
    const locked = await client.query('SELECT id,status,legacy_identity FROM principals WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [ids]);
    if (locked.rows.length !== ids.length || locked.rows.some(row => row.status !== 'active' || row.legacy_identity)) {
      throw err(409, 'TASK_CREATOR_UNAVAILABLE', 'The Task creator chain cannot receive new Grants');
    }
    // The ordered principal locks above keep parent/status/own-expression
    // coordinates stable. Resolve sponsorship only in this new-Task transaction;
    // neither an idempotent replay nor a read ever calls this helper again.
    const sponsor = await this.creationSponsor(client, actor, audit, 'task');
    await this.recordCreationAccount(client, 'task', taskId, actor, audit, sponsor?.principalId);
    for (const granteeId of [actor.principalId, ...(sponsor ? [sponsor.principalId] : [])]) {
      for (const verb of ['read', 'write'] as const) {
        const grant = await this.createUnlessHeld(client, { granteeId,
          resourceType: 'task', resourceId: taskId, verb }, audit);
        await auditService.record({ action: granteeId === actor.principalId ? 'task.creator_access' : 'task.sponsor_access',
          actor: audit, resourceType: 'task', resourceId: taskId,
          metadata: {
            policy: granteeId === actor.principalId ? 'task-creator-read-write' : 'task-human-sponsor-read-write-v1',
            grantId: grant?.id ?? null, granteePrincipalId: granteeId, verb, ...heldMetadata(grant),
            ...(granteeId === sponsor?.principalId ? {
              creatorPrincipalId: actor.principalId,
              sponsorPrincipalId: sponsor.principalId,
              credentialId: audit.credentialId,
              chain: sponsor.chain,
            } : {}),
          } }, client);
      }
    }
  }

  /** Ordinary standalone Report creation only; never inferred from a Task association. */
  async createForReportCreator(client: PoolClient, reportId: string,
    actor: AuthorizationActor, audit: AuditActor): Promise<void> {
    if (!actor.authenticated || !actor.principalId || actor.principalId !== audit.principalId
      || !UUID_PATTERN.test(reportId)
      || !authorizationService.authorizeRoute(actor, 'reports:write').allowed) {
      throw err(403, 'REPORT_CREATOR_REQUIRED', 'Authenticated Report creation authority is required');
    }
    const ids = [...new Set([actor.principalId, ...(actor.delegation?.links.map(link => link.principalId) ?? [])])].sort();
    const locked = await client.query('SELECT id,status,legacy_identity FROM principals WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [ids]);
    if (locked.rows.length !== ids.length || locked.rows.some(row => row.status !== 'active' || row.legacy_identity)) {
      throw err(409, 'REPORT_CREATOR_UNAVAILABLE', 'The Report creator chain cannot receive new Grants');
    }
    // The ordered principal locks above keep parent/status/own-expression
    // coordinates stable. Resolve sponsorship only in this new-Report transaction;
    // neither an idempotent replay nor a read ever calls this helper again.
    const sponsor = await this.creationSponsor(client, actor, audit, 'report');
    await this.recordCreationAccount(client, 'report', reportId, actor, audit, sponsor?.principalId);
    for (const granteeId of [actor.principalId, ...(sponsor ? [sponsor.principalId] : [])]) {
      for (const verb of ['read', 'write'] as const) {
        const grant = await this.createUnlessHeld(client, { granteeId,
          resourceType: 'report', resourceId: reportId, verb }, audit);
        await auditService.record({ action: granteeId === actor.principalId ? 'report.creator_access' : 'report.sponsor_access',
          actor: audit, resourceType: 'report', resourceId: reportId,
          metadata: {
            policy: granteeId === actor.principalId ? 'report-creator-read-write' : 'report-human-sponsor-read-write-v1',
            grantId: grant?.id ?? null, granteePrincipalId: granteeId, verb, ...heldMetadata(grant),
            ...(granteeId === sponsor?.principalId ? {
              creatorPrincipalId: actor.principalId,
              sponsorPrincipalId: sponsor.principalId,
              credentialId: audit.credentialId,
              chain: sponsor.chain,
            } : {}),
          } }, client);
      }
    }
  }

  /**
   * Owner ruling E407 item 2: a creation policy's grant is written ONLY when
   * it changes somebody's access. The authorization engine itself decides,
   * inside this creating transaction (`GrantEffectService.writeUnlessHeld`):
   * it is asked every question the grant could influence (the grantee, and the
   * widest identity that could ever sit below it, every action the verb
   * confers, on this object) before and after the row, and an unchanged
   * answer rolls the row back. The questions include what the row lets its
   * holder DELEGATE: the warrant, assignment (R3) and mint ceilings read the
   * holder's grant-and-profile inventory, not the engine's owner arm or a
   * Connector's own() cap, so a row that is the holder's only source for its
   * own selector stays written. So no row is written for an administrator
   * whose role derives root, or for a holder whose type-wide grant or profile
   * rule already contains it; the owner, an author and a Connector keep theirs
   * until those readers count the engine's other arms (a design question, not
   * this ruling's). Returns null when it was already held. Assignment grants
   * and owner-plane grants are not written here and keep their behaviour.
   */
  async createUnlessHeld(client: PoolClient,
    input: { granteeId: string; resourceType: 'task' | 'report' | 'project'; resourceId: string; verb: 'read' | 'write' },
    audit: AuditActor): Promise<GrantRecord | null> {
    // Loaded after module initialization, as DelegationService is below: the
    // evaluator imports the authorization modules that import this one.
    const { grantEffectService } = await import('./GrantEffectService');
    const tuple = { granteeType: 'principal' as const, ...input };
    const result = await grantEffectService.writeUnlessHeld(tuple, client,
      () => this.create(tuple, audit, client));
    return result.written;
  }

  /** A delegated creator's human Account is a creation-time sponsor, not a
   * runtime ancestor-access rule. The append-only audit is provenance only;
   * canonical ordinary grants are the sole new source of access. */
  private async creationSponsor(client: PoolClient, actor: AuthorizationActor, audit: AuditActor, resource: 'task' | 'report' | 'project'):
    Promise<{ principalId: string; chain: Array<{ principalId: string; kind: string; parentPrincipalId: string | null }> } | null> {
    const trusted = actor.delegation?.links;
    if (!trusted || trusted.length < 2 || trusted[trusted.length - 1].kind !== 'human') return null;
    // Load the maintained evaluator after module initialization: it imports
    // AccessProfileService, which imports this module's Grant vocabulary.
    const { delegationService, MAX_CHAIN_DEPTH } = await import('./DelegationService');
    if (trusted.length > MAX_CHAIN_DEPTH
      || trusted[0].principalId !== actor.principalId
      || !['service', 'agent'].includes(trusted[0].kind)
      || trusted.some((link, index) => link.legacyIdentity
        || link.parentPrincipalId !== (trusted[index + 1]?.principalId ?? null))
      || !audit.credentialId) {
      throw err(409, `${resource.toUpperCase()}_SPONSOR_UNAVAILABLE`, 'The authenticated human sponsor chain cannot receive new Grants');
    }

    // Re-read after waiting for the principal locks. A request resolved before
    // reparenting must never grant either the former or the new parent access.
    const current = await delegationService.resolveChain(actor.principalId!, client);
    if (!current.alive || current.links.length !== trusted.length
      || current.links.some((link, index) => link.status !== 'active' || link.legacyIdentity
        || link.principalId !== trusted[index].principalId || link.kind !== trusted[index].kind
        || link.parentPrincipalId !== trusted[index].parentPrincipalId)) {
      throw err(409, `${resource.toUpperCase()}_SPONSOR_UNAVAILABLE`, 'The authenticated human sponsor chain changed before creation');
    }
    // No credential lock is introduced into the principal-lock ordering.
    // Decision-time expiry, rather than transaction-start NOW(), closes a
    // credential expiring while this writer waits. Re-read its actual scopes.
    const credentials = await client.query(
      `SELECT scopes FROM principal_credentials
        WHERE id = $1 AND principal_id = $2 AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > clock_timestamp())
          AND (grace_until IS NULL OR grace_until > clock_timestamp())
          AND NOT EXISTS (
            SELECT 1 FROM unnest($3::uuid[]) AS delegated(principal_id)
             WHERE NOT EXISTS (
               SELECT 1 FROM principal_credentials live
                WHERE live.principal_id = delegated.principal_id AND live.revoked_at IS NULL
                  AND (live.expires_at IS NULL OR live.expires_at > clock_timestamp())
                  AND (live.grace_until IS NULL OR live.grace_until > clock_timestamp())
             )
          )`,
      [audit.credentialId, actor.principalId,
        current.links.filter(link => link.parentPrincipalId !== null).map(link => link.principalId)]);
    const credentialScopes: unknown = credentials.rows[0]?.scopes;
    if (credentials.rows.length !== 1 || !Array.isArray(credentialScopes)
      || !credentialScopes.every(scope => typeof scope === 'string')) {
      throw err(409, `${resource.toUpperCase()}_SPONSOR_UNAVAILABLE`, 'Current creator credential authority is required');
    }
    const account = current.links[current.links.length - 1];
    const fresh: AuthorizationActor = {
      ...actor,
      role: resolveActorRole({ handle: actor.handle, principalRole: current.links[0].role }),
      scopes: delegationService.effectiveScopes(current,
        (actor.scopes ?? []).filter(scope => credentialScopes.includes(scope)), scopesForRole(account.role)),
      delegation: { links: current.links },
    };
    if (!authorizationService.authorizeRoute(fresh, resource === 'task' ? 'tasks:write' : resource === 'project' ? 'projects:write' : 'reports:write').allowed) {
      throw err(403, `${resource.toUpperCase()}_CREATOR_REQUIRED`, `Current authenticated ${resource} creation authority is required`);
    }
    return { principalId: account.principalId, chain: current.links.map(link => ({
      principalId: link.principalId, kind: link.kind, parentPrincipalId: link.parentPrincipalId,
    })) };
  }

  /** List grants, optionally narrowed by grantee and/or resource type. */
  async list(filters: { granteeId?: string; resourceType?: string } = {}): Promise<GrantRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters.granteeId !== undefined) {
      if (!UUID_PATTERN.test(filters.granteeId)) {
        throw err(400, 'INVALID_QUERY_VALUE', 'granteeId must be a full UUID', 'granteeId');
      }
      params.push(filters.granteeId);
      clauses.push(`grantee_id = $${params.length}`);
    }
    if (filters.resourceType !== undefined) {
      if (!(GRANT_RESOURCE_TYPES as readonly string[]).includes(filters.resourceType)) {
        throw err(400, 'INVALID_QUERY_VALUE', `resourceType must be one of: ${GRANT_RESOURCE_TYPES.join(', ')}`, 'resourceType');
      }
      params.push(filters.resourceType);
      clauses.push(`resource_type = $${params.length}`);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT * FROM grants${where} ORDER BY created_at ASC, id ASC`,
      params,
    );
    return result.rows.map(mapRow);
  }

  /** A principal's own grants — the introspection read (A12.5 pattern). */
  async grantsFor(principalId: string): Promise<GrantRecord[]> {
    return this.list({ granteeId: principalId });
  }

  /**
   * THE GRANT ROW'S OWN VALIDATORS, extracted from `create` (AUTHZ amendment
   * AZ-A13 clause 8c, ratified 2026-10-11, E95): the resource type, the form of
   * `resourceId`, the verb, the `surface` closure (AZ-A5 clause 3, with the
   * authority-mutation half, owner ruling `70af4d82` §1.1) and the expiry.
   * `create` runs them on the row it is about to write; the in-place grant edit
   * (`AuthorityEditExecutor`) runs them on the row's state AFTER the edit, so a
   * closure dropped here is dropped for both. `act` names the audit action of a
   * refusal that is audited (`grant.create`, `grant.edit`).
   */
  async validateGrantFields(
    input: Pick<CreateGrantInput, 'resourceType' | 'resourceId' | 'verb' | 'expiresAt'>,
    actor: AuditActor,
    act: 'grant.create' | 'grant.edit',
  ): Promise<{ resourceId: string | null; expiresAt: string | null }> {
    if (typeof input.resourceType !== 'string' || !(GRANT_RESOURCE_TYPES as readonly string[]).includes(input.resourceType)) {
      throw err(422, 'INVALID_GRANT_VALUE', `resourceType must be one of: ${GRANT_RESOURCE_TYPES.join(', ')}`, 'resourceType');
    }
    let resourceId: string | null = null;
    if (input.resourceId !== undefined && input.resourceId !== null) {
      if (typeof input.resourceId !== 'string' || !UUID_PATTERN.test(input.resourceId)) {
        throw err(422, 'INVALID_GRANT_VALUE', 'resourceId must be a full UUID, or null/omitted for the type-wide wildcard', 'resourceId');
      }
      resourceId = input.resourceId;
    }
    if (typeof input.verb !== 'string' || !(GRANT_VERBS as readonly string[]).includes(input.verb)) {
      throw err(422, 'INVALID_GRANT_VALUE', `verb must be one of: ${GRANT_VERBS.join(', ')}`, 'verb');
    }
    // THE CLOSURE ON `surface` (AUTHZ amendment AZ-A5 clause 3; design
    // 7a9317b2 §2.6 I4; acceptance annex 85a2218d D19).
    //
    // `078` defines "resource_id NULL is the typed wildcard (all objects of the
    // type)" and `activeGrantCondition` honours it, so ONE hand-written wildcard
    // surface grant would confer an access level on every current AND FUTURE
    // governable Access surface - precisely the future-inclusive shape
    // `all-of-type` is excluded for in the profile store, reached through this
    // door instead. It is refused HERE and separately ignored by the evaluator,
    // so a row inserted by a path that bypasses this write surface widens
    // nothing and neither control alone carries the guarantee.
    if (input.resourceType === 'surface') {
      if (resourceId === null) {
        throw err(422, 'INVALID_GRANT_VALUE', "resourceId is REQUIRED for resourceType 'surface': the typed wildcard is refused on Access surfaces (AUTHZ amendment AZ-A5 clause 3)", 'resourceId');
      }
      // Verbs on a surface are `read` and `write` only: `use`, `invoke` and
      // `admin` are not admitted on this type (AZ-A5 clause 3). The access
      // LEVEL named `use` is a different thing at a different altitude and is
      // never a verb (A25.4).
      if (input.verb !== 'read' && input.verb !== 'write') {
        throw err(422, 'INVALID_GRANT_VALUE', "verb must be 'read' or 'write' for resourceType 'surface' (AUTHZ amendment AZ-A5 clause 3)", 'verb');
      }
      // THE AUTHORITY-MUTATION CLOSURE, `grants` half (owner ruling
      // `70af4d82` §1.1; annex `85a2218d` D21 clause (ii), D9's family).
      // The arm reads BOTH authority stores, so a `surface` grant naming
      // #15, #17 or #18 confers exactly what an Access-bundle membership
      // would - the reduced seed alone would leave this door open.
      //
      // On `pool` rather than the insert's client, and deliberately: this is a
      // validation, the id-to-KEY mapping it reads is catalogue metadata, and a
      // row that somehow slipped past it would still confer nothing, because
      // the arm re-reads the catalogue on EVERY request and returns before it
      // computes a level (`evaluateSurfaceStage` step 4b). Two locks, not one.
      const forbidden = await authorityMutationSurfacesAmong([resourceId], pool);
      if (forbidden.length > 0) {
        await auditAuthorityMutationRefusal(actor, forbidden[0].key, act);
        throw err(422, 'AUTHORITY_MUTATION_SURFACE', authorityMutationRefusalMessage(forbidden[0].key), 'resourceId');
      }
    }
    let expiresAt: string | null = null;
    if (input.expiresAt !== undefined && input.expiresAt !== null) {
      const parsed = new Date(String(input.expiresAt));
      if (Number.isNaN(parsed.getTime())) {
        throw err(422, 'INVALID_GRANT_VALUE', 'expiresAt must be an ISO timestamp', 'expiresAt');
      }
      if (parsed.getTime() <= Date.now()) {
        throw err(422, 'INVALID_GRANT_VALUE', 'expiresAt must be in the future', 'expiresAt');
      }
      expiresAt = parsed.toISOString();
    }
    return { resourceId, expiresAt };
  }

  /**
   * Create a grant. Grantees are ACTIVE principals or Groups (the 078 seam,
   * consumed at AZ-S1 — design 4d961e37 §3): a group grantee must resolve
   * to an existing group, and its authority reaches members by the
   * query-time membership join in activeGrantCondition.
   */
  async create(
    input: CreateGrantInput,
    actorInput: AuditActor | string | null,
    transactionClient?: PoolClient,
    approval?: GrantApprovalContext,
  ): Promise<GrantRecord> {
    const actor: AuditActor = typeof actorInput === 'object' && actorInput !== null
      ? actorInput
      : { principalId: actorInput, handle: actorInput ?? 'system', authMethod: actorInput ? 'unknown' : 'system' };
    const granteeType = input.granteeType === undefined ? 'principal' : input.granteeType;
    if (granteeType !== 'principal' && granteeType !== 'group') {
      throw err(422, 'INVALID_GRANT_VALUE', "granteeType must be 'principal' or 'group'", 'granteeType');
    }
    if (typeof input.granteeId !== 'string' || !UUID_PATTERN.test(input.granteeId)) {
      throw err(422, 'INVALID_GRANT_VALUE', `granteeId must be a ${granteeType} UUID`, 'granteeId');
    }
    if (granteeType === 'principal') {
      const principal = await principalService.getPrincipalById(input.granteeId);
      if (!principal) {
        throw err(422, 'GRANTEE_NOT_FOUND', 'granteeId resolves to no principal', 'granteeId');
      }
      // AZ-A12 clause 3(e): a Group principal is never a principal grantee.
      // The Group's one representation as a grantee is granteeType 'group',
      // which the membership join resolves at query time.
      if (principal.kind === 'group') {
        throw err(422, 'GROUP_PRINCIPAL_NOT_A_GRANTEE', GROUP_GRANTEE_MESSAGE, 'granteeId');
      }
      if (principal.status !== 'active') {
        throw err(422, 'GRANTEE_DISABLED', 'grants cannot be issued to a disabled principal', 'granteeId');
      }
      if (principal.legacyIdentity) {
        // T37 (§10): legacy identities are frozen out; the refusal is audited.
        await auditService.record({
          action: 'legacy.refused', actor, outcome: 'denied',
          resourceType: 'principal', resourceId: input.granteeId,
          metadata: { act: 'grant.create' },
        });
        throw err(409, 'LEGACY_FROZEN', 'legacy identities are frozen out of new grants (§10, T37)', 'granteeId');
      }
    } else {
      const group = await pool.query('SELECT id FROM groups WHERE id = $1', [input.granteeId]);
      if (group.rows.length === 0) {
        throw err(422, 'GRANTEE_NOT_FOUND', 'granteeId resolves to no group', 'granteeId');
      }
    }
    const { resourceId, expiresAt } = await this.validateGrantFields(input, actor, 'grant.create');

    const client = transactionClient ?? await pool.connect();
    try {
      if (!transactionClient) await client.query('BEGIN');
      // AZ-A9 clause 12: an approval-made row names its Approval. Without an
      // approval context this INSERT is the 078 one, byte for byte.
      const result = approval
        ? await client.query(
          `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id, expires_at, approval_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          [granteeType, input.granteeId, input.resourceType, resourceId, input.verb, actor.principalId ?? null, expiresAt, approval.approvalId],
        )
        : await client.query(
          `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [granteeType, input.granteeId, input.resourceType, resourceId, input.verb, actor.principalId ?? null, expiresAt],
        );
      const grant = mapRow(result.rows[0]);
      await auditService.record({
        action: 'grant.create',
        actor,
        resourceType: 'grant',
        resourceId: grant.id,
        metadata: {
          granteeId: grant.granteeId,
          resourceType: grant.resourceType,
          resourceId: grant.resourceId,
          verb: grant.verb,
          expiresAt: grant.expiresAt,
          // RH-LENSES-b: design s9 extends both existing grant acts with
          // `origin`, so a reader of the ledger can tell an owner-plane grant
          // from one an act wrote. This service writes only `manual` rows.
          origin: grant.origin,
          // AZ-A9 clause 14: a row an approval wrote says which, for whom.
          ...(approval
            ? { approvalId: approval.approvalId, requesterPrincipalId: approval.requesterPrincipalId, kind: approval.kind }
            : {}),
        },
      }, client);

      // RH-P3.C1: an ACL change over a feed object is itself a feed event
      // (strategy 4e40f06f §2.6.1 - revocation must propagate into
      // downstream indexes). Content-free by constraint; concrete-object
      // grants only - a typed-NULL wildcard covers a whole type and has no
      // single object to emit for (the scoped-consumer slice-transition
      // semantics stay a named, unimplemented v1 seam per the C5 ruling).
      const FEED_OBJECT_TYPES = new Set(['task', 'phase', 'project', 'report', 'skill', 'personality']);
      if (grant.resourceId && FEED_OBJECT_TYPES.has(grant.resourceType)) {
        await feedEventService.emit(client, {
          name: grant.resourceType + '.acl_changed',
          objectType: grant.resourceType as FeedObjectType,
          objectId: grant.resourceId,
          actorPrincipalId: actor.principalId ?? null,
          actorHandle: actor.handle ?? null,
          // The principal whose entitlement THIS transition changes. Recorded
          // so the content-free acl_changed reaches the party entitled
          // immediately BEFORE a revocation — their grant row is gone by
          // read time, so no current-state basis can fire (round 2, F3).
          ownerPrincipalId: grant.granteeType === 'principal' ? grant.granteeId : null,
          payload: {},
        });
      }
      if (!transactionClient) await client.query('COMMIT');
      return grant;
    } catch (e) {
      if (!transactionClient) await client.query('ROLLBACK');
      if (e instanceof Error && e.message.includes('duplicate key')) {
        throw err(409, 'GRANT_EXISTS', 'An identical grant already exists (grantee, resource, verb)');
      }
      throw e;
    } finally {
      if (!transactionClient) client.release();
    }
  }

  /** Revoke = DELETE (live configuration, not history — 070 doctrine).
   *
   * RH-P3.AZ-S7 (ruling 7440b579 R1): a grant this machinery materialized
   * as an assignment's access vehicle is NOT owner-plane configuration —
   * deleting it here would recreate exactly the assigned-but-invisible
   * state R1 makes unrepresentable. Such a grant is refused with the act
   * that DOES remove it named: unassign the task, or revoke the warrant
   * carrying it. The provenance column is the marker, and it is only ever
   * set by the vehicle machinery. */
  async remove(
    id: string,
    actor: AuditActor = { handle: 'system', authMethod: 'system' },
    // Card 502fb19e (E325): a change request's grant.revoke applies inside its
    // decide transaction. Without a client this act is its own transaction, as
    // it always was.
    transactionClient?: PoolClient,
    // The decision ledger a change decide adds to this act's EXISTING
    // grant.revoke audit row (change requests section 7.1): approvalId, kind,
    // targetType, deciderStanding, stepUp, before, after, chain. The direct
    // act passes none and its row is unchanged.
    decisionLedger?: Record<string, unknown>,
  ): Promise<GrantRecord> {
    if (!UUID_PATTERN.test(id)) {
      throw err(400, 'INVALID_GRANT_ID', 'grant id must be a full UUID');
    }
    const owned = await (transactionClient ?? pool).query('SELECT provenance FROM grants WHERE id = $1', [id]);
    if (owned.rows.length > 0 && owned.rows[0].provenance) {
      await auditService.record({
        action: 'grant.revoke', actor, outcome: 'denied', resourceType: 'grant', resourceId: id,
        metadata: { refusal: 'GRANT_CARRIES_ASSIGNMENT', provenance: owned.rows[0].provenance },
      });
      throw err(409, 'GRANT_CARRIES_ASSIGNMENT',
        'this grant carries an execution assignment\u2019s access (ruling 7440b579 R1) — remove it by unassigning the task, or by revoking the warrant that carries it');
    }
    const client = transactionClient ?? await pool.connect();
    try {
      if (!transactionClient) await client.query('BEGIN');
      const result = await client.query('DELETE FROM grants WHERE id = $1 RETURNING *', [id]);
      if (result.rows.length === 0) {
        throw err(404, 'GRANT_NOT_FOUND', 'No such grant');
      }
      const grant = mapRow(result.rows[0]);
      await auditService.record({
        action: 'grant.revoke',
        actor,
        resourceType: 'grant',
        resourceId: grant.id,
        metadata: {
          granteeId: grant.granteeId,
          resourceType: grant.resourceType,
          resourceId: grant.resourceId,
          verb: grant.verb,
          origin: grant.origin,
          ...(decisionLedger ?? {}),
        },
      }, client);

      // RH-P3.C1: an ACL change over a feed object is itself a feed event
      // (strategy 4e40f06f §2.6.1 - revocation must propagate into
      // downstream indexes). Content-free by constraint; concrete-object
      // grants only - a typed-NULL wildcard covers a whole type and has no
      // single object to emit for (the scoped-consumer slice-transition
      // semantics stay a named, unimplemented v1 seam per the C5 ruling).
      const FEED_OBJECT_TYPES = new Set(['task', 'phase', 'project', 'report', 'skill', 'personality']);
      if (grant.resourceId && FEED_OBJECT_TYPES.has(grant.resourceType)) {
        await feedEventService.emit(client, {
          name: grant.resourceType + '.acl_changed',
          objectType: grant.resourceType as FeedObjectType,
          objectId: grant.resourceId,
          actorPrincipalId: actor.principalId ?? null,
          actorHandle: actor.handle ?? null,
          // The principal whose entitlement THIS transition changes. Recorded
          // so the content-free acl_changed reaches the party entitled
          // immediately BEFORE a revocation — their grant row is gone by
          // read time, so no current-state basis can fire (round 2, F3).
          ownerPrincipalId: grant.granteeType === 'principal' ? grant.granteeId : null,
          payload: {},
        });
      }
      if (!transactionClient) await client.query('COMMIT');
      return grant;
    } catch (e) {
      if (!transactionClient) await client.query('ROLLBACK');
      throw e;
    } finally {
      if (!transactionClient) client.release();
    }
  }

  /**
   * THE P2.5 SEAM: a SQL-composable condition selecting the active grant
   * rows for one principal, resource type and verb, honouring wildcard and
   * expiry. The shared authorization predicate composes this into its arms;
   * list surfaces compose it into WHERE clauses for narrowing — point/list
   * SQL parity is structural because both go through THIS text.
   *
   * The GROUP ARM (AZ-S1, design 4d961e37 §3): grants.grantee_type='group'
   * resolves by membership join at query time. The join demands the member
   * principal be ACTIVE, so a disabled — and, post-096, terminated —
   * Account loses every group-derived authority on its very next request
   * (T34); no denormalized membership cache exists to go stale.
   */
  activeGrantCondition(paramOffset: number, options: { exactOnly?: boolean; excludeVehicleRole?: boolean } = {}): {
    sql: string;
    bind: (principalId: string, resourceType: GrantResourceType, verb: GrantVerb) => unknown[];
  } {
    const p1 = `$${paramOffset}`;
    const p2 = `$${paramOffset + 1}`;
    const p3 = `$${paramOffset + 2}`;
    return {
      sql:
        `EXISTS (SELECT 1 FROM grants g WHERE ` +
        `((g.grantee_type = 'principal' AND g.grantee_id = ${p1}) ` +
        `OR (g.grantee_type = 'group' AND g.grantee_id IN (` +
        `SELECT gm.group_id FROM group_members gm ` +
        `JOIN principals mp ON mp.id = gm.account_principal_id AND mp.status = 'active' ` +
        `WHERE gm.account_principal_id = ${p1}))) ` +
        `AND g.resource_type = ${p2} AND g.verb = ${p3} ` +
        // The typed wildcard stays exactly as ratified for the eight object
        // types, and is IGNORED for `surface` (AZ-A5 clause 3, annex D19): a
        // NULL-`resource_id` surface row inserted by any path that bypasses
        // `create` above confers nothing on any surface.
        // The approved Project-to-Task arm uses the same live Grant evaluator
        // with an exact coordinate; existing callers retain typed wildcards.
        (options.exactOnly
          ? `AND g.resource_id = <RESOURCE_ID_COLUMN> `
          : `AND (g.resource_id = <RESOURCE_ID_COLUMN> `
            + `OR (g.resource_id IS NULL AND g.resource_type <> 'surface')) `) +
        `AND (g.expires_at IS NULL OR g.expires_at > NOW()) ` +
        (options.excludeVehicleRole
          ? `AND NOT (g.provenance = 'assignment:grant' AND EXISTS (` +
            `SELECT 1 FROM access_vehicle_links role_l WHERE role_l.target_kind = 'grant' ` +
            `AND role_l.target_id = g.id AND role_l.vehicle_kind = 'role' ` +
            `AND role_l.created_by_vehicle)) `
          : '') + `)`,
      bind: (principalId, resourceType, verb) => [principalId, resourceType, verb],
    };
  }
}

export const grantService = new GrantService();
