/**
 * Card 1118fefa: an ORDINARY task-scoped Agent bootstraps, and then works.
 *
 * Reproduced on production 2026-10-09 14:33 UTC: an owner-approved Agent
 * credential carrying exactly `tasks:read`, `tasks:write`, `reports:read` and
 * `reports:write`, bound to an armed Task, called `relayhall_brief_compile`
 * with `{"session": true}` - the call its own onboarding prompt names - and was
 * refused 403 "missing scope principals:read". Every work-plane tool then said
 * "bootstrap first", so no Agent minted without `principals:read` could claim,
 * move or report anything.
 *
 * This suite is that drill, automated, over a REAL PostgreSQL and the
 * PRODUCTION router with the MCP ingress mounted the way `server.ts` mounts it:
 *
 *   - the Connector is registered through the owner's real `POST /services`
 *     wizard path, and the Agent is minted through the real approval path -
 *     Connector request, owner approval under a password step-up, Connector
 *     collect - so the credential is the one the board itself issues;
 *   - the Agent then bootstraps, claims, moves to in-progress, saves a draft
 *     progress Report, lists it and finishes to Review, all through MCP
 *     `tools/call` with nothing but its bearer token. Its four scopes are the
 *     route plane; the object plane is its own() expression, and this request
 *     carries one exact `write` rule on its bound Task. (A request with NO
 *     rule now works the same way - card c334177b reads an Agent's empty
 *     own() list as its bound Task, proven in boundAgentClaimLive.test.ts.) A
 *     separate control below shows an Agent whose approval names only a READ
 *     rule on its Task bootstraps all the same and is then refused at the
 *     claim by OBJECT authority, so bootstrapping visibly grants no authority;
 *   - the REST status behind every tool call is recorded at the in-process
 *     dispatch seam, so "201 on the draft save" is a measured status and not an
 *     inference from tool text.
 *
 * And the negatives the card names: the same Agent still cannot list other
 * principals (`principals:read`, unchanged); a credential with NO scopes at all
 * bootstraps on its identity alone and can do nothing else; and a Task-bound
 * credential whose scopes admit no content is told its Task id and nothing of
 * the Task.
 *
 * RED PROOF: against main's `scopeMap.ts` the bootstrap answers 403 and the
 * first assertion of the work sequence fails there.
 *
 * DESTRUCTIVE: writes principals, credentials, services, approvals, tasks,
 * reports, bootstrap records and audit rows. It refuses any deployment database
 * and any non-local host, and FAILS - never skips - without a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the bootstrap drill measures stored credential, bootstrap, '
    + 'claim and Report rows, so it never skips. Load database/init.sql into a disposable database, run '
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
  throw new Error('Session bootstrap drill refuses a non-disposable database target');
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
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { stepUpService } = require('../services/StepUpService');
const { requiredScopeFor } = require('../utils/scopeMap');
const inProcess = require('../mcp/inProcess');
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');
const { BOOTSTRAP_REFUSAL_MARKER } = require('../mcp/bootstrapGate');

jest.setTimeout(180_000);

// ──────────────────────────────── the app ────────────────────────────────────

let server: http.Server;
let origin: string;

function buildApp(): any {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  // The MCP ingress first and outside the REST funnel, exactly as server.ts
  // mounts it: it stamps the `mcp` transport after termination.
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

/** The board answers recorded since `mark`, for one route shape. */
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

/** One JSON-RPC tools/call, as a stock client makes it: a bearer and nothing else. */
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
const key = (label: string): string => `b9-${label}-${crypto.randomUUID()}`;

/** Every string anywhere inside a value - for prose whose field name is not the claim. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsIn);
  return [];
}

// ─────────────────────────────── fixtures ────────────────────────────────────

const FOUR_SCOPES = ['tasks:read', 'tasks:write', 'reports:read', 'reports:write'];
const BOOTSTRAP_CALL_IN_PROMPT = 'Call relayhall_brief_compile with {"session": true}';

let OWNER: Caller;
let CONNECTOR: Caller;
let TASK_ID: string;
let TASK_TITLE: string;

async function makeAccount(role: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $1, 'active', $2) RETURNING id`,
    [`b9-owner-${tag()}`, role],
  );
  return String(result.rows[0].id);
}

async function sessionFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

/**
 * Mint an Agent through the REAL approval path: the Connector requests, the
 * owner approves under a step-up, the Connector collects.
 *
 * The step-up token is minted through the service: `/auth/step-up` re-enters a
 * password these fixture Accounts do not have, and it performs no authority
 * check on its target, so the service mint is the faithful stand-in for an
 * owner who has just re-entered their own password (the mintTargetAuthorization
 * precedent). Everything else is the route.
 */
async function mintThroughApproval(scopes: string[], requestedRules: unknown[] = [], targetTaskId: string = TASK_ID): Promise<{ principalId: string; credentialId: string; token: string; pack: any }> {
  const requested = await call(CONNECTOR, 'POST', '/delegation/agent-mints',
    // No rules is an ABSENT field: the route validates any array it is sent.
    { targetTaskId, requestedScopes: scopes, via: 'approval', ...(requestedRules.length > 0 ? { requestedRules } : {}) },
    { 'Idempotency-Key': key('request') });
  expect([requested.status, requested.json?.path, requested.json?.code]).toEqual([202, 'approval', undefined]);
  const approvalId = String(requested.json.approval.id);

  const stepUp = await stepUpService.mint(OWNER.principalId, 'approval.decide', approvalId, 'password');
  const approved = await call(OWNER, 'POST', `/approvals/${approvalId}/approve`, { stepUpToken: stepUp.token });
  expect([approved.status, approved.json?.approval?.status]).toEqual([200, 'approved']);

  const collected = await call(CONNECTOR, 'POST', `/delegation/agent-mints/${approvalId}/collect`, {},
    { 'Idempotency-Key': key('collect') });
  expect(collected.status).toBe(201);
  const pack = collected.json.pack;
  const token = String(pack.secretOnce);
  const credential = await pool.query(
    'SELECT c.id, c.principal_id, c.scopes, p.kind, p.bound_task_id FROM principal_credentials c JOIN principals p ON p.id = c.principal_id WHERE c.id = $1',
    [pack.credentialId],
  );
  // The credential is the board's own, and it is exactly what was approved.
  expect(credential.rows).toHaveLength(1);
  expect(credential.rows[0].kind).toBe('agent');
  expect(String(credential.rows[0].bound_task_id)).toBe(targetTaskId);
  const stored = typeof credential.rows[0].scopes === 'string' ? JSON.parse(credential.rows[0].scopes) : credential.rows[0].scopes;
  expect([...stored].sort()).toEqual([...scopes].sort());
  return { principalId: String(credential.rows[0].principal_id), credentialId: String(pack.credentialId), token, pack };
}

async function bootstrapRows(credentialId: string): Promise<number> {
  const result = await pool.query(
    'SELECT 1 FROM mcp_bootstrap_records WHERE credential_id = $1 AND expires_at > now()', [credentialId]);
  return result.rows.length;
}

async function taskRow(taskId: string = TASK_ID): Promise<{ status: string; owner_principal_id: string | null; auto_start: boolean }> {
  const result = await pool.query('SELECT status, owner_principal_id, auto_start FROM tasks WHERE id = $1', [taskId]);
  return result.rows[0];
}

/** The one object rule a working Agent needs: write on exactly its bound Task. */
const writeOn = (taskId: string) => [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [taskId], verbs: ['write'] }];

/** An owner-created Task, armed through the owner's own routes. */
async function armedTask(title: string): Promise<string> {
  const created = await call(OWNER, 'POST', '/tasks', { title, description: 'session bootstrap drill', status: 'todo' });
  expect(created.status).toBe(201);
  const id = String(created.json?.task?.id);
  const armed = await call(OWNER, 'PATCH', `/tasks/${id}`, { autoStart: true }, { 'Idempotency-Key': key('arm') });
  expect(armed.status).toBe(200);
  expect((await taskRow(id)).auto_start).toBe(true);
  return id;
}

beforeAll(async () => {
  jest.spyOn(inProcess, 'dispatchInProcess').mockImplementation(async (...args: unknown[]) => {
    const request = args[0] as { method: string; path: string };
    const result = await realDispatch(...(args as [any]));
    dispatched.push({ method: request.method, path: request.path, status: result.status });
    return result;
  });

  await new Promise<void>((resolve) => { server = buildApp().listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // The owner: an ordinary Account, signed in.
  OWNER = await sessionFor('owner', await makeAccount('user'));

  // The owner's Task, through the owner's own create and arm routes.
  TASK_TITLE = `B9 BOUND TASK ${tag()}`;
  TASK_ID = await armedTask(TASK_TITLE);

  // The Connector: registered through the wizard path, REST-pinned, carrying
  // the four scopes it will delegate - and NOT principals:read.
  const slug = `b9-connector-${tag()}`;
  const registered = await call(OWNER, 'POST', '/services', {
    slug, name: slug, description: 'Session bootstrap drill connector.', kind: 'connector',
    issueCredential: { scopes: FOUR_SCOPES, label: slug, transport: 'api' },
  });
  expect(registered.status).toBe(201);
  const connectorRow = await pool.query('SELECT principal_id FROM services WHERE slug = $1', [slug]);
  CONNECTOR = {
    label: 'connector', principalId: String(connectorRow.rows[0].principal_id),
    headers: { Authorization: `Bearer ${registered.json.onboarding.credential.secretOnce}` },
  };
});

afterAll(async () => {
  jest.restoreAllMocks();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ─────────────────────────────── the drill ───────────────────────────────────

describe('a four-scope, task-bound Agent bootstraps and works (card 1118fefa)', () => {
  let AGENT: { principalId: string; credentialId: string; token: string; pack: any };
  let REPORT_ID: string;

  beforeAll(async () => {
    AGENT = await mintThroughApproval(FOUR_SCOPES, writeOn(TASK_ID));
  });

  it('the premise: the credential lacks principals:read, and its pack names the bootstrap call', () => {
    expect(FOUR_SCOPES).not.toContain('principals:read');
    expect(stringsIn(AGENT.pack.onboarding).some((text) => text.includes(BOOTSTRAP_CALL_IN_PROMPT))).toBe(true);
    expect(requiredScopeFor('GET', '/principals')).toBe('principals:read');
  });

  it('is refused "bootstrap first" before it bootstraps (the gate is live, so the rest is not vacuous)', async () => {
    expect(await bootstrapRows(AGENT.credentialId)).toBe(0);
    const early = await mcpCall(AGENT.token, 'relayhall_task_claim', { task: TASK_ID });
    expect(mcpFailed(early)).toBe(true);
    expect(mcpText(early)).toContain(BOOTSTRAP_REFUSAL_MARKER);
    expect((await taskRow()).owner_principal_id).toBeNull();
  });

  it('bootstraps with the call its pack names: 200, recorded, and the Brief is its own', async () => {
    const mark = dispatched.length;
    const brief = await mcpCall(AGENT.token, 'relayhall_brief_compile', { session: true });
    expect(answersSince(mark, 'POST', /^\/principals\/me\/brief$/)).toEqual([200]);
    expect(mcpFailed(brief)).toBe(false);
    const text = mcpText(brief);
    expect(text).toContain('Bootstrapped.');
    // The bootstrap is recorded exactly as before: one live row for THIS credential.
    expect(await bootstrapRows(AGENT.credentialId)).toBe(1);
    // "This identity" is served from the caller's own credential…
    expect(text).toContain(AGENT.principalId);
    expect(text).toContain(AGENT.credentialId);
    for (const scope of FOUR_SCOPES) expect(text).toContain(scope);
    // …and tasks:read admits the content, so its bound Task is in it by title.
    expect(text).toContain(TASK_TITLE);
    expect(text).not.toContain('What this Brief encloses');
    expect(text).toContain('Granted skill index');
  });

  it('claims its armed Task', async () => {
    const mark = dispatched.length;
    const claimed = await mcpCall(AGENT.token, 'relayhall_task_claim', { task: TASK_ID });
    expect([mcpFailed(claimed), mcpText(claimed).slice(0, 200)]).toEqual([false, expect.stringContaining('You are the Assignee')]);
    expect(answersSince(mark, 'POST', new RegExp(`^/tasks/${TASK_ID}/claim$`))).toEqual([200]);
    expect((await taskRow()).owner_principal_id).toBe(AGENT.principalId);
  });

  it('moves it to in-progress', async () => {
    const mark = dispatched.length;
    const moved = await mcpCall(AGENT.token, 'relayhall_task_move', { task: TASK_ID, status: 'in-progress' });
    expect([mcpFailed(moved), mcpText(moved)]).toEqual([false, expect.stringContaining('in-progress')]);
    expect(answersSince(mark, 'PATCH', new RegExp(`^/tasks/${TASK_ID}$`))).toEqual([200]);
    expect((await taskRow()).status).toBe('in-progress');
  });

  it('saves a draft progress Report: 201', async () => {
    const mark = dispatched.length;
    const saved = await mcpCall(AGENT.token, 'relayhall_task_report_save', {
      task: TASK_ID, title: 'B9 progress', content: 'Bootstrapped, claimed and moved without principals:read.',
      summary: 'session bootstrap drill', idempotencyKey: key('report'),
    });
    expect(mcpFailed(saved)).toBe(false);
    expect(answersSince(mark, 'POST', new RegExp(`^/tasks/${TASK_ID}/reports$`))).toEqual([201]);
    const envelope = JSON.parse(mcpText(saved));
    REPORT_ID = String(envelope.report?.id);
    const row = await pool.query('SELECT source_task_id, author_principal_id FROM reports WHERE id = $1', [REPORT_ID]);
    expect(row.rows).toHaveLength(1);
    expect(String(row.rows[0].source_task_id)).toBe(TASK_ID);
  });

  it('lists it', async () => {
    const mark = dispatched.length;
    const listed = await mcpCall(AGENT.token, 'relayhall_task_report_list',
      { task: TASK_ID, scope: 'progress', response_format: 'detailed' });
    expect(mcpFailed(listed)).toBe(false);
    expect(answersSince(mark, 'GET', new RegExp(`^/tasks/${TASK_ID}/reports`))).toEqual([200]);
    expect(mcpText(listed)).toContain(REPORT_ID);
  });

  it('finishes with that Report: the Task is in Review', async () => {
    const mark = dispatched.length;
    const finished = await mcpCall(AGENT.token, 'relayhall_task_finish',
      { task: TASK_ID, reportId: REPORT_ID, handover: 'Session bootstrap drill: bootstrap, claim, report, finish.' });
    expect([mcpFailed(finished), mcpText(finished).slice(0, 200)]).toEqual([false, expect.stringContaining('finished to Review')]);
    expect(answersSince(mark, 'POST', new RegExp(`^/tasks/${TASK_ID}/finish$`))).toEqual([200]);
    expect((await taskRow()).status).toBe('review');
  });

  it('still cannot list OTHER principals: principals:read is unchanged', async () => {
    const mark = dispatched.length;
    const listed = await mcpCall(AGENT.token, 'relayhall_principal_list', {});
    expect(mcpFailed(listed)).toBe(true);
    expect(mcpText(listed)).toContain('principals:read');
    expect(answersSince(mark, 'GET', /^\/principals$/)).toEqual([403]);
  });
});

describe('a credential with NO scopes bootstraps on its identity alone, and can do nothing else', () => {
  let BARE: { credentialId: string; token: string };

  beforeAll(async () => {
    // issueCredential is the only issuance path that admits an EMPTY set (the
    // approval path refuses one), so the zero-scope credential is issued on the
    // Connector principal through the service. Pinned to mcp: its only surface.
    const issued = await principalService.issueCredential(
      { principalId: CONNECTOR.principalId, scopes: [], transport: 'mcp', label: `b9-bare-${tag()}` },
      { handle: 'b9-bootstrap-drill-fixture', authMethod: 'system' },
    );
    BARE = { credentialId: issued.credentialId, token: issued.fullKey };
  });

  it('compiles its own session brief: 200, recorded, and nothing enclosed', async () => {
    const mark = dispatched.length;
    const brief = await mcpCall(BARE.token, 'relayhall_brief_compile', { session: true });
    expect(answersSince(mark, 'POST', /^\/principals\/me\/brief$/)).toEqual([200]);
    expect(mcpFailed(brief)).toBe(false);
    const text = mcpText(brief);
    expect(await bootstrapRows(BARE.credentialId)).toBe(1);
    expect(text).toContain(CONNECTOR.principalId);
    expect(text).toContain('What this Brief encloses');
    expect(text).toContain('No Skill is listed');
    expect(text).not.toContain(TASK_TITLE);
    // No registry, Task or Personality read was made on its behalf.
    expect(answersSince(mark, 'GET', /^\/skills/)).toEqual([]);
  });

  // Arguments are THUNKS: the table is built when the file is collected,
  // before beforeAll has created the Task it names.
  it.each([
    ['relayhall_task_list', () => ({}), 'GET', /^\/tasks$/],
    ['relayhall_task_get', () => ({ task: TASK_ID }), 'GET', /^\/tasks\//],
    ['relayhall_task_claim', () => ({ task: TASK_ID }), 'POST', /\/claim$/],
    ['relayhall_report_search', () => ({ q: 'B9' }), 'GET', /^\/reports/],
    ['relayhall_principal_list', () => ({}), 'GET', /^\/principals$/],
    ['relayhall_skill_list', () => ({}), 'GET', /^\/skills/],
  ])('%s is refused by the route ceiling - bootstrapped, but not authorized', async (tool, args, method, route) => {
    const mark = dispatched.length;
    const answer = await mcpCall(BARE.token, tool as string, (args as () => Record<string, unknown>)());
    expect(mcpFailed(answer)).toBe(true);
    expect(mcpText(answer)).not.toContain(BOOTSTRAP_REFUSAL_MARKER);
    expect(answersSince(mark, method as string, route as RegExp)).toEqual([403]);
  });
});

describe('a Task-bound credential whose scopes admit no content is told its Task id and nothing of it', () => {
  it('reports:read alone: the Brief names the bound id, withholds the Task, and the Task stays unreadable', async () => {
    const agent = await mintThroughApproval(['reports:read']);
    const mark = dispatched.length;
    const brief = await mcpCall(agent.token, 'relayhall_brief_compile', { session: true });
    expect(answersSince(mark, 'POST', /^\/principals\/me\/brief$/)).toEqual([200]);
    const text = mcpText(brief);
    expect(text).toContain(TASK_ID);
    expect(text).toContain('"readableByYourScopes": false');
    expect(text).toContain('What this Brief encloses');
    expect(text).not.toContain(TASK_TITLE);
    expect(text).not.toContain('Attached reports');
    const read = await mcpCall(agent.token, 'relayhall_task_get', { task: TASK_ID });
    expect(mcpFailed(read)).toBe(true);
    expect(mcpText(read)).not.toContain(TASK_TITLE);
  });
});

describe('bootstrapping grants no object authority: a four-scope Agent approved with only a READ rule is refused at the claim', () => {
  it('bootstraps (200), and its claim is then refused 403 by object authority, not by the gate', async () => {
    // Its own Task: a second write-capable Agent on TASK_ID would be refused at
    // collect by the one-writer slot, which is a different control.
    const taskId = await armedTask(`B9 READ-RULE TASK ${tag()}`);
    // Card c334177b: an EMPTY rule list now reads as the bound Task, so the
    // Agent that holds no write authority is the one whose approval NAMES a
    // read-only rule - a non-empty list is read exactly as stored.
    const readOnly = [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [taskId], verbs: ['read'] }];
    const agent = await mintThroughApproval(FOUR_SCOPES, readOnly, taskId);
    const own = await pool.query('SELECT own_expression FROM principals WHERE id = $1', [agent.principalId]);
    expect(own.rows[0].own_expression.objects).toEqual(readOnly);

    const mark = dispatched.length;
    await mcpCall(agent.token, 'relayhall_brief_compile', { session: true });
    expect(answersSince(mark, 'POST', /^\/principals\/me\/brief$/)).toEqual([200]);
    expect(await bootstrapRows(agent.credentialId)).toBe(1);

    const claimMark = dispatched.length;
    const claimed = await mcpCall(agent.token, 'relayhall_task_claim', { task: taskId });
    expect(mcpFailed(claimed)).toBe(true);
    expect(mcpText(claimed)).not.toContain(BOOTSTRAP_REFUSAL_MARKER);
    expect(mcpText(claimed)).not.toContain('principals:read');
    expect(answersSince(claimMark, 'POST', new RegExp(`^/tasks/${taskId}/claim$`))).toEqual([403]);
    expect((await taskRow(taskId)).owner_principal_id).toBeNull();
  });
});
