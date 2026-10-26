/**
 * The Timeline's statement ceiling, at the route (card 5854f0d6, the fix-forward
 * after the full tier). A Timeline statement that reaches the ceiling its own
 * transaction sets (`SET LOCAL statement_timeout`, SQLSTATE 57014) fails that
 * one request with a 503 `TIMELINE_READ_TIMEOUT` and its error id; any other
 * failure keeps the generic 500. The live suite proves the ceiling is set and
 * cancels a runaway statement; this proves what the caller then receives.
 */
import express from 'express';
import type { AddressInfo } from 'net';

jest.mock('../db/connection', () => ({ pool: { query: jest.fn(async () => ({ rows: [] })), connect: jest.fn() } }));
jest.mock('../services/TimelineService', () => {
  const actual = jest.requireActual('../services/TimelineService');
  return {
    ...actual,
    timelineService: { page: jest.fn(), lastSeen: jest.fn(async () => null), markSeen: jest.fn() },
  };
});

import notificationsRouter from '../routes/notifications';
import { timelineService, isTimelineTimeout, TIMELINE_TRANSACTION_SETTINGS } from '../services/TimelineService';

const page = timelineService.page as jest.Mock;
const markSeen = timelineService.markSeen as jest.Mock;
const cancelled = (): Error => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });

let origin = '';
let server: ReturnType<express.Express['listen']>;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.principal = { id: '11111111-1111-4111-8111-111111111111', handle: 'nt-timeout', kind: 'human', role: 'user' };
    req.userId = 'nt-timeout';
    req.authMethod = 'session';
    req.scopes = ['tasks:read'];
    next();
  });
  app.use('/notifications', notificationsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('the Timeline statement ceiling', () => {
  it('the Timeline transaction turns JIT off and sets a statement ceiling', () => {
    expect(TIMELINE_TRANSACTION_SETTINGS).toContain('SET LOCAL jit = off');
    expect(TIMELINE_TRANSACTION_SETTINGS.some((setting) => /^SET LOCAL statement_timeout = '\d+ms'$/.test(setting))).toBe(true);
  });

  it('only SQLSTATE 57014 is a Timeline timeout', () => {
    expect(isTimelineTimeout(cancelled())).toBe(true);
    expect(isTimelineTimeout(Object.assign(new Error('x'), { code: '57P01' }))).toBe(false);
    expect(isTimelineTimeout(new Error('x'))).toBe(false);
    expect(isTimelineTimeout(null)).toBe(false);
  });

  it('a page cancelled at the ceiling answers 503 TIMELINE_READ_TIMEOUT with an error id', async () => {
    page.mockRejectedValueOnce(cancelled());
    const response = await fetch(`${origin}/notifications/timeline`);
    const body: any = await response.json();
    expect(response.status).toBe(503);
    expect(body.code).toBe('TIMELINE_READ_TIMEOUT');
    expect(typeof body.details?.errorId).toBe('string');
    expect(JSON.stringify(body)).not.toContain('canceling statement');
  });

  it('any other failure keeps the generic 500', async () => {
    page.mockRejectedValueOnce(new Error('boom'));
    const response = await fetch(`${origin}/notifications/timeline`);
    expect(response.status).toBe(500);
    expect(((await response.json()) as any).code).toBe('TIMELINE_READ_FAILED');
  });

  it('a last-seen write cancelled at the ceiling answers 503 too', async () => {
    markSeen.mockRejectedValueOnce(cancelled());
    const response = await fetch(`${origin}/notifications/timeline/seen`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cursor: '5' }),
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as any).code).toBe('TIMELINE_READ_TIMEOUT');
  });
});
