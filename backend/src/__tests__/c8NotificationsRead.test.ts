/**
 * c8NotificationsRead.test.ts — RH-P3.C8 round 2 (review 4243b06e B1), the
 * notification READ MODEL's route, re-pointed at its new source (card
 * b1e3b16d, hub lane L2).
 *
 * WHERE EACH ASSERTION LIVES NOW. The read model used to be a JSON file the
 * route filtered in memory, so this file could prove the addressing and grant
 * filters with a mocked store. Lane L2 moved both filters INTO SQL (the shared
 * task predicate as a semi-join; the stuck notice addressed to
 * COALESCE(shepherd, creator, owner)), and a mocked pool cannot evaluate SQL.
 * The four C8 assertions are therefore measured on a REAL PostgreSQL in
 * `notificationReadStateLive.test.ts`, under the same names:
 *  - the entitled human sees the notice addressed to them   -> (5) first test;
 *  - an under-granted principal is concealed: no title, no row -> (4) and (5);
 *  - a caller with NO grants sees nothing                     -> (4) "C, with no grant at all";
 *  - root sees the full addressed set                         -> (5) "root sees the full addressed set".
 *
 * What THIS file still proves, with no database: the production route hands
 * the CALLER's identity — principal, root, session — to the read model and no
 * one else's; `who` defaults to "My work" (E44 Q4); a filter outside the
 * grammar is a 400, never a silently wider list; an identity with no principal
 * is refused rather than shown an empty list it could mistake for "nothing new";
 * and the envelope reports exactly what the read model returned.
 */
import express from 'express';
import type { AddressInfo } from 'net';

const ALICE = '99999999-9999-4999-8999-999999999999';
const TASK = '11111111-1111-4111-8111-111111111111';

const calls: { list: any[]; count: any[]; read: any[]; readAll: any[] } = { list: [], count: [], read: [], readAll: [] };
const ROW = {
  id: 'feed:42', type: 'stuck', event: 'exception', taskId: TASK, taskTitle: 'Shared fixture task',
  from: null, to: null, timestamp: '2026-10-10T04:01:00.000Z', read: false, actorHandle: null,
  exception: { name: 'task.stuck', reason: 'status_stale' }, cursor: '1760068860000000.feed:42',
};

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(async () => ({ rows: [] })), connect: jest.fn() },
}));
jest.mock('../services/NotificationHistoryService', () => {
  const actual = jest.requireActual('../services/NotificationHistoryService');
  return {
    ...actual,
    notificationHistoryService: {
      list: jest.fn(async (viewer: any, query: any) => { calls.list.push({ viewer, query }); return { notifications: [ROW], nextCursor: null, hasMore: false }; }),
      unreadCount: jest.fn(async (viewer: any, query: any) => { calls.count.push({ viewer, query }); return 1; }),
      markRead: jest.fn(async (viewer: any, key: string) => { calls.read.push({ viewer, key }); return key === 'feed:42'; }),
      markAllRead: jest.fn(async (viewer: any, query: any) => { calls.readAll.push({ viewer, query }); return 3; }),
    },
  };
});
jest.mock('../services/TaskManagerDB', () => {
  const actual = jest.requireActual('../services/TaskManagerDB');
  return {
    ...actual,
    taskManagerDB: {
      getTask: jest.fn(async () => undefined),
      queryLinkedReports: jest.fn(async () => []),
      getBlockingTasks: jest.fn(async () => []),
    },
  };
});
jest.mock('../services/ReportManager', () => ({ reportManager: { getBriefProjections: jest.fn(async () => []) } }));
jest.mock('../services/taskAnalyzer', () => ({ taskAnalyzer: {} }));
jest.mock('../services/NotificationEndpointService', () => ({ notificationEndpointService: { dispatchException: jest.fn() } }));
jest.mock('../services/TelemetryService', () => ({ telemetryService: { livenessForTask: jest.fn(async () => null) } }));
jest.mock('../services/CanonicalRuntimeSignalService', () => ({ canonicalRuntimeSignalService: { listTaskSignals: jest.fn(async () => []) } }));
jest.mock('../services/TaskReviewerService', () => ({ taskReviewerService: {} }));
jest.mock('../services/TaskOrchestrationService', () => ({
  taskOrchestrationService: {},
  OrchestrationConflictError: class extends Error { },
}));
jest.mock('../services/DiscordThreadService', () => ({ discordThreadService: {} }));
jest.mock('../services/TaskHistoryService', () => ({ taskHistoryService: { recordChange: jest.fn() } }));
jest.mock('../services/TaskNotificationService', () => ({ taskNotificationService: {} }));
jest.mock('../services/PrincipalService', () => ({ principalService: {} }));
jest.mock('../services/UnifiedTaskTimeline', () => ({ unifiedTaskTimeline: {}, decodeCursor: jest.fn() }));

import tasksRouter from '../routes/tasks';

const identity = {
  principal: { id: ALICE, handle: 'alice' } as { id: string; handle: string } | null,
  scopes: ['tasks:read', 'tasks:write'] as string[],
  authMethod: 'session' as string | undefined,
};

let server: ReturnType<typeof express.application.listen>;
let base = '';

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).principal = identity.principal;
    (req as any).scopes = identity.scopes;
    (req as any).authMethod = identity.authMethod;
    (req as any).userId = identity.principal?.handle ?? 'anon';
    next();
  });
  app.use('/tasks', tasksRouter);
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});
afterAll((done) => { server.close(() => done()); });
beforeEach(() => {
  calls.list = []; calls.count = []; calls.read = []; calls.readAll = [];
  identity.principal = { id: ALICE, handle: 'alice' };
  identity.scopes = ['tasks:read', 'tasks:write'];
  identity.authMethod = 'session';
});

const get = async (query = '') => {
  const response = await fetch(`${base}/tasks/notifications${query}`);
  return { status: response.status, body: (await response.json()) as any };
};

describe('GET /tasks/notifications — the route hands the CALLER to the read model', () => {
  test('the caller\'s principal, root flag and session standing reach the read model; My work is the default', async () => {
    const { status, body } = await get('?unread=true');
    expect(status).toBe(200);
    expect(calls.list).toHaveLength(1);
    const { viewer, query } = calls.list[0];
    expect({ principalId: viewer.principalId, isRoot: viewer.isRoot, isSession: viewer.isSession })
      .toEqual({ principalId: ALICE, isRoot: false, isSession: true });
    expect(viewer.taskScope.type).toBe('task');
    expect(query).toMatchObject({ who: 'mine', types: [], unreadOnly: true, before: null, limit: 50 });
    expect(body).toMatchObject({ success: true, count: 1, unreadCount: 1, unreadCountCapped: false, who: 'mine', hasMore: false });
    expect(body.notifications).toEqual([ROW]);
  });

  test('a bearer caller is not a session: the read model is told so (approval rows are session-only)', async () => {
    identity.authMethod = 'principal_api_key';
    await get();
    expect(calls.list[0].viewer.isSession).toBe(false);
    expect(calls.list[0].viewer.isAdministrator).toBe(false);
  });

  test('root is passed as root', async () => {
    identity.scopes = ['root'];
    await get('?who=all');
    expect(calls.list[0].viewer.isRoot).toBe(true);
    expect(calls.list[0].query.who).toBe('all');
  });

  test('filters outside the grammar are refused by name, never widened', async () => {
    expect((await get('?type=bogus')).body.code).toBe('INVALID_NOTIFICATION_FILTER');
    expect((await get('?who=everyone')).body.code).toBe('INVALID_NOTIFICATION_FILTER');
    expect((await get('?before=1.nope')).body.code).toBe('INVALID_NOTIFICATION_CURSOR');
    expect((await get('?limit=0')).body.code).toBe('INVALID_NOTIFICATION_LIMIT');
    expect(calls.list).toHaveLength(0);
    await get('?type=status,stuck');
    expect(calls.list[0].query.types).toEqual(['status', 'stuck']);
  });

  test('an identity with no principal is refused, not shown an empty list', async () => {
    identity.principal = null;
    const { status, body } = await get();
    expect([status, body.code]).toEqual([403, 'PRINCIPAL_REQUIRED']);
    expect(calls.list).toHaveLength(0);
  });
});

describe('POST /tasks/notifications/:id/read and /read-all — the caller\'s own state', () => {
  test('mark read passes the caller and the key; an unseen key answers 404', async () => {
    const ok = await fetch(`${base}/tasks/notifications/feed:42/read`, { method: 'POST' });
    expect(ok.status).toBe(200);
    expect(calls.read[0]).toMatchObject({ key: 'feed:42', viewer: { principalId: ALICE } });
    const missing = await fetch(`${base}/tasks/notifications/feed:43/read`, { method: 'POST' });
    expect([missing.status, ((await missing.json()) as any).code]).toEqual([404, 'NOTIFICATION_NOT_FOUND']);
    const malformed = await fetch(`${base}/tasks/notifications/not-a-key/read`, { method: 'POST' });
    expect(malformed.status).toBe(404);
    // A malformed key never reaches the read model.
    expect(calls.read.map((call) => call.key)).toEqual(['feed:42', 'feed:43']);
  });

  test('read-all carries the filters (default My work) and the caller', async () => {
    const answer = await fetch(`${base}/tasks/notifications/read-all?type=stuck`, { method: 'POST' });
    expect(answer.status).toBe(200);
    expect(((await answer.json()) as any).markedCount).toBe(3);
    expect(calls.readAll[0]).toMatchObject({ viewer: { principalId: ALICE }, query: { who: 'mine', types: ['stuck'] } });
  });
});
