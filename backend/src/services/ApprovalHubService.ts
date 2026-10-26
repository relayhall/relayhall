/**
 * ApprovalHubService — the approvals hub's read (card b1e3b16d; the brief's
 * "L4": design draft section C.2 and E, tiles T9-T10; owner rulings E15, E16,
 * E44 Q2/Q3 and E45).
 *
 * ONE PAGE, EVERY PENDING RATIFICATION KIND THE BOARD HOLDS. The hub lists:
 *   - every Approval the session may see (`ApprovalService.list`, the same
 *     self-scope `GET /approvals` has always applied): agent-mint, grant and,
 *     when that slice lands, credential requests;
 *   - skill versions waiting for review, through a READ ADAPTER over the
 *     existing review queue (E44 Q2: no second pending state). They are listed
 *     only to a session that may publish them — a human holding skills:admin,
 *     with write on the Skill, who did not write the version — which is the
 *     rule `SkillManager.transition` enforces at publish;
 *   - native verification requests WAITING ON A VERIFIER (kind
 *     `native-review`), READ-ONLY: a request still pending, leased or attested
 *     (the states `NativeReviewService.publicRequest` reports as active), on a
 *     task this session may read — the point gate of
 *     `GET /tasks/:id/native-reviews`. The task's assigned verifier records the
 *     verdict on the task's own routes; nobody decides it here, so it is never
 *     `decidable`, its `decideVia` names no route, and it is never counted as a
 *     decision waiting on anyone.
 * Charter revisions and phase goals have NO pending state on the board today
 * (`CharterService.approve` writes directly), so nothing is listed for them.
 *
 * EACH ITEM ADDS, read-only:
 *   - refs: the task, phase and project it is about. Ids always; a title only
 *     when this session may read the object, or — for a grant or credential
 *     request — when this session decides it (AZ-A9 clause 7 shows the
 *     decider the objects it is deciding about);
 *   - ownership (E45, ratified at hub Q3; ordered by AZ-A12 clause 12 and
 *     D-16, card a9b1e69c): `group` is decided FIRST by the owner column — a
 *     project whose owner is a Group principal lists under that Group, marked
 *     "Owned by" (`basis: 'owner'`); a live Group grant is the FALLBACK for a
 *     project with a person owner or none, marked "Shared with"
 *     (`basis: 'grant'`; several Groups list under the first, creation-default
 *     first, then by name); `shared` when the project is shared or public with
 *     neither, `private` otherwise, `board` when there is no project. The
 *     owner's kind travels as `ownerKind`;
 *   - deciders and decidable: WHO decides, as a sentence, and whether THIS
 *     session may. Both come from `approvalDeciderStanding` below, which is the
 *     very function `POST /approvals/:id/approve|deny` decides with — the hub
 *     cannot say "you may decide" where the route would refuse, or the reverse;
 *   - decideVia: the EXISTING routes that decide it. No route is added here.
 *
 * NOTHING HERE WRITES, and the default `GET /approvals` response is untouched:
 * this read answers only `?view=hub`.
 */
import { pool } from '../db/connection';
import type { AuthorizationActor } from './AuthorizationService';
import { authorizationRepository } from './AuthorizationRepository';
import {
  approvalService, APPROVAL_KINDS, type ApprovalKind, type ApprovalRecord,
} from './ApprovalService';
import { scopesSatisfy } from '../utils/scopeMap';
import { changeDecidersRule, changeTargetNeedsRootSession } from '../utils/changeTargets';
import {
  changeDiff, changeReach, changeRecordForRequester, changeRequestService, isRequesterSide, projectedRelationships,
  type ChangeDeciderArm, type CredentialReach, type RelationshipEdge,
} from './ChangeRequestService';
import { ownerKindOf, type OwnerKind } from '../utils/ownerFacts';

export const SKILL_PUBLISH_KIND = 'skill-publish' as const;
/** A native verification request waiting on its verifier: listed, never decided here. */
export const NATIVE_REVIEW_KIND = 'native-review' as const;
export const HUB_KINDS: readonly string[] = [...APPROVAL_KINDS, SKILL_PUBLISH_KIND, NATIVE_REVIEW_KIND];
export type HubKind = ApprovalKind | typeof SKILL_PUBLISH_KIND | typeof NATIVE_REVIEW_KIND;
export type OwnershipClass = 'group' | 'shared' | 'private' | 'board';
export type HubStatusFilter = 'pending' | 'decided' | 'all';
export const HUB_STATUS_FILTERS: readonly HubStatusFilter[] = ['pending', 'decided', 'all'];
export const HUB_GROUP_CLASSES: readonly string[] = ['shared', 'private', 'board'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * WHO MAY DECIDE AN APPROVAL OF THIS KIND — the single copy of the rule.
 *
 * `POST /approvals/:id/approve|deny` (routes/approvals.ts `decide`) calls this
 * for its decider check, and the hub calls it for `decidable`. For a session
 * that can see the item at all (the self-scope / 404-concealment arm runs
 * first, in both places):
 *   - root decides every kind;
 *   - an agent-mint item is decided by the Account whose subtree holds the
 *     requester (section 6.1) — seeing it is standing enough — and, by AZ-A9
 *     clause 6 (E43 Q1), by an administrator login session, whose view of
 *     every kind is what admits it here;
 *   - every other legacy kind (grant, credential, authority-edit) needs an
 *     administrator login session (AZ-A9 clause 6); anyone else is refused;
 *   - a change item is decided by the ordered predicate of the change-request
 *     design (section 5.1, `ChangeRequestService.changeDeciderArm`); this
 *     function only says which targets a root login session alone decides.
 */
export type ApprovalDeciderStanding = 'root' | 'administrator' | 'owning-account';
export function approvalDeciderStanding(
  viewer: { isRoot: boolean; administratorOk: boolean },
  kind: string,
  // E325 section 5.1 (kind change): the target type, for the targets a root
  // login session alone decides.
  targetType: string | null = null,
): ApprovalDeciderStanding | null {
  if (viewer.isRoot) return 'root';
  if (kind === 'agent-mint') return 'owning-account';
  if (kind === 'change' && changeTargetNeedsRootSession(targetType)) return null;
  return viewer.administratorOk ? 'administrator' : null;
}

/** The deciders, as the page says them. A kind the hub has not learned gets the
 * administrator sentence, because that is the arm `approvalDeciderStanding`
 * applies to it. */
export function decidersRule(kind: string, targetType: string | null = null): string {
  if (kind === 'agent-mint') {
    // E325 section 5.6 (R7-31): the administrator arm (AZ-A9 clause 6, E43 Q1) is named too.
    return 'Root, an administrator signed in to the dashboard, or the Account that owns the requesting connector, with step-up.';
  }
  // E325 section 5.6: a change item's deciders follow its target type.
  if (kind === 'change') return changeDecidersRule(targetType);
  if (kind === SKILL_PUBLISH_KIND) {
    return 'A person holding skills:admin who did not write this version. Publishing takes no step-up.';
  }
  if (kind === NATIVE_REVIEW_KIND) {
    return 'The task\'s assigned verifier records the verdict on the task. Nothing is decided on this page.';
  }
  return 'Root, or an administrator signed in to the dashboard, with step-up.';
}

/** The verifier sentence for one request, naming the verifier where the hub knows it. */
export function verifierRule(verifierHandle: string | null, serviceName: string | null): string {
  const who = verifierHandle ?? 'The task\'s assigned verifier';
  const via = serviceName ? ` through ${serviceName}` : '';
  return `${who}${via} records the verdict on the task. Nothing is decided on this page.`;
}

export interface HubViewer {
  principalId: string;
  isRoot: boolean;
  administratorOk: boolean;
  /** The principal kind: only a human publishes a Skill version. */
  principalKind: string | null;
  scopes: string[] | null;
  actor: AuthorizationActor;
  /** The server-derived authentication kind, for the targets a stored session decides (E325 section 5.1 (1)). */
  authMethod?: string | null;
}

export interface HubRef { id: string; title: string | null }
/** AZ-A12 clause 12: why a project is `group` — its owner column ("Owned by") or a live Group grant ("Shared with"). */
export type GroupBasis = 'owner' | 'grant';
export interface HubGroup { id: string; name: string; basis: GroupBasis }
export interface HubOwnership {
  class: OwnershipClass;
  /** The project's Groups (empty when not disclosed): the owning Group first, then the live Group grants,
   * creation-default first, then by name. */
  groups: HubGroup[];
  /** For `group`: the basis of the class (the first Group's basis); null for every other class. */
  basis: GroupBasis | null;
  /** The project owner's kind (`human` or `group`); null without a project or an owner. */
  ownerKind: OwnerKind | null;
  /** For `private`: the owner's handle, when this session may see it. */
  ownerHandle: string | null;
  /** For `private`: the owner is this session's principal. */
  ownerIsViewer: boolean;
}

export interface HubFields {
  refs: { task: HubRef | null; phase: HubRef | null; project: HubRef | null };
  ownership: HubOwnership;
  deciders: { rule: string; stepUp: boolean };
  decidable: boolean;
  decideVia: Record<string, string | null>;
}

/**
 * E325 section 6 (and F9 for the legacy kinds, read through the projection of
 * section 2.2): the relationship edges the decision would add, remove or keep,
 * and the one-line summary. For a change item also why THIS session does not
 * decide it, when it sees it but may not (section 5.6: "with the reason
 * shown"), and the requester's chain-root Account (never the chain beyond it).
 */
export interface HubApprovalExtras {
  /** Null on the requester's own item (section 6 "Where shown": the field diff only). */
  relationships: { edges: RelationshipEdge[]; summary: string } | null;
  /** A change item's field diff, on every view of it. */
  fieldDiff?: Array<{ field: string; before: unknown; after: unknown }>;
  /** Whose view of the item this is: its requester's, or a decider's. */
  view?: 'requester' | 'decider';
  decisionRefusal?: { code: string; message: string } | null;
  requesterAccountId?: string | null;
}

export type HubApprovalItem = ApprovalRecord & HubFields & HubApprovalExtras;

export interface HubSkillItem extends HubFields {
  id: string;
  kind: typeof SKILL_PUBLISH_KIND;
  status: 'pending';
  requesterPrincipalId: string | null;
  requesterHandle: string | null;
  requestedAt: string;
  pendingExpiresAt: null;
  collectExpiresAt: null;
  targetTaskId: null;
  targetTaskTitle: null;
  requestedScopes: string[];
  requestedRules: unknown[];
  approvedScopes: null;
  lapseReason: null;
  denialReason: null;
  skill: { id: string; name: string; version: number; description: string; provenance: string };
}

/** The states a native verification request waits in (migration 135). */
export type VerificationState = 'pending' | 'leased' | 'attested';

export interface HubVerificationItem extends HubFields {
  /** The native review request's id (`task_native_reviews.id`), not an Approval id. */
  id: string;
  kind: typeof NATIVE_REVIEW_KIND;
  status: 'pending';
  requesterPrincipalId: string;
  requesterHandle: string | null;
  requestedAt: string;
  /** When a request nobody has leased lapses; null once the verifier holds a lease. */
  pendingExpiresAt: string | null;
  collectExpiresAt: null;
  targetTaskId: string;
  targetTaskTitle: string | null;
  requestedScopes: string[];
  requestedRules: unknown[];
  approvedScopes: null;
  lapseReason: null;
  denialReason: null;
  verification: {
    state: VerificationState;
    serviceId: string;
    /** Null where this session may not read the Service. */
    serviceName: string | null;
    descriptorVersion: number;
    verifierPrincipalId: string;
    verifierHandle: string | null;
    requestExpiresAt: string;
    leaseExpiresAt: string | null;
  };
}

export type HubItem = HubApprovalItem | HubSkillItem | HubVerificationItem;

export interface HubQuery {
  status: HubStatusFilter;
  kind?: HubKind;
  /** `shared` | `private` | `board` | a Group id. */
  group?: string;
}

interface ProjectFacts {
  id: string; name: string; visibility: string; ownerPrincipalId: string | null; ownerHandle: string | null;
  /** AZ-A12 clause 12 (D-16): the owner's kind, read with the owner. */
  ownerKind: OwnerKind | null;
  /** The owning Group's name, when the owner is a Group. */
  ownerGroupName: string | null;
}

export class ApprovalHubService {
  async list(viewer: HubViewer, query: HubQuery): Promise<HubItem[]> {
    const standing = { principalId: viewer.principalId, isRoot: viewer.isRoot, isAdministrator: viewer.administratorOk };
    const items: HubItem[] = [];

    if (query.kind === undefined || (APPROVAL_KINDS as readonly string[]).includes(query.kind)) {
      const listed = await approvalService.list(
        standing, query.status === 'pending' ? 'pending' : undefined, query.kind as ApprovalKind | undefined,
      );
      const scoped = query.status === 'decided' ? listed.filter((approval) => approval.status !== 'pending') : listed;
      const described = scoped.some((approval) => approval.accessRequest)
        ? await approvalService.describeAccessRequests(scoped, standing)
        : scoped;
      items.push(...await this.decorate(viewer, described));
    }
    if ((query.kind === undefined || query.kind === SKILL_PUBLISH_KIND) && query.status !== 'decided') {
      items.push(...await this.skillReviews(viewer));
    }
    // Only ACTIVE requests are listed, so `decided` lists none of them; a
    // finished request is the task's review history, not a hub item.
    if ((query.kind === undefined || query.kind === NATIVE_REVIEW_KIND) && query.status !== 'decided') {
      items.push(...await this.verificationRequests(viewer));
    }

    const filtered = query.group ? items.filter((item) => matchesGroup(item.ownership, query.group as string)) : items;
    return filtered.sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt));
  }

  /** refs, ownership, deciders and decidable for Approval rows, in a fixed number of queries. */
  private async decorate(viewer: HubViewer, records: ApprovalRecord[]): Promise<HubApprovalItem[]> {
    const taskIds = unique(records.flatMap((record) => [record.targetTaskId, record.accessRequest?.relatedTaskId ?? null]));
    const tasks = taskIds.length > 0
      ? (await pool.query(
        `SELECT id::text AS id, title, project_id::text AS project_id, phase_id::text AS phase_id
           FROM tasks WHERE id = ANY($1::uuid[])`, [taskIds])).rows
      : [];
    const taskById = new Map(tasks.map((row: any) => [row.id, row]));

    const phaseIds = unique([
      ...records.map((record) => record.accessRequest?.relatedPhaseId ?? null),
      ...tasks.map((row: any) => row.phase_id as string | null),
    ]);
    const phases = phaseIds.length > 0
      ? (await pool.query(
        `SELECT id::text AS id, name, project_id::text AS project_id FROM phases WHERE id = ANY($1::uuid[])`, [phaseIds])).rows
      : [];
    const phaseById = new Map(phases.map((row: any) => [row.id, row]));

    const where = (record: ApprovalRecord) => {
      const task = taskById.get((record.targetTaskId ?? record.accessRequest?.relatedTaskId) ?? '') ?? null;
      const phaseId = record.accessRequest?.relatedPhaseId ?? task?.phase_id ?? null;
      const phase = phaseId ? phaseById.get(phaseId) ?? null : null;
      const projectId = task?.project_id ?? phase?.project_id ?? null;
      return { task, taskId: task?.id ?? record.targetTaskId ?? record.accessRequest?.relatedTaskId ?? null, phaseId, phase, projectId };
    };
    const located = records.map((record) => ({ record, at: where(record) }));

    const projectIds = unique(located.map(({ at }) => at.projectId));
    const projects = await this.projectFacts(projectIds);
    const groups = await this.projectGroups(projectIds);

    const [readableTasks, readablePhases, readableProjects] = await Promise.all([
      authorizationRepository.authorizedIds(viewer.actor, 'task', unique(located.map(({ at }) => at.taskId)), 'read'),
      authorizationRepository.authorizedIds(viewer.actor, 'phase', unique(located.map(({ at }) => at.phaseId)), 'read'),
      authorizationRepository.authorizedIds(viewer.actor, 'project', projectIds, 'read'),
    ]);

    // E325 section 5.6: whether this session decides a change item is the decide
    // route's own ordered predicate (`changeDeciderArm`), per item, so the hub
    // cannot say "you may decide" where the route would refuse.
    // It is `decidability`: the session kind, liveness, self-approval (section
    // 5.5) and the standing arm, in the decide's own order.
    const changeArms = new Map<string, ChangeDeciderArm & { cases: string[] }>();
    const reaches = new Map<string, CredentialReach | null>();
    const requesterAccounts = new Map<string, string | null>();
    // section 5.1 (2), Q20 (a): the decide refuses a decider that is not live for EVERY kind, so the hub does too.
    const live = await approvalService.deciderLive(viewer.principalId);
    for (const { record } of located) {
      if (record.kind !== 'change') continue;
      const arm = await changeRequestService.decidability(pool, {
        principalId: viewer.principalId, isRoot: viewer.isRoot, administratorOk: viewer.administratorOk, authMethod: viewer.authMethod ?? null,
      }, record);
      changeArms.set(record.id, arm);
      if (record.change && !isRequesterSide(arm.cases)) {
        const spec = (record.change.spec.approved ?? record.change.spec.requested) as Record<string, unknown>;
        reaches.set(record.id, await changeReach(pool, record.change.targetType, record.change.spec.before, spec, record.change.targetId));
      }
      if (!requesterAccounts.has(record.requesterPrincipalId)) {
        const root = (await pool.query(
          `WITH RECURSIVE up AS (
             SELECT id, parent_principal_id, 0 AS depth FROM principals WHERE id = $1
             UNION ALL
             SELECT p.id, p.parent_principal_id, up.depth + 1 FROM principals p JOIN up ON p.id = up.parent_principal_id WHERE up.depth < 8)
           SELECT id::text AS id FROM up WHERE parent_principal_id IS NULL LIMIT 1`, [record.requesterPrincipalId])).rows[0];
        requesterAccounts.set(record.requesterPrincipalId, root ? String(root.id) : null);
      }
    }

    return located.map(({ record, at }) => {
      const kind = record.kind ?? 'agent-mint';
      const arm = changeArms.get(record.id) ?? null;
      const standing = kind === 'change' ? arm?.standing ?? null
        : approvalDeciderStanding({ isRoot: viewer.isRoot, administratorOk: viewer.administratorOk }, kind, record.change?.targetType ?? null);
      // AZ-A9 clause 7: the decider of a grant or credential request sees the
      // objects it decides about (and E325: the decider of a change request).
      const decidesAccessRequest = (Boolean(record.accessRequest) || kind === 'change') && standing !== null && standing !== 'owning-account';
      const titled = (readable: Set<string>, id: string | null, title: string | null): HubRef | null => (
        id ? { id, title: readable.has(id) || decidesAccessRequest ? title : null } : null
      );
      const project = at.projectId ? projects.get(at.projectId) ?? null : null;
      const refs = {
        task: titled(readableTasks, at.taskId, at.task ? String(at.task.title) : null),
        phase: titled(readablePhases, at.phaseId, at.phase ? String(at.phase.name) : null),
        project: titled(readableProjects, at.projectId, project ? project.name : null),
      };
      const disclose = Boolean(at.projectId && (readableProjects.has(at.projectId) || decidesAccessRequest || viewer.isRoot));
      const ownership = classify(project, groups.get(at.projectId ?? '') ?? [], viewer.principalId, disclose);
      // The record's own title fields follow the same rule, so a concealed
      // title appears nowhere in the hub's answer.
      const record2: ApprovalRecord = {
        ...record,
        targetTaskTitle: record.targetTaskId ? refs.task?.title ?? null : record.targetTaskTitle,
        ...(record.accessRequest ? {
          accessRequest: {
            ...record.accessRequest,
            relatedTaskTitle: record.accessRequest.relatedTaskId ? refs.task?.title ?? null : null,
            relatedPhaseName: record.accessRequest.relatedPhaseId ? refs.phase?.title ?? null : null,
            relatedProjectTitle: record.accessRequest.relatedProjectId ? refs.project?.title ?? null : null,
          },
        } : {}),
      };
      const change = record.change;
      // section 6 "Where shown": the requester's own item carries the field
      // diff only — never the relationship diff, never the decider. A legacy
      // item's projection is a decider's view too.
      const requesterView = kind === 'change' ? isRequesterSide(arm?.cases ?? []) : standing === null;
      const diff = change
        ? (() => {
          const spec = (change.spec.approved ?? change.spec.requested) as Record<string, unknown>;
          return changeDiff(change.targetType, change.spec.before, { ...change.spec.before, ...spec }, spec,
            change.granteePrincipalId ? { type: change.granteeType ?? 'principal', id: change.granteePrincipalId } : null, change.targetId,
            reaches.get(record.id) ?? null);
        })()
        : null;
      const relationships = requesterView ? null
        : diff ? { edges: diff.relationships, summary: diff.summary }
          : (() => { const p = projectedRelationships(record); return { edges: p.relationships, summary: p.summary }; })();
      return {
        ...(kind === 'change' && requesterView ? changeRecordForRequester(record2) : record2),
        refs,
        ownership,
        relationships,
        ...(kind === 'change' ? {
          fieldDiff: diff?.fields ?? [],
          view: requesterView ? 'requester' as const : 'decider' as const,
          decisionRefusal: standing === null && arm?.refusal ? { code: arm.refusal.code, message: arm.refusal.message } : null,
          requesterAccountId: requesterAccounts.get(record.requesterPrincipalId) ?? null,
        } : {}),
        deciders: { rule: decidersRule(kind, record.change?.targetType ?? null), stepUp: true },
        decidable: record.status === 'pending' && standing !== null && live,
        decideVia: {
          approve: `/approvals/${record.id}/approve`,
          deny: `/approvals/${record.id}/deny`,
          stepUpAction: 'approval.decide',
        },
      };
    });
  }

  /**
   * THE SKILL-REVIEW READ ADAPTER (E44 Q2). A version whose newest lifecycle
   * event is `review`, listed only where `POST /skills/:id/versions/:v/publish`
   * would let this session publish it: a human principal, the skills:admin
   * route ceiling, write on the Skill (the point stage), and not the version's
   * creator (SkillManager.transition, INDEPENDENT_REVIEW_REQUIRED).
   */
  private async skillReviews(viewer: HubViewer): Promise<HubSkillItem[]> {
    if (viewer.principalKind !== 'human' || !scopesSatisfy(viewer.scopes, 'skills:admin')) return [];
    const result = await pool.query(
      `SELECT svs.id::text AS id, svs.skill_id::text AS skill_id, svs.version, svs.description, svs.provenance,
              s.name, svs.status_actor_principal_id::text AS requester_id, rp.handle AS requester_handle,
              svs.status_changed_at
         FROM skill_version_state svs
         JOIN skills s ON s.id = svs.skill_id
         LEFT JOIN principals rp ON rp.id = svs.status_actor_principal_id
        WHERE svs.status = 'review'
          AND svs.created_by_principal_id IS DISTINCT FROM $1::uuid
        ORDER BY svs.status_changed_at DESC
        LIMIT 500`,
      [viewer.principalId],
    );
    const writable = await authorizationRepository.authorizedIds(
      viewer.actor, 'skill', unique(result.rows.map((row: any) => String(row.skill_id))), 'write',
    );
    return result.rows
      .filter((row: any) => writable.has(String(row.skill_id)))
      .map((row: any): HubSkillItem => ({
        id: String(row.id),
        kind: SKILL_PUBLISH_KIND,
        status: 'pending',
        requesterPrincipalId: row.requester_id ?? null,
        requesterHandle: row.requester_handle ?? null,
        requestedAt: new Date(row.status_changed_at).toISOString(),
        pendingExpiresAt: null,
        collectExpiresAt: null,
        targetTaskId: null,
        targetTaskTitle: null,
        requestedScopes: [],
        requestedRules: [],
        approvedScopes: null,
        lapseReason: null,
        denialReason: null,
        skill: {
          id: String(row.skill_id), name: String(row.name), version: Number(row.version),
          description: String(row.description ?? ''), provenance: String(row.provenance ?? ''),
        },
        refs: { task: null, phase: null, project: null },
        ownership: classify(null, [], viewer.principalId, false),
        deciders: { rule: decidersRule(SKILL_PUBLISH_KIND), stepUp: false },
        decidable: true,
        decideVia: {
          publish: `/skills/${row.skill_id}/versions/${row.version}/publish`,
          reject: `/skills/${row.skill_id}/versions/${row.version}/reject`,
          stepUpAction: null,
        },
      }));
  }

  /**
   * WAITING ON A VERIFIER (card b1e3b16d, review round 2, blocker B1). A READ
   * of `task_native_reviews` (migration 135): a request still active — pending
   * and not past its request expiry, or leased or attested and not past its
   * lease, which is exactly what `NativeReviewService.publicRequest` reports as
   * pending, leased or attested — listed only on a task this session may read
   * (the point gate `GET /tasks/:id/native-reviews` applies). No new state and
   * no new semantics: the verifier leases, attests and records its verdict on
   * the task's existing routes, so the item is never `decidable` and
   * `decideVia` names no route.
   */
  private async verificationRequests(viewer: HubViewer): Promise<HubVerificationItem[]> {
    const result = await pool.query(
      `SELECT r.id::text AS id, r.task_id::text AS task_id, r.service_id::text AS service_id, s.name AS service_name,
              r.descriptor_version, r.verifier_principal_id::text AS verifier_id, vp.handle AS verifier_handle,
              r.requested_by_principal_id::text AS requester_id, rp.handle AS requester_handle,
              r.state, r.created_at, r.request_expires_at, r.lease_expires_at
         FROM task_native_reviews r
         JOIN services s ON s.id = r.service_id
         LEFT JOIN principals vp ON vp.id = r.verifier_principal_id
         LEFT JOIN principals rp ON rp.id = r.requested_by_principal_id
        WHERE (r.state = 'pending' AND r.request_expires_at > NOW())
           OR (r.state IN ('leased', 'attested') AND r.lease_expires_at > NOW())
        ORDER BY r.created_at DESC
        LIMIT 500`,
    );
    const readableTasks = await authorizationRepository.authorizedIds(
      viewer.actor, 'task', unique(result.rows.map((row: any) => String(row.task_id))), 'read',
    );
    const rows = result.rows.filter((row: any) => readableTasks.has(String(row.task_id)));
    if (rows.length === 0) return [];
    const located = await this.locateTasks(viewer, rows.map((row: any) => String(row.task_id)));
    const readableServices = await authorizationRepository.authorizedIds(
      viewer.actor, 'service', unique(rows.map((row: any) => String(row.service_id))), 'read',
    );
    return rows.map((row: any): HubVerificationItem => {
      const at = located.get(String(row.task_id))!;
      const serviceName = readableServices.has(String(row.service_id)) ? String(row.service_name) : null;
      const state = String(row.state) as VerificationState;
      return {
        id: String(row.id),
        kind: NATIVE_REVIEW_KIND,
        status: 'pending',
        requesterPrincipalId: String(row.requester_id),
        requesterHandle: row.requester_handle ?? null,
        requestedAt: new Date(row.created_at).toISOString(),
        pendingExpiresAt: state === 'pending' ? new Date(row.request_expires_at).toISOString() : null,
        collectExpiresAt: null,
        targetTaskId: String(row.task_id),
        targetTaskTitle: at.refs.task?.title ?? null,
        requestedScopes: [],
        requestedRules: [],
        approvedScopes: null,
        lapseReason: null,
        denialReason: null,
        verification: {
          state,
          serviceId: String(row.service_id),
          serviceName,
          descriptorVersion: Number(row.descriptor_version),
          verifierPrincipalId: String(row.verifier_id),
          verifierHandle: row.verifier_handle ?? null,
          requestExpiresAt: new Date(row.request_expires_at).toISOString(),
          leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : null,
        },
        refs: at.refs,
        ownership: at.ownership,
        deciders: { rule: verifierRule(row.verifier_handle ?? null, serviceName), stepUp: false },
        decidable: false,
        decideVia: {},
      };
    });
  }

  /** refs and ownership for tasks this session may read, in a fixed number of queries. */
  private async locateTasks(viewer: HubViewer, taskIds: string[]): Promise<Map<string, { refs: HubFields['refs']; ownership: HubOwnership }>> {
    const tasks = (await pool.query(
      `SELECT id::text AS id, title, project_id::text AS project_id, phase_id::text AS phase_id
         FROM tasks WHERE id = ANY($1::uuid[])`, [unique(taskIds)])).rows;
    const phaseIds = unique(tasks.map((row: any) => row.phase_id as string | null));
    const phases = phaseIds.length > 0
      ? (await pool.query(`SELECT id::text AS id, name FROM phases WHERE id = ANY($1::uuid[])`, [phaseIds])).rows
      : [];
    const phaseById = new Map(phases.map((row: any) => [row.id, String(row.name)]));
    const projectIds = unique(tasks.map((row: any) => row.project_id as string | null));
    const projects = await this.projectFacts(projectIds);
    const groups = await this.projectGroups(projectIds);
    const [readablePhases, readableProjects] = await Promise.all([
      authorizationRepository.authorizedIds(viewer.actor, 'phase', phaseIds, 'read'),
      authorizationRepository.authorizedIds(viewer.actor, 'project', projectIds, 'read'),
    ]);
    const out = new Map<string, { refs: HubFields['refs']; ownership: HubOwnership }>();
    for (const row of tasks as any[]) {
      const project = row.project_id ? projects.get(row.project_id) ?? null : null;
      out.set(row.id, {
        refs: {
          // Listed only where the task is readable, so its title is shown.
          task: { id: row.id, title: String(row.title) },
          phase: row.phase_id ? { id: row.phase_id, title: readablePhases.has(row.phase_id) ? phaseById.get(row.phase_id) ?? null : null } : null,
          project: row.project_id ? { id: row.project_id, title: readableProjects.has(row.project_id) && project ? project.name : null } : null,
        },
        ownership: classify(project, groups.get(row.project_id ?? '') ?? [], viewer.principalId,
          Boolean(row.project_id && (readableProjects.has(row.project_id) || viewer.isRoot))),
      });
    }
    return out;
  }

  private async projectFacts(projectIds: string[]): Promise<Map<string, ProjectFacts>> {
    if (projectIds.length === 0) return new Map();
    // AZ-A12 clause 12 (D-16): the owner read gains the kind, and the owning
    // Group's name, so the owner column can decide `group` first.
    const result = await pool.query(
      `SELECT p.id::text AS id, p.name, p.visibility, p.owner_principal_id::text AS owner_id, op.handle AS owner_handle,
              op.kind AS owner_kind, og.name AS owner_group_name
         FROM projects p LEFT JOIN principals op ON op.id = p.owner_principal_id
         LEFT JOIN groups og ON og.id = op.id AND op.kind = 'group'
        WHERE p.id = ANY($1::uuid[])`,
      [projectIds],
    );
    return new Map(result.rows.map((row: any) => [row.id, {
      id: row.id, name: String(row.name), visibility: String(row.visibility ?? 'private'),
      ownerPrincipalId: row.owner_id ?? null, ownerHandle: row.owner_handle ?? null,
      ownerKind: row.owner_id ? ownerKindOf(row.owner_kind) : null,
      ownerGroupName: row.owner_group_name ?? null,
    }]));
  }

  /**
   * The live Group grants on each project (E43 bound reading 3, E45): an exact
   * project coordinate, grantee type group, unexpired — the expiry test the
   * live grant evaluator applies (GrantService.activeGrantCondition) and the
   * one AZ-A9 clause 7's decider view uses. A typed-wildcard Group row reaches
   * every project and says nothing about this one, so it is not read.
   */
  private async projectGroups(projectIds: string[]): Promise<Map<string, Array<{ id: string; name: string }>>> {
    const out = new Map<string, Array<{ id: string; name: string }>>();
    if (projectIds.length === 0) return out;
    const result = await pool.query(
      `SELECT gr.resource_id::text AS project_id, g.id::text AS id, g.name,
              bool_or(gr.origin = 'creation-default') AS creation_default
         FROM grants gr JOIN groups g ON g.id = gr.grantee_id
        WHERE gr.grantee_type = 'group' AND gr.resource_type = 'project'
          AND gr.resource_id = ANY($1::uuid[])
          AND (gr.expires_at IS NULL OR gr.expires_at > NOW())
        GROUP BY gr.resource_id, g.id, g.name
        ORDER BY bool_or(gr.origin = 'creation-default') DESC, g.name, g.id`,
      [projectIds],
    );
    for (const row of result.rows) {
      const list = out.get(row.project_id) ?? [];
      list.push({ id: String(row.id), name: String(row.name) });
      out.set(row.project_id, list);
    }
    return out;
  }
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

/**
 * E45: group | shared | private | board, read at request time, in the class
 * order AZ-A12 clause 12 binds (D-16): the OWNER COLUMN decides `group` first
 * (a Group principal owns the project: "Owned by"); a live Group grant is the
 * fallback for a project with a person owner or none ("Shared with"); then
 * shared, private, board, unchanged.
 */
export function classify(
  project: ProjectFacts | null,
  groups: Array<{ id: string; name: string }>,
  viewerPrincipalId: string,
  disclose: boolean,
): HubOwnership {
  if (!project) return { class: 'board', groups: [], basis: null, ownerKind: null, ownerHandle: null, ownerIsViewer: false };
  const ownerKind = project.ownerPrincipalId ? project.ownerKind : null;
  const granted = groups.map((entry): HubGroup => ({ id: entry.id, name: entry.name, basis: 'grant' }));
  if (ownerKind === 'group' && project.ownerPrincipalId) {
    const owner: HubGroup = { id: project.ownerPrincipalId, name: project.ownerGroupName ?? '', basis: 'owner' };
    return {
      class: 'group', basis: 'owner', ownerKind,
      groups: disclose ? [owner, ...granted.filter((entry) => entry.id !== owner.id)] : [],
      ownerHandle: null, ownerIsViewer: false,
    };
  }
  if (granted.length > 0) {
    return { class: 'group', basis: 'grant', ownerKind, groups: disclose ? granted : [], ownerHandle: null, ownerIsViewer: false };
  }
  if (project.visibility === 'shared' || project.visibility === 'public') {
    return { class: 'shared', groups: [], basis: null, ownerKind, ownerHandle: null, ownerIsViewer: false };
  }
  const ownerIsViewer = project.ownerPrincipalId !== null && project.ownerPrincipalId === viewerPrincipalId;
  return {
    class: 'private', groups: [], basis: null, ownerKind,
    ownerHandle: ownerIsViewer || disclose ? project.ownerHandle : null,
    ownerIsViewer,
  };
}

function matchesGroup(ownership: HubOwnership, group: string): boolean {
  if (HUB_GROUP_CLASSES.includes(group)) return ownership.class === group;
  return ownership.groups.some((entry) => entry.id.toLowerCase() === group.toLowerCase());
}

/** `?group=`: a class word or a Group id; anything else is refused by the route. */
export function isHubGroupFilter(value: string): boolean {
  return HUB_GROUP_CLASSES.includes(value) || UUID_PATTERN.test(value);
}

export const approvalHubService = new ApprovalHubService();
