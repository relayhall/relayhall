/** Transaction-bound planning exception. Canonical SQL decisions are exercised
 * over real rows by taskProjectTargetAuthorization; this suite injects failures
 * and stale observations at the writer's pool/authorization boundaries. */
const query = jest.fn();
const release = jest.fn();
jest.mock('../db/connection', () => ({ pool: { query: jest.fn(), connect: async () => ({ query, release }) } }));
jest.mock('../services/LifecyclePolicyService', () => ({ lifecyclePolicyService: { evaluate: jest.fn() } }));
jest.mock('../services/FeedEventService', () => ({ feedEventService: { emit: jest.fn() } }));
jest.mock('../services/TaskHistoryService', () => ({ taskHistoryService: { recordChange: jest.fn() } }));
jest.mock('../utils/taskReadiness', () => ({ syncTaskReadiness: jest.fn(), syncDependentsReadiness: jest.fn() }));
import { TaskManagerDB } from '../services/TaskManagerDB';
import { authorizationRepository } from '../services/AuthorizationRepository';
import { pointAuthorizationTarget } from '../middleware/sharedAuthorization';
import { isPlanningTaskStatusPatch } from '../utils/taskLifecycle';
import type { TaskActor } from '../services/TaskHistoryService';

const id = '11111111-1111-4111-8111-111111111111';
const pid = '22222222-2222-4222-8222-222222222222';
const parent = '33333333-3333-4333-8333-333333333333';
let manager: TaskManagerDB;
let actor: TaskActor;
let row: any;
let chain: any[];
let permission: Set<string>;
let auth: jest.SpyInstance;
let log: jest.SpyInstance;
const statements = () => query.mock.calls.map(([sql]) => String(sql));
beforeEach(() => {
  actor = { principalId: pid, handle: 'planner', role: 'agent', authorization: {
    principalId: pid, handle: 'planner', role: 'user', scopes: ['tasks:read', 'tasks:write'], authenticated: true,
  } };
  row = { id, title: 'plan', status: 'ideas', auto_start: false, archived_at: null, shepherd_principal_id: pid };
  chain = [{ id: pid, kind: 'human', role: 'user', status: 'active', parent_principal_id: null }];
  permission = new Set(['write', 'shepherd']);
  auth = jest.spyOn(authorizationRepository, 'authorizedIds').mockImplementation(async (_actor, _type, ids, action, client) => {
    expect(client).toMatchObject({ query, release });
    return permission.has(action) ? new Set(ids) : new Set();
  });
  log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  query.mockReset(); release.mockClear();
  query.mockImplementation(async (sql: string, values: any[] = []) => {
    if (sql.includes('FROM tasks WHERE id = $1')) return { rows: [{ ...row }] };
    if (sql.startsWith('WITH RECURSIVE chain')) return { rows: chain.map(value => ({ ...value })) };
    if (sql.includes('FROM principal_credentials')) return { rows: values[0] === 'credential' && values[1] === pid ? [{ id: 'credential', scopes:['tasks:read','tasks:write'] }] : [] };
    if (sql.startsWith('UPDATE tasks SET')) row.status = values[0];
    return { rows: [] };
  });
  manager = new TaskManagerDB();
  jest.spyOn(manager as any, 'hydrateTask').mockImplementation(async (value: any) => ({
    id: value.id, title: value.title, status: value.status, autoStart: value.auto_start,
  }));
});
afterEach(() => { auth.mockRestore(); log.mockRestore(); jest.restoreAllMocks(); });

async function denied(updates: any = { status: 'todo' }) {
  await expect(manager.updateTask(id, updates, actor)).rejects.toThrow();
  expect(statements().some(sql => sql.startsWith('UPDATE tasks'))).toBe(false);
  expect(statements()).toContain('ROLLBACK');
  expect(statements()).not.toContain('COMMIT');
}

it.each(['human', 'service'])('allows a current %s Shepherd with task-write, preserving arming', async kind => {
  chain[0].kind = kind;
  const result = await manager.updateTask(id, { status: 'todo' }, actor);
  expect(result).toMatchObject({ status: 'todo', autoStart: false });
  expect(statements()).toContain('SELECT * FROM tasks WHERE id = $1 FOR UPDATE');
  expect(statements().filter(sql => sql.startsWith('WITH RECURSIVE chain'))).toHaveLength(2);
  expect(statements().some(sql => sql.includes('FOR SHARE'))).toBe(false);
  const authorityRead = statements().findIndex(sql => sql.startsWith('WITH RECURSIVE chain'));
  expect(statements().findIndex(sql => sql.startsWith('UPDATE tasks'))).toBeGreaterThan(authorityRead);
  expect(statements().find(sql => sql.startsWith('UPDATE tasks'))).not.toContain('auto_start');
  expect(statements()).toContain('COMMIT');
});
it.each(['ideas', 'todo'])('same-state %s retries retain the authority checks', async status => {
  row.status = status;
  expect((await manager.updateTask(id, { status } as any, actor)).status).toBe(status);
  expect(auth).toHaveBeenCalled();
});
it('allows canonical task administration without requiring a new tasks:admin route scope', async () => {
  row.shepherd_principal_id = parent;
  actor.authorization!.role = 'operator'; chain[0].role = 'operator';
  permission = new Set(['write', 'admin']);
  expect((await manager.updateTask(id, { status: 'todo' }, actor)).status).toBe('todo');
});
it.each(['in-progress', 'review', 'stuck', 'completed', 'archived'])('does not reopen or otherwise plan from %s', async status => {
  row.status = status; await denied();
});
it.each([{ status: 'todo', title: 'replacement' }, { status: 'todo', autoStart: true },
  { status: 'todo', autoStart: false }, { status: 'todo', shepherdPrincipalId: pid },
  { status: 'todo', executionProfile: {} }])('refuses mixed planning payload %j', async updates => { await denied(updates); });
it('refuses a task whose current Shepherd changed after the route observation', async () => { row.shepherd_principal_id = parent; await denied(); });
it('requires independent task-write authority even for the exact Shepherd', async () => { permission.delete('write'); await denied(); });
it('requires canonical shepherd authority in addition to identity equality', async () => { permission.delete('shepherd'); await denied(); });
it('refuses missing authorization rather than using the system fallback', async () => { delete actor.authorization; await denied(); });
it('refuses mismatched trusted actor identities', async () => { actor.authorization!.principalId = parent; await denied(); });
it('refuses missing task-write scope despite object authority', async () => { actor.authorization!.scopes = ['tasks:read']; await denied(); });
it('refuses a disabled acting principal', async () => { chain[0].status = 'disabled'; await denied(); });
it('refuses a role narrowed since authentication', async () => { chain[0].role = 'viewer'; await denied(); });
it('does not widen a trusted session ceiling from a fresh administrator role', async () => {
  row.shepherd_principal_id = parent; chain[0].role = 'admin'; permission = new Set(['write', 'admin']);
  // Canonical repository rejects the trusted user admin ceiling; model that decision here.
  auth.mockImplementation(async (who, _type, ids, action) => action === 'admin' && who.role === 'user' ? new Set() : new Set(ids));
  await denied();
});
function delegated(kind = 'service') {
  chain[0] = { ...chain[0], kind, parent_principal_id: parent, live_credential_count: 1, own_expression: { scopes: 'parent', objects: 'parent' } };
  chain.push({ id: parent, kind: 'human', role: 'user', status: 'active', parent_principal_id: null });
}
it('refuses a disabled ancestor', async () => { delegated(); chain[1].status = 'disabled'; await denied(); });
it('refuses a revoked delegated credential', async () => { delegated(); chain[0].live_credential_count = 0; await denied(); });
it('refuses the exact presented credential when another credential is live', async () => {
  actor.credentialId = 'revoked'; await denied();
});
it('refuses a cross-bound Agent', async () => { delegated('agent'); chain[0].bound_task_id = parent; await denied(); });
it('re-evaluates current delegated scope narrowing', async () => {
  delegated(); chain[0].own_expression.scopes = ['tasks:read']; await denied();
});
it('binds the credential decision to the presented credential and acting principal', async () => {
  actor.credentialId = 'credential';
  await manager.updateTask(id, { status: 'todo' }, actor);
  expect(query.mock.calls.find(([sql]) => String(sql).startsWith('SELECT id, scopes FROM principal_credentials'))?.[1])
    .toEqual(['credential', pid]);
});
it('rolls back on authorization substrate failure without performing the update', async () => {
  auth.mockRejectedValue(new Error('authorization database unavailable')); await denied();
});
it('rolls back on chain substrate failure', async () => {
  const original = query.getMockImplementation()!;
  query.mockImplementation(async (sql, values) => {
    if (String(sql).startsWith('WITH RECURSIVE chain')) throw new Error('chain unavailable');
    return original(sql, values);
  });
  await denied();
});
it('keeps the generic point classifier write-only for planning and mixed payloads', () => {
  for (const body of [{ status: 'todo' }, { status: 'ideas', title: 'content' }]) {
    expect(pointAuthorizationTarget('PATCH', '/tasks/' + id, body)).toEqual({ type: 'task', identifier: id, action: 'write' });
  }
  expect(isPlanningTaskStatusPatch({ status: 'todo' })).toBe(true);
  expect(isPlanningTaskStatusPatch({ status: 'todo', role: 'orchestrator' })).toBe(false);
});
