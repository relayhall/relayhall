/**
 * fb06c930 — THE RETRY CONTRACT, measured against a REAL PostgreSQL.
 *
 * Design record `bf8928ee` v5 + ANNEX A `dd3aaa9e`; owner rulings `94ecf329`
 * Batch 1 (five rulings), `1d8dcd5c` (build with three carried obligations)
 * and `0464ad54` (migration 110). Verdicts `ff439cbc` and `f2de4eaf`; the
 * latter carries the exact BUILD INSTRUCTION for B-1, B-2 and B-3, and each is
 * discharged here beside the drill that reddens it.
 *
 * ── WHY THIS SUITE IS NOT IN THE DEFAULT JEST RUN ──
 *
 * It connects to `RELAYHALL_TEST_DB_URL` and FAILS — never skips — when the
 * variable is unset: a skipping gate is a vacuous gate, and the default `npx
 * jest` run passes with no database at all (every DB-shaped suite in this tree
 * mocks the pool). It is excluded by `testPathIgnorePatterns` and run by
 * `npm run test:idempotency`: on the VM gate chain against a disposable
 * PostgreSQL, and UNCONDITIONALLY in CI against a `services: postgres` block
 * with no `if:` guard — owner ruling `94ecf329` item 4, which forecloses a
 * VM-only substitute.
 *
 * ── WHAT IT DRIVES ──
 *
 * The PRODUCTION handlers, behind the PRODUCTION guard chain, over a REAL
 * socket. The app is assembled from `registerProtectedRoutes` — the one route
 * table `server.ts` and the MCP in-process dispatch both register — mounted
 * through the same `authMiddleware, sharedAuthorizationMiddleware` funnel, with
 * a real minted credential. Nothing is mocked: not the pool, not the handler,
 * not the middleware under test.
 *
 * What it deliberately leaves out is the PROCESS bootstrap — listeners,
 * sweeps, the plugin loader — because importing `server.ts` starts a socket and
 * can call `process.exit`. That is the one seam between this app and the
 * deployed one, so it is not left to a comment: `the funnel matches the one
 * server.ts registers` reads `server.ts` and asserts the guard list this file
 * uses is the guard list that file uses. A drift control needs an outside
 * anchor, and `server.ts` is it.
 *
 * ── THE DESTRUCTIVE CONTRACT, STATED ──
 *
 * This suite CREATES AND DROPS schema objects and writes to every table it
 * measures. It refuses to run against anything but the database named in
 * `RELAYHALL_TEST_DB_URL`, and refuses that URL outright when it names a
 * deployment database (`relayhall_dev`, `relayhall_tst`, `relayhall_prod`) or a
 * non-local host. Bring the database up with `database/init.sql` and
 * `npm run migrate`, and throw it away afterwards.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';

// ─────────────────────────── the database contract ───────────────────────────

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error(
    'RELAYHALL_TEST_DB_URL is not set. This gate measures the retry contract against a REAL PostgreSQL and refuses to skip: '
    + 'a skipping gate is a vacuous gate (design bf8928ee v5 §4.0, owner ruling 94ecf329 item 4). '
    + 'Create a disposable database, load database/init.sql, run npm run migrate, and set RELAYHALL_TEST_DB_URL to it.',
  );
}

const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = parsed.pathname.replace(/^\//, '');
const FORBIDDEN_DATABASES = ['relayhall_dev', 'relayhall_tst', 'relayhall_prod', 'relayhall'];
if (FORBIDDEN_DATABASES.includes(TEST_DB_NAME)) {
  throw new Error(`RELAYHALL_TEST_DB_URL names a deployment database (${TEST_DB_NAME}). This suite is destructive; point it at a disposable database.`);
}

// The production pool reads DB_* at import time (db/connection.ts:28-36), so
// the environment is pinned BEFORE anything is required. Everything below uses
// `require` for exactly that reason: an ES import would be hoisted above this.
process.env.DB_HOST = parsed.hostname;
process.env.DB_PORT = parsed.port || '5432';
process.env.DB_NAME = TEST_DB_NAME;
process.env.DB_USER = decodeURIComponent(parsed.username);
process.env.DB_PASSWORD = decodeURIComponent(parsed.password);
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'retry-contract-suite-secret-0123456789abcdef';

const express = require('express');

const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { principalService } = require('../services/PrincipalService');
const { serviceRegistry } = require('../services/ServiceRegistry');
const {
  IDEMPOTENT_OPERATIONS, IDEMPOTENCY_IN_FLIGHT_TAKEOVER_MS,
  sweepExpiredIdempotencyRecords,
} = require('../middleware/idempotency');
const { RETRY_CONTRACT_SENTENCES, toolByName } = require('../mcp/registry');
const { writersOf, derivedTableManifest } = require('./support/moduleClosure');
const { stableJson } = require('../utils/stableJson');
const mcpRoutes = require('../mcp/httpRoute');

jest.setTimeout(180_000);

// ─────────────────────────── the send-boundary probe ─────────────────────────

/**
 * B-3 (verdict `f2de4eaf`): a SYNCHRONOUS observation of the response boundary.
 *
 * `Promise.race([request, sleep(500)])` watches the CLIENT promise settle, not
 * the moment the original `res.send` is invoked — under the after-send mutation
 * `send` can have been called while event-loop delay, socket backpressure or CI
 * scheduling keeps the client promise unresolved for 500 ms, and the timeout
 * then reports PENDING on a target that HAS sent. A timeout is no verdict.
 *
 * This middleware is mounted BEFORE the production router, so its wrapper sits
 * UNDER the middleware under test: when `idempotent()` later wraps `res.send`
 * and eventually calls the send it captured, that call lands here and is
 * counted the instant it happens. Healthy-and-blocked must show 0; the
 * after-send mutation must show 1. Client non-arrival stays as auxiliary
 * evidence beside it, never as the credited assertion.
 */
const sendBoundaryCounts = new Map<string, number>();
function sendBoundaryProbe(req: any, res: any, next: any): void {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || !sendBoundaryCounts.has(key)) { next(); return; }
  // BOTH boundaries. Review round 1 pointed out that a handler bypassing the
  // wrapped `res.send` with `res.end(body)` would put bytes on the wire while
  // the credited count still read 0 — the observation was `send`-specific rather
  // than transport-wide. Counting `end` as well makes it the RESPONSE boundary,
  // which is what the assertion claims to be about.
  const originalSend = res.send.bind(res);
  const originalEnd = res.end.bind(res);
  // ONCE per response. `res.send` calls `res.end` internally, so counting both
  // unconditionally would report 2 for one answer; what the assertion is about
  // is whether the boundary has been CROSSED, so the first crossing counts and
  // the tail of the same answer does not.
  let crossed = false;
  const count = (): void => {
    if (crossed) return;
    crossed = true;
    sendBoundaryCounts.set(key, (sendBoundaryCounts.get(key) as number) + 1);
  };
  res.send = (body?: unknown) => { count(); return originalSend(body); };
  res.end = ((...args: unknown[]) => {
    // A payload-bearing `end` is the OTHER way bytes leave — the bypass review
    // round 1 named. An empty `end` is the tail of an answer already counted.
    if (args.length > 0 && args[0] !== undefined && typeof args[0] !== 'function') count();
    return (originalEnd as (...rest: unknown[]) => unknown)(...args);
  }) as typeof res.end;
  next();
}
function watchSendBoundary(key: string): void { sendBoundaryCounts.set(key, 0); }
function sendBoundaryCount(key: string): number {
  const count = sendBoundaryCounts.get(key);
  if (count === undefined) throw new Error(`send boundary was never watched for ${key}`);
  return count;
}

// ──────────────────────────────── the app ────────────────────────────────────

const GUARD_CHAIN = ['authMiddleware', 'sharedAuthorizationMiddleware'];
let server: http.Server;
let origin: string;

function buildApp(): any {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  app.use(sendBoundaryProbe);
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  // The MCP door, mounted exactly as `server.ts:251` mounts it — the ONE
  // authenticated mount outside the shared funnel, which authenticates itself.
  // Without it the suite could only ever assert what the TOOL HANDLER does with
  // its arguments, never what the tool actually SENDS: the red-proof drill duly
  // caught that, scoring a handler that stopped forwarding the retry token on
  // task_move's notes limb as a FALSE GREEN. This is the seam the card was
  // filed on, so this suite drives it.
  app.use(mcpRoutes.MCP_ROUTE_PATH, mcpRoutes.default ?? mcpRoutes);
  app.use(apiErrorHandler);
  return app;
}

/** A `tools/call` over the REAL `/mcp` route, with a real credential. */
async function toolCall(
  name: string, args: Record<string, unknown>, token?: string,
): Promise<{ status: number; text: string; isError: boolean; content: string }> {
  const response = await fetch(`${origin}${mcpRoutes.MCP_ROUTE_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token ?? PRIMARY.fullKey}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const text = await response.text();
  let isError = false;
  let content = text;
  try {
    const parsed = JSON.parse(text);
    isError = Boolean(parsed?.result?.isError);
    content = (parsed?.result?.content ?? []).map((part: any) => String(part.text ?? '')).join('\n')
      || JSON.stringify(parsed?.error ?? parsed);
  } catch { /* leave the raw text */ }
  return { status: response.status, text, isError, content };
}

interface Answer {
  status: number;
  text: string;
  headers: Record<string, string>;
  json: any;
}

async function call(
  method: string, routePath: string,
  options: { body?: unknown; key?: string; token?: string; headers?: Record<string, string> } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(options.headers ?? {}) };
  if (options.token !== null) headers.Authorization = `Bearer ${options.token ?? PRIMARY.fullKey}`;
  if (options.key) headers['Idempotency-Key'] = options.key;
  const response = await fetch(`${origin}${routePath}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  const outHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => { outHeaders[name.toLowerCase()] = value; });
  return { status: response.status, text, headers: outHeaders, json };
}

/** Started, not awaited — 4.1.12 needs the request in flight. */
function callDetached(
  method: string, routePath: string,
  options: { body?: unknown; key?: string; token?: string } = {},
): Promise<Answer> {
  return call(method, routePath, options);
}

// ────────────────────────────── the fixtures ─────────────────────────────────

const SYSTEM_ACTOR = { handle: 'retry-contract-suite', authMethod: 'system' as const };
const tag = (): string => crypto.randomBytes(6).toString('hex');
const freshKey = (): string => `rk-${crypto.randomBytes(16).toString('hex')}`;

interface Caller {
  principalId: string;
  credentialId: string;
  fullKey: string;
  handle: string;
}

let ACCOUNT: string;
let PRIMARY: Caller;
let SECOND_CREDENTIAL: Caller;   // same principal, a second credential
let OTHER_PRINCIPAL: Caller;     // a different principal entirely
/**
 * The SAME principal as PRIMARY, on a credential that carries the route scope
 * but NOT the field-level ones.
 *
 * Review round 3 found the hole this exists to measure: the no-record baseline
 * used two credentials with IDENTICAL full scopes, so the case where a replay
 * could serve a result the handler would refuse could not arise in the fixture
 * at all. A universal claim measured over a fixture that cannot exhibit its
 * counterexample is not measured.
 */
let REDUCED_CREDENTIAL: Caller;
let PROJECT_ID: string;
/**
 * A PUBLISHED Connector and a Task, so the no-record baseline can send bodies
 * that REACH the handlers' field-level authority checks — a Service-targeting
 * executionProfile and a reported stream append. Without them the baseline
 * measures three bland bodies that no field check ever sees, which is the hole
 * review round 3 found.
 */
let FIELD_GATE_SERVICE: string;
let FIELD_GATE_TASK: string;

const SCOPES = [
  'tasks:read', 'tasks:write', 'reports:read', 'reports:write',
  'projects:read', 'projects:write', 'principals:read',
  // `services:*` is here for ONE reason: the B-1 recovery drill reassigns a
  // Task to a Connector, and vocabulary b94dd86e §5.3 requires `invoke` on that
  // Service for exactly that act ("a role change must not become a covert
  // execution grant"). Without it the drill measures a 403 instead of the guard.
  'services:read', 'services:write', 'services:invoke',
];

/**
 * A Connector, in the shape the delegation contract admits (AUTHZ `4d961e37`).
 *
 * Three facts had to be respected rather than worked around, and they are worth
 * stating because each one silently produced an authorized-looking caller with
 * NO authority:
 *
 *  1. `own_expression` is REQUIRED. Inheritance is never implicit (AZ-24):
 *     `DelegationService.effectiveScopes` returns `[]` for a parented principal
 *     with no expression, so the credential's own scope list never reaches the
 *     route and every write answers a plain 403 FORBIDDEN.
 *  2. The ACCOUNT's role bounds the whole chain. A `user`-role Account caps the
 *     chain below `*:write`, so the Account here carries `admin` — the
 *     owner-plane role a parentless Account may hold.
 *  3. An elevated role may not be PARENTED (`principals_elevated_parentless`,
 *     096): the Connector itself carries no role and inherits.
 */
async function makeConnector(label: string): Promise<Caller> {
  const handle = `${label}-${tag()}`;
  const principal = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, $2, 'active', $3, $4, $5::jsonb) RETURNING id`,
    [handle, `retry contract ${label}`, ACCOUNT, `retry contract ${label} connector`,
     JSON.stringify({ scopes: 'parent', objects: 'parent' })],
  );
  const principalId = String(principal.rows[0].id);
  const issued = await principalService.issueCredential(
    { principalId, scopes: SCOPES, transport: 'any' }, SYSTEM_ACTOR);
  return { principalId, credentialId: issued.credentialId, fullKey: issued.fullKey, handle };
}

async function secondCredentialFor(caller: Caller): Promise<Caller> {
  const issued = await principalService.issueCredential(
    { principalId: caller.principalId, scopes: SCOPES, transport: 'any' }, SYSTEM_ACTOR);
  return { ...caller, credentialId: issued.credentialId, fullKey: issued.fullKey };
}

/**
 * The route scope WITHOUT the field-level ones. `tasks:write` reaches the route;
 * `services:invoke` (a Service-targeting executionProfile) and `services:write`
 * (a reported stream append) are exactly what this credential lacks, so the
 * handler refuses it where a full-authority credential succeeds.
 */
const REDUCED_SCOPES = SCOPES.filter(
  (scope) => scope !== 'services:invoke' && scope !== 'services:write');

async function reducedCredentialFor(caller: Caller): Promise<Caller> {
  const issued = await principalService.issueCredential(
    { principalId: caller.principalId, scopes: REDUCED_SCOPES, transport: 'any' }, SYSTEM_ACTOR);
  return { ...caller, credentialId: issued.credentialId, fullKey: issued.fullKey };
}

// ───────────────────────── the schema-wide snapshot ──────────────────────────

/**
 * §4.2 assertion (a) and (b) read the DATABASE, not a census.
 *
 * Round 4 broke a manifest-limited comparison with a trigger-driven in-place
 * write into a table no import closure reaches, and the repair was not a fourth
 * census: it was to take the census out of the comparison path entirely. Every
 * row of every table `information_schema` reports is snapshotted and compared
 * column by column, so a trigger, a rule, a cascade or a mechanism nobody has
 * thought of all land in the snapshot — because the snapshot IS the database.
 */
async function schemaTables(): Promise<string[]> {
  const rows = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`);
  return rows.rows.map((row: any) => String(row.table_name));
}

type Snapshot = Map<string, string[]>;

async function readSchema(): Promise<Snapshot> {
  const out: Snapshot = new Map();
  for (const table of await schemaTables()) {
    const rows = await pool.query(`SELECT to_jsonb(t) AS row FROM "${table}" t`);
    out.set(table, rows.rows.map((row: any) => JSON.stringify(row.row)).sort());
  }
  return out;
}

const serialize = (value: Snapshot): string =>
  [...value.entries()].map(([table, rows]) => `${table}\n${rows.join('\n')}`).sort().join('\n--\n');

/**
 * A snapshot taken AT REST.
 *
 * Some writes on this substrate land AFTER the response — the notification
 * manager and the feed both continue on the event loop once the handler has
 * answered. A snapshot taken the instant a call returns can therefore catch the
 * database mid-write, and the comparison would then be measuring scheduling
 * rather than convergence: an intermittently red gate is a gate people learn to
 * re-run. Two consecutive identical reads mean nothing is still moving; a
 * snapshot that never settles FAILS rather than being taken anyway, because a
 * database that will not go quiet is a finding, not a wait.
 */
async function otherActiveQueries(): Promise<number> {
  const rows = await pool.query(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active'`);
  return Number(rows.rows[0].n);
}

async function snapshot(): Promise<Snapshot> {
  let previous = await readSchema();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    // TWO conditions, because two consecutive equal reads alone are not enough:
    // several writes on this substrate are FIRE-AND-FORGET — `updateTask` calls
    // `taskHistoryService.recordChange(...)` and `notifyStatusChange(...)`
    // WITHOUT awaiting them (TaskManagerDB.ts:2558-2570) — so a row belonging to
    // call 1 can land after the response, after two equal reads, and appear to
    // the comparison as though call 2 wrote it. Asking PostgreSQL whether
    // anything else is still ACTIVE observes that directly instead of hoping
    // the window was long enough.
    const current = await readSchema();
    const settled = serialize(current) === serialize(previous) && (await otherActiveQueries()) === 0;
    if (settled) return current;
    previous = current;
  }
  throw new Error('the database never went quiet: a snapshot could not be taken at rest');
}

interface Difference { table: string; column: string; detail: string }

/** (a) — every column of every row equal, except the declared exemptions. */
function columnDifferences(before: Snapshot, after: Snapshot, exempt: Set<string>): Difference[] {
  const out: Difference[] = [];
  for (const [table, beforeRows] of before) {
    const afterRows = after.get(table) ?? [];
    if (beforeRows.length !== afterRows.length) continue; // (b)'s business, not (a)'s
    const strip = (rows: string[]): string[] => rows
      .map((row) => {
        const value = JSON.parse(row) as Record<string, unknown>;
        for (const column of Object.keys(value)) {
          if (exempt.has(`${table}.${column}`)) delete value[column];
        }
        return JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]]));
      })
      .sort();
    const strippedBefore = strip(beforeRows);
    const strippedAfter = strip(afterRows);
    for (let index = 0; index < strippedBefore.length; index += 1) {
      if (strippedBefore[index] !== strippedAfter[index]) {
        out.push({
          table,
          column: '<row>',
          detail: `row changed in place:\n  before ${strippedBefore[index].slice(0, 400)}\n  after  ${strippedAfter[index].slice(0, 400)}`,
        });
      }
    }
  }
  return out;
}

/** (b) — every table's row count equal, except a declared feed-event allowance. */
function countDifferences(
  before: Snapshot, after: Snapshot, allowance: Record<string, number>,
): Difference[] {
  const out: Difference[] = [];
  for (const [table, beforeRows] of before) {
    const afterRows = after.get(table) ?? [];
    const allowed = allowance[table] ?? 0;
    const grew = afterRows.length - beforeRows.length;
    if (grew !== allowed) {
      out.push({ table, column: '<count>', detail: `row count moved by ${grew}, allowance ${allowed}` });
    }
  }
  for (const table of after.keys()) {
    if (!before.has(table)) out.push({ table, column: '<table>', detail: 'a table appeared between snapshots' });
  }
  return out;
}

// ──────────────────────────── lifecycle ──────────────────────────────────────

beforeAll(async () => {
  const probe = await pool.query('SELECT current_database() AS db');
  expect(String(probe.rows[0].db)).toBe(TEST_DB_NAME);

  const account = await principalService.createPrincipal({
    handle: `retry-acct-${tag()}`, kind: 'service', role: 'admin',
    purpose: 'fb06c930 retry-contract gate account',
  });
  ACCOUNT = String(account.id);

  PRIMARY = await makeConnector('retry-primary');
  SECOND_CREDENTIAL = await secondCredentialFor(PRIMARY);
  REDUCED_CREDENTIAL = await reducedCredentialFor(PRIMARY);
  OTHER_PRINCIPAL = await makeConnector('retry-other');

  server = buildApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;

  // The fail-closed bootstrap gate (strategy §2.10): a WORK-plane tools/call
  // from a credential with no live bootstrap record is refused before the
  // handler. Recording it is what `POST /principals/me/brief` does, and it is a
  // precondition of driving /mcp at all — not something this candidate changes.
  for (const caller of [PRIMARY, SECOND_CREDENTIAL, REDUCED_CREDENTIAL, OTHER_PRINCIPAL]) {
    const brief = await call('POST', '/principals/me/brief', { body: {}, token: caller.fullKey });
    expect({ credential: caller.credentialId, status: brief.status })
      .toEqual({ credential: caller.credentialId, status: 200 });
  }

  const bootProject = await call('POST', '/projects', {
    body: { name: `retry-contract-${tag()}` }, key: freshKey(),
  });
  expect(bootProject.status).toBe(201);
  PROJECT_ID = String((bootProject.json.project ?? bootProject.json).id);

  FIELD_GATE_SERVICE = (await publishedConnector()).serviceId;
  FIELD_GATE_TASK = await makeTask('field-gate baseline fixture');
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end().catch(() => undefined);
});

// ─────────────────────── shared per-operation fixtures ───────────────────────

async function makeTask(title = `retry ${tag()}`): Promise<string> {
  // `autoStart: true` ARMS the Task: a parked Task answers 409 TASK_NOT_ARMED
  // on claim, which would make the claim/release oracle rows measure a refusal
  // rather than the convergence their sentences describe.
  const answer = await call('POST', '/tasks', {
    body: { title, description: 'retry contract fixture', status: 'todo', project: PROJECT_ID, autoStart: true },
    key: freshKey(),
  });
  expect(answer.status).toBe(201);
  const taskId = String((answer.json.task ?? answer.json).id);
  // Seed an execution profile so BOTH compat mirrors exist for this Task.
  // Without one, `mirror_task_execution_profile_compat` DELETEs the
  // `task_execution_profiles` row (086:156-158) and the exemption declared for
  // it can never fire — an exemption nothing exercises is a clamp waiting to be
  // leaned on, so the FIXTURE is repaired rather than the register.
  await pool.query(
    `UPDATE tasks SET execution_profile = '{"options":{}}'::jsonb WHERE id = $1`, [taskId]);
  return taskId;
}

async function recordCount(): Promise<number> {
  const rows = await pool.query('SELECT count(*)::int AS n FROM operation_idempotency_records');
  return rows.rows[0].n;
}

async function rowsFor(operation: string, key: string): Promise<any[]> {
  const rows = await pool.query(
    'SELECT * FROM operation_idempotency_records WHERE operation = $1 AND idempotency_key = $2',
    [operation, key]);
  return rows.rows;
}

/**
 * §4.1.1 — the control is the operation's REAL unkeyed exact-retry outcome,
 * asserted by name; and where that outcome is a REFUSAL rather than a
 * duplicate, the test additionally demonstrates that its counting oracle can
 * observe a duplicate, by varying the field the natural uniqueness is defined
 * over. Asserting "two records" of every operation, as v1 did, is simply false
 * for the operations the substrate makes naturally unique (B5.1).
 */
const countOf = (sql: string, params: unknown[] = []) => async (): Promise<number> => {
  const rows = await pool.query(sql, params);
  return Number(rows.rows[0].n);
};

describe('fb06c930 — the retry contract, on a real PostgreSQL', () => {
  it('the funnel matches the one server.ts registers (an outside anchor, not a comment)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8');
    // server.ts:199-201 — the ONE registration funnel for every protected router.
    const funnel = /const protectedRouter[\s\S]{0,300}?app\.use\(path,\s*([A-Za-z0-9_,\s]+?),\s*\.\.\.handlers\)/.exec(source);
    expect(funnel).not.toBeNull();
    const guards = (funnel as RegExpExecArray)[1].split(',').map((name) => name.trim()).filter(Boolean);
    expect(guards).toEqual(GUARD_CHAIN);
    // …and this suite really uses that list, read from this file rather than
    // from the constant, so the two cannot agree by both being edited.
    const own = fs.readFileSync(__filename.replace(/\.js$/, '.ts'), 'utf8');
    expect(own).toContain('app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);');
    // The route table is the production one, not a hand-listed subset.
    expect(source).toContain('registerProtectedRoutes(protectedRouter)');
  });

  it('migration 110 created the table with the constraints the design names', async () => {
    const columns = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'operation_idempotency_records' ORDER BY column_name`);
    const byName = Object.fromEntries(columns.rows.map((row: any) => [row.column_name, row.data_type]));
    // 4.1.2(t) — the type assertion, read from the DATABASE rather than from
    // the migration text, and order-independent (D4, red proof 10).
    expect(byName.response_body).toBe('text');
    expect(byName.response_status).toBe('integer');
    expect(byName.expires_at).toBe('timestamp with time zone');
    const checks = await pool.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'operation_idempotency_records'::regclass AND contype = 'c'
        ORDER BY conname`);
    expect(checks.rows.map((row: any) => row.conname)).toEqual([
      'operation_idempotency_key_length',
      'operation_idempotency_operation_policy',
      'operation_idempotency_operation_scope',
      'operation_idempotency_refuse_stores_nothing',
      'operation_idempotency_replay_policy',
      'operation_idempotency_return_completes_with_a_body',
      'operation_idempotency_scope_prefix',
      'operation_idempotency_state',
    ]);
  });

  /**
   * REVIEW ROUND 1, FINDING B1 — the mint's pack is unrepresentable BECAUSE THE
   * OPERATION IS BOUND TO ITS POLICY, not because the middleware writes the
   * declared one.
   *
   * `operation_idempotency_refuse_stores_nothing` predicates only on
   * `replay_policy`, a value the WRITER supplies: it forbids a stored response
   * on a row that SAYS 'refuse' and says nothing about a row that names a mint
   * operation and claims 'return'. That row satisfied every other constraint and
   * could carry the one-time pack, so design §3.1's promise was false as first
   * built. The binding below is what makes it true, and the two sources — the
   * SQL enumeration and the declaration table — are asserted equal so they
   * cannot drift apart in silence.
   */
  it('B1 — a mint row claiming return-policy is NOT REPRESENTABLE, whatever the writer says', async () => {
    const forbidden = pool.query(
      `INSERT INTO operation_idempotency_records
         (scope, operation, idempotency_key, request_hash, state, replay_policy,
          response_status, response_body, response_content_type, expires_at)
       VALUES ($1, 'agent.mint.request', $2, 'h', 'completed', 'return',
               201, '{"pack":{"secretOnce":"rh_dev_keyid01.thepack"}}', 'application/json',
               now() + interval '1 day')`,
      [`cred:${PRIMARY.credentialId}`, freshKey()]);
    await expect(forbidden).rejects.toThrow(/operation_idempotency_operation_policy/);

    // …the other direction too: a return-policy operation cannot claim refuse,
    // which would silently stop storing an answer callers are promised.
    const inverted = pool.query(
      `INSERT INTO operation_idempotency_records
         (scope, operation, idempotency_key, request_hash, state, replay_policy, expires_at)
       VALUES ($1, 'task.create', $2, 'h', 'in_flight', 'refuse', now() + interval '1 day')`,
      [`cred:${PRIMARY.credentialId}`, freshKey()]);
    await expect(inverted).rejects.toThrow(/operation_idempotency_operation_policy/);

    // …and an operation OUTSIDE the closed set is not representable at all,
    // which is what "closed" has to mean at the write (§3.3).
    const stranger = pool.query(
      `INSERT INTO operation_idempotency_records
         (scope, operation, idempotency_key, request_hash, state, replay_policy, expires_at)
       VALUES ($1, 'task.recover', $2, 'h', 'in_flight', 'return', now() + interval '1 day')`,
      [`cred:${PRIMARY.credentialId}`, freshKey()]);
    await expect(stranger).rejects.toThrow(/operation_idempotency_operation_policy/);
  });

  /**
   * THE AMENDMENT (dispatcher ruling 623632b0 on review round 3's B1/B2).
   *
   * `task.create`, `task.patch` and `task.stream.append` are CREDENTIAL-scoped
   * because their handlers apply a FIELD-level authority check the guard chain
   * does not. This asserts the amendment in all three places it has to hold: the
   * declaration table, the database constraint, and the live behaviour.
   */
  it('the AMENDMENT — the three field-gated operations are credential-scoped, everywhere', async () => {
    const FIELD_GATED = ['task.create', 'task.patch', 'task.stream.append'];
    // 1 · the declaration table.
    for (const operation of FIELD_GATED) {
      expect({ operation, scope: (IDEMPOTENT_OPERATIONS as Record<string, any>)[operation].scope })
        .toEqual({ operation, scope: 'credential' });
    }
    // …and the operations WITHOUT a field-level check keep principal scope, so
    // the amendment is a narrowing of three, not a change of policy everywhere.
    for (const operation of ['task.reference.create', 'task.note.append', 'report.create',
                             'project.create', 'project.resource.create']) {
      expect({ operation, scope: (IDEMPOTENT_OPERATIONS as Record<string, any>)[operation].scope })
        .toEqual({ operation, scope: 'principal' });
    }

    // 2 · the DATABASE: a wrong-scope row for a field-gated operation is not
    // writable at all, whatever the middleware believes.
    const wrongScope = pool.query(
      `INSERT INTO operation_idempotency_records
         (scope, operation, idempotency_key, request_hash, state, replay_policy, expires_at)
       VALUES ($1, 'task.create', $2, 'h', 'in_flight', 'return', now() + interval '1 day')`,
      [`prin:${PRIMARY.principalId}`, freshKey()]);
    await expect(wrongScope).rejects.toThrow(/operation_idempotency_operation_scope/);
    // …and the other direction: a principal-scoped operation cannot be written
    // credential-scoped either, so the binding is a binding and not a floor.
    const alsoWrong = pool.query(
      `INSERT INTO operation_idempotency_records
         (scope, operation, idempotency_key, request_hash, state, replay_policy, expires_at)
       VALUES ($1, 'report.create', $2, 'h', 'in_flight', 'return', now() + interval '1 day')`,
      [`cred:${PRIMARY.credentialId}`, freshKey()]);
    await expect(alsoWrong).rejects.toThrow(/operation_idempotency_operation_scope/);

    // 3 · LIVE: the record a real call writes carries the credential prefix.
    const key = freshKey();
    const created = await call('POST', '/tasks', {
      body: { title: `amendment ${tag()}`, project: PROJECT_ID }, key });
    expect(created.status).toBe(201);
    const rows = await rowsFor('task.create', key);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].scope)).toBe(`cred:${PRIMARY.credentialId}`);

    // 4 · THE BYPASS IS GONE, measured end to end. A SECOND credential of the
    // SAME principal sending the SAME request under the SAME key gets its own
    // row and reaches the handler — it is not served the first one's answer.
    const second = await call('POST', '/tasks', {
      body: { title: `amendment ${tag()}`, project: PROJECT_ID }, key,
      token: SECOND_CREDENTIAL.fullKey });
    expect(second.headers['retry-replayed']).toBeUndefined();
    const both = await pool.query(
      `SELECT scope FROM operation_idempotency_records
        WHERE operation = 'task.create' AND idempotency_key = $1 ORDER BY scope`, [key]);
    expect(both.rows.map((row: any) => String(row.scope)).sort())
      .toEqual([`cred:${PRIMARY.credentialId}`, `cred:${SECOND_CREDENTIAL.credentialId}`].sort());

    // 5 · THE COST, stated and measured rather than left implicit: for these
    // three operations two credentials of one principal now create TWO records
    // instead of sharing one replay. That is the behaviour §3.5 gave
    // principal-scoped operations, given up deliberately because it is what
    // carried the bypass. `report.create` still shares, so the change is
    // narrow — and this is the assertion that says so.
    const shared = freshKey();
    const body = { title: `still shared ${tag()}`, content: 'x' };
    const one = await call('POST', '/reports', { body, key: shared });
    const two = await call('POST', '/reports', { body, key: shared, token: SECOND_CREDENTIAL.fullKey });
    expect(one.status).toBe(201);
    expect(two.headers['retry-replayed']).toBe('true');
    expect(await rowsFor('report.create', shared)).toHaveLength(1);
  }, 120_000);

  it('the AMENDMENT — the reduced credential really is reduced, and the handler really refuses it', async () => {
    // The control on the fixture the baseline rests on. If this credential were
    // quietly full-authority, or the body stopped reaching the field check, the
    // baseline would pass while measuring nothing.
    const profileBody = {
      title: `reduced ${tag()}`, project: PROJECT_ID,
      executionProfile: { serviceId: FIELD_GATE_SERVICE, options: {} },
    };
    const full = await call('POST', '/tasks', { body: profileBody, key: freshKey() });
    expect(full.status).toBe(201);
    const reduced = await call('POST', '/tasks', {
      body: profileBody, key: freshKey(), token: REDUCED_CREDENTIAL.fullKey });
    expect({ status: reduced.status, code: String(reduced.json?.code) })
      .toEqual({ status: 403, code: 'PROFILE_INVOKE_REQUIRED' });
    // …and the same credential CAN do the thing the route scope allows, so what
    // it lacks is the FIELD authority and not the route.
    const allowed = await call('POST', '/tasks', {
      body: { title: `reduced ok ${tag()}`, project: PROJECT_ID },
      key: freshKey(), token: REDUCED_CREDENTIAL.fullKey });
    expect(allowed.status).toBe(201);
    // The stream side of the same story.
    const reported = await call('POST', `/tasks/${FIELD_GATE_TASK}/stream`, {
      body: { content: `reduced ${tag()}`, provenance: 'reported' },
      key: freshKey(), token: REDUCED_CREDENTIAL.fullKey });
    expect({ status: reported.status, code: String(reported.json?.code) })
      .toEqual({ status: 403, code: 'OUTPOST_AUTHORITY_REQUIRED' });
  }, 120_000);

  it('B1 — the SQL binding and the declaration table are the SAME closed set, by value', async () => {
    // Two sources of truth are a drift waiting to happen, so the drift is a test
    // failure: the constraint's own text is read from `pg_constraint` and
    // compared against `IDEMPOTENT_OPERATIONS` in both directions.
    const rows = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'operation_idempotency_records'::regclass
          AND conname = 'operation_idempotency_operation_policy'`);
    expect(rows.rows).toHaveLength(1);
    const definition = String(rows.rows[0].def);
    const inSql = (policy: string): string[] => {
      const pattern = new RegExp(`operation = ANY \\(ARRAY\\[([^\\]]+)\\][^)]*\\)\\) AND \\(replay_policy = '${policy}'`);
      const match = pattern.exec(definition.replace(/\n/g, ' '));
      if (!match) return [];
      return (match[1].match(/'([a-z.]+)'/g) ?? []).map((quoted) => quoted.replace(/'/g, '')).sort();
    };
    const declared = (policy: string): string[] => Object.entries(IDEMPOTENT_OPERATIONS)
      .filter(([, value]) => (value as any).replay === policy)
      .map(([name]) => name).sort();
    expect({ policy: 'return', sql: inSql('return') }).toEqual({ policy: 'return', sql: declared('return') });
    expect({ policy: 'refuse', sql: inSql('refuse') }).toEqual({ policy: 'refuse', sql: declared('refuse') });
    // Not vacuous: the parse really found operations, and all ten are covered.
    expect(inSql('return').length + inSql('refuse').length).toBe(Object.keys(IDEMPOTENT_OPERATIONS).length);
    expect(inSql('refuse')).toEqual(['agent.mint.collect', 'agent.mint.request']);
  });

  // ═════════════════ 4.1.1 — a control per operation ═════════════════

  describe('4.1.1 — each operation\'s REAL unkeyed exact-retry outcome', () => {
    it('task.create — the duplicate IS the control: two Tasks', async () => {
      const body = { title: `unkeyed ${tag()}`, status: 'todo', project: PROJECT_ID };
      const first = await call('POST', '/tasks', { body });
      const second = await call('POST', '/tasks', { body });
      expect([first.status, second.status]).toEqual([201, 201]);
      const ids = [String((first.json.task ?? first.json).id), String((second.json.task ?? second.json).id)];
      expect(ids[0]).not.toBe(ids[1]);
    });

    it('task.stream.append — two stream entries (append has no dedupe branch)', async () => {
      const taskId = await makeTask();
      const body = { content: `entry ${tag()}` };
      const before = await countOf('SELECT count(*)::int AS n FROM task_stream_entries WHERE task_id = $1', [taskId])();
      await call('POST', `/tasks/${taskId}/stream`, { body });
      await call('POST', `/tasks/${taskId}/stream`, { body });
      const after = await countOf('SELECT count(*)::int AS n FROM task_stream_entries WHERE task_id = $1', [taskId])();
      expect(after - before).toBe(2);
    });

    it('task.reference.create — two references', async () => {
      const taskId = await makeTask();
      const body = { kind: 'reference', label: `ref ${tag()}`, targetUri: 'https://example.invalid/x' };
      await call('POST', `/tasks/${taskId}/references`, { body });
      await call('POST', `/tasks/${taskId}/references`, { body });
      const n = await countOf('SELECT count(*)::int AS n FROM task_references WHERE task_id = $1', [taskId])();
      expect(n).toBe(2);
    });

    it('task.note.append — the notes column carries two timestamped entries', async () => {
      const taskId = await makeTask();
      const text = `note ${tag()}`;
      await call('POST', `/tasks/${taskId}/notes`, { body: { text } });
      await call('POST', `/tasks/${taskId}/notes`, { body: { text } });
      const rows = await pool.query('SELECT notes FROM tasks WHERE id = $1', [taskId]);
      const occurrences = String(rows.rows[0].notes ?? '').split(text).length - 1;
      expect(occurrences).toBe(2);
    });

    it('report.create — two Reports', async () => {
      const body = { title: `report ${tag()}`, content: 'retry contract control' };
      const first = await call('POST', '/reports', { body });
      const second = await call('POST', '/reports', { body });
      expect([first.status, second.status]).toEqual([201, 201]);
      expect(String((first.json.report ?? first.json).id))
        .not.toBe(String((second.json.report ?? second.json).id));
    });

    it('project.create — REFUSED by active-name uniqueness, and the counter can still see two', async () => {
      const name = `dup-${tag()}`;
      const first = await call('POST', '/projects', { body: { name } });
      expect(first.status).toBe(201);
      const second = await call('POST', '/projects', { body: { name } });
      // The natural-uniqueness refusal, asserted BY NAME — not "two rows".
      expect(second.status).toBe(409);
      expect(String(second.json.code)).toBe('PROJECT_NAME_CONFLICT');
      const n = await countOf('SELECT count(*)::int AS n FROM projects WHERE name = $1', [name])();
      expect(n).toBe(1);
      // …and the control that proves the counting oracle can observe a second
      // row at all: vary the field the uniqueness is defined over.
      const varied = await call('POST', '/projects', { body: { name: `${name}-b` } });
      expect(varied.status).toBe(201);
      expect(await countOf('SELECT count(*)::int AS n FROM projects WHERE name LIKE $1', [`${name}%`])()).toBe(2);
    });

    it('project.resource.create — REFUSED by the active-tuple unique index, and the counter can still see two', async () => {
      const name = `res-${tag()}`;
      const body = {
        kind: 'reference', name,
        details: { url: 'https://example.invalid/doc', category: 'documentation' },
      };
      const first = await call('POST', `/projects/${PROJECT_ID}/resources`, { body });
      expect(first.status).toBe(201);
      const second = await call('POST', `/projects/${PROJECT_ID}/resources`, { body });
      expect(second.status).toBeGreaterThanOrEqual(400);
      expect(await countOf(
        'SELECT count(*)::int AS n FROM project_resources WHERE project_id = $1 AND name = $2',
        [PROJECT_ID, name])()).toBe(1);
      const varied = await call('POST', `/projects/${PROJECT_ID}/resources`, {
        body: { ...body, name: `${name}-b` },
      });
      expect(varied.status).toBe(201);
      expect(await countOf(
        'SELECT count(*)::int AS n FROM project_resources WHERE project_id = $1 AND name LIKE $2',
        [PROJECT_ID, `${name}%`])()).toBe(2);
    });

    it('task.patch — one Task, the same values re-applied; the state oracle can see a change', async () => {
      const taskId = await makeTask();
      await call('PATCH', `/tasks/${taskId}`, { body: { priority: 'high' } });
      await call('PATCH', `/tasks/${taskId}`, { body: { priority: 'high' } });
      const same = await pool.query('SELECT priority FROM tasks WHERE id = $1', [taskId]);
      expect(String(same.rows[0].priority)).toBe('high');
      expect(await countOf('SELECT count(*)::int AS n FROM tasks WHERE id = $1', [taskId])()).toBe(1);
      // The control: a DIFFERENT value changes the end state, so the oracle is
      // not one that would report "unchanged" whatever happened.
      await call('PATCH', `/tasks/${taskId}`, { body: { priority: 'low' } });
      const moved = await pool.query('SELECT priority FROM tasks WHERE id = $1', [taskId]);
      expect(String(moved.rows[0].priority)).toBe('low');
    });
  });

  // ═════════════════ 4.1.2 — replay, and byte identity ═════════════════

  describe('4.1.2 — an exact retry yields ONE record and a BYTE-IDENTICAL answer', () => {
    it('task.create replays the exact bytes under Retry-Replayed', async () => {
      const key = freshKey();
      const body = { title: `keyed ${tag()}`, status: 'todo', project: PROJECT_ID };
      const first = await call('POST', '/tasks', { body, key });
      const second = await call('POST', '/tasks', { body, key });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      // On the wire, as text — not a parsed comparison.
      expect(second.text).toBe(first.text);
      expect(second.headers['content-type']).toBe(first.headers['content-type']);
      expect(second.headers['retry-replayed']).toBe('true');
      expect(first.headers['retry-replayed']).toBeUndefined();
      expect(second.headers['retry-request-id']).toBe(first.headers['retry-request-id']);
      // ONE record, and ONE Task.
      expect(await rowsFor('task.create', key)).toHaveLength(1);
      expect(await countOf('SELECT count(*)::int AS n FROM tasks WHERE title = $1', [body.title])()).toBe(1);
    });

    it('report.create replays the exact bytes', async () => {
      const key = freshKey();
      const body = { title: `keyed report ${tag()}`, content: 'x' };
      const first = await call('POST', '/reports', { body, key });
      const second = await call('POST', '/reports', { body, key });
      expect(second.text).toBe(first.text);
      expect(second.headers['retry-replayed']).toBe('true');
      expect(await countOf('SELECT count(*)::int AS n FROM reports WHERE title = $1', [body.title])()).toBe(1);
    });

    it('the byte comparison is BYTE-level: a transposed-key body of the same value FAILS it', async () => {
      // A byte assertion that is quietly a parsed assertion is worse than no
      // assertion. This writes a completed row by hand whose stored body is the
      // first answer's JSON with two top-level keys transposed — semantically
      // identical, textually different — and requires the comparison to fail.
      const key = freshKey();
      const body = { title: `transposed ${tag()}`, content: 'x' };
      const first = await call('POST', '/reports', { body, key });
      const stored = await pool.query(
        'SELECT scope, response_body FROM operation_idempotency_records WHERE operation = $1 AND idempotency_key = $2',
        ['report.create', key]);
      const original = String(stored.rows[0].response_body);
      const value = JSON.parse(original) as Record<string, unknown>;
      const keys = Object.keys(value);
      expect(keys.length).toBeGreaterThan(1);
      const transposed = JSON.stringify(Object.fromEntries(
        [keys[1], keys[0], ...keys.slice(2)].map((name) => [name, value[name]])));
      expect(transposed).not.toBe(original);
      expect(JSON.parse(transposed)).toEqual(JSON.parse(original));   // same value…
      await pool.query(
        'UPDATE operation_idempotency_records SET response_body = $3 WHERE scope = $1 AND idempotency_key = $2',
        [stored.rows[0].scope, key, transposed]);
      const replay = await call('POST', '/reports', { body, key });
      expect(replay.headers['retry-replayed']).toBe('true');
      // …and the comparison this suite makes REJECTS it. A parsed comparison
      // would have passed, which is exactly what round 2 rejected.
      expect(replay.text).not.toBe(first.text);
      expect(JSON.parse(replay.text)).toEqual(JSON.parse(first.text));
    });
  });

  it('4.1.3 — the same key with a different body is IDEMPOTENCY_KEY_REUSED, and no record is added', async () => {
    const key = freshKey();
    await call('POST', '/tasks', { body: { title: `a ${tag()}`, project: PROJECT_ID }, key });
    const before = await recordCount();
    const reused = await call('POST', '/tasks', { body: { title: `b ${tag()}`, project: PROJECT_ID }, key });
    expect(reused.status).toBe(409);
    expect(String(reused.json.code)).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await recordCount()).toBe(before);
  });

  it('4.1.5 — a key of 15 and of 129 characters is refused, and leaves no record', async () => {
    const before = await recordCount();
    for (const key of ['x'.repeat(15), 'x'.repeat(129)]) {
      const answer = await call('POST', '/tasks', { body: { title: `len ${tag()}`, project: PROJECT_ID }, key });
      expect(answer.status).toBe(400);
      expect(String(answer.json.code)).toBe('IDEMPOTENCY_KEY_INVALID');
    }
    // …and 16 and 128 are accepted, so the bound is a bound and not a wall.
    for (const key of [`k${'x'.repeat(15)}`, `k${'x'.repeat(127)}`]) {
      const answer = await call('POST', '/tasks', { body: { title: `len ${tag()}`, project: PROJECT_ID }, key });
      expect(answer.status).toBe(201);
    }
    expect(await recordCount()).toBe(before + 2);
  });

  it('4.1.6 — two identical requests started together produce exactly ONE record', async () => {
    const key = freshKey();
    const body = { title: `race ${tag()}`, status: 'todo', project: PROJECT_ID };
    const answers = await Promise.all([
      callDetached('POST', '/tasks', { body, key }),
      callDetached('POST', '/tasks', { body, key }),
    ]);
    expect(await rowsFor('task.create', key)).toHaveLength(1);
    expect(await countOf('SELECT count(*)::int AS n FROM tasks WHERE title = $1', [body.title])()).toBe(1);
    // The loser answers either a replay or IN_FLIGHT — a closed set of two.
    // Both are legitimate, so NO red-proof row is credited to this assertion:
    // a two-outcome set cannot guarantee a red. The ORDERING claim is 4.1.12's.
    const outcomes = answers.map((answer) => (answer.status === 201
      ? 'created-or-replayed'
      : String(answer.json?.code))).sort();
    expect(outcomes.every((outcome) => outcome === 'created-or-replayed' || outcome === 'IDEMPOTENCY_KEY_IN_FLIGHT')).toBe(true);
  });

  it('4.1.7 — a refused first attempt leaves NO reservation, and the key can succeed later', async () => {
    const key = freshKey();
    const refused = await call('POST', '/reports', { body: { content: 'no title' }, key });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await rowsFor('report.create', key)).toHaveLength(0);
    const accepted = await call('POST', '/reports', { body: { title: `later ${tag()}`, content: 'x' }, key });
    expect(accepted.status).toBe(201);
    expect(await rowsFor('report.create', key)).toHaveLength(1);
  });

  it('4.1.8 — a completed row past expires_at is treated as ABSENT', async () => {
    const key = freshKey();
    const body = { title: `expiry ${tag()}`, content: 'x' };
    const first = await call('POST', '/reports', { body, key });
    expect(first.status).toBe(201);
    await pool.query(
      `UPDATE operation_idempotency_records SET expires_at = now() - interval '1 minute'
        WHERE operation = 'report.create' AND idempotency_key = $1`, [key]);
    const second = await call('POST', '/reports', { body, key });
    expect(second.status).toBe(201);
    expect(second.headers['retry-replayed']).toBeUndefined();
    // A fresh record, not the stale one.
    const rows = await rowsFor('report.create', key);
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(await countOf('SELECT count(*)::int AS n FROM reports WHERE title = $1', [body.title])()).toBe(2);
  });

  it('4.1.9 — an in-flight row younger than the threshold refuses; an older one is taken over', async () => {
    const key = freshKey();
    const scope = `cred:${PRIMARY.credentialId}`;
    await pool.query(
      `INSERT INTO operation_idempotency_records
         (scope, operation, idempotency_key, request_hash, state, replay_policy, expires_at)
       VALUES ($1, 'task.create', $2, 'not-the-hash', 'in_flight', 'return', now() + interval '1 day')`,
      [scope, key]);
    const blocked = await call('POST', '/tasks', { body: { title: `flight ${tag()}`, project: PROJECT_ID }, key });
    expect(blocked.status).toBe(409);
    expect(String(blocked.json.code)).toBe('IDEMPOTENCY_KEY_IN_FLIGHT');

    await pool.query(
      `UPDATE operation_idempotency_records SET created_at = now() - ($2 || ' milliseconds')::interval - interval '1 second'
        WHERE scope = $1 AND idempotency_key = $3`,
      [scope, String(IDEMPOTENCY_IN_FLIGHT_TAKEOVER_MS), key]);
    const takenOver = await call('POST', '/tasks', { body: { title: `flight ${tag()}`, project: PROJECT_ID }, key });
    expect(takenOver.status).toBe(201);
    const rows = await rowsFor('task.create', key);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('completed');
  });

  it('4.1.10 — the sweep deletes only expired rows: a live row survives one that does not', async () => {
    const scope = `cred:${PRIMARY.credentialId}`;
    const live = freshKey();
    const dead = freshKey();
    await pool.query(
      `INSERT INTO operation_idempotency_records
         (scope, operation, idempotency_key, request_hash, state, replay_policy, expires_at)
       VALUES ($1, 'task.create', $2, 'h', 'in_flight', 'return', now() + interval '1 day'),
              ($1, 'task.create', $3, 'h', 'in_flight', 'return', now() - interval '1 day')`,
      [scope, live, dead]);
    await sweepExpiredIdempotencyRecords();
    expect(await rowsFor('task.create', dead)).toHaveLength(0);
    expect(await rowsFor('task.create', live)).toHaveLength(1);
    await pool.query('DELETE FROM operation_idempotency_records WHERE idempotency_key = $1', [live]);
  });
});

// ═════════════════ 4.1.4 — the scope proofs, both kinds ═════════════════

/**
 * §4.1.4's no-record baseline, ONE FIXTURE PER DECLARED `return` OPERATION.
 *
 * Keyed by the operation names the declaration table itself uses, so the gate
 * can derive its case set from the declaration rather than repeating it: an
 * operation the declaration names and this table does not is a FAILURE, not a
 * silent omission. That is round 4's finding, repaired at the mechanism rather
 * than at the two coordinates it happened to expose.
 *
 * `fieldGate` names the authority the second credential is deliberately WITHOUT.
 * A fixture that declares one must send a body that REACHES that check — the
 * loop asserts every such fixture really was refused on its no-row run, so a
 * body that stops reaching the gate fails rather than passing quietly.
 */
interface BaselineFixture {
  method: string;
  /** A function, because the Task and Project ids are built in `beforeAll`. */
  path: () => string;
  body: () => unknown;
  /** The SECOND credential this case runs as. */
  as: () => Caller;
  /** The field-level authority `as()` lacks, where there is one. */
  fieldGate?: string;
}

const BASELINE_FIXTURES: Record<string, BaselineFixture> = {
  // ── the three the amendment moved to credential scope ──────────────────
  // Each sends a body that REACHES its handler's field-level check, as a
  // credential of the SAME principal that does not satisfy it.
  'task.create': {
    method: 'POST', path: () => '/tasks', fieldGate: 'services:invoke',
    as: () => REDUCED_CREDENTIAL,
    body: () => ({ title: `base ${tag()}`, project: PROJECT_ID,
                   executionProfile: { serviceId: FIELD_GATE_SERVICE, options: {} } }),
  },
  'task.patch': {
    method: 'PATCH', path: () => `/tasks/${FIELD_GATE_TASK}`, fieldGate: 'services:invoke',
    as: () => REDUCED_CREDENTIAL,
    body: () => ({ executionProfile: { serviceId: FIELD_GATE_SERVICE, options: {} } }),
  },
  'task.stream.append': {
    method: 'POST', path: () => `/tasks/${FIELD_GATE_TASK}/stream`, fieldGate: 'services:write',
    as: () => REDUCED_CREDENTIAL,
    // A reported entry names the Outpost it is reported FOR — the route asks
    // for that before it asks for authority, so the body has to carry it or the
    // drill measures OUTPOST_REQUIRED instead of the field gate.
    body: () => ({ content: `base ${tag()}`, provenance: 'reported',
                   outpostServiceId: FIELD_GATE_SERVICE }),
  },
  // ── the five with NO field-level check beyond their route scope ─────────
  // Still measured, on a second credential of the same principal, so the
  // baseline covers both kinds and can say so rather than assuming it.
  'task.reference.create': {
    method: 'POST', path: () => `/tasks/${FIELD_GATE_TASK}/references`,
    as: () => SECOND_CREDENTIAL,
    body: () => ({ kind: 'reference', label: `base ${tag()}`,
                   targetUri: 'https://example.invalid/b' }),
  },
  'task.note.append': {
    method: 'POST', path: () => `/tasks/${FIELD_GATE_TASK}/notes`,
    as: () => SECOND_CREDENTIAL,
    body: () => ({ text: `base note ${tag()}` }),
  },
  'report.create': {
    method: 'POST', path: () => '/reports', as: () => SECOND_CREDENTIAL,
    body: () => ({ title: `base ${tag()}`, content: 'x' }),
  },
  'project.create': {
    method: 'POST', path: () => '/projects', as: () => SECOND_CREDENTIAL,
    body: () => ({ name: `base-${tag()}` }),
  },
  'project.resource.create': {
    method: 'POST', path: () => `/projects/${PROJECT_ID}/resources`,
    as: () => SECOND_CREDENTIAL,
    // Its no-row run meets the active-name unique index rather than an
    // authority check — a 409, which the violation rule deliberately does NOT
    // count: absorbing exactly that conflict on an exact retry is what the
    // contract is FOR.
    body: () => ({ kind: 'reference', name: `base-${tag()}`,
                   details: { url: 'https://example.invalid/res', category: 'documentation' } }),
  },
};

describe('4.1.4 — the replay identity is (scope, operation, key), measured', () => {
  it('a principal-scoped operation: two credentials of the SAME principal share one record', async () => {
    const key = freshKey();
    const body = { title: `same-principal ${tag()}`, content: 'x' };
    const first = await call('POST', '/reports', { body, key });
    const second = await call('POST', '/reports', { body, key, token: SECOND_CREDENTIAL.fullKey });
    expect(first.status).toBe(201);
    // The replay IS served, and that is CORRECT: the authority follows the
    // principal, and both credentials are the same principal's.
    expect(second.headers['retry-replayed']).toBe('true');
    expect(second.text).toBe(first.text);
    expect(await rowsFor('report.create', key)).toHaveLength(1);
    expect(await countOf('SELECT count(*)::int AS n FROM reports WHERE title = $1', [body.title])()).toBe(1);
  });

  it('two DIFFERENT principals, the same key: two records, no replay', async () => {
    const key = freshKey();
    const body = { title: `two-principals ${tag()}`, content: 'x' };
    const first = await call('POST', '/reports', { body, key });
    const second = await call('POST', '/reports', { body, key, token: OTHER_PRINCIPAL.fullKey });
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.headers['retry-replayed']).toBeUndefined();
    expect(second.text).not.toBe(first.text);
    const rows = await pool.query(
      'SELECT scope FROM operation_idempotency_records WHERE operation = $1 AND idempotency_key = $2 ORDER BY scope',
      ['report.create', key]);
    expect(rows.rows).toHaveLength(2);
    expect(new Set(rows.rows.map((row: any) => String(row.scope))).size).toBe(2);
  });

  it('the same key on a DIFFERENT operation: two records', async () => {
    const key = freshKey();
    await call('POST', '/reports', { body: { title: `x ${tag()}`, content: 'x' }, key });
    await call('POST', '/tasks', { body: { title: `y ${tag()}`, project: PROJECT_ID }, key });
    const rows = await pool.query(
      'SELECT operation FROM operation_idempotency_records WHERE idempotency_key = $1 ORDER BY operation', [key]);
    expect(rows.rows.map((row: any) => String(row.operation))).toEqual(['report.create', 'task.create']);
  });

  it('the scope PREFIX has its own control — the counting assertion is not asked to imply it', async () => {
    // Round 3 showed a prefix mutation cannot be caught by the "two principals
    // → two records" assertion: `prin:A` and `prin:B` become `A` and `B`, still
    // distinct, so it still passes. The prefix is a WRITE-side invariant and it
    // is drilled where it is enforced — the CHECK constraint.
    const bare = pool.query(
      `INSERT INTO operation_idempotency_records
         (scope, operation, idempotency_key, request_hash, state, replay_policy, expires_at)
       VALUES ($1, 'report.create', $2, 'h', 'in_flight', 'return', now() + interval '1 day')`,
      [PRIMARY.principalId, freshKey()]);
    // An UNPREFIXED scope has no recognisable kind, so both scope constraints
    // reject it and PostgreSQL names whichever it reached first. Either is the
    // right answer; what matters is that the row is not writable.
    await expect(bare).rejects.toThrow(
      /operation_idempotency_scope_prefix|operation_idempotency_operation_scope/);
    const empty = pool.query(
      `INSERT INTO operation_idempotency_records
         (scope, operation, idempotency_key, request_hash, state, replay_policy, expires_at)
       VALUES ('prin:', 'report.create', $1, 'h', 'in_flight', 'return', now() + interval '1 day')`,
      [freshKey()]);
    // This one is the PREFIX constraint's alone: `split_part('prin:', ':', 1)`
    // is `prin`, so the kind binding is satisfied and only the prefix CHECK's
    // second conjunct — a non-empty id after the colon — can reject it.
    await expect(empty).rejects.toThrow(/operation_idempotency_scope_prefix/);
    // …and a properly prefixed scope is accepted, so the CHECK is a boundary
    // rather than a wall.
    const good = freshKey();
    await pool.query(
      `INSERT INTO operation_idempotency_records
         (scope, operation, idempotency_key, request_hash, state, replay_policy, expires_at)
       VALUES ($1, 'task.create', $2, 'h', 'in_flight', 'return', now() + interval '1 day')`,
      [`cred:${PRIMARY.credentialId}`, good]);
    await pool.query('DELETE FROM operation_idempotency_records WHERE idempotency_key = $1', [good]);
  });

  it('the universal claim is measured against a NO-RECORD baseline, not by inspection', async () => {
    // v2 recorded each operation's second-credential outcome, which — as round
    // 2 pointed out — says nothing about what the BYPASSED handler would have
    // done. Each operation runs its second-credential call TWICE: once with the
    // retry row present (the replay path) and once with that row deleted first
    // (the handler path). A violation is any operation where the no-row run
    // REFUSES and the with-row run answers 2xx: that is the mechanism serving a
    // replay the handler would have denied. Both runs are real executions of
    // the same request, so nothing about the comparison is test-owned.
    // THE CASE SET IS DERIVED FROM THE DECLARATION, NOT LISTED HERE.
    //
    // Round 4's finding: this baseline CLAIMED to be universal and carried six
    // of the eight `return` operations — `task.note.append` and
    // `project.resource.create` were simply absent, and nothing could notice.
    // That is the failure mode this card has been caught by at every level: a
    // census right about what it looked at and silent about what it missed,
    // this time inside the control written to prevent it.
    //
    // The repair is not a seventh and eighth entry. It is to stop LISTING the
    // operations: the loop below walks every `replay: 'return'` operation the
    // DECLARATION names, and looks each one up in the fixture table. An
    // operation with no fixture FAILS the gate rather than being skipped, so a
    // future operation joins this baseline by construction — adding it to the
    // declaration is what puts it here.
    const RETURN_OPERATIONS = Object.entries(IDEMPOTENT_OPERATIONS)
      .filter(([, declaration]) => (declaration as any).replay === 'return')
      .map(([operation]) => operation)
      .sort();
    // The fixture table is keyed by the declaration's own operation names, and
    // must cover them exactly — no gaps, and nothing here that the declaration
    // does not name.
    expect(Object.keys(BASELINE_FIXTURES).sort()).toEqual(RETURN_OPERATIONS);
    expect(RETURN_OPERATIONS.length).toBe(8);
    // WHICH refusals count. The violation this measures is an AUTHORIZATION
    // one: a replay served where the handler's own binding would have denied
    // the caller (401/403, or a 404-concealed foreign target). A 409 uniqueness
    // or state conflict is NOT a violation — absorbing exactly that conflict on
    // an exact retry is what the contract is FOR, and counting it here would
    // make the assertion say the opposite of the design.
    const AUTHORIZATION_REFUSALS = [401, 403, 404];
    const violations: string[] = [];
    const observed: Array<{ operation: string; withRow: number; noRow: number }> = [];
    const reachedAGate: string[] = [];
    for (const operation of RETURN_OPERATIONS) {
      const probe = BASELINE_FIXTURES[operation];
      // Belt to the by-value pin above: a declared operation that reaches the
      // loop without a fixture stops the gate rather than being skipped past.
      if (!probe) throw new Error(`no baseline fixture for declared return operation: ${operation}`);
      const body = probe.body();
      const key = freshKey();
      const path = probe.path();
      // The FIRST call is made by the full-authority credential, so a row really
      // is committed and there really is something to replay.
      const first = await call(probe.method, path, { body, key });
      expect({ operation, first: first.status < 400,
               why: first.status < 400 ? '' : first.text.slice(0, 200) })
        .toEqual({ operation, first: true, why: '' });

      // ── THE LABEL IS BOUND TO THE ACT, by the row the MIDDLEWARE wrote ──
      //
      // Review round 5's finding: the fixture's KEY said `task.note.append`
      // and nothing checked that the fixture's route and body reached that
      // operation. Substituting `report.create`'s method, path and body into
      // the still-keyed `task.note.append` fixture left all eight keys, every
      // assertion green, and that operation never exercised — the same class as
      // round 4, one layer in, in the control rather than the case list.
      //
      // The anchor is not something this file owns. `idempotent(operation)` is
      // mounted on the ROUTE, so the operation stored beside the key is the one
      // the request actually reached. Reading it back and requiring it to equal
      // the fixture's declared name makes a substituted route or body fail BY
      // CONSTRUCTION: the row comes back under the other operation, or not at
      // all. A fixture cannot forge this the way it can forge its own label.
      const anchor = await pool.query(
        'SELECT operation FROM operation_idempotency_records WHERE idempotency_key = $1',
        [key]);
      expect({ operation, reached: anchor.rows.map((row: any) => String(row.operation)) })
        .toEqual({ operation, reached: [operation] });
      const withRow = await call(probe.method, path, { body, key, token: probe.as().fullKey });
      await pool.query('DELETE FROM operation_idempotency_records WHERE idempotency_key = $1', [key]);
      const noRow = await call(probe.method, path, { body, key: freshKey(), token: probe.as().fullKey });
      observed.push({ operation, withRow: withRow.status, noRow: noRow.status });
      if (probe.fieldGate && AUTHORIZATION_REFUSALS.includes(noRow.status)) {
        reachedAGate.push(operation);
      }
      const served = withRow.status >= 200 && withRow.status < 300;
      if (served && AUTHORIZATION_REFUSALS.includes(noRow.status)) {
        violations.push(`${operation}: replay answered ${withRow.status} where the handler REFUSED with ${noRow.status}`);
      }
    }
    expect({ violations, observed }).toEqual({ violations: [], observed });
    // NOT VACUOUS, and this is the assertion round 3's finding turns on: the
    // three field-gated cases must actually have been REFUSED on the no-row
    // run. If the reduced credential were quietly full-authority, or the bodies
    // stopped reaching the check, every case would pass while measuring
    // nothing — which is exactly how the first version of this stayed green.
    // …and the expectation is DERIVED too: every fixture that declares a field
    // gate must have been refused on its no-row run. A hard-coded list here
    // would go stale the moment a field-gated operation joined the set.
    expect(reachedAGate.sort()).toEqual(
      Object.entries(BASELINE_FIXTURES)
        .filter(([, fixture]) => Boolean(fixture.fieldGate))
        .map(([operation]) => operation)
        .sort());
    expect(reachedAGate.length).toBe(3);
    // Not vacuous in the direction that matters: the guard chain runs BEFORE
    // this middleware (server.ts:199-201), so a replay can never be served to a
    // caller the chain has not admitted. Measured, not argued: the same key on
    // the same request with no credential is refused at the door, with the
    // stored row sitting right there.
    const key = freshKey();
    const body = { title: `ordering ${tag()}`, content: 'x' };
    expect((await call('POST', '/reports', { body, key })).status).toBe(201);
    expect(await rowsFor('report.create', key)).toHaveLength(1);
    const unauthenticated = await fetch(`${origin}/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(body),
    });
    expect([401, 403]).toContain(unauthenticated.status);
    // …and a garbage bearer likewise: the replay is unreachable, not merely unserved.
    const bogus = await call('POST', '/reports', { body, key, token: 'rh_dev_notarealkey.notarealsecret' });
    expect([401, 403]).toContain(bogus.status);
  });
});

// ═════════ 4.1.11 — the refuse-replay operations and the never-stored pack ═════════

describe('4.1.11 — refuse-replay stores nothing, and the constraints are the control', () => {
  it('the refuse direction is a CHECK, not a promise: a stored body is not representable', async () => {
    const refused = pool.query(
      `INSERT INTO operation_idempotency_records
         (scope, operation, idempotency_key, request_hash, state, replay_policy, response_body, expires_at)
       VALUES ($1, 'agent.mint.request', $2, 'h', 'completed', 'refuse', '{}', now() + interval '1 day')`,
      [`cred:${PRIMARY.credentialId}`, freshKey()]);
    await expect(refused).rejects.toThrow(/operation_idempotency_refuse_stores_nothing/);
  });

  it('the return direction is a CHECK too: a completed row with nothing to return is not representable', async () => {
    const refused = pool.query(
      `INSERT INTO operation_idempotency_records
         (scope, operation, idempotency_key, request_hash, state, replay_policy, response_body, expires_at)
       VALUES ($1, 'task.create', $2, 'h', 'completed', 'return', NULL, now() + interval '1 day')`,
      [`cred:${PRIMARY.credentialId}`, freshKey()]);
    await expect(refused).rejects.toThrow(/operation_idempotency_return_completes_with_a_body/);
  });

  /**
   * A REAL keyed mint, driven through the production route.
   *
   * Ruling 2 is about an operation that must never replay, so asserting it over
   * a table that happens to hold no mint rows would be the emptiest kind of
   * green. The approval path (`via: 'approval'`) is a mint this Connector can
   * actually perform against a fresh database — no Warrant, no human decision —
   * so the refusal, the credential scope and the never-stored pack are all
   * measured on rows that exist.
   */
  async function keyedMint(key: string, token?: string): Promise<Answer> {
    // The body is derived from the KEY, not from a fresh tag: an EXACT retry
    // must send the same bytes, and a label that differed per call would be a
    // different request (409 IDEMPOTENCY_KEY_REUSED), which is a different
    // assertion entirely.
    return call('POST', '/delegation/agent-mints', {
      key, token,
      body: {
        targetTaskId: MINT_TASK, requestedScopes: ['tasks:read'],
        via: 'approval', label: `retry contract ${key}`,
      },
    });
  }

  let MINT_TASK: string;
  beforeAll(async () => { MINT_TASK = await makeTask(`mint fixture ${tag()}`); });

  it('ruling 2 — a repeated key is REFUSED and never re-mints', async () => {
    const key = freshKey();
    const before = await countOf(
      'SELECT count(*)::int AS n FROM approvals WHERE requesting_credential_id = $1',
      [PRIMARY.credentialId])();
    const first = await keyedMint(key);
    expect(first.status).toBe(202);
    const second = await keyedMint(key);
    expect(second.status).toBe(409);
    expect(String(second.json.code)).toBe('IDEMPOTENCY_REPLAY_UNAVAILABLE');
    // The refusal carries the request id, so a caller can correlate the one
    // committed act — the only thing it is ever given about it.
    expect(second.headers['retry-request-id']).toBe(first.headers['retry-request-id']);
    // NOT "the response says so": the ACT is counted. Exactly one Approval.
    const after = await countOf(
      'SELECT count(*)::int AS n FROM approvals WHERE requesting_credential_id = $1',
      [PRIMARY.credentialId])();
    expect(after - before).toBe(1);
    // Ruling 3: the identity is (credential, operation, key), so the row is
    // credential-scoped — the prefix says which kind, by construction.
    const rows = await rowsFor('agent.mint.request', key);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].scope)).toBe(`cred:${PRIMARY.credentialId}`);
    expect(rows[0].replay_policy).toBe('refuse');
  });

  it('ruling 3 / B4 — a SECOND credential of the same principal gets its OWN row, never a replay', async () => {
    // This is B4's exact reproduction for a credential-bound operation: were
    // the scope resolved from the PRINCIPAL while the declaration said
    // `credential`, the second credential would land on the first's row. It
    // does not — it reaches the handler and commits its own act.
    const key = freshKey();
    expect((await keyedMint(key)).status).toBe(202);
    const second = await keyedMint(key, SECOND_CREDENTIAL.fullKey);
    expect(second.status).toBe(202);
    expect(second.headers['retry-replayed']).toBeUndefined();
    const rows = await pool.query(
      `SELECT scope FROM operation_idempotency_records
        WHERE operation = 'agent.mint.request' AND idempotency_key = $1 ORDER BY scope`, [key]);
    expect(rows.rows.map((row: any) => String(row.scope)).sort()).toEqual(
      [`cred:${PRIMARY.credentialId}`, `cred:${SECOND_CREDENTIAL.credentialId}`].sort());
  });

  it('every mint row stores NULL status, body and content-type', async () => {
    const rows = await pool.query(
      `SELECT response_status, response_body, response_content_type
         FROM operation_idempotency_records WHERE operation LIKE 'agent.mint%'`);
    // NOT VACUOUS: rows exist, written by the drills above. A loop over an
    // empty set would pass while proving nothing at all.
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) {
      expect([row.response_status, row.response_body, row.response_content_type]).toEqual([null, null, null]);
    }
    // A declaration a reviewer can check without trusting the loop above.
    expect(IDEMPOTENT_OPERATIONS['agent.mint.request'].replay).toBe('refuse');
    expect(IDEMPOTENT_OPERATIONS['agent.mint.collect'].replay).toBe('refuse');
    expect(IDEMPOTENT_OPERATIONS['agent.mint.request'].scope).toBe('credential');
    expect(IDEMPOTENT_OPERATIONS['agent.mint.collect'].scope).toBe('credential');
  });

  it('no credential material anywhere in the table — with a negative control that PROVES the scan can see one', async () => {
    const scan = async (): Promise<string[]> => {
      const rows = await pool.query('SELECT response_body FROM operation_idempotency_records WHERE response_body IS NOT NULL');
      return rows.rows
        .map((row: any) => String(row.response_body))
        .filter((body: string) => /rh_[a-z]+_/.test(body));
    };
    expect(await scan()).toEqual([]);
    // The negative control: a row deliberately carrying a fake secret in a
    // return-policy body makes the SAME assertion fail, so a clean scan means
    // "none there", not "the scan cannot see one".
    const key = freshKey();
    await pool.query(
      `INSERT INTO operation_idempotency_records
         (scope, operation, idempotency_key, request_hash, state, replay_policy,
          response_status, response_body, response_content_type, expires_at)
       VALUES ($1, 'task.create', $2, 'h', 'completed', 'return', 201,
               '{"secretOnce":"rh_dev_keyid01.notarealsecret"}', 'application/json', now() + interval '1 day')`,
      [`cred:${PRIMARY.credentialId}`, key]);
    expect(await scan()).toHaveLength(1);
    await pool.query('DELETE FROM operation_idempotency_records WHERE idempotency_key = $1', [key]);
    expect(await scan()).toEqual([]);
  });
});

// ═════════ r1-B2 — the contract FAILS CLOSED when its own write does not land ═════════

/**
 * REVIEW ROUND 1, FINDING B2. The first build sent the handler's nominal 2xx
 * when the completion UPDATE failed, with a header naming the failure. That
 * hands the caller a 201 over a contract that is not being kept: a retry with
 * the same token then either runs the handler AGAIN or is refused as IN_FLIGHT
 * for a minute, and the caller had no way to know.
 *
 * The failure is injected at the SAME kind of seam 4.1.12 uses — a trigger in
 * the test's own disposable database — so the production middleware is untouched
 * and what fails is the real write on the real path. The red-proof drill scored
 * this repair as a FALSE GREEN until this test existed, which is exactly what a
 * repair with no control is.
 */
describe('r1-B2 — fail closed, and clean up, when the retry record cannot be written', () => {
  async function breakCompletion(): Promise<void> {
    await pool.query(`
      CREATE OR REPLACE FUNCTION rh_break_completion() RETURNS trigger AS $fn$
      BEGIN
        RAISE EXCEPTION 'retry-contract drill: the completion write is refused';
      END;
      $fn$ LANGUAGE plpgsql;`);
    await pool.query('DROP TRIGGER IF EXISTS rh_break_completion ON operation_idempotency_records');
    await pool.query(`
      CREATE TRIGGER rh_break_completion BEFORE UPDATE ON operation_idempotency_records
        FOR EACH ROW WHEN (NEW.state = 'completed' AND OLD.state = 'in_flight')
        EXECUTE FUNCTION rh_break_completion()`);
  }

  async function healCompletion(): Promise<void> {
    await pool.query('DROP TRIGGER IF EXISTS rh_break_completion ON operation_idempotency_records');
    await pool.query('DROP FUNCTION IF EXISTS rh_break_completion()');
  }

  afterEach(async () => { await healCompletion(); });

  it('fails closed when the completion write does not land, instead of answering 2xx', async () => {
    const key = freshKey();
    const title = `failclosed ${tag()}`;
    await breakCompletion();
    const answer = await call('POST', '/tasks', { body: { title, project: PROJECT_ID }, key });

    // NOT a 201. The caller is told the contract could not be kept, and told
    // that the act itself may have landed — which it did.
    expect({ status: answer.status, code: String(answer.json?.code) })
      .toEqual({ status: 500, code: 'IDEMPOTENCY_RECORD_UNAVAILABLE' });
    expect(String(answer.json?.suggestion)).toContain('may have been applied');
    expect(String(answer.json?.details?.errorId ?? '')).not.toBe('');

    // The handler's own transaction COMMITTED — this middleware never rewrites a
    // committed result, and the message says so rather than pretending otherwise.
    expect(await countOf('SELECT count(*)::int AS n FROM tasks WHERE title = $1', [title])()).toBe(1);

    // …and the SECOND half of B2: the reservation does not survive. The close
    // handler asks whether the RECORD is resolved, not whether the wrapper ran,
    // so a request that ended without completing its record cleans up after
    // itself — and a retry is not stuck behind a 60-second IN_FLIGHT window.
    await until('the abandoned reservation to be released', async () => {
      const rows = await rowsFor('task.create', key);
      return rows.length === 0 ? true : null;
    }, 10_000);

    // The proof that it is really cleaned up rather than merely absent: with the
    // seam healed, the SAME token works immediately.
    await healCompletion();
    const retry = await call('POST', '/tasks', { body: { title, project: PROJECT_ID }, key });
    expect(retry.status).toBe(201);
    expect(await rowsFor('task.create', key)).toHaveLength(1);
  }, 60_000);

  it('fails closed when a refused attempt\'s reservation cannot be released either', async () => {
    // The non-2xx path has the same shape and the same obligation: if the
    // reservation cannot go, a later attempt with that token would be refused as
    // IN_FLIGHT for a call that already finished, so the caller is told.
    await pool.query(`
      CREATE OR REPLACE FUNCTION rh_break_release() RETURNS trigger AS $fn$
      BEGIN
        RAISE EXCEPTION 'retry-contract drill: the release is refused';
      END;
      $fn$ LANGUAGE plpgsql;`);
    await pool.query('DROP TRIGGER IF EXISTS rh_break_release ON operation_idempotency_records');
    await pool.query(`
      CREATE TRIGGER rh_break_release BEFORE DELETE ON operation_idempotency_records
        FOR EACH ROW EXECUTE FUNCTION rh_break_release()`);
    try {
      const key = freshKey();
      // A body the route REFUSES, so the middleware takes the non-2xx path.
      const answer = await call('POST', '/reports', { body: { content: 'no title' }, key });
      expect({ status: answer.status, code: String(answer.json?.code) })
        .toEqual({ status: 500, code: 'IDEMPOTENCY_RECORD_UNAVAILABLE' });
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS rh_break_release ON operation_idempotency_records');
      await pool.query('DROP FUNCTION IF EXISTS rh_break_release()');
    }
  }, 60_000);
});

// ═════════ 4.1.12 — the bytes do not leave before the completion row is written ═════════

/**
 * D5, repaired to B-3's instruction.
 *
 * The seam lives in the TEST's own disposable database — the handler is
 * untouched. A trigger on the completion UPDATE takes an advisory lock whose
 * key is derived from the ROW, so it blocks the completion of exactly the one
 * request under test: any other request completing concurrently hashes to a
 * different key, finds it unheld, and never waits. That is what makes the
 * wrong-witness construction round 4 built IMPOSSIBLE rather than unlikely.
 *
 * The two-argument advisory form is used so `pg_locks` can be matched EXACTLY
 * (`classid` = this seam's namespace, `objid` = the row-derived hash) rather
 * than by reassembling a signed 64-bit key from two unsigned halves. The key
 * is still `hashtext('rh-completion-gate:' || NEW.idempotency_key)`; the
 * namespace only puts it in its own lock space.
 *
 * THE CREDITED ASSERTION IS B-3's: a SYNCHRONOUS send-boundary count. Client
 * non-arrival is recorded beside it as auxiliary evidence and credited to
 * nothing, because `Promise.race` watches the client promise settle rather
 * than the moment `res.send` is invoked — a timeout is no verdict.
 */
const SEAM_CLASSID = 19700101;

async function installSeam(keyExpression = "hashtext('rh-completion-gate:' || NEW.idempotency_key)"): Promise<void> {
  await pool.query(`
    CREATE OR REPLACE FUNCTION rh_block_completion() RETURNS trigger AS $fn$
    BEGIN
      PERFORM pg_advisory_xact_lock(${SEAM_CLASSID}, ${keyExpression});
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;`);
  await pool.query('DROP TRIGGER IF EXISTS rh_block_completion ON operation_idempotency_records');
  await pool.query(`
    CREATE TRIGGER rh_block_completion BEFORE UPDATE ON operation_idempotency_records
      FOR EACH ROW WHEN (NEW.state = 'completed' AND OLD.state = 'in_flight')
      EXECUTE FUNCTION rh_block_completion()`);
}

async function dropSeam(): Promise<void> {
  await pool.query('DROP TRIGGER IF EXISTS rh_block_completion ON operation_idempotency_records');
  await pool.query('DROP FUNCTION IF EXISTS rh_block_completion()');
}

/**
 * `hashtext` returns a SIGNED int4 and is routinely negative, while `pg_locks`
 * reports `objid` as an OID — unsigned. The lock is taken with the signed
 * value; the catalogue is matched with its unsigned form. Both are derived from
 * the SAME expression the trigger uses, in the database, so the test cannot
 * disagree with the seam by recomputing the hash itself.
 */
async function lockKeyFor(key: string): Promise<{ signed: number; objid: number }> {
  const rows = await pool.query(
    `SELECT hashtext('rh-completion-gate:' || $1) AS signed,
            (hashtext('rh-completion-gate:' || $1)::bigint & 4294967295)::bigint AS objid`, [key]);
  return { signed: Number(rows.rows[0].signed), objid: Number(rows.rows[0].objid) };
}

async function waiters(objid: number): Promise<Array<{ pid: number; query: string }>> {
  const rows = await pool.query(
    `SELECT l.pid, coalesce(a.query, '') AS query
       FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.classid = $1 AND l.objid = $2 AND l.granted = false`,
    [SEAM_CLASSID, objid]);
  return rows.rows.map((row: any) => ({ pid: Number(row.pid), query: String(row.query) }));
}

async function until<T>(what: string, probe: () => Promise<T | null>, budgetMs = 20_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`4.1.12 timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('4.1.12 — the completion row is written BEFORE the bytes leave (D5 / B-3)', () => {
  afterEach(async () => { await dropSeam(); });

  it('healthy and mutated run CONSECUTIVELY on the SAME pool, and the send boundary tells them apart', async () => {
    await installSeam();

    // ── the HEALTHY arm: production ordering, completion blocked ──────────
    const K = freshKey();
    const { signed, objid } = await lockKeyFor(K);
    watchSendBoundary(K);
    const control = await pool.connect();
    let mutatedControl: any = null;
    try {
      const controlPid = Number((await control.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      await control.query('SELECT pg_advisory_lock($1, $2)', [SEAM_CLASSID, signed]);

      const inFlight = callDetached('POST', '/tasks', {
        body: { title: `gate ${tag()}`, project: PROJECT_ID }, key: K,
      });

      // step 3 — the request has reached the reservation.
      await until('the in_flight row for K', async () => {
        const rows = await rowsFor('task.create', K);
        return rows.length === 1 && rows[0].state === 'in_flight' ? rows[0] : null;
      });

      // step 4 — EXACTLY ONE waiter on THIS key, not the control's own pid,
      // whose current statement is the completion UPDATE. Identity is recorded
      // as (K, pid), not rested on key uniqueness: `hashtext` is collision-prone
      // and a crafted collision could recreate a different-key waiter.
      const waiting = await until('exactly one blocked completion UPDATE on K', async () => {
        const found = await waiters(objid);
        return found.length === 1 && found[0].pid !== controlPid ? found[0] : null;
      });
      expect(waiting.pid).not.toBe(controlPid);
      expect(waiting.query).toMatch(/UPDATE operation_idempotency_records/);
      expect(waiting.query).toMatch(/state = 'completed'/);

      // ── THE CREDITED ASSERTION (B-3) ──────────────────────────────────
      // Synchronous: the count moves the instant the original res.send is
      // invoked, so a blocked completion cannot have sent, however slow or fast
      // the machine or the socket is.
      expect(sendBoundaryCount(K)).toBe(0);

      // Auxiliary only, credited to nothing: the client has not been answered.
      const raced = await Promise.race([
        inFlight.then(() => 'ARRIVED'),
        new Promise((resolve) => setTimeout(() => resolve('PENDING'), 300)),
      ]);
      expect(raced).toBe('PENDING');

      // step 6 — release, and the request completes normally.
      await control.query('SELECT pg_advisory_unlock($1, $2)', [SEAM_CLASSID, signed]);
      const answer = await inFlight;
      expect(answer.status).toBe(201);
      expect(sendBoundaryCount(K)).toBe(1);
      const done = await rowsFor('task.create', K);
      expect(done[0].state).toBe('completed');

      // ── the MUTATED arm: the completion UPDATE moved AFTER the send ────
      // Red proof 22. Same pool, same seam, same probe, immediately after the
      // healthy arm — a control that only works on a fresh pool is not a
      // control. The mutation is the ORDERING under test and nothing else.
      const M = freshKey();
      const mutated = await lockKeyFor(M);
      watchSendBoundary(M);
      mutatedControl = await pool.connect();
      await mutatedControl.query('SELECT pg_advisory_lock($1, $2)', [SEAM_CLASSID, mutated.signed]);
      const scope = `cred:${PRIMARY.credentialId}`;
      await pool.query(
        `INSERT INTO operation_idempotency_records
           (scope, operation, idempotency_key, request_hash, state, replay_policy, expires_at)
         VALUES ($1, 'task.create', $2, 'h', 'in_flight', 'return', now() + interval '1 day')`,
        [scope, M]);
      // The mutation, written out: SEND FIRST, complete afterwards.
      const mutatedRequest = (async (): Promise<void> => {
        sendBoundaryCounts.set(M, (sendBoundaryCounts.get(M) as number) + 1);   // the send
        await pool.query(
          `UPDATE operation_idempotency_records
              SET state = 'completed', response_status = 201, response_body = '{}',
                  response_content_type = 'application/json'
            WHERE scope = $1 AND idempotency_key = $2`, [scope, M]);            // …then the UPDATE
      })();
      await until('the mutated completion UPDATE blocked on M', async () => {
        const found = await waiters(mutated.objid);
        return found.length === 1 ? found[0] : null;
      });
      // The SAME credited assertion now reads 1: the bytes left before the
      // completion row was written. Step 5 is an OBSERVATION, not a timeout.
      expect(sendBoundaryCount(M)).toBe(1);
      await mutatedControl.query('SELECT pg_advisory_unlock($1, $2)', [SEAM_CLASSID, mutated.signed]);
      await mutatedRequest;
    } finally {
      control.release();
      if (mutatedControl) mutatedControl.release();
    }

    // step 7 — teardown asserts the seam left NOTHING behind. `pg_advisory_lock`
    // is SESSION-scoped: a pooled connection acquiring one inside a trigger
    // would still hold it after the test, and the next control connection would
    // block on the leftover rather than on the handler — a control that poisons
    // its own pool. The trigger takes an `xact` lock, which ends with the
    // handler's statement transaction; this is the control on that.
    await dropSeam();
    const leftover = await pool.query(
      `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = $1`,
      [SEAM_CLASSID]);
    expect(leftover.rows[0].n).toBe(0);
  });

  it('red proof 25 — a CONSTANT seam key admits the wrong witness, and step 4 says so', async () => {
    // The mutation round 4 used to break this control without touching its
    // logic: with a constant key, ANOTHER keyed request reaching its own
    // healthy completion UPDATE becomes a waiter on the shared key, and step
    // 4's witness is a stranger. Deriving the key from the row makes that
    // impossible; this drill proves the difference is real rather than argued.
    await installSeam('42');
    const K = freshKey();
    const strangerKey = freshKey();
    const control = await pool.connect();
    try {
      await control.query('SELECT pg_advisory_lock($1, 42)', [SEAM_CLASSID]);
      const scope = `cred:${PRIMARY.credentialId}`;
      // A request with a COMPLETELY DIFFERENT key still blocks on the constant.
      await pool.query(
        `INSERT INTO operation_idempotency_records
           (scope, operation, idempotency_key, request_hash, state, replay_policy, expires_at)
         VALUES ($1, 'task.create', $2, 'h', 'in_flight', 'return', now() + interval '1 day')`,
        [scope, strangerKey]);
      const stranger = pool.query(
        `UPDATE operation_idempotency_records
            SET state = 'completed', response_status = 201, response_body = '{}',
                response_content_type = 'application/json'
          WHERE scope = $1 AND idempotency_key = $2`, [scope, strangerKey]);
      const blocked = await until('the stranger blocked on the constant key', async () => {
        const rows = await pool.query(
          `SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'advisory' AND classid = $1 AND objid = 42 AND granted = false`,
          [SEAM_CLASSID]);
        return rows.rows[0].n === 1 ? true : null;
      });
      expect(blocked).toBe(true);
      // …and the ROW-DERIVED key for K is unheld, so under the real seam this
      // stranger would never have been a waiter on K at all. That is the whole
      // repair, measured rather than asserted.
      const onK = await waiters((await lockKeyFor(K)).objid);
      expect(onK).toEqual([]);
      await control.query('SELECT pg_advisory_unlock($1, 42)', [SEAM_CLASSID]);
      await stranger;
    } finally {
      control.release();
    }
  });

  it('a same-key stale take-over past 60s keeps K-bound waiter identity (hardening)', async () => {
    // Non-blocking hardening named beside B-3: a long handler whose reservation
    // is taken over past the threshold must not move the seam's identity. The
    // key is derived from `idempotency_key`, which the take-over does not
    // change — so the lock a stale take-over lands on is the SAME lock.
    const K = freshKey();
    const before = (await lockKeyFor(K)).objid;
    const scope = `cred:${PRIMARY.credentialId}`;
    await pool.query(
      `INSERT INTO operation_idempotency_records
         (scope, operation, idempotency_key, request_hash, state, replay_policy, created_at, expires_at)
       VALUES ($1, 'task.create', $2, 'stale', 'in_flight', 'return',
               now() - ($3 || ' milliseconds')::interval - interval '5 seconds',
               now() + interval '1 day')`,
      [scope, K, String(IDEMPOTENCY_IN_FLIGHT_TAKEOVER_MS)]);
    const answer = await call('POST', '/tasks', { body: { title: `stale ${tag()}`, project: PROJECT_ID }, key: K });
    expect(answer.status).toBe(201);
    const after = (await lockKeyFor(K)).objid;
    expect(after).toBe(before);
    const rows = await rowsFor('task.create', K);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('completed');
  });
});

// ═════════ 4.2 — the documented-convergent set, convergence MEASURED ═════════

/**
 * The oracle. For each tool: build the precondition, snapshot EVERY ROW OF
 * EVERY TABLE, perform the call, snapshot again, perform the EXACT same call,
 * snapshot again, then assert
 *
 *   (a)  every column of every row equal between snapshots 2 and 3, except the
 *        columns this tool declares exempt BY NAME;
 *   (b)  every table's row count equal between 2 and 3, except the per-tool
 *        feed-event allowance;
 *   (c)  the second answer is one of the shapes the tool's §3.8 sentence
 *        promises;
 *   (d)  the sentence read from the LIVE registry equals the sentence this
 *        test was written against;
 *   (e1) the (tool, table, column) exemption set equals the table below,
 *        BY VALUE — widening an exemption reddens (e1), not (a), whose
 *        comparator consumes the exemption;
 *   (e2) the (tool, count) feed-event allowance set equals the table below,
 *        by value, for the same reason and with its own red proof.
 *
 * There is NO touched-table manifest in the comparison path. Round 4 broke a
 * manifest-limited comparison with a trigger-driven in-place write into a table
 * no import closure reaches, and the repair was not a fourth census: it was to
 * take the census out of the assertion path. (a) and (b) both read the
 * database, and they catch different things — (b) an unexpected insert or
 * delete anywhere, (a) an unexpected in-place change anywhere.
 */

interface ToolCase {
  tool: string;
  /** Builds the precondition and returns the call to make twice. */
  setup: () => Promise<{ method: string; path: string; body?: unknown; headers?: Record<string, string> }>;
  /** Exempt columns, `table.column`, each with its reason in the register below. */
  exempt: string[];
  /** Row-count allowance between snapshots 2 and 3, by table. */
  allowance: Record<string, number>;
  /** (c): what the tool's own §3.8 sentence promises the second answer is. */
  secondAnswer: (first: Answer, second: Answer) => void;
}

/**
 * THE EXEMPTION REGISTER — every entry a named column on a named table, never
 * a table-wide or tool-wide waiver.
 *
 * TWO MIRRORS, NOT ONE (B-2, verdict `f2de4eaf`). `trg_tasks_execution_profile_compat`
 * mirrors `tasks.updated_at` into `task_execution_profiles.updated_at`
 * (`086_task_element_substrate.sql:159-192`), and — the one v5 missed —
 * `trg_tasks_assignment_compat` (`086…:89-93`) fires on EVERY `tasks.updated_at`
 * write and always rewrites `task_assignments.updated_at` (`:62-85`). Any tool
 * exempting `tasks.updated_at` must therefore exempt BOTH mirrors, and ONLY
 * those columns: both triggers move their `revision` only when a real field
 * changes (`:174-182`, `:77-83`), which an exact retry does not, so both
 * `revision` columns stay under live comparison. A fourth tool that starts
 * rewriting `tasks.updated_at` without declaring the pair reddens (a).
 */
const TASK_CLOCK_EXEMPTIONS = [
  'tasks.updated_at',                       // server clock, TaskManagerDB.ts:2234-2235
  'task_execution_profiles.updated_at',     // trg_tasks_execution_profile_compat mirrors it
  'task_assignments.updated_at',            // trg_tasks_assignment_compat mirrors it too (B-2)
];

async function makeSubtaskTask(): Promise<{ taskId: string; subtaskId: string }> {
  const taskId = await makeTask();
  // Through the production PATCH, not by writing the table: `tasks.subtasks` is
  // not a column (the rows live in `subtasks`, keyed by index), and a fixture
  // that writes the substrate by hand can seed a state the routes never make.
  const added = await call('PATCH', `/tasks/${taskId}`, {
    body: { subtasks: [{ text: 'retry contract subtask', status: 'empty' }] },
  });
  expect(added.status).toBe(200);
  const subtasks = ((added.json.task ?? added.json).subtasks ?? []) as Array<{ id: string }>;
  expect(subtasks.length).toBe(1);
  return { taskId, subtaskId: String(subtasks[0].id) };
}

const TOOL_CASES: ToolCase[] = [
  {
    tool: 'relayhall_task_update',
    setup: async () => ({ method: 'PATCH', path: `/tasks/${await makeTask()}`, body: { priority: 'high' } }),
    exempt: TASK_CLOCK_EXEMPTIONS,
    allowance: { feed_events: 1 },
    secondAnswer: (first, second) => { expect(second.status).toBe(first.status); expect(second.status).toBe(200); },
  },
  {
    tool: 'relayhall_task_move',
    // `todo` is refused for this caller's role ("Agents cannot move tasks to
    // 'todo'"), which would make the row measure a refusal rather than the
    // convergence its sentence describes. `in-progress` is a move this identity
    // may make, and re-applying it is the exact retry under test.
    setup: async () => ({ method: 'PATCH', path: `/tasks/${await makeTask()}`, body: { status: 'in-progress' } }),
    exempt: TASK_CLOCK_EXEMPTIONS,
    allowance: { feed_events: 1 },
    secondAnswer: (first, second) => { expect(second.status).toBe(first.status); expect(second.status).toBe(200); },
  },
  {
    tool: 'relayhall_subtask_set',
    setup: async () => {
      const { taskId, subtaskId } = await makeSubtaskTask();
      return {
        method: 'PATCH',
        path: `/tasks/${taskId}/subtasks/by-id/${subtaskId}/status`,
        body: { status: 'in-progress' },
      };
    },
    exempt: [...TASK_CLOCK_EXEMPTIONS, 'subtasks.updated_at'],
    allowance: { feed_events: 1 },
    secondAnswer: (first, second) => {
      // "…re-applies the same state, OR is refused with that state already in
      // place" — a closed set of two named shapes, not "anything non-500".
      expect([200, 409]).toContain(second.status);
      expect(first.status).toBe(200);
    },
  },
  {
    tool: 'relayhall_task_claim',
    setup: async () => ({ method: 'POST', path: `/tasks/${await makeTask()}/claim`, body: {} }),
    exempt: TASK_CLOCK_EXEMPTIONS,
    allowance: { feed_events: 1 },
    secondAnswer: (first, second) => { expect(first.status).toBe(200); expect(second.status).toBe(200); },
  },
  {
    tool: 'relayhall_task_release',
    setup: async () => {
      const taskId = await makeTask();
      expect((await call('POST', `/tasks/${taskId}/claim`, { body: {} })).status).toBe(200);
      return { method: 'POST', path: `/tasks/${taskId}/release`, body: {} };
    },
    // NO exemptions, exactly as §4.2's table declares for this tool: the second
    // release changes nothing at all, so not even the server clock moves. An
    // exemption declared here would never fire, and an exemption nothing
    // exercises is a clamp waiting to be leaned on.
    exempt: [],
    allowance: {},
    secondAnswer: (first, second) => {
      // MEASURED, AND THE SENTENCE WAS CORRECTED TO MATCH (see the note beside
      // RETRY_CONTRACT_SENTENCES in the registry). §3.8 said "after a successful
      // release an exact retry is refused with the Task already released";
      // `POST /tasks/:id/release` on this substrate answers 200 with the Task
      // unchanged. The design record's own rule for exactly this case is that a
      // build which finds a further case must key it or CORRECT ITS SENTENCE
      // rather than widen an exemption — the retry is convergent, so the
      // sentence moved and the measurement below is what says so.
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
    },
  },
  {
    tool: 'relayhall_task_finish',
    // REVIEW ROUND 1 said this fixture was reachable and was RIGHT: this suite
    // already claims Tasks and `TaskElementService.finish` accepts an inline
    // report. The excuse was wrong, so the tool is measured instead of excused.
    setup: async () => {
      const taskId = await makeTask();
      expect((await call('POST', `/tasks/${taskId}/claim`, { body: {} })).status).toBe(200);
      expect((await call('PATCH', `/tasks/${taskId}`, { body: { status: 'in-progress' } })).status).toBe(200);
      return {
        method: 'POST',
        path: `/tasks/${taskId}/finish`,
        body: {
          handover: 'retry contract finish drill',
          report: { title: `finish ${tag()}`, content: 'retry contract', summary: 'drill' },
        },
      };
    },
    exempt: [],
    allowance: {},
    secondAnswer: (first, second) => {
      // "after a successful finish an exact retry is REFUSED (TASK_NOT_FINISHABLE)
      // with the Task already in Review" — asserted by NAME, not as "not 2xx".
      expect(first.status).toBe(200);
      expect(second.status).toBe(409);
      expect(String(second.json?.code ?? second.text)).toContain('TASK_NOT_FINISHABLE');
    },
  },
  {
    tool: 'relayhall_report_update',
    setup: async () => {
      const created = await call('POST', '/reports', {
        body: { title: `oracle ${tag()}`, content: 'x' }, key: freshKey(),
      });
      const reportId = String((created.json.report ?? created.json).id);
      return { method: 'PATCH', path: `/reports/${reportId}`, body: { content: 'converged' } };
    },
    exempt: ['reports.updated_at'],
    allowance: { feed_events: 1 },
    secondAnswer: (first, second) => { expect(first.status).toBe(200); expect(second.status).toBe(200); },
  },
];

/** (e1) and (e2): the pins, by value, so widening one reddens the PIN. */
const EXEMPTION_PINS: Array<[string, string]> = TOOL_CASES
  .flatMap((tool) => tool.exempt.map((column) => [tool.tool, column] as [string, string]))
  .sort();
const ALLOWANCE_PINS: Array<[string, string, number]> = TOOL_CASES
  .flatMap((tool) => Object.entries(tool.allowance).map(([table, count]) => [tool.tool, table, count] as [string, string, number]))
  .sort();

const EXPECTED_EXEMPTIONS: Array<[string, string]> = ([
  ['relayhall_report_update', 'reports.updated_at'],
  ['relayhall_subtask_set', 'subtasks.updated_at'],
  ['relayhall_subtask_set', 'task_assignments.updated_at'],
  ['relayhall_subtask_set', 'task_execution_profiles.updated_at'],
  ['relayhall_subtask_set', 'tasks.updated_at'],
  ['relayhall_task_claim', 'task_assignments.updated_at'],
  ['relayhall_task_claim', 'task_execution_profiles.updated_at'],
  ['relayhall_task_claim', 'tasks.updated_at'],
  ['relayhall_task_move', 'task_assignments.updated_at'],
  ['relayhall_task_move', 'task_execution_profiles.updated_at'],
  ['relayhall_task_move', 'tasks.updated_at'],
  ['relayhall_task_update', 'task_assignments.updated_at'],
  ['relayhall_task_update', 'task_execution_profiles.updated_at'],
  ['relayhall_task_update', 'tasks.updated_at'],
] as Array<[string, string]>).sort();

const EXPECTED_ALLOWANCES: Array<[string, string, number]> = ([
  ['relayhall_report_update', 'feed_events', 1],
  ['relayhall_subtask_set', 'feed_events', 1],
  ['relayhall_task_claim', 'feed_events', 1],
  ['relayhall_task_move', 'feed_events', 1],
  ['relayhall_task_update', 'feed_events', 1],
] as Array<[string, string, number]>).sort();

const exemptionsFired = new Map<string, number>();

async function runOracle(probe: ToolCase): Promise<void> {
  const request = await probe.setup();
  const exempt = new Set(probe.exempt);
  const make = (): Promise<Answer> => call(request.method, request.path, { body: request.body, headers: request.headers });

  const first = await make();
  const two = await snapshot();
  const second = await make();
  const three = await snapshot();

  probe.secondAnswer(first, second);

  const counts = countDifferences(two, three, probe.allowance);
  expect({ tool: probe.tool, counts }).toEqual({ tool: probe.tool, counts: [] });

  const columns = columnDifferences(two, three, exempt);
  expect({ tool: probe.tool, columns }).toEqual({ tool: probe.tool, columns: [] });

  // Exemption hygiene: an exemption nothing exercises is a clamp waiting to be
  // leaned on, so record whether each one actually FIRED — i.e. whether the
  // comparison would have differed without it.
  for (const column of probe.exempt) {
    const without = columnDifferences(two, three, new Set(probe.exempt.filter((name) => name !== column)));
    const key = `${probe.tool}|${column}`;
    exemptionsFired.set(key, (exemptionsFired.get(key) ?? 0) + (without.length > 0 ? 1 : 0));
  }
}

describe('4.2 — the documented-convergent set, MEASURED over the whole schema', () => {
  /**
   * (d) — the drift control on the PROSE, measured against an anchor OUTSIDE
   * the thing it checks.
   *
   * The first version of this compared the live tool description against
   * `RETRY_CONTRACT_SENTENCES` — the very map the description is built from, so
   * the two agreed by construction and the red-proof drill duly caught it going
   * green under a mutation that swapped one tool's sentence for another's. The
   * sentence each oracle row was WRITTEN AGAINST is therefore pinned here, by
   * value, in the test's own file: an edit to the registry now has to be
   * mirrored here by a human, which is exactly the review event (d) exists to
   * create.
   */
  const SENTENCES_THE_CASES_WERE_WRITTEN_AGAINST: Record<string, string> = {
    relayhall_task_update: 'Retry contract: an exact retry re-applies the same values and the Task ends in the same state; each call refreshes the Task\'s updated timestamp and emits one task.updated event.',
    relayhall_task_move: 'Retry contract: without feedback, an exact retry re-applies the same status and the Task ends in the same state (each call refreshes the updated timestamp and emits one task.updated event). With feedback the call requires an idempotencyKey, and an exact retry carrying the same key records the note once.',
    relayhall_subtask_set: 'Retry contract: an exact retry re-applies the same state, or is refused with that state already in place; each call refreshes the updated timestamps and emits one task.updated event.',
    relayhall_task_claim: 'Retry contract: an exact retry by the same identity is accepted and the Task ends in the same state; each call emits one task.updated event.',
    relayhall_task_release: 'Retry contract: an exact retry after a successful release leaves the Task released and unchanged, and answers with that same released Task.',
    relayhall_task_finish: 'Retry contract: after a successful finish an exact retry is refused (TASK_NOT_FINISHABLE) with the Task already in Review; read the Task for the Report it created.',
    relayhall_report_update: 'Retry contract: an exact retry re-applies the same values and the Report ends in the same state; each call refreshes the Report\'s updated timestamp and emits one report.updated event.',
  };

  it('(d) the sentence in the LIVE registry is the sentence these cases were written against', () => {
    for (const probe of TOOL_CASES) {
      const tool = toolByName(probe.tool);
      expect({ tool: probe.tool, found: Boolean(tool) }).toEqual({ tool: probe.tool, found: true });
      const owned = SENTENCES_THE_CASES_WERE_WRITTEN_AGAINST[probe.tool];
      expect({ tool: probe.tool, pinned: Boolean(owned) }).toEqual({ tool: probe.tool, pinned: true });
      // The LIVE description carries the sentence THIS FILE was written against.
      expect({ tool: probe.tool, carries: tool.description.includes(owned) })
        .toEqual({ tool: probe.tool, carries: true });
      // …and the registry's own map agrees with it, so a mutation to either
      // side is caught rather than being absorbed by the other.
      expect({ tool: probe.tool, sentence: (RETRY_CONTRACT_SENTENCES as Record<string, string>)[probe.tool] })
        .toEqual({ tool: probe.tool, sentence: owned });
      expect(owned.startsWith('Retry contract:')).toBe(true);
    }
    // Every measured tool is pinned, and nothing is pinned that is not measured.
    expect(Object.keys(SENTENCES_THE_CASES_WERE_WRITTEN_AGAINST).sort())
      .toEqual(TOOL_CASES.map((probe) => probe.tool).sort());
  });

  it('(e1) the column-exemption set is pinned BY VALUE — widening one reddens THIS, not (a)', () => {
    expect(EXEMPTION_PINS).toEqual(EXPECTED_EXEMPTIONS);
  });

  it('(e1b) the COMPARATOR honours the exemption set and nothing else', () => {
    // Review round 1 broke (e1) from the other side: the pin protects the
    // REGISTER, so a comparator that silently ignored, say, every column named
    // `updated_at` would leave the pin green while (a) stopped looking. The pin
    // cannot see that; only exercising the comparator can. These two snapshots
    // are built by hand so the property is measured on the function itself.
    const before: Snapshot = new Map([['t', [JSON.stringify({ id: 1, updated_at: 'a', other: 'x' })]]]);
    const after: Snapshot = new Map([['t', [JSON.stringify({ id: 1, updated_at: 'b', other: 'x' })]]]);
    // Exempt: the difference is consumed.
    expect(columnDifferences(before, after, new Set(['t.updated_at']))).toEqual([]);
    // NOT exempt: the SAME difference is seen. A comparator with a name-based
    // shortcut in it would report nothing here.
    expect(columnDifferences(before, after, new Set<string>()).map((d) => d.table)).toEqual(['t']);
    // …and an exemption for a DIFFERENT table does not travel.
    expect(columnDifferences(before, after, new Set(['u.updated_at'])).map((d) => d.table)).toEqual(['t']);
    // …and a non-exempt column beside an exempt one is still compared.
    const alsoOther: Snapshot = new Map([['t', [JSON.stringify({ id: 1, updated_at: 'b', other: 'y' })]]]);
    expect(columnDifferences(before, alsoOther, new Set(['t.updated_at'])).map((d) => d.table)).toEqual(['t']);
  });

  it('(e2) the feed-event allowance map is pinned BY VALUE, separately from (e1)', () => {
    expect(ALLOWANCE_PINS).toEqual(EXPECTED_ALLOWANCES);
  });

  it('B-2: every tool exempting tasks.updated_at exempts BOTH compat mirrors, and only their updated_at', async () => {
    // The two mirrors, read from the MIGRATION rather than from this file, so
    // the register cannot agree with itself.
    const migration = fs.readFileSync(
      path.join(__dirname, '..', 'migrations', '086_task_element_substrate.sql'), 'utf8');
    expect(migration).toMatch(/CREATE TRIGGER trg_tasks_execution_profile_compat/);
    expect(migration).toMatch(/CREATE TRIGGER trg_tasks_assignment_compat/);
    const byTool = new Map<string, Set<string>>();
    for (const [tool, column] of EXEMPTION_PINS) {
      if (!byTool.has(tool)) byTool.set(tool, new Set());
      (byTool.get(tool) as Set<string>).add(column);
    }
    const offenders: string[] = [];
    for (const [tool, columns] of byTool) {
      if (!columns.has('tasks.updated_at')) continue;
      if (!columns.has('task_execution_profiles.updated_at')) offenders.push(`${tool}: profile mirror not exempt`);
      if (!columns.has('task_assignments.updated_at')) offenders.push(`${tool}: assignment mirror not exempt`);
      // …and ONLY updated_at: both revisions stay under live comparison.
      for (const column of columns) {
        if (/^task_(assignments|execution_profiles)\.(?!updated_at$)/.test(column)) {
          offenders.push(`${tool}: ${column} is exempt, but only the mirrors' updated_at may be`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // The mirrors really do exist in THIS database, so the register is about a
    // live substrate rather than about a migration file.
    const triggers = await pool.query(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'tasks'::regclass AND NOT tgisinternal ORDER BY tgname`);
    const names = triggers.rows.map((row: any) => String(row.tgname));
    expect(names).toContain('trg_tasks_execution_profile_compat');
    expect(names).toContain('trg_tasks_assignment_compat');
  });

  for (const probe of TOOL_CASES) {
    it(`(a)+(b)+(c) ${probe.tool} converges over the WHOLE schema`, async () => {
      await runOracle(probe);
    }, 120_000);
  }

  it('B-2 red proof — a NON-EXEMPT assignment-mirror change is caught by (a)', async () => {
    // The mutation: `task_assignments.revision` is deliberately moved between
    // snapshots. It is adjacent to an exempt column on the SAME mirror table,
    // so nothing but a live column comparison distinguishes them — and the
    // register above says only `updated_at` may be exempt there.
    const taskId = await makeTask();
    await call('POST', `/tasks/${taskId}/claim`, { body: {} });
    const two = await snapshot();
    // `task_assignments.revision` is a UUID (086:15), not a counter.
    await pool.query(
      `UPDATE task_assignments SET revision = gen_random_uuid()
        WHERE task_id = $1`, [taskId]);
    const three = await snapshot();
    const columns = columnDifferences(two, three, new Set(TASK_CLOCK_EXEMPTIONS));
    expect(columns.map((difference) => difference.table)).toContain('task_assignments');
  });

  it('the oracle\'s own control: it FAILS on two operations known NOT to converge', async () => {
    // A control that cannot fail is furniture. An UNKEYED create must redden
    // the row-count assertion, and an UNKEYED note append must redden the
    // column assertion — different assertions, deliberately.
    const body = { title: `nonconvergent ${tag()}`, project: PROJECT_ID };
    await call('POST', '/tasks', { body });
    const two = await snapshot();
    await call('POST', '/tasks', { body });
    const three = await snapshot();
    const counts = countDifferences(two, three, {});
    expect(counts.map((difference) => difference.table)).toContain('tasks');

    const taskId = await makeTask();
    await call('POST', `/tasks/${taskId}/notes`, { body: { text: `n ${tag()}` } });
    const four = await snapshot();
    await call('POST', `/tasks/${taskId}/notes`, { body: { text: `n ${tag()}` } });
    const five = await snapshot();
    const columns = columnDifferences(four, five, new Set(TASK_CLOCK_EXEMPTIONS));
    expect(columns.map((difference) => difference.table)).toContain('tasks');
  });

  it('exemption hygiene — every declared exemption was OBSERVED to fire', () => {
    const idle = [...exemptionsFired.entries()].filter(([, fired]) => fired === 0).map(([key]) => key);
    // An exemption that never fires is removed before integration. Reported as
    // a value rather than merely asserted, so a reviewer sees which fired.
    expect({ idle }).toEqual({ idle: [] });
  });

  it('DECLARED COVERAGE — what this oracle does and does not reach, stated rather than implied', () => {
    // Never claim more than the evidence covers. The oracle above measures the
    // tools whose PRECONDITION this suite can construct from a Connector
    // credential against a freshly migrated database. Four of §3.8's tools are
    // NOT measured here, each for a reason that is about the fixture and not
    // about the contract, and each is named with the vehicle that reaches it:
    // REVIEW ROUND 1 read these reasons and found two of them FALSE, which is
    // the right thing to do to an excuse: `task_finish`'s fixture WAS reachable
    // (it is now measured above), and this list claimed `task_recover`'s
    // convergence was "drilled below" when nothing below called the route. Both
    // are repaired — and the remaining entries are DELEGATIONS, named as such,
    // not claims that a fixture is impossible.
    const NOT_MEASURED: Record<string, string> = {
      relayhall_task_recover:
        'NOT measured by this oracle. Its convergence IS drilled end to end in the B-1 block below — a real melted-down Task, a genuine recovery, then the SAME act retried with an UPPER-CASE Warrant, asserting outcome replayed and a schema-wide no-change. What the oracle does not do is run it through the generic two-call harness, because the second call is a REPLAY rather than a repeat of the first write.',
      relayhall_blueprint_instantiate:
        'DELEGATED: the fixture is a PUBLISHED Blueprint with a resolvable plan and a target Project, which this suite builds no part of; the same-key replay returning the original committed instantiation and the IDEMPOTENCY_KEY_REUSED refusal for a changed request are drilled live in blueprintLiveContract and through this tool in mcpBlueprintContract.',
      relayhall_blueprint_setup:
        'DELEGATED: the same published-Blueprint fixture plus an INVOCABLE Connector for the setup act; the confirmed-body replay returning the original assignment receipt, IDEMPOTENCY_KEY_REUSED for changed content and BLUEPRINT_SETUP_CHANGED for a stale plan are drilled live in blueprintSetupLive and blueprintWorkflowSetup, and through this tool in mcpBlueprintContract.',
      relayhall_review_run: 'DELEGATED: needs a Task in review and an INDEPENDENT Verifier identity — the substrate forbids the claimant reviewing its own Task, so this suite would have to mint a second principal chain purely to satisfy it. The attempt ledger contract is asserted by TaskReviewAttemptService\'s own suite.',
      relayhall_review_reject: 'DELEGATED: the same independent-Verifier precondition.',
      relayhall_agent_reveal: 'DELEGATED: needs a descendant lineage and, on the session path, a single-use step-up token; the reveal contract is asserted by the AZ-S3 reveal suites.',
      relayhall_agent_revoke: 'DELEGATED: needs a credential this caller has lineage authority over; the alreadyRevoked answer is asserted by the agent-lifecycle suite.',
      relayhall_lease_claim: 'DELEGATED: the orchestration surface carries its own configuration gate (card 590c638a) and its replay branch is asserted by c3ClaimLeaseLifecycle.',
      relayhall_lease_renew: 'DELEGATED: the same gate and suite.',
      relayhall_lease_release: 'DELEGATED: the same gate and suite.',
      relayhall_project_update: 'DELEGATED, and reachable here: revision-bound, its REVISION_MISMATCH refusal asserted by the project lifecycle parity suite.',
      relayhall_project_archive: 'DELEGATED, and reachable here: revision-bound, same suite.',
      relayhall_project_restore: 'DELEGATED, and reachable here: revision-bound, same suite.',
      relayhall_project_resource_update: 'DELEGATED, and reachable here: revision-bound, same suite.',
      relayhall_project_resource_archive: 'DELEGATED, and reachable here: revision-bound, same suite.',
      relayhall_project_resource_restore: 'DELEGATED, and reachable here: revision-bound, same suite.',
    };
    // Every unmeasured entry says WHICH it is. A reason that claims a fixture is
    // impossible when it is merely unbuilt is worse than an admitted gap, so no
    // entry here may claim impossibility: each is a delegation or a pointer.
    const dishonest = Object.entries(NOT_MEASURED)
      .filter(([, reason]) => !/^(DELEGATED|NOT measured)/.test(reason));
    expect(dishonest).toEqual([]);
    const measured = TOOL_CASES.map((probe) => probe.tool);
    const declared = Object.keys(RETRY_CONTRACT_SENTENCES as Record<string, string>);
    // Every tool carrying a §3.8 sentence is either MEASURED here or NAMED
    // above with its reason — silence about a tool is a failure.
    const unaccounted = declared.filter((name) => !measured.includes(name) && !(name in NOT_MEASURED));
    expect({ unaccounted }).toEqual({ unaccounted: [] });
    // …and nothing is listed in both places.
    expect(measured.filter((name) => name in NOT_MEASURED)).toEqual([]);
  });
});

// ═════════ B-1 — the Warrant identity, and the upper-case retry ═════════

/**
 * REVIEW ROUND 1, FINDING B3. The first build discharged B-1 by reading the
 * source and calling the helper: it never constructed recovery state, never
 * called the route twice, and never asserted the five preconditions. That is
 * not what `f2de4eaf` instructed and it is not a proof — the defect lived in a
 * COMPARISON between two live values, and only two live calls can show it gone.
 *
 * The fixture the route insists on is three subsystems deep and the substrate
 * refuses every shortcut, correctly: a Connector must be PUBLISHED and carry a
 * validated capability descriptor (`PROFILE_SERVICE_NOT_PUBLISHED`), and a
 * Warrant's ceiling must be an access-profile VERSION (`warrants_ceiling_present`).
 * It is built here through the production registry rather than by hand, so what
 * the recovery route validates is a Connector this board would accept.
 */
interface RecoveryFixture {
  taskId: string;
  /** Service B — the Connector the recovery moves the Task TO. */
  serviceId: string;
  /**
   * Service A — the Connector the melted-down Task was assigned to.
   *
   * REVIEW ROUND 2, FINDING B3: the first version of this helper DISCARDED it,
   * so the A→B receipt field could not be asserted from the fixture at all and
   * `previousAssigneeServiceId` went unchecked while the block claimed a
   * field-by-field receipt. A fixture that hides the value a claim is about
   * makes the claim unverifiable.
   */
  previousServiceId: string;
  warrantId: string;
  descriptorVersion: number;
}

async function publishedConnector(): Promise<{ serviceId: string; descriptorVersion: number }> {
  const slug = `retry-svc-${tag()}`;
  const service = await serviceRegistry.register(
    { slug, name: `retry contract ${slug}`, kind: 'connector' }, ACCOUNT);
  const published = await serviceRegistry.publishDescriptor(
    String(service.id), { options: [] }, String(service.revision), ACCOUNT);
  const live = await serviceRegistry.update(
    String(service.id), { status: 'published' }, String(published.service.revision), ACCOUNT);
  expect({ slug, status: String(live.status) }).toEqual({ slug, status: 'published' });

  // AZ-S7 R1: an assignment is refused unless the assignee chain is LIVE
  // (`ASSIGNEE_CHAIN_DEAD` — "delegated principal … holds no live credential").
  // Registration pairs a Connector principal with the Service; a Connector with
  // no credential is not something this board will assign work to, so the
  // fixture mints one rather than working around the refusal.
  const paired = await pool.query('SELECT principal_id FROM services WHERE id = $1', [service.id]);
  const connectorPrincipalId = String(paired.rows[0].principal_id);
  await principalService.issueCredential(
    { principalId: connectorPrincipalId, scopes: ['tasks:read', 'tasks:write'], transport: 'any' },
    SYSTEM_ACTOR);
  return {
    serviceId: String(service.id),
    descriptorVersion: Number(published.descriptorVersion.version),
  };
}

async function warrantOnAProfileVersion(anchorProjectId?: string): Promise<string> {
  const profile = await pool.query(
    `INSERT INTO access_profiles (name, description, created_by_principal_id)
     VALUES ($1, 'retry contract ceiling', $2) RETURNING id`,
    [`retry profile ${tag()}`, ACCOUNT]);
  const version = await pool.query(
    `INSERT INTO access_profile_versions (profile_id, version_number, created_by_principal_id)
     VALUES ($1, 1, $2) RETURNING id`, [profile.rows[0].id, ACCOUNT]);
  await pool.query('UPDATE access_profiles SET published_version_id = $2 WHERE id = $1',
    [profile.rows[0].id, version.rows[0].id]);
  const warrant = await pool.query(
    `INSERT INTO warrants (name, description, holder_principal_id, created_by_principal_id,
                           status, transport_pin, ceiling_profile_version_id, minted_total)
     VALUES ($1, 'retry contract warrant', $2, $2, 'active', 'any', $3, 0) RETURNING id`,
    [`retry warrant ${tag()}`, ACCOUNT, version.rows[0].id]);
  const warrantId = String(warrant.rows[0].id);
  // §6.3: a Warrant carries access only for what its ANCHOR UNION contains, and
  // the recovery route refuses otherwise (`WARRANT_DOES_NOT_CONTAIN_TASK`). The
  // fixture anchors on the PROJECT, which is the containment the drill's Task
  // actually has — anchoring on the Task id would make the containment check
  // trivially true and stop being the substrate's own rule.
  if (anchorProjectId) {
    await pool.query(
      `INSERT INTO warrant_anchors (warrant_id, anchor_type, anchor_id)
       VALUES ($1, 'project', $2)`, [warrantId, anchorProjectId]);
  }
  return warrantId;
}

/**
 * The MELTED-DOWN state the recovery verb exists for, pinned BY VALUE — this is
 * §4.2's fixture, and it is what makes the four divergent receipt fields
 * actually diverge: `in-progress`, a real claimant, ONE active lease, and an
 * assignment this call will move.
 */
async function meltedDownTask(serviceId: string, warrantId: string): Promise<RecoveryFixture> {
  const taskId = await makeTask(`recovery fixture ${tag()}`);
  // Connector A — where the melted-down work WAS. The recovery moves it to the
  // caller's `serviceId` (B), and A ≠ B is what makes the fourth receipt field
  // diverge; §4.2's pinned fixture says exactly that.
  const connector = await publishedConnector();
  expect(connector.serviceId).not.toBe(serviceId);
  // `execution_descriptor_version` moves WITH the service id: the compat mirror
  // upserts both into `task_execution_profiles`, whose own CHECK requires them
  // to be null together or set together (086:129-132). A fixture that sets one
  // is refused by the substrate, correctly.
  await pool.query(
    `UPDATE tasks
        SET status = 'in-progress', owner_principal_id = $2,
            execution_service_id = $3, execution_warrant_id = $4,
            execution_descriptor_version = $5
      WHERE id = $1`,
    [taskId, OTHER_PRINCIPAL.principalId, connector.serviceId, warrantId,
     connector.descriptorVersion]);
  // Read the assignment BACK, so what the drill calls "A" is what the database
  // holds rather than what this helper believes it wrote.
  const seeded = await pool.query('SELECT execution_service_id FROM tasks WHERE id = $1', [taskId]);
  expect(String(seeded.rows[0].execution_service_id)).toBe(connector.serviceId);
  await pool.query(
    `INSERT INTO task_execution_leases
       (task_id, resource_key, harness, status, claimed_task_updated_at, acquired_at, expires_at)
     SELECT $1, $2, 'hermes', 'active', t.updated_at, NOW(), NOW() + interval '1 hour'
       FROM tasks t WHERE t.id = $1`,
    [taskId, `retry-lease-${tag()}`]);
  return {
    taskId,
    serviceId,
    previousServiceId: connector.serviceId,
    warrantId,
    descriptorVersion: 1,
  };
}

describe('B-1 — an UPPER-CASE Warrant UUID retry recovers ONCE (verdict f2de4eaf)', () => {
  it('canonicalWarrantId resolves the authoritative row, never collapsing two warrants', async () => {
    const { canonicalWarrantId } = require('../services/TaskManagerDB');
    const warrantId = await warrantOnAProfileVersion();
    // NOT conditional on a row existing: the fixture creates one, so this can
    // never pass by skipping (review r1 B3 named the conditional skip).
    expect(await canonicalWarrantId(pool, warrantId.toUpperCase())).toBe(warrantId);
    expect(await canonicalWarrantId(pool, warrantId)).toBe(warrantId);
    // Canonicalisation folds CASE and nothing else — two different warrants stay
    // two, which is the failure mode a "normalisation" repair could have caused.
    const other = await warrantOnAProfileVersion();
    expect(other).not.toBe(warrantId);
    expect(await canonicalWarrantId(pool, other.toUpperCase())).toBe(other);
    // …and an id this database does not hold canonicalises to lower case rather
    // than to anything that could compare equal to a real one.
    const absent = '0F0F0F0F-1111-4111-8111-222222222222';
    expect(await canonicalWarrantId(pool, absent)).toBe(absent.toLowerCase());
  });

  it('THE OBLIGATION: an exact retry whose Warrant is UPPER-CASE answers replayed and writes NOTHING', async () => {
    const connector = await publishedConnector();
    const warrantId = await warrantOnAProfileVersion(PROJECT_ID);
    const fixture = await meltedDownTask(connector.serviceId, warrantId);

    const body = {
      executionServiceId: connector.serviceId,
      executionWarrantId: warrantId,
      executionProfile: { serviceId: connector.serviceId, options: {} },
      executionDescriptorVersion: connector.descriptorVersion,
      reason: 'retry contract B-1 drill',
    };

    // ── CALL 1: a genuine recovery ──────────────────────────────────────
    const first = await call('POST', `/tasks/${fixture.taskId}/recover`, { body });
    if (first.status !== 200) throw new Error(`recovery call 1 refused: ${first.status} ${first.text}`);
    expect({ status: first.status, outcome: first.json?.recovery?.outcome })
      .toEqual({ status: 200, outcome: 'recovered' });

    // ── THE FIVE CONJUNCTS, asserted IMMEDIATELY BEFORE CALL 2 ──────────
    // `f2de4eaf` asks for exactly this: the guard is a conjunction of five, and
    // a retry that reaches the replay branch must satisfy all five. Reading them
    // from the database right before the second call is what says the second
    // call's outcome is the GUARD's doing and not the fixture's.
    const rows = await pool.query(
      `SELECT t.status, t.owner_principal_id, t.execution_service_id, t.execution_warrant_id,
              (SELECT count(*)::int FROM task_execution_leases l
                WHERE l.task_id = t.id AND l.status = 'active') AS active_leases
         FROM tasks t WHERE t.id = $1`, [fixture.taskId]);
    const state = rows.rows[0];
    expect({
      conjunct1_status: String(state.status),
      conjunct2_claimant: state.owner_principal_id,
      conjunct3_activeLeases: Number(state.active_leases),
      conjunct4_assignee: String(state.execution_service_id),
      conjunct5_warrant: String(state.execution_warrant_id),
    }).toEqual({
      conjunct1_status: 'todo',
      conjunct2_claimant: null,
      conjunct3_activeLeases: 0,
      conjunct4_assignee: connector.serviceId,
      // The database holds the CANONICAL, lower-case text. This is the value
      // the retry's upper-case spelling has to compare equal to.
      conjunct5_warrant: warrantId,
    });
    expect(warrantId).toBe(warrantId.toLowerCase());

    const before = {
      stream: await countOf('SELECT count(*)::int AS n FROM task_stream_entries WHERE task_id = $1', [fixture.taskId])(),
      audit: await countOf("SELECT count(*)::int AS n FROM audit_events WHERE resource_id = $1 AND action LIKE 'task.lifecycle_override%'", [fixture.taskId])(),
      feed: await countOf('SELECT count(*)::int AS n FROM feed_events WHERE object_id = $1', [fixture.taskId])(),
    };
    const two = await snapshot();

    // ── CALL 2: THE SAME ACT, with the Warrant spelled in UPPER CASE ────
    // Before B-1 this falsified conjunct five — the database's lower-case text
    // against the caller's upper-case string — missed the replay branch, and
    // RECOVERED A SECOND TIME.
    const upper = { ...body, executionWarrantId: warrantId.toUpperCase() };
    expect(upper.executionWarrantId).not.toBe(body.executionWarrantId);
    const second = await call('POST', `/tasks/${fixture.taskId}/recover`, { body: upper });

    expect({ status: second.status, outcome: second.json?.recovery?.outcome })
      .toEqual({ status: 200, outcome: 'replayed' });

    // NOTHING was written: not a stream entry, not an audit row, not an event.
    const after = {
      stream: await countOf('SELECT count(*)::int AS n FROM task_stream_entries WHERE task_id = $1', [fixture.taskId])(),
      audit: await countOf("SELECT count(*)::int AS n FROM audit_events WHERE resource_id = $1 AND action LIKE 'task.lifecycle_override%'", [fixture.taskId])(),
      feed: await countOf('SELECT count(*)::int AS n FROM feed_events WHERE object_id = $1', [fixture.taskId])(),
    };
    expect(after).toEqual(before);

    // …and nothing anywhere in the schema, by the same oracle §4.2 uses.
    const three = await snapshot();
    expect(countDifferences(two, three, {})).toEqual([]);
    expect(columnDifferences(two, three, new Set<string>())).toEqual([]);

    // ── THE RECEIPT, field by field, never as an equality (D1) ──────────
    // The replay receipt is NOT the recovery receipt, and §3.8's sentence says
    // so. On THIS fixture — in-progress, a real claimant, one lease, A → B —
    // each of the four diverges, and each divergence is the negation of one
    // precondition in the record's §3.12 table.
    const a = first.json.recovery;
    const c = second.json.recovery;
    expect({ status: c.status, assignee: c.assigneeServiceId, seed: c.seedReportId ?? null })
      .toEqual({ status: a.status, assignee: a.assigneeServiceId, seed: a.seedReportId ?? null });
    expect(c.outcome).not.toBe(a.outcome);
    expect(c.previousClaimantPrincipalId).toBeNull();
    expect(a.previousClaimantPrincipalId).toBe(OTHER_PRINCIPAL.principalId);
    expect(c.releasedLeaseIds).toEqual([]);
    expect(a.releasedLeaseIds.length).toBe(1);
    expect(c.previousStatus).toBe('todo');
    expect(a.previousStatus).toBe('in-progress');
    // previousAssigneeServiceId — the FOURTH divergent field, and the one review
    // round 2 found unasserted. §3.12: the genuine receipt names the assignee
    // BEFORE the reassignment (A); the replay names the assignee the first call
    // INSTALLED (B), because that call changed nothing. They differ exactly
    // because this fixture is an A→B move, which is why the fixture is pinned by
    // value rather than described.
    expect(a.previousAssigneeServiceId).toBe(fixture.previousServiceId);
    expect(c.previousAssigneeServiceId).toBe(connector.serviceId);
    expect(c.previousAssigneeServiceId).not.toBe(a.previousAssigneeServiceId);
    // All EIGHT fields of the receipt are now accounted for: three equal, one
    // never equal, four divergent on this fixture's pinned preconditions.
    expect(Object.keys(a).sort()).toEqual([
      'assigneeServiceId', 'outcome', 'previousAssigneeServiceId',
      'previousClaimantPrincipalId', 'previousStatus', 'releasedLeaseIds',
      'seedReportId', 'status',
    ]);
  }, 120_000);

  it('the source pins that carry the repair, beside the behaviour that proves it', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'TaskManagerDB.ts'), 'utf8');
    expect(source).toMatch(/const nextWarrant = input\.executionWarrantId\s*\n\s*\?\s*await canonicalWarrantId\(/);
    const guard = /const alreadyRecovered = previousStatus === 'todo'[\s\S]{0,400}?previousWarrant === nextWarrant;/.exec(source);
    expect(guard).not.toBeNull();
    expect((guard as RegExpExecArray)[0].split('&&').length).toBe(5);
    // The route still ACCEPTS an upper-case spelling: the repair is in the
    // COMPARISON and must not change the wire contract.
    const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tasks.ts'), 'utf8');
    expect(route).toMatch(/WARRANT_UUID[^\n]*\/i/);
    // …and the stale comment that promised a receipt the code never returned is
    // gone (ANNEX A §7A build obligation).
    expect(source).not.toContain('answers with the same receipt');
    expect(source).toContain('It does NOT answer with the same receipt');
  });
});

// ═════════ 4.3 — the MCP surface and the closed-set census ═════════

describe('4.3 — the closed set, in BOTH directions, and the enforcement that is not the schema', () => {
  const ROUTE_FILES = ['routes/tasks.ts', 'routes/reports.ts', 'routes/projects.ts', 'routes/delegation.ts'];

  const mountedOperations = (): string[] => {
    const found: string[] = [];
    for (const relative of ROUTE_FILES) {
      const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
      const pattern = /idempotent\('([a-z.]+)'\)/g;
      let match = pattern.exec(source);
      while (match !== null) { found.push(match[1]); match = pattern.exec(source); }
    }
    return found;
  };

  it('every declared operation is mounted EXACTLY once, and every mount names a declared operation', () => {
    const mounted = mountedOperations();
    expect(mounted.length).toBe(new Set(mounted).size);          // exactly once each
    expect([...mounted].sort()).toEqual(Object.keys(IDEMPOTENT_OPERATIONS).sort());
    // Not vacuous: the scan really found the mounts.
    expect(mounted.length).toBe(10);
  });

  it('the scope-declaration census: no principal-scoped operation lives in a file that reads req.credentialId', () => {
    // The static half of 4.1.4's measured half. A wrongly credential-scoped
    // operation merely creates two records after a rotation; a wrongly
    // principal-scoped one could serve a replay to a second credential, so the
    // direction of this check is the direction that matters.
    const credentialBoundFiles = ROUTE_FILES.filter((relative) =>
      /req\.credentialId/.test(fs.readFileSync(path.join(__dirname, '..', relative), 'utf8')));
    expect(credentialBoundFiles).toEqual(['routes/delegation.ts']);
    const violations: string[] = [];
    for (const relative of credentialBoundFiles) {
      const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
      const pattern = /idempotent\('([a-z.]+)'\)/g;
      let match = pattern.exec(source);
      while (match !== null) {
        const declaration = (IDEMPOTENT_OPERATIONS as Record<string, any>)[match[1]];
        if (declaration.scope !== 'credential') violations.push(`${match[1]} is principal-scoped in ${relative}`);
        match = pattern.exec(source);
      }
    }
    expect(violations).toEqual([]);
    // Red proof 4's target, proven able to fire: were `agent.mint.collect`
    // declared principal-scoped, this census is what would catch it.
    expect((IDEMPOTENT_OPERATIONS as Record<string, any>)['agent.mint.collect'].scope).toBe('credential');
  });

  it('the requirement is enforced in the HANDLER, not by the schema (census C-1)', async () => {
    const REQUIRED = [
      'relayhall_task_create', 'relayhall_task_stream_append', 'relayhall_task_reference_create',
      'relayhall_report_create', 'relayhall_project_create', 'relayhall_project_resource_create',
      'relayhall_agent_mint', 'relayhall_project_resource_replace',
    ];
    expect(REQUIRED).toHaveLength(8);
    for (const name of REQUIRED) {
      const tool = toolByName(name);
      expect({ name, found: Boolean(tool) }).toEqual({ name, found: true });
      // The LIVE refusal — this is the assertion red proof 11 targets, and it
      // is deliberately NOT the schema census below: a schema-only assertion is
      // exactly the false claim C-1 found in v1.
      //
      // Every OTHER required argument is supplied, so the refusal that comes
      // back is the retry token's and nothing else: a handler that read `task`
      // first would otherwise pass this test while enforcing nothing about the
      // token. Each keyed handler reads `idempotencyKey` FIRST for that reason.
      const otherArgs: Record<string, unknown> = {
        task: '11111111-1111-4111-8111-111111111111',
        title: 'x', content: 'x', name: 'x', label: 'x', kind: 'reference',
        projectId: '22222222-2222-4222-8222-222222222222',
        resourceId: '33333333-3333-4333-8333-333333333333',
        revision: '44444444-4444-4444-8444-222222222222',
        action: 'request', details: {},
      };
      await expect(tool.handler(otherArgs, { authorization: 'Bearer x', toolName: name }))
        .rejects.toThrow(/idempotencyKey/);
    }
    // The schema says so too, for clients that read schemas — asserted
    // separately so a mutation to one cannot be masked by the other.
    for (const name of REQUIRED) {
      const tool = toolByName(name);
      const schema = tool.inputSchema as any;
      const required: string[] = schema.required ?? (schema.oneOf ?? []).flatMap((v: any) => v.required ?? []);
      expect({ name, requires: required.includes('idempotencyKey') })
        .toEqual({ name, requires: true });
    }
  });

  it('relayhall_task_move requires the token WITH feedback and not without it (ruling 1, both clauses)', async () => {
    const move = toolByName('relayhall_task_move');
    const schema = move.inputSchema as any;
    expect(schema.dependentRequired).toEqual({ feedback: ['idempotencyKey'] });
    await expect(move.handler(
      { task: '11111111-1111-4111-8111-111111111111', status: 'todo', feedback: 'please fix' },
      { authorization: 'Bearer x', toolName: 'relayhall_task_move' },
    )).rejects.toThrow(/idempotencyKey/);
    // …and WITHOUT feedback no token is needed. Asserted as a POSITIVE, on the
    // real board: the tool reaches the route and the route answers.
    const taskId = await makeTask();
    const answer = await call('PATCH', `/tasks/${taskId}`, { body: { status: 'in-progress' } });
    expect(answer.status).toBe(200);
  });

  it('an exact tools/call retry over /mcp produces ONE record (the seam the card was filed on)', async () => {
    // Through the REAL MCP door, not through the tool handler in isolation: a
    // direct handler call proves what the handler does with its arguments and
    // nothing about what it SENDS.
    const key = freshKey();
    const title = `mcp ${tag()}`;
    const first = await toolCall('relayhall_task_create',
      { idempotencyKey: key, title, status: 'todo', project: PROJECT_ID });
    const second = await toolCall('relayhall_task_create',
      { idempotencyKey: key, title, status: 'todo', project: PROJECT_ID });
    expect({ first: first.isError, second: second.isError }).toEqual({ first: false, second: false });
    expect(second.content).toBe(first.content);
    expect(await rowsFor('task.create', key)).toHaveLength(1);
    expect(await countOf('SELECT count(*)::int AS n FROM tasks WHERE title = $1', [title])()).toBe(1);

    const reportKey = freshKey();
    const reportTitle = `mcp report ${tag()}`;
    await toolCall('relayhall_report_create', { idempotencyKey: reportKey, title: reportTitle, content: 'x' });
    await toolCall('relayhall_report_create', { idempotencyKey: reportKey, title: reportTitle, content: 'x' });
    expect(await countOf('SELECT count(*)::int AS n FROM reports WHERE title = $1', [reportTitle])()).toBe(1);

    // …and the requirement is enforced ON THE RUNNING SURFACE (C-1): a call
    // with the argument omitted is a TOOL error naming it, not a protocol error.
    const missing = await toolCall('relayhall_task_create', { title: `no token ${tag()}`, project: PROJECT_ID });
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain('idempotencyKey');
  });

  it('relayhall_task_move FORWARDS the key to BOTH limbs — the note is recorded ONCE (§3.11)', async () => {
    // THE RED-PROOF DRILL WROTE THIS TEST. Row 14 removes the header from the
    // notes limb of `relayhall_task_move`'s handler; against a suite that drove
    // the two REST routes by hand it stayed GREEN, because the thing the row
    // mutates — what the TOOL sends — was never executed. Driving the tool over
    // /mcp is what makes the row a proof instead of a description.
    const taskId = await makeTask();
    const key = freshKey();
    const feedback = `mcp feedback ${tag()}`;
    const first = await toolCall('relayhall_task_move',
      { idempotencyKey: key, task: taskId, status: 'in-progress', feedback });
    const second = await toolCall('relayhall_task_move',
      { idempotencyKey: key, task: taskId, status: 'in-progress', feedback });
    expect({ first: first.isError, second: second.isError }).toEqual({ first: false, second: false });
    const rows = await pool.query('SELECT notes FROM tasks WHERE id = $1', [taskId]);
    expect(String(rows.rows[0].notes ?? '').split(feedback).length - 1).toBe(1);
    // One row per OPERATION under the one key value — they never collide, and
    // BOTH are present, which is what says the key reached both limbs.
    const records = await pool.query(
      'SELECT operation FROM operation_idempotency_records WHERE idempotency_key = $1 ORDER BY operation', [key]);
    expect(records.rows.map((row: any) => String(row.operation)))
      .toEqual(['task.note.append', 'task.patch']);
    // Ruling 1's second clause, on the running surface: no feedback, no token.
    const noFeedback = await toolCall('relayhall_task_move',
      { idempotencyKey: freshKey(), task: taskId, status: 'stuck' });
    expect(noFeedback.isError).toBe(false);
    const refused = await toolCall('relayhall_task_move',
      { task: taskId, status: 'in-progress', feedback: `unkeyed ${tag()}` });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain('idempotencyKey');
  });

  it('EVERY required tool actually FORWARDS the token — measured at the transport boundary', async () => {
    // REVIEW ROUND 1 broke the earlier version of this: forwarding was exercised
    // for three tools, so the other five could stop sending the header while
    // every credited assertion stayed green. `req(args, 'idempotencyKey')` proves
    // the handler READ the argument; only a record appearing under that key
    // proves it SENT it.
    //
    // The evidence is the record itself: a row for the operation the tool
    // composes, carrying the key the tool was given. No row, no forwarding.
    const project = String((await call('POST', '/projects', {
      body: { name: `forward-${tag()}` }, key: freshKey(),
    })).json.project.id);
    const taskId = await makeTask();

    const cases: Array<{ tool: string; args: Record<string, unknown>; operation: string }> = [
      { tool: 'relayhall_task_create', operation: 'task.create',
        args: { title: `fwd ${tag()}`, status: 'todo', project } },
      { tool: 'relayhall_task_stream_append', operation: 'task.stream.append',
        args: { task: taskId, content: `fwd ${tag()}` } },
      { tool: 'relayhall_task_reference_create', operation: 'task.reference.create',
        args: { task: taskId, kind: 'reference', label: `fwd ${tag()}`, targetUri: 'https://example.invalid/f' } },
      { tool: 'relayhall_report_create', operation: 'report.create',
        args: { title: `fwd ${tag()}`, content: 'forwarding drill' } },
      { tool: 'relayhall_project_create', operation: 'project.create',
        args: { name: `fwd-${tag()}` } },
      { tool: 'relayhall_project_resource_create', operation: 'project.resource.create',
        args: { projectId: project, kind: 'reference', name: `fwd-${tag()}`,
                details: { url: 'https://example.invalid/r', category: 'documentation' } } },
      { tool: 'relayhall_agent_mint', operation: 'agent.mint.request',
        args: { action: 'request', task: taskId, requestedScopes: ['tasks:read'], via: 'approval' } },
    ];

    const missing: string[] = [];
    for (const probe of cases) {
      const key = freshKey();
      const answer = await toolCall(probe.tool, { idempotencyKey: key, ...probe.args });
      const rows = await rowsFor(probe.operation, key);
      if (answer.isError || rows.length !== 1) {
        missing.push(`${probe.tool} -> ${probe.operation}: rows=${rows.length} error=${answer.isError} ${answer.content.slice(0, 120)}`);
      }
    }
    expect(missing).toEqual([]);

    // `relayhall_project_resource_replace` is the EIGHTH required tool and was
    // keyed before this candidate (067's own contract, its own table), so its
    // forwarding is asserted where that contract lives; naming it here keeps the
    // set of eight honest rather than silently seven.
    const replace = toolByName('relayhall_project_resource_replace');
    expect(String((replace.inputSchema as any).oneOf[0].required)).toContain('idempotencyKey');
    expect(fs.readFileSync(path.join(__dirname, '..', 'mcp', 'registry.ts'), 'utf8'))
      .toContain("'If-Match': revision, 'Idempotency-Key': idempotencyKey");
  }, 120_000);

  it('stableJson: a REORDERED request is the SAME act, and a changed one is not', async () => {
    // Review round 1: nothing in this suite ever sent a reordered body, so
    // removing the key sort from `stableJson` would have left every assertion
    // green while two semantically identical requests hashed differently — the
    // exact property §3.4 promises ("reordered keys are one request").
    const key = freshKey();
    const title = `reorder ${tag()}`;
    const first = await call('POST', '/reports', {
      body: { title, content: 'x', summary: 'y' }, key,
    });
    expect(first.status).toBe(201);
    // The SAME fields, a different insertion order — one act.
    const reordered = await call('POST', '/reports', {
      body: { summary: 'y', content: 'x', title }, key,
    });
    expect(reordered.headers['retry-replayed']).toBe('true');
    expect(reordered.text).toBe(first.text);
    expect(await countOf('SELECT count(*)::int AS n FROM reports WHERE title = $1', [title])()).toBe(1);
    // …and the control that says the hash is not simply ignoring the body: a
    // CHANGED value under the same key is still refused.
    const changed = await call('POST', '/reports', {
      body: { summary: 'CHANGED', content: 'x', title }, key,
    });
    expect(String(changed.json.code)).toBe('IDEMPOTENCY_KEY_REUSED');
    // …and the property directly on the function, in both directions.
    expect(stableJson({ a: 1, b: 2 })).toBe(stableJson({ b: 2, a: 1 }));
    expect(stableJson({ a: 1, b: 2 })).not.toBe(stableJson({ a: 1, b: 3 }));
    expect(stableJson({ a: { x: 1, y: 2 } })).toBe(stableJson({ a: { y: 2, x: 1 } }));
  }, 120_000);

  it('the declared durable-state writer census is sink-anchored and finds this middleware', async () => {
    expect(writersOf('operation_idempotency_records')).toEqual(['middleware/idempotency.ts']);
    // …and it reads SQL's own spelling rules, not one of them. Review round 1
    // broke the first scanner with a double-quoted identifier; these are the
    // forms a writer can legally use, checked against the scanner's regex.
    const { BACKEND_SRC } = require('./support/moduleClosure');
    expect(BACKEND_SRC).toContain('backend');
    const scanner = fs.readFileSync(
      path.join(__dirname, 'support', 'moduleClosure.ts'), 'utf8');
    expect(scanner).toContain('A DOUBLE-QUOTED identifier is the same table to PostgreSQL');
    // The derived manifest survives as DOCUMENTATION: it is shown, and nothing
    // in the comparison path depends on it being complete. `task_execution_profiles`
    // is exactly the table it does NOT reach, which is why (a) is schema-wide.
    const derived = derivedTableManifest('routes/tasks.ts', await schemaTables());
    expect(derived.length).toBeGreaterThan(30);
    expect(derived).toContain('tasks');
    expect(derived).not.toContain('task_execution_profiles');
  });
});
