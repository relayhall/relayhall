/**
 * subtaskByIdAliases.test.ts — task 228441cf: stable-id aliases for the
 * positional Subtask verbs (approve / reject / skip / PUT edit). The
 * production Express router is mounted and driven over HTTP. Contract:
 * identical authorization and semantics to the positional routes; the id
 * resolves inside the manager's row-locked transaction (reorder-race safety
 * comes from delegation, pinned structurally); positional routes KEEP the
 * Deprecation headers while the by-id family carries none.
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import type { AddressInfo } from 'net';

// Owner ruling E462 S4b: the Verifier identity check reads the chain guard in
// SQL (covered live by verificationModesLive); this suite models only the
// identity half of it.
jest.mock('../services/VerificationModes', () => ({
  ...jest.requireActual('../services/VerificationModes'),
  verifierStanding: jest.fn(async (_q: unknown, task: { verifier_principal_id?: string | null }, principalId: string | null) =>
    (principalId && task.verifier_principal_id === principalId ? 'exact' : null)),
}));
jest.mock('../db/connection', () => ({ pool: { query: jest.fn(async () => ({ rows: [] })) } }));
jest.mock('../services/TaskManagerDB', () => {
  const actual = jest.requireActual('../services/TaskManagerDB');
  return {
    ...actual,
    taskManagerDB: {
      getTask: jest.fn(async (taskId: string) => ({ id: taskId, ownerPrincipalId: null, verifierPrincipalId: null })),
      updateSubtaskStatusById: jest.fn(async (taskId: string) => ({ id: taskId, title: 'T', subtasks: [] })),
      updateSubtaskStatus: jest.fn(async (taskId: string) => ({ id: taskId, title: 'T', subtasks: [] })),
      approveSubtask: jest.fn(async (taskId: string) => ({ id: taskId, title: 'T', subtasks: [] })),
      getSubtaskSummaryAsync: jest.fn(async () => ({})),
      allSubtasksCompletedAsync: jest.fn(async () => false),
      hasBlockedSubtasks: jest.fn(async () => false),
      isTaskBlocked: jest.fn(async () => false),
      getBlockingTasks: jest.fn(async () => []),
      getDependentTasks: jest.fn(async () => []),
    },
  };
});
jest.mock('../services/TaskElementService', () => {
  const actual = jest.requireActual('../services/TaskElementService');
  return { ...actual, taskElementService: { listStream: jest.fn(async () => []), listReferences: jest.fn(async () => []) } };
});
jest.mock('../services/taskAnalyzer', () => ({ taskAnalyzer: {} }));
jest.mock('../services/TaskReviewerService', () => ({ taskReviewerService: {} }));
jest.mock('../services/TaskOrchestrationService', () => ({
  taskOrchestrationService: {},
  OrchestrationConflictError: class extends Error { },
}));
jest.mock('../services/DiscordThreadService', () => ({ discordThreadService: {} }));
jest.mock('../services/TaskHistoryService', () => ({ taskHistoryService: { recordChange: jest.fn() } }));
jest.mock('../services/TaskNotificationService', () => ({ taskNotificationService: {} }));
jest.mock('../services/CanonicalRuntimeSignalService', () => ({ canonicalRuntimeSignalService: {} }));
jest.mock('../services/PrincipalService', () => ({ principalService: {} }));
jest.mock('../services/AuthorizationRepository', () => ({
  authorizationRepository: {
    authorizePoint: jest.fn(async (actor: { principalId?: string }, type: string, id: string, verb: string) => ({
      allowed: actor.principalId === '99999999-9999-4999-8999-999999999999'
        && type === 'task' && id === '11111111-1111-4111-8111-111111111111' && verb === 'verify',
    })),
  },
}));
jest.mock('../middleware/sharedAuthorization', () => ({
  ...jest.requireActual('../middleware/sharedAuthorization'),
  filterAuthorizedResources: jest.fn(async (_req: any, _verb: any, rows: any[]) => rows),
}));

import tasksRouter from '../routes/tasks';
import { taskManagerDB } from '../services/TaskManagerDB';
import { authorizationRepository } from '../services/AuthorizationRepository';
import { NotFoundFault, InvalidRequestFault } from '../utils/httpErrors';
import { sharedAuthorizationMiddleware } from '../middleware/sharedAuthorization';
import { authorizationService } from '../services/AuthorizationService';

const TASK = '11111111-1111-4111-8111-111111111111';
let server: ReturnType<typeof express.application.listen>;
let base: string;
let principalRole: string | null = null;
let handle = 'test-agent';
let useSurfaceGate = false;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).principal = { id: '99999999-9999-4999-8999-999999999999', handle, role: principalRole };
    (req as any).userId = handle;
    (req as any).scopes = ['tasks:write'];
    next();
  });
  app.use((req, res, next) => { if (useSurfaceGate) void sharedAuthorizationMiddleware(req, res, next); else next(); });
  app.use('/tasks', tasksRouter);
  server = app.listen(0, () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; done(); });
});
afterAll((done) => { server.close(() => done()); });
afterEach(() => { jest.clearAllMocks(); jest.restoreAllMocks(); useSurfaceGate = false; principalRole = null; handle = 'test-agent'; });

const call = async (method: string, pathname: string, body?: unknown) => {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any, headers: response.headers };
};

describe('stable-id Subtask verb aliases (228441cf)', () => {
  test('approve by id: independent-Verifier gate matches the positional route; delegation carries the fixed reviewer role', async () => {
    handle = 'some-agent'; principalRole = null; // resolves to agent
    const denied = await call('POST', `/tasks/${TASK}/subtasks/by-id/7/approve`);
    expect(denied.status).toBe(403);
    expect(taskManagerDB.updateSubtaskStatusById).not.toHaveBeenCalled();
    expect(authorizationRepository.authorizePoint).not.toHaveBeenCalled();

    handle = 'dashboard_user'; // resolves to reviewer
    const ok = await call('POST', `/tasks/${TASK}/subtasks/by-id/7/approve`);
    expect(ok.status).toBe(200);
    expect(authorizationRepository.authorizePoint).toHaveBeenCalledWith(
      expect.objectContaining({ principalId: '99999999-9999-4999-8999-999999999999' }), 'task', TASK, 'verify');
    // Card 5854f0d6, round 2: the request principal rides as the feed actor only.
    expect(taskManagerDB.updateSubtaskStatusById).toHaveBeenCalledWith(TASK, '7', 'completed', 'reviewer',
      undefined, undefined, undefined, false, expect.objectContaining({ principalId: '99999999-9999-4999-8999-999999999999' }));
    expect(ok.body.subtaskId).toBe('7');
  });

  test('reject by id: orchestrator gate; REJECTED note semantics preserved', async () => {
    handle = 'dashboard_user';
    principalRole = 'admin';
    const ok = await call('POST', `/tasks/${TASK}/subtasks/by-id/7/reject`, { note: 'not quite' });
    expect(ok.status).toBe(200);
    expect(taskManagerDB.updateSubtaskStatusById).toHaveBeenCalledWith(TASK, '7', 'empty', 'orchestrator', 'REJECTED: not quite',
      undefined, undefined, false, expect.objectContaining({ principalId: '99999999-9999-4999-8999-999999999999' }));
  });

  test('skip by id delegates with the fixed orchestrator role', async () => {
    handle = 'dashboard_user'; principalRole = 'admin';
    const ok = await call('POST', `/tasks/${TASK}/subtasks/by-id/7/skip`);
    expect(ok.status).toBe(200);
    expect(taskManagerDB.updateSubtaskStatusById).toHaveBeenCalledWith(TASK, '7', 'skipped', 'orchestrator',
      undefined, undefined, undefined, false, expect.objectContaining({ principalId: '99999999-9999-4999-8999-999999999999' }));
  });

  test('PUT by id: legacy {completed} body maps; identity-derived authority (no body escape hatch)', async () => {
    // The manager now checks actual owner/Main authority under its row lock.
    // This route test checks propagation of that refusal and trusted actor.
    (taskManagerDB.updateSubtaskStatusById as jest.Mock).mockRejectedValueOnce(new (jest.requireActual('../utils/httpErrors').ForbiddenFault)('No owner control'));
    handle = 'some-agent'; // agent may not complete
    const denied = await call('PUT', `/tasks/${TASK}/subtasks/by-id/7`, { completed: true, role: 'orchestrator' });
    expect(denied.status).toBe(403);

    handle = 'dashboard_user'; // reviewer
    const ok = await call('PUT', `/tasks/${TASK}/subtasks/by-id/7`, { completed: true });
    expect(ok.status).toBe(200);
    expect(taskManagerDB.updateSubtaskStatusById).toHaveBeenCalledWith(TASK, '7', 'completed', 'reviewer', undefined, undefined, expect.objectContaining({ handle: 'dashboard_user' }));
    // status-form body works too
    await call('PUT', `/tasks/${TASK}/subtasks/by-id/7`, { status: 'review' });
    expect(taskManagerDB.updateSubtaskStatusById).toHaveBeenLastCalledWith(TASK, '7', 'review', 'reviewer', undefined, undefined, expect.objectContaining({ handle: 'dashboard_user' }));
  });

  test('non-numeric subtaskId gets the typed 400 on every alias', async () => {
    handle = 'dashboard_user';
    for (const [method, pathname] of [
      ['POST', `/tasks/${TASK}/subtasks/by-id/nope/approve`],
      ['POST', `/tasks/${TASK}/subtasks/by-id/nope/reject`],
      ['POST', `/tasks/${TASK}/subtasks/by-id/nope/skip`],
      ['PUT', `/tasks/${TASK}/subtasks/by-id/nope`],
    ] as const) {
      const r = await call(method, pathname, method === 'PUT' ? { status: 'review' } : undefined);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('INVALID_SUBTASK_ID');
    }
    expect(taskManagerDB.updateSubtaskStatusById).not.toHaveBeenCalled();
  });

  test('deprecation parity: positional routes carry the Deprecation header, by-id routes never do', async () => {
    handle = 'dashboard_user';
    const positional = await call('POST', `/tasks/${TASK}/subtasks/0/approve`);
    expect(positional.headers.get('deprecation')).toBe('true');
    const byId = await call('POST', `/tasks/${TASK}/subtasks/by-id/7/approve`);
    expect(byId.headers.get('deprecation')).toBeNull();
    const byIdPut = await call('PUT', `/tasks/${TASK}/subtasks/by-id/7`, { status: 'review' });
    expect(byIdPut.headers.get('deprecation')).toBeNull();
  });

  test('reorder-race safety is by construction: every alias delegates to the row-locking by-id manager path', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tasks.ts'), 'utf-8');
    const family = source.slice(source.indexOf("by-id/:subtaskId/approve"), source.indexOf("PATCH /tasks/:id/subtasks/:index/status"));
    // no alias resolves an index in the route layer
    expect(family).not.toMatch(/parseInt\(req\.params/);
    expect((family.match(/updateSubtaskStatusById\(/g) || []).length).toBeGreaterThanOrEqual(4);
    // the manager resolves the id under a row lock
    const manager = fs.readFileSync(path.join(__dirname, '..', 'services', 'TaskManagerDB.ts'), 'utf-8');
    const byId = manager.slice(manager.indexOf('async updateSubtaskStatusById'));
    expect(byId.slice(0, 1500)).toContain('FOR UPDATE OF s');
  });
});

/**
 * Task f075e779: the stable approve route is the MCP completion path. Its gate
 * is the Task's assigned Verifier + a fresh point `verify` check, never the
 * global automation role a connector handle resolves to.
 */
describe('stable approve: assigned independent Verifier gate and optional evidence (f075e779)', () => {
  const ME = '99999999-9999-4999-8999-999999999999';
  const OWNER = '22222222-2222-4222-8222-222222222222';
  const OTHER = '33333333-3333-4333-8333-333333333333';
  const approve = (body?: unknown) => call('POST', `/tasks/${TASK}/subtasks/by-id/7/approve`, body);
  const taskWith = (ownerPrincipalId: string | null, verifierPrincipalId: string | null) => {
    (taskManagerDB.getTask as jest.Mock).mockResolvedValueOnce({ id: TASK, ownerPrincipalId, verifierPrincipalId });
  };

  test('arbitrary connector handle with null principalRole succeeds when it is the assigned Verifier', async () => {
    handle = 'connector-0083180e'; principalRole = null; // global role resolves to agent
    taskWith(OWNER, ME);
    const ok = await approve();
    expect(ok.status).toBe(200);
    expect(authorizationRepository.authorizePoint).toHaveBeenCalledTimes(1);
    expect(authorizationRepository.authorizePoint).toHaveBeenCalledWith(
      expect.objectContaining({ principalId: ME }), 'task', TASK, 'verify');
    expect(taskManagerDB.updateSubtaskStatusById).toHaveBeenCalledTimes(1);
    expect(taskManagerDB.updateSubtaskStatusById).toHaveBeenCalledWith(TASK, '7', 'completed', 'reviewer',
      undefined, undefined, undefined, false, expect.objectContaining({ principalId: '99999999-9999-4999-8999-999999999999' }));
  });

  test('owner who is also named Verifier is refused before any write', async () => {
    handle = 'connector-0083180e';
    taskWith(ME, ME);
    const denied = await approve({ reviewNote: 'self-approval' });
    expect(denied.status).toBe(403);
    expect(taskManagerDB.updateSubtaskStatusById).not.toHaveBeenCalled();
  });

  test('a different assigned Verifier refuses even a reviewer-role handle (no global-role widening)', async () => {
    handle = 'dashboard_user'; // resolves to reviewer
    taskWith(OWNER, OTHER);
    const denied = await approve();
    expect(denied.status).toBe(403);
    expect(taskManagerDB.updateSubtaskStatusById).not.toHaveBeenCalled();
  });

  test('revoked verify authority refuses; authority is re-read on every call', async () => {
    handle = 'connector-0083180e';
    taskWith(OWNER, ME);
    expect((await approve()).status).toBe(200);
    taskWith(OWNER, ME);
    (authorizationRepository.authorizePoint as jest.Mock).mockResolvedValueOnce({ allowed: false });
    const denied = await approve();
    expect(denied.status).toBe(403);
    expect(authorizationRepository.authorizePoint).toHaveBeenCalledTimes(2);
    expect(taskManagerDB.updateSubtaskStatusById).toHaveBeenCalledTimes(1);
  });

  test('optional reviewNote/blockedReason reach the single row-locked manager call unchanged', async () => {
    handle = 'connector-0083180e';
    taskWith(OWNER, ME);
    const ok = await approve({ reviewNote: 'verified against spec', blockedReason: 'none' });
    expect(ok.status).toBe(200);
    expect(taskManagerDB.updateSubtaskStatusById).toHaveBeenCalledTimes(1);
    expect(taskManagerDB.updateSubtaskStatusById).toHaveBeenCalledWith(
      TASK, '7', 'completed', 'reviewer', 'verified against spec', 'none', undefined, false, expect.objectContaining({ principalId: '99999999-9999-4999-8999-999999999999' }));

    taskWith(OWNER, ME);
    await approve({ reviewNote: 'note only' });
    expect(taskManagerDB.updateSubtaskStatusById).toHaveBeenLastCalledWith(
      TASK, '7', 'completed', 'reviewer', 'note only', undefined, undefined, false, expect.objectContaining({ principalId: '99999999-9999-4999-8999-999999999999' }));
  });

  test('malformed optional evidence is refused with a typed 400 and nothing is written', async () => {
    handle = 'connector-0083180e';
    for (const body of [{ reviewNote: 42 }, { reviewNote: null }, { blockedReason: { x: 1 } }, { reviewNote: 'ok', blockedReason: ['a'] }]) {
      taskWith(OWNER, ME);
      const r = await approve(body);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('INVALID_SUBTASK_EVIDENCE');
    }
    expect(taskManagerDB.updateSubtaskStatusById).not.toHaveBeenCalled();
  });

  test('malformed evidence from a non-Verifier still gets the authorization refusal first', async () => {
    handle = 'connector-0083180e';
    taskWith(OWNER, OTHER);
    const denied = await approve({ reviewNote: 42 });
    expect(denied.status).toBe(403);
    expect(taskManagerDB.updateSubtaskStatusById).not.toHaveBeenCalled();
  });

  test('generic PATCH keeps the handle-derived role: an assigned Verifier connector is NOT upgraded there', async () => {
    handle = 'connector-0083180e'; principalRole = null;
    await call('PATCH', `/tasks/${TASK}/subtasks/by-id/7/status`, { status: 'completed' });
    expect(taskManagerDB.updateSubtaskStatusById).toHaveBeenCalledWith(TASK, '7', 'completed', 'agent', undefined, undefined, expect.objectContaining({ handle: 'connector-0083180e' }), false);
    expect(authorizationRepository.authorizePoint).not.toHaveBeenCalled();
  });
});


describe('stable-id integer-domain boundary', () => {
  test.each(['2147483648', '999999999999', '9'.repeat(1000), '-1', '1.5', '1e2', '1\n', 'nope'])('rejects %s with typed 400 before the mutation manager', async (subtaskId) => {
    handle = 'dashboard_user'; principalRole = 'admin';
    for (const [method, suffix, body] of [
      ['PATCH', '/status', { status: 'review' }],
      ['POST', '/approve', undefined],
      ['POST', '/reject', undefined],
      ['POST', '/skip', undefined],
      ['PUT', '', { status: 'review' }],
    ] as const) {
      const r = await call(method, `/tasks/${TASK}/subtasks/by-id/${encodeURIComponent(subtaskId)}${suffix}`, body);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('INVALID_SUBTASK_ID');
    }
    expect(taskManagerDB.updateSubtaskStatusById).not.toHaveBeenCalled();
  });
});


describe('stable-id valid-domain compatibility', () => {
  test.each(['0', '1', '2147483647', '0002147483647', '0000'])('preserves decimal %s and resolves inside the manager', async (subtaskId) => {
    handle = 'dashboard_user'; principalRole = 'admin';
    for (const [method, suffix, body] of [
      ['PATCH', '/status', { status: 'review' }], ['POST', '/approve', undefined],
      ['POST', '/reject', { note: 'redo' }], ['POST', '/skip', undefined],
      ['PUT', '', { status: 'review' }],
    ] as const) {
      expect((await call(method, `/tasks/${TASK}/subtasks/by-id/${encodeURIComponent(subtaskId)}${suffix}`, body)).status).toBe(200);
      expect((taskManagerDB.updateSubtaskStatusById as jest.Mock).mock.calls.at(-1).slice(0, 2)).toEqual([TASK, subtaskId]);
    }
  });
  test('ordinary unknown in-range id retains the typed 404 on all stable verbs', async () => {
    handle = 'dashboard_user'; principalRole = 'admin';
    for (const [method, suffix, body] of [
      ['PATCH', '/status', { status: 'review' }], ['POST', '/approve', undefined],
      ['POST', '/reject', undefined], ['POST', '/skip', undefined], ['PUT', '', { status: 'review' }],
    ] as const) {
      (taskManagerDB.updateSubtaskStatusById as jest.Mock).mockRejectedValueOnce(new NotFoundFault('Subtask not found: 99', 'SUBTASK_NOT_FOUND'));
      const r = await call(method, `/tasks/${TASK}/subtasks/by-id/99${suffix}`, body);
      expect(r.status).toBe(404); expect(r.body.code).toBe('SUBTASK_NOT_FOUND');
    }
  });
  test('independent Verifier refusal still precedes id validation and mutation', async () => {
    handle = 'connector-other';
    const r = await call('POST', `/tasks/${TASK}/subtasks/by-id/999999999999/approve`);
    expect(r.status).toBe(403);
    expect(taskManagerDB.updateSubtaskStatusById).not.toHaveBeenCalled();
  });
  test('direct manager refuses overflow before acquiring a database connection', async () => {
    const { TaskManagerDB } = jest.requireActual('../services/TaskManagerDB');
    const isolatedPool = { connect: jest.fn(() => { throw new Error('must not touch database'); }) };
    const manager = new TaskManagerDB(isolatedPool);
    for (const id of ['2147483648', '999999999999', '9'.repeat(1000), '-1', 'nope']) {
      await expect(manager.updateSubtaskStatusById(TASK, id, 'completed', 'reviewer')).rejects.toMatchObject({ status: 400, code: 'INVALID_SUBTASK_ID' });
      await expect(manager.updateSubtaskStatusById(TASK, id, 'completed', 'reviewer')).rejects.toBeInstanceOf(InvalidRequestFault);
    }
    expect(isolatedPool.connect).not.toHaveBeenCalled();
  });
});


describe('parent concealment precedes stable-id validation at the production middleware', () => {
  test.each([false, true])('absent/concealed parent (concealed=%s) keeps 404 for valid, missing and overflowing child ids', async (concealed) => {
    useSurfaceGate = true; handle = 'dashboard_user'; principalRole = 'admin';
    jest.spyOn(authorizationService, 'authorizeRoute').mockReturnValue({ allowed: true } as any);
    for (const subtaskId of ['7', '99', '999999999999']) {
      for (const [method, suffix, body] of [
        ['PATCH', '/status', { status: 'review' }], ['POST', '/approve', undefined],
        ['POST', '/reject', undefined], ['POST', '/skip', undefined], ['PUT', '', { status: 'review' }],
      ] as const) {
        (authorizationRepository.authorizePoint as jest.Mock).mockResolvedValueOnce({ exists: concealed, concealed, allowed: false });
        const r = await call(method, `/tasks/${TASK}/subtasks/by-id/${subtaskId}${suffix}`, body);
        expect(r.status).toBe(404); expect(r.body.code).toBe('RESOURCE_NOT_FOUND');
      }
    }
    expect(taskManagerDB.getTask).not.toHaveBeenCalled();
    expect(taskManagerDB.updateSubtaskStatusById).not.toHaveBeenCalled();
  });
});
