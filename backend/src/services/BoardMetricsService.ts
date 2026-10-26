import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../db/connection';
import type { DelegationActorLink } from './AuthorizationService';
import { logCaughtFailure } from '../utils/secretSafeLog';

/**
 * Board metrics for the plugin bridge (card e220be94, owner ruling E353).
 *
 * The core reports two numbers about the CALLER'S OWN Account's board work,
 * computed from the board's own rows on every bridge read:
 *
 *   queue       Tasks waiting for the Account: Tasks whose effective Account
 *               owner is the caller's Account, in status `todo` and ARMED
 *               (`auto_start`). Unarmed `todo` Tasks are parked, not waiting
 *               (the claim path refuses them, TaskOrchestrationService), and
 *               every other status is not waiting: `ideas` is not work yet,
 *               `in-progress` is being worked, `review` is handed back,
 *               `stuck` is held, `completed` and `archived` are over.
 *               Dependencies are NOT consulted: an armed Task behind an
 *               unfinished dependency is still waiting in the queue.
 *   throughput  handbacks per hour: `handover.finish` Task stream entries (the
 *               entry POST /tasks/{id}/finish writes in the same transaction
 *               that moves the Task into Review) on Tasks whose effective
 *               Account owner is the caller's Account, in the rolling hour
 *               before the read. Reported as jobs/minute over a 3600 s window
 *               (value = handbacks / 60), with the integer `count` beside it.
 *
 * The effective Account owner is the board's one ownership predicate,
 * COALESCE(t.account_owner_principal_id, p.owner_principal_id), the same
 * expression AccountControlService and the authorization repository use. A
 * Group-owned Task belongs to no person's Account and is never counted.
 *
 * Never global: both statements bind the caller's Account and nothing else.
 * Never zero for unknown: a statement that fails or overruns its budget, or a
 * caller whose delegated object reach is narrower than its Account, yields
 * `status: 'unknown'` with `value: null` and a reason.
 */
export const BOARD_METRICS_SCHEMA = 'rh.plugin.board-metrics/1' as const;
/** The bridge freshness rule shared with rh.plugin.metrics/1 (stale after 90 s). */
export const BOARD_METRICS_FRESHNESS_SECONDS = 90;
export const THROUGHPUT_WINDOW_SECONDS = 3600;
export const BOARD_METRICS_STATEMENT_TIMEOUT = '2s';

export const QUEUE_SQL = `SELECT COUNT(*) AS value,
    EXTRACT(EPOCH FROM transaction_timestamp()) * 1000 AS observed_ms
  FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
  WHERE t.status = 'todo' AND t.auto_start IS TRUE
    AND COALESCE(t.account_owner_principal_id, p.owner_principal_id) = $1`;

export const THROUGHPUT_SQL = `SELECT COUNT(*) AS value,
    EXTRACT(EPOCH FROM transaction_timestamp()) * 1000 AS observed_ms
  FROM task_stream_entries e JOIN tasks t ON t.id = e.task_id LEFT JOIN projects p ON p.id = t.project_id
  WHERE e.event_type = 'handover.finish'
    AND e.created_at > transaction_timestamp() - make_interval(secs => $2)
    AND e.created_at <= transaction_timestamp()
    AND COALESCE(t.account_owner_principal_id, p.owner_principal_id) = $1`;

export type UnknownReason = 'unavailable' | 'caller-reach';
export interface MetricSource { kind: 'core'; producer: 'board' }
const SOURCE: MetricSource = { kind: 'core', producer: 'board' };

export type QueueMetric =
  | { status: 'reported'; value: number; unit: 'jobs'; observedAt: string; stale: boolean; source: MetricSource }
  | { status: 'unknown'; value: null; unit: 'jobs'; reason: UnknownReason; source: MetricSource };
export type ThroughputMetric =
  | { status: 'reported'; value: number; unit: 'jobs/minute'; windowSeconds: number; count: number;
      observedAt: string; stale: boolean; source: MetricSource }
  | { status: 'unknown'; value: null; unit: 'jobs/minute'; windowSeconds: number; reason: UnknownReason; source: MetricSource };
export interface BoardMetrics {
  schemaVersion: typeof BOARD_METRICS_SCHEMA;
  /** The earliest observation among the reported metrics; null when none was measured. */
  observedAt: string | null;
  stale: boolean;
  freshnessSeconds: number;
  source: MetricSource;
  queue: QueueMetric;
  throughput: ThroughputMetric;
}

/** One measured count, or the reason there is none. */
export type Measured = { count: number; observedAtMs: number } | { unknown: UnknownReason };

function exactCount(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('INVALID_BOARD_METRICS_COUNT');
  return n;
}
const isStale = (observedAtMs: number, nowMs: number) => nowMs - observedAtMs > BOARD_METRICS_FRESHNESS_SECONDS * 1000;

/** Shapes two measurements into the bridge field. Unknown is never a number. */
export function shapeBoardMetrics(queue: Measured, throughput: Measured, nowMs = Date.now()): BoardMetrics {
  const q: QueueMetric = 'unknown' in queue
    ? { status: 'unknown', value: null, unit: 'jobs', reason: queue.unknown, source: SOURCE }
    : { status: 'reported', value: exactCount(queue.count), unit: 'jobs',
        observedAt: new Date(queue.observedAtMs).toISOString(), stale: isStale(queue.observedAtMs, nowMs), source: SOURCE };
  const t: ThroughputMetric = 'unknown' in throughput
    ? { status: 'unknown', value: null, unit: 'jobs/minute', windowSeconds: THROUGHPUT_WINDOW_SECONDS,
        reason: throughput.unknown, source: SOURCE }
    : { status: 'reported', value: exactCount(throughput.count) / (THROUGHPUT_WINDOW_SECONDS / 60), unit: 'jobs/minute',
        windowSeconds: THROUGHPUT_WINDOW_SECONDS, count: exactCount(throughput.count),
        observedAt: new Date(throughput.observedAtMs).toISOString(), stale: isStale(throughput.observedAtMs, nowMs),
        source: SOURCE };
  const observed = [queue, throughput].filter((m): m is { count: number; observedAtMs: number } => !('unknown' in m))
    .map(m => m.observedAtMs);
  const earliest = observed.length ? Math.min(...observed) : null;
  return {
    schemaVersion: BOARD_METRICS_SCHEMA,
    observedAt: earliest === null ? null : new Date(earliest).toISOString(),
    stale: earliest === null || isStale(earliest, nowMs),
    freshnessSeconds: BOARD_METRICS_FRESHNESS_SECONDS,
    source: SOURCE,
    queue: q,
    throughput: t,
  };
}

/**
 * Whether the caller's authority reaches its whole Account's Tasks, so an
 * Account-wide count discloses nothing beyond it. A session of the Account
 * itself does; a Connector or Agent does only when every delegated link
 * inherits its parent's objects and none is bound to a Task. An explicit
 * object selector, a bound Agent or a link without an expression gets
 * `unknown` (reason `caller-reach`), never a count.
 */
export function accountWideReach(accountId: string, principalId: string | null | undefined,
  links: DelegationActorLink[] | null | undefined): boolean {
  if (!links || links.length === 0) return !!principalId && principalId === accountId;
  if (links[links.length - 1].principalId !== accountId) return false;
  return links.slice(0, -1).every(link => !link.boundTaskId && link.ownExpression?.objects === 'parent');
}

export class BoardMetricsService {
  constructor(private readonly db: Pool = defaultPool) {}

  /**
   * One count in its own READ ONLY transaction. A statement error leaves the
   * connection usable once ROLLBACK succeeds; when ROLLBACK itself fails the
   * connection is broken, and the caught error is kept in `connection.broken`
   * so read() destroys the client (release(err)) instead of pooling it, and
   * the next measurement does not run on it.
   */
  private async measure(client: PoolClient, sql: string, params: unknown[],
    connection: { broken?: Error }): Promise<Measured> {
    if (connection.broken) return { unknown: 'unavailable' };
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query('SET LOCAL jit = off');
      await client.query(`SET LOCAL statement_timeout = '${BOARD_METRICS_STATEMENT_TIMEOUT}'`);
      const row = (await client.query(sql, params)).rows[0];
      await client.query('COMMIT');
      return { count: exactCount(row?.value), observedAtMs: Number(row.observed_ms) };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        connection.broken = error instanceof Error ? error : new Error('BOARD_METRICS_CONNECTION_BROKEN');
      }
      logCaughtFailure('[Board metrics] measurement unavailable', error);
      return { unknown: 'unavailable' };
    }
  }

  /** Never throws: a failure is `unknown`, so the bridge's other fields are unaffected. */
  async read(accountId: string, reach: boolean): Promise<BoardMetrics> {
    if (!reach) return shapeBoardMetrics({ unknown: 'caller-reach' }, { unknown: 'caller-reach' });
    let client: PoolClient;
    try {
      client = await this.db.connect();
    } catch (error) {
      logCaughtFailure('[Board metrics] connection unavailable', error);
      return shapeBoardMetrics({ unknown: 'unavailable' }, { unknown: 'unavailable' });
    }
    const connection: { broken?: Error } = {};
    try {
      const queue = await this.measure(client, QUEUE_SQL, [accountId], connection);
      const throughput = await this.measure(client, THROUGHPUT_SQL, [accountId, THROUGHPUT_WINDOW_SECONDS], connection);
      return shapeBoardMetrics(queue, throughput);
    } finally {
      // A broken client is destroyed, never returned to the pool.
      client.release(connection.broken);
    }
  }
}
export const boardMetricsService = new BoardMetricsService();
