/**
 * Owner ruling E462 (universal harness connector design, sections 6.1-6.3 and
 * 6.7): wake protocol 2 against a real PostgreSQL, real credentials, the real
 * feed, the production routers and real sockets. The `verify` and `stuck`
 * kinds ring from the Action Center's own predicates (its per-Task form), are
 * withdrawn by their own rules, are rung once per occurrence, never reach a
 * Connector that cannot read the Task or a `wake=1` socket, and the
 * `wake.outcome` frame becomes a `connector.trigger` stream entry and audit
 * row. The catch-up pull (`GET /notifications/actions`) lists what a wake lost
 * to a restart would have rung. Every test name starts `S4 ` so the mutation
 * drill (scripts/connector-wake-kinds-mutations.py) can name its red set.
 * Never runs without a disposable DB URL.
 */
import http from 'http';
import crypto from 'crypto';
import { WebSocket } from 'ws';
const databaseUrl = process.env.RELAYHALL_TEST_DB_URL;
if (!databaseUrl) throw new Error('RELAYHALL_TEST_DB_URL required; this integration gate never skips');
const parsed = new URL(databaseUrl);
const database = decodeURIComponent(parsed.pathname.slice(1));
const local = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) && /test|contract|fixture/.test(database);
const ci = process.env.CI === 'true' && parsed.hostname === 'postgres' && database === 'relayhall_ci';
if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod'].includes(database) || (!local && !ci)) throw new Error('Refusing a non-disposable database');
Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: database,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password), NODE_ENV: 'test',
  JWT_SECRET: crypto.randomBytes(32).toString('hex'), RELAYHALL_SESSIONS: 'on',
});
const express = require('express');
const { pool } = require('../db/connection');
const { principalService } = require('../services/PrincipalService');
const { feedEventService } = require('../services/FeedEventService');
const { taskManagerDB } = require('../services/TaskManagerDB');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { syncTaskReadiness } = require('../utils/taskReadiness');
const routeRegistry = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { ConnectorNotificationService } = require('../services/ConnectorNotificationService');
const { ConnectorWakeService, DEFAULT_WAKE_CONFIG } = require('../services/ConnectorWakeService');
jest.setTimeout(60000);

const system = { handle: 'connector-wake-kinds-fixture', authMethod: 'system' };
const tag = () => 'wk2-' + crypto.randomBytes(6).toString('hex');
let server: http.Server; let notifications: any; let wake: any; let origin: string; let port: number;
const sockets: WebSocket[] = [];
const inbox = new Map<WebSocket, any[]>();
// Real dispatcher, short passes, a backoff a test can act inside (600 + 1200 + 1200 + 1200 ms).
const FAST = { ...DEFAULT_WAKE_CONFIG, intervalMs: 50, backoffBaseMs: 600, backoffMaxMs: 1200 };
/** Long enough for many 50 ms passes to have read an event and rung nobody. */
const QUIET_MS = 1500;

interface Connector { id: string; parent: string; serviceId: string; authorization: string }

async function account(): Promise<string> {
  const r = await pool.query("INSERT INTO principals(kind,handle,display_name,status,role) VALUES('human',$1,$1,'active','user') RETURNING id", [tag()]);
  return r.rows[0].id;
}
async function bearerOf(principalId: string, scopes = ['tasks:read']): Promise<string> {
  const credential = await principalService.issueCredential({ principalId, scopes, transport: 'api' }, system);
  return 'Bearer ' + credential.fullKey;
}
async function connector(): Promise<Connector> {
  const parent = await account();
  const r = await pool.query("INSERT INTO principals(kind,handle,display_name,status,role,parent_principal_id,purpose,own_expression) VALUES('service',$1,$1,'active','user',$2,'wake kinds fixture',$3::jsonb) RETURNING id", [tag(), parent, JSON.stringify({ scopes: 'parent', objects: 'parent' })]);
  const id = r.rows[0].id;
  const slug = tag();
  const svc = await pool.query(
    `INSERT INTO services(slug,name,kind,status,principal_id,delivery_mode,delivery_poll_interval_seconds,current_descriptor_version)
     VALUES($1,$1,'connector','published',$2,'poll',30,1) RETURNING id`, [slug, id]);
  const descriptor = { options: [], telemetry: { tier: 'full', products: ['wake-kinds-fixture'] } };
  await pool.query(
    `INSERT INTO service_descriptor_versions(service_id,version,descriptor,content_hash) VALUES($1,1,$2::jsonb,$3)`,
    [svc.rows[0].id, JSON.stringify(descriptor), crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex')]);
  return { id, parent, serviceId: svc.rows[0].id, authorization: await bearerOf(id, ['tasks:read', 'telemetry:write']) };
}
async function agentOf(parent: Connector, taskId: string): Promise<string> {
  const r = await pool.query("INSERT INTO principals(kind,handle,display_name,status,parent_principal_id,bound_task_id,purpose,own_expression) VALUES('agent',$1,$1,'active',$2,$3,'wake kinds fixture agent',$4::jsonb) RETURNING id", [tag(), parent.id, taskId, JSON.stringify({ scopes: 'parent', objects: 'parent' })]);
  return r.rows[0].id;
}
/** A private Task created by its own Account, with the given role columns. */
async function task(fields: { status: string; owner?: string | null; verifier?: string | null; shepherd?: string | null; executionServiceId?: string | null }): Promise<{ id: string; creator: string }> {
  const creator = await account();
  const r = await pool.query(
    `INSERT INTO tasks(title,status,visibility,creator_principal_id,owner_principal_id,verifier_principal_id,shepherd_principal_id)
     VALUES($1,$2,'private',$3,$4,$5,$6) RETURNING id`,
    [tag(), fields.status, creator, fields.owner ?? null, fields.verifier ?? null, fields.shepherd ?? null]);
  if (fields.executionServiceId) {
    await pool.query(
      'UPDATE tasks SET execution_service_id=$2, execution_descriptor_version=1, execution_profile=$3::jsonb WHERE id=$1',
      [r.rows[0].id, fields.executionServiceId, JSON.stringify({ serviceId: fields.executionServiceId, descriptorVersion: 1, options: {} })]);
  }
  return { id: r.rows[0].id, creator };
}
async function grantRead(principalId: string, taskId: string): Promise<void> {
  await pool.query("INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id) VALUES('principal',$1,'task',$2,'read',$1)", [principalId, taskId]);
}
async function revokeRead(principalId: string, taskId: string): Promise<void> {
  await pool.query("DELETE FROM grants WHERE grantee_type='principal' AND grantee_id=$1 AND resource_type='task' AND resource_id=$2", [principalId, taskId]);
}
/** The production writers' feed shapes, emitted in the writing transaction. */
async function emit(taskId: string, name: string, payload: Record<string, unknown>, sql?: [string, unknown[]]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (sql) await client.query(sql[0], sql[1]);
    await feedEventService.emit(client, { name, objectType: 'task', objectId: taskId, payload });
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
const toReview = (taskId: string) => emit(taskId, 'task.updated',
  { status: 'review', previousStatus: 'in-progress', fields: ['status'] },
  ["UPDATE tasks SET status='review' WHERE id=$1", [taskId]]);
async function connect(authorization: string, query = '?wake=2'): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/events/ws${query}`, { headers: { Authorization: authorization } });
    sockets.push(ws); inbox.set(ws, []);
    ws.on('message', data => inbox.get(ws)!.push(JSON.parse(data.toString())));
    ws.on('error', () => undefined);
    const timer = setTimeout(() => reject(new Error('Upgrade timed out')), 10000);
    ws.once('open', () => { clearTimeout(timer); resolve(ws); });
    ws.once('unexpected-response', (_req, res) => { clearTimeout(timer); res.resume(); reject(new Error('refused ' + res.statusCode)); });
  });
}
async function until<T>(fn: () => Promise<T | undefined> | T | undefined, ms = 15000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn(); if (value !== undefined) return value;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('Timed out');
}
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function enabled(ws: WebSocket): Promise<void> {
  expect(await until(() => inbox.get(ws)!.find(f => f.type === 'wake.status'))).toEqual({ type: 'wake.status', enabled: true });
}
const wakes = (ws: WebSocket, taskId: string) => inbox.get(ws)!.filter(f => f.type === 'wake' && f.taskId === taskId);
/** The dispatcher's own in-flight wakes for a Task: "never rung" means none was ever raised, not only none was heard. */
const raised = (taskId: string, principalId?: string) => wake.pendingWakes()
  .filter((w: any) => w.taskId === taskId && (!principalId || w.principalId === principalId));
const firstWake = (ws: WebSocket, taskId: string) => until(() => wakes(ws, taskId)[0]);
/**
 * A positive marker that the dispatcher has EVALUATED an event: the
 * Connector endpoint's feed cursor has moved past it (a scan sets the cursor
 * only after it raised every wake the page called for). Reads the
 * dispatcher's own endpoint state.
 */
async function evaluated(principalId: string, taskId: string): Promise<void> {
  const last = (await pool.query('SELECT MAX(cursor)::text AS cursor FROM feed_events WHERE object_id=$1', [taskId])).rows[0].cursor;
  await until(() => (Number(wake.endpoints.get(principalId)?.cursor ?? 0) >= Number(last) ? true : undefined));
}
async function receipts(taskId: string, prefix = 'connector.wake.'): Promise<any[]> {
  return (await pool.query(
    "SELECT * FROM audit_events WHERE resource_type='task' AND resource_id=$1 AND action LIKE $2 ORDER BY occurred_at, id",
    [taskId, prefix + '%'])).rows;
}
const settled = (taskId: string) => until(async () => { const rows = await receipts(taskId); return rows.length ? rows : undefined; });
async function streamOf(taskId: string, type: string) {
  return (await pool.query('SELECT * FROM task_stream_entries WHERE task_id=$1 AND event_type=$2 ORDER BY stream_offset', [taskId, type])).rows;
}
async function get(authorization: string, routePath: string): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = authorization.startsWith('Bearer ') ? { Authorization: authorization } : { Cookie: authorization };
  const response = await fetch(`${origin}${routePath}`, { headers });
  return { status: response.status, json: await response.json().catch(() => null) };
}
const actionKeys = async (authorization: string) =>
  ((await get(authorization, '/notifications/actions')).json?.items ?? []).map((item: any) => item.key);

beforeAll(async () => {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  routeRegistry.registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  server = http.createServer(app);
  wake = new ConnectorWakeService(pool, FAST);
  notifications = new ConnectorNotificationService(server, 50, wake);
  wake.start();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as any).port;
  origin = `http://127.0.0.1:${port}`;
});
afterEach(() => { for (const ws of sockets.splice(0)) ws.terminate(); inbox.clear(); });
afterAll(async () => {
  wake?.stop(); notifications?.shutdown();
  if (server) await new Promise<void>(r => server.close(() => r()));
  await pool.end();
});

test('S4 verify rings the exact Verifier connector with the kind, and its ack is a verify receipt', async () => {
  const c = await connector(); const implementer = await account();
  const t = await task({ status: 'in-progress', owner: implementer, verifier: c.id });
  const ws = await connect(c.authorization); await enabled(ws);
  await toReview(t.id);
  const frame = await firstWake(ws, t.id);
  expect(frame).toEqual({ type: 'wake', wakeId: expect.any(String), taskId: t.id, kind: 'verify', cursor: expect.stringMatching(/^\d+$/), attempt: 1 });
  ws.send(JSON.stringify({ type: 'wake.ack', wakeId: frame.wakeId }));
  const [audit] = await settled(t.id);
  expect(audit).toMatchObject({ action: 'connector.wake.acknowledged', actor_principal_id: c.id, auth_method: 'principal_api_key' });
  expect(audit.metadata).toMatchObject({ wakeId: frame.wakeId, kind: 'verify', outcome: 'acknowledged', taskId: t.id, serviceId: c.serviceId });
  const [entry] = await streamOf(t.id, 'connector.wake');
  expect(entry).toMatchObject({ provenance: 'system' });
  expect(entry.content).toMatch(/^Verify wake acknowledged by the Verifier connector after 1 send in \d+ ms; no model identity reported\.$/);
});

test('S4 verify rings the connector whose Agent is the Verifier, never another reader, and matches the pull', async () => {
  const c = await connector(); const other = await connector(); const implementer = await account();
  const t = await task({ status: 'in-progress', owner: implementer });
  const agent = await agentOf(c, t.id);
  await pool.query('UPDATE tasks SET verifier_principal_id=$2 WHERE id=$1', [t.id, agent]);
  await grantRead(c.parent, t.id); await grantRead(other.parent, t.id);
  const mine = await connect(c.authorization); const theirs = await connect(other.authorization);
  await enabled(mine); await enabled(theirs);
  await toReview(t.id);
  expect((await firstWake(mine, t.id)).kind).toBe('verify');
  await pause(QUIET_MS);
  expect(wakes(theirs, t.id)).toEqual([]);
  expect(raised(t.id, other.id)).toEqual([]);
  // The outside anchor: the wake rings exactly what each Connector's own pull lists.
  expect(await actionKeys(c.authorization)).toContain(`verify:${t.id}`);
  expect(await actionKeys(other.authorization)).not.toContain(`verify:${t.id}`);
});

test('S4 verify never rings a connector that may not see the Task, even with its own Agent as the Verifier', async () => {
  const c = await connector(); const implementer = await account();
  const hidden = await task({ status: 'in-progress', owner: implementer });
  await pool.query('UPDATE tasks SET verifier_principal_id=$2 WHERE id=$1', [hidden.id, await agentOf(c, hidden.id)]);
  const ws = await connect(c.authorization); await enabled(ws);
  await toReview(hidden.id);
  await pause(QUIET_MS);
  expect(wakes(ws, hidden.id)).toEqual([]);
  expect(raised(hidden.id)).toEqual([]);
  expect(await receipts(hidden.id)).toEqual([]);
  expect(await actionKeys(c.authorization)).not.toContain(`verify:${hidden.id}`);
  // Negative control: the same shape, readable, rings.
  const seen = await task({ status: 'in-progress', owner: implementer });
  await pool.query('UPDATE tasks SET verifier_principal_id=$2 WHERE id=$1', [seen.id, await agentOf(c, seen.id)]);
  await grantRead(c.parent, seen.id);
  await toReview(seen.id);
  expect((await firstWake(ws, seen.id)).kind).toBe('verify');
});

test('S4 a connector that loses read while the wake waits is withdrawn before the next send', async () => {
  const c = await connector(); const implementer = await account();
  const t = await task({ status: 'in-progress', owner: implementer });
  await pool.query('UPDATE tasks SET verifier_principal_id=$2 WHERE id=$1', [t.id, await agentOf(c, t.id)]);
  await grantRead(c.parent, t.id);
  const ws = await connect(c.authorization); await enabled(ws);
  await toReview(t.id);
  await firstWake(ws, t.id);
  await revokeRead(c.parent, t.id);
  const [audit] = await settled(t.id);
  expect(audit.action).toBe('connector.wake.superseded');
  expect(audit.metadata).toMatchObject({ kind: 'verify', taskStatus: 'review', sends: 1 });
  expect(wakes(ws, t.id)).toHaveLength(1);
});

test('S4 verify is withdrawn when the Task leaves Review', async () => {
  const c = await connector(); const implementer = await account();
  const t = await task({ status: 'in-progress', owner: implementer, verifier: c.id });
  const ws = await connect(c.authorization); await enabled(ws);
  await toReview(t.id);
  await firstWake(ws, t.id);
  await pool.query("UPDATE tasks SET status='in-progress' WHERE id=$1", [t.id]);
  const [audit] = await settled(t.id);
  expect(audit.action).toBe('connector.wake.superseded');
  expect(audit.metadata).toMatchObject({ kind: 'verify', taskStatus: 'in-progress' });
  expect((await streamOf(t.id, 'connector.wake'))[0].content)
    .toBe('Verify wake withdrawn before an acknowledgement: the task left Review, its Verifier changed or the item closed (status in-progress).');
});

test('S4 verify is withdrawn when the Verifier changes, even inside the same subtree', async () => {
  const c = await connector(); const implementer = await account();
  const t = await task({ status: 'in-progress', owner: implementer, verifier: c.id });
  await grantRead(c.parent, t.id);
  const ws = await connect(c.authorization); await enabled(ws);
  await toReview(t.id);
  await firstWake(ws, t.id);
  // Still the Connector's item (its Agent is now the Verifier), but not the Verifier it was rung for.
  await pool.query('UPDATE tasks SET verifier_principal_id=$2 WHERE id=$1', [t.id, await agentOf(c, t.id)]);
  const [audit] = await settled(t.id);
  expect(audit.action).toBe('connector.wake.superseded');
  expect(audit.metadata).toMatchObject({ kind: 'verify', taskStatus: 'review' });
  expect(wakes(ws, t.id)).toHaveLength(1);
});

test('S4 a Verifier change through the roles writer withdraws the old wake and rings the new Verifier connector', async () => {
  const c = await connector(); const next = await connector(); const implementer = await account();
  const t = await task({ status: 'in-progress', owner: implementer, verifier: c.id });
  const mine = await connect(c.authorization); const theirs = await connect(next.authorization);
  await enabled(mine); await enabled(theirs);
  await toReview(t.id);
  await firstWake(mine, t.id);
  // The roles writer, as an administrator assigns through it (it emits the Verifier-change feed event).
  const assigner = { principalId: t.creator, handle: 'fixture-admin', role: 'admin', scopes: ['root'], authenticated: true };
  expect(await taskManagerDB.assignTaskRoles(t.id, { verifierPrincipalId: next.id },
    { principalId: t.creator, handle: 'fixture-admin', authMethod: 'session' }, undefined, assigner)).toBe('updated');
  expect((await firstWake(theirs, t.id)).kind).toBe('verify');
  const superseded = await until(async () => (await receipts(t.id)).find((row: any) => row.action === 'connector.wake.superseded'));
  expect(superseded.metadata).toMatchObject({ kind: 'verify', connectorPrincipalId: c.id });
});

test('S4 dedupe in flight: a second opening event for the same occurrence rings nothing more', async () => {
  const c = await connector(); const implementer = await account();
  const t = await task({ status: 'in-progress', owner: implementer, verifier: c.id });
  const ws = await connect(c.authorization); await enabled(ws);
  await toReview(t.id);
  await firstWake(ws, t.id);
  await emit(t.id, 'task.review_requested', { reviewId: crypto.randomUUID() });
  await pause(QUIET_MS);
  expect(new Set(wakes(ws, t.id).map(f => f.wakeId)).size).toBe(1);
  expect(raised(t.id)).toHaveLength(1);
  expect(await receipts(t.id)).toEqual([]);
});

test('S4 dedupe after settling: the same open occurrence is not rung again', async () => {
  const c = await connector(); const implementer = await account();
  const t = await task({ status: 'in-progress', owner: implementer, verifier: c.id });
  const ws = await connect(c.authorization); await enabled(ws);
  await toReview(t.id);
  const frame = await firstWake(ws, t.id);
  ws.send(JSON.stringify({ type: 'wake.ack', wakeId: frame.wakeId }));
  await settled(t.id);
  // Settled, and still the same open item: another opening event does not ring it again.
  // A scan that began before the acknowledgement may read the first event against
  // its older in-flight list, so the event is emitted twice and each is awaited by
  // its positive marker: the second is read by a scan that began after the
  // settle, where only the remembered occurrence can stop a second ring.
  await emit(t.id, 'task.updated', { fields: ['verifierPrincipalId'] });
  await evaluated(c.id, t.id);
  await emit(t.id, 'task.updated', { fields: ['verifierPrincipalId'] });
  await evaluated(c.id, t.id);
  expect(raised(t.id)).toEqual([]);
  await pause(QUIET_MS);
  expect(new Set(wakes(ws, t.id).map(f => f.wakeId)).size).toBe(1);
  expect((await receipts(t.id)).map((row: any) => row.action)).toEqual(['connector.wake.acknowledged']);
});

test('S4 a wake=1 connector is never rung for verify, and its implement wake is unchanged', async () => {
  const c = await connector(); const implementer = await account();
  const t = await task({ status: 'in-progress', owner: implementer, verifier: c.id });
  const ws = await connect(c.authorization, '?wake=1'); await enabled(ws);
  await toReview(t.id);
  // Longer than a whole wake budget: a wake raised here would have settled `offline` by now.
  await pause(QUIET_MS + 4000);
  expect(wakes(ws, t.id)).toEqual([]);
  expect(raised(t.id)).toEqual([]);
  expect(await receipts(t.id)).toEqual([]);
  // Hermes's path: the implement wake on a wake=1 socket is the protocol-1 frame, no kind.
  const ready = await task({ status: 'todo' });
  await grantRead(c.parent, ready.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE tasks SET execution_service_id=$2, execution_descriptor_version=1, execution_profile=$3::jsonb, auto_start=TRUE WHERE id=$1',
      [ready.id, c.serviceId, JSON.stringify({ serviceId: c.serviceId, descriptorVersion: 1, options: {} })]);
    expect(await syncTaskReadiness(client, ready.id)).toBe(true);
    await client.query('COMMIT');
  } finally { client.release(); }
  expect(await firstWake(ws, ready.id)).toEqual({ type: 'wake', wakeId: expect.any(String), taskId: ready.id, cursor: expect.stringMatching(/^\d+$/), attempt: 1 });
});

test('S4 on a mixed endpoint only the wake=2 socket hears verify', async () => {
  const c = await connector(); const implementer = await account();
  const t = await task({ status: 'in-progress', owner: implementer, verifier: c.id });
  const old = await connect(c.authorization, '?wake=1'); await enabled(old);
  const ws = await connect(c.authorization, '?wake=2'); await enabled(ws);
  await toReview(t.id);
  await firstWake(ws, t.id);
  await pause(QUIET_MS);
  expect(wakes(ws, t.id).length).toBeGreaterThan(0);
  expect(wakes(old, t.id)).toEqual([]);
});

test('S4 a wake=1 acknowledgement cannot settle a verify wake', async () => {
  const c = await connector(); const implementer = await account();
  const t = await task({ status: 'in-progress', owner: implementer, verifier: c.id });
  const old = await connect(c.authorization, '?wake=1'); await enabled(old);
  const ws = await connect(c.authorization, '?wake=2'); await enabled(ws);
  await toReview(t.id);
  const frame = await firstWake(ws, t.id);
  old.send(JSON.stringify({ type: 'wake.ack', wakeId: frame.wakeId }));
  await pause(300);
  expect(await receipts(t.id)).toEqual([]);
  ws.send(JSON.stringify({ type: 'wake.ack', wakeId: frame.wakeId }));
  expect((await settled(t.id)).map((row: any) => row.action)).toEqual(['connector.wake.acknowledged']);
});

test('S4 a connector is never rung to verify a Task it executes', async () => {
  const c = await connector(); const implementer = await account();
  const own = await task({ status: 'in-progress', owner: implementer, executionServiceId: c.serviceId });
  await pool.query('UPDATE tasks SET verifier_principal_id=$2 WHERE id=$1', [own.id, await agentOf(c, own.id)]);
  await grantRead(c.parent, own.id);
  const ws = await connect(c.authorization); await enabled(ws);
  await toReview(own.id);
  await pause(QUIET_MS);
  expect(wakes(ws, own.id)).toEqual([]);
  expect(raised(own.id)).toEqual([]);
  expect(await receipts(own.id)).toEqual([]);
});

test('S4 a connector is never rung to verify a Task its own subtree is the Assignee of', async () => {
  const c = await connector();
  const own = await task({ status: 'in-progress' });
  const doer = await agentOf(c, own.id);
  const judge = await agentOf(c, own.id);
  await pool.query('UPDATE tasks SET owner_principal_id=$2, verifier_principal_id=$3 WHERE id=$1', [own.id, doer, judge]);
  await grantRead(c.parent, own.id);
  const ws = await connect(c.authorization); await enabled(ws);
  await toReview(own.id);
  await pause(QUIET_MS);
  expect(wakes(ws, own.id)).toEqual([]);
  expect(raised(own.id)).toEqual([]);
  expect(await receipts(own.id)).toEqual([]);
});

test('S4 stuck rings its exact addressee: the Shepherd, never the Assignee under a Shepherd', async () => {
  const c = await connector(); const shepherd = await account();
  const underShepherd = await task({ status: 'in-progress', owner: c.id, shepherd });
  const ws = await connect(c.authorization); await enabled(ws);
  await emit(underShepherd.id, 'task.stuck', { reason: 'lease-expired' });
  await pause(QUIET_MS);
  expect(wakes(ws, underShepherd.id)).toEqual([]);
  expect(raised(underShepherd.id)).toEqual([]);
  // Negative control: the Connector as Shepherd is the addressee.
  const shepherded = await task({ status: 'in-progress', owner: await account(), shepherd: c.id });
  await emit(shepherded.id, 'task.stuck', { reason: 'lease-expired' });
  expect((await firstWake(ws, shepherded.id)).kind).toBe('stuck');
  expect(await actionKeys(c.authorization)).toContain(`stuck:${shepherded.id}`);
});

test('S4 stuck is withdrawn when its item closes', async () => {
  const c = await connector();
  const t = await task({ status: 'in-progress', owner: await account(), shepherd: c.id });
  const ws = await connect(c.authorization); await enabled(ws);
  await emit(t.id, 'task.updated', { status: 'stuck', previousStatus: 'in-progress', fields: ['status'] },
    ["UPDATE tasks SET status='stuck' WHERE id=$1", [t.id]]);
  expect((await firstWake(ws, t.id)).kind).toBe('stuck');
  await pool.query("UPDATE tasks SET status='completed' WHERE id=$1", [t.id]);
  const [audit] = await settled(t.id);
  expect(audit.action).toBe('connector.wake.superseded');
  expect(audit.metadata).toMatchObject({ kind: 'stuck', taskStatus: 'completed' });
});

test('S4 an outcome is accepted only on the acknowledging socket, and becomes a connector.trigger entry and audit row', async () => {
  const c = await connector(); const implementer = await account();
  const t = await task({ status: 'in-progress', owner: implementer, verifier: c.id });
  const first = await connect(c.authorization); const second = await connect(c.authorization);
  await enabled(first); await enabled(second);
  await toReview(t.id);
  const frame = await firstWake(first, t.id);
  first.send(JSON.stringify({ type: 'wake.ack', wakeId: frame.wakeId }));
  await settled(t.id);
  second.send(JSON.stringify({ type: 'wake.outcome', wakeId: frame.wakeId, outcome: 'notified' }));
  await pause(300);
  expect(await receipts(t.id, 'connector.trigger.')).toEqual([]);
  first.send(JSON.stringify({ type: 'wake.outcome', wakeId: frame.wakeId, outcome: 'notified', reason: 'INTERACTIVE_CONNECTOR' }));
  const [audit] = await until(async () => { const rows = await receipts(t.id, 'connector.trigger.'); return rows.length ? rows : undefined; });
  expect(audit).toMatchObject({ action: 'connector.trigger.notified', actor_principal_id: c.id, auth_method: 'principal_api_key' });
  expect(audit.metadata).toMatchObject({ wakeId: frame.wakeId, kind: 'verify', outcome: 'notified', reason: 'INTERACTIVE_CONNECTOR', taskId: t.id });
  const [entry] = await streamOf(t.id, 'connector.trigger');
  expect(entry).toMatchObject({ provenance: 'system', author_principal_id: null });
  expect(entry.content).toBe('The connector reported that it notified a person instead of running for its verify wake (INTERACTIVE_CONNECTOR).');
});

test("S4 the connector.trigger entry is on the Task Timeline's System view", async () => {
  const c = await connector(); const implementer = await account();
  const t = await task({ status: 'in-progress', owner: implementer, verifier: c.id });
  const ws = await connect(c.authorization); await enabled(ws);
  await toReview(t.id);
  const frame = await firstWake(ws, t.id);
  ws.send(JSON.stringify({ type: 'wake.ack', wakeId: frame.wakeId }));
  await settled(t.id);
  ws.send(JSON.stringify({ type: 'wake.outcome', wakeId: frame.wakeId, outcome: 'started' }));
  await until(async () => ((await streamOf(t.id, 'connector.trigger')).length ? true : undefined));
  const session = await loginSessionService.mint({ principalId: t.creator });
  const cookie = `${SESSION_COOKIE_NAME}=${session.token}`;
  const system = await get(cookie, `/tasks/${t.id}/timeline?filter=system`);
  expect(system.status).toBe(200);
  const types = (system.json?.events ?? []).map((event: any) => event.eventType);
  expect(types).toEqual(expect.arrayContaining(['connector.wake', 'connector.trigger']));
});

test('S4 outcomes are taken in order: finished needs started, and nothing follows the end', async () => {
  const c = await connector(); const implementer = await account();
  const t = await task({ status: 'in-progress', owner: implementer, verifier: c.id });
  const ws = await connect(c.authorization); await enabled(ws);
  await toReview(t.id);
  const frame = await firstWake(ws, t.id);
  ws.send(JSON.stringify({ type: 'wake.ack', wakeId: frame.wakeId }));
  await settled(t.id);
  ws.send(JSON.stringify({ type: 'wake.outcome', wakeId: frame.wakeId, outcome: 'finished' }));
  await pause(300);
  expect(await receipts(t.id, 'connector.trigger.')).toEqual([]);
  ws.send(JSON.stringify({ type: 'wake.outcome', wakeId: frame.wakeId, outcome: 'started' }));
  ws.send(JSON.stringify({ type: 'wake.outcome', wakeId: frame.wakeId, outcome: 'finished' }));
  ws.send(JSON.stringify({ type: 'wake.outcome', wakeId: frame.wakeId, outcome: 'started' }));
  await until(async () => ((await receipts(t.id, 'connector.trigger.')).length >= 2 ? true : undefined));
  await pause(300);
  expect((await receipts(t.id, 'connector.trigger.')).map((row: any) => row.action))
    .toEqual(['connector.trigger.started', 'connector.trigger.finished']);
});

test('S4 an outcome from a connector that can no longer read the Task writes nothing', async () => {
  const c = await connector(); const implementer = await account();
  const t = await task({ status: 'in-progress', owner: implementer });
  await pool.query('UPDATE tasks SET verifier_principal_id=$2 WHERE id=$1', [t.id, await agentOf(c, t.id)]);
  await grantRead(c.parent, t.id);
  const ws = await connect(c.authorization); await enabled(ws);
  await toReview(t.id);
  const frame = await firstWake(ws, t.id);
  ws.send(JSON.stringify({ type: 'wake.ack', wakeId: frame.wakeId }));
  await settled(t.id);
  await revokeRead(c.parent, t.id);
  ws.send(JSON.stringify({ type: 'wake.outcome', wakeId: frame.wakeId, outcome: 'started' }));
  await pause(600);
  expect(await receipts(t.id, 'connector.trigger.')).toEqual([]);
  expect(await streamOf(t.id, 'connector.trigger')).toEqual([]);
});

test('S4 restart: a wake lost with the process is found by the catch-up pull, with no new core state', async () => {
  const c = await connector(); const implementer = await account();
  const t = await task({ status: 'in-progress', owner: implementer, verifier: c.id });
  const stuck = await task({ status: 'in-progress', owner: await account(), shepherd: c.id });
  // The Connector is not subscribed (the board restarted, or it was down): nothing is rung.
  await toReview(t.id);
  await emit(stuck.id, 'task.stuck', { reason: 'lease-expired' });
  // On reconnect the new endpoint starts at the feed head, so the past events ring nothing...
  const ws = await connect(c.authorization); await enabled(ws);
  await pause(QUIET_MS);
  expect(wakes(ws, t.id)).toEqual([]);
  // ...and the Connector's catch-up pull, under its own bearer, lists both items.
  const keys = await actionKeys(c.authorization);
  expect(keys).toEqual(expect.arrayContaining([`verify:${t.id}`, `stuck:${stuck.id}`]));
});
