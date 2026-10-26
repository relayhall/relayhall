/**
 * Owner ruling E462 (universal harness connector design, section 6.8
 * "Verification modes", slice S4b) against a real PostgreSQL, real
 * credentials, the production routers and real sockets:
 *
 *   - migration 170: `none` never beside a Verifier, a setter always named,
 *     once cleared never again;
 *   - who may set `none` (the Shepherd, an administrator, the Account; never an
 *     Agent, never the implementing chain), when (before the Task started), the
 *     displaced default Verifier and the audit/Timeline rows;
 *   - finish on a `none` Task completes it, completes Subtasks in Review, and
 *     its dependent gets `task.ready` and an `implement` ring through the S4
 *     wake; a move to Review is refused; the setter re-check at finish;
 *   - the assigned-connector claim admits a `none` Task without a Verifier;
 *   - the `verifier-agent` arm with its negative controls (wrong parent, wrong
 *     role, another Task, a dead Warrant, a human Verifier), the chain guard
 *     G(Task) on the exact service Verifier and on the Agent, and never on a
 *     human Account Verifier;
 *   - the "no usable Verifier" filter and the legacy qa/reviewer arm skip
 *     `none`; the wake's own-work guard reads G(Task).
 *
 * Every test name starts `S4b ` so the mutation drill
 * (scripts/verification-modes-mutations.py) can name its red set. Never runs
 * without a disposable DB URL. Every row it writes is created under random
 * handles, so it can share a database with other suites.
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
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { authorizationRepository } = require('../services/AuthorizationRepository');
const routeRegistry = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { ConnectorNotificationService } = require('../services/ConnectorNotificationService');
const { ConnectorWakeService, DEFAULT_WAKE_CONFIG } = require('../services/ConnectorWakeService');
const { guardedPrincipalIds } = require('../services/VerificationModes');
jest.setTimeout(60000);

const system = { handle: 'verification-modes-fixture', authMethod: 'system' };
const tag = () => 'vm-' + crypto.randomBytes(6).toString('hex');
let server: http.Server; let notifications: any; let wake: any; let origin: string; let port: number;
const sockets: WebSocket[] = [];
const inbox = new Map<WebSocket, any[]>();
const FAST = { ...DEFAULT_WAKE_CONFIG, intervalMs: 50, backoffBaseMs: 600, backoffMaxMs: 1200 };
const WRITE = ['tasks:read', 'tasks:write', 'reports:read', 'reports:write'];

interface Connector { id: string; parent: string; serviceId: string; authorization: string }

async function account(): Promise<string> {
  const r = await pool.query("INSERT INTO principals(kind,handle,display_name,status,role) VALUES('human',$1,$1,'active','user') RETURNING id", [tag()]);
  return r.rows[0].id;
}
async function bearerOf(principalId: string, scopes = WRITE): Promise<string> {
  const credential = await principalService.issueCredential({ principalId, scopes, transport: 'api' }, system);
  return 'Bearer ' + credential.fullKey;
}
/** An Account holds no bearer credential: its own login session. */
async function sessionOf(principalId: string): Promise<string> {
  const session = await loginSessionService.mint({ principalId });
  return `${SESSION_COOKIE_NAME}=${session.token}`;
}
async function connector(parent?: string): Promise<Connector> {
  const owner = parent ?? await account();
  const r = await pool.query("INSERT INTO principals(kind,handle,display_name,status,role,parent_principal_id,purpose,own_expression) VALUES('service',$1,$1,'active','user',$2,'verification modes fixture',$3::jsonb) RETURNING id", [tag(), owner, JSON.stringify({ scopes: 'parent', objects: 'parent' })]);
  const id = r.rows[0].id;
  const slug = tag();
  const svc = await pool.query(
    `INSERT INTO services(slug,name,kind,status,principal_id,delivery_mode,delivery_poll_interval_seconds,current_descriptor_version)
     VALUES($1,$1,'connector','published',$2,'poll',30,1) RETURNING id`, [slug, id]);
  const descriptor = { options: [], telemetry: { tier: 'full', products: ['verification-modes-fixture'] } };
  await pool.query(
    `INSERT INTO service_descriptor_versions(service_id,version,descriptor,content_hash) VALUES($1,1,$2::jsonb,$3)`,
    [svc.rows[0].id, JSON.stringify(descriptor), crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex')]);
  return { id, parent: owner, serviceId: svc.rows[0].id, authorization: await bearerOf(id, [...WRITE, 'telemetry:write']) };
}
async function warrant(holder: string, opts: { status?: string; expired?: boolean } = {}): Promise<string> {
  const profile = (await pool.query('INSERT INTO access_profiles(name) VALUES($1) RETURNING id', [tag()])).rows[0].id;
  const version = (await pool.query('INSERT INTO access_profile_versions(profile_id,version_number) VALUES($1,1) RETURNING id', [profile])).rows[0].id;
  const w = (await pool.query('INSERT INTO warrants(name,holder_principal_id,ceiling_profile_version_id,created_by_principal_id) VALUES($1,$2,$3,$2) RETURNING id', [tag(), holder, version])).rows[0].id;
  if (opts.status === 'revoked') await pool.query("UPDATE warrants SET status='revoked', revoked_at=now() WHERE id=$1", [w]);
  if (opts.expired) await pool.query("UPDATE warrants SET expires_at=now() - interval '1 minute' WHERE id=$1", [w]);
  return w;
}
async function agent(parent: string, taskId: string, role: 'implementer' | 'verifier' | 'shepherd', warrantId: string | null): Promise<{ id: string; authorization: string }> {
  const r = await pool.query(
    `INSERT INTO principals(kind,handle,display_name,status,parent_principal_id,bound_task_id,bound_task_role,minted_under_warrant_id,purpose,own_expression)
     VALUES('agent',$1,$1,'active',$2,$3,$4,$5,'verification modes fixture agent',$6::jsonb) RETURNING id`,
    [tag(), parent, taskId, role, warrantId, JSON.stringify({ scopes: 'parent', objects: 'parent' })]);
  return { id: r.rows[0].id, authorization: await bearerOf(r.rows[0].id) };
}
/** A private Task created by its own Account, with the given role columns. */
async function task(fields: { status: string; owner?: string | null; verifier?: string | null; shepherd?: string | null; creator?: string; executionServiceId?: string | null; none?: { setBy: string; basis?: string } }): Promise<{ id: string; creator: string }> {
  const creator = fields.creator ?? await account();
  const r = await pool.query(
    `INSERT INTO tasks(title,status,visibility,creator_principal_id,owner_principal_id,verifier_principal_id,shepherd_principal_id,account_owner_principal_id,started_at)
     VALUES($1,$2,'private',$3,$4,$5,$6,$3,$7) RETURNING id`,
    [tag(), fields.status, creator, fields.owner ?? null, fields.verifier ?? null, fields.shepherd ?? creator,
      ['in-progress', 'review'].includes(fields.status) ? new Date() : null]);
  if (fields.executionServiceId) {
    await pool.query(
      'UPDATE tasks SET execution_service_id=$2, execution_descriptor_version=1, execution_profile=$3::jsonb WHERE id=$1',
      [r.rows[0].id, fields.executionServiceId, JSON.stringify({ serviceId: fields.executionServiceId, descriptorVersion: 1, options: {} })]);
  }
  if (fields.none) {
    await pool.query(`UPDATE tasks SET verification_none=TRUE, verification_none_set_by=$2, verification_none_basis=$3,
      verification_none_set_at=now() WHERE id=$1`, [r.rows[0].id, fields.none.setBy, fields.none.basis ?? 'role-authority']);
  }
  return { id: r.rows[0].id, creator };
}
async function grant(principalId: string, taskId: string, verb = 'write'): Promise<void> {
  await pool.query("INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id) VALUES('principal',$1,'task',$2,$3,$1)", [principalId, taskId, verb]);
}
async function claimedBy(taskId: string, principalId: string): Promise<void> {
  await pool.query(`INSERT INTO task_stream_entries(task_id,provenance,event_type,content,metadata) VALUES($1,'system','task.claimed','unassigned -> claimed',$2)`,
    [taskId, { assigneePrincipalId: principalId }]);
}
async function call(method: string, routePath: string, authorization: string, body?: unknown): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = authorization.startsWith('Bearer ') ? { Authorization: authorization } : { Cookie: authorization };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method === 'POST' && routePath === '/tasks') headers['Idempotency-Key'] = crypto.randomUUID();
  const response = await fetch(`${origin}${routePath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, json: await response.json().catch(() => null) };
}
const row = async (taskId: string) => (await pool.query('SELECT * FROM tasks WHERE id=$1', [taskId])).rows[0];
const audits = async (taskId: string, action: string) => (await pool.query(
  'SELECT * FROM audit_events WHERE resource_type=$1 AND resource_id=$2 AND action=$3 ORDER BY occurred_at, id', ['task', taskId, action])).rows;
const entries = async (taskId: string, type: string) => (await pool.query(
  'SELECT * FROM task_stream_entries WHERE task_id=$1 AND event_type=$2 ORDER BY stream_offset', [taskId, type])).rows;
const finishBody = () => ({ handover: 'done', report: { title: 'Result ' + tag(), content: 'The playbook ran.' } });
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

// ── Migration 170 ────────────────────────────────────────────────────────────

test('S4b migration 170: none never beside a Verifier, a setter is always named, once cleared never again', async () => {
  const verifier = await account();
  const t = await task({ status: 'todo' });
  const creator = (await row(t.id)).creator_principal_id;
  await expect(pool.query(`UPDATE tasks SET verification_none=TRUE, verification_none_set_by=$2, verification_none_basis='role-authority',
    verification_none_set_at=now(), verifier_principal_id=$3 WHERE id=$1`, [t.id, creator, verifier]))
    .rejects.toMatchObject({ constraint: 'tasks_verification_none_without_verifier' });
  await expect(pool.query('UPDATE tasks SET verification_none=TRUE WHERE id=$1', [t.id]))
    .rejects.toMatchObject({ constraint: 'tasks_verification_none_setter' });
  await expect(pool.query(`UPDATE tasks SET verification_none=TRUE, verification_none_set_by=$2, verification_none_basis='a-shepherd',
    verification_none_set_at=now() WHERE id=$1`, [t.id, creator])).rejects.toMatchObject({ constraint: 'tasks_verification_none_basis' });
  await pool.query('UPDATE tasks SET verification_none_cleared_at=now() WHERE id=$1', [t.id]);
  await expect(pool.query(`UPDATE tasks SET verification_none=TRUE, verification_none_set_by=$2, verification_none_basis='role-authority',
    verification_none_set_at=now() WHERE id=$1`, [t.id, creator])).rejects.toMatchObject({ constraint: 'tasks_verification_none_once' });
  expect((await row(t.id)).verification_none).toBe(false);
});

// ── Setting and clearing ─────────────────────────────────────────────────────

test('S4b create with verificationNone: the creator (its Shepherd) sets it; the Task reads mode none with an audit row and a Timeline entry', async () => {
  const human = await account(); const auth = await sessionOf(human);
  const created = await call('POST', '/tasks', auth, { title: tag(), status: 'todo', verificationNone: true });
  expect(created.status).toBe(201);
  const taskId = created.json.task?.id ?? created.json.id;
  const stored = await row(taskId);
  expect(stored).toMatchObject({ verification_none: true, verifier_principal_id: null, verification_none_set_by: human, verification_none_basis: 'account-control' });
  const read = await call('GET', `/tasks/${taskId}`, auth);
  expect(read.json.task ?? read.json).toMatchObject({ verificationNone: true, verificationMode: 'none', verificationNoneSetByPrincipalId: human });
  const [audit] = await audits(taskId, 'task.verification_none.set');
  expect(audit.metadata).toMatchObject({ mode: 'none', change: 'set', setByPrincipalId: human, basis: 'account-control', atCreation: true, displacedVerifierPrincipalId: null });
  const [entry] = await entries(taskId, 'task.verification_mode');
  expect(entry).toMatchObject({ provenance: 'system', content: 'Verification set to none' });
  const timeline = await call('GET', `/tasks/${taskId}/timeline?filter=system`, auth);
  expect(JSON.stringify(timeline.json)).toContain('task.verification_mode');
});

test('S4b create with verificationNone displaces the inherited Project default Verifier and audits it', async () => {
  const human = await account(); const auth = await sessionOf(human);
  const reviewer = await account();
  await connector(reviewer);
  const project = (await pool.query("INSERT INTO projects(name,owner_principal_id,default_verifier_principal_id) VALUES($1,$2,$3) RETURNING id", [tag(), human, reviewer])).rows[0].id;
  const created = await call('POST', '/tasks', auth, { title: tag(), status: 'todo', project, verificationNone: true });
  expect(created.status).toBe(201);
  const taskId = created.json.task?.id ?? created.json.id;
  expect(await row(taskId)).toMatchObject({ verification_none: true, verifier_principal_id: null });
  const [audit] = await audits(taskId, 'task.verification_none.set');
  expect(audit.metadata).toMatchObject({ displacedVerifierPrincipalId: reviewer, displacedVerifierSource: 'inherited-project' });
  // Control: the same create without the flag inherits the default.
  const plain = await call('POST', '/tasks', auth, { title: tag(), status: 'todo', project });
  expect((await row(plain.json.task?.id ?? plain.json.id)).verifier_principal_id).toBe(reviewer);
});

test('S4b create refuses verificationNone beside verifierPrincipalId, and a non-boolean', async () => {
  const human = await account(); const auth = await sessionOf(human);
  const both = await call('POST', '/tasks', auth, { title: tag(), status: 'todo', verificationNone: true, verifierPrincipalId: crypto.randomUUID() });
  expect(both.status).toBe(422);
  expect(both.json.code).toBe('VERIFICATION_NONE_WITH_VERIFIER');
  const odd = await call('POST', '/tasks', auth, { title: tag(), status: 'todo', verificationNone: 'yes' });
  expect(odd.json.code).toBe('INVALID_VERIFICATION_NONE');
});

test('S4b the Shepherd sets none on a To-Do Task; its Verifier is cleared and audited as displaced', async () => {
  const shepherd = await account(); const auth = await sessionOf(shepherd);
  const reviewer = await account();
  const t = await task({ status: 'todo', shepherd, verifier: reviewer });
  const set = await call('PATCH', `/tasks/${t.id}/roles`, auth, { verificationNone: true });
  expect(set.status).toBe(200);
  expect(await row(t.id)).toMatchObject({ verification_none: true, verifier_principal_id: null, verification_none_basis: 'role-authority' });
  const [audit] = await audits(t.id, 'task.verification_none.set');
  expect(audit.metadata).toMatchObject({ atCreation: false, displacedVerifierPrincipalId: reviewer });
});

test('S4b an Agent never sets none, even as the Shepherd of the Task', async () => {
  const owner = await account(); const c = await connector(owner);
  const t = await task({ status: 'todo', creator: owner });
  const a = await agent(c.id, t.id, 'shepherd', await warrant(c.id));
  await pool.query('UPDATE tasks SET shepherd_principal_id=$2 WHERE id=$1', [t.id, a.id]);
  const set = await call('PATCH', `/tasks/${t.id}/roles`, a.authorization, { verificationNone: true });
  expect(set.status).toBe(403);
  expect(set.json.code).toBe('VERIFICATION_NONE_AGENT');
  expect((await row(t.id)).verification_none).toBe(false);
  expect((await audits(t.id, 'task.verification_none.set'))[0]).toMatchObject({ outcome: 'denied' });
});

test('S4b the execution connector (in G(Task)) never waives its own verification, even as Shepherd', async () => {
  const owner = await account(); const c = await connector(owner);
  const t = await task({ status: 'todo', creator: owner, shepherd: c.id, executionServiceId: c.serviceId });
  const set = await call('PATCH', `/tasks/${t.id}/roles`, c.authorization, { verificationNone: true });
  expect(set.status).toBe(403);
  expect(set.json.code).toBe('VERIFICATION_NONE_CHAIN_GUARDED');
  expect((await row(t.id)).verification_none).toBe(false);
  // Control: a sibling connector of the same Account, as Shepherd, may (an owner appointment).
  const sibling = await connector(owner);
  await pool.query('UPDATE tasks SET shepherd_principal_id=$2 WHERE id=$1', [t.id, sibling.id]);
  expect((await call('PATCH', `/tasks/${t.id}/roles`, sibling.authorization, { verificationNone: true })).status).toBe(200);
});

test('S4b a principal without the roles authority cannot set none', async () => {
  const stranger = await account(); const auth = await sessionOf(stranger);
  const t = await task({ status: 'todo' });
  await grant(stranger, t.id, 'write');
  const set = await call('PATCH', `/tasks/${t.id}/roles`, auth, { verificationNone: true });
  expect(set.status).toBe(403);
  expect((await row(t.id)).verification_none).toBe(false);
});

test('S4b none is refused once the Task started: in progress, a claim entry, a started_at or an execution lease', async () => {
  const shepherd = await account(); const auth = await sessionOf(shepherd);
  const moving = await task({ status: 'in-progress', creator: shepherd });
  expect((await call('PATCH', `/tasks/${moving.id}/roles`, auth, { verificationNone: true })).json.code).toBe('VERIFICATION_NONE_TASK_STARTED');
  const released = await task({ status: 'todo', creator: shepherd });
  await claimedBy(released.id, shepherd);
  expect((await call('PATCH', `/tasks/${released.id}/roles`, auth, { verificationNone: true })).json.code).toBe('VERIFICATION_NONE_TASK_STARTED');
  const started = await task({ status: 'todo', creator: shepherd });
  await pool.query('UPDATE tasks SET started_at=now() WHERE id=$1', [started.id]);
  expect((await call('PATCH', `/tasks/${started.id}/roles`, auth, { verificationNone: true })).json.code).toBe('VERIFICATION_NONE_TASK_STARTED');
  const leased = await task({ status: 'todo', creator: shepherd });
  await pool.query(`INSERT INTO task_execution_leases(task_id,resource_key,harness,status,claimed_task_updated_at,expires_at)
    VALUES($1,$2,'hermes','released',now(),now() + interval '1 hour')`, [leased.id, tag()]);
  expect((await call('PATCH', `/tasks/${leased.id}/roles`, auth, { verificationNone: true })).json.code).toBe('VERIFICATION_NONE_TASK_STARTED');
});

test('S4b assigning a Verifier clears none in the same write; once cleared it can never be set again', async () => {
  const shepherd = await account(); const auth = await sessionOf(shepherd);
  const reviewer = await account(); await connector(reviewer);
  const t = await task({ status: 'todo', creator: shepherd });
  expect((await call('PATCH', `/tasks/${t.id}/roles`, auth, { verificationNone: true })).status).toBe(200);
  const assigned = await call('PATCH', `/tasks/${t.id}/roles`, auth, { verifierPrincipalId: reviewer });
  expect(assigned.status).toBe(200);
  const stored = await row(t.id);
  expect(stored).toMatchObject({ verification_none: false, verifier_principal_id: reviewer });
  expect(stored.verification_none_cleared_at).not.toBeNull();
  const [clear] = await audits(t.id, 'task.verification_none.clear');
  expect(clear.metadata).toMatchObject({ change: 'cleared', verifierPrincipalId: reviewer });
  await call('PATCH', `/tasks/${t.id}/roles`, auth, { verifierPrincipalId: null });
  const again = await call('PATCH', `/tasks/${t.id}/roles`, auth, { verificationNone: true });
  expect(again.json.code).toBe('VERIFICATION_NONE_CLEARED');
  expect((await call('PATCH', `/tasks/${t.id}/roles`, auth, { verificationNone: true, shepherdPrincipalId: shepherd })).json.code).toBe('VERIFICATION_NONE_EXCLUSIVE');
});

// ── Finish completes ─────────────────────────────────────────────────────────

test('S4b finish on a none Task completes it, completes Subtasks in Review, and its dependent gets task.ready and an implement ring', async () => {
  const shepherd = await account();
  const worker = await account(); const workerAuth = await sessionOf(worker);
  const t = await task({ status: 'in-progress', creator: shepherd, owner: worker, none: { setBy: shepherd } });
  await pool.query("INSERT INTO subtasks(task_id,index,title,status) VALUES($1,0,'run it','review'),($1,1,'skip it','skipped')", [t.id]);
  const c = await connector();
  // The dependent belongs to the connector's own Account, so the connector reads it.
  const dependent = await task({ status: 'todo', creator: c.parent, executionServiceId: c.serviceId, verifier: shepherd });
  await pool.query('UPDATE tasks SET auto_start=TRUE WHERE id=$1', [dependent.id]);
  await pool.query('INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES($1,$2)', [dependent.id, t.id]);
  const ws = await connect(c.authorization);
  await until(() => inbox.get(ws)!.find(f => f.type === 'wake.status'));

  const dry = await call('POST', `/tasks/${t.id}/finish`, workerAuth, { ...finishBody(), dryRun: true });
  expect(dry.json).toMatchObject({ valid: true, dryRun: true, targetStatus: 'completed' });
  const finished = await call('POST', `/tasks/${t.id}/finish`, workerAuth, finishBody());
  expect(finished.status).toBe(200);
  expect(finished.json).toMatchObject({ status: 'completed', verification: 'none' });
  const stored = await row(t.id);
  expect(stored.status).toBe('completed');
  expect(stored.completed_at).not.toBeNull();
  const subtasks = (await pool.query('SELECT status FROM subtasks WHERE task_id=$1 ORDER BY index', [t.id])).rows.map((r: any) => r.status);
  expect(subtasks).toEqual(['completed', 'skipped']);
  const [transition] = (await entries(t.id, 'task.transitioned'));
  expect(transition.metadata).toMatchObject({ from: 'in-progress', to: 'completed', reason: 'verification: none' });
  const [audit] = await audits(t.id, 'task.complete');
  expect(audit.metadata).toMatchObject({ reason: 'verification: none', setByPrincipalId: shepherd, independentVerification: false });
  const ready = (await pool.query("SELECT 1 FROM feed_events WHERE name='task.ready' AND object_id=$1", [dependent.id])).rows;
  expect(ready.length).toBeGreaterThan(0);
  const frame = await until(() => inbox.get(ws)!.find(f => f.type === 'wake' && f.taskId === dependent.id));
  expect(frame).toMatchObject({ kind: 'implement', taskId: dependent.id });
});

test('S4b finish on an ordinary Task still hands back into Review (control)', async () => {
  const shepherd = await account(); const reviewer = await account();
  const worker = await account(); const workerAuth = await sessionOf(worker);
  const t = await task({ status: 'in-progress', creator: shepherd, owner: worker, verifier: reviewer });
  const finished = await call('POST', `/tasks/${t.id}/finish`, workerAuth, finishBody());
  expect(finished.json).toMatchObject({ status: 'review' });
  expect((await row(t.id)).status).toBe('review');
});

test('S4b a move to Review on a none Task is refused', async () => {
  const shepherd = await account();
  const worker = await account(); const workerAuth = await sessionOf(worker);
  const t = await task({ status: 'in-progress', creator: shepherd, owner: worker, none: { setBy: shepherd } });
  const moved = await call('PATCH', `/tasks/${t.id}`, workerAuth, { status: 'review' });
  expect(moved.status).toBe(409);
  expect(moved.json.code).toBe('VERIFICATION_NONE_NO_REVIEW');
  expect((await row(t.id)).status).toBe('in-progress');
});

test('S4b finish refuses VERIFICATION_NONE_SELF_SET when the setter shares the implementing chain', async () => {
  const owner = await account(); const setter = await connector(owner);
  const t = await task({ status: 'in-progress', creator: owner, none: { setBy: setter.id } });
  const a = await agent(setter.id, t.id, 'implementer', await warrant(setter.id));
  await pool.query('UPDATE tasks SET owner_principal_id=$2 WHERE id=$1', [t.id, a.id]);
  await claimedBy(t.id, a.id);
  const refused = await call('POST', `/tasks/${t.id}/finish`, a.authorization, finishBody());
  expect(refused.status).toBe(409);
  expect(refused.json.code).toBe('VERIFICATION_NONE_SELF_SET');
  expect((await row(t.id)).status).toBe('in-progress');
  // The Account-control basis is exempt: the Account can already complete its own Task.
  await pool.query("UPDATE tasks SET verification_none_basis='account-control' WHERE id=$1", [t.id]);
  expect((await call('POST', `/tasks/${t.id}/finish`, a.authorization, finishBody())).json).toMatchObject({ status: 'completed' });
});

test('S4b the Account on its login session sets none on the Account-control basis', async () => {
  const human = await account();
  const t = await task({ status: 'todo', creator: human });
  const set = await call('PATCH', `/tasks/${t.id}/roles`, await sessionOf(human), { verificationNone: true });
  expect(set.status).toBe(200);
  expect(await row(t.id)).toMatchObject({ verification_none: true, verification_none_basis: 'account-control' });
});

test('S4b create with verificationNone in Ideas: an explicit ideas status and the inbox-phase default both set it', async () => {
  const human = await account(); const auth = await sessionOf(human);
  const explicit = await call('POST', '/tasks', auth, { title: tag(), status: 'ideas', verificationNone: true });
  expect(explicit.status).toBe(201);
  const explicitId = explicit.json.task?.id ?? explicit.json.id;
  expect(await row(explicitId)).toMatchObject({ status: 'ideas', verification_none: true, verifier_principal_id: null, verification_none_set_by: human });
  expect((await audits(explicitId, 'task.verification_none.set'))[0].metadata).toMatchObject({ change: 'set', atCreation: true });
  // The MCP/REST default: a Project with an inbox phase and no status lands the Task in Ideas.
  const project = (await pool.query('INSERT INTO projects(name,owner_principal_id) VALUES($1,$2) RETURNING id', [tag(), human])).rows[0].id;
  const inboxPhase = (await pool.query('INSERT INTO phases(project_id,name) VALUES($1,$2) RETURNING id', [project, 'Inbox'])).rows[0].id;
  await pool.query('UPDATE projects SET inbox_phase_id=$2 WHERE id=$1', [project, inboxPhase]);
  const plain = await call('POST', '/tasks', auth, { title: tag(), project });
  expect(await row(plain.json.task?.id ?? plain.json.id)).toMatchObject({ status: 'ideas', phase_id: inboxPhase, verification_none: false });
  const landed = await call('POST', '/tasks', auth, { title: tag(), project, verificationNone: true });
  expect(landed.status).toBe(201);
  const landedId = landed.json.task?.id ?? landed.json.id;
  expect(await row(landedId)).toMatchObject({ status: 'ideas', phase_id: inboxPhase, verification_none: true, verifier_principal_id: null });
  expect((await audits(landedId, 'task.verification_none.set'))[0].metadata).toMatchObject({ change: 'set', atCreation: true });
});

test('S4b after creation the roles route sets none only in To Do: an Ideas Task is refused', async () => {
  const shepherd = await account(); const auth = await sessionOf(shepherd);
  const idea = await task({ status: 'ideas', creator: shepherd });
  const refused = await call('PATCH', `/tasks/${idea.id}/roles`, auth, { verificationNone: true });
  expect(refused.status).toBe(409);
  expect(refused.json.code).toBe('VERIFICATION_NONE_TASK_STARTED');
  expect((await row(idea.id)).verification_none).toBe(false);
  // Control: the same Task in To Do is admitted.
  await pool.query("UPDATE tasks SET status='todo' WHERE id=$1", [idea.id]);
  expect((await call('PATCH', `/tasks/${idea.id}/roles`, auth, { verificationNone: true })).status).toBe(200);
});

test('S4b a Main connector in G(Task) never sets none, even on the Account-control basis; the human Account does', async () => {
  const owner = await account();
  const main = await connector(owner); const sibling = await connector(owner);
  await pool.query('UPDATE principals SET owner_control_account_id=$2 WHERE id = ANY($1::uuid[])', [[main.id, sibling.id], owner]);
  // The execution connector is a Main connector of the Task's Account: it holds the Account-control path and is in G.
  const t = await task({ status: 'todo', creator: owner, executionServiceId: main.serviceId });
  expect((await guardedPrincipalIds(pool, t.id)).has(main.id)).toBe(true);
  expect((await guardedPrincipalIds(pool, t.id)).has(sibling.id)).toBe(false);
  const refused = await call('PATCH', `/tasks/${t.id}/roles`, main.authorization, { verificationNone: true });
  expect(refused.status).toBe(403);
  expect(refused.json.code).toBe('VERIFICATION_NONE_CHAIN_GUARDED');
  expect((await row(t.id)).verification_none).toBe(false);
  // Control: a sibling Main connector outside G (not the Shepherd) sets it on the Account-control basis.
  const twin = await task({ status: 'todo', creator: owner, executionServiceId: main.serviceId });
  expect((await call('PATCH', `/tasks/${twin.id}/roles`, sibling.authorization, { verificationNone: true })).status).toBe(200);
  expect(await row(twin.id)).toMatchObject({ verification_none: true, verification_none_set_by: sibling.id, verification_none_basis: 'account-control' });
  // Control: the human Account on its login session is never in G and sets it on the Task the connector executes.
  const set = await call('PATCH', `/tasks/${t.id}/roles`, await sessionOf(owner), { verificationNone: true });
  expect(set.status).toBe(200);
  expect(await row(t.id)).toMatchObject({ verification_none: true, verification_none_set_by: owner, verification_none_basis: 'account-control' });
});

// ── Assigned claim ───────────────────────────────────────────────────────────

test('S4b the assigned connector claims a none Task without a Verifier; without none it still needs one', async () => {
  // As assignedClaimLive: the connector's Account may only read the Task, so
  // only the assigned-connector arm can admit the claim.
  const owner = await account(); const c = await connector(owner);
  const creator = await account();
  const fixture = async (none: boolean) => {
    const t = await task({ status: 'todo', creator, executionServiceId: c.serviceId, ...(none ? { none: { setBy: creator } } : {}) });
    await pool.query('UPDATE tasks SET auto_start=TRUE, account_owner_principal_id=NULL WHERE id=$1', [t.id]);
    await grant(owner, t.id, 'read');
    const epoch = (await pool.query('SELECT epoch::text FROM task_native_assignment_epochs WHERE task_id=$1', [t.id])).rows[0]?.epoch;
    return { id: t.id, epoch };
  };
  const none = await fixture(true);
  const plain = await fixture(false);
  const claimed = await call('POST', `/tasks/${none.id}/claim`, c.authorization, { expectedAssignmentEpoch: none.epoch });
  expect(claimed.status).toBe(200);
  expect((await row(none.id)).owner_principal_id).toBe(c.id);
  const refused = await call('POST', `/tasks/${plain.id}/claim`, c.authorization, { expectedAssignmentEpoch: plain.epoch });
  expect(refused.status).toBe(403);
  expect((await row(plain.id)).owner_principal_id).toBeNull();
});

// ── The verifier-agent arm and the chain guard ───────────────────────────────

async function reviewFixture(opts: { verifierKind?: 'service' | 'human' } = {}) {
  const implementer = await account();
  const v = await connector();
  const verifierId = opts.verifierKind === 'human' ? await account() : v.id;
  const t = await task({ status: 'review', owner: implementer, verifier: verifierId });
  return { implementer, v, verifierId, t };
}
const complete = (taskId: string, authorization: string) => call('PATCH', `/tasks/${taskId}`, authorization, { status: 'completed' });

test('S4b a verifier Agent of the service Verifier, minted under its live Warrant, completes the Task', async () => {
  const { v, t } = await reviewFixture();
  const a = await agent(v.id, t.id, 'verifier', await warrant(v.id));
  const done = await complete(t.id, a.authorization);
  expect(done.status).toBe(200);
  expect((await row(t.id)).status).toBe('completed');
});

test('S4b the verifier-agent arm refuses a wrong parent, the wrong role, another Task, a dead Warrant and a human Verifier', async () => {
  // Wrong parent: an Agent of another connector, even under the Verifier's own Warrant.
  { const { v, t } = await reviewFixture(); const other = await connector();
    const a = await agent(other.id, t.id, 'verifier', await warrant(v.id));
    expect((await complete(t.id, a.authorization)).status).not.toBe(200); expect((await row(t.id)).status).toBe('review'); }
  // Wrong role: bound as shepherd.
  { const { v, t } = await reviewFixture();
    const a = await agent(v.id, t.id, 'shepherd', await warrant(v.id));
    expect((await complete(t.id, a.authorization)).status).not.toBe(200); expect((await row(t.id)).status).toBe('review'); }
  // Another Task: bound to a sibling Task.
  { const { v, t } = await reviewFixture(); const elsewhere = await task({ status: 'todo' });
    const a = await agent(v.id, elsewhere.id, 'verifier', await warrant(v.id));
    expect((await complete(t.id, a.authorization)).status).not.toBe(200); expect((await row(t.id)).status).toBe('review'); }
  // Dead Warrant: revoked, then expired; and no Warrant (an Approval mint).
  for (const dead of [{ status: 'revoked' }, { expired: true }, null]) {
    const { v, t } = await reviewFixture();
    const a = await agent(v.id, t.id, 'verifier', dead ? await warrant(v.id, dead) : null);
    expect((await complete(t.id, a.authorization)).status).not.toBe(200); expect((await row(t.id)).status).toBe('review');
  }
  // A Warrant held by someone else.
  { const { v, t } = await reviewFixture(); const someone = await account();
    const a = await agent(v.id, t.id, 'verifier', await warrant(someone));
    expect((await complete(t.id, a.authorization)).status).not.toBe(200); expect((await row(t.id)).status).toBe('review'); }
  // A human Verifier: the arm needs a service Verifier, even for her own Agent under her own Warrant.
  { const { verifierId, t } = await reviewFixture({ verifierKind: 'human' });
    const a = await agent(verifierId, t.id, 'verifier', await warrant(verifierId));
    expect((await complete(t.id, a.authorization)).status).not.toBe(200); expect((await row(t.id)).status).toBe('review'); }
});

test('S4b a verifier Agent of the implementing connector is refused, and so is that connector as exact Verifier', async () => {
  const owner = await account(); const v = await connector(owner);
  const t = await task({ status: 'review', creator: owner, verifier: v.id });
  // V's own implementer Agent claimed the Task and handed it back, then released.
  const implementer = await agent(v.id, t.id, 'implementer', await warrant(v.id));
  await claimedBy(t.id, implementer.id);
  await pool.query(`INSERT INTO task_stream_entries(task_id,provenance,event_type,content,author_principal_id) VALUES($1,'authored','handover.finish','done',$2)`, [t.id, implementer.id]);
  const other = await account();
  await pool.query('UPDATE tasks SET owner_principal_id=$2 WHERE id=$1', [t.id, other]);
  expect((await guardedPrincipalIds(pool, t.id)).has(v.id)).toBe(true);
  const a = await agent(v.id, t.id, 'verifier', await warrant(v.id));
  expect((await complete(t.id, a.authorization)).status).not.toBe(200);
  expect((await complete(t.id, v.authorization)).status).not.toBe(200);
  expect((await row(t.id)).status).toBe('review');
  const rejected = await call('POST', `/tasks/reviewer/${t.id}/reject`, a.authorization, { reason: 'no' });
  expect(rejected.status).toBe(403);
});

test('S4b a human Account Verifier is never refused by the guard, even when her own connector implemented', async () => {
  const reviewer = await account(); const c = await connector(reviewer);
  const t = await task({ status: 'review', owner: c.id, verifier: reviewer, executionServiceId: c.serviceId });
  await claimedBy(t.id, c.id);
  expect((await guardedPrincipalIds(pool, t.id)).has(reviewer)).toBe(false);
  expect((await guardedPrincipalIds(pool, t.id)).has(c.id)).toBe(true);
  expect((await complete(t.id, await sessionOf(reviewer))).status).toBe(200);
  expect((await row(t.id)).status).toBe('completed');
});

test('S4b the exact service Verifier outside G(Task) still completes (sibling connectors are allowed)', async () => {
  const owner = await account(); const implementer = await connector(owner); const sibling = await connector(owner);
  const t = await task({ status: 'review', creator: owner, owner: implementer.id, verifier: sibling.id, executionServiceId: implementer.serviceId });
  await claimedBy(t.id, implementer.id);
  expect((await complete(t.id, sibling.authorization)).status).toBe(200);
});

test('S4b the verifier Agent may reject through the reviewer gate', async () => {
  const { v, t } = await reviewFixture();
  const a = await agent(v.id, t.id, 'verifier', await warrant(v.id));
  const rejected = await call('POST', `/tasks/reviewer/${t.id}/reject`, a.authorization, { reason: 'criteria not met' });
  expect(rejected.status).not.toBe(403);
});

// ── Kept out of the "no Verifier" machinery ──────────────────────────────────

test('S4b a none Task is never "without a usable Verifier", and the legacy qa arm never judges it', async () => {
  const human = await account(); const auth = await sessionOf(human);
  const reviewer = await account();
  const none = await task({ status: 'review', creator: human, none: { setBy: human } });
  const bare = await task({ status: 'review', creator: human });
  const listed = await call('GET', `/tasks?verifierUnusable=true&limit=100`, auth);
  const ids = JSON.stringify(listed.json);
  expect(ids).toContain(bare.id);
  expect(ids).not.toContain(none.id);
  const qa = { principalId: reviewer, handle: 'qa-fixture', role: 'qa', scopes: ['tasks:write'], authenticated: true, delegation: null };
  const allowed = await authorizationRepository.authorizedIds(qa, 'task', [none.id, bare.id], 'verify');
  expect(allowed.has(bare.id)).toBe(true);
  expect(allowed.has(none.id)).toBe(false);
});

test('S4b the verify wake reads G(Task): a connector whose Agent once handed the Task back is its own work', async () => {
  const c = await connector(); const other = await account();
  const t = await task({ status: 'review', owner: other, verifier: c.id });
  const facts = async () => (await wake.taskFacts([t.id], { serviceId: c.serviceId, principalId: c.id })).get(t.id);
  expect((await facts()).ownWork).toBe(false);
  // Not an implementer Agent: only its past handover puts it (and so its parent) in G.
  const a = await agent(c.id, t.id, 'shepherd', null);
  await pool.query(`INSERT INTO task_stream_entries(task_id,provenance,event_type,content,author_principal_id) VALUES($1,'authored','handover.finish','done',$2)`, [t.id, a.id]);
  expect((await facts()).ownWork).toBe(true);
});

test('S4b G(Task) remembers a released claimant and its descendants, never its Account or a sibling', async () => {
  const owner = await account(); const claimer = await connector(owner); const sibling = await connector(owner);
  const t = await task({ status: 'todo', creator: owner });
  const child = await agent(claimer.id, t.id, 'shepherd', null);
  expect((await guardedPrincipalIds(pool, t.id)).has(claimer.id)).toBe(false);
  await claimedBy(t.id, claimer.id);
  const guarded = await guardedPrincipalIds(pool, t.id);
  expect(guarded.has(claimer.id)).toBe(true);
  expect(guarded.has(child.id)).toBe(true);
  expect(guarded.has(owner)).toBe(false);
  expect(guarded.has(sibling.id)).toBe(false);
});

test('S4b a Verifier connector with a protocol-2 socket open is rung for verify even after a protocol-1 socket subscribed', async () => {
  const c = await connector();
  const worker = await account(); const workerAuth = await sessionOf(worker);
  const t = await task({ status: 'in-progress', owner: worker, verifier: c.id });
  const v2 = await connect(c.authorization, '?wake=2');
  await until(() => inbox.get(v2)!.find(f => f.type === 'wake.status'));
  const v1 = await connect(c.authorization, '?wake=1');
  await until(() => inbox.get(v1)!.find(f => f.type === 'wake.status'));
  expect((await call('POST', `/tasks/${t.id}/finish`, workerAuth, finishBody())).json).toMatchObject({ status: 'review' });
  const frame = await until(() => inbox.get(v2)!.find(f => f.type === 'wake' && f.taskId === t.id));
  expect(frame).toMatchObject({ kind: 'verify', taskId: t.id });
  expect(inbox.get(v1)!.some(f => f.type === 'wake' && f.taskId === t.id)).toBe(false);
});
