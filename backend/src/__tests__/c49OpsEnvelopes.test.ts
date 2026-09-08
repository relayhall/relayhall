/**
 * c49OpsEnvelopes.test.ts — review 3db17273 r2 B2: representative
 * route-level proofs that the whole-inventory sweep holds live — one DIRECT
 * handler (notification endpoints) and one PARAMETERIZED response helper
 * chain (grants: sendGrantError + logGrantRouteFailure + sendApiError).
 */
import express from 'express';
import type { AddressInfo } from 'net';

const endpointBehavior: { list: () => Promise<unknown> } = {
  list: async () => { throw new Error('SECRET driver text: relation endpoints not found'); },
};
jest.mock('../services/NotificationEndpointService', () => ({
  notificationEndpointService: { list: jest.fn(async () => endpointBehavior.list()) },
  NotificationEndpointValidationError: class extends Error { },
  NOTIFICATION_ENDPOINT_KINDS: ['ui', 'webhook', 'email'],
}));

const grantBehavior: { list: () => Promise<unknown> } = {
  list: async () => { throw new Error('SECRET grants driver text cannot connect'); },
};
jest.mock('../services/GrantService', () => ({
  grantService: { list: jest.fn(async () => grantBehavior.list()) },
  GrantError: class GrantError extends Error {
    constructor(public status: number, public code: string, message: string, public field?: string) { super(message); }
  },
}));

import notificationEndpointsRouter from '../routes/notificationEndpoints';
import grantsRouter from '../routes/grants';

let server: ReturnType<typeof express.application.listen>;
let base = '';

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).principal = { id: '99999999-9999-4999-8999-999999999999', handle: 'qa' };
    (req as any).scopes = ['root'];
    (req as any).userId = 'qa';
    next();
  });
  app.use('/notification-endpoints', notificationEndpointsRouter);
  app.use('/grants', grantsRouter);
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});
afterAll((done) => { server.close(() => done()); });

test('direct handler: notification-endpoint list failure sends the typed fixed 500 with errorId, no caught text', async () => {
  const response = await fetch(`${base}/notification-endpoints`);
  const body = (await response.json()) as any;
  expect(response.status).toBe(500);
  expect(body).toMatchObject({
    success: false,
    code: 'NOTIFICATION_ENDPOINTS_READ_FAILED',
    error: 'Failed to list notification endpoints',
  });
  expect(typeof body.errorId).toBe('string');
  expect(body.errorId.length).toBeGreaterThan(8);
  expect(JSON.stringify(body)).not.toContain('SECRET');
});

test('parameterized helper chain: grants list failure sends INTERNAL_ERROR with details.errorId, no caught text', async () => {
  const response = await fetch(`${base}/grants`);
  const body = (await response.json()) as any;
  expect(response.status).toBe(500);
  expect(body).toMatchObject({
    success: false,
    code: 'INTERNAL_ERROR',
    error: 'Failed to list grants',
  });
  expect(typeof body.details?.errorId).toBe('string');
  expect(body.details.errorId.length).toBeGreaterThan(8);
  expect(JSON.stringify(body)).not.toContain('SECRET');
});

test('the typed GrantError arm still answers with its own status, code, and developer-authored message', async () => {
  const { GrantError } = jest.requireMock('../services/GrantService') as any;
  grantBehavior.list = async () => { throw new GrantError(400, 'INVALID_GRANTEE', 'granteeId names no principal'); };
  try {
    const response = await fetch(`${base}/grants`);
    const body = (await response.json()) as any;
    expect(response.status).toBe(400);
    expect(body).toMatchObject({ success: false, code: 'INVALID_GRANTEE', error: 'granteeId names no principal' });
  } finally {
    grantBehavior.list = async () => { throw new Error('SECRET grants driver text cannot connect'); };
  }
});
