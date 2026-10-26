import type { ProfileRule } from '../access/accessShared';
import { authenticatedFetch } from '../../utils/auth';
import { createPolledResource, ReadFailure } from '../../utils/polledResource';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

/**
 * The approval read model (`GET /approvals`, `GET /approvals/:id`; backend
 * `ApprovalService.mapApproval`), and the approvals hub's view of it
 * (`GET /approvals?view=hub`; backend `ApprovalHubService`, card b1e3b16d):
 * the same items, plus the skill versions waiting for review and the native
 * verification requests waiting on a verifier (read-only), each with what
 * it is about (`refs`), whose it is (`ownership`), who decides it (`deciders`)
 * and whether THIS session may (`decidable`). The page renders those fields;
 * it never works out authority for itself.
 */
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'collected' | 'lapsed';

/**
 * One requested row as the decider reads it (AZ-A9 clause 7; backend
 * `ApprovalService.describeAccessRequests`): the exact objects with their
 * titles (null when the viewer does not decide, or the id names no row), or,
 * for an all-of-type row, the sentence the decider is shown.
 */
export interface AccessRequestRuleView {
  resourceType: string;
  selectorForm: string;
  verbs: string[];
  objects: Array<{ id: string; title: string | null }>;
  allOfType: string | null;
}

/**
 * The request fields a grant or credential request carries (AZ-A9 clauses 3
 * and 13; card 785e1eed). Absent on agent-mint items.
 */
export interface AccessRequestFields {
  granteePrincipalId: string;
  granteeHandle: string | null;
  /** UNTRUSTED requester text: render it only inside the untrusted-data fence. */
  reason: string;
  requestedExpiresAt: string;
  approvedExpiresAt: string | null;
  relatedTaskId: string | null;
  relatedTaskTitle: string | null;
  relatedPhaseId: string | null;
  relatedPhaseName: string | null;
  relatedProjectId: string | null;
  relatedProjectTitle: string | null;
  createdGrantIds: string[];
  /** Credential requests (clause 13): the credential collect issued, if any. */
  issuedCredentialId?: string | null;
  /** Credential requests: the transport pin asked for and approved, and the label. */
  requestedTransport?: string | null;
  approvedTransport?: string | null;
  credentialLabel?: string | null;
  ruleViews?: AccessRequestRuleView[];
  approvedRuleViews?: AccessRequestRuleView[] | null;
}

/**
 * What the decider sees about a CREDENTIAL request (AZ-A9 clauses 7 and 13;
 * backend `ApprovalService.credentialDecisionBlock`), served on
 * `GET /approvals/:id` to root or an administrator session only. Never a
 * secret: labels, key ids, scopes and pins.
 */
export interface CredentialDecision {
  target: { principalId: string; handle: string; kind: string; status: string } | null;
  liveCredentials: Array<{
    id: string; label: string | null; keyId: string | null; scopes: string[];
    transport: string | null; expiresAt: string | null; requesting: boolean;
  }>;
  requestedScopes: Array<{ scope: string; heldByRequestingCredential: boolean; heldByAnyLiveCredential: boolean }>;
  newScopes: string[];
  requestedTransport: string | null;
  approvedTransport: string | null;
  label: string | null;
  effectiveAfterIssue: string[];
  inertScopes: string[];
  deciderCap: { standing: string; delegable: string[]; within: string[]; exceeding: string[] };
  collectExpiresAt: string | null;
  issuedCredentialId: string | null;
  previousCredentialStays: boolean;
}

/**
 * What THIS session may decide (`viewer` on `GET /approvals` and
 * `GET /approvals/:id`; P1-B review nice-to-have 4). Root or an administrator
 * decides every kind; any other session only its own subtree's agent-mint
 * items. Absent on an older server: the controls are then shown, and the
 * server still refuses a decision it does not admit.
 */
export interface ApprovalsViewer {
  isRoot: boolean;
  isAdministrator: boolean;
}

/** A reference the hub resolved: the id always, the title only where this session may read it. */
export interface HubRef { id: string; title: string | null }

export type OwnershipClass = 'group' | 'shared' | 'private' | 'board';

/** AZ-A12 clause 12: why a project is `group` — its owner column ("Owned by") or a live Group grant ("Shared with"). */
export type GroupBasis = 'owner' | 'grant';

/** E45: whose the item is, derived by the server at read time. */
export interface HubOwnership {
  class: OwnershipClass;
  /** The project's Groups (empty when not disclosed): the owning Group first, then the live Group grants,
   * creation-default first. `basis` is absent on an older server. */
  groups: Array<{ id: string; name: string; basis?: GroupBasis }>;
  /** For `group`: the class's basis; absent on an older server. */
  basis?: GroupBasis | null;
  /** The project owner's kind; absent on an older server. */
  ownerKind?: 'human' | 'group' | null;
  ownerHandle: string | null;
  ownerIsViewer: boolean;
}

/**
 * A change request's record (kind `change`; the universal change request,
 * card 502fb19e; backend `ChangeRequestService.mapChangeFields`). The page
 * renders it by its target type and never works authority out: the server
 * says who decides it and whether this session may.
 */
export interface ChangeRequestFields {
  targetType: string;
  targetId: string | null;
  targetObjects: Array<{ type: string; id: string | null }> | null;
  granteeType: 'principal' | 'group' | null;
  granteePrincipalId: string | null;
  granteeHandle: string | null;
  /** UNTRUSTED requester text: render it only inside the untrusted-data fence. */
  reason: string;
  spec: {
    type: string;
    before: Record<string, unknown>;
    requested: Record<string, unknown>;
    approved: Record<string, unknown> | null;
    diff: unknown;
  };
  appliedAt: string | null;
  appliedEffect: Record<string, unknown> | null;
  deciderStanding: string | null;
  relatedTaskId: string | null;
  relatedPhaseId: string | null;
}

/** One edge of a change's relationship diff (design section 6). */
export interface RelationshipEdge {
  principal: { type: string; id: string };
  object: string;
  action: string;
  before: boolean;
  after: boolean;
  via: string;
  state: 'added' | 'removed' | 'kept';
}

/** One changed field: its value before and after. */
export interface FieldChange { field: string; before: unknown; after: unknown }

export interface ApprovalItem {
  id: string;
  /**
   * `agent-mint`, `grant` or `credential` (AZ-A9, card 785e1eed). An item
   * without it is read as `agent-mint`, the only kind older servers hold.
   */
  kind?: string;
  status: ApprovalStatus;
  requesterPrincipalId: string;
  requesterHandle: string | null;
  /** The mint target; null on a grant or credential request. */
  targetTaskId: string | null;
  targetTaskTitle: string | null;
  /** Present on grant and credential requests only. */
  accessRequest?: AccessRequestFields;
  /** AZ-A13 clause 6h: the amended object and its field-by-field diff. */
  authorityEdit?: {
    objectType: 'credential' | 'warrant' | 'grant';
    objectKindLabel: string;
    objectId: string;
    diff: Array<{ field: string; before: unknown; after: unknown }>;
    lifetime: { choice: 'keep' | 'until-task'; label: string; taskId: string | null; revertAt: string | null; revertedAt: string | null; due: boolean } | null;
  };
  requestedScopes: string[];
  requestedRules: ProfileRule[];
  approvedScopes: string[] | null;
  approvedRules?: ProfileRule[] | null;
  lapseReason: string | null;
  denialReason: string | null;
  requestedAt: string;
  /** Null for a skill version in review: it waits until someone decides it. */
  pendingExpiresAt: string | null;
  collectExpiresAt: string | null;
  decidedAt?: string | null;
  /** Hub view only (`?view=hub`). */
  refs?: { task: HubRef | null; phase: HubRef | null; project: HubRef | null };
  ownership?: HubOwnership;
  deciders?: { rule: string; stepUp: boolean };
  /** Whether THIS session may decide it — the decide route's own rule, computed by the server. */
  decidable?: boolean;
  decideVia?: Record<string, string | null>;
  /** Kind `change` only: the typed target and its before/requested/approved change. */
  change?: ChangeRequestFields;
  /** Hub view: the relationship diff; null on the requester's own item. */
  relationships?: { edges: RelationshipEdge[]; summary: string } | null;
  /** Hub view, kind `change`: the field diff, on every view of it. */
  fieldDiff?: FieldChange[];
  /** Hub view, kind `change`: whose view this is. */
  view?: 'requester' | 'decider';
  /** Hub view, kind `change`: why THIS session does not decide an item it sees. */
  decisionRefusal?: { code: string; message: string } | null;
  /** The skill-review adapter's items (kind `skill-publish`). */
  skill?: { id: string; name: string; version: number; description: string; provenance: string };
  /**
   * A native verification request waiting on its verifier (kind
   * `native-review`): listed read-only, never decidable, decided by nobody on
   * the hub — the task's assigned verifier records the verdict on the task.
   */
  verification?: {
    state: 'pending' | 'leased' | 'attested';
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

/** One row of the approval's own ledger (`approval_events`). */
export interface ApprovalEvent {
  id: string | number;
  occurredAt: string;
  action: string;
  actorPrincipalId: string | null;
  actorHandle: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * The list ceiling the server applies (`ApprovalService.list`, `LIMIT 500`).
 * A list this long may have been cut, so a count of it is a floor, not a total.
 */
export const APPROVAL_LIST_CEILING = 500;

export function approvalKind(approval: Pick<ApprovalItem, 'kind'>): string {
  return typeof approval.kind === 'string' && approval.kind ? approval.kind : 'agent-mint';
}

const KIND_LABELS: Record<string, string> = {
  'agent-mint': 'Agent mint',
  grant: 'Grant request',
  credential: 'Credential request',
  'authority-edit': 'Authority edit',
  change: 'Change request',
  'skill-publish': 'Skill publish',
  'native-review': 'Verification request',
};

/** The kinds the hub can be filtered to (`?kind=`), in the order the page offers them. */
export const HUB_KINDS = ['agent-mint', 'grant', 'credential', 'authority-edit', 'change', 'skill-publish', 'native-review'] as const;

/** A skill version waiting for review (the hub's read adapter, E44 Q2), never an Approval row. */
export function isSkillPublish(approval: Pick<ApprovalItem, 'kind'>): boolean {
  return approvalKind(approval) === 'skill-publish';
}

/**
 * The items waiting on THIS session: pending, and decidable by it. An item a
 * server has not marked is counted (older servers list only what the session
 * decides), and one marked not decidable is someone else's decision — it is
 * listed on the hub as waiting on others, never counted as "needs you".
 */
export function waitingOnYou<T extends Pick<ApprovalItem, 'status' | 'decidable'>>(approvals: T[]): T[] {
  return approvals.filter((approval) => approval.status === 'pending' && approval.decidable !== false);
}

/** A native verification request waiting on its verifier: listed, never decided on the hub. */
export function isVerification(approval: Pick<ApprovalItem, 'kind'>): boolean {
  return approvalKind(approval) === 'native-review';
}

/**
 * The pending items waiting on a VERIFIER: verification requests. They are
 * nobody's decision on the hub, so they are counted apart from "waiting on
 * you" and "waiting on someone else".
 */
export function waitingOnVerifier<T extends Pick<ApprovalItem, 'kind' | 'status'>>(approvals: T[]): T[] {
  return approvals.filter((approval) => approval.status === 'pending' && isVerification(approval));
}

/** A grant or credential request (AZ-A9) — never decided or labelled as a mint. */
export function isAccessRequest(approval: Pick<ApprovalItem, 'kind' | 'accessRequest'>): boolean {
  return ['grant', 'credential'].includes(approvalKind(approval)) && Boolean(approval.accessRequest);
}

/** A change request (kind `change`): rendered by its target type, decided where the server says. */
export function isChangeRequest(approval: Pick<ApprovalItem, 'kind' | 'change'>): boolean {
  return approvalKind(approval) === 'change' && Boolean(approval.change);
}

export function isAuthorityEdit(approval: Pick<ApprovalItem, 'kind'>): boolean {
  return approvalKind(approval) === 'authority-edit';
}

/** A credential request (AZ-A9 clause 13): one new credential for its requester. */
export function isCredentialRequest(approval: Pick<ApprovalItem, 'kind' | 'accessRequest'>): boolean {
  return approvalKind(approval) === 'credential' && Boolean(approval.accessRequest);
}

/** Whether this session may decide `approval`, as far as the page knows. An
 * unknown viewer (an older server) reads as "may": the server decides. */
export function viewerMayDecide(viewer: ApprovalsViewer | null, approval: Pick<ApprovalItem, 'kind' | 'accessRequest'>): boolean {
  if (!viewer) return true;
  if (viewer.isRoot || viewer.isAdministrator) return true;
  return !isAccessRequest(approval) && approvalKind(approval) !== 'authority-edit';
}

/** A kind the page has not learned reads as itself, never as another kind. */
export function approvalKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/** "3", or "500+" when the server's ceiling may have cut the list. */
export function countLabel(count: number): string {
  return count >= APPROVAL_LIST_CEILING ? `${APPROVAL_LIST_CEILING}+` : String(count);
}

/**
 * The pending items this session can see, through the hub view (the
 * self-scoped approvals plus the skill versions it may publish), shared by the
 * sidebar bell, the dashboard notice and the hub so all three say the same
 * number at the same moment: `waitingOnYou` of this list. A refusal (403), a
 * failure (500) or a body without the list is an ERROR state; it is never read
 * as an empty queue.
 */
export const pendingApprovals = createPolledResource<ApprovalItem[]>(async (signal) => {
  const response = await authenticatedFetch(`${API_BASE}/approvals?view=hub&status=pending`, { signal });
  if (!response.ok) throw new ReadFailure(response.status);
  const data = await response.json().catch(() => null);
  if (!data || !Array.isArray(data.approvals)) throw new ReadFailure(response.status);
  return (data.approvals as ApprovalItem[]).filter((approval) => approval.status === 'pending');
});
