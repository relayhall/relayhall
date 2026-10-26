// ApprovalService.ts — Approvals (RH-P3.AZ-S4, card aa48fb12; AUTHZ design
// 4d961e37 §6.1/§6.1a; A17.11; AZ-16/AZ-21/AZ-31c; T7/T8/T21/T27).
//
// LIFECYCLE (A17.11): pending · approved · denied · collected · lapsed. A
// Connector's mint request CREATES an Approval (pending, quota-bound per
// Connector — T21); an approver DECIDES it on the board's authenticated
// human surface after step-up (T7: board-only — no reply-to-approve in any
// channel; the deep link carries no authority, T8), possibly EDITING the
// requested authority DOWN; an approved Approval is a SINGLE-USE
// authorization consumed by COLLECT (by the SAME requesting credential) or
// expiring unused (TTL 24h post-approval, 7d pending).
//
// BINDING (AZ-31c): every Approval binds to the EXACT requesting
// credential id; the credential's revocation, expiry or entry into
// rotation grace INVALIDATES every outstanding pending/approved Approval
// bound to it (status lapsed, audited reason CREDENTIAL_ROTATED) — the
// successor credential must re-request (T27 by construction).
//
// REVALIDATION (§6.1, T27): decision AND collect both re-run the FULL mint
// validation. At collect a TERMINAL failure (task terminal, requester
// terminated, credential dead) LAPSES the Approval with an audited reason;
// a TRANSIENT failure (writer slot held) refuses WITHOUT consuming it.
//
// SESSION MINT (§6.1a): a HUMAN Account acting through its authenticated
// login session mints atomically — requester AND approver, ONE
// step-up-gated transaction recording an Approval row
// created→approved→collected with session + step-up evidence (credential
// id NULL). Base = the Account's own effective authority (§5.2 rule 1);
// the minted Agent's parent = the Account.
//
// GRANT AND CREDENTIAL REQUESTS (AZ-A9, ratified 2026-10-10 (E43); card
// 785e1eed P1-B and P1-B-2; migrations 142 and 145). An Approval has a KIND.
// Every pre-142 row, and every row the paths above write, is `agent-mint`, and
// those paths are unchanged byte for byte (clause 16); E43 Q1 adds an
// administrator login session to their deciders (clause 6), recorded in the
// decision audit. An Agent or Connector FILES a `grant` request for authority
// on its chain-root Account (`requestAccess`, clauses 2-5 and 11); filing
// changes no authority table. Root or an administrator login session DECIDES
// it on /approvals under the same step-up (`decide` dispatches by kind, clause
// 6), possibly narrowing it (clause 8), and approval writes expiring grant rows
// through `GrantService.create` in the decide transaction (clause 12). The
// rows are revoked when the related task reaches a terminal status
// (`utils/accessRequestTerminal.ts`, clause 12a).
//
// A Connector FILES a `credential` request (E8, clause 13) for ONE credential
// on itself carrying scopes it lacks. The same deciders approve it, possibly
// narrowed (fewer scopes, a shorter expiry, a narrower transport pin), and
// approval records the authorization only. COLLECT, by the SAME credential
// that filed it within 24 hours (§6.1's collect contract), re-runs every check
// and issues the credential through `executeConnectorCredentialIssue`, capped
// by the DECIDER's authority, recording it in `issued_credential_id`; clause
// 12a revokes it. The requester's previous credential stays live: the
// ratified text issues one credential and keeps rotation human (clause 15).
//
// EDIT REQUESTS (AZ-A13, ratified 2026-10-11, E95; card 1a38270d; migration
// 148). Kind `authority-edit` is AZ-A9's follow-on kind for editing an existing
// Connector credential, warrant or grant IN PLACE. A Connector FILES one for
// its OWN presenting credential's scopes (`requestAuthorityEdit`, clause 6c);
// root or an administrator DECIDES it here with the same step-up, possibly
// narrowed, choosing its lifetime (clause 6j); the approve applies the edit in
// the decide transaction through `AuthorityEditExecutor` (clause 7), so
// nothing is collected. A person widens on the object's own route (the one-act
// door), which writes an Approval of this kind already approved.
import type { PoolClient } from 'pg';
import { pool } from '../db/connection';
import { stepUpService } from './StepUpService';
import { auditService, type AuditActor } from './AuditService';
import { auditChainFor } from '../utils/auditChain';
import { principalService } from './PrincipalService';
import { authorizationRepository } from './AuthorizationRepository';
import type { AuthorizationActor } from './AuthorizationService';
import {
  accessProfileService, AccessProfileError, validateRules,
  type ProfileRule, type SelectorForm,
} from './AccessProfileService';
import {
  agentMintService, AgentMintError, validateRequestedScopes, normalizeMintRole,
  type MintedAgentPack,
} from './AgentMintService';
import { delegationService, type ChainLink } from './DelegationService';
import { grantService, GrantError, GRANT_RESOURCE_TYPES, type GrantResourceType, type GrantVerb } from './GrantService';
import {
  ruleCovered, rulesCovered, scopesWithin, sourcesFromEffectiveAccess, sourcesFromRules,
} from '../utils/authorityContainment';
import { invalidateApprovalsForCredentials } from '../utils/approvalInvalidation';
import { APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR, ROLE_ACT_ISSUER_ROLES } from '../utils/administratorSession';
import { notificationEndpointService } from './NotificationEndpointService';
import { logCaughtWarning } from '../utils/secretSafeLog';
import { scopesForRole } from '../utils/identityScopes';
import { resolveActorRole } from '../utils/taskAutomationRole';
import {
  assertConnectorCredentialScopes, ConnectorCredentialIssueError, CONNECTOR_CREDENTIAL_TRANSPORTS,
  executeConnectorCredentialIssue, issuingCeiling,
  type ConnectorCredentialTransport, type IssuedConnectorCredential,
} from './ConnectorCredentialIssuance';
import {
  authorityEditExecutor, AuthorityEditError, OBJECT_KIND_LABELS, LIFETIME_LABELS, EDIT_OBJECT_TYPES,
  statesEqual as authorityEditStatesEqual, agentMintOnlyRefusal, type EditObjectType,
} from './AuthorityEditExecutor';
import type {
  ChangeDeciderRequest, ChangeDeciderViewer, ChangeFields, ChangeFilingInput, ChangePreview, ChangePreviewInput, ChangeRequestService,
} from './ChangeRequestService';
import { liveStewardRows } from '../utils/liveStewardCondition';
import { ownerFactsOf, ownerFactsSql } from '../utils/ownerFacts';

/** The change-request service, loaded at call time: it imports this module's
 * ApprovalError, so a load-time import would be a cycle. */
function changeRequests(): ChangeRequestService {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('./ChangeRequestService').changeRequestService;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const APPROVAL_PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days (§6.1)
export const APPROVAL_COLLECT_TTL_MS = 24 * 60 * 60 * 1000;       // 24h post-approval

// T21 (AZ-21a), widened by AZ-A9 clause 11 and the change requests: every
// filed request is quota-bound per requester, every kind together (agent-mint,
// grant, credential, authority-edit and change); an owner-plane one-act edit
// is not a filed request and is not counted (AZ-A13 N14).
export const APPROVAL_QUOTA_PENDING = Number(process.env.RELAYHALL_APPROVAL_QUOTA_PENDING || 5);
export const APPROVAL_QUOTA_DAILY = Number(process.env.RELAYHALL_APPROVAL_QUOTA_DAILY || 20);
// Notification coalescing window per requesting Connector.
const APPROVAL_NOTICE_COALESCE_MS = 15 * 60 * 1000;

// ── AZ-A9 (ratified 2026-10-10, E43): request kinds and their bounds ───────

/** Every Approval kind the CHECK admits. Each follow-on kind (clause 17)
 * widens this list and the CHECK in its own migration: `authority-edit` is
 * AZ-A13's (migration 148), `change` the universal change request's
 * (migration 158, E325; ChangeRequestService). */
export const APPROVAL_KINDS = ['agent-mint', 'grant', 'credential', 'authority-edit', 'change'] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];
/** The kinds an administrator session decides and sees in full (clause 6).
 * E43 Q1 extended the administrator arm to EVERY kind decided on /approvals,
 * agent-mint included (D-01); §6.1's deciders for agent-mint stay beside it. */
export const ADMINISTRATOR_DECIDED_KINDS: readonly ApprovalKind[] = [...APPROVAL_KINDS];

const DAY_MS = 24 * 60 * 60 * 1000;
/** E15: "default 14 days, at most 90". */
export const ACCESS_REQUEST_DEFAULT_EXPIRY_MS = 14 * DAY_MS;
export const ACCESS_REQUEST_MAX_EXPIRY_MS = 90 * DAY_MS;
/** clause 3: the reason is mandatory, 20 to 2,000 characters. */
export const ACCESS_REQUEST_REASON_MIN = 20;
export const ACCESS_REQUEST_REASON_MAX = 2000;
/** clause 3: one rule per type, `exact` or `all-of-type` (the decider sees
 * the latter as "every current and future object of this type"). */
export const ACCESS_REQUEST_SELECTOR_FORMS: readonly SelectorForm[] = ['exact', 'all-of-type'];
/** clause 5: `admin` is never admissible, the grant analogue of §5.2 r2-3. */
export const ACCESS_REQUEST_VERBS: readonly GrantVerb[] = ['read', 'write', 'use', 'invoke'];
/** clause 5: every grant resource type except `surface`, whose AZ-A5 clause
 * 3 closure stays owner-plane. Derived from the ratified list, not a copy. */
export const ACCESS_REQUEST_RESOURCE_TYPES: readonly GrantResourceType[] =
  GRANT_RESOURCE_TYPES.filter((type) => type !== 'surface');

/**
 * clause 11: "Every refusal names the failing rule: body {code, rule,
 * subject: requester|grantee|decider, clause: 'AZ-A9 clause n'}". Carried on
 * an `ApprovalError` raised by the AZ-A9 paths only; the agent-mint paths
 * raise none, so their bodies and audit rows are unchanged.
 */
export interface ApprovalRefusal {
  rule: string;
  subject: 'requester' | 'grantee' | 'decider' | 'editor' | 'target';
  clause: string;
  [detail: string]: unknown;
}

export class ApprovalError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly refusal?: ApprovalRefusal,
  ) {
    super(message);
    this.name = 'ApprovalError';
  }
}

const err = (status: number, code: string, message: string) => new ApprovalError(status, code, message);

/** An AZ-A9 refusal: the code, the sentence, and the rule it names. */
function refuse(
  status: number, code: string, message: string,
  subject: ApprovalRefusal['subject'], clause: number | string, rule: string,
  detail: Record<string, unknown> = {},
): ApprovalError {
  return new ApprovalError(status, code, message, { rule, subject, clause: `AZ-A9 clause ${clause}`, ...detail });
}

/** The credential mechanism's refusal, re-raised in the AZ-A9 shape with the
 * request's kind: the same {code, rule, subject, clause}, so a refusal names
 * the same failing rule whichever path raised it. */
function asApprovalRefusal(e: unknown, kind: string): unknown {
  if (!(e instanceof ConnectorCredentialIssueError)) return e;
  return new ApprovalError(e.status, e.code, e.message,
    { rule: e.rule, subject: e.subject, clause: e.clause, kind, ...e.detail });
}

/** AZ-A13: an executor refusal, re-raised as an ApprovalError with the same
 * {code, rule, subject, clause}, so the approvals surface and its audit name it. */
function editRefusal(
  status: number, code: string, message: string, subject: ApprovalRefusal['subject'], clause: string, rule: string,
  detail: Record<string, unknown> = {},
): ApprovalError {
  return new ApprovalError(status, code, message,
    { rule, subject, clause: `AZ-A13 clause ${clause}`, kind: 'authority-edit', ...detail });
}

function asApprovalEditRefusal(e: unknown): unknown {
  if (!(e instanceof AuthorityEditError)) return e;
  return new ApprovalError(e.status, e.code, e.message, { kind: 'authority-edit', ...e.refusal });
}

/** The clause-6e comparison, for the decider's view. */
function statesEqualForView(type: EditObjectType, a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return EDIT_OBJECT_TYPES.includes(type) ? authorityEditStatesEqual(type, a, b) : false;
}

/** Run `check`, re-raising a credential-mechanism refusal as an ApprovalError. */
function credentialCheck<T>(kind: string, check: () => T): T {
  try {
    return check();
  } catch (e) {
    throw asApprovalRefusal(e, kind);
  }
}

/** The transport pins a credential request may carry (clause 13). */
const TRANSPORTS: readonly string[] = CONNECTOR_CREDENTIAL_TRANSPORTS;
/** clause 13: the issued credential's label, when the request names one. */
export const CREDENTIAL_LABEL_MAX = 100;

/** The fields a grant or credential request carries (clause 3), present on
 * those kinds only: an agent-mint record is unchanged but for `kind`. */
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
  /** clause 7: the project of the related task (else of the related phase). */
  relatedProjectId: string | null;
  relatedProjectTitle: string | null;
  createdGrantIds: string[];
  issuedCredentialId: string | null;
  /** clause 13 (credential kind only; null on a grant request): the transport
   * pin asked for, the pin approved, and the issued credential's label. */
  requestedTransport: string | null;
  approvedTransport: string | null;
  credentialLabel: string | null;
  /** clause 7: each requested row as the decider reads it — the object titles
   * resolved (for a decider only; see `describeAccessRequests`), and an
   * all-of-type row named "every current and future object of this type"
   * (clause 5). Present once a route has described the record. */
  ruleViews?: AccessRequestRuleView[];
  /** The same for the approved rows, once there are any. */
  approvedRuleViews?: AccessRequestRuleView[] | null;
}

/** clause 5: how an all-of-type row is shown to the decider. */
export const ALL_OF_TYPE_LABEL = 'every current and future object of this type';

export interface AccessRequestRuleView {
  resourceType: GrantResourceType;
  selectorForm: SelectorForm;
  verbs: GrantVerb[];
  /** exact rows: each named object, with its title when the viewer decides
   * (null for any other viewer, and for an id that resolves to no row). */
  objects: Array<{ id: string; title: string | null }>;
  /** all-of-type rows: ALL_OF_TYPE_LABEL; null for exact rows. */
  allOfType: string | null;
}

export interface ApprovalRecord {
  id: string;
  kind: ApprovalKind;
  status: 'pending' | 'approved' | 'denied' | 'collected' | 'lapsed';
  requesterPrincipalId: string;
  requesterHandle: string | null;
  requestingCredentialId: string | null;
  sessionEvidence: Record<string, unknown> | null;
  /** The mint target. NULL for a grant or credential request (migration 142). */
  targetTaskId: string | null;
  targetTaskTitle: string | null;
  requestedScopes: string[];
  requestedRole: 'implementer' | 'verifier' | 'shepherd' | null;
  requestedRules: ProfileRule[];
  approvedScopes: string[] | null;
  approvedRules: ProfileRule[] | null;
  decidedByPrincipalId: string | null;
  decidedAt: string | null;
  denialReason: string | null;
  lapseReason: string | null;
  requestedAt: string;
  pendingExpiresAt: string;
  collectExpiresAt: string | null;
  collectedAt: string | null;
  mintedPrincipalId: string | null;
  /** AZ-A9 clause 3: present on kinds `grant`, `credential` and `authority-edit`. */
  accessRequest?: AccessRequestFields;
  /** AZ-A13 clauses 6a, 6h and 6j: present on kind `authority-edit` only. */
  authorityEdit?: AuthorityEditFields;
  /** E325 (migration 158): present on kind `change` only - the typed target and spec. */
  change?: ChangeFields;
}

/**
 * AZ-A13 clause 6h: every authority-edit item names, in words, the kind of
 * object amended and the object, and, once decided, the lifetime chosen; the
 * diff is before -> after, field by field (clause 6g). Never a secret: the
 * states are clause 14's allowlist.
 */
export interface AuthorityEditFields {
  objectType: EditObjectType;
  /** "Connector configuration", "Warrant" or "Grant". */
  objectKindLabel: string;
  objectId: string;
  before: Record<string, unknown>;
  requested: Record<string, unknown>;
  approved: Record<string, unknown> | null;
  /** The fields that move, with each one's value before and after. */
  diff: Array<{ field: string; before: unknown; after: unknown }>;
  /** null until decided. */
  lifetime: {
    choice: 'keep' | 'until-task';
    label: string;
    taskId: string | null;
    revertAt: string | null;
    revertedAt: string | null;
    /** A due revert, shown as due (clause 6j): its date passed, its task is
     * completed or archived, or its task is gone and it names no date. */
    due: boolean;
  } | null;
}

function editDiff(before: Record<string, unknown>, after: Record<string, unknown>): Array<{ field: string; before: unknown; after: unknown }> {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((field) => !['keyId', 'releasedTaskIds', 'resourceType', 'granteeType', 'granteeId', 'ceilingRules'].includes(field));
  return fields
    .filter((field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null))
    .map((field) => ({ field, before: before[field] ?? null, after: after[field] ?? null }));
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T;
}

const iso = (value: unknown): string | null => (value ? new Date(value as string).toISOString() : null);

/** A requested rule in canonical form: ids lower-cased (the `uuid` columns
 * the rows land in compare them that way), keys in one fixed order. */
function canonicalRule(rule: ProfileRule): ProfileRule {
  return {
    resourceType: rule.resourceType, selectorForm: rule.selectorForm,
    selectorIds: rule.selectorIds.map((id) => id.toLowerCase()), verbs: [...rule.verbs],
  };
}

/** The failing rule, named in one fixed key order wherever AZ-A9 refuses. */
function namedRule(rule: ProfileRule): ProfileRule {
  return {
    resourceType: rule.resourceType, selectorForm: rule.selectorForm,
    selectorIds: [...rule.selectorIds], verbs: [...rule.verbs],
  };
}

/** One line naming a covering source, for an ALREADY_HELD sentence. */
function describeSource(source: Record<string, unknown>): string {
  switch (source.kind) {
    case 'grant': return `grant ${source.grantId}`;
    case 'group-grant': return `grant ${source.grantId} of group ${source.groupName ?? source.groupId}`;
    case 'profile': return `access profile '${source.profileName}' v${source.versionNumber}`;
    case 'group-profile': return `access profile '${source.profileName}' v${source.versionNumber} of group ${source.groupName ?? source.groupId}`;
    case 'role': return `the administrator role '${source.role}' (the board-wide superset, §5.1)`;
    default: return "the Account's live authority (an owner or Project arm)";
  }
}

/** A `uuid[]` column, whether the driver parsed it or handed back `{a,b}`. */
function uuidArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
    const body = value.slice(1, -1).trim();
    return body ? body.split(',').map((id) => id.trim()) : [];
  }
  return [];
}

function mapApproval(row: any): ApprovalRecord {
  const kind = (row.kind ?? 'agent-mint') as ApprovalKind;
  const record: ApprovalRecord = {
    id: String(row.id),
    kind,
    status: row.status,
    requesterPrincipalId: String(row.requester_principal_id),
    requesterHandle: row.requester_handle ? String(row.requester_handle) : null,
    requestingCredentialId: row.requesting_credential_id ? String(row.requesting_credential_id) : null,
    sessionEvidence: parseJson<Record<string, unknown> | null>(row.session_evidence, null),
    targetTaskId: row.target_task_id ? String(row.target_task_id) : null,
    targetTaskTitle: row.target_task_title ? String(row.target_task_title) : null,
    requestedScopes: parseJson<string[]>(row.requested_scopes, []),
    requestedRole: row.requested_role ?? null,
    requestedRules: parseJson<ProfileRule[]>(row.requested_rules, []),
    approvedScopes: parseJson<string[] | null>(row.approved_scopes, null),
    approvedRules: parseJson<ProfileRule[] | null>(row.approved_rules, null),
    decidedByPrincipalId: row.decided_by_principal_id ? String(row.decided_by_principal_id) : null,
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
    denialReason: row.denial_reason ?? null,
    lapseReason: row.lapse_reason ?? null,
    requestedAt: new Date(row.requested_at).toISOString(),
    pendingExpiresAt: new Date(row.pending_expires_at).toISOString(),
    collectExpiresAt: row.collect_expires_at ? new Date(row.collect_expires_at).toISOString() : null,
    collectedAt: row.collected_at ? new Date(row.collected_at).toISOString() : null,
    mintedPrincipalId: row.minted_principal_id ? String(row.minted_principal_id) : null,
  };
  if (kind === 'agent-mint') return record;
  if (kind === 'change') {
    // E325: a change request carries its own typed fields, never the legacy
    // accessRequest block (ChangeRequestService owns their shape).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    record.change = require('./ChangeRequestService').mapChangeFields(row);
    return record;
  }
  if (kind === 'authority-edit') {
    const objectType = String(row.edit_object_type) as EditObjectType;
    const before = parseJson<Record<string, unknown>>(row.edit_before, {});
    const requested = parseJson<Record<string, unknown>>(row.edit_requested, {});
    const approved = parseJson<Record<string, unknown> | null>(row.edit_approved, null);
    const lifetimeChoice = row.edit_lifetime ? String(row.edit_lifetime) as 'keep' | 'until-task' : null;
    const revertAt = iso(row.edit_revert_at);
    const revertedAt = iso(row.edit_reverted_at);
    record.authorityEdit = {
      objectType,
      objectKindLabel: OBJECT_KIND_LABELS[objectType] ?? objectType,
      objectId: String(row.edit_object_id),
      before, requested, approved,
      diff: editDiff(before, approved ?? requested),
      lifetime: lifetimeChoice ? {
        choice: lifetimeChoice,
        label: LIFETIME_LABELS[lifetimeChoice],
        taskId: row.related_task_id ? String(row.related_task_id) : null,
        revertAt,
        revertedAt,
        due: lifetimeChoice === 'until-task' && !revertedAt && String(row.status) === 'approved'
          && ((revertAt !== null && new Date(revertAt).getTime() <= Date.now())
            || ['completed', 'archived'].includes(String(row.related_task_status ?? ''))
            || (!row.related_task_id && revertAt === null)),
      } : null,
    };
  }
  record.accessRequest = {
    granteePrincipalId: String(row.grantee_principal_id),
    granteeHandle: row.grantee_handle ? String(row.grantee_handle) : null,
    reason: String(row.reason ?? ''),
    // null on kind authority-edit, which carries no requested expiry (migration 148).
    requestedExpiresAt: iso(row.requested_expires_at) as string,
    approvedExpiresAt: iso(row.approved_expires_at),
    relatedTaskId: row.related_task_id ? String(row.related_task_id) : null,
    relatedTaskTitle: row.related_task_title ? String(row.related_task_title) : null,
    relatedPhaseId: row.related_phase_id ? String(row.related_phase_id) : null,
    relatedPhaseName: row.related_phase_name ? String(row.related_phase_name) : null,
    relatedProjectId: row.related_project_id ? String(row.related_project_id) : null,
    relatedProjectTitle: row.related_project_title ? String(row.related_project_title) : null,
    createdGrantIds: uuidArray(row.created_grant_ids),
    issuedCredentialId: row.issued_credential_id ? String(row.issued_credential_id) : null,
    requestedTransport: row.requested_transport ? String(row.requested_transport) : null,
    approvedTransport: row.approved_transport ? String(row.approved_transport) : null,
    credentialLabel: row.credential_label ? String(row.credential_label) : null,
  };
  return record;
}

const APPROVAL_SELECT = `
  SELECT a.*, rp.handle AS requester_handle, t.title AS target_task_title,
         gp.handle AS grantee_handle, rt.title AS related_task_title, rt.status AS related_task_status,
         rph.name AS related_phase_name,
         rpj.id AS related_project_id, rpj.name AS related_project_title
    FROM approvals a
    JOIN principals rp ON rp.id = a.requester_principal_id
    LEFT JOIN tasks t ON t.id = a.target_task_id
    LEFT JOIN principals gp ON gp.id = a.grantee_principal_id
    LEFT JOIN tasks rt ON rt.id = a.related_task_id
    LEFT JOIN phases rph ON rph.id = a.related_phase_id
    LEFT JOIN projects rpj ON rpj.id = COALESCE(rt.project_id, rph.project_id)`;

/** The object tables a requested `exact` id resolves against, for the
 * decide-time existence check (clause 12: never a grant on no object).
 * `plugin` has no registry table yet; `surface` is never admissible. */
const OBJECT_TABLES: Partial<Record<GrantResourceType, string>> = {
  task: 'tasks', phase: 'phases', project: 'projects', report: 'reports', skill: 'skills',
  personality: 'personalities', service: 'services', blueprint: 'blueprints',
};

/** D-02 (E43 Q1): who decided an agent-mint item, for its decision AUDIT row
 * only — root, the owning Account (§6.1) or an administrator session. Absent
 * when the route did not say, so a direct service caller writes the row it
 * always wrote. The approval_events ledger is unchanged (clause 16). */
function mintStanding(input: Pick<DecideInput, 'mintDeciderStanding'>): Record<string, unknown> {
  return input.mintDeciderStanding ? { deciderStanding: input.mintDeciderStanding } : {};
}

/** The lapse reasons clause 14 names, for a requester that is no longer live
 * at decide (AZ-31c's one token for every credential exit). */
function lapseReasonForRequester(code: string): string {
  return code.startsWith('CREDENTIAL_') ? 'CREDENTIAL_ROTATED' : 'REQUESTER_CHAIN_DEAD';
}

async function writeApprovalEvent(
  queryable: { query: (t: string, p?: unknown[]) => Promise<{ rows: any[] }> },
  input: { approvalId: string; action: string; actor: AuditActor; metadata?: Record<string, unknown> },
): Promise<void> {
  await queryable.query(
    `INSERT INTO approval_events (approval_id, action, actor_principal_id, actor_handle, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [input.approvalId, input.action, input.actor.principalId ?? null, input.actor.handle || 'unknown', JSON.stringify(input.metadata ?? {})],
  );
}

/**
 * THE APPROVALS SELF-SCOPE, as a SQL conjunct over the approvals alias
 * `alias` (§6.1/§9.1; AZ-A9 clause 6). `list()` reads through it, and so does
 * the notification history's approval arm (card b1e3b16d, hub lane L2), so
 * the two can never disagree on which approvals a session may see: root sees
 * every item (null: no conjunct); any other session sees the items whose
 * requester lies in its own subtree, itself included; an administrator
 * session additionally sees every item of the kinds it decides.
 *
 * Parameters are appended to `params`, and numbered after `offset` existing
 * ones, so the conjunct composes into a larger statement.
 */
export function approvalSelfScopeCondition(
  viewer: { principalId: string; isRoot: boolean; isAdministrator?: boolean },
  params: unknown[],
  alias = 'a',
  offset = 0,
): string | null {
  if (viewer.isRoot) return null;
  params.push(viewer.principalId);
  const viewerParam = `$${offset + params.length}`;
  const subtree = `${alias}.requester_principal_id IN (
        WITH RECURSIVE subtree AS (
          SELECT id FROM principals WHERE id = ${viewerParam}
          UNION ALL
          SELECT p.id FROM principals p JOIN subtree s ON p.parent_principal_id = s.id
        ) SELECT id FROM subtree)`;
  if (viewer.isAdministrator) {
    params.push([...ADMINISTRATOR_DECIDED_KINDS]);
    return `(${subtree} OR ${alias}.kind = ANY($${offset + params.length}::text[]))`;
  }
  return `(${subtree} OR ${changeOwnerScopeCondition(alias, viewerParam)})`;
}

/**
 * THE SCOPED-DECIDER ARM (change-request design section 5.6, B1; card
 * 502fb19e S2), by CONTAINMENT so that no object outside the viewer's scope is
 * disclosed: a `change` item is visible iff it has a child row and EVERY child
 * row's stored owner value (`owner_ids`, the value the evaluator's owner arm
 * reads, derived at filing) overlaps the viewer's own id or a Group in which
 * the viewer holds a LIVE owner or manager row (`liveStewardRows`, the
 * fragment the Group edit tier composes). A child row with `owner_ids = '{}'`
 * hides the item from every scoped viewer; the three scope arrays are display
 * coordinates and are not read here. The same text drives `list`, the
 * route's 404-concealment and the notification history's approval arm.
 */
export function changeOwnerScopeCondition(alias: string, viewerParam: string): string {
  const live = liveStewardRows({ group: null, account: `${viewerParam}::uuid`, roles: "ARRAY['owner', 'manager']::text[]" });
  return `(${alias}.kind = 'change'
        AND EXISTS (SELECT 1 FROM approval_change_objects scope_object WHERE scope_object.approval_id = ${alias}.id)
        AND NOT EXISTS (SELECT 1 FROM approval_change_objects scope_object WHERE scope_object.approval_id = ${alias}.id
          AND NOT (scope_object.owner_ids && (ARRAY[${viewerParam}::uuid] || (SELECT coalesce(array_agg(scope_live.group_id), '{}'::uuid[])
            FROM (${live}) scope_live)))))`;
}

/** Deep-link path into the Access manager approval queue (T8: the link
 * carries NO authority — it lands on the login wall, then the board's
 * authenticated human surface where the act still demands step-up). */
export function approvalDeepLinkPath(approvalId: string): string {
  return `/dashboard/settings/access-manager?approval=${approvalId}`;
}

/**
 * The REQUESTER-plane view of a grant or credential request (AZ-A9 clause 9:
 * `GET /delegation/access-requests[/:id]`, the tool's `status`). The
 * requester sees its own item's lifecycle and what was written — never the
 * decider's identity or step-up evidence, exactly as the mint status read
 * (`GET /delegation/agent-mints/:id`) withholds them.
 */
export function accessRequestRequesterView(record: ApprovalRecord): Record<string, unknown> {
  const fields = record.accessRequest;
  const view: Record<string, unknown> = {
    id: record.id,
    kind: record.kind,
    status: record.status,
    granteePrincipalId: fields?.granteePrincipalId ?? null,
    requestedRules: record.requestedRules,
    approvedRules: record.approvedRules,
    requestedExpiresAt: fields?.requestedExpiresAt ?? null,
    approvedExpiresAt: fields?.approvedExpiresAt ?? null,
    // The requester's own text, returned to it as written.
    reason: fields?.reason ?? null,
    relatedTaskId: fields?.relatedTaskId ?? null,
    relatedPhaseId: fields?.relatedPhaseId ?? null,
    createdGrantIds: fields?.createdGrantIds ?? [],
    requestedAt: record.requestedAt,
    pendingExpiresAt: record.pendingExpiresAt,
    decidedAt: record.decidedAt,
    denialReason: record.denialReason,
    lapseReason: record.lapseReason,
  };
  if ((record.kind ?? 'agent-mint') === 'agent-mint') {
    // E325 section 9.1: a mint request in the requester's list (`kind=agent-mint`)
    // says what it asked for and where it stands, as the mint status read does:
    // never the decider, never the pack.
    Object.assign(view, {
      kind: 'agent-mint', targetTaskId: record.targetTaskId, requestedScopes: record.requestedScopes,
      approvedScopes: record.approvedScopes, collectExpiresAt: record.collectExpiresAt, collectedAt: record.collectedAt,
    });
  }
  if (record.kind === 'change' && record.change) {
    // E325: the target, the change before, requested and approved, the
    // lifetime and what was applied - never the decider, never a secret.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Object.assign(view, require('./ChangeRequestService').changeRequesterView(record.change), {
      granteePrincipalId: record.change.granteePrincipalId, reason: record.change.reason,
      relatedTaskId: record.change.relatedTaskId, relatedPhaseId: record.change.relatedPhaseId,
      collectExpiresAt: record.collectExpiresAt, collectedAt: record.collectedAt,
    });
  }
  if (record.kind === 'authority-edit' && record.authorityEdit) {
    // AZ-A13 clause 6: the object, the state before, the scopes asked for, the
    // state approved and the lifetime — never the decider, never a secret.
    const edit = record.authorityEdit;
    Object.assign(view, {
      object: { type: edit.objectType, id: edit.objectId, kind: edit.objectKindLabel },
      before: edit.before, requested: edit.requested, approved: edit.approved, diff: edit.diff,
      lifetime: edit.lifetime,
    });
  }
  if (record.kind === 'credential') {
    // clause 13: what a credential request asked for and what was approved —
    // the scopes, the pin, the label and the collect window. Never a secret.
    Object.assign(view, {
      requestedScopes: record.requestedScopes,
      approvedScopes: record.approvedScopes,
      requestedTransport: fields?.requestedTransport ?? null,
      approvedTransport: fields?.approvedTransport ?? null,
      label: fields?.credentialLabel ?? null,
      collectExpiresAt: record.collectExpiresAt,
      collectedAt: record.collectedAt,
      issuedCredentialId: fields?.issuedCredentialId ?? null,
    });
  }
  return view;
}

/** E49 delta (a): what became of the authority an approved request made. A
 * grant row is `live` or `expired` while the approval still owns it,
 * `handed-over` once clause 12a gave it to a linking assignment, and
 * `revoked` once it is gone (clause 12a, an owner revoke, or an expired row
 * replaced). */
export type CreatedGrantState = 'live' | 'expired' | 'revoked' | 'handed-over';

interface CoalesceState { windowStart: number; suppressed: number }

/** The decide act's input. The edit fields after `editedRules` are AZ-A9's
 * (clause 8) and are read for kinds `grant`/`credential` only; an agent-mint
 * decision ignores them exactly as it always has. */
export interface DecideInput {
  approvalId: string;
  decision: 'approve' | 'deny';
  editedScopes?: unknown;
  editedRules?: unknown;
  /** clause 8: shorten the expiry, never lengthen it. */
  editedExpiresAt?: unknown;
  /** clause 8: the grantee and the kind never change — present only to be
   * refused by name (EDIT_ONLY_NARROWS) when they differ. */
  editedGranteePrincipalId?: unknown;
  editedKind?: unknown;
  /** clauses 8 and 13 (credential kind): narrow the pin from any to mcp or api. */
  editedTransport?: unknown;
  /** clauses 8 and 13 (credential kind): the target never changes — it is the
   * requesting Connector — so any other value is refused by name. */
  editedTargetPrincipalId?: unknown;
  denialReason?: unknown;
  /** AZ-A13 clause 6j (kind authority-edit): the lifetime of the approved
   * widening, {choice: 'keep'} or {choice: 'until-task', taskId?, revertAt?}. */
  lifetime?: unknown;
  /** AZ-A13 clause 6d: the object never changes — present only to be refused. */
  editedObject?: unknown;
  /** E325 section 5.4 (kind change): the narrowed change, field by field. */
  editedChange?: unknown;
  /** E325 section 5.1 (kind change): the deciding session, which the ordered
   * predicate reads on the locked row (root, administrator or owner tier). */
  deciderViewer?: ChangeDeciderViewer;
  /** E325 sections 3 and 7.1 (kind change, T2 S5): the deciding session's own
   * server-derived facts, so an object target's executor runs its direct
   * predicate on the DECIDER (never the requester, never the system). */
  deciderRequest?: ChangeDeciderRequest;
  deciderPrincipalId: string;
  /** clause 6: how the route admitted the decider — root, or an
   * administrator login session (APPROVAL_DECIDE_ACT). Required for the
   * AZ-A9 kinds; the service refuses those without it (fail closed). */
  deciderStanding?: 'root' | 'administrator';
  /** clause 11 (credential kind): the decider session's scope set NOW. The
   * approved scopes must lie within what it may put on a credential; absent
   * reads as empty, which refuses (fail closed). */
  deciderScopes?: string[];
  /** D-02 (E43 Q1): for an agent-mint item, who decided — root, the owning
   * Account over its own subtree (§6.1), or an administrator session. Recorded
   * in the decision AUDIT only; the mint validation is unchanged. */
  mintDeciderStanding?: 'root' | 'owner' | 'administrator';
  stepUp: { tokenId: string; method: string };
}

/** The HTTP decision consumes its token inside the decision transaction. A
 * validation refusal rolls that consumption back with the decision. */
export type TokenDecideInput = Omit<DecideInput, 'stepUp'> & { stepUpToken: string };

/** Filing a grant or credential request (clauses 2-5, 11, 13). */
export interface AccessRequestInput {
  kind: unknown;
  requesterPrincipalId: string;
  requestingCredentialId: string;
  /** The requester as the evaluator sees it (the route's actorFromRequest):
   * the related task/phase must be readable BY IT, else 404-conceal. */
  authorizationActor: AuthorizationActor;
  granteePrincipalId?: unknown;
  requestedRules?: unknown;
  requestedExpiresAt?: unknown;
  reason: unknown;
  relatedTaskId?: unknown;
  relatedPhaseId?: unknown;
  /** clause 13 (credential kind): the scopes the credential carries. */
  requestedScopes?: unknown;
  /** clause 13: the transport pin; default the filing credential's pin. */
  requestedTransport?: unknown;
  /** clause 13: the issued credential's label (optional). */
  label?: unknown;
  /** clause 13: the Connector the credential is for. Slice P1-B-2 builds ONE
   * target, the requester itself: omit it, or name yourself. */
  targetPrincipalId?: unknown;
  /** AZ-A13 clause 6c (kind authority-edit): {type: 'credential'}; the id, when
   * named, must be the presenting credential's. */
  object?: unknown;
  /** AZ-A13 clause 6c: the scopes to add to the presenting credential. */
  addScopes?: unknown;
  /** E325 (kind change): the target type, the single target id, the requested
   * change, the grantee's type and the requested lifetime. */
  targetType?: unknown;
  targetId?: unknown;
  change?: unknown;
  granteeType?: unknown;
  lifetime?: unknown;
}

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/** One live identity a credential change reaches (AZ-A13 clause 6g). */
export interface IdentityReached { principalId: string; handle: string; credentialId: string; scopes: string[] }

/**
 * THE CREDENTIAL REACH PROJECTION (AZ-A13 clause 6g), the one copy: for a
 * Connector and one or more scope sets, what the Connector could actually
 * exercise with each set (`effectiveScopes` over its chain: its own() caps
 * and its Account's role set bound every credential, so a scope beyond them
 * is carried and inert), its owning Account, and every live identity the
 * change reaches (the active Agents under the Connector with a live
 * credential). The legacy edit decision block and the credential decision
 * block read it, and so does the change request's relationship diff
 * (change-request design section 6: "credential scopes -> the
 * effectiveAfterEdit projection and identitiesReached").
 */
export async function credentialReach(
  connectorId: string, scopeSets: string[][], options: { identities?: boolean; queryable?: Queryable } = {},
): Promise<{ ownerAccount: { principalId: string; role: string | null } | null; effective: string[][]; identitiesReached: IdentityReached[] }> {
  const q = options.queryable ?? pool;
  let effective: string[][] = scopeSets.map(() => []);
  let ownerAccount: { principalId: string; role: string | null } | null = null;
  try {
    const chain = await delegationService.resolveChain(connectorId, q);
    const account = chain.links[chain.links.length - 1];
    ownerAccount = { principalId: account.principalId, role: account.role ?? null };
    effective = scopeSets.map((scopes) => delegationService.effectiveScopes(chain, scopes, scopesForRole(account.role)));
  } catch { effective = scopeSets.map(() => []); }
  if (options.identities === false) return { ownerAccount, effective, identitiesReached: [] };
  const agents = await q.query(
    `SELECT p.id, p.handle, c.id AS credential_id, c.scopes FROM principals p
       JOIN principal_credentials c ON c.principal_id = p.id
      WHERE p.parent_principal_id = $1 AND p.status = 'active' AND c.revoked_at IS NULL AND c.grace_until IS NULL
        AND (c.expires_at IS NULL OR c.expires_at > NOW())
      ORDER BY p.handle`, [connectorId]);
  return {
    ownerAccount,
    effective,
    identitiesReached: agents.rows.map((row) => ({
      principalId: String(row.id), handle: String(row.handle), credentialId: String(row.credential_id),
      scopes: parseJson<string[]>(row.scopes, []),
    })),
  };
}

/** §5.2 rule 8: every approval-lifecycle REFUSAL is a durable denied audit
 * with the reason and the affected chain — written on the pool so a
 * transaction rollback cannot erase it. Unexpected errors (500s) are not
 * refusals and ride the error path unaudited. */
async function auditRefusal(
  action: string, e: unknown, actor: AuditActor,
  resource: { type: string; id: string | null }, chainPrincipalId: string | null,
): Promise<void> {
  const refusal = (e instanceof ApprovalError || e instanceof AgentMintError)
    ? e.code : null;
  if (!refusal) return;
  await auditService.record({
    action, actor, outcome: 'denied',
    resourceType: resource.type, resourceId: resource.id,
    metadata: {
      refusal,
      chain: chainPrincipalId ? await auditChainFor(pool, chainPrincipalId) : [],
      // AZ-A9 clause 11/14: an AZ-A9 refusal names its rule, subject, clause
      // and kind. Mint refusals carry none, so their rows are unchanged.
      ...(e instanceof ApprovalError && e.refusal ? { ...e.refusal } : {}),
    },
  }).catch(() => undefined);
}

export class ApprovalService {
  private noticeWindows = new Map<string, CoalesceState>();

  async get(approvalId: string): Promise<ApprovalRecord> {
    if (!UUID_PATTERN.test(approvalId)) throw err(404, 'APPROVAL_NOT_FOUND', 'No such approval');
    const result = await pool.query(`${APPROVAL_SELECT} WHERE a.id = $1`, [approvalId]);
    if (result.rows.length === 0) throw err(404, 'APPROVAL_NOT_FOUND', 'No such approval');
    return mapApproval(result.rows[0]);
  }

  /** SELF-SCOPE listing (§6.1/§9.1): root full view; a non-root session
   * sees only approvals whose SUBJECT (the requester) lies in its own
   * subtree, itself included.
   *
   * AZ-A9 clause 6 (ratified 2026-10-10, E43 Q1): an ADMINISTRATOR session
   * additionally sees every item of every kind decided on /approvals, whoever
   * filed it — agent-mint included — because it decides them all. A
   * non-administrator session keeps the self-scope arm. `kindFilter` is the
   * clause-9 `?kind=` beside `?status=`. */
  async list(
    viewer: { principalId: string; isRoot: boolean; isAdministrator?: boolean },
    statusFilter?: string,
    kindFilter?: ApprovalKind,
  ): Promise<ApprovalRecord[]> {
    const params: unknown[] = [];
    const clauses: string[] = [];
    const selfScope = approvalSelfScopeCondition(viewer, params);
    if (selfScope) clauses.push(selfScope);
    if (statusFilter) {
      params.push(statusFilter);
      clauses.push(`a.status = $${params.length}`);
    }
    if (kindFilter) {
      params.push(kindFilter);
      clauses.push(`a.kind = $${params.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await pool.query(`${APPROVAL_SELECT} ${where} ORDER BY a.requested_at DESC LIMIT 500`, params);
    return result.rows.map(mapApproval);
  }

  async events(approvalId: string, limit = 100): Promise<any[]> {
    const result = await pool.query(
      `SELECT * FROM approval_events WHERE approval_id = $1
       ORDER BY occurred_at DESC, id DESC LIMIT $2`,
      [approvalId, Math.min(Math.max(limit, 1), 500)],
    );
    return result.rows.map((row) => ({
      id: row.id, occurredAt: row.occurred_at, approvalId: row.approval_id,
      action: row.action, actorPrincipalId: row.actor_principal_id ?? null,
      actorHandle: row.actor_handle, metadata: row.metadata ?? {},
    }));
  }

  /**
   * §6.1 default path: a Connector REQUESTS an Agent identity. Creates the
   * pending Approval bound to the exact presenting credential, under the
   * per-Connector quota (T21), and alerts the notification endpoints with
   * a verifiable deep link (coalesced per Connector).
   */
  async request(input: {
    requesterPrincipalId: string;
    requestingCredentialId: string;
    targetTaskId: string;
    requestedScopes: unknown;
    requestedRole?: unknown;
    requestedRules?: unknown;
  }, actor: AuditActor): Promise<ApprovalRecord> {
    const requester = await principalService.getPrincipalById(input.requesterPrincipalId);
    if (!requester) throw err(404, 'REQUESTER_NOT_FOUND', 'requester resolves to no principal');
    if (requester.legacyIdentity) {
      await auditService.record({
        action: 'legacy.refused', actor, outcome: 'denied',
        resourceType: 'principal', resourceId: input.requesterPrincipalId,
        metadata: { act: 'approval.request', reason: 'legacy_identity frozen out (§10, T37)' },
      }).catch(() => undefined);
      throw err(409, 'LEGACY_FROZEN', 'legacy identities are frozen out of Approval creation (§10, T37)');
    }
    if (requester.kind === 'agent') {
      // AZ-28: mint is Connector/Account-plane; a sub-worker is a sibling
      // minted by the Connector — Agent-layer requests refuse (T11 shape).
      throw err(422, 'AGENT_PLANE_REFUSED', 'Agent-layer credentials never request mints (AZ-28): a sub-worker is a sibling minted by the Connector');
    }
    if (!requester.parentPrincipalId) {
      throw err(422, 'CONNECTOR_PLANE_ONLY', 'bearer mint requests are the Connector plane (§6.1); human Accounts mint through their session (§6.1a)');
    }
    if (!UUID_PATTERN.test(input.targetTaskId ?? '')) {
      throw err(422, 'INVALID_MINT_REQUEST', 'targetTaskId must be a full UUID');
    }
    const scopes = validateRequestedScopes(input.requestedScopes);
    const requestedRole = normalizeMintRole(input.requestedRole, scopes);
    const rules = input.requestedRules === undefined || input.requestedRules === null
      ? []
      : validateRules(input.requestedRules);

    // Full validation at REQUEST time too — a request that could never be
    // approved should refuse now, loudly, not sit in the queue. Rule 8:
    // these refusals audit durably with the requester chain.
    try {
      await agentMintService.assertRequesterLive(input.requesterPrincipalId, input.requestingCredentialId);
      await agentMintService.assertTaskMintable(pool, input.targetTaskId);
      // T2 at FILING (card 785e1eed P1-C; census 82804ddf gap 3). Decide,
      // collect, the session mint and the warrant mint all ran the mint-time
      // ⊆ check and filing did not, so a request no approver could ever
      // approve sat pending until someone opened it and pressed approve. The
      // SAME two halves run here, computed the way decide computes them: the
      // scope set against the requesting credential's CURRENT effective set,
      // and the object rules against the requester's live authority — one
      // function, so the refusal names the same failing rule as decide's.
      const credential = UUID_PATTERN.test(input.requestingCredentialId ?? '')
        ? await pool.query('SELECT scopes FROM principal_credentials WHERE id = $1', [input.requestingCredentialId])
        : { rows: [] as any[] };
      const effectiveNow = await agentMintService.currentEffectiveScopes(
        input.requesterPrincipalId, parseJson<string[]>(credential.rows[0]?.scopes, []));
      agentMintService.assertScopesWithinEffective(effectiveNow, scopes);
      await agentMintService.assertObjectAuthorityCovers(input.requesterPrincipalId, rules);
    } catch (e) {
      await auditRefusal('approval.request', e, actor,
        { type: 'principal', id: input.requesterPrincipalId }, input.requesterPrincipalId);
      throw e;
    }

    // T21: per-Connector quota, refused loudly and audited.
    const quota = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
         COUNT(*) FILTER (WHERE requested_at > NOW() - INTERVAL '24 hours')::int AS daily
       FROM approvals WHERE requester_principal_id = $1
         AND NOT (kind = 'authority-edit' AND COALESCE(session_evidence->>'door', '') = 'one-act')`,
      [input.requesterPrincipalId],
    );
    const { pending, daily } = quota.rows[0];
    if (Number(pending) >= APPROVAL_QUOTA_PENDING || Number(daily) >= APPROVAL_QUOTA_DAILY) {
      await auditService.record({
        action: 'approval.request', actor, outcome: 'denied',
        resourceType: 'principal', resourceId: input.requesterPrincipalId,
        metadata: {
          refusal: 'MINT_QUOTA_EXCEEDED', pending: Number(pending), daily: Number(daily),
          quotaPending: APPROVAL_QUOTA_PENDING, quotaDaily: APPROVAL_QUOTA_DAILY,
          chain: await auditChainFor(pool, input.requesterPrincipalId),
        },
      }).catch(() => undefined);
      throw err(429, 'MINT_QUOTA_EXCEEDED',
        `mint-request quota exceeded (AZ-21a: ${APPROVAL_QUOTA_PENDING} pending / ${APPROVAL_QUOTA_DAILY} per day) — excess refuses loudly (T21)`);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const created = await client.query(
        `INSERT INTO approvals
           (requester_principal_id, requesting_credential_id, target_task_id,
            requested_scopes, requested_rules, requested_role, pending_expires_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
         RETURNING id`,
        [
          input.requesterPrincipalId, input.requestingCredentialId, input.targetTaskId,
          JSON.stringify(scopes), JSON.stringify(rules), requestedRole,
          new Date(Date.now() + APPROVAL_PENDING_TTL_MS),
        ],
      );
      const approvalId = String(created.rows[0].id);
      await writeApprovalEvent(client, {
        approvalId, action: 'approval.requested', actor,
        metadata: { targetTaskId: input.targetTaskId, scopes, rules },
      });
      await auditService.record({
        action: 'approval.request', actor,
        resourceType: 'approval', resourceId: approvalId,
        metadata: {
          requesterPrincipalId: input.requesterPrincipalId,
          requestingCredentialId: input.requestingCredentialId,
          targetTaskId: input.targetTaskId, scopes, rules,
          chain: await auditChainFor(client, input.requesterPrincipalId),
        },
      }, client);
      await client.query('COMMIT');
      this.dispatchApprovalNotice(approvalId, input.requesterPrincipalId, requester.handle);
      return this.get(approvalId);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** T21 coalescing: at most one endpoint alert per Connector per window;
   * suppressed requests ride the next alert as a count. Fire-and-forget —
   * the Access manager queue is the authoritative surface. */
  dispatchApprovalNotice(
    approvalId: string, requesterPrincipalId: string, requesterHandle: string,
    // AZ-A9 clause 14: the notice names the kind it asks about. The default
    // keeps the agent-mint text exactly as it was; the deep link is the same
    // for every kind and carries no authority (T8).
    kind: ApprovalKind = 'agent-mint',
    // AZ-A13 clause 6h: an edit request's notice names, in words, the kind of
    // object amended and the object.
    subject: string | null = null,
  ): void {
    const now = Date.now();
    const state = this.noticeWindows.get(requesterPrincipalId);
    if (state && now - state.windowStart < APPROVAL_NOTICE_COALESCE_MS) {
      state.suppressed += 1;
      return;
    }
    const suppressed = state?.suppressed ?? 0;
    this.noticeWindows.set(requesterPrincipalId, { windowStart: now, suppressed: 0 });
    notificationEndpointService
      .dispatchException({
        name: 'approval.requested',
        objectType: 'approval',
        objectId: approvalId,
        reason: suppressed > 0
          ? `${kind} approval requested by ${requesterHandle}${subject ? ` (${subject})` : ''} (+${suppressed} coalesced); decide on the board: ${approvalDeepLinkPath(approvalId)}`
          : `${kind} approval requested by ${requesterHandle}${subject ? ` (${subject})` : ''}; decide on the board: ${approvalDeepLinkPath(approvalId)}`,
        occurredAt: new Date().toISOString(),
      })
      .catch((e) => logCaughtWarning('[ApprovalService] approval notice dispatch failed:', e));
  }

  /**
   * DECIDE (§6.1, AZ-16, T7): board-only — the ROUTE has established an
   * authenticated SESSION and self-scope containment. Consume the single-use
   * step-up inside this transaction, so a validation refusal rolls it back.
   * Approve may EDIT the authority DOWN (never up); a
   * decision re-runs the FULL mint validation and refuses loudly on
   * failure (the approval stays pending). Deny records the reason.
   */
  async decide(input: DecideInput | TokenDecideInput, actor: AuditActor): Promise<ApprovalRecord> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(`SELECT * FROM approvals WHERE id = $1 FOR UPDATE`, [input.approvalId]);
      if (locked.rows.length === 0) throw err(404, 'APPROVAL_NOT_FOUND', 'No such approval');
      const row = locked.rows[0];
      if (row.status !== 'pending') {
        throw err(409, 'APPROVAL_NOT_PENDING', `this approval is ${row.status} (A17.11: single-use lifecycle)`);
      }
      const decidedInput: DecideInput = 'stepUpToken' in input
        ? { ...input, stepUp: await stepUpService.consume(client, {
          token: input.stepUpToken,
          principalId: input.deciderPrincipalId,
          action: 'approval.decide',
          targetId: input.approvalId,
        }) }
        : input;
      // AZ-A9: a grant or credential request is decided by its own arm, on
      // this locked row and in this transaction. Everything below is the
      // agent-mint decision, unchanged (clause 16).
      if (row.kind && row.kind !== 'agent-mint') {
        return await this.decideAccessRequest(client, row, decidedInput, actor);
      }
      if (new Date(row.pending_expires_at).getTime() <= Date.now()) {
        // Live enforcement; persist the flip on the way out.
        await this.lapse(client, String(row.id), 'PENDING_EXPIRED', actor);
        await client.query('COMMIT');
        throw err(409, 'APPROVAL_LAPSED', 'this approval passed its 7-day pending TTL (§6.1)');
      }

      if (decidedInput.decision === 'deny') {
        const reason = typeof decidedInput.denialReason === 'string' ? decidedInput.denialReason.slice(0, 500) : null;
        await client.query(
          `UPDATE approvals SET status = 'denied', decided_by_principal_id = $2, decided_at = NOW(),
                  decision_step_up = $3::jsonb, denial_reason = $4, updated_at = NOW()
            WHERE id = $1`,
          [row.id, decidedInput.deciderPrincipalId, JSON.stringify(decidedInput.stepUp), reason],
        );
        await writeApprovalEvent(client, { approvalId: String(row.id), action: 'approval.denied', actor, metadata: { reason, stepUp: decidedInput.stepUp } });
        await auditService.record({
          action: 'approval.deny', actor, resourceType: 'approval', resourceId: String(row.id),
          metadata: {
            reason, stepUp: decidedInput.stepUp, ...mintStanding(decidedInput),
            chain: await auditChainFor(client, String(row.requester_principal_id)),
          },
        }, client);
        await client.query('COMMIT');
        return this.get(String(row.id));
      }

      // Approve — possibly edited DOWN (§6.1): the edited authority must
      // lie within the request.
      const requestedScopes = parseJson<string[]>(row.requested_scopes, []);
      const requestedRules = parseJson<ProfileRule[]>(row.requested_rules, []);
      let approvedScopes = requestedScopes;
      let approvedRules = requestedRules;
      if (decidedInput.editedScopes !== undefined && decidedInput.editedScopes !== null) {
        approvedScopes = validateRequestedScopes(decidedInput.editedScopes);
        const check = scopesWithin(requestedScopes, approvedScopes);
        if (!check.within) {
          throw err(422, 'EDIT_ONLY_NARROWS', `the approver edits authority DOWN (§6.1): ${check.exceeding.join(', ')} was never requested`);
        }
      }
      if (decidedInput.editedRules !== undefined && decidedInput.editedRules !== null) {
        approvedRules = Array.isArray(decidedInput.editedRules) && decidedInput.editedRules.length === 0 ? [] : validateRules(decidedInput.editedRules);
        const check = rulesCovered(sourcesFromRules(requestedRules), approvedRules);
        if (!check.covered) {
          throw err(422, 'EDIT_ONLY_NARROWS', `the approver edits authority DOWN (§6.1): ${JSON.stringify(check.failing)} was never requested`);
        }
      }
      normalizeMintRole(row.requested_role, approvedScopes);

      // The FULL mint validation at decision time (§6.1): holder live, the
      // BOUND credential live and un-graced, task mintable, authority ⊆
      // the requester's CURRENT effective set. Refuse loudly; stay pending.
      await agentMintService.assertRequesterLive(String(row.requester_principal_id), row.requesting_credential_id ? String(row.requesting_credential_id) : null);
      await agentMintService.assertTaskMintable(client, String(row.target_task_id));
      const credential = await client.query('SELECT scopes FROM principal_credentials WHERE id = $1', [row.requesting_credential_id]);
      const credentialScopes = parseJson<string[]>(credential.rows[0]?.scopes, []);
      // Review 1897c959 B2 (§6.1/T27): the decision compares against the
      // requester's CURRENT effective set — the production chain evaluator
      // over the bound credential — never the raw stored scopes, so an
      // own()/role narrowing between request and decision refuses HERE.
      const effectiveNow = await agentMintService.currentEffectiveScopes(
        String(row.requester_principal_id), credentialScopes);
      agentMintService.assertScopesWithinEffective(effectiveNow, approvedScopes);
      await agentMintService.assertObjectAuthorityCovers(String(row.requester_principal_id), approvedRules, client);

      await client.query(
        `UPDATE approvals SET status = 'approved', approved_scopes = $2::jsonb, approved_rules = $3::jsonb,
                decided_by_principal_id = $4, decided_at = NOW(), decision_step_up = $5::jsonb,
                collect_expires_at = $6, updated_at = NOW()
          WHERE id = $1`,
        [
          row.id, JSON.stringify(approvedScopes), JSON.stringify(approvedRules),
          decidedInput.deciderPrincipalId, JSON.stringify(decidedInput.stepUp),
          new Date(Date.now() + APPROVAL_COLLECT_TTL_MS),
        ],
      );
      await writeApprovalEvent(client, {
        approvalId: String(row.id), action: 'approval.approved', actor,
        metadata: { approvedScopes, approvedRules, edited: approvedScopes !== requestedScopes || approvedRules !== requestedRules, stepUp: decidedInput.stepUp },
      });
      await auditService.record({
        action: 'approval.approve', actor, resourceType: 'approval', resourceId: String(row.id),
        metadata: {
          approvedScopes, approvedRules, stepUp: decidedInput.stepUp, ...mintStanding(decidedInput),
          chain: await auditChainFor(client, String(row.requester_principal_id)),
        },
      }, client);
      await client.query('COMMIT');
      return this.get(String(row.id));
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      await auditRefusal('approval.decide', e, actor,
        { type: 'approval', id: input.approvalId }, null);
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * COLLECT (§6.1, AZ-31c, T27): single-use, by the SAME connector
   * credential that requested, within the 24h TTL. Re-runs the COMPLETE
   * mint validation TRANSACTIONALLY with Approval consumption and
   * Principal/Credential creation. Terminal failure → lapse with audited
   * reason; transient failure → refuse WITHOUT consuming.
   */
  async collect(input: {
    approvalId: string;
    presentingCredentialId: string;
    presentingPrincipalId: string;
    presentingEffectiveScopes: string[];
  }, actor: AuditActor): Promise<MintedAgentPack> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(`SELECT * FROM approvals WHERE id = $1 FOR UPDATE`, [input.approvalId]);
      if (locked.rows.length === 0) throw err(404, 'APPROVAL_NOT_FOUND', 'No such approval');
      const row = locked.rows[0];
      // Binding: the SAME credential that requested. Conceal foreign rows.
      if (!row.requesting_credential_id || String(row.requesting_credential_id) !== input.presentingCredentialId) {
        throw err(404, 'APPROVAL_NOT_FOUND', 'No such approval');
      }
      // AZ-A9 clause 9: collect mints an Agent from an agent-mint approval.
      // A grant approval wrote its rows when it was decided and has nothing
      // to collect; a credential approval collects through its own route
      // (clause 13, `collectAccessRequest`). Neither may reach executeMint.
      if (row.kind && row.kind !== 'agent-mint') {
        throw refuse(409, 'NOT_COLLECTABLE',
          `a ${row.kind} request is not collected here: ${row.kind === 'grant'
            ? 'its grant rows were written when it was approved'
            : 'a credential request is collected at POST /delegation/access-requests/:id/collect (AZ-A9 clause 13)'}`,
          'requester', 9, 'collect consumes an agent-mint approval; a grant approval writes its rows at decide',
          { kind: String(row.kind) });
      }
      if (row.status !== 'approved') {
        throw err(409, 'APPROVAL_NOT_COLLECTABLE', `this approval is ${row.status} (A17.11: collect consumes an approved authorization exactly once)`);
      }
      if (row.collect_expires_at && new Date(row.collect_expires_at).getTime() <= Date.now()) {
        await this.lapse(client, String(row.id), 'COLLECT_TTL_EXPIRED', actor);
        await client.query('COMMIT');
        throw err(409, 'APPROVAL_LAPSED', 'this approval passed its 24h collect TTL (§6.1)');
      }

      const approvedScopes = parseJson<string[]>(row.approved_scopes, []);
      const approvedRules = parseJson<ProfileRule[]>(row.approved_rules, []);
      // ── Round-1 review finding S3-F1 (`b7348598`) ──
      //
      // COLLECT used the STORED scope list unchanged. `AgentMintService`'s
      // own header says every mint path re-runs the complete validation at
      // authority-exercise time, and every other path does: the warrant
      // request, the session mint, the approval request and the approval edit
      // all call `validateRequestedScopes`. COLLECT did not, so an approval
      // granted BEFORE a scope entered `AGENT_EXCLUDED_SCOPES` could still
      // mint that scope afterwards — the exclusion would be true of new
      // requests and false of stored ones.
      //
      // It runs FIRST inside the terminal-validation try, so nothing else
      // consumes an illegal list, and a refusal LAPSES the approval through
      // the shipped T27 path exactly as any other terminal failure does. It
      // is strictly fail-closed: a still-legal stored list is unchanged. It
      // also hardens §5.2 rules 2 and 3 on this path, which were equally
      // unchecked here — `root` and `*:admin` in a stored approval.
      let mintScopes: string[] = approvedScopes;
      try {
        mintScopes = validateRequestedScopes(approvedScopes);
        // The COMPLETE mint validation, NOW (§6.1): requester live and
        // un-graced, current authority, task mintable, writer slot free.
        await agentMintService.assertRequesterLive(String(row.requester_principal_id), String(row.requesting_credential_id));
        await agentMintService.assertTaskMintable(client, String(row.target_task_id));
        await agentMintService.assertWriterSlotFree(client, String(row.target_task_id), mintScopes, row.requested_role);
        agentMintService.assertScopesWithinEffective(input.presentingEffectiveScopes, mintScopes);
        await agentMintService.assertObjectAuthorityCovers(String(row.requester_principal_id), approvedRules, client);
      } catch (validation) {
        if (validation instanceof AgentMintError && validation.disposition === 'terminal') {
          // T27: a terminal failure LAPSES the approval with the reason.
          await this.lapse(client, String(row.id), validation.code, actor);
          await client.query('COMMIT');
          throw err(409, 'APPROVAL_LAPSED', `collect failed terminally and lapsed the approval (§6.1): ${validation.message}`);
        }
        // Transient: refuse WITHOUT consuming — it stays approved until TTL.
        throw validation;
      }

      const pack = await agentMintService.executeMint(client, {
        targetTaskId: String(row.target_task_id),
        authority: { scopes: mintScopes, rules: approvedRules },
        role: row.requested_role,
        parentPrincipalId: input.presentingPrincipalId,
        mintedUnderWarrantId: null,
        label: null,
      }, actor);
      await client.query(
        `UPDATE approvals SET status = 'collected', collected_at = NOW(), minted_principal_id = $2, updated_at = NOW()
          WHERE id = $1`,
        [row.id, pack.principalId],
      );
      await writeApprovalEvent(client, {
        approvalId: String(row.id), action: 'approval.collected', actor,
        metadata: { mintedPrincipalId: pack.principalId },
      });
      await auditService.record({
        action: 'approval.collect', actor, resourceType: 'approval', resourceId: String(row.id),
        metadata: { mintedPrincipalId: pack.principalId, chain: await auditChainFor(client, pack.principalId) },
      }, client);
      await client.query('COMMIT');
      return pack;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      await auditRefusal('approval.collect', e, actor,
        { type: 'approval', id: input.approvalId }, input.presentingPrincipalId);
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * SESSION MINT (§6.1a): the atomic human-Account path. The ROUTE has
   * established the authenticated session and CONSUMED the step-up token
   * bound to this act. One transaction: Approval row
   * created→approved→collected with session evidence, full validation,
   * principal + credential creation; the pack renders once in the response.
   */
  async sessionMint(input: {
    accountPrincipalId: string;
    sessionScopes: string[];
    targetTaskId: string;
    requestedScopes: unknown;
    requestedRole?: unknown;
    requestedRules?: unknown;
    label?: unknown;
    stepUp: { tokenId: string; method: string };
    /**
     * WHO IS ASKING, for the target-authority re-check below (round-1 review
     * P2). Required rather than optional: a caller that forgets it must fail
     * to compile, because the alternative is a mint that silently skips the
     * only check standing between a session and a Task it may not read.
     */
    authorizationActor: AuthorizationActor;
  }, actor: AuditActor): Promise<{ approval: ApprovalRecord; pack: MintedAgentPack }> {
    const account = await principalService.getPrincipalById(input.accountPrincipalId);
    if (!account) throw err(404, 'ACCOUNT_NOT_FOUND', 'the session principal resolves to no row');
    if (account.legacyIdentity) throw err(409, 'LEGACY_FROZEN', 'legacy identities are frozen out of the mint machinery (§10, T37)');
    if (account.kind !== 'human' || account.parentPrincipalId) {
      // Service Accounts have no session and act through Connectors (§6.1a).
      throw err(422, 'SESSION_MINT_IS_HUMAN', 'the session mint is the direct HUMAN Account → Agent path (§6.1a)');
    }
    if (account.status !== 'active') throw err(409, 'ACCOUNT_NOT_ACTIVE', `the session Account is ${account.status}`);
    if (!UUID_PATTERN.test(input.targetTaskId ?? '')) {
      throw err(422, 'INVALID_MINT_REQUEST', 'targetTaskId must be a full UUID');
    }
    const scopes = validateRequestedScopes(input.requestedScopes);
    const requestedRole = normalizeMintRole(input.requestedRole, scopes);
    const rules = input.requestedRules === undefined || input.requestedRules === null
      ? []
      : validateRules(input.requestedRules);
    const label = typeof input.label === 'string' ? input.label.slice(0, 128) : null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // ── the target ceiling, re-evaluated ON THIS TRANSACTION (review P2) ──
      //
      // The route authorizes the target before compiling the Brief, which is
      // where the concealed refusal belongs. But that decision was reached on
      // the pool, in a separate operation, and the durable act happens here:
      // between the two sit the Task read and the Brief compile, and any
      // visibility, ownership, role, grant or profile change landing in that
      // window would have been minted straight through. So the SAME predicate
      // runs again, on THIS connection, immediately before anything durable is
      // created — `authorizedIds` takes the queryable for exactly this reason.
      //
      // What this does and does not buy, stated plainly: the window shrinks
      // from "route check, Task read, Brief compile, new transaction" to the
      // statements below, and nothing is disclosed or created before it — the
      // Brief rides the RESPONSE, which only exists if this transaction
      // commits. It is NOT serialisable: a revocation committing between this
      // SELECT and the COMMIT is still admitted under READ COMMITTED. Closing
      // that needs a locking or version protocol over the Task and the
      // authority rows, which is a design act, not a hardening edit.
      //
      // It runs BEFORE the lifecycle check on purpose: a caller with no
      // authority over the target learns nothing about its state, not even
      // whether it is terminal.
      const authorizedTargets = await authorizationRepository.authorizedIds(
        input.authorizationActor, 'task', [input.targetTaskId], 'read', client,
      );
      if (!authorizedTargets.has(String(input.targetTaskId))) {
        // The SAME words the route uses for an absent target, so the refusal
        // is one answer with one meaning wherever it is raised.
        throw err(404, 'TASK_NOT_FOUND', 'target task resolves to no row');
      }
      await agentMintService.assertTaskMintable(client, input.targetTaskId);
      await agentMintService.assertWriterSlotFree(client, input.targetTaskId, scopes, requestedRole);
      // §5.2 rule 1: base = the Account's OWN effective authority; step-up
      // authorized the ACT and never widened the ceiling.
      agentMintService.assertScopesWithinEffective(input.sessionScopes, scopes);
      await agentMintService.assertObjectAuthorityCovers(input.accountPrincipalId, rules, client);

      const sessionEvidence = { kind: 'session-mint', stepUp: input.stepUp, at: new Date().toISOString() };
      const created = await client.query(
        `INSERT INTO approvals
           (status, requester_principal_id, requesting_credential_id, session_evidence,
            target_task_id, requested_scopes, requested_rules, requested_role,
            approved_scopes, approved_rules, decided_by_principal_id, decided_at,
            decision_step_up, pending_expires_at, collect_expires_at)
         VALUES ('approved', $1, NULL, $2::jsonb, $3, $4::jsonb, $5::jsonb, $7,
                 $4::jsonb, $5::jsonb, $1, NOW(), $6::jsonb, NOW(), NOW() + INTERVAL '1 minute')
         RETURNING id`,
        [
          input.accountPrincipalId, JSON.stringify(sessionEvidence), input.targetTaskId,
          JSON.stringify(scopes), JSON.stringify(rules), JSON.stringify(input.stepUp), requestedRole,
        ],
      );
      const approvalId = String(created.rows[0].id);
      const pack = await agentMintService.executeMint(client, {
        targetTaskId: input.targetTaskId,
        authority: { scopes, rules },
        role: requestedRole,
        // §6.1a: the Account is the parent — the only legal producer of
        // the Account→Agent chain shape.
        parentPrincipalId: input.accountPrincipalId,
        mintedUnderWarrantId: null,
        label,
      }, actor);
      await client.query(
        `UPDATE approvals SET status = 'collected', collected_at = NOW(), minted_principal_id = $2, updated_at = NOW()
          WHERE id = $1`,
        [approvalId, pack.principalId],
      );
      for (const action of ['approval.requested', 'approval.approved', 'approval.collected']) {
        await writeApprovalEvent(client, {
          approvalId, action, actor, metadata: { sessionMint: true, stepUp: input.stepUp },
        });
      }
      await auditService.record({
        action: 'approval.session_mint', actor,
        resourceType: 'approval', resourceId: approvalId,
        metadata: {
          mintedPrincipalId: pack.principalId, targetTaskId: input.targetTaskId,
          scopes, rules, stepUp: input.stepUp,
          chain: await auditChainFor(client, pack.principalId),
        },
      }, client);
      await client.query('COMMIT');
      return { approval: await this.get(approvalId), pack };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      await auditRefusal('approval.session_mint', e, actor,
        { type: 'principal', id: input.accountPrincipalId }, input.accountPrincipalId);
      throw e;
    } finally {
      client.release();
    }
  }

  // ══════ AZ-A9: grant and credential requests (ratified 2026-10-10, E43; card 785e1eed P1-B, P1-B-2) ══════

  /**
   * FILE a request (clauses 2-5, 11 and 13). The bearer plane: a Connector or
   * an Agent asks for authority on its chain-root Account (kind `grant`), or a
   * Connector asks for ONE credential on itself carrying scopes it lacks (kind
   * `credential`). Filing changes no authority table (clause 2): it writes one
   * pending Approval, under the shared per-requester quota (one queue across
   * kinds).
   *
   * Everything a decider could never approve refuses NOW, loudly, by name,
   * and every refusal audits durably with the requester chain (§5.2 r8,
   * clause 14): the kind, the grantee (clause 4), the rows (clauses 3 and 5) or
   * the scopes and pin (clauses 11 and 13), the reason, the expiry, the related
   * task or phase (readable by the requester, else 404-conceal), ALREADY_HELD
   * (clause 5, measured with the clause-11 containment function; for a
   * credential, a live credential that already carries every requested scope),
   * the decider-ceiling preview (clause 11) and the quota.
   */
  async requestAccess(input: AccessRequestInput, actor: AuditActor): Promise<ApprovalRecord> {
    if (input.kind === 'change') return this.requestChange(input, actor);
    if (input.kind === 'authority-edit') return this.requestAuthorityEdit(input, actor);
    if ((input.object !== undefined && input.object !== null) || (input.addScopes !== undefined && input.addScopes !== null)) {
      const e = refuse(422, 'INVALID_ACCESS_REQUEST',
        'object and addScopes belong to an edit request (kind authority-edit, AZ-A13 clause 6c)', 'requester', 10,
        'a grant or credential filing carries no edit fields', { kind: typeof input.kind === 'string' ? input.kind : null });
      await auditRefusal('approval.request', e, actor,
        { type: 'principal', id: UUID_PATTERN.test(input.requesterPrincipalId ?? '') ? input.requesterPrincipalId : null },
        UUID_PATTERN.test(input.requesterPrincipalId ?? '') ? input.requesterPrincipalId : null);
      throw e;
    }
    let filed: {
      kind: 'grant' | 'credential'; requesterHandle: string; granteeId: string; rules: ProfileRule[]; reason: string;
      requestedAt: Date; expiresAt: Date; relatedTaskId: string | null; relatedPhaseId: string | null;
      scopes: string[]; transport: string | null; label: string | null;
    };
    try {
      const kind = this.filableKind(input.kind) as 'grant' | 'credential';
      const requester = UUID_PATTERN.test(input.requesterPrincipalId ?? '')
        ? await principalService.getPrincipalById(input.requesterPrincipalId)
        : null;
      if (!requester) {
        throw refuse(404, 'REQUESTER_NOT_FOUND', 'requester resolves to no principal', 'requester', 11,
          'the requester is a live principal', { kind });
      }
      if (requester.legacyIdentity) {
        await auditService.record({
          action: 'legacy.refused', actor, outcome: 'denied',
          resourceType: 'principal', resourceId: input.requesterPrincipalId,
          metadata: { act: 'approval.request', kind, reason: 'legacy_identity frozen out (§10, T37)' },
        }).catch(() => undefined);
        throw refuse(409, 'LEGACY_FROZEN', 'legacy identities are frozen out of Approval creation (§10, T37)',
          'requester', 11, 'legacy identities file nothing', { kind });
      }
      if (!requester.parentPrincipalId) {
        throw refuse(422, 'AGENT_PLANE_ONLY',
          'access requests are filed by a Connector or Agent credential (§9.2 agent plane): an Account is keyless and holds what it holds through the owner plane',
          'requester', 9, 'filing is the bearer agent plane', { kind });
      }
      if (kind === 'credential' && requester.kind !== 'service') {
        // clause 13 quotes §6.1's collect contract: "the pack mints at COLLECT by
        // the SAME connector credential that requested". An Agent's credential
        // is the mint's (AZ-28): its Connector asks for it.
        throw refuse(422, 'CREDENTIAL_REQUESTER_NOT_CONNECTOR',
          'a credential request is filed by a Connector for a Connector credential (AZ-A9 clause 13); an Agent credential is requested with relayhall_agent_mint by its Connector',
          'requester', 13, 'a credential request issues ONE Connector credential, collected by the SAME connector credential that requested',
          { kind });
      }
      await this.assertRequesterLiveFor(input.requesterPrincipalId, input.requestingCredentialId, kind);
      const chain = await delegationService.resolveChain(input.requesterPrincipalId);
      const account = chain.links[chain.links.length - 1];
      const granteeId = await this.admissibleGrantee(account, input.granteePrincipalId, kind);
      let rules: ProfileRule[] = [];
      let scopes: string[] = [];
      let transport: string | null = null;
      let label: string | null = null;
      if (kind === 'grant') {
        rules = this.admissibleRules(input.requestedRules, 'requester', kind);
      } else {
        this.admissibleCredentialTarget(input.targetPrincipalId, input.requesterPrincipalId, kind);
        if (input.requestedRules !== undefined && input.requestedRules !== null
          && !(Array.isArray(input.requestedRules) && input.requestedRules.length === 0)) {
          // clause 13 makes bundled grant rows optional; P1-B-2 does not build
          // them (a grant request asks for rows on the same queue).
          throw refuse(422, 'BUNDLED_ROWS_NOT_AVAILABLE',
            'a credential request carries scopes only: ask for grant rows with a separate request of kind grant',
            'requester', 13, 'bundled grant rows on a credential request are declared and not built', { kind });
        }
        scopes = credentialCheck(kind, () => assertConnectorCredentialScopes(input.requestedScopes, 'requester'));
        transport = await this.admissibleTransport(input.requestedTransport, input.requestingCredentialId, kind);
        label = this.admissibleLabel(input.label, kind);
      }
      const reason = this.admissibleReason(input.reason, kind);
      const requestedAt = new Date();
      const expiresAt = this.admissibleRequestedExpiry(input.requestedExpiresAt, requestedAt, kind);
      const related = await this.readableRelation(input, kind);
      // The quota before the coverage walk: it is one query, and the walk is
      // one containment check per requested (object, verb).
      await this.assertRequestQuota(input.requesterPrincipalId, kind);
      if (kind === 'grant') {
        await this.assertNotAlreadyHeld(granteeId, rules, kind);
        // clause 11 at FILING, as a preview: v1's deciders are root or an
        // administrator — the board-wide superset (§5.1) — so the check is
        // clause 5 on the rows a decider would write.
        await this.assertDeciderCeiling(null, rules, kind);
      } else {
        // clause 5 by analogy, clause 13 "ONE Connector credential": a live
        // credential that already carries every scope with a compatible pin
        // makes a second one pointless. The preview of clause 11 is the
        // closures, run above: v1's deciders may delegate every other scope.
        await this.assertCredentialNotAlreadyHeld(pool, input.requesterPrincipalId, scopes, transport as string, kind);
      }
      filed = {
        kind, requesterHandle: requester.handle, granteeId, rules, reason, requestedAt, expiresAt,
        relatedTaskId: related.taskId, relatedPhaseId: related.phaseId, scopes, transport, label,
      };
    } catch (e) {
      await auditRefusal('approval.request', e, actor,
        { type: 'principal', id: UUID_PATTERN.test(input.requesterPrincipalId ?? '') ? input.requesterPrincipalId : null },
        UUID_PATTERN.test(input.requesterPrincipalId ?? '') ? input.requesterPrincipalId : null);
      throw e;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const created = await client.query(
        `INSERT INTO approvals
           (kind, requester_principal_id, requesting_credential_id, grantee_principal_id,
            requested_scopes, requested_rules, requested_expires_at, reason,
            related_task_id, related_phase_id, requested_at, pending_expires_at,
            requested_transport, credential_label)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id`,
        [
          filed.kind, input.requesterPrincipalId, input.requestingCredentialId, filed.granteeId,
          JSON.stringify(filed.scopes), JSON.stringify(filed.rules), filed.expiresAt, filed.reason,
          filed.relatedTaskId, filed.relatedPhaseId, filed.requestedAt,
          new Date(filed.requestedAt.getTime() + APPROVAL_PENDING_TTL_MS),
          filed.transport, filed.label,
        ],
      );
      const approvalId = String(created.rows[0].id);
      const metadata = filed.kind === 'grant'
        ? {
          kind: filed.kind, granteePrincipalId: filed.granteeId, rules: filed.rules,
          requestedExpiresAt: filed.expiresAt.toISOString(),
          relatedTaskId: filed.relatedTaskId, relatedPhaseId: filed.relatedPhaseId,
        }
        : {
          kind: filed.kind, granteePrincipalId: filed.granteeId, targetPrincipalId: input.requesterPrincipalId,
          scopes: filed.scopes, transport: filed.transport, label: filed.label,
          requestedExpiresAt: filed.expiresAt.toISOString(),
          relatedTaskId: filed.relatedTaskId, relatedPhaseId: filed.relatedPhaseId,
        };
      await writeApprovalEvent(client, { approvalId, action: 'approval.requested', actor, metadata });
      await auditService.record({
        action: 'approval.request', actor,
        resourceType: 'approval', resourceId: approvalId,
        metadata: {
          ...metadata,
          requesterPrincipalId: input.requesterPrincipalId,
          requestingCredentialId: input.requestingCredentialId,
          chain: await auditChainFor(client, input.requesterPrincipalId),
        },
      }, client);
      await client.query('COMMIT');
      this.dispatchApprovalNotice(approvalId, input.requesterPrincipalId, filed.requesterHandle, filed.kind);
      return this.get(approvalId);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** E325: FILE a change request (kind change) through ChangeRequestService. */
  private async requestChange(input: AccessRequestInput, actor: AuditActor): Promise<ApprovalRecord> {
    const approvalId = await changeRequests().file({
      requesterPrincipalId: input.requesterPrincipalId,
      requestingCredentialId: input.requestingCredentialId,
      authorizationActor: input.authorizationActor,
      targetType: input.targetType, targetId: input.targetId, change: input.change,
      granteePrincipalId: input.granteePrincipalId, granteeType: input.granteeType,
      reason: input.reason, lifetime: input.lifetime,
      relatedTaskId: input.relatedTaskId, relatedPhaseId: input.relatedPhaseId,
      foreign: {
        requestedRules: input.requestedRules, requestedExpiresAt: input.requestedExpiresAt, requestedScopes: input.requestedScopes,
        requestedTransport: input.requestedTransport, label: input.label, targetPrincipalId: input.targetPrincipalId,
        object: input.object, addScopes: input.addScopes,
      },
    }, actor);
    return this.get(approvalId);
  }

  /**
   * E325 section 9.2: FILE a change request on the SESSION door
   * (`POST /approvals/requests`): a person files as its own Account, with the
   * session's standing (a root session, an administrator login session, or an
   * ordinary user and the owner tier). One pipeline with the bearer door.
   */
  async requestChangeOnSession(input: Omit<ChangeFilingInput, 'door' | 'requestingCredentialId'> & {
    session: NonNullable<ChangeFilingInput['session']>;
  }, actor: AuditActor): Promise<ApprovalRecord> {
    const approvalId = await changeRequests().file({ ...input, door: 'session', requestingCredentialId: null }, actor);
    return this.get(approvalId);
  }

  /** E325 section 4.3: "what may I request here", on either door. Writes nothing. */
  async previewChange(input: ChangePreviewInput): Promise<ChangePreview> {
    return changeRequests().preview(input);
  }

  /**
   * E325 section 5.1 (2), section 12 Q20 (a): the decider of ANY kind is an
   * active, non-legacy Account acting as itself, read when it decides.
   */
  async deciderLive(principalId: string): Promise<boolean> {
    if (!UUID_PATTERN.test(principalId ?? '')) return false;
    const row = (await pool.query(
      'SELECT status, legacy_identity, parent_principal_id FROM principals WHERE id = $1', [principalId])).rows[0];
    return Boolean(row && row.status === 'active' && !row.legacy_identity && !row.parent_principal_id);
  }

  /**
   * Whether this session may see one approval: the SAME self-scope text
   * `list` reads (section 5.6), applied to one id. The route's 404-concealment
   * reads it, so a list and a point read can never disagree.
   */
  async visibleTo(viewer: { principalId: string; isRoot: boolean; isAdministrator?: boolean }, approvalId: string): Promise<boolean> {
    if (!UUID_PATTERN.test(approvalId)) return false;
    const params: unknown[] = [approvalId];
    const scope = approvalSelfScopeCondition(viewer, params, 'a', 0);
    const result = await pool.query(`SELECT 1 FROM approvals a WHERE a.id = $1 AND ${scope ?? 'TRUE'}`, params);
    return result.rows.length > 0;
  }

  /**
   * FILE an edit request (AZ-A13 clause 6c, "the agent's door"): a Connector
   * asks for scopes its OWN presenting credential lacks, and receives them on
   * that credential once a person approves — no new secret, no collect, no
   * change to its harness (clause 7, E69's reconciliation). Filing changes no
   * authority (AZ-A9 clause 2).
   *
   * Refused by name, each with a durable audit: an Agent requester
   * (AGENT_CREDENTIAL_NOT_EDITABLE; AGENT_SCOPE_MINT_ONLY first when it asks
   * for knowledge-contents:write, E149); a warrant or grant object
   * (EDIT_OBJECT_NOT_FILABLE, DD-5); another credential (EDIT_TARGET_NOT_OWN);
   * any transport field (TRANSPORT_NOT_REQUESTABLE, clause 9d); any field of
   * another kind (EDIT_FIELD_NOT_EDITABLE); root, *:admin or an unknown scope;
   * a scope the credential already carries (ALREADY_HELD, naming it); an
   * OAuth, legacy or dead credential (clause 9e); a second pending edit of the
   * same credential (EDIT_PENDING, naming it); the shared quota.
   */
  private async requestAuthorityEdit(input: AccessRequestInput, actor: AuditActor): Promise<ApprovalRecord> {
    const kind = 'authority-edit';
    const credentialId = UUID_PATTERN.test(input.requestingCredentialId ?? '') ? input.requestingCredentialId.toLowerCase() : '';
    let filed: {
      requesterHandle: string; granteeId: string | null; reason: string; relatedTaskId: string | null; relatedPhaseId: string | null;
      before: Record<string, unknown>; requested: Record<string, unknown>; keyId: string | null;
    };
    try {
      const requester = UUID_PATTERN.test(input.requesterPrincipalId ?? '')
        ? await principalService.getPrincipalById(input.requesterPrincipalId)
        : null;
      if (!requester) {
        throw refuse(404, 'REQUESTER_NOT_FOUND', 'requester resolves to no principal', 'requester', 11,
          'the requester is a live principal', { kind });
      }
      if (requester.legacyIdentity) {
        throw refuse(409, 'LEGACY_FROZEN', 'legacy identities are frozen out of Approval creation (§10, T37)',
          'requester', 11, 'legacy identities file nothing', { kind });
      }
      if (!requester.parentPrincipalId) {
        throw refuse(422, 'AGENT_PLANE_ONLY',
          'edit requests are filed by a Connector credential (§9.2 agent plane): an Account edits on its own routes',
          'requester', 9, 'filing is the bearer agent plane', { kind });
      }
      // E149: the agent's door binds edits as the session door does - an Agent
      // asking for knowledge-contents:write is refused by its own name first.
      const mintOnly = agentMintOnlyRefusal(requester.kind, input.addScopes, 'requester');
      if (mintOnly) throw asApprovalEditRefusal(mintOnly);
      if (String(requester.kind) === 'agent') {
        throw editRefusal(422, 'AGENT_CREDENTIAL_NOT_EDITABLE',
          'an Agent credential is never edited (AZ-A13 clause 2): its Connector asks, or the Agent is re-minted',
          'requester', '6c', 'the filer presents a Connector credential');
      }
      const object = input.object;
      const objectType = object && typeof object === 'object' && !Array.isArray(object) ? (object as Record<string, unknown>).type : undefined;
      if (objectType === 'warrant' || objectType === 'grant') {
        throw editRefusal(422, 'EDIT_OBJECT_NOT_FILABLE',
          `a ${objectType} edit is not filed by an agent in v1 (AZ-A13 DD-5): ask for a grant with kind grant, or a person edits it`,
          'requester', '6c', 'an agent files an edit of its own credential\'s scopes only');
      }
      if (objectType !== 'credential') {
        throw editRefusal(422, 'INVALID_ACCESS_REQUEST', "object must be {type: 'credential'}: the credential you present",
          'requester', '6c', 'an edit request names its object');
      }
      const objectKeys = Object.keys(object as Record<string, unknown>).filter((key) => key !== 'type' && key !== 'id');
      if (objectKeys.length > 0) {
        throw editRefusal(422, 'EDIT_FIELD_NOT_EDITABLE', `object carries only type and id (got ${objectKeys.join(', ')})`,
          'requester', '6c', 'the object is {type, id?}', { fields: objectKeys });
      }
      const namedId = (object as Record<string, unknown>).id;
      if (namedId !== undefined && namedId !== null
        && (typeof namedId !== 'string' || namedId.toLowerCase() !== credentialId)) {
        throw editRefusal(403, 'EDIT_TARGET_NOT_OWN',
          'an agent asks only for its OWN presenting credential: the server fills the target in (omit object.id)',
          'requester', '6c', 'the target is the credential the agent presents');
      }
      if (input.requestedTransport !== undefined && input.requestedTransport !== null) {
        throw editRefusal(422, 'TRANSPORT_NOT_REQUESTABLE',
          'a transport pin is never asked for: root or an administrator loosens it with step-up (AZ-A13 clause 9d)',
          'requester', '9d', 'an agent filing carries no transport');
      }
      const foreign = (['requestedScopes', 'requestedRules', 'requestedExpiresAt', 'label', 'targetPrincipalId', 'granteePrincipalId'] as const)
        .filter((field) => input[field] !== undefined && input[field] !== null
          && !(Array.isArray(input[field]) && (input[field] as unknown[]).length === 0));
      if (foreign.length > 0) {
        throw editRefusal(422, 'EDIT_FIELD_NOT_EDITABLE',
          `an edit request carries object, addScopes, reason and the related task or phase only (got ${foreign.join(', ')})`,
          'requester', '6c', 'the edit filing shape is {object, addScopes, reason, relatedTaskId?, relatedPhaseId?}',
          { fields: foreign });
      }
      await this.assertRequesterLiveFor(input.requesterPrincipalId, input.requestingCredentialId, kind);
      const locked = await authorityEditExecutor.lockObject(pool, 'credential', credentialId, false);
      if (!locked) {
        throw editRefusal(409, 'CREDENTIAL_NOT_LIVE', 'the presenting credential resolves to no row', 'requester', '9e',
          'only a live credential is edited');
      }
      const problem = await authorityEditExecutor.editableProblem(pool, locked);
      if (problem) throw editRefusal(problem.status, problem.code, problem.message, 'requester', '9e', problem.refusal.rule);
      const before = locked.state as { scopes: string[]; transport: string };
      if (!Array.isArray(input.addScopes) || input.addScopes.length === 0) {
        throw editRefusal(422, 'SCOPES_REQUIRED', 'addScopes must be a non-empty array of the scopes your credential lacks',
          'requester', '6c', 'addScopes is non-empty');
      }
      const added = credentialCheck(kind, () => assertConnectorCredentialScopes(input.addScopes, 'requester'));
      const held = added.filter((scope) => before.scopes.includes(scope));
      if (held.length > 0) {
        throw refuse(409, 'ALREADY_HELD',
          `your credential already carries ${held.join(', ')}: ask only for the scopes it lacks`,
          'requester', 5, 'a scope the credential already carries is refused by name (AZ-A9 clause 5, AZ-A13 clause 6c)',
          { kind, heldScopes: held });
      }
      const reason = this.admissibleReason(input.reason, kind);
      const related = await this.readableRelation(input, kind, { optional: true });
      const pending = await pool.query(
        `SELECT id FROM approvals WHERE kind = 'authority-edit' AND status = 'pending'
            AND edit_object_type = 'credential' AND edit_object_id = $1`, [credentialId]);
      if (pending.rows.length > 0) {
        throw editRefusal(409, 'EDIT_PENDING',
          `this credential already has a pending edit request: ${pending.rows[0].id}. Withdraw it, or wait for its decision`,
          'requester', '6b', 'one pending edit per object', { pendingApprovalId: String(pending.rows[0].id) });
      }
      await this.assertRequestQuota(input.requesterPrincipalId, kind);
      const chain = await delegationService.resolveChain(input.requesterPrincipalId);
      const account = chain.links[chain.links.length - 1];
      filed = {
        requesterHandle: requester.handle, granteeId: account.principalId, reason,
        relatedTaskId: related.taskId, relatedPhaseId: related.phaseId,
        before: { scopes: [...before.scopes], transport: before.transport, keyId: locked.identity.keyId ?? null },
        requested: { scopes: [...before.scopes, ...added], transport: before.transport, keyId: locked.identity.keyId ?? null },
        keyId: (locked.identity.keyId as string | null) ?? null,
      };
    } catch (e) {
      await auditRefusal('approval.request', e, actor,
        { type: 'principal', id: UUID_PATTERN.test(input.requesterPrincipalId ?? '') ? input.requesterPrincipalId : null },
        UUID_PATTERN.test(input.requesterPrincipalId ?? '') ? input.requesterPrincipalId : null);
      throw e;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let created;
      try {
        created = await client.query(
          `INSERT INTO approvals
             (kind, requester_principal_id, requesting_credential_id, grantee_principal_id,
              requested_scopes, requested_rules, reason, related_task_id, related_phase_id, pending_expires_at,
              edit_object_type, edit_object_id, edit_before, edit_requested)
           VALUES ('authority-edit', $1, $2, $3, '[]'::jsonb, '[]'::jsonb, $4, $5, $6, $7,
                   'credential', $2, $8::jsonb, $9::jsonb)
           RETURNING id`,
          [
            input.requesterPrincipalId, credentialId, filed.granteeId, filed.reason, filed.relatedTaskId, filed.relatedPhaseId,
            new Date(Date.now() + APPROVAL_PENDING_TTL_MS), JSON.stringify(filed.before), JSON.stringify(filed.requested),
          ],
        );
      } catch (e) {
        // Two filings racing on one credential meet at the partial unique
        // index (clause 6b): the loser is refused EDIT_PENDING by name.
        if ((e as { code?: string })?.code === '23505') {
          const refusal = editRefusal(409, 'EDIT_PENDING', 'this credential already has a pending edit request',
            'requester', '6b', 'one pending edit per object');
          await client.query('ROLLBACK').catch(() => undefined);
          await auditRefusal('approval.request', refusal, actor, { type: 'principal', id: input.requesterPrincipalId }, input.requesterPrincipalId);
          throw refusal;
        }
        throw e;
      }
      const approvalId = String(created.rows[0].id);
      const metadata = {
        kind, objectType: 'credential', objectId: credentialId, before: filed.before, after: filed.requested,
        relatedTaskId: filed.relatedTaskId, relatedPhaseId: filed.relatedPhaseId,
      };
      await writeApprovalEvent(client, { approvalId, action: 'approval.requested', actor, metadata });
      await auditService.record({
        action: 'approval.request', actor, resourceType: 'approval', resourceId: approvalId,
        metadata: {
          ...metadata, requesterPrincipalId: input.requesterPrincipalId, requestingCredentialId: credentialId,
          chain: await auditChainFor(client, input.requesterPrincipalId),
        },
      }, client);
      await client.query('COMMIT');
      this.dispatchApprovalNotice(approvalId, input.requesterPrincipalId, filed.requesterHandle, kind,
        `${OBJECT_KIND_LABELS.credential}, credential ${filed.keyId ?? credentialId}`);
      return this.get(approvalId);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** The requester-plane read of ONE own request: 404-concealed for any other
   * principal's item and for agent-mint items (their status read is
   * GET /delegation/agent-mints/:id). */
  async getAccessRequestForRequester(approvalId: string, requesterPrincipalId: string): Promise<ApprovalRecord> {
    const record = await this.get(approvalId);
    if (record.kind === 'agent-mint' || record.requesterPrincipalId !== requesterPrincipalId) {
      throw err(404, 'APPROVAL_NOT_FOUND', 'No such approval');
    }
    return record;
  }

  /** The requester-plane list of the caller's OWN requests: every kind but
   * agent-mint by default; with kindFilter `agent-mint`, its own mint
   * requests (change-request design section 9.1: `status` lists every kind). */
  async listAccessRequestsForRequester(
    requesterPrincipalId: string, statusFilter?: string, kindFilter?: ApprovalKind,
  ): Promise<ApprovalRecord[]> {
    const params: unknown[] = [requesterPrincipalId];
    const clauses = [`a.requester_principal_id = $1`,
      kindFilter === 'agent-mint' ? `COALESCE(a.kind, 'agent-mint') = 'agent-mint'` : `a.kind <> 'agent-mint'`];
    if (statusFilter) {
      params.push(statusFilter);
      clauses.push(`a.status = $${params.length}`);
    }
    if (kindFilter && kindFilter !== 'agent-mint') {
      params.push(kindFilter);
      clauses.push(`a.kind = $${params.length}`);
    }
    const result = await pool.query(
      `${APPROVAL_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY a.requested_at DESC LIMIT 500`, params);
    return result.rows.map(mapApproval);
  }

  /** WITHDRAW (clause 9): the requester lapses its own pending request,
   * reason WITHDRAWN. Foreign and agent-mint items are 404-concealed. */
  async withdrawAccessRequest(input: { approvalId: string; requesterPrincipalId: string }, actor: AuditActor): Promise<ApprovalRecord> {
    if (!UUID_PATTERN.test(input.approvalId ?? '')) throw err(404, 'APPROVAL_NOT_FOUND', 'No such approval');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(`SELECT * FROM approvals WHERE id = $1 FOR UPDATE`, [input.approvalId]);
      const row = locked.rows[0];
      if (!row || !row.kind || row.kind === 'agent-mint' || String(row.requester_principal_id) !== input.requesterPrincipalId) {
        throw err(404, 'APPROVAL_NOT_FOUND', 'No such approval');
      }
      if (row.status !== 'pending') {
        throw refuse(409, 'APPROVAL_NOT_PENDING', `this request is ${row.status}: only a pending request is withdrawn`,
          'requester', 9, 'withdraw lapses a pending request', { kind: String(row.kind) });
      }
      await this.lapse(client, String(row.id), 'WITHDRAWN', actor, String(row.kind));
      await client.query('COMMIT');
      return this.get(String(row.id));
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      await auditRefusal('approval.withdraw', e, actor, { type: 'approval', id: input.approvalId }, input.requesterPrincipalId);
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * The requester-plane view with what became of the authority the request
   * made (E49 delta (a); card 785e1eed P1-B-2). Status stays `approved` or
   * `collected` after clause 12a — both are terminal for their kind — so the
   * view says it in fields of its own: `revokedAt` (the approval.revoked
   * event), each created grant row's state, and the issued credential's own
   * lifecycle. Never the decider's identity or step-up, never a secret column.
   */
  async requesterView(record: ApprovalRecord): Promise<Record<string, unknown>> {
    const view = accessRequestRequesterView(record);
    const fields = record.accessRequest;
    if (!fields) return view;
    const revokedEvents = await pool.query(
      `SELECT occurred_at, metadata FROM approval_events
        WHERE approval_id = $1 AND action = 'approval.revoked' ORDER BY occurred_at DESC, id DESC`,
      [record.id],
    );
    view.revokedAt = revokedEvents.rows.length > 0 ? iso(revokedEvents.rows[0].occurred_at) : null;
    if (record.kind === 'grant') {
      const handedOver = new Set<string>();
      for (const event of revokedEvents.rows) {
        const metadata = parseJson<Record<string, unknown>>(event.metadata, {});
        for (const entry of (Array.isArray(metadata.handedOverGrantIds) ? metadata.handedOverGrantIds : [])) {
          const grantId = typeof entry === 'string' ? entry : (entry as { grantId?: unknown })?.grantId;
          if (grantId) handedOver.add(String(grantId));
        }
      }
      const owned = fields.createdGrantIds.length > 0
        ? await pool.query(
          `SELECT id::text AS id, expires_at FROM grants WHERE id = ANY($1::uuid[]) AND approval_id = $2`,
          [fields.createdGrantIds, record.id])
        : { rows: [] as any[] };
      const live = new Map<string, any>(owned.rows.map((row) => [String(row.id), row]));
      view.createdGrants = fields.createdGrantIds.map((grantId) => {
        const row = live.get(grantId);
        let state: CreatedGrantState;
        if (row) state = !row.expires_at || new Date(row.expires_at).getTime() > Date.now() ? 'live' : 'expired';
        else state = handedOver.has(grantId) ? 'handed-over' : 'revoked';
        return { id: grantId, state, expiresAt: row ? iso(row.expires_at) : null };
      });
    }
    if (record.kind === 'credential') {
      const issued = fields.issuedCredentialId
        ? (await pool.query(
          `SELECT id, key_id, label, scopes, transport, expires_at, revoked_at FROM principal_credentials WHERE id = $1`,
          [fields.issuedCredentialId])).rows[0] ?? null
        : null;
      view.issuedCredential = issued ? {
        id: String(issued.id), keyId: issued.key_id ?? null, label: issued.label ?? null,
        scopes: parseJson<string[]>(issued.scopes, []), transport: issued.transport ?? null,
        expiresAt: iso(issued.expires_at), revokedAt: iso(issued.revoked_at),
      } : null;
    }
    return view;
  }

  /**
   * COLLECT (clause 9's fifth route; clause 13): the requesting Connector
   * consumes its APPROVED credential request and receives the credential, ONCE.
   *
   * §6.1's collect contract, which clause 13 quotes: "the pack mints at COLLECT
   * by the SAME connector credential that requested — single-use, TTL 24h after
   * approval". So: the item must be the caller's own credential request
   * (anything else is answered as absent), presented by the EXACT credential
   * that filed it (404-concealed otherwise, as the mint collect does), approved,
   * and inside its 24-hour collect window and its approved expiry.
   *
   * "COLLECT re-runs every check" (clause 13): the requester and its bound
   * credential are live, the grantee Account is active and the related task or
   * phase is not terminal — a failure there is terminal and LAPSES the request
   * with its clause-14 reason; then the closures, the decider's standing and
   * ceiling NOW, and ALREADY_HELD — a failure there refuses without consuming.
   * It then issues through `executeConnectorCredentialIssue`, the one
   * mechanism, capped by the DECIDER's authority, and records the credential in
   * `issued_credential_id` and the target Connector in `minted_principal_id`.
   *
   * WHY A BEARER ACT ISSUES (clause 2 read with clause 13). Clause 2 says
   * collecting a credential request is credential issuance, a session +
   * step-up act. The authority act is the decider's step-up approval, which
   * fixes the scopes, the pin and the expiry; collect only consumes that
   * single-use authorization and can choose nothing, exactly as §6.1's mint
   * collect does. The secret is returned to the caller and stored nowhere.
   *
   * A grant request has nothing to collect (its rows were written at decide):
   * a typed 409 NOT_COLLECTABLE. Every refusal audits durably.
   */
  async collectAccessRequest(
    input: { approvalId: string; requesterPrincipalId: string; presentingCredentialId: string },
    actor: AuditActor,
  ): Promise<{ record: ApprovalRecord; issued: IssuedConnectorCredential }> {
    // E325 section 7.2(a): an approved credential.issue change is collected by
    // the TARGET Connector, not by the requester; any other caller of a change
    // request is answered as an absent id.
    const changeKind = UUID_PATTERN.test(input.approvalId ?? '')
      ? (await pool.query('SELECT kind FROM approvals WHERE id = $1', [input.approvalId])).rows[0]?.kind : null;
    if (changeKind === 'change') {
      if (!(await changeRequests().isCollectableBy(input.approvalId, input.requesterPrincipalId))) {
        const absent = err(404, 'APPROVAL_NOT_FOUND', 'No such approval');
        await auditRefusal('approval.collect', absent, actor, { type: 'approval', id: input.approvalId }, input.requesterPrincipalId);
        throw absent;
      }
      const collected = await changeRequests().collect({
        approvalId: input.approvalId, presentingPrincipalId: input.requesterPrincipalId, presentingCredentialId: input.presentingCredentialId,
      }, actor);
      return { record: await this.get(collected.approvalId), issued: collected.issued };
    }
    const client = await pool.connect();
    try {
      if (!UUID_PATTERN.test(input.approvalId ?? '')) throw err(404, 'APPROVAL_NOT_FOUND', 'No such approval');
      await client.query('BEGIN');
      const row = (await client.query(`SELECT * FROM approvals WHERE id = $1 FOR UPDATE`, [input.approvalId])).rows[0];
      if (!row || !row.kind || row.kind === 'agent-mint' || String(row.requester_principal_id) !== input.requesterPrincipalId) {
        throw err(404, 'APPROVAL_NOT_FOUND', 'No such approval');
      }
      const kind = String(row.kind);
      const approvalId = String(row.id);
      if (kind !== 'credential') {
        // AZ-A13 clause 7 P-4: collect is credential-only. A grant request's
        // rows and an edit request's edit are written when it is approved.
        throw refuse(409, 'NOT_COLLECTABLE',
          kind === 'grant'
            ? 'a grant request is not collected: its grant rows are written when it is approved (AZ-A9 clause 12)'
            : 'an edit request is not collected: the edit is applied to your credential when it is approved (AZ-A13 clause 6f)',
          'requester', 9, 'collect issues an approved credential request; a grant or edit approval applies at decide',
          { kind, status: String(row.status) });
      }
      // §6.1: the SAME credential that requested. Any other credential of the
      // same Connector is answered exactly as an absent id.
      if (!row.requesting_credential_id || String(row.requesting_credential_id) !== input.presentingCredentialId) {
        throw err(404, 'APPROVAL_NOT_FOUND', 'No such approval');
      }
      if (row.status !== 'approved') {
        throw refuse(409, 'APPROVAL_NOT_COLLECTABLE',
          `this request is ${row.status}: collect consumes an APPROVED credential request exactly once`,
          'requester', 13, 'collect consumes the approved authorization once, by the credential that requested it',
          { kind, status: String(row.status) });
      }
      const requesterId = String(row.requester_principal_id);
      const lapseAndRefuse = async (reason: string, message: string, subject: ApprovalRefusal['subject'], clause: number | string, rule: string): Promise<never> => {
        await this.lapse(client, approvalId, reason, actor, kind);
        await client.query('COMMIT');
        throw refuse(409, 'APPROVAL_LAPSED', message, subject, clause, rule, { kind, lapseReason: reason });
      };
      const now = Date.now();
      if (row.collect_expires_at && new Date(row.collect_expires_at).getTime() <= now) {
        await lapseAndRefuse('COLLECT_TTL_EXPIRED', 'this approval passed its 24-hour collect window and lapsed (§6.1)',
          'requester', 13, 'collect within 24 hours of approval (§6.1 collect contract)');
      }
      if (row.approved_expires_at && new Date(row.approved_expires_at).getTime() <= now) {
        await lapseAndRefuse('PENDING_EXPIRED', 'the approved expiry passed before collect, so the request lapsed PENDING_EXPIRED',
          'requester', 13, 'the credential carries a mandatory future expiry');
      }
      // The terminal re-checks: each LAPSES with its clause-14 reason.
      try {
        await agentMintService.assertRequesterLive(requesterId, String(row.requesting_credential_id));
      } catch (e) {
        if (!(e instanceof AgentMintError)) throw e;
        const reason = lapseReasonForRequester(e.code);
        await lapseAndRefuse(reason, `the requester is no longer live, so the request lapsed ${reason}: ${e.message}`,
          'requester', 11, 'assertRequesterLive runs at filing, decide and collect');
      }
      const grantee = await principalService.getPrincipalById(String(row.grantee_principal_id));
      if (!grantee || grantee.status !== 'active' || grantee.legacyIdentity) {
        await lapseAndRefuse('GRANTEE_DISABLED', 'the grantee Account is no longer active, so the request lapsed GRANTEE_DISABLED',
          'grantee', 4, 'the grantee is an active, non-legacy Account');
      }
      if (row.related_task_id) {
        const task = (await client.query('SELECT status FROM tasks WHERE id = $1', [row.related_task_id])).rows[0];
        if (['completed', 'archived'].includes(String(task?.status))) {
          await lapseAndRefuse('TASK_TERMINAL', `the related task is ${task.status}, so the request lapsed TASK_TERMINAL`,
            'requester', '12a', 'authority attached to a terminal task is never issued');
        }
      } else if (row.related_phase_id) {
        const phase = (await client.query('SELECT status FROM phases WHERE id = $1', [row.related_phase_id])).rows[0];
        if (['completed', 'archived'].includes(String(phase?.status))) {
          await lapseAndRefuse('PHASE_TERMINAL', `the related phase is ${phase.status}, so the request lapsed PHASE_TERMINAL`,
            'requester', '12a', 'authority attached to a terminal phase is never issued');
        }
      }
      // The re-checks that refuse WITHOUT consuming: the closures on the stored
      // approval, the decider's standing and ceiling NOW, and ALREADY_HELD.
      const scopes = credentialCheck(kind, () => assertConnectorCredentialScopes(parseJson<unknown>(row.approved_scopes, null), 'decider'));
      const transport = String(row.approved_transport) as ConnectorCredentialTransport;
      const authority = await this.currentDeciderAuthority(client, row.decided_by_principal_id ? String(row.decided_by_principal_id) : null, kind);
      await this.assertCredentialNotAlreadyHeld(client, requesterId, scopes, transport, kind);

      let issued: IssuedConnectorCredential;
      try {
        issued = await executeConnectorCredentialIssue(client, {
          connectorPrincipalId: requesterId,
          scopes,
          transport,
          expiresAt: new Date(row.approved_expires_at),
          label: row.credential_label ? String(row.credential_label) : `access request ${approvalId.slice(0, 8)}`,
          authority,
          approvalId,
        }, actor);
      } catch (e) {
        throw asApprovalRefusal(e, kind);
      }
      await client.query(
        `UPDATE approvals SET status = 'collected', collected_at = NOW(), minted_principal_id = $2,
                issued_credential_id = $3, updated_at = NOW()
          WHERE id = $1`,
        [approvalId, requesterId, issued.credentialId],
      );
      // The ledger names the credential by id and keyId — never its secret.
      const metadata = {
        kind, issuedCredentialId: issued.credentialId, keyId: issued.keyId, mintedPrincipalId: requesterId,
        scopes: issued.scopes, transport: issued.transport, expiresAt: issued.expiresAt, label: issued.label,
      };
      await writeApprovalEvent(client, { approvalId, action: 'approval.collected', actor, metadata });
      await auditService.record({
        action: 'approval.collect', actor, resourceType: 'approval', resourceId: approvalId,
        metadata: { ...metadata, deciderPrincipalId: authority.principalId, chain: await auditChainFor(client, requesterId) },
      }, client);
      await client.query('COMMIT');
      return { record: await this.get(approvalId), issued };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      await auditRefusal('approval.collect', e, actor,
        { type: 'approval', id: UUID_PATTERN.test(input.approvalId ?? '') ? input.approvalId : null },
        input.requesterPrincipalId);
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * The decider of an approved credential request, NOW (clause 13: "COLLECT
   * re-runs every check"). It must still be an active, non-legacy Account with
   * the standing clause 6 admits — root or an administrator — and the ceiling
   * is what its CURRENT role's scope set may put on a credential. A decider
   * that lost its standing between approve and collect issues nothing.
   */
  private async currentDeciderAuthority(
    queryable: Queryable, deciderId: string | null, kind: string,
  ): Promise<{ principalId: string; standing: 'root' | 'administrator'; scopes: string[] }> {
    const row = deciderId
      ? (await queryable.query('SELECT id, handle, role, status, legacy_identity FROM principals WHERE id = $1', [deciderId])).rows[0]
      : null;
    const role = row ? resolveActorRole({ handle: String(row.handle ?? ''), principalRole: row.role ?? null }) : '';
    if (!row || String(row.status) !== 'active' || row.legacy_identity || !ROLE_ACT_ISSUER_ROLES.includes(role)) {
      throw refuse(403, 'DECIDER_NO_LONGER_ADMITTED',
        'the Account that approved this request no longer holds the standing to decide it, so nothing is issued (AZ-A9 clauses 6 and 13)',
        'decider', 13, "COLLECT re-runs every check, the decider's standing included", { kind });
    }
    const scopes: string[] = scopesForRole(role);
    return { principalId: String(row.id), standing: scopes.includes('root') ? 'root' : 'administrator', scopes };
  }

  /**
   * ALREADY_HELD for a credential request (clause 5 by analogy; clause 13
   * "ONE Connector credential"): a LIVE credential of the Connector — not
   * revoked, not expired, not in rotation grace — that already carries every
   * requested scope under a compatible pin ('any', or the requested one) makes
   * the request pointless, and is refused by name: its id, label and keyId,
   * never a secret column. A request that overlaps a held credential in part
   * is admitted: one credential is one scope set.
   */
  private async assertCredentialNotAlreadyHeld(
    queryable: Queryable, connectorId: string, scopes: string[], transport: string, kind: string,
  ): Promise<void> {
    const held = await queryable.query(
      `SELECT id, label, key_id, scopes, transport, expires_at FROM principal_credentials
        WHERE principal_id = $1 AND revoked_at IS NULL AND grace_until IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY key_id`,
      [connectorId],
    );
    for (const row of held.rows) {
      const carried = parseJson<string[]>(row.scopes, []);
      const covers = carried.includes('root') || scopes.every((scope) => carried.includes(scope));
      const pinCovers = String(row.transport ?? 'any') === 'any' || String(row.transport) === transport;
      if (!covers || !pinCovers) continue;
      throw refuse(409, 'ALREADY_HELD',
        `the Connector already holds ${scopes.join(', ')} on its live credential '${row.label ?? row.key_id}' (key ${row.key_id}): ask only for the scopes it lacks`,
        'requester', 13, 'a live credential that already carries every requested scope under a compatible pin is refused by name',
        {
          kind,
          coveringCredential: {
            credentialId: String(row.id), label: row.label ?? null, keyId: row.key_id ?? null,
            transport: row.transport ?? null, expiresAt: iso(row.expires_at),
          },
        });
    }
  }

  // ── clause 7: what the decider sees ───────────────────────────────────────

  /**
   * Each row as the decider reads it (clauses 5 and 7): the exact objects with
   * their titles, and an all-of-type row as "every current and future object
   * of this type". Titles are resolved for a DECIDER only — root or an
   * administrator session, which see every grant-kind item in full (clause 6).
   * Any other viewer (the requester's own non-administrator Account, which
   * lists its subtree's items) gets the ids: a title is board content its own
   * grants may not reach. One query per object table, whatever the list size.
   */
  async describeAccessRequests(
    records: ApprovalRecord[], viewer: { isRoot: boolean; isAdministrator?: boolean },
  ): Promise<ApprovalRecord[]> {
    const decider = viewer.isRoot || Boolean(viewer.isAdministrator);
    const wanted = new Map<GrantResourceType, Set<string>>();
    for (const record of records) {
      if (!record.accessRequest) continue;
      for (const rule of [...record.requestedRules, ...(record.approvedRules ?? [])]) {
        if (rule.selectorForm !== 'exact') continue;
        const ids = wanted.get(rule.resourceType) ?? new Set<string>();
        for (const id of rule.selectorIds) ids.add(id.toLowerCase());
        wanted.set(rule.resourceType, ids);
      }
    }
    const titles = decider ? await this.objectTitles(wanted) : new Map<string, string>();
    const view = (rules: ProfileRule[]): AccessRequestRuleView[] => rules.map((rule) => ({
      resourceType: rule.resourceType,
      selectorForm: rule.selectorForm,
      verbs: [...rule.verbs],
      objects: rule.selectorForm === 'exact'
        ? rule.selectorIds.map((id) => ({ id, title: titles.get(`${rule.resourceType}:${id.toLowerCase()}`) ?? null }))
        : [],
      allOfType: rule.selectorForm === 'all-of-type' ? ALL_OF_TYPE_LABEL : null,
    }));
    return records.map((record) => (record.accessRequest
      ? {
        ...record,
        accessRequest: {
          ...record.accessRequest,
          ruleViews: view(record.requestedRules),
          approvedRuleViews: record.approvedRules ? view(record.approvedRules) : null,
        },
      }
      : record));
  }

  /** `${type}:${id}` -> the object's title (or name), one query per table. */
  private async objectTitles(wanted: Map<GrantResourceType, Set<string>>): Promise<Map<string, string>> {
    const titles = new Map<string, string>();
    for (const [type, ids] of wanted) {
      const table = OBJECT_TABLES[type];
      const valid = [...ids].filter((id) => UUID_PATTERN.test(id));
      if (!table || valid.length === 0) continue;
      const found = await pool.query(
        `SELECT o.id::text AS id, to_jsonb(o) AS row FROM ${table} o WHERE o.id = ANY($1::uuid[])`, [valid]);
      for (const row of found.rows) {
        const value = row.row ?? {};
        const title = value.title ?? value.name ?? value.display_name ?? value.slug ?? null;
        if (title !== null && title !== undefined) titles.set(`${type}:${String(row.id).toLowerCase()}`, String(title));
      }
    }
    return titles;
  }

  /**
   * AZ-A13 clause 6g — what the decider of an edit request sees, as data: the
   * object, its owning Account and current state, the diff field by field, for
   * a credential the effective result after the edit (credential ∩ own() ∩ the
   * Account's role set) and every identity the change reaches (the live Agents
   * under the Connector), whether the object still equals the snapshot (clause
   * 6e), and the decider's ceiling over the added scopes (clause 8a).
   */
  private async editDecisionBlock(
    record: ApprovalRecord, decider: { principalId: string; isRoot: boolean; isAdministrator?: boolean; scopes?: string[] },
  ): Promise<{ view: Record<string, unknown>; deciderCeiling: Record<string, unknown> }> {
    const edit = record.authorityEdit as AuthorityEditFields;
    const current = await authorityEditExecutor.lockObject(pool, edit.objectType, edit.objectId, false);
    const view: Record<string, unknown> = {
      object: { type: edit.objectType, kind: edit.objectKindLabel, id: edit.objectId },
      before: edit.before, requested: edit.requested, diff: edit.diff,
      current: current ? current.state : null,
      stale: current ? !statesEqualForView(edit.objectType, current.state as unknown as Record<string, unknown>, edit.before) : true,
    };
    let deciderCeiling: Record<string, unknown> = { ok: true };
    if (edit.objectType === 'credential' && current) {
      const requested = parseJson<string[]>(edit.requested.scopes, []);
      const before = parseJson<string[]>(edit.before.scopes, []);
      const added = requested.filter((scope) => !before.includes(scope));
      const connectorId = String(current.holderPrincipalId);
      const reach = await credentialReach(connectorId, [requested]);
      const effectiveAfter = reach.effective[0];
      Object.assign(view, {
        ownerAccount: reach.ownerAccount,
        added,
        effectiveAfterEdit: effectiveAfter,
        inertScopes: requested.filter((scope) => !effectiveAfter.includes(scope)),
        identitiesReached: reach.identitiesReached,
      });
      const { ceiling, exceeding } = issuingCeiling({ scopes: decider.scopes ?? [] }, added);
      deciderCeiling = exceeding.length === 0
        ? { ok: true, delegable: ceiling }
        : { ok: false, code: 'DECIDER_CEILING_EXCEEDED', subject: 'decider', clause: 'AZ-A13 clause 8a', exceeding };
    }
    return { view, deciderCeiling };
  }

  /**
   * clause 7 — "What the decider sees", as DATA beside `GET /approvals/:id`:
   * the requester's chain and requesting credential label; the grantee
   * Account and every identity under it whose own() admits the rows (the
   * honest blast radius); the grantee's current holdings for each requested
   * (object, verb); the related task, phase and project with the project's
   * ownership class; the precomputed clause-11 result for THIS decider; the
   * requester's quota counters; and the pending-TTL countdown. The request's
   * audit trail is the `approval_events` ledger the route returns beside it.
   *
   * Computed for a DECIDER only (root or an administrator session); for any
   * other viewer, and for agent-mint items (clause 16), it is null. Nothing
   * here writes: every check runs in its preview form.
   *
   * A CREDENTIAL request (clause 13) has no rows: its `credential` block
   * carries the target Connector and every live credential it holds (label,
   * scopes, pin, expiry — never a secret column), each requested scope marked
   * held or new, what the Connector could actually exercise after issue (its
   * chain's caps and its Account's role bound it, so a scope beyond them would
   * be carried and inert), what THIS decider may put on a credential (clause
   * 11), the ALREADY_HELD preview, and the statement that the requester's
   * previous credential stays live.
   */
  async accessRequestDecisionContext(
    record: ApprovalRecord,
    decider: { principalId: string; isRoot: boolean; isAdministrator?: boolean; scopes?: string[] },
  ): Promise<Record<string, unknown> | null> {
    const fields = record.accessRequest;
    if (!fields || !(decider.isRoot || decider.isAdministrator)) return null;
    const credentialKind = record.kind === 'credential';

    // The requester, its chain up to its Account, and the credential it filed with.
    const chain = await pool.query(
      `WITH RECURSIVE up AS (
         SELECT p.id, p.handle, p.kind, p.role, p.status, p.parent_principal_id, 0 AS depth
           FROM principals p WHERE p.id = $1
         UNION ALL
         SELECT p.id, p.handle, p.kind, p.role, p.status, p.parent_principal_id, up.depth + 1
           FROM principals p JOIN up ON p.id = up.parent_principal_id
          WHERE up.depth < 4)
       SELECT * FROM up ORDER BY depth`,
      [record.requesterPrincipalId],
    );
    const links = chain.rows.map((row) => ({
      principalId: String(row.id), handle: String(row.handle), kind: String(row.kind),
      role: row.role ?? null, status: String(row.status),
    }));
    const requester = links[0] ?? null;
    // Never a secret column: the label, the keyId, the scopes and the pin.
    const credential = record.requestingCredentialId
      ? (await pool.query(
        `SELECT id, label, key_id, scopes, transport, revoked_at, expires_at FROM principal_credentials WHERE id = $1`,
        [record.requestingCredentialId])).rows[0] ?? null
      : null;

    // The grantee Account, and every identity under it whose own() admits the rows.
    const granteeId = fields.granteePrincipalId;
    const grantee = (await pool.query(
      'SELECT id, handle, kind, role, status FROM principals WHERE id = $1', [granteeId])).rows[0] ?? null;
    const affectedIdentities = credentialKind ? [] : await this.identitiesAdmitting(granteeId, record.requestedRules);

    // The grantee's current holdings, per requested (object, verb), measured
    // with the clause-11 containment function (the ALREADY_HELD measure).
    const holdings: Array<Record<string, unknown>> = [];
    for (const rule of record.requestedRules) {
      const targets: string[][] = rule.selectorForm === 'exact' ? rule.selectorIds.map((id) => [id]) : [[]];
      for (const selectorIds of targets) {
        for (const verb of rule.verbs) {
          const single: ProfileRule = { resourceType: rule.resourceType, selectorForm: rule.selectorForm, selectorIds, verbs: [verb] };
          const held = await this.accountCovers(granteeId, single);
          holdings.push({
            resourceType: rule.resourceType, selectorForm: rule.selectorForm,
            objectId: selectorIds[0] ?? null, verb, held,
            coveringSource: held ? await this.coveringSource(granteeId, single) : null,
          });
        }
      }
    }

    // The related task, phase and project; the project's ownership class.
    const task = fields.relatedTaskId
      ? (await pool.query('SELECT id, title, status, project_id FROM tasks WHERE id = $1', [fields.relatedTaskId])).rows[0] ?? null
      : null;
    const phase = fields.relatedPhaseId
      ? (await pool.query('SELECT id, name, status, project_id FROM phases WHERE id = $1', [fields.relatedPhaseId])).rows[0] ?? null
      : null;
    const projectId = task?.project_id ?? phase?.project_id ?? null;
    let project: Record<string, unknown> | null = null;
    if (projectId) {
      // AZ-A12 clause 12 and D-16 (card a9b1e69c): the owner read gains the
      // kind, and the class is ordered: the OWNER COLUMN decides `group` first
      // (a Group principal owns the Project), and "a Project some Group holds a
      // live grant on" — AZ-A9 clause 7's reading — is the fallback for a
      // Project with a person owner or none; else private.
      const owner = ownerFactsSql('p.owner_principal_id', 'decider_owner');
      const row = (await pool.query(
        `SELECT p.id, p.name, p.owner_principal_id, ${owner.select} FROM projects p ${owner.join} WHERE p.id = $1`,
        [projectId])).rows[0];
      const groups = await pool.query(
        `SELECT DISTINCT g.id, g.name FROM grants gr JOIN groups g ON g.id = gr.grantee_id
          WHERE gr.grantee_type = 'group' AND gr.resource_type = 'project' AND gr.resource_id = $1
            AND (gr.expires_at IS NULL OR gr.expires_at > NOW())
          ORDER BY g.name`,
        [projectId]);
      if (row) {
        const ownerPrincipalId = row.owner_principal_id ? String(row.owner_principal_id) : null;
        const facts = ownerFactsOf(row, ownerPrincipalId);
        const ownedByGroup = facts.ownerKind === 'group' && ownerPrincipalId !== null;
        const granted = groups.rows
          .filter((g) => !(ownedByGroup && String(g.id) === ownerPrincipalId))
          .map((g) => ({ id: String(g.id), name: String(g.name), basis: 'grant' as const }));
        const listed = ownedByGroup
          ? [{ id: ownerPrincipalId as string, name: facts.ownerDisplayName ?? '', basis: 'owner' as const }, ...granted]
          : granted;
        project = {
          id: String(row.id), title: String(row.name),
          ownerPrincipalId, ownerKind: facts.ownerKind, ownerDisplayName: facts.ownerDisplayName,
          ownershipClass: listed.length > 0 ? 'group' : 'private',
          ownershipBasis: ownedByGroup ? 'owner' : granted.length > 0 ? 'grant' : null,
          groups: listed,
        };
      }
    }

    // clause 11, precomputed for THIS decider (preview: nothing written).
    const requesterLive = await agentMintService
      .assertRequesterLive(record.requesterPrincipalId, record.requestingCredentialId)
      .then(() => ({ ok: true }))
      .catch((e) => (e instanceof AgentMintError ? { ok: false, code: e.code, message: e.message } : Promise.reject(e)));
    const credentialBlock = credentialKind ? await this.credentialDecisionBlock(record, decider) : null;
    const editBlock = record.kind === 'authority-edit' ? await this.editDecisionBlock(record, decider) : null;
    const deciderCeiling = editBlock ? editBlock.deciderCeiling : credentialBlock
      ? credentialBlock.deciderCeiling
      : await this.assertDeciderCeiling(decider.principalId, record.approvedRules ?? record.requestedRules, record.kind)
        .then(() => ({ ok: true }))
        .catch((e) => (e instanceof ApprovalError
          ? { ok: false, code: e.code, message: e.message, ...(e.refusal ?? {}) }
          : Promise.reject(e)));
    const quota = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
         COUNT(*) FILTER (WHERE requested_at > NOW() - INTERVAL '24 hours')::int AS daily
       FROM approvals WHERE requester_principal_id = $1
         AND NOT (kind = 'authority-edit' AND COALESCE(session_evidence->>'door', '') = 'one-act')`,
      [record.requesterPrincipalId],
    );

    return {
      kind: record.kind,
      requester: requester ? { ...requester, chain: links } : null,
      requestingCredential: credential ? {
        id: String(credential.id), label: credential.label ?? null, keyId: credential.key_id ?? null,
        scopes: parseJson<string[]>(credential.scopes, []), transport: credential.transport ?? null,
        revoked: Boolean(credential.revoked_at), expiresAt: iso(credential.expires_at),
      } : null,
      grantee: grantee ? {
        principalId: String(grantee.id), handle: String(grantee.handle), kind: String(grantee.kind),
        role: grantee.role ?? null, status: String(grantee.status),
      } : null,
      affectedIdentities,
      rules: (await this.describeAccessRequests([record], decider))[0].accessRequest?.ruleViews ?? [],
      requestedExpiresAt: fields.requestedExpiresAt,
      // UNTRUSTED requester text, rendered only inside the untrusted-data fence.
      reason: fields.reason,
      holdings,
      related: {
        task: task ? { id: String(task.id), title: String(task.title), status: String(task.status) } : null,
        phase: phase ? { id: String(phase.id), name: String(phase.name), status: String(phase.status) } : null,
        project,
      },
      clause11: {
        requesterLive,
        granteeActive: grantee ? String(grantee.status) === 'active' : false,
        deciderCeiling,
        alreadyHeld: credentialBlock ? (credentialBlock.alreadyHeld ? [credentialBlock.alreadyHeld] : []) : holdings.filter((holding) => holding.held),
      },
      ...(credentialBlock ? { credential: credentialBlock.view } : {}),
      ...(editBlock ? { authorityEdit: editBlock.view } : {}),
      quota: {
        pending: Number(quota.rows[0].pending), daily: Number(quota.rows[0].daily),
        quotaPending: APPROVAL_QUOTA_PENDING, quotaDaily: APPROVAL_QUOTA_DAILY,
      },
      pendingTtl: {
        pendingExpiresAt: record.pendingExpiresAt,
        msRemaining: record.status === 'pending' ? Math.max(0, new Date(record.pendingExpiresAt).getTime() - Date.now()) : null,
      },
    };
  }

  /**
   * clause 7 for a CREDENTIAL request (clause 13): what the decider sees about
   * the credential it would authorize. Preview only; never a secret column.
   */
  private async credentialDecisionBlock(
    record: ApprovalRecord, decider: { principalId: string; isRoot: boolean; isAdministrator?: boolean; scopes?: string[] },
  ): Promise<{ view: Record<string, unknown>; deciderCeiling: Record<string, unknown>; alreadyHeld: Record<string, unknown> | null }> {
    const fields = record.accessRequest as AccessRequestFields;
    const targetId = record.requesterPrincipalId;
    const target = (await pool.query('SELECT id, handle, kind, status FROM principals WHERE id = $1', [targetId])).rows[0] ?? null;
    const live = await pool.query(
      `SELECT id, label, key_id, scopes, transport, expires_at FROM principal_credentials
        WHERE principal_id = $1 AND revoked_at IS NULL AND grace_until IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY key_id`,
      [targetId],
    );
    const liveCredentials = live.rows.map((row) => ({
      id: String(row.id), label: row.label ?? null, keyId: row.key_id ?? null,
      scopes: parseJson<string[]>(row.scopes, []), transport: row.transport ?? null, expiresAt: iso(row.expires_at),
      requesting: String(row.id) === record.requestingCredentialId,
    }));
    const requesting = liveCredentials.find((entry) => entry.requesting) ?? null;
    const asked = record.approvedScopes ?? record.requestedScopes;
    const requestedScopes = record.requestedScopes.map((scope) => ({
      scope,
      heldByRequestingCredential: Boolean(requesting?.scopes.includes(scope)),
      heldByAnyLiveCredential: liveCredentials.some((entry) => entry.scopes.includes(scope)),
    }));
    // What the Connector could exercise with the new credential: its chain's
    // own() caps and its Account's role set bound every credential (§5.2 rule
    // 1), so a scope outside them would be carried and inert.
    const effectiveAfterIssue = (await credentialReach(targetId, [asked], { identities: false })).effective[0];
    const { ceiling, exceeding } = issuingCeiling({ scopes: decider.scopes ?? [] }, asked);
    const deciderCeiling = exceeding.length === 0
      ? { ok: true }
      : {
        ok: false, code: 'DECIDER_CEILING_EXCEEDED', subject: 'decider', clause: 'AZ-A9 clause 11',
        rule: "the approved scopes lie within the decider's effective authority", exceeding,
      };
    // The ALREADY_HELD preview answers for a request still to be decided or
    // collected; once collected, its own credential would read as covering it.
    let alreadyHeld: Record<string, unknown> | null = null;
    if (record.status === 'pending' || record.status === 'approved') {
      try {
        await this.assertCredentialNotAlreadyHeld(pool, targetId, asked, String(fields.approvedTransport ?? fields.requestedTransport ?? 'any'), record.kind);
      } catch (e) {
        if (!(e instanceof ApprovalError)) throw e;
        alreadyHeld = { code: e.code, message: e.message, ...(e.refusal ?? {}) };
      }
    }
    return {
      deciderCeiling,
      alreadyHeld,
      view: {
        target: target ? {
          principalId: String(target.id), handle: String(target.handle), kind: String(target.kind), status: String(target.status),
        } : null,
        liveCredentials,
        requestedScopes,
        newScopes: requestedScopes.filter((entry) => !entry.heldByAnyLiveCredential).map((entry) => entry.scope),
        requestedTransport: fields.requestedTransport,
        approvedTransport: fields.approvedTransport,
        label: fields.credentialLabel,
        effectiveAfterIssue,
        inertScopes: asked.filter((scope) => !effectiveAfterIssue.includes(scope)),
        deciderCap: {
          standing: decider.isRoot ? 'root' : 'administrator',
          delegable: ceiling,
          within: asked.filter((scope) => ceiling.includes(scope)),
          exceeding,
        },
        collectExpiresAt: record.collectExpiresAt,
        issuedCredentialId: fields.issuedCredentialId,
        // The ratified text issues ONE credential and keeps rotation human
        // (clauses 13 and 15): approval never retires the requester's key.
        previousCredentialStays: true,
      },
    };
  }

  /**
   * clause 7: "every identity under it whose own() admits the rows" — the
   * grantee Account's live delegated subtree (Connectors, and Agents under
   * them), each with the requested rows its own() caps admit. A delegated
   * identity reaches a row only when EVERY own() cap on its path to the Account
   * admits it (§5.1); no own() expression admits nothing. `admits` is `true`
   * where the containment algebra proves it, and `'possibly'` where a cap's
   * selector (all-except, all-in-project) needs rows the algebra does not read
   * — the blast radius is over-stated there, never under-stated.
   */
  private async identitiesAdmitting(accountId: string, rules: ProfileRule[]): Promise<Array<Record<string, unknown>>> {
    const subtree = await pool.query(
      `WITH RECURSIVE down AS (
         SELECT p.id, p.handle, p.kind, p.status, p.parent_principal_id, p.bound_task_id,
                p.legacy_identity, p.own_expression, 0 AS depth
           FROM principals p WHERE p.id = $1
         UNION ALL
         SELECT p.id, p.handle, p.kind, p.status, p.parent_principal_id, p.bound_task_id,
                p.legacy_identity, p.own_expression, down.depth + 1
           FROM principals p JOIN down ON p.parent_principal_id = down.id
          WHERE down.depth < 3)
       SELECT * FROM down WHERE depth > 0 AND status = 'active' ORDER BY depth, handle LIMIT 500`,
      [accountId],
    );
    const byId = new Map<string, any>(subtree.rows.map((row) => [String(row.id), row]));
    const tuples: ProfileRule[] = [];
    for (const rule of rules) {
      const ids: string[][] = rule.selectorForm === 'exact' ? rule.selectorIds.map((id) => [id]) : [[]];
      for (const selectorIds of ids) {
        for (const verb of rule.verbs) {
          tuples.push({ resourceType: rule.resourceType, selectorForm: rule.selectorForm, selectorIds, verbs: [verb] });
        }
      }
    }
    const capAdmits = (row: any, tuple: ProfileRule): true | 'possibly' | false => {
      let own: { objects: 'parent' | ProfileRule[] } | null = null;
      try {
        own = row.own_expression
          ? (typeof row.own_expression === 'string' ? JSON.parse(row.own_expression) : row.own_expression)
          : null;
      } catch { own = null; }
      if (!own || own.objects === undefined) return false;
      let objects = own.objects;
      // The card c334177b reading: a rule-less Agent's empty list is its bound Task.
      if (objects !== 'parent' && Array.isArray(objects) && objects.length === 0 && row.kind === 'agent'
        && !row.legacy_identity && row.bound_task_id) {
        objects = [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [String(row.bound_task_id)], verbs: ['read', 'write'] }];
      }
      if (objects === 'parent') return true;
      if (!Array.isArray(objects)) return false;
      if (ruleCovered(sourcesFromRules(objects), tuple)) return true;
      return objects.some((rule) => rule.resourceType === tuple.resourceType
        && (rule.selectorForm === 'all-except' || rule.selectorForm === 'all-in-project')) ? 'possibly' : false;
    };
    const identities: Array<Record<string, unknown>> = [];
    for (const row of subtree.rows) {
      const admitted: Array<{ resourceType: string; objectId: string | null; verb: string; admits: true | 'possibly' }> = [];
      for (const tuple of tuples) {
        let verdict: true | 'possibly' | false = true;
        // Walk to the Account. A parent missing from the ACTIVE subtree is a
        // disabled link: the chain below it is dead and admits nothing.
        let link: any = row;
        while (verdict && String(link.id) !== accountId) {
          const step = capAdmits(link, tuple);
          if (step === false) verdict = false;
          else if (step === 'possibly') verdict = 'possibly';
          const parentId = link.parent_principal_id ? String(link.parent_principal_id) : null;
          if (parentId === accountId) break;
          link = parentId ? byId.get(parentId) : undefined;
          if (!link) verdict = false;
        }
        if (verdict) {
          admitted.push({ resourceType: tuple.resourceType, objectId: tuple.selectorIds[0] ?? null, verb: tuple.verbs[0], admits: verdict });
        }
      }
      if (admitted.length > 0) {
        identities.push({
          principalId: String(row.id), handle: String(row.handle), kind: String(row.kind),
          parentPrincipalId: row.parent_principal_id ? String(row.parent_principal_id) : null, admitted,
        });
      }
    }
    return identities;
  }

  /**
   * DECIDE a grant or credential request (clauses 6, 8, 11, 12, 13), on the
   * row `decide` has locked, in its transaction.
   *
   * A GRANT approval writes every approved (row, verb) through
   * `GrantService.create` with the approved expiry, origin manual, provenance
   * NULL and `approval_id` set, and records their ids in `created_grant_ids` —
   * or refuses by name and rolls ALL of it back, the request staying pending.
   *
   * A CREDENTIAL approval records the authorization only (clause 13): the
   * approved scopes, pin and expiry and the 24-hour collect window. Nothing is
   * issued until the requesting credential collects. Deny records the reason.
   */
  private async decideAccessRequest(client: PoolClient, row: any, input: DecideInput, actor: AuditActor): Promise<ApprovalRecord> {
    const approvalId = String(row.id);
    const kind = String(row.kind);
    const requesterId = String(row.requester_principal_id);
    if (kind === 'change') {
      // E325: a change request is decided and applied by its own service, in
      // this transaction, on this locked row, after this decision's step-up.
      // Its ordered predicate (section 5.1) admits root, an administrator login
      // session or the owner tier itself, from the deciding session's facts; a
      // caller that names no session is refused there (fail closed).
      const afterCommit = await changeRequests().decide(client, row, {
        decision: input.decision, deciderPrincipalId: input.deciderPrincipalId,
        viewer: input.deciderViewer ?? { principalId: input.deciderPrincipalId, isRoot: false, administratorOk: false },
        deciderScopes: input.deciderScopes, stepUp: input.stepUp, editedChange: input.editedChange, denialReason: input.denialReason,
        deciderRequest: input.deciderRequest,
      }, actor);
      await client.query('COMMIT');
      // Card 9ce0b0b0 (S4): a decision that changed a principal publishes it to
      // the read caches only now, after its COMMIT.
      if (typeof afterCommit === 'function') afterCommit();
      return this.get(approvalId);
    }
    // clause 6: root, or an administrator login session. The ROUTE admits the
    // decider (APPROVAL_DECIDE_ACT) and says how; a caller that says nothing
    // is refused here too, so no second caller of decide can skip the arm.
    if (input.deciderStanding !== 'root' && input.deciderStanding !== 'administrator') {
      throw refuse(403, APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR,
        'Deciding a grant or credential request requires root or an administrator login session (AZ-A9 clause 6)',
        'decider', 6, 'the decider is root or an administrator login session with a step-up bound to approval.decide',
        { kind });
    }
    // AZ-A13 clause 7 P-4: ONE dispatcher, exhaustive. An edit request carries
    // no requested expiry (migration 148), so it is decided by its own arm
    // BEFORE the requested-expiry check below would read NULL as the epoch.
    if (kind === 'authority-edit') return this.decideAuthorityEdit(client, row, input, actor);
    if (kind !== 'grant' && kind !== 'credential') {
      throw refuse(422, 'KIND_NOT_DECIDABLE', `an approval of kind ${kind} is not decided here`, 'decider', 6,
        'decide dispatches every kind it admits by name', { kind });
    }
    const now = Date.now();
    if (new Date(row.pending_expires_at).getTime() <= now || new Date(row.requested_expires_at).getTime() <= now) {
      // Live enforcement; persist the flip on the way out (the §6.1 shape).
      await this.lapse(client, approvalId, 'PENDING_EXPIRED', actor, kind);
      await client.query('COMMIT');
      throw refuse(409, 'APPROVAL_LAPSED',
        'this request passed its 7-day pending TTL or its own requested expiry, and lapsed PENDING_EXPIRED',
        'decider', 11, 'pending TTL 7 days', { kind });
    }

    if (input.decision === 'deny') {
      const reason = typeof input.denialReason === 'string' ? input.denialReason.slice(0, 500) : null;
      await client.query(
        `UPDATE approvals SET status = 'denied', decided_by_principal_id = $2, decided_at = NOW(),
                decision_step_up = $3::jsonb, denial_reason = $4, updated_at = NOW()
          WHERE id = $1`,
        [approvalId, input.deciderPrincipalId, JSON.stringify(input.stepUp), reason],
      );
      const metadata = { kind, reason, stepUp: input.stepUp, deciderStanding: input.deciderStanding };
      await writeApprovalEvent(client, { approvalId, action: 'approval.denied', actor, metadata });
      await auditService.record({
        action: 'approval.deny', actor, resourceType: 'approval', resourceId: approvalId,
        metadata: { ...metadata, chain: await auditChainFor(client, requesterId) },
      }, client);
      await client.query('COMMIT');
      return this.get(approvalId);
    }

    const decision = kind === 'credential' ? null : this.narrowedDecision(row, input, kind);
    const credentialDecision = kind === 'credential' ? this.narrowedCredentialDecision(row, input, kind) : null;

    // clause 11 at DECIDE: the requester is still live. A requester that is
    // not lapses the request with the clause-14 reason (the T27 shape).
    try {
      await agentMintService.assertRequesterLive(requesterId,
        row.requesting_credential_id ? String(row.requesting_credential_id) : null);
    } catch (e) {
      if (!(e instanceof AgentMintError)) throw e;
      const reason = lapseReasonForRequester(e.code);
      await this.lapse(client, approvalId, reason, actor, kind);
      await client.query('COMMIT');
      throw refuse(409, 'APPROVAL_LAPSED', `the requester is no longer live, so the request lapsed ${reason}: ${e.message}`,
        'requester', 11, 'assertRequesterLive runs at filing and at decide', { kind, lapseReason: reason, cause: e.code });
    }
    const granteeId = String(row.grantee_principal_id);
    const grantee = await principalService.getPrincipalById(granteeId);
    if (!grantee || grantee.status !== 'active' || grantee.legacyIdentity) {
      await this.lapse(client, approvalId, 'GRANTEE_DISABLED', actor, kind);
      await client.query('COMMIT');
      throw refuse(409, 'APPROVAL_LAPSED', 'the grantee Account is no longer active, so the request lapsed GRANTEE_DISABLED',
        'grantee', 4, 'the grantee is an active, non-legacy Account', { kind, lapseReason: 'GRANTEE_DISABLED' });
    }

    if (credentialDecision) {
      return this.approveCredentialRequest(client, row, input, actor, credentialDecision);
    }
    const grantDecision = decision as { rules: ProfileRule[]; expiresAt: Date; edited: boolean };

    // clause 11: the approved rows lie within the DECIDER's effective
    // authority, with the same containment function, on the rows as written.
    await this.assertDeciderCeiling(input.deciderPrincipalId, grantDecision.rules, kind);
    await this.assertObjectsExist(client, grantDecision.rules, kind);
    const written = await this.writeApprovedGrants(client, {
      approvalId, requesterId, granteeId, rules: grantDecision.rules, expiresAt: grantDecision.expiresAt, actor, kind,
    });

    await client.query(
      `UPDATE approvals SET status = 'approved', approved_rules = $2::jsonb, approved_expires_at = $3,
              decided_by_principal_id = $4, decided_at = NOW(), decision_step_up = $5::jsonb,
              created_grant_ids = $6::uuid[], updated_at = NOW()
        WHERE id = $1`,
      [
        approvalId, JSON.stringify(grantDecision.rules), grantDecision.expiresAt, input.deciderPrincipalId,
        JSON.stringify(input.stepUp), written.created,
      ],
    );
    const metadata = {
      kind, approvedRules: grantDecision.rules, approvedExpiresAt: grantDecision.expiresAt.toISOString(),
      edited: grantDecision.edited, createdGrantIds: written.created, replacedExpiredGrantIds: written.replaced,
      stepUp: input.stepUp, deciderStanding: input.deciderStanding,
    };
    await writeApprovalEvent(client, { approvalId, action: 'approval.approved', actor, metadata });
    await auditService.record({
      action: 'approval.approve', actor, resourceType: 'approval', resourceId: approvalId,
      metadata: { ...metadata, chain: await auditChainFor(client, requesterId) },
    }, client);
    await client.query('COMMIT');
    return this.get(approvalId);
  }

  /**
   * DECIDE an edit request (AZ-A13 clauses 6d, 6e, 6j; AZ-A9 clause 6), on the
   * row `decide` locked, in its transaction. Deny records the reason. Approve
   * re-checks the requester (AZ-31c: the target IS the bound credential), then
   * `AuthorityEditExecutor.approveFiled` runs the stale check (a changed object
   * lapses TARGET_CHANGED and refuses EDIT_STALE), the decider's narrowing, the
   * lifetime, the caps, and applies the edit; the row records the approved
   * state and lifetime. Nothing is collected (clause 6f).
   */
  private async decideAuthorityEdit(client: PoolClient, row: any, input: DecideInput, actor: AuditActor): Promise<ApprovalRecord> {
    const approvalId = String(row.id);
    const kind = 'authority-edit';
    const requesterId = String(row.requester_principal_id);
    if (new Date(row.pending_expires_at).getTime() <= Date.now()) {
      await this.lapse(client, approvalId, 'PENDING_EXPIRED', actor, kind);
      await client.query('COMMIT');
      throw refuse(409, 'APPROVAL_LAPSED', 'this request passed its 7-day pending TTL and lapsed PENDING_EXPIRED',
        'decider', 11, 'pending TTL 7 days', { kind });
    }
    if (input.decision === 'deny') {
      const reason = typeof input.denialReason === 'string' ? input.denialReason.slice(0, 500) : null;
      await client.query(
        `UPDATE approvals SET status = 'denied', decided_by_principal_id = $2, decided_at = NOW(),
                decision_step_up = $3::jsonb, denial_reason = $4, updated_at = NOW()
          WHERE id = $1`,
        [approvalId, input.deciderPrincipalId, JSON.stringify(input.stepUp), reason],
      );
      const metadata = {
        kind, objectType: row.edit_object_type, objectId: String(row.edit_object_id),
        before: parseJson(row.edit_before, {}), after: parseJson(row.edit_requested, {}),
        reason, stepUp: input.stepUp, deciderStanding: input.deciderStanding,
      };
      await writeApprovalEvent(client, { approvalId, action: 'approval.denied', actor, metadata });
      await auditService.record({
        action: 'approval.deny', actor, resourceType: 'approval', resourceId: approvalId,
        metadata: { ...metadata, chain: await auditChainFor(client, requesterId) },
      }, client);
      await client.query('COMMIT');
      return this.get(approvalId);
    }
    if (row.requesting_credential_id) {
      try {
        await agentMintService.assertRequesterLive(requesterId, String(row.requesting_credential_id));
      } catch (e) {
        if (!(e instanceof AgentMintError)) throw e;
        const reason = lapseReasonForRequester(e.code);
        await this.lapse(client, approvalId, reason, actor, kind);
        await client.query('COMMIT');
        throw refuse(409, 'APPROVAL_LAPSED', `the requester is no longer live, so the request lapsed ${reason}: ${e.message}`,
          'requester', 11, 'assertRequesterLive runs at filing and at decide', { kind, lapseReason: reason, cause: e.code });
      }
    }
    let applied;
    try {
      applied = await authorityEditExecutor.approveFiled(client, row, {
        deciderPrincipalId: input.deciderPrincipalId,
        deciderStanding: input.deciderStanding as 'root' | 'administrator',
        deciderScopes: input.deciderScopes ?? [],
        stepUp: input.stepUp,
        editedScopes: input.editedScopes,
        editedKind: input.editedKind,
        editedTransport: input.editedTransport,
        editedObject: input.editedObject,
        lifetime: input.lifetime,
      }, actor, (reason) => this.lapse(client, approvalId, reason, actor, kind));
    } catch (e) {
      throw asApprovalEditRefusal(e);
    }
    const ledger = {
      kind, objectType: applied.objectType, objectId: applied.objectId, before: applied.before, after: applied.after,
      lifetime: applied.lifetime, deciderStanding: input.deciderStanding, stepUp: input.stepUp, auditId: applied.auditId,
      edited: JSON.stringify(applied.after.scopes ?? null) !== JSON.stringify(parseJson<Record<string, unknown>>(row.edit_requested, {}).scopes ?? null),
    };
    await writeApprovalEvent(client, { approvalId, action: 'approval.approved', actor, metadata: ledger });
    await auditService.record({
      action: 'approval.approve', actor, resourceType: 'approval', resourceId: approvalId,
      metadata: { ...ledger, chain: await auditChainFor(client, requesterId) },
    }, client);
    await client.query('COMMIT');
    return this.get(approvalId);
  }

  /**
   * APPROVE a credential request (clauses 8, 11, 13), on the locked row: the
   * closures re-run on the scopes as approved; the scopes lie within what THIS
   * decider may put on a credential (clause 11 — the session's scope set,
   * `delegableScopes`); a live credential that already carries them all refuses
   * ALREADY_HELD; and the row records the authorization with a 24-hour collect
   * window. NOTHING is issued here (clause 13: "Approval records the
   * authorization only"). A refusal rolls everything back and the request
   * stays pending.
   */
  private async approveCredentialRequest(
    client: PoolClient, row: any, input: DecideInput, actor: AuditActor,
    decision: { scopes: string[]; expiresAt: Date; transport: ConnectorCredentialTransport; edited: boolean },
  ): Promise<ApprovalRecord> {
    const approvalId = String(row.id);
    const kind = String(row.kind);
    const requesterId = String(row.requester_principal_id);
    const scopes = credentialCheck(kind, () => assertConnectorCredentialScopes(decision.scopes, 'decider'));
    const { exceeding } = issuingCeiling({ scopes: input.deciderScopes ?? [] }, scopes);
    if (exceeding.length > 0) {
      throw refuse(403, 'DECIDER_CEILING_EXCEEDED',
        `the approved scopes exceed what this decider may put on a credential (AZ-A9 clause 11): ${exceeding.join(', ')}`,
        'decider', 11, "the approved scopes lie within the decider's effective authority", { kind, exceeding });
    }
    await this.assertCredentialNotAlreadyHeld(client, requesterId, scopes, decision.transport, kind);
    const collectExpiresAt = new Date(Date.now() + APPROVAL_COLLECT_TTL_MS);
    await client.query(
      `UPDATE approvals SET status = 'approved', approved_scopes = $2::jsonb, approved_expires_at = $3,
              approved_transport = $4, decided_by_principal_id = $5, decided_at = NOW(),
              decision_step_up = $6::jsonb, collect_expires_at = $7, updated_at = NOW()
        WHERE id = $1`,
      [
        approvalId, JSON.stringify(scopes), decision.expiresAt, decision.transport, input.deciderPrincipalId,
        JSON.stringify(input.stepUp), collectExpiresAt,
      ],
    );
    const metadata = {
      kind, approvedScopes: scopes, approvedTransport: decision.transport,
      approvedExpiresAt: decision.expiresAt.toISOString(), collectExpiresAt: collectExpiresAt.toISOString(),
      edited: decision.edited, stepUp: input.stepUp, deciderStanding: input.deciderStanding,
    };
    await writeApprovalEvent(client, { approvalId, action: 'approval.approved', actor, metadata });
    await auditService.record({
      action: 'approval.approve', actor, resourceType: 'approval', resourceId: approvalId,
      metadata: { ...metadata, chain: await auditChainFor(client, requesterId) },
    }, client);
    await client.query('COMMIT');
    return this.get(approvalId);
  }

  /** The EDIT_ONLY_NARROWS refusal of clause 8, naming what was attempted. */
  private narrowsRefusal(kind: string, what: string, detail: Record<string, unknown> = {}): ApprovalError {
    return refuse(422, 'EDIT_ONLY_NARROWS',
      `the decider edits a request DOWN (AZ-A9 clause 8): ${what}`, 'decider', 8,
      kind === 'credential'
        ? 'untick scopes, shorten the expiry, or narrow the pin from any to mcp or api; never add, lengthen, widen, or change the grantee, target or kind'
        : 'untick rows or verbs, shorten the expiry, or replace all-of-type with exact ids; never add, lengthen, or change the grantee or kind',
      { kind, ...detail });
  }

  /** clause 8: the approved expiry is no later than the requested one, and in
   * the future. Shared by both kinds. */
  private narrowedExpiry(row: any, input: DecideInput, kind: string): { expiresAt: Date; edited: boolean } {
    const requestedExpiresAt = new Date(row.requested_expires_at);
    if (input.editedExpiresAt === undefined || input.editedExpiresAt === null) {
      return { expiresAt: requestedExpiresAt, edited: false };
    }
    const parsed = typeof input.editedExpiresAt === 'string' ? new Date(input.editedExpiresAt) : new Date(Number.NaN);
    if (Number.isNaN(parsed.getTime())) {
      throw refuse(422, 'INVALID_EXPIRY', 'editedExpiresAt must be an ISO timestamp', 'decider', 8,
        'the approved expiry is a timestamp', { kind });
    }
    if (parsed.getTime() > requestedExpiresAt.getTime()) {
      throw this.narrowsRefusal(kind, `the approved expiry ${parsed.toISOString()} is later than the requested ${requestedExpiresAt.toISOString()}`,
        { requestedExpiresAt: requestedExpiresAt.toISOString() });
    }
    if (parsed.getTime() <= Date.now()) {
      throw refuse(422, 'INVALID_EXPIRY', 'editedExpiresAt must be in the future', 'decider', 8,
        'the approved expiry is in the future', { kind });
    }
    return { expiresAt: parsed, edited: true };
  }

  /** clause 8: the decider untick rows or verbs, shortens the expiry, or
   * replaces all-of-type with exact ids — never adds, lengthens, or changes
   * the grantee or kind. EDIT_ONLY_NARROWS is the §6.1 algebra the mint
   * edit-down uses (`rulesCovered(sourcesFromRules(requested), approved)`),
   * plus approved_expires_at ≤ requested_expires_at. */
  private narrowedDecision(row: any, input: DecideInput, kind: string): { rules: ProfileRule[]; expiresAt: Date; edited: boolean } {
    const requestedRules = parseJson<ProfileRule[]>(row.requested_rules, []);
    const present = (value: unknown) => value !== undefined && value !== null;
    const narrows = (what: string, detail: Record<string, unknown> = {}) => this.narrowsRefusal(kind, what, detail);
    if (present(input.editedKind) && input.editedKind !== kind) {
      throw narrows(`the kind never changes (it is ${kind})`);
    }
    if (present(input.editedGranteePrincipalId)
      && String(input.editedGranteePrincipalId).toLowerCase() !== String(row.grantee_principal_id).toLowerCase()) {
      throw narrows('the grantee never changes', { granteePrincipalId: String(row.grantee_principal_id) });
    }
    if (present(input.editedScopes) && !(Array.isArray(input.editedScopes) && input.editedScopes.length === 0)) {
      throw narrows('a grant request carries no scopes, so none can be approved');
    }
    if (present(input.editedTransport)) {
      throw narrows('a grant request carries no transport pin');
    }
    let rules = requestedRules;
    let edited = false;
    if (present(input.editedRules)) {
      if (Array.isArray(input.editedRules) && input.editedRules.length === 0) {
        throw refuse(422, 'APPROVAL_WRITES_NOTHING', 'unticking every row writes nothing: deny the request instead',
          'decider', 8, 'an approval writes at least one row', { kind });
      }
      let candidate: ProfileRule[];
      try {
        candidate = validateRules(input.editedRules).map(canonicalRule);
      } catch (e) {
        if (e instanceof AccessProfileError) {
          throw refuse(422, 'INVALID_ACCESS_RULE', e.message, 'decider', 8,
            'each rule is {resourceType, selectorForm, selectorIds, verbs}', { kind });
        }
        throw e;
      }
      const check = rulesCovered(sourcesFromRules(requestedRules), candidate);
      if (!check.covered) {
        throw narrows(`${JSON.stringify(check.failing)} was never requested`,
          { failingRule: check.failing ? namedRule(check.failing) : null });
      }
      rules = candidate;
      edited = true;
    }
    const expiry = this.narrowedExpiry(row, input, kind);
    return { rules, expiresAt: expiry.expiresAt, edited: edited || expiry.edited };
  }

  /** clause 8 for a CREDENTIAL request: untick scopes (never all of them),
   * shorten the expiry, or narrow the pin from `any` to `mcp` or `api` — never
   * add a scope, lengthen the expiry, widen the pin, or change the grantee,
   * kind or rows. The scope algebra is `scopesWithin(requested, approved)`, the
   * mint edit-down's own. */
  private narrowedCredentialDecision(row: any, input: DecideInput, kind: string): {
    scopes: string[]; expiresAt: Date; transport: ConnectorCredentialTransport; edited: boolean;
  } {
    const requestedScopes = parseJson<string[]>(row.requested_scopes, []);
    const requestedTransport = String(row.requested_transport) as ConnectorCredentialTransport;
    const present = (value: unknown) => value !== undefined && value !== null;
    const narrows = (what: string, detail: Record<string, unknown> = {}) => this.narrowsRefusal(kind, what, detail);
    if (present(input.editedKind) && input.editedKind !== kind) {
      throw narrows(`the kind never changes (it is ${kind})`);
    }
    if (present(input.editedGranteePrincipalId)
      && String(input.editedGranteePrincipalId).toLowerCase() !== String(row.grantee_principal_id).toLowerCase()) {
      throw narrows('the grantee never changes', { granteePrincipalId: String(row.grantee_principal_id) });
    }
    if (present(input.editedTargetPrincipalId)
      && String(input.editedTargetPrincipalId).toLowerCase() !== String(row.requester_principal_id).toLowerCase()) {
      throw narrows('the target never changes: the credential is issued on the requesting Connector itself',
        { targetPrincipalId: String(row.requester_principal_id) });
    }
    if (present(input.editedRules) && !(Array.isArray(input.editedRules) && input.editedRules.length === 0)) {
      throw narrows('a credential request carries no rows, so none can be approved');
    }
    let scopes = requestedScopes;
    let edited = false;
    if (present(input.editedScopes)) {
      if (Array.isArray(input.editedScopes) && input.editedScopes.length === 0) {
        throw refuse(422, 'APPROVAL_WRITES_NOTHING', 'unticking every scope issues nothing: deny the request instead',
          'decider', 8, 'an approval issues a credential with at least one scope', { kind });
      }
      const candidate = credentialCheck(kind, () => assertConnectorCredentialScopes(input.editedScopes, 'decider'));
      const check = scopesWithin(requestedScopes, candidate);
      if (!check.within) {
        throw narrows(`${check.exceeding.join(', ')} was never requested`, { exceeding: check.exceeding });
      }
      edited = candidate.length !== requestedScopes.length;
      scopes = candidate;
    }
    let transport = requestedTransport;
    if (present(input.editedTransport)) {
      const pin = String(input.editedTransport);
      if (!TRANSPORTS.includes(pin)) {
        throw refuse(422, 'INVALID_TRANSPORT', "editedTransport must be 'any', 'mcp' or 'api'", 'decider', 8,
          'the transport pin is any, mcp or api', { kind });
      }
      if (pin !== requestedTransport && !(requestedTransport === 'any' && (pin === 'mcp' || pin === 'api'))) {
        throw narrows(`the pin ${pin} is wider than the requested ${requestedTransport}`, { requestedTransport });
      }
      if (pin !== requestedTransport) edited = true;
      transport = pin as ConnectorCredentialTransport;
    }
    const expiry = this.narrowedExpiry(row, input, kind);
    return { scopes, expiresAt: expiry.expiresAt, transport, edited: edited || expiry.edited };
  }

  /**
   * clause 12: write each approved (row, verb) through GrantService.create,
   * inside the decide transaction. The (grantee, type, id, verb) tuple is
   * UNIQUE NULLS NOT DISTINCT (078:54) and expired rows stay until swept, so a
   * tuple that already exists is handled BY NAME before the INSERT: an expired
   * row is replaced here, a live one is refused ALREADY_HELD (clause 5) naming
   * it — never an opaque unique violation.
   *
   * CONCURRENCY. The other writer of principal grant rows on an Account is the
   * assignment vehicle (`AccessVehicleService.ensureGrant`). The existing row is
   * taken FOR UPDATE, and the vehicle takes its target rows NOWAIT, so a
   * vehicle that meets this transaction's row refuses ASSIGNMENT_REFERENCE_BUSY
   * and retries. Two writers racing to INSERT an ABSENT tuple meet at the
   * UNIQUE constraint, and both name the loss: the vehicle maps 23505 to
   * ASSIGNMENT_REFERENCE_BUSY, and this path maps GrantService's GRANT_EXISTS to
   * ALREADY_HELD — the approval rolls back and stays pending.
   */
  private async writeApprovedGrants(client: PoolClient, input: {
    approvalId: string; requesterId: string; granteeId: string; rules: ProfileRule[];
    expiresAt: Date; actor: AuditActor; kind: string;
  }): Promise<{ created: string[]; replaced: string[] }> {
    const created: string[] = [];
    const replaced: string[] = [];
    for (const rule of input.rules) {
      const ids: Array<string | null> = rule.selectorForm === 'all-of-type'
        ? [null] : [...new Set(rule.selectorIds.map((id) => id.toLowerCase()))];
      for (const resourceId of ids) {
        for (const verb of rule.verbs) {
          const tuple: ProfileRule = {
            resourceType: rule.resourceType, selectorForm: resourceId ? 'exact' : 'all-of-type',
            selectorIds: resourceId ? [resourceId] : [], verbs: [verb],
          };
          const existing = await client.query(
            `SELECT id, expires_at, provenance, approval_id FROM grants
              WHERE grantee_type = 'principal' AND grantee_id = $1 AND resource_type = $2
                AND resource_id IS NOT DISTINCT FROM $3 AND verb = $4
              FOR UPDATE`,
            [input.granteeId, rule.resourceType, resourceId, verb],
          );
          let replacedId: string | null = null;
          if (existing.rows.length > 0) {
            const prior = existing.rows[0];
            const live = !prior.expires_at || new Date(prior.expires_at).getTime() > Date.now();
            if (live) {
              throw refuse(409, 'ALREADY_HELD',
                `the grantee Account already holds ${verb} on ${rule.resourceType} ${resourceId ?? '(every object of the type)'} through grant ${prior.id}: untick it and approve the rest (AZ-A9 clause 12)`,
                'grantee', 12, 'a live identical row is refused by name, never as a unique violation',
                {
                  kind: input.kind, failingRule: tuple,
                  coveringSource: {
                    kind: prior.provenance ? 'assignment' : prior.approval_id ? 'approval' : 'grant',
                    grantId: String(prior.id), approvalId: prior.approval_id ? String(prior.approval_id) : null,
                    provenance: prior.provenance ?? null, expiresAt: iso(prior.expires_at),
                  },
                });
            }
            await client.query('DELETE FROM grants WHERE id = $1', [prior.id]);
            replacedId = String(prior.id);
            await auditService.record({
              action: 'grant.revoke', actor: input.actor, resourceType: 'grant', resourceId: replacedId,
              metadata: {
                automatic: true, reason: 'EXPIRED_REPLACED', approvalId: input.approvalId, kind: input.kind,
                granteeId: input.granteeId, resourceType: rule.resourceType, resourceId, verb,
                expiredAt: iso(prior.expires_at),
              },
            }, client);
          }
          let grantId: string;
          try {
            const grant = await grantService.create({
              granteeType: 'principal', granteeId: input.granteeId, resourceType: rule.resourceType,
              resourceId, verb, expiresAt: input.expiresAt.toISOString(),
            }, input.actor, client, { approvalId: input.approvalId, requesterPrincipalId: input.requesterId, kind: 'grant' });
            grantId = grant.id;
          } catch (e) {
            if (e instanceof GrantError && e.code === 'GRANT_EXISTS') {
              throw refuse(409, 'ALREADY_HELD',
                `the grantee Account already holds ${verb} on ${rule.resourceType} ${resourceId ?? '(every object of the type)'} (written concurrently): untick it and approve the rest`,
                'grantee', 12, 'a live identical row is refused by name, never as a unique violation',
                { kind: input.kind, failingRule: tuple });
            }
            if (e instanceof GrantError) {
              throw refuse(e.status, e.code, e.message, 'grantee', 12, 'GrantService.create admits every approved row',
                { kind: input.kind, failingRule: tuple });
            }
            throw e;
          }
          if (replacedId) {
            // A vehicle that linked the expired row links its replacement,
            // which it did NOT create: the approval did. So the link is marked
            // created_by_vehicle FALSE whatever it said of the expired row — a
            // vehicle that had created that row must not reap the approval's
            // replacement when its assignment ends (P1-B review nice-to-have 2).
            await client.query(
              `UPDATE access_vehicle_links SET target_id = $2, created_by_vehicle = FALSE
                WHERE target_kind = 'grant' AND target_id = $1`,
              [replacedId, grantId],
            );
            replaced.push(replacedId);
          }
          created.push(grantId);
        }
      }
    }
    return { created, replaced };
  }

  // ── the AZ-A9 admissibility checks, each refusing by name ─────────────────

  private filableKind(raw: unknown): 'grant' | 'credential' | 'authority-edit' {
    if (raw === 'grant') return 'grant';
    if (raw === 'credential') return 'credential';
    // AZ-A13 clause 6i: filable for a Connector's own credential only; the
    // object is checked by requestAuthorityEdit.
    if (raw === 'authority-edit') return 'authority-edit';
    if (raw === 'agent-mint') {
      throw refuse(422, 'KIND_NOT_FILABLE_HERE',
        'an Agent credential is requested with relayhall_agent_mint at POST /delegation/agent-mints — one tool per noun, and no second door (AZ-A9 clause 10)',
        'requester', 10, 'agent-mint has its own door', { kind: 'agent-mint' });
    }
    throw refuse(422, 'INVALID_ACCESS_REQUEST', 'kind must be one of: grant, credential, authority-edit', 'requester', 10,
      'kind is grant, credential or authority-edit');
  }

  private async assertRequesterLiveFor(requesterId: string, credentialId: string, kind: string): Promise<void> {
    try {
      await agentMintService.assertRequesterLive(requesterId, credentialId);
    } catch (e) {
      if (e instanceof AgentMintError) {
        throw refuse(e.status, e.code, e.message, 'requester', 11,
          'the requester is live: its chain, and the exact credential it files with (AZ-31c)', { kind });
      }
      throw e;
    }
  }

  /** clause 4: the grantee is the requester's chain-root Account, filled by
   * the server. A grant on a Connector or Agent is inert — §5.1 reduces a
   * delegated link's side of the chain to its own() cap
   * (AccessVehicleService.ts:15-25) — so a delegated grantee refuses
   * GRANTEE_INERT; any other principal is not the requester's to name. */
  private async admissibleGrantee(account: ChainLink, requested: unknown, kind: string): Promise<string> {
    const chainRoot = account.principalId;
    if (requested !== undefined && requested !== null && requested !== '') {
      if (typeof requested !== 'string' || !UUID_PATTERN.test(requested)) {
        throw refuse(422, 'GRANTEE_NOT_ADMISSIBLE', 'granteePrincipalId must be your chain-root Account id, or omitted',
          'grantee', 4, "the grantee is the requester's chain-root Account", { kind, chainRootAccountId: chainRoot });
      }
      if (requested.toLowerCase() !== chainRoot.toLowerCase()) {
        const named = await principalService.getPrincipalById(requested);
        if (named?.parentPrincipalId) {
          throw refuse(422, 'GRANTEE_INERT',
            "a grant on a Connector or Agent is inert: §5.1 reduces a delegated link's side of the chain to its own() cap, so the grantee is your chain-root Account (omit granteePrincipalId)",
            'grantee', 4, "the grantee is the requester's chain-root Account; a delegated grantee is inert",
            { kind, chainRootAccountId: chainRoot });
        }
        throw refuse(422, 'GRANTEE_NOT_ADMISSIBLE', 'the grantee is your chain-root Account (omit granteePrincipalId)',
          'grantee', 4, "the grantee is the requester's chain-root Account", { kind, chainRootAccountId: chainRoot });
      }
    }
    // GrantService.ts:352-376 refuses these at the write; refuse them at
    // filing too, so no request sits pending for a grantee nothing can grant.
    if (account.status !== 'active') {
      throw refuse(409, 'GRANTEE_DISABLED', `the grantee Account is ${account.status}`, 'grantee', 4,
        'the grantee is an active Account', { kind });
    }
    if (account.legacyIdentity) {
      throw refuse(409, 'LEGACY_FROZEN', 'legacy identities are frozen out of new grants (§10, T37)', 'grantee', 4,
        'the grantee is a non-legacy Account', { kind });
    }
    return chainRoot;
  }

  /** clause 13: the Connector the credential is for. Slice P1-B-2 builds ONE
   * target, the requesting Connector itself; another existing Connector in the
   * Account's subtree, and a new Connector, are declared and refused by name. */
  private admissibleCredentialTarget(raw: unknown, requesterId: string, kind: string): void {
    if (raw === undefined || raw === null || raw === '') return;
    if (typeof raw === 'string' && UUID_PATTERN.test(raw) && raw.toLowerCase() === requesterId.toLowerCase()) return;
    throw refuse(422, 'TARGET_NOT_AVAILABLE',
      'a credential request issues a credential on the requesting Connector itself: omit targetPrincipalId (another Connector, or a new one, is not available yet)',
      'requester', 13, 'the target is the requesting Connector; another existing Connector or a new Connector is declared and not built',
      { kind });
  }

  /** clause 13: the transport pin, `any`, `mcp` or `api`. Omitted, it is the
   * pin of the credential the request is filed with, so a Connector asking
   * for more scopes keeps the transport it already works over. */
  private async admissibleTransport(raw: unknown, requestingCredentialId: string, kind: string): Promise<string> {
    if (raw === undefined || raw === null || raw === '') {
      const filing = UUID_PATTERN.test(requestingCredentialId ?? '')
        ? (await pool.query('SELECT transport FROM principal_credentials WHERE id = $1', [requestingCredentialId])).rows[0]
        : null;
      const pin = String(filing?.transport ?? 'any');
      return TRANSPORTS.includes(pin) ? pin : 'any';
    }
    if (typeof raw !== 'string' || !TRANSPORTS.includes(raw)) {
      throw refuse(422, 'INVALID_TRANSPORT', "requestedTransport must be 'any', 'mcp' or 'api' (default: the pin of the credential you file with)",
        'requester', 13, 'the transport pin is any, mcp or api', { kind });
    }
    return raw;
  }

  /** clause 13: the issued credential's label, optional, 1-100 characters. */
  private admissibleLabel(raw: unknown, kind: string): string | null {
    if (raw === undefined || raw === null) return null;
    const label = typeof raw === 'string' ? raw.trim() : '';
    const length = [...label].length;
    if (length < 1 || length > CREDENTIAL_LABEL_MAX) {
      throw refuse(422, 'INVALID_LABEL', `label is optional and, when given, 1-${CREDENTIAL_LABEL_MAX} characters`,
        'requester', 13, `the label is 1-${CREDENTIAL_LABEL_MAX} characters`, { kind });
    }
    return label;
  }

  /** clause 3 (shape) and clause 5 (closures) on the requested rows. */
  private admissibleRules(raw: unknown, subject: 'requester' | 'decider', kind: string): ProfileRule[] {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw refuse(422, 'RULES_REQUIRED', 'requestedRules must be a non-empty array of rules', subject, 3,
        'a request names at least one rule', { kind });
    }
    let rules: ProfileRule[];
    try {
      rules = validateRules(raw).map(canonicalRule);
    } catch (e) {
      if (e instanceof AccessProfileError) {
        throw refuse(422, 'INVALID_ACCESS_RULE', e.message, subject, 3,
          'each rule is {resourceType, selectorForm, selectorIds, verbs}', { kind });
      }
      throw e;
    }
    this.assertClause5(rules, subject, kind);
    return rules;
  }

  /** clauses 3 and 5 on validated rows: run at filing, and again at decide on
   * the rows as they will be written (the decider ceiling, below). ONE copy
   * of each closure, so a mutation that drops one is seen by both. */
  private assertClause5(rules: ProfileRule[], subject: 'requester' | 'decider', kind: string): void {
    const seen = new Set<string>();
    for (const rule of rules) {
      const failingRule = namedRule(rule);
      if (!ACCESS_REQUEST_RESOURCE_TYPES.includes(rule.resourceType)) {
        throw refuse(422, 'SURFACE_NOT_ADMISSIBLE',
          `${rule.resourceType} rows are not requestable: the Access-surface closure (AZ-A5 clause 3) stays owner-plane`,
          subject, 5, 'every grant resource type except surface', { kind, failingRule });
      }
      if (rule.verbs.some((verb) => !ACCESS_REQUEST_VERBS.includes(verb))) {
        throw refuse(422, 'ADMIN_VERB_NOT_ADMISSIBLE',
          'the admin verb is never admissible in a request (the grant analogue of §5.2 rules 2-3)',
          subject, 5, 'verbs are drawn from read, write, use, invoke — never admin', { kind, failingRule });
      }
      if (!ACCESS_REQUEST_SELECTOR_FORMS.includes(rule.selectorForm)) {
        throw refuse(422, 'SELECTOR_FORM_NOT_ADMISSIBLE',
          `selectorForm ${rule.selectorForm} is not requestable: use exact ids or all-of-type`,
          subject, 3, 'selectorForm is exact or all-of-type', { kind, failingRule });
      }
      if (seen.has(rule.resourceType)) {
        throw refuse(422, 'ONE_RULE_PER_TYPE', `two rules name ${rule.resourceType}: merge them into one`,
          subject, 3, 'one rule per resource type', { kind, failingRule });
      }
      seen.add(rule.resourceType);
    }
  }

  private admissibleReason(raw: unknown, kind: string): string {
    const reason = typeof raw === 'string' ? raw.trim() : '';
    // Code points, as PostgreSQL's char_length counts them (migration 142).
    const length = [...reason].length;
    if (length < ACCESS_REQUEST_REASON_MIN || length > ACCESS_REQUEST_REASON_MAX) {
      throw refuse(422, 'INVALID_REASON',
        `reason is mandatory, ${ACCESS_REQUEST_REASON_MIN}-${ACCESS_REQUEST_REASON_MAX} characters (got ${length})`,
        'requester', 3, `the reason is ${ACCESS_REQUEST_REASON_MIN}-${ACCESS_REQUEST_REASON_MAX} characters`, { kind });
    }
    return reason;
  }

  private admissibleRequestedExpiry(raw: unknown, requestedAt: Date, kind: string): Date {
    if (raw === undefined || raw === null || raw === '') {
      return new Date(requestedAt.getTime() + ACCESS_REQUEST_DEFAULT_EXPIRY_MS);
    }
    const parsed = typeof raw === 'string' ? new Date(raw) : new Date(Number.NaN);
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= requestedAt.getTime()) {
      throw refuse(422, 'INVALID_EXPIRY', 'requestedExpiresAt must be a future ISO timestamp (default: 14 days)',
        'requester', 3, 'the requested expiry is a future timestamp', { kind });
    }
    if (parsed.getTime() > requestedAt.getTime() + ACCESS_REQUEST_MAX_EXPIRY_MS) {
      throw refuse(422, 'EXPIRY_TOO_LONG', 'requestedExpiresAt is at most 90 days out (E15)', 'requester', 3,
        'the requested expiry is at most 90 days out', { kind, maxExpiresAt: new Date(requestedAt.getTime() + ACCESS_REQUEST_MAX_EXPIRY_MS).toISOString() });
    }
    return parsed;
  }

  /** clause 3: a related task and/or phase, READABLE by the requester — an
   * unreadable one is answered exactly as an absent one (404-conceal). A
   * related object already terminal refuses: clause 12a would revoke at once. */
  private async readableRelation(input: AccessRequestInput, kind: string,
    options: { optional?: boolean } = {}): Promise<{ taskId: string | null; phaseId: string | null }> {
    const id = (value: unknown, field: string): string | null => {
      if (value === undefined || value === null || value === '') return null;
      if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
        throw refuse(422, 'INVALID_ACCESS_REQUEST', `${field} must be a full UUID`, 'requester', 3,
          'related ids are UUIDs', { kind });
      }
      return value.toLowerCase();
    };
    const taskId = id(input.relatedTaskId, 'relatedTaskId');
    const phaseId = id(input.relatedPhaseId, 'relatedPhaseId');
    if (!taskId && !phaseId && options.optional) return { taskId: null, phaseId: null };
    if (!taskId && !phaseId) {
      throw refuse(422, 'RELATED_REQUIRED', 'name the task (relatedTaskId) and/or phase (relatedPhaseId) this request is for',
        'requester', 3, 'at least one of related_task_id and related_phase_id is mandatory', { kind });
    }
    if (taskId) {
      const readable = await authorizationRepository.authorizedIds(input.authorizationActor, 'task', [taskId], 'read');
      if (!readable.has(taskId)) {
        throw refuse(404, 'TASK_NOT_FOUND', 'related task resolves to no row', 'requester', 3,
          'the related task is readable by the requester', { kind });
      }
      const status = await pool.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
      if (['completed', 'archived'].includes(String(status.rows[0]?.status))) {
        throw refuse(409, 'RELATED_TASK_TERMINAL',
          `the related task is ${status.rows[0].status}: authority attached to it would be revoked at once (AZ-A9 clause 12a)`,
          'requester', '12a', 'the related task is not terminal', { kind });
      }
    }
    if (phaseId) {
      const readable = await authorizationRepository.authorizedIds(input.authorizationActor, 'phase', [phaseId], 'read');
      if (!readable.has(phaseId)) {
        throw refuse(404, 'PHASE_NOT_FOUND', 'related phase resolves to no row', 'requester', 3,
          'the related phase is readable by the requester', { kind });
      }
      if (!taskId) {
        const status = await pool.query('SELECT status FROM phases WHERE id = $1', [phaseId]);
        if (['completed', 'archived'].includes(String(status.rows[0]?.status))) {
          throw refuse(409, 'RELATED_PHASE_TERMINAL',
            `the related phase is ${status.rows[0].status}: authority attached to it would be revoked at once (AZ-A9 clause 12a)`,
            'requester', '12a', 'the related phase is not terminal', { kind });
        }
      }
    }
    return { taskId, phaseId };
  }

  /** clause 11: ONE queue and ONE quota across kinds — the per-requester
   * count the mint request uses (5 pending, 20 per day), counting every kind. */
  private async assertRequestQuota(requesterId: string, kind: string): Promise<void> {
    const quota = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
         COUNT(*) FILTER (WHERE requested_at > NOW() - INTERVAL '24 hours')::int AS daily
       FROM approvals WHERE requester_principal_id = $1
         AND NOT (kind = 'authority-edit' AND COALESCE(session_evidence->>'door', '') = 'one-act')`,
      [requesterId],
    );
    const pending = Number(quota.rows[0].pending);
    const daily = Number(quota.rows[0].daily);
    if (pending >= APPROVAL_QUOTA_PENDING || daily >= APPROVAL_QUOTA_DAILY) {
      throw refuse(429, 'REQUEST_QUOTA_EXCEEDED',
        `request quota exceeded (${APPROVAL_QUOTA_PENDING} pending / ${APPROVAL_QUOTA_DAILY} per day, shared by every kind) — excess refuses loudly`,
        'requester', 11, 'one quota across kinds: 5 pending, 20 per day',
        { kind, pending, daily, quotaPending: APPROVAL_QUOTA_PENDING, quotaDaily: APPROVAL_QUOTA_DAILY });
    }
  }

  /** clause 5: a row the grantee Account already covers refuses ALREADY_HELD,
   * naming the covering source. Coverage is measured per (object, verb) with
   * the clause-11 containment function — `assertObjectAuthorityCovers`, the
   * mint ceiling's own function (card 785e1eed P1-C repairs it in place), so a
   * request ceiling and a mint ceiling cannot come to disagree. The Account is
   * what the grant would change, so the Account is what is measured. */
  private async assertNotAlreadyHeld(granteeId: string, rules: ProfileRule[], kind: string): Promise<void> {
    for (const rule of rules) {
      const ids: string[][] = rule.selectorForm === 'exact' ? rule.selectorIds.map((id) => [id]) : [[]];
      for (const selectorIds of ids) {
        for (const verb of rule.verbs) {
          const single: ProfileRule = { resourceType: rule.resourceType, selectorForm: rule.selectorForm, selectorIds, verbs: [verb] };
          if (!(await this.accountCovers(granteeId, single))) continue;
          const coveringSource = await this.coveringSource(granteeId, single);
          throw refuse(409, 'ALREADY_HELD',
            `the grantee Account already holds ${verb} on ${rule.resourceType} ${selectorIds[0] ?? '(every object of the type)'} through ${describeSource(coveringSource)}: drop that row`,
            'grantee', 5, 'a row the grantee Account already covers is refused, naming the covering source',
            { kind, failingRule: namedRule(single), coveringSource });
        }
      }
    }
  }

  private async accountCovers(accountId: string, rule: ProfileRule): Promise<boolean> {
    try {
      await agentMintService.assertObjectAuthorityCovers(accountId, [rule]);
      return true;
    } catch (e) {
      if (e instanceof AgentMintError) return false;
      throw e;
    }
  }

  /** Name WHERE coverage comes from: a grant, a group grant, a profile, a
   * group profile, the administrator role, or — when only an arm the
   * containment function reads live covers it — the Account's live authority. */
  private async coveringSource(accountId: string, rule: ProfileRule): Promise<Record<string, unknown>> {
    const effective = await accessProfileService.effectiveAccess(accountId);
    for (const grant of effective.grants) {
      if (ruleCovered(sourcesFromEffectiveAccess({ grants: [grant], profiles: [] }), rule)) {
        return {
          kind: String(grant.source), grantId: grant.grantId ?? null, groupId: grant.groupId ?? null,
          groupName: grant.groupName ?? null, expiresAt: grant.expiresAt ? iso(grant.expiresAt) : null,
        };
      }
    }
    for (const profile of effective.profiles) {
      if (ruleCovered(sourcesFromEffectiveAccess({ grants: [], profiles: [profile] }), rule)) {
        return {
          kind: String(profile.source), profileId: profile.profileId ?? null, profileName: profile.profileName ?? null,
          versionNumber: profile.versionNumber ?? null, groupId: profile.groupId ?? null, groupName: profile.groupName ?? null,
        };
      }
    }
    const account = await principalService.getPrincipalById(accountId);
    const role = String(account?.role ?? '').toLowerCase();
    if (ROLE_ACT_ISSUER_ROLES.includes(role)) {
      return { kind: 'role', role, principalId: accountId };
    }
    return { kind: 'live-authority', principalId: accountId };
  }

  /** clause 11: the approved rows lie within the decider's effective
   * authority. At FILING (no decider yet) and for v1's deciders — root or an
   * administrator, the board-wide superset (§5.1; AuthorizationService.ts
   * :714-720) — that reduces to clause 5, which runs first on the rows as they
   * will be written; at DECIDE the decider is then measured with the SAME
   * containment function the mint ceiling uses. */
  private async assertDeciderCeiling(deciderPrincipalId: string | null, rules: ProfileRule[], kind: string): Promise<void> {
    this.assertClause5(rules, 'decider', kind);
    if (!deciderPrincipalId) return;
    try {
      await agentMintService.assertObjectAuthorityCovers(deciderPrincipalId, rules);
    } catch (e) {
      if (e instanceof AgentMintError) {
        throw refuse(403, 'DECIDER_CEILING_EXCEEDED',
          `the approved rows exceed the decider's effective authority (AZ-A9 clause 11): ${e.message}`,
          'decider', 11, "the approved rows lie within the decider's effective authority", { kind });
      }
      throw e;
    }
  }

  /** clause 12: an approval writes grant rows only on objects that exist (the
   * decider sees each object's title; an unresolved id is narrowed out). */
  private async assertObjectsExist(client: Queryable, rules: ProfileRule[], kind: string): Promise<void> {
    for (const rule of rules) {
      const table = OBJECT_TABLES[rule.resourceType];
      if (rule.selectorForm !== 'exact' || !table) continue;
      const found = await client.query(`SELECT id::text AS id FROM ${table} WHERE id = ANY($1::uuid[])`, [rule.selectorIds]);
      const have = new Set(found.rows.map((row) => String(row.id)));
      const missing = rule.selectorIds.filter((id) => !have.has(id.toLowerCase()));
      if (missing.length > 0) {
        throw refuse(409, 'OBJECT_NOT_FOUND',
          `the request names ${rule.resourceType} ${missing.join(', ')}, which resolves to no row: untick it and approve the rest`,
          'decider', 12, 'an approval writes rows only on objects that exist', { kind, failingRule: namedRule(rule), missing });
      }
    }
  }

  private async lapse(
    queryable: { query: (t: string, p?: unknown[]) => Promise<{ rows: any[] }> },
    approvalId: string,
    reason: string,
    actor: AuditActor,
    // AZ-A9 clause 14: a non-mint lapse carries its kind; the agent-mint
    // event and audit metadata stay exactly { reason } (clause 16).
    kind: string = 'agent-mint',
  ): Promise<void> {
    const metadata = kind === 'agent-mint' ? { reason } : { reason, kind };
    await queryable.query(
      `UPDATE approvals SET status = 'lapsed', lapse_reason = $2, updated_at = NOW()
        WHERE id = $1 AND status IN ('pending', 'approved')`,
      [approvalId, reason],
    );
    await writeApprovalEvent(queryable, { approvalId, action: 'approval.lapsed', actor, metadata });
    await auditService.record({
      action: 'approval.lapse', actor, resourceType: 'approval', resourceId: approvalId,
      metadata,
    }, queryable as any);
  }

  /** TTL sweep (§6.1): persists pending/collect TTL flips. Decide/collect
   * enforce the TTLs live regardless.
   *
   * AZ-A9 (P1-B review nice-to-have 3): a PENDING grant or credential request
   * whose own requested expiry has passed can never be approved — decide
   * lapses it PENDING_EXPIRED live — so the sweep persists that flip too, and
   * the queue stops offering an item nobody can decide. */
  async sweepTtls(actor: AuditActor = { handle: 'system', authMethod: 'system' }): Promise<number> {
    const due = await pool.query(
      `SELECT id, status, kind FROM approvals
        WHERE (status = 'pending' AND pending_expires_at <= NOW())
           OR (status = 'pending' AND kind <> 'agent-mint' AND requested_expires_at IS NOT NULL
               AND requested_expires_at <= NOW())
           OR (status = 'approved' AND collect_expires_at IS NOT NULL AND collect_expires_at <= NOW())`,
    );
    for (const row of due.rows) {
      await this.lapse(pool, String(row.id), row.status === 'pending' ? 'PENDING_EXPIRED' : 'COLLECT_TTL_EXPIRED', actor,
        row.kind ? String(row.kind) : 'agent-mint')
        .catch((e) => logCaughtWarning('[ApprovalService] TTL sweep lapse failed:', e));
    }
    // AZ-31c: a bound credential that died OUTSIDE the hooked paths (natural
    // expiry above all) still invalidates its outstanding approvals — the
    // sweep persists the flip; decide/collect refuse live regardless.
    const deadBound = await pool.query(
      `SELECT DISTINCT a.requesting_credential_id AS id
         FROM approvals a JOIN principal_credentials c ON c.id = a.requesting_credential_id
        WHERE a.status IN ('pending', 'approved')
          AND (c.revoked_at IS NOT NULL
               OR (c.expires_at IS NOT NULL AND c.expires_at <= NOW())
               OR c.grace_until IS NOT NULL)`,
    );
    if (deadBound.rows.length > 0) {
      await invalidateApprovalsForCredentials(
        pool, deadBound.rows.map((row) => String(row.id)), 'expired', actor,
      ).catch((e) => logCaughtWarning('[ApprovalService] credential-death sweep failed:', e));
    }
    return due.rows.length + deadBound.rows.length;
  }
}

export const approvalService = new ApprovalService();
