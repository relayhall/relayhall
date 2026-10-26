/** Writer-bound whole-Task approval. Real point SQL and concurrency run in
 * taskProjectTargetAuthorization; this suite injects substrate failures. */
const query = jest.fn();
const release = jest.fn();
// Owner ruling E462 S4b: the Verifier identity check reads the chain guard in
// SQL (covered live by verificationModesLive); this suite models only the
// identity half of it.
jest.mock('../services/VerificationModes', () => ({
  ...jest.requireActual('../services/VerificationModes'),
  verifierStanding: jest.fn(async (_q: unknown, task: { verifier_principal_id?: string | null }, principalId: string | null) =>
    (principalId && task.verifier_principal_id === principalId ? 'exact' : null)),
}));
jest.mock('../db/connection', () => ({ pool: { query: jest.fn(), connect: async () => ({ query, release }) } }));
jest.mock('../services/LifecyclePolicyService', () => ({ lifecyclePolicyService: { evaluate: jest.fn() } }));
jest.mock('../services/FeedEventService', () => ({ feedEventService: { emit: jest.fn() } }));
jest.mock('../services/TaskHistoryService', () => ({ taskHistoryService: { recordChange: jest.fn() } }));
jest.mock('../utils/taskReadiness', () => ({ syncTaskReadiness: jest.fn(), syncDependentsReadiness: jest.fn() }));
import { TaskManagerDB } from '../services/TaskManagerDB';
import { authorizationRepository } from '../services/AuthorizationRepository';
import { pointAuthorizationTarget } from '../middleware/sharedAuthorization';
import { isTaskCompletionPatch } from '../utils/taskLifecycle';
import { ForbiddenFault } from '../utils/httpErrors';
import type { TaskActor } from '../services/TaskHistoryService';

const id = '11111111-1111-4111-8111-111111111111';
const pid = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
let manager: TaskManagerDB;
let actor: TaskActor;
let row: any;
let chain: any[];
let children: string[];
let auth: jest.SpyInstance;
const statements = () => query.mock.calls.map(([sql]) => String(sql));
beforeEach(() => {
  actor = { principalId: pid, handle: 'verifier', role: 'agent', authorization: {
    principalId: pid, handle: 'verifier', role: 'user', scopes: ['tasks:read', 'tasks:write'], authenticated: true,
  } };
  row = { id, title: 'verify', status: 'review', auto_start: false, archived_at: null, verifier_principal_id: pid, owner_principal_id: other };
  chain = [{ id: pid, kind: 'human', role: 'user', status: 'active', parent_principal_id: null }];
  children = [];
  auth = jest.spyOn(authorizationRepository, 'authorizedIds').mockImplementation(async (_actor, _type, ids, action, client) => {
    expect(client).toMatchObject({ query, release });
    return action === 'verify' ? new Set(ids) : new Set();
  });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  query.mockReset(); release.mockClear();
  query.mockImplementation(async (sql: string, values: any[] = []) => {
    if (sql.includes('FROM tasks WHERE id = $1')) return { rows: [{ ...row }] };
    if (sql.startsWith('WITH RECURSIVE chain')) return { rows: chain.map(value => ({ ...value })) };
    if (sql.startsWith('SELECT id FROM principal_credentials')) return { rows: values[0] === 'credential' && values[1] === pid ? [{ id: 'credential' }] : [] };
    if (sql.startsWith('SELECT status FROM subtasks')) return { rows: children.map(status => ({ status })) };
    if (sql.startsWith('UPDATE tasks SET')) row.status = values[0];
    return { rows: [] };
  });
  manager = new TaskManagerDB();
  jest.spyOn(manager as any, 'hydrateTask').mockImplementation(async (value: any) => ({
    id: value.id, title: value.title, status: value.status, autoStart: value.auto_start,
  }));
});
afterEach(() => jest.restoreAllMocks());
async function denied(updates: any = { status: 'completed' }, who: TaskActor | undefined = actor) {
  await expect(manager.updateTask(id, updates, who)).rejects.toThrow();
  expect(statements().some(sql => sql.startsWith('UPDATE tasks'))).toBe(false);
  expect(statements()).not.toContain('COMMIT');
}
it.each([{ statuses: [] }, { statuses: ['completed'] }, { statuses: ['completed', 'skipped'] }])('allows independent Verifier with terminal children %j', async ({ statuses }) => {
  children = statuses;
  const result = await manager.updateTask(id, { status: 'completed' }, actor);
  expect(result).toMatchObject({ status: 'completed', autoStart: false });
  const parentLock = statements().indexOf('SELECT * FROM tasks WHERE id = $1 FOR UPDATE');
  const childLock = statements().indexOf('SELECT status FROM subtasks WHERE task_id = $1 ORDER BY id FOR UPDATE NOWAIT');
  const chainRead = statements().findIndex(sql => sql.startsWith('WITH RECURSIVE chain'));
  expect(parentLock).toBeGreaterThan(0); expect(childLock).toBeGreaterThan(parentLock); expect(chainRead).toBeGreaterThan(childLock);
  expect(auth.mock.calls.every(call => call[3] === 'verify')).toBe(true);
  expect(statements()).toContain('COMMIT');
});
it.each(['empty', 'in-progress', 'review', 'stuck'])('refuses nonterminal child %s', async status => { children = [status]; await denied(); });
it.each(['ideas', 'todo', 'in-progress', 'stuck', 'completed', 'archived'])('refuses source state %s', async status => { row.status = status; await denied(); });
it('refuses archived review rows', async () => { row.archived_at = '2026-09-26'; await denied(); });
it('requires exact current Verifier', async () => { row.verifier_principal_id = other; await denied(); });
it('requires independence from the current Assignee', async () => { row.owner_principal_id = pid; await denied(); });
it('does not use a system fallback for omitted actor', async () => {
  await expect(manager.updateTask(id, { status: 'completed' })).rejects.toBeInstanceOf(ForbiddenFault);
  expect(query).not.toHaveBeenCalled();
});
it('requires authenticated request authorization', async () => { delete actor.authorization; await denied(); });
it('binds request and live principal identity', async () => { actor.authorization!.principalId = other; await denied(); });
it('requires task-write route scope even with canonical verify', async () => { actor.authorization!.scopes = ['tasks:read']; await denied(); });
it('requires canonical verify in addition to current role equality', async () => { auth.mockResolvedValue(new Set()); await denied(); });
it('honors a fresh role downgrade', async () => { chain[0].role = 'viewer'; await denied(); });
it('honors current principal disablement', async () => { chain[0].status = 'disabled'; await denied(); });
it('honors exact presented credential revocation', async () => { actor.credentialId = 'revoked'; await denied(); });
it('checks both trusted and fresh canonical actors', async () => {
  chain[0].role = 'operator';
  await manager.updateTask(id, { status: 'completed' }, actor);
  expect(auth.mock.calls.map(call => call[0].role)).toEqual(['user', 'operator']);
});
it.each([{ title: 'mixed' }, { autoStart: false }, { subtasks: [] }, { role: 'reviewer' }, { id: 'ignored' }])('refuses mixed completion patch %j', async extra => {
  await denied({ status: 'completed', ...extra });
});
it('maps only the child NOWAIT conflict to a fixed retryable error and rolls back', async () => {
  const original = query.getMockImplementation()!;
  query.mockImplementation(async (sql, values) => {
    if (String(sql).endsWith('FOR UPDATE NOWAIT')) throw Object.assign(new Error('private SQL detail'), { code: '55P03' });
    return original(sql, values);
  });
  await expect(manager.updateTask(id, { status: 'completed' }, actor)).rejects.toMatchObject({
    status: 409, code: 'TASK_COMPLETION_BUSY', message: 'Task is being changed; retry completion',
  });
  expect(statements()).toContain('ROLLBACK'); expect(statements()).not.toContain('COMMIT');
  expect(statements().some(sql => sql.startsWith('UPDATE tasks'))).toBe(false);
});
it.each(['XX000', '08006'])('does not transmute child database fault %s', async code => {
  const original = query.getMockImplementation()!;
  const failure = Object.assign(new Error('database unavailable'), { code });
  query.mockImplementation(async (sql, values) => {
    if (String(sql).endsWith('FOR UPDATE NOWAIT')) throw failure;
    return original(sql, values);
  });
  await expect(manager.updateTask(id, { status: 'completed' }, actor)).rejects.toBe(failure);
  expect(statements()).toContain('ROLLBACK');
});
it('does not map an unrelated authority query 55P03 as a child retry', async () => {
  const failure = Object.assign(new Error('authority unavailable'), { code: '55P03' });
  auth.mockRejectedValue(failure);
  await expect(manager.updateTask(id, { status: 'completed' }, actor)).rejects.toBe(failure);
  expect(statements()).toContain('ROLLBACK');
});
it('preserves the explicit internal structured-review role path', async () => {
  actor.role = 'reviewer'; actor.authMethod = 'system'; actor.principalId = null; delete actor.authorization;
  row.verifier_principal_id = other; row.owner_principal_id = pid;
  children = ['completed'];
  expect((await manager.updateTask(id, { status: 'completed' }, actor)).status).toBe('completed');
  expect(auth).not.toHaveBeenCalled();
  expect(statements()).toContain('SELECT status FROM subtasks WHERE task_id = $1 ORDER BY id FOR UPDATE NOWAIT');
});
it('classifies only the original pure completed body as verify', () => {
  for (const route of ['/tasks/' + id, '/TASKS/' + id + '/']) {
    expect(pointAuthorizationTarget('PATCH', route, { status: 'completed' })).toEqual({ type: 'task', identifier: id, action: 'verify' });
  }
  for (const body of [{ status: 'todo' }, { status: 'completed', title: 'mixed' }, { status: 'completed', id }]) {
    expect(pointAuthorizationTarget('PATCH', '/tasks/' + id, body)).toEqual({ type: 'task', identifier: id, action: 'write' });
    expect(isTaskCompletionPatch(body)).toBe(false);
  }
});

it.each(['reviewer','qa','orchestrator'])('external %s role still uses exact current Verifier and locked source', async role => {
  actor.role = role; actor.authorization!.role = role; chain[0].role = role;
  row.verifier_principal_id = other;
  await denied();
  expect(statements()).toContain('SELECT * FROM tasks WHERE id = $1 FOR UPDATE');
});
it('an internal-looking role without explicit system provenance cannot bypass current Verifier', async () => {
  actor.role = 'reviewer'; delete actor.authorization;
  await denied();
});

it('direct writer does not let raw pure shape hide mixed actual updates', async () => {
  await expect(manager.updateTask(id, { status: 'completed', title: 'mixed' }, actor, undefined, undefined, { status: 'completed' }))
    .rejects.toMatchObject({ code: 'TASK_COMPLETION_PATCH_REQUIRED' });
  expect(statements().some(sql => sql.startsWith('UPDATE tasks'))).toBe(false);
});
it('direct writer respects original ignored fields even when normalized updates are pure', async () => {
  await expect(manager.updateTask(id, { status: 'completed' }, actor, undefined, undefined, { status: 'completed', id: 'ignored' }))
    .rejects.toMatchObject({ code: 'TASK_COMPLETION_PATCH_REQUIRED' });
});
it('mixed unchanged Completed uses canonical write rather than verify', async () => {
  row.status = 'completed';
  auth.mockImplementation(async (_actor, _type, ids, action) => action === 'write' ? new Set(ids) : new Set());
  await manager.updateTask(id, { status: 'completed', title: 'metadata' }, actor);
  expect(auth.mock.calls.every(call => call[3] === 'write')).toBe(true);
  expect(statements()).toContain('COMMIT');
});
it('verify-only authority cannot edit metadata by repeating unchanged Completed', async () => {
  row.status = 'completed'; await denied({ status: 'completed', title: 'metadata' });
});
it('the classifier matrix retains task and subtask review, planning and mixed writes', () => {
  expect(pointAuthorizationTarget('POST', '/tasks/'+id+'/subtasks/by-id/1/approve')).toMatchObject({ action: 'verify' });
  expect(pointAuthorizationTarget('POST', '/tasks/reviewer/'+id+'/review')).toMatchObject({ action: 'verify' });
  expect(pointAuthorizationTarget('PATCH', '/tasks/'+id, { status: 'ideas' })).toMatchObject({ action: 'write' });
  expect(pointAuthorizationTarget('PATCH', '/tasks/'+id, { status: 'completed', notes: 'metadata' })).toMatchObject({ action: 'write' });
});
