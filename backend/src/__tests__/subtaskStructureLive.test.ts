/**
 * Card 2bc7b303 (owner ruling E374) — the Subtask structure verbs, measured
 * against a REAL PostgreSQL through the PRODUCTION router and the PRODUCTION
 * MCP route: `relayhall_subtask_create`, `relayhall_subtask_reorder` and
 * `relayhall_subtask_update_text`, over `POST /tasks/:id/subtasks`,
 * `POST /tasks/:id/subtasks/reorder` and
 * `PATCH /tasks/:id/subtasks/by-id/:subtaskId/text`.
 *
 * WHAT IS MEASURED:
 *  (a) the three tools are advertised with their required fields, the retry
 *      token among them;
 *  (b) create appends with a new stable id from the subtasks id sequence and
 *      the requested state, and inserts at a 1-based position without
 *      changing any existing Subtask's id or state; REST and the dashboard
 *      read (GET /tasks/:id) show the new order;
 *  (c) an exact retry with the same key returns the original receipt (same
 *      subtaskId) and adds nothing; a different request with that key is
 *      refused IDEMPOTENCY_KEY_REUSED;
 *  (d) reorder permutes without changing ids, states or text; a list that is
 *      not exactly the current ids (missing, foreign, repeated) is refused and
 *      nothing moves; an exact retry writes one record;
 *  (e) AUTHORIZATION PARITY: for every caller shape, create, reorder and text
 *      are refused exactly where `relayhall_subtask_set` is refused, with the
 *      same HTTP status (no scope, read-only grant, no grant, Agent bound to
 *      another Task), and admitted where it is admitted;
 *  (f) the state rule is the status verb's from empty: an implementation
 *      caller may create in-progress/review/stuck but not skipped or
 *      completed; a Verifier creating a completed Subtask is refused
 *      SUBTASK_COMPLETE_FROM_REVIEW; a completed Task refuses an unfinished
 *      Subtask (TASK_REOPEN_REQUIRED);
 *  (g) the text edit keeps id, position and state, and a retry writes once;
 *  (h) each write emits one task.updated feed event, as the status verb does;
 *  (i) the REST verbs refuse malformed bodies by name before any write.
 *
 * NEVER SKIPS. Without RELAYHALL_TEST_DB_URL it throws, and it refuses a
 * deployment database: this suite writes. Bring the database up with
 * `database/init.sql` and `npm run migrate`, and throw it away afterwards.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: Subtask structure writes are stored rows written through the '
    + 'production router, so this suite never skips. Load database/init.sql into a disposable database, run '
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
  throw new Error('The Subtask structure suite refuses a non-disposable database target');
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
const { principalService } = require('../services/PrincipalService');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');

jest.setTimeout(180_000);

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

async function rpc(token: string, method: string, params: Record<string, unknown>): Promise<any> {
  const response = await fetch(`${origin}${MCP_ROUTE_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return JSON.parse(await response.text());
}

async function mcp(token: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const json = await rpc(token, 'tools/call', { name, arguments: args });
  return {
    text: String(json?.result?.content?.[0]?.text ?? JSON.stringify(json?.error ?? json)),
    isError: Boolean(json?.result?.isError) || Boolean(json?.error),
  };
}

/** The HTTP status a tool error names, or 200 for a success. */
function statusOf(result: { text: string; isError: boolean }): number {
  if (!result.isError) return 200;
  const match = /\(HTTP (\d{3})\)/.exec(result.text);
  return match ? Number(match[1]) : -1;
}

async function rest(token: string, method: string, path: string, body?: unknown, key?: string): Promise<{ status: number; json: any; headers: Headers }> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: response.status, json, headers: response.headers };
}

const tag = (): string => crypto.randomBytes(5).toString('hex');
const key = (): string => `subtask-structure-${crypto.randomUUID()}`;
const SYSTEM_ACTOR = { handle: 'subtask-structure-suite', authMethod: 'system' as const };
const SCOPES = ['tasks:read', 'tasks:write'];

interface Caller { label: string; principalId: string; accountId: string; token: string; restToken: string }

let adminCookie: string;

async function roleAct(principalId: string, role: string): Promise<void> {
  const response = await fetch(`${origin}/principals/${principalId}/role`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ role }),
  });
  expect([role, response.status]).toEqual([role, 200]);
}

/** A Connector (role NULL: Task-lifecycle role agent) under an ordinary Account,
 *  with an MCP credential and a REST credential of the same scopes. */
async function connector(label: string, scopes: string[] = SCOPES): Promise<Caller> {
  const account = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $1, 'active', 'user') RETURNING id`,
    [`ssl-${label}-account-${tag()}`],
  );
  const accountId = String(account.rows[0].id);
  const row = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, $2, 'active', $3, 'Subtask structure suite connector', $4::jsonb) RETURNING id`,
    [`ssl-${label}-${tag()}`, `Subtask structure suite ${label}`, accountId, JSON.stringify({ scopes: 'parent', objects: 'parent' })],
  );
  const principalId = String(row.rows[0].id);
  const issued = await principalService.issueCredential({ principalId, scopes, transport: 'mcp' }, SYSTEM_ACTOR);
  const restIssued = await principalService.issueCredential({ principalId, scopes, transport: 'any' }, SYSTEM_ACTOR);
  return { label, principalId, accountId, token: issued.fullKey, restToken: restIssued.fullKey };
}

async function grant(caller: Caller, taskId: string, verb: 'read' | 'write'): Promise<void> {
  for (const grantee of [caller.accountId, caller.principalId]) {
    await pool.query(
      `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb)
       VALUES ('principal', $1, 'task', $2, $3)`,
      [grantee, taskId, verb],
    );
  }
}

/** A To-Do Task with the named Subtasks (all empty unless a state is given). */
async function taskWith(subtasks: Array<string | [string, string]>, status = 'todo'): Promise<string> {
  const id = String((await pool.query(
    'INSERT INTO tasks (title, status) VALUES ($1, $2) RETURNING id', [`Subtask structure suite ${tag()}`, status],
  )).rows[0].id);
  for (let index = 0; index < subtasks.length; index += 1) {
    const [title, state] = Array.isArray(subtasks[index]) ? subtasks[index] as [string, string] : [subtasks[index] as string, 'empty'];
    await pool.query(
      'INSERT INTO subtasks (task_id, index, title, status, completed_at) VALUES ($1, $2, $3, $4, $5)',
      [id, index, title, state, state === 'completed' ? new Date() : null],
    );
  }
  return id;
}

async function rows(taskId: string): Promise<Array<{ id: string; index: number; title: string; status: string }>> {
  return (await pool.query(
    'SELECT id::text AS id, index, title, status FROM subtasks WHERE task_id = $1 ORDER BY index', [taskId],
  )).rows.map((row: any) => ({ id: String(row.id), index: Number(row.index), title: String(row.title), status: String(row.status) }));
}

async function feedEvents(taskId: string): Promise<number> {
  return Number((await pool.query(
    "SELECT count(*)::int AS n FROM feed_events WHERE object_id = $1 AND name = 'task.updated'", [taskId],
  )).rows[0].n);
}

async function retryRows(operation: string, idempotencyKey: string): Promise<number> {
  return Number((await pool.query(
    'SELECT count(*)::int AS n FROM operation_idempotency_records WHERE operation = $1 AND idempotency_key = $2',
    [operation, idempotencyKey],
  )).rows[0].n);
}

async function bootstrap(caller: Caller): Promise<void> {
  const brief = await mcp(caller.token, 'relayhall_brief_compile', { session: true });
  expect([caller.label, brief.isError]).toEqual([caller.label, false]);
}

function payload(result: { text: string; isError: boolean }): any {
  expect([result.isError, result.text.slice(0, 300)]).toEqual([false, expect.any(String)]);
  return JSON.parse(result.text);
}

let writer: Caller;
let reviewer: Caller;

beforeAll(async () => {
  server = buildApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const admin = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $1, 'active', 'admin') RETURNING id`,
    [`ssl-admin-${tag()}`],
  );
  const minted = await loginSessionService.mint({ principalId: String(admin.rows[0].id) });
  adminCookie = `${SESSION_COOKIE_NAME}=${minted.token}`;
  writer = await connector('writer');
  reviewer = await connector('reviewer');
  await roleAct(reviewer.principalId, 'reviewer');
  for (const caller of [writer, reviewer]) await bootstrap(caller);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('Subtask structure verbs over MCP and REST (card 2bc7b303, E374)', () => {
  it('(a) advertises the three tools with their required fields', async () => {
    const listed = await rpc(writer.token, 'tools/list', {});
    const tools = new Map<string, any>((listed?.result?.tools ?? []).map((tool: any) => [tool.name, tool]));
    expect(tools.get('relayhall_subtask_create')?.inputSchema?.required).toEqual(['task', 'text', 'idempotencyKey']);
    expect(tools.get('relayhall_subtask_create')?.inputSchema?.properties?.status?.enum)
      .toEqual(tools.get('relayhall_subtask_set')?.inputSchema?.properties?.status?.enum);
    expect(tools.get('relayhall_subtask_reorder')?.inputSchema?.required).toEqual(['task', 'order', 'idempotencyKey']);
    expect(tools.get('relayhall_subtask_update_text')?.inputSchema?.required).toEqual(['task', 'subtaskId', 'text', 'idempotencyKey']);
  });

  it('(b) create appends with a new stable id and inserts at a position without moving ids or states', async () => {
    const taskId = await taskWith(['first', ['second', 'in-progress']]);
    await grant(writer, taskId, 'write');
    const before = await rows(taskId);
    const maxId = (await pool.query('SELECT max(id)::bigint AS m FROM subtasks')).rows[0].m;

    const appended = payload(await mcp(writer.token, 'relayhall_subtask_create', { idempotencyKey: key(), task: taskId, text: 'third' }));
    expect(appended.position).toBe(3);
    expect(BigInt(appended.subtaskId) > BigInt(maxId)).toBe(true);
    expect(appended.subtask).toEqual(expect.objectContaining({ id: appended.subtaskId, text: 'third', status: 'empty' }));

    const inserted = payload(await mcp(writer.token, 'relayhall_subtask_create', {
      idempotencyKey: key(), task: taskId, text: 'zeroth', position: 1, status: 'in-progress',
    }));
    expect(inserted.position).toBe(1);
    const after = await rows(taskId);
    expect(after.map((row) => [row.id, row.index, row.title, row.status])).toEqual([
      [inserted.subtaskId, 0, 'zeroth', 'in-progress'],
      [before[0].id, 1, 'first', 'empty'],
      [before[1].id, 2, 'second', 'in-progress'],
      [appended.subtaskId, 3, 'third', 'empty'],
    ]);

    // Through the REST route directly, at a middle position.
    const viaRest = await rest(writer.restToken, 'POST', `/tasks/${taskId}/subtasks`, { text: 'one-and-a-half', position: 3 }, key());
    expect([viaRest.status, viaRest.json.position]).toEqual([201, 3]);
    // The dashboard and REST read show the new order with the same ids.
    const read = await rest(writer.restToken, 'GET', `/tasks/${taskId}`);
    expect(read.status).toBe(200);
    const shown = (read.json.task ?? read.json).subtasks.map((subtask: any) => [subtask.id, subtask.text, subtask.status]);
    expect(shown).toEqual([
      [inserted.subtaskId, 'zeroth', 'in-progress'],
      [before[0].id, 'first', 'empty'],
      [viaRest.json.subtaskId, 'one-and-a-half', 'empty'],
      [before[1].id, 'second', 'in-progress'],
      [appended.subtaskId, 'third', 'empty'],
    ]);

    // A position past the end is refused by name, and nothing is added.
    const tooFar = await mcp(writer.token, 'relayhall_subtask_create', { idempotencyKey: key(), task: taskId, text: 'x', position: 7 });
    expect([tooFar.isError, tooFar.text]).toEqual([true, expect.stringContaining('[INVALID_SUBTASK_POSITION]')]);
    expect((await rows(taskId)).length).toBe(5);
  });

  it('(c) an exact retry returns the original receipt and adds nothing; a changed request with that key is refused', async () => {
    const taskId = await taskWith(['only']);
    await grant(writer, taskId, 'write');
    const token = key();
    const args = { idempotencyKey: token, task: taskId, text: 'retried' };
    const first = await mcp(writer.token, 'relayhall_subtask_create', args);
    const second = await mcp(writer.token, 'relayhall_subtask_create', args);
    expect(payload(second).subtaskId).toBe(payload(first).subtaskId);
    expect(second.text).toBe(first.text);
    expect((await rows(taskId)).map((row) => row.title)).toEqual(['only', 'retried']);
    expect(await retryRows('task.subtask.create', token)).toBe(1);

    const changed = await mcp(writer.token, 'relayhall_subtask_create', { ...args, text: 'different' });
    expect([changed.isError, changed.text]).toEqual([true, expect.stringContaining('IDEMPOTENCY_KEY_REUSED')]);
    expect((await rows(taskId)).length).toBe(2);

    // The token is required on the tool surface.
    const unkeyed = await mcp(writer.token, 'relayhall_subtask_create', { task: taskId, text: 'no token' });
    expect([unkeyed.isError, unkeyed.text]).toEqual([true, expect.stringContaining('idempotencyKey')]);
    expect((await rows(taskId)).length).toBe(2);
  });

  it('(d) reorder permutes without changing ids, states or text; a non-permutation is refused and nothing moves', async () => {
    const taskId = await taskWith([['a', 'review'], 'b', ['c', 'stuck']]);
    const otherTask = await taskWith(['foreign']);
    await grant(writer, taskId, 'write');
    const before = await rows(taskId);
    const order = [before[2].id, before[0].id, before[1].id];
    const token = key();
    const result = payload(await mcp(writer.token, 'relayhall_subtask_reorder', { idempotencyKey: token, task: taskId, order }));
    expect(result.order).toEqual(order);
    const after = await rows(taskId);
    expect(after.map((row) => [row.id, row.title, row.status])).toEqual([
      [before[2].id, 'c', 'stuck'], [before[0].id, 'a', 'review'], [before[1].id, 'b', 'empty'],
    ]);
    const again = await mcp(writer.token, 'relayhall_subtask_reorder', { idempotencyKey: token, task: taskId, order });
    expect(again.isError).toBe(false);
    expect(await retryRows('task.subtask.reorder', token)).toBe(1);

    const foreign = (await rows(otherTask))[0].id;
    const refusals: Array<[string, string[], string]> = [
      ['missing', [after[0].id, after[1].id], 'SUBTASK_ORDER_MISMATCH'],
      ['foreign', [after[0].id, after[1].id, foreign], 'SUBTASK_ORDER_MISMATCH'],
      ['extra', [...after.map((row) => row.id), foreign], 'SUBTASK_ORDER_MISMATCH'],
      ['repeated', [after[0].id, after[0].id, after[1].id], 'INVALID_SUBTASK_ORDER'],
    ];
    for (const [label, badOrder, code] of refusals) {
      const viaRest = await rest(writer.restToken, 'POST', `/tasks/${taskId}/subtasks/reorder`, { order: badOrder }, key());
      expect([label, viaRest.status, viaRest.json.code]).toEqual([label, code === 'INVALID_SUBTASK_ORDER' ? 400 : 409, code]);
    }
    expect(await rows(taskId)).toEqual(after);
  });

  it('(e) create, reorder and text are refused exactly where relayhall_subtask_set is refused', async () => {
    const readOnlyScope = await connector('read-scope', ['tasks:read']);
    const readGrant = await connector('read-grant');
    const outsider = await connector('outsider');
    const shapes: Array<{ caller: Caller; verb: 'read' | 'write' | null }> = [
      { caller: writer, verb: 'write' },
      { caller: reviewer, verb: 'write' },
      { caller: readOnlyScope, verb: 'write' },
      { caller: readGrant, verb: 'read' },
      { caller: outsider, verb: null },
    ];
    for (const caller of [readOnlyScope, readGrant, outsider]) await bootstrap(caller);
    const observed: Array<[string, number, number, number, number]> = [];
    for (const { caller, verb } of shapes) {
      const taskId = await taskWith(['one', 'two']);
      if (verb) await grant(caller, taskId, verb);
      const ids = (await rows(taskId)).map((row) => row.id);
      const set = statusOf(await mcp(caller.token, 'relayhall_subtask_set', { task: taskId, subtaskId: ids[0], status: 'in-progress' }));
      // Reorder before create, so the two-id order is still the Task's full set.
      const reordered = statusOf(await mcp(caller.token, 'relayhall_subtask_reorder', { idempotencyKey: key(), task: taskId, order: [ids[1], ids[0]] }));
      const edited = statusOf(await mcp(caller.token, 'relayhall_subtask_update_text', { idempotencyKey: key(), task: taskId, subtaskId: ids[0], text: 'renamed' }));
      const created = statusOf(await mcp(caller.token, 'relayhall_subtask_create', { idempotencyKey: key(), task: taskId, text: 'added' }));
      observed.push([caller.label, set, created, reordered, edited]);
      if (set !== 200) {
        // Nothing the refused caller sent changed the Task.
        expect([caller.label, (await rows(taskId)).map((row) => [row.title, row.status])])
          .toEqual([caller.label, [['one', 'empty'], ['two', 'empty']]]);
      }
    }
    // Parity, cell by cell: each structure verb answers what the status verb answered.
    for (const [label, set, created, reordered, edited] of observed) {
      expect({ label, created, reordered, edited }).toEqual({ label, created: set, reordered: set, edited: set });
    }
    // Not vacuous: two shapes are admitted and three are refused.
    expect(observed.map(([label, set]) => [label, set === 200])).toEqual([
      ['writer', true], ['reviewer', true], ['read-scope', false], ['read-grant', false], ['outsider', false],
    ]);
  });

  it('(f) the state rule is the status verb\'s from empty, and a completed Task refuses an unfinished Subtask', async () => {
    const taskId = await taskWith(['seed']);
    await grant(writer, taskId, 'write');
    await grant(reviewer, taskId, 'write');
    for (const status of ['in-progress', 'review', 'stuck']) {
      const created = await mcp(writer.token, 'relayhall_subtask_create', { idempotencyKey: key(), task: taskId, text: status, status });
      expect([status, payload(created).subtask.status]).toEqual([status, status]);
    }
    for (const status of ['skipped', 'completed']) {
      const created = await mcp(writer.token, 'relayhall_subtask_create', { idempotencyKey: key(), task: taskId, text: status, status });
      const viaSet = await mcp(writer.token, 'relayhall_subtask_set', {
        task: taskId, subtaskId: (await rows(taskId))[0].id, status, ...(status === 'completed' ? { completionMode: 'owner' } : {}),
      });
      expect([status, statusOf(created)]).toEqual([status, 403]);
      expect([status, statusOf(viaSet)]).toEqual([status, 403]);
    }
    const verifierCompleted = await mcp(reviewer.token, 'relayhall_subtask_create', { idempotencyKey: key(), task: taskId, text: 'done', status: 'completed' });
    expect([verifierCompleted.isError, verifierCompleted.text]).toEqual([true, expect.stringContaining('[SUBTASK_COMPLETE_FROM_REVIEW]')]);
    expect((await rows(taskId)).map((row) => row.title)).toEqual(['seed', 'in-progress', 'review', 'stuck']);

    const completedTask = await taskWith([['finished', 'completed']], 'completed');
    await grant(writer, completedTask, 'write');
    const reopen = await mcp(writer.token, 'relayhall_subtask_create', { idempotencyKey: key(), task: completedTask, text: 'more work' });
    expect([reopen.isError, reopen.text]).toEqual([true, expect.stringContaining('[TASK_REOPEN_REQUIRED]')]);
    expect((await rows(completedTask)).length).toBe(1);
  });

  it('(g) the text edit keeps id, position and state; an exact retry writes once', async () => {
    const taskId = await taskWith([['keep', 'review'], 'other']);
    await grant(writer, taskId, 'write');
    const before = await rows(taskId);
    const token = key();
    const args = { idempotencyKey: token, task: taskId, subtaskId: before[0].id, text: 'kept, renamed' };
    const first = await mcp(writer.token, 'relayhall_subtask_update_text', args);
    const second = await mcp(writer.token, 'relayhall_subtask_update_text', args);
    expect([first.isError, second.isError]).toEqual([false, false]);
    expect(await retryRows('task.subtask.text', token)).toBe(1);
    expect(await rows(taskId)).toEqual([{ ...before[0], title: 'kept, renamed' }, before[1]]);
    const missing = await mcp(writer.token, 'relayhall_subtask_update_text', { idempotencyKey: key(), task: taskId, subtaskId: '2147483000', text: 'x' });
    expect([missing.isError, missing.text]).toEqual([true, expect.stringContaining('(HTTP 404)')]);
  });

  it('(h) each structure write emits one task.updated feed event, as the status verb does', async () => {
    const taskId = await taskWith(['one', 'two']);
    await grant(writer, taskId, 'write');
    const ids = (await rows(taskId)).map((row) => row.id);
    const start = await feedEvents(taskId);
    payload(await mcp(writer.token, 'relayhall_subtask_create', { idempotencyKey: key(), task: taskId, text: 'three' }));
    expect(await feedEvents(taskId)).toBe(start + 1);
    payload(await mcp(writer.token, 'relayhall_subtask_reorder', { idempotencyKey: key(), task: taskId, order: [ids[1], ids[0], (await rows(taskId))[2].id] }));
    expect(await feedEvents(taskId)).toBe(start + 2);
    expect((await mcp(writer.token, 'relayhall_subtask_update_text', { idempotencyKey: key(), task: taskId, subtaskId: ids[0], text: 'one!' })).isError).toBe(false);
    expect(await feedEvents(taskId)).toBe(start + 3);
    expect((await mcp(writer.token, 'relayhall_subtask_set', { task: taskId, subtaskId: ids[0], status: 'in-progress' })).isError).toBe(false);
    expect(await feedEvents(taskId)).toBe(start + 4);
  });

  it('(i) the REST verbs refuse malformed bodies by name before any write', async () => {
    const taskId = await taskWith(['one']);
    await grant(writer, taskId, 'write');
    const subtaskId = (await rows(taskId))[0].id;
    const cases: Array<[string, string, string, unknown, number, string]> = [
      ['empty text', 'POST', `/tasks/${taskId}/subtasks`, { text: '   ' }, 400, 'INVALID_SUBTASK_TEXT'],
      ['long text', 'POST', `/tasks/${taskId}/subtasks`, { text: 'x'.repeat(1001) }, 400, 'INVALID_SUBTASK_TEXT'],
      ['zero position', 'POST', `/tasks/${taskId}/subtasks`, { text: 'x', position: 0 }, 400, 'INVALID_SUBTASK_POSITION'],
      ['bad status', 'POST', `/tasks/${taskId}/subtasks`, { text: 'x', status: 'done' }, 400, 'INVALID_SUBTASK_STATUS'],
      ['unknown field', 'POST', `/tasks/${taskId}/subtasks`, { text: 'x', id: '9' }, 400, 'UNKNOWN_FIELD'],
      ['order not array', 'POST', `/tasks/${taskId}/subtasks/reorder`, { order: subtaskId }, 400, 'INVALID_SUBTASK_ORDER'],
      ['order bad id', 'POST', `/tasks/${taskId}/subtasks/reorder`, { order: ['abc'] }, 400, 'INVALID_SUBTASK_ORDER'],
      ['text bad id', 'PATCH', `/tasks/${taskId}/subtasks/by-id/abc/text`, { text: 'x' }, 400, 'INVALID_SUBTASK_ID'],
      ['text empty', 'PATCH', `/tasks/${taskId}/subtasks/by-id/${subtaskId}/text`, { text: '' }, 400, 'INVALID_SUBTASK_TEXT'],
    ];
    for (const [label, method, path, body, status, code] of cases) {
      const answer = await rest(writer.restToken, method, path, body);
      expect([label, answer.status, answer.json.code]).toEqual([label, status, code]);
    }
    expect((await rows(taskId)).map((row) => row.title)).toEqual(['one']);
  });
});
