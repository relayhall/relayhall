/**
 * Card 785e1eed P1-C: the Agent mint ceiling (T2) IS the live predicate.
 *
 * Census 82804ddf gap 3 (verifier finding P1-3, card stream 114025b7).
 * `AgentMintService.assertObjectAuthorityCovers` judged a requested object rule
 * against the Account's grant and profile ROWS, matching verbs exactly. The
 * predicate that decides every live act is wider in three ways: `grantAllows`
 * maps `write` to read/write/claim/finish/release, the account-owner arm counts
 * `COALESCE(t.account_owner_principal_id, p.owner_principal_id)`, and exact
 * Project Grants reach their Tasks. So an Account that owned the Task's
 * Project, or held only a `write` grant, or a Project grant, was refused
 * MINT_EXCEEDS_REQUESTER for `{task, exact, [X], [read, write]}`: authority it
 * exercises every day. And the check never ran when a request was FILED, so a
 * request no approver could approve sat pending until one pressed approve
 * (DEV mint 8e8b2a3b).
 *
 * This suite runs over a REAL PostgreSQL and the PRODUCTION router, with the
 * MCP ingress mounted the way `server.ts` mounts it:
 *
 *   1. an Account that OWNS the Task's Project, holding no grant row at all,
 *      mints `{task exact X [read, write]}` through request, step-up approval
 *      and collect, and the Agent then reads and writes X;
 *   2. an Account holding ONLY a `write` grant on X mints `[read, write]`. The
 *      live predicate implies read from write (the Account's own read of X
 *      proves it), and the ceiling agrees;
 *   3. an Account holding a Project-level grant mints a Task-exact rule;
 *   4. an Account with no authority on X is refused when it FILES, over REST
 *      and over MCP `relayhall_agent_mint`, with 403 MINT_EXCEEDS_REQUESTER
 *      naming the rule, no Approval row and an audited denial. When authority
 *      is withdrawn after filing, DECIDE refuses with the same words. The scope
 *      half of T2 refuses at filing too;
 *   5. PARITY: across a matrix of authority sources × requested rules, the
 *      filing verdict equals what an Agent holding that rule can actually do
 *      through the router. Both are also pinned to a written expectation, so
 *      neither side can be edited to agree with a broken other;
 *   6. the ALGEBRA ARM: a rule the predicate cannot decide object by object
 *      (all-of-type, all-except, all-in-project) is never admitted wider
 *      than the requester's authority. Ten cells, each with a written
 *      verdict; every admitted one is exercised live, and every refused one
 *      whose rule covers a readable Task names a Task the rule's Agent cannot
 *      read.
 *
 * THE LIVE ORACLE (5). For every cell an Agent carrying exactly the requested
 * rule is written by the production mint writer, `agentMintService.executeMint`
 * (the INSERTs collect performs), under the cell's own Connector, with no
 * ceiling in front of it. It is the Agent the mint would produce. Its reads go
 * to `GET /tasks/:id` while it is bound to an unrelated anchor Task, because
 * an Agent always reads its OWN bound Task (§8.2) and that arm is the Agent's
 * identity, not the requester's authority. Its writes go to `PATCH
 * /tasks/:id` while it is bound to X, because an Agent never writes past its
 * bound Task (T36). A ceiling WIDER than that live authority admits a cell
 * the oracle refuses, and the parity assertion goes red; the mutation drills
 * recorded with the card prove it.
 *
 * RED PROOF: against main's `AgentMintService.ts` and `ApprovalService.ts`, (1),
 * (2) and (3) fail at DECIDE (403 MINT_EXCEEDS_REQUESTER), and (4) and the
 * matrix's refusal cells and (6)'s refusal cells fail at FILING (202, the
 * request is accepted).
 *
 * DESTRUCTIVE: writes principals, credentials, groups, grants, access
 * profiles, projects, tasks, approvals, bootstrap records and audit rows. It
 * refuses any deployment database and any non-local host, and FAILS (never
 * skips) without a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the mint-ceiling parity drill measures stored approval, '
    + 'credential and Task rows, so it never skips. Load database/init.sql into a disposable database, run '
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
  throw new Error('Mint-ceiling parity drill refuses a non-disposable database target');
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
const { principalService } = require('../services/PrincipalService');
const { accessProfileService } = require('../services/AccessProfileService');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { stepUpService } = require('../services/StepUpService');
const inProcess = require('../mcp/inProcess');
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');

jest.setTimeout(300_000);

// ──────────────────────────────── the app ────────────────────────────────────

let server: http.Server;
let origin: string;

function buildApp(): any {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  // The MCP ingress first and outside the REST funnel, exactly as server.ts
  // mounts it.
  app.use(MCP_ROUTE_PATH, mcpRoutes);
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  return app;
}

// ───────────────────── the REST status behind every tool ─────────────────────

interface Dispatched { method: string; path: string; status: number }
const dispatched: Dispatched[] = [];
const realDispatch = inProcess.dispatchInProcess;

function answersSince(mark: number, method: string, path: RegExp): number[] {
  return dispatched.slice(mark).filter((entry) => entry.method === method && path.test(entry.path))
    .map((entry) => entry.status);
}

// ──────────────────────────────── callers ────────────────────────────────────

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

async function mcpCall(token: string, name: string, args: Record<string, unknown> = {}): Promise<Answer> {
  const response = await fetch(`${origin}${MCP_ROUTE_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
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
const key = (label: string): string => `p1c-${label}-${crypto.randomUUID()}`;
const bearer = (token: string): Caller => ({ label: 'bearer', principalId: '', headers: { Authorization: `Bearer ${token}` } });

// ─────────────────────────────── fixtures ────────────────────────────────────

const FOUR_SCOPES = ['tasks:read', 'tasks:write', 'reports:read', 'reports:write'];
const SYSTEM = { principalId: null, handle: 'p1c-mint-ceiling-fixture', authMethod: 'system' as const };

/** An unrelated Account: creator and owner of everything no cell is meant to hold. */
let STRANGER: string;
/** An unrelated Task every read oracle is bound to, so §8.2 never reaches X. */
let ANCHOR: string;

async function account(role = 'user'): Promise<string> {
  const row = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $1, 'active', $2) RETURNING id`,
    [`p1c-account-${tag()}`, role],
  );
  return String(row.rows[0].id);
}

async function sessionFor(principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label: 'session', principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

/** A Connector under `accountId`, with an explicit own() (the delegation fixture shape). */
async function connectorOf(accountId: string, objects: unknown = 'parent', scopes: string[] = FOUR_SCOPES)
  : Promise<Caller & { token: string }> {
  const row = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, $1, 'active', 'user', $2, 'mint ceiling parity fixture', $3::jsonb) RETURNING id`,
    [`p1c-connector-${tag()}`, accountId, JSON.stringify({ scopes: 'parent', objects })],
  );
  const principalId = String(row.rows[0].id);
  const credential = await principalService.issueCredential({ principalId, scopes, transport: 'any' }, SYSTEM);
  return { label: 'connector', principalId, token: credential.fullKey, headers: { Authorization: `Bearer ${credential.fullKey}` } };
}

async function project(owner: string): Promise<string> {
  const row = await pool.query(
    `INSERT INTO projects (name, status, visibility, owner_principal_id)
     VALUES ($1, 'active', 'private', $2) RETURNING id`,
    [`p1c-project-${tag()}`, owner],
  );
  return String(row.rows[0].id);
}

async function task(projectId: string | null, fields: {
  accountOwner?: string | null; restricted?: boolean; visibility?: string; claimant?: string | null;
} = {}): Promise<string> {
  const row = await pool.query(
    `INSERT INTO tasks (title, status, visibility, project_id, restricted_access,
                        creator_principal_id, account_owner_principal_id, owner_principal_id)
     VALUES ($1, 'todo', $2, $3, $4, $5, $6, $7) RETURNING id`,
    [`p1c-task-${tag()}`, fields.visibility ?? 'private', projectId, fields.restricted ?? false,
      STRANGER, fields.accountOwner === undefined ? STRANGER : fields.accountOwner, fields.claimant ?? null],
  );
  return String(row.rows[0].id);
}

async function grant(granteeId: string, resourceType: string, resourceId: string | null, verb: string,
  granteeType = 'principal'): Promise<string> {
  const row = await pool.query(
    `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [granteeType, granteeId, resourceType, resourceId, verb, STRANGER],
  );
  return String(row.rows[0].id);
}

async function grantRows(principalId: string): Promise<number> {
  const row = await pool.query(
    `SELECT COUNT(*)::int AS n FROM grants WHERE grantee_type = 'principal' AND grantee_id = $1`, [principalId]);
  return Number(row.rows[0].n);
}

async function approvalRows(requesterId: string): Promise<number> {
  const row = await pool.query('SELECT COUNT(*)::int AS n FROM approvals WHERE requester_principal_id = $1', [requesterId]);
  return Number(row.rows[0].n);
}

const exact = (taskId: string, verbs: string[]) => ({ resourceType: 'task', selectorForm: 'exact', selectorIds: [taskId], verbs });

/** The rule exactly as a refusal names it. */
const named = (rule: ReturnType<typeof exact>): string => JSON.stringify({
  resourceType: rule.resourceType, selectorForm: rule.selectorForm, selectorIds: rule.selectorIds, verbs: rule.verbs,
});

// ──────────────────────────── the mint path ──────────────────────────────────

/** FILE a mint request over REST, as a stock Connector does. */
async function file(connector: Caller, taskId: string, rules: unknown[], scopes: string[] = FOUR_SCOPES): Promise<Answer> {
  return call(connector, 'POST', '/delegation/agent-mints',
    { via: 'approval', targetTaskId: taskId, requestedScopes: scopes, requestedRules: rules },
    { 'Idempotency-Key': key('file') });
}

/**
 * Approve under a step-up. The token is minted through the service:
 * `/auth/step-up` re-enters a password these fixture Accounts do not have and
 * performs no authority check on its target, so the service mint is the
 * faithful stand-in for an approver who has just re-entered their own password
 * (the mintTargetAuthorization and 1118fefa precedent). The rest is the route.
 */
async function approve(approver: Caller, approvalId: string): Promise<Answer> {
  const stepUp = await stepUpService.mint(approver.principalId, 'approval.decide', approvalId, 'password');
  return call(approver, 'POST', `/approvals/${approvalId}/approve`, { stepUpToken: stepUp.token });
}

/** request -> step-up approval -> collect, every step through the router. */
async function mintThrough(connector: Caller, approver: Caller, taskId: string, rules: unknown[])
  : Promise<{ token: string; principalId: string }> {
  const filed = await file(connector, taskId, rules);
  expect([filed.status, filed.json?.path, filed.json?.code]).toEqual([202, 'approval', undefined]);
  const approvalId = String(filed.json.approval.id);
  const approved = await approve(approver, approvalId);
  expect([approved.status, approved.json?.code, approved.json?.approval?.status]).toEqual([200, undefined, 'approved']);
  const collected = await call(connector, 'POST', `/delegation/agent-mints/${approvalId}/collect`, {},
    { 'Idempotency-Key': key('collect') });
  expect([collected.status, collected.json?.code]).toEqual([201, undefined]);
  return { token: String(collected.json.pack.secretOnce), principalId: String(collected.json.pack.principalId) };
}

const readStatus = async (token: string, taskId: string): Promise<number> =>
  (await call(bearer(token), 'GET', `/tasks/${taskId}`)).status;
const writeStatus = async (token: string, taskId: string): Promise<number> =>
  (await call(bearer(token), 'PATCH', `/tasks/${taskId}`, { title: `p1c-written-${tag()}` })).status;

/**
 * THE LIVE T2 ORACLE: a fixture Agent carrying exactly `rule`, under
 * `parentId`, bound to `boundTaskId`. AZ-A10's production mint now refuses
 * role rows above the assigner; constructing this explicit-rule fixture
 * separately keeps this parity drill about the requested-rule T2 algebra.
 */
async function oracleAgent(parentId: string, boundTaskId: string, rule: unknown): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const handle = `p1c-rule-oracle-${tag()}`;
    const inserted = await client.query(
      `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id,
         bound_task_id, own_expression, source_tag)
       VALUES ('agent', $1, $1, 'active', $2, $3, $4::jsonb, $5) RETURNING id`,
      [handle, parentId, boundTaskId, JSON.stringify({ scopes: FOUR_SCOPES, objects: [rule] }), handle],
    );
    const issued = await principalService.issueCredential({
      principalId: String(inserted.rows[0].id), scopes: FOUR_SCOPES,
      expiresAt: new Date(Date.now() + 3600_000), transport: 'any',
    }, SYSTEM, client);
    await client.query('COMMIT');
    return String(issued.fullKey);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ─────────────────────────────── lifecycle ───────────────────────────────────

beforeAll(async () => {
  jest.spyOn(inProcess, 'dispatchInProcess').mockImplementation(async (...args: unknown[]) => {
    const request = args[0] as { method: string; path: string };
    const result = await realDispatch(...(args as [any]));
    dispatched.push({ method: request.method, path: request.path, status: result.status });
    return result;
  });
  await new Promise<void>((resolve) => { server = buildApp().listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  STRANGER = await account('user');
  ANCHOR = await task(await project(STRANGER));
});

afterAll(async () => {
  jest.restoreAllMocks();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ──────────────────── 1-3: authority the old ceiling refused ─────────────────

describe('1-3: the ceiling admits what the live predicate admits (request, approve, collect, act)', () => {
  it('1: an Account that OWNS the Task\'s Project, with no grant row, mints {task exact X [read, write]}', async () => {
    const owner = await account('user');
    const projectId = await project(owner);
    // account_owner unset: the predicate's COALESCE falls through to the Project owner.
    const taskId = await task(projectId, { accountOwner: null });
    const connector = await connectorOf(owner);
    expect(await grantRows(owner)).toBe(0);

    const agent = await mintThrough(connector, await sessionFor(owner), taskId, [exact(taskId, ['read', 'write'])]);
    expect(await readStatus(agent.token, taskId)).toBe(200);
    expect(await writeStatus(agent.token, taskId)).toBe(200);
    expect(await grantRows(owner)).toBe(0);
  });

  it('2: an Account holding ONLY a write grant on X mints [read, write] (write implies read, live)', async () => {
    const holder = await account('user');
    const taskId = await task(await project(STRANGER));
    await grant(holder, 'task', taskId, 'write');
    const verbs = await pool.query(
      `SELECT array_agg(verb ORDER BY verb) AS verbs FROM grants WHERE grantee_type = 'principal' AND grantee_id = $1`, [holder]);
    expect(verbs.rows[0].verbs).toEqual(['write']);
    // The live truth the ceiling must agree with: this Account READS X on its
    // write grant alone, through the same predicate.
    const holderSession = await sessionFor(holder);
    expect((await call(holderSession, 'GET', `/tasks/${taskId}`)).status).toBe(200);

    const agent = await mintThrough(await connectorOf(holder), holderSession, taskId, [exact(taskId, ['read', 'write'])]);
    expect(await readStatus(agent.token, taskId)).toBe(200);
    expect(await writeStatus(agent.token, taskId)).toBe(200);
  });

  it('3: an Account holding a Project-level grant mints a Task-exact rule', async () => {
    const member = await account('user');
    const projectId = await project(STRANGER);
    const taskId = await task(projectId);
    await grant(member, 'project', projectId, 'write');
    expect(await pool.query(
      `SELECT 1 FROM grants WHERE grantee_id = $1 AND resource_type = 'task'`, [member])).toMatchObject({ rowCount: 0 });

    const agent = await mintThrough(await connectorOf(member), await sessionFor(member), taskId, [exact(taskId, ['read', 'write'])]);
    expect(await readStatus(agent.token, taskId)).toBe(200);
    expect(await writeStatus(agent.token, taskId)).toBe(200);
  });
});

// ───────────────────── 4: the negative, at filing and at decide ──────────────

describe('4: no authority on X refuses at FILING, and decide refuses with the same words', () => {
  it('REST: 403 MINT_EXCEEDS_REQUESTER naming the rule, no Approval row, an audited denial', async () => {
    const outsider = await account('user');
    const taskId = await task(await project(STRANGER));
    const connector = await connectorOf(outsider);
    const rule = exact(taskId, ['read', 'write']);

    const refused = await file(connector, taskId, [rule]);
    expect([refused.status, refused.json?.code]).toEqual([403, 'MINT_EXCEEDS_REQUESTER']);
    expect(String(refused.json?.message)).toContain(named(rule));
    expect(await approvalRows(connector.principalId)).toBe(0);

    const audit = await pool.query(
      `SELECT metadata FROM audit_events
        WHERE action = 'approval.request' AND outcome = 'denied' AND resource_id = $1`, [connector.principalId]);
    expect(audit.rows.map((row: any) => row.metadata?.refusal)).toEqual(['MINT_EXCEEDS_REQUESTER']);
  });

  it('MCP relayhall_agent_mint: the same refusal, through the same route', async () => {
    const outsider = await account('user');
    const taskId = await task(await project(STRANGER));
    // The tool needs principals:read; bootstrapping is the session brief.
    const connector = await connectorOf(outsider, 'parent', [...FOUR_SCOPES, 'principals:read']);
    const brief = await mcpCall(connector.token, 'relayhall_brief_compile', { session: true });
    expect(mcpFailed(brief)).toBe(false);
    const rule = exact(taskId, ['read', 'write']);

    const mark = dispatched.length;
    const refused = await mcpCall(connector.token, 'relayhall_agent_mint', {
      action: 'request', task: taskId, via: 'approval', requestedScopes: FOUR_SCOPES,
      requestedRules: [rule], idempotencyKey: key('mcp'),
    });
    expect(answersSince(mark, 'POST', /^\/delegation\/agent-mints$/)).toEqual([403]);
    expect(mcpFailed(refused)).toBe(true);
    expect(mcpText(refused)).toContain('MINT_EXCEEDS_REQUESTER');
    expect(mcpText(refused)).toContain(named(rule));
    expect(await approvalRows(connector.principalId)).toBe(0);
  });

  it('DECIDE: authority withdrawn after filing refuses with the filing refusal\'s exact code and words', async () => {
    const holder = await account('user');
    const taskId = await task(await project(STRANGER));
    const connector = await connectorOf(holder);
    const approver = await sessionFor(holder);
    const rule = exact(taskId, ['read', 'write']);
    const temporary = await grant(holder, 'task', taskId, 'write');

    const filed = await file(connector, taskId, [rule]);
    expect([filed.status, filed.json?.code]).toEqual([202, undefined]);
    const approvalId = String(filed.json.approval.id);

    await pool.query('DELETE FROM grants WHERE id = $1', [temporary]);
    const atFiling = await file(connector, taskId, [rule]);
    const atDecide = await approve(approver, approvalId);
    expect([atDecide.status, atDecide.json?.code]).toEqual([403, 'MINT_EXCEEDS_REQUESTER']);
    expect([atFiling.status, atFiling.json?.code, atFiling.json?.message])
      .toEqual([atDecide.status, atDecide.json?.code, atDecide.json?.message]);
    expect(String(atDecide.json?.message)).toContain(named(rule));
    const state = await pool.query('SELECT status FROM approvals WHERE id = $1', [approvalId]);
    expect(state.rows[0].status).toBe('pending');
  });

  it('the scope half of T2 refuses at filing too, naming the scope', async () => {
    const holder = await account('user');
    const taskId = await task(await project(STRANGER));
    await grant(holder, 'task', taskId, 'write');
    const connector = await connectorOf(holder);
    // projects:write is within the Account's role set but not on the
    // Connector's credential, so it is outside the requester's effective set.
    const refused = await file(connector, taskId, [exact(taskId, ['read', 'write'])], [...FOUR_SCOPES, 'projects:write']);
    expect([refused.status, refused.json?.code]).toEqual([403, 'MINT_EXCEEDS_REQUESTER']);
    expect(String(refused.json?.message)).toContain('projects:write');
    expect(await approvalRows(connector.principalId)).toBe(0);
  });
});

// ─────────────────────────── 5: the parity drill ─────────────────────────────

type Shape = 'read' | 'write' | 'read+write';
const SHAPES: Array<{ shape: Shape; verbs: string[] }> = [
  { shape: 'read', verbs: ['read'] },
  { shape: 'write', verbs: ['write'] },
  { shape: 'read+write', verbs: ['read', 'write'] },
];

interface Cell {
  source: string;
  /** Builds the cell's Account authority; returns the Connector that files and the Task X. */
  build(): Promise<{ connector: Caller; taskId: string }>;
  /** The written expectation for [read], [write], [read, write]. */
  expected: [boolean, boolean, boolean];
}

const ALL: [boolean, boolean, boolean] = [true, true, true];
const NONE: [boolean, boolean, boolean] = [false, false, false];
const READ_ONLY: [boolean, boolean, boolean] = [true, false, false];

const CELLS: Cell[] = [
  {
    source: 'no authority',
    expected: NONE,
    async build() {
      const subject = await account();
      return { connector: await connectorOf(subject), taskId: await task(await project(STRANGER)) };
    },
  },
  {
    source: 'owns the Task\'s Project (account_owner unset)',
    expected: ALL,
    async build() {
      const subject = await account();
      return { connector: await connectorOf(subject), taskId: await task(await project(subject), { accountOwner: null }) };
    },
  },
  {
    source: 'is the Task\'s account owner',
    expected: ALL,
    async build() {
      const subject = await account();
      return { connector: await connectorOf(subject), taskId: await task(await project(STRANGER), { accountOwner: subject }) };
    },
  },
  {
    source: 'exact write grant',
    expected: ALL,
    async build() {
      const subject = await account();
      const taskId = await task(await project(STRANGER));
      await grant(subject, 'task', taskId, 'write');
      return { connector: await connectorOf(subject), taskId };
    },
  },
  {
    source: 'exact read grant',
    expected: READ_ONLY,
    async build() {
      const subject = await account();
      const taskId = await task(await project(STRANGER));
      await grant(subject, 'task', taskId, 'read');
      return { connector: await connectorOf(subject), taskId };
    },
  },
  {
    source: 'wildcard Task write grant',
    expected: ALL,
    async build() {
      const subject = await account();
      await grant(subject, 'task', null, 'write');
      return { connector: await connectorOf(subject), taskId: await task(await project(STRANGER)) };
    },
  },
  {
    source: 'group write grant on the Task',
    expected: ALL,
    async build() {
      const subject = await account();
      const taskId = await task(await project(STRANGER));
      // AZ-A12 build 1: a raw Group row needs its kind='group' principal first.
      const groupId = await require('./support/groupRows').insertGroupRow(pool, { name: `p1c-group-${tag()}` });
      await pool.query('INSERT INTO group_members (group_id, account_principal_id) VALUES ($1, $2)', [groupId, subject]);
      await grant(String(groupId), 'task', taskId, 'write', 'group');
      return { connector: await connectorOf(subject), taskId };
    },
  },
  {
    source: 'Project read grant',
    expected: READ_ONLY,
    async build() {
      const subject = await account();
      const projectId = await project(STRANGER);
      await grant(subject, 'project', projectId, 'read');
      return { connector: await connectorOf(subject), taskId: await task(projectId) };
    },
  },
  {
    source: 'Project write grant',
    expected: ALL,
    async build() {
      const subject = await account();
      const projectId = await project(STRANGER);
      await grant(subject, 'project', projectId, 'write');
      return { connector: await connectorOf(subject), taskId: await task(projectId) };
    },
  },
  {
    source: 'Project write grant, Task restricted',
    expected: NONE,
    async build() {
      const subject = await account();
      const projectId = await project(STRANGER);
      await grant(subject, 'project', projectId, 'write');
      return { connector: await connectorOf(subject), taskId: await task(projectId, { restricted: true }) };
    },
  },
  {
    source: 'profile rule all-in-project [P] write',
    expected: ALL,
    async build() {
      const subject = await account();
      const projectId = await project(STRANGER);
      const profile = await accessProfileService.create({ name: `p1c-profile-${tag()}` }, SYSTEM);
      const version = await accessProfileService.createVersion(profile.id,
        [{ resourceType: 'task', selectorForm: 'all-in-project', selectorIds: [projectId], verbs: ['write'] }], SYSTEM);
      await accessProfileService.publish(profile.id, version.id, SYSTEM);
      await accessProfileService.assign(profile.id, { assigneeType: 'principal', assigneeId: subject }, SYSTEM);
      return { connector: await connectorOf(subject), taskId: await task(projectId) };
    },
  },
  {
    source: 'Task visibility shared',
    expected: READ_ONLY,
    async build() {
      const subject = await account();
      return { connector: await connectorOf(subject), taskId: await task(await project(STRANGER), { visibility: 'shared' }) };
    },
  },
  {
    source: 'operator Account',
    expected: ALL,
    async build() {
      const subject = await account('operator');
      return { connector: await connectorOf(subject), taskId: await task(await project(STRANGER)) };
    },
  },
  {
    // A Task role is the ACTING identity's, and never inherits down a chain
    // (AZ-26): the Connector may work X; an Agent it mints may not.
    source: 'the Connector is the Task\'s claimant',
    expected: NONE,
    async build() {
      const subject = await account();
      const connector = await connectorOf(subject);
      return { connector, taskId: await task(await project(STRANGER), { claimant: connector.principalId }) };
    },
  },
  {
    source: 'exact write grant, Connector own() cap excludes X',
    expected: NONE,
    async build() {
      const subject = await account();
      const taskId = await task(await project(STRANGER));
      await grant(subject, 'task', taskId, 'write');
      return { connector: await connectorOf(subject, [exact(ANCHOR, ['read', 'write'])]), taskId };
    },
  },
  {
    source: 'exact write grant, Connector own() cap read-only on X',
    expected: READ_ONLY,
    async build() {
      const subject = await account();
      const taskId = await task(await project(STRANGER));
      await grant(subject, 'task', taskId, 'write');
      return { connector: await connectorOf(subject, [exact(taskId, ['read'])]), taskId };
    },
  },
];

// Card 696f3bb8 (CI run 5685 job 14991). The matrix is built in ONE hook:
// 16 cells x 3 rule shapes, each a filing and one or two live oracle Agents.
// Measured on a disposable PostgreSQL 16 with jest and the database pinned to
// the same busy cores: 9.9 s idle, 40.6 s with each of two cores shared four
// ways, 60.1 s and 103.0 s with one core shared eight and sixteen ways. It
// also slows as the database fills: over ten consecutive runs on one fresh
// database (the mint-ceiling drill runs this file ten times on one) it rose
// from 10.0 s to 87.4 s idle, and an eleventh run, on two cores each shared
// four ways, took 254.0 s. On the saturated CI runner it outlived the
// file-wide 300 000 ms budget (jest.setTimeout above), which failed all four
// section-5 tests at once and made the drill read the control as a MISS. The
// hook carries its own budget: three times the 300 s the CI build already
// exceeded, and more than three times that eleventh run. What the matrix
// measures is unchanged.
const PARITY_MATRIX_BUILD_MS = 900_000;

describe('5: PARITY: the filing verdict equals what the minted rule can do live, cell by cell', () => {
  interface Row { source: string; shape: Shape; filed: boolean; live: boolean }
  const measured: Row[] = [];

  beforeAll(async () => {
    for (const cell of CELLS) {
      const { connector, taskId } = await cell.build();
      for (const { shape, verbs } of SHAPES) {
        const rule = exact(taskId, verbs);

        const answer = await file(connector, taskId, [rule]);
        if (!(answer.status === 202 || (answer.status === 403 && answer.json?.code === 'MINT_EXCEEDS_REQUESTER'))) {
          throw new Error(`${cell.source} / ${shape}: filing answered ${answer.status} ${String(answer.json?.code)}`);
        }

        const reader = await oracleAgent(connector.principalId, ANCHOR, rule);
        const read = await readStatus(reader, taskId);
        let live = read === 200;
        if (verbs.includes('write')) {
          const writer = await oracleAgent(connector.principalId, taskId, rule);
          live = live && (await writeStatus(writer, taskId)) === 200;
        }
        measured.push({ source: cell.source, shape, filed: answer.status === 202, live });
      }
    }
  }, PARITY_MATRIX_BUILD_MS);

  it('measured every cell', () => {
    expect(measured).toHaveLength(CELLS.length * SHAPES.length);
  });

  it('the live oracle agrees with the written expectation (the matrix is not vacuous)', () => {
    const expected = CELLS.flatMap((cell) => SHAPES.map(({ shape }, index) => ({ source: cell.source, shape, live: cell.expected[index] })));
    expect(measured.map(({ source, shape, live }) => ({ source, shape, live }))).toEqual(expected);
  });

  it('the filing verdict equals the live verdict in EVERY cell: never wider, never narrower', () => {
    expect(measured.map(({ source, shape, filed }) => ({ source, shape, filed })))
      .toEqual(measured.map(({ source, shape, live }) => ({ source, shape, filed: live })));
  });

  it('both verdicts occur, in every rule shape (a ceiling that always says yes or always no fails above)', () => {
    for (const { shape } of SHAPES) {
      const verdicts = new Set(measured.filter((row) => row.shape === shape).map((row) => row.filed));
      expect([shape, [...verdicts].sort()]).toEqual([shape, [false, true]]);
    }
  });
});

// ──────────── 6: the algebra arm (non-exact selectors), never wider ──────────

/**
 * A rule the live predicate cannot decide object by object (`all-of-type`,
 * `all-except`, `all-in-project`) is judged by `algebraCeilingMiss`: the
 * Account's grant and profile rows with verb implication (`withImpliedVerbs`),
 * the administrator superset (`ADMINISTRATOR_ROLES`), and every own() cap down
 * the chain. That arm may be narrower than live authority, never wider.
 *
 * Each cell carries a written verdict. An ADMITTED cell is also checked live:
 * an Agent written by the production mint writer with exactly that rule
 * (`oracleAgent`, bound to the unrelated ANCHOR) reads the named Tasks, and an
 * Agent bound to each named write Task writes it. A REFUSED cell whose rule
 * covers a readable Task names a WITNESS: a Task the rule covers that the same
 * Agent cannot read, so admitting the rule would claim more than the requester
 * holds. A refusal that turns on a verb (`admin`, `use`) has no read witness;
 * its verdict is the written one.
 *
 * `scripts/mint-ceiling-mutations.py` widens each of the three algebra inputs
 * in turn (every source holds every verb; the own() caps are dropped; every
 * Account is an administrator) and requires exactly the cells below that each
 * one breaks to go red.
 */

const allOfType = (verbs: string[]) => ({ resourceType: 'task', selectorForm: 'all-of-type', selectorIds: [] as string[], verbs });
const allExcept = (ids: string[], verbs: string[]) => ({ resourceType: 'task', selectorForm: 'all-except', selectorIds: ids, verbs });
const allInProject = (ids: string[], verbs: string[]) => ({ resourceType: 'task', selectorForm: 'all-in-project', selectorIds: ids, verbs });

/** A published Access profile carrying `rules`, assigned to `subject`. */
async function profileOf(subject: string, rules: unknown[]): Promise<void> {
  const profile = await accessProfileService.create({ name: `p1c-profile-${tag()}` }, SYSTEM);
  const version = await accessProfileService.createVersion(profile.id, rules, SYSTEM);
  await accessProfileService.publish(profile.id, version.id, SYSTEM);
  await accessProfileService.assign(profile.id, { assigneeType: 'principal', assigneeId: subject }, SYSTEM);
}

/** A Task in a Project of the STRANGER: nothing any cell holds by default. */
const unrelatedTask = async (): Promise<string> => task(await project(STRANGER));

interface AlgebraCell {
  title: string;
  admitted: boolean;
  build(): Promise<{
    connector: Caller;
    /** The Task the request is filed for. */
    target: string;
    rule: ReturnType<typeof exact>;
    /** Admitted: Tasks the rule's Agent must read live. Refused: witnesses it must NOT read. */
    reads: string[];
    /** Admitted only: Tasks the rule's Agent, bound to each, must write live. */
    writes: string[];
  }>;
}

const ALGEBRA_CELLS: AlgebraCell[] = [
  {
    title: '6a: an exact grant only, all-of-type [read]: refused',
    admitted: false,
    async build() {
      const subject = await account();
      const target = await unrelatedTask();
      await grant(subject, 'task', target, 'write');
      return { connector: await connectorOf(subject), target, rule: allOfType(['read']), reads: [await unrelatedTask()], writes: [] };
    },
  },
  {
    title: '6b: an exact grant only, all-except [Z] [read]: refused',
    admitted: false,
    async build() {
      const subject = await account();
      const target = await unrelatedTask();
      await grant(subject, 'task', target, 'write');
      return {
        connector: await connectorOf(subject), target,
        rule: allExcept([await unrelatedTask()], ['read']), reads: [await unrelatedTask()], writes: [],
      };
    },
  },
  {
    title: '6c: a wildcard Task write grant, all-of-type [read]: admitted, and its Agent reads an unrelated Task',
    admitted: true,
    async build() {
      const subject = await account();
      await grant(subject, 'task', null, 'write');
      return { connector: await connectorOf(subject), target: await unrelatedTask(), rule: allOfType(['read']), reads: [await unrelatedTask()], writes: [] };
    },
  },
  {
    title: '6d: a wildcard Task write grant, all-of-type [admin]: refused (write confers no admin)',
    admitted: false,
    async build() {
      const subject = await account();
      await grant(subject, 'task', null, 'write');
      return { connector: await connectorOf(subject), target: await unrelatedTask(), rule: allOfType(['admin']), reads: [], writes: [] };
    },
  },
  {
    title: '6e: a profile all-in-project [P] write, all-in-project [P] [read, write]: admitted, read and written live',
    admitted: true,
    async build() {
      const subject = await account();
      const projectId = await project(STRANGER);
      await profileOf(subject, [allInProject([projectId], ['write'])]);
      const inside = await task(projectId);
      return {
        connector: await connectorOf(subject), target: await task(projectId),
        rule: allInProject([projectId], ['read', 'write']), reads: [inside], writes: [inside],
      };
    },
  },
  {
    title: '6f: a profile all-in-project [P] write, all-in-project [P, P2] [read, write]: refused',
    admitted: false,
    async build() {
      const subject = await account();
      const projectId = await project(STRANGER);
      const other = await project(STRANGER);
      await profileOf(subject, [allInProject([projectId], ['write'])]);
      return {
        connector: await connectorOf(subject), target: await task(projectId),
        rule: allInProject([projectId, other], ['read', 'write']), reads: [await task(other)], writes: [],
      };
    },
  },
  {
    title: '6g: a profile all-in-project [P] write, all-in-project [P] [use]: refused (write confers no use)',
    admitted: false,
    async build() {
      const subject = await account();
      const projectId = await project(STRANGER);
      await profileOf(subject, [allInProject([projectId], ['write'])]);
      return {
        connector: await connectorOf(subject), target: await task(projectId),
        rule: allInProject([projectId], ['use']), reads: [], writes: [],
      };
    },
  },
  {
    title: '6h: a Connector own() capped to exact [X] under a wildcard-grant Account, all-of-type [read]: refused',
    admitted: false,
    async build() {
      const subject = await account();
      await grant(subject, 'task', null, 'write');
      const target = await unrelatedTask();
      return {
        connector: await connectorOf(subject, [exact(target, ['read', 'write'])]), target,
        rule: allOfType(['read']), reads: [await unrelatedTask()], writes: [],
      };
    },
  },
  {
    title: '6i: an admin Account, all-of-type [read, write]: admitted, read and written live',
    admitted: true,
    async build() {
      const subject = await account('admin');
      const elsewhere = await unrelatedTask();
      return {
        connector: await connectorOf(subject), target: await unrelatedTask(),
        rule: allOfType(['read', 'write']), reads: [elsewhere], writes: [elsewhere],
      };
    },
  },
  {
    title: '6j: an operator Account, all-of-type [read, write]: admitted, read and written live',
    admitted: true,
    async build() {
      const subject = await account('operator');
      const elsewhere = await unrelatedTask();
      return {
        connector: await connectorOf(subject), target: await unrelatedTask(),
        rule: allOfType(['read', 'write']), reads: [elsewhere], writes: [elsewhere],
      };
    },
  },
];

describe('6: the algebra arm (all-of-type, all-except, all-in-project) is never wider than live authority', () => {
  for (const cell of ALGEBRA_CELLS) {
    it(cell.title, async () => {
      const { connector, target, rule, reads, writes } = await cell.build();
      const answer = await file(connector, target, [rule]);

      if (cell.admitted) {
        expect([answer.status, answer.json?.path, answer.json?.code]).toEqual([202, 'approval', undefined]);
        // Not vacuous: every admitted cell is exercised live.
        expect(reads.length).toBeGreaterThan(0);
        const reader = await oracleAgent(connector.principalId, ANCHOR, rule);
        for (const taskId of reads) expect([taskId, await readStatus(reader, taskId)]).toEqual([taskId, 200]);
        for (const taskId of writes) {
          const writer = await oracleAgent(connector.principalId, taskId, rule);
          expect([taskId, await writeStatus(writer, taskId)]).toEqual([taskId, 200]);
        }
        return;
      }

      expect([answer.status, answer.json?.code]).toEqual([403, 'MINT_EXCEEDS_REQUESTER']);
      expect(String(answer.json?.message)).toContain(named(rule));
      expect(await approvalRows(connector.principalId)).toBe(0);
      expect(writes).toEqual([]);
      if (reads.length > 0) {
        // The witness: the rule covers this Task, and an Agent holding it under
        // this requester cannot read it. Admitting the rule would be wider.
        const reader = await oracleAgent(connector.principalId, ANCHOR, rule);
        for (const taskId of reads) expect([taskId, (await readStatus(reader, taskId)) === 200]).toEqual([taskId, false]);
      }
    });
  }
});
