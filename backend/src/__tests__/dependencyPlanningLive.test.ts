/** Real PostgreSQL plus the production REST and MCP HTTP doors. Never infer a
 * deployment database from inherited DB_* settings; missing/unsafe URL fails. */
import http from 'http';
import crypto from 'crypto';
const url = process.env.RELAYHALL_TEST_DB_URL;
if (!url) throw new Error('RELAYHALL_TEST_DB_URL is required for dependency planning');
const parsed = new URL(url);
const database = decodeURIComponent(parsed.pathname.slice(1));
if (!['127.0.0.1', 'localhost', '[::1]', 'postgres'].includes(parsed.hostname)
  || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod', 'clawboard', 'clawboard_dev', 'clawboard_prod'].includes(database)
  || (!/(test|contract|fixture)/i.test(database) && database !== 'relayhall_ci')) {
  throw new Error('Dependency planning requires an explicitly disposable local test database');
}
Object.assign(process.env, { DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: database,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password), NODE_ENV: 'test',
  RELAYHALL_SESSIONS: 'on', JWT_SECRET: 'dependency-contract-only-jwt-key-0123456789' });
delete process.env.BOOT_CHECK;
const express = require('express');
const { Pool } = require('pg');
const { pool } = require('../db/connection');
const { TaskManagerDB, taskManagerDB } = require('../services/TaskManagerDB');
const { runCreationTransaction } = require('../db/creationTransaction');
const { authorizationRepository } = require('../services/AuthorizationRepository');
const { generateTaskPromptWithSkills } = require('../utils/promptTemplate');
const { principalService } = require('../services/PrincipalService');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const mcpRoutes = require('../mcp/httpRoute');
const { feedEventService } = require('../services/FeedEventService');
const tag = () => crypto.randomBytes(8).toString('hex');
interface Caller { accountId?: string; id: string; headers: Record<string, string>; token?: string }
let server: http.Server; let origin: string; let owner: Caller; let reviewer: Caller; let reader: Caller;
const writerPool = new Pool({ connectionString: url, max: 4 });
let actor: any;
async function account(role = 'admin', credential = false, scopes = ['tasks:read', 'tasks:write', 'projects:read', 'principals:read']): Promise<Caller> {
  const id = (await pool.query("INSERT INTO principals(kind,handle,display_name,status,role) VALUES($1,$2,$2,'active',$3) RETURNING id", [credential ? 'service' : 'human', `dependency-${tag()}`, role])).rows[0].id;
  if (credential) {
    const connector = (await pool.query("INSERT INTO principals(kind,handle,display_name,status,role,parent_principal_id,purpose,own_expression) VALUES('service',$1,$1,'active','user',$2,'Dependency authorization connector',$3::jsonb) RETURNING id",
      [`dependency-connector-${tag()}`, id, JSON.stringify({ scopes: 'parent', objects: 'parent' })])).rows[0].id;
    const key = await principalService.issueCredential({ principalId: connector, scopes, transport: 'any' },
      { principalId: owner.id, handle: 'dependency-contract', authMethod: 'system' });
    return { id: connector, accountId: id, token: key.fullKey, headers: { Authorization: `Bearer ${key.fullKey}` } };
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

async function task(title = `Dependency ${tag()}`, status = 'todo'): Promise<string> {
  return (await pool.query("INSERT INTO tasks(title,status,auto_start,visibility) VALUES($1,$2,false,'private') RETURNING id", [title, status])).rows[0].id;
}
async function rest(who: Caller, method: string, path: string, body?: unknown, key?: string) {
  const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...who.headers,
    ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text(); let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, text, json };
}
async function tool(name: string, args: Record<string, unknown>, who = reader) {
  const response = await fetch(origin + mcpRoutes.MCP_ROUTE_PATH, { method: 'POST', headers: {
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${who.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const text = await response.text(); const json = JSON.parse(text);
  return { status: response.status, text, error: Boolean(json.error || json.result?.isError),
    content: (json.result?.content ?? []).map((part: any) => String(part.text ?? '')).join('\n') };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 4000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
/** Pause AFTER PostgreSQL grants the first writer's graph lock. The second
 * writer is observed waiting in pg_locks, not guessed from elapsed time. */
function heldWriter() {
  const held = deferred(); const resume = deferred(); let first = true;
  const queryLog: string[] = [];
  const adapter = {
    query: (...args: any[]) => writerPool.query(...args),
    connect: async () => {
      const client = await writerPool.connect();
      return { query: async (sql: string, params?: any[]) => {
        queryLog.push(sql);
        const result = await client.query(sql, params);
        if (first && sql === 'LOCK TABLE task_dependencies IN SHARE ROW EXCLUSIVE MODE') {
          first = false; held.resolve(); await resume.promise;
        }
        return result;
      }, release: () => client.release() };
    },
  };
  return { manager: new TaskManagerDB(adapter), adapter, held, resume, queryLog };
}
async function waitingGraphWriter() {
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    const result = await pool.query("SELECT 1 FROM pg_locks WHERE relation='task_dependencies'::regclass AND mode='ShareRowExclusiveLock' AND NOT granted");
    if (result.rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('No graph writer waited on the PostgreSQL lock');
}
async function edges(ids: string[]) {
  return (await pool.query('SELECT task_id,depends_on_task_id FROM task_dependencies WHERE task_id=ANY($1::uuid[]) ORDER BY task_id,depends_on_task_id', [ids])).rows;
}
function settle(operation: Promise<any>) { return operation.then(value => ({ ok: true, value, error: undefined }), error => ({ ok: false, value: undefined, error })); }
beforeAll(async () => {
  const app = express(); app.use(express.json(jsonBodyOptions));
  registerProtectedRoutes((mount: string, ...handlers: any[]) => app.use(mount, authMiddleware, sharedAuthorizationMiddleware, ...handlers));
  app.use(mcpRoutes.MCP_ROUTE_PATH, mcpRoutes.default ?? mcpRoutes); app.use(apiErrorHandler);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  owner = await account(); reviewer = await account(); reader = await account('user', true);
  actor = { principalId: owner.id, handle: 'dependency-contract', authMethod: 'session',
    authorization: { principalId: owner.id, handle: 'dependency-contract', role: 'admin', scopes: ['root'], authenticated: true } };
  const bootstrap = await tool('relayhall_brief_compile', { session: true });
  expect({ status: bootstrap.status, error: bootstrap.error }).toEqual({ status: 200, error: false });
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); await writerPool.end(); await pool.end(); });
jest.setTimeout(30000);

describe('concurrent graph writers preserve acyclicity', () => {
  test.each(['add/add', 'add/PATCH', 'PATCH/PATCH'])('%s reciprocal writes recheck after acquiring the lock', async mode => {
    const a = await task(); const b = await task(); const held = heldWriter();
    const first = settle(mode.startsWith('PATCH') ? held.manager.updateTask(a, { dependsOn: [b] }, actor) : held.manager.addDependency(a, b, actor));
    let second: ReturnType<typeof settle> | undefined;
    try {
      await bounded(held.held.promise, 'first writer never acquired the graph lock');
      expect(held.queryLog.slice(0, 2)).toEqual(['BEGIN', 'LOCK TABLE task_dependencies IN SHARE ROW EXCLUSIVE MODE']);
      second = settle(mode.endsWith('PATCH') ? taskManagerDB.updateTask(b, { dependsOn: [a] }, actor) : taskManagerDB.addDependency(b, a, actor));
      await waitingGraphWriter();
    } finally { held.resume.resolve(); }
    expect((await first).ok).toBe(true);
    const loser = await second!; expect(loser.ok).toBe(false); expect(loser.error.code).toBe('CIRCULAR_DEPENDENCY');
    expect(await edges([a, b])).toEqual([{ task_id: a, depends_on_task_id: b }]);
  });
  test('create with dependencies locks before target lookup and serializes removal', async () => {
    const target = await task(); const prerequisite = await task();
    await taskManagerDB.addDependency(target, prerequisite, actor);
    const held = heldWriter(); const projectTarget = jest.fn(async () => null);
    const creating = settle(held.manager.createTask({ title: `Created ${tag()}`, dependsOn: [target], autoStart: false }, actor, projectTarget));
    let removing: ReturnType<typeof settle> | undefined;
    try {
      await bounded(held.held.promise, 'create never acquired graph lock');
      expect(held.queryLog.slice(0, 2)).toEqual(['BEGIN', 'LOCK TABLE task_dependencies IN SHARE ROW EXCLUSIVE MODE']);
      expect(projectTarget).not.toHaveBeenCalled();
      removing = settle(taskManagerDB.removeDependency(target, prerequisite, actor)); await waitingGraphWriter();
    } finally { held.resume.resolve(); }
    const created = await creating; expect(created.ok).toBe(true); expect((await removing!).ok).toBe(true);
    expect(await edges([created.value.id, target])).toEqual([{ task_id: created.value.id, depends_on_task_id: target }]);
  });
  test('same-edge contenders preserve typed duplicate semantics', async () => {
    const a = await task(); const b = await task();
    const results = await Promise.all([settle(taskManagerDB.addDependency(a, b, actor)), settle(taskManagerDB.addDependency(a, b, actor))]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.find(result => !result.ok)!.error.code).toBe('DEPENDENCY_EXISTS');
    expect(await edges([a])).toHaveLength(1);
    await taskManagerDB.removeDependency(a, b, actor);
    await expect(taskManagerDB.removeDependency(a, b, actor)).rejects.toMatchObject({ code: 'DEPENDENCY_NOT_FOUND', status: 404 });
  });
  test('Repeatable Read outer callback starts only after the previous graph commit', async () => {
    const a = await task(); const b = await task(); const held = heldWriter();
    const first = settle(held.manager.addDependency(a, b, actor)); let entered = false; let second: ReturnType<typeof settle> | undefined;
    try {
      await bounded(held.held.promise, 'first writer never acquired graph lock');
      second = settle(runCreationTransaction(pool, actor, async (tx: any) => {
        entered = true; expect(tx.dependencyGraphLocked).toBe(true);
        await taskManagerDB.addDependency(b, a, actor, tx);
      }, 'blueprint', { dependencyGraphWrite: true }));
      await waitingGraphWriter(); expect(entered).toBe(false);
    } finally { held.resume.resolve(); }
    expect((await first).ok).toBe(true); expect((await second!).error.code).toBe('CIRCULAR_DEPENDENCY');
    expect(await edges([a, b])).toHaveLength(1);
  });
  test('task cascade deletion takes graph lock before row/feed locks', async () => {
    const a = await task(); const b = await task(); const held = heldWriter();
    const deletion = settle(held.manager.deleteTask(b)); let addition: ReturnType<typeof settle> | undefined;
    try {
      await bounded(held.held.promise, 'delete never acquired graph lock');
      expect(held.queryLog.slice(0, 2)).toEqual(['BEGIN', 'LOCK TABLE task_dependencies IN SHARE ROW EXCLUSIVE MODE']);
      addition = settle(taskManagerDB.addDependency(a, b, actor)); await waitingGraphWriter();
    } finally { held.resume.resolve(); }
    expect((await deletion).ok).toBe(true); expect((await addition!).error.code).toBe('UNKNOWN_DEPENDENCY');
    expect(await edges([a])).toEqual([]);
  });
  test('external unprepared transaction fails closed without a late graph lock', async () => {
    const a = await task(); const b = await task();
    await expect(runCreationTransaction(pool, actor, (tx: any) => taskManagerDB.addDependency(a, b, actor, tx))).rejects.toThrow('prepared creation transaction');
    expect(await edges([a])).toEqual([]);
  });
});

describe('UUID graph identity matches PostgreSQL', () => {
  test('canonical writers reject mixed-case self and cycle edges, accept known uppercase targets and preserve duplicates', async () => {
    const a = await task(); const b = await task(); const c = await task();
    expect(a.toUpperCase()).not.toBe(a); expect(b.toUpperCase()).not.toBe(b);
    await expect(taskManagerDB.addDependency(a.toUpperCase(), a, actor)).rejects.toMatchObject({ code: 'SELF_DEPENDENCY' });
    await expect(taskManagerDB.addDependency(a, a.toUpperCase(), actor)).rejects.toMatchObject({ code: 'SELF_DEPENDENCY' });
    await expect(taskManagerDB.updateTask(a.toUpperCase(), { dependsOn: [a] }, actor)).rejects.toMatchObject({ code: 'SELF_DEPENDENCY' });
    await taskManagerDB.addDependency(a, b.toUpperCase(), actor);
    await expect(taskManagerDB.addDependency(b.toUpperCase(), a, actor)).rejects.toMatchObject({ code: 'CIRCULAR_DEPENDENCY' });
    await expect(taskManagerDB.updateTask(b.toUpperCase(), { dependsOn: [a.toUpperCase()] }, actor)).rejects.toMatchObject({ code: 'CIRCULAR_DEPENDENCY' });
    await expect(taskManagerDB.addDependency(a.toUpperCase(), b.toUpperCase(), actor)).rejects.toMatchObject({ code: 'DEPENDENCY_EXISTS', status: 400 });
    const created = await taskManagerDB.createTask({ title: `Uppercase target ${tag()}`, autoStart: false, dependsOn: [c.toUpperCase()] }, actor, async () => null);
    await taskManagerDB.updateTask(created.id.toUpperCase(), { dependsOn: [b.toUpperCase()] }, actor);
    expect(await edges([created.id])).toEqual([{ task_id: created.id, depends_on_task_id: b }]);
    expect(await edges([a, b])).toEqual([{ task_id: a, depends_on_task_id: b }]);
    await expect(taskManagerDB.createTask({ title: 'Malformed dependency', dependsOn: ['NOT-A-UUID'] }, actor, async () => null)).rejects.toMatchObject({ code: 'UNKNOWN_DEPENDENCY', offendingIds: ['NOT-A-UUID'] });
  });
  test('MCP accepts uppercase UUID arguments without weakening self/cycle/duplicate checks', async () => {
    const a = await task(); const b = await task(); await grant(reader, a, ['read', 'write']); await grant(reader, b, ['read', 'write']);
    const self = await tool('relayhall_task_dependency_add', { taskId: a.toUpperCase(), dependsOnTaskId: a });
    expect(self.error).toBe(true); expect(self.content).toContain('SELF_DEPENDENCY');
    expect((await tool('relayhall_task_dependency_add', { taskId: a.toUpperCase(), dependsOnTaskId: b.toUpperCase() })).error).toBe(false);
    const cycle = await tool('relayhall_task_dependency_add', { taskId: b.toUpperCase(), dependsOnTaskId: a });
    expect(cycle.error).toBe(true); expect(cycle.content).toContain('CIRCULAR_DEPENDENCY');
    const duplicate = await tool('relayhall_task_dependency_add', { taskId: a, dependsOnTaskId: b.toUpperCase() });
    expect(duplicate.error).toBe(true); expect(duplicate.content).toContain('DEPENDENCY_EXISTS');
    expect(await edges([a, b])).toEqual([{ task_id: a, depends_on_task_id: b }]);
  });
});

describe('dependency metadata follows current caller authority', () => {
  test('revoked private target is hidden from REST/MCP Briefs while visible blocker and warning remain', async () => {
    const source = await task(); const secret = `PRIVATE-BLOCKER-${tag()}`; const visibleTitle = `VISIBLE-BLOCKER-${tag()}`;
    const privateTarget = await task(secret, 'stuck'); const visibleTarget = await task(visibleTitle);
    await grant(reader, source, ['read', 'write']);
    const concealed = await tool('relayhall_task_dependency_add', { taskId: source, dependsOnTaskId: privateTarget });
    expect(concealed.error).toBe(true); expect(concealed.content).toContain('RESOURCE_NOT_FOUND'); expect(await edges([source])).toEqual([]);
    await grant(reader, privateTarget, ['read']); await grant(reader, visibleTarget, ['read']);
    const add = await tool('relayhall_task_dependency_add', { taskId: source, dependsOnTaskId: privateTarget });
    expect({ status: add.status, error: add.error }).toEqual({ status: 200, error: false });
    const addedVisible = await rest(reader, 'POST', `/tasks/${source}/dependencies`, { dependsOn: visibleTarget });
    expect(addedVisible.status).toBe(201);
    const before = await rest(reader, 'POST', `/tasks/${source}/brief`, {}); expect(before.status).toBe(200); expect(before.text).toContain(secret);
    await revoke(reader, privateTarget);
    const denied = await rest(reader, 'GET', `/tasks/${privateTarget}`); expect(denied.status).toBe(404);
    const revokedAdd = await tool('relayhall_task_dependency_add', { taskId: source, dependsOnTaskId: privateTarget });
    expect(revokedAdd.error).toBe(true); expect(revokedAdd.content).toContain('RESOURCE_NOT_FOUND'); expect(await edges([source])).toHaveLength(2);
    const answer = await rest(reader, 'POST', `/tasks/${source}/brief`, {});
    const compiled = await tool('relayhall_brief_compile', { taskId: source, response_format: 'detailed' });
    expect(answer.status).toBe(200); expect(compiled.error).toBe(false);
    for (const content of [answer.text, compiled.text]) {
      expect(content).toContain(visibleTitle); expect(content).toContain('task is dependency-blocked');
      expect(content).not.toContain(privateTarget); expect(content).not.toContain(secret);
      expect(content).not.toContain('\"status\": \"stuck\"'); expect(content).not.toContain('\\\"status\\\": \\\"stuck\\\"');
    }
    const noActor = await generateTaskPromptWithSkills(await taskManagerDB.getTask(source), { actor: null });
    expect(noActor).toContain('task is dependency-blocked'); expect(noActor).not.toContain(visibleTitle); expect(noActor).not.toContain(secret);
    await revoke(reader, visibleTarget);
    const allHidden = await rest(reader, 'POST', `/tasks/${source}/brief`, {});
    expect(allHidden.status).toBe(200); expect(allHidden.text).toContain('task is dependency-blocked'); expect(allHidden.text).not.toContain(visibleTitle);
    // A writer may add a readable edge, but the established removal ceiling is ADMIN.
    const removeDenied = await tool('relayhall_task_dependency_remove', { taskId: source, dependsOnTaskId: privateTarget });
    expect(removeDenied.error).toBe(true); expect(await edges([source])).toHaveLength(2);
    await grant(reader, source, ['admin']);
    const removed = await tool('relayhall_task_dependency_remove', { taskId: source, dependsOnTaskId: privateTarget });
    expect(removed.error).toBe(false); expect(await edges([source])).toHaveLength(1);
    const absent = await tool('relayhall_task_dependency_remove', { taskId: source, dependsOnTaskId: privateTarget });
    expect(absent.error).toBe(true); expect(absent.content).toContain('DEPENDENCY_NOT_FOUND');
  });
  test('a read-only credential cannot add or remove even with object write/admin grants', async () => {
    const narrow = await account('user', true, ['tasks:read', 'principals:read']);
    expect((await tool('relayhall_brief_compile', { session: true }, narrow)).error).toBe(false);
    const source = await task(); const target = await task(); await grant(narrow, source, ['read', 'write', 'admin']); await grant(narrow, target, ['read']);
    const refused = await tool('relayhall_task_dependency_add', { taskId: source, dependsOnTaskId: target }, narrow);
    expect(refused.error).toBe(true); expect(await edges([source])).toEqual([]);
    await taskManagerDB.addDependency(source, target, actor);
    const removal = await tool('relayhall_task_dependency_remove', { taskId: source, dependsOnTaskId: target }, narrow);
    expect(removal.error).toBe(true); expect(await edges([source])).toHaveLength(1);
  });
  test('authority lookup failure cannot become a successful or leaking Brief', async () => {
    const source = await task(); const target = await task(); await grant(reader, source, ['read']);
    await taskManagerDB.addDependency(source, target, actor);
    const original = authorizationRepository.authorizedIds.bind(authorizationRepository);
    jest.spyOn(authorizationRepository, 'authorizedIds').mockImplementation((...args: any[]) => {
      if (args[1] === 'task' && args[2].includes(target)) throw new Error('PRIVATE-ADAPTER-DETAIL');
      return original(...args);
    });
    const answer = await rest(reader, 'POST', `/tasks/${source}/brief`, {});
    expect(answer.status).toBe(503); expect(answer.json.code).toBe('DEPENDENCY_CONTEXT_LOOKUP_FAILED'); expect(answer.text).not.toContain('PRIVATE-ADAPTER-DETAIL');
    const compiled = await tool('relayhall_brief_compile', { taskId: source });
    expect(compiled.error).toBe(true); expect(compiled.text).not.toContain('PRIVATE-ADAPTER-DETAIL');
  });
});

function blueprint(name: string) {
  return { schemaVersion: 'rh.blueprint/1.0', blueprint: { key: `dependency-${tag()}`, name, version: 1, summary: '', description: '', tags: [], provenance: 'human-authored' },
    parameters: [], target: { mode: 'new-project', project: { name } }, phases: [{ key: 'prepare', name: 'Prepare', position: 0 }],
    tasks: [{ key: 'first', title: 'First', phase: 'prepare' }, { key: 'second', title: 'Second', phase: 'prepare' }],
    dependencies: [{ task: 'second', dependsOn: 'first' }], references: [], humanGates: [], reports: [] };
}
async function publish(name: string) {
  const draft = await rest(owner, 'POST', '/blueprints', blueprint(name)); expect(draft.status).toBe(201);
  const id = draft.json.blueprint.id;
  expect((await rest(owner, 'POST', `/blueprints/${id}/versions/1/submit`, {})).status).toBe(200);
  expect((await rest(reviewer, 'POST', `/blueprints/${id}/versions/1/publish`, {})).status).toBe(200); return id;
}
describe('composed Blueprint writes', () => {
  test('phase/feed writes already hold graph lock, so concurrent add waits without lock inversion', async () => {
    const name = `Graph blueprint ${tag()}`; const id = await publish(name); const a = await task(); const b = await task();
    const reached = deferred(); const resume = deferred(); const emit = feedEventService.emit.bind(feedEventService); let paused = false;
    jest.spyOn(feedEventService, 'emit').mockImplementation(async (client: any, event: any) => {
      await emit(client, event);
      if (!paused && event.name === 'phase.created') {
        paused = true;
        const lock = await client.query("SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND relation='task_dependencies'::regclass AND mode='ShareRowExclusiveLock' AND granted");
        expect(lock.rows).toHaveLength(1); reached.resolve(); await resume.promise;
      }
    });
    const creating = settle(rest(owner, 'POST', `/blueprints/${id}/instantiations`, { target: { mode: 'new-project' }, parameterValues: {} }, tag()));
    let adding: ReturnType<typeof settle> | undefined;
    try { await bounded(reached.promise, 'Blueprint did not reach phase/feed boundary'); adding = settle(taskManagerDB.addDependency(a, b, actor)); await waitingGraphWriter(); }
    finally { resume.resolve(); }
    const created = (await creating).value; expect(created.status).toBe(201); expect((await adding!).ok).toBe(true);
    expect(await edges(Object.values(created.json.tasks))).toEqual([{ task_id: created.json.tasks.second, depends_on_task_id: created.json.tasks.first }]);
  });
  test('failure after canonical edge creation rolls back composed objects, edges and feed', async () => {
    const name = `Rolled back graph ${tag()}`; const id = await publish(name); const touched: string[] = [];
    const original = taskManagerDB.addDependency.bind(taskManagerDB);
    jest.spyOn(taskManagerDB, 'addDependency').mockImplementation(async (...args: any[]) => {
      touched.push(args[0], args[1]); await original(...args); throw new Error('Injected late dependency failure');
    });
    const answer = await rest(owner, 'POST', `/blueprints/${id}/instantiations`, { target: { mode: 'new-project' }, parameterValues: {} }, tag());
    expect(answer.status).toBeGreaterThanOrEqual(500); expect(touched).toHaveLength(2);
    expect((await pool.query('SELECT id FROM projects WHERE name=$1', [name])).rows).toEqual([]);
    for (const [table, field] of [['tasks', 'id'], ['task_dependencies', 'task_id'], ['feed_events', 'object_id'], ['task_history', 'task_id']]) {
      expect((await pool.query(`SELECT 1 FROM ${table} WHERE ${field}=ANY($1::uuid[])`, [touched])).rows).toEqual([]);
    }
  });
});
