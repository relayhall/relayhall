/**
 * TelemetryService — RH-P3.C7: presence/telemetry ingest and the liveness
 * and stuck-task derivations (strategy 4e40f06f §2.6.5, the C5/F11 trim).
 *
 * The three ratified rules, in code:
 *  - ZERO SERVER-SIDE EFFECT: ingest writes telemetry_frames and nothing
 *    else — no task writes, no lease renewal (that is ONLY the explicit
 *    claim-renew operation), no feed emission. Telemetry is displayed,
 *    never authority.
 *  - DERIVED, NEVER PUSHED: 'stale' liveness and `task.stuck` come from the
 *    board's own clock — frame age, lease expiry, status staleness. Frame
 *    CONTENTS never trigger anything.
 *  - SHORT RETENTION, RATE- AND SIZE-LIMITED: frames expire after
 *    TELEMETRY_RETENTION_HOURS and are pruned opportunistically at ingest;
 *    per-principal minimum frame interval; payload byte cap. The Report
 *    remains the durable record.
 */
import { Pool } from 'pg';
import { pool as defaultPool } from '../db/connection';
import { feedEventService } from './FeedEventService';
import { notificationEndpointService } from './NotificationEndpointService';
import { logCaughtWarning } from '../utils/secretSafeLog';
import {
  telemetryRateLimitService, TELEMETRY_MIN_INTERVAL_MS,
  TELEMETRY_GATE_CTE, gateParams,
  type TelemetryRateLimitService,
} from './TelemetryRateLimitService';

export const TELEMETRY_FRAME_KINDS = ['heartbeat', 'status'] as const;
export type TelemetryFrameKind = (typeof TELEMETRY_FRAME_KINDS)[number];

/** Coarse pushed statuses — existing canonical liveness words only (C5/F11
 * trim). 'stale' is derived from frame age and can never be pushed. */
export const TELEMETRY_COARSE_STATUSES = ['active', 'idle'] as const;
export type TelemetryCoarseStatus = (typeof TELEMETRY_COARSE_STATUSES)[number];

export const TELEMETRY_MAX_PAYLOAD_BYTES = 4096;
/**
 * Per-principal minimum interval between accepted frames.
 *
 * The VALUE is the ratified C7 one and is unchanged. What changed is where the
 * counter lives: `TelemetryRateLimitService` now decides each attempt with one
 * conditional upsert against the database, so the limit is DEPLOYMENT-WIDE
 * instead of per-process (owner decision D6; hardening 329dba46, whose DoD
 * design 7d5c0cdc Appendix C imports into TW1a verbatim). Re-exported from the
 * limiter so there is exactly one number.
 */
export const TELEMETRY_MIN_FRAME_INTERVAL_MS = TELEMETRY_MIN_INTERVAL_MS.frames;
export const TELEMETRY_RETENTION_HOURS = 24;
/** A frame older than this no longer proves liveness — the state derives to
 * 'stale'. Aligned with the canonical runtime signal's stale window. */
export const TELEMETRY_STALE_MS = 9 * 60_000;
/** Status staleness that marks an in-progress Task stuck (the
 * heartbeating-but-dead backstop) — board-clock minutes since the Task's own
 * last recorded change. */
export const TASK_STUCK_STALE_MINUTES = 30;

/**
 * THE QUALIFYING-ACTIVITY CLOCK of the stuck sweep, as ONE SQL expression over
 * the Task row aliased `task` (review 79261f77, B2): the latest of the Task's
 * status-bearing feed events (with started_at/created_at as the pre-feed
 * fallback) and linked-Report activity through the ratified two-arm linkage
 * (task_ids containment OR a task_references 'report' row).
 *
 * Exported (card 5854f0d6, Notifications and Timeline design section 3.1 and
 * R2-N4): the "Needs your action" Stuck kind reads THIS expression, so an
 * episode is open there exactly when the sweep counts it open, and a Task
 * re-armed by a new linked Report leaves the list. Never re-typed.
 */
export function stuckActivityAtSql(task: string): string {
  return `GREATEST(
                  COALESCE((SELECT max(fe.occurred_at)
                     FROM feed_events fe
                    WHERE fe.object_type = 'task' AND fe.object_id = ${task}.id
                      AND fe.name IN ('task.created', 'task.updated')
                      AND fe.payload ? 'status'), ${task}.started_at, ${task}.created_at),
                  COALESCE((SELECT max(GREATEST(r.created_at, COALESCE(r.updated_at, r.created_at)))
                     FROM reports r
                    WHERE r.deleted_at IS NULL
                      AND (
                        EXISTS (SELECT 1 FROM unnest(r.task_ids) AS linked(task_id)
                                 WHERE linked.task_id::uuid = ${task}.id)
                        OR EXISTS (SELECT 1 FROM task_references tr
                                    WHERE tr.task_id = ${task}.id AND tr.kind = 'report'
                                      AND tr.target_id = r.id)
                      )), '-infinity'::timestamptz)
                )`;
}

/**
 * Episode dedup against the SAME clock: a `task.stuck` row at or after
 * `activityAt` means the episode of Task `taskId` is announced (and, for the
 * action list, still open). Exported with the clock for the same reason.
 */
export function stuckEpisodeAnnouncedSql(taskId: string, activityAt: string): string {
  return `EXISTS (
          SELECT 1 FROM feed_events fe
           WHERE fe.name = 'task.stuck'
             AND fe.object_type = 'task'
             AND fe.object_id = ${taskId}
             AND fe.occurred_at >= ${activityAt}
        )`;
}

export interface TelemetryFrameInput {
  kind: TelemetryFrameKind;
  status?: TelemetryCoarseStatus | null;
  taskId?: string | null;
  payload?: Record<string, unknown>;
}

export type TelemetryIngestOutcome =
  | { accepted: true; receivedAt: string }
  | { accepted: false; code: 'RATE_LIMITED' | 'PAYLOAD_TOO_LARGE' | 'TASK_NOT_FOUND' };

export interface TelemetryLiveness {
  state: 'active' | 'idle' | 'stale';
  kind: TelemetryFrameKind;
  receivedAt: string;
}

/**
 * Pure stuckness derivation — exported so the property is testable without a
 * database. The board watches its clock, never agent internals:
 *  - `lease` is the Task's ONE AUTHORITATIVE lease — the newest
 *    active/expired row (the SQL's LATERAL picks it): a current unexpired
 *    active lease WINS over any retained historical expired rows, so
 *    recovered work is never falsely marked stuck (review 79261f77, B1).
 *  - `activityAt` is the last QUALIFYING activity — the latest status
 *    transition (the feed's own status-bearing task events) or linked-Report
 *    activity through the ratified two-arm linkage. Generic Task metadata
 *    edits are NOT qualifying activity, and a fresh handover Report defers
 *    staleness exactly as the contract's "no status transition or report
 *    activity" wording requires (review 79261f77, B2).
 */
export function deriveStuckReason(
  now: Date,
  task: { status: string; activityAt: Date },
  lease: { status: string; expiresAt: Date } | null,
  staleMinutes = TASK_STUCK_STALE_MINUTES,
): 'lease_expired' | 'status_stale' | null {
  if (task.status !== 'in-progress') return null;
  if (lease) {
    if (lease.status === 'active' && lease.expiresAt.getTime() > now.getTime()) {
      // A live, unexpired lease proves a claimant is holding the work: not
      // stuck by the lease arm — and not by staleness either? No: the
      // heartbeating-but-dead backstop applies exactly here, so staleness
      // still runs below.
    } else {
      return 'lease_expired';
    }
  }
  if (now.getTime() - task.activityAt.getTime() >= staleMinutes * 60_000) {
    return 'status_stale';
  }
  return null;
}

export class TelemetryService {
  private lastPruneAt = 0;

  constructor(
    private readonly pool: Pool = defaultPool,
    /**
     * D6: the interval gate is DEPLOYMENT-WIDE and lives in the database. The
     * `private lastAcceptedAt = new Map<string, number>()` that used to sit
     * here was per-process — two workers each accepted a frame in the same
     * interval — and was never evicted. It is REMOVED, not bounded: a bounded
     * per-process map is still per-process.
     */
    private readonly rateLimits: TelemetryRateLimitService = telemetryRateLimitService,
  ) {}

  /**
   * Accept one frame from the authenticated principal. Writes ONLY
   * telemetry_frames (plus the opportunistic retention prune) — the
   * zero-server-side-effect rule is the point of this method's shape.
   */
  async ingest(principalId: string, frame: TelemetryFrameInput): Promise<TelemetryIngestOutcome> {
    const serialized = JSON.stringify(frame.payload ?? {});
    if (Buffer.byteLength(serialized, 'utf8') > TELEMETRY_MAX_PAYLOAD_BYTES) {
      return { accepted: false, code: 'PAYLOAD_TOO_LARGE' };
    }
    const now = Date.now();

    // D6 + reviews `29874574` F4 and `fc4829d2` R3-B1/R3-M2 — ONE STATEMENT.
    //
    // The gate and the frame write are a single data-modifying CTE, not a
    // transaction around two statements. That is the whole repair, and each
    // clause of it answers a rejected attempt:
    //
    //   - the gate must be DEPLOYMENT-WIDE, so it is a database upsert and not
    //     the per-process Map candidate A shipped (`329dba46`);
    //   - a frame that is NOT stored must not charge the interval, so the gate
    //     lives inside the same statement as the INSERT: a Task foreign-key
    //     failure aborts the whole statement and the gate's update goes with it
    //     (F4);
    //   - and nothing may hold a lock across a second connection, so there is
    //     no BEGIN here at all. `ON CONFLICT DO UPDATE` locks the conflicting
    //     row even when its WHERE is false; with the previous transaction that
    //     lock outlived the gate and the refusal counter — on another pooled
    //     connection — waited on it while the transaction waited to roll back
    //     (R3-B1, a hang on the ordinary rate-limited path). One statement
    //     releases everything as it returns, so the cycle cannot form.
    //
    // A refusal is therefore `rowCount === 0`: the CTE runs (a data-modifying
    // CTE always executes), its WHERE refuses, it returns no rows, and the
    // outer `INSERT ... SELECT ... FROM gate` writes nothing.
    // Task attribution (card b595b3b0) is decided in the SAME statement as the
    // interval gate. Every frame the gate admits is stored as before (the MCP
    // Task-link frames of card 35b73092 included), but only a frame from the
    // Task's current Assignee, while the Task is in progress, and - when the
    // Task names an assigned connector Service - from that Service's principal,
    // carries the server's assignment-epoch stamp. Task activity reads count
    // only stamped frames of the current epoch, so a reassignment (even away
    // and back) retires every earlier observation. The caller's own
    // `_taskAssignmentEpoch` is always removed: it cannot choose the stamp.
    // FOR SHARE makes a concurrent reassignment wait for this bounded write.
    let inserted;
    try {
      inserted = await this.pool.query(
        `WITH attributed_task AS MATERIALIZED (
           SELECT e.epoch::text AS epoch
             FROM tasks t JOIN task_native_assignment_epochs e ON e.task_id=t.id
             LEFT JOIN services s ON s.id=t.execution_service_id
            WHERE $5::uuid IS NOT NULL AND t.id=$5 AND t.owner_principal_id=$1
              AND t.status='in-progress'
              AND (t.execution_service_id IS NULL OR s.principal_id=$1)
            FOR SHARE OF t, e
         ), ${TELEMETRY_GATE_CTE}
         INSERT INTO telemetry_frames (principal_id, task_id, kind, status, payload)
         SELECT $1, $5, $6, $7,
           ($8::jsonb - '_taskAssignmentEpoch')
             || COALESCE((SELECT jsonb_build_object('_taskAssignmentEpoch', epoch) FROM attributed_task), '{}'::jsonb)
           FROM gate
         RETURNING received_at`,
        [
          ...gateParams(principalId, 'frames', new Date(now)),
          frame.taskId ?? null, frame.kind, frame.status ?? null, serialized,
        ],
      );
    } catch (err: any) {
      // 23503 = the optional Task FK: frames about unknown Tasks are refused
      // rather than stored as dangling observability. The statement aborted, so
      // the gate's update is gone and an immediate corrected retry is NOT
      // rate-limited for a frame that never landed.
      if (err?.code === '23503') return { accepted: false, code: 'TASK_NOT_FOUND' };
      throw err;
    }

    if ((inserted.rowCount ?? 0) === 0) {
      // The gate refused. Counting happens now, after the statement has ended
      // and released its lock — never during it (R3-B1).
      await this.rateLimits.countRefusal(principalId, 'frames', new Date(now));
      return { accepted: false, code: 'RATE_LIMITED' };
    }

    // Cleanup runs after the write, on the pool, holding nothing (R3-M2).
    await this.rateLimits.prune(new Date(now));
    await this.pruneExpired(now);
    return { accepted: true, receivedAt: String(inserted.rows[0]?.received_at ?? new Date(now).toISOString()) };
  }

  /** Retention: prune expired frames at most once a minute per process. */
  private async pruneExpired(now: number): Promise<void> {
    if (now - this.lastPruneAt < 60_000) return;
    this.lastPruneAt = now;
    try {
      await this.pool.query(
        `DELETE FROM telemetry_frames
          WHERE received_at < now() - ($1 * INTERVAL '1 hour')`,
        [TELEMETRY_RETENTION_HOURS],
      );
    } catch (err) {
      logCaughtWarning('[TelemetryService] retention prune failed:', err);
    }
  }

  /**
   * The liveness the RH-UI.9 chip renders: the Task's freshest frame,
   * derived against the board clock — a fresh status frame IS its coarse
   * status, a fresh heartbeat proves 'active', an old frame derives 'stale'.
   * No frames → null (callers fall back to the canonical runtime signal).
   */
  async livenessForTask(taskId: string): Promise<TelemetryLiveness | null> {
    const result = await this.pool.query(
      `SELECT kind, status, received_at
         FROM telemetry_frames
        WHERE task_id = $1
        ORDER BY received_at DESC, id DESC
        LIMIT 1`,
      [taskId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const age = Date.now() - new Date(row.received_at).getTime();
    const state: TelemetryLiveness['state'] = age >= TELEMETRY_STALE_MS
      ? 'stale'
      : (row.kind === 'status' && row.status === 'idle' ? 'idle' : 'active');
    return { state, kind: row.kind, receivedAt: new Date(row.received_at).toISOString() };
  }

  /** Task activity for the board and Task details (card b595b3b0). The caller
   * supplies only ids narrowed by Task read authorization. One query, no
   * canonical-session fallback, no lifecycle inference and no per-card
   * fan-out: no stamped frame of the current assignment means 'unknown'. */
  async activityForTasks(taskIds: string[]): Promise<Array<{
    taskId: string; state: 'active' | 'idle' | 'stale' | 'unknown';
    receivedAt: string | null; kind: TelemetryFrameKind | null;
  }>> {
    if (taskIds.length === 0) return [];
    if (taskIds.length > 100) throw new Error('Activity read exceeds bounded task set');
    const result = await this.pool.query(
      `SELECT DISTINCT ON (f.task_id) f.task_id, f.kind, f.status, f.received_at
         FROM telemetry_frames f JOIN tasks t ON t.id=f.task_id
         JOIN task_native_assignment_epochs e ON e.task_id=t.id
         LEFT JOIN services s ON s.id=t.execution_service_id
        WHERE f.task_id=ANY($1::uuid[]) AND t.status='in-progress'
          AND f.principal_id=t.owner_principal_id
          AND (t.execution_service_id IS NULL OR s.principal_id=f.principal_id)
          AND f.payload->>'_taskAssignmentEpoch'=e.epoch::text
        ORDER BY f.task_id, f.received_at DESC, f.id DESC`, [taskIds],
    );
    const rows = new Map(result.rows.map(row => [String(row.task_id), row]));
    const now = Date.now();
    return taskIds.map(taskId => {
      const row = rows.get(taskId);
      if (!row) return { taskId, state: 'unknown', receivedAt: null, kind: null };
      const receivedAt = new Date(row.received_at).toISOString();
      return { taskId, receivedAt, kind: row.kind,
        state: now - Date.parse(receivedAt) >= TELEMETRY_STALE_MS ? 'stale'
          : row.kind === 'status' && row.status === 'idle' ? 'idle' : 'active' };
    });
  }

  /**
   * The `task.stuck` sweep: derive stuckness for every in-progress Task from
   * lease expiry or status staleness (board clock only), and announce each
   * NEW episode once into the cursor feed.
   *
   * ONE ROW PER TASK (review 79261f77, B1): the lease LATERAL picks the
   * single newest active/expired lease, so retained historical expired rows
   * can neither override a current renewed lease nor multiply emissions.
   *
   * THE QUALIFYING-ACTIVITY CLOCK (review 79261f77, B2): `activity_at` is
   * the latest of (a) the Task's status-bearing feed events — the C1 feed
   * records every status transition with a `status` payload key, so the
   * feed's own occurred_at IS the board-owned status-transition timestamp —
   * and (b) linked-Report activity through the ratified two-arm linkage
   * (task_ids containment OR a task_references 'report' row), with
   * started_at/created_at as the pre-feed fallback. Generic Task metadata
   * edits do not qualify. Dedup is episode-scoped against the SAME clock: a
   * task.stuck row at-or-after activity_at means this episode is announced;
   * any new qualifying activity re-arms it. Emission rides its own
   * transaction per Task.
   */
  async sweepStuckTasks(now: Date = new Date()): Promise<number> {
    const candidates = await this.pool.query(
      `WITH candidates AS (
         SELECT t.id, t.title, t.status, t.project_id, t.owner_principal_id,
                ${stuckActivityAtSql('t')} AS activity_at,
                lease.status AS lease_status,
                lease.expires_at AS lease_expires_at
           FROM tasks t
           LEFT JOIN LATERAL (
             SELECT l.status, l.expires_at
               FROM task_execution_leases l
              WHERE l.task_id = t.id AND l.status IN ('active', 'expired')
              ORDER BY l.acquired_at DESC, l.id DESC
              LIMIT 1
           ) lease ON TRUE
          WHERE t.status = 'in-progress'
       )
       SELECT * FROM candidates c
        WHERE NOT ${stuckEpisodeAnnouncedSql('c.id', 'c.activity_at')}`,
    );

    let emitted = 0;
    for (const row of candidates.rows) {
      const reason = deriveStuckReason(
        now,
        { status: String(row.status), activityAt: new Date(row.activity_at) },
        row.lease_status
          ? { status: String(row.lease_status), expiresAt: new Date(row.lease_expires_at) }
          : null,
      );
      if (!reason) continue;
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await feedEventService.emit(client, {
          name: 'task.stuck',
          objectType: 'task',
          objectId: String(row.id),
          projectId: row.project_id ?? null,
          ownerPrincipalId: row.owner_principal_id ?? null,
          // Coarse derivation reason only — never frame content.
          payload: { reason },
        });
        await client.query('COMMIT');
        emitted += 1;
        // RH-P3.C8 (§2.12): the announced exception also reaches the human
        // path. The UI reads the feed row itself (the notification history
        // and the "Needs your action" Stuck kind, addressed to the shepherd,
        // else the creator, else the Assignee); the legacy file writer is
        // gone (card 5854f0d6, choice C10). Enabled webhook endpoints are
        // post-commit, ID-only, best-effort and loop-guarded: the feed row is
        // the record, and a dispatch failure never un-announces it.
        try {
          await notificationEndpointService.dispatchException({
            name: 'task.stuck',
            objectType: 'task',
            objectId: String(row.id),
            reason,
            occurredAt: now.toISOString(),
          });
        } catch (err) {
          logCaughtWarning('[TelemetryService] exception dispatch failed:', err);
        }
      } catch (err) {
        await client.query('ROLLBACK');
        logCaughtWarning('[TelemetryService] task.stuck emission failed:', err);
      } finally {
        client.release();
      }
    }
    return emitted;
  }
}

export const telemetryService = new TelemetryService();
