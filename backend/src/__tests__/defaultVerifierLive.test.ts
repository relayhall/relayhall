/**
 * Card 41e24358 (design ba22fd01, ratified E298 with Q1 (a), Q2 (b), Q3 (a),
 * Q4 (a), Q5 (a)): the default Verifier per Project and Phase.
 *
 * Proven over a REAL PostgreSQL and the PRODUCTION router, with the MCP ingress
 * mounted the way `server.ts` mounts it:
 *
 *   (A) the inheritance order at creation - explicit, the landing Phase's
 *       default (after the inbox decision), the Project default, none - and
 *       the server-written tasks.verifier_source, with the role rows the
 *       creation transaction materializes;
 *   (B) a default that cannot judge is never set and never refuses the
 *       create; a later change of a default never reassigns an existing card;
 *   (C) the usable predicate's four arms, by name, at the point and in the
 *       list filter, with point/list parity;
 *   (D) the Review warning never blocks: REST PATCH, MCP task_move, REST and
 *       MCP finish, and a create directly in Review;
 *   (E) MCP task_create refuses a non-default Verifier (no card exists
 *       afterwards) and accepts a default;
 *   (F) the default write's gates: owner, administrator, a write grant that
 *       is not ownership, a bearer, a Group-owned Project, a Group value, an
 *       Agent value, an unusable value, and the generic PATCH refusing the
 *       field;
 *   (G) the audit rows: the default write with before/after, its refusals,
 *       the Review warnings and the inherited role write with its source.
 *
 * Mutation proofs (scripts/default-verifier-mutations.py) name the tests here
 * that each mutation must turn red.
 *
 * DESTRUCTIVE: writes principals, credentials, services, groups, projects,
 * phases, tasks, sessions, grants and audit rows. It refuses any deployment
 * database and any non-local host, and FAILS - never skips - without a
 * disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the default-Verifier drill measures stored project, phase, '
    + 'task and audit rows, so it never skips. Load database/init.sql into a disposable database, run npm run '
    + 'migrate, and point RELAYHALL_TEST_DB_URL at it.');
}
const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = decodeURIComponent(parsed.pathname.slice(1));
const localDisposable = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  && /test|contract|fixture/.test(TEST_DB_NAME);
const ciService = process.env.CI === 'true' && parsed.hostname === 'postgres' && TEST_DB_NAME === 'relayhall_ci';
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
  || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod'].includes(TEST_DB_NAME)
  || (!localDisposable && !ciService)) {
  throw new Error('Default-Verifier drill refuses a non-disposable database target');
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
const verifierModule = require('../services/VerifierUsability');

jest.setTimeout(240_000);

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

const tag = (): string => crypto.randomBytes(5).toString('hex');
const key = (label: string): string => `dv-${label}-${crypto.randomUUID()}`;

// ─────────────────────────────── fixtures ────────────────────────────────────

const CREATOR_SCOPES = ['tasks:read', 'tasks:write', 'projects:read', 'reports:read', 'reports:write'];

let OWNER: Caller;      // the person owner of PROJECT
let ADMIN: Caller;      // an administrator session
let OTHER: Caller;      // a person holding a Project write Grant, not the owner
let MEMBER: Caller;     // a person in GROUP, with a write Grant on the Group-owned Project
let CREATOR: Caller;    // a Connector that creates cards (REST and MCP)
let CREATOR_TOKEN: string;

let PERSON_V: string;     // a person who can judge: the Project default
let CONNECTOR_V: string;  // a Connector with tasks:write: a Phase default
let READ_ONLY_C: string;  // a Connector whose only credential lacks tasks:write
let REVOKED_C: string;    // a Connector whose credentials are all revoked
let DISABLED_P: string;   // a disabled person
let GROUP: string;        // a Group principal
let AGENT: string;        // a non-legacy Agent

let PROJECT: { id: string; name: string };
let PHASE_WITH: string;   // a Phase with its own default (CONNECTOR_V)
let PHASE_WITHOUT: string;// a Phase with no default
let INBOX: string;        // PROJECT's inbox phase, with its own default (PERSON_V2)
let PERSON_V2: string;
let PLAIN: { id: string; name: string };      // no defaults anywhere
let GROUP_PROJECT: { id: string; name: string };

async function makePerson(role: string, label: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $1, 'active', $2) RETURNING id`,
    [`dv-${label}-${tag()}`, role],
  );
  return String(result.rows[0].id);
}

async function sessionFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

async function registerConnector(owner: Caller, scopes: string[]): Promise<{ principalId: string; token: string }> {
  const slug = `dv-connector-${tag()}`;
  const registered = await call(owner, 'POST', '/services', {
    slug, name: slug, description: 'Default-Verifier drill connector.', kind: 'connector',
    issueCredential: { scopes, label: slug, transport: 'any' },
  });
  expect(registered.status).toBe(201);
  const row = await pool.query('SELECT principal_id FROM services WHERE slug = $1', [slug]);
  return { principalId: String(row.rows[0].principal_id), token: String(registered.json.onboarding.credential.secretOnce) };
}

async function makeProject(who: Caller, name: string): Promise<{ id: string; name: string }> {
  const created = await call(who, 'POST', '/projects', { name });
  expect(created.status).toBe(201);
  return { id: String(created.json.project.id), name };
}

async function makePhase(projectId: string, name: string, position: number): Promise<string> {
  const created = await call(ADMIN, 'POST', '/phases', { projectId, name, position }, { 'Idempotency-Key': key('phase') });
  expect(created.status).toBe(201);
  return String(created.json.phase.id);
}

async function projectRevision(projectId: string): Promise<string> {
  return String((await pool.query('SELECT revision FROM projects WHERE id = $1', [projectId])).rows[0].revision);
}
async function phaseRevision(phaseId: string): Promise<string> {
  return String((await pool.query('SELECT revision FROM phases WHERE id = $1', [phaseId])).rows[0].revision);
}

/** The default, set with SQL: independent of the route contract under test in (F). */
async function setDefaultDirect(table: 'projects' | 'phases', id: string, principalId: string | null): Promise<void> {
  await pool.query(`UPDATE ${table} SET default_verifier_principal_id = $2 WHERE id = $1`, [id, principalId]);
}

async function putDefault(who: Caller, target: 'projects' | 'phases', id: string, principalId: string | null,
  revision?: string): Promise<Answer> {
  const rev = revision ?? (target === 'projects' ? await projectRevision(id) : await phaseRevision(id));
  return call(who, 'PUT', `/${target}/${id}/default-verifier`, { principalId }, { 'If-Match': rev });
}

async function taskRow(taskId: string): Promise<{ verifier_principal_id: string | null; verifier_source: string | null;
  phase_id: string | null; status: string }> {
  const result = await pool.query(
    'SELECT verifier_principal_id, verifier_source, phase_id, status FROM tasks WHERE id = $1', [taskId]);
  expect(result.rows).toHaveLength(1);
  const row = result.rows[0];
  return { ...row, verifier_principal_id: row.verifier_principal_id ? String(row.verifier_principal_id) : null,
    phase_id: row.phase_id ? String(row.phase_id) : null };
}

async function restCreate(who: Caller, body: Record<string, unknown>): Promise<Answer> {
  const created = await call(who, 'POST', '/tasks', body);
  expect([created.status, created.json?.code]).toEqual([201, undefined]);
  return created;
}

async function verifierRoleLinks(taskId: string, principalId: string): Promise<number> {
  const rows = await pool.query(
    `SELECT 1 FROM access_vehicle_links WHERE task_id = $1 AND vehicle_kind = 'role' AND role = 'verifier'
       AND landed_on_principal_id = $2`, [taskId, principalId]);
  return rows.rows.length;
}

async function auditRows(action: string, resourceId: string): Promise<Array<{ outcome: string; metadata: any }>> {
  const rows = await pool.query(
    `SELECT outcome, metadata FROM audit_events WHERE action = $1 AND resource_id = $2 ORDER BY occurred_at, id`,
    [action, resourceId]);
  return rows.rows.map((row: any) => ({ outcome: row.outcome,
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata }));
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

  OWNER = await sessionFor('owner', await makePerson('user', 'owner'));
  ADMIN = await sessionFor('admin', await makePerson('admin', 'admin'));
  OTHER = await sessionFor('other', await makePerson('user', 'other'));
  MEMBER = await sessionFor('member', await makePerson('user', 'member'));
  PERSON_V = await makePerson('user', 'verifier');
  PERSON_V2 = await makePerson('user', 'verifier-two');
  DISABLED_P = await makePerson('user', 'disabled');

  // The creating Connector, bootstrapped over MCP.
  const creator = await registerConnector(OWNER, CREATOR_SCOPES);
  CREATOR_TOKEN = creator.token;
  CREATOR = { label: 'creator', principalId: creator.principalId, headers: { Authorization: `Bearer ${creator.token}` } };
  const mark = dispatched.length;
  const brief = await mcpCall(CREATOR_TOKEN, 'relayhall_brief_compile', { session: true });
  expect(answersSince(mark, 'POST', /^\/principals\/me\/brief$/)).toEqual([200]);
  expect(mcpFailed(brief)).toBe(false);

  CONNECTOR_V = (await registerConnector(OWNER, ['tasks:read', 'tasks:write'])).principalId;
  READ_ONLY_C = (await registerConnector(OWNER, ['tasks:read'])).principalId;
  REVOKED_C = (await registerConnector(OWNER, ['tasks:read', 'tasks:write'])).principalId;
  await pool.query('UPDATE principal_credentials SET revoked_at = NOW() WHERE principal_id = $1', [REVOKED_C]);

  // The Project, owned by OWNER (set with SQL: ownership is not under test).
  PROJECT = await makeProject(OWNER, `DV drill ${tag()}`);
  await pool.query('UPDATE projects SET owner_principal_id = $1 WHERE id = $2', [OWNER.principalId, PROJECT.id]);
  PHASE_WITH = await makePhase(PROJECT.id, '10 · With a default', 10);
  PHASE_WITHOUT = await makePhase(PROJECT.id, '20 · Without a default', 20);
  INBOX = await makePhase(PROJECT.id, '30 · Inbox', 30);
  PLAIN = await makeProject(OWNER, `DV plain ${tag()}`);
  await pool.query('UPDATE projects SET owner_principal_id = $1 WHERE id = $2', [OWNER.principalId, PLAIN.id]);

  // OTHER holds a Project write Grant: write authority that is not ownership.
  await pool.query(
    `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id)
     VALUES ('principal', $1, 'project', $2, 'write', $3)`, [OTHER.principalId, PROJECT.id, ADMIN.principalId]);

  // A Group, a Group-owned Project, and MEMBER in the Group with a write Grant.
  const group = await call(ADMIN, 'POST', '/groups', { name: `dv group ${tag()}` });
  expect(group.status).toBe(201);
  GROUP = String(group.json.group.id);
  await pool.query(
    `INSERT INTO group_members (group_id, account_principal_id, source, added_by_principal_id)
     VALUES ($1, $2, 'local', $3)`, [GROUP, MEMBER.principalId, ADMIN.principalId]);
  GROUP_PROJECT = await makeProject(ADMIN, `DV group-owned ${tag()}`);
  await pool.query('UPDATE projects SET owner_principal_id = $1 WHERE id = $2', [GROUP, GROUP_PROJECT.id]);
  await pool.query(
    `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id)
     VALUES ('principal', $1, 'project', $2, 'write', $3)`, [MEMBER.principalId, GROUP_PROJECT.id, ADMIN.principalId]);

  // A non-legacy Agent, bound to a card of PLAIN.
  const boundTo = await restCreate(OWNER, { title: `DV agent anchor ${tag()}`, project: PLAIN.id });
  const agent = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, bound_task_id, own_expression)
     VALUES ('agent', $1, $1, 'active', $2, $3, '{"scopes":"parent","objects":[]}'::jsonb) RETURNING id`,
    [`dv-agent-${tag()}`, CONNECTOR_V, String(boundTo.json.task.id)]);
  AGENT = String(agent.rows[0].id);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  jest.restoreAllMocks();
  await pool.end();
});

// ═══════════════════ (A) the inheritance order at creation ═══════════════════

describe('(A) inheritance order: explicit -> landing Phase default -> Project default -> none', () => {
  beforeAll(async () => {
    await setDefaultDirect('projects', PROJECT.id, PERSON_V);
    await setDefaultDirect('phases', PHASE_WITH, CONNECTOR_V);
    await setDefaultDirect('phases', INBOX, PERSON_V2);
  });

  it('order 1 - explicit: a named default wins and is recorded explicit', async () => {
    // PERSON_V2 is the inbox Phase's default; the card lands in PHASE_WITH,
    // whose own default is CONNECTOR_V, yet the explicit choice wins.
    const created = await restCreate(OWNER, { title: `DV explicit ${tag()}`, project: PROJECT.id,
      phaseId: PHASE_WITH, verifierPrincipalId: PERSON_V2 });
    const row = await taskRow(created.json.task.id);
    expect([row.verifier_principal_id, row.verifier_source]).toEqual([PERSON_V2, 'explicit']);
    expect(created.json.task.verifierSource).toBe('explicit');
  });

  it('order 2 - Phase beats Project: the landing Phase default is inherited-phase', async () => {
    const created = await restCreate(OWNER, { title: `DV phase ${tag()}`, project: PROJECT.id, phaseId: PHASE_WITH });
    const row = await taskRow(created.json.task.id);
    expect([row.verifier_principal_id, row.verifier_source]).toEqual([CONNECTOR_V, 'inherited-phase']);
    expect(created.json.warnings).toBeUndefined();
    // The role rows are materialized in the creation transaction (AZ-A10 1(c)).
    expect(await verifierRoleLinks(created.json.task.id, CONNECTOR_V)).toBeGreaterThan(0);
  });

  it('order 2b - the inbox decision comes first: a card without phaseId takes the inbox Phase default', async () => {
    await pool.query('UPDATE projects SET inbox_phase_id = $2 WHERE id = $1', [PROJECT.id, INBOX]);
    try {
      const created = await restCreate(OWNER, { title: `DV inbox ${tag()}`, project: PROJECT.id });
      const row = await taskRow(created.json.task.id);
      expect([row.phase_id, row.verifier_principal_id, row.verifier_source]).toEqual([INBOX, PERSON_V2, 'inherited-phase']);
    } finally {
      await pool.query('UPDATE projects SET inbox_phase_id = NULL WHERE id = $1', [PROJECT.id]);
    }
  });

  it('order 3 - Project default when the landing Phase has none, and for an unphased card', async () => {
    const phased = await restCreate(OWNER, { title: `DV project ${tag()}`, project: PROJECT.id, phaseId: PHASE_WITHOUT });
    const unphased = await restCreate(OWNER, { title: `DV unphased ${tag()}`, project: PROJECT.id, phaseId: null });
    for (const created of [phased, unphased]) {
      const row = await taskRow(created.json.task.id);
      expect([row.verifier_principal_id, row.verifier_source]).toEqual([PERSON_V, 'inherited-project']);
    }
  });

  it('order 4 - none: a Project with no default gives no Verifier, no source and no warning', async () => {
    const created = await restCreate(OWNER, { title: `DV none ${tag()}`, project: PLAIN.id });
    const row = await taskRow(created.json.task.id);
    expect([row.verifier_principal_id, row.verifier_source]).toEqual([null, null]);
    expect(created.json.warnings).toBeUndefined();
  });

  it('the inherited role write is audited with its source and where it came from', async () => {
    const created = await restCreate(OWNER, { title: `DV audited ${tag()}`, project: PROJECT.id, phaseId: PHASE_WITH });
    const rows = await auditRows('task.lifecycle_override.roles', created.json.task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ verifierPrincipalId: CONNECTOR_V, verifierSource: 'inherited-phase',
      inheritedFrom: { phaseId: PHASE_WITH } });
  });

  it('the roles route records assigned, and clearing the Verifier clears the source', async () => {
    const created = await restCreate(OWNER, { title: `DV reassigned ${tag()}`, project: PLAIN.id });
    const id = created.json.task.id;
    const assigned = await call(OWNER, 'PATCH', `/tasks/${id}/roles`, { verifierPrincipalId: PERSON_V });
    expect(assigned.status).toBe(200);
    expect((await taskRow(id)).verifier_source).toBe('assigned');
    const cleared = await call(OWNER, 'PATCH', `/tasks/${id}/roles`, { verifierPrincipalId: null });
    expect(cleared.status).toBe(200);
    expect([(await taskRow(id)).verifier_principal_id, (await taskRow(id)).verifier_source]).toEqual([null, null]);
  });
});

// ═══════ (B) unusable defaults never refuse; changes never reassign ═══════

describe('(B) an unusable default is never set and never refuses; a change never reassigns', () => {
  it('a disabled Project default leaves the card without a Verifier and answers 201 with DEFAULT_VERIFIER_UNUSABLE', async () => {
    const project = await makeProject(OWNER, `DV unusable ${tag()}`);
    const soon = await makePerson('user', 'soon-disabled');
    await setDefaultDirect('projects', project.id, soon);
    const before = await restCreate(OWNER, { title: `DV before ${tag()}`, project: project.id });
    expect((await taskRow(before.json.task.id)).verifier_principal_id).toBe(soon);

    await pool.query(`UPDATE principals SET status = 'disabled' WHERE id = $1`, [soon]);
    const after = await restCreate(OWNER, { title: `DV after ${tag()}`, project: project.id });
    const row = await taskRow(after.json.task.id);
    expect([row.verifier_principal_id, row.verifier_source]).toEqual([null, null]);
    expect(after.json.warnings).toEqual([expect.objectContaining({
      code: 'DEFAULT_VERIFIER_UNUSABLE', source: 'inherited-project', principalId: soon, failedArm: 'principal',
    })]);
    // No silent reassignment: the earlier card keeps the disabled Verifier.
    expect((await taskRow(before.json.task.id)).verifier_principal_id).toBe(soon);
  });

  it('a later change of the default never touches existing cards (no backfill)', async () => {
    const project = await makeProject(OWNER, `DV change ${tag()}`);
    const existing = await restCreate(OWNER, { title: `DV existing ${tag()}`, project: project.id });
    await setDefaultDirect('projects', project.id, PERSON_V);
    expect((await taskRow(existing.json.task.id)).verifier_principal_id).toBeNull();
    const second = await restCreate(OWNER, { title: `DV second ${tag()}`, project: project.id });
    await setDefaultDirect('projects', project.id, PERSON_V2);
    expect((await taskRow(second.json.task.id)).verifier_principal_id).toBe(PERSON_V);
  });

  it('MCP project_get and phase_get show the default Verifier in the concise format', async () => {
    // Introspection tools: no bootstrap needed. The values are set with SQL.
    const reader = await registerConnector(OWNER, ['projects:read', 'phases:read']);
    const project = await makeProject(OWNER, `DV concise ${tag()}`);
    const phase = await makePhase(project.id, '10 · Concise', 10);
    const line = (answer: Answer): string[] => mcpText(answer).split('\n').filter((row) => row.startsWith('default Verifier: '));
    const projectGet = () => mcpCall(reader.token, 'relayhall_project_get', { projectId: project.id });
    const phaseGet = () => mcpCall(reader.token, 'relayhall_phase_get', { phaseId: phase });
    expect(line(await projectGet())).toEqual(['default Verifier: none']);
    expect(line(await phaseGet())).toEqual(['default Verifier: none']);
    await setDefaultDirect('projects', project.id, PERSON_V);
    await setDefaultDirect('phases', phase, CONNECTOR_V);
    expect(line(await projectGet())).toEqual([`default Verifier: ${PERSON_V}`]);
    expect(line(await phaseGet())).toEqual([`default Verifier: ${CONNECTOR_V}`]);
  });
});

// ═════════════════════ (C) the usable predicate's four arms ═════════════════════

describe('(C) the usable predicate: four arms by name, point and list in parity', () => {
  const fixtures: Record<string, string> = {};

  beforeAll(async () => {
    const make = async (label: string, verifier: string | null): Promise<string> => {
      // Fixture state written with SQL, independent of the create and move contracts under test in (D).
      const created = await restCreate(ADMIN, { title: `DV arm ${label} ${tag()}`, project: PLAIN.id });
      const id = String(created.json.task.id);
      await pool.query(`UPDATE tasks SET status = 'review', verifier_principal_id = $2 WHERE id = $1`, [id, verifier]);
      return id;
    };
    fixtures.usablePerson = await make('usable-person', PERSON_V);
    fixtures.usableConnector = await make('usable-connector', CONNECTOR_V);
    fixtures.none = await make('none', null);
    fixtures.principal = await make('principal', DISABLED_P);
    fixtures.chain = await make('chain', REVOKED_C);
    fixtures.scope = await make('scope', READ_ONLY_C);
    await pool.query(`UPDATE principals SET status = 'disabled' WHERE id = $1`, [DISABLED_P]);
  });

  const point = async (taskId: string) => verifierModule.verifierUsability(pool, taskId);

  it('arm none: no Verifier set', async () => {
    expect(await point(fixtures.none)).toEqual({ usable: false, failedArm: 'none', principalId: null });
  });
  it('arm principal: a disabled principal', async () => {
    expect(await point(fixtures.principal)).toEqual({ usable: false, failedArm: 'principal', principalId: DISABLED_P });
  });
  it('arm chain: a Connector whose last credential is revoked', async () => {
    expect(await point(fixtures.chain)).toEqual({ usable: false, failedArm: 'chain', principalId: REVOKED_C });
  });
  it('arm scope: a Connector whose only credential lacks tasks:write', async () => {
    expect(await point(fixtures.scope)).toEqual({ usable: false, failedArm: 'scope', principalId: READ_ONLY_C });
  });
  it('arm independence: the Verifier is the Assignee', async () => {
    // tasks_claimant_verifier_separation keeps this state out of the table, so
    // the arm is measured on the card's two fields directly.
    expect(await verifierModule.verifierUsabilityOf(pool, { verifierPrincipalId: PERSON_V, ownerPrincipalId: PERSON_V }))
      .toEqual({ usable: false, failedArm: 'independence', principalId: PERSON_V });
    expect(await verifierModule.verifierUsabilityOf(pool, { verifierPrincipalId: PERSON_V, ownerPrincipalId: CONNECTOR_V }))
      .toEqual({ usable: true, principalId: PERSON_V });
  });
  it('usable: an active person Account and a live Connector with tasks:write', async () => {
    expect((await point(fixtures.usablePerson))?.usable).toBe(true);
    expect((await point(fixtures.usableConnector))?.usable).toBe(true);
  });

  it('point/list parity: GET /tasks?verifierUnusable=true lists exactly the cards the point check finds unusable', async () => {
    const listed = await call(ADMIN, 'GET', `/tasks?project=${PLAIN.id}&verifierUnusable=true&includeArchived=true&limit=1000`);
    expect(listed.status).toBe(200);
    const listedIds = new Set<string>(listed.json.tasks.map((task: any) => String(task.id)));
    const all = await pool.query('SELECT id FROM tasks WHERE project_id = $1', [PLAIN.id]);
    for (const row of all.rows) {
      const result = await point(String(row.id));
      expect([String(row.id), listedIds.has(String(row.id))]).toEqual([String(row.id), !result.usable]);
    }
    for (const unusable of ['none', 'principal', 'chain', 'scope']) expect(listedIds.has(fixtures[unusable])).toBe(true);
    // Each listed row says why, from the same predicate (the census read).
    const byId = new Map<string, any>(listed.json.tasks.map((task: any) => [String(task.id), task]));
    for (const arm of ['none', 'principal', 'chain', 'scope']) {
      expect(byId.get(fixtures[arm]).verifierUsability).toMatchObject({ usable: false, failedArm: arm });
    }
    for (const usable of ['usablePerson', 'usableConnector']) expect(listedIds.has(fixtures[usable])).toBe(false);
  });

  it('the board read and MCP task_list carry the same filter', async () => {
    const board = await call(ADMIN, 'GET', `/tasks/board?projects=${PLAIN.id}&statuses=review&verifierUnusable=true`);
    expect(board.status).toBe(200);
    const items = (board.json.columns?.review?.items ?? []).map((task: any) => String(task.id));
    expect(items).toEqual(expect.arrayContaining([fixtures.none, fixtures.principal, fixtures.chain, fixtures.scope]));
    expect(items).not.toContain(fixtures.usablePerson);
    const listed = await mcpCall(CREATOR_TOKEN, 'relayhall_task_list',
      { project: PLAIN.id, status: 'review', verifierUnusable: true, response_format: 'detailed', limit: 100 });
    expect(mcpFailed(listed)).toBe(false);
    expect(mcpText(listed)).not.toContain(fixtures.usablePerson);
  });

  it('the Task read carries the predicate for the Review banner', async () => {
    const read = await call(ADMIN, 'GET', `/tasks/${fixtures.chain}`);
    expect(read.json.task.verifierUsability).toEqual({ usable: false, failedArm: 'chain', principalId: REVOKED_C });
  });
});

// ═════════════════════ (D) the Review warning never blocks ═════════════════════

describe('(D) the Review warning never blocks', () => {
  it('never-blocking: REST PATCH into Review without a Verifier answers 200 with the warning, and the move committed', async () => {
    const created = await restCreate(OWNER, { title: `DV move ${tag()}`, project: PLAIN.id, status: 'in-progress' });
    const id = String(created.json.task.id);
    const moved = await call(OWNER, 'PATCH', `/tasks/${id}`, { status: 'review' });
    expect(moved.status).toBe(200);
    expect(moved.json.warnings).toEqual([expect.objectContaining({ code: 'VERIFIER_NOT_USABLE', failedArm: 'none' })]);
    expect(String(moved.json.warning)).toContain('Verifier cannot judge it');
    expect((await taskRow(id)).status).toBe('review');
    const audited = await auditRows('task.review.verifier_warning', id);
    expect(audited).toEqual([expect.objectContaining({ outcome: 'success',
      metadata: expect.objectContaining({ code: 'VERIFIER_NOT_USABLE', failedArm: 'none' }) })]);
  });

  it('never-blocking: a usable Verifier gives no warning', async () => {
    const created = await restCreate(OWNER, { title: `DV usable move ${tag()}`, project: PROJECT.id,
      phaseId: PHASE_WITHOUT, status: 'in-progress' });
    const moved = await call(OWNER, 'PATCH', `/tasks/${created.json.task.id}`, { status: 'review' });
    expect(moved.status).toBe(200);
    expect(moved.json.warnings).toBeUndefined();
  });

  it('never-blocking: MCP task_move prints the warning and is not an error', async () => {
    const created = await mcpCall(CREATOR_TOKEN, 'relayhall_task_create',
      { idempotencyKey: key('mcp-move'), title: `DV mcp move ${tag()}`, project: PLAIN.id, status: 'in-progress' });
    expect(mcpFailed(created)).toBe(false);
    const id = /full id: ([0-9a-f-]{36})/.exec(mcpText(created))![1];
    const mark = dispatched.length;
    const moved = await mcpCall(CREATOR_TOKEN, 'relayhall_task_move', { task: id, status: 'review' });
    expect(answersSince(mark, 'PATCH', new RegExp(`^/tasks/${id}$`))).toEqual([200]);
    expect(mcpFailed(moved)).toBe(false);
    expect(mcpText(moved)).toContain('warning: This card is in Review but its Verifier cannot judge it');
    expect((await taskRow(id)).status).toBe('review');
  });

  it('never-blocking: REST finish into Review answers 200 with the warning', async () => {
    const created = await restCreate(OWNER, { title: `DV finish ${tag()}`, project: PLAIN.id, status: 'in-progress' });
    const id = String(created.json.task.id);
    const finished = await call(OWNER, 'POST', `/tasks/${id}/finish`, { report: { title: 'DV report', content: 'Done.' } });
    expect(finished.status).toBe(200);
    expect(finished.json).toMatchObject({ success: true, status: 'review' });
    expect(finished.json.warnings).toEqual([expect.objectContaining({ code: 'VERIFIER_NOT_USABLE', failedArm: 'none' })]);
    expect((await taskRow(id)).status).toBe('review');
  });

  it('never-blocking: MCP task_finish prints the warning line', async () => {
    const created = await mcpCall(CREATOR_TOKEN, 'relayhall_task_create',
      { idempotencyKey: key('mcp-finish'), title: `DV mcp finish ${tag()}`, project: PLAIN.id, status: 'in-progress' });
    const id = /full id: ([0-9a-f-]{36})/.exec(mcpText(created))![1];
    const finished = await mcpCall(CREATOR_TOKEN, 'relayhall_task_finish',
      { task: id, report: { title: 'DV report', content: 'Done.' } });
    expect(mcpFailed(finished)).toBe(false);
    expect(mcpText(finished)).toContain('warning: This card is in Review but its Verifier cannot judge it');
    expect((await taskRow(id)).status).toBe('review');
  });

  it('never-blocking: a card created directly in Review without a Verifier answers 201 with the warning', async () => {
    const created = await restCreate(OWNER, { title: `DV born review ${tag()}`, project: PLAIN.id, status: 'review' });
    expect(created.json.warnings).toEqual([expect.objectContaining({ code: 'VERIFIER_NOT_USABLE', failedArm: 'none' })]);
  });

  it('never-blocking control: an evaluation failure yields no warning and still answers 200', async () => {
    const created = await restCreate(OWNER, { title: `DV throws ${tag()}`, project: PLAIN.id, status: 'in-progress' });
    const spy = jest.spyOn(verifierModule, 'verifierUsability').mockRejectedValueOnce(new Error('evaluation down'));
    try {
      const moved = await call(OWNER, 'PATCH', `/tasks/${created.json.task.id}`, { status: 'review' });
      expect(moved.status).toBe(200);
      expect((await taskRow(created.json.task.id)).status).toBe('review');
    } finally {
      spy.mockRestore();
    }
  });
});

// ═══════════════ (E) MCP task_create: defaults only (Q2 (b)) ═══════════════

describe('(E) MCP task_create names a Verifier only when it is a default', () => {
  it('mcp-refusal: a non-default principal is refused VERIFIER_NOT_ALLOWED and no card exists', async () => {
    const title = `DV refused ${tag()}`;
    const mark = dispatched.length;
    const refused = await mcpCall(CREATOR_TOKEN, 'relayhall_task_create',
      { idempotencyKey: key('mcp-refuse'), title, project: PROJECT.id, verifierPrincipalId: OTHER.principalId });
    expect(answersSince(mark, 'POST', /^\/tasks$/)).toEqual([422]);
    expect(mcpFailed(refused)).toBe(true);
    expect(JSON.stringify(refused.json)).toContain('VERIFIER_NOT_ALLOWED');
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM tasks WHERE title = $1', [title]);
    expect(count.rows[0].n).toBe(0);
  });

  it('mcp-refusal: a default that cannot judge is refused too', async () => {
    const project = await makeProject(OWNER, `DV unusable explicit ${tag()}`);
    await setDefaultDirect('projects', project.id, READ_ONLY_C);
    const refused = await mcpCall(CREATOR_TOKEN, 'relayhall_task_create',
      { idempotencyKey: key('mcp-unusable'), title: `DV unusable ${tag()}`, project: project.id, verifierPrincipalId: READ_ONLY_C });
    expect(mcpFailed(refused)).toBe(true);
    expect(JSON.stringify(refused.json)).toContain('VERIFIER_NOT_ALLOWED');
  });

  it('mcp-refusal: an archived Phase default named explicitly is refused over MCP and REST', async () => {
    // The Phase default counts only while its Phase is not archived (design
    // Part 6, Q2 (b)). The same principal is accepted first, while the Phase
    // is live, so the refusal below is the archive and nothing else.
    const project = await makeProject(OWNER, `DV archived phase ${tag()}`);
    const phase = await makePhase(project.id, '10 · Soon archived', 10);
    const verifier = await makePerson('user', 'archived-phase-verifier');
    await setDefaultDirect('phases', phase, verifier);
    const live = await mcpCall(CREATOR_TOKEN, 'relayhall_task_create',
      { idempotencyKey: key('mcp-archived-live'), title: `DV live phase ${tag()}`, project: project.id, verifierPrincipalId: verifier });
    expect(mcpFailed(live)).toBe(false);
    await pool.query("UPDATE phases SET status = 'archived' WHERE id = $1", [phase]);
    const title = `DV archived phase ${tag()}`;
    const mark = dispatched.length;
    const refused = await mcpCall(CREATOR_TOKEN, 'relayhall_task_create',
      { idempotencyKey: key('mcp-archived'), title, project: project.id, verifierPrincipalId: verifier });
    expect(answersSince(mark, 'POST', /^\/tasks$/)).toEqual([422]);
    expect(mcpFailed(refused)).toBe(true);
    expect(JSON.stringify(refused.json)).toContain('VERIFIER_NOT_ALLOWED');
    const rest = await call(OWNER, 'POST', '/tasks', { title, project: project.id, verifierPrincipalId: verifier });
    expect([rest.status, rest.json?.code]).toEqual([422, 'VERIFIER_NOT_ALLOWED']);
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM tasks WHERE title = $1', [title]);
    expect(count.rows[0].n).toBe(0);
  });

  it('mcp-acceptance: the Project default and a Phase default are accepted and recorded explicit', async () => {
    for (const verifier of [PERSON_V, CONNECTOR_V]) {
      const created = await mcpCall(CREATOR_TOKEN, 'relayhall_task_create',
        { idempotencyKey: key('mcp-accept'), title: `DV accepted ${tag()}`, project: PROJECT.id,
          phaseId: PHASE_WITHOUT, verifierPrincipalId: verifier });
      expect(mcpFailed(created)).toBe(false);
      const id = /full id: ([0-9a-f-]{36})/.exec(mcpText(created))![1];
      const row = await taskRow(id);
      expect([row.verifier_principal_id, row.verifier_source]).toEqual([verifier, 'explicit']);
    }
  });

  it('the generic PATCH and every other role field on create stay refused', async () => {
    const created = await restCreate(OWNER, { title: `DV patch ${tag()}`, project: PLAIN.id });
    const patched = await call(OWNER, 'PATCH', `/tasks/${created.json.task.id}`, { verifierPrincipalId: PERSON_V });
    expect([patched.status, patched.json?.code]).toEqual([400, 'SERVER_WRITTEN_FIELD']);
    const shepherd = await call(OWNER, 'POST', '/tasks', { title: 'x', project: PLAIN.id, shepherdPrincipalId: PERSON_V });
    expect([shepherd.status, shepherd.json?.code]).toEqual([400, 'SERVER_WRITTEN_FIELD']);
    const source = await call(OWNER, 'POST', '/tasks', { title: 'x', project: PLAIN.id, verifierSource: 'explicit' });
    expect([source.status, source.json?.code]).toEqual([400, 'SERVER_WRITTEN_FIELD']);
  });
});

// ═════════════════════ (F) the default write's gates ═════════════════════

describe('(F) the default write: session-only, owner/administrator, person or Connector values', () => {
  it('route-gate owner: the person owner sets and clears the Project default; the read carries it', async () => {
    const set = await putDefault(OWNER, 'projects', PLAIN.id, PERSON_V);
    expect(set.status).toBe(200);
    expect(set.json.project.defaultVerifierPrincipalId).toBe(PERSON_V);
    const read = await call(OWNER, 'GET', `/projects/${PLAIN.id}`);
    expect(read.json.project.defaultVerifierPrincipalId).toBe(PERSON_V);
    const cleared = await putDefault(OWNER, 'projects', PLAIN.id, null);
    expect([cleared.status, cleared.json.project.defaultVerifierPrincipalId]).toEqual([200, null]);
    const rows = await auditRows('project.default_verifier.set', PLAIN.id);
    expect(rows.filter((row) => row.outcome === 'success').map((row) => [row.metadata.previous, row.metadata.next]))
      .toEqual([[null, PERSON_V], [PERSON_V, null]]);
    expect(rows[0].metadata).toMatchObject({ projectId: PLAIN.id, standing: 'owner' });
  });

  it('route-gate owner: the person owner sets a Phase default (a Phase resolves to its Project owner)', async () => {
    const set = await putDefault(OWNER, 'phases', PHASE_WITHOUT, CONNECTOR_V);
    expect([set.status, set.json.phase.defaultVerifierPrincipalId]).toEqual([200, CONNECTOR_V]);
    const read = await call(OWNER, 'GET', `/phases/${PHASE_WITHOUT}`);
    expect(read.json.phase.defaultVerifierPrincipalId).toBe(CONNECTOR_V);
    expect((await auditRows('phase.default_verifier.set', PHASE_WITHOUT))[0].metadata)
      .toMatchObject({ previous: null, next: CONNECTOR_V, projectId: PROJECT.id, phaseId: PHASE_WITHOUT });
    expect((await putDefault(OWNER, 'phases', PHASE_WITHOUT, null)).status).toBe(200);
  });

  it('route-gate admin: an administrator session sets the default', async () => {
    expect((await putDefault(ADMIN, 'projects', PLAIN.id, PERSON_V2)).status).toBe(200);
    expect((await putDefault(ADMIN, 'projects', PLAIN.id, null)).status).toBe(200);
  });

  it('route-gate grant: a Project write Grant is not ownership', async () => {
    const refused = await putDefault(OTHER, 'projects', PROJECT.id, PERSON_V);
    expect([refused.status, refused.json?.code]).toEqual([403, 'DEFAULT_VERIFIER_REQUIRES_OWNER']);
    const denied = (await auditRows('project.default_verifier.set', PROJECT.id)).filter((row) => row.outcome === 'denied');
    expect(denied.map((row) => row.metadata.refusal)).toContain('DEFAULT_VERIFIER_REQUIRES_OWNER');
  });

  it('route-gate readable non-owner: read on the Phase or on its Project reaches the named 403 on the Phase route, audited once each', async () => {
    // Owner ruling E311 (card 5216d735): a caller who can READ the Phase - read
    // on it, or read on its Project - and is not root, an administrator or the
    // person owner gets the Project route's refusal on the Phase route, by
    // name and audited, never the concealed 404. OTHER holds a Project write
    // Grant; READER holds a read Grant on the Phase alone. Nothing changes.
    const reader = await sessionFor('reader', await makePerson('user', 'reader'));
    await pool.query(
      `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id)
       VALUES ('principal', $1, 'phase', $2, 'read', $3)`, [reader.principalId, PHASE_WITHOUT, ADMIN.principalId]);
    const project = await putDefault(OTHER, 'projects', PROJECT.id, PERSON_V);
    const throughProject = await putDefault(OTHER, 'phases', PHASE_WITHOUT, PERSON_V);
    const throughPhase = await putDefault(reader, 'phases', PHASE_WITHOUT, PERSON_V);
    expect([project, throughProject, throughPhase].map((answer) => [answer.status, answer.json?.code])).toEqual([
      [403, 'DEFAULT_VERIFIER_REQUIRES_OWNER'], [403, 'DEFAULT_VERIFIER_REQUIRES_OWNER'], [403, 'DEFAULT_VERIFIER_REQUIRES_OWNER']]);
    const denied = await pool.query(
      `SELECT actor_principal_id::text AS actor, metadata->>'refusal' AS refusal FROM audit_events
        WHERE action = 'phase.default_verifier.set' AND resource_id = $1 AND outcome = 'denied'
          AND actor_principal_id = ANY($2::uuid[]) ORDER BY occurred_at, id`, [PHASE_WITHOUT, [OTHER.principalId, reader.principalId]]);
    expect(denied.rows.map((row: any) => [row.actor, row.refusal])).toEqual([
      [OTHER.principalId, 'DEFAULT_VERIFIER_REQUIRES_OWNER'], [reader.principalId, 'DEFAULT_VERIFIER_REQUIRES_OWNER']]);
    expect((await pool.query('SELECT default_verifier_principal_id FROM phases WHERE id = $1', [PHASE_WITHOUT])).rows[0].default_verifier_principal_id).toBeNull();
  });

  it('route-gate unreadable: a caller who can read neither the Phase nor its Project is concealed 404 on both routes, with no audit row', async () => {
    // The concealment rule stands (E311): absent and unreadable are one answer,
    // and the refusal leaves no row naming the object.
    const stranger = await sessionFor('stranger', await makePerson('user', 'stranger'));
    const hidden = [await putDefault(stranger, 'projects', PROJECT.id, PERSON_V), await putDefault(stranger, 'phases', PHASE_WITHOUT, PERSON_V)];
    expect(hidden.map((answer) => [answer.status, answer.json?.code])).toEqual([[404, 'RESOURCE_NOT_FOUND'], [404, 'RESOURCE_NOT_FOUND']]);
    const rows = await pool.query(
      `SELECT action FROM audit_events WHERE action LIKE '%.default_verifier.set' AND actor_principal_id = $1`, [stranger.principalId]);
    expect(rows.rows).toEqual([]);
    expect((await pool.query('SELECT default_verifier_principal_id FROM phases WHERE id = $1', [PHASE_WITHOUT])).rows[0].default_verifier_principal_id).toBeNull();
  });

  it('route-gate restricted Phase: read on its Project alone does not reach a restricted Phase, which stays concealed 404 with no audit row', async () => {
    // A restricted Phase suppresses what its Project lends (ruling 44ee41f2),
    // so a Project grantee cannot read it, and the refusal conceals it.
    const restricted = await makePhase(PROJECT.id, '40 · Restricted', 40);
    const access = await call(ADMIN, 'PATCH', `/phases/${restricted}/access`,
      { revision: await phaseRevision(restricted), restricted: true, reason: 'Default-Verifier drill: a restricted Phase.' });
    expect(access.status).toBe(200);
    const answer = await putDefault(OTHER, 'phases', restricted, PERSON_V);
    expect([answer.status, answer.json?.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    expect((await auditRows('phase.default_verifier.set', restricted))).toEqual([]);
    expect((await pool.query('SELECT default_verifier_principal_id FROM phases WHERE id = $1', [restricted])).rows[0].default_verifier_principal_id).toBeNull();
  });

  it('route-gate bearer: a Connector credential is refused SESSION_ONLY and audited', async () => {
    const refused = await call(CREATOR, 'PUT', `/projects/${PROJECT.id}/default-verifier`, { principalId: PERSON_V },
      { 'If-Match': await projectRevision(PROJECT.id) });
    expect([refused.status, refused.json?.code]).toEqual([403, 'SESSION_ONLY']);
    const denied = (await auditRows('project.default_verifier.set', PROJECT.id)).filter((row) => row.outcome === 'denied');
    expect(denied.map((row) => row.metadata.refusal)).toContain('SESSION_ONLY');
  });

  it('route-gate group-owned: only root or an administrator on a Group-owned Project (Q3 (a))', async () => {
    const member = await putDefault(MEMBER, 'projects', GROUP_PROJECT.id, PERSON_V);
    expect([member.status, member.json?.code]).toEqual([403, 'DEFAULT_VERIFIER_REQUIRES_OWNER']);
    const admin = await putDefault(ADMIN, 'projects', GROUP_PROJECT.id, PERSON_V);
    expect(admin.status).toBe(200);
  });

  it('route-gate values: a Group and an Agent are refused by name, an unusable principal names its arm', async () => {
    const group = await putDefault(OWNER, 'projects', PLAIN.id, GROUP);
    expect([group.status, group.json?.code]).toEqual([422, 'DEFAULT_VERIFIER_GROUP_PRINCIPAL']);
    const agent = await putDefault(OWNER, 'projects', PLAIN.id, AGENT);
    expect([agent.status, agent.json?.code]).toEqual([422, 'DEFAULT_VERIFIER_AGENT_PRINCIPAL']);
    const unusable = await putDefault(OWNER, 'phases', PHASE_WITHOUT, READ_ONLY_C);
    expect([unusable.status, unusable.json?.code, unusable.json?.details?.failedArm])
      .toEqual([422, 'DEFAULT_VERIFIER_UNUSABLE', 'scope']);
    // The trigger is the backstop under the route.
    await expect(setDefaultDirect('projects', PLAIN.id, GROUP)).rejects.toThrow(/Group principal never acts/);
    await expect(setDefaultDirect('phases', PHASE_WITHOUT, AGENT)).rejects.toThrow(/Agent is bound to one Task/);
  });

  it('route-gate revision: a stale If-Match is refused and nothing changes', async () => {
    const stale = await putDefault(OWNER, 'projects', PLAIN.id, PERSON_V, '00000000-0000-4000-8000-000000000000');
    expect([stale.status, stale.json?.code]).toEqual([412, 'REVISION_MISMATCH']);
    const missing = await call(OWNER, 'PUT', `/projects/${PLAIN.id}/default-verifier`, { principalId: PERSON_V });
    expect([missing.status, missing.json?.code]).toEqual([400, 'REVISION_REQUIRED']);
  });

  it('the generic PATCH routes refuse the field, so the MCP project/phase update tools cannot reach it', async () => {
    const project = await call(OWNER, 'PATCH', `/projects/${PLAIN.id}`, { defaultVerifierPrincipalId: PERSON_V },
      { 'If-Match': await projectRevision(PLAIN.id) });
    expect([project.status, project.json?.code]).toEqual([400, 'UNKNOWN_FIELD']);
    const phase = await call(OWNER, 'PATCH', `/phases/${PHASE_WITHOUT}`,
      { revision: await phaseRevision(PHASE_WITHOUT), defaultVerifierPrincipalId: PERSON_V });
    expect(phase.status).toBe(400);
  });
});

// ═════════════════════ the picker's candidates ═════════════════════

describe('the default-Verifier picker lists exactly the principals the predicate accepts', () => {
  it('candidates: usable people and Connectors, never a Group, an Agent or an unusable principal', async () => {
    const listed = await call(OWNER, 'GET', `/projects/${PROJECT.id}/default-verifier/candidates`);
    expect(listed.status).toBe(200);
    const ids = new Set<string>(listed.json.candidates.map((candidate: any) => String(candidate.id)));
    for (const usable of [PERSON_V, PERSON_V2, CONNECTOR_V]) expect(ids.has(usable)).toBe(true);
    for (const excluded of [GROUP, AGENT, READ_ONLY_C, REVOKED_C, DISABLED_P]) expect(ids.has(excluded)).toBe(false);
    for (const candidate of listed.json.candidates) {
      expect((await verifierModule.principalVerifierUsability(pool, String(candidate.id))).usable).toBe(true);
    }
  });
});
