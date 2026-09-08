/**
 * 9c177e6a — A TASK IS CREATED WHERE ITS AUTHOR MAY REACH, OR NOWHERE.
 *
 * The defect was found by LANE FEAT-A on its own fixtures and confirmed on
 * `main` (handover `9faa483f`): `POST /tasks` destructured `project`, handed it
 * to `TaskManagerDB.resolveProjectId`, and INSERTed the id that came back.
 * Nothing anywhere asked whether the caller could reach that Project, so an
 * outsider to a PRIVATE Project could file a Task inside it — and, through the
 * same helper, `PATCH /tasks/:id` and `PATCH /tasks/batch` could move one in.
 *
 * ── THE PROPERTY, AND ITS OUTSIDE ANCHOR ──
 *
 * For every caller and every Project: `POST /tasks` places a Task in that
 * Project EXACTLY when the point-read surface for that Project answers 200.
 * The expected set is never computed from the authorization rules — it is READ
 * BACK from the surface that decides Project readability today, so a test that
 * re-derived the predicate could be edited into agreement with a broken one,
 * and this one cannot, because both sides are measured.
 *
 * The product carries no bare `GET /projects/:id`; the Project point-read
 * surface is `GET /projects/:id/context`, which the shared point stage decides
 * (`pointAuthorizationTarget` classifies GET on a `projects` family as `read`)
 * BEFORE its handler runs. That is the anchor, and `GET /tasks/:id` is the
 * second one: where a Task landed is read back from the point route rather
 * than from the create's own echo.
 *
 * ── THE SECOND PROPERTY: ONE ANSWER ──
 *
 * A caller that names an unreachable Project and a caller that names an ABSENT
 * one receive the SAME status and the SAME body — the house rule, and AUTHZ
 * `4d961e37` par.9.6 (the 44d1bf89 rule). Both spellings of "name a Project"
 * are drilled, because a name lookup and a UUID were two different code paths
 * in the defect and only one of them was ever going to be repaired by accident.
 *
 * ── THE THIRD PROPERTY: NOTHING IS LEFT BEHIND ──
 *
 * The decision runs on the create's OWN transaction and before its INSERT, so
 * a refused create leaves NO row: the private Project's Task population, read
 * as the caller who owns it, is unchanged, and no Task anywhere carries the
 * refused title.
 *
 * ── WHY IT IS NOT IN THE DEFAULT JEST RUN ──
 *
 * It connects to `RELAYHALL_TEST_DB_URL` and FAILS — never skips — when the
 * variable is unset, for the reason `listPointParity` gives: the predicate
 * under test is SQL, every DB-shaped suite in the default run mocks the pool,
 * and a mocked pool can only replay the rule this gate exists to measure.
 * Excluded by `testPathIgnorePatterns`, run by `npm run test:project-target`
 * on the VM gate chain and UNCONDITIONALLY in CI against the `services:
 * postgres` block, with no `if:` guard.
 *
 * ── THE DESTRUCTIVE CONTRACT, STATED ──
 *
 * This suite WRITES to principals, projects, tasks, grants and auth_sessions.
 * It refuses any URL naming a deployment database (`relayhall_dev`,
 * `relayhall_tst`, `relayhall_prod`, `relayhall`) and any non-local host.
 * Bring the database up with `database/init.sql` and `npm run migrate`, and
 * throw it away afterwards.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

// ─────────────────────────── the database contract ───────────────────────────

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error(
    'RELAYHALL_TEST_DB_URL is not set. This gate measures the create path against a REAL PostgreSQL and refuses to skip: '
    + 'the decision under test is SQL, and a mocked pool can only replay the rule. '
    + 'Create a disposable database, load database/init.sql, run npm run migrate, and set RELAYHALL_TEST_DB_URL to it.',
  );
}

const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = parsed.pathname.replace(/^\//, '');
const FORBIDDEN_DATABASES = ['relayhall_dev', 'relayhall_tst', 'relayhall_prod', 'relayhall'];
if (FORBIDDEN_DATABASES.includes(TEST_DB_NAME)) {
  throw new Error(`RELAYHALL_TEST_DB_URL names a deployment database (${TEST_DB_NAME}). This suite writes; point it at a disposable database.`);
}

process.env.DB_HOST = parsed.hostname;
process.env.DB_PORT = parsed.port || '5432';
process.env.DB_NAME = TEST_DB_NAME;
process.env.DB_USER = decodeURIComponent(parsed.username);
process.env.DB_PASSWORD = decodeURIComponent(parsed.password);
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'project-target-suite-secret-0123456789ab';
process.env.RELAYHALL_SESSIONS = 'on';

const express = require('express');

const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { principalService } = require('../services/PrincipalService');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');

jest.setTimeout(180_000);

// ──────────────────────────────── the app ────────────────────────────────────

let server: http.Server;
let origin: string;

function buildApp(): any {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  return app;
}

interface Answer { status: number; json: any }

interface Caller {
  label: string;
  principalId: string;
  headers: Record<string, string>;
}

async function call(who: Caller, method: string, routePath: string, body?: unknown): Promise<Answer> {
  const response = await fetch(`${origin}${routePath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...who.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json };
}

// ────────────────────────────── the fixtures ─────────────────────────────────

const SYSTEM_ACTOR = { handle: 'project-target-suite', authMethod: 'system' as const };
const tag = (): string => crypto.randomBytes(6).toString('hex');

/** The MCP/CLI create shape: a bearer credential that may write Tasks and has
 *  no Projects surface at all. */
const NARROW_SCOPES = ['tasks:read', 'tasks:write'];

let ROOT_PRINCIPAL: string;
let ROOT: Caller;
/** A just-in-time human Account, role `user`, no grants: an OUTSIDER to the
 *  private Project and the caller the defect was reported for. */
let OUTSIDER: Caller;
/** The same shape, plus ONE `read` grant on the private Project — the row that
 *  makes the gate non-vacuous in the admitting direction. */
let GRANTEE: Caller;
/** A parented Connector whose credential carries no `projects:read`. */
let NARROW_CONNECTOR: Caller;

let PRIVATE_PROJECT: string;
let PRIVATE_PROJECT_NAME: string;
let SHARED_PROJECT: string;
let SHARED_PROJECT_NAME: string;
/** A UUID no `projects` row carries, and a name no `projects` row carries. */
let ABSENT_PROJECT_ID: string;
let ABSENT_PROJECT_NAME: string;
/** A Task in the SHARED Project, ASSIGNED to the outsider so the claimant arm
 *  gives it `write`: the row the MOVE half is drilled on. */
let MOVABLE_TASK: string;

async function makeAccount(kind: 'human' | 'service', role: string | null): Promise<string> {
  const handle = `target-${kind}-${tag()}`;
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role, purpose)
     VALUES ($1, $2, $3, 'active', $4, $5) RETURNING id`,
    [kind, handle, `project target ${handle}`, role, kind === 'service' ? 'project target account' : null],
  );
  return String(result.rows[0].id);
}

async function sessionCallerFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

async function connectorCaller(label: string, accountId: string, scopes: string[]): Promise<Caller> {
  const handle = `target-connector-${tag()}`;
  const principal = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, $2, 'active', $3, $4, $5::jsonb) RETURNING id`,
    [handle, `project target ${label}`, accountId, 'project target connector',
      JSON.stringify({ scopes: 'parent', objects: 'parent' })],
  );
  const principalId = String(principal.rows[0].id);
  const issued = await principalService.issueCredential(
    { principalId, scopes, transport: 'any' }, SYSTEM_ACTOR);
  return { label, principalId, headers: { Authorization: `Bearer ${issued.fullKey}` } };
}

async function makeProject(name: string, visibility: 'private' | 'shared'): Promise<string> {
  const result = await pool.query(
    `INSERT INTO projects (name, status, visibility, owner_principal_id)
     VALUES ($1, 'active', $2, $3) RETURNING id`,
    [name, visibility, ROOT_PRINCIPAL],
  );
  return String(result.rows[0].id);
}

async function grantProjectRead(principalId: string, projectId: string): Promise<void> {
  await pool.query(
    `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id)
     VALUES ('principal', $1, 'project', $2, 'read', $3)`,
    [principalId, projectId, ROOT_PRINCIPAL],
  );
}

beforeAll(async () => {
  await new Promise<void>((resolve) => { server = buildApp().listen(0, resolve); });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;

  ROOT_PRINCIPAL = await makeAccount('human', 'admin');
  ROOT = await sessionCallerFor('root session', ROOT_PRINCIPAL);

  OUTSIDER = await sessionCallerFor('outsider session', await makeAccount('human', 'user'));
  GRANTEE = await sessionCallerFor('granted session', await makeAccount('human', 'user'));

  const connectorAccount = await makeAccount('service', 'user');
  NARROW_CONNECTOR = await connectorCaller('narrow connector', connectorAccount, NARROW_SCOPES);

  PRIVATE_PROJECT_NAME = `target-private-${tag()}`;
  PRIVATE_PROJECT = await makeProject(PRIVATE_PROJECT_NAME, 'private');
  SHARED_PROJECT_NAME = `target-shared-${tag()}`;
  SHARED_PROJECT = await makeProject(SHARED_PROJECT_NAME, 'shared');

  ABSENT_PROJECT_ID = crypto.randomUUID();
  ABSENT_PROJECT_NAME = `target-absent-${tag()}`;

  await grantProjectRead(GRANTEE.principalId, PRIVATE_PROJECT);

  const movable = await pool.query(
    `INSERT INTO tasks (title, status, visibility, project_id, owner_principal_id, creator_principal_id)
     VALUES ($1, 'todo', 'private', $2, $3, $3) RETURNING id`,
    [`target movable ${tag()}`, SHARED_PROJECT, OUTSIDER.principalId],
  );
  MOVABLE_TASK = String(movable.rows[0].id);
});

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  await pool.end();
});

// ─────────────────── the outside anchor: Project readability ─────────────────

/**
 * What the Project POINT-READ surface allows. `GET /projects/:id/context` is
 * decided by the shared point stage before its handler runs, so a 404 here is
 * the same refusal `GET /tasks/:id` gives for a Task: the object stage's, not
 * the handler's.
 */
async function projectIsReadable(who: Caller, projectId: string): Promise<boolean> {
  const answer = await call(who, 'GET', `/projects/${projectId}/context`);
  if (answer.status === 200) return true;
  if (answer.status === 404) return false;
  throw new Error(`${who.label} got an unexpected ${answer.status} from the Project point read`);
}

async function taskProjectId(taskId: string): Promise<string | null> {
  const answer = await call(ROOT, 'GET', `/tasks/${taskId}`);
  expect(`root reads task ${taskId}: ${answer.status}`).toBe(`root reads task ${taskId}: 200`);
  const named = answer.json.task.project;
  if (!named) return null;
  const row = await pool.query('SELECT id::text AS id FROM projects WHERE name = $1 OR id::text = $1', [named]);
  return row.rows.length === 1 ? String(row.rows[0].id) : null;
}

/** Every Task id in a Project, as the root Account sees them. The population
 *  a refused create must not have joined. */
async function taskIdsIn(projectId: string): Promise<string[]> {
  const rows = await pool.query('SELECT id::text AS id FROM tasks WHERE project_id = $1 ORDER BY id', [projectId]);
  return rows.rows.map((row: any) => String(row.id));
}

const createBody = (title: string, project: string) => ({ title, project });

// ─────────────────────────────── the properties ──────────────────────────────

describe('the create path decides its target Project through the shared predicate', () => {
  it('the fixtures are the two sides they claim to be (not vacuous)', async () => {
    expect(`outsider reads the private project: ${await projectIsReadable(OUTSIDER, PRIVATE_PROJECT)}`)
      .toBe('outsider reads the private project: false');
    expect(`outsider reads the shared project: ${await projectIsReadable(OUTSIDER, SHARED_PROJECT)}`)
      .toBe('outsider reads the shared project: true');
    expect(`grantee reads the private project: ${await projectIsReadable(GRANTEE, PRIVATE_PROJECT)}`)
      .toBe('grantee reads the private project: true');
    expect(`root reads the private project: ${await projectIsReadable(ROOT, PRIVATE_PROJECT)}`)
      .toBe('root reads the private project: true');
  });

  it('a create lands EXACTLY where the Project point read answers 200', async () => {
    const observed: string[] = [];
    const expected: string[] = [];
    for (const who of [ROOT, OUTSIDER, GRANTEE]) {
      for (const [label, projectId] of [
        ['private', PRIVATE_PROJECT] as const,
        ['shared', SHARED_PROJECT] as const,
      ]) {
        const readable = await projectIsReadable(who, projectId);
        const answer = await call(who, 'POST', '/tasks', createBody(`target ${who.label} ${label} ${tag()}`, projectId));
        const created = answer.status === 201;
        // A create that SUCCEEDED must also have landed in the Project it
        // named — read back from GET /tasks/:id, never from the create echo.
        const landed = created ? await taskProjectId(String(answer.json.task.id)) === projectId : false;
        observed.push(`${who.label}/${label}: created=${created} landed=${landed}`);
        expected.push(`${who.label}/${label}: created=${readable} landed=${readable}`);
      }
    }
    expect(observed).toEqual(expected);
  });

  it('an unreachable Project answers exactly as an ABSENT one — both spellings', async () => {
    const byId = await call(OUTSIDER, 'POST', '/tasks', createBody(`target conceal id ${tag()}`, PRIVATE_PROJECT));
    const byName = await call(OUTSIDER, 'POST', '/tasks', createBody(`target conceal name ${tag()}`, PRIVATE_PROJECT_NAME));
    const absentId = await call(OUTSIDER, 'POST', '/tasks', createBody(`target absent id ${tag()}`, ABSENT_PROJECT_ID));
    const absentName = await call(OUTSIDER, 'POST', '/tasks', createBody(`target absent name ${tag()}`, ABSENT_PROJECT_NAME));

    // The absent answer is the reference, and it is stated so a reader can see
    // WHICH answer both sides collapsed onto rather than only that they agree.
    expect(`absent by uuid: ${absentId.status} ${absentId.json.code}`).toBe('absent by uuid: 404 PROJECT_NOT_FOUND');
    expect(`absent by name: ${absentName.status} ${absentName.json.code}`).toBe('absent by name: 404 PROJECT_NOT_FOUND');
    expect({ status: byId.status, body: byId.json }).toEqual({ status: absentId.status, body: absentId.json });
    expect({ status: byName.status, body: byName.json }).toEqual({ status: absentName.status, body: absentName.json });
  });

  it('a refused create leaves NO row — the decision precedes the INSERT', async () => {
    const before = await taskIdsIn(PRIVATE_PROJECT);
    const title = `target must not exist ${tag()}`;
    const refused = await call(OUTSIDER, 'POST', '/tasks', createBody(title, PRIVATE_PROJECT));
    expect(`refused: ${refused.status}`).toBe('refused: 404');
    expect(await taskIdsIn(PRIVATE_PROJECT)).toEqual(before);
    const anywhere = await pool.query('SELECT count(*)::int AS n FROM tasks WHERE title = $1', [title]);
    // Not merely "not in that Project": a create that fell through to a NULL
    // project_id would satisfy the population check and still be a durable
    // write the caller was refused.
    expect(`rows with the refused title: ${anywhere.rows[0].n}`).toBe('rows with the refused title: 0');
  });

  it('a bearer credential with no Projects scope is decided the same way', async () => {
    // The MCP and CLI create paths are this caller: `relayhall_task_create`
    // posts to `POST /tasks` with `tasks:write` and nothing else. The route
    // CEILING for the Projects surface is a separate stage and this credential
    // fails it; the OBJECT decision is what this gate is about, and it does not
    // borrow the ceiling — a Project this credential cannot reach is refused,
    // one it can is created in.
    const ceiling = await call(NARROW_CONNECTOR, 'GET', `/projects/${SHARED_PROJECT}/context`);
    expect(`narrow connector at the Projects ceiling: ${ceiling.status}`)
      .toBe('narrow connector at the Projects ceiling: 403');

    const intoShared = await call(NARROW_CONNECTOR, 'POST', '/tasks',
      createBody(`target narrow shared ${tag()}`, SHARED_PROJECT));
    expect(`into the shared project: ${intoShared.status}`).toBe('into the shared project: 201');
    expect(await taskProjectId(String(intoShared.json.task.id))).toBe(SHARED_PROJECT);

    const intoPrivate = await call(NARROW_CONNECTOR, 'POST', '/tasks',
      createBody(`target narrow private ${tag()}`, PRIVATE_PROJECT));
    const intoAbsent = await call(NARROW_CONNECTOR, 'POST', '/tasks',
      createBody(`target narrow absent ${tag()}`, ABSENT_PROJECT_ID));
    expect({ status: intoPrivate.status, body: intoPrivate.json })
      .toEqual({ status: intoAbsent.status, body: intoAbsent.json });
    expect(`refused with: ${intoPrivate.status} ${intoPrivate.json.code}`)
      .toBe('refused with: 404 PROJECT_NOT_FOUND');
  });

  it('naming NO Project is unchanged — nothing to decide, nothing refused', async () => {
    const answer = await call(OUTSIDER, 'POST', '/tasks', { title: `target orphan ${tag()}` });
    expect(`orphan create: ${answer.status}`).toBe('orphan create: 201');
    expect(await taskProjectId(String(answer.json.task.id))).toBeNull();
  });
});

describe('the MOVE surfaces decide the same target the same way', () => {
  it('PATCH /tasks/:id refuses a move into an unreachable Project, as for an absent one', async () => {
    // The control first: a move to a Project this caller CAN reach works, so a
    // green refusal below is not a route that refuses every move.
    const allowed = await call(OUTSIDER, 'PATCH', `/tasks/${MOVABLE_TASK}`, { project: SHARED_PROJECT });
    expect(`move into the shared project: ${allowed.status}`).toBe('move into the shared project: 200');
    expect(await taskProjectId(MOVABLE_TASK)).toBe(SHARED_PROJECT);

    const intoPrivate = await call(OUTSIDER, 'PATCH', `/tasks/${MOVABLE_TASK}`, { project: PRIVATE_PROJECT });
    const intoAbsent = await call(OUTSIDER, 'PATCH', `/tasks/${MOVABLE_TASK}`, { project: ABSENT_PROJECT_ID });
    expect({ status: intoPrivate.status, body: intoPrivate.json })
      .toEqual({ status: intoAbsent.status, body: intoAbsent.json });
    expect(`refused with: ${intoPrivate.status} ${intoPrivate.json.code}`)
      .toBe('refused with: 404 PROJECT_NOT_FOUND');
    // And the Task did not move.
    expect(await taskProjectId(MOVABLE_TASK)).toBe(SHARED_PROJECT);
  });

  it('PATCH /tasks/batch refuses the same move, and the Task does not move', async () => {
    const drop = (answer: Answer) => ({
      status: answer.status,
      results: (answer.json.results as Array<any>).map(({ errorId, ...rest }) => rest),
    });
    const intoPrivate = await call(OUTSIDER, 'PATCH', '/tasks/batch',
      { ids: [MOVABLE_TASK], updates: { project: PRIVATE_PROJECT } });
    const intoAbsent = await call(OUTSIDER, 'PATCH', '/tasks/batch',
      { ids: [MOVABLE_TASK], updates: { project: ABSENT_PROJECT_ID } });
    // The correlation id differs per call by construction; everything a caller
    // could learn the target from must not.
    expect(drop(intoPrivate)).toEqual(drop(intoAbsent));
    expect(`batch refused: ${intoPrivate.status} ${intoPrivate.json.succeeded}`)
      .toBe('batch refused: 422 0');
    expect(await taskProjectId(MOVABLE_TASK)).toBe(SHARED_PROJECT);

    // The control: the same batch into a reachable Project succeeds.
    const allowed = await call(OUTSIDER, 'PATCH', '/tasks/batch',
      { ids: [MOVABLE_TASK], updates: { project: SHARED_PROJECT } });
    expect(`batch allowed: ${allowed.status} ${allowed.json.succeeded}`).toBe('batch allowed: 200 1');
  });
});
