/**
 * The AUTHENTICATED reach of `POST /telemetry/events/batch`, with the real auth
 * chain executed (RH-TW1a candidate B; review `fc4829d2` R3-M3 / F5.1).
 *
 * WHY THIS SUITE EXISTS. The endpoint suite next door stamps `req.principal`
 * and `req.scopes` itself and mounts the router directly. That is right for
 * what it tests, but it means its batch-404 case would return 404 identically
 * with no identity, no scope, or a broken authorization mount — so it did not
 * prove an *authenticated* 404. As the reviewer put it, the defect was the
 * proof, not the route behaviour.
 *
 * Here the production middleware really runs: `authMiddleware` then
 * `sharedAuthorizationMiddleware`, exactly as `server.ts`'s `protectedRouter`
 * composes them. Only the credential store beneath them is a double, so the
 * scope map, the transport pin and the authorization decision are the real
 * ones.
 *
 * THE CONTROL IS THE POINT: a bad credential must yield **401**, not 404. A
 * 404 for an unauthenticated caller would mean the chain never ran and this
 * suite proves nothing.
 */
import express from 'express';
import type { AddressInfo } from 'net';

// `parsePrincipalKey` accepts rh_(live|dev)_<keyId>.<secret> (PrincipalService.ts:84).
const GOOD_KEY = 'rh_dev_aaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BAD_KEY = 'rh_dev_cccccccccccc.dddddddddddddddddddddddddddddddd';

/** Scopes the authenticated credential carries; a test may narrow them. */
const credentialScopes = { value: ['telemetry:write'] as string[] };

// Spread the REAL module and override only what this suite must control.
// Replacing the module wholesale drops every sibling export and method the
// middleware also calls — which showed up here as a TypeError surfacing as a
// 500, not as an obvious missing-mock error.
jest.mock('../services/PrincipalService', () => {
  const actual = jest.requireActual('../services/PrincipalService');
  const real = actual.principalService;
  const stub = Object.create(Object.getPrototypeOf(real));
  Object.assign(stub, real, {
    authenticatePrincipalKey: jest.fn(async (parts: { keyId?: string }) => (
      parts?.keyId === 'aaaaaaaaaaaa'
        ? {
          principal: {
            id: '00000000-0000-4000-8000-0000000c0nn3', handle: 'outpost-1', kind: 'service',
            legacyIdentity: false, parentPrincipalId: null, status: 'active', role: null,
          },
          credential: { id: 'cred-1', scopes: credentialScopes.value, transport: 'any' },
        }
        : undefined)),
    isLegacyEnvKeyRevoked: jest.fn(async () => false),
    bumpCredentialLastUsed: jest.fn(),
  });
  return { ...actual, principalService: stub };
});

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(async () => ({ rows: [], rowCount: 0 })), connect: jest.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { authMiddleware } = require('../middleware/auth');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const telemetryRouter = require('../routes/telemetry').default;

let server: ReturnType<typeof express.application.listen>;
let base: string;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  // Exactly `server.ts`'s protectedRouter composition.
  app.use('/telemetry', authMiddleware, sharedAuthorizationMiddleware, telemetryRouter);
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});
afterAll((done) => { server.close(() => done()); });
beforeEach(() => { credentialScopes.value = ['telemetry:write']; });

const post = async (path: string, key?: string) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ probe: true }),
  });
  return { status: res.status, body: await res.text() };
};

describe('the batch endpoint is reached THROUGH the real auth chain', () => {
  // Candidate B proved this route was reached at all, by asserting an
  // AUTHENTICATED 404 on a deliberately handler-less path (review `fc4829d2`,
  // R3-M3). Candidate C ships the handler, so the 404 is gone — but the
  // property that mattered was never the status code. It was that the request
  // travels the whole chain, and the controls below are what establish that:
  // change the credential and the answer changes with it.
  it('an AUTHENTICATED telemetry:write caller REACHES the handler', async () => {
    const { status, body } = await post('/telemetry/events/batch', GOOD_KEY);
    // The handler runs and refuses this particular caller for a reason only IT
    // knows — the acting principal is not a registry Connector (§4.1/§5.1). So
    // the STATUS is not the evidence here (it is 403, exactly as an
    // authorization refusal would be); the CODE is, because no middleware can
    // produce it. Compare with the scope control below, which is also 403 and
    // carries no telemetry code at all.
    expect(status).not.toBe(404);
    expect(JSON.parse(body).code).toBe('TELEMETRY_PRINCIPAL_NO_CONNECTOR');
  });

  it('CONTROL: a BAD credential gets 401, and never reaches the handler', async () => {
    // If this were the handler's own answer the chain never ran, and the
    // assertion above would be true of an unauthenticated stranger too.
    const { status } = await post('/telemetry/events/batch', BAD_KEY);
    expect(status).toBe(401);
  });

  it('CONTROL: no credential at all gets 401', async () => {
    const { status } = await post('/telemetry/events/batch');
    expect(status).toBe(401);
  });

  it('CONTROL: an authenticated caller WITHOUT telemetry:write is refused', async () => {
    // The scope map must actually gate this path. A route that answered
    // everyone would pass the first assertion by accident.
    credentialScopes.value = ['tasks:read'];
    const { status, body } = await post('/telemetry/events/batch', GOOD_KEY);
    expect(status).toBe(403);
    // …and this 403 is the MIDDLEWARE's, not the handler's: the request never
    // reached code that could name a telemetry refusal.
    expect(JSON.parse(body).code).not.toBe('TELEMETRY_PRINCIPAL_NO_CONNECTOR');
  });

  it('CONTROL: the router IS mounted — /telemetry/events is handled, not 404', async () => {
    // A 404 above must mean "no handler for batch", not "no router".
    const { status } = await post('/telemetry/events', GOOD_KEY);
    expect(status).not.toBe(404);
  });
});
