/**
 * SS-W1 · the live-update stream accepts a login session.
 *
 * Found by the live drill, not by any suite: the stream URL carries
 * `?token=` read from localStorage, and a login session deliberately has no
 * token there. Every Account that signed in the new way therefore got an
 * unauthenticated upgrade and no live updates at all — a whole surface
 * unreachable for the exact users this wave exists to create.
 *
 * The upgrade is same-origin and carries cookies, so it authenticates on the
 * same predicate the REST ingress uses. This suite drives the REAL
 * `WebSocketService` against a real HTTP server with a real `ws` client;
 * only the session store and the principal lookup are doubled.
 */
import http from 'http';
import { WebSocket } from 'ws';

const sessionResolve = jest.fn();
const getPrincipalById = jest.fn();
const verifyActiveDashboardToken = jest.fn();

jest.mock('../services/LoginSessionService', () => ({
  SESSION_COOKIE_NAME: 'relayhall_session',
  loginSessionService: { resolve: (...args: unknown[]) => sessionResolve(...args) },
}));
jest.mock('../services/PrincipalService', () => ({
  principalService: { getPrincipalById: (...args: unknown[]) => getPrincipalById(...args) },
}));
jest.mock('../utils/dashboardToken', () => ({
  verifyActiveDashboardToken: (...args: unknown[]) => verifyActiveDashboardToken(...args),
}));

import { WebSocketService } from '../services/websocket';

let server: http.Server;
let port = 0;
let service: WebSocketService;
/** Every socket this suite opened, so teardown can drain them deterministically. */
const opened: WebSocket[] = [];

beforeAll(async () => {
  server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  service = new WebSocketService(server, '/ws');
  await new Promise<void>((resolve) => { server.listen(0, resolve); });
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
});

afterAll(async () => {
  // The service logs on disconnect. If the suite ends while a server-side
  // close handler is still pending, Jest fails the RUN with "Cannot log after
  // tests are done" while every test passes — an exit-1 gate with a green
  // report, which is exactly the shape a reviewer must reject. So drain on the
  // real condition (the service's own client set emptying) rather than on a
  // timer, then shut down.
  for (const socket of opened) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clients = () => ((service as any).clients as Set<unknown>).size;
  const deadline = Date.now() + 5000;
  while (clients() > 0 && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(clients()).toBe(0);
  service.shutdown();
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.RELAYHALL_SESSIONS = 'on';
  verifyActiveDashboardToken.mockRejectedValue(new Error('not a token'));
  sessionResolve.mockResolvedValue(undefined);
  getPrincipalById.mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.RELAYHALL_SESSIONS;
});

/** Resolve to 'open' or the HTTP status the upgrade was refused with. */
function connect(headers: Record<string, string> = {}, query = ''): Promise<string> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, { headers });
    opened.push(socket);
    // An accepted upgrade is closed HERE and awaited, so the server's close
    // handler runs inside the test that opened it rather than after teardown.
    socket.on('open', () => {
      socket.once('close', () => resolve('open'));
      socket.close();
    });
    socket.on('unexpected-response', (_req, res) => resolve(String(res.statusCode)));
    socket.on('error', () => resolve('error'));
  });
}

const liveSession = () => {
  sessionResolve.mockResolvedValue({ sessionId: 'sess-1', principalId: 'p-1', roleSnapshot: null });
  getPrincipalById.mockResolvedValue({ id: 'p-1', handle: 'ada', status: 'active', kind: 'human', role: 'operator' });
};

describe('the stream upgrade', () => {
  it('accepts a live login session cookie, with no token in the URL at all', async () => {
    liveSession();
    expect(await connect({ Cookie: 'relayhall_session=opaque' })).toBe('open');
    expect(sessionResolve).toHaveBeenCalledWith('opaque');
  });

  it('still accepts a valid dashboard token', async () => {
    verifyActiveDashboardToken.mockResolvedValue({ userId: 'dashboard_user' });
    expect(await connect({}, '?token=good')).toBe('open');
    // The session store is never consulted when the token authenticates.
    expect(sessionResolve).not.toHaveBeenCalled();
  });

  it('refuses an upgrade carrying neither', async () => {
    expect(await connect()).toBe('401');
  });

  it('refuses a session cookie that resolves to nothing', async () => {
    sessionResolve.mockResolvedValue(undefined);
    expect(await connect({ Cookie: 'relayhall_session=stale' })).toBe('401');
  });

  it('refuses a session whose Account is disabled', async () => {
    sessionResolve.mockResolvedValue({ sessionId: 'sess-1', principalId: 'p-1', roleSnapshot: null });
    getPrincipalById.mockResolvedValue({ id: 'p-1', handle: 'ada', status: 'disabled', kind: 'human', role: 'operator' });
    expect(await connect({ Cookie: 'relayhall_session=opaque' })).toBe('401');
  });

  it('ignores the cookie entirely while the flag is off', async () => {
    delete process.env.RELAYHALL_SESSIONS;
    liveSession();
    expect(await connect({ Cookie: 'relayhall_session=opaque' })).toBe('401');
    expect(sessionResolve).not.toHaveBeenCalled();
  });

  it('falls through to the cookie when the token is present but bad', async () => {
    // A stale localStorage token must not shadow a live session.
    liveSession();
    expect(await connect({ Cookie: 'relayhall_session=opaque' }, '?token=expired')).toBe('open');
  });
});
