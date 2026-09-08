/**
 * THE ROLE-CHANGE ACT, driven THROUGH THE PRODUCTION CHAIN
 * (owner ruling `60307311` §1.2; card `27322abb`).
 *
 * WHY THE WHOLE CHAIN. The act's central claim is about the SEAM, not about a
 * function: "this request arrived on a login session and presents no bearer
 * credential" is decided from `req.authMethod`, which only `authMiddleware`
 * writes. A suite that stamped `req.authMethod` itself and called the handler
 * would be asking the classification to check itself, and would pass just as
 * happily with the guard deleted from the route. So this suite mounts
 * `authMiddleware` then `sharedAuthorizationMiddleware` then the real
 * principals router — exactly `server.ts`'s `protectedRouter` composition —
 * and every caller below authenticates with a REAL credential of its kind: a
 * signed dashboard JWT, a session cookie resolved by the session store, or an
 * `rh_` principal key parsed and authenticated by the credential path.
 *
 * Only the stores beneath the chain are doubles. The scope map, the route
 * ceiling, the transport pin, the authentication-kind classification and the
 * act's own bounds are the production ones.
 *
 * THE VACUITY CONTROL comes first: an unauthenticated call must be 401. If it
 * were not, the chain would not be running and nothing below would mean
 * anything.
 */
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';

const JWT_SECRET = 'role-act-suite-secret-0123456789';
process.env.JWT_SECRET = JWT_SECRET;
// The session substrate is what makes a cookie an identity (middleware/auth
// step 6). Every deployment this act ships to runs with it on; a suite that
// left it off would be testing the flag, not the act.
process.env.RELAYHALL_SESSIONS = 'on';

const ADMIN = {
  id: '11111111-1111-4111-8111-111111111111', handle: 'ada', kind: 'human',
  status: 'active', role: 'admin', parentPrincipalId: null, legacyIdentity: false,
  displayName: 'Ada', metadata: {},
};
const OPERATOR = {
  id: '22222222-2222-4222-8222-222222222222', handle: 'olive', kind: 'human',
  status: 'active', role: 'operator', parentPrincipalId: null, legacyIdentity: false,
  displayName: 'Olive', metadata: {},
};
const ORDINARY = {
  id: '33333333-3333-4333-8333-333333333333', handle: 'ulrich', kind: 'human',
  status: 'active', role: 'user', parentPrincipalId: null, legacyIdentity: false,
  displayName: 'Ulrich', metadata: {},
};
const TARGET = {
  id: '44444444-4444-4444-8444-444444444444', handle: 'tessa', kind: 'human',
  status: 'active', role: 'viewer', parentPrincipalId: null, legacyIdentity: false,
  displayName: 'Tessa', metadata: {},
};
/** A parentless legacy SERVICE row — the shape that holds `rh_` bearer keys. */
const LEGACY_SERVICE = {
  id: '55555555-5555-4555-8555-555555555555', handle: 'service_account', kind: 'service',
  status: 'active', role: 'agent', parentPrincipalId: null, legacyIdentity: true,
  displayName: 'Legacy shared API key', metadata: {},
};
/** The break-glass identity, seeded `orchestrator` by migration 062. */
const LOCAL_ADMIN = {
  id: '66666666-6666-4666-8666-666666666666', handle: 'dashboard_user', kind: 'human',
  status: 'active', role: 'orchestrator', parentPrincipalId: null, legacyIdentity: false,
  displayName: 'Owner', metadata: {},
};
const SYSTEM = {
  id: '77777777-7777-4777-8777-777777777777', handle: 'system', kind: 'service',
  status: 'active', role: null, parentPrincipalId: null, legacyIdentity: true,
  displayName: 'internal', metadata: {},
};
/** A Connector holding a ROOT-scoped `rh_` key — the strongest bearer there is. */
const CONNECTOR = {
  id: '88888888-8888-4888-8888-888888888888', handle: 'connector-1', kind: 'service',
  status: 'active', role: 'admin', parentPrincipalId: null, legacyIdentity: true,
  displayName: 'Connector', metadata: {},
};

const ALL = [ADMIN, OPERATOR, ORDINARY, TARGET, LEGACY_SERVICE, LOCAL_ADMIN, SYSTEM, CONNECTOR];

/** Role writes land here so a case can read back what the route asked for. */
const roleWrites: Array<{ id: string; role: string }> = [];
/** Every audit row the act wrote, in order. */
const auditRows: Array<Record<string, any>> = [];
/** Session id -> principal id, for the cookie arm. */
const sessions: Record<string, string> = {
  'session-admin': ADMIN.id,
  'session-operator': OPERATOR.id,
  'session-ordinary': ORDINARY.id,
};

const ROOT_KEY = 'rh_dev_aaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

jest.mock('../services/PrincipalService', () => {
  const actual = jest.requireActual('../services/PrincipalService');
  const real = actual.principalService;
  const stub = Object.create(Object.getPrototypeOf(real));
  const find = (id: string) => ALL.find((p) => p.id === id);
  Object.assign(stub, real, {
    getPrincipalById: jest.fn(async (id: string) => find(id)),
    getPrincipalByHandle: jest.fn(async (handle: string) => ALL.find((p) => p.handle === handle)),
    resolveHandle: jest.fn(async (handle: string) => ({
      principal: ALL.find((p) => p.handle === handle), degraded: false,
    })),
    updatePrincipal: jest.fn(async (id: string, updates: { role?: string }) => {
      const found = find(id);
      if (!found) return undefined;
      if (updates.role !== undefined) roleWrites.push({ id, role: updates.role });
      return { ...found, ...(updates.role !== undefined ? { role: updates.role } : {}) };
    }),
    authenticatePrincipalKey: jest.fn(async (parts: { keyId?: string }) => (
      parts?.keyId === 'aaaaaaaaaaaa'
        ? { principal: CONNECTOR, credential: { id: 'cred-root', scopes: ['root'], transport: 'any' } }
        : undefined)),
    isLegacyEnvKeyRevoked: jest.fn(async () => false),
    bumpCredentialLastUsed: jest.fn(),
    bumpLastSeen: jest.fn(),
    // The route publishes the committed row into the read caches. With a
    // doubled directory there is nothing to publish, and letting the real
    // method run would leak this suite's fixtures into the process-wide cache.
    cachePrincipal: jest.fn(),
  });
  return { ...actual, principalService: stub };
});

jest.mock('../services/LoginSessionService', () => {
  const actual = jest.requireActual('../services/LoginSessionService');
  return {
    ...actual,
    loginSessionService: {
      resolve: jest.fn(async (token: string) => (
        sessions[token] ? { sessionId: token, principalId: sessions[token], roleSnapshot: null } : undefined)),
      touch: jest.fn(),
    },
  };
});

jest.mock('../services/AuditService', () => {
  const actual = jest.requireActual('../services/AuditService');
  return {
    ...actual,
    auditService: {
      record: jest.fn(async (write: Record<string, any>) => { auditRows.push(write); return write; }),
      list: jest.fn(async () => ({ events: [], nextCursor: null })),
    },
  };
});

/**
 * The act now runs its write and its audit row inside ONE transaction (review
 * verdict `2c284891` B2), so `pool.connect()` has to answer with a usable
 * client here. It records nothing: WHICH connection each statement went down is
 * the question `roleChangeAtomicity.test.ts` was written to ask, with the real
 * service and the real audit writer. This suite is about WHO may act and WHAT
 * they may assign, and its doubled service performs no SQL at all.
 */
jest.mock('../db/connection', () => {
  const transactionClient = {
    query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
    release: jest.fn(),
  };
  return {
    pool: {
      query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
      connect: jest.fn(async () => transactionClient),
    },
    BOOT_CHECK_MODE: false,
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { authMiddleware } = require('../middleware/auth');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const principalsRouter = require('../routes/principals').default;

let server: ReturnType<typeof express.application.listen>;
let base: string;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  // Exactly `server.ts`'s protectedRouter composition.
  app.use('/principals', authMiddleware, sharedAuthorizationMiddleware, principalsRouter);
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});
afterAll((done) => { server.close(() => done()); });
beforeEach(() => { roleWrites.length = 0; auditRows.length = 0; });

/** A real v2 dashboard JWT for one of the fixtures. */
function dashboardJwt(principal: { id: string; handle: string; kind: string }): string {
  return jwt.sign(
    { v: 2, sub: principal.id, handle: principal.handle, kind: principal.kind },
    JWT_SECRET, { expiresIn: '1h' },
  );
}

type Caller =
  | { via: 'jwt'; principal: typeof ADMIN }
  | { via: 'cookie'; session: string }
  | { via: 'bearer'; key: string }
  | { via: 'none' };

async function changeRole(caller: Caller, targetId: string, role: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (caller.via === 'jwt') headers.authorization = `Bearer ${dashboardJwt(caller.principal)}`;
  if (caller.via === 'bearer') headers.authorization = `Bearer ${caller.key}`;
  if (caller.via === 'cookie') headers.cookie = `relayhall_session=${caller.session}`;
  const response = await fetch(`${base}/principals/${targetId}/role`, {
    method: 'POST', headers, body: JSON.stringify({ role }),
  });
  const text = await response.text();
  let body: any;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return { status: response.status, body };
}

/** The refusal rows the act wrote, for the audit assertions. */
const refusals = () => auditRows.filter((row) => row.outcome === 'denied');

describe('the chain really runs (vacuity controls)', () => {
  it('an unauthenticated call is 401, not a refusal from the handler', async () => {
    const { status, body } = await changeRole({ via: 'none' }, TARGET.id, 'editor');
    expect(status).toBe(401);
    // A handler refusal would carry one of the act's codes. None can appear
    // here, because the request never reached the handler.
    expect(body?.code).toBeUndefined();
    expect(roleWrites).toEqual([]);
  });

  it('an ADMIN session reaches the handler and the write happens', async () => {
    const { status, body } = await changeRole({ via: 'cookie', session: 'session-admin' }, TARGET.id, 'editor');
    expect(status).toBe(200);
    expect(roleWrites).toEqual([{ id: TARGET.id, role: 'editor' }]);
    expect(body.previousRole).toBe('viewer');
    expect(body.principal.role).toBe('editor');
  });
});

describe('WHO may act — the login-session classification, across the seam', () => {
  it('a ROOT-SCOPED rh_ bearer credential is REFUSED BY NAME', async () => {
    const { status, body } = await changeRole({ via: 'bearer', key: ROOT_KEY }, TARGET.id, 'editor');
    expect(status).toBe(403);
    expect(body.code).toBe('ROLE_ACT_REQUIRES_SESSION');
    expect(roleWrites).toEqual([]);
  });

  it('...and that bearer credential is NOT merely unauthorized — it authenticates fine', async () => {
    // The control that makes the case above mean something. The same
    // credential, on a route the same chain admits it to, succeeds — so the
    // 403 above is the ACT's refusal of a bearer credential, not the chain
    // failing to authenticate one.
    const response = await fetch(`${base}/principals`, {
      headers: { authorization: `Bearer ${ROOT_KEY}` },
    });
    expect(response.status).toBe(200);
  });

  it('a dashboard JWT (the break-glass door credential) IS a login session', async () => {
    const { status } = await changeRole({ via: 'jwt', principal: ADMIN }, TARGET.id, 'editor');
    expect(status).toBe(200);
  });

  it('a session cookie IS a login session', async () => {
    const { status } = await changeRole({ via: 'cookie', session: 'session-admin' }, TARGET.id, 'qa');
    expect(status).toBe(200);
  });

  it('an ORDINARY user session is refused as not an administrator', async () => {
    const { status } = await changeRole({ via: 'cookie', session: 'session-ordinary' }, TARGET.id, 'admin');
    // The route ceiling refuses `user` before the handler is reached — the
    // scope map puts every /principals write behind principals:admin, which
    // `scopesForRole('user')` does not derive. Either way the write does not
    // happen; asserting the write is what this case is for.
    expect(status).toBe(403);
    expect(roleWrites).toEqual([]);
  });
});

describe('WHAT may be assigned — the non-escalation bound', () => {
  it('an OPERATOR cannot mint an admin', async () => {
    const { status, body } = await changeRole({ via: 'cookie', session: 'session-operator' }, TARGET.id, 'admin');
    expect(status).toBe(403);
    expect(body.code).toBe('ROLE_ABOVE_YOUR_AUTHORITY');
    expect(roleWrites).toEqual([]);
  });

  it('an OPERATOR cannot mint an orchestrator either — the other root-deriving role', async () => {
    const { status, body } = await changeRole({ via: 'cookie', session: 'session-operator' }, TARGET.id, 'orchestrator');
    expect(status).toBe(403);
    expect(body.code).toBe('ROLE_ABOVE_YOUR_AUTHORITY');
  });

  it('an OPERATOR can assign an ordinary role — the bound is a ceiling, not a lockout', async () => {
    const { status } = await changeRole({ via: 'cookie', session: 'session-operator' }, TARGET.id, 'editor');
    expect(status).toBe(200);
    expect(roleWrites).toEqual([{ id: TARGET.id, role: 'editor' }]);
  });

  it('an ADMIN may assign admin — the same bound, from above it', async () => {
    const { status } = await changeRole({ via: 'cookie', session: 'session-admin' }, TARGET.id, 'admin');
    expect(status).toBe(200);
    expect(roleWrites).toEqual([{ id: TARGET.id, role: 'admin' }]);
  });

  it('`root` is refused as a role — it is a SCOPE sentinel and not a role at all', async () => {
    const { status, body } = await changeRole({ via: 'cookie', session: 'session-admin' }, TARGET.id, 'root');
    expect(status).toBe(400);
    expect(body.code).toBe('UNKNOWN_ROLE');
    expect(roleWrites).toEqual([]);
  });

  it('a non-string role is refused rather than coerced', async () => {
    const { status, body } = await changeRole({ via: 'cookie', session: 'session-admin' }, TARGET.id, { toString: 'admin' });
    expect(status).toBe(400);
    expect(body.code).toBe('ROLE_REQUIRED');
    expect(roleWrites).toEqual([]);
  });
});

describe('WHOM it may be assigned to', () => {
  it('an administrator cannot change their OWN row', async () => {
    const { status, body } = await changeRole({ via: 'cookie', session: 'session-admin' }, ADMIN.id, 'operator');
    expect(status).toBe(403);
    expect(body.code).toBe('SELF_ROLE_CHANGE_REFUSED');
    expect(roleWrites).toEqual([]);
  });

  it('the break-glass local administrator keeps its role', async () => {
    const { status, body } = await changeRole({ via: 'cookie', session: 'session-admin' }, LOCAL_ADMIN.id, 'viewer');
    expect(status).toBe(422);
    expect(body.code).toBe('LOCAL_ADMINISTRATOR_ROLE_FIXED');
    expect(roleWrites).toEqual([]);
  });

  it('the internal `system` actor carries no assignable role', async () => {
    const { status, body } = await changeRole({ via: 'cookie', session: 'session-admin' }, SYSTEM.id, 'agent');
    expect(status).toBe(422);
    expect(body.code).toBe('PRINCIPAL_REFUSES_ROLE_CHANGE');
    expect(roleWrites).toEqual([]);
  });

  it('a legacy SERVICE row cannot be promoted to admin — the bearer-key escalation', async () => {
    // The path this refusal closes: `service_account` holds rh_ keys, and
    // `scopesForRole('admin')` is the root sentinel, so promoting it would hand
    // every one of those bearer keys owner authority on its next request.
    const { status, body } = await changeRole({ via: 'cookie', session: 'session-admin' }, LEGACY_SERVICE.id, 'admin');
    expect(status).toBe(422);
    expect(body.code).toBe('ELEVATED_ROLE_REQUIRES_ACCOUNT');
    expect(roleWrites).toEqual([]);
  });

  it('...but an ordinary role on that same service row is allowed', async () => {
    // The control for the case above: the refusal is about the ROLE being
    // elevated, not about the target being a service. A refusal that fired on
    // every service row would pass the case above while meaning something else.
    const { status } = await changeRole({ via: 'cookie', session: 'session-admin' }, LEGACY_SERVICE.id, 'agent');
    expect(status).toBe(200);
    expect(roleWrites).toEqual([{ id: LEGACY_SERVICE.id, role: 'agent' }]);
  });

  it('an unknown principal is 404 and a malformed id is 404 too', async () => {
    const missing = await changeRole({ via: 'cookie', session: 'session-admin' }, '99999999-9999-4999-8999-999999999999', 'editor');
    expect(missing.status).toBe(404);
    const malformed = await changeRole({ via: 'cookie', session: 'session-admin' }, 'not-a-uuid', 'editor');
    expect(malformed.status).toBe(404);
    expect(roleWrites).toEqual([]);
  });
});

describe('the ledger', () => {
  it('a successful change records actor, target, before, after and the seam', async () => {
    await changeRole({ via: 'cookie', session: 'session-admin' }, TARGET.id, 'editor');
    const row = auditRows.find((r) => r.action === 'principal.role.changed' && r.outcome !== 'denied');
    expect(row).toBeDefined();
    expect(row!.actor.principalId).toBe(ADMIN.id);
    expect(row!.actor.authMethod).toBe('session');
    expect(row!.resourceId).toBe(TARGET.id);
    expect(row!.metadata).toMatchObject({
      targetHandle: TARGET.handle,
      before: 'viewer',
      after: 'editor',
      issuerRole: 'admin',
      seam: 'POST /principals/:id/role',
    });
  });

  it('every refusal is recorded too, naming its reason', async () => {
    await changeRole({ via: 'bearer', key: ROOT_KEY }, TARGET.id, 'admin');
    const denied = refusals();
    expect(denied).toHaveLength(1);
    expect(denied[0].action).toBe('principal.role.changed');
    expect(denied[0].metadata.refusal).toBe('ROLE_ACT_REQUIRES_SESSION');
    expect(denied[0].metadata.requestedRole).toBe('admin');
  });

  it('a refused attempt writes NO success row — the control for the pair above', async () => {
    await changeRole({ via: 'cookie', session: 'session-operator' }, TARGET.id, 'admin');
    expect(auditRows.filter((r) => r.outcome !== 'denied')).toEqual([]);
  });
});

describe('what the caller is told about when it takes effect', () => {
  it('the response says NEXT REQUEST, not next login', async () => {
    const { body } = await changeRole({ via: 'cookie', session: 'session-admin' }, TARGET.id, 'editor');
    // `auth_sessions.role_snapshot` has no writer in this tree, so
    // `resolveActorRole` falls through to `principals.role` for every live
    // session. Saying "at next login" would be false, and this pins the
    // sentence to the substrate rather than to a guess.
    expect(body.effectiveFrom).toBe('next-request');
    expect(body.note).toContain('no re-login');
  });
});
