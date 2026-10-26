/** Card b595b3b0: truthful task activity through the production REST door and a
 * real disposable PostgreSQL. Never infer a deployment database from inherited
 * DB_* settings; a missing or unsafe URL fails before anything connects. */
import http from 'http';
import crypto from 'crypto';
const url = process.env.RELAYHALL_TEST_DB_URL;
if (!url) throw new Error('RELAYHALL_TEST_DB_URL is required for the task activity suite');
const parsed = new URL(url);
const database = decodeURIComponent(parsed.pathname.slice(1));
if (!['127.0.0.1', 'localhost', '[::1]', 'postgres'].includes(parsed.hostname)
  || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod', 'clawboard', 'clawboard_dev', 'clawboard_prod'].includes(database)
  || (!/(test|contract|fixture)/i.test(database) && database !== 'relayhall_ci')) {
  throw new Error('The task activity suite requires an explicitly disposable local test database');
}
Object.assign(process.env, { DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: database,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password), NODE_ENV: 'test',
  RELAYHALL_SESSIONS: 'on', JWT_SECRET: 'task-activity-contract-only-jwt-key-0123456789' });
delete process.env.BOOT_CHECK;
const express = require('express');
const { pool } = require('../db/connection');
const { principalService } = require('../services/PrincipalService');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const tag = () => crypto.randomBytes(8).toString('hex');
interface Caller { accountId?: string; id: string; headers: Record<string, string> }
let server: http.Server; let origin: string; let owner: Caller; let reader: Caller;

async function account(role = 'admin', credential = false, scopes = ['tasks:read', 'tasks:write', 'projects:read', 'principals:read']): Promise<Caller> {
  const id = (await pool.query("INSERT INTO principals(kind,handle,display_name,status,role) VALUES($1,$2,$2,'active',$3) RETURNING id", [credential ? 'service' : 'human', `activity-${tag()}`, role])).rows[0].id;
  if (credential) {
    const connector = (await pool.query("INSERT INTO principals(kind,handle,display_name,status,role,parent_principal_id,purpose,own_expression) VALUES('service',$1,$1,'active','user',$2,'Task activity connector',$3::jsonb) RETURNING id",
      [`activity-connector-${tag()}`, id, JSON.stringify({ scopes: 'parent', objects: 'parent' })])).rows[0].id;
    const key = await principalService.issueCredential({ principalId: connector, scopes, transport: 'any' },
      { principalId: owner.id, handle: 'task-activity-contract', authMethod: 'system' });
    return { id: connector, accountId: id, headers: { Authorization: `Bearer ${key.fullKey}` } };
  }
  const session = await loginSessionService.mint({ principalId: id });
  return { id, headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.token}` } };
}
async function grant(who: Caller, id: string, verbs: string[]) {
  for (const principal of [who.id, ...(who.accountId ? [who.accountId] : [])]) for (const verb of verbs) {
    await pool.query("INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id) VALUES('principal',$1,'task',$2,$3,$4)", [principal, id, verb, owner.id]);
  }
}
async function revoke(who: Caller, id: string) {
  await pool.query("DELETE FROM grants WHERE grantee_type='principal' AND grantee_id=ANY($1::uuid[]) AND resource_type='task' AND resource_id=$2", [[who.id, ...(who.accountId ? [who.accountId] : [])], id]);
}
async function task(title = `Activity ${tag()}`, status = 'todo'): Promise<string> {
  return (await pool.query("INSERT INTO tasks(title,status,auto_start,visibility) VALUES($1,$2,false,'private') RETURNING id", [title, status])).rows[0].id;
}
async function rest(who: Caller, method: string, path: string, body?: unknown) {
  const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...who.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text(); let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, text, json, cacheControl: response.headers.get('cache-control') };
}
/** An in-progress Task assigned to a connector Service whose principal is `who`. */
async function assigned(who: Caller, title = `Assigned activity ${tag()}`): Promise<string> {
  const id = await task(title, 'in-progress');
  const serviceId = crypto.randomUUID();
  await pool.query("INSERT INTO services(id,slug,name,kind,status,principal_id,current_descriptor_version) VALUES($1,$2,$2,'connector','published',$3,1)",
    [serviceId, 'activity-' + tag(), who.id]);
  await pool.query('INSERT INTO service_descriptor_versions(service_id,version,descriptor,content_hash) VALUES($1,1,$2,$3)',
    [serviceId, JSON.stringify({ options: [] }), crypto.randomBytes(32).toString('hex')]);
  await pool.query('UPDATE tasks SET owner_principal_id=$2,execution_service_id=$3,execution_descriptor_version=1,execution_profile=$4::jsonb WHERE id=$1',
    [id, who.id, serviceId, JSON.stringify({ serviceId, descriptorVersion: 1, options: {} })]);
  return id;
}
/** The frame cadence is per principal and deployment-wide; clear it before each deliberate frame. */
async function frame(who: Caller, body: Record<string, unknown>) {
  await pool.query("DELETE FROM telemetry_rate_limits WHERE principal_id=$1 AND surface='frames'", [who.id]);
  return rest(who, 'POST', '/telemetry/frames', body);
}
async function activity(who: Caller, ids: string[]) {
  return rest(who, 'GET', '/tasks/activity?ids=' + ids.join(','));
}
const unknown = (taskId: string) => ({ taskId, state: 'unknown', kind: null, receivedAt: null });

beforeAll(async () => {
  const app = express(); app.use(express.json(jsonBodyOptions));
  registerProtectedRoutes((mount: string, ...handlers: any[]) => app.use(mount, authMiddleware, sharedAuthorizationMiddleware, ...handlers));
  app.use(apiErrorHandler);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  owner = await account(); reader = await account('user', true);
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); await pool.end(); });
jest.setTimeout(30000);

describe('task activity attribution uses current server-owned assignment', () => {
  test('only the current Assignee\'s frames under the current assignment count; the caller cannot choose the stamp', async () => {
    const reporter = await account('user', true, ['telemetry:write']);
    const other = await account('user', true, ['telemetry:write']);
    const id = await assigned(reporter, 'Activity attribution ' + tag());
    await grant(reader, id, ['read']);
    const epoch = (await pool.query('SELECT epoch::text FROM task_native_assignment_epochs WHERE task_id=$1', [id])).rows[0].epoch;
    // Another principal's frame about this Task is stored (telemetry:write) but
    // carries no stamp, even a forged one, and is never this Task's activity.
    const foreign = await frame(other, { kind: 'status', status: 'active', taskId: id, payload: { _taskAssignmentEpoch: epoch } });
    expect(foreign.status).toBe(200);
    expect((await pool.query('SELECT payload FROM telemetry_frames WHERE task_id=$1 AND principal_id=$2', [id, other.id])).rows[0].payload)
      .not.toHaveProperty('_taskAssignmentEpoch');
    expect((await activity(reader, [id])).json.activity).toEqual([unknown(id)]);
    // The Assignee's frame is stamped by the server, whatever the caller sent.
    expect((await frame(reporter, { kind: 'status', status: 'active', taskId: id, payload: { _taskAssignmentEpoch: 'forged', origin: 'kept' } })).status).toBe(200);
    const stored = (await pool.query('SELECT payload FROM telemetry_frames WHERE task_id=$1 AND principal_id=$2', [id, reporter.id])).rows[0].payload;
    expect(stored).toEqual({ _taskAssignmentEpoch: epoch, origin: 'kept' });
    expect((await activity(reader, [id])).json.activity[0]).toMatchObject({ taskId: id, state: 'active', kind: 'status' });
    expect((await frame(reporter, { kind: 'status', status: 'idle', taskId: id })).status).toBe(200);
    expect((await activity(reader, [id])).json.activity[0]).toMatchObject({ state: 'idle' });
    // Out of progress, nothing counts - neither the earlier frames nor new ones.
    await pool.query("UPDATE tasks SET status='review' WHERE id=$1", [id]);
    expect((await frame(reporter, { kind: 'heartbeat', taskId: id })).status).toBe(200);
    expect((await activity(reader, [id])).json.activity).toEqual([unknown(id)]);
  });

  test('without an assigned Service the Assignee counts; with one, only that Service\'s principal does', async () => {
    const worker = await account('user', true, ['telemetry:write']);
    const elsewhere = await account('user', true, ['telemetry:write']);
    // The MCP claim shape: Assignee set, no assigned connector Service.
    const claimed = await task('Claimed ' + tag(), 'in-progress');
    await pool.query('UPDATE tasks SET owner_principal_id=$2 WHERE id=$1', [claimed, worker.id]);
    // Assigned to a Service whose principal is someone else.
    const foreignService = await assigned(elsewhere, 'Foreign service ' + tag());
    await pool.query('UPDATE tasks SET owner_principal_id=$2 WHERE id=$1', [foreignService, worker.id]);
    await grant(reader, claimed, ['read']); await grant(reader, foreignService, ['read']);
    expect((await frame(worker, { kind: 'heartbeat', taskId: claimed })).status).toBe(200);
    expect((await frame(worker, { kind: 'heartbeat', taskId: foreignService })).status).toBe(200);
    const rows = (await activity(reader, [claimed, foreignService])).json.activity;
    expect(rows.find((row: any) => row.taskId === claimed)).toMatchObject({ state: 'active', kind: 'heartbeat' });
    expect(rows.find((row: any) => row.taskId === foreignService)).toEqual(unknown(foreignService));
  });

  test('a reassignment away and back never revives the earlier observation on the read surface', async () => {
    const worker = await account('user', true, ['telemetry:write']);
    const elsewhere = await account('user', true, ['telemetry:write']);
    const id = await assigned(worker, 'Reassigned ' + tag());
    expect((await frame(worker, { kind: 'heartbeat', taskId: id })).status).toBe(200);
    await grant(reader, id, ['read']);
    expect((await activity(reader, [id])).json.activity[0]).toMatchObject({ taskId: id, state: 'active' });
    await pool.query('UPDATE tasks SET owner_principal_id=$2 WHERE id=$1', [id, elsewhere.id]);
    expect((await activity(reader, [id])).json.activity).toEqual([unknown(id)]);
    await pool.query('UPDATE tasks SET owner_principal_id=$2 WHERE id=$1', [id, worker.id]);
    expect((await activity(reader, [id])).json.activity).toEqual([unknown(id)]);
  });
});

describe('bounded task activity read follows current task authority', () => {
  test('collection filters private ids, revocation clears, uppercase/duplicates normalize and hostile batches refuse', async () => {
    const visible = await task(); const hidden = await task();
    await grant(reader, visible, ['read']);
    const path = '/tasks/activity?ids=' + [visible.toUpperCase(), hidden, visible].join(',');
    const found = await rest(reader, 'GET', path);
    expect(found.status).toBe(200);
    expect(found.cacheControl).toBe('no-store');
    expect(found.json.activity).toEqual([unknown(visible)]);
    expect(found.text).not.toContain(hidden);
    expect(found.json.staleAfterMs).toBe(9 * 60_000);
    expect(Number.isNaN(Date.parse(found.json.observedAt))).toBe(false);
    await revoke(reader, visible);
    const cleared = await rest(reader, 'GET', path);
    expect(cleared.status).toBe(200); expect(cleared.json.activity).toEqual([]);
    for (const query of ['', '?ids=bad', '?ids=' + Array(101).fill(visible).join(','), '?ids=' + visible + '&payload=true', '?ids=' + visible + '&ids=' + hidden]) {
      expect((await rest(reader, 'GET', '/tasks/activity' + query)).status).toBe(400);
    }
    const writer = await account('user', true, ['telemetry:write']);
    expect((await activity(writer, [visible])).status).toBe(403);
  });

  test('authorized batch returns only current coarse evidence and derived server-clock staleness', async () => {
    const who = await account('user', true, ['telemetry:write']);
    const id = await assigned(who, 'Batch coarse activity ' + tag());
    expect((await frame(who, { kind: 'heartbeat', taskId: id, payload: { privateMarker: 'never-return-this' } })).status).toBe(200);
    await grant(reader, id, ['read']);
    const active = await activity(reader, [id]);
    expect(active.status).toBe(200); expect(active.json.activity[0]).toMatchObject({ taskId: id, state: 'active', kind: 'heartbeat' });
    expect(Object.keys(active.json.activity[0]).sort()).toEqual(['kind', 'receivedAt', 'state', 'taskId']);
    expect(active.text).not.toContain('never-return-this'); expect(active.text).not.toContain(who.id);
    await pool.query("UPDATE telemetry_frames SET received_at=clock_timestamp()-interval '10 minutes' WHERE task_id=$1", [id]);
    expect((await activity(reader, [id])).json.activity[0].state).toBe('stale');
    await pool.query('UPDATE tasks SET owner_principal_id=NULL WHERE id=$1', [id]);
    expect((await activity(reader, [id])).json.activity[0]).toEqual(unknown(id));
    const { telemetryService } = await import('../services/TelemetryService');
    const spy = jest.spyOn(telemetryService, 'activityForTasks').mockRejectedValueOnce(new Error('sensitive database values'));
    const unavailable = await activity(reader, [id]);
    expect(unavailable.status).toBe(503); expect(unavailable.json.code).toBe('TASK_ACTIVITY_UNAVAILABLE');
    expect(unavailable.text).not.toContain('sensitive database values'); spy.mockRestore();
  });
});

describe('task activity isolation between readers and Tasks', () => {
  test('a reader of one Task never sees another Task\'s activity, even in the same batch', async () => {
    const workerA = await account('user', true, ['telemetry:write']);
    const workerB = await account('user', true, ['telemetry:write']);
    const a = await assigned(workerA, 'Isolation A ' + tag());
    const b = await assigned(workerB, 'Isolation B ' + tag());
    expect((await frame(workerA, { kind: 'status', status: 'idle', taskId: a })).status).toBe(200);
    expect((await frame(workerB, { kind: 'heartbeat', taskId: b })).status).toBe(200);
    // A worker's frame about another worker's Task is stored but never becomes that Task's activity.
    expect((await frame(workerA, { kind: 'status', status: 'idle', taskId: b })).status).toBe(200);
    const readerA = await account('user', true); const readerB = await account('user', true);
    await grant(readerA, a, ['read']); await grant(readerB, b, ['read']);
    const seenByA = await activity(readerA, [a, b]);
    expect(seenByA.status).toBe(200);
    expect(seenByA.json.activity).toEqual([expect.objectContaining({ taskId: a, state: 'idle', kind: 'status' })]);
    expect(seenByA.text).not.toContain(b);
    const seenByB = await activity(readerB, [b, a]);
    expect(seenByB.status).toBe(200);
    expect(seenByB.json.activity).toEqual([expect.objectContaining({ taskId: b, state: 'active', kind: 'heartbeat' })]);
    expect(seenByB.text).not.toContain(a);
    // A Task the reader can see but nobody reports on is unknown, never another Task's state.
    const quiet = await task('Quiet ' + tag(), 'in-progress');
    await grant(readerA, quiet, ['read']);
    expect((await activity(readerA, [quiet, b])).json.activity).toEqual([unknown(quiet)]);
  });

  test('access lost returns nothing for that Task while the other Task stays readable', async () => {
    const worker = await account('user', true, ['telemetry:write']);
    const id = await assigned(worker, 'Access lost ' + tag());
    const other = await task();
    expect((await frame(worker, { kind: 'heartbeat', taskId: id })).status).toBe(200);
    const viewer = await account('user', true);
    await grant(viewer, id, ['read']); await grant(viewer, other, ['read']);
    expect((await activity(viewer, [id, other])).json.activity.map((row: any) => row.taskId).sort()).toEqual([id, other].sort());
    await revoke(viewer, id);
    const after = await activity(viewer, [id, other]);
    expect(after.status).toBe(200);
    expect(after.json.activity).toEqual([unknown(other)]);
    expect(after.text).not.toContain(id);
    await revoke(viewer, other);
    expect((await activity(viewer, [id, other])).json.activity).toEqual([]);
  });

  test('lifecycle, a fresh update and the worker\'s other evidence never present activity without an attributed observation', async () => {
    const worker = await account('user', true, ['telemetry:write']);
    const id = await assigned(worker, 'Lifecycle only ' + tag());
    const sibling = await assigned(worker, 'Sibling ' + tag());
    // In progress, assigned to a live connector, just updated: still no observation about THIS Task.
    await pool.query('UPDATE tasks SET title=title WHERE id=$1', [id]);
    // A connector-only heartbeat (no taskId) and a frame about another Task are not evidence about it.
    expect((await frame(worker, { kind: 'heartbeat' })).status).toBe(200);
    expect((await frame(worker, { kind: 'heartbeat', taskId: sibling })).status).toBe(200);
    await grant(reader, id, ['read']); await grant(reader, sibling, ['read']);
    const rows = (await activity(reader, [id, sibling])).json.activity;
    expect(rows.find((row: any) => row.taskId === id)).toEqual(unknown(id));
    expect(rows.find((row: any) => row.taskId === sibling)).toMatchObject({ state: 'active', kind: 'heartbeat' });
  });
});
