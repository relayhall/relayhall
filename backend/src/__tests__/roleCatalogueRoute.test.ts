/**
 * GET /principals/roles THROUGH THE PRODUCTION CHAIN (card a2d1e317).
 *
 * The route carries no gate of its own: its ceiling is the `/principals`
 * family GET rule (`principals:read`). So the claim to measure is the seam,
 * not the handler: `authMiddleware`, then `sharedAuthorizationMiddleware`, then
 * the real principals router, exactly `server.ts`'s protected composition,
 * with real `rh_` bearer credentials of two scope sets. Only the principal
 * store beneath the chain is a double.
 */
import express from 'express';
import type { AddressInfo } from 'net';
import { requiredScopeFor } from '../utils/scopeMap';
import { roleCatalogue } from '../utils/roleCatalogue';

process.env.JWT_SECRET = 'role-catalogue-suite-secret-0123456789';

const READER = {
  id: '11111111-1111-4111-8111-111111111111', handle: 'catalogue-reader', kind: 'service',
  status: 'active', role: 'viewer', parentPrincipalId: null, legacyIdentity: false,
  displayName: 'Reader', metadata: {},
};
const TASKS_ONLY = {
  id: '22222222-2222-4222-8222-222222222222', handle: 'tasks-only', kind: 'service',
  status: 'active', role: 'agent', parentPrincipalId: null, legacyIdentity: false,
  displayName: 'Tasks only', metadata: {},
};

const READER_KEY = 'rh_dev_aaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TASKS_KEY = 'rh_dev_cccccccccccc.dddddddddddddddddddddddddddddddd';

jest.mock('../services/PrincipalService', () => {
  const actual = jest.requireActual('../services/PrincipalService');
  const real = actual.principalService;
  const stub = Object.create(Object.getPrototypeOf(real));
  const ALL = [READER, TASKS_ONLY];
  Object.assign(stub, real, {
    getPrincipalById: jest.fn(async (id: string) => ALL.find((p) => p.id === id)),
    getPrincipalByIdStrict: jest.fn(async (id: string) => ALL.find((p) => p.id === id)),
    getPrincipalByHandle: jest.fn(async (handle: string) => ALL.find((p) => p.handle === handle)),
    resolveHandle: jest.fn(async (handle: string) => ({ principal: ALL.find((p) => p.handle === handle), degraded: false })),
    authenticatePrincipalKey: jest.fn(async (parts: { keyId?: string }) => {
      if (parts?.keyId === 'aaaaaaaaaaaa') {
        return { principal: READER, credential: { id: 'cred-reader', scopes: ['principals:read'], transport: 'any' } };
      }
      if (parts?.keyId === 'cccccccccccc') {
        return { principal: TASKS_ONLY, credential: { id: 'cred-tasks', scopes: ['tasks:read'], transport: 'any' } };
      }
      return undefined;
    }),
    isLegacyEnvKeyRevoked: jest.fn(async () => false),
    bumpCredentialLastUsed: jest.fn(),
    bumpLastSeen: jest.fn(),
    cachePrincipal: jest.fn(),
  });
  return { ...actual, principalService: stub };
});

jest.mock('../services/AuditService', () => {
  const actual = jest.requireActual('../services/AuditService');
  return { ...actual, auditService: { record: jest.fn(async (write: unknown) => write), list: jest.fn() } };
});

jest.mock('../db/connection', () => ({
  pool: {
    query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
    connect: jest.fn(async () => ({ query: jest.fn(async () => ({ rows: [], rowCount: 0 })), release: jest.fn() })),
  },
  BOOT_CHECK_MODE: false,
}));

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
  app.use('/principals', authMiddleware, sharedAuthorizationMiddleware, principalsRouter);
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});
afterAll((done) => { server.close(() => done()); });

async function getRoles(key?: string) {
  const response = await fetch(`${base}/principals/roles`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });
  const text = await response.text();
  let body: any;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return { status: response.status, body };
}

describe('GET /principals/roles', () => {
  it('rides the /principals family read ceiling', () => {
    expect(requiredScopeFor('GET', '/principals/roles')).toBe('principals:read');
  });

  it('an unauthenticated call is 401 (the chain really runs)', async () => {
    const { status, body } = await getRoles();
    expect(status).toBe(401);
    expect(body?.roles).toBeUndefined();
  });

  it('a credential without principals:read is refused by the ceiling', async () => {
    const { status, body } = await getRoles(TASKS_KEY);
    expect(status).toBe(403);
    expect(body?.roles).toBeUndefined();
  });

  it('a principals:read credential gets the whole catalogue, exactly as the module builds it', async () => {
    const { status, body } = await getRoles(READER_KEY);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.roles).toEqual(JSON.parse(JSON.stringify(roleCatalogue())));
    expect(body.roles).toHaveLength(9);
  });

  it('is not shadowed by a path-id route: "roles" never reaches a principal lookup', async () => {
    const { principalService } = jest.requireMock('../services/PrincipalService');
    principalService.getPrincipalById.mockClear();
    await getRoles(READER_KEY);
    expect(principalService.getPrincipalById).not.toHaveBeenCalledWith('roles');
  });
});
