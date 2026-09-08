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

export interface TelemetrySessionDetail {
  session: TelemetrySessionRow;
  events: TelemetryTimelineEvent[];
  truncated: boolean;
}

export interface TelemetryStats {
  windowDays: number;
  windowStart: string;
  totals: {
    events: number; sessions: number; sources: number; errors: number; requests: number;
    inputTokens: number; outputTokens: number; cachedReadTokens: number;
    reasoningTokens: number; toolTokens: number; totalTokens: number;
  };
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

export function fetchSessions(): Promise<{ sessions: TelemetrySessionRow[] }> {
  return readProjection('/telemetry/sessions');
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
