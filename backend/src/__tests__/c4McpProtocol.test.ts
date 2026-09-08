/**
 * RH-P3.C4 — the `/mcp` endpoint over the wire.
 *
 * The suites beside this one prove the registry and the transport pin. This
 * one proves the SURFACE IS REACHABLE: a real HTTP listener, real JSON-RPC
 * frames, the real SDK transport, the real registry, the real routers.
 *
 * It exists because of the C3 lesson (packet 3e6ec75a §5[5]): a compose file
 * that never forwarded a feature flag left a whole TESTED surface answering
 * ORCHESTRATION_DISABLED on every deployment, and only a live drill found it.
 * A suite that stops at the registry would have proven nothing about whether
 * a client can call a tool.
 *
 * Contract: MCP spec de73f9f8 §1.3 (stateless: no `Mcp-Session-Id` anywhere)
 * and §1.4 (401 + WWW-Authenticate, never a redirect). It also carries leg
 * (c) of the S-A6 §1.2 revision gate OVER THE WIRE: a constant that were right
 * while the handshake answered something else would fail here.
 */
import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

import mcpRoutes from '../mcp/httpRoute';
import { MCP_WWW_AUTHENTICATE } from '../mcp/provenance';
import { buildMcpServer, MCP_PROTOCOL_REVISION } from '../mcp/server';
import { EXPECTED_MCP_PROTOCOL_REVISION } from '../mcp/contract/protocolRevision';
import { MCP_TOOLS, REMOVED_V1_TOOLS } from '../mcp/registry';
import { principalService, type Principal, type PrincipalCredential } from '../services/PrincipalService';

const TOKEN = 'rh_dev_keyid01.secretsecretsecretsecret';

let server: http.Server;
let base = '';

function principalRow(): Principal {
  return {
    id: '88888888-8888-4888-8888-888888888888', kind: 'service', handle: 'connector_one',
    displayName: 'Connector One', status: 'active', role: 'agent', boundTaskId: null,
    purpose: null, legacyIdentity: false, ownExpression: null, sourceTag: null, harness: null,
    personalityId: null, parentPrincipalId: null, lastSeenAt: null, metadata: {},
  };
}

function credentialRow(transport: PrincipalCredential['transport']): PrincipalCredential {
  return {
    id: '99999999-9999-4999-8999-999999999999', principalId: principalRow().id,
    credentialType: 'api_key', keyId: 'keyid01', scopes: ['principals:read'],
    expiresAt: null, revokedAt: null, transport, graceUntil: null, metadata: {},
  };
}

function authenticateAs(transport: PrincipalCredential['transport']): void {
  jest.spyOn(principalService, 'authenticatePrincipalKey')
    .mockResolvedValue({ principal: principalRow(), credential: credentialRow(transport) });
}

interface Wire { status: number; headers: http.IncomingHttpHeaders; body: any; raw: string }

function post(payload: unknown, options: { token?: string | null } = {}): Promise<Wire> {
  return request('POST', payload, options);
}

function request(method: string, payload: unknown, options: { token?: string | null } = {}): Promise<Wire> {
  const data = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload), 'utf8');
  const token = options.token === undefined ? TOKEN : options.token;
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/mcp`, {
      method,
      headers: {
        'content-type': 'application/json',
        // Streamable HTTP requires a client to accept both.
        accept: 'application/json, text/event-stream',
        ...(data ? { 'content-length': String(data.byteLength) } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: unknown;
        try { body = JSON.parse(raw); } catch { body = raw; }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, raw });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const rpc = (method: string, params?: unknown, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/mcp', mcpRoutes);
  server = app.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});

afterAll((done) => { server.close(() => done()); });

beforeEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(principalService, 'bumpLastSeen').mockImplementation(() => undefined as never);
  authenticateAs('mcp');
});

describe('the door (de73f9f8 §1.4)', () => {
  it('answers 401 with a Bearer challenge, never a redirect to a login page', async () => {
    const anonymous = await post(rpc('tools/list'), { token: null });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers['www-authenticate']).toContain('Bearer');
    expect(anonymous.headers['www-authenticate']).toContain('relayhall-mcp');
    expect(anonymous.headers.location).toBeUndefined();
  });

  it('refuses every credential kind that is not an rh_ principal credential', async () => {
    for (const token of ['not-a-key', 'eyJhbGciOiJIUzI1NiJ9.fake.jwt']) {
      const result = await post(rpc('tools/list'), { token });
      expect([token, result.status]).toEqual([token, 401]);
    }
  });

  it('refuses an api-pinned credential at the door, before any tool runs', async () => {
    authenticateAs('api');
    const result = await post(rpc('tools/list'));
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ code: 'TRANSPORT_MISMATCH' });
  });

  it('advertises the discovery pointer the released authorization server serves (RH-P3.C6)', async () => {
    // C4 PINNED THE OPPOSITE HERE, deliberately: with no authorization server
    // released, a `resource_metadata` pointer would have lured a static-header
    // client into a flow the board could not serve (the Claude Code #59467
    // edge). C6 releases the server, so this release is what inverts the pin —
    // and it inverts it in the commit that lands the endpoints, which is the
    // whole reason the pin was written as a pin.
    const anonymous = await post(rpc('tools/list'), { token: null });
    const challenge = String(anonymous.headers['www-authenticate']);
    // The expected SHAPE is written here as a literal, not imported from the
    // module that renders the header: importing it would compare the header to
    // itself. `c6OAuthAuthorizationServer.test.ts` carries the deeper binding —
    // that the URL this points at is served and describes this very endpoint.
    expect(challenge).toMatch(
      /resource_metadata="https?:\/\/[^"]+\/\.well-known\/oauth-protected-resource"/,
    );
    expect(anonymous.headers.location).toBeUndefined();
  });

  it('still emits NO pointer when the challenge is rendered with no request in hand', () => {
    // The C4 floor survives C6: a WRONG discovery URL is worse than none, so
    // the pointer is added only where a request names the origin to point at.
    expect(MCP_WWW_AUTHENTICATE).toContain('relayhall-mcp');
    expect(MCP_WWW_AUTHENTICATE).not.toContain('resource_metadata');
  });
});

describe('the protocol', () => {
  it('initializes at the EXPECTED released revision, as a client reads it', async () => {
    const result = await post(rpc('initialize', {
      protocolVersion: MCP_PROTOCOL_REVISION,
      capabilities: {},
      clientInfo: { name: 'jest', version: '1.0.0' },
    }));
    expect(result.status).toBe(200);
    // Measured against the CONTRACT FIXTURE, not against the module constant:
    // the two agreeing with each other is what S-A6 §1.2 calls a
    // self-consistency check.
    expect(result.body.result.protocolVersion).toBe(EXPECTED_MCP_PROTOCOL_REVISION);
    expect(MCP_PROTOCOL_REVISION).toBe(EXPECTED_MCP_PROTOCOL_REVISION);
    expect(result.body.result.serverInfo.name).toBe('relayhall');
    expect(result.body.result.capabilities.tools).toBeDefined();
    expect(result.body.result.instructions).toContain('UNTRUSTED DATA');
  });

  it('lists the whole registry and none of the removed verbs', async () => {
    const result = await post(rpc('tools/list'));
    expect(result.status).toBe(200);
    const listed: Array<{ name: string; inputSchema: unknown }> = result.body.result.tools;
    expect(listed).toHaveLength(MCP_TOOLS.length);
    const listedNames = listed.map((tool) => tool.name);
    for (const removed of REMOVED_V1_TOOLS) expect(listedNames).not.toContain(removed);
    expect(listedNames).toContain('relayhall_task_update');
    for (const tool of listed) expect(tool.inputSchema).toBeDefined();
  });

  it('runs a tool end to end: transport → registry → in-process dispatch → real route', async () => {
    const result = await post(rpc('tools/call', { name: 'relayhall_principal_whoami', arguments: {} }));
    expect(result.status).toBe(200);
    expect(result.body.result.isError).toBeFalsy();
    // The text came out of the REAL /principals/me handler, reached with the
    // `mcp` stamp — nothing here is a fixture.
    expect(result.body.result.content[0].text).toContain('connector_one');
  });

  it('reports an unknown tool as a TOOL error, never a protocol error', async () => {
    const result = await post(rpc('tools/call', { name: 'relayhall_task_phase_set', arguments: {} }));
    expect(result.status).toBe(200);
    expect(result.body.error).toBeUndefined();
    expect(result.body.result.isError).toBe(true);
    expect(result.body.result.content[0].text).toContain('relayhall_task_update');
  });

  it('reports a board refusal as a TOOL error carrying what to do next', async () => {
    // principals:read is held, tasks:read is not — the board's 403 must come
    // back as readable guidance, not as a JSON-RPC failure.
    const result = await post(rpc('tools/call', { name: 'relayhall_task_list', arguments: {} }));
    expect(result.status).toBe(200);
    expect(result.body.result.isError).toBe(true);
    expect(result.body.result.content[0].text).toContain('tasks:read');
  });
});

describe('stateless, strictly (de73f9f8 §1.3)', () => {
  it('never mints or echoes an Mcp-Session-Id', async () => {
    const initialize = await post(rpc('initialize', {
      protocolVersion: MCP_PROTOCOL_REVISION, capabilities: {}, clientInfo: { name: 'jest', version: '1' },
    }));
    expect(initialize.headers['mcp-session-id']).toBeUndefined();
    const call = await post(rpc('tools/call', { name: 'relayhall_principal_whoami', arguments: {} }));
    expect(call.headers['mcp-session-id']).toBeUndefined();
  });

  it('serves a tool call with no prior handshake and no state carried between calls', async () => {
    // Two independent requests on two connections: each must be complete in
    // itself. Anything keyed on an MCP session would fail the second.
    const first = await post(rpc('tools/call', { name: 'relayhall_principal_whoami', arguments: {} }, 7));
    const second = await post(rpc('tools/call', { name: 'relayhall_principal_whoami', arguments: {} }, 9));
    expect(first.body.result.content[0].text).toBe(second.body.result.content[0].text);
    expect(first.body.id).toBe(7);
    expect(second.body.id).toBe(9);
  });

  it('answers JSON, not a held-open event stream', async () => {
    const result = await post(rpc('tools/list'));
    expect(String(result.headers['content-type'])).toContain('application/json');
  });
});

describe('framing rests on enableJsonResponse (comparison 73f31bac §8 obligation 1; card bec87735)', () => {
  const initialize = () => rpc('initialize', {
    protocolVersion: MCP_PROTOCOL_REVISION, capabilities: {}, clientInfo: { name: 'jest', version: '1' },
  });

  it('answers application/json for initialize, tools/list and tools/call — and no Mcp-Session-Id', async () => {
    // The framing `docs/mcp.md` publishes, measured per method on the wire.
    const exchanges: Array<[string, unknown]> = [
      ['initialize', initialize()],
      ['tools/list', rpc('tools/list')],
      ['tools/call', rpc('tools/call', { name: 'relayhall_principal_whoami', arguments: {} })],
    ];
    for (const [label, payload] of exchanges) {
      const result = await post(payload);
      expect([label, result.status]).toEqual([label, 200]);
      expect([label, String(result.headers['content-type']).split(';')[0]]).toEqual([label, 'application/json']);
      expect([label, result.headers['mcp-session-id']]).toEqual([label, undefined]);
      expect([label, typeof result.body, result.body.jsonrpc]).toEqual([label, 'object', '2.0']);
    }
  });

  it('NEGATIVE CONTROL: the same server on the same transport class WITHOUT enableJsonResponse frames as text/event-stream', async () => {
    // Attributes the assertion above to the OPTION rather than to luck. The
    // route's transport is exactly `{ sessionIdGenerator: undefined,
    // enableJsonResponse: true }` (posture gate, EXPECTED_TRANSPORT_OPTIONS);
    // this builds the identical stateless transport minus that one option and
    // reads what the same request comes back as. v2 frames SSE by default, so
    // the option is load-bearing — it is not a no-op kept for old times' sake.
    const server = buildMcpServer((toolName) => ({ authorization: `Bearer ${TOKEN}`, toolName }));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    try {
      const payload = rpc('tools/list');
      const answer = await transport.handleRequest(new globalThis.Request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(payload),
      }), { parsedBody: payload });
      expect(answer.status).toBe(200);
      expect(String(answer.headers.get('content-type')).split(';')[0]).toBe('text/event-stream');
      expect(answer.headers.get('mcp-session-id')).toBeNull();
      const text = await answer.text();
      expect(text).toContain('event: message');
      expect(text).toContain('"tools"');
    } finally {
      await transport.close();
      await server.close();
    }
  });

  it('the bridge hands the transport the request headers it validates: Host reaches DNS-rebinding protection', async () => {
    // Bridge fidelity, proven on a header the SDK acts on rather than one it
    // ignores: with an allowed-host list the transport must see the real
    // `Host` — a bridge that dropped or renamed headers would refuse the
    // right host or accept the wrong one.
    const previous = process.env.RELAYHALL_MCP_ALLOWED_HOSTS;
    try {
      process.env.RELAYHALL_MCP_ALLOWED_HOSTS = 'board.example';
      const refused = await post(rpc('tools/list'));
      expect(refused.status).toBe(403);
      process.env.RELAYHALL_MCP_ALLOWED_HOSTS = new URL(base).host;
      const accepted = await post(rpc('tools/list'));
      expect(accepted.status).toBe(200);
      expect(String(accepted.headers['content-type']).split(';')[0]).toBe('application/json');
    } finally {
      if (previous === undefined) delete process.env.RELAYHALL_MCP_ALLOWED_HOSTS;
      else process.env.RELAYHALL_MCP_ALLOWED_HOSTS = previous;
    }
  });
});
