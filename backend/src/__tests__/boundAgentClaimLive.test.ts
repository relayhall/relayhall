/**
 * Card c334177b: an Agent minted with NO object rules works its bound Task.
 *
 * Reproduced on production 2026-10-09 15:48-15:49 UTC (receipt on cdc724b9):
 * an owner-approved, task-scoped Agent - tasks:read, tasks:write, reports:read,
 * reports:write; the Connector's request carried no object rule and the owner
 * approved it unchanged, so approvedRules was [] - bootstrapped, and was then
 * refused 403 "This identity is not authorized for the requested resource" at
 * relayhall_task_claim, relayhall_task_move and relayhall_task_report_save on
 * the one Task it was minted for. Its stored own() object list was empty, and
 * an empty list made the Agent's side of the chain intersection FALSE for every
 * Task act - while the approval panel told its approver "None - the agent works
 * purely through its bound-task role".
 *
 * The repair is read-time only (`ownObjectsFor`): a non-legacy Agent whose
 * stored own() object list is EMPTY is read as holding exactly one rule,
 * `exact` read+write on its bound Task, INSIDE the chain intersection. This
 * suite proves it over a REAL PostgreSQL and the PRODUCTION router, with the
 * MCP ingress mounted the way `server.ts` mounts it:
 *
 *   - the Connector is registered through the owner's `POST /services` wizard
 *     path and the Agent is minted through the REAL approval path - Connector
 *     request with NO `requestedRules` field, owner approval under a password
 *     step-up, Connector collect - so the stored rows are the board's own:
 *     the request, the approval and the Agent's own() all list no rule;
 *   - over MCP `tools/call`, with nothing but its bearer: bootstrap 200, claim
 *     200, move to in-progress 200, draft progress Report 201, finish 200. The
 *     REST status behind every tool call is recorded at the in-process
 *     dispatch seam, so each number is measured, not inferred;
 *   - the session mint path (the Access manager's "Mint an agent" form, which
 *     sends no rules) works its bound Task the same way.
 *
 * And the negative controls:
 *   - the Agent cannot claim, move, report on or edit ANY other Task - a
 *     same-Project sibling and an unrelated owner Task, both armed and both
 *     writable by its parent Account - and the production predicate, asked
 *     about EVERY Task in the database, admits exactly its bound Task for
 *     every write-class act and nothing for verify, shepherd or admin;
 *   - a zero-rule Agent bound to Task A gains nothing on Task B, not even a
 *     read;
 *   - an explicitly narrowed approval still narrows: unticking tasks:write
 *     refuses the claim at the route ceiling, and an approval narrowed to a
 *     read-only rule on the bound Task is read as written - refused 403 at the
 *     claim by object authority;
 *   - the default adds nothing the parent chain does not hold: when the
 *     Connector's own() cap stops covering the Task, the rule-less Agent's
 *     claim is refused, live.
 *
 * RED PROOF: against main's `AuthorizationService.ts` and
 * `ExplicitTaskActionCaps.ts` the first failing assertion is the claim
 * (403, owner unset), exactly the production receipt.
 *
 * DESTRUCTIVE: writes principals, credentials, services, approvals, projects,
 * tasks, reports, bootstrap records and audit rows. It refuses any deployment
 * database and any non-local host, and FAILS - never skips - without a
 * disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the bound-Agent claim drill measures stored approval, credential, '
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
  throw new Error('Bound-Agent claim drill refuses a non-disposable database target');
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
const { stepUpService } = require('../services/StepUpService');
const { delegationService } = require('../services/DelegationService');
const { warrantService } = require('../services/WarrantService');
const { principalService } = require('../services/PrincipalService');
const { agentLifecycleService } = require('../services/AgentLifecycleService');
const { authorizationRepository } = require('../services/AuthorizationRepository');
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
const key = (label: string): string => `b10-${label}-${crypto.randomUUID()}`;
const parseJson = (value: unknown): any => (typeof value === 'string' ? JSON.parse(value) : value);

// ─────────────────────────────── fixtures ────────────────────────────────────

const FOUR_SCOPES = ['tasks:read', 'tasks:write', 'reports:read', 'reports:write'];

let OWNER: Caller;
let CONNECTOR: Caller;
let PROJECT_ID: string;

async function makeAccount(role: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $1, 'active', $2) RETURNING id`,
    [`b10-owner-${tag()}`, role],
  );
  return String(result.rows[0].id);
}

async function sessionFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

/** A Connector registered through the owner's wizard path, carrying the four scopes it will delegate. */
async function registerConnector(owner: Caller): Promise<Caller> {
  const slug = `b10-connector-${tag()}`;
  const registered = await call(owner, 'POST', '/services', {
    slug, name: slug, description: 'Bound-Agent claim drill connector.', kind: 'connector',
    issueCredential: { scopes: FOUR_SCOPES, label: slug, transport: 'api' },
  });
  expect(registered.status).toBe(201);
  const row = await pool.query('SELECT principal_id FROM services WHERE slug = $1', [slug]);
  return {
    label: slug, principalId: String(row.rows[0].principal_id),
    headers: { Authorization: `Bearer ${registered.json.onboarding.credential.secretOnce}` },
  };
}

interface Minted { principalId: string; credentialId: string; token: string; approvalId: string }

/**
 * Mint an Agent through the REAL approval path: the Connector requests, the
 * owner approves under a step-up (optionally editing the authority DOWN), the
 * Connector collects.
 *
 * The step-up token is minted through the service: `/auth/step-up` re-enters a
 * password these fixture Accounts do not have, and it performs no authority
 * check on its target, so the service mint is the faithful stand-in for an
 * owner who has just re-entered their own password (the mintTargetAuthorization
 * and 1118fefa precedent). Everything else is the route.
 */
async function mintThroughApproval(targetTaskId: string, options: {
  scopes?: string[];
  requestedRules?: unknown[];
  editedScopes?: string[];
  editedRules?: unknown[];
  role?: 'implementer' | 'verifier' | 'shepherd';
  connector?: Caller;
} = {}): Promise<Minted> {
  const connector = options.connector ?? CONNECTOR;
  const scopes = options.scopes ?? FOUR_SCOPES;
  const requested = await call(connector, 'POST', '/delegation/agent-mints',
    // No rules is an ABSENT field, as a stock client sends it.
    { targetTaskId, requestedScopes: scopes, via: 'approval',
      ...(options.role ? { role: options.role } : {}),
      ...(options.requestedRules ? { requestedRules: options.requestedRules } : {}) },
    { 'Idempotency-Key': key('request') });
  expect([requested.status, requested.json?.path, requested.json?.code]).toEqual([202, 'approval', undefined]);
  const approvalId = String(requested.json.approval.id);

  const stepUp = await stepUpService.mint(OWNER.principalId, 'approval.decide', approvalId, 'password');
  const approved = await call(OWNER, 'POST', `/approvals/${approvalId}/approve`, {
    stepUpToken: stepUp.token,
    ...(options.editedScopes ? { editedScopes: options.editedScopes } : {}),
    ...(options.editedRules ? { editedRules: options.editedRules } : {}),
  });
  expect([approved.status, approved.json?.approval?.status]).toEqual([200, 'approved']);

  const collected = await call(connector, 'POST', `/delegation/agent-mints/${approvalId}/collect`, {},
    { 'Idempotency-Key': key('collect') });
  expect(collected.status).toBe(201);
  const pack = collected.json.pack;
  const credential = await pool.query(
    'SELECT c.principal_id, c.scopes, p.kind, p.bound_task_id FROM principal_credentials c JOIN principals p ON p.id = c.principal_id WHERE c.id = $1',
    [pack.credentialId],
  );
  expect(credential.rows).toHaveLength(1);
  expect(credential.rows[0].kind).toBe('agent');
  expect(String(credential.rows[0].bound_task_id)).toBe(targetTaskId);
  expect([...parseJson(credential.rows[0].scopes)].sort()).toEqual([...(options.editedScopes ?? scopes)].sort());
  return {
    principalId: String(credential.rows[0].principal_id), credentialId: String(pack.credentialId),
    token: String(pack.secretOnce), approvalId,
  };
}

async function taskRow(taskId: string): Promise<{ status: string; owner_principal_id: string | null; title: string }> {
  const result = await pool.query('SELECT status, owner_principal_id, title FROM tasks WHERE id = $1', [taskId]);
  return result.rows[0];
}

async function reportCount(taskId: string): Promise<number> {
  const result = await pool.query('SELECT COUNT(*)::int AS n FROM reports WHERE source_task_id = $1', [taskId]);
  return Number(result.rows[0].n);
}

async function ownObjects(principalId: string): Promise<unknown> {
  const result = await pool.query('SELECT own_expression FROM principals WHERE id = $1', [principalId]);
  return parseJson(result.rows[0].own_expression).objects;
}

/** An owner-created Task, armed through the owner's own routes; in the drill Project unless told otherwise. */
async function armedTask(title: string, inProject = true): Promise<string> {
  const created = await call(OWNER, 'POST', '/tasks', {
    title, description: 'bound-Agent claim drill', status: 'todo', ...(inProject ? { project: PROJECT_ID } : {}),
  });
  expect(created.status).toBe(201);
  const id = String(created.json?.task?.id);
  const armed = await call(OWNER, 'PATCH', `/tasks/${id}`, { autoStart: true }, { 'Idempotency-Key': key('arm') });
  expect(armed.status).toBe(200);
  return id;
}

/** The actor the auth middleware builds for this Agent's bearer, from the LIVE chain. */
async function agentActor(principalId: string): Promise<any> {
  const chain = await delegationService.resolveChain(principalId);
  expect(chain.alive).toBe(true);
  return {
    principalId, handle: 'b10-agent', role: null, scopes: FOUR_SCOPES, authenticated: true,
    delegation: {
      links: chain.links.map((link: any) => ({
        principalId: link.principalId, kind: link.kind, role: link.role,
        parentPrincipalId: link.parentPrincipalId, boundTaskId: link.boundTaskId,
        legacyIdentity: link.legacyIdentity, ownExpression: link.ownExpression,
      })),
    },
  };
}

async function bootstrap(token: string): Promise<void> {
  const mark = dispatched.length;
  const brief = await mcpCall(token, 'relayhall_brief_compile', { session: true });
  expect(answersSince(mark, 'POST', /^\/principals\/me\/brief$/)).toEqual([200]);
  expect(mcpFailed(brief)).toBe(false);
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

  // The owner: an ordinary Account, signed in, with one Project.
  OWNER = await sessionFor('owner', await makeAccount('user'));
  const project = await call(OWNER, 'POST', '/projects', { name: `B10 drill ${tag()}` });
  expect(project.status).toBe(201);
  PROJECT_ID = String(project.json.project.id);

  // The Connector: registered through the wizard path.
  CONNECTOR = await registerConnector(OWNER);
});

afterAll(async () => {
  jest.restoreAllMocks();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ─────────────────────────────── the drill ───────────────────────────────────

describe('an Agent minted through the approval path with NO object rules works its bound Task (card c334177b)', () => {
  let TASK_A: string;
  let AGENT: Minted;
  let REPORT_ID: string;

  beforeAll(async () => {
    TASK_A = await armedTask(`B10 BOUND TASK ${tag()}`);
    AGENT = await mintThroughApproval(TASK_A);
  });

  it('the premise: the request, the approval and the stored own() all list NO object rule', async () => {
    const approval = await pool.query('SELECT requested_rules, approved_rules FROM approvals WHERE id = $1', [AGENT.approvalId]);
    expect(parseJson(approval.rows[0].requested_rules)).toEqual([]);
    expect(parseJson(approval.rows[0].approved_rules)).toEqual([]);
    // The default is read-time only: the stored expression is never rewritten.
    expect(await ownObjects(AGENT.principalId)).toEqual([]);
    expect((await taskRow(TASK_A)).owner_principal_id).toBeNull();
  });

  it('bootstraps: 200', async () => {
    await bootstrap(AGENT.token);
  });

  it('claims its bound Task: 200, and it is the Assignee', async () => {
    const mark = dispatched.length;
    const claimed = await mcpCall(AGENT.token, 'relayhall_task_claim', { task: TASK_A });
    expect(answersSince(mark, 'POST', new RegExp(`^/tasks/${TASK_A}/claim$`))).toEqual([200]);
    expect([mcpFailed(claimed), mcpText(claimed).slice(0, 200)]).toEqual([false, expect.stringContaining('You are the Assignee')]);
    expect((await taskRow(TASK_A)).owner_principal_id).toBe(AGENT.principalId);
  });

  it('moves it to in-progress: 200', async () => {
    const mark = dispatched.length;
    const moved = await mcpCall(AGENT.token, 'relayhall_task_move', { task: TASK_A, status: 'in-progress' });
    expect(answersSince(mark, 'PATCH', new RegExp(`^/tasks/${TASK_A}$`))).toEqual([200]);
    expect([mcpFailed(moved), mcpText(moved)]).toEqual([false, expect.stringContaining('in-progress')]);
    expect((await taskRow(TASK_A)).status).toBe('in-progress');
  });

  it('saves a draft progress Report: 201', async () => {
    const mark = dispatched.length;
    const saved = await mcpCall(AGENT.token, 'relayhall_task_report_save', {
      task: TASK_A, title: 'B10 progress', content: 'Claimed and moved with no object rule.',
      summary: 'bound-Agent claim drill', idempotencyKey: key('report'),
    });
    expect(answersSince(mark, 'POST', new RegExp(`^/tasks/${TASK_A}/reports$`))).toEqual([201]);
    expect(mcpFailed(saved)).toBe(false);
    REPORT_ID = String(JSON.parse(mcpText(saved)).report?.id);
    const row = await pool.query('SELECT source_task_id, author_principal_id FROM reports WHERE id = $1', [REPORT_ID]);
    expect(row.rows).toHaveLength(1);
    expect([String(row.rows[0].source_task_id), String(row.rows[0].author_principal_id)]).toEqual([TASK_A, AGENT.principalId]);
  });

  it('finishes with that Report: 200, and the Task is in Review', async () => {
    const mark = dispatched.length;
    const finished = await mcpCall(AGENT.token, 'relayhall_task_finish',
      { task: TASK_A, reportId: REPORT_ID, handover: 'Bound-Agent claim drill: claim, move, report, finish with no object rule.' });
    expect(answersSince(mark, 'POST', new RegExp(`^/tasks/${TASK_A}/finish$`))).toEqual([200]);
    expect([mcpFailed(finished), mcpText(finished).slice(0, 200)]).toEqual([false, expect.stringContaining('finished to Review')]);
    expect((await taskRow(TASK_A)).status).toBe('review');
  });

  describe('the default never leaves the bound Task: a zero-rule Agent bound to Task A gains nothing on Task B', () => {
    let SIBLING: string;
    let UNRELATED: string;

    beforeAll(async () => {
      // Both armed, both owned and writable by the Agent's parent Account, so
      // nothing but the Agent's own side of the intersection can refuse them.
      SIBLING = await armedTask(`B10 SAME-PROJECT SIBLING ${tag()}`);
      UNRELATED = await armedTask(`B10 UNRELATED TASK ${tag()}`, false);
    });

    // Arguments are THUNKS: the table is built when the file is collected,
    // before beforeAll has created the Tasks it names.
    const ACTS: Array<[string, (task: string) => Record<string, unknown>, string, (task: string) => RegExp]> = [
      ['relayhall_task_claim', (task) => ({ task }), 'POST', (task) => new RegExp(`^/tasks/${task}/claim$`)],
      ['relayhall_task_move', (task) => ({ task, status: 'in-progress' }), 'PATCH', (task) => new RegExp(`^/tasks/${task}$`)],
      ['relayhall_task_report_save', (task) => ({ task, title: 'B10 stray', content: 'must not land', summary: 'stray', idempotencyKey: key('stray') }),
        'POST', (task) => new RegExp(`^/tasks/${task}/reports$`)],
      ['relayhall_task_update', (task) => ({ task, title: 'B10 rewritten by a stray Agent' }), 'PATCH', (task) => new RegExp(`^/tasks/${task}$`)],
      ['relayhall_task_get', (task) => ({ task }), 'GET', (task) => new RegExp(`^/tasks/${task}$`)],
    ];

    it.each(['sibling', 'unrelated'])('on the %s Task: every act is refused (concealed 404) and nothing changes', async (which) => {
      const task = which === 'sibling' ? SIBLING : UNRELATED;
      const before = await taskRow(task);
      for (const [tool, args, method, route] of ACTS) {
        const mark = dispatched.length;
        const answer = await mcpCall(AGENT.token, tool, args(task));
        expect([tool, mcpFailed(answer)]).toEqual([tool, true]);
        expect([tool, mcpText(answer).includes(BOOTSTRAP_REFUSAL_MARKER)]).toEqual([tool, false]);
        // Unreadable to it, so absent to it: the 44d1bf89 concealment, on every verb.
        expect([tool, answersSince(mark, method, route(task))]).toEqual([tool, [404]]);
      }
      expect(await taskRow(task)).toEqual({ ...before });
      expect(before.owner_principal_id).toBeNull();
      expect(await reportCount(task)).toBe(0);
    });

    it('the production predicate, asked about EVERY Task in the database, admits exactly the bound Task', async () => {
      const actor = await agentActor(AGENT.principalId);
      const all = (await pool.query('SELECT id::text AS id FROM tasks')).rows.map((row: any) => String(row.id));
      expect(all).toEqual(expect.arrayContaining([TASK_A, SIBLING, UNRELATED]));
      // Not vacuous: the Agent's PARENT, the Connector acting for the same
      // Account, may write all three - so on the other two nothing but the
      // Agent's own side of the intersection can be refusing.
      const parent = { ...(await agentActor(CONNECTOR.principalId)), handle: 'b10-connector' };
      const parentWrites = await authorizationRepository.authorizedIds(parent, 'task', all, 'write');
      expect([TASK_A, SIBLING, UNRELATED].every((id) => parentWrites.has(id))).toBe(true);
      for (const action of ['read', 'write', 'claim', 'finish', 'release']) {
        const allowed = await authorizationRepository.authorizedIds(actor, 'task', all, action);
        expect([action, [...allowed]]).toEqual([action, [TASK_A]]);
      }
      // `write` never maps to the Verifier's, the Shepherd's or the admin act.
      for (const action of ['verify', 'shepherd', 'admin']) {
        const allowed = await authorizationRepository.authorizedIds(actor, 'task', all, action);
        expect([action, [...allowed]]).toEqual([action, []]);
      }
    });
  });
});

describe('the session mint path (the Access manager form sends no rules) works its bound Task', () => {
  it('session mint with no rules: 201; then bootstrap, claim 200 and move 200', async () => {
    const taskId = await armedTask(`B10 SESSION-MINT TASK ${tag()}`);
    const stepUp = await stepUpService.mint(OWNER.principalId, 'agent.mint', taskId, 'password');
    const minted = await call(OWNER, 'POST', '/delegation/agent-mints',
      { targetTaskId: taskId, requestedScopes: FOUR_SCOPES, stepUpToken: stepUp.token },
      { 'Idempotency-Key': key('session-mint') });
    expect([minted.status, minted.json?.path]).toEqual([201, 'session']);
    const token = String(minted.json.pack.secretOnce);
    const principal = await pool.query('SELECT principal_id FROM principal_credentials WHERE id = $1', [minted.json.pack.credentialId]);
    const agentId = String(principal.rows[0].principal_id);
    expect(await ownObjects(agentId)).toEqual([]);

    await bootstrap(token);
    let mark = dispatched.length;
    await mcpCall(token, 'relayhall_task_claim', { task: taskId });
    expect(answersSince(mark, 'POST', new RegExp(`^/tasks/${taskId}/claim$`))).toEqual([200]);
    expect((await taskRow(taskId)).owner_principal_id).toBe(agentId);
    mark = dispatched.length;
    await mcpCall(token, 'relayhall_task_move', { task: taskId, status: 'in-progress' });
    expect(answersSince(mark, 'PATCH', new RegExp(`^/tasks/${taskId}$`))).toEqual([200]);
    expect((await taskRow(taskId)).status).toBe('in-progress');
  });
});

describe('an explicitly narrowed approval still narrows', () => {
  it('tasks:write unticked at approval: bootstraps, and the claim is refused 403 at the route ceiling naming tasks:write', async () => {
    const taskId = await armedTask(`B10 NARROWED-SCOPES TASK ${tag()}`);
    const agent = await mintThroughApproval(taskId, { role: 'verifier',
      editedScopes: ['tasks:read', 'reports:read', 'reports:write'] });
    expect(await ownObjects(agent.principalId)).toEqual([]);
    await bootstrap(agent.token);
    const mark = dispatched.length;
    const claimed = await mcpCall(agent.token, 'relayhall_task_claim', { task: taskId });
    expect(mcpFailed(claimed)).toBe(true);
    expect(mcpText(claimed)).toContain('tasks:write');
    expect(answersSince(mark, 'POST', new RegExp(`^/tasks/${taskId}/claim$`))).toEqual([403]);
    expect((await taskRow(taskId)).owner_principal_id).toBeNull();
  });

  it('rules narrowed to read-only on the bound Task: read as written, and the claim is refused 403 by object authority', async () => {
    const taskId = await armedTask(`B10 NARROWED-RULES TASK ${tag()}`);
    const readWrite = [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [taskId], verbs: ['read', 'write'] }];
    const readOnly = [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [taskId], verbs: ['read'] }];
    const agent = await mintThroughApproval(taskId, { requestedRules: readWrite, editedRules: readOnly });
    expect(await ownObjects(agent.principalId)).toEqual(readOnly);
    await bootstrap(agent.token);
    // It can read its Task (AZ-19 and its own read rule)...
    let mark = dispatched.length;
    const read = await mcpCall(agent.token, 'relayhall_task_get', { task: taskId });
    expect(mcpFailed(read)).toBe(false);
    expect(answersSince(mark, 'GET', new RegExp(`^/tasks/${taskId}$`))).toEqual([200]);
    // ...and it cannot claim it: a non-empty list is never defaulted.
    mark = dispatched.length;
    const claimed = await mcpCall(agent.token, 'relayhall_task_claim', { task: taskId });
    expect(mcpFailed(claimed)).toBe(true);
    expect(mcpText(claimed)).not.toContain(BOOTSTRAP_REFUSAL_MARKER);
    expect(mcpText(claimed)).not.toContain('tasks:write');
    expect(answersSince(mark, 'POST', new RegExp(`^/tasks/${taskId}/claim$`))).toEqual([403]);
    expect((await taskRow(taskId)).owner_principal_id).toBeNull();
  });
});

describe('AZ-A10 role-bound verifier Agent', () => {
  it('files an ordinary verdict Report and rejects its own bound Task after an independent handoff', async () => {
    const taskId = await armedTask(`A10 VERDICT ${tag()}`);
    const implementer = await mintThroughApproval(taskId);
    const verifier = await mintThroughApproval(taskId, { role: 'verifier' });
    expect((await call(OWNER, 'PATCH', `/tasks/${taskId}/roles`,
      { verifierPrincipalId: verifier.principalId })).status).toBe(200);
    await bootstrap(implementer.token);
    await bootstrap(verifier.token);
    expect(mcpFailed(await mcpCall(implementer.token, 'relayhall_task_claim', { task: taskId }))).toBe(false);
    expect(mcpFailed(await mcpCall(implementer.token, 'relayhall_task_move',
      { task: taskId, status: 'in-progress' }))).toBe(false);
    const report = await mcpCall(implementer.token, 'relayhall_task_report_save', {
      task: taskId, title: 'A10 implementer handoff', content: 'Work submitted for independent verification.',
      idempotencyKey: key('handoff-report'),
    });
    expect(mcpFailed(report)).toBe(false);
    const reportId = String(JSON.parse(mcpText(report)).report?.id);
    expect(mcpFailed(await mcpCall(implementer.token, 'relayhall_task_finish', {
      task: taskId, reportId, handover: 'A10 independent verification drill',
    }))).toBe(false);
    expect((await taskRow(taskId)).status).toBe('review');
    const verdictReport = await mcpCall(verifier.token, 'relayhall_report_create', {
      title: 'A10 verifier verdict', content: 'Independent rejection evidence.',
      taskIds: [taskId], idempotencyKey: key('verdict-report'),
    });
    expect(mcpFailed(verdictReport)).toBe(false);
    const rejected = await call({ label: 'verifier', principalId: verifier.principalId,
      headers: { Authorization: `Bearer ${verifier.token}` } },
    'POST', `/tasks/reviewer/${taskId}/reject`, { reason: 'Independent verifier rejected this fixture task.' });
    expect([rejected.status, rejected.json?.code]).toEqual([200, undefined]);
    expect((await taskRow(taskId)).status).not.toBe('review');
  });

  it('keeps its role link at the credential expiry through lease renewal, then reaps it on revoke', async () => {
    const taskId = await armedTask(`A10 ROLE LIFECYCLE ${tag()}`);
    const agent = await mintThroughApproval(taskId, { role: 'verifier' });
    const links = async () => (await pool.query(
      `SELECT l.expires_at FROM access_vehicle_links l WHERE l.task_id = $1
        AND l.vehicle_kind = 'role' AND l.role = 'verifier'
        AND l.landed_on_principal_id = $2`, [taskId, agent.principalId],
    )).rows;
    const firstExpiry = (await pool.query('SELECT expires_at FROM principal_credentials WHERE id = $1',
      [agent.credentialId])).rows[0].expires_at;
    expect((await links()).length).toBeGreaterThan(0);
    expect((await links()).every((row: any) => +new Date(row.expires_at) === +new Date(firstExpiry))).toBe(true);
    const earlier = new Date(Date.now() + 3600_000);
    await pool.query('UPDATE principal_credentials SET expires_at = $2 WHERE id = $1', [agent.credentialId, earlier]);
    const renewed = await agentLifecycleService.extendOnLeaseRenewal(agent.principalId, taskId,
      { handle: 'p2b-fixture', authMethod: 'system' });
    expect(renewed.extended).toBe(true);
    const renewedExpiry = (await pool.query('SELECT expires_at FROM principal_credentials WHERE id = $1',
      [agent.credentialId])).rows[0].expires_at;
    expect(+new Date(renewedExpiry)).toBeGreaterThan(+earlier);
    expect((await links()).every((row: any) => +new Date(row.expires_at) === +new Date(renewedExpiry))).toBe(true);
    expect(await principalService.revokeCredentialById(agent.credentialId, 'p2b test revoke')).toBe(true);
    expect(await links()).toHaveLength(0);
  });

  it('reaps a disabled role holder without removing a sibling holder', async () => {
    const taskId = await armedTask(`A10 ROLE DISABLE ${tag()}`);
    const first = await mintThroughApproval(taskId, { role: 'verifier' });
    const second = await mintThroughApproval(taskId, { role: 'verifier' });
    await principalService.updatePrincipal(first.principalId, { status: 'disabled' });
    const links = await pool.query(
      `SELECT DISTINCT landed_on_principal_id FROM access_vehicle_links
        WHERE task_id = $1 AND vehicle_kind = 'role' AND role = 'verifier'`, [taskId],
    );
    expect(links.rows.map((row: any) => String(row.landed_on_principal_id))).toEqual([second.principalId]);
  });

  it('coexists with the implementer slot, keeps read rows, and reaches only its own verdict route', async () => {
    const taskId = await armedTask(`A10 VERIFIER TASK ${tag()}`);
    const implementer = await mintThroughApproval(taskId);
    const verifier = await mintThroughApproval(taskId, { role: 'verifier' });
    const roles = await pool.query(
      'SELECT id, bound_task_role FROM principals WHERE id = ANY($1::uuid[])',
      [[implementer.principalId, verifier.principalId]],
    );
    expect(new Map(roles.rows.map((row: any) => [String(row.id), row.bound_task_role]))).toEqual(
      new Map([[implementer.principalId, 'implementer'], [verifier.principalId, 'verifier']]),
    );
    const verifierRows = await pool.query(
      `SELECT g.verb FROM grants g JOIN access_vehicle_links l ON l.target_id = g.id
        WHERE l.task_id = $1 AND l.vehicle_kind = 'role' AND l.role = 'verifier'
          AND l.landed_on_principal_id = $2 AND g.resource_type = 'task' AND g.resource_id = $1`,
      [taskId, verifier.principalId],
    );
    expect(verifierRows.rows.map((row: any) => row.verb)).toEqual(['read']);
    const assigned = await call(OWNER, 'PATCH', `/tasks/${taskId}/roles`,
      { verifierPrincipalId: verifier.principalId });
    expect(assigned.status).toBe(200);
    await bootstrap(verifier.token);
    expect((await call({ label: 'verifier', principalId: verifier.principalId,
      headers: { Authorization: `Bearer ${verifier.token}` } }, 'GET', `/tasks/${taskId}`)).status).toBe(200);
    const asVerifier = { label: 'verifier', principalId: verifier.principalId,
      headers: { Authorization: `Bearer ${verifier.token}` } };
    for (const [method, path, body] of [
      ['POST', `/tasks/${taskId}/claim`, {}],
      ['PATCH', `/tasks/${taskId}`, { description: 'must refuse' }],
      ['POST', `/tasks/${taskId}/native-reviews`, {}],
    ] as const) {
      const refused = await call(asVerifier, method, path, body);
      expect([refused.status, refused.json?.code]).toEqual([403, 'VERIFIER_ACT_CAP']);
    }
    const verdictDoor = await call(asVerifier, 'POST', `/tasks/reviewer/${taskId}/reject`,
      { reason: 'test review status guard' });
    expect(verdictDoor.json?.code).not.toBe('VERIFIER_ACT_CAP');
    expect(verdictDoor.status).not.toBe(404);
  });

  it('warrant mint checks derived exact role rows against a project-pinned ceiling', async () => {
    const taskId = await armedTask(`A10 WARRANT ROLE ${tag()}`);
    const adminId = await makeAccount('admin');
    const creator = { principalId: adminId, isRoot: true,
      stepUp: { tokenId: 'fixture', method: 'password' } };
    const audit = { principalId: adminId, handle: 'p2b-fixture', authMethod: 'system' };
    const ceilingRules = [
      { resourceType: 'task', selectorForm: 'all-in-project', selectorIds: [PROJECT_ID], verbs: ['read', 'write'] },
      { resourceType: 'phase', selectorForm: 'all-in-project', selectorIds: [PROJECT_ID], verbs: ['read'] },
    ];
    const good = await warrantService.create({
      name: `A10 project ceiling ${tag()}`, holderPrincipalId: CONNECTOR.principalId,
      anchors: [{ anchorType: 'task', anchorId: taskId }], ceilingRules,
      ceilingScopes: FOUR_SCOPES, expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }, creator, audit);
    const goodMint = await call(CONNECTOR, 'POST', '/delegation/agent-mints', {
      targetTaskId: taskId, via: 'warrant', warrantId: good.id, role: 'verifier',
      requestedScopes: FOUR_SCOPES, requestedRules: [],
    }, { 'Idempotency-Key': key('warrant-role') });
    expect([goodMint.status, goodMint.json?.code, goodMint.json?.path, goodMint.json?.pack?.role]).toEqual([201, undefined, 'warrant', 'verifier']);
    const bad = await warrantService.create({
      name: `A10 read ceiling ${tag()}`, holderPrincipalId: CONNECTOR.principalId,
      anchors: [{ anchorType: 'task', anchorId: taskId }],
      ceilingRules: ceilingRules.map((rule) => ({ ...rule, verbs: ['read'] })),
      ceilingScopes: FOUR_SCOPES, expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }, creator, audit);
    const before = Number((await pool.query('SELECT COUNT(*)::int AS n FROM principals WHERE kind = $1', ['agent'])).rows[0].n);
    const denied = await call(CONNECTOR, 'POST', '/delegation/agent-mints', {
      targetTaskId: taskId, via: 'warrant', warrantId: bad.id, role: 'implementer',
      requestedScopes: FOUR_SCOPES, requestedRules: [],
    }, { 'Idempotency-Key': key('warrant-ceiling') });
    expect([denied.status, denied.json?.code]).toEqual([403, 'CEILING_EXCEEDED']);
    expect(Number((await pool.query('SELECT COUNT(*)::int AS n FROM principals WHERE kind = $1', ['agent'])).rows[0].n)).toBe(before);
    expect((await warrantService.get(bad.id)).mintedTotal).toBe(0);
  });

  it('keeps a warrant-minted Agent inside its pinned ceiling when reports are linked later', async () => {
    const taskId = await armedTask(`A10 LATER REPORT CEILING ${tag()}`);
    const makeReport = async (label: string) => {
      const created = await call(OWNER, 'POST', '/reports', {
        title: `${label} ${tag()}`, content: 'A later linked report.', task_ids: [],
      });
      expect(created.status).toBe(201);
      return String(created.json.report.id);
    };
    const outside = await makeReport('outside ceiling');
    const inside = await makeReport('inside ceiling');
    const adminId = await makeAccount('admin');
    const warrant = await warrantService.create({
      name: `A10 later ceiling ${tag()}`, holderPrincipalId: CONNECTOR.principalId,
      anchors: [{ anchorType: 'task', anchorId: taskId }],
      ceilingRules: [
        { resourceType: 'task', selectorForm: 'all-in-project', selectorIds: [PROJECT_ID], verbs: ['read', 'write'] },
        { resourceType: 'report', selectorForm: 'exact', selectorIds: [inside], verbs: ['read'] },
      ],
      ceilingScopes: FOUR_SCOPES, expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }, { principalId: adminId, isRoot: true, stepUp: { tokenId: 'fixture', method: 'password' } },
    { principalId: adminId, handle: 'p2b-fixture', authMethod: 'system' });
    const minted = await call(CONNECTOR, 'POST', '/delegation/agent-mints', {
      targetTaskId: taskId, via: 'warrant', warrantId: warrant.id, role: 'verifier',
      requestedScopes: FOUR_SCOPES, requestedRules: [],
    }, { 'Idempotency-Key': key('warrant-later-reference') });
    expect(minted.status).toBe(201);
    const agentId = String(minted.json.pack.principalId);
    const agent: Caller = { label: 'warrant-agent', principalId: agentId,
      headers: { Authorization: `Bearer ${minted.json.pack.secretOnce}` } };
    const linked = async (reportId: string) => call(OWNER, 'POST', `/tasks/${taskId}/references`,
      { kind: 'report', targetId: reportId, label: `later ${reportId}` });
    expect((await linked(outside)).status).toBe(201);
    const outsideRows = await pool.query(
      `SELECT g.id FROM grants g JOIN access_vehicle_links l ON l.target_id = g.id
        WHERE l.task_id = $1 AND l.vehicle_kind = 'role' AND l.landed_on_principal_id = $2
          AND g.resource_type = 'report' AND g.resource_id = $3`, [taskId, agentId, outside]);
    expect(outsideRows.rows).toHaveLength(0);
    expect((await call(agent, 'GET', `/reports/${outside}`)).status).toBe(404);
    const skipped = await pool.query(
      `SELECT metadata FROM audit_events WHERE action = 'grant.reference_skipped'
        AND resource_type = 'report' AND resource_id = $1 ORDER BY occurred_at DESC LIMIT 1`, [outside]);
    expect(skipped.rows[0]?.metadata?.reason).toContain('pinned warrant ceiling');

    expect((await linked(inside)).status).toBe(201);
    const allowed = await pool.query(
      `SELECT g.granted_by_principal_id FROM grants g JOIN access_vehicle_links l ON l.target_id = g.id
        WHERE l.task_id = $1 AND l.vehicle_kind = 'role' AND l.landed_on_principal_id = $2
          AND g.resource_type = 'report' AND g.resource_id = $3`, [taskId, agentId, inside]);
    expect(allowed.rows.map((row: any) => String(row.granted_by_principal_id)))
      .toEqual([CONNECTOR.principalId]);
    expect((await call(agent, 'GET', `/reports/${inside}`)).status).toBe(200);
    expect((await call(agent, 'GET', `/reports/${outside}`)).status).toBe(404);
  });
});

describe('the default adds nothing the parent chain does not hold', () => {
  it('a Connector whose own() stops covering the Task takes the rule-less Agent\'s claim with it, live', async () => {
    const connector = await registerConnector(OWNER);
    const taskId = await armedTask(`B10 PARENT-CAP TASK ${tag()}`);
    const agent = await mintThroughApproval(taskId, { connector });
    await bootstrap(agent.token);
    // The owner narrows the Connector's own() to READ on this Task: the
    // principal-level narrowing tool (§5.1), applied here as a fixture write.
    const before = await pool.query('SELECT own_expression FROM principals WHERE id = $1', [connector.principalId]);
    expect(parseJson(before.rows[0].own_expression)).toEqual({ scopes: 'parent', objects: 'parent' });
    await pool.query('UPDATE principals SET own_expression = $2::jsonb WHERE id = $1', [connector.principalId,
      JSON.stringify({ scopes: 'parent', objects: [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [taskId], verbs: ['read'] }] })]);
    const mark = dispatched.length;
    const claimed = await mcpCall(agent.token, 'relayhall_task_claim', { task: taskId });
    expect(mcpFailed(claimed)).toBe(true);
    expect(answersSince(mark, 'POST', new RegExp(`^/tasks/${taskId}/claim$`))).toEqual([403]);
    expect((await taskRow(taskId)).owner_principal_id).toBeNull();
    // Restored, the same credential claims: the refusal above was the cap, nothing else.
    await pool.query('UPDATE principals SET own_expression = $2::jsonb WHERE id = $1',
      [connector.principalId, JSON.stringify({ scopes: 'parent', objects: 'parent' })]);
    const again = dispatched.length;
    await mcpCall(agent.token, 'relayhall_task_claim', { task: taskId });
    expect(answersSince(again, 'POST', new RegExp(`^/tasks/${taskId}/claim$`))).toEqual([200]);
    expect((await taskRow(taskId)).owner_principal_id).toBe(agent.principalId);
  });
});
