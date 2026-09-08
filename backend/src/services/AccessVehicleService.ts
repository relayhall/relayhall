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
import type { PoolClient } from 'pg';
import { pool } from '../db/connection';
import { auditService, type AuditActor } from './AuditService';
import { feedEventService, type FeedObjectType } from './FeedEventService';
import { delegationService, type DelegationChain } from './DelegationService';
import { accessProfileService, type ProfileRule } from './AccessProfileService';
import { authorizationRepository } from './AuthorizationRepository';
import { grantAllows, type AuthorizationActor } from './AuthorizationService';
import type { GrantResourceType, GrantVerb } from './GrantService';
import { rulesCovered, sourcesFromEffectiveAccess } from '../utils/authorityContainment';

const ADMINISTRATOR_ROLES = new Set(['admin', 'orchestrator']);

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

export class AssignmentAccessError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
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
}

export interface VehicleTarget {
  targetKind: 'grant' | 'profile_assignment';
  targetId: string;
  createdByVehicle: boolean;
  resourceType?: GrantResourceType;
  resourceId?: string | null;
}

export interface VehicleAttachResult {
  vehicleKind: 'warrant' | 'auto-grant';
  warrantId: string | null;
  landedOnPrincipalId: string;
  assigneePrincipalId: string;
  targets: VehicleTarget[];
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
      vehicleKind: 'warrant' | 'auto-grant';
      warrantId: string | null;
      actor: AuditActor;
    },
  ): Promise<VehicleTarget> {
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
      createdByVehicle = false;
    } else {
      const inserted = await client.query(
        `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id, provenance)
         VALUES ('principal', $1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          input.granteeId, input.resourceType, input.resourceId, input.verb,
          input.actor.principalId ?? null,
          input.vehicleKind === 'warrant' ? 'assignment:warrant' : 'assignment:grant',
        ],
      );
      grantId = String(inserted.rows[0].id);
      createdByVehicle = true;
      await auditService.record({
        action: 'grant.create', actor: input.actor, resourceType: 'grant', resourceId: grantId,
        metadata: {
          automatic: true, granteeId: input.granteeId, resourceType: input.resourceType,
          resourceId: input.resourceId, verb: input.verb, taskId: input.taskId,
          carriedBy: input.vehicleKind === 'warrant' ? 'warrant' : 'grant', warrantId: input.warrantId,
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
          target_kind, target_id, created_by_vehicle, created_by_principal_id)
       VALUES ($1, $2, $3, $4, $5, 'grant', $6, $7, $8)
       ON CONFLICT (task_id, target_kind, target_id) DO NOTHING`,
      [
        input.taskId, input.assigneePrincipalId, input.granteeId, input.vehicleKind,
        input.warrantId, grantId, effectiveFlag, input.actor.principalId ?? null,
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
    const existing = await client.query(
      `SELECT id FROM access_profile_assignments
        WHERE profile_id = $1 AND assignee_type = 'principal' AND assignee_id = $2`,
      [input.profileId, input.granteeId],
    );

    let assignmentId: string;
    let createdByVehicle: boolean;
    if (existing.rows.length > 0) {
      assignmentId = String(existing.rows[0].id);
      createdByVehicle = false;
    } else {
      const inserted = await client.query(
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
       ON CONFLICT (task_id, target_kind, target_id) DO NOTHING`,
      [
        input.taskId, input.assigneePrincipalId, input.granteeId, input.warrantId,
        assignmentId, effectiveFlag, input.actor.principalId ?? null,
      ],
    );

    return { targetKind: 'profile_assignment', targetId: assignmentId, createdByVehicle: effectiveFlag };
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

  // ── R2(b): the auto-grant fallback ──────────────────────────────────

  private async attachAutoGrants(
    client: VehicleClient,
    input: { taskId: string; assigneePrincipalId: string; landedOn: string; actor: AuditActor; assigner: AuthorizationActor },
  ): Promise<VehicleTarget[]> {
    const references = await this.permittedReferences(client, input.taskId, input.assigner);
    const targets: VehicleTarget[] = [];
    for (const reference of references) {
      targets.push(await this.ensureGrant(client, {
        taskId: input.taskId, assigneePrincipalId: input.assigneePrincipalId,
        granteeId: input.landedOn, resourceType: reference.resourceType,
        resourceId: reference.resourceId, verb: VEHICLE_VERB,
        vehicleKind: 'auto-grant', warrantId: null, actor: input.actor,
      }));
    }
    return targets;
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
  ): Promise<Array<{ resourceType: GrantResourceType; resourceId: string }>> {
    const references = await this.referenceSet(client, taskId);
    const permitted: Array<{ resourceType: GrantResourceType; resourceId: string }> = [];
    for (const reference of references) {
      if (reference.resourceType === 'task' && reference.resourceId === taskId) {
        permitted.push(reference);
        continue;
      }
      if (!(await this.assignerCovers(client, actor, reference.resourceType, reference.resourceId))) continue;
      permitted.push(reference);
    }
    return permitted;
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
    const landedOn = resolved.root.principalId;
    const warrantId = input.warrantId ?? null;

    // R3 requires an identified assigner for anything but a system act.
    if (!input.assigner.authenticated) {
      throw err(403, 'ASSIGNER_UNKNOWN',
        'an execution assignment requires an identified assigner so the R3 non-escalation cap can be applied');
    }

    let targets: VehicleTarget[] = [];
    let vehicleKind: 'warrant' | 'auto-grant' = warrantId ? 'warrant' : 'auto-grant';

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
      targets = await this.attachAutoGrants(client, {
        taskId: input.taskId, assigneePrincipalId, landedOn,
        actor: input.actor, assigner: input.assigner,
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
        carriedBy: vehicleKind === 'warrant' ? 'warrant' : 'grant',
        warrantId, targetCount: targets.length,
      },
    }, client as PoolClient);

    return { vehicleKind, warrantId, landedOnPrincipalId: landedOn, assigneePrincipalId, targets };
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
      if (remaining.rows.length > 0) continue;
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
    const existing = await client.query(
      `SELECT assignee_principal_id, landed_on_principal_id
         FROM access_vehicle_links
        WHERE task_id = $1 AND vehicle_kind = 'auto-grant' LIMIT 1`,
      [taskId],
    );
    if (existing.rows.length === 0) return;
    const assigneePrincipalId = String(existing.rows[0].assignee_principal_id);
    const landedOn = String(existing.rows[0].landed_on_principal_id);

    const desired = await this.permittedReferences(client, taskId, linker);

    const current = await client.query(
      `SELECT l.target_kind, l.target_id, l.created_by_vehicle, l.landed_on_principal_id,
              g.resource_type, g.resource_id
         FROM access_vehicle_links l
         JOIN grants g ON g.id = l.target_id
        WHERE l.task_id = $1 AND l.vehicle_kind = 'auto-grant' AND l.target_kind = 'grant'`,
      [taskId],
    );
    // The REMOVAL arm works off the raw reference set, not the capped one:
    // a linker who cannot read an object must not be able to REVOKE the
    // assignee's access to it either, and "not permitted to confer" is not
    // "no longer referenced" (review bedc25f3 B2).
    const stillReferenced = new Set(
      (await this.referenceSet(client, taskId)).map((r) => `${r.resourceType}:${r.resourceId}`),
    );
    const currentKeys = new Set<string>();
    for (const row of current.rows) {
      const key = `${row.resource_type}:${row.resource_id}`;
      currentKeys.add(key);
      if (stillReferenced.has(key)) continue;
      // No longer referenced: drop the link, then the target at refcount
      // zero — and only when this machinery created it.
      await client.query(
        `DELETE FROM access_vehicle_links WHERE task_id = $1 AND target_kind = 'grant' AND target_id = $2`,
        [taskId, row.target_id],
      );
      if (!row.created_by_vehicle) continue;
      const remaining = await client.query(
        `SELECT 1 FROM access_vehicle_links WHERE target_kind = 'grant' AND target_id = $1 LIMIT 1`,
        [row.target_id],
      );
      if (remaining.rows.length > 0) continue;
      await this.dropTarget(client, row as any, actor, 'AZ-S7 recompute: the task no longer references this object');
    }

    for (const reference of desired) {
      if (currentKeys.has(`${reference.resourceType}:${reference.resourceId}`)) continue;
      await this.ensureGrant(client, {
        taskId, assigneePrincipalId, granteeId: landedOn,
        resourceType: reference.resourceType, resourceId: reference.resourceId,
        verb: VEHICLE_VERB, vehicleKind: 'auto-grant', warrantId: null, actor,
      });
    }
  }

  // ── R4: warrant lifecycle coupling ──────────────────────────────────

  /** The dependent not-yet-terminal tasks a revoke or suspend would
   * auto-unassign (R4's mandatory warning list). */
  async dependentOpenTasks(warrantId: string): Promise<Array<{ id: string; title: string; status: string }>> {
    const result = await pool.query(
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
    for (const row of carried.rows) {
      const taskId = String(row.task_id);
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
    const stragglers = await client.query(
      `UPDATE tasks SET execution_service_id = NULL, execution_profile = NULL,
              execution_descriptor_version = NULL, execution_warrant_id = NULL
        WHERE execution_warrant_id = $1 AND status NOT IN ('completed', 'archived')
        RETURNING id`,
      [warrantId],
    );
    for (const row of stragglers.rows) {
      const taskId = String(row.id);
      if (unassigned.includes(taskId)) continue;
      await auditService.record({
        action: 'task.execution_unassign', actor, resourceType: 'task', resourceId: taskId,
        metadata: { automatic: true, reason, warrantId },
      }, client as PoolClient);
      unassigned.push(taskId);
    }
    await client.query(
      `UPDATE tasks SET execution_warrant_id = NULL WHERE execution_warrant_id = $1`,
      [warrantId],
    );

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
      carriedBy: row.vehicle_kind === 'warrant' ? 'warrant' : 'grant',
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
