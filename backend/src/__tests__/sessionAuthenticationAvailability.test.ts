/** A failed lookup is unknown validity, never an invalid credential. These
 * requests use real services, middleware, routes, and WebSocket upgrade logic;
 * only the database pool boundary is scripted. */
import http from 'http';
import express from 'express';
import jwt from 'jsonwebtoken';
import { WebSocket } from 'ws';

const queryMock = jest.fn();
jest.mock('../db/connection', () => ({ pool: { query: (...args: unknown[]) => queryMock(...args) } }));

const principalId = '99999999-9999-4999-8999-999999999999';
const cookie = 'relayhall_session=opaque-session-sentinel';
const sensitive = 'driver-secret-SQL-cookie-sentinel';
const principal = {
  id: principalId, kind: 'human', handle: 'ada', display_name: 'Ada',
  status: 'active', role: 'operator', legacy_identity: false, metadata: {},
};
const session = { session_id: 'session-id', principal_id: principalId, role_snapshot: null };
type FailureAt = 'session' | 'principal' | null;
let failOnce: FailureAt = null;
let sessionPresent = true;
let principalPresent = true;
let principalStatus = 'active';
let sessionReads = 0;
let admitted = 0;
let admission: Record<string, unknown> | undefined;
let observedRequest: Record<string, unknown> | undefined;
let server: http.Server;
let origin: string;
let wsService: any;
let principalService: any;

interface Reply { status: number; body: any; headers: http.IncomingHttpHeaders }
function call(path: string, method = 'GET', headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = http.request(`${origin}${path}`, { method, headers }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: body ? JSON.parse(body) : undefined,
        headers: response.headers,
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

function upgrade(headers: Record<string, string>): Promise<{ result: string; headers?: http.IncomingHttpHeaders }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${new URL(origin).port}/ws`, { headers });
    socket.on('open', () => { socket.once('close', () => resolve({ result: 'open' })); socket.close(); });
    socket.on('unexpected-response', (_req, response) => {
      response.resume();
      resolve({ result: String(response.statusCode), headers: response.headers });
    });
    socket.on('error', () => resolve({ result: 'error' }));
  });
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'availability-suite-jwt-secret-0123456789abcdef';
  process.env.RELAYHALL_SESSIONS = 'on';
  queryMock.mockImplementation((sql: string) => {
    const text = String(sql);
    if (text.includes('FROM auth_sessions s')) {
      sessionReads += 1;
      if (failOnce === 'session') {
        failOnce = null;
        return Promise.reject(new Error(sensitive));
      }
      return Promise.resolve({ rows: sessionPresent ? [session] : [] });
    }
    if (text.includes('FROM principals WHERE id')) {
      if (failOnce === 'principal') {
        failOnce = null;
        return Promise.reject(new Error(sensitive));
      }
      return Promise.resolve({ rows: principalPresent ? [{ ...principal, status: principalStatus }] : [] });
    }
    if (text.includes('FROM principals WHERE handle')) {
      return Promise.resolve({ rows: [{ ...principal, status: principalStatus }] });
    }
    if (text.startsWith('UPDATE auth_sessions')) return Promise.resolve({ rows: [], rowCount: 1 });
    if (text.includes('FROM auth_sessions')) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: [] });
  });
  // Import after test-only environment and pool script are in place.
  const { authMiddleware } = require('../middleware/auth');
  const authRouter = require('../routes/auth').default;
  principalService = require('../services/PrincipalService').principalService;
  const { WebSocketService } = require('../services/websocket');
  const app = express();
  app.use('/protected', (req, _res, next) => { observedRequest = req as unknown as Record<string, unknown>; next(); });
  app.use('/protected', authMiddleware, (req: any, res: any) => {
    admitted += 1;
    admission = { userId: req.userId, scopes: req.scopes, authMethod: req.authMethod };
    res.json({ success: true });
  });
  app.use('/auth', authRouter);
  server = http.createServer(app);
  wsService = new WebSocketService(server, '/ws');
  await new Promise<void>((resolve) => { server.listen(0, resolve); });
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  wsService.shutdown();
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  delete process.env.RELAYHALL_SESSIONS;
});

beforeEach(() => {
  failOnce = null;
  sessionPresent = true;
  principalPresent = true;
  principalStatus = 'active';
  sessionReads = 0;
  admitted = 0;
  admission = undefined;
  observedRequest = undefined;
  principalService.clearCacheForTests();
});

function expectUnavailable(reply: Reply, logs: jest.SpyInstance): void {
  expect(reply.status).toBe(503);
  expect(reply.body).toEqual({
    error: 'Service Unavailable',
    code: 'SESSION_AUTH_UNAVAILABLE',
    message: 'Session authentication is temporarily unavailable',
    errorId: expect.stringMatching(/^[0-9a-f-]{36}$/),
  });
  expect(reply.headers['set-cookie']).toBeUndefined();
  expect(JSON.stringify(reply)).not.toContain(sensitive);
  expect(JSON.stringify(reply)).not.toContain('opaque-session-sentinel');
  const lines = logs.mock.calls.map((args) => args.join(' ')).join('\n');
  expect(lines).toContain(reply.body.errorId);
  expect(lines).not.toContain(sensitive);
  expect(lines).not.toContain('opaque-session-sentinel');
}

it.each(['session', 'principal'] as const)('REST returns correlated 503 for %s SELECT failure, then admits the same cookie', async (stage) => {
  const logs = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    failOnce = stage;
    const first = await call('/protected', 'GET', { Cookie: cookie });
    expectUnavailable(first, logs);
    expect(admitted).toBe(0);
    expect(observedRequest?.userId).toBeUndefined();
    expect(observedRequest?.principal).toBeUndefined();
    expect(observedRequest?.scopes).toBeUndefined();
    expect(observedRequest?.authMethod).toBeUndefined();
    const second = await call('/protected', 'GET', { Cookie: cookie });
    expect(second.status).toBe(200);
    expect(admitted).toBe(1);
    expect(admission).toMatchObject({ userId: 'ada', authMethod: 'session' });
  } finally {
    logs.mockRestore();
  }
});

it('keeps confirmed missing, expired/revoked/idle (filtered rows), missing Account, and disabled Account at 401', async () => {
  sessionPresent = false;
  expect((await call('/protected', 'GET', { Cookie: cookie })).status).toBe(401);
  sessionPresent = true;
  principalPresent = false;
  expect((await call('/protected', 'GET', { Cookie: cookie })).status).toBe(401);
  principalService.clearCacheForTests();
  principalPresent = true;
  principalStatus = 'disabled';
  expect((await call('/protected', 'GET', { Cookie: cookie })).status).toBe(401);
  expect(admitted).toBe(0);
});

it('keeps a valid bearer ahead of the cookie', async () => {
  const bearer = jwt.sign({ userId: 'ada' }, process.env.JWT_SECRET!);
  failOnce = 'session';
  const reply = await call('/protected', 'GET', { Cookie: cookie, Authorization: `Bearer ${bearer}` });
  expect(reply.status).toBe(200);
  expect(sessionReads).toBe(0);
  expect(admission?.authMethod).toBe('dashboard_jwt');
});

it.each(['session', 'principal'] as const)(
  'does not fall through a failed %s cookie lookup to an otherwise valid dashboard JWT on an auth route',
  async (stage) => {
    const logs = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const bearer = jwt.sign({ userId: 'ada' }, process.env.JWT_SECRET!);
      // Show that this JWT really works on the same route without the cookie.
      expect((await call('/auth/sessions', 'GET', { Authorization: `Bearer ${bearer}` })).status).toBe(200);
      principalService.clearCacheForTests();
      failOnce = stage;
      const reply = await call('/auth/sessions', 'GET', { Cookie: cookie, Authorization: `Bearer ${bearer}` });
      expectUnavailable(reply, logs);
      expect((await call('/auth/sessions', 'GET', { Cookie: cookie, Authorization: `Bearer ${bearer}` })).status).toBe(200);
    } finally {
      logs.mockRestore();
    }
  },
);

it('returns 503 for SSO logout lookup failure without clearing the cookie', async () => {
  const logs = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    failOnce = 'session';
    expectUnavailable(await call('/auth/sso/logout', 'POST', { Cookie: cookie }), logs);
    sessionPresent = false;
    expect((await call('/auth/sso/logout', 'POST', { Cookie: cookie })).status).toBe(401);
  } finally {
    logs.mockRestore();
  }
});

it.each(['session', 'principal'] as const)('WebSocket refuses %s SELECT fault with 503, then accepts the same cookie', async (stage) => {
  const logs = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    failOnce = stage;
    const first = await upgrade({ Cookie: cookie });
    expect(first.result).toBe('503');
    expect(first.headers?.['set-cookie']).toBeUndefined();
    expect(first.headers?.['x-error-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect((await upgrade({ Cookie: cookie })).result).toBe('open');
    const lines = logs.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(lines).toContain(first.headers?.['x-error-id']);
    expect(lines).not.toContain(sensitive);
    expect(lines).not.toContain('opaque-session-sentinel');
  } finally {
    logs.mockRestore();
  }
});

it('keeps the auth-route 503 envelope fixed for hostile typed error properties', async () => {
  const auth = require('../services/sessionAuthentication');
  const fault = new auth.SessionAuthenticationUnavailableError('session', new Error(sensitive));
  Object.assign(fault, { message: sensitive, status: 401, code: sensitive });
  const injected = jest.spyOn(auth, 'resolveActiveLoginSession').mockRejectedValueOnce(fault);
  const logs = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    expectUnavailable(await call('/auth/sessions', 'GET', { Cookie: cookie }), logs);
  } finally {
    injected.mockRestore();
    logs.mockRestore();
  }
});

it('keeps the 503 envelope fixed even if a typed error carries hostile message, status, and code properties', async () => {
  const auth = require('../services/sessionAuthentication');
  const fault = new auth.SessionAuthenticationUnavailableError('session', new Error(sensitive));
  Object.assign(fault, { message: sensitive, status: 401, code: sensitive });
  const injected = jest.spyOn(auth, 'resolveActiveLoginSession').mockRejectedValueOnce(fault);
  const logs = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const reply = await call('/protected', 'GET', { Cookie: cookie });
    expectUnavailable(reply, logs);
    expect(admitted).toBe(0);
  } finally {
    injected.mockRestore();
    logs.mockRestore();
  }
});
