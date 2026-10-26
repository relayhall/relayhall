/**
 * Card 6dea3cca — END TO END against the REAL server process. `src/server.ts`
 * is spawned exactly as it boots (its own wiring, its own background
 * dispatcher, PRODUCTION wake timings); the only double is the Connector,
 * which is a plain WebSocket client holding a real database-issued credential.
 *
 *  1. Wake path: assign + arm a Task to the Connector, receive the wake on
 *     `/events/ws?wake=1`, acknowledge it with the provider's model metadata,
 *     and read the receipt back from the audit log, the Task stream and the
 *     telemetry envelope table.
 *  2. Negative control: the same Connector offline. The board records
 *     `offline` with no telemetry, and the work is still reachable by the
 *     fallback the card names: polling `GET /events` and reconnecting from the
 *     saved cursor.
 *
 * Never runs without a disposable DB URL; the spawned server is pointed at
 * that database and nothing else.
 */
import crypto from 'crypto';
import net from 'net';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { WebSocket } from 'ws';
const databaseUrl = process.env.RELAYHALL_TEST_DB_URL;
if (!databaseUrl) throw new Error('RELAYHALL_TEST_DB_URL required; this integration gate never skips');
const parsed = new URL(databaseUrl);
const database = decodeURIComponent(parsed.pathname.slice(1));
const local = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) && /test|contract|fixture/.test(database);
const ci = process.env.CI === 'true' && parsed.hostname === 'postgres' && database === 'relayhall_ci';
if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod'].includes(database) || (!local && !ci)) throw new Error('Refusing a non-disposable database');
const dbEnv = {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: database,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
};
Object.assign(process.env, dbEnv, { NODE_ENV: 'test' });
const { pool } = require('../db/connection');
const { principalService } = require('../services/PrincipalService');
const { syncTaskReadiness } = require('../utils/taskReadiness');
const { wakeBudgetMs } = require('../services/ConnectorWakeService');
jest.setTimeout(120000);

const BACKEND_DIR = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(BACKEND_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PRODUCT = 'wake-process-fixture';
const system = { handle: 'connector-wake-process-fixture', authMethod: 'system' };
const tag = () => 'wakep-' + crypto.randomBytes(6).toString('hex');
let child: ChildProcess | null = null;
let output = '';
let port = 0;
const sockets: WebSocket[] = [];
const inbox = new Map<WebSocket, any[]>();

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address() as net.AddressInfo;
      probe.close(() => resolve(address.port));
    });
  });
}
async function until<T>(fn: () => Promise<T | undefined> | T | undefined, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn(); if (value !== undefined) return value;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}\n--- server output (tail) ---\n${output.slice(-4000)}`);
}
async function account(): Promise<string> {
  const r = await pool.query("INSERT INTO principals(kind,handle,display_name,status,role) VALUES('human',$1,$1,'active','user') RETURNING id", [tag()]);
  return r.rows[0].id;
}
async function connector(parent: string) {
  const r = await pool.query("INSERT INTO principals(kind,handle,display_name,status,role,parent_principal_id,purpose,own_expression) VALUES('service',$1,$1,'active','user',$2,'wake process fixture',$3::jsonb) RETURNING id", [tag(), parent, JSON.stringify({ scopes: 'parent', objects: 'parent' })]);
  const id = r.rows[0].id;
  const svc = await pool.query(
    `INSERT INTO services(slug,name,kind,status,principal_id,delivery_mode,delivery_poll_interval_seconds,current_descriptor_version)
     VALUES($1,$1,'connector','published',$2,'poll',30,1) RETURNING id`, [tag(), id]);
  const descriptor = { options: [], telemetry: { tier: 'full', products: [PRODUCT] } };
  await pool.query(
    `INSERT INTO service_descriptor_versions(service_id,version,descriptor,content_hash) VALUES($1,1,$2::jsonb,$3)`,
    [svc.rows[0].id, JSON.stringify(descriptor), crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex')]);
  const credential = await principalService.issueCredential({ principalId: id, scopes: ['tasks:read', 'telemetry:write'], transport: 'api' }, system);
  return { id, serviceId: svc.rows[0].id as string, authorization: 'Bearer ' + credential.fullKey };
}
async function readableTask(owner: string, reader: string): Promise<string> {
  const r = await pool.query("INSERT INTO tasks(title,status,visibility,creator_principal_id) VALUES($1,'todo','private',$2) RETURNING id", [tag(), owner]);
  await pool.query("INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id) VALUES('principal',$1,'task',$2,'read',$1)", [reader, r.rows[0].id]);
  return r.rows[0].id;
}
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
async function connect(authorization: string, query: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/events/ws${query}`, { headers: { Authorization: authorization } });
    sockets.push(ws); inbox.set(ws, []);
    ws.on('message', data => inbox.get(ws)!.push(JSON.parse(data.toString())));
    ws.on('error', () => undefined);
    const timer = setTimeout(() => reject(new Error('Upgrade timed out')), 10000);
    ws.once('open', () => { clearTimeout(timer); resolve(ws); });
    ws.once('unexpected-response', (_req, res) => { clearTimeout(timer); res.resume(); reject(new Error('upgrade refused with ' + res.statusCode)); });
  });
}
const frame = (ws: WebSocket, match: (f: any) => boolean, what: string, ms = 20000) =>
  until(() => inbox.get(ws)!.find(match), ms, what);
const receipt = (taskId: string, ms: number) => until(async () => {
  const rows = (await pool.query("SELECT * FROM audit_events WHERE resource_type='task' AND resource_id=$1 AND action LIKE 'connector.wake.%'", [taskId])).rows;
  return rows.length ? rows : undefined;
}, ms, `the wake receipt for ${taskId}`);

beforeAll(async () => {
  port = await freePort();
  const credentialKeys = process.env.RELAYHALL_CREDENTIAL_KEYS ?? '';
  const activeKey = process.env.RELAYHALL_CREDENTIAL_ACTIVE_KEY ?? '';
  // The server is a separate process: its own module graph, its own wiring.
  // `detached` gives it a process group of its own so teardown leaves no orphan.
  child = spawn(process.execPath, [TSX_CLI, 'src/server.ts'], {
    cwd: BACKEND_DIR,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'test', PORT: String(port),
      ...dbEnv,
      JWT_SECRET: crypto.randomBytes(48).toString('hex'),
      RELAYHALL_CREDENTIAL_KEYS: credentialKeys, RELAYHALL_CREDENTIAL_ACTIVE_KEY: activeKey,
      RELAYHALL_TELEMETRY_PEPPERS: JSON.stringify({ wakeprocess: crypto.randomBytes(32).toString('base64') }),
      RELAYHALL_TELEMETRY_ACTIVE_PEPPER: 'wakeprocess',
    },
  });
  child.stdout!.on('data', d => { output += String(d); });
  child.stderr!.on('data', d => { output += String(d); });
  await until(async () => {
    if (child?.exitCode !== null) throw new Error(`server exited early\n${output.slice(-4000)}`);
    try { return (await fetch(`http://127.0.0.1:${port}/health`)).status === 200 ? true : undefined; } catch { return undefined; }
  }, 90000, 'the spawned server to answer /health');
});
afterEach(() => { for (const ws of sockets.splice(0)) ws.terminate(); inbox.clear(); });
afterAll(async () => {
  if (child?.pid && child.exitCode === null) {
    const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()));
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    const timer = setTimeout(() => { try { process.kill(-child!.pid!, 'SIGKILL'); } catch { /* gone */ } }, 10000);
    await exited;
    clearTimeout(timer);
  }
  await pool.end();
});

test('wake path: the real server wakes the connector and records the receipt with the provider-reported model', async () => {
  const owner = await account(); const parent = await account();
  const c = await connector(parent); const taskId = await readableTask(owner, parent);
  const ws = await connect(c.authorization, '?wake=1');
  expect(await frame(ws, f => f.type === 'wake.status', 'wake.status')).toEqual({ type: 'wake.status', enabled: true });
  const armedAt = Date.now();
  await assignAndArm(taskId, c.serviceId);
  const wake: any = await frame(ws, f => f.type === 'wake' && f.taskId === taskId, 'the wake frame');
  const wakeLatencyMs = Date.now() - armedAt;
  // Within one dispatcher interval plus scheduling slack.
  expect(wakeLatencyMs).toBeLessThan(5000);
  const sent = {
    schema_version: 'rh.ai.telemetry/1.0', event_id: tag(), occurred_at: new Date().toISOString(),
    kind: 'session', phase: 'started', source: { product: PRODUCT, adapter: 'fake-connector', mechanism: 'push' },
    model: { provider: 'openai-codex', requested: 'gpt-5.6-sol', resolved: 'gpt-5.6-sol-2026-09-01' },
  };
  ws.send(JSON.stringify({ type: 'wake.ack', wakeId: wake.wakeId, telemetry: sent }));

  const [audit] = await receipt(taskId, 20000);
  expect(audit).toMatchObject({ action: 'connector.wake.acknowledged', actor_principal_id: c.id, auth_method: 'principal_api_key' });
  expect(audit.metadata).toMatchObject({
    wakeId: wake.wakeId, outcome: 'acknowledged', attempts: 1, sends: 1, fallback: null,
    modelIdentity: 'provider-reported',
    reported: { model: { provider: 'openai-codex', requested: 'gpt-5.6-sol', resolved: 'gpt-5.6-sol-2026-09-01' } },
    telemetry: { stored: true },
  });
  const stream = (await pool.query("SELECT * FROM task_stream_entries WHERE task_id=$1 AND event_type='connector.wake'", [taskId])).rows;
  expect(stream).toHaveLength(1);
  expect(stream[0].provenance).toBe('system');
  expect(stream[0].metadata).toEqual(audit.metadata);
  const envelopes = (await pool.query('SELECT * FROM session_events WHERE connector_id=$1', [c.id])).rows;
  expect(envelopes).toHaveLength(1);
  expect(envelopes[0].event_id).toBe(audit.metadata.telemetry.eventId);
  expect(envelopes[0].payload.model.resolved).toBe('gpt-5.6-sol-2026-09-01');
});

test('NEGATIVE CONTROL: offline connector -> offline receipt, no telemetry, and the polling and reconnect fallback still find the work', async () => {
  const owner = await account(); const parent = await account();
  const c = await connector(parent); const taskId = await readableTask(owner, parent);
  const ws = await connect(c.authorization, '?wake=1');
  await frame(ws, f => f.type === 'wake.status', 'wake.status');
  const closed = new Promise<void>(resolve => ws.once('close', () => resolve()));
  ws.close(); await closed;
  await assignAndArm(taskId, c.serviceId);

  const [audit] = await receipt(taskId, wakeBudgetMs() + 15000);
  expect(audit).toMatchObject({ action: 'connector.wake.offline', auth_method: 'system', actor_principal_id: null });
  expect(audit.metadata).toMatchObject({
    outcome: 'offline', attempts: 4, sends: 0, fallback: 'polling', modelIdentity: 'not-reported',
    reported: null, telemetry: { stored: false, code: 'NOT_ACKNOWLEDGED' },
  });
  expect((await pool.query('SELECT 1 FROM session_events WHERE connector_id=$1', [c.id])).rows).toEqual([]);

  // Fallback 1 — polling: the real GET /events, with the Connector's own credential.
  const since = String(BigInt(audit.metadata.feedCursor) - 1n);
  const polled = await fetch(`http://127.0.0.1:${port}/events?cursor=${since}`, { headers: { Authorization: c.authorization } });
  expect(polled.status).toBe(200);
  const body: any = await polled.json();
  expect(body.events.some((e: any) => e.name === 'task.ready' && e.objectId === taskId)).toBe(true);

  // Fallback 2 — reconnect from the saved cursor: the go signal is redelivered.
  const back = await connect(c.authorization, `?cursor=${since}&wake=1`);
  const page: any = await frame(back, f => f.type === 'events' && f.events.length > 0, 'the resumed events frame');
  expect(page.events.some((e: any) => e.name === 'task.ready' && e.objectId === taskId)).toBe(true);
  // A settled wake is never re-sent on the new socket.
  await new Promise(r => setTimeout(r, 2500));
  expect(inbox.get(back)!.some(f => f.type === 'wake' && f.taskId === taskId)).toBe(false);
});
