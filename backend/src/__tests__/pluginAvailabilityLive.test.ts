/**
 * Card bedf50cc (epic F3, E380 stage 1): plugin availability and layered
 * plugin settings, over a REAL PostgreSQL, the PRODUCTION routers (the
 * protected registry, the host proxy and the backend effective-settings read
 * mounted as server.ts mounts them), the real PluginLoader reading a real
 * installation file, and a real plugin upstream over HTTP.
 *
 * Two Accounts (and more) and an administrator. It measures, on stored rows:
 *
 *   (M) migration 166: replay-safe; its tables and CHECKs pinned by name;
 *       exactly one deployment row per plugin (NULLS NOT DISTINCT).
 *   (A) availability: every state x the Account's switch x an Account the
 *       installation file does and does not allow, at every site; policy never
 *       widens; an explicit generate grant without view does not bypass it.
 *   (C) concealment: the byte-identical 404 at every site, and the choice /
 *       eligible-list exception.
 *   (R) resolution across the three layers with locks; lock then unlock
 *       restores the Account's kept value.
 *   (V) every value bound, wrong-scope writes, the secret value-shape guard.
 *   (I) If-Match and idempotent replay of the five operations.
 *   (E) the plugin backend's effective read and every refusal it owes.
 *   (K) load: same-key installations, a bad schema, an invalid name.
 *   (D) deliver: backend keys absent from the bridge.
 *   (G) the administrator gate; (U) the Account's own session gate.
 *   (X) isolation through an outside-anchor read; (AU) audit rows without
 *       values; (P) no MCP tool (C9); (CL) the explicit clean-up.
 *
 * DESTRUCTIVE: writes principals, credentials, sessions, step-up tokens,
 * plugin rows and audit rows. It refuses any deployment database and any
 * non-local host, and FAILS (never skips) without a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { replayInRolledBackTransaction, setAsideRowsOnlyLaterMigrationsAdmit, type Queryable } from './support/migrationReplay';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: plugin availability and settings are measured on stored rows, so this '
    + 'suite never skips. Load database/init.sql into a disposable database, run npm run migrate, and point '
    + 'RELAYHALL_TEST_DB_URL at it.');
}
const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = decodeURIComponent(parsed.pathname.slice(1));
const localDisposable = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  && /test|contract|fixture/.test(TEST_DB_NAME);
const ciService = process.env.CI === 'true' && parsed.hostname === 'postgres' && TEST_DB_NAME === 'relayhall_ci';
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
  || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod'].includes(TEST_DB_NAME)
  || (!localDisposable && !ciService)) {
  throw new Error('The plugin availability suite refuses a non-disposable database target');
}

Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: TEST_DB_NAME,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
  DOCKER_HOST_ALIAS: '127.0.0.1',
});
process.env.RELAYHALL_API_KEY = process.env.RELAYHALL_API_KEY || `plugin-availability-suite-${crypto.randomBytes(16).toString('hex')}`;

const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { stepUpService } = require('../services/StepUpService');
const { principalService } = require('../services/PrincipalService');
const { PluginLoader } = require('../services/PluginLoader');
const { setPluginLoader } = require('../routes/plugins');
const { setPluginHostLoader, PLUGIN_EFFECTIVE_SETTINGS_ROUTE_PATH, pluginEffectiveSettingsHandler } = require('../routes/pluginHost');
const { createPluginProxy } = require('../middleware/pluginProxy');
const { IDEMPOTENT_OPERATIONS } = require('../middleware/idempotency');
const { MCP_TOOLS } = require('../mcp/registry');

jest.setTimeout(180_000);

const MIGRATION_FILE = path.join(__dirname, '..', 'migrations', '166_plugin_availability_settings.sql');
const NEWS = 'news-desk';
const ORB = 'orb-alpha';
const GATED = 'gated-tool';
// A `claw-` name compiles to a shorter public namespace (/plugins/detail), so
// GET /plugins/<installation name> reaches the detail route, not the proxy.
const DETAIL = 'claw-detail';
const LEGACY = 'claw-legacy';
const FIXTURES = [NEWS, ORB, GATED, DETAIL, LEGACY, 'bad-schema', 'dup-one', 'dup-two', 'dup-three', 'dup-four'];
const STATES = ['required', 'default_on', 'available', 'disabled'] as const;
const NOT_FOUND = '{"code":"PLUGIN_NOT_FOUND"}';
/** A value no audit row may ever carry (AU). */
const MARKER = 'zq-marker-value';

const keyEnv = (name: string) => 'PLUGIN_AVAILABILITY_TEST_KEY_' + name.toUpperCase().replace(/-/g, '_');
const keyOf = (name: string) => `plugin-availability-test-only-key-${name}-0123456789abcdef`;

const NEWS_SCHEMA = [
  { key: 'language', label: 'Language', type: 'enum', scope: 'account_overridable', default: 'en',
    options: [{ value: 'en', label: 'English' }, { value: 'de', label: 'German' }, { value: 'pl', label: 'Polish' }] },
  { key: 'topics', label: 'Topics', type: 'multi_enum', scope: 'account', default: [],
    options: [{ value: 'tech', label: 'Technology' }, { value: 'sport', label: 'Sport' }] },
  { key: 'short-version', label: 'Short version', type: 'boolean', scope: 'account', default: false },
  { key: 'max-items', label: 'Items', type: 'integer', scope: 'account_overridable', min: 1, max: 50, default: 10 },
  { key: 'ratio', label: 'Ratio', type: 'number', scope: 'deployment', min: 0, max: 1, default: 0.5 },
  { key: 'notes', label: 'Notes', type: 'text', scope: 'account', max_length: 200 },
  { key: 'generation-endpoint', label: 'Generator', type: 'string', scope: 'deployment', deliver: 'backend', default: 'https://generator.invalid/v1' },
  { key: 'feed-token', label: 'Feed credential', type: 'secret', scope: 'deployment' },
  { key: 'token-sort', label: 'Sort', type: 'string', scope: 'account' },
  // An Account's own value the browser never sees (N13): the R3 case.
  { key: 'callback-url', label: 'Callback', type: 'string', scope: 'account', deliver: 'backend' },
];

let server: http.Server;
let upstream: http.Server;
let origin: string;
let loader: any;
let directory: string;
let last: { path: string; method: string; headers: http.IncomingHttpHeaders } | null = null;
let loadLines: string[] = [];
/** The installation file's entries, as written (E7 re-reads a revised copy). */
let installation: any[] = [];

interface Caller { label: string; principalId: string; headers: Record<string, string> }
interface Answer { status: number; json: any; text: string; headers: Headers }

async function call(who: Caller, method: string, routePath: string, body?: unknown, extra: Record<string, string> = {}): Promise<Answer> {
  const response = await fetch(`${origin}${routePath}`, {
    method,
    headers: { 'Content-Type': 'application/json', Connection: 'close', ...who.headers, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, text, headers: response.headers };
}

const tag = (): string => crypto.randomBytes(5).toString('hex');
const freshKey = (): string => `pa-${crypto.randomUUID()}`;

async function makeAccount(role: string, label: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role) VALUES ('human', $1, $2, 'active', $3) RETURNING id`,
    [`pa-${label}-${tag()}`, `PA ${label}`, role]);
  return String(result.rows[0].id);
}
async function sessionFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}
async function person(label: string, role = 'editor'): Promise<Caller> {
  return sessionFor(label, await makeAccount(role, label));
}
async function connectorOf(accountId: string, scopes: string[]): Promise<Caller> {
  const created = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, $1, 'active', $2, 'plugin availability drill connector', $3::jsonb) RETURNING id`,
    [`pa-connector-${tag()}`, accountId, JSON.stringify({ scopes: 'parent', objects: 'parent' })]);
  const id = String(created.rows[0].id);
  const issued = await principalService.issueCredential({ principalId: id, scopes, label: `pa-${tag()}`, transport: 'any' });
  return { label: 'connector', principalId: id, headers: { Authorization: `Bearer ${issued.fullKey}` } };
}
/** A bearer credential whose principal IS the Account (issued to a carrier, then rebound). */
async function bearerOfAccount(accountId: string, scopes: string[]): Promise<Caller> {
  const carrier = await connectorOf(accountId, scopes);
  await pool.query('UPDATE principal_credentials SET principal_id = $2 WHERE principal_id = $1', [carrier.principalId, accountId]);
  principalService.invalidatePrincipals([carrier.principalId, accountId]);
  return { ...carrier, label: 'account-bearer', principalId: accountId };
}
/** A principal_api_key bearer HOLDING root (minted narrow, widened in raw SQL), as the precedent drills build one. */
async function rootBearerFor(accountId: string): Promise<Caller> {
  const created = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role, parent_principal_id)
     VALUES ('service', $1, $1, 'active', 'user', $2) RETURNING id`, [`pa-bearer-${tag()}`, accountId]);
  const bearerId = String(created.rows[0].id);
  const issued = await principalService.issueCredential({ principalId: bearerId, scopes: ['principals:read'], label: 'pa', transport: 'api' });
  await pool.query('UPDATE principals SET parent_principal_id = NULL WHERE id = $1', [bearerId]);
  await pool.query('UPDATE principal_credentials SET scopes = $2::jsonb WHERE id = $1', [issued.credentialId, JSON.stringify(['root'])]);
  principalService.invalidatePrincipals([bearerId]);
  return { label: 'root-bearer', principalId: bearerId, headers: { Authorization: `Bearer ${issued.fullKey}` } };
}

async function stepUp(principalId: string, name: string): Promise<string> {
  return (await stepUpService.mint(principalId, 'plugin.admin', name, 'password')).token;
}
async function tokenConsumed(token: string): Promise<boolean> {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return (await pool.query('SELECT consumed_at FROM step_up_tokens WHERE token_hash = $1', [hash])).rows[0]?.consumed_at != null;
}

/** Stored rows, read directly: the OUTSIDE ANCHOR every route answer is compared with. */
async function storedState(name: string): Promise<{ state: string | null; version: number }> {
  const row = (await pool.query('SELECT availability, version FROM plugin_policies WHERE plugin_name = $1', [name])).rows[0];
  return { state: row?.availability ?? null, version: row ? Number(row.version) : 0 };
}
async function storedValues(name: string, accountId: string | null): Promise<{ values: any; locked: string[]; version: number } | null> {
  const row = (await pool.query(
    `SELECT settings_values, locked_keys, version FROM plugin_settings
      WHERE plugin_name = $1 AND account_principal_id IS NOT DISTINCT FROM $2::uuid`, [name, accountId])).rows[0];
  return row ? { values: row.settings_values, locked: row.locked_keys, version: Number(row.version) } : null;
}
async function storedChoice(name: string, accountId: string): Promise<{ enabled: boolean; version: number } | null> {
  const row = (await pool.query(
    'SELECT enabled, version FROM plugin_account_choices WHERE plugin_name = $1 AND account_principal_id = $2', [name, accountId])).rows[0];
  return row ? { enabled: row.enabled, version: Number(row.version) } : null;
}
async function reset(name: string): Promise<void> {
  await pool.query('DELETE FROM plugin_policies WHERE plugin_name = $1', [name]);
  await pool.query('DELETE FROM plugin_settings WHERE plugin_name = $1', [name]);
  await pool.query('DELETE FROM plugin_account_choices WHERE plugin_name = $1', [name]);
}
async function setState(name: string, state: string): Promise<void> {
  await pool.query(`INSERT INTO plugin_policies (plugin_name, availability) VALUES ($1, $2)
    ON CONFLICT (plugin_name) DO UPDATE SET availability = EXCLUDED.availability, version = plugin_policies.version + 1`, [name, state]);
}
async function setChoice(name: string, accountId: string, enabled: boolean | null): Promise<void> {
  if (enabled === null) {
    await pool.query('DELETE FROM plugin_account_choices WHERE plugin_name = $1 AND account_principal_id = $2', [name, accountId]);
    return;
  }
  await pool.query(`INSERT INTO plugin_account_choices (plugin_name, account_principal_id, enabled) VALUES ($1, $2, $3)
    ON CONFLICT ON CONSTRAINT plugin_account_choices_pkey DO UPDATE SET enabled = EXCLUDED.enabled, version = plugin_account_choices.version + 1`,
  [name, accountId, enabled]);
}
const resolvesOn = (state: string, choice: boolean | null) =>
  state === 'required' || (state === 'default_on' && choice !== false) || (state === 'available' && choice === true);

/** Administrator writes, each with a fresh step-up unless one is given. */
async function adminPolicy(who: Caller, name: string, body: Record<string, unknown>, extra: Record<string, string> = {}): Promise<Answer> {
  const revision = (await storedState(name)).version;
  return call(who, 'PUT', `/plugin-admin/${name}/policy`,
    { stepUpToken: await stepUp(who.principalId, name), ...body }, { 'If-Match': String(revision), ...extra });
}
async function adminSettings(who: Caller, name: string, body: Record<string, unknown>, extra: Record<string, string> = {}): Promise<Answer> {
  const revision = (await storedValues(name, null))?.version ?? 0;
  return call(who, 'PUT', `/plugin-admin/${name}/settings`,
    { stepUpToken: await stepUp(who.principalId, name), ...body }, { 'If-Match': String(revision), ...extra });
}
async function ownValues(who: Caller, name: string, values: unknown, extra: Record<string, string> = {}): Promise<Answer> {
  const revision = (await storedValues(name, who.principalId))?.version ?? 0;
  return call(who, 'PUT', `/plugin-host/${name}/settings/account`, { values }, { 'If-Match': String(revision), ...extra });
}
async function ownChoice(who: Caller, name: string, enabled: boolean, extra: Record<string, string> = {}): Promise<Answer> {
  const revision = (await storedChoice(name, who.principalId))?.version ?? 0;
  return call(who, 'PUT', `/plugin-host/${name}/choice`, { enabled }, { 'If-Match': String(revision), ...extra });
}

const registryNames = async (who: Caller): Promise<string[]> =>
  ((await call(who, 'GET', '/plugins')).json?.plugins ?? []).map((entry: any) => entry.name).sort();
const choiceNames = async (who: Caller): Promise<string[]> =>
  ((await call(who, 'GET', '/plugin-host/choices')).json?.plugins ?? []).map((entry: any) => entry.name).sort();

/** One proxied read as `who`; returns the status and the assertion the core sent upstream. */
async function proxied(who: Caller, name: string, method = 'GET', sub = '/item'): Promise<{ status: number; assertion?: string }> {
  last = null;
  const answer = await call(who, method, `/plugins/${name}${sub}`);
  return { status: answer.status, assertion: last ? String((last as any).headers['x-relayhall-assertion']) : undefined };
}
const effective = (name: string, assertion: string | undefined, extra: Record<string, string> = {}) =>
  call({ label: 'plugin-backend', principalId: '', headers: {} }, 'GET', `/plugin-host/${name}/settings/effective`, undefined,
    { ...(assertion === undefined ? {} : { 'X-RelayHall-Assertion': assertion }), ...extra });

function manifest(name: string, port: number, extra: Record<string, unknown> = {}, v1 = true): any {
  return {
    ...(v1 ? { schema_version: 'rh.plugin/1' } : {}), name, version: '1.0.0', description: `${name} fixture`,
    docker: { image: 'fixture:1', ports: {}, network_mode: 'host' },
    api: { base_path: '/plugins/' + name.replace(/^claw-/, ''), internal_port: port, health: '/health', allow: [
      { path: '/', methods: ['GET', 'HEAD'], capability: 'view' },
      { path: '/run', methods: ['POST'], match: 'exact', capability: 'generate' },
    ] },
    ui: { enabled: true, sidebar: [{ label: `${name} label`, icon: 'circle', path: '/plugins/' + name }] },
    ...(v1 ? { relayhall: { api_version: 1, trust: 'installed', capabilities: [] } } : {}),
    ...extra,
  };
}

let ALICE: Caller; let BOB: Caller; let CAROL: Caller; let DAVE: Caller;
let ADMIN: Caller; let OPERATOR: Caller; let ROOT_BEARER: Caller; let LEGACY_KEY: Caller;
let ALICE_BEARER: Caller; let ALICE_CONNECTOR: Caller;

beforeAll(async () => {
  for (const name of FIXTURES) await reset(name);
  ALICE = await person('alice'); BOB = await person('bob'); CAROL = await person('carol'); DAVE = await person('dave');
  ADMIN = await person('admin', 'admin'); OPERATOR = await person('operator', 'operator');
  ROOT_BEARER = await rootBearerFor(ADMIN.principalId);
  LEGACY_KEY = { label: 'legacy', principalId: '', headers: { 'x-api-key': String(process.env.RELAYHALL_API_KEY) } };
  ALICE_BEARER = await bearerOfAccount(ALICE.principalId, ['services:read', 'services:write']);
  ALICE_CONNECTOR = await connectorOf(ALICE.principalId, ['services:read', 'services:write']);

  upstream = http.createServer((req, res) => {
    if (req.url === '/health') { res.end('ok'); return; }
    req.resume();
    req.on('end', () => { last = { path: String(req.url), method: String(req.method), headers: req.headers }; res.end('ok'); });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const port = (upstream.address() as { port: number }).port;

  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-availability-'));
  const write = (name: string, body: any) => {
    const source = path.join(directory, name.replace(/[^a-z0-9-]/gi, '_') || 'empty');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'plugin.json'), JSON.stringify(body));
    return source;
  };
  const own = (name: string) => { process.env[keyEnv(name)] = keyOf(name); return keyEnv(name); };
  process.env.PLUGIN_AVAILABILITY_TEST_SHARED = keyOf('shared');
  process.env.PLUGIN_AVAILABILITY_TEST_SAME_A = keyOf('same-value');
  process.env.PLUGIN_AVAILABILITY_TEST_SAME_B = keyOf('same-value');
  const plugins = [
    { name: NEWS, source: write(NEWS, manifest(NEWS, port, {
      ui: { enabled: true, sidebar: [{ label: 'News desk', icon: 'circle', path: '/plugins/' + NEWS }], settings_schema: NEWS_SCHEMA } })),
      enabled: true, access: { default: ['view'], assertion_key_env: own(NEWS) } },
    { name: ORB, source: write(ORB, manifest(ORB, port)), enabled: true, access: { default: ['view'], assertion_key_env: own(ORB) } },
    { name: GATED, source: write(GATED, manifest(GATED, port)), enabled: true,
      access: { accounts: { [ALICE.principalId]: ['view'], [BOB.principalId]: ['generate'] }, assertion_key_env: own(GATED) } },
    { name: DETAIL, source: write(DETAIL, manifest(DETAIL, port)), enabled: true, access: { default: ['view'], assertion_key_env: own(DETAIL) } },
    { name: LEGACY, source: write(LEGACY, manifest(LEGACY, port, {}, false)), enabled: true },
    { name: 'bad-schema', source: write('bad-schema', manifest('bad-schema', port, {
      ui: { enabled: true, settings_schema: [{ key: 'colour', label: 'Colour', type: 'json', scope: 'account' }] } })),
      enabled: true, access: { default: ['view'], assertion_key_env: own('bad-schema') } },
    { name: 'dup-one', source: write('dup-one', manifest('dup-one', port)), enabled: true,
      access: { default: ['view'], assertion_key_env: 'PLUGIN_AVAILABILITY_TEST_SHARED' } },
    { name: 'dup-two', source: write('dup-two', manifest('dup-two', port)), enabled: true,
      access: { default: ['view'], assertion_key_env: 'PLUGIN_AVAILABILITY_TEST_SHARED' } },
    { name: 'dup-three', source: write('dup-three', manifest('dup-three', port)), enabled: true,
      access: { default: ['view'], assertion_key_env: 'PLUGIN_AVAILABILITY_TEST_SAME_A' } },
    { name: 'dup-four', source: write('dup-four', manifest('dup-four', port)), enabled: true,
      access: { default: ['view'], assertion_key_env: 'PLUGIN_AVAILABILITY_TEST_SAME_B' } },
    { name: 'Bad_Name', source: write('Bad_Name', manifest('bad-name', port)), enabled: true },
    { name: 'claw-', source: write('claw-', manifest('claw-', port)), enabled: true },
  ];
  installation = plugins;
  fs.writeFileSync(path.join(directory, 'relayhall.plugins.json'), JSON.stringify({ plugins }));
  loader = new PluginLoader(path.join(directory, 'relayhall.plugins.json'), 3_600_000);
  const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
  const warned = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await loader.initialize();
    loadLines = [...logged.mock.calls, ...warned.mock.calls].map((args) => args.map(String).join(' '));
  } finally { logged.mockRestore(); warned.mockRestore(); }
  setPluginLoader(loader); setPluginHostLoader(loader);

  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(createPluginProxy(loader));
  app.get(PLUGIN_EFFECTIVE_SETTINGS_ROUTE_PATH, pluginEffectiveSettingsHandler);
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  loader?.stop();
  for (const target of [server, upstream]) if (target) await new Promise<void>((resolve) => target.close(() => resolve()));
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  await pool.end();
});

// ═════════════════════ (M) migration 166 ═════════════════════

async function catalogSnapshot(q: Queryable = pool): Promise<string> {
  const rows = await q.query(
    `SELECT 'c:' || conrelid::regclass || ':' || conname || ':' || pg_get_constraintdef(oid) AS item FROM pg_constraint
      WHERE conrelid IN ('plugin_policies'::regclass, 'plugin_settings'::regclass, 'plugin_account_choices'::regclass)
     UNION ALL
     SELECT 'i:' || indexname || ':' || indexdef FROM pg_indexes
      WHERE tablename IN ('plugin_policies', 'plugin_settings', 'plugin_account_choices')
     UNION ALL
     SELECT 'o:' || conname || ':' || pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conrelid = 'operation_idempotency_records'::regclass
        AND conname IN ('operation_idempotency_operation_policy', 'operation_idempotency_operation_scope')
     ORDER BY 1`);
  return rows.rows.map((row: any) => row.item).join('\n');
}

/** Run one statement inside a transaction that is ALWAYS rolled back. */
async function probe(sql: string, params: unknown[] = []): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try { await client.query(sql, params); return 'admitted'; } catch (error: any) { return String(error?.constraint ?? error?.code ?? error?.message); }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('(M) migration 166, pinned by name', () => {
  it('M1 re-applies cleanly, a rerun changes nothing, and it opens no transaction of its own', async () => {
    const sql = fs.readFileSync(MIGRATION_FILE, 'utf8');
    // 166 redefines the retry-contract CHECKs, which the next migration that
    // adds a retried operation widens again; a committed replay would then
    // narrow them under every later suite on the shared database (machinery
    // queue 9b761f09). The replay is rolled back and the schema proven as found.
    // Rows a later widening admits and 166's own CHECKs reject (none until a
    // later migration widens them) are set aside first, in the same transaction.
    const once = await replayInRolledBackTransaction(pool, 'the replay of migration 166', async (client) => {
      await setAsideRowsOnlyLaterMigrationsAdmit(client, path.basename(MIGRATION_FILE));
      await client.query(sql);
      const first = await catalogSnapshot(client);
      await client.query(sql);
      expect(await catalogSnapshot(client)).toBe(first);
      return first;
    });
    expect(sql.replace(/--[^\n]*/g, '')).not.toMatch(/^\s*(COMMIT|BEGIN|ROLLBACK|START\s+TRANSACTION|END)\s*;/im);
    for (const name of ['plugin_policies_availability', 'plugin_settings_layer', 'plugin_settings_owner_matches_layer',
      'plugin_settings_locks_deployment_only', 'plugin_settings_values_object', 'plugin_settings_one_row_per_owner',
      'plugin_account_choices_pkey']) {
      expect(once).toContain(`:${name}:`);
    }
    expect(once).toMatch(/plugin_settings_one_row_per_owner:UNIQUE NULLS NOT DISTINCT \(plugin_name, layer, account_principal_id\)/);
  });

  it('M2 exactly one deployment row per plugin, and the layer, owner, lock and object CHECKs refuse', async () => {
    const plugin = `m2-${tag()}`;
    await pool.query(`INSERT INTO plugin_settings (plugin_name, layer) VALUES ($1, 'deployment')`, [plugin]);
    try {
      expect(await probe(`INSERT INTO plugin_settings (plugin_name, layer) VALUES ($1, 'deployment')`, [plugin]))
        .toBe('plugin_settings_one_row_per_owner');
      expect(await probe(`INSERT INTO plugin_settings (plugin_name, layer, account_principal_id) VALUES ($1, 'group', $2)`, [plugin, ALICE.principalId]))
        .toBe('plugin_settings_layer');
      expect(await probe(`INSERT INTO plugin_settings (plugin_name, layer) VALUES ($1, 'account')`, [plugin]))
        .toBe('plugin_settings_owner_matches_layer');
      expect(await probe(`INSERT INTO plugin_settings (plugin_name, layer, account_principal_id) VALUES ($1, 'deployment', $2)`, [`${plugin}-x`, ALICE.principalId]))
        .toBe('plugin_settings_owner_matches_layer');
      expect(await probe(`INSERT INTO plugin_settings (plugin_name, layer, account_principal_id, locked_keys) VALUES ($1, 'account', $2, '{language}')`, [plugin, ALICE.principalId]))
        .toBe('plugin_settings_locks_deployment_only');
      expect(await probe(`INSERT INTO plugin_settings (plugin_name, layer, account_principal_id, settings_values) VALUES ($1, 'account', $2, '[]')`, [plugin, ALICE.principalId]))
        .toBe('plugin_settings_values_object');
      expect(await probe(`INSERT INTO plugin_policies (plugin_name, availability) VALUES ($1, 'hidden')`, [plugin]))
        .toBe('plugin_policies_availability');
      // An Account's own row is one per (plugin, Account) as well.
      await pool.query(`INSERT INTO plugin_settings (plugin_name, layer, account_principal_id) VALUES ($1, 'account', $2)`, [plugin, ALICE.principalId]);
      expect(await probe(`INSERT INTO plugin_settings (plugin_name, layer, account_principal_id) VALUES ($1, 'account', $2)`, [plugin, ALICE.principalId]))
        .toBe('plugin_settings_one_row_per_owner');
      expect(await probe(`INSERT INTO plugin_settings (plugin_name, layer, account_principal_id) VALUES ($1, 'account', $2)`, [plugin, BOB.principalId]))
        .toBe('admitted');
    } finally { await reset(plugin); }
  });
});

// ═════════════════════ (A) availability ═════════════════════

describe('(A) availability narrows, never widens', () => {
  it('A1 the bridge, the registry, the settings read and the proxy follow every state and switch for an Account the file allows', async () => {
    const seen: string[] = [];
    const expected: string[] = [];
    for (const state of STATES) {
      for (const choice of [null, true, false]) {
        await reset(ORB);
        await setState(ORB, state);
        await setChoice(ORB, ALICE.principalId, choice);
        const on = resolvesOn(state, choice);
        const bridge = (await call(ALICE, 'GET', `/plugin-host/${ORB}/bridge`)).status;
        const listed = (await registryNames(ALICE)).includes(ORB);
        const settings = (await call(ALICE, 'GET', `/plugin-host/${ORB}/settings`)).status;
        const read = (await proxied(ALICE, ORB)).status;
        seen.push(`${state}/${choice}: bridge ${bridge} listed ${listed} settings ${settings} proxy ${read}`);
        expected.push(`${state}/${choice}: bridge ${on ? 200 : 404} listed ${on} settings ${on ? 200 : 404} proxy ${on ? 200 : 404}`);
      }
    }
    expect(seen).toEqual(expected);
    await reset(ORB);
  });

  it('A2 policy never widens: an Account the installation file does not allow sees nothing in any state or switch', async () => {
    const seen: string[] = [];
    for (const state of STATES) {
      for (const choice of [null, true]) {
        await reset(GATED);
        await setState(GATED, state);
        await setChoice(GATED, CAROL.principalId, choice);
        seen.push([
          (await call(CAROL, 'GET', `/plugin-host/${GATED}/bridge`)).status,
          (await registryNames(CAROL)).includes(GATED),
          (await choiceNames(CAROL)).includes(GATED),
          (await call(CAROL, 'GET', `/plugin-host/${GATED}/settings`)).status,
          (await proxied(CAROL, GATED)).status,
          (await proxied(CAROL, GATED, 'POST', '/run')).status,
        ].join(' '));
      }
    }
    expect(seen).toEqual(Array(8).fill('404 false false 404 404 404'));
    await reset(GATED);
  });

  it('A3 an explicit generate grant without view does not bypass availability on the proxy', async () => {
    const seen: string[] = [];
    const expected: string[] = [];
    for (const state of STATES) {
      for (const choice of [null, true, false]) {
        await reset(GATED);
        await setState(GATED, state);
        await setChoice(GATED, BOB.principalId, choice);
        const write = (await proxied(BOB, GATED, 'POST', '/run')).status;
        const bridge = (await call(BOB, 'GET', `/plugin-host/${GATED}/bridge`)).status;
        seen.push(`${state}/${choice}: write ${write} bridge ${bridge}`);
        expected.push(`${state}/${choice}: write ${resolvesOn(state, choice) ? 200 : 404} bridge 404`);
      }
    }
    expect(seen).toEqual(expected);
    await reset(GATED);
  });

  it('A4 GET /plugins/:name answers for the active Account and its existing 404 for a hidden plugin', async () => {
    await reset(DETAIL);
    const shown = await call(ADMIN, 'GET', `/plugins/${DETAIL}`);
    expect({ status: shown.status, name: shown.json?.name }).toEqual({ status: 200, name: DETAIL });
    await setState(DETAIL, 'disabled');
    const hidden = await call(ADMIN, 'GET', `/plugins/${DETAIL}`);
    expect({ status: hidden.status, body: hidden.json }).toEqual({ status: 404, body: { error: `Plugin not found: ${DETAIL}` } });
    await setState(DETAIL, 'available');
    expect((await call(ADMIN, 'GET', `/plugins/${DETAIL}`)).status).toBe(404);
    await setChoice(DETAIL, ADMIN.principalId, true);
    expect((await call(ADMIN, 'GET', `/plugins/${DETAIL}`)).status).toBe(200);
    await reset(DETAIL);
  });

  it('A5 legacy (non-v1) plugins are outside policy and keep today\'s behaviour (C10)', async () => {
    await setState(LEGACY, 'disabled');
    try {
      expect(await registryNames(ALICE)).toContain(LEGACY);
      expect((await call(ADMIN, 'GET', `/plugins/${LEGACY}`)).status).toBe(200);
      expect((await call(ADMIN, 'GET', `/plugin-admin/${LEGACY}/policy`)).text).toBe(NOT_FOUND);
      expect((await call(ALICE, 'GET', `/plugin-host/${LEGACY}/bridge`)).text).toBe(NOT_FOUND);
      expect(await choiceNames(ALICE)).not.toContain(LEGACY);
    } finally { await reset(LEGACY); }
  });
});

// ═════════════════════ (C) concealment ═════════════════════

describe('(C) concealment', () => {
  it('C1 every host route answers the byte-identical 404 for unknown, legacy, file-invisible, disabled and switched-off plugins', async () => {
    await reset(ORB); await reset(GATED);
    await setState(ORB, 'disabled');
    const hidden = [`unknown-${tag()}`, LEGACY, ORB];
    const answers: string[] = [];
    for (const name of hidden) {
      answers.push((await call(ALICE, 'GET', `/plugin-host/${name}/bridge`)).text);
      answers.push((await call(ALICE, 'GET', `/plugin-host/${name}/settings`)).text);
      answers.push((await call(ALICE, 'PUT', `/plugin-host/${name}/settings/account`, { values: {} }, { 'If-Match': '0' })).text);
      answers.push((await call(ALICE, 'PUT', `/plugin-host/${name}/choice`, { enabled: true }, { 'If-Match': '0' })).text);
    }
    // File-invisible: CAROL on the gated plugin.
    answers.push((await call(CAROL, 'GET', `/plugin-host/${GATED}/bridge`)).text);
    answers.push((await call(CAROL, 'GET', `/plugin-host/${GATED}/settings`)).text);
    answers.push((await call(CAROL, 'PUT', `/plugin-host/${GATED}/choice`, { enabled: true }, { 'If-Match': '0' })).text);
    // Switched off: an available plugin Alice never turned on, on every non-choice route.
    await reset(ORB); await setState(ORB, 'available');
    answers.push((await call(ALICE, 'GET', `/plugin-host/${ORB}/bridge`)).text);
    answers.push((await call(ALICE, 'GET', `/plugin-host/${ORB}/settings`)).text);
    answers.push((await call(ALICE, 'PUT', `/plugin-host/${ORB}/settings/account`, { values: {} }, { 'If-Match': '0' })).text);
    expect(new Set(answers)).toEqual(new Set([NOT_FOUND]));
    // The proxy's own 404, for reads and writes, unchanged in shape.
    const read = await call(ALICE, 'GET', `/plugins/${ORB}/item`);
    const write = await call(ALICE, 'POST', `/plugins/${ORB}/run`);
    expect([read.status, read.text, write.status, write.text]).toEqual([404, NOT_FOUND, 404, NOT_FOUND]);
    expect(await registryNames(ALICE)).not.toContain(ORB);
    await reset(ORB);
  });

  it('C2 the choice route and the eligible list find a switched-off default_on or available plugin, and nothing else about it', async () => {
    await reset(ORB);
    await setState(ORB, 'available');
    const list = (await call(ALICE, 'GET', '/plugin-host/choices')).json.plugins.find((entry: any) => entry.name === ORB);
    expect(list).toEqual({ name: ORB, label: `${ORB} label`, state: 'available', enabled: false, userControlled: true, revision: 0 });
    expect(Object.keys(list).sort()).toEqual(['enabled', 'label', 'name', 'revision', 'state', 'userControlled']);
    expect((await call(ALICE, 'GET', `/plugin-host/${ORB}/settings`)).status).toBe(404);
    const on = await ownChoice(ALICE, ORB, true);
    expect({ status: on.status, enabled: on.json.enabled, revision: on.json.revision }).toEqual({ status: 200, enabled: true, revision: 1 });
    expect(await storedChoice(ORB, ALICE.principalId)).toEqual({ enabled: true, version: 1 });
    expect((await call(ALICE, 'GET', `/plugin-host/${ORB}/bridge`)).status).toBe(200);
    // default_on, switched off: still eligible, still found on the choice route.
    await setState(ORB, 'default_on');
    expect((await ownChoice(ALICE, ORB, false)).status).toBe(200);
    expect((await call(ALICE, 'GET', `/plugin-host/${ORB}/bridge`)).status).toBe(404);
    expect(await choiceNames(ALICE)).toContain(ORB);
    // disabled and file-invisible: absent from the list, and the choice route 404s.
    await setState(ORB, 'disabled');
    expect(await choiceNames(ALICE)).not.toContain(ORB);
    expect((await ownChoice(ALICE, ORB, true)).text).toBe(NOT_FOUND);
    expect(await choiceNames(CAROL)).not.toContain(GATED);
    await reset(ORB);
  });

  it('C3 required answers 409 CHOICE_NOT_ALLOWED; a kept choice applies again when the state returns', async () => {
    await reset(ORB);
    expect((await ownChoice(ALICE, ORB, false)).status).toBe(200);
    await setState(ORB, 'required');
    const refused = await ownChoice(ALICE, ORB, true);
    expect({ status: refused.status, code: refused.json.code }).toEqual({ status: 409, code: 'CHOICE_NOT_ALLOWED' });
    expect((await call(ALICE, 'GET', `/plugin-host/${ORB}/bridge`)).status).toBe(200);
    expect(await storedChoice(ORB, ALICE.principalId)).toEqual({ enabled: false, version: 1 });
    await setState(ORB, 'default_on');
    expect((await call(ALICE, 'GET', `/plugin-host/${ORB}/bridge`)).status).toBe(404);
    await reset(ORB);
  });

  it('C4 an administrator may clear every choice with a state change, audited with a count (N14)', async () => {
    await reset(ORB);
    expect((await ownChoice(ALICE, ORB, false)).status).toBe(200);
    expect((await ownChoice(BOB, ORB, false)).status).toBe(200);
    const changed = await adminPolicy(ADMIN, ORB, { availability: 'available', clearChoices: true });
    expect({ status: changed.status, state: changed.json.state, cleared: changed.json.clearedChoices })
      .toEqual({ status: 200, state: 'available', cleared: 2 });
    expect([await storedChoice(ORB, ALICE.principalId), await storedChoice(ORB, BOB.principalId)]).toEqual([null, null]);
    const audit = (await pool.query(
      `SELECT metadata FROM audit_events WHERE action = 'plugin.policy.set' AND resource_id = $1 AND outcome = 'success'
        ORDER BY occurred_at DESC, id DESC LIMIT 1`, [ORB])).rows[0].metadata;
    expect(audit).toMatchObject({ clearChoices: true, clearedChoices: 2, availability: 'available', previous: 'default_on', revision: 1 });
    await reset(ORB);
  });
});

// ═════════════════════ (R) resolution ═════════════════════

describe('(R) resolution across the three layers', () => {
  it('R1 the Account value, then the administrators\' value, then the schema default', async () => {
    await reset(NEWS);
    expect((await adminSettings(ADMIN, NEWS, { values: { language: 'pl', 'max-items': 20, ratio: 0.25 } })).status).toBe(200);
    expect((await ownValues(ALICE, NEWS, { language: 'de', topics: ['tech'], 'token-sort': 'newest' })).status).toBe(200);
    const alice = (await call(ALICE, 'GET', `/plugin-host/${NEWS}/settings`)).json;
    expect(alice.values).toMatchObject({ language: 'de', topics: ['tech'], 'max-items': 20, ratio: 0.25, 'short-version': false, 'token-sort': 'newest' });
    expect(alice.sources).toMatchObject({
      language: { source: 'account', locked: false }, 'max-items': { source: 'deployment', locked: false },
      ratio: { source: 'deployment', locked: false }, 'short-version': { source: 'default', locked: false },
    });
    const bob = (await call(BOB, 'GET', `/plugin-host/${NEWS}/settings`)).json;
    expect(bob.values).toMatchObject({ language: 'pl', topics: [], 'max-items': 20 });
    expect(bob.sources.language).toEqual({ source: 'deployment', locked: false });
  });

  it('R2 a lock overrides the Account value and keeps it stored; unlocking restores it', async () => {
    expect((await adminSettings(ADMIN, NEWS, { values: { language: 'pl', 'max-items': 20, ratio: 0.25 }, lockedKeys: ['language'] })).status).toBe(200);
    let alice = (await call(ALICE, 'GET', `/plugin-host/${NEWS}/settings`)).json;
    expect({ value: alice.values.language, source: alice.sources.language }).toEqual({ value: 'pl', source: { source: 'deployment', locked: true } });
    expect((await storedValues(NEWS, ALICE.principalId))!.values.language).toBe('de');
    const write = await ownValues(ALICE, NEWS, { language: 'en' });
    expect({ status: write.status, code: write.json.code, field: write.json.field }).toEqual({ status: 409, code: 'PLUGIN_SETTINGS_KEY_LOCKED', field: 'language' });
    // A write that leaves the locked key out keeps its stored value.
    expect((await ownValues(ALICE, NEWS, { topics: ['sport'] })).status).toBe(200);
    expect((await storedValues(NEWS, ALICE.principalId))!.values).toEqual({ language: 'de', topics: ['sport'] });
    expect((await adminSettings(ADMIN, NEWS, { values: { language: 'pl', 'max-items': 20, ratio: 0.25 }, lockedKeys: [] })).status).toBe(200);
    alice = (await call(ALICE, 'GET', `/plugin-host/${NEWS}/settings`)).json;
    expect({ value: alice.values.language, source: alice.sources.language }).toEqual({ value: 'de', source: { source: 'account', locked: false } });
  });

  it('R3 a save from the form keeps the Account\'s own deliver: backend value; naming the key validates and replaces it, null removes it (N13)', async () => {
    await reset(NEWS);
    const hook = 'https://alice.invalid/hook';
    expect((await ownValues(ALICE, NEWS, { 'callback-url': hook, notes: 'first' })).status).toBe(200);
    // The Account's own read shows the key and its source, never the value.
    const view = (await call(ALICE, 'GET', `/plugin-host/${NEWS}/settings`)).json;
    expect(view.values).not.toHaveProperty('callback-url');
    expect(view.sources['callback-url']).toEqual({ source: 'account', locked: false });
    expect(JSON.stringify(view)).not.toContain('alice.invalid');
    expect(JSON.stringify((await call(ALICE, 'GET', `/plugin-host/${NEWS}/bridge`)).json)).not.toContain('alice.invalid');
    // The form sends back the Account's own values from that read, one changed:
    // the stored backend-only value is kept, and the audit names only the change.
    const fromForm = Object.fromEntries(Object.entries(view.values).filter(([key]) => view.sources[key]?.source === 'account'));
    expect(fromForm).toEqual({ notes: 'first' });
    const saved = await ownValues(ALICE, NEWS, { ...fromForm, notes: 'second' });
    expect([saved.status, saved.json.changedKeys]).toEqual([200, ['notes']]);
    expect((await storedValues(NEWS, ALICE.principalId))!.values).toEqual({ 'callback-url': hook, notes: 'second' });
    const { assertion } = await proxied(ALICE, NEWS);
    expect((await effective(NEWS, assertion)).json.values['callback-url']).toBe(hook);
    // A reset (an empty object) clears every key the read showed and keeps it too.
    expect((await ownValues(ALICE, NEWS, {})).status).toBe(200);
    expect((await storedValues(NEWS, ALICE.principalId))!.values).toEqual({ 'callback-url': hook });
    // Naming the key validates it like every value, and a refusal stores nothing.
    const shaped = await ownValues(ALICE, NEWS, { 'callback-url': 'rh_live_abcdefgh.ijklmnopqrstu' });
    const typed = await ownValues(ALICE, NEWS, { 'callback-url': 42 });
    const scoped = await ownValues(ALICE, NEWS, { ratio: null });
    expect([shaped, typed, scoped].map((answer) => `${answer.status} ${answer.json.code} ${answer.json.field}`)).toEqual([
      '400 PLUGIN_SETTINGS_VALUE_SECRET callback-url', '400 PLUGIN_SETTINGS_VALUE_INVALID callback-url', '400 PLUGIN_SETTINGS_KEY_WRONG_SCOPE ratio']);
    expect((await storedValues(NEWS, ALICE.principalId))!.values).toEqual({ 'callback-url': hook });
    // Naming it with a value replaces it; naming it with null removes it.
    expect((await ownValues(ALICE, NEWS, { 'callback-url': 'https://alice.invalid/v2' })).status).toBe(200);
    expect((await storedValues(NEWS, ALICE.principalId))!.values).toEqual({ 'callback-url': 'https://alice.invalid/v2' });
    const removed = await ownValues(ALICE, NEWS, { 'callback-url': null, notes: 'third' });
    expect([removed.status, removed.json.changedKeys]).toEqual([200, ['callback-url', 'notes']]);
    expect((await storedValues(NEWS, ALICE.principalId))!.values).toEqual({ notes: 'third' });
    await reset(NEWS);
  });
});

// ═════════════════════ (V) values ═════════════════════

describe('(V) value validation at write', () => {
  it('V1 refuses every value outside its declared type or bound, and stores nothing', async () => {
    await reset(NEWS);
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ 'max-items': 0 }, 400, 'PLUGIN_SETTINGS_VALUE_INVALID'],
      [{ topics: ['politics'] }, 400, 'PLUGIN_SETTINGS_VALUE_INVALID'],
      [{ topics: ['tech', 'tech'] }, 400, 'PLUGIN_SETTINGS_VALUE_INVALID'],
      [{ 'short-version': 'yes' }, 400, 'PLUGIN_SETTINGS_VALUE_INVALID'],
      [{ notes: 'x'.repeat(201) }, 400, 'PLUGIN_SETTINGS_VALUE_INVALID'],
      [{ notes: 'bell\u0007' }, 400, 'PLUGIN_SETTINGS_VALUE_INVALID'],
      [{ language: 'fr' }, 400, 'PLUGIN_SETTINGS_VALUE_INVALID'],
      [{ notes: 'x'.repeat(4097) }, 400, 'PLUGIN_SETTINGS_STRING_TOO_LONG'],
      [{ topics: Array(40).fill('y'.repeat(450)) }, 413, 'PLUGIN_SETTINGS_TOO_LARGE'],
      [{ colour: 'red' }, 400, 'PLUGIN_SETTINGS_KEY_UNKNOWN'],
    ];
    const seen: string[] = [];
    for (const [values, status, code] of cases) {
      const answer = await ownValues(ALICE, NEWS, values);
      seen.push(`${JSON.stringify(values).slice(0, 40)} ${answer.status} ${answer.json?.code}`);
      expect(`${JSON.stringify(values).slice(0, 40)} ${answer.status} ${answer.json?.code}`).toBe(`${JSON.stringify(values).slice(0, 40)} ${status} ${code}`);
    }
    // Administrator bounds: below min, above max, fractional.
    for (const value of [0, 51, 2.5]) {
      const answer = await adminSettings(ADMIN, NEWS, { values: { 'max-items': value } });
      expect([answer.status, answer.json.code]).toEqual([400, 'PLUGIN_SETTINGS_VALUE_INVALID']);
    }
    for (const value of [-0.1, 1.1]) {
      expect((await adminSettings(ADMIN, NEWS, { values: { ratio: value } })).json.code).toBe('PLUGIN_SETTINGS_VALUE_INVALID');
    }
    expect([await storedValues(NEWS, ALICE.principalId), await storedValues(NEWS, null)]).toEqual([null, null]);
    expect(seen).toHaveLength(cases.length);
    // At each bound the value is accepted.
    expect((await adminSettings(ADMIN, NEWS, { values: { 'max-items': 50, ratio: 1 } })).status).toBe(200);
    expect((await adminSettings(ADMIN, NEWS, { values: { 'max-items': 1, ratio: 0 } })).status).toBe(200);
    expect((await ownValues(ALICE, NEWS, { 'max-items': 50, notes: 'x'.repeat(200) })).status).toBe(200);
  });

  it('V2 wrong-scope writes are refused for each writer, like unknown keys', async () => {
    const user = await ownValues(BOB, NEWS, { ratio: 0.3 });
    expect([user.status, user.json.code, user.json.field]).toEqual([400, 'PLUGIN_SETTINGS_KEY_WRONG_SCOPE', 'ratio']);
    const admin = await adminSettings(ADMIN, NEWS, { values: { topics: ['tech'] } });
    expect([admin.status, admin.json.code, admin.json.field]).toEqual([400, 'PLUGIN_SETTINGS_KEY_WRONG_SCOPE', 'topics']);
    const lock = await adminSettings(ADMIN, NEWS, { values: {}, lockedKeys: ['ratio'] });
    expect([lock.status, lock.json.code]).toEqual([400, 'PLUGIN_SETTINGS_KEY_WRONG_SCOPE']);
    expect(await storedValues(NEWS, BOB.principalId)).toBeNull();
  });

  it('V3 the secret value-shape guard: a token-sort key is accepted, an rh_ value is refused, a secret setting stores nothing', async () => {
    expect((await ownValues(BOB, NEWS, { 'token-sort': 'oldest' })).status).toBe(200);
    const shaped = await ownValues(BOB, NEWS, { 'token-sort': 'rh_live_abcdefgh.ijklmnopqrstu' });
    expect([shaped.status, shaped.json.code, shaped.json.field]).toEqual([400, 'PLUGIN_SETTINGS_VALUE_SECRET', 'token-sort']);
    const adminShaped = await adminSettings(ADMIN, NEWS, { values: { 'generation-endpoint': 'Bearer abcdefghijkl' } });
    expect(adminShaped.json.code).toBe('PLUGIN_SETTINGS_VALUE_SECRET');
    const secret = await adminSettings(ADMIN, NEWS, { values: { 'feed-token': 'plain' } });
    expect([secret.status, secret.json.code]).toEqual([400, 'PLUGIN_SETTINGS_SECRET_NOT_STORED']);
    expect((await storedValues(NEWS, BOB.principalId))!.values).toEqual({ 'token-sort': 'oldest' });
    const view = (await call(BOB, 'GET', `/plugin-host/${NEWS}/settings`)).json;
    expect(view.values).not.toHaveProperty('feed-token');
    expect(view.schema.find((entry: any) => entry.key === 'feed-token')).toMatchObject({ type: 'secret', scope: 'deployment' });
  });
});

// ═════════════════════ (I) If-Match and replay ═════════════════════

describe('(I) If-Match and idempotent replay', () => {
  it('I1 every PUT requires If-Match: absent 400 REVISION_REQUIRED, stale 412 REVISION_MISMATCH, an absent row is revision 0', async () => {
    await reset(ORB); await reset(NEWS);
    const puts: Array<[Caller, string, Record<string, unknown>]> = [
      [ALICE, `/plugin-host/${ORB}/choice`, { enabled: false }],
      [ALICE, `/plugin-host/${NEWS}/settings/account`, { values: { 'short-version': true } }],
      [ADMIN, `/plugin-admin/${ORB}/policy`, { availability: 'available' }],
      [ADMIN, `/plugin-admin/${NEWS}/settings`, { values: { ratio: 0.75 } }],
    ];
    const seen: string[] = [];
    for (const [who, route, body] of puts) {
      const target = route.split('/')[2];
      const withToken = async () => (who === ADMIN ? { ...body, stepUpToken: await stepUp(ADMIN.principalId, target) } : body);
      const absent = await call(who, 'PUT', route, await withToken());
      const stale = await call(who, 'PUT', route, await withToken(), { 'If-Match': '7' });
      const first = await call(who, 'PUT', route, await withToken(), { 'If-Match': '0' });
      const again = await call(who, 'PUT', route, await withToken(), { 'If-Match': '0' });
      const next = await call(who, 'PUT', route, await withToken(), { 'If-Match': '1' });
      seen.push(`${route}: ${absent.status} ${absent.json?.code} ${stale.status} ${stale.json?.code} ${first.status} ${first.json?.revision} `
        + `${again.status} ${again.json?.code} ${next.status} ${next.json?.revision}`);
    }
    expect(seen).toEqual(puts.map(([, route]) => `${route}: 400 REVISION_REQUIRED 412 REVISION_MISMATCH 200 1 412 REVISION_MISMATCH 200 2`));
    await reset(ORB); await reset(NEWS);
  });

  it('I2 the same Idempotency-Key replays the stored receipt for each of the five operations, and the act runs once', async () => {
    await reset(ORB); await reset(NEWS);
    const replayed: string[] = [];
    const once = async (who: Caller, method: string, route: string, body: Record<string, unknown>, ifMatch?: string) => {
      const key = freshKey();
      const headers = { 'Idempotency-Key': key, ...(ifMatch === undefined ? {} : { 'If-Match': ifMatch }) };
      const first = await call(who, method, route, body, headers);
      const second = await call(who, method, route, body, headers);
      const reused = await call(who, method, route, { ...body, extra: true }, headers);
      replayed.push(`${route} ${first.status} ${second.status} ${second.headers.get('retry-replayed')} ${first.text === second.text} ${reused.status} ${reused.json?.code}`);
      expect(JSON.stringify(first.json)).not.toContain(MARKER);
    };
    await once(ALICE, 'PUT', `/plugin-host/${ORB}/choice`, { enabled: false }, '0');
    await once(ALICE, 'PUT', `/plugin-host/${NEWS}/settings/account`, { values: { notes: MARKER } }, '0');
    await once(ADMIN, 'PUT', `/plugin-admin/${ORB}/policy`, { availability: 'available', stepUpToken: await stepUp(ADMIN.principalId, ORB) }, '0');
    await once(ADMIN, 'PUT', `/plugin-admin/${NEWS}/settings`, { values: { ratio: 0.5 }, stepUpToken: await stepUp(ADMIN.principalId, NEWS) }, '0');
    await pool.query(`UPDATE plugin_settings SET settings_values = settings_values || '{"retired": true}'::jsonb WHERE plugin_name = $1 AND layer = 'deployment'`, [NEWS]);
    await once(ADMIN, 'POST', `/plugin-admin/${NEWS}/settings/cleanup`, { stepUpToken: await stepUp(ADMIN.principalId, NEWS) });
    expect(replayed.map((line) => line.replace(/^\S+ /, ''))).toEqual(Array(5).fill('200 200 true true 409 IDEMPOTENCY_KEY_REUSED'));
    // Each act ran exactly once (the stored rows moved by one revision).
    expect([(await storedChoice(ORB, ALICE.principalId))!.version, (await storedValues(NEWS, ALICE.principalId))!.version,
      (await storedState(ORB)).version, (await storedValues(NEWS, null))!.version]).toEqual([1, 1, 1, 2]);
    await reset(ORB); await reset(NEWS);
  });

  it('I3 the closed SQL operation set holds the five plugin operations, credential-scoped with return replay', async () => {
    const rows = await pool.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'operation_idempotency_records'::regclass
          AND conname IN ('operation_idempotency_operation_policy', 'operation_idempotency_operation_scope') ORDER BY conname`);
    const plugin = ['plugin.settings.account.put', 'plugin.choice.put', 'plugin.policy.put', 'plugin.settings.deployment.put', 'plugin.settings.cleanup'];
    for (const operation of plugin) {
      expect(IDEMPOTENT_OPERATIONS[operation]).toEqual({ scope: 'credential', replay: 'return' });
      for (const row of rows.rows) expect(`${row.conname}: ${String(row.def).includes(`'${operation}'`)}`).toBe(`${row.conname}: true`);
    }
    expect(await probe(`INSERT INTO operation_idempotency_records (scope, operation, idempotency_key, request_hash, state, replay_policy, expires_at)
      VALUES ('prin:x', 'plugin.policy.put', $1, 'h', 'in_flight', 'return', now() + interval '1 day')`, [freshKey()]))
      .toBe('operation_idempotency_operation_scope');
    expect(await probe(`INSERT INTO operation_idempotency_records (scope, operation, idempotency_key, request_hash, state, replay_policy, expires_at)
      VALUES ('user:x', 'plugin.policy.put', $1, 'h', 'in_flight', 'refuse', now() + interval '1 day')`, [freshKey()]))
      .toBe('operation_idempotency_operation_policy');
  });
});

// ═════════════════════ (E) the backend effective read ═════════════════════

describe('(E) the plugin backend effective-settings read', () => {
  it('E1 reads the Account\'s effective settings, deliver: backend keys included, with the assertion the proxy issued', async () => {
    await reset(NEWS);
    expect((await adminSettings(ADMIN, NEWS, { values: { 'generation-endpoint': 'https://internal.invalid/generate' } })).status).toBe(200);
    expect((await ownValues(ALICE, NEWS, { language: 'de' })).status).toBe(200);
    const { status, assertion } = await proxied(ALICE, NEWS);
    expect(status).toBe(200);
    const claims = jwt.verify(assertion, keyOf(NEWS), { algorithms: ['HS256'] });
    expect(claims).toMatchObject({ sub: ALICE.principalId, aud: NEWS, iss: 'relayhall', capability: 'view' });
    expect(typeof claims.jti).toBe('string');
    const answer = await effective(NEWS, assertion);
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({ schemaVersion: 'rh.plugin.settings.effective/1', plugin: NEWS, account: ALICE.principalId });
    expect(answer.json.values).toMatchObject({ language: 'de', 'generation-endpoint': 'https://internal.invalid/generate' });
    expect(answer.json.values).not.toHaveProperty('feed-token');
    // Reuse within its lifetime by the same plugin is accepted.
    expect((await effective(NEWS, assertion)).status).toBe(200);
  });

  it('E2 refuses a wrong audience, an expired token, a wrong algorithm, alg none, a forged signature and a wrong issuer', async () => {
    const { assertion } = await proxied(ALICE, NEWS);
    const claims = jwt.decode(assertion);
    const body = { actor: claims.actor, capability: claims.capability };
    const options = { issuer: 'relayhall', audience: NEWS, subject: ALICE.principalId, jwtid: claims.jti };
    const expired = jwt.sign({ ...body, exp: Math.floor(Date.now() / 1000) - 5 }, keyOf(NEWS), { ...options, algorithm: 'HS256' });
    const hs512 = jwt.sign(body, keyOf(NEWS), { ...options, algorithm: 'HS512', expiresIn: 60 });
    const forged = jwt.sign(body, keyOf('someone-else'), { ...options, algorithm: 'HS256', expiresIn: 60 });
    // The issuer pin: the plugin's own key, the issued jti, sub and capability, but not the core's issuer.
    const wrongIssuer = jwt.sign(body, keyOf(NEWS), { ...options, issuer: 'news-desk', algorithm: 'HS256', expiresIn: 60 });
    const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const none = `${segment({ alg: 'none', typ: 'JWT' })}.${segment({ ...claims })}.`;
    const answers = [
      (await effective(ORB, assertion)).text,
      (await effective(NEWS, expired)).text,
      (await effective(NEWS, hs512)).text,
      (await effective(NEWS, none)).text,
      (await effective(NEWS, forged)).text,
      (await effective(NEWS, undefined)).text,
      (await effective(NEWS, wrongIssuer)).text,
    ];
    expect(answers).toEqual(Array(7).fill(NOT_FOUND));
    // The control: the same jti, correctly signed, is accepted.
    expect((await effective(NEWS, jwt.sign(body, keyOf(NEWS), { ...options, algorithm: 'HS256', expiresIn: 60 }))).status).toBe(200);
  });

  it('E3 refuses a validly signed token whose jti the core never issued for that sub', async () => {
    const { assertion } = await proxied(ALICE, NEWS);
    const claims = jwt.decode(assertion);
    const sign = (subject: string, jwtid: string) => jwt.sign({ actor: subject, capability: 'view' }, keyOf(NEWS),
      { algorithm: 'HS256', issuer: 'relayhall', audience: NEWS, subject, jwtid, expiresIn: 60 });
    expect((await effective(NEWS, sign(BOB.principalId, crypto.randomBytes(18).toString('base64url')))).text).toBe(NOT_FOUND);
    expect((await effective(NEWS, sign(BOB.principalId, claims.jti))).text).toBe(NOT_FOUND);
    expect((await effective(NEWS, sign(ALICE.principalId, claims.jti))).status).toBe(200);
  });

  it('E4 refuses a terminated Account and a switched-off plugin within the assertion lifetime', async () => {
    const dave = await proxied(DAVE, NEWS);
    expect((await effective(NEWS, dave.assertion)).status).toBe(200);
    await pool.query(`UPDATE principals SET status = 'disabled' WHERE id = $1`, [DAVE.principalId]);
    expect((await effective(NEWS, dave.assertion)).text).toBe(NOT_FOUND);
    const alice = await proxied(ALICE, NEWS);
    expect((await effective(NEWS, alice.assertion)).status).toBe(200);
    await setState(NEWS, 'disabled');
    expect((await effective(NEWS, alice.assertion)).text).toBe(NOT_FOUND);
    await setState(NEWS, 'available');
    expect((await effective(NEWS, alice.assertion)).text).toBe(NOT_FOUND);
    await setChoice(NEWS, ALICE.principalId, true);
    expect((await effective(NEWS, alice.assertion)).status).toBe(200);
    await pool.query('DELETE FROM plugin_policies WHERE plugin_name = $1', [NEWS]);
  });

  it('E5 reads only X-RelayHall-Assertion: Authorization is ignored, and the assertion authenticates no other route', async () => {
    const { assertion } = await proxied(ALICE, NEWS);
    expect((await call(ALICE_BEARER, 'GET', `/plugin-host/${NEWS}/settings/effective`)).text).toBe(NOT_FOUND);
    expect((await effective(NEWS, undefined, { Authorization: `Bearer ${assertion}` })).text).toBe(NOT_FOUND);
    expect((await effective(NEWS, undefined, ALICE.headers)).text).toBe(NOT_FOUND);
    const elsewhere = await call({ label: 'x', principalId: '', headers: { Authorization: `Bearer ${assertion}` } }, 'GET', `/plugin-host/${NEWS}/settings`);
    expect(elsewhere.status).toBe(401);
    const asHeader = await call({ label: 'x', principalId: '', headers: { 'X-RelayHall-Assertion': assertion! } }, 'GET', '/plugin-host/choices');
    expect(asHeader.status).toBe(401);
  });

  it('E6 an explicit non-view grant reads under the proxy composition, ANDed with availability (N15)', async () => {
    await reset(GATED);
    const bob = await proxied(BOB, GATED, 'POST', '/run');
    expect(bob.status).toBe(200);
    expect(jwt.decode(bob.assertion)).toMatchObject({ capability: 'generate', sub: BOB.principalId });
    expect((await effective(GATED, bob.assertion)).status).toBe(200);
    await setState(GATED, 'disabled');
    expect((await effective(GATED, bob.assertion)).text).toBe(NOT_FOUND);
    await reset(GATED);
  });

  /**
   * A loader over a revised copy of the installation file (N15's re-check):
   * the host's view of the file can change while an assertion it issued still
   * lives, and the effective read must follow the file it holds now, not the
   * one the proxy consulted when it signed.
   */
  async function revisedLoader(access: Record<string, Record<string, unknown>>): Promise<any> {
    const file = path.join(directory, 'relayhall.plugins.revised.json');
    const plugins = installation.filter((entry) => [NEWS, ORB, GATED].includes(entry.name)).map((entry) => (access[entry.name]
      ? { ...entry, access: { ...access[entry.name], assertion_key_env: entry.access.assertion_key_env } } : entry));
    fs.writeFileSync(file, JSON.stringify({ plugins }));
    const revised = new PluginLoader(file, 3_600_000);
    const quiet = jest.spyOn(console, 'log').mockImplementation(() => {});
    try { await revised.initialize(); } finally { quiet.mockRestore(); }
    return revised;
  }

  it('E7 an assertion whose capability the installation file no longer grants is refused within its lifetime (N15)', async () => {
    await reset(GATED); await reset(ORB); await reset(NEWS);
    const bob = await proxied(BOB, GATED, 'POST', '/run');
    const carol = await proxied(CAROL, ORB);
    const alice = await proxied(ALICE, NEWS);
    expect([bob.status, carol.status, alice.status]).toEqual([200, 200, 200]);
    expect([jwt.decode(bob.assertion).capability, jwt.decode(carol.assertion).capability]).toEqual(['generate', 'view']);
    // Bob's explicit generate grant and the Orb's deployment view default are withdrawn; the news desk is unchanged.
    const revised = await revisedLoader({ [GATED]: { accounts: { [ALICE.principalId]: ['view'] } }, [ORB]: { accounts: {} } });
    setPluginHostLoader(revised);
    try {
      expect([(await effective(GATED, bob.assertion)).text, (await effective(ORB, carol.assertion)).text]).toEqual([NOT_FOUND, NOT_FOUND]);
      // The control: an assertion the revised file still grants reads as before.
      expect((await effective(NEWS, alice.assertion)).status).toBe(200);
    } finally {
      setPluginHostLoader(loader);
      revised.stop();
    }
    expect([(await effective(GATED, bob.assertion)).status, (await effective(ORB, carol.assertion)).status]).toEqual([200, 200]);
  });
});

// ═════════════════════ (K) load ═════════════════════

describe('(K) refusals at load', () => {
  it('K1 two installations sharing an assertion key variable or key value are both refused, by reason code, never logging a key or digest', () => {
    for (const name of ['dup-one', 'dup-two', 'dup-three', 'dup-four']) {
      expect(`${name}: ${loader.getPlugin(name)?.manifest === null}`).toBe(`${name}: true`);
    }
    const shared = loadLines.filter((line) => line.startsWith('[PluginLoader] plugin load failed reason=PLUGIN_ASSERTION_KEY_SHARED'));
    expect(shared).toHaveLength(4);
    const secrets = [keyOf('shared'), keyOf('same-value'), crypto.createHash('sha256').update(keyOf('shared')).digest('hex'),
      crypto.createHash('sha256').update(keyOf('same-value')).digest('hex')];
    for (const line of loadLines) for (const secret of secrets) expect(line.includes(secret)).toBe(false);
    for (const name of [NEWS, ORB, GATED]) expect(loader.getPlugin(name)?.manifest?.name).toBe(name);
  });

  it('K2 an invalid settings schema refuses the plugin at load with its own reason code', async () => {
    expect(loader.getPlugin('bad-schema')?.manifest).toBeNull();
    expect(loadLines.filter((line) => line.startsWith('[PluginLoader] plugin load failed reason=PLUGIN_SETTINGS_SCHEMA_INVALID'))).toHaveLength(1);
    expect((await call(ALICE, 'GET', '/plugin-host/bad-schema/bridge')).text).toBe(NOT_FOUND);
  });

  it('K3 an invalid installation name is refused on its own reason line, and the others still load', () => {
    expect(loadLines.filter((line) => line.startsWith('[PluginLoader] plugin load failed reason=PLUGIN_NAME_INVALID'))).toHaveLength(1);
    expect(loadLines.filter((line) => line.startsWith('[PluginLoader] plugin load failed reason=PLUGIN_NAMESPACE_EMPTY'))).toHaveLength(1);
    expect(loader.getRegistry().map((entry: any) => entry.name).sort()).toEqual([DETAIL, GATED, LEGACY, NEWS, ORB].sort());
  });
});

// ═════════════════════ (D) delivery ═════════════════════

describe('(D) delivery to the frame', () => {
  it('D1 the bridge carries availability and settings, and no deliver: backend key; the user route shows its source only', async () => {
    await reset(NEWS);
    expect((await adminSettings(ADMIN, NEWS, { values: { 'generation-endpoint': 'https://internal.invalid/generate', ratio: 0.2 } })).status).toBe(200);
    const bridge = (await call(ALICE, 'GET', `/plugin-host/${NEWS}/bridge`)).json;
    expect(bridge.availability).toEqual({ state: 'default_on', enabled: true });
    expect(bridge.settings.values).toMatchObject({ ratio: 0.2, language: 'en' });
    expect(bridge.settings.values).not.toHaveProperty('generation-endpoint');
    expect(bridge.settings.sources).not.toHaveProperty('generation-endpoint');
    expect(JSON.stringify(bridge)).not.toContain('internal.invalid');
    const own = (await call(ALICE, 'GET', `/plugin-host/${NEWS}/settings`)).json;
    expect(own.values).not.toHaveProperty('generation-endpoint');
    expect(own.sources['generation-endpoint']).toEqual({ source: 'deployment', locked: false });
    expect(JSON.stringify(own)).not.toContain('internal.invalid');
    expect(JSON.stringify(own)).not.toContain('generator.invalid');
    const admin = (await call(ADMIN, 'GET', `/plugin-admin/${NEWS}/settings`)).json;
    expect(admin.values['generation-endpoint']).toBe('https://internal.invalid/generate');
  });
});

// ═════════════════════ (G) the administrator gate ═════════════════════

describe('(G) the administrator gate', () => {
  it('G1 an admin and an operator session write with a step-up; an editor and an orchestrator session are refused and audited', async () => {
    await reset(ORB);
    expect((await adminPolicy(ADMIN, ORB, { availability: 'available' })).status).toBe(200);
    expect((await adminPolicy(OPERATOR, ORB, { availability: 'default_on' })).status).toBe(200);
    const editor = await adminPolicy(ALICE, ORB, { availability: 'disabled' });
    expect([editor.status, editor.json.code]).toEqual([403, 'PLUGIN_ADMIN_REQUIRES_ADMINISTRATOR']);
    // C5: the role-change act also admits `orchestrator`; plugin administration
    // narrows it to ADMINISTRATOR_ROLES (admin, operator), reads included.
    const orchestrator = await person('orchestrator', 'orchestrator');
    const write = await adminPolicy(orchestrator, ORB, { availability: 'disabled' });
    const read = await call(orchestrator, 'GET', `/plugin-admin/${ORB}/policy`);
    expect([write.status, write.json.code, read.status, read.json.code]).toEqual(
      [403, 'PLUGIN_ADMIN_REQUIRES_ADMINISTRATOR', 403, 'PLUGIN_ADMIN_REQUIRES_ADMINISTRATOR']);
    expect(await storedState(ORB)).toEqual({ state: 'default_on', version: 2 });
    const orchestratorDenied = await pool.query(`SELECT metadata FROM audit_events WHERE action = 'plugin.policy.set' AND outcome = 'denied'
      AND actor_principal_id = $1`, [orchestrator.principalId]);
    expect(orchestratorDenied.rows.map((row: any) => row.metadata.refusal)).toEqual(['PLUGIN_ADMIN_REQUIRES_ADMINISTRATOR']);
    const denied = await pool.query(`SELECT metadata FROM audit_events WHERE action = 'plugin.policy.set' AND outcome = 'denied'
      AND actor_principal_id = $1`, [ALICE.principalId]);
    expect(denied.rows.map((row: any) => row.metadata.refusal)).toContain('PLUGIN_ADMIN_REQUIRES_ADMINISTRATOR');
    await reset(ORB);
  });

  it('G2 a root bearer, an Account bearer and the API key are refused as non-sessions (C11), reads included', async () => {
    // Its own starting state: a G1 that failed mid-way must not redden this test too.
    await reset(ORB);
    const seen: string[] = [];
    for (const who of [ROOT_BEARER, ALICE_BEARER, LEGACY_KEY]) {
      const write = await call(who, 'PUT', `/plugin-admin/${ORB}/policy`, { availability: 'disabled' }, { 'If-Match': '0' });
      const read = await call(who, 'GET', `/plugin-admin/${ORB}/policy`);
      seen.push(`${who.label}: ${write.status} ${write.json?.code} ${read.status} ${read.json?.code}`);
    }
    expect(seen).toEqual(['root-bearer', 'account-bearer', 'legacy'].map((label) =>
      `${label}: 403 PLUGIN_ADMIN_REQUIRES_SESSION 403 PLUGIN_ADMIN_REQUIRES_SESSION`));
    expect(await storedState(ORB)).toEqual({ state: null, version: 0 });
  });

  it('G3 every write burns a single-use step-up bound to (plugin.admin, the name); missing, wrong-target and replayed tokens write nothing', async () => {
    await reset(ORB); await reset(NEWS);
    const put = (body: Record<string, unknown>) => call(ADMIN, 'PUT', `/plugin-admin/${ORB}/policy`, { availability: 'available', ...body }, { 'If-Match': '0' });
    const missing = await put({});
    const wrongTarget = await put({ stepUpToken: await stepUp(ADMIN.principalId, NEWS) });
    const wrongAction = await put({ stepUpToken: (await stepUpService.mint(ADMIN.principalId, 'approval.decide', ORB, 'password')).token });
    const someoneElse = await put({ stepUpToken: await stepUp(OPERATOR.principalId, ORB) });
    expect([missing, wrongTarget, wrongAction, someoneElse].map((answer) => `${answer.status} ${answer.json.code} ${answer.json.stepUp?.action}`))
      .toEqual(Array(4).fill('403 STEP_UP_REQUIRED plugin.admin'));
    expect(await storedState(ORB)).toEqual({ state: null, version: 0 });
    const token = await stepUp(ADMIN.principalId, ORB);
    expect((await put({ stepUpToken: token })).status).toBe(200);
    expect(await tokenConsumed(token)).toBe(true);
    const replay = await call(ADMIN, 'PUT', `/plugin-admin/${ORB}/policy`, { availability: 'disabled', stepUpToken: token }, { 'If-Match': '1' });
    expect([replay.status, replay.json.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    const cleanup = await call(ADMIN, 'POST', `/plugin-admin/${NEWS}/settings/cleanup`, {});
    expect([cleanup.status, cleanup.json.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    const settings = await call(ADMIN, 'PUT', `/plugin-admin/${NEWS}/settings`, { values: { ratio: 0.1 } }, { 'If-Match': '0' });
    expect([settings.status, settings.json.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    expect([(await storedState(ORB)).state, await storedValues(NEWS, null)]).toEqual(['available', null]);
    await reset(ORB);
  });

  it('G4 administrator reads need the session check only', async () => {
    const list = await call(OPERATOR, 'GET', '/plugin-admin');
    expect(list.status).toBe(200);
    expect(list.json.plugins.map((entry: any) => entry.name)).toEqual([DETAIL, GATED, NEWS, ORB].sort());
    expect((await call(ADMIN, 'GET', `/plugin-admin/${NEWS}/settings`)).status).toBe(200);
    expect((await call(ADMIN, 'GET', `/plugin-admin/${ORB}/policy`)).json).toEqual({ name: ORB, availability: 'default_on', revision: 0 });
    expect((await call(ALICE, 'GET', '/plugin-admin')).json.code).toBe('PLUGIN_ADMIN_REQUIRES_ADMINISTRATOR');
    expect((await call(ADMIN, 'GET', `/plugin-admin/unknown-${tag()}/settings`)).text).toBe(NOT_FOUND);
  });
});

// ═════════════════════ (U) the Account's own gate ═════════════════════

describe('(U) the Account\'s own session gate', () => {
  it('U1 the Account\'s own writes need its own login session: a bearer and a delegated Connector are refused SESSION_ONLY', async () => {
    await reset(ORB); await reset(NEWS);
    const seen: string[] = [];
    for (const who of [ALICE_BEARER, ALICE_CONNECTOR, LEGACY_KEY]) {
      const choice = await call(who, 'PUT', `/plugin-host/${ORB}/choice`, { enabled: false }, { 'If-Match': '0' });
      const values = await call(who, 'PUT', `/plugin-host/${NEWS}/settings/account`, { values: { notes: 'x' } }, { 'If-Match': '0' });
      seen.push(`${who.label}: ${choice.status} ${choice.json?.code} ${values.status} ${values.json?.code}`);
    }
    expect(seen).toEqual(['account-bearer', 'connector', 'legacy'].map((label) => `${label}: 403 SESSION_ONLY 403 SESSION_ONLY`));
    expect([await storedChoice(ORB, ALICE.principalId), await storedValues(NEWS, ALICE.principalId)]).toEqual([null, null]);
    expect((await ownChoice(ALICE, ORB, false)).status).toBe(200);
    await reset(ORB);
  });

  it('U2 every caller of the Account holding services:read reads the Account\'s own settings and choices', async () => {
    await reset(NEWS);
    expect((await ownValues(ALICE, NEWS, { notes: 'mine' })).status).toBe(200);
    for (const who of [ALICE, ALICE_BEARER, ALICE_CONNECTOR]) {
      const view = await call(who, 'GET', `/plugin-host/${NEWS}/settings`);
      expect(`${who.label} ${view.status} ${view.json?.values?.notes}`).toBe(`${who.label} 200 mine`);
      expect((await choiceNames(who))).toContain(NEWS);
    }
  });
});

// ═════════════════════ (X) isolation ═════════════════════

describe('(X) isolation', () => {
  it('X1 one Account never reads or writes another\'s values or choices; no parameter names an Account (outside-anchor read)', async () => {
    await reset(NEWS); await reset(ORB);
    await setState(ORB, 'available');
    expect((await ownValues(ALICE, NEWS, { notes: 'alice private', language: 'de' })).status).toBe(200);
    expect((await ownChoice(ALICE, ORB, true)).status).toBe(200);
    const bob = await call(BOB, 'GET', `/plugin-host/${NEWS}/settings?account=${ALICE.principalId}&accountId=${ALICE.principalId}`);
    expect({ notes: bob.json.values.notes, language: bob.json.values.language, revision: bob.json.revision })
      .toEqual({ notes: null, language: 'en', revision: 0 });
    expect(JSON.stringify(bob.json)).not.toContain('alice private');
    expect((await call(BOB, 'GET', `/plugin-host/${ORB}/bridge?account=${ALICE.principalId}`)).status).toBe(404);
    expect((await call(BOB, 'PUT', `/plugin-host/${NEWS}/settings/account?account=${ALICE.principalId}`, { values: { notes: 'bob' } }, { 'If-Match': '0' })).status).toBe(200);
    // The outside anchor: the stored rows, read directly.
    expect((await storedValues(NEWS, ALICE.principalId))!.values).toEqual({ notes: 'alice private', language: 'de' });
    expect((await storedValues(NEWS, BOB.principalId))!.values).toEqual({ notes: 'bob' });
    expect(await storedChoice(ORB, BOB.principalId)).toBeNull();
    expect((await call(ALICE, 'GET', `/plugin-host/${NEWS}/settings`)).json.values.notes).toBe('alice private');
    await reset(ORB);
  });
});

// ═════════════════════ (CL) clean-up ═════════════════════

describe('(CL) the explicit clean-up', () => {
  it('CL1 removes every stored value and lock the current schema no longer accepts, from every row, and nothing else', async () => {
    await reset(NEWS);
    await pool.query(`INSERT INTO plugin_settings (plugin_name, layer, settings_values, locked_keys) VALUES ($1, 'deployment', $2::jsonb, $3)`,
      [NEWS, JSON.stringify({ ratio: 0.3, retired: 'x', topics: ['tech'] }), ['language', 'ratio']]);
    await pool.query(`INSERT INTO plugin_settings (plugin_name, layer, account_principal_id, settings_values) VALUES ($1, 'account', $2, $3::jsonb)`,
      [NEWS, ALICE.principalId, JSON.stringify({ language: 'fr', notes: 'kept' })]);
    await pool.query(`INSERT INTO plugin_settings (plugin_name, layer, account_principal_id, settings_values) VALUES ($1, 'account', $2, $3::jsonb)`,
      [NEWS, BOB.principalId, JSON.stringify({ notes: 'fine' })]);
    expect((await call(ADMIN, 'GET', `/plugin-admin/${NEWS}/settings`)).json.stale).toEqual({ keys: ['retired', 'topics'], lockedKeys: ['ratio'], accountRows: 1 });
    const cleaned = await call(ADMIN, 'POST', `/plugin-admin/${NEWS}/settings/cleanup`, { stepUpToken: await stepUp(ADMIN.principalId, NEWS) });
    expect({ status: cleaned.status, rows: cleaned.json.rowsChanged, keys: cleaned.json.keysRemoved })
      .toEqual({ status: 200, rows: 2, keys: ['language', 'ratio', 'retired', 'topics'] });
    expect(await storedValues(NEWS, null)).toEqual({ values: { ratio: 0.3 }, locked: ['language'], version: 2 });
    expect(await storedValues(NEWS, ALICE.principalId)).toEqual({ values: { notes: 'kept' }, locked: [], version: 2 });
    expect(await storedValues(NEWS, BOB.principalId)).toEqual({ values: { notes: 'fine' }, locked: [], version: 1 });
  });
});

// ═════════════════════ (AU) audit, (P) MCP ═════════════════════

describe('(AU) audit and (P) MCP', () => {
  it('AU1 every plugin change is audited with actor, Account, plugin, keys and revision, and never a value', async () => {
    await reset(NEWS);
    expect((await ownValues(ALICE, NEWS, { notes: MARKER, 'token-sort': `${MARKER}-sort` })).status).toBe(200);
    expect((await adminSettings(ADMIN, NEWS, { values: { 'generation-endpoint': `https://${MARKER}.invalid/x` } })).status).toBe(200);
    const rows = (await pool.query(
      `SELECT action, outcome, actor_principal_id, resource_type, resource_id, metadata FROM audit_events
        WHERE resource_type = 'plugin' ORDER BY occurred_at, id`)).rows;
    expect(rows.length).toBeGreaterThan(10);
    for (const row of rows) expect(JSON.stringify(row).includes(MARKER)).toBe(false);
    const own = rows.filter((row: any) => row.action === 'plugin.settings.account.set' && row.outcome === 'success').pop();
    expect(own).toMatchObject({ actor_principal_id: ALICE.principalId, resource_id: NEWS,
      metadata: { account: ALICE.principalId, keys: ['notes', 'token-sort'], revision: 1 } });
    const shared = rows.filter((row: any) => row.action === 'plugin.settings.deployment.set' && row.outcome === 'success').pop();
    expect(shared).toMatchObject({ actor_principal_id: ADMIN.principalId, resource_id: NEWS,
      metadata: { keys: ['generation-endpoint'], revision: 1 } });
    expect(typeof shared.metadata.stepUpTokenId).toBe('string');
    expect(new Set(rows.map((row: any) => row.action))).toEqual(new Set([
      'plugin.choice.set', 'plugin.settings.account.set', 'plugin.policy.set', 'plugin.settings.deployment.set',
      'plugin.settings.cleanup', 'plugin.admin.read']));
  });

  it('P1 no MCP tool reaches plugin availability or settings in stage 1 (C9)', () => {
    const names: string[] = MCP_TOOLS.map((tool: any) => tool.name);
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((name) => /plugin/.test(name))).toEqual([]);
    const described = MCP_TOOLS.map((tool: any) => JSON.stringify(tool)).join('\n');
    expect(described).not.toMatch(/plugin-host|plugin-admin/);
  });
});
