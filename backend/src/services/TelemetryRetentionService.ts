/**
 * TS-9 RETENTION for RH-TW1a candidate C (card `beac9c79`).
 *
 * The ratification sitting `7e7eeca3` ruled: identity-bound Tier 0/1 metadata
 * is retained at EVENT GRAIN for a 90-day default; aggregates beyond that carry
 * no identity finer than org/key; both bounds are deployment-configurable and
 * documented. Design §6.5.1 adds that "retention receipts cover raw blobs", and
 * §6.3 that deletion "cannot orphan or mutate Tier-0/1 history".
 *
 * EVERY SWEEP IS ONE STATEMENT PER CLASS, and each writes its own receipt in
 * that same statement. A delete followed by a separate receipt insert can leave
 * a deletion with no evidence — the exact failure a retention receipt exists to
 * make impossible. The CTE also gives the receipt something honest to say:
 * `copies_examined` counts the whole population under the policy, computed from
 * the SAME snapshot as the delete, and `copies_removed` counts what went. A
 * receipt whose two numbers are always equal proves only that a delete ran.
 *
 * THE EVIDENCE HASH IS COMPUTED BY THE DATABASE over the sorted identifiers of
 * the rows actually removed. It is reproducible from the rows themselves if
 * they are ever recovered from a backup, which is what makes it evidence rather
 * than a receipt number.
 *
 * ORDER IS LOAD-BEARING: events first, then blobs. `session_events.raw_ref` is
 * `ON DELETE SET NULL`, so a blob outlives its events by design — the metadata
 * must not be mutated by the erasure of a payload. Sweeping events first lets
 * the blob pass its own "nothing references me" test in the same run, so a
 * ninety-day-old event and its payload leave together instead of the payload
 * lingering a further ninety days.
 *
 * WHAT IS NEVER TOUCHED: migration 055's own rows. Every predicate here is
 * restricted to the envelope plane — `schema_version IS NOT NULL` for events,
 * and a non-null `expires_at` for quarantine, which migration 113's CHECK makes
 * exactly equivalent to "written by the envelope plane".
 */
import { Pool } from 'pg';
import { pool as defaultPool } from '../db/connection';
import { telemetryEventRetentionDays } from '../utils/telemetryRetention';

/** Stamped on every receipt this sweep writes. */
export const TELEMETRY_RETENTION_POLICY_VERSION = 'rh.telemetry.ts9/1';

export const TELEMETRY_RETENTION_CLASSES = [
  'telemetry_event_metadata',
  'telemetry_raw_blob',
  'telemetry_quarantine',
] as const;
export type TelemetryRetentionClass = (typeof TELEMETRY_RETENTION_CLASSES)[number];

export interface TelemetryRetentionReceipt {
  payloadClass: TelemetryRetentionClass;
  receiptId: string;
  examined: number;
  removed: number;
  evidenceHash: string;
}

export interface TelemetryRetentionOutcome {
  cutoff: Date;
  receipts: TelemetryRetentionReceipt[];
}

/**
 * `sha256` over the sorted identifiers of the removed rows, hex-encoded.
 * `coalesce` to the empty string so a sweep that removed nothing still writes
 * a receipt with a well-formed hash — "nothing expired today" is evidence too,
 * and a NULL here would violate the ledger's own CHECK.
 */
const EVIDENCE = (idColumn: string): string =>
  `encode(sha256(coalesce(string_agg(${idColumn}::text, ',' ORDER BY ${idColumn}), '')::bytea), 'hex')`;

const RECEIPT_COLUMNS = `
  (policy_version, attempt_id, payload_class, source_event_id, action,
   copies_examined, copies_removed, evidence_hash)`;

export class TelemetryRetentionService {
  constructor(private readonly pool: Pool = defaultPool) {}

  /**
   * Expire everything past its bound and write the three receipts.
   *
   * Returns one receipt per class, always — including for a class that removed
   * nothing, because an unbroken receipt series is what lets an auditor tell
   * "nothing was due" from "the sweep did not run".
   */
  async sweep(now: Date = new Date()): Promise<TelemetryRetentionOutcome> {
    const cutoff = new Date(now.getTime() - telemetryEventRetentionDays() * 86_400_000);
    const receipts: TelemetryRetentionReceipt[] = [];

    // 1 — EVENT-GRAIN METADATA (TS-9). Envelope rows only; 055's own rows have
    // no `schema_version` and are not this policy's to expire.
    receipts.push(await this.run('telemetry_event_metadata', `
      WITH examined AS (
        SELECT COUNT(*)::int AS n FROM session_events WHERE schema_version IS NOT NULL
      ), removed AS (
        DELETE FROM session_events
              WHERE schema_version IS NOT NULL AND observed_at < $1
          RETURNING event_id
      ), evidence AS (
        SELECT COUNT(*)::int AS n, ${EVIDENCE('event_id')} AS hash FROM removed
      )
      INSERT INTO session_retention_receipts ${RECEIPT_COLUMNS}
      SELECT $2, NULL, 'telemetry_event_metadata', NULL, 'expired',
             examined.n, evidence.n, evidence.hash
        FROM examined, evidence
      RETURNING receipt_id, copies_examined, copies_removed, evidence_hash`, [cutoff]));

    // 2 — THE GOVERNED RAW BLOBS (§6.5.1: "retention receipts cover raw
    // blobs"). Past its own expiry AND unreferenced: a blob a surviving event
    // still points at is not expired evidence, it is live evidence.
    receipts.push(await this.run('telemetry_raw_blob', `
      WITH examined AS (
        SELECT COUNT(*)::int AS n FROM telemetry_raw_blobs
      ), removed AS (
        DELETE FROM telemetry_raw_blobs b
              WHERE b.expires_at < $1
                AND NOT EXISTS (SELECT 1 FROM session_events e WHERE e.raw_ref = b.blob_key)
          RETURNING b.blob_key
      ), evidence AS (
        SELECT COUNT(*)::int AS n, ${EVIDENCE('blob_key')} AS hash FROM removed
      )
      INSERT INTO session_retention_receipts ${RECEIPT_COLUMNS}
      SELECT $2, NULL, 'telemetry_raw_blob', NULL, 'erased',
             examined.n, evidence.n, evidence.hash
        FROM examined, evidence
      RETURNING receipt_id, copies_examined, copies_removed, evidence_hash`, [now]));

    // 3 — QUARANTINE (§6.5.2's "mandatory short retention"). A non-null
    // `expires_at` IS the envelope-plane discriminator: migration 113's CHECK
    // admits a quarantine row without one only when it also has no owner and no
    // tier, which is exactly a pre-envelope 055 row.
    receipts.push(await this.run('telemetry_quarantine', `
      WITH examined AS (
        SELECT COUNT(*)::int AS n FROM session_quarantine WHERE expires_at IS NOT NULL
      ), removed AS (
        DELETE FROM session_quarantine
              WHERE expires_at IS NOT NULL AND expires_at < $1
          RETURNING quarantine_id
      ), evidence AS (
        SELECT COUNT(*)::int AS n, ${EVIDENCE('quarantine_id')} AS hash FROM removed
      )
      INSERT INTO session_retention_receipts ${RECEIPT_COLUMNS}
      SELECT $2, NULL, 'telemetry_quarantine', NULL, 'expired',
             examined.n, evidence.n, evidence.hash
        FROM examined, evidence
      RETURNING receipt_id, copies_examined, copies_removed, evidence_hash`, [now]));

    return { cutoff, receipts };
  }

  private async run(
    payloadClass: TelemetryRetentionClass,
    text: string,
    params: unknown[],
  ): Promise<TelemetryRetentionReceipt> {
    const row = (await this.pool.query(text, [...params, TELEMETRY_RETENTION_POLICY_VERSION]))
      .rows[0] as {
        receipt_id: string; copies_examined: number;
        copies_removed: number; evidence_hash: string;
      };
    return {
      payloadClass,
      receiptId: row.receipt_id,
      examined: Number(row.copies_examined),
      removed: Number(row.copies_removed),
      evidenceHash: row.evidence_hash,
    };
  }
}

export const telemetryRetentionService = new TelemetryRetentionService();
