// ChangeRequestService.ts — the universal change request, kind `change`
// (design ratified by owner ruling E325 with every section 12 recommendation;
// rulings E308, E309, E310; card 502fb19e, train T1 slice S1; migration 158).
//
// ONE MORE KIND, ONE TYPED TARGET. A change request is an Approval of kind
// `change` naming a target type from the closed vocabulary (utils/changeTargets),
// the object(s) it is about, the Account or Group it is FOR, and one typed
// before/requested pair. Filing changes no authority. A person decides it on
// /approvals with ONE step-up; the decision applies the change inside its own
// transaction through the executor that already performs the direct act, with
// the DECIDER as the standing principal, and stamps applied_at. A two-step
// secret (credential.issue) is approved and then collected by the TARGET
// Connector's own credential. The four existing kinds are untouched: they keep
// their columns, arms, routes, tools and tests (section 2.2).
//
// WHAT S1 BUILDS (section 11, T1 S1): the targets grant.rows (any named Account
// or Group), grant.edit, grant.revoke, credential.scopes on any credential,
// credential.issue for another existing Connector (with collect),
// knowledge.compartment and knowledge.shared_writer. Every other IN target is
// refused TARGET_NOT_AVAILABLE naming the slice that builds it; every OUT
// target TARGET_NOT_REQUESTABLE with its declared rule. Filing has two doors:
// the bearer door (/delegation/access-requests, kind change) and, from slice
// S2, the session door (POST /approvals/requests); both run ONE pipeline, and
// the "what may I request here" preview runs the same pipeline without
// writing anything (section 4.3).
//
// WHAT S4 ADDS (section 11, T2 S4; card 9ce0b0b0): the identity targets.
// identity.role through the lifted role-change seam (PrincipalRoleService),
// identity.create through PrincipalService.createPrincipal, identity.status
// through the ONE account-status seam both doors call (its disable revokes
// the stored login sessions and lapses the requests naming the Account as
// grantee), credential.revoke through revokeCredentialById, and warrant.create,
// warrant.edit, warrant.revoke and warrant.resume through WarrantService and
// AuthorityEditExecutor — every one applied in the decide transaction with the
// DECIDER as the standing principal and the decision's ledger on the act's own
// audit row. Each names its object by targetId and no grantee; the principal it
// changes is section 5.5's case (c) (a warrant's holder case (d)), so neither
// the target Account nor an Account above it ever decides it.
//
// WHAT S5 ADDS (section 11, T2 S5; card 9ce0b0b0): the object targets.
// project.owner and task.account_owner through the transfer acts their direct
// PUTs run (a Group source or target through AZ-A12 build 3's standing test),
// report.account_owner through a NEW small executor, project.default_verifier
// and phase.default_verifier through the lifted default-Verifier seam,
// charter.revision through the Charter approval act (content and approval are
// one act), phase.goal through PhaseService.update, task.roles through
// assignTaskRoles, task.access and phase.access through the two attributed
// access writers (each now with its first audit_events row), and the OPENING
// transition of report.visibility through ReportManager.update. Each names ONE
// object by targetId and no grantee; the principal it puts on the object is a
// field of the change (section 5.5 (d)). Every one is applied in the decide
// transaction with the DECIDER as the acting principal: the executor runs its
// own direct predicate on the decider's own session facts, and the decider's
// live reach on the object (S5_DECIDER_ACTION, section 5.1 (5)) is checked
// before it, so an approval never applies what its decider could not do
// itself. The decision's one step-up is the executor's evidence where the
// direct act takes a step-up (section 5.3). A stale preview never applies:
// the object's state is re-read under its row lock and compared, field by
// field, with what the request was filed against.
//
// STANDING TO ASK (section 4.1, slice S2: `requestStanding`). The tier is
// computed live at filing from the existing evaluator, never stored:
//   - a root session, or an administrator login session (CHANGE_REQUEST_ACT),
//     names any Account or Group and files every built target;
//   - the OWNER TIER: an ordinary user whose live predicate reaches EVERY
//     object of the target through an owner source alone (basis owner,
//     account-owner, group-owner or group-project-owner, evaluated at `write`
//     with the administrator arm suppressed) names any Account or Group for
//     the targets section 4.1 row 3 lists; a grant, profile, role-grant,
//     Task-role or visibility source never confers it (F4), and a target with
//     some objects outside that scope is TARGET_OUT_OF_SCOPE (F2);
//   - an ordinary user otherwise names its own Account only, within its role's
//     ceiling, for the targets section 4.1 row 4 lists;
//   - a bearer's standing is its chain-root Account's tier INTERSECTED with
//     the presenting credential's effective authority (row 5): the owner tier
//     is evaluated on the delegation chain itself, so every own() cap binds
//     it, and a root or administrator Account's Connector names another
//     grantee only for rows its own live authority covers (OWN_CAP_EXCEEDED).
//
// THE POINT-STAGE READ AT FILING (section 4.2 TARGET_NOT_FOUND; section 4.3:
// nothing is disclosed about an object the filer cannot read). Every object a
// filing names is read through the FILER's own live authority with the shared
// predicates, never a copy: an object row (a Project, a related Task or Phase,
// a grant's resource, a knowledge source) by authorizedIds, the rule of
// authorizePoint; a principal-plane object (an Account or Group grantee, a
// credential's holder, a target Connector, a grant's grantee) in the
// DIRECTORY: inside the filer's own Account subtree it is the filer's own,
// outside it the route predicate decides exactly as the GET of that object
// would (authorizeRoute on the scope GET /principals/{id} or /groups/{id}
// requires). An unreadable object is refused with the ABSENT object's own
// refusal, byte for byte, and audited as every filing refusal is. grant.rows
// is the one target whose objects are what is asked for (section 3, section
// 4.1 row 4), so it files on an object the filer cannot read exactly as on an
// absent one: the held-row probe and the before-state read only the objects
// the filer reads, and decide refuses an absent object OBJECT_NOT_FOUND.
//
// WHO DECIDES (section 5.1, the ordered predicate, slice S2): (1) a login
// session (the route's SESSION_ONLY; a stored session where the executor needs
// one); (2) the decider still an active, non-legacy Account acting as itself;
// (3) never the requester's Account, the grantee or a member or steward of a
// Group grantee, the target principal, or a principal the approved change
// names (section 5.5, every case over the decider's subtree); (4) the first
// standing arm that admits — root, an administrator login session (not for the
// root-ceiling targets), the owner tier of section 5.2 read from the child
// rows' stored owner values (`changeDeciderArm`, the ONE function the hub's
// `decidable` also calls); (5) the decider's ceiling; (6) ONE step-up, whose
// consumed token is the executor's evidence (section 5.3). Every refusal runs
// before anything is applied, and its rollback un-consumes the step-up.
import type { PoolClient } from 'pg';
import { pool } from '../db/connection';
import { auditService, type AuditActor } from './AuditService';
import { auditChainFor } from '../utils/auditChain';
import { principalService } from './PrincipalService';
import { authorizationRepository } from './AuthorizationRepository';
import { authorizationService, type AuthorizationActor } from './AuthorizationService';
import { requiredScopeFor, scopesSatisfy } from '../utils/scopeMap';
import { liveStewardRows } from '../utils/liveStewardCondition';
import { GROUP_EDIT_TIER_ACTIONS } from '../utils/groupOwnerCondition';
import { validateRules, AccessProfileError, type ProfileRule } from './AccessProfileService';
import { agentMintService, AgentMintError } from './AgentMintService';
import { delegationService } from './DelegationService';
import { grantService, GrantError, GRANT_RESOURCE_TYPES, type GrantResourceType, type GrantVerb } from './GrantService';
import {
  ApprovalError, approvalService, credentialReach, type ApprovalRefusal, type ApprovalRecord, type IdentityReached,
} from './ApprovalService';
import { APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR, ROLE_ACT_ISSUER_ROLES, isStoredLoginSessionKind } from '../utils/administratorSession';
import { scopesForRole } from '../utils/identityScopes';
import { resolveActorRole } from '../utils/taskAutomationRole';
import {
  assertConnectorCredentialScopes, ConnectorCredentialIssueError, CONNECTOR_CREDENTIAL_TRANSPORTS,
  executeConnectorCredentialIssue, issuingCeiling,
  type ConnectorCredentialTransport, type IssuedConnectorCredential,
} from './ConnectorCredentialIssuance';
import { authorityEditExecutor, AuthorityEditError, statesEqual } from './AuthorityEditExecutor';
import { knowledgeSharedWriterService, resolveSharedWriterSource, SharedWriterError } from './KnowledgeSharedWriterService';
import { lifecycleSelectionFor, lifecycleSelectionMisses } from './KnowledgeLifecycleExporter';
import { assertDecisionEvidence, DecisionEvidenceError } from '../utils/decisionEvidence';
import {
  BUILT_TARGET_TYPES, CHANGE_TARGET_SLICE, MANAGER_TIER_TARGETS, MULTI_OBJECT_TARGETS, OUT_TARGET_TYPES, PERSON_OWNER_ONLY_TARGETS,
  PRINCIPAL_TARGETS, S4_TARGET_TYPES, STORED_SESSION_TARGETS, TWO_STEP_TARGETS, WARRANT_TARGETS,
  changeDecidersRule, changeTargetAdmitsOwnerTier, changeTargetNeedsRootSession, isChangeTargetType, type ChangeTargetType,
} from '../utils/changeTargets';
import { principalRoleService, roleChangeProblem, assignableRole, RoleChangeError } from './PrincipalRoleService';
import { AccountStatusError, accountStatusRefusal } from './PrincipalService';
import { warrantService, WarrantError } from './WarrantService';
import { accessVehicleService } from './AccessVehicleService';
import { EDITABLE_FIELDS, transportMove } from './AuthorityEditExecutor';
import { ELEVATED_ROLES, canAssignRole, validateNewHandle } from '../utils/credentialAuthority';
import { S5_DECIDER_ACTION, S5_OBJECT_TYPE, S5_TARGET_TYPES } from '../utils/changeTargets';
import { validateGoal } from './PhaseService';
import { principalVerifierUsability } from './VerifierUsability';
import type { CreationTransaction } from '../db/creationTransaction';
import crypto from 'crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;
/** E15: "default 14 days, at most 90" — every request-made row expires. */
export const CHANGE_DEFAULT_EXPIRY_MS = 14 * DAY_MS;
export const CHANGE_MAX_EXPIRY_MS = 90 * DAY_MS;
export const CHANGE_PENDING_TTL_MS = 7 * DAY_MS;
export const CHANGE_COLLECT_TTL_MS = DAY_MS;
export const CHANGE_REASON_MIN = 20;
export const CHANGE_REASON_MAX = 2000;
/** One quota across kinds (the AZ-A9 clause 11 counters). */
const QUOTA_PENDING = Number(process.env.RELAYHALL_APPROVAL_QUOTA_PENDING || 5);
const QUOTA_DAILY = Number(process.env.RELAYHALL_APPROVAL_QUOTA_DAILY || 20);
/** clause 5: verbs a request may carry — never admin. */
const REQUESTABLE_VERBS: readonly GrantVerb[] = ['read', 'write', 'use', 'invoke'];
/** clause 5: every grant resource type except surface. */
const REQUESTABLE_RESOURCE_TYPES: readonly GrantResourceType[] = GRANT_RESOURCE_TYPES.filter((type) => type !== 'surface');
/** The object tables an exact grant.rows id resolves against at decide. */
const OBJECT_TABLES: Partial<Record<GrantResourceType, string>> = {
  task: 'tasks', phase: 'phases', project: 'projects', report: 'reports', skill: 'skills',
  personality: 'personalities', service: 'services', blueprint: 'blueprints',
};
/** The fields a change filing carries on the bearer route. */
export const CHANGE_FILING_FIELDS = [
  'kind', 'targetType', 'targetId', 'change', 'granteePrincipalId', 'granteeType', 'reason', 'lifetime',
  'relatedTaskId', 'relatedPhaseId',
] as const;

/** The fields a change filing carries on the session door (POST /approvals/requests). */
export const CHANGE_SESSION_FILING_FIELDS = [
  'kind', 'targetType', 'targetId', 'change', 'granteePrincipalId', 'granteeType', 'reason', 'lifetime',
  'relatedTaskId', 'relatedPhaseId',
] as const;

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };
type Tier = 'root' | 'administrator' | 'user';
type Grantee = { type: 'principal' | 'group'; id: string };
type Subject = ApprovalRefusal['subject'];
/** The two filing doors (section 9.2): a bearer credential, or a login session. */
export type FilingDoor = 'bearer' | 'session';
/** Which tier admitted a filing (section 4.1): the Account's own tier, or the owner tier. */
export type FilingStanding = 'root' | 'administrator' | 'owner' | 'user';
/** The standings that decide a change (section 5.1 (4)); migration 158 binds the same words. */
export type ChangeDeciderStanding = 'root' | 'administrator' | 'owner' | 'group-owner' | 'group-manager';

/** The bases of the evaluator's owner sources (AuthorizationService.sqlCondition), the only ones the owner tier reads (F4). */
const OWNER_SOURCE_BASES: ReadonlySet<string> = new Set([
  'owner', 'account-owner', 'group-owner', 'group-project-owner', 'account-group-owner', 'account-group-project-owner',
]);
/** The object types an owner column reaches (AZ-A12 clause 4; groupOwnerCondition.GROUP_OWNABLE_TYPES). */
const OWNABLE_TYPES: readonly string[] = ['project', 'phase', 'task', 'report'];
/** The scope family of each ownable type, for the scope half of a bearer's intersection (section 4.1 row 5). */
const OWNABLE_FAMILY: Readonly<Record<string, string>> = { project: 'projects', phase: 'phases', task: 'tasks', report: 'reports' };
/** section 5.5: the refusal every self-decision answers, at decide and in the hub. */
const SELF_DECISION_MESSAGE = 'you, or a principal under your Account, are the requester, the grantee or a member of it, the target principal or a principal the change names: another person decides';
const SELF_DECISION_RULE = 'the decider is not the requester, the grantee, the target principal or named by the approved change';
/** The decider standings, weakest last: a mixed item records its weakest arm. */
const STANDING_ORDER: readonly ChangeDeciderStanding[] = ['root', 'administrator', 'owner', 'group-owner', 'group-manager'];

/** The deciding session, as `changeDeciderArm` reads it. */
export interface ChangeDeciderViewer {
  principalId: string;
  isRoot: boolean;
  /** administratorSessionOf(..., APPROVAL_DECIDE_ACT).ok */
  administratorOk: boolean;
  /** The server-derived authentication kind ('session' | 'dashboard_jwt'). */
  authMethod?: string | null;
}

/** What `changeDeciderArm` answers: the first standing arm that admits, or why none does. */
export interface ChangeDeciderArm {
  standing: ChangeDeciderStanding | null;
  refusal: { status: number; code: string; message: string; rule: string } | null;
}

/** One edge of the relationship diff (section 6). */
export interface RelationshipEdge {
  principal: { type: string; id: string };
  object: string;
  action: string;
  before: boolean;
  after: boolean;
  via: string;
  state: 'added' | 'removed' | 'kept';
}

/**
 * What a credential change reaches (section 6: "credential scopes -> the
 * effectiveAfterEdit projection and identitiesReached"), read by
 * `credentialReach`, the projection the legacy edit decision block reads: the
 * Connector, what it could exercise before and after the change, and the
 * live identities under it.
 */
export interface CredentialReach {
  connectorId: string;
  effectiveBefore: string[];
  effectiveAfter: string[];
  identitiesReached: IdentityReached[];
}

/** The before/after view of one change (section 6): a field diff, the relationship edges and a one-line summary. */
export interface ChangeDiff {
  fields: Array<{ field: string; before: unknown; after: unknown }>;
  relationships: RelationshipEdge[];
  summary: string;
}

/** The S1 target types a preview evaluates for an object of each type (section 4.3). */
const PREVIEW_OBJECT_TYPES: readonly string[] = ['task', 'phase', 'project', 'report', 'skill', 'personality', 'service', 'blueprint'];

/**
 * The standing an administrative executor reads. Only grant.rows and
 * knowledge.compartment admit the owner tier (section 5.2), and neither calls
 * one of these executors, so an owner standing reaching one is a defect: it
 * fails closed rather than being read as root or an administrator.
 */
function administrativeStanding(standing: ChangeDeciderStanding): 'root' | 'administrator' {
  if (standing === 'root' || standing === 'administrator') return standing;
  throw refuse(403, APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR, 'this executor is applied by root or an administrator login session only',
    'decider', '5.1', 'an owner-tier decider applies only the targets section 5.2 lists');
}

/** A refusal of the change kind: {code, rule, subject, clause} plus detail, as every request refusal. */
function refuse(
  status: number, code: string, message: string, subject: Subject, section: string, rule: string,
  detail: Record<string, unknown> = {},
): ApprovalError {
  return new ApprovalError(status, code, message,
    { rule, subject, clause: `change requests section ${section}`, kind: 'change', ...detail });
}

/** An executor's or a mechanism's own refusal, re-raised in the request shape with its code. */
function asChangeRefusal(e: unknown, subject: Subject, section: string): unknown {
  if (e instanceof ApprovalError) return e;
  if (e instanceof AuthorityEditError) return new ApprovalError(e.status, e.code, e.message, { kind: 'change', ...e.refusal });
  if (e instanceof ConnectorCredentialIssueError) {
    return new ApprovalError(e.status, e.code, e.message, { rule: e.rule, subject: e.subject, clause: e.clause, kind: 'change', ...e.detail });
  }
  if (e instanceof GrantError || e instanceof SharedWriterError) {
    return refuse(e.status, e.code, e.message, subject, section, 'the executor of the direct act admits the change');
  }
  if (e instanceof DecisionEvidenceError) {
    return refuse(e.status, e.code, e.message, 'decider', '5.3', "the apply accepts the decision's own consumed step-up as its evidence");
  }
  if (e instanceof AgentMintError) {
    return refuse(e.status, e.code, e.message, subject, section, 'the containment function admits the change');
  }
  if (e instanceof RoleChangeError || e instanceof AccountStatusError || e instanceof WarrantError) {
    return refuse(e.status, e.code, e.message, subject, section, 'the executor of the direct act admits the change');
  }
  // Slice S5: the object executors' own named refusals (read by class name, so
  // this module never imports their modules at load).
  if (e instanceof Error && EXECUTOR_REFUSALS.has(e.name)
    && typeof (e as { status?: unknown }).status === 'number' && typeof (e as { code?: unknown }).code === 'string') {
    const named = e as Error & { status: number; code: string };
    return refuse(named.status, named.code, named.message, subject, section, 'the executor of the direct act admits the change');
  }
  return e;
}

/** The refusal classes of the S5 object executors (each carries status and code). */
const EXECUTOR_REFUSALS: ReadonlySet<string> = new Set([
  'ResourceContractError', 'GroupOwnershipTransferError', 'CharterError', 'PhaseError', 'ReportAccountOwnershipError',
  'DefaultVerifierRefusal', 'NotFoundFault', 'ConflictFault', 'InvalidRequestFault', 'AssignmentAccessError', 'RequestFaultError',
]);

/** The report visibility labels every authenticated principal reads (AuthorizationService.visibleToAuthenticated). */
const OPEN_REPORT_VISIBILITY: readonly string[] = ['shared', 'public', 'default'];

/** The executors of the S5 object targets, loaded on first use (each imports much of the board). */
function objectExecutors() {
  /* eslint-disable @typescript-eslint/no-var-requires */
  return {
    projectOwnership: (require('./ProjectOwnershipService') as typeof import('./ProjectOwnershipService')).projectOwnershipService,
    taskAccountOwnership: (require('./TaskAccountOwnershipService') as typeof import('./TaskAccountOwnershipService')).taskAccountOwnershipService,
    reportAccountOwnership: require('./ReportAccountOwnershipService') as typeof import('./ReportAccountOwnershipService'),
    defaultVerifier: require('../routes/defaultVerifierRoute') as typeof import('../routes/defaultVerifierRoute'),
    charter: require('./CharterService') as typeof import('./CharterService'),
    phases: (require('./PhaseService') as typeof import('./PhaseService')).phaseService,
    taskAccess: (require('./TaskAccessService') as typeof import('./TaskAccessService')).taskAccessService,
    reports: (require('./ReportManager') as typeof import('./ReportManager')).reportManager,
    tasks: (require('./TaskManagerDB') as typeof import('./TaskManagerDB')).taskManagerDB,
  };
  /* eslint-enable @typescript-eslint/no-var-requires */
}

/**
 * The rank of a role on the scope ceiling it derives (section 5.4: an
 * identity.role change narrows to a LOWER role, never a higher one): the root
 * sentinel (admin, orchestrator) 4, an operator 3, a writer class 2, a reader
 * 1, anything else 0.
 */
export function roleRank(role: string | null | undefined): number {
  const normalized = String(role ?? '').trim().toLowerCase();
  const scopes = scopesForRole(normalized) as string[];
  if (scopes.includes('root')) return 4;
  if (normalized === 'operator') return 3;
  if (scopes.some((scope) => scope.endsWith(':write'))) return 2;
  if (scopes.some((scope) => scope.endsWith(':read'))) return 1;
  return 0;
}

/** The warrant fields a warrant.create change carries (WarrantService.create's input). */
const WARRANT_CREATE_FIELDS = [
  'name', 'description', 'holderPrincipalId', 'anchors', 'ceilingProfileId', 'ceilingRules', 'ceilingScopes',
  'expiresAt', 'transportPin', 'agentMaxAgeHours', 'maxConcurrent', 'maxTotal',
] as const;
/** The fields a decider may narrow on a warrant change (section 5.4: a narrower ceiling, lower caps, an earlier expiry, a narrower pin). */
const WARRANT_NARROWABLE = ['ceilingScopes', 'maxConcurrent', 'maxTotal', 'expiresAt', 'transportPin'];
/** The account fields an identity.create change carries (POST /principals's body, an Agent excluded). */
const IDENTITY_CREATE_FIELDS = ['kind', 'handle', 'displayName', 'role', 'purpose'] as const;

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') { try { return JSON.parse(value) as T; } catch { return fallback; } }
  return value as T;
};
const iso = (value: unknown): string | null => (value ? new Date(value as string).toISOString() : null);
const present = (value: unknown): boolean => value !== undefined && value !== null && value !== '';
const lower = (id: string): string => id.toLowerCase();
/** JSON with every object's keys sorted: a value read back from a JSONB column
 * (which stores keys in its own order) compares equal to the same value built
 * fresh. The stale check compares by value, never by key order. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
const uniqueSorted = (values: Array<string | null | undefined>): string[] =>
  [...new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0).map(lower))].sort();

/** The filing tier of an Account (section 4.1): root, a non-root administrator, or an ordinary user. */
export function filingTierOf(role: string | null): Tier {
  const normalized = String(role ?? '').trim().toLowerCase();
  if ((scopesForRole(normalized) as string[]).includes('root')) return 'root';
  if (ROLE_ACT_ISSUER_ROLES.includes(normalized)) return 'administrator';
  return 'user';
}

/** The verb ceiling of an ordinary user's role (section 4.1 row 4): a role whose
 * scope set carries no write scope may ask read only; an unknown role nothing. */
function userVerbCeiling(role: string | null): 0 | 1 | 2 {
  const scopes = scopesForRole(role) as string[];
  if (scopes.some((scope) => scope.endsWith(':write'))) return 2;
  if (scopes.some((scope) => scope.endsWith(':read'))) return 1;
  return 0;
}
const verbCeiling = (verb: GrantVerb): 1 | 2 => (verb === 'read' ? 1 : 2);

/** What a filing resolves to before anything is written. */
interface Filing {
  targetType: ChangeTargetType;
  targetId: string | null;
  targetObjects: Array<{ type: string; id: string | null }> | null;
  grantee: Grantee | null;
  before: Record<string, unknown>;
  requested: Record<string, unknown>;
  objects: Array<{ objectId: string; ownerIds: string[] }>;
  scope: { projectIds: string[]; reportIds: string[]; groupIds: string[] };
  lifetime: Record<string, unknown> | null;
  /** A short subject for the endpoint notice. */
  subject: string;
  /** grant.rows only: the named objects the filer cannot read (absent or
   * unreadable, never told apart), kept OUT of the requester view. */
  unreadByFiler?: string[];
}

/** What the filing pipeline resolved, before anything is written. */
interface EvaluatedFiling {
  filing: Filing;
  related: { taskId: string | null; phaseId: string | null };
  reason: string;
  requesterHandle: string;
  accountId: string;
  door: FilingDoor;
  standing: FilingStanding;
  tier: Tier;
}

/** The standing callback a resolver calls once it has located the target's objects, before any held-row probe. */
type StandingCheck = (located: { objects: Array<{ objectId: string; ownerIds: string[] }>; rules?: ProfileRule[]; operation?: string }) => Promise<FilingStanding>;

export interface ChangeFilingInput {
  requesterPrincipalId: string;
  /** The bearer door's presenting credential; null on the session door. */
  requestingCredentialId: string | null;
  authorizationActor: AuthorizationActor;
  /** Which door files (default bearer). */
  door?: FilingDoor;
  /** The session door's standing: a root session, an administrator login
   * session (CHANGE_REQUEST_ACT), and the server-derived authentication kind. */
  session?: { isRoot: boolean; administratorOk: boolean; authMethod: string | null };
  targetType?: unknown;
  targetId?: unknown;
  change?: unknown;
  granteePrincipalId?: unknown;
  granteeType?: unknown;
  reason?: unknown;
  lifetime?: unknown;
  relatedTaskId?: unknown;
  relatedPhaseId?: unknown;
  /** Legacy-kind fields a change filing never carries, present only to be refused by name. */
  foreign?: Record<string, unknown>;
}

/** The preview's question (section 4.3): a target type, or an object, with an optional grantee and knowledge source. */
export interface ChangePreviewInput {
  requesterPrincipalId: string;
  requestingCredentialId: string | null;
  authorizationActor: AuthorizationActor;
  door: FilingDoor;
  session?: ChangeFilingInput['session'];
  targetType?: unknown;
  targetId?: unknown;
  objectType?: unknown;
  sourceId?: unknown;
  granteePrincipalId?: unknown;
  granteeType?: unknown;
}

/** The preview's answer (section 4.3). */
export interface ChangePreview {
  requestable: Array<{
    targetType: string;
    grantees: 'self' | 'any' | 'none';
    fields: string[];
    bound: Record<string, unknown>;
    deciders: Array<{ standing: string; rule: string }>;
    before: unknown;
  }>;
  refused: Array<{ targetType: string; code: string; hint?: string }>;
}

export interface ChangeDecideInput {
  decision: 'approve' | 'deny';
  deciderPrincipalId: string;
  /** The deciding session: the ordered predicate of section 5.1 reads it on the locked row. */
  viewer?: ChangeDeciderViewer;
  deciderScopes?: string[];
  stepUp: { tokenId: string; method: string };
  editedChange?: unknown;
  denialReason?: unknown;
  /** Slice S5: the deciding session's own facts, which an object target's executor runs its direct predicate on. */
  deciderRequest?: ChangeDeciderRequest;
}

/**
 * The deciding session's own facts (slice S5), every field server-derived by
 * the decide route: the object executors run their DIRECT predicate on these
 * (the person owner on a stored session, an object administrator, root), so a
 * decision applies only what this session could do on the direct door.
 */
export interface ChangeDeciderRequest {
  authorization: AuthorizationActor;
  principalId: string | null;
  handle: string;
  authMethod?: string;
  principalRole: string | null;
  sessionRole: string | null;
  scopes: string[];
  sessionId: string | null;
  credentialId: string | null;
}

/** The record fields of kind change (ApprovalService.mapApproval reads them). */
export interface ChangeFields {
  targetType: string;
  targetId: string | null;
  targetObjects: Array<{ type: string; id: string | null }> | null;
  granteeType: 'principal' | 'group' | null;
  granteePrincipalId: string | null;
  granteeHandle: string | null;
  /** UNTRUSTED requester text: render it only inside the untrusted-data fence. */
  reason: string;
  spec: { type: string; before: Record<string, unknown>; requested: Record<string, unknown>; approved: Record<string, unknown> | null; diff: unknown };
  requestedLifetime: Record<string, unknown> | null;
  revertAt: string | null;
  revertedAt: string | null;
  appliedAt: string | null;
  appliedEffect: Record<string, unknown> | null;
  deciderStanding: string | null;
  scopeProjectIds: string[];
  scopeReportIds: string[];
  scopeGroupIds: string[];
  relatedTaskId: string | null;
  relatedPhaseId: string | null;
}

export function mapChangeFields(row: any): ChangeFields {
  const spec = parseJson<Record<string, any>>(row.change_spec, {});
  const array = (value: unknown): string[] => (Array.isArray(value) ? value.map(String)
    : typeof value === 'string' && value.startsWith('{') ? value.slice(1, -1).split(',').filter(Boolean) : []);
  return {
    targetType: String(row.target_type),
    targetId: row.target_id ? String(row.target_id) : null,
    targetObjects: parseJson<Array<{ type: string; id: string | null }> | null>(row.target_objects, null),
    granteeType: row.grantee_type ?? null,
    granteePrincipalId: row.grantee_principal_id ? String(row.grantee_principal_id) : null,
    granteeHandle: row.grantee_handle ? String(row.grantee_handle) : null,
    reason: String(row.reason ?? ''),
    spec: {
      type: String(spec.type ?? row.target_type), before: spec.before ?? {}, requested: spec.requested ?? {},
      approved: spec.approved ?? null, diff: spec.diff ?? null,
    },
    requestedLifetime: parseJson<Record<string, unknown> | null>(row.requested_lifetime, null),
    revertAt: iso(row.revert_at),
    revertedAt: iso(row.reverted_at),
    appliedAt: iso(row.applied_at),
    appliedEffect: parseJson<Record<string, unknown> | null>(row.applied_effect, null),
    deciderStanding: row.decider_standing ?? null,
    scopeProjectIds: array(row.scope_project_ids),
    scopeReportIds: array(row.scope_report_ids),
    scopeGroupIds: array(row.scope_group_ids),
    relatedTaskId: row.related_task_id ? String(row.related_task_id) : null,
    relatedPhaseId: row.related_phase_id ? String(row.related_phase_id) : null,
  };
}

/** The requester-plane view of a change: its lifecycle and what was applied — never the decider. */
export function changeRequesterView(fields: ChangeFields): Record<string, unknown> {
  return {
    targetType: fields.targetType, targetId: fields.targetId, targetObjects: fields.targetObjects,
    granteeType: fields.granteeType, granteePrincipalId: fields.granteePrincipalId,
    before: fields.spec.before, requested: fields.spec.requested, approved: fields.spec.approved,
    // section 6: the requester's status read carries the FIELD diff only.
    diff: fields.spec.diff && typeof fields.spec.diff === 'object' && Array.isArray((fields.spec.diff as { fields?: unknown }).fields)
      ? { fields: (fields.spec.diff as { fields: unknown[] }).fields } : null,
    requestedLifetime: fields.requestedLifetime, revertAt: fields.revertAt, revertedAt: fields.revertedAt,
    appliedAt: fields.appliedAt, applied: fields.appliedEffect,
    relatedTaskId: fields.relatedTaskId, relatedPhaseId: fields.relatedPhaseId,
  };
}

/** A field diff between two plain states, for the decision record (section 6). */
function fieldDiff(before: Record<string, unknown>, after: Record<string, unknown>): Array<{ field: string; before: unknown; after: unknown }> {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return fields.filter((field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null))
    .map((field) => ({ field, before: before[field] ?? null, after: after[field] ?? null }));
}

/**
 * THE RELATIONSHIP DIFF (section 6): the edges a change adds, removes or keeps,
 * computed by a per-target projection from the stored before-state and the
 * approved (or, while pending, the requested) spec — never by a dry run. One
 * edge is `{principal, object, action, before, after, via, state}`; the
 * summary is one line ("1 principal gains read on 2 objects; nothing is
 * removed"). The map rendering of the same JSON is a declared dependency
 * (section 14 R1). A credential change also carries what it REACHES, read by
 * `credentialReach` (`reach`): the Connector's effective scopes before and
 * after (via `effectiveAfterEdit`, or `effectiveAfterIssue` for a new
 * credential), and, for credential.scopes, one edge per live identity under
 * it (via `identitiesReached`).
 */
export function relationshipsOf(targetType: string, before: Record<string, any>, spec: Record<string, any>,
  grantee: Grantee | null, targetId: string | null, reach: CredentialReach | null = null): RelationshipEdge[] {
  const edges: RelationshipEdge[] = [];
  const edge = (principal: { type: string; id: string }, object: string, action: string, had: boolean, has: boolean, via: string): void => {
    edges.push({ principal, object, action, before: had, after: has, via, state: had && has ? 'kept' : has ? 'added' : 'removed' });
  };
  if (targetType === 'grant.rows' && grantee) {
    const held = new Set((Array.isArray(before.rows) ? before.rows : [])
      .map((r: any) => `${r.resourceType}:${r.resourceId ? lower(String(r.resourceId)) : '*'}:${r.verb}`));
    for (const rule of (Array.isArray(spec.rules) ? spec.rules : []) as ProfileRule[]) {
      const ids: Array<string | null> = rule.selectorForm === 'all-of-type' ? [null] : rule.selectorIds;
      for (const id of ids) {
        for (const verb of rule.verbs) {
          const object = `${rule.resourceType}:${id ? lower(id) : '*'}`;
          edge(grantee, object, verb, held.has(`${object}:${verb}`), true, 'grant');
        }
      }
    }
  } else if ((targetType === 'grant.edit' || targetType === 'grant.revoke') && before.grant) {
    const g = before.grant;
    const principal = { type: String(g.granteeType), id: String(g.granteeId) };
    const object = `${g.resourceType}:${g.resourceId ? lower(String(g.resourceId)) : '*'}`;
    if (targetType === 'grant.revoke') {
      edge(principal, object, String(g.verb), true, false, 'grant');
    } else {
      const verb = spec.verb === undefined ? String(g.verb) : String(spec.verb);
      const resourceId = spec.resourceId === undefined ? g.resourceId : spec.resourceId;
      const afterObject = `${g.resourceType}:${resourceId ? lower(String(resourceId)) : '*'}`;
      if (verb === String(g.verb) && afterObject === object) {
        edge(principal, object, verb, true, true, 'grant');
      } else {
        edge(principal, object, String(g.verb), true, false, 'grant');
        edge(principal, afterObject, verb, false, true, 'grant');
      }
    }
  } else if (targetType === 'credential.scopes') {
    const principal = { type: 'principal', id: String(before.holderPrincipalId ?? '') };
    const object = `credential:${targetId ?? ''}`;
    const had = new Set<string>(Array.isArray(before.scopes) ? before.scopes : []);
    const has = new Set<string>(Array.isArray(spec.scopes) ? spec.scopes : []);
    for (const scope of [...new Set([...had, ...has])].sort()) edge(principal, object, scope, had.has(scope), has.has(scope), 'credential');
  } else if (targetType === 'credential.issue') {
    const principal = { type: 'principal', id: String(targetId ?? '') };
    for (const scope of [...new Set<string>(Array.isArray(spec.scopes) ? spec.scopes : [])].sort()) {
      edge(principal, 'credential:new', scope, false, true, 'credential.issue');
    }
  } else if (targetType === 'knowledge.compartment') {
    const subject = spec.subject ?? (grantee ? { type: grantee.type === 'group' ? 'group' : 'user', id: grantee.id } : null);
    if (subject) {
      const principal = { type: subject.type === 'group' ? 'group' : 'principal', id: String(subject.id) };
      const held = new Set((Array.isArray(before.rows) ? before.rows : []).map((r: any) => `${lower(String(r.projectId))}:${r.operation}`));
      for (const projectId of (Array.isArray(spec.projectIds) ? spec.projectIds : []) as string[]) {
        edge(principal, `compartment:${lower(projectId)}`, String(spec.operation ?? 'read'),
          held.has(`${lower(projectId)}:${spec.operation ?? 'read'}`), true, 'knowledge');
      }
    }
  } else if (targetType === 'knowledge.shared_writer') {
    edge({ type: 'principal', id: String(spec.accountId ?? grantee?.id ?? '') }, `shared-area:${spec.sourceId ?? ''}`, 'write',
      Boolean(before.listed), true, 'writer-list');
  }
  // slice S4: roles, status, a new Account, a revoked credential, warrants.
  if (targetType === 'identity.role' && targetId) {
    const principal = { type: 'principal', id: targetId };
    const had = before.role ? String(before.role) : null;
    const has = spec.role ? String(spec.role) : null;
    if (had && had === has) edge(principal, 'role', had, true, true, 'role');
    else {
      if (had) edge(principal, 'role', had, true, false, 'role');
      if (has) edge(principal, 'role', has, false, true, 'role');
    }
  } else if (targetType === 'identity.status' && targetId) {
    edge({ type: 'principal', id: targetId }, 'board', 'sign-in and act', before.status === 'active', spec.status === 'active', 'status');
  } else if (targetType === 'identity.create' && spec.handle) {
    const principal = { type: 'principal', id: `new:${String(spec.handle)}` };
    edge(principal, 'board', 'exists', false, true, 'identity.create');
    if (spec.role) edge(principal, 'role', String(spec.role), false, true, 'role');
  } else if (targetType === 'credential.revoke' && targetId) {
    edge({ type: 'principal', id: String(before.holderPrincipalId ?? '') }, `credential:${targetId}`, 'authenticate', true, false, 'credential.revoke');
  } else if ((WARRANT_TARGETS as readonly string[]).includes(targetType)) {
    const holderId = String(spec.holderPrincipalId ?? before.holderPrincipalId ?? before.holder?.principalId ?? '');
    const object = targetType === 'warrant.create' ? 'warrant:new' : `warrant:${targetId ?? ''}`;
    const live = (status: unknown) => status === 'active';
    const had = targetType === 'warrant.create' ? false : live(before.status);
    const has = targetType === 'warrant.revoke' ? false : targetType === 'warrant.resume' || targetType === 'warrant.create' ? true : live(before.status);
    edge({ type: 'principal', id: holderId }, object, 'mint under', had, has, 'warrant');
  }
  // slice S5: ownership, Verifiers, roles, the Charter head and the arms access and visibility open or close.
  if ((S5_TARGET_TYPES as readonly string[]).includes(targetType) && targetId) {
    const object = `${S5_OBJECT_TYPE[targetType]}:${lower(targetId)}`;
    const principalEdge = (field: string, action: string, via: string): void => {
      const had = before[field] ? String(before[field]) : null;
      const has = spec[field] === undefined ? had : spec[field] ? String(spec[field]) : null;
      if (had && had === has) { edge({ type: 'principal', id: had }, object, action, true, true, via); return; }
      if (had) edge({ type: 'principal', id: had }, object, action, true, false, via);
      if (has) edge({ type: 'principal', id: has }, object, action, false, true, via);
    };
    if (targetType === 'project.owner') principalEdge('ownerPrincipalId', 'owner', 'ownership');
    else if (targetType === 'task.account_owner' || targetType === 'report.account_owner') principalEdge('accountOwnerPrincipalId', 'account owner', 'ownership');
    else if (targetType === 'project.default_verifier' || targetType === 'phase.default_verifier') {
      principalEdge('defaultVerifierPrincipalId', 'default Verifier', 'default-verifier');
    } else if (targetType === 'task.roles') {
      if (spec.shepherdPrincipalId !== undefined) principalEdge('shepherdPrincipalId', 'Shepherd', 'role');
      if (spec.verifierPrincipalId !== undefined) principalEdge('verifierPrincipalId', 'Verifier', 'role');
    } else if (targetType === 'charter.revision') {
      const had = before.contentHash ? String(before.contentHash) : null;
      if (had) edge({ type: 'project', id: lower(targetId) }, `charter:${had}`, 'approved Charter', true, false, 'charter');
      edge({ type: 'project', id: lower(targetId) }, `charter:${String(spec.contentHash ?? '')}`, 'approved Charter', false, true, 'charter');
    } else if (targetType === 'task.access' || targetType === 'phase.access') {
      // Restricted access suppresses the authority the object INHERITS from its Phase and Project.
      edge({ type: 'arm', id: 'inherited' }, object, 'inherited read and write', !before.restricted, !spec.restricted, 'restricted-access');
    } else if (targetType === 'report.visibility') {
      edge({ type: 'arm', id: 'authenticated' }, object, 'read', OPEN_REPORT_VISIBILITY.includes(String(before.visibility)),
        OPEN_REPORT_VISIBILITY.includes(String(spec.visibility)), 'visibility');
    }
  }
  if (reach && (targetType === 'credential.scopes' || targetType === 'credential.issue')) {
    const connector = { type: 'principal', id: reach.connectorId };
    const object = targetType === 'credential.scopes' ? `credential:${targetId ?? ''}` : 'credential:new';
    const via = targetType === 'credential.scopes' ? 'effectiveAfterEdit' : 'effectiveAfterIssue';
    const had = new Set(reach.effectiveBefore);
    const has = new Set(reach.effectiveAfter);
    for (const scope of [...new Set([...had, ...has])].sort()) edge(connector, object, scope, had.has(scope), has.has(scope), via);
    for (const identity of reach.identitiesReached) {
      edge({ type: 'principal', id: identity.principalId }, `principal:${reach.connectorId}`, 'reached', true, true, 'identitiesReached');
    }
  }
  return edges;
}

/** The one-line summary of a relationship diff (section 6). */
export function relationshipSummary(edges: RelationshipEdge[]): string {
  const added = edges.filter((e) => e.state === 'added');
  // An edge counts once whatever projection carries it (the credential's
  // carried scope and its effective scope name the same edge).
  const removed = [...new Set(edges.filter((e) => e.state === 'removed').map((e) => `${e.principal.type}:${e.principal.id}|${e.object}|${e.action}`))];
  const principals = new Set(added.map((e) => `${e.principal.type}:${e.principal.id}`));
  const objects = new Set(added.map((e) => e.object));
  const actions = [...new Set(added.map((e) => e.action))].sort();
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  const gains = added.length === 0 ? 'nobody gains anything'
    : `${plural(principals.size, 'principal')} ${principals.size === 1 ? 'gains' : 'gain'} ${actions.join(', ')} on ${plural(objects.size, 'object')}`;
  const losers = new Set(removed.map((key) => key.split('|')[0])).size;
  const loses = removed.length === 0 ? 'nothing is removed'
    : `${plural(losers, 'principal')} ${losers === 1 ? 'loses' : 'lose'} ${plural(removed.length, 'edge')}`;
  const reached = new Set(edges.filter((e) => e.via === 'identitiesReached').map((e) => e.principal.id)).size;
  return `${gains}; ${loses}${reached > 0 ? `; the change reaches ${plural(reached, 'identity').replace(/identitys$/, 'identities')}` : ''}`;
}

/**
 * The relationship diff of a LEGACY kind, read through the hub's projection
 * (section 2.2, section 12 Q34 (a), F9): a grant request reads as grant.rows
 * for its chain-root Account, a credential request as credential.issue for the
 * requesting Connector, an edit request as credential.scopes on its object, an
 * agent-mint as the new Agent's scopes and rows. Computed, never stored: the
 * legacy rows carry no change columns (migration 158's
 * approvals_change_columns_only), and their bytes stay as they are.
 */
export function projectedRelationships(record: {
  kind?: string; requesterPrincipalId: string; requestedScopes: string[]; requestedRules: ProfileRule[];
  approvedScopes: string[] | null; approvedRules: ProfileRule[] | null;
  accessRequest?: { granteePrincipalId: string | null } | null;
  authorityEdit?: { objectId: string; before: Record<string, unknown>; requested: Record<string, unknown>; approved: Record<string, unknown> | null } | null;
}): { relationships: RelationshipEdge[]; summary: string } {
  const kind = record.kind ?? 'agent-mint';
  let edges: RelationshipEdge[] = [];
  if (kind === 'grant' && record.accessRequest?.granteePrincipalId) {
    edges = relationshipsOf('grant.rows', { rows: [] }, { rules: record.approvedRules ?? record.requestedRules },
      { type: 'principal', id: record.accessRequest.granteePrincipalId }, null);
  } else if (kind === 'credential') {
    edges = relationshipsOf('credential.issue', {}, { scopes: record.approvedScopes ?? record.requestedScopes }, null, record.requesterPrincipalId);
  } else if (kind === 'authority-edit' && record.authorityEdit) {
    const edit = record.authorityEdit;
    edges = relationshipsOf('credential.scopes', { ...edit.before, holderPrincipalId: record.requesterPrincipalId },
      edit.approved ?? edit.requested, null, edit.objectId);
  } else if (kind === 'agent-mint') {
    const agent: Grantee = { type: 'principal', id: 'agent:new' };
    for (const scope of [...new Set(record.approvedScopes ?? record.requestedScopes)].sort()) {
      edges.push({ principal: agent, object: 'credential:new', action: scope, before: false, after: true, via: 'agent-mint', state: 'added' });
    }
    edges.push(...relationshipsOf('grant.rows', { rows: [] }, { rules: record.approvedRules ?? record.requestedRules }, agent, null)
      .map((edge) => ({ ...edge, via: 'agent-mint' })));
  }
  return { relationships: edges, summary: relationshipSummary(edges) };
}

/** The field and relationship diff of one change (section 6). */
export function changeDiff(targetType: string, before: Record<string, any>, after: Record<string, any>, spec: Record<string, any>,
  grantee: Grantee | null, targetId: string | null, reach: CredentialReach | null = null): ChangeDiff {
  const relationships = relationshipsOf(targetType, before, spec, grantee, targetId, reach);
  return { fields: fieldDiff(before, after), relationships, summary: relationshipSummary(relationships) };
}

/**
 * What a credential change reaches (section 6), read through `credentialReach`
 * — the projection the legacy decision blocks read, never a second copy: for
 * credential.scopes the holder Connector with the scopes before and the
 * (approved or requested) scopes after, and the live identities under it, as
 * the edit request's decision block shows them; for credential.issue the
 * target Connector with the new credential's scopes, as the credential
 * request's decision block shows them (no identities: a new credential
 * changes no existing one). Null for every other target.
 */
export async function changeReach(q: Queryable, targetType: string, before: Record<string, any>, spec: Record<string, any>,
  targetId: string | null): Promise<CredentialReach | null> {
  if (targetType !== 'credential.scopes' && targetType !== 'credential.issue') return null;
  const connectorId = targetType === 'credential.scopes' ? before.holderPrincipalId : targetId;
  if (typeof connectorId !== 'string' || !UUID_PATTERN.test(connectorId)) return null;
  const scopes = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
  const reach = await credentialReach(connectorId, [targetType === 'credential.scopes' ? scopes(before.scopes) : [], scopes(spec.scopes)],
    { queryable: q, identities: targetType === 'credential.scopes' });
  return { connectorId: lower(connectorId), effectiveBefore: reach.effective[0], effectiveAfter: reach.effective[1], identitiesReached: reach.identitiesReached };
}

/**
 * section 6 "Where shown": the requester's own status read carries the FIELD
 * diff only, never the relationship diff and never the decider. The requester
 * side is section 5.5 case (a) — the viewer's Account, or a principal under
 * it, is the requester's chain-root Account — so it never decides the item.
 * The point read, the hub item and the bearer status read all answer it.
 */
export function isRequesterSide(cases: readonly string[]): boolean {
  return cases.includes('a');
}

/** A change record as its requester reads it: the decider's id, its standing and the stored relationship diff withheld. */
export function changeRecordForRequester<T extends { decidedByPrincipalId?: string | null; change?: ChangeFields }>(record: T): T {
  if (!record.change) return { ...record, decidedByPrincipalId: null };
  const diff = record.change.spec.diff as { fields?: unknown } | null;
  return {
    ...record,
    decidedByPrincipalId: null,
    change: {
      ...record.change,
      deciderStanding: null,
      spec: { ...record.change.spec, diff: diff && Array.isArray(diff.fields) ? { fields: diff.fields } : null },
    },
  };
}

/** The ledger as the requester reads it: every event's action and time; the actor and metadata only of its own acts. */
export function changeEventsForRequester(events: any[], requesterPrincipalId: string): any[] {
  return events.map((event) => {
    const own = event.actorPrincipalId && lower(String(event.actorPrincipalId)) === lower(requesterPrincipalId);
    return {
      id: event.id, occurredAt: event.occurredAt, approvalId: event.approvalId, action: event.action,
      actorPrincipalId: own ? event.actorPrincipalId : null, actorHandle: own ? event.actorHandle : null,
      metadata: own ? event.metadata : {},
    };
  });
}

/** Canonical rule: ids lower-cased, keys in one order. */
function canonicalRule(rule: ProfileRule): ProfileRule {
  return {
    resourceType: rule.resourceType, selectorForm: rule.selectorForm,
    selectorIds: [...new Set(rule.selectorIds.map(lower))].sort(), verbs: [...new Set(rule.verbs)].sort() as GrantVerb[],
  };
}

/** The rules with every `type:id` in `objects` dropped (an exact rule left with no id is dropped). */
function withoutObjects(rules: ProfileRule[], objects: string[]): ProfileRule[] {
  if (objects.length === 0) return rules;
  return rules
    .map((rule) => (rule.selectorForm === 'exact'
      ? { ...rule, selectorIds: rule.selectorIds.filter((id) => !objects.includes(`${rule.resourceType}:${lower(id)}`)) } : rule))
    .filter((rule) => rule.selectorForm !== 'exact' || rule.selectorIds.length > 0);
}

export class ChangeRequestService {
  // ═════════════════════════════ FILE ═════════════════════════════

  /**
   * FILE a change request, on either door. Everything a decider could never
   * approve refuses now, by name, with a durable denied audit carrying the
   * requester chain; filing changes no authority table.
   */
  async file(input: ChangeFilingInput, actor: AuditActor): Promise<string> {
    let evaluated: EvaluatedFiling;
    try {
      evaluated = await this.evaluateFiling(input, { dry: false, actor });
    } catch (e) {
      await this.auditRefusal('approval.request', e, actor, { type: 'principal', id: UUID_PATTERN.test(input.requesterPrincipalId ?? '') ? input.requesterPrincipalId : null },
        UUID_PATTERN.test(input.requesterPrincipalId ?? '') ? input.requesterPrincipalId : null);
      throw e;
    }
    const { filing, related, reason, requesterHandle, accountId, door, standing } = evaluated;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let approvalId: string;
      try {
        approvalId = await this.insertFiling(client, input, filing, reason, related, accountId,
          door === 'session' ? { door: 'request', authMethod: input.session?.authMethod ?? null, standing } : null);
      } catch (e) {
        if ((e as { code?: string })?.code === '23505') {
          await client.query('ROLLBACK').catch(() => undefined);
          const pending = await this.pendingFor(pool, filing, accountId);
          const refusal = this.pendingRefusal(pending);
          await this.auditRefusal('approval.request', refusal, actor, { type: 'principal', id: input.requesterPrincipalId }, input.requesterPrincipalId);
          throw refusal;
        }
        throw e;
      }
      const metadata = {
        kind: 'change', targetType: filing.targetType, targetId: filing.targetId, targetObjects: filing.targetObjects,
        grantee: filing.grantee, before: filing.before, requested: filing.requested,
        relatedTaskId: related.taskId, relatedPhaseId: related.phaseId, door, standing,
      };
      await this.writeEvent(client, approvalId, 'approval.requested', actor, metadata);
      await auditService.record({
        action: 'approval.request', actor, resourceType: 'approval', resourceId: approvalId,
        metadata: {
          ...metadata, requesterPrincipalId: input.requesterPrincipalId, requestingCredentialId: input.requestingCredentialId ?? null,
          chain: await auditChainFor(client, input.requesterPrincipalId),
        },
      }, client);
      await client.query('COMMIT');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { approvalService } = require('./ApprovalService');
      approvalService.dispatchApprovalNotice(approvalId, input.requesterPrincipalId, requesterHandle, 'change', filing.subject);
      return approvalId;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * THE FILING PIPELINE, shared by both doors and the preview (section 4.3):
   * the requester and its door, the tier, the target, the grantee, the
   * standing (`requestStanding`, section 4.1), the reason, the relation, the
   * quota and the pending key. `dry` (the preview) reads only: it skips the
   * reason, the relation and the quota, and its caller writes no audit row.
   */
  private async evaluateFiling(input: ChangeFilingInput, opts: { dry: boolean; actor?: AuditActor }): Promise<EvaluatedFiling> {
    const door: FilingDoor = input.door ?? 'bearer';
    const foreign = Object.entries(input.foreign ?? {})
      .filter(([, value]) => present(value) && !(Array.isArray(value) && value.length === 0)).map(([key]) => key).sort();
    if (foreign.length > 0) {
      throw refuse(422, 'INVALID_ACCESS_REQUEST',
        `a change filing carries ${CHANGE_FILING_FIELDS.join(', ')} only (got ${foreign.join(', ')})`,
        'requester', '9.1', 'a change request names its target, the change, the grantee, a reason and a lifetime', { fields: foreign });
    }
    const requester = UUID_PATTERN.test(input.requesterPrincipalId ?? '')
      ? await principalService.getPrincipalById(input.requesterPrincipalId) : undefined;
    if (!requester) {
      throw refuse(404, 'REQUESTER_NOT_FOUND', 'requester resolves to no principal', 'requester', '4.2', 'the requester is a live principal');
    }
    const requesterHandle = requester.handle;
    if (requester.legacyIdentity) {
      throw refuse(409, 'LEGACY_FROZEN', 'legacy identities are frozen out of Approval creation (§10, T37)',
        'requester', '4.2', 'legacy identities file nothing');
    }
    let accountId: string;
    let tier: Tier;
    let role: string | null;
    if (door === 'bearer') {
      if (!requester.parentPrincipalId) {
        throw refuse(422, 'AGENT_PLANE_ONLY',
          'a change request on this route is filed by a Connector or Agent credential; the session door is POST /approvals/requests',
          'requester', '9.2', 'the bearer door is the agent plane');
      }
      try {
        await agentMintService.assertRequesterLive(input.requesterPrincipalId, input.requestingCredentialId ?? '');
      } catch (e) {
        if (e instanceof AgentMintError) {
          throw refuse(e.status, e.code, e.message, 'requester', '4.1', 'the requester is live: its chain, and the exact credential it files with (AZ-31c)');
        }
        throw e;
      }
      const chain = await delegationService.resolveChain(input.requesterPrincipalId);
      const root = chain.links[chain.links.length - 1];
      accountId = root.principalId;
      if (root.status !== 'active' || root.legacyIdentity) {
        throw refuse(409, root.legacyIdentity ? 'LEGACY_FROZEN' : 'GRANTEE_DISABLED',
          'the requester\'s Account is not an active, non-legacy Account', 'requester', '4.1', "the filer's Account is live");
      }
      const accountRow = await principalService.getPrincipalById(accountId);
      role = resolveActorRole({ handle: String(accountRow?.handle ?? ''), principalRole: accountRow?.role ?? null });
      tier = filingTierOf(role);
    } else {
      // The session door: a person files as its own Account (section 9.2).
      if (requester.parentPrincipalId || !input.session) {
        throw refuse(422, 'SESSION_ACCOUNT_ONLY', 'a login session files as its own Account; a Connector or Agent files on POST /delegation/access-requests',
          'requester', '9.2', 'the session door is a person acting as itself');
      }
      if (requester.status !== 'active') {
        throw refuse(409, 'REQUESTER_DISABLED', `the filing Account is ${requester.status}`, 'requester', '4.1', "the filer's Account is live");
      }
      accountId = lower(requester.id);
      role = resolveActorRole({ handle: String(requester.handle ?? ''), principalRole: requester.role ?? null });
      // section 4.1 rows 1-2: a root session, an administrator login session, else an ordinary user.
      tier = input.session.isRoot ? 'root' : input.session.administratorOk ? 'administrator' : 'user';
    }
    const targetType = this.admissibleTargetType(input.targetType);
    const grantee = await this.admissibleGrantee(targetType, input, accountId, tier);
    let standing: FilingStanding = tier;
    const filing = await this.resolveTarget(targetType, input, {
      accountId, tier, role, grantee,
      actor: opts.actor ?? { handle: requesterHandle, principalId: input.requesterPrincipalId, authMethod: 'unknown' },
      filer: input.authorizationActor,
      standing: async (objects) => {
        standing = await this.requestStanding({
          door, tier, accountId, requesterId: input.requesterPrincipalId, filer: input.authorizationActor,
        }, { targetType, grantee, objects: objects.objects, rules: objects.rules, operation: objects.operation });
        return standing;
      },
    });
    let reason = '';
    let related: { taskId: string | null; phaseId: string | null } = { taskId: null, phaseId: null };
    if (!opts.dry) {
      reason = this.admissibleReason(input.reason);
      related = await this.readableRelation(input);
      await this.assertQuota(input.requesterPrincipalId);
    }
    await this.assertNotPending(filing, accountId);
    return { filing, related, reason, requesterHandle, accountId, door, standing, tier };
  }

  /**
   * requestStanding (section 4.1): may THIS filer ask for THIS change for THIS
   * grantee? Computed live from the evaluator, never stored, at filing and in
   * the preview. Answers the standing that admits, or throws the named refusal.
   */
  async requestStanding(ctx: { door: FilingDoor; tier: Tier; accountId: string; requesterId: string; filer: AuthorizationActor },
    target: { targetType: ChangeTargetType; grantee: Grantee | null; objects: Array<{ objectId: string; ownerIds: string[] }>;
      rules?: ProfileRule[]; operation?: string }): Promise<FilingStanding> {
    const selfGrantee = !target.grantee || (target.grantee.type === 'principal' && lower(target.grantee.id) === lower(ctx.accountId));
    if (ctx.tier === 'root' || ctx.tier === 'administrator') {
      // Row 5: a bearer names ANOTHER grantee only for rows its own live
      // authority covers (own() of every link, then its Account).
      if (ctx.door === 'bearer' && !selfGrantee && target.targetType === 'grant.rows' && target.rules && target.rules.length > 0) {
        try {
          await agentMintService.assertObjectAuthorityCovers(ctx.requesterId, target.rules);
        } catch (e) {
          if (!(e instanceof AgentMintError)) throw e;
          throw refuse(403, 'OWN_CAP_EXCEEDED',
            "the rows lie outside this credential's own authority: a Connector or Agent names another grantee only within own() and its Account",
            'requester', '4.1', "a bearer's standing is its Account's tier intersected with its credential's effective authority");
        }
      }
      return ctx.tier;
    }
    // Slice S5: an object target changes the object itself, so an ordinary
    // user files it only through the owner tier (section 4.1 row 3); a target
    // that tier does not list (task.account_owner) is root's or an administrator's.
    const objectTarget = (S5_TARGET_TYPES as readonly string[]).includes(target.targetType);
    const needsOwner = objectTarget || !selfGrantee || (target.targetType === 'knowledge.compartment' && target.operation === 'write');
    if (!needsOwner) return 'user';
    if (!changeTargetAdmitsOwnerTier(target.targetType)) {
      throw refuse(403, 'REQUEST_STANDING_NONE',
        objectTarget ? `an ordinary user has no standing to ask for a ${target.targetType} change`
          : `an ordinary user has no standing to ask for a ${target.targetType} for another grantee`,
        'requester', '4.1', objectTarget ? `${target.targetType} is filed by root or an administrator`
          : `${target.targetType} for another grantee is filed by root or an administrator`, { tier: 'user' });
    }
    const owned = await this.ownedObjects(ctx.filer, target.objects);
    if (owned.length === 0) {
      throw refuse(403, 'REQUEST_STANDING_NONE',
        'this needs the owner tier on every object: you own none of these objects (a write grant, a Task role or visibility confers no standing)',
        'requester', '4.1', 'the owner tier is read from the owner sources alone: a Project owner, a Report owner, a Group owner or manager', { tier: 'user' });
    }
    if (owned.length < target.objects.length) {
      throw refuse(403, 'TARGET_OUT_OF_SCOPE',
        `${target.objects.length - owned.length} of these objects lie outside your owner scope: file one request per Project`,
        'requester', '4.1', 'every object of a multi-object target lies in the owner scope',
        { objects: target.objects.length - owned.length, hint: 'split-by-project' });
    }
    return 'owner';
  }

  /**
   * The objects the filer's live predicate reaches through an OWNER source
   * alone (section 4.1 row 3, F4): `sqlCondition(actor, type, id, 'write',
   * {withoutAdministratorArm, includeSources})` read by source, admitting only
   * the owner, account-owner, group-owner and group-project-owner bases (a
   * source gated on the delegation chain counts only where the whole chain
   * intersection holds, so own() binds a bearer). The presenting credential or
   * session must also carry the type's write scope (row 5's scope half).
   */
  private async ownedObjects(filer: AuthorizationActor, objects: Array<{ objectId: string }>): Promise<string[]> {
    const byType = new Map<string, string[]>();
    for (const object of objects) {
      const [type, id] = object.objectId.split(':');
      if (!OWNABLE_TYPES.includes(type) || !id || !UUID_PATTERN.test(id)) continue;
      byType.set(type, [...(byType.get(type) ?? []), lower(id)]);
    }
    const owned: string[] = [];
    for (const [type, ids] of byType) {
      if (!scopesSatisfy(filer.scopes, `${OWNABLE_FAMILY[type]}:write` as never)) continue;
      const { from, resource } = authorizationRepository.sqlResource(type as GrantResourceType);
      const decision = authorizationService.sqlCondition(filer, 'write', resource, 2, { withoutAdministratorArm: true, includeSources: true });
      const sources = decision.sources ?? [];
      const columns = sources.map((source, index) => `COALESCE((${source.sql}), FALSE) AS source_${index}`);
      const rows = await pool.query(
        `SELECT ${resource.id}::text AS id, COALESCE((${decision.sql}), FALSE) AS allowed${columns.length ? `, ${columns.join(', ')}` : ''}
           FROM ${from} WHERE ${resource.id}::text = ANY($1::text[])`, [ids, ...decision.params]);
      for (const row of rows.rows) {
        if (!row.allowed) continue;
        const admitted = sources.some((source, index) => {
          if (!OWNER_SOURCE_BASES.has(source.basis) || !row[`source_${index}`]) return false;
          if (!source.gate) return true;
          const gate = sources.findIndex((entry) => entry.basis === source.gate);
          return gate >= 0 && Boolean(row[`source_${gate}`]);
        });
        if (admitted) owned.push(`${type}:${lower(String(row.id))}`);
      }
    }
    return owned;
  }

  private admissibleTargetType(raw: unknown): ChangeTargetType {
    if (typeof raw === 'string' && OUT_TARGET_TYPES[raw]) {
      throw refuse(422, 'TARGET_NOT_REQUESTABLE', `${raw} is not requestable: ${OUT_TARGET_TYPES[raw]}`,
        'requester', '3', 'every OUT target is declared with its rule', { targetType: raw, why: OUT_TARGET_TYPES[raw] });
    }
    if (!isChangeTargetType(raw)) {
      throw refuse(422, 'TARGET_TYPE_UNKNOWN', 'targetType must name a change target type',
        'requester', '3', 'the target type is one of the closed vocabulary', { targetType: typeof raw === 'string' ? raw : null });
    }
    if (!BUILT_TARGET_TYPES.includes(raw)) {
      throw refuse(422, 'TARGET_NOT_AVAILABLE',
        `${raw} is requestable and ships with slice ${CHANGE_TARGET_SLICE[raw] ?? 'a later slice'} of the change-request trains`,
        'requester', '11', 'a target type is filable once its slice has shipped', { targetType: raw, slice: CHANGE_TARGET_SLICE[raw] ?? null });
    }
    return raw;
  }

  /** section 4.1: the grantee a tier may name. Object-only targets name none. */
  private async admissibleGrantee(targetType: ChangeTargetType, input: ChangeFilingInput, accountId: string, tier: Tier): Promise<Grantee | null> {
    // Every S4 identity target is about its object (a principal, a credential,
    // a warrant or its holder, a new Account) and names no grantee: the
    // principal it changes is targetId (section 5.5 (c), (d)).
    const objectOnly = ['grant.edit', 'grant.revoke', 'credential.scopes', 'credential.issue'].includes(targetType)
      || S4_TARGET_TYPES.includes(targetType) || S5_TARGET_TYPES.includes(targetType);
    if (objectOnly) {
      if (present(input.granteePrincipalId) || present(input.granteeType)) {
        throw refuse(422, 'GRANTEE_NOT_ADMISSIBLE', `a ${targetType} change is about its object and names no grantee`,
          'grantee', '2.1', 'an object-only target carries no grantee');
      }
      return null;
    }
    const type = present(input.granteeType) ? input.granteeType : 'principal';
    if (type !== 'principal' && type !== 'group') {
      throw refuse(422, 'GRANTEE_NOT_ADMISSIBLE', "granteeType is 'principal' or 'group'", 'grantee', '2.1', 'the grantee is an Account or a Group');
    }
    const named = present(input.granteePrincipalId) ? input.granteePrincipalId : (type === 'principal' ? accountId : undefined);
    if (typeof named !== 'string' || !UUID_PATTERN.test(named)) {
      throw refuse(422, 'GRANTEE_NOT_ADMISSIBLE', 'granteePrincipalId must be an Account or Group id', 'grantee', '4.1', 'the grantee is named by id');
    }
    const id = lower(named);
    const another = type === 'group' || id !== lower(accountId);
    // section 4.1: an ordinary user names another grantee only through the
    // owner tier, which requestStanding decides once the objects are located;
    // a target the owner tier never reaches stays its own Account's.
    if (tier === 'user' && another && !changeTargetAdmitsOwnerTier(targetType)) {
      throw refuse(422, 'GRANTEE_NOT_ADMISSIBLE', 'an ordinary user asks for its own Account only (omit granteePrincipalId)',
        'grantee', '4.1', "an ordinary user's grantee is its own Account", { tier });
    }
    // section 4.2: a grantee the filer cannot read in the directory is answered as an absent one.
    const absentGroup = () => refuse(404, 'GRANTEE_NOT_FOUND', 'the Group grantee resolves to no Group', 'grantee', '4.2', 'a Group grantee is a Group');
    const absentPrincipal = () => refuse(404, 'GRANTEE_NOT_FOUND', 'the grantee resolves to no principal', 'grantee', '4.2', 'the grantee is a principal');
    if (type === 'group' ? !this.directoryReadable(input.authorizationActor, 'groups', id)
      : !(await this.principalReadable(input.authorizationActor, accountId, id, tier, another && changeTargetAdmitsOwnerTier(targetType)))) {
      throw type === 'group' ? absentGroup() : absentPrincipal();
    }
    const row = (await pool.query(
      'SELECT id, kind, status, legacy_identity, parent_principal_id FROM principals WHERE id = $1', [id])).rows[0];
    if (type === 'group') {
      const group = (await pool.query('SELECT id FROM groups WHERE id = $1', [id])).rows[0];
      if (!group || !row || row.kind !== 'group') throw absentGroup();
      if (targetType === 'knowledge.shared_writer') {
        throw refuse(422, 'GRANTEE_NOT_ADMISSIBLE', 'a shared-area writer is an Account, never a Group (E298 Q1 (a))',
          'grantee', '3', 'the writer list names Accounts');
      }
      return { type: 'group', id };
    }
    if (!row) throw absentPrincipal();
    if (row.kind === 'group') {
      throw refuse(422, 'GRANTEE_NOT_ADMISSIBLE', "a Group is named with granteeType 'group'", 'grantee', '4.2', 'a Group grantee is typed group');
    }
    if (row.parent_principal_id) {
      throw refuse(422, 'GRANTEE_INERT',
        "a change for a Connector or Agent is inert: §5.1 reduces a delegated link to its own() cap, so the grantee is an Account",
        'grantee', '4.1', 'a Connector or Agent grantee is inert (AZ-A9 clause 4)');
    }
    if (row.legacy_identity) throw refuse(409, 'LEGACY_FROZEN', 'legacy identities are frozen out (§10, T37)', 'grantee', '4.2', 'the grantee is non-legacy');
    if (row.status !== 'active') throw refuse(409, 'GRANTEE_DISABLED', `the grantee Account is ${row.status}`, 'grantee', '4.2', 'the grantee is an active Account');
    if ((targetType === 'knowledge.shared_writer' || targetType === 'knowledge.compartment') && row.kind !== 'human') {
      throw refuse(422, 'GRANTEE_NOT_ADMISSIBLE', 'a knowledge subject is a human Account', 'grantee', '3',
        'the exported subjects are human Accounts and relevant Groups');
    }
    return { type: 'principal', id };
  }

  /** The per-target reading of a filing: the target, its objects and owners, before and requested. */
  private async resolveTarget(targetType: ChangeTargetType, input: ChangeFilingInput, ctx: {
    accountId: string; tier: Tier; role: string | null; grantee: Grantee | null; actor: AuditActor; filer: AuthorizationActor;
    standing: StandingCheck;
  }): Promise<Filing> {
    const filing = await this.resolveTargetObjects(targetType, input, ctx);
    // The multi-object resolvers ran the standing check themselves, before any
    // held-row probe; an object-only target runs it on its one object here.
    // The S5 object resolvers run it themselves too, on the located object and
    // before any content check, so the preview's content stop follows it.
    if (!MULTI_OBJECT_TARGETS.includes(targetType) && !S5_TARGET_TYPES.includes(targetType)) await ctx.standing({ objects: filing.objects });
    return filing;
  }

  private async resolveTargetObjects(targetType: ChangeTargetType, input: ChangeFilingInput, ctx: {
    accountId: string; tier: Tier; role: string | null; grantee: Grantee | null; actor: AuditActor; filer: AuthorizationActor;
    standing: StandingCheck;
  }): Promise<Filing> {
    const change = input.change && typeof input.change === 'object' && !Array.isArray(input.change)
      ? input.change as Record<string, unknown> : null;
    if (!change) {
      throw refuse(422, 'INVALID_ACCESS_REQUEST', 'change must be an object naming the requested change', 'requester', '2.1',
        'the change spec is a JSON object');
    }
    if (MULTI_OBJECT_TARGETS.includes(targetType) && present(input.targetId)) {
      throw refuse(422, 'INVALID_ACCESS_REQUEST', `a ${targetType} change names its objects inside change, not targetId`, 'requester', '2.1',
        'a multi-object target carries target_objects');
    }
    switch (targetType) {
      case 'grant.rows': return this.resolveGrantRows(change, ctx);
      case 'grant.edit': case 'grant.revoke': return this.resolveGrantObject(targetType, input.targetId, change, ctx);
      case 'credential.scopes': return this.resolveCredentialScopes(input, change, ctx);
      case 'credential.issue': return this.resolveCredentialIssue(input, change, ctx);
      case 'knowledge.compartment': return this.resolveCompartment(change, ctx);
      case 'knowledge.shared_writer': return this.resolveSharedWriter(input.targetId, change, ctx);
      case 'identity.role': return this.resolveIdentityRole(input, change, ctx);
      case 'identity.create': return this.resolveIdentityCreate(input, change, ctx);
      case 'identity.status': return this.resolveIdentityStatus(input, change, ctx);
      case 'credential.revoke': return this.resolveCredentialRevoke(input, change, ctx);
      case 'warrant.create': return this.resolveWarrantCreate(input, change, ctx);
      case 'warrant.edit': case 'warrant.revoke': case 'warrant.resume': return this.resolveWarrantObject(targetType, input, change, ctx);
      case 'project.owner': case 'task.account_owner': case 'report.account_owner':
      case 'project.default_verifier': case 'phase.default_verifier': case 'charter.revision': case 'phase.goal':
      case 'task.roles': case 'task.access': case 'phase.access': case 'report.visibility':
        return this.resolveObjectTarget(targetType, input, change, ctx);
      default:
        throw refuse(422, 'TARGET_NOT_AVAILABLE', `${targetType} is not filable yet`, 'requester', '11', 'a target type is filable once its slice has shipped');
    }
  }

  private requestedExpiry(raw: unknown, subject: Subject = 'requester'): string {
    const now = Date.now();
    if (!present(raw)) return new Date(now + CHANGE_DEFAULT_EXPIRY_MS).toISOString();
    const parsed = typeof raw === 'string' ? new Date(raw) : new Date(Number.NaN);
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= now) {
      throw refuse(422, 'INVALID_LIFETIME', 'expiresAt must be a future ISO timestamp (default: 14 days)', subject, '7.4',
        'a request-made row carries a future expiry');
    }
    if (parsed.getTime() > now + CHANGE_MAX_EXPIRY_MS) {
      throw refuse(422, 'INVALID_LIFETIME', 'expiresAt is at most 90 days out (E15)', subject, '7.4', 'a request-made row expires at most 90 days out');
    }
    return parsed.toISOString();
  }

  // ── grant.rows ─────────────────────────────────────────────────────────

  private async resolveGrantRows(change: Record<string, unknown>, ctx: {
    accountId: string; tier: Tier; role: string | null; grantee: Grantee | null; filer: AuthorizationActor; standing: StandingCheck;
  }): Promise<Filing> {
    const grantee = ctx.grantee as Grantee;
    const rules = this.admissibleRules(change.rules, 'requester');
    const forSelf = grantee.type === 'principal' && lower(grantee.id) === lower(ctx.accountId);
    // section 4.1 row 4: an ordinary user asking for ITSELF asks only for verbs
    // within its role's ceiling; the owner tier (another grantee) asks for any
    // requestable verb, which the owner arm admits on its own objects.
    if (ctx.tier === 'user' && forSelf) {
      const ceiling = userVerbCeiling(ctx.role);
      const over = rules.flatMap((rule) => rule.verbs.filter((verb) => verbCeiling(verb) > ceiling));
      if (over.length > 0) {
        throw refuse(422, 'EXCEEDS_ROLE_CEILING',
          `your role (${ctx.role ?? 'none'}) cannot exercise ${[...new Set(over)].join(', ')}: a row beyond it would be inert`,
          'requester', '4.1', "an ordinary user asks only for verbs within its role's ceiling", { role: ctx.role });
      }
    }
    const expiresAt = this.requestedExpiry(change.expiresAt);
    const unknown = Object.keys(change).filter((key) => !['rules', 'expiresAt'].includes(key)).sort();
    if (unknown.length > 0) {
      throw refuse(422, 'INVALID_ACCESS_REQUEST', `a grant.rows change carries rules and expiresAt only (got ${unknown.join(', ')})`,
        'requester', '3', 'the grant.rows spec is {rules, expiresAt?}', { fields: unknown });
    }
    const targetObjects = rules.flatMap((rule): Array<{ type: string; id: string | null }> => (rule.selectorForm === 'all-of-type'
      ? [{ type: rule.resourceType, id: null }]
      : rule.selectorIds.map((id) => ({ type: rule.resourceType, id }))));
    const located = await this.locateObjects(pool, targetObjects);
    // section 4.1: the standing, before any probe of what the grantee holds.
    await ctx.standing({ objects: located.objects, rules });
    // section 4.2 / 4.3: an object the filer cannot read and an absent one file
    // alike; nothing about either is read for the filer's answer.
    const unreadByFiler = await this.unreadObjects(ctx.filer, rules);
    const readRules = withoutObjects(rules, unreadByFiler);
    await this.assertRowsNotHeld(pool, grantee, readRules);
    return {
      targetType: 'grant.rows', targetId: null, targetObjects, grantee,
      before: { rows: await this.heldRows(pool, grantee, readRules) },
      requested: { grantee, rules, expiresAt },
      objects: located.objects, scope: located.scope,
      lifetime: { choice: 'until-date', revertAt: expiresAt },
      subject: `grant.rows for ${grantee.type} ${grantee.id}`,
      unreadByFiler,
    };
  }

  /** The `type:id` of every exact object the filer cannot read (absent or unreadable alike), by authorizedIds. */
  private async unreadObjects(filer: AuthorizationActor, rules: ProfileRule[]): Promise<string[]> {
    const unread: string[] = [];
    for (const rule of rules) {
      // A plugin row names no object row a read decision covers (and surface is never requestable).
      if (rule.selectorForm !== 'exact' || rule.selectorIds.length === 0 || !OBJECT_TABLES[rule.resourceType]) continue;
      const readable = await authorizationRepository.authorizedIds(filer, rule.resourceType, rule.selectorIds, 'read');
      for (const id of rule.selectorIds) if (!readable.has(lower(id))) unread.push(`${rule.resourceType}:${lower(id)}`);
    }
    return unread;
  }

  /** A principal-plane object read in the DIRECTORY through the shared route predicate (the GET of that object). */
  private directoryReadable(filer: AuthorizationActor, family: 'principals' | 'groups', id: string): boolean {
    return authorizationService.authorizeRoute(filer, requiredScopeFor('GET', `/${family}/${id}`)).allowed;
  }

  /** A principal (Account, Connector, Agent) the filer reads: its own Account subtree, else the directory read
   * (for an ordinary user only where the owner tier may name another grantee: a grantee Account, section 4.1 row 3). */
  private async principalReadable(filer: AuthorizationActor, accountId: string, principalId: string, tier: Tier,
    ownerTierGrantee = false): Promise<boolean> {
    const root = await authorityEditExecutor.chainRootAccount(pool, principalId);
    if (root !== null && lower(root) === lower(accountId)) return true;
    return (tier !== 'user' || ownerTierGrantee) && this.directoryReadable(filer, 'principals', principalId);
  }

  /** A grant row the filer reads: its grantee in the directory and its resource object, if it names one. */
  private async grantReadable(filer: AuthorizationActor, accountId: string, tier: Tier, row: any): Promise<boolean> {
    const granteeId = lower(String(row.grantee_id));
    const grantee = row.grantee_type === 'group'
      ? this.directoryReadable(filer, 'groups', granteeId)
      : await this.principalReadable(filer, accountId, granteeId, tier);
    if (!grantee) return false;
    // A plugin or surface row names no object row a read decision covers.
    if (row.resource_id && !OBJECT_TABLES[row.resource_type as GrantResourceType]) return true;
    if (!row.resource_id) return true;
    const resourceId = lower(String(row.resource_id));
    return (await authorizationRepository.authorizedIds(filer, row.resource_type as GrantResourceType, [resourceId], 'read')).has(resourceId);
  }

  /** clauses 3 and 5 on requested rows (one rule per type, exact or all-of-type, never admin, never surface). */
  private admissibleRules(raw: unknown, subject: Subject): ProfileRule[] {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw refuse(422, 'RULES_REQUIRED', 'change.rules must be a non-empty array of rules', subject, '3', 'a grant.rows change names at least one rule');
    }
    let rules: ProfileRule[];
    try {
      rules = validateRules(raw).map(canonicalRule);
    } catch (e) {
      if (e instanceof AccessProfileError) {
        throw refuse(422, 'INVALID_ACCESS_RULE', e.message, subject, '3', 'each rule is {resourceType, selectorForm, selectorIds, verbs}');
      }
      throw e;
    }
    const seen = new Set<string>();
    for (const rule of rules) {
      if (!REQUESTABLE_RESOURCE_TYPES.includes(rule.resourceType)) {
        throw refuse(422, 'SURFACE_NOT_ADMISSIBLE', `${rule.resourceType} rows are not requestable (AZ-A5 clause 3)`, subject, '3',
          'every grant resource type except surface', { failingRule: rule });
      }
      if (rule.verbs.some((verb) => !REQUESTABLE_VERBS.includes(verb))) {
        throw refuse(422, 'ADMIN_VERB_NOT_ADMISSIBLE', 'the admin verb is never requestable (R9:126)', subject, '3',
          'verbs are read, write, use or invoke — never admin', { failingRule: rule });
      }
      if (rule.selectorForm !== 'exact' && rule.selectorForm !== 'all-of-type') {
        throw refuse(422, 'SELECTOR_FORM_NOT_ADMISSIBLE', `selectorForm ${rule.selectorForm} is not requestable`, subject, '3',
          'selectorForm is exact or all-of-type', { failingRule: rule });
      }
      if (seen.has(rule.resourceType)) {
        throw refuse(422, 'ONE_RULE_PER_TYPE', `two rules name ${rule.resourceType}: merge them`, subject, '3', 'one rule per resource type');
      }
      seen.add(rule.resourceType);
    }
    return rules;
  }

  /** The grantee's direct live rows on the named tuples: the grant.rows before-state. */
  private async heldRows(q: Queryable, grantee: Grantee, rules: ProfileRule[]): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    for (const rule of rules) {
      const ids: Array<string | null> = rule.selectorForm === 'all-of-type' ? [null] : rule.selectorIds;
      for (const id of ids) {
        const rows = await q.query(
          `SELECT id, verb, expires_at FROM grants
            WHERE grantee_type = $1 AND grantee_id = $2 AND resource_type = $3 AND resource_id IS NOT DISTINCT FROM $4::uuid
              AND verb = ANY($5::text[]) AND (expires_at IS NULL OR expires_at > NOW())
            ORDER BY verb, id`, [grantee.type, grantee.id, rule.resourceType, id, rule.verbs]);
        for (const row of rows.rows) {
          out.push({ resourceType: rule.resourceType, resourceId: id, verb: String(row.verb), grantId: String(row.id), expiresAt: iso(row.expires_at) });
        }
      }
    }
    return out;
  }

  /** clause 5: a row the grantee already holds refuses ALREADY_HELD, naming where it comes from. */
  private async assertRowsNotHeld(q: Queryable, grantee: Grantee, rules: ProfileRule[]): Promise<void> {
    for (const rule of rules) {
      const ids: string[][] = rule.selectorForm === 'exact' ? rule.selectorIds.map((id) => [id]) : [[]];
      for (const selectorIds of ids) {
        for (const verb of rule.verbs) {
          const single: ProfileRule = { resourceType: rule.resourceType, selectorForm: rule.selectorForm, selectorIds, verbs: [verb] };
          if (grantee.type === 'principal') {
            let covered = true;
            try {
              await agentMintService.assertObjectAuthorityCovers(grantee.id, [single]);
            } catch (e) {
              if (!(e instanceof AgentMintError)) throw e;
              covered = false;
            }
            if (covered) {
              throw refuse(409, 'ALREADY_HELD',
                `the grantee Account already holds ${verb} on ${rule.resourceType} ${selectorIds[0] ?? '(every object of the type)'}: drop that row`,
                'grantee', '4.2', 'a row the grantee already covers is refused (assertNotAlreadyHeld)', { failingRule: single });
            }
          } else {
            const held = (await q.query(
              `SELECT id FROM grants WHERE grantee_type = 'group' AND grantee_id = $1 AND resource_type = $2
                  AND resource_id IS NOT DISTINCT FROM $3::uuid AND verb = $4 AND (expires_at IS NULL OR expires_at > NOW())`,
              [grantee.id, rule.resourceType, selectorIds[0] ?? null, verb])).rows[0];
            if (held) {
              throw refuse(409, 'ALREADY_HELD',
                `the Group already holds ${verb} on ${rule.resourceType} ${selectorIds[0] ?? '(every object of the type)'} through grant ${held.id}: drop that row`,
                'grantee', '4.2', 'a row the Group already holds is refused', { failingRule: single, grantId: String(held.id) });
            }
          }
        }
      }
    }
  }

  /**
   * Per object: the owner value the evaluator's owner arm reads (section 2.1,
   * B1) and the Project/Report/Group coordinates of the scope arrays. A
   * Project its owner; a Phase its Project's owner; a Task its own account
   * owner, else its Project's owner; a Report its account owner and its
   * author; anything else, and an all-of-type rule, '{}'.
   */
  private async locateObjects(q: Queryable, objects: Array<{ type: string; id: string | null }>): Promise<{
    objects: Array<{ objectId: string; ownerIds: string[] }>; scope: { projectIds: string[]; reportIds: string[]; groupIds: string[] };
  }> {
    const projectIds: string[] = [];
    const reportIds: string[] = [];
    const out: Array<{ objectId: string; ownerIds: string[] }> = [];
    for (const object of objects) {
      let owners: Array<string | null> = [];
      if (object.id) {
        if (object.type === 'project') {
          const row = (await q.query('SELECT id, owner_principal_id FROM projects WHERE id = $1', [object.id])).rows[0];
          if (row) { owners = [row.owner_principal_id]; projectIds.push(String(row.id)); }
        } else if (object.type === 'phase') {
          const row = (await q.query(
            'SELECT ph.project_id, p.owner_principal_id FROM phases ph LEFT JOIN projects p ON p.id = ph.project_id WHERE ph.id = $1', [object.id])).rows[0];
          if (row) { owners = [row.owner_principal_id]; if (row.project_id) projectIds.push(String(row.project_id)); }
        } else if (object.type === 'task') {
          const row = (await q.query(
            `SELECT t.project_id, COALESCE(t.account_owner_principal_id, p.owner_principal_id) AS owner
               FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = $1`, [object.id])).rows[0];
          if (row) { owners = [row.owner]; if (row.project_id) projectIds.push(String(row.project_id)); }
        } else if (object.type === 'report') {
          const row = (await q.query('SELECT id, account_owner_principal_id, author_principal_id FROM reports WHERE id = $1', [object.id])).rows[0];
          if (row) { owners = [row.account_owner_principal_id, row.author_principal_id]; reportIds.push(String(row.id)); }
        }
      }
      out.push({ objectId: `${object.type}:${object.id ? lower(object.id) : '*'}`, ownerIds: uniqueSorted(owners) });
    }
    const ownerIds = uniqueSorted(out.flatMap((o) => o.ownerIds));
    const groupIds = ownerIds.length === 0 ? [] : (await q.query(
      `SELECT id::text AS id FROM principals WHERE id = ANY($1::uuid[]) AND kind = 'group' ORDER BY id`, [ownerIds])).rows.map((r) => String(r.id));
    return { objects: out, scope: { projectIds: uniqueSorted(projectIds), reportIds: uniqueSorted(reportIds), groupIds } };
  }

  // ── grant.edit / grant.revoke ──────────────────────────────────────────

  private async resolveGrantObject(targetType: 'grant.edit' | 'grant.revoke', rawId: unknown, change: Record<string, unknown>,
    ctx: { accountId: string; tier: Tier; actor: AuditActor; filer: AuthorizationActor }): Promise<Filing> {
    if (ctx.tier === 'user') {
      throw refuse(403, 'REQUEST_STANDING_NONE',
        `an ordinary user has no standing to ask for a ${targetType}: the grant is root's owner-plane object`,
        'requester', '4.1', `${targetType} is filed by root or an administrator`, { tier: ctx.tier });
    }
    const id = typeof rawId === 'string' && UUID_PATTERN.test(rawId) ? lower(rawId) : null;
    const locked = id ? await authorityEditExecutor.lockObject(pool, 'grant', id, false) : null;
    // section 4.2: a grant whose grantee or object the filer cannot read is answered as an absent grant.
    if (!locked || !(await this.grantReadable(ctx.filer, ctx.accountId, ctx.tier, locked.row))) {
      throw refuse(404, 'TARGET_NOT_FOUND', 'the grant resolves to no row', 'target', '4.2', 'the target exists');
    }
    const problem = await authorityEditExecutor.editableProblem(pool, locked);
    if (problem) throw asChangeRefusal(problem, 'target', '3');
    const row = locked.row;
    const grantSnapshot = {
      grantId: String(row.id), granteeType: String(row.grantee_type), granteeId: String(row.grantee_id),
      resourceType: String(row.resource_type), resourceId: row.resource_id ? String(row.resource_id) : null,
      verb: String(row.verb), expiresAt: iso(row.expires_at), approvalId: row.approval_id ? String(row.approval_id) : null,
    };
    let requested: Record<string, unknown>;
    if (targetType === 'grant.revoke') {
      if (Object.keys(change).length > 0 && !(Object.keys(change).length === 1 && change.revoke === true)) {
        throw refuse(422, 'INVALID_ACCESS_REQUEST', 'a grant.revoke change is {} or {revoke: true}', 'requester', '3', 'the revoke spec names nothing else');
      }
      requested = { revoke: true };
    } else {
      if (present(change.transport)) {
        throw refuse(422, 'TRANSPORT_NOT_REQUESTABLE', 'a grant carries no transport', 'requester', '3', 'a grant edit changes verb, expiresAt or resourceId');
      }
      let target;
      try {
        target = await authorityEditExecutor.target(locked, change, ctx.actor);
      } catch (e) {
        throw asChangeRefusal(e, 'requester', '3');
      }
      if (target.classification.changed.length === 0) {
        throw refuse(422, 'EDIT_NO_CHANGE', 'the requested grant edit changes nothing', 'requester', '3', 'a change changes at least one field');
      }
      requested = target.after;
    }
    return {
      targetType, targetId: String(row.id), targetObjects: null, grantee: null,
      before: { ...(locked.state as unknown as Record<string, unknown>), grant: grantSnapshot },
      requested, objects: [{ objectId: String(row.id), ownerIds: [] }],
      scope: { projectIds: row.resource_type === 'project' && row.resource_id ? [lower(String(row.resource_id))] : [], reportIds: [], groupIds: [] },
      lifetime: { choice: 'keep' }, subject: `${targetType} of grant ${row.id}`,
    };
  }

  // ── credential.scopes on any credential ────────────────────────────────

  private async resolveCredentialScopes(input: ChangeFilingInput, change: Record<string, unknown>,
    ctx: { accountId: string; tier: Tier; actor: AuditActor; filer: AuthorizationActor }): Promise<Filing> {
    const id = typeof input.targetId === 'string' && UUID_PATTERN.test(input.targetId) ? lower(input.targetId) : null;
    const locked = id ? await authorityEditExecutor.lockObject(pool, 'credential', id, false) : null;
    // A credential's holder lies in an ordinary user's own Account subtree; root and an
    // administrator name any holder their directory read reaches (section 4.2).
    if (!locked || !(await this.principalReadable(ctx.filer, ctx.accountId, String(locked.holderPrincipalId), ctx.tier))) {
      throw refuse(404, 'TARGET_NOT_FOUND', 'the credential resolves to no row', 'target', '4.2', 'the target exists and lies within the filer\'s standing');
    }
    if (present(change.transport)) {
      throw refuse(422, 'TRANSPORT_NOT_REQUESTABLE',
        'a transport pin is never asked for: root or an administrator loosens it with step-up (AZ-A13 clause 9d)',
        'requester', '3', 'credential.transport is OUT');
    }
    const unknown = Object.keys(change).filter((key) => key !== 'scopes').sort();
    if (unknown.length > 0) {
      throw refuse(422, 'INVALID_ACCESS_REQUEST', `a credential.scopes change carries scopes only (got ${unknown.join(', ')})`,
        'requester', '3', 'the credential.scopes spec is {scopes}', { fields: unknown });
    }
    const before = locked.state as unknown as { scopes: string[]; transport: string };
    const addedRaw = Array.isArray(change.scopes) ? (change.scopes as unknown[]).filter((s) => typeof s === 'string' && !before.scopes.includes(s as string)) : [];
    if ((addedRaw as string[]).some((scope) => scope === 'root' || scope.endsWith(':admin'))) {
      throw refuse(422, 'ADMIN_SCOPE_NOT_ADMISSIBLE', 'root and *:admin are never added through a request (R9:195)', 'requester', '3',
        'never root, never *:admin');
    }
    const problem = await authorityEditExecutor.editableProblem(pool, locked, addedRaw as string[]);
    if (problem) throw asChangeRefusal(problem, 'target', '3');
    let target;
    try {
      target = await authorityEditExecutor.target(locked, { scopes: change.scopes }, ctx.actor);
    } catch (e) {
      throw asChangeRefusal(e, 'requester', '3');
    }
    if (target.classification.changed.length === 0) {
      throw refuse(422, 'EDIT_NO_CHANGE', 'the requested scope set is the credential\'s own', 'requester', '3', 'a change changes at least one field');
    }
    return {
      targetType: 'credential.scopes', targetId: String(locked.id), targetObjects: null, grantee: null,
      before: { scopes: [...before.scopes], transport: before.transport, holderPrincipalId: String(locked.holderPrincipalId),
        keyId: locked.identity.keyId ?? null },
      requested: { scopes: (target.after as { scopes: string[] }).scopes, transport: before.transport },
      objects: [{ objectId: String(locked.id), ownerIds: [] }],
      scope: { projectIds: [], reportIds: [], groupIds: [] },
      lifetime: { choice: 'keep' }, subject: `credential.scopes of credential ${locked.identity.keyId ?? locked.id}`,
    };
  }

  // ── credential.issue for another existing Connector ────────────────────

  private async resolveCredentialIssue(input: ChangeFilingInput, change: Record<string, unknown>,
    ctx: { accountId: string; tier: Tier; filer: AuthorizationActor }): Promise<Filing> {
    const id = typeof input.targetId === 'string' && UUID_PATTERN.test(input.targetId) ? lower(input.targetId) : null;
    if (id && id === lower(input.requesterPrincipalId)) {
      throw refuse(422, 'KIND_NOT_FILABLE_HERE',
        'a credential for the requesting Connector itself is filed with kind credential (AZ-A9 clause 13): one door per noun',
        'requester', '3', 'credential.issue for self is kind credential, unchanged');
    }
    const row = id ? (await pool.query(
      'SELECT id, handle, kind, status, legacy_identity, parent_principal_id FROM principals WHERE id = $1', [id])).rows[0] : null;
    if (!row || row.kind !== 'service' || !row.parent_principal_id || !(await this.principalReadable(ctx.filer, ctx.accountId, String(row.id), ctx.tier))) {
      throw refuse(404, 'TARGET_NOT_FOUND', 'the target resolves to no Connector within your standing', 'target', '4.2',
        'the target is an existing Connector the filer may name');
    }
    if (row.legacy_identity) throw refuse(409, 'LEGACY_FROZEN', 'a legacy Connector is frozen out (§10, T37)', 'target', '4.2', 'the target is non-legacy');
    if (row.status !== 'active') throw refuse(409, 'GRANTEE_DISABLED', `the target Connector is ${row.status}`, 'target', '4.2', 'the target is an active Connector');
    const unknown = Object.keys(change).filter((key) => !['scopes', 'transport', 'label', 'expiresAt'].includes(key)).sort();
    if (unknown.length > 0) {
      throw refuse(422, 'INVALID_ACCESS_REQUEST', `a credential.issue change carries scopes, transport, label and expiresAt only (got ${unknown.join(', ')})`,
        'requester', '3', 'the credential.issue spec is {scopes, transport?, label?, expiresAt?}', { fields: unknown });
    }
    let scopes: string[];
    try {
      scopes = assertConnectorCredentialScopes(change.scopes, 'requester');
    } catch (e) {
      throw asChangeRefusal(e, 'requester', '3');
    }
    const transport = present(change.transport) ? change.transport : 'any';
    if (typeof transport !== 'string' || !(CONNECTOR_CREDENTIAL_TRANSPORTS as readonly string[]).includes(transport)) {
      throw refuse(422, 'INVALID_TRANSPORT', "transport is 'any', 'mcp' or 'api'", 'requester', '3', 'the transport pin is any, mcp or api');
    }
    let label: string | null = null;
    if (present(change.label)) {
      label = typeof change.label === 'string' ? change.label.trim() : '';
      if ([...label].length < 1 || [...label].length > 100) {
        throw refuse(422, 'INVALID_LABEL', 'label is optional and, when given, 1-100 characters', 'requester', '3', 'the label is 1-100 characters');
      }
    }
    const expiresAt = this.requestedExpiry(change.expiresAt);
    await this.assertCredentialNotHeld(pool, String(row.id), scopes, transport);
    const live = await pool.query(
      `SELECT id FROM principal_credentials WHERE principal_id = $1 AND revoked_at IS NULL AND grace_until IS NULL
          AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY id`, [row.id]);
    return {
      targetType: 'credential.issue', targetId: String(row.id), targetObjects: null, grantee: null,
      before: { connector: { principalId: String(row.id), handle: String(row.handle), status: String(row.status) },
        liveCredentialIds: live.rows.map((r) => String(r.id)) },
      requested: { scopes, transport, label, expiresAt },
      objects: [{ objectId: String(row.id), ownerIds: [] }],
      scope: { projectIds: [], reportIds: [], groupIds: [] },
      lifetime: { choice: 'until-date', revertAt: expiresAt }, subject: `credential.issue for Connector ${row.handle}`,
    };
  }

  /** clause 13 by analogy: a live credential of the Connector already carrying every scope under a compatible pin. */
  private async assertCredentialNotHeld(q: Queryable, connectorId: string, scopes: string[], transport: string): Promise<void> {
    const held = await q.query(
      `SELECT id, label, key_id, scopes, transport FROM principal_credentials
        WHERE principal_id = $1 AND revoked_at IS NULL AND grace_until IS NULL AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY key_id`, [connectorId]);
    for (const row of held.rows) {
      const carried = parseJson<string[]>(row.scopes, []);
      const covers = carried.includes('root') || scopes.every((scope) => carried.includes(scope));
      const pinCovers = String(row.transport ?? 'any') === 'any' || String(row.transport) === transport;
      if (covers && pinCovers) {
        throw refuse(409, 'ALREADY_HELD',
          `the Connector already holds ${scopes.join(', ')} on its live credential (key ${row.key_id}): ask only for what it lacks`,
          'target', '4.2', 'a live credential that already carries every scope under a compatible pin is refused',
          { coveringCredential: { credentialId: String(row.id), keyId: row.key_id ?? null, label: row.label ?? null } });
      }
    }
  }

  // ── knowledge.compartment ──────────────────────────────────────────────

  /** A knowledge source: a knowledge-configured, unretired Service. */
  private async knowledgeSource(raw: unknown, filer: AuthorizationActor): Promise<{ id: string; relevantGroups: string[] }> {
    const id = typeof raw === 'string' && UUID_PATTERN.test(raw) ? lower(raw) : null;
    const row = id ? (await pool.query(
      `SELECT id, knowledge_relevant_groups FROM services
        WHERE id = $1 AND knowledge_query_endpoint IS NOT NULL AND retired_at IS NULL`, [id])).rows[0] : null;
    if (!row || !(await authorizationRepository.authorizedIds(filer, 'service', [String(row.id)], 'read')).has(String(row.id))) {
      throw refuse(404, 'TARGET_NOT_FOUND', 'the knowledge source resolves to no Service', 'target', '4.2', 'the source is a knowledge Service');
    }
    return { id: String(row.id), relevantGroups: (row.knowledge_relevant_groups ?? []).map((g: unknown) => lower(String(g))) };
  }

  /**
   * KNOWLEDGE_NOT_EXPORTED (section 4.2, F7): the subject Account and every
   * named Project lie inside the exporter's LIVE selection, at filing and again
   * at decide; a request nothing would export is refused, never approved.
   */
  assertExported(sourceId: string, input: { accountIds: string[]; projectIds: string[] }, subject: Subject): void {
    const selection = lifecycleSelectionFor(sourceId);
    if (!selection) {
      throw refuse(409, 'KNOWLEDGE_NOT_EXPORTED',
        'this knowledge source has no live export: nothing a decision wrote would reach it', subject, '4.2',
        "the subject and every Project lie inside the exporter's live selection", { project: [], account: [], reason: 'no-export' });
    }
    const misses = lifecycleSelectionMisses(selection, input);
    if (misses.accounts.length > 0 || misses.projects.length > 0) {
      throw refuse(409, 'KNOWLEDGE_NOT_EXPORTED',
        `outside the exporter's selection: ${[...misses.accounts.map((a) => `Account ${a}`), ...misses.projects.map((p) => `Project ${p}`)].join(', ')}`,
        subject, '4.2', "the subject and every Project lie inside the exporter's live selection",
        { account: misses.accounts, project: misses.projects });
    }
  }

  private async resolveCompartment(change: Record<string, unknown>, ctx: {
    tier: Tier; grantee: Grantee | null; filer: AuthorizationActor; standing: StandingCheck;
  }): Promise<Filing> {
    const grantee = ctx.grantee as Grantee;
    const unknown = Object.keys(change).filter((key) => !['sourceId', 'operation', 'projectIds', 'expiresAt'].includes(key)).sort();
    if (unknown.length > 0) {
      throw refuse(422, 'INVALID_ACCESS_REQUEST', `a knowledge.compartment change carries sourceId, operation, projectIds and expiresAt only (got ${unknown.join(', ')})`,
        'requester', '3', 'the knowledge.compartment spec is {sourceId, operation, projectIds, expiresAt?}', { fields: unknown });
    }
    const source = await this.knowledgeSource(change.sourceId, ctx.filer);
    const operation = change.operation === undefined ? 'read' : change.operation;
    if (operation !== 'read' && operation !== 'write') {
      throw refuse(422, 'INVALID_ACCESS_REQUEST', "operation is 'read' or 'write'", 'requester', '3', 'a compartment row is read or write');
    }
    const raw = change.projectIds;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 200 || raw.some((id) => typeof id !== 'string' || !UUID_PATTERN.test(id))) {
      throw refuse(422, 'INVALID_ACCESS_REQUEST', 'projectIds is a non-empty list of at most 200 Project ids', 'requester', '2.1',
        'a knowledge.compartment change names its Projects');
    }
    const projectIds = uniqueSorted(raw as string[]);
    // The point-stage rule: a Project the filer cannot read is answered exactly as an absent one.
    const readable = await authorizationRepository.authorizedIds(ctx.filer, 'project', projectIds, 'read');
    const missing = projectIds.filter((id) => !readable.has(id));
    if (missing.length > 0) {
      throw refuse(404, 'TARGET_NOT_FOUND', `${missing.length} named Project(s) resolve to no row you can read`, 'target', '4.2',
        'every named Project exists and is readable by the filer', { objects: missing.length });
    }
    const targetObjects = projectIds.map((id) => ({ type: 'project', id }));
    const located = await this.locateObjects(pool, targetObjects);
    // section 4.1: an ordinary user asks READ for itself on a Project it can
    // read; another grantee, or write, needs the owner tier on every Project.
    await ctx.standing({ objects: located.objects, operation });
    if (grantee.type === 'group' && !source.relevantGroups.includes(grantee.id)) {
      throw refuse(422, 'GROUP_NOT_RELEVANT', 'the Group is not among the source\'s relevant Groups, so the source never sees it',
        'grantee', '3', 'a Group subject is in services.knowledge_relevant_groups');
    }
    this.assertExported(source.id, { accountIds: grantee.type === 'principal' ? [grantee.id] : [], projectIds }, 'grantee');
    const expiresAt = this.requestedExpiry(change.expiresAt);
    const subjectType = grantee.type === 'group' ? 'group' : 'user';
    const held = await pool.query(
      `SELECT project_id FROM knowledge_compartment_grants
        WHERE source_id = $1 AND project_id = ANY($2::uuid[]) AND subject_type = $3 AND subject_id = $4 AND operation = $5
          AND (expires_at IS NULL OR expires_at > NOW())`, [source.id, projectIds, subjectType, grantee.id, operation]);
    if (held.rows.length > 0) {
      throw refuse(409, 'ALREADY_HELD', `the subject already holds ${operation} on ${held.rows.length} of these Projects: drop them`,
        'grantee', '4.2', 'a compartment row the subject already holds is refused',
        { projects: held.rows.map((r) => String(r.project_id)).sort() });
    }
    return {
      targetType: 'knowledge.compartment', targetId: null, targetObjects, grantee,
      before: { rows: await this.compartmentRows(pool, source.id, subjectType, grantee.id, projectIds) },
      requested: { sourceId: source.id, operation, subject: { type: subjectType, id: grantee.id }, projectIds, expiresAt },
      objects: located.objects, scope: located.scope,
      lifetime: { choice: 'until-date', revertAt: expiresAt },
      subject: `knowledge.compartment ${operation} on ${projectIds.length} Project(s)`,
    };
  }

  private async compartmentRows(q: Queryable, sourceId: string, subjectType: string, subjectId: string, projectIds: string[]): Promise<Array<Record<string, unknown>>> {
    const rows = await q.query(
      `SELECT project_id, operation, expires_at FROM knowledge_compartment_grants
        WHERE source_id = $1 AND subject_type = $2 AND subject_id = $3 AND project_id = ANY($4::uuid[])
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY project_id, operation`, [sourceId, subjectType, subjectId, projectIds]);
    return rows.rows.map((r) => ({ projectId: String(r.project_id), operation: String(r.operation), expiresAt: iso(r.expires_at) }));
  }

  // ── knowledge.shared_writer ────────────────────────────────────────────

  private async resolveSharedWriter(rawTargetId: unknown, change: Record<string, unknown>, ctx: { grantee: Grantee | null; filer: AuthorizationActor }): Promise<Filing> {
    const grantee = ctx.grantee as Grantee;
    const unknown = Object.keys(change).filter((key) => !['sourceId', 'expiresAt'].includes(key)).sort();
    if (unknown.length > 0) {
      throw refuse(422, 'INVALID_ACCESS_REQUEST', `a knowledge.shared_writer change carries sourceId and expiresAt only (got ${unknown.join(', ')})`,
        'requester', '3', 'the knowledge.shared_writer spec is {sourceId?, expiresAt?}', { fields: unknown });
    }
    let sourceRaw: unknown = change.sourceId;
    if (typeof rawTargetId === 'string' && rawTargetId.length > 0) {
      const [sourcePart, scope] = rawTargetId.split(':');
      if (scope !== 'organisation' || (present(change.sourceId) && lower(String(change.sourceId)) !== lower(sourcePart))) {
        throw refuse(422, 'INVALID_ACCESS_REQUEST', "targetId is '<source>:organisation'", 'requester', '2.1', 'the writer-list target is <source>:<scope>');
      }
      sourceRaw = sourcePart;
    }
    const absentSource = () => refuse(404, 'TARGET_NOT_FOUND', 'the knowledge source resolves to no Service', 'target', '4.2', 'the source is a knowledge Service');
    let source;
    try {
      source = await resolveSharedWriterSource(pool, sourceRaw);
    } catch (e) {
      if (e instanceof SharedWriterError) {
        throw e.status === 404 ? absentSource() : refuse(422, e.code, e.message, 'target', '4.2', 'the source is a knowledge Service');
      }
      throw e;
    }
    if (!(await authorizationRepository.authorizedIds(ctx.filer, 'service', [source.id], 'read')).has(source.id)) throw absentSource();
    this.assertExported(source.id, { accountIds: [grantee.id], projectIds: [] }, 'grantee');
    const expiresAt = this.requestedExpiry(change.expiresAt);
    const listed = (await pool.query(
      `SELECT 1 FROM knowledge_shared_writers WHERE source_id = $1 AND scope = 'organisation' AND account_id = $2
          AND (expires_at IS NULL OR expires_at > NOW())`, [source.id, grantee.id])).rows.length > 0;
    if (listed) {
      throw refuse(409, 'ALREADY_HELD', 'the Account is already on the shared-area writer list', 'grantee', '4.2', 'a listed Account is refused');
    }
    const targetId = `${source.id}:organisation`;
    return {
      targetType: 'knowledge.shared_writer', targetId, targetObjects: null, grantee,
      before: { listed: false }, requested: { sourceId: source.id, scope: 'organisation', accountId: grantee.id, expiresAt },
      objects: [{ objectId: targetId, ownerIds: [] }], scope: { projectIds: [], reportIds: [], groupIds: [] },
      lifetime: { choice: 'until-date', revertAt: expiresAt }, subject: `knowledge.shared_writer on ${source.slug}`,
    };
  }

  // ── slice S4: the identity targets ─────────────────────────────────────

  /** The change keys a target carries, refused by name otherwise. */
  private onlyKeys(change: Record<string, unknown>, targetType: string, allowed: readonly string[]): void {
    const unknown = Object.keys(change).filter((key) => !allowed.includes(key)).sort();
    if (unknown.length > 0) {
      throw refuse(422, 'INVALID_ACCESS_REQUEST',
        `a ${targetType} change carries ${allowed.length > 0 ? allowed.join(', ') : 'nothing'} only (got ${unknown.join(', ')})`,
        'requester', '3', `the ${targetType} spec is {${allowed.join(', ')}}`, { fields: unknown });
    }
  }

  /** A revoke-shaped spec: {} or {revoke: true}. */
  private revokeShape(change: Record<string, unknown>, targetType: string): void {
    if (Object.keys(change).length > 0 && !(Object.keys(change).length === 1 && change.revoke === true)) {
      throw refuse(422, 'INVALID_ACCESS_REQUEST', `a ${targetType} change is {} or {revoke: true}`, 'requester', '3',
        'the revoke spec names nothing else');
    }
  }

  /** section 4.1: a target only root or an administrator files (the root-ceiling identity acts). */
  private administrativeTierOnly(ctx: { tier: Tier }, targetType: ChangeTargetType, why: string): void {
    if (ctx.tier === 'user') {
      throw refuse(403, 'REQUEST_STANDING_NONE', `an ordinary user has no standing to ask for ${targetType}: ${why}`,
        'requester', '4.1', `${targetType} is filed by root or an administrator`, { tier: ctx.tier });
    }
  }

  /**
   * A principal the filer may name as a target (section 4.2): inside its own
   * Account subtree, or (root and an administrator) read in the directory.
   * An absent or unreadable principal answers TARGET_NOT_FOUND alike; a Group
   * is managed only on /groups.
   */
  private async targetPrincipal(raw: unknown, ctx: { accountId: string; tier: Tier; filer: AuthorizationActor }, what: string): Promise<any> {
    const id = typeof raw === 'string' && UUID_PATTERN.test(raw) ? lower(raw) : null;
    const row = id ? (await pool.query(
      `SELECT id, handle, kind, role, status, legacy_identity, parent_principal_id FROM principals WHERE id = $1`, [id])).rows[0] : null;
    if (!row || !(await this.principalReadable(ctx.filer, ctx.accountId, String(row.id), ctx.tier))) {
      throw refuse(404, 'TARGET_NOT_FOUND', `the ${what} resolves to no principal within your standing`, 'target', '4.2',
        'the target exists and lies within the filer\'s standing');
    }
    if (row.kind === 'group') {
      throw refuse(422, 'GROUP_PRINCIPAL_MANAGED_BY_GROUPS', 'a Group principal is managed only through /groups (AZ-A12 clause 2)',
        'target', '3', 'a Group\'s lifecycle runs on /groups');
    }
    return row;
  }

  /**
   * identity.role (section 3; section 4.1 rows 1-4; section 12 Q4 (a)): one
   * principal's role, applied by the role-change seam with the decider as the
   * issuer. Root and an administrator name any principal they read; an
   * ordinary user asks for its OWN Account only, and only within ceiling
   * class 2 (never an elevated role). The act's own refusals (the internal
   * actor, the break-glass identity, an elevated role on anything but a
   * parentless human Account) answer at filing as they would at decide.
   */
  private async resolveIdentityRole(input: ChangeFilingInput, change: Record<string, unknown>,
    ctx: { accountId: string; tier: Tier; filer: AuthorizationActor }): Promise<Filing> {
    const row = await this.targetPrincipal(input.targetId, ctx, 'principal whose role changes');
    if (ctx.tier === 'user' && lower(String(row.id)) !== lower(ctx.accountId)) {
      throw refuse(422, 'GRANTEE_NOT_ADMISSIBLE', "an ordinary user asks for its own Account's role only", 'requester', '4.1',
        "an ordinary user's role request names its own Account", { tier: ctx.tier });
    }
    if (row.legacy_identity) throw refuse(409, 'LEGACY_FROZEN', 'a legacy identity is frozen out (§10, T37)', 'target', '4.2', 'the target is non-legacy');
    if (row.status !== 'active') {
      throw refuse(409, 'GRANTEE_DISABLED', `the principal is ${row.status}`, 'target', '4.2', 'the target is an active principal');
    }
    this.onlyKeys(change, 'identity.role', ['role']);
    let role: string;
    try {
      role = assignableRole(change.role, String(row.id));
    } catch (e) {
      throw asChangeRefusal(e, 'requester', '3');
    }
    if (role === (row.role ?? null)) {
      throw refuse(409, 'ALREADY_HELD', `the principal already holds the role '${role}'`, 'target', '4.2', 'a role the principal holds is refused');
    }
    if (ctx.tier === 'user' && ELEVATED_ROLES.has(role)) {
      throw refuse(422, 'EXCEEDS_ROLE_CEILING', `an ordinary user asks for a role within ceiling class 2 only: '${role}' is an elevated role`,
        'requester', '4.1', "an ordinary user's own role request stays within ceiling class 2 (section 12 Q4 (a))", { role });
    }
    const target = { id: String(row.id), handle: String(row.handle), kind: String(row.kind),
      parentPrincipalId: row.parent_principal_id ? String(row.parent_principal_id) : null };
    // The act's refusals that do not depend on the decider (its ceiling is read at decide).
    const problem = roleChangeProblem(target, role, { principalId: null, issuerRole: 'admin' });
    if (problem) throw asChangeRefusal(problem, 'target', '3');
    return {
      targetType: 'identity.role', targetId: target.id, targetObjects: null, grantee: null,
      before: { role: row.role ?? null, status: String(row.status), handle: target.handle, kind: target.kind },
      requested: { role },
      objects: [{ objectId: `principal:${target.id}`, ownerIds: [] }],
      scope: { projectIds: [], reportIds: [], groupIds: [] },
      lifetime: { choice: 'keep' }, subject: `identity.role of ${target.handle} to ${role}`,
    };
  }

  /**
   * identity.create (section 3; section 12 Q9 (a)): a local user or a service
   * Account, created by the decider through PrincipalService.createPrincipal;
   * a new Connector's first credential stays a direct human act after
   * creation, never a secret through a decision. Filed by root or an
   * administrator; decided by a root session only (section 5.1 (4)). The
   * target is the requested handle (`handle:<handle>`).
   */
  private async resolveIdentityCreate(input: ChangeFilingInput, change: Record<string, unknown>, ctx: { tier: Tier }): Promise<Filing> {
    this.administrativeTierOnly(ctx, 'identity.create', 'a new Account is the root owner-plane act');
    this.onlyKeys(change, 'identity.create', IDENTITY_CREATE_FIELDS);
    const handleCheck = validateNewHandle(change.handle);
    if (!handleCheck.ok) {
      throw refuse(422, 'INVALID_HANDLE', handleCheck.error, 'requester', '3', 'the handle follows the POST /principals rules');
    }
    const handle = handleCheck.handle;
    if (present(input.targetId) && input.targetId !== `handle:${handle}`) {
      throw refuse(422, 'INVALID_ACCESS_REQUEST', "targetId is omitted or 'handle:<the requested handle>'", 'requester', '2.1',
        'the identity.create target is the requested handle');
    }
    if (change.kind === 'agent') {
      throw refuse(422, 'AGENT_MINT_ONLY', 'Agent identities arrive through the delegation machinery (design 4d961e37 §3); identity.create creates Accounts',
        'requester', '3', 'identity.create creates a human or a service Account');
    }
    if (change.kind !== 'human' && change.kind !== 'service') {
      throw refuse(422, 'INVALID_ACCESS_REQUEST', "kind is 'human' or 'service'", 'requester', '3', 'identity.create creates a human or a service Account');
    }
    const purpose = typeof change.purpose === 'string' ? change.purpose.trim() : '';
    if (change.kind === 'service' && !purpose) {
      throw refuse(422, 'PURPOSE_REQUIRED', 'service Accounts must declare a purpose at creation (design 4d961e37 A17.1)', 'requester', '3',
        'a service Account declares its purpose');
    }
    if (purpose.length > 500) throw refuse(422, 'INVALID_PURPOSE', 'purpose must be at most 500 characters', 'requester', '3', 'purpose is at most 500 characters');
    let displayName: string | null = null;
    if (present(change.displayName)) {
      if (typeof change.displayName !== 'string' || change.displayName.length > 200) {
        throw refuse(422, 'INVALID_ACCESS_REQUEST', 'displayName is a string of at most 200 characters', 'requester', '3', 'the display name is text');
      }
      displayName = change.displayName;
    }
    let role: string | null = null;
    if (present(change.role)) {
      try {
        role = assignableRole(change.role, null);
      } catch (e) {
        throw asChangeRefusal(e, 'requester', '3');
      }
      if (ELEVATED_ROLES.has(role) && change.kind !== 'human') {
        throw refuse(422, 'ELEVATED_ROLE_REQUIRES_ACCOUNT', 'an elevated role belongs only to a parentless human Account (design 4d961e37 §7.1)',
          'requester', '3', 'an elevated role is a human Account\'s');
      }
    }
    const taken = (await pool.query('SELECT 1 FROM principals WHERE lower(handle) = lower($1)', [handle])).rows.length > 0;
    if (taken) throw refuse(409, 'ALREADY_HELD', 'a principal with that handle already exists', 'target', '4.2', 'the handle is free');
    return {
      targetType: 'identity.create', targetId: `handle:${handle}`, targetObjects: null, grantee: null,
      before: { exists: false },
      requested: { kind: change.kind, handle, displayName, role, purpose: purpose || null },
      objects: [{ objectId: `principal-handle:${handle}`, ownerIds: [] }],
      scope: { projectIds: [], reportIds: [], groupIds: [] },
      lifetime: { choice: 'keep' }, subject: `identity.create of ${change.kind} ${handle}`,
    };
  }

  /**
   * identity.status (section 3; section 12 Q31 (a)): disable or enable one
   * principal through the ONE account-status seam both doors call. Filed by
   * root or an administrator; decided by a root session only.
   */
  private async resolveIdentityStatus(input: ChangeFilingInput, change: Record<string, unknown>,
    ctx: { accountId: string; tier: Tier; filer: AuthorizationActor }): Promise<Filing> {
    this.administrativeTierOnly(ctx, 'identity.status', "an Account's status is the root owner-plane act");
    const row = await this.targetPrincipal(input.targetId, ctx, 'principal whose status changes');
    if (row.status === 'terminated') {
      throw refuse(409, 'TARGET_TERMINATED', 'a terminated principal is one-way: its status never changes', 'target', '3', 'the target is not terminated');
    }
    this.onlyKeys(change, 'identity.status', ['status']);
    if (change.status !== 'active' && change.status !== 'disabled') {
      throw refuse(422, 'STATUS_REQUIRED', "status is 'active' or 'disabled'", 'requester', '3', 'the identity.status spec is {status}');
    }
    const refusal = accountStatusRefusal(String(row.handle), change.status);
    if (refusal) throw refuse(422, refusal.code, refusal.message, 'target', '3', 'the internal actor and the dashboard login identity are never disabled');
    if (change.status === row.status) {
      throw refuse(409, 'ALREADY_HELD', `the principal is already ${row.status}`, 'target', '4.2', 'a status the principal holds is refused');
    }
    return {
      targetType: 'identity.status', targetId: String(row.id), targetObjects: null, grantee: null,
      before: { status: String(row.status), handle: String(row.handle), kind: String(row.kind) },
      requested: { status: change.status },
      objects: [{ objectId: `principal:${lower(String(row.id))}`, ownerIds: [] }],
      scope: { projectIds: [], reportIds: [], groupIds: [] },
      lifetime: { choice: 'keep' }, subject: `identity.status of ${row.handle} to ${change.status}`,
    };
  }

  /**
   * credential.revoke (section 3, the protective direction): another
   * principal's credential, revoked by PrincipalService.revokeCredentialById
   * in the decide transaction. The credential the filer presents is revoked
   * directly (self-service), never through a request.
   */
  private async resolveCredentialRevoke(input: ChangeFilingInput, change: Record<string, unknown>,
    ctx: { accountId: string; tier: Tier; filer: AuthorizationActor }): Promise<Filing> {
    const id = typeof input.targetId === 'string' && UUID_PATTERN.test(input.targetId) ? lower(input.targetId) : null;
    const row = id ? (await pool.query(
      `SELECT id, principal_id, credential_type, key_id, label, revoked_at, expires_at FROM principal_credentials WHERE id = $1`, [id])).rows[0] : null;
    if (!row || !(await this.principalReadable(ctx.filer, ctx.accountId, String(row.principal_id), ctx.tier))) {
      throw refuse(404, 'TARGET_NOT_FOUND', 'the credential resolves to no row within your standing', 'target', '4.2',
        'the target exists and lies within the filer\'s standing');
    }
    if (input.requestingCredentialId && lower(String(input.requestingCredentialId)) === lower(String(row.id))) {
      throw refuse(422, 'KIND_NOT_FILABLE_HERE', 'the credential you present is revoked directly (POST /credentials/{id}/revoke), never through a request',
        'requester', '3', 'self-service revocation is the direct door');
    }
    if (row.credential_type === 'legacy_env') throw refuse(409, 'LEGACY_FROZEN', 'a legacy credential is frozen (§10, T37)', 'target', '4.2', 'the target is non-legacy');
    if (row.revoked_at || (row.expires_at && new Date(row.expires_at).getTime() <= Date.now())) {
      throw refuse(409, 'ALREADY_HELD', 'the credential is already revoked or expired: nothing to revoke', 'target', '4.2', 'only a live credential is revoked');
    }
    this.revokeShape(change, 'credential.revoke');
    return {
      targetType: 'credential.revoke', targetId: String(row.id), targetObjects: null, grantee: null,
      before: { credentialId: String(row.id), keyId: row.key_id ?? null, label: row.label ?? null,
        holderPrincipalId: String(row.principal_id), revoked: false },
      requested: { revoke: true },
      objects: [{ objectId: `credential:${lower(String(row.id))}`, ownerIds: [] }],
      scope: { projectIds: [], reportIds: [], groupIds: [] },
      lifetime: { choice: 'keep' }, subject: `credential.revoke of credential ${row.key_id ?? row.id}`,
    };
  }

  /**
   * warrant.create (section 3; R9 clause 17): a warrant created by the
   * DECIDER through WarrantService.create, its ceiling contained in the
   * decider's authority (section 5.1 (5)). Filed by any principal within its
   * standing: root and an administrator for a holder they read, an ordinary
   * user for a holder in its own Account subtree (the subtree a person's own
   * session warrants directly). The spec is validated now by the creation
   * validators; an anchor the filer cannot read answers exactly as an absent one.
   */
  private async resolveWarrantCreate(input: ChangeFilingInput, change: Record<string, unknown>,
    ctx: { accountId: string; tier: Tier; filer: AuthorizationActor; actor: AuditActor }): Promise<Filing> {
    this.onlyKeys(change, 'warrant.create', WARRANT_CREATE_FIELDS);
    const holderRaw = present(input.targetId) ? input.targetId : change.holderPrincipalId;
    if (present(input.targetId) && present(change.holderPrincipalId) && lower(String(input.targetId)) !== lower(String(change.holderPrincipalId))) {
      throw refuse(422, 'INVALID_ACCESS_REQUEST', 'targetId and change.holderPrincipalId name the same holder', 'requester', '2.1',
        'the warrant.create target is its holder');
    }
    const holder = await this.targetPrincipal(holderRaw, ctx, 'warrant holder');
    if (Array.isArray(change.anchors)) {
      for (const anchor of change.anchors as Array<Record<string, unknown>>) {
        const type = anchor?.anchorType;
        const anchorId = anchor?.anchorId;
        if ((type === 'task' || type === 'phase' || type === 'project') && typeof anchorId === 'string' && UUID_PATTERN.test(anchorId)) {
          const readable = await authorizationRepository.authorizedIds(ctx.filer, type, [lower(anchorId)], 'read');
          if (!readable.has(lower(anchorId))) {
            throw refuse(422, 'ANCHOR_NOT_FOUND', `${type} anchor ${anchorId} resolves to no row`, 'target', '4.2', 'every anchor exists and is readable by the filer');
          }
        }
      }
    }
    const spec: Record<string, unknown> = {};
    for (const field of WARRANT_CREATE_FIELDS) if (change[field] !== undefined) spec[field] = change[field];
    spec.holderPrincipalId = String(holder.id);
    let prepared;
    try {
      // The creation validators, with the containment left to the decider (section 5.1 (5)).
      prepared = await warrantService.previewCreate(spec as never, { principalId: input.requesterPrincipalId, isRoot: true, sessionScopes: null, stepUp: null }, ctx.actor);
    } catch (e) {
      if (e instanceof WarrantError) throw refuse(e.status, e.code, e.message, 'requester', '3', 'the warrant creation validators admit the spec');
      if (e instanceof AccessProfileError) throw refuse(422, 'INVALID_ACCESS_RULE', e.message, 'requester', '3', 'each ceiling rule is well formed');
      throw e;
    }
    spec.expiresAt = prepared.expiresAt;
    spec.transportPin = prepared.transportPin;
    return {
      targetType: 'warrant.create', targetId: String(holder.id), targetObjects: null, grantee: null,
      before: { holder: { principalId: String(holder.id), handle: String(holder.handle), status: String(holder.status) } },
      requested: spec,
      objects: [{ objectId: `warrant-holder:${lower(String(holder.id))}`, ownerIds: [] }],
      scope: { projectIds: [], reportIds: [], groupIds: [] },
      lifetime: { choice: 'keep' }, subject: `warrant.create for ${holder.handle}`,
    };
  }

  /**
   * warrant.edit, warrant.revoke and warrant.resume on an existing warrant
   * (section 3): an edit is applied by AuthorityEditExecutor with the decider's
   * standing (its pin never loosened through a request, AZ-A13 clause 9d), a
   * revoke and a resume by WarrantService in the decide transaction. The
   * warrant is read through its holder: inside the filer's own Account
   * subtree, or in the directory for root and an administrator. The tasks a
   * ceiling edit or a revoke would release are counted in the before-state,
   * so the decider approves that count and the stale check holds it.
   */
  private async resolveWarrantObject(targetType: 'warrant.edit' | 'warrant.revoke' | 'warrant.resume', input: ChangeFilingInput,
    change: Record<string, unknown>, ctx: { accountId: string; tier: Tier; filer: AuthorizationActor; actor: AuditActor }): Promise<Filing> {
    const id = typeof input.targetId === 'string' && UUID_PATTERN.test(input.targetId) ? lower(input.targetId) : null;
    const locked = id ? await authorityEditExecutor.lockObject(pool, 'warrant', id, false) : null;
    if (!locked || !(await this.principalReadable(ctx.filer, ctx.accountId, String(locked.holderPrincipalId), ctx.tier))) {
      throw refuse(404, 'TARGET_NOT_FOUND', 'the warrant resolves to no row within your standing', 'target', '4.2',
        'the target exists and lies within the filer\'s standing');
    }
    const status = String(locked.row.status);
    const dependentTaskCount = (await accessVehicleService.dependentOpenTasks(locked.id)).length;
    const base = { status, holderPrincipalId: String(locked.holderPrincipalId), dependentTaskCount };
    let before: Record<string, unknown> = base;
    let requested: Record<string, unknown>;
    if (targetType === 'warrant.edit') {
      const problem = await authorityEditExecutor.editableProblem(pool, locked);
      if (problem) throw asChangeRefusal(problem, 'target', '3');
      this.onlyKeys(change, 'warrant.edit', EDITABLE_FIELDS.warrant);
      let target;
      try {
        target = await authorityEditExecutor.target(locked, change, ctx.actor);
      } catch (e) {
        throw asChangeRefusal(e, 'requester', '3');
      }
      if (target.classification.changed.length === 0) {
        throw refuse(422, 'EDIT_NO_CHANGE', 'the requested warrant edit changes nothing', 'requester', '3', 'a change changes at least one field');
      }
      if (target.classification.moves.transportPin === 'up') {
        throw refuse(422, 'TRANSPORT_NOT_REQUESTABLE',
          'a transport pin is never loosened through a request (AZ-A13 clause 9d): root or an administrator loosens it on the direct door',
          'requester', '3', 'credential.transport is OUT');
      }
      before = { ...(locked.state as unknown as Record<string, unknown>), ...base };
      requested = { ...change };
    } else if (targetType === 'warrant.revoke') {
      if (status === 'revoked') throw refuse(409, 'ALREADY_HELD', 'the warrant is already revoked', 'target', '4.2', 'a revoked warrant needs no revocation');
      if (status === 'expired') throw refuse(409, 'WARRANT_EXPIRED', 'an expired warrant is one-way (§6.2) and needs no revocation', 'target', '3', 'an expired warrant is one-way');
      this.revokeShape(change, 'warrant.revoke');
      requested = { revoke: true };
    } else {
      if (status !== 'suspended') {
        throw refuse(409, 'WARRANT_NOT_SUSPENDED', `only a suspended warrant resumes (status: ${status})`, 'target', '3', 'a resume names a suspended warrant');
      }
      this.onlyKeys(change, 'warrant.resume', ['resume']);
      before = { ...base, suspendedReason: locked.row.suspended_reason ?? null };
      requested = { resume: true };
    }
    return {
      targetType, targetId: locked.id, targetObjects: null, grantee: null, before, requested,
      objects: [{ objectId: `warrant:${locked.id}`, ownerIds: [] }],
      scope: { projectIds: [], reportIds: [], groupIds: [] },
      lifetime: { choice: 'keep' }, subject: `${targetType} of warrant ${String(locked.row.name ?? locked.id)}`,
    };
  }

  // ── slice S5: the object targets ───────────────────────────────────────

  /**
   * THE STATE OF ONE OBJECT a change of `targetType` is about, in the shape
   * the request stores as `before` (section 6): the filing reads it, the stale
   * check re-reads it under the row lock (`lock`), and they are compared by
   * value, so a decision never applies to an object that moved after the
   * preview. Null when the object is absent (a tombstoned Report included).
   */
  async objectState(q: Queryable, targetType: string, id: string, lock = false): Promise<Record<string, unknown> | null> {
    const forUpdate = lock ? ' FOR UPDATE' : '';
    const id8 = (value: unknown): string | null => (value ? lower(String(value)) : null);
    if (targetType === 'project.owner') {
      const row = (await q.query(`SELECT p.owner_principal_id, o.kind AS owner_kind FROM projects p
          LEFT JOIN principals o ON o.id = p.owner_principal_id WHERE p.id = $1${lock ? ' FOR UPDATE OF p' : ''}`, [id])).rows[0];
      return row ? { ownerPrincipalId: id8(row.owner_principal_id), ownerKind: row.owner_kind ?? null } : null;
    }
    if (targetType === 'task.account_owner') {
      const row = (await q.query(`SELECT t.account_owner_principal_id, COALESCE(t.account_owner_principal_id, p.owner_principal_id) AS effective_owner,
                 o.kind AS owner_kind
            FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
            LEFT JOIN principals o ON o.id = COALESCE(t.account_owner_principal_id, p.owner_principal_id)
           WHERE t.id = $1${lock ? ' FOR UPDATE OF t' : ''}`, [id])).rows[0];
      return row ? {
        accountOwnerPrincipalId: id8(row.effective_owner), explicitAccountOwnerPrincipalId: id8(row.account_owner_principal_id),
        ownerKind: row.owner_kind ?? null,
      } : null;
    }
    if (targetType === 'report.account_owner' || targetType === 'report.visibility') {
      const row = (await q.query(`SELECT account_owner_principal_id, author_principal_id, visibility, deleted_at FROM reports
          WHERE id = $1${forUpdate}`, [id])).rows[0];
      if (!row || row.deleted_at) return null;
      return targetType === 'report.visibility' ? { visibility: String(row.visibility || 'default') }
        : { accountOwnerPrincipalId: id8(row.account_owner_principal_id), authorPrincipalId: id8(row.author_principal_id) };
    }
    if (targetType === 'project.default_verifier' || targetType === 'phase.default_verifier') {
      const row = (await q.query(`SELECT default_verifier_principal_id FROM ${targetType === 'project.default_verifier' ? 'projects' : 'phases'}
          WHERE id = $1${forUpdate}`, [id])).rows[0];
      return row ? { defaultVerifierPrincipalId: id8(row.default_verifier_principal_id) } : null;
    }
    if (targetType === 'charter.revision') {
      const project = (await q.query(`SELECT id FROM projects WHERE id = $1${forUpdate}`, [id])).rows[0];
      if (!project) return null;
      const head = (await q.query(`SELECT version, content, content_hash FROM project_charters WHERE project_id = $1${forUpdate}`, [id])).rows[0];
      return { version: head ? Number(head.version) : null, contentHash: head?.content_hash ?? null, content: head?.content ?? null };
    }
    if (targetType === 'phase.goal' || targetType === 'phase.access') {
      const row = (await q.query(`SELECT goal, restricted_access FROM phases WHERE id = $1${forUpdate}`, [id])).rows[0];
      if (!row) return null;
      return targetType === 'phase.goal' ? { goal: row.goal ?? null } : { restricted: Boolean(row.restricted_access) };
    }
    if (targetType === 'task.roles' || targetType === 'task.access') {
      const row = (await q.query(`SELECT shepherd_principal_id, verifier_principal_id, restricted_access FROM tasks WHERE id = $1${forUpdate}`, [id])).rows[0];
      if (!row) return null;
      return targetType === 'task.access' ? { restricted: Boolean(row.restricted_access) }
        : { shepherdPrincipalId: id8(row.shepherd_principal_id), verifierPrincipalId: id8(row.verifier_principal_id) };
    }
    return null;
  }

  /**
   * An owner a change names (project.owner, task.account_owner,
   * report.account_owner): an active, non-legacy, parentless human Account
   * whose role reads and writes the object's family, or (where `groups`) an
   * active Group principal. A principal the filer cannot read in the
   * directory is answered exactly as one that does not exist.
   */
  private async ownerValue(raw: unknown, family: 'projects' | 'tasks' | 'reports', groups: boolean,
    ctx: { accountId: string; tier: Tier; filer: AuthorizationActor }, targetType: string): Promise<{ id: string; kind: string }> {
    if (!present(raw)) {
      throw refuse(422, 'OWNER_REQUIRED', `a ${targetType} change names the new owner`, 'requester', '3', `the ${targetType} spec names its owner`);
    }
    const invalid = () => refuse(422, 'INVALID_OWNER', `the new owner is an active human Account${groups ? ' or an active Group' : ''} you can name`,
      'requester', '3', `the owner is an active human Account${groups ? ' or an active Group' : ''}`);
    if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) throw invalid();
    const id = lower(raw);
    const row = (await pool.query(
      'SELECT id, handle, kind, role, status, legacy_identity, parent_principal_id FROM principals WHERE id = $1', [id])).rows[0];
    if (!row) throw invalid();
    if (row.kind === 'group') {
      if (!groups || row.status !== 'active' || !this.directoryReadable(ctx.filer, 'groups', id)) throw invalid();
      return { id, kind: 'group' };
    }
    if (!(await this.principalReadable(ctx.filer, ctx.accountId, id, ctx.tier, true))) throw invalid();
    if (row.kind !== 'human' || row.status !== 'active' || row.legacy_identity || row.parent_principal_id) throw invalid();
    const scopes = scopesForRole(resolveActorRole({ handle: String(row.handle ?? ''), principalRole: row.role ?? null })) as string[];
    if (!scopesSatisfy(scopes, `${family}:read` as never) || !scopesSatisfy(scopes, `${family}:write` as never)) {
      throw refuse(422, 'INEFFECTIVE_OWNER', `the selected Account cannot read and write ${family}`, 'requester', '3',
        'the owner can act on what it owns');
    }
    return { id, kind: 'human' };
  }

  /**
   * The Shepherd and Verifier a task.roles change names, checked as the roles
   * route checks them (a Group never acts, an inactive principal is no role
   * holder, an Agent holds roles only on its bound Task, a Verifier passes
   * the usable predicate and is never the Assignee): at filing on the filer's
   * view, and again at decide, where the state may have moved.
   */
  async taskRoleProblem(q: Queryable, taskId: string, spec: Record<string, unknown>): Promise<{ status: number; code: string; message: string } | null> {
    const named = [spec.shepherdPrincipalId, spec.verifierPrincipalId].filter((v): v is string => typeof v === 'string');
    for (const id of named) {
      const row = (await q.query('SELECT id, kind, status, legacy_identity, bound_task_id FROM principals WHERE id = $1', [id])).rows[0];
      if (row?.kind === 'group') {
        return { status: 422, code: 'TASK_ROLE_GROUP_PRINCIPAL', message: 'A Group principal never acts (AZ-A12 clause 3c): it cannot be a Task Shepherd or Verifier' };
      }
      if (!row || row.status !== 'active') return { status: 422, code: 'TASK_ROLE_PRINCIPAL_UNAVAILABLE', message: 'Every assigned Task role must resolve to an active Principal' };
      if (row.kind === 'agent' && !row.legacy_identity && row.bound_task_id && lower(String(row.bound_task_id)) !== lower(taskId)) {
        return { status: 422, code: 'CROSS_BOUND_ROLE', message: 'An Agent identity is task-bounded: it can hold roles only on its bound Task' };
      }
    }
    if (typeof spec.verifierPrincipalId === 'string') {
      const usability = await principalVerifierUsability(q, spec.verifierPrincipalId);
      if (!usability.usable) {
        return { status: 422, code: 'TASK_VERIFIER_UNUSABLE', message: `The principal cannot judge this card (${usability.failedArm ?? 'principal'})` };
      }
      const task = (await q.query('SELECT owner_principal_id FROM tasks WHERE id = $1', [taskId])).rows[0];
      if (task?.owner_principal_id && lower(String(task.owner_principal_id)) === lower(spec.verifierPrincipalId)) {
        return { status: 409, code: 'CLAIMANT_VERIFIER_CONFLICT', message: 'The Assignee and Verifier must be different Principals' };
      }
    }
    return null;
  }

  /**
   * THE S5 OBJECT TARGETS AT FILING (section 3; section 4.1 row 3; section
   * 4.2). The object is read through the FILER's own live authority (an
   * unreadable object answers exactly as an absent one, TARGET_NOT_FOUND),
   * located with its stored owner value, and the standing runs on it BEFORE
   * any content check (an ordinary user files only as the object's owner
   * tier; task.account_owner is root's or an administrator's alone). Then the
   * change is validated exactly as its direct act validates it, so nothing a
   * decider could never apply is filed.
   */
  private async resolveObjectTarget(targetType: ChangeTargetType, input: ChangeFilingInput, change: Record<string, unknown>, ctx: {
    accountId: string; tier: Tier; filer: AuthorizationActor; standing: StandingCheck;
  }): Promise<Filing> {
    const type = S5_OBJECT_TYPE[targetType];
    const id = typeof input.targetId === 'string' && UUID_PATTERN.test(input.targetId) ? lower(input.targetId) : null;
    const absent = () => refuse(404, 'TARGET_NOT_FOUND', `the ${type} resolves to no row`, 'target', '4.2', 'the target exists and is readable by the filer');
    if (!id || !(await authorizationRepository.authorizedIds(ctx.filer, type, [id], 'read')).has(id)) throw absent();
    const before = await this.objectState(pool, targetType, id);
    if (!before) throw absent();
    const located = await this.locateObjects(pool, [{ type, id }]);
    // section 4.1: the standing, on the located object, before any content check.
    await ctx.standing({ objects: located.objects });
    const status = (await pool.query(`SELECT status FROM ${OBJECT_TABLES[type]} WHERE id = $1`, [id])).rows[0]?.status;
    if (status === 'archived') {
      throw refuse(409, `${type.toUpperCase()}_ARCHIVED`, `the ${type} is archived and read-only: restore it first`, 'target', '3', 'the object is live');
    }
    let requested: Record<string, unknown>;
    const held = (what: string) => refuse(409, 'ALREADY_HELD', what, 'target', '4.2', 'a change to the value the object already holds is refused');
    if (targetType === 'project.owner' || targetType === 'task.account_owner' || targetType === 'report.account_owner') {
      const field = targetType === 'project.owner' ? 'ownerPrincipalId' : 'accountOwnerPrincipalId';
      this.onlyKeys(change, targetType, [field]);
      if (type === 'report') {
        const report = (await pool.query('SELECT origin, source_task_id FROM reports WHERE id = $1', [id])).rows[0];
        if (report?.origin === 'task-report' || report?.source_task_id) {
          throw refuse(422, 'REPORT_TASK_BOUND', 'a task-bound Report is never account-owned: it belongs to its Task', 'target', '3',
            'report.account_owner moves a standalone Report only (R1-F04)');
        }
      }
      const owner = await this.ownerValue(change[field], type === 'project' ? 'projects' : type === 'task' ? 'tasks' : 'reports',
        type !== 'report', ctx, targetType);
      const current = targetType === 'task.account_owner' ? before.explicitAccountOwnerPrincipalId : before[field];
      if (current === owner.id) throw held(`that ${owner.kind === 'group' ? 'Group' : 'Account'} already owns the ${type}`);
      requested = type === 'report' ? { [field]: owner.id } : { [field]: owner.id, ownerKind: owner.kind };
    } else if (targetType === 'project.default_verifier' || targetType === 'phase.default_verifier') {
      this.onlyKeys(change, targetType, ['defaultVerifierPrincipalId']);
      if (!('defaultVerifierPrincipalId' in change)) {
        throw refuse(422, 'VERIFIER_REQUIRED', `a ${targetType} change names the Verifier, or null to clear the default`, 'requester', '3',
          'the default-Verifier spec is {defaultVerifierPrincipalId}');
      }
      const raw = change.defaultVerifierPrincipalId;
      let next: string | null = null;
      if (raw !== null) {
        const invalid = () => refuse(422, 'INVALID_DEFAULT_VERIFIER', 'defaultVerifierPrincipalId is a person or Connector you can name, or null',
          'requester', '3', 'the default Verifier is a principal UUID or null');
        if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) throw invalid();
        next = lower(raw);
        const exists = (await pool.query('SELECT 1 FROM principals WHERE id = $1', [next])).rows.length > 0;
        const groupRow = (await pool.query("SELECT 1 FROM principals WHERE id = $1 AND kind = 'group'", [next])).rows.length > 0;
        // A principal (or Group) the filer cannot read in the directory answers exactly as an absent one.
        if (!exists || !(groupRow ? this.directoryReadable(ctx.filer, 'groups', next)
          : await this.principalReadable(ctx.filer, ctx.accountId, next, ctx.tier, true))) throw invalid();
        try {
          await objectExecutors().defaultVerifier.validateValue(pool, next);
        } catch (e) {
          throw asChangeRefusal(e, 'requester', '3');
        }
      }
      if (before.defaultVerifierPrincipalId === next) throw held('the object already has that default Verifier');
      requested = { defaultVerifierPrincipalId: next };
    } else if (targetType === 'charter.revision') {
      this.onlyKeys(change, targetType, ['content']);
      let content: string;
      try {
        content = objectExecutors().charter.validateContent(change.content);
      } catch (e) {
        throw asChangeRefusal(e, 'requester', '3');
      }
      const contentHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
      if (before.contentHash === contentHash) throw held('the approved Charter already has this content');
      requested = { content, contentHash };
    } else if (targetType === 'phase.goal') {
      this.onlyKeys(change, targetType, ['goal']);
      if (!('goal' in change)) throw refuse(422, 'GOAL_REQUIRED', 'a phase.goal change names the goal (null clears it)', 'requester', '3', 'the phase.goal spec is {goal}');
      let goal: string | null;
      try {
        goal = validateGoal(change.goal);
      } catch (e) {
        throw asChangeRefusal(e, 'requester', '3');
      }
      if ((before.goal ?? null) === goal) throw held('the Phase already has this goal');
      requested = { goal };
    } else if (targetType === 'task.roles') {
      this.onlyKeys(change, targetType, ['shepherdPrincipalId', 'verifierPrincipalId']);
      const shepherd = change.shepherdPrincipalId;
      const verifier = change.verifierPrincipalId;
      if (shepherd === undefined && verifier === undefined) {
        throw refuse(422, 'INVALID_TASK_ROLE', 'a task.roles change names a Shepherd, a Verifier, or both', 'requester', '3',
          'the task.roles spec is {shepherdPrincipalId?, verifierPrincipalId?}');
      }
      if (shepherd !== undefined && (typeof shepherd !== 'string' || !UUID_PATTERN.test(shepherd))) {
        throw refuse(422, 'INVALID_TASK_ROLE', 'shepherdPrincipalId must be a Principal UUID', 'requester', '3', 'a Shepherd is a principal');
      }
      if (verifier !== undefined && verifier !== null && (typeof verifier !== 'string' || !UUID_PATTERN.test(verifier))) {
        throw refuse(422, 'INVALID_TASK_ROLE', 'verifierPrincipalId must be a Principal UUID or null', 'requester', '3', 'a Verifier is a principal or none');
      }
      requested = {};
      if (shepherd !== undefined) requested.shepherdPrincipalId = lower(String(shepherd));
      if (verifier !== undefined) requested.verifierPrincipalId = verifier === null ? null : lower(String(verifier));
      for (const value of [requested.shepherdPrincipalId, requested.verifierPrincipalId]) {
        // A role holder (or Group) the filer cannot read is answered as one that does not exist.
        const isGroup = typeof value === 'string'
          && (await pool.query("SELECT 1 FROM principals WHERE id = $1 AND kind = 'group'", [value])).rows.length > 0;
        if (typeof value === 'string' && !(isGroup ? this.directoryReadable(ctx.filer, 'groups', value)
          : await this.principalReadable(ctx.filer, ctx.accountId, value, ctx.tier, true))) {
          throw refuse(422, 'TASK_ROLE_PRINCIPAL_UNAVAILABLE', 'Every assigned Task role must resolve to an active Principal', 'requester', '3',
            'a role holder is an active principal the filer can name');
        }
      }
      const problem = await this.taskRoleProblem(pool, id, requested);
      if (problem) throw refuse(problem.status, problem.code, problem.message, 'requester', '3', 'the roles route admits the holders');
      if (Object.keys(requested).every((key) => (before[key] ?? null) === requested[key])) throw held('the Task already has these role holders');
    } else if (targetType === 'task.access' || targetType === 'phase.access') {
      this.onlyKeys(change, targetType, ['restricted']);
      if (typeof change.restricted !== 'boolean') {
        throw refuse(422, 'RESTRICTED_REQUIRED', `a ${targetType} change is {restricted: true | false}`, 'requester', '3', `the ${targetType} spec is {restricted}`);
      }
      if (before.restricted === change.restricted) throw held(`the ${type} access policy already has the requested value`);
      requested = { restricted: change.restricted };
    } else {
      // report.visibility: ONLY the opening transition (section 3), of a standalone Report.
      const report = (await pool.query('SELECT origin, source_task_id FROM reports WHERE id = $1', [id])).rows[0];
      if (report?.origin === 'task-report' || report?.source_task_id) {
        throw refuse(422, 'REPORT_TASK_BOUND', "a task-bound Report's visibility follows its Task", 'target', '3', 'report.visibility opens a standalone Report');
      }
      this.onlyKeys(change, targetType, ['visibility']);
      if (typeof change.visibility !== 'string' || !change.visibility) {
        throw refuse(422, 'VISIBILITY_REQUIRED', 'a report.visibility change names the label it opens to', 'requester', '3', 'the report.visibility spec is {visibility}');
      }
      if (!OPEN_REPORT_VISIBILITY.includes(change.visibility) || OPEN_REPORT_VISIBILITY.includes(String(before.visibility))) {
        throw refuse(422, 'VISIBILITY_NOT_OPENING',
          `a request opens a closed Report to ${OPEN_REPORT_VISIBILITY.join(', ')}; any other label change is a content write (PATCH /reports/{id})`,
          'requester', '3', 'only the opening transition is requested (section 3)');
      }
      requested = { visibility: change.visibility };
    }
    return {
      targetType, targetId: id, targetObjects: null, grantee: null, before, requested,
      objects: located.objects, scope: located.scope, lifetime: { choice: 'keep' }, subject: `${targetType} of ${type} ${id}`,
    };
  }

  // ── shared filing checks ───────────────────────────────────────────────

  private admissibleReason(raw: unknown): string {
    const reason = typeof raw === 'string' ? raw.trim() : '';
    const length = [...reason].length;
    if (length < CHANGE_REASON_MIN || length > CHANGE_REASON_MAX) {
      throw refuse(422, 'INVALID_REASON', `reason is mandatory, ${CHANGE_REASON_MIN}-${CHANGE_REASON_MAX} characters (got ${length})`,
        'requester', '2.1', 'the reason is 20-2,000 characters');
    }
    return reason;
  }

  private async readableRelation(input: ChangeFilingInput): Promise<{ taskId: string | null; phaseId: string | null }> {
    const id = (value: unknown, field: string): string | null => {
      if (!present(value)) return null;
      if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
        throw refuse(422, 'INVALID_ACCESS_REQUEST', `${field} must be a full UUID`, 'requester', '7.4', 'related ids are UUIDs');
      }
      return lower(value);
    };
    const taskId = id(input.relatedTaskId, 'relatedTaskId');
    const phaseId = id(input.relatedPhaseId, 'relatedPhaseId');
    for (const [type, value] of [['task', taskId], ['phase', phaseId]] as const) {
      if (!value) continue;
      const readable = await authorizationRepository.authorizedIds(input.authorizationActor, type, [value], 'read');
      if (!readable.has(value)) {
        throw refuse(404, `${type.toUpperCase()}_NOT_FOUND`, `related ${type} resolves to no row`, 'requester', '7.4', `the related ${type} is readable by the requester`);
      }
      const status = (await pool.query(`SELECT status FROM ${type === 'task' ? 'tasks' : 'phases'} WHERE id = $1`, [value])).rows[0]?.status;
      if (['completed', 'archived'].includes(String(status))) {
        throw refuse(409, `RELATED_${type.toUpperCase()}_TERMINAL`, `the related ${type} is ${status}`, 'requester', '7.4', `the related ${type} is not terminal`);
      }
    }
    return { taskId, phaseId };
  }

  private async assertQuota(requesterId: string): Promise<void> {
    const quota = (await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
              COUNT(*) FILTER (WHERE requested_at > NOW() - INTERVAL '24 hours')::int AS daily
         FROM approvals WHERE requester_principal_id = $1
          AND NOT (kind = 'authority-edit' AND COALESCE(session_evidence->>'door', '') = 'one-act')`, [requesterId])).rows[0];
    if (Number(quota.pending) >= QUOTA_PENDING || Number(quota.daily) >= QUOTA_DAILY) {
      throw refuse(429, 'REQUEST_QUOTA_EXCEEDED',
        `request quota exceeded (${QUOTA_PENDING} pending / ${QUOTA_DAILY} per day, shared by every kind)`, 'requester', '4.2',
        'one quota across kinds', { pending: Number(quota.pending), daily: Number(quota.daily) });
    }
  }

  /** The caller's OWN pending change on any of these objects (the per-requester key), or null. */
  private async pendingFor(q: Queryable, filing: Filing, accountId: string): Promise<string | null> {
    const row = (await q.query(
      `SELECT approval_id FROM approval_change_objects
        WHERE pending AND target_type = $1 AND object_id = ANY($2::text[]) AND requester_account_id = $3
          AND grantee_type IS NOT DISTINCT FROM $4 AND grantee_principal_id IS NOT DISTINCT FROM $5::uuid
        ORDER BY approval_id LIMIT 1`,
      [filing.targetType, filing.objects.map((o) => o.objectId), accountId, filing.grantee?.type ?? null, filing.grantee?.id ?? null])).rows[0];
    return row ? String(row.approval_id) : null;
  }

  private pendingRefusal(approvalId: string | null): ApprovalError {
    return refuse(409, 'CHANGE_PENDING',
      `you already have a pending change request on this object for this grantee${approvalId ? `: ${approvalId}` : ''}. Withdraw it, or wait for its decision`,
      'requester', '4.2', 'one pending change per (target, object, grantee, requester Account)', { approvalId });
  }

  private async assertNotPending(filing: Filing, accountId: string): Promise<void> {
    const pending = await this.pendingFor(pool, filing, accountId);
    if (pending) throw this.pendingRefusal(pending);
  }

  /**
   * One pending row and its child rows. The binding is EXACTLY ONE of the
   * filing credential (the bearer door) or the session evidence (the session
   * door, `{door: 'request', authMethod, standing}`), the XOR migration 158's
   * change arm holds (section 2.1).
   */
  private async insertFiling(client: PoolClient, input: ChangeFilingInput, filing: Filing, reason: string,
    related: { taskId: string | null; phaseId: string | null }, accountId: string,
    sessionEvidence: Record<string, unknown> | null): Promise<string> {
    const created = await client.query(
      `INSERT INTO approvals
         (kind, requester_principal_id, requesting_credential_id, session_evidence, grantee_principal_id, grantee_type,
          requested_scopes, requested_rules, reason, related_task_id, related_phase_id, pending_expires_at,
          target_type, target_id, target_objects, change_spec, scope_project_ids, scope_report_ids, scope_group_ids,
          requested_lifetime)
       VALUES ('change', $1, $2, $17::jsonb, $3, $4, '[]'::jsonb, '[]'::jsonb, $5, $6, $7, $8,
               $9, $10, $11::jsonb, $12::jsonb, $13::uuid[], $14::uuid[], $15::uuid[], $16::jsonb)
       RETURNING id`,
      [
        input.requesterPrincipalId, sessionEvidence ? null : input.requestingCredentialId,
        filing.grantee?.id ?? null, filing.grantee?.type ?? null,
        reason, related.taskId, related.phaseId, new Date(Date.now() + CHANGE_PENDING_TTL_MS),
        filing.targetType, filing.targetId, filing.targetObjects ? JSON.stringify(filing.targetObjects) : null,
        JSON.stringify({
          type: filing.targetType, before: filing.before, requested: filing.requested,
          ...(filing.unreadByFiler && filing.unreadByFiler.length > 0 ? { filing: { unreadByFiler: filing.unreadByFiler } } : {}),
        }),
        filing.scope.projectIds, filing.scope.reportIds, filing.scope.groupIds,
        filing.lifetime ? JSON.stringify(filing.lifetime) : null,
        sessionEvidence ? JSON.stringify(sessionEvidence) : null,
      ]);
    const approvalId = String(created.rows[0].id);
    for (const [ordinal, object] of filing.objects.entries()) {
      await client.query(
        `INSERT INTO approval_change_objects
           (approval_id, ordinal, target_type, object_id, owner_ids, grantee_type, grantee_principal_id, requester_account_id)
         VALUES ($1, $2, $3, $4, $5::uuid[], $6, $7, $8)`,
        [approvalId, ordinal, filing.targetType, object.objectId, object.ownerIds, filing.grantee?.type ?? null,
          filing.grantee?.id ?? null, accountId]);
    }
    return approvalId;
  }

  // ═════════════════════════════ PREVIEW ═════════════════════════════

  /**
   * "WHAT MAY I REQUEST HERE" (section 4.3). Runs the filing pipeline — the
   * section 4.1 standing and the section 4.2 validators — for each target type
   * that applies to the object named, and writes NOTHING: no audit row, no
   * approval, no quota count, no burned key. The answer lists what is
   * requestable (who may be named, the fields, the bound, the standings that
   * would decide it, the before-state) and what is refused, by code. It
   * discloses nothing about an object the caller cannot read: such an object
   * answers exactly as an absent one, and no decider standing derived from its
   * owner is shown. It never enumerates the knowledge registry: a compartment
   * is previewed only for the source the caller names.
   */
  async preview(input: ChangePreviewInput): Promise<ChangePreview> {
    const requestable: ChangePreview['requestable'] = [];
    const refused: ChangePreview['refused'] = [];
    const objectType = typeof input.objectType === 'string' ? input.objectType : null;
    const targetId = typeof input.targetId === 'string' ? input.targetId : null;
    let candidates: string[];
    if (present(input.targetType)) {
      candidates = [String(input.targetType)];
    } else if (objectType && PREVIEW_OBJECT_TYPES.includes(objectType)) {
      candidates = ['grant.rows', ...(objectType === 'project' && present(input.sourceId) ? ['knowledge.compartment'] : []),
        // slice S5: the object targets about this type of object.
        ...S5_TARGET_TYPES.filter((type) => S5_OBJECT_TYPE[type] === objectType)];
    } else {
      throw refuse(422, 'PREVIEW_TARGET_REQUIRED', 'name a targetType, or an objectType and targetId to preview what may be requested there',
        'requester', '4.3', `objectType is one of ${PREVIEW_OBJECT_TYPES.join(', ')}`);
    }
    const base: ChangeFilingInput = {
      requesterPrincipalId: input.requesterPrincipalId, requestingCredentialId: input.requestingCredentialId,
      authorizationActor: input.authorizationActor, door: input.door, session: input.session,
      granteePrincipalId: input.granteePrincipalId, granteeType: input.granteeType,
    };
    const attempt = async (body: Partial<ChangeFilingInput>): Promise<{ ok: EvaluatedFiling } | { code: string; refusal: Record<string, unknown> }> => {
      try {
        return { ok: await this.evaluateFiling({ ...base, ...body }, { dry: true }) };
      } catch (e) {
        if (e instanceof ApprovalError) return { code: e.code, refusal: e.refusal ?? {} };
        throw e;
      }
    };
    const refusedEntry = (targetType: string, code: string, refusal: Record<string, unknown>) => {
      refused.push({ targetType, code, ...(refusal.hint ? { hint: String(refusal.hint) } : {}) });
    };
    for (const targetType of candidates) {
      if (targetType === 'grant.rows' || targetType === 'knowledge.compartment') {
        if (!objectType || !targetId || !UUID_PATTERN.test(targetId)) {
          refusedEntry(targetType, 'PREVIEW_TARGET_REQUIRED', {});
          continue;
        }
        const options = targetType === 'grant.rows' ? REQUESTABLE_VERBS : ['read', 'write'];
        const admitted: string[] = [];
        let first: EvaluatedFiling | null = null;
        let refusal: { code: string; refusal: Record<string, unknown> } | null = null;
        for (const option of options) {
          const change = targetType === 'grant.rows'
            ? { rules: [{ resourceType: objectType, selectorForm: 'exact', selectorIds: [targetId], verbs: [option] }] }
            : { sourceId: input.sourceId, operation: option, projectIds: [targetId] };
          const answer = await attempt({ targetType, change });
          if ('ok' in answer) {
            admitted.push(option);
            first = first ?? answer.ok;
          } else {
            refusal = refusal ?? answer;
          }
        }
        if (!first) {
          refusedEntry(targetType, refusal?.code ?? 'REQUEST_STANDING_NONE', refusal?.refusal ?? {});
          continue;
        }
        requestable.push({
          targetType,
          grantees: await this.previewGrantees(first, input.authorizationActor),
          fields: targetType === 'grant.rows' ? ['rules', 'expiresAt'] : ['sourceId', 'operation', 'projectIds', 'expiresAt'],
          bound: { [targetType === 'grant.rows' ? 'verbs' : 'operations']: admitted, defaultExpiryDays: 14, maxExpiryDays: 90 },
          deciders: this.previewDeciders(targetType, first.filing),
          before: first.filing.before,
        });
        continue;
      }
      // An object-only target: the change content is the caller's to write, so
      // the preview stops at the first content check, after every standing and
      // target check has passed.
      const probe: Record<string, { change: Record<string, unknown>; contentCodes: string[]; fields: string[] }> = {
        'grant.edit': { change: {}, contentCodes: ['EDIT_NO_CHANGE'], fields: ['verb', 'expiresAt', 'resourceId'] },
        'grant.revoke': { change: {}, contentCodes: [], fields: [] },
        'credential.scopes': { change: {}, contentCodes: ['EDIT_NO_CHANGE'], fields: ['scopes'] },
        'credential.issue': { change: { scopes: [] }, contentCodes: ['SCOPES_REQUIRED'], fields: ['scopes', 'transport', 'label', 'expiresAt'] },
        'knowledge.shared_writer': { change: present(input.sourceId) ? { sourceId: input.sourceId } : {}, contentCodes: [], fields: ['expiresAt'] },
        // slice S4: every standing and target check runs; the content is the caller's.
        'identity.role': { change: {}, contentCodes: ['ROLE_REQUIRED'], fields: ['role'] },
        'identity.create': { change: {}, contentCodes: ['INVALID_HANDLE'], fields: [...IDENTITY_CREATE_FIELDS] },
        'identity.status': { change: {}, contentCodes: ['STATUS_REQUIRED'], fields: ['status'] },
        'credential.revoke': { change: {}, contentCodes: [], fields: [] },
        'warrant.create': { change: {}, contentCodes: ['INVALID_WARRANT_VALUE'], fields: WARRANT_CREATE_FIELDS.filter((f) => f !== 'holderPrincipalId') },
        'warrant.edit': { change: {}, contentCodes: ['EDIT_NO_CHANGE'], fields: [...EDITABLE_FIELDS.warrant] },
        'warrant.revoke': { change: {}, contentCodes: [], fields: [] },
        'warrant.resume': { change: {}, contentCodes: [], fields: [] },
        // slice S5: the object, its reading by the caller and the standing run; the content is the caller's.
        'project.owner': { change: {}, contentCodes: ['OWNER_REQUIRED'], fields: ['ownerPrincipalId'] },
        'task.account_owner': { change: {}, contentCodes: ['OWNER_REQUIRED'], fields: ['accountOwnerPrincipalId'] },
        'report.account_owner': { change: {}, contentCodes: ['OWNER_REQUIRED'], fields: ['accountOwnerPrincipalId'] },
        'project.default_verifier': { change: {}, contentCodes: ['VERIFIER_REQUIRED'], fields: ['defaultVerifierPrincipalId'] },
        'phase.default_verifier': { change: {}, contentCodes: ['VERIFIER_REQUIRED'], fields: ['defaultVerifierPrincipalId'] },
        'charter.revision': { change: {}, contentCodes: ['INVALID_CHARTER_VALUE'], fields: ['content'] },
        'phase.goal': { change: {}, contentCodes: ['GOAL_REQUIRED'], fields: ['goal'] },
        'task.roles': { change: {}, contentCodes: ['INVALID_TASK_ROLE'], fields: ['shepherdPrincipalId', 'verifierPrincipalId'] },
        'task.access': { change: {}, contentCodes: ['RESTRICTED_REQUIRED'], fields: ['restricted'] },
        'phase.access': { change: {}, contentCodes: ['RESTRICTED_REQUIRED'], fields: ['restricted'] },
        'report.visibility': { change: {}, contentCodes: ['VISIBILITY_REQUIRED'], fields: ['visibility'] },
      };
      const shape = probe[targetType];
      const answer = await attempt({ targetType, targetId: input.targetId, change: shape?.change ?? {} });
      if (!shape) {
        refusedEntry(targetType, 'ok' in answer ? 'TARGET_NOT_AVAILABLE' : answer.code, 'ok' in answer ? {} : answer.refusal);
        continue;
      }
      if ('ok' in answer || shape.contentCodes.includes(answer.code)) {
        // A content stop on an S5 target came after the caller read the object and
        // the standing admitted it, so its owner and its state are the caller's to see.
        const objectTarget = (S5_TARGET_TYPES as readonly string[]).includes(targetType) && !('ok' in answer) && typeof input.targetId === 'string'
          && UUID_PATTERN.test(input.targetId);
        const objectId = objectTarget ? lower(String(input.targetId)) : null;
        const located = objectId ? await this.locateObjects(pool, [{ type: S5_OBJECT_TYPE[targetType], id: objectId }]) : null;
        requestable.push({
          targetType, grantees: targetType === 'knowledge.shared_writer' ? ('ok' in answer && answer.ok.tier !== 'user' ? 'any' : 'self') : 'none',
          fields: shape.fields, bound: {},
          deciders: this.previewDeciders(targetType, located ? { objects: located.objects, unreadByFiler: [] } as unknown as Filing : null),
          before: 'ok' in answer ? answer.ok.filing.before : objectId ? await this.objectState(pool, targetType, objectId) : null,
        });
      } else {
        refusedEntry(targetType, answer.code, answer.refusal);
      }
    }
    return { requestable, refused };
  }

  /** Who a requestable target may be FOR: any Account or Group (root, an administrator, the owner tier) or the caller's own Account. */
  private async previewGrantees(evaluated: EvaluatedFiling, filer: AuthorizationActor): Promise<'any' | 'self'> {
    if (evaluated.tier !== 'user') return 'any';
    if (evaluated.filing.unreadByFiler && evaluated.filing.unreadByFiler.length > 0) return 'self';
    const owned = await this.ownedObjects(filer, evaluated.filing.objects);
    return owned.length > 0 && owned.length === evaluated.filing.objects.length ? 'any' : 'self';
  }

  /** The standings that would decide (section 5.1 (4)): never a person. An owner standing is shown only where every object is readable by the caller. */
  private previewDeciders(targetType: string, filing: Filing | null): Array<{ standing: string; rule: string }> {
    const rule = changeDecidersRule(targetType);
    const out = [{ standing: 'root', rule }];
    if (!changeTargetNeedsRootSession(targetType)) out.push({ standing: 'administrator', rule });
    if (filing && changeTargetAdmitsOwnerTier(targetType) && !(filing.unreadByFiler && filing.unreadByFiler.length > 0)
      && filing.objects.length > 0 && filing.objects.every((object) => object.ownerIds.length > 0)) {
      out.push({ standing: 'owner', rule });
    }
    return out;
  }

  /**
   * The decider's before/after view of one change while it is pending, or as
   * decided (section 6): the field diff, the relationship edges and the
   * summary, and whether THIS session decides it (the very arm the decide
   * runs), with the reason when it does not.
   */
  async decisionContext(record: { id: string; requesterPrincipalId: string; change?: ChangeFields; status: string },
    viewer: ChangeDeciderViewer): Promise<Record<string, unknown> | null> {
    const fields = record.change;
    if (!fields) return null;
    const grantee: Grantee | null = fields.granteePrincipalId ? { type: (fields.granteeType ?? 'principal'), id: fields.granteePrincipalId } : null;
    const spec = fields.spec.approved ?? fields.spec.requested;
    const after = fields.spec.approved ? { ...fields.spec.before, ...fields.spec.approved } : { ...fields.spec.before, ...fields.spec.requested };
    const arm = await this.decidability(pool, viewer, record);
    const deciders = { rule: changeDecidersRule(fields.targetType), stepUp: true };
    if (isRequesterSide(arm.cases)) {
      // section 6 "Where shown": the requester's own status read — the field diff only.
      return {
        view: 'requester',
        change: { fields: fieldDiff(fields.spec.before, after), decided: Boolean(fields.spec.approved) },
        deciders, decidable: false, standing: null, refusal: arm.refusal,
      };
    }
    const reach = await changeReach(pool, fields.targetType, fields.spec.before, spec, fields.targetId);
    const diff = changeDiff(fields.targetType, fields.spec.before, after, spec, grantee, fields.targetId, reach);
    return {
      view: 'decider',
      change: { ...diff, decided: Boolean(fields.spec.approved) },
      deciders,
      decidable: record.status === 'pending' && arm.standing !== null,
      standing: arm.standing,
      refusal: arm.standing ? null : arm.refusal,
    };
  }

  /**
   * WHETHER THIS SESSION DECIDES THIS CHANGE, in the order the decide runs
   * (section 5.1): (1) the session kind, (2) liveness, (3) self-approval
   * (section 5.5, on the approved spec, or the requested one while pending),
   * (4) the standing arm. The hub's `decidable` and `decisionRefusal` and the
   * point read's `decidable` read it, so the page and the decide route answer
   * the same code. `cases` are the self-approval cases that hold, whatever
   * else refused (the requester side, case (a), is read from them).
   */
  /** Whether `viewerPrincipalId` reads this change as its requester (section 5.5 case (a), section 6 "Where shown"). */
  async requesterSideOf(viewerPrincipalId: string, record: { requesterPrincipalId: string; change?: ChangeFields }): Promise<boolean> {
    const fields = record.change;
    if (!fields) return false;
    return isRequesterSide(await this.selfDecisionCases(pool, {
      requester_principal_id: record.requesterPrincipalId, grantee_principal_id: fields.granteePrincipalId,
      grantee_type: fields.granteeType, target_id: fields.targetId,
    }, fields.targetType, fields.spec.before ?? {}, (fields.spec.approved ?? fields.spec.requested ?? {}) as Record<string, any>, viewerPrincipalId));
  }

  async decidability(q: Queryable, viewer: ChangeDeciderViewer,
    record: { id: string; requesterPrincipalId: string; change?: ChangeFields }): Promise<ChangeDeciderArm & { cases: string[] }> {
    const fields = record.change;
    const targetType = fields?.targetType ?? '';
    const cases = fields ? await this.selfDecisionCases(q, {
      requester_principal_id: record.requesterPrincipalId, grantee_principal_id: fields.granteePrincipalId,
      grantee_type: fields.granteeType, target_id: fields.targetId,
    }, targetType, fields.spec.before ?? {}, (fields.spec.approved ?? fields.spec.requested ?? {}) as Record<string, any>, viewer.principalId) : [];
    const arm = await this.changeDeciderArm(q, viewer, { id: record.id, target_type: targetType });
    if (arm.refusal?.code === 'DECIDER_SESSION_KIND') return { ...arm, cases };
    if (!(await approvalService.deciderLive(viewer.principalId))) {
      return { standing: null, cases, refusal: {
        status: 403, code: 'DECIDER_NO_LONGER_ADMITTED', message: 'the deciding Account is not an active, non-legacy Account acting as itself',
        rule: 'the decider is live at decide',
      } };
    }
    if (cases.length > 0) return { standing: null, cases, refusal: { status: 403, code: 'SELF_DECISION_REFUSED', message: SELF_DECISION_MESSAGE, rule: SELF_DECISION_RULE } };
    return { ...arm, cases };
  }

  // ═════════════════════════════ DECIDE ═════════════════════════════

  /**
   * DECIDE a change request on the row `ApprovalService.decide` locked, in its
   * transaction, after it consumed the decision's ONE step-up. Every refusal
   * below throws before anything is written, and the caller's rollback
   * un-consumes the token; a lapse commits the lapse and then refuses.
   */
  async decide(client: PoolClient, row: any, input: ChangeDecideInput, actor: AuditActor): Promise<(() => void) | void> {
    const approvalId = String(row.id);
    const targetType = String(row.target_type) as ChangeTargetType;
    const requesterId = String(row.requester_principal_id);
    const viewer: ChangeDeciderViewer = input.viewer ?? { principalId: input.deciderPrincipalId, isRoot: false, administratorOk: false };
    if (lower(viewer.principalId) !== lower(input.deciderPrincipalId)) {
      throw refuse(403, APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR, 'the deciding session is not the decider', 'decider', '5.1',
        'the decider is the session that decides');
    }
    // section 5.1 (1): the session kind, where the executor needs a STORED session.
    if (STORED_SESSION_TARGETS.includes(targetType) && !isStoredLoginSessionKind(viewer.authMethod ?? undefined)) {
      throw refuse(403, 'DECIDER_SESSION_KIND', `a ${targetType} change is applied on a stored login session: the break-glass session cannot decide it`,
        'decider', '5.1', 'an executor that needs a stored session is decided on one');
    }
    // section 5.1 (2): the decider is still an active, non-legacy Account acting as itself.
    const decider = (await client.query(
      'SELECT id, handle, role, status, legacy_identity, parent_principal_id FROM principals WHERE id = $1', [input.deciderPrincipalId])).rows[0];
    if (!decider || decider.status !== 'active' || decider.legacy_identity || decider.parent_principal_id) {
      throw refuse(403, 'DECIDER_NO_LONGER_ADMITTED', 'the deciding Account is not an active, non-legacy Account acting as itself',
        'decider', '5.1', 'the decider is live at decide');
    }
    const spec = parseJson<Record<string, any>>(row.change_spec, {});
    const requested = spec.requested as Record<string, any>;
    // section 5.4: the decider narrows, never widens; section 5.5 reads the APPROVED spec.
    const approved = input.decision === 'approve' ? this.narrowed(targetType, requested, input.editedChange, spec.before ?? {}) : requested;
    // section 5.1 (3): self-approval is refused, root not exempt.
    if (input.decision === 'approve') {
      await this.assertNotSelfDecision(client, row, targetType, spec.before ?? {}, approved, input.deciderPrincipalId);
    }
    // section 5.1 (4): the first standing arm that admits.
    const arm = await this.changeDeciderArm(client, viewer, { id: approvalId, target_type: targetType });
    if (!arm.standing) {
      const refusal = arm.refusal ?? {
        status: 403, code: APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR, message: 'this session does not decide this change', rule: changeDecidersRule(targetType),
      };
      throw refuse(refusal.status, refusal.code, refusal.message, 'decider', '5.1', refusal.rule, { targetType });
    }
    const deciderStanding = arm.standing;
    const lapse = async (reason: string, status: number, code: string, message: string, subject: Subject, section: string, rule: string,
      detail: Record<string, unknown> = {}): Promise<never> => {
      await this.lapse(client, approvalId, reason, actor);
      await client.query('COMMIT');
      throw refuse(status, code, message, subject, section, rule, { lapseReason: reason, ...detail });
    };
    if (new Date(row.pending_expires_at).getTime() <= Date.now()) {
      await lapse('PENDING_EXPIRED', 409, 'APPROVAL_LAPSED', 'this request passed its 7-day pending TTL and lapsed', 'decider', '7.4', 'pending TTL 7 days');
    }
    if (input.decision === 'deny') {
      const reason = typeof input.denialReason === 'string' ? input.denialReason.slice(0, 500) : null;
      await client.query(
        `UPDATE approvals SET status = 'denied', decided_by_principal_id = $2, decided_at = NOW(), decision_step_up = $3::jsonb,
                denial_reason = $4, decider_standing = $5, updated_at = NOW() WHERE id = $1`,
        [approvalId, input.deciderPrincipalId, JSON.stringify(input.stepUp), reason, deciderStanding]);
      const metadata = { kind: 'change', targetType, reason, stepUp: input.stepUp, deciderStanding };
      await this.writeEvent(client, approvalId, 'approval.denied', actor, metadata);
      await auditService.record({
        action: 'approval.deny', actor, resourceType: 'approval', resourceId: approvalId,
        metadata: { ...metadata, chain: await auditChainFor(client, requesterId) },
      }, client);
      return;
    }
    if (row.session_evidence && !row.requesting_credential_id) {
      // A session-filed request: its requester is a person's Account, live at decide.
      const requester = (await client.query('SELECT status, legacy_identity FROM principals WHERE id = $1', [requesterId])).rows[0];
      if (!requester || requester.status !== 'active' || requester.legacy_identity) {
        await lapse('REQUESTER_CHAIN_DEAD', 409, 'APPROVAL_LAPSED', 'the filing Account is no longer live, so the request lapsed REQUESTER_CHAIN_DEAD',
          'requester', '5.1', 'the requester is live at decide');
      }
    } else {
      try {
        await agentMintService.assertRequesterLive(requesterId, row.requesting_credential_id ? String(row.requesting_credential_id) : null);
      } catch (e) {
        if (!(e instanceof AgentMintError)) throw e;
        const reason = e.code.startsWith('CREDENTIAL_') ? 'CREDENTIAL_ROTATED' : 'REQUESTER_CHAIN_DEAD';
        await lapse(reason, 409, 'APPROVAL_LAPSED', `the requester is no longer live, so the request lapsed ${reason}`, 'requester', '5.1',
          'the requester is live at decide');
      }
    }
    const grantee: Grantee | null = row.grantee_principal_id ? { type: row.grantee_type, id: String(row.grantee_principal_id) } : null;
    if (grantee) {
      const live = (await client.query(
        grantee.type === 'group'
          ? `SELECT 1 FROM groups g JOIN principals p ON p.id = g.id WHERE g.id = $1 AND p.status = 'active'`
          : `SELECT 1 FROM principals WHERE id = $1 AND status = 'active' AND NOT legacy_identity`, [grantee.id])).rows.length > 0;
      if (!live) {
        await lapse('GRANTEE_DISABLED', 409, 'APPROVAL_LAPSED', 'the grantee is no longer active, so the request lapsed GRANTEE_DISABLED',
          'grantee', '7.4', 'the grantee is active at decide');
      }
    }
    // section 6: the target is re-read; a difference from the snapshot lapses the request TARGET_CHANGED.
    const stale = await this.staleReason(client, row, targetType, spec);
    if (stale) {
      await lapse('TARGET_CHANGED', 409, 'EDIT_STALE',
        `the target changed after this request was filed (${stale}), so the request lapsed TARGET_CHANGED and nothing was applied`,
        'decider', '6', 'the target still equals the state the request was filed against');
    }
    // section 4.2 / F7: a knowledge change is re-checked against the LIVE export selection.
    if (targetType === 'knowledge.compartment') {
      this.assertExported(String(approved.sourceId), {
        accountIds: approved.subject.type === 'user' ? [String(approved.subject.id)] : [], projectIds: approved.projectIds,
      }, 'grantee');
    }
    if (targetType === 'knowledge.shared_writer') {
      this.assertExported(String(approved.sourceId), { accountIds: [String(approved.accountId)], projectIds: [] }, 'grantee');
    }
    // section 5.1 (5): a Group manager decides grant.rows only within the write set.
    if (deciderStanding === 'group-manager') {
      const verbs = ((approved.rules ?? []) as ProfileRule[]).flatMap((rule) => rule.verbs);
      const beyond = verbs.filter((verb) => !(GROUP_EDIT_TIER_ACTIONS as readonly string[]).includes(verb));
      if (beyond.length > 0) {
        throw refuse(403, 'DECIDER_CEILING_EXCEEDED', `a Group manager decides the write set only: ${[...new Set(beyond)].join(', ')} is beyond it`,
          'decider', '5.2', 'a manager row decides grant.rows with verbs in the write set');
      }
    }
    // section 5.3: the decision's ONE step-up is the apply's evidence.
    const evidence = { tokenId: input.stepUp.tokenId, method: input.stepUp.method, approvalId, deciderPrincipalId: input.deciderPrincipalId };
    try {
      await assertDecisionEvidence(client, evidence);
    } catch (e) {
      throw asChangeRefusal(e, 'decider', '5.3');
    }
    const decision = await this.apply(client, row, targetType, grantee, approved, {
      ...input, deciderStanding, evidence,
    }, actor);
    // section 6: the field AND relationship diff, stored with the decision.
    const decidedTargetId = row.target_id ? String(row.target_id) : null;
    const reach = await changeReach(client, targetType, spec.before ?? {}, approved, decidedTargetId);
    const diff = changeDiff(targetType, spec.before ?? {}, decision.after, approved, grantee, decidedTargetId, reach);
    const twoStep = TWO_STEP_TARGETS.includes(targetType);
    await client.query(
      `UPDATE approvals
          SET status = 'approved', decided_by_principal_id = $2, decided_at = NOW(), decision_step_up = $3::jsonb,
              change_spec = change_spec || jsonb_build_object('approved', $4::jsonb, 'diff', $5::jsonb),
              decider_standing = $6, applied_at = CASE WHEN $7::boolean THEN NULL ELSE NOW() END,
              applied_effect = $8::jsonb, revert_at = $9, collect_expires_at = $10, updated_at = NOW()
        WHERE id = $1`,
      [approvalId, input.deciderPrincipalId, JSON.stringify(input.stepUp), JSON.stringify(approved), JSON.stringify(diff),
        deciderStanding, twoStep, JSON.stringify(decision.effect), decision.revertAt,
        twoStep ? new Date(Date.now() + CHANGE_COLLECT_TTL_MS) : null]);
    const ledger = {
      kind: 'change', targetType, deciderStanding, stepUp: input.stepUp,
      before: spec.before ?? {}, after: decision.after, approved, effect: decision.effect,
      edited: stableJson(approved) !== stableJson(requested), relationships: diff.summary,
    };
    await this.writeEvent(client, approvalId, 'approval.approved', actor, ledger);
    await auditService.record({
      action: 'approval.approve', actor, resourceType: 'approval', resourceId: approvalId,
      metadata: { ...ledger, approvalId, chain: await auditChainFor(client, requesterId) },
    }, client);
    // What the caller runs once its COMMIT has landed: the read caches of a
    // principal the decision changed (slice S4), never before (a rollback
    // must not publish a role, a status or an Account that never existed).
    return decision.afterCommit;
  }

  /**
   * WHO MAY DECIDE THIS CHANGE — the single copy of section 5.1 (4) and 5.2.
   * The decide (on its locked row) and the hub's `decidable` both call it, so
   * the page cannot say "you may decide" where the route would refuse.
   *
   *   - root: a root session, every target;
   *   - administrator: an administrator login session, every target but the
   *     root-ceiling ones (section 5.1, section 12 Q3);
   *   - the OWNER TIER (section 5.2): a human Account acting as itself, and for
   *     EVERY child row its stored owner value (owner_ids, re-derived at decide
   *     by the stale check) names the decider (owner), or a Group in which the
   *     decider holds a LIVE owner row (group-owner), or, for grant.rows alone,
   *     a live manager row (group-manager). A person-only target admits no Group
   *     arm. The arm never evaluates `admin`, and runs only after the root and
   *     administrator arms refuse. A service Account's steward row is inert as a
   *     decider (LENSES-C).
   * Otherwise null, with the reason the page shows.
   */
  async changeDeciderArm(q: Queryable, viewer: ChangeDeciderViewer, row: { id: string; target_type: string }): Promise<ChangeDeciderArm> {
    const targetType = String(row.target_type);
    const rule = changeDecidersRule(targetType);
    if (STORED_SESSION_TARGETS.includes(targetType as ChangeTargetType) && !isStoredLoginSessionKind(viewer.authMethod ?? undefined)) {
      return { standing: null, refusal: { status: 403, code: 'DECIDER_SESSION_KIND', message: 'this change is decided on a stored login session', rule } };
    }
    if (viewer.isRoot) return { standing: 'root', refusal: null };
    const rootOnly = changeTargetNeedsRootSession(targetType);
    if (viewer.administratorOk && !rootOnly) return { standing: 'administrator', refusal: null };
    const refused = (message: string): ChangeDeciderArm => ({
      standing: null, refusal: { status: 403, code: APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR, message, rule },
    });
    if (rootOnly) return refused(`a ${targetType} change is decided by a root session only`);
    if (!changeTargetAdmitsOwnerTier(targetType)) return refused(`a ${targetType} change is decided by root or an administrator login session`);
    if (targetType === 'project.owner') {
      // section 5.2 (R12:205-211): its person owner moves a Project to another
      // person; into, out of or between Groups only root or an administrator.
      const spec = parseJson<Record<string, any>>((await q.query('SELECT change_spec FROM approvals WHERE id = $1', [row.id])).rows[0]?.change_spec, {});
      // (A Group-owned Project is already out of the person arm: its owner value is the Group.)
      if (spec.requested?.ownerKind === 'group') {
        return refused('a project.owner change into, out of or between Groups is decided by root or an administrator login session');
      }
    }
    const live = liveStewardRows({ group: null, account: '$2::uuid', roles: "ARRAY['owner', 'manager']::text[]" });
    const objects = (await q.query(
      `WITH me AS (SELECT id FROM principals WHERE id = $2 AND kind = 'human' AND status = 'active'
                     AND NOT legacy_identity AND parent_principal_id IS NULL),
            live AS (SELECT live_row.group_id, live_row.role FROM (${live}) live_row
                       JOIN principals owning_group ON owning_group.id = live_row.group_id
                        AND owning_group.kind = 'group' AND owning_group.status = 'active')
       SELECT o.ordinal,
              (EXISTS (SELECT 1 FROM me) AND $2::uuid = ANY(o.owner_ids)) AS person,
              (EXISTS (SELECT 1 FROM me) AND EXISTS (SELECT 1 FROM live WHERE live.group_id = ANY(o.owner_ids) AND live.role = 'owner')) AS group_owner,
              (EXISTS (SELECT 1 FROM me) AND EXISTS (SELECT 1 FROM live WHERE live.group_id = ANY(o.owner_ids) AND live.role = 'manager')) AS group_manager
         FROM approval_change_objects o WHERE o.approval_id = $1 ORDER BY o.ordinal`,
      [row.id, viewer.principalId])).rows;
    if (objects.length === 0) return refused('this change names no object an owner decides');
    const personOnly = (PERSON_OWNER_ONLY_TARGETS as readonly string[]).includes(targetType);
    const managerTier = (MANAGER_TIER_TARGETS as readonly string[]).includes(targetType);
    let weakest: ChangeDeciderStanding = 'owner';
    for (const object of objects) {
      let standing: ChangeDeciderStanding | null = null;
      if (object.person) standing = 'owner';
      else if (!personOnly && object.group_owner) standing = 'group-owner';
      else if (!personOnly && managerTier && object.group_manager) standing = 'group-manager';
      if (!standing) {
        if (object.group_manager && !managerTier) {
          return refused(`a Group manager decides grant.rows within the write set only; this ${targetType} change is decided by root, an administrator or the owner`);
        }
        if ((object.group_owner || object.group_manager) && personOnly) {
          return refused(`a ${targetType} change on a Group-owned object is decided by root or an administrator; no Group tier reaches it`);
        }
        return refused('you do not own every object this change names');
      }
      if (STANDING_ORDER.indexOf(standing) > STANDING_ORDER.indexOf(weakest)) weakest = standing;
    }
    return { standing: weakest, refusal: null };
  }

  /** The target re-derived at decide, compared with what the request was filed against. */
  private async staleReason(client: PoolClient, row: any, targetType: ChangeTargetType, spec: Record<string, any>): Promise<string | null> {
    const before = spec.before ?? {};
    const requested = spec.requested ?? {};
    const objects = (await client.query(
      'SELECT object_id, owner_ids FROM approval_change_objects WHERE approval_id = $1 ORDER BY ordinal', [row.id])).rows;
    const filedOwners = objects.map((o) => uniqueSorted(Array.isArray(o.owner_ids) ? o.owner_ids.map(String)
      : String(o.owner_ids ?? '').replace(/[{}]/g, '').split(',')));
    const array = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : String(value ?? '').replace(/[{}]/g, '').split(',').filter(Boolean));
    if (targetType === 'grant.rows' || targetType === 'knowledge.compartment') {
      const targetObjects = parseJson<Array<{ type: string; id: string | null }>>(row.target_objects, []);
      const located = await this.locateObjects(client, targetObjects);
      if (JSON.stringify(located.objects.map((o) => o.ownerIds)) !== JSON.stringify(filedOwners)) return 'an object\'s owner changed';
      if (JSON.stringify(located.scope.projectIds) !== JSON.stringify(uniqueSorted(array(row.scope_project_ids)))
        || JSON.stringify(located.scope.reportIds) !== JSON.stringify(uniqueSorted(array(row.scope_report_ids)))
        || JSON.stringify(located.scope.groupIds) !== JSON.stringify(uniqueSorted(array(row.scope_group_ids)))) return 'an object moved';
      if (targetType === 'grant.rows') {
        const unread: string[] = Array.isArray(spec.filing?.unreadByFiler) ? spec.filing.unreadByFiler.map(String) : [];
        const now = await this.heldRows(client, requested.grantee, withoutObjects(requested.rules, unread));
        if (stableJson(now) !== stableJson(before.rows ?? [])) return "the grantee's rows on these objects changed";
      } else {
        const now = await this.compartmentRows(client, requested.sourceId, requested.subject.type, requested.subject.id, requested.projectIds);
        if (stableJson(now) !== stableJson(before.rows ?? [])) return "the subject's compartment rows changed";
      }
      return null;
    }
    if (targetType === 'grant.edit' || targetType === 'grant.revoke' || targetType === 'credential.scopes') {
      const type = targetType === 'credential.scopes' ? 'credential' : 'grant';
      const locked = await authorityEditExecutor.lockObject(client, type, String(row.target_id));
      if (!locked) return 'it no longer exists';
      if (!statesEqual(type, locked.state as unknown as Record<string, unknown>, before)) return 'its editable fields differ from the snapshot';
      return null;
    }
    if (targetType === 'credential.issue') {
      const target = (await client.query('SELECT status FROM principals WHERE id = $1', [row.target_id])).rows[0];
      if (!target || target.status !== 'active') return 'the target Connector is no longer active';
      return null;
    }
    if (targetType === 'knowledge.shared_writer') {
      const listed = (await client.query(
        `SELECT 1 FROM knowledge_shared_writers WHERE source_id = $1 AND scope = 'organisation' AND account_id = $2
            AND (expires_at IS NULL OR expires_at > NOW())`, [requested.sourceId, requested.accountId])).rows.length > 0;
      return listed ? 'the Account was added to the list meanwhile' : null;
    }
    // ── slice S5: the object, re-read under its row lock, equals what was filed ──
    if ((S5_TARGET_TYPES as readonly string[]).includes(targetType)) {
      const located = await this.locateObjects(client, [{ type: S5_OBJECT_TYPE[targetType], id: String(row.target_id) }]);
      if (JSON.stringify(located.objects.map((o) => o.ownerIds)) !== JSON.stringify(filedOwners)) return "the object's owner changed";
      const now = await this.objectState(client, targetType, String(row.target_id), true);
      if (!now) return 'it no longer exists';
      if (stableJson(now) !== stableJson(before)) return 'its state differs from the one the request was filed against';
      return null;
    }
    // ── slice S4 ──
    if (targetType === 'identity.role' || targetType === 'identity.status') {
      const now = (await client.query('SELECT role, status FROM principals WHERE id = $1 FOR UPDATE', [row.target_id])).rows[0];
      if (!now) return 'the principal no longer exists';
      if ((now.role ?? null) !== (before.role === undefined ? (now.role ?? null) : before.role)) return 'its role changed';
      if (String(now.status) !== String(before.status)) return 'its status changed';
      return null;
    }
    if (targetType === 'identity.create') {
      const taken = (await client.query('SELECT 1 FROM principals WHERE lower(handle) = lower($1)', [requested.handle])).rows.length > 0;
      return taken ? 'a principal with that handle now exists' : null;
    }
    if (targetType === 'credential.revoke') {
      const now = (await client.query('SELECT revoked_at, expires_at FROM principal_credentials WHERE id = $1 FOR UPDATE', [row.target_id])).rows[0];
      if (!now) return 'it no longer exists';
      if (now.revoked_at || (now.expires_at && new Date(now.expires_at).getTime() <= Date.now())) return 'it is no longer live';
      return null;
    }
    if (targetType === 'warrant.create') {
      const holder = (await client.query('SELECT status FROM principals WHERE id = $1', [row.target_id])).rows[0];
      return !holder || holder.status !== 'active' ? 'the holder is no longer active' : null;
    }
    if (targetType === 'warrant.edit' || targetType === 'warrant.revoke' || targetType === 'warrant.resume') {
      const locked = await authorityEditExecutor.lockObject(client, 'warrant', String(row.target_id));
      if (!locked) return 'it no longer exists';
      if (String(locked.row.status) !== String(before.status)) return 'its status changed';
      if (targetType === 'warrant.edit' && !statesEqual('warrant', locked.state as unknown as Record<string, unknown>, before)) {
        return 'its editable fields differ from the snapshot';
      }
      const dependents = (await accessVehicleService.dependentOpenTasks(locked.id, client)).length;
      if (dependents !== Number(before.dependentTaskCount ?? 0)) return 'the tasks riding it changed';
      return null;
    }
    return null;
  }

  /** section 5.4: the decider narrows, never widens, per target. */
  private narrowed(targetType: ChangeTargetType, requested: Record<string, any>, raw: unknown, before: Record<string, any> = {}): Record<string, any> {
    if (raw === undefined || raw === null) return requested;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw refuse(422, 'EDIT_ONLY_NARROWS', 'editedChange is an object narrowing the requested change', 'decider', '5.4', 'the decider narrows only');
    }
    const edit = raw as Record<string, any>;
    const narrows = (what: string, detail: Record<string, unknown> = {}) => refuse(422, 'EDIT_ONLY_NARROWS',
      `the decider narrows a change, never widens it (section 5.4): ${what}`, 'decider', '5.4',
      'untick rows, verbs, scopes or Projects, shorten the expiry, write to read, or narrow a pin; never add', { targetType, ...detail });
    const allowed: Record<string, string[]> = {
      'grant.rows': ['rules', 'expiresAt'], 'credential.scopes': ['scopes'], 'credential.issue': ['scopes', 'transport', 'expiresAt'],
      'knowledge.compartment': ['projectIds', 'operation', 'expiresAt'], 'knowledge.shared_writer': ['expiresAt'],
      'grant.edit': [], 'grant.revoke': [],
      // slice S4: a role narrows to a lower one; a warrant to a narrower
      // ceiling, lower caps, an earlier expiry or a narrower pin; the rest is
      // approved or denied as filed.
      'identity.role': ['role'], 'identity.create': [], 'identity.status': [], 'credential.revoke': [],
      'warrant.create': WARRANT_NARROWABLE, 'warrant.edit': WARRANT_NARROWABLE, 'warrant.revoke': [], 'warrant.resume': [],
      // slice S5 (section 5.4): no field narrowing: approve the named value or deny.
      ...Object.fromEntries(S5_TARGET_TYPES.map((type) => [type, [] as string[]])),
    };
    const outside = Object.keys(edit).filter((key) => !(allowed[targetType] ?? []).includes(key)).sort();
    if (outside.length > 0) throw narrows(`${outside.join(', ')} cannot be narrowed on a ${targetType} change`, { fields: outside });
    if (targetType === 'identity.role') {
      if (edit.role === undefined) return requested;
      let role: string;
      try {
        role = assignableRole(edit.role, null);
      } catch (e) {
        throw asChangeRefusal(e, 'decider', '5.4');
      }
      if (role !== requested.role && roleRank(role) >= roleRank(requested.role)) {
        throw narrows(`the role '${role}' is not lower than the requested '${requested.role}'`);
      }
      if (role === (before.role ?? null)) {
        throw refuse(422, 'APPROVAL_WRITES_NOTHING', 'the narrowed role is the one the principal holds: deny the request instead', 'decider', '5.4',
          'an approval changes the role');
      }
      return { ...requested, role };
    }
    if (targetType === 'warrant.create' || targetType === 'warrant.edit') {
      // Each field narrows against what the approved state would otherwise
      // carry: the requested value, else (an edit) the warrant's own.
      const base = (field: string): any => (requested[field] !== undefined ? requested[field] : before[field] ?? null);
      const out: Record<string, any> = { ...requested };
      if (edit.expiresAt !== undefined) {
        const parsed = typeof edit.expiresAt === 'string' ? new Date(edit.expiresAt) : new Date(Number.NaN);
        if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
          throw refuse(422, 'INVALID_LIFETIME', 'expiresAt must be a future ISO timestamp', 'decider', '5.4', 'the approved expiry is in the future');
        }
        const ceiling = base('expiresAt');
        if (ceiling && parsed.getTime() > new Date(ceiling).getTime()) throw narrows('the approved expiresAt is later than the warrant would otherwise carry');
        out.expiresAt = parsed.toISOString();
      }
      for (const cap of ['maxConcurrent', 'maxTotal']) {
        if (edit[cap] === undefined) continue;
        const value = Number(edit[cap]);
        const ceiling = base(cap);
        if (!Number.isInteger(value) || value < 1) throw narrows(`${cap} is a positive integer`);
        if (ceiling !== null && value > Number(ceiling)) throw narrows(`the approved ${cap} is higher than ${ceiling}`);
        out[cap] = value;
      }
      if (edit.ceilingScopes !== undefined) {
        const ceiling = base('ceilingScopes') as string[] | null;
        if (!Array.isArray(edit.ceilingScopes) || edit.ceilingScopes.length === 0 || edit.ceilingScopes.some((s: unknown) => typeof s !== 'string')) {
          throw narrows('ceilingScopes is a non-empty scope set');
        }
        const extra = ceiling ? (edit.ceilingScopes as string[]).filter((s) => !ceiling.includes(s)) : [];
        if (extra.length > 0) throw narrows(`${extra.join(', ')} lies outside the scope ceiling it would otherwise carry`, { exceeding: extra });
        out.ceilingScopes = [...new Set(edit.ceilingScopes as string[])];
      }
      if (edit.transportPin !== undefined) {
        const pin = String(edit.transportPin);
        const from = String(base('transportPin') ?? 'any');
        if (!['any', 'mcp', 'api'].includes(pin) || transportMove(from as never, pin as never) === 'up') {
          throw narrows(`the pin ${pin} is wider than ${from}`);
        }
        out.transportPin = pin;
      }
      return out;
    }
    const shorter = (field: string): string => {
      const value = edit[field];
      const parsed = typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
      if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
        throw refuse(422, 'INVALID_LIFETIME', `${field} must be a future ISO timestamp`, 'decider', '5.4', 'the approved expiry is in the future');
      }
      if (parsed.getTime() > new Date(requested[field]).getTime()) throw narrows(`the approved ${field} is later than the requested one`);
      return parsed.toISOString();
    };
    const out: Record<string, any> = { ...requested };
    if (edit.expiresAt !== undefined) out.expiresAt = shorter('expiresAt');
    if (targetType === 'grant.rows' && edit.rules !== undefined) {
      if (Array.isArray(edit.rules) && edit.rules.length === 0) {
        throw refuse(422, 'APPROVAL_WRITES_NOTHING', 'unticking every row writes nothing: deny the request instead', 'decider', '5.4', 'an approval writes at least one row');
      }
      const candidate = this.admissibleRules(edit.rules, 'decider');
      const requestedRules = requested.rules as ProfileRule[];
      for (const rule of candidate) {
        const match = requestedRules.find((r) => r.resourceType === rule.resourceType);
        const idsOk = match && (match.selectorForm === 'all-of-type'
          ? true : rule.selectorForm === 'exact' && rule.selectorIds.every((id) => match.selectorIds.includes(id)));
        if (!match || !idsOk || !rule.verbs.every((verb) => match.verbs.includes(verb))) {
          throw narrows(`${JSON.stringify(rule)} was never requested`, { failingRule: rule });
        }
      }
      out.rules = candidate;
    }
    if (targetType === 'credential.scopes' && edit.scopes !== undefined) {
      const req = requested.scopes as string[];
      if (!Array.isArray(edit.scopes) || edit.scopes.some((s: unknown) => typeof s !== 'string')) throw narrows('scopes is the full approved scope set');
      const candidate = [...new Set(edit.scopes as string[])];
      const extra = candidate.filter((s) => !req.includes(s));
      if (extra.length > 0) throw narrows(`${extra.join(', ')} was never requested`, { exceeding: extra });
      out.scopes = req.filter((s) => candidate.includes(s));
    }
    if (targetType === 'credential.issue') {
      if (edit.scopes !== undefined) {
        const req = requested.scopes as string[];
        if (!Array.isArray(edit.scopes) || edit.scopes.length === 0) {
          throw refuse(422, 'APPROVAL_WRITES_NOTHING', 'unticking every scope issues nothing: deny the request instead', 'decider', '5.4', 'an approval issues at least one scope');
        }
        const extra = (edit.scopes as unknown[]).filter((s) => typeof s !== 'string' || !req.includes(s));
        if (extra.length > 0) throw narrows(`${extra.join(', ')} was never requested`, { exceeding: extra });
        out.scopes = req.filter((s) => (edit.scopes as string[]).includes(s));
      }
      if (edit.transport !== undefined) {
        const pin = String(edit.transport);
        if (pin !== requested.transport && !(requested.transport === 'any' && (pin === 'mcp' || pin === 'api'))) {
          throw narrows(`the pin ${pin} is wider than the requested ${requested.transport}`);
        }
        out.transport = pin;
      }
    }
    if (targetType === 'knowledge.compartment') {
      if (edit.projectIds !== undefined) {
        if (!Array.isArray(edit.projectIds) || edit.projectIds.length === 0) {
          throw refuse(422, 'APPROVAL_WRITES_NOTHING', 'dropping every Project writes nothing: deny the request instead', 'decider', '5.4', 'an approval writes at least one row');
        }
        const ids = uniqueSorted(edit.projectIds as string[]);
        const extra = ids.filter((id) => !(requested.projectIds as string[]).includes(id));
        if (extra.length > 0) throw narrows(`Project ${extra.join(', ')} was never requested`, { exceeding: extra });
        out.projectIds = ids;
      }
      if (edit.operation !== undefined) {
        if (edit.operation !== requested.operation && !(requested.operation === 'write' && edit.operation === 'read')) {
          throw narrows(`the operation ${edit.operation} is wider than the requested ${requested.operation}`);
        }
        out.operation = edit.operation;
      }
    }
    return out;
  }

  /**
   * section 5.5 — SELF_DECISION_REFUSED when the decider's Account, or any
   * principal in its subtree: (a) is the requester's chain-root Account; (b) is
   * the grantee, or a member by any source or a steward-row holder of a Group
   * grantee or subject; (c) for a target on a principal (a credential, a
   * Connector, a grant's grantee) is that principal's chain-root Account; (d)
   * is named by a principal-valued field of the APPROVED change (the writer-list
   * Account, the knowledge subject). Root is not exempt: a second person, or the
   * break-glass row, decides. Run on the approved spec, before anything is applied.
   */
  private async assertNotSelfDecision(client: PoolClient, row: any, targetType: ChangeTargetType,
    before: Record<string, any>, approved: Record<string, any>, deciderId: string): Promise<void> {
    const cases = await this.selfDecisionCases(client, row, targetType, before, approved, deciderId);
    if (cases.length > 0) {
      throw refuse(403, 'SELF_DECISION_REFUSED', SELF_DECISION_MESSAGE, 'decider', '5.5', SELF_DECISION_RULE, { cases });
    }
  }

  /**
   * The section 5.5 cases (a)-(d) that hold for one decider over one change
   * row, sorted, or [] — the single copy the decide refusal, the hub's
   * `decidable` and the requester view all read. `row` carries the stored
   * columns requester_principal_id, grantee_principal_id, grantee_type and
   * target_id; `approved` is the approved spec (the requested one while pending).
   */
  async selfDecisionCases(q: Queryable, row: { requester_principal_id: unknown; grantee_principal_id?: unknown; grantee_type?: unknown; target_id?: unknown },
    targetType: string, before: Record<string, any>, approved: Record<string, any>, deciderId: string): Promise<string[]> {
    if (!UUID_PATTERN.test(String(deciderId ?? ''))) return [];
    const client = q;
    const named: Array<{ id: string; case: string }> = [];
    const groups: string[] = [];
    const requesterRoot = await authorityEditExecutor.chainRootAccount(client, String(row.requester_principal_id));
    if (requesterRoot) named.push({ id: requesterRoot, case: 'a' });
    if (row.grantee_principal_id) {
      if (row.grantee_type === 'group') groups.push(String(row.grantee_principal_id));
      else named.push({ id: String(row.grantee_principal_id), case: 'b' });
    }
    // (c) the target principal: a credential's holder, a target Connector, a
    // grant's principal grantee, and (slice S4) the principal whose role or
    // status changes and the holder of a credential revoked.
    const holder = targetType === 'credential.scopes' || targetType === 'credential.revoke' ? before.holderPrincipalId
      : targetType === 'credential.issue' || (PRINCIPAL_TARGETS as readonly string[]).includes(targetType) ? row.target_id
        : (targetType === 'grant.edit' || targetType === 'grant.revoke') && before.grant?.granteeType === 'principal' ? before.grant.granteeId : null;
    // (d) a principal-valued field of the approved change: a warrant's holder
    // (a warrant whose holder sits under the decider's Account, section 5.5).
    const warrantHolder = (WARRANT_TARGETS as readonly string[]).includes(targetType)
      ? (approved.holderPrincipalId ?? before.holderPrincipalId ?? before.holder?.principalId ?? null) : null;
    if (warrantHolder) {
      const warrantHolderRoot = await authorityEditExecutor.chainRootAccount(client, String(warrantHolder));
      if (warrantHolderRoot) named.push({ id: warrantHolderRoot, case: 'd' });
    }
    if (holder) {
      const holderRoot = await authorityEditExecutor.chainRootAccount(client, String(holder));
      if (holderRoot) named.push({ id: holderRoot, case: 'c' });
    }
    if ((targetType === 'grant.edit' || targetType === 'grant.revoke') && before.grant?.granteeType === 'group') groups.push(String(before.grant.granteeId));
    if (approved.accountId) named.push({ id: String(approved.accountId), case: 'd' });
    // (d), slice S5: the owner, the account owner, the default Verifier, the
    // Shepherd and the Verifier the approved change puts on the object; a Group
    // value is read through its members and stewards, as a Group grantee is.
    if ((S5_TARGET_TYPES as readonly string[]).includes(targetType)) {
      for (const field of ['ownerPrincipalId', 'accountOwnerPrincipalId', 'defaultVerifierPrincipalId', 'shepherdPrincipalId', 'verifierPrincipalId']) {
        const value = approved[field];
        if (typeof value === 'string' && UUID_PATTERN.test(value)) { named.push({ id: value, case: 'd' }); groups.push(value); }
      }
    }
    if (approved.subject?.type === 'user') named.push({ id: String(approved.subject.id), case: 'd' });
    if (approved.subject?.type === 'group') groups.push(String(approved.subject.id));
    const found = (await client.query(
      `WITH RECURSIVE subtree AS (
         SELECT id FROM principals WHERE id = $1
         UNION ALL
         SELECT p.id FROM principals p JOIN subtree s ON p.parent_principal_id = s.id)
       SELECT
         (SELECT array_agg(id::text) FROM subtree WHERE id = ANY($2::uuid[])) AS named,
         EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = ANY($3::uuid[]) AND m.account_principal_id IN (SELECT id FROM subtree)) AS member,
         EXISTS (SELECT 1 FROM group_stewards g WHERE g.group_id = ANY($3::uuid[]) AND g.account_principal_id IN (SELECT id FROM subtree)) AS steward`,
      [deciderId, uniqueSorted(named.map((n) => n.id)), uniqueSorted(groups)])).rows[0];
    const hits = new Set((found?.named ?? []).map((id: string) => lower(id)));
    const cases = [...new Set(named.filter((n) => hits.has(lower(n.id))).map((n) => n.case))];
    if (found?.member || found?.steward) cases.push('b');
    return [...new Set(cases)].sort();
  }

  /** The apply per target, with the decider as the standing principal. */
  private async apply(client: PoolClient, row: any, targetType: ChangeTargetType, grantee: Grantee | null, approved: Record<string, any>,
    input: ChangeDecideInput & { deciderStanding: ChangeDeciderStanding; evidence: { tokenId: string; method: string; approvalId: string; deciderPrincipalId: string } },
    actor: AuditActor): Promise<{ after: Record<string, unknown>; effect: Record<string, unknown>; revertAt: string | null; afterCommit?: () => void }> {
    const approvalId = String(row.id);
    const requesterId = String(row.requester_principal_id);
    const deciderScopes = input.deciderScopes ?? [];
    try {
      if (targetType === 'grant.rows') {
        const rules = approved.rules as ProfileRule[];
        // section 5.1(5): the approved rows lie within the DECIDER's effective authority.
        try {
          await agentMintService.assertObjectAuthorityCovers(input.deciderPrincipalId, rules);
        } catch (e) {
          if (e instanceof AgentMintError) {
            throw refuse(403, 'DECIDER_CEILING_EXCEEDED', `the approved rows exceed the decider's effective authority: ${e.message}`,
              'decider', '5.1', "the approved rows lie within the decider's effective authority");
          }
          throw e;
        }
        await this.assertObjectsExist(client, rules);
        const written = await this.writeApprovedGrants(client, {
          approvalId, requesterId, grantee: grantee as Grantee, rules, expiresAt: String(approved.expiresAt), actor,
        });
        return { after: { rows: written.rows }, effect: { grantIds: written.created, replacedExpiredGrantIds: written.replaced }, revertAt: String(approved.expiresAt) };
      }
      if (targetType === 'grant.edit') {
        const fields = { verb: approved.verb, expiresAt: approved.expiresAt, resourceId: approved.resourceId };
        const result = await authorityEditExecutor.applyDecidedChange(client, {
          type: 'grant', id: String(row.target_id), fields, approvalId,
          decider: { principalId: input.deciderPrincipalId, standing: administrativeStanding(input.deciderStanding), sessionScopes: deciderScopes },
          stepUp: input.stepUp, evidence: input.evidence,
        }, actor);
        return { after: result.after, effect: { grantId: String(row.target_id), auditId: result.auditId }, revertAt: null };
      }
      if (targetType === 'grant.revoke') {
        const origin = (await client.query('SELECT approval_id FROM grants WHERE id = $1', [row.target_id])).rows[0];
        // section 7.1: the existing grant.revoke audit carries the decision ledger.
        const removed = await grantService.remove(String(row.target_id), actor, client, {
          approvalId, kind: 'change', targetType, deciderStanding: input.deciderStanding, stepUp: input.stepUp,
          before: parseJson<Record<string, any>>(row.change_spec, {}).before ?? {}, after: { revoked: true },
          chain: await auditChainFor(client, requesterId),
        });
        if (origin?.approval_id) {
          // The originating request learns its row is gone (closes D9 G11).
          await this.writeEvent(client, String(origin.approval_id), 'approval.revoked', actor,
            { kind: 'change', reason: 'GRANT_REVOKED_BY_CHANGE', grantId: removed.id, byApprovalId: approvalId });
        }
        return { after: { revoked: true }, effect: { revokedGrantId: removed.id }, revertAt: null };
      }
      if (targetType === 'credential.scopes') {
        const result = await authorityEditExecutor.applyDecidedChange(client, {
          type: 'credential', id: String(row.target_id), fields: { scopes: approved.scopes }, approvalId,
          decider: { principalId: input.deciderPrincipalId, standing: administrativeStanding(input.deciderStanding), sessionScopes: deciderScopes },
          stepUp: input.stepUp, evidence: input.evidence,
        }, actor);
        return { after: result.after, effect: { credentialId: String(row.target_id), auditId: result.auditId }, revertAt: null };
      }
      if (targetType === 'credential.issue') {
        const scopes = assertConnectorCredentialScopes(approved.scopes, 'decider');
        const { exceeding } = issuingCeiling({ scopes: deciderScopes }, scopes);
        if (exceeding.length > 0) {
          throw refuse(403, 'DECIDER_CEILING_EXCEEDED',
            `the approved scopes exceed what this decider may put on a credential: ${exceeding.join(', ')}`, 'decider', '5.1',
            "the approved scopes lie within the decider's delegable set", { exceeding });
        }
        await this.assertCredentialNotHeld(client, String(row.target_id), scopes, String(approved.transport));
        return { after: { authorized: { scopes, transport: approved.transport, expiresAt: approved.expiresAt } }, effect: {}, revertAt: String(approved.expiresAt) };
      }
      if (targetType === 'knowledge.compartment') {
        const subjectType = String(approved.subject.type);
        const subjectId = String(approved.subject.id);
        const rowIds: string[] = [];
        for (const projectId of approved.projectIds as string[]) {
          const inserted = await client.query(
            `INSERT INTO knowledge_compartment_grants
               (source_id, project_id, subject_type, subject_id, operation, consent_ref, approval_id, added_by, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (source_id, project_id, subject_type, subject_id, operation)
               DO UPDATE SET consent_ref = EXCLUDED.consent_ref, approval_id = EXCLUDED.approval_id, added_by = EXCLUDED.added_by,
                             added_at = now(), expires_at = EXCLUDED.expires_at
               WHERE knowledge_compartment_grants.expires_at IS NOT NULL AND knowledge_compartment_grants.expires_at <= now()
             RETURNING id`,
            [approved.sourceId, projectId, subjectType, subjectId, approved.operation, `approval:${approvalId}`, approvalId,
              input.deciderPrincipalId, approved.expiresAt]);
          if (inserted.rows.length === 0) {
            throw refuse(409, 'ALREADY_HELD', `the subject already holds ${approved.operation} on Project ${projectId}: drop it`, 'grantee', '4.2',
              'a live compartment row is refused by name, never as a unique violation', { project: projectId });
          }
          rowIds.push(String(inserted.rows[0].id));
        }
        await auditService.record({
          action: 'knowledge.compartment.grant', actor, resourceType: 'knowledge_source', resourceId: String(approved.sourceId),
          metadata: { approvalId, kind: 'change', operation: approved.operation, subject: approved.subject, projectIds: approved.projectIds,
            expiresAt: approved.expiresAt, deciderStanding: input.deciderStanding, rowIds },
        }, client);
        return {
          after: { rows: (approved.projectIds as string[]).map((projectId) => ({ projectId, operation: approved.operation, expiresAt: approved.expiresAt })) },
          effect: { sourceId: String(approved.sourceId), compartmentRowIds: rowIds }, revertAt: String(approved.expiresAt),
        };
      }
      if (targetType === 'knowledge.shared_writer') {
        const source = await resolveSharedWriterSource(client, approved.sourceId);
        const result = await knowledgeSharedWriterService.addApprovedWithin(client, {
          source, accountId: String(approved.accountId), reason: String(row.reason), expiresAt: String(approved.expiresAt),
          approvalId, deciderPrincipalId: input.deciderPrincipalId, actor, standing: administrativeStanding(input.deciderStanding), evidence: input.evidence,
        });
        return { after: { listed: true }, effect: { sourceId: source.id, sharedWriter: { accountId: result.accountId, auditId: result.auditId } }, revertAt: String(approved.expiresAt) };
      }
      if ((S4_TARGET_TYPES as readonly string[]).includes(targetType)) {
        // The after-state is the before-state with what the act changed laid
        // over it, so the field diff names only the fields that moved.
        const applied = await this.applyIdentityTarget(client, row, targetType, approved, input, actor);
        return { ...applied, after: { ...(parseJson<Record<string, any>>(row.change_spec, {}).before ?? {}), ...applied.after } };
      }
      if ((S5_TARGET_TYPES as readonly string[]).includes(targetType)) {
        const applied = await this.applyObjectTarget(client, row, targetType, approved, input, actor);
        return { ...applied, after: { ...(parseJson<Record<string, any>>(row.change_spec, {}).before ?? {}), ...applied.after } };
      }
    } catch (e) {
      throw asChangeRefusal(e, 'decider', '7.1');
    }
    throw refuse(422, 'KIND_NOT_DECIDABLE', `a ${targetType} change is not decided here`, 'decider', '7.1', 'decide applies every S1 target by name');
  }

  /**
   * THE APPLY OF THE S4 IDENTITY TARGETS (section 3, section 7.1), inside the
   * decide transaction, through the executor that already performs the direct
   * act, with the DECIDER as the standing principal and the decision's ledger
   * on the act's own audit row. The decision's one step-up (already checked
   * as this decision's evidence, section 5.3) stands for the act's: no
   * executor here consumes a second token.
   */
  private async applyIdentityTarget(client: PoolClient, row: any, targetType: ChangeTargetType, approved: Record<string, any>,
    input: ChangeDecideInput & { deciderStanding: ChangeDeciderStanding },
    actor: AuditActor): Promise<{ after: Record<string, unknown>; effect: Record<string, unknown>; revertAt: string | null; afterCommit?: () => void }> {
    const approvalId = String(row.id);
    const targetId = String(row.target_id);
    const deciderStanding = administrativeStanding(input.deciderStanding);
    const ledger = {
      approvalId, kind: 'change', targetType, deciderStanding, stepUp: input.stepUp,
      chain: await auditChainFor(client, String(row.requester_principal_id)),
    };
    const deciderRow = (await client.query('SELECT handle, role FROM principals WHERE id = $1', [input.deciderPrincipalId])).rows[0];
    const deciderRole = resolveActorRole({ handle: String(deciderRow?.handle ?? ''), principalRole: deciderRow?.role ?? null });
    const ceiling = (what: string) => refuse(403, 'DECIDER_CEILING_EXCEEDED', what, 'decider', '5.1',
      "the approved change lies within the decider's own authority");

    if (targetType === 'identity.role') {
      // section 5.1 (4)-(5): an elevated role only from an `admin` issuer (canAssignRole, the act's own ceiling).
      if (!canAssignRole(deciderRole, approved.role)) {
        throw ceiling(`a '${approved.role}' role is given only by an admin issuer; this decider is '${deciderRole}'`);
      }
      const { updated, previousRole } = await principalRoleService.change(client, {
        targetId, role: approved.role, issuer: { principalId: input.deciderPrincipalId, issuerRole: deciderRole },
        actor, seam: 'change request identity.role', metadata: ledger,
      });
      return {
        after: { role: updated.role }, effect: { principalId: updated.id, previousRole, role: updated.role }, revertAt: null,
        afterCommit: () => principalService.cachePrincipal(updated),
      };
    }
    if (targetType === 'identity.create') {
      if (approved.role && !canAssignRole(deciderRole, approved.role)) {
        throw ceiling(`a '${approved.role}' role is given only by an admin issuer; this decider is '${deciderRole}'`);
      }
      const created = await principalService.createPrincipal({
        handle: String(approved.handle), kind: approved.kind, displayName: approved.displayName ?? null,
        role: approved.role ?? null, purpose: approved.purpose ?? null,
      }, client);
      if (!created) throw refuse(409, 'ALREADY_HELD', 'a principal with that handle already exists', 'target', '7.1', 'the handle is free at decide');
      // The existing `principal.create` row (its `kind` stays the principal's kind; the decision rides beside it).
      await auditService.record({
        action: 'principal.create', actor, resourceType: 'principal', resourceId: created.id,
        metadata: { ...ledger, requestKind: 'change', kind: created.kind, handle: created.handle, role: created.role },
      }, client);
      return {
        after: { exists: true, principalId: created.id, handle: created.handle, kind: created.kind, role: created.role },
        effect: { principalId: created.id, handle: created.handle }, revertAt: null,
        afterCommit: () => principalService.invalidateHandles([created.handle]),
      };
    }
    if (targetType === 'identity.status') {
      const result = await principalService.applyAccountStatus(client, {
        principalId: targetId, status: approved.status, actor, metadata: ledger,
      });
      if (!result.principal) throw refuse(404, 'TARGET_NOT_FOUND', 'the principal no longer exists', 'target', '7.1', 'the target exists at decide');
      const principal = result.principal;
      return {
        after: { status: principal.status },
        effect: { principalId: principal.id, previousStatus: result.previousStatus, status: principal.status,
          sessionsRevoked: result.sessionsRevoked, lapsedApprovalIds: result.lapsedApprovalIds },
        revertAt: null,
        afterCommit: () => (principal.status === 'disabled'
          ? principalService.invalidatePrincipals([principal.id]) : principalService.cachePrincipal(principal)),
      };
    }
    if (targetType === 'credential.revoke') {
      const revoked = await principalService.revokeCredentialById(targetId, `change request ${approvalId}`, actor, client, ledger);
      if (!revoked) throw refuse(409, 'CREDENTIAL_NOT_LIVE', 'the credential is no longer live', 'target', '7.1', 'the target is live at decide');
      return { after: { revoked: true }, effect: { revokedCredentialId: targetId }, revertAt: null };
    }
    if (targetType === 'warrant.create') {
      const spec: Record<string, unknown> = {};
      for (const field of WARRANT_CREATE_FIELDS) if (approved[field] !== undefined && approved[field] !== null) spec[field] = approved[field];
      const warrant = await warrantService.create(spec as never, {
        principalId: input.deciderPrincipalId, isRoot: deciderStanding === 'root', sessionScopes: input.deciderScopes ?? [],
        stepUp: input.stepUp, auditMetadata: ledger,
      }, actor, client);
      return { after: { warrantId: warrant.id, status: warrant.status }, effect: { warrantId: warrant.id }, revertAt: null };
    }
    if (targetType === 'warrant.edit') {
      const fields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(approved)) if (EDITABLE_FIELDS.warrant.includes(key)) fields[key] = value;
      const result = await authorityEditExecutor.applyDecidedChange(client, {
        type: 'warrant', id: targetId, fields, approvalId,
        decider: { principalId: input.deciderPrincipalId, standing: deciderStanding, sessionScopes: input.deciderScopes ?? [], role: deciderRole },
        stepUp: input.stepUp, evidence: { tokenId: input.stepUp.tokenId, method: input.stepUp.method, approvalId, deciderPrincipalId: input.deciderPrincipalId },
        // The decider approved the riding-task count the request showed; the stale check held it equal.
        acknowledgeDependents: true,
      }, actor);
      return { after: result.after, effect: { warrantId: targetId, auditId: result.auditId, releasedTaskIds: result.releasedTaskIds }, revertAt: null };
    }
    if (targetType === 'warrant.revoke') {
      const warrant = await warrantService.revoke(targetId, `change request ${approvalId}`, actor, async () => [],
        { acknowledgeDependents: true, transactionClient: client, auditMetadata: ledger });
      return { after: { status: warrant.status }, effect: { warrantId: targetId }, revertAt: null };
    }
    if (targetType === 'warrant.resume') {
      const warrant = await warrantService.resume(targetId, actor, { transactionClient: client, auditMetadata: ledger });
      return { after: { status: warrant.status }, effect: { warrantId: targetId }, revertAt: null };
    }
    throw refuse(422, 'KIND_NOT_DECIDABLE', `a ${targetType} change is not decided here`, 'decider', '7.1', 'decide applies every built target by name');
  }

  /**
   * THE APPLY OF THE S5 OBJECT TARGETS (section 3, section 7.1), inside the
   * decide transaction, through the executor of the direct act, with the
   * DECIDER as the acting principal. In order:
   *   1. the deciding session's own facts are present and are the decider's
   *      (fail closed: no executor runs under anyone else's authority);
   *   2. section 5.1 (5): the decider's own live reach on the object, at the
   *      action the direct door asks (S5_DECIDER_ACTION), so an approval never
   *      applies what its decider could not do directly;
   *   3. the executor, which runs its own direct predicate on the decider's
   *      facts and takes the decision's consumed step-up as its evidence where
   *      its direct act takes a step-up (section 5.3), its existing audit row
   *      carrying the decision's ledger.
   * The stale check has already held the object equal to the filed state.
   */
  private async applyObjectTarget(client: PoolClient, row: any, targetType: ChangeTargetType, approved: Record<string, any>,
    input: ChangeDecideInput & { deciderStanding: ChangeDeciderStanding; evidence: { tokenId: string; method: string; approvalId: string; deciderPrincipalId: string } },
    actor: AuditActor): Promise<{ after: Record<string, unknown>; effect: Record<string, unknown>; revertAt: string | null; afterCommit?: () => void }> {
    const approvalId = String(row.id);
    const targetId = lower(String(row.target_id));
    const type = S5_OBJECT_TYPE[targetType];
    const request = input.deciderRequest;
    // 1. The decider's own session facts, or nothing is applied.
    if (!request || !request.authorization?.authenticated || !request.principalId
      || lower(String(request.authorization.principalId ?? '')) !== lower(input.deciderPrincipalId)
      || lower(request.principalId) !== lower(input.deciderPrincipalId)) {
      throw refuse(403, APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR, "an object change is applied on the deciding session's own facts, which this decision does not carry",
        'decider', '5.1', 'the executor runs its direct predicate on the decider');
    }
    // 2. section 5.1 (5): the decider's own reach on the object.
    const action = S5_DECIDER_ACTION[targetType];
    if (action && !(await authorizationRepository.authorizedIds(request.authorization, type, [targetId], action, client)).has(targetId)) {
      throw refuse(403, 'DECIDER_CEILING_EXCEEDED',
        `this session does not hold ${action} on the ${type} itself: an approval never applies what its decider could not do directly`,
        'decider', '5.1', "the approved change lies within the decider's own authority on the object", { action });
    }
    const ledger = {
      approvalId, kind: 'change', targetType, deciderStanding: input.deciderStanding, stepUp: input.stepUp,
      requesterChain: await auditChainFor(client, String(row.requester_principal_id)),
    };
    const executors = objectExecutors();
    const reason = `change request ${approvalId}: ${String(row.reason ?? '')}`;
    const transferStanding = {
      authMethod: request.authMethod, handle: request.handle, principalId: request.principalId, principalRole: request.principalRole,
      sessionRole: request.sessionRole, scopes: request.scopes, stepUpToken: '', decisionEvidence: input.evidence,
    };
    const taskActor = {
      principalId: request.principalId, handle: request.handle, authMethod: request.authMethod as AuditActor['authMethod'],
      credentialId: request.credentialId, sessionId: request.sessionId, authorization: request.authorization,
    };
    const feedActor = { principalId: request.principalId, handle: actor.handle };

    if (targetType === 'project.owner') {
      const moved = await executors.projectOwnership.changeWithin(client, targetId, String(approved.ownerPrincipalId), {
        authorization: request.authorization, authMethod: request.authMethod as AuditActor['authMethod'], audit: actor,
        sessionId: request.sessionId, credentialId: request.credentialId, standing: transferStanding,
      }, ledger);
      return {
        after: { ownerPrincipalId: approved.ownerPrincipalId, ownerKind: approved.ownerKind },
        effect: { projectId: targetId, ownerPrincipalId: approved.ownerPrincipalId }, revertAt: null,
        afterCommit: () => { void moved.afterCommit(); },
      };
    }
    if (targetType === 'task.account_owner') {
      const now = (await client.query(
        `SELECT COALESCE(t.account_owner_principal_id, p.owner_principal_id) AS owner, t.updated_at::text AS owner_revision
           FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = $1`, [targetId])).rows[0];
      const result = await executors.taskAccountOwnership.changeWithin(client, targetId, {
        accountOwnerPrincipalId: String(approved.accountOwnerPrincipalId),
        expectedAccountOwnerPrincipalId: now?.owner ? String(now.owner) : null, expectedUpdatedAt: String(now?.owner_revision ?? ''),
        reason: reason.slice(0, 2000),
      }, taskActor, transferStanding, ledger);
      if (!result.changed) throw refuse(409, 'ALREADY_HELD', 'that Account already owns the Task', 'target', '7.1', 'an approval changes the owner');
      return {
        after: { accountOwnerPrincipalId: approved.accountOwnerPrincipalId, explicitAccountOwnerPrincipalId: approved.accountOwnerPrincipalId, ownerKind: approved.ownerKind },
        effect: { taskId: targetId, accountOwnerPrincipalId: approved.accountOwnerPrincipalId }, revertAt: null,
      };
    }
    if (targetType === 'report.account_owner') {
      const before = parseJson<Record<string, any>>(row.change_spec, {}).before ?? {};
      const moved = await executors.reportAccountOwnership.reportAccountOwnershipService.changeWithin(client, {
        reportId: targetId, accountOwnerPrincipalId: String(approved.accountOwnerPrincipalId),
        expectedAccountOwnerPrincipalId: before.accountOwnerPrincipalId ?? null, actor, ledger,
      });
      return { after: { accountOwnerPrincipalId: moved.next }, effect: { reportId: targetId, previous: moved.previous, accountOwnerPrincipalId: moved.next }, revertAt: null };
    }
    if (targetType === 'project.default_verifier' || targetType === 'phase.default_verifier') {
      const written = await executors.defaultVerifier.setDefaultVerifierWithin(client, type as 'project' | 'phase', targetId,
        approved.defaultVerifierPrincipalId ?? null, {
          facts: {
            principalId: request.principalId, handle: request.handle, authMethod: request.authMethod, principalRole: request.principalRole,
            sessionRole: request.sessionRole, scopes: request.scopes, sessionId: request.sessionId,
          },
          audit: actor, revision: null, ledger,
        });
      return {
        after: { defaultVerifierPrincipalId: written.defaultVerifierPrincipalId },
        effect: { [`${type}Id`]: targetId, previous: written.previous, defaultVerifierPrincipalId: written.defaultVerifierPrincipalId, standing: written.standing },
        revertAt: null,
      };
    }
    if (targetType === 'charter.revision') {
      const written = await executors.charter.charterService.approveWithin(client, targetId, approved.content, {
        authorization: request.authorization, authMethod: request.authMethod, audit: actor, decisionEvidence: input.evidence,
      }, ledger);
      return {
        after: { version: written.charter.version, contentHash: written.charter.contentHash, content: written.charter.content },
        effect: { projectId: targetId, version: written.charter.version, contentHash: written.charter.contentHash, created: written.created },
        revertAt: null,
      };
    }
    if (targetType === 'phase.goal') {
      const revision = (await client.query('SELECT revision FROM phases WHERE id = $1', [targetId])).rows[0]?.revision;
      const phase = await executors.phases.update(targetId, { goal: approved.goal, revision: String(revision ?? '') }, feedActor, client);
      return { after: { goal: phase.goal ?? null }, effect: { phaseId: targetId, revision: phase.revision }, revertAt: null };
    }
    if (targetType === 'task.roles') {
      const problem = await this.taskRoleProblem(client, targetId, approved);
      if (problem) throw refuse(problem.status, problem.code, problem.message, 'target', '7.1', 'the roles route admits the holders at decide');
      // The roles route's SERVICE_INVOKE_REQUIRED binds a bearer only: every login
      // session that passes the Shepherd reach above holds services:invoke by its
      // role (scopesForRole: the writer, operator and root sets), so a decider never meets it.
      const assignments: { shepherdPrincipalId?: string; verifierPrincipalId?: string | null } = {};
      if (approved.shepherdPrincipalId !== undefined) assignments.shepherdPrincipalId = String(approved.shepherdPrincipalId);
      if (approved.verifierPrincipalId !== undefined) assignments.verifierPrincipalId = approved.verifierPrincipalId === null ? null : String(approved.verifierPrincipalId);
      const transaction = { client, actor: taskActor, source: 'ordinary', afterCommit: () => undefined } as unknown as CreationTransaction;
      const outcome = await executors.tasks.assignTaskRoles(targetId, assignments, actor, transaction, request.authorization, undefined, ledger);
      if (outcome === 'not_found') throw refuse(404, 'TASK_NOT_FOUND', 'the Task no longer exists', 'target', '7.1', 'the target exists at decide');
      if (outcome === 'self_review') throw refuse(409, 'CLAIMANT_VERIFIER_CONFLICT', 'The Assignee and Verifier must be different Principals', 'target', '7.1', 'the roles route admits the holders');
      if (outcome !== 'updated') throw refuse(503, 'TASK_ROLE_ASSIGNMENT_UNAVAILABLE', 'Task role assignment is unavailable', 'target', '7.1', 'the roles writer is available');
      return { after: { ...assignments }, effect: { taskId: targetId, ...assignments }, revertAt: null };
    }
    if (targetType === 'task.access' || targetType === 'phase.access') {
      const before = parseJson<Record<string, any>>(row.change_spec, {}).before ?? {};
      const accessInput = { restricted: Boolean(approved.restricted), reason: reason.slice(0, 1000), actorPrincipalId: request.principalId };
      if (targetType === 'task.access') {
        await executors.taskAccess.setRestrictedAccess(targetId, accessInput, client);
      } else {
        const revision = (await client.query('SELECT revision FROM phases WHERE id = $1', [targetId])).rows[0]?.revision;
        await executors.phases.setRestrictedAccess(targetId, { ...accessInput, revision: String(revision ?? '') }, client);
      }
      // Section 3: the apply writes the family's first audit_events row beside the trigger ledger.
      await auditService.record({
        action: `${type}.access.set`, actor, resourceType: type, resourceId: targetId,
        metadata: { ...ledger, before: { restricted: Boolean(before.restricted) }, after: { restricted: Boolean(approved.restricted) } },
      }, client);
      return { after: { restricted: Boolean(approved.restricted) }, effect: { [`${type}Id`]: targetId, restricted: Boolean(approved.restricted) }, revertAt: null };
    }
    if (targetType === 'report.visibility') {
      const before = parseJson<Record<string, any>>(row.change_spec, {}).before ?? {};
      let updated;
      try {
        updated = await executors.reports.update(targetId, { visibility: String(approved.visibility) }, feedActor, client);
      } catch (e) {
        const code = e instanceof Error ? e.message : '';
        if (code === 'REPORT_ARCHIVED') throw refuse(409, 'REPORT_ARCHIVED', 'the Report is archived and read-only', 'target', '7.1', 'the object is live');
        if (code === 'TASK_REPORT_ROUTE_REQUIRED') throw refuse(422, 'REPORT_TASK_BOUND', "a task-bound Report's visibility follows its Task", 'target', '7.1', 'a standalone Report');
        throw e;
      }
      if (!updated) throw refuse(404, 'TARGET_NOT_FOUND', 'the Report no longer exists', 'target', '7.1', 'the target exists at decide');
      await auditService.record({
        action: 'report.visibility.set', actor, resourceType: 'report', resourceId: targetId,
        metadata: { ...ledger, before: { visibility: before.visibility ?? null }, after: { visibility: updated.visibility } },
      }, client);
      return { after: { visibility: updated.visibility }, effect: { reportId: targetId, visibility: updated.visibility }, revertAt: null };
    }
    throw refuse(422, 'KIND_NOT_DECIDABLE', `a ${targetType} change is not decided here`, 'decider', '7.1', 'decide applies every built target by name');
  }

  /** clause 12: exact ids resolve to rows at decide. */
  private async assertObjectsExist(client: Queryable, rules: ProfileRule[]): Promise<void> {
    for (const rule of rules) {
      const table = OBJECT_TABLES[rule.resourceType];
      if (rule.selectorForm !== 'exact' || !table) continue;
      const found = await client.query(`SELECT id::text AS id FROM ${table} WHERE id = ANY($1::uuid[])`, [rule.selectorIds]);
      const have = new Set(found.rows.map((r) => String(r.id)));
      const missing = rule.selectorIds.filter((id) => !have.has(lower(id)));
      if (missing.length > 0) {
        throw refuse(409, 'OBJECT_NOT_FOUND', `${rule.resourceType} ${missing.join(', ')} resolves to no row: untick it and approve the rest`,
          'decider', '7.1', 'an approval writes rows only on objects that exist', { missing });
      }
    }
  }

  /**
   * Write every approved (row, verb) for the grantee — an Account OR a Group —
   * through GrantService.create in the decide transaction (section 3: the
   * Group-grantee path threads granteeType into the probe and the insert). An
   * expired identical row is replaced; a live one refuses ALREADY_HELD by name.
   */
  private async writeApprovedGrants(client: PoolClient, input: {
    approvalId: string; requesterId: string; grantee: Grantee; rules: ProfileRule[]; expiresAt: string; actor: AuditActor;
  }): Promise<{ created: string[]; replaced: string[]; rows: Array<Record<string, unknown>> }> {
    const created: string[] = [];
    const replaced: string[] = [];
    const rows: Array<Record<string, unknown>> = [];
    for (const rule of input.rules) {
      const ids: Array<string | null> = rule.selectorForm === 'all-of-type' ? [null] : rule.selectorIds;
      for (const resourceId of ids) {
        for (const verb of rule.verbs) {
          const existing = (await client.query(
            `SELECT id, expires_at FROM grants
              WHERE grantee_type = $1 AND grantee_id = $2 AND resource_type = $3
                AND resource_id IS NOT DISTINCT FROM $4::uuid AND verb = $5 FOR UPDATE`,
            [input.grantee.type, input.grantee.id, rule.resourceType, resourceId, verb])).rows[0];
          let replacedId: string | null = null;
          if (existing) {
            const live = !existing.expires_at || new Date(existing.expires_at).getTime() > Date.now();
            if (live) {
              throw refuse(409, 'ALREADY_HELD',
                `the grantee already holds ${verb} on ${rule.resourceType} ${resourceId ?? '(every object of the type)'} through grant ${existing.id}`,
                'grantee', '7.1', 'a live identical row is refused by name, never as a unique violation', { grantId: String(existing.id) });
            }
            await client.query('DELETE FROM grants WHERE id = $1', [existing.id]);
            await auditService.record({
              action: 'grant.revoke', actor: input.actor, resourceType: 'grant', resourceId: String(existing.id),
              metadata: { automatic: true, reason: 'EXPIRED_REPLACED', approvalId: input.approvalId, kind: 'change' },
            }, client);
            replacedId = String(existing.id);
          }
          const grant = await grantService.create({
            granteeType: input.grantee.type, granteeId: input.grantee.id, resourceType: rule.resourceType,
            resourceId, verb, expiresAt: input.expiresAt,
          }, input.actor, client, { approvalId: input.approvalId, requesterPrincipalId: input.requesterId, kind: 'change' });
          if (replacedId) {
            // A vehicle that linked the expired row links its replacement, which the
            // approval created (the legacy kind's rule): created_by_vehicle FALSE.
            await client.query(
              `UPDATE access_vehicle_links SET target_id = $2, created_by_vehicle = FALSE WHERE target_kind = 'grant' AND target_id = $1`,
              [replacedId, grant.id]);
            replaced.push(replacedId);
          }
          created.push(grant.id);
          rows.push({ resourceType: rule.resourceType, resourceId, verb, grantId: grant.id, expiresAt: grant.expiresAt });
        }
      }
    }
    return { created, replaced, rows };
  }

  // ═════════════════════════════ COLLECT ═════════════════════════════

  /**
   * COLLECT an approved credential.issue change (section 7.2(a), section 12 Q9
   * (a)): by the TARGET Connector's own live credential, once, within 24 hours
   * of approval. Every other caller is answered as an absent id. It re-runs the
   * checks and issues through the one issuance executor, capped by the
   * DECIDER's authority now; collect is the application, so it stamps
   * applied_at and writes `approval.applied`.
   */
  async collect(input: { approvalId: string; presentingPrincipalId: string; presentingCredentialId: string }, actor: AuditActor):
    Promise<{ approvalId: string; issued: IssuedConnectorCredential }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = UUID_PATTERN.test(input.approvalId ?? '')
        ? (await client.query('SELECT * FROM approvals WHERE id = $1 FOR UPDATE', [input.approvalId])).rows[0] : null;
      if (!row || row.kind !== 'change' || row.target_type !== 'credential.issue'
        || lower(String(row.target_id)) !== lower(input.presentingPrincipalId)) {
        throw new ApprovalError(404, 'APPROVAL_NOT_FOUND', 'No such approval');
      }
      const approvalId = String(row.id);
      if (row.status !== 'approved') {
        throw refuse(409, 'APPROVAL_NOT_COLLECTABLE', `this request is ${row.status}: collect consumes an APPROVED credential.issue once`,
          'requester', '7.2', 'collect consumes the approved authorization once, by the target Connector');
      }
      const lapseAndRefuse = async (reason: string, message: string): Promise<never> => {
        await this.lapse(client, approvalId, reason, actor);
        await client.query('COMMIT');
        throw refuse(409, 'APPROVAL_LAPSED', message, 'requester', '7.2', 'collect re-runs every check', { lapseReason: reason });
      };
      if (row.collect_expires_at && new Date(row.collect_expires_at).getTime() <= Date.now()) {
        await lapseAndRefuse('COLLECT_TTL_EXPIRED', 'this approval passed its 24-hour collect window and lapsed');
      }
      const spec = parseJson<Record<string, any>>(row.change_spec, {});
      const approved = spec.approved as Record<string, any>;
      if (new Date(approved.expiresAt).getTime() <= Date.now()) {
        await lapseAndRefuse('PENDING_EXPIRED', 'the approved expiry passed before collect, so the request lapsed');
      }
      // The collecting credential is the target Connector's own LIVE credential.
      try {
        await agentMintService.assertRequesterLive(input.presentingPrincipalId, input.presentingCredentialId);
      } catch (e) {
        if (e instanceof AgentMintError) {
          throw refuse(e.status, e.code, e.message, 'requester', '7.2', "collect is by the target Connector's own live credential");
        }
        throw e;
      }
      const deciderRow = row.decided_by_principal_id
        ? (await client.query('SELECT id, handle, role, status, legacy_identity FROM principals WHERE id = $1', [row.decided_by_principal_id])).rows[0]
        : null;
      const deciderRole = deciderRow ? resolveActorRole({ handle: String(deciderRow.handle ?? ''), principalRole: deciderRow.role ?? null }) : '';
      if (!deciderRow || deciderRow.status !== 'active' || deciderRow.legacy_identity || !ROLE_ACT_ISSUER_ROLES.includes(deciderRole)) {
        throw refuse(403, 'DECIDER_NO_LONGER_ADMITTED',
          'the Account that approved this request no longer holds the standing to decide it, so nothing is issued', 'decider', '7.2',
          "collect re-runs every check, the decider's standing included");
      }
      const deciderScopes = scopesForRole(deciderRole) as string[];
      const scopes = assertConnectorCredentialScopes(approved.scopes, 'decider');
      await this.assertCredentialNotHeld(client, String(row.target_id), scopes, String(approved.transport));
      let issued: IssuedConnectorCredential;
      try {
        issued = await executeConnectorCredentialIssue(client, {
          connectorPrincipalId: String(row.target_id),
          scopes,
          transport: String(approved.transport) as ConnectorCredentialTransport,
          expiresAt: new Date(approved.expiresAt),
          label: approved.label ? String(approved.label) : `change request ${approvalId.slice(0, 8)}`,
          authority: { principalId: String(deciderRow.id), standing: deciderScopes.includes('root') ? 'root' : 'administrator', scopes: deciderScopes },
          approvalId,
        }, actor);
      } catch (e) {
        throw asChangeRefusal(e, 'decider', '7.2');
      }
      const effect = { credentialId: issued.credentialId, keyId: issued.keyId, connectorPrincipalId: String(row.target_id) };
      await client.query(
        `UPDATE approvals SET status = 'collected', collected_at = NOW(), minted_principal_id = $2, applied_at = NOW(),
                applied_effect = COALESCE(applied_effect, '{}'::jsonb) || $3::jsonb, updated_at = NOW()
          WHERE id = $1`, [approvalId, String(row.target_id), JSON.stringify(effect)]);
      // The ledger names the credential by id and keyId — never its secret.
      const metadata = { kind: 'change', targetType: 'credential.issue', ...effect, scopes: issued.scopes, transport: issued.transport, expiresAt: issued.expiresAt };
      await this.writeEvent(client, approvalId, 'approval.collected', actor, metadata);
      await this.writeEvent(client, approvalId, 'approval.applied', actor, metadata);
      await auditService.record({
        action: 'approval.collect', actor, resourceType: 'approval', resourceId: approvalId,
        metadata: { ...metadata, deciderPrincipalId: String(deciderRow.id), chain: await auditChainFor(client, String(row.target_id)) },
      }, client);
      await client.query('COMMIT');
      return { approvalId, issued };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      await this.auditRefusal('approval.collect', e, actor,
        { type: 'approval', id: UUID_PATTERN.test(input.approvalId ?? '') ? input.approvalId : null }, input.presentingPrincipalId);
      throw e;
    } finally {
      client.release();
    }
  }

  /** Whether an approval id names a change request this principal may COLLECT (the target Connector). */
  async isCollectableBy(approvalId: string, principalId: string): Promise<boolean> {
    if (!UUID_PATTERN.test(approvalId ?? '')) return false;
    const row = (await pool.query('SELECT kind, target_type, target_id FROM approvals WHERE id = $1', [approvalId])).rows[0];
    return Boolean(row && row.kind === 'change' && row.target_type === 'credential.issue'
      && lower(String(row.target_id)) === lower(principalId));
  }

  // ═════════════════════════════ shared ═════════════════════════════

  private async writeEvent(q: Queryable, approvalId: string, action: string, actor: AuditActor, metadata: Record<string, unknown>): Promise<void> {
    await q.query(
      `INSERT INTO approval_events (approval_id, action, actor_principal_id, actor_handle, metadata) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [approvalId, action, actor.principalId ?? null, actor.handle || 'unknown', JSON.stringify(metadata)]);
  }

  private async lapse(q: Queryable, approvalId: string, reason: string, actor: AuditActor): Promise<void> {
    const metadata = { reason, kind: 'change' };
    await q.query(
      `UPDATE approvals SET status = 'lapsed', lapse_reason = $2, updated_at = NOW() WHERE id = $1 AND status IN ('pending', 'approved')`,
      [approvalId, reason]);
    await this.writeEvent(q, approvalId, 'approval.lapsed', actor, metadata);
    await auditService.record({ action: 'approval.lapse', actor, resourceType: 'approval', resourceId: approvalId, metadata }, q as any);
  }

  /** A durable denied audit for a refusal, written on the pool so a rollback cannot erase it (§5.2 rule 8). */
  private async auditRefusal(action: string, e: unknown, actor: AuditActor, resource: { type: string; id: string | null }, chainPrincipalId: string | null): Promise<void> {
    if (!(e instanceof ApprovalError)) return;
    await auditService.record({
      action, actor, outcome: 'denied', resourceType: resource.type, resourceId: resource.id,
      metadata: { refusal: e.code, chain: chainPrincipalId ? await auditChainFor(pool, chainPrincipalId).catch(() => []) : [], ...(e.refusal ?? {}) },
    }).catch(() => undefined);
  }

}

export const changeRequestService = new ChangeRequestService();

/** The record type used by callers that hold an ApprovalRecord of kind change. */
export type ChangeApprovalRecord = ApprovalRecord & { change: ChangeFields };
