/**
 * Card 6dea3cca — the wake RECEIPT rows against a real PostgreSQL: the audit
 * row, the system Task stream entry and (for an acknowledgement only) the
 * telemetry envelope row, written through real credentials, real delegation,
 * the real feed and the real `task.ready` derivation, over a real socket.
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
  // A test-only pseudonymization pepper, so the envelope store can run.
  RELAYHALL_TELEMETRY_PEPPERS: JSON.stringify({ wakefixture: crypto.randomBytes(32).toString('base64') }),
  RELAYHALL_TELEMETRY_ACTIVE_PEPPER: 'wakefixture',
});
const { pool } = require('../db/connection');
const { principalService } = require('../services/PrincipalService');
const { feedEventService } = require('../services/FeedEventService');
const { subscriberActorService } = require('../services/SubscriberActorService');
const { syncTaskReadiness } = require('../utils/taskReadiness');
const { ConnectorNotificationService } = require('../services/ConnectorNotificationService');
const { ConnectorWakeService, DEFAULT_WAKE_CONFIG } = require('../services/ConnectorWakeService');
jest.setTimeout(60000);

const PRODUCT = 'wake-fixture';
const system = { handle: 'connector-wake-db-fixture', authMethod: 'system' };
const tag = () => 'wake-' + crypto.randomBytes(6).toString('hex');
let server: http.Server; let notifications: any; let wake: any; let port: number;
const sockets: WebSocket[] = [];
const inbox = new Map<WebSocket, any[]>();
// Fast but real: the same dispatcher with a short backoff (budget 200+400+800+800 ms).
const FAST = { ...DEFAULT_WAKE_CONFIG, intervalMs: 50, backoffBaseMs: 200, backoffMaxMs: 800 };

async function account(): Promise<string> {
  const r = await pool.query("INSERT INTO principals(kind,handle,display_name,status,role) VALUES('human',$1,$1,'active','user') RETURNING id", [tag()]);
  return r.rows[0].id;
}
async function connector(parent: string, scopes = ['tasks:read', 'telemetry:write']) {
  const r = await pool.query("INSERT INTO principals(kind,handle,display_name,status,role,parent_principal_id,purpose,own_expression) VALUES('service',$1,$1,'active','user',$2,'wake receipt fixture',$3::jsonb) RETURNING id", [tag(), parent, JSON.stringify({ scopes: 'parent', objects: 'parent' })]);
  const id = r.rows[0].id;
  const slug = tag();
  const svc = await pool.query(
    `INSERT INTO services(slug,name,kind,status,principal_id,delivery_mode,delivery_poll_interval_seconds,current_descriptor_version)
     VALUES($1,$1,'connector','published',$2,'poll',30,1) RETURNING id`, [slug, id]);
  const descriptor = { options: [], telemetry: { tier: 'full', products: [PRODUCT] } };
  await pool.query(
    `INSERT INTO service_descriptor_versions(service_id,version,descriptor,content_hash) VALUES($1,1,$2::jsonb,$3)`,
    [svc.rows[0].id, JSON.stringify(descriptor), crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex')]);
  const credential = await principalService.issueCredential({ principalId: id, scopes, transport: 'api' }, system);
  return { id, serviceId: svc.rows[0].id as string, authorization: 'Bearer ' + credential.fullKey };
}
async function readableTask(owner: string, reader: string): Promise<string> {
  const r = await pool.query("INSERT INTO tasks(title,status,visibility,creator_principal_id) VALUES($1,'todo','private',$2) RETURNING id", [tag(), owner]);
  await pool.query("INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id) VALUES('principal',$1,'task',$2,'read',$1)", [reader, r.rows[0].id]);
  return r.rows[0].id;
}
/** Assign and arm, then let the PRODUCTION readiness derivation announce `task.ready`. */
async function assignAndArm(taskId: string, serviceId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE tasks SET execution_service_id=$2, execution_descriptor_version=1, execution_profile=$3::jsonb, auto_start=TRUE WHERE id=$1',
      [taskId, serviceId, JSON.stringify({ serviceId, descriptorVersion: 1, options: {} })]);
    expect(await syncTaskReadiness(client, taskId)).toBe(true);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
async function connect(authorization: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/events/ws?wake=1`, { headers: { Authorization: authorization } });
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
const frame = (ws: WebSocket, type: string, taskId?: string) =>
  until(() => inbox.get(ws)!.find(f => f.type === type && (!taskId || f.taskId === taskId)));
async function receipt(taskId: string) {
  return until(async () => {
    const audit = await pool.query("SELECT * FROM audit_events WHERE resource_type='task' AND resource_id=$1 AND action LIKE 'connector.wake.%'", [taskId]);
    return audit.rows.length ? audit.rows : undefined;
  });
}
async function streamEntries(taskId: string) {
  return (await pool.query("SELECT * FROM task_stream_entries WHERE task_id=$1 AND event_type='connector.wake' ORDER BY stream_offset", [taskId])).rows;
}
async function envelopeRows(connectorId: string) {
  return (await pool.query('SELECT * FROM session_events WHERE connector_id=$1 ORDER BY ingested_at', [connectorId])).rows;
}
function envelope(model: Record<string, string>) {
  return {
    schema_version: 'rh.ai.telemetry/1.0', event_id: 'wake-' + crypto.randomBytes(6).toString('hex'),
    occurred_at: new Date().toISOString(), kind: 'session', phase: 'started',
    source: { product: PRODUCT, adapter: 'fake-connector', mechanism: 'push' },
    model,
  };
}

beforeAll(async () => {
  server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  wake = new ConnectorWakeService(pool, FAST);
  notifications = new ConnectorNotificationService(server, 50, wake);
  wake.start();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as any).port;
});
afterEach(() => { for (const ws of sockets.splice(0)) ws.terminate(); inbox.clear(); });
afterAll(async () => {
  wake?.stop(); notifications?.shutdown();
  if (server) await new Promise<void>(r => server.close(() => r()));
  await pool.end();
});

test('an acknowledged wake writes the audit row, the stream entry and the telemetry row with the provider-reported model', async () => {
  const owner = await account(); const parent = await account();
  const c = await connector(parent); const taskId = await readableTask(owner, parent);
  const ws = await connect(c.authorization);
  expect(await frame(ws, 'wake.status')).toEqual({ type: 'wake.status', enabled: true });
  await assignAndArm(taskId, c.serviceId);
  const wakeFrame: any = await frame(ws, 'wake', taskId);
  expect(wakeFrame).toEqual({ type: 'wake', wakeId: expect.any(String), taskId, cursor: expect.stringMatching(/^\d+$/), attempt: 1 });
  const sent = envelope({ provider: 'openai-codex', requested: 'gpt-5.6-sol', resolved: 'gpt-5.6-sol-2026-09-01' });
  ws.send(JSON.stringify({ type: 'wake.ack', wakeId: wakeFrame.wakeId, telemetry: sent }));

  const [audit] = await receipt(taskId);
  expect(audit).toMatchObject({ action: 'connector.wake.acknowledged', outcome: 'success', actor_principal_id: c.id, auth_method: 'principal_api_key' });
  expect(audit.credential_id).toEqual(expect.any(String));
  expect(audit.metadata).toMatchObject({
    wakeId: wakeFrame.wakeId, outcome: 'acknowledged', serviceId: c.serviceId, connectorPrincipalId: c.id, taskId,
    feedCursor: wakeFrame.cursor, attempts: 1, sends: 1, fallback: null, modelIdentity: 'provider-reported',
    reported: { kind: 'session', phase: 'started', eventId: sent.event_id, source: { product: PRODUCT, adapter: 'fake-connector' },
      model: { provider: 'openai-codex', requested: 'gpt-5.6-sol', resolved: 'gpt-5.6-sol-2026-09-01' } },
    telemetry: { stored: true, duplicate: false },
  });
  expect(audit.metadata.latencyMs).toBeGreaterThanOrEqual(0);

  const stream = await streamEntries(taskId);
  expect(stream).toHaveLength(1);
  expect(stream[0]).toMatchObject({ provenance: 'system', author_principal_id: null });
  expect(stream[0].metadata).toEqual(audit.metadata);
  expect(stream[0].content).toContain('connector-reported provider model gpt-5.6-sol-2026-09-01 (openai-codex)');

  // The telemetry sample IS the Connector's envelope, stored under the socket's chain.
  const rows = await envelopeRows(c.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ account_id: parent, source_product: PRODUCT });
  expect(rows[0].payload.model).toMatchObject({ provider: 'openai-codex', requested: 'gpt-5.6-sol', resolved: 'gpt-5.6-sol-2026-09-01' });
  // The receipt names the stored row, so the sample and the receipt cannot drift apart.
  expect(audit.metadata.telemetry.eventId).toBe(rows[0].event_id);

  // The wake changed nothing on the Task: the Connector still claims it the ordinary way.
  const task = (await pool.query('SELECT status, execution_service_id FROM tasks WHERE id=$1', [taskId])).rows[0];
  expect(task).toEqual({ status: 'todo', execution_service_id: c.serviceId });
});

test('an acknowledgement naming only the requested model is recorded as requested-only, never as an observed model', async () => {
  const owner = await account(); const parent = await account();
  const c = await connector(parent); const taskId = await readableTask(owner, parent);
  const ws = await connect(c.authorization); await frame(ws, 'wake.status');
  await assignAndArm(taskId, c.serviceId);
  const wakeFrame: any = await frame(ws, 'wake', taskId);
  ws.send(JSON.stringify({ type: 'wake.ack', wakeId: wakeFrame.wakeId, telemetry: envelope({ provider: 'openai-codex', requested: 'gpt-5.6-sol' }) }));
  const [audit] = await receipt(taskId);
  expect(audit.metadata).toMatchObject({ modelIdentity: 'requested-only', reported: { model: { provider: 'openai-codex', requested: 'gpt-5.6-sol' } } });
  expect(audit.metadata.reported.model.resolved).toBeUndefined();
  expect((await streamEntries(taskId))[0].content).toContain('only the requested model gpt-5.6-sol; no provider-reported model');
});

test('a credential without telemetry:write still acknowledges, but no telemetry is stored and the receipt says why', async () => {
  const owner = await account(); const parent = await account();
  const c = await connector(parent, ['tasks:read']); const taskId = await readableTask(owner, parent);
  const ws = await connect(c.authorization); await frame(ws, 'wake.status');
  await assignAndArm(taskId, c.serviceId);
  const wakeFrame: any = await frame(ws, 'wake', taskId);
  ws.send(JSON.stringify({ type: 'wake.ack', wakeId: wakeFrame.wakeId, telemetry: envelope({ resolved: 'gpt-5.6-sol-2026-09-01' }) }));
  const [audit] = await receipt(taskId);
  expect(audit.metadata).toMatchObject({ outcome: 'acknowledged', telemetry: { stored: false, stage: 'scope', code: 'TELEMETRY_SCOPE_REQUIRED' } });
  expect(await envelopeRows(c.id)).toEqual([]);
});

test('NEGATIVE CONTROL: an offline connector gets an offline receipt, no telemetry, and the work stays on the polling path', async () => {
  const owner = await account(); const parent = await account();
  const c = await connector(parent); const taskId = await readableTask(owner, parent);
  const ws = await connect(c.authorization); await frame(ws, 'wake.status');
  const closed = new Promise<void>(resolve => ws.once('close', () => resolve()));
  ws.close(); await closed;
  await assignAndArm(taskId, c.serviceId);
  const [audit] = await receipt(taskId);
  expect(audit).toMatchObject({ action: 'connector.wake.offline', actor_principal_id: null, auth_method: 'system' });
  expect(audit.metadata).toMatchObject({
    outcome: 'offline', attempts: 4, sends: 0, firstSentAt: null, acknowledgedAt: null, fallback: 'polling',
    modelIdentity: 'not-reported', reported: null, telemetry: { stored: false, code: 'NOT_ACKNOWLEDGED' },
  });
  const stream = await streamEntries(taskId);
  expect(stream.map((s: any) => s.content)).toEqual([
    'The assigned connector had no open notification socket across 4 wake attempts; the task falls back to polling.',
  ]);
  expect(await envelopeRows(c.id)).toEqual([]);
  // Fallback, exercised: the Connector's own pull still finds the go signal.
  const actor = await subscriberActorService.actorForConnector(c.serviceId);
  expect(actor.ok).toBe(true);
  const page = await feedEventService.listSince(actor.actor, audit.metadata.feedCursor - 1 + '', 50);
  expect(page.events.some((e: any) => e.name === 'task.ready' && e.objectId === taskId)).toBe(true);
});

test('a connector that never answers gets an unanswered receipt after the bounded retries', async () => {
  const owner = await account(); const parent = await account();
  const c = await connector(parent); const taskId = await readableTask(owner, parent);
  const ws = await connect(c.authorization); await frame(ws, 'wake.status');
  await assignAndArm(taskId, c.serviceId);
  const [audit] = await receipt(taskId);
  expect(audit).toMatchObject({ action: 'connector.wake.unanswered', auth_method: 'system' });
  expect(audit.metadata).toMatchObject({ outcome: 'unanswered', attempts: 4, sends: 4, fallback: 'polling', reported: null });
  expect(inbox.get(ws)!.filter(f => f.type === 'wake').map(f => f.attempt)).toEqual([1, 2, 3, 4]);
  expect(await envelopeRows(c.id)).toEqual([]);
});

test('a wake whose task leaves the ready state is withdrawn as superseded', async () => {
  const owner = await account(); const parent = await account();
  const c = await connector(parent); const taskId = await readableTask(owner, parent);
  const ws = await connect(c.authorization); await frame(ws, 'wake.status');
  await assignAndArm(taskId, c.serviceId);
  await frame(ws, 'wake', taskId);
  await pool.query("UPDATE tasks SET auto_start=FALSE WHERE id=$1", [taskId]);
  const [audit] = await receipt(taskId);
  expect(audit.action).toBe('connector.wake.superseded');
  expect(audit.metadata).toMatchObject({ outcome: 'superseded', taskStatus: 'todo', fallback: 'polling' });
});
