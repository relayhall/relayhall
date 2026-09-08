/**
 * archiveBulkUnarchive.test.ts — candidate A2 (design 986be411 §4, E3/E5;
 * runbook daf703a6 §4-A2; resolves 7092b73d).
 *
 * Route contracts run the PRODUCTION tasks router over HTTP: GET /tasks/ids
 * (enumerated statuses, 400 on unknown), POST /tasks/bulk-archive (shape,
 * cap, full-UUID validation, per-Task result passthrough), and
 * POST /tasks/:id/unarchive (invalid-id 400, not-archived 409, not-found
 * 404, success envelope with restoredTo/derivedFrom).
 *
 * Service behavior drives the REAL TaskManagerDB methods: unarchive-target
 * derivation from the newest status→archived history row with the enumerated
 * restorable set and Completed fallback; the bulk loop's per-Task honesty
 * (NOT_FOUND / ALREADY_ARCHIVED / NOT_COMPLETED / ERROR never silently
 * skip) and its single end-of-run board emit.
 */
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const poolQuery: jest.Mock = jest.fn(async () => ({ rows: [] as any[] }));
jest.mock('../db/connection', () => ({
  pool: { query: (...args: unknown[]) => poolQuery(...args), connect: jest.fn() },
}));
jest.mock('../services/NotificationManager', () => ({
  notificationManager: { notifyStatusChange: jest.fn().mockResolvedValue(undefined) },
}));
const priorStatusSpy: jest.Mock = jest.fn(async () => null);
jest.mock('../services/TaskHistoryService', () => ({
  taskHistoryService: {
    recordChange: jest.fn(),
    priorStatusBeforeArchive: (...args: unknown[]) => priorStatusSpy(...args),
  },
}));

const VALID = (n: string) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`;
const ID_A = VALID('a');
const ID_B = VALID('b');
const ID_C = VALID('c');
const ID_D = VALID('d');

describe('TaskManagerDB unarchive-target derivation (E5)', () => {
  // The real service instance; the history read is the history service's
  // (variant-aware) and is mocked at that boundary here.
  const { taskManagerDB } = jest.requireActual('../services/TaskManagerDB');

  afterEach(() => {
    priorStatusSpy.mockReset();
    priorStatusSpy.mockImplementation(async () => null);
  });

  test('derives the prior state from the history service', async () => {
    priorStatusSpy.mockResolvedValueOnce('in-progress');
    await expect(taskManagerDB.getUnarchiveTarget(ID_A)).resolves.toEqual({
      target: 'in-progress',
      derivedFrom: 'history',
    });
    expect(priorStatusSpy).toHaveBeenCalledWith(ID_A);
  });

  test('falls back to Completed when history has no answer (legacy rows)', async () => {
    await expect(taskManagerDB.getUnarchiveTarget(ID_A)).resolves.toEqual({
      target: 'completed',
      derivedFrom: 'fallback',
    });
  });

  test('a history value outside the enumerated restorable set falls back, never passes through', async () => {
    priorStatusSpy.mockResolvedValueOnce('archived');
    await expect(taskManagerDB.getUnarchiveTarget(ID_A)).resolves.toEqual({
      target: 'completed',
      derivedFrom: 'fallback',
    });
  });

  test('a derivation error degrades to the fallback instead of failing the unarchive', async () => {
    priorStatusSpy.mockRejectedValueOnce(new Error('history table on vacation'));
    await expect(taskManagerDB.getUnarchiveTarget(ID_A)).resolves.toEqual({
      target: 'completed',
      derivedFrom: 'fallback',
    });
  });
});

describe('TaskHistoryService.priorStatusBeforeArchive schema variants (found live on DEV)', () => {
  // Drives the REAL history service against both task_history variants via
  // the mocked shared pool: the newer schema carries the changed field in
  // 'field', the older live-compatibility schema in 'event_type'. A query
  // pinned to one variant silently degraded every unarchive on the other.
  const loadFreshService = () => {
    // requireActual: the file-level TaskHistoryService mock must NOT satisfy
    // this require; resetModules gives each variant test a fresh column
    // cache. The db/connection mock still applies through the registry.
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return jest.requireActual('../services/TaskHistoryService').taskHistoryService;
  };

  afterEach(() => {
    poolQuery.mockReset();
    poolQuery.mockImplementation(async () => ({ rows: [] }));
  });

  test.each([
    ['newer field variant', ['task_id', 'task_title', 'field', 'old_value', 'new_value', 'changed_by', 'created_at'], "field = 'status'"],
    ['older event_type variant', ['task_id', 'event_type', 'old_value', 'new_value', 'note', 'created_at'], "event_type = 'status'"],
  ])('%s: queries the variant column and returns the prior value', async (_label, columns, expectedClause) => {
    const service = loadFreshService();
    poolQuery.mockImplementationOnce(async () => ({ rows: (columns as string[]).map(name => ({ column_name: name })) }));
    poolQuery.mockImplementationOnce(async () => ({ rows: [{ old_value: 'in-progress' }] }));
    await expect(service.priorStatusBeforeArchive(ID_A)).resolves.toBe('in-progress');
    const sql = String(poolQuery.mock.calls[1][0]);
    expect(sql).toContain(expectedClause as string);
    expect(sql).toContain("new_value = 'archived'");
  });

  test('no recognizable variant returns null instead of guessing', async () => {
    const service = loadFreshService();
    poolQuery.mockImplementationOnce(async () => ({ rows: [{ column_name: 'task_id' }, { column_name: 'created_at' }] }));
    await expect(service.priorStatusBeforeArchive(ID_A)).resolves.toBeNull();
  });
});

describe('TaskManagerDB.unarchiveTask (E5)', () => {
  const { taskManagerDB } = jest.requireActual('../services/TaskManagerDB');

  afterEach(() => jest.restoreAllMocks());

  test('restores the history-derived prior state through updateTask', async () => {
    jest.spyOn(taskManagerDB, 'getTask').mockResolvedValue({ id: ID_A, status: 'archived', title: 'T' } as any);
    jest.spyOn(taskManagerDB, 'getUnarchiveTarget').mockResolvedValue({ target: 'review', derivedFrom: 'history' });
    const updateSpy = jest.spyOn(taskManagerDB, 'updateTask').mockResolvedValue({ id: ID_A, status: 'review' } as any);

    const result = await taskManagerDB.unarchiveTask(ID_A, { handle: 'tester', principalId: null } as any);
    expect(updateSpy).toHaveBeenCalledWith(ID_A, { status: 'review' }, expect.anything());
    expect(result.restoredTo).toBe('review');
    expect(result.derivedFrom).toBe('history');
    expect(result.task.status).toBe('review');
  });

  test('refuses a Task that is not archived', async () => {
    jest.spyOn(taskManagerDB, 'getTask').mockResolvedValue({ id: ID_A, status: 'todo' } as any);
    await expect(taskManagerDB.unarchiveTask(ID_A)).rejects.toThrow('not archived');
  });

  test('refuses a missing Task', async () => {
    jest.spyOn(taskManagerDB, 'getTask').mockResolvedValue(undefined);
    await expect(taskManagerDB.unarchiveTask(ID_A)).rejects.toThrow('not found');
  });
});

describe('TaskManagerDB.bulkArchiveCompleted (E3)', () => {
  const { taskManagerDB } = jest.requireActual('../services/TaskManagerDB');

  afterEach(() => jest.restoreAllMocks());

  test('per-Task results are honest: found/missing/already-archived/non-completed each report their code', async () => {
    const tasks: Record<string, any> = {
      [ID_A]: { id: ID_A, status: 'completed', title: 'done' },
      [ID_B]: { id: ID_B, status: 'in-progress', title: 'active' },
      [ID_C]: { id: ID_C, status: 'archived', title: 'gone' },
    };
    jest.spyOn(taskManagerDB, 'getTask').mockImplementation(async (id: any) => tasks[id as string]);
    const archiveSpy = jest.spyOn(taskManagerDB, 'archiveTask').mockResolvedValue({
      success: true, archived: true, disposition: 'completed', task: tasks[ID_A],
    } as any);
    jest.spyOn(taskManagerDB, 'getAllTasks').mockResolvedValue([] as any);
    const emitSpy = jest.spyOn(taskManagerDB, 'emit');

    const outcome = await taskManagerDB.bulkArchiveCompleted([ID_A, ID_B, ID_C, ID_D], { reason: 'sweep' });

    expect(outcome.results).toEqual([
      { id: ID_A, archived: true, code: 'ARCHIVED' },
      { id: ID_B, archived: false, code: 'NOT_COMPLETED', error: 'Task is in-progress, not completed' },
      { id: ID_C, archived: true, code: 'ALREADY_ARCHIVED' },
      { id: ID_D, archived: false, code: 'NOT_FOUND', error: 'Task not found' },
    ]);
    expect(outcome.archivedCount).toBe(2);
    expect(outcome.failedCount).toBe(2);
    // The one real archive ran through archiveTask with the board emit
    // suppressed; the board refresh emitted exactly once, at the end.
    expect(archiveSpy).toHaveBeenCalledTimes(1);
    expect(archiveSpy).toHaveBeenCalledWith(ID_A, { reason: 'sweep', suppressBoardEmit: true }, undefined);
    const boardEmits = emitSpy.mock.calls.filter(call => call[0] === 'tasks.updated');
    expect(boardEmits).toHaveLength(1);
  });

  test('a thrown archive error becomes a FIXED per-Task ERROR result — the exception never reaches response data (review f98d127b B1)', async () => {
    const MARKER = 'RH_SECRET_MARKER_TEST_4c11';
    jest.spyOn(taskManagerDB, 'getTask').mockResolvedValue({ id: ID_A, status: 'completed' } as any);
    jest.spyOn(taskManagerDB, 'archiveTask').mockRejectedValue(new Error(MARKER));
    jest.spyOn(taskManagerDB, 'getAllTasks').mockResolvedValue([] as any);

    const outcome = await taskManagerDB.bulkArchiveCompleted([ID_A]);
    expect(outcome.results[0]).toEqual({ id: ID_A, archived: false, code: 'ERROR', error: 'The Task could not be archived' });
    expect(JSON.stringify(outcome)).not.toContain(MARKER);
    expect(outcome.failedCount).toBe(1);
  });
});

describe('route contracts (production tasks router over HTTP)', () => {
  let server: http.Server;
  let base: string;
  const manager = {
    queryTaskIds: jest.fn(async () => [ID_A, ID_B]),
    bulkArchiveCompleted: jest.fn(async () => ({
      results: [{ id: ID_A, archived: true, code: 'ARCHIVED' }],
      archivedCount: 1,
      failedCount: 0,
    })),
    unarchiveTask: jest.fn(async () => ({
      success: true, task: { id: ID_A, status: 'review' }, restoredTo: 'review', derivedFrom: 'history',
    })),
  };

  beforeAll(async () => {
    jest.resetModules();
    // The routes narrow through the shared authorization adapter (review
    // d2ed1775 B2); this describe pins the ROUTE contracts, so the grant
    // boundary authorizes everything. archiveAuthzChain.test.ts pins the
    // narrowing itself.
    jest.doMock('../services/AuthorizationService', () => ({
      authorizationService: {
        authorizeRoute: jest.fn(() => ({ allowed: true })),
        authorizeResource: jest.fn(() => ({ allowed: true })),
      },
    }));
    jest.doMock('../services/AuthorizationRepository', () => ({
      authorizationRepository: {
        authorizedIds: jest.fn(async (_a: unknown, _t: unknown, ids: string[]) => ids),
        authorizePoint: jest.fn(async () => ({ allowed: true, exists: true })),
      },
    }));
    jest.doMock('../services/TaskManagerDB', () => ({
      ...(jest.requireActual('../services/TaskManagerDB') as Record<string, unknown>),
      taskManagerDB: manager,
      SubtaskStatus: {},
      DependencyValidationError: class extends Error {},
      archiveWarningForStatus: jest.fn(() => null),
      computeArchiveDisposition: jest.fn(),
      archiveReasonNote: jest.fn(),
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const tasksRouter = require('../routes/tasks').default;
    const app = express();
    app.use(express.json());
    app.use('/tasks', tasksRouter);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
  afterEach(() => jest.clearAllMocks());

  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: (await response.json()) as any };
  };

  test('GET /tasks/ids defaults to completed and returns the id set with a total', async () => {
    const { status, json } = await request('GET', '/tasks/ids?projects=RelayHall&tags=frontend');
    expect(status).toBe(200);
    expect(json).toEqual({ success: true, ids: [ID_A, ID_B], total: 2 });
    expect(manager.queryTaskIds).toHaveBeenCalledWith(['completed'], expect.objectContaining({
      projects: ['RelayHall'],
      tags: ['frontend'],
      includeArchived: false,
    }));
  });

  test('GET /tasks/ids rejects unknown statuses with a 400, never a silent empty set', async () => {
    const { status, json } = await request('GET', '/tasks/ids?statuses=finished');
    expect(status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error).toContain('finished');
    expect(manager.queryTaskIds).not.toHaveBeenCalled();
  });

  test('POST /tasks/bulk-archive validates the body shape', async () => {
    expect((await request('POST', '/tasks/bulk-archive', {})).status).toBe(400);
    expect((await request('POST', '/tasks/bulk-archive', { taskIds: [] })).status).toBe(400);
    expect((await request('POST', '/tasks/bulk-archive', { taskIds: ['not-a-uuid'] })).status).toBe(400);
    expect(manager.bulkArchiveCompleted).not.toHaveBeenCalled();
  });

  test('POST /tasks/bulk-archive enforces the server cap with a typed 400', async () => {
    const many = Array.from({ length: 201 }, () => ID_A);
    const { status, json } = await request('POST', '/tasks/bulk-archive', { taskIds: many });
    expect(status).toBe(400);
    expect(json.code).toBe('BULK_CAP_EXCEEDED');
    expect(json.cap).toBe(200);
    expect(manager.bulkArchiveCompleted).not.toHaveBeenCalled();
  });

  test('POST /tasks/bulk-archive passes the id list and reason through and returns per-Task results', async () => {
    const { status, json } = await request('POST', '/tasks/bulk-archive', { taskIds: [ID_A], reason: 'sweep' });
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.results).toEqual([{ id: ID_A, archived: true, code: 'ARCHIVED' }]);
    expect(json.archivedCount).toBe(1);
    expect(manager.bulkArchiveCompleted).toHaveBeenCalledWith([ID_A], { reason: 'sweep' }, expect.anything());
  });

  test('POST /tasks/:id/unarchive returns restoredTo/derivedFrom on success', async () => {
    const { status, json } = await request('POST', `/tasks/${ID_A}/unarchive`);
    expect(status).toBe(200);
    expect(json.restoredTo).toBe('review');
    expect(json.derivedFrom).toBe('history');
  });

  test('POST /tasks/:id/unarchive maps invalid id, not-archived and not-found to typed errors', async () => {
    expect((await request('POST', '/tasks/short/unarchive')).status).toBe(400);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { TaskNotFoundError, TaskNotArchivedError } = jest.requireActual('../services/TaskManagerDB');
    manager.unarchiveTask.mockRejectedValueOnce(new TaskNotArchivedError(ID_A));
    const conflict = await request('POST', `/tasks/${ID_A}/unarchive`);
    expect(conflict.status).toBe(409);
    expect(conflict.json.code).toBe('NOT_ARCHIVED');

    manager.unarchiveTask.mockRejectedValueOnce(new TaskNotFoundError(ID_A));
    expect((await request('POST', `/tasks/${ID_A}/unarchive`)).status).toBe(404);
  });
});
