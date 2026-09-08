/**
 * TelemetryEnvelopeStore — THE ONE normalization entry point and the ONE
 * envelope write path (RH-TW1a, card `beac9c79`).
 *
 * `validate -> dedupe -> redact -> store`, in that order, in one method. Run
 * packet `bb83d616` §8 makes this a contract, not a preference: TW1b
 * (`dac2ca71`) translates OTLP into `rh.ai.telemetry/1.0` envelopes and calls
 * THIS method, so that translated traffic and native traffic cannot diverge.
 * **A second write path is the defect.**
 *
 * NO HTTP HERE. Candidate A ships the write path only; the native endpoint,
 * the principal derivation that produces a `TelemetryPrincipalBinding`, and
 * the receiver limits are candidate B. The binding arrives as an argument
 * precisely so that this module cannot accidentally derive identity from the
 * envelope: it never sees a request.
 *
 * WHAT IS WRITTEN, AND WHAT IS NOT (owner decision D1, design §2.1.4): rows
 * land in the migration-055 `session_events` table, extended in place by
 * migration 111. There is no parallel session database.
 *
 * ATTEMPT-LESS BY CONSTRUCTION (§2.2.1, and the D1 control): every envelope
 * row is written with `attempt_id = NULL`. `CanonicalRuntimeSignalService`'s
 * `progress_sequence` counts `session_events` rows `WHERE e.attempt_id =
 * l.attempt_id`, which no NULL row can satisfy — so envelope traffic cannot
 * move a Task's canonical progress count. The property is pinned twice: by
 * `telemetryEnvelopeStore.test.ts` on the SQL this module issues, and — across
 * the seam, against a real PostgreSQL — by
 * `backend/scripts/test-telemetry-envelope-migration.js`, which runs the
 * service's own LATERAL count before and after inserting an attempt-less
 * envelope `tool_call` row.
 */
import { Pool } from 'pg';
import { pool as defaultPool } from '../db/connection';
import type { TelemetryEnvelope, TelemetryPrincipalBinding } from '../types/TelemetryEnvelope';
import {
  canonicalPayloadHash,
  telemetryEventIdentityKey,
  validateTelemetryEnvelope,
  type TelemetryValidationFailure,
} from '../utils/telemetryEnvelopeValidator';
import {
  applyTelemetryPolicy,
  TelemetryPolicyError,
  type TelemetryAttributeProfile,
  type TelemetryPolicyOptions,
  type TelemetryRedactionCounts,
} from './TelemetryPolicyEngine';
import {
  TELEMETRY_RAW_BLOB_CTE,
  describeTelemetryRawBlob,
  rawBlobParams,
} from './TelemetryRawStore';

export type TelemetryEnvelopeStoreOutcome =
  | {
      accepted: true;
      duplicate: boolean;
      eventId: string | null;
      identityKey: string;
      identityArm: 'event_id' | 'stream_sequence';
      sessionRef: string | null;
      counts: TelemetryRedactionCounts;
      /**
       * The §6.5.1 governed raw blob this call WROTE, or null when the event
       * was a duplicate and therefore stored none. Never the key of a blob
       * that was not written (review `d9697a35` F1).
       */
      rawRef: string | null;
    }
  | {
      accepted: false;
      /**
       * WHICH STAGE refused, so a caller never has to keep a list of codes.
       * `validation` means the input was malformed and belongs in quarantine
       * (§6.5.2); `policy` means a well-formed record was refused by the tier
       * arm (TS-5 / D9) and belongs nowhere — quarantining legitimate traffic
       * a deployment declined would fill the plane with its own policy.
       */
      stage: 'validation' | 'policy';
      code: string;
      field: string;
      message: string;
      acceptedMajors?: readonly number[];
    };

export interface TelemetryEnvelopeStoreOptions {
  /** Receiver clock; defaults to now. Injected in tests for determinism. */
  observedAt?: Date;
  /** A certified adapter profile: key -> the value class it is certified for (§4.5). */
  attributeAllowlist?: TelemetryAttributeProfile;
}

export class TelemetryEnvelopeStore {
  constructor(private readonly pool: Pool = defaultPool) {}

  /**
   * Normalize and persist ONE envelope under an already-derived principal
   * binding.
   *
   * Ordering is load-bearing. Validation runs before anything else so a
   * malformed record never reaches the redactor. Identity is computed from
   * the VALIDATED record and the binding's `connectorId` — never from a
   * payload-supplied connector — so dedupe is connector-namespaced by
   * construction (§4.3). Redaction runs BEFORE storage, so the unredacted
   * record never reaches the database, not even inside a transaction that
   * later rolls back.
   */
  async store(
    binding: TelemetryPrincipalBinding,
    input: unknown,
    options: TelemetryEnvelopeStoreOptions = {},
  ): Promise<TelemetryEnvelopeStoreOutcome> {
    // 1 — VALIDATE
    const validation = validateTelemetryEnvelope(input);
    if (!validation.ok) return failure(validation);
    const envelope: TelemetryEnvelope = validation.envelope;

    // 2 — DEDUPE KEY (connector-namespaced, §4.3)
    const identity = telemetryEventIdentityKey(binding.connectorId, envelope);

    // 3 — REDACT (tier-gated; tiers 1 and 2 refuse, TS-5 / D9)
    const policyOptions: TelemetryPolicyOptions = {
      observedAt: options.observedAt ?? new Date(),
      attributeAllowlist: options.attributeAllowlist,
    };
    let policy;
    try {
      policy = applyTelemetryPolicy(binding.policyTier, envelope, policyOptions);
    } catch (err) {
      if (err instanceof TelemetryPolicyError) {
        return { accepted: false, stage: 'policy', code: err.code, field: 'policy_tier', message: err.message };
      }
      throw err;
    }

    // 4 — CONTENT-ADDRESS THE REDACTED PAYLOAD (§6.5.1), THEN STORE, IN ONE
    // STATEMENT — with the EVENT deciding whether the blob is written at all.
    //
    // Review `d9697a35` F1: the first version had the event select from the
    // blob, so the blob was written unconditionally. Re-sending an existing
    // idempotency key with a changed redacted payload stored a new blob that
    // no event referenced, and the store returned that pointer while reporting
    // a duplicate. The dependency is inverted: `raw_blob` selects FROM `event`,
    // so a duplicate writes nothing and reports no pointer, because it stored
    // none.
    //
    // The blob key is a pure function of the connector and the content hash, so
    // the event can carry it before the blob row exists; the foreign key is
    // satisfied because RI triggers fire after the whole statement.
    //
    // The blob is addressed over the record as the POLICY left it — pointer
    // still null — because a key derived from a record that already contained
    // that key could not be computed. The event's stored copy carries the
    // pointer, so its own `payload_hash` covers it.
    const blob = describeTelemetryRawBlob(
      binding, policy.record, policy.counts, policyOptions.observedAt as Date);
    const record = {
      ...policy.record,
      source: { ...policy.record.source, raw_ref: blob.blobKey },
    };

    const inserted = await this.pool.query(
      `WITH event AS (
         INSERT INTO session_events (
           attempt_id, source, source_instance, stream_generation, event_kind,
           source_event_id, source_sequence, source_occurred_at,
           payload, payload_hash, redaction_policy_version, idempotency_key,
           connector_id, account_id, agent_id, source_product, session_ref,
           policy_tier, schema_version, observed_at, raw_ref
         ) VALUES (
           NULL::uuid, $10, $11, $12, $13,
           $14, $15, $16,
           $17, $18, $19, $20,
           $21, $22, $23, $24, $25,
           $26, $27, $28, $1
         )
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING event_id
       ), ${TELEMETRY_RAW_BLOB_CTE}
       SELECT (SELECT event_id FROM event) AS event_id,
              (SELECT blob_key FROM raw_blob) AS raw_ref`,
      [
        ...rawBlobParams(blob, binding.connectorId),
        envelope.source.adapter,
        record.source.instance_ref ?? 'unattributed',
        record.stream_generation ?? 'envelope:none',
        policy.eventKind,
        record.event_id,
        record.source_sequence,
        record.occurred_at,
        JSON.stringify(record),
        canonicalPayloadHash(record),
        policy.policyVersion,
        identity.key,
        binding.connectorId,
        binding.accountId,
        binding.agentId,
        envelope.source.product,
        policy.sessionRef,
        binding.policyTier,
        envelope.schema_version,
        record.observed_at,
      ],
    );

    // The final SELECT always returns exactly one row; both columns are NULL
    // when the event lost its `ON CONFLICT`. That is the duplicate signal, and
    // a null `rawRef` alongside it is the truth: this call stored no blob.
    const row = inserted.rows[0] as { event_id: string | null; raw_ref: string | null };
    return {
      accepted: true,
      duplicate: row.event_id === null,
      eventId: row.event_id,
      identityKey: identity.key,
      identityArm: identity.arm,
      sessionRef: policy.sessionRef,
      counts: policy.counts,
      rawRef: row.raw_ref,
    };
  }
}

function failure(validation: TelemetryValidationFailure): TelemetryEnvelopeStoreOutcome {
  return {
    accepted: false,
    stage: 'validation',
    code: validation.code,
    field: validation.field,
    message: validation.message,
    ...(validation.acceptedMajors ? { acceptedMajors: validation.acceptedMajors } : {}),
  };
}

export const telemetryEnvelopeStore = new TelemetryEnvelopeStore();
