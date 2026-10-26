import { createHmac } from 'crypto';
import type { Pool } from 'pg';
import { pool } from '../db/connection';
import { delegationService } from './DelegationService';
import { authorizationRepository } from './AuthorizationRepository';
import type { AuthorizationActor } from './AuthorizationService';
import { scopesForRole } from '../utils/identityScopes';

export class MetricsCollectorDenied extends Error {}
export interface MetricsCollector { principalId: string; credentialId: string }
export interface MetricsConfig { projectLimit: number; labelKey: string }
export function metricsConfig(env: NodeJS.ProcessEnv = process.env): MetricsConfig {
  const projectLimit = Number(env.RELAYHALL_METRICS_PROJECT_LIMIT ?? '200');
  const labelKey = env.RELAYHALL_METRICS_LABEL_KEY ?? '';
  if (!Number.isInteger(projectLimit) || projectLimit < 1 || projectLimit > 10000
    || Buffer.byteLength(labelKey) < 32) throw new Error('METRICS_CONFIGURATION_UNAVAILABLE');
  return { projectLimit, labelKey };
}

// Fixed board vocabulary: stored unexpected statuses never become labels.
export const METRICS_TASK_STATUSES = ['ideas', 'todo', 'in-progress', 'review', 'stuck', 'completed', 'archived'] as const;
export interface MetricsTaskCount { status: string; value: string | number }
export interface MetricsProjectCount extends MetricsTaskCount { project_id: string }
export interface CoreMetricsSnapshot {
  accountId: string; projectCount: number; projects: MetricsProjectCount[];
  totals: MetricsTaskCount[]; observedAt: number;
  completion?: { cumulative: string | number; utcDay: string | number; rolling24h: string | number; recordingSince: number };
}
function count(value: string | number): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('INVALID_METRICS_COUNT');
  return n;
}
export function opaqueProjectRef(accountId: string, projectId: string, labelKey: string): string {
  return createHmac('sha256', labelKey).update(JSON.stringify([accountId, 'project', projectId])).digest('hex').slice(0, 32);
}
export function renderCoreMetrics(s: CoreMetricsSnapshot, config: MetricsConfig): string {
  const lines: string[] = [];
  const family = (name: string, help: string) => lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
  family('relayhall_projects', 'Projects readable by this Account and collector.');
  lines.push(`relayhall_projects ${count(s.projectCount)}`);
  family('relayhall_tasks_aggregate', 'All readable current tasks by status including omitted project detail.');
  const totals = new Map(s.totals.map(r => [r.status, count(r.value)]));
  for (const status of METRICS_TASK_STATUSES) lines.push(`relayhall_tasks_aggregate{status="${status}"} ${totals.get(status) ?? 0}`);
  family('relayhall_tasks', 'Readable current tasks in the bounded visible project set.');
  const projects = new Map<string, Map<string, number>>();
  for (const row of s.projects) {
    if (!projects.has(row.project_id)) projects.set(row.project_id, new Map());
    projects.get(row.project_id)!.set(row.status, count(row.value));
  }
  for (const [id, counts] of projects) {
    const ref = opaqueProjectRef(s.accountId, id, config.labelKey);
    for (const status of METRICS_TASK_STATUSES) lines.push(`relayhall_tasks{project_ref="${ref}",status="${status}"} ${counts.get(status) ?? 0}`);
  }
  const omitted = Math.max(0, count(s.projectCount) - projects.size);
  family('relayhall_metrics_truncated', 'Detail was omitted by the configured family cap.');
  lines.push(`relayhall_metrics_truncated{family="projects"} ${omitted > 0 ? 1 : 0}`);
  family('relayhall_metrics_omitted_projects', 'Number of readable projects omitted from detail.');
  lines.push(`relayhall_metrics_omitted_projects ${omitted}`);
  family('relayhall_metrics_unknown_task_status', 'Readable tasks outside the fixed status vocabulary.');
  lines.push(`relayhall_metrics_unknown_task_status ${s.totals.filter(r => !(METRICS_TASK_STATUSES as readonly string[]).includes(r.status)).reduce((n, r) => n + count(r.value), 0)}`);
  family('relayhall_metrics_source_available', 'Verified source availability; unavailable numeric families are omitted.');
  lines.push('relayhall_metrics_source_available{source="core_tasks"} 1');
  lines.push(`relayhall_metrics_source_available{source="task_completions"} ${s.completion ? 1 : 0}`);
  for (const source of ['durable_events', 'plugins', 'governor', 'adoption', 'approvals', 'deployments']) {
    lines.push(`relayhall_metrics_source_available{source="${source}"} 0`);
  }
  if (s.completion) {
    const c = s.completion;
    lines.push('# HELP relayhall_task_completions_total Verified Account-owned first completions since recording began.');
    lines.push('# TYPE relayhall_task_completions_total counter');
    lines.push(`relayhall_task_completions_total ${count(c.cumulative)}`);
    family('relayhall_task_completions_utc_day', 'Verified Account-owned first completions on the current UTC calendar day.');
    lines.push(`relayhall_task_completions_utc_day ${count(c.utcDay)}`);
    family('relayhall_task_completions_rolling_24h', 'Verified Account-owned first completions in the rolling past 24 hours.');
    lines.push(`relayhall_task_completions_rolling_24h ${count(c.rolling24h)}`);
    family('relayhall_metrics_history_complete', 'Whether reliable history predates recording; zero means it does not.');
    lines.push('relayhall_metrics_history_complete{source="task_completions"} 0');
    family('relayhall_metrics_recording_since_timestamp_seconds', 'Beginning of verified event recording.');
    lines.push(`relayhall_metrics_recording_since_timestamp_seconds{source="task_completions"} ${c.recordingSince / 1000}`);
  }
  family('relayhall_metrics_last_refresh_timestamp_seconds', 'UTC time of the consistent core snapshot.');
  lines.push(`relayhall_metrics_last_refresh_timestamp_seconds ${s.observedAt / 1000}`);
  return lines.join('\n') + '\n';
}

/** Scrapes read one bounded SQL snapshot, never a plugin URL or a content row. */
export class ProductMetricsService {
  constructor(private readonly db: Pool = pool) {}
  async scrape(collector: MetricsCollector, config: MetricsConfig): Promise<string> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      // The authorization predicate is one large expression whose estimated
      // cost grows with the Task count. Past PostgreSQL's JIT thresholds an
      // explicit-object collector paid seconds of compilation for a
      // millisecond read and overran the budget below (card 3471b8bf). Like
      // the authority preview, the scrape never JIT-compiles; the setting is
      // transaction-scoped, never pool-global state.
      await client.query('SET LOCAL jit = off');
      await client.query("SET LOCAL statement_timeout = '5s'");
      const credential = await client.query(`SELECT scopes FROM principal_credentials
        WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > clock_timestamp())
        AND (grace_until IS NULL OR grace_until > clock_timestamp())`, [collector.credentialId, collector.principalId]);
      const scopes = credential.rows[0]?.scopes;
      // A broad credential (including Main's) cannot act as the collector.
      if (!Array.isArray(scopes) || scopes.length !== 1 || scopes[0] !== 'metrics:read') throw new MetricsCollectorDenied();
      const chain = await delegationService.resolveChain(collector.principalId, client);
      const [acting, account] = chain.links;
      if (!chain.alive || chain.links.length !== 2 || acting.kind !== 'service'
        || acting.legacyIdentity || acting.boundTaskId || acting.ownerControlAccountId
        || !acting.parentPrincipalId || acting.parentPrincipalId !== account.principalId
        || account.parentPrincipalId || !['human', 'service'].includes(account.kind)
        || account.legacyIdentity) throw new MetricsCollectorDenied();
      if (!delegationService.effectiveScopes(chain, scopes, scopesForRole(account.role)).includes('metrics:read')) throw new MetricsCollectorDenied();
      const actor: AuthorizationActor = {
        principalId: acting.principalId, handle: '', role: acting.role, scopes: ['metrics:read'], authenticated: true,
        delegation: { links: chain.links },
      };
      const ps = authorizationRepository.listScope(actor, 'project', 'read');
      const ts = authorizationRepository.listScope(actor, 'task', 'read');
      const pp = ps.render(1), tp = ts.render(1);
      const projectTotal = await client.query(`SELECT COUNT(*) AS value FROM ${ps.from} WHERE ${pp.sql}`, pp.params);
      const totals = await client.query(`SELECT t.status,COUNT(*) AS value FROM ${ts.from} WHERE ${tp.sql} GROUP BY t.status`, tp.params);
      const detailP = ps.render(1), detailT = ts.render(detailP.params.length + 1);
      const capParam = detailP.params.length + detailT.params.length + 1;
      const projects = await client.query(`WITH selected AS (
        SELECT p.id FROM ${ps.from} WHERE ${detailP.sql} ORDER BY p.id LIMIT $${capParam}),
        readable_tasks AS (SELECT t.project_id,t.status FROM ${ts.from} WHERE ${detailT.sql})
        SELECT selected.id::text AS project_id,readable_tasks.status,COUNT(readable_tasks.project_id) AS value
        FROM selected LEFT JOIN readable_tasks ON readable_tasks.project_id=selected.id
        GROUP BY selected.id,readable_tasks.status ORDER BY selected.id,readable_tasks.status`,
      [...detailP.params, ...detailT.params, config.projectLimit]);
      const observedAt = await client.query('SELECT EXTRACT(EPOCH FROM transaction_timestamp()) * 1000 AS milliseconds');
      // Event history is Account-owned. A collector with an explicit object
      // selector must not receive aggregate history beyond that selector.
      let completion: CoreMetricsSnapshot['completion'];
      if (acting.ownExpression?.objects === 'parent') {
        const events = await client.query(`SELECT
          COALESCE((SELECT value FROM product_metric_cumulative WHERE account_id=$1 AND source='task_completion'),0) AS cumulative,
          COALESCE((SELECT value FROM product_metric_daily WHERE account_id=$1 AND source='task_completion'
            AND utc_day=(transaction_timestamp() AT TIME ZONE 'UTC')::date),0) AS utc_day,
          (SELECT COUNT(*) FROM product_metric_events WHERE account_id=$1 AND source='task_completion'
            AND occurred_at > transaction_timestamp()-interval '24 hours'
            AND occurred_at <= transaction_timestamp()) AS rolling24h,
          (SELECT EXTRACT(EPOCH FROM recording_since)*1000 FROM product_metric_coverage
            WHERE source='task_completions') AS recording_since`, [account.principalId]);
        const row = events.rows[0];
        if (row?.recording_since != null) completion = {
          cumulative: row.cumulative, utcDay: row.utc_day, rolling24h: row.rolling24h,
          recordingSince: Number(row.recording_since),
        };
      }
      const text = renderCoreMetrics({ accountId: account.principalId, projectCount: count(projectTotal.rows[0].value),
        totals: totals.rows, projects: projects.rows, observedAt: Number(observedAt.rows[0].milliseconds), completion }, config);
      await client.query('COMMIT');
      return text;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
}
export const productMetricsService = new ProductMetricsService();
