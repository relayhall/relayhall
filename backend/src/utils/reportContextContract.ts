/**
 * reportContextContract — the transport-neutral half of the bounded Task
 * Report context (card 50b5e9c4, slice 3): its limits, its envelope, its
 * request validation, its cursor and its retrieval guidance.
 *
 * Pure on purpose. `services/TaskReportContext` computes a context against
 * the database; the MCP registry renders one it received over REST. Both read
 * these definitions, and this module imports nothing that opens a database
 * pool, so the MCP transports can depend on it without one.
 */

import { InvalidRequestFault } from './httpErrors';

export const REPORT_CONTEXT_SCOPES = ['linked', 'progress'] as const;
export type ReportContextScope = typeof REPORT_CONTEXT_SCOPES[number];

/** The default page: "at most 5 most-recent Report summaries". */
export const REPORT_CONTEXT_DEFAULT_LIMIT = 5;
/** The largest page any transport may ask for (the MCP list hard cap). */
export const REPORT_CONTEXT_MAX_LIMIT = 50;
/** The bounded pinned-evidence selection shown beside the recent page. */
export const REPORT_CONTEXT_PINNED_LIMIT = 3;

const CURSOR_PREFIX = 'rc1.';
const CURSOR_MAX_LENGTH = 512;
const CREATED_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ReportRelevance = 'pinned' | 'progress' | 'handover' | 'stream' | 'linked';

/** One Report summary. Title and summary are author-written board data. */
export interface TaskReportSummary {
  id: string;
  title: string;
  status: 'active' | 'archived';
  relevance: ReportRelevance;
  pinned: boolean;
  origin: string;
  createdAt: string | null;
  updatedAt: string | null;
  /** The stored one-line summary (at most 500 characters), never the body. */
  summary: string | null;
  authorPrincipalId: string | null;
  hasStructuredHandover: boolean;
  /**
   * sha256 of the body for this Task's own task-bound progress Reports — the
   * `expectedContentHash` an edit through POST /tasks/:id/reports needs — and
   * null for every other Report. A hash, never the body.
   */
  contentHash: string | null;
}

export interface TaskReportPagination {
  limit: number;
  /** Authorized Reports ahead of this page in the full ordering. */
  offset: number;
  /** Every Report in this scope the caller may read. */
  total: number;
  returned: number;
  hasMore: boolean;
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

export interface TaskReportPinned {
  /** Pinned Reports NOT already in `reports`, newest first, at most three. */
  reports: TaskReportSummary[];
  /** Every pinned Report in this scope the caller may read. */
  total: number;
  returned: number;
  /** Pinned Reports neither in `reports` nor in this selection. */
  hasMore: boolean;
}

export interface TaskReportContext {
  taskId: string;
  scope: ReportContextScope;
  pinnedOnly: boolean;
  reports: TaskReportSummary[];
  pinned: TaskReportPinned;
  pagination: TaskReportPagination;
  /** One line naming the real interface for the next page and for bodies. */
  retrieval: string;
}

export interface TaskReportContextRequest {
  scope?: ReportContextScope;
  limit?: number;
  cursor?: string | null;
  offset?: number;
  pinnedOnly?: boolean;
}

/** A malformed context request: a typed 400 whose code and message are
 * developer-authored here, never a caught value's text. */
export class ReportContextRequestError extends InvalidRequestFault {
  constructor(code: string, message: string, public readonly field: string) {
    super(message, code);
  }
}

/** A position in newest-first order: creation instant (microseconds) + id. */
export interface ReportCursorPosition { createdKey: string; id: string }

export function encodeReportCursor(scope: ReportContextScope, pinnedOnly: boolean, position: ReportCursorPosition): string {
  const payload = JSON.stringify({ s: scope, p: pinnedOnly ? 1 : 0, c: position.createdKey, i: position.id });
  return CURSOR_PREFIX + Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeReportCursor(cursor: string, scope: ReportContextScope, pinnedOnly: boolean): ReportCursorPosition {
  const refuse = (detail: string): never => {
    throw new ReportContextRequestError(
      'INVALID_REPORT_CURSOR',
      `cursor ${detail}; pass back the nextCursor value exactly as a previous page returned it`,
      'cursor',
    );
  };
  if (cursor.length > CURSOR_MAX_LENGTH || !cursor.startsWith(CURSOR_PREFIX)) refuse('is not a Report context cursor');
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    return refuse('could not be decoded');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return refuse('could not be decoded');
  const { s, p, c, i } = payload as Record<string, unknown>;
  if (typeof c !== 'string' || !CREATED_KEY.test(c) || typeof i !== 'string' || !UUID.test(i)) return refuse('is malformed');
  if (s !== scope || p !== (pinnedOnly ? 1 : 0)) {
    return refuse(`was issued for scope ${String(s)}${p === 1 ? ' with pinned' : ''}, not for this request; repeat the same scope and pinned values`);
  }
  return { createdKey: c, id: i };
}

function boundedInteger(raw: unknown, field: string, min: number, max: number): number {
  const value = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ReportContextRequestError('INVALID_REPORT_PAGE', `${field} must be an integer from ${min} to ${max}`, field);
  }
  return value;
}

/**
 * Validate a context request from REST query strings or tool arguments. One
 * validator, so every surface refuses the same inputs with the same codes.
 */
export function parseReportContextRequest(source: Record<string, unknown>): TaskReportContextRequest {
  const request: TaskReportContextRequest = {};
  if (source.scope !== undefined) {
    if (typeof source.scope !== 'string' || !(REPORT_CONTEXT_SCOPES as readonly string[]).includes(source.scope)) {
      throw new ReportContextRequestError('INVALID_REPORT_SCOPE', `scope must be one of ${REPORT_CONTEXT_SCOPES.join(', ')}`, 'scope');
    }
    request.scope = source.scope as ReportContextScope;
  }
  if (source.limit !== undefined) request.limit = boundedInteger(source.limit, 'limit', 1, REPORT_CONTEXT_MAX_LIMIT);
  if (source.offset !== undefined) request.offset = boundedInteger(source.offset, 'offset', 0, Number.MAX_SAFE_INTEGER);
  if (source.cursor !== undefined && source.cursor !== null) {
    if (typeof source.cursor !== 'string' || source.cursor.length === 0) {
      throw new ReportContextRequestError('INVALID_REPORT_CURSOR', 'cursor must be a nextCursor string', 'cursor');
    }
    request.cursor = source.cursor;
  }
  if (request.cursor && request.offset !== undefined) {
    throw new ReportContextRequestError('INVALID_REPORT_PAGE', 'send cursor or offset, not both', 'offset');
  }
  if (source.pinned !== undefined) {
    if (source.pinned === true || source.pinned === 'true') request.pinnedOnly = true;
    else if (source.pinned === false || source.pinned === 'false') request.pinnedOnly = false;
    else throw new ReportContextRequestError('INVALID_REPORT_PAGE', 'pinned must be true or false', 'pinned');
  }
  return request;
}

/**
 * The one line of retrieval guidance. `mcp` names the MCP tool only (the
 * reader is an MCP client); `all` names the MCP tool, the REST route and the
 * CLI flag, for the REST envelope and the Brief, whose readers use any of them.
 *
 * When this Task's own progress Reports are in view — scope `progress`, or a
 * listed summary carries a content hash — the line also names the
 * Task-authority body read a claimant continues its progress Report from
 * (round-1 B1). Every surface decides that from the same envelope, so MCP and
 * REST name the same reads.
 */
export function reportContextGuidance(
  context: Pick<TaskReportContext, 'taskId' | 'scope' | 'pinnedOnly' | 'pagination' | 'pinned'>
    & { reports?: readonly TaskReportSummary[] },
  surface: 'mcp' | 'all' = 'all',
): string {
  const { taskId, scope, pinnedOnly, pagination, pinned } = context;
  const scopeArgs = scope !== 'linked' ? { scope } : {};
  const mcpArgs = (extra: Record<string, unknown>) => JSON.stringify({
    task: taskId, ...scopeArgs, ...(pinnedOnly ? { pinned: true } : {}), ...extra,
  });
  const restQuery = (extra: string) => [scope !== 'linked' ? `scope=${scope}` : '', pinnedOnly ? 'pinned=true' : '', extra]
    .filter(Boolean).join('&');
  const cliFlags = `${scope !== 'linked' ? ` --scope ${scope}` : ''}${pinnedOnly ? ' --pinned' : ''}`;
  const parts: string[] = [];
  if (pagination.hasMore && pagination.nextCursor) {
    const remaining = Math.max(0, pagination.total - pagination.offset - pagination.returned);
    const cursor = pagination.nextCursor;
    parts.push(surface === 'mcp'
      ? `${remaining} more authorized Report summaries: call relayhall_task_report_list with ${mcpArgs({ cursor })} (limit up to ${REPORT_CONTEXT_MAX_LIMIT}).`
      : `${remaining} more authorized Report summaries: MCP relayhall_task_report_list ${mcpArgs({ cursor })}; REST GET /api/tasks/${taskId}/reports?${restQuery(`cursor=${cursor}`)}; CLI relayhall task-reports ${taskId}${cliFlags} --all.`);
  } else if (pagination.total === 0) {
    parts.push('No authorized Reports in this scope.');
  } else if (pagination.offset === 0) {
    parts.push(`All ${pagination.total} authorized Report summaries are listed.`);
  } else {
    parts.push(`Last page: ${pagination.total} authorized Report summaries in all.`);
  }
  if (!pinnedOnly && pinned.hasMore) {
    parts.push(surface === 'mcp'
      ? `More pinned Reports: call relayhall_task_report_list with ${JSON.stringify({ task: taskId, ...scopeArgs, pinned: true })}.`
      : `More pinned Reports: add pinned=true (MCP "pinned": true, CLI --pinned).`);
  }
  // Report bodies: the Report read (reports:read), and — when this Task's own
  // progress Reports are in view — the Task-authority read (tasks:read) a
  // claimant continues its progress Report from (50b5e9c4 round-1 B1).
  const progressInView = scope === 'progress'
    || [...(context.reports ?? []), ...(pinned.reports ?? [])]
      .some((report) => typeof report.contentHash === 'string' && report.contentHash !== '');
  if (!progressInView) {
    parts.push(surface === 'mcp'
      ? 'Report bodies are never included: fetch one with relayhall_report_get.'
      : 'Report bodies are never included: fetch one with relayhall_report_get (REST GET /api/reports/{id}).');
  } else {
    parts.push(surface === 'mcp'
      ? 'Report bodies are never included: fetch one with relayhall_report_get (reports:read), '
        + `or one of this Task's progress Reports, with its content hash, with relayhall_task_report_get ${JSON.stringify({ task: taskId, reportId: '<id>' })} (tasks:read).`
      : 'Report bodies are never included: fetch one with relayhall_report_get (REST GET /api/reports/{id}; reports:read), '
        + `or one of this Task's progress Reports, with its content hash, under tasks:read: MCP relayhall_task_report_get; REST GET /api/tasks/${taskId}/reports/{reportId}; CLI relayhall task-reports ${taskId} --report REPORT_ID.`);
  }
  return parts.join(' ');
}
