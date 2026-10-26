/**
 * Card 311229fd - AZ-A12 build 3: the Group ownership transfer act (amendment
 * AZ-A12 clauses 9, 10(b), 12 (the owner selector) and 14, RATIFIED 2026-10-10,
 * ruling E72; rulings E58 and E59).
 *
 * Over a REAL PostgreSQL and the PRODUCTION router (and the MCP route), it
 * measures the transfer gates of G.2 drill 6 and the act's own controls:
 *
 *   - 9(e) the standing test: a bearer credential (a Main-appointed Connector
 *     holding projects:admin, and the MCP tool) is refused
 *     GROUP_OWNER_SESSION_ONLY; a session that is neither root nor an
 *     administrator is refused GROUP_OWNER_REQUIRES_ADMINISTRATOR; a missing,
 *     foreign-act or foreign-object step-up is refused STEP_UP_REQUIRED with
 *     the SU-14 challenge. Steps 1 and 2 refuse BEFORE the token is consumed:
 *     the token is still live afterwards and spends on the next, admitted act.
 *     Each refusal is audited OUTSIDE the rolled-back transaction: the denied
 *     row exists while the object is unchanged;
 *   - root (an admin session) and an administrator (an operator session) with
 *     step-up move a Project and a Task into, out of and between Groups;
 *     clearing a Group-owned Project; the break-glass dashboard JWT reaches the
 *     Project act and not the Task act (R87);
 *   - the Group target checks of 9(a): a disabled Group principal is refused;
 *   - the undo (E59 (b)): an operator moves a Project into a Group and back,
 *     both audited deciderStanding 'administrator'; a Task's undo pins an
 *     explicit person and a later Project transfer leaves it with that person;
 *     a Group-owned Task cannot be cleared;
 *   - 9(d) grants are untouched; 9(f) the audit row's fields;
 *   - the person-to-person path is unchanged (no step-up, no new audit keys,
 *     the appointed Main arm still decides);
 *   - 10(b) creation with a Group owner is create + transfer in one
 *     transaction under the same deciders; a person owner at create is refused;
 *   - 12 the owner selector lists Groups (featured first, enabled only) to root
 *     and administrator sessions only;
 *   - 14 the administrator exception is act-scoped: an operator session with a
 *     step-up is still refused Group enable/disable and Group-role appointment.
 *
 * DESTRUCTIVE: writes principals, groups, members, projects, tasks, grants,
 * credentials, sessions, step-up tokens and audit rows. It refuses any
 * deployment database and any non-local host, and FAILS - never skips -
 * without a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the Group ownership transfer drill measures stored owners, '
    + 'step-up tokens and audit rows, so it never skips. Load database/init.sql into a disposable database, '
    + 'run npm run migrate, and point RELAYHALL_TEST_DB_URL at it.');
}
const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = decodeURIComponent(parsed.pathname.slice(1));
const localDisposable = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  && /test|contract|fixture/.test(TEST_DB_NAME);
const ciService = process.env.CI === 'true' && parsed.hostname === 'postgres' && TEST_DB_NAME === 'relayhall_ci';
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
  || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod'].includes(TEST_DB_NAME)
  || (!localDisposable && !ciService)) {
  throw new Error('Group ownership transfer drill refuses a non-disposable database target');
}

Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: TEST_DB_NAME,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
});

const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware, actorFromRequest } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { principalService } = require('../services/PrincipalService');
const { stepUpService } = require('../services/StepUpService');
const { projectOwnershipService } = require('../services/ProjectOwnershipService');
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');
const { insertGroupRow } = require('./support/groupRows');

jest.setTimeout(240_000);

type Caller = { label: string; id: string; headers: Record<string, string>; credentialId?: string };
type Answer = { status: number; json: any; replayed: string | null };

let server: http.Server;
let origin: string;
const captured = new Map<string, any>();
const tag = (): string => crypto.randomBytes(5).toString('hex');
const SYSTEM = { handle: 'group-ownership-transfer-live-fixture', authMethod: 'system' as const };
const ACT = 'ownership.transfer';
const REASON = 'AZ-A12 build 3 drill transfer';

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
  return { status: response.status, json, replayed: response.headers.get('retry-replayed') };
}

async function account(label: string, role: string | null = 'editor'): Promise<Caller> {
  const row = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role) VALUES ('human', $1, $1, 'active', $2) RETURNING id`,
    [`aza12b3-${label}-${tag()}`, role],
  );
  const id = String(row.rows[0].id);
  const session = await loginSessionService.mint({ principalId: id });
  return { label, id, headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.token}` } };
}

/** A Connector under `parent`, with a bearer credential holding the admin scopes the routes ask for. */
async function connectorOf(parent: Caller, transport = 'any'): Promise<Caller> {
  const row = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, $1, 'active', 'user', $2, 'AZ-A12 build 3 drill connector', $3::jsonb) RETURNING id`,
    [`aza12b3-connector-${tag()}`, parent.id, JSON.stringify({ scopes: 'parent', objects: 'parent' })],
  );
  const id = String(row.rows[0].id);
  const credential = await principalService.issueCredential({
    principalId: id, transport,
    scopes: ['projects:read', 'projects:write', 'projects:admin', 'tasks:read', 'tasks:write', 'tasks:admin'],
  }, SYSTEM);
  return { label: 'connector', id, credentialId: credential.credentialId, headers: { Authorization: `Bearer ${credential.fullKey}` } };
}

/**
 * A bearer credential held by the Account `owner` ITSELF, so a login session
 * and a bearer credential act as the SAME principal. The issuance policy never
 * mints one (Accounts are keyless, A17.1), but the authenticator accepts a
 * stored row for an Account, and the retry scope must not depend on the
 * issuance policy holding: the credential is issued through the policy to a
 * Connector of `owner` and then rebound to the Account directly.
 */
async function accountBearerOf(owner: Caller): Promise<Caller> {
  const carrier = await connectorOf(owner);
  await pool.query('UPDATE principal_credentials SET principal_id = $2 WHERE id = $1', [carrier.credentialId, owner.id]);
  return { label: 'account-bearer', id: owner.id, credentialId: carrier.credentialId, headers: carrier.headers };
}

const newGroup = (label: string, featured = false): Promise<string> =>
  insertGroupRow(pool, { name: `aza12b3 ${label} ${tag()}`, description: 'AZ-A12 build 3 drill', featured });

async function join(groupId: string, accountId: string): Promise<void> {
  await pool.query("INSERT INTO group_members (group_id, account_principal_id, source) VALUES ($1, $2, 'local')", [groupId, accountId]);
}

async function project(owner: string | null): Promise<string> {
  const row = await pool.query(
    `INSERT INTO projects (name, status, visibility, owner_principal_id) VALUES ($1, 'active', 'private', $2) RETURNING id`,
    [`aza12b3 project ${tag()}`, owner],
  );
  return String(row.rows[0].id);
}
async function task(projectId: string | null, accountOwner: string | null = null): Promise<string> {
  const row = await pool.query(
    `INSERT INTO tasks (title, status, visibility, project_id, creator_principal_id, account_owner_principal_id)
     VALUES ($1, 'todo', 'private', $2, $3, $4) RETURNING id`,
    [`aza12b3 task ${tag()}`, projectId, FIXTURE_CREATOR.id, accountOwner],
  );
  return String(row.rows[0].id);
}

/** A single-use step-up for `who`, bound to (action, target); returns the token and its row id. */
async function stepUp(who: Caller, targetId: string, action = ACT): Promise<{ token: string; tokenId: string }> {
  const minted = await stepUpService.mint(who.id, action, targetId, 'password');
  return { token: minted.token, tokenId: minted.tokenId };
}
async function tokenLive(tokenId: string): Promise<boolean> {
  const row = await pool.query('SELECT consumed_at FROM step_up_tokens WHERE id = $1', [tokenId]);
  return row.rows.length === 1 && row.rows[0].consumed_at === null;
}

async function projectOwner(projectId: string): Promise<string | null> {
  const row = await pool.query('SELECT owner_principal_id FROM projects WHERE id = $1', [projectId]);
  return row.rows[0]?.owner_principal_id ? String(row.rows[0].owner_principal_id) : null;
}
async function taskOwner(taskId: string): Promise<{ explicit: string | null; effective: string | null }> {
  const row = await pool.query(`SELECT t.account_owner_principal_id AS explicit,
      COALESCE(t.account_owner_principal_id, p.owner_principal_id) AS effective
     FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = $1`, [taskId]);
  const r = row.rows[0];
  return { explicit: r.explicit ? String(r.explicit) : null, effective: r.effective ? String(r.effective) : null };
}

/** PUT /projects/:id/owner under the stored revision. */
async function moveProject(who: Caller, projectId: string, ownerId: string | null, token?: string): Promise<Answer> {
  const revision = (await pool.query('SELECT revision FROM projects WHERE id = $1', [projectId])).rows[0].revision;
  return call(who, 'PUT', `/projects/${projectId}/owner`,
    token === undefined ? { ownerPrincipalId: ownerId } : { ownerPrincipalId: ownerId, stepUpToken: token },
    { 'If-Match': String(revision) });
}
/** PUT /tasks/:id/account-owner under the stored preconditions. */
function taskBody(state: { effective: string | null; updatedAt: string }, target: string, token?: string): Record<string, unknown> {
  return {
    accountOwnerPrincipalId: target, expectedAccountOwnerPrincipalId: state.effective,
    expectedUpdatedAt: state.updatedAt, reason: REASON, ...(token === undefined ? {} : { stepUpToken: token }),
  };
}
async function moveTask(who: Caller, taskId: string, target: string, token?: string): Promise<Answer> {
  const owner = await taskOwner(taskId);
  const updatedAt = (await pool.query('SELECT updated_at::text AS u FROM tasks WHERE id = $1', [taskId])).rows[0].u;
  return call(who, 'PUT', `/tasks/${taskId}/account-owner`, taskBody({ effective: owner.effective, updatedAt }, target, token));
}

async function audits(resourceId: string, action: string): Promise<Array<{ outcome: string; metadata: any }>> {
  const rows = await pool.query(
    `SELECT outcome, metadata FROM audit_events WHERE resource_id = $1 AND action = $2 ORDER BY occurred_at, id`,
    [resourceId, action]);
  return rows.rows.map((row: any) => ({ outcome: String(row.outcome), metadata: row.metadata }));
}

/** The actor the production middleware builds for this caller, captured on a real request. */
async function actorOf(who: Caller): Promise<any> {
  captured.delete(who.id);
  await call(who, 'GET', '/tasks?limit=1');
  const actor = captured.get(who.id);
  expect(actor).toBeDefined();
  return actor;
}

let FIXTURE_CREATOR: Caller;
let ROOT: Caller;       // an admin-role login session: derives root
let OPERATOR: Caller;   // an operator-role login session: an administrator, not root
let EDITOR: Caller;     // an editor-role login session
let PERSON: Caller;     // a person owner and target
let OTHER: Caller;      // a second person target
let DASHBOARD: Caller;  // the break-glass dashboard JWT (dashboard_user, orchestrator)
let G: string;          // an enabled Group with two active members
let H: string;          // a second enabled Group

beforeAll(async () => {
  await pool.query("INSERT INTO principals(kind,handle,status,role) VALUES('human','dashboard_user','active','orchestrator') ON CONFLICT(handle) DO NOTHING");
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  app.use(MCP_ROUTE_PATH, mcpRoutes);
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, (req: any, _res: any, next: any) => {
      const actor = actorFromRequest(req);
      if (actor.principalId) captured.set(actor.principalId, actor);
      next();
    }, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;

  FIXTURE_CREATOR = await account('creator', 'editor');
  ROOT = await account('root', 'admin');
  OPERATOR = await account('operator', 'operator');
  EDITOR = await account('editor', 'editor');
  PERSON = await account('person', 'editor');
  OTHER = await account('other', 'editor');
  const dashboard = await pool.query("SELECT id FROM principals WHERE handle = 'dashboard_user'");
  const dashboardId = String(dashboard.rows[0].id);
  const dashboardToken = jwt.sign({ v: 2, sub: dashboardId, handle: 'dashboard_user', kind: 'human' }, process.env.JWT_SECRET, { expiresIn: '30m' });
  DASHBOARD = { label: 'dashboard', id: dashboardId, headers: { Authorization: `Bearer ${dashboardToken}` } };
  G = await newGroup('G');
  H = await newGroup('H');
  await join(G, PERSON.id);
  await join(G, OTHER.id);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('clause 9(e): the standing test, before the token is consumed', () => {
  it('a Main-appointed Connector holding projects:admin is refused person -> Group GROUP_OWNER_SESSION_ONLY, and still moves person -> person', async () => {
    const owner = await account('main-owner', 'admin');
    const main = await connectorOf(owner);
    await pool.query('UPDATE principals SET owner_control_account_id = $2 WHERE id = $1', [main.id, owner.id]);
    const P = await project(owner.id);
    const { token, tokenId } = await stepUp(main, P);
    const refused = await moveProject(main, P, G, token);
    expect([refused.status, refused.json?.code]).toEqual([403, 'GROUP_OWNER_SESSION_ONLY']);
    expect(await tokenLive(tokenId)).toBe(true);
    expect(await projectOwner(P)).toBe(owner.id);
    const person = await moveProject(main, P, PERSON.id);
    expect([person.status, person.json?.project?.ownerPrincipalId]).toEqual([200, PERSON.id]);
  });

  it('a bearer without a token is refused GROUP_OWNER_SESSION_ONLY, never STEP_UP_REQUIRED, on both acts', async () => {
    const main = await connectorOf(ROOT);
    const P = await project(PERSON.id);
    const T = await task(P);
    const onProject = await moveProject(main, P, G);
    expect([onProject.status, onProject.json?.code]).toEqual([403, 'GROUP_OWNER_SESSION_ONLY']);
    const onTask = await moveTask(main, T, G);
    expect([onTask.status, onTask.json?.code]).toEqual([403, 'GROUP_OWNER_SESSION_ONLY']);
  });

  it('the refusal is audited outside the rolled-back transaction: the denied row exists, the object is unchanged', async () => {
    const main = await connectorOf(ROOT);
    const P = await project(PERSON.id);
    const refused = await moveProject(main, P, G);
    expect(refused.status).toBe(403);
    expect(await projectOwner(P)).toBe(PERSON.id);
    const rows = await audits(P, 'project.owner.change');
    expect(rows.map((r) => [r.outcome, r.metadata.refusal, r.metadata.clause, r.metadata.newOwnerKind]))
      .toEqual([['denied', 'GROUP_OWNER_SESSION_ONLY', 'AZ-A12 clause 9(e)', 'group']]);
    const noToken = await moveProject(OPERATOR, P, G);
    expect([noToken.status, noToken.json?.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    expect((await audits(P, 'project.owner.change')).map((r) => [r.outcome, r.metadata.refusal]))
      .toEqual([['denied', 'GROUP_OWNER_SESSION_ONLY'], ['denied', 'STEP_UP_REQUIRED']]);
    expect(await projectOwner(P)).toBe(PERSON.id);
  });

  it('the MCP tool relayhall_task_account_owner_change is refused GROUP_OWNER_SESSION_ONLY for a Group target', async () => {
    const main = await connectorOf(ROOT, 'mcp');
    const P = await project(PERSON.id);
    const T = await task(P);
    const mcp = async (name: string, args: Record<string, unknown>): Promise<any> => {
      const response = await fetch(origin + MCP_ROUTE_PATH, {
        method: 'POST',
        headers: { ...main.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      return response.json();
    };
    const brief = await mcp('relayhall_brief_compile', { session: true });
    expect(brief.result?.isError).not.toBe(true);
    const state = await taskOwner(T);
    const updatedAt = (await pool.query('SELECT updated_at::text AS u FROM tasks WHERE id = $1', [T])).rows[0].u;
    const answer = await mcp('relayhall_task_account_owner_change', {
      task: T, accountOwnerPrincipalId: G, expectedAccountOwnerPrincipalId: state.effective, expectedUpdatedAt: updatedAt, reason: REASON,
    });
    const text = JSON.stringify(answer);
    expect([Boolean(answer.error || answer.result?.isError), text.includes('GROUP_OWNER_SESSION_ONLY')]).toEqual([true, true]);
    expect((await taskOwner(T)).explicit).toBeNull();
  });

  it('a session that is neither root nor an administrator is refused GROUP_OWNER_REQUIRES_ADMINISTRATOR and its token stays live (service seam)', async () => {
    // Over HTTP an editor never reaches the act: the route ceiling (projects:admin)
    // refuses first. The act's own code is proven here, at the service seam,
    // with the editor's real actor and a session standing.
    const P = await project(PERSON.id);
    await pool.query(`INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id)
      VALUES ('principal', $1, 'project', $2, 'write', $3)`, [EDITOR.id, P, ROOT.id]);
    const { token, tokenId } = await stepUp(EDITOR, P);
    const actor = await actorOf(EDITOR);
    const revision = (await pool.query('SELECT revision FROM projects WHERE id = $1', [P])).rows[0].revision;
    await expect(projectOwnershipService.change(P, G, String(revision), {
      authorization: actor, authMethod: 'session', audit: { principalId: EDITOR.id, handle: 'editor', authMethod: 'session' },
      standing: { authMethod: 'session', handle: 'editor', principalId: EDITOR.id, principalRole: 'editor', sessionRole: 'editor', scopes: ['projects:admin'], stepUpToken: token },
    })).rejects.toMatchObject({ status: 403, code: 'GROUP_OWNER_REQUIRES_ADMINISTRATOR' });
    expect(await tokenLive(tokenId)).toBe(true);
    for (const role of ['editor', 'user', 'viewer']) {
      const session = await account(`http-${role}`, role);
      const own = await stepUp(session, P);
      const refused = await moveProject(session, P, G, own.token);
      // Refused before the act: the route ceiling (403), or concealment (404)
      // where the session cannot read the Project at all.
      expect([role, [403, 404].includes(refused.status)]).toEqual([role, true]);
      expect([role, await tokenLive(own.tokenId)]).toEqual([role, true]);
    }
    expect(await projectOwner(P)).toBe(PERSON.id);
  });

  it('a step-up bound to another act or another object is refused STEP_UP_REQUIRED with the challenge for this binding', async () => {
    const P = await project(PERSON.id);
    const other = await project(PERSON.id);
    for (const minted of [await stepUp(OPERATOR, P, 'approval.decide'), await stepUp(OPERATOR, other)]) {
      const refused = await moveProject(OPERATOR, P, G, minted.token);
      expect([refused.status, refused.json?.code]).toEqual([403, 'STEP_UP_REQUIRED']);
      expect(refused.json?.stepUp).toMatchObject({ error: 'insufficient_user_authentication', action: ACT, targetId: P, max_age: 0 });
      expect(await tokenLive(minted.tokenId)).toBe(true);
    }
    expect(await projectOwner(P)).toBe(PERSON.id);
  });

  it('the Main arm is never a decider once a Group is involved (service seam)', async () => {
    const owner = await account('main-owner-seam', 'admin');
    const main = await connectorOf(owner);
    await pool.query('UPDATE principals SET owner_control_account_id = $2 WHERE id = $1', [main.id, owner.id]);
    const P = await project(owner.id);
    const { token } = await stepUp(main, P);
    const actor = await actorOf(main);
    const revision = (await pool.query('SELECT revision FROM projects WHERE id = $1', [P])).rows[0].revision;
    // A standing that passes steps 1-3 cannot carry the appointed Main through
    // arm (i): the act's own decider still needs a human login (arm ii).
    await expect(projectOwnershipService.change(P, G, String(revision), {
      authorization: actor, authMethod: 'principal_api_key', credentialId: main.credentialId,
      audit: { principalId: main.id, handle: 'main', authMethod: 'principal_api_key' },
      standing: { authMethod: 'session', handle: 'main', principalId: main.id, scopes: ['root'], stepUpToken: token },
    })).rejects.toMatchObject({ status: 403, code: 'REQUIRES_HUMAN_LOGIN' });
    expect(await projectOwner(P)).toBe(owner.id);
  });
});

describe('clause 9(a)-(d): root and an administrator, with step-up, into, out of and between Groups', () => {
  it('root and an administrator move a Project person -> Group -> Group -> person and clear a Group-owned Project', async () => {
    for (const who of [ROOT, OPERATOR]) {
      const P = await project(PERSON.id);
      for (const target of [G, H, OTHER.id]) {
        const { token, tokenId } = await stepUp(who, P);
        const moved = await moveProject(who, P, target, token);
        expect([who.label, target, moved.status, moved.json?.project?.ownerPrincipalId]).toEqual([who.label, target, 200, target]);
        expect(await tokenLive(tokenId)).toBe(false);
      }
      const back = await stepUp(who, P);
      expect((await moveProject(who, P, G, back.token)).status).toBe(200);
      const clear = await stepUp(who, P);
      const cleared = await moveProject(who, P, null, clear.token);
      expect([who.label, cleared.status, await projectOwner(P)]).toEqual([who.label, 200, null]);
    }
  });

  it('root and an administrator move a Task person -> Group -> Group -> person', async () => {
    for (const who of [ROOT, OPERATOR]) {
      const P = await project(PERSON.id);
      const T = await task(P);
      for (const target of [G, H, OTHER.id]) {
        const { token } = await stepUp(who, T);
        const moved = await moveTask(who, T, target, token);
        expect([who.label, target, moved.status, moved.json?.ownership?.accountOwnerPrincipalId]).toEqual([who.label, target, 200, target]);
      }
    }
  });

  it('the break-glass dashboard JWT reaches the Project act and not the Task act (R87)', async () => {
    const P = await project(PERSON.id);
    const T = await task(P);
    const onProject = await stepUp(DASHBOARD, P);
    expect((await moveProject(DASHBOARD, P, G, onProject.token)).status).toBe(200);
    const onTask = await stepUp(DASHBOARD, T);
    const refused = await moveTask(DASHBOARD, T, H, onTask.token);
    expect([refused.status, refused.json?.code]).toEqual([403, 'TASK_ACCOUNT_OWNER_AUTHORITY_REQUIRED']);
    expect(await tokenLive(onTask.tokenId)).toBe(true);
  });

  it('a disabled Group principal is refused as a Project target and its token stays live', async () => {
    const D = await newGroup('disabled-project');
    await pool.query("UPDATE principals SET status = 'disabled' WHERE id = $1", [D]);
    const P = await project(PERSON.id);
    const { token, tokenId } = await stepUp(OPERATOR, P);
    const refused = await moveProject(OPERATOR, P, D, token);
    expect([refused.status, refused.json?.code]).toEqual([422, 'INVALID_OWNER']);
    expect(await tokenLive(tokenId)).toBe(true);
    expect(await projectOwner(P)).toBe(PERSON.id);
  });

  it('a disabled Group principal is refused as a Task target and its token stays live', async () => {
    const D = await newGroup('disabled-task');
    await pool.query("UPDATE principals SET status = 'disabled' WHERE id = $1", [D]);
    const T = await task(await project(PERSON.id));
    const { token, tokenId } = await stepUp(OPERATOR, T);
    const refused = await moveTask(OPERATOR, T, D, token);
    expect([refused.status, refused.json?.code]).toEqual([422, 'INVALID_ACCOUNT_OWNER']);
    expect(await tokenLive(tokenId)).toBe(true);
    expect((await taskOwner(T)).explicit).toBeNull();
  });

  it('undo: an operator moves a Project into a Group and back; both audit rows record deciderStanding administrator', async () => {
    const P = await project(PERSON.id);
    const into = await stepUp(OPERATOR, P);
    expect((await moveProject(OPERATOR, P, G, into.token)).status).toBe(200);
    const back = await stepUp(OPERATOR, P);
    expect((await moveProject(OPERATOR, P, PERSON.id, back.token)).status).toBe(200);
    const rows = (await audits(P, 'project.owner.change')).filter((r) => r.outcome === 'success');
    expect(rows.map((r) => [r.metadata.oldOwnerKind, r.metadata.newOwnerKind, r.metadata.deciderStanding]))
      .toEqual([['human', 'group', 'administrator'], ['group', 'human', 'administrator']]);
  });

  it('undo on a Task pins an explicit person, and a later Project transfer leaves the Task with that person', async () => {
    const P = await project(PERSON.id);
    const T = await task(P);
    expect(await taskOwner(T)).toEqual({ explicit: null, effective: PERSON.id });
    const into = await stepUp(OPERATOR, T);
    expect((await moveTask(OPERATOR, T, G, into.token)).status).toBe(200);
    const back = await stepUp(OPERATOR, T);
    expect((await moveTask(OPERATOR, T, PERSON.id, back.token)).status).toBe(200);
    expect(await taskOwner(T)).toEqual({ explicit: PERSON.id, effective: PERSON.id });
    expect((await moveProject(OPERATOR, P, OTHER.id)).status).toBe(200);
    expect(await taskOwner(T)).toEqual({ explicit: PERSON.id, effective: PERSON.id });
    const cleared = await call(OPERATOR, 'PUT', `/tasks/${T}/account-owner`, {
      accountOwnerPrincipalId: null, expectedAccountOwnerPrincipalId: PERSON.id, expectedUpdatedAt: 'x', reason: REASON,
    });
    expect([cleared.status, cleared.json?.code]).toEqual([422, 'INVALID_ACCOUNT_OWNER_CHANGE']);
  });

  it('a Task that takes its Group owner from its Project (COALESCE) is a Group source: the standing test applies', async () => {
    const P = await project(G);
    const T = await task(P);
    const bearer = await connectorOf(ROOT);
    const refused = await moveTask(bearer, T, PERSON.id);
    expect([refused.status, refused.json?.code]).toEqual([403, 'GROUP_OWNER_SESSION_ONLY']);
    const { token } = await stepUp(OPERATOR, T);
    expect((await moveTask(OPERATOR, T, PERSON.id, token)).status).toBe(200);
    expect(await taskOwner(T)).toEqual({ explicit: PERSON.id, effective: PERSON.id });
  });

  it('clause 9(d): grants are untouched by a transfer into and out of a Group', async () => {
    const P = await project(PERSON.id);
    await pool.query(`INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id)
      VALUES ('principal', $1, 'project', $2, 'read', $3), ('principal', $1, 'project', $2, 'write', $3)`, [EDITOR.id, P, ROOT.id]);
    const before = (await pool.query("SELECT id, verb FROM grants WHERE resource_type = 'project' AND resource_id = $1 ORDER BY id", [P])).rows;
    for (const target of [G, PERSON.id]) {
      const { token } = await stepUp(ROOT, P);
      expect((await moveProject(ROOT, P, target, token)).status).toBe(200);
    }
    expect((await pool.query("SELECT id, verb FROM grants WHERE resource_type = 'project' AND resource_id = $1 ORDER BY id", [P])).rows).toEqual(before);
  });
});

describe('clause 9(f): the audit row', () => {
  it('records kinds, the member count, the step-up token, deciderStanding and the full chain', async () => {
    const P = await project(PERSON.id);
    const { token, tokenId } = await stepUp(ROOT, P);
    expect((await moveProject(ROOT, P, G, token)).status).toBe(200);
    const [row] = (await audits(P, 'project.owner.change')).filter((r) => r.outcome === 'success');
    expect(row.metadata).toMatchObject({
      oldOwnerPrincipalId: PERSON.id, newOwnerPrincipalId: G, oldOwnerKind: 'human', newOwnerKind: 'group',
      groupMemberCountAtTransfer: 2, stepUpTokenId: tokenId, stepUpMethod: 'password', deciderStanding: 'root',
    });
    expect(row.metadata.chain.map((link: any) => link.principalId)).toEqual([ROOT.id]);
    const T = await task(P);
    const onTask = await stepUp(OPERATOR, T);
    expect((await moveTask(OPERATOR, T, H, onTask.token)).status).toBe(200);
    const [taskRow] = (await audits(T, 'task.account_owner.change')).filter((r) => r.outcome === 'success');
    expect(taskRow.metadata).toMatchObject({
      oldAccountOwnerPrincipalId: G, newAccountOwnerPrincipalId: H, oldOwnerKind: 'group', newOwnerKind: 'group',
      groupMemberCountAtTransfer: 0, stepUpTokenId: onTask.tokenId, deciderStanding: 'administrator',
    });
  });

  it('the person-to-person path is unchanged: no step-up, and no Group keys in its audit row', async () => {
    const P = await project(PERSON.id);
    expect((await moveProject(OPERATOR, P, OTHER.id)).status).toBe(200);
    const [row] = await audits(P, 'project.owner.change');
    expect(Object.keys(row.metadata).sort()).toEqual(['newOwnerPrincipalId', 'oldOwnerPrincipalId']);
    const T = await task(P);
    expect((await moveTask(OPERATOR, T, PERSON.id)).status).toBe(200);
    const [taskRow] = await audits(T, 'task.account_owner.change');
    expect(taskRow.metadata).not.toHaveProperty('deciderStanding');
  });
});

describe('clause 10(b): creation with a Group owner', () => {
  const create = (who: Caller, body: Record<string, unknown>): Promise<Answer> =>
    call(who, 'POST', '/projects', { name: `aza12b3 created ${tag()}`, ...body });

  it('an administrator creates a Group-owned Project with a step-up bound to the allocated id, in one transaction', async () => {
    const id = crypto.randomUUID();
    const { token, tokenId } = await stepUp(OPERATOR, id);
    const created = await create(OPERATOR, { ownerPrincipalId: G, projectId: id, stepUpToken: token });
    expect([created.status, created.json?.project?.id, created.json?.project?.ownerPrincipalId]).toEqual([201, id, G]);
    expect(await tokenLive(tokenId)).toBe(false);
    const [row] = (await audits(id, 'project.owner.change')).filter((r) => r.outcome === 'success');
    // Creation records the creator as the person owner first (clause 10(a),
    // unchanged); the selector then moves it to the Group in the same transaction.
    expect(row.metadata).toMatchObject({
      oldOwnerPrincipalId: OPERATOR.id, newOwnerPrincipalId: G, oldOwnerKind: 'human', newOwnerKind: 'group',
      atCreation: true, deciderStanding: 'administrator',
    });
  });

  it('creation refuses an editor, a bearer and a missing step-up, and leaves no Project behind', async () => {
    const editorId = crypto.randomUUID();
    const editorToken = await stepUp(EDITOR, editorId);
    const editor = await create(EDITOR, { ownerPrincipalId: G, projectId: editorId, stepUpToken: editorToken.token });
    expect([editor.status, editor.json?.code]).toEqual([403, 'GROUP_OWNER_REQUIRES_ADMINISTRATOR']);
    expect(await tokenLive(editorToken.tokenId)).toBe(true);
    const bearerId = crypto.randomUUID();
    const bearer = await create(await connectorOf(ROOT), { ownerPrincipalId: G, projectId: bearerId, stepUpToken: '' });
    expect([bearer.status, bearer.json?.code]).toEqual([403, 'GROUP_OWNER_SESSION_ONLY']);
    const missingId = crypto.randomUUID();
    const missing = await create(OPERATOR, { ownerPrincipalId: G, projectId: missingId, stepUpToken: '' });
    expect([missing.status, missing.json?.code, missing.json?.stepUp?.targetId]).toEqual([403, 'STEP_UP_REQUIRED', missingId]);
    const left = await pool.query('SELECT id FROM projects WHERE id = ANY($1::uuid[])', [[editorId, bearerId, missingId]]);
    expect(left.rows).toEqual([]);
  });

  it('a person owner at creation is refused OWNER_AT_CREATE_GROUP_ONLY', async () => {
    const id = crypto.randomUUID();
    const { token, tokenId } = await stepUp(OPERATOR, id);
    const refused = await create(OPERATOR, { ownerPrincipalId: PERSON.id, projectId: id, stepUpToken: token });
    expect([refused.status, refused.json?.code]).toEqual([422, 'OWNER_AT_CREATE_GROUP_ONLY']);
    expect(await tokenLive(tokenId)).toBe(true);
    expect((await pool.query('SELECT id FROM projects WHERE id = $1', [id])).rows).toEqual([]);
  });
});

describe('clause 10(b): the Group-owned create is retried under its own credential-scoped operation', () => {
  it('a same-key replay of a Group-owned create by a second credential of the same principal is decided afresh, never served', async () => {
    // The B4 replay class (idempotency ruling 3). The Group-owned create reads
    // the caller's session and credential (the 9(e) standing test and its
    // step-up), so its retry record is CREDENTIAL-scoped under its own
    // operation, project.groupowned.create (migration 156); the plain create
    // keeps project.create, principal-scoped. Under principal scope the session
    // and the bearer below both resolve to prin:<account>, and the bearer would
    // be served the stored 201 without its own standing test.
    const owner = await account('replay-admin', 'admin');
    const bearer = await accountBearerOf(owner);
    expect((await call(bearer, 'GET', '/projects')).status).toBe(200);
    const id = crypto.randomUUID();
    const { token, tokenId } = await stepUp(owner, id);
    const key = `aza12b3-replay-${crypto.randomBytes(12).toString('hex')}`;
    const body = { name: `aza12b3 replay ${tag()}`, ownerPrincipalId: G, projectId: id, stepUpToken: token };
    const first = await call(owner, 'POST', '/projects', body, { 'Idempotency-Key': key });
    expect([first.status, first.json?.project?.id, first.json?.project?.ownerPrincipalId, first.replayed]).toEqual([201, id, G, null]);
    expect(await tokenLive(tokenId)).toBe(false);
    // The second credential of the SAME principal, the same body and key: no
    // record exists in its scope, so the handler decides afresh (the Project
    // now exists) and nothing is replayed.
    const second = await call(bearer, 'POST', '/projects', body, { 'Idempotency-Key': key });
    expect([second.status, second.json?.code, second.replayed]).toEqual([409, 'PROJECT_NAME_CONFLICT', null]);
    // ...and with a new Project under the SAME key it meets its own standing
    // test (step 1 refuses before the step-up is consumed). Under principal
    // scope this request would find the session's record and answer
    // IDEMPOTENCY_KEY_REUSED instead.
    const otherId = crypto.randomUUID();
    const other = await stepUp(owner, otherId);
    const own = await call(bearer, 'POST', '/projects',
      { name: `aza12b3 replay other ${tag()}`, ownerPrincipalId: G, projectId: otherId, stepUpToken: other.token },
      { 'Idempotency-Key': key });
    expect([own.status, own.json?.code, own.replayed]).toEqual([403, 'GROUP_OWNER_SESSION_ONLY', null]);
    expect(await tokenLive(other.tokenId)).toBe(true);
    const rows = await pool.query(
      `SELECT operation, split_part(scope, ':', 1) AS kind, state FROM operation_idempotency_records WHERE idempotency_key = $1`, [key]);
    expect(rows.rows).toEqual([{ operation: 'project.groupowned.create', kind: 'user', state: 'completed' }]);
    // The same session's exact retry is still served the stored answer.
    const retry = await call(owner, 'POST', '/projects', body, { 'Idempotency-Key': key });
    expect([retry.status, retry.json?.project?.id, retry.replayed]).toEqual([201, id, 'true']);
    expect((await pool.query('SELECT count(*)::int AS n FROM projects WHERE id = $1', [id])).rows[0].n).toBe(1);
  });
});

describe('clause 12: the owner selector', () => {
  it('owner-candidates lists enabled Groups, featured first, to root and administrator sessions only', async () => {
    const featured = await newGroup('featured', true);
    const disabled = await newGroup('disabled-candidate');
    await pool.query("UPDATE principals SET status = 'disabled' WHERE id = $1", [disabled]);
    const P = await project(PERSON.id);
    for (const who of [ROOT, OPERATOR]) {
      const listed = await call(who, 'GET', `/projects/${P}/owner-candidates`);
      expect(listed.status).toBe(200);
      const ids = listed.json.groups.map((g: any) => g.id);
      expect([who.label, ids.includes(G), ids.includes(featured), ids.includes(disabled)]).toEqual([who.label, true, true, false]);
      const firstPlain = listed.json.groups.findIndex((g: any) => !g.featured);
      expect(listed.json.groups.slice(firstPlain).every((g: any) => !g.featured)).toBe(true);
      expect(Array.isArray(listed.json.candidates)).toBe(true);
    }
    const owner = await account('selector-main-owner', 'admin');
    const main = await connectorOf(owner);
    await pool.query('UPDATE principals SET owner_control_account_id = $2 WHERE id = $1', [main.id, owner.id]);
    const mainProject = await project(owner.id);
    const asMain = await call(main, 'GET', `/projects/${mainProject}/owner-candidates`);
    expect([asMain.status, asMain.json?.groups]).toEqual([200, []]);
  });
});

describe('clause 14: the administrator exception is act-scoped', () => {
  it('an operator session with a step-up is still refused Group enable/disable and Group-role appointment', async () => {
    const statusToken = await stepUp(OPERATOR, G, 'group.ownership_status');
    const status = await call(OPERATOR, 'PUT', `/groups/${G}/ownership-status`, { enabled: false, reason: 'drill', stepUpToken: statusToken.token });
    expect(status.status).toBe(403);
    expect(await tokenLive(statusToken.tokenId)).toBe(true);
    const appoint = await call(OPERATOR, 'POST', `/groups/${G}/stewards`, { accountPrincipalId: PERSON.id, role: 'manager' });
    expect(appoint.status).toBe(403);
    expect((await pool.query("SELECT status FROM principals WHERE id = $1", [G])).rows[0].status).toBe('active');
  });
});
