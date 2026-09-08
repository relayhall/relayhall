import { auditChainFor } from '../utils/auditChain';
import { idempotent } from '../middleware/idempotency';
import { auditService } from '../services/AuditService';
import { logCaughtFailure, logCaughtWarning } from '../utils/secretSafeLog';
import { RequestFaultError, NotFoundFault, ForbiddenFault, InvalidRequestFault, ProjectTargetNotFoundFault } from '../utils/httpErrors';
// tasks.ts - API endpoints for task management
import { Router, Request, Response } from 'express';
import { taskManagerDB as taskManager, SubtaskStatus, DependencyValidationError, TaskNotFoundError, TaskNotArchivedError, archiveWarningForStatus, ArchiveDisposition, dependencyBlocks } from '../services/TaskManagerDB';
import { taskAnalyzer } from '../services/taskAnalyzer';
import {
  generateTaskPromptWithSkills,
  renderAgentsMdShape,
  ReportReferenceLookupError,
  parseBriefInlineOptions,
} from '../utils/promptTemplate';
import { CharterLookupError } from '../services/CharterService';
import { notificationManager } from '../services/NotificationManager';
import { taskReviewerService } from '../services/TaskReviewerService';
import { taskOrchestrationService, OrchestrationConflictError } from '../services/TaskOrchestrationService';
import { discordThreadService } from '../services/DiscordThreadService';
import { unifiedTaskTimeline, decodeCursor, type TimelineFilter } from '../services/UnifiedTaskTimeline';
import { taskHistoryService } from '../services/TaskHistoryService';
import { telemetryService } from '../services/TelemetryService';
import { pool } from '../db/connection';
import { feedEventService } from '../services/FeedEventService';
import { isValidTaskId, rejectInvalidTaskIdParam } from '../utils/taskIds';
import { createHash } from 'crypto';
import { resolveCreateAutoStart, dodWarningForStatusChange } from '../utils/taskLifecycle';
import { resolveTaskLifecycleRole, type TaskAutomationRole } from '../utils/taskAutomationRole';
import { isStringTooLongError, sendStringTooLongError, sendApiError } from '../utils/apiErrors';
import { isPhaseBindingViolation, PhaseLookupError } from '../services/PhaseService';
import { normalizeTaskDueAtWrite, normalizeTaskNotesWrite, sendTaskFieldRefusal, type DueAtResolution } from '../utils/taskWriteFields';
import { createPgDueAtResolver } from '../utils/dueAtResolver';
import { buildBoardOwnershipFilters } from '../utils/boardFilters';
import { scopesSatisfy } from '../utils/scopeMap';
import {
  isLegacyExecutionProfile,
  validateConnectorProfile,
  ProfileValidationError,
} from '../utils/executionProfile';
import type { AuthRequest } from '../middleware/auth';
import type { TaskActor } from '../services/TaskHistoryService';
import { taskNotificationService, type TaskNotificationKind } from '../services/TaskNotificationService';
import { canonicalRuntimeSignalService } from '../services/CanonicalRuntimeSignalService';
import { actorFromRequest, authorizedListScope, authorizedProjectTarget, filterAuthorizedResources } from '../middleware/sharedAuthorization';
import { authorizationService } from '../services/AuthorizationService';
import { authorizationRepository } from '../services/AuthorizationRepository';
import { AssignmentAccessError, accessVehicleService } from '../services/AccessVehicleService';
import { principalService } from '../services/PrincipalService';
import {
  taskElementService,
  TaskElementError,
  TASK_ELEMENT_INPUT_SCHEMA,
  compileTaskOperatingContract,
} from '../services/TaskElementService';
import { auditActorFromRequest } from '../utils/auditActor';
import { agentLifecycleService } from '../services/AgentLifecycleService';
import { taskAccessService } from '../services/TaskAccessService';
import { lifecyclePolicyDenialEnvelope } from '../services/LifecyclePolicyService';

// Card 7d38a6e0. A Task deadline reaches this API either as an ISO-8601
// instant or as `{ local, zone }` - a wall clock exactly as a person wrote
// it plus the IANA zone to read it in. Nothing in this process converts
// either one: PostgreSQL does, against the tz database the column itself is
// stored with, and every conversion is proved by rendering the instant back
// into the frame the caller named. See utils/dueAtResolver.ts for why.
const dueAtResolver = createPgDueAtResolver(pool);

const router = Router();

// Valid subtask statuses for validation (6-state lifecycle)
const VALID_SUBTASK_STATUSES: SubtaskStatus[] = ['empty', 'in-progress', 'review', 'stuck', 'skipped', 'completed'];
// Statuses agents can set (subtask-level)
const AGENT_ALLOWED_STATUSES: SubtaskStatus[] = ['in-progress', 'review', 'stuck'];
// Task-level statuses agents can set (orchestrator controls completed/todo/ideas/archived)
const AGENT_ALLOWED_TASK_STATUSES: string[] = ['in-progress', 'review', 'stuck'];

const SERVER_WRITTEN_TASK_ROLE_FIELDS = new Set([
  'ownerPrincipalId',
  'claimantPrincipalId',
  'shepherdPrincipalId',
  'verifierPrincipalId',
  'owner_principal_id',
  'claimant_principal_id',
  'shepherd_principal_id',
  'verifier_principal_id',
]);
const PRINCIPAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** RH-P3.AZ-S7: any UUID version — warrants.id is gen_random_uuid (v4),
 * but the id is opaque to this surface and the DB is the authority. */
const WARRANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rejectCallerWrittenTaskRoles(req: Request, res: Response): boolean {
  const supplied = Object.keys((req.body ?? {}) as Record<string, unknown>)
    .find((field) => SERVER_WRITTEN_TASK_ROLE_FIELDS.has(field));
  if (!supplied) return false;
  sendApiError(
    res,
    400,
    'SERVER_WRITTEN_FIELD',
    `Field '${supplied}' is server-written and cannot be supplied by a caller`,
    undefined,
    { field: supplied },
  );
  return true;
}

function getRequestAutomationRole(req: Request): TaskAutomationRole {
  const authReq = req as AuthRequest;
  return resolveTaskLifecycleRole({
    handle: authReq.userId || '',
    principalRole: authReq.principal?.role ?? null,
    sessionRole: authReq.sessionRole ?? null,
  }) as TaskAutomationRole;
}

/** Request actor for history/timeline attribution (spec b48bb799 §2.5). */
export function requestActor(req: Request): TaskActor {
  const authReq = req as AuthRequest;
  return {
    principalId: authReq.principal?.id ?? null,
    handle: authReq.userId || 'user',
    role: getRequestAutomationRole(req),
    authMethod: authReq.authMethod,
    credentialId: authReq.credentialId ?? null,
    // RH-P3.AZ-S7: the ASSIGNER's authorization identity, so the coupling
    // at the TaskManagerDB choke point can cap every materialization ⊆ the
    // assigner's own effective authority (ruling 7440b579 R3).
    authorization: actorFromRequest(authReq),
  };
}

function taskElementActor(req: Request) {
  const authReq = req as AuthRequest;
  if (!authReq.principal) {
    throw new TaskElementError(400, 'PRINCIPAL_REQUIRED', 'This Task operation requires a resolved principal identity');
  }
  return {
    principalId: authReq.principal.id,
    handle: authReq.principal.handle,
    root: scopesSatisfy(authReq.scopes ?? null, 'root'),
    // RH-P3.AZ-S7 (review bedc25f3 B2): a link edit on an assigned Task
    // recomputes its access, and R3/R8 cap that at the LINKER's own
    // authority. Without this the recompute ran uncapped.
    authorization: actorFromRequest(authReq),
  };
}

function sendTaskElementError(res: Response, error: unknown): void {
  if (error instanceof TaskElementError) {
    sendApiError(res, error.status, error.code, error.message, undefined, error.field ? { field: error.field } : undefined);
    return;
  }
  const errorId = logCaughtFailure('[Tasks API] Task element operation failed:', error);
  sendApiError(res, 500, 'TASK_ELEMENT_FAILURE', 'Task element operation failed', undefined, { errorId });
}

function sendLifecyclePolicyError(res: Response, error: unknown): boolean {
  const policy = lifecyclePolicyDenialEnvelope(error);
  if (!policy) return false;
  sendApiError(res, policy.status, policy.code, policy.message, undefined, policy.details);
  return true;
}

function markLegacySubtaskIndexRoute(res: Response): void {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Warning', '299 RelayHall "Positional Subtask addressing is deprecated; use the stable-id route"');
}

async function rejectNonReviewerAction(req: Request, res: Response, action: string): Promise<boolean> {
  const actor = actorFromRequest(req as AuthRequest);
  const task = await taskManager.getTask(req.params.id);
  const role = getRequestAutomationRole(req);
  const assignedVerifier = task?.verifierPrincipalId === actor.principalId;
  const legacyUnassignedVerifier = !task?.verifierPrincipalId && (role === 'qa' || role === 'reviewer');
  // A generic admin/Grant verify allowance does not make its holder an
  // independent Verifier. Keep identity separation as well as the predicate.
  if (task && actor.principalId && task.ownerPrincipalId !== actor.principalId
    && (assignedVerifier || legacyUnassignedVerifier)
    && (await authorizationRepository.authorizePoint(actor, 'task', task.id, 'verify')).allowed) return false;
  res.status(403).json({ success: false, error: `Only an independent Verifier identity can ${action}.` });
  return true;
}

function rejectImplementationAgentOrchestratorAction(req: Request, res: Response, action: string): boolean {
  const role = getRequestAutomationRole(req);
  if (role === 'agent') {
    res.status(403).json({
      success: false,
      error: `Implementation agents cannot ${action}. Hand off to an independent Verifier worker or orchestrator.`
    });
    return true;
  }
  return false;
}

/**
 * Phase membership on a Task write (RH-P2.4). The value is a Phase UUID or
 * null (unphase); anything else is refused here rather than reaching the
 * database as a cast error.
 *
 * Whether the Phase belongs to the Task's Project is NOT decided here — that
 * is a database fact (the composite FK tasks_phase_project_fk plus the
 * tasks_phase_requires_project CHECK). The write is refused and translated
 * by `sendPhaseBindingRefusal` below; it is never silently repaired, because
 * quietly unphasing or re-projecting someone's Task is a data change nobody
 * asked for.
 */
export class PhaseFieldError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PhaseFieldError';
  }
}

const PHASE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizePhaseIdWrite(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !PHASE_UUID_PATTERN.test(value)) {
    throw new PhaseFieldError(
      'INVALID_PHASE_ID',
      'phaseId must be a Phase UUID, or null to leave the task unphased (the project backlog)',
    );
  }
  return value;
}

/** Translate the two Phase-binding constraint violations into typed 4xx. */
export function sendPhaseBindingRefusal(res: Response, e: unknown): boolean {
  if (e instanceof PhaseFieldError) {
    sendApiError(res, 400, e.code, e.message, undefined, { field: 'phaseId' });
    return true;
  }
  if (isPhaseBindingViolation(e)) {
    sendApiError(
      res,
      409,
      'PHASE_PROJECT_MISMATCH',
      "the phase does not belong to this task's project — set both together, or clear the phase in the same request",
      undefined,
      { field: 'phaseId' },
    );
    return true;
  }
  return false;
}

/**
 * Connector-first execution profiles (RH-P2.2; vocabulary D-15, strategy
 * §2.1, RH-DESIGN.5 R5, design 2e51b732). The legacy
 * mode/harness/accessProfile/requiredCapabilities/allowOverrideAtSpawn
 * shape RETIRED with D-15: the write path refuses it by name; STORED legacy
 * blobs are held, reported and never dropped (they surface as
 * legacyExecutionProfile on reads, and the orchestration-lease harness
 * binding keeps reading them until the RH-P3.1 pickup protocol).
 *
 * §2.1 authority: setting or changing a profile that TARGETS a service
 * requires `services:invoke` (or root) on top of the route's tasks:write —
 * choosing a connector workflow IS choosing what executes, so bare
 * task-write must never be enough. Every identity path carries explicit
 * scopes; a missing set fails closed. "Assignment authority over S" gains storage with the RH-P2.3
 * grants schema and widens this check through the RH-P2.5 predicate.
 */
export async function resolveExecutionProfileWrite(payload: any, req: Request): Promise<any> {
  if (payload.executionMode !== undefined) {
    throw new ProfileValidationError(
      400,
      'FIELD_RETIRED',
      "executionMode retired with the connector-first execution profile (vocabulary D-15): send executionProfile { serviceId, descriptorVersion, options } or omit it for a basic (model/thinking) task",
      'executionMode',
    );
  }
  // RH-P3.AZ-S7 (ruling 7440b579 R2(a)): the Warrant a caller chooses as
  // the assignment's access vehicle. Warrants are the DEFAULT vehicle;
  // omitting it takes the R2(b) auto-grant fallback, never zero access.
  // The word is ratified vocabulary (A17.5) and this is the existing
  // assignment write, so no noun and no scope string is minted.
  if (payload.executionWarrantId !== undefined && payload.executionWarrantId !== null) {
    if (typeof payload.executionWarrantId !== 'string' || !WARRANT_UUID.test(payload.executionWarrantId)) {
      throw new ProfileValidationError(422, 'INVALID_WARRANT_ID',
        'executionWarrantId must be a Warrant UUID, or null to take the auto-grant fallback',
        'executionWarrantId');
    }
    if (payload.executionProfile === undefined || payload.executionProfile === null) {
      throw new ProfileValidationError(422, 'WARRANT_WITHOUT_ASSIGNMENT',
        'executionWarrantId names the Warrant carrying the access for an execution assignment — send it with the executionProfile that makes the assignment',
        'executionWarrantId');
    }
  }

  const input = payload.executionProfile;
  if (input === undefined) return payload;
  if (input === null) {
    payload.executionProfile = null;
    payload.executionServiceId = null;
    payload.executionDescriptorVersion = null;
    // Unassigning drops the vehicle with it — a warrant pointer may never
    // outlive its assignment (migration 100 CHECK).
    payload.executionWarrantId = null;
    return payload;
  }
  if (isLegacyExecutionProfile(input)) {
    throw new ProfileValidationError(
      400,
      'FIELD_RETIRED',
      "the mode/harness/accessProfile execution-profile shape retired with vocabulary D-15: send { serviceId, descriptorVersion, options } validated against the Connector's pinned capability descriptor",
      'executionProfile',
    );
  }
  // AUTHORITY BEFORE LOOKUP (review 66c78a1d F1): the invoke check runs
  // BEFORE any Service-registry read, so a bare task-writer learns nothing —
  // not service existence, not descriptor vocabulary — and receives one
  // generic refusal regardless of what it guessed.
  const scopes = (req as AuthRequest).scopes;
  if (!scopesSatisfy(scopes, 'services:invoke')) {
    throw new ProfileValidationError(
      403,
      'PROFILE_INVOKE_REQUIRED',
      'setting a profile that targets a service requires services:invoke (or root) — filling arguments is choosing what executes (§2.1)',
      'executionProfile',
    );
  }
  const profile = await validateConnectorProfile(input);
  payload.executionProfile = profile;
  payload.executionServiceId = profile.serviceId;
  payload.executionDescriptorVersion = profile.descriptorVersion;
  return payload;
}

async function getConfiguredDefaultModel(configPrimary: string): Promise<string> {
  try {
    const result = await pool.query(
      "SELECT value FROM user_preferences WHERE key = 'preferred_default_model'"
    );
    if (result.rows.length > 0 && result.rows[0].value) {
      return result.rows[0].value;
    }
  } catch {
    // Table might not exist yet, that's fine.
  }
  return configPrimary;
}

/**
 * GET /tasks/:id/assignment-access — RH-P3.AZ-S7 (ruling 7440b579 R5): the
 * "task -> its vehicle" half of the two-way linkage. Renders WHAT carries
 * this assignment: the Warrant if one does, and the grant /
 * profile-assignment rows the vehicle depends on, each showing whether the
 * vehicle created it (owner default D4 — a row it did not create is one it
 * will never delete).
 *
 * The path spells the ratified words: an assignment, and the access it
 * carries. "Vehicle" is descriptive prose in the ruling and stays internal
 * (review bedc25f3 B1) - no surface introduces it as a noun.
 *
 * Read-only, and the shared point predicate has already authorized `read`
 * on the Task before this handler runs. No new scope string: it is a GET
 * under /tasks.
 */
router.get('/:id/assignment-access', async (req: Request, res: Response): Promise<void> => {
  try {
    const task = await taskManager.getTask(req.params.id);
    if (!task) {
      sendApiError(res, 404, 'TASK_NOT_FOUND', 'Task not found');
      return;
    }
    const row = await pool.query(
      `SELECT t.execution_service_id, t.execution_warrant_id, s.slug AS service_slug, s.name AS service_name,
              w.name AS warrant_name, w.status AS warrant_status, w.expires_at AS warrant_expires_at
         FROM tasks t
         LEFT JOIN services s ON s.id = t.execution_service_id
         LEFT JOIN warrants w ON w.id = t.execution_warrant_id
        WHERE t.id = $1`,
      [task.id],
    );
    const record = row.rows[0] ?? {};
    res.json({
      success: true,
      assignment: {
        taskId: task.id,
        executionServiceId: record.execution_service_id ?? null,
        executionServiceSlug: record.service_slug ?? null,
        executionServiceName: record.service_name ?? null,
        // See AccessVehicleService.linksForTask: wire names are
        // compositional over ratified words (review 1f60bf8f B1).
        carriedBy: record.execution_service_id
          ? (record.execution_warrant_id ? 'warrant' : 'grant')
          : null,
        warrantId: record.execution_warrant_id ?? null,
        warrantName: record.warrant_name ?? null,
        warrantStatus: record.warrant_status ?? null,
        warrantExpiresAt: record.warrant_expires_at ? new Date(record.warrant_expires_at).toISOString() : null,
      },
      links: await accessVehicleService.linksForTask(task.id),
    });
  } catch (err) {
    const errorId = logCaughtFailure('[Tasks API] assignment-access read failed:', err);
    res.status(503).json({ success: false, code: 'ASSIGNMENT_ACCESS_UNAVAILABLE', error: 'The assignment access could not be read', errorId });
  }
});

/**
 * GET /tasks
 * List all active tasks with optional filters
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const filters: any = {};
    const getList = (value: unknown): string[] | undefined => {
      if (Array.isArray(value)) return value.flatMap(v => String(v).split(',')).map(v => v.trim()).filter(Boolean);
      if (typeof value === 'string') return value.split(',').map(v => v.trim()).filter(Boolean);
      return undefined;
    };
    
    if (req.query.status) filters.status = req.query.status as string;
    const statuses = getList(req.query.statuses);
    if (statuses?.length) filters.statuses = statuses;
    if (req.query.project) filters.project = req.query.project as string;
    const projects = getList(req.query.projects);
    if (projects?.length) filters.projects = projects;
    if (req.query.priority) filters.priority = req.query.priority as string;
    const priorities = getList(req.query.priorities);
    if (priorities?.length) filters.priorities = priorities;
    if (req.query.tag) filters.tag = req.query.tag as string;
    const tags = getList(req.query.tags);
    if (tags?.length) filters.tags = tags;
    if (req.query.q) filters.q = req.query.q as string;
    if (req.query.excludeTaskId) filters.excludeTaskId = req.query.excludeTaskId as string;
    if (req.query.includeArchived !== undefined) {
      filters.includeArchived = String(req.query.includeArchived) === 'true';
    }
    if (req.query.limit) {
      const parsedLimit = Number(req.query.limit);
      if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
        filters.limit = parsedLimit;
      }
    }
    if (req.query.offset) {
      const parsedOffset = Number(req.query.offset);
      if (Number.isFinite(parsedOffset) && parsedOffset >= 0) {
        filters.offset = parsedOffset;
      }
    }
    if (req.query.parentId !== undefined) {
      filters.parentId = req.query.parentId === 'null' ? null : req.query.parentId as string;
    }
    // Phase membership (RH-P2.4). 'null' selects the unphased backlog — the
    // spelling parentId already uses, so callers learn one convention. The
    // single-value form is the CLI/agent contract; the board uses the list.
    if (req.query.phaseId !== undefined) {
      filters.phaseIds = [req.query.phaseId === 'null' ? null : String(req.query.phaseId)];
    }

    // Assignee filters (Phase 1, spec b48bb799 §3.3)
    if (req.query.owner) filters.ownerHandle = String(req.query.owner);
    if (String(req.query.unassigned) === 'true') filters.unassigned = true;
    if (String(req.query.mine) === 'true') {
      const callerPrincipal = (req as AuthRequest).principal;
      if (!callerPrincipal) {
        // Legacy identities without a principal row hold no assignments yet; an empty
        // board beats an error until the substrate migrates everywhere.
        res.json({ success: true, tasks: [] });
        return;
      }
      filters.ownerPrincipalId = callerPrincipal.id;
    }

    const queriedTasks = await taskManager.queryTasks(filters);
    const tasks = await filterAuthorizedResources(
      req as AuthRequest,
      'read',
      queriedTasks,
      (task) => ({ type: 'task', id: task.id }),
    );
    
    // Computed dependency fields, for the WHOLE result set (590e88cc).
    //
    // This loop used to run three point reads per Task — getBlockingTasks,
    // getDependentTasks and isTaskBlocked — inside a `Promise.all` over the
    // UNPAGINATED estate, and each of those re-read Tasks through `getTask`.
    // Measured on the 5,200-Task fixture: ONE request, no concurrency, offered
    // the pool 9,186 connection acquisitions against `max: 20` with
    // `connectionTimeoutMillis: 2000`, so the request itself took 5.5s and
    // every OTHER caller sharing those twenty connections — the board, the
    // graph, filter-options, /dashboard/active and the AutoArchive job —
    // started failing with an untyped connection-acquisition error. The
    // reported "intermittent 500s across five paths" were four victims of one
    // producer.
    //
    // Two statements now serve every row, and the narrowing runs ONCE over the
    // union of related ids rather than twice per row. The decisions are the
    // same ones, from the same shared predicate, on the same actor:
    //   - `blocked` is derived from the UNFILTERED edge set, exactly as
    //     `isTaskBlocked` derived it — whether a Task is blocked is a property
    //     of the Task, not of who is asking, and narrowing it would tell a
    //     caller that an unreadable blocker does not exist;
    //   - `blockingTasks` and `dependentTasks` are narrowed, exactly as the
    //     per-row `filterAuthorizedResources` calls narrowed them.
    const edges = await taskManager.getDependencyEdgesForTasks(tasks.map((task: any) => task.id));
    const blockingFor = (taskId: string) =>
      (edges.blocking.get(taskId) ?? []).filter((edge) => dependencyBlocks(edge.status, edge.archiveDisposition));
    const relatedIds = [...new Set([
      ...tasks.flatMap((task: any) => blockingFor(task.id).map((edge) => edge.id)),
      ...tasks.flatMap((task: any) => (edges.dependents.get(task.id) ?? []).map((edge) => edge.id)),
    ])];
    const readableRelated = new Set((await filterAuthorizedResources(
      req as AuthRequest,
      'read',
      relatedIds,
      (id) => ({ type: 'task', id }),
    )));
    const summarize = (list: { id: string; title: string }[]) =>
      list.filter((edge) => readableRelated.has(edge.id)).map((edge) => ({ id: edge.id, title: edge.title }));
    const tasksWithDeps = tasks.map((task: any) => {
      const blocking = blockingFor(task.id);
      return {
        ...task,
        blocked: blocking.length > 0,
        blockingTasks: summarize(blocking),
        dependentTasks: summarize(edges.dependents.get(task.id) ?? []),
      };
    });
    
    res.json({ success: true, tasks: tasksWithDeps });
  } catch (err) {
    if ((err as { code?: string })?.code === 'OWNER_FILTER_UNAVAILABLE') {
      res.status(503).json({ success: false, error: 'Task Assignee filters are unavailable until the identity substrate is migrated' });
      return;
    }
    const errorId = logCaughtFailure('[Tasks API] Error listing tasks:', err);
    res.status(500).json({ success: false, error: 'Tasks could not be listed', code: 'TASK_LIST_FAILED', errorId });
  }
});

/**
 * GET /tasks/filter-options
 * Return available filter values from the DB-backed task set
 */
router.get('/filter-options', async (req: Request, res: Response): Promise<void> => {
  try {
    const includeArchived = req.query.includeArchived === undefined
      ? true
      : String(req.query.includeArchived) === 'true';

    // 6a351638 (R19): this route hydrated EVERY task in the estate — four
    // child queries per row, ~20,000 queries and 2.8s at the 5,200-task
    // fixture — to emit two lists of distinct strings, and the contention
    // queued the whole board startup behind it. An actor whose task-read is
    // id-INDEPENDENT (root/administrator — the probe carries no principal
    // fields, so no id-specific basis can fire) sees exactly the same options
    // from the two DISTINCT aggregates. Scoped actors keep the row-filtered
    // path unchanged: the options list must never leak a tag or project name
    // that is visible only through tasks they cannot read.
    const blanketRead = authorizationService.authorizeResource(
      actorFromRequest(req as AuthRequest),
      'read',
      { type: 'task', id: '00000000-0000-4000-8000-000000000000' },
      [],
    ).allowed;
    if (blanketRead) {
      const options = await taskManager.getTaskFilterOptions(includeArchived);
      res.json({
        success: true,
        // Same comparator as the filtered path below — SQL collation and
        // localeCompare do not always agree, and the two paths must be
        // indistinguishable to a blanket-read client.
        tags: [...options.tags].sort((a, b) => a.localeCompare(b)),
        projects: [...options.projects].sort((a, b) => a.localeCompare(b)),
      });
      return;
    }

    const listedTasks = await taskManager.queryTasks({ includeArchived });
    const tasks = await filterAuthorizedResources(
      req as AuthRequest,
      'read',
      listedTasks,
      (task: any) => ({ type: 'task', id: task.id }),
    );
    const options = {
      tags: [...new Set(tasks.flatMap((task: any) => Array.isArray(task.tags) ? task.tags : []))]
        .map(String)
        .sort((a, b) => a.localeCompare(b)),
      projects: [...new Set(tasks.map((task: any) => task.project).filter(Boolean))]
        .map(String)
        .sort((a, b) => a.localeCompare(b)),
    };
    res.json({ success: true, ...options });
  } catch (err) {
    const errorId = logCaughtFailure('[Tasks API] Error loading filter options:', err);
    res.status(500).json({ success: false, error: 'Task filter options could not be read', code: 'FILTER_OPTIONS_FAILED', errorId });
  }
});

/**
 * GET /tasks/board
 * Per-column paginated task board, server-side filtered
 */
router.get('/board', async (req: Request, res: Response): Promise<void> => {
  try {
    const parseList = (value: unknown, fallback: string[] = []): string[] => {
      if (Array.isArray(value)) return value.flatMap(v => String(v).split(',')).map(v => v.trim()).filter(Boolean);
      if (typeof value === 'string') return value.split(',').map(v => v.trim()).filter(Boolean);
      return fallback;
    };

    const statuses = parseList(req.query.statuses, ['ideas', 'todo', 'in-progress', 'stuck', 'completed', 'archived']);
    const perColumnRaw = Number(req.query.perColumn);
    // Column page default raised to 50 (design 986be411 §5, E4; candidate
    // A3), cap unchanged at 100. PAGINATION DECISION (documented per the A3
    // contract): OFFSET is RETAINED over keyset for column pages. The
    // production column order is the TOTAL order
    // `created_at DESC, id DESC` (the id tie-break lands with this
    // candidate — without it, equal timestamps left page composition
    // unspecified). Column membership is still mutable: a Task entering or
    // leaving the scope between fetches shifts offsets, so a later page can
    // repeat or skip a row relative to an earlier fetch. The coping
    // contract: totals are recomputed server-side on EVERY fetch (a
    // windowed column never lies about its size); the client accumulates
    // pages by id (the shift duplicate collapses); and the debounced
    // reconcile refetch (candidate A4 wires that client) converges the
    // accumulated set to live membership, recovering any skipped row.
    // Keyset was evaluated and declined for v1: a (created_at, id) cursor
    // would need the RH-UI.7 exact-encoding treatment while membership
    // churn — the actual drift source — still forces the same reconcile,
    // so the cursor buys nothing the reconcile does not already provide.
    const perColumn = Number.isFinite(perColumnRaw) && perColumnRaw > 0 ? Math.min(perColumnRaw, 100) : 50;
    const includeArchived = req.query.includeArchived === undefined
      ? statuses.includes('archived')
      : String(req.query.includeArchived) === 'true';

    const offsets: Record<string, number> = {};
    for (const status of statuses) {
      const value = req.query[`offset_${status}` as keyof typeof req.query];
      const parsed = Number(Array.isArray(value) ? value[0] : value);
      if (Number.isFinite(parsed) && parsed >= 0) offsets[status] = parsed;
    }

    // Assignee filters (epic 60558599). The board is what the UI actually
    // renders, and buildTaskWhere already understands these predicates — the
    // list endpoint simply got them first. Filtering here rather than in the
    // client keeps the per-column totals honest, since the client only ever
    // holds one page per column.
    const ownership = buildBoardOwnershipFilters(
      req.query as Record<string, unknown>,
      (req as AuthRequest).principal?.id ?? null
    );
    if (ownership.__empty) {
      // An empty board beats an error while the substrate is still rolling out.
      res.json({ success: true, columns: {}, meta: { statuses, perColumn, includeArchived } });
      return;
    }
    const { __empty, ...ownershipFilters } = ownership;

    // The narrowing is IN the query (TaskManagerDB.queryBoardColumns): the
    // board reports a per-column total, and a total computed over rows the
    // caller may not read is a disclosure even when the rows themselves are
    // withheld. What stood here instead was a post-read filter loop, and it
    // never executed: it iterated `Object.values(board)` - whose single value
    // is the `columns` MAP, not a column - and looked for `column.tasks`, a
    // field the column rows spell `items`. Both mistakes were invisible to the
    // compiler behind an `as any[]`, and to the source census that asserts this
    // file merely CONTAINS the word `filterAuthorizedResources`. Card 08f42f36.
    const board = await taskManager.queryBoardColumns(
      statuses,
      {
        q: req.query.q as string | undefined,
        projects: parseList(req.query.projects),
        // Phase membership on the board (RH-P2.4): the same shared WHERE
        // builder the list route uses, so board totals and the list agree.
        // 'null' inside the list is the unphased backlog.
        phaseIds: parseList(req.query.phaseIds).map((value) => (value === 'null' ? null : value)),
        priorities: parseList(req.query.priorities),
        tags: parseList(req.query.tags),
        includeArchived,
        ...ownershipFilters,
      },
      perColumn,
      offsets,
      authorizedListScope(req as AuthRequest, 'task', 'read'),
    );

    res.json({
      success: true,
      columns: board.columns,
      meta: { statuses, perColumn, includeArchived },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === 'OWNER_FILTER_UNAVAILABLE') {
      res.status(503).json({ success: false, error: 'Task Assignee filters are unavailable until the identity substrate is migrated' });
      return;
    }
    const errorId = logCaughtFailure('[Tasks API] Error loading board:', err);
    res.status(500).json({ success: false, error: 'The Task board could not be read', code: 'BOARD_FAILED', errorId });
  }
});

/**
 * GET /tasks/ids — IDs-only scope read (design 986be411 §4, candidate A2).
 * Same filter vocabulary as GET /tasks/board (statuses, q, projects,
 * phaseIds, priorities, tags, includeArchived, Assignee filters); returns
 * the matching Task ids and total, nothing else. The bulk archive-completed
 * confirm reads its EXPLICIT id set here — never the loaded column window.
 * NOTE: Must be BEFORE /:id route to avoid being caught by wildcard.
 */
router.get('/ids', async (req: Request, res: Response): Promise<void> => {
  try {
    const parseList = (value: unknown, fallback: string[] = []): string[] => {
      if (Array.isArray(value)) return value.flatMap(v => String(v).split(',')).map(v => v.trim()).filter(Boolean);
      if (typeof value === 'string') return value.split(',').map(v => v.trim()).filter(Boolean);
      return fallback;
    };
    // Enumerated states only — an unknown status is a 400, never a silent
    // empty result that would read as "nothing to archive".
    const KNOWN_STATUSES = ['ideas', 'todo', 'in-progress', 'review', 'stuck', 'completed', 'archived'];
    const statuses = parseList(req.query.statuses, ['completed']);
    const unknown = statuses.filter(status => !KNOWN_STATUSES.includes(status));
    if (statuses.length === 0 || unknown.length > 0) {
      res.status(400).json({
        success: false,
        error: `statuses must name known states only (unknown: ${unknown.join(', ') || 'none given'})`,
      });
      return;
    }
    const includeArchived = req.query.includeArchived === undefined
      ? statuses.includes('archived')
      : String(req.query.includeArchived) === 'true';
    const ownership = buildBoardOwnershipFilters(
      req.query as Record<string, unknown>,
      (req as AuthRequest).principal?.id ?? null
    );
    if (ownership.__empty) {
      res.json({ success: true, ids: [], total: 0 });
      return;
    }
    const { __empty, ...ownershipFilters } = ownership;
    const ids = await taskManager.queryTaskIds(statuses, {
      q: req.query.q as string | undefined,
      projects: parseList(req.query.projects),
      phaseIds: parseList(req.query.phaseIds).map((value) => (value === 'null' ? null : value)),
      priorities: parseList(req.query.priorities),
      tags: parseList(req.query.tags),
      includeArchived,
      ...ownershipFilters,
    });
    // The id scope narrows through the SAME point evaluator the board rows
    // use (review d2ed1775 B2): an out-of-grant Task id must never leave the
    // route — an id IS a disclosure.
    const authorizedIds = await filterAuthorizedResources(
      req as AuthRequest,
      'read',
      ids,
      (id: string) => ({ type: 'task', id }),
    );
    res.json({ success: true, ids: authorizedIds, total: authorizedIds.length });
  } catch (err) {
    // Safety floor (review f98d127b B1): an unexpected exception is logged
    // secret-safe and serialized as a FIXED envelope — a driver/adapter
    // message can carry row values or connection details.
    const errorId = logCaughtFailure('[Tasks API] Error reading task id scope:', err);
    res.status(500).json({ success: false, error: 'The Task id scope could not be read', code: 'IDS_SCOPE_FAILED', errorId });
  }
});

/**
 * GET /tasks/aggregates — one cheap grouped read for the filtered scope
 * (design 986be411 §5, candidate A3): per-status totals always; per-project
 * counts/progress with groupBy=project (map far-zoom hubs, archive badge,
 * column headers all read the same numbers). Counts are computed over the
 * GRANT-NARROWED id set — a count is a disclosure too.
 * NOTE: Must be BEFORE /:id route to avoid being caught by wildcard.
 */
router.get('/aggregates', async (req: Request, res: Response): Promise<void> => {
  try {
    const parseList = (value: unknown, fallback: string[] = []): string[] => {
      if (Array.isArray(value)) return value.flatMap(v => String(v).split(',')).map(v => v.trim()).filter(Boolean);
      if (typeof value === 'string') return value.split(',').map(v => v.trim()).filter(Boolean);
      return fallback;
    };
    const KNOWN_STATUSES = ['ideas', 'todo', 'in-progress', 'review', 'stuck', 'completed', 'archived'];
    const statuses = parseList(req.query.statuses, KNOWN_STATUSES);
    const unknown = statuses.filter(status => !KNOWN_STATUSES.includes(status));
    if (statuses.length === 0 || unknown.length > 0) {
      res.status(400).json({ success: false, error: `statuses must name known states only (unknown: ${unknown.join(', ') || 'none given'})` });
      return;
    }
    const groupBy = req.query.groupBy === undefined ? 'status' : String(req.query.groupBy);
    if (groupBy !== 'status' && groupBy !== 'project') {
      res.status(400).json({ success: false, error: 'groupBy must be status or project' });
      return;
    }
    const includeArchived = req.query.includeArchived === undefined
      ? statuses.includes('archived')
      : String(req.query.includeArchived) === 'true';
    const ownership = buildBoardOwnershipFilters(
      req.query as Record<string, unknown>,
      (req as AuthRequest).principal?.id ?? null
    );
    if (ownership.__empty) {
      res.json({ success: true, statuses: {}, ...(groupBy === 'project' ? { projects: [] } : {}), total: 0 });
      return;
    }
    const { __empty, ...ownershipFilters } = ownership;
    const rows = await taskManager.queryScopeRows(statuses, {
      q: req.query.q as string | undefined,
      projects: parseList(req.query.projects),
      phaseIds: parseList(req.query.phaseIds).map((value) => (value === 'null' ? null : value)),
      priorities: parseList(req.query.priorities),
      tags: parseList(req.query.tags),
      includeArchived,
      ...ownershipFilters,
    });
    const authorizedRows = await filterAuthorizedResources(
      req as AuthRequest,
      'read',
      rows,
      (row: { id: string }) => ({ type: 'task', id: row.id }),
    );
    const statusCounts: Record<string, number> = {};
    for (const row of authorizedRows) statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
    const payload: Record<string, unknown> = { success: true, statuses: statusCounts, total: authorizedRows.length };
    if (groupBy === 'project') {
      const byProject = new Map<string, { project: string | null; total: number; byStatus: Record<string, number> }>();
      for (const row of authorizedRows) {
        const key = row.project ?? '';
        const bucket = byProject.get(key) ?? { project: row.project, total: 0, byStatus: {} };
        bucket.total += 1;
        bucket.byStatus[row.status] = (bucket.byStatus[row.status] ?? 0) + 1;
        byProject.set(key, bucket);
      }
      payload.projects = [...byProject.values()]
        .map(bucket => ({
          ...bucket,
          // Progress over the non-archived population: archived rows are an
          // attic, not remaining work.
          progress: (() => {
            const active = bucket.total - (bucket.byStatus['archived'] ?? 0);
            return active > 0 ? Number((((bucket.byStatus['completed'] ?? 0) / active)).toFixed(4)) : 0;
          })(),
        }))
        .sort((a, b) => b.total - a.total);
    }
    res.json(payload);
  } catch (err) {
    const errorId = logCaughtFailure('[Tasks API] Error reading task aggregates:', err);
    res.status(500).json({ success: false, error: 'The Task aggregates could not be read', code: 'AGGREGATES_FAILED', errorId });
  }
});

/**
 * GET /tasks/graph — the Map's bulk read (design 986be411 §5, candidate A3;
 * seed 0ddaaf74): compact nodes + edges for the filtered scope in a FIXED
 * number of queries (one scope read, one dependency-edge read, one
 * knowledge-edge read — no N+1). LOD is enumerated: 'task' returns tiles and
 * both edge families (dependencies solid, knowledge dashed — edges only
 * BETWEEN authorized in-scope nodes); 'project' returns aggregate hubs.
 * Caching: a strong ETag over the authorized scope (If-None-Match → 304) and
 * an optional updatedSince delta (strict ISO 8601, the same encoding
 * generatedAt emits). A delta carries fullCount so a client can detect
 * deletions and fall back to a full refetch — v1 emits no tombstones.
 * NOTE: Must be BEFORE /:id route to avoid being caught by wildcard.
 */
router.get('/graph', async (req: Request, res: Response): Promise<void> => {
  try {
    const parseList = (value: unknown, fallback: string[] = []): string[] => {
      if (Array.isArray(value)) return value.flatMap(v => String(v).split(',')).map(v => v.trim()).filter(Boolean);
      if (typeof value === 'string') return value.split(',').map(v => v.trim()).filter(Boolean);
      return fallback;
    };
    const KNOWN_STATUSES = ['ideas', 'todo', 'in-progress', 'review', 'stuck', 'completed', 'archived'];
    const statuses = parseList(req.query.statuses, ['ideas', 'todo', 'in-progress', 'review', 'stuck', 'completed']);
    const unknown = statuses.filter(status => !KNOWN_STATUSES.includes(status));
    if (statuses.length === 0 || unknown.length > 0) {
      res.status(400).json({ success: false, error: `statuses must name known states only (unknown: ${unknown.join(', ') || 'none given'})` });
      return;
    }
    const LOD_LEVELS = ['task', 'project'];
    const lod = req.query.lod === undefined ? 'task' : String(req.query.lod);
    if (!LOD_LEVELS.includes(lod)) {
      res.status(400).json({ success: false, error: `lod must be one of: ${LOD_LEVELS.join(', ')}` });
      return;
    }
    let updatedSince: Date | null = null;
    if (req.query.updatedSince !== undefined) {
      const raw = String(req.query.updatedSince);
      // Strict: exactly the encoding generatedAt emits (ISO 8601 UTC with
      // milliseconds) — enumerated acceptance, never a lenient Date parse.
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw) || Number.isNaN(Date.parse(raw))) {
        res.status(400).json({ success: false, error: 'updatedSince must be an ISO 8601 UTC timestamp with milliseconds (as generatedAt emits)' });
        return;
      }
      updatedSince = new Date(raw);
    }
    const includeArchived = req.query.includeArchived === undefined
      ? statuses.includes('archived')
      : String(req.query.includeArchived) === 'true';
    const ownership = buildBoardOwnershipFilters(
      req.query as Record<string, unknown>,
      (req as AuthRequest).principal?.id ?? null
    );
    if (ownership.__empty) {
      res.json({ success: true, lod, nodes: [], edges: [], generatedAt: new Date().toISOString(), fullCount: 0 });
      return;
    }
    const { __empty, ...ownershipFilters } = ownership;
    const rows = await taskManager.queryScopeRows(statuses, {
      q: req.query.q as string | undefined,
      projects: parseList(req.query.projects),
      phaseIds: parseList(req.query.phaseIds).map((value) => (value === 'null' ? null : value)),
      priorities: parseList(req.query.priorities),
      tags: parseList(req.query.tags),
      includeArchived,
      ...ownershipFilters,
    });
    const authorizedRows = await filterAuthorizedResources(
      req as AuthRequest,
      'read',
      rows,
      (row: { id: string }) => ({ type: 'task', id: row.id }),
    );
    const fullCount = authorizedRows.length;
    // Edge families are read BEFORE the conditional return: a knowledge edge
    // can be added by the production reference path without rotating either
    // Task's updated_at, so a validator built from node state alone would
    // serve a stale 304 (review 3475a71e B1). The ETag covers node
    // membership, the newest update AND both sorted edge sets.
    const authorizedIds = authorizedRows.map(row => row.id);
    let dependencyEdges: Array<{ from: string; to: string }> = [];
    let knowledgeEdges: Array<{ from: string; to: string }> = [];
    // Phase identity for the Map's band chips (card 8645e81c, design
    // 77950a97 §3): read with the edge families, BEFORE the conditional
    // 304 return, so the validator below covers it too — a phase rename or
    // goal edit must not be served from a stale cached graph.
    let phases: Array<{ id: string; name: string; goal: string | null; projectId: string; position: number }> = [];
    // §3 taxonomy data: progress for the tile bar, linked reports for the
    // report pills. Read with the edge families, BEFORE the 304 return, so
    // the validator covers them too.
    let progress: Array<{ taskId: string; done: number; total: number }> = [];
    let reports: Array<{ id: string; taskId: string; title: string }> = [];
    if (lod === 'task') {
      const referencedPhaseIds = [...new Set(
        authorizedRows.map(row => row.phaseId).filter((id): id is string => Boolean(id))
      )];
      const [dependency, knowledge, phaseRows, progressRows, reportRows] = await Promise.all([
        taskManager.queryDependencyEdges(authorizedIds),
        taskManager.queryKnowledgeEdges(authorizedIds),
        taskManager.queryPhaseSummaries(referencedPhaseIds),
        taskManager.queryTaskProgress(authorizedIds),
        taskManager.queryLinkedReports(authorizedIds),
      ]);
      dependencyEdges = dependency;
      knowledgeEdges = knowledge;
      progress = progressRows;
      // A Report carries its own grants: authorize every row rather than
      // inheriting visibility from the Task that cites it.
      reports = await filterAuthorizedResources(
        req as AuthRequest,
        'read',
        reportRows,
        (report: { id: string }) => ({ type: 'report', id: report.id }),
      );
      // Phases carry an explicit restricted-access policy (owner ruling
      // 44ee41f2), so each one goes through the SAME authorization
      // predicate as the nodes — never inferred from a visible Task.
      phases = await filterAuthorizedResources(
        req as AuthRequest,
        'read',
        phaseRows,
        (phase: { id: string }) => ({ type: 'phase', id: phase.id }),
      );
    }
    let newestUpdate = '';
    for (const row of authorizedRows) if (row.updated > newestUpdate) newestUpdate = row.updated;
    const edgeSignature = [
      dependencyEdges.map(edge => `d:${edge.from}>${edge.to}`).sort().join(','),
      knowledgeEdges.map(edge => `k:${edge.from}>${edge.to}`).sort().join(','),
    ].join('|');
    // Phase name/goal/position are rendered state that no Task's updated_at
    // rotates, so they join the validator exactly like the edge sets did
    // (the review 3475a71e B1 lesson).
    const phaseSignature = phases
      .map(phase => `p:${phase.id}:${phase.name}:${phase.goal ?? ''}:${phase.position}`)
      .sort().join(',');
    // Progress, liveness and report membership are rendered state that no
    // task's updated_at necessarily rotates — a subtask ticking over or an
    // agent picking a task up must not be served from a stale cache.
    const taxonomySignature = [
      progress.map(row => `g:${row.taskId}:${row.done}/${row.total}`).sort().join(','),
      // The title is rendered (pill tooltip + accessible name), so a
      // title-only edit MUST rotate the validator. Length-prefixed because
      // free text may contain the ':' and ',' that delimit these fields.
      reports.map(row => {
        const title = row.title ?? '';
        return `r:${row.taskId}:${row.id}:${title.length}:${title}`;
      }).sort().join(','),
      authorizedRows.map(row => `a:${row.id}:${row.agent ?? ''}`).sort().join(','),
    ].join('|');
    const etagSource = `${lod}:${fullCount}:${newestUpdate}:${authorizedIds.slice().sort().join(',')}:${edgeSignature}:${phaseSignature}:${taxonomySignature}`;
    const etag = `"g-${createHash('sha256').update(etagSource).digest('hex').slice(0, 32)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader('ETag', etag);
    const generatedAt = new Date().toISOString();
    if (lod === 'project') {
      const byProject = new Map<string, { project: string | null; total: number; byStatus: Record<string, number> }>();
      for (const row of authorizedRows) {
        const key = row.project ?? '';
        const bucket = byProject.get(key) ?? { project: row.project, total: 0, byStatus: {} };
        bucket.total += 1;
        bucket.byStatus[row.status] = (bucket.byStatus[row.status] ?? 0) + 1;
        byProject.set(key, bucket);
      }
      const nodes = [...byProject.values()].map(bucket => ({
        kind: 'project' as const,
        project: bucket.project,
        total: bucket.total,
        byStatus: bucket.byStatus,
        progress: (() => {
          const active = bucket.total - (bucket.byStatus['archived'] ?? 0);
          return active > 0 ? Number((((bucket.byStatus['completed'] ?? 0) / active)).toFixed(4)) : 0;
        })(),
      })).sort((a, b) => b.total - a.total);
      res.json({ success: true, lod, nodes, edges: [], generatedAt, fullCount });
      return;
    }
    const deltaRows = updatedSince
      ? authorizedRows.filter(row => new Date(row.updated).getTime() > updatedSince!.getTime())
      : authorizedRows;
    // Tasks whose PROGRESS moved without their row moving. Only asked for on a
    // delta read, and only over ids already authorized above.
    const progressChangedIds = updatedSince
      ? await taskManager.queryProgressChangedSince(authorizedIds, updatedSince)
      : [];
    res.json({
      success: true,
      lod,
      nodes: deltaRows.map(row => {
        const bar = progress.find(entry => entry.taskId === row.id);
        return {
          id: row.id, title: row.title, status: row.status, priority: row.priority,
          project: row.project, phaseId: row.phaseId, updated: row.updated,
          // Coarse liveness only: the agent's NAME answers "who is working
          // on this now" without disclosing session internals.
          agent: row.agent ?? null,
          progress: bar && bar.total > 0 ? { done: bar.done, total: bar.total } : null,
        };
      }),
      edges: [
        ...dependencyEdges.map(edge => ({ ...edge, kind: 'dependency' as const })),
        ...knowledgeEdges.map(edge => ({ ...edge, kind: 'knowledge' as const })),
      ],
      // Keyed identity rather than a field repeated on every node: one row
      // per phase keeps the delta payload small at estate scale.
      phases,
      reports,
      generatedAt,
      fullCount,
      // PROGRESS is the one fact a delta keyed on tasks.updated_at cannot
      // carry: subtasks is a separate table with its own updated_at and no
      // trigger writing back to tasks. Agent does NOT need this channel —
      // active_agent is a column on tasks and `update_tasks_updated_at` fires
      // unconditionally on every row update, so a pickup is already inside the
      // delta window on its own node.
      //
      // Scoped to the tasks whose subtasks actually moved. Walking the whole
      // scope would make a delta nearly the size of a full read, on the one
      // surface whose design exists for estate scale.
      ...(updatedSince && progressChangedIds.length ? {
        taxonomy: progressChangedIds.map((id: string) => {
          const bar = progress.find(entry => entry.taskId === id);
          return {
            id,
            progress: bar && bar.total > 0 ? { done: bar.done, total: bar.total } : null,
          };
        }),
      } : {}),
      ...(updatedSince ? { deltaOf: updatedSince.toISOString() } : {}),
    });
  } catch (err) {
    const errorId = logCaughtFailure('[Tasks API] Error reading task graph:', err);
    res.status(500).json({ success: false, error: 'The Task graph could not be read', code: 'GRAPH_FAILED', errorId });
  }
});

/**
 * GET /tasks/current
 * Most recently updated in-progress task from the authoritative board.
 * NOTE: Must be BEFORE /:id route to avoid being caught by wildcard
 */
router.get('/current', async (req: Request, res: Response): Promise<void> => {
  try {
    const candidates = await taskManager.queryTasks({ status: 'in-progress' });
    const visible = await filterAuthorizedResources(
      req as AuthRequest,
      'read',
      candidates,
      (candidate: any) => ({ type: 'task', id: candidate.id }),
    );
    const task = visible[0] ?? null;
    res.json({
      success: true,
      task,
      taskId: task?.id ?? null,
      hasCurrentTask: Boolean(task),
    });
  } catch (err) {
    const errorId = logCaughtFailure('[Tasks API] Error loading current task:', err);
    res.status(500).json({ success: false, error: 'The current task could not be read', code: 'CURRENT_TASK_READ_FAILED', errorId });
  }
});

/**
 * POST /tasks/orchestration/:id/claim
 * Compare-and-set claim with dependency and active resource lease checks.
 */
router.post('/orchestration/:id/claim', async (req: Request, res: Response): Promise<void> => {
  try {
    if (rejectImplementationAgentOrchestratorAction(req, res, 'claim scheduler work')) return;
    const { snapshotUpdatedAt, harness, resourceKey, sessionKey, ttlSeconds, metadata } = req.body || {};
    if (!snapshotUpdatedAt || !['hermes', 'openclaw'].includes(harness) || !resourceKey) {
      res.status(400).json({ success: false, error: 'snapshotUpdatedAt, harness, and resourceKey are required' });
      return;
    }
    const claim = await taskOrchestrationService.claimReadyTask({
      taskId: req.params.id,
      snapshotUpdatedAt,
      harness,
      resourceKey,
      sessionKey,
      ttlSeconds,
      metadata,
      // RH-P3.C3: the acting identity, so the service can apply the ratified
      // claimant-is-not-verifier refusal (§2.6.4). Every authenticated route
      // has one by the time it reaches here; the service treats a missing
      // one as "no identity to compare", never as an exemption.
      claimantPrincipalId: (req as AuthRequest).principal?.id ?? null,
    });
    res.status(claim.acquired ? 201 : 200).json({ success: true, ...claim });
  } catch (err) {
    if (err instanceof OrchestrationConflictError) {
      res.status(err.code === 'TASK_NOT_FOUND' ? 404 : 409).json({ success: false, code: err.code, error: err.message });
      return;
    }
    const errorId = logCaughtFailure('[Tasks API] Error claiming orchestration task:', err);
    res.status(500).json({ success: false, error: 'The orchestration claim failed', code: 'ORCHESTRATION_CLAIM_FAILED', errorId });
  }
});

router.post('/orchestration/:id/lease/:leaseId/heartbeat', async (req: Request, res: Response): Promise<void> => {
  try {
    const lease = await taskOrchestrationService.heartbeatLease(
      req.params.id,
      req.params.leaseId,
      req.body?.sessionKey,
      req.body?.ttlSeconds,
    );
    // AZ-29 (RH-P3.AZ-S5, design §8.4): the EXPLICIT lease renewal is the
    // one act that extends a bound Agent's credential expiry (re-up to
    // NOW + mint-time max-age). Blocked extensions (revoked warrant,
    // terminal task) never fail the heartbeat — the credential runway just
    // stops growing, durably audited.
    let credentialExtension: { extended: boolean; blockedReason: string | null } | undefined;
    const acting = (req as AuthRequest).principal;
    if (acting?.kind === 'agent') {
      credentialExtension = await agentLifecycleService.extendOnLeaseRenewal(
        acting.id, req.params.id, auditActorFromRequest(req as AuthRequest));
    }
    res.json({ success: true, lease, ...(credentialExtension ? { credentialExtension } : {}) });
  } catch (err) {
    if (err instanceof OrchestrationConflictError) {
      res.status(409).json({ success: false, code: err.code, error: err.message });
      return;
    }
    const errorId = logCaughtFailure('[Tasks API] Error heartbeating the lease:', err);
    res.status(500).json({ success: false, code: 'LEASE_HEARTBEAT_FAILED', error: 'The lease heartbeat failed', errorId });
  }
});

router.post('/orchestration/:id/lease/:leaseId/release', async (req: Request, res: Response): Promise<void> => {
  try {
    const status = req.body?.status === 'failed' ? 'failed' : 'released';
    const lease = await taskOrchestrationService.releaseLease(
      req.params.id,
      req.params.leaseId,
      status,
      req.body?.failureReason,
    );
    res.json({ success: true, lease });
  } catch (err) {
    if (err instanceof OrchestrationConflictError) {
      res.status(409).json({ success: false, code: err.code, error: err.message });
      return;
    }
    const errorId = logCaughtFailure('[Tasks API] Error releasing the lease:', err);
    res.status(500).json({ success: false, code: 'LEASE_RELEASE_FAILED', error: 'The lease could not be released', errorId });
  }
});

/**
 * POST /tasks/reviewer/:id/run
 * Run the structured Verifier. Dry-run is guaranteed to skip task/history and
 * notification mutations inside TaskReviewerService.
 */
router.post('/reviewer/:id/run', async (req: Request, res: Response): Promise<void> => {
  try {
    if (await rejectNonReviewerAction(req, res, 'run the independent Verifier')) return;
    const outcome = await taskReviewerService.runReview(req.params.id, {
      dryRun: req.body?.dryRun === true,
      triggeredBy: req.body?.triggeredBy || 'user',
    });
    res.json({ success: true, dryRun: req.body?.dryRun === true, outcome });
  } catch (err) {
    if (err instanceof NotFoundFault) {
      res.status(err.status).json({ success: false, code: err.code, error: err.message });
      return;
    }
    const errorId = logCaughtFailure('[Tasks API] Error running the Verifier:', err);
    res.status(500).json({ success: false, code: 'VERIFIER_RUN_FAILED', error: 'The Verifier could not be run', errorId });
  }
});

/**
 * POST /tasks/reviewer/:id/reject
 * Record a structured independent rejection and bounded retry/escalation.
 */
router.post('/reviewer/:id/reject', async (req: Request, res: Response): Promise<void> => {
  try {
    if (await rejectNonReviewerAction(req, res, 'reject tasks')) return;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) {
      res.status(400).json({ success: false, error: 'Reject reason is required' });
      return;
    }
    const outcome = await taskReviewerService.rejectTask(req.params.id, reason, {
      triggeredBy: req.body?.triggeredBy || 'user',
    });
    res.json({ success: true, outcome });
  } catch (err) {
    if (err instanceof NotFoundFault) {
      res.status(err.status).json({ success: false, code: err.code, error: err.message });
      return;
    }
    const errorId = logCaughtFailure('[Tasks API] Error rejecting the Verifier task:', err);
    res.status(500).json({ success: false, code: 'VERIFIER_REJECT_FAILED', error: 'The Verifier rejection could not be applied', errorId });
  }
});

/**
 * POST /tasks/:id/notifications/deliver
 * Reserve and deliver an operator notification through the durable receipt
 * ledger. Scheduler callers must not complete dedup before this returns a
 * transport receipt.
 */
router.post('/:id/notifications/deliver', async (req: Request, res: Response): Promise<void> => {
  try {
    if (rejectImplementationAgentOrchestratorAction(req, res, 'deliver operator notifications')) return;
    const allowedKinds: TaskNotificationKind[] = ['review-escalation', 'blocked-human', 'stale', 'review'];
    const kind = req.body?.kind as TaskNotificationKind;
    const stateVersion = typeof req.body?.stateVersion === 'string' ? req.body.stateVersion.trim() : '';
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!allowedKinds.includes(kind) || !stateVersion || !message) {
      res.status(400).json({ success: false, error: 'kind, stateVersion, and message are required' });
      return;
    }
    const task = await taskManager.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }
    const destination = task.discordThreadId || discordThreadService.getSystemNotificationChannelId();
    if (!destination) {
      res.status(409).json({ success: false, error: 'No configured task-thread or system notification destination' });
      return;
    }
    const result = await taskNotificationService.deliver({
      taskId: task.id,
      kind,
      stateVersion,
      destination,
      message,
    });
    res.status(result.status === 'failed' ? 503 : 200).json({
      success: result.status !== 'failed',
      ...result,
    });
  } catch (error) {
    const errorId = logCaughtFailure('[Tasks API] Durable notification delivery failed:', error);
    res.status(500).json({ success: false, error: 'Durable notification delivery failed', code: 'NOTIFICATION_DELIVERY_FAILED', errorId });
  }
});

/**
 * GET /tasks/next
 * Next auto-start task in the todo queue (todo + autoStart + not blocked).
 *
 * ROUTE ORDER MATTERS: 'next', 'current' and 'notifications' are reserved
 * static path segments. Express matches routes in registration order, so
 * every literal route MUST be registered BEFORE the '/:id' wildcard below —
 * otherwise '/:id' swallows the request and rejectInvalidTaskIdParam()
 * returns 400 INVALID_TASK_ID (this is exactly what broke `relayhall next`).
 * Covered by the route-registration-order test in taskLifecycleGates.test.ts.
 */
router.get('/next', async (req: Request, res: Response): Promise<void> => {
  try {
    const queue = await taskManager.getAutoStartQueue();
    const visibleQueue = await filterAuthorizedResources(
      req as AuthRequest,
      'read',
      queue,
      (task: any) => ({ type: 'task', id: task.id }),
    );
    res.json({
      success: true,
      task: visibleQueue[0] || null,
      queueLength: visibleQueue.length,
    });
  } catch (err) {
    const errorId = logCaughtFailure('[Tasks API] Error getting next task:', err);
    res.status(500).json({
      success: false,
      error: 'The next task could not be read',
      code: 'NEXT_TASK_READ_FAILED',
      errorId
    });
  }
});

/**
 * GET /tasks/notifications
 * Get all notifications (with optional filter for unread only).
 * NOTE: Registered here (before '/:id') — see route-order comment on /next.
 * Previously registered after '/:id' and therefore unreachable (400).
 */
router.get('/notifications', async (req: Request, res: Response): Promise<void> => {
  try {
    const unreadOnly = req.query.unread === 'true';

    const stored = unreadOnly
      ? await notificationManager.getUnreadNotifications()
      : await notificationManager.getNotifications();

    // RH-P3.C8 round 2 (review 4243b06e B1): this surface carries Task
    // titles, so it is filtered TWICE for every caller —
    //  1. addressing: an addressed notification reaches its recipient (and
    //     root); NULL-recipient rows are broadcasts;
    //  2. grants: every referenced Task goes through the SHARED
    //     authorization adapter, so another principal's inaccessible Task
    //     title is concealed here exactly as it is everywhere else.
    const authReq = req as AuthRequest;
    const callerPrincipalId = authReq.principal?.id ?? null;
    const callerIsRoot = scopesSatisfy(authReq.scopes ?? null, 'root');
    const addressed = stored.filter((notification) => {
      const recipient = (notification as { recipientPrincipalId?: string | null }).recipientPrincipalId ?? null;
      if (recipient === null || callerIsRoot) return true;
      return callerPrincipalId !== null && recipient === callerPrincipalId;
    });
    const notifications = await filterAuthorizedResources(
      authReq,
      'read',
      addressed,
      (notification) => ({ type: 'task', id: notification.taskId }),
    );

    res.json({
      success: true,
      notifications,
      count: notifications.length,
      unreadCount: notifications.filter(n => !n.read).length
    });
  } catch (err) {
    const errorId = logCaughtFailure('[Tasks API] Error getting notifications:', err);
    res.status(500).json({
      success: false,
      error: 'Notifications could not be read',
      code: 'NOTIFICATIONS_READ_FAILED',
      errorId
    });
  }
});

/**
 * GET /tasks/:id/timeline
 * Returns durable task/session timeline entries, including legacy fallbacks.
 */
router.get('/operating-contract', (_req: Request, res: Response): void => {
  res.json({
    success: true,
    schema: TASK_ELEMENT_INPUT_SCHEMA,
    compiled: compileTaskOperatingContract(),
  });
});

router.get('/:id/stream', async (req: Request, res: Response): Promise<void> => {
  try {
    if (rejectInvalidTaskIdParam(req.params.id, res)) return;
    const entries = await taskElementService.listStream(req.params.id, taskElementActor(req));
    res.json({ success: true, taskId: req.params.id, entries });
  } catch (error) {
    sendTaskElementError(res, error);
  }
});

router.get('/:id/references', async (req: Request, res: Response): Promise<void> => {
  try {
    if (rejectInvalidTaskIdParam(req.params.id, res)) return;
    const references = await taskElementService.listReferences(req.params.id);
    res.json({ success: true, taskId: req.params.id, references });
  } catch (error) {
    sendTaskElementError(res, error);
  }
});

router.get('/:id/timeline', async (req: Request, res: Response): Promise<void> => {
  try {
    if (rejectInvalidTaskIdParam(req.params.id, res)) {
      return;
    }

    const task = await taskManager.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }

    // C1 (RH-UI.7, design 3cdf6e65 §4.1): merged four-source timeline with
    // filter + keyset pagination. Additive over the legacy shape — events[]
    // keeps the fields the live modal reads; new fields ride alongside.
    const filterParam = typeof req.query.filter === 'string' ? req.query.filter : 'all';
    if (filterParam !== 'all' && filterParam !== 'handover' && filterParam !== 'system') {
      sendApiError(res, 400, 'INVALID_FILTER', "filter must be 'all', 'handover' or 'system'");
      return;
    }
    const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
    const before = typeof req.query.before === 'string' && req.query.before ? req.query.before : null;
    if (before && !decodeCursor(before)) {
      sendApiError(res, 400, 'INVALID_CURSOR', 'before must be a cursor previously returned as nextCursor');
      return;
    }

    // Per-source degradation (§4.1): a failed source is reported in
    // sourcesUnavailable while the merged remainder returns.
    let streamRows: any[] | Error;
    let streamSourceErrorId: string | null = null;
    try {
      streamRows = await taskElementService.listStream(task.id, taskElementActor(req));
    } catch (err) {
      streamSourceErrorId = logCaughtFailure('[Tasks API] timeline stream source failed:', err);
      streamRows = err instanceof Error ? err : new Error('stream source failed');
    }
    let historyRows: any[] | Error;
    let historySourceErrorId: string | null = null;
    try {
      historyRows = await unifiedTaskTimeline.listHistoryNotInStream(task.id);
    } catch (err) {
      historySourceErrorId = logCaughtFailure('[Tasks API] timeline history source failed:', err);
      historyRows = err instanceof Error ? err : new Error('history source failed');
    }

    const result = unifiedTaskTimeline.merge(task as any, streamRows, historyRows, {
      filter: filterParam as TimelineFilter,
      before,
      limit,
    });
    res.json({
      success: true,
      taskId: task.id,
      filter: filterParam,
      events: result.events,
      sourcesUnavailable: result.sourcesUnavailable,
      nextCursor: result.nextCursor,
      ...(streamSourceErrorId || historySourceErrorId ? {
        sourceErrorIds: {
          ...(streamSourceErrorId ? { stream: streamSourceErrorId } : {}),
          ...(historySourceErrorId ? { history: historySourceErrorId } : {}),
        },
      } : {}),
    });
  } catch (err) {
    const errorId = logCaughtFailure('[Tasks API] Error getting task timeline:', err);
    res.status(500).json({
      success: false,
      error: 'The task timeline could not be read',
      code: 'TASK_TIMELINE_READ_FAILED',
      errorId,
    });
  }
});

/**
 * GET /tasks/:id
 * Get a single task by ID
 * NOTE: This wildcard must be AFTER specific routes like /current and /next
 */
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    if (rejectInvalidTaskIdParam(req.params.id, res)) {
      return;
    }

    const task = await taskManager.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }
    
    // Add computed dependency fields (same as list endpoint)
    const blockingTasks = await filterAuthorizedResources(
      req as AuthRequest,
      'read',
      await taskManager.getBlockingTasks(task.id),
      (related) => ({ type: 'task', id: related.id }),
    );
    const dependentTasks = await filterAuthorizedResources(
      req as AuthRequest,
      'read',
      await taskManager.getDependentTasks(task.id),
      (related) => ({ type: 'task', id: related.id }),
    );
    const taskWithDeps = {
      ...task,
      blocked: await taskManager.isTaskBlocked(task.id),
      blockingTasks: blockingTasks.map(t => ({ id: t.id, title: t.title })),
      dependentTasks: dependentTasks.map(t => ({ id: t.id, title: t.title })),
    };
    
    res.json({ success: true, task: taskWithDeps });
  } catch (err) {
    const errorId = logCaughtFailure('[Tasks API] Error getting task:', err);
    res.status(500).json({ 
      success: false, 
      error: 'The task could not be read',
      code: 'TASK_READ_FAILED',
      errorId
    });
  }
});

/**
 * POST /tasks
 * Create a new task
 */
router.post('/', idempotent('task.create'), async (req: Request, res: Response): Promise<void> => {
  try {
    if (rejectCallerWrittenTaskRoles(req, res)) return;
    const { 
      title, description, status, priority, project, tags, 
      // Phase 4 fields
      subtasks, links, sessionRefs, autoCreated, autoStart, blockedBy, blockedReason,
      // Task dependencies
      dependsOn,
      // AI execution/Verifier fields
      model, executionMode, executionProfile, activeAgent,
      successCriteria, reviewHistory, maxRetries, definitionOfDone, constraints,
      // Thinking level
      thinking,
      // Personality
      personalityId,
      // Phase membership (RH-P2.4)
      phaseId,
      // RH-P3.AZ-S7: the chosen access vehicle for this assignment.
      executionWarrantId,
      // When this Task is due (card 7d38a6e0). Absent is the ordinary state.
      dueAt,
      // Legacy fields
      parentId, notes
    } = req.body;

    if (!title) {
      res.status(400).json({ success: false, error: 'Title is required' });
      return;
    }

    // Validate thinking level if provided
    const validThinkingLevels = ['low', 'medium', 'high'];
    if (thinking && !validThinkingLevels.includes(thinking)) {
      res.status(400).json({ success: false, error: `Invalid thinking level: "${thinking}". Must be one of: ${validThinkingLevels.join(', ')}` });
      return;
    }

    // Card 7d38a6e0. Resolved before the payload is built, because a deadline
    // this server cannot convert into the instant the caller named is a refusal
    // rather than a Task with a surprising date on it. The resolution is echoed
    // below: a wall clock at an autumn fall-back names TWO instants, and the
    // server saying which one it took is the difference between a choice and a
    // substitution.
    const normalizedDueAt = await normalizeTaskDueAtWrite(dueAt, dueAtResolver);
    const createPayload = await resolveExecutionProfileWrite({
      title,
      description,
      status,
      priority,
      project,
      tags,
      // Phase 4 fields
      subtasks,
      links,
      sessionRefs,
      autoCreated,
      // Lifecycle gate: autoStart is opt-in. Missing/false-y -> FALSE so new
      // tasks are never silently eligible for orchestrator auto-pickup.
      autoStart: resolveCreateAutoStart(autoStart),
      blockedBy,
      blockedReason,
      // Task dependencies
      dependsOn,
      // AI execution fields
      model,
      executionMode,
      executionProfile,
      executionWarrantId,
      activeAgent,
      successCriteria,
      reviewHistory,
      maxRetries,
      definitionOfDone,
      constraints,
      // Thinking level
      thinking,
      // Personality
      personalityId,
      // Phase membership (RH-P2.4)
      phaseId: normalizePhaseIdWrite(phaseId),
      // Card 7d38a6e0: normalized by the same function the update route calls.
      dueAt: normalizedDueAt.value,
      // Legacy fields
      parentId,
      // Card 9c3a1aa4: `notes` was destructured, forwarded, and then dropped on
      // the floor by an INSERT that never named the column. It is now the same
      // field the update route accepts, normalized by the same function.
      notes: normalizeTaskNotesWrite(notes)
    }, req);

    // Card 9c177e6a: the TARGET Project decision travels INTO the create as a
    // required parameter, so it is made on the create's own transaction and
    // before its INSERT. The route is the only place that can build it,
    // because only the route holds the request the actor comes from.
    const task = await taskManager.createTask(
      createPayload as any,
      requestActor(req),
      authorizedProjectTarget(req as AuthRequest),
    );

    // Add computed dependency fields
    const taskWithDeps = {
      ...task,
      blocked: await taskManager.isTaskBlocked(task.id),
      blockingTasks: (await taskManager.getBlockingTasks(task.id)).map(t => ({ id: t.id, title: t.title })),
      dependentTasks: (await taskManager.getDependentTasks(task.id)).map(t => ({ id: t.id, title: t.title })),
    };

    res.status(201).json({
      success: true,
      task: taskWithDeps,
      ...(normalizedDueAt.resolution ? { dueAtResolution: normalizedDueAt.resolution } : {}),
    });
  } catch (err) {
    if (sendLifecyclePolicyError(res, err)) return;
    if (err instanceof ProfileValidationError) {
      // Fixed-text diagnostics only — the profile pipeline's messages are
      // board-authored and the raw object never reaches the log sink.
      const errorId = logCaughtFailure('[Tasks API] execution-profile write refused', err);
      res.status(err.status).json({ success: false, error: err.message, code: err.code, errorId, ...(err.field ? { field: err.field } : {}) });
      return;
    }
    // RH-P3.AZ-S7: the coupling's refusals are contract answers, not
    // failures — a caller must learn that its assignment had no viable
    // access vehicle, and with which code (ruling 7440b579 R1).
    if (err instanceof AssignmentAccessError) {
      const errorId = logCaughtFailure('[Tasks API] assignment-access coupling refused the write', err);
      res.status(err.status).json({ success: false, error: err.message, code: err.code, errorId, ...(err.field ? { field: err.field } : {}) });
      return;
    }
    if (sendPhaseBindingRefusal(res, err)) return;
    // Card 9c177e6a. The target-Project refusal is a CONTRACT answer and it is
    // dispatched by CLASS, never by message (review 14c7f96d B1): a caller who
    // named a Project that does not exist, and a caller who named one it may
    // not read, both learn the same 404 PROJECT_NOT_FOUND. Without this branch
    // the fall-through below would answer 500 for one of them and the
    // difference in status alone would restore the disclosure.
    if (err instanceof ProjectTargetNotFoundFault) {
      sendApiError(res, err.status, err.code, err.message);
      return;
    }
    if (sendTaskFieldRefusal(res, err)) return;
    if (isStringTooLongError(err)) { sendStringTooLongError(res, 'task', err); return; }
    if (err instanceof DependencyValidationError) {
      res.status(400).json({ success: false, error: err.message, code: err.code, offendingIds: err.offendingIds });
      return;
    }
    // Review 3db17273 r2 B1: POST /tasks keeps its base contract - domain
    // preconditions surfaced during creation were 500 before the typed-fault
    // refactor and stay 500; only the message is fixed (never the caught
    // value). Typed fault statuses apply on the surfaces that always had
    // them (update, delete, subtask and dependency verbs).
    const errorId = logCaughtFailure('[Tasks API] Error creating task:', err);
    res.status(500).json({ success: false, code: 'TASK_CREATE_FAILED', error: 'The task could not be created', errorId });
  }
});

/** PATCH /tasks/:id/roles — the dedicated server-owned role assignment
 * surface. Generic PATCH rejects these fields. The shared predicate admits
 * only the Task's Shepherd or an administrator-class actor before this
 * handler runs. */
router.patch('/:id/roles', async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const allowed = ['shepherdPrincipalId', 'verifierPrincipalId'];
  const unknown = Object.keys(body).find((field) => !allowed.includes(field));
  if (unknown) {
    sendApiError(res, 400, 'UNKNOWN_FIELD', `Unknown field '${unknown}'`, undefined, { field: unknown });
    return;
  }
  if (Object.keys(body).length === 0) {
    sendApiError(res, 422, 'INVALID_TASK_ROLE', 'At least one Task role assignment is required');
    return;
  }
  if (
    body.shepherdPrincipalId !== undefined &&
    (typeof body.shepherdPrincipalId !== 'string' || !PRINCIPAL_UUID.test(body.shepherdPrincipalId))
  ) {
    sendApiError(res, 422, 'INVALID_TASK_ROLE', 'shepherdPrincipalId must be a Principal UUID', undefined, { field: 'shepherdPrincipalId' });
    return;
  }
  if (
    body.verifierPrincipalId !== undefined && body.verifierPrincipalId !== null &&
    (typeof body.verifierPrincipalId !== 'string' || !PRINCIPAL_UUID.test(body.verifierPrincipalId))
  ) {
    sendApiError(res, 422, 'INVALID_TASK_ROLE', 'verifierPrincipalId must be a Principal UUID or null', undefined, { field: 'verifierPrincipalId' });
    return;
  }
  try {
    const roleIds = [body.shepherdPrincipalId, body.verifierPrincipalId]
      .filter((value): value is string => typeof value === 'string');
    const principals = await Promise.all(roleIds.map((id) => principalService.getPrincipalById(id)));
    if (principals.some((principal) => !principal || principal.status !== 'active')) {
      sendApiError(res, 422, 'TASK_ROLE_PRINCIPAL_UNAVAILABLE', 'Every assigned Task role must resolve to an active Principal');
      return;
    }
    // §8.2/T36 (AZ-S3, review 731415a7 B3): a role mutation that would
    // record a CROSS-BOUND Agent role refuses BEFORE the write — an Agent
    // bound to Task A is never Shepherd/Verifier of Task B. The refusal is
    // audited with the affected chain.
    const crossBound = principals.find((principal) =>
      principal && principal.kind === 'agent' && !principal.legacyIdentity
      && principal.boundTaskId && principal.boundTaskId !== req.params.id);
    if (crossBound) {
      await auditService.record({
        action: 'task.role_assign', actor: auditActorFromRequest(req as AuthRequest), outcome: 'denied',
        resourceType: 'task', resourceId: req.params.id,
        metadata: {
          refusal: 'CROSS_BOUND_ROLE',
          agentPrincipalId: crossBound.id,
          boundTaskId: crossBound.boundTaskId,
          chain: await auditChainFor(pool, crossBound.id),
        },
      }).catch(() => undefined);
      sendApiError(res, 422, 'CROSS_BOUND_ROLE',
        'An Agent identity is task-bounded (design 4d961e37 §8.2/T36): it can hold roles only on its bound Task');
      return;
    }

    const shepherd = body.shepherdPrincipalId
      ? principals[roleIds.indexOf(body.shepherdPrincipalId as string)]
      : undefined;
    const scopes = (req as AuthRequest).scopes;
    if (shepherd?.kind === 'service' && !scopesSatisfy(scopes, 'services:invoke')) {
      sendApiError(
        res,
        403,
        'SERVICE_INVOKE_REQUIRED',
        'Assigning a Service Principal as Shepherd requires services:invoke or root',
      );
      return;
    }

    const outcome = await taskManager.assignTaskRoles(req.params.id, {
      shepherdPrincipalId: body.shepherdPrincipalId as string | undefined,
      verifierPrincipalId: body.verifierPrincipalId as string | null | undefined,
    }, auditActorFromRequest(req as AuthRequest));
    if (outcome === 'not_found') {
      sendApiError(res, 404, 'TASK_NOT_FOUND', 'Task not found');
      return;
    }
    if (outcome === 'self_review') {
      sendApiError(res, 409, 'CLAIMANT_VERIFIER_CONFLICT', 'The Assignee and Verifier must be different Principals');
      return;
    }
    if (outcome === 'unavailable') {
      sendApiError(res, 503, 'TASK_ROLE_ASSIGNMENT_UNAVAILABLE', 'Task role assignment is unavailable');
      return;
    }
    const task = await taskManager.getTask(req.params.id);
    res.json({ success: true, task });
  } catch {
    sendApiError(res, 503, 'TASK_ROLE_ASSIGNMENT_UNAVAILABLE', 'Task role assignment is unavailable');
  }
});

/**
 * PATCH /tasks/:id
 * Update an existing task
 */
router.patch('/:id', idempotent('task.patch'), async (req: Request, res: Response): Promise<void> => {
  try {
    if (rejectCallerWrittenTaskRoles(req, res)) return;
    const updates = await resolveExecutionProfileWrite({ ...req.body }, req);
    if (updates.phaseId !== undefined) updates.phaseId = normalizePhaseIdWrite(updates.phaseId);
    // The same function the create route calls, so the two surfaces cannot
    // drift about what `notes` means. `in` rather than `!== undefined`: an
    // explicit `notes: undefined` is absence, and both are left absent.
    if ('notes' in updates) updates.notes = normalizeTaskNotesWrite(updates.notes);
    let dueAtResolution: DueAtResolution | undefined;
    if ('dueAt' in updates) {
      const normalized = await normalizeTaskDueAtWrite(updates.dueAt, dueAtResolver);
      updates.dueAt = normalized.value;
      dueAtResolution = normalized.resolution;
    }
    delete updates.id; // Don't allow ID changes
    delete updates.created; // Don't allow created timestamp changes

    // Validate thinking level if provided
    const validThinkingLevels = ['low', 'medium', 'high'];
    if (updates.thinking && !validThinkingLevels.includes(updates.thinking)) {
      res.status(400).json({ success: false, error: `Invalid thinking level: "${updates.thinking}". Must be one of: ${validThinkingLevels.join(', ')}` });
      return;
    }

    // Agent role enforcement for task status moves
    let dodWarning: string | undefined;
    let priorStatus: string | undefined;
    if (updates.status) {
      const role = getRequestAutomationRole(req);
      if (role === 'agent' && !AGENT_ALLOWED_TASK_STATUSES.includes(updates.status)) {
        res.status(403).json({
          success: false,
          error: `Agents cannot move tasks to '${updates.status}'. Allowed: ${AGENT_ALLOWED_TASK_STATUSES.join(', ')}. Only the orchestrator can mark tasks as completed.`
        });
        return;
      }

      // Lifecycle gate (non-blocking): warn on ideas -> todo without a
      // definitionOfDone. The move still succeeds; the response carries a
      // 'warning' field callers may surface (CLI prints it).
      const existing = await taskManager.getTask(req.params.id);
      if (existing) {
        priorStatus = existing.status;
        const effectiveDod = updates.definitionOfDone !== undefined
          ? updates.definitionOfDone
          : (existing as any).definitionOfDone;
        dodWarning = dodWarningForStatusChange(existing.status, updates.status, effectiveDod);
      }
    }

    const task = await taskManager.updateTask(
      req.params.id,
      updates,
      requestActor(req),
      // Card 9c177e6a: `updates.project` rewrites `project_id`, so the generic
      // PATCH is a MOVE surface and carries the same target decision the
      // create does. The catch below already relays a RequestFaultError by
      // class, so the refusal arrives as 404 PROJECT_NOT_FOUND.
      authorizedProjectTarget(req as AuthRequest),
    );

    // Unified archive policy (task 7d2a60a6): PATCH status->archived carries
    // the same warning as POST /tasks/:id/archive when the task was not
    // completed at archive time. The optional body field `archiveReason`
    // flowed through updates into updateTask, which appended it to task notes.
    let archiveWarning: string | undefined;
    if (updates.status === 'archived' && priorStatus && priorStatus !== 'archived') {
      archiveWarning = archiveWarningForStatus(
        priorStatus,
        (task.archiveDisposition ?? 'abandoned') as ArchiveDisposition
      );
    }

    // Add computed dependency fields (same as GET endpoints)
    const taskWithDeps = {
      ...task,
      blocked: await taskManager.isTaskBlocked(task.id),
      blockingTasks: (await taskManager.getBlockingTasks(task.id)).map(t => ({ id: t.id, title: t.title })),
      dependentTasks: (await taskManager.getDependentTasks(task.id)).map(t => ({ id: t.id, title: t.title })),
    };

    // dodWarning (ideas->todo) and archiveWarning (->archived) are mutually
    // exclusive transitions, but join defensively if both ever appear.
    const warning = [dodWarning, archiveWarning].filter(Boolean).join('; ') || undefined;
    res.json({
      success: true,
      task: taskWithDeps,
      ...(warning ? { warning } : {}),
      ...(dueAtResolution ? { dueAtResolution } : {}),
    });
  } catch (err) {
    if (sendLifecyclePolicyError(res, err)) return;
    if (err instanceof ProfileValidationError) {
      // Fixed-text diagnostics only — the profile pipeline's messages are
      // board-authored and the raw object never reaches the log sink.
      const errorId = logCaughtFailure('[Tasks API] execution-profile write refused', err);
      res.status(err.status).json({ success: false, error: err.message, code: err.code, errorId, ...(err.field ? { field: err.field } : {}) });
      return;
    }
    // RH-P3.AZ-S7: the coupling's refusals are contract answers, not
    // failures — a caller must learn that its assignment had no viable
    // access vehicle, and with which code (ruling 7440b579 R1).
    if (err instanceof AssignmentAccessError) {
      const errorId = logCaughtFailure('[Tasks API] assignment-access coupling refused the write', err);
      res.status(err.status).json({ success: false, error: err.message, code: err.code, errorId, ...(err.field ? { field: err.field } : {}) });
      return;
    }
    if (sendPhaseBindingRefusal(res, err)) return;
    if (sendTaskFieldRefusal(res, err)) return;
    if (isStringTooLongError(err)) { sendStringTooLongError(res, 'task', err); return; }
    if (err instanceof DependencyValidationError) {
      res.status(400).json({ success: false, error: err.message, code: err.code, offendingIds: err.offendingIds });
      return;
    }
    if (err instanceof RequestFaultError) {
      res.status(err.status).json({ success: false, code: err.code, error: err.message });
      return;
    }
    const errorId = logCaughtFailure('[Tasks API] Error updating task:', err);
    res.status(500).json({ success: false, code: 'TASK_UPDATE_FAILED', error: 'The task could not be updated', errorId });
  }
});

/**
 * PATCH /tasks/{id}/access — the exceptional Task confidentiality mode.
 *
 * Privileged, explicit and audited, exactly as `PATCH /phases/{id}/access` is
 * (owner ruling 44ee41f2; migration 117). It is a SEPARATE route from the
 * ordinary content PATCH on purpose: no content edit can reach the column, so
 * inheritance semantics can never change as a side effect of an edit or of
 * adding a grant. It rides `tasks:admin` in `scopeMap` and the shared
 * point-authorization gate classifies an `/access` tail as the `admin` action.
 *
 * There is no `revision` key here because `tasks` carries no revision column;
 * the service takes a row lock and refuses a no-op flip with 409 instead.
 */
router.patch('/:id/access', async (req: Request, res: Response): Promise<void> => {
  try {
    if (rejectInvalidTaskIdParam(req.params.id, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const unknownKeys = Object.keys(body).filter((key) => key !== 'restricted' && key !== 'reason');
    if (unknownKeys.length > 0) {
      res.status(400).json({
        success: false, code: 'UNKNOWN_BODY_KEY',
        error: 'Only restricted and reason may be sent to the Task access policy',
      });
      return;
    }
    const actorPrincipalId = (req as AuthRequest).principal?.id;
    if (!actorPrincipalId) {
      res.status(403).json({
        success: false, code: 'PRINCIPAL_REQUIRED',
        error: 'A resolved Principal is required for Task access-policy changes',
      });
      return;
    }
    const policy = await taskAccessService.setRestrictedAccess(req.params.id, {
      restricted: body.restricted, reason: body.reason, actorPrincipalId,
    });
    res.json({ success: true, task: { id: policy.taskId, restrictedAccess: policy.restrictedAccess } });
  } catch (err) {
    if (err instanceof RequestFaultError) {
      res.status(err.status).json({ success: false, code: err.code, error: err.message });
      return;
    }
    const errorId = logCaughtFailure('[Tasks API] Error changing the Task access policy:', err);
    res.status(500).json({
      success: false, code: 'TASK_ACCESS_FAILED',
      error: 'The Task access policy could not be changed', errorId,
    });
  }
});

/**
 * DELETE /tasks/:id
 * Delete a task (and its subtasks)
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await taskManager.deleteTask(req.params.id);
    res.json({ success: true });
  } catch (err) {
    if (sendLifecyclePolicyError(res, err)) return;
    if (err instanceof NotFoundFault) {
      res.status(err.status).json({ success: false, code: err.code, error: err.message });
    } else {
      const errorId = logCaughtFailure('[Tasks API] Error deleting task:', err);
      res.status(500).json({ 
        success: false, 
        error: 'The task could not be deleted',
        code: 'TASK_DELETE_FAILED',
        errorId
      });
    }
  }
});

/**
 * POST /tasks/:id/notes  { text }
 *
 * Server-side append with a timestamped attribution line. Notes live in a
 * single TEXT column (migration 041), so every client that appends by reading,
 * concatenating and PATCHing races every other one — the last writer silently
 * discards whatever landed in between. Appending in one statement inside the
 * database removes the race entirely, which matters most for the MCP notes
 * tool and for concurrent agents writing progress to the same task.
 */
router.post('/:id/notes', idempotent('task.note.append'), async (req: Request, res: Response): Promise<void> => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) {
      res.status(400).json({ success: false, error: 'text is required' });
      return;
    }
    if (text.length > 20000) {
      res.status(400).json({ success: false, error: 'text must be 20000 characters or fewer' });
      return;
    }

    const actor = requestActor(req);
    const stamp = new Date().toISOString();
    // Indent the body so caller text cannot forge a line that reads like a
    // server-written attribution header. Without this, a note containing
    // "\n\n[<timestamp>] someone_else:" is byte-identical to a genuine entry,
    // which defeats the point of attributing notes at all.
    // Split on CR, LF and CRLF: a lone \r still starts a new rendered line in
    // terminals and in CSS segment-break handling, so splitting on \n alone
    // would leave an unindented line that imitates the header.
    const indented = text.split(/\r\n|\r|\n/).map((line: string) => `  ${line}`).join('\n');
    const entry = `\n\n[${stamp}] ${actor.handle}:\n${indented}`;

    // COALESCE so the first note on a task with NULL notes still lands.
    // RH-P3.C1 (round 3 review): the note append is a Task write every feed
    // consumer can observe, and this route bypasses TaskManagerDB — so the
    // append and its task.updated emission commit or vanish together here.
    const client = await pool.connect();
    let updated;
    try {
      await client.query('BEGIN');
      updated = await client.query(
        `UPDATE tasks SET notes = COALESCE(notes, '') || $2, updated_at = NOW()
          WHERE id = $1
          RETURNING id, title, notes, project_id, owner_principal_id`,
        [req.params.id, entry]
      );
      if (updated.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ success: false, error: 'Task not found' });
        return;
      }
      await feedEventService.emit(client, {
        name: 'task.updated',
        objectType: 'task',
        objectId: updated.rows[0].id,
        actorPrincipalId: actor.principalId ?? null,
        actorHandle: actor.handle ?? null,
        projectId: updated.rows[0].project_id ?? null,
        ownerPrincipalId: updated.rows[0].owner_principal_id ?? null,
        payload: {},
      });
      await client.query('COMMIT');
    } catch (txnError) {
      await client.query('ROLLBACK');
      throw txnError;
    } finally {
      client.release();
    }

    // This endpoint writes notes by direct SQL rather than through
    // TaskManagerDB.updateTask, so it does NOT inherit that path's history
    // recording — the attribution row has to be written here explicitly. It
    // was missing, which made "no notes mutation is invisible" false on the
    // one endpoint built for writing notes.
    taskHistoryService.recordChange(
      updated.rows[0].id, updated.rows[0].title, 'notes', null, null,
      actor.handle, actor.principalId
    );

    res.json({ success: true, taskId: updated.rows[0].id, appended: entry.trim() });
  } catch (err) {
    if (isStringTooLongError(err)) {
      sendStringTooLongError(res, 'task note', err);
      return;
    }
    const errorId = logCaughtFailure('[Tasks API] Error appending note:', err);
    res.status(500).json({ success: false, error: 'The note could not be appended', code: 'NOTE_APPEND_FAILED', errorId });
  }
});

/**
 * POST /tasks/:id/archive
 * Archive a task from ANY status (unified archive policy, task 7d2a60a6).
 * Body (optional): { reason?: string } — appended to task notes as
 * "Archived (<disposition>): <reason>". `archiveReason` is accepted as an
 * alias to mirror the PATCH body field.
 * Response: { success, archived, disposition, warning?, task } — `warning`
 * ("archiving non-completed task (disposition: ...)") is present when the
 * task was not completed at archive time.
 */
/**
 * POST /tasks/bulk-archive — bulk archive of COMPLETED Tasks by explicit id
 * list (design 986be411 §4, E3). Body: { taskIds: string[], reason? }.
 * Server cap 200 ids per request (client batches above it). Per-Task
 * results are reported honestly — partial failure is data, never a silent
 * skip. Each archived Task carries the same audit trail as a single archive.
 */
const BULK_ARCHIVE_CAP = 200;
router.post('/bulk-archive', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body || {};
    const taskIds = body.taskIds;
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      res.status(400).json({ success: false, error: 'taskIds must be a non-empty array of Task ids' });
      return;
    }
    if (taskIds.length > BULK_ARCHIVE_CAP) {
      res.status(400).json({
        success: false,
        error: `taskIds exceeds the server cap of ${BULK_ARCHIVE_CAP}; batch the request`,
        code: 'BULK_CAP_EXCEEDED',
        cap: BULK_ARCHIVE_CAP,
      });
      return;
    }
    const invalid = taskIds.filter((id: unknown) => typeof id !== 'string' || !isValidTaskId(id as string));
    if (invalid.length > 0) {
      res.status(400).json({ success: false, error: `taskIds must be full Task UUIDs (${invalid.length} invalid)` });
      return;
    }
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason : undefined;
    // Per-Task WRITE authority before any mutation (review d2ed1775 B2). An
    // out-of-grant Task reports NOT_FOUND — concealment: the caller learns
    // nothing an unauthorized point read would not already refuse.
    const writableIds = new Set(await filterAuthorizedResources(
      req as AuthRequest,
      'write',
      taskIds as string[],
      (id: string) => ({ type: 'task', id }),
    ));
    const outcome = await taskManager.bulkArchiveCompleted(
      (taskIds as string[]).filter(id => writableIds.has(id)),
      { reason },
      requestActor(req)
    );
    const byId = new Map(outcome.results.map(result => [result.id, result]));
    const results = (taskIds as string[]).map(id => byId.get(id)
      ?? { id, archived: false, code: 'NOT_FOUND' as const, error: 'Task not found' });
    const archivedCount = results.filter(r => r.archived).length;
    res.json({ success: true, results, archivedCount, failedCount: results.length - archivedCount });
  } catch (err) {
    // Safety floor (review f98d127b B1): fixed envelope, never the exception.
    const errorId = logCaughtFailure('[Tasks API] Error bulk-archiving tasks:', err);
    res.status(500).json({ success: false, error: 'The bulk archive could not be executed', code: 'BULK_ARCHIVE_FAILED', errorId });
  }
});

/**
 * POST /tasks/:id/unarchive — unarchive to the PRIOR state (design 986be411
 * §4, owner ruling E5; resolves 7092b73d): history-derived target with
 * fallback Completed. 409 when the Task is not archived.
 * Response: { success, task, restoredTo, derivedFrom: 'history' | 'fallback' }.
 */
router.post('/:id/unarchive', async (req: Request, res: Response): Promise<void> => {
  try {
    if (rejectInvalidTaskIdParam(req.params.id, res)) return;
    const result = await taskManager.unarchiveTask(req.params.id, requestActor(req));
    res.json(result);
  } catch (err) {
    if (sendLifecyclePolicyError(res, err)) return;
    // Known domain outcomes are identified by CLASS, never message substring,
    // and their response text is constructed from fixed wording + the
    // VALIDATED request id (reviews f98d127b B1, 14c7f96d B1). Anything
    // unexpected serializes as the FIXED 500 envelope.
    if (err instanceof TaskNotFoundError) {
      res.status(404).json({ success: false, error: `Task not found: ${req.params.id}` });
    } else if (err instanceof TaskNotArchivedError) {
      res.status(409).json({ success: false, error: `Task is not archived: ${req.params.id}`, code: 'NOT_ARCHIVED' });
    } else {
      const errorId = logCaughtFailure('[Tasks API] Error unarchiving task:', err);
      res.status(500).json({ success: false, error: 'The Task could not be unarchived', code: 'UNARCHIVE_FAILED', errorId });
    }
  }
});

router.post('/:id/stream', idempotent('task.stream.append'), async (req: Request, res: Response): Promise<void> => {
  try {
    if (rejectInvalidTaskIdParam(req.params.id, res)) return;
    if (req.body?.provenance === 'reported' && !scopesSatisfy((req as AuthRequest).scopes, 'services:write')) {
      sendApiError(res, 403, 'OUTPOST_AUTHORITY_REQUIRED', 'Reported entries require Service write authority');
      return;
    }
    const result = await taskElementService.append(req.params.id, req.body || {}, taskElementActor(req));
    res.status(req.body?.dryRun ? 200 : 201).json({ success: true, ...result });
  } catch (error) {
    sendTaskElementError(res, error);
  }
});

router.post('/:id/finish', async (req: Request, res: Response): Promise<void> => {
  try {
    if (rejectInvalidTaskIdParam(req.params.id, res)) return;
    const result = await taskElementService.finish(req.params.id, req.body || {}, taskElementActor(req));
    res.json(result);
  } catch (error) {
    sendTaskElementError(res, error);
  }
});

router.post('/:id/references', idempotent('task.reference.create'), async (req: Request, res: Response): Promise<void> => {
  try {
    if (rejectInvalidTaskIdParam(req.params.id, res)) return;
    const reference = await taskElementService.createReference(req.params.id, req.body || {}, taskElementActor(req));
    res.status(req.body?.dryRun ? 200 : 201).json({ success: true, reference });
  } catch (error) {
    sendTaskElementError(res, error);
  }
});

router.post('/:id/stream/:entryId/redact', async (req: Request, res: Response): Promise<void> => {
  try {
    if (rejectInvalidTaskIdParam(req.params.id, res)) return;
    const entry = await taskElementService.redact(
      req.params.id,
      req.params.entryId,
      req.body || {},
      taskElementActor(req),
    );
    res.json({ success: true, entry });
  } catch (error) {
    sendTaskElementError(res, error);
  }
});

router.post('/:id/archive', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body || {};
    const reason = typeof body.reason === 'string' && body.reason.trim()
      ? body.reason
      : (typeof body.archiveReason === 'string' ? body.archiveReason : undefined);
    const result = await taskManager.archiveTask(req.params.id, { reason }, requestActor(req));
    res.json(result);
  } catch (err) {
    if (sendLifecyclePolicyError(res, err)) return;
    if (err instanceof NotFoundFault) {
      res.status(err.status).json({ success: false, code: err.code, error: err.message });
    } else {
      const errorId = logCaughtFailure('[Tasks API] Error archiving task:', err);
      res.status(400).json({ 
        success: false, 
        error: 'The task could not be archived',
        code: 'TASK_ARCHIVE_FAILED',
        errorId
      });
    }
  }
});

/**
 * POST /tasks/:id/brief — the TASK ALTITUDE of the Brief family.
 *
 * Compile and return the full agent Brief for this task — generation only, no
 * execution and no side effects (strategy §2.3).
 * Returns { brief, model, thinking, taskId }.
 *
 * RH-P3.C4 integration (ii), owner decision D4: this is the contracted
 * Phase-3 removal of the pre-A7 spelling. `/tasks/:id/prompt` and the `prompt`
 * response key are GONE — not aliased. Vocabulary `b94dd86e` §7 retires
 * `prompt`, `spawn-prompt`, `generate-brief`, "compiler" and "bootstrap
 * payload" with the words "nothing in this column survives as an alias", and
 * §3 ratifies one verb and one noun across four altitudes: task, phase,
 * project and session. All four are now spelled the same way.
 *
 * The `/tasks/:id/spawn-prompt` alias went in RH-P3.C5 (the A12-contracted
 * removal); this completes the family.
 */
async function handleCompiledBrief(req: Request, res: Response): Promise<void> {
  // RH-P3.C5 compile options, validated before any lookup: opt-in Report
  // inlining (the C4 default is IDs + summaries), a caller-declared token
  // budget, and the optional AGENTS.md shape.
  const body = req.body ?? {};
  const parsed = parseBriefInlineOptions(body);
  if (!parsed.ok) {
    res.status(400).json({ success: false, code: parsed.code, error: parsed.error });
    return;
  }
  const { inlineReports, tokenBudget } = parsed;
  const format = body.format === undefined ? 'markdown' : body.format;
  if (format !== 'markdown' && format !== 'agentsmd') {
    res.status(400).json({ success: false, code: 'INVALID_COMPILE_OPTION', error: "format must be 'markdown' or 'agentsmd'" });
    return;
  }

  const task = await taskManager.getTask(req.params.id);
  if (!task) {
    res.status(404).json({ success: false, error: 'Task not found' });
    return;
  }
  let brief: string;
  try {
    // The compiler evaluates the CALLING principal's grants for referenced
    // Reports (strategy 2.3): the compile is a disclosure act by the caller.
    brief = await generateTaskPromptWithSkills(task, {
      actor: actorFromRequest(req as AuthRequest),
      inlineReports,
      tokenBudget,
    });
  } catch (err) {
    // Review 6fa91e28 F1: when Charter existence cannot be established the
    // Brief fails closed — a success response without the authority index
    // would hand an agent a seemingly complete Brief missing the project's
    // governing agreements.
    if (err instanceof PhaseLookupError) {
      // Same fail-closed contract as the Charter (review 1a786ae4 F2): a
      // bound Phase whose lookup failed is not confirmed absence, and a Brief
      // missing the goal E-12 requires must not be returned as a success.
      // PhaseLookupError deliberately carries no adapter detail, so its
      // message is only the surface and the board-native task id.
      const errorId = logCaughtFailure('[Tasks API] Phase lookup failed while compiling a Brief:', err);
      res.status(503).json({
        success: false,
        errorId,
        error: 'The Brief could not establish this task\'s phase goal',
        code: 'PHASE_LOOKUP_FAILED',
        message: 'The Brief could not establish this task\'s phase goal; refusing to compile without it',
      });
      return;
    }
    if (err instanceof ReportReferenceLookupError) {
      // Same fail-closed contract as the Charter and the Phase goal: a Brief
      // silently missing references the caller is entitled to must not
      // compile as a success.
      const errorId = logCaughtFailure('[Tasks API] Referenced-report lookup failed while compiling a Brief:', err);
      res.status(503).json({
        success: false,
        errorId,
        error: 'The Brief could not establish this task\'s referenced reports',
        code: 'REPORT_REFERENCE_LOOKUP_FAILED',
        message: 'The Brief could not establish this task\'s referenced reports; refusing to compile without them',
      });
      return;
    }
    if (err instanceof CharterLookupError) {
      // Reviews a2b2f742 F1 + b45fb44e F1: the envelope is FIXED text, and
      // the log line is too — CharterLookupError deliberately carries no
      // adapter detail (the safety floor covers logs as well as responses),
      // so err.message is only the surface + board-native project id.
      const errorId = logCaughtFailure('[Tasks API] Charter lookup failed while compiling a Brief:', err);
      res.status(503).json({
        success: false,
        errorId,
        error: 'The Brief compiler could not establish whether this project has a Charter',
        code: 'CHARTER_LOOKUP_FAILED',
        message: 'The Brief compiler could not establish whether this project has a Charter; refusing to compile without the authority index',
      });
      return;
    }
    throw err;
  }
  if (format === 'agentsmd') {
    brief = renderAgentsMdShape(brief, task);
  }
  const configuredDefaultModel = await getConfiguredDefaultModel('openai-codex/gpt-5.4');
  const model = req.body?.model || task.model || configuredDefaultModel;
  const thinking = req.body?.thinking || 'low';
  res.json({
    success: true,
    brief,
    model,
    thinking,
    taskId: task.id,
    format,
    tokenEstimate: Math.ceil(brief.length / 4),
  });
}

router.post('/:id/brief', async (req: Request, res: Response): Promise<void> => {
  await handleCompiledBrief(req, res);
});

// POST /tasks/:id/spawn-prompt went in RH-P3.C5 and POST /tasks/:id/prompt
// goes here (D4). Neither is aliased: vocabulary §7 says nothing in the
// retired column survives as an alias, and an alias is how a retired word
// stays alive in every client that never had to change.

/**
 * POST /tasks/:id/claim — become the task's Assignee (Phase 1, spec §3.3).
 * Idempotent for the current Assignee; someone-else-is-Assignee → 409.
 */
router.post('/:id/claim', async (req: Request, res: Response): Promise<void> => {
  try {
    const callerPrincipal = (req as AuthRequest).principal;
    if (!callerPrincipal) {
      res.status(400).json({ success: false, error: 'Claiming requires a resolved principal identity' });
      return;
    }
    const outcome = await taskManager.claimTask(req.params.id, callerPrincipal.id);
    if (outcome === 'not_found') {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }
    if (outcome === 'conflict') {
      res.status(409).json({ success: false, error: 'Another principal is already the Assignee of this task' });
      return;
    }
    if (outcome === 'self_review') {
      sendApiError(
        res,
        409,
        'CLAIMANT_VERIFIER_CONFLICT',
        'The assigned Verifier cannot become the Assignee of the same task',
      );
      return;
    }
    if (outcome === 'unarmed') {
      sendApiError(res, 409, 'TASK_NOT_ARMED', 'This Task is parked. Arm it explicitly before claiming it.');
      return;
    }
    if (outcome === 'dependency_blocked') {
      sendApiError(res, 409, 'TASK_DEPENDENCY_BLOCKED', 'This Task cannot be claimed until every dependency is semantically completed.');
      return;
    }
    if (outcome === 'unavailable') {
      res.status(503).json({ success: false, error: 'Task assignment is unavailable until the identity substrate is migrated' });
      return;
    }
    const task = await taskManager.getTask(req.params.id);
    res.json({ success: true, task });
  } catch (err) {
    const errorId = logCaughtFailure('[Tasks API] Error claiming task:', err);
    res.status(500).json({ success: false, error: 'The task could not be claimed', code: 'TASK_CLAIM_FAILED', errorId });
  }
});

/**
 * POST /tasks/:id/recover — RH-P3.C3: the shepherd's ONE-CLICK MELTDOWN
 * RECOVERY (strategy 4e40f06f §2.6.4, RATIFIED 2026-08-02 — C4).
 *
 * Force-release + reassign, seeded from the last good report, as ONE call.
 * The shared point predicate has already authorized `shepherd` on this Task
 * before the handler runs (sharedAuthorization classifies the `recover`
 * tail), so this handler adds exactly one thing on top: the reassignment
 * target goes through the SAME `resolveExecutionProfileWrite` pipeline every
 * other assignment write uses. That is not decoration —
 * vocabulary b94dd86e §5.3 requires it: "Shepherd reassignment to a Service
 * additionally requires `invoke` on that Service or assignment authority
 * over it — a role change must not become a covert execution grant."
 * Reusing the pipeline means the `services:invoke` check and the descriptor
 * validation are the identical ones, and a recovery can never become a door
 * around them.
 *
 * Body: { executionProfile: { serviceId, descriptorVersion, options },
 *         executionWarrantId?, reason? }
 */
router.post('/:id/recover', async (req: Request, res: Response): Promise<void> => {
  try {
    if (rejectInvalidTaskIdParam(req.params.id, res)) return;
    const callerPrincipal = (req as AuthRequest).principal;
    if (!callerPrincipal) {
      sendApiError(res, 400, 'PRINCIPAL_REQUIRED', 'Meltdown recovery requires a resolved principal identity');
      return;
    }
    const body = req.body || {};
    // The reassignment is REQUIRED. Force-release on its own is already a
    // route (POST /tasks/:id/release under orchestrator authority); what
    // §2.6.4 ratified here is the combined act, and a recovery that put the
    // work back with no assignee would fire no `task.ready` and rescue
    // nothing.
    if (body.executionProfile === undefined || body.executionProfile === null) {
      sendApiError(
        res,
        400,
        'REASSIGNMENT_REQUIRED',
        'Meltdown recovery is force-release AND reassign: send the executionProfile naming the Connector the work restarts on',
        undefined,
        { field: 'executionProfile' },
      );
      return;
    }
    const resolved = await resolveExecutionProfileWrite(
      { executionProfile: body.executionProfile, executionWarrantId: body.executionWarrantId },
      req,
    );
    const outcome = await taskManager.recoverTask(
      req.params.id,
      {
        executionServiceId: resolved.executionServiceId,
        executionProfile: resolved.executionProfile,
        executionDescriptorVersion: resolved.executionDescriptorVersion ?? null,
        executionWarrantId: resolved.executionWarrantId ?? null,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
      },
      requestActor(req),
    );
    if (outcome.outcome === 'not_found') {
      sendApiError(res, 404, 'TASK_NOT_FOUND', 'Task not found');
      return;
    }
    if (outcome.outcome === 'task_terminal') {
      sendApiError(
        res,
        409,
        'TASK_TERMINAL',
        `A ${outcome.previousStatus} Task has no meltdown to recover from`,
      );
      return;
    }
    if (outcome.outcome === 'unavailable') {
      sendApiError(res, 503, 'RECOVERY_UNAVAILABLE', 'Meltdown recovery is unavailable until the identity substrate is migrated');
      return;
    }
    const task = await taskManager.getTask(req.params.id);
    res.json({ success: true, recovery: outcome, task });
  } catch (err) {
    if (err instanceof ProfileValidationError) {
      const errorId = logCaughtFailure('[Tasks API] meltdown-recovery reassignment refused', err);
      res.status(err.status).json({ success: false, error: err.message, code: err.code, errorId, ...(err.field ? { field: err.field } : {}) });
      return;
    }
    // RH-P3.AZ-S7 (ruling 7440b579 R1): the coupling's refusal is a contract
    // answer. The recovery rolled back with it, so the Task keeps the
    // claimant and the assignment it had — a refused reassignment must never
    // leave the work force-released into nobody's hands.
    if (err instanceof AssignmentAccessError) {
      const errorId = logCaughtFailure('[Tasks API] assignment-access coupling refused the recovery', err);
      res.status(err.status).json({ success: false, error: err.message, code: err.code, errorId, ...(err.field ? { field: err.field } : {}) });
      return;
    }
    const errorId = logCaughtFailure('[Tasks API] Error recovering task:', err);
    res.status(500).json({ success: false, code: 'TASK_RECOVERY_FAILED', error: 'The task could not be recovered', errorId });
  }
});

/**
 * POST /tasks/:id/release — clear the Assignee. The current Assignee may always
 * release; orchestrator authority may release any task.
 */
router.post('/:id/release', async (req: Request, res: Response): Promise<void> => {
  try {
    const callerPrincipal = (req as AuthRequest).principal;
    if (!callerPrincipal) {
      res.status(400).json({ success: false, error: 'Releasing requires a resolved principal identity' });
      return;
    }
    const actor = actorFromRequest(req as AuthRequest);
    const releaseTarget = await taskManager.getTask(req.params.id);
    const assignedShepherd = releaseTarget?.shepherdPrincipalId === actor.principalId;
    const force = getRequestAutomationRole(req) === 'orchestrator' || Boolean(releaseTarget && assignedShepherd
      && (await authorizationRepository.authorizePoint(actor, 'task', releaseTarget.id, 'shepherd')).allowed);
    const outcome = await taskManager.releaseTask(
      req.params.id,
      callerPrincipal.id,
      force,
      auditActorFromRequest(req as AuthRequest),
    );
    if (outcome === 'not_found') {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }
    if (outcome === 'conflict') {
      res.status(409).json({ success: false, error: 'Another principal is the Assignee of this task' });
      return;
    }
    if (outcome === 'unavailable') {
      res.status(503).json({ success: false, error: 'Task assignment is unavailable until the identity substrate is migrated' });
      return;
    }
    const task = await taskManager.getTask(req.params.id);
    res.json({ success: true, task });
  } catch (err) {
    const errorId = logCaughtFailure('[Tasks API] Error releasing task:', err);
    res.status(500).json({ success: false, error: 'The task could not be released', code: 'TASK_RELEASE_FAILED', errorId });
  }
});

/**
 * GET /tasks/:id/session-status
 * Pull-side session evidence for a task. Live-runtime inspection was removed
 * with the execution runtime (P1.2 wave 2, strategy §2.8); this now serves
 * only the canonical task-attempt evidence contract plus the task's own
 * linkage fields.
 */
router.get('/:id/session-status', async (req: Request, res: Response): Promise<void> => {
  try {
    const task = await taskManager.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }

    const sessionKey = task.acpSessionKey || task.activeAgent?.sessionKey;
    // Legacy-read path (RH-P2.2): harness/mode live only in held legacy
    // blobs now — the pickup contract itself is RH-P3.1 scope.
    const harness = task.legacyExecutionProfile?.harness
      || task.activeAgent?.harness
      || (typeof sessionKey === 'string' && sessionKey.startsWith('hermes:') ? 'hermes' : 'openclaw');
    const interactive = (task.executionMode || task.legacyExecutionProfile?.mode) === 'interactive';

    let canonicalRuntimeSignals: Awaited<ReturnType<typeof canonicalRuntimeSignalService.listTaskSignals>> = [];
    let canonicalRuntimeError: string | null = null;
    try {
      canonicalRuntimeSignals = await canonicalRuntimeSignalService.listTaskSignals(task.id);
    } catch (error) {
      canonicalRuntimeError = 'canonical runtime lookup failed';
      logCaughtWarning('[Tasks API] Canonical runtime lookup failed', error);
    }

    // RH-P3.C7: pushed telemetry frames are the primary liveness signal —
    // a fresh frame IS the state the chip shows, an old frame derives
    // 'stale' on the board clock, and with no frames at all the canonical
    // runtime signal keeps answering exactly as before. Lookup failure
    // degrades to the canonical path (telemetry is display, never
    // authority — its absence must not break the surface).
    let telemetryLiveness = null;
    try {
      telemetryLiveness = await telemetryService.livenessForTask(task.id);
    } catch (error) {
      logCaughtWarning('[Tasks API] Telemetry liveness lookup failed', error);
    }

    res.json({
      success: true,
      data: {
        taskId: task.id,
        sessionKey: sessionKey || null,
        acpSessionKey: task.acpSessionKey || null,
        executionMode: task.executionMode || task.legacyExecutionProfile?.mode || null,
        executionProfile: task.executionProfile || null,
        legacyExecutionProfile: task.legacyExecutionProfile || null,
        startedAt: task.startedAt || null,
        state: telemetryLiveness?.state || canonicalRuntimeSignals[0]?.state || 'none',
        telemetry: telemetryLiveness,
        label: task.activeAgent ? `Task: ${task.title}` : null,
        model: task.model || null,
        interactive,
        discordThreadId: task.discordThreadId || null,
        harness,
        canonicalRuntime: canonicalRuntimeSignals[0] || null,
        runtimeContract: {
          version: 'canonical-session-events-v1',
          available: canonicalRuntimeError === null,
          attemptCount: canonicalRuntimeSignals.length,
          ...(canonicalRuntimeError ? { reason: canonicalRuntimeError } : {}),
        },
      },
    });
  } catch (err) {
    const errorId = logCaughtFailure('[Tasks API] Error getting session status:', err);
    res.status(500).json({
      success: false,
      error: 'The session status could not be read',
      code: 'SESSION_STATUS_READ_FAILED',
      errorId,
    });
  }
});

/**
 * POST /tasks/:id/breakdown
 * Generate subtasks for a task using TaskAnalyzer
 */
router.post('/:id/breakdown', async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await taskAnalyzer.breakdownTask(req.params.id);
    if (!result) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }
    res.json({ 
      success: true, 
      subtasks: result.subtasks,
      confidence: result.confidence,
      method: result.method
    });
  } catch (err) {
    const errorId = logCaughtFailure('[Tasks API] Error breaking down task:', err);
    res.status(500).json({ 
      success: false, 
      error: 'The task could not be broken down',
      code: 'TASK_BREAKDOWN_FAILED',
      errorId
    });
  }
});

/**
 * POST /tasks/auto-archive
 * Manually trigger auto-archiving of old completed tasks
 */
router.post('/auto-archive', async (_req: Request, res: Response): Promise<void> => {
  try {
    const count = await taskManager.autoArchiveOldTasks();
    res.json({ success: true, archivedCount: count });
  } catch (err) {
    const errorId = logCaughtFailure('[Tasks API] Error auto-archiving:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Auto-archiving could not be run',
      code: 'AUTO_ARCHIVE_FAILED',
      errorId
    });
  }
});

// ============================================================
// Task Dependency Management APIs
// ============================================================

/**
 * GET /tasks/:id/dependencies
 * Get full dependency info for a task (both directions)
 * Returns { dependsOn: Task[], blockedBy: Task[] }
 */
router.get('/:id/dependencies', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const deps = await taskManager.getTaskDependencies(id);
    const blocked = await taskManager.isTaskBlocked(id);

    const dependsOn = await filterAuthorizedResources(
      req as AuthRequest,
      'read',
      deps.dependsOn,
      (task) => ({ type: 'task', id: task.id }),
    );
    const blockedBy = await filterAuthorizedResources(
      req as AuthRequest,
      'read',
      deps.blockedBy,
      (task) => ({ type: 'task', id: task.id }),
    );
    res.json({
      success: true,
      taskId: id,
      blocked,
      dependsOn: dependsOn.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        project: t.project,
      })),
      blockedBy: blockedBy.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        project: t.project,
      })),
    });
  } catch (err) {
    if (err instanceof NotFoundFault) {
      res.status(err.status).json({ success: false, code: err.code, error: err.message });
      return;
    }
    const errorId = logCaughtFailure('[Tasks API] Error getting dependencies:', err);
    res.status(500).json({ success: false, code: 'DEPENDENCIES_READ_FAILED', error: 'Task dependencies could not be read', errorId });
  }
});

/**
 * POST /tasks/:id/dependencies
 * Add a dependency (this task depends on another)
 * Body: { dependsOn: "task-uuid" }
 */
router.post('/:id/dependencies', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { dependsOn } = req.body;

    if (!dependsOn) {
      res.status(400).json({ success: false, error: 'dependsOn task ID is required' });
      return;
    }

    const dependencyTask = await taskManager.getTask(dependsOn);
    const visibleDependency = dependencyTask
      ? await filterAuthorizedResources(
        req as AuthRequest,
        'read',
        [dependencyTask],
        (task) => ({ type: 'task', id: task.id }),
      )
      : [];
    if (visibleDependency.length === 0) {
      sendApiError(res, 404, 'RESOURCE_NOT_FOUND', 'Resource not found');
      return;
    }

    await taskManager.addDependency(id, dependsOn, requestActor(req));

    // Return updated dependency info
    const deps = await taskManager.getTaskDependencies(id);
    const visibleDependsOn = await filterAuthorizedResources(
      req as AuthRequest,
      'read',
      deps.dependsOn,
      (task) => ({ type: 'task', id: task.id }),
    );
    const blocked = await taskManager.isTaskBlocked(id);

    res.status(201).json({
      success: true,
      taskId: id,
      blocked,
      dependsOn: visibleDependsOn.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
      })),
    });
  } catch (err) {
    if (err instanceof DependencyValidationError) {
      res.status(400).json({ success: false, error: err.message, code: err.code, offendingIds: err.offendingIds });
      return;
    }
    if (err instanceof NotFoundFault || err instanceof InvalidRequestFault) {
      res.status(err.status).json({ success: false, code: err.code, error: err.message });
      return;
    }
    const errorId = logCaughtFailure('[Tasks API] Error adding dependency:', err);
    res.status(500).json({ success: false, code: 'DEPENDENCY_ADD_FAILED', error: 'The dependency could not be added', errorId });
  }
});

/**
 * DELETE /tasks/:id/dependencies/:depTaskId
 * Remove a dependency
 */
router.delete('/:id/dependencies/:depTaskId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id, depTaskId } = req.params;

    await taskManager.removeDependency(id, depTaskId, requestActor(req));

    res.json({ success: true, taskId: id, removed: depTaskId });
  } catch (err) {
    if (err instanceof NotFoundFault) {
      res.status(err.status).json({ success: false, code: err.code, error: err.message });
      return;
    }
    const errorId = logCaughtFailure('[Tasks API] Error removing dependency:', err);
    res.status(500).json({ success: false, code: 'DEPENDENCY_REMOVE_FAILED', error: 'The dependency could not be removed', errorId });
  }
});

// ============================================================
// Phase 1 Hub Redesign: Subtask Status Management APIs
// ============================================================

/** PATCH /tasks/:id/subtasks/by-id/:subtaskId/status — preferred stable address. */
router.patch('/:id/subtasks/by-id/:subtaskId/status', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id, subtaskId } = req.params;
    const { status, reviewNote, blockedReason } = req.body || {};
    if (!/^\d+$/.test(subtaskId)) {
      sendApiError(res, 400, 'INVALID_SUBTASK_ID', 'subtaskId must be the stable numeric Subtask id');
      return;
    }
    if (!status || !VALID_SUBTASK_STATUSES.includes(status)) {
      sendApiError(res, 400, 'INVALID_SUBTASK_STATUS', `status must be one of: ${VALID_SUBTASK_STATUSES.join(', ')}`);
      return;
    }
    const actorRole = getRequestAutomationRole(req);
    const task = await taskManager.updateSubtaskStatusById(
      id, subtaskId, status, actorRole, reviewNote, blockedReason,
    );
    res.json({
      success: true,
      task,
      subtaskId,
      subtaskSummary: await (taskManager as any).getSubtaskSummaryAsync(id),
      hasBlocked: await (taskManager as any).hasBlockedSubtasks(id),
    });
  } catch (error) {
    if (error instanceof NotFoundFault || error instanceof ForbiddenFault) {
      res.status(error.status).json({ success: false, code: error.code, error: error.message });
      return;
    }
    const errorId = logCaughtFailure('[Tasks API] Error updating subtask by stable id:', error);
    res.status(500).json({ success: false, code: 'SUBTASK_UPDATE_FAILED', error: 'The subtask could not be updated', errorId });
  }
});

/** Shared validation for the stable-id Subtask verb family (task 228441cf). */
function invalidSubtaskIdParam(subtaskId: string, res: Response): boolean {
  if (!/^\d+$/.test(subtaskId)) {
    sendApiError(res, 400, 'INVALID_SUBTASK_ID', 'subtaskId must be the stable numeric Subtask id');
    return true;
  }
  return false;
}

/** POST /tasks/:id/subtasks/by-id/:subtaskId/approve — stable-id alias of the
 *  positional approve. Identical authorization (independent Verifier gate) and
 *  semantics: the id resolves inside the manager's row-locked transaction, so
 *  a concurrent reorder can never redirect the verb to a different Subtask. */
router.post('/:id/subtasks/by-id/:subtaskId/approve', async (req: Request, res: Response): Promise<void> => {
  try {
    if (await rejectNonReviewerAction(req, res, 'approve subtasks')) return;
    const { id, subtaskId } = req.params;
    if (invalidSubtaskIdParam(subtaskId, res)) return;
    const task = await taskManager.updateSubtaskStatusById(id, subtaskId, 'completed', 'reviewer');
    res.json({
      success: true,
      task,
      subtaskId,
      subtaskSummary: await (taskManager as any).getSubtaskSummaryAsync(id),
      allCompleted: await (taskManager as any).allSubtasksCompletedAsync(id),
    });
  } catch (err) {
    if (err instanceof NotFoundFault || err instanceof ForbiddenFault) {
      res.status(err.status).json({ success: false, code: err.code, error: err.message });
      return;
    }
    const errorId = logCaughtFailure('[Tasks API] Error approving subtask by id:', err);
    res.status(500).json({ success: false, code: 'SUBTASK_APPROVE_FAILED', error: 'The subtask could not be approved', errorId });
  }
});

/** POST /tasks/:id/subtasks/by-id/:subtaskId/reject — stable-id alias. */
router.post('/:id/subtasks/by-id/:subtaskId/reject', async (req: Request, res: Response): Promise<void> => {
  try {
    if (rejectImplementationAgentOrchestratorAction(req, res, 'reject subtasks')) return;
    const { id, subtaskId } = req.params;
    if (invalidSubtaskIdParam(subtaskId, res)) return;
    const { note } = req.body || {};
    const task = await taskManager.updateSubtaskStatusById(
      id, subtaskId, 'empty', 'orchestrator', note ? `REJECTED: ${note}` : undefined,
    );
    res.json({
      success: true,
      task,
      subtaskId,
      subtaskSummary: await (taskManager as any).getSubtaskSummaryAsync(id),
    });
  } catch (err) {
    if (err instanceof NotFoundFault || err instanceof ForbiddenFault) {
      res.status(err.status).json({ success: false, code: err.code, error: err.message });
      return;
    }
    const errorId = logCaughtFailure('[Tasks API] Error rejecting subtask by id:', err);
    res.status(500).json({ success: false, code: 'SUBTASK_REJECT_FAILED', error: 'The subtask could not be rejected', errorId });
  }
});

/** POST /tasks/:id/subtasks/by-id/:subtaskId/skip — stable-id alias. */
router.post('/:id/subtasks/by-id/:subtaskId/skip', async (req: Request, res: Response): Promise<void> => {
  try {
    if (rejectImplementationAgentOrchestratorAction(req, res, 'skip subtasks')) return;
    const { id, subtaskId } = req.params;
    if (invalidSubtaskIdParam(subtaskId, res)) return;
    const task = await taskManager.updateSubtaskStatusById(id, subtaskId, 'skipped', 'orchestrator');
    res.json({
      success: true,
      task,
      subtaskId,
      subtaskSummary: await (taskManager as any).getSubtaskSummaryAsync(id),
      allCompleted: await (taskManager as any).allSubtasksCompletedAsync(id),
    });
  } catch (err) {
    if (err instanceof NotFoundFault || err instanceof ForbiddenFault) {
      res.status(err.status).json({ success: false, code: err.code, error: err.message });
      return;
    }
    const errorId = logCaughtFailure('[Tasks API] Error skipping subtask by id:', err);
    res.status(500).json({ success: false, code: 'SUBTASK_SKIP_FAILED', error: 'The subtask could not be skipped', errorId });
  }
});

/** PUT /tasks/:id/subtasks/by-id/:subtaskId — stable-id alias of the
 *  positional edit. Same identity-derived authority rules; supports the same
 *  legacy {completed} and {status} bodies. Registered in the by-id family so
 *  the positional matcher never sees 'by-id' as an index. */
router.put('/:id/subtasks/by-id/:subtaskId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id, subtaskId } = req.params;
    if (invalidSubtaskIdParam(subtaskId, res)) return;
    const { completed, status, reviewNote, blockedReason } = req.body || {};

    let newStatus: SubtaskStatus;
    if (status !== undefined) newStatus = status;
    else if (completed !== undefined) newStatus = completed ? 'completed' : 'empty';
    else {
      res.status(400).json({ success: false, error: 'Either "status" or "completed" must be provided' });
      return;
    }

    // Authority comes from the authenticated identity only (same rule as the
    // positional route): no body or header escape hatch.
    const actorRole = getRequestAutomationRole(req);
    if (newStatus === 'completed' && actorRole !== 'qa' && actorRole !== 'reviewer') {
      res.status(403).json({ success: false, error: 'Only an independent Verifier identity can complete a subtask' });
      return;
    }
    if (!AGENT_ALLOWED_STATUSES.includes(newStatus) && actorRole === 'agent') {
      res.status(403).json({
        success: false,
        error: `Agents cannot set status to '${newStatus}'. Use ${AGENT_ALLOWED_STATUSES.join(' or ')} instead.`
      });
      return;
    }

    const task = await taskManager.updateSubtaskStatusById(id, subtaskId, newStatus, actorRole, reviewNote, blockedReason);
    const taskWithDeps = {
      ...task,
      blocked: await taskManager.isTaskBlocked(task.id),
      blockingTasks: (await taskManager.getBlockingTasks(task.id)).map(t => ({ id: t.id, title: t.title })),
      dependentTasks: (await taskManager.getDependentTasks(task.id)).map(t => ({ id: t.id, title: t.title })),
    };
    res.json({ success: true, task: taskWithDeps, subtaskId });
  } catch (err) {
    if (err instanceof NotFoundFault || err instanceof ForbiddenFault) {
      res.status(err.status).json({ success: false, code: err.code, error: err.message });
      return;
    }
    const errorId = logCaughtFailure('[Tasks API] Error updating subtask by id:', err);
    res.status(500).json({ success: false, code: 'SUBTASK_UPDATE_FAILED', error: 'The subtask could not be updated', errorId });
  }
});

/**
 * PATCH /tasks/:id/subtasks/:index/status
 * Update subtask status with role-based permissions
 * 
 * Body: { 
 *   status: 'empty' | 'in-progress' | 'review' | 'stuck' | 'skipped' | 'completed',
 *   role?: 'agent' | 'orchestrator', 
 *   reviewNote?: string,
 *   blockedReason?: string 
 * }
 * 
 * Role permissions:
 * - agent: can only set 'in-progress', 'review' or 'stuck'
 * - orchestrator (default): can set any status
 */
router.patch('/:id/subtasks/:index/status', async (req: Request, res: Response): Promise<void> => {
  try {
    markLegacySubtaskIndexRoute(res);
    const { id } = req.params;
    const index = parseInt(req.params.index, 10);
    const { status, reviewNote, blockedReason } = req.body;

    // Validate index
    if (isNaN(index) || index < 0) {
      res.status(400).json({ success: false, error: 'Invalid subtask index' });
      return;
    }

    // Validate status
    if (!status || !VALID_SUBTASK_STATUSES.includes(status)) {
      res.status(400).json({ 
        success: false, 
        error: `Invalid status. Must be one of: ${VALID_SUBTASK_STATUSES.join(', ')}` 
      });
      return;
    }

    // Validate role if provided
    const actorRole = getRequestAutomationRole(req);
    if (status === 'completed' && actorRole !== 'qa' && actorRole !== 'reviewer') {
      res.status(403).json({ success: false, error: 'Only an independent Verifier identity can complete a subtask' });
      return;
    }
    const task = await taskManager.updateSubtaskStatus(id, index, status, actorRole, reviewNote, blockedReason);
    
    // Get subtask summary (always use async version for DB)
    const subtaskSummary = await (taskManager as any).getSubtaskSummaryAsync(id);
    const hasBlocked = await (taskManager as any).hasBlockedSubtasks(id);
    
    res.json({ 
      success: true, 
      task,
      subtaskSummary,
      hasBlocked
    });
  } catch (err) {
    if (err instanceof NotFoundFault || err instanceof ForbiddenFault) {
      res.status(err.status).json({ success: false, code: err.code, error: err.message });
      return;
    }
    const errorId = logCaughtFailure('[Tasks API] Error updating subtask status:', err);
    res.status(500).json({ success: false, code: 'SUBTASK_STATUS_UPDATE_FAILED', error: 'The subtask status could not be updated', errorId });
  }
});

/**
 * PUT /tasks/:id/subtasks/:index
 * Legacy endpoint for subtask updates (backward compatible)
 * Supports both old {completed: boolean} and new {status: SubtaskStatus} format
 * 
 * SECURITY: restricted statuses (completed, skipped) require an
 * authenticated identity that resolves to a non-agent automation role. There is
 * no header or body escape hatch — see utils/taskAutomationRole.
 */
router.put('/:id/subtasks/:index', async (req: Request, res: Response): Promise<void> => {
  try {
    markLegacySubtaskIndexRoute(res);
    const { id } = req.params;
    const index = parseInt(req.params.index, 10);
    const { completed, status, reviewNote, blockedReason } = req.body;

    if (isNaN(index) || index < 0) {
      res.status(400).json({ success: false, error: 'Invalid subtask index' });
      return;
    }

    // Determine new status from request
    let newStatus: SubtaskStatus;
    if (status !== undefined) {
      newStatus = status;
    } else if (completed !== undefined) {
      // Legacy format: map boolean to status
      newStatus = completed ? 'completed' : 'empty';
    } else {
      res.status(400).json({ success: false, error: 'Either "status" or "completed" must be provided' });
      return;
    }

    // Authority comes from the authenticated identity only. A request body flag
    // or a client-supplied header is not an authority source.
    const actorRole = getRequestAutomationRole(req);
    if (newStatus === 'completed' && actorRole !== 'qa' && actorRole !== 'reviewer') {
      res.status(403).json({ success: false, error: 'Only an independent Verifier identity can complete a subtask' });
      return;
    }
    const role = actorRole;

    // Block agents from using non-agent statuses
    if (!AGENT_ALLOWED_STATUSES.includes(newStatus) && role === 'agent') {
      res.status(403).json({
        success: false,
        error: `Agents cannot set status to '${newStatus}'. Use ${AGENT_ALLOWED_STATUSES.join(' or ')} instead.`
      });
      return;
    }

    const task = await taskManager.updateSubtaskStatus(id, index, newStatus, role, reviewNote, blockedReason);
    
    // Add computed dependency fields
    const taskWithDeps = {
      ...task,
      blocked: await taskManager.isTaskBlocked(task.id),
      blockingTasks: (await taskManager.getBlockingTasks(task.id)).map(t => ({ id: t.id, title: t.title })),
      dependentTasks: (await taskManager.getDependentTasks(task.id)).map(t => ({ id: t.id, title: t.title })),
    };
    
    res.json({ success: true, task: taskWithDeps });
  } catch (err) {
    if (err instanceof NotFoundFault || err instanceof ForbiddenFault) {
      res.status(err.status).json({ success: false, code: err.code, error: err.message });
      return;
    }
    const errorId = logCaughtFailure('[Tasks API] Error updating subtask:', err);
    res.status(500).json({ success: false, code: 'SUBTASK_UPDATE_FAILED', error: 'The subtask could not be updated', errorId });
  }
});

/**
 * POST /tasks/:id/subtasks/:index/approve
 * Approve a subtask (orchestrator marks as completed)
 */
router.post('/:id/subtasks/:index/approve', async (req: Request, res: Response): Promise<void> => {
  try {
    markLegacySubtaskIndexRoute(res);
    if (await rejectNonReviewerAction(req, res, 'approve subtasks')) return;
    const { id } = req.params;
    const index = parseInt(req.params.index, 10);

    if (isNaN(index) || index < 0) {
      res.status(400).json({ success: false, error: 'Invalid subtask index' });
      return;
    }

    const task = await taskManager.approveSubtask(id, index);
    
    // Get subtask summary (always use async version for DB)
    const subtaskSummary = await (taskManager as any).getSubtaskSummaryAsync(id);
    const allCompleted = await (taskManager as any).allSubtasksCompletedAsync(id);
    
    res.json({ 
      success: true, 
      task,
      subtaskSummary,
      allCompleted
    });
  } catch (err) {
    if (err instanceof NotFoundFault || err instanceof ForbiddenFault) {
      res.status(err.status).json({ success: false, code: err.code, error: err.message });
      return;
    }
    const errorId = logCaughtFailure('[Tasks API] Error approving subtask:', err);
    res.status(500).json({ success: false, code: 'SUBTASK_APPROVE_FAILED', error: 'The subtask could not be approved', errorId });
  }
});

/**
 * POST /tasks/:id/subtasks/:index/reject
 * Reject a subtask (orchestrator marks as empty with optional note)
 */
router.post('/:id/subtasks/:index/reject', async (req: Request, res: Response): Promise<void> => {
  try {
    markLegacySubtaskIndexRoute(res);
    if (rejectImplementationAgentOrchestratorAction(req, res, 'reject subtasks')) return;
    const { id } = req.params;
    const index = parseInt(req.params.index, 10);
    const { note } = req.body;

    if (isNaN(index) || index < 0) {
      res.status(400).json({ success: false, error: 'Invalid subtask index' });
      return;
    }

    const task = await taskManager.rejectSubtask(id, index, note);
    
    // Get subtask summary (always use async version for DB)
    const subtaskSummary = await (taskManager as any).getSubtaskSummaryAsync(id);
    
    res.json({ 
      success: true, 
      task,
      subtaskSummary
    });
  } catch (err) {
    if (err instanceof NotFoundFault || err instanceof ForbiddenFault) {
      res.status(err.status).json({ success: false, code: err.code, error: err.message });
      return;
    }
    const errorId = logCaughtFailure('[Tasks API] Error rejecting subtask:', err);
    res.status(500).json({ success: false, code: 'SUBTASK_REJECT_FAILED', error: 'The subtask could not be rejected', errorId });
  }
});

/**
 * POST /tasks/:id/subtasks/:index/skip
 * Skip a subtask (orchestrator only, counts as "done")
 */
router.post('/:id/subtasks/:index/skip', async (req: Request, res: Response): Promise<void> => {
  try {
    markLegacySubtaskIndexRoute(res);
    if (rejectImplementationAgentOrchestratorAction(req, res, 'skip subtasks')) return;
    const { id } = req.params;
    const index = parseInt(req.params.index, 10);

    if (isNaN(index) || index < 0) {
      res.status(400).json({ success: false, error: 'Invalid subtask index' });
      return;
    }

    const task = await taskManager.skipSubtask(id, index);
    
    const subtaskSummary = await (taskManager as any).getSubtaskSummaryAsync(id);
    const allCompleted = await (taskManager as any).allSubtasksCompletedAsync(id);
    
    res.json({ 
      success: true, 
      task,
      subtaskSummary,
      allCompleted
    });
  } catch (err) {
    if (err instanceof NotFoundFault || err instanceof ForbiddenFault) {
      res.status(err.status).json({ success: false, code: err.code, error: err.message });
      return;
    }
    const errorId = logCaughtFailure('[Tasks API] Error skipping subtask:', err);
    res.status(500).json({ success: false, code: 'SUBTASK_SKIP_FAILED', error: 'The subtask could not be skipped', errorId });
  }
});

/**
 * GET /tasks/:id/subtasks/summary
 * Get subtask completion summary for a task
 * Returns counts for all 6 statuses: empty, in-progress, review, stuck, skipped, completed
 */
router.get('/:id/subtasks/summary', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const task = await taskManager.getTask(id);
    
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }

    // Get subtask summary (always use async version for DB)
    const summary = await (taskManager as any).getSubtaskSummaryAsync(id);
    const allCompleted = await (taskManager as any).allSubtasksCompletedAsync(id);
    const hasBlocked = await (taskManager as any).hasBlockedSubtasks(id);
    
    res.json({ 
      success: true, 
      taskId: id,
      summary,
      allCompleted,
      hasBlocked
    });
  } catch (err) {
    const errorId = logCaughtFailure('[Tasks API] Error getting subtask summary:', err);
    res.status(500).json({ 
      success: false, 
      error: 'The subtask summary could not be read',
      code: 'SUBTASK_SUMMARY_READ_FAILED',
      errorId
    });
  }
});

// ============================================================
// Notification Endpoints
// ============================================================

// NOTE: GET /notifications moved above the '/:id' wildcard (route order) —
// see the /next route comment. POST routes below are safe: no bare POST /:id
// route exists, so these literal POST paths cannot be shadowed.

/**
 * POST /notifications/:id/read
 * Mark a notification as read
 */
router.post('/notifications/:id/read', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const success = await notificationManager.markAsRead(id);
    
    if (!success) {
      res.status(404).json({ success: false, error: 'Notification not found' });
      return;
    }
    
    res.json({ success: true });
  } catch (err) {
    const errorId = logCaughtFailure('[Tasks API] Error marking notification as read:', err);
    res.status(500).json({ 
      success: false, 
      error: 'The notification could not be marked read',
      code: 'NOTIFICATION_MARK_READ_FAILED',
      errorId
    });
  }
});

/**
 * POST /notifications/read-all
 * Mark all notifications as read
 */
router.post('/notifications/read-all', async (_req: Request, res: Response): Promise<void> => {
  try {
    const count = await notificationManager.markAllAsRead();
    res.json({ success: true, markedCount: count });
  } catch (err) {
    const errorId = logCaughtFailure('[Tasks API] Error marking all notifications as read:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Notifications could not be marked read',
      code: 'NOTIFICATIONS_MARK_READ_FAILED',
      errorId
    });
  }
});

export default router;
