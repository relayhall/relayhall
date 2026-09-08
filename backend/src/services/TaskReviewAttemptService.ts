import { createHash } from 'crypto';
import { NotFoundFault } from '../utils/httpErrors';
import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../db/connection';
import { feedEventService } from './FeedEventService';
import { syncTaskReadiness, syncDependentsReadiness } from '../utils/taskReadiness';
import type { Subtask, Task } from './TaskManagerDB';

export type ReviewAttemptDecision = 'pass' | 'reject' | 'escalate';

export interface ReviewAttemptIdentity {
  id: string;
  attemptNo: number;
  idempotencyKey: string;
  reviewSlice: Array<{
    subtaskId: string;
    index: number;
    title: string;
    status: 'review';
    updatedAt: string;
    evidenceReceipt: string;
  }>;
  status: string;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

/**
 * Select the only reviewable slice: a contiguous group of review subtasks after
 * a completed/skipped prefix. Later empty work is allowed; gaps or active work
 * before the slice fail closed.
 */
export function buildCanonicalReviewSlice(task: Task): ReviewAttemptIdentity['reviewSlice'] {
  const subtasks = task.subtasks || [];
  const firstReview = subtasks.findIndex((subtask) => subtask.status === 'review');
  if (firstReview < 0) throw new Error('No subtask is ready for review');
  const invalidPrefix = subtasks.slice(0, firstReview).find((subtask) => !['completed', 'skipped'].includes(subtask.status));
  if (invalidPrefix) throw new Error('Review slice is not preceded by a completed/skipped prefix');

  const reviewed: Array<{ subtask: Subtask; index: number }> = [];
  for (let index = firstReview; index < subtasks.length && subtasks[index].status === 'review'; index += 1) {
    reviewed.push({ subtask: subtasks[index], index });
  }
  if (subtasks.slice(firstReview + reviewed.length).some((subtask) => subtask.status === 'review')) {
    throw new Error('Review subtasks must form one contiguous slice');
  }

  const fallbackReceipt = task.completedBy?.sessionKey || task.sessionRefs?.[task.sessionRefs.length - 1] || task.notes;
  return reviewed.map(({ subtask, index }) => {
    const evidenceReceipt = subtask.reviewNote || subtask.sessionRef || fallbackReceipt;
    if (!evidenceReceipt) throw new Error(`Review subtask ${index} has no immutable evidence receipt`);
    return {
      subtaskId: String(subtask.id),
      index,
      title: subtask.text,
      status: 'review' as const,
      updatedAt: subtask.completedAt || task.updated,
      evidenceReceipt,
    };
  });
}

export class TaskReviewAttemptService {
  constructor(private readonly pool: Pool = defaultPool, private readonly timeoutMs = 300000) {}

  async beginAttempt(task: Task, evidence: unknown): Promise<ReviewAttemptIdentity> {
    const reviewSlice = buildCanonicalReviewSlice(task);
    const reviewSliceHash = sha256(reviewSlice);
    const implementationReceiptHash = sha256(evidence);
    const snapshot = iso(task.updated);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query('SELECT status, updated_at, attempt_count, max_retries FROM tasks WHERE id=$1 FOR UPDATE', [task.id]);
      if (!locked.rowCount) throw new NotFoundFault(`Task not found: ${task.id}`, 'TASK_NOT_FOUND');
      if (locked.rows[0].status !== 'review') throw new Error(`Task is not currently in review (status=${locked.rows[0].status})`);
      if (iso(locked.rows[0].updated_at) !== snapshot) throw new Error('Task snapshot changed before review attempt');

      // `tasks.attempt_count` is the retry-budget counter: escalations that do
      // not consume that budget deliberately leave it unchanged. It therefore
      // cannot also be the immutable review-attempt sequence. First make a
      // retry of this exact snapshot idempotent, then derive the next sequence
      // number from the ledger itself while the Task row is locked.
      const existing = await client.query(
        `SELECT id, attempt_no, idempotency_key, review_slice, status
           FROM task_review_attempts
          WHERE task_id=$1 AND task_snapshot_updated_at=$2
            AND review_slice_hash=$3 AND implementation_receipt_hash=$4
          ORDER BY attempt_no DESC LIMIT 1`,
        [task.id, snapshot, reviewSliceHash, implementationReceiptHash],
      );
      if (existing.rowCount) {
        await client.query('COMMIT');
        return {
          id: existing.rows[0].id,
          attemptNo: existing.rows[0].attempt_no,
          idempotencyKey: existing.rows[0].idempotency_key,
          reviewSlice: existing.rows[0].review_slice,
          status: existing.rows[0].status,
        };
      }
      const sequence = await client.query(
        `SELECT COALESCE(MAX(attempt_no), 0) + 1 AS attempt_no
           FROM task_review_attempts WHERE task_id=$1`,
        [task.id],
      );
      const attemptNo = Number(sequence.rows[0].attempt_no);
      const idempotencyKey = `review:${task.id}:${attemptNo}:${snapshot}:${reviewSliceHash}`;
      const result = await client.query(
        `INSERT INTO task_review_attempts (
           task_id, attempt_no, status, task_snapshot_updated_at, review_slice_version,
           review_slice_hash, review_slice, implementation_receipt_hash,
           implementation_session_key, implementation_commit, evidence,
           idempotency_key, started_at, deadline_at
         ) VALUES ($1,$2,'running',$3,1,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10,NOW(),NOW()+($11*INTERVAL '1 millisecond'))
         ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
         RETURNING id, attempt_no, idempotency_key, review_slice, status`,
        [task.id, attemptNo, snapshot, reviewSliceHash, JSON.stringify(reviewSlice), implementationReceiptHash,
          task.completedBy?.sessionKey || task.sessionRefs?.[task.sessionRefs.length - 1] || null,
          task.notes?.match(/\b[0-9a-f]{40}\b/i)?.[0] || null, JSON.stringify(evidence || {}), idempotencyKey, this.timeoutMs],
      );
      await client.query('COMMIT');
      return {
        id: result.rows[0].id,
        attemptNo: result.rows[0].attempt_no,
        idempotencyKey: result.rows[0].idempotency_key,
        reviewSlice: result.rows[0].review_slice,
        status: result.rows[0].status,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async recordVerdict(
    attemptId: string,
    decision: ReviewAttemptDecision,
    findings: unknown,
    verdict: unknown,
    reviewerSessionKey?: string,
    incrementAttempt = decision === 'reject',
  ): Promise<{ status: string; attemptCount: number; applied: boolean }> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT a.*, t.status AS task_status, t.attempt_count, t.max_retries, t.updated_at AS current_task_updated_at
           FROM task_review_attempts a JOIN tasks t ON t.id=a.task_id
          WHERE a.id=$1 FOR UPDATE OF a,t`, [attemptId]);
      if (!result.rowCount) throw new NotFoundFault(`Review attempt not found: ${attemptId}`, 'REVIEW_ATTEMPT_NOT_FOUND');
      const row = result.rows[0];
      if (row.status !== 'running') {
        await client.query('COMMIT');
        return { status: row.task_status, attemptCount: row.attempt_count, applied: false };
      }
      if (row.task_status !== 'review') throw new Error(`Task advanced before verdict (status=${row.task_status})`);
      if (iso(row.current_task_updated_at) !== iso(row.task_snapshot_updated_at)) {
        throw new Error('Task snapshot changed before Verifier verdict');
      }

      let finalDecision = decision;
      let nextStatus = 'review';
      let attemptCount = Number(row.attempt_count || 0);
      if (incrementAttempt) {
        attemptCount += 1;
        if (attemptCount >= Number(row.max_retries)) {
          finalDecision = 'escalate';
          nextStatus = 'stuck';
        } else {
          finalDecision = 'reject';
          nextStatus = 'todo';
        }
      } else if (decision === 'escalate') {
        nextStatus = 'stuck';
      }
      const attemptStatus = finalDecision === 'pass' ? 'passed' : finalDecision === 'reject' ? 'rejected' : 'escalated';
      await client.query(
        `UPDATE task_review_attempts SET status=$2, reviewer_session_key=$3, verdict=$4::jsonb,
                findings=$5::jsonb, finished_at=NOW() WHERE id=$1 AND status='running'`,
        [attemptId, attemptStatus, reviewerSessionKey || null, JSON.stringify(verdict || {}), JSON.stringify(findings || [])],
      );
      const indexes = (row.review_slice as Array<{ index: number }>).map((item) => item.index);
      const disposition = finalDecision === 'pass' ? 'completed' : finalDecision === 'reject' ? 'empty' : 'stuck';
      const verdictSummary = verdict && typeof verdict === 'object' && typeof (verdict as { summary?: unknown }).summary === 'string'
        ? String((verdict as { summary: string }).summary)
        : `Verifier ${finalDecision}`;
      const resolved = await client.query(
        `UPDATE subtasks
            SET status=$3::varchar,
                note=CASE
                  WHEN $3::varchar='completed' THEN COALESCE(note, $4)
                  WHEN $3::varchar='empty' THEN 'REJECTED: ' || $4
                  ELSE 'ESCALATED: ' || $4
                END,
                blocked_reason=CASE WHEN $3::varchar='stuck' THEN $4 ELSE NULL END,
                completed_at=CASE WHEN $3::varchar='completed' THEN NOW() ELSE NULL END,
                updated_at=NOW()
          WHERE task_id=$1 AND index=ANY($2::int[]) AND status='review'
          RETURNING index`,
        [row.task_id, indexes, disposition, verdictSummary],
      );
      if (resolved.rowCount !== indexes.length) {
        throw new Error('Immutable review slice changed before Verifier verdict');
      }
      if (finalDecision === 'pass') {
        const statuses = await client.query('SELECT status FROM subtasks WHERE task_id=$1 ORDER BY index', [row.task_id]);
        nextStatus = statuses.rows.every((item) => item.status === 'completed' || item.status === 'skipped')
          ? 'completed'
          : 'todo';
      }
      const applied = await client.query(
        `UPDATE tasks SET status=$2, attempt_count=$3, needs_review=$4, updated_at=NOW()
          WHERE id=$1 AND status='review'
          RETURNING project_id, owner_principal_id`,
        [row.task_id, nextStatus, attemptCount, finalDecision === 'escalate']);
      // RH-P3.C1 (round 2, F2): verdict application is a Task write every
      // consumer can observe; it and its feed event commit together.
      await feedEventService.emit(client, {
        name: 'task.updated',
        objectType: 'task',
        objectId: row.task_id,
        projectId: applied.rows[0]?.project_id ?? null,
        ownerPrincipalId: applied.rows[0]?.owner_principal_id ?? null,
        payload: { status: nextStatus, previousStatus: 'review' },
      });
      // RH-P3.C2 (pre-review F3): a passing verdict with incomplete subtasks
      // returns the task to 'todo' — a transition INTO the ready state that
      // no other hook observes. Completing it instead can unblock dependents.
      await syncTaskReadiness(client, row.task_id, null);
      if (nextStatus === 'completed') {
        await syncDependentsReadiness(client, row.task_id, null);
      }
      await client.query('COMMIT');
      return { status: nextStatus, attemptCount, applied: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export const taskReviewAttemptService = new TaskReviewAttemptService();
