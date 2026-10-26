/**
 * Card ab8f78e9 — the per-session MCP ACTION LOG (owner rulings E91, E89 (c)),
 * measured against a REAL PostgreSQL through the PRODUCTION MCP server and the
 * PRODUCTION router.
 *
 * A Connector that declared a telemetry tier and works through the board's
 * MCP server gets an MCP-derived session (card 35b73092); every admitted tool
 * call it makes inside that session now also adds ONE row to the session's
 * action log, and the Agent sessions page shows it when the session row is
 * opened. This suite drives real `tools/call` requests through `POST /mcp`
 * with minted credentials and reads the log back the way the page does —
 * `GET /telemetry/sessions/:sessionRef` — as each Account.
 *
 * WHAT IS MEASURED, by test:
 *  L1  a real call makes exactly ONE row, under the caller's session, with the
 *      tool, the allowlisted target, ok and a duration; the bootstrap call is
 *      the session's first row;
 *  L2  an error call records its CLOSED code (not_found from the board,
 *      tool_refused from the tool) and never a message;
 *  L3  no argument is ever stored: a secret-looking marker sent in arguments
 *      reaches the Task stream (positive control) and no action-log row;
 *  L4  a tool that is not allowlisted records no target although it was sent
 *      a UUID;
 *  L5  the owner reads the log on the session point route, newest first; a
 *      reader who cannot read the session gets the same 404 as for nothing and
 *      no rows; a row written under ANOTHER Account for the same session is
 *      not shown to the owner (the per-row narrowing);
 *  L6  the retention sweep removes rows past the bound and ONLY those, with
 *      its own receipt and an evidence hash over the removed ids;
 *  L7  a caller that may not be shown, and a call the bootstrap gate refused,
 *      write no row;
 *  L8  a failed log write never fails the tool call.
 *
 * NEVER SKIPS. Without RELAYHALL_TEST_DB_URL it throws, and it refuses a
 * deployment database: this suite writes. Bring the database up with
 * `database/init.sql` and `npm run migrate`, and throw it away afterwards.
 *
 * RED PROOF ON MAIN. The log module is required DEFENSIVELY and the table is
 * read only when it exists, so on a tree without them this file still loads
 * and every behaviour fails on its own assertion rather than on an import or a
 * missing relation.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

// ─────────────────────────── the database contract ───────────────────────────

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the MCP action log is stored rows read back through the '
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
  throw new Error('The MCP action log suite refuses a non-disposable database target');
}

Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: TEST_DB_NAME,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
});
process.env.RELAYHALL_TELEMETRY_PEPPERS = process.env.RELAYHALL_TELEMETRY_PEPPERS
  || JSON.stringify({ testpepper: Buffer.alloc(32, 13).toString('base64') });
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
const { resetTelemetryPepperCache } = require('../utils/telemetryPepper');
const { telemetryRetentionService } = require('../services/TelemetryRetentionService');
const { telemetryEventRetentionDays } = require('../utils/telemetryRetention');
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');

jest.setTimeout(240_000);

/** The log writer, when this tree has one (the red proof runs without it). */
function logModule(): any {
  try { return require('../services/McpActionLog'); } catch { return null; }
}

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

interface Caller { label: string; principalId: string; headers: Record<string, string> }
interface Answer { status: number; json: any }

async function call(who: Caller, method: string, routePath: string, body?: unknown,
  extra: Record<string, string> = {}): Promise<Answer> {
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

async function mcp(token: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const response = await fetch(`${origin}${MCP_ROUTE_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const json: any = JSON.parse(await response.text());
  return {
    text: String(json?.result?.content?.[0]?.text ?? JSON.stringify(json?.error ?? json)),
    isError: Boolean(json?.result?.isError) || Boolean(json?.error),
  };
}

const tag = (): string => crypto.randomBytes(5).toString('hex');
const idemKey = (label: string): string => `mal-${label}-${crypto.randomUUID()}`;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ─────────────────────────────── fixtures ────────────────────────────────────

const SYSTEM_ACTOR = { handle: 'mcp-action-log-suite', authMethod: 'system' as const };
const MCP_SCOPES = ['tasks:read', 'tasks:write', 'principals:read', 'reports:read', 'reports:write'];

interface Tenant { accountId: string; reader: Caller; projectId: string }
interface McpConnector { principalId: string; credentialId: string; token: string; displayName: string }

async function makeTenant(label: string): Promise<Tenant> {
  const account = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $2, 'active', 'user') RETURNING id`,
    [`mal-${label}-${tag()}`, `MCP action log suite ${label}`],
  );
  const accountId = String(account.rows[0].id);
  const minted = await loginSessionService.mint({ principalId: accountId });
  const reader = { label, principalId: accountId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
  const project = await call(reader, 'POST', '/projects', { name: `MCP action log suite ${label} ${tag()}` });
  expect(project.status).toBe(201);
  return { accountId, reader, projectId: String(project.json.project.id) };
}

/** A Connector under `accountId` whose registry descriptor declares `tier`. */
async function makeConnector(accountId: string, displayName: string, tier: 'presence' | 'full' | 'none'): Promise<McpConnector> {
  const principal = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, $2, 'active', $3, 'MCP action log suite connector', $4::jsonb) RETURNING id`,
    [`mal-connector-${tag()}`, displayName, accountId, JSON.stringify({ scopes: 'parent', objects: 'parent' })],
  );
  const principalId = String(principal.rows[0].id);
  const descriptor = { telemetry: { tier, products: ['claude-code'] } };
  const service = await pool.query(
    `INSERT INTO services (slug, name, description, kind, status, principal_id, current_descriptor_version)
     VALUES ($1, $2, 'MCP action log suite', 'connector', 'published', $3, 1) RETURNING id`,
    [`mal-conn-${tag()}`, displayName, principalId],
  );
  await pool.query(
    `INSERT INTO service_descriptor_versions (service_id, version, descriptor, content_hash, created_by_principal_id)
     VALUES ($1, 1, $2::jsonb, $3, NULL)`,
    [String(service.rows[0].id), JSON.stringify(descriptor),
      crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex')],
  );
  const issued = await principalService.issueCredential(
    { principalId, scopes: MCP_SCOPES, transport: 'mcp' }, SYSTEM_ACTOR);
  return { principalId, credentialId: issued.credentialId, token: issued.fullKey, displayName };
}

async function armedTask(owner: Tenant, title: string): Promise<string> {
  const created = await call(owner.reader, 'POST', '/tasks',
    { title, description: 'MCP action log suite', status: 'todo', project: owner.projectId });
  expect(created.status).toBe(201);
  const id = String(created.json?.task?.id);
  const armed = await call(owner.reader, 'PATCH', `/tasks/${id}`, { autoStart: true }, { 'Idempotency-Key': idemKey('arm') });
  expect(armed.status).toBe(200);
  return id;
}

// ─────────────────────────────── readers ─────────────────────────────────────

interface LogRow {
  id: string; session_ref: string; connector_id: string; account_id: string; agent_id: string | null;
  tool_name: string; target_type: string | null; target_id: string | null; outcome: string;
  error_code: string | null; duration_ms: number; observed_at: Date; row_text: string;
}

async function tableExists(): Promise<boolean> {
  const found = await pool.query("SELECT to_regclass('public.mcp_action_log') IS NOT NULL AS present");
  return Boolean(found.rows[0].present);
}

/** Every stored row for a Connector, oldest first — empty on a tree without the table. */
async function logRows(connectorId: string): Promise<LogRow[]> {
  if (!(await tableExists())) return [];
  const rows = await pool.query(
    `SELECT a.*, to_jsonb(a)::text AS row_text FROM mcp_action_log a
      WHERE a.connector_id = $1 ORDER BY a.observed_at, a.id`, [connectorId]);
  return rows.rows.map((row: any) => ({ ...row, id: String(row.id), duration_ms: Number(row.duration_ms) }));
}

/**
 * The rows once the fire-and-forget writer has nothing outstanding and two
 * reads agree. The writer is asked directly (it lives in this process), so the
 * wait is on the thing itself, not on a guess about how long it takes.
 */
async function settledRows(connectorId: string): Promise<LogRow[]> {
  let previous = await logRows(connectorId);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await sleep(60);
    const outstanding = logModule()?.mcpActionLog?.stats().inFlight ?? 0;
    const current = await logRows(connectorId);
    if (outstanding === 0 && current.length === previous.length) return current;
    previous = current;
  }
  throw new Error('the action-log writer never settled');
}

/** The caller's current MCP session reference, from its own envelope rows. */
async function sessionRefOf(connectorId: string): Promise<string> {
  const rows = await pool.query(
    `SELECT session_ref FROM session_events
      WHERE connector_id = $1 AND source_product = 'mcp' AND schema_version IS NOT NULL
      ORDER BY observed_at DESC, event_id DESC LIMIT 1`, [connectorId]);
  expect(rows.rows).toHaveLength(1);
  return String(rows.rows[0].session_ref);
}

async function sessionDetail(reader: Caller, sessionRef: string, connectorId: string): Promise<Answer> {
  return call(reader, 'GET',
    `/telemetry/sessions/${encodeURIComponent(sessionRef)}?connectorId=${connectorId}&sourceProduct=mcp`);
}

// ────────────────────────────── the world ────────────────────────────────────

let A: Tenant;
let B: Tenant;
let ALPHA: McpConnector;   // Account A, tier presence: the measured caller
let BRAVO: McpConnector;   // Account B, tier full: the other Account's caller
let SILENT: McpConnector;  // Account A, tier none
let LATE: McpConnector;    // Account A, tier presence, never bootstrapped
let TASK: string;
const MARKER = `rh_live_${crypto.randomBytes(8).toString('hex')}.ActionLogSecretMarker`;
/**
 * The retry keys of this suite's marker-carrying calls (card 8c9dcc0f). L3's
 * append is keyed (the tool requires a key), so the retry contract stores its
 * answer, which echoes the marker, in operation_idempotency_records for a day.
 * The job database is shared, and the retry-contract suite that runs later on
 * it scans that table for credential material (idempotencyContract 4.1.11), so
 * afterAll removes exactly these rows, by scope, operation and key, and fails
 * the suite if any row there still carries the marker.
 */
const MARKER_KEYS: string[] = [];

beforeAll(async () => {
  resetTelemetryPepperCache();
  await new Promise<void>((resolve) => { server = buildApp().listen(0, '127.0.0.1', resolve); });
  server.keepAliveTimeout = 0;
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const probe = await pool.query('SELECT current_database() AS db');
  expect(String(probe.rows[0].db)).toBe(TEST_DB_NAME);

  A = await makeTenant('alpha');
  B = await makeTenant('bravo');
  ALPHA = await makeConnector(A.accountId, 'Action Log Alpha', 'presence');
  BRAVO = await makeConnector(B.accountId, 'Action Log Bravo', 'full');
  SILENT = await makeConnector(A.accountId, 'Action Log Silent', 'none');
  LATE = await makeConnector(A.accountId, 'Action Log Late', 'presence');
  TASK = await armedTask(A, `MCP action log ${tag()}`);
});

afterAll(async () => {
  try {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (ALPHA && MARKER_KEYS.length > 0) {
      await pool.query(
        `DELETE FROM operation_idempotency_records
          WHERE scope = $1 AND operation = 'task.stream.append' AND idempotency_key = ANY($2::text[])`,
        [`cred:${ALPHA.credentialId}`, MARKER_KEYS]);
    }
    const left = await pool.query(
      'SELECT count(*)::int AS n FROM operation_idempotency_records t WHERE to_jsonb(t)::text LIKE $1', [`%${MARKER}%`]);
    if (Number(left.rows[0].n) !== 0) {
      throw new Error(`${left.rows[0].n} retry record(s) still carry the L3 marker after the suite's own cleanup`);
    }
  } finally {
    await pool.end();
  }
});

// ═══════════════════════════ L1 one call, one row ════════════════════════════

describe('L1 a real MCP call makes exactly one row under the caller session', () => {
  it('L1: the bootstrap is the first row; one task_get adds exactly one row with its tool, target, ok and duration', async () => {
    expect((await mcp(ALPHA.token, 'relayhall_brief_compile', { session: true })).isError).toBe(false);
    const afterBootstrap = await settledRows(ALPHA.principalId);
    const sessionRef = await sessionRefOf(ALPHA.principalId);
    expect(afterBootstrap.map((row) => ({ tool: row.tool_name, outcome: row.outcome, target: row.target_type, ref: row.session_ref })))
      .toEqual([{ tool: 'relayhall_brief_compile', outcome: 'ok', target: null, ref: sessionRef }]);

    const read = await mcp(ALPHA.token, 'relayhall_task_get', { task: TASK });
    expect(read.isError).toBe(false);
    const rows = await settledRows(ALPHA.principalId);
    expect(rows).toHaveLength(2);
    const row = rows[1];
    expect({
      session_ref: row.session_ref, connector_id: row.connector_id, account_id: row.account_id, agent_id: row.agent_id,
      tool_name: row.tool_name, target_type: row.target_type, target_id: row.target_id,
      outcome: row.outcome, error_code: row.error_code,
    }).toEqual({
      session_ref: sessionRef, connector_id: ALPHA.principalId, account_id: A.accountId, agent_id: null,
      tool_name: 'relayhall_task_get', target_type: 'task', target_id: TASK, outcome: 'ok', error_code: null,
    });
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    expect(row.duration_ms).toBeLessThan(60_000);
    expect(Math.abs(new Date(row.observed_at).getTime() - Date.now())).toBeLessThan(120_000);
    // The credential id lands nowhere in the row.
    expect(row.row_text).not.toContain(ALPHA.credentialId);
  });
});

// ═════════════════════════════ L2 closed codes ═══════════════════════════════

describe('L2 an error call records its closed code, never a message', () => {
  it('L2: a Task that does not exist is not_found with its target; a malformed id records no target; a tool-side refusal is tool_refused', async () => {
    const before = (await settledRows(ALPHA.principalId)).length;
    const absent = crypto.randomUUID();
    const missing = await mcp(ALPHA.token, 'relayhall_task_get', { task: absent });
    const malformed = await mcp(ALPHA.token, 'relayhall_task_get', { task: 'not-a-task-id' });
    // The tool refuses an update that names nothing to change before the board is asked.
    const empty = await mcp(ALPHA.token, 'relayhall_task_update', { task: TASK });
    expect([missing.isError, malformed.isError, empty.isError]).toEqual([true, true, true]);
    expect(empty.text).toContain('Nothing to update');
    const rows = (await settledRows(ALPHA.principalId)).slice(before);
    expect(rows.map((row) => ({ tool: row.tool_name, outcome: row.outcome, code: row.error_code, type: row.target_type, id: row.target_id })))
      .toEqual([
        { tool: 'relayhall_task_get', outcome: 'error', code: 'not_found', type: 'task', id: absent },
        { tool: 'relayhall_task_get', outcome: 'error', code: 'not_found', type: null, id: null },
        { tool: 'relayhall_task_update', outcome: 'error', code: 'tool_refused', type: 'task', id: TASK },
      ]);
    for (const row of rows) {
      expect(row.row_text).not.toMatch(/HTTP|visible to you|Nothing to update|not-a-task-id/);
    }
  });
});

// ═══════════════════════ L3 no argument is ever stored ═══════════════════════

describe('L3 no argument is ever stored', () => {
  it('L3: a secret-looking marker in the arguments reaches the Task stream and no action-log row', async () => {
    const before = (await settledRows(ALPHA.principalId)).length;
    const markerKey = `${MARKER}-key`;
    MARKER_KEYS.push(markerKey);
    const appended = await mcp(ALPHA.token, 'relayhall_task_stream_append',
      { task: TASK, content: `note carrying ${MARKER}`, idempotencyKey: markerKey });
    const rows = (await settledRows(ALPHA.principalId)).slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool_name: 'relayhall_task_stream_append', target_id: TASK });
    // Nowhere in the whole table, in any column.
    const hits = await pool.query(
      'SELECT count(*)::int AS n FROM mcp_action_log a WHERE to_jsonb(a)::text LIKE $1', [`%${MARKER}%`]);
    expect(Number(hits.rows[0].n)).toBe(0);
    // POSITIVE CONTROL: the scan sees a marker that IS there — the append
    // stored it in the Task stream, so the same LIKE finds it in that table.
    expect(appended.isError).toBe(false);
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
    const holding: string[] = [];
    for (const table of tables.rows.map((r: any) => String(r.table_name))) {
      const found = await pool.query(`SELECT count(*)::int AS n FROM "${table}" t WHERE to_jsonb(t)::text LIKE $1`, [`%${MARKER}%`]);
      if (Number(found.rows[0].n) > 0) holding.push(table);
    }
    expect(holding.length).toBeGreaterThan(0);
    expect(holding).not.toContain('mcp_action_log');
  });
});

// ══════════════════ L4 a non-allowlisted tool records no target ══════════════

describe('L4 a tool that is not allowlisted records no target', () => {
  it('L4: report_search sent a project UUID records the call and no target', async () => {
    const before = (await settledRows(ALPHA.principalId)).length;
    await mcp(ALPHA.token, 'relayhall_report_search', { projectId: A.projectId });
    const rows = (await settledRows(ALPHA.principalId)).slice(before);
    expect(rows.map((row) => ({ tool: row.tool_name, type: row.target_type, id: row.target_id })))
      .toEqual([{ tool: 'relayhall_report_search', type: null, id: null }]);
  });
});

// ═════════════════════════ L5 who may read the log ═══════════════════════════

describe('L5 the log is visible exactly to the readers of the session', () => {
  it('L5a: the owner reads the log on the session point route, newest first, equal to the stored rows', async () => {
    const sessionRef = await sessionRefOf(ALPHA.principalId);
    const stored = await settledRows(ALPHA.principalId);
    const detail = await sessionDetail(A.reader, sessionRef, ALPHA.principalId);
    expect(detail.status).toBe(200);
    const actions = detail.json.actions as any[];
    expect(Array.isArray(actions)).toBe(true);
    expect(actions.map((a) => [a.toolName, a.targetType, a.targetId, a.outcome, a.errorCode, a.durationMs]))
      .toEqual([...stored].reverse().map((r) => [r.tool_name, r.target_type, r.target_id, r.outcome, r.error_code, r.duration_ms]));
    expect(detail.json.actionsTruncated).toBe(false);
    // The read is a projection of closed values: no other field rides it.
    for (const action of actions) {
      expect(Object.keys(action).sort()).toEqual(['durationMs', 'errorCode', 'observedAt', 'outcome', 'targetId', 'targetType', 'toolName']);
    }
  });

  it('L5b: another Account reading the session gets the same 404 as for a session that does not exist, and no rows', async () => {
    const sessionRef = await sessionRefOf(ALPHA.principalId);
    const foreign = await sessionDetail(B.reader, sessionRef, ALPHA.principalId);
    const nothing = await sessionDetail(B.reader, `rhp_${'z'.repeat(27)}`, ALPHA.principalId);
    expect(foreign.status).toBe(404);
    expect({ status: foreign.status, body: foreign.json }).toEqual({ status: nothing.status, body: nothing.json });
    expect(JSON.stringify(foreign.json)).not.toContain('relayhall_task_get');
    expect(foreign.json?.actions).toBeUndefined();
  });

  it('L5c: a row written under ANOTHER Account for the same session is not shown to the owner', async () => {
    const sessionRef = await sessionRefOf(ALPHA.principalId);
    const before = await sessionDetail(A.reader, sessionRef, ALPHA.principalId);
    expect(before.status).toBe(200);
    // The re-parented-Connector case: the same (Connector, session) carrying a
    // row whose own Account is B. A must not see B's row; the narrowing is per
    // row, exactly as on the session's envelope rows.
    await pool.query(
      `INSERT INTO mcp_action_log (session_ref, connector_id, account_id, agent_id, tool_name, outcome, duration_ms)
       VALUES ($1, $2, $3, NULL, 'relayhall_phase_list', 'ok', 1)`, [sessionRef, ALPHA.principalId, B.accountId]);
    const after = await sessionDetail(A.reader, sessionRef, ALPHA.principalId);
    expect(after.status).toBe(200);
    expect((after.json.actions as any[]).map((a) => a.toolName)).not.toContain('relayhall_phase_list');
    expect((after.json.actions as any[]).length).toBe((before.json.actions as any[]).length);
  });
});

// ═════════════════════════════ L6 retention ══════════════════════════════════

describe('L6 the retention sweep removes rows past the bound, and only those', () => {
  it('L6: rows just past the bound go with a receipt over their ids; rows just inside it and today stay', async () => {
    const sessionRef = await sessionRefOf(ALPHA.principalId);
    const days = telemetryEventRetentionDays();
    expect(days).toBe(90);
    const now = new Date();
    const at = (offsetMs: number): Date => new Date(now.getTime() - days * 86_400_000 + offsetMs);
    const insert = async (observedAt: Date): Promise<string> => String((await pool.query(
      `INSERT INTO mcp_action_log (session_ref, connector_id, account_id, tool_name, outcome, duration_ms, observed_at)
       VALUES ($1, $2, $3, 'relayhall_task_get', 'ok', 1, $4) RETURNING id`,
      [sessionRef, ALPHA.principalId, A.accountId, observedAt])).rows[0].id);
    const expired = [await insert(at(-60_000)), await insert(at(-86_400_000))];
    const kept = [await insert(at(60_000)), await insert(at(86_400_000))];
    const today = (await settledRows(ALPHA.principalId)).filter((row) => !expired.includes(row.id) && !kept.includes(row.id));
    expect(today.length).toBeGreaterThan(0);

    // Anything else in this disposable database that is already past the bound
    // goes too; the receipt must name exactly what went.
    const due = await pool.query('SELECT id FROM mcp_action_log WHERE observed_at < $1 ORDER BY id', [at(0)]);
    const dueIds = due.rows.map((row: any) => String(row.id));
    expect(dueIds).toEqual(expect.arrayContaining(expired));

    const sweep = await telemetryRetentionService.sweep(now);
    const receipt = sweep.receipts.find((r: any) => r.payloadClass === 'mcp_action_log');
    expect(receipt).toBeDefined();
    expect(receipt.removed).toBe(dueIds.length);
    const ordered = [...dueIds].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
    expect(receipt.evidenceHash).toBe(crypto.createHash('sha256').update(ordered.join(',')).digest('hex'));

    const left = new Set((await logRows(ALPHA.principalId)).map((row) => row.id));
    for (const id of expired) expect({ id, present: left.has(id) }).toEqual({ id, present: false });
    for (const id of [...kept, ...today.map((row) => row.id)]) expect({ id, present: left.has(id) }).toEqual({ id, present: true });
    const stored = await pool.query(
      `SELECT payload_class, action, copies_removed FROM session_retention_receipts WHERE receipt_id = $1`, [receipt.receiptId]);
    expect(stored.rows).toEqual([{ payload_class: 'mcp_action_log', action: 'expired', copies_removed: dueIds.length }]);
  });
});

// ═══════════════════ L7 nothing for a caller that may not be shown ═══════════

describe('L7 a caller that may not be shown, and a refused call, write nothing', () => {
  it('L7: a tier-none Connector writes no row; a work call before bootstrap is refused and writes no row', async () => {
    expect((await mcp(SILENT.token, 'relayhall_brief_compile', { session: true })).isError).toBe(false);
    await mcp(SILENT.token, 'relayhall_task_get', { task: TASK });
    expect(await settledRows(SILENT.principalId)).toEqual([]);

    const refused = await mcp(LATE.token, 'relayhall_task_stream_append',
      { task: TASK, content: 'before bootstrap', idempotencyKey: idemKey('late') });
    expect(refused.isError).toBe(true);
    expect(await settledRows(LATE.principalId)).toEqual([]);
    // Positive control: the same Connector, once bootstrapped, does write.
    expect((await mcp(LATE.token, 'relayhall_brief_compile', { session: true })).isError).toBe(false);
    expect((await settledRows(LATE.principalId)).map((row) => row.tool_name)).toEqual(['relayhall_brief_compile']);
    // And the other Account's Connector writes only under its own Account.
    expect((await mcp(BRAVO.token, 'relayhall_brief_compile', { session: true })).isError).toBe(false);
    expect((await settledRows(BRAVO.principalId)).map((row) => row.account_id)).toEqual([B.accountId]);
  });
});

// ═══════════════════ L8 a failed write never fails the tool ══════════════════

describe('L8 a failed log write never fails the tool call', () => {
  it('L8: with the log table unavailable the call still answers, and writes resume when it returns', async () => {
    const before = (await settledRows(ALPHA.principalId)).length;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await pool.query('ALTER TABLE mcp_action_log RENAME TO mcp_action_log_unavailable');
    let answer!: { text: string; isError: boolean };
    let printed = '';
    try {
      answer = await mcp(ALPHA.token, 'relayhall_task_get', { task: TASK });
      await sleep(300);
      const outstanding = logModule()?.mcpActionLog?.stats().inFlight ?? 0;
      expect(outstanding).toBe(0);
    } finally {
      await pool.query('ALTER TABLE mcp_action_log_unavailable RENAME TO mcp_action_log');
      printed = warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
      warn.mockRestore();
    }
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain(TASK.slice(0, 8));
    // Whatever the failure logged, it carries none of the row's values.
    expect(printed).not.toContain(TASK);
    expect(printed).not.toContain(ALPHA.principalId);
    expect((await settledRows(ALPHA.principalId)).length).toBe(before);
    await mcp(ALPHA.token, 'relayhall_task_get', { task: TASK });
    expect((await settledRows(ALPHA.principalId)).length).toBe(before + 1);
  });
});
