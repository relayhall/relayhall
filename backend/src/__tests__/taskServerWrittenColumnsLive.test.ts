/**
 * Card c3880767: a server-written column of `tasks` is never a request field,
 * and the classification that says which columns are server-written covers
 * the WHOLE table.
 *
 * Card 7c77fcf3 refused the two internal execution keys by name. Its census
 * found the class: PATCH /tasks/:id spread the request body into
 * TaskManagerDB.updateTask, which honours a string key for every column it
 * knows, so a plain Task writer could set attemptCount and maxRetries (the
 * reviewer retry budget), needsReview, reviewHistory, completedBy,
 * activeAgent, acpSessionKey, discordThreadId, lastChecked,
 * thinkingAutoEstimated, autoCreated and sessionRefs; POST /tasks forwarded
 * autoCreated, activeAgent, reviewHistory, maxRetries and sessionRefs into the
 * INSERT. utils/taskColumnContract.ts classifies every column as PUBLIC or
 * SERVER-WRITTEN, the two routes refuse every key that names a server-written
 * column, and PATCH forwards only public keys to the write.
 *
 * Proven over a REAL PostgreSQL, the PRODUCTION router and the MCP ingress
 * mounted the way server.ts mounts it:
 *
 *   (A) CLASSIFICATION, schema-wide: the live column list of `tasks` is read
 *       from information_schema and must equal the contract's columns, so a
 *       column a later migration adds fails here until it is classified; no
 *       key names two columns; the batch allowlist is public.
 *   (B) THE PROBES ARE THIS FILE'S OWN: one entry per server-written column,
 *       with every key that names it and a value that differs from the stored
 *       one. The per-column blocks iterate over THIS table, never over the
 *       module's set, so reclassifying one column as public reddens that
 *       column's block instead of deleting it. Completeness binds the module to
 *       the table in the direction that cannot be satisfied by removal: every
 *       server-written column and key of the module has a probe here.
 *   (C) ONE describe per server-written column. For every key that names it:
 *       PATCH /tasks/:id by a plain Task writer is 400 SERVER_WRITTEN_FIELD
 *       naming the key in details.field and the stored row is byte-identical;
 *       POST /tasks is the same refusal and writes no Task; MCP
 *       relayhall_task_create refuses it as an unknown argument and writes no Task; MCP
 *       relayhall_task_update and relayhall_task_recover refuse it as an
 *       unknown argument and change nothing; PATCH /tasks/batch refuses it as
 *       UNSUPPORTED_BATCH_FIELD and changes nothing.
 *   (D) THE LAWFUL PATH: every public request key still writes through PATCH
 *       (read back from stored rows), and every payload an in-repo client
 *       sends (the Task create page, the Project modal, the Task board, the
 *       Task detail page, the CLI create/update/move/agent hand-off/phase
 *       scaffold, the MCP create/update/move/arm/park tools) is still
 *       answered as before and stores what it sent. Keys that are no column
 *       (agentInstructions, role, blockedBy) are still ignored, not refused.
 *
 * AGAINST THE ROUTES BEFORE THIS CARD (the red proof): on PATCH, the twelve
 * reachable columns are WRITTEN (attempt_count, max_retries, needs_review,
 * review_history, completed_by, active_agent, acp_session_key,
 * discord_thread_id, last_checked, thinking_auto_estimated, auto_created,
 * session_refs), which is the defect; on POST auto_created, active_agent,
 * review_history, max_retries and session_refs are written. Every other key
 * fails on the refusal contract only (200 or 201, nothing written), except the
 * role identifiers and the two camelCase execution keys, which were refused
 * before. (A), (B), the MCP update and recover refusals, the batch refusals,
 * the outsider check and (D) pass there too.
 *
 * DESTRUCTIVE: writes principals, credentials, projects, phases, services,
 * descriptor versions and tasks. It refuses any deployment database and any
 * non-local host, and FAILS - never skips - without a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the server-written column drill reads the live column list and '
    + 'measures stored task rows, so it never skips. Load database/init.sql into a disposable database, run '
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
  throw new Error('Server-written column drill refuses a non-disposable database target');
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
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');
const {
  TASK_COLUMN_CONTRACT, PUBLIC_TASK_REQUEST_KEYS, SERVER_WRITTEN_TASK_COLUMN_KEYS, NON_COLUMN_TASK_REQUEST_KEYS,
  publicTaskBody,
} = require('../utils/taskColumnContract');
const { ALLOWED_FIELDS: BATCH_FIELDS } = require('../routes/tasksBatch');

jest.setTimeout(300_000);

// ──────────────────────────────── the app ────────────────────────────────────

let server: http.Server;
let origin: string;

function buildApp(): any {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  // The MCP ingress first and outside the REST funnel, exactly as server.ts
  // mounts it: the task tools dispatch in-process to the same /tasks routes.
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
    [`swcols-${label}-${tag()}`, role],
  )).rows[0];
  const minted = await loginSessionService.mint({ principalId: row.id });
  return { label, principalId: String(row.id), headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

/** A delegated service principal under `parent`, inheriting the parent's
 * object authority, with its own bearer credential. */
async function delegatedService(parent: Caller, label: string, scopes: string[]): Promise<Caller> {
  const principalId = String((await pool.query(
    `INSERT INTO principals (kind, handle, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, 'active', $2, 'Server-written column drill', $3) RETURNING id`,
    [`swcols-${label}-${tag()}`, parent.principalId, JSON.stringify({ scopes: 'parent', objects: 'parent' })],
  )).rows[0].id);
  const issued = await principalService.issueCredential(
    { principalId, scopes, transport: 'any' },
    { handle: 'swcols-drill', authMethod: 'system' },
  );
  return { label, principalId, headers: { Authorization: `Bearer ${issued.fullKey}` } };
}

interface Connector { serviceId: string; principalId: string }

/** A published Connector owned by `account`, with descriptor version 1. */
async function publishedConnector(account: Caller): Promise<Connector> {
  const principal = await delegatedService(account, 'connector', ['tasks:read', 'tasks:write']);
  const serviceId = crypto.randomUUID();
  const slug = `swcols-connector-${tag()}`;
  await pool.query(
    `INSERT INTO services (id, slug, name, kind, status, principal_id, current_descriptor_version)
     VALUES ($1, $2, $2, 'connector', 'published', $3, 1)`,
    [serviceId, slug, principal.principalId],
  );
  await pool.query(
    `INSERT INTO service_descriptor_versions (service_id, version, descriptor, content_hash)
     VALUES ($1, 1, '{"options":[]}'::jsonb, $2)`,
    [serviceId, hex64()],
  );
  return { serviceId, principalId: principal.principalId };
}

// ─────────────────────────────── fixtures ────────────────────────────────────

let OWNER: Caller;     // Account role user: owns the Projects and creates the Tasks; holds services:invoke
let WRITER: Caller;    // a service under OWNER: tasks:read + tasks:write, NOT services:invoke
let OUTSIDER: Caller;  // another Account; reads none of the Tasks
let CONNECTOR: Connector;
let PROJECT: { id: string; name: string };
let PROJECT_B: { id: string; name: string };
let PHASE: string;     // a Phase of PROJECT
let GENERALIST: string;

async function makeProject(owner: Caller): Promise<{ id: string; name: string }> {
  const name = `swcols project ${tag()}`;
  const id = String((await pool.query(
    `INSERT INTO projects (name, status, visibility, owner_principal_id)
     VALUES ($1, 'active', 'private', $2) RETURNING id`, [name, owner.principalId],
  )).rows[0].id);
  return { id, name };
}

/** Every stored column of one Task row, exactly as PostgreSQL returns it. */
async function row(taskId: string): Promise<Record<string, unknown>> {
  return (await pool.query('SELECT * FROM tasks WHERE id = $1', [taskId])).rows[0];
}

/** Make `who` the Task's Assignee. Lifecycle moves in a body that is not a
 * pure planning write need the claimant arm; the claim protocol is not what is
 * on trial here, so the assignment is a direct fixture write. */
async function assignTo(taskId: string, who: Caller): Promise<string> {
  await pool.query('UPDATE tasks SET owner_principal_id = $2 WHERE id = $1', [taskId, who.principalId]);
  return taskId;
}

async function rowsTitled(title: string): Promise<unknown[]> {
  return (await pool.query('SELECT id FROM tasks WHERE title = $1', [title])).rows;
}

/** A Task created through the route by OWNER. Explicit thinking makes
 * thinking_auto_estimated false, so a probe of true would show. */
async function fixtureTask(label: string, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await call(OWNER, 'POST', '/tasks', {
    title: `swcols ${label} ${tag()}`, description: 'server-written column drill', status: 'todo',
    thinking: 'low', project: PROJECT.name, ...extra,
  });
  expect([created.status, created.json?.code]).toEqual([201, undefined]);
  return String(created.json.task.id);
}

beforeAll(async () => {
  await new Promise<void>((resolve) => { server = buildApp().listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  OWNER = await makeAccount('user', 'owner');
  WRITER = await delegatedService(OWNER, 'writer', ['tasks:read', 'tasks:write']);
  OUTSIDER = await makeAccount('user', 'outsider');
  CONNECTOR = await publishedConnector(await makeAccount('user', 'connector-account'));
  PROJECT = await makeProject(OWNER);
  PROJECT_B = await makeProject(OWNER);
  PHASE = String((await pool.query(
    "INSERT INTO phases (project_id, name) VALUES ($1, 'swcols phase') RETURNING id", [PROJECT.id],
  )).rows[0].id);
  GENERALIST = String((await pool.query("SELECT id FROM personalities WHERE slug = 'generalist'")).rows[0].id);
  const brief = await mcpCall(WRITER, 'relayhall_brief_compile', { session: true });
  expect(mcpFailed(brief)).toBe(false);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ───────────────────────── (A) the classification ────────────────────────────

describe('(A) every column of tasks is classified, schema-wide', () => {
  test('the live column list (information_schema) equals the contract: none unclassified, none invented', async () => {
    const live: string[] = (await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tasks' ORDER BY ordinal_position`,
    )).rows.map((r: { column_name: string }) => r.column_name);
    const classified = Object.keys(TASK_COLUMN_CONTRACT);
    expect(live.length).toBeGreaterThan(40);
    expect({
      unclassified: live.filter((column) => !classified.includes(column)),
      invented: classified.filter((column) => !live.includes(column)),
    }).toEqual({ unclassified: [], invented: [] });
  });

  test('each column is in exactly one class and names at least one request key', () => {
    const malformed = Object.entries(TASK_COLUMN_CONTRACT as Record<string, { class: string; keys: string[] }>)
      .filter(([, entry]) => !['public', 'server-written'].includes(entry.class) || entry.keys.length === 0)
      .map(([column]) => column);
    expect(malformed).toEqual([]);
  });

  test('no request key names two columns, and the public and server-written key sets are disjoint', () => {
    const owners = new Map<string, string[]>();
    for (const [column, entry] of Object.entries(TASK_COLUMN_CONTRACT as Record<string, { keys: string[] }>)) {
      for (const key of entry.keys) owners.set(key, [...(owners.get(key) ?? []), column]);
    }
    expect([...owners].filter(([, columns]) => columns.length > 1)).toEqual([]);
    expect([...PUBLIC_TASK_REQUEST_KEYS].filter((key: string) => SERVER_WRITTEN_TASK_COLUMN_KEYS.has(key))).toEqual([]);
    expect(NON_COLUMN_TASK_REQUEST_KEYS.filter((key: string) => owners.has(key))).toEqual([]);
  });

  test('every PATCH /tasks/batch field is a public request key', () => {
    expect([...BATCH_FIELDS].filter((key: string) => !PUBLIC_TASK_REQUEST_KEYS.has(key))).toEqual([]);
  });

  test('publicTaskBody keeps the shape the classifiers read: a plain object, the caller\'s order, explicit nulls', () => {
    // Only keys that are no column at all are dropped here: a server-written
    // key never reaches the pick, because the route refuses it first.
    const picked = publicTaskBody({ role: 'agent', status: 'review', phaseId: null, dueAt: null, agentInstructions: 'x' });
    expect(Object.getPrototypeOf(picked)).toBe(Object.prototype);
    expect(Object.entries(picked)).toEqual([['status', 'review'], ['phaseId', null], ['dueAt', null]]);
    expect([publicTaskBody(undefined), publicTaskBody(null), publicTaskBody(['status'])]).toEqual([{}, {}, {}]);
  });
});

// ───────────────────────── (B) this file's probes ────────────────────────────

const AT = '2031-01-02T03:04:05.000Z';

/** One entry per server-written column: every key that names it, and a value
 * that differs from what a fixture Task stores. Values respect the CHECKs, so
 * a route that honoured the key would WRITE it rather than fail on a
 * constraint: max_retries 1..10, needs_review NOT NULL. */
const PROBES: Record<string, { keys: string[]; value: () => unknown }> = {
  id: { keys: ['id'], value: () => crypto.randomUUID() },
  started_at: { keys: ['startedAt', 'started_at'], value: () => AT },
  archived_at: { keys: ['archivedAt', 'archived_at'], value: () => AT },
  created_at: { keys: ['created', 'createdAt', 'created_at'], value: () => AT },
  updated_at: { keys: ['updated', 'updatedAt', 'updated_at'], value: () => AT },
  thinking_auto_estimated: { keys: ['thinkingAutoEstimated', 'thinking_auto_estimated'], value: () => true },
  execution_mode: { keys: ['execution_mode'], value: () => 'interactive' },
  status_reason: { keys: ['statusReason', 'status_reason'], value: () => 'swcols probe' },
  attempt_count: { keys: ['attemptCount', 'attempt_count'], value: () => 7 },
  completed_at: { keys: ['completed', 'completedAt', 'completed_at'], value: () => AT },
  discord_thread_id: { keys: ['discordThreadId', 'discord_thread_id'], value: () => '123456789012345678' },
  success_criteria: { keys: ['successCriteria', 'success_criteria'], value: () => ['Independent criteria remain unchanged'] },
  review_history: { keys: ['reviewHistory', 'review_history'], value: () => [{ verdict: 'approved', probe: true }] },
  max_retries: { keys: ['maxRetries', 'max_retries'], value: () => 9 },
  review_status: { keys: ['reviewStatus', 'review_status'], value: () => 'approved' },
  reviewer_session_key: { keys: ['reviewerSessionKey', 'reviewer_session_key'], value: () => 'swcols-probe' },
  reviewer_last_run_at: { keys: ['reviewerLastRunAt', 'reviewer_last_run_at'], value: () => AT },
  reviewer_timeout_seconds: { keys: ['reviewerTimeoutSeconds', 'reviewer_timeout_seconds'], value: () => 5 },
  last_reviewed_at: { keys: ['lastReviewedAt', 'last_reviewed_at'], value: () => AT },
  needs_review: { keys: ['needsReview', 'needs_review'], value: () => true },
  archive_disposition: { keys: ['archiveDisposition', 'archive_disposition'], value: () => 'completed' },
  owner_principal_id: { keys: ['ownerPrincipalId', 'owner_principal_id'], value: () => OUTSIDER.principalId },
  creator_principal_id: { keys: ['creatorPrincipalId', 'creator_principal_id'], value: () => OUTSIDER.principalId },
  visibility: { keys: ['visibility'], value: () => 'public' },
  execution_service_id: { keys: ['executionServiceId', 'execution_service_id'], value: () => CONNECTOR.serviceId },
  execution_descriptor_version: { keys: ['executionDescriptorVersion', 'execution_descriptor_version'], value: () => 2 },
  shepherd_principal_id: { keys: ['shepherdPrincipalId', 'shepherd_principal_id'], value: () => OUTSIDER.principalId },
  verifier_principal_id: { keys: ['verifierPrincipalId', 'verifier_principal_id'], value: () => OUTSIDER.principalId },
  // Card 41e24358 (migration 155): where the Verifier came from.
  verifier_source: { keys: ['verifierSource', 'verifier_source'], value: () => 'explicit' },
  // Owner ruling E462 S4b (migration 170): verification mode none. The create
  // admits `verificationNone` (a boolean); this probe's value is not one.
  verification_none: { keys: ['verificationNone', 'verification_none'], value: () => 'yes' },
  verification_none_set_by: { keys: ['verificationNoneSetByPrincipalId', 'verification_none_set_by'], value: () => OUTSIDER.principalId },
  verification_none_basis: { keys: ['verificationNoneBasis', 'verification_none_basis'], value: () => 'account-control' },
  verification_none_set_at: { keys: ['verificationNoneSetAt', 'verification_none_set_at'], value: () => AT },
  verification_none_cleared_at: { keys: ['verificationNoneClearedAt', 'verification_none_cleared_at'], value: () => AT },
  restricted_access: { keys: ['restrictedAccess', 'restricted_access'], value: () => true },
  blueprint_key: { keys: ['blueprintKey', 'blueprint_key'], value: () => 'swcols-probe' },
  blueprint_version: { keys: ['blueprintVersion', 'blueprint_version'], value: () => 2 },
  blueprint_content_sha256: { keys: ['blueprintContentSha256', 'blueprint_content_sha256'], value: () => hex64() },
  blueprint_identity_sha256: { keys: ['blueprintIdentitySha256', 'blueprint_identity_sha256'], value: () => hex64() },
  instantiation_id: { keys: ['instantiationId', 'instantiation_id'], value: () => crypto.randomUUID() },
  account_owner_principal_id: { keys: ['accountOwnerPrincipalId', 'account_owner_principal_id'], value: () => OUTSIDER.principalId },
};

describe('(B) the probes cover the module, column by column and key by key', () => {
  test('every server-written column of the contract has a probe here, with every key that names it', () => {
    const missing = Object.entries(TASK_COLUMN_CONTRACT as Record<string, { class: string; keys: string[] }>)
      .filter(([, entry]) => entry.class === 'server-written')
      .flatMap(([column, entry]) => entry.keys
        .filter((key) => !PROBES[column]?.keys.includes(key))
        .map((key) => `${column}.${key}`));
    expect(missing).toEqual([]);
  });

  test('every probed column exists in the live schema', async () => {
    const live = new Set((await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tasks'",
    )).rows.map((r: { column_name: string }) => r.column_name));
    expect(Object.keys(PROBES).filter((column) => !live.has(column))).toEqual([]);
  });
});

// ──────────────────── (C) one describe per server-written column ─────────────

const refused = (answer: Answer) => ({
  status: answer.status, code: answer.json?.code, field: answer.json?.details?.field,
});

describe.each(Object.keys(PROBES))('(C) server-written column %s', (column) => {
  const { keys, value } = PROBES[column];
  let taskId: string;

  beforeAll(async () => { taskId = await fixtureTask(`c-${column}`); });

  test.each(keys)('PATCH /tasks/:id by a plain Task writer carrying %s is refused SERVER_WRITTEN_FIELD; the row is byte-identical', async (key) => {
    const before = await row(taskId);
    const answer = await call(WRITER, 'PATCH', `/tasks/${taskId}`, { [key]: value() });
    expect({ ...refused(answer), row: await row(taskId) })
      .toEqual({ status: 400, code: 'SERVER_WRITTEN_FIELD', field: key, row: before });
  });

  // Card 41e24358 (owner answer Q2 (b), check F6): the create alone admits
  // `verifierPrincipalId`, and only as a Project or Phase default; any other
  // value (this outsider is no default) is refused VERIFIER_NOT_ALLOWED and
  // still writes no Task. Every other key keeps SERVER_WRITTEN_FIELD.
  const CREATE_ADMITTED = 'verifierPrincipalId';
  // Owner ruling E462 S4b: the create also admits `verificationNone`, and only
  // as a boolean; this probe's non-boolean is refused and writes no Task.
  const CREATE_ADMITTED_NONE = 'verificationNone';

  test.each(keys)('POST /tasks carrying %s is refused SERVER_WRITTEN_FIELD and writes no Task', async (key) => {
    const title = `swcols post ${key} ${tag()}`;
    const answer = await call(WRITER, 'POST', '/tasks', { title, project: PROJECT.name, [key]: value() });
    expect({ ...refused(answer), rows: await rowsTitled(title) })
      .toEqual(key === CREATE_ADMITTED
        ? { status: 422, code: 'VERIFIER_NOT_ALLOWED', field: undefined, rows: [] }
        : key === CREATE_ADMITTED_NONE
          ? { status: 422, code: 'INVALID_VERIFICATION_NONE', field: key, rows: [] }
          : { status: 400, code: 'SERVER_WRITTEN_FIELD', field: key, rows: [] });
  });

  test.each(keys)('MCP relayhall_task_create carrying %s refuses the unknown argument and writes no Task', async (key) => {
    const title = `swcols mcp ${key} ${tag()}`;
    const answer = await mcpCall(WRITER, 'relayhall_task_create',
      { title, project: PROJECT.name, idempotencyKey: crypto.randomUUID(), [key]: value() });
    const text = mcpText(answer);
    const refusal = key === CREATE_ADMITTED ? 'VERIFIER_NOT_ALLOWED'
      : key === CREATE_ADMITTED_NONE ? 'INVALID_VERIFICATION_NONE' : `Unknown arguments: ${key}.`;
    expect({
      failed: mcpFailed(answer), refusal: text.includes(refusal), namesKey: text.includes(key),
      rows: await rowsTitled(title),
    }).toEqual({ failed: true, refusal: true, namesKey: true, rows: [] });
  });

  test.each(keys)('MCP relayhall_task_update carrying %s is refused as an unknown argument; the row is byte-identical', async (key) => {
    const before = await row(taskId);
    const answer = await mcpCall(WRITER, 'relayhall_task_update', { task: taskId, [key]: value() });
    expect({ failed: mcpFailed(answer), unknown: mcpText(answer).includes(`Unknown arguments: ${key}.`), row: await row(taskId) })
      .toEqual({ failed: true, unknown: true, row: before });
  });

  test.each(keys)('MCP relayhall_task_recover carrying %s is refused as an unknown argument; the row is byte-identical', async (key) => {
    const before = await row(taskId);
    const answer = await mcpCall(WRITER, 'relayhall_task_recover', { task: taskId, reason: 'swcols drill', [key]: value() });
    expect({ failed: mcpFailed(answer), unknown: mcpText(answer).includes(`Unknown arguments: ${key}.`), row: await row(taskId) })
      .toEqual({ failed: true, unknown: true, row: before });
  });

  test.each(keys)('PATCH /tasks/batch carrying %s is refused UNSUPPORTED_BATCH_FIELD; the row is byte-identical', async (key) => {
    const before = await row(taskId);
    const answer = await call(WRITER, 'PATCH', '/tasks/batch', { ids: [taskId], updates: { [key]: value() } });
    expect({ status: answer.status, code: answer.json?.code, row: await row(taskId) })
      .toEqual({ status: 400, code: 'UNSUPPORTED_BATCH_FIELD', row: before });
  });
});

describe('(C) bodies that mix keys', () => {
  test('two server-written keys in one PATCH body: refused naming one of them, the row is byte-identical', async () => {
    const taskId = await fixtureTask('c-two');
    const before = await row(taskId);
    const answer = await call(WRITER, 'PATCH', `/tasks/${taskId}`, { attemptCount: 0, maxRetries: 10 });
    expect({
      status: answer.status, code: answer.json?.code, namesOne: ['attemptCount', 'maxRetries'].includes(answer.json?.details?.field),
      row: await row(taskId),
    }).toEqual({ status: 400, code: 'SERVER_WRITTEN_FIELD', namesOne: true, row: before });
  });

  test('a lawful edit beside a server-written key: the whole body is refused, the lawful half is not written', async () => {
    const taskId = await fixtureTask('c-mixed');
    const before = await row(taskId);
    const answer = await call(WRITER, 'PATCH', `/tasks/${taskId}`, { title: 'not written', reviewStatus: 'approved' });
    expect({ ...refused(answer), row: await row(taskId) })
      .toEqual({ status: 400, code: 'SERVER_WRITTEN_FIELD', field: 'reviewStatus', row: before });
  });

  test('an outsider learns nothing: the Task stays unreadable (404) and unchanged, before any field is weighed', async () => {
    const taskId = await fixtureTask('c-outsider');
    const before = await row(taskId);
    const answer = await call(OUTSIDER, 'PATCH', `/tasks/${taskId}`, { attemptCount: 7 });
    expect({ status: answer.status, row: await row(taskId) }).toEqual({ status: 404, row: before });
  });
});

// ────────────────────────────── (D) the lawful path ──────────────────────────

const column = async (taskId: string, name: string): Promise<unknown> =>
  (await pool.query(`SELECT ${name} AS value FROM tasks WHERE id = $1`, [taskId])).rows[0].value;
const read = async (taskId: string): Promise<any> => (await call(OWNER, 'GET', `/tasks/${taskId}`)).json?.task;
const profileOf = (connector: Connector) => ({ serviceId: connector.serviceId, descriptorVersion: 1, options: {} });

describe('(E) Verifier-owned success criteria', () => {
  test('assigned Verifier writes through the dedicated route with an atomic metadata audit and feed receipt', async () => {
    const taskId = await fixtureTask('criteria-verifier');
    const verifier = await delegatedService(OWNER, 'criteria-verifier', ['tasks:read', 'tasks:write']);
    await pool.query('UPDATE tasks SET verifier_principal_id=$2 WHERE id=$1', [taskId, verifier.principalId]);
    const body = { successCriteria: ['Evidence must pass'] };
    expect((await call(verifier, 'GET', `/tasks/${taskId}`)).json.task.successCriteriaAccess.allowed).toBe(true);
    expect((await call(WRITER, 'GET', `/tasks/${taskId}`)).json.task.successCriteriaAccess.allowed).toBe(false);
    expect((await call(verifier, 'PATCH', `/tasks/${taskId}/success-criteria`, body)).status).toBe(200);
    expect((await row(taskId)).success_criteria).toBe(JSON.stringify(body.successCriteria));
    const audit = (await pool.query("SELECT actor_principal_id,metadata FROM audit_events WHERE resource_id=$1 AND action='task.success_criteria.change' AND outcome='success'", [taskId])).rows;
    expect(audit).toEqual([{ actor_principal_id: verifier.principalId, metadata: { field: 'successCriteria' } }]);
    expect((await pool.query("SELECT payload FROM feed_events WHERE object_id=$1 AND name='task.updated'", [taskId])).rows.some((r: any) => JSON.stringify(r.payload).includes('successCriteria'))).toBe(true);
    // Ordinary PATCH remains refused even for the lawful Verifier.
    expect(refused(await call(verifier, 'PATCH', `/tasks/${taskId}`, body))).toEqual({status:400,code:'SERVER_WRITTEN_FIELD',field:'successCriteria'});
  });

  test('MCP assigned Verifier uses the same lawful writer; service without appointment cannot', async () => {
    const taskId = await fixtureTask('criteria-mcp');
    await pool.query('UPDATE tasks SET verifier_principal_id=$2 WHERE id=$1', [taskId, WRITER.principalId]);
    const changed = await mcpCall(WRITER, 'relayhall_task_success_criteria_set', { task: taskId, successCriteria: 'Verifier evidence' });
    expect(mcpFailed(changed)).toBe(false);
    expect((await row(taskId)).success_criteria).toBe(JSON.stringify('Verifier evidence'));
    await pool.query('UPDATE tasks SET verifier_principal_id=NULL WHERE id=$1', [taskId]);
    const before = await row(taskId);
    expect(mcpFailed(await mcpCall(WRITER, 'relayhall_task_success_criteria_set', { task: taskId, successCriteria: ['Changed without appointment'] }))).toBe(true);
    expect(await row(taskId)).toEqual(before);
  });

  test('owner and explicit Main can write; ordinary delegated service, implementer and broad Task-admin grant cannot', async () => {
    const taskId = await fixtureTask('criteria-authority');
    expect((await call(OWNER, 'PATCH', `/tasks/${taskId}/success-criteria`, { successCriteria: [] })).status).toBe(200);
    const main = await delegatedService(OWNER, 'criteria-main', ['tasks:read', 'tasks:write']);
    const before = await row(taskId);
    expect((await call(main, 'PATCH', `/tasks/${taskId}/success-criteria`, { successCriteria: ['unappointed'] })).status).toBe(403);
    expect(await row(taskId)).toEqual(before);
    await pool.query('UPDATE principals SET owner_control_account_id=$2 WHERE id=$1', [main.principalId, OWNER.principalId]);
    expect((await call(main, 'PATCH', `/tasks/${taskId}/success-criteria`, { successCriteria: ['Main evidence'] })).status).toBe(200);
    await assignTo(taskId, WRITER);
    const assignedBefore = await row(taskId);
    expect((await call(WRITER, 'PATCH', `/tasks/${taskId}/success-criteria`, { successCriteria: ['implementer rewrite'] })).status).toBe(403);
    await pool.query("INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,origin) VALUES('principal',$1,'task',$2,'admin','manual')", [WRITER.principalId, taskId]);
    expect((await call(WRITER, 'PATCH', `/tasks/${taskId}/success-criteria`, { successCriteria: ['grant rewrite'] })).status).toBe(403);
    expect(await row(taskId)).toEqual(assignedBefore);
  });

  test('shape validation, archived refusal and audit failure preserve the criteria row', async () => {
    const taskId = await fixtureTask('criteria-validation');
    for (const body of [{ successCriteria: 7 }, { successCriteria: [7] }, { successCriteria: null }, { successCriteria: [], title: 'extra' }, {}]) {
      expect((await call(OWNER, 'PATCH', `/tasks/${taskId}/success-criteria`, body)).status).toBe(422);
    }
    const before = await row(taskId);
    const { auditService } = require('../services/AuditService');
    const failed = jest.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('synthetic audit failure'));
    expect((await call(OWNER, 'PATCH', `/tasks/${taskId}/success-criteria`, { successCriteria: ['must roll back'] })).status).toBe(503);
    failed.mockRestore();
    expect(await row(taskId)).toEqual(before);
    await pool.query("UPDATE tasks SET status='archived' WHERE id=$1", [taskId]);
    expect((await call(OWNER, 'PATCH', `/tasks/${taskId}/success-criteria`, { successCriteria: [] })).status).toBe(409);
  });

  test('revoked appointment, credential and account control cannot retain write authority', async () => {
    const taskId = await fixtureTask('criteria-revocation');
    const verifier = await delegatedService(OWNER, 'revoked-verifier', ['tasks:read', 'tasks:write']);
    await pool.query('UPDATE tasks SET verifier_principal_id=$2 WHERE id=$1', [taskId, verifier.principalId]);
    expect((await call(verifier, 'PATCH', `/tasks/${taskId}/success-criteria`, { successCriteria: ['current'] })).status).toBe(200);
    await pool.query('UPDATE principal_credentials SET revoked_at=clock_timestamp() WHERE principal_id=$1', [verifier.principalId]);
    const before = await row(taskId);
    expect((await call(verifier, 'PATCH', `/tasks/${taskId}/success-criteria`, { successCriteria: ['revoked'] })).status).toBe(401);
    expect(await row(taskId)).toEqual(before);
  });

  test('Verifier appointment revoked while a writer waits on the Task lock is refused at decision time', async () => {
    const taskId = await fixtureTask('criteria-lock');
    const verifier = await delegatedService(OWNER, 'criteria-lock-verifier', ['tasks:read', 'tasks:write']);
    await pool.query('UPDATE tasks SET verifier_principal_id=$2 WHERE id=$1', [taskId, verifier.principalId]);
    const locker = await pool.connect();
    let pending: Promise<Answer> | undefined;
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [taskId]);
      pending = call(verifier, 'PATCH', `/tasks/${taskId}/success-criteria`, { successCriteria: ['Stale appointment'] });
      let waiting = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const blockers = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query=$1", ['SELECT * FROM tasks WHERE id=$1 FOR UPDATE']);
        if (blockers.rows.length) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await locker.query('UPDATE tasks SET verifier_principal_id=NULL WHERE id=$1', [taskId]);
      await locker.query('COMMIT');
      expect(await pending).toMatchObject({ status: 403, json: { code: 'TASK_VERIFIER_REQUIRED' } });
      expect((await row(taskId)).success_criteria).toBeNull();
    } finally { await locker.query('ROLLBACK'); locker.release(); if (pending) await pending; }
  });
});

interface PublicWrite {
  /** Who sends it: the plain Task writer unless the key needs the invoke holder or a human. */
  who?: () => Caller;
  body: (ids: { other: string }) => Record<string, unknown>;
  status?: number;
  code?: string;
  stored: (taskId: string, answer: Answer) => Promise<unknown>;
  expected: (ids: { other: string }) => unknown;
}

/** One lawful PATCH per public request key, each read back from what was stored. */
const PUBLIC_WRITES: Record<string, PublicWrite> = {
  title: { body: () => ({ title: 'renamed by the plain writer' }), stored: (id) => column(id, 'title'), expected: () => 'renamed by the plain writer' },
  description: { body: () => ({ description: 'edited' }), stored: (id) => column(id, 'description'), expected: () => 'edited' },
  status: { body: () => ({ status: 'ideas' }), stored: (id) => column(id, 'status'), expected: () => 'ideas' },
  priority: { body: () => ({ priority: 'high' }), stored: (id) => column(id, 'priority'), expected: () => 'high' },
  tags: { body: () => ({ tags: ['beta', 'alpha'] }), stored: async (id) => [...(await read(id)).tags].sort(), expected: () => ['alpha', 'beta'] },
  project: { body: () => ({ project: PROJECT_B.name }), stored: (id) => column(id, 'project_id'), expected: () => PROJECT_B.id },
  autoStart: { body: () => ({ autoStart: true }), stored: (id) => column(id, 'auto_start'), expected: () => true },
  blockedReason: { body: () => ({ blockedReason: 'waiting' }), stored: (id) => column(id, 'blocked_reason'), expected: () => 'waiting' },
  links: {
    body: () => ({ links: [{ title: 'Reference', url: 'https://example.com/reference', type: 'reference' }] }),
    stored: async (id) => (await read(id)).links.map((link: any) => [link.title, link.url]),
    expected: () => [['Reference', 'https://example.com/reference']],
  },
  personalityId: { body: () => ({ personalityId: GENERALIST }), stored: (id) => column(id, 'personality_id'), expected: () => GENERALIST },
  thinking: { body: () => ({ thinking: 'high' }), stored: (id) => column(id, 'thinking_budget'), expected: () => 'high' },
  model: { body: () => ({ model: 'swcols-model' }), stored: (id) => column(id, 'model'), expected: () => 'swcols-model' },
  executionProfile: {
    who: () => OWNER, body: () => ({ executionProfile: profileOf(CONNECTOR) }),
    stored: async (id) => [await column(id, 'execution_service_id'), await column(id, 'execution_descriptor_version')],
    expected: () => [CONNECTOR.serviceId, 1],
  },
  parentId: { body: ({ other }) => ({ parentId: other }), stored: (id) => column(id, 'parent_id'), expected: ({ other }) => other },
  definitionOfDone: { body: () => ({ definitionOfDone: ['the class is closed'] }), stored: async (id) => (await read(id)).definitionOfDone, expected: () => ['the class is closed'] },
  constraints: { body: () => ({ constraints: ['no column left open'] }), stored: async (id) => (await read(id)).constraints, expected: () => ['no column left open'] },
  notes: { body: () => ({ notes: 'a note' }), stored: (id) => column(id, 'notes'), expected: () => 'a note' },
  phaseId: { body: () => ({ phaseId: PHASE }), stored: (id) => column(id, 'phase_id'), expected: () => PHASE },
  // Accepted only beside a non-null executionProfile: the pipeline's own
  // refusal proves the key reached it rather than being dropped.
  executionWarrantId: {
    body: () => ({ executionWarrantId: crypto.randomUUID() }), status: 422, code: 'WARRANT_WITHOUT_ASSIGNMENT',
    stored: (id) => column(id, 'execution_warrant_id'), expected: () => null,
  },
  dueAt: { body: () => ({ dueAt: '2031-05-01T12:00:00Z' }), stored: async (id) => (await read(id)).dueAt, expected: () => '2031-05-01T12:00:00.000000Z' },
  subtasks: {
    body: () => ({ subtasks: [{ text: 'first', status: 'empty' }] }),
    stored: async (id) => (await read(id)).subtasks.map((s: any) => [s.text, s.status]), expected: () => [['first', 'empty']],
  },
  dependsOn: { body: ({ other }) => ({ dependsOn: [other] }), stored: async (id) => (await read(id)).dependsOn, expected: ({ other }) => [other] },
  archiveReason: {
    who: () => OWNER, body: () => ({ status: 'archived', archiveReason: 'superseded by the drill' }),
    stored: async (id) => [await column(id, 'status'), String(await column(id, 'notes')).includes('superseded by the drill')],
    expected: () => ['archived', true],
  },
  // The assigning act's date travels under a Symbol key the pipeline attaches
  // to the PICKED body; 'unlimited' in the receipt proves it survived.
  roleGrantExpiresAt: {
    who: () => OWNER, body: () => ({ executionProfile: profileOf(CONNECTOR), roleGrantExpiresAt: 'unlimited' }),
    stored: async (_id, answer) => answer.json?.roleGrantExpiresAt, expected: () => 'unlimited',
  },
  // Retired: still refused by name by the pipeline, never silently dropped.
  executionMode: {
    body: () => ({ executionMode: 'interactive' }), status: 400, code: 'FIELD_RETIRED',
    stored: (id) => column(id, 'execution_mode'), expected: () => null,
  },
};

describe('(D) every public request key still writes through PATCH /tasks/:id', () => {
  test('every request key the contract lets through is exercised here: by a lawful write, or by a refusal probe', () => {
    // A key that is public in the module but probed in (B) is a reclassified
    // server-written column: its own (C) block is what reddens for it.
    const probed = new Set(Object.values(PROBES).flatMap((probe) => probe.keys));
    expect([...PUBLIC_TASK_REQUEST_KEYS].filter((key: string) => !PUBLIC_WRITES[key] && !probed.has(key))).toEqual([]);
  });

  test.each(Object.keys(PUBLIC_WRITES))('%s', async (key) => {
    const spec = PUBLIC_WRITES[key];
    const taskId = await fixtureTask(`d-${key}`);
    const other = await fixtureTask(`d-${key}-other`);
    const answer = await call((spec.who ?? (() => WRITER))(), 'PATCH', `/tasks/${taskId}`, spec.body({ other }));
    expect({ status: answer.status, code: answer.json?.code, stored: await spec.stored(taskId, answer) })
      .toEqual({ status: spec.status ?? 200, code: spec.code, stored: spec.expected({ other }) });
  });
});

/** The stored projection a client payload is checked against: what a Task
 * READ reports for the fields the census payloads carry. */
async function projection(taskId: string): Promise<Record<string, unknown>> {
  const task = await read(taskId);
  const stored = await row(taskId);
  return {
    title: task.title, description: task.description, status: task.status, priority: task.priority,
    project: task.project ?? null, phaseId: task.phaseId, tags: [...(task.tags ?? [])].sort(),
    model: task.model ?? null, thinking: task.thinking ?? null, personalityId: task.personalityId,
    notes: task.notes ?? null, dueAt: task.dueAt ?? null, autoStart: task.autoStart,
    blockedReason: task.blockedReason ?? null, definitionOfDone: task.definitionOfDone ?? null,
    constraints: task.constraints ?? null, dependsOn: task.dependsOn ?? [],
    links: (task.links ?? []).map((link: any) => [link.title, link.url]),
    subtasks: (task.subtasks ?? []).map((s: any) => [s.text, s.status]),
    serverWritten: {
      attempt_count: stored.attempt_count, max_retries: stored.max_retries, needs_review: stored.needs_review,
      review_history: stored.review_history,
      discord_thread_id: stored.discord_thread_id,
    },
  };
}

const UNTOUCHED = {
  attempt_count: 0, max_retries: 3, needs_review: false, review_history: [],
  discord_thread_id: null,
};

describe('(D) every in-repo client payload is answered as before and stores what it sent', () => {
  test('the Task create page (POST /tasks)', async () => {
    const answer = await call(OWNER, 'POST', '/tasks', {
      title: `swcols create page ${tag()}`, description: 'from the create page', project: PROJECT.name, phaseId: PHASE,
      priority: 'high', status: 'todo', tags: ['ui', 'census'], model: 'swcols-model', thinking: 'medium',
      definitionOfDone: ['it is created'], constraints: ['by the page'], personalityId: GENERALIST,
      subtasks: [{ id: 'draft-1-0', text: 'first', completed: false, status: 'empty' }],
      links: [{ title: 'Reference', url: 'https://example.com/reference', type: 'reference' }],
      dueAt: '2031-05-01T12:00:00Z',
    });
    expect(answer.status).toBe(201);
    expect(await projection(answer.json.task.id)).toEqual(expect.objectContaining({
      description: 'from the create page', project: PROJECT.name, phaseId: PHASE, priority: 'high', status: 'todo',
      tags: ['census', 'ui'], model: 'swcols-model', thinking: 'medium', definitionOfDone: ['it is created'],
      constraints: ['by the page'], personalityId: GENERALIST, subtasks: [['first', 'empty']],
      links: [['Reference', 'https://example.com/reference']], dueAt: '2031-05-01T12:00:00.000000Z',
      serverWritten: UNTOUCHED,
    }));
  });

  test('the Project modal (POST /tasks)', async () => {
    const answer = await call(OWNER, 'POST', '/tasks', {
      title: `swcols modal ${tag()}`, description: 'from the modal', priority: 'low', project: PROJECT.name,
    });
    expect(answer.status).toBe(201);
    expect(await projection(answer.json.task.id)).toEqual(expect.objectContaining({
      description: 'from the modal', priority: 'low', project: PROJECT.name, serverWritten: UNTOUCHED,
    }));
  });

  test('the Task board: archive, drag and move menu (PATCH {status})', async () => {
    const taskId = await fixtureTask('d-board');
    for (const status of ['ideas', 'todo', 'archived']) {
      const answer = await call(OWNER, 'PATCH', `/tasks/${taskId}`, { status });
      expect([status, answer.status]).toEqual([status, 200]);
      expect((await projection(taskId)).status).toBe(status);
    }
  });

  test('the Task detail page: each section\'s PATCH, with agentInstructions still ignored rather than refused', async () => {
    const taskId = await fixtureTask('d-detail');
    const patches: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ title: 'detail title' }, { title: 'detail title' }],
      [{ status: 'ideas' }, { status: 'ideas' }],
      [{ status: 'todo' }, { status: 'todo' }],
      [{ priority: 'urgent' }, { priority: 'urgent' }],
      [{ autoStart: true }, { autoStart: true }],
      [{ project: PROJECT.name, phaseId: PHASE }, { project: PROJECT.name, phaseId: PHASE }],
      [{ phaseId: null }, { phaseId: null }],
      [{ tags: ['detail'] }, { tags: ['detail'] }],
      [{ dueAt: '2031-06-01T00:00:00Z' }, { dueAt: '2031-06-01T00:00:00.000000Z' }],
      [{ dueAt: null }, { dueAt: null }],
      [{ executionProfile: null, model: 'detail-model', thinking: 'high', personalityId: GENERALIST },
        { model: 'detail-model', thinking: 'high', personalityId: GENERALIST }],
      [{ links: [{ title: 'Detail', url: 'https://example.com/detail', type: 'reference' }] },
        { links: [['Detail', 'https://example.com/detail']] }],
      [{ subtasks: [{ text: 'detail subtask', status: 'empty' }] }, { subtasks: [['detail subtask', 'empty']] }],
      [{ description: 'detail description' }, { description: 'detail description' }],
      [{ definitionOfDone: ['detail done'] }, { definitionOfDone: ['detail done'] }],
      [{ constraints: ['detail constraint'] }, { constraints: ['detail constraint'] }],
      [{ notes: 'detail notes' }, { notes: 'detail notes' }],
    ];
    for (const [body, expected] of patches) {
      const answer = await call(OWNER, 'PATCH', `/tasks/${taskId}`, body);
      expect([body, answer.status]).toEqual([body, 200]);
      expect([body, await projection(taskId)]).toEqual([body, expect.objectContaining({ ...expected, serverWritten: UNTOUCHED })]);
    }
    const before = await projection(taskId);
    const ignored = await call(OWNER, 'PATCH', `/tasks/${taskId}`, { agentInstructions: 'not a field' });
    expect([ignored.status, await projection(taskId)]).toEqual([200, before]);
  });

  test('the CLI create (POST /tasks), with blockedBy still ignored rather than refused', async () => {
    const answer = await call(WRITER, 'POST', '/tasks', {
      title: `swcols cli create ${tag()}`, status: 'todo', priority: 'normal', project: PROJECT.name, phaseId: PHASE,
      description: 'from the CLI', notes: 'cli notes', dueAt: '2031-07-01T00:00:00Z',
      subtasks: [{ text: 'cli one', status: 'empty' }, { text: 'cli two', status: 'empty' }],
      definitionOfDone: ['cli done'], constraints: ['cli constraint'],
      links: [{ title: 'Linked report', url: 'https://example.com/reports/1', type: 'report' }],
      tags: ['cli'], blockedBy: ['not-a-task'], dependsOn: [], autoStart: false, thinking: 'low', model: 'cli-model',
      personalityId: GENERALIST,
    });
    expect(answer.status).toBe(201);
    expect(await projection(answer.json.task.id)).toEqual(expect.objectContaining({
      status: 'todo', priority: 'normal', project: PROJECT.name, phaseId: PHASE, description: 'from the CLI',
      notes: 'cli notes', dueAt: '2031-07-01T00:00:00.000000Z', subtasks: [['cli one', 'empty'], ['cli two', 'empty']],
      definitionOfDone: ['cli done'], constraints: ['cli constraint'], links: [['Linked report', 'https://example.com/reports/1']],
      tags: ['cli'], dependsOn: [], autoStart: false, thinking: 'low', model: 'cli-model', personalityId: GENERALIST,
      serverWritten: UNTOUCHED,
    }));
  });

  test('the CLI update (PATCH /tasks/:id), sent by the Assignee', async () => {
    const taskId = await assignTo(await fixtureTask('d-cli-update'), WRITER);
    const other = await fixtureTask('d-cli-update-other');
    const answer = await call(WRITER, 'PATCH', `/tasks/${taskId}`, {
      status: 'in-progress', priority: 'low', project: PROJECT.name, phaseId: null, description: 'cli update',
      title: 'cli updated', tags: ['cli-update'], subtasks: [{ text: 'cli update subtask', status: 'empty' }],
      dependsOn: [other], notes: 'cli update notes', dueAt: null, thinking: 'high',
      model: 'cli-update-model', executionProfile: null, autoStart: false, personalityId: GENERALIST,
      links: [], definitionOfDone: ['cli update done'], constraints: ['cli update constraint'],
    });
    expect([answer.status, answer.json?.code, answer.json?.error]).toEqual([200, undefined, undefined]);
    expect(await projection(taskId)).toEqual(expect.objectContaining({
      status: 'in-progress', priority: 'low', project: PROJECT.name, phaseId: null, description: 'cli update',
      title: 'cli updated', tags: ['cli-update'], subtasks: [['cli update subtask', 'empty']], dependsOn: [other],
      notes: 'cli update notes', dueAt: null, thinking: 'high',
      model: 'cli-update-model', autoStart: false, personalityId: GENERALIST, links: [],
      definitionOfDone: ['cli update done'], constraints: ['cli update constraint'], serverWritten: UNTOUCHED,
    }));
  });

  test('the CLI move and the agent hand-off carry role: agent, which is still ignored rather than refused', async () => {
    // Each body is sent with the key to one Task and without it to a twin in
    // the same state: the key changes neither the answer nor what is stored.
    const strip = ({ title: _t, ...rest }: Record<string, unknown>) => rest;
    const withRole = await assignTo(await fixtureTask('d-cli-move'), WRITER);
    const twin = await assignTo(await fixtureTask('d-cli-move-twin'), WRITER);
    for (const body of [{ status: 'in-progress', notes: 'moved by the CLI' }, { status: 'review' }]) {
      const keyed = await call(WRITER, 'PATCH', `/tasks/${withRole}`, { ...body, role: 'agent' });
      const plain = await call(WRITER, 'PATCH', `/tasks/${twin}`, body);
      expect([body, keyed.status, keyed.json?.code, strip(await projection(withRole))])
        .toEqual([body, 200, undefined, strip(await projection(twin))]);
      expect([plain.status, (await projection(twin)).status]).toEqual([200, body.status]);
    }
  });

  test('the CLI phase scaffold (POST /tasks)', async () => {
    const first = await call(WRITER, 'POST', '/tasks', {
      title: `swcols scaffold one ${tag()}`, project: PROJECT.name, phaseId: PHASE, status: 'todo', priority: 'normal',
      tags: ['scaffold'], description: 'seed one', autoStart: true,
    });
    expect(first.status).toBe(201);
    const second = await call(WRITER, 'POST', '/tasks', {
      title: `swcols scaffold two ${tag()}`, project: PROJECT.name, phaseId: PHASE, status: 'ideas', priority: 'normal',
      tags: ['scaffold'], description: 'seed two', autoStart: false, dependsOn: [first.json.task.id],
    });
    expect(second.status).toBe(201);
    expect(await projection(second.json.task.id)).toEqual(expect.objectContaining({
      status: 'ideas', phaseId: PHASE, tags: ['scaffold'], autoStart: false, dependsOn: [first.json.task.id],
      serverWritten: UNTOUCHED,
    }));
  });

  test('the MCP task tools: create, update, move, arm and park', async () => {
    const created = await mcpCall(WRITER, 'relayhall_task_create', {
      title: `swcols mcp lawful ${tag()}`, description: 'over MCP', notes: 'mcp notes', status: 'todo',
      project: PROJECT.name, phaseId: PHASE, idempotencyKey: crypto.randomUUID(),
    });
    expect([mcpFailed(created), mcpText(created).slice(0, 200)]).toEqual([false, expect.stringContaining('Created Task')]);
    const taskId = (await pool.query("SELECT id FROM tasks WHERE description = 'over MCP' ORDER BY created_at DESC LIMIT 1")).rows[0].id;
    const updated = await mcpCall(WRITER, 'relayhall_task_update', {
      task: taskId, title: 'mcp updated', priority: 'high', tags: ['mcp'], definitionOfDone: 'mcp done',
      constraints: 'mcp constraint', notes: 'mcp update notes', dueAt: '2031-08-01T00:00:00Z', thinking: 'medium',
    });
    expect(mcpFailed(updated)).toBe(false);
    expect(await projection(taskId)).toEqual(expect.objectContaining({
      title: 'mcp updated', priority: 'high', tags: ['mcp'], notes: 'mcp update notes', thinking: 'medium',
      dueAt: '2031-08-01T00:00:00.000000Z', phaseId: PHASE, serverWritten: UNTOUCHED,
    }));
    expect(mcpFailed(await mcpCall(WRITER, 'relayhall_task_arm', { task: taskId, idempotencyKey: crypto.randomUUID() }))).toBe(false);
    expect((await projection(taskId)).autoStart).toBe(true);
    expect(mcpFailed(await mcpCall(WRITER, 'relayhall_task_park', { task: taskId, idempotencyKey: crypto.randomUUID() }))).toBe(false);
    expect((await projection(taskId)).autoStart).toBe(false);
    expect(mcpFailed(await mcpCall(WRITER, 'relayhall_task_move', { task: taskId, status: 'ideas' }))).toBe(false);
    expect((await projection(taskId)).status).toBe('ideas');
  });
});
