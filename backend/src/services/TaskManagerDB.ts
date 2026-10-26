import { taskAccountControl, recordAccountTaskDisposition } from './AccountControlService';
import { assertHumanTaskArchiveAuthority } from './TaskArchiveAuthority';
// Unforgeable, server-only operation marker: never copied from a request body.
const RESTORE_ARCHIVE = Symbol('restore-archive');
const ARCHIVE_COMPLETED = Symbol('archive-completed');
import { assignedClaimBindingSql, assignedClaimEligibleSql, assignedClaimPrincipalSql, assignedClaimCaps } from './AssignedClaimAuthority';
import { taskAuthoritySnapshot } from './TaskAuthoritySnapshot';
import { authorizationRepository } from './AuthorizationRepository';
import { isValidSubtaskId, SUBTASK_ID_ERROR } from '../utils/taskIds';
import { grantService } from './GrantService';
import { blueprintProvenanceOf, type BlueprintProvenanceFields } from '../utils/blueprintProvenance';
import type { CreationTransaction } from '../db/creationTransaction';
import { lockDependencyGraph } from '../db/dependencyGraph';
import { bulkArchiveFailure } from '../utils/bulkArchiveFailure';
import { logCaughtFailure, logCaughtWarning } from '../utils/secretSafeLog';
import { NotFoundFault, ForbiddenFault, ConflictFault, InvalidRequestFault, ProjectTargetNotFoundFault, RequestFaultError } from '../utils/httpErrors';
// TaskManagerDB.ts - PostgreSQL-backed task management (replacement for JSON file)
import { EventEmitter } from 'events';
import { isDeepStrictEqual } from 'util';
import { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../db/connection';
import { isLegacyExecutionProfile } from '../utils/executionProfile';
import { buildDiscordThreadUrl, resolveTaskDiscordThreadId } from '../utils/discordLinks';
import { taskHistoryService, TaskActor } from './TaskHistoryService';
import type { TaskAutomationRole } from '../utils/taskAutomationRole';
import { auditService, type AuditActor } from './AuditService';
import { lifecyclePolicyService } from './LifecyclePolicyService';
import { feedEventService, type FeedActorRef } from './FeedEventService';
import { accessVehicleService, AssignmentAccessError, SYSTEM_AUTHORIZATION_ACTOR } from './AccessVehicleService';
import type { AuthorizationActor } from './AuthorizationService';
// Type-only: the board's authorization is a PARAMETER, so the query layer
// never reaches for an actor of its own and this import erases at compile time.
import type { AuthorizationListScope } from './AuthorizationRepository';
// Type-only, for the same reason: the TARGET-Project decision is a PARAMETER
// (card 9c177e6a), so this layer never builds an authorization actor of its own.
import type { AuthorizedProjectTarget } from '../middleware/sharedAuthorization';
import { syncTaskReadiness, syncDependentsReadiness } from '../utils/taskReadiness';
import { reapAccessRequestsAtTerminal } from '../utils/accessRequestTerminal';
import { runTaskTerminalEffects } from './TaskTerminalEffects';
import { verificationModeOf, verificationNoneSetterBasis, recordVerificationNone, recordVerificationNoneCleared, VerificationModeError, type DisplacedVerifier, type VerificationMode } from './VerificationModes';
import { assigningActExpiry, ROLE_GRANT_EXPIRY_FIELD, type RoleGrantExpiryRequest } from '../utils/roleGrantExpiry';
import { isPlanningTaskStatusPatch, isTaskCompletionPatch, isTaskArchivePatch } from '../utils/taskLifecycle';
import { assertTaskPlanningAuthority } from './TaskPlanningAuthority';
import { assertTaskCompletionAuthority, assertCompletedTaskWriteAuthority } from './TaskCompletionAuthority';
import { readInboxPhase, resolveCreatePlacement, statusAbsent } from './ProjectInboxPhase';
import { usableVerifierPrincipalIds, verifierUnusableSql, verifierUsabilityOf, VERIFIER_ARM_REASONS, type DefaultVerifierWarning } from './VerifierUsability';

/** Card 41e24358 (migration 155): the vocabulary of tasks.verifier_source. */
export type VerifierSource = 'explicit' | 'inherited-phase' | 'inherited-project' | 'assigned';

/** Where the create's Verifier decision is reported back to the route. */
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CreateTaskReceipt {
  warnings: DefaultVerifierWarning[];
}

/**
 * The authority that caps an AZ-S7 vehicle recompute triggered by a link
 * edit (review bedc25f3 B2). A request-borne actor carries its own; a
 * genuine server-side act (a sweep, a migration follow-up) is the board
 * acting on nobody's behalf and says so explicitly.
 */
function linkerAuthorizationFor(actor?: TaskActor): AuthorizationActor {
  return actor?.authorization ?? SYSTEM_AUTHORIZATION_ACTOR;
}

function taskAuditActor(actor?: TaskActor): AuditActor {
  return actor ? {
    principalId: actor.principalId,
    handle: actor.handle,
    authMethod: actor.authMethod ?? 'unknown',
    credentialId: actor.credentialId ?? null,
  } : { handle: 'system', authMethod: 'system' };
}

/** Every answer the claim decides (Phase 1, spec b48bb799 §3.3). */
export type ClaimOutcome = 'authority_changed' | 'epoch_mismatch' | 'claimed' | 'already_assignee'
  | 'conflict' | 'self_review' | 'unarmed' | 'dependency_blocked' | 'not_found' | 'unavailable';

/**
 * Card 3fc32dd1: each claim refusal in the vocabulary of the lifecycle
 * projection (`lifecycleAccess.claim.reason`, TaskLifecycleAccess.ts), so the
 * route's refusal, its `task.claim` audit row and the disabled dashboard
 * control name one reason. The two refusals the projection cannot foresee —
 * authority that changed under the Task lock and the epoch compare-and-set —
 * keep their own codes as their reason.
 */
export const CLAIM_REFUSAL_REASONS: Readonly<Partial<Record<ClaimOutcome, string>>> = {
  authority_changed: 'TASK_CLAIM_AUTHORITY_CHANGED',
  epoch_mismatch: 'TASK_ASSIGNMENT_EPOCH_MISMATCH',
  conflict: 'TASK_ALREADY_ASSIGNED',
  self_review: 'INDEPENDENT_VERIFIER',
  unarmed: 'TASK_NOT_ARMED',
  dependency_blocked: 'TASK_BLOCKED',
};

// Re-export types from TaskManager for compatibility
export type TaskStatus = 'ideas' | 'todo' | 'in-progress' | 'review' | 'stuck' | 'completed' | 'archived';
export type TaskPriority = 'urgent' | 'high' | 'normal' | 'low' | 'someday';
export type TaskLinkType = 'project' | 'tool' | 'git' | 'doc' | 'memory' | 'session' | 'report';
// TaskPlanningMode deleted (RH-P2.2, owner ruling 2e51b732 §8.1): the field never
// persisted — the pre-D-15 normalizer always dropped it, so every stored value is
// absent by construction. The concept's tombstone lives in the design report.

// Phase 4: 6-state subtask lifecycle
// empty       - Not started
// in-progress - Agent working on it
// review      - To be reviewed by an independent Verifier
// stuck       - Cannot proceed; needs human/data intervention
// skipped     - Intentionally skipped (counts as "done")
// completed   - Approved by an independent Verifier
export type SubtaskStatus = 'empty' | 'in-progress' | 'review' | 'stuck' | 'skipped' | 'completed';

// Valid statuses for different roles
export const AGENT_ALLOWED_STATUSES: SubtaskStatus[] = ['in-progress', 'review', 'stuck'];
export const ORCHESTRATOR_ALLOWED_STATUSES: SubtaskStatus[] = ['empty', 'in-progress', 'review', 'stuck', 'skipped', 'completed'];
// "Done" statuses for completion checks
export const DONE_STATUSES: SubtaskStatus[] = ['completed', 'skipped'];
export const AGENT_ALLOWED_TASK_STATUSES: TaskStatus[] = ['in-progress', 'review', 'stuck'];

/**
 * RH-P3.C3 — the shepherd's ONE-CLICK MELTDOWN RECOVERY input.
 *
 * Strategy 4e40f06f §2.6.4 [RATIFIED 2026-08-02 — C4]: "the shepherd gets a
 * single operation — force-release + reassign, seeded from the last good
 * report — because agents do not self-recover from context meltdown
 * (Vending-Bench); kill-and-restart-from-external-state IS the recovery, and
 * reports-first is what makes it possible".
 *
 * The reassignment target is REQUIRED. Force-release on its own already
 * exists (`releaseTask` with `force`); what is ratified here is the combined
 * act, and a recovery that put the work back in the queue with no assignee
 * would fire no `task.ready` and rescue nothing. Restarting the SAME
 * Connector is a legitimate target — that is the kill-and-restart case.
 *
 * The caller supplies an execution profile already validated against the
 * Connector's pinned descriptor and already past the `services:invoke`
 * check, exactly as the ordinary assignment write does. Vocabulary
 * b94dd86e §5.3: "Shepherd reassignment to a Service additionally requires
 * `invoke` on that Service or assignment authority over it — a role change
 * must not become a covert execution grant."
 */
export interface MeltdownRecoveryInput {
  /** The assignment field of record (`tasks.execution_service_id`). */
  executionServiceId: string;
  /** The descriptor-validated profile the route produced. */
  executionProfile: unknown;
  executionDescriptorVersion: string | null;
  /** AZ-S7 access vehicle; null takes the auto-grant fallback (R2(b)). */
  executionWarrantId?: string | null;
  /** AZ-A10 clause 6: the date the recovering shepherd sets on the
   * reassignment's grant rows; absent = the default. Recovery reassigns, so
   * it is an assigning act (E62). */
  roleGrantExpiry?: RoleGrantExpiryRequest;
  /** Free text recorded in the audit and the Task stream. */
  reason?: string;
}

export interface MeltdownRecoveryResult {
  outcome: 'recovered' | 'replayed' | 'not_found' | 'task_terminal' | 'unavailable';
  /**
   * The Report the restart is seeded from: the newest live Report linked to
   * this Task. `null` when the Task carries none — the honest answer for a
   * claimant that melted down before filing anything, which is precisely the
   * case this operation exists for. The recovery still runs; it says so.
   */
  seedReportId?: string | null;
  previousClaimantPrincipalId?: string | null;
  previousAssigneeServiceId?: string | null;
  assigneeServiceId?: string | null;
  releasedLeaseIds?: string[];
  previousStatus?: string;
  status?: string;
}

export function allSubtaskStatusesDone(statuses: readonly string[]): boolean {
  return statuses.every((status) => status === 'completed' || status === 'skipped');
}

/** Completed Tasks must be reopened explicitly before unfinished work is added. */
function assertTerminalTaskChildren(parentStatus: string, statuses: readonly string[]): void {
  if (parentStatus === 'completed' && !allSubtaskStatusesDone(statuses)) {
    throw new ConflictFault('Reopen the task before adding or reopening unfinished subtasks', 'TASK_REOPEN_REQUIRED');
  }
}

function assertSubtaskStatusTransition(role: TaskAutomationRole, currentStatus: SubtaskStatus, newStatus: SubtaskStatus): void {
  if (newStatus === 'completed' && role !== 'qa' && role !== 'reviewer') {
    throw new ForbiddenFault('Only an independent Verifier identity can complete a subtask');
  }
  if (newStatus === 'completed' && currentStatus !== 'review') {
    throw new Error(`A subtask can only be completed from review (current status: ${currentStatus})`);
  }
  if (role === 'agent') {
    if (!AGENT_ALLOWED_STATUSES.includes(newStatus)) {
      throw new ForbiddenFault(`Agents cannot set subtask status to '${newStatus}'. Allowed: ${AGENT_ALLOWED_STATUSES.join(', ')}`);
    }
    if (DONE_STATUSES.includes(currentStatus)) throw new ForbiddenFault(`Cannot change status of ${currentStatus} subtasks`);
    if (currentStatus === 'stuck' && newStatus !== 'stuck') {
      throw new ForbiddenFault('Cannot resume a stuck subtask. An independent Verifier or orchestrator must resolve it.');
    }
  }
}

// Disposition recorded when a task transitions into 'archived':
//   completed - the work was actually done (task was completed at archive time,
//               or every subtask ended completed/skipped)
//   abandoned - archived without the work being finished
export type ArchiveDisposition = 'completed' | 'abandoned';

export interface DashboardTaskSummary {
  ideas: number;
  todo: number;
  inProgress: number;
  review: number;
  stuck: number;
  completed: number;
  archived: number;
  recentCompleted: number;
  total: number;
}

/**
 * Typed dependency validation failure. Routes map this to HTTP 400 with a
 * machine-readable `code` and the offending ids, instead of the generic
 * 404/500 that plain Errors fall into.
 */
export type DependencyValidationCode = 'UNKNOWN_DEPENDENCY' | 'SELF_DEPENDENCY';

// Typed unarchive outcomes (review 14c7f96d B1): routes classify by CLASS,
// never by message substring — an unexpected exception whose message happens
// to contain 'not found' must never be mistaken for a domain outcome.
export class TaskNotFoundError extends Error {
  constructor(public readonly taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = 'TaskNotFoundError';
  }
}

export class TaskNotArchivedError extends Error {
  constructor(public readonly taskId: string) {
    super(`Task is not archived: ${taskId}`);
    this.name = 'TaskNotArchivedError';
  }
}

export class DependencyValidationError extends Error {
  readonly code: DependencyValidationCode;
  readonly offendingIds: string[];

  constructor(code: DependencyValidationCode, message: string, offendingIds: string[] = []) {
    super(message);
    this.name = 'DependencyValidationError';
    this.code = code;
    this.offendingIds = offendingIds;
  }
}

// ============================================================
// Dependency semantics — SINGLE SOURCE OF TRUTH
// (task af900dd2: dependency referential integrity)
// ============================================================

/**
 * A dependency blocks until its work is semantically satisfied. Archiving is
 * not completion: archived-abandoned/unknown parents remain fail-closed.
 * Any SQL that derives blocked-ness must mirror this predicate.
 */
/**
 * One end of a dependency edge, carrying exactly the four fields a dependency
 * SUMMARY needs: the id and title the response emits, and the two columns
 * `dependencyBlocks` reads. Deliberately NOT a Task — hydrating a Task to reach
 * four columns is the cost `getDependencyEdgesForTasks` exists to remove.
 */
export interface DependencyEdge {
  id: string;
  title: string;
  status: string;
  archiveDisposition: string | null;
}

export function dependencyBlocks(depStatus: string, archiveDisposition?: string | null): boolean {
  return !dependencySatisfied(depStatus, archiveDisposition);
}

/**
 * A dependency is semantically SATISFIED when its work actually happened:
 * status completed, or archived with archive_disposition = 'completed'.
 * This is also the inverse of dependencyBlocks so scheduler, board and doctor
 * cannot disagree about whether a child may advance.
 */
export function dependencySatisfied(depStatus: string, archiveDisposition?: string | null): boolean {
  return depStatus === 'completed' || (depStatus === 'archived' && archiveDisposition === 'completed');
}

/**
 * Heuristic for archive_disposition, applied both at archive time (updateTask)
 * and by migration 040's backfill of pre-existing archived rows:
 * 'completed' when the task was completed at archive time, or when every
 * subtask ended in a done state (completed/skipped); otherwise 'abandoned'.
 */
export function computeArchiveDisposition(
  previousStatus: string | null,
  subtasks: Array<{ status?: string | null }>
): ArchiveDisposition {
  if (previousStatus === 'completed') return 'completed';
  if (
    subtasks.length > 0 &&
    subtasks.every(s => s.status === 'completed' || s.status === 'skipped')
  ) {
    return 'completed';
  }
  return 'abandoned';
}

// ============================================================
// Unified archive policy — SINGLE SOURCE OF TRUTH
// (task 7d2a60a6: archiving is allowed from ANY status, through BOTH the
// dedicated POST /tasks/:id/archive endpoint and PATCH status->archived,
// with identical semantics: same disposition heuristic, same warning, same
// optional reason note.)
// ============================================================

/**
 * Warning surfaced when a task that never reached 'completed' is archived.
 * Embeds the disposition actually recorded — usually 'abandoned', but
 * 'completed' when every subtask ended done (see computeArchiveDisposition).
 * Returns undefined when the task was completed at archive time.
 */
export function archiveWarningForStatus(
  previousStatus: string | null,
  disposition: ArchiveDisposition
): string | undefined {
  if (previousStatus === 'completed') return undefined;
  return `archiving non-completed task (disposition: ${disposition})`;
}

/**
 * Note line appended to task notes when an archive carries a reason.
 * Identical format for both archive paths.
 */
export function archiveReasonNote(disposition: ArchiveDisposition, reason: string): string {
  return `Archived (${disposition}): ${reason}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** PostgreSQL UUID equality ignores case; graph comparisons must do so too.
 * Only normalize complete UUIDs, preserving malformed values in typed errors. */
function canonicalDependencyId(id: string): string {
  return typeof id === 'string' && id.length === 36 && UUID_RE.test(id) ? id.toLowerCase() : id;
}


export interface Subtask extends BlueprintProvenanceFields {
  id: string;
  text: string;
  completed?: boolean; // Legacy field
  status: SubtaskStatus;
  reviewNote?: string;
  blockedReason?: string; // Why is this subtask blocked?
  completedAt?: string;
  sessionRef?: string;
}

export interface TaskLink {
  type: TaskLinkType;
  url: string;
  title: string;
  icon?: string;
}

export type TaskExecutionMode = 'main' | 'subagent' | 'interactive';
export type TaskExecutionHarness = 'openclaw' | 'hermes';
export type TaskAccessProfile = 'safe' | 'dev' | 'network' | 'browser' | 'elevated';
export type TaskCapability = 'browser' | 'host-browser' | 'elevated' | 'network' | 'discord-thread' | 'long-running';

/**
 * Connector-first execution profile (RH-P2.2, vocabulary D-15): names a
 * Connector and carries ONLY options declared by the pinned immutable
 * capability-descriptor version. Validated by utils/executionProfile.ts.
 */
export interface TaskExecutionProfile {
  serviceId: string;
  descriptorVersion: number;
  options: Record<string, string | number | boolean>;
  parameters?: Record<string, Record<string, string | number | boolean>>;
}

/**
 * The RETIRED pre-D-15 shape. Stored legacy blobs are held, reported and
 * never dropped: hydration surfaces them as legacyExecutionProfile, and the
 * orchestration-lease harness binding keeps reading the raw row value until
 * the RH-P3.1 pickup protocol replaces that contract.
 */
export interface LegacyTaskExecutionProfile {
  mode?: TaskExecutionMode;
  harness?: TaskExecutionHarness;
  accessProfile?: TaskAccessProfile;
  requiredCapabilities?: TaskCapability[];
  allowOverrideAtSpawn?: boolean;
  notes?: string;
}

export interface TaskResources {
  links?: Array<{
    type: 'git' | 'url' | 'file' | 'reference' | 'doc';
    title: string;
    url: string;
  }>;
  files?: string[];
  relatedTasks?: string[];
}

export type ReviewDecision = 'running' | 'pass' | 'reject' | 'escalate';

export interface ReviewFinding {
  severity: 'info' | 'warning' | 'error';
  message: string;
  evidence?: string[];
}

export interface ReviewWorkspaceEvidence {
  workingDirectory?: string;
  gitBranch?: string;
  changedFiles?: string[];
  diffStat?: string;
  commandEvidence?: string[];
}

export interface ReviewHistoryEntry {
  id: string;
  decision: ReviewDecision;
  summary: string;
  triggeredBy: 'user' | 'agent' | 'system';
  createdAt: string;
  completedAt?: string;
  statusBefore?: TaskStatus;
  statusAfter?: TaskStatus;
  findings: ReviewFinding[];
  evidence: {
    successCriteria: string[];
    reports: Array<{ id: string; title: string; summary?: string | null }>;
    sessionRefs: string[];
    completedBy?: { name?: string; sessionKey?: string; harness?: TaskExecutionHarness } | null;
    workspace?: ReviewWorkspaceEvidence;
    testSignals?: string[];
  };
}

export interface Task extends BlueprintProvenanceFields {
  /** Caller-scoped GET projection, not persisted and never mutation authority. */
  reportMaintenanceAccess?: { allowed: boolean; reason: string | null };
  // Core fields
  id: string;
  title: string;
  description: string;
  
  // Status
  status: TaskStatus;
  priority: TaskPriority;
  
  // Subtasks
  subtasks: Subtask[];
  
  // Rich context
  links: TaskLink[];
  
  // Audit trail
  
  // Work tracking
  autoStart: boolean;
  startedAt?: string;
  completedAt?: string;
  archivedAt?: string;
  // Set when status transitions into 'archived'; null for non-archived tasks
  archiveDisposition?: ArchiveDisposition | null;

  // Blocking
  blockedBy: string[];
  blockedReason?: string;
  
  // Task Dependencies
  dependsOn?: string[];
  blocked?: boolean;
  blockingTasks?: Array<{ id: string; title: string }>;
  dependentTasks?: Array<{ id: string; title: string }>;
  
  // Metadata
  project?: string;
  /** tasks.phase_id (migration 079). NULL/absent = unphased, which is the
   *  project backlog and a normal state, not an error. Bound to the task's
   *  own project by the composite FK; a Phase from another Project is
   *  refused, never silently repaired. */
  phaseId?: string | null;
  tags: string[];
  created: string;
  updated: string;
  
  // AI execution
  model?: string;
  executionMode?: TaskExecutionMode;
  executionProfile?: TaskExecutionProfile;
  executionServiceId?: string;
  executionDescriptorVersion?: number;
  legacyExecutionProfile?: LegacyTaskExecutionProfile;
  /** tasks.owner_principal_id (migration 063); null pre-migration or when no Assignee is set. */
  ownerPrincipalId?: string | null;
  /** tasks.creator_principal_id (migration 063); null on rows created before it. */
  creatorPrincipalId?: string | null;
  /** Server-written Shepherd task role (migration 082); every migrated Task names one. */
  shepherdPrincipalId?: string | null;
  /** Server-written Verifier task role (migration 082); must differ from the Assignee. */
  verifierPrincipalId?: string | null;
  /** Card 41e24358 (migration 155): where the Verifier came from - explicit,
   *  inherited-phase, inherited-project or assigned; null when none is set or
   *  the card predates the column. Server-written. */
  verifierSource?: VerifierSource | null;
  /** Section 6.8 (E462 S4b, migration 170): no verification; finish completes the Task. */
  verificationNone?: boolean;
  /** Section 6.8: `none` (stored), else `human`/`service` from the Verifier's kind, else `unassigned`. */
  verificationMode?: VerificationMode;
  verificationNoneSetByPrincipalId?: string | null;
  verificationNoneBasis?: string | null;
  verificationNoneSetAt?: string | null;
  verificationNoneClearedAt?: string | null;
  needsReview?: boolean;
  successCriteria?: string | string[];
  reviewHistory?: ReviewHistoryEntry[];
  maxRetries?: number;
  definitionOfDone?: string | string[];
  constraints?: string | string[];
  discordThreadId?: string | null;  // Discord thread ID for interactive sessions (Phase 3)
  discordThreadUrl?: string | null;  // Guild-scoped link derived via utils/discordLinks (read-only)
  
  // Thinking level
  thinking?: 'low' | 'medium' | 'high';
  thinkingAutoEstimated?: boolean;
  attemptCount?: number;
  
  // Phase 1 Hub Redesign
  trackerUrl?: string;
  phaseTag?: string;
  taskResources?: TaskResources;
  
  // Personality
  personalityId?: string | null;
  personality?: { id: string; slug: string; name: string; color: string | null; category: string | null } | null;

  /** When this Task is due (card 7d38a6e0, migration 124), as an ISO-8601
   *  instant. Absent/null is NO DEADLINE — the ordinary state of most Tasks,
   *  not a missing value. A past instant is accepted: the board records
   *  deadlines, including ones already missed, and does not police them. */
  dueAt?: string | null;

  // Legacy fields
  parentId?: string | null;
  notes?: string;
  completed?: string | null;
}

export interface TaskFilters {
  status?: string;
  statuses?: string[];
  project?: string;
  projects?: string[];
  priority?: string;
  priorities?: string[];
  tag?: string;
  tags?: string[];
  parentId?: string | null;
  /** Phase membership (RH-P2.4). A list so the board can select several at
   *  once, exactly like `projects`; the member `null` selects the UNPHASED
   *  backlog, which is a first-class view rather than the absence of a
   *  filter. An empty array means "no phase constraint". */
  phaseIds?: Array<string | null>;
  q?: string;
  limit?: number;
  offset?: number;
  excludeTaskId?: string;
  includeArchived?: boolean;
  /** owner=<handle> — tasks whose Assignee is the principal with this exact handle. */
  ownerHandle?: string;
  /** mine=true — resolved to the caller's principal id by the route. */
  ownerPrincipalId?: string;
  /** unassigned=true — tasks with no Assignee. */
  unassigned?: boolean;
  /** Card 41e24358: verifierUnusable=true - cards without a usable Verifier
   *  (services/VerifierUsability: no Verifier, or one failing an arm). */
  verifierUnusable?: boolean;
}

export interface TaskFilterOptions {
  tags: string[];
  projects: string[];
}

export interface BoardColumnResult {
  items: Task[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface BoardQueryResult {
  columns: Record<string, BoardColumnResult>;
}

/**
 * PostgreSQL-backed TaskManager
 * Drop-in replacement for JSON file-based TaskManager
 */

/**
 * B-1 (verdict `f2de4eaf`, design record `bf8928ee` v5 §10) — the canonical
 * identity of a Warrant, taken from the authoritative Warrant row.
 *
 * `tasks.execution_warrant_id` is a `UUID` column
 * (`099_assignment_access_vehicles.sql:92`), so PostgreSQL hands it back in
 * canonical lower-case form; the recovery route validates the caller's
 * `executionWarrantId` against a case-INSENSITIVE regex
 * (`routes/tasks.ts:78`, `:260-265`) and forwards the spelling unchanged.
 * Comparing the two as strings therefore let an exact retry carrying an
 * upper-case UUID falsify the replay signature and recover a second time.
 *
 * The lookup is the authoritative source; the lower-cased fallback covers a
 * Warrant id this database does not hold, which the vehicle attach path
 * refuses on its own — the comparison must not silently succeed there either.
 */
export async function canonicalWarrantId(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<{ id: unknown }> }> },
  warrantId: string,
): Promise<string> {
  const found = await client.query('SELECT id FROM warrants WHERE id = $1', [warrantId]);
  if (found.rows.length > 0) return String(found.rows[0].id);
  return warrantId.toLowerCase();
}

/**
 * The deadline, read back at the precision the COLUMN keeps.
 *
 * Card 7d38a6e0, round-2 review. `tasks.due_at` is a `timestamptz`, which
 * PostgreSQL holds to microseconds, and `normalizeTaskDueAtWrite` accepts and
 * stores all six digits. But `pg` parses a `timestamptz` into a JavaScript
 * `Date`, and a `Date` counts whole MILLISECONDS: by the time a row reaches
 * this file the last three digits of the caller's instant are already gone,
 * and no amount of care in `hydrateTask` can put them back. A read that
 * echoed `row.due_at` would report an instant nobody named — the same
 * property the write path exists to hold, broken on the way out.
 *
 * So the value is asked for as TEXT, formatted by the database itself, in the
 * one canonical spelling `normalizeTaskDueAtWrite` also produces. Every SELECT
 * that feeds `hydrateTasks` appends this; `DUE_AT_ISO_RETURNING` is the same
 * expression for a `RETURNING` clause, where there is no `t` alias.
 *
 * It is a projection, not a second query: no extra round trip, no window in
 * which the row and its deadline could be read at two different times.
 */
const DUE_AT_ISO_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const DUE_AT_ISO_SELECT = `, to_char(t.due_at AT TIME ZONE 'UTC', ${DUE_AT_ISO_FORMAT}) AS due_at_iso`;
const DUE_AT_ISO_RETURNING = `, to_char(due_at AT TIME ZONE 'UTC', ${DUE_AT_ISO_FORMAT}) AS due_at_iso`;

/**
 * Fail closed rather than truncate.
 *
 * A read path that forgot `DUE_AT_ISO_SELECT` would still have `row.due_at` —
 * a millisecond `Date` — sitting there looking usable, and reading it would
 * silently reintroduce exactly the defect above on that one surface, visible
 * only to a caller who happened to store microseconds. That is not a failure
 * a test suite finds by looking at the paths it already knows about, so the
 * absence is made LOUD instead: a row that carries the column but not its
 * canonical text throws here, on the first Task with a deadline, rather than
 * answering 200 with a different instant.
 *
 * A database that predates migration 124 has no `due_at` at all, and that
 * reads as "no deadline", which is what it is.
 */
export function readRowDueAt(row: { due_at?: unknown; due_at_iso?: unknown }): string | null {
  if (row.due_at === undefined || row.due_at === null) return null;
  if (typeof row.due_at_iso !== 'string') {
    throw new Error(
      'Task row carries due_at without due_at_iso. The pg driver parses timestamptz '
      + 'into a millisecond Date, so reading due_at directly would echo an instant the '
      + 'caller never named. Append DUE_AT_ISO_SELECT (or DUE_AT_ISO_RETURNING) to the '
      + 'query that produced this row.',
    );
  }
  return row.due_at_iso;
}

/**
 * The field NAMES an update applied, sorted (card 5854f0d6, design section
 * 4.2): the keys the caller set to a defined value. A feed payload carries
 * these names and never a value.
 */
export function appliedFieldNames(updates: object): string[] {
  return Object.keys(updates)
    .filter((key) => (updates as Record<string, unknown>)[key] !== undefined)
    .sort();
}

export class TaskManagerDB extends EventEmitter {
  private pool: Pool;

  constructor(pool?: Pool) {
    super();
    this.pool = pool || defaultPool;
  }

  /**
   * Return dashboard lifecycle counts from the authoritative PostgreSQL board,
   * over the Tasks the CALLER may read and no others.
   *
   * Archive membership is status-based; archived_at is transition metadata and
   * can be null on legacy rows without removing them from the archived bucket.
   *
   * `authorization` is REQUIRED and unnamed by default, for the reason
   * `queryBoardColumns` states: this answers in COUNTS, and a count over rows
   * the caller may not read is a disclosure on its own. Card 72258a60 is what
   * its absence cost — the first screen a non-owner sees reported IDEAS 1 and
   * TODO 2 for an estate whose every row `GET /tasks` correctly refused. There
   * is no post-read narrowing that could have repaired that: the numbers ARE
   * the payload. A caller that forgets the scope fails to compile.
   */
  async getDashboardSummary(authorization: AuthorizationListScope<'task'>): Promise<DashboardTaskSummary> {
    // The predicate is rendered ONCE and bound once: one statement, one set of
    // placeholders. Every column reference below is qualified with `t.`,
    // because the scope's FROM joins `phases` and `projects` and both carry a
    // `status` of their own — an unqualified `status` there is not a leak, it
    // is an ambiguous-column error, and the tests would have found it. The
    // qualification is stated anyway so a reader knows which `status` is meant.
    const predicate = authorization.render(1);
    const result = await this.pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE t.status = 'ideas')::int AS ideas,
        COUNT(*) FILTER (WHERE t.status = 'todo')::int AS todo,
        COUNT(*) FILTER (WHERE t.status = 'in-progress')::int AS in_progress,
        COUNT(*) FILTER (WHERE t.status = 'review')::int AS review,
        COUNT(*) FILTER (WHERE t.status = 'stuck')::int AS stuck,
        COUNT(*) FILTER (WHERE t.status = 'completed')::int AS completed,
        COUNT(*) FILTER (WHERE t.status = 'archived')::int AS archived,
        COUNT(*) FILTER (
          WHERE t.status IN ('completed', 'archived')
            AND t.completed_at >= NOW() - INTERVAL '7 days'
        )::int AS recent_completed,
        COUNT(*)::int AS total
      FROM ${authorization.from}
      WHERE ${predicate.sql}
    `, predicate.params);
    const row = result.rows[0];
    return {
      ideas: row.ideas,
      todo: row.todo,
      inProgress: row.in_progress,
      review: row.review,
      stuck: row.stuck,
      completed: row.completed,
      archived: row.archived,
      recentCompleted: row.recent_completed,
      total: row.total,
    };
  }

  /**
   * Initialize - placeholder for compatibility
   */
  async initialize(): Promise<void> {
    // Test connection
    try {
      await this.pool.query('SELECT 1');
      console.log('[TaskManagerDB] Connected to PostgreSQL');
    } catch (err) {
      logCaughtFailure('[TaskManagerDB] Failed to connect:', err);
      throw err;
    }
  }

  /**
   * Resolve project name to UUID (for create/update)
   */
  /**
   * The target-Project decision for a MOVE (card `9c177e6a`).
   *
   * Clearing the Project (`project` falsy) decides nothing: it removes a
   * perimeter rather than crossing one, and the Task that results inherits
   * nothing. Naming one requires the caller's decision, and both of its
   * refusals - absent, and present but unreadable - arrive as the SAME
   * `ProjectTargetNotFoundFault`.
   */
  private async decideProjectTarget(
    value: unknown,
    projectTarget: AuthorizedProjectTarget | undefined,
    client: PoolClient,
  ): Promise<string | null> {
    if (!value) return null;
    if (!projectTarget) {
      throw new ForbiddenFault(
        'moving a Task to another Project requires an authorized target decision',
        'PROJECT_TARGET_REQUIRED',
      );
    }
    const resolved = await projectTarget(String(value), client);
    if (resolved === null) throw new ProjectTargetNotFoundFault();
    return resolved;
  }

  /**
   * Name-or-id resolution for READ filters ONLY. It performs NO authorization
   * and it no longer reaches any write: the two paths that wrote
   * `tasks.project_id` through it now decide their target through
   * `AuthorizedProjectTarget` instead (card `9c177e6a`). The rows a filter
   * built from this can reach are narrowed by the shared predicate downstream,
   * which is why an unauthorized name here discloses nothing.
   */
  private async resolveProjectId(nameOrId: string, client?: PoolClient): Promise<string | null> {
    const executor = client || this.pool;
    // Try as UUID first
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidPattern.test(nameOrId)) {
      return nameOrId;
    }
    // Look up by name
    const res = await executor.query('SELECT id FROM projects WHERE name = $1', [nameOrId]);
    return res.rows.length > 0 ? res.rows[0].id : null;
  }

  /**
   * Map database row to Task object
   * Joins subtasks, tags, dependencies, links into flat structure
   */
  private async hydrateTask(row: any, client?: PoolClient): Promise<Task> {
    const [task] = await this.hydrateTasks([row], client);
    return task;
  }

  /**
   * Batch form of hydrateTask — ONE query per child table for the whole row
   * set instead of four (plus a project-name lookup) per row.
   *
   * 6a351638 (R19): the per-row form multiplied by the estate is where the E4
   * board-startup time actually went. filter-options hydrated EVERY task —
   * ~20,000 queries at the 5,200-task fixture — and the resulting event-loop
   * and pool contention queued every other startup request behind it (a
   * DB-free /api/health probe degraded 6ms → 900ms during the browser's
   * startup mix). Same data, same shapes, constant query count.
   */
  private async hydrateTasks(rows: any[], client?: PoolClient): Promise<Task[]> {
    if (rows.length === 0) return [];
    const executor = client || this.pool;
    const taskIds = rows.map((row: any) => row.id);

    const [subtasksRes, tagsRes, depsRes, linksRes] = await Promise.all([
      executor.query(
        `SELECT id, task_id, index, title, status, note, completed_at, created_at, updated_at, blueprint_key, blueprint_version, blueprint_content_sha256, blueprint_identity_sha256, instantiation_id
         FROM subtasks
         WHERE task_id = ANY($1::uuid[])
         ORDER BY task_id, index ASC`,
        [taskIds]
      ),
      executor.query(
        `SELECT task_id, tag FROM task_tags WHERE task_id = ANY($1::uuid[]) ORDER BY task_id, tag`,
        [taskIds]
      ),
      executor.query(
        `SELECT task_id, depends_on_task_id FROM task_dependencies WHERE task_id = ANY($1::uuid[])`,
        [taskIds]
      ),
      executor.query(
        `SELECT id, task_id, type, title, url FROM task_links WHERE task_id = ANY($1::uuid[]) ORDER BY task_id, id`,
        [taskIds]
      ),
    ]);

    const grouped = <T>(input: Array<{ task_id: string } & T>): Map<string, T[]> => {
      const byTask = new Map<string, T[]>();
      for (const item of input) {
        const list = byTask.get(item.task_id) ?? [];
        list.push(item);
        byTask.set(item.task_id, list);
      }
      return byTask;
    };
    const subtasksByTask = grouped<any>(subtasksRes.rows);
    const tagsByTask = grouped<any>(tagsRes.rows);
    const depsByTask = grouped<any>(depsRes.rows);
    const linksByTask = grouped<any>(linksRes.rows);

    // Project names in one lookup for the whole set (resolveProjectName was a
    // fifth query per row).
    const projectIds = [...new Set(rows.map((row: any) => row.project_id).filter(Boolean))];
    const projectNameById = new Map<string, string>();
    if (projectIds.length > 0) {
      const projectsRes = await executor.query(
        'SELECT id, name FROM projects WHERE id = ANY($1::uuid[])',
        [projectIds]
      );
      for (const project of projectsRes.rows) projectNameById.set(project.id, project.name);
    }
    // Section 6.8 (E462 S4b): the derived verification mode reads the
    // Verifier's principal kind, in one lookup for the whole set.
    const verifierIds = [...new Set(rows.map((row: any) => row.verifier_principal_id).filter(Boolean).map(String))];
    const verifierKindById = new Map<string, string>();
    if (verifierIds.length > 0) {
      const kinds = await executor.query('SELECT id::text AS id, kind FROM principals WHERE id = ANY($1::uuid[])', [verifierIds]);
      for (const principal of kinds?.rows ?? []) verifierKindById.set(String(principal.id), String(principal.kind));
    }

    return rows.map((row: any) => this.mapTaskRow(row, {
      subtaskRows: subtasksByTask.get(row.id) ?? [],
      tagRows: tagsByTask.get(row.id) ?? [],
      dependencyRows: depsByTask.get(row.id) ?? [],
      linkRows: linksByTask.get(row.id) ?? [],
      projectName: row.project_id ? projectNameById.get(row.project_id) : undefined,
      verifierKind: row.verifier_principal_id ? verifierKindById.get(String(row.verifier_principal_id)) ?? null : null,
    }));
  }

  /**
   * The pure row→Task mapping both hydrate forms share. No queries in here —
   * every child row arrives pre-fetched, so the mapping cannot regrow an N+1.
   */
  private mapTaskRow(row: any, children: {
    subtaskRows: any[]; tagRows: any[]; dependencyRows: any[]; linkRows: any[];
    projectName: string | undefined;
    verifierKind?: string | null;
  }): Task {
    const taskId = row.id;

    const subtasks: Subtask[] = children.subtaskRows.map((s: any) => ({
      ...blueprintProvenanceOf(s),
      id: s.id.toString(),
      text: s.title,
      status: s.status as SubtaskStatus,
      reviewNote: s.note || undefined,
      blockedReason: s.blocked_reason || undefined,
      completedAt: s.completed_at || undefined,
      // Legacy field for backward compat
      completed: s.status === 'completed' || s.status === 'skipped',
    }));

    const tags = children.tagRows.map((t: any) => t.tag);
    const dependsOn = children.dependencyRows.map((d: any) => d.depends_on_task_id);
    const links: TaskLink[] = children.linkRows.map((l: any) => ({
      type: l.type as TaskLinkType,
      url: l.url,
      title: l.title,
    }));

    // Parse JSON fields
    // RH-P2.2: stored profiles split by shape — the connector-first shape
    // hydrates as executionProfile; retired legacy blobs are held and
    // surface separately (never rewritten, never dropped).
    const rawProfile = row.execution_profile || undefined;
    const rawIsLegacy = rawProfile ? isLegacyExecutionProfile(rawProfile) : false;
    const executionProfile = rawIsLegacy ? undefined : rawProfile;
    const legacyExecutionProfile = rawIsLegacy ? rawProfile : undefined;
    let successCriteria = row.success_criteria ?? undefined;
    if (typeof successCriteria === 'string') {
      try {
        const decoded = JSON.parse(successCriteria);
        if (Array.isArray(decoded) && decoded.every(item => typeof item === 'string')) successCriteria = decoded;
      } catch { /* Legacy plain text is already a valid criterion. */ }
    }
    const reviewHistory = row.review_history ?? undefined;
    const maxRetries = row.max_retries ?? undefined;
    const definitionOfDone = row.definition_of_done ?? undefined;
    const constraints = row.constraints ?? undefined;
    const taskResources = row.task_resources || undefined;

    // Map to Task interface
    const task: Task = {
      ...blueprintProvenanceOf(row),
      id: taskId,
      title: row.title,
      description: row.description || '',
      status: row.status,
      priority: row.priority,
      subtasks,
      links,
      autoStart: row.auto_start,
      startedAt: row.started_at || undefined,
      completedAt: row.completed_at || undefined,
      archivedAt: row.archived_at || undefined,
      archiveDisposition: row.archive_disposition ?? null,
      blockedBy: [], // Computed from dependencies
      blockedReason: row.blocked_reason || undefined,
      dependsOn,
      project: children.projectName || undefined,
      tags,
      created: row.created_at,
      updated: row.updated_at,
      model: row.model || undefined,
      executionMode: row.execution_mode || legacyExecutionProfile?.mode || undefined,
      executionProfile,
      executionServiceId: row.execution_service_id || undefined,
      executionDescriptorVersion: row.execution_descriptor_version || undefined,
      legacyExecutionProfile,
      ownerPrincipalId: row.owner_principal_id ?? null,
      creatorPrincipalId: row.creator_principal_id ?? null,
      shepherdPrincipalId: row.shepherd_principal_id ?? null,
      verifierPrincipalId: row.verifier_principal_id ?? null,
      verifierSource: row.verifier_source ?? null,
      // Section 6.8 (E462 S4b): `none` is stored; `human`/`service` derive from the Verifier's kind.
      verificationNone: row.verification_none === true,
      verificationMode: verificationModeOf({ verificationNone: row.verification_none === true,
        verifierPrincipalId: row.verifier_principal_id ?? null, verifierKind: children.verifierKind ?? null }),
      verificationNoneSetByPrincipalId: row.verification_none_set_by ?? null,
      verificationNoneBasis: row.verification_none_basis ?? null,
      verificationNoneSetAt: row.verification_none_set_at ?? null,
      verificationNoneClearedAt: row.verification_none_cleared_at ?? null,
      needsReview: row.needs_review || false,
      successCriteria,
      reviewHistory,
      maxRetries,
      definitionOfDone,
      constraints,
      discordThreadId: resolveTaskDiscordThreadId({
        discordThreadId: row.discord_thread_id,
        }),
      discordThreadUrl: buildDiscordThreadUrl(resolveTaskDiscordThreadId({
        discordThreadId: row.discord_thread_id,
        })),
      thinking: row.thinking_budget || undefined,
      thinkingAutoEstimated: row.thinking_auto_estimated || false,
      attemptCount: row.attempt_count || 0,
      trackerUrl: row.tracker_url || undefined,
      phaseTag: row.phase_tag || undefined,
      taskResources,
      parentId: row.parent_id || null,
      phaseId: row.phase_id ?? null,
      notes: row.notes || undefined,
      // Card 7d38a6e0. A Task with no deadline says so, and on a database
      // that predates migration 124 the column is simply absent from the row,
      // which reads the same way. Round-2 review: the instant comes from the
      // database's own formatting of the column, never from the millisecond
      // `Date` the driver parses beside it — see readRowDueAt above.
      dueAt: readRowDueAt(row),
      // Legacy field: completed timestamp
      completed: row.status === 'completed' ? row.completed_at : null,
      personalityId: row.personality_id || null,
      personality: row.personality_id ? {
        id: row.personality_id,
        slug: row.at_slug || null,
        name: row.at_name || null,
        color: row.at_color || null,
        category: row.at_category || null,
      } : null,
    };

    return task;
  }

  /**
   * Add lightweight dependency metadata used by task board cards.
   * hydrateTask() deliberately only returns dependency IDs; without this pass the
   * board UI cannot distinguish ready todo tasks from dependency-locked tasks.
   */
  private async addDependencyMeta(tasks: Task[]): Promise<Task[]> {
    if (tasks.length === 0) return tasks;

    const taskIds = tasks.map(task => task.id);
    const byId = new Map(tasks.map(task => [task.id, task]));

    const blockingRes = await this.pool.query(
      `SELECT d.task_id,
              dep.id,
              dep.title,
              dep.status,
              dep.archive_disposition
       FROM task_dependencies d
       JOIN tasks dep ON dep.id = d.depends_on_task_id
       WHERE d.task_id = ANY($1::uuid[])
       ORDER BY dep.created_at ASC`,
      [taskIds]
    );

    const dependentRes = await this.pool.query(
      `SELECT d.depends_on_task_id AS task_id,
              child.id,
              child.title,
              child.status
       FROM task_dependencies d
       JOIN tasks child ON child.id = d.task_id
       WHERE d.depends_on_task_id = ANY($1::uuid[])
       ORDER BY child.created_at ASC`,
      [taskIds]
    );

    for (const task of tasks) {
      task.blockingTasks = [];
      task.dependentTasks = [];
      task.blocked = false;
    }

    for (const row of blockingRes.rows) {
      const task = byId.get(row.task_id);
      if (!task) continue;
      if (dependencyBlocks(row.status, row.archive_disposition)) {
        task.blockingTasks!.push({ id: row.id, title: row.title });
        task.blocked = true;
      }
    }

    for (const row of dependentRes.rows) {
      const task = byId.get(row.task_id);
      if (!task) continue;
      task.dependentTasks!.push({ id: row.id, title: row.title });
    }

    return tasks;
  }

  /**
   * Query tasks with filters
   */
  private async buildTaskWhere(filters: TaskFilters = {}): Promise<{ conditions: string[]; params: any[]; orderClause: string; filterParamCount: number }> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;
    // Total order (candidate A3, review e0f52de7): created_at alone has no
    // tie-break, so equal timestamps left page composition unspecified —
    // OFFSET windows need a total order to be stable at all. id DESC is the
    // same tiebreak the reports list uses.
    let orderClause = 'ORDER BY t.created_at DESC, t.id DESC';

    if (filters.statuses && filters.statuses.length > 0) {
      conditions.push(`t.status = ANY($${paramIndex++})`);
      params.push(filters.statuses);
    } else if (filters.status) {
      conditions.push(`t.status = $${paramIndex++}`);
      params.push(filters.status);
    } else if (!filters.includeArchived) {
      conditions.push(`t.status <> 'archived'`);
    }

    if (filters.projects && filters.projects.length > 0) {
      const resolvedProjectIds = (await Promise.all(filters.projects.map(p => this.resolveProjectId(p)))).filter(Boolean);
      if (resolvedProjectIds.length > 0) {
        conditions.push(`t.project_id = ANY($${paramIndex++})`);
        params.push(resolvedProjectIds);
      } else {
        conditions.push('FALSE');
      }
    } else if (filters.project) {
      const projId = await this.resolveProjectId(filters.project);
      if (projId) {
        conditions.push(`t.project_id = $${paramIndex++}`);
        params.push(projId);
      } else {
        conditions.push('FALSE');
      }
    }

    if (filters.priorities && filters.priorities.length > 0) {
      conditions.push(`t.priority = ANY($${paramIndex++})`);
      params.push(filters.priorities);
    } else if (filters.priority) {
      conditions.push(`t.priority = $${paramIndex++}`);
      params.push(filters.priority);
    }

    if (filters.tags && filters.tags.length > 0) {
      conditions.push(`t.id IN (SELECT task_id FROM task_tags WHERE tag = ANY($${paramIndex++}))`);
      params.push(filters.tags);
    } else if (filters.tag) {
      conditions.push(`t.id IN (SELECT task_id FROM task_tags WHERE tag = $${paramIndex++})`);
      params.push(filters.tag);
    }

    if (filters.parentId !== undefined) {
      if (filters.parentId === null) {
        conditions.push(`t.parent_id IS NULL`);
      } else {
        conditions.push(`t.parent_id = $${paramIndex++}`);
        params.push(filters.parentId);
      }
    }

    // Phase membership (RH-P2.4). `null` in the list is the unphased backlog,
    // a first-class view rather than the absence of a filter — so selecting
    // "Backlog" alongside two phases is one OR, not three queries.
    if (filters.phaseIds && filters.phaseIds.length > 0) {
      const ids = filters.phaseIds.filter((value): value is string => value !== null);
      const wantsUnphased = filters.phaseIds.some((value) => value === null);
      const alternatives: string[] = [];
      if (ids.length > 0) {
        alternatives.push(`t.phase_id = ANY($${paramIndex++})`);
        params.push(ids);
      }
      if (wantsUnphased) {
        alternatives.push(`t.phase_id IS NULL`);
      }
      conditions.push(`(${alternatives.join(' OR ')})`);
    }

    // Assignee filters (Phase 1, spec b48bb799 §3.3). These predicates read
    // migration-063 columns, so on a pre-migration DB a request that uses
    // them gets a typed failure the route maps to 503 — never a 500.
    if (filters.ownerHandle || filters.ownerPrincipalId || filters.unassigned) {
      if (!(await this.ownerPrincipalColumnExists())) {
        const err = new Error('Task Assignee columns are not migrated yet');
        (err as Error & { code: string }).code = 'OWNER_FILTER_UNAVAILABLE';
        throw err;
      }
      if (filters.unassigned) {
        conditions.push('t.owner_principal_id IS NULL');
      }
      if (filters.ownerPrincipalId) {
        conditions.push(`t.owner_principal_id = $${paramIndex++}`);
        params.push(filters.ownerPrincipalId);
      } else if (filters.ownerHandle) {
        conditions.push(`t.owner_principal_id IN (SELECT id FROM principals WHERE handle = $${paramIndex++})`);
        params.push(filters.ownerHandle);
      }
    }

    // Card 41e24358: "without a usable Verifier". Arms 1-3 come from the ONE
    // predicate (usableVerifierPrincipalIds evaluates principalVerifierUsability
    // for every principal named as a Verifier); arm 4 is the comparison with the
    // Assignee. The point check (verifierUsabilityOf) reads the same arms, and
    // the live suite pins point/list parity.
    if (filters.verifierUnusable) {
      const usable = await usableVerifierPrincipalIds(this.pool);
      conditions.push(verifierUnusableSql('t', `$${paramIndex++}`));
      params.push(usable);
    }

    let filterParamCount = params.length;

    const searchQuery = filters.q?.trim();
    if (searchQuery) {
      const normalizedSearch = searchQuery.replace(/-/g, '').toLowerCase();
      conditions.push(`(
        t.title ILIKE $${paramIndex}
        OR t.description ILIKE $${paramIndex}
        OR t.id::text ILIKE $${paramIndex}
        OR REPLACE(LOWER(t.id::text), '-', '') LIKE $${paramIndex + 1}
        OR p.name ILIKE $${paramIndex}
      )`);
      params.push(`%${searchQuery}%`, `%${normalizedSearch}%`);
      paramIndex += 2;

      const exactIdParam = `$${paramIndex++}`;
      const exactCompactIdParam = `$${paramIndex++}`;
      const exactShortIdParam = `$${paramIndex++}`;
      const exactTitleParam = `$${paramIndex++}`;
      const titlePrefixParam = `$${paramIndex++}`;
      const titleContainsParam = `$${paramIndex++}`;
      const projectPrefixParam = `$${paramIndex++}`;
      params.push(
        searchQuery.toLowerCase(),
        normalizedSearch,
        normalizedSearch.slice(0, 8),
        searchQuery.toLowerCase(),
        `${searchQuery.toLowerCase()}%`,
        `%${searchQuery.toLowerCase()}%`,
        `${searchQuery.toLowerCase()}%`
      );

      orderClause = `ORDER BY
        CASE
          WHEN LOWER(t.id::text) = ${exactIdParam} OR REPLACE(LOWER(t.id::text), '-', '') = ${exactCompactIdParam} THEN 0
          WHEN LEFT(REPLACE(LOWER(t.id::text), '-', ''), 8) = ${exactShortIdParam} THEN 1
          WHEN LOWER(t.title) = ${exactTitleParam} THEN 2
          WHEN LOWER(t.title) LIKE ${titlePrefixParam} THEN 3
          WHEN LOWER(t.title) LIKE ${titleContainsParam} THEN 4
          WHEN LOWER(COALESCE(p.name, '')) LIKE ${projectPrefixParam} THEN 5
          ELSE 6
        END,
        t.updated_at DESC,
        t.created_at DESC,
        t.id DESC`;
    }

    filterParamCount = searchQuery ? params.length - 7 : params.length;

    if (filters.excludeTaskId) {
      conditions.push(`t.id <> $${paramIndex++}`);
      params.push(filters.excludeTaskId);
    }

    if (filters.excludeTaskId) {
      filterParamCount = params.length;
    }

    return { conditions, params, orderClause, filterParamCount };
  }

  private taskColumnCache = new Map<string, boolean>();

  /** Pre-migration tolerance: 063 adds identity columns to tasks; until they
   *  exist, features that read/write them degrade (503/skip), never 500.
   *  Only positives are cached — a migration can apply while we run. */
  private async taskColumnExists(columnName: string): Promise<boolean> {
    if (this.taskColumnCache.get(columnName)) return true;
    try {
      // to_regclass resolves the table exactly as the unqualified DML around
      // it does — following the whole search_path. current_schema() only names
      // the FIRST existing schema, so a role-named schema would report the
      // column missing while writes still land in public.
      const result = await this.pool.query(
        `SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('tasks') AND attname = $1
            AND attnum > 0 AND NOT attisdropped`,
        [columnName]
      );
      const exists = result.rows.length > 0;
      if (exists) this.taskColumnCache.set(columnName, true);
      return exists;
    } catch {
      return false;
    }
  }

  private ownerPrincipalColumnExists(): Promise<boolean> {
    return this.taskColumnExists('owner_principal_id');
  }

  /**
   * Claim a task for a principal (Phase 1, spec b48bb799 §3.3) — the caller
   * becomes its Assignee. The current Assignee claiming again is accepted and
   * answers 'already_assignee'; a different Assignee → 'conflict'.
   *
   * Card 3fc32dd1: every claim the board decides is on the ledger as one
   * `task.claim` row — `success` when it made an Assignee (written with the
   * claim, below), `denied` with the projected reason when it refused. An
   * accepted retry assigns nothing and records nothing.
   */
  async claimTask(taskId: string, principalId: string, actor?: TaskActor, expectedAssignmentEpoch?: string): Promise<ClaimOutcome> {
    const outcome = await this.decideClaim(taskId, principalId, actor, expectedAssignmentEpoch);
    const reason = CLAIM_REFUSAL_REASONS[outcome];
    if (reason) {
      // The refusal is answered either way: a ledger that is down must not turn
      // it into a 500, and it must not be silent (the surface.refused rule).
      // The reason only — never the identity that holds the Task.
      await auditService.record({
        action: 'task.claim', actor: taskAuditActor(actor), outcome: 'denied',
        resourceType: 'task', resourceId: taskId, metadata: { reason },
      }, this.pool).catch((error) => logCaughtFailure('[TaskManagerDB] claim refusal audit not written:', error));
    }
    return outcome;
  }

  private async decideClaim(taskId: string, principalId: string, actor?: TaskActor, expectedAssignmentEpoch?: string): Promise<ClaimOutcome> {
    if (!(await this.ownerPrincipalColumnExists())) return 'unavailable';
    try {
      const hasVerifier = await this.taskColumnExists('verifier_principal_id');
      const verifierGuard = hasVerifier ? 'AND (verifier_principal_id IS NULL OR verifier_principal_id <> $2)' : '';
      // RH-P3.C1 (round 1, F2): a successful claim is a Task write every
      // consumer can observe; the claim and its feed event commit together.
      const client = await this.pool.connect();
      let claimedRow: { project_id?: string | null } | undefined;
      let previousOwner: string | null = null;
      try {
        await client.query('BEGIN');
        const exists = (await client.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [taskId])).rows[0];
        // Derived service/descriptor/epoch facts use a NEW statement snapshot
        // after the lock wait, not the locking SELECT's pre-wait snapshot.
        const locked = exists && (await client.query(`SELECT t.*, e.epoch::text AS assignment_epoch,
          ${assignedClaimBindingSql('t')} AS assigned_binding,
          ${assignedClaimEligibleSql('t')} AS assigned_eligible,
          ${assignedClaimPrincipalSql('t')} AS assigned_principal
          FROM tasks t LEFT JOIN task_native_assignment_epochs e ON e.task_id=t.id
          WHERE t.id=$1`, [taskId])).rows[0];
        const refuse = async (outcome: 'not_found' | 'authority_changed' | 'epoch_mismatch') => {
          await client.query('ROLLBACK'); return outcome;
        };
        if (!locked) return await refuse('not_found');
        previousOwner = locked.owner_principal_id ?? null;
        if (actor) {
          if (actor.principalId !== principalId) return await refuse('authority_changed');
          const snapshots = await taskAuthoritySnapshot(client, actor, taskId);
          if (!snapshots) return await refuse('authority_changed');
          if (expectedAssignmentEpoch !== undefined) {
            const resource = {type: 'task' as const, id: taskId, projectId: locked.project_id};
            if (!actor.credentialId || !locked.assigned_binding || locked.assigned_principal !== principalId
              || snapshots.some(a => !assignedClaimCaps(a, resource))) return await refuse('authority_changed');
            const epoch = BigInt(locked.assignment_epoch ?? '0');
            const expected = BigInt(expectedAssignmentEpoch);
            const retry = locked.owner_principal_id === principalId;
            if (!locked.auto_start) return await refuse('authority_changed');
            if (epoch !== expected && !(retry && epoch === expected + 1n)) return await refuse('epoch_mismatch');
            if (!retry && !locked.assigned_eligible) return await refuse('authority_changed');
          } else {
            // No request epoch: the original positive-WRITE/Task-role contract
            // remains; the new assignment exception never supplies WRITE.
            for (const snapshot of snapshots) {
              if (!(await authorizationRepository.authorizedIds(snapshot, 'task', [taskId], 'write', client)).has(taskId))
                return await refuse('authority_changed');
            }
          }
        } else if (expectedAssignmentEpoch !== undefined) return await refuse('authority_changed');
        // A genuine retry changes no epoch, feed, readiness or generation.
        if (expectedAssignmentEpoch !== undefined && locked.owner_principal_id === principalId) {
          await client.query('COMMIT'); return 'already_assignee';
        }
        const updated = await client.query(
          `UPDATE tasks SET owner_principal_id = $2, updated_at = NOW()
          WHERE id = $1 AND (owner_principal_id IS NULL OR owner_principal_id = $2)
          AND auto_start = TRUE
          AND NOT EXISTS (
            SELECT 1
              FROM task_dependencies dependency
              JOIN tasks prerequisite ON prerequisite.id = dependency.depends_on_task_id
             WHERE dependency.task_id = tasks.id
               AND NOT COALESCE((
                 prerequisite.status = 'completed'
                 OR (prerequisite.status = 'archived' AND prerequisite.archive_disposition = 'completed')
               ), FALSE)
          )
          ${verifierGuard}
          RETURNING id, project_id`,
          [taskId, principalId]
        );
        claimedRow = updated.rows[0];
        if (claimedRow) {
          // Protocol v2 intent burns BEFORE claim; this witness is written only
          // by the supported claim transaction, never inferred from owner alone.
          if (process.env.RELAYHALL_DEPLOYMENT_ID) {
            await client.query(`UPDATE task_native_generations g SET claim_epoch=e.epoch,claimed_at=clock_timestamp()
              FROM task_native_assignment_epochs e WHERE g.task_id=$1 AND e.task_id=g.task_id
              AND g.deployment_id=$3::uuid AND g.actor_principal_id=$2 AND g.state='reserved' AND g.claimed_at IS NULL
              AND g.expires_at>clock_timestamp() AND e.epoch=g.reserved_epoch+CASE WHEN g.reserved_owner IS NULL THEN 1 ELSE 0 END`,
              [taskId,principalId,process.env.RELAYHALL_DEPLOYMENT_ID]);
          }
          await feedEventService.emit(client, {
            name: 'task.updated', objectType: 'task', objectId: taskId,
            // RH-P3.C2 (pre-review F1): record WHO wrote. C2 suppresses
            // delivering an event back to the principal that caused it, and an
            // unattributed emission cannot be suppressed.
            actorPrincipalId: principalId,
            projectId: claimedRow.project_id ?? null,
            // Card 5854f0d6: the field NAME the claim wrote, never its value.
            ownerPrincipalId: principalId, payload: { fields: ['ownerPrincipalId'] },
          });
          // RH-P3.C2: a claimed task has left the ready state; retract the
          // announcement so a later release announces it again.
          await syncTaskReadiness(client, taskId, { principalId });
          // Card 3fc32dd1: a claim that made an Assignee is a durable act the
          // owner can find — one audit row, and the `task.claimed` system
          // entry the Task timeline already labels "Task claimed" — committed
          // with the claim or not at all. The current Assignee's accepted
          // legacy retry still emits its task.updated and records neither.
          if (previousOwner !== principalId) {
            await auditService.record({
              action: 'task.claim', actor: taskAuditActor(actor), resourceType: 'task', resourceId: taskId,
              metadata: { assigneePrincipalId: principalId, epochBound: expectedAssignmentEpoch !== undefined },
            }, client);
            await client.query(
              `INSERT INTO task_stream_entries (task_id, provenance, event_type, content, metadata)
               VALUES ($1, 'system', 'task.claimed', 'unassigned -> claimed', $2)`,
              [taskId, { assigneePrincipalId: principalId }],
            );
          }
        }
        await client.query('COMMIT');
      } catch (txnError) {
        await client.query('ROLLBACK');
        throw txnError;
      } finally {
        client.release();
      }
      if (claimedRow) return previousOwner === principalId ? 'already_assignee' : 'claimed';
      const existing = await this.pool.query(
        `SELECT owner_principal_id, auto_start${hasVerifier ? ', verifier_principal_id' : ''},
                EXISTS (
                  SELECT 1 FROM task_dependencies dependency
                  JOIN tasks prerequisite ON prerequisite.id = dependency.depends_on_task_id
                  WHERE dependency.task_id = tasks.id
                    AND NOT COALESCE((
                      prerequisite.status = 'completed'
                      OR (prerequisite.status = 'archived' AND prerequisite.archive_disposition = 'completed')
                    ), FALSE)
                ) AS dependency_blocked
           FROM tasks WHERE id = $1`,
        [taskId]
      );
      if (hasVerifier && existing.rows[0]?.verifier_principal_id === principalId) return 'self_review';
      // A parked dependent is blocked until its prerequisite completes; only
      // then is its independent arming requirement actionable (C9 D-7(d)).
      if (existing.rows[0]?.dependency_blocked === true) return 'dependency_blocked';
      if (existing.rows.length > 0 && existing.rows[0].auto_start !== true) return 'unarmed';
      return existing.rows.length > 0 ? 'conflict' : 'not_found';
    } catch (err) {
      logCaughtFailure('[TaskManagerDB] claimTask failed:', err);
      return 'unavailable';
    }
  }

  /**
   * Clear a task's Assignee. Only the current Assignee releases; `force`
   * (orchestrator authority, decided by the route) releases regardless.
   */
  async releaseTask(
    taskId: string,
    principalId: string,
    force: boolean,
    actor: AuditActor = { principalId, handle: principalId, authMethod: 'unknown' },
  ): Promise<'released' | 'conflict' | 'not_found' | 'unavailable'> {
    if (!(await this.ownerPrincipalColumnExists())) return 'unavailable';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // THE TRANSITION IS THE GUARD (retry contract, `relayhall_task_release`).
      // The owner-guarded arm already cannot match an unowned Task, so an
      // ordinary retry writes nothing and answers `released` from the read
      // below. The FORCE arm matched on the id alone, so a retried force
      // release re-wrote `updated_at` and emitted a SECOND `task.updated`
      // feed event for a Task it moved from NULL to NULL - a replay with a
      // side effect, and the row the convergence oracle counted. `IS NOT
      // NULL` makes the UPDATE, and therefore every write below it, the
      // transition itself: no transition, no rows, no event.
      const ownerGuard = force ? 'AND owner_principal_id IS NOT NULL' : 'AND owner_principal_id = $2';
      const params: unknown[] = force ? [taskId] : [taskId, principalId];
      const updated = await client.query(
        `WITH target AS (
           SELECT owner_principal_id FROM tasks WHERE id = $1 FOR UPDATE
         )
         UPDATE tasks SET owner_principal_id = NULL, updated_at = NOW()
          WHERE id = $1 ${ownerGuard}
          RETURNING id, project_id, (SELECT owner_principal_id FROM target) AS previous_owner_principal_id`,
        params
      );
      if (updated.rows.length > 0) {
        const previous = updated.rows[0].previous_owner_principal_id as string | null;
        if (force && previous !== null && previous !== principalId) {
          await auditService.record({
            action: 'task.lifecycle_override.force_release', actor,
            resourceType: 'task', resourceId: taskId,
            metadata: { previousAssigneePrincipalId: previous },
          }, client);
        }
        await feedEventService.emit(client, {
          name: 'task.updated', objectType: 'task', objectId: taskId,
          // RH-P3.C2 (pre-review F1): attribute the write (see claimTask).
          actorPrincipalId: principalId ?? null,
          projectId: updated.rows[0].project_id ?? null,
          // Card 5854f0d6: the field NAME the release wrote, never its value.
          ownerPrincipalId: null, payload: { fields: ['ownerPrincipalId'] },
        });
        // RH-P3.C2: a released task may be ready again.
        await syncTaskReadiness(client, taskId, null);
        await client.query('COMMIT');
        return 'released';
      }
      const existing = await client.query('SELECT owner_principal_id FROM tasks WHERE id = $1', [taskId]);
      await client.query('ROLLBACK');
      if (existing.rows.length === 0) return 'not_found';
      // Already Assignee-less: report success without writing. `owner_principal_id = $2` cannot
      // match NULL, so a retried release (first response lost) would otherwise
      // answer 409 "another principal is the Assignee" about a task nobody holds —
      // while widening the UPDATE to cover NULL would let any caller bump
      // updated_at on a task they never held.
      if (existing.rows[0].owner_principal_id === null) return 'released';
      return 'conflict';
    } catch (err) {
      await client.query('ROLLBACK');
      logCaughtFailure('[TaskManagerDB] releaseTask failed:', err);
      return 'unavailable';
    } finally {
      client.release();
    }
  }

  /**
   * RH-P3.C3 — ONE-CLICK MELTDOWN RECOVERY (strategy 4e40f06f §2.6.4,
   * RATIFIED 2026-08-02 — C4; vocabulary b94dd86e §5.3; drilled in the
   * P3.EXIT acceptance battery).
   *
   * ONE operation, ONE transaction, in this order:
   *
   *   1. resolve the LAST GOOD REPORT — the newest live Report linked to the
   *      Task through the ratified two-arm linkage (`reports.task_ids`
   *      containment OR a `task_references` row of kind `report`), the same
   *      two arms the `task.stuck` derivation already uses for report
   *      activity, so "linked" means one thing on this board;
   *   2. FORCE-RELEASE the claimant, audited exactly as the standing
   *      force-release path audits it;
   *   3. release every ACTIVE lease, so the restart is not refused by
   *      ACTIVE_LEASE_CONFLICT against a claimant that is already gone;
   *   4. REASSIGN through the shared AZ-S7 vehicle swap, so the outgoing
   *      assignee loses access in the same commit the incoming one gains it;
   *   5. put the Task back in `todo` and re-announce readiness, because
   *      "kill-and-restart-from-external-state IS the recovery" — a Task
   *      left in-progress with nobody on it announces nothing and rescues
   *      nobody;
   *   6. record the seed on the Task stream and in the audit ledger.
   *
   * Everything is one transaction because a half-recovery is worse than no
   * recovery: a force-released, un-reassigned Task is exactly the abandoned
   * state the shepherd was called to fix.
   *
   * ARMING IS NOT TOUCHED. A parked Task recovers into `todo` still parked
   * and stays unclaimable until someone arms it — arming gates the
   * transition, not just the announcement (§2.6.4), and a recovery that
   * silently armed work would re-open the premature-pickup incidents arming
   * exists to close.
   */
  async recoverTask(
    taskId: string,
    input: MeltdownRecoveryInput,
    actor?: TaskActor,
  ): Promise<MeltdownRecoveryResult> {
    if (!(await this.ownerPrincipalColumnExists())) return { outcome: 'unavailable' };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT id, status, project_id, owner_principal_id, auto_start,
                execution_service_id, execution_warrant_id, execution_profile, execution_descriptor_version
           FROM tasks
          WHERE id = $1
          FOR UPDATE`,
        [taskId],
      );
      if (!current.rows.length) {
        await client.query('ROLLBACK');
        return { outcome: 'not_found' };
      }
      const task = current.rows[0];
      const previousStatus = String(task.status);

      // A terminal Task has already had its vehicle reaped (AZ-S7 R2(b)) and
      // has no meltdown to recover from. Re-attaching access to finished
      // work through a recovery verb would be a quiet way to resurrect it.
      if (previousStatus === 'completed' || previousStatus === 'archived') {
        await client.query('ROLLBACK');
        return { outcome: 'task_terminal', previousStatus };
      }

      const previousClaimant = task.owner_principal_id ? String(task.owner_principal_id) : null;
      const previousAssignee = task.execution_service_id ? String(task.execution_service_id) : null;
      const previousWarrant = task.execution_warrant_id ? String(task.execution_warrant_id) : null;
      const nextAssignee = String(input.executionServiceId);
      // B-1 (verdict f2de4eaf, design bf8928ee v5 §10): the Warrant pointer is a
      // UUID column (099_assignment_access_vehicles.sql:92), so the value read
      // back from tasks.execution_warrant_id is canonical lower-case database
      // text, while the route accepts the caller's spelling
      // unchanged — routes/tasks.ts:78's WARRANT_UUID carries /i and :260-265
      // validates without normalising. An exact retry that sent an UPPER-CASE
      // UUID therefore falsified the fifth conjunct of the replay signature
      // below, missed the replay branch and recovered a SECOND time — a hole in
      // the convergence claim itself. The identity is taken from the
      // authoritative Warrant row so the comparison is between two canonical
      // values; a Warrant this database does not hold cannot be attached at all
      // (AccessVehicleService.attachWarrant refuses it), and lower-casing is the
      // canonical form of the UUID text the route has already validated.
      const nextWarrant = input.executionWarrantId
        ? await canonicalWarrantId(client, String(input.executionWarrantId))
        : null;

      // The last good report, resolved BEFORE anything is written so the
      // seed describes the state the melted-down claimant left behind.
      const seed = await client.query(
        `SELECT r.id
           FROM reports r
          WHERE r.deleted_at IS NULL
            AND (
              EXISTS (SELECT 1 FROM unnest(r.task_ids) AS linked(task_id)
                       WHERE linked.task_id::uuid = $1)
              OR EXISTS (SELECT 1 FROM task_references tr
                          WHERE tr.task_id = $1 AND tr.kind = 'report'
                            AND tr.target_id = r.id)
            )
          ORDER BY GREATEST(r.created_at, COALESCE(r.updated_at, r.created_at)) DESC, r.id DESC
          LIMIT 1`,
        [taskId],
      );
      const seedReportId: string | null = seed.rows.length ? String(seed.rows[0].id) : null;

      const activeLeases = await client.query(
        `SELECT id FROM task_execution_leases
          WHERE task_id = $1 AND status = 'active'
          ORDER BY acquired_at, id
          FOR UPDATE`,
        [taskId],
      );

      // REPLAY. A recovery that has already landed leaves an exact
      // signature: back in todo, nobody holding it, no live lease, and the
      // assignment already pointing where this call would point it. Writing
      // again would detach and re-attach a vehicle that is already correct
      // and emit a second announcement for one shepherd click, so a retried
      // request whose first response was lost writes NOTHING and answers
      // outcome 'replayed'. It does NOT answer with the same receipt: the
      // replay return below reports previousClaimantPrincipalId null,
      // releasedLeaseIds empty and previousStatus 'todo' because this call
      // released nothing, while a genuine recovery reports what it released.
      // (The old wording here promised a sameness neither return shape
      // delivers — round-4 build obligation, ANNEX A dd3aaa9e §7A. Read the
      // Task for the state the first call left.) Anything short of the full
      // signature is a genuine recovery and runs.
      const alreadyRecovered = previousStatus === 'todo'
        && previousClaimant === null
        && activeLeases.rows.length === 0
        && previousAssignee === nextAssignee
        && previousWarrant === nextWarrant
        && task.execution_descriptor_version === (input.executionDescriptorVersion ?? null)
        && isDeepStrictEqual(task.execution_profile ?? null, input.executionProfile ?? null);
      // AZ-A10 clause 6: a retry that names a date is the same act only if
      // the links ALREADY carry that date. Otherwise an exact retry with a
      // different date would answer 'replayed' and drop the date silently.
      const replayed = alreadyRecovered
        && (input.roleGrantExpiry === undefined
          || await this.assignmentCarriesExpiry(client, taskId, input.roleGrantExpiry));
      if (replayed) {
        await client.query('ROLLBACK');
        return {
          outcome: 'replayed',
          seedReportId,
          previousClaimantPrincipalId: null,
          previousAssigneeServiceId: previousAssignee,
          assigneeServiceId: nextAssignee,
          releasedLeaseIds: [],
          previousStatus,
          status: previousStatus,
        };
      }

      // 2. force-release, audited on the same action the standing path uses.
      if (previousClaimant !== null) {
        await auditService.record({
          action: 'task.lifecycle_override.force_release',
          actor: taskAuditActor(actor),
          resourceType: 'task',
          resourceId: taskId,
          metadata: { previousAssigneePrincipalId: previousClaimant, viaMeltdownRecovery: true },
        }, client);
      }

      // 3. the runtime lease the melted-down claimant still holds.
      const releasedLeaseIds: string[] = [];
      if (activeLeases.rows.length > 0) {
        const released = await client.query(
          `UPDATE task_execution_leases
              SET status = 'released', released_at = COALESCE(released_at, NOW())
            WHERE task_id = $1 AND status = 'active'
            RETURNING id`,
          [taskId],
        );
        for (const row of released.rows) releasedLeaseIds.push(String(row.id));
      }

      // 5. the task row: released, reassigned, back in the queue.
      await client.query(
        `UPDATE tasks
            SET status = 'todo',
                owner_principal_id = NULL,
                execution_service_id = $2,
                execution_profile = $3::jsonb,
                execution_descriptor_version = $4,
                updated_at = NOW()
          WHERE id = $1`,
        [
          taskId,
          nextAssignee,
          input.executionProfile === null || input.executionProfile === undefined
            ? null
            : JSON.stringify(input.executionProfile),
          input.executionDescriptorVersion,
        ],
      );

      // 4. the vehicle, through the ONE implementation updateTask uses. Runs
      // after the task row so the incoming assignee's access is materialized
      // against the assignment it is actually for. A recovery that restarts
      // the SAME Connector on the SAME warrant leaves the vehicle alone:
      // detaching and re-attaching an unchanged vehicle would churn grants
      // and audit rows for a no-op.
      if (previousAssignee !== nextAssignee || previousWarrant !== nextWarrant) {
        await this.swapExecutionVehicle(client, {
          taskId,
          serviceId: nextAssignee,
          warrantId: nextWarrant,
          attach: true,
          actor,
          reason: 'RH-P3.C3: one-click meltdown recovery reassigned this Task',
          roleGrantExpiry: input.roleGrantExpiry,
        });
      } else if (input.roleGrantExpiry !== undefined) {
        // Same Connector, same carriage, a new date (AZ-A10 clause 6, E62):
        // the rows stay and take the date the recovering shepherd set.
        await accessVehicleService.redate(client, {
          taskId, serviceId: nextAssignee, roleGrantExpiry: input.roleGrantExpiry, actor: taskAuditActor(actor),
        });
      }

      // 6. the durable record.
      await auditService.record({
        action: 'task.lifecycle_override.recovery',
        actor: taskAuditActor(actor),
        resourceType: 'task',
        resourceId: taskId,
        metadata: {
          previousStatus,
          previousAssigneePrincipalId: previousClaimant,
          previousAssigneeServiceId: previousAssignee,
          assigneeServiceId: nextAssignee,
          seedReportId,
          releasedLeaseIds,
          reason: input.reason ?? null,
        },
      }, client);

      // The stream entry rides `task.transitioned` — the event type migration
      // 086 already uses for a Task's status moves, and the one
      // TaskElementService.finish writes for in-progress -> review. Review r1
      // (verdict 2834c857, B1) correctly rejected an earlier `task.recovered`
      // here: a new dotted name in a durable, queryable column is new
      // vocabulary, and vocabulary arrives by declared amendment, never by
      // local invention. Nothing is lost by reusing the ratified name — a
      // recovery IS a transition, and `metadata.recovery` discriminates it
      // for anyone querying the stream.
      await client.query(
        `INSERT INTO task_stream_entries (task_id, provenance, event_type, content, report_id, metadata)
         VALUES ($1, 'system', 'task.transitioned', $2, $3, $4)`,
        [
          taskId,
          seedReportId
            ? `${previousStatus} -> todo; force-released and reassigned, seeded from report ${seedReportId}`
            : `${previousStatus} -> todo; force-released and reassigned, no linked Report to seed from`,
          seedReportId,
          {
            from: previousStatus,
            to: 'todo',
            recovery: true,
            previousAssigneePrincipalId: previousClaimant,
            previousAssigneeServiceId: previousAssignee,
            assigneeServiceId: nextAssignee,
            seedReportId,
            releasedLeaseIds,
            reason: input.reason ?? null,
          },
        ],
      );

      await feedEventService.emit(client, {
        name: 'task.updated',
        objectType: 'task',
        objectId: taskId,
        actorPrincipalId: actor?.principalId ?? null,
        actorHandle: actor?.handle ?? null,
        projectId: task.project_id ?? null,
        ownerPrincipalId: null,
        payload: { status: 'todo', previousStatus, fields: ['ownerPrincipalId', 'status'] },
      });

      // The whole point of putting it back in todo: the incoming assignee
      // must hear about it. Readiness is re-derived inside this transaction,
      // so the announcement and the reassignment become visible together.
      await syncTaskReadiness(client, taskId, actor ?? null);
      if (previousStatus !== 'todo') {
        await syncDependentsReadiness(client, taskId, actor ?? null);
      }

      await client.query('COMMIT');
      return {
        outcome: 'recovered',
        seedReportId,
        previousClaimantPrincipalId: previousClaimant,
        previousAssigneeServiceId: previousAssignee,
        assigneeServiceId: nextAssignee,
        releasedLeaseIds,
        previousStatus,
        status: 'todo',
      };
    } catch (err) {
      await client.query('ROLLBACK');
      // An AZ-S7 refusal is the coupling doing its job — the incoming
      // assignee could not be given access, so the reassignment must not
      // stand. It reaches the route as itself, never as a generic 503.
      if (err instanceof AssignmentAccessError) throw err;
      logCaughtFailure('[TaskManagerDB] recoverTask failed:', err);
      return { outcome: 'unavailable' };
    } finally {
      client.release();
    }
  }

  /** Section 6.8: the default Verifier a new card would inherit (Phase, then Project), for the audit of a `none` create. */
  private async defaultVerifierFor(client: PoolClient, projectId: string | null, phaseId: string | null): Promise<DisplacedVerifier | null> {
    if (!projectId || !(await this.taskColumnExists('verifier_source'))) return null;
    if (phaseId) {
      const phase = await client.query('SELECT default_verifier_principal_id FROM phases WHERE id = $1', [phaseId]);
      const value = phase.rows[0]?.default_verifier_principal_id;
      if (value) return { principalId: String(value), source: 'inherited-phase' };
    }
    const project = await client.query('SELECT default_verifier_principal_id FROM projects WHERE id = $1', [projectId]);
    const value = project.rows[0]?.default_verifier_principal_id;
    return value ? { principalId: String(value), source: 'inherited-project' } : null;
  }

  /**
   * Card 41e24358: the Verifier a new card starts with.
   *
   * EXPLICIT (`verifierPrincipalId` on POST /tasks and MCP task_create, owner
   * answer Q2 (b)) is admitted only when it equals the Project default or the
   * default of a non-archived Phase of the same Project AND passes the usable
   * predicate; anything else refuses 422 VERIFIER_NOT_ALLOWED and the create
   * rolls back, so no card exists. Nothing is ever silently replaced.
   *
   * INHERITED (Phase, then Project) never refuses (E284): a default that
   * fails the predicate is left unset and reported as DEFAULT_VERIFIER_UNUSABLE
   * on the create answer. The write itself runs under a SAVEPOINT (check F3):
   * an outcome other than `updated`, or a refusal by the role-row
   * materialization, rolls back only the Verifier and is reported as
   * DEFAULT_VERIFIER_UNUSABLE with failedArm `assignment` - never a 503.
   */
  private async resolveCreateVerifier(client: PoolClient, input: {
    taskId: string; projectId: string | null; phaseId: string | null; explicit: unknown;
    actor: TaskActor | undefined; transaction?: CreationTransaction; receipt?: CreateTaskReceipt;
  }): Promise<{ verifierPrincipalId: string; source: VerifierSource } | null> {
    const { taskId, projectId, phaseId, explicit, actor, receipt } = input;
    const hasColumns = await this.taskColumnExists('verifier_source');
    let chosen: string | null = null;
    let source: VerifierSource | null = null;
    let inheritedFrom: { phaseId?: string; projectId?: string } | undefined;
    if (explicit !== undefined && explicit !== null) {
      const notAllowed = (detail: string) => new RequestFaultError(422, 'VERIFIER_NOT_ALLOWED',
        `verifierPrincipalId is accepted only when it equals the Project default Verifier or the default of a non-archived Phase of the same Project, and that principal can judge the card (${detail})`);
      if (typeof explicit !== 'string' || !UUID_TEXT.test(explicit)) throw notAllowed('not a principal id');
      if (!projectId || !hasColumns) throw notAllowed('the card has no Project');
      const defaults = await client.query(
        `SELECT p.default_verifier_principal_id AS id FROM projects p
          WHERE p.id = $1 AND p.default_verifier_principal_id IS NOT NULL
         UNION
         SELECT ph.default_verifier_principal_id FROM phases ph
          WHERE ph.project_id = $1 AND ph.status <> 'archived' AND ph.default_verifier_principal_id IS NOT NULL`,
        [projectId],
      );
      const value = explicit.toLowerCase();
      if (!defaults.rows.some((row) => String(row.id).toLowerCase() === value)) throw notAllowed('not a default of this Project');
      const usability = await verifierUsabilityOf(client, { verifierPrincipalId: value, ownerPrincipalId: null });
      if (!usability.usable) throw notAllowed(VERIFIER_ARM_REASONS[usability.failedArm ?? 'none']);
      chosen = value;
      source = 'explicit';
    } else if (projectId && hasColumns) {
      if (phaseId) {
        const phase = await client.query('SELECT default_verifier_principal_id FROM phases WHERE id = $1', [phaseId]);
        const value = phase.rows[0]?.default_verifier_principal_id;
        if (value) { chosen = String(value); source = 'inherited-phase'; inheritedFrom = { phaseId }; }
      }
      if (!chosen) {
        const project = await client.query('SELECT default_verifier_principal_id FROM projects WHERE id = $1', [projectId]);
        const value = project.rows[0]?.default_verifier_principal_id;
        if (value) { chosen = String(value); source = 'inherited-project'; inheritedFrom = { projectId }; }
      }
    }
    if (!chosen || !source) return null;

    const inherited = source !== 'explicit';
    const warn = (failedArm: DefaultVerifierWarning['failedArm'], reason: string): void => {
      receipt?.warnings.push({
        code: 'DEFAULT_VERIFIER_UNUSABLE', source: source as DefaultVerifierWarning['source'],
        principalId: chosen as string, failedArm,
        message: `The ${source === 'inherited-phase' ? 'Phase' : 'Project'} default Verifier was not set on this card: ${reason}.`,
      });
    };
    if (inherited) {
      const usability = await verifierUsabilityOf(client, { verifierPrincipalId: chosen, ownerPrincipalId: null });
      if (!usability.usable) {
        warn(usability.failedArm ?? 'none', VERIFIER_ARM_REASONS[usability.failedArm ?? 'none']);
        return null;
      }
    }
    // The role rows are capped by the creator as assigner (AZ-A10 clauses
    // 1(c), 5); an internal create has no assigning authority to cap them by.
    if (!actor?.authorization || !actor.principalId) {
      if (inherited) { warn('assignment', 'the creating identity carries no assigning authority'); return null; }
      throw new RequestFaultError(422, 'VERIFIER_NOT_ALLOWED', 'verifierPrincipalId requires an authenticated creator');
    }
    const roleTransaction: CreationTransaction = input.transaction ?? {
      client, source: 'ordinary', actor, afterCommit: () => undefined,
    };
    await client.query('SAVEPOINT create_default_verifier');
    let outcome: string;
    let refusal: unknown;
    try {
      outcome = await this.assignTaskRoles(taskId, { verifierPrincipalId: chosen }, taskAuditActor(actor),
        roleTransaction, actor.authorization, { verifierSource: source, ...(inheritedFrom ? { inheritedFrom } : {}) });
    } catch (error) {
      outcome = 'refused';
      refusal = error;
    }
    if (outcome === 'updated') {
      await client.query('RELEASE SAVEPOINT create_default_verifier');
      return { verifierPrincipalId: chosen, source };
    }
    await client.query('ROLLBACK TO SAVEPOINT create_default_verifier');
    await client.query('RELEASE SAVEPOINT create_default_verifier');
    if (inherited) {
      const code = (refusal as { code?: unknown } | undefined)?.code;
      warn('assignment', `the role assignment was refused (${typeof code === 'string' ? code : outcome})`);
      return null;
    }
    if (refusal instanceof AssignmentAccessError) throw refusal;
    throw new RequestFaultError(409, 'VERIFIER_ASSIGNMENT_UNAVAILABLE', 'The named Verifier could not be assigned to the new card');
  }

  /** Dedicated server-owned Task-role assignment surface. Generic Task
   * PATCH never writes these columns; the route authorizes the Shepherd and
   * resolves active Principals before calling here. */
  async assignTaskRoles(
    taskId: string,
    assignments: { shepherdPrincipalId?: string; verifierPrincipalId?: string | null;
      roleGrantExpiry?: RoleGrantExpiryRequest },
    actor: AuditActor = { handle: 'system', authMethod: 'system' },
    transaction?: CreationTransaction,
    assigner?: AuthorizationActor,
    // Card 41e24358: where a supplied Verifier came from. Absent = 'assigned'
    // (the roles route, a Blueprint); clearing the Verifier clears the source.
    provenance?: { verifierSource?: VerifierSource; inheritedFrom?: { phaseId?: string; projectId?: string } },
    // T2 S5 (card 9ce0b0b0; change-request design section 7.1): an approved
    // task.roles change's decision, carried on the act's own audit row.
    ledger?: Record<string, unknown>,
  ): Promise<'updated' | 'self_review' | 'not_found' | 'unavailable'> {
    if (transaction && actor.principalId !== transaction.actor.principalId) throw new Error('Creation actor mismatch');
    // §8.2/T36 defensive layer (review 731415a7 B3): the transactional
    // service refuses cross-bound Agent roles even if a future caller
    // bypasses the route check.
    {
      const roleIds = [assignments.shepherdPrincipalId, assignments.verifierPrincipalId]
        .filter((value): value is string => typeof value === 'string');
      if (roleIds.length > 0) {
        const boundRows = await (transaction?.client ?? this.pool).query(
          `SELECT id, kind, bound_task_id, legacy_identity FROM principals WHERE id = ANY($1::uuid[])`,
          [roleIds],
        );
        for (const row of boundRows.rows) {
          if (row.kind === 'agent' && !row.legacy_identity && row.bound_task_id && String(row.bound_task_id) !== taskId) {
            throw new Error('CROSS_BOUND_ROLE: an Agent identity holds roles only on its bound Task (§8.2/T36)');
          }
        }
      }
    }
    if (
      !(await this.taskColumnExists('shepherd_principal_id')) ||
      !(await this.taskColumnExists('verifier_principal_id'))
    ) return 'unavailable';
    const client = transaction?.client ?? await this.pool.connect();
    try {
      if (!transaction) await client.query('BEGIN');
      const before = (await client.query(
        `SELECT shepherd_principal_id, verifier_principal_id, verification_none FROM tasks WHERE id = $1 FOR UPDATE`,
        [taskId],
      )).rows[0];
      const fields: string[] = [];
      const params: unknown[] = [taskId];
      if (assignments.shepherdPrincipalId !== undefined) {
        params.push(assignments.shepherdPrincipalId);
        fields.push(`shepherd_principal_id = $${params.length}`);
      }
      let verifierSource: VerifierSource | null | undefined;
      let verifierParam = 0;
      if (assignments.verifierPrincipalId !== undefined) {
        params.push(assignments.verifierPrincipalId);
        verifierParam = params.length;
        fields.push(`verifier_principal_id = $${verifierParam}`);
        // Card 41e24358: the source rides the same UPDATE, after the holder.
        verifierSource = assignments.verifierPrincipalId === null ? null : (provenance?.verifierSource ?? 'assigned');
        params.push(verifierSource);
        fields.push(`verifier_source = $${params.length}`);
        // Section 6.8 (E462 S4b): adding a Verifier clears `none` in the SAME
        // UPDATE; once cleared it can never be set again (migration 170).
        if (assignments.verifierPrincipalId !== null) {
          fields.push('verification_none_cleared_at = CASE WHEN verification_none THEN clock_timestamp() ELSE verification_none_cleared_at END');
          fields.push('verification_none = FALSE');
        }
      }
      if (fields.length === 0) {
        if (!transaction) await client.query('ROLLBACK');
        return 'updated';
      }

      const verifierGuard = assignments.verifierPrincipalId !== undefined
        ? `AND (owner_principal_id IS NULL OR $${verifierParam}::uuid IS NULL OR owner_principal_id <> $${verifierParam}::uuid)`
        : '';
      const updated = await client.query(
        `UPDATE tasks SET ${fields.join(', ')}, updated_at = NOW()
          WHERE id = $1
            ${verifierGuard}
          RETURNING id, project_id, owner_principal_id, shepherd_principal_id, verifier_principal_id, status`,
        params,
      );
      if (updated.rows.length > 0) {
        // AZ-A10 clause 7: rows are reaped at task-terminal and materialized
        // only for a live task, so a role field changed on a completed or
        // archived Task carries no rows until the Task is live again.
        const terminal = ['completed', 'archived'].includes(String(updated.rows[0].status));
        const roleChanges = [
          { role: 'shepherd' as const, previous: before?.shepherd_principal_id,
            next: updated.rows[0].shepherd_principal_id,
            supplied: assignments.shepherdPrincipalId !== undefined },
          { role: 'verifier' as const, previous: before?.verifier_principal_id,
            next: updated.rows[0].verifier_principal_id,
            supplied: assignments.verifierPrincipalId !== undefined },
        ];
        for (const change of roleChanges) {
          if (!change.supplied) continue;
          if (String(change.previous ?? '') === String(change.next ?? '')) {
            if (change.next && assignments.roleGrantExpiry) {
              await accessVehicleService.redateRole(client, taskId, change.role,
                String(change.next), assignments.roleGrantExpiry, actor);
            }
            continue;
          }
          await accessVehicleService.detachRole(client, taskId, change.role, actor,
            'AZ-A10: task role holder changed', change.previous ? String(change.previous) : undefined);
          if (change.next && !terminal) {
            if (!assigner) throw new AssignmentAccessError(403, 'ASSIGNER_UNKNOWN',
              'role assignment requires the assigning identity for its authority cap');
            await accessVehicleService.materializeRole(client, {
              taskId, principalId: String(change.next), role: change.role,
              actor, assigner, roleGrantExpiry: assignments.roleGrantExpiry,
            });
          }
        }
        if (before?.verification_none === true && assignments.verifierPrincipalId) {
          await recordVerificationNoneCleared(client, taskId, actor, String(assignments.verifierPrincipalId));
        }
        await auditService.record({
          action: 'task.lifecycle_override.roles', actor,
          resourceType: 'task', resourceId: taskId,
          metadata: {
            ...(ledger ?? {}),
            changedFields: Object.keys(assignments),
            shepherdPrincipalId: updated.rows[0].shepherd_principal_id,
            verifierPrincipalId: updated.rows[0].verifier_principal_id,
            ...(verifierSource !== undefined ? { verifierSource } : {}),
            ...(provenance?.inheritedFrom ? { inheritedFrom: provenance.inheritedFrom } : {}),
          },
        }, client);
        await feedEventService.emit(client, {
          name: 'task.updated', objectType: 'task', objectId: taskId,
          // RH-P3.C2 (pre-review F1): attribute the write (see claimTask).
          actorPrincipalId: actor?.principalId ?? null,
          actorHandle: actor?.handle ?? null,
          projectId: updated.rows[0].project_id ?? null,
          // Card 5854f0d6: the role field NAMES this edit wrote, never a value.
          ownerPrincipalId: updated.rows[0].owner_principal_id ?? null, payload: { fields: appliedFieldNames(assignments) },
        });
        if (!transaction) await client.query('COMMIT');
        return 'updated';
      }
      const existing = await client.query('SELECT id, owner_principal_id FROM tasks WHERE id = $1', [taskId]);
      if (!transaction) await client.query('ROLLBACK');
      if (existing.rows.length === 0) return 'not_found';
      return 'self_review';
    } catch (error) {
      if (!transaction) await client.query('ROLLBACK');
      if (error instanceof AssignmentAccessError) throw error;
      console.error('[TaskManagerDB] assignTaskRoles failed');
      return 'unavailable';
    } finally {
      if (!transaction) client.release();
    }
  }

  /**
   * Section 6.8 (E462 S4b): set or clear `verification: none` on an existing
   * Task (PATCH /tasks/:id/roles {"verificationNone": true|false}). Setting is
   * allowed only to the Account-control path or the roles authority outside
   * G(Task), never an Agent, while the Task is To Do and has never started; a
   * current Verifier is cleared in the same transaction and audited as
   * displaced. Clearing needs only the roles authority the route admitted.
   */
  async setTaskVerificationNone(taskId: string, value: boolean, actor: TaskActor): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = (await client.query(
        'SELECT verifier_principal_id, verifier_source, verification_none FROM tasks WHERE id = $1 FOR UPDATE', [taskId])).rows[0];
      if (!current) throw new NotFoundFault('Task not found', 'TASK_NOT_FOUND');
      if (value) {
        const basis = await verificationNoneSetterBasis(client, taskId, actor);
        let displaced: DisplacedVerifier | null = null;
        if (current.verifier_principal_id) {
          displaced = { principalId: String(current.verifier_principal_id), source: current.verifier_source ?? null };
          const roleTransaction: CreationTransaction = { client, source: 'ordinary', actor, afterCommit: () => undefined };
          const outcome = await this.assignTaskRoles(taskId, { verifierPrincipalId: null }, taskAuditActor(actor),
            roleTransaction, actor.authorization);
          if (outcome !== 'updated') throw new VerificationModeError(409, 'VERIFICATION_NONE_UNAVAILABLE', 'The current Verifier could not be cleared');
        }
        await recordVerificationNone(client, taskId, actor, basis, displaced, false);
      } else if (current.verification_none === true) {
        await client.query(
          `UPDATE tasks SET verification_none = FALSE, verification_none_cleared_at = clock_timestamp(), updated_at = NOW()
            WHERE id = $1`, [taskId]);
        await recordVerificationNoneCleared(client, taskId, taskAuditActor(actor), null);
      }
      await feedEventService.emit(client, {
        name: 'task.updated', objectType: 'task', objectId: taskId,
        actorPrincipalId: actor.principalId ?? null, actorHandle: actor.handle ?? null,
        payload: { fields: ['verificationNone'] },
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Query tasks with filters
   */
  async queryTasks(filters: TaskFilters = {}): Promise<Task[]> {
    const { conditions, params, orderClause } = await this.buildTaskWhere(filters);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = filters.limit && filters.limit > 0 ? `LIMIT ${Math.min(filters.limit, 100)}` : '';
    const offsetClause = filters.offset && filters.offset > 0 ? `OFFSET ${Math.max(filters.offset, 0)}` : '';

    const query = `
      SELECT t.*,
        at.slug AS at_slug, at.name AS at_name, at.color AS at_color, at.category AS at_category
        ${DUE_AT_ISO_SELECT}
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      LEFT JOIN personalities at ON at.id = t.personality_id
      ${whereClause}
      ${orderClause}
      ${limitClause}
      ${offsetClause}
    `;

    const result = await this.pool.query(query, params);

    // Batched (6a351638): constant query count however many rows return.
    return this.hydrateTasks(result.rows);
  }

  async getTaskFilterOptions(includeArchived = true): Promise<TaskFilterOptions> {
    const taskScope = includeArchived ? '' : "WHERE t.status <> 'archived'";
    const [tagsRes, projectsRes] = await Promise.all([
      this.pool.query(
        `SELECT DISTINCT tt.tag
         FROM task_tags tt
         JOIN tasks t ON t.id = tt.task_id
         ${taskScope}
         ORDER BY tt.tag ASC`
      ),
      this.pool.query(
        `SELECT DISTINCT p.name
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         ${taskScope}
         ORDER BY p.name ASC`
      ),
    ]);

    return {
      tags: tagsRes.rows.map((row: any) => row.tag),
      projects: projectsRes.rows.map((row: any) => row.name),
    };
  }

  /**
   * The board is the ONE Task list that paginates, and that is why its
   * authorization is a parameter rather than a step the route takes afterwards.
   *
   * A post-read narrowing (`filterAuthorizedResources`, which every other Task
   * list uses) cannot make this endpoint honest: `total` and `hasMore` come
   * from a COUNT, so a page narrowed after the fact still ships a count of rows
   * the caller may not read - and a count is a disclosure. Worse, the narrowing
   * is then something the route has to REMEMBER: from bcf89cc until card
   * 08f42f36 this route ran a filter loop over the wrong object, against a
   * field name the column rows do not have, and every row of the board left
   * unfiltered for eighteen days while a source census that looked for the word
   * `filterAuthorizedResources` stayed green.
   *
   * `authorization` is therefore REQUIRED and unnamed by default: a caller that
   * forgets it does not leak, it fails to compile.
   */
  async queryBoardColumns(
    statuses: string[],
    baseFilters: Omit<TaskFilters, 'status' | 'statuses' | 'limit' | 'offset'> = {},
    perColumn = 6,
    offsets: Record<string, number> = {},
    authorization: AuthorizationListScope<'task'>,
  ): Promise<BoardQueryResult> {
    const columns: Record<string, BoardColumnResult> = {};

    for (const status of statuses) {
      // A column holds exactly the status it is named after — no column widens
      // its query to sweep in another one.
      //
      // The Stuck column used to query ['stuck', 'review'], inherited from the
      // predecessor board's import (e854a3f), so every task in Review rendered
      // TWICE on the board: once under Review and again under Stuck, with
      // Stuck's `total` counting it as well. Owner-reported from the running
      // product rather than found by any gate.
      //
      // `stuck` means something is WRONG. `review` means something is WAITING to
      // be judged. Collapsing them made the board unable to answer "what is
      // actually broken", which is the one question that column exists for.
      const statusFilters: TaskFilters = {
        ...baseFilters,
        statuses: [status],
        includeArchived: baseFilters.includeArchived ?? status === 'archived',
      };

      const { conditions, params, orderClause, filterParamCount } = await this.buildTaskWhere(statusFilters);
      const offset = Math.max(offsets[status] || 0, 0);
      const limit = Math.min(Math.max(perColumn, 1), 100);

      // The authorization predicate is rendered TWICE only because the two
      // statements bind different numbers of filter parameters (the count query
      // drops the ORDER BY relevance parameters). The bound VALUES are
      // identical, and both renderings come from the same
      // `authorizationService.sqlCondition` call site that `authorizedIds` -
      // and therefore `GET /tasks/:id` - runs, so the page, the total and the
      // point route cannot disagree about a single row.
      const countAuth = authorization.render(filterParamCount + 1);
      const dataAuth = authorization.render(params.length + 1);
      // `conditions` may be empty; the predicate never is (`TRUE`/`FALSE` at
      // the extremes), so the WHERE is unconditional and there is no spelling
      // of this query that omits the narrowing.
      const whereFor = (predicate: string): string => `WHERE ${[...conditions, predicate].join(' AND ')}`;

      // The FROM comes from the scope, not from here: it is where the
      // inheritance shape (Task -> Phase -> Project) is CONFIGURED, and a query
      // that hand-copied it could not notice that shape changing.
      const countQuery = `
        SELECT COUNT(*)::int AS total
        FROM ${authorization.from}
        ${whereFor(countAuth.sql)}
      `;

      const dataQuery = `
        SELECT t.*, at.slug AS at_slug, at.name AS at_name, at.color AS at_color, at.category AS at_category${DUE_AT_ISO_SELECT}
        FROM ${authorization.from}
        LEFT JOIN personalities at ON at.id = t.personality_id
        ${whereFor(dataAuth.sql)}
        ${orderClause}
        LIMIT ${limit}
        OFFSET ${offset}
      `;

      const countParams = [...params.slice(0, filterParamCount), ...countAuth.params];
      const dataParams = [...params, ...dataAuth.params];
      const [countRes, dataRes] = await Promise.all([
        this.pool.query(countQuery, countParams),
        this.pool.query(dataQuery, dataParams),
      ]);

      const hydratedItems = await this.hydrateTasks(dataRes.rows);
      const items = await this.addDependencyMeta(hydratedItems);
      const total = Number(countRes.rows[0]?.total || 0);

      columns[status] = {
        items,
        total,
        offset,
        limit,
        hasMore: offset + items.length < total,
      };
    }

    return { columns };
  }

  /**
   * Get a single task by ID
   */
  async getTask(id: string, client?: PoolClient): Promise<Task | undefined> {
    const result = await (client ?? this.pool).query(
      `SELECT t.*, at.slug AS at_slug, at.name AS at_name, at.color AS at_color, at.category AS at_category${DUE_AT_ISO_SELECT}
       FROM tasks t LEFT JOIN personalities at ON at.id = t.personality_id WHERE t.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return undefined;
    }

    return this.hydrateTask(result.rows[0], client);
  }

  /**
   * Get all tasks
   */
  async getAllTasks(): Promise<Task[]> {
    return this.queryTasks();
  }

  /**
   * Create a new task
   */
  /**
   * RH-P3.AZ-S7 — the assignment-access coupling (owner ruling 7440b579
   * R1; AUTHZ amendment AZ-A2; contract note d3accc39).
   *
   * `tasks.execution_service_id` is the assignment field of record
   * (packet c17ebfff D6) and THIS class is the only place it is written,
   * so the coupling lives here rather than in a route: every path — REST
   * create and update, MCP, CLI, orchestration — passes through it, and
   * the vehicle is materialized in the SAME transaction as the task write,
   * which is what R1's "simultaneously" means.
   *
   * A refusal throws, rolling the task write back with it. That is the
   * whole point: the assigned-but-invisible state is unrepresentable, and
   * strategy 4e40f06f §2.6.4's union is satisfied by construction.
   */
  private async attachExecutionVehicle(
    client: PoolClient,
    input: {
      taskId: string; serviceId: string; warrantId: string | null; actor?: TaskActor;
      /** AZ-A10 clause 6: the assigning act's date; absent = the default. */
      roleGrantExpiry?: RoleGrantExpiryRequest;
    },
  ): Promise<{ warrantId: string | null }> {
    const assigner = input.actor?.authorization;
    if (!assigner) {
      // Fail closed rather than silently assigning with no R3 cap: an
      // execution assignment always has an assigner, and a caller that
      // forgot to carry one is a wiring bug, not a system act.
      throw new AssignmentAccessError(403, 'ASSIGNER_UNKNOWN',
        'an execution assignment must carry the assigning identity so the R3 non-escalation cap can be applied (ruling 7440b579)',
        'executionProfile');
    }
    const result = await accessVehicleService.attach(client, {
      taskId: input.taskId,
      serviceId: input.serviceId,
      warrantId: input.warrantId,
      actor: taskAuditActor(input.actor),
      assigner,
      roleGrantExpiry: input.roleGrantExpiry,
    });
    return { warrantId: result.warrantId };
  }

  /** Recovery's replay test for a date (AZ-A10 clause 6): do this task's
   * assignment links ALREADY carry exactly the requested date? */
  private async assignmentCarriesExpiry(
    client: PoolClient,
    taskId: string,
    requested: RoleGrantExpiryRequest,
  ): Promise<boolean> {
    const carried = await accessVehicleService.assignmentExpiry(taskId, client);
    if (carried === undefined) return false;
    return requested.kind === 'unlimited' ? carried === null : carried === requested.instant;
  }

  /**
   * Re-point an assignment's ACCESS VEHICLE: drop the old one, then attach
   * the new one for the incoming assignee (RH-P3.AZ-S7, ruling 7440b579).
   *
   * The old vehicle goes FIRST, so a re-assignment to a different Connector
   * never leaves the previous assignee holding access to work it no longer
   * has.
   *
   * Extracted at RH-P3.C3 because meltdown recovery re-assigns too, and two
   * copies of this sequence is exactly the failure owner ruling AZ-A3 named:
   * "no risk of a fix landing on one path and not the other". Both callers
   * run inside the caller's transaction, so the vehicle moves in the same
   * commit as the task write — which is what R1's "simultaneously" means.
   */
  private async swapExecutionVehicle(
    client: PoolClient,
    input: {
      taskId: string;
      serviceId: string | null;
      warrantId: string | null;
      /** FALSE for a task going terminal: R2(b) reaps, it does not re-attach. */
      attach: boolean;
      actor?: TaskActor;
      reason: string;
      /** AZ-A10 clause 6: the incoming assignment's date; absent = the default. */
      roleGrantExpiry?: RoleGrantExpiryRequest;
    },
  ): Promise<void> {
    await accessVehicleService.detach(client, input.taskId, taskAuditActor(input.actor), input.reason);
    await client.query('UPDATE tasks SET execution_warrant_id = NULL WHERE id = $1', [input.taskId]);
    if (input.serviceId && input.attach) {
      const attached = await this.attachExecutionVehicle(client, {
        taskId: input.taskId,
        serviceId: input.serviceId,
        warrantId: input.warrantId,
        actor: input.actor,
        roleGrantExpiry: input.roleGrantExpiry,
      });
      if (attached.warrantId) {
        await client.query(
          'UPDATE tasks SET execution_warrant_id = $1 WHERE id = $2',
          [attached.warrantId, input.taskId],
        );
      }
    }
  }

  /**
   * `projectTarget` is REQUIRED and is deliberately not optional (card
   * `9c177e6a`). Every create path reaches this method, so a path that cannot
   * name the caller's authority over the target Project fails to compile
   * rather than defaulting to something. `actor` keeps its optional shape and
   * is NOT the vehicle for this decision: its `authorization` field falls back
   * to `SYSTEM_AUTHORIZATION_ACTOR`, which holds `root`.
   */
  async createTask(
    data: Partial<Task>,
    actor: TaskActor | undefined,
    projectTarget: AuthorizedProjectTarget,
    transaction?: CreationTransaction,
    receipt?: CreateTaskReceipt,
  ): Promise<Task> {
    if (transaction && actor?.principalId !== transaction.actor.principalId) throw new Error('Creation actor mismatch');
    const requestedSubtaskStatuses = (data.subtasks || []).map((subtask) => subtask.status || 'empty');
    const ownerLifecycleRequested = data.status === 'completed' || requestedSubtaskStatuses.some(status =>
      status === 'completed' || (actor?.role === 'agent' && status !== 'empty'
        && !AGENT_ALLOWED_STATUSES.includes(status as SubtaskStatus)));
    const assertCreationLifecycle = (accountControl = false): void => {
      for (const status of requestedSubtaskStatuses) {
        if (status === 'completed' && actor?.role !== 'qa' && actor?.role !== 'reviewer' && !accountControl) {
          throw new ForbiddenFault('Only an independent Verifier identity can create a completed subtask');
        }
        if (actor?.role === 'agent' && !accountControl && status !== 'empty' && !AGENT_ALLOWED_STATUSES.includes(status as SubtaskStatus)) {
          throw new ForbiddenFault(`Implementation agents cannot create a subtask with status '${status}'`);
        }
      }
      if (data.status === 'completed') {
        if (actor?.role !== 'qa' && actor?.role !== 'reviewer' && !accountControl) {
          throw new ForbiddenFault('Only an independent Verifier identity can create a completed task');
        }
        if (!allSubtaskStatusesDone(requestedSubtaskStatuses)) {
          throw new ConflictFault('A task can be completed only when every subtask is completed or skipped');
        }
      }
    };
    if (!ownerLifecycleRequested || !actor?.authorization?.authenticated) assertCreationLifecycle();

    const client = transaction?.client ?? await this.pool.connect();

    try {
      if (!transaction) await client.query('BEGIN');
      if (data.dependsOn && data.dependsOn.length > 0) await lockDependencyGraph(client, transaction);

      // Card 9c177e6a. The TARGET Project is decided FIRST - before the
      // dependency read, before the INSERT, before any statement of this
      // transaction that could leave a row behind - and it is decided on THIS
      // transaction's client, so the decision and the write it guards are the
      // same transaction rather than two observations of the database.
      //
      // A caller that names no Project names no target and nothing is decided:
      // an orphan Task inherits nothing (117), so there is no perimeter to
      // cross. A caller that names one gets a resolved id or the ONE refusal,
      // and `phase_id` needs no separate decision of its own - migration 079's
      // `tasks_phase_requires_project` CHECK refuses a Phase without a Project
      // and its composite FK `(phase_id, project_id) -> phases(id, project_id)`
      // refuses a Phase from any other one, so the Phase is inside the Project
      // this line just decided or the INSERT does not happen.
      const projectId = data.project ? await projectTarget(String(data.project), client) : null;
      if (data.project && projectId === null) throw new ProjectTargetNotFoundFault();

      // Card b13e5ac9 (owner ruling D34(b), Charter v5 §6.1): a Task created
      // WITHOUT an explicit phaseId in a Project that names an inbox phase
      // lands in it, and a Task that lands in the inbox without an explicit
      // status is created as Ideas. An explicit phaseId (including null, the
      // backlog) or status wins for its own field (§6.2). Decided HERE,
      // after the target Project and on this transaction, because every
      // creation surface reaches this method: the dashboard form, REST, MCP
      // and the CLI cannot disagree about where a new card lands. The inbox
      // row is read FOR SHARE so it cannot be archived or deleted between
      // this decision and the INSERT. A Project with no inbox phase, and an
      // orphan Task, take exactly the path they took before migration 141.
      if (projectId !== null && (data.phaseId === undefined || statusAbsent(data.status))) {
        const placement = resolveCreatePlacement(
          { phaseId: data.phaseId, status: data.status },
          await readInboxPhase(client, projectId, { lock: true }),
        );
        data = { ...data, phaseId: placement.phaseId, status: placement.status as Task['status'] };
      }

      const now = new Date().toISOString();

      // Validate dependencies before creating. The task has no id yet, so
      // there is no self/circular dependency to check — only referential
      // integrity. (Previously this passed dependsOn[0] as the "current task
      // id", which made every create-with-dependencies trip the
      // self-dependency check.)
      if (data.dependsOn && data.dependsOn.length > 0) {
        await this.validateDependencies(data.dependsOn, undefined, client);
      }

      // Resolve thinking level
      const thinking = this.resolveThinking(data);

      // Insert task
      const taskResult = await client.query(
        `INSERT INTO tasks (
          title, description, status, priority, project_id, thinking_budget, thinking_auto_estimated, model, execution_mode, execution_profile, execution_service_id, execution_descriptor_version, success_criteria, review_history, max_retries, definition_of_done, constraints, auto_start, blocked_reason, status_reason, attempt_count, parent_id, personality_id, phase_id, created_at, updated_at, started_at, completed_at, archived_at, archive_disposition, notes, due_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32
        ) RETURNING *${DUE_AT_ISO_RETURNING}`,
        [
          data.title || 'Untitled Task',
          data.description || '',
          data.status || 'todo',
          data.priority || 'normal',
          projectId,
          thinking.thinking,
          thinking.thinkingAutoEstimated,
          data.model || null,
          // execution_mode retired from the write path (D-15); the column
          // survives read-only for legacy rows.
          null,
          data.executionProfile ? JSON.stringify(data.executionProfile) : null,
          (data as any).executionServiceId ?? null,
          (data as any).executionDescriptorVersion ?? null,
          data.successCriteria !== undefined ? JSON.stringify(data.successCriteria) : null,
          data.reviewHistory !== undefined ? JSON.stringify(data.reviewHistory) : '[]',
          data.maxRetries ?? 3,
          data.definitionOfDone !== undefined ? JSON.stringify(data.definitionOfDone) : null,
          data.constraints !== undefined ? JSON.stringify(data.constraints) : null,
          // Lifecycle gate: autoStart defaults FALSE (explicit opt-in only).
          // Previously defaulted true for any non-ideas status, which made the
          // orchestration loop auto-pick freshly created tasks unattended.
          data.autoStart !== undefined ? data.autoStart : false,
          data.blockedReason || null,
          null, // status_reason
          data.attemptCount || 0,
          data.parentId || null,
          (data as any).personalityId || null,
          // Phase membership (079). Bound to the task's own project by the
          // composite FK — a Phase from another Project raises 23503, which
          // the routes translate into a typed 409 rather than a 500.
          data.phaseId || null,
          now,
          now,
          data.status === 'in-progress' ? now : data.startedAt || null,
          data.status === 'completed' ? now : data.completedAt || null,
          data.status === 'archived' ? now : data.archivedAt || null,
          // Direct create in archived status is rare, but record a disposition
          // so the row never ends up archived-with-NULL-disposition.
          data.status === 'archived' ? computeArchiveDisposition(null, data.subtasks || []) : null,
          // Card 9c3a1aa4. This column was the whole defect: the route accepted
          // `notes`, the payload carried it here, and the INSERT never named
          // it, so a create answered 201 and stored nothing. The route
          // normalizes the value through the same function the update route
          // uses; null and absent both land as NULL, which is what an
          // un-noted Task has always been.
          (data.notes as string | null | undefined) ?? null,
          // Card 7d38a6e0. NULL is no deadline, which is what a Task created
          // without one has and what every Task on every deployment had
          // before migration 124.
          data.dueAt ?? null,
        ]
      );
      const taskId = taskResult.rows[0].id;
      await lifecyclePolicyService.evaluate(client, {
        action: 'task.create',
        subject: { kind: 'task', id: taskId },
        proposed: {
          status: data.status || 'todo',
          projectId,
          phaseId: data.phaseId || null,
          autoStart: data.autoStart === true,
        },
      });

      // Creation attribution (migration 063), stamped INSIDE the creating
      // transaction so the stored Task never changes after its task.created
      // event — a consumer that pulls on the event must see the same row
      // authorization will read (round 4 review 91461e9b, F2). The
      // column-existence checks keep pre-063 compatibility; a stamp failure
      // now rolls the create back with the rest of the transaction, which is
      // the honest outcome — a Task whose authorization-bearing attribution
      // could not be recorded should not exist half-attributed.
      if (actor?.principalId) {
        const hasCreator = await this.taskColumnExists('creator_principal_id');
        const hasShepherd = await this.taskColumnExists('shepherd_principal_id');
        if (hasCreator || hasShepherd) {
          const assignments = [
            ...(hasCreator ? ['creator_principal_id = $2'] : []),
            ...(hasShepherd ? ['shepherd_principal_id = $2'] : []),
          ];
          await client.query(
            `UPDATE tasks SET ${assignments.join(', ')} WHERE id = $1`,
            [taskResult.rows[0].id, actor.principalId]
          );
          if (hasCreator) taskResult.rows[0].creator_principal_id = actor.principalId;
          if (hasShepherd) taskResult.rows[0].shepherd_principal_id = actor.principalId;
        }
      }

      // Ordinary authenticated creation bootstraps only this creator's
      // exact Task grants. Internal/system actors have no trusted authority;
      // Blueprint creation deliberately keeps its separate access contract.
      if (transaction?.source !== 'blueprint' && actor?.authorization) {
        if (!actor.principalId || actor.principalId !== actor.authorization.principalId) {
          throw new ForbiddenFault('Authenticated Task creation authority is required', 'TASK_CREATOR_REQUIRED');
        }
        await grantService.createForTaskCreator(client, taskId, actor.authorization, taskAuditActor(actor));
      }
      if (actor?.authorization && taskResult.rows[0].shepherd_principal_id
        && !['completed', 'archived'].includes(String(taskResult.rows[0].status))) {
        await accessVehicleService.materializeRole(client, {
          taskId, principalId: String(taskResult.rows[0].shepherd_principal_id),
          role: 'shepherd', actor: taskAuditActor(actor), assigner: actor.authorization,
        });
      }

      // Card 41e24358 (design ba22fd01 Part 3): the Verifier at creation,
      // decided AFTER the landing Phase (the inbox decision above) and the
      // Shepherd stamp, on this transaction: explicit -> the landing Phase's
      // default -> the Project default -> none.
      // Section 6.8 (E462 S4b): `verification: none` at creation suppresses
      // the inherited Phase/Project default Verifier; the displaced default is
      // audited. The setter's authority is decided below, once the execution
      // assignment (part of G(Task)) is in place.
      const verificationNoneRequested = (data as { verificationNone?: unknown }).verificationNone === true;
      let displacedDefault: DisplacedVerifier | null = null;
      if (verificationNoneRequested) {
        const explicitVerifier = (data as { verifierPrincipalId?: unknown }).verifierPrincipalId;
        if (explicitVerifier !== undefined && explicitVerifier !== null) {
          throw new VerificationModeError(422, 'VERIFICATION_NONE_WITH_VERIFIER', 'verificationNone and verifierPrincipalId cannot be given together');
        }
        if (!['todo', 'ideas'].includes(String(taskResult.rows[0].status))) {
          throw new VerificationModeError(409, 'VERIFICATION_NONE_TASK_STARTED', 'Verification none can be set only on a Task created in To Do or Ideas');
        }
        displacedDefault = await this.defaultVerifierFor(client, projectId, data.phaseId ?? null);
      }
      const createdVerifier = verificationNoneRequested ? null : await this.resolveCreateVerifier(client, {
        taskId, projectId, phaseId: data.phaseId ?? null,
        explicit: (data as { verifierPrincipalId?: unknown }).verifierPrincipalId,
        actor, transaction, receipt,
      });
      if (createdVerifier) {
        taskResult.rows[0].verifier_principal_id = createdVerifier.verifierPrincipalId;
        taskResult.rows[0].verifier_source = createdVerifier.source;
      }

      // Owner/Main creation uses the same fresh, scoped authority as lifecycle
      // edits. The row and its creator grants exist only in this transaction;
      // any refusal rolls them all back before a feed event can escape.
      if (ownerLifecycleRequested && actor?.authorization?.authenticated) {
        const account = await taskAccountControl(client, taskId, actor);
        assertCreationLifecycle(Boolean(account));
        if (account) await recordAccountTaskDisposition(client, taskId, actor, account, 'explicit-task-create');
      }

      // Insert subtasks
      if (data.subtasks && data.subtasks.length > 0) {
        for (let i = 0; i < data.subtasks.length; i++) {
          const s = data.subtasks[i];
          await client.query(
            `INSERT INTO subtasks (task_id, index, title, status, note, completed_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [taskId, i, s.text, s.status || 'empty', s.reviewNote || null, s.completedAt || null]
          );
        }
      }

      // Insert tags
      if (data.tags && data.tags.length > 0) {
        for (const tag of data.tags) {
          await client.query(
            `INSERT INTO task_tags (task_id, tag) VALUES ($1, $2)
             ON CONFLICT (task_id, tag) DO NOTHING`,
            [taskId, tag]
          );
        }
      }

      // Insert dependencies
      if (data.dependsOn && data.dependsOn.length > 0) {
        for (const depId of data.dependsOn) {
          await client.query(
            `INSERT INTO task_dependencies (task_id, depends_on_task_id)
             VALUES ($1, $2)`,
            [taskId, depId]
          );
        }
      }

      // Insert links
      if (data.links && data.links.length > 0) {
        for (const link of data.links) {
          await client.query(
            `INSERT INTO task_links (task_id, type, title, url)
             VALUES ($1, $2, $3, $4)`,
            [taskId, link.type, link.title, link.url]
          );
        }
      }

      if (data.autoStart === true) {
        await auditService.record({
          action: 'task.arm',
          actor: taskAuditActor(actor),
          resourceType: 'task',
          resourceId: taskId,
          metadata: { source: 'create' },
        }, client);
      }

      // RH-P3.AZ-S7 (ruling 7440b579 R1): a task created ALREADY ASSIGNED
      // gets its access vehicle in this same transaction, or the create is
      // refused. Same rule, same choke point, same proof as an update.
      const createdAssignment = (data as any).executionServiceId ?? null;
      if (createdAssignment) {
        const attached = await this.attachExecutionVehicle(client, {
          taskId,
          serviceId: String(createdAssignment),
          warrantId: (data as any).executionWarrantId ?? null,
          actor,
          roleGrantExpiry: assigningActExpiry(data),
        });
        if (attached.warrantId) {
          await client.query('UPDATE tasks SET execution_warrant_id = $1 WHERE id = $2', [attached.warrantId, taskId]);
        }
      }

      // Section 6.8 (E462 S4b): who may set `none` (never an Agent, never a
      // principal in G(Task) on any basis; then the Account-control path, or
      // the Shepherd/administrator authority). The creator is the new Task's
      // Shepherd. A Blueprint instantiation sets it through its own plan
      // authority instead.
      if (verificationNoneRequested && actor) {
        const basis = await verificationNoneSetterBasis(client, taskId, actor);
        await recordVerificationNone(client, taskId, actor, basis, displacedDefault, true);
        Object.assign(taskResult.rows[0], { verification_none: true, verification_none_set_by: actor.principalId,
          verification_none_basis: basis });
      } else if (verificationNoneRequested) {
        throw new VerificationModeError(403, 'VERIFICATION_NONE_FORBIDDEN', 'Setting verification none requires an authenticated identity');
      }

      // RH-P3.C1: the feed event rides the creating transaction — visible
      // exactly when the Task is, gone if this rolls back.
      await feedEventService.emit(client, {
        name: 'task.created',
        objectType: 'task',
        objectId: taskId,
        actorPrincipalId: actor?.principalId ?? null,
        actorHandle: actor?.handle ?? null,
        projectId: projectId || null,
        ownerPrincipalId: (data as { ownerPrincipalId?: string | null }).ownerPrincipalId ?? null,
        payload: { status: data.status || 'todo' },
      });

      // RH-P3.C2: a task can be born ready (todo + armed + no unmet
      // dependencies). Same transaction as the creation, so the feed never
      // announces a task that rolled back.
      await syncTaskReadiness(client, taskId, actor ?? null);

      if (transaction) {
        await taskHistoryService.recordChange(taskId, taskResult.rows[0].title, 'status', null,
          taskResult.rows[0].status, actor?.handle || 'system', actor?.principalId ?? null, client);
      }
      if (!transaction) await client.query('COMMIT');

      // Fetch the complete task
      const task = await this.hydrateTask(taskResult.rows[0], client);

      // These notifications describe committed work. A containing creation
      // transaction owns when they become externally observable.
      const notify = async () => {
        this.emit('task.created', task);
        if (!transaction) await taskHistoryService.recordChange(task.id, task.title, 'status', null, task.status, actor?.handle || 'system', actor?.principalId ?? null);

        // A create that WRITES notes is a notes mutation, and docs/api.md states
        // as a property that no notes mutation is invisible: every path that
        // writes the column leaves a server-written history row carrying
        // actor_principal_id, which the caller cannot author or suppress. When
        // create started writing the column it became such a path, so it leaves
        // the row too. Values omitted, exactly as the update path omits them.
        //
        // Dispatcher ruling R2 (C9 composition): the row is written INSIDE this
        // post-commit closure, alongside the other post-commit work, so a
        // rolled-back create leaves none - which is the property the control
        // that ships with it measures.
        if (typeof task.notes === 'string' && task.notes.length > 0) {
          await taskHistoryService.recordChange(
            task.id, task.title, 'notes', null, null,
            actor?.handle || 'system', actor?.principalId ?? null
          );
        }

        console.log('[TaskManagerDB] Created task:', task.id, task.title);
      };
      if (transaction) transaction.afterCommit(notify); else await notify();
      return task;

    } catch (err) {
      if (!transaction) await client.query('ROLLBACK');
      logCaughtFailure('[TaskManagerDB] Error creating task:', err);
      throw err;
    } finally {
      if (!transaction) client.release();
    }
  }

  /**
   * Update an existing task.
   *
   * `archiveReason` (not a Task field) is only honored on a transition INTO
   * 'archived': it is appended to task notes as
   * "Archived (<disposition>): <reason>". Both archive paths (PATCH
   * status->archived with body field archiveReason, and archiveTask() below)
   * funnel through here, so the semantics are identical by construction.
   */
  /**
   * The MOVE half of card `9c177e6a`: `updates.project` rewrites
   * `tasks.project_id` exactly as a create writes it, so `PATCH /tasks/:id`
   * and `PATCH /tasks/batch` could move a Task INTO a Project the caller
   * cannot read through the same unguarded helper.
   *
   * Unlike `createTask`, `projectTarget` here is OPTIONAL in the signature and
   * REFUSED at the write. This method has a dozen internal callers - the
   * archive sweep, the analyzer, the reviewer service, the Discord binder -
   * none of which carry a request and none of which ever set `project`.
   * Making the parameter required would ask each of them to invent an
   * authorization value out of nothing, which is precisely how a `SYSTEM`
   * fallback gets written. So the OMISSION is refused at the one line it
   * guards instead: a caller that forgets the target cannot perform the move
   * at all (`PROJECT_TARGET_REQUIRED`), which is the fail-closed direction,
   * and `projectTargetRefusesWithoutDecision` in the unit suite is the control
   * that the omission still refuses.
   */
  async updateTask(
    id: string,
    updates: Partial<Task> & { archiveReason?: string },
    actor?: TaskActor,
    projectTarget?: AuthorizedProjectTarget,
    transaction?: CreationTransaction,
    originalPatch?: unknown,
    archiveOperation?: typeof RESTORE_ARCHIVE | typeof ARCHIVE_COMPLETED,
    // Card 5854f0d6, round 2: who the feed row records when the write runs
    // under another authority actor (the internal reviewer) or none (the
    // breakdown analyzer). Attribution only: it never grants or checks authority.
    feedActor?: FeedActorRef,
  ): Promise<Task> {
    id = canonicalDependencyId(id);
    const restoring = archiveOperation === RESTORE_ARCHIVE;
    const completedOnlyArchive = archiveOperation === ARCHIVE_COMPLETED;
    const humanArchive = actor?.role === 'agent' && isTaskArchivePatch(updates)
      && (originalPatch === undefined || isTaskArchivePatch(originalPatch));
    const reviewerAuthorized = actor?.role === 'qa' || actor?.role === 'reviewer';
    const internalReviewer = reviewerAuthorized && actor?.authMethod === 'system'
      && actor.principalId === null && !actor.authorization;
    const completionRequest = updates.status === 'completed' && !internalReviewer;
    // The route passes the original body so discarded fields cannot turn a
    // mixed write into verification. Raw shape never replaces actual updates.
    const completionAttempt = completionRequest && isTaskCompletionPatch(updates)
      && (originalPatch === undefined || isTaskCompletionPatch(originalPatch));
    if (completionRequest && !actor) {
      throw new ForbiddenFault('Only an independent Verifier identity can mark a task completed');
    }
    if (updates.subtasks?.some((subtask) => subtask.status === 'completed') && !reviewerAuthorized && !actor) {
      throw new ForbiddenFault('Only an independent Verifier identity can submit completed subtasks');
    }
    if (transaction && actor?.principalId !== transaction.actor.principalId) throw new Error('Task update actor mismatch');
    const client = transaction?.client ?? await this.pool.connect();

    try {
      if (!transaction) await client.query('BEGIN');
      if (updates.dependsOn !== undefined) await lockDependencyGraph(client, transaction);

      // The planning exception decides on the current source state and exact
      // Shepherd while holding the same row lock as the subsequent write.
      const planningAttempt = actor?.role === 'agent' && isPlanningTaskStatusPatch(updates)
        && (originalPatch === undefined || isPlanningTaskStatusPatch(originalPatch));
      const currentRes = await client.query(
        'SELECT * FROM tasks WHERE id = $1' + (restoring || completedOnlyArchive || humanArchive || planningAttempt || updates.status === 'completed' || updates.subtasks !== undefined ? ' FOR UPDATE' : ''), [id]);
      if (currentRes.rows.length === 0) {
        throw new NotFoundFault(`Task not found: ${id}`, 'TASK_NOT_FOUND');
      }

      const current = currentRes.rows[0];
      const accountControl = actor && !completionRequest && (updates.status !== undefined || updates.subtasks !== undefined)
        ? await taskAccountControl(client, id, actor) : null;
      if (humanArchive || restoring) await assertHumanTaskArchiveAuthority(client, id, actor);
      if (completedOnlyArchive && current.status !== 'completed') {
        throw new ConflictFault('Task is no longer Completed', 'NOT_COMPLETED');
      }
      if (restoring) {
        if (current.status !== 'archived') throw new TaskNotArchivedError(id);
        const prior = await taskHistoryService.priorStatusBeforeArchive(id, client);
        if (!prior || !['ideas', 'todo', 'in-progress', 'review', 'stuck', 'completed'].includes(prior)) {
          throw new ConflictFault('The prior Task state could not be established', 'TASK_RESTORE_PROVENANCE_REQUIRED');
        }
        // A disposition inferred from children is not a whole-Task verdict.
        if (prior === 'completed' && (current.archive_disposition !== 'completed'
          || !current.archived_at || current.completed_at && new Date(current.completed_at).getTime() > new Date(current.archived_at).getTime())) {
          throw new ConflictFault('Prior completion evidence is inconsistent', 'TASK_RESTORE_PROVENANCE_REQUIRED');
        }
        updates = { status: prior as TaskStatus };
      }
      let lockedCompletionStatuses: string[] | undefined;
      if (completionRequest && !completionAttempt) {
        await assertCompletedTaskWriteAuthority(client, current, actor!);
      }
      if (completionAttempt || internalReviewer && updates.status === 'completed') {
        // Other writers may hold a child before updating its parent. Never
        // wait in the inverse order: NOWAIT rolls this whole attempt back
        // with a retryable conflict. The immediate nondeferrable task FK
        // makes concurrent child inserts wait for this parent FOR UPDATE.
        try {
          const children = await client.query(
            'SELECT status FROM subtasks WHERE task_id = $1 ORDER BY id FOR UPDATE NOWAIT', [id]);
          lockedCompletionStatuses = children.rows.map(row => row.status);
        } catch (error) {
          if ((error as { code?: unknown })?.code === '55P03') {
            throw new ConflictFault('Task is being changed; retry completion', 'TASK_COMPLETION_BUSY');
          }
          throw error;
        }
        if (completionAttempt) await assertTaskCompletionAuthority(client, current, actor!);
      }
      if (accountControl && actor && updates.subtasks !== undefined) {
        await recordAccountTaskDisposition(client, id, actor, accountControl, 'explicit-subtask-update');
      }
      const oldStatus = current.status;
      const oldPriority = current.priority;
      const oldNotes = current.notes;
      const now = new Date().toISOString();

      // Whole-task edit payloads may replace the subtask array, so apply the
      // same Verifier-only transition policy used by the dedicated endpoints.
      if (updates.subtasks !== undefined) {
        assertTerminalTaskChildren(updates.status ?? current.status, updates.subtasks.map(subtask => subtask.status || 'empty'));
      }
      if (updates.subtasks !== undefined && actor) {
        const previous = await client.query('SELECT index, status FROM subtasks WHERE task_id = $1', [id]);
        const previousByIndex = new Map(previous.rows.map((row) => [Number(row.index), String(row.status)]));
        for (let index = 0; index < updates.subtasks.length; index += 1) {
          const next = updates.subtasks[index].status || 'empty';
          const previousStatus = previousByIndex.get(index);
          if (previousStatus === next || (previousStatus === undefined && next === 'empty')) continue;
          if (next === 'completed' && actor.role !== 'qa' && actor.role !== 'reviewer' && !accountControl) {
            throw new ForbiddenFault('Only an independent Verifier identity can complete a subtask');
          }
          if (actor.role === 'agent' && !accountControl && !AGENT_ALLOWED_STATUSES.includes(next as SubtaskStatus)) {
            throw new ForbiddenFault(`Implementation agents cannot set subtask status to '${next}'`);
          }
        }
      }

      // Completion is an independent-review transition, not an implementer or
      // dashboard convenience action. Internal structured review supplies an
      // explicit system actor; authenticated callers carry request authority.
      if (updates.status && actor?.role === 'agent' && !AGENT_ALLOWED_TASK_STATUSES.includes(updates.status) && !completionRequest && !humanArchive && !restoring && !accountControl) {
        if (!planningAttempt) throw new ForbiddenFault(`Implementation agents cannot move tasks to '${updates.status}'`);
        await assertTaskPlanningAuthority(client, current, actor);
      }
      if (updates.status === 'completed' && !restoring) {
        const effectiveStatuses = updates.subtasks !== undefined
          ? updates.subtasks.map((subtask) => subtask.status || 'empty')
          : lockedCompletionStatuses ?? (await client.query('SELECT status FROM subtasks WHERE task_id = $1', [id])).rows.map((row) => row.status);
        if (!allSubtaskStatusesDone(effectiveStatuses)) {
          throw new ConflictFault('A task can be completed only when every subtask is completed or skipped');
        }
      }

      // Section 6.8 (E462 S4b, VM-N4): agents may PATCH to `review`; a `none`
      // Task has no one to judge it there, so the move is refused.
      if (updates.status === 'review' && current.status !== 'review' && current.verification_none === true) {
        throw new ConflictFault('A Task with verification none completes at finish and never enters Review', 'VERIFICATION_NONE_NO_REVIEW');
      }
      if (updates.status && updates.status !== current.status) {
        await lifecyclePolicyService.evaluate(client, {
          action: 'task.transition',
          subject: { kind: 'task', id, revision: current.updated_at ?? null },
          current: { status: current.status, archived: current.archived_at !== null },
          proposed: { status: updates.status, archived: updates.status === 'archived' },
        });
      }

      // Validate dependencies if being updated
      if (updates.dependsOn !== undefined) {
        await this.validateAndCheckCircular(id, updates.dependsOn, client);
      }

      // Track status transitions
      const statusUpdates: any = {};
      if (updates.status && updates.status !== current.status) {
        // Status moves preserve the task's autoStart setting (owner decision 2026-07-04):
        // arming auto-pickup is always an explicit action, never a side effect.
        if (updates.status === 'in-progress' && !current.started_at) {
          statusUpdates.started_at = now;
        }
        if (updates.status === 'completed' && !current.completed_at && !restoring) {
          statusUpdates.completed_at = now;
        }
        if (updates.status === 'archived' && !current.archived_at) {
          statusUpdates.archived_at = now;
        }
        // Archive disposition: recorded on every transition INTO archived,
        // cleared when a task is un-archived (so a later re-archive recomputes
        // it from the then-current state). Heuristic: completed at archive
        // time, or all subtasks done → 'completed'; otherwise 'abandoned'.
        if (updates.status === 'archived' && oldStatus !== 'archived') {
          const subRes = await client.query(
            'SELECT status FROM subtasks WHERE task_id = $1',
            [id]
          );
          statusUpdates.archive_disposition = computeArchiveDisposition(oldStatus, subRes.rows);
          // Unified archive policy (task 7d2a60a6): optional reason is
          // appended to task notes so the "why" survives the archive.
          const reason = typeof updates.archiveReason === 'string' ? updates.archiveReason.trim() : '';
          if (reason) {
            const line = archiveReasonNote(statusUpdates.archive_disposition, reason);
            statusUpdates.notes = current.notes ? `${current.notes}\n${line}` : line;
          }
        }
        // Generic notes updates: persist when explicitly provided (the notes
        // column exists since migration 041; before that these were dropped).
        if (typeof updates.notes === 'string' && statusUpdates.notes === undefined) {
          statusUpdates.notes = updates.notes;
        }
 else if (oldStatus === 'archived' && updates.status !== 'archived') {
          statusUpdates.archive_disposition = null;
          if (restoring) statusUpdates.archived_at = null;
        }
      }

      // Build update query
      const fields: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      const addField = (column: string, value: any) => {
        fields.push(`${column} = $${paramIndex++}`);
        params.push(value);
      };

      if (updates.title !== undefined) addField('title', updates.title);
      if (updates.description !== undefined) addField('description', updates.description);
      if (updates.status !== undefined) addField('status', updates.status);
      if (updates.priority !== undefined) addField('priority', updates.priority);
      if (updates.project !== undefined) {
        addField('project_id', await this.decideProjectTarget(updates.project, projectTarget, client));
      }
      if (updates.thinking !== undefined) addField('thinking_budget', updates.thinking);
      if (updates.thinkingAutoEstimated !== undefined) addField('thinking_auto_estimated', updates.thinkingAutoEstimated);
      if (updates.model !== undefined) addField('model', updates.model);
      if (updates.executionMode !== undefined) addField('execution_mode', updates.executionMode);
      if ((updates as any).executionProfile !== undefined) addField('execution_profile', (updates as any).executionProfile ? JSON.stringify((updates as any).executionProfile) : null);
      if ((updates as any).executionServiceId !== undefined) addField('execution_service_id', (updates as any).executionServiceId);
      // The Warrant pointer requires an assignee (migration 099). A full
      // unassignment must clear both columns in this one statement; the
      // vehicle swap below then revokes its links in the same transaction.
      if ((updates as any).executionServiceId === null) addField('execution_warrant_id', null);
      if ((updates as any).executionDescriptorVersion !== undefined) addField('execution_descriptor_version', (updates as any).executionDescriptorVersion);
      if (updates.reviewHistory !== undefined) addField('review_history', updates.reviewHistory !== null ? JSON.stringify(updates.reviewHistory) : null);
      if (updates.maxRetries !== undefined) addField('max_retries', updates.maxRetries);
      if (updates.needsReview !== undefined) addField('needs_review', updates.needsReview);
      if ((updates as any).definitionOfDone !== undefined) addField('definition_of_done', (updates as any).definitionOfDone !== null ? JSON.stringify((updates as any).definitionOfDone) : null);
      if ((updates as any).constraints !== undefined) addField('constraints', (updates as any).constraints !== null ? JSON.stringify((updates as any).constraints) : null);
      if (updates.autoStart !== undefined) addField('auto_start', updates.autoStart);
      if (updates.blockedReason !== undefined) addField('blocked_reason', updates.blockedReason);
      if (updates.notes !== undefined && statusUpdates.notes === undefined) addField('notes', updates.notes);
      if (updates.dueAt !== undefined) addField('due_at', updates.dueAt);
      if (updates.discordThreadId !== undefined) addField('discord_thread_id', updates.discordThreadId || null);
      if (updates.attemptCount !== undefined) addField('attempt_count', updates.attemptCount);
      if (updates.parentId !== undefined) addField('parent_id', updates.parentId);
      // Phase membership (079). Consistency with the task's Project is a
      // DATABASE fact (composite FK + CHECK), so a caller cannot move a task
      // to another Project while leaving a stale Phase behind: the write is
      // refused and translated to a typed 409, never silently repaired.
      if (updates.phaseId !== undefined) addField('phase_id', updates.phaseId || null);
      if ((updates as any).personalityId !== undefined) addField('personality_id', (updates as any).personalityId || null);
      if (statusUpdates.started_at) addField('started_at', statusUpdates.started_at);
      if (statusUpdates.completed_at) addField('completed_at', statusUpdates.completed_at);
      if (statusUpdates.archived_at !== undefined) addField('archived_at', statusUpdates.archived_at);
      if (statusUpdates.archive_disposition !== undefined) addField('archive_disposition', statusUpdates.archive_disposition);
      if (statusUpdates.notes !== undefined) addField('notes', statusUpdates.notes);

      // Always update updated_at
      addField('updated_at', now);

      if (fields.length > 0) {
        params.push(id);
        await client.query(
          `UPDATE tasks SET ${fields.join(', ')} WHERE id = $${paramIndex}`,
          params
        );
      }

      // Update subtasks if provided
      if (updates.subtasks !== undefined) {
        await client.query(
          'SET CONSTRAINTS task_attempt_links_task_id_subtask_index_fkey, task_attempt_ownership_task_id_subtask_index_fkey DEFERRED',
        );
        const existingSubtasks = await client.query(
          'SELECT id FROM subtasks WHERE task_id = $1 FOR UPDATE',
          [id],
        );
        const existingIds = new Set(existingSubtasks.rows.map((row) => String(row.id)));
        const retainedIds = new Set<string>();

        // Vacate display positions first so swaps/reorders do not collide with
        // UNIQUE(task_id,index). Compatibility triggers carry canonical
        // attempt links through the temporary position and back to the final
        // one by stable Subtask id.
        //
        // 36071c86: the offset must clear the INCOMING index range too, not
        // only the existing one. A replacement array LONGER than the current
        // set inserts brand-new rows at final indexes up to length-1, and an
        // offset of only MAX(index)+1 parks the vacated rows exactly there:
        // three rows vacated to 3,4,5 collide with a four-element
        // replacement's insert at index 3 — the live 500 this card was filed
        // for. GREATEST over both ranges leaves the parked rows no meeting
        // point with any final index, and the shift itself stays transiently
        // safe because every parked index remains above the old range.
        await client.query(
          `UPDATE subtasks
              SET index = index + GREATEST(
                (
                  SELECT COALESCE(MAX(current_subtask.index), -1) + 1
                    FROM subtasks current_subtask
                   WHERE current_subtask.task_id = $1
                ),
                $2::int
              )
            WHERE task_id = $1`,
          [id, updates.subtasks.length],
        );

        for (let i = 0; i < updates.subtasks.length; i++) {
          const s = updates.subtasks[i];
          const stableId = s.id !== undefined ? String(s.id) : '';
          if (stableId && existingIds.has(stableId)) {
            if (retainedIds.has(stableId)) throw new Error(`Duplicate Subtask id in update: ${stableId}`);
            retainedIds.add(stableId);
            await client.query(
              `UPDATE subtasks
                  SET index = $3, title = $4, status = $5, note = $6, completed_at = $7
                WHERE task_id = $1 AND id = $2`,
              [id, stableId, i, s.text, s.status || 'empty', s.reviewNote || null, s.completedAt || null],
            );
          } else {
            if (stableId) throw new Error(`Subtask id does not belong to this Task: ${stableId}`);
            const inserted = await client.query(
              `INSERT INTO subtasks (task_id, index, title, status, note, completed_at)
               VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
              [id, i, s.text, s.status || 'empty', s.reviewNote || null, s.completedAt || null],
            );
            retainedIds.add(String(inserted.rows[0].id));
          }
        }
        const removedIds = [...existingIds].filter((subtaskId) => !retainedIds.has(subtaskId));
        if (removedIds.length > 0) {
          await client.query('DELETE FROM subtasks WHERE task_id = $1 AND id = ANY($2::int[])', [id, removedIds]);
        }
      }

      // Update tags if provided
      if (updates.tags !== undefined) {
        await client.query('DELETE FROM task_tags WHERE task_id = $1', [id]);
        for (const tag of updates.tags) {
          await client.query(
            `INSERT INTO task_tags (task_id, tag) VALUES ($1, $2)`,
            [id, tag]
          );
        }
      }

      // Update dependencies if provided
      if (updates.dependsOn !== undefined) {
        await client.query('DELETE FROM task_dependencies WHERE task_id = $1', [id]);
        for (const depId of updates.dependsOn) {
          await client.query(
            `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)`,
            [id, depId]
          );
        }
        // RH-P3.AZ-S7 (ruling 7440b579 R2(b)): an auto-grant vehicle is
        // "recomputed in the SAME transaction as any link edit while
        // assigned" — dependency parents are part of the D5 reference set,
        // so the vehicle follows the edit rather than drifting from it.
        // The EDITOR's own authority caps what it may confer (bedc25f3 B2).
        await accessVehicleService.recompute(client, id, taskAuditActor(actor), linkerAuthorizationFor(actor));
      }

      // Update links if provided
      if (updates.links !== undefined) {
        await client.query('DELETE FROM task_links WHERE task_id = $1', [id]);
        for (const link of updates.links) {
          await client.query(
            `INSERT INTO task_links (task_id, type, title, url) VALUES ($1, $2, $3, $4)`,
            [id, link.type, link.title, link.url]
          );
        }
      }

      if (updates.autoStart === true && current.auto_start !== true) {
        await auditService.record({
          action: 'task.arm',
          actor: taskAuditActor(actor),
          resourceType: 'task',
          resourceId: id,
          metadata: { source: 'update' },
        }, client);
      }
      if (updates.status && updates.status !== oldStatus && actor?.role === 'orchestrator') {
        await auditService.record({
          action: 'task.lifecycle_override.status',
          actor: taskAuditActor(actor),
          resourceType: 'task',
          resourceId: id,
          metadata: { from: oldStatus, to: updates.status },
        }, client);
      }

      // ── RH-P3.AZ-S7: the assignment-access coupling (ruling 7440b579) ──
      //
      // Four transitions matter, all in THIS transaction:
      //   1. the assignment changes -> reap the old vehicle, attach the new
      //      one, and refuse (rolling the update back) if the assignee chain
      //      still could not read the task (R1);
      //   2. the task goes TERMINAL -> the vehicle is reaped (R2(b): "reaped
      //      at task-terminal or unassignment");
      //   3. the task REOPENS -> a dead warrant vehicle returns it
      //      UNASSIGNED (R4); an auto-grant vehicle is simply re-attached;
      //   4. neither -> nothing happens to the vehicle here.
      const TERMINAL_TASK_STATUSES = ['completed', 'archived'];
      const vehicleAuditActor = taskAuditActor(actor);
      const oldAssignment = current.execution_service_id ? String(current.execution_service_id) : null;
      const assignmentInPayload = (updates as any).executionServiceId !== undefined;
      const newAssignment = assignmentInPayload
        ? ((updates as any).executionServiceId ? String((updates as any).executionServiceId) : null)
        : oldAssignment;
      // Review bedc25f3 B4: the VEHICLE can change while the assignee does
      // not — auto-grant → Warrant, Warrant A → Warrant B, Warrant →
      // auto-grant are all real transitions, and the route accepts every
      // one of them. Dropping them silently let a caller believe a vehicle
      // change had happened when nothing had moved. At the route each needs
      // services:invoke: the first two through the executionProfile they ride
      // with, the third through the Warrant-drop gate (card 69943b61).
      const oldWarrant = current.execution_warrant_id ? String(current.execution_warrant_id) : null;
      const warrantInPayload = (updates as any).executionWarrantId !== undefined;
      const newWarrant = warrantInPayload
        ? ((updates as any).executionWarrantId ? String((updates as any).executionWarrantId) : null)
        : oldWarrant;
      const wasTerminal = TERMINAL_TASK_STATUSES.includes(String(oldStatus));
      const isTerminal = updates.status !== undefined
        ? TERMINAL_TASK_STATUSES.includes(String(updates.status))
        : wasTerminal;

      const vehicleChanged = (assignmentInPayload && newAssignment !== oldAssignment)
        || (warrantInPayload && newWarrant !== oldWarrant);
      let detachAtTerminal = false;

      // AZ-A10 clause 6: the assigning act's date. It is read from the
      // out-of-band key only `resolveExecutionProfileWrite` sets, after the
      // act's services:invoke gate and beside a non-null executionProfile —
      // never from a body field — so its presence here means this PATCH
      // performs an execution assignment (E62: whoever performs it may set
      // it). A task that is or becomes terminal holds no rows to date —
      // clause 7 reaps them — so the date is refused rather than dropped.
      const roleGrantExpiry = assigningActExpiry(updates);
      if (roleGrantExpiry !== undefined && isTerminal) {
        throw new AssignmentAccessError(409, 'ROLE_GRANT_EXPIRY_TASK_TERMINAL',
          'a completed or archived task holds no assignment grant rows for roleGrantExpiresAt to date (AZ-A10 clause 7 '
          + 'reaps them at the terminal state): reopen the task with the date, or omit the field',
          ROLE_GRANT_EXPIRY_FIELD);
      }

      if (vehicleChanged) {
        await this.swapExecutionVehicle(client, {
          taskId: id,
          serviceId: newAssignment,
          warrantId: newWarrant,
          attach: !isTerminal,
          actor,
          reason: 'AZ-S7: the execution assignment changed',
          roleGrantExpiry,
        });
      } else if (roleGrantExpiry !== undefined && newAssignment && !wasTerminal) {
        // The SAME assignee, re-asserted with a date (E62 "shortenable"
        // reaches an existing assignment only this way): the rows stay and
        // take the new date; nothing is detached or re-created.
        await accessVehicleService.redate(client, {
          taskId: id, serviceId: newAssignment, roleGrantExpiry, actor: vehicleAuditActor,
        });
      } else if (!wasTerminal && isTerminal) {
        // R2(b): reaped at task-terminal. The assignment itself stays — a
        // completed task keeps its record of who executed it. The detach runs
        // in the shared terminal helper below (E462 S4b, VM-B4).
        detachAtTerminal = true;
      } else if (wasTerminal && !isTerminal && newAssignment) {
        // R4: "A reopened task whose vehicle is dead returns UNASSIGNED."
        const carriedWarrant = current.execution_warrant_id ? String(current.execution_warrant_id) : null;
        let warrantStillLive = false;
        if (carriedWarrant) {
          const live = await client.query(
            `SELECT 1 FROM warrants WHERE id = $1 AND status = 'active'
              AND (expires_at IS NULL OR expires_at > NOW())`,
            [carriedWarrant],
          );
          warrantStillLive = live.rows.length > 0;
        }
        if (carriedWarrant && !warrantStillLive) {
          await client.query(
            `UPDATE tasks SET execution_service_id = NULL, execution_profile = NULL,
                    execution_descriptor_version = NULL, execution_warrant_id = NULL
              WHERE id = $1`,
            [id],
          );
          await auditService.record({
            action: 'task.execution_unassign', actor: vehicleAuditActor,
            resourceType: 'task', resourceId: id,
            metadata: { automatic: true, reason: 'AZ-S7: reopened while its carrying warrant was dead (ruling 7440b579 R4)', warrantId: carriedWarrant },
          }, client);
        } else {
          // AZ-A10 clause 7: "On reopen, NEW rows (new ids, new links) are
          // materialized for the current holders". A reopen is not itself a
          // dated act: the new rows take the default unless this same PATCH
          // re-asserts the assignment with a date.
          const attached = await this.attachExecutionVehicle(client, {
            taskId: id,
            serviceId: newAssignment,
            warrantId: carriedWarrant,
            actor,
            roleGrantExpiry,
          });
          if (attached.warrantId) {
            await client.query('UPDATE tasks SET execution_warrant_id = $1 WHERE id = $2', [attached.warrantId, id]);
          }
        }
      }

      // AZ-A9 clause 12a (ratified 2026-10-10 (E43), card 785e1eed; E15): the
      // grant rows a grant-kind Approval wrote for THIS task are revoked, the
      // credential a credential-kind Approval issued for it is revoked, and its
      // pending or approved-uncollected requests lapse TASK_TERMINAL, in this
      // transaction and after the vehicle detach above. Reopening restores nothing. PATCH, archive and
      // auto-archive all arrive here; the verifier's verdict is the other
      // terminal writer (TaskReviewAttemptService.recordVerdict).
      // The terminal effects are ONE helper, shared with a `none` Task's
      // finish (TaskTerminalEffects; E462 S4b, VM-B4).
      if (!wasTerminal && isTerminal) {
        await runTaskTerminalEffects(client, {
          taskId: id, to: String(updates.status) as 'completed' | 'archived', via: 'updateTask',
          actor: vehicleAuditActor, detachVehicle: detachAtTerminal,
        });
      }

      // RH-P3.C1: one task.updated per successful update (status in the
      // payload when it moved — moves ARE the lifecycle signal consumers key
      // on), plus the dedicated archived event the webhook taxonomy already
      // names. Same-transaction emission: the feed never reports an update
      // that rolled back.
      await feedEventService.emit(client, {
        name: 'task.updated',
        objectType: 'task',
        objectId: id,
        actorPrincipalId: (feedActor ?? actor)?.principalId ?? null, actorHandle: (feedActor ?? actor)?.handle ?? null,
        projectId: current.project_id ?? null,
        ownerPrincipalId: current.owner_principal_id ?? null,
        // Card 5854f0d6 (design section 4.2, choice C6): the field NAMES of
        // the applied update, sorted, beside the status move (the
        // TaskSuccessCriteriaService `fields` precedent). Names only, never a
        // value: the Timeline says WHAT changed and the pull carries the rest.
        payload: {
          ...(updates.status && updates.status !== oldStatus
            ? { status: updates.status, previousStatus: oldStatus }
            : {}),
          fields: appliedFieldNames(updates),
        },
      });
      if (updates.status === 'archived' && oldStatus !== 'archived') {
        await feedEventService.emit(client, {
          name: 'task.archived',
          objectType: 'task',
          objectId: id,
          actorPrincipalId: (feedActor ?? actor)?.principalId ?? null, actorHandle: (feedActor ?? actor)?.handle ?? null,
          projectId: current.project_id ?? null,
          ownerPrincipalId: current.owner_principal_id ?? null,
          payload: {},
        });
      }

      // RH-P3.C2: arming, status moves and dependency edits all cross the
      // readiness boundary for THIS task.
      // A status move is the one change that can make OTHER tasks ready:
      // nothing about a dependent's own row changes when its parent
      // completes, so without this fan-out an unblocked task would never
      // be announced. Run on any status change so regressions retract too.
      // A `none` Task's finish runs the same two (TaskElementService).
      await syncTaskReadiness(client, id, actor ?? null);
      if (updates.status && updates.status !== oldStatus) {
        await syncDependentsReadiness(client, id, actor ?? null);
      }

      // A containing setup transaction owns authoritative history and feed
      // writes; notifications are delivered only after its commit.
      //
      // The ISO fragment is the union with RH-FEAT-A: this in-transaction read
      // replaced a post-commit `getTask`, and every query that feeds
      // `hydrateTasks` has to append it or `readRowDueAt` throws rather than
      // echo a millisecond-truncated instant the caller never named.
      const updated = await client.query(
        `SELECT *${DUE_AT_ISO_RETURNING} FROM tasks WHERE id = $1`, [id]);
      if (!updated.rows[0]) throw new NotFoundFault(`Task not found after update: ${id}`, 'TASK_NOT_FOUND');
      const task = await this.hydrateTask(updated.rows[0], client);
      const writtenNotes = statusUpdates.notes !== undefined ? statusUpdates.notes : updates.notes;
      const history = async (historyClient?: PoolClient) => {
        if (updates.status && updates.status !== oldStatus) await taskHistoryService.recordChange(task.id, task.title,
          'status', oldStatus, task.status, actor?.handle || 'user', actor?.principalId ?? null, historyClient);
        if (updates.priority && updates.priority !== oldPriority) await taskHistoryService.recordChange(task.id, task.title,
          'priority', oldPriority, task.priority, actor?.handle || 'user', actor?.principalId ?? null, historyClient);
        if (writtenNotes !== undefined && writtenNotes !== oldNotes) await taskHistoryService.recordChange(task.id, task.title,
          'notes', null, null, actor?.handle || 'user', actor?.principalId ?? null, historyClient);
      };
      await history(client);
      if (!transaction) await client.query('COMMIT');
      // The status move's notification IS the feed row written above (card
      // 5854f0d6, choice C10: the legacy file writer is removed).
      const notify = async () => {
        this.emit('task.updated', task);
      };
      if (transaction) transaction.afterCommit(notify); else await notify();
      return task;

    } catch (err) {
      if (!transaction) await client.query('ROLLBACK');
      logCaughtFailure('[TaskManagerDB] Error updating task:', err);
      throw err;
    } finally {
      if (!transaction) client.release();
    }
  }

  /**
   * Delete a task (CASCADE handles related tables)
   */
  /**
   * RH-P3.AZ-S7: deleting a task drops its vehicle links by FK cascade,
   * which would leave the grants those links owned behind as orphans. The
   * vehicle is therefore reaped explicitly first, in the deleting
   * transaction, under the same created_by_vehicle rule as every other
   * reap (owner default D4).
   */
  async deleteTask(id: string): Promise<{ success: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockDependencyGraph(client);
      const current = await client.query(
        'SELECT id, status, updated_at, project_id, owner_principal_id FROM tasks WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!current.rows[0]) {
        throw new NotFoundFault(`Task not found: ${id}`, 'TASK_NOT_FOUND');
      }
      await lifecyclePolicyService.evaluate(client, {
        action: 'task.delete',
        subject: { kind: 'task', id, revision: current.rows[0].updated_at ?? null },
        current: { status: current.rows[0].status },
        proposed: null,
      });
      // RH-P3.C1: the content-free deletion tombstone, emitted in the same
      // transaction as the delete. The event row keeps the emission-time
      // ownership metadata precisely because the object row is about to be
      // gone — that metadata is what authorizes tombstone delivery later.
      await feedEventService.emit(client, {
        name: 'task.deleted',
        objectType: 'task',
        objectId: id,
        projectId: current.rows[0].project_id ?? null,
        ownerPrincipalId: current.rows[0].owner_principal_id ?? null,
        payload: {},
      });
      // RH-P3.AZ-S7: reap the access vehicle BEFORE the cascade takes its
      // link rows, or the grants those links owned survive as orphans.
      await accessVehicleService.detach(client, id, { handle: 'system', authMethod: 'system' },
        'AZ-S7: the assigned task was deleted');
      // AZ-A9 clause 12a: a deleted task is terminal for its grant requests
      // too, and this runs BEFORE the delete — approvals.related_task_id is
      // ON DELETE SET NULL, which would otherwise detach the request from the
      // rows it wrote.
      await reapAccessRequestsAtTerminal(client, { type: 'task', id, to: 'deleted', via: 'deleteTask' },
        { handle: 'system', authMethod: 'system' });
      // CASCADE in schema handles subtasks, tags, deps, links.
      await client.query('DELETE FROM tasks WHERE id = $1', [id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    this.emit('task.deleted', id);

    console.log('[TaskManagerDB] Deleted task:', id);
    return { success: true };
  }

  /**
   * Move task to a new status
   */
  async moveTask(id: string, status: TaskStatus, actor?: TaskActor): Promise<Task> {
    return this.updateTask(id, { status }, actor);
  }

  /** Check current archive authority under the Task lock before a no-op receipt. */
  private async authorizedArchivedTask(id: string, actor: TaskActor): Promise<Task | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT status FROM tasks WHERE id = $1 FOR UPDATE', [id]);
      if (!current.rows.length) throw new NotFoundFault(`Task not found: ${id}`, 'TASK_NOT_FOUND');
      if (current.rows[0].status !== 'archived') {
        await client.query('COMMIT');
        return undefined;
      }
      // A no-op still discloses the Task and archive result. Repeat the same
      // current authority decision as an archive write, without an act audit.
      await assertHumanTaskArchiveAuthority(client, id, actor, false);
      const task = await this.getTask(id, client);
      await client.query('COMMIT');
      return task;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Archive a task from ANY status (unified archive policy, task 7d2a60a6).
   * Same semantics as PATCH status->archived: the optional reason is appended
   * to notes, and unfinished work receives a warning. An authorized repeat
   * preserves its disposition and ignores a new reason.
   */
  async archiveTask(
    id: string,
    options: { reason?: string; suppressBoardEmit?: boolean } = {},
    actor?: TaskActor,
    archiveOperation?: typeof ARCHIVE_COMPLETED
  ): Promise<{
    success: boolean;
    archived: boolean;
    disposition: ArchiveDisposition | null;
    warning?: string;
    task: Task;
  }> {
    let task = await this.getTask(id);
    if (!task) {
      throw new NotFoundFault(`Task not found: ${id}`, 'TASK_NOT_FOUND');
    }

    if (task.status === 'archived') {
      const archived = actor ? await this.authorizedArchivedTask(id, actor) : task;
      if (archived) {
        return { success: true, archived: true, disposition: archived.archiveDisposition ?? null, task: archived };
      }
      // The Task changed while the no-op acquired its lock. Rejoin the normal
      // archive path, which locks and checks authority again before mutation.
      task = await this.getTask(id);
      if (!task) throw new NotFoundFault(`Task not found: ${id}`, 'TASK_NOT_FOUND');
    }
    const oldStatus = task.status;

    const updated = await this.updateTask(id, {
      status: 'archived' as TaskStatus,
      archiveReason: options.reason,
    }, actor, undefined, undefined, undefined, archiveOperation);
    const disposition = (updated.archiveDisposition ?? 'abandoned') as ArchiveDisposition;

    this.emit('task.archived', id);
    // Bulk archive emits the board refresh ONCE at the end instead of per
    // Task (design 986be411 §4); every other side effect stays per-Task.
    if (!options.suppressBoardEmit) {
      this.emit('tasks.updated', await this.getAllTasks());
    }

    console.log('[TaskManagerDB] Archived task:', id, `(disposition: ${disposition})`);
    const warning = archiveWarningForStatus(oldStatus, disposition);
    return {
      success: true,
      archived: true,
      disposition,
      ...(warning ? { warning } : {}),
      task: updated,
    };
  }

  /**
   * Unarchive target derivation (design 986be411 §4, owner ruling E5): the
   * status the Task held at archive time, read from the newest
   * status→archived history row; fallback 'completed' where history cannot
   * resolve it (imported/legacy rows without a recorded transition).
   */
  async getUnarchiveTarget(id: string): Promise<{ target: TaskStatus; derivedFrom: 'history' | 'fallback' }> {
    const FALLBACK = { target: 'completed' as TaskStatus, derivedFrom: 'fallback' as const };
    // The six non-archived states are the ONLY restorable targets — an
    // enumerated set, never whatever string the history row happens to carry.
    const RESTORABLE: string[] = ['ideas', 'todo', 'in-progress', 'review', 'stuck', 'completed'];
    try {
      // The history service owns the schema variants (field vs event_type) —
      // a query pinned to one variant silently degrades every unarchive to
      // the fallback on the other (found live on DEV, this candidate's QA).
      const prior = await taskHistoryService.priorStatusBeforeArchive(id);
      if (typeof prior === 'string' && RESTORABLE.includes(prior)) {
        return { target: prior as TaskStatus, derivedFrom: 'history' };
      }
      return FALLBACK;
    } catch (err) {
      logCaughtWarning('[TaskManagerDB] unarchive target derivation failed; falling back to completed:', err);
      return FALLBACK;
    }
  }

  /**
   * Unarchive to the prior state (design 986be411 §4, E5; resolves 7092b73d).
   * Refuses non-archived Tasks. The status write funnels through updateTask,
   * which clears the archive disposition and records history, so unarchive
   * carries the same audit trail as any status change.
   */
  async unarchiveTask(
    id: string,
    actor?: TaskActor
  ): Promise<{ success: boolean; task: Task; restoredTo: TaskStatus; derivedFrom: 'history' | 'fallback' }> {
    if (actor?.authorization) {
      const task = await this.updateTask(id, {}, actor, undefined, undefined, undefined, RESTORE_ARCHIVE);
      return { success: true, task, restoredTo: task.status, derivedFrom: 'history' };
    }
    const task = await this.getTask(id);
    if (!task) {
      throw new TaskNotFoundError(id);
    }
    if (task.status !== 'archived') {
      throw new TaskNotArchivedError(id);
    }
    const { target, derivedFrom } = await this.getUnarchiveTarget(id);
    const updated = await this.updateTask(id, { status: target }, actor);
    return { success: true, task: updated, restoredTo: target, derivedFrom };
  }

  /**
   * Bulk archive of COMPLETED Tasks by explicit id list (design 986be411 §4,
   * E3). Per-Task results — nothing is silently skipped: a missing Task, an
   * already-archived Task and a non-completed Task each report their own
   * code. Per-Task side effects (history, notes, notifications,
   * task.archived) are archiveTask's, unchanged; the board refresh emits
   * once at the end.
   */
  async bulkArchiveCompleted(
    ids: string[],
    options: { reason?: string } = {},
    actor?: TaskActor
  ): Promise<{
    results: Array<{ id: string; archived: boolean; code: string; error?: string; warning?: string; errorId?: string }>;
    archivedCount: number;
    failedCount: number;
  }> {
    const results: Array<{ id: string; archived: boolean; code: string; error?: string; warning?: string; errorId?: string }> = [];
    for (const id of ids) {
      try {
        let task = await this.getTask(id);
        if (!task) {
          results.push({ id, archived: false, code: 'NOT_FOUND', error: 'Task not found' });
          continue;
        }
        if (task.status === 'archived') {
          const archived = actor ? await this.authorizedArchivedTask(id, actor) : task;
          if (archived) {
            results.push({ id, archived: true, code: 'ALREADY_ARCHIVED' });
            continue;
          }
          task = await this.getTask(id);
          if (!task) {
            results.push({ id, archived: false, code: 'NOT_FOUND', error: 'Task not found' });
            continue;
          }
        }
        if (task.status !== 'completed') {
          results.push({ id, archived: false, code: 'NOT_COMPLETED', error: `Task is ${task.status}, not completed` });
          continue;
        }
        const outcome = await this.archiveTask(id, { reason: options.reason, suppressBoardEmit: true }, actor, ARCHIVE_COMPLETED);
        results.push({ id, archived: true, code: 'ARCHIVED', ...(outcome.warning ? { warning: outcome.warning } : {}) });
      } catch (err) {
        // Safety floor (review f98d127b B1): the exception is logged
        // secret-safe; the per-Task result carries a FIXED message only.
        const errorId = logCaughtFailure('[TaskManagerDB] bulk archive failed for a task:', err);
        const failure = bulkArchiveFailure(err);
        results.push({ id, archived: false, ...failure, ...(failure.code === 'NOT_FOUND' ? {} : { errorId }) });
      }
    }
    this.emit('tasks.updated', await this.getAllTasks());
    const archivedCount = results.filter(r => r.archived).length;
    return { results, archivedCount, failedCount: results.length - archivedCount };
  }

  /**
   * IDs-only scope read (design 986be411 §4, candidate A2): the exact id set
   * a filtered scope resolves to, computed server-side with the SAME shared
   * WHERE builder the board uses — the bulk archive-completed confirm reads
   * its explicit id list here, never the loaded column window (the 6-item
   * ceiling this replaces; mechanism d8507677 §7). Order is irrelevant to an
   * id SET, so no ORDER BY.
   */
  async queryTaskIds(
    statuses: string[],
    baseFilters: Omit<TaskFilters, 'status' | 'statuses' | 'limit' | 'offset'> = {}
  ): Promise<string[]> {
    const filters: TaskFilters = {
      ...baseFilters,
      statuses,
      includeArchived: baseFilters.includeArchived ?? statuses.includes('archived'),
    };
    const { conditions, params, filterParamCount } = await this.buildTaskWhere(filters);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT t.id
       FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
       ${whereClause}`,
      params.slice(0, filterParamCount)
    );
    return result.rows.map((row: { id: string }) => String(row.id));
  }

  /**
   * One-query scope row read (design 986be411 §5, candidate A3): the compact
   * columns the aggregates and graph reads share, over the SAME WHERE builder
   * the board uses. ONE query regardless of scope size — the N+1-free
   * property both endpoints inherit (the dependency-hydrating /tasks list
   * path is exactly what this exists to avoid).
   */
  async queryScopeRows(
    statuses: string[],
    baseFilters: Omit<TaskFilters, 'status' | 'statuses' | 'limit' | 'offset'> = {}
  ): Promise<Array<{
    id: string; title: string; status: string; priority: string;
    project: string | null; phaseId: string | null; updated: string;
    agent: string | null;
  }>> {
    const filters: TaskFilters = {
      ...baseFilters,
      statuses,
      includeArchived: baseFilters.includeArchived ?? statuses.includes('archived'),
    };
    const { conditions, params, filterParamCount } = await this.buildTaskWhere(filters);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query(
      // No canonical record assigns a display name to this Task. Keep the
      // graph's optional badge empty rather than inventing an actor identity.
      `SELECT t.id, t.title, t.status, t.priority, p.name AS project,
              t.phase_id, t.updated_at,
              NULL::text AS agent_name
       FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
       ${whereClause}`,
      params.slice(0, filterParamCount)
    );
    return result.rows.map((row: any) => ({
      id: String(row.id),
      title: String(row.title),
      status: String(row.status),
      priority: String(row.priority),
      project: row.project ?? null,
      phaseId: row.phase_id ?? null,
      updated: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      agent: row.agent_name ?? null,
    }));
  }

  /**
   * Subtask progress WITHIN an id set — one grouped query (card 5152e2ab,
   * design 77950a97 §3: the map tile is the board card, and the board card
   * shows progress). Bounded like the edge reads; short-circuits on empty.
   */
  async queryTaskProgress(ids: string[]): Promise<Array<{ taskId: string; done: number; total: number }>> {
    if (ids.length === 0) return [];
    const result = await this.pool.query(
      `SELECT task_id,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status IN ('completed', 'skipped'))::int AS done
       FROM subtasks
       WHERE task_id = ANY($1::uuid[])
       GROUP BY task_id`,
      [ids]
    );
    return result.rows.map((row: any) => ({
      taskId: String(row.task_id),
      done: Number(row.done ?? 0),
      total: Number(row.total ?? 0),
    }));
  }

  /**
   * Task ids WITHIN a set whose SUBTASKS changed since a moment — the delta
   * signal that tasks.updated_at cannot give.
   *
   * subtasks is its own table with its own updated_at and no trigger writing
   * back to tasks, so a subtask ticking over leaves the task row untouched.
   * That is precisely why progress needs its own delta channel (review
   * 51a17ab2 B3) — and why only THESE ids need one, rather than every task in
   * scope.
   */
  async queryProgressChangedSince(ids: string[], since: Date): Promise<string[]> {
    if (ids.length === 0) return [];
    const result = await this.pool.query(
      `SELECT task_id
       FROM subtasks
       WHERE task_id = ANY($1::uuid[])
       GROUP BY task_id
       HAVING MAX(updated_at) > $2`,
      [ids, since]
    );
    return result.rows.map((row: any) => String(row.task_id));
  }

  /**
   * Reports linked to tasks WITHIN an id set — one query (design 77950a97
   * §3 report pills). The CALLER authorizes every row: a Report is its own
   * resource with its own grants, so visibility is never inherited from the
   * task that cites it.
   */
  async queryLinkedReports(ids: string[]): Promise<Array<{ id: string; taskId: string; title: string }>> {
    if (ids.length === 0) return [];
    // The RATIFIED linkage (design 3cdf6e65 §4.2, card C1): task_ids
    // containment OR a task_references row of kind 'report'. Both arms, because
    // either alone silently drops half the citations — the same closed additive
    // filter GET /reports?taskId= applies, kept identical on purpose.
    //
    // It is deliberately many-valued: one Report cites SEVERAL Tasks, and §3
    // draws a dashed edge to each. One row per (report, task) pair, DISTINCT so
    // a report matching through BOTH arms is not counted twice.
    const result = await this.pool.query(
      `SELECT DISTINCT r.id, link.task_id, r.title, r.created_at
       FROM reports r
       JOIN LATERAL (
         SELECT unnest(r.task_ids)::uuid AS task_id
         UNION
         SELECT tr.task_id
         FROM task_references tr
         WHERE tr.kind = 'report' AND tr.target_id = r.id
       ) AS link ON TRUE
       WHERE link.task_id = ANY($1::uuid[])
         AND r.deleted_at IS NULL
       ORDER BY link.task_id, r.created_at DESC, r.id`,
      [ids]
    );
    return result.rows.map((row: any) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      title: String(row.title ?? ''),
    }));
  }

  /**
   * Phase identity WITHIN an id set — one query (card 8645e81c, design
   * 77950a97 §3). The Map's band chip renders the phase NAME and its goal
   * line; the graph node carries only `phaseId`, so without this the band
   * label degrades to a raw UUID fragment (census 7fa7e605 A13).
   *
   * Bounded by the id set exactly like the edge reads, and the CALLER still
   * authorizes every row: Phases carry an explicit `restricted_access`
   * policy (owner ruling 44ee41f2), so visibility is never inferred from a
   * Task the caller happens to see.
   */
  async queryPhaseSummaries(ids: string[]): Promise<Array<{
    id: string; name: string; goal: string | null; projectId: string; position: number;
  }>> {
    if (ids.length === 0) return [];
    const result = await this.pool.query(
      `SELECT id, name, goal, project_id, position
       FROM phases
       WHERE id = ANY($1::uuid[])
       ORDER BY project_id, position, created_at, id`,
      [ids]
    );
    return result.rows.map((row: any) => ({
      id: String(row.id),
      name: String(row.name),
      goal: row.goal ?? null,
      projectId: String(row.project_id),
      position: Number(row.position),
    }));
  }

  /**
   * Dependency edges WITHIN an id set — one query (candidate A3; the Map's
   * solid edges, seed 0ddaaf74). Both endpoints must be in the set: an edge
   * to an out-of-scope (or out-of-grant) Task would leak its existence.
   */
  async queryDependencyEdges(ids: string[]): Promise<Array<{ from: string; to: string }>> {
    if (ids.length === 0) return [];
    const result = await this.pool.query(
      `SELECT task_id, depends_on_task_id
       FROM task_dependencies
       WHERE task_id = ANY($1::uuid[]) AND depends_on_task_id = ANY($1::uuid[])`,
      [ids]
    );
    return result.rows.map((row: any) => ({ from: String(row.task_id), to: String(row.depends_on_task_id) }));
  }

  /**
   * Knowledge edges WITHIN an id set — one query (candidate A3; the Map's
   * dashed edges): task_references rows of kind 'task' whose target is also
   * in the set.
   */
  async queryKnowledgeEdges(ids: string[]): Promise<Array<{ from: string; to: string }>> {
    if (ids.length === 0) return [];
    const result = await this.pool.query(
      `SELECT task_id, target_id
       FROM task_references
       WHERE kind = 'task' AND task_id = ANY($1::uuid[]) AND target_id = ANY($1::uuid[])`,
      [ids]
    );
    return result.rows.map((row: any) => ({ from: String(row.task_id), to: String(row.target_id) }));
  }

  /**
   * Auto-pickup queue: tasks that are eligible for unattended orchestrator
   * pickup. Lifecycle gate — autoStart is honored ONLY for status 'todo'
   * (the queryTasks filter below), and only when explicitly true, and only
   * when the task is not blocked by dependencies. Sorted by priority, then
   * creation time (FIFO within a priority).
   */
  async getAutoStartQueue(): Promise<Task[]> {
    const todoTasks = await this.queryTasks({ status: 'todo' });

    const priorityOrder: Record<string, number> = {
      urgent: 0, high: 1, normal: 2, low: 3, someday: 4
    };

    // Filter out blocked tasks (async check against DB)
    const autoStartTasks: Task[] = [];
    for (const t of todoTasks) {
      if (t.autoStart === true) {
        const blocked = await this.isTaskBlocked(t.id);
        if (!blocked) {
          autoStartTasks.push(t);
        }
      }
    }

    autoStartTasks.sort((a, b) => {
      const pa = priorityOrder[a.priority] ?? 99;
      const pb = priorityOrder[b.priority] ?? 99;
      if (pa !== pb) return pa - pb;
      return new Date(a.created).getTime() - new Date(b.created).getTime();
    });

    return autoStartTasks;
  }

  /**
   * Get next task to work on (todo + autoStart + not blocked by dependencies)
   */
  async getNextTask(): Promise<Task | null> {
    const queue = await this.getAutoStartQueue();
    return queue[0] || null;
  }

  /**
   * Get the most recently updated in-progress task.
   *
   * "Current" is board state, not inferred runtime activity: the product does
   * not observe agent processes (strategy F11).
   */
  async getCurrentTask(): Promise<Task | null> {
    const result = await this.pool.query(
      `SELECT t.*, at.slug AS at_slug, at.name AS at_name, at.color AS at_color, at.category AS at_category${DUE_AT_ISO_SELECT}
       FROM tasks t
       LEFT JOIN personalities at ON at.id = t.personality_id
       WHERE t.status = $1
       ORDER BY t.updated_at DESC
       LIMIT 1`,
      ['in-progress'],
    );

    return result.rows[0] ? this.hydrateTask(result.rows[0]) : null;
  }

  // ============================================================
  // Subtask Status Management
  // ============================================================

  /**
   * Update subtask status with role-based permission enforcement
   * 
   * Agent permissions:
   *   - CAN set: in-progress, review, stuck
   *   - CANNOT set: completed, skipped, empty
   * 
   * Orchestrator permissions:
   *   - CAN set: any status
   */
  async updateSubtaskStatus(
    taskId: string,
    subtaskIndex: number,
    newStatus: SubtaskStatus,
    role: TaskAutomationRole = 'orchestrator',
    reviewNote?: string,
    blockedReason?: string,
    actor?: TaskActor,
    // Card 5854f0d6, round 2: the request principal of a route that keeps the
    // legacy role semantics (no authority actor); the feed row records it.
    feedActor?: FeedActorRef,
  ): Promise<Task> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new NotFoundFault(`Task not found: ${taskId}`, 'TASK_NOT_FOUND');
    }

    if (!task.subtasks || subtaskIndex < 0 || subtaskIndex >= task.subtasks.length) {
      throw new NotFoundFault(`Subtask not found at index ${subtaskIndex}`, 'SUBTASK_NOT_FOUND');
    }

    const subtask = task.subtasks[subtaskIndex];
    if (actor) {
      return this.updateSubtaskStatusById(taskId, String(subtask.id), newStatus, role, reviewNote, blockedReason, actor, false, feedActor);
    }
    const currentStatus = subtask.status;

    // Completion authority is enforced here, not only by HTTP routes, so
    // batch/whole-record/CLI/MCP/internal callers cannot bypass review authority.
    if (newStatus === 'completed' && role !== 'qa' && role !== 'reviewer') {
      throw new ForbiddenFault('Only an independent Verifier identity can complete a subtask');
    }
    if (newStatus === 'completed' && currentStatus !== 'review') {
      throw new Error(`A subtask can only be completed from review (current status: ${currentStatus})`);
    }

    // Permission checks for agents
    if (role === 'agent') {
      if (!AGENT_ALLOWED_STATUSES.includes(newStatus)) {
        throw new ForbiddenFault(`Agents cannot set subtask status to '${newStatus}'. Allowed: ${AGENT_ALLOWED_STATUSES.join(', ')}`);
      }
      // Agents cannot modify completed/skipped subtasks
      if (DONE_STATUSES.includes(currentStatus)) {
        throw new ForbiddenFault(`Cannot change status of ${currentStatus} subtasks`);
      }
      // Agents may report a stuck subtask but cannot resume it themselves.
      if (currentStatus === 'stuck' && newStatus !== 'stuck') {
        throw new ForbiddenFault('Cannot resume a stuck subtask. An independent Verifier or orchestrator must resolve it.');
      }
    }

    const now = new Date().toISOString();

    // Determine completed_at: set when status becomes completed, clear otherwise
    const completedAt = newStatus === 'completed' ? now : null;

    // Update in database. RH-P3.C1 (round 1, F2): a Subtask write is a Task
    // mutation as every consumer sees it, so the write, the parent bump, and
    // the task.updated emission commit or vanish together.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const parent = await client.query('SELECT status FROM tasks WHERE id = $1 FOR UPDATE', [taskId]);
      if (!parent.rows.length) throw new NotFoundFault(`Task not found: ${taskId}`, 'TASK_NOT_FOUND');
      const fresh = await client.query(
        'SELECT status, note FROM subtasks WHERE task_id = $1 AND index = $2 FOR UPDATE', [taskId, subtaskIndex]);
      if (!fresh.rows.length) throw new NotFoundFault(`Subtask not found at index ${subtaskIndex}`, 'SUBTASK_NOT_FOUND');
      assertTerminalTaskChildren(parent.rows[0].status, [newStatus]);
      assertSubtaskStatusTransition(role, fresh.rows[0].status as SubtaskStatus, newStatus);
      await client.query(
        `UPDATE subtasks
         SET status = $1, note = $2, blocked_reason = $3, completed_at = $4, updated_at = $5
         WHERE task_id = $6 AND index = $7`,
        [
          newStatus,
          reviewNote || fresh.rows[0].note || null,
          newStatus === 'stuck' ? (blockedReason || null) : null,
          completedAt,
          now,
          taskId,
          subtaskIndex
        ]
      );
      const bumped = await client.query(
        'UPDATE tasks SET updated_at = $1 WHERE id = $2 RETURNING project_id, owner_principal_id',
        [now, taskId]
      );
      await feedEventService.emit(client, {
        name: 'task.updated', objectType: 'task', objectId: taskId,
        // The legacy index path runs WITHOUT an authority actor (an actor goes
        // by id above); a route passes its request principal as feedActor.
        actorPrincipalId: feedActor?.principalId ?? null, actorHandle: feedActor?.handle ?? null,
        projectId: bumped.rows[0]?.project_id ?? null,
        // Card 5854f0d6: the field NAME this write changed, never its value.
        ownerPrincipalId: bumped.rows[0]?.owner_principal_id ?? null, payload: { fields: ['subtasks'] },
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const updatedTask = await this.getTask(taskId);
    if (!updatedTask) {
      throw new NotFoundFault(`Task not found after subtask update: ${taskId}`, 'TASK_NOT_FOUND');
    }

    this.emit('task.updated', updatedTask);

    console.log(`[TaskManagerDB] Subtask ${subtaskIndex} of task ${taskId} changed from '${currentStatus}' to '${newStatus}' by ${role}`);
    return updatedTask;
  }

  /**
   * Stable-id Subtask mutation. `subtasks.id` is the durable address; display
   * index remains available only through the one-release compatibility route.
   */
  async updateSubtaskStatusById(
    taskId: string,
    subtaskId: string,
    newStatus: SubtaskStatus,
    role: TaskAutomationRole = 'orchestrator',
    reviewNote?: string,
    blockedReason?: string,
    actor?: TaskActor,
    requireAccountControl = false,
    // Card 5854f0d6, round 2: the request principal of a route that keeps the
    // role semantics (no authority actor); the feed row records it.
    feedActor?: FeedActorRef,
  ): Promise<Task> {
    if (!isValidSubtaskId(subtaskId)) throw new InvalidRequestFault(SUBTASK_ID_ERROR, 'INVALID_SUBTASK_ID');
    const client = await this.pool.connect();
    let displayIndex = -1;
    let currentStatus: SubtaskStatus = 'empty';
    try {
      await client.query('BEGIN');
      const parent = await client.query('SELECT status FROM tasks WHERE id = $1 FOR UPDATE', [taskId]);
      if (!parent.rows.length) throw new NotFoundFault(`Task not found: ${taskId}`, 'TASK_NOT_FOUND');
      const rowResult = await client.query(
        `SELECT s.id, s.index, s.status, s.note
           FROM subtasks s
           JOIN tasks t ON t.id = s.task_id
          WHERE s.task_id = $1 AND s.id = $2
          FOR UPDATE OF s`,
        [taskId, subtaskId],
      );
      if (rowResult.rows.length === 0) {
        const taskExists = await client.query('SELECT 1 FROM tasks WHERE id = $1', [taskId]);
        if (taskExists.rows.length === 0) throw new NotFoundFault(`Task not found: ${taskId}`, 'TASK_NOT_FOUND');
        throw new NotFoundFault(`Subtask not found: ${subtaskId}`, 'SUBTASK_NOT_FOUND');
      }
      const subtask = rowResult.rows[0];
      displayIndex = Number(subtask.index);
      currentStatus = subtask.status as SubtaskStatus;

      assertTerminalTaskChildren(parent.rows[0].status, [newStatus]);
      const account = actor ? await taskAccountControl(client, taskId, actor) : null;
      if (requireAccountControl && !account) {
        throw new ForbiddenFault('Owner completion requires actual account-owner or appointed Main authority', 'ACCOUNT_CONTROL_REQUIRED');
      }
      if (account && actor) {
        await recordAccountTaskDisposition(client, taskId, actor, account, newStatus, subtaskId);
      } else {
        assertSubtaskStatusTransition(role, currentStatus, newStatus);
      }

      const now = new Date().toISOString();
      await client.query(
        `UPDATE subtasks
            SET status = $1, note = $2, blocked_reason = $3,
                completed_at = $4, updated_at = $5
          WHERE task_id = $6 AND id = $7`,
        [
          newStatus,
          reviewNote || subtask.note || null,
          newStatus === 'stuck' ? (blockedReason || null) : null,
          newStatus === 'completed' ? now : null,
          now,
          taskId,
          subtaskId,
        ],
      );
      const bumped = await client.query(
        'UPDATE tasks SET updated_at = $1 WHERE id = $2 RETURNING project_id, owner_principal_id',
        [now, taskId]
      );
      await feedEventService.emit(client, {
        name: 'task.updated', objectType: 'task', objectId: taskId,
        actorPrincipalId: (actor ?? feedActor)?.principalId ?? null, actorHandle: (actor ?? feedActor)?.handle ?? null,
        projectId: bumped.rows[0]?.project_id ?? null,
        // Card 5854f0d6: the field NAME this write changed, never its value.
        ownerPrincipalId: bumped.rows[0]?.owner_principal_id ?? null, payload: { fields: ['subtasks'] },
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const updatedTask = await this.getTask(taskId);
    if (!updatedTask) throw new NotFoundFault(`Task not found after subtask update: ${taskId}`, 'TASK_NOT_FOUND');
    this.emit('task.updated', updatedTask);
    console.log(`[TaskManagerDB] Subtask ${subtaskId} (display index ${displayIndex}) of task ${taskId} changed from '${currentStatus}' to '${newStatus}' by ${role}`);
    return updatedTask;
  }

  /*
   * Card 2bc7b303 (owner ruling E374): the Subtask structure verbs. Create,
   * reorder and text edit are the dedicated forms of what the dashboard does
   * through the generic whole-Task Subtask replacement, under the SAME lock
   * order as the stable-id status verb (the parent Task row, then its Subtask
   * rows), the same account-control disposition record and the same
   * task.updated emission. They never change an existing Subtask's id or
   * state; a new Subtask's id comes from the subtasks id sequence, as every
   * other Subtask's does. Authorization is the status verb's: the route's
   * point stage asks Task `write`, and a state other than empty on create
   * meets the same transition rule the status verb applies from empty.
   */
  private async lockSubtaskParent(client: PoolClient, taskId: string): Promise<{ status: string; rows: Array<{ id: string; index: number }> }> {
    const parent = await client.query('SELECT status FROM tasks WHERE id = $1 FOR UPDATE', [taskId]);
    if (!parent.rows.length) throw new NotFoundFault(`Task not found: ${taskId}`, 'TASK_NOT_FOUND');
    const rows = await client.query(
      'SELECT id, index FROM subtasks WHERE task_id = $1 ORDER BY index ASC FOR UPDATE', [taskId]);
    return {
      status: String(parent.rows[0].status),
      rows: rows.rows.map((row) => ({ id: String(row.id), index: Number(row.index) })),
    };
  }

  /** Give each listed Subtask its display index by stable id. The rows are
   *  parked above every old and new index first (the 36071c86 offset rule of
   *  the whole-Task replacement), so no intermediate state meets
   *  UNIQUE(task_id, index); attempt links follow through the compatibility
   *  triggers, with their FKs deferred to COMMIT exactly as there. */
  private async placeSubtasks(client: PoolClient, taskId: string, finalOrder: string[], finalLength: number): Promise<void> {
    await client.query(
      'SET CONSTRAINTS task_attempt_links_task_id_subtask_index_fkey, task_attempt_ownership_task_id_subtask_index_fkey DEFERRED',
    );
    await client.query(
      `UPDATE subtasks
          SET index = index + GREATEST(
            (
              SELECT COALESCE(MAX(current_subtask.index), -1) + 1
                FROM subtasks current_subtask
               WHERE current_subtask.task_id = $1
            ),
            $2::int
          )
        WHERE task_id = $1`,
      [taskId, finalLength],
    );
    for (let index = 0; index < finalOrder.length; index += 1) {
      await client.query('UPDATE subtasks SET index = $3 WHERE task_id = $1 AND id = $2', [taskId, finalOrder[index], index]);
    }
  }

  /** One Subtask structure write in its own transaction: the parent Task row
   *  and its Subtask rows are locked first, account control is read under that
   *  lock, the parent is bumped and task.updated is emitted with the write,
   *  then the in-process listeners hear it. */
  private async subtaskStructureWrite<T>(
    taskId: string,
    write: (client: PoolClient, parent: { status: string; rows: Array<{ id: string; index: number }> }, account: string | null) => Promise<T>,
    actor?: TaskActor,
  ): Promise<{ task: Task; result: T }> {
    const client = await this.pool.connect();
    let result: T;
    try {
      await client.query('BEGIN');
      const parent = await this.lockSubtaskParent(client, taskId);
      result = await write(client, parent, actor ? await taskAccountControl(client, taskId, actor) : null);
      const bumped = await client.query(
        'UPDATE tasks SET updated_at = $1 WHERE id = $2 RETURNING project_id, owner_principal_id',
        [new Date().toISOString(), taskId],
      );
      await feedEventService.emit(client, {
        name: 'task.updated', objectType: 'task', objectId: taskId,
        actorPrincipalId: actor?.principalId ?? null,
        actorHandle: actor?.handle ?? null,
        projectId: bumped.rows[0]?.project_id ?? null,
        // Card 5854f0d6: the field NAME this write changed, never its value.
        ownerPrincipalId: bumped.rows[0]?.owner_principal_id ?? null, payload: { fields: ['subtasks'] },
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const task = await this.getTask(taskId);
    if (!task) throw new NotFoundFault(`Task not found after subtask update: ${taskId}`, 'TASK_NOT_FOUND');
    this.emit('task.updated', task);
    return { task, result };
  }

  /** Add one Subtask at a 1-based position (default: append). Returns the new
   *  stable id and the position it took. */
  async createSubtask(
    taskId: string,
    input: { text: string; position?: number; status?: SubtaskStatus },
    role: TaskAutomationRole = 'orchestrator',
    actor?: TaskActor,
  ): Promise<{ task: Task; subtaskId: string; position: number }> {
    const status: SubtaskStatus = input.status ?? 'empty';
    const { task, result } = await this.subtaskStructureWrite(taskId, async (client, parent, account) => {
      const count = parent.rows.length;
      const position = input.position ?? count + 1;
      if (!Number.isInteger(position) || position < 1 || position > count + 1) {
        throw new InvalidRequestFault(
          `position must be an integer from 1 to ${count + 1} for this Task (it has ${count} Subtasks)`,
          'INVALID_SUBTASK_POSITION');
      }
      assertTerminalTaskChildren(parent.status, [status]);
      if (!account && status !== 'empty') {
        // The status verb's rule, applied from the empty state a new Subtask
        // starts in. Completion stays a Verifier act from review, so a
        // Verifier creating a completed Subtask is refused as a conflict.
        if (status === 'completed' && (role === 'qa' || role === 'reviewer')) {
          throw new ConflictFault('A Subtask is completed from review: create it in review, then complete it with the status verb', 'SUBTASK_COMPLETE_FROM_REVIEW');
        }
        assertSubtaskStatusTransition(role, 'empty', status);
      }
      if (position <= count) {
        const order = parent.rows.map((row) => row.id);
        await this.placeSubtasks(client, taskId, order, count + 1);
        // Free the requested position: rows at or after it move down by one,
        // last first, so each move lands on an index the previous one freed.
        for (let index = order.length - 1; index >= position - 1; index -= 1) {
          await client.query('UPDATE subtasks SET index = $3 WHERE task_id = $1 AND id = $2', [taskId, order[index], index + 1]);
        }
      }
      const now = new Date().toISOString();
      const inserted = await client.query(
        `INSERT INTO subtasks (task_id, index, title, status, note, completed_at, updated_at)
         VALUES ($1, $2, $3, $4, NULL, $5, $6) RETURNING id`,
        [taskId, position - 1, input.text, status, status === 'completed' ? now : null, now],
      );
      const subtaskId = String(inserted.rows[0].id);
      if (account && actor) await recordAccountTaskDisposition(client, taskId, actor, account, 'explicit-subtask-update', subtaskId);
      return { subtaskId, position };
    }, actor);
    return { task, ...result };
  }

  /** Put the Task's Subtasks in a new order. `order` must name every current
   *  Subtask id exactly once; ids, states and text are unchanged. */
  async reorderSubtasks(taskId: string, order: string[], actor?: TaskActor): Promise<Task> {
    const { task } = await this.subtaskStructureWrite(taskId, async (client, parent, account) => {
      const current = new Set(parent.rows.map((row) => row.id));
      const permutation = order.length === parent.rows.length && new Set(order).size === order.length
        && order.every((subtaskId) => current.has(subtaskId));
      if (!permutation) {
        throw new ConflictFault(
          `order must name every Subtask id of this Task exactly once (it has ${parent.rows.length}); re-read the Task and send its current ids`,
          'SUBTASK_ORDER_MISMATCH');
      }
      await this.placeSubtasks(client, taskId, order, order.length);
      if (account && actor) await recordAccountTaskDisposition(client, taskId, actor, account, 'explicit-subtask-update');
      return null;
    }, actor);
    return task;
  }

  /** Replace one Subtask's text by stable id; its id, position and state are unchanged. */
  async updateSubtaskText(taskId: string, subtaskId: string, text: string, actor?: TaskActor): Promise<Task> {
    if (!isValidSubtaskId(subtaskId)) throw new InvalidRequestFault(SUBTASK_ID_ERROR, 'INVALID_SUBTASK_ID');
    const { task } = await this.subtaskStructureWrite(taskId, async (client, parent, account) => {
      if (!parent.rows.some((row) => row.id === subtaskId)) {
        throw new NotFoundFault(`Subtask not found: ${subtaskId}`, 'SUBTASK_NOT_FOUND');
      }
      await client.query(
        'UPDATE subtasks SET title = $3, updated_at = $4 WHERE task_id = $1 AND id = $2',
        [taskId, subtaskId, text, new Date().toISOString()]);
      if (account && actor) await recordAccountTaskDisposition(client, taskId, actor, account, 'explicit-subtask-update', subtaskId);
      return null;
    }, actor);
    return task;
  }

  async markSubtaskInReview(taskId: string, subtaskIndex: number, reviewNote?: string): Promise<Task> {
    return this.updateSubtaskStatus(taskId, subtaskIndex, 'review', 'agent', reviewNote);
  }

  async markSubtaskInProgress(taskId: string, subtaskIndex: number): Promise<Task> {
    return this.updateSubtaskStatus(taskId, subtaskIndex, 'in-progress', 'agent');
  }

  async approveSubtask(taskId: string, subtaskIndex: number, feedActor?: FeedActorRef): Promise<Task> {
    return this.updateSubtaskStatus(taskId, subtaskIndex, 'completed', 'reviewer', undefined, undefined, undefined, feedActor);
  }

  async rejectSubtask(taskId: string, subtaskIndex: number, note?: string, feedActor?: FeedActorRef): Promise<Task> {
    const task = await this.updateSubtaskStatus(taskId, subtaskIndex, 'empty', 'orchestrator', undefined, undefined, undefined, feedActor);
    if (note && task.subtasks && task.subtasks[subtaskIndex]) {
      task.subtasks[subtaskIndex].reviewNote = `REJECTED: ${note}`;
      // RH-P3.C1 (round 1, F2): the rejection note is a second Task
      // mutation after the status write above; it announces itself too.
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'UPDATE subtasks SET note = $1 WHERE task_id = $2 AND index = $3',
          [`REJECTED: ${note}`, taskId, subtaskIndex]
        );
        const bumped = await client.query(
          'UPDATE tasks SET updated_at = NOW() WHERE id = $1 RETURNING project_id, owner_principal_id',
          [taskId]
        );
        await feedEventService.emit(client, {
          name: 'task.updated', objectType: 'task', objectId: taskId,
          actorPrincipalId: feedActor?.principalId ?? null, actorHandle: feedActor?.handle ?? null,
          projectId: bumped.rows[0]?.project_id ?? null,
          // Card 5854f0d6: the field NAME this write changed, never its value.
          ownerPrincipalId: bumped.rows[0]?.owner_principal_id ?? null, payload: { fields: ['subtasks'] },
        });
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    return task;
  }

  async blockSubtask(taskId: string, subtaskIndex: number, reason?: string): Promise<Task> {
    return this.updateSubtaskStatus(taskId, subtaskIndex, 'stuck', 'orchestrator', undefined, reason);
  }

  async skipSubtask(taskId: string, subtaskIndex: number, feedActor?: FeedActorRef): Promise<Task> {
    return this.updateSubtaskStatus(taskId, subtaskIndex, 'skipped', 'orchestrator', undefined, undefined, undefined, feedActor);
  }

  /** Apply one independent Verifier verdict to every subtask awaiting review. */
  async resolveReviewedSubtasks(
    taskId: string,
    outcome: 'accepted' | 'rejected' | 'stuck',
    note?: string,
  ): Promise<boolean> {
    const nextStatus: SubtaskStatus = outcome === 'accepted' ? 'completed' : outcome === 'rejected' ? 'empty' : 'stuck';
    const now = new Date().toISOString();
    const reviewNote = note ? `${outcome.toUpperCase()}: ${note}` : null;
    // RH-P3.C1 (round 1, F2): verdict application mutates the Task; the
    // writes and the task.updated emission commit together.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Same parent-before-child order as status/replacement writers. The
      // structured verdict's review-only outcome and authority stay intact.
      await client.query('SELECT status FROM tasks WHERE id = $1 FOR UPDATE', [taskId]);
      await client.query(
        `UPDATE subtasks
            SET status = $1::varchar,
                note = COALESCE($2, note),
                blocked_reason = CASE WHEN $1::varchar = 'stuck' THEN $2 ELSE NULL END,
                completed_at = CASE WHEN $1::varchar = 'completed' THEN $3::timestamptz ELSE NULL END,
                updated_at = $3::timestamptz
          WHERE task_id = $4 AND status = 'review'`,
        [nextStatus, reviewNote, now, taskId],
      );
      const bumped = await client.query(
        'UPDATE tasks SET updated_at = $1 WHERE id = $2 RETURNING project_id, owner_principal_id',
        [now, taskId]
      );
      await feedEventService.emit(client, {
        name: 'task.updated', objectType: 'task', objectId: taskId,
        projectId: bumped.rows[0]?.project_id ?? null,
        // Card 5854f0d6: the field NAME this write changed, never its value.
        // A board-applied verdict: no acting principal (TIMELINE_SYSTEM_EMITS).
        ownerPrincipalId: bumped.rows[0]?.owner_principal_id ?? null, payload: { fields: ['subtasks'] },
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return this.allSubtasksCompletedAsync(taskId);
  }

  /**
   * Complete a subtask (legacy method - uses orchestrator role)
   */
  async completeSubtask(taskId: string, subtaskIndex: number): Promise<Task> {
    return this.approveSubtask(taskId, subtaskIndex);
  }

  /**
   * Uncomplete a subtask (legacy method)
   */
  async uncompleteSubtask(taskId: string, subtaskIndex: number): Promise<Task> {
    return this.updateSubtaskStatus(taskId, subtaskIndex, 'empty', 'orchestrator');
  }

  allSubtasksCompleted(_id: string): boolean {
    // This is a sync method in the original, but we need async for DB
    // For now, throw error - callers should use async version
    throw new Error('Use allSubtasksCompletedAsync instead');
  }

  /**
   * Check if all subtasks are in a "done" state (completed or skipped)
   */
  async allSubtasksCompletedAsync(taskId: string): Promise<boolean> {
    const task = await this.getTask(taskId);
    if (!task || !task.subtasks || task.subtasks.length === 0) {
      return true;
    }
    return task.subtasks.every(s => DONE_STATUSES.includes(s.status));
  }

  /**
   * Check if any subtask is blocked
   */
  async hasBlockedSubtasks(taskId: string): Promise<boolean> {
    const task = await this.getTask(taskId);
    if (!task || !task.subtasks) {
      return false;
    }
    return task.subtasks.some(s => s.status === 'stuck');
  }

  getSubtaskSummary(_id: string): { total: number; empty: number; in_progress: number; review: number; stuck: number; skipped: number; completed: number } {
    // Sync method - throw error
    throw new Error('Use getSubtaskSummaryAsync instead');
  }

  async getSubtaskSummaryAsync(taskId: string): Promise<{ total: number; empty: number; in_progress: number; review: number; stuck: number; skipped: number; completed: number }> {
    const task = await this.getTask(taskId);
    if (!task || !task.subtasks) {
      return { total: 0, empty: 0, in_progress: 0, review: 0, stuck: 0, skipped: 0, completed: 0 };
    }
    return {
      total: task.subtasks.length,
      empty: task.subtasks.filter(s => s.status === 'empty').length,
      in_progress: task.subtasks.filter(s => s.status === 'in-progress').length,
      review: task.subtasks.filter(s => s.status === 'review').length,
      stuck: task.subtasks.filter(s => s.status === 'stuck').length,
      skipped: task.subtasks.filter(s => s.status === 'skipped').length,
      completed: task.subtasks.filter(s => s.status === 'completed').length,
    };
  }

  // ============================================================
  // Task Dependency Management
  // ============================================================

  /**
   * Referential integrity for dependsOn: every id must reference an existing
   * task (any status, archived included) and none may be the task itself.
   * Throws DependencyValidationError (mapped to HTTP 400 by the routes)
   * listing ALL offending ids, not just the first.
   */
  private async validateDependencies(dependsOn: string[] | undefined, currentTaskId?: string, client?: PoolClient): Promise<void> {
    if (!dependsOn || dependsOn.length === 0) return;

    const executor = client || this.pool;

    const canonicalCurrentId = currentTaskId && canonicalDependencyId(currentTaskId);
    const selfDeps = currentTaskId ? dependsOn.filter(depId => canonicalDependencyId(depId) === canonicalCurrentId) : [];
    if (selfDeps.length > 0) {
      throw new DependencyValidationError('SELF_DEPENDENCY', 'Task cannot depend on itself', selfDeps);
    }

    // Malformed ids can never reference a task, and would make the uuid cast
    // below throw a 22P02 (→ opaque 500) — treat them as unknown up front.
    const malformed = dependsOn.filter(depId => typeof depId !== 'string' || depId.length !== 36 || !UUID_RE.test(depId));
    const candidates = dependsOn.filter(depId => typeof depId === 'string' && depId.length === 36 && UUID_RE.test(depId));

    let missing: string[] = [...malformed];
    if (candidates.length > 0) {
      const result = await executor.query(
        'SELECT id FROM tasks WHERE id = ANY($1::uuid[])',
        [candidates.map(canonicalDependencyId)]
      );
      const found = new Set(result.rows.map((r: any) => r.id));
      missing = missing.concat(candidates.filter(depId => !found.has(canonicalDependencyId(depId))));
    }

    if (missing.length > 0) {
      throw new DependencyValidationError(
        'UNKNOWN_DEPENDENCY',
        `Unknown dependency task id(s): ${missing.join(', ')}`,
        missing
      );
    }
  }

  private async hasCircularDependency(taskId: string, depId: string, visited = new Set<string>(), client?: PoolClient): Promise<boolean> {
    taskId = canonicalDependencyId(taskId);
    depId = canonicalDependencyId(depId);
    // Walk the dependency chain from depId. If we ever reach taskId, adding
    // taskId→depId would create a cycle.  `visited` tracks depIds we've
    // already expanded so we don't loop on existing (non-taskId) cycles.
    if (visited.has(depId)) {
      return false; // already explored this node, no cycle found
    }
    
    visited.add(depId);
    const executor = client || this.pool;
    
    // Follow the dependency chain from depId: what does depId depend on?
    const result = await executor.query(
      'SELECT depends_on_task_id FROM task_dependencies WHERE task_id = $1',
      [depId]
    );
    
    for (const row of result.rows) {
      const nextDep = row.depends_on_task_id;
      if (nextDep === taskId) {
        return true; // cycle: depId depends on something that eventually reaches taskId
      }
      if (await this.hasCircularDependency(taskId, nextDep, visited, client)) {
        return true;
      }
    }
    
    return false;
  }

  private async validateAndCheckCircular(taskId: string, dependsOn: string[] | undefined, client?: PoolClient): Promise<void> {
    if (!dependsOn || dependsOn.length === 0) return;
    
    await this.validateDependencies(dependsOn, taskId, client);
    
    for (const depId of dependsOn) {
      if (await this.hasCircularDependency(taskId, depId, new Set(), client)) {
        throw new InvalidRequestFault(`Circular dependency detected: ${taskId} -> ${depId}`, 'CIRCULAR_DEPENDENCY');
      }
    }
  }

  /**
   * Dependency edges for a WHOLE result set, in TWO statements — the SET form
   * of `getBlockingTasks` + `getDependentTasks` + `isTaskBlocked`.
   *
   * 590e88cc. The point forms are correct and stay; what could not stay is
   * calling them once per row. `GET /tasks` ran all three per Task over the
   * unpaginated estate, and each one re-read a Task through `getTask` — one
   * statement for the row plus the four child-table statements `hydrateTasks`
   * issues — so a single request against the 5,200-Task fixture offered the
   * pool over nine thousand connection acquisitions. `max` is 20 and
   * `connectionTimeoutMillis` is 2000, so acquisitions past the first twenty
   * queue and the ones that wait longer than two seconds THROW. That is the
   * reported defect, and it is not confined to the request that causes it:
   * every other caller and every background job competes for the same twenty
   * connections while the flood drains.
   *
   * The count here is CONSTANT in the size of `taskIds`: two statements,
   * whatever the estate holds. Nothing is hydrated — a dependency edge needs
   * the id, the title and the two fields `dependencyBlocks` reads, and
   * hydrating a Task to reach four columns is what made the point form
   * expensive.
   *
   * `blocking` maps a Task id to the Tasks it DEPENDS ON that block it (the
   * same `dependencyBlocks` filter `getBlockingTasks` applies, applied here in
   * the caller so the unfiltered edge set stays available); `dependents` maps a
   * Task id to the Tasks that depend on IT, unfiltered, exactly as
   * `getDependentTasks` returns them.
   */
  async getDependencyEdgesForTasks(taskIds: string[]): Promise<{
    blocking: Map<string, DependencyEdge[]>;
    dependents: Map<string, DependencyEdge[]>;
  }> {
    const blocking = new Map<string, DependencyEdge[]>();
    const dependents = new Map<string, DependencyEdge[]>();
    if (taskIds.length === 0) return { blocking, dependents };

    const [blockingRes, dependentsRes] = await Promise.all([
      this.pool.query(
        `SELECT d.task_id AS holder_id, t.id, t.title, t.status, t.archive_disposition
           FROM task_dependencies d
           JOIN tasks t ON t.id = d.depends_on_task_id
          WHERE d.task_id = ANY($1::uuid[])`,
        [taskIds],
      ),
      this.pool.query(
        `SELECT d.depends_on_task_id AS holder_id, t.id, t.title, t.status, t.archive_disposition
           FROM task_dependencies d
           JOIN tasks t ON t.id = d.task_id
          WHERE d.depends_on_task_id = ANY($1::uuid[])`,
        [taskIds],
      ),
    ]);

    const collect = (rows: any[], into: Map<string, DependencyEdge[]>): void => {
      for (const row of rows) {
        const list = into.get(String(row.holder_id)) ?? [];
        list.push({
          id: String(row.id),
          title: String(row.title),
          status: String(row.status),
          archiveDisposition: row.archive_disposition ?? null,
        });
        into.set(String(row.holder_id), list);
      }
    };
    collect(blockingRes.rows, blocking);
    collect(dependentsRes.rows, dependents);
    return { blocking, dependents };
  }

  async getBlockingTasks(id: string): Promise<Task[]> {
    const task = await this.getTask(id);
    if (!task || !task.dependsOn || task.dependsOn.length === 0) {
      return [];
    }
    
    const blocking: Task[] = [];
    for (const depId of task.dependsOn) {
      const depTask = await this.getTask(depId);
      // Missing deps (deleted rows) are prevented by the foreign key and are
      // still surfaced by doctor if historical drift exists.
      if (depTask && dependencyBlocks(depTask.status, depTask.archiveDisposition)) {
        blocking.push(depTask);
      }
    }
    
    return blocking;
  }

  async getDependentTasks(id: string): Promise<Task[]> {
    const result = await this.pool.query(
      'SELECT task_id FROM task_dependencies WHERE depends_on_task_id = $1',
      [id]
    );
    
    const dependent: Task[] = [];
    for (const row of result.rows) {
      const task = await this.getTask(row.task_id);
      if (task) {
        dependent.push(task);
      }
    }
    
    return dependent;
  }

  /**
   * Get full dependency info for a task (both directions)
   */
  async getTaskDependencies(taskId: string): Promise<{ dependsOn: Task[]; blockedBy: Task[] }> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new NotFoundFault(`Task not found: ${taskId}`, 'TASK_NOT_FOUND');
    }

    // dependsOn: tasks this task depends on (all, regardless of status)
    const dependsOnTasks: Task[] = [];
    if (task.dependsOn && task.dependsOn.length > 0) {
      for (const depId of task.dependsOn) {
        const depTask = await this.getTask(depId);
        if (depTask) {
          dependsOnTasks.push(depTask);
        }
      }
    }

    // blockedBy: tasks that depend on this task (reverse direction)
    const dependentTasks = await this.getDependentTasks(taskId);

    return { dependsOn: dependsOnTasks, blockedBy: dependentTasks };
  }

  /**
   * Add a single dependency (taskId depends on dependsOnId)
   */
  async addDependency(taskId: string, dependsOnId: string, actor?: TaskActor, transaction?: CreationTransaction): Promise<void> {
    taskId = canonicalDependencyId(taskId);
    dependsOnId = canonicalDependencyId(dependsOnId);
    if (transaction && actor?.principalId !== transaction.actor.principalId) throw new Error('Creation actor mismatch');
    // RH-P3.C1 (round 1, F2): a dependency edge changes the Task's
    // readiness; the write and its task.updated emission commit together.
    const client = transaction?.client ?? await this.pool.connect();
    try {
      if (!transaction) await client.query('BEGIN');
      await lockDependencyGraph(client, transaction);
      // Validate the parent task exists (missing parent → 404 at the route)
      const task = await this.getTask(taskId, client);
      if (!task) throw new NotFoundFault(`Task not found: ${taskId}`, 'TASK_NOT_FOUND');

      // Referential integrity + self-reference (typed → 400 at the route)
      await this.validateDependencies([dependsOnId], taskId, client);

      // Check for circular dependency
      if (await this.hasCircularDependency(taskId, dependsOnId, new Set(), client)) {
        throw new InvalidRequestFault(`Circular dependency detected: ${taskId} -> ${dependsOnId}`, 'CIRCULAR_DEPENDENCY');
      }

      // Check if already exists
      const existing = await client.query(
        'SELECT 1 FROM task_dependencies WHERE task_id = $1 AND depends_on_task_id = $2',
        [taskId, dependsOnId]
      );
      if (existing.rows.length > 0) {
        throw new InvalidRequestFault(`Dependency already exists: ${taskId} -> ${dependsOnId}`, 'DEPENDENCY_EXISTS');
      }

      await client.query(
        'INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)',
        [taskId, dependsOnId]
      );
      // RH-P3.AZ-S7 (R2(b)): same-transaction vehicle recompute, capped at
      // the editor's own authority (bedc25f3 B2).
      await accessVehicleService.recompute(
        client, taskId, { principalId: actor?.principalId, handle: actor?.handle ?? 'system', authMethod: actor?.authMethod ?? 'unknown' }, linkerAuthorizationFor(actor));
      const bumped = await client.query(
        'UPDATE tasks SET updated_at = $1 WHERE id = $2 RETURNING project_id, owner_principal_id',
        [new Date().toISOString(), taskId]
      );
      await feedEventService.emit(client, {
        name: 'task.updated', objectType: 'task', objectId: taskId,
        actorPrincipalId: actor?.principalId ?? null,
        actorHandle: actor?.handle ?? null,
        projectId: bumped.rows[0]?.project_id ?? null,
        ownerPrincipalId: bumped.rows[0]?.owner_principal_id ?? null, payload: { fields: ['dependsOn'] },
      });
      // RH-P3.C2 (pre-review F3): adding or removing a dependency edge is a
      // readiness transition for THIS task — gaining an unmet parent must
      // retract a standing announcement, and removing the last unmet parent
      // must make one. Without this, the claim path accepts a task the board
      // never announced, or a stale announcement row swallows the next one.
      await syncTaskReadiness(client, taskId, actor ?? null);
      if (!transaction) await client.query('COMMIT');
    } catch (error) {
      if (!transaction) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (!transaction) client.release();
    }

    const announce = () => { console.log(`[TaskManagerDB] Added dependency: ${taskId} depends on ${dependsOnId}`); };
    if (transaction) transaction.afterCommit(announce); else announce();
  }

  /**
   * Remove a single dependency
   */
  async removeDependency(taskId: string, dependsOnId: string, actor?: TaskActor): Promise<void> {
    taskId = canonicalDependencyId(taskId);
    dependsOnId = canonicalDependencyId(dependsOnId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockDependencyGraph(client);
      const result = await client.query(
        'DELETE FROM task_dependencies WHERE task_id = $1 AND depends_on_task_id = $2',
        [taskId, dependsOnId]
      );
      if ((result.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        throw new NotFoundFault(`Dependency not found: ${taskId} -> ${dependsOnId}`, 'DEPENDENCY_NOT_FOUND');
      }
      // RH-P3.AZ-S7 (R2(b)): same-transaction vehicle recompute — the
      // dropped parent's read grant goes with the edge, under the same
      // refcount and created_by_vehicle rules. Removal works off the raw
      // reference set, so an editor cannot use this arm to strip access.
      await accessVehicleService.recompute(
        client, taskId, { handle: 'system', authMethod: 'system' }, linkerAuthorizationFor(actor));
      const bumped = await client.query(
        'UPDATE tasks SET updated_at = $1 WHERE id = $2 RETURNING project_id, owner_principal_id',
        [new Date().toISOString(), taskId]
      );
      await feedEventService.emit(client, {
        name: 'task.updated', objectType: 'task', objectId: taskId,
        actorPrincipalId: actor?.principalId ?? null,
        actorHandle: actor?.handle ?? null,
        projectId: bumped.rows[0]?.project_id ?? null,
        // Card 5854f0d6: the field NAME this write changed, never its value.
        ownerPrincipalId: bumped.rows[0]?.owner_principal_id ?? null, payload: { fields: ['dependsOn'] },
      });
      // RH-P3.C2 (pre-review F3): adding or removing a dependency edge is a
      // readiness transition for THIS task — gaining an unmet parent must
      // retract a standing announcement, and removing the last unmet parent
      // must make one. Without this, the claim path accepts a task the board
      // never announced, or a stale announcement row swallows the next one.
      await syncTaskReadiness(client, taskId, null);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    console.log(`[TaskManagerDB] Removed dependency: ${taskId} no longer depends on ${dependsOnId}`);
  }

  /**
   * Get all tasks that are blocked by unmet dependencies (for automation clients)
   */
  async getBlockedTasks(): Promise<Task[]> {
    // Find all tasks that have at least one semantically unsatisfied dependency.
    // NOTE: the WHERE clause below is the SQL mirror of dependencyBlocks() —
    // keep the two in sync (see the helper's doc comment for the semantics).
    const result = await this.pool.query(`
      SELECT DISTINCT td.task_id
      FROM task_dependencies td
      JOIN tasks dep ON dep.id = td.depends_on_task_id
      JOIN tasks t ON t.id = td.task_id
      WHERE NOT (
        dep.status = 'completed'
        OR (dep.status = 'archived' AND dep.archive_disposition = 'completed')
      )
        AND t.status NOT IN ('completed', 'archived')
    `);

    const blocked: Task[] = [];
    for (const row of result.rows) {
      const task = await this.getTask(row.task_id);
      if (task) {
        blocked.push(task);
      }
    }

    return blocked;
  }

  async isTaskBlocked(id: string): Promise<boolean> {
    const blocking = await this.getBlockingTasks(id);
    return blocking.length > 0;
  }

  /**
   * Auto-archive old completed tasks
   */
  async autoArchiveOldTasks(): Promise<number> {
    const ARCHIVE_AFTER_DAYS = 7;
    const cutoff = new Date(Date.now() - (ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000));

    const result = await this.pool.query(
      `SELECT id FROM tasks 
       WHERE status = 'completed' 
       AND completed_at < $1`,
      [cutoff.toISOString()]
    );

    let count = 0;
    for (const row of result.rows) {
      try {
        await this.archiveTask(row.id);
        count++;
      } catch (err) {
        logCaughtFailure('[TaskManagerDB] Error auto-archiving task:', err);
      }
    }

    if (count > 0) {
      console.log('[TaskManagerDB] Auto-archived', count, 'old completed tasks');
    }

    return count;
  }

  /**
   * Resolve thinking level (auto-estimate if not provided)
   */
  private resolveThinking(data: Partial<Task>): { thinking: 'low' | 'medium' | 'high'; thinkingAutoEstimated: boolean } {
    const validLevels: Array<'low' | 'medium' | 'high'> = ['low', 'medium', 'high'];
    
    if (data.thinking && validLevels.includes(data.thinking)) {
      return { thinking: data.thinking, thinkingAutoEstimated: false };
    }
    
    const levels: Array<'low' | 'medium' | 'high'> = ['low', 'medium', 'high'];
    let levelIndex = 0;
    
    const subtaskCount = (data.subtasks || []).length;
    if (subtaskCount >= 8) {
      levelIndex = 2;
    } else if (subtaskCount >= 4) {
      levelIndex = 1;
    }
    
    const tags = (data.tags || []).map(t => t.toLowerCase());
    if (tags.some(t => ['bugfix', 'hotfix'].includes(t))) {
      levelIndex = 0;
    } else if (tags.some(t => ['architecture', 'refactor', 'security'].includes(t))) {
      levelIndex = 2;
    }
    
    if (data.priority === 'urgent' || data.priority === 'high') {
      levelIndex = Math.min(levelIndex + 1, 2);
    }
    
    return { thinking: levels[levelIndex], thinkingAutoEstimated: true };
  }

  /**
   * Shutdown - cleanup
   */
  async shutdown(): Promise<void> {
    console.log('[TaskManagerDB] Shutdown complete');
  }
}

// Singleton instance (will be swapped in server.ts)
export const taskManagerDB = new TaskManagerDB();
