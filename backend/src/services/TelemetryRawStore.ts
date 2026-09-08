/**
 * The §6.5.1 GOVERNED RAW STORE for RH-TW1a candidate C (card `beac9c79`).
 *
 * Design `7d5c0cdc` §6.5.1, verbatim:
 *
 *   "Raw vendor payloads pass the source's policy tier BEFORE
 *    content-addressing: for Tier 0/1 sources, `raw_ref` stores the *redacted*
 *    raw payload only (fidelity loss accepted and visible via redaction
 *    counts) ... Blob keys are connector-namespaced — a blob is never shared
 *    across sources/policies, so per-source deletion is well-defined;
 *    retention receipts cover raw blobs."
 *
 * WHAT "RAW" MEANS AT TW1a, SAID PLAINLY SO IT IS NOT MISTAKEN FOR A
 * CONFLATION. The blob holds the REDACTED record — the same bytes the event
 * row carries, minus the pointer. It is not the reporter's submitted body,
 * and that is deliberate: redacting an arbitrary submitted body would need a
 * redactor for shapes the Tier-0 engine does not model, and storing anything
 * no redactor has passed is the exact failure §6.5.1 exists to prevent.
 * Raw and normalized coincide at TW1a because there is no translation step
 * yet — OTLP/OpenInference translation is TW1b (`dac2ca71`), and it is TW1b
 * that gives this store a pre-translation payload to hold. What TW1a
 * establishes is the GOVERNANCE: the namespace, the tier rule, the retention
 * and the receipts, all enforced by the schema rather than by this file.
 *
 * WHY THERE IS NO `put()` METHOD. The blob and the event are written by ONE
 * statement, so this module exports a CTE and its parameters rather than a
 * second round trip. Candidate B learned that the hard way: a gate and a write
 * split across two statements — even inside a transaction — produced a
 * self-deadlock on the ordinary path (review `fc4829d2`, R3-B1). A blob
 * written by its own statement would be worse than merely slow: an event that
 * failed to insert would leave an orphan blob behind, and a blob that failed
 * would leave the event pointing at nothing. One statement makes both
 * impossible.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../utils/telemetryEnvelopeValidator';
import type { TelemetryPrincipalBinding } from '../types/TelemetryEnvelope';
import type { TelemetryRedactionCounts } from './TelemetryPolicyEngine';
import { telemetryEventExpiry } from '../utils/telemetryRetention';

/** The blob-key scheme, mirrored by migration 113's own CHECK. */
export const TELEMETRY_RAW_BLOB_PREFIX = 'rhraw/1';

/**
 * The only payload class TW1a can write. Migration 113 forbids the Tier-2
 * class at tiers 0 and 1 outright, so this constant cannot drift into one.
 */
export const TELEMETRY_RAW_PAYLOAD_CLASS = 'telemetry_raw_redacted';

/**
 * `rhraw/1:<connector>:<sha256 of the redacted payload>`.
 *
 * The database derives the same string from the row's own `connector_id` and
 * `content_hash` in a CHECK, so this function cannot mint a key naming another
 * connector's blob — if it tried, the write would be refused. Per-source
 * deletion stays well-defined because the owner is IN the key.
 */
export function telemetryRawBlobKey(connectorId: string, contentHash: string): string {
  return `${TELEMETRY_RAW_BLOB_PREFIX}:${connectorId}:${contentHash}`;
}

/**
 * The fields the RECEIVER assigns rather than the reporter, stripped before
 * content-addressing.
 *
 * Without this the store is content-addressed in name only: `observed_at` is
 * the receiver's own clock and is different for every event, so two identical
 * reports would address differently and the store would keep a copy per
 * arrival. Stripping the receiver's annotations makes the address mean what it
 * says — the same reported payload from the same connector is ONE blob,
 * however many times it arrives.
 *
 * Nothing is lost by the strip. `observed_at` and the policy stamp live on the
 * event row, and the blob row carries `policy_tier` and `redaction_counts` as
 * columns of its own, so the tier under which the payload was redacted is
 * still recoverable from the blob alone.
 */
export const TELEMETRY_RAW_BLOB_RECEIVER_FIELDS = ['observed_at', 'policy'] as const;

export function telemetryRawBlobPayload(record: unknown): unknown {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return record;
  const rest: Record<string, unknown> = { ...(record as Record<string, unknown>) };
  for (const field of TELEMETRY_RAW_BLOB_RECEIVER_FIELDS) delete rest[field];
  const source = rest.source;
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    // The pointer is receiver-assigned too, and it cannot be inside the bytes
    // whose hash produces it.
    rest.source = { ...(source as Record<string, unknown>), raw_ref: null };
  }
  return rest;
}

export interface TelemetryRawBlobDescriptor {
  blobKey: string;
  contentHash: string;
  /** Canonical JSON of the redacted record — the bytes that were hashed. */
  serialized: string;
  byteSize: number;
  policyTier: number;
  redactionCounts: TelemetryRedactionCounts;
  expiresAt: Date;
  referencedAt: Date;
}

/**
 * Content-address the redacted record.
 *
 * `JSON.stringify` is NOT used for the hash: two records with the same fields
 * in a different order would content-address differently and store twice. The
 * hash runs over the same canonical form `payload_hash` uses, and over the
 * REPORTED payload only (see `telemetryRawBlobPayload`), so identical reports
 * collapse to one blob however their keys were ordered and whenever they
 * arrived.
 */
export function describeTelemetryRawBlob(
  binding: TelemetryPrincipalBinding,
  record: unknown,
  counts: TelemetryRedactionCounts,
  observedAt: Date,
): TelemetryRawBlobDescriptor {
  const serialized = canonicalJson(telemetryRawBlobPayload(record));
  const contentHash = createHash('sha256').update(serialized, 'utf8').digest('hex');
  return {
    blobKey: telemetryRawBlobKey(binding.connectorId, contentHash),
    contentHash,
    serialized,
    byteSize: Buffer.byteLength(serialized, 'utf8'),
    policyTier: binding.policyTier,
    redactionCounts: counts,
    expiresAt: telemetryEventExpiry(observedAt),
    referencedAt: observedAt,
  };
}

/**
 * The blob half of the ingest statement. Parameters $1-$9; the event insert it
 * depends on continues from $10.
 *
 * WHICH WAY THE DEPENDENCY POINTS IS THE WHOLE OF REVIEW `d9697a35` F1. The
 * first version had the EVENT select from the blob, so the blob was written
 * unconditionally — a data-modifying CTE always executes. Re-sending an
 * existing idempotency key with any difference in the redacted payload then
 * content-addressed a NEW blob, the event insert lost its `ON CONFLICT`, and
 * the store returned `duplicate: true` alongside a pointer to a blob no event
 * referenced. An orphan, and a lie in the same breath.
 *
 * Now the blob SELECTS FROM the event. If the event insert wins, the blob is
 * written or touched; if it loses to a duplicate, `event` returns no rows and
 * this writes NOTHING. There is no arrangement of the two in which a blob
 * outlives the reason it was stored.
 *
 * The foreign key survives the inversion because the event references a blob
 * created LATER IN THE SAME STATEMENT: referential-integrity triggers are AFTER
 * ROW triggers, queued and fired once the whole statement — CTEs included — has
 * finished, by which time the blob row exists. The probe proves this against
 * real PostgreSQL rather than trusting the paragraph.
 *
 * `ON CONFLICT DO UPDATE` rather than `DO NOTHING` because a second event that
 * legitimately addresses the same content should record that the blob was
 * referenced again, and extend its expiry to the later of the two.
 */
export const TELEMETRY_RAW_BLOB_CTE = `
  raw_blob AS (
    INSERT INTO telemetry_raw_blobs
      (blob_key, connector_id, content_hash, policy_tier, payload_class,
       payload, redaction_counts, byte_size, expires_at, last_referenced_at)
    SELECT $1, $2, $3, $4, '${TELEMETRY_RAW_PAYLOAD_CLASS}',
           $5::jsonb, $6::jsonb, $7, $8, $9
      FROM event
    ON CONFLICT (blob_key) DO UPDATE
           SET last_referenced_at = EXCLUDED.last_referenced_at,
               expires_at = GREATEST(telemetry_raw_blobs.expires_at, EXCLUDED.expires_at)
     RETURNING blob_key
  )`;

export function rawBlobParams(
  descriptor: TelemetryRawBlobDescriptor,
  connectorId: string,
): [string, string, string, number, string, string, number, Date, Date] {
  return [
    descriptor.blobKey,
    connectorId,
    descriptor.contentHash,
    descriptor.policyTier,
    descriptor.serialized,
    JSON.stringify(descriptor.redactionCounts),
    descriptor.byteSize,
    descriptor.expiresAt,
    descriptor.referencedAt,
  ];
}
