/** Real HTTP authentication, live credential/chain and canonical SQL narrowing. */
import crypto from 'crypto';
import { standaloneReportTestTarget } from './support/standaloneReportTestTarget';
const parsed = standaloneReportTestTarget(process.env.RELAYHALL_TEST_DB_URL, process.env.CI);
Object.assign(process.env, { DB_HOST: parsed.hostname, DB_PORT: parsed.port, DB_NAME: parsed.pathname.slice(1),
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password), NODE_ENV: 'test',
  RELAYHALL_METRICS_LABEL_KEY: crypto.randomBytes(32).toString('hex'), RELAYHALL_METRICS_PROJECT_LIMIT: '1' });
const express = require('express');
const { pool } = require('../db/connection');
const { principalService } = require('../services/PrincipalService');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const metricsRouter = require('../routes/metrics').default;
const { apiErrorHandler } = require('../utils/apiErrors');
const { opaqueProjectRef, metricsConfig, ProductMetricsService } = require('../services/ProductMetricsService');
const { Pool } = require('pg');
jest.setTimeout(30000);
let server: any, base: string;
const ids: string[] = [], projects: string[] = [], tasks: string[] = [];
const syntheticEventIds: string[] = [];
const name = () => 'metrics-test-' + crypto.randomBytes(8).toString('hex');
async function human() {
  const row = (await pool.query("INSERT INTO principals(kind,handle,status,role) VALUES('human',$1,'active','user') RETURNING id", [name()])).rows[0];
  ids.push(row.id); return row.id;
}
async function connector(owner: string, scopes = ['metrics:read']) {
  const row = (await pool.query("INSERT INTO principals(kind,handle,status,parent_principal_id,purpose,own_expression) VALUES('service',$1,'active',$2,'Disposable metrics proof',$3) RETURNING id",
    [name(), owner, JSON.stringify({ scopes: 'parent', objects: 'parent' })])).rows[0];
  ids.push(row.id);
  const credential = await principalService.issueCredential({ principalId: row.id, scopes, transport: 'api', expiresAt: new Date(Date.now() + 3600000) }, { handle: 'disposable-metrics-fixture', authMethod: 'system' });
  return { id: row.id, ...credential };
}
async function project(owner: string) {
  const row = (await pool.query("INSERT INTO projects(name,owner_principal_id,visibility) VALUES($1,$2,'private') RETURNING id", [name(), owner])).rows[0];
  projects.push(row.id); return row.id;
}
async function task(projectId: string, owner: string, status: string) {
  const row = (await pool.query("INSERT INTO tasks(title,project_id,account_owner_principal_id,status,visibility) VALUES($1,$2,$3,$4,'private') RETURNING id", [name(), projectId, owner, status])).rows[0];
  tasks.push(row.id); return row.id;
}
async function get(c?: any) {
  const res = await fetch(base + '/metrics', { headers: c ? { Authorization: `Bearer ${c.fullKey}` } : {} });
  return { status: res.status, text: await res.text() };
}
// The CI database is shared with earlier live suites, whose shared/public
// Projects a fresh Account may legitimately read: totals are asserted as deltas
// over a baseline scrape of the SAME connector, never as absolute literals.
const PROJECTS = 'relayhall_projects', OMITTED = 'relayhall_metrics_omitted_projects';
const AGG = (status: string) => `relayhall_tasks_aggregate{status="${status}"}`;
function metric(text: string, series: string): number {
  const line = text.split('\n').find(l => l.startsWith(series + ' '));
  if (line === undefined) throw new Error(`series missing from scrape: ${series}`);
  const value = Number(line.slice(series.length + 1));
  if (!Number.isSafeInteger(value)) throw new Error(`series not an integer: ${line}`);
  return value;
}
function refs(text: string): string[] {
  const out: string[] = [];
  for (const l of text.split('\n')) {
    const m = /^relayhall_tasks\{project_ref="([0-9a-f]{32})",status="ideas"\} \d+$/.exec(l);
    if (m) out.push(m[1]);
  }
  return out;
}
async function uncapped(c: any) {
  // Lift the detail cap above everything this collector can read, so every
  // readable Project carries a per-project series.
  const total = metric((await get(c)).text, PROJECTS);
  process.env.RELAYHALL_METRICS_PROJECT_LIMIT = String(total + 1);
  try {
    const r = await get(c); expect(r.status).toBe(200);
    expect(metric(r.text, PROJECTS)).toBe(total); expect(metric(r.text, OMITTED)).toBe(0);
    expect(refs(r.text)).toHaveLength(total);
    return r;
  } finally { process.env.RELAYHALL_METRICS_PROJECT_LIMIT = '1'; }
}
beforeAll(async () => {
  const app = express(); app.use('/metrics', authMiddleware, sharedAuthorizationMiddleware, metricsRouter); app.use(apiErrorHandler);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = 'http://127.0.0.1:' + server.address().port;
});
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(resolve));
  await pool.query('DELETE FROM tasks WHERE id=ANY($1::uuid[])', [tasks]);
  await pool.query('DELETE FROM projects WHERE id=ANY($1::uuid[])', [projects]);
  await pool.query('DELETE FROM product_metric_events WHERE account_id=ANY($1::uuid[])', [ids]);
  await pool.query('DELETE FROM product_metric_daily WHERE account_id=ANY($1::uuid[])', [ids]);
  await pool.query('DELETE FROM product_metric_cumulative WHERE account_id=ANY($1::uuid[])', [ids]);
  await pool.query(`DELETE FROM product_metric_dedupe_keys WHERE source_hash IN
    (SELECT product_metric_source_hash('task_completion', source_id)
      FROM unnest($1::uuid[]) AS source_id)`, [tasks.concat(syntheticEventIds)]);
  await pool.query('DELETE FROM audit_events WHERE actor_principal_id=ANY($1::uuid[]) OR credential_id IN (SELECT id FROM principal_credentials WHERE principal_id=ANY($1::uuid[]))', [ids]);
  for (const id of ids.slice().reverse()) await pool.query('DELETE FROM principals WHERE id=$1', [id]);
  await pool.end();
});
test('two Accounts, capped detail/full totals, zero project, opaque stable labels, live object narrowing', async () => {
  const key = process.env.RELAYHALL_METRICS_LABEL_KEY;
  const owner = await human(), foreign = await human(), c = await connector(owner), outsider = await connector(foreign);
  // Baselines before any fixture: whatever the database already lets a fresh Account read.
  const before = await get(c), outsiderBefore = await get(outsider);
  expect(before.status).toBe(200); expect(outsiderBefore.status).toBe(200);
  const base = { projects: metric(before.text, PROJECTS), todo: metric(before.text, AGG('todo')), completed: metric(before.text, AGG('completed')) };
  // Two fresh Accounts read the same pre-existing set; neither holds anything of its own yet.
  expect(metric(outsiderBefore.text, PROJECTS)).toBe(base.projects);
  expect(metric(outsiderBefore.text, AGG('todo'))).toBe(base.todo);
  expect(metric(outsiderBefore.text, AGG('completed'))).toBe(base.completed);
  const a = await project(owner), b = await project(owner), hidden = await project(foreign);
  await task(a, owner, 'todo'); await task(b, owner, 'todo'); await task(b, owner, 'completed');
  await task(hidden, foreign, 'todo');
  const result = await get(c); expect(result.status).toBe(200);
  // Exactly the owner's two private Projects are added; the foreign private Project and Task are not.
  expect(metric(result.text, PROJECTS)).toBe(base.projects + 2);
  expect(metric(result.text, AGG('todo'))).toBe(base.todo + 2);
  expect(metric(result.text, AGG('completed'))).toBe(base.completed + 1);
  // RELAYHALL_METRICS_PROJECT_LIMIT=1: one detailed Project, every other readable one omitted.
  expect(metric(result.text, OMITTED)).toBe(metric(result.text, PROJECTS) - 1);
  expect(result.text).toContain('relayhall_metrics_truncated{family="projects"} 1');
  expect(result.text).not.toMatch(new RegExp([owner, foreign, a, b, hidden].join('|')));
  const refA = opaqueProjectRef(owner, a, key), refB = opaqueProjectRef(owner, b, key);
  const hiddenRefs = [opaqueProjectRef(owner, hidden, key), opaqueProjectRef(foreign, hidden, key)];
  const capped = refs(result.text); expect(capped).toHaveLength(1);
  const full = refs((await uncapped(c)).text);
  expect(full).toEqual(expect.arrayContaining([refA, refB]));
  for (const r of hiddenRefs) { expect(full).not.toContain(r); expect(result.text).not.toContain(r); }
  // The capped detail is the lowest-id readable Project; on an empty database that is the lower of a and b.
  expect(capped[0]).toBe(full[0]);
  if (base.projects === 0) expect(capped[0]).toBe(opaqueProjectRef(owner, [a, b].sort()[0], key));
  // Labels are stable across scrapes.
  expect(refs((await get(c)).text)).toEqual(capped);
  expect(refs((await uncapped(c)).text)).toEqual(full);
  const foreignResult = await get(outsider); expect(foreignResult.status).toBe(200);
  expect(metric(foreignResult.text, PROJECTS)).toBe(base.projects + 1);
  expect(metric(foreignResult.text, AGG('todo'))).toBe(base.todo + 1);
  expect(metric(foreignResult.text, AGG('completed'))).toBe(base.completed);
  const foreignFull = refs((await uncapped(outsider)).text);
  expect(foreignFull).toContain(opaqueProjectRef(foreign, hidden, key));
  for (const id of [a, b]) {
    expect(foreignFull).not.toContain(opaqueProjectRef(foreign, id, key));
    expect(foreignFull).not.toContain(opaqueProjectRef(owner, id, key));
  }
  await pool.query('UPDATE principals SET own_expression=$2 WHERE id=$1', [c.id, JSON.stringify({ scopes: 'parent', objects: [
    { resourceType: 'project', selectorForm: 'exact', selectorIds: [a], verbs: ['read'] },
    { resourceType: 'task', selectorForm: 'all-in-project', selectorIds: [a], verbs: ['read'] },
  ] })]);
  // Live object narrowing to Project a is exact whatever else the database holds.
  const narrowed = await get(c); expect(narrowed.status).toBe(200);
  expect(narrowed.text).toContain('relayhall_projects 1\n');
  expect(narrowed.text).toContain('relayhall_tasks_aggregate{status="todo"} 1');
  expect(narrowed.text).toContain('relayhall_tasks_aggregate{status="completed"} 0');
  expect(narrowed.text).toContain('relayhall_metrics_omitted_projects 0');
  expect(refs(narrowed.text)).toEqual([refA]);
  const emptyOwner = await human(), emptyC = await connector(emptyOwner);
  const emptyBefore = await get(emptyC); expect(emptyBefore.status).toBe(200);
  // The fixtures above stay invisible to a third fresh Account.
  expect(metric(emptyBefore.text, PROJECTS)).toBe(base.projects);
  expect(metric(emptyBefore.text, AGG('todo'))).toBe(base.todo);
  const zero = await project(emptyOwner);
  const empty = await get(emptyC); expect(empty.status).toBe(200);
  expect(metric(empty.text, PROJECTS)).toBe(base.projects + 1);
  expect(metric(empty.text, AGG('todo'))).toBe(base.todo);
  expect(metric(empty.text, AGG('completed'))).toBe(base.completed);
  // The zero-task Project still carries a per-project series of zeros.
  const zeroRef = opaqueProjectRef(emptyOwner, zero, key);
  const emptyFull = await uncapped(emptyC);
  expect(emptyFull.text).toContain(`relayhall_tasks{project_ref="${zeroRef}",status="todo"} 0`);
  expect(emptyFull.text).toContain(`relayhall_tasks{project_ref="${zeroRef}",status="completed"} 0`);
});
test('stored broad credentials and appointed Main are refused; expiry and revocation bite on next scrape', async () => {
  const owner = await human();
  const c = await connector(owner), broad = await connector(owner, ['metrics:read', 'tasks:write']);
  expect((await get()).status).toBe(401); expect((await get(broad)).status).toBe(403);
  expect((await get(c)).status).toBe(200);
  await pool.query('UPDATE principals SET owner_control_account_id=$2 WHERE id=$1', [c.id, owner]);
  expect((await get(c)).status).toBe(403);
  await pool.query('UPDATE principals SET owner_control_account_id=NULL WHERE id=$1', [c.id]);
  await pool.query("UPDATE principal_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [c.credentialId]);
  expect((await get(c)).status).toBe(401);
  await pool.query("UPDATE principal_credentials SET expires_at=clock_timestamp()+interval '1 hour',revoked_at=clock_timestamp() WHERE id=$1", [c.credentialId]);
  expect((await get(c)).status).toBe(401);
});

test('verified first completion survives retry and reopening, and remains Account-bound', async () => {
  const owner = await human(), other = await human();
  const c = await connector(owner), otherC = await connector(other);
  const p = await project(owner), otherP = await project(other);
  const t = await task(p, owner, 'todo'), foreign = await task(otherP, other, 'todo');
  let result = await get(c);
  expect(result.text).toContain('relayhall_metrics_source_available{source="task_completions"} 1');
  expect(result.text).toContain('relayhall_task_completions_total 0');
  expect(result.text).toContain('relayhall_metrics_history_complete{source="task_completions"} 0');
  await pool.query("UPDATE tasks SET status='completed',completed_at=clock_timestamp() WHERE id=$1", [t]);
  await pool.query("UPDATE tasks SET status='completed',completed_at=clock_timestamp() WHERE id=$1", [foreign]);
  await pool.query("UPDATE tasks SET status='completed',completed_at=clock_timestamp() WHERE id=$1", [t]);
  await pool.query("UPDATE tasks SET status='todo' WHERE id=$1", [t]);
  await pool.query("UPDATE tasks SET status='completed',completed_at=clock_timestamp() WHERE id=$1", [t]);
  result = await get(c);
  expect(result.text).toContain('relayhall_task_completions_total 1');
  expect(result.text).toContain('relayhall_task_completions_utc_day 1');
  expect(result.text).toContain('relayhall_task_completions_rolling_24h 1');
  expect((await get(otherC)).text).toContain('relayhall_task_completions_total 1');
  const rows = await pool.query("SELECT COUNT(*)::int AS n FROM product_metric_events WHERE source='task_completion' AND source_id=$1", [t]);
  expect(rows.rows[0].n).toBe(1);
  await pool.query('UPDATE principals SET own_expression=$2 WHERE id=$1', [c.id, JSON.stringify({ scopes: 'parent', objects: [
    { resourceType: 'project', selectorForm: 'exact', selectorIds: [p], verbs: ['read'] },
    { resourceType: 'task', selectorForm: 'all-in-project', selectorIds: [p], verbs: ['read'] },
  ] })]);
  result = await get(c);
  expect(result.text).toContain('relayhall_metrics_source_available{source="task_completions"} 0');
  expect(result.text).not.toContain('relayhall_task_completions_total ');
});

test('UTC-day and rolling windows differ; retention removes detail without resetting cumulative totals', async () => {
  const owner = await human(), c = await connector(owner);
  const insert = async (when: string) => {
    const sourceId = crypto.randomUUID(); syntheticEventIds.push(sourceId);
    return pool.query(
    "INSERT INTO product_metric_events(source,source_id,account_id,occurred_at) VALUES('task_completion',$1,$2,$3::timestamptz)",
    [sourceId, owner, when]);
  };
  const now = new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  await insert(new Date(midnight.getTime() - 1000).toISOString());
  await insert(new Date(now.getTime() - 100 * 86400000).toISOString());
  await insert(new Date(now.getTime() - 430 * 86400000).toISOString());
  let result = await get(c);
  expect(result.text).toContain('relayhall_task_completions_total 3');
  expect(result.text).toContain('relayhall_task_completions_utc_day 0');
  expect(result.text).toContain('relayhall_task_completions_rolling_24h 1');
  await pool.query('SELECT product_metric_prune(clock_timestamp())');
  const retained = await pool.query('SELECT COUNT(*)::int AS n FROM product_metric_events WHERE account_id=$1', [owner]);
  expect(retained.rows[0].n).toBe(1);
  const daily = await pool.query('SELECT COUNT(*)::int AS n FROM product_metric_daily WHERE account_id=$1', [owner]);
  expect(daily.rows[0].n).toBe(2);
  result = await get(c);
  expect(result.text).toContain('relayhall_task_completions_total 3');
  expect(result.text).toContain('relayhall_task_completions_rolling_24h 1');
});

test('pruning completion detail cannot erase lifetime dedupe across reopen', async () => {
  const owner = await human(), c = await connector(owner);
  const p = await project(owner), t = await task(p, owner, 'todo');
  await pool.query("UPDATE tasks SET status='completed',completed_at=clock_timestamp() WHERE id=$1", [t]);
  await pool.query("UPDATE product_metric_events SET occurred_at=clock_timestamp()-interval '91 days' WHERE source='task_completion' AND source_id=$1", [t]);
  await pool.query('SELECT product_metric_prune(clock_timestamp())');
  expect((await pool.query('SELECT COUNT(*)::int AS n FROM product_metric_events WHERE source_id=$1', [t])).rows[0].n).toBe(0);
  await pool.query("UPDATE tasks SET status='todo',completed_at=NULL WHERE id=$1", [t]);
  await pool.query("UPDATE tasks SET status='completed',completed_at=clock_timestamp() WHERE id=$1", [t]);
  const result = await get(c);
  expect(result.text).toContain('relayhall_task_completions_total 1');
  expect((await pool.query('SELECT COUNT(*)::int AS n FROM product_metric_events WHERE source_id=$1', [t])).rows[0].n).toBe(0);
  expect((await pool.query("SELECT COUNT(*)::int AS n FROM product_metric_dedupe_keys WHERE source_hash=product_metric_source_hash('task_completion',$1::uuid)", [t])).rows[0].n).toBe(1);
});

test('rolled-back completion leaves no key; Account deletion removes readable data but preserves opaque dedupe', async () => {
  const owner = await human(), p = await project(owner), t = await task(p, owner, 'todo');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("UPDATE tasks SET status='completed',completed_at=clock_timestamp() WHERE id=$1", [t]);
    expect((await client.query("SELECT COUNT(*)::int AS n FROM product_metric_dedupe_keys WHERE source_hash=product_metric_source_hash('task_completion',$1::uuid)", [t])).rows[0].n).toBe(1);
  } finally {
    await client.query('ROLLBACK'); client.release();
  }
  expect((await pool.query("SELECT COUNT(*)::int AS n FROM product_metric_dedupe_keys WHERE source_hash=product_metric_source_hash('task_completion',$1::uuid)", [t])).rows[0].n).toBe(0);
  await pool.query("UPDATE tasks SET status='completed',completed_at=clock_timestamp() WHERE id=$1", [t]);
  expect((await pool.query('SELECT value FROM product_metric_cumulative WHERE account_id=$1', [owner])).rows[0].value).toBe('1');
  await pool.query('DELETE FROM tasks WHERE id=$1', [t]);
  await pool.query('DELETE FROM projects WHERE id=$1', [p]);
  await pool.query('DELETE FROM principals WHERE id=$1', [owner]);
  expect((await pool.query('SELECT COUNT(*)::int AS n FROM product_metric_events WHERE account_id=$1', [owner])).rows[0].n).toBe(0);
  expect((await pool.query('SELECT COUNT(*)::int AS n FROM product_metric_daily WHERE account_id=$1', [owner])).rows[0].n).toBe(0);
  expect((await pool.query('SELECT COUNT(*)::int AS n FROM product_metric_cumulative WHERE account_id=$1', [owner])).rows[0].n).toBe(0);
  expect((await pool.query("SELECT COUNT(*)::int AS n FROM product_metric_dedupe_keys WHERE source_hash=product_metric_source_hash('task_completion',$1::uuid)", [t])).rows[0].n).toBe(1);
});
test('200-project default detail boundary keeps all 201 project totals within a bounded scrape', async () => {
  const owner = await human(), c = await connector(owner);
  const before = await get(c); expect(before.status).toBe(200);
  const baseProjects = metric(before.text, PROJECTS), baseTodo = metric(before.text, AGG('todo'));
  const inserted = await pool.query(`INSERT INTO projects(name,owner_principal_id,visibility)
    SELECT $1 || n::text,$2,'private' FROM generate_series(1,201) n RETURNING id`, [name(), owner]);
  const projectIds = inserted.rows.map((r: any) => r.id); projects.push(...projectIds);
  const taskRows = await pool.query(`INSERT INTO tasks(title,project_id,account_owner_principal_id,status,visibility)
    SELECT $1,p,$2,'todo','private' FROM unnest($3::uuid[]) p RETURNING id`, [name(), owner, projectIds]);
  tasks.push(...taskRows.rows.map((r: any) => r.id));
  process.env.RELAYHALL_METRICS_PROJECT_LIMIT = '200';
  try {
    const start = Date.now(), result = await get(c);
    expect(result.status).toBe(200); expect(Date.now() - start).toBeLessThan(5000);
    const projectCount = metric(result.text, PROJECTS);
    expect(projectCount).toBe(baseProjects + 201);
    expect(metric(result.text, AGG('todo'))).toBe(baseTodo + 201);
    expect(metric(result.text, OMITTED)).toBe(projectCount - 200);
    expect(result.text).toContain('relayhall_metrics_truncated{family="projects"} 1');
    expect(result.text.split('\n').filter(l => l.startsWith('relayhall_tasks{'))).toHaveLength(200 * 7);
  } finally { process.env.RELAYHALL_METRICS_PROJECT_LIMIT = '1'; }
});

test('an explicit-object scrape never JIT-compiles, even on a connection that would compile everything', async () => {
  // Card 3471b8bf: past the JIT cost thresholds (reached by Task volume on a
  // long-lived database) this scrape spent seconds compiling its predicate and
  // answered 503 METRICS_UNAVAILABLE. A connection whose thresholds are zero
  // reaches that state on any database, so the guard does not depend on volume.
  const owner = await human(), c = await connector(owner);
  const p = await project(owner); await task(p, owner, 'todo');
  await pool.query('UPDATE principals SET own_expression=$2 WHERE id=$1', [c.id, JSON.stringify({ scopes: 'parent', objects: [
    { resourceType: 'project', selectorForm: 'exact', selectorIds: [p], verbs: ['read'] },
    { resourceType: 'task', selectorForm: 'all-in-project', selectorIds: [p], verbs: ['read'] },
  ] })]);
  const forced = new Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_NAME,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, max: 1,
    options: '-c jit=on -c jit_above_cost=0 -c jit_inline_above_cost=0 -c jit_optimize_above_cost=0' });
  try {
    const probe = await forced.query("SELECT current_setting('jit') AS jit, current_setting('jit_above_cost') AS above");
    expect(probe.rows[0]).toEqual({ jit: 'on', above: '0' });
    // The setting is read on the scrape's own transaction, just before its first authorization query.
    const seen: string[] = [];
    const db = { connect: async () => {
      const client = await forced.connect(), query = client.query.bind(client);
      client.query = async (text: any, params?: any) => {
        if (typeof text === 'string' && text.startsWith('SELECT COUNT(*) AS value FROM ')) {
          seen.push((await query("SELECT current_setting('jit') AS jit")).rows[0].jit);
        }
        return query(text, params);
      };
      // Hand the pool back its own client: pg-pool drives it with callbacks.
      const release = client.release.bind(client);
      client.release = (error?: any) => { delete client.query; delete client.release; return release(error); };
      return client;
    } };
    const start = Date.now();
    const text = await new ProductMetricsService(db).scrape({ principalId: c.id, credentialId: c.credentialId }, metricsConfig());
    expect(seen).toEqual(['off']);
    expect(text).toContain('relayhall_projects 1\n');
    expect(text).toContain('relayhall_tasks_aggregate{status="todo"} 1');
    expect(Date.now() - start).toBeLessThan(5000);
    // The local setting ended with the scrape's transaction.
    expect((await forced.query("SELECT current_setting('jit') AS jit")).rows[0].jit).toBe('on');
  } finally { await forced.end(); }
});
