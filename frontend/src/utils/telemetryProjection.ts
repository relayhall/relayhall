/**
 * The TW1c read model, on the client (card `50e74c1d`).
 *
 * ONE module for both surfaces. The Sessions page and the Stats page render
 * different halves of the same projection, and a second copy of the state
 * vocabulary or the fetch shape is how two pages start disagreeing about what
 * `idle` means. So the labels, the fetchers and the polling interval live
 * here and both pages import them.
 *
 * WHY THIS POLLS AND DOES NOT SUBSCRIBE. The ratified §2.6.5 telemetry rule
 * (`backend/src/services/TelemetryService.ts`, verbatim) is that ingest
 * "writes telemetry_frames and nothing else — no task writes, no lease
 * renewal ..., no feed emission". A live WebSocket push for presence would
 * have to be emitted from the ingest path, which is exactly the emission that
 * rule forbids. So these surfaces re-read on an interval using the query
 * client the app already ships — no new transport, and the ingest contract is
 * untouched.
 */
import { authenticatedFetch } from './auth';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

/**
 * Re-read cadence.
 *
 * Deliberately ABOVE a frame interval and well below the staleness window the
 * server derives `stale` from (`TELEMETRY_STALE_MS`, 9 minutes): a source that
 * goes quiet is repainted stale within one poll of the server deciding so, and
 * a live one never flickers because a poll landed between two events.
 */
export const TELEMETRY_POLL_MS = 20_000;

/**
 * The Sessions list's page size and window (card `0ac41d40`). The page SENDS
 * both rather than leaning on the server's defaults, so what it says ("in the
 * last 7 days") is what it asked for. They equal the server's defaults today.
 */
export const SESSIONS_PAGE_SIZE = 50;
export const SESSIONS_WINDOW_DAYS = 7;

/** The SHIPPED chip vocabulary (design 7d5c0cdc §10.1). Not extended here. */
export type TelemetryPresenceState = 'active' | 'idle' | 'stale';

/**
 * The session-row vocabulary: four of the seven labels the shipped UI already
 * paints (`TaskDetailPage.LIVENESS_LABELS`). `orphan` is a lease conclusion a
 * reporter session cannot reach; `unknown` and `none` describe the absence of
 * a session, and a row exists here only because events were stored under it.
 */
export type TelemetrySessionState = 'active' | 'idle' | 'stale' | 'finished';

export const PRESENCE_LABELS: Record<TelemetryPresenceState, string> = {
  active: 'Active', idle: 'Idle', stale: 'Stale',
};

export const SESSION_STATE_LABELS: Record<TelemetrySessionState, string> = {
  active: 'Active', idle: 'Idle', stale: 'Stale', finished: 'Finished',
};

/**
 * What each state MEANS, for the reader who has never read the design.
 *
 * These ride as the chip's accessible description rather than as a `title`:
 * a `title` tooltip is mouse-only, and the state word alone ("Stale") does not
 * tell a screen-reader user whether something broke.
 */
export const SESSION_STATE_HINTS: Record<TelemetrySessionState, string> = {
  active: 'reporting now',
  idle: 'reported waiting',
  stale: 'no report inside the staleness window',
  finished: 'the source reported this session ended',
};

export interface TelemetryPresenceRow {
  connectorId: string;
  connectorHandle: string | null;
  /** The Connector's display name, when its principal has one. */
  connectorDisplayName?: string | null;
  accountId: string;
  sourceProduct: string;
  adapter: string | null;
  adapterVersion: string | null;
  mechanism: string | null;
  supportLevel: string | null;
  lastVerified: string | null;
  policyTier: number | null;
  schemaVersion: string | null;
  lastSeenAt: string;
  firstSeenAt: string;
  lastPhase: string | null;
  eventCount: number;
  sessionCount: number;
  errorCount: number;
  state: TelemetryPresenceState;
  basis: 'envelope';
  connectorFrame: { state: TelemetryPresenceState; receivedAt: string; kind: string } | null;
}

export interface TelemetrySessionRow {
  sessionRef: string;
  connectorId: string;
  connectorHandle: string | null;
  /** The Connector's display name, when its principal has one. */
  connectorDisplayName?: string | null;
  sourceProduct: string;
  state: TelemetrySessionState;
  startedAt: string;
  lastSeenAt: string;
  lastPhase: string | null;
  eventCount: number;
  errorCount: number;
  models: string[];
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
}

/**
 * Who reported a source or a session, as a person reads it: the Connector's
 * display name, then its handle, then its id. One helper so the Sessions and
 * Stats pages cannot name the same Connector two different ways.
 */
export function reporterName(row: {
  connectorId: string;
  connectorHandle: string | null;
  connectorDisplayName?: string | null;
}): string {
  return row.connectorDisplayName || row.connectorHandle || row.connectorId;
}

/**
 * What makes a session SHORT (card `0ac41d40`), as the SERVER reports it, so
 * the page states the rule from the values that applied it rather than from a
 * second copy. Short: at most `maxEvents` events, last seen less than
 * `minDurationMs` after it started, and no model and no tokens at all.
 */
export interface TelemetryShortSessionRule {
  maxEvents: number;
  minDurationMs: number;
}

/** One page of the Sessions list. The counts describe the WHOLE filtered list. */
export interface TelemetrySessionPage {
  sessions: TelemetrySessionRow[];
  /** Short sessions withheld from this list (0 when they are shown). */
  hiddenCount: number;
  /** Short sessions in the window and filters, shown or not. */
  shortCount: number;
  /** Rows the list holds under the current filters and toggle, across every page. */
  total: number;
  offset: number;
  /** The next page's offset, or null on the last page. */
  nextOffset: number | null;
  /** The rule as the server applied it; null from a board that does not report one. */
  shortSession: TelemetryShortSessionRule | null;
}

/** What the Sessions page asks for. Filters are omitted when unset. */
export interface TelemetrySessionQuery {
  offset?: number;
  limit?: number;
  windowDays?: number;
  includeShort?: boolean;
  connectorId?: string;
  sourceProduct?: string;
}

/**
 * The short-session rule in words, from the server's values:
 * "at most 3 events, under 2 minutes, with no model and no tokens".
 */
export function describeShortSession(rule: TelemetryShortSessionRule): string {
  const seconds = Math.round(rule.minDurationMs / 1000);
  const span = seconds % 60 === 0
    ? `${seconds / 60} minute${seconds === 60 ? '' : 's'}`
    : `${seconds} seconds`;
  return `at most ${rule.maxEvents} event${rule.maxEvents === 1 ? '' : 's'}, under ${span}, `
    + 'with no model and no tokens';
}

export interface TelemetryTimelineEvent {
  eventId: string;
  observedAt: string;
  occurredAt: string | null;
  kind: string;
  phase: string | null;
  modelProvider: string | null;
  modelResolved: string | null;
  operation: string | null;
  outcomeStatus: string | null;
  errorType: string | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  contextUtilization: number | null;
}

/**
 * The MCP action log's closed error vocabulary (card `ab8f78e9`), as the
 * server stores it (`McpActionLog.MCP_ACTION_ERROR_CODES`), with the words the
 * page shows for each. A code this table does not name is shown verbatim.
 */
export const MCP_ACTION_ERROR_LABELS: Record<string, string> = {
  tool_refused: 'Refused by the tool',
  bad_request: 'Bad request',
  unauthenticated: 'Not authenticated',
  forbidden: 'Forbidden',
  not_found: 'Not found',
  conflict: 'Conflict',
  rate_limited: 'Rate limited',
  rejected: 'Rejected',
  unavailable: 'Unavailable',
  server_error: 'Server error',
  internal: 'Internal error',
};

/** The product whose sessions carry an action log: the board's own MCP server. */
export const MCP_ACTION_LOG_PRODUCT = 'mcp';

/**
 * One MCP tool call in a session's action log (card `ab8f78e9`, owner ruling
 * E91): tool, allowlisted target, outcome, duration, time. Never arguments.
 */
export interface TelemetrySessionAction {
  observedAt: string;
  toolName: string;
  targetType: string | null;
  targetId: string | null;
  outcome: 'ok' | 'error';
  errorCode: string | null;
  durationMs: number;
}

export interface TelemetrySessionDetail {
  session: TelemetrySessionRow;
  events: TelemetryTimelineEvent[];
  truncated: boolean;
  /** The session's MCP action log, newest first. Absent from an older server. */
  actions?: TelemetrySessionAction[];
  actionsTruncated?: boolean;
}

/** An action's outcome in words: "OK", or the closed error code's label. */
export function describeActionOutcome(action: Pick<TelemetrySessionAction, 'outcome' | 'errorCode'>): string {
  if (action.outcome === 'ok') return 'OK';
  const code = action.errorCode ?? '';
  return `Error: ${MCP_ACTION_ERROR_LABELS[code] ?? (code || 'unknown')}`;
}

export interface TelemetryStats {
  windowDays: number;
  windowStart: string;
  totals: {
    events: number; sessions: number; sources: number; errors: number; requests: number;
    inputTokens: number; outputTokens: number; cachedReadTokens: number;
    reasoningTokens: number; toolTokens: number; totalTokens: number;
    /**
     * Card `0ac41d40`: how many of `sessions` are short and how many of
     * `events` they hold. `sessions` and `events` INCLUDE them. Optional only
     * so a page served by an older board still renders.
     */
    shortSessions?: number;
    shortSessionEvents?: number;
  };
  shortSession?: TelemetryShortSessionRule;
  modelMix: Array<{
    provider: string | null; model: string | null; events: number;
    inputTokens: number; outputTokens: number; totalTokens: number;
  }>;
  cost: Array<{ currency: string | null; basis: string; amount: string; events: number }>;
  coverage: TelemetryPresenceRow[];
}

/**
 * One reader for every projection route.
 *
 * A non-2xx is thrown, never rendered as empty: an authorization refusal and
 * "nothing reported yet" are different facts, and a page that showed the
 * documented empty state for a 403 would tell an operator their reporters had
 * stopped when the truth is that their credential cannot read them.
 */
async function readProjection<T>(path: string): Promise<T> {
  const response = await authenticatedFetch(`${API_BASE_URL}${path}`);
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    throw new Error(
      typeof body?.error === 'string' && body.error.length > 0
        ? body.error
        : `Telemetry read failed (${response.status})`,
    );
  }
  return body as T;
}

export function fetchPresence(): Promise<{ sources: TelemetryPresenceRow[] }> {
  return readProjection('/telemetry/presence');
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * One page of the Sessions list (card `0ac41d40`).
 *
 * Every parameter the page means is SENT — the offset, the page size, the
 * window — and the toggle and filters only when set, so an unset filter is
 * never a request for an empty one. The counts are read defensively: a
 * missing count is 0 and a missing next offset is the last page, so a board
 * that does not report them degrades to one page of rows rather than to a
 * broken page.
 */
export async function fetchSessions(query: TelemetrySessionQuery = {}): Promise<TelemetrySessionPage> {
  const params = new URLSearchParams({
    offset: String(query.offset ?? 0),
    limit: String(query.limit ?? SESSIONS_PAGE_SIZE),
    windowDays: String(query.windowDays ?? SESSIONS_WINDOW_DAYS),
  });
  if (query.includeShort) params.set('includeShort', 'true');
  if (query.connectorId) params.set('connectorId', query.connectorId);
  if (query.sourceProduct) params.set('sourceProduct', query.sourceProduct);
  const body = await readProjection<Partial<TelemetrySessionPage>>(`/telemetry/sessions?${params.toString()}`);
  const sessions = Array.isArray(body.sessions) ? body.sessions : [];
  const nextOffset = typeof body.nextOffset === 'number' && body.nextOffset > 0 ? body.nextOffset : null;
  return {
    sessions,
    hiddenCount: count(body.hiddenCount),
    shortCount: count(body.shortCount),
    total: typeof body.total === 'number' ? count(body.total) : sessions.length,
    offset: count(body.offset),
    nextOffset,
    shortSession: body.shortSession && typeof body.shortSession.maxEvents === 'number'
      && typeof body.shortSession.minDurationMs === 'number'
      ? body.shortSession
      : null,
  };
}

/**
 * A session is addressed by its TRIPLE. The parameter is one object rather
 * than three strings so a call site cannot silently pass them in the wrong
 * order, and so that a caller holding only the pseudonym does not compile.
 */
export function fetchSession(key: {
  sessionRef: string; connectorId: string; sourceProduct: string;
}): Promise<TelemetrySessionDetail> {
  const query = new URLSearchParams({
    connectorId: key.connectorId,
    sourceProduct: key.sourceProduct,
  });
  return readProjection(
    `/telemetry/sessions/${encodeURIComponent(key.sessionRef)}?${query.toString()}`);
}

export function fetchStats(windowDays?: number): Promise<TelemetryStats> {
  const query = windowDays ? `?windowDays=${encodeURIComponent(String(windowDays))}` : '';
  return readProjection(`/telemetry/stats${query}`);
}

/** Thousands separators only — never a locale-dependent date. */
export function formatCount(value: number): string {
  return new Intl.NumberFormat('en-GB').format(value);
}

/**
 * Money stays a STRING end to end.
 *
 * The server sums `numeric` and serializes the sum as text precisely so the
 * value never passes through an IEEE double. Parsing it here to format it
 * would undo that, so this only trims a trailing `.000…` and hands the rest
 * through untouched.
 */
export function formatAmount(amount: string): string {
  const trimmed = amount.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return trimmed.length > 0 ? trimmed : '0';
}

/** A session pseudonym is 31 opaque characters; show enough to tell two apart. */
export function shortSessionRef(sessionRef: string): string {
  return sessionRef.length > 14 ? `${sessionRef.slice(0, 14)}…` : sessionRef;
}
