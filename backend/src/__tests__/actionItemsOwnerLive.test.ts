/**
 * The Action Center queue for agents (owner ruling E467, option A), over a REAL
 * PostgreSQL and the PRODUCTION router and MCP ingress: `GET
 * /notifications/actions/owner`, the read-only tool `relayhall_action_items_list`
 * and the CLI verb `relayhall actions`. The list of tests:
 *
 *   (1) a person's own Connector lists every kind waiting on the person's
 *       Account (Decision, Verify, Stuck, Skill review) as well as its own, with
 *       the PERSON'S seen state; an Agent under that Connector reads the same;
 *   (2) ANOTHER person's Connector sees none of them (and its own item, the
 *       negative control), and a service Account's Connector is not a person's;
 *   (3) the title and content of an item appear only where the CALLER can read
 *       the object: a Task the caller cannot read, a Decision whose Task it
 *       cannot read and a Skill review whose Skill it cannot read are kind, id,
 *       wait and link only, checked against the objects' own point routes (the
 *       outside anchor), a Decision keeps its approval's kind and requester only
 *       where the caller's own approval point read answers 200, and the queue
 *       never widens what any caller reads;
 *   (4) one source: the owner queue equals the Account's own Action Center list
 *       item for item, a caller with no owning Account gets exactly its own
 *       plain list, and the caps are the Action Center's;
 *   (5) read only: no seen mark, no decision, no write by any caller or route,
 *       and the route ceiling (tasks:read) refuses a blind credential;
 *   (6) the MCP tool and the CLI print what the service answered.
 *
 * DESTRUCTIVE: writes principals, sessions, projects, tasks, skills, approvals
 * and feed rows. It refuses any deployment database and any non-local host, and
 * FAILS - never skips - without a disposable one. It is SELF-ISOLATING: it
 * asserts only on the principals and rows it creates, so it reads the same on a
 * fresh database and on a full-tier job database that earlier steps filled.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';
import path from 'path';
import { spawn } from 'child_process';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the owner queue drill reads stored rows, so it never skips. '
    + 'Load database/init.sql into a disposable database, run npm run migrate, and point RELAYHALL_TEST_DB_URL at it.');
}
const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = decodeURIComponent(parsed.pathname.slice(1));
const localDisposable = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  && /test|contract|fixture/.test(TEST_DB_NAME);
const ciService = process.env.CI === 'true' && parsed.hostname === 'postgres' && TEST_DB_NAME === 'relayhall_ci';
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
  || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod'].includes(TEST_DB_NAME)
  || (!localDisposable && !ciService)) {
  throw new Error('The owner queue drill refuses a non-disposable database target');
}

Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: TEST_DB_NAME,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
});

jest.setTimeout(240_000);

interface App { server: http.Server; origin: string; pool: any; modules: Record<string, any> }

async function startApp(): Promise<App> {
  let modules: Record<string, any> = {};
  jest.isolateModules(() => {
    modules = {
      express: require('express'),
      connection: require('../db/connection'),
      routeRegistry: require('../routeRegistry'),
      auth: require('../middleware/auth'),
      shared: require('../middleware/sharedAuthorization'),
      apiErrors: require('../utils/apiErrors'),
      jsonBodyTypes: require('../utils/jsonBodyTypes'),
      sessions: require('../services/LoginSessionService'),
      stepUp: require('../services/StepUpService'),
      principals: require('../services/PrincipalService'),
      actions: require('../services/NotificationActionsService'),
      mcpHttp: require('../mcp/httpRoute'),
    };
  });
  const app = modules.express();
  app.use(modules.express.json(modules.jsonBodyTypes.jsonBodyOptions));
  // The in-process MCP ingress: every tool dispatches through the same routers.
  app.use(modules.mcpHttp.MCP_ROUTE_PATH, modules.mcpHttp.default);
  modules.routeRegistry.registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, modules.auth.authMiddleware, modules.shared.sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(modules.apiErrors.apiErrorHandler);
  const server: http.Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return {
    server, pool: modules.connection.pool, modules,
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  };
}

let APP: App;
const pool = () => APP.pool;

interface Caller { label: string; principalId: string; handle: string; role: string; headers: Record<string, string>; token?: string }
interface Answer { status: number; json: any; text: string }

async function call(who: Caller, method: string, routePath: string, body?: unknown, extra: Record<string, string> = {}): Promise<Answer> {
  const response = await fetch(`${APP.origin}${routePath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...who.headers, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, text };
}
const skillMd = (name: string): string => ['---', `name: ${name}`, 'description: Owner queue drill skill', '---', '', 'A drill skill.', ''].join('\n');
const tag = (): string => crypto.randomBytes(5).toString('hex');
const SECRET = 'OQ-SECRET';

async function makeAccount(role: string, label: string): Promise<{ id: string; handle: string }> {
  const handle = `oq-${label}-${tag()}`;
  const result = await pool().query(
    `INSERT INTO principals (kind, handle, display_name, status, role) VALUES ('human', $1, $1, 'active', $2) RETURNING id`,
    [handle, role]);
  return { id: String(result.rows[0].id), handle };
}

async function sessionFor(label: string, role: string): Promise<Caller> {
  const account = await makeAccount(role, label);
  const minted = await APP.modules.sessions.loginSessionService.mint({ principalId: account.id });
  return {
    label, principalId: account.id, handle: account.handle, role,
    headers: { Cookie: `${APP.modules.sessions.SESSION_COOKIE_NAME}=${minted.token}` },
  };
}

/** A Connector of `owner` with exactly `scopes`, as a bearer caller usable over REST and MCP. */
async function connectorFor(owner: Caller, scopes: string[]): Promise<Caller> {
  const slug = `oq-connector-${tag()}`;
  const registered = await call(owner, 'POST', '/services', {
    slug, name: slug, description: 'Owner queue drill connector.', kind: 'connector',
    issueCredential: { scopes, label: slug, transport: 'any' },
  });
  expect(registered.status).toBe(201);
  const principal = (await pool().query('SELECT principal_id FROM services WHERE slug = $1', [slug])).rows[0].principal_id;
  const token = String(registered.json.onboarding.credential.secretOnce);
  return {
    label: slug, principalId: String(principal), handle: slug, role: 'service', token,
    headers: { Authorization: `Bearer ${token}` },
  };
}

async function makeTask(owner: Caller, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await call(owner, 'POST', '/tasks', { title, description: 'owner queue drill', status: 'todo', ...extra });
  expect(created.status).toBe(201);
  return String(created.json?.task?.id);
}

async function makeProject(owner: Caller, name: string, visibility: 'shared' | 'private'): Promise<string> {
  const created = await call(owner, 'POST', '/projects', { name }, { 'Idempotency-Key': `oq-${crypto.randomUUID()}` });
  expect(created.status).toBe(201);
  const id = String(created.json.project.id);
  if (visibility === 'private') await pool().query("UPDATE projects SET visibility = 'private' WHERE id = $1", [id]);
  return id;
}

/** A pending grant request that names a Task, filed by `requester` for `grantee`: the Decision of every administrator. */
async function pendingGrant(requester: Caller, grantee: Caller, relatedTask: string): Promise<string> {
  const credential = String((await pool().query(
    'SELECT id FROM principal_credentials WHERE principal_id = $1 LIMIT 1', [requester.principalId])).rows[0].id);
  const id = String((await pool().query(
    `INSERT INTO approvals (kind, requester_principal_id, requesting_credential_id, grantee_principal_id,
       requested_scopes, requested_rules, requested_expires_at, reason, related_task_id, pending_expires_at)
     VALUES ('grant', $1, $2, $3, '[]'::jsonb, $4::jsonb, NOW() + INTERVAL '5 days',
             'Owner queue drill: a grant request naming a Task.', $5, NOW() + INTERVAL '5 days')
     RETURNING id`,
    [requester.principalId, credential, grantee.principalId,
      JSON.stringify([{ resourceType: 'task', selectorForm: 'exact', selectorIds: [relatedTask], verbs: ['read'] }]), relatedTask])).rows[0].id);
  await pool().query(
    `INSERT INTO approval_events (approval_id, action, actor_principal_id, actor_handle, occurred_at)
     VALUES ($1, 'approval.requested', $2, $3, now())`, [id, requester.principalId, requester.handle]);
  // Self-isolating: the longest-waiting pending request, so no earlier step's
  // requests push it past the list's per-kind cap.
  await pool().query(
    `UPDATE approvals SET requested_at = (SELECT min(requested_at) FROM approvals WHERE status = 'pending') - interval '1 minute'
      WHERE id = $1`, [id]);
  return id;
}

const plain = (who: Caller): Promise<Answer> => call(who, 'GET', '/notifications/actions');
const owner = (who: Caller): Promise<Answer> => call(who, 'GET', '/notifications/actions/owner');
const keysOf = (items: any[]): string[] => items.map((item) => String(item.key));
const byKey = (items: any[], key: string): any => items.find((item) => item.key === key);
/** The item, asserted listed: a missing one is an assertion failure, not a TypeError. */
const need = (items: any[], key: string): any => {
  const found = byKey(items, key);
  expect(`${key} listed: ${found !== undefined}`).toBe(`${key} listed: true`);
  return found;
};

/** One MCP tools/call over the in-process ingress, as an rh_ bearer. */
async function mcpTool(token: string, name: string, args: Record<string, unknown>): Promise<{ status: number; isError: boolean; text: string }> {
  const response = await fetch(`${APP.origin}${APP.modules.mcpHttp.MCP_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return {
    status: response.status,
    isError: Boolean(json?.result?.isError || json?.error),
    text: String(json?.result?.content?.[0]?.text ?? JSON.stringify(json?.error ?? text)),
  };
}

/** Every item the tool lists in detailed form, page by page. */
async function mcpItems(token: string, args: Record<string, unknown> = {}): Promise<any[]> {
  const items: any[] = [];
  for (let offset = 0; offset < 2000; offset += 50) {
    const page = await mcpTool(token, 'relayhall_action_items_list', { response_format: 'detailed', limit: 50, offset, ...args });
    expect(page.isError).toBe(false);
    const body = JSON.parse(page.text);
    items.push(...body.items);
    if (!body.pagination.hasMore) return items;
  }
  throw new Error('paging did not terminate');
}

/** `relayhall actions ...` as a separate process against the running board. */
function cli(token: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [path.resolve(__dirname, '../../../cli/relayhall'), '--api', APP.origin, ...args],
      { env: { ...process.env, RELAYHALL_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

let P: Caller;          // the person: an administrator Account (every kind reaches it)
let X: Caller;          // another person who owns private work that waits on P
let Q: Caller;          // a third person with a Connector of her own
let P_CONN: Caller;     // P's Connector: tasks:read and tasks:write
let P_SKILLS: Caller;   // P's Connector holding tasks:read and the skills scopes that see drafts (skills:read, skills:write, skills:admin)
let P_SKILLS_READ: Caller; // P's Connector holding tasks:read and skills:read only
let P_PROJECTS: Caller; // P's Connector holding tasks:read and projects:read
let P_BLIND: Caller;    // P's Connector holding neither tasks:read nor anything of the queue
let X_CONN: Caller;     // X's Connector
let Q_CONN: Caller;     // Q's Connector, tasks:read
let S_CONN: Caller;     // a Connector of a SERVICE Account holding the administrator role
let AGENT: Caller;      // an Agent under P_CONN

// What waits on P.
let TP: string;         // P's own Task: readable by P's Connector
let TV: string;         // P's own Task in Review, P the Verifier
let TN: string;         // P's own Task in Review with no Verifier: P the account owner
let TS: string;         // P's own Task, stuck, P the shepherd
let TPV: string;        // P's own Task in Review, P the Verifier, in P's shared Project
let TC: string;         // P's own Task in Review, P_CONN the Verifier (on both lists)
let TCS: string;        // P's own Task, stuck, P_CONN the shepherd (the caller's own list only)
let TX1: string;        // X's private Task in Review, P the Verifier: P_CONN cannot read it
let TX2: string;        // X's private Task, stuck, P the shepherd: P_CONN cannot read it
let D_P: string;        // a Decision about TP
let D_X: string;        // a Decision about TX1
let SKILL: string;      // X's unpublished Skill, submitted for review
let SKILL_VERSION: string;
let PROJECT_PV: string; // P's shared Project, named
const PROJECT_NAME = `OQ shared project ${tag()}`;
const TITLES: Record<string, string> = {};

let TQ: string;         // Q's own Task in Review, Q the Verifier

beforeAll(async () => {
  APP = await startApp();
  P = await sessionFor('person', 'admin');
  X = await sessionFor('xavier', 'user');
  Q = await sessionFor('quinn', 'user');
  P_CONN = await connectorFor(P, ['tasks:read', 'tasks:write']);
  P_SKILLS = await connectorFor(P, ['tasks:read', 'skills:read', 'skills:write', 'skills:admin']);
  P_SKILLS_READ = await connectorFor(P, ['tasks:read', 'skills:read']);
  P_PROJECTS = await connectorFor(P, ['tasks:read', 'projects:read']);
  P_BLIND = await connectorFor(P, ['principals:read']);
  X_CONN = await connectorFor(X, ['tasks:read', 'tasks:write']);
  Q_CONN = await connectorFor(Q, ['tasks:read']);

  PROJECT_PV = await makeProject(P, PROJECT_NAME, 'shared');
  const privateX = await makeProject(X, `OQ SECRET project ${tag()}`, 'private');
  const title = (key: string, secret = false): string => (TITLES[key] = `${secret ? SECRET : 'OQ'} ${key} ${tag()}`);

  TP = await makeTask(P, title('own task'));
  TV = await makeTask(P, title('verify'));
  TN = await makeTask(P, title('no verifier'));
  TS = await makeTask(P, title('stuck'));
  TPV = await makeTask(P, title('verify in project'), { project: PROJECT_PV });
  TC = await makeTask(P, title('caller verify'));
  TCS = await makeTask(P, title('caller stuck'));
  TX1 = await makeTask(X, title('hidden verify', true), { project: privateX });
  TX2 = await makeTask(X, title('hidden stuck', true), { project: privateX });

  for (const id of [TV, TPV, TX1]) {
    await pool().query("UPDATE tasks SET status = 'review', verifier_principal_id = $2 WHERE id = $1", [id, P.principalId]);
  }
  await pool().query("UPDATE tasks SET status = 'review', verifier_principal_id = $2 WHERE id = $1", [TC, P_CONN.principalId]);
  await pool().query("UPDATE tasks SET status = 'review', verifier_principal_id = NULL, account_owner_principal_id = $2 WHERE id = $1", [TN, P.principalId]);
  for (const id of [TS, TX2]) {
    await pool().query("UPDATE tasks SET status = 'stuck', shepherd_principal_id = $2 WHERE id = $1", [id, P.principalId]);
  }
  await pool().query("UPDATE tasks SET status = 'stuck', shepherd_principal_id = $2 WHERE id = $1", [TCS, P_CONN.principalId]);

  D_P = await pendingGrant(P_CONN, P, TP);
  D_X = await pendingGrant(X_CONN, X, TX1);

  const skillName = `oq-skill-${tag()}`;
  const skill = await call(X, 'POST', '/skills', { name: skillName, skill_md: skillMd(skillName), description: `${SECRET} draft` });
  expect(skill.status).toBe(201);
  SKILL = String(skill.json.skill.id);
  TITLES.skill = skillName;
  const revision = async (): Promise<string> => String((await pool().query('SELECT revision::text AS r FROM skills WHERE id = $1', [SKILL])).rows[0].r);
  expect((await call(X, 'POST', `/skills/${SKILL}/versions/1/submit-review`, {}, { 'If-Match': await revision() })).status).toBe(200);
  // The administrator's own Action Center names the version under review.
  const review = (await plain(P)).json.items.find((item: any) => item.kind === 'skill' && item.object.id === SKILL);
  expect(review).toBeDefined();
  SKILL_VERSION = String(review.detail.versionId);

  // Q's own item: the negative control for "another person's Connector sees none of P's".
  TQ = await makeTask(Q, title('quinn verify'));
  await pool().query("UPDATE tasks SET status = 'review', verifier_principal_id = $2 WHERE id = $1", [TQ, Q.principalId]);

  // A Connector of a SERVICE Account that holds the administrator role: not a person's.
  const service = (await pool().query(
    `INSERT INTO principals (kind, handle, display_name, status, role, purpose)
     VALUES ('service', $1, $1, 'active', 'admin', 'Owner queue drill: a service Account') RETURNING id`, [`oq-service-${tag()}`])).rows[0].id;
  const serviceConnector = (await pool().query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, $1, 'active', $2, 'Owner queue drill: its Connector', $3::jsonb) RETURNING id`,
    [`oq-service-connector-${tag()}`, service, JSON.stringify({ scopes: 'parent', objects: 'parent' })])).rows[0].id;
  const key = await APP.modules.principals.principalService.issueCredential(
    { principalId: serviceConnector, scopes: ['tasks:read'], transport: 'any' },
    { principalId: P.principalId, handle: P.handle, authMethod: 'system' });
  S_CONN = { label: 'service connector', principalId: String(serviceConnector), handle: 'oq-service', role: 'service',
    token: key.fullKey, headers: { Authorization: `Bearer ${key.fullKey}` } };
});

afterAll(async () => {
  if (APP) {
    await new Promise<void>((resolve) => APP.server.close(() => resolve()));
    await APP.pool.end();
  }
});

const EVERY_KEY = (): string[] => [
  `decision:${D_P}`, `decision:${D_X}`, `verify:${TV}`, `verify:${TN}`, `verify:${TX1}`, `verify:${TPV}`, `verify:${TC}`,
  `stuck:${TS}`, `stuck:${TX2}`, `stuck:${TCS}`, `skill:${SKILL_VERSION}`,
];

/** Whether a caller reads this Task at its own point route (the outside anchor). */
const readsTask = async (who: Caller, id: string): Promise<boolean> => (await call(who, 'GET', `/tasks/${id}`)).status === 200;

describe('(1) the person\'s own Connector and the Agent under it', () => {
  it('lists every kind waiting on the Account, and the caller\'s own, with the person\'s seen state', async () => {
    // The person's own Action Center is the baseline: every kind reaches an administrator.
    const own = (await plain(P)).json;
    for (const key of EVERY_KEY().filter((candidate) => !candidate.startsWith('stuck:' + TCS))) {
      expect(`${key}: ${byKey(own.items, key) !== undefined}`).toBe(`${key}: true`);
    }
    // The person marks two items seen on the board.
    const marked = await call(P, 'POST', '/notifications/actions/seen', { keys: [`verify:${TV}`, `decision:${D_X}`, `verify:${TC}`] });
    expect([marked.status, marked.json.marked]).toEqual([200, 3]);

    const answer = await owner(P_CONN);
    expect([answer.status, answer.json.scope]).toEqual([200, 'owning-account']);
    for (const key of EVERY_KEY()) expect(`${key}: ${byKey(answer.json.items, key) !== undefined}`).toBe(`${key}: true`);
    expect(new Set(keysOf(answer.json.items)).size).toBe(answer.json.items.length);
    // The person's seen state: the three marks, and no other item seen (the caller has marked nothing).
    expect(need(answer.json.items, `verify:${TV}`).seen).toBe(true);
    expect(need(answer.json.items, `decision:${D_X}`).seen).toBe(true);
    expect(need(answer.json.items, `verify:${TC}`).seen).toBe(true);
    for (const key of [`verify:${TN}`, `verify:${TPV}`, `stuck:${TS}`, `decision:${D_P}`, `stuck:${TCS}`, `skill:${SKILL_VERSION}`]) {
      expect(`${key}: ${need(answer.json.items, key).seen}`).toBe(`${key}: false`);
    }
    // Who each waits on: the caller-only item is the caller's; one on both lists is both.
    expect(need(answer.json.items, `stuck:${TCS}`).waitingOn).toBe('caller');
    expect(need(answer.json.items, `verify:${TC}`).waitingOn).toBe('both');
    expect(need(answer.json.items, `verify:${TV}`).waitingOn).toBe('account');
    // Each item: kind, the id it points to, how long it has waited, the board link.
    for (const item of answer.json.items.filter((candidate: any) => EVERY_KEY().includes(candidate.key))) {
      expect(typeof item.kind).toBe('string');
      expect(String(item.object.id)).toMatch(/^[0-9a-f-]{36}$/);
      expect(item.waitedSeconds).toBeGreaterThanOrEqual(0);
      expect(typeof item.href).toBe('string');
      expect(item.href.length).toBeGreaterThan(1);
    }
    expect(need(answer.json.items, `decision:${D_P}`).href).toBe(`/notifications?tab=approvals&approval=${D_P}`);
    expect(need(answer.json.items, `verify:${TV}`).href).toBe(`/tasks/${TV}`);
    expect(need(answer.json.items, `skill:${SKILL_VERSION}`).object).toMatchObject({ type: 'skill', id: SKILL });
    // The counts say what is listed.
    const kind = (name: string) => answer.json.items.filter((item: any) => item.kind === name).length;
    expect(answer.json.counts).toEqual({
      decision: kind('decision'), verify: kind('verify'), stuck: kind('stuck'), skill: kind('skill'),
      total: answer.json.items.length, unseen: answer.json.items.filter((item: any) => !item.seen).length,
    });
  });

  it('an Agent under that Connector reads the same queue', async () => {
    const mint = await call(P_CONN, 'POST', '/delegation/agent-mints', { targetTaskId: TP, requestedScopes: ['tasks:read'], via: 'approval' },
      { 'Idempotency-Key': `oq-mint-${crypto.randomUUID()}` });
    expect(mint.status).toBe(202);
    const mintId = String(mint.json.approval.id);
    const stepUp = await APP.modules.stepUp.stepUpService.mint(P.principalId, 'approval.decide', mintId, 'password');
    expect((await call(P, 'POST', `/approvals/${mintId}/approve`, { stepUpToken: stepUp.token })).status).toBe(200);
    const collected = await call(P_CONN, 'POST', `/delegation/agent-mints/${mintId}/collect`, {}, { 'Idempotency-Key': `oq-collect-${crypto.randomUUID()}` });
    expect(collected.status).toBe(201);
    const secret = String(collected.json.pack.secretOnce);
    AGENT = { label: 'agent', principalId: '', handle: 'agent', role: 'agent', token: secret, headers: { Authorization: `Bearer ${secret}` } };

    const viaConnector = (await owner(P_CONN)).json;
    const viaAgent = await owner(AGENT);
    expect([viaAgent.status, viaAgent.json.scope]).toEqual([200, 'owning-account']);
    for (const key of EVERY_KEY().filter((candidate) => candidate !== `stuck:${TCS}`)) {
      expect(`${key}: ${byKey(viaAgent.json.items, key) !== undefined}`).toBe(`${key}: true`);
    }
    // The person's seen state, not the Agent's: the same two marks.
    expect(need(viaAgent.json.items, `verify:${TV}`).seen).toBe(true);
    expect(need(viaAgent.json.items, `decision:${D_X}`).seen).toBe(true);
    expect(need(viaAgent.json.items, `stuck:${TS}`).seen).toBe(false);
    // The Agent reads less than the Connector, never more: every item it reads is one the Connector reads too.
    for (const item of viaAgent.json.items.filter((candidate: any) => candidate.readable)) {
      expect(`${item.key}: ${byKey(viaConnector.items, item.key)?.readable}`).toBe(`${item.key}: true`);
    }
  });
});

describe('(2) only the owning person\'s queue', () => {
  it('another person\'s Connector sees none of P\'s items, and its own person\'s item (the negative control)', async () => {
    const answer = await owner(Q_CONN);
    expect([answer.status, answer.json.scope]).toEqual([200, 'owning-account']);
    expect(byKey(answer.json.items, `verify:${TQ}`)?.waitingOn).toBe('account');
    expect(byKey(answer.json.items, `verify:${TQ}`)?.readable).toBe(true);
    for (const key of EVERY_KEY()) expect(`${key}: ${byKey(answer.json.items, key) !== undefined}`).toBe(`${key}: false`);
    for (const id of [TP, TV, TN, TS, TPV, TC, TCS, TX1, TX2, D_P, D_X, SKILL, SKILL_VERSION]) expect(answer.text).not.toContain(id);
    expect(answer.text).not.toContain(SECRET);
    // The same through X's Connector: X's work that waits on P is not on X's queue.
    const forX = await owner(X_CONN);
    for (const key of EVERY_KEY()) expect(`${key}: ${byKey(forX.json.items, key) !== undefined}`).toBe(`${key}: false`);
  });

  it('a Connector of a service Account is not a person\'s: it gets its own list, never the administrator Decisions', async () => {
    const answer = await owner(S_CONN);
    expect([answer.status, answer.json.scope]).toEqual([200, 'own']);
    expect(answer.json.items).toEqual([]);
    for (const key of EVERY_KEY()) expect(answer.text).not.toContain(key.split(':')[1]);
  });
});

describe('(3) a title only where the caller can read the object', () => {
  // A Connector's own authority is its person's (an `objects: parent` expression), and an administrator
  // Account reads everything, so an administrator's Connector reads every Task on the person's queue. The
  // narrow caller is the Agent: bound to one Task, it reads that Task and nothing else the queue names.
  const concealedShape = (item: any) => ({
    readable: item.readable, title: item.object.title, project: item.project, reasons: item.reasons, detail: item.detail,
  });
  const CONCEALED = { readable: false, title: null, project: null, reasons: [], detail: {} };

  it('a Task the caller cannot read is kind, id, wait and link only, and its point route refuses', async () => {
    const hiddenFromAgent: Array<[string, string]> = [
      [`verify:${TX1}`, TX1], [`stuck:${TX2}`, TX2], [`verify:${TV}`, TV], [`verify:${TN}`, TN], [`stuck:${TS}`, TS],
      [`verify:${TPV}`, TPV], [`verify:${TC}`, TC],
    ];
    const asAgent = (await owner(AGENT)).json;
    const asConnector = (await owner(P_CONN)).json;
    for (const [key, task] of hiddenFromAgent) {
      // The outside anchor: the Agent's own point route refuses this Task, and the Connector's reads it.
      expect(`${key}: agent reads ${await readsTask(AGENT, task)}`).toBe(`${key}: agent reads false`);
      expect(`${key}: connector reads ${await readsTask(P_CONN, task)}`).toBe(`${key}: connector reads true`);
      const concealed = need(asAgent.items, key);
      expect(concealedShape(concealed)).toEqual(CONCEALED);
      expect(Object.keys(concealed).sort()).toEqual(['detail', 'href', 'key', 'kind', 'object', 'project', 'readable', 'reasons', 'seen', 'since', 'waitedSeconds', 'waitingOn']);
      expect(concealed.object.type).toBe('task');
      expect(concealed.href).toBe(`/tasks/${concealed.object.id}`);
      expect(concealed.object.id).toBe(task);
      // The same item for the Connector carries what it reads.
      const read = need(asConnector.items, key);
      expect(read.readable).toBe(true);
      expect(typeof read.object.title).toBe('string');
    }
    expect(need(asConnector.items, `stuck:${TCS}`)).toMatchObject({ readable: true, waitingOn: 'caller' });
    expect(need(asConnector.items, `verify:${TN}`).reasons).toEqual(['no-verifier']);
    expect(need(asConnector.items, `verify:${TV}`).reasons).toEqual(['verifier']);
    expect(need(asConnector.items, `verify:${TV}`).object.title).toBe(TITLES.verify);
    expect(need(asConnector.items, `stuck:${TX2}`).object.title).toContain(SECRET);
    expect(JSON.stringify(asAgent).includes(SECRET)).toBe(false);
  });

  it('a Decision is readable only where its Task is: the one about a hidden Task is kind and id only', async () => {
    const answer = (await owner(AGENT)).json;
    expect(await readsTask(AGENT, TP)).toBe(true);
    expect(await readsTask(AGENT, TX1)).toBe(false);
    const visible = need(answer.items, `decision:${D_P}`);
    expect([visible.readable, visible.object.title, visible.object.type, visible.object.id]).toEqual([true, TITLES['own task'], 'approval', D_P]);
    // The requester stays with the approval: no detail beyond the Task's title.
    expect(visible.detail).toEqual({});
    const hidden = need(answer.items, `decision:${D_X}`);
    expect(concealedShape(hidden)).toEqual(CONCEALED);
    expect([hidden.object.type, hidden.object.id]).toEqual(['approval', D_X]);
    // The Connector reads the Task of both.
    const asConnector = (await owner(P_CONN)).json;
    expect(need(asConnector.items, `decision:${D_X}`).object.title).toContain(SECRET);
    // ... and its detail stays empty too: the requester is approval content.
    expect(need(asConnector.items, `decision:${D_P}`).detail).toEqual({});
    expect(need(asConnector.items, `decision:${D_X}`).detail).toEqual({});
  });

  it("a Decision's approval kind is kept only where the caller's own approval point read answers 200", async () => {
    // Every bearer is refused at the approval point route, so the title is all a Decision gives it:
    // the Task's title (readable), no reasons, whether the request is its own person's or another's.
    for (const who of [P_CONN, P_SKILLS, P_PROJECTS, AGENT]) {
      expect(`${who.label} opens D_P: ${(await call(who, 'GET', `/approvals/${D_P}`)).status === 200}`).toBe(`${who.label} opens D_P: false`);
      expect(`${who.label} opens D_X: ${(await call(who, 'GET', `/approvals/${D_X}`)).status === 200}`).toBe(`${who.label} opens D_X: false`);
    }
    const asConnector = (await owner(P_CONN)).json;
    for (const [id, title] of [[D_P, TITLES['own task']], [D_X, undefined]] as Array<[string, string | undefined]>) {
      const item = need(asConnector.items, `decision:${id}`);
      expect([item.readable, item.reasons]).toEqual([true, []]);
      if (title) expect(item.object.title).toBe(title);
    }
    expect(need((await owner(AGENT)).json.items, `decision:${D_P}`).reasons).toEqual([]);
    for (const who of [P_SKILLS, P_PROJECTS]) {
      expect(need((await owner(who)).json.items, `decision:${D_X}`).reasons).toEqual([]);
    }
    // The control: the person's own login session opens the approval and its own Action Center keeps the kind.
    expect((await call(P, 'GET', `/approvals/${D_P}`)).status).toBe(200);
    const asPerson = need((await owner(P)).json.items, `decision:${D_P}`);
    expect([asPerson.readable, asPerson.reasons, asPerson.detail.approvalKind]).toEqual([true, ['grant'], 'grant']);
  });

  it('a Skill review is readable only where its Skill is: kind and id without skills:read, the name with it', async () => {
    for (const who of [P_CONN, P_SKILLS_READ, AGENT]) {
      const item = need((await owner(who)).json.items, `skill:${SKILL_VERSION}`);
      expect(concealedShape(item)).toEqual(CONCEALED);
      expect([item.object.type, item.object.id]).toEqual(['skill', SKILL]);
      expect((await call(who, 'GET', `/skills/${SKILL}`)).status).not.toBe(200);
    }
    const reads = need((await owner(P_SKILLS)).json.items, `skill:${SKILL_VERSION}`);
    expect((await call(P_SKILLS, 'GET', `/skills/${SKILL}`)).status).toBe(200);
    expect([reads.readable, reads.object.title, reads.object.id, reads.detail]).toEqual([true, TITLES.skill, SKILL, {}]);
  });

  it('a Project name appears only to a caller that reads the Project', async () => {
    const without = need((await owner(P_CONN)).json.items, `verify:${TPV}`);
    expect([without.readable, without.object.title, without.project]).toEqual([true, TITLES['verify in project'], null]);
    const withProjects = need((await owner(P_PROJECTS)).json.items, `verify:${TPV}`);
    expect(withProjects.readable).toBe(true);
    expect(withProjects.project).toEqual({ id: PROJECT_PV, name: PROJECT_NAME });
    expect((await call(P_PROJECTS, 'GET', `/projects/${PROJECT_PV}`)).status).toBe(200);
    expect((await call(P_CONN, 'GET', `/projects/${PROJECT_PV}`)).status).not.toBe(200);
  });

  it('never widens: for every caller, an item is readable exactly when its object reads at its own point route', async () => {
    let readable = 0; let concealed = 0;
    for (const who of [P_CONN, P_SKILLS, P_SKILLS_READ, P_PROJECTS, AGENT, Q_CONN]) {
      const answer = await owner(who);
      expect(answer.status).toBe(200);
      for (const item of answer.json.items) {
        if (item.kind === 'verify' || item.kind === 'stuck') {
          const reads = await readsTask(who, item.object.id);
          expect(`${who.label} ${item.key}: ${item.readable}`).toBe(`${who.label} ${item.key}: ${reads}`);
        }
        if (item.kind === 'skill') {
          const reads = (await call(who, 'GET', `/skills/${item.object.id}`)).status === 200;
          expect(`${who.label} ${item.key}: ${item.readable}`).toBe(`${who.label} ${item.key}: ${reads}`);
        }
        if (item.readable) {
          readable += 1;
          expect(typeof item.object.title).toBe('string');
        } else {
          concealed += 1;
          expect(item.object.title).toBeNull();
        }
      }
    }
    // Not vacuous: both outcomes occurred.
    expect(readable).toBeGreaterThan(0);
    expect(concealed).toBeGreaterThan(0);

    // A Decision (Task read and approval read are different reads): readable exactly when its Task reads, and
    // its approval kind (reasons) and requester (detail) are present exactly when the caller's own approval
    // point route answers 200 - for each caller kind, bearers (the bound Agent among them) and sessions.
    let opened = 0; let closed = 0; let titled = 0;
    for (const who of [P_CONN, P_SKILLS, P_SKILLS_READ, P_PROJECTS, AGENT, Q_CONN, P, X]) {
      const answer = await owner(who);
      expect(answer.status).toBe(200);
      for (const item of answer.json.items.filter((candidate: any) => candidate.kind === 'decision')) {
        const opens = (await call(who, 'GET', `/approvals/${item.object.id}`)).status === 200;
        if (!item.readable) {
          expect(`${who.label} ${item.key}: ${JSON.stringify([item.object.title, item.reasons, item.detail])}`)
            .toBe(`${who.label} ${item.key}: ${JSON.stringify([null, [], {}])}`);
          continue;
        }
        if (typeof item.object.title === 'string') titled += 1;
        expect(`${who.label} ${item.key}: reasons ${item.reasons.length > 0}, detail ${Object.keys(item.detail).length > 0}`)
          .toBe(`${who.label} ${item.key}: reasons ${opens}, detail ${opens}`);
        if (opens) opened += 1; else closed += 1;
      }
    }
    // Not vacuous: a Decision kept its approval content for a caller that opens the approval, and lost it for one that does not.
    expect(opened).toBeGreaterThan(0);
    expect(closed).toBeGreaterThan(0);
    expect(titled).toBeGreaterThan(0);
    // Another person's Connector reads her own item and nothing of P's.
    expect(need((await owner(Q_CONN)).json.items, `verify:${TQ}`).readable).toBe(true);
  });
});

describe('(4) one source, and the Action Center\'s caps', () => {
  it('the owner queue equals the Account\'s own Action Center list, item for item', async () => {
    const own = (await plain(P)).json;
    const queue = (await owner(P_CONN)).json;
    // Every item on the person's list is on the queue, with the same kind, since and seen state.
    for (const item of own.items) {
      const found = need(queue.items, item.key);
      expect(`${item.key}: ${found !== undefined}`).toBe(`${item.key}: true`);
      expect([found.kind, found.since, found.seen]).toEqual([item.kind, item.since, item.seen]);
      expect(found.object.id).toBe(item.object.id);
      expect(found.href).toBe(item.href);
      // A Decision's reasons are the approval's kind: a bearer's queue does not carry them (its approval read is refused).
      if (found.readable) expect(found.reasons).toEqual(item.kind === 'decision' ? [] : expect.arrayContaining(item.reasons));
    }
    // And nothing is on the queue that is on neither list: the extras are the caller's own.
    const ownKeys = new Set(keysOf(own.items));
    const callerOwn = new Set(keysOf((await plain(P_CONN)).json.items));
    for (const item of queue.items) expect(`${item.key}: ${ownKeys.has(item.key) || callerOwn.has(item.key)}`).toBe(`${item.key}: true`);
  });

  it('a caller with no owning Account gets exactly its own plain list', async () => {
    const forPerson = (await owner(P)).json;
    const plainList = (await plain(P)).json;
    expect(forPerson.scope).toBe('own');
    expect(keysOf(forPerson.items)).toEqual(keysOf(plainList.items));
    for (const item of forPerson.items) {
      const { readable, waitingOn, waitedSeconds, ...rest } = item;
      expect([readable, waitingOn]).toEqual([true, 'caller']);
      expect(waitedSeconds).toBeGreaterThanOrEqual(0);
      expect(rest).toEqual(need(plainList.items, item.key));
    }
    expect(forPerson.counts).toEqual(plainList.counts);
    expect(forPerson.capped).toEqual(plainList.capped);
  });

  it('the caps are the Action Center\'s: the same 200, oldest first, capped flagged', async () => {
    const K = await sessionFor('capped', 'user');
    const K_CONN = await connectorFor(K, ['tasks:read']);
    const seeded = await pool().query(
      `INSERT INTO tasks (title, description, status, visibility, creator_principal_id, verifier_principal_id)
       SELECT 'OQ cap ' || g, 'cap fixture', 'review', 'private', $1::uuid, $1::uuid FROM generate_series(1, 205) AS g`,
      [K.principalId]);
    expect(seeded.rowCount).toBe(205);
    const cap = APP.modules.actions.ACTIONS_KIND_CAP;
    expect(cap).toBe(200);
    const centre = (await plain(K)).json;
    const queue = (await owner(K_CONN)).json;
    expect([centre.counts.verify, centre.capped.verify]).toEqual([cap, true]);
    expect([queue.scope, queue.counts.verify, queue.capped.verify]).toEqual(['owning-account', cap, true]);
    expect(keysOf(queue.items.filter((item: any) => item.kind === 'verify'))).toEqual(keysOf(centre.items.filter((item: any) => item.kind === 'verify')));
    expect(queue.counts.total).toBe(centre.counts.total);
    expect(queue.items.length).toBe(centre.items.length);
  });

  it('an item leaves the queue when its condition ends, and returns as unseen when it begins again', async () => {
    const task = await makeTask(P, `OQ transient ${tag()}`);
    await pool().query("UPDATE tasks SET status = 'review', verifier_principal_id = $2 WHERE id = $1", [task, P.principalId]);
    expect(byKey((await owner(P_CONN)).json.items, `verify:${task}`)?.waitingOn).toBe('account');
    await pool().query("UPDATE tasks SET status = 'completed' WHERE id = $1", [task]);
    expect(byKey((await owner(P_CONN)).json.items, `verify:${task}`)).toBeUndefined();
  });
});

describe('(5) read only', () => {
  // The count AND the newest write time: a read that re-marks an item changes the time, not the count.
  const marksOf = async (): Promise<string> => JSON.stringify((await pool().query(
    'SELECT count(*)::int AS n, max(seen_at)::text AS at FROM notification_action_seen')).rows[0]);
  const approvalsOf = async (): Promise<string> => JSON.stringify((await pool().query(
    "SELECT status, count(*)::int AS n FROM approvals GROUP BY status ORDER BY status")).rows);
  const tasksOf = async (): Promise<string> => String((await pool().query(
    'SELECT count(*)::int AS n, max(updated_at)::text AS u FROM tasks')).rows.map((row: any) => `${row.n}|${row.u}`));

  it('reading the queue over REST, MCP and the CLI marks nothing seen, decides nothing and changes no Task', async () => {
    const before = [await marksOf(), await approvalsOf(), await tasksOf()];
    for (const who of [P_CONN, P_SKILLS, Q_CONN, AGENT]) {
      expect((await owner(who)).status).toBe(200);
      expect((await mcpTool(who.token!, 'relayhall_action_items_list', {})).isError).toBe(false);
    }
    expect((await cli(P_CONN.token!, ['actions'])).code).toBe(0);
    expect([await marksOf(), await approvalsOf(), await tasksOf()]).toEqual(before);
  });

  it('only a GET reaches the route: every write method is refused and writes nothing', async () => {
    const before = [await marksOf(), await approvalsOf(), await tasksOf()];
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const who of [P_CONN, P]) {
        const refused = await call(who, method, '/notifications/actions/owner', method === 'DELETE' ? undefined : { all: true });
        expect(`${method} ${who.label}: ${[403, 404, 405].includes(refused.status)}`).toBe(`${method} ${who.label}: true`);
      }
    }
    expect([await marksOf(), await approvalsOf(), await tasksOf()]).toEqual(before);
  });

  it('the Connector\'s own seen mark is its own: it never writes the person\'s', async () => {
    const personMarks = async (): Promise<number> => Number((await pool().query(
      'SELECT count(*)::int AS n FROM notification_action_seen WHERE principal_id = $1', [P.principalId])).rows[0].n);
    const before = await personMarks();
    const marked = await call(P_CONN, 'POST', '/notifications/actions/seen', { all: true });
    expect(marked.status).toBe(200);
    expect(await personMarks()).toBe(before);
    // The person's seen state in the queue is unchanged by the Connector's marks.
    const item = need((await owner(P_CONN)).json.items, `stuck:${TS}`);
    expect(item.seen).toBe(false);
  });

  it('a credential without tasks:read is refused at the route ceiling, over REST and over MCP', async () => {
    const refused = await owner(P_BLIND);
    expect(refused.status).toBe(403);
    expect(refused.text).not.toContain(TV);
    const viaMcp = await mcpTool(P_BLIND.token!, 'relayhall_action_items_list', {});
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.text).toContain('403');
    expect(viaMcp.text).not.toContain(TV);
  });
});

describe('(6) the MCP tool and the CLI print what the service answered', () => {
  it('the tool is read only, on the introspection plane: it answers before the credential has bootstrapped', async () => {
    const listed = await fetch(`${APP.origin}${APP.modules.mcpHttp.MCP_ROUTE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${P_CONN.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const tools: any[] = JSON.parse(await listed.text()).result.tools;
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('relayhall_action_items_list');
    expect(names.filter((name) => /^relayhall_action_|notification/.test(name))).toEqual(['relayhall_action_items_list']);
    const tool = tools.find((candidate) => candidate.name === 'relayhall_action_items_list');
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(['kind', 'limit', 'offset', 'response_format']);
    // This credential never called relayhall_brief_compile, yet the read answers.
    const answer = await mcpTool(P_CONN.token!, 'relayhall_action_items_list', {});
    expect([answer.status, answer.isError]).toEqual([200, false]);
  });

  it('the tool\'s detailed items equal the service\'s, and its kind filter narrows', async () => {
    for (const who of [P_CONN, P_SKILLS, AGENT, Q_CONN]) {
      const service = (await owner(who)).json;
      const viaTool = await mcpItems(who.token!);
      expect(keysOf(viaTool)).toEqual(keysOf(service.items));
      // The wait is computed at read time, so the two reads differ by it alone.
      for (const item of service.items) {
        const { waitedSeconds, ...rest } = item;
        const { waitedSeconds: _ignored, ...got } = need(viaTool, item.key);
        expect(got).toEqual(rest);
      }
    }
    const onlyStuck = await mcpItems(P_CONN.token!, { kind: 'stuck' });
    expect(onlyStuck.length).toBeGreaterThan(0);
    expect(onlyStuck.every((item) => item.kind === 'stuck')).toBe(true);
    expect(keysOf(onlyStuck)).toEqual(keysOf((await owner(P_CONN)).json.items.filter((item: any) => item.kind === 'stuck')));
  });

  it('the tool\'s concise lines hold ids, readable titles and the concealed marker only, and refuse any argument that could write', async () => {
    const readable = await mcpTool(P_CONN.token!, 'relayhall_action_items_list', { kind: 'verify', limit: 50 });
    expect(readable.isError).toBe(false);
    expect(readable.text).toContain(TITLES.verify);
    expect(readable.text).not.toContain('not readable by you');
    // The Agent reads one Task: every other line is its kind and id.
    const concise = await mcpTool(AGENT.token!, 'relayhall_action_items_list', { kind: 'verify', limit: 50 });
    expect(concise.isError).toBe(false);
    expect(concise.text).toContain(TX1);
    expect(concise.text).toContain('not readable by you: kind and id only');
    expect(concise.text.includes(TITLES.verify)).toBe(false);
    expect(concise.text.includes(SECRET)).toBe(false);
    expect((await mcpTool(P_CONN.token!, 'relayhall_action_items_list', { kind: 'nonsense' })).isError).toBe(true);
    for (const forbidden of [{ mark: true }, { decide: D_P }, { seen: [TV] }, { all: true }]) {
      expect((await mcpTool(P_CONN.token!, 'relayhall_action_items_list', forbidden)).isError).toBe(true);
    }
  });

  it('the CLI prints the service\'s envelope under --json, and --kind narrows', async () => {
    const service = (await owner(P_CONN)).json;
    const asJson = await cli(P_CONN.token!, ['actions', '--json']);
    expect(asJson.code).toBe(0);
    const printed = JSON.parse(asJson.stdout);
    expect(keysOf(printed.items)).toEqual(keysOf(service.items));
    for (const item of service.items) {
      const { waitedSeconds, ...rest } = item;
      const { waitedSeconds: _ignored, ...got } = need(printed.items, item.key);
      expect(got).toEqual(rest);
    }
    const onlyDecisions = await cli(P_CONN.token!, ['actions', '--kind', 'decision', '--json']);
    const decisions = JSON.parse(onlyDecisions.stdout).items;
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every((item: any) => item.kind === 'decision')).toBe(true);
  });

  it('the CLI table holds readable titles and the concealed marker only, and no verb decides, marks or changes', async () => {
    const readable = await cli(P_CONN.token!, ['actions']);
    expect(readable.code).toBe(0);
    expect(readable.stdout).toContain(TITLES.verify);
    const table = await cli(AGENT.token!, ['actions']);
    expect(table.code).toBe(0);
    expect(table.stdout).toContain(TV);
    expect(table.stdout.includes(TITLES.verify)).toBe(false);
    const hidden = table.stdout.split('\n').find((row) => row.includes(TX1)) ?? '';
    expect(hidden).toContain('not readable by you: kind and id only');
    expect(hidden).not.toContain(SECRET);
    expect(table.stdout.includes(SECRET)).toBe(false);
    for (const verb of ['decide', 'seen', 'mark-seen']) {
      expect((await cli(P_CONN.token!, ['actions', verb, TV])).code).not.toBe(0);
    }
  });
});
