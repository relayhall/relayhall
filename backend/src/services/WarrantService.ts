// WarrantService.ts — Warrants (RH-P3.AZ-S4, card aa48fb12; AUTHZ design
// 4d961e37 §6.2–6.4; A17.5; AZ-7/AZ-16/AZ-21/AZ-31/AZ-33b;
// T3/T4/T17/T18/T23).
//
// A Warrant is the STANDING EXCEPTION to per-mint human approval: it names
// ONE holder (a Connector, or a service Account exercised through its live
// Connectors — the minted Agent's parent is ALWAYS the acting Connector,
// AZ-RT5), a SET of anchors (union semantics), a version-PINNED authority
// ceiling (AZ-21b — republish never silently widens, T23), MANDATORY
// expiry, optional caps and an optional transport pin.
//
// CREATION is a human-plane step-up act or root (T3: the route refuses
// bearer callers outright — a Connector can never warrant itself). ROOT
// warrants carry an explicit ceiling like everyone else's (AZ-31a — the
// schema refuses unbounded ceilings).
//
// SELECTION (§6.3, sol M8): every mint NAMES its target Task; containment
// is validated against the anchor union. An unnamed warrant auto-selects
// ONLY when exactly one live warrant of the acting holder contains the
// target; ANY multiplicity refuses — determinism beats cleverness.
//
// SERIALIZATION (AZ-33b, T18): warrant-mint takes SELECT ... FOR UPDATE on
// the warrant row, serializing against revoke and against sibling mints
// for cap accounting. Cap semantics (§6.2): max_concurrent counts LIVE
// minted identities through the provenance FK (a slot frees at
// disable/expiry); max_total is the monotonic minted_total counter.
// Over-cap refusals are LOUD and audited (T17).
//
// LIFECYCLE (§6.4, AZ-31a): the live-cap binds to the CREATING principal —
// creator disabled/terminated (or, for a non-root creator, narrowed below
// the ceiling) AUTO-SUSPENDS the warrant loudly (status + event + Access
// manager flag; resumable only by re-approval). Revocation keeps the
// record and stops new mints NOW. Expiry is one-way; single-task warrants
// expire when all anchors are terminal (the sweep persists the flip; mint
// checks it live).
import type { PoolClient } from 'pg';
import { pool } from '../db/connection';
import { auditService, type AuditActor } from './AuditService';
import { auditChainFor } from '../utils/auditChain';
import { principalService } from './PrincipalService';
import {
  accessProfileService, assertGovernableSurfaceSelectors, assertProjectBoundedSelectors,
  validateRules, type ProfileRule,
} from './AccessProfileService';
import {
  agentMintService,
  type MintAuthorityRequest, type MintedAgentPack,
} from './AgentMintService';
import {
  rulesCovered, scopesWithin, sourcesFromEffectiveAccess, sourcesFromRules,
} from '../utils/authorityContainment';
import { isMintableScope } from '../utils/scopeMap';
import { randomUUID } from 'crypto';
import { accessVehicleService } from './AccessVehicleService';
import type { AuthorizedTaskNarrowing } from '../middleware/sharedAuthorization';

/**
 * RH-P3.AZ-S7 (ruling 7440b579 R4 / AZ-A2 par.4): the idle grace a warrant
 * waits after ALL its anchors read terminal before it auto-expires.
 * Default 6 hours, deployment-configurable — the same env-var convention
 * the approval quotas use.
 */
export function warrantIdleGraceMs(): number {
  const raw = Number(process.env.RELAYHALL_WARRANT_IDLE_GRACE_HOURS);
  const hours = Number.isFinite(raw) && raw >= 0 ? raw : 6;
  return hours * 60 * 60 * 1000;
}
import { scopesForRole } from '../utils/identityScopes';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADMINISTRATOR_ROLES = new Set(['admin', 'orchestrator']);

export class WarrantError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'WarrantError';
  }
}

const err = (status: number, code: string, message: string) => new WarrantError(status, code, message);

export type AnchorType = 'task' | 'phase' | 'project';

export interface WarrantAnchorInput {
  anchorType: AnchorType;
  anchorId: string;
}

export interface WarrantRecord {
  id: string;
  name: string;
  description: string;
  holderPrincipalId: string;
  createdByPrincipalId: string | null;
  status: 'active' | 'suspended' | 'revoked' | 'expired';
  ceilingProfileVersionId: string | null;
  ceilingProfileId: string | null;
  ceilingProfileName: string | null;
  ceilingProfileVersionNumber: number | null;
  ceilingRules: ProfileRule[] | null;
  ceilingScopes: string[] | null;
  expiresAt: string | null;
  transportPin: 'any' | 'mcp' | 'api';
  agentMaxAgeHours: number | null;
  maxConcurrent: number | null;
  maxTotal: number | null;
  mintedTotal: number;
  liveMinted: number;
  suspendedReason: string | null;
  anchors: Array<{ anchorType: AnchorType; anchorId: string }>;
  createdAt: string;
  updatedAt: string;
}

function parseJsonColumn<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

function mapWarrant(row: any, anchors: any[], liveMinted: number): WarrantRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ''),
    holderPrincipalId: String(row.holder_principal_id),
    createdByPrincipalId: row.created_by_principal_id ? String(row.created_by_principal_id) : null,
    status: row.status,
    ceilingProfileVersionId: row.ceiling_profile_version_id ? String(row.ceiling_profile_version_id) : null,
    ceilingProfileId: row.ceiling_profile_id ? String(row.ceiling_profile_id) : null,
    ceilingProfileName: row.ceiling_profile_name ? String(row.ceiling_profile_name) : null,
    ceilingProfileVersionNumber: row.ceiling_profile_version_number !== null && row.ceiling_profile_version_number !== undefined
      ? Number(row.ceiling_profile_version_number) : null,
    ceilingRules: parseJsonColumn<ProfileRule[]>(row.ceiling_rules),
    ceilingScopes: parseJsonColumn<string[]>(row.ceiling_scopes),
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    transportPin: row.transport_pin,
    agentMaxAgeHours: row.agent_max_age_hours === null || row.agent_max_age_hours === undefined ? null : Number(row.agent_max_age_hours),
    maxConcurrent: row.max_concurrent === null || row.max_concurrent === undefined ? null : Number(row.max_concurrent),
    maxTotal: row.max_total === null || row.max_total === undefined ? null : Number(row.max_total),
    mintedTotal: Number(row.minted_total ?? 0),
    liveMinted,
    suspendedReason: row.suspended_reason ?? null,
    anchors: anchors.map((anchor) => ({ anchorType: anchor.anchor_type, anchorId: String(anchor.anchor_id) })),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const WARRANT_SELECT = `
  SELECT w.*, v.profile_id AS ceiling_profile_id, v.version_number AS ceiling_profile_version_number,
         ap.name AS ceiling_profile_name
    FROM warrants w
    LEFT JOIN access_profile_versions v ON v.id = w.ceiling_profile_version_id
    LEFT JOIN access_profiles ap ON ap.id = v.profile_id`;

async function writeWarrantEvent(
  queryable: { query: (t: string, p?: unknown[]) => Promise<{ rows: any[] }> },
  input: { warrantId: string; action: string; actor: AuditActor; metadata?: Record<string, unknown> },
): Promise<void> {
  await queryable.query(
    `INSERT INTO warrant_events (warrant_id, action, actor_principal_id, actor_handle, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [input.warrantId, input.action, input.actor.principalId ?? null, input.actor.handle || 'unknown', JSON.stringify(input.metadata ?? {})],
  );
}

export class WarrantService {
  /** Live minted-identity count through the §6.4 provenance FK: a slot
   * frees when the identity is disabled/terminated or its last credential
   * dies (§6.2 "max concurrent = COUNT of live minted identities"). */
  async liveMintedCount(queryable: { query: (t: string, p?: unknown[]) => Promise<{ rows: any[] }> }, warrantId: string): Promise<number> {
    const result = await queryable.query(
      `SELECT COUNT(*)::int AS live FROM principals p
        WHERE p.minted_under_warrant_id = $1 AND p.status = 'active'
          AND EXISTS (SELECT 1 FROM principal_credentials c
                       WHERE c.principal_id = p.id AND c.revoked_at IS NULL
                         AND (c.expires_at IS NULL OR c.expires_at > NOW())
                         AND (c.grace_until IS NULL OR c.grace_until > NOW()))`,
      [warrantId],
    );
    return Number(result.rows[0]?.live ?? 0);
  }

  async get(warrantId: string): Promise<WarrantRecord> {
    if (!UUID_PATTERN.test(warrantId)) throw err(404, 'WARRANT_NOT_FOUND', 'No such warrant');
    const result = await pool.query(`${WARRANT_SELECT} WHERE w.id = $1`, [warrantId]);
    if (result.rows.length === 0) throw err(404, 'WARRANT_NOT_FOUND', 'No such warrant');
    const anchors = await pool.query('SELECT anchor_type, anchor_id FROM warrant_anchors WHERE warrant_id = $1 ORDER BY anchor_type, anchor_id', [warrantId]);
    return mapWarrant(result.rows[0], anchors.rows, await this.liveMintedCount(pool, warrantId));
  }

  /** SELF-SCOPE listing (§6.1/§9.1): root sees everything; a non-root
   * session sees only warrants whose HOLDER lies in its own subtree
   * (itself included). Concealment is the caller's route concern; the
   * filter here simply never returns foreign rows. */
  async list(viewer: { principalId: string; isRoot: boolean }): Promise<WarrantRecord[]> {
    const result = viewer.isRoot
      ? await pool.query(`${WARRANT_SELECT} ORDER BY w.created_at DESC`)
      : await pool.query(
        `${WARRANT_SELECT}
          WHERE w.holder_principal_id IN (
            WITH RECURSIVE subtree AS (
              SELECT id FROM principals WHERE id = $1
              UNION ALL
              SELECT p.id FROM principals p JOIN subtree s ON p.parent_principal_id = s.id
            ) SELECT id FROM subtree)
          ORDER BY w.created_at DESC`,
        [viewer.principalId],
      );
    const records: WarrantRecord[] = [];
    for (const row of result.rows) {
      const anchors = await pool.query('SELECT anchor_type, anchor_id FROM warrant_anchors WHERE warrant_id = $1 ORDER BY anchor_type, anchor_id', [row.id]);
      records.push(mapWarrant(row, anchors.rows, await this.liveMintedCount(pool, String(row.id))));
    }
    return records;
  }

  /** The §6.4 minted-identity registry for one warrant (provenance FK, not
   * audit rows): every identity ever minted under it with its liveness. */
  async mintedIdentities(warrantId: string): Promise<Array<Record<string, unknown>>> {
    const result = await pool.query(
      `SELECT p.id, p.handle, p.display_name, p.status, p.bound_task_id, p.created_at,
              EXISTS (SELECT 1 FROM principal_credentials c
                       WHERE c.principal_id = p.id AND c.revoked_at IS NULL
                         AND (c.expires_at IS NULL OR c.expires_at > NOW())
                         AND (c.grace_until IS NULL OR c.grace_until > NOW())) AS live
         FROM principals p WHERE p.minted_under_warrant_id = $1
        ORDER BY p.created_at DESC`,
      [warrantId],
    );
    return result.rows.map((row) => ({
      principalId: String(row.id),
      handle: String(row.handle),
      displayName: row.display_name ?? null,
      status: row.status,
      boundTaskId: row.bound_task_id ? String(row.bound_task_id) : null,
      live: Boolean(row.live),
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async events(warrantId: string, limit = 100): Promise<any[]> {
    const result = await pool.query(
      `SELECT * FROM warrant_events WHERE warrant_id = $1
       ORDER BY occurred_at DESC, id DESC LIMIT $2`,
      [warrantId, Math.min(Math.max(limit, 1), 500)],
    );
    return result.rows.map((row) => ({
      id: row.id, occurredAt: row.occurred_at, warrantId: row.warrant_id,
      action: row.action, actorPrincipalId: row.actor_principal_id ?? null,
      actorHandle: row.actor_handle, metadata: row.metadata ?? {},
    }));
  }

  /**
   * Create a Warrant (§6.2). The ROUTE has already established this is a
   * human-plane SESSION act under step-up, or root (T3) — this method
   * validates the object: holder shape, anchors, ceiling (version-pinned
   * at creation, AZ-21b), expiry rules, caps, transport pin, and — for a
   * non-root creator — ceiling ⊆ the creator's CURRENT authority.
   */
  private async prepareCreate(input: {
    name: unknown;
    description?: unknown;
    holderPrincipalId: unknown;
    anchors: unknown;
    ceilingProfileId?: unknown;
    ceilingRules?: unknown;
    ceilingScopes?: unknown;
    expiresAt?: unknown;
    transportPin?: unknown;
    agentMaxAgeHours?: unknown;
    maxConcurrent?: unknown;
    maxTotal?: unknown;
  }, creator: { principalId: string; isRoot: boolean; sessionScopes?: string[] | null; stepUp: { tokenId: string; method: string } | null }, _actor: AuditActor) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 120) throw err(422, 'INVALID_WARRANT_VALUE', 'name must be a non-empty string of at most 120 characters');
    const description = typeof input.description === 'string' ? input.description : '';
    if (description.length > 2000) throw err(422, 'INVALID_WARRANT_VALUE', 'description must be at most 2000 characters');

    // Holder (§6.2): one Connector (parented service) or a service Account
    // (exercised through its live Connectors). Never a human, never an
    // Agent, never a legacy row.
    if (typeof input.holderPrincipalId !== 'string' || !UUID_PATTERN.test(input.holderPrincipalId)) {
      throw err(422, 'INVALID_WARRANT_VALUE', 'holderPrincipalId must be a full UUID');
    }
    const holder = await principalService.getPrincipalById(input.holderPrincipalId);
    if (!holder) throw err(422, 'HOLDER_NOT_FOUND', 'holderPrincipalId resolves to no principal');
    if (holder.legacyIdentity) throw err(409, 'LEGACY_FROZEN', 'legacy identities are frozen out of Warrant holding (§10, T37)');
    if (holder.status !== 'active') throw err(409, 'HOLDER_NOT_ACTIVE', `the holder is ${holder.status}`);
    if (holder.kind !== 'service') {
      throw err(422, 'INVALID_HOLDER_SHAPE', 'a Warrant holder is a Connector or a service Account (design 4d961e37 §6.2)');
    }

    // Anchors: non-empty union of existing tasks/phases/projects.
    if (!Array.isArray(input.anchors) || input.anchors.length === 0) {
      throw err(422, 'INVALID_WARRANT_VALUE', 'anchors must be a non-empty array of {anchorType, anchorId}');
    }
    if (input.anchors.length > 100) throw err(422, 'INVALID_WARRANT_VALUE', 'anchors must be at most 100 entries');
    const anchors: WarrantAnchorInput[] = [];
    const anchorTables: Record<AnchorType, string> = { task: 'tasks', phase: 'phases', project: 'projects' };
    for (const raw of input.anchors as Array<Record<string, unknown>>) {
      const anchorType = raw?.anchorType;
      const anchorId = raw?.anchorId;
      if (anchorType !== 'task' && anchorType !== 'phase' && anchorType !== 'project') {
        throw err(422, 'INVALID_WARRANT_VALUE', "each anchor's anchorType must be 'task', 'phase' or 'project'");
      }
      if (typeof anchorId !== 'string' || !UUID_PATTERN.test(anchorId)) {
        throw err(422, 'INVALID_WARRANT_VALUE', "each anchor's anchorId must be a full UUID");
      }
      const exists = await pool.query(`SELECT 1 FROM ${anchorTables[anchorType]} WHERE id = $1`, [anchorId]);
      if (exists.rows.length === 0) throw err(422, 'ANCHOR_NOT_FOUND', `${anchorType} anchor ${anchorId} resolves to no row`);
      anchors.push({ anchorType, anchorId });
    }

    // Expiry (§6.2): MANDATORY — task-terminal expiry only for single-TASK
    // warrants; multi-anchor warrants require an explicit date.
    let expiresAt: Date | null = null;
    if (input.expiresAt !== undefined && input.expiresAt !== null) {
      expiresAt = new Date(String(input.expiresAt));
      if (Number.isNaN(expiresAt.getTime())) throw err(422, 'INVALID_WARRANT_VALUE', 'expiresAt must be a parseable timestamp');
      if (expiresAt.getTime() <= Date.now()) throw err(422, 'INVALID_WARRANT_VALUE', 'expiresAt must lie in the future');
    }
    const singleTask = anchors.length === 1 && anchors[0].anchorType === 'task';
    if (!expiresAt && !singleTask) {
      throw err(422, 'EXPIRY_REQUIRED',
        'multi-anchor warrants require an explicit expiry date (§6.2); only a single-task warrant may rely on task-terminal expiry alone');
    }

    // Ceiling (AZ-21b/AZ-31a): a profile reference pins the version
    // PUBLISHED NOW, or inline rules — exactly one form, never unbounded.
    const hasProfile = input.ceilingProfileId !== undefined && input.ceilingProfileId !== null;
    const hasRules = input.ceilingRules !== undefined && input.ceilingRules !== null;
    if (hasProfile === hasRules) {
      throw err(422, 'CEILING_REQUIRED',
        'a warrant ceiling is exactly one of: ceilingProfileId (an existing published profile) or ceilingRules (which the server publishes as a profile) — never both, never neither (AZ-31a)');
    }
    // AZ-A3: there is ONE ceiling shape — a version-pinned Access profile.
    // `ceilingRules` survives as a creation-time convenience: the rules are
    // validated here and published as a profile inside the warrant's own
    // transaction below, so the pin is taken exactly as AZ-21b requires and
    // a failed warrant leaves no orphan profile.
    let ceilingProfileVersionId: string | null = null;
    let ceilingRulesForCheck: ProfileRule[];
    if (hasProfile) {
      if (typeof input.ceilingProfileId !== 'string' || !UUID_PATTERN.test(input.ceilingProfileId)) {
        throw err(422, 'INVALID_WARRANT_VALUE', 'ceilingProfileId must be a full UUID');
      }
      const profile = await pool.query(
        `SELECT ap.published_version_id FROM access_profiles ap WHERE ap.id = $1`,
        [input.ceilingProfileId],
      );
      if (profile.rows.length === 0) throw err(422, 'PROFILE_NOT_FOUND', 'ceilingProfileId resolves to no profile');
      if (!profile.rows[0].published_version_id) {
        throw err(409, 'PROFILE_UNPUBLISHED', 'an unpublished profile cannot serve as a warrant ceiling (T35 fail-closed)');
      }
      ceilingProfileVersionId = String(profile.rows[0].published_version_id);
      ceilingRulesForCheck = await this.rulesOfVersion(ceilingProfileVersionId);
    } else {
      ceilingRulesForCheck = validateRules(input.ceilingRules);
    }
    let ceilingScopes: string[] | null = null;
    if (input.ceilingScopes !== undefined && input.ceilingScopes !== null) {
      if (!Array.isArray(input.ceilingScopes) || input.ceilingScopes.length === 0) {
        throw err(422, 'INVALID_WARRANT_VALUE', 'ceilingScopes must be a non-empty array when given');
      }
      ceilingScopes = (input.ceilingScopes as unknown[]).map(String);
      for (const scope of ceilingScopes) {
        if (scope === 'root' || scope.endsWith(':admin') || !isMintableScope(scope)) {
          throw err(422, 'INVALID_WARRANT_VALUE', `'${scope}' cannot appear in an Agent scope ceiling (§5.2 rules 2/3)`);
        }
      }
    }

    // Ceiling within the creator's authority AT CREATION (§6.2) — BOTH
    // halves (review 1897c959 B1). A root session is the board-wide
    // superset; a non-root Account session must prove containment of the
    // OBJECT ceiling against its own sources AND of the SCOPE ceiling
    // against its current effective session scopes (§5.2 rule 1: step-up
    // authorized the act and never widened anything).
    if (!creator.isRoot) {
      const sources = sourcesFromEffectiveAccess(await accessProfileService.effectiveAccess(creator.principalId));
      const check = rulesCovered(sources, ceilingRulesForCheck);
      if (!check.covered) {
        throw err(403, 'CEILING_EXCEEDS_CREATOR',
          `the warrant ceiling exceeds the creator's authority (§6.2): ${JSON.stringify(check.failing)}`);
      }
      if (ceilingScopes) {
        const scopeCheck = scopesWithin(creator.sessionScopes ?? [], ceilingScopes);
        if (!scopeCheck.within) {
          throw err(403, 'CEILING_EXCEEDS_CREATOR',
            `the warrant scope ceiling exceeds the creator's current effective scopes (§6.2): ${scopeCheck.exceeding.join(', ')}`);
        }
      }
    }

    const transportPin = input.transportPin === undefined || input.transportPin === null ? 'any' : String(input.transportPin);
    if (!['any', 'mcp', 'api'].includes(transportPin)) {
      throw err(422, 'INVALID_WARRANT_VALUE', "transportPin must be 'any', 'mcp' or 'api'");
    }
    const intOrNull = (value: unknown, what: string, max: number): number | null => {
      if (value === undefined || value === null) return null;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
        throw err(422, 'INVALID_WARRANT_VALUE', `${what} must be an integer between 1 and ${max}`);
      }
      return parsed;
    };
    const agentMaxAgeHours = intOrNull(input.agentMaxAgeHours, 'agentMaxAgeHours', 168);
    const maxConcurrent = intOrNull(input.maxConcurrent, 'maxConcurrent', 1000);
    const maxTotal = intOrNull(input.maxTotal, 'maxTotal', 100000);

    return { name, description, anchors, expiresAt, hasProfile, ceilingProfileVersionId, ceilingRulesForCheck,
      ceilingScopes, transportPin, agentMaxAgeHours, maxConcurrent, maxTotal };
  }
  async previewCreate(input: Parameters<WarrantService['create']>[0], creator: Parameters<WarrantService['create']>[1], actor: AuditActor) {
    const prepared = await this.prepareCreate(input, creator, actor);
    return { ...prepared, holderPrincipalId: input.holderPrincipalId, expiresAt: prepared.expiresAt?.toISOString() ?? null };
  }
  async create(input: {
    name: unknown;
    description?: unknown;
    holderPrincipalId: unknown;
    anchors: unknown;
    ceilingProfileId?: unknown;
    ceilingRules?: unknown;
    ceilingScopes?: unknown;
    expiresAt?: unknown;
    transportPin?: unknown;
    agentMaxAgeHours?: unknown;
    maxConcurrent?: unknown;
    maxTotal?: unknown;
  }, creator: { principalId: string; isRoot: boolean; sessionScopes?: string[] | null; stepUp: { tokenId: string; method: string } | null }, actor: AuditActor, transactionClient?: PoolClient): Promise<WarrantRecord> {
    let { name, description, anchors, expiresAt, hasProfile, ceilingProfileVersionId, ceilingRulesForCheck,
      ceilingScopes, transportPin, agentMaxAgeHours, maxConcurrent, maxTotal } = await this.prepareCreate(input, creator, actor);
    const client = transactionClient ?? await pool.connect();
    try {
      if (!transactionClient) await client.query('BEGIN');

      // AZ-A3: inline rules become a real, named, published profile. It is
      // created in THIS transaction, by the creating principal, as part of
      // the same step-up-gated act — so the authority a caller just defined
      // is listable, previewable and reusable instead of anonymous JSON on
      // one row, and a rolled-back warrant takes the profile with it.
      if (!hasProfile) {
        ceilingProfileVersionId = await this.publishCeilingProfile(
          client, name, ceilingRulesForCheck, creator.principalId, actor);
      }

      const created = await client.query(
        `INSERT INTO warrants
           (name, description, holder_principal_id, created_by_principal_id,
            ceiling_profile_version_id, ceiling_rules, ceiling_scopes, expires_at,
            transport_pin, agent_max_age_hours, max_concurrent, max_total)
         VALUES ($1, $2, $3, $4, $5, NULL, $6::jsonb, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          name, description, input.holderPrincipalId, creator.principalId,
          ceilingProfileVersionId,
          ceilingScopes ? JSON.stringify(ceilingScopes) : null,
          expiresAt, transportPin, agentMaxAgeHours, maxConcurrent, maxTotal,
        ],
      );
      const warrantId = String(created.rows[0].id);
      for (const anchor of anchors) {
        await client.query(
          'INSERT INTO warrant_anchors (warrant_id, anchor_type, anchor_id) VALUES ($1, $2, $3)',
          [warrantId, anchor.anchorType, anchor.anchorId],
        );
      }
      await writeWarrantEvent(client, {
        warrantId, action: 'warrant.created', actor,
        metadata: { holderPrincipalId: input.holderPrincipalId, anchors, ceilingProfileVersionId, transportPin, stepUp: creator.stepUp },
      });
      await auditService.record({
        action: 'warrant.create', actor,
        resourceType: 'warrant', resourceId: warrantId,
        metadata: {
          holderPrincipalId: input.holderPrincipalId, anchors,
          ceilingProfileVersionId, ceilingScopes, expiresAt: expiresAt?.toISOString() ?? null,
          transportPin, maxConcurrent, maxTotal, stepUp: creator.stepUp,
          chain: await auditChainFor(client, String(input.holderPrincipalId)),
        },
      }, client);
      if (!transactionClient) await client.query('COMMIT');
      if (transactionClient) {
        const row = (await client.query(WARRANT_SELECT + ' WHERE w.id=$1', [warrantId])).rows[0];
        return mapWarrant(row, anchors.map(anchor => ({anchor_type:anchor.anchorType,anchor_id:anchor.anchorId})), 0);
      }
      return this.get(warrantId);
    } catch (e) {
      if (!transactionClient) await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      if (!transactionClient) client.release();
    }
  }

  private async rulesOfVersion(versionId: string): Promise<ProfileRule[]> {
    const result = await pool.query(
      'SELECT resource_type, selector_form, selector_ids, verbs FROM access_profile_rules WHERE version_id = $1',
      [versionId],
    );
    return result.rows.map((row) => ({
      resourceType: row.resource_type,
      selectorForm: row.selector_form,
      selectorIds: (row.selector_ids ?? []).map(String),
      verbs: row.verbs ?? [],
    }));
  }

  /** Name/description touch-ups only — authority fields are immutable by
   * construction; widening is a NEW warrant (re-approval). */
  async update(warrantId: string, input: { name?: unknown; description?: unknown }, actor: AuditActor): Promise<WarrantRecord> {
    const existing = await this.get(warrantId);
    const sets: string[] = [];
    const params: unknown[] = [warrantId];
    if (input.name !== undefined) {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name || name.length > 120) throw err(422, 'INVALID_WARRANT_VALUE', 'name must be a non-empty string of at most 120 characters');
      params.push(name);
      sets.push(`name = $${params.length}`);
    }
    if (input.description !== undefined) {
      const description = typeof input.description === 'string' ? input.description : null;
      if (description === null || description.length > 2000) throw err(422, 'INVALID_WARRANT_VALUE', 'description must be a string of at most 2000 characters');
      params.push(description);
      sets.push(`description = $${params.length}`);
    }
    if (sets.length === 0) return existing;
    // §9.7 / card DoD "full-chain audit rows for every act" (review
    // 644a2538 F1): the mutation, its warrant.updated provenance event and
    // the central audit act commit as ONE transaction — a failed ledger
    // write rolls the edit back, never the other way round.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE warrants SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, params);
      await writeWarrantEvent(client, { warrantId, action: 'warrant.updated', actor, metadata: { fields: sets.length } });
      await auditService.record({
        action: 'warrant.update', actor,
        resourceType: 'warrant', resourceId: warrantId,
        metadata: {
          fields: sets.length,
          renamed: input.name !== undefined,
          redescribed: input.description !== undefined,
          chain: await auditChainFor(client, existing.holderPrincipalId),
        },
      }, client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    return this.get(warrantId);
  }

  /** Revoke (§6.4): keeps the record, stops new mints NOW and blocks
   * further lease-driven extensions for minted Agents (the §8.3 hook rides
   * AZ-S5's lease surface; the status is what that hook consults). */
  /**
   * R4 (ruling 7440b579): "Revoking or suspending a warrant first WARNS
   * with the enumerated list of dependent not-yet-terminal tasks;
   * proceeding AUTO-UNASSIGNS them." On a REST surface the warning is a
   * refusal that CARRIES the list: without `acknowledgeDependents` the act
   * refuses and enumerates, and the caller decides. The UI renders that
   * list as the revoke warning dialog; the CLI prints it.
   */
  async revoke(
    warrantId: string,
    reason: string | null,
    actor: AuditActor,
    /**
     * Which of the dependent Tasks this caller may READ.
     *
     * The COUNT is the decision - a revoke must be acknowledged against every
     * Task it will unassign, including ones the caller cannot see, or the
     * acknowledgement means less than it says. The ENUMERATION is a
     * disclosure, and it carried each Task's TITLE to any holder-tree viewer
     * (review 302a338f B2). Holding a warrant is not authority over the Tasks
     * riding it: `create` validates that an anchor row EXISTS and nothing
     * more, so the two are genuinely independent.
     *
     * REQUIRED, so a caller cannot forget which of the two it is handing over.
     */
    visible: AuthorizedTaskNarrowing,
    options: { acknowledgeDependents?: boolean } = {},
  ): Promise<WarrantRecord> {
    if (!options.acknowledgeDependents) {
      const dependents = await accessVehicleService.dependentOpenTasks(warrantId);
      if (dependents.length > 0) {
        const readable = await visible(dependents, (task) => task.id);
        const listing = readable.map((task) => `${task.id} (${task.status}) ${task.title}`).join('; ');
        const concealed = dependents.length - readable.length;
        const tail = readable.length === 0
          ? `none of them are readable by you`
          : `${listing}${concealed > 0 ? `; and ${concealed} more you may not read` : ''}`;
        throw err(409, 'WARRANT_HAS_DEPENDENT_TASKS',
          `revoking this warrant will UNASSIGN ${dependents.length} not-yet-terminal task(s) that ride it (ruling 7440b579 R4). Re-send with acknowledgeDependents to proceed: ${tail}`);
      }
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await client.query('SELECT status FROM warrants WHERE id = $1 FOR UPDATE', [warrantId]);
      if (row.rows.length === 0) throw err(404, 'WARRANT_NOT_FOUND', 'No such warrant');
      if (row.rows[0].status === 'revoked') {
        await client.query('ROLLBACK');
        return this.get(warrantId); // idempotent
      }
      if (row.rows[0].status === 'expired') throw err(409, 'WARRANT_EXPIRED', 'an expired warrant is one-way (§6.2) and needs no revocation');
      await client.query(
        `UPDATE warrants SET status = 'revoked', revoked_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [warrantId],
      );
      // R4: proceeding auto-unassigns — which also silences those tasks'
      // doorbells (ccd53781 R2). In-flight work finishes on its
      // task-bounded credentials; force-release stays the hard stop.
      const released = await accessVehicleService.releaseWarrant(client, warrantId, actor,
        'AZ-S7: the carrying warrant was revoked (ruling 7440b579 R4)');
      await writeWarrantEvent(client, {
        warrantId, action: 'warrant.revoked', actor,
        metadata: { reason, unassignedTaskIds: released.unassignedTaskIds },
      });
      await auditService.record({
        action: 'warrant.revoke', actor, resourceType: 'warrant', resourceId: warrantId,
        metadata: { reason, unassignedTaskIds: released.unassignedTaskIds },
      }, client);
      await client.query('COMMIT');
      return this.get(warrantId);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** Resume (§6.4): a suspended warrant returns to service ONLY by this
   * re-approval act — the route gates it as human-plane step-up or root.
   * Resumption re-proves the creator live-cap first. */
  async resume(warrantId: string, actor: AuditActor): Promise<WarrantRecord> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await client.query(`${WARRANT_SELECT} WHERE w.id = $1 FOR UPDATE OF w`, [warrantId]);
      if (row.rows.length === 0) throw err(404, 'WARRANT_NOT_FOUND', 'No such warrant');
      if (row.rows[0].status !== 'suspended') throw err(409, 'WARRANT_NOT_SUSPENDED', `only a suspended warrant resumes (status: ${row.rows[0].status})`);
      const creatorProblem = await this.creatorCapProblem(client, row.rows[0]);
      if (creatorProblem) {
        throw err(409, 'CREATOR_CAP_UNMET', `the creator live-cap still fails (AZ-31a): ${creatorProblem}`);
      }
      await client.query(
        `UPDATE warrants SET status = 'active', suspended_reason = NULL, suspended_at = NULL, updated_at = NOW() WHERE id = $1`,
        [warrantId],
      );
      await writeWarrantEvent(client, { warrantId, action: 'warrant.resumed', actor, metadata: {} });
      await auditService.record({
        action: 'warrant.resume', actor, resourceType: 'warrant', resourceId: warrantId, metadata: {},
      }, client);
      await client.query('COMMIT');
      return this.get(warrantId);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * The AZ-31a creator live-cap: creator disabled/terminated, or (for a
   * non-root creator) currently narrowed below the ceiling. Returns the
   * problem text, or null when the cap holds. NULL creator (pre-backfill
   * rows) fails closed.
   */
  private async creatorCapProblem(
    queryable: { query: (t: string, p?: unknown[]) => Promise<{ rows: any[] }> },
    warrantRow: any,
  ): Promise<string | null> {
    const creatorId = warrantRow.created_by_principal_id ? String(warrantRow.created_by_principal_id) : null;
    if (!creatorId) return 'the warrant records no creating principal';
    const creator = await queryable.query('SELECT status, role, kind, parent_principal_id FROM principals WHERE id = $1', [creatorId]);
    if (creator.rows.length === 0) return 'the creating principal resolves to no row';
    if (creator.rows[0].status !== 'active') return `the creating principal is ${creator.rows[0].status}`;
    if (ADMINISTRATOR_ROLES.has(String(creator.rows[0].role || '').toLowerCase())) return null;
    const ceilingRules = warrantRow.ceiling_profile_version_id
      ? await this.rulesOfVersion(String(warrantRow.ceiling_profile_version_id))
      : (parseJsonColumn<ProfileRule[]>(warrantRow.ceiling_rules) ?? []);
    const sources = sourcesFromEffectiveAccess(await accessProfileService.effectiveAccess(creatorId));
    const check = rulesCovered(sources, ceilingRules);
    if (!check.covered) return `the creator is narrowed below the ceiling: ${JSON.stringify(check.failing)}`;
    // SCOPE half of the cap (review 1897c959 B1): a session Account's live
    // scope authority is its role-derived set (the same trusted source the
    // auth middleware uses for sessions) — a role narrowed below the scope
    // ceiling suspends the warrant exactly like an object narrowing.
    const ceilingScopes = parseJsonColumn<string[]>(warrantRow.ceiling_scopes);
    if (ceilingScopes) {
      const scopeCheck = scopesWithin(scopesForRole(creator.rows[0].role), ceilingScopes);
      if (!scopeCheck.within) {
        return `the creator's role-derived scopes no longer cover the scope ceiling: ${scopeCheck.exceeding.join(', ')}`;
      }
    }
    return null;
  }

  /**
   * AZ-A3: publish a warrant's inline ceiling rules as an Access profile and
   * return the published version id to pin (AZ-21b).
   *
   * Written as direct SQL rather than through AccessProfileService because
   * each of that service's acts opens its OWN transaction, and this one has
   * to ride the warrant's: a warrant that fails validation after this point
   * must not leave a published profile behind.
   *
   * The name is derived from the warrant and disambiguated by a short random
   * suffix, because `access_profiles` is UNIQUE on lower(name) and two
   * warrants may legitimately share a name. Everything else follows the
   * ratified 095 shape — immutable version, published pointer, append-only
   * event ledger.
   */
  private async publishCeilingProfile(
    client: PoolClient,
    warrantName: string,
    rules: ProfileRule[],
    createdByPrincipalId: string,
    actor: AuditActor,
  ): Promise<string> {
    // THE `surface` CLOSURE, on the SECOND writer of `access_profile_rules`
    // (AZ-A5 clause 3: "refused at EVERY write surface"; owner ruling
    // `70af4d82` §1.1 for the authority-mutation half).
    //
    // `validateRules` — the synchronous half — is on every path that reaches
    // here, so `exact`-only and read/write-only already hold. What did NOT hold
    // until round 2 of this candidate's cross-family review is the half that
    // needs a ROW: a warrant's inline ceiling could name a `locked`, an
    // `always-self` or an authority-mutation Access surface, because
    // `assertGovernableSurfaceSelectors` was reached from
    // `AccessProfileService.createVersion` alone (regression `3b9ff322`).
    //
    // The consequence was bounded to zero by the evaluator half — the arm
    // refuses all three classes before it computes a level — but "bounded to
    // zero downstream" is not the same as "unrepresentable at the write", and
    // this design's whole delivery model is the latter. It runs on the
    // WARRANT'S client, inside the warrant's transaction, so a surface retired
    // concurrently cannot slip between the check and the write.
    await assertGovernableSurfaceSelectors(rules, client, actor);
    // The project-bounded half of the same closure, on the WARRANT'S client for
    // two reasons: `AccessProfileService.createVersion` is not on this path
    // (regression `3b9ff322` is the type case for what one missed write surface
    // costs), so the sibling validator is called at both coordinates or the
    // closure is not one; and the `FOR KEY SHARE` lock it takes must be held by
    // the transaction that writes the rule, not by a stray connection.
    await assertProjectBoundedSelectors(rules, client);

    const suffix = randomUUID().slice(0, 8);
    const profileName = `Warrant ceiling — ${warrantName}`.slice(0, 100) + ` (${suffix})`;
    const profile = await client.query(
      `INSERT INTO access_profiles (name, description, created_by_principal_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [
        profileName,
        `Published from the inline ceiling of warrant "${warrantName}" (AZ-A3). Edit by creating a new warrant; warrant authority is immutable.`,
        createdByPrincipalId,
      ],
    );
    const profileId = String(profile.rows[0].id);
    const version = await client.query(
      `INSERT INTO access_profile_versions (profile_id, version_number, created_by_principal_id)
       VALUES ($1, 1, $2) RETURNING id`,
      [profileId, createdByPrincipalId],
    );
    const versionId = String(version.rows[0].id);
    for (const rule of rules) {
      await client.query(
        `INSERT INTO access_profile_rules (version_id, resource_type, selector_form, selector_ids, verbs)
         VALUES ($1, $2, $3, $4::uuid[], $5::text[])`,
        [versionId, rule.resourceType, rule.selectorForm, rule.selectorIds, rule.verbs],
      );
    }
    await client.query(
      'UPDATE access_profiles SET published_version_id = $2, updated_at = NOW() WHERE id = $1',
      [profileId, versionId],
    );
    for (const action of ['profile.created', 'version.created', 'profile.published']) {
      await client.query(
        `INSERT INTO access_profile_events (profile_id, version_id, action, actor_principal_id, actor_handle, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          profileId, versionId, action, actor.principalId ?? null, actor.handle ?? 'system',
          JSON.stringify({ automatic: true, reason: 'AZ-A3: published from a warrant inline ceiling' }),
        ],
      );
    }
    // BOTH central acts, in this transaction (review 3e0a103d B7). This path
    // creates a profile AND publishes it; §9.7 audits publication and §5.2
    // rule 8 audits every authority act, so recording only the creation left
    // a required act absent from audit_events on the new happy path. The
    // canonical publisher (AccessProfileService.publish) records
    // `profile.publish` — the convenience path records the same action, with
    // the same shape, so an audit reader cannot tell which route published a
    // profile except by the automatic marker.
    await auditService.record({
      action: 'profile.create', actor, resourceType: 'access_profile', resourceId: profileId,
      metadata: { automatic: true, reason: 'AZ-A3: published from a warrant inline ceiling', versionId },
    }, client);
    await auditService.record({
      action: 'profile.publish', actor, resourceType: 'access_profile', resourceId: profileId,
      metadata: { automatic: true, reason: 'AZ-A3: published from a warrant inline ceiling', versionId, versionNumber: 1 },
    }, client);
    return versionId;
  }

  /** Auto-suspend LOUDLY (AZ-31a): status + event + audit; the Access
   * manager surfaces the flag. Runs inside the caller's transaction. */
  private async autoSuspend(client: PoolClient, warrantId: string, reason: string, actor: AuditActor): Promise<void> {
    await client.query(
      `UPDATE warrants SET status = 'suspended', suspended_reason = $2, suspended_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'active'`,
      [warrantId, reason],
    );
    // R4: suspending auto-unassigns the dependent not-yet-terminal tasks.
    // There is no human in an AUTOMATIC suspension to warn first, so the
    // enumerated list lands in the audit metadata instead of a dialog —
    // the protective half of R4 still fires, loudly.
    const released = await accessVehicleService.releaseWarrant(client, warrantId, actor,
      `AZ-S7: the carrying warrant auto-suspended (${reason})`);
    if (released.unassignedTaskIds.length > 0) {
      await writeWarrantEvent(client, {
        warrantId, action: 'warrant.suspended', actor,
        metadata: { reason, automatic: true, unassignedTaskIds: released.unassignedTaskIds },
      });
    }
    await writeWarrantEvent(client, { warrantId, action: 'warrant.suspended', actor, metadata: { reason, automatic: true } });
    await auditService.record({
      action: 'warrant.suspend', actor, resourceType: 'warrant', resourceId: warrantId,
      metadata: { reason, automatic: true },
    }, client);
  }

  /** Anchor-union containment (§6.3): the target task, its phase or its
   * project appears in the anchor set. */
  async anchorsContainTask(
    queryable: { query: (t: string, p?: unknown[]) => Promise<{ rows: any[] }> },
    warrantId: string,
    taskId: string,
  ): Promise<boolean> {
    const result = await queryable.query(
      `SELECT 1 FROM warrant_anchors wa
        WHERE wa.warrant_id = $1 AND (
          (wa.anchor_type = 'task' AND wa.anchor_id = $2::uuid)
          OR (wa.anchor_type = 'phase' AND wa.anchor_id IN (SELECT t.phase_id FROM tasks t WHERE t.id = $2::uuid AND t.phase_id IS NOT NULL))
          OR (wa.anchor_type = 'project' AND wa.anchor_id IN (SELECT t.project_id FROM tasks t WHERE t.id = $2::uuid AND t.project_id IS NOT NULL))
        ) LIMIT 1`,
      [warrantId, taskId],
    );
    return result.rows.length > 0;
  }

  /**
   * Candidate warrants for an acting principal + target task (§6.2–6.3):
   * warrants held by the acting Connector itself OR by its parent service
   * Account (exercised through its live Connectors), live, containing the
   * task. Used by auto-select and by the named-warrant validation.
   */
  private async candidateWarrantIds(actingPrincipalId: string, taskId: string): Promise<string[]> {
    const result = await pool.query(
      `SELECT w.id FROM warrants w
        WHERE w.status = 'active'
          AND (w.expires_at IS NULL OR w.expires_at > NOW())
          AND (w.holder_principal_id = $1
               OR w.holder_principal_id IN (
                 SELECT p.parent_principal_id FROM principals p
                  WHERE p.id = $1 AND p.parent_principal_id IS NOT NULL
                    AND EXISTS (SELECT 1 FROM principals acct
                                 WHERE acct.id = p.parent_principal_id
                                   AND acct.kind = 'service' AND acct.parent_principal_id IS NULL)))
        ORDER BY w.created_at ASC`,
      [actingPrincipalId],
    );
    const contained: string[] = [];
    for (const row of result.rows) {
      if (await this.anchorsContainTask(pool, String(row.id), taskId)) contained.push(String(row.id));
    }
    return contained;
  }

  /**
   * WARRANT-MINT (§6.2–6.4, AZ-31b/AZ-33b): resolve the warrant (named, or
   * auto-selected only when exactly ONE live warrant contains the target —
   * sol M8), take SELECT FOR UPDATE on its row (T18: serializes against
   * revoke and sibling mints), re-validate EVERYTHING live (holder match,
   * containment T4, creator live-cap with loud auto-suspend, caps T17,
   * ceiling T23, requester ⊆ T2), then mint in the same transaction. The
   * selected warrant id returns in the response and the audit row.
   */
  async mintUnderWarrant(input: {
    actingPrincipalId: string;
    actingCredentialScopes: string[];
    targetTaskId: string;
    warrantId?: string | null;
    authority: MintAuthorityRequest;
    label?: string | null;
  }, actor: AuditActor): Promise<MintedAgentPack> {
    // Selection happens OUTSIDE the lock; every fact that matters is
    // re-validated under the lock below.
    let warrantId = input.warrantId ?? null;
    if (warrantId && !UUID_PATTERN.test(warrantId)) {
      throw err(404, 'WARRANT_NOT_FOUND', 'No such warrant');
    }
    if (!warrantId) {
      const candidates = await this.candidateWarrantIds(input.actingPrincipalId, input.targetTaskId);
      if (candidates.length === 0) {
        throw err(409, 'NO_CONTAINING_WARRANT', 'no live warrant of this holder contains the target task (§6.3)');
      }
      if (candidates.length > 1) {
        // sol M8: ANY multiplicity refuses — determinism beats cleverness.
        throw err(409, 'AMBIGUOUS_WARRANT',
          `multiple live warrants contain the target task — name the warrant (warrantId) explicitly (§6.3): ${candidates.join(', ')}`);
      }
      warrantId = candidates[0];
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // AZ-33b/T18: the row lock serializes mint-vs-revoke and sibling
      // mints; cap counting below happens under this lock.
      const locked = await client.query(`SELECT * FROM warrants WHERE id = $1 FOR UPDATE`, [warrantId]);
      if (locked.rows.length === 0) throw err(404, 'WARRANT_NOT_FOUND', 'No such warrant');
      const warrant = locked.rows[0];

      if (warrant.status === 'revoked') throw err(409, 'WARRANT_REVOKED', 'this warrant is revoked (§6.4): no new mints');
      if (warrant.status === 'expired') throw err(409, 'WARRANT_EXPIRED', 'this warrant is expired (§6.2): expiry is one-way');
      if (warrant.status === 'suspended') throw err(409, 'WARRANT_SUSPENDED', `this warrant is suspended (${warrant.suspended_reason ?? 'AZ-31a'}): resumable only by re-approval`);
      if (warrant.expires_at && new Date(warrant.expires_at).getTime() <= Date.now()) {
        // Live enforcement; the sweep persists the flip.
        throw err(409, 'WARRANT_EXPIRED', 'this warrant is past its expiry (§6.2, evaluated live)');
      }

      // Holder match: the acting principal, or its parent service Account.
      const actingRow = await client.query('SELECT parent_principal_id, kind FROM principals WHERE id = $1', [input.actingPrincipalId]);
      const actingParent = actingRow.rows[0]?.parent_principal_id ? String(actingRow.rows[0].parent_principal_id) : null;
      const holderId = String(warrant.holder_principal_id);
      if (holderId !== input.actingPrincipalId && holderId !== actingParent) {
        // Concealment: a foreign warrant id is indistinguishable from a
        // missing one.
        throw err(404, 'WARRANT_NOT_FOUND', 'No such warrant');
      }

      // Containment (T4): the named target inside the anchor union.
      if (!(await this.anchorsContainTask(client, String(warrant.id), input.targetTaskId))) {
        throw err(409, 'ANCHOR_CONTAINMENT_FAILED', 'the target task lies outside this warrant\'s anchor union (§6.3, T4)');
      }

      // Creator live-cap (AZ-31a): failure AUTO-SUSPENDS loudly and refuses.
      const creatorProblem = await this.creatorCapProblem(client, warrant);
      if (creatorProblem) {
        await this.autoSuspend(client, String(warrant.id), creatorProblem, actor);
        await client.query('COMMIT'); // the suspension must survive the refusal
        throw err(409, 'WARRANT_SUSPENDED', `warrant auto-suspended (AZ-31a): ${creatorProblem}`);
      }

      // Caps (§6.2, T17): counted under the lock.
      if (warrant.max_total !== null && Number(warrant.minted_total) >= Number(warrant.max_total)) {
        throw err(409, 'WARRANT_CAP_EXHAUSTED', `max_total cap reached (${warrant.max_total}) — over-cap mints refuse loudly (T17)`);
      }
      if (warrant.max_concurrent !== null) {
        const live = await this.liveMintedCount(client, String(warrant.id));
        if (live >= Number(warrant.max_concurrent)) {
          throw err(409, 'WARRANT_CAP_EXHAUSTED', `max_concurrent cap reached (${live}/${warrant.max_concurrent}) — a slot frees at disable/expiry (T17)`);
        }
      }

      // Ceiling (T23: the pinned version, never the republished one).
      const ceilingRules = warrant.ceiling_profile_version_id
        ? await this.rulesOfVersion(String(warrant.ceiling_profile_version_id))
        : (parseJsonColumn<ProfileRule[]>(warrant.ceiling_rules) ?? []);
      const objectCheck = rulesCovered(sourcesFromRules(ceilingRules), input.authority.rules);
      if (!objectCheck.covered) {
        throw err(403, 'CEILING_EXCEEDED', `requested object authority exceeds the warrant ceiling (§6.2): ${JSON.stringify(objectCheck.failing)}`);
      }
      const scopeCheck = scopesWithin(parseJsonColumn<string[]>(warrant.ceiling_scopes), input.authority.scopes);
      if (!scopeCheck.within) {
        throw err(403, 'CEILING_EXCEEDED', `requested scopes exceed the warrant scope ceiling: ${scopeCheck.exceeding.join(', ')}`);
      }

      // The full shared validation (§8.1): requester live, task mintable,
      // writer slot, mint-time ⊆ against the requester's CURRENT authority.
      await agentMintService.assertRequesterLive(input.actingPrincipalId, null);
      await agentMintService.assertTaskMintable(client, input.targetTaskId);
      await agentMintService.assertWriterSlotFree(client, input.targetTaskId, input.authority.scopes);
      agentMintService.assertScopesWithinEffective(input.actingCredentialScopes, input.authority.scopes);
      await agentMintService.assertObjectAuthorityCovers(input.actingPrincipalId, input.authority.rules);

      const pack = await agentMintService.executeMint(client, {
        targetTaskId: input.targetTaskId,
        authority: input.authority,
        // AZ-RT5: the parent is ALWAYS the acting credential's principal,
        // never the warrant holder.
        parentPrincipalId: input.actingPrincipalId,
        mintedUnderWarrantId: String(warrant.id),
        transport: warrant.transport_pin,
        maxAgeHours: warrant.agent_max_age_hours ? Number(warrant.agent_max_age_hours) : undefined,
        label: input.label ?? null,
      }, actor);
      await client.query('UPDATE warrants SET minted_total = minted_total + 1, updated_at = NOW() WHERE id = $1', [warrant.id]);
      await writeWarrantEvent(client, {
        warrantId: String(warrant.id), action: 'warrant.minted', actor,
        metadata: { mintedPrincipalId: pack.principalId, targetTaskId: input.targetTaskId },
      });
      await client.query('COMMIT');
      return pack;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      // §5.2 rule 8 / T17: every warrant-mint REFUSAL is a durable denied
      // audit with the reason and the acting chain — written on the pool
      // so the rollback cannot erase it (over-cap refusals above all:
      // "loud audited refusal").
      const refusal = (e instanceof WarrantError || (e instanceof Error && e.name === 'AgentMintError'))
        ? (e as { code?: string }).code ?? 'UNKNOWN' : null;
      if (refusal) {
        await auditService.record({
          action: 'agent.mint', actor, outcome: 'denied',
          resourceType: 'warrant', resourceId: warrantId,
          metadata: {
            refusal,
            targetTaskId: input.targetTaskId,
            requestedScopes: input.authority.scopes,
            chain: await auditChainFor(pool, input.actingPrincipalId),
          },
        }).catch(() => undefined);
      }
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * The lifecycle sweep (§6.2/§6.4): persists expiry flips — explicit
   * dates past due, and single/multi-anchor scope completion (ALL anchors
   * terminal shortens/expires; a task anchor is terminal at
   * completed/archived, a phase/project anchor only counts once it holds
   * at least one task and every task is terminal). Also re-proves the
   * creator live-cap on active warrants, auto-suspending failures loudly.
   * Mint enforcement is LIVE either way — the sweep persists state and
   * emits events (§7.3 doctrine).
   */
  async sweepLifecycles(actor: AuditActor = { handle: 'system', authMethod: 'system' }): Promise<{ expired: number; suspended: number }> {
    let expired = 0;
    let suspended = 0;
    const active = await pool.query(`SELECT id FROM warrants WHERE status IN ('active', 'suspended')`);
    for (const row of active.rows) {
      const warrantId = String(row.id);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query('SELECT * FROM warrants WHERE id = $1 FOR UPDATE', [warrantId]);
        const warrant = locked.rows[0];
        if (!warrant || !['active', 'suspended'].includes(String(warrant.status))) {
          await client.query('ROLLBACK');
          continue;
        }
        const datePast = warrant.expires_at && new Date(warrant.expires_at).getTime() <= Date.now();
        let anchorsTerminal = false;
        if (!datePast) {
          // RH-P3.AZ-S7 (ruling 7440b579 R5): the PHASE branch consulted
          // only the tasks under the phase and never `phases.status`, so a
          // COMPLETED phase holding zero tasks read NON-terminal
          // (NOT EXISTS(tasks) opened the anchor) and its warrant never
          // expired — the opposite of R5's "active while the phase OR any
          // of its tasks is non-terminal". A phase anchor is now open iff a
          // phase row exists in a non-terminal status OR a non-terminal
          // task hangs off it; a dangling anchor (phase deleted) is
          // terminal, the fail-safe direction. The PROJECT branch is
          // deliberately unchanged — R5 speaks only to phases and
          // `projects` carries no equivalent ratified status enum.
          const openAnchor = await client.query(
            `SELECT 1 FROM warrant_anchors wa
              WHERE wa.warrant_id = $1 AND (
                (wa.anchor_type = 'task' AND EXISTS (
                   SELECT 1 FROM tasks t WHERE t.id = wa.anchor_id AND t.status NOT IN ('completed', 'archived')))
                OR (wa.anchor_type = 'phase' AND (
                   EXISTS (SELECT 1 FROM phases ph WHERE ph.id = wa.anchor_id AND ph.status NOT IN ('completed', 'archived'))
                   OR EXISTS (SELECT 1 FROM tasks t WHERE t.phase_id = wa.anchor_id AND t.status NOT IN ('completed', 'archived'))))
                OR (wa.anchor_type = 'project' AND (
                   NOT EXISTS (SELECT 1 FROM tasks t WHERE t.project_id = wa.anchor_id)
                   OR EXISTS (SELECT 1 FROM tasks t WHERE t.project_id = wa.anchor_id AND t.status NOT IN ('completed', 'archived'))))
              ) LIMIT 1`,
            [warrantId],
          );
          anchorsTerminal = openAnchor.rows.length === 0;
        }

        // R4 idle grace: all-anchors-terminal no longer expires on sight.
        // The sweep stamps when it FIRST saw the scope complete and expires
        // only once the window has elapsed; an anchor that reopens inside
        // the window clears the stamp, which is what a grace window means
        // and leaves §6.2's one-way expiry untouched (nothing expired yet).
        let graceElapsed = false;
        if (anchorsTerminal) {
          const stampedAt = warrant.anchors_terminal_since
            ? new Date(warrant.anchors_terminal_since).getTime()
            : null;
          if (stampedAt === null) {
            await client.query(
              'UPDATE warrants SET anchors_terminal_since = NOW(), updated_at = NOW() WHERE id = $1',
              [warrantId],
            );
          } else {
            graceElapsed = Date.now() - stampedAt >= warrantIdleGraceMs();
          }
        } else if (warrant.anchors_terminal_since) {
          await client.query(
            'UPDATE warrants SET anchors_terminal_since = NULL, updated_at = NOW() WHERE id = $1',
            [warrantId],
          );
        }

        if (datePast || (anchorsTerminal && graceElapsed)) {
          await client.query(
            `UPDATE warrants SET status = 'expired', expired_at = NOW(), suspended_reason = NULL, suspended_at = NULL, updated_at = NOW() WHERE id = $1`,
            [warrantId],
          );
          // R2(a)/R4: warrant death releases every vehicle it carried and
          // auto-unassigns the not-yet-terminal tasks riding it.
          await accessVehicleService.releaseWarrant(client, warrantId, actor,
            datePast
              ? 'AZ-S7: the carrying warrant reached its expiry date'
              : 'AZ-S7: the carrying warrant expired on scope completion after the idle grace (ruling 7440b579 R4)');
          await writeWarrantEvent(client, {
            warrantId, action: 'warrant.expired', actor,
            metadata: {
              reason: datePast
                ? 'expiry date reached'
                : 'all anchors terminal plus the idle grace (§6.2 scope completion, ruling 7440b579 R4)',
            },
          });
          await auditService.record({
            action: 'warrant.expire', actor, resourceType: 'warrant', resourceId: warrantId,
            metadata: { reason: datePast ? 'date' : 'anchors-terminal' },
          }, client);
          expired += 1;
        } else if (warrant.status === 'active') {
          const creatorProblem = await this.creatorCapProblem(client, warrant);
          if (creatorProblem) {
            await this.autoSuspend(client, warrantId, creatorProblem, actor);
            suspended += 1;
          }
        }
        await client.query('COMMIT');
      } catch {
        await client.query('ROLLBACK').catch(() => undefined);
      } finally {
        client.release();
      }
    }
    return { expired, suspended };
  }
}

export const warrantService = new WarrantService();
