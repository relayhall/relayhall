/**
 * RH-KW1 candidate C — KNOWLEDGE-DESIGN `94747de9` ACCEPTANCE ITEMS 1 and 11,
 * measured against a REAL PostgreSQL through the PRODUCTION router.
 *
 * ── WHY THIS SUITE IS NOT IN THE DEFAULT JEST RUN ──
 *
 * Item 1 is a property of the SELECTOR forms (`exact`, `all-of-type`,
 * `all-except`) and item 11 is a property of a SQL predicate composed
 * in-query. Every KW1 suite in the default run mocks the pool, and a mocked
 * pool can only replay the rule these two items exist to measure. So this
 * suite connects to `RELAYHALL_TEST_DB_URL` and FAILS — never skips — when it
 * is unset, exactly as `listPointParity.test.ts` (card 08f42f36) does for the
 * same reason. It is excluded by `testPathIgnorePatterns`, runs from
 * `npm run test:knowledge-board` on the gate chain, and runs unconditionally
 * in CI against the `services: postgres` block.
 *
 * ── THE DESTRUCTIVE CONTRACT, STATED ──
 *
 * This suite WRITES to principals, principal_credentials, projects, tasks,
 * reports, skills, skill_versions, services, service_descriptor_versions,
 * grants, access_profiles and their versions/rules/assignments. It refuses any
 * URL naming a deployment database and any non-local host. Bring the database
 * up with `database/init.sql` and `npm run migrate`, and throw it away.
 *
 * ── THE ACTOR THE CONTROLS RUN AS (breakdown `abc71ffb` §2, D-C2) ──
 *
 * `AuthorizationService.sqlCondition` short-circuits TRUE for any actor with
 * NO delegation chain whose role is in `ADMINISTRATOR_ROLES` = {admin,
 * operator, orchestrator}. Every negative clause of item 11 is composed over
 * that predicate, so a control whose caller carries an administrator role
 * CANNOT FAIL — it reports green while proving nothing. The breakdown
 * therefore ASSIGNS the actor: every item-11 control below runs as a
 * principal whose role is `user`, with no delegation chain and no `root`
 * scope. The administrator path is proven separately and is not optional: one
 * positive control on the shipped behaviour, and one MUTATION control on the
 * `!chain` guard itself.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';
import os from 'os';
// A typed import, deliberately: this helper reads and transpiles source files
// and touches no database, so it is safe above the environment pinning that
// keeps every DB-reading module on `require`.
import { loadMutatedModule } from './support/moduleMutation';

// ─────────────────────────── the database contract ───────────────────────────

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error(
    'RELAYHALL_TEST_DB_URL is not set. This gate measures the knowledge fan-out set and the board '
    + 'adapter against a REAL PostgreSQL and refuses to skip: both are SQL predicates, and a mocked '
    + 'pool can only replay the rule. Create a disposable database, load database/init.sql, run '
    + 'npm run migrate, and set RELAYHALL_TEST_DB_URL to it.',
  );
}

const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = parsed.pathname.replace(/^\//, '');
const FORBIDDEN_DATABASES = ['relayhall_dev', 'relayhall_tst', 'relayhall_prod', 'relayhall'];
if (FORBIDDEN_DATABASES.includes(TEST_DB_NAME)) {
  throw new Error(`RELAYHALL_TEST_DB_URL names a deployment database (${TEST_DB_NAME}). This suite writes; point it at a disposable database.`);
}

process.env.DB_HOST = parsed.hostname;
process.env.DB_PORT = parsed.port || '5432';
process.env.DB_NAME = TEST_DB_NAME;
process.env.DB_USER = decodeURIComponent(parsed.username);
process.env.DB_PASSWORD = decodeURIComponent(parsed.password);
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'knowledge-board-suite-secret-0123456789';
process.env.RELAYHALL_KNOWLEDGE_ASSERTION_KEYS = JSON.stringify({
  ka: (crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64'),
});
process.env.RELAYHALL_KNOWLEDGE_ASSERTION_ACTIVE_KEY = 'ka';
process.env.RELAYHALL_KNOWLEDGE_HANDLE_KEYS = JSON.stringify({ h1: crypto.randomBytes(32).toString('base64') });
process.env.RELAYHALL_KNOWLEDGE_HANDLE_ACTIVE_KEY = 'h1';
// The session plane is the caller shape these controls need: a role-`user`
// principal with no delegation chain. It is a deployment flag, so the suite
// turns it on for itself rather than depending on the machine's configuration.
process.env.RELAYHALL_SESSIONS = 'on';

const express = require('express');

const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { executeKnowledgeQuery } = require('../services/KnowledgeFanoutExecutor');
const boardAdapter = require('../services/KnowledgeBoardAdapter');
const { KnowledgeFixtureSource } = require('./support/knowledgeFixtureSource');

jest.setTimeout(240_000);

// ──────────────────────────────── the app ────────────────────────────────────

let server: http.Server;
let origin: string;

function buildApp(): any {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  return app;
}

interface Caller {
  label: string;
  principalId: string;
  headers: Record<string, string>;
  /** The session the cookie resolves to — what `middleware/auth` stamps on the request. */
  sessionId: string;
}

async function search(who: Caller, body: Record<string, unknown> = {}): Promise<any> {
  const response = await fetch(`${origin}/knowledge-queries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...who.headers },
    body: JSON.stringify({ q: NEEDLE, ...body }),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json };
}

async function readContents(who: Caller, handle: string): Promise<any> {
  const response = await fetch(`${origin}/knowledge-contents?handle=${encodeURIComponent(handle)}`, {
    headers: who.headers,
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json };
}

// ────────────────────────────── the fixtures ─────────────────────────────────

const tag = (): string => crypto.randomBytes(6).toString('hex');
/** Every fixture row carries this, so a shared database's leftovers cannot join a drill. */
const NEEDLE = `kw1needle${crypto.randomBytes(4).toString('hex')}`;

const KNOWLEDGE_SCOPE = 'knowledge-contents:read';
const BOARD_SCOPES = ['reports:read', 'tasks:read', 'skills:read', 'skills:use'];

function firstExternalIpv4(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

const alpha = new KnowledgeFixtureSource('kw1-board-suite-alpha');
const beta = new KnowledgeFixtureSource('kw1-board-suite-beta');
let fixtureHost: string;

let SOURCE_ALPHA: string;
let SOURCE_BETA: string;
let BOARD_SOURCE: string;
/**
 * Every source THIS RUN created, plus the reserved board row.
 *
 * The selector equalities below run over this set. A disposable database is
 * not necessarily an empty one, and an equality over "every knowledge-capable
 * Service in the database" would measure a previous run's rows rather than the
 * selector under test.
 */
const RUN_SOURCES = new Set<string>();

let ROOT_PRINCIPAL: string;
/** The item-11 actor: role `user`, no chain, no root scope. */
let USER_A: Caller;
let USER_B: Caller;
/** The administrator path, proven separately. */
let OPERATOR: Caller;

let REPORT_READABLE: string;
let TASK_READABLE: string;
let SKILL_ID: string;

async function makeAccount(role: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $2, 'active', $3) RETURNING id`,
    [`kw1board-${role}-${tag()}`, `kw1 board ${role}`, role],
  );
  return String(result.rows[0].id);
}

/**
 * A login session, exactly as the SSO return path mints one: an httpOnly
 * cookie, no bearer credential anywhere, and therefore NO delegation chain —
 * which is the actor item 11's controls are assigned.
 */
async function callerFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return {
    label,
    principalId,
    sessionId: String(minted.sessionId),
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` },
  };
}

/** A knowledge-capable external Service, dialing one of the two fixtures. */
async function makeSource(slug: string, port: number, credentialRef: string): Promise<string> {
  const service = await pool.query(
    `INSERT INTO services (slug, name, description, kind, status, runtime_mode,
                           knowledge_query_endpoint, knowledge_claims_mode,
                           knowledge_subject_mode, knowledge_allowed_networks,
                           knowledge_core_credential_ref, current_descriptor_version)
     VALUES ($1, $2, '', 'service', 'published', 'direct', $3, 'asserted', 'pairwise',
             $4::text[], $5, 1)
     RETURNING id`,
    [slug, slug, `https://${fixtureHost}:${port}/knowledge/query`, [`${fixtureHost}/32`], credentialRef],
  );
  const id = String(service.rows[0].id);
  RUN_SOURCES.add(id);
  const descriptor = {
    options: [],
    knowledgeSource: { classes: [{ key: 'docs', content: 'docs' }], compartments: ['corpus'] },
  };
  await pool.query(
    `INSERT INTO service_descriptor_versions (service_id, version, descriptor, content_hash)
     VALUES ($1, 1, $2::jsonb, $3)`,
    [id, JSON.stringify(descriptor), crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex')],
  );
  return id;
}

/** An access profile granting one selector form over `service` rows. */
async function assignServiceSelector(
  principalId: string,
  form: 'exact' | 'all-of-type' | 'all-except',
  ids: string[],
): Promise<void> {
  const profile = await pool.query(
    'INSERT INTO access_profiles (name, description) VALUES ($1, $2) RETURNING id',
    [`kw1-board-${form}-${tag()}`, 'kw1 board suite'],
  );
  const profileId = String(profile.rows[0].id);
  const version = await pool.query(
    'INSERT INTO access_profile_versions (profile_id, version_number) VALUES ($1, 1) RETURNING id',
    [profileId],
  );
  const versionId = String(version.rows[0].id);
  await pool.query(
    `INSERT INTO access_profile_rules (version_id, resource_type, selector_form, selector_ids, verbs)
     VALUES ($1, 'service', $2, $3::uuid[], ARRAY['read'])`,
    [versionId, form, ids],
  );
  await pool.query('UPDATE access_profiles SET published_version_id = $1 WHERE id = $2', [versionId, profileId]);
  await pool.query(
    `INSERT INTO access_profile_assignments (profile_id, assignee_type, assignee_id)
     VALUES ($1, 'principal', $2)`,
    [profileId, principalId],
  );
}

/** Remove every service selector this principal holds. */
async function clearServiceSelectors(principalId: string): Promise<void> {
  await pool.query(
    'DELETE FROM access_profile_assignments WHERE assignee_type = $1 AND assignee_id = $2',
    ['principal', principalId],
  );
}

beforeAll(async () => {
  const address = firstExternalIpv4();
  // A skip would be a suite that cannot fail: §4.2 refuses loopback
  // unconditionally, so the fixtures must bind somewhere allow-listable.
  expect(address).not.toBeNull();
  fixtureHost = address as string;
  await alpha.start(fixtureHost);
  await beta.start(fixtureHost);
  process.env.RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS = JSON.stringify({
    'alpha/core': { bearer: 'core-to-alpha' },
    'beta/core': { bearer: 'core-to-beta' },
  });

  ROOT_PRINCIPAL = await makeAccount('admin');

  SOURCE_ALPHA = await makeSource(`kw1alpha${tag()}`, alpha.port, 'alpha/core');
  SOURCE_BETA = await makeSource(`kw1beta${tag()}`, beta.port, 'beta/core');
  const board = await pool.query("SELECT id FROM services WHERE slug = 'board'");
  // §9's reserved row is written by migration 116. Its absence is a failure of
  // this deployment, not a reason to skip the board half of item 1.
  expect(board.rows).toHaveLength(1);
  BOARD_SOURCE = String(board.rows[0].id);
  RUN_SOURCES.add(BOARD_SOURCE);

  const userAId = await makeAccount('user');
  const userBId = await makeAccount('user');
  const operatorId = await makeAccount('operator');
  USER_A = await callerFor('user-a', userAId);
  USER_B = await callerFor('user-b', userBId);
  OPERATOR = await callerFor('operator', operatorId);

  // Board rows: one A may read through exactly ONE arm (a grant), one A may
  // not read at all, one Task A owns, one Skill.
  const readable = await pool.query(
    `INSERT INTO reports (title, content, summary, visibility, author_principal_id)
     VALUES ($1, $2, $3, 'private', $4) RETURNING id`,
    [`readable ${NEEDLE}`, `body ${NEEDLE}`, `summary ${NEEDLE}`, ROOT_PRINCIPAL],
  );
  REPORT_READABLE = String(readable.rows[0].id);
  // The row no arm of A's reaches. Named by TITLE in the drills, because what
  // matters is that it never appears — not which id it has.
  await pool.query(
    `INSERT INTO reports (title, content, summary, visibility, author_principal_id)
     VALUES ($1, $2, $3, 'private', $4)`,
    [`hidden ${NEEDLE}`, `body ${NEEDLE}`, `summary ${NEEDLE}`, ROOT_PRINCIPAL],
  );
  await pool.query(
    `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id)
     VALUES ('principal', $1, 'report', $2, 'read', $3)`,
    [USER_A.principalId, REPORT_READABLE, ROOT_PRINCIPAL],
  );

  const task = await pool.query(
    `INSERT INTO tasks (title, status, visibility, owner_principal_id, creator_principal_id)
     VALUES ($1, 'todo', 'private', $2, $2) RETURNING id`,
    [`task ${NEEDLE}`, USER_A.principalId],
  );
  TASK_READABLE = String(task.rows[0].id);

  const skill = await pool.query(
    'INSERT INTO skills (name) VALUES ($1) RETURNING id',
    [`skill ${NEEDLE}`],
  );
  SKILL_ID = String(skill.rows[0].id);
  const version = await pool.query(
    `INSERT INTO skill_versions (skill_id, version, skill_md, description, provenance,
                                 created_by_principal_id)
     VALUES ($1, 1, $2, $3, 'human-authored', $4) RETURNING id`,
    [SKILL_ID, `# ${NEEDLE}`, `skill about ${NEEDLE}`, ROOT_PRINCIPAL],
  );
  await pool.query('UPDATE skills SET current_published_version_id = $1 WHERE id = $2',
    [String(version.rows[0].id), SKILL_ID]);

  const app = buildApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${(server.address() as any).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await alpha.stop();
  await beta.stop();
  await pool.end();
});

beforeEach(() => {
  jest.restoreAllMocks();
  alpha.reset();
  beta.reset();
  alpha.behaviour = { status: 200, body: '{"results":[]}' };
  beta.behaviour = { status: 200, body: '{"results":[]}' };
});

const consultedOf = (answer: any): string[] => [...(answer.json?.coverage?.consulted ?? [])].sort();
/** The computed set, narrowed to the sources this run created. */
const runConsulted = (response: any): string[] =>
  [...(response.coverage?.consulted ?? [])].filter((id: string) => RUN_SOURCES.has(id)).sort();

// ═══════════ item 1 — the fan-out set is a PROVEN property ════════════════

describe('§5.5 / item 1 — the caller × selector table, over real selectors', () => {
  afterEach(async () => {
    await clearServiceSelectors(USER_A.principalId);
  });

  it('exact: the computed set is exactly the named source', async () => {
    await assignServiceSelector(USER_A.principalId, 'exact', [SOURCE_ALPHA]);
    const answer = await searchDialing(USER_A);
    expect(runConsulted(answer)).toEqual([SOURCE_ALPHA]);
    // The channel half: exactly the EXTERNAL member was dialed.
    expect(alpha.requests).toHaveLength(1);
    expect(beta.requests).toHaveLength(0);
  });

  it('all-of-type: every capable source, including one configured AFTER the grant', async () => {
    await assignServiceSelector(USER_A.principalId, 'all-of-type', []);
    const late = await makeSource(`kw1late${tag()}`, alpha.port, 'alpha/core');
    const answer = await searchDialing(USER_A);
    // Future-inclusive by construction: the selector names a TYPE, so a row
    // created after the assignment is inside it without a second act.
    expect(runConsulted(answer)).toEqual([SOURCE_ALPHA, SOURCE_BETA, BOARD_SOURCE, late].sort());
    await pool.query('DELETE FROM service_descriptor_versions WHERE service_id = $1', [late]);
    await pool.query('DELETE FROM services WHERE id = $1', [late]);
    RUN_SOURCES.delete(late);
  });

  it('all-except: the excluded source is absent, and nothing was sent to it', async () => {
    await assignServiceSelector(USER_A.principalId, 'all-except', [SOURCE_BETA]);
    const answer = await searchDialing(USER_A);
    expect(runConsulted(answer)).toEqual([SOURCE_ALPHA, BOARD_SOURCE].sort());
    expect(answer.coverage.consulted).not.toContain(SOURCE_BETA);
    expect(beta.requests).toHaveLength(0);
  });

  it('sources[]-narrowed: the narrowing is applied INSIDE the covered set', async () => {
    await assignServiceSelector(USER_A.principalId, 'all-of-type', []);
    const answer = await searchDialing(USER_A, { sources: [SOURCE_BETA] });
    // The narrowing is absolute, not scoped: naming one source means one
    // source, whatever else the database holds.
    expect([...answer.coverage.consulted].sort()).toEqual([SOURCE_BETA]);
    expect(alpha.requests).toHaveLength(0);
    expect(beta.requests).toHaveLength(1);
  });

  it('a source outside the selector is UNDISCLOSED ABSOLUTELY — not named, not dialed', async () => {
    await assignServiceSelector(USER_A.principalId, 'exact', [SOURCE_ALPHA]);
    const answer = await searchDialing(USER_A);
    const serialized = JSON.stringify(answer);
    expect(serialized).not.toContain(SOURCE_BETA);
    expect(serialized).not.toContain(BOARD_SOURCE);
    expect(beta.requests).toHaveLength(0);
    // The design's "visibility-only-denied" row is UNREACHABLE for `service`
    // rows and this is where that is recorded: `sqlResource('service')` sets
    // visibility to the SQL literal `'shared'`
    // (`AuthorizationRepository.ts`), so limb (b) answers TRUE for every
    // authenticated caller and cannot deny a source on visibility alone. That
    // is candidate A's round-1 finding S2-B1, and it is why limb (c) — the
    // A21 selector asked here — is the operative refusal.
  });

  it('the board row is RUNNABLE: it joins the set like any other source and answers in-process', async () => {
    await assignServiceSelector(USER_A.principalId, 'exact', [BOARD_SOURCE]);
    const spy = jest.spyOn(boardAdapter, 'searchBoard');
    const answer = await search(USER_A);
    expect(answer.status).toBe(200);
    expect(consultedOf(answer)).toEqual([BOARD_SOURCE]);
    // The in-process adapter ran exactly once, and NOTHING was dialed.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(alpha.requests).toHaveLength(0);
    expect(beta.requests).toHaveLength(0);
    // The same-run positive control: the board group carries the readable
    // Report, so the run that proves the concealments also proves a read.
    const groups = answer.json.groups;
    const board = groups.find((group: any) => group.sourceId === BOARD_SOURCE);
    expect(board.results.length).toBeGreaterThan(0);
  });

  it('the adapter is invoked IFF board is in the computed set', async () => {
    await assignServiceSelector(USER_A.principalId, 'exact', [SOURCE_ALPHA]);
    const spy = jest.spyOn(boardAdapter, 'searchBoard');
    await search(USER_A);
    expect(spy).not.toHaveBeenCalled();
  });

  it('MUTATION: an executor that always invokes the adapter fails the board-absent drill', async () => {
    await assignServiceSelector(USER_A.principalId, 'exact', [SOURCE_ALPHA]);
    const mutated = loadMutatedModule<typeof import('../services/KnowledgeFanoutExecutor')>(
      'services/KnowledgeFanoutExecutor.ts',
      [{ find: '  if (isBoardSource(source.row.slug)) {', replace: '  if (true) {' }],
    );
    const req = await requestFor(USER_A);
    const response = await mutated.executeKnowledgeQuery(req, {
      q: NEEDLE, kinds: ['code', 'docs', 'data'], limitPerSource: 8, timeoutMs: 3000,
    } as never, { issuer: 'https://relayhall.test', callerGroupIds: [] });
    // The mutant answered the EXTERNAL source in-process: nothing was dialed,
    // which is exactly what the honest drill asserts must not happen.
    expect(alpha.requests).toHaveLength(0);
    expect(response.coverage.consulted).toEqual([SOURCE_ALPHA]);
  });

  it('MUTATION: an executor that never invokes the adapter fails the board-present drill', async () => {
    await assignServiceSelector(USER_A.principalId, 'exact', [BOARD_SOURCE]);
    const mutated = loadMutatedModule<typeof import('../services/KnowledgeFanoutExecutor')>(
      'services/KnowledgeFanoutExecutor.ts',
      [{ find: '  if (isBoardSource(source.row.slug)) {', replace: '  if (false) {' }],
    );
    const req = await requestFor(USER_A);
    const response = await mutated.executeKnowledgeQuery(req, {
      q: NEEDLE, kinds: ['code', 'docs', 'data'], limitPerSource: 8, timeoutMs: 3000,
    } as never, { issuer: 'https://relayhall.test', callerGroupIds: [] });
    // With the board branch gone the reserved row has no endpoint, so it is
    // dropped instead of answered: the board-present drill's assertion that
    // the group exists would fail.
    expect(response.groups.find((group: { sourceId: string }) => group.sourceId === BOARD_SOURCE))
      .toBeUndefined();
  });
});

/**
 * Run one query as this principal, dialing the fixtures.
 *
 * The TEST-ONLY trust anchors (owner decision D7(a)) are the reason this is a
 * direct call rather than an HTTP one: production never passes them, which is
 * exactly the property candidate A drills, and a self-signed fixture is
 * therefore unreachable through the route.
 */
async function searchDialing(who: Caller, request: Record<string, unknown> = {}): Promise<any> {
  const req = await requestFor(who);
  return executeKnowledgeQuery(req, {
    q: NEEDLE, kinds: ['code', 'docs', 'data'], limitPerSource: 8, timeoutMs: 3000, ...request,
  }, {
    issuer: 'https://relayhall.test',
    callerGroupIds: [],
    trustAnchors: [alpha.certificate.cert, beta.certificate.cert],
  });
}

/**
 * Run one query as this principal with an EXPLICIT scope list.
 *
 * Used where a control must vary the scope half while holding the principal —
 * and therefore the predicate half — constant.
 */
async function runAs(who: Caller, scopes: string[]): Promise<any> {
  const req = await requestFor(who, scopes);
  return executeKnowledgeQuery(req, {
    q: NEEDLE, kinds: ['code', 'docs', 'data'], limitPerSource: 8, timeoutMs: 3000,
  }, { issuer: 'https://relayhall.test', callerGroupIds: [] });
}

/** A request object carrying the caller's real actor, for the mutation drills. */
async function requestFor(who: Caller, scopeList?: string[]): Promise<any> {
  const principal = await pool.query('SELECT id, handle, role FROM principals WHERE id = $1', [who.principalId]);
  const row = principal.rows[0];
  const scopes = scopeList ?? [KNOWLEDGE_SCOPE, ...BOARD_SCOPES];
  return {
    principal: { id: String(row.id), handle: row.handle, role: row.role },
    userId: row.handle,
    credentialId: null,
    // The middleware stamps both of these for a resolved login session, and
    // `sessionRole` is NULL for an SSO-minted one — which is the shape §5.2's
    // arm 2 has to accept, and the reason it asks for the session rather than
    // for its role snapshot.
    sessionId: who.sessionId,
    sessionRole: null,
    scopes,
    authorizationActor: {
      principalId: String(row.id),
      handle: row.handle,
      role: row.role,
      scopes,
      authenticated: true,
      delegation: null,
    },
  };
}

// ═══════════ item 11 — the board pseudo-source, in-query ══════════════════

describe('§9 / item 11 — the board adapter draws from AUTHORIZED rows, in-query', () => {
  beforeEach(async () => {
    await clearServiceSelectors(USER_A.principalId);
    await clearServiceSelectors(USER_B.principalId);
    await clearServiceSelectors(OPERATOR.principalId);
    await assignServiceSelector(USER_A.principalId, 'exact', [BOARD_SOURCE]);
    await assignServiceSelector(USER_B.principalId, 'exact', [BOARD_SOURCE]);
    await assignServiceSelector(OPERATOR.principalId, 'exact', [BOARD_SOURCE]);
  });

  const boardResults = (answer: any): any[] =>
    (answer.json.groups.find((group: any) => group.sourceId === BOARD_SOURCE)?.results ?? []);

  it('shared predicate, POSITIVE and NEGATIVE, as a role-`user` principal with one arm each', async () => {
    const answer = await search(USER_A);
    const titles = boardResults(answer).map((result: any) => result.title);
    // POSITIVE: readable through exactly ONE arm — a grant — so a green row
    // names which arm passed.
    expect(titles).toContain(`readable ${NEEDLE}`);
    // NEGATIVE: the same corpus, the same query, no arm.
    expect(titles).not.toContain(`hidden ${NEEDLE}`);
  });

  it('the negative control runs on a REPORT, because a Skill cannot fail on the predicate half', async () => {
    // Finding F4: `sqlResource('skill')` sets visibility to the literal
    // 'shared', so the predicate half is vacuous for Skills — a
    // "shared-predicate negative control" written on a Skill CANNOT fail.
    // This assertion states the substrate fact the control avoids.
    const repository = require('../services/AuthorizationRepository');
    expect(repository.authorizationRepository.sqlResource('skill').resource.visibility).toBe("'shared'");
    expect(repository.authorizationRepository.sqlResource('report').resource.visibility).toBe('r.visibility');
  });

  it('composed scope, POSITIVE and NEGATIVE: object grants but NO reports:read gets nothing from the reports group', async () => {
    // The SAME principal, with the SAME grant, differing only in the scope
    // list — so a difference between the two runs isolates the SCOPE half of
    // §5.1's composition from the predicate half. The executor is called
    // directly because a login session's scopes are derived from its role and
    // cannot be narrowed; the route path is exercised by every other drill.
    const withReports = await runAs(USER_A, [KNOWLEDGE_SCOPE, ...BOARD_SCOPES]);
    const withoutReports = await runAs(USER_A, [KNOWLEDGE_SCOPE, 'tasks:read']);

    const titlesOf = (response: any): string[] =>
      (response.groups.find((group: any) => group.sourceId === BOARD_SOURCE)?.results ?? [])
        .map((result: any) => result.title);

    // POSITIVE: with `reports:read`, the granted Report is in the group.
    expect(titlesOf(withReports)).toContain(`readable ${NEEDLE}`);
    // NEGATIVE: without it, the same row is gone — and the caller still sees
    // its Tasks, so this proves a narrowing rather than an empty response.
    expect(titlesOf(withoutReports)).not.toContain(`readable ${NEEDLE}`);
    expect(titlesOf(withoutReports)).toContain(`task ${NEEDLE}`);
  });

  it('no count oracle: two corpora differing only by unreadable matching rows answer identically', async () => {
    const before = await search(USER_A);
    const extra = await pool.query(
      `INSERT INTO reports (title, content, summary, visibility, author_principal_id)
       VALUES ($1, $2, $3, 'private', $4) RETURNING id`,
      [`extra hidden ${NEEDLE}`, `body ${NEEDLE}`, `summary ${NEEDLE}`, ROOT_PRINCIPAL],
    );
    const after = await search(USER_A);
    await pool.query('DELETE FROM reports WHERE id = $1', [String(extra.rows[0].id)]);

    const strip = (answer: any): string => JSON.stringify({
      coverage: answer.json.coverage,
      groups: answer.json.groups.map((group: any) => ({
        sourceId: group.sourceId,
        // Handles carry a random IV per seal, so they differ between two runs
        // of the same query by construction; everything else must not.
        results: group.results.map((result: any) => ({ ...result, handle: null, parentHandle: null })),
      })),
    });
    expect(strip(after)).toEqual(strip(before));
  });

  it('a board handle for a report A may read is refused when B presents it', async () => {
    const answer = await search(USER_A);
    const readable = boardResults(answer).find((result: any) => result.title === `readable ${NEEDLE}`);
    expect(readable).toBeDefined();
    const mine = await readContents(USER_A, readable.handle);
    expect(mine.status).toBe(200);
    expect(mine.json.content).toContain(NEEDLE);

    const theirs = await readContents(USER_B, readable.handle);
    expect(theirs.status).toBe(403);
    expect(theirs.json.refused).toBe('not_authorized');
  });

  it("A's OWN handle is refused once A loses read", async () => {
    const answer = await search(USER_A);
    const readable = boardResults(answer).find((result: any) => result.title === `readable ${NEEDLE}`);
    const before = await readContents(USER_A, readable.handle);
    expect(before.status).toBe(200);

    await pool.query(
      "DELETE FROM grants WHERE grantee_id = $1 AND resource_id = $2 AND resource_type = 'report'",
      [USER_A.principalId, REPORT_READABLE],
    );
    const after = await readContents(USER_A, readable.handle);
    expect(after.status).toBe(403);
    expect(after.json.refused).toBe('not_authorized');
    // Restore, so the drills that follow keep their positive arm.
    await pool.query(
      `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id)
       VALUES ('principal', $1, 'report', $2, 'read', $3)`,
      [USER_A.principalId, REPORT_READABLE, ROOT_PRINCIPAL],
    );
  });

  // ── the administrator path, proven SEPARATELY and not optionally ──

  it('POSITIVE CONTROL on the shipped behaviour: a non-delegated operator IS unfiltered by the predicate', async () => {
    const answer = await search(OPERATOR);
    const titles = boardResults(answer).map((result: any) => result.title);
    // INTENDED shipped behaviour: `sqlCondition` short-circuits TRUE for a
    // non-delegated administrator role, so the operator sees the report no
    // grant of theirs covers. Asserted here so no later reader mistakes the
    // role-`user` controls above for a claim that administrators are filtered.
    expect(titles).toContain(`hidden ${NEEDLE}`);
  });

  it('MUTATION CONTROL on the guard itself: with `!chain &&` deleted, a DELEGATED administrator takes the arm', async () => {
    const shipped = require('../services/AuthorizationService');
    const mutated = loadMutatedModule<typeof import('../services/AuthorizationService')>(
      'services/AuthorizationService.ts',
      [{
        find: '      && !chain && ADMINISTRATOR_ROLES.has(String(actor.role || \'\').toLowerCase())) {',
        replace: '      && ADMINISTRATOR_ROLES.has(String(actor.role || \'\').toLowerCase())) {',
      }],
    );
    const delegatedOperator = {
      principalId: OPERATOR.principalId,
      handle: 'delegated-operator',
      role: 'operator',
      scopes: [KNOWLEDGE_SCOPE],
      authenticated: true,
      // A REAL two-link chain: the shipped `DelegationActorLink` shape, not a
      // convenient subset. `chain` is derived from `links.length > 1` and a
      // non-legacy root, so a chain that omitted fields would be a different
      // object than the one production hands the predicate.
      delegation: {
        links: [
          {
            kind: 'human',
            principalId: ROOT_PRINCIPAL,
            role: 'admin',
            parentPrincipalId: null,
            boundTaskId: null,
            legacyIdentity: false,
            ownExpression: { scopes: 'parent' as const, objects: 'parent' as const },
          },
          {
            kind: 'agent',
            principalId: OPERATOR.principalId,
            role: 'operator',
            parentPrincipalId: ROOT_PRINCIPAL,
            boundTaskId: null,
            legacyIdentity: false,
            ownExpression: { scopes: 'parent' as const, objects: 'parent' as const },
          },
        ],
      },
    };
    // READ from the shipped map rather than restated here: a control that
    // hand-copies the resource shape cannot notice the shape changing.
    const { resource } = require('../services/AuthorizationRepository')
      .authorizationRepository.sqlResource('report');
    const shippedSql = shipped.authorizationService.sqlCondition(delegatedOperator, 'read', resource, 2).sql;
    const mutantSql = mutated.authorizationService.sqlCondition(delegatedOperator, 'read', resource, 2).sql;
    // The shipped guard keeps a PARENTED identity out of the administrator
    // arm; the mutant hands it the unconditional TRUE. Nothing else in the
    // suite would notice the guard disappearing.
    expect(mutantSql).toBe('TRUE');
    expect(shippedSql).not.toBe('TRUE');
  });

  it('the two post-SQL report filters are composed IN-QUERY, with a positive and a negative arm', async () => {
    // F3 limb 2: an auto-promoted report survives only if its SOURCE TASK is
    // readable. A's Task is readable by A and by nobody else here.
    const promoted = await pool.query(
      `INSERT INTO reports (title, content, summary, visibility, author_principal_id,
                            auto_promoted, source_task_id)
       VALUES ($1, $2, $3, 'private', $4, TRUE, $5) RETURNING id`,
      [`promoted ${NEEDLE}`, `body ${NEEDLE}`, `summary ${NEEDLE}`, ROOT_PRINCIPAL, TASK_READABLE],
    );
    const promotedId = String(promoted.rows[0].id);
    await pool.query(
      `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id)
       VALUES ('principal', $1, 'report', $2, 'read', $3), ('principal', $4, 'report', $2, 'read', $3)`,
      [USER_A.principalId, promotedId, ROOT_PRINCIPAL, USER_B.principalId],
    );

    // POSITIVE: A owns the source Task, so the promoted report survives.
    const mine = await search(USER_A);
    expect(boardResults(mine).map((result: any) => result.title)).toContain(`promoted ${NEEDLE}`);

    // NEGATIVE: B holds the SAME report grant and cannot read the source Task,
    // so the shipped filter's rule — expressed here as an in-query EXISTS —
    // must still hide it.
    const theirs = await search(USER_B);
    expect(boardResults(theirs).map((result: any) => result.title)).not.toContain(`promoted ${NEEDLE}`);

    // F3 limb 3: an `assigned-only` outpost promotion needs an assignment row.
    // The precondition, established rather than assumed: this Task must carry
    // NO assignment for the `assigned-only` arm to be the thing under test.
    await pool.query('DELETE FROM task_assignments WHERE task_id = $1', [TASK_READABLE]);
    await pool.query(
      "UPDATE reports SET source_outpost_visibility_tier = 'assigned-only' WHERE id = $1",
      [promotedId],
    );
    const restricted = await search(USER_A);
    expect(boardResults(restricted).map((result: any) => result.title)).not.toContain(`promoted ${NEEDLE}`);

    // `shepherd_principal_id` is NOT NULL in the shipped table, so the row is
    // written the way the product writes one.
    await pool.query(
      `INSERT INTO task_assignments (task_id, claimant_principal_id, shepherd_principal_id)
       VALUES ($1, $2, $2)
       ON CONFLICT (task_id) DO UPDATE SET claimant_principal_id = EXCLUDED.claimant_principal_id`,
      [TASK_READABLE, USER_A.principalId],
    );
    const assigned = await search(USER_A);
    expect(boardResults(assigned).map((result: any) => result.title)).toContain(`promoted ${NEEDLE}`);

    await pool.query('DELETE FROM grants WHERE resource_id = $1', [promotedId]);
    await pool.query('DELETE FROM reports WHERE id = $1', [promotedId]);
    await pool.query('DELETE FROM task_assignments WHERE task_id = $1', [TASK_READABLE]);
  });
});


// ═══════ item 2's revocation clause, and item 13's restart clauses ════════

describe('§5.5 / §8.1 / items 2 and 13 — revocation is very-next-call, and a restart decides nothing new', () => {
  beforeEach(async () => {
    await clearServiceSelectors(USER_A.principalId);
  });

  it('revoking the selector between two searches refuses the SECOND at core', async () => {
    await assignServiceSelector(USER_A.principalId, 'exact', [SOURCE_ALPHA]);
    alpha.behaviour = { status: 200, body: '{"results":[]}' };
    const first = await searchDialing(USER_A);
    expect(runConsulted(first)).toEqual([SOURCE_ALPHA]);
    expect(alpha.requests).toHaveLength(1);

    // The revocation. No cache to wait for and no TTL to expire: §5.2's arm
    // set is re-evaluated per request, so the very next call is the one that
    // must refuse.
    await clearServiceSelectors(USER_A.principalId);
    const second = await searchDialing(USER_A);
    expect(runConsulted(second)).toEqual([]);
    // …and the source is UNDISCLOSED, not named as refused (§5.5).
    expect(JSON.stringify(second)).not.toContain(SOURCE_ALPHA);
    // Nothing was sent on the second call.
    expect(alpha.requests).toHaveLength(1);
  });

  it('a RESTART between search and get changes the decision for no unchanged caller', async () => {
    await assignServiceSelector(USER_A.principalId, 'exact', [BOARD_SOURCE]);
    const answer = await search(USER_A);
    const readable = (answer.json.groups.find((group: any) => group.sourceId === BOARD_SOURCE)?.results ?? [])
      .find((result: any) => result.title === `readable ${NEEDLE}`);
    expect(readable).toBeDefined();

    // THE RESTART. Every module is dropped and re-imported, which is what a
    // process restart does to this deployment: the AEAD and assertion keys
    // come from CONFIGURATION (§8.1, BD-2), so a handle minted before the
    // restart is still readable after it — the decision is authority, not
    // stored state.
    jest.resetModules();
    const afterRestart = await readContents(USER_A, readable.handle);
    expect(afterRestart.status).toBe(200);
    expect(afterRestart.json.content).toContain(NEEDLE);
  });

  it('…and REFUSES a caller revoked during the restart', async () => {
    await assignServiceSelector(USER_A.principalId, 'exact', [BOARD_SOURCE]);
    const answer = await search(USER_A);
    const readable = (answer.json.groups.find((group: any) => group.sourceId === BOARD_SOURCE)?.results ?? [])
      .find((result: any) => result.title === `readable ${NEEDLE}`);

    await pool.query(
      "DELETE FROM grants WHERE grantee_id = $1 AND resource_id = $2 AND resource_type = 'report'",
      [USER_A.principalId, REPORT_READABLE],
    );
    jest.resetModules();
    const afterRestart = await readContents(USER_A, readable.handle);
    expect(afterRestart.status).toBe(403);
    expect(afterRestart.json.refused).toBe('not_authorized');

    await pool.query(
      `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id)
       VALUES ('principal', $1, 'report', $2, 'read', $3)`,
      [USER_A.principalId, REPORT_READABLE, ROOT_PRINCIPAL],
    );
  });

  it('no assertion and no source content is readable from ANY store afterwards', async () => {
    await assignServiceSelector(USER_A.principalId, 'exact', [SOURCE_ALPHA]);
    const secret = `source-authored-content-${crypto.randomBytes(6).toString('hex')}`;
    alpha.behaviour = {
      status: 200,
      body: JSON.stringify({
        results: [{
          ref: `/docs/${secret}.md`,
          title: secret,
          snippet: secret,
          contentKind: 'docs',
          compartment: 'corpus',
          score: 0.5,
        }],
      }),
    };
    await searchDialing(USER_A);
    const assertion = JSON.parse(alpha.requests[alpha.requests.length - 1].body).assertion as string;
    expect(typeof assertion).toBe('string');

    // THE CENSUS. Every text-ish column of every table in the schema is asked
    // whether it holds the assertion or the source-authored bytes — the
    // question §11.13 asks, over the whole store rather than over the tables
    // this feature happens to know about. The exceptions are the ones the
    // design names: the audit ledger (§7.7) and the bounded jti seen-set
    // (§5.2), and they are excluded BY NAME so the census cannot be widened
    // into vacuity by accident.
    const EXCEPTED = ['knowledge_search_audit', 'knowledge_get_audit', 'knowledge_assertion_jti'];
    const columns = await pool.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type IN ('text', 'character varying', 'jsonb', 'json')
        ORDER BY table_name, column_name`,
    );
    const hits: string[] = [];
    for (const column of columns.rows as Array<{ table_name: string; column_name: string }>) {
      if (EXCEPTED.includes(column.table_name)) continue;
      const found = await pool.query(
        `SELECT 1 FROM "${column.table_name}"
          WHERE "${column.column_name}"::text LIKE $1 OR "${column.column_name}"::text LIKE $2
          LIMIT 1`,
        [`%${assertion.slice(0, 40)}%`, `%${secret}%`],
      );
      if (found.rows.length > 0) hits.push(`${column.table_name}.${column.column_name}`);
    }
    expect(hits).toEqual([]);

    // The control on the census itself: the audit ledger DOES hold the query
    // text, so a census that found nothing anywhere would be measuring a
    // broken query rather than a stateless broker.
    const audited = await pool.query(
      'SELECT 1 FROM knowledge_search_audit WHERE query_text = $1 LIMIT 1',
      [NEEDLE],
    );
    expect(audited.rows).toHaveLength(1);
  });
});


// ══════ the round-1 repairs that need real rows, each with its proof ══════

describe('round-1 P3, P5, P6 and the LIMIT controls — over real board rows', () => {
  beforeEach(async () => {
    await clearServiceSelectors(USER_A.principalId);
    await assignServiceSelector(USER_A.principalId, 'exact', [BOARD_SOURCE]);
  });

  const boardGroup = (answer: any): any =>
    answer.json.groups.find((group: any) => group.sourceId === BOARD_SOURCE);

  it('P3 — the board obeys limitPerSource ACROSS its three compartments', async () => {
    // One match in each of reports, tasks and skills — the fixtures created in
    // beforeAll are exactly that. Before the repair this returned three.
    const answer = await search(USER_A, { limitPerSource: 1 });
    expect(boardGroup(answer).results).toHaveLength(1);
    // …and the cut is a TRUNCATION, named as one, not a silent absence.
    expect(answer.json.coverage.truncatedResults).toContain(BOARD_SOURCE);
    expect(answer.json.coverage.answered).toContain(BOARD_SOURCE);
  });

  it('P3 — a limit large enough for every compartment truncates nothing', async () => {
    const answer = await search(USER_A, { limitPerSource: 25 });
    expect(boardGroup(answer).results.length).toBeGreaterThanOrEqual(3);
    expect(answer.json.coverage.truncatedResults).not.toContain(BOARD_SOURCE);
  });

  it('the LIMIT follows the predicate: unreadable rows ordered AHEAD do not consume it', async () => {
    // Five reports the caller cannot read, each newer than the readable one,
    // so a filter-after-page implementation would spend the whole page on them
    // and return nothing.
    const noise: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const row = await pool.query(
        `INSERT INTO reports (title, content, summary, visibility, author_principal_id, updated_at)
         VALUES ($1, $2, $3, 'private', $4, now() + ($5 || ' minutes')::interval) RETURNING id`,
        [`unreadable ${index} ${NEEDLE}`, `body ${NEEDLE}`, `summary ${NEEDLE}`, ROOT_PRINCIPAL, String(index + 1)],
      );
      noise.push(String(row.rows[0].id));
    }
    try {
      const answer = await search(USER_A, { limitPerSource: 1, kinds: ['docs'] });
      const titles = boardGroup(answer).results.map((result: any) => result.title);
      expect(titles).toHaveLength(1);
      // The one row that survives is a row the caller may read — never one of
      // the five that sorted ahead of it.
      expect(titles[0]).not.toContain('unreadable');
    } finally {
      await pool.query('DELETE FROM reports WHERE id = ANY($1::uuid[])', [noise]);
    }
  });

  it('P5 — a board GET windows by UTF-8 BYTES and resumes where it stopped', async () => {
    // A document whose characters are all multi-byte: before the repair the
    // 256-KiB cap was a UTF-16 CHARACTER cap and emitted twice the bytes.
    const document = '🙂'.repeat(80_000); // 320,000 UTF-8 bytes
    const row = await pool.query(
      `INSERT INTO reports (title, content, summary, visibility, author_principal_id)
       VALUES ($1, $2, $3, 'private', $4) RETURNING id`,
      [`multibyte ${NEEDLE}`, document, `summary ${NEEDLE}`, ROOT_PRINCIPAL],
    );
    const reportId = String(row.rows[0].id);
    await pool.query(
      `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id)
       VALUES ('principal', $1, 'report', $2, 'read', $3)`,
      [USER_A.principalId, reportId, ROOT_PRINCIPAL],
    );
    try {
      const answer = await search(USER_A, { limitPerSource: 25 });
      const result = boardGroup(answer).results.find((entry: any) => entry.title === `multibyte ${NEEDLE}`);
      expect(result).toBeDefined();

      const first = await readContents(USER_A, result.handle);
      expect(first.status).toBe(200);
      const firstBytes = Buffer.byteLength(first.json.content, 'utf8');
      expect(firstBytes).toBeLessThanOrEqual(256 * 1024);
      expect(first.json.truncated).toBe(true);
      // No code point was cut in half: the window round-trips.
      expect(first.json.content).not.toContain('\ufffd');

      // The continuation is in the SAME units, so the two halves are the
      // document and nothing is skipped or repeated.
      const rest = await fetch(
        `${origin}/knowledge-contents?handle=${encodeURIComponent(result.handle)}`
        + `&continueFrom=${firstBytes}&contentHash=${first.json.sha256}`,
        { headers: USER_A.headers },
      );
      const restJson = await rest.json() as any;
      expect(rest.status).toBe(200);
      expect(Buffer.byteLength(first.json.content + restJson.content, 'utf8')).toBe(320_000);
      expect(first.json.content + restJson.content).toBe(document);
    } finally {
      await pool.query('DELETE FROM grants WHERE resource_id = $1', [reportId]);
      await pool.query('DELETE FROM reports WHERE id = $1', [reportId]);
    }
  });

  it('P6 — a non-UUID in sources[] is REFUSED by name, and a canonical one is not', async () => {
    const malformed = await fetch(`${origin}/knowledge-queries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...USER_A.headers },
      body: JSON.stringify({ q: NEEDLE, sources: ['not-a-uuid'] }),
    });
    expect(malformed.status).toBe(422);
    expect((await malformed.json() as any).code).toBe('KNOWLEDGE_SOURCES_INVALID');

    // The positive half: a well-formed id is accepted, whether or not it names
    // anything — an unknown id is silently ignored, which is §5.5's rule and a
    // different question from malformedness.
    const canonical = await search(USER_A, { sources: ['00000000-0000-4000-8000-000000000000'] });
    expect(canonical.status).toBe(200);
    expect(canonical.json.coverage.consulted).toEqual([]);
  });

  it('F3 — an auto-promoted report with a NULL source task is dropped, root or not', async () => {
    const orphan = await pool.query(
      `INSERT INTO reports (title, content, summary, visibility, author_principal_id,
                            auto_promoted, source_task_id)
       VALUES ($1, $2, $3, 'private', $4, TRUE, NULL) RETURNING id`,
      [`orphan ${NEEDLE}`, `body ${NEEDLE}`, `summary ${NEEDLE}`, ROOT_PRINCIPAL],
    );
    const orphanId = String(orphan.rows[0].id);
    await pool.query(
      `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id)
       VALUES ('principal', $1, 'report', $2, 'read', $3)`,
      [USER_A.principalId, orphanId, ROOT_PRINCIPAL],
    );
    try {
      // The shipped `filterTaskScopedPromotions` drops an auto-promoted report
      // whose `source_task_id` is NULL — `report.source_task_id ? … : false` —
      // and the in-query fragment must drop it too, grant or no grant.
      const answer = await search(USER_A, { limitPerSource: 25 });
      const titles = boardGroup(answer).results.map((result: any) => result.title);
      expect(titles).not.toContain(`orphan ${NEEDLE}`);
    } finally {
      await pool.query('DELETE FROM grants WHERE resource_id = $1', [orphanId]);
      await pool.query('DELETE FROM reports WHERE id = $1', [orphanId]);
    }
  });

  it('F3 — the assigned-only arm is bypassed by the root SCOPE, exactly as the shipped filter bypasses it', async () => {
    const promoted = await pool.query(
      `INSERT INTO reports (title, content, summary, visibility, author_principal_id,
                            auto_promoted, source_task_id, source_outpost_visibility_tier)
       VALUES ($1, $2, $3, 'private', $4, TRUE, $5, 'assigned-only') RETURNING id`,
      [`rootonly ${NEEDLE}`, `body ${NEEDLE}`, `summary ${NEEDLE}`, ROOT_PRINCIPAL, TASK_READABLE],
    );
    const promotedId = String(promoted.rows[0].id);
    await pool.query('DELETE FROM task_assignments WHERE task_id = $1', [TASK_READABLE]);
    try {
      // A caller holding the ROOT SCOPE — which is what `promotedReportActor`
      // computes `root` from, never the role — is not filtered by this arm.
      const withRoot = await runAs(USER_A, [KNOWLEDGE_SCOPE, ...BOARD_SCOPES, 'root']);
      const rootTitles = (withRoot.groups.find((group: any) => group.sourceId === BOARD_SOURCE)?.results ?? [])
        .map((result: any) => result.title);
      expect(rootTitles).toContain(`rootonly ${NEEDLE}`);

      // …and the same caller without it is.
      const withoutRoot = await runAs(USER_A, [KNOWLEDGE_SCOPE, ...BOARD_SCOPES]);
      const plainTitles = (withoutRoot.groups.find((group: any) => group.sourceId === BOARD_SOURCE)?.results ?? [])
        .map((result: any) => result.title);
      expect(plainTitles).not.toContain(`rootonly ${NEEDLE}`);
    } finally {
      await pool.query('DELETE FROM reports WHERE id = $1', [promotedId]);
    }
  });
});
