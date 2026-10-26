/**
 * Card 1fd5de08, line 1 (owner ruling E428) — THE KNOWLEDGE SEARCH CONSOLE'S DOOR,
 * measured through the PRODUCTION router against a REAL PostgreSQL and a STUB
 * v2 source, with two Accounts signed in to the dashboard.
 *
 * The console adds no route and no authority: it calls `GET /knowledge-sources`,
 * `POST /knowledge-queries` and `GET /knowledge-contents` with a login session,
 * exactly as the dashboard does, and the MCP tools call the same two knowledge
 * routes with a bearer. So the property the console relies on is the core's,
 * and this suite measures it at the door the console uses:
 *
 *   (1) the queryable set: an Account sees only the sources its selector covers;
 *   (2) the console's own search body: a caller WITHOUT access to a source gets
 *       no result from it, it is never consulted or dialed, and its id appears
 *       nowhere in the answer; the caller with access gets its results;
 *   (3) narrowing to a source the caller cannot read answers exactly as an
 *       unknown id does: nothing consulted, nothing dialed;
 *   (4) the reader's read: a handle the holder received, presented by the other
 *       Account, is refused with the same shape as a forged handle and never
 *       dialed; the holder opens it;
 *   (5) access withdrawn takes effect on the next search and the next read;
 *   (6) the fields a result and a coverage record carry are exactly the ones
 *       the console's explain view reads — it exposes nothing new;
 *   (7) the MCP search tool, over a Connector of the same Account, answers the
 *       same set.
 *
 * ── THE DESTRUCTIVE CONTRACT, STATED ──
 *
 * It writes principals, login sessions, credentials, services, descriptor
 * versions, access profiles and knowledge audit rows. It refuses any target but
 * a local disposable database whose name says so (or the CI service database),
 * and FAILS — never skips — without `RELAYHALL_TEST_DB_URL`.
 * `npm run test:knowledge-console` runs it; the CI full tier runs it
 * unconditionally against its `services: postgres` block.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';
import os from 'os';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the knowledge console door is measured through the production '
    + 'router over real source, descriptor and grant rows, so this suite never skips. Load database/init.sql into a '
    + 'disposable database, run npm run migrate, and point RELAYHALL_TEST_DB_URL at it.');
}
const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = decodeURIComponent(parsed.pathname.slice(1));
const localDisposable = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  && /test|contract|fixture/.test(TEST_DB_NAME);
const ciService = process.env.CI === 'true' && parsed.hostname === 'postgres' && TEST_DB_NAME === 'relayhall_ci';
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
  || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod'].includes(TEST_DB_NAME)
  || (!localDisposable && !ciService)) {
  throw new Error('The knowledge console suite refuses a non-disposable database target');
}

Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: TEST_DB_NAME,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
});
process.env.RELAYHALL_KNOWLEDGE_ASSERTION_KEYS = JSON.stringify({
  'kc-run': (crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64'),
});
process.env.RELAYHALL_KNOWLEDGE_ASSERTION_ACTIVE_KEY = 'kc-run';
process.env.RELAYHALL_KNOWLEDGE_HANDLE_KEYS = JSON.stringify({ 'kh-run': crypto.randomBytes(32).toString('base64') });
process.env.RELAYHALL_KNOWLEDGE_HANDLE_ACTIVE_KEY = 'kh-run';
process.env.RELAYHALL_TELEMETRY_PEPPERS = process.env.RELAYHALL_TELEMETRY_PEPPERS
  || JSON.stringify({ testpepper: Buffer.alloc(32, 29).toString('base64') });
process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER = process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER || 'testpepper';

const express = require('express');
const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { principalService } = require('../services/PrincipalService');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { knowledgeAssertionJwks } = require('../services/KnowledgeAssertionSigner');
const { sealKnowledgeHandle } = require('../services/KnowledgeHandleSealer');
const dialClient = require('../services/KnowledgeDialClient');
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');
const { KnowledgeSearchStubSource } = require('./support/knowledgeSearchStubSource');

jest.setTimeout(240_000);

let server: http.Server;
let origin: string;

function buildApp(): any {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  app.use(MCP_ROUTE_PATH, mcpRoutes);
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  return app;
}

interface Caller { label: string; accountId: string; headers: Record<string, string> }
interface Answer { status: number; json: any; text: string }

async function call(who: Caller, method: string, routePath: string, body?: unknown): Promise<Answer> {
  const response = await fetch(`${origin}${routePath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...who.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, text };
}

const tag = (): string => crypto.randomBytes(5).toString('hex');
const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

function firstExternalIpv4(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

// ─────────────────────────────── fixtures ────────────────────────────────────

const SYSTEM_ACTOR = { handle: 'knowledge-console-suite', authMethod: 'system' as const };
const STUB = new KnowledgeSearchStubSource('console-search-stub');
const CHANNEL_REF = 'console-search-stub/core';
const CATEGORY = 'relaybrain:note';
/** The body the console sends (pages/KnowledgePage.tsx), with its defaults. */
const CONSOLE_BODY = { protocol_version: 2, kinds: ['code', 'docs', 'data'], includeArchive: false, limitPerSource: 8, timeoutMs: 8000 };
/** Every field a result may carry as it leaves the core; the console's explain view reads these and no other. */
const RESULT_FIELDS = ['category', 'compartment', 'contentKind', 'handle', 'parentHandle', 'score', 'snippet', 'title', 'updatedAt'];
/** The coverage record the console renders. */
const COVERAGE_FIELDS = ['answered', 'archive', 'consulted', 'invalidResults', 'partialSources', 'refusedByPolicy', 'refusedBySource',
  'searchedCategories', 'skipped', 'timedOut', 'truncatedResults', 'unavailable'];

const SHARED_SLUG = `console-shared-${tag()}`;
const PRIVATE_SLUG = `console-private-${tag()}`;
let SHARED: string;
let PRIVATE: string;
/** Reads both sources. */
let HOLDER: Caller;
/** Reads SHARED only: PRIVATE is not in this Account's queryable set. */
let OUTSIDER: Caller;
/** The holder's selector row over PRIVATE, withdrawn in (5). */
let holderPrivateAssignment: string;

async function makeAccount(label: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $1, 'active', 'user') RETURNING id`,
    [`kc-${label}-${tag()}`],
  );
  return String(result.rows[0].id);
}

/** A dashboard login session for the Account: the console's own door. */
async function sessionFor(label: string, accountId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId: accountId });
  return { label, accountId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

/** A Connector of the Account with a bearer, for the MCP search tool (7). */
async function connectorOf(caller: Caller): Promise<Caller & { token: string }> {
  const principal = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, $1, 'active', $2, 'knowledge console suite connector', $3::jsonb) RETURNING id`,
    [`kc-connector-${tag()}`, caller.accountId, JSON.stringify({ scopes: 'parent', objects: 'parent' })],
  );
  const issued = await principalService.issueCredential(
    { principalId: String(principal.rows[0].id), scopes: ['tasks:read', 'knowledge-contents:read'], transport: 'any' }, SYSTEM_ACTOR);
  const connector = { label: `${caller.label}-connector`, accountId: caller.accountId, token: issued.fullKey, headers: { Authorization: `Bearer ${issued.fullKey}` } };
  const brief = await call(connector, 'POST', '/principals/me/brief', {});
  expect({ who: connector.label, status: brief.status }).toEqual({ who: connector.label, status: 200 });
  return connector;
}

async function makeSource(slug: string): Promise<string> {
  const service = await pool.query(
    `INSERT INTO services (slug, name, description, kind, status, runtime_mode,
                           knowledge_query_endpoint, knowledge_get_endpoint, knowledge_claims_mode,
                           knowledge_subject_mode, knowledge_allowed_networks,
                           knowledge_core_credential_ref, current_descriptor_version)
     VALUES ($1, $1, '', 'service', 'published', 'direct', $2, $3, 'asserted', 'pairwise', $4::text[], $5, 1)
     RETURNING id`,
    [slug, STUB.url(`/${slug}/search`), STUB.url(`/${slug}/get`), [`${STUB.host}/32`], CHANNEL_REF],
  );
  const id = String(service.rows[0].id);
  const descriptor = {
    options: [],
    knowledgeSource: {
      classes: [{ key: 'notes', content: 'docs' }],
      compartments: [],
      protocol_version: 2,
      compartment_mode: 'dynamic-opaque',
      categories: [CATEGORY],
    },
  };
  await pool.query(
    `INSERT INTO service_descriptor_versions (service_id, version, descriptor, content_hash) VALUES ($1, 1, $2::jsonb, $3)`,
    [id, JSON.stringify(descriptor), sha256(JSON.stringify(descriptor))],
  );
  return id;
}

/** A published access profile with one read rule over `ids`, assigned to the Account; returns the assignment id. */
async function assignServiceSelector(accountId: string, ids: string[]): Promise<string> {
  const profile = await pool.query('INSERT INTO access_profiles (name, description) VALUES ($1, $2) RETURNING id',
    [`kc-sources-${tag()}`, 'knowledge console suite']);
  const profileId = String(profile.rows[0].id);
  const version = await pool.query(
    'INSERT INTO access_profile_versions (profile_id, version_number) VALUES ($1, 1) RETURNING id', [profileId]);
  const versionId = String(version.rows[0].id);
  await pool.query(
    `INSERT INTO access_profile_rules (version_id, resource_type, selector_form, selector_ids, verbs)
     VALUES ($1, 'service', 'exact', $2::uuid[], ARRAY['read'])`, [versionId, ids]);
  await pool.query('UPDATE access_profiles SET published_version_id = $1 WHERE id = $2', [versionId, profileId]);
  const assignment = await pool.query(
    `INSERT INTO access_profile_assignments (profile_id, assignee_type, assignee_id) VALUES ($1, 'principal', $2) RETURNING id`,
    [profileId, accountId]);
  return String(assignment.rows[0].id);
}

async function consoleSearch(who: Caller, extra: Record<string, unknown> = {}): Promise<Answer> {
  const answer = await call(who, 'POST', '/knowledge-queries', { ...CONSOLE_BODY, q: 'console needle', ...extra });
  expect({ who: who.label, extra, status: answer.status }).toEqual({ who: who.label, extra, status: 200 });
  return answer;
}

const sourcesOf = (answer: Answer): string[] =>
  (answer.json?.groups ?? []).filter((group: any) => group.results.length > 0).map((group: any) => group.sourceId).sort();
const dialsOf = (slug: string, from: number): number => STUB.requests.slice(from).filter((entry: any) => entry.slug === slug).length;

// ─────────────────────────────── lifecycle ───────────────────────────────────

beforeAll(async () => {
  const probe = await pool.query('SELECT current_database() AS db');
  expect(String(probe.rows[0].db)).toBe(TEST_DB_NAME);

  const address = firstExternalIpv4();
  expect(address).not.toBeNull();
  await STUB.start(address as string);
  STUB.bearer = crypto.randomBytes(24).toString('base64url');
  STUB.jwks = knowledgeAssertionJwks().keys;
  process.env.RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS = JSON.stringify({ [CHANNEL_REF]: { bearer: STUB.bearer } });

  const realDial = dialClient.dialKnowledgeSource;
  jest.spyOn(dialClient, 'dialKnowledgeSource').mockImplementation(async (options: any) =>
    realDial({ ...options, trustAnchors: [STUB.certificate.cert] }));

  await new Promise<void>((resolve) => { server = buildApp().listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  SHARED = await makeSource(SHARED_SLUG);
  PRIVATE = await makeSource(PRIVATE_SLUG);
  for (const [slug, id] of [[SHARED_SLUG, SHARED], [PRIVATE_SLUG, PRIVATE]] as const) {
    STUB.sources.set(slug, {
      slug, sourceId: id, compartmentId: crypto.randomUUID(), categories: [CATEGORY], archiveCategories: [], archiveReaders: new Set<string>(),
    });
  }

  const holder = await makeAccount('holder');
  const outsider = await makeAccount('outsider');
  await assignServiceSelector(holder, [SHARED]);
  holderPrivateAssignment = await assignServiceSelector(holder, [PRIVATE]);
  await assignServiceSelector(outsider, [SHARED]);
  HOLDER = await sessionFor('holder', holder);
  OUTSIDER = await sessionFor('outsider', outsider);
});

afterAll(async () => {
  jest.restoreAllMocks();
  await STUB.stop();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ═══════════ (1) the queryable set ═══════════

describe('(1) the queryable set the console lists', () => {
  it('each Account lists only the sources its selector covers, and the other source is absent from the bytes', async () => {
    const holder = await call(HOLDER, 'GET', '/knowledge-sources');
    const outsider = await call(OUTSIDER, 'GET', '/knowledge-sources');
    expect({ holder: holder.status, outsider: outsider.status }).toEqual({ holder: 200, outsider: 200 });
    const ids = (answer: Answer): string[] => (answer.json?.sources ?? []).map((source: any) => source.id).filter((id: string) => id === SHARED || id === PRIVATE).sort();
    expect({ holder: ids(holder), outsider: ids(outsider) }).toEqual({ holder: [SHARED, PRIVATE].sort(), outsider: [SHARED] });
    expect(outsider.text).not.toContain(PRIVATE);
    expect(outsider.text).not.toContain(PRIVATE_SLUG);
  });
});

// ═══════════ (2) the console's search ═══════════

describe('(2) a caller without access to a source sees no results from it', () => {
  it('the holder gets results from both sources through the console body', async () => {
    const answer = await consoleSearch(HOLDER);
    expect(sourcesOf(answer)).toEqual([SHARED, PRIVATE].sort());
    expect([...answer.json.coverage.consulted].sort()).toEqual([SHARED, PRIVATE].sort());
  });

  it('the outsider gets SHARED only: PRIVATE is never consulted, never dialed, and named nowhere in the answer', async () => {
    const base = STUB.requests.length;
    const answer = await consoleSearch(OUTSIDER);
    expect(sourcesOf(answer)).toEqual([SHARED]);
    expect(answer.json.coverage.consulted).toEqual([SHARED]);
    expect(dialsOf(PRIVATE_SLUG, base)).toBe(0);
    expect(dialsOf(SHARED_SLUG, base)).toBe(1);
    expect(answer.text).not.toContain(PRIVATE);
    expect(answer.text).not.toContain(PRIVATE_SLUG);
  });
});

// ═══════════ (3) narrowing to an unreadable source ═══════════

describe('(3) narrowing to a source the caller cannot read', () => {
  it('answers exactly as an unknown id does: nothing consulted, nothing dialed, no results', async () => {
    const base = STUB.requests.length;
    const named = await consoleSearch(OUTSIDER, { sources: [PRIVATE] });
    const unknown = await consoleSearch(OUTSIDER, { sources: [crypto.randomUUID()] });
    expect(STUB.requests.length).toBe(base);
    const shape = (answer: Answer) => ({ coverage: answer.json.coverage, groups: answer.json.groups });
    expect(shape(named)).toEqual(shape(unknown));
    expect(named.json.coverage.consulted).toEqual([]);
    expect(named.json.groups).toEqual([]);
    expect(named.text).not.toContain(PRIVATE_SLUG);
  });
});

// ═══════════ (4) the reader's read ═══════════

describe('(4) the reader opens a result only for a caller who may read it', () => {
  it("the holder's PRIVATE handle, presented by the outsider, is refused like a forged handle and never dialed; the holder opens it", async () => {
    const search = await consoleSearch(HOLDER, { sources: [PRIVATE] });
    const hit = search.json.groups.find((group: any) => group.sourceId === PRIVATE)?.results?.[0];
    expect(hit).toBeDefined();
    const opened = await call(HOLDER, 'GET', `/knowledge-contents?handle=${encodeURIComponent(hit.handle)}`);
    expect({ status: opened.status, category: opened.json?.provenance?.category }).toEqual({ status: 200, category: CATEGORY });

    const base = STUB.requests.length;
    const borrowed = await call(OUTSIDER, 'GET', `/knowledge-contents?handle=${encodeURIComponent(hit.handle)}`);
    const forged = await call(OUTSIDER, 'GET', `/knowledge-contents?handle=${encodeURIComponent(sealKnowledgeHandle({
      s: crypto.randomUUID(), dv: 1, c: crypto.randomUUID(), r: 'doc/forged', f: { version: 2, kinds: ['code', 'data', 'docs'] },
    }))}`);
    expect(dialsOf(PRIVATE_SLUG, base)).toBe(0);
    const refusal = (answer: Answer) => ({ status: answer.status, success: answer.json?.success, refused: answer.json?.refused, code: answer.json?.code, status2: answer.json?.status });
    expect(refusal(borrowed)).toEqual({ status: 403, success: false, refused: 'not_authorized', code: 'refused', status2: 'refused' });
    expect(refusal(borrowed)).toEqual(refusal(forged));
    expect(borrowed.text).not.toContain('content of');
  });
});

// ═══════════ (5) access withdrawn ═══════════

describe('(5) access withdrawn takes effect on the next search and the next read', () => {
  it('once the holder loses PRIVATE, the next search has no PRIVATE result and an earlier handle is refused', async () => {
    const before = await consoleSearch(HOLDER, { sources: [PRIVATE] });
    const hit = before.json.groups.find((group: any) => group.sourceId === PRIVATE)?.results?.[0];
    expect(hit).toBeDefined();
    await pool.query('DELETE FROM access_profile_assignments WHERE id = $1', [holderPrivateAssignment]);
    principalService.invalidatePrincipals([HOLDER.accountId]);
    const base = STUB.requests.length;
    const after = await consoleSearch(HOLDER);
    expect(sourcesOf(after)).toEqual([SHARED]);
    expect(after.json.coverage.consulted).toEqual([SHARED]);
    const reread = await call(HOLDER, 'GET', `/knowledge-contents?handle=${encodeURIComponent(hit.handle)}`);
    expect({ status: reread.status, refused: reread.json?.refused }).toEqual({ status: 403, refused: 'not_authorized' });
    expect(dialsOf(PRIVATE_SLUG, base)).toBe(0);
  });
});

// ═══════════ (6) the explain view reads only what the core returns ═══════════

describe('(6) the fields the console reads', () => {
  it('every result carries only the declared result fields with a score in 0..1, and the coverage record the declared fields', async () => {
    const answer = await consoleSearch(OUTSIDER);
    const results = answer.json.groups.flatMap((group: any) => group.results);
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(Object.keys(result).every((key) => RESULT_FIELDS.includes(key))).toBe(true);
      expect(typeof result.score === 'number' && result.score >= 0 && result.score <= 1).toBe(true);
    }
    expect(Object.keys(answer.json.coverage).every((key) => COVERAGE_FIELDS.includes(key))).toBe(true);
    expect(Object.keys(answer.json).sort()).toEqual(['auditRef', 'coverage', 'groups', 'protocol_version', 'success']);
  });
});

// ═══════════ (7) the MCP tool answers the same set ═══════════

describe('(7) the MCP search tool over a Connector of the same Account', () => {
  it("answers the outsider's set: SHARED, never PRIVATE", async () => {
    const connector = await connectorOf(OUTSIDER);
    const base = STUB.requests.length;
    const response = await fetch(`${origin}${MCP_ROUTE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${connector.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'relayhall_knowledge_source_search', arguments: { q: 'console needle' } } }),
    });
    const text = await response.text();
    expect(text).toContain(SHARED_SLUG);
    expect(text).not.toContain(PRIVATE_SLUG);
    expect(text).not.toContain(PRIVATE);
    expect(dialsOf(PRIVATE_SLUG, base)).toBe(0);
  });
});
