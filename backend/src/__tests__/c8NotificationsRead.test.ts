/**
 * c8NotificationsRead.test.ts — RH-P3.C8 round 2 (review 4243b06e B1): the
 * notification READ MODEL, driven over the production route with TWO
 * differently-granted principals through the REAL shared-authorization
 * middleware:
 *  - the entitled human sees a useful task.stuck notification;
 *  - an under-granted principal gets neither the title nor any other
 *    private content of a Task their grants do not cover (the never-waived
 *    concealment class);
 *  - addressing: a notification addressed to principal B never reaches
 *    principal A; broadcasts reach whoever passes the grant filter; root
 *    sees the addressed set it is entitled to (everything, by blanket).
 */
import express from 'express';
import type { AddressInfo } from 'net';

const TASK_VISIBLE = '11111111-1111-4111-8111-111111111111';
const TASK_PRIVATE = '22222222-2222-4222-8222-222222222222';
const ALICE = '99999999-9999-4999-8999-999999999999';
const BOB = '88888888-8888-4888-8888-888888888888';

const grants = new Map<string, Set<string>>();

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(async () => ({ rows: [] })), connect: jest.fn() },
}));
jest.mock('../services/AuthorizationRepository', () => ({
  authorizationRepository: {
    authorizedIds: jest.fn(async (actor: any, _type: string, ids: string[]) => {
      const allowed = grants.get(String(actor?.principalId)) ?? new Set<string>();
      return new Set(ids.filter((id) => allowed.has(id)));
    }),
  },
}));
jest.mock('../services/NotificationManager', () => ({
  notificationManager: {
    getUnreadNotifications: jest.fn(async () => [
      {
        id: 'n-broadcast', taskId: TASK_VISIBLE, taskTitle: 'Shared fixture task',
        event: 'status_changed', from: 'todo', to: 'in-progress',
        changedBy: 'system', timestamp: '2026-08-22T04:00:00.000Z', read: false,
        recipientPrincipalId: null,
      },
      {
        id: 'n-alice', taskId: TASK_VISIBLE, taskTitle: 'Shared fixture task',
        event: 'exception', from: 'in-progress', to: 'in-progress',
        changedBy: 'system', timestamp: '2026-08-22T04:01:00.000Z', read: false,
        exception: { name: 'task.stuck', reason: 'status_stale' },
        recipientPrincipalId: ALICE,
      },
      {
        id: 'n-private', taskId: TASK_PRIVATE, taskTitle: 'SECRET private task title',
        event: 'exception', from: 'in-progress', to: 'in-progress',
        changedBy: 'system', timestamp: '2026-08-22T04:02:00.000Z', read: false,
        exception: { name: 'task.stuck', reason: 'lease_expired' },
        recipientPrincipalId: null,
      },
    ]),
    getNotifications: jest.fn(async () => []),
    markAsRead: jest.fn(async () => true),
    markAllAsRead: jest.fn(async () => 0),
  },
}));
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
  scopes: ['tasks:read'] as string[],
};

let server: ReturnType<typeof express.application.listen>;
let base = '';

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).principal = identity.principal;
    (req as any).scopes = identity.scopes;
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
  grants.clear();
  identity.principal = { id: ALICE, handle: 'alice' };
  identity.scopes = ['tasks:read'];
});

const read = async () => {
  const response = await fetch(`${base}/tasks/notifications?unread=true`);
  return { status: response.status, body: (await response.json()) as any };
};

describe('GET /tasks/notifications — recipient-addressed, grant-filtered (4243b06e B1)', () => {
  test('the entitled human sees the broadcast AND the notice addressed to them', async () => {
    grants.set(ALICE, new Set([TASK_VISIBLE]));
    const { status, body } = await read();
    expect(status).toBe(200);
    const ids = body.notifications.map((n: any) => n.id).sort();
    expect(ids).toEqual(['n-alice', 'n-broadcast']);
    const stuck = body.notifications.find((n: any) => n.id === 'n-alice');
    expect(stuck.exception).toEqual({ name: 'task.stuck', reason: 'status_stale' });
    expect(stuck.taskTitle).toBe('Shared fixture task');
    expect(body.unreadCount).toBe(2);
  });

  test('an under-granted principal is concealed from the private Task — no title, no row', async () => {
    grants.set(BOB, new Set([TASK_VISIBLE]));
    identity.principal = { id: BOB, handle: 'bob' };
    const { body } = await read();
    const ids = body.notifications.map((n: any) => n.id);
    // The broadcast about the readable Task arrives; the notice ADDRESSED to
    // alice does not; the private-Task broadcast is concealed entirely.
    expect(ids).toEqual(['n-broadcast']);
    expect(JSON.stringify(body)).not.toContain('SECRET private task title');
  });

  test('a caller with NO grants sees nothing — and no private content leaks through the envelope', async () => {
    identity.principal = { id: BOB, handle: 'bob' };
    const { body } = await read();
    expect(body.notifications).toEqual([]);
    expect(body.count).toBe(0);
    expect(JSON.stringify(body)).not.toContain('SECRET');
  });

  test('root sees the full addressed set (blanket entitlement)', async () => {
    grants.set(ALICE, new Set([TASK_VISIBLE, TASK_PRIVATE]));
    identity.scopes = ['root'];
    const { body } = await read();
    expect(body.notifications.map((n: any) => n.id).sort()).toEqual(['n-alice', 'n-broadcast', 'n-private']);
  });
});
