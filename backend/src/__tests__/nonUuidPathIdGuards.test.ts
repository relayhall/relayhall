/**
 * Card 9cdc6b27: a path id that is not a UUID answered HTTP 500.
 *
 * `GET /skills/relayhall-release-review` answered 500 on production. The
 * authorization stage resolves a Skill by NAME as well as by id
 * (AuthorizationRepository.resolve: `id::text = $1 OR name = $1`), so the
 * name of a Skill the caller can read passed it and reached `skills.id = $1`,
 * a uuid-typed read, where PostgreSQL's cast failure (22P02) surfaced as
 * INTERNAL_ERROR. The census of the class on the sibling routes found the same
 * defect on two /principals routes, for any non-UUID id.
 *
 * Every route below now refuses a malformed id by name before its handler
 * reads anything (400 INVALID_SKILL_ID, INVALID_SKILL_VERSION_ID or
 * INVALID_PRINCIPAL_ID), and an uppercase or unknown UUID answers exactly as
 * it did.
 *
 * The service doubles fail the way PostgreSQL does: a value that is not a uuid
 * makes the read throw 22P02 and an out-of-range Version number 22003. On
 * main, therefore, every refusal case here answers 500 (the red proof). A
 * double can be edited to agree with the code, so the outside anchor is the
 * live ID-1 case in skillDraftProvenanceLive.test.ts and the card 9cdc6b27
 * case in groupPrincipalLive.test.ts, which drive the production routers over
 * a real PostgreSQL.
 */
import express from 'express';
import type { Router } from 'express';

import principalsRoutes from '../routes/principals';
import skillsRoutes from '../routes/skills';
import { pool } from '../db/connection';
import { toolByName } from '../mcp/registry';
import { authorizationRepository } from '../services/AuthorizationRepository';
import { credentialLifecycleService, CredentialLifecycleError } from '../services/CredentialLifecycleService';
import { principalService, type Principal, type PrincipalCredential } from '../services/PrincipalService';
import { skillManager, SkillContractError } from '../services/SkillManager';

const SKILL_ID = '5c1b7e2a-9d4f-4b8e-a1c3-0f2e4d6b8a10';
const VERSION_ID = '7e9d1c3b-2a4f-4e6d-8b0a-1c3e5f7a9b20';
const PERSON_ID = '3a5c7e9b-1d2f-4a6b-8c0d-2e4f6a8b0c30';
const UNKNOWN = '0d9e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f60';
const REV = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INT4_MAX = 2147483647;
/** The spellings the production defect and the brief name: a Skill name, and
 * two wildcard strings (`%25` reaches the route as the literal `%`). */
const NOT_UUIDS = ['relayhall-release-review', 'relayhall-live-audit', '*', '%25'];

// ── PostgreSQL's behaviour, as the doubles reproduce it ─────────────────────

const PG_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function pgUuid(value: string): string {
  if (!PG_UUID.test(value)) {
    throw Object.assign(new Error(`invalid input syntax for type uuid: "${value}"`), { code: '22P02' });
  }
  return value.toLowerCase();
}
/** SkillManager reads a digits-only reference as `$2::integer`, anything else as `$2::uuid`. */
function pgVersionRef(ref: string): string {
  if (/^\d+$/.test(ref)) {
    if (Number(ref) > INT4_MAX) {
      throw Object.assign(new Error('value out of range for type integer'), { code: '22003' });
    }
    return String(Number(ref));
  }
  return pgUuid(ref);
}

const skill = { id: SKILL_ID, name: 'relayhall-release-review', revision: REV, current_published_version_id: VERSION_ID };
const version = { id: VERSION_ID, skill_id: SKILL_ID, version: 1, skill_md: '# body', content_sha256: 'a'.repeat(64), status: 'published' };
const skillNotFound = () => new SkillContractError(404, 'SKILL_NOT_FOUND', 'Skill not found');
const knownSkill = (id: string): boolean => pgUuid(id) === SKILL_ID;
function findVersion(skillId: string, ref: string): typeof version {
  const known = knownSkill(skillId);
  const wanted = pgVersionRef(ref);
  if (!known || (wanted !== '1' && wanted !== VERSION_ID)) {
    throw new SkillContractError(404, 'SKILL_VERSION_NOT_FOUND', 'Skill Version not found');
  }
  return version;
}

function stubSkillManager(): void {
  jest.spyOn(skillManager, 'getById').mockImplementation(async (id) => {
    if (!knownSkill(id)) throw skillNotFound();
    return skill as never;
  });
  jest.spyOn(skillManager, 'listVersions').mockImplementation(async (id) => {
    if (!knownSkill(id)) throw skillNotFound();
    return [version] as never;
  });
  jest.spyOn(skillManager, 'getVersion').mockImplementation(async (id, ref) => findVersion(id, ref) as never);
  jest.spyOn(skillManager, 'update').mockImplementation(async (id) => {
    if (!knownSkill(id)) throw skillNotFound();
    return skill as never;
  });
  // transition locks the catalogue row first, then reads the Version.
  jest.spyOn(skillManager, 'transition').mockImplementation(async (id, ref) => {
    if (!knownSkill(id)) throw skillNotFound();
    return findVersion(id, ref) as never;
  });
  jest.spyOn(skillManager, 'setGlobal').mockImplementation(async (id) => {
    if (!knownSkill(id)) throw skillNotFound();
    return skill as never;
  });
  jest.spyOn(skillManager, 'delete').mockImplementation(async (id) => {
    if (!knownSkill(id)) throw skillNotFound();
  });
  // Card d67e6990: the owner act locks the catalogue row first.
  jest.spyOn(skillManager, 'changeOwner').mockImplementation(async (id) => {
    if (!knownSkill(id)) throw skillNotFound();
    return { skill, changed: true } as never;
  });
}

// ── /skills: the route table is the census ──────────────────────────────────

type ManagerMethod = 'getById' | 'listVersions' | 'getVersion' | 'update' | 'transition' | 'setGlobal' | 'delete' | 'changeOwner';
interface SkillRoute {
  route: string;
  reads: ManagerMethod;
  ok: number;
  notFound: string;
  body?: Record<string, unknown>;
  revisionBound?: boolean;
}
const SKILL_ROUTES: SkillRoute[] = [
  { route: 'GET /skills/:id', reads: 'getById', ok: 200, notFound: 'SKILL_NOT_FOUND' },
  { route: 'GET /skills/:id/versions', reads: 'listVersions', ok: 200, notFound: 'SKILL_NOT_FOUND' },
  { route: 'GET /skills/:id/versions/:version', reads: 'getVersion', ok: 200, notFound: 'SKILL_VERSION_NOT_FOUND' },
  { route: 'GET /skills/:id/versions/:version/content', reads: 'getVersion', ok: 200, notFound: 'SKILL_VERSION_NOT_FOUND' },
  { route: 'PUT /skills/:id', reads: 'update', ok: 201, notFound: 'SKILL_NOT_FOUND', body: { description: 'next draft' }, revisionBound: true },
  { route: 'POST /skills/:id/versions/:version/submit-review', reads: 'transition', ok: 200, notFound: 'SKILL_NOT_FOUND', revisionBound: true },
  { route: 'POST /skills/:id/versions/:version/reject', reads: 'transition', ok: 200, notFound: 'SKILL_NOT_FOUND', revisionBound: true },
  { route: 'POST /skills/:id/versions/:version/publish', reads: 'transition', ok: 200, notFound: 'SKILL_NOT_FOUND', revisionBound: true },
  { route: 'POST /skills/:id/versions/:version/retire', reads: 'transition', ok: 200, notFound: 'SKILL_NOT_FOUND', revisionBound: true },
  { route: 'PATCH /skills/:id/audience', reads: 'setGlobal', ok: 200, notFound: 'SKILL_NOT_FOUND', body: { is_global: false }, revisionBound: true },
  { route: 'DELETE /skills/:id', reads: 'delete', ok: 200, notFound: 'SKILL_NOT_FOUND', revisionBound: true },
  { route: 'PUT /skills/:id/owner', reads: 'changeOwner', ok: 200, notFound: 'SKILL_NOT_FOUND', body: { ownerPrincipalId: PERSON_ID, reason: 'owner act' }, revisionBound: true },
];
const VERSION_ROUTES = SKILL_ROUTES.filter((route) => route.route.includes(':version'));

function mountedParamRoutes(router: Router, mount: string): string[] {
  return (router.stack as Array<{ route?: { path: unknown; methods: Record<string, boolean> } }>)
    .filter((layer) => layer.route && typeof layer.route.path === 'string' && layer.route.path.includes(':'))
    .flatMap((layer) => Object.keys(layer.route!.methods)
      .map((method) => `${method.toUpperCase()} ${mount}${layer.route!.path as string}`));
}

interface Answer { status: number; body: Record<string, any> }

async function withApp(app: express.Express, run: (origin: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('not listening');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function request(origin: string, method: string, path: string, body?: unknown, ifMatch?: string): Promise<Answer> {
  const response = await fetch(origin + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(ifMatch ? { 'If-Match': ifMatch } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

function skillsApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { principal: { id: PERSON_ID, kind: 'human', role: 'admin' }, scopes: ['root'] });
    next();
  });
  app.use('/skills', skillsRoutes);
  return app;
}

async function sendSkill(route: SkillRoute, id: string, ref = '1'): Promise<Answer> {
  const [method, template] = route.route.split(' ');
  const path = template.replace(':id', id).replace(':version', ref);
  let answer: Answer = { status: 0, body: {} };
  await withApp(skillsApp(), async (origin) => {
    answer = await request(origin, method, path, route.body ?? (method === 'GET' || method === 'DELETE' ? undefined : {}),
      route.revisionBound ? REV : undefined);
  });
  return answer;
}

beforeEach(() => {
  jest.restoreAllMocks();
  stubSkillManager();
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('/skills: every route with a path parameter refuses a malformed one by name', () => {
  it('the table is the census: it names every /skills route that takes a path parameter', () => {
    expect(mountedParamRoutes(skillsRoutes, '/skills').sort()).toEqual(SKILL_ROUTES.map((route) => route.route).sort());
  });

  describe.each(SKILL_ROUTES)('$route', (route) => {
    it.each(NOT_UUIDS)('refuses the Skill id %p with 400 INVALID_SKILL_ID before any read', async (bad) => {
      const answer = await sendSkill(route, bad);
      expect([answer.status, answer.body.code]).toEqual([400, 'INVALID_SKILL_ID']);
      expect(answer.body.error).toBe('skill id must be a full UUID');
      expect(skillManager[route.reads]).not.toHaveBeenCalled();
    });

    it('lets an uppercase UUID through to the read, unchanged', async () => {
      const answer = await sendSkill(route, SKILL_ID.toUpperCase());
      expect(answer.status).toBe(route.ok);
      expect(skillManager[route.reads]).toHaveBeenCalledTimes(1);
      expect((skillManager[route.reads] as unknown as jest.Mock).mock.calls[0][0]).toBe(SKILL_ID.toUpperCase());
    });

    it('keeps 404 for an unknown UUID', async () => {
      const answer = await sendSkill(route, UNKNOWN);
      expect([answer.status, answer.body.code]).toEqual([404, route.notFound]);
    });
  });
});

describe('/skills: a Version reference is a Version UUID or a Version number', () => {
  describe.each(VERSION_ROUTES)('$route', (route) => {
    it.each(['latest', 'v1', '1.0', '-1', '*', '%25', String(INT4_MAX + 1), '99999999999'])(
      'refuses the Version reference %p with 400 INVALID_SKILL_VERSION_ID before any read', async (bad) => {
        const answer = await sendSkill(route, SKILL_ID, bad);
        expect([answer.status, answer.body.code]).toEqual([400, 'INVALID_SKILL_VERSION_ID']);
        expect(skillManager[route.reads]).not.toHaveBeenCalled();
      });

    it.each(['1', '0001', VERSION_ID, VERSION_ID.toUpperCase()])('passes the Version reference %p to the read', async (ref) => {
      const answer = await sendSkill(route, SKILL_ID, ref);
      expect(answer.status).toBe(route.ok);
      expect((skillManager[route.reads] as unknown as jest.Mock).mock.calls[0][1]).toBe(ref);
    });

    it.each(['0', String(INT4_MAX), UNKNOWN])('keeps 404 for the unknown Version reference %p', async (ref) => {
      const answer = await sendSkill(route, SKILL_ID, ref);
      expect([answer.status, answer.body.code]).toEqual([404, 'SKILL_VERSION_NOT_FOUND']);
    });
  });
});

// ── relayhall_skill_get: the MCP twin dispatches to the same routes ─────────

describe('relayhall_skill_get rides the same refusal through the in-process dispatcher', () => {
  const BEARER = 'Bearer rh_dev_keyid01.secretsecretsecretsecret';

  beforeEach(() => {
    const principal: Principal = {
      id: '66666666-6666-4666-8666-666666666666', kind: 'service', handle: 'connector_one',
      displayName: null, status: 'active', role: 'agent', boundTaskId: null, purpose: null,
      legacyIdentity: false, ownExpression: null, sourceTag: null, harness: null,
      personalityId: null, parentPrincipalId: null, lastSeenAt: null, metadata: {},
    };
    const credential: PrincipalCredential = {
      id: '77777777-7777-4777-8777-777777777777', principalId: principal.id, credentialType: 'api_key',
      keyId: 'keyid01', scopes: ['skills:read', 'skills:use'], expiresAt: null, revokedAt: null, transport: 'mcp',
      graceUntil: null, metadata: {},
    };
    jest.spyOn(principalService, 'authenticatePrincipalKey').mockResolvedValue({ principal, credential });
    jest.spyOn(principalService, 'bumpLastSeen').mockImplementation(() => undefined as never);
    // As AuthorizationRepository.resolve does for a readable Skill's NAME: it exists and may be read.
    jest.spyOn(authorizationRepository, 'authorizePoint').mockResolvedValue({ exists: true, allowed: true } as never);
  });

  function skillGet(args: Record<string, unknown>): Promise<string> {
    const tool = toolByName('relayhall_skill_get');
    if (!tool) throw new Error('relayhall_skill_get is not registered');
    return tool.handler(args, { authorization: BEARER, toolName: 'relayhall_skill_get' });
  }

  it('a Skill name as skillId is refused 400 INVALID_SKILL_ID, not 500', async () => {
    await expect(skillGet({ skillId: 'relayhall-release-review' })).rejects.toThrow('(HTTP 400) [INVALID_SKILL_ID]');
    expect(skillManager.getById).not.toHaveBeenCalled();
  });

  it('a version that is neither a Version UUID nor a number is refused 400 INVALID_SKILL_VERSION_ID', async () => {
    await expect(skillGet({ skillId: SKILL_ID, version: 'latest', fullContent: true }))
      .rejects.toThrow('(HTTP 400) [INVALID_SKILL_VERSION_ID]');
    expect(skillManager.getVersion).not.toHaveBeenCalled();
  });

  it('an unknown UUID still answers 404, and the Skill id still reads', async () => {
    await expect(skillGet({ skillId: UNKNOWN })).rejects.toThrow('(HTTP 404) [SKILL_NOT_FOUND]');
    await expect(skillGet({ skillId: SKILL_ID, response_format: 'detailed' })).resolves.toContain(SKILL_ID);
  });
});

// ── the same class on /principals: two routes, the same one-line guard ─────

interface PrincipalRoute { route: string; reads: () => jest.SpyInstance; unknown: { status: number; code?: string } }

function principalsApp(scopes: string[]): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { principal: { id: PERSON_ID, kind: 'human', role: 'admin' }, scopes, userId: 'id-guard-admin' });
    next();
  });
  app.use('/principals', principalsRoutes);
  return app;
}

describe('/principals: the two routes the census found refuse a malformed id by name', () => {
  let listCredentials: jest.SpyInstance;
  let terminate: jest.SpyInstance;
  const PRINCIPAL_ROUTES: PrincipalRoute[] = [
    { route: 'GET /principals/:id/credentials', reads: () => listCredentials, unknown: { status: 200 } },
    { route: 'POST /principals/:id/terminate', reads: () => terminate, unknown: { status: 404, code: 'PRINCIPAL_NOT_FOUND' } },
  ];

  beforeEach(() => {
    // refuseGroupPrincipal reads the target's kind by uuid; it steps aside for a non-UUID id.
    jest.spyOn(pool, 'query').mockImplementation((async (_text: string, params: unknown[] = []) => (
      { rows: pgUuid(String(params[0])) === PERSON_ID ? [{ kind: 'human' }] : [] })) as never);
    listCredentials = jest.spyOn(principalService, 'listCredentials').mockImplementation(async (id) => (
      pgUuid(id) === PERSON_ID ? [{ id: UNKNOWN, key_id: 'k' }] : []));
    terminate = jest.spyOn(credentialLifecycleService, 'terminate').mockImplementation(async (id) => {
      if (pgUuid(id) !== PERSON_ID) throw new CredentialLifecycleError(404, 'PRINCIPAL_NOT_FOUND', 'No such principal');
      return { terminated: [PERSON_ID], revokedCredentials: 0 };
    });
  });

  async function sendPrincipal(route: PrincipalRoute, id: string, scopes = ['root']): Promise<Answer> {
    const [method, template] = route.route.split(' ');
    let answer: Answer = { status: 0, body: {} };
    await withApp(principalsApp(scopes), async (origin) => {
      answer = await request(origin, method, template.replace(':id', id), method === 'POST' ? {} : undefined);
    });
    return answer;
  }

  describe.each(PRINCIPAL_ROUTES)('$route', (route) => {
    it.each(NOT_UUIDS)('refuses the principal id %p with 400 INVALID_PRINCIPAL_ID before any read', async (bad) => {
      const answer = await sendPrincipal(route, bad);
      expect([answer.status, answer.body.code]).toEqual([400, 'INVALID_PRINCIPAL_ID']);
      expect(answer.body.error).toBe('principal id must be a full UUID');
      expect(route.reads()).not.toHaveBeenCalled();
    });

    it('keeps the authority check first: a caller without root is still 403 for a malformed id', async () => {
      const answer = await sendPrincipal(route, 'relayhall-release-review', ['principals:read']);
      expect(answer.status).toBe(403);
      expect(route.reads()).not.toHaveBeenCalled();
    });

    it('lets an uppercase UUID through to the read, unchanged', async () => {
      const answer = await sendPrincipal(route, PERSON_ID.toUpperCase());
      expect(answer.status).toBe(200);
      expect(route.reads().mock.calls[0][0]).toBe(PERSON_ID.toUpperCase());
    });

    it('answers an unknown UUID exactly as before', async () => {
      const answer = await sendPrincipal(route, UNKNOWN);
      expect({ status: answer.status, code: answer.body.code }).toEqual({ status: route.unknown.status, code: route.unknown.code });
    });
  });
});
