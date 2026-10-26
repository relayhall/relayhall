/**
 * Card 35b73092 — MCP-DERIVED AGENT SESSIONS, measured against a REAL
 * PostgreSQL through the PRODUCTION MCP server and the PRODUCTION router.
 *
 * A Connector that works through the board's MCP server and declared a
 * telemetry tier appears on the Agent sessions page from its own tool calls:
 * a session row on bootstrap, a bounded heartbeat, a Task link while it holds
 * a Task in progress, `stale` after the shipped window and `finished` when the
 * credential bootstraps again or its bootstrap lapses. This suite drives every
 * one of those through `POST /mcp` with real minted credentials and reads the
 * result back the way the page does — `GET /telemetry/sessions`,
 * `GET /telemetry/presence` and the Task chip route — as each Account.
 *
 * WHAT IS MEASURED, by test:
 *  (a) bootstrap -> exactly one `mcp` session row for the caller, carrying the
 *      Connector's display name; the other Account sees none;
 *  (b) many calls inside one heartbeat bucket -> ONE heartbeat, under
 *      concurrency too; the next bucket -> one more;
 *  (c) holding a Task in progress -> a link frame under the CALLER's
 *      principal and the Task chip active; release and finish clear it with
 *      an idle frame, a frame the five-second gate refuses is recovered, and
 *      nothing re-links a Task the caller no longer holds;
 *  (d) clock-controlled: silence past the shipped window -> stale; a new
 *      bootstrap -> the old row finished and a new one active; a lapsed
 *      bootstrap -> finished at the next contact, and no row for a refused
 *      call;
 *  (e) a second Account's Connector never touches the first's rows, and the
 *      first HAS rows;
 *  (f) A17.7 still holds at the ingest route, and no MCP argument can steer
 *      the owner of what this path writes;
 *  (g) ZERO SIDE EFFECTS: the whole schema around a call changes only in the
 *      four telemetry tables (plus the bootstrap record a bootstrap writes);
 *  (h) negatives: tier `none`, an unregistered (Account -> service) chain and
 *      pre-bootstrap introspection write nothing, and nothing is audited;
 *  (i) the taskId-brief arm of the link: a brief alone links a held Task in
 *      the SAME bucket (no heartbeat reconcile can have done it), a brief
 *      naming the other of two held Tasks moves the link and it SURVIVES the
 *      following reconciles although `updated_at` favours the other, and a
 *      switch the frame gate refuses is not retried until the brief is
 *      compiled again.
 *
 * NEVER SKIPS. Without RELAYHALL_TEST_DB_URL it throws, and it refuses a
 * deployment database: this suite writes. Bring the database up with
 * `database/init.sql` and `npm run migrate`, and throw it away afterwards.
 *
 * CLOCK. The observer's clock is driven through its test seam, so a session
 * moves through its states without sleeping; the projection routes read the
 * wall clock, so "stale" is produced by writing a session in the past. The
 * only real waits are the five-second frame gate (a few seconds, twice).
 *
 * RED PROOF ON MAIN. The observer module is required DEFENSIVELY (see
 * `observerClock`), so on a tree without it this file still loads and every
 * behaviour fails on its own assertion rather than on an import.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

// ─────────────────────────── the database contract ───────────────────────────

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: MCP-derived sessions are stored telemetry rows read back '
    + 'through the production router, so this suite never skips. Load database/init.sql into a disposable '
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
  throw new Error('The MCP-derived sessions suite refuses a non-disposable database target');
}

// The production pool reads DB_* at import time, so the environment is pinned
// BEFORE anything is required.
Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: TEST_DB_NAME,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
});
// A deterministic TEST pepper, as the projection suite pins one.
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
const { TELEMETRY_STALE_MS, TELEMETRY_MIN_FRAME_INTERVAL_MS } = require('../services/TelemetryService');
const { presenceWriter } = require('../db/boundedPresenceWrites');
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');
const { BOOTSTRAP_REFUSAL_MARKER } = require('../mcp/bootstrapGate');

jest.setTimeout(240_000);

/**
 * The cadence under test. Read from the observer when it exists; on a tree
 * without it (the red proof) the suite falls back to the value this card
 * ships, so the bucket arithmetic still runs and the assertions do the failing.
 */
function observerModule(): any {
  try { return require('../services/McpSessionTelemetry'); } catch { return null; }
}
const HEARTBEAT_MS: number = observerModule()?.MCP_HEARTBEAT_INTERVAL_MS ?? 60_000;

/** Drive the observer's clock; `null` restores the wall clock. */
function observerClock(clock: (() => Date) | null): void {
  observerModule()?.mcpSessionTelemetry?.setClockForTests(clock);
}
let NOW = new Date();
const at = (date: Date): void => { NOW = date; observerClock(() => NOW); };

// Card ab8f78e9 added the session's ACTION LOG: every admitted call inside a
// live session also writes one `mcp_action_log` row, a telemetry table of the
// same observation (never read by a tool, never authority).
const TELEMETRY_TABLES = ['session_events', 'telemetry_raw_blobs', 'telemetry_frames', 'telemetry_rate_limits', 'mcp_action_log'];

// ──────────────────────────────── the app ────────────────────────────────────

let server: http.Server;
let origin: string;

function buildApp(): any {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  // The MCP ingress outside the REST funnel, exactly as server.ts mounts it.
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

/** One JSON-RPC tools/call over the REAL `/mcp` route, as a stock client makes it. */
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
const idemKey = (label: string): string => `mds-${label}-${crypto.randomUUID()}`;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ─────────────────────────────── fixtures ────────────────────────────────────

const SYSTEM_ACTOR = { handle: 'mcp-derived-sessions-suite', authMethod: 'system' as const };
const MCP_SCOPES = ['tasks:read', 'tasks:write', 'principals:read', 'reports:read', 'reports:write'];

interface Tenant { accountId: string; reader: Caller; projectId: string }
interface McpConnector { principalId: string; credentialId: string; token: string; displayName: string }

async function makeTenant(label: string): Promise<Tenant> {
  const account = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $2, 'active', 'user') RETURNING id`,
    [`mds-${label}-${tag()}`, `MCP sessions suite ${label}`],
  );
  const accountId = String(account.rows[0].id);
  const minted = await loginSessionService.mint({ principalId: accountId });
  const reader = { label, principalId: accountId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
  const project = await call(reader, 'POST', '/projects', { name: `MCP sessions suite ${label} ${tag()}` });
  expect(project.status).toBe(201);
  return { accountId, reader, projectId: String(project.json.project.id) };
}

/**
 * A Connector under `accountId`, named by a `kind = 'connector'` registry row
 * whose current descriptor declares `tier` — or, with `registered: false`, a
 * service principal under the Account that NO registry row names (a direct
 * Account -> service chain, which the derivation refuses).
 *
 * The descriptor's product list deliberately does NOT contain `mcp`: the
 * MCP-derived rows are written by the server, and the allowlist governs what a
 * REPORTER may assert, so the rows must appear without it.
 */
async function makeConnector(accountId: string, displayName: string,
  options: { tier?: 'presence' | 'full' | 'none'; registered?: boolean } = {}): Promise<McpConnector> {
  const principal = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, $2, 'active', $3, 'MCP sessions suite connector', $4::jsonb) RETURNING id`,
    [`mds-connector-${tag()}`, displayName, accountId, JSON.stringify({ scopes: 'parent', objects: 'parent' })],
  );
  const principalId = String(principal.rows[0].id);
  if (options.registered !== false) {
    const descriptor = { telemetry: { tier: options.tier ?? 'presence', products: ['claude-code'] } };
    const service = await pool.query(
      `INSERT INTO services (slug, name, description, kind, status, principal_id, current_descriptor_version)
       VALUES ($1, $2, 'MCP sessions suite', 'connector', 'published', $3, 1) RETURNING id`,
      [`mds-conn-${tag()}`, displayName, principalId],
    );
    await pool.query(
      `INSERT INTO service_descriptor_versions (service_id, version, descriptor, content_hash, created_by_principal_id)
       VALUES ($1, 1, $2::jsonb, $3, NULL)`,
      [String(service.rows[0].id), JSON.stringify(descriptor),
        crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex')],
    );
  }
  // Pinned to the MCP transport, like the production connector credentials,
  // and WITHOUT telemetry:write — the MCP path does not ask for it.
  const issued = await principalService.issueCredential(
    { principalId, scopes: MCP_SCOPES, transport: 'mcp' }, SYSTEM_ACTOR);
  return { principalId, credentialId: issued.credentialId, token: issued.fullKey, displayName };
}

/** An owner-created, armed Task in the tenant's Project. */
async function armedTask(owner: Tenant, title: string): Promise<string> {
  const created = await call(owner.reader, 'POST', '/tasks',
    { title, description: 'MCP sessions suite', status: 'todo', project: owner.projectId });
  expect(created.status).toBe(201);
  const id = String(created.json?.task?.id);
  const armed = await call(owner.reader, 'PATCH', `/tasks/${id}`, { autoStart: true }, { 'Idempotency-Key': idemKey('arm') });
  expect(armed.status).toBe(200);
  return id;
}

// ─────────────────────────────── readers ─────────────────────────────────────

/**
 * Both readers ask for EVERY session, short ones included (card `0ac41d40`).
 *
 * The Sessions list hides short sessions by default: at most three events,
 * under two minutes, no model and no tokens. A freshly bootstrapped MCP
 * session is exactly that shape, so a default read would not list the rows
 * this suite exists to measure. This suite measures the DERIVATION — which
 * rows the MCP path writes and how the projection labels them — not the
 * page's default view, so it reads with `includeShort=true`. The default view
 * is asserted once, in (a), and its own gate is
 * `telemetryProjectionAuthorization.test.ts`.
 */
const EVERY_SESSION = '/telemetry/sessions?includeShort=true';

async function mcpSessions(reader: Caller, connectorId: string): Promise<any[]> {
  const answer = await call(reader, 'GET', EVERY_SESSION);
  expect(answer.status).toBe(200);
  return (answer.json.sessions as any[])
    .filter((row) => row.connectorId === connectorId && row.sourceProduct === 'mcp');
}

async function allSessions(reader: Caller): Promise<any[]> {
  const answer = await call(reader, 'GET', EVERY_SESSION);
  expect(answer.status).toBe(200);
  return answer.json.sessions as any[];
}

async function presence(reader: Caller): Promise<any[]> {
  const answer = await call(reader, 'GET', '/telemetry/presence');
  expect(answer.status).toBe(200);
  return answer.json.sources as any[];
}

async function storedRows(connectorId: string): Promise<Array<{ session_ref: string; phase: string; account_id: string; agent_id: string | null; payload: string; idempotency_key: string }>> {
  const rows = await pool.query(
    `SELECT session_ref, payload->>'phase' AS phase, account_id, agent_id, payload::text AS payload, idempotency_key
       FROM session_events
      WHERE connector_id = $1 AND source_product = 'mcp' AND schema_version IS NOT NULL
      ORDER BY observed_at, event_id`,
    [connectorId],
  );
  return rows.rows.map((row: any) => ({
    session_ref: String(row.session_ref), phase: String(row.phase), account_id: String(row.account_id),
    agent_id: row.agent_id === null ? null : String(row.agent_id), payload: String(row.payload),
    idempotency_key: String(row.idempotency_key),
  }));
}

async function frames(principalId: string, taskId?: string): Promise<Array<{ task_id: string | null; status: string | null }>> {
  const rows = await pool.query(
    `SELECT task_id, status FROM telemetry_frames
      WHERE principal_id = $1 ${taskId ? 'AND task_id = $2' : ''}
      ORDER BY received_at, id`,
    taskId ? [principalId, taskId] : [principalId],
  );
  return rows.rows.map((row: any) => ({ task_id: row.task_id === null ? null : String(row.task_id), status: row.status }));
}

async function framesForTask(taskId: string): Promise<Array<{ principal_id: string; status: string | null }>> {
  const rows = await pool.query(
    'SELECT principal_id, status FROM telemetry_frames WHERE task_id = $1 ORDER BY received_at, id', [taskId]);
  return rows.rows.map((row: any) => ({ principal_id: String(row.principal_id), status: row.status }));
}

async function chip(owner: Tenant, taskId: string): Promise<any> {
  const answer = await call(owner.reader, 'GET', `/tasks/${taskId}/session-status`);
  expect(answer.status).toBe(200);
  return answer.json.data;
}

/** Card b595b3b0: the board and Task details read Task activity here, never the chip. */
async function boardActivity(owner: Tenant, taskId: string): Promise<any> {
  const answer = await call(owner.reader, 'GET', `/tasks/activity?ids=${taskId}`);
  expect(answer.status).toBe(200);
  return answer.json.activity;
}

/** Wait out the per-principal frame gate since the newest frame `principalId` wrote. */
async function clearFrameGate(principalId: string): Promise<void> {
  const newest = await pool.query(
    'SELECT EXTRACT(EPOCH FROM (now() - max(received_at))) * 1000 AS age_ms FROM telemetry_frames WHERE principal_id = $1',
    [principalId]);
  const age = newest.rows[0]?.age_ms === null || newest.rows[0]?.age_ms === undefined
    ? Number.POSITIVE_INFINITY : Number(newest.rows[0].age_ms);
  const wait = TELEMETRY_MIN_FRAME_INTERVAL_MS - age + 250;
  if (wait > 0) await sleep(wait);
}

// ───────────────────────── the schema-wide snapshot ──────────────────────────

type Snapshot = Map<string, string[]>;

async function readSchema(): Promise<Snapshot> {
  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
  const out: Snapshot = new Map();
  for (const row of tables.rows) {
    const table = String(row.table_name);
    const rows = await pool.query(`SELECT to_jsonb(t) AS row FROM "${table}" t`);
    out.set(table, rows.rows.map((r: any) => JSON.stringify(r.row)).sort());
  }
  return out;
}

async function quietSnapshot(): Promise<Snapshot> {
  let previous = await readSchema();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(120);
    const current = await readSchema();
    const active = await pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active'`);
    const same = [...current.entries()].every(([table, rows]) => {
      const before = previous.get(table) ?? [];
      return before.length === rows.length && before.every((value, index) => value === rows[index]);
    });
    if (same && Number(active.rows[0].n) === 0) return current;
    previous = current;
  }
  throw new Error('the database never went quiet: a snapshot could not be taken at rest');
}

function changedTables(before: Snapshot, after: Snapshot): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((table) => {
    const a = before.get(table) ?? [];
    const b = after.get(table) ?? [];
    return a.length !== b.length || a.some((value, index) => value !== b[index]);
  }).sort();
}

/**
 * Card c25c82d4 — the liveness window, opened AT the measured call instead of
 * being left to the wall clock.
 *
 * Every authenticated rh_ request offers two bookkeeping writes to the shared
 * `presenceWriter`: `principals.last_seen_at` (key `principal:<id>`) and
 * `principal_credentials.last_used_at` (key `credential:<id>`), each coalesced
 * for `PRESENCE_THROTTLE_MS` (60 s) from the moment its last write STARTED.
 * Section (g) used to open that window with a warm-up call and then take a
 * whole-schema snapshot at rest; on a loaded runner the snapshot alone can run
 * past 60 s, the measured call then found both keys expired, wrote both rows,
 * and the diff reported `principals` and `principal_credentials` as side
 * effects of the observation (2 of 9 runs beside a mocked run). The red was
 * real arithmetic about the clock, not about the observation.
 *
 * So the window is opened between the BEFORE snapshot and the measured call:
 * `reset()` forgets every throttle, and a no-op submit stamps exactly the
 * caller's two keys, so the measured call's own bookkeeping is coalesced by
 * the product's rule whatever the load. Nothing is written by the stamp and
 * no table or column is exempted: a write through any OTHER key, or any write
 * that is not presence bookkeeping, still lands between the snapshots and
 * fails the comparison by table name.
 */
function openPresenceWindowFor(connector: McpConnector): void {
  presenceWriter.reset();
  const stamped = [
    presenceWriter.submit(`principal:${connector.principalId}`, async () => undefined),
    presenceWriter.submit(`credential:${connector.credentialId}`, async () => undefined),
  ];
  expect({ presenceWindowOpened: stamped }).toEqual({ presenceWindowOpened: [true, true] });
}

// ────────────────────────────── the world ────────────────────────────────────

let A: Tenant;
let B: Tenant;
let ALPHA: McpConnector;      // Account A, tier presence
let BRAVO: McpConnector;      // Account B, tier full
let SILENT: McpConnector;     // Account A, tier none
let UNREGISTERED: McpConnector; // Account A, no registry row
let LATE: McpConnector;       // Account A, tier presence, used for pre-bootstrap
let CHARLIE: McpConnector;    // Account A, tier presence, used for the brief arm of the link
/** The start of a heartbeat bucket, safely in the past. */
let BASE: number;

beforeAll(async () => {
  resetTelemetryPepperCache();
  await new Promise<void>((resolve) => { server = buildApp().listen(0, '127.0.0.1', resolve); });
  // 4a645aa9: the SERVER never ends an idle keep-alive connection; only the client
  // does. Node's default server timeout (5 s) runs on the real clock, while
  // fetch's pool times its idle sockets on a coarse clock that moves one fixed
  // half-second step each time its timer runs, however long the event loop was
  // blocked. A long synchronous phase (a whole-schema snapshot and its
  // comparisons) therefore leaves the client holding a socket the server has just
  // closed, and the next request on it is reset before any answer (`fetch
  // failed` / `read ECONNRESET`). With 0 the client's idle timeout is the only
  // one, and a client never writes on a socket it closed itself. No request and
  // no assertion changes.
  server.keepAliveTimeout = 0;
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  A = await makeTenant('alpha');
  B = await makeTenant('bravo');
  ALPHA = await makeConnector(A.accountId, 'Suite Connector Alpha', { tier: 'presence' });
  BRAVO = await makeConnector(B.accountId, 'Suite Connector Bravo', { tier: 'full' });
  SILENT = await makeConnector(A.accountId, 'Suite Connector Silent', { tier: 'none' });
  UNREGISTERED = await makeConnector(A.accountId, 'Suite Service Unregistered', { registered: false });
  LATE = await makeConnector(A.accountId, 'Suite Connector Late', { tier: 'presence' });
  CHARLIE = await makeConnector(A.accountId, 'Suite Connector Charlie', { tier: 'presence' });

  BASE = (Math.floor(Date.now() / HEARTBEAT_MS) - 1) * HEARTBEAT_MS;
  at(new Date(BASE + 1_000));
});

afterAll(async () => {
  observerClock(null);
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ═══════════════════════════════ (a) start ═══════════════════════════════════

describe('(a) bootstrap records one session for the caller only', () => {
  it('a session brief yields exactly one mcp session row, named for the Connector, visible to its own Account only', async () => {
    const brief = await mcp(ALPHA.token, 'relayhall_brief_compile', { session: true });
    expect(brief.isError).toBe(false);

    const rows = await mcpSessions(A.reader, ALPHA.principalId);
    expect(rows.map((row) => ({ state: row.state, lastPhase: row.lastPhase, name: row.connectorDisplayName })))
      .toEqual([{ state: 'active', lastPhase: 'started', name: ALPHA.displayName }]);

    const sources = (await presence(A.reader))
      .filter((source) => source.connectorId === ALPHA.principalId && source.sourceProduct === 'mcp');
    expect(sources.map((source) => ({ state: source.state, name: source.connectorDisplayName, sessions: source.sessionCount })))
      .toEqual([{ state: 'active', name: ALPHA.displayName, sessions: 1 }]);

    // The other Account sees nothing of it.
    expect((await allSessions(B.reader)).filter((row) => row.connectorId === ALPHA.principalId)).toEqual([]);

    // THE DEFAULT VIEW (card `0ac41d40`). One `started` event and nothing
    // else is a short session, so the page's default read does not list it —
    // and says so: the one session this Account has is counted as hidden
    // rather than silently missing.
    expect(await allSessions(A.reader)).toHaveLength(1);
    const defaultView = await call(A.reader, 'GET', '/telemetry/sessions');
    expect(defaultView.status).toBe(200);
    expect({
      listed: (defaultView.json.sessions as any[]).filter((row) => row.connectorId === ALPHA.principalId),
      hiddenCount: defaultView.json.hiddenCount,
    }).toEqual({ listed: [], hiddenCount: 1 });

    // Stored under the CALLER's chain, and the raw credential id lands nowhere.
    const stored = await storedRows(ALPHA.principalId);
    expect(stored.map((row) => ({ phase: row.phase, account: row.account_id, agent: row.agent_id })))
      .toEqual([{ phase: 'started', account: A.accountId, agent: null }]);
    for (const row of stored) {
      expect(row.payload).not.toContain(ALPHA.credentialId);
      expect(row.idempotency_key).not.toContain(ALPHA.credentialId);
    }
  });
});

// ═════════════════════════════ (b) heartbeat ═════════════════════════════════

describe('(b) the heartbeat is bounded to one per bucket', () => {
  const running = async (): Promise<number> =>
    (await storedRows(ALPHA.principalId)).filter((row) => row.phase === 'running').length;

  it('many calls inside one bucket store ONE heartbeat; the next bucket stores one more', async () => {
    expect(await running()).toBe(0);
    for (let second = 2; second <= 6; second += 1) {
      at(new Date(BASE + second * 1_000));
      expect((await mcp(ALPHA.token, 'relayhall_principal_whoami')).isError).toBe(false);
    }
    expect(await running()).toBe(1);

    at(new Date(BASE + HEARTBEAT_MS + 1_000));
    await mcp(ALPHA.token, 'relayhall_principal_whoami');
    await mcp(ALPHA.token, 'relayhall_task_list', {});
    expect(await running()).toBe(2);

    const [row] = await mcpSessions(A.reader, ALPHA.principalId);
    expect({ state: row.state, lastPhase: row.lastPhase, events: row.eventCount })
      .toEqual({ state: 'active', lastPhase: 'running', events: 3 });
  });

  it('holds under concurrency: eight simultaneous calls in a new bucket store exactly one', async () => {
    at(new Date(BASE + 2 * HEARTBEAT_MS + 1_000));
    await Promise.all(Array.from({ length: 8 }, () => mcp(ALPHA.token, 'relayhall_principal_whoami')));
    expect(await running()).toBe(3);
  });
});

// ═════════════════════════════ (c) Task link ═════════════════════════════════

describe('(c) the Task link follows the Task the caller holds in progress', () => {
  let T1: string;
  let T2: string;

  it('a brief or a claim alone sets nothing; holding the Task in progress links it under the CALLER', async () => {
    T1 = await armedTask(A, `MCP sessions link ${tag()}`);
    await clearFrameGate(ALPHA.principalId);

    expect((await mcp(ALPHA.token, 'relayhall_brief_compile', { taskId: T1 })).isError).toBe(false);
    expect(await framesForTask(T1)).toEqual([]);

    expect((await mcp(ALPHA.token, 'relayhall_task_claim', { task: T1 })).isError).toBe(false);
    expect(await framesForTask(T1)).toEqual([]);

    const moved = await mcp(ALPHA.token, 'relayhall_task_move', { task: T1, status: 'in-progress', idempotencyKey: idemKey('move') });
    expect(moved.isError).toBe(false);
    expect(await framesForTask(T1)).toEqual([{ principal_id: ALPHA.principalId, status: 'active' }]);
    expect(await chip(A, T1)).toMatchObject({ state: 'active', telemetry: { state: 'active' } });
    // The link frame of the caller holding the Task is the board's task activity too (b595b3b0).
    expect(await boardActivity(A, T1)).toEqual([expect.objectContaining({ taskId: T1, state: 'active', kind: 'status' })]);

    // A brief for the linked Task while it is shown changes nothing.
    await mcp(ALPHA.token, 'relayhall_brief_compile', { taskId: T1 });
    expect(await framesForTask(T1)).toHaveLength(1);
  });

  it('release clears the link with ONE idle frame, and nothing re-links it', async () => {
    await clearFrameGate(ALPHA.principalId);
    expect((await mcp(ALPHA.token, 'relayhall_task_release', { task: T1 })).isError).toBe(false);
    expect(await framesForTask(T1)).toEqual([
      { principal_id: ALPHA.principalId, status: 'active' },
      { principal_id: ALPHA.principalId, status: 'idle' },
    ]);
    expect(await chip(A, T1)).toMatchObject({ state: 'idle' });
    // Released, the Task has no current Assignee observation: the board shows unknown, not idle-by-lifecycle.
    expect(await boardActivity(A, T1)).toEqual([{ taskId: T1, state: 'unknown', kind: null, receivedAt: null }]);

    await clearFrameGate(ALPHA.principalId);
    at(new Date(BASE + 3 * HEARTBEAT_MS + 1_000));
    await mcp(ALPHA.token, 'relayhall_principal_whoami');
    await mcp(ALPHA.token, 'relayhall_brief_compile', { taskId: T1 });
    expect(await framesForTask(T1)).toHaveLength(2);
  });

  it('a clear the five-second gate refuses is recovered at the next reconcile; finish clears too', async () => {
    T2 = await armedTask(A, `MCP sessions finish ${tag()}`);
    await clearFrameGate(ALPHA.principalId);
    await mcp(ALPHA.token, 'relayhall_task_claim', { task: T2 });
    await mcp(ALPHA.token, 'relayhall_task_move', { task: T2, status: 'in-progress', idempotencyKey: idemKey('move') });
    expect(await framesForTask(T2)).toEqual([{ principal_id: ALPHA.principalId, status: 'active' }]);

    // Finished straight away, INSIDE the gate's interval since the active
    // frame — asserted, so a run too slow to exercise the refusal fails by
    // name instead of quietly measuring the easy path.
    const finished = await mcp(ALPHA.token, 'relayhall_task_finish',
      { task: T2, handover: 'done for the drill', report: { title: 'Drill handover', content: 'done for the drill' } });
    expect({ isError: finished.isError, text: finished.isError ? finished.text : '' }).toEqual({ isError: false, text: '' });
    const age = await pool.query(
      'SELECT EXTRACT(EPOCH FROM (now() - max(received_at))) * 1000 AS ms FROM telemetry_frames WHERE principal_id = $1 AND task_id = $2',
      [ALPHA.principalId, T2]);
    expect({ insideFrameGate: Number(age.rows[0].ms) < TELEMETRY_MIN_FRAME_INTERVAL_MS }).toEqual({ insideFrameGate: true });
    // The gate refused the clear: the Task still SHOWS active…
    expect(await framesForTask(T2)).toEqual([{ principal_id: ALPHA.principalId, status: 'active' }]);

    await clearFrameGate(ALPHA.principalId);
    at(new Date(BASE + 4 * HEARTBEAT_MS + 1_000));
    await mcp(ALPHA.token, 'relayhall_principal_whoami');
    // …and the next reconcile — a new heartbeat bucket — clears it, once.
    const t2 = await framesForTask(T2);
    expect(t2).toEqual([
      { principal_id: ALPHA.principalId, status: 'active' },
      { principal_id: ALPHA.principalId, status: 'idle' },
    ]);
    expect(await chip(A, T2)).toMatchObject({ state: 'idle' });

    // …and nothing after the clear: no further frame for a Task not held.
    await clearFrameGate(ALPHA.principalId);
    at(new Date(BASE + 5 * HEARTBEAT_MS + 1_000));
    await mcp(ALPHA.token, 'relayhall_principal_whoami');
    expect(await framesForTask(T2)).toEqual(t2);
  });

  it('every link frame is the caller\'s own: no frame under any other principal', async () => {
    const all = [...await framesForTask(T1), ...await framesForTask(T2)];
    expect(all.length).toBeGreaterThan(0);
    expect([...new Set(all.map((frame) => frame.principal_id))]).toEqual([ALPHA.principalId]);
  });
});

// ═════════════════════════ (d) idle, stale, ended ════════════════════════════

describe('(d) silence derives stale; a new bootstrap or a lapse ends the session', () => {
  it('a session silent past the shipped window is stale, and active again on its next call', async () => {
    const past = Date.now() - TELEMETRY_STALE_MS - 5 * HEARTBEAT_MS;
    at(new Date(past));
    expect((await mcp(BRAVO.token, 'relayhall_brief_compile', { session: true })).isError).toBe(false);
    at(new Date(past + 2_000));
    await mcp(BRAVO.token, 'relayhall_principal_whoami');

    let rows = await mcpSessions(B.reader, BRAVO.principalId);
    expect(rows.map((row) => row.state)).toEqual(['stale']);
    expect((await presence(B.reader)).filter((s) => s.connectorId === BRAVO.principalId).map((s) => s.state))
      .toEqual(['stale']);

    at(new Date());
    await mcp(BRAVO.token, 'relayhall_principal_whoami');
    rows = await mcpSessions(B.reader, BRAVO.principalId);
    expect(rows.map((row) => ({ state: row.state, name: row.connectorDisplayName })))
      .toEqual([{ state: 'active', name: BRAVO.displayName }]);
  });

  it('bootstrapping again finishes the previous session and starts a new one', async () => {
    const before = (await mcpSessions(B.reader, BRAVO.principalId))[0];
    at(new Date(Date.now() + 1_000));
    expect((await mcp(BRAVO.token, 'relayhall_brief_compile', { session: true })).isError).toBe(false);
    const rows = await mcpSessions(B.reader, BRAVO.principalId);
    expect(rows).toHaveLength(2);
    const old = rows.find((row) => row.sessionRef === before.sessionRef);
    const fresh = rows.find((row) => row.sessionRef !== before.sessionRef);
    expect({ state: old.state, lastPhase: old.lastPhase }).toEqual({ state: 'finished', lastPhase: 'completed' });
    expect({ state: fresh.state, lastPhase: fresh.lastPhase }).toEqual({ state: 'active', lastPhase: 'started' });
  });

  it('a lapsed bootstrap is finished at the next contact, and a refused call records nothing', async () => {
    await pool.query(
      `UPDATE mcp_bootstrap_records SET expires_at = now() - INTERVAL '1 second' WHERE credential_id = $1`,
      [BRAVO.credentialId]);
    at(new Date(Date.now() + 2_000));
    expect((await mcp(BRAVO.token, 'relayhall_principal_whoami')).isError).toBe(false);
    const rows = await mcpSessions(B.reader, BRAVO.principalId);
    expect(rows.map((row) => row.state).sort()).toEqual(['finished', 'finished']);

    const count = (await storedRows(BRAVO.principalId)).length;
    at(new Date(Date.now() + HEARTBEAT_MS));
    // A WORK-plane call: refused by the gate before anything runs.
    const refused = await mcp(BRAVO.token, 'relayhall_task_claim', { task: crypto.randomUUID() });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(BOOTSTRAP_REFUSAL_MARKER);
    expect((await storedRows(BRAVO.principalId)).length).toBe(count);
  });
});

// ═══════════════════════════ (e) isolation ═══════════════════════════════════

describe('(e) one Connector never touches another\'s rows', () => {
  it('Alpha\'s calls leave Bravo\'s rows byte-identical, and each Account reads only its own', async () => {
    const bravoBefore = await storedRows(BRAVO.principalId);
    const bravoFramesBefore = await frames(BRAVO.principalId);
    expect(bravoBefore.length).toBeGreaterThan(0);

    at(new Date(BASE + 6 * HEARTBEAT_MS + 1_000));
    await mcp(ALPHA.token, 'relayhall_principal_whoami');
    await mcp(ALPHA.token, 'relayhall_brief_compile', { session: true });
    at(new Date(BASE + 7 * HEARTBEAT_MS + 1_000));
    await mcp(ALPHA.token, 'relayhall_task_list', {});

    expect(await storedRows(BRAVO.principalId)).toEqual(bravoBefore);
    expect(await frames(BRAVO.principalId)).toEqual(bravoFramesBefore);
    expect((await storedRows(ALPHA.principalId)).length).toBeGreaterThan(0);

    for (const row of await storedRows(ALPHA.principalId)) expect(row.account_id).toBe(A.accountId);
    for (const row of await storedRows(BRAVO.principalId)) expect(row.account_id).toBe(B.accountId);
    expect((await allSessions(A.reader)).filter((row) => row.connectorId === BRAVO.principalId)).toEqual([]);
    expect((await allSessions(B.reader)).filter((row) => row.connectorId === ALPHA.principalId)).toEqual([]);
    expect((await mcpSessions(A.reader, ALPHA.principalId)).length).toBeGreaterThan(0);
  });
});

// ═════════════════════════════ (f) A17.7 ═════════════════════════════════════

describe('(f) A17.7: each principal writes only its own frames', () => {
  it('a frame naming an owner is still refused at the ingest route', async () => {
    const issued = await principalService.issueCredential(
      { principalId: ALPHA.principalId, scopes: ['telemetry:write'], transport: 'api' }, SYSTEM_ACTOR);
    const reporter = { label: 'alpha reporter', principalId: ALPHA.principalId, headers: { Authorization: `Bearer ${issued.fullKey}` } };
    const alphaFrames = await frames(ALPHA.principalId);
    const bravoFrames = await frames(BRAVO.principalId);
    for (const field of ['principalId', 'owner', 'principal']) {
      const refused = await call(reporter, 'POST', '/telemetry/frames',
        { kind: 'status', status: 'active', [field]: BRAVO.principalId });
      expect({ field, status: refused.status, code: refused.json?.code })
        .toEqual({ field, status: 400, code: 'INVALID_FRAME' });
    }
    // Refused means stored nowhere — not under the named owner, not under the sender.
    expect(await frames(BRAVO.principalId)).toEqual(bravoFrames);
    expect(await frames(ALPHA.principalId)).toEqual(alphaFrames);
  });

  it('no MCP argument can steer the owner of what the MCP path writes', async () => {
    const bravoBefore = await storedRows(BRAVO.principalId);
    const bravoFramesBefore = await frames(BRAVO.principalId);
    const alphaBefore = (await storedRows(ALPHA.principalId)).length;
    at(new Date(BASE + 8 * HEARTBEAT_MS + 1_000));
    // Unknown arguments are refused by the tools — and the observation still
    // runs, for the CALLER.
    await mcp(ALPHA.token, 'relayhall_brief_compile', { session: true, principalId: BRAVO.principalId });
    await mcp(ALPHA.token, 'relayhall_principal_whoami', { principalId: BRAVO.principalId, connectorId: BRAVO.principalId });
    await mcp(ALPHA.token, 'relayhall_task_list', { owner: BRAVO.principalId });
    expect(await storedRows(BRAVO.principalId)).toEqual(bravoBefore);
    expect(await frames(BRAVO.principalId)).toEqual(bravoFramesBefore);
    expect((await storedRows(ALPHA.principalId)).length).toBe(alphaBefore + 1);
  });
});

// ═══════════════════════ (g) zero side effects ═══════════════════════════════

describe('(g) the observation changes the telemetry tables and nothing else', () => {
  it('a heartbeat-and-link call changes only telemetry tables — and does change them', async () => {
    const T3 = await armedTask(A, `MCP sessions effects ${tag()}`);
    at(new Date(BASE + 9 * HEARTBEAT_MS + 1_000));
    await mcp(ALPHA.token, 'relayhall_task_claim', { task: T3 });
    await mcp(ALPHA.token, 'relayhall_task_move', { task: T3, status: 'in-progress', idempotencyKey: idemKey('move') });
    await clearFrameGate(ALPHA.principalId);

    // Warm the path with the same call (its bookkeeping lands before the
    // snapshot), open the liveness window at the measured instant, then
    // measure one call in a NEW bucket: its heartbeat and link refresh.
    presenceWriter.reset();
    await mcp(ALPHA.token, 'relayhall_principal_whoami');
    await clearFrameGate(ALPHA.principalId);
    const before = await quietSnapshot();
    openPresenceWindowFor(ALPHA);
    at(new Date(BASE + 10 * HEARTBEAT_MS + 1_000));
    expect((await mcp(ALPHA.token, 'relayhall_principal_whoami')).isError).toBe(false);
    const after = await quietSnapshot();

    const changed = changedTables(before, after);
    expect(changed.filter((table) => !TELEMETRY_TABLES.includes(table))).toEqual([]);
    expect(changed).toEqual(expect.arrayContaining(['session_events', 'telemetry_raw_blobs', 'telemetry_frames']));
  });

  it('a bootstrap changes only the telemetry tables and its own bootstrap record', async () => {
    presenceWriter.reset();
    await mcp(ALPHA.token, 'relayhall_principal_whoami');
    const before = await quietSnapshot();
    openPresenceWindowFor(ALPHA);
    at(new Date(BASE + 11 * HEARTBEAT_MS + 1_000));
    expect((await mcp(ALPHA.token, 'relayhall_brief_compile', { session: true })).isError).toBe(false);
    const after = await quietSnapshot();
    const changed = changedTables(before, after);
    expect(changed.filter((table) => ![...TELEMETRY_TABLES, 'mcp_bootstrap_records'].includes(table))).toEqual([]);
    expect(changed).toEqual(expect.arrayContaining(['session_events', 'mcp_bootstrap_records']));
  });
});

// ═══════════════════════════ (h) negatives ═══════════════════════════════════

describe('(h) a caller that may not be shown writes nothing', () => {
  const refusalAudits = async (principalId: string): Promise<number> => {
    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE action = 'telemetry.envelope.refused' AND actor_principal_id = $1`, [principalId]);
    return Number(rows.rows[0].n);
  };

  it.each([
    ['a Connector whose descriptor declares tier none', () => SILENT],
    ['a service under the Account that no registry row names', () => UNREGISTERED],
  ])('%s', async (_label, who) => {
    const caller = who();
    at(new Date(BASE + 12 * HEARTBEAT_MS + 1_000));
    expect((await mcp(caller.token, 'relayhall_brief_compile', { session: true })).isError).toBe(false);
    await mcp(caller.token, 'relayhall_principal_whoami');
    await mcp(caller.token, 'relayhall_task_list', {});
    expect(await storedRows(caller.principalId)).toEqual([]);
    expect(await frames(caller.principalId)).toEqual([]);
    expect(await refusalAudits(caller.principalId)).toBe(0);
  });

  it('introspection before any bootstrap writes nothing; the bootstrap then does', async () => {
    at(new Date(BASE + 12 * HEARTBEAT_MS + 2_000));
    expect((await mcp(LATE.token, 'relayhall_principal_whoami')).isError).toBe(false);
    expect(await storedRows(LATE.principalId)).toEqual([]);
    await mcp(LATE.token, 'relayhall_brief_compile', { session: true });
    expect((await storedRows(LATE.principalId)).map((row) => row.phase)).toEqual(['started']);
  });
});

// ═══════════════════ (i) the taskId-brief arm of the link ════════════════════

describe('(i) a taskId brief sets the link, and a brief-named switch between held Tasks survives', () => {
  let reporter: Caller;
  let T_OLD: string;
  let T_NEW: string;

  const running = async (): Promise<number> =>
    (await storedRows(CHARLIE.principalId)).filter((row) => row.phase === 'running').length;
  const statuses = async (taskId: string): Promise<Array<string | null>> =>
    (await framesForTask(taskId)).map((frame) => frame.status);

  /** A REAL reporter under the same principal takes the shared five-second frame gate. */
  const takeFrameGate = async (): Promise<void> => {
    await clearFrameGate(CHARLIE.principalId);
    const beat = await call(reporter, 'POST', '/telemetry/frames', { kind: 'heartbeat' });
    expect({ status: beat.status, accepted: beat.json?.accepted }).toEqual({ status: 200, accepted: true });
  };
  /** Asserted, so a run too slow to exercise the refusal fails by name. */
  const expectInsideFrameGate = async (): Promise<void> => {
    const age = await pool.query(
      'SELECT EXTRACT(EPOCH FROM (now() - max(received_at))) * 1000 AS ms FROM telemetry_frames WHERE principal_id = $1',
      [CHARLIE.principalId]);
    expect({ insideFrameGate: Number(age.rows[0].ms) < TELEMETRY_MIN_FRAME_INTERVAL_MS }).toEqual({ insideFrameGate: true });
  };

  it('a taskId brief alone links a held Task whose link the frame gate refused, in the SAME bucket', async () => {
    const issued = await principalService.issueCredential(
      { principalId: CHARLIE.principalId, scopes: ['telemetry:write'], transport: 'api' }, SYSTEM_ACTOR);
    reporter = { label: 'charlie reporter', principalId: CHARLIE.principalId, headers: { Authorization: `Bearer ${issued.fullKey}` } };
    T_OLD = await armedTask(A, `MCP sessions brief link ${tag()}`);

    at(new Date(BASE + 13 * HEARTBEAT_MS + 1_000));
    expect((await mcp(CHARLIE.token, 'relayhall_brief_compile', { session: true })).isError).toBe(false);
    expect((await mcp(CHARLIE.token, 'relayhall_task_claim', { task: T_OLD })).isError).toBe(false);
    // This bucket's heartbeat is stored: from here on every call in it is a
    // duplicate, so only a LINKING tool's own reconcile can write a frame.
    expect(await running()).toBe(1);

    await takeFrameGate();
    const moved = await mcp(CHARLIE.token, 'relayhall_task_move', { task: T_OLD, status: 'in-progress', idempotencyKey: idemKey('move') });
    expect(moved.isError).toBe(false);
    await expectInsideFrameGate();
    // The gate refused the move's link frame: the Task is held and unlinked.
    expect(await framesForTask(T_OLD)).toEqual([]);

    // Same bucket, gate clear: the Task's brief, and nothing else, links it.
    await clearFrameGate(CHARLIE.principalId);
    expect((await mcp(CHARLIE.token, 'relayhall_brief_compile', { taskId: T_OLD })).isError).toBe(false);
    expect(await running()).toBe(1);
    expect(await framesForTask(T_OLD)).toEqual([{ principal_id: CHARLIE.principalId, status: 'active' }]);
    expect(await chip(A, T_OLD)).toMatchObject({ state: 'active', telemetry: { state: 'active' } });
  });

  it('a brief naming the other of two held Tasks moves the link, and the switch survives the next reconciles', async () => {
    // Precondition: CHARLIE holds T_OLD and T_NEW in progress, T_NEW linked.
    T_NEW = await armedTask(A, `MCP sessions brief switch ${tag()}`);
    await clearFrameGate(CHARLIE.principalId);
    await mcp(CHARLIE.token, 'relayhall_task_claim', { task: T_NEW });
    await mcp(CHARLIE.token, 'relayhall_task_move', { task: T_NEW, status: 'in-progress', idempotencyKey: idemKey('move') });
    await clearFrameGate(CHARLIE.principalId);
    at(new Date(BASE + 14 * HEARTBEAT_MS + 1_000));
    await mcp(CHARLIE.token, 'relayhall_principal_whoami');
    expect(await statuses(T_OLD)).toEqual(['active', 'idle']);
    expect(await statuses(T_NEW)).toEqual(['active']);

    // The brief names T_OLD: the link moves to it at once…
    await clearFrameGate(CHARLIE.principalId);
    expect((await mcp(CHARLIE.token, 'relayhall_brief_compile', { taskId: T_OLD })).isError).toBe(false);
    expect(await statuses(T_OLD)).toEqual(['active', 'idle', 'active']);

    // …although `updated_at` would pick T_NEW — the brief touched neither —
    const newest = await pool.query(
      `SELECT id FROM tasks WHERE id = ANY($1::uuid[]) ORDER BY updated_at DESC, id ASC LIMIT 1`, [[T_OLD, T_NEW]]);
    expect(String(newest.rows[0].id)).toBe(T_NEW);

    // …the next reconcile keeps T_OLD and clears T_NEW…
    await clearFrameGate(CHARLIE.principalId);
    at(new Date(BASE + 15 * HEARTBEAT_MS + 1_000));
    await mcp(CHARLIE.token, 'relayhall_principal_whoami');
    expect(await statuses(T_NEW)).toEqual(['active', 'idle']);
    expect(await statuses(T_OLD)).toEqual(['active', 'idle', 'active']);

    // …and the one after refreshes T_OLD: the link is still where the brief put it.
    await clearFrameGate(CHARLIE.principalId);
    at(new Date(BASE + 16 * HEARTBEAT_MS + 1_000));
    await mcp(CHARLIE.token, 'relayhall_principal_whoami');
    expect(await statuses(T_OLD)).toEqual(['active', 'idle', 'active', 'active']);
    expect(await statuses(T_NEW)).toEqual(['active', 'idle']);
    expect(await chip(A, T_OLD)).toMatchObject({ state: 'active', telemetry: { state: 'active' } });
    expect(await chip(A, T_NEW)).toMatchObject({ state: 'idle' });
  });

  it('a switch the frame gate refuses is not retried; compiling the brief again applies it', async () => {
    const tNewBefore = await statuses(T_NEW);
    await takeFrameGate();
    expect((await mcp(CHARLIE.token, 'relayhall_brief_compile', { taskId: T_NEW })).isError).toBe(false);
    await expectInsideFrameGate();
    expect(await statuses(T_NEW)).toEqual(tNewBefore);

    // The next reconcile follows the SHOWN link, not the refused request.
    await clearFrameGate(CHARLIE.principalId);
    at(new Date(BASE + 17 * HEARTBEAT_MS + 1_000));
    await mcp(CHARLIE.token, 'relayhall_principal_whoami');
    expect(await statuses(T_NEW)).toEqual(tNewBefore);
    expect((await statuses(T_OLD)).slice(-1)).toEqual(['active']);

    await clearFrameGate(CHARLIE.principalId);
    expect((await mcp(CHARLIE.token, 'relayhall_brief_compile', { taskId: T_NEW })).isError).toBe(false);
    expect(await statuses(T_NEW)).toEqual([...tNewBefore, 'active']);
  });

  it('every frame on these Tasks is the caller\'s own', async () => {
    const all = [...await framesForTask(T_OLD), ...await framesForTask(T_NEW)];
    expect(all.length).toBeGreaterThan(0);
    expect([...new Set(all.map((frame) => frame.principal_id))]).toEqual([CHARLIE.principalId]);
  });
});
