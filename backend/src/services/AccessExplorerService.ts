/**
 * AZ-A12 build 6 (card 1e56dbef; amendment AZ-A12 clause 12 and E45 (3),
 * ratified E72): THE ACCESS EXPLORER READ MODEL.
 *
 * Read-only and derived at read. The first hop is uniform: an object -> its
 * owner (a person or a Group) and the holders of authority on it. Then a Group
 * -> its members, each with a tier (owner, manager or member; source local or
 * directory; inert role rows flagged); an Account -> its Connectors (its
 * children); a Connector -> its own() cap, grants, profiles and warrants.
 *
 * ── ONE EVALUATOR, NEVER A SECOND RULE SET ──
 *
 * Every verdict this model states ("principal P may do A on object O, because
 * of these sources") is computed by `authorizationService.sqlCondition` - the
 * predicate `authorizationRepository.authorizePoint` and every list surface
 * enforce with - over the object's own row, with `includeSources` asking that
 * same invocation which of its arms held. A Group tier is read through the
 * shared fragment `groupOwnerCondition` (clause 6), which composes the live
 * role-row fragment. Nothing here scans `effectiveAccess` (LENSES v7 B-L6).
 *
 * The only thing this model adds is NOMINATION: which principals are worth
 * asking about. A nominee is drawn from every principal-valued coordinate of
 * the evaluator's own resource shape (`authorizationRepository.sqlResource`),
 * from every grant and published profile rule that names the object's type,
 * from the members of every Group those name, and from the Agents bound inside
 * the object. Nomination decides nothing: a nominee the evaluator refuses is
 * listed with no actions, and the drill (accessExplorerLive.test.ts) proves on
 * a generated matrix that every principal the evaluator admits is nominated.
 * Board-wide arms (root, the administrator roles and authenticated-read
 * visibility) are stated as classes, never enumerated.
 *
 * ── WHAT A CALLER SEES (design 4d961e37 §5.3, as AZ-A12 D-7 amends it) ──
 *
 *   - The object hop answers only a caller that may READ the object; any
 *     other caller gets the 404 an absent object gets (docs/authorization.md).
 *   - Ownership, Groups, membership and Group roles are directory data,
 *     readable under `principals:read`: every caller of this family sees them.
 *   - Another principal's authority (its verdict, grants, profiles, own() cap
 *     and warrants) is the what-if disclosure, which stays behind the `root`
 *     sentinel (`GET /access-profiles/what-if`). A non-root caller sees its
 *     OWN verdict (the self preview), and a login session also its own
 *     descendants' (the §9.2 self-service subtree the credential and warrant
 *     reads already use).
 *   - SR-3 (`GET /groups/:id/members/:principalId/access`, LENSES v5 §6.4)
 *     is the steward projection: only the authority reaching one member
 *     THROUGH one Group, for a root login session or a steward whose role row
 *     gives it the Group's edit tier (clause 6: the Group active, the steward
 *     an active member with a live owner or manager row) on a login session;
 *     every other caller gets the empty answer.
 *
 * ── NOTHING A CALLER'S OWN READ SURFACES WOULD NOT SHOW (review r1, A and B) ──
 *
 * Every hop discloses about an object, principal or relation only what the
 * caller's existing read surface for that field discloses, through that
 * surface's own rule, never a copy of it:
 *   - a principal another caller may not see the authority of is projected as
 *     `GET /principals` projects it (`toApiPrincipal`, handed in by the route)
 *     and filtered as that list filters it (`principalService.listPrincipals`:
 *     hidden principals only with manage authority), so a hidden principal is
 *     answered exactly as an absent one;
 *   - a principal's `boundTaskId` names a Task: it is shown only where the
 *     viewer's own point read of that Task admits it (`GET /tasks/:id`);
 *   - its `mintedUnderWarrantId`, and a principal's warrants, are warrant
 *     registry data: shown only to a login session the registry would show
 *     them to (`routes/warrants.ts`, `requireSessionViewer` + the holder-subtree
 *     rule `credentialLifecycleService.holderConcealedFrom`);
 *   - SR-3 lists an owned object only when the viewer's own point read admits
 *     it.
 *
 * Transport pins, credential scope ceilings, task state, step-up and handler
 * conditions still gate every real act; a verdict here is the object
 * predicate, as the authority preview states it.
 */
import { pool } from '../db/connection';
import type { AuthRequest } from '../middleware/auth';
import { actorFromRequest } from '../middleware/sharedAuthorization';
import { isLoginSessionKind } from '../utils/administratorSession';
import {
  ADMINISTRATOR_ROLES, AUTHORIZATION_ACTIONS, authorizationService,
  type AuthorizationAction, type AuthorizationActor, type AuthorizationSqlResource,
} from './AuthorizationService';
import { authorizationRepository } from './AuthorizationRepository';
import { delegationService, boundAgentContextIsLive } from './DelegationService';
import { groupService } from './GroupService';
import { groupStewardService } from './GroupStewardService';
import { credentialLifecycleService } from './CredentialLifecycleService';
import { principalService, type Principal } from './PrincipalService';
import { scopesForRole } from '../utils/identityScopes';
import { resolveActorRole } from '../utils/taskAutomationRole';
import { groupOwnerCondition } from '../utils/groupOwnerCondition';
import { ownerFactsSql } from '../utils/ownerFacts';
import { RequestFaultError } from '../utils/httpErrors';
import type { GrantResourceType } from './GrantService';

/** The object types the Explorer opens: the point types of the evaluator. */
export const EXPLORER_TYPES = ['task', 'phase', 'project', 'report', 'skill', 'personality', 'service'] as const;
export type ExplorerType = typeof EXPLORER_TYPES[number];

/** At most this many nominees are evaluated per object, Group or child list. */
export const EXPLORER_LIST_LIMIT = 200;

/** The refusals of this read model; status, code and message are developer-authored literals. */
export class AccessExplorerError extends RequestFaultError {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The order nominees keep before the list limit truncates them; a shape coordinate (any other label) ranks 0. */
const NOMINATION_RANK: Record<string, number> = { grant: 1, 'bound-task-context': 2, 'group-member': 3, profile: 4 };

/**
 * The resource-shape keys that hold a PRINCIPAL id (a column expression), and
 * the keys that hold arrays of them. Every other key of the evaluator's shape
 * is listed in `SHAPE_NON_PRINCIPAL_KEYS`. accessExplorerCensus.test.ts reads
 * `AuthorizationSqlResource` from AuthorizationService.ts and asserts the
 * three lists cover every key it declares, so a principal coordinate the
 * evaluator gains cannot be left out of nomination silently.
 */
export const SHAPE_PRINCIPAL_KEYS = [
  'owner', 'accountOwner', 'creator', 'spawnedBy', 'claimant', 'shepherd', 'verifier', 'projectOwner',
  'assignedClaimPrincipal',
] as const;
export const SHAPE_PRINCIPAL_LIST_KEYS = ['taskEvidenceReaders'] as const;
export const SHAPE_PRINCIPAL_ARRAY_KEYS = ['taskEvidenceAudience'] as const;
export const SHAPE_NON_PRINCIPAL_KEYS = [
  'type', 'id', 'visibility', 'inheritedVisibility', 'project', 'restrictedAccess', 'inheritanceAnchor',
  'assignedClaimEligible',
  // Owner ruling E462 S4b: `verification_none`, a flag the guard SQL reads by the Task id.
  'verificationNone',
] as const;

/**
 * The evaluator's source bases this model nominates for, and the board-wide
 * ones it states as classes. accessExplorerCensus.test.ts reads every basis
 * literal `sqlCondition` can emit and requires each to be in exactly one list.
 */
export const NOMINATED_BASES = [
  'owner', 'claimant', 'shepherd', 'verifier', 'legacy-verifier', 'initiator', 'task-evidence-reader',
  'bound-task-context', 'grant', 'profile', 'inherited-project-grant', 'group-owner', 'group-project-owner',
  'role-grant', 'assigned-connector-claim', 'delegation-chain', 'account-owner', 'account-group-owner',
  'account-group-project-owner',
  // Owner ruling E462 S4b: a bound `verifier` Agent, nominated as a bound Agent (bound-task-context).
  'verifier-agent',
] as const;
export const BOARD_WIDE_BASES = ['root', 'administrator', 'account-administrator', 'visibility'] as const;

export interface ActionVerdict { action: AuthorizationAction; sources: string[] }

export interface ExplorerViewer {
  /** The enforcing actor, exactly as the shared middleware built it. */
  actor: AuthorizationActor;
  /** The request carries the `root` sentinel scope. */
  root: boolean;
  /** The request is a login session (cookie or dashboard JWT). */
  loginSession: boolean;
  /**
   * The caller holds principal management authority: the guard `GET
   * /principals` asks before it lists hidden principals (`includeHidden`).
   * Set by the route from that same guard; absent means no.
   */
  manage?: boolean;
}

/** The record `GET /principals` gives for a principal (the route hands in its own `toApiPrincipal`). */
export type DirectoryRecord = (principal: Principal) => unknown;

export interface PrincipalSummary {
  principalId: string;
  kind: string;
  handle: string;
  displayName: string | null;
  status: string;
  role: string | null;
  parentPrincipalId: string | null;
  boundTaskId: string | null;
  mintedUnderWarrantId: string | null;
  legacyIdentity: boolean;
}

/** The viewer of one request: the enforcing actor, the root sentinel and the login-session kind. */
export function explorerViewer(req: AuthRequest): ExplorerViewer {
  return {
    actor: actorFromRequest(req),
    root: Boolean(req.scopes?.includes('root')),
    loginSession: isLoginSessionKind(req.authMethod),
  };
}

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

function requireUuid(value: unknown, code: string, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new AccessExplorerError(400, code, `${label} must be a full UUID`);
  }
  return value.toLowerCase();
}

export function explorerType(value: unknown): ExplorerType {
  if (typeof value !== 'string' || !(EXPLORER_TYPES as readonly string[]).includes(value)) {
    throw new AccessExplorerError(400, 'INVALID_EXPLORER_TYPE', `type must be one of: ${EXPLORER_TYPES.join(', ')}`);
  }
  return value as ExplorerType;
}

/** The optional `objectType` + `objectId` query pair of the Group and principal hops. */
export function objectContext(query: Record<string, unknown>): { type: ExplorerType; id: string } | null {
  if (query.objectType === undefined && query.objectId === undefined) return null;
  if (query.objectType === undefined || query.objectId === undefined) {
    throw new AccessExplorerError(400, 'INVALID_EXPLORER_QUERY', 'objectType and objectId are given together or not at all');
  }
  return { type: explorerType(query.objectType), id: requireUuid(query.objectId, 'INVALID_EXPLORER_QUERY', 'objectId') };
}

const SUMMARY_COLUMNS = `p.id::text AS principal_id, p.kind, p.handle, p.display_name, p.status, p.role,
  p.parent_principal_id::text AS parent_principal_id, p.bound_task_id::text AS bound_task_id,
  p.minted_under_warrant_id::text AS minted_under_warrant_id, p.legacy_identity`;

function summaryOf(row: any): PrincipalSummary {
  return {
    principalId: String(row.principal_id),
    kind: String(row.kind),
    handle: String(row.handle),
    displayName: row.display_name ?? null,
    status: String(row.status),
    role: row.role ?? null,
    parentPrincipalId: row.parent_principal_id ?? null,
    boundTaskId: row.bound_task_id ?? null,
    mintedUnderWarrantId: row.minted_under_warrant_id ?? null,
    legacyIdentity: row.legacy_identity === true,
  };
}

export class AccessExplorerService {
  /**
   * The actor the shared middleware would build for `principalId` presenting
   * itself: an Account as its own login session (role and role scopes), a
   * delegated identity as its live chain (root never survives delegation, so
   * no scope reaches the object predicate), a legacy identity on the Account
   * plane. A Group principal never authenticates (clause 3a): null.
   * A structural chain fault throws, and the whole request fails closed.
   */
  async actorFor(principalId: string, queryable: Queryable = pool): Promise<AuthorizationActor | null> {
    const row = (await queryable.query(`SELECT ${SUMMARY_COLUMNS} FROM principals p WHERE p.id = $1`, [principalId])).rows[0];
    if (!row || row.kind === 'group') return null;
    const chain = await delegationService.resolveChain(principalId, queryable);
    const acting = chain.links[0];
    const role = resolveActorRole({ handle: String(row.handle), principalRole: row.role ?? null, sessionRole: null });
    if (!acting.parentPrincipalId || acting.legacyIdentity) {
      return {
        principalId, handle: String(row.handle), role, scopes: scopesForRole(role),
        authenticated: String(row.status) === 'active',
        delegation: null,
      };
    }
    const alive = chain.alive && await boundAgentContextIsLive(acting, queryable);
    return {
      principalId, handle: String(row.handle), role, scopes: [], authenticated: alive,
      delegation: {
        links: chain.links.map((link) => ({
          principalId: link.principalId, kind: link.kind, role: link.role, parentPrincipalId: link.parentPrincipalId,
          boundTaskId: link.boundTaskId, boundTaskRole: link.boundTaskRole, legacyIdentity: link.legacyIdentity,
          ownExpression: link.ownExpression,
        })),
      },
    };
  }

  /**
   * THE VERDICT: for every action, whether the evaluator admits `actor` on the
   * one object, and which of its arms held. One statement; every column is the
   * text `sqlCondition` rendered, aggregated with bool_or over the shape's
   * FROM exactly as `authorizedIds` filters it.
   */
  async verdict(actor: AuthorizationActor, type: ExplorerType, objectId: string, queryable: Queryable = pool)
    : Promise<ActionVerdict[]> {
    const { from, resource } = authorizationRepository.sqlResource(type as GrantResourceType);
    const params: unknown[] = [objectId];
    const columns: string[] = [];
    const plan: Array<{ action: AuthorizationAction; column: string; sources: Array<{ basis: string; column: string }> }> = [];
    for (const action of AUTHORIZATION_ACTIONS) {
      const decision = authorizationService.sqlCondition(actor, action, resource, params.length + 1, { includeSources: true });
      params.push(...decision.params);
      const column = `decision_${columns.length}`;
      columns.push(`bool_or(COALESCE((${decision.sql}), FALSE)) AS ${column}`);
      const sources = decision.sources ?? [];
      const traced = sources.map((source) => {
        const gate = source.gate ? sources.find((entry) => entry.basis === source.gate)?.sql ?? 'FALSE' : 'TRUE';
        const sourceColumn = `source_${columns.length}`;
        columns.push(`bool_or(COALESCE((${source.sql}) AND (${gate}), FALSE)) AS ${sourceColumn}`);
        return { basis: source.basis, column: sourceColumn };
      });
      plan.push({ action, column, sources: traced });
    }
    const client = queryable === pool ? await pool.connect() : null;
    const run: Queryable = client ?? queryable;
    let row: any;
    try {
      if (client) {
        await client.query('BEGIN READ ONLY');
        await client.query("SET LOCAL jit=off; SET LOCAL statement_timeout='5000ms'");
      }
      row = (await run.query(`SELECT ${columns.join(', ')} FROM ${from} WHERE ${resource.id} = $1::uuid`, params)).rows[0] ?? {};
      if (client) await client.query('COMMIT');
    } catch (error) {
      if (client) await client.query('ROLLBACK');
      throw error;
    } finally {
      client?.release();
    }
    return plan.filter((entry) => row[entry.column] === true).map((entry) => ({
      action: entry.action,
      sources: [...new Set(entry.sources.filter((source) => row[source.column] === true).map((source) => source.basis))],
    }));
  }

  /** Whether the object exists for this model (a deleted Report does not). */
  private async exists(type: ExplorerType, objectId: string): Promise<boolean> {
    const { from, resource } = authorizationRepository.sqlResource(type as GrantResourceType);
    const deleted = type === 'report' ? ' AND r.deleted_at IS NULL' : '';
    const result = await pool.query(`SELECT 1 FROM ${from} WHERE ${resource.id} = $1::uuid${deleted} LIMIT 1`, [objectId]);
    return result.rows.length > 0;
  }

  /**
   * The object read gate: the caller's own point decision for `read`. An
   * object the caller cannot read is answered exactly as an absent one.
   */
  async requireReadable(viewer: ExplorerViewer, type: ExplorerType, rawId: unknown): Promise<string> {
    const objectId = requireUuid(rawId, 'INVALID_EXPLORER_OBJECT_ID', 'object id');
    if (!(await this.exists(type, objectId))) throw new AccessExplorerError(404, 'RESOURCE_NOT_FOUND', 'Resource not found');
    const point = await authorizationRepository.authorizePoint(viewer.actor, type as GrantResourceType, objectId, 'read');
    if (!point.allowed) throw new AccessExplorerError(404, 'RESOURCE_NOT_FOUND', 'Resource not found');
    return objectId;
  }

  /** Every principal-valued coordinate of the evaluator's own shape, read off the object's row. */
  private async shapeNominees(type: ExplorerType, objectId: string): Promise<Map<string, Set<string>>> {
    const { from, resource } = authorizationRepository.sqlResource(type as GrantResourceType);
    const shape = resource as AuthorizationSqlResource & Record<string, unknown>;
    // One column per coordinate, read row by row (the shape's FROM may carry a
    // LEFT JOIN LATERAL); an array coordinate is cast to text[] and flattened here.
    const selects: string[] = [];
    const labels: Array<{ label: string; array: boolean }> = [];
    for (const key of SHAPE_PRINCIPAL_KEYS) {
      const column = shape[key];
      // A Task's `owner` coordinate is its claimant column, nominated as `claimant`.
      if (typeof column !== 'string' || (type === 'task' && key === 'owner')) continue;
      labels.push({ label: key, array: false });
      selects.push(`(${column})::text AS c${selects.length}`);
    }
    for (const key of SHAPE_PRINCIPAL_LIST_KEYS) {
      const columnList = shape[key];
      if (!Array.isArray(columnList)) continue;
      for (const column of columnList) {
        labels.push({ label: 'task-evidence-reader', array: false });
        selects.push(`(${column})::text AS c${selects.length}`);
      }
    }
    for (const key of SHAPE_PRINCIPAL_ARRAY_KEYS) {
      const column = shape[key];
      if (typeof column !== 'string') continue;
      labels.push({ label: 'task-evidence-reader', array: true });
      selects.push(`(${column})::text[] AS c${selects.length}`);
    }
    const found = new Map<string, Set<string>>();
    if (selects.length === 0) return found;
    const rows = (await pool.query(`SELECT ${selects.join(', ')} FROM ${from} WHERE ${resource.id} = $1::uuid`, [objectId])).rows;
    for (const row of rows) {
      labels.forEach(({ label, array }, index) => {
        const raw = row[`c${index}`];
        const values = (array ? (Array.isArray(raw) ? raw : []) : [raw]) as Array<string | null>;
        for (const value of values) {
          if (!value) continue;
          found.set(value, new Set([...(found.get(value) ?? []), label]));
        }
      });
    }
    return found;
  }

  /** Grant rows that name the object: exact, the typed wildcard, and (Task) its Project's exact rows. */
  private async objectGrants(type: ExplorerType, objectId: string): Promise<any[]> {
    const projectOfTask = type === 'task'
      ? `OR (g.resource_type = 'project' AND g.resource_id = (SELECT t.project_id FROM tasks t WHERE t.id = $2::uuid))`
      : '';
    const result = await pool.query(
      `SELECT g.id::text AS id, g.grantee_type, g.grantee_id::text AS grantee_id, g.resource_type,
              g.resource_id::text AS resource_id, g.verb, g.expires_at, g.origin,
              (g.expires_at IS NULL OR g.expires_at > NOW()) AS live,
              CASE WHEN g.resource_type <> $1 THEN 'project'
                   WHEN g.resource_id IS NULL THEN 'wildcard' ELSE 'exact' END AS selector,
              COALESCE(gr.name, gp.display_name, gp.handle) AS grantee_name
         FROM grants g
         LEFT JOIN groups gr ON gr.id = g.grantee_id AND g.grantee_type = 'group'
         LEFT JOIN principals gp ON gp.id = g.grantee_id AND g.grantee_type = 'principal'
        WHERE (g.resource_type = $1 AND (g.resource_id = $2::uuid OR g.resource_id IS NULL)) ${projectOfTask}
        ORDER BY g.created_at ASC, g.id ASC`,
      [type, objectId],
    );
    return result.rows;
  }

  /**
   * NOMINATION ONLY: the assignees of every published profile rule of the
   * object's type. Whether a rule's selector covers this object is the
   * evaluator's question, answered in each assignee's verdict (source
   * `profile`); the rules themselves are listed on the principal hop.
   */
  private async profileAssignees(type: ExplorerType): Promise<Array<{ assignee_type: string; assignee_id: string; profile_id: string }>> {
    const result = await pool.query(
      `SELECT DISTINCT apa.assignee_type, apa.assignee_id::text AS assignee_id, ap.id::text AS profile_id
         FROM access_profile_assignments apa
         JOIN access_profiles ap ON ap.id = apa.profile_id AND ap.published_version_id IS NOT NULL
         JOIN access_profile_rules apr ON apr.version_id = ap.published_version_id AND apr.resource_type = $1
        ORDER BY 2, 3`,
      [type],
    );
    return result.rows;
  }

  /** Agents whose bound Task lies inside the object (the bound-task context arm). */
  private async boundAgents(type: ExplorerType, objectId: string): Promise<string[]> {
    const where = type === 'task' ? 'ctx.id = $1::uuid'
      : type === 'phase' ? 'ctx.phase_id = $1::uuid'
        : type === 'project' ? 'ctx.project_id = $1::uuid' : null;
    if (!where) return [];
    const result = await pool.query(
      `SELECT agent.id::text AS id FROM principals agent JOIN tasks ctx ON ctx.id = agent.bound_task_id
        WHERE ${where} ORDER BY agent.id`,
      [objectId],
    );
    return result.rows.map((row) => String(row.id));
  }

  /** The Group summary every caller of this family may read (directory data, §5.3). */
  private async groupSummaries(ids: string[]): Promise<Map<string, any>> {
    const out = new Map<string, any>();
    if (ids.length === 0) return out;
    const result = await pool.query(
      `SELECT g.id::text AS id, g.name, g.featured, gp.status AS principal_status,
              (SELECT COUNT(*)::int FROM group_members m WHERE m.group_id = g.id) AS member_count
         FROM groups g JOIN principals gp ON gp.id = g.id
        WHERE g.id = ANY($1::uuid[])`,
      [ids],
    );
    for (const row of result.rows) {
      out.set(String(row.id), {
        groupId: String(row.id), name: row.name, featured: row.featured === true,
        ownershipStatus: row.principal_status === 'active' ? 'enabled' : String(row.principal_status),
        memberCount: Number(row.member_count),
      });
    }
    return out;
  }

  private async membersOf(groupIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (groupIds.length === 0) return out;
    const result = await pool.query(
      `SELECT group_id::text AS group_id, account_principal_id::text AS account_id FROM group_members
        WHERE group_id = ANY($1::uuid[]) ORDER BY account_principal_id`,
      [groupIds],
    );
    for (const row of result.rows) out.set(String(row.group_id), [...(out.get(String(row.group_id)) ?? []), String(row.account_id)]);
    return out;
  }

  private async summaries(ids: string[]): Promise<Map<string, PrincipalSummary>> {
    const out = new Map<string, PrincipalSummary>();
    if (ids.length === 0) return out;
    const result = await pool.query(`SELECT ${SUMMARY_COLUMNS} FROM principals p WHERE p.id = ANY($1::uuid[])`, [ids]);
    for (const row of result.rows) out.set(String(row.principal_id), summaryOf(row));
    return out;
  }

  /**
   * Whether `accountId` holds the Group's EDIT tier now: the clause-6
   * fragment the evaluator's Group-owner arms read (a live owner or manager
   * row, an active member, the Group principal active).
   */
  private async holdsEditTier(groupId: string, accountId: string): Promise<boolean> {
    const result = await pool.query(
      `SELECT ${groupOwnerCondition({ owner: '$1::uuid', account: '$2', tier: 'edit' })} AS edit_tier`,
      [groupId, accountId],
    );
    return result.rows[0]?.edit_tier === true;
  }

  /** A Group that does not exist is refused by name, with this family's own error class. */
  private async requireGroup(groupId: string): Promise<void> {
    const found = await pool.query('SELECT 1 FROM groups WHERE id = $1', [groupId]);
    if (found.rows.length === 0) throw new AccessExplorerError(404, 'GROUP_NOT_FOUND', 'No such group');
  }

  /** Whether the viewer may see `principalId`'s authority: root, itself, or (a login session) its descendant. */
  async mayDisclose(viewer: ExplorerViewer, principalId: string): Promise<boolean> {
    if (viewer.root) return true;
    const self = viewer.actor.principalId;
    if (!self) return false;
    if (self === principalId) return true;
    return viewer.loginSession && credentialLifecycleService.isDescendant(self, principalId);
  }

  /**
   * The rows of `rows` the viewer's own point read admits: the decision `GET
   * /<type>/:id` answers with (a refused read is a 404 there). Root reads
   * every row through the sentinel arm of the same decision.
   */
  async readableBy<T extends { type: string; id: string }>(viewer: ExplorerViewer, rows: readonly T[]): Promise<T[]> {
    const kept: T[] = [];
    for (const row of rows) {
      const point = await authorizationRepository.authorizePoint(viewer.actor, row.type as GrantResourceType, row.id, 'read');
      if (point.allowed) kept.push(row);
    }
    return kept;
  }

  /**
   * Whether the warrant registry would show the viewer a Warrant held by
   * `holderPrincipalId`: only a login session (bearers are refused by
   * `requireSessionViewer`), and only one whose subtree holds the holder, or
   * root (`credentialLifecycleService.holderConcealedFrom`, the rule
   * `routes/warrants.ts` conceals with).
   */
  private async warrantHolderVisible(viewer: ExplorerViewer, holderPrincipalId: string): Promise<boolean> {
    const self = viewer.actor.principalId;
    if (!viewer.loginSession || !self) return false;
    return !(await credentialLifecycleService.holderConcealedFrom({ principalId: self, isRoot: viewer.root }, holderPrincipalId));
  }

  /**
   * A summary as this viewer may see it: `boundTaskId` only where the
   * viewer's point read of that Task admits it, `mintedUnderWarrantId` only
   * where the warrant registry would show the viewer that Warrant. Every
   * other key is the directory data `GET /principals` lists.
   */
  private async disclosedSummaries(viewer: ExplorerViewer, summaries: readonly PrincipalSummary[]): Promise<PrincipalSummary[]> {
    const taskIds = [...new Set(summaries.map((summary) => summary.boundTaskId).filter((id): id is string => Boolean(id)))];
    const readableTasks = new Set((await this.readableBy(viewer, taskIds.map((id) => ({ type: 'task', id })))).map((row) => row.id));
    const warrantIds = [...new Set(summaries.map((summary) => summary.mintedUnderWarrantId).filter((id): id is string => Boolean(id)))];
    const holders = warrantIds.length === 0 ? [] : (await pool.query(
      'SELECT id::text AS id, holder_principal_id::text AS holder FROM warrants WHERE id = ANY($1::uuid[])', [warrantIds])).rows;
    const visibleWarrants = new Set<string>();
    for (const row of holders) {
      if (await this.warrantHolderVisible(viewer, String(row.holder))) visibleWarrants.add(String(row.id));
    }
    return summaries.map((summary) => ({
      ...summary,
      boundTaskId: summary.boundTaskId && readableTasks.has(summary.boundTaskId) ? summary.boundTaskId : null,
      mintedUnderWarrantId: summary.mintedUnderWarrantId && visibleWarrants.has(summary.mintedUnderWarrantId)
        ? summary.mintedUnderWarrantId : null,
    }));
  }

  /**
   * HOP 1: the object -> its owner (person or Group) and the holders of
   * authority on it, each with the evaluator's verdict.
   */
  async object(viewer: ExplorerViewer, rawType: unknown, rawId: unknown) {
    const type = explorerType(rawType);
    const objectId = await this.requireReadable(viewer, type, rawId);
    const { from, resource } = authorizationRepository.sqlResource(type as GrantResourceType);
    const shape = resource as AuthorizationSqlResource & Record<string, unknown>;

    // The owner value the evaluator's owner arm reads: the account owner where
    // the shape declares one (Task, Report), else the owner (Project, Phase,
    // Skill). A Task's projectOwner is the clause 7(b) path.
    const ownerColumn = typeof shape.accountOwner === 'string' ? shape.accountOwner
      : (type !== 'task' && typeof shape.owner === 'string' ? shape.owner : null);
    const projectOwnerColumn = typeof shape.projectOwner === 'string' ? shape.projectOwner : null;
    const ownerFacts = ownerColumn ? ownerFactsSql(`(${ownerColumn})`, 'explorer_owner') : null;
    const projectFacts = projectOwnerColumn ? ownerFactsSql(`(${projectOwnerColumn})`, 'explorer_project_owner') : null;
    const factsRow = (await pool.query(
      `SELECT ${ownerColumn ? `(${ownerColumn})::text AS owner_id, ${ownerFacts!.select}` : 'NULL::text AS owner_id'}
              ${projectOwnerColumn ? `, (${projectOwnerColumn})::text AS project_owner_id,
                 ${projectFacts!.select.replace(/ AS owner_kind/, ' AS project_owner_kind').replace(/ AS owner_display_name/, ' AS project_owner_display_name')}` : ''}
              ${typeof shape.project === 'string' ? `, (${shape.project})::text AS project_id` : ''}
         FROM ${from} ${ownerFacts ? ownerFacts.join : ''} ${projectFacts ? projectFacts.join : ''}
        WHERE ${resource.id} = $1::uuid LIMIT 1`,
      [objectId],
    )).rows[0] ?? {};
    const owner = factsRow.owner_id
      ? { principalId: String(factsRow.owner_id), kind: factsRow.owner_kind ?? null, displayName: factsRow.owner_display_name ?? null }
      : null;
    // The Project owner is shown only to a caller that may read the Project.
    let projectOwner: typeof owner = null;
    if (factsRow.project_owner_id && factsRow.project_id) {
      const projectRead = await authorizationRepository.authorizePoint(viewer.actor, 'project', String(factsRow.project_id), 'read');
      if (projectRead.allowed) {
        projectOwner = {
          principalId: String(factsRow.project_owner_id), kind: factsRow.project_owner_kind ?? null,
          displayName: factsRow.project_owner_display_name ?? null,
        };
      }
    }

    // Board-wide classes, from the evaluator itself: the read decision of an
    // authenticated principal that holds nothing is exactly the visibility arms.
    const holdsNothing: AuthorizationActor = { principalId: null, handle: '', role: 'viewer', scopes: [], authenticated: true };
    const everyoneReads = (await this.verdict(holdsNothing, type, objectId)).some((entry) => entry.action === 'read');
    const boardWide = {
      readableByEveryAuthenticatedPrincipal: everyoneReads,
      administratorRoles: [...ADMINISTRATOR_ROLES].sort(),
      rootSentinel: 'every action',
    };

    // Owner Groups are directory data: every caller sees them.
    const ownerGroups = [owner, projectOwner].filter((entry) => entry?.kind === 'group').map((entry) => entry!.principalId);

    if (!viewer.root) {
      const self = viewer.actor.principalId;
      const groups = await this.groupSummaries([...new Set(ownerGroups)]);
      const selfSummary = self ? (await this.disclosedSummaries(viewer, [...(await this.summaries([self])).values()]))[0] : undefined;
      return {
        object: { type, id: objectId }, projection: 'self' as const, owner, projectOwner, boardWide,
        groups: ownerGroups.map((id) => ({ ...groups.get(id), relation: id === owner?.principalId ? 'owner' : 'project-owner' })),
        holders: self ? [{
          ...selfSummary,
          self: true, via: [], actions: await this.verdict(viewer.actor, type, objectId),
        }] : [],
        holdersTruncated: false, grants: null, evaluatedAt: new Date().toISOString(),
        semantics: SEMANTICS,
      };
    }

    // ── root: every nominee, with the evaluator's verdict ──
    const via = new Map<string, Array<{ source: string; id?: string }>>();
    const nominate = (principalId: string, source: string, id?: string): void => {
      via.set(principalId, [...(via.get(principalId) ?? []), id ? { source, id } : { source }]);
    };
    const groupRelations = new Map<string, Set<string>>();
    const relate = (groupId: string, relation: string): void => {
      groupRelations.set(groupId, new Set([...(groupRelations.get(groupId) ?? []), relation]));
    };
    for (const [principalId, labels] of await this.shapeNominees(type, objectId)) {
      for (const label of labels) nominate(principalId, label);
    }
    const grants = await this.objectGrants(type, objectId);
    for (const grant of grants) {
      if (grant.grantee_type === 'group') relate(grant.grantee_id, 'grantee');
      else nominate(grant.grantee_id, 'grant', grant.id);
    }
    for (const rule of await this.profileAssignees(type)) {
      if (rule.assignee_type === 'group') relate(rule.assignee_id, 'profile-assignee');
      else nominate(rule.assignee_id, 'profile', rule.profile_id);
    }
    for (const agentId of await this.boundAgents(type, objectId)) nominate(agentId, 'bound-task-context');
    // A shape coordinate naming a Group is a Group owner, never a holder itself.
    const kinds = await this.summaries([...via.keys()]);
    for (const [principalId, summary] of kinds) {
      if (summary.kind !== 'group') continue;
      const labels = via.get(principalId) ?? [];
      via.delete(principalId);
      for (const label of labels) relate(principalId, label.source === 'projectOwner' ? 'project-owner' : 'owner');
    }
    const members = await this.membersOf([...groupRelations.keys()]);
    for (const [groupId, accountIds] of members) {
      for (const accountId of accountIds) nominate(accountId, 'group-member', groupId);
    }

    // The direct holders first, so a truncated list keeps them: a shape
    // coordinate (owner, Task roles, evidence readers), then a grant naming
    // the object, a bound Agent, a Group member, and last a profile assignee
    // (nominated for every rule of the type, covering or not). Ties by id.
    const rankOf = (principalId: string): number => Math.min(...(via.get(principalId) ?? []).map((entry) =>
      NOMINATION_RANK[entry.source] ?? 0));
    const ordered = [...via.keys()].sort((a, b) => rankOf(a) - rankOf(b) || (a < b ? -1 : a > b ? 1 : 0));
    const evaluated = ordered.slice(0, EXPLORER_LIST_LIMIT);
    const summaries = new Map((await this.disclosedSummaries(viewer, [...(await this.summaries(evaluated)).values()]))
      .map((summary) => [summary.principalId, summary]));
    const holders = [];
    for (const principalId of evaluated) {
      const summary = summaries.get(principalId);
      if (!summary || summary.kind === 'group') continue;
      const actor = await this.actorFor(principalId);
      holders.push({
        ...summary, self: principalId === viewer.actor.principalId, via: via.get(principalId) ?? [],
        alive: actor?.authenticated === true,
        actions: actor ? await this.verdict(actor, type, objectId) : [],
      });
    }
    const groupSummaries = await this.groupSummaries([...groupRelations.keys()]);
    return {
      object: { type, id: objectId }, projection: 'root' as const, owner, projectOwner, boardWide,
      groups: [...groupRelations.entries()].map(([groupId, relations]) => ({
        ...(groupSummaries.get(groupId) ?? { groupId }), relations: [...relations].sort(),
      })),
      holders,
      holdersTruncated: ordered.length > EXPLORER_LIST_LIMIT,
      grants: grants.map((grant) => ({
        grantId: grant.id, granteeType: grant.grantee_type, granteeId: grant.grantee_id, granteeName: grant.grantee_name ?? null,
        resourceType: grant.resource_type, resourceId: grant.resource_id ?? null, selector: grant.selector, verb: grant.verb,
        expiresAt: grant.expires_at ?? null, live: grant.live === true, origin: grant.origin ?? 'manual',
      })),
      evaluatedAt: new Date().toISOString(),
      semantics: SEMANTICS,
    };
  }

  /**
   * HOP 2: a Group -> its members, each with the tier the clause-6 fragment
   * gives them (edit: a live owner or manager row; use: an active member;
   * none), the member's source, and its role row; inert role rows flagged.
   * With an object context, each member's verdict on that object (root), or
   * the caller's own (anyone else).
   */
  async group(viewer: ExplorerViewer, rawGroupId: unknown, context: { type: ExplorerType; id: string } | null) {
    const groupId = requireUuid(rawGroupId, 'INVALID_GROUP_ID', 'group id');
    await this.requireGroup(groupId);
    const group = await groupService.get(groupId);
    const objectId = context ? await this.requireReadable(viewer, context.type, context.id) : null;
    const members = await groupService.members(groupId);
    const stewards = await groupStewardService.list(groupId);
    const tiers = await pool.query(
      `SELECT m.account_principal_id::text AS account_id,
              ${groupOwnerCondition({ owner: '$1::uuid', account: 'm.account_principal_id', tier: 'edit' })} AS edit_tier,
              ${groupOwnerCondition({ owner: '$1::uuid', account: 'm.account_principal_id', tier: 'use' })} AS use_tier
         FROM group_members m WHERE m.group_id = $1::uuid`,
      [groupId],
    );
    const tierOf = new Map<string, 'edit' | 'use' | 'none'>();
    for (const row of tiers.rows) {
      tierOf.set(String(row.account_id), row.edit_tier === true ? 'edit' : row.use_tier === true ? 'use' : 'none');
    }
    const roleOf = new Map(stewards.map((steward) => [String(steward.accountPrincipalId), steward]));
    const listed = members.slice(0, EXPLORER_LIST_LIMIT);
    // The member rows are `GET /groups/:id/members`' own (handle, kind,
    // status, source); a display name is `GET /principals`' field, so it is
    // read through that list's filter: a hidden principal's name only with
    // manage authority (root holds it).
    const named = new Map((await principalService.listPrincipals(viewer.root || viewer.manage === true, undefined, {
      principalIds: listed.map((member) => String(member.accountPrincipalId)),
    })).map((principal) => [principal.id, principal.displayName]));
    const rows = [];
    for (const member of listed) {
      const id = String(member.accountPrincipalId);
      const steward = roleOf.get(id);
      let actions: ActionVerdict[] | undefined;
      if (context && objectId) {
        if (viewer.root) {
          const actor = await this.actorFor(id);
          actions = actor ? await this.verdict(actor, context.type, objectId) : [];
        } else if (id === viewer.actor.principalId) {
          actions = await this.verdict(viewer.actor, context.type, objectId);
        }
      }
      rows.push({
        principalId: id, handle: member.handle, displayName: named.get(id) ?? null, kind: member.kind,
        status: member.status, source: member.source,
        role: steward?.role ?? 'member', roleLive: steward ? steward.live : null,
        tier: tierOf.get(id) ?? 'none',
        ...(actions !== undefined ? { actions } : {}),
      });
    }
    const memberIds = new Set(members.map((member) => String(member.accountPrincipalId)));
    return {
      group: {
        groupId: group.id, name: group.name, featured: group.featured, memberCount: group.memberCount,
        ownershipStatus: group.ownershipStatus,
      },
      object: context && objectId ? { type: context.type, id: objectId } : null,
      projection: viewer.root ? 'root' as const : 'self' as const,
      members: rows,
      membersTruncated: members.length > EXPLORER_LIST_LIMIT,
      inertRoles: stewards.filter((steward) => !steward.live).map((steward) => ({
        principalId: steward.accountPrincipalId, handle: steward.handle, role: steward.role, inertReason: steward.inertReason,
        member: memberIds.has(String(steward.accountPrincipalId)),
      })),
      evaluatedAt: new Date().toISOString(),
      semantics: SEMANTICS,
    };
  }

  /**
   * HOP 3: a principal -> its children (an Account's Connectors, a
   * Connector's Agents), and, for a viewer that may see its authority, its
   * chain, own() cap, grants, Access profile assignments, Group memberships
   * and warrants. With an object context, its verdict and its children's.
   */
  async principal(
    viewer: ExplorerViewer, rawPrincipalId: unknown, context: { type: ExplorerType; id: string } | null,
    directoryRecord: DirectoryRecord,
  ) {
    const principalId = requireUuid(rawPrincipalId, 'INVALID_PRINCIPAL_ID', 'principal id');
    const found = (await this.summaries([principalId])).get(principalId);
    if (!found) throw new AccessExplorerError(404, 'PRINCIPAL_NOT_FOUND', 'Principal not found');
    if (found.kind === 'group') {
      throw new AccessExplorerError(422, 'GROUP_PRINCIPAL_USE_GROUP_VIEW',
        'A Group principal is explored through GET /access-explorer/groups/{id}');
    }
    const disclose = await this.mayDisclose(viewer, principalId);
    if (!disclose) {
      // THE DIRECTORY PROJECTION is `GET /principals` itself (review r1 LEAK
      // A): the target and its children are read through the list's own
      // filter (`listPrincipals`; a hidden principal only with manage
      // authority) and projected by the list's own record (`toApiPrincipal`,
      // handed in by the route), so no key that list withholds - a bound Task,
      // a minting Warrant, metadata - and no principal it hides reaches a
      // caller here. A hidden target is answered exactly as an absent one.
      const includeHidden = viewer.manage === true;
      const listed = await principalService.listPrincipals(includeHidden, undefined, { principalIds: [principalId] });
      if (listed.length !== 1) throw new AccessExplorerError(404, 'PRINCIPAL_NOT_FOUND', 'Principal not found');
      const objectId = context ? await this.requireReadable(viewer, context.type, context.id) : null;
      const children = await principalService.listPrincipals(includeHidden, undefined, { parentPrincipalId: principalId });
      return {
        principal: directoryRecord(listed[0]), projection: 'directory' as const,
        children: children.slice(0, EXPLORER_LIST_LIMIT).map((child) => directoryRecord(child)),
        childrenTruncated: children.length > EXPLORER_LIST_LIMIT, authority: null,
        object: context && objectId ? { type: context.type, id: objectId } : null,
        evaluatedAt: new Date().toISOString(), semantics: SEMANTICS,
      };
    }
    const [summary] = await this.disclosedSummaries(viewer, [found]);
    const objectId = context ? await this.requireReadable(viewer, context.type, context.id) : null;
    const childRows = await pool.query(
      `SELECT ${SUMMARY_COLUMNS} FROM principals p WHERE p.parent_principal_id = $1
        ORDER BY p.kind, p.handle, p.id LIMIT ${EXPLORER_LIST_LIMIT + 1}`,
      [principalId],
    );
    const children = await this.disclosedSummaries(viewer, childRows.rows.slice(0, EXPLORER_LIST_LIMIT).map(summaryOf));
    const chain = await delegationService.resolveChain(principalId);
    const own = chain.links[0].ownExpression;
    const grants = await pool.query(
      `SELECT g.id::text AS id, g.resource_type, g.resource_id::text AS resource_id, g.verb, g.expires_at, g.origin,
              (g.expires_at IS NULL OR g.expires_at > NOW()) AS live
         FROM grants g WHERE g.grantee_type = 'principal' AND g.grantee_id = $1
        ORDER BY g.resource_type, g.verb, g.id`,
      [principalId],
    );
    const profiles = await pool.query(
      `SELECT apa.id::text AS assignment_id, ap.id::text AS profile_id, ap.name,
              ap.published_version_id::text AS published_version_id
         FROM access_profile_assignments apa JOIN access_profiles ap ON ap.id = apa.profile_id
        WHERE apa.assignee_type = 'principal' AND apa.assignee_id = $1
        ORDER BY ap.name, apa.id`,
      [principalId],
    );
    const groups = await pool.query(
      `SELECT m.group_id::text AS group_id, g.name, m.source
         FROM group_members m JOIN groups g ON g.id = m.group_id
        WHERE m.account_principal_id = $1 ORDER BY g.name, m.group_id`,
      [principalId],
    );
    // A principal's warrants are warrant registry data: only a login session
    // the registry would show them to sees them (bearers get null), and an
    // anchor is the Warrant's own structure (type and id), as the registry's
    // linkage read gives it.
    const warrants = await this.warrantHolderVisible(viewer, principalId) ? await pool.query(
      `SELECT w.id::text AS id, w.name, w.status, w.expires_at,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('type', a.anchor_type, 'id', a.anchor_id) ORDER BY a.anchor_type, a.anchor_id)
                          FROM warrant_anchors a WHERE a.warrant_id = w.id), '[]'::jsonb) AS anchors
         FROM warrants w WHERE w.holder_principal_id = $1
        ORDER BY w.created_at, w.id`,
      [principalId],
    ) : null;
    let actions: ActionVerdict[] | undefined;
    let childActions: Map<string, ActionVerdict[]> | undefined;
    if (context && objectId) {
      const actor = principalId === viewer.actor.principalId ? viewer.actor : await this.actorFor(principalId);
      actions = actor ? await this.verdict(actor, context.type, objectId) : [];
      childActions = new Map();
      for (const child of children) {
        if (child.kind === 'group') continue;
        // A child's verdict is that child's authority: the same disclosure
        // rule as its parent's (a bearer sees its own, never its Agents').
        if (!(await this.mayDisclose(viewer, child.principalId))) continue;
        const childActor = await this.actorFor(child.principalId);
        childActions.set(child.principalId, childActor ? await this.verdict(childActor, context.type, objectId) : []);
      }
    }
    return {
      principal: summary,
      projection: viewer.root ? 'root' as const : 'self' as const,
      children: children.map((child) => ({
        ...child, ...(childActions?.has(child.principalId) ? { actions: childActions.get(child.principalId) } : {}),
      })),
      childrenTruncated: childRows.rows.length > EXPLORER_LIST_LIMIT,
      object: context && objectId ? { type: context.type, id: objectId } : null,
      authority: {
        chain: {
          alive: chain.alive, deadReason: chain.deadReason,
          links: chain.links.map((link) => ({ principalId: link.principalId, kind: link.kind, status: link.status })),
        },
        ownCap: own ? { scopes: own.scopes, objects: own.objects } : null,
        grants: grants.rows.map((row) => ({
          grantId: row.id, resourceType: row.resource_type, resourceId: row.resource_id ?? null, verb: row.verb,
          expiresAt: row.expires_at ?? null, live: row.live === true, origin: row.origin ?? 'manual',
        })),
        profiles: profiles.rows.map((row) => ({
          assignmentId: row.assignment_id, profileId: row.profile_id, profileName: row.name,
          publishedVersionId: row.published_version_id ?? null,
        })),
        groups: groups.rows.map((row) => ({ groupId: row.group_id, name: row.name, source: row.source })),
        warrants: warrants ? warrants.rows.map((row) => ({
          warrantId: row.id, name: row.name, status: row.status, expiresAt: row.expires_at ?? null, anchors: row.anchors ?? [],
        })) : null,
        ...(actions !== undefined ? { actions } : {}),
      },
      evaluatedAt: new Date().toISOString(),
      semantics: SEMANTICS,
    };
  }

  /**
   * SR-3 (LENSES v5 §6.4; built here as LENSES-c delta LC-DD-2 directs): the
   * authority reaching ONE member through ONE Group, and nothing else - not
   * the member's own grants, not its Connectors, not another Group's reach.
   * A root login session, or a steward whose role row gives it the Group's
   * edit tier on a login session, sees it; every other caller gets the empty
   * answer, the SR-2 convention.
   *
   * The steward audience is the owner-tier fragment itself
   * (`groupOwnerCondition`, edit tier): a live owner or manager row of an
   * active member, and the Group principal ACTIVE. The role-row fragment
   * alone ignores the Group's status, so a steward of a disabled Group was
   * shown the objects that Group owns though it could read none of them
   * (review r1 LEAK B); a disabled Group has no steward here. And an owned
   * object is listed to a non-root viewer only when that viewer's own point
   * read admits it (`readableBy`), whatever the audience rule says.
   */
  async memberAccess(
    viewer: ExplorerViewer, rawGroupId: unknown, rawPrincipalId: unknown,
  ) {
    const groupId = requireUuid(rawGroupId, 'INVALID_GROUP_ID', 'group id');
    const principalId = requireUuid(rawPrincipalId, 'INVALID_PRINCIPAL_ID', 'principal id');
    await this.requireGroup(groupId);
    const empty = { groupId, principalId, member: null, grants: [], owned: [], ownedTruncated: false };
    const rootSession = viewer.loginSession && viewer.root;
    const steward = !rootSession && viewer.loginSession && viewer.actor.principalId
      && !viewer.actor.delegation
      && await this.holdsEditTier(groupId, viewer.actor.principalId);
    if (!rootSession && !steward) return empty;
    const membership = (await pool.query(
      `SELECT m.source, p.status, p.handle FROM group_members m JOIN principals p ON p.id = m.account_principal_id
        WHERE m.group_id = $1 AND m.account_principal_id = $2`,
      [groupId, principalId],
    )).rows[0];
    if (!membership) return empty;
    const tier = (await pool.query(
      `SELECT ${groupOwnerCondition({ owner: '$1::uuid', account: '$2', tier: 'edit' })} AS edit_tier,
              ${groupOwnerCondition({ owner: '$1::uuid', account: '$2', tier: 'use' })} AS use_tier`,
      [groupId, principalId],
    )).rows[0] ?? {};
    const active = membership.status === 'active';
    const grants = await pool.query(
      `SELECT g.id::text AS id, g.resource_type, g.resource_id::text AS resource_id, g.verb, g.expires_at, g.origin,
              (g.expires_at IS NULL OR g.expires_at > NOW()) AS live
         FROM grants g WHERE g.grantee_type = 'group' AND g.grantee_id = $1
        ORDER BY g.resource_type, g.verb, g.id`,
      [groupId],
    );
    // Objects whose owner value names this Group, through the evaluator: only
    // the Group-owner arms of the member's verdict count here.
    const owned = await pool.query(
      `(SELECT 'project' AS type, id::text AS id FROM projects WHERE owner_principal_id = $1)
        UNION ALL (SELECT 'task', id::text FROM tasks WHERE account_owner_principal_id = $1)
        UNION ALL (SELECT 'report', id::text FROM reports WHERE account_owner_principal_id = $1 AND deleted_at IS NULL)
        UNION ALL (SELECT 'skill', id::text FROM skills WHERE owner_principal_id = $1)
        ORDER BY 1, 2 LIMIT ${EXPLORER_LIST_LIMIT + 1}`,
      [groupId],
    );
    const actor = await this.actorFor(principalId);
    const through = new Set(['group-owner', 'group-project-owner', 'account-group-owner', 'account-group-project-owner']);
    const ownedRows = [];
    const listedOwned = owned.rows.slice(0, EXPLORER_LIST_LIMIT).map((row) => ({ type: String(row.type), id: String(row.id) }));
    for (const row of rootSession ? listedOwned : await this.readableBy(viewer, listedOwned)) {
      const verdict = actor ? await this.verdict(actor, row.type as ExplorerType, String(row.id)) : [];
      ownedRows.push({
        type: row.type, id: row.id,
        actions: verdict.filter((entry) => entry.sources.some((source) => through.has(source)))
          .map((entry) => ({ action: entry.action, sources: entry.sources.filter((source) => through.has(source)) })),
      });
    }
    return {
      groupId, principalId,
      member: {
        handle: membership.handle, status: membership.status, source: membership.source,
        tier: tier.edit_tier === true ? 'edit' : tier.use_tier === true ? 'use' : 'none',
      },
      grants: grants.rows.map((row) => ({
        grantId: row.id, resourceType: row.resource_type, resourceId: row.resource_id ?? null, verb: row.verb,
        expiresAt: row.expires_at ?? null, live: row.live === true, origin: row.origin ?? 'manual',
        reachesMember: active && row.live === true,
      })),
      owned: ownedRows,
      ownedTruncated: owned.rows.length > EXPLORER_LIST_LIMIT,
    };
  }
}

const SEMANTICS = 'Each action is the object predicate the server enforces with, evaluated now; its sources are the '
  + 'arms of that same predicate that held. Board-wide authority (root, the administrator roles and authenticated-read '
  + 'visibility) is stated as classes, not listed per principal. Transport pins, credential scope ceilings, task state, '
  + 'step-up and handler conditions still gate each real act.';

export const accessExplorerService = new AccessExplorerService();
