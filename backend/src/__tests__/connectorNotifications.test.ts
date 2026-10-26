import http from 'http';
import { WebSocket } from 'ws';

const credentials = new Map<string, any>();
const grants = new Map<string, Set<string>>();
let rows: any[] = [];
let chainAlive = true;
const query = jest.fn(async (sql: string, args: any[]) => {
  if (!sql.includes('FROM feed_events')) throw new Error('Unexpected query in isolated fixture');
  return { rows: rows.filter(row => BigInt(row.cursor) > BigInt(args[0])).slice(0, args[1]) };
});
jest.mock('../db/connection', () => ({ pool: { query: (...args: any[]) => query(args[0], args[1]) } }));
jest.mock('../services/PrincipalService', () => ({
  parsePrincipalKey: (value: string) => ({ value }),
  principalService: {
    authenticatePrincipalKey: async ({ value }: { value: string }) => credentials.get(value),
    bumpLastSeen: jest.fn(),
  },
}));
jest.mock('../services/DelegationService', () => ({
  delegationService: {
    resolveChain: async () => ({ alive: chainAlive, links: [
      { principalId: 'a', kind: 'connector', role: 'user', parentPrincipalId: 'account', boundTaskId: null, boundTaskRole: null, legacyIdentity: false, ownExpression: null },
      { principalId: 'account', kind: 'account', role: 'user', parentPrincipalId: null, boundTaskId: null, boundTaskRole: null, legacyIdentity: false, ownExpression: null },
    ] }),
    effectiveScopes: (_chain: unknown, scopes: string[]) => scopes,
  },
  DelegationEvaluatorError: class extends Error {},
}));
jest.mock('../services/AuthorizationRepository', () => ({
  authorizationRepository: {
    authorizedIds: async (actor: any, _type: string, ids: string[]) =>
      new Set(ids.filter(id => grants.get(actor.principalId)?.has(id))),
  },
}));
import { ConnectorNotificationService } from '../services/ConnectorNotificationService';
import { feedEventService } from '../services/FeedEventService';

let server: http.Server;
let service: ConnectorNotificationService;
let port: number;
const sockets: WebSocket[] = [];
const inbox = new Map<WebSocket, any[]>();

function issue(name: string, scopes = ['tasks:read'], transport = 'api', delegated = false): string {
  const key = `rh_live_${name}`;
  credentials.set(key, {
    principal: { id: name, handle: name, role: 'user', kind: 'connector', legacyIdentity: false,
      parentPrincipalId: delegated ? 'account' : null },
    credential: { id: `credential-${name}`, scopes, transport },
  });
  return `Bearer ${key}`;
}
function event(cursor: number, object: string): any {
  return { cursor: String(cursor), name: 'task.updated', object_type: 'task', object_id: object,
    occurred_at: '2026-09-25T00:00:00Z', actor_principal_id: null, actor_handle: null,
    project_id: null, owner_principal_id: null, payload: {} };
}
async function connect(authorization?: string, suffix = ''): Promise<WebSocket | number> {
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
async function page(ws: WebSocket, cursor: string): Promise<any> {
  return until(() => inbox.get(ws)?.find(value => value.nextCursor === cursor));
}
beforeEach(async () => {
  credentials.clear(); grants.clear(); rows = []; chainAlive = true; query.mockClear();
  server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  service = new ConnectorNotificationService(server, 20);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as any).port;
});
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  service.shutdown();
  await new Promise<void>(resolve => server.close(() => resolve()));
  inbox.clear(); jest.restoreAllMocks();
});

test('real socket + canonical credential/route acceptance + feed hide another account and resume by cursor', async () => {
  rows = [event(1, 'private-a'), event(2, 'private-b'), event(3, 'private-a')];
  grants.set('a', new Set(['private-a'])); grants.set('b', new Set(['private-b']));
  const a = await connect(issue('a')) as WebSocket;
  const b = await connect(issue('b')) as WebSocket;
  expect((await page(a, '3')).events.map((e: any) => e.objectId)).toEqual(['private-a', 'private-a']);
  expect((await page(b, '3')).events.map((e: any) => e.objectId)).toEqual(['private-b']);
  const resumed = await connect(issue('a'), '?cursor=1') as WebSocket;
  expect((await page(resumed, '3')).events.map((e: any) => e.cursor)).toEqual(['3']);
  expect(query.mock.calls.every(([, args]) => args[1] === 200)).toBe(true);
});

test.each([
  [undefined, '', 401],
  ['Bearer dashboard-jwt', '', 401],
  ['Bearer rh_live_unknown', '', 401],
  [undefined, '?token=rh_live_secret', 400],
  [undefined, '?cursor=-1', 400],
  [undefined, '?cursor=9223372036854775808', 400],
  [undefined, '?cursor=1&cursor=2', 400],
  [undefined, '?cursor=abc', 400],
])('refuses invalid identity/query without touching feed: %s %s', async (auth, suffix, status) => {
  expect(await connect(auth, suffix)).toBe(status);
  expect(query).not.toHaveBeenCalled();
});

test('scope and API transport ceilings refuse even valid credentials', async () => {
  expect(await connect(issue('reader-without-tasks', ['reports:read']))).toBe(401);
  expect(await connect(issue('mcp-only', ['tasks:read'], 'mcp'))).toBe(401);
  expect(query).not.toHaveBeenCalled();
});

test('revoked credential closes an existing socket before another event is sent', async () => {
  const ws = await connect(issue('a')) as WebSocket;
  await page(ws, '0');
  credentials.delete('rh_live_a');
  grants.set('a', new Set(['secret']));
  rows = [event(1, 'secret')];
  const code = await new Promise<number>(resolve => ws.once('close', resolve));
  expect(code).toBe(1008);
  expect(inbox.get(ws)!.flatMap(p => p.events)).toEqual([]);
});

test('revoked delegation parent closes an existing socket', async () => {
  const ws = await connect(issue('a', ['tasks:read'], 'api', true)) as WebSocket;
  await page(ws, '0'); chainAlive = false;
  expect(await new Promise<number>(resolve => ws.once('close', resolve))).toBe(1008);
});

test('revoked object grant is reread; hidden events still advance recovery cursor without metadata', async () => {
  grants.set('a', new Set(['private-a']));
  const ws = await connect(issue('a')) as WebSocket;
  await page(ws, '0');
  grants.get('a')!.clear(); rows = [event(1, 'private-a')];
  expect((await page(ws, '1')).events).toEqual([]);
});

test('credential revocation during an in-flight feed read refuses the resulting frame', async () => {
  const original = feedEventService.listSince.bind(feedEventService);
  jest.spyOn(feedEventService, 'listSince').mockImplementation(async (...args) => {
    const result = await original(...args); credentials.delete('rh_live_a'); return result;
  });
  const ws = await connect(issue('a')) as WebSocket;
  expect(await new Promise<number>(resolve => ws.once('close', resolve))).toBe(1008);
  expect(inbox.get(ws)).toEqual([]);
});

test('per-principal socket bound refuses the fifth connection', async () => {
  const auth = issue('a');
  for (let i = 0; i < 4; i++) expect(await connect(auth)).toBeInstanceOf(WebSocket);
  expect(await connect(auth)).toBe(503);
});

test('client messages cannot mutate state or reset the cursor', async () => {
  const ws = await connect(issue('a')) as WebSocket;
  await page(ws, '0');
  const closed = new Promise<number>(resolve => ws.once('close', resolve));
  ws.send(JSON.stringify({ cursor: '0', action: 'grant', principal: 'other' }));
  expect(await closed).toBe(1008);
});

test('oversized batch closes with polling recovery rather than enqueueing unbounded content', async () => {
  grants.set('a', new Set(['private-a']));
  rows = [{ ...event(1, 'private-a'), payload: { unexpected: 'x'.repeat(262144) } }];
  const ws = await connect(issue('a')) as WebSocket;
  expect(await new Promise<number>(resolve => ws.once('close', resolve))).toBe(1013);
  expect(inbox.get(ws)).toEqual([]);
});

test('feed failure closes without sending internal error details', async () => {
  query.mockRejectedValueOnce(new Error('SENSITIVE fixture exception') as never);
  const ws = await connect(issue('a')) as WebSocket;
  const closed = await new Promise<{ code: number; reason: string }>(resolve =>
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  expect(closed).toEqual({ code: 1011, reason: 'Feed unavailable; use polling' });
});

test('a slow outgoing socket closes before reading another batch', async () => {
  const ws = await connect(issue('a')) as WebSocket;
  await page(ws, '0');
  const serverSocket = [...(service as any).connections.keys()][0] as WebSocket;
  Object.defineProperty(serverSocket, 'bufferedAmount', { configurable: true, get: () => 262145 });
  const reads = query.mock.calls.length;
  expect(await new Promise<number>(resolve => ws.once('close', resolve))).toBe(1013);
  expect(query.mock.calls.length).toBe(reads);
});

test('idle sockets still revalidate and close when credential acceptance expires', async () => {
  const ws = await connect(issue('a')) as WebSocket;
  await page(ws, '0');
  // Canonical acceptance treats expiry as an authentication refusal, just as
  // its live credential store does. No new event is needed to trigger recheck.
  credentials.set('rh_live_a', undefined);
  expect(await new Promise<number>(resolve => ws.once('close', resolve))).toBe(1008);
});


test('authority narrowed during a feed read cannot emit the old authority snapshot', async () => {
  const original = feedEventService.listSince.bind(feedEventService);
  jest.spyOn(feedEventService, 'listSince').mockImplementation(async (...args) => {
    const result = await original(...args);
    credentials.get('rh_live_a').credential.scopes = ['tasks:read'];
    return result;
  });
  grants.set('a', new Set(['private-a'])); rows = [event(1, 'private-a')];
  const ws = await connect(issue('a', ['tasks:read', 'reports:read'])) as WebSocket;
  expect(await new Promise<number>(resolve => ws.once('close', resolve))).toBe(1008);
  expect(inbox.get(ws)).toEqual([]);
});
