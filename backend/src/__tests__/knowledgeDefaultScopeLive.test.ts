/**
 * Card 40e0e542 — THE DEFAULT SEARCH SCOPE (owner ruling E127 (5), selector
 * amendment v1.2), measured through the PRODUCTION router AND the MCP ingress
 * against a REAL PostgreSQL and a STUB v2 source.
 *
 * ── WHY THIS SUITE IS NOT IN THE DEFAULT JEST RUN ──
 *
 * Which sources a caller may query is a SQL predicate over real service,
 * descriptor, profile and principal rows, and the dial is a real TLS
 * connection under the real outbound policy. A mocked pool can only replay
 * that. The suite connects to `RELAYHALL_TEST_DB_URL` and FAILS — never skips —
 * when it is unset; `npm run test:knowledge-default-scope` runs it, and the CI
 * full tier runs it unconditionally against its `services: postgres` block.
 *
 * ── THE DESTRUCTIVE CONTRACT, STATED ──
 *
 * It writes principals, credentials, services, descriptor versions, access
 * profiles and knowledge audit rows. It refuses any target but a local
 * disposable database whose name says so (or the CI service database). Bring
 * the database up with `database/init.sql` and `npm run migrate`, and throw it
 * away afterwards.
 *
 * ── THE STUB SOURCE ──
 *
 * `support/knowledgeSearchStubSource.ts` serves two v2 sources from one TLS
 * listener: MIXED declares `relaybrain:archive`, `relaybrain:note` and `relaybrain:shared` with
 * `archiveCategories: [relaybrain:archive]`, and ARCHIVE_ONLY declares only
 * `relaybrain:archive`, all of it archive. It verifies every read assertion against the
 * core's published keyset, answers one result per category it was asked to
 * search, ECHOES the filter it received in each snippet, and refuses an archive
 * reach by a subject it does not release its archive to — its own authority,
 * never the core's. It is dialed at a private interface address with an
 * allowed-networks /32, because loopback is never admissible.
 *
 * ── THE CONTROLS ──
 *
 *   (1) a default search sends each source its categories minus the archive,
 *       and the answer says the archive was excluded (REST and MCP);
 *   (2) includeArchive: true sends the request unchanged, and the answer says
 *       the archive was included (REST and MCP);
 *   (3) a source whose categories are ALL archive is skipped with reason
 *       `categories` by default and consulted on opt-in;
 *   (4) the flag is never authority: a caller the source does not release its
 *       archive to gains nothing (the source's refusal passes through), a
 *       caller without the source never reaches it, a malformed flag is
 *       refused before any dial, and no source request ever carries the flag;
 *   (5) a handle from a default search cannot open an archive document, and a
 *       stray archive hit to a default search is dropped;
 *   (R) the rider (the L3 review): the scope sentence is true in each
 *       situation - a source that declares no archive (PLAIN), the opt-in, and
 *       an opt-in every declaring source refused - and the search ledger
 *       records the opt-in on every fan-out entry;
 *   (6) every coverage record names `searchedCategories` and `archive` per the
 *       invariants, `archive.declaredBy` included.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';
import os from 'os';

// ─────────────────────────── the database contract ───────────────────────────

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the default search scope is measured through the production '
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
  throw new Error('The default search scope suite refuses a non-disposable database target');
}

Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: TEST_DB_NAME,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
});
process.env.RELAYHALL_KNOWLEDGE_ASSERTION_KEYS = JSON.stringify({
  'ks-run': (crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64'),
});
process.env.RELAYHALL_KNOWLEDGE_ASSERTION_ACTIVE_KEY = 'ks-run';
process.env.RELAYHALL_KNOWLEDGE_HANDLE_KEYS = JSON.stringify({ 'kh-run': crypto.randomBytes(32).toString('base64') });
process.env.RELAYHALL_KNOWLEDGE_HANDLE_ACTIVE_KEY = 'kh-run';
process.env.RELAYHALL_TELEMETRY_PEPPERS = process.env.RELAYHALL_TELEMETRY_PEPPERS
  || JSON.stringify({ testpepper: Buffer.alloc(32, 21).toString('base64') });
process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER = process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER || 'testpepper';

const express = require('express');
const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { principalService } = require('../services/PrincipalService');
const { knowledgeAssertionJwks, pairwiseSubject } = require('../services/KnowledgeAssertionSigner');
const dialClient = require('../services/KnowledgeDialClient');
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');
const { KnowledgeSearchStubSource } = require('./support/knowledgeSearchStubSource');

jest.setTimeout(240_000);

// ──────────────────────────────── the app ────────────────────────────────────

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

interface Caller { label: string; accountId: string; principalId: string; token: string; headers: Record<string, string> }
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

async function mcp(who: Caller, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const response = await fetch(`${origin}${MCP_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${who.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const json: any = JSON.parse(await response.text());
  return {
    text: String(json?.result?.content?.[0]?.text ?? JSON.stringify(json?.error ?? json)),
    isError: Boolean(json?.result?.isError) || Boolean(json?.error),
  };
}

/** The coverage record an MCP answer carries: the first quoted JSON block after the coverage heading. */
function mcpCoverage(text: string): any {
  const lines = text.split('\n');
  const heading = lines.indexOf('# Knowledge search coverage');
  const open = lines.findIndex((line, index) => index > heading && /^`{3,}json$/.test(line));
  const close = lines.findIndex((line, index) => index > open && /^`{3,}$/.test(line));
  expect({ heading: heading >= 0, open: open > heading, close: close > open }).toEqual({ heading: true, open: true, close: true });
  return JSON.parse(lines.slice(open + 1, close).join('\n'));
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

const SYSTEM_ACTOR = { handle: 'knowledge-default-scope-suite', authMethod: 'system' as const };
const STUB = new KnowledgeSearchStubSource('scope40-search-stub');
const CHANNEL_REF = 'scope40-search-stub/core';
const ARCHIVE = 'relaybrain:archive';
const CURRENT = ['relaybrain:note', 'relaybrain:shared'];
const ALL_KINDS = ['code', 'data', 'docs'];
const SEARCH_WIRE_KEYS = ['assertion', 'budget_ms', 'filter', 'limit', 'protocol_version', 'q'];
const GET_WIRE_KEYS = ['assertion', 'compartment_id', 'filter', 'limitBytes', 'protocol_version', 'ref'];

const MIXED_SLUG = `scope40-mixed-${tag()}`;
const ARCHIVE_ONLY_SLUG = `scope40-archive-only-${tag()}`;
const PLAIN_SLUG = `scope40-plain-${tag()}`;
let MIXED: string;
let ARCHIVE_ONLY: string;
/** Rider: a v2 source that declares NO archive. */
let PLAIN: string;
/** Reads the source releases its archive to. */
let ARCHIVIST: Caller;
/** Reads both sources, but the sources do not release their archive to this Account. */
let NOT_RELEASED: Caller;
/** Holds MIXED only: ARCHIVE_ONLY is not in this caller's queryable set. */
let NARROW: Caller;
/** Rider: holds PLAIN only, so no consulted source declares an archive. */
let PLAIN_READER: Caller;

async function makeAccount(label: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $1, 'active', 'user') RETURNING id`,
    [`ks-${label}-${tag()}`],
  );
  return String(result.rows[0].id);
}

/** A Connector under an Account: own() inherits, so the Account's authority is the ceiling. */
async function makeConnector(label: string, accountId: string): Promise<Caller> {
  const principal = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, $1, 'active', $2, $3, $4::jsonb) RETURNING id`,
    [`ks-${label}-${tag()}`, accountId, `default search scope suite ${label}`, JSON.stringify({ scopes: 'parent', objects: 'parent' })],
  );
  const principalId = String(principal.rows[0].id);
  const issued = await principalService.issueCredential(
    { principalId, scopes: ['tasks:read', 'knowledge-contents:read'], transport: 'any' }, SYSTEM_ACTOR);
  const caller: Caller = { label, accountId, principalId, token: issued.fullKey, headers: { Authorization: `Bearer ${issued.fullKey}` } };
  const brief = await call(caller, 'POST', '/principals/me/brief', {});
  expect({ who: label, status: brief.status }).toEqual({ who: label, status: 200 });
  return caller;
}

async function makeSource(slug: string, categories: string[], archiveCategories: string[]): Promise<string> {
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
      categories,
      ...(archiveCategories.length ? { archiveCategories } : {}),
    },
  };
  await pool.query(
    `INSERT INTO service_descriptor_versions (service_id, version, descriptor, content_hash) VALUES ($1, 1, $2::jsonb, $3)`,
    [id, JSON.stringify(descriptor), sha256(JSON.stringify(descriptor))],
  );
  return id;
}

async function assignServiceSelector(principalId: string, ids: string[]): Promise<void> {
  const profile = await pool.query('INSERT INTO access_profiles (name, description) VALUES ($1, $2) RETURNING id',
    [`ks-sources-${tag()}`, 'default search scope suite']);
  const profileId = String(profile.rows[0].id);
  const version = await pool.query(
    'INSERT INTO access_profile_versions (profile_id, version_number) VALUES ($1, 1) RETURNING id', [profileId]);
  const versionId = String(version.rows[0].id);
  await pool.query(
    `INSERT INTO access_profile_rules (version_id, resource_type, selector_form, selector_ids, verbs)
     VALUES ($1, 'service', 'exact', $2::uuid[], ARRAY['read'])`, [versionId, ids]);
  await pool.query('UPDATE access_profiles SET published_version_id = $1 WHERE id = $2', [versionId, profileId]);
  await pool.query(
    `INSERT INTO access_profile_assignments (profile_id, assignee_type, assignee_id) VALUES ($1, 'principal', $2)`,
    [profileId, principalId]);
}

/** Every coverage record this suite saw, with the opt-in it was asked under (control 6). */
const seenCoverage: Array<{ label: string; includeArchive: boolean; coverage: any }> = [];

async function search(who: Caller, extra: Record<string, unknown> = {}): Promise<Answer> {
  const answer = await call(who, 'POST', '/knowledge-queries', { protocol_version: 2, q: 'scope needle', ...extra });
  // Every search this suite makes is one the core must ANSWER (a failed source
  // never fails the search, so anything else is a core failure), and saying so
  // here keeps a broken core an assertion failure, never a crash of the test.
  expect({ who: who.label, extra, status: answer.status }).toEqual({ who: who.label, extra, status: 200 });
  if (answer.status === 200) seenCoverage.push({ label: `${who.label} REST ${JSON.stringify(extra)}`, includeArchive: extra.includeArchive === true, coverage: answer.json.coverage });
  return answer;
}

async function mcpSearch(who: Caller, extra: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean; coverage: any }> {
  const answer = await mcp(who, 'relayhall_knowledge_source_search', { q: 'scope needle', ...extra });
  const coverage = answer.isError ? null : mcpCoverage(answer.text);
  if (coverage) seenCoverage.push({ label: `${who.label} MCP ${JSON.stringify(extra)}`, includeArchive: extra.includeArchive === true, coverage });
  return { ...answer, coverage };
}

const categoriesOf = (answer: Answer, sourceId: string): string[] =>
  (answer.json.groups.find((group: any) => group.sourceId === sourceId)?.results ?? []).map((result: any) => result.category).sort();

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

  MIXED = await makeSource(MIXED_SLUG, [ARCHIVE, ...CURRENT], [ARCHIVE]);
  ARCHIVE_ONLY = await makeSource(ARCHIVE_ONLY_SLUG, [ARCHIVE], [ARCHIVE]);
  PLAIN = await makeSource(PLAIN_SLUG, CURRENT, []);

  const archivist = await makeAccount('archivist');
  const notReleased = await makeAccount('not-released');
  const narrow = await makeAccount('narrow');
  const plainReader = await makeAccount('plain-reader');
  await assignServiceSelector(archivist, [MIXED, ARCHIVE_ONLY]);
  await assignServiceSelector(notReleased, [MIXED, ARCHIVE_ONLY]);
  await assignServiceSelector(narrow, [MIXED]);
  await assignServiceSelector(plainReader, [PLAIN]);
  ARCHIVIST = await makeConnector('archivist', archivist);
  NOT_RELEASED = await makeConnector('not-released', notReleased);
  NARROW = await makeConnector('narrow', narrow);
  PLAIN_READER = await makeConnector('plain-reader', plainReader);

  // The SOURCE's authority table: its archive is released to the archivist's
  // pairwise subject only (and to the narrow Account, which cannot reach the
  // archive-only source at all, so the flag must not get it there).
  for (const [slug, id, categories] of [[MIXED_SLUG, MIXED, [ARCHIVE, ...CURRENT]], [ARCHIVE_ONLY_SLUG, ARCHIVE_ONLY, [ARCHIVE]]] as const) {
    STUB.sources.set(slug, {
      slug, sourceId: id, compartmentId: crypto.randomUUID(), categories: [...categories], archiveCategories: [ARCHIVE],
      archiveReaders: new Set([pairwiseSubject(archivist, id), pairwiseSubject(narrow, id)]),
    });
  }
  STUB.sources.set(PLAIN_SLUG, {
    slug: PLAIN_SLUG, sourceId: PLAIN, compartmentId: crypto.randomUUID(), categories: [...CURRENT], archiveCategories: [],
    archiveReaders: new Set<string>(),
  });
});

afterAll(async () => {
  jest.restoreAllMocks();
  await STUB.stop();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ═══════════ (1) the default search: categories minus the archive, stated ═══════════

describe('(1) a default search excludes the archive and says so', () => {
  it('REST: MIXED is asked for its categories minus the archive, ARCHIVE_ONLY is not dialed, and the coverage says archive excluded', async () => {
    const base = STUB.requests.length;
    const answer = await search(ARCHIVIST);
    expect(answer.status).toBe(200);
    const dialed = STUB.requests.slice(base);
    expect(dialed.map((entry: any) => [entry.slug, entry.verb, entry.status])).toEqual([[MIXED_SLUG, 'search', 200]]);
    expect(dialed[0].body.filter).toEqual({ version: 2, kinds: ALL_KINDS, categories: CURRENT });
    // The assertion names the caller's Account through the source's pairwise subject.
    expect(dialed[0].claims.sub).toBe(pairwiseSubject(ARCHIVIST.accountId, MIXED));
    expect(answer.json.coverage).toMatchObject({
      consulted: [MIXED], answered: [MIXED], skipped: [{ id: ARCHIVE_ONLY, reason: 'categories' }],
      searchedCategories: [{ id: MIXED, categories: CURRENT }], archive: { included: false },
    });
    expect(categoriesOf(answer, MIXED)).toEqual(CURRENT);
    // The source echoed the narrowed filter it received.
    for (const result of answer.json.groups[0].results) {
      expect(JSON.parse(result.snippet.replace(/^filter=/, ''))).toEqual({ version: 2, kinds: ALL_KINDS, categories: CURRENT });
    }
  });

  it('MCP: the same narrowed request, and the answer opens by saying the archive was excluded', async () => {
    const base = STUB.requests.length;
    const answer = await mcpSearch(ARCHIVIST);
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain('Searched: current knowledge; archive excluded (pass includeArchive: true).');
    expect(answer.text.indexOf('Searched:')).toBeLessThan(answer.text.indexOf('# Results'));
    expect(STUB.requests.slice(base).map((entry: any) => [entry.slug, entry.body.filter])).toEqual([
      [MIXED_SLUG, { version: 2, kinds: ALL_KINDS, categories: CURRENT }],
    ]);
    expect(answer.coverage).toMatchObject({ searchedCategories: [{ id: MIXED, categories: CURRENT }], archive: { included: false } });
  });
});

// ═══════════ (2) the opt-in: the request unchanged, stated ═══════════

describe('(2) includeArchive: true searches the archive and says so', () => {
  it('REST: both sources are asked with no category filter, the archive answers, and the coverage says archive included', async () => {
    const base = STUB.requests.length;
    const answer = await search(ARCHIVIST, { includeArchive: true });
    expect(answer.status).toBe(200);
    const dialed = STUB.requests.slice(base).map((entry: any) => [entry.slug, entry.body.filter]).sort();
    expect(dialed).toEqual([
      [ARCHIVE_ONLY_SLUG, { version: 2, kinds: ALL_KINDS }],
      [MIXED_SLUG, { version: 2, kinds: ALL_KINDS }],
    ].sort());
    expect([...answer.json.coverage.consulted].sort()).toEqual([MIXED, ARCHIVE_ONLY].sort());
    expect(answer.json.coverage.skipped).toEqual([]);
    expect({ ...answer.json.coverage.archive, declaredBy: [...(answer.json.coverage.archive?.declaredBy ?? [])].sort() })
      .toEqual({ included: true, declaredBy: [MIXED, ARCHIVE_ONLY].sort() });
    expect([...answer.json.coverage.searchedCategories].sort((a: any, b: any) => a.id.localeCompare(b.id)))
      .toEqual([{ id: MIXED, categories: 'all' }, { id: ARCHIVE_ONLY, categories: 'all' }].sort((a, b) => a.id.localeCompare(b.id)));
    expect(categoriesOf(answer, MIXED)).toEqual([ARCHIVE, ...CURRENT]);
    expect(categoriesOf(answer, ARCHIVE_ONLY)).toEqual([ARCHIVE]);
  });

  it('MCP: includeArchive is the explicit agent parameter, and the answer opens by saying the archive was included', async () => {
    const answer = await mcpSearch(ARCHIVIST, { includeArchive: true });
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain('Searched: current knowledge and the archive (includeArchive: true).');
    expect({ ...answer.coverage.archive, declaredBy: [...(answer.coverage.archive?.declaredBy ?? [])].sort() })
      .toEqual({ included: true, declaredBy: [MIXED, ARCHIVE_ONLY].sort() });
    expect(answer.text).toContain(`${ARCHIVE_ONLY_SLUG} ${ARCHIVE}`);
  });
});

// ═══════════ (3) an all-archive source ═══════════

describe('(3) a source whose categories are ALL archive', () => {
  it('is skipped with reason categories by default — never dialed — and consulted on opt-in', async () => {
    const base = STUB.requests.length;
    const byDefault = await search(ARCHIVIST, { sources: [ARCHIVE_ONLY] });
    expect(byDefault.status).toBe(200);
    expect(byDefault.json.coverage).toMatchObject({ consulted: [], skipped: [{ id: ARCHIVE_ONLY, reason: 'categories' }], searchedCategories: [] });
    expect(STUB.requests.length).toBe(base);
    const optIn = await search(ARCHIVIST, { sources: [ARCHIVE_ONLY], includeArchive: true });
    expect(optIn.json.coverage).toMatchObject({ consulted: [ARCHIVE_ONLY], answered: [ARCHIVE_ONLY], skipped: [], searchedCategories: [{ id: ARCHIVE_ONLY, categories: 'all' }] });
    expect(STUB.searches(ARCHIVE_ONLY_SLUG).length).toBeGreaterThan(0);
    expect(STUB.requests.slice(base).map((entry: any) => entry.slug)).toEqual([ARCHIVE_ONLY_SLUG]);
  });
});

// ═══════════ (4) the flag is never authority ═══════════

describe('(4) a caller without the right gains nothing through the flag', () => {
  it('a caller the source does not release its archive to: the default answers; the opt-in is refused BY THE SOURCE and the refusal passes through', async () => {
    const byDefault = await search(NOT_RELEASED);
    expect(byDefault.json.coverage).toMatchObject({ answered: [MIXED], archive: { included: false } });
    expect(categoriesOf(byDefault, MIXED)).toEqual(CURRENT);
    const base = STUB.requests.length;
    const optIn = await search(NOT_RELEASED, { includeArchive: true });
    expect(optIn.status).toBe(200);
    const refusals = STUB.requests.slice(base);
    expect(refusals.map((entry: any) => [entry.status, entry.refusal]))
      .toEqual([[403, 'archive not released to this subject'], [403, 'archive not released to this subject']]);
    expect([...optIn.json.coverage.refusedBySource].sort()).toEqual([MIXED, ARCHIVE_ONLY].sort());
    expect(optIn.json.coverage.answered).toEqual([]);
    expect(optIn.json.groups.flatMap((group: any) => group.results)).toEqual([]);
  });

  it('a caller without the archive-only source never reaches it, whatever the flag says', async () => {
    const base = STUB.requests.length;
    const optIn = await search(NARROW, { includeArchive: true });
    expect(optIn.status).toBe(200);
    expect(optIn.json.coverage.consulted).toEqual([MIXED]);
    expect(JSON.stringify(optIn.json)).not.toContain(ARCHIVE_ONLY);
    expect(STUB.requests.slice(base).map((entry: any) => entry.slug)).toEqual([MIXED_SLUG]);
    const named = await search(NARROW, { includeArchive: true, sources: [ARCHIVE_ONLY] });
    expect(named.json.coverage).toMatchObject({ consulted: [], skipped: [] });
    expect(STUB.requests.slice(base).map((entry: any) => entry.slug)).toEqual([MIXED_SLUG]);
  });

  it('a malformed flag is refused before any dial, over REST and MCP', async () => {
    const base = STUB.requests.length;
    for (const body of [
      { protocol_version: 2, q: 'scope needle', includeArchive: 'true' },
      { protocol_version: 2, q: 'scope needle', includeArchive: 1 },
      { protocol_version: 2, q: 'scope needle', include_archive: true },
      { q: 'scope needle', includeArchive: true },
    ]) {
      const refused = await call(ARCHIVIST, 'POST', '/knowledge-queries', body);
      expect({ body, status: refused.status, code: refused.json?.code }).toEqual({ body, status: 400, code: 'INVALID_SELECTOR' });
    }
    const viaMcp = await mcp(ARCHIVIST, 'relayhall_knowledge_source_search', { q: 'scope needle', includeArchive: 'yes' });
    expect(viaMcp.isError).toBe(true);
    expect(STUB.requests.length).toBe(base);
  });
});

// ═══════════ (5) sealed handles ═══════════

describe('(5) a handle from a default search cannot open an archive document', () => {
  it('a default-search handle whose document the source has since filed as archive is refused by the core, and the source was sent the narrowed filter', async () => {
    const answer = await search(ARCHIVIST, { sources: [MIXED] });
    const note = answer.json.groups[0].results.find((result: any) => result.category === 'relaybrain:note');
    expect(note).toBeDefined();
    // Positive control: the same handle opens while the document is current.
    const open = await call(ARCHIVIST, 'GET', `/knowledge-contents?handle=${encodeURIComponent(note.handle)}`);
    expect({ status: open.status, category: open.json?.provenance?.category }).toEqual({ status: 200, category: 'relaybrain:note' });
    const ref = KnowledgeSearchStubSource.ref(MIXED_SLUG, 'relaybrain:note');
    STUB.refiled.set(ref, ARCHIVE);
    try {
      const base = STUB.requests.length;
      const moved = await call(ARCHIVIST, 'GET', `/knowledge-contents?handle=${encodeURIComponent(note.handle)}`);
      expect({ status: moved.status, code: moved.json?.code }).toEqual({ status: 403, code: 'source_protocol_error' });
      expect(moved.text).not.toContain('content of');
      const get = STUB.requests.slice(base);
      expect(get.map((entry: any) => [entry.verb, entry.body.ref, entry.body.filter])).toEqual([
        ['get', ref, { version: 2, kinds: ALL_KINDS, categories: CURRENT }],
      ]);
      const viaMcp = await mcp(ARCHIVIST, 'relayhall_knowledge_source_get', { handle: note.handle });
      expect(viaMcp.text).not.toContain('content of');
    } finally {
      STUB.refiled.clear();
    }
  });

  it('only an opt-in search yields a handle that opens an archive document', async () => {
    const optIn = await search(ARCHIVIST, { sources: [MIXED], includeArchive: true });
    const archived = optIn.json.groups[0].results.find((result: any) => result.category === ARCHIVE);
    expect(archived).toBeDefined();
    const open = await call(ARCHIVIST, 'GET', `/knowledge-contents?handle=${encodeURIComponent(archived.handle)}`);
    expect({ status: open.status, category: open.json?.provenance?.category }).toEqual({ status: 200, category: ARCHIVE });
    expect(Buffer.from(open.json.content_base64, 'base64').toString('utf8')).toContain(KnowledgeSearchStubSource.ref(MIXED_SLUG, ARCHIVE));
  });

  it('an archive hit a source returns to a default search is dropped and named in invalidResults; no handle is issued for it', async () => {
    STUB.misbehaveOnce = true;
    const base = STUB.requests.length;
    const answer = await search(ARCHIVIST, { sources: [MIXED] });
    expect(STUB.requests.slice(base).map((entry: any) => entry.body.filter)).toEqual([{ version: 2, kinds: ALL_KINDS, categories: CURRENT }]);
    expect(answer.json.coverage).toMatchObject({ answered: [MIXED], invalidResults: [MIXED], archive: { included: false } });
    expect(categoriesOf(answer, MIXED)).toEqual(CURRENT);
    expect(answer.text).not.toContain(`${MIXED_SLUG} ${ARCHIVE}`);
  });
});

// ═══════════ (R) the rider: the sentence in each situation, and the ledger ═══════════

describe('(R) the rider: the scope sentence and the search ledger', () => {
  it('MCP: a source that declares no archive, the opt-in, and an opt-in every declaring source refused each get a true sentence', async () => {
    const declaredBy = (answer: { coverage: any }): string[] => [...(answer.coverage?.archive?.declaredBy ?? [])].sort();
    const plain = await mcpSearch(PLAIN_READER);
    expect({ isError: plain.isError, consulted: plain.coverage?.consulted, archive: plain.coverage?.archive })
      .toEqual({ isError: false, consulted: [PLAIN], archive: { included: false, declaredBy: [] } });
    expect(plain.text).toContain('Searched: current knowledge (no consulted source declares an archive).');
    const plainOptIn = await mcpSearch(PLAIN_READER, { includeArchive: true });
    expect(plainOptIn.coverage?.archive).toEqual({ included: true, declaredBy: [] });
    expect(plainOptIn.text).toContain('Searched: current knowledge (no consulted source declares an archive).');
    const optIn = await mcpSearch(ARCHIVIST, { includeArchive: true });
    expect(declaredBy(optIn)).toEqual([MIXED, ARCHIVE_ONLY].sort());
    expect(optIn.text).toContain('Searched: current knowledge and the archive (includeArchive: true).');
    const refused = await mcpSearch(NOT_RELEASED, { includeArchive: true });
    expect([...(refused.coverage?.refusedBySource ?? [])].sort()).toEqual([MIXED, ARCHIVE_ONLY].sort());
    expect(declaredBy(refused)).toEqual([MIXED, ARCHIVE_ONLY].sort());
    expect(refused.text).toContain('Scope requested: current knowledge and the archive; the archive sources refused.');
    // The default over a declaring source is (1)'s MCP control. Each answer
    // carries exactly ONE scope sentence, before the results.
    for (const answer of [plain, plainOptIn, optIn, refused]) {
      const lines = answer.text.split('\n').filter((line) => /^(Searched|Scope requested):/.test(line));
      expect(lines).toHaveLength(1);
      expect(answer.text.indexOf(lines[0])).toBeLessThan(answer.text.indexOf('# Results'));
    }
  });

  it('the search ledger records the caller\'s archive opt-in on every fan-out entry, default and opt-in', async () => {
    const ledger = async (answer: Answer): Promise<unknown[][]> => {
      const rows = await pool.query('SELECT fanout FROM knowledge_search_audit WHERE audit_ref = $1', [answer.json.auditRef]);
      expect(rows.rows).toHaveLength(1);
      return (rows.rows[0]?.fanout ?? []).map((entry: any) => [entry.sourceId, entry.outcome, entry.archiveIncluded]).sort();
    };
    const byDefault = await search(PLAIN_READER);
    const optIn = await search(PLAIN_READER, { includeArchive: true });
    const refused = await search(NOT_RELEASED, { includeArchive: true });
    expect({ byDefault: await ledger(byDefault), optIn: await ledger(optIn), refused: await ledger(refused) }).toEqual({
      byDefault: [[PLAIN, 'answered', false]],
      optIn: [[PLAIN, 'answered', true]],
      refused: [[MIXED, 'refusedBySource', true], [ARCHIVE_ONLY, 'refusedBySource', true]].sort(),
    });
  });
});

// ═══════════ (6) the coverage record, and the wire as a whole ═══════════

describe('(6) every coverage record and every source request', () => {
  it('every coverage record this suite saw names searchedCategories for exactly its consulted sources and states archive per the invariants', () => {
    expect(seenCoverage.length).toBeGreaterThanOrEqual(12);
    expect(seenCoverage.some((entry) => entry.includeArchive)).toBe(true);
    // Not vacuous: a DEFAULT answer that had an archive to exclude (the rider's
    // PLAIN answers have none, so they cannot stand in for one).
    expect(seenCoverage.some((entry) => !entry.includeArchive && (entry.coverage.archive?.declaredBy ?? []).length > 0)).toBe(true);
    for (const { label, includeArchive, coverage } of seenCoverage) {
      const partition = [...coverage.answered, ...coverage.timedOut, ...coverage.unavailable.map((entry: any) => entry.id),
        ...coverage.refusedBySource, ...coverage.refusedByPolicy];
      expect({ label, partition: partition.sort() }).toEqual({ label, partition: [...coverage.consulted].sort() });
      expect({ label, searched: coverage.searchedCategories.map((entry: any) => entry.id).sort() })
        .toEqual({ label, searched: [...coverage.consulted].sort() });
      // Invariant 7 (rider): declaredBy is exactly the consulted sources that
      // declare an archive - MIXED and ARCHIVE_ONLY here, never PLAIN.
      const declaring = coverage.consulted.filter((id: string) => id === MIXED || id === ARCHIVE_ONLY).sort();
      expect({ label, archive: { ...coverage.archive, declaredBy: [...(coverage.archive?.declaredBy ?? [])].sort() } })
        .toEqual({ label, archive: { included: includeArchive, declaredBy: declaring } });
      if (!includeArchive) {
        // Invariant 6 binds the sources that declare an archive; PLAIN is searched over `all`.
        for (const entry of coverage.searchedCategories.filter((searched: any) => declaring.includes(searched.id))) {
          expect({ label, entry, reaches: entry.categories === 'all' || entry.categories.includes(ARCHIVE) })
            .toEqual({ label, entry, reaches: false });
        }
      }
    }
  });

  it('NO SOURCE REQUEST EVER CARRIED THE FLAG: every search and get body has exactly the wire keys, a closed filter and claims without it', () => {
    const searches = STUB.requests.filter((entry: any) => entry.verb === 'search');
    const gets = STUB.requests.filter((entry: any) => entry.verb === 'get');
    // Not vacuous: both verbs were exercised.
    expect(searches.length).toBeGreaterThan(0);
    expect(gets.length).toBeGreaterThan(0);
    for (const entry of STUB.requests) {
      expect(Object.keys(entry.body).sort()).toEqual(entry.verb === 'search' ? SEARCH_WIRE_KEYS : GET_WIRE_KEYS);
      expect(Object.keys(entry.body.filter).every((key: string) => ['version', 'kinds', 'categories'].includes(key))).toBe(true);
      expect(entry.rawBody).not.toMatch(/includeArchive|include_archive/);
      expect(JSON.stringify(entry.claims)).not.toMatch(/includeArchive|include_archive|archive/i);
    }
  });
});
