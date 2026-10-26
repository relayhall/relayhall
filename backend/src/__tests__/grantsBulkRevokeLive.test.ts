/**
 * grantsBulkRevokeLive.test.ts — owner rulings E407 item 2 (the grant writer
 * stops creating grants the grantee already has), E413 (a safe, session-only,
 * step-up-bound bulk revoke of grants that change nobody's access) and
 * E418(b) (the single grant DELETE takes PATCH's login-session and step-up
 * requirement), over a REAL PostgreSQL and the PRODUCTION router, auth, route
 * ceiling and MCP ingress.
 *
 * Every redundancy decision is the authorization engine's own
 * (`GrantEffectService` over `AuthorizationRepository.authorizedIdsByAction`,
 * whose parity with `authorizedIds` and `selectorCoveredIds` is pinned here
 * too). Access is also read back from OUTSIDE the engine module: through the
 * real REST routes, as the grantee itself.
 *
 * The groups: (W) the writer; (B) the bulk revoke; (D) the single delete;
 * (P) parity. `scripts/grants-bulk-revoke-mutations.py` turns each control red
 * at its declared tests by title, so titles are part of the contract.
 *
 * DESTRUCTIVE: writes principals, credentials, tasks, reports, grants,
 * step-up tokens and audit rows. Disposable database only: a local database
 * whose name contains test, contract or fixture, or the CI job's own
 * `relayhall_ci` service. It FAILS - never skips - without one.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) throw new Error('RELAYHALL_TEST_DB_URL is required: the bulk revoke drill measures stored grants and audit rows, so it never skips');
const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = decodeURIComponent(parsed.pathname.slice(1));
const localDisposable = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) && /test|contract|fixture/.test(TEST_DB_NAME);
const ciService = process.env.CI === 'true' && parsed.hostname === 'postgres' && TEST_DB_NAME === 'relayhall_ci';
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
  || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod'].includes(TEST_DB_NAME)
  || (!localDisposable && !ciService)) {
  throw new Error('The bulk revoke drill refuses a non-disposable database target');
}
Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: TEST_DB_NAME,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
});

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
const { grantService } = require('../services/GrantService');
const { authorizationRepository } = require('../services/AuthorizationRepository');
const { warrantService } = require('../services/WarrantService');
const { accessProfileService } = require('../services/AccessProfileService');
const { rulesCovered, sourcesFromEffectiveAccess } = require('../utils/authorityContainment');
const { AUTHORIZATION_ACTIONS } = require('../services/AuthorizationService');
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');
// Loaded tolerantly so the suite RUNS on a tree without the bulk revoke (the
// red-first proof): each test then fails by its own assertion.
let grantBulkRevokeService: any = { readBack: async () => ({ checks: 0, differences: 0 }) };
let bulkRevokeIdSetHash: (ids: string[]) => string = () => 'absent';
try {
  ({ grantBulkRevokeService, bulkRevokeIdSetHash } = require('../services/GrantBulkRevokeService'));
} catch (e) {
  if ((e as { code?: string })?.code !== 'MODULE_NOT_FOUND') throw e;
}

jest.setTimeout(300_000);

let server: http.Server;
let origin: string;
interface Caller { label: string; principalId: string; headers: Record<string, string> }
interface Answer { status: number; json: any; text: string }

async function call(who: Caller, method: string, path: string, body?: unknown): Promise<Answer> {
  const response = await fetch(origin + path, {
    method, headers: { 'Content-Type': 'application/json', ...who.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, text };
}
async function mcp(who: Caller, method: string, params: Record<string, unknown>): Promise<Answer> {
  const response = await fetch(`${origin}${MCP_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: who.headers.Authorization },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, text };
}

const tag = (): string => crypto.randomBytes(5).toString('hex');
async function account(role: string, label: string): Promise<string> {
  return String((await pool.query(
    "INSERT INTO principals (kind, handle, display_name, status, role) VALUES ('human', $1, $1, 'active', $2) RETURNING id",
    [`e413-${label}-${tag()}`, role])).rows[0].id);
}
async function session(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}
const CONNECTOR_SCOPES = ['tasks:read', 'tasks:write', 'projects:read', 'reports:read', 'reports:write', 'principals:read'];
async function connectorOf(accountId: string, objects: unknown = 'parent'): Promise<Caller> {
  const id = String((await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, $1, 'active', $2, 'E413 drill connector', $3::jsonb) RETURNING id`,
    [`e413-connector-${tag()}`, accountId, JSON.stringify({ scopes: 'parent', objects })])).rows[0].id);
  const issued = await principalService.issueCredential({ principalId: id, scopes: CONNECTOR_SCOPES, label: `e413-${tag()}`, transport: 'any' });
  return { label: 'connector', principalId: id, headers: { Authorization: `Bearer ${issued.fullKey}` } };
}
/** An Account bearer carrying the `root` scope, the shape a pre-096 root key
 * has: no NEW credential may carry root (AZ-18) and no Account may be issued
 * one (A17.1), so a Connector's credential is issued plainly and then moved
 * onto the Account and re-scoped in place. */
async function rootBearerOf(accountId: string): Promise<Caller> {
  const holder = await connectorOf(accountId);
  const credential = (await pool.query('SELECT id FROM principal_credentials WHERE principal_id = $1', [holder.principalId])).rows[0].id;
  await pool.query(`UPDATE principal_credentials SET principal_id = $2, scopes = '["root"]'::jsonb WHERE id = $1`, [credential, accountId]);
  return { label: 'root-bearer', principalId: accountId, headers: holder.headers };
}
async function stepUp(who: Caller, action: string, targetId: string): Promise<string> {
  return (await stepUpService.mint(who.principalId, action, targetId, 'password')).token;
}

/** A Task created through the real route by ROOT, then re-owned in place. */
async function taskOwnedBy(owner: string, fields: Record<string, unknown> = {}): Promise<string> {
  const created = await call(ROOT, 'POST', '/tasks', { title: `E413 task ${tag()}`, status: 'todo' });
  expect(created.status).toBe(201);
  const id = String(created.json.task.id);
  await pool.query(
    `UPDATE tasks SET account_owner_principal_id = $2, creator_principal_id = $3, visibility = 'private', project_id = NULL WHERE id = $1`,
    [id, owner, fields.creator ?? owner]);
  return id;
}
/** A Report created through the real route by ROOT, then re-owned in place. */
async function reportOwnedBy(owner: string, visibility = 'private', author: string = owner): Promise<string> {
  const created = await call(ROOT, 'POST', '/reports', { title: `E413 report ${tag()}`, content: 'body', summary: 'summary' });
  expect([200, 201]).toContain(created.status);
  const id = String(created.json.report?.id ?? created.json.id);
  await pool.query('UPDATE reports SET author_principal_id = $2, account_owner_principal_id = $3, visibility = $4 WHERE id = $1',
    [id, author, owner, visibility]);
  return id;
}
async function grantRow(granteeId: string, resourceType: string, resourceId: string | null, verb: string,
  extra: { provenance?: string; expiresAt?: string; createdAt?: string; granteeType?: string } = {}): Promise<string> {
  return String((await pool.query(
    `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, expires_at, created_at, provenance)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, NOW()), $8) RETURNING id`,
    [extra.granteeType ?? 'principal', granteeId, resourceType, resourceId, verb, extra.expiresAt ?? null, extra.createdAt ?? null,
      extra.provenance ?? null])).rows[0].id);
}
const exists = async (id: string): Promise<boolean> => (await pool.query('SELECT 1 FROM grants WHERE id = $1', [id])).rows.length === 1;
async function auditRows(where: string, params: unknown[]): Promise<any[]> {
  return (await pool.query(`SELECT * FROM audit_events WHERE ${where} ORDER BY occurred_at, id`, params)).rows;
}

/** E407 item 2's writer, in a transaction of its own: whether a row was written. Rolled back unless `keep`. */
async function writer(granteeId: string, resourceType: 'task' | 'report' | 'project', resourceId: string, verb: 'read' | 'write',
  keep = false): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const written = await grantService.createUnlessHeld(client, { granteeId, resourceType, resourceId, verb },
      { principalId: ROOT.principalId, handle: 'e413-root', authMethod: 'session' });
    await client.query(keep ? 'COMMIT' : 'ROLLBACK');
    return written !== null;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function bulk(who: Caller, body: Record<string, unknown>): Promise<Answer> {
  return call(who, 'POST', '/grants/bulk-revoke', body);
}
async function realRun(who: Caller, ids: string[]): Promise<Answer> {
  return bulk(who, { ids, dryRun: false, stepUpToken: await stepUp(who, 'grant.bulk_revoke', bulkRevokeIdSetHash(ids)) });
}
const verdicts = (answer: Answer): Record<string, string> =>
  Object.fromEntries((answer.json?.results ?? []).map((r: any) => [r.id, r.verdict]));

let ROOT: Caller;          // role admin, a login session: derives root
let USER_A: Caller;        // role user
let USER_B: Caller;        // role user, the other Account
let CONNECTOR_A: Caller;   // USER_A's Connector, own() = parent
let ROOT_CONNECTOR: Caller;// ROOT's Connector
let ROOT_BEARER: Caller;   // an Account bearer carrying root
/** An administrator Account that creates nothing: it holds the grants the
 * administrator arm makes redundant, so no creation grant can collide with them. */
let ADMIN: string;

beforeAll(async () => {
  await pool.query("INSERT INTO principals(kind,handle,display_name,role) VALUES('human','dashboard_user','Owner','orchestrator') ON CONFLICT(handle) DO NOTHING");
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(MCP_ROUTE_PATH, mcpRoutes);
  registerProtectedRoutes((mount: string, ...handlers: any[]) => app.use(mount, authMiddleware, sharedAuthorizationMiddleware, ...handlers));
  app.use(apiErrorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  ROOT = await session('root', await account('admin', 'root'));
  USER_A = await session('user-a', await account('user', 'a'));
  USER_B = await session('user-b', await account('user', 'b'));
  CONNECTOR_A = await connectorOf(USER_A.principalId);
  ROOT_CONNECTOR = await connectorOf(ROOT.principalId);
  ROOT_BEARER = await rootBearerOf(await account('admin', 'root-key'));
  ADMIN = await account('admin', 'holder');
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ── (W) the writer, E407 item 2 ─────────────────────────────────────────────
export const W_ADMIN = 'W admin: no grant is written for an administrator on a private Report of another Account';
export const W_TYPE_WIDE = 'W type-wide: no exact Task grant is written for a holder of the type-wide grant';
export const W_OWNER = 'W owner: the owning Account keeps its grant, its only source for the warrant ceiling it may set on the Task';
export const W_CONNECTOR = "W Connector: a Connector keeps its grant, its only source for the assignment cap (R3) it is checked against";
export const W_OPERATOR = 'W operator: an operator keeps its grant, because no root session lets its warrants past the ceiling check';
export const W_ADDS = 'W adds access: the grant is written when it adds access, and the grantee then reads through the router';
export const W_DESCENDANT = 'W descendants: a read grant is written for a Task initiator, whose Connectors would gain it';
export const W_ROUTES = ("W through the routes: an administrator's creations write no creator or sponsor grant, its Connector's "
  + 'write only the Connector pair, and access is unchanged');

/** The rule a non-escalation reader checks for one exact grant. */
const exactRule = (resourceType: string, id: string, verb: string) =>
  ({ resourceType, selectorForm: 'exact', selectorIds: [id], verbs: [verb] });

describe('(W) the writer writes a grant only when it changes access or what its holder may delegate (E407 item 2)', () => {
  test(W_ADMIN, async () => {
    const report = await reportOwnedBy(USER_B.principalId);
    expect(await writer(ADMIN, 'report', report, 'read')).toBe(false);
    expect(await writer(ADMIN, 'report', report, 'write')).toBe(false);
  });
  test(W_TYPE_WIDE, async () => {
    const holder = await account('user', 'wide');
    await grantRow(holder, 'task', null, 'write');
    await grantRow(holder, 'task', null, 'read');
    const task = await taskOwnedBy(USER_B.principalId);
    expect(await writer(holder, 'task', task, 'read')).toBe(false);
    expect(await writer(holder, 'task', task, 'write')).toBe(false);
  });
  test(W_OWNER, async () => {
    // The engine already admits the owner; the warrant ceiling check reads
    // grants and profiles only, so the row is what lets the owner set a
    // ceiling on its own Task (WarrantService.ceilingContainmentProblem).
    const task = await taskOwnedBy(USER_A.principalId, { creator: USER_B.principalId });
    expect((await call(USER_A, 'GET', `/tasks/${task}`)).status).toBe(200);
    expect(await warrantService.ceilingContainmentProblem(USER_A.principalId, [], [exactRule('task', task, 'read')], null)).not.toBeNull();
    expect(await writer(USER_A.principalId, 'task', task, 'read', true)).toBe(true);
    expect(await warrantService.ceilingContainmentProblem(USER_A.principalId, [], [exactRule('task', task, 'read')], null)).toBeNull();
  });
  test(W_CONNECTOR, async () => {
    // The Connector reaches its Account's Task through the Account, and its own
    // grant adds no access; the assignment cap reads the Connector's own
    // grants and profiles (AccessVehicleService R3), so the row is kept.
    const owned = await taskOwnedBy(USER_A.principalId);
    expect((await call(CONNECTOR_A, 'GET', `/tasks/${owned}`)).status).toBe(200);
    const inventory = async () => rulesCovered(sourcesFromEffectiveAccess(await accessProfileService.effectiveAccess(CONNECTOR_A.principalId)),
      [exactRule('task', owned, 'write')]).covered;
    expect(await inventory()).toBe(false);
    expect(await writer(CONNECTOR_A.principalId, 'task', owned, 'write', true)).toBe(true);
    expect(await inventory()).toBe(true);
  });
  test(W_OPERATOR, async () => {
    // An operator is admitted by the engine's administrator arm, but its
    // session never carries root, so its warrant ceilings are checked against
    // its grants: the row is kept.
    const operator = await account('operator', 'operator');
    const report = await reportOwnedBy(USER_B.principalId);
    expect(await writer(operator, 'report', report, 'read')).toBe(true);
  });
  test(W_ADDS, async () => {
    const task = await taskOwnedBy(USER_B.principalId);
    expect((await call(USER_A, 'GET', `/tasks/${task}`)).status).toBe(404);
    expect(await writer(USER_A.principalId, 'task', task, 'read', true)).toBe(true);
    expect((await call(USER_A, 'GET', `/tasks/${task}`)).status).toBe(200);
    expect((await call(CONNECTOR_A, 'GET', `/tasks/${task}`)).status).toBe(200);
    const rows = await pool.query("SELECT verb FROM grants WHERE grantee_id = $1 AND resource_type = 'task' AND resource_id = $2", [USER_A.principalId, task]);
    expect(rows.rows.map((r: any) => r.verb)).toEqual(['read']);
  });
  test(W_DESCENDANT, async () => {
    const task = await taskOwnedBy(USER_B.principalId, { creator: USER_A.principalId });
    // The initiator reads it; its Connector does not.
    expect((await call(USER_A, 'GET', `/tasks/${task}`)).status).toBe(200);
    expect((await call(CONNECTOR_A, 'GET', `/tasks/${task}`)).status).toBe(404);
    expect(await writer(USER_A.principalId, 'task', task, 'read')).toBe(true);
  });
  test(W_ROUTES, async () => {
    const before = Number((await pool.query('SELECT count(*)::int AS n FROM grants')).rows[0].n);
    const own = await call(ROOT, 'POST', '/tasks', { title: `E413 own ${tag()}`, status: 'todo' });
    expect(own.status).toBe(201);
    const viaConnector = await call(ROOT_CONNECTOR, 'POST', '/tasks', { title: `E413 connector ${tag()}`, status: 'todo' });
    expect(viaConnector.status).toBe(201);
    const report = await call(ROOT_CONNECTOR, 'POST', '/reports', { title: `E413 report ${tag()}`, content: 'body', summary: 'summary' });
    expect([200, 201]).toContain(report.status);
    const reportId = String(report.json.report?.id ?? report.json.id);
    const ownId = String(own.json.task.id);
    const connectorTask = String(viaConnector.json.task.id);
    // Rows another act writes, such as an assignment's provenance rows, are not this writer's.
    const written = await pool.query(
      `SELECT grantee_id::text AS grantee, resource_id::text AS resource, verb, provenance FROM grants
        WHERE resource_id = ANY($1::uuid[]) ORDER BY resource_id, verb`, [[ownId, connectorTask, reportId]]);
    const policyRows = written.rows.filter((row: any) => !row.provenance).map((row: any) => [row.grantee, row.resource, row.verb]);
    expect(policyRows.sort()).toEqual([
      [ROOT_CONNECTOR.principalId, connectorTask, 'read'], [ROOT_CONNECTOR.principalId, connectorTask, 'write'],
      [ROOT_CONNECTOR.principalId, reportId, 'read'], [ROOT_CONNECTOR.principalId, reportId, 'write'],
    ].sort());
    expect(Number((await pool.query('SELECT count(*)::int AS n FROM grants')).rows[0].n) - before).toBe(written.rows.length);
    // The policy audit rows still record every act, and say which wrote no row.
    const policy = await auditRows("action IN ('task.creator_access','task.sponsor_access','report.creator_access','report.sponsor_access') AND resource_id = ANY($1::text[])",
      [[ownId, connectorTask, reportId]]);
    expect(policy.length).toBe(10);
    expect(policy.filter((row: any) => row.metadata.alreadyHeld === true && row.metadata.grantId === null)
      .map((row: any) => row.metadata.granteePrincipalId)).toEqual(Array(6).fill(ROOT.principalId));
    // Access is what it was: the administrator and its Connector read and write all three.
    for (const id of [ownId, connectorTask]) {
      for (const who of [ROOT, ROOT_CONNECTOR]) {
        expect((await call(who, 'GET', `/tasks/${id}`)).status).toBe(200);
        expect((await call(who, 'PATCH', `/tasks/${id}`, { description: `touched ${tag()}` })).status).toBe(200);
      }
    }
    expect((await call(ROOT_CONNECTOR, 'GET', `/reports/${reportId}`)).status).toBe(200);
  });
});

// ── (B) the bulk revoke, E413 ───────────────────────────────────────────────
export const B_REFUSED = 'B refusals: a root Account bearer is refused SESSION_ONLY and audited; a root Connector, a non-root session and MCP are refused, and nothing is written';
export const B_DRY = 'B the dry run answers a verdict per id and writes nothing';
export const B_CAP = 'B more than 500 ids are refused by name; exactly 500 are admitted';
export const B_INPUT = 'B a duplicate or malformed id and an unknown field are refused by name';
export const B_NO_STEP_UP = 'B a real run without a step-up is refused STEP_UP_REQUIRED, audited, and removes nothing';
export const B_REUSED = 'B a real run with a spent step-up is refused and removes nothing';
export const B_OTHER_SET = 'B a step-up bound to another id set or another act is refused and removes nothing';
export const B_REAL = 'B the real run removes only the ids still redundant, each through the revoke path, with one summary row';
export const B_RECHECK = 'B a grant that became effective after the dry run is skipped by the live re-check';
export const B_JOINT = 'B the dry run takes the same read-back: an injected difference answers wouldRollBack and writes nothing';
export const B_HOOK = 'B an injected read-back difference rolls the whole batch back';
export const B_ASSIGNMENT = 'B assignment grants are refused and plugin grants are unevaluable, in the dry run and the real run';

describe('(B) the bulk revoke (E413)', () => {
  test(B_REFUSED, async () => {
    const report = await reportOwnedBy(USER_B.principalId);
    const id = await grantRow(ADMIN, 'report', report, 'read');
    const body = { ids: [id], dryRun: false, stepUpToken: 'rhsu_nothing' };
    const bearer = await bulk(ROOT_BEARER, body);
    expect([bearer.status, bearer.json?.code]).toEqual([403, 'SESSION_ONLY']);
    const denied = await auditRows("action = 'grant.bulk_revoke' AND outcome = 'denied' AND actor_principal_id = $1", [ROOT_BEARER.principalId]);
    expect(denied.map((row: any) => row.metadata.refusal)).toContain('SESSION_ONLY');
    const connector = await bulk(ROOT_CONNECTOR, body);
    expect(connector.status).toBe(403);
    const nonRoot = await bulk(USER_A, body);
    expect(nonRoot.status).toBe(403);
    // Over MCP: no tool reaches it, and the ingress refuses a bearer on it.
    const tools = await mcp(CONNECTOR_A, 'tools/list', {});
    const names: string[] = (tools.json?.result?.tools ?? []).map((tool: any) => String(tool.name));
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => /grant_(revoke|remove|delete)|bulk_revoke/.test(name))).toEqual([]);
    expect(JSON.stringify(tools.json)).not.toContain('bulk-revoke');
    expect(await exists(id)).toBe(true);
  });

  test(B_DRY, async () => {
    const privateReport = await reportOwnedBy(USER_B.principalId);
    const redundant = await grantRow(ADMIN, 'report', privateReport, 'write');
    const effective = await grantRow(USER_A.principalId, 'report', privateReport, 'read');
    const assignment = await grantRow(USER_A.principalId, 'task', await taskOwnedBy(USER_B.principalId), 'write', { provenance: 'assignment:grant' });
    const expired = await grantRow(USER_A.principalId, 'report', await reportOwnedBy(USER_B.principalId), 'read',
      { createdAt: new Date(Date.now() - 7200_000).toISOString(), expiresAt: new Date(Date.now() - 3600_000).toISOString() });
    const plugin = await grantRow(USER_A.principalId, 'plugin', null, 'use');
    const missing = crypto.randomUUID();
    const counts = async () => (await pool.query(
      'SELECT (SELECT count(*) FROM grants)::int AS g, (SELECT count(*) FROM audit_events)::int AS a, (SELECT count(*) FROM feed_events)::int AS f, (SELECT count(*) FROM step_up_tokens)::int AS s')).rows[0];
    const before = await counts();
    const ids = [redundant, effective, assignment, expired, plugin, missing];
    const answer = await bulk(ROOT, { ids });
    expect(answer.status).toBe(200);
    expect(answer.json.dryRun).toBe(true);
    expect(verdicts(answer)).toEqual({
      [redundant]: 'redundant', [effective]: 'effective', [assignment]: 'assignment',
      [expired]: 'expired', [plugin]: 'unevaluable', [missing]: 'missing',
    });
    expect(answer.json.removed).toBe(0);
    expect(answer.json.rolledBack).toBe(false);
    expect(answer.json.wouldRollBack).toBe(false);
    expect(answer.json.idSetHash).toBe(bulkRevokeIdSetHash(ids));
    expect(answer.json.redundantIdSetHash).toBe(bulkRevokeIdSetHash([redundant]));
    expect(answer.json.skipped).toEqual({ redundant: 1, effective: 1, unevaluable: 1, assignment: 1, missing: 1, expired: 1 });
    expect(answer.json.readBack.checks).toBeGreaterThan(0);
    expect(await counts()).toEqual(before);
    for (const id of [redundant, effective, assignment, expired, plugin]) expect(await exists(id)).toBe(true);
  });

  test(B_CAP, async () => {
    const ids = Array.from({ length: 501 }, () => crypto.randomUUID());
    const over = await bulk(ROOT, { ids });
    expect([over.status, over.json?.code]).toEqual([400, 'BULK_REVOKE_TOO_MANY']);
    const at = await bulk(ROOT, { ids: ids.slice(0, 500) });
    expect(at.status).toBe(200);
    expect(at.json.skipped.missing).toBe(500);
  });

  test(B_INPUT, async () => {
    const id = crypto.randomUUID();
    expect((await bulk(ROOT, { ids: [id, id.toUpperCase()] })).json?.code).toBe('BULK_REVOKE_DUPLICATE_ID');
    expect((await bulk(ROOT, { ids: ['not-a-uuid'] })).json?.code).toBe('INVALID_GRANT_ID');
    expect((await bulk(ROOT, { ids: [] })).json?.code).toBe('BULK_REVOKE_IDS_REQUIRED');
    expect((await bulk(ROOT, { ids: [id], dryRun: 'no' })).json?.code).toBe('INVALID_FIELD');
    expect((await bulk(ROOT, { ids: [id], extra: true })).json?.code).toBe('UNKNOWN_FIELD');
  });

  test(B_NO_STEP_UP, async () => {
    const id = await grantRow(ADMIN, 'report', await reportOwnedBy(USER_B.principalId), 'read');
    const answer = await bulk(ROOT, { ids: [id], dryRun: false });
    expect([answer.status, answer.json?.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    expect(answer.json.stepUp).toMatchObject({ action: 'grant.bulk_revoke', targetId: bulkRevokeIdSetHash([id]) });
    const denied = await auditRows("action = 'grant.bulk_revoke' AND outcome = 'denied' AND actor_principal_id = $1 AND metadata->>'refusal' = 'STEP_UP_REQUIRED'", [ROOT.principalId]);
    expect(denied.length).toBeGreaterThan(0);
    expect(await exists(id)).toBe(true);
  });

  test(B_REUSED, async () => {
    const first = await grantRow(ADMIN, 'report', await reportOwnedBy(USER_B.principalId), 'read');
    const token = await stepUp(ROOT, 'grant.bulk_revoke', bulkRevokeIdSetHash([first]));
    const used = await bulk(ROOT, { ids: [first], dryRun: false, stepUpToken: token });
    expect([used.status, used.json?.removed]).toEqual([200, 1]);
    // The same id set again (a fresh row would need a fresh id: re-insert the tuple's twin).
    const again = await bulk(ROOT, { ids: [first], dryRun: false, stepUpToken: token });
    expect([again.status, again.json?.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    const summaries = await auditRows("action = 'grant.bulk_revoke' AND outcome = 'success' AND metadata->>'idSetHash' = $1", [bulkRevokeIdSetHash([first])]);
    expect(summaries.length).toBe(1);
  });

  test(B_OTHER_SET, async () => {
    const report = await reportOwnedBy(USER_B.principalId);
    const one = await grantRow(ADMIN, 'report', report, 'read');
    const two = await grantRow(ADMIN, 'report', report, 'write');
    const boundToOne = await stepUp(ROOT, 'grant.bulk_revoke', bulkRevokeIdSetHash([one]));
    const wrongSet = await bulk(ROOT, { ids: [one, two], dryRun: false, stepUpToken: boundToOne });
    expect([wrongSet.status, wrongSet.json?.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    const wrongAct = await bulk(ROOT, { ids: [one, two], dryRun: false, stepUpToken: await stepUp(ROOT, 'grant.revoke', bulkRevokeIdSetHash([one, two])) });
    expect([wrongAct.status, wrongAct.json?.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    expect([await exists(one), await exists(two)]).toEqual([true, true]);
    // The refused calls spent nothing: the token bound to [one] still works for [one].
    expect((await bulk(ROOT, { ids: [one], dryRun: false, stepUpToken: boundToOne })).json?.removed).toBe(1);
  });

  test(B_REAL, async () => {
    const privateReport = await reportOwnedBy(USER_B.principalId);
    const ownedTask = await taskOwnedBy(USER_A.principalId);
    const adminHeld = await grantRow(ADMIN, 'report', privateReport, 'read');
    // A holder of the type-wide write grant: its exact row adds no access and no delegation source.
    const wide = await account('user', 'wide-real');
    await grantRow(wide, 'task', null, 'write');
    const wideHeld = await grantRow(wide, 'task', ownedTask, 'write');
    const effective = await grantRow(USER_A.principalId, 'report', privateReport, 'read');
    const assignment = await grantRow(USER_B.principalId, 'task', ownedTask, 'read', { provenance: 'assignment:grant' });
    const ids = [adminHeld, wideHeld, effective, assignment];
    const dry = await bulk(ROOT, { ids });
    expect(verdicts(dry)).toEqual({ [adminHeld]: 'redundant', [wideHeld]: 'redundant', [effective]: 'effective', [assignment]: 'assignment' });
    const readable = async () => [
      (await call(USER_A, 'GET', `/tasks/${ownedTask}`)).status, (await call(CONNECTOR_A, 'PATCH', `/tasks/${ownedTask}`, { description: tag() })).status,
      (await call(USER_A, 'GET', `/reports/${privateReport}`)).status, (await call(ROOT, 'GET', `/reports/${privateReport}`)).status,
    ];
    const accessBefore = await readable();
    expect(accessBefore).toEqual([200, 200, 200, 200]);
    const answer = await realRun(ROOT, ids);
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({ dryRun: false, removed: 2, rolledBack: false });
    expect(answer.json.skipped).toEqual({ redundant: 0, effective: 1, unevaluable: 0, assignment: 1, missing: 0, expired: 0 });
    expect(answer.json.readBack.principals).toBe(2);
    expect(answer.json.readBack.checks).toBeGreaterThan(0);
    expect(answer.json.readBack.differences).toBe(0);
    expect([await exists(adminHeld), await exists(wideHeld), await exists(effective), await exists(assignment)]).toEqual([false, false, true, true]);
    expect(await readable()).toEqual(accessBefore);
    // One grant.revoke row per removed grant, each naming this batch.
    const revokes = await auditRows("action = 'grant.revoke' AND outcome = 'success' AND resource_id = ANY($1::text[])", [[adminHeld, wideHeld]]);
    expect(revokes.map((row: any) => row.resource_id).sort()).toEqual([adminHeld, wideHeld].sort());
    expect(revokes.every((row: any) => row.metadata.bulkRevoke?.idSetHash === bulkRevokeIdSetHash(ids))).toBe(true);
    const feed = await pool.query("SELECT object_id::text FROM feed_events WHERE name IN ('report.acl_changed','task.acl_changed') AND object_id = ANY($1::uuid[])", [[privateReport, ownedTask]]);
    expect(feed.rows.length).toBeGreaterThanOrEqual(2);
    // ONE summary row: counts, the id-set hash, the actor, and no secret.
    const summary = await auditRows("action = 'grant.bulk_revoke' AND outcome = 'success' AND metadata->>'idSetHash' = $1", [bulkRevokeIdSetHash(ids)]);
    expect(summary.length).toBe(1);
    expect(summary[0].actor_principal_id).toBe(ROOT.principalId);
    expect(summary[0].metadata).toMatchObject({ requested: 4, removed: 2, rolledBack: false });
    expect(JSON.stringify(summary[0].metadata)).not.toMatch(/rhsu_|rh_(live|dev|test)_/);
  });

  test(B_RECHECK, async () => {
    const task = await taskOwnedBy(USER_B.principalId);
    const holder = await account('user', 'recheck');
    const holderSession = await session('recheck', holder);
    const wildcard = await grantRow(holder, 'task', null, 'read');
    const stillRedundant = await grantRow(ADMIN, 'task', task, 'read');
    const becomesEffective = await grantRow(holder, 'task', task, 'read');
    const ids = [stillRedundant, becomesEffective];
    expect(verdicts(await bulk(ROOT, { ids }))).toEqual({ [stillRedundant]: 'redundant', [becomesEffective]: 'redundant' });
    // Between the dry run and the real run the holder's type-wide grant is
    // revoked: the exact row is now its only way to read the Task.
    await pool.query('DELETE FROM grants WHERE id = $1', [wildcard]);
    const answer = await realRun(ROOT, ids);
    expect(answer.status).toBe(200);
    expect(verdicts(answer)).toEqual({ [stillRedundant]: 'redundant', [becomesEffective]: 'effective' });
    expect(answer.json).toMatchObject({ removed: 1, rolledBack: false });
    expect([await exists(stillRedundant), await exists(becomesEffective)]).toEqual([false, true]);
    expect((await call(holderSession, 'GET', `/tasks/${task}`)).status).toBe(200);
  });

  test(B_JOINT, async () => {
    // A read-back difference cannot arise from grants alone once the
    // delegation question is asked (a holder's other source that contains a
    // row also admits it), so it is injected at the read-back seam.
    const report = await reportOwnedBy(USER_B.principalId);
    const ids = [await grantRow(ADMIN, 'report', report, 'read'), await grantRow(ADMIN, 'report', report, 'write')];
    const clean = await bulk(ROOT, { ids });
    expect(clean.json).toMatchObject({ dryRun: true, wouldRollBack: false, removed: 0 });
    expect(clean.json.readBack.differences).toBe(0);
    const spy = jest.spyOn(grantBulkRevokeService, 'readBack').mockResolvedValueOnce({ checks: 1, differences: 1 });
    try {
      const dry = await bulk(ROOT, { ids });
      expect(dry.status).toBe(200);
      expect(dry.json).toMatchObject({ dryRun: true, wouldRollBack: true, rolledBack: false, removed: 0 });
      expect(dry.json.readBack.differences).toBe(1);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect([await exists(ids[0]), await exists(ids[1])]).toEqual([true, true]);
  });

  test(B_HOOK, async () => {
    const report = await reportOwnedBy(USER_B.principalId);
    const ids = [await grantRow(ADMIN, 'report', report, 'read'), await grantRow(ADMIN, 'report', report, 'write')];
    const spy = jest.spyOn(grantBulkRevokeService, 'readBack').mockResolvedValueOnce({ checks: 1, differences: 1 });
    try {
      const answer = await realRun(ROOT, ids);
      expect(answer.status).toBe(200);
      expect(answer.json).toMatchObject({ removed: 0, rolledBack: true });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect([await exists(ids[0]), await exists(ids[1])]).toEqual([true, true]);
    expect((await auditRows("action = 'grant.revoke' AND resource_id = ANY($1::text[])", [ids])).length).toBe(0);
    const summary = await auditRows("action = 'grant.bulk_revoke' AND outcome = 'success' AND metadata->>'idSetHash' = $1", [bulkRevokeIdSetHash(ids)]);
    expect(summary.map((row: any) => [row.metadata.rolledBack, row.metadata.removed])).toEqual([[true, 0]]);
    // The step-up is spent although the batch rolled back.
    const spent = await pool.query("SELECT consumed_at FROM step_up_tokens WHERE action = 'grant.bulk_revoke' AND target_id = $1", [bulkRevokeIdSetHash(ids)]);
    expect(spent.rows.length).toBe(1);
    expect(spent.rows.every((row: any) => row.consumed_at !== null)).toBe(true);
  });

  test(B_ASSIGNMENT, async () => {
    const task = await taskOwnedBy(USER_A.principalId);
    const assignment = await grantRow(USER_A.principalId, 'task', task, 'read', { provenance: 'assignment:grant' });
    const plugin = await grantRow(USER_B.principalId, 'plugin', null, 'invoke');
    const ids = [assignment, plugin];
    expect(verdicts(await bulk(ROOT, { ids }))).toEqual({ [assignment]: 'assignment', [plugin]: 'unevaluable' });
    const answer = await realRun(ROOT, ids);
    expect(answer.status).toBe(200);
    expect(verdicts(answer)).toEqual({ [assignment]: 'assignment', [plugin]: 'unevaluable' });
    expect(answer.json.removed).toBe(0);
    expect([await exists(assignment), await exists(plugin)]).toEqual([true, true]);
  });
});

// ── (D) the single delete, E418(b) ──────────────────────────────────────────
export const D_BEARER = 'D a root Account bearer and a root Connector are refused by name and the bearer refusal is audited as denied';
export const D_STEP_UP = 'D a session without a step-up, or with one bound to another act or grant, is refused STEP_UP_REQUIRED and audited';
export const D_ALLOWED = 'D a step-up bound to (grant.revoke, id) revokes the grant once and the token is spent';

describe('(D) the single grant DELETE takes the session and step-up of PATCH (E418(b))', () => {
  test(D_BEARER, async () => {
    const id = await grantRow(USER_A.principalId, 'report', await reportOwnedBy(USER_B.principalId), 'read');
    const bearer = await call(ROOT_BEARER, 'DELETE', `/grants/${id}`, { stepUpToken: 'rhsu_nothing' });
    expect([bearer.status, bearer.json?.code]).toEqual([403, 'SESSION_ONLY']);
    const denied = await auditRows("action = 'grant.revoke' AND outcome = 'denied' AND resource_id = $1", [id]);
    expect(denied.map((row: any) => row.metadata.refusal)).toEqual(['SESSION_ONLY']);
    expect((await call(ROOT_CONNECTOR, 'DELETE', `/grants/${id}`)).status).toBe(403);
    expect(await exists(id)).toBe(true);
  });
  test(D_STEP_UP, async () => {
    const id = await grantRow(USER_A.principalId, 'report', await reportOwnedBy(USER_B.principalId), 'read');
    const other = await grantRow(USER_A.principalId, 'report', await reportOwnedBy(USER_B.principalId), 'write');
    const none = await call(ROOT, 'DELETE', `/grants/${id}`);
    expect([none.status, none.json?.code, none.json?.stepUp?.action, none.json?.stepUp?.targetId]).toEqual([403, 'STEP_UP_REQUIRED', 'grant.revoke', id]);
    const wrongAct = await call(ROOT, 'DELETE', `/grants/${id}`, { stepUpToken: await stepUp(ROOT, 'grant.edit', id) });
    expect([wrongAct.status, wrongAct.json?.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    const wrongGrant = await call(ROOT, 'DELETE', `/grants/${id}`, { stepUpToken: await stepUp(ROOT, 'grant.revoke', other) });
    expect([wrongGrant.status, wrongGrant.json?.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    const denied = await auditRows("action = 'grant.revoke' AND outcome = 'denied' AND resource_id = $1", [id]);
    expect(denied.map((row: any) => row.metadata.refusal)).toEqual(['STEP_UP_REQUIRED', 'STEP_UP_REQUIRED', 'STEP_UP_REQUIRED']);
    expect([await exists(id), await exists(other)]).toEqual([true, true]);
  });
  test(D_ALLOWED, async () => {
    const id = await grantRow(USER_A.principalId, 'report', await reportOwnedBy(USER_B.principalId), 'read');
    const token = await stepUp(ROOT, 'grant.revoke', id);
    const done = await call(ROOT, 'DELETE', `/grants/${id}`, { stepUpToken: token });
    expect([done.status, done.json?.grant?.id]).toEqual([200, id]);
    expect(await exists(id)).toBe(false);
    const revoked = await auditRows("action = 'grant.revoke' AND outcome = 'success' AND resource_id = $1", [id]);
    expect(revoked.length).toBe(1);
    expect(revoked[0].metadata.stepUp?.method).toBe('password');
    const replay = await call(ROOT, 'DELETE', `/grants/${id}`, { stepUpToken: token });
    expect([replay.status, replay.json?.code]).toEqual([403, 'STEP_UP_REQUIRED']);
  });
});

// ── (P) parity of the one-statement form with the engine's own reads ────────
export const P_PARITY = 'P authorizedIdsByAction equals authorizedIds and selectorCoveredIds for every action and identity';

describe('(P) parity', () => {
  test(P_PARITY, async () => {
    const tasks = [await taskOwnedBy(USER_A.principalId), await taskOwnedBy(USER_B.principalId), await taskOwnedBy(USER_B.principalId, { creator: USER_A.principalId })];
    const reports = [await reportOwnedBy(USER_B.principalId), await reportOwnedBy(USER_B.principalId, 'default'), await reportOwnedBy(USER_B.principalId, 'private', USER_A.principalId)];
    await grantRow(USER_A.principalId, 'task', tasks[1], 'write');
    const services = (await pool.query('SELECT id::text FROM services LIMIT 5')).rows.map((r: any) => r.id);
    const actors = [
      { principalId: ROOT.principalId, handle: 'root', role: 'admin', scopes: [], authenticated: true, delegation: null },
      { principalId: USER_A.principalId, handle: 'a', role: 'user', scopes: [], authenticated: true, delegation: null },
      { principalId: CONNECTOR_A.principalId, handle: 'c', role: null, scopes: [], authenticated: true,
        delegation: { links: (await (require('../services/DelegationService').delegationService).resolveChain(CONNECTOR_A.principalId)).links } },
    ];
    let compared = 0;
    for (const actor of actors) {
      for (const [type, ids] of [['task', tasks], ['report', reports], ['service', services]] as Array<[string, string[]]>) {
        const many = await authorizationRepository.authorizedIdsByAction(actor, type, ids, AUTHORIZATION_ACTIONS);
        const selector = await authorizationRepository.authorizedIdsByAction(actor, type, ids, AUTHORIZATION_ACTIONS, pool, { selector: true });
        for (const action of AUTHORIZATION_ACTIONS) {
          expect([...many.get(action)].sort()).toEqual([...(await authorizationRepository.authorizedIds(actor, type, ids, action))].sort());
          expect([...selector.get(action)].sort()).toEqual([...(await authorizationRepository.selectorCoveredIds(actor, type, ids, action))].sort());
          compared += 2;
        }
      }
    }
    expect(compared).toBe(3 * 3 * AUTHORIZATION_ACTIONS.length * 2);
  });
});
