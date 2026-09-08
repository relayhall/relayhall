/**
 * AuditPage — the board's own action ledger, on screen (card 96aeacb7).
 *
 * WHAT CHANGED. `GET /audit` and `AuditService` shipped in RH-P2.7 and are
 * documented, but this page stayed a `CoreSurfacePlaceholder` saying the
 * source would arrive in a later phase — so the product recorded who did what
 * on the board and then offered no way to read it. It reads it now.
 *
 * IT ADDS NO READ PATH. Every row on this page comes from that one route,
 * through `authenticatedFetch`, under the `audit:read` rule the route already
 * carries (`utils/scopeMap`). No second endpoint, no direct query, no
 * widening. The four extra ways to narrow — action prefix, outcome, and a
 * half-open time window — are parameters of that same handler.
 *
 * WHO THE BOARD IS THE AUTHORITY ON. Not this file. An earlier draft read
 * `/principals/me` first and skipped the request when the scopes it reported
 * did not include `audit:read`; round-1 review withdrew that precheck (O1) and
 * round 2 confirmed nothing was lost with it. The page ALWAYS asks, because a
 * client-side gate that wrongly DENIES is the failure mode worth avoiding —
 * the one that wrongly permits cannot exist, since the refusal is enforced at
 * the route. A refusal is then rendered as an answer, not an error: the
 * doctrine card 85014317 established for the plugin registry, for the same
 * reason (an ordinary Account being told "not for you" is not a defect to
 * log). The only other route this page reads is `/principals`, and only to
 * put a handle beside an actor id; when it fails the rows still render.
 *
 * DATES. `utils/dateFormat` and nowhere else (card 96984e2c), inside a
 * `<time datetime>` carrying the ledger's own UTC instant, so the machine
 * reading is exact while the human reading is unambiguous.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ChevronDown, Loader2, RefreshCw, Search, ShieldOff, X } from 'lucide-react';
import { usePrincipals } from '../hooks/usePrincipals';
import { authenticatedFetch } from '../utils/auth';
import { formatDateTime, formatDateTimeLong } from '../utils/dateFormat';
import './AuditPage.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

/** One page of the ledger. 50 keeps the first paint honest on a phone. */
const PAGE_SIZE = 50;

/**
 * The board decides who may read the ledger, and this file does not repeat
 * the decision.
 *
 * An earlier draft kept `['root', 'audit:read']` here and used it to skip a
 * request it expected to be refused. Round-1 review OBSERVATION O1: that is a
 * second authority catalogue, and the day the route accepts a third scope the
 * page denies a session the board would have served — a failure with no
 * upside, bought to save one refused request per load. The catalogue is
 * withdrawn rather than bounded. The page asks; a 403 is rendered as the
 * answer it is.
 */

interface AuditEvent {
  id: string;
  occurredAt: string;
  action: string;
  outcome: 'success' | 'denied';
  actorPrincipalId: string | null;
  actorHandle: string;
  authMethod: string;
  credentialId: string | null;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
}

interface Filters {
  actorPrincipalId: string;
  actionPrefix: string;
  outcome: '' | 'success' | 'denied';
  since: string;
  until: string;
  resourceType: string;
  resourceId: string;
}

const NO_FILTERS: Filters = {
  actorPrincipalId: '', actionPrefix: '', outcome: '',
  since: '', until: '', resourceType: '', resourceId: '',
};

/** The wall-clock grammar an `<input type="datetime-local">` produces. */
const LOCAL_WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * The instant grammar `GET /audit` reads — `backend/src/routes/audit.ts`
 * `INSTANT`, four-digit year, and `isInstant` compares every component back.
 *
 * `Date.prototype.toISOString` does NOT always produce that shape. Outside
 * years 0000-9999 it emits the expanded form (`+010000-01-01T04:59:00.000Z`),
 * and a wall time within a day of either edge of the range falls outside it in
 * some zone: `9999-12-31T23:59` in America/New_York is year 10000 in UTC. So
 * the conversion CHECKS what it produced instead of trusting the constructor,
 * and the controls step in one day from the edges (below) so that the range
 * they advertise is askable in every zone rather than in the author's.
 */
const REPRESENTABLE_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * THE RANGE THE CONTROLS ADVERTISE, WHICH IS THE RANGE THIS CONVERTS.
 *
 * Round-2 review PRODUCTION P1-R2: the controls said `0001-01-01T00:00` and
 * the conversion refused it, calling a valid boundary an hour skipped by
 * daylight saving. Two separate defects made that one sentence false, and
 * both are repaired here rather than in the control:
 *
 *   1. `new Date(year, ...)` maps years 0-99 to 1900-1999, so year 1 became
 *      1901 and failed its own round-trip. `toInstant` now writes the year
 *      with `setFullYear`, which has no such offset, for EVERY year rather
 *      than only the ones that would be remapped.
 *   2. The edge wall times convert to instants OUTSIDE the route's four-digit
 *      grammar in zones far enough from UTC. The widest offsets the tz
 *      database carries are inside +/-16 hours (America/Juneau's LMT is
 *      -15:02:19), so one whole day of margin is enough in every zone, and
 *      these two values are pushed through `toInstant` by the range test.
 */
export const WALL_CLOCK_MIN = '0001-01-02T00:00';
export const WALL_CLOCK_MAX = '9999-12-30T23:59';

/**
 * WHAT THE CONVERSION MEASURED — round-3 review, PRODUCTION P1-R3.
 *
 * This was an Error class whose MESSAGE the page turned into a sentence, and
 * the sentence named a CAUSE: "the hour it names is skipped by a daylight-
 * saving change". The conversion never established any such thing. All it
 * establishes is that a wall time does not exist on this clock; WHY a clock
 * skips an interval is open-ended — daylight saving, a dateline move (Samoa
 * skipped 30 December 2011 entirely), a war-time offset, an LMT switch — and
 * every round of naming causes has named a wrong one for some value.
 *
 * So the conversion returns an OUTCOME rather than throwing a string, and the
 * outcome is exactly what was measured:
 *
 *   ok                       a route-readable instant, or null for an empty field
 *   nonexistent-local-time   the wall time does not occur on this clock
 *   out-of-grammar           the text is not a wall clock this page reads
 *                            (`wall-clock-text`), or the instant it makes is
 *                            outside the grammar the route reads (`instant`)
 *
 * There is no `daylight-saving` member and there is no room for one: a member
 * this can never populate is a sentence the page can never justify. The UI
 * states the fact and names the zone it measured in, and stops there.
 */
export type InstantOutcome =
  | { kind: 'ok'; instant: string | null }
  | { kind: 'nonexistent-local-time'; local: string; zone: string }
  | { kind: 'out-of-grammar'; where: 'wall-clock-text' | 'instant' };

/**
 * The zone the measurement was taken in, for the sentence to name. This is the
 * zone whose clock refused the value, so saying it is the difference between
 * "that time does not exist" (in what?) and a fact the reader can act on.
 */
export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'your timezone';
  } catch {
    return 'your timezone';
  }
}

/**
 * A `datetime-local` value is wall-clock text with no offset. The ledger
 * speaks UTC instants, so the boundary is converted ONCE, here, rather than
 * being sent as-is and meaning a different moment for every reader.
 *
 * NOT `new Date(local)` (round-1 review, PRODUCTION P1). That constructor
 * NORMALISES a wall time its own clock does not have: in Europe/Warsaw the
 * clock jumps 02:00 -> 03:00 on 29 March 2026, and `2026-03-29T02:30` — a
 * value the browser control accepts and a person can type — comes back as
 * 03:30. The filter then silently answers a different question from the one
 * asked, on the surface whose entire subject is what happened when. It also
 * threw a RangeError on a year the same control accepts.
 *
 * So the components are compared back: the Date this builds must spell the
 * same wall time it was given, or the value is refused — with a sentence that
 * says what was measured and does not guess why.
 *
 * WHAT IS CLAIMED ABOUT THE CONTROLS AND THIS CONVERSION, exactly and only:
 * BOTH MIN/MAX BOUNDS DECLARED BY THE CONTROLS CONVERT TO ROUTE-READABLE
 * INSTANTS IN EVERY SUPPORTED ZONE. Nothing wider.
 *
 * Round-3 review CONTROL C4-R3 withdrew the claim that the controls and this
 * accept the SAME set — in Pacific/Kiritimati `0001-01-01T12:00` converts to a
 * route-valid instant while the rendered control reports range underflow. The
 * paragraph written to withdraw that over-claim OVER-CLAIMED IN THE OTHER
 * DIRECTION (round-4 review CONTROL C4-R4): it said everything the controls
 * advertise is inside what this accepts, and that the extra values are
 * unreachable through the form. Both halves are false, and the counterexample
 * was already being exercised two files away — `2026-03-29T02:30` in
 * Europe/Warsaw is form-reachable, the native control holds it and reports it
 * valid, and this REFUSES it on purpose, because that wall time does not
 * occur.
 *
 * The two sets are simply not comparable, and neither containment is wanted.
 * The control enforces a RANGE; this enforces EXISTENCE and route
 * representability. Each refusal is separately correct, the reader meets
 * whichever comes first, and the only relationship worth asserting is the
 * bounds one at the top of this paragraph — which `AuditPage.time.test.tsx`
 * measures off the RENDERED controls.
 *
 * AMBIGUITY, the other direction, is DISCLOSED rather than refused. When a
 * clock goes back, a wall time happens twice; both round-trip, so this
 * accepts the value and the platform resolves it to the EARLIER instant —
 * the offset in force before the transition. Refusing an hour that exists
 * would be worse than reading it as its first occurrence, and the filter
 * form says which one it takes.
 */
export function readInstant(local: string): InstantOutcome {
  if (!local) return { kind: 'ok', instant: null };
  const parts = LOCAL_WALL_CLOCK.exec(local);
  if (!parts) return { kind: 'out-of-grammar', where: 'wall-clock-text' };
  const [, y, mo, d, h, mi, s] = parts;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = s === undefined ? 0 : Number(s);
  // NOT `new Date(year, ...)` for the year (round-2 review, PRODUCTION
  // P1-R2): that constructor treats a numeric year of 0-99 as 1900-1999, so
  // `0001-01-02T00:00` — the value the control advertises as its own minimum
  // — built 1901, failed the round-trip below and was reported to the reader
  // as an hour daylight saving had skipped. `setFullYear` carries no such
  // offset, and it is used for every year so that no year is a special case.
  // The order matters: the DATE is placed first, from a base instant that
  // exists in every zone, and the wall time is written onto THAT day. Setting
  // the time first would ask whether the hour exists on 1 January 2000 rather
  // than on the day the reader asked about, and the round-trip below would
  // then answer a question nobody put.
  const date = new Date(2000, 0, 1, 12, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, second, 0);
  const spellsItselfBack = date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day
    && date.getHours() === hour
    && date.getMinutes() === minute
    && date.getSeconds() === second;
  // MEASURED, NOT DIAGNOSED: the clock did not give back the wall time it was
  // handed, so that wall time does not occur on it. Which transition removed
  // it is not asked and not answered.
  if (!spellsItselfBack) return { kind: 'nonexistent-local-time', local, zone: localZone() };
  const instant = date.toISOString();
  // The wall time exists; its INSTANT still has to be one the route can read.
  // Checked rather than assumed, because `toISOString` widens the year field
  // silently outside 0000-9999 and the reader would meet that as a 400.
  if (!REPRESENTABLE_INSTANT.test(instant)) return { kind: 'out-of-grammar', where: 'instant' };
  return { kind: 'ok', instant };
}

/**
 * Two questions are the SAME question when they make the same call. The
 * cursor is already inside the query string, but it also decides which
 * spinner runs, so it is part of the identity rather than assumed into it.
 */
function requestKey(cursor: string | null, query: string): string {
  return `${cursor ?? ''}::${query}`;
}

/** The query the applied filters make, or the reason they make none. */
function buildQuery(filters: Filters, cursor: string | null): string | { error: string } {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor) params.set('before', cursor);
  if (filters.actorPrincipalId) params.set('actorPrincipalId', filters.actorPrincipalId);
  if (filters.outcome) params.set('outcome', filters.outcome);
  if (filters.resourceType.trim()) params.set('resourceType', filters.resourceType.trim());
  if (filters.resourceId.trim()) params.set('resourceId', filters.resourceId.trim());

  const prefix = filters.actionPrefix.trim().toLowerCase();
  if (prefix) {
    // Said here as well as at the route, because the person typing gets the
    // answer without a round trip and without a 400 they have to interpret.
    if (!/^[a-z][a-z0-9_.]{0,127}$/.test(prefix)) {
      return { error: 'An action filter is lower-case letters, digits, dots and underscores, starting with a letter.' };
    }
    params.set('actionPrefix', prefix);
  }

  // ONE SENTENCE PER OUTCOME, and no sentence says more than its outcome
  // carries (round-3 review PRODUCTION P1-R3). The refused-wall-time sentence
  // names the ZONE the measurement was taken in and the value that is missing
  // from it. It does not name daylight saving, because the measurement does
  // not distinguish a daylight-saving gap from Samoa's 2011 dateline move,
  // and a confident wrong reason is worse than a plain right one.
  const readTime = (which: 'from' | 'to', value: string): string | null | { error: string } => {
    const outcome = readInstant(value);
    if (outcome.kind === 'ok') return outcome.instant;
    if (outcome.kind === 'nonexistent-local-time') {
      return { error: `That "${which}" time does not exist in ${outcome.zone}: the local clock there never reaches ${outcome.local}. Pick another.` };
    }
    if (outcome.where === 'instant') {
      return { error: `That "${which}" time is outside the range this page can ask about on your clock: ${WALL_CLOCK_MIN} to ${WALL_CLOCK_MAX}.` };
    }
    return { error: `That "${which}" time is not a date this page can read. It takes a date and time between ${WALL_CLOCK_MIN} and ${WALL_CLOCK_MAX}.` };
  };
  const readSince = readTime('from', filters.since);
  if (readSince && typeof readSince === 'object') return readSince;
  const readUntil = readTime('to', filters.until);
  if (readUntil && typeof readUntil === 'object') return readUntil;
  const since = readSince as string | null;
  const until = readUntil as string | null;
  if (since && until && Date.parse(since) >= Date.parse(until)) {
    return { error: 'The "from" time must be earlier than the "to" time.' };
  }
  if (since) params.set('since', since);
  if (until) params.set('until', until);
  return params.toString();
}

export const AuditPage: React.FC = () => {
  const { byId: principalsById, principals } = usePrincipals();

  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The board said "not for you". An answer about this session, not a fault. */
  const [refused, setRefused] = useState(false);
  const [selected, setSelected] = useState<AuditEvent | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  /** The row button the drawer was opened from; focus goes back to it. */
  const openerRef = useRef<HTMLButtonElement | null>(null);
  /**
   * THE REQUEST IN FLIGHT, AND THE QUESTION IT IS ASKING — round-3 review,
   * PRODUCTION P3-R3.
   *
   * This was a monotonic counter, and a counter can only IGNORE a late
   * answer; it cannot stop the request that produced it. Two Refresh clicks
   * issue byte-identical `/audit` URLs. The second made the first stale, so a
   * successful first answer was discarded — and because the second request
   * was still running, the page sat at "Reading the audit log..." with
   * neither rows nor an error for as long as that transport took, which for a
   * transport that never settles is forever.
   *
   * Two changes, and between them that state is unreachable:
   *
   *   1. A NEWER QUESTION ABORTS THE OLDER REQUEST. An `AbortController` per
   *      question does the thing the counter could not: the superseded
   *      request is CANCELLED, not left running and ignored. A settled older
   *      request cannot write, because its controller is aborted; a
   *      never-settling one is not merely ignored, it is stopped.
   *   2. AN IDENTICAL QUESTION IS NOT A NEW ONE. If the request already in
   *      flight makes the same call, this adopts it rather than starting a
   *      second. That is the actual defect the counter had: it treated a
   *      duplicate as a different question and threw away an answer that
   *      answered it exactly.
   */
  const inFlight = useRef<{ key: string; controller: AbortController } | null>(null);

  const load = useCallback(async (filters: Filters, cursor: string | null) => {
    // THE QUESTION IS BUILT FIRST, AND BUILDING IT WRITES NOTHING: `buildQuery`
    // is pure, so this cannot be the "old request is still current" bug the
    // round-2 repair fixed (PRODUCTION P3-R2). That repair's requirement — a
    // new question invalidates the last answer whether or not it can be SENT —
    // is kept below: the abort runs on every path out of here except the one
    // where the question is literally the one already being asked.
    const query = buildQuery(filters, cursor);

    if (typeof query === 'string' && inFlight.current?.key === requestKey(cursor, query)) {
      // The same question is already in flight, so its answer is this
      // question's answer. Starting a second request could only produce two
      // answers to one question plus a rule for discarding one of them, which
      // is where P3-R3 came from. The spinner on screen belongs to the
      // request being adopted, so nothing here is touched.
      return;
    }

    inFlight.current?.controller.abort();
    inFlight.current = null;

    if (typeof query !== 'string') {
      // A FRESH question that cannot be asked invalidates the last answer
      // (round-1 review, PRODUCTION P3). Leaving `events` and `nextCursor`
      // behind left the header claiming a count for a query that never ran
      // and "load older events" offering the PREVIOUS query's cursor under
      // the new filters. A load-more failure is different: the rows on
      // screen were read successfully and stay, and the button is the retry.
      if (!cursor) {
        setEvents([]);
        setNextCursor(null);
      }
      setError(query.error);
      setLoading(false);
      setLoadingMore(false);
      return;
    }
    const controller = new AbortController();
    inFlight.current = { key: requestKey(cursor, query), controller };
    setError(null);
    if (cursor) setLoadingMore(true); else setLoading(true);
    try {
      const response = await authenticatedFetch(
        `${API_BASE}/audit?${query}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      // A REFUSAL IS AN ANSWER (card 85014317). 401 is handled globally by
      // authenticatedFetch, which clears the session and reloads; 403 lands
      // here and means this Account may not read the ledger.
      if (response.status === 403 || response.status === 401) {
        setRefused(true);
        setEvents([]);
        setNextCursor(null);
        return;
      }
      const data = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok || !data.success) {
        throw new Error(data.message || data.error || 'Could not read the audit log');
      }
      const page: AuditEvent[] = Array.isArray(data.events) ? data.events : [];
      setRefused(false);
      setEvents(current => (cursor ? [...current, ...page] : page));
      setNextCursor(typeof data.nextCursor === 'string' ? data.nextCursor : null);
    } catch (caught) {
      // OUR OWN CANCELLATION IS NOT A FAILURE. An aborted request rejects; if
      // this is the abort a newer question performed, the newer question owns
      // the page and nothing here may write.
      if (controller.signal.aborted) return;
      // Same rule as the unaskable query above: a fresh read that failed
      // leaves no count and no cursor to reason with.
      if (!cursor) {
        setEvents([]);
        setNextCursor(null);
      }
      setError(caught instanceof Error ? caught.message : 'Could not read the audit log');
    } finally {
      if (inFlight.current?.controller === controller) {
        inFlight.current = null;
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => {
    load(applied, null);
  }, [applied, load]);

  const applyFilters = (event: React.FormEvent) => {
    event.preventDefault();
    setSelected(null);
    setApplied(draft);
  };

  const clearFilters = () => {
    setSelected(null);
    setDraft(NO_FILTERS);
    setApplied(NO_FILTERS);
  };

  const actorLabel = useCallback((event: AuditEvent): string => {
    const principal = event.actorPrincipalId ? principalsById.get(event.actorPrincipalId) : undefined;
    if (principal?.displayName) return `${principal.displayName} (${event.actorHandle})`;
    return event.actorHandle;
  }, [principalsById]);

  /** Whether the empty state should say 'nothing yet' or 'nothing matches'. */
  const hasFilters = Object.values(applied).some(value => value.trim() !== '');

  const actorOptions = useMemo(
    () => principals
      .map(principal => ({
        id: principal.id,
        label: principal.displayName ? `${principal.displayName} (${principal.handle})` : principal.handle,
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    [principals],
  );

  const openDetail = (event: AuditEvent, trigger: HTMLButtonElement) => {
    openerRef.current = trigger;
    setSelected(event);
  };

  const closeDetail = useCallback(() => {
    setSelected(null);
    // Focus must come back where it left, or a keyboard reader is returned to
    // the top of the document with no idea which row they had open.
    openerRef.current?.focus();
  }, []);

  /**
   * A FOCUS TRAP, because `aria-modal="true"` is a claim.
   *
   * Announcing modality to a screen reader while Tab walks out of the dialog
   * and into the record behind it tells that reader something untrue about
   * where they are. This is the same cycle `ConfirmationModal` implements
   * (design 986be411 §9); focus RESTORATION stays in `closeDetail`, which is
   * the one place that knows the drawer was dismissed rather than unmounted,
   * so there is a single owner of it.
   */
  useEffect(() => {
    const node = drawerRef.current;
    if (!selected || !node) return;
    const focusables = () => Array.from(
      node.querySelectorAll<HTMLElement>('button, input, [href], [tabindex]:not([tabindex="-1"])'),
    ).filter(element => !element.hasAttribute('disabled'));
    (focusables()[0] ?? node).focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    node.addEventListener('keydown', onKeyDown);
    return () => node.removeEventListener('keydown', onKeyDown);
  }, [selected]);

  /** Arrow keys walk the rows; Home/End jump. Enter/Space are the button's. */
  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const rows = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-audit-row]') ?? [],
    );
    if (rows.length === 0) return;
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    if (event.key === 'ArrowDown') next = current < 0 ? 0 : Math.min(current + 1, rows.length - 1);
    if (event.key === 'ArrowUp') next = current < 0 ? rows.length - 1 : Math.max(current - 1, 0);
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = rows.length - 1;
    if (next !== current || current < 0) {
      event.preventDefault();
      rows[next]?.focus();
    }
  };

  if (refused) {
    return (
      <div className="audit-page">
        <div className="audit-header audit-page-audit-header">
          <h1><Activity size={24} aria-hidden="true" /> Audit log</h1>
        </div>
        <div className="audit-ledger-refused" role="note">
          <ShieldOff size={20} aria-hidden="true" />
          <span>
            The audit log records who did what on this board, and reading it
            needs the <code>audit:read</code> permission. This account does not
            have it. An administrator can grant it; nothing is missing from the
            record.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="audit-page">
      <div className="audit-header audit-page-audit-header">
        <h1><Activity size={24} aria-hidden="true" /> Audit log</h1>
        <div className="audit-header-actions">
          {/* A count is a claim about the record. With nothing read, there is
              nothing to count and the page says nothing (round-1 review P3). */}
          {events.length > 0 && (
            <span className="audit-ledger-count">
              {events.length}{nextCursor ? '+' : ''} {events.length === 1 ? 'event' : 'events'}
            </span>
          )}
          <button
            type="button"
            className="audit-btn"
            onClick={() => load(applied, null)}
            aria-label="Refresh the audit log"
          >
            <RefreshCw size={16} aria-hidden="true" /> Refresh
          </button>
        </div>
      </div>

      <p className="audit-ledger-intro">
        Every credential, grant and owner-plane act on this board, plus the
        refusals worth recording. The record is append-only and kept
        indefinitely: nothing here can be edited or removed.
      </p>

      <form className="audit-filters audit-search-form" onSubmit={applyFilters} aria-labelledby="audit-filters-heading">
        <h2 id="audit-filters-heading" className="audit-ledger-filters-heading">Narrow the record</h2>
        <div className="audit-ledger-filter-grid">
          <div className="form-group">
            <label htmlFor="audit-actor">Actor</label>
            <select
              id="audit-actor"
              className="form-select"
              value={draft.actorPrincipalId}
              onChange={event => setDraft({ ...draft, actorPrincipalId: event.target.value })}
            >
              <option value="">Anyone</option>
              {actorOptions.map(option => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="audit-action">Action starts with</label>
            <input
              id="audit-action"
              className="form-input"
              type="text"
              placeholder="credential."
              value={draft.actionPrefix}
              onChange={event => setDraft({ ...draft, actionPrefix: event.target.value })}
            />
          </div>
          <div className="form-group">
            <label htmlFor="audit-outcome">Outcome</label>
            <select
              id="audit-outcome"
              className="form-select"
              value={draft.outcome}
              onChange={event => setDraft({ ...draft, outcome: event.target.value as Filters['outcome'] })}
            >
              <option value="">Any outcome</option>
              <option value="success">Succeeded</option>
              <option value="denied">Refused</option>
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="audit-since">From</label>
            <input
              id="audit-since"
              className="form-input"
              type="datetime-local"
              min={WALL_CLOCK_MIN}
              max={WALL_CLOCK_MAX}
              value={draft.since}
              onChange={event => setDraft({ ...draft, since: event.target.value })}
            />
          </div>
          <div className="form-group">
            <label htmlFor="audit-until">To <span className="audit-ledger-hint">exclusive</span></label>
            <input
              id="audit-until"
              className="form-input"
              type="datetime-local"
              min={WALL_CLOCK_MIN}
              max={WALL_CLOCK_MAX}
              value={draft.until}
              onChange={event => setDraft({ ...draft, until: event.target.value })}
            />
          </div>
          <div className="form-group">
            <label htmlFor="audit-resource-type">Target type</label>
            <input
              id="audit-resource-type"
              className="form-input"
              type="text"
              placeholder="grant"
              value={draft.resourceType}
              onChange={event => setDraft({ ...draft, resourceType: event.target.value })}
            />
          </div>
          <div className="form-group">
            <label htmlFor="audit-resource-id">Target id</label>
            <input
              id="audit-resource-id"
              className="form-input"
              type="text"
              placeholder="Exact id of one object"
              value={draft.resourceId}
              onChange={event => setDraft({ ...draft, resourceId: event.target.value })}
            />
          </div>
        </div>
        <p className="audit-ledger-clock-note">
          The two times are read on your own clock and sent to the board as UTC
          instants; the record below is shown on your clock too. The window
          includes its start and excludes its end, so two windows that meet
          cover the record once each. An hour your clock passes through twice
          is read as its first occurrence; an hour it skips is refused rather
          than quietly moved.
        </p>
        <div className="audit-ledger-filter-actions">
          <button type="submit" className="audit-btn audit-btn-primary">
            <Search size={16} aria-hidden="true" /> Apply
          </button>
          <button type="button" className="audit-btn" onClick={clearFilters}>Clear</button>
        </div>
      </form>

      {error && <div className="audit-ledger-error" role="alert">{error}</div>}

      <section className="audit-ledger-list" aria-labelledby="audit-events-heading">
        <h2 id="audit-events-heading" className="audit-ledger-list-heading">Recorded actions</h2>
        {loading ? (
          <div className="audit-ledger-state" role="status">
            <Loader2 className="audit-ledger-spin" aria-hidden="true" /> Reading the audit log…
          </div>
        ) : events.length === 0 ? (
          error ? (
            // Say NOTHING about the contents of a ledger this page failed to
            // read. "Nothing has been recorded yet" under an error banner is a
            // claim about the record, and the page has no basis for it: an
            // empty ledger and an unreadable one look the same from here and
            // mean opposite things.
            null
          ) : (
            <div className="audit-ledger-empty">
              {!hasFilters
                ? 'Nothing has been recorded yet. Acts on credentials, grants and the owner plane will appear here as they happen.'
                : 'No recorded action matches these filters.'}
            </div>
          )
        ) : (
          <div className="audit-ledger-table">
          <div className="audit-ledger-columns" aria-hidden="true">
            <span>When</span>
            <span>Action</span>
            <span>Outcome</span>
            <span>Actor</span>
            <span>Target</span>
            <span />
          </div>
          <div
            className="audit-ledger-rows"
            ref={listRef}
            onKeyDown={onListKeyDown}
            role="list"
            aria-label="Recorded actions, newest first"
          >
            {events.map(event => (
              <div className="audit-ledger-row" role="listitem" key={event.id}>
                <button
                  type="button"
                  data-audit-row
                  className="audit-event-header"
                  aria-expanded={selected?.id === event.id}
                  onClick={mouse => openDetail(event, mouse.currentTarget)}
                >
                  <time className="audit-ledger-when" dateTime={event.occurredAt}>
                    {formatDateTime(event.occurredAt, event.occurredAt)}
                  </time>
                  <span className="audit-ledger-action">{event.action}</span>
                  <span className={event.outcome === 'denied' ? 'audit-ledger-outcome audit-ledger-outcome-denied' : 'audit-ledger-outcome'}>
                    {event.outcome === 'denied' ? 'Refused' : 'Succeeded'}
                  </span>
                  <span className="audit-ledger-actor">{actorLabel(event)}</span>
                  <span className="audit-ledger-target">
                    {event.resourceType}{event.resourceId ? ` · ${event.resourceId}` : ''}
                  </span>
                  <ChevronDown size={16} aria-hidden="true" className="audit-ledger-chevron" />
                </button>
              </div>
            ))}
          </div>
          </div>
        )}

        {/* Only offer more of something there is some of. After a failed
            fresh read the cursor is gone anyway; after a failed load-more the
            rows are still on screen and this button is the retry. */}
        {nextCursor && !loading && events.length > 0 && (
          <div className="audit-pagination">
            <button
              type="button"
              className="audit-btn"
              onClick={() => load(applied, nextCursor)}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading…' : error ? 'Try again' : 'Load older events'}
            </button>
          </div>
        )}
      </section>

      {selected && (
        <div className="audit-ledger-scrim" onClick={closeDetail} data-testid="audit-scrim">
          <div
            className="audit-ledger-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="audit-detail-heading"
            tabIndex={-1}
            ref={drawerRef}
            onClick={stop => stop.stopPropagation()}
            onKeyDown={key => { if (key.key === 'Escape') { key.stopPropagation(); closeDetail(); } }}
          >
            <div className="audit-ledger-drawer-head">
              <h2 id="audit-detail-heading">{selected.action}</h2>
              <button type="button" className="audit-btn" onClick={closeDetail} aria-label="Close event details">
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <dl className="audit-ledger-detail">
              <dt>When</dt>
              <dd>
                <time dateTime={selected.occurredAt}>
                  {formatDateTimeLong(selected.occurredAt, selected.occurredAt)}
                </time>
              </dd>
              <dt>Outcome</dt>
              <dd>{selected.outcome === 'denied' ? 'Refused' : 'Succeeded'}</dd>
              <dt>Actor</dt>
              <dd>{actorLabel(selected)}</dd>
              <dt>Authenticated as</dt>
              <dd>{selected.authMethod}</dd>
              <dt>Credential</dt>
              <dd>{selected.credentialId ?? 'Not a credentialled act'}</dd>
              <dt>Target</dt>
              <dd>{selected.resourceType}{selected.resourceId ? ` · ${selected.resourceId}` : ''}</dd>
              <dt>Event id</dt>
              <dd>{selected.id}</dd>
            </dl>
            <h3 className="audit-ledger-metadata-heading">Recorded detail</h3>
            <pre className="audit-ledger-metadata">{JSON.stringify(selected.metadata ?? {}, null, 2)}</pre>
          </div>
        </div>
      )}
    </div>
  );
};
