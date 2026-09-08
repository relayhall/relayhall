/**
 * archiveAuthzChain.test.ts — candidate A2, review d2ed1775 B1/B2.
 *
 * Drives the PRODUCTION middleware chain exactly as server.ts wires it
 * (identity → sharedAuthorizationMiddleware → tasksRouter; the identity
 * injector stands in for authMiddleware's effect) and proves:
 *   B1 — the collection routes /tasks/ids and /tasks/bulk-archive are
 *        REACHABLE: the classifier treats them as non-object segments
 *        instead of synthesizing a Task id and 404ing;
 *   B2 — per-Task grant validation: the id scope narrows through the shared
 *        authorization adapter before ids leave the route (an id IS a
 *        disclosure), and bulk archive evaluates write authority per Task,
 *        reporting out-of-grant ids as concealed NOT_FOUND without mutating
 *        them.
 */
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const IN_GRANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const IN_GRANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OUT_OF_GRANT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(async () => ({ rows: [] })), connect: jest.fn() },
}));

// The grant boundary: the repository adapter authorizes everything except
// OUT_OF_GRANT; the service's materialized fast-path always defers to it.
const authorizedIdsSpy: jest.Mock = jest.fn(async (_actor: unknown, _type: unknown, ids: string[]) =>
  ids.filter(id => id !== OUT_OF_GRANT));
jest.mock('../services/AuthorizationRepository', () => ({
  authorizationRepository: {
    authorizedIds: (...args: unknown[]) => authorizedIdsSpy(...(args as [unknown, unknown, string[]])),
    authorizePoint: jest.fn(async () => ({ allowed: true, exists: true })),
  },
}));
jest.mock('../services/AuthorizationService', () => ({
  authorizationService: {
    authorizeRoute: jest.fn(() => ({ allowed: true })),
    authorizeResource: jest.fn(() => ({ allowed: false })),
  },
}));

const bulkSpy: jest.Mock = jest.fn(async (ids: string[]) => ({
  results: ids.map(id => ({ id, archived: true, code: 'ARCHIVED' as const })),
  archivedCount: ids.length,
  failedCount: 0,
}));
const queryIdsSpy: jest.Mock = jest.fn(async () => [IN_GRANT_A, IN_GRANT_B, OUT_OF_GRANT]);
const unarchiveSpy: jest.Mock = jest.fn(async () => ({ success: true, task: { id: IN_GRANT_A }, restoredTo: 'review', derivedFrom: 'history' }));
jest.mock('../services/TaskManagerDB', () => ({
  ...(jest.requireActual('../services/TaskManagerDB') as Record<string, unknown>),
  taskManagerDB: {
    queryTaskIds: (...args: unknown[]) => queryIdsSpy(...args),
    bulkArchiveCompleted: (...args: unknown[]) => bulkSpy(...(args as [string[]])),
    unarchiveTask: (...args: unknown[]) => unarchiveSpy(...args),
  },
  SubtaskStatus: {},
  DependencyValidationError: class extends Error {},
  archiveWarningForStatus: jest.fn(() => null),
  computeArchiveDisposition: jest.fn(),
  archiveReasonNote: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tasksRouter = require('../routes/tasks').default;

let server: http.Server;
let base: string;

beforeAll(() => {
  const app = express();
  app.use(express.json());
  // Stand-in for authMiddleware's identity effect only; the authorization
  // middleware under test is the production one.
  app.use((req, _res, next) => {
    (req as any).userId = 'chain-tester';
    (req as any).principal = { id: '99999999-9999-4999-8999-999999999999', role: 'member' };
    (req as any).scopes = ['tasks:read', 'tasks:write'];
    next();
  });
  app.use('/tasks', sharedAuthorizationMiddleware, tasksRouter);
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

test('B1: GET /tasks/ids is reachable through the production authorization chain', async () => {
  const { status, json } = await request('GET', '/tasks/ids?statuses=completed');
  expect(status).toBe(200);
  expect(json.success).toBe(true);
});

test('B2: the id scope narrows through the shared adapter — out-of-grant ids never leave the route', async () => {
  const { json } = await request('GET', '/tasks/ids?statuses=completed');
  expect(json.ids).toEqual([IN_GRANT_A, IN_GRANT_B]);
  expect(json.total).toBe(2);
  expect(authorizedIdsSpy).toHaveBeenCalled();
});

test('B1+B2: POST /tasks/bulk-archive is reachable; out-of-grant ids report concealed NOT_FOUND and are never mutated', async () => {
  const { status, json } = await request('POST', '/tasks/bulk-archive', {
    taskIds: [IN_GRANT_A, OUT_OF_GRANT, IN_GRANT_B],
  });
  expect(status).toBe(200);
  // Input order preserved; the out-of-grant Task reads exactly like a
  // missing one — concealment, not disclosure.
  expect(json.results).toEqual([
    { id: IN_GRANT_A, archived: true, code: 'ARCHIVED' },
    { id: OUT_OF_GRANT, archived: false, code: 'NOT_FOUND', error: 'Task not found' },
    { id: IN_GRANT_B, archived: true, code: 'ARCHIVED' },
  ]);
  expect(json.archivedCount).toBe(2);
  expect(json.failedCount).toBe(1);
  // The mutation layer only ever saw the authorized ids.
  expect(bulkSpy).toHaveBeenCalledTimes(1);
  expect(bulkSpy.mock.calls[0][0]).toEqual([IN_GRANT_A, IN_GRANT_B]);
});

describe('hostile-exception envelopes (review f98d127b B1): no caught message reaches a body', () => {
  const MARKER = 'RH_PRIVATE_MARKER_TEST_9f27';

  test('an ID-lookup failure serializes the fixed IDS_SCOPE_FAILED envelope', async () => {
    queryIdsSpy.mockRejectedValueOnce(new Error(MARKER));
    const { status, json } = await request('GET', '/tasks/ids?statuses=completed');
    expect(status).toBe(500);
    expect(json).toEqual({ success: false, error: 'The Task id scope could not be read', code: 'IDS_SCOPE_FAILED', errorId: expect.any(String) });
    expect(JSON.stringify(json)).not.toContain(MARKER);
  });

  test('a grant-lookup failure on the id scope never discloses the exception', async () => {
    authorizedIdsSpy.mockRejectedValueOnce(new Error(MARKER));
    const { status, json } = await request('GET', '/tasks/ids?statuses=completed');
    expect(status).toBe(500);
    expect(json.code).toBe('IDS_SCOPE_FAILED');
    expect(JSON.stringify(json)).not.toContain(MARKER);
  });

  test('a bulk-mutation failure serializes the fixed BULK_ARCHIVE_FAILED envelope', async () => {
    bulkSpy.mockRejectedValueOnce(new Error(MARKER));
    const { status, json } = await request('POST', '/tasks/bulk-archive', { taskIds: [IN_GRANT_A] });
    expect(status).toBe(500);
    expect(json).toEqual({ success: false, error: 'The bulk archive could not be executed', code: 'BULK_ARCHIVE_FAILED', errorId: expect.any(String) });
    expect(JSON.stringify(json)).not.toContain(MARKER);
  });

  test('an unexpected unarchive failure is a fixed 500, and the known domain outcomes keep their typed surfaces', async () => {
    unarchiveSpy.mockRejectedValueOnce(new Error(MARKER));
    const unexpected = await request('POST', '/tasks/' + IN_GRANT_A + '/unarchive');
    expect(unexpected.status).toBe(500);
    expect(unexpected.json).toEqual({ success: false, error: 'The Task could not be unarchived', code: 'UNARCHIVE_FAILED', errorId: expect.any(String) });
    expect(JSON.stringify(unexpected.json)).not.toContain(MARKER);

    // Domain outcomes are TYPED classes; the same wording inside a plain
    // Error is an unexpected exception and must serialize the fixed 500.
    const { TaskNotFoundError, TaskNotArchivedError } = jest.requireActual('../services/TaskManagerDB');
    unarchiveSpy.mockRejectedValueOnce(new TaskNotArchivedError(IN_GRANT_A));
    const conflict = await request('POST', '/tasks/' + IN_GRANT_A + '/unarchive');
    expect(conflict.status).toBe(409);
    expect(conflict.json.error).toBe('Task is not archived: ' + IN_GRANT_A);
    unarchiveSpy.mockRejectedValueOnce(new TaskNotFoundError(IN_GRANT_A));
    const missing = await request('POST', '/tasks/' + IN_GRANT_A + '/unarchive');
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe('Task not found: ' + IN_GRANT_A);
  });

  test('a hostile message CONTAINING the domain phrases never rides a typed surface (review 14c7f96d B1)', async () => {
    for (const hostile of [
      'database row not found: ' + MARKER,
      'lease is not archived correctly: ' + MARKER,
    ]) {
      unarchiveSpy.mockRejectedValueOnce(new Error(hostile));
      const { status, json } = await request('POST', '/tasks/' + IN_GRANT_A + '/unarchive');
      expect(status).toBe(500);
      expect(json).toEqual({ success: false, error: 'The Task could not be unarchived', code: 'UNARCHIVE_FAILED', errorId: expect.any(String) });
      expect(JSON.stringify(json)).not.toContain(MARKER);
    }
  });
});
