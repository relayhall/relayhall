/**
 * TelemetryAdapterHealthService — the §8.3 adapter-health WRITER for the
 * ingest paths (RH-TW1b slice 1, card `dac2ca71`; design `7d5c0cdc` §3.1 item
 * 1 "surfaced on adapter health", §8.3).
 *
 * It writes the migration-055 `session_adapter_health` table, which
 * `GET /sessions/pipeline-health` already reads; no schema change is needed:
 * the per-request counters live in the row's existing `safe_details` JSONB.
 *
 * THE ROW SET IS BOUNDED BY CONSTRUCTION (the lesson candidate A's drill
 * measured: a counted cap in a `WHERE` does not hold under concurrency). Both
 * key columns are RECEIVER-KNOWN: `source` is one of the closed ingest-path
 * names below, and `source_instance` is the owning Connector's principal id,
 * which exists only by an authenticated administrative act. No payload can add
 * a row, so no cap is needed. The counter KEYS inside `safe_details.counts`
 * are equally closed: refusal codes, translation ids and fixed names.
 *
 * ONE STATEMENT per request: the counters are added inside the
 * `ON CONFLICT ... DO UPDATE`, which holds the row lock, so two concurrent
 * requests for one Connector both land — there is no read-modify-write.
 *
 * Metadata only (§6.5.3): counts, codes, versions and timestamps. Never a
 * payload byte, never a producer string.
 */
import type { Pool } from 'pg';
import { pool as defaultPool } from '../db/connection';
import { telemetryAcceptedMajorsAdvertisement } from '../utils/telemetryEnvelopeValidator';

export const TELEMETRY_ADAPTER_SOURCES = {
  otlpHttp: 'otlp-http',
  // RH-TW1b slice 2: the OTLP/gRPC listener, its own row per Connector so an
  // operator can see which transport a producer is actually using.
  otlpGrpc: 'otlp-grpc',
  nativeEnvelope: 'native-envelope',
} as const;
export type TelemetryAdapterSource = (typeof TELEMETRY_ADAPTER_SOURCES)[keyof typeof TELEMETRY_ADAPTER_SOURCES];

/** OTLP protocol versions the receiver accepts, advertised with the envelope majors. */
export const TELEMETRY_OTLP_ACCEPTED_VERSIONS: readonly string[] = ['v1'];

const COUNTER_KEY_RE = /^[a-z][a-z0-9_.\-]{0,63}$|^rejected\.[A-Z][A-Z0-9_]{2,63}$/;

export interface TelemetryAdapterHealthReport {
  source: TelemetryAdapterSource;
  connectorId: string;
  adapterVersion: string;
  /** Counter increments for this request. Keys from a closed vocabulary. */
  counts: Record<string, number>;
  /** The refusal code that dominated this request, if any. */
  reasonCode: string | null;
  accepted: number;
  rejected: number;
  /** Latest source-side timestamp seen in the request. */
  lastSourceAt: Date | null;
  /** Receiver clock minus that timestamp, in whole milliseconds. Never applied to an event. */
  clockSkewMs: number | null;
  /** Extra non-counter facts (signal, encoding). Closed vocabularies only. */
  facts?: Record<string, string>;
}

/**
 * healthy: something was accepted, or nothing was refused.
 * degraded: everything this request carried was refused.
 */
export function adapterStatusFor(report: Pick<TelemetryAdapterHealthReport, 'accepted' | 'rejected'>): 'healthy' | 'degraded' {
  return report.rejected > 0 && report.accepted === 0 ? 'degraded' : 'healthy';
}

export class TelemetryAdapterHealthService {
  constructor(private readonly pool: Pool = defaultPool) {}

  async record(report: TelemetryAdapterHealthReport, now: Date = new Date()): Promise<void> {
    const counts: Record<string, number> = {};
    for (const [key, value] of Object.entries(report.counts)) {
      if (!COUNTER_KEY_RE.test(key)) throw new Error('adapter health counter keys are a closed vocabulary');
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('adapter health counters are non-negative integers');
      if (value > 0) counts[key] = value;
    }
    const advertisement = telemetryAcceptedMajorsAdvertisement();
    const details = {
      schemaFamily: advertisement.schemaFamily,
      acceptedMajors: advertisement.acceptedMajors,
      acceptedOtlpVersions: TELEMETRY_OTLP_ACCEPTED_VERSIONS,
      lastClockSkewMs: report.clockSkewMs,
      ...(report.facts ?? {}),
      counts,
    };
    const status = adapterStatusFor(report);
    await this.pool.query(
      `INSERT INTO session_adapter_health (
         source, source_instance, adapter_version, status, reason_code,
         last_source_at, last_success_at, last_error_at, checked_at, safe_details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (source, source_instance) DO UPDATE SET
         adapter_version = EXCLUDED.adapter_version,
         status = EXCLUDED.status,
         reason_code = EXCLUDED.reason_code,
         last_source_at = GREATEST(session_adapter_health.last_source_at, EXCLUDED.last_source_at),
         last_success_at = COALESCE(EXCLUDED.last_success_at, session_adapter_health.last_success_at),
         last_error_at = COALESCE(EXCLUDED.last_error_at, session_adapter_health.last_error_at),
         checked_at = EXCLUDED.checked_at,
         safe_details = (session_adapter_health.safe_details - 'counts') || (EXCLUDED.safe_details - 'counts')
           || jsonb_build_object('counts', (
             SELECT COALESCE(jsonb_object_agg(k,
                      COALESCE((session_adapter_health.safe_details->'counts'->>k)::bigint, 0)
                      + COALESCE((EXCLUDED.safe_details->'counts'->>k)::bigint, 0)), '{}'::jsonb)
               FROM (SELECT jsonb_object_keys(COALESCE(session_adapter_health.safe_details->'counts', '{}'::jsonb))
                     UNION
                     SELECT jsonb_object_keys(COALESCE(EXCLUDED.safe_details->'counts', '{}'::jsonb))) AS keys(k)))`,
      [
        report.source,
        report.connectorId,
        report.adapterVersion,
        status,
        status === 'degraded' ? report.reasonCode : null,
        report.lastSourceAt,
        report.accepted > 0 ? now : null,
        report.rejected > 0 ? now : null,
        now,
        JSON.stringify(details),
      ],
    );
  }
}

export const telemetryAdapterHealthService = new TelemetryAdapterHealthService();
