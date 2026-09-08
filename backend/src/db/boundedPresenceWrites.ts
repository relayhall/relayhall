/**
 * BOUNDED LIVENESS BOOKKEEPING WRITES — card 8491557e.
 *
 * ── THE DEFECT THIS EXISTS FOR ──
 *
 * `LoginSessionService.touch` issued an UNAWAITED
 * `UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1` on EVERY
 * authenticated request carrying a login-session cookie. Every request from
 * one session writes the SAME ROW; concurrent UPDATEs of one row serialise on
 * a tuple lock; and each waiting statement holds a pooled connection for as
 * long as it waits. The pool is `max: 20` with `connectionTimeoutMillis: 2000`
 * (`db/connection.ts`), so a burst from a SINGLE session fills the pool with
 * bookkeeping writes that OUTLIVE the requests that issued them, and the next
 * genuine query cannot obtain a connection inside 2s.
 *
 * Measured on a real PostgreSQL, `pg_stat_activity` showed twenty backends on
 * that one statement, nineteen of them waiting on `Lock: tuple`, while
 * unrelated requests answered 503 AUTHORIZATION_UNAVAILABLE and 500
 * DASHBOARD_SUMMARY_READ_FAILED — a pool timeout wearing the mask of an
 * authorization fault, which is the reading an operator would act on.
 *
 * ── WHY A SHARED WRITER, AND NOT A SECOND THROTTLE ──
 *
 * `PrincipalService.bumpLastSeen` already carried a per-principal throttle, so
 * throttling `touch` would have been the same idea written a second time — and
 * a throttle alone bounds FREQUENCY PER KEY, never CONCURRENCY. Distinct keys
 * still admit the convoy: a hundred live sessions each past their window put a
 * hundred unawaited writes into a twenty-connection pool, and the pool is what
 * ran out. So the bound belongs on the resource, in one place, for every
 * caller in this shape — the card's own second question, and the reason this
 * is a module rather than a line.
 *
 * Three bounds, each closing a different route to the pool:
 *
 *   1. COALESCE per key — at most one write per key per window. Every column
 *      written through here is read at minute granularity (the idle-window
 *      check in `LoginSessionService.resolve`; `last_seen_at`/`last_used_at`
 *      telemetry), so a skip inside the window changes no behaviour that
 *      depends on it. A skip never moves a timestamp backwards, so the column
 *      remains MONOTONIC — the property the idle check actually needs.
 *   2. SINGLE-FLIGHT per key — never two in-flight writes to the same row.
 *      Two writers of one row is the smallest instance of the tuple-lock
 *      convoy; this bound forbids the instance, not merely its large cases.
 *   3. BOUND THE TOTAL IN FLIGHT — at most `maxInFlight` of the pool's
 *      connections may ever be held by bookkeeping. Beyond that a write is
 *      SHED, not queued: a queued bookkeeping write outliving its request is
 *      PRECISELY the defect, and shedding costs nothing because the caller
 *      retries on its very next request.
 *
 * Shedding deliberately does NOT stamp the throttle. A shed write never
 * happened, so recording it as done would let a session's `last_seen_at` go
 * stale for a whole window on nothing but load — the one way a bound on a
 * liveness write could become a liveness BUG.
 *
 * Nothing here throws, and nothing here is ever awaited by a request.
 */

/** What a writer did with the submissions it was handed. */
export interface PresenceWriteCounters {
  /** Every `submit` call. */
  submitted: number;
  /** Submissions that actually reached the database. */
  started: number;
  /** Suppressed inside the coalescing window. */
  coalesced: number;
  /** Suppressed because a write for that key was still in flight. */
  singleFlighted: number;
  /** Refused because the concurrency bound was full. */
  shed: number;
  /** Started, then rejected. */
  failed: number;
  /** In flight right now. */
  inFlight: number;
  /** The most ever in flight at once — the number the pool cares about. */
  peakInFlight: number;
}

export interface BoundedPresenceWriterOptions {
  /** Default coalescing window; a caller may pass a tighter one per submit. */
  throttleMs: number;
  /** Ceiling on pooled connections this writer may hold at once. */
  maxInFlight: number;
  /**
   * Cap on remembered keys. Forgetting a key is ALWAYS SAFE: it can permit one
   * extra write, never suppress a needed one, so the bound on memory can never
   * become a bound on correctness.
   */
  maxTrackedKeys?: number;
  /** Where a rejected write is reported. Never rethrown. */
  onError?: (err: unknown, key: string) => void;
}

const DEFAULT_MAX_TRACKED_KEYS = 10_000;

export class BoundedPresenceWriter {
  private readonly lastStartedAt = new Map<string, number>();
  private readonly inFlightKeys = new Set<string>();
  private inFlightCount = 0;
  private peak = 0;
  private submittedCount = 0;
  private startedCount = 0;
  private coalescedCount = 0;
  private singleFlightedCount = 0;
  private shedCount = 0;
  private failedCount = 0;

  constructor(private readonly options: BoundedPresenceWriterOptions) {}

  /**
   * Offer one bookkeeping write. Returns whether it was STARTED, so a caller
   * (and a test) can tell a real write from a suppressed one without reading
   * the database. Never throws.
   */
  submit(key: string, run: () => Promise<unknown>, throttleMs?: number): boolean {
    this.submittedCount += 1;
    const window = throttleMs ?? this.options.throttleMs;
    const now = Date.now();

    if (now - (this.lastStartedAt.get(key) ?? 0) < window) {
      this.coalescedCount += 1;
      return false;
    }
    if (this.inFlightKeys.has(key)) {
      this.singleFlightedCount += 1;
      return false;
    }
    if (this.inFlightCount >= this.options.maxInFlight) {
      // Shed WITHOUT stamping the throttle: the next request retries.
      this.shedCount += 1;
      return false;
    }

    this.rememberKey(key, now);
    this.inFlightKeys.add(key);
    this.inFlightCount += 1;
    if (this.inFlightCount > this.peak) this.peak = this.inFlightCount;
    this.startedCount += 1;

    // `run` is invoked INSIDE the promise chain so a synchronous throw while
    // the caller builds its query is caught here too, never escaping as an
    // unhandled rejection.
    void Promise.resolve()
      .then(run)
      .catch((err) => {
        this.failedCount += 1;
        try {
          this.options.onError?.(err, key);
        } catch {
          /* a reporter that throws must not become the failure it reports */
        }
      })
      .then(() => {
        this.inFlightCount -= 1;
        this.inFlightKeys.delete(key);
      });

    return true;
  }

  /**
   * Remember that `key` was written at `now`, keeping the map bounded.
   *
   * The sweep drops only keys whose window has already elapsed — those are
   * suppressing nothing, so dropping them is free. If that is not enough the
   * map is cleared outright, which (per the safety note on `maxTrackedKeys`)
   * can only allow extra writes, and those are themselves bounded by
   * `maxInFlight`.
   */
  private rememberKey(key: string, now: number): void {
    const cap = this.options.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS;
    if (this.lastStartedAt.size >= cap) {
      const staleBefore = now - this.options.throttleMs;
      for (const [existing, at] of this.lastStartedAt) {
        if (at <= staleBefore) this.lastStartedAt.delete(existing);
      }
      if (this.lastStartedAt.size >= cap) this.lastStartedAt.clear();
    }
    this.lastStartedAt.set(key, now);
  }

  counters(): PresenceWriteCounters {
    return {
      submitted: this.submittedCount,
      started: this.startedCount,
      coalesced: this.coalescedCount,
      singleFlighted: this.singleFlightedCount,
      shed: this.shedCount,
      failed: this.failedCount,
      inFlight: this.inFlightCount,
      peakInFlight: this.peak,
    };
  }

  /** Forget every throttle and counter. In-flight writes are left to finish. */
  reset(): void {
    this.lastStartedAt.clear();
    this.submittedCount = 0;
    this.startedCount = 0;
    this.coalescedCount = 0;
    this.singleFlightedCount = 0;
    this.shedCount = 0;
    this.failedCount = 0;
    this.peak = this.inFlightCount;
  }
}

/**
 * The default window for every liveness column in the tree (the budget
 * `PrincipalService` already used for credential telemetry).
 */
export const PRESENCE_THROTTLE_MS = 60_000;

/**
 * At most four of the pool's twenty connections may be held by bookkeeping.
 *
 * The number is deliberately far below `max: 20`: bookkeeping exists to be
 * invisible, and the property this bound buys — that a burst can never spend
 * the pool on liveness — is worth more than the freshness of a column read at
 * minute granularity.
 */
export const PRESENCE_MAX_IN_FLIGHT = 4;

/** The one writer every liveness bookkeeping caller in the process shares. */
export const presenceWriter = new BoundedPresenceWriter({
  throttleMs: PRESENCE_THROTTLE_MS,
  maxInFlight: PRESENCE_MAX_IN_FLIGHT,
});
