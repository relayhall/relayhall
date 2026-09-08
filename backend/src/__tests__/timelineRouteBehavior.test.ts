/**
 * timelineRouteBehavior.test.ts — C1 route-HANDLER behavior (review ac5d1cf6
 * F4.1): the production Express handler is invoked over HTTP. Typed 400s for
 * invalid filter and malformed/semantically-invalid cursors (including
 * parseable non-ISO forms), per-source degradation surfaced in the envelope,
 * and stream-visibility parity — /timeline hands taskElementService.listStream
 * the same server-derived actor as /stream, byte for byte.
 */
import express from 'express';
import type { AddressInfo } from 'net';

jest.mock('../db/connection', () => ({ pool: { query: jest.fn(async () => ({ rows: [] })) } }));
jest.mock('../services/TaskManagerDB', () => {
  const actual = jest.requireActual('../services/TaskManagerDB');
  return {
    ...actual,
    taskManagerDB: {
      getTask: jest.fn(async (id: string) => ({
        id,
        title: 'Fixture task',
        created: '2026-08-01T00:00:00.000Z',
        updated: '2026-08-14T12:00:00.000Z',
        startedAt: '2026-08-02T00:00:00.000Z',
        sessionRefs: ['sess-1'],
        reviewHistory: [],
      })),
    },
  };
});
jest.mock('../services/TaskElementService', () => {
  const actual = jest.requireActual('../services/TaskElementService');
  return {
    ...actual,
    taskElementService: {
      listStream: jest.fn(async () => []),
      listReferences: jest.fn(async () => []),
    },
  };
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
jest.mock('../middleware/sharedAuthorization', () => ({
  filterAuthorizedResources: jest.fn(async (_req: any, _verb: any, rows: any[]) => rows),
  // AZ-S7 (review bedc25f3 B2): taskElementActor now carries the LINKER's
  // authorization identity, so a link edit on an assigned Task cannot
  // confer access the linker does not hold. The fixture returns the LIVE
  // shape — a bare {} would pass here and hide a real integration break.
  actorFromRequest: jest.fn((req: any) => ({
    principalId: req?.principal?.id ?? null,
    handle: req?.userId ?? '',
    role: req?.principal?.role ?? null,
    scopes: req?.scopes ?? null,
    authenticated: Boolean(req?.userId),
    delegation: null,
  })),
}));

import tasksRouter from '../routes/tasks';
import { taskElementService } from '../services/TaskElementService';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const PRINCIPAL = { id: '99999999-9999-4999-8999-999999999999', handle: 'qa-principal' };

let server: ReturnType<typeof express.application.listen>;
let base: string;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).principal = PRINCIPAL;
    (req as any).scopes = ['tasks:read'];
    (req as any).userId = PRINCIPAL.handle;
    next();
  });
  app.use('/tasks', tasksRouter);
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});
afterAll((done) => { server.close(() => done()); });
afterEach(() => jest.clearAllMocks());

const get = async (path: string) => {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: (await response.json()) as any };
};

describe('GET /tasks/:id/timeline handler behavior', () => {
  test('invalid filter → typed 400 before any source read', async () => {
    const { status, body } = await get(`/tasks/${TASK_ID}/timeline?filter=bogus`);
    expect(status).toBe(400);
    expect(body.code).toBe('INVALID_FILTER');
    expect(taskElementService.listStream).not.toHaveBeenCalled();
  });

  test.each([
    ['garbage', 'not-a-cursor'],
    ['wrong shape', Buffer.from('{"nope":1}').toString('base64url')],
    ['non-ISO human date', Buffer.from(JSON.stringify({ at: 'August 14, 2026 12:00:00 UTC', source: 'stream', id: 'x' })).toString('base64url')],
    ['date-only', Buffer.from(JSON.stringify({ at: '2026-08-14', source: 'stream', id: 'x' })).toString('base64url')],
    ['bad source', Buffer.from(JSON.stringify({ at: '2026-08-14T00:00:00.000Z', source: 'bogus', id: 'x' })).toString('base64url')],
    ['no milliseconds', Buffer.from(JSON.stringify({ at: '2026-08-14T00:00:00Z', source: 'stream', id: 'x' })).toString('base64url')],
    ['short milliseconds', Buffer.from(JSON.stringify({ at: '2026-08-14T00:00:00.1Z', source: 'stream', id: 'x' })).toString('base64url')],
  ])('malformed cursor (%s) → typed 400 before any source read', async (_label, cursor) => {
    const { status, body } = await get(`/tasks/${TASK_ID}/timeline?before=${encodeURIComponent(cursor)}`);
    expect(status).toBe(400);
    expect(body.code).toBe('INVALID_CURSOR');
    expect(taskElementService.listStream).not.toHaveBeenCalled();
  });

  test('a valid previously-returned cursor is accepted', async () => {
    const first = await get(`/tasks/${TASK_ID}/timeline?limit=1`);
    expect(first.status).toBe(200);
    // sessionRefs fixture guarantees at least one event
    expect(first.body.events.length).toBeGreaterThan(0);
    const cursor = Buffer.from(JSON.stringify({
      at: first.body.events[0].at, source: first.body.events[0].source, id: first.body.events[0].id,
    })).toString('base64url');
    const second = await get(`/tasks/${TASK_ID}/timeline?before=${encodeURIComponent(cursor)}`);
    expect(second.status).toBe(200);
  });

  test('stream failure degrades: 200 with sourcesUnavailable naming the source, remainder returned', async () => {
    (taskElementService.listStream as jest.Mock).mockRejectedValueOnce(new Error('db down'));
    const { status, body } = await get(`/tasks/${TASK_ID}/timeline`);
    expect(status).toBe(200);
    expect(body.sourcesUnavailable).toEqual(['stream']);
    // session synthesis still produced the legacy ref event
    expect(body.events.map((e: any) => e.source)).toContain('session');
  });

  test('healthy sources report an EMPTY sourcesUnavailable — failed is distinguishable from empty', async () => {
    const { body } = await get(`/tasks/${TASK_ID}/timeline`);
    expect(body.sourcesUnavailable).toEqual([]);
  });

  test('visibility parity: /timeline and /stream pass the identical server-derived actor to the same governed read', async () => {
    await get(`/tasks/${TASK_ID}/timeline`);
    const timelineArgs = (taskElementService.listStream as jest.Mock).mock.calls[0];
    jest.clearAllMocks();
    await get(`/tasks/${TASK_ID}/stream`);
    const streamArgs = (taskElementService.listStream as jest.Mock).mock.calls[0];
    expect(timelineArgs[0]).toBe(TASK_ID);
    expect(streamArgs[0]).toBe(TASK_ID);
    expect(timelineArgs[1]).toEqual(streamArgs[1]);
    expect(timelineArgs[1].principalId).toBe(PRINCIPAL.id);
  });

  test('every returned event keeps the legacy modal fields with modal-safe types', async () => {
    (taskElementService.listStream as jest.Mock).mockResolvedValueOnce([{
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      provenance: 'authored', event_type: 'note', content: 'hello',
      author_principal_id: null, author_handle: 'agent-1', author_role: null,
      metadata: {}, redacted_at: null, redaction_mode: null,
      created_at: '2026-08-10T10:00:00.000Z',
    }]);
    const { body } = await get(`/tasks/${TASK_ID}/timeline`);
    for (const event of body.events) {
      expect(typeof event.id).toBe('string');
      expect(typeof event.title).toBe('string');
      expect(typeof event.createdAt).toBe('string');
      expect(event.actor === null || typeof event.actor === 'string').toBe(true);
    }
  });
});
