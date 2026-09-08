/**
 * TelemetryRateLimitService — the DEPLOYMENT-WIDE receiver limit (owner
 * decision D6; hardening card `329dba46`, whose DoD design `7d5c0cdc`
 * Appendix C imports into TW1a verbatim).
 *
 * WHAT WAS WRONG. `TelemetryService` gated frames on
 * `private lastAcceptedAt = new Map<string, number>()`: per-process, so two
 * workers each accept a frame in the same interval, and never evicted, so it
 * grows for the life of the process. There is no Redis anywhere in this tree,
 * and `middleware/apiRateLimit.ts` declares the backend single-process — so
 * "deployment-wide" can only mean database-backed. That map is REMOVED by this
 * candidate, not bounded: a bounded per-process map is still per-process.
 *
 * THE ATOMICITY IS IN THE STATEMENT. `tryAccept` is ONE
 * `INSERT ... ON CONFLICT DO UPDATE` whose `WHERE` carries the interval test
 * and which `RETURNING`s a row only when it actually won. A read-then-write
 * pair cannot do this even inside a transaction: under READ COMMITTED two
 * clients both read "last accepted long ago" and both write. The conditional
 * upsert makes the database pick a winner in one round trip — which is exactly
 * what the two-client race test drives against a real PostgreSQL.
 *
 * A REFUSAL IS COUNTED, NOT SILENT — by a SEPARATE statement after the gate
 * has ended, not by the gate itself (review `fc4829d2` F4.3 corrected this
 * comment, which claimed the conditional upsert did the counting; it does not,
 * because its `WHERE` is false exactly when a refusal happens). Counting it
 * afterwards is also what keeps it off any caller lock path, and means an
 * operator can see a misconfigured reporter hammering the endpoint instead of
 * inferring it from absence.
 *
 * WHY THE FRAME RETROFIT IS NOT A C7 VIOLATION. Design Appendix C, verbatim:
 *
 *   > Hardening `329dba46` (frame throttling deployment-wide) — Its DoD text is
 *   > imported into TW1a's DoD verbatim; the card closes on TW1a acceptance
 *   > (single consistent mechanic, stated identically in §3.1 and here).
 *
 * §2.1 item 5's "C7 shipped code is not retrofitted" governs the FRAME
 * CONTRACT — `heartbeat|status`, pushed `active|idle`, derived `stale`, zero
 * server-side effect, short retention — every part of which is unchanged. The
 * throttling mechanism is the named exception, and a single consistent mechanic
 * across both surfaces is what the ratified text asks for.
 */
import type { Pool } from 'pg';
import { pool as defaultPool } from '../db/connection';

/** The ingest surfaces budgeted separately. */
export type TelemetryRateSurface = 'frames' | 'events' | 'events_batch';

/**
 * Minimum interval between ACCEPTED writes, per principal, per surface.
 *
 * Frames keep the ratified C7 value exactly — the contract is unchanged, only
 * where the counter lives. Envelope events are allowed a faster cadence because
 * a rich event stream is not a heartbeat; a batch upload is slower still
 * because one request carries many records.
 */
export const TELEMETRY_MIN_INTERVAL_MS: Readonly<Record<TelemetryRateSurface, number>> = {
  frames: 5_000,
  events: 1_000,
  events_batch: 10_000,
};

/** Limiter rows untouched for this long are pruned; the state stays bounded. */
export const TELEMETRY_RATE_LIMIT_RETENTION_HOURS = 24;

export interface TelemetryRateDecision {
  accepted: boolean;
  /** Milliseconds until the next write would be accepted; 0 when accepted. */
  retryAfterMs: number;
}

/**
 * THE GATE, AS A DATA-MODIFYING CTE — the shape that terminates the regress
 * (dispatcher ruling `623632b0`, option (a)).
 *
 * A caller that must write something ATOMICALLY WITH the gate composes this
 * fragment into its own single statement rather than wrapping both in a
 * transaction. That distinction is the whole point, and it was learned the
 * hard way across three rejected attempts:
 *
 *   1. a per-process `Map` set after a successful write — not deployment-wide
 *      (hardening `329dba46`);
 *   2. the upsert on the pool BEFORE the write — a write that then failed had
 *      already charged the interval (review `29874574` F4);
 *   3. the upsert inside the caller transaction — `ON CONFLICT DO UPDATE`
 *      locks the conflicting row even when its `WHERE` is false, so awaiting
 *      the refusal counter on a second connection deadlocked against the
 *      caller own open transaction (review `fc4829d2` R3-B1, reproduced
 *      against a real PostgreSQL), and the prune held the caller locks
 *      (R3-M2).
 *
 * As ONE statement all three become unrepresentable rather than fixed:
 *
 *   - a refusing gate returns no rows, so the outer `INSERT ... SELECT ... FROM
 *     gate` writes nothing — no second connection is involved and **no lock
 *     outlives the statement**, so there is no cycle to deadlock;
 *   - a failing outer write aborts the whole statement, so the gate own
 *     update is discarded and **the interval is never charged**;
 *   - there is no caller transaction for a prune to sit inside.
 *
 * A data-modifying CTE executes exactly once whether or not the outer query
 * reads its rows, so the gate is always attempted — which is what makes the
 * refusal case correct rather than merely quiet.
 *
 * Placeholders `$1..$4` are (principalId, surface, nowIso, intervalMs); a
 * caller own parameters therefore start at `$5`. Use `gateParams()` so the
 * order is never restated by hand.
 */
export const TELEMETRY_GATE_CTE = `
  gate AS (
    INSERT INTO telemetry_rate_limits (principal_id, surface, last_accepted_at, accepted_count)
         VALUES ($1, $2, $3, 1)
    ON CONFLICT (principal_id, surface) DO UPDATE
           SET last_accepted_at = EXCLUDED.last_accepted_at,
               accepted_count   = telemetry_rate_limits.accepted_count + 1
         WHERE telemetry_rate_limits.last_accepted_at <= $3::timestamptz - ($4 || ' milliseconds')::interval
     RETURNING 1 AS won
  )`;

/** The `$1..$4` the CTE expects, in order. */
export function gateParams(
  principalId: string, surface: TelemetryRateSurface, now: Date,
): [string, string, string, string] {
  return [principalId, surface, now.toISOString(), String(TELEMETRY_MIN_INTERVAL_MS[surface])];
}

export class TelemetryRateLimitService {
  private lastPruneAt = 0;

  constructor(private readonly pool: Pool = defaultPool) {}

  /**
   * Decide ONE attempt, atomically, across every worker.
   *
   * Returns `accepted: true` only for the client whose statement actually won
   * the row. Everything else — including a simultaneous attempt by another
   * process — is refused and counted.
   */
  /**
   * Decide ONE attempt on its own, for callers with nothing to write
   * atomically alongside it (the envelope endpoint). One statement, one
   * connection, no transaction — the same properties the CTE gives a
   * composing caller.
   */
  async tryAccept(
    principalId: string,
    surface: TelemetryRateSurface,
    now: Date = new Date(),
  ): Promise<TelemetryRateDecision> {
    const result = await this.pool.query(
      `WITH ${TELEMETRY_GATE_CTE} SELECT won FROM gate`,
      gateParams(principalId, surface, now),
    );
    if ((result.rowCount ?? 0) > 0) {
      await this.prune(now);
      return { accepted: true, retryAfterMs: 0 };
    }
    return { accepted: false, retryAfterMs: await this.countRefusal(principalId, surface, now) };
  }

  /**
   * Count a refusal and report how long the caller should wait.
   *
   * Called AFTER the gate statement has ended, never during it — the statement
   * holds no lock once it returns, so this can never wait on the caller. A
   * refusal is a real event and stays counted; it is deliberately not part of
   * any caller atomic unit.
   */
  async countRefusal(
    principalId: string, surface: TelemetryRateSurface, now: Date = new Date(),
  ): Promise<number> {
    const refused = await this.pool.query(
      `UPDATE telemetry_rate_limits
          SET refused_count = refused_count + 1
        WHERE principal_id = $1 AND surface = $2
      RETURNING last_accepted_at`,
      [principalId, surface],
    );
    const lastAcceptedAt = refused.rows[0]?.last_accepted_at
      ? new Date(refused.rows[0].last_accepted_at as string).getTime()
      : now.getTime();
    return Math.max(0, TELEMETRY_MIN_INTERVAL_MS[surface] - (now.getTime() - lastAcceptedAt));
  }

  /**
   * Bounded with defined cleanup (D6). Rows are per (principal, surface), so
   * the table is bounded by the principals that have ever reported; this drops
   * the ones that have stopped. Opportunistic and at most once a minute per
   * process.
   *
   * PUBLIC and always called AFTER the caller gate statement has ended
   * (review `fc4829d2` R3-M2: awaiting it while a caller transaction was open
   * held that caller limiter-row lock for the length of the cleanup, and on a
   * one-connection pool could not acquire a connection at all).
   */
  async prune(now: Date): Promise<void> {
    if (now.getTime() - this.lastPruneAt < 60_000) return;
    this.lastPruneAt = now.getTime();
    try {
      await this.pool.query(
        `DELETE FROM telemetry_rate_limits
           WHERE last_accepted_at < now() - ($1 * INTERVAL '1 hour')`,
        [TELEMETRY_RATE_LIMIT_RETENTION_HOURS],
      );
    } catch {
      // Cleanup is opportunistic: a failed prune must never refuse a write that
      // the gate itself accepted.
    }
  }
}

export const telemetryRateLimitService = new TelemetryRateLimitService();
