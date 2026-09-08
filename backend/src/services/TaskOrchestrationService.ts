import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../db/connection';
import { feedEventService } from './FeedEventService';
import { syncTaskReadiness } from '../utils/taskReadiness';

export type LeaseHarness = 'hermes' | 'openclaw';

export interface ClaimTaskInput {
  taskId: string;
  snapshotUpdatedAt: string;
  harness: LeaseHarness;
  resourceKey: string;
  sessionKey?: string;
  ttlSeconds?: number;
  metadata?: Record<string, unknown>;
  /**
   * RH-P3.C3: the identity doing the claiming, so the ratified
   * claimant-is-not-verifier refusal can be applied on THIS plane too
   * (strategy 4e40f06f §2.6.4, RATIFIED 2026-08-02 — C4).
   *
   * Optional because the scheduler primitive predates principals and a
   * system-initiated claim genuinely has no acting identity. A caller that
   * HAS one and drops it does not weaken the refusal for anyone else: the
   * check is identity equality against the Task's own Verifier, so a
   * missing identity can never equal a set Verifier. The route always
   * passes what it resolved.
   */
  claimantPrincipalId?: string | null;
}

export interface TaskExecutionLease {
  id: string;
  taskId: string;
  resourceKey: string;
  harness: LeaseHarness;
  sessionKey?: string;
  status: 'active' | 'released' | 'expired' | 'failed';
  acquiredAt: string;
  expiresAt: string;
}

export interface ClaimTaskResult {
  lease: TaskExecutionLease;
  acquired: boolean;
}

/**
 * The claim/lease surface is ALWAYS ON (card 590c638a, ruling 1). The two
 * bounds are an optional estate-wide policy: `null` means no bound is
 * checked at all - no count query, no advisory lock.
 */
export interface OrchestrationLimits {
  maxActiveGlobal: number | null;
  maxActivePerProject: number | null;
  leaseTtlSeconds: number;
}

/**
 * What the process is ACTUALLY running with - read back from the configured
 * service, never re-parsed from the environment, so a caller of
 * GET /health/orchestration sees the value that reached the claim path
 * (card 590c638a, ruling 4: the reachability check).
 */
export interface EffectiveOrchestrationConfiguration {
  claimSurface: 'always-on';
  maxActiveGlobal: number | 'unlimited';
  maxActivePerProject: number | 'unlimited';
  leaseTtlSeconds: number;
}

export class OrchestrationConflictError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
  }
}

function mapLease(row: any): TaskExecutionLease {
  return {
    id: row.id,
    taskId: row.task_id,
    resourceKey: row.resource_key,
    harness: row.harness,
    sessionKey: row.session_key || undefined,
    status: row.status,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  };
}

function sameTimestamp(left: unknown, right: unknown): boolean {
  const iso = (value: unknown): string => value instanceof Date
    ? value.toISOString()
    : new Date(String(value)).toISOString();
  return iso(left) === iso(right);
}

export class TaskOrchestrationService {
  private limits: OrchestrationLimits;

  constructor(
    private readonly pool: Pool = defaultPool,
    limits: Partial<OrchestrationLimits> = {},
  ) {
    this.limits = {
      maxActiveGlobal: limits.maxActiveGlobal ?? null,
      maxActivePerProject: limits.maxActivePerProject ?? null,
      leaseTtlSeconds: limits.leaseTtlSeconds ?? 900,
    };
  }

  configure(limits: OrchestrationLimits): void {
    if (limits.maxActiveGlobal !== null && (!Number.isInteger(limits.maxActiveGlobal) || limits.maxActiveGlobal < 1)) {
      throw new Error('maxActiveGlobal must be null (unlimited) or a positive integer');
    }
    if (limits.maxActivePerProject !== null && (!Number.isInteger(limits.maxActivePerProject) || limits.maxActivePerProject < 1)) {
      throw new Error('maxActivePerProject must be null (unlimited) or a positive integer');
    }
    if (!Number.isInteger(limits.leaseTtlSeconds) || limits.leaseTtlSeconds < 30 || limits.leaseTtlSeconds > 3600) {
      throw new Error('leaseTtlSeconds must be an integer between 30 and 3600');
    }
    this.limits = { ...limits };
  }

  effectiveConfiguration(): EffectiveOrchestrationConfiguration {
    return {
      claimSurface: 'always-on',
      maxActiveGlobal: this.limits.maxActiveGlobal ?? 'unlimited',
      maxActivePerProject: this.limits.maxActivePerProject ?? 'unlimited',
      leaseTtlSeconds: this.limits.leaseTtlSeconds,
    };
  }

  async claimReadyTask(input: ClaimTaskInput): Promise<ClaimTaskResult> {
    const client = await this.pool.connect();
    const ttlSeconds = Math.max(30, Math.min(input.ttlSeconds ?? this.limits.leaseTtlSeconds, 3600));
    try {
      await client.query('BEGIN');
      await this.expireLeases(client);

      const taskResult = await client.query(
        `SELECT id, title, status, auto_start, updated_at, project_id,
                execution_mode, execution_profile, archive_disposition,
                verifier_principal_id
           FROM tasks
          WHERE id = $1
          FOR UPDATE`,
        [input.taskId],
      );
      if (!taskResult.rowCount) {
        throw new OrchestrationConflictError('Task not found', 'TASK_NOT_FOUND');
      }
      const task = taskResult.rows[0];

      // ── Never-self-review, on the scheduler plane (RH-P3.C3) ──
      //
      // Strategy 4e40f06f §2.6.4, RATIFIED 2026-08-02 (C4): "the server
      // refuses claimant == verifier". The principal-plane claim
      // (TaskManagerDB.claimTask) has carried this guard since RH-P2.5; this
      // plane never read `verifier_principal_id` at all, so the identical
      // act reached the identical Task and was allowed. One rule, two doors,
      // one of them open.
      //
      // The refusal is deliberately placed BEFORE the replay branch below.
      // The rule is stated unconditionally, and idempotency is a promise
      // about retrying a request that SUCCEEDED — a claim the server must
      // refuse never succeeded, so returning a lease for it would be
      // answering a refused request with a receipt. It also matters in the
      // one order that can actually produce this state: a Task claimed
      // first and given its Verifier afterwards. There the standing lease
      // exists and the Verifier equality is now true, and the refusal wins.
      //
      // Read from `tasks.verifier_principal_id` under the row lock already
      // taken above: the same column `task_assignments` mirrors (086) and
      // the shared predicate reads. No second source, no fixture.
      if (
        input.claimantPrincipalId
        && task.verifier_principal_id
        && String(task.verifier_principal_id) === String(input.claimantPrincipalId)
      ) {
        throw new OrchestrationConflictError(
          'The assigned Verifier cannot claim the same task',
          'CLAIMANT_VERIFIER_CONFLICT',
        );
      }

      // A retry of the exact successful request is idempotent even though the
      // first request has already moved the task to in-progress.
      const existingResult = await client.query(
        `SELECT *
           FROM task_execution_leases
          WHERE task_id = $1 AND status = 'active'
          FOR UPDATE`,
        [input.taskId],
      );
      if (existingResult.rowCount) {
        const existing = existingResult.rows[0];
        // Once this task has an active lease, matching task/resource/harness
        // callers are replays regardless of timestamp precision. They must not
        // acquire wake ownership; stale snapshots therefore remain fail-safe.
        if (
          existing.resource_key === input.resourceKey
          && existing.harness === input.harness
        ) {
          await client.query('COMMIT');
          return { lease: mapLease(existing), acquired: false };
        }
        throw new OrchestrationConflictError('Task already has a different active lease', 'ACTIVE_LEASE_CONFLICT');
      }

      if (task.status !== 'todo') {
        throw new OrchestrationConflictError(`Task is not claimable from status ${task.status}`, 'TASK_NOT_TODO');
      }
      if (!task.auto_start) {
        throw new OrchestrationConflictError('Task auto-start is disabled', 'AUTO_START_DISABLED');
      }
      if (!sameTimestamp(task.updated_at, input.snapshotUpdatedAt)) {
        throw new OrchestrationConflictError('Task snapshot changed before claim', 'STALE_TASK_SNAPSHOT');
      }

      const configuredHarness = task.execution_profile?.harness;
      if (configuredHarness && configuredHarness !== input.harness) {
        throw new OrchestrationConflictError(
          `Task requires ${configuredHarness} harness, not ${input.harness}`,
          'HARNESS_MISMATCH',
        );
      }

      // Lock every parent in stable UUID order. Scheduler pre-filtering is
      // advisory; this transaction is the authoritative dependency check.
      const dependencies = await client.query(
        `SELECT parent.id, parent.status, parent.archive_disposition
           FROM task_dependencies d
           JOIN tasks parent ON parent.id = d.depends_on_task_id
          WHERE d.task_id = $1
          ORDER BY parent.id
          FOR UPDATE OF parent`,
        [input.taskId],
      );
      const unmet = dependencies.rows.find((parent: any) => !(
        parent.status === 'completed'
        || (parent.status === 'archived' && parent.archive_disposition === 'completed')
      ));
      if (unmet) {
        throw new OrchestrationConflictError('Task has unmet dependencies', 'UNMET_DEPENDENCY');
      }

      // Capacity is a cross-task invariant. Row locks on the candidate task
      // cannot serialize claims for different tasks/resources, so two READ
      // COMMITTED transactions could otherwise both observe count=0 and
      // exceed the configured global/project budget. One transaction-scoped
      // advisory lock serializes the short capacity-check + lease-insert
      // section for every scheduler claimant without holding a session lock.
      // With no bound configured (the default) there is nothing to serialize:
      // no lock, no count - unlimited means unlimited, not "64".
      const boundConfigured = this.limits.maxActiveGlobal !== null || this.limits.maxActivePerProject !== null;
      if (boundConfigured) {
        await client.query('SELECT pg_advisory_xact_lock($1, $2)', [1129072962, 1]);
      }

      if (this.limits.maxActiveGlobal !== null) {
        const globalCount = await client.query(
          `SELECT COUNT(*)::int AS count
             FROM task_execution_leases
            WHERE status = 'active' AND expires_at > NOW()`,
        );
        if (Number(globalCount.rows[0]?.count || 0) >= this.limits.maxActiveGlobal) {
          throw new OrchestrationConflictError('Global active lease budget is exhausted', 'GLOBAL_CAPACITY_EXHAUSTED');
        }
      }

      if (this.limits.maxActivePerProject !== null && task.project_id) {
        const projectCount = await client.query(
          `SELECT COUNT(*)::int AS count
             FROM task_execution_leases lease
             JOIN tasks leased_task ON leased_task.id = lease.task_id
            WHERE lease.status = 'active' AND lease.expires_at > NOW()
              AND leased_task.project_id = $1`,
          [task.project_id],
        );
        if (Number(projectCount.rows[0]?.count || 0) >= this.limits.maxActivePerProject) {
          throw new OrchestrationConflictError('Project active lease budget is exhausted', 'PROJECT_CAPACITY_EXHAUSTED');
        }
      }

      const leaseResult = await client.query(
        `INSERT INTO task_execution_leases (
           task_id, resource_key, harness, session_key,
           claimed_task_updated_at, expires_at, metadata
         ) VALUES ($1, $2, $3, $4, $5, NOW() + ($6 * INTERVAL '1 second'), $7::jsonb)
         RETURNING *`,
        [
          input.taskId,
          input.resourceKey,
          input.harness,
          input.sessionKey || null,
          task.updated_at,
          ttlSeconds,
          JSON.stringify(input.metadata || {}),
        ],
      );

      // The task row has remained locked since the snapshot/dependency checks,
      // so status is the authoritative compare-and-set guard here. Do not
      // compare updated_at again: PostgreSQL may retain microseconds while the
      // node-postgres Date/API snapshot has millisecond precision, making an
      // unchanged row compare unequal.
      const moved = await client.query(
        `UPDATE tasks
            SET status = 'in-progress', started_at = COALESCE(started_at, NOW()),
                updated_at = NOW()
          WHERE id = $1 AND status = 'todo'
          RETURNING id, project_id, owner_principal_id`,
        [input.taskId],
      );
      if (!moved.rowCount) {
        throw new OrchestrationConflictError('Task changed during claim', 'CLAIM_COMPARE_AND_SET_FAILED');
      }
      // RH-P3.C2 (pre-review F3): this path moves the task OUT of the ready
      // state, so the announcement must be retracted here exactly as
      // TaskManagerDB.claimTask does — otherwise a task claimed through
      // orchestration and later released is never announced ready again,
      // permanently, while this very method would accept the claim.
      await syncTaskReadiness(client, input.taskId, null);
      // RH-P3.C1 (round 2, F2): the orchestration claim is a Task write
      // every consumer can observe; it and its feed event commit together.
      await feedEventService.emit(client, {
        name: 'task.updated',
        objectType: 'task',
        objectId: input.taskId,
        projectId: moved.rows[0].project_id ?? null,
        ownerPrincipalId: moved.rows[0].owner_principal_id ?? null,
        payload: { status: 'in-progress', previousStatus: 'todo' },
      });

      await client.query(
        `INSERT INTO task_history (task_id, event_type, old_value, new_value, note)
         VALUES ($1, 'orchestration.claimed', 'todo', 'in-progress', $2)`,
        [input.taskId, `lease=${leaseResult.rows[0].id} | harness=${input.harness} | resource=${input.resourceKey}`],
      );

      await client.query('COMMIT');
      return { lease: mapLease(leaseResult.rows[0]), acquired: true };
    } catch (error: any) {
      await client.query('ROLLBACK');
      if (error?.code === '23505') {
        throw new OrchestrationConflictError('Task or resource already has an active lease', 'ACTIVE_LEASE_CONFLICT');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async heartbeatLease(taskId: string, leaseId: string, sessionKey?: string, ttlSeconds = 900): Promise<TaskExecutionLease> {
    const boundedTtl = Math.max(30, Math.min(ttlSeconds, 3600));
    const result = await this.pool.query(
      `UPDATE task_execution_leases
          SET heartbeat_at = NOW(), expires_at = NOW() + ($2 * INTERVAL '1 second'),
              session_key = COALESCE($3, session_key)
        WHERE id = $1 AND task_id = $4 AND status = 'active' AND expires_at > NOW()
        RETURNING *`,
      [leaseId, boundedTtl, sessionKey || null, taskId],
    );
    if (!result.rowCount) {
      throw new OrchestrationConflictError('Active lease not found or expired', 'LEASE_NOT_ACTIVE');
    }
    return mapLease(result.rows[0]);
  }

  async releaseLease(taskId: string, leaseId: string, status: 'released' | 'failed' = 'released', failureReason?: string): Promise<TaskExecutionLease> {
    const result = await this.pool.query(
      `UPDATE task_execution_leases
          SET status = $2, released_at = COALESCE(released_at, NOW()), failure_reason = COALESCE($3, failure_reason)
        WHERE id = $1 AND task_id = $4 AND status = 'active'
        RETURNING *`,
      [leaseId, status, failureReason || null, taskId],
    );
    if (!result.rowCount) {
      const existing = await this.pool.query(
        `SELECT * FROM task_execution_leases WHERE id = $1 AND task_id = $2 AND status = $3`,
        [leaseId, taskId, status],
      );
      if (existing.rowCount) return mapLease(existing.rows[0]);
      throw new OrchestrationConflictError('Active lease not found', 'LEASE_NOT_ACTIVE');
    }
    return mapLease(result.rows[0]);
  }

  async expireActiveLeases(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE task_execution_leases
          SET status = 'expired', released_at = NOW()
        WHERE status = 'active' AND expires_at <= NOW()`,
    );
    return result.rowCount || 0;
  }

  private async expireLeases(client: PoolClient): Promise<void> {
    await client.query(
      `UPDATE task_execution_leases
          SET status = 'expired', released_at = NOW()
        WHERE status = 'active' AND expires_at <= NOW()`,
    );
  }
}

export const taskOrchestrationService = new TaskOrchestrationService();
