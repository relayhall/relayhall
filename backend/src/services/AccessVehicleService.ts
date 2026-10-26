// AccessVehicleService.ts — RH-P3.AZ-S7 (card 446240c4): assignment-access
// coupling (owner ruling 7440b579 R1–R6/R8; AUTHZ amendment AZ-A2, design
// 4d961e37 §709–745; contract note d3accc39).
//
// R1: a task may not be assigned to a Connector unless the assignment act
// simultaneously ensures the assignee chain can READ that task through the
// EXISTING ratified arms. The assigned-but-invisible state becomes
// UNREPRESENTABLE, so strategy 4e40f06f §2.6.4's "grants ∪ current
// assignments" union is satisfied BY CONSTRUCTION. **The §1 shared
// predicate gains NO arm** — this file adds none, mints no scope string
// and mints no vocabulary noun ("vehicle" is descriptive prose in the
// ruling, and stays internal machinery here: no route, event name or UI
// label introduces the word).
//
// WHERE THE VEHICLE LANDS (chain-aware targeting, AZ-24/AZ-26). Reading
// the ratified intersection in AuthorizationService.sqlCondition: a
// DELEGATED link's side reduces to its own() cap — `capSql AND (capSql OR
// authorityCore(link))` ≡ `capSql` — so grants or profiles on the
// Connector itself cannot widen anything. Only the chain ROOT Account's
// side carries object authority. The vehicle therefore lands on the
// Account, which is exactly the empirical C2 finding that a
// parent-derived Connector needed its ACCOUNT granted. A delegated link
// whose own() EXCLUDES the task can never be fixed by a vehicle — own()
// is THE narrowing tool (§5.1) and the server never edits it as a side
// effect — so the assignment is refused.
//
// THE PROOF, NOT THE INTENTION. After materializing, this service re-runs
// the REAL production predicate for (assignee chain, read, task) ON THE
// ASSIGNMENT'S OWN TRANSACTION. If the assignee still cannot read the
// task, the whole assignment is refused and rolled back. That is what
// makes "unrepresentable" a fact.
//
// THE B5-CLASS TRAP (owner default D4). Neither `grants` (078) nor
// `access_profile_assignments` (095) carries provenance or a refcount, and
// both are UNIQUE on the tuple a vehicle would want — so a naive
// reference-counted removal would DELETE AN OWNER-CREATED ROW. Migration
// 100's `access_vehicle_links` carries the refcount instead;
// `created_by_vehicle` is decided ONCE per target, and a target is dropped
// at refcount zero ONLY when this machinery created it.
import { RequestFaultError } from '../utils/httpErrors';
import type { PoolClient } from 'pg';
import { pool } from '../db/connection';
import { auditService, type AuditActor } from './AuditService';
import { feedEventService, type FeedObjectType } from './FeedEventService';
import { delegationService, type DelegationChain } from './DelegationService';
import { accessProfileService, type ProfileRule } from './AccessProfileService';
import { authorizationRepository } from './AuthorizationRepository';
import { ADMINISTRATOR_ROLES, grantAllows, type AuthorizationActor } from './AuthorizationService';
import type { GrantResourceType, GrantVerb } from './GrantService';
import { rulesCovered, rulesCoveredWithCoordinates, sourcesFromEffectiveAccess, sourcesFromRules } from '../utils/authorityContainment';
import {
  ROLE_GRANT_DEFAULT_INTERVAL, ROLE_GRANT_EXPIRY_FIELD, ROLE_GRANT_EXPIRY_ISO_FORMAT,
  type RoleGrantExpiryRequest,
} from '../utils/roleGrantExpiry';


/**
 * The identity a genuine SERVER-SIDE act carries into the R3 cap: the board
 * itself, acting on nobody's behalf (a migration, a sweep). It is named
 * once, explicitly, so that using it is always a visible decision — never
 * the accidental result of a caller that forgot to pass a principal.
 */
export const SYSTEM_AUTHORIZATION_ACTOR: AuthorizationActor = {
  principalId: null,
  handle: 'system',
  role: 'admin',
  scopes: ['root'],
  authenticated: true,
  delegation: null,
};
const FEED_OBJECT_TYPES = new Set<string>(['task', 'phase', 'project', 'report', 'skill', 'personality']);

/** R2(b) / owner default D5: READ verb only, DIRECT references only. */
const VEHICLE_VERB: GrantVerb = 'read';

export class AssignmentAccessError extends RequestFaultError {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly field?: string,
  ) {
    super(status, code, message);
    this.name = 'AssignmentAccessError';
  }
}

const err = (status: number, code: string, message: string, field?: string) =>
  new AssignmentAccessError(status, code, message, field);

/** The transaction handle a vehicle act rides on — always the open
 * transaction of the task write it couples to (R1: "simultaneously"). */
export interface VehicleClient {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}

export type TaskGrantRole = 'implementer' | 'verifier' | 'shepherd';

export interface VehicleAttachInput {
  taskId: string;
  /** services.id — the Connector registry row the task is assigned to. */
  serviceId: string;
  /** R2(a): the chosen Warrant, or null for the R2(b) auto-grant fallback. */
  warrantId?: string | null;
  /** Audit identity of the ASSIGNER. */
  actor: AuditActor;
  /** Authorization identity of the ASSIGNER — the R3 non-escalation cap. */
  assigner: AuthorizationActor;
  /**
   * AZ-A10 clause 6: the date the assigning act set for the rows it writes,
   * or `undefined` for the default (materialization + 3 months). E62: any
   * assigner that performs the act may set it, earlier or later; nothing
   * here asks who the assigner is.
   */
  roleGrantExpiry?: RoleGrantExpiryRequest;
}

/**
 * AZ-A10 clause 8's audit shape for one assigning act's date: what was asked
 * for, what this task's links now carry, and whether the date came from the
 * default or from the assigner.
 */
export interface AppliedRoleGrantExpiry {
  /** The canonical instant asked for, `'unlimited'`, or null when the field was omitted. */
  requested: string | null;
  /** The date this task's links carry: a canonical instant, or null = until the task or the assignment ends. */
  applied: string | null;
  source: 'default' | 'assigner';
}

export interface VehicleTarget {
  targetKind: 'grant' | 'profile_assignment';
  targetId: string;
  createdByVehicle: boolean;
  resourceType?: GrantResourceType;
  resourceId?: string | null;
}

export interface VehicleAttachResult {
  vehicleKind: 'warrant' | 'auto-grant' | 'role';
  warrantId: string | null;
  landedOnPrincipalId: string;
  assigneePrincipalId: string;
  targets: VehicleTarget[];
  /** null for a warrant-carried assignment, which keeps the warrant's own lifecycle. */
  roleGrantExpiry: AppliedRoleGrantExpiry | null;
}

interface ChainResolution {
  chain: DelegationChain;
  assignee: { principalId: string; legacyIdentity: boolean };
  root: { principalId: string; role: string | null; legacyIdentity: boolean };
}

/** Does one own()-rule set cover (task, read) for this task? Mirrors the
 * objects half of the ratified chain cap for exactly that case. */
/** EXPORTED for the controls (card 95572530). A classification cannot check
 * itself: a test that re-implements this decision beside it proves only that
 * two copies agree. The suite calls THIS function, across the same seam
 * `resolveChainForTask` calls it across. */
export function ownRulesCoverTaskRead(rules: ProfileRule[], taskId: string): boolean {
  return rules.some((rule) => {
    if (rule.resourceType !== 'task') return false;
    if (!rule.verbs.some((verb) => grantAllows(verb, 'read'))) return false;
    if (rule.selectorForm === 'all-of-type') return true;
    if (rule.selectorForm === 'exact') return rule.selectorIds.includes(taskId);
    if (rule.selectorForm === 'all-except') return !rule.selectorIds.includes(taskId);
    // EXHAUSTIVE, AND THE DEFAULT COVERS NOTHING (RH-AZ.PROJ-b). The trailing
    // branch used to be `all-except` unlabelled, so `all-in-project` — a rule
    // pinned to ONE project, holding PROJECT ids — would have been read as
    // "every task except those three ids" and would have covered essentially
    // every task on the board.
    //
    // `all-in-project` genuinely cannot be answered here: this is a pure
    // function of (rules, taskId) and the answer needs the Task's project row.
    // It therefore refuses, in the conservative algebra `authorityContainment`
    // states — a coverage question the checker cannot PROVE refuses loudly, and
    // the caller turns that into ASSIGNEE_AUTHORITY_EXCLUDES_TASK. The effect
    // is a narrowing: an assignment is refused, never admitted. Widening it
    // into a proof is the named rider ab85d103 (AZ-S2 assignment validation),
    // which is where the task row is already open.
    return false;
  });
}

export class AccessVehicleService {
  /** Logical tuple TRY locks cover absent creation and all reference mutations.
   * Task NOWAIT precedes discovery: every writer stabilizes its own Task.
   * Target row locks are NOWAIT and every mutation versions the target row.
   * RC refreshes queries; RR/SERIALIZABLE stale versions fail the WHOLE owner
   * with ASSIGNMENT_REFERENCE_BUSY, never refresh/weaken a plan snapshot.
   * Task/tuple/row conflicts add no wait edge after caller Task/warrant/feed
   * locks. Feed/audit keep their existing order. No internal retry or commit.
   * Owners must rollback supplied transactions and discard afterCommit effects.
   */
  private async referenceQuery(client: VehicleClient, sql: string, values: any[] = []) {
    try { return await client.query(sql, values); }
    catch (error: any) {
      if (['40001', '55P03', '23505'].includes(error?.code)) {
        throw err(409, 'ASSIGNMENT_REFERENCE_BUSY', 'Assignment reference lifecycle busy; roll back and retry the transaction');
      }
      throw error;
    }
  }
  private async lockReferenceTask(client: VehicleClient, taskId: string): Promise<void> {
    await this.referenceQuery(client, 'SELECT id FROM tasks WHERE id=$1 FOR UPDATE NOWAIT', [taskId]);
  }
  private async versionReferenceTarget(client: VehicleClient, kind: string, id: string): Promise<void> {
    const table = kind === 'grant' ? 'grants' : 'access_profile_assignments';
    const locked = await this.referenceQuery(client, `SELECT id FROM ${table} WHERE id=$1 FOR UPDATE NOWAIT`, [id]);
    if (!locked.rows.length) throw err(409, 'ASSIGNMENT_REFERENCE_BUSY', 'Assignment target changed; roll back and retry the transaction');
    // MVCC fence: even shared-reference changes (no final deletion) invalidate
    // a higher-isolation stale target/refcount snapshot. Data stays unchanged.
    await this.referenceQuery(client, `UPDATE ${table} SET id=id WHERE id=$1`, [id]);
  }

  private async lockReferenceTarget(client: VehicleClient, tuple: unknown[]): Promise<void> {
    const key = JSON.stringify(tuple.map(value => typeof value === "string" ? value.toLowerCase() : value));
    const locked = await client.query(
      `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked`,
      ["relayhall:vehicle-reference:" + key],
    );
    if (!locked.rows[0]?.locked) {
      throw err(409, "ASSIGNMENT_REFERENCE_BUSY", "Assignment reference lifecycle busy; roll back and retry the transaction");
    }
  }

  /** Resolve the same logical identities creation locks BEFORE removing links.
   * Only this service changes vehicle links; callers serialize edits of their
   * own Task. Other Tasks may share these targets and are guarded here.
   */
  private async lockTaskReferenceTargets(client: VehicleClient, taskId: string): Promise<void> {
    await this.lockReferenceTask(client, taskId);
    const targets = await client.query(
      `SELECT l.target_kind, l.target_id, g.grantee_type, g.grantee_id, g.resource_type, g.resource_id, g.verb,
              p.profile_id, p.assignee_type, p.assignee_id
         FROM access_vehicle_links l
         LEFT JOIN grants g ON l.target_kind = 'grant' AND g.id = l.target_id
         LEFT JOIN access_profile_assignments p ON l.target_kind = 'profile_assignment' AND p.id = l.target_id
        WHERE l.task_id = $1`, [taskId],
    );
    const tuples = targets.rows.flatMap(row => row.target_kind === "grant"
      ? row.grantee_id ? [["grant", row.grantee_type, row.grantee_id, row.resource_type, row.resource_id, row.verb]] : []
      : row.profile_id ? [["profile_assignment", row.profile_id, row.assignee_type, row.assignee_id]] : []);
    // Deterministic acquisition aids diagnosis; nonblocking is what prevents
    // inversion across multi-target attach/recompute/swap operations.
    for (const key of [...new Set(tuples.map(tuple => JSON.stringify(tuple)))].sort()) {
      await this.lockReferenceTarget(client, JSON.parse(key));
    }
    for (const row of targets.rows) {
      if (row.grantee_id || row.profile_id) await this.versionReferenceTarget(client, row.target_kind, String(row.target_id));
    }
  }

  // ── chain resolution ────────────────────────────────────────────────

  /** Resolve the assignee Connector principal for a registry row. */
  private async assigneePrincipalFor(client: VehicleClient, serviceId: string): Promise<string> {
    const row = await client.query(
      'SELECT id, kind, principal_id FROM services WHERE id = $1',
      [serviceId],
    );
    if (row.rows.length === 0) {
      throw err(422, 'ASSIGNEE_NOT_FOUND', 'the execution assignee resolves to no Service registry row', 'executionProfile');
    }
    if (!row.rows[0].principal_id) {
      // A17.2: only connector-kind rows carry an identity. A plain Service
      // has no chain to give access to, so R1 cannot be satisfied for it.
      throw err(422, 'ASSIGNEE_NOT_IDENTITY',
        'only a Connector (a Service that carries a delegated identity, A17.2) can hold an execution assignment',
        'executionProfile');
    }
    return String(row.rows[0].principal_id);
  }

  /** Chain + own()-cap validation (§5.1, AZ-24/AZ-26). Refuses fail-closed. */
  private async resolveChainForTask(assigneePrincipalId: string, taskId: string): Promise<ChainResolution> {
    const chain = await delegationService.resolveChain(assigneePrincipalId);
    if (!chain.alive) {
      throw err(409, 'ASSIGNEE_CHAIN_DEAD',
        `the assignee chain is not live, so the assignment cannot be given the access it needs (§5.1): ${chain.deadReason}`,
        'executionProfile');
    }
    const acting = chain.links[0];
    const root = chain.links[chain.links.length - 1];
    for (const link of chain.links) {
      if (!link.parentPrincipalId || link.legacyIdentity) continue;
      const own = link.ownExpression;
      if (!own) {
        // Inheritance is never implicit (AZ-24).
        throw err(409, 'ASSIGNEE_AUTHORITY_EXCLUDES_TASK',
          `delegated principal ${link.principalId} carries no own() expression, so it holds EMPTY authority and nothing can make the task reachable for it (AZ-24)`,
          'executionProfile');
      }
      if (own.objects === 'parent') continue;
      if (!ownRulesCoverTaskRead(own.objects, taskId)) {
        throw err(409, 'ASSIGNEE_AUTHORITY_EXCLUDES_TASK',
          `delegated principal ${link.principalId} has an own() expression that excludes this task, and own() is the principal-level narrowing tool the server never edits as a side effect (§5.1)`,
          'executionProfile');
      }
    }
    return {
      chain,
      assignee: { principalId: acting.principalId, legacyIdentity: acting.legacyIdentity },
      root: { principalId: root.principalId, role: root.role, legacyIdentity: root.legacyIdentity },
    };
  }

  // ── the readability proof (R1, run on the assignment's own client) ──

  /** The REAL production predicate for (principal, read, task), evaluated
   * on the open transaction so it sees this act's own uncommitted rows. */
  async canRead(client: VehicleClient, principalId: string, taskId: string): Promise<boolean> {
    const chain = await delegationService.resolveChain(principalId);
    if (!chain.alive) return false;
    const acting = chain.links[0];
    const actor: AuthorizationActor = {
      principalId: acting.principalId,
      handle: '',
      role: acting.role,
      // The assignee acts through its OWN credentials, never the assigner's.
      // Object authority is what R1 is about; the route scope ceiling is a
      // separate plane and is not simulated here.
      scopes: null,
      authenticated: true,
      delegation: chain.links.length > 1 && !acting.legacyIdentity
        ? { links: chain.links }
        : null,
    };
    const allowed = await authorizationRepository.authorizedIds(actor, 'task', [taskId], 'read', client);
    return allowed.has(taskId);
  }

  // ── materialization primitives (owner default D4) ───────────────────

  /** Ensure ONE grant exists on `granteeId`, linked and refcounted. The
   * target row is created only when absent; an owner-plane row that
   * already covers the tuple is LINKED with created_by_vehicle = FALSE and
   * is never adopted, rewritten or reaped. */
  private async ensureGrant(
    client: VehicleClient,
    input: {
      taskId: string;
      assigneePrincipalId: string;
      granteeId: string;
      resourceType: GrantResourceType;
      resourceId: string | null;
      verb: GrantVerb;
      vehicleKind: 'warrant' | 'auto-grant' | 'role';
      role?: 'implementer' | 'verifier' | 'shepherd';
      warrantId: string | null;
      actor: AuditActor;
      /** The assigning principal remains the grantor when a later linker adds a reference. */
      grantorPrincipalId?: string;
      /** AZ-A10 clause 6: THIS task's date for the row (a canonical
       * instant), or null = until the task or the assignment ends. A row
       * created here starts with it; a shared row is recomputed by the
       * caller once every link of the act is in place. */
      expiresAt: string | null;
    },
  ): Promise<VehicleTarget> {
    // Warrants live by their own expiry; assignment and role links carry a date.
    const expiresAt = input.vehicleKind === 'warrant' ? null : input.expiresAt;
    await this.lockReferenceTask(client, input.taskId);
    await this.lockReferenceTarget(client, ["grant", "principal", input.granteeId, input.resourceType, input.resourceId, input.verb]);
    const existing = await client.query(
      `SELECT id FROM grants
        WHERE grantee_type = 'principal' AND grantee_id = $1
          AND resource_type = $2 AND resource_id IS NOT DISTINCT FROM $3 AND verb = $4`,
      [input.granteeId, input.resourceType, input.resourceId, input.verb],
    );

    let grantId: string;
    let createdByVehicle: boolean;
    if (existing.rows.length > 0) {
      grantId = String(existing.rows[0].id);
      await this.versionReferenceTarget(client, 'grant', grantId);
      createdByVehicle = false;
    } else {
      const inserted = await this.referenceQuery(client,
        `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id, provenance, expires_at)
         VALUES ('principal', $1, $2, $3, $4, $5, $6, $7::timestamptz) RETURNING id`,
        [
          input.granteeId, input.resourceType, input.resourceId, input.verb,
          input.grantorPrincipalId ?? input.actor.principalId ?? null,
          input.vehicleKind === 'warrant' ? 'assignment:warrant' : 'assignment:grant',
          expiresAt,
        ],
      );
      grantId = String(inserted.rows[0].id);
      createdByVehicle = true;
      // AZ-A10 clause 8: grant.create names the assignee and the date. The
      // `carriedBy: 'role'` and `role` keys of clause 8 arrive with the role
      // rows of clause 1; these rows are the execution assignment's.
      await auditService.record({
        action: 'grant.create', actor: input.actor, resourceType: 'grant', resourceId: grantId,
        metadata: {
          automatic: true, granteeId: input.granteeId, resourceType: input.resourceType,
          resourceId: input.resourceId, verb: input.verb, taskId: input.taskId,
          carriedBy: input.vehicleKind === 'role' ? 'role' : input.vehicleKind === 'warrant' ? 'warrant' : 'grant',
          role: input.role ?? null, warrantId: input.warrantId,
          assigneePrincipalId: input.assigneePrincipalId, expiresAt,
        },
      }, client as PoolClient);
      // RH-P3.C1: an ACL change over a feed object is itself a feed event.
      // Content-free by constraint; concrete objects only (a typed-NULL
      // wildcard has no single object to emit for) — the exact rule
      // GrantService.create applies.
      if (input.resourceId && FEED_OBJECT_TYPES.has(input.resourceType)) {
        await feedEventService.emit(client, {
          name: `${input.resourceType}.acl_changed`,
          objectType: input.resourceType as FeedObjectType,
          objectId: input.resourceId,
          actorPrincipalId: input.actor.principalId ?? null,
          actorHandle: input.actor.handle ?? null,
          ownerPrincipalId: input.granteeId,
          payload: {},
        });
      }
    }

    // The refcount row. A second task legitimately needing the same target
    // adds a second link; the target survives until the last one lets go.
    // created_by_vehicle is decided ONCE per target: a concurrent link on
    // the same target copies the recorded flag rather than re-deciding it.
    const priorFlag = await client.query(
      `SELECT created_by_vehicle FROM access_vehicle_links
        WHERE target_kind = 'grant' AND target_id = $1 LIMIT 1`,
      [grantId],
    );
    const effectiveFlag = priorFlag.rows.length > 0
      ? Boolean(priorFlag.rows[0].created_by_vehicle)
      : createdByVehicle;

    await client.query(
      `INSERT INTO access_vehicle_links
         (task_id, assignee_principal_id, landed_on_principal_id, vehicle_kind, warrant_id,
          target_kind, target_id, created_by_vehicle, created_by_principal_id, expires_at, role)
       VALUES ($1, $2, $3, $4, $5, 'grant', $6, $7, $8, $9::timestamptz, $10)
       ON CONFLICT DO NOTHING`,
      [
        input.taskId, input.assigneePrincipalId, input.granteeId, input.vehicleKind,
        input.warrantId, grantId, effectiveFlag, input.grantorPrincipalId ?? input.actor.principalId ?? null, expiresAt, input.role ?? null,
      ],
    );

    return {
      targetKind: 'grant', targetId: grantId, createdByVehicle: effectiveFlag,
      resourceType: input.resourceType, resourceId: input.resourceId,
    };
  }

  /** Ensure ONE access_profile_assignment exists, linked and refcounted.
   * D4 verbatim: the vehicle NEVER deletes an assignment row it did not
   * itself create — ratified 095 semantics stay untouched. */
  private async ensureProfileAssignment(
    client: VehicleClient,
    input: {
      taskId: string;
      assigneePrincipalId: string;
      granteeId: string;
      profileId: string;
      warrantId: string;
      actor: AuditActor;
    },
  ): Promise<VehicleTarget> {
    await this.lockReferenceTask(client, input.taskId);
    await this.lockReferenceTarget(client, ["profile_assignment", input.profileId, "principal", input.granteeId]);
    const existing = await client.query(
      `SELECT id FROM access_profile_assignments
        WHERE profile_id = $1 AND assignee_type = 'principal' AND assignee_id = $2`,
      [input.profileId, input.granteeId],
    );

    let assignmentId: string;
    let createdByVehicle: boolean;
    if (existing.rows.length > 0) {
      assignmentId = String(existing.rows[0].id);
      await this.versionReferenceTarget(client, 'profile_assignment', assignmentId);
      createdByVehicle = false;
    } else {
      const inserted = await this.referenceQuery(client,
        `INSERT INTO access_profile_assignments (profile_id, assignee_type, assignee_id, assigned_by_principal_id)
         VALUES ($1, 'principal', $2, $3) RETURNING id`,
        [input.profileId, input.granteeId, input.actor.principalId ?? null],
      );
      assignmentId = String(inserted.rows[0].id);
      createdByVehicle = true;
      // The ratified 095 append-only ledger + audit action, reused verbatim.
      await client.query(
        `INSERT INTO access_profile_events (profile_id, action, actor_principal_id, actor_handle, metadata)
         VALUES ($1, 'profile.assigned', $2, $3, $4)`,
        [
          input.profileId, input.actor.principalId ?? null, input.actor.handle ?? 'system',
          JSON.stringify({
            assignmentId, assigneeType: 'principal', assigneeId: input.granteeId,
            automatic: true, taskId: input.taskId, warrantId: input.warrantId,
          }),
        ],
      );
      await auditService.record({
        action: 'profile.assign', actor: input.actor, resourceType: 'access_profile', resourceId: input.profileId,
        metadata: {
          automatic: true, assigneeType: 'principal', assigneeId: input.granteeId,
          taskId: input.taskId, warrantId: input.warrantId,
        },
      }, client as PoolClient);
    }

    const priorFlag = await client.query(
      `SELECT created_by_vehicle FROM access_vehicle_links
        WHERE target_kind = 'profile_assignment' AND target_id = $1 LIMIT 1`,
      [assignmentId],
    );
    const effectiveFlag = priorFlag.rows.length > 0
      ? Boolean(priorFlag.rows[0].created_by_vehicle)
      : createdByVehicle;

    await client.query(
      `INSERT INTO access_vehicle_links
         (task_id, assignee_principal_id, landed_on_principal_id, vehicle_kind, warrant_id,
          target_kind, target_id, created_by_vehicle, created_by_principal_id)
       VALUES ($1, $2, $3, 'warrant', $4, 'profile_assignment', $5, $6, $7)
       ON CONFLICT DO NOTHING`,
      [
        input.taskId, input.assigneePrincipalId, input.granteeId, input.warrantId,
        assignmentId, effectiveFlag, input.actor.principalId ?? null,
      ],
    );

    return { targetKind: 'profile_assignment', targetId: assignmentId, createdByVehicle: effectiveFlag };
  }

  // ── AZ-A10 clause 6: the date an assigning act sets ─────────────────
  //
  // Ratified text (E43): "default `expires_at` = materialization + 3 months.
  // The assigning act may set any later date, or `unlimited` ... Three
  // months is the DEFAULT, not a floor: an earlier date is admitted". E62:
  // "whoever performs the assigning act ... may set an EARLIER date as well
  // as a later one or 'unlimited'". So the date is resolved WITHOUT looking
  // at who the assigner is, and there is no ceiling and no floor: the only
  // refusal is a date that is not in the future (D-11's "A past date can be
  // refused INVALID_EXPIRY ... an implementation choice").
  //
  // Each LINK keeps the date its own task's assignment set; the ROW is
  // "the maximum over its live links, NULL dominating" (clause 6), and is
  // recomputed whenever a link is added, re-dated or removed. Only a row
  // this machinery created is ever re-dated: an owner-plane row keeps its
  // own date (owner default D4 — never adopted, rewritten or reaped).

  /** Resolve one assigning act's date on the act's own transaction. The
   * default is computed by PostgreSQL, in UTC, from the transaction's own
   * NOW() — the moment of materialization — never from a JavaScript clock. */
  private async resolveRoleGrantExpiry(
    client: VehicleClient,
    request: RoleGrantExpiryRequest | undefined,
  ): Promise<AppliedRoleGrantExpiry> {
    if (request?.kind === 'unlimited') {
      return { requested: 'unlimited', applied: null, source: 'assigner' };
    }
    if (request?.kind === 'instant') {
      const row = await client.query(
        `SELECT to_char($1::timestamptz AT TIME ZONE 'UTC', ${ROLE_GRANT_EXPIRY_ISO_FORMAT}) AS iso,
                $1::timestamptz > clock_timestamp() AS future`,
        [request.instant],
      );
      if (row.rows[0]?.future !== true) {
        throw err(422, 'INVALID_EXPIRY',
          'roleGrantExpiresAt names an instant that is not in the future, so the rows would have expired before the '
          + 'assignment took effect. A past date is refused (AZ-A10 D-11). An earlier date than the three-month '
          + "default IS admitted: send any future instant, 'unlimited', or omit the field for the default",
          ROLE_GRANT_EXPIRY_FIELD);
      }
      return { requested: request.instant, applied: String(row.rows[0].iso), source: 'assigner' };
    }
    const row = await client.query(
      `SELECT to_char((NOW() AT TIME ZONE 'UTC') + INTERVAL '${ROLE_GRANT_DEFAULT_INTERVAL}', ${ROLE_GRANT_EXPIRY_ISO_FORMAT}) AS iso`,
    );
    return { requested: null, applied: String(row.rows[0].iso), source: 'default' };
  }

  /**
   * Re-date ONE row from its links: NULL if any link is unlimited, else the
   * latest link date. A row with no link, a row whose links say this
   * machinery did not create it, and a row without provenance (owner plane)
   * are left exactly as they are. Every change writes `grant.expiry_change`
   * with the date before and after (clause 8's audit, for a write clause 6
   * makes possible).
   */
  private async recomputeRowExpiry(
    client: VehicleClient,
    grantId: string,
    actor: AuditActor,
    context: { taskId: string; reason: string },
  ): Promise<boolean> {
    const state = await client.query(
      `SELECT g.provenance,
              to_char(g.expires_at AT TIME ZONE 'UTC', ${ROLE_GRANT_EXPIRY_ISO_FORMAT}) AS before_iso,
              COUNT(l.id)::int AS links,
              COALESCE(BOOL_OR(l.expires_at IS NULL), FALSE) AS any_unlimited,
              COALESCE(BOOL_AND(l.created_by_vehicle), FALSE) AS created_here,
              to_char(MAX(l.expires_at) AT TIME ZONE 'UTC', ${ROLE_GRANT_EXPIRY_ISO_FORMAT}) AS latest_iso
         FROM grants g
         LEFT JOIN access_vehicle_links l ON l.target_kind = 'grant' AND l.target_id = g.id
        WHERE g.id = $1
        GROUP BY g.id, g.provenance, g.expires_at`,
      [grantId],
    );
    const row = state.rows[0];
    if (!row || !row.provenance || row.links === 0 || row.created_here !== true) return false;
    const before: string | null = row.before_iso ?? null;
    const after: string | null = row.any_unlimited ? null : (row.latest_iso ?? null);
    const changed = await this.referenceQuery(client,
      `UPDATE grants SET expires_at = $2::timestamptz
        WHERE id = $1 AND provenance IS NOT NULL AND expires_at IS DISTINCT FROM $2::timestamptz
        RETURNING grantee_id, resource_type, resource_id, verb`,
      [grantId, after],
    );
    if (changed.rows.length === 0) return false;
    const updated = changed.rows[0];
    await auditService.record({
      action: 'grant.expiry_change', actor, resourceType: 'grant', resourceId: grantId,
      metadata: {
        automatic: true, before, after, taskId: context.taskId, reason: context.reason,
        granteeId: String(updated.grantee_id), resourceType: updated.resource_type,
        resourceId: updated.resource_id ?? null, verb: updated.verb,
      },
    }, client as PoolClient);
    if (updated.resource_id && FEED_OBJECT_TYPES.has(String(updated.resource_type))) {
      // A changed expiry changes who can read the object and when, so it is
      // an ACL change like any other (RH-P3.C1); content-free by constraint.
      await feedEventService.emit(client, {
        name: `${updated.resource_type}.acl_changed`,
        objectType: String(updated.resource_type) as FeedObjectType,
        objectId: String(updated.resource_id),
        actorPrincipalId: actor.principalId ?? null,
        actorHandle: actor.handle ?? null,
        ownerPrincipalId: String(updated.grantee_id),
        payload: {},
      });
    }
    return true;
  }

  /** Give every auto-grant link of THIS task the date `expiresAt`, then
   * recompute each row it links. The task's targets must already be locked
   * (ensureGrant, or lockTaskReferenceTargets). */
  private async applyLinkExpiry(
    client: VehicleClient,
    taskId: string,
    expiresAt: string | null,
    actor: AuditActor,
    reason: string,
  ): Promise<void> {
    await client.query(
      `UPDATE access_vehicle_links SET expires_at = $2::timestamptz
        WHERE task_id = $1 AND (vehicle_kind = 'auto-grant' OR (vehicle_kind = 'role' AND role = 'implementer')) AND target_kind = 'grant'
          AND expires_at IS DISTINCT FROM $2::timestamptz`,
      [taskId, expiresAt],
    );
    const targets = await client.query(
      `SELECT target_id FROM access_vehicle_links
        WHERE task_id = $1 AND (vehicle_kind = 'auto-grant' OR (vehicle_kind = 'role' AND role = 'implementer')) AND target_kind = 'grant'
        ORDER BY target_id`,
      [taskId],
    );
    for (const target of targets.rows) {
      await this.recomputeRowExpiry(client, String(target.target_id), actor, { taskId, reason });
    }
  }

  /** The date THIS task's assignment links carry, read back as the
   * canonical instant: `undefined` when the task holds no auto-grant link
   * (unassigned, warrant-carried, or a legacy identity), null when it is
   * unlimited. The links of one act share one date; if they ever disagreed,
   * the answer is clause 6's own rule (the latest, NULL dominating). */
  async assignmentExpiry(taskId: string, client: VehicleClient = pool): Promise<string | null | undefined> {
    const result = await client.query(
      `SELECT COUNT(*)::int AS links,
              COALESCE(BOOL_OR(expires_at IS NULL), FALSE) AS any_unlimited,
              to_char(MAX(expires_at) AT TIME ZONE 'UTC', ${ROLE_GRANT_EXPIRY_ISO_FORMAT}) AS latest_iso
         FROM access_vehicle_links
        WHERE task_id = $1 AND (vehicle_kind = 'auto-grant' OR (vehicle_kind = 'role' AND role = 'implementer')) AND target_kind = 'grant'`,
      [taskId],
    );
    const row = result.rows[0];
    if (!row || row.links === 0) return undefined;
    return row.any_unlimited ? null : String(row.latest_iso);
  }

  // ── the D5 reference set ────────────────────────────────────────────

  /**
   * Owner default D5, enumerated in contract note d3accc39 §D: the task
   * itself, its ONE-HOP dependency parents, its linked reports and its
   * referenced skills. READ verb only. No transitive closure, and no other
   * task_references kind — R2(b) names three reference classes and
   * excluding is the fail-safe direction.
   */
  async referenceSet(
    client: VehicleClient,
    taskId: string,
  ): Promise<Array<{ resourceType: GrantResourceType; resourceId: string }>> {
    const result = await client.query(
      `SELECT 'task'::text AS resource_type, $1::uuid AS resource_id
       UNION
       SELECT 'task', d.depends_on_task_id FROM task_dependencies d WHERE d.task_id = $1::uuid
       UNION
       SELECT 'report', r.id FROM reports r WHERE $1::uuid = ANY(r.task_ids)
       UNION
       SELECT 'report', tr.target_id FROM task_references tr
        WHERE tr.task_id = $1::uuid AND tr.kind = 'report' AND tr.target_id IS NOT NULL
       UNION
       SELECT 'skill', tr.target_id FROM task_references tr
        WHERE tr.task_id = $1::uuid AND tr.kind = 'skill' AND tr.target_id IS NOT NULL`,
      [taskId],
    );
    return result.rows
      .filter((row) => row.resource_id !== null && row.resource_id !== undefined)
      .map((row) => ({
        resourceType: String(row.resource_type) as GrantResourceType,
        resourceId: String(row.resource_id),
      }));
  }

  // ── R3: the non-escalation cap ──────────────────────────────────────

  /** Every materialization is capped ⊆ the ASSIGNER's own effective
   * authority, server-checked (R3). Root and administrator Accounts are
   * board-wide by ratified design (§5.1) and pass trivially. */
  private async assignerCovers(
    client: VehicleClient,
    assigner: AuthorizationActor,
    resourceType: GrantResourceType,
    resourceId: string,
  ): Promise<boolean> {
    if (assigner.scopes?.includes('root')) return true;
    if (!assigner.delegation && ADMINISTRATOR_ROLES.has(String(assigner.role || '').toLowerCase())) return true;
    const allowed = await authorizationRepository.authorizedIds(
      assigner, resourceType, [resourceId], 'read', client,
    );
    return allowed.has(resourceId);
  }

  // ── R2(a): the warrant vehicle ──────────────────────────────────────

  /**
   * The rules a warrant's ceiling resolves to on ONE of its two planes.
   *
   * A ceiling is ALWAYS a profile (AZ-A3), so this reads the same object on
   * either plane:
   * `plane: 'pinned'` is the MINT ceiling (AZ-21b) — the version pinned at
   * warrant creation, which republishing never widens.
   * `plane: 'published'` is what a vehicle actually MATERIALIZES for
   * visibility (AZ-11/T14): assignments store profile_id only and the
   * evaluator joins through published_version_id.
   *
   * Review bedc25f3 B3: the R3 non-escalation cap must be applied to the
   * PUBLISHED plane, because that is the authority the assignment hands
   * over. Checking the pinned plane let an assigner covered by v1 attach a
   * warrant whose profile had since published a v2 the assigner could not
   * read.
   */
  private async warrantCeilingRules(
    client: VehicleClient,
    warrantRow: any,
    plane: 'pinned' | 'published',
  ): Promise<ProfileRule[]> {
    const versionId = plane === 'pinned'
      ? String(warrantRow.ceiling_profile_version_id)
      : (await client.query(
          `SELECT ap.published_version_id
             FROM access_profile_versions v
             JOIN access_profiles ap ON ap.id = v.profile_id
            WHERE v.id = $1`,
          [String(warrantRow.ceiling_profile_version_id)],
        )).rows[0]?.published_version_id;
    // An unpublished profile carries EMPTY authority (T35) and is refused
    // as a vehicle below; an empty rule set here is the honest answer.
    if (!versionId) return [];
    const rules = await client.query(
      `SELECT resource_type, selector_form, selector_ids, verbs
         FROM access_profile_rules WHERE version_id = $1`,
      [String(versionId)],
    );
    return rules.rows.map((row) => ({
      resourceType: row.resource_type,
      selectorForm: row.selector_form,
      selectorIds: (row.selector_ids ?? []).map(String),
      verbs: row.verbs ?? [],
    }));
  }

  private async attachWarrant(
    client: VehicleClient,
    input: VehicleAttachInput & { taskId: string; assigneePrincipalId: string; landedOn: string; warrantId: string },
  ): Promise<VehicleTarget[]> {
    // SELECT FOR UPDATE serializes against revoke and against the sweep
    // (AZ-33b, the same discipline warrant-mint uses).
    const locked = await client.query('SELECT * FROM warrants WHERE id = $1 FOR UPDATE', [input.warrantId]);
    if (locked.rows.length === 0) {
      throw err(404, 'WARRANT_NOT_FOUND', 'No such warrant', 'warrantId');
    }
    const warrant = locked.rows[0];
    if (String(warrant.status) !== 'active') {
      throw err(409, 'WARRANT_NOT_LIVE', `the warrant is ${warrant.status} and cannot carry an assignment (§6.4)`, 'warrantId');
    }
    if (warrant.expires_at && new Date(warrant.expires_at).getTime() <= Date.now()) {
      throw err(409, 'WARRANT_NOT_LIVE', 'the warrant has passed its expiry (§6.2)', 'warrantId');
    }

    // The holder must BE the assignee chain — a warrant is a standing
    // authorization for ITS holder (§6.2), never a token another Connector
    // can borrow.
    const holderId = String(warrant.holder_principal_id);
    const chainIds = (await delegationService.resolveChain(input.assigneePrincipalId)).links.map((l) => l.principalId);
    if (!chainIds.includes(holderId)) {
      throw err(409, 'WARRANT_HOLDER_MISMATCH',
        'the warrant is held by a principal outside the assignee chain (§6.2)', 'warrantId');
    }

    // Containment (§6.3): the target task, its phase or its project must
    // appear in the anchor union.
    const contained = await client.query(
      `SELECT 1 FROM warrant_anchors wa
        WHERE wa.warrant_id = $1 AND (
          (wa.anchor_type = 'task' AND wa.anchor_id = $2::uuid)
          OR (wa.anchor_type = 'phase' AND wa.anchor_id IN (SELECT t.phase_id FROM tasks t WHERE t.id = $2::uuid AND t.phase_id IS NOT NULL))
          OR (wa.anchor_type = 'project' AND wa.anchor_id IN (SELECT t.project_id FROM tasks t WHERE t.id = $2::uuid AND t.project_id IS NOT NULL))
        ) LIMIT 1`,
      [input.warrantId, input.taskId],
    );
    if (contained.rows.length === 0) {
      throw err(409, 'WARRANT_DOES_NOT_CONTAIN_TASK',
        'the warrant anchor union does not contain this task (§6.3)', 'warrantId');
    }

    // R3 is applied to what the vehicle MATERIALIZES (review bedc25f3 B3),
    // which for a profile ceiling is the CURRENT PUBLISHED version — not
    // the pinned mint ceiling.
    const ceilingRules = await this.warrantCeilingRules(client, warrant, 'published');

    // R3: the ceiling must sit inside the ASSIGNER's own effective
    // authority — the warrant's creator-cap is a separate, earlier check.
    if (!(input.assigner.scopes?.includes('root'))
      && !(!input.assigner.delegation && ADMINISTRATOR_ROLES.has(String(input.assigner.role || '').toLowerCase()))) {
      const assignerId = input.assigner.principalId;
      if (!assignerId) {
        throw err(403, 'ASSIGNER_UNKNOWN', 'the assigning identity cannot be resolved, so the R3 non-escalation cap cannot be applied');
      }
      const sources = sourcesFromEffectiveAccess(await accessProfileService.effectiveAccess(assignerId));
      const check = rulesCovered(sources, ceilingRules);
      if (!check.covered) {
        throw err(403, 'ACCESS_EXCEEDS_ASSIGNER',
          `attaching this warrant would materialize authority beyond the assigner's own (R3): ${JSON.stringify(check.failing)}`,
          'warrantId');
      }
    }

    {
      // R2(a): assign the PROFILE (not the pinned version) through the
      // existing live profile-assignment arm — vehicle visibility follows
      // the PUBLISHED version (AZ-11/T14) while the warrant's MINT ceiling
      // stays version-pinned (AZ-21b). Two planes, deliberately.
      //
      // AZ-A3: there is one ceiling shape, so this is the ONLY path. The
      // rules-form branch that stood here — and the `all-except` refusal it
      // needed, because `grants` has no negation operator — are gone with
      // the case they guarded.
      const version = await client.query(
        `SELECT v.profile_id, ap.published_version_id
           FROM access_profile_versions v
           JOIN access_profiles ap ON ap.id = v.profile_id
          WHERE v.id = $1`,
        [String(warrant.ceiling_profile_version_id)],
      );
      if (version.rows.length === 0) {
        throw err(409, 'CEILING_NOT_MATERIALIZABLE', 'the warrant ceiling names no resolvable profile version', 'warrantId');
      }
      if (!version.rows[0].published_version_id) {
        // T35: an unpublished profile yields EMPTY authority and may not be
        // assigned — attaching it would produce exactly the
        // assigned-but-invisible state R1 forbids.
        throw err(409, 'CEILING_NOT_MATERIALIZABLE',
          'the warrant ceiling profile has no published version, so assigning it would carry no authority (T35)', 'warrantId');
      }
      const target = await this.ensureProfileAssignment(client, {
        taskId: input.taskId,
        assigneePrincipalId: input.assigneePrincipalId,
        granteeId: input.landedOn,
        profileId: String(version.rows[0].profile_id),
        warrantId: input.warrantId,
        actor: input.actor,
      });
      return [target];
    }
  }

  /**
   * The D5 reference set, filtered by the R3 non-escalation cap.
   *
   * A reference the acting principal cannot itself READ is OMITTED, never
   * granted (review bedc25f3 B2). Only the task itself is load-bearing for
   * R1, so omitting a reference never blocks the act — and the readability
   * proof still refuses if the TASK could not be covered.
   *
   * This is the single place the cap is applied, so the attach path and the
   * link-edit recompute path cannot drift apart: the first cut applied it
   * only on attach, and a link edit could then disclose a private object.
   */
  private async permittedReferences(
    client: VehicleClient,
    taskId: string,
    actor: AuthorizationActor,
    auditActor?: AuditActor,
  ): Promise<Array<{ resourceType: GrantResourceType; resourceId: string }>> {
    const references = await this.referenceSet(client, taskId);
    const permitted: Array<{ resourceType: GrantResourceType; resourceId: string }> = [];
    for (const reference of references) {
      if (reference.resourceType === 'task' && reference.resourceId === taskId) {
        permitted.push(reference);
        continue;
      }
      if (!(await this.assignerCovers(client, actor, reference.resourceType, reference.resourceId))) {
        if (auditActor) await auditService.record({
          action: 'grant.reference_skipped', actor: auditActor,
          resourceType: reference.resourceType, resourceId: reference.resourceId,
          metadata: { taskId, reason: 'AZ-A10: reference exceeds assigner authority' },
        }, client as PoolClient);
        continue;
      }
      permitted.push(reference);
    }
    return permitted;
  }

  /** The exact rows the role trigger would write, before it writes them.
   * Warrant mint checks this set against its pinned ceiling in the same
   * transaction; the trigger uses this very plan so the two cannot drift. */
  async plannedRoleRules(client: VehicleClient, taskId: string, role: TaskGrantRole,
    assigner: AuthorizationActor, auditActor?: AuditActor): Promise<Array<{ resourceType: GrantResourceType; resourceId: string; verb: GrantVerb }>> {
    const task = (await client.query('SELECT phase_id FROM tasks WHERE id = $1', [taskId])).rows[0];
    if (!task) throw err(404, 'ROLE_TASK_NOT_FOUND', 'the role target task does not exist');
    const references = await this.permittedReferences(client, taskId, assigner, auditActor);
    if (task.phase_id && await this.assignerCovers(client, assigner, 'phase', String(task.phase_id))) {
      references.push({ resourceType: 'phase', resourceId: String(task.phase_id) });
    } else if (task.phase_id && auditActor) {
      await auditService.record({ action: 'grant.reference_skipped', actor: auditActor,
        resourceType: 'phase', resourceId: String(task.phase_id),
        metadata: { taskId, reason: 'AZ-A10: phase exceeds assigner authority' },
      }, client as PoolClient);
    }
    const self = await authorizationRepository.authorizedIds(
      assigner, 'task', [taskId], role === 'implementer' ? 'write' : 'read', client,
    );
    if (!self.has(taskId)) throw err(403, 'ROLE_EXCEEDS_ASSIGNER',
      `the ${role} task row exceeds the assigner's effective authority`);
    return references.flatMap(reference => {
      const verbs: GrantVerb[] = reference.resourceType === 'task'
        && reference.resourceId === taskId && role === 'implementer' ? ['read', 'write'] : ['read'];
      return verbs.map(verb => ({ ...reference, verb }));
    });
  }

  /** AZ-A10: one role is one independent set of links. The role marker lives
   * on the links, while the grants remain ordinary assignment:grant rows. */
  async materializeRole(client: VehicleClient, input: {
    taskId: string; principalId: string; role: TaskGrantRole;
    actor: AuditActor; assigner: AuthorizationActor;
    roleGrantExpiry?: RoleGrantExpiryRequest;
    credentialExpiresAt?: string;
  }): Promise<VehicleTarget[]> {
    const task = (await client.query(
      `SELECT phase_id, status FROM tasks WHERE id = $1 FOR UPDATE`, [input.taskId],
    )).rows[0];
    if (!task || ['completed', 'archived'].includes(String(task.status))) {
      throw err(409, 'ROLE_TASK_TERMINAL', 'role rows require a live task');
    }
    const principal = (await client.query(
      `SELECT kind, status, role FROM principals WHERE id = $1`, [input.principalId],
    )).rows[0];
    if (!principal || principal.status !== 'active') {
      throw err(422, 'ROLE_ASSIGNEE_NOT_ACTIVE', 'the role holder must be an active Principal');
    }
    if (!input.assigner.authenticated) {
      throw err(403, 'ASSIGNER_UNKNOWN', 'a role grant requires an identified assigner');
    }
    if (!principal.kind || (!['agent', 'human', 'service'].includes(String(principal.kind)))) {
      throw err(422, 'ROLE_ASSIGNEE_INVALID', 'the role holder must be a Principal identity');
    }
    if (principal.kind === 'human' && ADMINISTRATOR_ROLES.has(String(principal.role || '').toLowerCase())) {
      return [];
    }
    if (principal.kind === 'agent' && input.roleGrantExpiry !== undefined) {
      throw err(422, 'ROLE_AGENT_EXPIRY_FOLLOWS_CREDENTIAL',
        'an Agent role row follows its credential expiry');
    }
    // E15 "agents follow the credential": the rows take the latest expiry of
    // the Agent's live credentials, and none when a live credential has none
    // (an owner-issued undated key); they are still reaped at task-terminal,
    // revoke and disable. Only an Agent with no live credential is refused.
    const agentCredential = principal.kind === 'agent' && !input.credentialExpiresAt
      ? (await client.query(
        `SELECT COUNT(*)::int AS live, COALESCE(BOOL_OR(expires_at IS NULL), FALSE) AS undated,
                to_char(MAX(expires_at) AT TIME ZONE 'UTC', ${ROLE_GRANT_EXPIRY_ISO_FORMAT}) AS expires_iso
           FROM principal_credentials WHERE principal_id = $1 AND revoked_at IS NULL
             AND (expires_at IS NULL OR expires_at > clock_timestamp())
             AND (grace_until IS NULL OR grace_until > clock_timestamp())`,
        [input.principalId],
      )).rows[0] : null;
    if (agentCredential && Number(agentCredential.live) === 0) {
      throw err(409, 'ROLE_AGENT_EXPIRY_MISSING', 'an Agent role grant must follow a live credential');
    }
    const agentExpiry: string | null | undefined = agentCredential
      ? (agentCredential.undated ? null : agentCredential.expires_iso)
      : input.credentialExpiresAt;
    const expiry = principal.kind === 'agent'
      ? agentExpiry
      : (await this.resolveRoleGrantExpiry(client, input.roleGrantExpiry)).applied;
    if (principal.kind === 'agent' && expiry === undefined) {
      throw err(409, 'ROLE_AGENT_EXPIRY_MISSING', 'an Agent role grant must follow a live credential');
    }
    const planned = await this.plannedRoleRules(client, input.taskId, input.role, input.assigner, input.actor);
    const targets: VehicleTarget[] = [];
    for (const reference of planned) {
      const verb = reference.verb;
        targets.push(await this.ensureGrant(client, {
          taskId: input.taskId, assigneePrincipalId: input.principalId,
          granteeId: input.principalId, resourceType: reference.resourceType,
          resourceId: reference.resourceId, verb, vehicleKind: 'role',
          role: input.role, warrantId: null, actor: input.actor, expiresAt: expiry ?? null,
        }));
    }
    for (const target of targets) {
      await this.recomputeRowExpiry(client, target.targetId, input.actor,
        { taskId: input.taskId, reason: 'AZ-A10 role assignment' });
    }
    return targets;
  }

  /** Remove only one role's links. Shared rows survive through other roles or
   * tasks and keep the maximum date of their remaining links. */
  async detachRole(client: VehicleClient, taskId: string, role: TaskGrantRole,
    actor: AuditActor, reason: string, holderId?: string): Promise<void> {
    await this.lockTaskReferenceTargets(client, taskId);
    const links = await client.query(
      `DELETE FROM access_vehicle_links WHERE task_id = $1 AND vehicle_kind = 'role' AND role = $2
         AND ($3::uuid IS NULL OR landed_on_principal_id = $3)
       RETURNING target_kind, target_id, created_by_vehicle, landed_on_principal_id`,
      [taskId, role, holderId ?? null],
    );
    for (const link of links.rows) {
      if (!link.created_by_vehicle) continue;
      const remaining = await client.query(
        `SELECT 1 FROM access_vehicle_links WHERE target_kind = $1 AND target_id = $2 LIMIT 1`,
        [link.target_kind, link.target_id],
      );
      if (remaining.rows.length) {
        if (link.target_kind === 'grant') await this.recomputeRowExpiry(
          client, String(link.target_id), actor, { taskId, reason });
      } else {
        await this.dropTarget(client, link, actor, reason);
      }
    }
  }

  /** Reap every role carried by this identity, without disturbing a sibling
   * holder of the same role on the task. Used by disable and last-key revoke. */
  async detachRoleHolder(client: VehicleClient, principalId: string,
    actor: AuditActor, reason: string): Promise<void> {
    const roles = await client.query(
      `SELECT DISTINCT task_id, role FROM access_vehicle_links
        WHERE vehicle_kind = 'role' AND landed_on_principal_id = $1
        ORDER BY task_id, role`, [principalId],
    );
    for (const row of roles.rows) await this.detachRole(client, String(row.task_id),
      row.role as TaskGrantRole, actor, reason, principalId);
  }

  /** An Agent's role links expire with its live credential. Lease extension
   * and key revocation invoke this inside their own transaction. */
  async syncAgentRoleExpiry(client: VehicleClient, principalId: string,
    actor: AuditActor): Promise<void> {
    const credential = (await client.query(
      `SELECT COUNT(*)::int AS live, COALESCE(BOOL_OR(c.expires_at IS NULL), FALSE) AS undated,
              MAX(c.expires_at) AS latest FROM principal_credentials c
        JOIN principals p ON p.id = c.principal_id
       WHERE c.principal_id = $1 AND p.kind = 'agent' AND p.status = 'active'
         AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > clock_timestamp())
         AND (c.grace_until IS NULL OR c.grace_until > clock_timestamp())`,
      [principalId],
    )).rows[0];
    if (!credential || Number(credential.live) === 0) {
      await this.detachRoleHolder(client, principalId, actor, 'AZ-A10: bound Agent has no live credential');
      return;
    }
    // An undated live credential leaves the rows undated (E15: they follow it).
    const expiry = credential.undated ? null : credential.latest;
    const linkedTasks = await client.query(
      `SELECT DISTINCT task_id FROM access_vehicle_links WHERE vehicle_kind = 'role'
        AND landed_on_principal_id = $1 ORDER BY task_id`, [principalId],
    );
    for (const row of linkedTasks.rows) {
      const taskId = String(row.task_id);
      await this.lockTaskReferenceTargets(client, taskId);
      const updated = await client.query(
        `UPDATE access_vehicle_links SET expires_at = $2::timestamptz
          WHERE vehicle_kind = 'role' AND landed_on_principal_id = $1
            AND task_id = $3 AND target_kind = 'grant'
            AND expires_at IS DISTINCT FROM $2::timestamptz
          RETURNING target_id`, [principalId, expiry, taskId],
      );
      for (const target of updated.rows) await this.recomputeRowExpiry(client,
        String(target.target_id), actor, { taskId, reason: 'AZ-A10 Agent credential expiry moved' });
    }
  }

  async redateRole(client: VehicleClient, taskId: string, role: TaskGrantRole,
    holderId: string, requested: RoleGrantExpiryRequest, actor: AuditActor): Promise<void> {
    const holder = (await client.query('SELECT kind FROM principals WHERE id = $1', [holderId])).rows[0];
    if (holder?.kind === 'agent') {
      throw err(422, 'ROLE_AGENT_EXPIRY_FOLLOWS_CREDENTIAL',
        'an Agent role row follows its credential expiry');
    }
    const expiry = await this.resolveRoleGrantExpiry(client, requested);
    await this.lockTaskReferenceTargets(client, taskId);
    const changed = await client.query(
      `UPDATE access_vehicle_links SET expires_at = $3::timestamptz
        WHERE task_id = $1 AND vehicle_kind = 'role' AND role = $2
          AND landed_on_principal_id = $4
        RETURNING target_id`,
      [taskId, role, expiry.applied, holderId],
    );
    for (const row of changed.rows) await this.recomputeRowExpiry(client, String(row.target_id), actor,
      { taskId, reason: 'AZ-A10 role assigning act changed its date' });
  }

  // ── the public act ──────────────────────────────────────────────────

  /**
   * R1: attach an access vehicle to an assignment, IN the assignment's own
   * transaction. Refuses — rolling the assignment back with it — whenever
   * the assignee chain would end up unable to read its task.
   */
  async attach(client: VehicleClient, input: VehicleAttachInput): Promise<VehicleAttachResult> {
    const assigneePrincipalId = await this.assigneePrincipalFor(client, input.serviceId);
    const resolved = await this.resolveChainForTask(assigneePrincipalId, input.taskId);
    const warrantId = input.warrantId ?? null;
    const landedOn = warrantId ? resolved.root.principalId : assigneePrincipalId;

    // R3 requires an identified assigner for anything but a system act.
    if (!input.assigner.authenticated) {
      throw err(403, 'ASSIGNER_UNKNOWN',
        'an execution assignment requires an identified assigner so the R3 non-escalation cap can be applied');
    }

    // AZ-A10 clause 6 governs the grant rows an assignment writes. A
    // warrant-carried assignment writes a profile assignment instead, which
    // lives and dies with the warrant (§6.2), so a date for it is refused
    // rather than silently ignored. Resolved BEFORE anything is materialized:
    // a refused date writes nothing.
    if (warrantId && input.roleGrantExpiry !== undefined) {
      throw err(422, 'ROLE_GRANT_EXPIRY_WITH_WARRANT',
        'roleGrantExpiresAt dates the grant rows an assignment writes (AZ-A10 clause 6); an assignment carried by a '
        + 'Warrant writes none and follows the Warrant\'s own expiry. Send one or the other',
        ROLE_GRANT_EXPIRY_FIELD);
    }
    const roleGrantExpiry = warrantId ? null : await this.resolveRoleGrantExpiry(client, input.roleGrantExpiry);

    let targets: VehicleTarget[] = [];
    let vehicleKind: 'warrant' | 'auto-grant' | 'role' = warrantId ? 'warrant' : 'role';

    // T37: legacy identities are frozen out of BOTH new grants and profile
    // assignment. No vehicle can be materialized for them — the readability
    // proof below decides whether the assignment stands on the unchanged
    // Phase-2 arms or is refused.
    const legacyFrozen = resolved.assignee.legacyIdentity || resolved.root.legacyIdentity;
    if (legacyFrozen) {
      if (warrantId) {
        throw err(409, 'LEGACY_FROZEN',
          'legacy identities are frozen out of profile assignment and new grants (§10, T37), so a warrant cannot carry access for them',
          'warrantId');
      }
    } else if (warrantId) {
      targets = await this.attachWarrant(client, {
        ...input, taskId: input.taskId, assigneePrincipalId, landedOn, warrantId,
      });
    } else {
      targets = await this.materializeRole(client, {
        taskId: input.taskId, principalId: assigneePrincipalId, role: 'implementer',
        actor: input.actor, assigner: input.assigner,
        roleGrantExpiry: input.roleGrantExpiry,
      });
    }

    // ── R1, PROVEN: the real predicate, this transaction, right now ────
    const readable = await this.canRead(client, assigneePrincipalId, input.taskId);
    if (!readable) {
      throw err(409, 'ASSIGNMENT_NOT_VISIBLE',
        legacyFrozen
          ? 'this assignee is a legacy identity (§10, T37) and can be given neither a grant nor a profile assignment, and it cannot already read the task — the assignment would be invisible, which ruling 7440b579 R1 forbids'
          : 'the assignee chain still cannot read this task after attaching its access — ruling 7440b579 R1 forbids an assigned-but-invisible task',
        'executionProfile');
    }

    await auditService.record({
      action: 'task.execution_assign', actor: input.actor, resourceType: 'task', resourceId: input.taskId,
      metadata: {
        assigneePrincipalId, landedOnPrincipalId: landedOn,
        carriedBy: vehicleKind === 'warrant' ? 'warrant' : 'role',
        warrantId, targetCount: targets.length,
        // AZ-A10 clauses 6 and 8: what the assigning act asked for, what the
        // rows carry, and where the date came from. null for a warrant.
        roleGrantExpiresAt: roleGrantExpiry,
      },
    }, client as PoolClient);

    return { vehicleKind, warrantId, landedOnPrincipalId: landedOn, assigneePrincipalId, targets, roleGrantExpiry };
  }

  /**
   * An assigning act that names the assignee the task ALREADY has, with a
   * new `roleGrantExpiresAt` (AZ-A10 clause 6, E62). Nothing is detached or
   * re-created: this task's links take the new date, every row they link is
   * recomputed from its links (clause 6's maximum, owner-plane rows never
   * touched), and the act is audited with the link date before and after.
   * The R1 proof runs again on this transaction, so a re-date can never
   * leave the assignee unable to read its task.
   */
  async redate(
    client: VehicleClient,
    input: { taskId: string; serviceId: string; roleGrantExpiry: RoleGrantExpiryRequest; actor: AuditActor },
  ): Promise<AppliedRoleGrantExpiry> {
    await this.lockTaskReferenceTargets(client, input.taskId);
    const carried = await client.query(
      `SELECT 1 FROM access_vehicle_links WHERE task_id = $1 AND vehicle_kind = 'warrant' LIMIT 1`,
      [input.taskId],
    );
    const pointer = await client.query('SELECT execution_warrant_id FROM tasks WHERE id = $1', [input.taskId]);
    if (carried.rows.length > 0 || pointer.rows[0]?.execution_warrant_id) {
      throw err(422, 'ROLE_GRANT_EXPIRY_WITH_WARRANT',
        'this assignment is carried by a Warrant, which writes no grant rows for roleGrantExpiresAt to date '
        + '(AZ-A10 clause 6); it follows the Warrant\'s own expiry',
        ROLE_GRANT_EXPIRY_FIELD);
    }
    const before = await this.assignmentExpiry(input.taskId, client);
    const expiry = await this.resolveRoleGrantExpiry(client, input.roleGrantExpiry);
    await this.applyLinkExpiry(client, input.taskId, expiry.applied, input.actor,
      'AZ-A10 clause 6: the assigning act set a new date');

    const assigneePrincipalId = await this.assigneePrincipalFor(client, input.serviceId);
    if (!(await this.canRead(client, assigneePrincipalId, input.taskId))) {
      throw err(409, 'ASSIGNMENT_NOT_VISIBLE',
        'the assignee chain cannot read this task with the new date — ruling 7440b579 R1 forbids an assigned-but-invisible task',
        ROLE_GRANT_EXPIRY_FIELD);
    }
    await auditService.record({
      action: 'task.execution_assign', actor: input.actor, resourceType: 'task', resourceId: input.taskId,
      metadata: {
        assigneePrincipalId, carriedBy: 'role', warrantId: null, reasserted: true,
        roleGrantExpiresAt: { ...expiry, before: before === undefined ? null : before },
      },
    }, client as PoolClient);
    return expiry;
  }

  // ── reaping (R2 reference-counting, R4 lifecycle) ───────────────────

  /**
   * Drop every link this task holds and, for each target whose refcount
   * reaches zero, delete the target — but ONLY when this machinery created
   * it (owner default D4: the vehicle never deletes an owner-plane row).
   */
  async detach(
    client: VehicleClient,
    taskId: string,
    actor: AuditActor,
    reason: string,
  ): Promise<{ removedLinks: number; removedTargets: number }> {
    await this.lockTaskReferenceTargets(client, taskId);
    const links = await client.query(
      `DELETE FROM access_vehicle_links WHERE task_id = $1
        RETURNING target_kind, target_id, created_by_vehicle, landed_on_principal_id`,
      [taskId],
    );
    let removedTargets = 0;
    for (const link of links.rows) {
      if (!link.created_by_vehicle) continue;
      const remaining = await client.query(
        `SELECT 1 FROM access_vehicle_links WHERE target_kind = $1 AND target_id = $2 LIMIT 1`,
        [link.target_kind, link.target_id],
      );
      if (remaining.rows.length > 0) {
        // AZ-A10 clause 7: "A shared row survives only through another live
        // task's link, with its expiry recomputed over the remaining links."
        if (link.target_kind === 'grant') {
          await this.recomputeRowExpiry(client, String(link.target_id), actor, { taskId, reason });
        }
        continue;
      }
      removedTargets += await this.dropTarget(client, link, actor, reason);
    }
    return { removedLinks: links.rows.length, removedTargets };
  }

  private async dropTarget(
    client: VehicleClient,
    link: { target_kind: string; target_id: string; landed_on_principal_id: string },
    actor: AuditActor,
    reason: string,
  ): Promise<number> {
    if (link.target_kind === 'grant') {
      // The provenance guard is the second half of the D4 promise: even if
      // a link row were wrong, a grant this machinery did not tag is never
      // deleted here.
      const removed = await client.query(
        `DELETE FROM grants WHERE id = $1 AND provenance IS NOT NULL
          RETURNING grantee_id, resource_type, resource_id, verb`,
        [link.target_id],
      );
      if (removed.rows.length === 0) return 0;
      const row = removed.rows[0];
      await auditService.record({
        action: 'grant.revoke', actor, resourceType: 'grant', resourceId: String(link.target_id),
        metadata: {
          automatic: true, reason, granteeId: String(row.grantee_id),
          resourceType: row.resource_type, resourceId: row.resource_id, verb: row.verb,
        },
      }, client as PoolClient);
      if (row.resource_id && FEED_OBJECT_TYPES.has(String(row.resource_type))) {
        await feedEventService.emit(client, {
          name: `${row.resource_type}.acl_changed`,
          objectType: String(row.resource_type) as FeedObjectType,
          objectId: String(row.resource_id),
          actorPrincipalId: actor.principalId ?? null,
          actorHandle: actor.handle ?? null,
          // The party whose entitlement THIS transition removes — recorded
          // so the content-free event still reaches them (C1 round 2, F3).
          ownerPrincipalId: String(row.grantee_id),
          payload: {},
        });
      }
      return 1;
    }

    const removed = await client.query(
      `DELETE FROM access_profile_assignments WHERE id = $1 RETURNING profile_id, assignee_id`,
      [link.target_id],
    );
    if (removed.rows.length === 0) return 0;
    const row = removed.rows[0];
    await client.query(
      `INSERT INTO access_profile_events (profile_id, action, actor_principal_id, actor_handle, metadata)
       VALUES ($1, 'profile.unassigned', $2, $3, $4)`,
      [
        String(row.profile_id), actor.principalId ?? null, actor.handle ?? 'system',
        JSON.stringify({
          assignmentId: link.target_id, assigneeType: 'principal',
          assigneeId: String(row.assignee_id), automatic: true, reason,
        }),
      ],
    );
    await auditService.record({
      action: 'profile.unassign', actor, resourceType: 'access_profile', resourceId: String(row.profile_id),
      metadata: {
        automatic: true, reason, assignmentId: link.target_id,
        assigneeType: 'principal', assigneeId: String(row.assignee_id),
      },
    }, client as PoolClient);
    return 1;
  }

  /**
   * AZ-A10 clauses 7 and 13 for the superseded Account-landed fallback. The
   * clause-14 backfill replaces an `auto-grant` link only where it could
   * materialize the implementer's role rows; it leaves the link where the
   * holder is an administrator Account or the assigner is not provable. Such
   * a link keeps the AZ-S7 REMOVAL arm: a link edit that drops a reference
   * still revokes what the fallback carried ("a link edit drops a reference
   * (recompute)", clause 7). Nothing is ever added to it: clause 13
   * supersedes the fallback for new materialization. Caller holds the
   * task's reference-target locks.
   */
  private async pruneLegacyAutoGrant(
    client: VehicleClient,
    taskId: string,
    actor: AuditActor,
  ): Promise<void> {
    const current = await client.query(
      `SELECT l.target_kind, l.target_id, l.created_by_vehicle, l.landed_on_principal_id,
              g.resource_type, g.resource_id
         FROM access_vehicle_links l
         JOIN grants g ON g.id = l.target_id
        WHERE l.task_id = $1 AND l.vehicle_kind = 'auto-grant' AND l.target_kind = 'grant'
        ORDER BY l.target_id`,
      [taskId],
    );
    if (current.rows.length === 0) return;
    // The raw reference set, as the role arm's removal uses (review bedc25f3 B2).
    const stillReferenced = new Set(
      (await this.referenceSet(client, taskId)).map((r) => `${r.resourceType}:${r.resourceId}`),
    );
    const reason = 'AZ-S7 recompute: the task no longer references this object';
    for (const row of current.rows) {
      if (stillReferenced.has(`${row.resource_type}:${row.resource_id}`)) continue;
      await client.query(
        `DELETE FROM access_vehicle_links WHERE task_id = $1 AND vehicle_kind = 'auto-grant'
            AND target_kind = 'grant' AND target_id = $2`,
        [taskId, row.target_id],
      );
      if (!row.created_by_vehicle) continue;
      const remaining = await client.query(
        `SELECT 1 FROM access_vehicle_links WHERE target_kind = 'grant' AND target_id = $1 LIMIT 1`,
        [row.target_id],
      );
      if (remaining.rows.length > 0) {
        await this.recomputeRowExpiry(client, String(row.target_id), actor, { taskId, reason });
        continue;
      }
      await this.dropTarget(client, row, actor, reason);
    }
  }

  /**
   * R2(b): "recomputed in the SAME transaction as any link edit while
   * assigned". Re-derives the D5 set for a task that currently holds an
   * auto-grant vehicle: newly referenced objects gain their grant, objects
   * that stopped being referenced lose theirs under the same refcount and
   * created_by_vehicle rules. A warrant-backed vehicle carries its ceiling
   * and is deliberately untouched by link edits.
   *
   * `linker` is the authorization identity of whoever made the link edit,
   * and it is REQUIRED (review bedc25f3 B2). R3 and R8 both cap the derived
   * access at the linking principal's own authority — a link act may not
   * hand the assignee an object the linker could not read. Passing a
   * root/system actor here is a real decision and only correct for genuine
   * server-side acts.
   */
  async recompute(
    client: VehicleClient,
    taskId: string,
    actor: AuditActor,
    linker: AuthorizationActor,
  ): Promise<void> {
    await this.lockTaskReferenceTargets(client, taskId);
    await this.pruneLegacyAutoGrant(client, taskId, actor);
    const holders = await client.query(
      `SELECT role, assignee_principal_id, landed_on_principal_id,
              CASE WHEN BOOL_OR(expires_at IS NULL) THEN NULL ELSE MAX(expires_at) END AS expires_at
         FROM access_vehicle_links
        WHERE task_id = $1 AND vehicle_kind = 'role' AND target_kind = 'grant'
        GROUP BY role, assignee_principal_id, landed_on_principal_id
        ORDER BY role, assignee_principal_id, landed_on_principal_id`, [taskId],
    );
    if (holders.rows.length === 0) return;
    const desired = await this.permittedReferences(client, taskId, linker, actor);
    const phase = (await client.query('SELECT phase_id FROM tasks WHERE id = $1', [taskId])).rows[0]?.phase_id;
    if (phase && await this.assignerCovers(client, linker, 'phase', String(phase))) {
      desired.push({ resourceType: 'phase', resourceId: String(phase) });
    }
    // The REMOVAL arm works off the raw reference set, not the capped one:
    // a linker who cannot read an object must not be able to REVOKE the
    // assignee's access to it either, and "not permitted to confer" is not
    // "no longer referenced" (review bedc25f3 B2).
    const stillReferenced = new Set(
      (await this.referenceSet(client, taskId)).map((r) => `${r.resourceType}:${r.resourceId}`),
    );
    if (phase) stillReferenced.add(`phase:${String(phase)}`);
    for (const holder of holders.rows) {
    const role = holder.role as TaskGrantRole;
    const landedOn = String(holder.landed_on_principal_id);
    const assigneePrincipalId = String(holder.assignee_principal_id);
    // The task row was written by the assigning act. A later linker may
    // confer only what BOTH that assigner and the linker currently hold.
    const taskGrantors = await client.query(
      `SELECT DISTINCT l.created_by_principal_id AS id
         FROM access_vehicle_links l JOIN grants g ON g.id = l.target_id
        WHERE l.task_id = $1 AND l.vehicle_kind = 'role' AND l.role = $2
          AND l.landed_on_principal_id = $3 AND l.target_kind = 'grant'
          AND g.resource_type = 'task' AND g.resource_id = $1 AND g.verb = 'read'`,
      [taskId, role, landedOn],
    );
    const grantorId = taskGrantors.rows.length === 1 && taskGrantors.rows[0].id
      ? String(taskGrantors.rows[0].id) : null;
    if (!grantorId) throw err(409, 'ROLE_ASSIGNER_UNKNOWN',
      `the ${role} task row has no provable assigning principal`);
    const grantorChain = await delegationService.resolveChain(grantorId, client);
    if (!grantorChain.alive) throw err(403, 'ROLE_EXCEEDS_ASSIGNER',
      `the ${role} task row's assigner is no longer live`);
    const originalAssigner: AuthorizationActor = {
      principalId: grantorId, handle: '', role: grantorChain.links[0].role,
      scopes: null, authenticated: true,
      delegation: grantorChain.links.length > 1 ? { links: grantorChain.links } : null,
    };
    const selfVerb = role === 'implementer' ? 'write' : 'read';
    if (!(await authorizationRepository.authorizedIds(
      originalAssigner, 'task', [taskId], selfVerb, client,
    )).has(taskId)) throw err(403, 'ROLE_EXCEEDS_ASSIGNER',
      `the ${role} bound task row exceeds the original assigner's current ${selfVerb} authority`);
    // A warrant is pinned at mint. Read that version on this transaction;
    // a later profile publication or an authorized linker cannot widen it.
    const warrant = (await client.query(
      `SELECT w.id, w.status, w.expires_at, w.ceiling_profile_version_id,
              p.own_expression
         FROM principals p LEFT JOIN warrants w ON w.id = p.minted_under_warrant_id
        WHERE p.id = $1 AND p.minted_under_warrant_id IS NOT NULL`,
      [assigneePrincipalId],
    )).rows[0];
    if (warrant && (warrant.status !== 'active'
      || (warrant.expires_at && new Date(warrant.expires_at).getTime() <= Date.now())
      || !warrant.ceiling_profile_version_id)) {
      throw err(403, 'CEILING_EXCEEDED', `the ${role} holder's pinned warrant is unavailable`);
    }
    const ceilingSources = warrant ? sourcesFromRules((await client.query(
      `SELECT resource_type, selector_form, selector_ids, verbs
         FROM access_profile_rules WHERE version_id = $1`,
      [warrant.ceiling_profile_version_id],
    )).rows.map(row => ({
      resourceType: row.resource_type as GrantResourceType,
      selectorForm: row.selector_form,
      selectorIds: (row.selector_ids ?? []).map(String),
      verbs: row.verbs ?? [],
    } as ProfileRule))) : null;
    if (ceilingSources) {
      const own = typeof warrant.own_expression === 'string'
        ? JSON.parse(warrant.own_expression) : warrant.own_expression;
      const requested = Array.isArray(own?.objects) ? own.objects as ProfileRule[] : [];
      const requestCheck = await rulesCoveredWithCoordinates(client, ceilingSources, requested);
      if (!requestCheck.covered) throw err(403, 'CEILING_EXCEEDED',
        `the Agent's requested rules exceed its pinned warrant ceiling: ${JSON.stringify(requestCheck.failing)}`);
    }
    const withinCeiling = async (resourceType: GrantResourceType, resourceId: string, verb: GrantVerb) =>
      !ceilingSources || (await rulesCoveredWithCoordinates(client, ceilingSources, [{
        resourceType, selectorForm: 'exact', selectorIds: [resourceId], verbs: [verb],
      }])).covered;
    for (const verb of (role === 'implementer' ? ['read', 'write'] : ['read']) as GrantVerb[]) {
      if (!(await withinCeiling('task', taskId, verb))) {
        throw err(403, 'CEILING_EXCEEDED',
          `the ${role} bound task row exceeds the pinned warrant ceiling: task/${taskId}/${verb}`);
      }
    }
    const current = await client.query(
      `SELECT l.target_kind, l.target_id, l.created_by_vehicle, l.landed_on_principal_id,
              g.resource_type, g.resource_id, g.verb
         FROM access_vehicle_links l JOIN grants g ON g.id = l.target_id
        WHERE l.task_id = $1 AND l.vehicle_kind = 'role' AND l.role = $2
          AND l.landed_on_principal_id = $3 AND l.target_kind = 'grant'`,
      [taskId, role, landedOn],
    );
    const currentKeys = new Set<string>();
    for (const row of current.rows) {
      const key = `${row.resource_type}:${row.resource_id}`;
      currentKeys.add(key);
      const covered = await withinCeiling(row.resource_type as GrantResourceType,
        String(row.resource_id), row.verb as GrantVerb);
      const assignerCovered = row.resource_type === 'task' || await this.assignerCovers(
        client, originalAssigner, row.resource_type as GrantResourceType, String(row.resource_id));
      if (stillReferenced.has(key) && covered && assignerCovered) continue;
      const removalReason = !covered ? 'AZ-A10 recompute: row exceeds pinned warrant ceiling'
        : !assignerCovered ? 'AZ-A10 recompute: row exceeds original assigner authority'
          : 'AZ-S7 recompute: the task no longer references this object';
      // No longer referenced: drop the link, then the target at refcount
      // zero — and only when this machinery created it.
      await client.query(
        `DELETE FROM access_vehicle_links WHERE task_id = $1 AND vehicle_kind = 'role' AND role = $3
           AND landed_on_principal_id = $4 AND target_kind = 'grant' AND target_id = $2`,
        [taskId, row.target_id, role, landedOn],
      );
      if (!row.created_by_vehicle) continue;
      const remaining = await client.query(
        `SELECT 1 FROM access_vehicle_links WHERE target_kind = 'grant' AND target_id = $1 LIMIT 1`,
        [row.target_id],
      );
      if (remaining.rows.length > 0) {
        // AZ-A10 clause 7: "a link edit drops a reference (recompute)" — the
        // row lives on through other tasks, at the latest of THEIR dates.
        await this.recomputeRowExpiry(client, String(row.target_id), actor,
          { taskId, reason: removalReason });
        continue;
      }
      await this.dropTarget(client, row as any, actor, removalReason);
    }

    // A newly referenced object is linked at the date the assignment
    // already carries (AZ-A10 clause 6): a link edit is not an assigning act
    // and never moves the date.
    const expiresAt: string | null = holder.expires_at ? new Date(holder.expires_at).toISOString() : null;
    for (const reference of desired) {
      if (currentKeys.has(`${reference.resourceType}:${reference.resourceId}`)) continue;
      if (!(await this.assignerCovers(client, originalAssigner, reference.resourceType, reference.resourceId))) {
        await auditService.record({ action: 'grant.reference_skipped', actor,
          resourceType: reference.resourceType, resourceId: reference.resourceId,
          metadata: { taskId, role, assigneePrincipalId, reason: 'AZ-A10: reference exceeds original assigner authority' },
        }, client as PoolClient);
        continue;
      }
      if (!(await withinCeiling(reference.resourceType, reference.resourceId, VEHICLE_VERB))) {
        await auditService.record({ action: 'grant.reference_skipped', actor,
          resourceType: reference.resourceType, resourceId: reference.resourceId,
          metadata: { taskId, role, assigneePrincipalId, warrantId: String(warrant.id),
            reason: 'AZ-A10: reference exceeds pinned warrant ceiling' },
        }, client as PoolClient);
        continue;
      }
      const target = await this.ensureGrant(client, {
        taskId, assigneePrincipalId, granteeId: landedOn,
        resourceType: reference.resourceType, resourceId: reference.resourceId,
        verb: VEHICLE_VERB, vehicleKind: 'role', role, warrantId: null, actor,
        grantorPrincipalId: grantorId, expiresAt,
      });
      await this.recomputeRowExpiry(client, target.targetId, actor,
        { taskId, reason: 'AZ-A10 clause 6: a link edit linked this row' });
    }
    }
  }

  // ── R4: warrant lifecycle coupling ──────────────────────────────────

  /** The dependent not-yet-terminal tasks a revoke or suspend would
   * auto-unassign (R4's mandatory warning list). */
  async dependentOpenTasks(
    warrantId: string,
    // AZ-A13 clause 10c: a ceiling edit asks inside its own transaction.
    queryable: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> } = pool,
  ): Promise<Array<{ id: string; title: string; status: string }>> {
    const result = await queryable.query(
      `SELECT DISTINCT t.id, t.title, t.status
         FROM tasks t
        WHERE t.status NOT IN ('completed', 'archived')
          AND t.execution_service_id IS NOT NULL
          AND (t.execution_warrant_id = $1
               OR EXISTS (SELECT 1 FROM access_vehicle_links l
                           WHERE l.task_id = t.id AND l.warrant_id = $1))
        ORDER BY t.id`,
      [warrantId],
    );
    return result.rows.map((row) => ({ id: String(row.id), title: String(row.title), status: String(row.status) }));
  }

  /** Every task this warrant currently carries, terminal or not. */
  async vehicleTasksForWarrant(warrantId: string): Promise<string[]> {
    const result = await pool.query(
      `SELECT DISTINCT task_id FROM access_vehicle_links WHERE warrant_id = $1 ORDER BY task_id`,
      [warrantId],
    );
    return result.rows.map((row) => String(row.task_id));
  }

  /**
   * R4: revoking or suspending a warrant AUTO-UNASSIGNS its dependent
   * not-yet-terminal tasks — which also silences their doorbells,
   * consistent with delivery ruling ccd53781 R2. In-flight tasks run to
   * completion on their task-bounded credentials: this touches the
   * ASSIGNMENT, never a minted credential, and force-release remains the
   * hard stop.
   *
   * R2(a): vehicle profile-assignments are reference-counted against the
   * warrant's active assignments and removed "at zero OR ON WARRANT
   * DEATH", so every link this warrant holds is reaped here — terminal
   * tasks included, since their assignment is no longer carrying anything.
   */
  async releaseWarrant(
    client: VehicleClient,
    warrantId: string,
    actor: AuditActor,
    reason: string,
  ): Promise<{ unassignedTaskIds: string[] }> {
    const carried = await client.query(
      `SELECT DISTINCT l.task_id, t.status, t.execution_service_id
         FROM access_vehicle_links l
         JOIN tasks t ON t.id = l.task_id
        WHERE l.warrant_id = $1
        ORDER BY l.task_id`,
      [warrantId],
    );

    const unassigned: string[] = [];
    for (const discovered of carried.rows) {
      const taskId = String(discovered.task_id);
      await this.lockReferenceTask(client, taskId);
      // The warrant lock is not a Task lock: recheck the carried decision.
      const current = await client.query(`SELECT status, execution_service_id FROM tasks t WHERE id=$1
        AND EXISTS (SELECT 1 FROM access_vehicle_links l WHERE l.task_id=t.id AND l.warrant_id=$2)`, [taskId, warrantId]);
      if (!current.rows.length) continue;
      const row = current.rows[0];
      await this.detach(client, taskId, actor, reason);
      const terminal = ['completed', 'archived'].includes(String(row.status));
      if (terminal || !row.execution_service_id) continue;
      await client.query(
        `UPDATE tasks SET execution_service_id = NULL, execution_profile = NULL,
                execution_descriptor_version = NULL, execution_warrant_id = NULL
          WHERE id = $1`,
        [taskId],
      );
      await auditService.record({
        action: 'task.execution_unassign', actor, resourceType: 'task', resourceId: taskId,
        metadata: { automatic: true, reason, warrantId },
      }, client as PoolClient);
      unassigned.push(taskId);
    }

    // A task can also carry the warrant pointer with its links already
    // reaped (it went terminal, then reopened, then the warrant died).
    // Clear those too, so no pointer outlives its warrant.
    const pointers = await client.query('SELECT id FROM tasks WHERE execution_warrant_id=$1 ORDER BY id', [warrantId]);
    for (const pointer of pointers.rows) {
      const taskId = String(pointer.id);
      await this.lockReferenceTask(client, taskId);
      const current = await client.query('SELECT status FROM tasks WHERE id=$1 AND execution_warrant_id=$2', [taskId, warrantId]);
      if (!current.rows.length) continue;
      const terminal = ['completed', 'archived'].includes(String(current.rows[0].status));
      if (terminal) await client.query('UPDATE tasks SET execution_warrant_id=NULL WHERE id=$1', [taskId]);
      else {
        await client.query(`UPDATE tasks SET execution_service_id=NULL, execution_profile=NULL,
          execution_descriptor_version=NULL, execution_warrant_id=NULL WHERE id=$1`, [taskId]);
        if (!unassigned.includes(taskId)) {
          await auditService.record({action: 'task.execution_unassign', actor, resourceType: 'task', resourceId: taskId,
            metadata: {automatic:true, reason, warrantId}}, client as PoolClient);
          unassigned.push(taskId);
        }
      }
    }

    return { unassignedTaskIds: unassigned };
  }

  /** The two-way linkage the R5 UI renders: what carries THIS task. */
  async linksForTask(taskId: string): Promise<Array<Record<string, unknown>>> {
    const result = await pool.query(
      `SELECT l.id, l.vehicle_kind, l.warrant_id, w.name AS warrant_name, w.status AS warrant_status,
              l.target_kind, l.target_id, l.created_by_vehicle,
              l.assignee_principal_id, l.landed_on_principal_id,
              lp.handle AS landed_on_handle,
              g.resource_type, g.resource_id, g.verb,
              to_char(l.expires_at AT TIME ZONE 'UTC', ${ROLE_GRANT_EXPIRY_ISO_FORMAT}) AS link_expires_iso,
              to_char(g.expires_at AT TIME ZONE 'UTC', ${ROLE_GRANT_EXPIRY_ISO_FORMAT}) AS row_expires_iso,
              (g.expires_at IS NOT NULL AND g.expires_at <= NOW()) AS row_expired,
              ap.id AS profile_id, ap.name AS profile_name
         FROM access_vehicle_links l
         LEFT JOIN warrants w ON w.id = l.warrant_id
         LEFT JOIN principals lp ON lp.id = l.landed_on_principal_id
         LEFT JOIN grants g ON g.id = l.target_id AND l.target_kind = 'grant'
         LEFT JOIN access_profile_assignments apa ON apa.id = l.target_id AND l.target_kind = 'profile_assignment'
         LEFT JOIN access_profiles ap ON ap.id = apa.profile_id
        WHERE l.task_id = $1
        ORDER BY l.created_at ASC, l.id ASC`,
      [taskId],
    );
    // WIRE NAMES (review 1f60bf8f B1): a JSON field is a named surface, so
    // these are compositional over ratified words. `carriedBy` says what
    // carries the assignment's access; `createdByAssignment` says whether
    // the assignment created this row — which is exactly what decides
    // whether it may ever remove it (owner default D4).
    return result.rows.map((row) => ({
      id: String(row.id),
      carriedBy: row.vehicle_kind === 'warrant' ? 'warrant' : row.vehicle_kind === 'role' ? 'role' : 'grant',
      warrantId: row.warrant_id ? String(row.warrant_id) : null,
      warrantName: row.warrant_name ?? null,
      warrantStatus: row.warrant_status ?? null,
      targetKind: row.target_kind,
      targetId: String(row.target_id),
      createdByAssignment: Boolean(row.created_by_vehicle),
      assigneePrincipalId: String(row.assignee_principal_id),
      landedOnPrincipalId: String(row.landed_on_principal_id),
      landedOnHandle: row.landed_on_handle ?? null,
      resourceType: row.resource_type ?? null,
      resourceId: row.resource_id ?? null,
      verb: row.verb ?? null,
      // AZ-A10 clauses 6 and 8. `roleGrantExpiresAt` is the date THIS task's
      // assigning act set for its link, in the request field's own name (null
      // = until the task or the assignment ends; always null for a warrant).
      // `expiresAt` is the row's effective date: the latest over every task
      // that links it, or an owner-plane row's own date. `expired` is decided
      // by the database clock, not the reader's.
      roleGrantExpiresAt: row.link_expires_iso ?? null,
      expiresAt: row.row_expires_iso ?? null,
      expired: row.row_expired === true,
      profileId: row.profile_id ? String(row.profile_id) : null,
      profileName: row.profile_name ?? null,
    }));
  }

  /** R5: warrants a new task in this phase could ride, for the creation
   * suggestion. Live, phase- or project-anchored, containing the phase. */
  async suggestionsForPhase(phaseId: string): Promise<Array<Record<string, unknown>>> {
    const result = await pool.query(
      `SELECT DISTINCT w.id, w.name, w.status, w.expires_at,
              hp.handle AS holder_handle, w.holder_principal_id
         FROM warrants w
         JOIN warrant_anchors wa ON wa.warrant_id = w.id
         LEFT JOIN principals hp ON hp.id = w.holder_principal_id
        WHERE w.status = 'active'
          AND (w.expires_at IS NULL OR w.expires_at > NOW())
          AND (
            (wa.anchor_type = 'phase' AND wa.anchor_id = $1::uuid)
            OR (wa.anchor_type = 'project' AND wa.anchor_id IN
                 (SELECT ph.project_id FROM phases ph WHERE ph.id = $1::uuid))
          )
        ORDER BY w.name ASC`,
      [phaseId],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      status: String(row.status),
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      holderPrincipalId: String(row.holder_principal_id),
      holderHandle: row.holder_handle ?? null,
    }));
  }
}

export const accessVehicleService = new AccessVehicleService();
