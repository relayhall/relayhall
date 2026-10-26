/**
 * TaskReportContext — the bounded Report context of one Task (card 50b5e9c4,
 * slice 3: "default to at most 5 most-recent Report summaries ... not Report
 * bodies. Return total authorized count, returned count, hasMore and stable
 * next-page cursor ... Current pinned plan/acceptance evidence appears
 * separately and is deduplicated from recent items; keep that selection
 * bounded. Fetch Report content explicitly on demand.").
 *
 * ONE implementation, every transport. `GET /tasks/:id` (and so MCP
 * `relayhall_task_get`), `GET /tasks/:id/reports` (MCP
 * `relayhall_task_report_list`, CLI `task-reports`) and the Report section of
 * every compiled Brief (task altitude and the session brief's attached
 * Reports) call `compileTaskReportContext` and nothing else. The ordering,
 * the cursor, the pinned selection and its deduplication, the authorized
 * count and the retrieval guidance are decided here and in
 * `utils/reportContextContract` once, so no transport can page or count
 * differently from another.
 *
 * WHAT IS COUNTED. Only Reports the caller may read: the shared report READ
 * predicate (`authorizationRepository.authorizedIds`, the predicate the
 * shared middleware runs for `GET /reports/:id`) and then the two promotion
 * narrowings that point read applies (`ReportVisibility.filterVisiblePromotions`:
 * an auto-promoted Report is only as visible as its source Task, and the
 * `assigned-only` outpost tier also needs assignment membership). A Report the
 * caller cannot read is neither listed nor counted, so `total` discloses
 * nothing a point read would refuse.
 *
 * ORDER AND CURSOR. Newest-created first, ties broken by id, both descending.
 * The cursor is a keyset position — the creation instant at microsecond
 * precision plus the id of the last row served — never an offset. A Report
 * created after the first page cannot shift a later page, and an edit cannot
 * move a Report, because neither key changes after insert. `offset` remains
 * available as a positional alternative and is reported in every envelope.
 *
 * NO BODIES IN A CONTEXT. Compiling one never reads `content`. The Brief's
 * opt-in inlining reads bodies only for the Reports a context returned, and
 * `readTaskProgressReport` below is the one explicit body read, of one Report.
 *
 * THE CLAIMANT'S OWN PROGRESS REPORTS (round-1 B1). Before this card,
 * `GET /tasks/:id/reports` returned this Task's progress Reports in full under
 * tasks:read, and that was the only read a claimant credential without
 * reports:read had of its own progress Report's body and content hash — which
 * an edit needs as `expectedContentHash`. Two things keep that path without
 * putting bodies back into the list: a summary of one of this Task's progress
 * Reports carries its `contentHash`, and `readTaskProgressReport` serves one
 * such Report in full (`GET /tasks/:id/reports/:reportId`, MCP
 * `relayhall_task_report_get`, CLI `task-reports --report`) through the same
 * READ predicate and promotion narrowings the context counts with: the set
 * the old list exposed under tasks:read, one Report at a time. Any other
 * Report's body still needs reports:read.
 */
import { taskManagerDB } from './TaskManagerDB';
import { reportManager, type ReportContextRow } from './ReportManager';
import { authorizationRepository } from './AuthorizationRepository';
import { taskElementService } from './TaskElementService';
import type { AuthorizationActor } from './AuthorizationService';
import {
  REPORT_CONTEXT_DEFAULT_LIMIT,
  REPORT_CONTEXT_MAX_LIMIT,
  REPORT_CONTEXT_PINNED_LIMIT,
  ReportContextRequestError,
  decodeReportCursor,
  encodeReportCursor,
  reportContextGuidance,
  type ReportContextScope,
  type ReportCursorPosition,
  type ReportRelevance,
  type TaskReportContext,
  type TaskReportContextRequest,
  type TaskReportSummary,
} from '../utils/reportContextContract';

export * from '../utils/reportContextContract';

/** Newest-created first; ties by id. Both keys are immutable after insert. */
function newestFirst(left: ReportContextRow, right: ReportContextRow): number {
  if (left.created_key !== right.created_key) return left.created_key < right.created_key ? 1 : -1;
  if (left.id !== right.id) return left.id < right.id ? 1 : -1;
  return 0;
}

/** Strictly after `position` in newest-first order. */
function after(row: ReportContextRow, position: ReportCursorPosition): boolean {
  return row.created_key < position.createdKey
    || (row.created_key === position.createdKey && row.id < position.id);
}

function relevanceOf(row: ReportContextRow, taskId: string): ReportRelevance {
  if (row.pinned) return 'pinned';
  if (row.origin === 'task-report' && row.source_task_id === taskId) return 'progress';
  if (row.auto_promoted) return 'stream';
  if (row.origin === 'task-finish') return 'handover';
  return 'linked';
}

function summaryOf(row: ReportContextRow, taskId: string, progressIds: ReadonlySet<string>): TaskReportSummary {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    relevance: relevanceOf(row, taskId),
    pinned: row.pinned,
    origin: row.origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    summary: row.summary,
    authorPrincipalId: row.author_principal_id,
    hasStructuredHandover: row.has_handover,
    contentHash: progressIds.has(row.id) ? row.content_hash : null,
  };
}

/**
 * Which of these rows are this Task's own progress Reports (the `progress`
 * scope's binding: server-bound, origin task-report, genuine Reference) — the
 * rows whose summary carries a content hash. Only a task-report row bound to
 * this Task can be one, so the binding is read only when such a row is
 * present: an ordinary Task's context costs no extra query.
 */
async function progressIdsAmong(taskId: string, scope: ReportContextScope, rows: ReportContextRow[]): Promise<Set<string>> {
  const bound = rows.filter((row) => row.origin === 'task-report' && row.source_task_id === taskId);
  if (bound.length === 0) return new Set();
  const binding = scope === 'progress' ? null : new Set(await taskElementService.taskReportIds(taskId));
  return new Set(bound.filter((row) => binding === null || binding.has(row.id)).map((row) => row.id));
}

/**
 * The two promotion narrowings a point read applies after the READ predicate
 * (`ReportVisibility.filterVisiblePromotions`), evaluated for an
 * AuthorizationActor rather than a request, so the Brief compiler and the
 * routes count exactly the Reports `GET /reports/:id` would serve.
 */
async function narrowPromotions(actor: AuthorizationActor, rows: ReportContextRow[]): Promise<ReportContextRow[]> {
  const sourceTaskIds = [...new Set(rows
    .filter((row) => row.auto_promoted && row.source_task_id)
    .map((row) => row.source_task_id as string))];
  if (sourceTaskIds.length === 0) return rows;
  const visibleTasks = await authorizationRepository.authorizedIds(actor, 'task', sourceTaskIds, 'read');
  const taskScoped = rows.filter((row) => !row.auto_promoted
    || (row.source_task_id ? visibleTasks.has(row.source_task_id) : false));
  return taskElementService.filterPromotedReports(taskScoped, {
    // An unresolved caller gets a principal id that matches no assignment
    // row rather than a wildcard (`ReportVisibility.promotedReportActor`).
    principalId: actor.principalId ?? '00000000-0000-4000-8000-000000000000',
    handle: actor.handle,
    root: Boolean(actor.scopes?.includes('root')),
  });
}

async function candidateIds(taskId: string, scope: ReportContextScope): Promise<string[]> {
  if (scope === 'progress') return [...new Set(await taskElementService.taskReportIds(taskId))];
  // The ratified linkage (design 3cdf6e65 §4.2): task_ids containment OR a
  // task_references row of kind 'report' — the same union the Map draws.
  const linked = await taskManagerDB.queryLinkedReports([taskId]);
  return [...new Set(linked.map((row) => row.id))];
}

/**
 * Every Report of this Task's scope the caller may read, newest first. The
 * whole authorized set is held as metadata (never bodies) because the total
 * must be exact, and the rule that decides it is not one SQL conjunct without
 * restating the promotion narrowings (the reason `countVisibleReports` reads
 * rows too).
 */
async function authorizedRows(taskId: string, actor: AuthorizationActor | null, scope: ReportContextScope): Promise<ReportContextRow[]> {
  // No actor compiles fail-closed: nothing is readable, so nothing is listed
  // or counted.
  if (!actor) return [];
  const ids = await candidateIds(taskId, scope);
  if (ids.length === 0) return [];
  const readable = await authorizationRepository.authorizedIds(actor, 'report', ids, 'read');
  if (readable.size === 0) return [];
  const rows = await reportManager.getContextRows(ids.filter((id) => readable.has(id)));
  const visible = await narrowPromotions(actor, rows);
  return [...visible].sort(newestFirst);
}

/**
 * Compile one page of a Task's Report context for `actor`.
 *
 * The caller has already been authorized to READ the Task itself; this
 * decides which of the Task's Reports it may see and how many there are.
 */
export async function compileTaskReportContext(
  taskId: string,
  actor: AuthorizationActor | null,
  request: TaskReportContextRequest = {},
): Promise<TaskReportContext> {
  const scope = request.scope ?? 'linked';
  const pinnedOnly = request.pinnedOnly === true;
  const limit = request.limit ?? REPORT_CONTEXT_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > REPORT_CONTEXT_MAX_LIMIT) {
    throw new ReportContextRequestError('INVALID_REPORT_PAGE', `limit must be an integer from 1 to ${REPORT_CONTEXT_MAX_LIMIT}`, 'limit');
  }
  // A bad cursor is refused before any read.
  const position = request.cursor ? decodeReportCursor(request.cursor, scope, pinnedOnly) : null;

  const all = await authorizedRows(taskId, actor, scope);
  const listed = pinnedOnly ? all.filter((row) => row.pinned) : all;
  const progressIds = await progressIdsAmong(taskId, scope, all);

  let start: number;
  if (position) {
    start = listed.findIndex((row) => after(row, position));
    if (start < 0) start = listed.length;
  } else {
    start = Math.min(request.offset ?? 0, listed.length);
  }
  const page = listed.slice(start, start + limit);
  const hasMore = start + page.length < listed.length;
  const last = page[page.length - 1];

  // Pinned evidence, deduplicated from the page and bounded. On a pinned-only
  // request the page IS the pinned list, so the separate selection is empty.
  const pageIds = new Set(page.map((row) => row.id));
  const allPinned = all.filter((row) => row.pinned);
  const pinnedElsewhere = pinnedOnly ? [] : allPinned.filter((row) => !pageIds.has(row.id));
  const pinnedShown = pinnedElsewhere.slice(0, REPORT_CONTEXT_PINNED_LIMIT);

  const context: Omit<TaskReportContext, 'retrieval'> = {
    taskId,
    scope,
    pinnedOnly,
    reports: page.map((row) => summaryOf(row, taskId, progressIds)),
    pinned: {
      reports: pinnedShown.map((row) => summaryOf(row, taskId, progressIds)),
      total: allPinned.length,
      returned: pinnedShown.length,
      hasMore: pinnedElsewhere.length > pinnedShown.length,
    },
    pagination: {
      limit,
      offset: start,
      total: listed.length,
      returned: page.length,
      hasMore,
      nextCursor: hasMore && last
        ? encodeReportCursor(scope, pinnedOnly, { createdKey: last.created_key, id: last.id })
        : null,
    },
  };
  return { ...context, retrieval: reportContextGuidance(context, 'all') };
}

/**
 * One of this Task's progress Reports in full — body and content_hash — for
 * `actor`, or null (card 50b5e9c4 round-1 B1).
 *
 * The caller has already been authorized to READ the Task itself. The Report
 * must be one of the `progress` scope's candidates (server-bound to THIS Task,
 * origin task-report, genuine Reference), pass the shared report READ
 * predicate, and survive the promotion narrowings — the very checks that
 * decide whether the context lists and counts it. So this serves exactly a
 * Report the context would summarise for the same caller, and never a
 * Report it would not. Not a progress Report of this Task, unreadable,
 * deleted, or no actor: all null, one answer, nothing distinguished.
 */
export async function readTaskProgressReport(
  taskId: string,
  reportId: string,
  actor: AuthorizationActor | null,
): Promise<Record<string, unknown> | null> {
  if (!actor) return null;
  const candidates = await taskElementService.taskReportIds(taskId);
  if (!candidates.includes(reportId)) return null;
  const readable = await authorizationRepository.authorizedIds(actor, 'report', [reportId], 'read');
  if (!readable.has(reportId)) return null;
  const visible = await narrowPromotions(actor, await reportManager.getContextRows([reportId]));
  if (!visible.some((row) => row.id === reportId)) return null;
  return taskElementService.taskProgressReport(taskId, reportId);
}
