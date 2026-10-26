/**
 * Card bc847bd0 (owner ruling E159, "refuse names"): a path id that is not a
 * full UUID answered 5xx on whole route families, the class card 9cdc6b27
 * closed for /skills.
 *
 * A path id that a handler hands to a uuid-typed read (or a Version number to
 * an integer one) without checking its shape surfaces PostgreSQL's cast
 * failure (22P02, 22003) as HTTP 500, or as 503 where the authorization stage
 * reads it first. The census of the class, driven through the production
 * routers over a real PostgreSQL, found it on:
 *
 *   projects        a Project NAME passes the point stage, which resolves
 *                   names, and reached about twenty uuid reads (500); the
 *                   owner paths read it before the route ceiling (503); a
 *                   malformed :resourceId or :skillId reached its read (500);
 *                   a Charter Version number past 2147483647 (500)
 *   personalities   PATCH and DELETE by slug (500)
 *   identity-providers  every :id route, /links/:linkId and :groupId (500)
 *   credentials     reveal, revoke and rotate (500)
 *   notification-endpoints  DELETE (500)
 *   appearance      GET /appearance/asset-versions/:id (500) and a revert
 *                   Version number past 2147483647 (500)
 *   auth sessions   DELETE /auth/sessions/:id (500)
 *   oauth           the consent request read and decision (500)
 *   tasks           the point stage resolves an 8-character Task id PREFIX,
 *                   and about twenty handlers then read it as a uuid (500,
 *                   503; POST /tasks/:id/brief never answered at all); a
 *                   malformed :leaseId or :depTaskId (500)
 *   services        a descriptor Version number past 2147483647 (500)
 *   the account-owner arm of the authorization stage: every admin-action
 *                   point route of tasks, phases and reports (503)
 *
 * Every family below now refuses such an id by name with 400 (the family's
 * INVALID_<OBJECT>_ID, or its existing Version refusal) before anything reads
 * it; the account-owner arm steps aside for an id that cannot name a stored
 * row. An uppercase or unknown UUID answers exactly as before, and no name is
 * resolved to an id.
 *
 * THE CENSUS IS THE CONTROL. Each family's table is compared with the routes
 * the production router's own stack carries for the family's guarded
 * parameters, so a route added to a family without being probed reddens the
 * family's census. The last test walks every OTHER route with a path
 * parameter, on every mounted router, and requires that a name-shaped value
 * never answers 5xx: the census of the class is measured, not asserted.
 *
 * DESTRUCTIVE: writes principals, sessions, credentials, services, projects,
 * a Charter, tasks, reports, personalities, groups and an identity provider.
 * It refuses any deployment database and any non-local host, and FAILS -
 * never skips - without a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the non-UUID path id census drives the production routers over '
    + 'stored rows, so it never skips. Load database/init.sql into a disposable database, run npm run migrate, and '
    + 'point RELAYHALL_TEST_DB_URL at it.');
}
const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = decodeURIComponent(parsed.pathname.slice(1));
const localDisposable = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  && /test|contract|fixture/.test(TEST_DB_NAME);
const ciService = process.env.CI === 'true' && parsed.hostname === 'postgres' && TEST_DB_NAME === 'relayhall_ci';
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
  || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod'].includes(TEST_DB_NAME)
  || (!localDisposable && !ciService)) {
  throw new Error('The non-UUID path id census refuses a non-disposable database target');
}

const JWT_SECRET = crypto.randomBytes(32).toString('hex');
Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: TEST_DB_NAME,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET,
});

const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db/connection');
const { PROTECTED_ROUTE_REGISTRATIONS, registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware, pointAuthorizationTarget } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { principalService } = require('../services/PrincipalService');
const { insertGroupRow } = require('./support/groupRows');
const authRoutes = require('../routes/auth').default;
const appearanceRoutes = require('../routes/appearance').default;
const oauthRoutes = require('../routes/oauth').default;
const { OAUTH_ROUTE_PATH } = require('../utils/oauthMetadata');
const projectsRoutes = require('../routes/projects').default;
const tasksRoutes = require('../routes/tasks').default;
const personalitiesRoutes = require('../routes/personalities').default;
const identityProvidersRoutes = require('../routes/identityProviders').default;
const credentialsRoutes = require('../routes/credentials').default;
const notificationEndpointsRoutes = require('../routes/notificationEndpoints').default;
const appearanceAdminRoutes = require('../routes/appearanceAdmin').default;
const servicesRoutes = require('../routes/services').default;
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');

jest.setTimeout(600_000);

/** A request that never answers (an unhandled rejection in an Express 4
 * handler) is recorded as status -1 rather than hanging the suite. */
const REQUEST_TIMEOUT_MS = 15_000;
const INT4_PAST_MAX = ['2147483648', '99999999999'];
/** A Skill-like name, a plain word, and two wildcard spellings (`%25` reaches
 * the route as the literal `%`). */
const NOT_UUIDS = ['not-a-uuid', 'relayhall-release-review', '*', '%25'];

// ── the app: the production routers behind the production chain ────────────

const PUBLIC_MOUNTS: Array<{ path: string; router: any }> = [
  { path: '/auth', router: authRoutes },
  { path: '/appearance', router: appearanceRoutes },
  { path: OAUTH_ROUTE_PATH, router: oauthRoutes },
];

function buildApp(): any {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  for (const mount of PUBLIC_MOUNTS) app.use(mount.path, mount.router);
  app.use(MCP_ROUTE_PATH, mcpRoutes);
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  return app;
}

let server: http.Server;
let origin: string;

interface Caller { label: string; principalId: string; headers: Record<string, string> }
interface Answer { status: number; code: string | null; json: any; text: string }

function writeHeaders(method: string): Record<string, string> {
  // Past every header precondition, so a route reaches the code that reads its id.
  return method === 'GET' ? {} : { 'If-Match': crypto.randomBytes(16).toString('hex'), 'Idempotency-Key': `nonuuid-${crypto.randomUUID()}` };
}

async function send(who: Caller, method: string, routePath: string, body?: unknown): Promise<Answer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${origin}${routePath}`, {
      method,
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...writeHeaders(method), ...who.headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, code: typeof json?.code === 'string' ? json.code : null, json, text };
  } catch (error) {
    return { status: -1, code: 'NO_ANSWER', json: null, text: String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function defaultBody(method: string): unknown {
  return method === 'GET' || method === 'DELETE' ? undefined : {};
}

async function mcpCall(who: Caller, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${origin}${MCP_ROUTE_PATH}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: who.headers.Authorization,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const text = await response.text();
    try {
      return `HTTP ${response.status} ${String(JSON.parse(text)?.result?.content?.[0]?.text ?? text)}`;
    } catch {
      return `HTTP ${response.status} ${text}`;
    }
  } catch (error) {
    return `NO_ANSWER ${String(error)}`;
  } finally {
    clearTimeout(timer);
  }
}

// ── the census: the router's own stack ──────────────────────────────────────

interface StackRoute { method: string; path: string; mount: string; params: string[] }
const routeKey = (route: { method: string; path: string }): string => `${route.method} ${route.path}`;

function nestedMount(layer: any): string {
  const match = /^\^((?:\\\/[A-Za-z0-9_-]+)+)\\\/\?\(\?=\\\/\|\$\)/.exec(String(layer.regexp?.source ?? ''));
  if (!match) throw new Error(`a nested router whose mount path this census cannot read: ${layer.regexp}`);
  return match[1].replace(/\\\//g, '/');
}

function stackRoutes(router: any, mount: string): StackRoute[] {
  const out: StackRoute[] = [];
  for (const layer of router.stack ?? []) {
    if (layer.route && typeof layer.route.path === 'string') {
      const path = `${mount}${layer.route.path}`;
      const params = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);
      for (const method of Object.keys(layer.route.methods).filter((name) => name !== '_all')) {
        out.push({ method: method.toUpperCase(), path, mount, params });
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      out.push(...stackRoutes(layer.handle, `${mount}${nestedMount(layer)}`));
    }
  }
  return out;
}

function mountOf(router: any): string {
  const registration = PROTECTED_ROUTE_REGISTRATIONS.find((entry: any) => entry.router === router);
  if (!registration) throw new Error('router is not a protected registration');
  return registration.path;
}

function concrete(route: StackRoute, values: Record<string, string>): string {
  return route.path.replace(/:([A-Za-z0-9_]+)/g, (_whole, name: string) => values[name] ?? crypto.randomUUID());
}

// ── fixtures ────────────────────────────────────────────────────────────────

const tag = (): string => crypto.randomBytes(5).toString('hex');

let ROOT: Caller;
let USER: Caller;
let ROOT_BEARER: Caller;
let NARROW: Caller;
let CONSENT: Caller;
let PROJECT_ID: string;
let PROJECT_NAME: string;
let TASK_ID: string;
let TASK_PREFIX: string;
let REPORT_ID: string;
let REPORT_PREFIX: string;
let PERSONALITY_ID: string;
let PERSONALITY_SLUG: string;
let SERVICE_ID: string;
let SERVICE_SLUG: string;
let PROVIDER_ID: string;
let GROUP_ID: string;
const unhandled: string[] = [];
const recordUnhandled = (reason: unknown): void => { unhandled.push(String((reason as any)?.code ?? reason)); };

async function makeAccount(role: string, label: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $1, 'active', $2) RETURNING id`,
    [`nonuuid-${label}-${tag()}`, role],
  );
  return String(result.rows[0].id);
}

async function sessionFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

/** A bearer holding root over BOTH transports: unmintable through any door
 * (ROOT_NOT_MINTABLE), so it is minted narrow and widened in raw SQL, as the
 * lenses-b and group-principal drills build theirs. */
async function rootBearerFor(accountId: string): Promise<Caller> {
  const created = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role, parent_principal_id)
     VALUES ('service', $1, $1, 'active', 'user', $2) RETURNING id`,
    [`nonuuid-bearer-${tag()}`, accountId],
  );
  const bearerId = String(created.rows[0].id);
  const issued = await principalService.issueCredential({
    principalId: bearerId, scopes: ['principals:read'], label: 'nonuuid-root-bearer', transport: 'any',
  });
  await pool.query('UPDATE principals SET parent_principal_id = NULL WHERE id = $1', [bearerId]);
  await pool.query('UPDATE principal_credentials SET scopes = $2::jsonb WHERE id = $1',
    [issued.credentialId, JSON.stringify(['root'])]);
  principalService.invalidatePrincipals([bearerId]);
  return { label: 'root-bearer', principalId: bearerId, headers: { Authorization: `Bearer ${issued.fullKey}` } };
}

async function registerConnector(owner: Caller, scopes: string[]): Promise<{ caller: Caller; serviceId: string; slug: string }> {
  const slug = `nonuuid-connector-${tag()}`;
  const registered = await send(owner, 'POST', '/services', {
    slug, name: slug, description: 'Non-UUID path id census connector.', kind: 'connector',
    issueCredential: { scopes, label: slug, transport: 'any' },
  });
  expect(registered.status).toBe(201);
  const row = await pool.query('SELECT id, principal_id FROM services WHERE slug = $1', [slug]);
  return {
    caller: { label: slug, principalId: String(row.rows[0].principal_id), headers: { Authorization: `Bearer ${registered.json.onboarding.credential.secretOnce}` } },
    serviceId: String(row.rows[0].id),
    slug,
  };
}

beforeAll(async () => {
  process.on('unhandledRejection', recordUnhandled);
  await new Promise<void>((resolve) => { server = buildApp().listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // Schema-only disposable databases need the migration 062/084 fallback identity.
  await pool.query(`INSERT INTO principals(kind, handle, display_name, role)
    VALUES ('human', 'dashboard_user', 'Owner', 'orchestrator') ON CONFLICT (handle) DO NOTHING`);

  ROOT = await sessionFor('root', await makeAccount('admin', 'root'));
  USER = await sessionFor('user', await makeAccount('user', 'user'));
  ROOT_BEARER = await rootBearerFor(ROOT.principalId);
  const rootHandle = String((await pool.query('SELECT handle FROM principals WHERE id = $1', [ROOT.principalId])).rows[0].handle);
  CONSENT = {
    label: 'consent', principalId: ROOT.principalId,
    headers: { Authorization: `Bearer ${jwt.sign({ v: 2, sub: ROOT.principalId, handle: rootHandle, kind: 'human' }, JWT_SECRET, { expiresIn: '30m' })}` },
  };

  PROJECT_NAME = `nonuuid-project-${tag()}`;
  const project = await send(ROOT, 'POST', '/projects', { name: PROJECT_NAME });
  expect(project.status).toBe(201);
  PROJECT_ID = String(project.json.project.id);
  const charter = await send(ROOT, 'PUT', `/projects/${PROJECT_ID}/charter`, { content: '# Charter\n\nThe census Charter.' });
  expect(charter.status).toBe(201);

  const task = await send(ROOT, 'POST', '/tasks', {
    title: `Non-UUID census ${tag()}`, description: 'card bc847bd0', status: 'todo', project: PROJECT_ID,
  });
  expect(task.status).toBe(201);
  TASK_ID = String(task.json.task.id);
  TASK_PREFIX = TASK_ID.slice(0, 8);
  // A prefix the point stage resolves to exactly this Task.
  expect(Number((await pool.query(`SELECT count(*)::int AS n FROM tasks WHERE id::text LIKE $1 || '%'`, [TASK_PREFIX])).rows[0].n)).toBe(1);

  const report = await pool.query(
    `INSERT INTO reports (title, content, summary, task_ids, author_principal_id, author_actor_id, origin)
     VALUES ('Non-UUID census report', 'card bc847bd0', 'census', $1, $2::uuid, $2::uuid::text, 'api') RETURNING id`,
    [[TASK_ID], ROOT.principalId],
  );
  REPORT_ID = String(report.rows[0].id);
  REPORT_PREFIX = REPORT_ID.slice(0, 8);
  expect(Number((await pool.query(`SELECT count(*)::int AS n FROM reports WHERE id::text LIKE $1 || '%'`, [REPORT_PREFIX])).rows[0].n)).toBe(1);

  PERSONALITY_SLUG = `nonuuid-personality-${tag()}`;
  const personality = await send(ROOT, 'POST', '/personalities', { slug: PERSONALITY_SLUG, name: 'Non-UUID census personality' });
  expect(personality.status).toBe(201);
  PERSONALITY_ID = String(personality.json.personality.id);

  const connector = await registerConnector(ROOT, ['tasks:read', 'tasks:write', 'projects:read', 'projects:write']);
  SERVICE_ID = connector.serviceId;
  SERVICE_SLUG = connector.slug;
  NARROW = (await registerConnector(ROOT, ['tasks:read'])).caller;

  const provider = await pool.query(
    `INSERT INTO identity_providers
       (name, status, issuer, discovery_url, client_id, subject_immutable, group_binding_mode, groups_claim)
     VALUES ($1, 'disabled', $2, $3, 'nonuuid-census', TRUE, 'claim', 'groups') RETURNING id`,
    [`nonuuid ${tag()}`, `https://issuer.invalid/nonuuid/${tag()}`, `https://issuer.invalid/nonuuid/${tag()}/.well-known/openid-configuration`],
  );
  PROVIDER_ID = String(provider.rows[0].id);
  GROUP_ID = await insertGroupRow(pool, { name: `nonuuid ${tag()}`, description: 'card bc847bd0 census', featured: false });

  // The MCP twins act as a root bearer, so object authority never decides
  // what they answer; a bootstrapped credential may change board state.
  expect(await mcpCall(ROOT_BEARER, 'relayhall_brief_compile', { session: true })).toContain('HTTP 200');
});

afterAll(async () => {
  process.off('unhandledRejection', recordUnhandled);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ── the families ────────────────────────────────────────────────────────────

interface Refusal { status: number; code: string }
interface Family {
  name: string;
  /** The routers the family's guards sit on, with their mounts. */
  routers: () => Array<{ router: any; mount: string }>;
  /** Guarded parameter -> the refusal it answers for a malformed value. */
  refusals: Record<string, Refusal>;
  /** THE CENSUS: every route of the family carrying a guarded parameter. */
  table: string[];
  /** Routes carrying a guarded parameter name that the guard does not cover, and why. */
  excluded?: Record<string, string>;
  caller: () => Caller;
  /** The malformed values a guarded parameter is probed with. */
  bad: (param: string) => string[];
  /** A real value for every OTHER parameter of a probed route. */
  real: () => Record<string, string>;
  body?: (route: StackRoute) => unknown;
}

function familyRoutes(family: Family): StackRoute[] {
  return family.routers()
    .flatMap(({ router, mount }) => stackRoutes(router, mount))
    .filter((route) => route.params.some((param) => param in family.refusals));
}

/** Every route x guarded parameter x malformed value, through the production
 * chain. Returns the answers that are not the family's refusal. */
async function probeFamily(family: Family): Promise<string[]> {
  const excluded = new Set(Object.keys(family.excluded ?? {}));
  const failures: string[] = [];
  for (const route of familyRoutes(family).filter((candidate) => !excluded.has(routeKey(candidate)))) {
    for (const param of route.params.filter((name) => name in family.refusals)) {
      for (const bad of family.bad(param)) {
        const path = concrete(route, { ...family.real(), [param]: bad });
        const answer = await send(family.caller(), route.method, path, family.body ? family.body(route) : defaultBody(route.method));
        const want = family.refusals[param];
        if (answer.status !== want.status || answer.code !== want.code) {
          failures.push(`${routeKey(route)} :${param}=${bad} -> ${answer.status} ${answer.code ?? ''}`.trim());
        }
      }
    }
  }
  return failures;
}

/** The family's table against the router's own stack, as failures (so a red
 * census reports the routes it is missing AND every answer it got). */
function censusDiff(family: Family): string[] {
  const stack = new Set(familyRoutes(family).map(routeKey));
  const declared = new Set([...family.table, ...Object.keys(family.excluded ?? {})]);
  return [
    ...[...stack].filter((key) => !declared.has(key)).map((key) => `not in the census table: ${key}`),
    ...[...declared].filter((key) => !stack.has(key)).map((key) => `not on the router: ${key}`),
  ];
}

async function familyFailures(family: Family): Promise<string[]> {
  return [...censusDiff(family), ...await probeFamily(family)];
}

const FAMILIES: Record<string, Family> = {
  projects: {
    name: 'projects',
    routers: () => [{ router: projectsRoutes, mount: '/projects' }],
    refusals: {
      id: { status: 400, code: 'INVALID_PROJECT_ID' },
      resourceId: { status: 400, code: 'INVALID_RESOURCE_ID' },
      skillId: { status: 400, code: 'INVALID_SKILL_ID' },
      version: { status: 400, code: 'INVALID_QUERY_VALUE' },
    },
    table: [
      'POST /projects/:id/brief', 'GET /projects/:id/context', 'GET /projects/:id/phases',
      'GET /projects/:id/compatibility', 'POST /projects/:id/archive', 'POST /projects/:id/unarchive',
      'GET /projects/:id/stats', 'POST /projects/:id/links', 'PUT /projects/:id/links/:linkId',
      'DELETE /projects/:id/links/:linkId', 'GET /projects/:id/resources', 'POST /projects/:id/resources',
      'GET /projects/:id/resources/:resourceId', 'PATCH /projects/:id/resources/:resourceId',
      'POST /projects/:id/resources/:resourceId/archive', 'POST /projects/:id/resources/:resourceId/restore',
      'POST /projects/:id/resources/:resourceId/replace', 'PATCH /projects/:id/resources', 'PUT /projects/:id/resources',
      'GET /projects/:id/tool-instructions', 'PATCH /projects/:id/tool-instructions', 'PUT /projects/:id/tool-instructions',
      'GET /projects/:id/skills', 'PUT /projects/:id/skills/:skillId', 'DELETE /projects/:id/skills/:skillId',
      'GET /projects/:id/tools', 'PUT /projects/:id/tools', 'GET /projects/:id/sessions',
      'GET /projects/:id/charter', 'PUT /projects/:id/charter', 'POST /projects/:id/charter/approve',
      'GET /projects/:id/charter/versions', 'GET /projects/:id/charter/versions/:version',
      'GET /projects/:id/owner-access', 'GET /projects/:id/owner-candidates', 'PUT /projects/:id/owner',
      // LENSES-c c1-B (card b5c83682): the steward transfer route, guarded like its sibling.
      'PUT /projects/:id/owner/steward',
      'PUT /projects/:id/default-verifier', 'GET /projects/:id/default-verifier/candidates',
      'GET /projects/:id', 'PATCH /projects/:id',
    ],
    caller: () => ROOT,
    bad: (param) => (param === 'id' ? [PROJECT_NAME, ...NOT_UUIDS] : param === 'version' ? INT4_PAST_MAX : NOT_UUIDS),
    real: () => ({ id: PROJECT_ID, version: '1' }),
    // A pin body, so a malformed :skillId is the only thing wrong with it.
    body: (route) => (route.path.endsWith('/skills/:skillId') && route.method === 'PUT' ? { version: 1 } : defaultBody(route.method)),
  },
  personalities: {
    name: 'personalities',
    routers: () => [{ router: personalitiesRoutes, mount: '/personalities' }],
    refusals: { id: { status: 400, code: 'INVALID_PERSONALITY_ID' } },
    table: ['PATCH /personalities/:id', 'DELETE /personalities/:id'],
    excluded: { 'GET /personalities/:id': 'addressable by slug by design: it reads by slug, never casts one' },
    caller: () => ROOT,
    bad: () => [PERSONALITY_SLUG, ...NOT_UUIDS],
    real: () => ({}),
  },
  identityProviders: {
    name: 'identity-providers',
    routers: () => [{ router: identityProvidersRoutes, mount: '/identity-providers' }],
    refusals: {
      id: { status: 400, code: 'INVALID_IDENTITY_PROVIDER_ID' },
      linkId: { status: 400, code: 'INVALID_IDENTITY_LINK_ID' },
      groupId: { status: 400, code: 'INVALID_GROUP_ID' },
    },
    table: [
      'GET /identity-providers/:id', 'PATCH /identity-providers/:id', 'PUT /identity-providers/:id/scim-client',
      'DELETE /identity-providers/:id/scim-client', 'DELETE /identity-providers/:id',
      'POST /identity-providers/:id/test-connection', 'GET /identity-providers/:id/invitations',
      'POST /identity-providers/:id/invitations', 'GET /identity-providers/:id/links',
      'GET /identity-providers/:id/login-groups', 'POST /identity-providers/:id/login-groups',
      'DELETE /identity-providers/:id/login-groups/:groupId', 'DELETE /identity-providers/links/:linkId',
    ],
    caller: () => ROOT,
    bad: () => NOT_UUIDS,
    real: () => ({ id: PROVIDER_ID, groupId: GROUP_ID }),
    body: (route) => (route.path.endsWith('/scim-client') && route.method === 'PUT'
      ? { principalId: crypto.randomUUID() }
      : route.path.endsWith('/login-groups') && route.method === 'POST' ? { groupId: GROUP_ID } : defaultBody(route.method)),
  },
  credentials: {
    name: 'credentials',
    routers: () => [{ router: credentialsRoutes, mount: '/credentials' }],
    refusals: { id: { status: 400, code: 'INVALID_CREDENTIAL_ID' } },
    table: ['POST /credentials/:id/reveal', 'POST /credentials/:id/revoke', 'POST /credentials/:id/rotate'],
    excluded: { 'PATCH /credentials/:id': 'canonicalises the id and answers 404 CREDENTIAL_NOT_FOUND before any read (AZ-A13)' },
    caller: () => ROOT,
    bad: () => NOT_UUIDS,
    real: () => ({}),
  },
  notificationEndpoints: {
    name: 'notification-endpoints',
    routers: () => [{ router: notificationEndpointsRoutes, mount: '/notification-endpoints' }],
    refusals: { id: { status: 400, code: 'INVALID_NOTIFICATION_ENDPOINT_ID' } },
    table: ['DELETE /notification-endpoints/:id'],
    caller: () => ROOT,
    bad: () => NOT_UUIDS,
    real: () => ({}),
  },
  appearance: {
    name: 'appearance',
    routers: () => [{ router: appearanceAdminRoutes, mount: mountOf(appearanceAdminRoutes) }],
    refusals: {
      id: { status: 400, code: 'INVALID_APPEARANCE_ASSET_ID' },
      versionNo: { status: 400, code: 'INVALID_VERSION' },
    },
    table: ['GET /appearance/asset-versions/:id', 'POST /appearance/versions/:versionNo/revert'],
    caller: () => ROOT,
    bad: (param) => (param === 'versionNo' ? INT4_PAST_MAX : NOT_UUIDS),
    real: () => ({}),
  },
  authSessions: {
    name: 'auth sessions',
    routers: () => [{ router: authRoutes, mount: '/auth' }],
    refusals: { id: { status: 400, code: 'INVALID_SESSION_ID' } },
    table: ['DELETE /auth/sessions/:id'],
    caller: () => ROOT,
    bad: () => NOT_UUIDS,
    real: () => ({}),
  },
  oauth: {
    name: 'oauth authorization requests',
    routers: () => [{ router: oauthRoutes, mount: OAUTH_ROUTE_PATH }],
    refusals: { requestId: { status: 400, code: 'INVALID_AUTHORIZATION_REQUEST_ID' } },
    table: ['GET /oauth/authorization-requests/:requestId', 'POST /oauth/authorization-requests/:requestId/decision'],
    caller: () => CONSENT,
    bad: () => NOT_UUIDS,
    real: () => ({}),
    // A well-formed decision, so the request id is the only thing wrong with it.
    body: (route) => (route.method === 'POST' ? { approve: false } : undefined),
  },
  tasks: {
    name: 'tasks',
    routers: () => [{ router: tasksRoutes, mount: '/tasks' }],
    refusals: {
      id: { status: 400, code: 'INVALID_TASK_ID' },
      depTaskId: { status: 400, code: 'INVALID_TASK_ID' },
      leaseId: { status: 400, code: 'INVALID_LEASE_ID' },
    },
    table: [
      'GET /tasks/:id/account-owner', 'PUT /tasks/:id/account-owner', 'GET /tasks/:id/assignment-access',
      // LENSES-c c1-B (card b5c83682): the steward transfer route, guarded like its sibling.
      'PUT /tasks/:id/account-owner/steward',
      'POST /tasks/orchestration/:id/claim', 'POST /tasks/orchestration/:id/lease/:leaseId/heartbeat',
      'POST /tasks/orchestration/:id/lease/:leaseId/release', 'POST /tasks/reviewer/:id/run', 'POST /tasks/reviewer/:id/reject',
      'POST /tasks/:id/notifications/deliver', 'GET /tasks/:id/stream', 'GET /tasks/:id/references', 'GET /tasks/:id/timeline',
      'GET /tasks/:id', 'PATCH /tasks/:id/roles', 'PATCH /tasks/:id', 'PATCH /tasks/:id/access', 'DELETE /tasks/:id',
      'POST /tasks/:id/notes', 'POST /tasks/:id/unarchive', 'POST /tasks/:id/stream', 'GET /tasks/:id/reports',
      'GET /tasks/:id/reports/:reportId', 'GET /tasks/:id/report-operations/:key', 'POST /tasks/:id/reports',
      'POST /tasks/:id/finish', 'POST /tasks/:id/references', 'POST /tasks/:id/stream/:entryId/redact',
      'POST /tasks/:id/archive', 'POST /tasks/:id/brief', 'POST /tasks/:id/claim', 'POST /tasks/:id/recover',
      'POST /tasks/:id/release', 'GET /tasks/:id/session-status', 'POST /tasks/:id/breakdown',
      'GET /tasks/:id/dependencies', 'POST /tasks/:id/dependencies', 'DELETE /tasks/:id/dependencies/:depTaskId',
      'PATCH /tasks/:id/subtasks/by-id/:subtaskId/status', 'POST /tasks/:id/subtasks/by-id/:subtaskId/approve',
      'POST /tasks/:id/subtasks/by-id/:subtaskId/reject', 'POST /tasks/:id/subtasks/by-id/:subtaskId/skip',
      'PUT /tasks/:id/subtasks/by-id/:subtaskId', 'PATCH /tasks/:id/subtasks/:index/status',
      // The subtask structure verbs (card 2bc7b303), retried by key: the Task
      // id guard answers before the retry middleware reads the key.
      'POST /tasks/:id/subtasks', 'POST /tasks/:id/subtasks/reorder', 'PATCH /tasks/:id/subtasks/by-id/:subtaskId/text',
      'PUT /tasks/:id/subtasks/:index', 'POST /tasks/:id/subtasks/:index/approve', 'POST /tasks/:id/subtasks/:index/reject',
      'POST /tasks/:id/subtasks/:index/skip', 'GET /tasks/:id/subtasks/summary', 'PATCH /tasks/:id/success-criteria',
    ],
    // A root BEARER: the account-owner arm never reads a Task for a bearer
    // without a literal tasks:write scope, so this census measures the Task
    // guards alone (the arm has its own census below).
    caller: () => ROOT_BEARER,
    // The point stage resolves a Task id PREFIX, so only a prefix reaches a
    // handler; any other non-UUID answers 404 there, unchanged (checked below).
    bad: (param) => (param === 'id' ? [TASK_PREFIX, TASK_ID.slice(0, 13)] : NOT_UUIDS),
    real: () => ({ id: TASK_ID, index: '0', subtaskId: '1' }),
  },
  services: {
    name: 'services descriptor versions',
    routers: () => [{ router: servicesRoutes, mount: '/services' }],
    refusals: { version: { status: 400, code: 'INVALID_QUERY_VALUE' } },
    table: ['GET /services/:id/descriptor/versions/:version', 'POST /services/:id/descriptor/versions/:version/retire'],
    caller: () => ROOT,
    bad: () => INT4_PAST_MAX,
    real: () => ({ id: SERVICE_ID }),
  },
};

/** The account-owner arm of the authorization stage reads the target before
 * the route ceiling for every admin-action point route of these types. */
const ACCOUNT_OWNER_ARM_TYPES = ['task', 'phase', 'report'];
const ACCOUNT_OWNER_ARM_TABLE = [
  'PUT /tasks/:id/account-owner', 'PATCH /tasks/:id/access', 'DELETE /tasks/:id', 'DELETE /tasks/:id/dependencies/:depTaskId',
  'PATCH /phases/:id/access', 'DELETE /phases/:id', 'DELETE /reports/:id',
];

function accountOwnerArmRoutes(): StackRoute[] {
  const sample = '11111111-2222-4333-8444-555555555555';
  return PROTECTED_ROUTE_REGISTRATIONS
    .filter((registration: any) => ['/tasks', '/phases', '/reports'].includes(registration.path))
    .flatMap((registration: any) => stackRoutes(registration.router, registration.path))
    .filter((route: StackRoute) => route.params.includes('id'))
    .filter((route: StackRoute) => {
      const target = pointAuthorizationTarget(route.method, concrete(route, { id: sample }), {});
      return target?.action === 'admin' && ACCOUNT_OWNER_ARM_TYPES.includes(target.type);
    });
}

// ═════════════════════ the families, one census each ═════════════════════

describe('R1 Express spelling variants preserve pre-read refusal and authority', () => {
  it('GET/retire and PATCH/DELETE accept fixed-word case variants and trailing slash without folding UUIDs', async () => {
    const { authorizationRepository } = require('../services/AuthorizationRepository');
    const point = jest.spyOn(authorizationRepository, 'authorizePoint');
    try {
      const serviceWords = [
        ['services', 'descriptor', 'versions', 'retire', ''],
        ['SERVICES', 'descriptor', 'versions', 'retire', ''],
        ['services', 'DESCRIPTOR', 'VERSIONS', 'RETIRE', ''],
        ['SeRvIcEs', 'DeScRiPtOr', 'VeRsIoNs', 'ReTiRe', ''],
        ['services', 'descriptor', 'versions', 'retire', '/'],
        ['SERVICES', 'DESCRIPTOR', 'VERSIONS', 'RETIRE', '/'],
      ];
      for (const method of ['GET', 'POST']) for (const [mount, descriptor, versions, retire, slash] of serviceWords) {
        const path = (id: string, version: string) => `/${mount}/${id}/${descriptor}/${versions}/${version}${method === 'POST' ? '/' + retire : ''}${slash}`;
        point.mockClear();
        const refused = await send(ROOT, method, path(SERVICE_ID, '99999999999'), defaultBody(method));
        expect([refused.status, refused.code]).toEqual([400, 'INVALID_QUERY_VALUE']);
        expect(point).not.toHaveBeenCalled();
        point.mockClear();
        expect((await send(NARROW, method, path(SERVICE_ID, '99999999999'), defaultBody(method))).status).toBe(403);
        expect(point).not.toHaveBeenCalled();
        for (const id of [SERVICE_ID.toUpperCase(), crypto.randomUUID()]) {
          point.mockClear();
          const read = await send(ROOT, method, path(id, '2147483647'), defaultBody(method));
          expect(read.status).toBe(404);
          expect(point.mock.calls[0][2]).toBe(id);
        }
      }
      for (const method of ['PATCH', 'DELETE']) for (const [mount, slash] of [
        ['personalities', ''], ['PERSONALITIES', ''], ['PeRsOnAlItIeS', ''],
        ['personalities', '/'], ['PERSONALITIES', '/'],
      ]) {
        const path = (id: string) => `/${mount}/${id}${slash}`;
        point.mockClear();
        const refused = await send(ROOT, method, path(PERSONALITY_SLUG), defaultBody(method));
        expect([refused.status, refused.code]).toEqual([400, 'INVALID_PERSONALITY_ID']);
        expect(point).not.toHaveBeenCalled();
        point.mockClear();
        expect((await send(NARROW, method, path(PERSONALITY_SLUG), defaultBody(method))).status).toBe(403);
        expect(point).not.toHaveBeenCalled();
        for (const id of [PERSONALITY_ID.toUpperCase(), crypto.randomUUID()]) {
          point.mockClear();
          expect((await send(ROOT, method, path(id), defaultBody(method))).status).toBe(404);
          expect(point.mock.calls[0][2]).toBe(id);
        }
      }
    } finally { point.mockRestore(); }
  });
});

describe('projects (ruling E159): a Project is addressed by its id', () => {
  it('census: every /projects route refuses a Project name or any non-UUID id, a malformed :resourceId and :skillId, and a Charter Version past int4 with 400, through REST and the MCP twins', async () => {
    const failures = await familyFailures(FAMILIES.projects);
    // The owner-change path admits a caller without projects:admin only by
    // READING the Project, so such a caller is refused by the shape alone.
    const owner = await send(USER, 'PUT', `/projects/${PROJECT_NAME}/owner`, { ownerPrincipalId: USER.principalId });
    if (owner.status !== 400 || owner.code !== 'INVALID_PROJECT_ID') failures.push(`USER PUT /projects/<name>/owner -> ${owner.status} ${owner.code}`);
    for (const [tool, args, code] of [
      ['relayhall_project_get', { projectId: PROJECT_NAME }, 'INVALID_PROJECT_ID'],
      ['relayhall_project_update', { projectId: PROJECT_NAME, revision: crypto.randomUUID(), name: 'refused write' }, 'INVALID_PROJECT_ID'],
      ['relayhall_project_archive', { projectId: PROJECT_NAME, revision: crypto.randomUUID() }, 'INVALID_PROJECT_ID'],
      ['relayhall_project_restore', { projectId: PROJECT_NAME, revision: crypto.randomUUID() }, 'INVALID_PROJECT_ID'],
      ['relayhall_project_resource_list', { projectId: PROJECT_NAME }, 'INVALID_PROJECT_ID'],
      ['relayhall_project_resource_create', { projectId: PROJECT_NAME, kind: 'reference', name: 'refused write', details: { url: 'https://example.invalid' }, idempotencyKey: crypto.randomUUID() }, 'INVALID_PROJECT_ID'],
      ['relayhall_project_context_get', { projectId: PROJECT_NAME }, 'INVALID_PROJECT_ID'],
      ['relayhall_charter_get', { projectId: PROJECT_NAME }, 'INVALID_PROJECT_ID'],
      ['relayhall_brief_compile', { projectId: PROJECT_NAME }, 'INVALID_PROJECT_ID'],
      ['relayhall_project_resource_get', { projectId: PROJECT_ID, resourceId: 'not-a-uuid' }, 'INVALID_RESOURCE_ID'],
      ['relayhall_project_resource_update', { projectId: PROJECT_ID, resourceId: 'not-a-uuid', revision: crypto.randomUUID(), kind: 'reference', name: 'refused write' }, 'INVALID_RESOURCE_ID'],
      ['relayhall_project_resource_archive', { projectId: PROJECT_ID, resourceId: 'not-a-uuid', revision: crypto.randomUUID() }, 'INVALID_RESOURCE_ID'],
      ['relayhall_project_resource_restore', { projectId: PROJECT_ID, resourceId: 'not-a-uuid', revision: crypto.randomUUID() }, 'INVALID_RESOURCE_ID'],
      ['relayhall_project_resource_replace', { projectId: PROJECT_ID, resourceId: 'not-a-uuid', revision: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), kind: 'reference', name: 'refused write', details: { url: 'https://example.invalid' } }, 'INVALID_RESOURCE_ID'],
    ] as const) {
      const text = await mcpCall(ROOT_BEARER, tool, args);
      if (!text.includes(`(HTTP 400) [${code}]`)) failures.push(`MCP ${tool} ${JSON.stringify(args)} -> ${text.slice(0, 160)}`);
    }
    expect(failures).toEqual([]);
  });

  it('unchanged: a Project id reads, an unknown or uppercase UUID answers 404, and a caller without the route scope keeps its 403 for a name too', async () => {
    const read = await send(ROOT, 'GET', `/projects/${PROJECT_ID}`);
    expect([read.status, read.json?.project?.name]).toEqual([200, PROJECT_NAME]);
    expect((await send(ROOT, 'GET', `/projects/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await send(ROOT, 'GET', `/projects/${PROJECT_ID.toUpperCase()}`)).status).toBe(404);
    for (const id of [PROJECT_NAME, PROJECT_ID]) {
      const refused = await send(NARROW, 'GET', `/projects/${id}`);
      expect([refused.status, refused.code]).toEqual([403, 'FORBIDDEN']);
      // The route ceiling refuses an Account without projects:admin outright.
      const candidates = await send(USER, 'GET', `/projects/${id}/owner-candidates`);
      expect([candidates.status, candidates.code]).toEqual([403, 'FORBIDDEN']);
    }
    const version = await send(ROOT, 'GET', `/projects/${PROJECT_ID}/charter/versions/1`);
    expect(version.status).toBe(200);
    expect(await mcpCall(ROOT_BEARER, 'relayhall_project_get', { projectId: PROJECT_ID })).toContain(PROJECT_NAME);
  });
});

describe('personalities: PATCH and DELETE take the Personality id', () => {
  it('census: PATCH and DELETE refuse a Personality slug with 400 INVALID_PERSONALITY_ID', async () => {
    expect(await familyFailures(FAMILIES.personalities)).toEqual([]);
    const row = await pool.query('SELECT retired_at, name FROM personalities WHERE id = $1', [PERSONALITY_ID]);
    expect(row.rows[0]).toEqual({ retired_at: null, name: 'Non-UUID census personality' });
  });

  it('GET by slug and id still reads; write names are 400, unknown UUIDs are 404 and manage authority remains first', async () => {
    for (const id of [PERSONALITY_SLUG, PERSONALITY_ID]) {
      const read = await send(ROOT, 'GET', `/personalities/${id}`);
      expect([read.status, read.json?.personality?.id]).toEqual([200, PERSONALITY_ID]);
    }
    expect((await send(ROOT, 'PATCH', '/personalities/not-a-personality', { name: 'x' })).status).toBe(400);
    expect((await send(USER, 'PATCH', `/personalities/${PERSONALITY_SLUG}`, { name: 'x' })).status).toBe(403);
    expect((await send(ROOT, 'PATCH', `/personalities/${crypto.randomUUID()}`, { name: 'x' })).status).toBe(404);
  });
});

describe('identity providers: every :id, :linkId and :groupId', () => {
  it('census: every route refuses a non-UUID with 400, by parameter', async () => {
    expect(await familyFailures(FAMILIES.identityProviders)).toEqual([]);
  });

  it('unchanged: a provider id reads, an unknown one is 404, a caller without root keeps its 403', async () => {
    expect((await send(ROOT, 'GET', `/identity-providers/${PROVIDER_ID}`)).status).toBe(200);
    expect((await send(ROOT, 'GET', `/identity-providers/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await send(USER, 'GET', '/identity-providers/not-a-uuid')).status).toBe(403);
  });
});

describe('credentials: reveal, revoke and rotate', () => {
  it('census: each refuses a non-UUID with 400 INVALID_CREDENTIAL_ID, through REST and the MCP twins', async () => {
    const failures = await familyFailures(FAMILIES.credentials);
    for (const tool of ['relayhall_agent_reveal', 'relayhall_agent_revoke']) {
      const text = await mcpCall(ROOT_BEARER, tool, { credentialId: 'not-a-uuid' });
      if (!text.includes('(HTTP 400) [INVALID_CREDENTIAL_ID]')) failures.push(`MCP ${tool} -> ${text.slice(0, 160)}`);
    }
    expect(failures).toEqual([]);
  });

  it('an unknown id answers 404, and a caller without manage authority is refused 403 on revoke and rotate, never 500', async () => {
    expect((await send(ROOT, 'POST', `/credentials/${crypto.randomUUID()}/revoke`, {})).status).toBe(404);
    expect((await send(ROOT, 'POST', `/credentials/${crypto.randomUUID()}/rotate`, {})).status).toBe(404);
    for (const path of ['/credentials/not-a-uuid/revoke', '/credentials/not-a-uuid/rotate']) {
      expect((await send(USER, 'POST', path, {})).status).toBe(403);
    }
  });
});

describe('notification endpoints: DELETE', () => {
  it('census: DELETE refuses a non-UUID with 400 INVALID_NOTIFICATION_ENDPOINT_ID', async () => {
    expect(await familyFailures(FAMILIES.notificationEndpoints)).toEqual([]);
  });

  it('unchanged: an unknown id answers 404', async () => {
    expect((await send(ROOT, 'DELETE', `/notification-endpoints/${crypto.randomUUID()}`)).status).toBe(404);
  });
});

describe('appearance: a historical asset and a revert Version', () => {
  it('census: a non-UUID asset id and a Version number past int4 are refused with 400', async () => {
    expect(await familyFailures(FAMILIES.appearance)).toEqual([]);
  });

  it('unchanged: an unknown asset is 404, a malformed Version keeps INVALID_VERSION, a caller without root keeps its 403', async () => {
    expect((await send(ROOT, 'GET', `/appearance/asset-versions/${crypto.randomUUID()}`)).status).toBe(404);
    const word = await send(ROOT, 'POST', '/appearance/versions/latest/revert', {});
    expect([word.status, word.code]).toEqual([400, 'INVALID_VERSION']);
    expect((await send(ROOT, 'POST', '/appearance/versions/2147483647/revert', {})).status).toBe(404);
    // A caller without root gets the refusal it gets for any id, whatever its shape.
    const forAny = await send(USER, 'GET', `/appearance/asset-versions/${crypto.randomUUID()}`);
    const forMalformed = await send(USER, 'GET', '/appearance/asset-versions/not-a-uuid');
    expect([forMalformed.status, forMalformed.code]).toEqual([forAny.status, forAny.code]);
    expect([403, 404]).toContain(forMalformed.status);
  });
});

describe('auth sessions: DELETE /auth/sessions/:id', () => {
  it('census: DELETE refuses a non-UUID with 400 INVALID_SESSION_ID', async () => {
    expect(await familyFailures(FAMILIES.authSessions)).toEqual([]);
  });

  it('unchanged: an unknown session is 404, and a caller without a login session keeps its 401', async () => {
    expect((await send(ROOT, 'DELETE', `/auth/sessions/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await send({ label: 'anonymous', principalId: '', headers: {} }, 'DELETE', '/auth/sessions/not-a-uuid')).status).toBe(401);
  });
});

describe('oauth: the consent request', () => {
  it('census: the read and the decision refuse a non-UUID request id with 400 INVALID_AUTHORIZATION_REQUEST_ID', async () => {
    expect(await familyFailures(FAMILIES.oauth)).toEqual([]);
  });

  it('unchanged: an unknown request is 404, and an anonymous caller keeps its 401', async () => {
    expect((await send(CONSENT, 'GET', `/oauth/authorization-requests/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await send({ label: 'anonymous', principalId: '', headers: {} }, 'GET', '/oauth/authorization-requests/not-a-uuid')).status).toBe(401);
  });
});

describe('tasks: every :id, :depTaskId and :leaseId of the Task router', () => {
  it('census: a Task id prefix and a malformed :depTaskId or :leaseId are refused with 400 on every route, through REST and the MCP twins, and nothing is left unanswered', async () => {
    const before = unhandled.length;
    const failures = await familyFailures(FAMILIES.tasks);
    for (const [tool, args, code] of [
      ['relayhall_task_update', { task: TASK_PREFIX, title: 'renamed by prefix' }, 'INVALID_TASK_ID'],
      ['relayhall_brief_compile', { taskId: TASK_PREFIX }, 'INVALID_TASK_ID'],
      ['relayhall_lease_renew', { task: TASK_ID, leaseId: 'not-a-uuid' }, 'INVALID_LEASE_ID'],
      ['relayhall_lease_release', { task: TASK_ID, leaseId: 'not-a-uuid' }, 'INVALID_LEASE_ID'],
    ] as const) {
      const text = await mcpCall(ROOT_BEARER, tool, args);
      if (!text.includes(`(HTTP 400) [${code}]`)) failures.push(`MCP ${tool} ${JSON.stringify(args)} -> ${text.slice(0, 160)}`);
    }
    if (unhandled.length !== before) failures.push(`unhandled rejections: ${unhandled.slice(before).join(', ')}`);
    expect(failures).toEqual([]);
    expect((await pool.query('SELECT title FROM tasks WHERE id = $1', [TASK_ID])).rows[0].title).not.toBe('renamed by prefix');
  });

  it('unchanged: a Task id reads, a non-resolving id is 404 at the point stage, a notification item key still reaches its handler', async () => {
    const read = await send(ROOT, 'GET', `/tasks/${TASK_ID}`);
    expect([read.status, read.json?.task?.id]).toEqual([200, TASK_ID]);
    for (const id of ['not-a-uuid', crypto.randomUUID(), TASK_ID.toUpperCase()]) {
      expect((await send(ROOT, 'GET', `/tasks/${id}`)).status).toBe(404);
    }
    const item = await send(ROOT, 'POST', '/tasks/notifications/feed:9999999999/read', {});
    expect([item.status, item.code]).toEqual([404, 'NOTIFICATION_NOT_FOUND']);
  });
});

describe('services: a descriptor Version number past int4', () => {
  it('census: the read and the retire refuse it with 400 INVALID_QUERY_VALUE', async () => {
    expect(await familyFailures(FAMILIES.services)).toEqual([]);
  });

  it('unchanged: a Version number in range answers as before', async () => {
    const missing = await send(ROOT, 'GET', `/services/${SERVICE_ID}/descriptor/versions/2147483647`);
    expect(missing.status).toBe(404);
    const word = await send(ROOT, 'GET', `/services/${SERVICE_ID}/descriptor/versions/latest`);
    expect([word.status, word.code]).toEqual([400, 'INVALID_QUERY_VALUE']);
  });
});

describe('the account-owner arm of the authorization stage', () => {
  it('census: an Account without the admin scope is refused, never 503, on every admin-action Task, Phase and Report route given a non-UUID id', async () => {
    expect(accountOwnerArmRoutes().map(routeKey).sort()).toEqual([...ACCOUNT_OWNER_ARM_TABLE].sort());
    const failures: string[] = [];
    for (const route of accountOwnerArmRoutes()) {
      const values = route.mount === '/tasks' ? ['not-a-uuid', TASK_PREFIX]
        : route.mount === '/reports' ? ['not-a-uuid', REPORT_PREFIX] : ['not-a-uuid'];
      for (const bad of values) {
        const answer = await send(USER, route.method, concrete(route, { id: bad }), defaultBody(route.method));
        // The refusal this Account gets for any object it may not administer.
        if (![403, 404].includes(answer.status)) failures.push(`${routeKey(route)} :id=${bad} -> ${answer.status} ${answer.code}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

// ═════════════════ the rest of the class: measured, not asserted ═════════════════

describe('every other route with a path parameter', () => {
  it('answers a name-shaped value without a 5xx, on every mounted router', async () => {
    const guarded = new Set<string>();
    for (const family of Object.values(FAMILIES)) {
      const excluded = new Set(Object.keys(family.excluded ?? {}));
      for (const route of familyRoutes(family).filter((candidate) => !excluded.has(routeKey(candidate)))) {
        for (const param of route.params.filter((name) => name in family.refusals)) guarded.add(`${routeKey(route)} :${param}`);
      }
    }
    for (const route of accountOwnerArmRoutes()) guarded.add(`${routeKey(route)} :id`);

    const resolvable: Record<string, string[]> = {
      '/tasks': [TASK_PREFIX], '/reports': [REPORT_PREFIX], '/personalities': [PERSONALITY_SLUG],
      '/services': [SERVICE_SLUG], '/projects': [PROJECT_NAME],
    };
    const real: Record<string, Record<string, string>> = {
      '/projects': { id: PROJECT_ID }, '/tasks': { id: TASK_ID }, '/reports': { id: REPORT_ID },
      '/personalities': { id: PERSONALITY_ID }, '/services': { id: SERVICE_ID },
      '/identity-providers': { id: PROVIDER_ID }, '/groups': { id: GROUP_ID },
    };
    const routers = [
      ...PUBLIC_MOUNTS,
      ...PROTECTED_ROUTE_REGISTRATIONS.map((registration: any) => ({ path: registration.path, router: registration.router })),
    ];
    const failures: string[] = [];
    let probed = 0;
    for (const { path: mount, router } of routers) {
      for (const route of stackRoutes(router, mount)) {
        for (const param of route.params.filter((name) => !guarded.has(`${routeKey(route)} :${name}`))) {
          for (const bad of [...NOT_UUIDS, ...(param === 'id' ? resolvable[mount] ?? [] : [])]) {
            const answer = await send(ROOT, route.method, concrete(route, { ...real[mount], [param]: bad }), defaultBody(route.method));
            probed += 1;
            if (answer.status >= 500 || answer.status < 0) failures.push(`${routeKey(route)} :${param}=${bad} -> ${answer.status} ${answer.code}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
    // Not vacuous: the walk reached the routers it claims to cover.
    expect(probed).toBeGreaterThan(400);
  });
});
