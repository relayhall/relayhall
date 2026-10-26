/**
 * Card bc847bd0 (owner ruling E159, "refuse names"): the two guards that live
 * in the shared authorization stage, measured on the stage itself with every
 * read it could make replaced by a spy that fails the way an unreachable
 * database does.
 *
 *   1. A Project is addressed by its id. A path Project id that is not a full
 *      UUID is refused 400 INVALID_PROJECT_ID BEFORE ANY READ: the point stage
 *      would resolve a Project NAME, and the owner paths read the Project
 *      before the route ceiling. A caller the route ceiling refuses outright
 *      keeps its 403, which reads nothing either.
 *   2. The account-owner arm compares uuid columns, so it does not read for an
 *      identifier that is not a full UUID (on main it threw 22P02 and every
 *      admin-action Task, Phase, Report and Project route answered 503).
 *
 * The live census (nonUuidPathIdLive.test.ts) drives the same guards through
 * the production routers over a real PostgreSQL; this suite is the fast-tier
 * twin that says WHICH reads did not happen.
 */
import express from 'express';

import { pool } from '../db/connection';
import { sharedAuthorizationMiddleware } from '../middleware/sharedAuthorization';
import { authorizationRepository } from '../services/AuthorizationRepository';
import { projectOwnershipService } from '../services/ProjectOwnershipService';
import { accessSurfaceService } from '../services/AccessSurfaceService';
import { scopesForRole } from '../utils/identityScopes';
import { auditService } from '../services/AuditService';

const PROJECT_ID = '4f1c2b3a-5d6e-4f70-8a9b-0c1d2e3f4a50';
const TASK_ID = '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c90';
const PROJECT_NAME = 'RelayHall';

interface Identity { userId: string; principal: Record<string, unknown>; scopes: string[]; authMethod: string; sessionId?: string; credentialId?: string }
const ROOT: Identity = {
  userId: 'stage-root', principal: { id: '1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c50', kind: 'human', role: 'admin' },
  scopes: ['root'], authMethod: 'session', sessionId: 'session-root',
};
const ACCOUNT: Identity = {
  userId: 'stage-user', principal: { id: '2c3d4e5f-6a70-4b8c-9d0e-1f2a3b4c5d60', kind: 'human', role: 'user' },
  scopes: scopesForRole('user'), authMethod: 'session', sessionId: 'session-user',
};
const NARROW: Identity = {
  userId: 'stage-narrow', principal: { id: '3d4e5f6a-7b80-4c9d-8e0f-2a3b4c5d6e70', kind: 'service', role: 'agent' },
  scopes: ['tasks:read'], authMethod: 'principal_api_key', credentialId: '4e5f6a7b-8c90-4d0e-9f1a-3b4c5d6e7f80',
};

let reads: Record<string, jest.SpyInstance>;

beforeEach(() => {
  jest.restoreAllMocks();
  // Refused Skill writes now emit an audit row; business reads remain unreachable.
  jest.spyOn(auditService, 'record').mockResolvedValue({} as never);
  const unreachable = (name: string) => () => { throw Object.assign(new Error(`${name}: the database is unreachable`), { code: 'ECONNREFUSED' }); };
  reads = {
    authorizePoint: jest.spyOn(authorizationRepository, 'authorizePoint').mockImplementation(async () => ({ exists: true, allowed: true, concealed: false } as never)),
    authorizedIds: jest.spyOn(authorizationRepository, 'authorizedIds').mockImplementation(unreachable('authorizedIds') as never),
    connect: jest.spyOn(pool, 'connect').mockImplementation(unreachable('pool.connect') as never),
    query: jest.spyOn(pool, 'query').mockImplementation(unreachable('pool.query') as never),
    ownerAccess: jest.spyOn(projectOwnershipService, 'access').mockImplementation(unreachable('projectOwnershipService.access') as never),
    surfaces: jest.spyOn(accessSurfaceService, 'listSurfaces').mockImplementation(unreachable('listSurfaces') as never),
  };
});

afterAll(() => {
  jest.restoreAllMocks();
});

function readsMade(): string[] {
  return Object.entries(reads).filter(([, spy]) => spy.mock.calls.length > 0).map(([name]) => name);
}

async function through(identity: Identity, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, identity); next(); });
  for (const mount of ['/projects', '/tasks', '/services', '/personalities']) {
    app.use(mount, sharedAuthorizationMiddleware, (_req: express.Request, res: express.Response) => { res.json({ reached: true }); });
  }
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {} };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('a Project is addressed by its id: refused by shape before any read', () => {
  it.each([
    ['GET', `/projects/${PROJECT_NAME}`],
    ['PATCH', `/projects/${PROJECT_NAME}`],
    ['GET', '/projects/not-a-uuid/resources'],
    ['GET', `/projects/${PROJECT_ID.slice(0, 8)}/charter`],
    ['DELETE', `/projects/${PROJECT_NAME}/skills/${TASK_ID}`],
    ['PUT', `/projects/${PROJECT_NAME}/owner`],
    ['GET', `/projects/${PROJECT_NAME}/owner-access`],
  ])('root %s %s answers 400 INVALID_PROJECT_ID and reads nothing', async (method, path) => {
    const answer = await through(ROOT, method, path, method === 'GET' || method === 'DELETE' ? undefined : {});
    expect([answer.status, answer.body.code, answer.body.error]).toEqual([400, 'INVALID_PROJECT_ID', 'project id must be a full UUID']);
    expect(readsMade()).toEqual([]);
  });

  it('an Account the owner-change path could admit only by reading the Project is refused by the shape alone', async () => {
    const answer = await through(ACCOUNT, 'PUT', `/projects/${PROJECT_NAME}/owner`, { ownerPrincipalId: null });
    expect([answer.status, answer.body.code]).toEqual([400, 'INVALID_PROJECT_ID']);
    expect(readsMade()).toEqual([]);
  });

  it('a caller the route ceiling refuses outright keeps its 403, and nothing is read for it either', async () => {
    for (const path of [`/projects/${PROJECT_NAME}`, `/projects/${PROJECT_ID}`]) {
      const answer = await through(NARROW, 'GET', path);
      expect([answer.status, answer.body.code]).toEqual([403, 'FORBIDDEN']);
    }
    expect(readsMade()).toEqual([]);
  });

  it('a Project UUID, in either case, and the collection routes reach the stage exactly as before', async () => {
    for (const id of [PROJECT_ID, PROJECT_ID.toUpperCase()]) {
      const answer = await through(ROOT, 'GET', `/projects/${id}`);
      expect(answer).toEqual({ status: 200, body: { reached: true } });
    }
    expect(reads.authorizePoint.mock.calls.map((call) => call[2])).toEqual([PROJECT_ID, PROJECT_ID.toUpperCase()]);
    expect(await through(ROOT, 'GET', '/projects/stats/distribution')).toEqual({ status: 200, body: { reached: true } });
  });
});

// R1 report92969321: these are Express defaults, so the authorization-stage
// guard must recognize them too, without folding an identifier's spelling.
describe('R1 reviewer reproduction', () => {
  it.each([
    ['GET', '/SERVICES/relayhall/descriptor/versions/99999999999', 'INVALID_QUERY_VALUE'],
    ['GET', '/services/relayhall/descriptor/versions/99999999999/', 'INVALID_QUERY_VALUE'],
    ['PATCH', '/PERSONALITIES/not-a-uuid', 'INVALID_PERSONALITY_ID'],
    ['DELETE', '/personalities/not-a-uuid/', 'INVALID_PERSONALITY_ID'],
  ])('%s %s refuses before point read', async (method, path, code) => {
    const answer = await through(ROOT, method, path, method === 'GET' ? undefined : {});
    expect([answer.status, answer.body.code]).toEqual([400, code]);
    expect(readsMade()).toEqual([]);
  });
});

const ABSENT_ID = 'abcd1234-abcd-4abc-8abc-abcdef123456';
const MALFORMED_NAMES = ['not-a-uuid', 'relayhall-release-review', '*', '%25'];
const SERVICE_SPELLINGS = [
  ['canonical', 'services', 'descriptor', 'versions', 'retire', ''],
  ['upper mount', 'SERVICES', 'descriptor', 'versions', 'retire', ''],
  ['upper fixed tail', 'services', 'DESCRIPTOR', 'VERSIONS', 'RETIRE', ''],
  ['mixed words', 'SeRvIcEs', 'DeScRiPtOr', 'VeRsIoNs', 'ReTiRe', ''],
  ['trailing slash', 'services', 'descriptor', 'versions', 'retire', '/'],
  ['upper and slash', 'SERVICES', 'DESCRIPTOR', 'VERSIONS', 'RETIRE', '/'],
];
describe.each(['GET', 'POST'])('R1 spelling variants services %s', (method) => {
  describe.each(SERVICE_SPELLINGS)('%s', (_label, mount, descriptor, versions, retire, slash) => {
    const path = (id: string, version: string) => `/${mount}/${id}/${descriptor}/${versions}/${version}${method === 'POST' ? '/' + retire : ''}${slash}`;
    it.each(['latest', '-1', '2147483648', '99999999999'])('malformed %p is refused without point lookup', async (bad) => {
      const answer = await through(ROOT, method, path('ServiceCase', bad), method === 'GET' ? undefined : {});
      expect([answer.status, answer.body.code]).toEqual([400, 'INVALID_QUERY_VALUE']);
      expect(readsMade()).toEqual([]);
    });
    it('authority remains403 before malformed-value refusal', async () => {
      const answer = await through(NARROW, method, path('ServiceCase', '99999999999'), method === 'GET' ? undefined : {});
      expect(answer.status).toBe(403);
      expect(readsMade()).toEqual([]);
    });
    it('valid Version preserves uppercase Service UUID bytes at point lookup', async () => {
      const id = PROJECT_ID.toUpperCase();
      expect((await through(ROOT, method, path(id, '1'), method === 'GET' ? undefined : {})).status).toBe(200);
      expect(reads.authorizePoint.mock.calls[0][2]).toBe(id);
    });
    it('unknown Service UUID retains404 for an in-range Version', async () => {
      reads.authorizePoint.mockResolvedValue({ exists: false, allowed: false, concealed: true });
      expect((await through(ROOT, method, path(ABSENT_ID, '2147483647'), method === 'GET' ? undefined : {})).status).toBe(404);
      expect(reads.authorizePoint.mock.calls[0][2]).toBe(ABSENT_ID);
    });
  });
});

const PERSONALITY_SPELLINGS = [
  ['canonical', 'personalities', ''], ['upper mount', 'PERSONALITIES', ''],
  ['mixed words', 'PeRsOnAlItIeS', ''], ['trailing slash', 'personalities', '/'],
  ['upper and slash', 'PERSONALITIES', '/'],
];
describe.each(['PATCH', 'DELETE'])('R1 spelling variants personalities %s', (method) => {
  describe.each(PERSONALITY_SPELLINGS)('%s', (_label, mount, slash) => {
    const path = (id: string) => `/${mount}/${id}${slash}`;
    it.each(MALFORMED_NAMES)('malformed %p is refused without point lookup', async (bad) => {
      const answer = await through(ROOT, method, path(bad), method === 'DELETE' ? undefined : {});
      expect([answer.status, answer.body.code]).toEqual([400, 'INVALID_PERSONALITY_ID']);
      expect(readsMade()).toEqual([]);
    });
    it('authority remains403 before malformed-name refusal', async () => {
      expect((await through(NARROW, method, path('CaseSensitiveName'), method === 'DELETE' ? undefined : {})).status).toBe(403);
      expect(readsMade()).toEqual([]);
    });
    it('a family-scoped caller without root keeps403 without point lookup', async () => {
      const scoped = { ...NARROW, scopes: ['personalities:write', 'personalities:admin'] };
      expect((await through(scoped, method, path('CaseSensitiveName'), method === 'DELETE' ? undefined : {})).status).toBe(403);
      expect(readsMade()).toEqual([]);
    });
    it('uppercase UUID preserves its identifier bytes at point lookup', async () => {
      const id = PROJECT_ID.toUpperCase();
      expect((await through(ROOT, method, path(id), method === 'DELETE' ? undefined : {})).status).toBe(200);
      expect(reads.authorizePoint.mock.calls[0][2]).toBe(id);
    });
    it('unknown UUID retains404', async () => {
      reads.authorizePoint.mockResolvedValue({ exists: false, allowed: false, concealed: true });
      expect((await through(ROOT, method, path(ABSENT_ID), method === 'DELETE' ? undefined : {})).status).toBe(404);
      expect(reads.authorizePoint.mock.calls[0][2]).toBe(ABSENT_ID);
    });
  });
});

describe('the account-owner arm reads only for an identifier that can name a stored row', () => {
  it.each([
    ['DELETE', `/tasks/${TASK_ID.slice(0, 8)}`],
    ['PATCH', '/tasks/not-a-uuid/access'],
    ['PUT', `/tasks/${TASK_ID.slice(0, 8)}/account-owner`],
  ])('an Account without tasks:admin on %s %s is never answered 503, and the arm reads nothing', async (method, path) => {
    const answer = await through(ACCOUNT, method, path, method === 'DELETE' ? undefined : {});
    // What answers instead is the route ceiling or the (spied) point stage,
    // exactly as for an id the arm finds nothing for.
    expect(answer.status).not.toBe(503);
    expect(reads.connect).not.toHaveBeenCalled();
  });

  it('for a full Task UUID the arm still runs', async () => {
    const answer = await through(ACCOUNT, 'DELETE', `/tasks/${TASK_ID}`);
    expect(reads.connect).toHaveBeenCalledTimes(1);
    // The spy makes the read fail, which the arm answers as it always has.
    expect([answer.status, answer.body.code]).toEqual([503, 'AUTHORIZATION_UNAVAILABLE']);
  });
});
