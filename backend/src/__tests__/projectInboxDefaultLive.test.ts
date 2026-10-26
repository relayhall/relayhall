/**
 * Card b13e5ac9 (owner ruling D34(b); Charter v5 §6.1 and §6.2): new-card
 * defaults. A Project names one inbox phase (`projects.inbox_phase_id`,
 * migration 141); a Task created WITHOUT an explicit phaseId lands there, and
 * a Task that lands there without an explicit status is created as Ideas. An
 * explicit phaseId (null = the backlog) or status wins for its own field.
 * Projects without an inbox phase, orphan Tasks and existing Tasks keep
 * today's behaviour.
 *
 * Proven over a REAL PostgreSQL and the PRODUCTION router, with the MCP
 * ingress mounted the way `server.ts` mounts it, for all four creation
 * surfaces, each with and without an explicit phase:
 *
 *   - REST `POST /tasks` under an owner login session;
 *   - the dashboard: the exact request bodies the New task form and the
 *     Project Work-tab quick create send, under the same session;
 *   - MCP `relayhall_task_create` over `tools/call` with a Connector bearer,
 *     the REST status behind every call recorded at the in-process seam;
 *   - the CLI `relayhall create`, the real Python program, spawned against
 *     this server with the same bearer.
 *
 * And the setting itself (PATCH /projects/:id, the composite FK, the phase
 * delete guard), the suspended default (archived or restricted inbox), the
 * existing-Task invariant, and the compiled Brief's "Project Context".
 *
 * The creation-surface blocks set the inbox with SQL, independently of the
 * PATCH contract, so that against main's sources (on a database carrying
 * migration 141) every "without an explicit phase" assertion fails for the
 * reason it exists - the default is not applied - rather than at setup.
 *
 * DESTRUCTIVE: writes principals, credentials, services, projects, phases,
 * tasks, sessions and audit rows. It refuses any deployment database and any
 * non-local host, and FAILS - never skips - without a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';
import path from 'path';
import { spawn } from 'child_process';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the inbox-default drill measures stored project, phase and task '
    + 'rows, so it never skips. Load database/init.sql into a disposable database, run npm run migrate, and point '
    + 'RELAYHALL_TEST_DB_URL at it.');
}
const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = decodeURIComponent(parsed.pathname.slice(1));
const localDisposable = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  && /test|contract|fixture/.test(TEST_DB_NAME);
const ciService = process.env.CI === 'true' && parsed.hostname === 'postgres' && TEST_DB_NAME === 'relayhall_ci';
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
  || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod'].includes(TEST_DB_NAME)
  || (!localDisposable && !ciService)) {
  throw new Error('Inbox-default drill refuses a non-disposable database target');
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
const inProcess = require('../mcp/inProcess');
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');

jest.setTimeout(240_000);

// ──────────────────────────────── the app ────────────────────────────────────

let server: http.Server;
let origin: string;

function buildApp(): any {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  // The MCP ingress first and outside the REST funnel, exactly as server.ts mounts it.
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

function answersSince(mark: number, method: string, routePath: RegExp): number[] {
  return dispatched.slice(mark).filter((entry) => entry.method === method && routePath.test(entry.path))
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

interface CliResult { code: number; stdout: string; stderr: string }
const CLI_PATH = path.resolve(__dirname, '../../../cli/relayhall');

/** The real CLI program, spawned against this server with a bearer and nothing else. */
function cli(token: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [CLI_PATH, '--api', origin, ...args], {
      env: { ...process.env, RELAYHALL_TOKEN: token, RELAYHALL_CONFIG_DIR: path.join('/tmp', `b11-cli-${crypto.randomUUID()}`) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

const tag = (): string => crypto.randomBytes(5).toString('hex');
const key = (label: string): string => `b11-${label}-${crypto.randomUUID()}`;

// ─────────────────────────────── fixtures ────────────────────────────────────

const CONNECTOR_SCOPES = ['tasks:read', 'tasks:write', 'projects:read', 'personalities:read'];

let OWNER: Caller;
let ADMIN: Caller;
let CONNECTOR: Caller;
let CONNECTOR_TOKEN: string;

let INBOX_PROJECT: { id: string; name: string };
let PLAIN_PROJECT: { id: string; name: string };
let ACTIVE: string;   // an active phase of INBOX_PROJECT ("11 · Track A")
let INBOX: string;    // INBOX_PROJECT's inbox phase ("15 · Inbox — to be sorted")
let SPARE: string;    // a third phase of INBOX_PROJECT, for the refusal drills
let PLAIN_PHASE: string; // a phase of PLAIN_PROJECT, which names no inbox
let PRE_EXISTING: string; // created in INBOX_PROJECT before any inbox existed
let preExistingRow: Record<string, unknown>;
let projectRevision: string;

async function makeAccount(role: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $1, 'active', $2) RETURNING id`,
    [`b11-${role}-${tag()}`, role],
  );
  return String(result.rows[0].id);
}

async function sessionFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

async function makeProject(name: string): Promise<{ id: string; name: string; revision: string }> {
  const created = await call(OWNER, 'POST', '/projects', { name });
  expect(created.status).toBe(201);
  return { id: String(created.json.project.id), name, revision: String(created.json.project.revision) };
}

async function makePhase(projectId: string, name: string, position: number): Promise<string> {
  const created = await call(OWNER, 'POST', '/phases', { projectId, name, position }, { 'Idempotency-Key': key('phase') });
  expect(created.status).toBe(201);
  return String(created.json.phase.id);
}

async function taskRow(taskId: string): Promise<{ phase_id: string | null; status: string; project_id: string | null; updated_at: unknown }> {
  const result = await pool.query('SELECT phase_id, status, project_id, updated_at FROM tasks WHERE id = $1', [taskId]);
  expect(result.rows).toHaveLength(1);
  return result.rows[0];
}

/** Where a Task landed: [phase_id, status]. */
async function landing(taskId: string): Promise<[string | null, string]> {
  const row = await taskRow(taskId);
  return [row.phase_id === null ? null : String(row.phase_id), String(row.status)];
}

async function restCreate(who: Caller, body: Record<string, unknown>): Promise<string> {
  const created = await call(who, 'POST', '/tasks', body);
  expect([created.status, created.json?.code]).toEqual([201, undefined]);
  return String(created.json.task.id);
}

/** The MCP and CLI Tasks are the Connector's own acts, not the owner's. */
async function expectCreatedByConnector(taskId: string): Promise<void> {
  const row = await pool.query('SELECT creator_principal_id FROM tasks WHERE id = $1', [taskId]);
  expect(String(row.rows[0]?.creator_principal_id)).toBe(CONNECTOR.principalId);
}

async function mcpCreate(args: Record<string, unknown>): Promise<string> {
  const mark = dispatched.length;
  const created = await mcpCall(CONNECTOR_TOKEN, 'relayhall_task_create', { idempotencyKey: key('mcp-create'), ...args });
  expect(answersSince(mark, 'POST', /^\/tasks$/)).toEqual([201]);
  expect(mcpFailed(created)).toBe(false);
  const match = /full id: ([0-9a-f-]{36})/.exec(mcpText(created));
  expect(match).not.toBeNull();
  await expectCreatedByConnector(match![1]);
  return match![1];
}

async function cliCreate(args: string[]): Promise<string> {
  const result = await cli(CONNECTOR_TOKEN, ['create', ...args, '--no-subtasks']);
  expect([result.code, result.stderr.includes('API error')]).toEqual([0, false]);
  const match = /ID: ([0-9a-f-]{36})/.exec(result.stdout);
  expect(match).not.toBeNull();
  await expectCreatedByConnector(match![1]);
  return match![1];
}

/** The inbox, set with SQL: independent of the PATCH contract under test elsewhere. */
async function setInboxDirect(projectId: string, phaseId: string | null): Promise<void> {
  await pool.query('UPDATE projects SET inbox_phase_id = $2 WHERE id = $1', [projectId, phaseId]);
}

async function setRestricted(phaseId: string, restricted: boolean): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('relayhall.phase_access_actor', $1, true),
      set_config('relayhall.phase_access_reason', 'b11 inbox drill fixture', true)`, [OWNER.principalId]);
    await client.query('UPDATE phases SET restricted_access = $2 WHERE id = $1', [phaseId, restricted]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function phaseRevision(phaseId: string): Promise<string> {
  const read = await call(OWNER, 'GET', `/phases/${phaseId}`);
  expect(read.status).toBe(200);
  return String(read.json.phase.revision);
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

  OWNER = await sessionFor('owner', await makeAccount('user'));
  ADMIN = await sessionFor('admin', await makeAccount('admin'));

  const inboxProject = await makeProject(`B11 inbox drill ${tag()}`);
  INBOX_PROJECT = { id: inboxProject.id, name: inboxProject.name };
  projectRevision = inboxProject.revision;
  ACTIVE = await makePhase(INBOX_PROJECT.id, '11 · Track A', 11);
  INBOX = await makePhase(INBOX_PROJECT.id, '15 · Inbox — to be sorted', 15);
  SPARE = await makePhase(INBOX_PROJECT.id, '20 · Spare', 20);
  const plain = await makeProject(`B11 plain drill ${tag()}`);
  PLAIN_PROJECT = { id: plain.id, name: plain.name };
  PLAIN_PHASE = await makePhase(PLAIN_PROJECT.id, '01 · Build', 1);

  // A Task that existed before the Project had an inbox: no phase, To-Do.
  PRE_EXISTING = await restCreate(OWNER, { title: `B11 PRE-EXISTING ${tag()}`, project: INBOX_PROJECT.id });
  preExistingRow = await taskRow(PRE_EXISTING);
  expect([preExistingRow.phase_id, preExistingRow.status]).toEqual([null, 'todo']);

  // The Connector: registered through the owner's wizard path, bootstrapped over MCP.
  const slug = `b11-connector-${tag()}`;
  const registered = await call(OWNER, 'POST', '/services', {
    slug, name: slug, description: 'Inbox-default drill connector.', kind: 'connector',
    issueCredential: { scopes: CONNECTOR_SCOPES, label: slug, transport: 'any' },
  });
  expect(registered.status).toBe(201);
  const row = await pool.query('SELECT principal_id FROM services WHERE slug = $1', [slug]);
  CONNECTOR_TOKEN = String(registered.json.onboarding.credential.secretOnce);
  CONNECTOR = { label: slug, principalId: String(row.rows[0].principal_id), headers: { Authorization: `Bearer ${CONNECTOR_TOKEN}` } };
  const mark = dispatched.length;
  const brief = await mcpCall(CONNECTOR_TOKEN, 'relayhall_brief_compile', { session: true });
  expect(answersSince(mark, 'POST', /^\/principals\/me\/brief$/)).toEqual([200]);
  expect(mcpFailed(brief)).toBe(false);
});

afterAll(async () => {
  jest.restoreAllMocks();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ─────────────────────────── C1: the setting ─────────────────────────────────

describe('C1 the inbox phase is a per-Project setting (PATCH /projects/:id, migration 141)', () => {
  it('a Project starts with none, and GET says so', async () => {
    const read = await call(OWNER, 'GET', `/projects/${PLAIN_PROJECT.id}`);
    expect([read.status, read.json?.project?.inboxPhaseId]).toEqual([200, null]);
  });

  it('a malformed value, an unknown Phase and another Project\'s Phase are refused, and nothing is stored', async () => {
    const malformed = await call(OWNER, 'PATCH', `/projects/${INBOX_PROJECT.id}`, { inboxPhaseId: 'phase-15' }, { 'If-Match': projectRevision });
    expect([malformed.status, malformed.json?.code]).toEqual([422, 'INVALID_PROJECT_VALUE']);
    const unknown = await call(OWNER, 'PATCH', `/projects/${INBOX_PROJECT.id}`, { inboxPhaseId: crypto.randomUUID() }, { 'If-Match': projectRevision });
    expect([unknown.status, unknown.json?.code]).toEqual([422, 'INBOX_PHASE_NOT_IN_PROJECT']);
    const foreign = await call(OWNER, 'PATCH', `/projects/${INBOX_PROJECT.id}`, { inboxPhaseId: PLAIN_PHASE }, { 'If-Match': projectRevision });
    // The same answer for "no such Phase" and "a Phase of another Project".
    expect([foreign.status, foreign.json?.code]).toEqual([422, 'INBOX_PHASE_NOT_IN_PROJECT']);
    const stored = await pool.query('SELECT inbox_phase_id, revision FROM projects WHERE id = $1', [INBOX_PROJECT.id]);
    expect([stored.rows[0].inbox_phase_id, String(stored.rows[0].revision)]).toEqual([null, projectRevision]);
  });

  it('an archived Phase and a restricted Phase cannot be named', async () => {
    const archived = await call(OWNER, 'POST', `/phases/${SPARE}/archive`, { revision: await phaseRevision(SPARE) });
    expect(archived.status).toBe(200);
    const onArchived = await call(OWNER, 'PATCH', `/projects/${INBOX_PROJECT.id}`, { inboxPhaseId: SPARE }, { 'If-Match': projectRevision });
    expect([onArchived.status, onArchived.json?.code]).toEqual([409, 'PHASE_ARCHIVED']);
    const restored = await call(OWNER, 'POST', `/phases/${SPARE}/unarchive`, { revision: await phaseRevision(SPARE) });
    expect(restored.status).toBe(200);

    await setRestricted(SPARE, true);
    const onRestricted = await call(OWNER, 'PATCH', `/projects/${INBOX_PROJECT.id}`, { inboxPhaseId: SPARE }, { 'If-Match': projectRevision });
    expect([onRestricted.status, onRestricted.json?.code]).toEqual([409, 'INBOX_PHASE_RESTRICTED']);
    await setRestricted(SPARE, false);
    const stored = await pool.query('SELECT inbox_phase_id FROM projects WHERE id = $1', [INBOX_PROJECT.id]);
    expect(stored.rows[0].inbox_phase_id).toBeNull();
  });

  it('a stale revision is refused 412 and stores nothing', async () => {
    const stale = await call(OWNER, 'PATCH', `/projects/${INBOX_PROJECT.id}`, { inboxPhaseId: INBOX }, { 'If-Match': crypto.randomUUID() });
    expect([stale.status, stale.json?.code]).toEqual([412, 'REVISION_MISMATCH']);
    const stored = await pool.query('SELECT inbox_phase_id FROM projects WHERE id = $1', [INBOX_PROJECT.id]);
    expect(stored.rows[0].inbox_phase_id).toBeNull();
  });

  it('PATCH names it under If-Match; GET and the list carry it; the row stores it; existing Tasks are untouched', async () => {
    const set = await call(OWNER, 'PATCH', `/projects/${INBOX_PROJECT.id}`, { inboxPhaseId: INBOX }, { 'If-Match': projectRevision });
    expect([set.status, set.json?.project?.inboxPhaseId]).toEqual([200, INBOX]);
    expect(set.json.project.revision).not.toBe(projectRevision);
    projectRevision = String(set.json.project.revision);

    const read = await call(OWNER, 'GET', `/projects/${INBOX_PROJECT.id}`);
    expect(read.json?.project?.inboxPhaseId).toBe(INBOX);
    const list = await call(OWNER, 'GET', '/projects');
    const listed = (list.json?.projects ?? []).find((project: any) => project.id === INBOX_PROJECT.id);
    expect(listed?.inboxPhaseId).toBe(INBOX);
    const stored = await pool.query('SELECT inbox_phase_id FROM projects WHERE id = $1', [INBOX_PROJECT.id]);
    expect(String(stored.rows[0].inbox_phase_id)).toBe(INBOX);

    // Naming an inbox moves nothing: the Task that predates it is byte-for-byte where it was.
    expect(await taskRow(PRE_EXISTING)).toEqual(preExistingRow);
  });

  it('the database binds the inbox to its own Project: a direct write naming another Project\'s Phase raises 23503', async () => {
    await expect(pool.query('UPDATE projects SET inbox_phase_id = $2 WHERE id = $1', [INBOX_PROJECT.id, PLAIN_PHASE]))
      .rejects.toMatchObject({ code: '23503', constraint: 'projects_inbox_phase_fk' });
  });

  it('deleting the inbox Phase is refused 409 PHASE_IS_INBOX through the router (and by the FK underneath); cleared, it deletes', async () => {
    const throwaway = await makeProject(`B11 delete drill ${tag()}`);
    const phase = await makePhase(throwaway.id, 'Inbox to delete', 1);
    const set = await call(OWNER, 'PATCH', `/projects/${throwaway.id}`, { inboxPhaseId: phase }, { 'If-Match': throwaway.revision });
    expect(set.status).toBe(200);

    const refused = await call(ADMIN, 'DELETE', `/phases/${phase}`);
    expect([refused.status, refused.json?.code]).toEqual([409, 'PHASE_IS_INBOX']);
    await expect(pool.query('DELETE FROM phases WHERE id = $1', [phase]))
      .rejects.toMatchObject({ code: '23503', constraint: 'projects_inbox_phase_fk' });
    expect((await pool.query('SELECT 1 FROM phases WHERE id = $1', [phase])).rows).toHaveLength(1);

    const cleared = await call(OWNER, 'PATCH', `/projects/${throwaway.id}`, { inboxPhaseId: null }, { 'If-Match': String(set.json.project.revision) });
    expect([cleared.status, cleared.json?.project?.inboxPhaseId]).toEqual([200, null]);
    const deleted = await call(ADMIN, 'DELETE', `/phases/${phase}`);
    expect(deleted.status).toBe(200);
  });

  it('deleting a whole Project that names an inbox still succeeds: NO ACTION is checked at statement end', async () => {
    const projectId = crypto.randomUUID();
    await pool.query('INSERT INTO projects (id, name) VALUES ($1, $2)', [projectId, `B11 cascade ${tag()}`]);
    const phase = await pool.query('INSERT INTO phases (project_id, name) VALUES ($1, $2) RETURNING id', [projectId, 'Inbox']);
    await setInboxDirect(projectId, String(phase.rows[0].id));
    await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
    expect((await pool.query('SELECT 1 FROM phases WHERE id = $1', [phase.rows[0].id])).rows).toHaveLength(0);
  });
});

// ─────────────────────── C2: the four creation surfaces ──────────────────────

describe('C2 a Task created without an explicit phase lands in the inbox phase with status Ideas', () => {
  beforeAll(async () => {
    await setInboxDirect(INBOX_PROJECT.id, INBOX);
  });

  describe('REST POST /tasks (owner session)', () => {
    it('no phaseId, no status: the inbox phase, Ideas', async () => {
      const id = await restCreate(OWNER, { title: `B11 REST default ${tag()}`, project: INBOX_PROJECT.id });
      expect(await landing(id)).toEqual([INBOX, 'ideas']);
    });

    it('the response says where it landed', async () => {
      const created = await call(OWNER, 'POST', '/tasks', { title: `B11 REST echo ${tag()}`, project: INBOX_PROJECT.name });
      expect([created.status, created.json?.task?.phaseId, created.json?.task?.status]).toEqual([201, INBOX, 'ideas']);
    });

    it('no phaseId, explicit status: the inbox phase, and the status wins', async () => {
      const id = await restCreate(OWNER, { title: `B11 REST status ${tag()}`, project: INBOX_PROJECT.id, status: 'todo' });
      expect(await landing(id)).toEqual([INBOX, 'todo']);
    });

    it('explicit phaseId and status (the authorised-work exception): straight to To-Do in the active phase', async () => {
      const id = await restCreate(OWNER, { title: `B11 REST follow-up ${tag()}`, project: INBOX_PROJECT.id, phaseId: ACTIVE, status: 'todo' });
      expect(await landing(id)).toEqual([ACTIVE, 'todo']);
    });

    it('explicit phaseId, no status: that phase, and To-Do as always', async () => {
      const id = await restCreate(OWNER, { title: `B11 REST phase only ${tag()}`, project: INBOX_PROJECT.id, phaseId: ACTIVE });
      expect(await landing(id)).toEqual([ACTIVE, 'todo']);
    });

    it('naming the inbox phase itself, no status: Ideas', async () => {
      const id = await restCreate(OWNER, { title: `B11 REST named inbox ${tag()}`, project: INBOX_PROJECT.id, phaseId: INBOX });
      expect(await landing(id)).toEqual([INBOX, 'ideas']);
    });

    it('explicit phaseId null is a choice: the unphased backlog, To-Do', async () => {
      const id = await restCreate(OWNER, { title: `B11 REST backlog ${tag()}`, project: INBOX_PROJECT.id, phaseId: null });
      expect(await landing(id)).toEqual([null, 'todo']);
    });

    it('a Project with no inbox phase keeps today\'s behaviour', async () => {
      const id = await restCreate(OWNER, { title: `B11 REST plain ${tag()}`, project: PLAIN_PROJECT.id });
      expect(await landing(id)).toEqual([null, 'todo']);
      const phased = await restCreate(OWNER, { title: `B11 REST plain phased ${tag()}`, project: PLAIN_PROJECT.id, phaseId: PLAIN_PHASE });
      expect(await landing(phased)).toEqual([PLAIN_PHASE, 'todo']);
    });

    it('an orphan Task (no Project) keeps today\'s behaviour', async () => {
      const id = await restCreate(OWNER, { title: `B11 REST orphan ${tag()}` });
      expect(await landing(id)).toEqual([null, 'todo']);
    });
  });

  describe('the dashboard (the exact bodies its two create surfaces send, owner session)', () => {
    it('Project Work-tab quick create - no status, no phase: the inbox phase, Ideas', async () => {
      const id = await restCreate(OWNER, { title: `B11 DASH quick ${tag()}`, description: '', priority: 'normal', project: INBOX_PROJECT.name });
      expect(await landing(id)).toEqual([INBOX, 'ideas']);
    });

    it('New task form, nothing chosen - the preselected inbox phase and Ideas', async () => {
      const id = await restCreate(OWNER, {
        title: `B11 DASH form default ${tag()}`, description: '', project: INBOX_PROJECT.name, phaseId: INBOX,
        priority: 'normal', status: 'ideas', tags: [], definitionOfDone: [], constraints: [], subtasks: [], links: [],
      });
      expect(await landing(id)).toEqual([INBOX, 'ideas']);
    });

    it('New task form, a phase and status chosen: they win', async () => {
      const id = await restCreate(OWNER, {
        title: `B11 DASH form chosen ${tag()}`, description: '', project: INBOX_PROJECT.name, phaseId: ACTIVE,
        priority: 'normal', status: 'todo', tags: [], definitionOfDone: [], constraints: [], subtasks: [], links: [],
      });
      expect(await landing(id)).toEqual([ACTIVE, 'todo']);
    });

    it('New task form, "No phase" chosen: sent as null, the backlog wins over the inbox', async () => {
      const id = await restCreate(OWNER, {
        title: `B11 DASH form backlog ${tag()}`, description: '', project: INBOX_PROJECT.name, phaseId: null,
        priority: 'normal', status: 'todo', tags: [], definitionOfDone: [], constraints: [], subtasks: [], links: [],
      });
      expect(await landing(id)).toEqual([null, 'todo']);
    });
  });

  describe('MCP relayhall_task_create (Connector bearer, tools/call)', () => {
    it('no phaseId, no status: the inbox phase, Ideas', async () => {
      const id = await mcpCreate({ title: `B11 MCP default ${tag()}`, project: INBOX_PROJECT.id });
      expect(await landing(id)).toEqual([INBOX, 'ideas']);
    });

    it('explicit phaseId and status: they win', async () => {
      const id = await mcpCreate({ title: `B11 MCP follow-up ${tag()}`, project: INBOX_PROJECT.id, phaseId: ACTIVE, status: 'todo' });
      expect(await landing(id)).toEqual([ACTIVE, 'todo']);
    });

    it('explicit phaseId null: the backlog', async () => {
      const id = await mcpCreate({ title: `B11 MCP backlog ${tag()}`, project: INBOX_PROJECT.id, phaseId: null });
      expect(await landing(id)).toEqual([null, 'todo']);
    });

    it('a Project with no inbox phase keeps today\'s behaviour', async () => {
      const id = await mcpCreate({ title: `B11 MCP plain ${tag()}`, project: PLAIN_PROJECT.id });
      expect(await landing(id)).toEqual([null, 'todo']);
    });
  });

  describe('CLI relayhall create (the real program, Connector bearer)', () => {
    it('no --phase: the inbox phase, Ideas', async () => {
      const id = await cliCreate([`B11 CLI default ${tag()}`, '--project', INBOX_PROJECT.name]);
      expect(await landing(id)).toEqual([INBOX, 'ideas']);
    });

    it('--phase and --status: they win', async () => {
      const id = await cliCreate([`B11 CLI follow-up ${tag()}`, '--project', INBOX_PROJECT.name, '--phase', ACTIVE, '--status', 'todo']);
      expect(await landing(id)).toEqual([ACTIVE, 'todo']);
    });

    it('--phase null: the backlog (with the CLI\'s own default status, Ideas)', async () => {
      const id = await cliCreate([`B11 CLI backlog ${tag()}`, '--project', INBOX_PROJECT.name, '--phase', 'null']);
      expect(await landing(id)).toEqual([null, 'ideas']);
    });

    it('a Project with no inbox phase keeps today\'s behaviour', async () => {
      const id = await cliCreate([`B11 CLI plain ${tag()}`, '--project', PLAIN_PROJECT.name]);
      expect(await landing(id)).toEqual([null, 'ideas']);
    });
  });

  describe('the default is suspended, never redirected, while the inbox phase is archived or restricted', () => {
    it('archived: no phase lands in the backlog with To-Do; restored, the inbox applies again', async () => {
      const archived = await call(OWNER, 'POST', `/phases/${INBOX}/archive`, { revision: await phaseRevision(INBOX) });
      expect(archived.status).toBe(200);
      const id = await restCreate(OWNER, { title: `B11 SUSPENDED archived ${tag()}`, project: INBOX_PROJECT.id });
      expect(await landing(id)).toEqual([null, 'todo']);
      const restored = await call(OWNER, 'POST', `/phases/${INBOX}/unarchive`, { revision: await phaseRevision(INBOX) });
      expect(restored.status).toBe(200);
      const again = await restCreate(OWNER, { title: `B11 RESUMED ${tag()}`, project: INBOX_PROJECT.id });
      expect(await landing(again)).toEqual([INBOX, 'ideas']);
    });

    it('restricted: no phase lands in the backlog with To-Do (a restricted inbox would hide new cards)', async () => {
      await setRestricted(INBOX, true);
      try {
        const id = await mcpCreate({ title: `B11 SUSPENDED restricted ${tag()}`, project: INBOX_PROJECT.id });
        expect(await landing(id)).toEqual([null, 'todo']);
      } finally {
        await setRestricted(INBOX, false);
      }
    });
  });

  it('existing Tasks are untouched: the Task that predates the inbox is exactly where it was', async () => {
    expect(await taskRow(PRE_EXISTING)).toEqual(preExistingRow);
  });
});

// ───────────────────── C4: the compiled Brief names it ───────────────────────

describe('C4 the compiled Brief\'s Project Context names the inbox phase', () => {
  beforeAll(async () => {
    await setInboxDirect(INBOX_PROJECT.id, INBOX);
  });

  it('a Task brief in a Project with an inbox phase carries an "Inbox phase" section naming it', async () => {
    const compiled = await call(OWNER, 'POST', `/tasks/${PRE_EXISTING}/brief`, {});
    expect(compiled.status).toBe(200);
    const brief = String(compiled.json?.brief ?? '');
    const context = brief.slice(brief.indexOf('## Project Context'));
    expect(brief.indexOf('## Project Context')).toBeGreaterThanOrEqual(0);
    expect(context).toContain('### Inbox phase');
    expect(context).toContain('lands in its inbox phase, with status Ideas');
    expect(context).toContain(`"id": "${INBOX}"`);
    expect(context).toContain('"name": "15 · Inbox — to be sorted"');
    expect(context).toContain('"defaultStatus": "ideas"');
  });

  it('a Project with no inbox phase renders no inbox section', async () => {
    const id = await restCreate(OWNER, { title: `B11 BRIEF plain ${tag()}`, project: PLAIN_PROJECT.id });
    const compiled = await call(OWNER, 'POST', `/tasks/${id}/brief`, {});
    expect(compiled.status).toBe(200);
    expect(String(compiled.json?.brief ?? '')).not.toContain('### Inbox phase');
  });

  it('the project-awareness brief carries inboxPhaseId', async () => {
    const compiled = await call(OWNER, 'POST', `/projects/${INBOX_PROJECT.id}/brief`, {});
    expect(compiled.status).toBe(200);
    expect(String(compiled.json?.brief ?? '')).toContain(`"inboxPhaseId": "${INBOX}"`);
  });
});
