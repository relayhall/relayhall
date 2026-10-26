/**
 * Card 785e1eed P2-B slice 1: AZ-A10 clause 6, the expiry of the grant rows an
 * execution assignment writes, over a REAL PostgreSQL and the PRODUCTION router.
 *
 * Ratified text (AUTHZ amendment AZ-A10, E43), for a Connector or a human
 * assignee: "default `expires_at` = materialization + 3 months. The assigning
 * act may set any later date, or `unlimited` (`expires_at` NULL) ... Three
 * months is the DEFAULT, not a floor: an earlier date is admitted (E43 Q4:
 * "shortenable by the owner")." E62 read "the owner" as "whoever performs the
 * assigning act". D-11 names the controls, every one of which is a test here:
 *
 *   T1-T3  "Controls: the default; a later date; `unlimited`."
 *   C1     "a one-day date set by an admitted assigner (admitted, and the row
 *           expires that day)" - root, at create and on PATCH, plus a short
 *           horizon twin that watches the live predicate stop admitting the
 *           assignee at the instant, through the router, with no SQL edits.
 *   C2     "a one-day date set by any other assigner (admitted or refused, as
 *           answered)" - answered ADMITTED by E62: a Main-shaped Connector that
 *           is not root, not an administrator and not the Task's owning Account
 *           but performs the assigning act, over REST and over MCP.
 *   C3     "A past date can be refused `INVALID_EXPIRY`" - and malformed
 *           values by shape; each writes nothing.
 *
 * and the brief's controls: C4 a non-assigner cannot date anything (the field
 * outside an assignment, principals the act's own gate refuses, and the
 * normalized date sent as a raw body field - review round 1, B1); C5 the
 * terminal reapers are unchanged for dated and unlimited rows, and reopen
 * materializes NEW rows at the default; C6 the audit names the date before and
 * after; C7 clause 6's shared row is the maximum over its live links, NULL
 * dominating, an owner-plane row is never re-dated, and an expired assignment
 * row on the tuple is re-dated rather than linked inert. Every expected
 * instant is read from the database clock, never from a JavaScript clock.
 *
 * DESTRUCTIVE: writes principals, credentials, services, tasks, grants, links
 * and audit rows. It refuses any deployment database and any non-local host,
 * and FAILS - never skips - without a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the assignment-expiry drill measures stored grant, link, '
    + 'audit and task rows, so it never skips. Load database/init.sql into a disposable database, run '
    + 'npm run migrate, and point RELAYHALL_TEST_DB_URL at it.');
}
const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = decodeURIComponent(parsed.pathname.slice(1));
const localDisposable = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  && /test|contract|fixture/.test(TEST_DB_NAME);
const ciService = process.env.CI === 'true' && parsed.hostname === 'postgres' && TEST_DB_NAME === 'relayhall_ci';
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
  || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod'].includes(TEST_DB_NAME)
  || (!localDisposable && !ciService)) {
  throw new Error('Assignment-expiry drill refuses a non-disposable database target');
}

// The production pool reads DB_* at import time, so the environment is pinned
// BEFORE anything is required.
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
const { grantService } = require('../services/GrantService');
const { taskManagerDB } = require('../services/TaskManagerDB');
const { carryAssigningActExpiry, assigningActExpiry, normalizeRoleGrantExpiresAtWrite } = require('../utils/roleGrantExpiry');
const { createPgDueAtResolver } = require('../utils/dueAtResolver');
const { TaskReviewAttemptService, hashReviewReports } = require('../services/TaskReviewAttemptService');
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');

jest.setTimeout(180_000);

// ──────────────────────────────── the app ────────────────────────────────────

let server: http.Server;
let origin: string;

function buildApp(): any {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  // The MCP ingress first and outside the REST funnel, exactly as server.ts
  // mounts it: relayhall_task_create dispatches in-process to POST /tasks.
  app.use(MCP_ROUTE_PATH, mcpRoutes);
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  return app;
}

// ──────────────────────────────── callers ────────────────────────────────────

interface Caller { label: string; principalId: string; headers: Record<string, string> }
interface Connector extends Caller { serviceId: string; credentialId: string; profile: Record<string, unknown> }
interface Answer { status: number; json: any }

async function call(who: Caller, method: string, routePath: string, body?: unknown): Promise<Answer> {
  const extra: Record<string, string> = method === 'POST' || method === 'PATCH'
    ? { 'Idempotency-Key': `p2b-${crypto.randomUUID()}` } : {};
  const response = await fetch(`${origin}${routePath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...who.headers, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json };
}

async function mcpCall(who: Caller, name: string, args: Record<string, unknown> = {}): Promise<Answer> {
  const response = await fetch(`${origin}${MCP_ROUTE_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: who.headers.Authorization,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json };
}
const mcpText = (answer: Answer): string => String(answer.json?.result?.content?.[0]?.text ?? '');
const mcpFailed = (answer: Answer): boolean => Boolean(answer.json?.result?.isError) || Boolean(answer.json?.error);

const tag = (): string => crypto.randomBytes(5).toString('hex');
const parseJson = (value: unknown): any => (typeof value === 'string' ? JSON.parse(value) : value);
const SYSTEM = { handle: 'p2b-drill', authMethod: 'system' };
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

async function makeAccount(role: string, label: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $1, 'active', $2) RETURNING id`,
    [`p2b-${label}-${tag()}`, role],
  );
  return String(result.rows[0].id);
}

async function sessionFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

/** A Connector registered through the owner's wizard path, then published with
 * a one-version descriptor so an executionProfile can target it. */
async function registerConnector(owner: Caller, scopes: string[], transport: 'api' | 'any' = 'api'): Promise<Connector> {
  const slug = `p2b-connector-${tag()}`;
  const registered = await call(owner, 'POST', '/services', {
    slug, name: slug, description: 'Assignment-expiry drill connector.', kind: 'connector',
    issueCredential: { scopes, label: slug, transport },
  });
  expect(registered.status).toBe(201);
  const row = await pool.query('SELECT id, principal_id FROM services WHERE slug = $1', [slug]);
  const serviceId = String(row.rows[0].id);
  await pool.query(
    `INSERT INTO service_descriptor_versions (service_id, version, descriptor, content_hash)
     VALUES ($1, 1, '{"options":[]}'::jsonb, $2)`,
    [serviceId, 'a'.repeat(64)],
  );
  await pool.query(`UPDATE services SET status = 'published', current_descriptor_version = 1 WHERE id = $1`, [serviceId]);
  return {
    label: slug, principalId: String(row.rows[0].principal_id), serviceId,
    credentialId: String(registered.json.onboarding.credential.credentialId),
    headers: { Authorization: `Bearer ${registered.json.onboarding.credential.secretOnce}` },
    profile: { serviceId, descriptorVersion: 1, options: {} },
  };
}

/** An instant `interval` from the DATABASE clock, in the canonical spelling. */
async function dbInstant(interval: string): Promise<string> {
  const row = await pool.query(`SELECT to_char((clock_timestamp() + $1::interval) AT TIME ZONE 'UTC', ${ISO}) AS iso`, [interval]);
  return String(row.rows[0].iso);
}

async function waitPast(instant: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const row = await pool.query('SELECT clock_timestamp() > $1::timestamptz AS past', [instant]);
    if (row.rows[0].past === true) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the database clock never passed ${instant}`);
}

/** Every link of a task, oldest first, with its date in the canonical spelling. */
async function linksOf(taskId: string): Promise<any[]> {
  return (await pool.query(
    `SELECT l.id, l.target_kind, l.target_id, l.created_by_vehicle, l.vehicle_kind,
            l.landed_on_principal_id,
            to_char(l.expires_at AT TIME ZONE 'UTC', ${ISO}) AS expires_iso
       FROM access_vehicle_links l JOIN grants g ON g.id = l.target_id
      WHERE l.task_id = $1 AND l.target_kind = 'grant' AND g.verb = 'read' ORDER BY l.created_at, l.id`,
    [taskId],
  )).rows;
}

/** The read row on (grantee, type, id), with its date and provenance. */
async function rowOn(granteeId: string, resourceType: string, resourceId: string): Promise<any | undefined> {
  return (await pool.query(
    `SELECT id, provenance, to_char(expires_at AT TIME ZONE 'UTC', ${ISO}) AS expires_iso
       FROM grants
      WHERE grantee_type = 'principal' AND grantee_id = $1 AND resource_type = $2 AND resource_id = $3 AND verb = 'read'`,
    [granteeId, resourceType, resourceId],
  )).rows[0];
}

async function audits(action: string, resourceId: string): Promise<any[]> {
  return (await pool.query(
    `SELECT metadata FROM audit_events WHERE action = $1 AND resource_id = $2 ORDER BY occurred_at, id`,
    [action, resourceId],
  )).rows.map((row: any) => parseJson(row.metadata));
}

async function auditCount(): Promise<number> {
  return Number((await pool.query('SELECT COUNT(*)::int AS n FROM audit_events')).rows[0].n);
}

async function readsTask(who: Caller, taskId: string): Promise<number> {
  return (await call(who, 'GET', `/tasks/${taskId}`)).status;
}

// ─────────────────────────────── fixtures ────────────────────────────────────

let ROOT: Caller;            // role admin: derives root - the "admitted assigner"
let OTHER: Caller;           // an ordinary Account that owns the C2 Tasks
let STRANGER: Caller;        // an ordinary Account with no authority over them
let ASSIGNEE_OWNER: Caller;  // the chain-root Account of the assignee Connector
let ASSIGNEE: Connector;     // the Connector the Tasks are assigned to
let ASSIGNEE2_OWNER: Caller;
let ASSIGNEE2: Connector;    // the incoming assignee of a reassignment
let MAIN_ACCOUNT: Caller;    // an ordinary Account (role user): not root, not an administrator
let MAIN: Connector;         // tasks:write + services:invoke: the Main-connector shape (E62's "whoever")
let NO_INVOKE: Connector;    // tasks:write without services:invoke

const FOUR_SCOPES = ['tasks:read', 'tasks:write', 'reports:read', 'reports:write'];
const MAIN_SCOPES = ['tasks:read', 'tasks:write', 'services:invoke'];

beforeAll(async () => {
  await new Promise<void>((resolve) => { server = buildApp().listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  ROOT = await sessionFor('root', await makeAccount('admin', 'root'));
  OTHER = await sessionFor('other', await makeAccount('user', 'other'));
  STRANGER = await sessionFor('stranger', await makeAccount('user', 'stranger'));
  ASSIGNEE_OWNER = await sessionFor('assignee-owner', await makeAccount('user', 'assignee-owner'));
  ASSIGNEE = await registerConnector(ASSIGNEE_OWNER, FOUR_SCOPES);
  ASSIGNEE2_OWNER = await sessionFor('assignee2-owner', await makeAccount('user', 'assignee2-owner'));
  ASSIGNEE2 = await registerConnector(ASSIGNEE2_OWNER, FOUR_SCOPES);
  MAIN_ACCOUNT = await sessionFor('main-account', await makeAccount('user', 'main-account'));
  MAIN = await registerConnector(MAIN_ACCOUNT, MAIN_SCOPES, 'any');
  NO_INVOKE = await registerConnector(MAIN_ACCOUNT, ['tasks:read', 'tasks:write']);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

/** A Task created by `who`, assigned to `assignee` in the same act. */
async function createAssigned(who: Caller, extra: Record<string, unknown> = {}, assignee: Connector = ASSIGNEE): Promise<Answer> {
  return call(who, 'POST', '/tasks', {
    title: `P2-B ${tag()}`, description: 'assignment-expiry drill', status: 'todo',
    executionProfile: assignee.profile, ...extra,
  });
}

/** The created Task's id. An assertion, not a throw: a refused create is a
 * test failure the mutation drill can attribute to an expectation. */
async function createdId(answer: Answer): Promise<string> {
  expect([answer.status, answer.json?.code]).toEqual([201, undefined]);
  return String(answer.json.task.id);
}

async function plainTask(who: Caller, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await call(who, 'POST', '/tasks', { title: `P2-B plain ${tag()}`, description: 'drill', status: 'todo', ...extra });
  return createdId(created);
}

async function titled(title: string): Promise<number> {
  return Number((await pool.query('SELECT COUNT(*)::int AS n FROM tasks WHERE title = $1', [title])).rows[0].n);
}

// ─────────────────────── T1-T3: the base controls ───────────────────────────

describe('D-11 base controls: the default, a later date, unlimited', () => {
  it('T1 DEFAULT: an assignment without the field dates its link and row at materialization + 3 months, computed by PostgreSQL', async () => {
    const created = await createAssigned(ROOT);
    const taskId = await createdId(created);
    const proof = await pool.query(
      `SELECT COUNT(*)::int AS links,
              BOOL_AND(expires_at = ((created_at AT TIME ZONE 'UTC') + INTERVAL '3 months') AT TIME ZONE 'UTC') AS exact,
              to_char(MIN(expires_at) AT TIME ZONE 'UTC', ${ISO}) AS stored
         FROM access_vehicle_links WHERE task_id = $1`,
      [taskId],
    );
    expect(proof.rows[0]).toMatchObject({ links: 2, exact: true });
    const stored = String(proof.rows[0].stored);
    expect((await rowOn(ASSIGNEE.principalId, 'task', taskId))).toMatchObject({ provenance: 'assignment:grant', expires_iso: stored });
    expect(created.json.roleGrantExpiresAt).toBe(stored);
    const [assigned] = await audits('task.execution_assign', taskId);
    expect(assigned.roleGrantExpiresAt).toEqual({ requested: null, applied: stored, source: 'default' });
  });

  it('T2 LATER DATE: one year out is admitted and stored exactly, neither clamped nor refused', async () => {
    const later = await dbInstant('1 year');
    const created = await createAssigned(ROOT, { roleGrantExpiresAt: later });
    const taskId = await createdId(created);
    expect(created.json.roleGrantExpiresAt).toBe(later);
    expect((await linksOf(taskId)).map((link) => link.expires_iso)).toEqual([later]);
    expect((await rowOn(ASSIGNEE.principalId, 'task', taskId)).expires_iso).toBe(later);
  });

  it('T3 UNLIMITED: link and row carry NULL, the receipt says unlimited, and the row is still reaped at completed', async () => {
    const created = await createAssigned(ROOT, { roleGrantExpiresAt: 'unlimited' });
    const taskId = await createdId(created);
    expect(created.json.roleGrantExpiresAt).toBe('unlimited');
    expect((await linksOf(taskId)).map((link) => link.expires_iso)).toEqual([null]);
    const row = await rowOn(ASSIGNEE.principalId, 'task', taskId);
    expect([row.provenance, row.expires_iso]).toEqual(['assignment:grant', null]);
    expect(await readsTask(ASSIGNEE, taskId)).toBe(200);
    const completed = await call(ROOT, 'PATCH', `/tasks/${taskId}`, { status: 'completed' });
    expect(completed.status).toBe(200);
    expect(await linksOf(taskId)).toEqual([]);
    expect(await rowOn(ASSIGNEE.principalId, 'task', taskId)).toBeUndefined();
  });
});

// ───────────────── C1 / C2: D-11's two extra controls (E62) ─────────────────

describe('D-11 extra controls: a one-day date from an admitted assigner and from any other assigner', () => {
  it('C1 root sets a one-day date at create: admitted, the row and its link expire that instant, and the access view shows it', async () => {
    const oneDay = await dbInstant('1 day');
    const created = await createAssigned(ROOT, { roleGrantExpiresAt: oneDay });
    const taskId = await createdId(created);
    expect(created.json.roleGrantExpiresAt).toBe(oneDay);
    const exact = await pool.query(
      `SELECT BOOL_AND(l.expires_at = $2::timestamptz AND g.expires_at = $2::timestamptz) AS exact, COUNT(*)::int AS n
         FROM access_vehicle_links l JOIN grants g ON g.id = l.target_id
        WHERE l.task_id = $1`,
      [taskId, oneDay],
    );
    expect(exact.rows[0]).toEqual({ exact: true, n: 2 });
    const view = await call(ROOT, 'GET', `/tasks/${taskId}/assignment-access`);
    expect(view.status).toBe(200);
    expect(view.json.links.map((link: any) => [link.roleGrantExpiresAt, link.expiresAt, link.expired]))
      .toEqual([[oneDay, oneDay, false], [oneDay, oneDay, false]]);
    expect(await readsTask(ASSIGNEE, taskId)).toBe(200);
  });

  it('C1 root sets the same one-day date on PATCH: admitted and stored', async () => {
    const taskId = await plainTask(ROOT);
    const oneDay = await dbInstant('1 day');
    const patched = await call(ROOT, 'PATCH', `/tasks/${taskId}`, { executionProfile: ASSIGNEE.profile, roleGrantExpiresAt: oneDay });
    expect([patched.status, patched.json?.roleGrantExpiresAt]).toEqual([200, oneDay]);
    expect((await linksOf(taskId)).map((link) => link.expires_iso)).toEqual([oneDay]);
    expect((await rowOn(ASSIGNEE.principalId, 'task', taskId)).expires_iso).toBe(oneDay);
  });

  it('C1 short horizon: the live predicate stops admitting the assignee through the router at the instant, with no SQL edits', async () => {
    const soon = await dbInstant('8 seconds');
    const taskId = await createdId(await createAssigned(ROOT, { roleGrantExpiresAt: soon }));
    expect(await readsTask(ASSIGNEE, taskId)).toBe(200);
    await waitPast(soon);
    expect(await readsTask(ASSIGNEE, taskId)).toBe(404);
    const view = await call(ROOT, 'GET', `/tasks/${taskId}/assignment-access`);
    expect(view.json.links.map((link: any) => [link.expiresAt, link.expired])).toEqual([[soon, true], [soon, true]]);
  });

  it('C2 any other assigner that performs the act (a Main-shaped Connector: not root, not an administrator, not the owning Account) sets the one-day date: admitted', async () => {
    const taskId = await plainTask(OTHER);
    // The assigning act's own gate: tasks:write on the credential, write on
    // the Task through its Account, services:invoke for the profile.
    await grantService.create({ granteeId: MAIN_ACCOUNT.principalId, resourceType: 'task', resourceId: taskId, verb: 'write' }, SYSTEM);
    const role = await pool.query('SELECT role FROM principals WHERE id = $1', [MAIN_ACCOUNT.principalId]);
    expect(role.rows[0].role).toBe('user');
    // The Task's owning Account (the effective account owner) is OTHER, not
    // the assigner's Account.
    const owner = await pool.query(
      `SELECT COALESCE(t.account_owner_principal_id, p.owner_principal_id) AS owner
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = $1`, [taskId]);
    expect(String(owner.rows[0].owner)).toBe(OTHER.principalId);
    const oneDay = await dbInstant('1 day');
    const patched = await call(MAIN, 'PATCH', `/tasks/${taskId}`, { executionProfile: ASSIGNEE.profile, roleGrantExpiresAt: oneDay });
    expect([patched.status, patched.json?.code, patched.json?.roleGrantExpiresAt]).toEqual([200, undefined, oneDay]);
    expect((await linksOf(taskId)).filter((link) => String(link.landed_on_principal_id) === ASSIGNEE.principalId)
      .map((link) => link.expires_iso)).toEqual([oneDay]);
    expect((await rowOn(ASSIGNEE.principalId, 'task', taskId)).expires_iso).toBe(oneDay);
    const [assigned] = await audits('task.execution_assign', taskId);
    expect(assigned.roleGrantExpiresAt).toEqual({ requested: oneDay, applied: oneDay, source: 'assigner' });
  });

  it('C2 through MCP: relayhall_task_create by that Connector carries the one-day date and prints it in the receipt', async () => {
    const brief = await mcpCall(MAIN, 'relayhall_brief_compile', { session: true });
    expect(mcpFailed(brief)).toBe(false);
    const oneDay = await dbInstant('1 day');
    const title = `P2-B mcp ${tag()}`;
    const created = await mcpCall(MAIN, 'relayhall_task_create', {
      idempotencyKey: `p2b-mcp-${crypto.randomUUID()}`, title, executionProfile: ASSIGNEE.profile, roleGrantExpiresAt: oneDay,
    });
    expect([mcpFailed(created), mcpText(created).includes(`assignment grant rows expire: ${oneDay}`)]).toEqual([false, true]);
    const taskId = String((await pool.query('SELECT id FROM tasks WHERE title = $1', [title])).rows[0].id);
    expect((await linksOf(taskId)).filter((link) => String(link.landed_on_principal_id) === ASSIGNEE.principalId)
      .map((link) => link.expires_iso)).toEqual([oneDay]);
  });
});

// ─────────────────────── C3: past and malformed values ──────────────────────

describe('D-11 bullet 5: a past date is refused INVALID_EXPIRY, and a malformed one by shape; each writes nothing', () => {
  it('C3 a past date and a date of now are refused 422 INVALID_EXPIRY naming D-11, and the create writes nothing', async () => {
    for (const interval of ['-1 minute', '0 seconds']) {
      const instant = await dbInstant(interval);
      const title = `P2-B past ${tag()}`;
      const before = await auditCount();
      const refused = await call(ROOT, 'POST', '/tasks', { title, status: 'todo', executionProfile: ASSIGNEE.profile, roleGrantExpiresAt: instant });
      expect([refused.status, refused.json?.code, refused.json?.field, /D-11/.test(String(refused.json?.error))])
        .toEqual([422, 'INVALID_EXPIRY', 'roleGrantExpiresAt', true]);
      expect(await titled(title)).toBe(0);
      expect(await auditCount()).toBe(before);
    }
    const taskId = await plainTask(ROOT);
    const linksBefore = await linksOf(taskId);
    const past = await call(ROOT, 'PATCH', `/tasks/${taskId}`, { executionProfile: ASSIGNEE.profile, roleGrantExpiresAt: await dbInstant('-1 hour') });
    expect([past.status, past.json?.code]).toEqual([422, 'INVALID_EXPIRY']);
    expect(await linksOf(taskId)).toEqual(linksBefore);
    expect((await pool.query('SELECT execution_service_id FROM tasks WHERE id = $1', [taskId])).rows[0].execution_service_id).toBeNull();
  });

  it('C3 malformed values are refused by shape and write nothing', async () => {
    const cases: Array<[unknown, number, string]> = [
      ['2027-01-15', 400, 'INVALID_ROLE_GRANT_EXPIRY'],
      ['next tuesday', 400, 'INVALID_ROLE_GRANT_EXPIRY'],
      [null, 400, 'INVALID_ROLE_GRANT_EXPIRY'],
      ['Unlimited', 400, 'INVALID_ROLE_GRANT_EXPIRY'],
      [['2027-01-15T00:00:00Z'], 400, 'INVALID_ROLE_GRANT_EXPIRY'],
      ['2027-01-15T00:00:00.1234567Z', 400, 'INVALID_ROLE_GRANT_EXPIRY_PRECISION'],
      // The last Sunday of March 2027: Warsaw's clocks move 02:00 -> 03:00.
      [{ local: '2027-03-28T02:30:00', zone: 'Europe/Warsaw' }, 400, 'INVALID_ROLE_GRANT_EXPIRY_LOCAL_TIME'],
      [{ local: '2027-01-15T09:00:00', zone: 'Nowhere/Atlantis' }, 400, 'INVALID_ROLE_GRANT_EXPIRY_ZONE'],
    ];
    for (const [value, status, code] of cases) {
      const title = `P2-B malformed ${tag()}`;
      const refused = await call(ROOT, 'POST', '/tasks', { title, status: 'todo', executionProfile: ASSIGNEE.profile, roleGrantExpiresAt: value });
      expect([JSON.stringify(value), refused.status, refused.json?.code, refused.json?.field ?? refused.json?.details?.field])
        .toEqual([JSON.stringify(value), status, code, 'roleGrantExpiresAt']);
      expect(await titled(title)).toBe(0);
    }
  });

  it('C3 {local, zone} is resolved by PostgreSQL and the receipt names the instant and offset', async () => {
    const created = await createAssigned(ROOT, { roleGrantExpiresAt: { local: '2030-01-15T09:00:00', zone: 'Europe/Warsaw' } });
    const taskId = await createdId(created);
    expect(created.json.roleGrantExpiresAt).toBe('2030-01-15T08:00:00.000000Z');
    expect(created.json.roleGrantExpiryResolution).toMatchObject({
      zone: 'Europe/Warsaw', instant: '2030-01-15T08:00:00.000000Z', offset: '+01:00', chosen: 'postgresql',
    });
    expect((await linksOf(taskId)).map((link) => link.expires_iso)).toEqual(['2030-01-15T08:00:00.000000Z']);
  });
});

// ─────────────────────── C4: no date without the act ────────────────────────

describe('a principal that does not perform the assigning act cannot date anything', () => {
  it('C4(a) roleGrantExpiresAt without an executionProfile is refused ROLE_GRANT_EXPIRY_WITHOUT_ASSIGNMENT, and nothing moves', async () => {
    const taskId = await createdId(await createAssigned(ROOT));
    const links = await linksOf(taskId);
    const row = await rowOn(ASSIGNEE.principalId, 'task', taskId);
    const before = await auditCount();
    const oneDay = await dbInstant('1 day');
    for (const body of [{ roleGrantExpiresAt: oneDay }, { roleGrantExpiresAt: 'unlimited', title: 'renamed' },
      { executionProfile: null, roleGrantExpiresAt: oneDay }]) {
      const refused = await call(ROOT, 'PATCH', `/tasks/${taskId}`, body);
      expect([refused.status, refused.json?.code, refused.json?.field]).toEqual([422, 'ROLE_GRANT_EXPIRY_WITHOUT_ASSIGNMENT', 'roleGrantExpiresAt']);
    }
    const title = `P2-B unassigned ${tag()}`;
    const create = await call(ROOT, 'POST', '/tasks', { title, status: 'todo', roleGrantExpiresAt: oneDay });
    expect([create.status, create.json?.code]).toEqual([422, 'ROLE_GRANT_EXPIRY_WITHOUT_ASSIGNMENT']);
    expect(await titled(title)).toBe(0);
    expect(await linksOf(taskId)).toEqual(links);
    expect(await rowOn(ASSIGNEE.principalId, 'task', taskId)).toEqual(row);
    expect(await auditCount()).toBe(before);
  });

  it('C4(b) principals the assigning act refuses cannot shorten: the assignee itself, a credential without services:invoke, a stranger', async () => {
    const taskId = await plainTask(OTHER);
    await grantService.create({ granteeId: MAIN_ACCOUNT.principalId, resourceType: 'task', resourceId: taskId, verb: 'write' }, SYSTEM);
    const assigned = await call(MAIN, 'PATCH', `/tasks/${taskId}`, { executionProfile: ASSIGNEE.profile });
    expect(assigned.status).toBe(200);
    const links = await linksOf(taskId);
    const row = await rowOn(ASSIGNEE.principalId, 'task', taskId);
    const cursor = String((await pool.query('SELECT clock_timestamp()::text AS t')).rows[0].t);
    const oneDay = await dbInstant('1 day');
    const body = { executionProfile: ASSIGNEE.profile, roleGrantExpiresAt: oneDay };
    const self = await call(ASSIGNEE, 'PATCH', `/tasks/${taskId}`, body);
    const noInvoke = await call(NO_INVOKE, 'PATCH', `/tasks/${taskId}`, body);
    const noInvokeAlone = await call(NO_INVOKE, 'PATCH', `/tasks/${taskId}`, { roleGrantExpiresAt: oneDay });
    const stranger = await call(STRANGER, 'PATCH', `/tasks/${taskId}`, body);
    expect(self.status).toBeGreaterThanOrEqual(400);
    expect([noInvoke.status, noInvoke.json?.code]).toEqual([403, 'PROFILE_INVOKE_REQUIRED']);
    expect([noInvokeAlone.status, noInvokeAlone.json?.code]).toEqual([422, 'ROLE_GRANT_EXPIRY_WITHOUT_ASSIGNMENT']);
    expect(stranger.status).toBeGreaterThanOrEqual(400);
    expect(await linksOf(taskId)).toEqual(links);
    expect(await rowOn(ASSIGNEE.principalId, 'task', taskId)).toEqual(row);
    const written = await pool.query(
      `SELECT action FROM audit_events
        WHERE occurred_at > $1::timestamptz AND outcome = 'success'
          AND action IN ('grant.expiry_change', 'task.execution_assign', 'grant.create', 'grant.revoke')`,
      [cursor]);
    expect(written.rows).toEqual([]);
  });

  // Review round 1, B1: the route once carried the NORMALIZED date as a
  // body-shaped key, so PATCH /tasks/:id read it straight from the request
  // body: any Task writer could re-date, shorten or extend the rows without
  // the assigning act or its services:invoke gate, and an unnormalized value
  // reached SQL as a 500. The date now travels out of band; this sends the
  // old internal shape from both kinds of caller the review used.
  it('C4(c) the date is not a body field: a raw roleGrantExpiry from a writer without services:invoke, or from root beside an ordinary field, moves no link or row, writes no expiry audit and never answers 500', async () => {
    const taskId = await plainTask(OTHER);
    await grantService.create({ granteeId: MAIN_ACCOUNT.principalId, resourceType: 'task', resourceId: taskId, verb: 'write' }, SYSTEM);
    expect((await call(MAIN, 'PATCH', `/tasks/${taskId}`, { executionProfile: ASSIGNEE.profile })).status).toBe(200);
    const links = await linksOf(taskId);
    const row = await rowOn(ASSIGNEE.principalId, 'task', taskId);
    expect([links.length > 0, typeof row?.expires_iso]).toEqual([true, 'string']);
    const cursor = String((await pool.query('SELECT clock_timestamp()::text AS t')).rows[0].t);
    const oneHour = await dbInstant('1 hour');
    // The router's public-key picker independently drops raw body fields.
    // Also exercise the production carriage boundary: lawful normalization
    // survives in memory, while JSON cannot carry or forge that evidence.
    const normalized = await normalizeRoleGrantExpiresAtWrite(oneHour, createPgDueAtResolver(pool));
    expect(normalized).toMatchObject({ kind: 'instant' });
    const lawfulPayload = { title: 'lawful normalized carriage' };
    carryAssigningActExpiry(lawfulPayload, normalized);
    expect(assigningActExpiry(lawfulPayload)).toEqual(normalized);
    expect(assigningActExpiry(JSON.parse(JSON.stringify(lawfulPayload)))).toBeUndefined();
    const raws = [{ kind: 'unlimited' }, { kind: 'instant', instant: oneHour },
      { kind: 'instant', instant: 'garbage' }, { kind: 'instant', instant: 'infinity' }];
    const answers: unknown[] = [];
    for (const raw of raws) {
      expect(assigningActExpiry(JSON.parse(JSON.stringify({ roleGrantExpiry: raw })))).toBeUndefined();
      const writer = await call(NO_INVOKE, 'PATCH', `/tasks/${taskId}`, { roleGrantExpiry: raw });
      const title = `P2-B raw ${tag()}`;
      const root = await call(ROOT, 'PATCH', `/tasks/${taskId}`, { title, roleGrantExpiry: raw });
      // The ordinary field beside it still applies: the key is ignored, not the write.
      answers.push(['writer', writer.status, writer.json?.roleGrantExpiresAt],
        ['root', root.status, root.json?.roleGrantExpiresAt, await titled(title)]);
    }
    expect(answers).toEqual(raws.flatMap(() => [['writer', 200, undefined], ['root', 200, undefined, 1]]));
    expect(await linksOf(taskId)).toEqual(links);
    expect(await rowOn(ASSIGNEE.principalId, 'task', taskId)).toEqual(row);
    const written = await pool.query(
      `SELECT action FROM audit_events
        WHERE occurred_at > $1::timestamptz
          AND action IN ('grant.expiry_change', 'task.execution_assign', 'grant.create', 'grant.revoke')`,
      [cursor]);
    expect(written.rows).toEqual([]);
  });

  it('C4 the field beside executionWarrantId is refused ROLE_GRANT_EXPIRY_WITH_WARRANT, and a terminal task refuses it ROLE_GRANT_EXPIRY_TASK_TERMINAL', async () => {
    const title = `P2-B warrant ${tag()}`;
    const withWarrant = await call(ROOT, 'POST', '/tasks', {
      title, status: 'todo', executionProfile: ASSIGNEE.profile, executionWarrantId: crypto.randomUUID(), roleGrantExpiresAt: 'unlimited',
    });
    expect([withWarrant.status, withWarrant.json?.code]).toEqual([422, 'ROLE_GRANT_EXPIRY_WITH_WARRANT']);
    expect(await titled(title)).toBe(0);
    const taskId = await createdId(await createAssigned(ROOT));
    expect((await call(ROOT, 'PATCH', `/tasks/${taskId}`, { status: 'completed' })).status).toBe(200);
    const terminal = await call(ROOT, 'PATCH', `/tasks/${taskId}`, { executionProfile: ASSIGNEE.profile, roleGrantExpiresAt: 'unlimited' });
    expect([terminal.status, terminal.json?.code]).toEqual([409, 'ROLE_GRANT_EXPIRY_TASK_TERMINAL']);
    expect(await linksOf(taskId)).toEqual([]);
  });
});

// ──────────────── C5: the terminal reapers are unchanged ────────────────────

describe('clause 7: dated and unlimited rows are reaped exactly as before, and never revived', () => {
  it('C5 a shortened row is reaped at completed by PATCH, with grant.revoke', async () => {
    const taskId = await createdId(await createAssigned(ROOT, { roleGrantExpiresAt: await dbInstant('1 day') }));
    const row = await rowOn(ASSIGNEE.principalId, 'task', taskId);
    expect((await call(ROOT, 'PATCH', `/tasks/${taskId}`, { status: 'completed' })).status).toBe(200);
    expect(await linksOf(taskId)).toEqual([]);
    expect(await rowOn(ASSIGNEE.principalId, 'task', taskId)).toBeUndefined();
    expect((await audits('grant.revoke', String(row.id))).map((m) => m.reason)).toEqual(['AZ-S7: the task reached a terminal status']);
  });

  it('C5 an unlimited row is reaped at completed by the verdict writer', async () => {
    const taskId = await createdId(await createAssigned(ROOT, { roleGrantExpiresAt: 'unlimited' }));
    await pool.query(`UPDATE tasks SET status = 'review' WHERE id = $1`, [taskId]);
    const ledger = new TaskReviewAttemptService(pool);
    const attempt = await ledger.beginAttempt(await taskManagerDB.getTask(taskId), { reportDigest: hashReviewReports([]) });
    const verdict = await ledger.recordVerdict(attempt.id, 'pass', [], { summary: 'P2-B drill verdict' }, undefined, false);
    expect(verdict).toMatchObject({ status: 'completed', applied: true });
    expect(await linksOf(taskId)).toEqual([]);
    expect(await rowOn(ASSIGNEE.principalId, 'task', taskId)).toBeUndefined();
  });

  it('C5 archived and delete reap too', async () => {
    const archived = await createdId(await createAssigned(ROOT, { roleGrantExpiresAt: await dbInstant('2 days') }));
    expect((await call(ROOT, 'PATCH', `/tasks/${archived}`, { status: 'archived' })).status).toBe(200);
    expect(await linksOf(archived)).toEqual([]);
    expect(await rowOn(ASSIGNEE.principalId, 'task', archived)).toBeUndefined();
    const deleted = await createdId(await createAssigned(ROOT, { roleGrantExpiresAt: 'unlimited' }));
    const row = await rowOn(ASSIGNEE.principalId, 'task', deleted);
    expect((await call(ROOT, 'DELETE', `/tasks/${deleted}`)).status).toBe(200);
    expect((await pool.query('SELECT id FROM grants WHERE id = $1', [row.id])).rows).toEqual([]);
  });

  it('C5 unassign and reassign reap; the incoming assignee gets its own row at the default', async () => {
    const unassigned = await createdId(await createAssigned(ROOT, { roleGrantExpiresAt: await dbInstant('3 days') }));
    expect((await call(ROOT, 'PATCH', `/tasks/${unassigned}`, { executionProfile: null })).status).toBe(200);
    expect(await linksOf(unassigned)).toEqual([]);
    expect(await rowOn(ASSIGNEE.principalId, 'task', unassigned)).toBeUndefined();
    const moved = await createdId(await createAssigned(ROOT, { roleGrantExpiresAt: await dbInstant('3 days') }));
    expect((await call(ROOT, 'PATCH', `/tasks/${moved}`, { executionProfile: ASSIGNEE2.profile })).status).toBe(200);
    expect(await rowOn(ASSIGNEE.principalId, 'task', moved)).toBeUndefined();
    const incoming = await pool.query(
      `SELECT BOOL_AND(expires_at = ((created_at AT TIME ZONE 'UTC') + INTERVAL '3 months') AT TIME ZONE 'UTC') AS defaulted
         FROM access_vehicle_links WHERE task_id = $1 AND landed_on_principal_id = $2`,
      [moved, ASSIGNEE2.principalId],
    );
    expect(incoming.rows[0].defaulted).toBe(true);
  });

  it('C5 reopen materializes NEW rows at the default; the reaped ids are never revived', async () => {
    const taskId = await createdId(await createAssigned(ROOT, { roleGrantExpiresAt: await dbInstant('1 day') }));
    const firstLinks = (await linksOf(taskId)).map((link) => link.id);
    const firstRow = (await rowOn(ASSIGNEE.principalId, 'task', taskId)).id;
    expect((await call(ROOT, 'PATCH', `/tasks/${taskId}`, { status: 'completed' })).status).toBe(200);
    expect((await call(ROOT, 'PATCH', `/tasks/${taskId}`, { status: 'todo' })).status).toBe(200);
    const reopened = await linksOf(taskId);
    expect(reopened).toHaveLength(1);
    expect(firstLinks).not.toContain(reopened[0].id);
    const row = await rowOn(ASSIGNEE.principalId, 'task', taskId);
    expect(row.id).not.toBe(firstRow);
    const defaulted = await pool.query(
      `SELECT expires_at = ((created_at AT TIME ZONE 'UTC') + INTERVAL '3 months') AT TIME ZONE 'UTC' AS defaulted
         FROM access_vehicle_links WHERE id = $1`, [reopened[0].id]);
    expect(defaulted.rows[0].defaulted).toBe(true);
    expect(row.expires_iso).toBe(reopened[0].expires_iso);
  });
});

// ──────────────────────── C6: the audit names the date ──────────────────────

describe('clause 8: the audit names the date, and every re-date writes before and after', () => {
  it('C6 grant.create names expiresAt and assigneePrincipalId', async () => {
    const oneDay = await dbInstant('1 day');
    const taskId = await createdId(await createAssigned(ROOT, { roleGrantExpiresAt: oneDay }));
    const row = await rowOn(ASSIGNEE.principalId, 'task', taskId);
    const [created] = await audits('grant.create', String(row.id));
    expect(created).toMatchObject({
      automatic: true, taskId, carriedBy: 'role', role: 'implementer', assigneePrincipalId: ASSIGNEE.principalId, expiresAt: oneDay,
      granteeId: ASSIGNEE.principalId,
    });
  });

  it('C6 re-asserting the same assignee with a new date re-dates in place: grant.expiry_change per row with before and after, and task.execution_assign with the link date before', async () => {
    const first = await dbInstant('5 days');
    const taskId = await createdId(await createAssigned(ROOT, { roleGrantExpiresAt: first }));
    const linkIds = (await linksOf(taskId)).map((link) => link.id);
    const row = await rowOn(ASSIGNEE.principalId, 'task', taskId);
    const second = await dbInstant('1 day');
    const patched = await call(ROOT, 'PATCH', `/tasks/${taskId}`, { executionProfile: ASSIGNEE.profile, roleGrantExpiresAt: second });
    expect([patched.status, patched.json?.roleGrantExpiresAt]).toEqual([200, second]);
    const after = await linksOf(taskId);
    expect([after.map((link) => link.id), after.map((link) => link.expires_iso)]).toEqual([linkIds, [second]]);
    const kept = await rowOn(ASSIGNEE.principalId, 'task', taskId);
    expect([kept.id, kept.expires_iso]).toEqual([row.id, second]);
    const changes = await audits('grant.expiry_change', String(row.id));
    expect(changes).toEqual([expect.objectContaining({
      automatic: true, before: first, after: second, taskId, reason: 'AZ-A10 clause 6: the assigning act set a new date',
    })]);
    const assigned = await audits('task.execution_assign', taskId);
    expect(assigned[assigned.length - 1]).toMatchObject({
      reasserted: true, roleGrantExpiresAt: { requested: second, applied: second, source: 'assigner', before: first },
    });
  });
});

describe('AZ-A10 role rows are confined to their holder', () => {
  it('dates a verifier assignment on the roles act and reaps it when the field is cleared', async () => {
    const taskId = await plainTask(ROOT);
    const until = await dbInstant('2 days');
    const assigned = await call(ROOT, 'PATCH', `/tasks/${taskId}/roles`,
      { verifierPrincipalId: ASSIGNEE_OWNER.principalId, roleGrantExpiresAt: until });
    expect(assigned.status).toBe(200);
    const row = await rowOn(ASSIGNEE_OWNER.principalId, 'task', taskId);
    expect(row.expires_iso).toBe(until);
    const link = await pool.query(
      `SELECT role, landed_on_principal_id, to_char(expires_at AT TIME ZONE 'UTC', ${ISO}) AS expires_iso
         FROM access_vehicle_links WHERE task_id = $1 AND target_id = $2`, [taskId, row.id]);
    expect(link.rows).toEqual([expect.objectContaining({
      role: 'verifier', landed_on_principal_id: ASSIGNEE_OWNER.principalId, expires_iso: until,
    })]);
    const dateAlone = await call(ROOT, 'PATCH', `/tasks/${taskId}/roles`,
      { roleGrantExpiresAt: await dbInstant('3 days') });
    expect([dateAlone.status, dateAlone.json?.code]).toEqual([422, 'ROLE_GRANT_EXPIRY_WITHOUT_ASSIGNMENT']);
    expect((await rowOn(ASSIGNEE_OWNER.principalId, 'task', taskId)).expires_iso).toBe(until);
    const cleared = await call(ROOT, 'PATCH', `/tasks/${taskId}/roles`, { verifierPrincipalId: null });
    expect(cleared.status).toBe(200);
    expect(await rowOn(ASSIGNEE_OWNER.principalId, 'task', taskId)).toBeUndefined();
  });

  it('a human verifier reads the foreign task while a sibling Connector under that Account does not inherit the role row', async () => {
    const taskId = await plainTask(OTHER);
    expect(await readsTask(ASSIGNEE, taskId)).toBe(404);
    const assigned = await call(ROOT, 'PATCH', `/tasks/${taskId}/roles`,
      { verifierPrincipalId: ASSIGNEE_OWNER.principalId });
    expect(assigned.status).toBe(200);
    expect(await readsTask(ASSIGNEE_OWNER, taskId)).toBe(200);
    expect(await readsTask(ASSIGNEE, taskId)).toBe(404);
  });
});

// ─────────── C7: clause 6's shared row, and the owner plane untouched ────────

describe('clause 6: a shared row is the latest link date, NULL dominating, and an owner-plane row is never re-dated', () => {
  it('C7 three tasks link one row: a later link raises it, an earlier one never lowers it (the maximum, not the last writer)', async () => {
    const parent = await plainTask(ROOT);
    const early = await dbInstant('10 days');
    const late = await dbInstant('20 days');
    const earliest = await dbInstant('5 days');
    await createdId(await createAssigned(ROOT, { dependsOn: [parent], roleGrantExpiresAt: early }));
    const row = await rowOn(ASSIGNEE.principalId, 'task', parent);
    expect(row.expires_iso).toBe(early);
    await createdId(await createAssigned(ROOT, { dependsOn: [parent], roleGrantExpiresAt: late }));
    expect((await rowOn(ASSIGNEE.principalId, 'task', parent))).toMatchObject({ id: row.id, expires_iso: late });
    const third = await createdId(await createAssigned(ROOT, { dependsOn: [parent], roleGrantExpiresAt: earliest }));
    expect((await rowOn(ASSIGNEE.principalId, 'task', parent))).toMatchObject({ id: row.id, expires_iso: late });
    // The access view tells the two dates apart (review round 1, N1): the
    // link carries the date THIS task's act set, the row the maximum.
    const view = await call(ROOT, 'GET', `/tasks/${third}/assignment-access`);
    expect(view.status).toBe(200);
    expect(view.json.links.filter((link: any) => link.targetId === String(row.id))
      .map((link: any) => [link.roleGrantExpiresAt, link.expiresAt, link.expired])).toEqual([[earliest, late, false]]);
  });

  it('C7 completing the task that holds the latest link recomputes the row over the remaining links, audited before and after', async () => {
    const parent = await plainTask(ROOT);
    const early = await dbInstant('10 days');
    const late = await dbInstant('20 days');
    await createdId(await createAssigned(ROOT, { dependsOn: [parent], roleGrantExpiresAt: early }));
    const row = await rowOn(ASSIGNEE.principalId, 'task', parent);
    const second = await createdId(await createAssigned(ROOT, { dependsOn: [parent], roleGrantExpiresAt: late }));
    expect((await call(ROOT, 'PATCH', `/tasks/${second}`, { status: 'completed' })).status).toBe(200);
    expect((await rowOn(ASSIGNEE.principalId, 'task', parent))).toMatchObject({ id: row.id, expires_iso: early });
    const changes = await audits('grant.expiry_change', String(row.id));
    expect(changes.map((change) => [change.before, change.after, change.taskId])).toEqual([[early, late, second], [late, early, second]]);
  });

  it('C7 an unlimited link makes the row NULL, and the row returns to the remaining date when that task completes', async () => {
    const parent = await plainTask(ROOT);
    const early = await dbInstant('10 days');
    await createdId(await createAssigned(ROOT, { dependsOn: [parent], roleGrantExpiresAt: early }));
    const unlimited = await createdId(await createAssigned(ROOT, { dependsOn: [parent], roleGrantExpiresAt: 'unlimited' }));
    expect((await rowOn(ASSIGNEE.principalId, 'task', parent)).expires_iso).toBeNull();
    expect((await call(ROOT, 'PATCH', `/tasks/${unlimited}`, { status: 'completed' })).status).toBe(200);
    expect((await rowOn(ASSIGNEE.principalId, 'task', parent)).expires_iso).toBe(early);
  });

  it('C7 an owner-plane row linked by an assignment is never re-dated', async () => {
    const parent = await plainTask(ROOT);
    const ownerDate = await dbInstant('50 days');
    const owned = await grantService.create({
      granteeId: ASSIGNEE.principalId, resourceType: 'task', resourceId: parent, verb: 'read', expiresAt: ownerDate,
    }, SYSTEM);
    // The owner plane's own write keeps its own precision; what matters is
    // that the assignment never moves it, so the oracle is the stored value.
    const ownerStored = (await rowOn(ASSIGNEE.principalId, 'task', parent)).expires_iso;
    expect(ownerStored.slice(0, 19)).toBe(ownerDate.slice(0, 19));
    const short = await dbInstant('5 days');
    const taskId = await createdId(await createAssigned(ROOT, { dependsOn: [parent], roleGrantExpiresAt: short }));
    const linked = (await linksOf(taskId)).find((link) => String(link.target_id) === String(owned.id));
    expect([linked?.created_by_vehicle, linked?.expires_iso]).toEqual([false, short]);
    const row = await rowOn(ASSIGNEE.principalId, 'task', parent);
    expect([String(row.id), row.provenance, row.expires_iso]).toEqual([String(owned.id), null, ownerStored]);
    expect(await audits('grant.expiry_change', String(owned.id))).toEqual([]);
    const unlimited = await call(ROOT, 'PATCH', `/tasks/${taskId}`, { executionProfile: ASSIGNEE.profile, roleGrantExpiresAt: 'unlimited' });
    expect(unlimited.status).toBe(200);
    expect((await rowOn(ASSIGNEE.principalId, 'task', parent)).expires_iso).toBe(ownerStored);
    expect(await audits('grant.expiry_change', String(owned.id))).toEqual([]);
  });

  it('C7 an expired assignment row found on the tuple is re-dated by the next assignment, not linked inert', async () => {
    const parent = await plainTask(ROOT);
    const soon = await dbInstant('8 seconds');
    const first = await createdId(await createAssigned(ROOT, { dependsOn: [parent], roleGrantExpiresAt: soon }));
    const row = await rowOn(ASSIGNEE.principalId, 'task', parent);
    expect(row.expires_iso).toBe(soon);
    await waitPast(soon);
    expect(await readsTask(ASSIGNEE, parent)).toBe(404);
    const later = await dbInstant('10 days');
    const second = await createdId(await createAssigned(ROOT, { dependsOn: [parent], roleGrantExpiresAt: later }));
    expect((await rowOn(ASSIGNEE.principalId, 'task', parent))).toMatchObject({ id: row.id, expires_iso: later });
    expect(await readsTask(ASSIGNEE, parent)).toBe(200);
    expect((await audits('grant.expiry_change', String(row.id))).map((change) => [change.before, change.after, change.taskId]))
      .toEqual([[soon, later, second]]);
    expect(first).not.toBe(second);
  });
});

// ───────────────── recovery is an assigning act too (E62) ───────────────────

describe('recovery reassigns, so the recovering shepherd may date it', () => {
  it('R recovery to the same Connector with a new date re-dates in place; an exact retry replays; a different date does not', async () => {
    const taskId = await createdId(await createAssigned(ROOT));
    const linkIds = (await linksOf(taskId)).map((link) => link.id);
    const oneDay = await dbInstant('1 day');
    const recovered = await call(ROOT, 'POST', `/tasks/${taskId}/recover`, { executionProfile: ASSIGNEE.profile, roleGrantExpiresAt: oneDay });
    expect([recovered.status, recovered.json?.recovery?.outcome, recovered.json?.roleGrantExpiresAt]).toEqual([200, 'recovered', oneDay]);
    expect((await linksOf(taskId)).map((link) => [link.id, link.expires_iso])).toEqual(linkIds.map((id) => [id, oneDay]));
    const retried = await call(ROOT, 'POST', `/tasks/${taskId}/recover`, { executionProfile: ASSIGNEE.profile, roleGrantExpiresAt: oneDay });
    expect([retried.status, retried.json?.recovery?.outcome]).toEqual([200, 'replayed']);
    const twoDays = await dbInstant('2 days');
    const moved = await call(ROOT, 'POST', `/tasks/${taskId}/recover`, { executionProfile: ASSIGNEE.profile, roleGrantExpiresAt: twoDays });
    expect([moved.status, moved.json?.recovery?.outcome, moved.json?.roleGrantExpiresAt]).toEqual([200, 'recovered', twoDays]);
    const past = await call(ROOT, 'POST', `/tasks/${taskId}/recover`, { executionProfile: ASSIGNEE.profile, roleGrantExpiresAt: '2001-01-01T00:00:00Z' });
    expect([past.status, past.json?.code]).toEqual([422, 'INVALID_EXPIRY']);
    const malformed = await call(ROOT, 'POST', `/tasks/${taskId}/recover`, { executionProfile: ASSIGNEE.profile, roleGrantExpiresAt: '2030-01-01' });
    expect([malformed.status, malformed.json?.code]).toEqual([400, 'INVALID_ROLE_GRANT_EXPIRY']);
    expect((await linksOf(taskId)).map((link) => link.expires_iso)).toEqual([twoDays]);
  });
});
