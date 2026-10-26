import { createHash } from 'crypto';
import type { NativeReviewScope } from '../utils/nativeReview';
import { NATIVE_REVIEW_INPUT_REPORTS_SQL, reviewDigest } from '../utils/nativeReview';
import { ConflictFault, NotFoundFault } from '../utils/httpErrors';
import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../db/connection';
import { accessVehicleService, AssignmentAccessError } from './AccessVehicleService';
import { feedEventService, type FeedActorRef } from './FeedEventService';
import { reapAccessRequestsAtTerminal } from '../utils/accessRequestTerminal';
import { syncTaskReadiness, syncDependentsReadiness } from '../utils/taskReadiness';
import type { Subtask, Task } from './TaskManagerDB';

export type ReviewAttemptDecision = 'pass' | 'reject' | 'escalate';

type ReviewedSubtaskSlice = {
  subtaskId: string;
  index: number;
  title: string;
  status: 'review';
  updatedAt: string;
  evidenceReceipt: string;
};

type FlatTaskSlice = {
  kind: 'flat_task_review';
  taskId: string;
  taskSnapshotUpdatedAt: string;
  evidenceReceipt: string;
  reportDigest: string;
};

type NativeTaskSlice = { kind: 'native_review'; scope: NativeReviewScope; subtaskDigest: string; reportDigest: string };
export interface ReviewAttemptIdentity {
  id: string;
  attemptNo: number;
  idempotencyKey: string;
  reviewSlice: ReviewedSubtaskSlice[] | [FlatTaskSlice] | [NativeTaskSlice];
  status: string;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Bind a flat-task attempt to the linked Report bytes without storing a second copy. */
export function hashReviewReports(reports: Array<{ id: string; title: string; summary?: string | null; content: string }>): string {
  return sha256(reports.map((report) => ({
    id: report.id,
    title: report.title,
    summary: report.summary || null,
    contentHash: createHash('sha256').update(report.content).digest('hex'),
  })).sort((a, b) => a.id.localeCompare(b.id)));
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

/**
 * Select the only reviewable slice: a contiguous group of review subtasks after
 * a completed/skipped prefix. Later empty work is allowed; gaps or active work
 * before the slice fail closed.
 */
export function buildCanonicalReviewSlice(
  task: Task,
  flatEvidence?: { implementationReceiptHash: string; reportDigest: string },
  executionEvidence?: Pick<import('./TaskManagerDB').ReviewHistoryEntry['evidence'], 'sessionRefs' | 'completedBy'>,
): ReviewAttemptIdentity['reviewSlice'] {
  const subtasks = task.subtasks || [];
  if (subtasks.length === 0) {
    if (!flatEvidence || !/^[0-9a-f]{64}$/.test(flatEvidence.implementationReceiptHash)
      || !/^[0-9a-f]{64}$/.test(flatEvidence.reportDigest)) {
      throw new Error('Flat Task review requires an immutable evidence and Report digest');
    }
    return [{
      kind: 'flat_task_review',
      taskId: task.id,
      taskSnapshotUpdatedAt: iso(task.updated),
      evidenceReceipt: flatEvidence.implementationReceiptHash,
      reportDigest: flatEvidence.reportDigest,
    }];
  }
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

  const fallbackReceipt = executionEvidence?.completedBy?.sessionKey
    || executionEvidence?.sessionRefs?.[executionEvidence.sessionRefs.length - 1] || task.notes;
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

/**
 * How many times the verdict owner rolls back and re-runs a verdict refused
 * ASSIGNMENT_REFERENCE_BUSY (card 0616c363). AccessVehicleService takes its
 * reference locks without waiting and never retries: a verdict that overlaps
 * another writer of a shared target (two Tasks of one assignee verified at the
 * same moment) is refused whole, and the transaction owner retries. Bounded, so
 * sustained contention still answers 409 and consumes no retry budget.
 */
export const VERDICT_REFERENCE_BUSY_RETRIES = 3;

export interface TaskReviewAttemptOptions {
  /** Waits after a rolled-back busy attempt (1-based) before the next one. */
  referenceBusyPause?: (attempt: number) => Promise<void>;
}

const jitteredReferenceBusyPause = (attempt: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, 15 * attempt + Math.floor(Math.random() * 35)));

const isReferenceBusy = (error: unknown): boolean =>
  error instanceof AssignmentAccessError && error.code === 'ASSIGNMENT_REFERENCE_BUSY';

export class TaskReviewAttemptService {
  constructor(
    private readonly pool: Pool = defaultPool,
    private readonly timeoutMs = 300000,
    private readonly options: TaskReviewAttemptOptions = {},
  ) {}

  async beginAttempt(task: Task, evidence: unknown, transaction?: PoolClient, nativeScope?: NativeReviewScope): Promise<ReviewAttemptIdentity> {
    const executionEvidence = evidence as Pick<import('./TaskManagerDB').ReviewHistoryEntry['evidence'], 'sessionRefs' | 'completedBy'> | undefined;
    const implementationReceiptHash = sha256(evidence);
    const reportDigest = evidence && typeof evidence === 'object' && 'reportDigest' in evidence
      ? (evidence as { reportDigest?: unknown }).reportDigest : undefined;
    const reviewSlice: ReviewAttemptIdentity['reviewSlice'] = nativeScope
      ? [{ kind: 'native_review', scope: nativeScope, subtaskDigest: reviewDigest(task.subtasks || []), reportDigest: String(reportDigest) }]
      : buildCanonicalReviewSlice(task, typeof reportDigest === 'string'
      ? { implementationReceiptHash, reportDigest } : undefined,
      evidence as Pick<import('./TaskManagerDB').ReviewHistoryEntry['evidence'], 'sessionRefs' | 'completedBy'>);
    const reviewSliceHash = sha256(reviewSlice);
    const reviewSliceVersion = nativeScope ? 3 : (task.subtasks || []).length === 0 ? 2 : 1;
    const snapshot = iso(task.updated);
    const client = transaction ?? await this.pool.connect();
    try {
      if (!transaction) await client.query('BEGIN');
      const locked = await client.query('SELECT status, updated_at, attempt_count, max_retries FROM tasks WHERE id=$1 FOR UPDATE', [task.id]);
      if (!locked.rowCount) throw new NotFoundFault(`Task not found: ${task.id}`, 'TASK_NOT_FOUND');
      if (locked.rows[0].status !== 'review') throw new ConflictFault(`Task is not currently in review (status=${locked.rows[0].status})`);
      if (iso(locked.rows[0].updated_at) !== snapshot) throw new ConflictFault('Task snapshot changed before review attempt');

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
        if (!transaction) await client.query('COMMIT');
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
         ) VALUES ($1,$2,'running',$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11,NOW(),NOW()+($12*INTERVAL '1 millisecond'))
         ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
         RETURNING id, attempt_no, idempotency_key, review_slice, status`,
        [task.id, attemptNo, snapshot, reviewSliceVersion, reviewSliceHash, JSON.stringify(reviewSlice), implementationReceiptHash,
          executionEvidence?.completedBy?.sessionKey
            || executionEvidence?.sessionRefs?.[executionEvidence.sessionRefs.length - 1] || null,
          task.notes?.match(/\b[0-9a-f]{40}\b/i)?.[0] || null, JSON.stringify(evidence || {}), idempotencyKey, this.timeoutMs],
      );
      if (!transaction) await client.query('COMMIT');
      return {
        id: result.rows[0].id,
        attemptNo: result.rows[0].attempt_no,
        idempotencyKey: result.rows[0].idempotency_key,
        reviewSlice: result.rows[0].review_slice,
        status: result.rows[0].status,
      };
    } catch (error) {
      if (!transaction) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (!transaction) client.release();
    }
  }

  async recordVerdict(
    attemptId: string,
    decision: ReviewAttemptDecision,
    findings: unknown,
    verdict: unknown,
    reviewerSessionKey?: string,
    incrementAttempt = decision === 'reject',
    transaction?: PoolClient,
    // Card 5854f0d6, round 2: the principal who rendered the verdict (a
    // person's rejection, a native reviewer); absent = the board's own verdict.
    feedActor?: FeedActorRef,
  ): Promise<{ status: string; attemptCount: number; applied: boolean }> {
    // A supplied transaction belongs to its caller, which rolls back and
    // retries (AccessVehicleService's contract). Without one this service opens
    // the transaction, so it is the owner: each busy attempt has already rolled
    // back and released its connection before the next one starts afresh.
    if (transaction) {
      return this.applyVerdict(attemptId, decision, findings, verdict, reviewerSessionKey, incrementAttempt, transaction, feedActor);
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.applyVerdict(attemptId, decision, findings, verdict, reviewerSessionKey, incrementAttempt, undefined, feedActor);
      } catch (error) {
        if (!isReferenceBusy(error) || attempt > VERDICT_REFERENCE_BUSY_RETRIES) throw error;
        await (this.options.referenceBusyPause ?? jitteredReferenceBusyPause)(attempt);
      }
    }
  }

  private async applyVerdict(
    attemptId: string,
    decision: ReviewAttemptDecision,
    findings: unknown,
    verdict: unknown,
    reviewerSessionKey: string | undefined,
    incrementAttempt: boolean,
    transaction?: PoolClient,
    feedActor?: FeedActorRef,
  ): Promise<{ status: string; attemptCount: number; applied: boolean }> {
    const client: PoolClient = transaction ?? await this.pool.connect();
    try {
      if (!transaction) await client.query('BEGIN');
      const result = await client.query(
        `SELECT a.*, t.status AS task_status, t.attempt_count, t.max_retries, t.updated_at AS current_task_updated_at
           FROM task_review_attempts a JOIN tasks t ON t.id=a.task_id
          WHERE a.id=$1 FOR UPDATE OF a,t`, [attemptId]);
      if (!result.rowCount) throw new NotFoundFault(`Review attempt not found: ${attemptId}`, 'REVIEW_ATTEMPT_NOT_FOUND');
      const row = result.rows[0];
      if (row.status !== 'running') {
        if (!transaction) await client.query('COMMIT');
        return { status: row.task_status, attemptCount: row.attempt_count, applied: false };
      }
      if (row.task_status !== 'review') throw new ConflictFault(`Task advanced before verdict (status=${row.task_status})`);
      if (iso(row.current_task_updated_at) !== iso(row.task_snapshot_updated_at)) {
        throw new ConflictFault('Task snapshot changed before Verifier verdict');
      }
      const nativeReview = Number(row.review_slice_version) === 3;
      const nativeMarker = nativeReview ? (row.review_slice as NativeTaskSlice[])[0] : undefined;
      if (nativeReview) {
        const barrier = await client.query('SELECT pg_try_advisory_xact_lock(1397653301,hashtext($1::text)) AS acquired', [row.task_id]);
        if (!barrier.rows[0]?.acquired) throw new ConflictFault('Task review evidence is busy');
        const { taskManagerDB } = await import('./TaskManagerDB');
        const current = await taskManagerDB.getTask(row.task_id, client);
        if (!current || row.review_slice.length !== 1 || nativeMarker?.kind !== 'native_review'
          || reviewDigest(current.subtasks || []) !== nativeMarker.subtaskDigest) throw new ConflictFault('Native review subtask snapshot changed');
        const reports = await client.query(NATIVE_REVIEW_INPUT_REPORTS_SQL, [row.task_id]);
        if (hashReviewReports(reports.rows) !== nativeMarker.reportDigest) throw new ConflictFault('Native review Report evidence changed');
        const selected = current.subtasks.filter(s => nativeMarker.scope.subtaskIds.includes(String(s.id)));
        if (selected.length !== nativeMarker.scope.subtaskIds.length || selected.some(s => s.status !== 'review')
          || (nativeMarker.scope.kind === 'task_final' && current.subtasks.some(s => !['completed','skipped'].includes(s.status)))) throw new ConflictFault('Native review scope changed');
      }
      const flatReview = Number(row.review_slice_version) === 2;
      if (flatReview) {
        // Report writers use this same transaction-scoped, no-wait barrier.
        // Acquiring it after the Task lock cannot create a Report-row/Task-row
        // wait cycle: a conflicting writer or verdict refuses immediately.
        const barrier = await client.query(
          'SELECT pg_try_advisory_xact_lock(1397653301, hashtext($1::text)) AS acquired', [row.task_id]);
        if (!barrier.rows[0]?.acquired) throw new ConflictFault('Flat Task review evidence is busy');
        const slice = row.review_slice as FlatTaskSlice[];
        const marker = slice[0];
        if (slice.length !== 1 || marker?.kind !== 'flat_task_review'
          || marker.taskId !== row.task_id
          || iso(marker.taskSnapshotUpdatedAt) !== iso(row.task_snapshot_updated_at)
          || marker.evidenceReceipt !== row.implementation_receipt_hash) {
          throw new Error('Flat Task review snapshot is invalid');
        }
        const reports = await client.query(
          `SELECT id, title, summary, content FROM reports
             WHERE $1::uuid = ANY(task_ids) AND deleted_at IS NULL ORDER BY id`, [row.task_id]);
        if (hashReviewReports(reports.rows) !== marker.reportDigest) {
          throw new ConflictFault('Linked Report evidence changed before Verifier verdict');
        }
        const subtasks = await client.query('SELECT id FROM subtasks WHERE task_id=$1 LIMIT 1 FOR UPDATE', [row.task_id]);
        if (subtasks.rowCount) throw new ConflictFault('Flat Task gained a subtask before Verifier verdict');
      } else if (!nativeReview && Number(row.review_slice_version) !== 1) {
        throw new Error('Unsupported review slice version');
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
      const disposition = finalDecision === 'pass' ? 'completed' : finalDecision === 'reject' ? 'empty' : 'stuck';
      const verdictSummary = verdict && typeof verdict === 'object' && typeof (verdict as { summary?: unknown }).summary === 'string'
        ? String((verdict as { summary: string }).summary)
        : `Verifier ${finalDecision}`;
      if (!flatReview && (!nativeReview || nativeMarker!.scope.subtaskIds.length)) {
        const indexes = nativeReview
          ? (await client.query('SELECT index FROM subtasks WHERE task_id=$1 AND id::text=ANY($2::text[]) ORDER BY index', [row.task_id, nativeMarker!.scope.subtaskIds])).rows.map(s => s.index)
          : (row.review_slice as ReviewedSubtaskSlice[]).map((item) => item.index);
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
          throw new ConflictFault('Immutable review slice changed before Verifier verdict');
        }
      }
      if (finalDecision === 'pass') {
        if (nativeReview) nextStatus = nativeMarker!.scope.includesTaskCriteria ? 'completed' : 'todo';
        else if (flatReview) nextStatus = 'completed';
        else {
          const statuses = await client.query('SELECT status FROM subtasks WHERE task_id=$1 ORDER BY index', [row.task_id]);
          nextStatus = statuses.rows.every((item) => item.status === 'completed' || item.status === 'skipped')
            ? 'completed'
            : 'todo';
        }
      }
      const applied = await client.query(
        `UPDATE tasks SET status=$2, attempt_count=$3, needs_review=$4,
          completed_at=CASE WHEN $2::varchar='completed' THEN NOW() ELSE NULL END, updated_at=NOW()
          WHERE id=$1 AND status='review'
          RETURNING project_id, owner_principal_id`,
        [row.task_id, nextStatus, attemptCount, finalDecision === 'escalate']);
      // RH-P3.C1 (round 2, F2): verdict application is a Task write every
      // consumer can observe; it and its feed event commit together.
      await feedEventService.emit(client, {
        name: 'task.updated',
        objectType: 'task',
        objectId: row.task_id,
        // Card 5854f0d6: who rendered the verdict; a board-applied verdict
        // (no feedActor) shows as "RelayHall".
        actorPrincipalId: feedActor?.principalId ?? null, actorHandle: feedActor?.handle ?? null,
        projectId: applied.rows[0]?.project_id ?? null,
        ownerPrincipalId: applied.rows[0]?.owner_principal_id ?? null,
        // Card 5854f0d6: the field name.
        payload: { status: nextStatus, previousStatus: 'review', fields: ['status'] },
      });
      // RH-P3.C2 (pre-review F3): a passing verdict with incomplete subtasks
      // returns the task to 'todo' — a transition INTO the ready state that
      // no other hook observes. Completing it instead can unblock dependents.
      await syncTaskReadiness(client, row.task_id, null);
      if (nextStatus === 'completed') {
        // This is the authoritative review -> terminal write (flat, subtask
        // and native). A later updateTask sees an already-completed Task, so
        // reap here, under the locked Task and in the verdict transaction.
        // Reuse the provenance/refcount guards; never remove owner grants.
        await accessVehicleService.detach(client, row.task_id,
          { handle: 'system', authMethod: 'system' },
          'AZ-S7: the task reached a terminal status');
        // AZ-A9 clause 12a (ratified 2026-10-10 (E43), card 785e1eed; E15):
        // the second terminal writer reaps request-made grants and credentials
        // exactly as updateTask does — the same function, in the verdict
        // transaction, after the detach.
        await reapAccessRequestsAtTerminal(client, {
          type: 'task', id: String(row.task_id), to: 'completed', via: 'recordVerdict',
        }, { handle: 'system', authMethod: 'system' });
        await syncDependentsReadiness(client, row.task_id, null);
      }
      if (!transaction) await client.query('COMMIT');
      return { status: nextStatus, attemptCount, applied: true };
    } catch (error) {
      if (!transaction) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (!transaction) client.release();
    }
  }
}

export const taskReviewAttemptService = new TaskReviewAttemptService();
