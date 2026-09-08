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
jest.mock('../services/NotificationManager', () => ({ notificationManager: {} }));
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

const TASK = '11111111-1111-4111-8111-111111111111';
let server: ReturnType<typeof express.application.listen>;
let base: string;
let principalRole: string | null = null;
let handle = 'test-agent';

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).principal = { id: '99999999-9999-4999-8999-999999999999', handle, role: principalRole };
    (req as any).userId = handle;
    (req as any).scopes = ['tasks:write'];
    next();
  });
  app.use('/tasks', tasksRouter);
  server = app.listen(0, () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; done(); });
});
afterAll((done) => { server.close(() => done()); });
afterEach(() => { jest.clearAllMocks(); principalRole = null; handle = 'test-agent'; });

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
    expect(taskManagerDB.updateSubtaskStatusById).toHaveBeenCalledWith(TASK, '7', 'completed', 'reviewer');
    expect(ok.body.subtaskId).toBe('7');
  });

  test('reject by id: orchestrator gate; REJECTED note semantics preserved', async () => {
    handle = 'dashboard_user';
    principalRole = 'admin';
    const ok = await call('POST', `/tasks/${TASK}/subtasks/by-id/7/reject`, { note: 'not quite' });
    expect(ok.status).toBe(200);
    expect(taskManagerDB.updateSubtaskStatusById).toHaveBeenCalledWith(TASK, '7', 'empty', 'orchestrator', 'REJECTED: not quite');
  });

  test('skip by id delegates with the fixed orchestrator role', async () => {
    handle = 'dashboard_user'; principalRole = 'admin';
    const ok = await call('POST', `/tasks/${TASK}/subtasks/by-id/7/skip`);
    expect(ok.status).toBe(200);
    expect(taskManagerDB.updateSubtaskStatusById).toHaveBeenCalledWith(TASK, '7', 'skipped', 'orchestrator');
  });

  test('PUT by id: legacy {completed} body maps; identity-derived authority (no body escape hatch)', async () => {
    handle = 'some-agent'; // agent may not complete
    const denied = await call('PUT', `/tasks/${TASK}/subtasks/by-id/7`, { completed: true, role: 'orchestrator' });
    expect(denied.status).toBe(403);

    handle = 'dashboard_user'; // reviewer
    const ok = await call('PUT', `/tasks/${TASK}/subtasks/by-id/7`, { completed: true });
    expect(ok.status).toBe(200);
    expect(taskManagerDB.updateSubtaskStatusById).toHaveBeenCalledWith(TASK, '7', 'completed', 'reviewer', undefined, undefined);
    // status-form body works too
    await call('PUT', `/tasks/${TASK}/subtasks/by-id/7`, { status: 'review' });
    expect(taskManagerDB.updateSubtaskStatusById).toHaveBeenLastCalledWith(TASK, '7', 'review', 'reviewer', undefined, undefined);
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
