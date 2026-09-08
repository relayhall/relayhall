/**
 * notesFeedEmission.test.ts — RH-P3.C1 (round 3 review f7d9613e): the direct
 * note-append route is a Task mutation every feed consumer can observe. The
 * production Express handler is driven over HTTP and must (1) emit
 * task.updated on the SAME transaction client, after the write and before
 * COMMIT, and (2) roll the note append back if the emission fails — the
 * write and its event commit or vanish together.
 */
import express from 'express';
import type { AddressInfo } from 'net';

const statements: string[] = [];
const feedBehavior = { failFeedInsert: false, taskFound: true };

jest.mock('../db/connection', () => {
  const client = {
    query: jest.fn(async (text: string) => {
      statements.push(text);
      if (/INSERT INTO feed_events/.test(text)) {
        if (feedBehavior.failFeedInsert) throw new Error('feed insert refused');
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE tasks SET notes/.test(text)) {
        return feedBehavior.taskFound
          ? { rows: [{ id: '11111111-1111-4111-8111-111111111111', title: 'Fixture', notes: 'n', project_id: null, owner_principal_id: null }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
  };
  return { pool: { query: jest.fn(async () => ({ rows: [] })), connect: jest.fn(async () => client) } };
});
jest.mock('../services/AuthorizationService', () => ({
  authorizationService: { authorizeResource: jest.fn(() => ({ allowed: false })) },
}));
jest.mock('../services/AuthorizationRepository', () => ({
  authorizationRepository: { authorizedIds: jest.fn(async () => new Set()) },
}));
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
  filterAuthorizedResources: jest.fn(async (_req: unknown, _verb: unknown, rows: unknown[]) => rows),
  // AZ-S7: requestActor now carries the ASSIGNER's authorization identity
  // so the assignment-access coupling can apply its R3 non-escalation cap.
  // The fixture returns the LIVE shape, not a stub — a bare {} here would
  // pass this file and hide a real integration break.
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

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const PRINCIPAL = { id: '99999999-9999-4999-8999-999999999999', handle: 'qa-principal' };

let server: ReturnType<typeof express.application.listen>;
let base: string;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).principal = PRINCIPAL;
    (req as any).scopes = ['root'];
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
beforeEach(() => { statements.length = 0; feedBehavior.failFeedInsert = false; feedBehavior.taskFound = true; });

const post = async (path: string, body: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
};

describe('POST /tasks/:id/notes — the append rides the feed transaction', () => {
  test('write → task.updated emission → COMMIT, in order, on one client', async () => {
    const { status, body } = await post(`/tasks/${TASK_ID}/notes`, { text: 'progress note' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const begin = statements.indexOf('BEGIN');
    const write = statements.findIndex(s => s.includes('UPDATE tasks SET notes'));
    const feed = statements.findIndex(s => s.includes('INSERT INTO feed_events'));
    const commit = statements.indexOf('COMMIT');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(begin);
    expect(feed).toBeGreaterThan(write);
    expect(commit).toBeGreaterThan(feed);
    expect(statements).not.toContain('ROLLBACK');
  });

  test('a refused emission rolls the note append back — the write cannot land without its event', async () => {
    feedBehavior.failFeedInsert = true;
    const { status } = await post(`/tasks/${TASK_ID}/notes`, { text: 'progress note' });
    expect(status).toBe(500);
    const write = statements.findIndex(s => s.includes('UPDATE tasks SET notes'));
    const rollback = statements.indexOf('ROLLBACK');
    expect(write).toBeGreaterThanOrEqual(0);
    expect(rollback).toBeGreaterThan(write);
    expect(statements).not.toContain('COMMIT');
  });

  test('a missing Task rolls back with no emission', async () => {
    feedBehavior.taskFound = false;
    const { status } = await post(`/tasks/${TASK_ID}/notes`, { text: 'progress note' });
    expect(status).toBe(404);
    expect(statements.some(s => s.includes('INSERT INTO feed_events'))).toBe(false);
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
  });
});
