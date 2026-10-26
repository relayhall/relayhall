/**
 * Card 7c77fcf3: the INTERNAL keys of a Task's execution assignment are never
 * request fields.
 *
 * `executionServiceId` (tasks.execution_service_id, the assignment field of
 * record) and `executionDescriptorVersion` (tasks.execution_descriptor_version,
 * the descriptor pin) have ONE writer on a request path:
 * `resolveExecutionProfileWrite` in routes/tasks.ts, which derives both from an
 * `executionProfile` it validated against the Connector's pinned capability
 * descriptor, after the `services:invoke` gate. PATCH /tasks/:id spread the
 * request body into that pipeline, and the pipeline returns the payload
 * untouched when no executionProfile is present, so a raw key reached
 * TaskManagerDB.updateTask as if the pipeline had produced it. A caller holding
 * plain Task write and NOT services:invoke could reassign a Task to another
 * Connector, which swapped the access vehicle so that Connector's Account could
 * read the Task, or pin a descriptor version the Connector never published. No
 * invoke check, no descriptor validation and no Warrant rule ran for either.
 *
 * Proven over a REAL PostgreSQL, the PRODUCTION router and the MCP ingress
 * mounted the way server.ts mounts it. ONE describe per key, so a mutation that
 * stops refusing one key reddens that key's block and no other:
 *
 *   (i)   PATCH by a plain Task writer with the raw key: 400 SERVER_WRITTEN_FIELD
 *         naming the key, and the assignment, descriptor pin, profile, Warrant
 *         pointer, profile mirror, vehicle links, vehicle grant rows, assignment
 *         epoch, the in-flight native execution and the audit/feed counts are
 *         all UNCHANGED; the other Connector's Account still cannot read the Task;
 *   (ii)  PATCH by an invoke holder with a lawful executionProfile AND the raw
 *         key: the same refusal, nothing changed;
 *   (iii) POST /tasks with the raw key: 400 SERVER_WRITTEN_FIELD, no Task row;
 *   (iv)  MCP relayhall_task_create with the raw key: refused as an unknown
 *         argument by the tool's own allowlist, no Task row;
 *   (v)   MCP relayhall_task_update with the raw key: refused as an unknown
 *         argument by the tool's own allowlist, nothing changed;
 *   (vi)  POST /tasks/:id/recover with a lawful executionProfile AND a raw key
 *         that names a DIFFERENT value: 200, and the Task carries the PROFILE's
 *         assignment. The route reads named fields only, so the key is provably
 *         ignored with no effect; it is not refused there, because the route
 *         never reads it and its pinned contract (idempotencyContract) sends both
 *         keys in a recovery body;
 *   (vii) MCP relayhall_task_recover with the raw key: refused as an unknown
 *         argument, nothing changed.
 *
 * Plus both keys in one body, and the LAWFUL path unchanged: a plain writer's
 * executionProfile is 403 PROFILE_INVOKE_REQUIRED on PATCH and on POST; the
 * invoke holder's is 200 with exactly the assignment, pin, vehicle and epoch the
 * profile names; executionProfile null by a plain writer unassigns; a Warrant id
 * without a profile is 422 WARRANT_WITHOUT_ASSIGNMENT.
 *
 * AGAINST THE ROUTE BEFORE THIS CARD (the red proof): (i) with a non-null
 * value answers 200 and moves the assignment or the pin, the vehicle grant to
 * the other Connector's Account, the epoch and the in-flight run, which is the
 * defect; (i) with null answers 500, because the profile mirror's CHECK
 * refuses one null half, and both keys null in one body answers 200 and
 * unassigns the Task while leaving its profile behind; (ii), (iii) and (iv)
 * fail on the refusal contract only (the profile overwrote the key, or the
 * create's named field list dropped it); (v), (vi), (vii) and the lawful block
 * pass there too, because those surfaces never reached the keys.
 *
 * Card 69943b61 (owner ruling E100, option (a)) adds one block. Dropping the
 * Warrant that carries a Task's execution assignment (`executionWarrantId:
 * null` with no executionProfile) re-carries the assignment on an auto-grant,
 * so it requires services:invoke, like every other execution reassignment:
 *
 *   (1) a plain Task writer is refused 403 WARRANT_DROP_INVOKE_REQUIRED naming
 *       the field, with one denied audit row; the Task row, the Warrant's
 *       vehicle and every row above are unchanged, and so they are when the
 *       same body also archives the Task;
 *   (2) a holder of services:invoke still swaps the Warrant for an auto-grant;
 *   (3) on a Task no Warrant carries, the null changes nothing, as before;
 *   (4) switching to another Warrant stays gated: 422 WARRANT_WITHOUT_ASSIGNMENT
 *       without a profile, 403 PROFILE_INVOKE_REQUIRED with one, and the
 *       invoke holder switches;
 *   (5) the assigning act's date still reaches the write beside a drop (the
 *       785e1eed out-of-band carrier);
 *   (6) MCP relayhall_task_update cannot carry the field at all.
 *
 * AGAINST THE ROUTE BEFORE CARD 69943b61 (the red proof): (1) answers 200 and
 * the Warrant's vehicle is replaced by an auto-grant under the writer's
 * authority, which is the defect; (2) to (6) pass there too.
 *
 * DESTRUCTIVE: writes principals, credentials, services, descriptor versions,
 * tasks, grants, native execution rows and audit rows. It refuses any
 * deployment database and any non-local host, and FAILS - never skips - without
 * a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the raw execution key drill measures stored task, vehicle, '
    + 'grant and epoch rows, so it never skips. Load database/init.sql into a disposable database, run '
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
  throw new Error('Raw execution key drill refuses a non-disposable database target');
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
const { principalService } = require('../services/PrincipalService');
const { warrantService } = require('../services/WarrantService');
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
  // mounts it: the task tools dispatch in-process to the same /tasks routes the
  // REST callers below reach.
  app.use(MCP_ROUTE_PATH, mcpRoutes);
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  return app;
}

// ──────────────────────────────── callers ────────────────────────────────────

interface Caller { label: string; principalId: string; headers: Record<string, string> }
interface Answer { status: number; json: any }

async function call(who: Caller, method: string, routePath: string, body?: unknown): Promise<Answer> {
  const response = await fetch(`${origin}${routePath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...who.headers },
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
const hex64 = (): string => crypto.randomBytes(32).toString('hex');

async function makeAccount(role: string, label: string): Promise<Caller> {
  const row = (await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $1, 'active', $2) RETURNING id`,
    [`rawkeys-${label}-${tag()}`, role],
  )).rows[0];
  const minted = await loginSessionService.mint({ principalId: row.id });
  return { label, principalId: String(row.id), headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

/** A delegated service principal under `parent`, inheriting the parent's
 * object authority, with its own bearer credential. */
async function delegatedService(parent: Caller, label: string, scopes: string[]): Promise<Caller> {
  const principalId = String((await pool.query(
    `INSERT INTO principals (kind, handle, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, 'active', $2, 'Raw execution key drill', $3) RETURNING id`,
    [`rawkeys-${label}-${tag()}`, parent.principalId, JSON.stringify({ scopes: 'parent', objects: 'parent' })],
  )).rows[0].id);
  const issued = await principalService.issueCredential(
    { principalId, scopes, transport: 'any' },
    { handle: 'rawkeys-drill', authMethod: 'system' },
  );
  return { label, principalId, headers: { Authorization: `Bearer ${issued.fullKey}` } };
}

interface Connector { serviceId: string; principalId: string; account: Caller; caller: Caller }

/** A published Connector owned by `account`, with live descriptor versions. */
async function publishedConnector(account: Caller, versions: number[]): Promise<Connector> {
  const principal = await delegatedService(account, 'connector', ['tasks:read', 'tasks:write']);
  const serviceId = crypto.randomUUID();
  const slug = `rawkeys-connector-${tag()}`;
  await pool.query(
    `INSERT INTO services (id, slug, name, kind, status, principal_id, current_descriptor_version)
     VALUES ($1, $2, $2, 'connector', 'published', $3, $4)`,
    [serviceId, slug, principal.principalId, Math.max(...versions)],
  );
  for (const version of versions) {
    await pool.query(
      `INSERT INTO service_descriptor_versions (service_id, version, descriptor, content_hash)
       VALUES ($1, $2, '{"options":[]}'::jsonb, $3)`,
      [serviceId, version, hex64()],
    );
  }
  return { serviceId, principalId: principal.principalId, account, caller: principal };
}

const profileOf = (connector: Connector, version: number) =>
  ({ serviceId: connector.serviceId, descriptorVersion: version, options: {} });

// ─────────────────────────────── fixtures ────────────────────────────────────

let OWNER: Caller;   // Account role user: creates the Tasks, holds services:invoke (the lawful assigner)
let WRITER: Caller;  // a service under OWNER: tasks:read + tasks:write, NOT services:invoke
let A: Connector;    // the Connector every fixture Task is lawfully assigned to (descriptor v1 only)
let A_SIBLING: Connector; // another Connector under A's Account; it must not inherit A's role grant
let B: Connector;    // another Account's Connector (descriptor v1 and v2); its Account cannot read the Tasks

type Snapshot = Record<string, unknown>;

/** Every row the execution assignment owns or moves. */
async function snapshot(taskId: string): Promise<Snapshot> {
  const one = async (sql: string) => (await pool.query(sql, [taskId])).rows;
  return {
    task: (await one(`SELECT execution_service_id, execution_descriptor_version, execution_profile, execution_warrant_id
                        FROM tasks WHERE id = $1`))[0],
    mirror: await one(`SELECT service_id, descriptor_version, options, legacy_profile, revision
                         FROM task_execution_profiles WHERE task_id = $1`),
    links: await one(`SELECT id, assignee_principal_id, landed_on_principal_id, vehicle_kind, role, warrant_id, target_kind,
                             target_id, created_by_vehicle
                        FROM access_vehicle_links WHERE task_id = $1 ORDER BY id`),
    vehicleGrants: await one(`SELECT id, grantee_id, verb, provenance FROM grants
                               WHERE resource_type = 'task' AND resource_id::text = $1 AND provenance IS NOT NULL
                               ORDER BY id`),
    epoch: (await one('SELECT epoch::text AS epoch FROM task_native_assignment_epochs WHERE task_id = $1'))[0]?.epoch,
    executions: await one('SELECT id, state FROM task_native_executions WHERE task_id = $1 ORDER BY id'),
    assignmentAudit: (await one(`SELECT COUNT(*)::int AS n FROM audit_events
                                  WHERE (resource_id::text = $1 AND action LIKE 'task.execution%')
                                     OR metadata->>'taskId' = $1`))[0].n,
    feed: (await one('SELECT COUNT(*)::int AS n FROM feed_events WHERE object_id = $1'))[0].n,
  };
}

async function readStatus(who: Caller, taskId: string): Promise<number> {
  return (await call(who, 'GET', `/tasks/${taskId}`)).status;
}

async function taskRowsTitled(title: string): Promise<any[]> {
  return (await pool.query(
    'SELECT id, execution_service_id, execution_descriptor_version FROM tasks WHERE title = $1', [title],
  )).rows;
}

interface Fixture { taskId: string; before: Snapshot }

/** A Task lawfully assigned to Connector A at v1 through PATCH executionProfile
 * by the invoke holder, with an in-flight native execution of A. */
async function assignedTask(label: string): Promise<Fixture> {
  const created = await call(OWNER, 'POST', '/tasks', {
    title: `rawkeys ${label} ${tag()}`, description: 'raw execution key drill', status: 'todo',
  });
  expect(created.status).toBe(201);
  const taskId = String(created.json.task.id);
  const assigned = await call(OWNER, 'PATCH', `/tasks/${taskId}`, { executionProfile: profileOf(A, 1) });
  expect(assigned.status).toBe(200);
  // Adversarial fixture written directly: a run of the assigned Connector in
  // flight, so an assignment change would show as ownership_lost.
  const epoch = (await pool.query('SELECT epoch FROM task_native_assignment_epochs WHERE task_id = $1', [taskId])).rows[0].epoch;
  await pool.query(
    `INSERT INTO task_native_executions (task_id, assignment_epoch, actor_principal_id, connector_id, account_id,
       service_id, descriptor_version, source_product, dispatch_key, request_digest, run_ordinal, state, lease_hash,
       lease_expires_at, hard_deadline)
     VALUES ($1, $2, $3, $3, $4, $5, 1, 'rawkeys-drill', gen_random_uuid(), $6, 1, 'running', $7,
       NOW() + interval '1 hour', NOW() + interval '2 hours')`,
    [taskId, epoch, A.principalId, A.account.principalId, A.serviceId, hex64(), hex64()],
  );
  const before = await snapshot(taskId);
  // The fixture is what it claims to be: assigned to A at v1 by its profile,
  // carried by AZ-A10 implementer role grants on A itself, one run in flight;
  // neither A's Account nor B's identity inherits the role grant.
  expect(before.task).toEqual({
    execution_service_id: A.serviceId, execution_descriptor_version: 1,
    execution_profile: profileOf(A, 1), execution_warrant_id: null,
  });
  expect((before.links as any[]).length).toBeGreaterThan(0);
  expect((before.links as any[]).every((link) => link.vehicle_kind === 'role'
    && link.role === 'implementer' && link.assignee_principal_id === A.principalId
    && link.landed_on_principal_id === A.principalId && link.target_kind === 'grant'
    && link.warrant_id === null)).toBe(true);
  expect((before.vehicleGrants as any[]).length).toBeGreaterThan(0);
  expect((before.vehicleGrants as any[]).map((grant) => grant.verb).sort()).toEqual(['read', 'write']);
  expect((before.vehicleGrants as any[]).every((grant) => grant.grantee_id === A.principalId
    && grant.provenance === 'assignment:grant')).toBe(true);
  expect((before.executions as any[]).map((row) => row.state)).toEqual(['running']);
  expect(await readStatus(WRITER, taskId)).toBe(200);
  expect(await readStatus(A.caller, taskId)).toBe(200);
  expect(await readStatus(A.account, taskId)).toBe(404);
  expect(await readStatus(A_SIBLING.caller, taskId)).toBe(404);
  expect(await readStatus(B.account, taskId)).toBe(404);
  expect(await readStatus(B.caller, taskId)).toBe(404);
  return { taskId, before };
}

beforeAll(async () => {
  await new Promise<void>((resolve) => { server = buildApp().listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  OWNER = await makeAccount('user', 'owner');
  WRITER = await delegatedService(OWNER, 'writer', ['tasks:read', 'tasks:write']);
  A = await publishedConnector(await makeAccount('user', 'account-a'), [1]);
  A_SIBLING = await publishedConnector(A.account, [1]);
  B = await publishedConnector(await makeAccount('user', 'account-b'), [1, 2]);
  const brief = await mcpCall(WRITER, 'relayhall_brief_compile', { session: true });
  expect(mcpFailed(brief)).toBe(false);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ─────────────────────────────── the drill ───────────────────────────────────

type InternalKey = 'executionServiceId' | 'executionDescriptorVersion';

/** The raw value a caller would send: `other` reassigns (another Connector) or
 * re-pins (a version Connector A never published); `null` unassigns or unpins. */
function rawValue(key: InternalKey, which: 'other' | 'null'): unknown {
  if (which === 'null') return null;
  return key === 'executionServiceId' ? B.serviceId : 2;
}

/** A value that DIFFERS from what the recovery profile (B at v2) names, so an
 * honoured key would be visible in the result. */
function recoveryDecoy(key: InternalKey): unknown {
  return key === 'executionServiceId' ? A.serviceId : 1;
}

describe.each(['executionServiceId', 'executionDescriptorVersion'] as InternalKey[])('internal key %s', (key) => {
  test.each(['other', 'null'] as const)(
    `(i) PATCH /tasks/:id by a plain Task writer carrying ${key} = %s is refused SERVER_WRITTEN_FIELD and changes nothing`,
    async (which) => {
      const f = await assignedTask(`i-${key}-${which}`);
      const answer = await call(WRITER, 'PATCH', `/tasks/${f.taskId}`, { [key]: rawValue(key, which) });
      expect({
        status: answer.status, code: answer.json?.code, field: answer.json?.details?.field,
        state: await snapshot(f.taskId), otherAccountReads: await readStatus(B.account, f.taskId),
      }).toEqual({
        status: 400, code: 'SERVER_WRITTEN_FIELD', field: key, state: f.before, otherAccountReads: 404,
      });
    },
  );

  test(`(ii) PATCH /tasks/:id by the invoke holder with a lawful executionProfile AND ${key} is refused and changes nothing`, async () => {
    const f = await assignedTask(`ii-${key}`);
    const answer = await call(OWNER, 'PATCH', `/tasks/${f.taskId}`,
      { executionProfile: profileOf(A, 1), [key]: rawValue(key, 'other') });
    expect({
      status: answer.status, code: answer.json?.code, field: answer.json?.details?.field, state: await snapshot(f.taskId),
    }).toEqual({ status: 400, code: 'SERVER_WRITTEN_FIELD', field: key, state: f.before });
  });

  test(`(iii) POST /tasks carrying ${key} is refused SERVER_WRITTEN_FIELD and writes no Task`, async () => {
    const title = `rawkeys iii ${key} ${tag()}`;
    const answer = await call(WRITER, 'POST', '/tasks', { title, [key]: rawValue(key, 'other') });
    expect({
      status: answer.status, code: answer.json?.code, field: answer.json?.details?.field, rows: await taskRowsTitled(title),
    }).toEqual({ status: 400, code: 'SERVER_WRITTEN_FIELD', field: key, rows: [] });
  });

  test(`(iv) MCP relayhall_task_create carrying ${key} refuses the unknown argument and writes no Task`, async () => {
    const title = `rawkeys iv ${key} ${tag()}`;
    const answer = await mcpCall(WRITER, 'relayhall_task_create',
      { title, idempotencyKey: crypto.randomUUID(), [key]: rawValue(key, 'other') });
    const text = mcpText(answer);
    expect({
      failed: mcpFailed(answer), refusal: text.includes(`Unknown arguments: ${key}.`), namesKey: text.includes(key),
      rows: await taskRowsTitled(title),
    }).toEqual({ failed: true, refusal: true, namesKey: true, rows: [] });
  });

  test(`(v) MCP relayhall_task_update carrying ${key} is refused by the tool allowlist and changes nothing`, async () => {
    const f = await assignedTask(`v-${key}`);
    const answer = await mcpCall(WRITER, 'relayhall_task_update', { task: f.taskId, [key]: rawValue(key, 'other') });
    const text = mcpText(answer);
    expect({
      failed: mcpFailed(answer), unknown: text.includes('Unknown arguments') && text.includes(key), state: await snapshot(f.taskId),
    }).toEqual({ failed: true, unknown: true, state: f.before });
  });

  test(`(vi) POST /tasks/:id/recover ignores ${key}: the Task carries the PROFILE's assignment, never the raw value`, async () => {
    const f = await assignedTask(`vi-${key}`);
    const answer = await call(OWNER, 'POST', `/tasks/${f.taskId}/recover`, {
      executionProfile: profileOf(B, 2), [key]: recoveryDecoy(key), reason: 'raw execution key drill',
    });
    expect([answer.status, answer.json?.recovery?.outcome]).toEqual([200, 'recovered']);
    expect((await snapshot(f.taskId)).task).toEqual({
      execution_service_id: B.serviceId, execution_descriptor_version: 2,
      execution_profile: profileOf(B, 2), execution_warrant_id: null,
    });
  });

  test(`(vii) MCP relayhall_task_recover carrying ${key} is refused by the tool allowlist and changes nothing`, async () => {
    const f = await assignedTask(`vii-${key}`);
    const answer = await mcpCall(WRITER, 'relayhall_task_recover',
      { task: f.taskId, executionProfile: profileOf(B, 2), [key]: rawValue(key, 'other') });
    const text = mcpText(answer);
    expect({
      failed: mcpFailed(answer), unknown: text.includes('Unknown arguments') && text.includes(key), state: await snapshot(f.taskId),
    }).toEqual({ failed: true, unknown: true, state: f.before });
  });
});

describe('both internal keys in one body', () => {
  const BOTH = ['executionServiceId', 'executionDescriptorVersion'];

  test.each(['other', 'null'] as const)('PATCH /tasks/:id by a plain Task writer carrying both keys = %s is refused and changes nothing', async (which) => {
    const f = await assignedTask(`both-${which}`);
    const body = which === 'null'
      ? { executionServiceId: null, executionDescriptorVersion: null }
      : { executionServiceId: B.serviceId, executionDescriptorVersion: 2 };
    const answer = await call(WRITER, 'PATCH', `/tasks/${f.taskId}`, body);
    expect({
      status: answer.status, code: answer.json?.code, namesAKey: BOTH.includes(answer.json?.details?.field),
      state: await snapshot(f.taskId), otherAccountReads: await readStatus(B.account, f.taskId),
    }).toEqual({ status: 400, code: 'SERVER_WRITTEN_FIELD', namesAKey: true, state: f.before, otherAccountReads: 404 });
  });
});

describe('the lawful path is unchanged', () => {
  test('a plain Task writer\'s executionProfile is 403 PROFILE_INVOKE_REQUIRED on PATCH and changes nothing', async () => {
    const f = await assignedTask('lawful-writer-patch');
    const answer = await call(WRITER, 'PATCH', `/tasks/${f.taskId}`, { executionProfile: profileOf(B, 2) });
    expect({ status: answer.status, code: answer.json?.code, state: await snapshot(f.taskId) })
      .toEqual({ status: 403, code: 'PROFILE_INVOKE_REQUIRED', state: f.before });
  });

  test('a plain Task writer\'s executionProfile is 403 PROFILE_INVOKE_REQUIRED on POST and writes no Task', async () => {
    const title = `rawkeys lawful-writer-post ${tag()}`;
    const answer = await call(WRITER, 'POST', '/tasks', { title, executionProfile: profileOf(B, 2) });
    expect({ status: answer.status, code: answer.json?.code, rows: await taskRowsTitled(title) })
      .toEqual({ status: 403, code: 'PROFILE_INVOKE_REQUIRED', rows: [] });
  });

  test('the plain Task writer edits an ordinary field: the refusals above are not authority refusals', async () => {
    const f = await assignedTask('lawful-writer-field');
    const answer = await call(WRITER, 'PATCH', `/tasks/${f.taskId}`, { description: 'edited by the plain writer' });
    expect(answer.status).toBe(200);
    expect((await snapshot(f.taskId)).task).toEqual(f.before.task);
  });

  test('the implementer role grant remains subject to the Connector\'s delegated own() cap', async () => {
    const f = await assignedTask('role-grant-own-cap');
    await pool.query(`UPDATE principals SET own_expression = '{"scopes":"parent","objects":[]}'::jsonb WHERE id = $1`,
      [A.principalId]);
    try {
      expect(await readStatus(A.caller, f.taskId)).toBe(404);
      expect(await readStatus(A.account, f.taskId)).toBe(404);
      expect(await snapshot(f.taskId)).toEqual(f.before);
    } finally {
      await pool.query(`UPDATE principals SET own_expression = '{"scopes":"parent","objects":"parent"}'::jsonb WHERE id = $1`,
        [A.principalId]);
    }
    expect(await readStatus(A.caller, f.taskId)).toBe(200);
  });

  test('the invoke holder\'s executionProfile reassigns, re-pins, swaps the vehicle and bumps the epoch', async () => {
    const f = await assignedTask('lawful-invoke');
    const answer = await call(OWNER, 'PATCH', `/tasks/${f.taskId}`, { executionProfile: profileOf(B, 2) });
    expect(answer.status).toBe(200);
    const after = await snapshot(f.taskId);
    expect(after.task).toEqual({
      execution_service_id: B.serviceId, execution_descriptor_version: 2,
      execution_profile: profileOf(B, 2), execution_warrant_id: null,
    });
    expect((after.links as any[]).length).toBeGreaterThan(0);
    expect((after.links as any[]).every((link) => link.vehicle_kind === 'role'
      && link.role === 'implementer' && link.assignee_principal_id === B.principalId
      && link.landed_on_principal_id === B.principalId && link.target_kind === 'grant')).toBe(true);
    expect((after.vehicleGrants as any[]).map((grant) => grant.verb).sort()).toEqual(['read', 'write']);
    expect((after.vehicleGrants as any[]).every((grant) => grant.grantee_id === B.principalId
      && grant.provenance === 'assignment:grant')).toBe(true);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM grants WHERE id = ANY($1::uuid[])',
      [(f.before.vehicleGrants as any[]).map((grant) => grant.id)])).rows[0].n).toBe(0);
    expect(after.epoch).toBe(String(BigInt(f.before.epoch as string) + 1n));
    expect((after.executions as any[]).map((row) => row.state)).toEqual(['ownership_lost']);
    expect(await readStatus(A.caller, f.taskId)).toBe(404);
    expect(await readStatus(A_SIBLING.caller, f.taskId)).toBe(404);
    expect(await readStatus(B.caller, f.taskId)).toBe(200);
    expect(await readStatus(B.account, f.taskId)).toBe(404);
  });

  test('executionProfile null by a plain Task writer unassigns: assignment, pin, profile and vehicle all go', async () => {
    const f = await assignedTask('lawful-unassign');
    const answer = await call(WRITER, 'PATCH', `/tasks/${f.taskId}`, { executionProfile: null });
    expect(answer.status).toBe(200);
    const after = await snapshot(f.taskId);
    expect([after.task, after.links, after.vehicleGrants]).toEqual([{
      execution_service_id: null, execution_descriptor_version: null, execution_profile: null, execution_warrant_id: null,
    }, [], []]);
    expect(await readStatus(A.caller, f.taskId)).toBe(404);
    expect(await readStatus(A.account, f.taskId)).toBe(404);
    expect(await readStatus(A_SIBLING.caller, f.taskId)).toBe(404);
  });

  test('a Warrant id without an executionProfile is 422 WARRANT_WITHOUT_ASSIGNMENT and changes nothing', async () => {
    const f = await assignedTask('lawful-warrant');
    const answer = await call(OWNER, 'PATCH', `/tasks/${f.taskId}`, { executionWarrantId: crypto.randomUUID() });
    expect({ status: answer.status, code: answer.json?.code, state: await snapshot(f.taskId) })
      .toEqual({ status: 422, code: 'WARRANT_WITHOUT_ASSIGNMENT', state: f.before });
  });
});

// ────────────── card 69943b61: dropping a Warrant needs services:invoke ──────────────

describe('card 69943b61: dropping the Warrant that carries an assignment requires services:invoke', () => {
  // A service under OWNER holding WRITER's scopes plus services:invoke, so the
  // two callers differ by that one scope.
  let INVOKER: Caller;

  beforeAll(async () => {
    INVOKER = await delegatedService(OWNER, 'invoker', ['tasks:read', 'tasks:write', 'services:invoke']);
  });

  const taskRow = async (taskId: string) => (await pool.query('SELECT * FROM tasks WHERE id = $1', [taskId])).rows[0];
  const profileAssignmentExists = async (id: string) =>
    (await pool.query('SELECT 1 FROM access_profile_assignments WHERE id = $1', [id])).rows.length === 1;
  const deniedRows = async (taskId: string) => (await pool.query(
    `SELECT action, outcome, actor_principal_id, metadata FROM audit_events
      WHERE resource_type = 'task' AND resource_id = $1 AND outcome = 'denied' ORDER BY occurred_at, id`,
    [taskId],
  )).rows;

  /** A Warrant held by Connector A, anchored on exactly this Task, whose ceiling is read on it. */
  async function taskWarrant(taskId: string, label: string): Promise<string> {
    const warrant = await warrantService.create({
      name: `rawkeys ${label} ${tag()}`,
      holderPrincipalId: A.principalId,
      anchors: [{ anchorType: 'task', anchorId: taskId }],
      ceilingRules: [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [taskId], verbs: ['read'] }],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }, { principalId: OWNER.principalId, isRoot: false, sessionScopes: null, stepUp: null },
    { principalId: OWNER.principalId, handle: 'rawkeys-drill', authMethod: 'session' });
    return String(warrant.id);
  }

  interface Warranted extends Fixture { warrantId: string; target: string; row: any }

  /** A Task assigned to Connector A at v1 through PATCH by the invoke holder,
   * its access carried by a Warrant A holds. */
  async function warrantedTask(label: string): Promise<Warranted> {
    const created = await call(OWNER, 'POST', '/tasks', {
      title: `rawkeys ${label} ${tag()}`, description: 'Warrant drop drill', status: 'todo',
    });
    expect(created.status).toBe(201);
    const taskId = String(created.json.task.id);
    const warrantId = await taskWarrant(taskId, label);
    const assigned = await call(OWNER, 'PATCH', `/tasks/${taskId}`,
      { executionProfile: profileOf(A, 1), executionWarrantId: warrantId });
    expect([assigned.status, assigned.json?.code]).toEqual([200, undefined]);
    const before = await snapshot(taskId);
    // The fixture is what it claims to be: assigned to A at v1, the access
    // carried by the Warrant's profile assignment landed on A's Account, which
    // reads the Task; the writer reads it too.
    expect(before.task).toEqual({
      execution_service_id: A.serviceId, execution_descriptor_version: 1,
      execution_profile: profileOf(A, 1), execution_warrant_id: warrantId,
    });
    const links = before.links as any[];
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((link) => link.vehicle_kind === 'warrant' && link.warrant_id === warrantId
      && link.target_kind === 'profile_assignment' && link.landed_on_principal_id === A.account.principalId)).toBe(true);
    expect(await profileAssignmentExists(String(links[0].target_id))).toBe(true);
    expect(await readStatus(A.account, taskId)).toBe(200);
    expect(await readStatus(A.caller, taskId)).toBe(200);
    expect(await readStatus(WRITER, taskId)).toBe(200);
    return { taskId, before, warrantId, target: String(links[0].target_id), row: await taskRow(taskId) };
  }

  /** AZ-A10: dropping a Warrant switches to implementer role grants on A itself. */
  function carriedByRoleGrant(state: Snapshot): boolean {
    const links = state.links as any[];
    const grants = state.vehicleGrants as any[];
    return links.length > 0 && grants.length > 0
      && links.every((link) => link.vehicle_kind === 'role' && link.role === 'implementer'
        && link.assignee_principal_id === A.principalId && link.warrant_id === null
        && link.target_kind === 'grant' && link.landed_on_principal_id === A.principalId)
      && grants.every((grant) => grant.grantee_id === A.principalId
        && grant.provenance === 'assignment:grant');
  }

  test('a plain Task writer fully unassigns a Warrant-carried Task and revokes its vehicle', async () => {
    for (const body of [{ executionProfile: null }, { executionProfile: null, executionWarrantId: null }]) {
      const f = await warrantedTask('full-unassign');
      const answer = await call(WRITER, 'PATCH', `/tasks/${f.taskId}`, body);
      expect([answer.status, answer.json?.code]).toEqual([200, undefined]);

      const after = await snapshot(f.taskId);
      expect([after.task, after.links, after.vehicleGrants]).toEqual([{
        execution_service_id: null, execution_descriptor_version: null,
        execution_profile: null, execution_warrant_id: null,
      }, [], []]);
      expect(await profileAssignmentExists(f.target)).toBe(false);
      expect(await readStatus(A.account, f.taskId)).toBe(404);
      expect((after.feed as number)).toBe((f.before.feed as number) + 1);
      expect(await deniedRows(f.taskId)).toEqual([]);
      const revoked = (await pool.query(
        `SELECT action, outcome, actor_principal_id, metadata->>'assignmentId' AS assignment_id
           FROM audit_events WHERE metadata->>'assignmentId' = $1 AND action = 'profile.unassign'`,
        [f.target],
      )).rows;
      expect(revoked).toEqual([{
        action: 'profile.unassign', outcome: 'success', actor_principal_id: WRITER.principalId,
        assignment_id: f.target,
      }]);
    }
  });

  test('(1) a plain Task writer\'s executionWarrantId: null on a Warrant-carried Task is 403 WARRANT_DROP_INVOKE_REQUIRED, audited, and writes nothing', async () => {
    // The second body moves the Task to a terminal status in the same write,
    // which used to clear the pointer so that a reopen re-carried the
    // assignment on an auto-grant: the gate does not depend on status.
    for (const body of [{ executionWarrantId: null }, { status: 'archived', executionWarrantId: null }]) {
      const f = await warrantedTask(`drop-writer-${body.status ?? 'edit'}`);
      const answer = await call(WRITER, 'PATCH', `/tasks/${f.taskId}`, body);
      expect({
        body,
        status: answer.status, code: answer.json?.code, field: answer.json?.field,
        row: await taskRow(f.taskId),
        state: await snapshot(f.taskId),
        warrantTarget: await profileAssignmentExists(f.target),
        denied: await deniedRows(f.taskId),
        assigneeReads: await readStatus(A.account, f.taskId),
      }).toEqual({
        body,
        status: 403, code: 'WARRANT_DROP_INVOKE_REQUIRED', field: 'executionWarrantId',
        row: f.row,
        // The one row this refusal writes is its own denied audit row.
        state: { ...f.before, assignmentAudit: (f.before.assignmentAudit as number) + 1 },
        warrantTarget: true,
        denied: [{
          action: 'task.execution_assign', outcome: 'denied', actor_principal_id: WRITER.principalId,
          metadata: { refusal: 'WARRANT_DROP_INVOKE_REQUIRED', field: 'executionWarrantId', warrantId: f.warrantId },
        }],
        assigneeReads: 200,
      });
    }
  });

  test('(2) the invoke holder\'s executionWarrantId: null swaps the Warrant for assignee role grants', async () => {
    const f = await warrantedTask('drop-invoker');
    const answer = await call(INVOKER, 'PATCH', `/tasks/${f.taskId}`, { executionWarrantId: null });
    expect([answer.status, answer.json?.code]).toEqual([200, undefined]);
    const after = await snapshot(f.taskId);
    expect({
      task: after.task, roleGrant: carriedByRoleGrant(after), warrantTarget: await profileAssignmentExists(f.target),
      denied: await deniedRows(f.taskId), assigneeReads: await readStatus(A.caller, f.taskId),
      accountReads: await readStatus(A.account, f.taskId),
      siblingReads: await readStatus(A_SIBLING.caller, f.taskId),
    }).toEqual({
      task: { ...(f.before.task as object), execution_warrant_id: null },
      roleGrant: true, warrantTarget: false, denied: [], assigneeReads: 200, accountReads: 404, siblingReads: 404,
    });
  });

  test('(3) on a Task no Warrant carries, a plain Task writer\'s executionWarrantId: null changes nothing, as before', async () => {
    const assigned = await assignedTask('drop-no-warrant');
    const answer = await call(WRITER, 'PATCH', `/tasks/${assigned.taskId}`, { executionWarrantId: null });
    expect([answer.status, answer.json?.code]).toEqual([200, undefined]);
    // A successful PATCH records a feed event; nothing the assignment owns moves.
    expect({ ...(await snapshot(assigned.taskId)), feed: null }).toEqual({ ...assigned.before, feed: null });
    expect(await deniedRows(assigned.taskId)).toEqual([]);

    const created = await call(OWNER, 'POST', '/tasks', { title: `rawkeys drop-unassigned ${tag()}`, status: 'todo' });
    expect(created.status).toBe(201);
    const taskId = String(created.json.task.id);
    const before = await snapshot(taskId);
    const plain = await call(WRITER, 'PATCH', `/tasks/${taskId}`, { executionWarrantId: null });
    expect([plain.status, plain.json?.code]).toEqual([200, undefined]);
    expect({ ...(await snapshot(taskId)), feed: null }).toEqual({ ...before, feed: null });
    expect((before.task as any).execution_warrant_id).toBeNull();
    expect(await deniedRows(taskId)).toEqual([]);
  });

  test('(4) switching to another Warrant stays gated: 422 without a profile, 403 PROFILE_INVOKE_REQUIRED with one; the invoke holder switches', async () => {
    const f = await warrantedTask('switch');
    const other = await taskWarrant(f.taskId, 'switch-other');

    const bare = await call(WRITER, 'PATCH', `/tasks/${f.taskId}`, { executionWarrantId: other });
    expect({ status: bare.status, code: bare.json?.code, row: await taskRow(f.taskId), state: await snapshot(f.taskId) })
      .toEqual({ status: 422, code: 'WARRANT_WITHOUT_ASSIGNMENT', row: f.row, state: f.before });

    const withProfile = await call(WRITER, 'PATCH', `/tasks/${f.taskId}`,
      { executionProfile: profileOf(A, 1), executionWarrantId: other });
    expect({
      status: withProfile.status, code: withProfile.json?.code, row: await taskRow(f.taskId), state: await snapshot(f.taskId),
    }).toEqual({ status: 403, code: 'PROFILE_INVOKE_REQUIRED', row: f.row, state: f.before });

    // The lawful switch is the fixture's assigner: a Warrant's ceiling must sit
    // inside the assigner's own effective access (the R3 cap), which the
    // delegated INVOKER does not hold: R3 refuses it, and R3 is not under test.
    const lawful = await call(OWNER, 'PATCH', `/tasks/${f.taskId}`,
      { executionProfile: profileOf(A, 1), executionWarrantId: other });
    expect([lawful.status, lawful.json?.code]).toEqual([200, undefined]);
    const after = await snapshot(f.taskId);
    expect((after.task as any).execution_warrant_id).toBe(other);
    expect((after.links as any[]).length).toBeGreaterThan(0);
    expect((after.links as any[]).every((link) => link.vehicle_kind === 'warrant' && link.warrant_id === other)).toBe(true);
    expect(await readStatus(A.account, f.taskId)).toBe(200);
  });

  test('(5) the assigning act\'s date still reaches the write beside a drop by the invoke holder (the 785e1eed carrier)', async () => {
    const f = await warrantedTask('drop-dated');
    const answer = await call(INVOKER, 'PATCH', `/tasks/${f.taskId}`,
      { executionProfile: profileOf(A, 1), executionWarrantId: null, roleGrantExpiresAt: 'unlimited' });
    expect([answer.status, answer.json?.code, answer.json?.roleGrantExpiresAt]).toEqual([200, undefined, 'unlimited']);
    const after = await snapshot(f.taskId);
    expect({ warrant: (after.task as any).execution_warrant_id, roleGrant: carriedByRoleGrant(after) })
      .toEqual({ warrant: null, roleGrant: true });
    expect(await readStatus(A.caller, f.taskId)).toBe(200);
    expect(await readStatus(A.account, f.taskId)).toBe(404);
    expect(await readStatus(A_SIBLING.caller, f.taskId)).toBe(404);
    expect((await pool.query(
      'SELECT COUNT(*)::int AS n FROM grants WHERE id = ANY($1::uuid[]) AND expires_at IS NOT NULL',
      [(after.vehicleGrants as any[]).map((grant) => grant.id)],
    )).rows[0].n).toBe(0);
  });

  test('(6) MCP relayhall_task_update cannot carry executionWarrantId: refused by the tool allowlist, nothing changed', async () => {
    const f = await warrantedTask('drop-mcp');
    const answer = await mcpCall(WRITER, 'relayhall_task_update', { task: f.taskId, executionWarrantId: null });
    const text = mcpText(answer);
    expect({
      failed: mcpFailed(answer), unknown: text.includes('Unknown arguments') && text.includes('executionWarrantId'),
      row: await taskRow(f.taskId), state: await snapshot(f.taskId),
    }).toEqual({ failed: true, unknown: true, row: f.row, state: f.before });
  });
});
