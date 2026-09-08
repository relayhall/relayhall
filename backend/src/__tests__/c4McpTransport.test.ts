/**
 * RH-P3.C4 — MCP-only enforcement, all three directions (AUTHZ design
 * 4d961e37 §7.5; threat rows T15/T26/T28).
 *
 * §7.5 pins three directions, and this suite drives all of them through the
 * PRODUCTION ingress code rather than a synthetic actor — the AZ-S3 lesson
 * (verdict 87fec3e2 B1: "a synthetic actor passed its tests while the real
 * derivation returned empty authority"):
 *
 *   1. an `mcp`-pinned credential SUCCEEDS through the in-process MCP handler;
 *   2. the same credential over REST REFUSES (T15);
 *   3. direct HTTP with forged provenance headers still classifies `api`;
 *   plus an UNCLASSIFIED route rejecting any non-`any` pin (T26)
 *   and rotation inheriting the pin verbatim (T28).
 *
 * Every dispatch below runs through the real Express routers, the real
 * `acceptPrincipalKey`, the real `sharedAuthorizationMiddleware` ceiling and
 * the real handlers. Only the credential lookup is stubbed, because a real
 * one needs a database and a plaintext secret.
 */
import { evaluateTransportPin } from '../utils/credentialAcceptance';
import { routeTransportClassFor } from '../utils/transportMap';
import { principalService, type Principal, type PrincipalCredential } from '../services/PrincipalService';
import { acceptPrincipalKey, authMiddleware, REST_TRANSPORT_STAMP, type AuthRequest } from '../middleware/auth';
import { MCP_TRANSPORT_STAMP } from '../mcp/provenance';
import { dispatchInProcess } from '../mcp/inProcess';

const PRINCIPAL_ID = '11111111-1111-4111-8111-111111111111';
const CREDENTIAL_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'rh_dev_keyid01.secretsecretsecretsecret';
const BEARER = `Bearer ${TOKEN}`;

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    id: PRINCIPAL_ID, kind: 'service', handle: 'connector_one', displayName: 'Connector One',
    status: 'active', role: 'agent', boundTaskId: null, purpose: null, legacyIdentity: false,
    ownExpression: null, sourceTag: null, harness: null, personalityId: null,
    parentPrincipalId: null, lastSeenAt: null, metadata: {}, ...overrides,
  };
}

function credential(transport: PrincipalCredential['transport'], scopes: string[]): PrincipalCredential {
  return {
    id: CREDENTIAL_ID, principalId: PRINCIPAL_ID, credentialType: 'api_key', keyId: 'keyid01',
    scopes, expiresAt: null, revokedAt: null, transport, graceUntil: null, metadata: {},
  };
}

function authenticateAs(transport: PrincipalCredential['transport'], scopes: string[] = ['principals:read', 'reports:read', 'reports:write']): void {
  jest.spyOn(principalService, 'authenticatePrincipalKey')
    .mockResolvedValue({ principal: principal(), credential: credential(transport, scopes) });
}

beforeEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(principalService, 'bumpLastSeen').mockImplementation(() => undefined as never);
});

/** Drive the REST ingress exactly as `protectedRouter` does. */
async function overRest(headers: Record<string, unknown>, mounted = { baseUrl: '/principals', path: '/me' }) {
  const req = { ...mounted, method: 'GET', headers } as unknown as AuthRequest;
  let status = 200;
  let body: unknown;
  const res = {
    status: (code: number) => { status = code; return res; },
    json: (value: unknown) => { body = value; return res; },
    setHeader: () => res,
  } as never;
  let passed = false;
  await authMiddleware(req, res, () => { passed = true; });
  return { status, body: body as Record<string, unknown> | undefined, passed, req };
}

describe('the stamp is a server-derived constant, not an input', () => {
  it('is `mcp` for the in-process handler and `api` for REST', () => {
    expect(MCP_TRANSPORT_STAMP).toBe('mcp');
    expect(REST_TRANSPORT_STAMP).toBe('api');
  });

  it('declares /mcp so the T26 unclassified rule does not reject its own callers', () => {
    expect(routeTransportClassFor('/mcp')).toBe('mcp');
    expect(routeTransportClassFor('/mcp/anything')).toBe('mcp');
  });
});

describe('direction 1 — an mcp-pinned credential SUCCEEDS through the MCP handler', () => {
  it('reaches a real route handler and gets its real answer', async () => {
    authenticateAs('mcp');
    const result = await dispatchInProcess({ method: 'GET', path: '/principals/me', authorization: BEARER });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ success: true, principal: { handle: 'connector_one' } });
  });

  it('carries query strings, path parameters and JSON bodies into the handler', async () => {
    authenticateAs('mcp');
    // Each of these is a production 400 raised by the real handler AFTER
    // routing — so the plumbing that produced it is the production plumbing.
    const query = await dispatchInProcess({
      method: 'GET', path: '/reports', query: { sort: 'nonsense' }, authorization: BEARER,
    });
    expect(query.status).toBe(400);
    expect(query.body).toMatchObject({ code: 'INVALID_SORT' });

    const param = await dispatchInProcess({
      method: 'GET', path: '/reports', query: { taskId: 'not-a-uuid' }, authorization: BEARER,
    });
    expect(param.status).toBe(400);
    expect(param.body).toMatchObject({ code: 'INVALID_TASK_ID' });

    const body = await dispatchInProcess({
      method: 'POST', path: '/reports', body: { title: '', content: '' }, authorization: BEARER,
    });
    expect(body.status).toBe(400);
  });

  it('adds NO authority: the shared ceiling still refuses a scope the credential lacks', async () => {
    // The whole point of dispatching through the routers is that every
    // authorization decision still happens exactly once, in the board's
    // central helper. A credential without principals:read must not gain it
    // by arriving over MCP.
    //
    // The probe was `GET /principals/me` until SETGOV `D-5` moved that route's
    // ceiling to `authenticated` (AZ-A5 clause 9b, accepted by owner ruling
    // `dda2cdcc` §1), at which point it stopped being an example of a
    // scope-gated route and the control would have passed for the wrong
    // reason. `GET /principals` is the same family at the SAME unchanged
    // ceiling, so the control's subject is untouched; the widening it used to
    // ride on is pinned in its own right below.
    authenticateAs('mcp', ['tasks:read']);
    const result = await dispatchInProcess({ method: 'GET', path: '/principals', authorization: BEARER });
    expect(result.status).toBe(403);
  });

  it('SETGOV `D-5`: the two SELF endpoints are reachable at `authenticated`, and only those two', async () => {
    // The declared reachability widening, pinned so it is a decision rather
    // than a surprise: a bearer caller holding neither `principals:read` nor
    // `root` now reaches its OWN principal and its OWN effective access — both
    // disclose the caller to itself and nothing else — while `POST
    // /principals/me/brief` keeps `principals:read` because it discloses Task,
    // Personality and Report content.
    authenticateAs('mcp', ['tasks:read']);
    expect((await dispatchInProcess({ method: 'GET', path: '/principals/me', authorization: BEARER })).status).not.toBe(403);
    expect((await dispatchInProcess({ method: 'POST', path: '/principals/me/brief', authorization: BEARER })).status).toBe(403);
  });

  it('refuses anything that is not an rh_ principal credential', async () => {
    authenticateAs('mcp');
    for (const authorization of ['Bearer not-a-relayhall-key', 'Bearer rh_dev_bad', '']) {
      const result = await dispatchInProcess({ method: 'GET', path: '/principals/me', authorization });
      expect(result.status).toBe(401);
    }
  });
});

describe('direction 2 — the SAME credential over REST refuses (T15)', () => {
  it('answers 403 TRANSPORT_MISMATCH and never reaches a handler', async () => {
    authenticateAs('mcp');
    const rest = await overRest({ authorization: BEARER });
    expect(rest.status).toBe(403);
    expect(rest.body).toMatchObject({ code: 'TRANSPORT_MISMATCH' });
    expect(rest.passed).toBe(false);
  });

  it('and the mirror image: an api-pinned credential is refused through MCP', async () => {
    authenticateAs('api');
    const result = await dispatchInProcess({ method: 'GET', path: '/principals/me', authorization: BEARER });
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ code: 'TRANSPORT_MISMATCH' });
  });

  it('leaves an unpinned credential working on both surfaces', async () => {
    authenticateAs('any');
    expect((await overRest({ authorization: BEARER })).passed).toBe(true);
    expect((await dispatchInProcess({ method: 'GET', path: '/principals/me', authorization: BEARER })).status).toBe(200);
  });
});

describe('direction 3 — forged provenance still classifies api', () => {
  it('ignores every header a caller could use to claim it arrived over MCP', async () => {
    authenticateAs('mcp');
    const forged = {
      authorization: BEARER,
      'x-transport-class': 'mcp',
      'x-relayhall-transport': 'mcp',
      'x-forwarded-transport': 'mcp',
      'mcp-session-id': 'pretend-i-am-a-session',
      'x-clawboard-origin': 'mcp',
      'x-relayhall-origin': 'mcp',
      'x-mcp': 'true',
    };
    const rest = await overRest(forged);
    expect(rest.status).toBe(403);
    expect(rest.body).toMatchObject({ code: 'TRANSPORT_MISMATCH' });
  });

  it('ignores a forged transport claim carried in the body of an MCP call too', async () => {
    // The in-process dispatcher forwards caller-supplied headers, so a tool
    // argument that became a header must not be able to reclassify anything.
    authenticateAs('api');
    const result = await dispatchInProcess({
      method: 'GET', path: '/principals/me', authorization: BEARER,
      headers: { 'x-transport-class': 'api', 'mcp-session-id': 'x' },
    });
    // Still refused: the pin is compared against the ingress's own constant.
    expect(result.status).toBe(403);
  });
});

describe('the credential is the last word on the in-process request', () => {
  it('cannot be replaced by a header a tool supplies', async () => {
    // The dispatcher forwards tool-supplied headers. If one of them could
    // land under `authorization`, a tool argument would become an identity.
    authenticateAs('mcp');
    const seen: string[] = [];
    jest.spyOn(principalService, 'authenticatePrincipalKey').mockImplementation(async (parts) => {
      seen.push(parts.keyId);
      return { principal: principal(), credential: credential('mcp', ['principals:read']) };
    });
    const result = await dispatchInProcess({
      method: 'GET', path: '/principals/me', authorization: BEARER,
      headers: {
        Authorization: 'Bearer rh_dev_notmine.aaaaaaaaaaaaaaaaaaaaaaaa',
        authorization: 'Bearer rh_dev_alsonot.bbbbbbbbbbbbbbbbbbbbbbbb',
        host: 'evil.example',
        'content-length': '999999',
      },
    });
    expect(result.status).toBe(200);
    // Only the caller's own key id was ever authenticated.
    expect(new Set(seen)).toEqual(new Set(['keyid01']));
  });
});

describe('T26 — an unclassified route rejects every non-any pin', () => {
  it('fails closed on a route no family declares', () => {
    expect(routeTransportClassFor('/some-new-surface')).toBeUndefined();
    expect(evaluateTransportPin('mcp', '/some-new-surface', 'mcp')).toEqual({ allowed: false, code: 'TRANSPORT_MISMATCH' });
    expect(evaluateTransportPin('api', '/some-new-surface', 'api')).toEqual({ allowed: false, code: 'TRANSPORT_MISMATCH' });
    // `any` is the only pin an unclassified route serves.
    expect(evaluateTransportPin('any', '/some-new-surface', 'api')).toEqual({ allowed: true });
  });
});

// T28 (rotation inherits the pin verbatim) is proven in
// c4TransportPinRotation.test.ts — it needs a module-wide db mock, which this
// suite must not install because its dispatches run real routers.

describe('the controls fail when what they guard regresses', () => {
  // C2/C3 lesson: a control nobody has broken on purpose is a decoration.
  it('an mcp-pinned credential is refused the moment the ingress stamps api', async () => {
    authenticateAs('mcp');
    const asMcp = {} as AuthRequest;
    expect(await acceptPrincipalKey(asMcp, BEARER, '/principals/me', 'mcp')).toEqual({ kind: 'ok' });

    // The mutation: the same credential, the same route, the wrong stamp.
    const asApi = {} as AuthRequest;
    const denied = await acceptPrincipalKey(asApi, BEARER, '/principals/me', 'api');
    expect(denied).toMatchObject({ kind: 'denied', status: 403 });
    expect(asApi.principal).toBeUndefined();
    expect(asApi.scopes).toBeUndefined();
  });

  it('the /mcp declaration is load-bearing: remove it and the endpoint refuses its own callers', () => {
    // If `/mcp` were not classified, T26 would reject every mcp-pinned
    // credential AT THE DOOR — which is why the row exists.
    expect(evaluateTransportPin('mcp', '/mcp', 'mcp')).toEqual({ allowed: true });
    expect(evaluateTransportPin('mcp', '/mcp-that-does-not-exist', 'mcp')).toEqual({ allowed: false, code: 'TRANSPORT_MISMATCH' });
  });

  it('a revoked credential stops working on the MCP surface immediately', async () => {
    jest.spyOn(principalService, 'authenticatePrincipalKey').mockResolvedValue(undefined);
    const result = await dispatchInProcess({ method: 'GET', path: '/principals/me', authorization: BEARER });
    expect(result.status).toBe(401);
  });
});
