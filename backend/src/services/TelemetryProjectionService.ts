/**
 * TelemetryProjectionService — the TW1c read model: presence, Sessions and
 * Stats over the Tier-0 envelope foundation (card `50e74c1d`, design
 * `7d5c0cdc` §10.1–§10.3, sitting `7e7eeca3` TS-8/TS-11).
 *
 * ── DERIVED, BOUNDED, TIER-0 ──
 *
 * DERIVED. Nothing here writes. There is no projection table, no materialized
 * view and no background projector: every method is a SELECT over the rows
 * migration 111 already indexed for exactly this card
 * (`idx_session_events_envelope_grouping`, `idx_session_events_envelope_presence`
 * — both partial on `schema_version IS NOT NULL`, so the 055 hermes rows are
 * not merely filtered out, they never enter the index). That is why this card
 * needs NO migration of its own: its reserved number `120` stays reserved and
 * unwritten, which the RESERVED ledger's append-only rule accommodates by
 * design.
 *
 * Because it is derived, it is IDEMPOTENT UNDER REPLAY for free, and for a
 * reason worth naming: the write path dedupes on
 * `session_events.idempotency_key` (§4.3 identity, connector-namespaced), so a
 * replayed envelope inserts no row, so the projection cannot move. The
 * property is measured — `telemetryProjectionAuthorization.test.ts` snapshots
 * every surface, replays the whole batch through the production route, and
 * compares. A projection that accumulated state of its own could not make that
 * claim, which is the argument for it not having any.
 *
 * BOUNDED. Every read carries three bounds and none of them is optional: a
 * TIME WINDOW (default 7 days, hard ceiling 90), a ROW LIMIT (default 50, hard
 * ceiling 200) and — for the timeline — an EVENT LIMIT (default 200, hard
 * ceiling 500). Callers may narrow them and cannot widen them: `clamp` takes
 * the minimum with the ceiling and the ceiling is a module constant, so a
 * query string cannot ask this service for an unbounded scan.
 *
 * TIER-0. The only columns read out of `payload` are the ones the Tier-0
 * policy engine already bounded to a closed vocabulary, a shape-checked name
 * or a finite number (`TelemetryPolicyEngine`: `phase` against
 * `TELEMETRY_PHASES_TIER0`, `model.provider/requested/resolved` against
 * `MODEL_NAME_RE`, `outcome.status` against `TELEMETRY_OUTCOME_STATUSES_TIER0`,
 * usage/timing/context through `retainNumber`). No prompt, response, tool
 * input or tool output can be reached from here because Tier 0 stores none —
 * §6.3 is "default OFF per source" and the engine nulls all four content
 * references. This module adds NO new field to what is stored; it only groups
 * and counts what already survived redaction.
 *
 * ── ZERO SERVER-SIDE EFFECT, AND WHY THIS IS A POLL ──
 *
 * The ratified §2.6.5 rule, restated verbatim in `TelemetryService`: "ingest
 * writes telemetry_frames and nothing else — no task writes, no lease renewal
 * ..., NO FEED EMISSION." A WebSocket push for presence would have to be
 * emitted from the ingest path, which is precisely the emission that rule
 * forbids. So the surfaces PULL: the Sessions and Stats pages re-read these
 * routes on an interval with the query client the app already ships. No new
 * transport is introduced, and the ingest contract is not touched.
 *
 * ── THE STATE VOCABULARIES ──
 *
 * `TELEMETRY_PRESENCE_STATES` is the SHIPPED C7 chip vocabulary and is not
 * extended here: `active | idle` pushed, `stale` derived from age against the
 * SHIPPED `TELEMETRY_STALE_MS` — imported from `TelemetryService`, never
 * re-declared, so the two windows cannot drift (sitting ruling TS-8). Design
 * §10.1: "any future extension of the chip's state vocabulary is a declared C7
 * contract revision with its own review" — this card declares none.
 *
 * `TELEMETRY_SESSION_STATES` is the Sessions-row vocabulary, and it is a
 * SUBSET of the labels the shipped UI already paints
 * (`TaskDetailPage.LIVENESS_LABELS`: active, idle, stale, orphan, finished,
 * unknown, none). Four of those seven are reachable for a reporter session and
 * the other three are not, for stated reasons:
 *
 *   - `orphan` is a LEASE conclusion (`CanonicalRuntimeSignalService`:
 *     `writer_lease_expired_without_terminal_evidence`). A reporter session
 *     holds no lease, so no evidence in this plane could produce it.
 *   - `unknown` and `none` describe the ABSENCE of a session. A row exists
 *     here only because at least one event was stored under its `session_ref`,
 *     so neither is reachable by construction.
 *
 * That is a bounded claim about this projection, not about the UI: the chip
 * keeps painting all seven for its own sources.
 */
import { Pool } from 'pg';
import { pool as defaultPool } from '../db/connection';
import { TELEMETRY_STALE_MS } from './TelemetryService';
import { MAX_CHAIN_DEPTH } from './DelegationService';
import {
  renderTelemetryScopeSql,
  type TelemetryReadScope,
  type TelemetryScopeSql,
} from './TelemetryReadScope';

// ─────────────────────────────── the bounds ──────────────────────────────────

export const TELEMETRY_PROJECTION_DEFAULT_ROWS = 50;
export const TELEMETRY_PROJECTION_MAX_ROWS = 200;
export const TELEMETRY_PROJECTION_DEFAULT_WINDOW_DAYS = 7;
export const TELEMETRY_PROJECTION_MAX_WINDOW_DAYS = 90;
export const TELEMETRY_TIMELINE_DEFAULT_EVENTS = 200;
export const TELEMETRY_TIMELINE_MAX_EVENTS = 500;
/**
 * The only product with an action log: the server-written MCP key
 * (`McpSessionTelemetry.MCP_SESSION_SOURCE_PRODUCT`), restated rather than
 * imported because that module pulls the MCP write path into this read model.
 * `mcpActionLog.test.ts` pins the two equal.
 */
export const MCP_ACTION_LOG_PRODUCT = 'mcp';

/**
 * Narrow-only clamp. `requested` may lower a bound and can never raise it,
 * because the result is `Math.min(..., max)` and `max` is a module constant a
 * request cannot reach.
 */
export function clampBound(requested: unknown, fallback: number, max: number): number {
  const value = typeof requested === 'number' ? requested : Number(requested);
  if (!Number.isFinite(value) || value <= 0) return Math.min(fallback, max);
  return Math.min(Math.floor(value), max);
}

// ─────────────────────────── the short-session rule ──────────────────────────

/**
 * A SHORT session (card `0ac41d40`, owner ruling E89 (b)): the Sessions list
 * hides it by default and counts it instead. ALL of these hold, each over the
 * session's events inside the requested window and filters — the same events
 * the row's own columns show:
 *
 *   - at most `TELEMETRY_SHORT_SESSION_MAX_EVENTS` events;
 *   - last seen LESS than `TELEMETRY_SHORT_SESSION_MIN_DURATION_MS` after it
 *     started (receiver clock) — exactly two minutes is NOT short;
 *   - NO MODEL: no `model_call` event and no event naming a model provider,
 *     requested model or resolved model (the Models column reads
 *     `model.resolved` from any event kind, so a session that shows a model
 *     can never count as model-less);
 *   - NO TOKENS: input tokens and output tokens BOTH sum to zero. Both, rather
 *     than their sum, because the Tier-0 engine admits negative numbers and a
 *     sum could cancel to zero.
 *
 * The shape this exists for is the MCP-derived bootstrap, heartbeat and
 * completion of a session that did nothing else. Nothing is deleted and
 * nothing is re-labelled: retention is untouched (ruling E89 (c)), the point
 * route reads a short session by its triple like any other, and Stats count
 * every session and say how many are short.
 */
export const TELEMETRY_SHORT_SESSION_MAX_EVENTS = 3;
export const TELEMETRY_SHORT_SESSION_MIN_DURATION_MS = 120_000;

/**
 * A list page offset: a whole number of rows to skip, or 0 for anything else.
 *
 * It has no ceiling of its own because it widens nothing — the window and the
 * narrowing bound the scan and the row limit bounds the page, whatever the
 * offset. It is held to a safe integer only so the value always reaches
 * PostgreSQL as a plain integer.
 */
export function sessionPageOffset(requested: unknown): number {
  const value = typeof requested === 'number' ? requested : Number(requested);
  if (!Number.isFinite(value) || value < 1) return 0;
  return Math.floor(Math.min(value, Number.MAX_SAFE_INTEGER));
}

// ───────────────────────────── the vocabularies ──────────────────────────────

/** The SHIPPED C7 chip vocabulary (design §10.1). Not extended by this card. */
export const TELEMETRY_PRESENCE_STATES = ['active', 'idle', 'stale'] as const;
export type TelemetryPresenceState = (typeof TELEMETRY_PRESENCE_STATES)[number];

/** The Sessions-row vocabulary: four of the seven labels the UI already paints. */
export const TELEMETRY_SESSION_STATES = ['active', 'idle', 'stale', 'finished'] as const;
export type TelemetrySessionState = (typeof TELEMETRY_SESSION_STATES)[number];

/** Envelope phases the Tier-0 engine admits, as this module reads them. */
const TERMINAL_PHASES = new Set(['completed', 'failed', 'cancelled']);
const IDLE_PHASES = new Set(['waiting']);

// ─────────────────────────── the pure derivations ────────────────────────────

/**
 * Presence, from ONE observation. Pure, exported, and the only place the
 * mapping lives.
 *
 * The order is the contract: AGE FIRST. A source that stopped reporting mid
 * `running` is `stale`, never `active` — silence outranks the last thing it
 * said, which is the whole point of a derived staleness window. `idle` is the
 * explicit waiting signal; everything else fresh is `active`. §10.1, exactly:
 * "envelope activity in flight -> active; explicit idle/waiting signals ->
 * idle; silence -> stale".
 */
export function derivePresenceState(
  nowMs: number,
  lastSeenAtMs: number,
  phase: string | null,
  staleMs: number = TELEMETRY_STALE_MS,
): TelemetryPresenceState {
  if (nowMs - lastSeenAtMs >= staleMs) return 'stale';
  if (phase !== null && IDLE_PHASES.has(phase)) return 'idle';
  return 'active';
}

/**
 * Session state, from the newest event of the session.
 *
 * TERMINAL FIRST, and deliberately ahead of age: a session that COMPLETED an
 * hour ago is `finished`, not `stale`. `stale` means "we do not know", and we
 * do know — the source told us it ended. Reversing these two would relabel
 * every finished session as stale nine minutes later and lose the distinction
 * the timeline exists to show.
 */
export function deriveSessionState(
  nowMs: number,
  lastSeenAtMs: number,
  phase: string | null,
  staleMs: number = TELEMETRY_STALE_MS,
): TelemetrySessionState {
  if (phase !== null && TERMINAL_PHASES.has(phase)) return 'finished';
  return derivePresenceState(nowMs, lastSeenAtMs, phase, staleMs);
}

// ──────────────────────────────── the shapes ─────────────────────────────────

/** One telemetry source: the §5.3 selectable object `(connector, product)`. */
export interface TelemetrySourceRow {
  connectorId: string;
  connectorHandle: string | null;
  /**
   * The Connector principal's display name (`principals.display_name`), so a
   * person reads the name the Connector was given rather than a derived handle (card
   * `35b73092`). Additive: the same row, the same narrowing, one more column
   * of a principal this row already names.
   */
  connectorDisplayName: string | null;
  accountId: string;
  sourceProduct: string;
  /** §8.2 coverage labels, as the newest event of the source declared them. */
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
}

export interface TelemetryPresenceRow extends TelemetrySourceRow {
  /** The SHIPPED chip vocabulary, derived from the envelope observation. */
  state: TelemetryPresenceState;
  /**
   * Which observation the state was derived from. Always `'envelope'` at TW1c:
   * §10.1's synthesis for envelope-only sources, so such a source is not
   * permanently stale merely because it emits no C7 frames.
   */
  basis: 'envelope';
  /**
   * The owning Connector's OWN newest C7 frame, when it pushes any, and
   * DELIBERATELY NOT merged into `state`.
   *
   * A frame proves the reporting process is alive; it carries no
   * `source.product` (migration 092 has no such column), so it cannot say
   * WHICH source is alive. Folding it into the state would let one live
   * reporter paint every product it ever reported as active — including one
   * that died an hour ago. So it is surfaced beside the state, labelled, and
   * the state stays a statement about the source.
   *
   * Bounded claim: this is the CONNECTOR's own frames only
   * (`principal_id = connector_id`). A frame pushed by an Agent beneath that
   * Connector is recorded against the Agent — "each principal writes only its
   * own frames" — and is not read here.
   *
   * OWNERSHIP IS THE CALLER'S OWN NARROWING, asked of the Connector's CURRENT
   * chain head (`CONNECTOR_CHAIN_HEAD`) — the same resolution write
   * attribution uses. `null` here therefore means "no frame this caller owns",
   * and a reporter that has moved to another Account stops showing its live
   * frame to the one it left.
   */
  connectorFrame: { state: TelemetryPresenceState; receivedAt: string; kind: string } | null;
}

export interface TelemetrySessionRow {
  sessionRef: string;
  connectorId: string;
  connectorHandle: string | null;
  /** As on the source row: the Connector principal's display name. */
  connectorDisplayName: string | null;
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

/** The short-session thresholds, as the list and Stats report them. */
export interface TelemetryShortSessionRule {
  maxEvents: number;
  minDurationMs: number;
}

/**
 * One page of the Sessions list (card `0ac41d40`).
 *
 * `shortCount`, `hiddenCount` and `total` come from the SAME statement as the
 * rows, so they describe exactly the set the page was cut from.
 */
export interface TelemetrySessionPage {
  sessions: TelemetrySessionRow[];
  /** Short sessions withheld from this list: `shortCount`, or 0 with `includeShort`. */
  hiddenCount: number;
  /** Short sessions inside the window and filters, whether shown or not. */
  shortCount: number;
  /** Rows the list holds under the current filters and toggle, across every page. */
  total: number;
  offset: number;
  limit: number;
  /** The offset of the next page, or null on the last one. */
  nextOffset: number | null;
  windowDays: number;
  windowStart: string;
  includeShort: boolean;
  shortSession: TelemetryShortSessionRule;
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
 * The identity of ONE session, in full.
 *
 * Three required fields, because the grouping key is a triple and a partial
 * key does not name a session (round-1 review `f4c56960`). Written as a type
 * rather than as three positional arguments so that adding a fourth member
 * later is a compile error at every call site instead of a silent widening.
 */
export interface TelemetrySessionKey {
  sessionRef: string;
  connectorId: string;
  sourceProduct: string;
}

/**
 * One row of an MCP-derived session's ACTION LOG (card `ab8f78e9`, owner
 * ruling E91): which tool ran, the allowlisted object it named, how it ended
 * and how long it took. Every field is a closed vocabulary, a UUID, a number
 * or a time — `mcp_action_log` has no column for arguments or free text.
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
  /** True when the timeline was cut by the event limit. */
  truncated: boolean;
  /**
   * The session's MCP action log, newest first — always empty for a session
   * whose product is not `mcp` (card `ab8f78e9`). Read only after the session
   * itself resolved under the caller's narrowing, and narrowed again per row.
   */
  actions: TelemetrySessionAction[];
  /** True when the action log was cut by the event limit. */
  actionsTruncated: boolean;
}

export interface TelemetryModelMixRow {
  provider: string | null;
  model: string | null;
  events: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TelemetryCostRow {
  currency: string | null;
  basis: string;
  amount: string;
  events: number;
}

export interface TelemetryStats {
  windowDays: number;
  windowStart: string;
  totals: {
    events: number;
    sessions: number;
    sources: number;
    errors: number;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cachedReadTokens: number;
    reasoningTokens: number;
    toolTokens: number;
    totalTokens: number;
    /**
     * How many of `sessions` are SHORT (card `0ac41d40`), and how many of
     * `events` they hold. The totals above INCLUDE them: Stats count every
     * session and event received in the window, and the page labels the
     * short share rather than subtracting it.
     */
    shortSessions: number;
    shortSessionEvents: number;
  };
  shortSession: TelemetryShortSessionRule;
  modelMix: TelemetryModelMixRow[];
  cost: TelemetryCostRow[];
  coverage: TelemetryPresenceRow[];
}

export interface TelemetryProjectionOptions {
  /** Days back from now. Narrow-only; ceiling `TELEMETRY_PROJECTION_MAX_WINDOW_DAYS`. */
  windowDays?: number;
  /** Row cap. Narrow-only; ceiling `TELEMETRY_PROJECTION_MAX_ROWS`. */
  limit?: number;
  /** Injected for determinism in tests; defaults to the board clock. */
  now?: Date;
}

/** The Sessions list's own options (card `0ac41d40`). */
export interface TelemetrySessionListOptions extends TelemetryProjectionOptions {
  /** Rows to skip, after the short filter and in list order. See `sessionPageOffset`. */
  offset?: number;
  /** List short sessions too. Default false: they are hidden and counted. */
  includeShort?: boolean;
  /** Narrow to one reporting Connector. Applied AFTER the caller's narrowing. */
  connectorId?: string | null;
  /** Narrow to one product. Applied AFTER the caller's narrowing. */
  sourceProduct?: string | null;
}

// ─────────────────────────────── SQL helpers ─────────────────────────────────

/**
 * The envelope discriminator. `schema_version IS NOT NULL` is what migration
 * 111 made both TW1c indexes partial on, and it is what separates envelope
 * rows from the 055 hermes ingestion rows that carry no principal binding at
 * all. Every query in this file starts with it.
 */
const ENVELOPE = 'e.schema_version IS NOT NULL';

/**
 * A JSONB scalar read as a number, or NULL — never a cast error.
 *
 * The Tier-0 engine stores usage/timing/context values through `retainNumber`,
 * so they ARE JSON numbers; but `usage.cost.amount` is explicitly allowed
 * through as a STRING when the reporter sent one (`TelemetryPolicyEngine`:
 * "else if (typeof cost.amount === 'string') costOut.amount = cost.amount"),
 * and a non-numeric string would make a bare `::numeric` throw — turning one
 * reporter's typo into a 500 on everybody's Stats page. The shape test comes
 * first so the cast only ever runs on something that casts.
 */
function jsonNumber(expr: string): string {
  return `CASE WHEN (${expr}) ~ '^-?[0-9]+(\\.[0-9]+)?([eE][-+]?[0-9]+)?$' THEN (${expr})::numeric ELSE NULL END`;
}

const USAGE = (key: string): string => jsonNumber(`e.payload->'usage'->>'${key}'`);

/**
 * THE ONLY PLACE THIS MODULE READS `session_events`, and the reason an
 * unnarrowed read is not writable here rather than merely absent.
 *
 * Two rounds of review found the same class twice — a correlated LATERAL that
 * read another Account's rows — and two rounds of controls tried to close it
 * by COUNTING: first "every statement contains the conjunct", then "the
 * conjunct occurs as often as the table is read". Round 2 (`a4a748d5`, MAJOR)
 * broke the second one the same way the first was broken: move both
 * narrowings onto one read and the counts still balance while the other read
 * is wide open. A third counting control would have been the third census of a
 * thing that has no census-shaped answer.
 *
 * So the census is off the assertion path. `FROM session_events` is written
 * ONCE, here, and it emits the envelope discriminator and the caller's
 * rendered narrowing before any caller-supplied predicate. `narrowing` is the
 * FIRST parameter and is not optional — the same shape `TelemetryReadScope`
 * uses on every public method, for the same reason: a read that forgets it
 * does not compile. `telemetryProjectionContract.test.ts` asserts that the
 * string `session_events` appears exactly once in this file, which is a
 * structural fact about the source rather than a count over rendered SQL, and
 * a redistribution of predicates cannot satisfy it.
 *
 * The narrowing is passed ALREADY RENDERED, so a correlated read inside a
 * statement binds the very same `$n` its outer query bound. That is the whole
 * of the round-2 lesson stated in SQL: the Account belongs in the NARROWING of
 * every read, never in the group KEY of any of them.
 */
function envelopeRead(narrowing: TelemetryScopeSql, ...identity: string[]): string {
  return [
    'FROM session_events e',
    `WHERE ${ENVELOPE}`,
    `  AND ${narrowing.sql}`,
    ...identity.map((predicate) => `  AND ${predicate}`),
  ].join('\n            ');
}

/**
 * THE PER-SESSION AGGREGATE AND ITS SHORT CLASSIFICATION, written ONCE.
 *
 * Two CTEs, `grouped` then `classified`, for the list and for the Stats split
 * alike — so the rule that hides a session from the list and the rule that
 * counts it as short on Stats are the same SQL and cannot drift. The read goes
 * through `envelopeRead` like every other: the caller's narrowing first, then
 * the window, then any filter, so a filter can only narrow what the caller
 * could already read.
 *
 * The group key is the triple and never the Account (review `a4a748d5`). The
 * thresholds are the exported constants, rendered as literals because they
 * are module constants and not request values.
 */
function classifiedSessionsSql(narrowing: TelemetryScopeSql, filters: string[]): string {
  return `grouped AS (
         -- THE SESSION KEY IS THE TRIPLE, and the Account is not a fourth
         -- member of it (review \`a4a748d5\`, BLOCKER). Grouping additionally
         -- by \`account_id\` split a re-parented Connector's ONE advertised
         -- session into an old-Account row and a new-Account row — while
         -- \`TelemetrySessionRow\`, the point route, the react-query key, the
         -- React key and the DOM id all remained triples. Root saw two
         -- indistinguishable rows, the older was unaddressable, and
         -- \`stats.totals.sessions\` counted the triple once while this list
         -- returned it twice. The Account does its work in the narrowing of
         -- every read, where it cannot split an identity.
         SELECT e.session_ref,
                e.connector_id,
                e.source_product,
                MIN(e.observed_at)                                        AS started_at,
                MAX(e.observed_at)                                        AS last_seen_at,
                COUNT(*)                                                  AS event_count,
                COUNT(*) FILTER (WHERE e.event_kind = 'error')            AS error_count,
                COALESCE(SUM(${USAGE('input_tokens')}), 0)                AS input_tokens,
                COALESCE(SUM(${USAGE('output_tokens')}), 0)               AS output_tokens,
                COALESCE(SUM(${USAGE('requests')}), 0)                    AS requests,
                BOOL_OR(e.event_kind = 'model_call'
                        OR e.payload->'model'->>'provider' IS NOT NULL
                        OR e.payload->'model'->>'requested' IS NOT NULL
                        OR e.payload->'model'->>'resolved' IS NOT NULL)   AS has_model
           ${envelopeRead(narrowing, 'e.session_ref IS NOT NULL', 'e.observed_at >= $1', ...filters)}
          GROUP BY e.session_ref, e.connector_id, e.source_product
       ),
       classified AS (
         SELECT g.*,
                (g.event_count <= ${TELEMETRY_SHORT_SESSION_MAX_EVENTS}
                 AND g.last_seen_at - g.started_at < INTERVAL '${TELEMETRY_SHORT_SESSION_MIN_DURATION_MS} milliseconds'
                 AND NOT g.has_model
                 AND g.input_tokens = 0
                 AND g.output_tokens = 0)                                  AS is_short
           FROM grouped g
       )`;
}

/** The thresholds as the routes report them, from the same constants. */
const SHORT_SESSION_RULE: TelemetryShortSessionRule = {
  maxEvents: TELEMETRY_SHORT_SESSION_MAX_EVENTS,
  minDurationMs: TELEMETRY_SHORT_SESSION_MIN_DURATION_MS,
};

/**
 * The list's TOTAL order: newest activity first, then the whole identity,
 * byte-wise. Without the identity a tie on `last_seen_at` is ordered by the
 * planner, and an offset page could repeat or skip a row; without `COLLATE
 * "C"` the text members would follow the database locale. One spelling for
 * the page and the outer select, so the two cannot disagree.
 */
const sessionListOrder = (alias: string): string =>
  `${alias}.last_seen_at DESC, ${alias}.connector_id, ${alias}.source_product COLLATE "C", `
  + `${alias}.session_ref COLLATE "C"`;

/**
 * The Connector's CURRENT chain head, as `DelegationService.resolveChain`
 * computes it — a recursive walk of `parent_principal_id` to the parentless
 * row, capped at the ratified `MAX_CHAIN_DEPTH`.
 *
 * WHY A WALK AND NOT ONE HOP. Write attribution takes the LAST link of the
 * authenticated chain (`TelemetryPrincipalService.derive`: "the Account is the
 * head of the chain"). The frame arm used to ask `p.parent_principal_id =
 * g.account_id`, which is the head only for a one-hop chain. Migration 096's
 * chain-shape trigger fires `BEFORE INSERT OR UPDATE OF parent_principal_id,
 * kind` on the row being written, so it validates the Connector when the
 * Connector is written and never revalidates it when its PARENT later gains a
 * parent of its own — after which the Connector sits two hops below its
 * Account and the one-hop test is TRUE for an intermediate that is no longer
 * the owner. Review `a4a748d5` (BLOCKER) named that as a live reporter's frame
 * shown to an Account it had left. This fails the other way: an ancestry the
 * walk cannot resolve produces no head row, the LEFT JOIN yields NULL, and the
 * narrowing against it is not TRUE.
 *
 * `MAX_CHAIN_DEPTH` is IMPORTED from `DelegationService`, never copied, so the
 * walk and the resolver cannot come to disagree about how deep a chain goes.
 *
 * THE CAP IS FOR TERMINATION, NOT FOR POLICY, and the two counts differ by one
 * on purpose. `MAX_CHAIN_DEPTH` counts LINKS and this counts STEPS, so the
 * walk can generate one node more than `resolveChain` would accept. That is
 * the deliberate direction, because a walk that stopped SHORT is the harmful
 * one: it would reach no parentless row, produce no head, and withhold a frame
 * from the very Account that owns it. Depth enforcement belongs to
 * `resolveChain` at authentication; this cap only guarantees the recursion
 * ends, and it ends on a cycle too — at the cap, with no parentless row, hence
 * no head, hence no frame.
 *
 * WHAT THIS DOES NOT CLAIM. An earlier version of this comment argued the
 * extra step was unreachable because a chain too deep to resolve "writes no
 * events and has no group here". Review `5b4b197c` (MINOR) showed that is
 * false: rows and frames written BEFORE an ancestor was re-parented survive,
 * and 096 does not revalidate descendants — so an over-depth Connector can
 * indeed have historical groups. The bound is still safe, but for the reason
 * the narrowing gives rather than the reason that comment gave: an
 * Account-scoped reader only ever has a group here for rows whose stored
 * `account_id` is its own, and it is shown the frame only when the walk's head
 * is ALSO its own. A Connector that has moved therefore shows its frame to
 * neither the Account it left nor, through this arm, any Account but its
 * current head. Root is estate-wide by design. The max-plus-one state is
 * untested, and this comment does not pretend otherwise.
 */
const CONNECTOR_CHAIN_HEAD = `
         chain AS (
           SELECT g.connector_id                     AS connector_id,
                  cp.id                              AS node_id,
                  cp.parent_principal_id             AS parent_principal_id,
                  0                                  AS depth
             FROM (SELECT DISTINCT connector_id FROM grouped) g
             JOIN principals cp ON cp.id = g.connector_id
            UNION ALL
           SELECT c.connector_id, up.id, up.parent_principal_id, c.depth + 1
             FROM chain c
             JOIN principals up ON up.id = c.parent_principal_id
            WHERE c.depth < ${MAX_CHAIN_DEPTH}
         ),
         connector_head AS (
           SELECT connector_id, node_id AS head_principal_id
             FROM chain
            WHERE parent_principal_id IS NULL
         )`;

function isoOrNull(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function iso(value: unknown): string {
  return isoOrNull(value) ?? new Date(0).toISOString();
}

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// ──────────────────────────────── the service ────────────────────────────────

export class TelemetryProjectionService {
  constructor(private readonly pool: Pool = defaultPool) {}

  /**
   * The presence projection: one row per telemetry source, with the SHIPPED
   * chip state.
   *
   * `scope` is the FIRST parameter and has no default. That is the point: this
   * service cannot be asked for an unnarrowed read, because there is no call
   * shape that omits the narrowing.
   */
  async presence(
    scope: TelemetryReadScope,
    options: TelemetryProjectionOptions = {},
  ): Promise<TelemetryPresenceRow[]> {
    const now = options.now ?? new Date();
    const windowDays = clampBound(
      options.windowDays, TELEMETRY_PROJECTION_DEFAULT_WINDOW_DAYS, TELEMETRY_PROJECTION_MAX_WINDOW_DAYS);
    const limit = clampBound(options.limit, TELEMETRY_PROJECTION_DEFAULT_ROWS, TELEMETRY_PROJECTION_MAX_ROWS);
    const windowStart = new Date(now.getTime() - windowDays * 86_400_000);

    const params: unknown[] = [windowStart];
    // ONE scope parameter, rendered against TWO columns and bound once. Every
    // read and the frame arm all refer to that same `$n`, which is what makes
    // "the same narrowing" a fact rather than an intention — and it is why
    // `frameOwner.params` is deliberately not pushed: the value is already
    // bound, and pushing it again would shift every placeholder after it.
    const scopeParam = params.length + 1;
    const narrowing = renderTelemetryScopeSql(scope, 'e.account_id', scopeParam);
    params.push(...narrowing.params);
    // The frame arm is the SAME narrowing, asked of the Connector's CURRENT
    // chain head — the resolution write attribution uses. See
    // `CONNECTOR_CHAIN_HEAD` for why one hop was wrong and which direction it
    // failed in.
    const frameOwner = renderTelemetryScopeSql(scope, 'connector_head.head_principal_id', scopeParam);
    params.push(limit);
    const limitParam = `$${params.length}`;

    const result = await this.pool.query(
      `WITH RECURSIVE grouped AS (
         SELECT e.connector_id,
                e.source_product,
                MAX(e.observed_at)                                        AS last_seen_at,
                MIN(e.observed_at)                                        AS first_seen_at,
                COUNT(*)                                                  AS event_count,
                -- The composite grain, and NOT the Account. A source is
                -- (connector, product) — design §5.3's selectable object —
                -- so within one row the pseudonym is the whole of the
                -- remaining key, and COUNT(DISTINCT session_ref) here is the
                -- same grain the estate-wide tuple count in stats produces.
                --
                -- The Account is NOT a member of this key (review \`a4a748d5\`,
                -- BLOCKER). Grouping by it split a re-parented Connector's one
                -- advertised source into two rows that no public identity
                -- could tell apart. It reaches the caller as a DERIVED
                -- attribute below — the newest row's — and it does its real
                -- work in the WHERE clause of every read.
                COUNT(DISTINCT e.session_ref)
                  FILTER (WHERE e.session_ref IS NOT NULL)                AS session_count,
                COUNT(*) FILTER (WHERE e.event_kind = 'error')            AS error_count
           ${envelopeRead(narrowing, 'e.observed_at >= $1')}
          GROUP BY e.connector_id, e.source_product
          ORDER BY MAX(e.observed_at) DESC
          LIMIT ${limitParam}
       ),${CONNECTOR_CHAIN_HEAD}
       SELECT g.*,
              latest.account_id                          AS account_id,
              p.handle                                   AS connector_handle,
              p.display_name                             AS connector_display_name,
              latest.phase                               AS last_phase,
              latest.adapter                             AS adapter,
              latest.adapter_version                     AS adapter_version,
              latest.mechanism                           AS mechanism,
              latest.support_level                       AS support_level,
              latest.last_verified                       AS last_verified,
              latest.policy_tier                         AS policy_tier,
              latest.schema_version                      AS schema_version,
              fr.kind                                    AS frame_kind,
              fr.status                                  AS frame_status,
              fr.received_at                             AS frame_received_at
         FROM grouped g
         LEFT JOIN principals p ON p.id = g.connector_id
         LEFT JOIN connector_head ON connector_head.connector_id = g.connector_id
         LEFT JOIN LATERAL (
           SELECT e.account_id                                 AS account_id,
                  e.payload->>'phase'                          AS phase,
                  e.payload->'source'->>'adapter'              AS adapter,
                  e.payload->'source'->>'adapter_version'      AS adapter_version,
                  e.payload->'source'->>'mechanism'            AS mechanism,
                  e.payload->'source'->>'support_level'        AS support_level,
                  e.payload->'source'->>'last_verified'        AS last_verified,
                  e.policy_tier                                AS policy_tier,
                  e.schema_version                             AS schema_version
             ${envelopeRead(narrowing, 'e.connector_id = g.connector_id', 'e.source_product = g.source_product')}
            ORDER BY e.observed_at DESC, e.event_id DESC
            LIMIT 1
         ) latest ON TRUE
         LEFT JOIN LATERAL (
           SELECT f.kind, f.status, f.received_at
             FROM telemetry_frames f
            WHERE f.principal_id = g.connector_id
            ORDER BY f.received_at DESC, f.id DESC
            LIMIT 1
         ) fr ON ${frameOwner.sql}
        ORDER BY g.last_seen_at DESC`,
      params,
    );

    const nowMs = now.getTime();
    return result.rows.map((row) => {
      const lastSeenAt = iso(row.last_seen_at);
      const frameReceivedAt = isoOrNull(row.frame_received_at);
      return {
        connectorId: String(row.connector_id),
        connectorHandle: text(row.connector_handle),
        connectorDisplayName: text(row.connector_display_name),
        accountId: String(row.account_id),
        sourceProduct: String(row.source_product),
        adapter: text(row.adapter),
        adapterVersion: text(row.adapter_version),
        mechanism: text(row.mechanism),
        supportLevel: text(row.support_level),
        lastVerified: text(row.last_verified),
        policyTier: numOrNull(row.policy_tier),
        schemaVersion: text(row.schema_version),
        lastSeenAt,
        firstSeenAt: iso(row.first_seen_at),
        lastPhase: text(row.last_phase),
        eventCount: num(row.event_count),
        sessionCount: num(row.session_count),
        errorCount: num(row.error_count),
        state: derivePresenceState(nowMs, new Date(lastSeenAt).getTime(), text(row.last_phase)),
        basis: 'envelope' as const,
        connectorFrame: frameReceivedAt === null ? null : {
          // The SHIPPED derivation, in the shipped order: age, then the pushed
          // word. `TelemetryService.livenessForTask` reads the same two facts
          // the same way; only the row it reads them from differs.
          state: derivePresenceState(
            nowMs,
            new Date(frameReceivedAt).getTime(),
            row.frame_kind === 'status' && row.frame_status === 'idle' ? 'waiting' : null,
          ),
          receivedAt: frameReceivedAt,
          kind: String(row.frame_kind),
        },
      };
    });
  }

  /**
   * The Sessions list: one row per session triple, Tier-0 metadata only, one
   * page at a time.
   *
   * SHORT SESSIONS ARE HIDDEN HERE, BEFORE THE LIMIT (card `0ac41d40`). The
   * `page` CTE drops them ahead of its ORDER BY, LIMIT and OFFSET, so a page
   * is always the newest SHOWN rows rather than whatever survived a filter
   * applied after the cut. `tally` counts the UNLIMITED classified set in
   * the same statement, so `hiddenCount` and `total` describe exactly the
   * set the page was cut from. `includeShort` lists them too.
   *
   * The reporter and product filters are two more predicates on the ONE
   * grouping read, after the caller's narrowing: a filter naming another
   * Account's Connector reads nothing and answers exactly as one naming no
   * Connector at all.
   */
  async sessions(
    scope: TelemetryReadScope,
    options: TelemetrySessionListOptions = {},
  ): Promise<TelemetrySessionPage> {
    const now = options.now ?? new Date();
    const windowDays = clampBound(
      options.windowDays, TELEMETRY_PROJECTION_DEFAULT_WINDOW_DAYS, TELEMETRY_PROJECTION_MAX_WINDOW_DAYS);
    const limit = clampBound(options.limit, TELEMETRY_PROJECTION_DEFAULT_ROWS, TELEMETRY_PROJECTION_MAX_ROWS);
    const offset = sessionPageOffset(options.offset);
    const includeShort = options.includeShort === true;
    const windowStart = new Date(now.getTime() - windowDays * 86_400_000);

    const params: unknown[] = [windowStart];
    const narrowing = renderTelemetryScopeSql(scope, 'e.account_id', params.length + 1);
    params.push(...narrowing.params);
    const filters: string[] = [];
    for (const [column, value] of [
      ['e.connector_id', options.connectorId],
      ['e.source_product', options.sourceProduct],
    ] as const) {
      if (value) {
        params.push(value);
        filters.push(`${column} = $${params.length}`);
      }
    }
    params.push(includeShort);
    const includeParam = `$${params.length}::boolean`;
    params.push(limit);
    const limitParam = `$${params.length}`;
    params.push(offset);
    const offsetParam = `$${params.length}`;

    const result = await this.pool.query(
      `WITH ${classifiedSessionsSql(narrowing, filters)},
       tally AS (
         -- Over the WHOLE classified set, uncut: what the page was cut from.
         SELECT COUNT(c.session_ref) FILTER (WHERE c.is_short)                  AS short_count,
                COUNT(c.session_ref) FILTER (WHERE ${includeParam} OR NOT c.is_short) AS listed_total
           FROM classified c
       ),
       page AS (
         SELECT c.*
           FROM classified c
          WHERE ${includeParam} OR NOT c.is_short
          ORDER BY ${sessionListOrder('c')}
          LIMIT ${limitParam}
         OFFSET ${offsetParam}
       )
       SELECT t.short_count,
              t.listed_total,
              g.*,
              p.handle       AS connector_handle,
              p.display_name AS connector_display_name,
              latest.phase   AS last_phase,
              models.models  AS models
         FROM tally t
         -- ON TRUE, so an EMPTY page still returns one row carrying the counts.
         LEFT JOIN page g ON TRUE
         LEFT JOIN principals p ON p.id = g.connector_id
         LEFT JOIN LATERAL (
           SELECT e.payload->>'phase' AS phase
             ${envelopeRead(narrowing,
    'e.session_ref = g.session_ref',
    'e.connector_id = g.connector_id',
    'e.source_product = g.source_product')}
            ORDER BY e.observed_at DESC, e.event_id DESC
            LIMIT 1
         ) latest ON TRUE
         LEFT JOIN LATERAL (
           SELECT ARRAY_AGG(DISTINCT m.model ORDER BY m.model) AS models
             FROM (
               -- WINDOWED and ORDERED before it is capped. Unwindowed, a
               -- caller that narrowed to a day still got model names from
               -- rows outside it; uncapped-but-unordered, a session past the
               -- cap returned a planner-dependent subset that could differ
               -- between two identical requests.
               SELECT e.payload->'model'->>'resolved' AS model
                 ${envelopeRead(narrowing,
    'e.session_ref = g.session_ref',
    'e.connector_id = g.connector_id',
    'e.source_product = g.source_product',
    'e.observed_at >= $1',
    "e.payload->'model'->>'resolved' IS NOT NULL")}
                ORDER BY e.observed_at DESC, e.event_id DESC
                LIMIT ${TELEMETRY_TIMELINE_MAX_EVENTS}
             ) m
         ) models ON TRUE
        ORDER BY ${sessionListOrder('g')}`,
      params,
    );

    const nowMs = now.getTime();
    const counts = result.rows[0] ?? {};
    const shortCount = num(counts.short_count);
    const total = num(counts.listed_total);
    // The row an empty page leaves behind carries the counts and no session.
    const sessions = result.rows
      .filter((row) => row.session_ref !== null && row.session_ref !== undefined)
      .map((row) => this.toSessionRow(row, nowMs));
    const reached = offset + sessions.length;
    return {
      sessions,
      hiddenCount: includeShort ? 0 : shortCount,
      shortCount,
      total,
      offset,
      limit,
      nextOffset: sessions.length > 0 && reached < total ? reached : null,
      windowDays,
      windowStart: windowStart.toISOString(),
      includeShort,
      shortSession: { ...SHORT_SESSION_RULE },
    };
  }

  /**
   * The POINT route for one session: the row plus its bounded timeline.
   *
   * THE KEY IS THE TRIPLE, AND A PARTIAL KEY IS NOT EXPRESSIBLE. `session_ref`
   * is `HMAC(domain, product|seed)` — namespaced by the product but NOT by the
   * Connector — so two Connectors under one Account reporting the same product
   * and the same source-side session id share a pseudonym. Keyed on the
   * pseudonym alone this method picked one group arbitrarily and then fetched
   * events for BOTH, pairing one session's header with two sessions' timeline
   * (round-1 review `f4c56960`, second blocker). The identity now arrives as
   * one object with three required fields, so a caller cannot ask a half
   * question: leaving one out is a type error, not a merged answer.
   *
   * The SAME narrowing as the list, rendered against the same column. A
   * session outside the caller's Account answers exactly as one that does not
   * exist — the caller gets `null` either way and the route turns both into
   * the same 404, so the point route is not an existence oracle for another
   * Account's sessions.
   */
  async session(
    scope: TelemetryReadScope,
    key: TelemetrySessionKey,
    options: TelemetryProjectionOptions & { events?: number } = {},
  ): Promise<TelemetrySessionDetail | null> {
    const { sessionRef, connectorId, sourceProduct } = key;
    const now = options.now ?? new Date();
    const eventLimit = clampBound(
      options.events, TELEMETRY_TIMELINE_DEFAULT_EVENTS, TELEMETRY_TIMELINE_MAX_EVENTS);

    const headParams: unknown[] = [sessionRef, connectorId, sourceProduct];
    const headNarrowing = renderTelemetryScopeSql(scope, 'e.account_id', headParams.length + 1);
    headParams.push(...headNarrowing.params);

    const head = await this.pool.query(
      `WITH grouped AS (
         -- The key is the TRIPLE plus the caller's narrowing, and all three
         -- members are already bound to $1..$3 — so this CTE yields AT MOST
         -- ONE row and there is nothing left to choose between. It used to
         -- group by \`account_id\` as well and then take the newest of the
         -- resulting groups, which meant a re-parented Connector's older
         -- Account segment was listed by \`sessions()\` and unreachable here
         -- (review \`a4a748d5\`, BLOCKER) — and, with equal \`last_seen_at\`
         -- values, arbitrarily chosen. The Account narrows; it does not key.
         SELECT e.session_ref,
                e.connector_id,
                e.source_product,
                MIN(e.observed_at)                                        AS started_at,
                MAX(e.observed_at)                                        AS last_seen_at,
                COUNT(*)                                                  AS event_count,
                COUNT(*) FILTER (WHERE e.event_kind = 'error')            AS error_count,
                COALESCE(SUM(${USAGE('input_tokens')}), 0)                AS input_tokens,
                COALESCE(SUM(${USAGE('output_tokens')}), 0)               AS output_tokens,
                COALESCE(SUM(${USAGE('requests')}), 0)                    AS requests,
                ARRAY_REMOVE(ARRAY_AGG(DISTINCT e.payload->'model'->>'resolved'), NULL) AS models
           ${envelopeRead(headNarrowing,
    'e.session_ref = $1',
    'e.connector_id = $2',
    'e.source_product = $3')}
          GROUP BY e.session_ref, e.connector_id, e.source_product
       )
       SELECT g.*, p.handle AS connector_handle, p.display_name AS connector_display_name,
              latest.phase AS last_phase
         FROM grouped g
         LEFT JOIN principals p ON p.id = g.connector_id
         LEFT JOIN LATERAL (
           SELECT e.payload->>'phase' AS phase
             ${envelopeRead(headNarrowing,
    'e.session_ref = g.session_ref',
    'e.connector_id = g.connector_id',
    'e.source_product = g.source_product')}
            ORDER BY e.observed_at DESC, e.event_id DESC
            LIMIT 1
         ) latest ON TRUE`,
      headParams,
    );

    const row = head.rows[0];
    if (!row) return null;

    const eventParams: unknown[] = [sessionRef, connectorId, sourceProduct];
    const eventNarrowing = renderTelemetryScopeSql(scope, 'e.account_id', eventParams.length + 1);
    eventParams.push(...eventNarrowing.params);
    eventParams.push(eventLimit + 1);
    const eventLimitParam = `$${eventParams.length}`;

    const events = await this.pool.query(
      `SELECT e.event_id,
              e.observed_at,
              e.source_occurred_at,
              e.event_kind,
              e.payload->>'phase'                          AS phase,
              e.payload->'model'->>'provider'              AS model_provider,
              e.payload->'model'->>'resolved'              AS model_resolved,
              e.payload->'model'->>'operation'             AS operation,
              e.payload->'outcome'->>'status'              AS outcome_status,
              e.payload->'outcome'->>'error_type'          AS error_type,
              ${jsonNumber("e.payload->'timing'->>'duration_ms'")}    AS duration_ms,
              ${USAGE('input_tokens')}                                AS input_tokens,
              ${USAGE('output_tokens')}                               AS output_tokens,
              ${jsonNumber("e.payload->'context'->>'utilization'")}   AS context_utilization
         ${envelopeRead(eventNarrowing,
    'e.session_ref = $1',
    'e.connector_id = $2',
    'e.source_product = $3')}
        ORDER BY e.observed_at DESC, e.event_id DESC
        LIMIT ${eventLimitParam}`,
      eventParams,
    );

    const truncated = events.rows.length > eventLimit;
    const rows = truncated ? events.rows.slice(0, eventLimit) : events.rows;
    const actionLog = await this.sessionActions(scope, key, eventLimit);

    return {
      session: this.toSessionRow(row, now.getTime()),
      truncated,
      actions: actionLog.actions,
      actionsTruncated: actionLog.truncated,
      events: rows.map((event) => ({
        eventId: String(event.event_id),
        observedAt: iso(event.observed_at),
        occurredAt: isoOrNull(event.source_occurred_at),
        kind: String(event.event_kind),
        phase: text(event.phase),
        modelProvider: text(event.model_provider),
        modelResolved: text(event.model_resolved),
        operation: text(event.operation),
        outcomeStatus: text(event.outcome_status),
        errorType: text(event.error_type),
        durationMs: numOrNull(event.duration_ms),
        inputTokens: numOrNull(event.input_tokens),
        outputTokens: numOrNull(event.output_tokens),
        contextUtilization: numOrNull(event.context_utilization),
      })),
    };
  }

  /**
   * The ACTION LOG of one MCP-derived session (card `ab8f78e9`).
   *
   * Reached ONLY from `session()`, after the session's own header resolved
   * under the caller's narrowing — so a session the caller cannot read yields
   * no action rows, by the same `null` and the same 404 as every other part of
   * it. Visibility is not decided here a second time; it is APPLIED a second
   * time: every action row is narrowed by its OWN `account_id` with the same
   * rendered predicate, so a Connector that changed Accounts mid-session shows
   * each Account only the rows written under it, exactly as its envelope rows.
   * A product other than `mcp` has no action log and reads nothing.
   */
  private async sessionActions(
    scope: TelemetryReadScope,
    key: TelemetrySessionKey,
    limit: number,
  ): Promise<{ actions: TelemetrySessionAction[]; truncated: boolean }> {
    if (key.sourceProduct !== MCP_ACTION_LOG_PRODUCT) return { actions: [], truncated: false };
    const params: unknown[] = [key.sessionRef, key.connectorId];
    const narrowing = renderTelemetryScopeSql(scope, 'a.account_id', params.length + 1);
    params.push(...narrowing.params);
    params.push(limit + 1);
    const result = await this.pool.query(
      `SELECT a.observed_at, a.tool_name, a.target_type, a.target_id, a.outcome, a.error_code, a.duration_ms
         FROM mcp_action_log a
        WHERE a.session_ref = $1
          AND a.connector_id = $2
          AND ${narrowing.sql}
        ORDER BY a.observed_at DESC, a.id DESC
        LIMIT $${params.length}`,
      params,
    );
    const truncated = result.rows.length > limit;
    const rows = truncated ? result.rows.slice(0, limit) : result.rows;
    return {
      truncated,
      actions: rows.map((action) => ({
        observedAt: iso(action.observed_at),
        toolName: String(action.tool_name),
        targetType: text(action.target_type),
        targetId: text(action.target_id),
        outcome: action.outcome === 'ok' ? 'ok' : 'error',
        errorCode: text(action.error_code),
        durationMs: Number(action.duration_ms),
      })),
    };
  }

  /** Stats: usage/model/cost rollups plus the adapter coverage view (§10.3). */
  async stats(
    scope: TelemetryReadScope,
    options: TelemetryProjectionOptions = {},
  ): Promise<TelemetryStats> {
    const now = options.now ?? new Date();
    const windowDays = clampBound(
      options.windowDays, TELEMETRY_PROJECTION_DEFAULT_WINDOW_DAYS, TELEMETRY_PROJECTION_MAX_WINDOW_DAYS);
    const limit = clampBound(options.limit, TELEMETRY_PROJECTION_DEFAULT_ROWS, TELEMETRY_PROJECTION_MAX_ROWS);
    const windowStart = new Date(now.getTime() - windowDays * 86_400_000);

    const params: unknown[] = [windowStart];
    const narrowing = renderTelemetryScopeSql(scope, 'e.account_id', params.length + 1);
    params.push(...narrowing.params);

    const totals = await this.pool.query(
      `SELECT COUNT(*)                                                   AS events,
              -- The COMPOSITE grain, as a row constructor.
              --
              -- A bare distinct count over the pseudonym counted PSEUDONYMS, and a
              -- pseudonym is HMAC(domain, product|seed) — namespaced by product
              -- but NOT by Connector. Two Connectors reporting the same product
              -- and the same source-side session id therefore collapsed into
              -- one session in this total while remaining two rows everywhere
              -- else on the page, so the page contradicted itself.
              --
              -- A row constructor rather than a string concatenation: string
              -- joining depends on no member being able to contain the
              -- separator, which is true today (a UUID, and PRODUCT_RE excludes
              -- '|') and is exactly the kind of premise that stops being true
              -- one validator change later. COUNT(DISTINCT (a, b, c))
              -- compares the tuple and needs no such premise.
              COUNT(DISTINCT (e.connector_id, e.source_product, e.session_ref))
                FILTER (WHERE e.session_ref IS NOT NULL)                 AS sessions,
              COUNT(DISTINCT (e.connector_id, e.source_product))         AS sources,
              COUNT(*) FILTER (WHERE e.event_kind = 'error')             AS errors,
              COALESCE(SUM(${USAGE('requests')}), 0)                     AS requests,
              COALESCE(SUM(${USAGE('input_tokens')}), 0)                 AS input_tokens,
              COALESCE(SUM(${USAGE('output_tokens')}), 0)                AS output_tokens,
              COALESCE(SUM(${USAGE('cached_read_tokens')}), 0)           AS cached_read_tokens,
              COALESCE(SUM(${USAGE('reasoning_tokens')}), 0)             AS reasoning_tokens,
              COALESCE(SUM(${USAGE('tool_tokens')}), 0)                  AS tool_tokens
         ${envelopeRead(narrowing, 'e.observed_at >= $1')}`,
      params,
    );

    // THE SHORT SPLIT (card `0ac41d40`): how many of the sessions counted
    // above are short, and how many events they hold — the SAME classified set
    // the Sessions list hides by default, over the same window and narrowing.
    // The totals above are left exactly as they were: Stats count every
    // session received, and the page labels this share instead of subtracting
    // it. One aggregate row, so it carries no row cap.
    const shortSplit = await this.pool.query(
      `WITH ${classifiedSessionsSql(narrowing, [])}
       SELECT COUNT(*) FILTER (WHERE c.is_short)                           AS short_sessions,
              COALESCE(SUM(c.event_count) FILTER (WHERE c.is_short), 0)     AS short_events
         FROM classified c`,
      params,
    );

    const mixParams = [...params, limit];
    const modelMix = await this.pool.query(
      `SELECT e.payload->'model'->>'provider'                            AS provider,
              e.payload->'model'->>'resolved'                            AS model,
              COUNT(*)                                                   AS events,
              COALESCE(SUM(${USAGE('input_tokens')}), 0)                 AS input_tokens,
              COALESCE(SUM(${USAGE('output_tokens')}), 0)                AS output_tokens
         ${envelopeRead(narrowing, 'e.observed_at >= $1', "e.payload->'model'->>'resolved' IS NOT NULL")}
        GROUP BY 1, 2
        ORDER BY COUNT(*) DESC, 2 ASC
        LIMIT $${mixParams.length}`,
      mixParams,
    );

    const costParams = [...params, limit];
    const cost = await this.pool.query(
      `SELECT e.payload->'usage'->'cost'->>'currency'                    AS currency,
              COALESCE(e.payload->'usage'->'cost'->>'basis', 'estimated') AS basis,
              COALESCE(SUM(${jsonNumber("e.payload->'usage'->'cost'->>'amount'")}), 0) AS amount,
              COUNT(*)                                                   AS events
         ${envelopeRead(narrowing, 'e.observed_at >= $1', "e.payload->'usage'->'cost'->>'amount' IS NOT NULL")}
        GROUP BY 1, 2
        ORDER BY 2 ASC, 1 ASC
        LIMIT $${costParams.length}`,
      costParams,
    );

    const coverage = await this.presence(scope, { windowDays, limit, now });
    const row = totals.rows[0] ?? {};
    const shortRow = shortSplit.rows[0] ?? {};
    const inputTokens = num(row.input_tokens);
    const outputTokens = num(row.output_tokens);

    return {
      windowDays,
      windowStart: windowStart.toISOString(),
      totals: {
        events: num(row.events),
        sessions: num(row.sessions),
        sources: num(row.sources),
        errors: num(row.errors),
        requests: num(row.requests),
        inputTokens,
        outputTokens,
        cachedReadTokens: num(row.cached_read_tokens),
        reasoningTokens: num(row.reasoning_tokens),
        toolTokens: num(row.tool_tokens),
        totalTokens: inputTokens + outputTokens,
        shortSessions: num(shortRow.short_sessions),
        shortSessionEvents: num(shortRow.short_events),
      },
      shortSession: { ...SHORT_SESSION_RULE },
      modelMix: modelMix.rows.map((mix) => {
        const mixInput = num(mix.input_tokens);
        const mixOutput = num(mix.output_tokens);
        return {
          provider: text(mix.provider),
          model: text(mix.model),
          events: num(mix.events),
          inputTokens: mixInput,
          outputTokens: mixOutput,
          totalTokens: mixInput + mixOutput,
        };
      }),
      // The amount stays a STRING all the way to the client: it is money, and
      // `numeric` -> IEEE double is exactly the conversion that loses it. The
      // page formats the string; nothing multiplies it.
      cost: cost.rows.map((entry) => ({
        currency: text(entry.currency),
        basis: String(entry.basis),
        amount: String(entry.amount),
        events: num(entry.events),
      })),
      coverage,
    };
  }

  private toSessionRow(row: Record<string, unknown>, nowMs: number): TelemetrySessionRow {
    const lastSeenAt = iso(row.last_seen_at);
    const inputTokens = num(row.input_tokens);
    const outputTokens = num(row.output_tokens);
    const models = Array.isArray(row.models)
      ? (row.models as unknown[]).filter((m): m is string => typeof m === 'string' && m.length > 0)
      : [];
    return {
      sessionRef: String(row.session_ref),
      connectorId: String(row.connector_id),
      connectorHandle: text(row.connector_handle),
      connectorDisplayName: text(row.connector_display_name),
      sourceProduct: String(row.source_product),
      state: deriveSessionState(nowMs, new Date(lastSeenAt).getTime(), text(row.last_phase)),
      startedAt: iso(row.started_at),
      lastSeenAt,
      lastPhase: text(row.last_phase),
      eventCount: num(row.event_count),
      errorCount: num(row.error_count),
      models,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      requests: num(row.requests),
    };
  }
}

export const telemetryProjectionService = new TelemetryProjectionService();
