/**
 * Card 08792425 (member N6, the core half of two-way registration; the
 * default-store design's choice C7) over a REAL PostgreSQL, the PRODUCTION
 * routers and the MCP ingress.
 *
 * It measures, on stored rows:
 *
 *   (M) migration 168: it re-applies cleanly (in a rolled-back transaction) and
 *       its CHECKs and foreign key are pinned BY NAME.
 *   (G) the gate: a root bearer, an Account bearer and the legacy API key are
 *       refused as non-sessions and a non-administrator session is refused, each
 *       audited as denied with nothing written; no MCP tool reaches the family.
 *   (S) the step-up is bound to the ACTION and the FINGERPRINT: none, another
 *       action's, another fingerprint's, another Account's and a spent token are
 *       each refused, nothing written, and a refused act spends no step-up.
 *   (B) invalid bundles and an unconfirmed fingerprint are refused by name,
 *       audited, before any step-up is spent.
 *   (A) the act: one transaction creates and publishes the Service with the v2
 *       descriptor, records the endpoints, the allowed networks and the
 *       credential reference NAME, records the fingerprint as confirmed, and
 *       writes ONE audit row carrying it; the step-up is spent.
 *   (D) duplicates by name: the same endpoint, the same fingerprint, the same
 *       slug; nothing written, no step-up spent, each audited.
 *   (K) the derived channel-credential reference must be FREE: a name that
 *       resolves now, any entry of RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS that is
 *       the same name after case, Unicode, invisible-character, whitespace and
 *       separator folding, and the reference any Service row records (draft,
 *       published or retired), each refused REGISTRATION_CREDENTIAL_REFERENCE_TAKEN
 *       with its reason, audited, nothing written and no step-up spent; and a
 *       Service deleted while its bearer stays placed cannot hand that bearer
 *       to a new endpoint under its old slug.
 *   (R) the return bundle: the audience, the issuer, the public assertion keys
 *       and the lifecycle key once the exporter signs for the Service; no
 *       secret, ever.
 *   (L) create -> return bundle -> grants through the existing approval flow ->
 *       the dial REFUSED (unavailable:transport, nothing sent) until the
 *       credential reference resolves; then, with the reference resolved, the
 *       core dials through its DEFAULT trust store and refuses the installer's
 *       self-signed certificate although its fingerprint was confirmed (D7(a):
 *       no installer CA, no dial-time pinning); and with the existing test-only
 *       trust seam the source answers, verifying the assertion with the keys
 *       and audience the return bundle carried.
 *
 * DESTRUCTIVE: writes principals, services, registrations, grants, approvals,
 * step-up tokens and audit rows. It refuses any deployment database and any
 * non-local host, and FAILS — never skips — without a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { replayInRolledBackTransaction } from './support/migrationReplay';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: knowledge source registration is measured on stored service, '
    + 'registration, step-up and audit rows, so this suite never skips. Load database/init.sql into a disposable '
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
  throw new Error('The knowledge source registration suite refuses a non-disposable database target');
}

Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: TEST_DB_NAME,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
});
process.env.RELAYHALL_API_KEY = process.env.RELAYHALL_API_KEY || `registration-suite-${crypto.randomBytes(16).toString('hex')}`;
const ASSERTION_KEY = crypto.generateKeyPairSync('ed25519').privateKey;
process.env.RELAYHALL_KNOWLEDGE_ASSERTION_KEYS = JSON.stringify({
  'reg-run': (ASSERTION_KEY.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64'),
});
process.env.RELAYHALL_KNOWLEDGE_ASSERTION_ACTIVE_KEY = 'reg-run';
process.env.RELAYHALL_KNOWLEDGE_HANDLE_KEYS = JSON.stringify({ 'reg-handle': crypto.randomBytes(32).toString('base64') });
process.env.RELAYHALL_KNOWLEDGE_HANDLE_ACTIVE_KEY = 'reg-handle';
process.env.RELAYHALL_TELEMETRY_PEPPERS = process.env.RELAYHALL_TELEMETRY_PEPPERS
  || JSON.stringify({ testpepper: Buffer.alloc(32, 29).toString('base64') });
process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER = process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER || 'testpepper';
delete process.env.RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS;

const express = require('express');
const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { stepUpService } = require('../services/StepUpService');
const { principalService } = require('../services/PrincipalService');
const { recordLifecyclePublicKey } = require('../services/KnowledgeLifecycleExporter');
const { serviceRegistry } = require('../services/ServiceRegistry');
const dialClient = require('../services/KnowledgeDialClient');
const { MCP_TOOLS } = require('../mcp/registry');
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');
const { KnowledgeSearchStubSource } = require('./support/knowledgeSearchStubSource');

jest.setTimeout(240_000);

const MIGRATION_FILE = path.join(__dirname, '..', 'migrations', '168_knowledge_source_registrations.sql');
const ACTION = 'knowledge.source.register';
const BASE = '/knowledge-source-registrations';

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

interface Caller { label: string; principalId: string; headers: Record<string, string>; token?: string }
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

function firstExternalIpv4(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

async function makeAccount(role: string | null, label: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role) VALUES ('human', $1, $2, 'active', $3) RETURNING id`,
    [`ksr-${label}-${tag()}`, `KSR ${label}`, role]);
  return String(result.rows[0].id);
}

async function sessionFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

async function connectorOf(accountId: string, scopes: string[]): Promise<Caller> {
  const created = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, $1, 'active', $2, 'registration drill connector', $3::jsonb) RETURNING id`,
    [`ksr-connector-${tag()}`, accountId, JSON.stringify({ scopes: 'parent', objects: 'parent' })]);
  const id = String(created.rows[0].id);
  const issued = await principalService.issueCredential({ principalId: id, scopes, label: `ksr-${tag()}`, transport: 'any' });
  return { label: 'connector', principalId: id, headers: { Authorization: `Bearer ${issued.fullKey}` }, token: issued.fullKey };
}

/** A principal_api_key bearer HOLDING root (minted narrow, widened in raw SQL), as the build-1 drill builds one. */
async function rootBearerFor(accountId: string): Promise<Caller> {
  const created = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role, parent_principal_id)
     VALUES ('service', $1, $1, 'active', 'user', $2) RETURNING id`, [`ksr-bearer-${tag()}`, accountId]);
  const bearerId = String(created.rows[0].id);
  const issued = await principalService.issueCredential({ principalId: bearerId, scopes: ['principals:read'], label: 'ksr', transport: 'api' });
  await pool.query('UPDATE principals SET parent_principal_id = NULL WHERE id = $1', [bearerId]);
  await pool.query('UPDATE principal_credentials SET scopes = $2::jsonb WHERE id = $1', [issued.credentialId, JSON.stringify(['root'])]);
  principalService.invalidatePrincipals([bearerId]);
  return { label: 'root-bearer', principalId: bearerId, headers: { Authorization: `Bearer ${issued.fullKey}` }, token: issued.fullKey };
}

const fingerprintOf = (): string => crypto.randomBytes(32).toString('hex');
const display = (sha: string): string => (sha.toUpperCase().match(/.{2}/g) ?? []).join(':');
const DESCRIPTOR_V2 = {
  options: [],
  knowledgeSource: {
    classes: [{ key: 'notes', content: 'docs' }], compartments: [], protocol_version: 2,
    compartment_mode: 'dynamic-opaque', categories: ['relaybrain:note'],
  },
};

function bundleFor(input: { name?: string; slug?: string; endpoint: string; getEndpoint?: string; fingerprint: string; descriptor?: unknown }) {
  return {
    schema: 'rh.knowledge-source.registration/1',
    name: input.name ?? `Knowledge ${tag()}`,
    ...(input.slug ? { slug: input.slug } : {}),
    endpoint: input.endpoint,
    ...(input.getEndpoint ? { getEndpoint: input.getEndpoint } : {}),
    descriptor: input.descriptor ?? DESCRIPTOR_V2,
    certificateSha256: input.fingerprint,
  };
}

async function stepUp(principalId: string, targetId: string, action = ACTION): Promise<{ token: string; tokenId: string }> {
  return stepUpService.mint(principalId, action, targetId, 'password');
}

async function tokenConsumed(tokenId: string): Promise<boolean> {
  const row = await pool.query('SELECT consumed_at FROM step_up_tokens WHERE id = $1', [tokenId]);
  return row.rows[0]?.consumed_at != null;
}

async function serviceCount(): Promise<number> {
  return Number((await pool.query('SELECT count(*)::int AS n FROM services')).rows[0].n);
}

async function registrationCount(): Promise<number> {
  return Number((await pool.query('SELECT count(*)::int AS n FROM knowledge_source_registrations')).rows[0].n);
}

const CREDENTIALS_ENV = 'RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS';

async function deniedAudits(fingerprint: string | null, refusal: string): Promise<any[]> {
  const rows = await pool.query(
    `SELECT actor_principal_id, auth_method, resource_id, metadata FROM audit_events
      WHERE action = $1 AND outcome = 'denied' AND resource_type = 'knowledge_source_registration'
        AND resource_id IS NOT DISTINCT FROM $2 AND metadata->>'refusal' = $3`, [ACTION, fingerprint, refusal]);
  return rows.rows;
}

async function probe(sql: string, params: unknown[] = []): Promise<{ admitted: boolean; message: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(sql, params);
      return { admitted: true, message: '' };
    } catch (error: any) {
      return { admitted: false, message: String(error?.message ?? error) };
    }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

const STUB = new KnowledgeSearchStubSource('ksr-search-stub');
/** Every TLS handshake the stub saw fail: proof the core DIALED, and that the handshake did not pass. */
let tlsRefusals = 0;
/** When true, the existing TEST-ONLY trust seam hands the stub's anchor to the dial; when false, the production default store decides. */
let anchorSeam = false;

let ADMIN: Caller;
let ADMIN_TWO: Caller;
let EDITOR: Caller;
let OPERATOR: Caller;
let ROOT_BEARER: Caller;
let ACCOUNT_BEARER: Caller;
const API_KEY: Caller = { label: 'api-key', principalId: '', headers: { 'x-api-key': process.env.RELAYHALL_API_KEY as string } };

beforeAll(async () => {
  const probeDb = await pool.query('SELECT current_database() AS db');
  expect(String(probeDb.rows[0].db)).toBe(TEST_DB_NAME);

  const address = firstExternalIpv4();
  expect(address).not.toBeNull();
  await STUB.start(address as string);
  (STUB as any).server.on('tlsClientError', () => { tlsRefusals += 1; });
  const realDial = dialClient.dialKnowledgeSource;
  jest.spyOn(dialClient, 'dialKnowledgeSource').mockImplementation(async (options: any) =>
    realDial(anchorSeam ? { ...options, trustAnchors: [STUB.certificate.cert] } : options));

  await new Promise<void>((resolve) => { server = buildApp().listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  ADMIN = await sessionFor('admin', await makeAccount('admin', 'admin'));
  ADMIN_TWO = await sessionFor('admin-two', await makeAccount('admin', 'admin-two'));
  EDITOR = await sessionFor('editor', await makeAccount('editor', 'editor'));
  OPERATOR = await sessionFor('operator', await makeAccount('operator', 'operator'));
  ROOT_BEARER = await rootBearerFor(ADMIN.principalId);
  ACCOUNT_BEARER = await connectorOf(ADMIN.principalId, ['services:write', 'services:read']);
});

afterAll(async () => {
  jest.restoreAllMocks();
  delete process.env.RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS;
  await STUB.stop();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ═══════════ (M) migration 168 ═══════════

describe('(M) migration 168', () => {
  it('re-applies cleanly and changes nothing, in a rolled-back transaction', async () => {
    const sql = fs.readFileSync(MIGRATION_FILE, 'utf8');
    await replayInRolledBackTransaction(pool, 'the replay of migration 168', async (client) => {
      await client.query(sql);
      await client.query(sql);
    });
    const columns = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'knowledge_source_registrations' ORDER BY column_name`);
    expect(columns.rows.map((row: any) => row.column_name)).toEqual([
      'bundle_sha256', 'certificate_sha256', 'confirmed_at', 'confirmed_by', 'fingerprint_confirmation', 'service_id', 'step_up_token_id',
    ]);
  });

  it('pins its CHECKs by name and cascades with the Service', async () => {
    const service = await pool.query(
      `INSERT INTO services (slug, name, description, kind) VALUES ($1, 'm', '', 'service') RETURNING id`, [`ksr-m-${tag()}`]);
    const id = String(service.rows[0].id);
    const insert = (fingerprint: string, confirmation: string, bundle: string) => probe(
      `INSERT INTO knowledge_source_registrations (service_id, certificate_sha256, fingerprint_confirmation, confirmed_by, bundle_sha256, step_up_token_id)
       VALUES ($1, $2, $3, $4, $5, gen_random_uuid())`, [id, fingerprint, confirmation, ADMIN.principalId, bundle]);
    expect(await insert(fingerprintOf(), 'checked', fingerprintOf())).toEqual({ admitted: true, message: '' });
    expect((await insert('AB'.repeat(32), 'checked', fingerprintOf())).message).toContain('knowledge_source_registrations_fingerprint');
    expect((await insert(fingerprintOf(), 'waved', fingerprintOf())).message).toContain('knowledge_source_registrations_confirmation');
    expect((await insert(fingerprintOf(), 'typed', 'nope')).message).toContain('knowledge_source_registrations_bundle');
    await pool.query(
      `INSERT INTO knowledge_source_registrations (service_id, certificate_sha256, fingerprint_confirmation, confirmed_by, bundle_sha256, step_up_token_id)
       VALUES ($1, $2, 'typed', $3, $4, gen_random_uuid())`, [id, fingerprintOf(), ADMIN.principalId, fingerprintOf()]);
    await pool.query('DELETE FROM services WHERE id = $1', [id]);
    expect((await pool.query('SELECT 1 FROM knowledge_source_registrations WHERE service_id = $1', [id])).rows).toEqual([]);
  });
});

// ═══════════ (G) the gate ═══════════

describe('(G) the gate refuses every bearer and every non-administrator, audited, nothing written', () => {
  it.each([
    ['a root bearer', () => ROOT_BEARER, 'KNOWLEDGE_SOURCE_REGISTER_REQUIRES_SESSION'],
    ['an Account bearer', () => ACCOUNT_BEARER, 'KNOWLEDGE_SOURCE_REGISTER_REQUIRES_SESSION'],
    ['the legacy API key', () => API_KEY, 'KNOWLEDGE_SOURCE_REGISTER_REQUIRES_SESSION'],
    ['an editor session', () => EDITOR, 'KNOWLEDGE_SOURCE_REGISTER_REQUIRES_ADMINISTRATOR'],
  ])('%s is refused on the act and on every read', async (_label, who, code) => {
    const fingerprint = fingerprintOf();
    const token = await stepUp(ADMIN.principalId, fingerprint);
    const before = { services: await serviceCount(), registrations: await registrationCount() };
    const answer = await call(who(), 'POST', BASE, {
      bundle: bundleFor({ endpoint: STUB.url(`/g-${tag()}/search`), fingerprint }), confirmedFingerprint: fingerprint,
      confirmation: 'checked', allowedNetworks: [`${STUB.host}/32`], stepUpToken: token.token,
    });
    expect({ status: answer.status, code: answer.json?.code }).toEqual({ status: 403, code });
    expect({ services: await serviceCount(), registrations: await registrationCount() }).toEqual(before);
    expect(await tokenConsumed(token.tokenId)).toBe(false);
    expect(await deniedAudits(fingerprint, code)).toHaveLength(1);
    for (const read of [BASE, `${BASE}/${crypto.randomUUID()}`, `${BASE}/${crypto.randomUUID()}/return-bundle`]) {
      const refused = await call(who(), 'GET', read);
      expect({ read, status: refused.status, code: refused.json?.code }).toEqual({ read, status: 403, code });
    }
  });

  it('no MCP tool reaches the family, and a bearer through the MCP ingress meets the same refusal', async () => {
    for (const tool of MCP_TOOLS) expect(JSON.stringify({ name: tool.name, description: tool.description })).not.toMatch(/registration bundle|knowledge-source-registrations/);
    const listed = await fetch(`${origin}${MCP_ROUTE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${ROOT_BEARER.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const names: string[] = (JSON.parse(await listed.text())?.result?.tools ?? []).map((tool: any) => String(tool.name));
    expect(names.filter((name) => /regist/.test(name))).toEqual([]);
  });
});

// ═══════════ (S) the step-up binding ═══════════

describe('(S) the step-up is bound to the action and the fingerprint', () => {
  const attempt = async (fingerprint: string, stepUpToken: unknown, who: Caller = ADMIN) => call(who, 'POST', BASE, {
    bundle: bundleFor({ endpoint: STUB.url(`/s-${tag()}/search`), fingerprint }), confirmedFingerprint: display(fingerprint),
    confirmation: 'typed', allowedNetworks: [`${STUB.host}/32`], ...(stepUpToken === undefined ? {} : { stepUpToken }),
  });

  it('refuses a missing token with the challenge naming the action and the fingerprint', async () => {
    const fingerprint = fingerprintOf();
    const before = await serviceCount();
    const answer = await attempt(fingerprint, undefined);
    expect(answer.status).toBe(403);
    expect(answer.json).toMatchObject({ code: 'STEP_UP_REQUIRED', stepUp: { error: 'insufficient_user_authentication', action: ACTION, targetId: fingerprint, max_age: 0 } });
    expect(await serviceCount()).toBe(before);
    expect(await deniedAudits(fingerprint, 'STEP_UP_REQUIRED')).toHaveLength(1);
  });

  it.each([
    ['another action', async (fingerprint: string) => stepUp(ADMIN.principalId, fingerprint, 'plugin.admin')],
    ['another fingerprint', async () => stepUp(ADMIN.principalId, fingerprintOf())],
    ["another Account's", async (fingerprint: string) => stepUp(ADMIN_TWO.principalId, fingerprint)],
  ])('refuses a token bound to %s and spends nothing', async (_label, mint) => {
    const fingerprint = fingerprintOf();
    const token = await mint(fingerprint);
    const before = { services: await serviceCount(), registrations: await registrationCount() };
    const answer = await attempt(fingerprint, token.token);
    expect({ status: answer.status, code: answer.json?.code }).toEqual({ status: 403, code: 'STEP_UP_REQUIRED' });
    expect({ services: await serviceCount(), registrations: await registrationCount() }).toEqual(before);
    expect(await tokenConsumed(token.tokenId)).toBe(false);
  });

  it('refuses a spent token on replay', async () => {
    const fingerprint = fingerprintOf();
    const token = await stepUp(ADMIN.principalId, fingerprint);
    const first = await attempt(fingerprint, token.token);
    expect(first.status).toBe(201);
    expect(await tokenConsumed(token.tokenId)).toBe(true);
    // The same fingerprint at a new endpoint: the spent token is refused FIRST,
    // before the duplicate fingerprint is even looked at.
    const before = await serviceCount();
    const second = await call(ADMIN, 'POST', BASE, {
      bundle: bundleFor({ endpoint: STUB.url(`/s2-${tag()}/search`), fingerprint }),
      confirmedFingerprint: fingerprint, confirmation: 'checked', allowedNetworks: [`${STUB.host}/32`], stepUpToken: token.token,
    });
    expect({ status: second.status, code: second.json?.code }).toEqual({ status: 403, code: 'STEP_UP_REQUIRED' });
    expect(await serviceCount()).toBe(before);
  });
});

// ═══════════ (B) invalid bundles and the confirmation ═══════════

describe('(B) an invalid bundle or an unconfirmed fingerprint is refused by name before any step-up is spent', () => {
  it.each([
    ['a v1 descriptor', (fp: string) => ({ bundle: bundleFor({ endpoint: STUB.url('/b1/search'), fingerprint: fp, descriptor: { options: [], knowledgeSource: { classes: [{ key: 'n', content: 'docs' }], compartments: ['corpus'] } } }), confirmedFingerprint: fp, confirmation: 'checked', allowedNetworks: [`${STUB.host}/32`] }), 422, 'REGISTRATION_DESCRIPTOR_NOT_V2'],
    ['another schema', (fp: string) => ({ bundle: { ...bundleFor({ endpoint: STUB.url('/b2/search'), fingerprint: fp }), schema: 'rh.other/1' }, confirmedFingerprint: fp, confirmation: 'checked' }), 422, 'REGISTRATION_BUNDLE_SCHEMA_UNSUPPORTED'],
    ['a private endpoint outside the allowed networks', (fp: string) => ({ bundle: bundleFor({ endpoint: STUB.url('/b3/search'), fingerprint: fp }), confirmedFingerprint: fp, confirmation: 'checked' }), 422, 'KNOWLEDGE_ENDPOINT_ADDRESS_REFUSED'],
    ['a fingerprint that does not match', (fp: string) => ({ bundle: bundleFor({ endpoint: STUB.url('/b4/search'), fingerprint: fp }), confirmedFingerprint: fingerprintOf(), confirmation: 'checked', allowedNetworks: [`${STUB.host}/32`] }), 422, 'REGISTRATION_FINGERPRINT_NOT_CONFIRMED'],
    ['no confirmation method', (fp: string) => ({ bundle: bundleFor({ endpoint: STUB.url('/b5/search'), fingerprint: fp }), confirmedFingerprint: fp, allowedNetworks: [`${STUB.host}/32`] }), 422, 'REGISTRATION_CONFIRMATION_INVALID'],
    ['an unknown field', (fp: string) => ({ bundle: bundleFor({ endpoint: STUB.url('/b6/search'), fingerprint: fp }), confirmedFingerprint: fp, confirmation: 'checked', bearer: 'x' }), 400, 'UNKNOWN_FIELD'],
  ])('%s', async (_label, body, status, code) => {
    const fingerprint = fingerprintOf();
    const token = await stepUp(ADMIN.principalId, fingerprint);
    const before = { services: await serviceCount(), registrations: await registrationCount() };
    const answer = await call(ADMIN, 'POST', BASE, { ...body(fingerprint), stepUpToken: token.token });
    expect({ status: answer.status, code: answer.json?.code }).toEqual({ status, code });
    expect({ services: await serviceCount(), registrations: await registrationCount() }).toEqual(before);
    expect(await tokenConsumed(token.tokenId)).toBe(false);
    expect(await deniedAudits(fingerprint, code)).toHaveLength(1);
  });
});

// ═══════════ (A) (D) (R) (L) the act, the duplicates, the return bundle and the dial ═══════════

describe('(A) to (L): one registration, end to end', () => {
  const SLUG = `ksr-live-${tag()}`;
  const FINGERPRINT = fingerprintOf();
  let endpoint: string;
  let getEndpoint: string;
  let serviceId: string;
  let tokenId: string;
  let returnBundle: any;
  let readerConnector: Caller;

  beforeAll(() => {
    endpoint = STUB.url(`/${SLUG}/search`);
    getEndpoint = STUB.url(`/${SLUG}/get`);
  });

  it('(A) an administrator session registers the source in one act with one audit row', async () => {
    const token = await stepUp(ADMIN.principalId, FINGERPRINT);
    tokenId = token.tokenId;
    const answer = await call(ADMIN, 'POST', BASE, {
      bundle: JSON.stringify(bundleFor({ name: 'Live knowledge', slug: SLUG, endpoint, getEndpoint, fingerprint: FINGERPRINT })),
      confirmedFingerprint: display(FINGERPRINT), confirmation: 'checked', allowedNetworks: [`${STUB.host}/32`], stepUpToken: token.token,
    });
    expect(answer.status).toBe(201);
    serviceId = answer.json.registration.service.id;
    returnBundle = answer.json.returnBundle;
    expect(answer.json.registration).toMatchObject({
      service: { slug: SLUG, name: 'Live knowledge', status: 'published', currentDescriptorVersion: 1 },
      endpoints: { query: endpoint, get: getEndpoint, write: null, allowedNetworks: [`${STUB.host}/32`] },
      fingerprint: { sha256: FINGERPRINT, confirmation: 'checked', confirmedBy: ADMIN.principalId },
      channel: { credentialReference: `knowledge-source/${SLUG}`, resolves: false, dial: 'refused', refusal: 'unavailable:transport' },
      lifecycleExport: { configured: false, keyRecorded: false },
    });
    expect(await tokenConsumed(tokenId)).toBe(true);

    const row = (await pool.query('SELECT * FROM services WHERE id = $1', [serviceId])).rows[0];
    expect({
      status: row.status, query: row.knowledge_query_endpoint, get: row.knowledge_get_endpoint, ref: row.knowledge_core_credential_ref,
      networks: row.knowledge_allowed_networks, claims: row.knowledge_claims_mode, subject: row.knowledge_subject_mode, version: row.current_descriptor_version,
    }).toEqual({
      status: 'published', query: endpoint, get: getEndpoint, ref: `knowledge-source/${SLUG}`, networks: [`${STUB.host}/32`],
      claims: 'asserted', subject: 'pairwise', version: 1,
    });
    const descriptor = (await pool.query('SELECT descriptor FROM service_descriptor_versions WHERE service_id = $1 AND version = 1', [serviceId])).rows[0].descriptor;
    expect(descriptor.knowledgeSource).toMatchObject({ protocol_version: 2, compartment_mode: 'dynamic-opaque' });
    const registration = (await pool.query('SELECT * FROM knowledge_source_registrations WHERE service_id = $1', [serviceId])).rows[0];
    expect({ fp: registration.certificate_sha256, how: registration.fingerprint_confirmation, by: registration.confirmed_by, token: registration.step_up_token_id })
      .toEqual({ fp: FINGERPRINT, how: 'checked', by: ADMIN.principalId, token: tokenId });

    const audits = await pool.query(
      `SELECT actor_principal_id, auth_method, metadata FROM audit_events
        WHERE action = $1 AND outcome = 'success' AND resource_type = 'service' AND resource_id = $2`, [ACTION, serviceId]);
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]).toMatchObject({
      actor_principal_id: ADMIN.principalId, auth_method: 'session',
      metadata: { certificateSha256: FINGERPRINT, fingerprintConfirmation: 'checked', credentialReference: `knowledge-source/${SLUG}`, stepUpTokenId: tokenId, stepUpMethod: 'password' },
    });
  });

  it('(D) duplicates are refused by name: the endpoint, the fingerprint and the slug; nothing written, nothing spent', async () => {
    // A slug held by a Service that records no credential reference meets the
    // registry's own slug check; the registered source's own slug meets the
    // taken reference first, because that Service records knowledge-source/<slug>.
    const plainSlug = `ksr-plain-${tag()}`;
    await pool.query(`INSERT INTO services (slug, name, description, kind) VALUES ($1, 'plain', '', 'service')`, [plainSlug]);
    const cases: Array<[Record<string, unknown>, string, number, string]> = [
      [bundleFor({ endpoint, fingerprint: fingerprintOf() }), 'REGISTRATION_ENDPOINT_TAKEN', 409, 'endpoint'],
      [bundleFor({ endpoint: STUB.url(`/other-${tag()}/search`), fingerprint: FINGERPRINT }), 'REGISTRATION_FINGERPRINT_TAKEN', 409, 'fingerprint'],
      [bundleFor({ slug: plainSlug, endpoint: STUB.url(`/other-${tag()}/search`), fingerprint: fingerprintOf() }), 'SERVICE_SLUG_TAKEN', 409, 'slug'],
      [bundleFor({ slug: SLUG, endpoint: STUB.url(`/other-${tag()}/search`), fingerprint: fingerprintOf() }), 'REGISTRATION_CREDENTIAL_REFERENCE_TAKEN', 409, 'slug'],
    ];
    for (const [bundle, code, status] of cases) {
      const fingerprint = String(bundle.certificateSha256);
      const token = await stepUp(ADMIN.principalId, fingerprint);
      const before = { services: await serviceCount(), registrations: await registrationCount() };
      const answer = await call(ADMIN, 'POST', BASE, {
        bundle, confirmedFingerprint: fingerprint, confirmation: 'checked', allowedNetworks: [`${STUB.host}/32`], stepUpToken: token.token,
      });
      expect({ code, got: answer.json?.code, status: answer.status }).toEqual({ code, got: code, status });
      expect({ services: await serviceCount(), registrations: await registrationCount() }).toEqual(before);
      expect({ code, consumed: await tokenConsumed(token.tokenId) }).toEqual({ code, consumed: false });
      expect({ code, audits: (await deniedAudits(fingerprint, code)).length }).toEqual({ code, audits: 1 });
    }
  });

  it('(R) the return bundle carries the audience, the issuer and public keys only; the lifecycle key joins once the exporter signs', async () => {
    expect(returnBundle).toMatchObject({
      schema: 'rh.knowledge-source.return/1', serviceId, audience: serviceId, certificateSha256: FINGERPRINT,
      credentialReference: `knowledge-source/${SLUG}`, lifecycleKey: null,
    });
    expect(typeof returnBundle.issuer).toBe('string');
    expect(returnBundle.assertionKeys.keys.map((key: any) => key.kid)).toEqual(['reg-run']);
    const lifecycleKey = crypto.generateKeyPairSync('ed25519').privateKey;
    recordLifecyclePublicKey(serviceId, 'ksr-lifecycle', lifecycleKey);
    const read = await call(ADMIN, 'GET', `${BASE}/${serviceId}/return-bundle`);
    expect(read.status).toBe(200);
    expect(read.json.lifecycleKey).toMatchObject({ kid: 'ksr-lifecycle', jwk: { kty: 'OKP', crv: 'Ed25519' } });
    expect(read.json.issuer).toBe(returnBundle.issuer);
    const privateScalars = [ASSERTION_KEY, lifecycleKey].map((key) => String((key.export({ format: 'jwk' }) as any).d));
    for (const scalar of privateScalars) expect(read.text).not.toContain(scalar);
    expect(read.text).not.toMatch(/"d"\s*:|PRIVATE KEY|bearer/i);
    for (const jwk of [...read.json.assertionKeys.keys, read.json.lifecycleKey.jwk]) {
      expect(Object.keys(jwk).sort().every((member) => ['alg', 'crv', 'kid', 'kty', 'use', 'x'].includes(member))).toBe(true);
    }
    // The installer imports it: the stub verifies with these keys and this audience.
    STUB.jwks = read.json.assertionKeys.keys;
    STUB.sources.set(SLUG, {
      slug: SLUG, sourceId: read.json.audience, compartmentId: crypto.randomUUID(), categories: ['relaybrain:note'],
      archiveCategories: [], archiveReaders: new Set<string>(),
    });
    const listed = await call(ADMIN, 'GET', BASE);
    expect(listed.json.registrations.map((entry: any) => entry.service.id)).toContain(serviceId);
  });

  it('(L) the readers\' grant is made through the existing grant flow the state names', async () => {
    const readerAccount = await makeAccount('user', 'reader');
    readerConnector = await connectorOf(readerAccount, ['knowledge-contents:read']);
    const state = (await call(ADMIN, 'GET', `${BASE}/${serviceId}`)).json.registration;
    expect(state.grantsForApproval.direct).toEqual({
      surface: '/settings/access', granteeType: 'principal', resourceType: 'service', resourceId: serviceId, verb: 'read',
    });
    // Before the grant the reader's queryable set does not hold the source.
    const before = await call(readerConnector, 'GET', '/knowledge-sources');
    expect(before.json.sources.map((source: any) => source.id)).not.toContain(serviceId);
    const { granteeType, resourceType, resourceId, verb } = state.grantsForApproval.direct;
    // The route's ceiling is the root scope: an operator (an administrator
    // without root) is refused, an admin login session makes it.
    const byOperator = await call(OPERATOR, 'POST', '/grants', { granteeType, granteeId: readerAccount, resourceType, resourceId, verb });
    expect(byOperator.status).toBe(403);
    const made = await call(ADMIN, 'POST', '/grants', { granteeType, granteeId: readerAccount, resourceType, resourceId, verb });
    expect(made.status).toBe(201);
    const after = await call(readerConnector, 'GET', '/knowledge-sources');
    expect(after.json.sources.map((source: any) => source.id)).toContain(serviceId);
  });

  it('(L) the change request the dialog would file for the read grant: what an administrator filing answers today', async () => {
    // Exactly the body RequestChangeDialog files for a knowledge Service with no
    // source to read yet: grant.rows, service, exact, read, for the filer's own
    // Account. The page offers no "Request a change" button while this answers
    // ALREADY_HELD (a finding for the change-request owner); when it files, the
    // button can return.
    const body = {
      targetType: 'grant.rows',
      change: { rules: [{ resourceType: 'service', selectorForm: 'exact', selectorIds: [serviceId], verbs: ['read'] }] },
      reason: 'Read the knowledge source registered from its installer bundle.',
    };
    const byOperator = await call(OPERATOR, 'POST', '/approvals/requests', body);
    const byAdmin = await call(ADMIN, 'POST', '/approvals/requests', body);
    expect({ operator: [byOperator.status, byOperator.json?.code], admin: [byAdmin.status, byAdmin.json?.code] })
      .toEqual({ operator: [409, 'ALREADY_HELD'], admin: [409, 'ALREADY_HELD'] });
  });

  const search = async () => {
    const answer = await call(readerConnector, 'POST', '/knowledge-queries', { protocol_version: 2, q: 'registration needle', sources: [serviceId] });
    expect(answer.status).toBe(200);
    return answer.json;
  };

  it('(L) until the reference resolves the dial is REFUSED unavailable:transport and nothing is sent', async () => {
    const sent = STUB.requests.length;
    const handshakes = tlsRefusals;
    const answer = await search();
    expect(answer.coverage.consulted).toEqual([serviceId]);
    expect(answer.coverage.unavailable).toEqual([{ id: serviceId, reason: 'transport' }]);
    expect(STUB.requests.length).toBe(sent);
    expect(tlsRefusals).toBe(handshakes);
    const state = await call(ADMIN, 'GET', `${BASE}/${serviceId}`);
    expect(state.json.registration.channel).toMatchObject({ resolves: false, dial: 'refused', refusal: 'unavailable:transport' });
  });

  it('(L) after the operator\'s step the core dials through its DEFAULT trust store, which refuses the confirmed but self-signed certificate (D7(a))', async () => {
    STUB.bearer = crypto.randomBytes(24).toString('base64url');
    process.env.RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS = JSON.stringify({ [`knowledge-source/${SLUG}`]: { bearer: STUB.bearer } });
    const state = await call(ADMIN, 'GET', `${BASE}/${serviceId}`);
    expect(state.json.registration.channel).toMatchObject({ resolves: true, dial: 'ready', refusal: null });
    expect(state.text).not.toContain(STUB.bearer);
    anchorSeam = false;
    const sent = STUB.requests.length;
    const handshakes = tlsRefusals;
    const answer = await search();
    expect(answer.coverage.unavailable).toEqual([{ id: serviceId, reason: 'transport' }]);
    expect(STUB.requests.length).toBe(sent);
    // The core DID dial, and the handshake failed: no installer CA, no pinned fingerprint.
    for (let i = 0; i < 50 && tlsRefusals === handshakes; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tlsRefusals).toBeGreaterThan(handshakes);
  });

  it('(L) with the existing test-only trust seam the source answers, verifying the assertion with the return bundle\'s keys and audience', async () => {
    anchorSeam = true;
    const sent = STUB.requests.length;
    const answer = await search();
    expect(answer.coverage.answered).toEqual([serviceId]);
    const dialed = STUB.requests.slice(sent);
    expect(dialed.map((entry: any) => [entry.slug, entry.verb, entry.status, entry.refusal])).toEqual([[SLUG, 'search', 200, null]]);
    expect(dialed[0].claims.aud).toBe(serviceId);
    anchorSeam = false;
  });
});

// ═══════════ (K) the derived credential reference must be free ═══════════

describe('(K) the derived channel-credential reference must be free', () => {
  let savedCredentials: string | undefined;
  beforeEach(() => { savedCredentials = process.env[CREDENTIALS_ENV]; });
  afterEach(() => {
    if (savedCredentials === undefined) delete process.env[CREDENTIALS_ENV];
    else process.env[CREDENTIALS_ENV] = savedCredentials;
  });

  const bodyFor = (fingerprint: string, extra: { slug?: string; name?: string } = {}) => ({
    bundle: bundleFor({ ...extra, endpoint: STUB.url(`/k-${tag()}/search`), fingerprint }),
    confirmedFingerprint: fingerprint, confirmation: 'checked', allowedNetworks: [`${STUB.host}/32`],
  });

  /** Register, expect the taken reference with its reason, and prove nothing was written or spent. */
  async function expectTaken(body: Record<string, any>, fingerprint: string, reason: string): Promise<{ token: string; tokenId: string }> {
    const token = await stepUp(ADMIN.principalId, fingerprint);
    const before = { services: await serviceCount(), registrations: await registrationCount() };
    const answer = await call(ADMIN, 'POST', BASE, { ...body, stepUpToken: token.token });
    expect({ status: answer.status, code: answer.json?.code, reason: answer.json?.reason, field: answer.json?.field })
      .toEqual({ status: 409, code: 'REGISTRATION_CREDENTIAL_REFERENCE_TAKEN', reason, field: 'slug' });
    // Names only: no placed value ever comes back.
    expect(answer.text).not.toContain('bearer-value-');
    expect({ services: await serviceCount(), registrations: await registrationCount() }).toEqual(before);
    expect(await tokenConsumed(token.tokenId)).toBe(false);
    const audits = await deniedAudits(fingerprint, 'REGISTRATION_CREDENTIAL_REFERENCE_TAKEN');
    expect(audits.map((row) => row.metadata.reason)).toEqual([reason]);
    return token;
  }

  it('(a) a reference that already resolves is refused, then the same step-up registers once the entry is gone', async () => {
    // The round-1 reproduction: a bearer already placed under knowledge-source/<s>, a NEW endpoint registered as <s>.
    const slug = `ksr-victim-${tag()}`;
    process.env[CREDENTIALS_ENV] = JSON.stringify({ [`knowledge-source/${slug}`]: { bearer: `bearer-value-${tag()}` } });
    const fingerprint = fingerprintOf();
    const body = bodyFor(fingerprint, { slug });
    const token = await expectTaken(body, fingerprint, 'resolves');
    delete process.env[CREDENTIALS_ENV];
    const answer = await call(ADMIN, 'POST', BASE, { ...body, stepUpToken: token.token });
    expect(answer.status).toBe(201);
    expect(answer.json.registration.channel).toMatchObject({ credentialReference: `knowledge-source/${slug}`, resolves: false, dial: 'refused' });
  });

  it('(a) the name derived from the bundle name, with no slug given, is checked the same way', async () => {
    const suffix = tag();
    process.env[CREDENTIALS_ENV] = JSON.stringify({ [`knowledge-source/ksr-named-${suffix}`]: { bearer: `bearer-value-${tag()}` } });
    const fingerprint = fingerprintOf();
    await expectTaken(bodyFor(fingerprint, { name: `KSR Named ${suffix}` }), fingerprint, 'resolves');
  });

  it('(a) a Service deleted while its bearer stays placed cannot pass that bearer to a new endpoint under its old slug', async () => {
    const slug = `ksr-reborn-${tag()}`;
    const first = fingerprintOf();
    const token = await stepUp(ADMIN.principalId, first);
    const made = await call(ADMIN, 'POST', BASE, { ...bodyFor(first, { slug }), stepUpToken: token.token });
    expect(made.status).toBe(201);
    process.env[CREDENTIALS_ENV] = JSON.stringify({ [`knowledge-source/${slug}`]: { bearer: `bearer-value-${tag()}` } });
    await serviceRegistry.delete(made.json.registration.service.id);
    expect((await pool.query('SELECT 1 FROM services WHERE slug = $1', [slug])).rows).toEqual([]);
    const second = fingerprintOf();
    await expectTaken(bodyFor(second, { slug }), second, 'resolves');
  });

  it('(b) an entry under the exact name that does not resolve (no bearer yet) is refused as an entry', async () => {
    const slug = `ksr-empty-${tag()}`;
    process.env[CREDENTIALS_ENV] = JSON.stringify({ [`knowledge-source/${slug}`]: {} });
    const fingerprint = fingerprintOf();
    await expectTaken(bodyFor(fingerprint, { slug }), fingerprint, 'environment-entry');
  });

  it.each([
    ['upper case', (s: string) => `Knowledge-Source/${s.toUpperCase()}`],
    ['other separators', (s: string) => `knowledge_source/${s.replace(/-/g, '.')}`],
    ['surrounding and inner whitespace', (s: string) => ` knowledge-source/ ${s.replace(/-/g, ' ')} `],
    ['Unicode compatibility forms', (s: string) => `\uFF4B\uFF4E\uFF4F\uFF57\uFF4C\uFF45\uFF44\uFF47\uFF45-source/${s}`],
    ['an invisible character', (s: string) => `knowledge-source/${s.slice(0, 4)}\u200B${s.slice(4)}`],
  ])('(b) an entry that is the same name after folding (%s) is refused as an entry', async (_label, variant) => {
    const slug = `ksr-fold-${tag()}`;
    const entry = variant(slug);
    expect(entry).not.toBe(`knowledge-source/${slug}`);
    process.env[CREDENTIALS_ENV] = JSON.stringify({ [entry]: { bearer: `bearer-value-${tag()}` } });
    const fingerprint = fingerprintOf();
    await expectTaken(bodyFor(fingerprint, { slug }), fingerprint, 'environment-entry');
  });

  it.each([
    ['a published Service', 'published', (s: string) => `knowledge-source/${s}`],
    ['a retired Service', 'retired', (s: string) => `knowledge-source/${s}`],
    ['a draft Service, case and separators folded', 'draft', (s: string) => `Knowledge_Source/${s.toUpperCase()}`],
  ])('(c) a reference recorded by %s is refused, whatever its slug', async (_label, status, recorded) => {
    const slug = `ksr-held-${tag()}`;
    await pool.query(
      `INSERT INTO services (slug, name, description, kind, status, knowledge_core_credential_ref, retired_at)
       VALUES ($1, 'held by hand', '', 'service', $2, $3, $4)`,
      [`ksr-other-${tag()}`, status, recorded(slug), status === 'retired' ? new Date() : null]);
    const fingerprint = fingerprintOf();
    await expectTaken(bodyFor(fingerprint, { slug }), fingerprint, 'service-reference');
  });
});
