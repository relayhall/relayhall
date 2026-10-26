import type { Pool } from 'pg';
import { pool as defaultPool } from '../db/connection';
import type { ReviewHistoryEntry } from './TaskManagerDB';

export interface TaskSessionEvidence {
  taskId: string;
  attemptId: string;
  linkId: string;
  harness: string;
  startedAt: string | null;
  endedAt: string | null;
  lifecycle: string | null;
}

/** Records with a lawful canonical writer; no task JSON, reported text, or aliases.
 * Callers exposing a list must first narrow its Task ids to their readable set. */
export class TaskSessionEvidenceService {
  constructor(private readonly pool: Pool = defaultPool) {}

  async listForTasks(taskIds: string[]): Promise<TaskSessionEvidence[]> {
    if (taskIds.length === 0) return [];
    const result = await this.pool.query(
      `SELECT l.task_id, l.link_id, l.attempt_id, a.harness, a.started_at, a.ended_at,
              lifecycle.payload->>'lifecycle' AS lifecycle
         FROM task_attempt_links l JOIN session_attempts a ON a.attempt_id=l.attempt_id
         LEFT JOIN LATERAL (
           SELECT e.payload FROM session_events e
            WHERE e.attempt_id=l.attempt_id AND e.event_kind='lifecycle'
            ORDER BY COALESCE(e.source_occurred_at,e.ingested_at) DESC,e.ingested_at DESC,e.event_id DESC
            LIMIT 1
         ) lifecycle ON TRUE
        WHERE l.task_id=ANY($1::uuid[]) AND l.role='implementation'
          AND l.link_state IN ('claimed','bound','released')
          AND l.source IN ('task_spawn','runtime_callback','operator')
          AND a.identity_confidence IN ('authoritative','correlated')
        ORDER BY l.task_id,l.attempt_number DESC,l.linked_at DESC,l.link_id`,
      [taskIds],
    );
    const iso = (value: unknown) => value == null ? null
      : value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
    return result.rows.map(row => ({
      taskId: String(row.task_id), attemptId: String(row.attempt_id), linkId: String(row.link_id),
      harness: row.harness, startedAt: iso(row.started_at), endedAt: iso(row.ended_at),
      lifecycle: row.lifecycle ?? null,
    }));
  }

  async reviewEvidence(taskId: string): Promise<Pick<ReviewHistoryEntry['evidence'], 'sessionRefs' | 'completedBy'>> {
    const sessions = await this.listForTasks([taskId]);
    const completed = sessions.find(session => session.endedAt && session.lifecycle === 'completed');
    return {
      sessionRefs: [...new Set(sessions.map(session => session.attemptId))],
      // An ended or merely existing session is not proof of successful completion.
      completedBy: completed ? {
        sessionKey: completed.attemptId,
        ...(completed.harness === 'hermes' || completed.harness === 'openclaw' ? { harness: completed.harness } : {}),
      } : null,
    };
  }
}

export const taskSessionEvidenceService = new TaskSessionEvidenceService();
