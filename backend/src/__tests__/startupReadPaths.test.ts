/**
 * startupReadPaths.test.ts — card 6a351638 (R19): the two startup read paths
 * that hydrated the estate to answer small questions.
 *
 * filter-options loaded and hydrated EVERY task (then authorization-filtered
 * them in JS) to emit two lists of distinct strings; dashboard/active
 * re-queried a per-task subtask summary for rows whose subtasks it had just
 * hydrated. Both routes now answer from what they already have: an
 * id-independent (blanket) reader takes the SQL DISTINCT aggregates, and the
 * active list counts its own hydrated subtask rows. Scoped readers keep the
 * row-filtered options path bit-for-bit: the options list must never leak a
 * tag or project name visible only through unauthorized tasks.
 */
import express from 'express';
import type { AddressInfo } from 'net';

const authState = { blanket: true };
const filterState = { dropTaskIds: new Set<string>() };

jest.mock('../db/connection', () => ({ pool: { query: jest.fn(async () => ({ rows: [] })) } }));
jest.mock('../services/TaskManagerDB', () => {
  const actual = jest.requireActual('../services/TaskManagerDB');
  return {
    ...actual,
    taskManagerDB: {
      queryTasks: jest.fn(async () => []),
      getTaskFilterOptions: jest.fn(async () => ({ tags: [], projects: [] })),
      getSubtaskSummaryAsync: jest.fn(async () => { throw new Error('per-task summary round-trip is retired on this path'); }),
      getSubtaskSummary: jest.fn(() => { throw new Error('sync summary retired'); }),
      getBlockingTasks: jest.fn(async () => []),
      getDependentTasks: jest.fn(async () => []),
      hasBlockedSubtasks: jest.fn(async () => false),
      isTaskBlocked: jest.fn(async () => false),
      allSubtasksCompletedAsync: jest.fn(async () => false),
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
jest.mock('../services/TaskHistoryService', () => ({ taskHistoryService: { recordChange: jest.fn(), getRecentHistory: jest.fn(async () => []) } }));
jest.mock('../services/TaskNotificationService', () => ({ taskNotificationService: {} }));
jest.mock('../services/CanonicalRuntimeSignalService', () => ({ canonicalRuntimeSignalService: {} }));
jest.mock('../services/PrincipalService', () => ({ principalService: {} }));
jest.mock('../services/ReportManager', () => ({ reportManager: { listVisibilityRows: jest.fn(async () => []) } }));
jest.mock('../services/AuthorizationService', () => ({
  authorizationService: {
    authorizeResource: jest.fn(() => ({ allowed: authState.blanket, basis: authState.blanket ? 'administrator' : undefined, denial: authState.blanket ? undefined : 'NO_GRANT' })),
  },
}));
jest.mock('../middleware/sharedAuthorization', () => ({
  actorFromRequest: jest.fn(() => ({ principalId: 'p', handle: 'test', role: 'agent', scopes: [], authenticated: true })),
  filterAuthorizedResources: jest.fn(async (_req: any, _verb: any, rows: any[], resourceFor: (v: any) => { id: string }) =>
    rows.filter(row => !filterState.dropTaskIds.has(resourceFor(row).id))),
  // Card 72258a60: /dashboard/* now composes the list form of the same
  // predicate. A partial mock of this module would leave that import
  //  and the route would fail for a reason unrelated to what these
  // tests measure (the memory case:  wholesale drops siblings).
  authorizedListScope: jest.fn(() => ({
    type: 'task', from: 'tasks t', id: 't.id', render: () => ({ sql: 'TRUE', params: [] }),
  })),
}));

import tasksRouter from '../routes/tasks';
import dashboardRouter from '../routes/dashboard';
import { taskManagerDB } from '../services/TaskManagerDB';

let server: ReturnType<typeof express.application.listen>;
let base: string;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).principal = { id: '99999999-9999-4999-8999-999999999999', handle: 'test', role: null };
    (req as any).userId = 'test';
    (req as any).scopes = ['tasks:read'];
    next();
  });
  app.use('/tasks', tasksRouter);
  app.use('/dashboard', dashboardRouter);
  server = app.listen(0, () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; done(); });
});
afterAll((done) => { server.close(() => done()); });
afterEach(() => { jest.clearAllMocks(); authState.blanket = true; filterState.dropTaskIds = new Set(); });

const get = async (pathname: string) => {
  const response = await fetch(`${base}${pathname}`);
  return { status: response.status, body: (await response.json()) as any };
};

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('GET /tasks/filter-options — card 6a351638', () => {
  test('a blanket reader takes the SQL aggregates and never hydrates the estate', async () => {
    authState.blanket = true;
    (taskManagerDB.getTaskFilterOptions as jest.Mock).mockResolvedValueOnce({
      tags: ['zeta', 'Alpha'], projects: ['beta project', 'Alpha Project'],
    });
    const res = await get('/tasks/filter-options');
    expect(res.status).toBe(200);
    // Same comparator as the filtered path (localeCompare), whatever order
    // the SQL collation produced.
    expect(res.body.tags).toEqual(['Alpha', 'zeta'].sort((a, b) => a.localeCompare(b)));
    expect(res.body.projects).toEqual(['Alpha Project', 'beta project'].sort((a, b) => a.localeCompare(b)));
    expect(taskManagerDB.getTaskFilterOptions).toHaveBeenCalledWith(true);
    // The whole point: no estate-wide hydration on this path.
    expect(taskManagerDB.queryTasks).not.toHaveBeenCalled();
  });

  test('includeArchived=false reaches the aggregate scope', async () => {
    authState.blanket = true;
    await get('/tasks/filter-options?includeArchived=false');
    expect(taskManagerDB.getTaskFilterOptions).toHaveBeenCalledWith(false);
  });

  test('a scoped reader keeps the row-filtered path: no aggregate call, no leaked names', async () => {
    authState.blanket = false;
    filterState.dropTaskIds = new Set([B]);
    (taskManagerDB.queryTasks as jest.Mock).mockResolvedValueOnce([
      { id: A, tags: ['visible-tag'], project: 'Visible Project' },
      { id: B, tags: ['secret-tag'], project: 'Secret Project' },
    ]);
    const res = await get('/tasks/filter-options');
    expect(res.status).toBe(200);
    expect(res.body.tags).toEqual(['visible-tag']);
    expect(res.body.projects).toEqual(['Visible Project']);
    // The names visible only through the unauthorized task must be absent.
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(taskManagerDB.getTaskFilterOptions).not.toHaveBeenCalled();
  });
});

describe('GET /dashboard/active — card 6a351638', () => {
  test('subtask progress is counted from the hydrated rows, with zero per-task summary round-trips', async () => {
    (taskManagerDB.queryTasks as jest.Mock).mockResolvedValueOnce([
      {
        id: A, title: 'Busy', status: 'in-progress', priority: 'high', project: 'P',
        updated: '2026-08-21T02:00:00Z',
        subtasks: [
          { status: 'completed' }, { status: 'completed' }, { status: 'skipped' },
          { status: 'review' }, { status: 'in-progress' }, { status: 'stuck' }, { status: 'empty' },
        ],
      },
      { id: B, title: 'Bare', status: 'in-progress', priority: 'low', project: null, updated: '2026-08-21T01:00:00Z', subtasks: [] },
    ]);
    const res = await get('/dashboard/active');
    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(2);
    expect(res.body.tasks[0].subtaskProgress).toEqual({
      total: 7, completed: 2, skipped: 1, review: 1, inProgress: 1, stuck: 1, empty: 1,
    });
    expect(res.body.tasks[1].subtaskProgress).toEqual({
      total: 0, completed: 0, skipped: 0, review: 0, inProgress: 0, stuck: 0, empty: 0,
    });
    // The retired round-trip: the mock THROWS if the route still calls it, so
    // the old code cannot pass this test by coincidence.
    expect(taskManagerDB.getSubtaskSummaryAsync).not.toHaveBeenCalled();
  });
});
