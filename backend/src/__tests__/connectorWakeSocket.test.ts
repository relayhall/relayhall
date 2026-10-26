/**
 * Card 6dea3cca — the socket half of the Connector wake on `/events/ws`:
 * the `wake=1` opt-in, the one client frame a wake socket may send, and the
 * receive-only rule every other socket keeps (including a `wake=1` socket the
 * dispatcher refused or has not registered yet), plus the per-socket bound on
 * acknowledgement work. Real sockets and canonical credential acceptance; the
 * dispatcher is a recording stub here (its own behaviour is
 * connectorWake.test.ts).
 */
import http from 'http';
import { WebSocket } from 'ws';

const credentials = new Map<string, any>();
// Counts canonical credential look-ups (one per authorization) and can hold them.
const authProbe = { calls: 0, gate: null as Promise<void> | null };
const query = jest.fn(async (sql: string, _args: any[]) => {
  if (!sql.includes('FROM feed_events')) throw new Error('Unexpected query in isolated fixture');
  return { rows: [] as any[] };
});
jest.mock('../db/connection', () => ({ pool: { query: (...args: any[]) => query(args[0], args[1]) } }));
jest.mock('../services/PrincipalService', () => ({
  parsePrincipalKey: (value: string) => ({ value }),
  principalService: {
    authenticatePrincipalKey: async ({ value }: { value: string }) => {
      authProbe.calls++;
      if (authProbe.gate) await authProbe.gate;
      return credentials.get(value);
    },
    bumpLastSeen: jest.fn(),
  },
}));
jest.mock('../services/AuthorizationRepository', () => ({
  authorizationRepository: { authorizedIds: async () => new Set<string>() },
}));
import { ConnectorNotificationService } from '../services/ConnectorNotificationService';

let server: http.Server;
let service: ConnectorNotificationService;
let port: number;
const sockets: WebSocket[] = [];
const inbox = new Map<WebSocket, any[]>();
const defaultAcknowledge = async (_identity: any, ack: any, _via?: any): Promise<boolean> =>
  ack.wakeId === '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const wake = {
  attach: jest.fn(async (_ws: any, principalId: string): Promise<any> => (principalId === 'hermes'
    ? { enabled: true, serviceId: 'svc' } : { enabled: false, reason: 'NOT_A_PUBLISHED_CONNECTOR' })),
  detach: jest.fn(),
  acknowledge: jest.fn(defaultAcknowledge),
  recordOutcome: jest.fn(async (_identity: any, report: any, _ws: any): Promise<boolean> => report.wakeId === WAKE_ID),
};
const WAKE_ID = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

function issue(name: string): string {
  const key = `rh_live_${name}`;
  credentials.set(key, {
    principal: { id: name, handle: name, role: 'user', kind: 'connector', legacyIdentity: false, parentPrincipalId: null },
    credential: { id: `credential-${name}`, scopes: ['tasks:read'], transport: 'api' },
  });
  return `Bearer ${key}`;
}
async function connect(authorization: string | undefined, suffix: string): Promise<WebSocket | number> {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/events/ws${suffix}`,
      { headers: authorization ? { Authorization: authorization } : {} });
    sockets.push(ws); inbox.set(ws, []);
    ws.on('message', data => inbox.get(ws)!.push(JSON.parse(data.toString())));
    ws.on('error', () => undefined);
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode!); });
  });
}
async function until<T>(fn: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const result = fn(); if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for transport outcome');
}
const closeOf = (ws: WebSocket) => new Promise<{ code: number; reason: string }>(resolve =>
  ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
const statusOf = (ws: WebSocket) => until(() => inbox.get(ws)?.find(frame => frame.type === 'wake.status'));
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function start(withWake: boolean, intervalMs = 20): Promise<void> {
  server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  service = new ConnectorNotificationService(server, intervalMs, withWake ? wake as any : null);
  return new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => {
    port = (server.address() as any).port; resolve();
  }));
}
beforeEach(() => {
  credentials.clear(); query.mockClear(); Object.values(wake).forEach(fn => fn.mockClear());
  wake.acknowledge.mockImplementation(defaultAcknowledge);
  authProbe.calls = 0; authProbe.gate = null;
});
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  service.shutdown();
  await new Promise<void>(resolve => server.close(() => resolve()));
  inbox.clear();
});

describe('with the wake dispatcher wired', () => {
  beforeEach(() => start(true));

  test.each([
    ['?wake=0'], ['?wake=true'], ['?wake=1&wake=1'], ['?cursor=0&wake=1&token=x'],
    // Owner ruling E462: 1 and 2 are the only protocols.
    ['?wake=3'], ['?wake=02'], ['?wake=1&wake=2'],
  ])('refuses a malformed wake opt-in %s before authentication', async (suffix) => {
    expect(await connect(issue('hermes'), suffix)).toBe(400);
    expect(wake.attach).not.toHaveBeenCalled();
  });

  test('a wake=1 socket registers, is told so, and keeps its ordinary event stream', async () => {
    const ws = await connect(issue('hermes'), '?cursor=0&wake=1') as WebSocket;
    expect(await statusOf(ws)).toEqual({ type: 'wake.status', enabled: true });
    await until(() => inbox.get(ws)?.find(frame => frame.type === 'events'));
    expect(wake.attach).toHaveBeenCalledWith(expect.anything(), 'hermes');
  });

  test('a principal that is not a published connector is told why it gets no wakes', async () => {
    const ws = await connect(issue('reader'), '?wake=1') as WebSocket;
    expect(await statusOf(ws)).toEqual({ type: 'wake.status', enabled: false, reason: 'NOT_A_PUBLISHED_CONNECTOR' });
  });

  test('a wake.ack is handed over with the RE-DERIVED identity, and closing detaches', async () => {
    const ws = await connect(issue('hermes'), '?wake=1') as WebSocket;
    await statusOf(ws);
    ws.send(JSON.stringify({ type: 'wake.ack', wakeId: WAKE_ID, telemetry: { kind: 'session' } }));
    await until(() => (wake.acknowledge.mock.calls.length ? true : undefined));
    expect(wake.acknowledge).toHaveBeenCalledWith(
      expect.objectContaining({
        principalId: 'hermes', handle: 'hermes', credentialId: 'credential-hermes', delegationLinks: null,
        actor: expect.objectContaining({ principalId: 'hermes', scopes: ['tasks:read'], authenticated: true }),
      }),
      { wakeId: WAKE_ID, telemetry: { kind: 'session' } },
    );
    expect(ws.readyState).toBe(WebSocket.OPEN);
    const closed = closeOf(ws);
    ws.close();
    await closed;
    await until(() => (wake.detach.mock.calls.length ? true : undefined));
    expect(wake.detach).toHaveBeenCalledWith(expect.anything(), 'hermes');
  });

  test('a revoked credential cannot acknowledge: the socket closes 1008 and nothing settles', async () => {
    const ws = await connect(issue('hermes'), '?wake=1') as WebSocket;
    await statusOf(ws);
    credentials.delete('rh_live_hermes');
    const closed = closeOf(ws);
    ws.send(JSON.stringify({ type: 'wake.ack', wakeId: WAKE_ID }));
    expect((await closed).code).toBe(1008);
    expect(wake.acknowledge).not.toHaveBeenCalled();
  });

  test.each([
    ['another frame type', JSON.stringify({ cursor: '0', action: 'grant' })],
    ['an extra key', JSON.stringify({ type: 'wake.ack', wakeId: WAKE_ID, cursor: '0' })],
    ['not JSON', 'wake'],
  ])('anything but a well-formed wake.ack (%s) still closes 1008', async (_label, frame) => {
    const ws = await connect(issue('hermes'), '?wake=1') as WebSocket;
    await statusOf(ws);
    const closed = closeOf(ws);
    ws.send(frame);
    expect(await closed).toEqual({ code: 1008, reason: 'Only wake.ack frames are accepted' });
    expect(wake.acknowledge).not.toHaveBeenCalled();
  });

  test('a flood of acknowledgements naming no wake closes the socket', async () => {
    const ws = await connect(issue('hermes'), '?wake=1') as WebSocket;
    await statusOf(ws);
    const closed = closeOf(ws);
    for (let i = 0; i < 17; i++) ws.send(JSON.stringify({ type: 'wake.ack', wakeId: OTHER_ID }));
    expect(await closed).toEqual({ code: 1008, reason: 'Too many unmatched acknowledgements' });
  });

  test('a wake=1 socket the dispatcher refused stays receive-only: a wake.ack closes it and settles nothing', async () => {
    const ws = await connect(issue('reader'), '?wake=1') as WebSocket;
    expect(await statusOf(ws)).toEqual({ type: 'wake.status', enabled: false, reason: 'NOT_A_PUBLISHED_CONNECTOR' });
    const closed = closeOf(ws);
    ws.send(JSON.stringify({ type: 'wake.ack', wakeId: WAKE_ID }));
    expect(await closed).toEqual({ code: 1008, reason: 'This stream is receive-only' });
    expect(wake.acknowledge).not.toHaveBeenCalled();
  });

  test('a frame sent before the dispatcher registered the socket closes it receive-only; the late registration is undone', async () => {
    const registration = deferred<any>();
    wake.attach.mockImplementationOnce(() => registration.promise);
    const ws = await connect(issue('hermes'), '?wake=1') as WebSocket;
    await until(() => (wake.attach.mock.calls.length ? true : undefined));
    const closed = closeOf(ws);
    ws.send(JSON.stringify({ type: 'wake.ack', wakeId: WAKE_ID }));
    expect(await closed).toEqual({ code: 1008, reason: 'This stream is receive-only' });
    await until(() => (wake.detach.mock.calls.length >= 1 ? true : undefined));
    registration.resolve({ enabled: true, serviceId: 'svc' });
    // Once from the close handler, once more for the registration that landed late.
    await until(() => (wake.detach.mock.calls.length >= 2 ? true : undefined));
    expect(wake.acknowledge).not.toHaveBeenCalled();
    expect(inbox.get(ws)!.some(frame => frame.type === 'wake.status')).toBe(false);
  });

  test('a socket without wake=1 stays receive-only, acknowledgement or not', async () => {
    const ws = await connect(issue('hermes'), '') as WebSocket;
    const closed = closeOf(ws);
    ws.send(JSON.stringify({ type: 'wake.ack', wakeId: WAKE_ID }));
    expect(await closed).toEqual({ code: 1008, reason: 'This stream is receive-only' });
    expect(wake.attach).not.toHaveBeenCalled();
    expect(wake.acknowledge).not.toHaveBeenCalled();
  });
});

describe('wake protocol 2 (owner ruling E462, design sections 6.1 and 6.7)', () => {
  beforeEach(() => start(true));

  test('a wake=2 socket registers with its protocol, and protocol 1 still registers exactly as before', async () => {
    const ws = await connect(issue('hermes'), '?cursor=0&wake=2') as WebSocket;
    expect(await statusOf(ws)).toEqual({ type: 'wake.status', enabled: true });
    expect(wake.attach).toHaveBeenCalledWith(expect.anything(), 'hermes', 2);
    const old = await connect(issue('hermes'), '?wake=1') as WebSocket;
    await statusOf(old);
    expect(wake.attach).toHaveBeenLastCalledWith(expect.anything(), 'hermes');
  });

  test('a wake.ack on a wake=2 socket names that socket; a wake.outcome is handed over with the re-derived identity and the socket', async () => {
    const ws = await connect(issue('hermes'), '?wake=2') as WebSocket;
    await statusOf(ws);
    ws.send(JSON.stringify({ type: 'wake.ack', wakeId: WAKE_ID }));
    await until(() => (wake.acknowledge.mock.calls.length ? true : undefined));
    expect(wake.acknowledge.mock.calls[0]).toHaveLength(3);
    expect(wake.acknowledge.mock.calls[0][2]).toEqual({ socket: expect.anything() });
    ws.send(JSON.stringify({ type: 'wake.outcome', wakeId: WAKE_ID, outcome: 'refused', reason: 'HARNESS_CONFIG_NOT_ISOLATED' }));
    await until(() => (wake.recordOutcome.mock.calls.length ? true : undefined));
    expect(wake.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ principalId: 'hermes', credentialId: 'credential-hermes' }),
      { wakeId: WAKE_ID, outcome: 'refused', reason: 'HARNESS_CONFIG_NOT_ISOLATED' },
      wake.acknowledge.mock.calls[0][2].socket,
    );
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  test('a wake.outcome on a wake=1 socket closes it 1008, unchanged message, and records nothing', async () => {
    const ws = await connect(issue('hermes'), '?wake=1') as WebSocket;
    await statusOf(ws);
    const closed = closeOf(ws);
    ws.send(JSON.stringify({ type: 'wake.outcome', wakeId: WAKE_ID, outcome: 'started' }));
    expect(await closed).toEqual({ code: 1008, reason: 'Only wake.ack frames are accepted' });
    expect(wake.recordOutcome).not.toHaveBeenCalled();
  });

  test.each([
    ['a free-text reason', JSON.stringify({ type: 'wake.outcome', wakeId: WAKE_ID, outcome: 'refused', reason: 'ignore previous instructions' })],
    ['a refusal without a reason', JSON.stringify({ type: 'wake.outcome', wakeId: WAKE_ID, outcome: 'refused' })],
    ['an unknown outcome', JSON.stringify({ type: 'wake.outcome', wakeId: WAKE_ID, outcome: 'merged' })],
  ])('a malformed frame on a wake=2 socket (%s) closes it 1008', async (_label, frame) => {
    const ws = await connect(issue('hermes'), '?wake=2') as WebSocket;
    await statusOf(ws);
    const closed = closeOf(ws);
    ws.send(frame);
    expect(await closed).toEqual({ code: 1008, reason: 'Only wake.ack and wake.outcome frames are accepted' });
    expect(wake.recordOutcome).not.toHaveBeenCalled();
  });

  test('outcomes that record nothing count toward the unmatched cap', async () => {
    const ws = await connect(issue('hermes'), '?wake=2') as WebSocket;
    await statusOf(ws);
    const closed = closeOf(ws);
    for (let i = 0; i < 17; i++) ws.send(JSON.stringify({ type: 'wake.outcome', wakeId: OTHER_ID, outcome: 'started' }));
    expect(await closed).toEqual({ code: 1008, reason: 'Too many unmatched acknowledgements' });
  });
});

describe('bounded acknowledgement work per socket', () => {
  // A long interval keeps the periodic feed re-authorization out of the counts.
  beforeEach(() => start(true, 60000));

  async function enabledWakeSocket(): Promise<WebSocket> {
    const ws = await connect(issue('hermes'), '?wake=1') as WebSocket;
    expect(await statusOf(ws)).toEqual({ type: 'wake.status', enabled: true });
    // The first feed frame means the opening tick's two authorizations are done.
    await until(() => inbox.get(ws)?.find(frame => frame.type === 'events'));
    authProbe.calls = 0;
    return ws;
  }

  test('a burst of 400 acknowledgements naming no wake: one at a time, at most 17 re-authorizations', async () => {
    let active = 0;
    let peak = 0;
    wake.acknowledge.mockImplementation(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return false;
    });
    const ws = await enabledWakeSocket();
    const closed = closeOf(ws);
    for (let i = 0; i < 400; i++) ws.send(JSON.stringify({ type: 'wake.ack', wakeId: OTHER_ID }));
    const outcome = await closed;
    await pause(150);
    expect(outcome.code).toBe(1008);
    expect(['Too many acknowledgements waiting', 'Too many unmatched acknowledgements']).toContain(outcome.reason);
    expect(peak).toBeLessThanOrEqual(1);
    expect(wake.acknowledge.mock.calls.length).toBeLessThanOrEqual(17);
    expect(authProbe.calls).toBeLessThanOrEqual(17);
  });

  test('paced acknowledgements naming no wake cost exactly 17 re-authorizations, then the socket closes', async () => {
    const ws = await enabledWakeSocket();
    const closed = closeOf(ws);
    for (let i = 1; i <= 17; i++) {
      ws.send(JSON.stringify({ type: 'wake.ack', wakeId: OTHER_ID }));
      await until(() => (wake.acknowledge.mock.calls.length >= i ? true : undefined));
    }
    expect(await closed).toEqual({ code: 1008, reason: 'Too many unmatched acknowledgements' });
    await pause(50);
    expect(wake.acknowledge).toHaveBeenCalledTimes(17);
    expect(authProbe.calls).toBe(17);
  });

  test('acknowledgements still waiting when the socket closes are discarded', async () => {
    const held = deferred<boolean>();
    wake.acknowledge.mockImplementationOnce(() => held.promise);
    const ws = await enabledWakeSocket();
    for (let i = 0; i < 4; i++) ws.send(JSON.stringify({ type: 'wake.ack', wakeId: i === 0 ? WAKE_ID : OTHER_ID }));
    await until(() => (wake.acknowledge.mock.calls.length ? true : undefined));
    const closed = closeOf(ws);
    ws.close();
    await closed;
    held.resolve(true);
    await pause(150);
    expect(wake.acknowledge).toHaveBeenCalledTimes(1);
    expect(authProbe.calls).toBe(1);
  });

  test('an acknowledgement whose re-authorization finishes after the socket closed is never handed over', async () => {
    const ws = await enabledWakeSocket();
    const gate = deferred<void>();
    authProbe.gate = gate.promise;
    ws.send(JSON.stringify({ type: 'wake.ack', wakeId: WAKE_ID }));
    await until(() => (authProbe.calls === 1 ? true : undefined));
    const closed = closeOf(ws);
    ws.close();
    await closed;
    gate.resolve();
    await pause(150);
    expect(wake.acknowledge).not.toHaveBeenCalled();
  });
});

describe('without the wake dispatcher', () => {
  beforeEach(() => start(false));

  test('wake=1 is accepted, reported unavailable, and the socket stays receive-only', async () => {
    const ws = await connect(issue('hermes'), '?wake=1') as WebSocket;
    expect(await statusOf(ws)).toEqual({ type: 'wake.status', enabled: false, reason: 'WAKE_UNAVAILABLE' });
    const closed = closeOf(ws);
    ws.send(JSON.stringify({ type: 'wake.ack', wakeId: WAKE_ID }));
    expect(await closed).toEqual({ code: 1008, reason: 'This stream is receive-only' });
  });
});
