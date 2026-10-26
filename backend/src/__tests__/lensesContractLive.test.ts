/**
 * RH-LENSES-d (card 4e159741) - THE LENS CONTRACT, MEASURED LIVE.
 *
 * Design record v7.1 `96f0bd3d` §8 with ANNEX `d6637a92` §A7.5 and §A8.3.
 * This file is control **R-8-v1** and the live half of acceptance rows
 * **A-L30**, **A-L53** and obligation **B-L9d**. The unit half is
 * `lensesContract.test.ts`; control R-14 / A-L52 extends
 * `administratorSessionSeam.test.ts`; the red mutations for all three are
 * `scripts/lenses-d-mutations.py`.
 *
 * ── R-8-v1: LENSES GRANT NOTHING ────────────────────────────────────────────
 *
 * Invariant I-L2: a lens is a derived navigational fact, never an input to an
 * authorization predicate, and every route it leads to enforces exactly the
 * ceiling it enforced before. The control records, for a matrix of callers -
 * an ordinary member Account, an Account holding no scope at all, a root
 * LOGIN SESSION, the same Account on the break-glass dashboard token, the
 * same Account on a BEARER credential holding root, and a delegated Connector
 * - every outcome AND every body of the route families the lens touches, plus
 * the dashboard family FIX-A narrowed (summary, activity, active, and the
 * Reports count it carries). It then answers each request again with the
 * lens surface REMOVED - every function the lens module exports replaced, in
 * the running process, by one that throws - and requires every outcome and
 * every body to be identical.
 *
 * HOW THE REMOVAL REACHES EVERY CONSUMER. The swap is made on the module's
 * own exports object, which every importer reads at CALL time (compiled
 * imports are property reads on the module object, and a lazy `require`
 * returns the same object), so a consumer however it is spelled meets the
 * removed surface. The one shape a swap cannot reach is a consumer that copies
 * the function out at load time; `lensesContract.test.ts` closes that with
 * its importer register, which allows exactly one importer of the lens module:
 * the route that serves it.
 *
 * The comparison is the one the control is about, and it can fail: a route
 * that consulted a lens, for anything, answers differently once there is no
 * lens to consult (the mutations in `scripts/lenses-d-mutations.py` make two
 * routes do exactly that, one in each family, and each reddens its own test).
 * And it runs at the pin it must run at: the dashboard family narrows in its
 * QUERY since FIX-A (`0a134f3`), which the vacuity test below measures - a
 * member and a root session see different summaries - because a comparison
 * over a surface that narrows nothing could not fail.
 *
 * ── R-8-c: THE MANAGER ARM GRANTS NOTHING EITHER (LENSES-c c1-B) ─────────
 *
 * Card b5c83682 (design delta C.8; ANNEX control R-8-c): the same matrix,
 * extended with a STEWARD caller - an Account holding a live owner row in a
 * Group, whose lens therefore carries the manager arm - and the touched
 * families extended with that Group's member, steward and team-grants reads.
 * The comparison is re-run over the extended matrix; the A-L53 rows keep the
 * original matrix, whose callers hold no live Group role.
 *
 * ── WHY IT CANNOT BE A UNIT SUITE ──────────────────────────────────────────
 *
 * The admin arm is a fact about how a REAL request authenticated: a login
 * session cookie, the break-glass dashboard token and an `rh_` bearer arrive
 * through different doors of `middleware/auth`, and only the production
 * router decides what each one resolves to. The comparison is a fact about
 * every route of a real router over stored rows. A mocked pool has neither.
 *
 * ── THE DESTRUCTIVE CONTRACT, STATED ───────────────────────────────────────
 *
 * It WRITES principals, principal_credentials, auth_sessions, projects,
 * tasks, reports and grants, and changes one principal's role and restores
 * it. It refuses any URL naming a deployment database, connects only to a
 * local disposable one (or the CI service database), and FAILS - never skips
 * - without one. Excluded from the default jest run; it runs from
 * `npm run test:lenses-contract` and unconditionally in the full CI tier.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the lens contract is a fact about real requests through the '
    + 'production router over stored rows, so this suite never skips. Load database/init.sql into a disposable '
    + 'database, run npm run migrate, and point RELAYHALL_TEST_DB_URL at it.');
}
const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = decodeURIComponent(parsed.pathname.slice(1));
const localDisposable = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  && /test|contract|fixture/.test(TEST_DB_NAME);
const ciService = process.env.CI === 'true' && parsed.hostname === 'postgres' && TEST_DB_NAME === 'relayhall_ci';
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
  || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod'].includes(TEST_DB_NAME)
  || (!localDisposable && !ciService)) {
  throw new Error('The lens contract suite refuses a non-disposable database target');
}

Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: TEST_DB_NAME,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
});

const jwt = require('jsonwebtoken');

jest.setTimeout(600_000);

interface Answer { status: number; json: any; text: string }
interface Caller { label: string; principalId: string; headers: Record<string, string> }
interface Production {
  pool: any;
  server: http.Server;
  origin: string;
}

/** The production router over the real database, exactly as the other live suites mount it. */
async function production(): Promise<Production> {
  const express = require('express');
  const { pool } = require('../db/connection');
  const { registerProtectedRoutes } = require('../routeRegistry');
  const { authMiddleware } = require('../middleware/auth');
  const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
  const { apiErrorHandler } = require('../utils/apiErrors');
  const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  const server: http.Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return { pool, server, origin: `http://127.0.0.1:${(server.address() as any).port}` };
}

let LIVE: Production;

/**
 * THE LENS SURFACE, REMOVED, for the duration of `run`: every function the
 * lens module exports throws, on the module object every consumer reads at
 * call time. Restored afterwards, whatever `run` did.
 */
async function withoutLensSurface<T>(run: () => Promise<T>): Promise<T> {
  const lensModule = require('../utils/lenses');
  const saved: Record<string, unknown> = {};
  for (const key of Object.keys(lensModule)) {
    if (typeof lensModule[key] !== 'function') continue;
    saved[key] = lensModule[key];
    lensModule[key] = () => { throw new Error('R-8-v1: the lens surface is removed'); };
  }
  if (Object.keys(saved).length === 0) throw new Error('the lens module exports no function to remove: the removal would be vacuous');
  try {
    return await run();
  } finally {
    Object.assign(lensModule, saved);
  }
}

async function call(at: Production, who: Caller, method: string, routePath: string, body?: unknown): Promise<Answer> {
  const response = await fetch(`${at.origin}${routePath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...who.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, text };
}
const live = (who: Caller, method: string, routePath: string, body?: unknown): Promise<Answer> =>
  call(LIVE, who, method, routePath, body);

const tag = (): string => crypto.randomBytes(5).toString('hex');
const SYSTEM = { handle: 'lenses-d-live-fixture', authMethod: 'system' as const };

// ─────────────────────────────── the callers ─────────────────────────────────

/** An ordinary member Account on a login session. */
let MEMBER: Caller;
/** An Account session whose role snapshot derives NO scope at all: only `authenticated` routes admit it. */
let BARE: Caller;
/** ONE administrator Account, arriving through three doors. */
let ADMIN_SESSION: Caller;
let ADMIN_JWT: Caller;
let ADMIN_BEARER: Caller;
/** A Connector the member created, on its own bearer credential. */
let CONNECTOR: Caller;
/** R-8-c: an Account holding a LIVE owner row in STEWARD_GROUP, on a login session. */
let STEWARD: Caller;
let STEWARD_GROUP = '';

let ADMIN_ID = '';
let PROJECT_MEMBER = '';
let PROJECT_OTHER = '';

async function insertAccount(role: string | null, kind: 'human' | 'service' = 'human', parent: string | null = null): Promise<string> {
  const handle = `lensd-${role ?? 'bare'}-${tag()}`;
  const row = await LIVE.pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role, parent_principal_id)
     VALUES ($1, $2, $2, 'active', $3, $4) RETURNING id`,
    [kind, handle, role, parent],
  );
  return String(row.rows[0].id);
}

async function sessionOf(label: string, principalId: string): Promise<Caller> {
  const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

/**
 * THE SAME ADMINISTRATOR ACCOUNT ON THREE DOORS (A-L30 says "the same Account").
 *
 * `issueCredential` refuses a credential to an Account (A17.1, keyless) and
 * refuses `root` to any credential (AZ-18), so the bearer half cannot come
 * through an ordinary door - and A-L30 names a bearer HOLDING root exactly
 * because a derivation that tested `root` alone would admit it. The fixture
 * is therefore built the way the LENSES-b drill builds its root bearer: the
 * principal is parented while its credential is issued, then detached,
 * promoted to `admin`, and its credential widened to `root` in raw SQL.
 * Detached and non-legacy, the bearer door hands the request the CREDENTIAL's
 * scopes; the session and the dashboard-token doors hand it the ROLE's.
 */
async function administratorOnThreeDoors(): Promise<void> {
  const parent = await insertAccount('editor');
  ADMIN_ID = await insertAccount('user', 'service', parent);
  const { principalService } = require('../services/PrincipalService');
  const issued = await principalService.issueCredential({
    principalId: ADMIN_ID, scopes: ['principals:read'], label: 'lenses-d root bearer', transport: 'api',
  }, SYSTEM);
  await LIVE.pool.query('UPDATE principals SET parent_principal_id = NULL WHERE id = $1', [ADMIN_ID]);
  await LIVE.pool.query(`UPDATE principals SET role = 'admin' WHERE id = $1`, [ADMIN_ID]);
  await LIVE.pool.query('UPDATE principal_credentials SET scopes = $2::jsonb WHERE id = $1',
    [issued.credentialId, JSON.stringify(['root'])]);
  principalService.invalidatePrincipals?.([ADMIN_ID]);
  const handle = String((await LIVE.pool.query('SELECT handle FROM principals WHERE id = $1', [ADMIN_ID])).rows[0].handle);
  ADMIN_SESSION = await sessionOf('admin-session', ADMIN_ID);
  ADMIN_JWT = {
    label: 'admin-dashboard-token', principalId: ADMIN_ID,
    headers: { Authorization: `Bearer ${jwt.sign({ v: 2, sub: ADMIN_ID, handle, kind: 'service' }, process.env.JWT_SECRET, { expiresIn: '30m' })}` },
  };
  ADMIN_BEARER = { label: 'admin-bearer-holding-root', principalId: ADMIN_ID, headers: { Authorization: `Bearer ${issued.fullKey}` } };
}

async function connectorOf(parentId: string): Promise<Caller> {
  const id = await insertAccount('user', 'service', parentId);
  // An explicit own() expression inheriting the parent's scopes and objects: a
  // delegated principal without one holds NOTHING (inheritance is never
  // implicit), and a Connector refused everywhere would make its rows of the
  // matrix compare refusals only.
  await LIVE.pool.query('UPDATE principals SET own_expression = $2::jsonb WHERE id = $1',
    [id, JSON.stringify({ scopes: 'parent', objects: 'parent' })]);
  const { principalService } = require('../services/PrincipalService');
  const issued = await principalService.issueCredential({
    principalId: id, transport: 'any',
    scopes: ['tasks:read', 'projects:read', 'reports:read', 'principals:read'],
  }, SYSTEM);
  return { label: 'connector', principalId: id, headers: { Authorization: `Bearer ${issued.fullKey}` } };
}

async function projectWithTask(label: string): Promise<string> {
  const projectId = String((await LIVE.pool.query(
    `INSERT INTO projects (name, status, visibility) VALUES ($1, 'active', 'private') RETURNING id`,
    [`lensd ${label} ${tag()}`])).rows[0].id);
  for (const status of ['todo', 'in-progress']) {
    await LIVE.pool.query(
      `INSERT INTO tasks (title, status, visibility, project_id) VALUES ($1, $2, 'private', $3)`,
      [`lensd ${label} ${status} ${tag()}`, status, projectId]);
  }
  await LIVE.pool.query(
    `INSERT INTO reports (title, content, author, author_actor_id, visibility, project_id)
     VALUES ($1, 'lenses-d drill report', 'lensd', 'lensd', 'private', $2)`,
    [`lensd ${label} report ${tag()}`, projectId]);
  return projectId;
}

beforeAll(async () => {
  LIVE = await production();

  MEMBER = await sessionOf('member', await insertAccount('editor'));
  // An empty role SNAPSHOT is authoritative and derives no scope (`scopesForRole('')` is `[]`, pinned by
  // sessionRoleSnapshot.test.ts): the one ordinary way a signed-in Account holds nothing but `authenticated`.
  BARE = await sessionOf('bare', await insertAccount('editor'));
  await LIVE.pool.query(`UPDATE auth_sessions SET role_snapshot = '' WHERE principal_id = $1`, [BARE.principalId]);
  await administratorOnThreeDoors();
  CONNECTOR = await connectorOf(MEMBER.principalId);

  PROJECT_MEMBER = await projectWithTask('member');
  PROJECT_OTHER = await projectWithTask('other');
  STEWARD = await sessionOf('steward', await insertAccount('editor'));
  const { insertGroupRow } = require('./support/groupRows');
  STEWARD_GROUP = await insertGroupRow(LIVE.pool, { name: `lensd steward ${tag()}`, description: 'R-8-c', featured: true });
  await LIVE.pool.query(`INSERT INTO group_members (group_id, account_principal_id, source) VALUES ($1, $2, 'local')`,
    [STEWARD_GROUP, STEWARD.principalId]);
  await LIVE.pool.query(
    `INSERT INTO group_stewards (group_id, account_principal_id, role, appointed_by_principal_id) VALUES ($1, $2, 'owner', $3)`,
    [STEWARD_GROUP, STEWARD.principalId, ADMIN_ID]);
  await LIVE.pool.query(
    `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, origin, granted_by_principal_id)
     VALUES ('group', $1, 'project', $2, 'read', 'manual', $3)`, [STEWARD_GROUP, PROJECT_OTHER, ADMIN_ID]);

  await LIVE.pool.query(
    `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, origin)
     VALUES ('principal', $1, 'project', $2, 'read', 'manual')`, [MEMBER.principalId, PROJECT_MEMBER]);
});

afterAll(async () => {
  if (LIVE?.server) await new Promise<void>((resolve) => LIVE.server.close(() => resolve()));
  if (LIVE?.pool) await LIVE.pool.end();
});

const MATRIX = (): Caller[] => [MEMBER, BARE, ADMIN_SESSION, ADMIN_JWT, ADMIN_BEARER, CONNECTOR];
/** R-8-c: the comparison's matrix, the v1 callers and a live steward. */
const R8_MATRIX = (): Caller[] => [...MATRIX(), STEWARD];

// ═══════════════════════════════════════════════════════════════════════════
// A-L30 / A-L53 / B-L9d over real requests
// ═══════════════════════════════════════════════════════════════════════════

describe('A-L30 - the same Account: a bearer holding root is refused the admin lens, a login session receives it', () => {
  it('the three doors really resolve to root for the same principal (the fixture is not vacuous)', async () => {
    for (const door of [ADMIN_SESSION, ADMIN_JWT, ADMIN_BEARER]) {
      const me = await live(door, 'GET', '/principals/me');
      expect({ door: door.label, status: me.status, id: me.json?.principal?.id, root: (me.json?.scopes ?? []).includes('root') })
        .toEqual({ door: door.label, status: 200, id: ADMIN_ID, root: true });
    }
  });

  it('the bearer holding root gets admin: false', async () => {
    const answer = await live(ADMIN_BEARER, 'GET', '/principals/me/lenses');
    expect(answer.status).toBe(200);
    expect(answer.json).toStrictEqual({ lenses: ['member'], admin: false });
  });

  it('the same Account on a login session gets admin: true', async () => {
    const answer = await live(ADMIN_SESSION, 'GET', '/principals/me/lenses');
    expect(answer.status).toBe(200);
    expect(answer.json).toStrictEqual({ lenses: ['member', 'admin'], admin: true });
  });

  it('the same Account on the break-glass dashboard token gets admin: true', async () => {
    const answer = await live(ADMIN_JWT, 'GET', '/principals/me/lenses');
    expect(answer.status).toBe(200);
    expect(answer.json).toStrictEqual({ lenses: ['member', 'admin'], admin: true });
  });

  it('recomputed per request: the Account loses root and the next request has no admin arm; restored, it returns', async () => {
    const { principalService } = require('../services/PrincipalService');
    try {
      await LIVE.pool.query(`UPDATE principals SET role = 'editor' WHERE id = $1`, [ADMIN_ID]);
      principalService.invalidatePrincipals?.([ADMIN_ID]);
      expect((await live(ADMIN_SESSION, 'GET', '/principals/me/lenses')).json).toStrictEqual({ lenses: ['member'], admin: false });
    } finally {
      await LIVE.pool.query(`UPDATE principals SET role = 'admin' WHERE id = $1`, [ADMIN_ID]);
      principalService.invalidatePrincipals?.([ADMIN_ID]);
    }
    expect((await live(ADMIN_SESSION, 'GET', '/principals/me/lenses')).json).toStrictEqual({ lenses: ['member', 'admin'], admin: true });
  });
});

describe('A-L53 - the v1 payload carries no manager key', () => {
  it('an ordinary member gets exactly { lenses: [member], admin: false }, with no manager key in the body at all', async () => {
    const answer = await live(MEMBER, 'GET', '/principals/me/lenses');
    expect(answer.status).toBe(200);
    expect(answer.json).toStrictEqual({ lenses: ['member'], admin: false });
    expect(answer.text).not.toContain('manager');
  });

  it('no caller in the matrix is handed a manager key', async () => {
    for (const who of MATRIX()) {
      const answer = await live(who, 'GET', '/principals/me/lenses');
      expect({ who: who.label, status: answer.status, manager: answer.text.includes('manager') })
        .toEqual({ who: who.label, status: 200, manager: false });
    }
  });
});

describe('B-L9d - the authenticated ceiling, over a real request', () => {
  it('an Account holding no scope at all reads its own lenses (below the /principals family it would be refused)', async () => {
    const family = await live(BARE, 'GET', '/principals');
    expect(family.status).toBe(403);
    const answer = await live(BARE, 'GET', '/principals/me/lenses');
    expect({ status: answer.status, json: answer.json }).toEqual({ status: 200, json: { lenses: ['member'], admin: false } });
  });

  it('a delegated Connector reads its own lenses and is a member and nothing more', async () => {
    expect((await live(CONNECTOR, 'GET', '/principals/me/lenses')).json).toStrictEqual({ lenses: ['member'], admin: false });
  });

  it('the read writes nothing: no audit row, so it is not a noise source', async () => {
    const before = Number((await LIVE.pool.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n);
    for (const who of MATRIX()) await live(who, 'GET', '/principals/me/lenses');
    const after = Number((await LIVE.pool.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n);
    expect(after).toBe(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R-8-v1 - lenses grant nothing
// ═══════════════════════════════════════════════════════════════════════════

type Probe = { method: string; path: () => string; body?: unknown };
const ABSENT = '7d1f3c2a-9b4e-4c5d-8e6f-0a1b2c3d4e5f';

/** The dashboard family FIX-A narrowed, and the Reports list whose count it carries. */
const DASHBOARD_FAMILY: Probe[] = [
  { method: 'GET', path: () => '/dashboard/summary' },
  { method: 'GET', path: () => '/dashboard/activity' },
  { method: 'GET', path: () => '/dashboard/active' },
  { method: 'GET', path: () => '/reports?limit=50' },
];

/** Every route family the lens touches: its own neighbours, and what each lens section leads to. */
const TOUCHED_FAMILIES: Probe[] = [
  { method: 'GET', path: () => '/principals/me' },
  { method: 'GET', path: () => '/principals/me/effective-access' },
  { method: 'GET', path: () => '/principals/me/home-group' },
  { method: 'GET', path: () => '/principals/me/directory-group-references' },
  { method: 'GET', path: () => '/principals/me/connectors' },
  { method: 'GET', path: () => '/principals?limit=50' },
  { method: 'GET', path: () => '/directory-group-references' },
  { method: 'GET', path: () => `/directory-group-references/${ABSENT}` },
  { method: 'POST', path: () => `/directory-group-references/${ABSENT}/use`, body: {} },
  { method: 'GET', path: () => '/groups' },
  { method: 'GET', path: () => '/groups/directory-sync' },
  { method: 'GET', path: () => '/identity-providers' },
  { method: 'GET', path: () => '/grants' },
  { method: 'GET', path: () => '/tasks?limit=50' },
  { method: 'GET', path: () => '/projects' },
  { method: 'GET', path: () => `/projects/${PROJECT_MEMBER}` },
  { method: 'GET', path: () => `/projects/${PROJECT_OTHER}` },
  // R-8-c: what the manager arm's "My team" leads to (members, Group roles, team grants).
  { method: 'GET', path: () => `/groups/${STEWARD_GROUP}` },
  { method: 'GET', path: () => `/groups/${STEWARD_GROUP}/members` },
  { method: 'GET', path: () => `/groups/${STEWARD_GROUP}/stewards` },
  { method: 'GET', path: () => `/groups/${STEWARD_GROUP}/grants` },
];

/**
 * Two readings that are not outcomes: a correlation id minted per failure, and
 * the clock reading an authority preview stamps on itself (`evaluatedAt`).
 * Everything else in every body is compared.
 */
const NOT_AN_OUTCOME = new Set(['errorId', 'evaluatedAt']);
function normalised(value: any): any {
  if (Array.isArray(value)) return value.map(normalised);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !NOT_AN_OUTCOME.has(key))
      .map(([key, inner]) => [key, normalised(inner)]));
  }
  return value;
}

/** Where two answers first part, as a JSON path with both values, so a red names its cause. */
function firstDifference(a: any, b: any, at: string): string {
  if (JSON.stringify(a) === JSON.stringify(b)) return '';
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const inner = firstDifference(a[key], b[key], `${at}/${key}`);
      if (inner) return inner;
    }
  }
  return `${at || '/'}: ${JSON.stringify(a)?.slice(0, 120)} != ${JSON.stringify(b)?.slice(0, 120)}`;
}

/** Every caller x every probe, each answered with the lens surface and then, at once, without it. */
async function compare(probes: Probe[]): Promise<{ rows: number; differences: unknown[] }> {
  const differences: unknown[] = [];
  let rows = 0;
  for (const who of R8_MATRIX()) {
    for (const probe of probes) {
      const target = probe.path();
      const withLens = await call(LIVE, who, probe.method, target, probe.body);
      const withoutLens = await withoutLensSurface(() => call(LIVE, who, probe.method, target, probe.body));
      rows += 1;
      const a = { status: withLens.status, body: normalised(withLens.json ?? withLens.text) };
      const b = { status: withoutLens.status, body: normalised(withoutLens.json ?? withoutLens.text) };
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        differences.push({
          who: who.label, route: `${probe.method} ${target}`, withLens: a.status, withoutLens: b.status,
          firstDifference: firstDifference(a, b, ''),
        });
      }
    }
  }
  return { rows, differences };
}

describe('R-8-v1 - every outcome and every body is identical with the lens surface removed', () => {
  it('the comparison can fail: the lens is really gone from the second router, and the dashboard really narrows', async () => {
    // Without the surface there is no lens to give, and restoring it restores it...
    expect((await withoutLensSurface(() => live(MEMBER, 'GET', '/principals/me/lenses'))).status).toBe(500);
    expect((await live(MEMBER, 'GET', '/principals/me/lenses')).status).toBe(200);
    // ...and the dashboard family narrows in its query (FIX-A): the member and
    // the root session are shown different populations, so a lens that changed
    // a caller's population would change a body this control compares.
    const memberSummary = (await live(MEMBER, 'GET', '/dashboard/summary')).json;
    const rootSummary = (await live(ADMIN_SESSION, 'GET', '/dashboard/summary')).json;
    expect(memberSummary?.success).toBe(true);
    expect(rootSummary?.success).toBe(true);
    expect(JSON.stringify(memberSummary)).not.toEqual(JSON.stringify(rootSummary));
    const memberTasks = (await live(MEMBER, 'GET', '/tasks?limit=50')).json;
    const titles = JSON.stringify(memberTasks);
    expect(titles).toContain('lensd member');
    expect(titles).not.toContain('lensd other');
  });

  it('R-8-c: the steward caller really holds the manager arm, so the extended matrix is not vacuous', async () => {
    const answer = await live(STEWARD, 'GET', '/principals/me/lenses');
    expect(answer.status).toBe(200);
    expect(answer.json?.lenses).toEqual(['member', 'manager']);
    expect(answer.json?.manager?.stewardedGroups?.map((row: any) => [row.id, row.role])).toEqual([[STEWARD_GROUP, 'owner']]);
    // ...and its team reads answer through the steward arm, which the comparison then holds still.
    expect((await live(STEWARD, 'GET', `/groups/${STEWARD_GROUP}/grants`)).json?.grants).toHaveLength(1);
  });

  it('the dashboard family (summary, activity, active, the Reports count) answers identically', async () => {
    const { rows, differences } = await compare(DASHBOARD_FAMILY);
    expect(rows).toBe(R8_MATRIX().length * DASHBOARD_FAMILY.length);
    expect(differences).toEqual([]);
  });

  it('every route family the lens touches answers identically', async () => {
    const { rows, differences } = await compare(TOUCHED_FAMILIES);
    expect(rows).toBe(R8_MATRIX().length * TOUCHED_FAMILIES.length);
    expect(differences).toEqual([]);
  });
});
