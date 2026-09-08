/**
 * §6.5.2 QUARANTINE for RH-TW1a candidate C (card `beac9c79`).
 *
 * Design `7d5c0cdc` §6.5.2, verbatim:
 *
 *   "Quarantined payloads are Tier-0-stripped before persistence (or, where
 *    stripping would destroy diagnostic value, keyset-encrypted) with a
 *    mandatory short retention and scoped access. Per-connector quarantine
 *    quota with drop-and-count past threshold and a per-connector
 *    quarantine-rate health alarm — one connector can neither exhaust nor
 *    blind the quarantine plane."
 *
 * THE TWO FAILURES THAT SENTENCE NAMES, and how each is answered here:
 *
 *   EXHAUST — one connector fills the plane. Answered by a per-connector quota
 *     per window, decided by the same conditional-upsert shape the receiver
 *     limit uses (migration 112): the budget and the quarantine write are ONE
 *     statement, so a refused budget writes nothing at all.
 *
 *   BLIND — one connector's noise drowns everyone else's evidence. Answered by
 *     drop-and-count: past the quota the row is refused and `dropped_total`
 *     rises. That counter is LIFETIME and is never reset by a window roll,
 *     because the evidence of a flood has to outlive the flood.
 *
 * TIER-0-STRIPPED IS NOT A PROMISE, IT IS AN ABSENCE. Nothing here serialises
 * the payload into a stored value. What is stored is a reason code, a SHA-256
 * of the payload (so repeats collapse without the bytes being kept), a SHA-256
 * of the source key, and a small metadata object of shapes and sizes. The
 * keyset-encrypted arm §6.5.2 allows "where stripping would destroy diagnostic
 * value" is Tier-2 machinery and is TW5 scope; at TW1a there is no keyset and
 * therefore no arm that could store content.
 *
 * SCOPED ACCESS is not a route here. TW1a ships no quarantine read surface —
 * the rows are reachable only by an operator with database access, which is
 * strictly narrower than any scope this plane could mint. When a read surface
 * arrives it takes a scope with it.
 */
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { pool as defaultPool } from '../db/connection';
import type { TelemetryPrincipalBinding } from '../types/TelemetryEnvelope';
import { telemetryQuarantineExpiry } from '../utils/telemetryRetention';

/** The window a quota is counted over. */
export const TELEMETRY_QUARANTINE_WINDOW_MS = 3_600_000;

/**
 * Quarantine WRITES a connector may make per window — a new row and a repeat
 * that bumps an occurrence count are both writes, because both are load on the
 * plane and the quota exists to bound load.
 */
export const TELEMETRY_QUARANTINE_QUOTA_PER_WINDOW = 50;

/**
 * The health alarm. A connector whose traffic is more than a quarter
 * quarantine is either broken or hostile, and either way an operator should
 * hear about it — but only once there is enough traffic for the ratio to mean
 * something, or one malformed event on a quiet connector would alarm at 100%.
 */
export const TELEMETRY_QUARANTINE_ALARM_RATE = 0.25;
export const TELEMETRY_QUARANTINE_ALARM_FLOOR = 5;

/**
 * The `source` and `source_instance` of every envelope-plane quarantine row.
 *
 * They are CONSTANTS, and that is the point. The obvious implementation takes
 * them from the submitted body's `source.adapter` and `source.instance_ref` —
 * but a quarantined body is by definition one the validator REFUSED, so those
 * strings are unvalidated reporter input, and writing them into a TEXT column
 * would be a Tier-0 leak through the very table that exists to prevent one. A
 * reporter cannot choose these because no caller can supply them.
 */
export const TELEMETRY_QUARANTINE_SOURCE = 'telemetry_envelope';
export const TELEMETRY_QUARANTINE_INSTANCE = 'unattributed';

/** Refusal codes are SHOUTED constants; anything else is not a code. */
const REASON_CODE_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
/** A field path is a schema label: dots, brackets, digits, identifier chars. */
const FIELD_PATH_RE = /^[A-Za-z0-9_.[\]]{1,120}$/;

export class TelemetryQuarantineInputError extends Error {}

export interface TelemetryQuarantineInput {
  /** Why it was refused. The validator's own code, never a message. */
  reasonCode: string;
  /** The dedupe key for this submission — hashed before storage. */
  sourceKey: string;
  /** Hashed for dedupe. NEVER stored, NEVER logged, NEVER returned. */
  payload: unknown;
  /** The field the refusal named, if it named one. */
  field?: string | null;
}

export type TelemetryQuarantineOutcome =
  | { stored: true; quarantineId: string; occurrences: number }
  | { stored: false; code: 'QUARANTINE_QUOTA_EXHAUSTED'; droppedTotal: number };

/**
 * How long after a connector's last quarantine it stays under evaluation.
 * A connector that has gone quiet is still evaluated once more, so an alarm
 * that should CLEAR does.
 */
export const TELEMETRY_QUARANTINE_ALARM_LOOKBACK_MS = 86_400_000;

/** How many NEW connectors one evaluation pass will discover. */
export const TELEMETRY_QUARANTINE_ALARM_MAX_CONNECTORS = 200;

/**
 * The most connectors this process will TRACK as alarming at once.
 *
 * Review `7b0ea9dd` F7. Making current alarms unpageable (F5) fixed the truth
 * and broke the bound: every pass could admit up to the discovery limit, nothing
 * evicted, and the whole set was copied into a `uuid[]` and re-assessed with a
 * correlated count every five minutes. The comment claiming otherwise was
 * simply wrong.
 *
 * A cap restores the bound, and the shape of the cap is the point: a tracked
 * alarm is NEVER evicted to make room — forgetting a current alarm is the
 * defect F5 existed to fix — so saturation falls on the NEW alarm, and it is
 * announced rather than swallowed. One pass therefore reads at most
 * `TELEMETRY_QUARANTINE_ALARM_MAX_TRACKED + TELEMETRY_QUARANTINE_ALARM_MAX_CONNECTORS`
 * rows, and the parameter array is bounded by the first of those.
 */
export const TELEMETRY_QUARANTINE_ALARM_MAX_TRACKED = 500;

/**
 * How long a continuing flood stays silent between signals.
 *
 * The alarm signals on TRANSITIONS, or an hourly pass would repeat the same
 * line forever and an operator would filter it out — which is how an alarm
 * stops being one. A still-flooding connector is re-signalled at this interval
 * so that a flood lasting days does not go silent after its first minute.
 */
export const TELEMETRY_QUARANTINE_ALARM_RENOTIFY_MS = 21_600_000;

export interface TelemetryQuarantineHealth {
  connectorId: string;
  quarantined: number;
  dropped: number;
  accepted: number;
  /**
   * (quarantined + dropped) / (quarantined + dropped + accepted); 0 when the
   * connector is silent. Drops count: past the quota they are the only signal
   * a flood is still happening.
   */
  rate: number;
  alarm: boolean;
  lastQuarantinedAt: Date | null;
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** One row of the health query, as the database returns it. */
interface QuarantineBudgetRow {
  connector_id?: string;
  quarantined_total?: string;
  dropped_total?: string;
  last_quarantined_at?: Date | null;
  accepted?: string;
}

/**
 * The rate and the alarm, computed in ONE place.
 *
 * `health()` and `evaluateAlarms()` both answer the same question, and two
 * copies of this arithmetic would eventually answer it differently — the
 * operator's dashboard saying one thing while the alarm said another.
 */
function assess(connectorId: string, row: QuarantineBudgetRow | undefined): TelemetryQuarantineHealth {
  const quarantined = Number(row?.quarantined_total ?? 0);
  const dropped = Number(row?.dropped_total ?? 0);
  const accepted = Number(row?.accepted ?? 0);

  // The quarantine term includes the DROPPED attempts, not only the stored
  // ones. Counting stored-only would understate the rate exactly when a
  // connector is flooding — past its quota the stored count stops rising while
  // the drops climb, so the alarm would go quiet at the moment it is most
  // needed.
  const quarantineEvents = quarantined + dropped;
  const total = quarantineEvents + accepted;
  const rate = total === 0 ? 0 : quarantineEvents / total;
  return {
    connectorId,
    quarantined,
    dropped,
    accepted,
    rate,
    alarm: quarantineEvents >= TELEMETRY_QUARANTINE_ALARM_FLOOR
      && rate >= TELEMETRY_QUARANTINE_ALARM_RATE,
    lastQuarantinedAt: row?.last_quarantined_at ?? null,
  };
}

/**
 * What an evaluation pass has to say. `continuing` is the re-notification of a
 * flood that has not stopped; the silent case emits nothing at all.
 */
export type TelemetryQuarantineAlarmSignal =
  | { state: 'raised' | 'continuing' | 'cleared'; health: TelemetryQuarantineHealth }
  /**
   * The tracking set is FULL and at least one newly-alarming connector could
   * not be taken on. This is the visible half of the cap: an operator learns
   * that the alarm plane itself is saturated, which is a different and worse
   * condition than any one connector flooding.
   */
  | { state: 'saturated'; tracked: number; cap: number; untracked: number };

/** The health query, shared by the single-connector and the sweep forms. */
const HEALTH_SELECT = `
  SELECT b.connector_id, b.quarantined_total, b.dropped_total, b.last_quarantined_at,
         (SELECT COUNT(*) FROM session_events e
           WHERE e.connector_id = b.connector_id AND e.schema_version IS NOT NULL) AS accepted
    FROM telemetry_quarantine_budget b`;

/**
 * The sweep's target set: every connector CURRENTLY ALARMING, unconditionally,
 * plus a bounded page of recently-quarantining ones.
 *
 * Review `2b893224` F5. The first version put the alarming ids in the predicate
 * and then applied ONE global `ORDER BY last_quarantined_at DESC … LIMIT` over
 * the union, so with more recent rows than the limit a quiet alarming connector
 * was displaced off the page — and the cleanup loop, which deletes every
 * alarming key it did not see, read "outside this page" as "row is gone". The
 * alarm was silently forgotten: it could never emit `cleared`, and a later
 * reappearance emitted a false `raised`.
 *
 * The LIMIT now applies to DISCOVERY ONLY. An alarming connector is a target
 * whatever its recency, so the only way one can be missing from the result is
 * that its budget row no longer exists — which is exactly what the cleanup loop
 * assumes, and now the only thing it can mean.
 *
 * The alarming set is bounded by `TELEMETRY_QUARANTINE_ALARM_MAX_TRACKED`,
 * and saturation is ANNOUNCED rather than absorbed (review `7b0ea9dd` F7 —
 * an earlier comment here claimed a bound that did not exist).
 */
const ALARM_SWEEP_SQL = `
  WITH discovery AS (
    SELECT d.connector_id
      FROM telemetry_quarantine_budget d
     WHERE d.last_quarantined_at >= $1
       AND NOT (d.connector_id = ANY($2::uuid[]))
     ORDER BY d.last_quarantined_at DESC
     LIMIT $3
  ), targets AS (
    SELECT connector_id FROM discovery
     UNION
    SELECT unnest($2::uuid[]) AS connector_id
  )
  ${HEALTH_SELECT}
    JOIN targets t ON t.connector_id = b.connector_id`;

/**
 * The budget half of the quarantine statement, parameters $1-$4.
 *
 * The WHERE decides the attempt: the window has rolled, or the connector is
 * still under quota. When it is false the upsert updates nothing, RETURNS
 * nothing, and the quarantine insert that selects from it therefore writes
 * nothing — one statement, one decision, no window in which a caller could
 * store past its quota.
 */
export const TELEMETRY_QUARANTINE_BUDGET_CTE = `
  budget AS (
    INSERT INTO telemetry_quarantine_budget
      (connector_id, window_started_at, stored_count, quarantined_total, last_quarantined_at)
         VALUES ($1, $2, 1, 1, $2)
    ON CONFLICT (connector_id) DO UPDATE
           SET window_started_at = CASE
                 WHEN telemetry_quarantine_budget.window_started_at
                      <= $2::timestamptz - ($3 || ' milliseconds')::interval
                 THEN $2 ELSE telemetry_quarantine_budget.window_started_at END,
               stored_count = CASE
                 WHEN telemetry_quarantine_budget.window_started_at
                      <= $2::timestamptz - ($3 || ' milliseconds')::interval
                 THEN 1 ELSE telemetry_quarantine_budget.stored_count + 1 END,
               quarantined_total = telemetry_quarantine_budget.quarantined_total + 1,
               last_quarantined_at = $2
         WHERE telemetry_quarantine_budget.window_started_at
               <= $2::timestamptz - ($3 || ' milliseconds')::interval
            OR telemetry_quarantine_budget.stored_count < $4
     RETURNING 1 AS won
  )`;

export class TelemetryQuarantineService {
  /**
   * Connectors currently alarming, and when each was last signalled. Kept in
   * memory and therefore per-process: a restart re-raises a continuing flood
   * once, which is the right way round for an alarm to be wrong.
   *
   * Bounded by `maxTracked`. Nothing is ever evicted from it to make room —
   * see the constant's own note.
   */
  private readonly alarming = new Map<string, number>();

  constructor(
    private readonly pool: Pool = defaultPool,
    private readonly quota: number = TELEMETRY_QUARANTINE_QUOTA_PER_WINDOW,
    private readonly windowMs: number = TELEMETRY_QUARANTINE_WINDOW_MS,
    private readonly maxTracked: number = TELEMETRY_QUARANTINE_ALARM_MAX_TRACKED,
  ) {}

  /**
   * Record a refused submission, or drop and count it.
   *
   * The payload reaches this method and leaves as a hash. Nothing between here
   * and the database binds it: the only values in the statement are codes,
   * hashes, shapes and timestamps.
   */
  async record(
    binding: Pick<TelemetryPrincipalBinding, 'connectorId' | 'policyTier'>,
    input: TelemetryQuarantineInput,
    now: Date = new Date(),
  ): Promise<TelemetryQuarantineOutcome> {
    // Shape-gate the two strings that reach a TEXT column. The validator
    // supplies both, so in production they always pass — which is exactly why
    // the gate belongs here rather than in a comment: a future caller that
    // forwards a message instead of a code is refused, not stored.
    if (!REASON_CODE_RE.test(input.reasonCode)) {
      throw new TelemetryQuarantineInputError(
        'a quarantine reason must be a refusal CODE (upper snake case, 3-64 characters), not free text. '
        + 'The offending value is deliberately NOT quoted here: it is the very string this refusal exists '
        + 'to keep out of storage, and a message that repeated it would put it in the log instead.');
    }
    if (input.field !== undefined && input.field !== null && !FIELD_PATH_RE.test(input.field)) {
      throw new TelemetryQuarantineInputError(
        'a quarantine field must be a schema path (identifier characters, dots and brackets, '
        + 'at most 120 of them), not free text. The value is not quoted here, for the same reason.');
    }

    const serialized = JSON.stringify(input.payload ?? null);
    const safeMetadata = {
      // Shapes and sizes only. A field NAME is a schema label, not content;
      // a field VALUE never appears here.
      field: input.field ?? null,
      payload_bytes: Buffer.byteLength(serialized, 'utf8'),
      payload_shape: Array.isArray(input.payload) ? 'array'
        : input.payload === null || input.payload === undefined ? 'null'
          : typeof input.payload,
      policy_tier: binding.policyTier,
    };

    const won = await this.pool.query(
      `WITH ${TELEMETRY_QUARANTINE_BUDGET_CTE}
       INSERT INTO session_quarantine
         (attempt_id, source, source_instance, reason_code, source_key_hash, payload_hash,
          safe_metadata, first_observed_at, last_observed_at, occurrence_count,
          connector_id, policy_tier, expires_at)
       SELECT NULL::uuid, $5, $6, $7, $8, $9, $10::jsonb, $2, $2, 1, $1, $11, $12
         FROM budget
       ON CONFLICT (source, source_instance, reason_code, source_key_hash, payload_hash)
       DO UPDATE SET occurrence_count = session_quarantine.occurrence_count + 1,
                     last_observed_at = EXCLUDED.last_observed_at,
                     expires_at = GREATEST(session_quarantine.expires_at, EXCLUDED.expires_at)
       RETURNING quarantine_id, occurrence_count`,
      [
        binding.connectorId,
        now,
        String(this.windowMs),
        this.quota,
        TELEMETRY_QUARANTINE_SOURCE,
        TELEMETRY_QUARANTINE_INSTANCE,
        input.reasonCode,
        sha256(input.sourceKey),
        sha256(serialized),
        JSON.stringify(safeMetadata),
        binding.policyTier,
        telemetryQuarantineExpiry(now),
      ],
    );

    if ((won.rowCount ?? 0) > 0) {
      const row = won.rows[0] as { quarantine_id: string; occurrence_count: number };
      return { stored: true, quarantineId: row.quarantine_id, occurrences: Number(row.occurrence_count) };
    }

    // DROP AND COUNT. Past the quota nothing is stored, but the fact that
    // something was refused survives — and survives the window roll, so an
    // operator can still see the flood after it has stopped.
    const dropped = await this.pool.query(
      `UPDATE telemetry_quarantine_budget
          SET dropped_total = dropped_total + 1, last_dropped_at = $2
        WHERE connector_id = $1
      RETURNING dropped_total`,
      [binding.connectorId, now],
    );
    return {
      stored: false,
      code: 'QUARANTINE_QUOTA_EXHAUSTED',
      droppedTotal: Number((dropped.rows[0] as { dropped_total?: string } | undefined)?.dropped_total ?? 0),
    };
  }

  /**
   * The per-connector quarantine-rate health alarm.
   *
   * The accepted term is COUNTED from the events themselves rather than kept
   * as a running total on the budget row. A maintained counter would have to
   * be incremented on the accept path — a write on the hot path that a
   * duplicate or an aborted insert could desynchronise — and a rate computed
   * from a drifting denominator is worse than no alarm at all.
   */
  async health(connectorId: string): Promise<TelemetryQuarantineHealth> {
    const row = (await this.pool.query(
      `${HEALTH_SELECT} WHERE b.connector_id = $1`, [connectorId],
    )).rows[0] as QuarantineBudgetRow | undefined;
    return assess(connectorId, row);
  }

  /**
   * Evaluate every connector that has quarantined anything recently — plus
   * every connector currently alarming, so an alarm that should CLEAR does —
   * and return only the signals worth emitting.
   *
   * Review `d9697a35` F2: before this, the alarm was an unreachable
   * calculator. `health()` computed a correct rate that nothing in production
   * ever called, so a flooding connector raised no signal an operator could
   * hear. The counters were already durable; what was missing was somebody
   * asking them.
   *
   * WHAT THIS IS AND IS NOT. It is a bounded operational signal on
   * transitions, emitted by the caller (the server schedules it and logs each
   * signal). It is NOT a governed health SURFACE — no route, no scope — and
   * the transition state is per-process and in memory, so a restart re-raises
   * a continuing flood once. Both are deliberate at TW1a: a read surface takes
   * a scope with it, and adding one here would mint the first telemetry read
   * scope as a side effect of an alarm.
   */
  async evaluateAlarms(
    now: Date = new Date(),
    limit: number = TELEMETRY_QUARANTINE_ALARM_MAX_CONNECTORS,
  ): Promise<TelemetryQuarantineAlarmSignal[]> {
    const since = new Date(now.getTime() - TELEMETRY_QUARANTINE_ALARM_LOOKBACK_MS);
    const rows = (await this.pool.query(
      ALARM_SWEEP_SQL, [since, [...this.alarming.keys()], limit],
    )).rows as QuarantineBudgetRow[];

    const signals: TelemetryQuarantineAlarmSignal[] = [];
    const seen = new Set<string>();
    let untracked = 0;

    for (const row of rows) {
      const connectorId = String(row.connector_id);
      seen.add(connectorId);
      const health = assess(connectorId, row);
      const signalledAt = this.alarming.get(connectorId);

      if (health.alarm) {
        if (signalledAt === undefined) {
          // The cap falls on the NEW alarm, never on a tracked one: evicting a
          // current alarm to make room would be F5 all over again, and this
          // time on purpose.
          if (this.alarming.size >= this.maxTracked) {
            untracked += 1;
            continue;
          }
          this.alarming.set(connectorId, now.getTime());
          signals.push({ state: 'raised', health });
        } else if (now.getTime() - signalledAt >= TELEMETRY_QUARANTINE_ALARM_RENOTIFY_MS) {
          this.alarming.set(connectorId, now.getTime());
          signals.push({ state: 'continuing', health });
        }
        continue;
      }
      if (signalledAt !== undefined) {
        this.alarming.delete(connectorId);
        signals.push({ state: 'cleared', health });
      }
    }

    // A connector whose budget row has been DELETED cannot be assessed again,
    // so its alarm is cleared silently rather than left latched forever.
    //
    // This is sound only because the query above makes every alarming id a
    // TARGET rather than a candidate for paging: absence from the result can no
    // longer mean "displaced by more recent rows" (review `2b893224` F5), it can
    // only mean the row is gone.
    for (const connectorId of [...this.alarming.keys()]) {
      if (!seen.has(connectorId)) this.alarming.delete(connectorId);
    }

    // ONE saturation signal per pass, carrying the count rather than a line per
    // connector: the condition is a property of the plane, not of any one of
    // them, and a line each would be the noise this alarm avoids elsewhere.
    if (untracked > 0) {
      signals.push({
        state: 'saturated', tracked: this.alarming.size, cap: this.maxTracked, untracked,
      });
    }
    return signals;
  }
}

export const telemetryQuarantineService = new TelemetryQuarantineService();
