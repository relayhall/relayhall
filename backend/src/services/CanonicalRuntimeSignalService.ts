import type { Pool } from 'pg';
import { pool as defaultPool } from '../db/connection';

export type OrchestratorRuntimeState = 'active' | 'idle' | 'stale' | 'orphan' | 'finished' | 'unknown';

export interface CanonicalRuntimeSignalEvidence {
  taskId: string;
  attemptId: string;
  attemptNumber: number;
  harness: string;
  linkState: string;
  linkedAt: Date;
  endedAt: Date | null;
  progressSequence: number;
  lastProgressAt: Date | null;
  latestEvidenceAt: Date | null;
  lifecycle: string | null;
  availability: string | null;
  freshness: string | null;
  writerLease: 'active' | 'expired' | 'released' | 'none';
}

export interface CanonicalRuntimeSignal {
  taskId: string;
  attemptId: string;
  attemptNumber: number;
  harness: string;
  state: OrchestratorRuntimeState;
  reasonCode: string;
  progressSequence: number;
  lastProgressAt: string | null;
  latestEvidenceAt: string | null;
  observedAt: string;
  evidence: {
    lifecycle: string | null;
    availability: string | null;
    freshness: string | null;
    writerLease: CanonicalRuntimeSignalEvidence['writerLease'];
    linkState: string;
  };
}

export interface RuntimeSignalWindows {
  activeMs: number;
  staleMs: number;
}

export const DEFAULT_RUNTIME_SIGNAL_WINDOWS: RuntimeSignalWindows = {
  activeMs: 90_000,
  staleMs: 9 * 60_000,
};

const TERMINAL_LIFECYCLES = new Set(['completed', 'failed', 'cancelled']);

function ageMs(value: Date | null, now: Date): number {
  return value ? Math.max(0, now.getTime() - value.getTime()) : Number.POSITIVE_INFINITY;
}

/**
 * Project canonical events into an orchestrator decision signal. Session
 * existence and an unended row are deliberately not treated as activity.
 */
export function classifyCanonicalRuntimeSignal(
  evidence: CanonicalRuntimeSignalEvidence,
  now = new Date(),
  windows: RuntimeSignalWindows = DEFAULT_RUNTIME_SIGNAL_WINDOWS,
): CanonicalRuntimeSignal {
  if (!(windows.activeMs > 0) || windows.staleMs < windows.activeMs) {
    throw new Error('runtime signal windows must be positive and ordered');
  }

  let state: OrchestratorRuntimeState;
  let reasonCode: string;
  const lifecycle = String(evidence.lifecycle || '').toLowerCase();
  const progressAge = ageMs(evidence.lastProgressAt, now);
  const evidenceAge = ageMs(evidence.latestEvidenceAt, now);

  if (TERMINAL_LIFECYCLES.has(lifecycle)) {
    state = 'finished';
    reasonCode = `terminal_lifecycle_${lifecycle}`;
  } else if (evidence.endedAt) {
    state = 'finished';
    reasonCode = 'attempt_ended_without_terminal_event';
  } else if (progressAge <= windows.activeMs) {
    state = 'active';
    reasonCode = 'recent_meaningful_progress';
  } else if (progressAge <= windows.staleMs) {
    state = 'idle';
    reasonCode = 'recent_but_not_active_progress';
  } else if (
    evidence.writerLease === 'expired'
    || (evidence.linkState === 'bound'
      && evidence.availability === 'unavailable'
      && evidenceAge > windows.activeMs)
    || (evidence.linkState === 'bound'
      && !evidence.latestEvidenceAt
      && ageMs(evidence.linkedAt, now) > windows.activeMs)
  ) {
    state = 'orphan';
    reasonCode = evidence.writerLease === 'expired'
      ? 'writer_lease_expired_without_terminal_evidence'
      : 'bound_attempt_source_unavailable';
  } else if (evidenceAge <= windows.activeMs) {
    state = 'idle';
    reasonCode = 'fresh_lifecycle_without_meaningful_progress';
  } else if (evidence.latestEvidenceAt) {
    state = 'stale';
    reasonCode = evidence.writerLease === 'active'
      ? 'writer_lease_active_but_progress_stale'
      : 'canonical_evidence_stale';
  } else {
    state = 'unknown';
    reasonCode = 'insufficient_canonical_evidence';
  }

  return {
    taskId: evidence.taskId,
    attemptId: evidence.attemptId,
    attemptNumber: evidence.attemptNumber,
    harness: evidence.harness,
    state,
    reasonCode,
    progressSequence: evidence.progressSequence,
    lastProgressAt: evidence.lastProgressAt?.toISOString() || null,
    latestEvidenceAt: evidence.latestEvidenceAt?.toISOString() || null,
    observedAt: now.toISOString(),
    evidence: {
      lifecycle: evidence.lifecycle,
      availability: evidence.availability,
      freshness: evidence.freshness,
      writerLease: evidence.writerLease,
      linkState: evidence.linkState,
    },
  };
}

interface RuntimeSignalRow {
  task_id: string;
  attempt_id: string;
  attempt_number: string | number;
  harness: string;
  link_state: string;
  linked_at: Date;
  ended_at: Date | null;
  progress_sequence: string | number;
  last_progress_at: Date | null;
  latest_evidence_at: Date | null;
  lifecycle: string | null;
  availability: string | null;
  freshness: string | null;
  writer_lease: CanonicalRuntimeSignalEvidence['writerLease'];
}

/**
 * The event kinds that count as PROGRESS on a canonical attempt.
 *
 * Exported (review `bfac1dd5` finding F6) because owner decision D1 of run
 * packet `bb83d616` turns this list into a load-bearing control: envelope rows
 * are written attempt-less precisely so they cannot move this count, and the
 * real-PostgreSQL probe that proves it must run THIS predicate rather than a
 * copy of it. A copy can drift silently and leave the control green while the
 * property it guards has changed.
 */
export const PROGRESS_EVENT_KINDS = ['message', 'tool_call', 'tool_result', 'control'] as const;

/** The same list as a SQL literal list, for interpolation into the LATERAL. */
export const PROGRESS_EVENT_KINDS_SQL = PROGRESS_EVENT_KINDS.map((k) => `'${k}'`).join(',');

export class CanonicalRuntimeSignalService {
  constructor(private readonly pool: Pool = defaultPool) {}

  async listTaskSignals(taskId: string, now = new Date()): Promise<CanonicalRuntimeSignal[]> {
    const result = await this.pool.query<RuntimeSignalRow>(
      `SELECT l.task_id, l.attempt_id, l.attempt_number, a.harness, l.link_state,
              l.linked_at, a.ended_at,
              COALESCE(progress.progress_sequence, 0) AS progress_sequence,
              progress.last_progress_at, evidence.latest_evidence_at,
              lifecycle.payload->>'lifecycle' AS lifecycle,
              lifecycle.payload->>'availability' AS availability,
              lifecycle.payload->>'freshness' AS freshness,
              CASE
                WHEN lease.released_at IS NOT NULL THEN 'released'
                WHEN lease.expires_at > $2::timestamptz THEN 'active'
                WHEN lease.expires_at IS NOT NULL THEN 'expired'
                ELSE 'none'
              END AS writer_lease
         FROM task_attempt_links l
         JOIN session_attempts a ON a.attempt_id=l.attempt_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::bigint AS progress_sequence,
                  MAX(COALESCE(e.source_occurred_at, e.ingested_at)) AS last_progress_at
             FROM session_events e
            WHERE e.attempt_id=l.attempt_id
              AND e.event_kind IN (${PROGRESS_EVENT_KINDS_SQL})
         ) progress ON TRUE
         LEFT JOIN LATERAL (
           SELECT MAX(COALESCE(e.source_occurred_at, e.ingested_at)) AS latest_evidence_at
             FROM session_events e WHERE e.attempt_id=l.attempt_id
         ) evidence ON TRUE
         LEFT JOIN LATERAL (
           SELECT e.payload
             FROM session_events e
            WHERE e.attempt_id=l.attempt_id AND e.event_kind='lifecycle'
            ORDER BY COALESCE(e.source_occurred_at, e.ingested_at) DESC, e.ingested_at DESC, e.event_id DESC
            LIMIT 1
         ) lifecycle ON TRUE
         LEFT JOIN LATERAL (
           SELECT o.expires_at, o.released_at
             FROM task_attempt_ownership o
            WHERE o.task_id=l.task_id AND o.attempt_id=l.attempt_id AND o.ownership_kind='writer'
            ORDER BY o.acquired_at DESC, o.ownership_id DESC LIMIT 1
         ) lease ON TRUE
        WHERE l.task_id=$1 AND l.link_state NOT IN ('released','superseded')
        ORDER BY l.attempt_number DESC, l.linked_at DESC`,
      [taskId, now],
    );

    return result.rows.map(row => classifyCanonicalRuntimeSignal({
      taskId: row.task_id,
      attemptId: row.attempt_id,
      attemptNumber: Number(row.attempt_number),
      harness: row.harness,
      linkState: row.link_state,
      linkedAt: new Date(row.linked_at),
      endedAt: row.ended_at ? new Date(row.ended_at) : null,
      progressSequence: Number(row.progress_sequence),
      lastProgressAt: row.last_progress_at ? new Date(row.last_progress_at) : null,
      latestEvidenceAt: row.latest_evidence_at ? new Date(row.latest_evidence_at) : null,
      lifecycle: row.lifecycle,
      availability: row.availability,
      freshness: row.freshness,
      writerLease: row.writer_lease,
    }, now));
  }
}

export const canonicalRuntimeSignalService = new CanonicalRuntimeSignalService();
