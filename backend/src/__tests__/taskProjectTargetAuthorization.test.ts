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


/** Planning authority is measured through the same real SQL point guard and
 * transaction writer. Task-write alone is insufficient, and Shepherd is not
 * generalized into task content-write. */
describe('pure planning transitions require current canonical authority', () => {
  async function fixture(who: Caller, status = 'ideas', grantWrite = true): Promise<string> {
    const inserted = await pool.query(
      `INSERT INTO tasks (title, status, visibility, creator_principal_id, shepherd_principal_id, auto_start)
       VALUES ($1, $2, 'private', $3, $4, false) RETURNING id`,
      [`planning authority ${tag()}`, status, ROOT_PRINCIPAL, who.principalId],
    );
    const id = String(inserted.rows[0].id);
    if (grantWrite) await grant(who.principalId, id);
    return id;
  }

  async function grant(principalId: string, taskId: string, verb = 'write'): Promise<void> {
    await pool.query(
      `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id)
       VALUES ('principal', $1, 'task', $2, $3, $4)`,
      [principalId, taskId, verb, ROOT_PRINCIPAL],
    );
  }

  async function state(id: string): Promise<any> {
    return (await pool.query('SELECT status, auto_start, title, shepherd_principal_id FROM tasks WHERE id = $1', [id])).rows[0];
  }

  async function ordinary(): Promise<Caller> {
    return sessionCallerFor('planning human', await makeAccount('human', 'user'));
  }

  it('ordinary account Shepherd with task-write moves both ways and retries without arming', async () => {
    const who = await ordinary();
    const id = await fixture(who);
    for (const status of ['todo', 'todo', 'ideas', 'ideas']) {
      const answer = await call(who, 'PATCH', `/tasks/${id}`, { status });
      expect({ status: answer.status, body: answer.status === 200 ? undefined : answer.json }).toEqual({ status: 200 });
      expect(await state(id)).toMatchObject({ status, auto_start: false, shepherd_principal_id: who.principalId });
    }
  });

  it('service Connector Shepherd uses canonical parent authority and its existing task-write scope', async () => {
    const account = await makeAccount('service', 'user');
    const who = await connectorCaller('planning connector', account, NARROW_SCOPES);
    const id = await fixture(who);
    await grant(account, id);
    expect((await call(who, 'PATCH', `/tasks/${id}`, { status: 'todo' })).status).toBe(200);
    expect(await state(id)).toMatchObject({ status: 'todo', auto_start: false });
  });

  it('canonical operator administration retains object authority without an additional tasks:admin scope', async () => {
    const account = await makeAccount('service', 'operator');
    const who = await connectorCaller('planning operator connector', account, NARROW_SCOPES);
    const id = await fixture(await ordinary(), 'ideas', false);
    expect((await call(who, 'PATCH', `/tasks/${id}`, { status: 'todo' })).status).toBe(200);
    expect(await state(id)).toMatchObject({ status: 'todo', auto_start: false });
  });

  it('a Shepherd without task-write cannot move or use Shepherd to edit content', async () => {
    const who = await ordinary();
    const id = await fixture(who, 'ideas', false);
    const before = await state(id);
    for (const body of [{ status: 'todo' }, { title: 'forbidden content' }]) {
      expect((await call(who, 'PATCH', `/tasks/${id}`, body)).status).toBeGreaterThanOrEqual(400);
      expect(await state(id)).toEqual(before);
    }
  });

  it('an unrelated writer cannot plan, even if a role is forged in the body', async () => {
    const who = await ordinary();
    const id = await fixture(await ordinary());
    await grant(who.principalId, id);
    const before = await state(id);
    for (const body of [{ status: 'todo' }, { status: 'todo', role: 'orchestrator' }]) {
      expect((await call(who, 'PATCH', `/tasks/${id}`, body)).status).toBeGreaterThanOrEqual(400);
      expect(await state(id)).toEqual(before);
    }
  });

  it.each([
    { title: 'no mixed content' }, { autoStart: true }, { autoStart: false },
    { id: 'discarded identity must not make this pure' }, { shepherdPrincipalId: null },
    { role: 'orchestrator' },
  ])('does not broaden planning authority to mixed payload %j', async (extra) => {
    const who = await ordinary();
    const id = await fixture(who);
    const before = await state(id);
    expect((await call(who, 'PATCH', `/tasks/${id}`, { status: 'todo', ...extra })).status).toBeGreaterThanOrEqual(400);
    expect(await state(id)).toEqual(before);
  });

  it.each(['in-progress', 'review', 'stuck', 'completed', 'archived'])('cannot reopen source state %s', async (source) => {
    const who = await ordinary();
    const id = await fixture(who, source);
    const before = await state(id);
    expect((await call(who, 'PATCH', `/tasks/${id}`, { status: 'todo' })).status).toBeGreaterThanOrEqual(400);
    expect(await state(id)).toEqual(before);
  });

  // Hold the Task lock until the real HTTP request reaches the writer. This
  // proves a fresh DB decision after the point guard, not merely a denial by
  // middleware using already-revoked credentials.
  async function mutateWhileWaiting(
    who: Caller,
    id: string,
    mutate: (client: any) => Promise<unknown>,
  ): Promise<Answer> {
    const blocker = await pool.connect();
    let request: Promise<Answer> | undefined;
    let committed = false;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [id]);
      request = call(who, 'PATCH', `/tasks/${id}`, { status: 'todo' });
      const deadline = Date.now() + 10_000;
      let waiting = false;
      while (Date.now() < deadline) {
        const result = await pool.query(
          `SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
           AND wait_event_type = 'Lock' AND query = 'SELECT * FROM tasks WHERE id = $1 FOR UPDATE'`,
        );
        if (result.rows.length) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(true);
      await mutate(blocker);
      await blocker.query('COMMIT');
      committed = true;
      return await request;
    } finally {
      if (!committed) await blocker.query('ROLLBACK');
      blocker.release();
      if (request) await request;
    }
  }

  it('uses the current Shepherd after waiting for the Task lock', async () => {
    const who = await ordinary();
    const replacement = await ordinary();
    const id = await fixture(who);
    const answer = await mutateWhileWaiting(who, id, client =>
      client.query('UPDATE tasks SET shepherd_principal_id = $1 WHERE id = $2', [replacement.principalId, id]));
    expect(answer.status).toBe(403);
    expect(await state(id)).toMatchObject({ status: 'ideas', auto_start: false, shepherd_principal_id: replacement.principalId });
  });

  it('rechecks a revoked object write grant after the point guard', async () => {
    const who = await ordinary();
    const id = await fixture(who);
    const answer = await mutateWhileWaiting(who, id, client =>
      client.query("DELETE FROM grants WHERE grantee_id = $1 AND resource_id = $2 AND verb = 'write'", [who.principalId, id]));
    expect(answer.status).toBe(403);
    expect(await state(id)).toMatchObject({ status: 'ideas', auto_start: false });
  });

  it('rechecks a disabled ancestor after the point guard', async () => {
    const account = await makeAccount('service', 'user');
    const who = await connectorCaller('planning parent disabled', account, NARROW_SCOPES);
    const id = await fixture(who);
    await grant(account, id);
    const answer = await mutateWhileWaiting(who, id, client =>
      client.query("UPDATE principals SET status = 'disabled' WHERE id = $1", [account]));
    expect(answer.status).toBe(403);
    expect(await state(id)).toMatchObject({ status: 'ideas', auto_start: false });
  });

  it('rechecks the presented credential even when another remains live', async () => {
    const account = await makeAccount('service', 'user');
    const who = await connectorCaller('planning credential revoked', account, NARROW_SCOPES);
    const id = await fixture(who);
    await grant(account, id);
    const spare = await principalService.issueCredential(
      { principalId: who.principalId, scopes: NARROW_SCOPES, transport: 'any' }, SYSTEM_ACTOR);
    const answer = await mutateWhileWaiting(who, id, client =>
      client.query('UPDATE principal_credentials SET revoked_at = NOW() WHERE principal_id = $1 AND id <> $2',
        [who.principalId, spare.credentialId]));
    expect(answer.status).toBe(403);
    expect(await state(id)).toMatchObject({ status: 'ideas', auto_start: false });
  });
  it('requires the presented task-write route scope', async () => {
    const account = await makeAccount('service', 'user');
    const who = await connectorCaller('planning read only', account, ['tasks:read']);
    const id = await fixture(who);
    await grant(account, id);
    const before = await state(id);
    expect((await call(who, 'PATCH', `/tasks/${id}`, { status: 'todo' })).status).toBe(403);
    expect(await state(id)).toEqual(before);
  });

  it('a task-bound Agent cannot exercise its Shepherd role across the task boundary', async () => {
    const account = await makeAccount('service', 'user');
    const connector = await connectorCaller('planning agent parent', account, NARROW_SCOPES);
    const bound = await fixture(await ordinary());
    const inserted = await pool.query(
      `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, bound_task_id, own_expression)
       VALUES ('agent', $1, 'planning agent', 'active', $2, $3, $4::jsonb) RETURNING id`,
      [`planning-agent-${tag()}`, connector.principalId, bound, JSON.stringify({ scopes: 'parent', objects: 'parent' })]);
    const principalId = String(inserted.rows[0].id);
    const issued = await principalService.issueCredential({ principalId, scopes: NARROW_SCOPES, transport: 'any' }, SYSTEM_ACTOR);
    const who: Caller = { label: 'cross-bound agent', principalId, headers: { Authorization: `Bearer ${issued.fullKey}` } };
    const id = await fixture(who);
    await grant(account, id);
    const before = await state(id);
    expect((await call(who, 'PATCH', `/tasks/${id}`, { status: 'todo' })).status).toBeGreaterThanOrEqual(400);
    expect(await state(id)).toEqual(before);
  });

  it('uses the current source status after waiting for the Task lock', async () => {
    const who = await ordinary();
    const id = await fixture(who);
    const answer = await mutateWhileWaiting(who, id, client =>
      client.query("UPDATE tasks SET status = 'completed' WHERE id = $1", [id]));
    expect(answer.status).toBe(403);
    expect(await state(id)).toMatchObject({ status: 'completed', auto_start: false });
  });

  it('rechecks a demoted account role despite its earlier session snapshot', async () => {
    const who = await ordinary();
    const id = await fixture(who);
    const answer = await mutateWhileWaiting(who, id, client =>
      client.query("UPDATE principals SET role = 'viewer' WHERE id = $1", [who.principalId]));
    expect(answer.status).toBe(403);
    expect(await state(id)).toMatchObject({ status: 'ideas', auto_start: false });
  });

  it('rechecks narrowed delegation scopes after the point guard', async () => {
    const account = await makeAccount('service', 'user');
    const who = await connectorCaller('planning narrowed scopes', account, NARROW_SCOPES);
    const id = await fixture(who);
    await grant(account, id);
    const answer = await mutateWhileWaiting(who, id, client =>
      client.query('UPDATE principals SET own_expression = $1::jsonb WHERE id = $2',
        [JSON.stringify({ scopes: ['tasks:read'], objects: 'parent' }), who.principalId]));
    expect(answer.status).toBe(403);
    expect(await state(id)).toMatchObject({ status: 'ideas', auto_start: false });
  });

  it('does not make a credential rotation wait for planner-held predecessor locks', async () => {
    const account = await makeAccount('service', 'user');
    const connector = await connectorCaller('planning rotation control', account, NARROW_SCOPES);
    const first = await principalService.issueCredential(
      { principalId: connector.principalId, scopes: NARROW_SCOPES, transport: 'any' }, SYSTEM_ACTOR);
    const second = await principalService.issueCredential(
      { principalId: connector.principalId, scopes: NARROW_SCOPES, transport: 'any' }, SYSTEM_ACTOR);
    // Choose the predecessor first in UUID order: this is the adverse order
    // for the rejected planner's all-credential SHARE lock.
    const [predecessor, current] = [first, second].sort((a, b) => a.credentialId.localeCompare(b.credentialId));
    const who: Caller = { ...connector, headers: { Authorization: `Bearer ${predecessor.fullKey}` } };
    const id = await fixture(who);
    await grant(account, id);
    await pool.query('UPDATE principal_credentials SET rotated_from_id = $1 WHERE id = $2',
      [predecessor.credentialId, current.credentialId]);
    const rotation = await pool.connect();
    let request: Promise<Answer> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await rotation.query('BEGIN');
      await rotation.query("SET LOCAL lock_timeout = '500ms'");
      // PrincipalService.rotateCredential takes current first, then updates
      // the predecessor. Planning must not add an inverse credential order.
      await rotation.query('SELECT id FROM principal_credentials WHERE id = $1 FOR UPDATE', [current.credentialId]);
      request = call(who, 'PATCH', `/tasks/${id}`, { status: 'todo' });
      const answer = await Promise.race([
        request,
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 3000); }),
      ]);
      await rotation.query('UPDATE principal_credentials SET revoked_at = NOW() WHERE id = $1', [predecessor.credentialId]);
      expect(answer?.status).toBe(200);
      expect(await state(id)).toMatchObject({ status: 'todo', auto_start: false });
    } finally {
      if (timer) clearTimeout(timer);
      await rotation.query('ROLLBACK');
      rotation.release();
      if (request) await request;
    }
  });

});


describe('whole-Task completion is an independent Verifier act', () => {
  async function reviewer(): Promise<Caller> {
    return sessionCallerFor('ordinary verifier', await makeAccount('human', 'user'));
  }
  async function fixture(who: Caller, statuses: string[] = [], parentStatus = 'review') {
    const inserted = await pool.query(
      `INSERT INTO tasks (title, status, visibility, creator_principal_id, owner_principal_id, verifier_principal_id, auto_start)
       VALUES ($1,$2,'private',$3,$4,$5,false) RETURNING id`,
      [`completion authority ${tag()}`, parentStatus, ROOT_PRINCIPAL, OUTSIDER.principalId, who.principalId]);
    const id = String(inserted.rows[0].id);
    const childIds: string[] = [];
    for (const [index, status] of statuses.entries()) {
      const child = await pool.query(
        'INSERT INTO subtasks (task_id,index,title,status) VALUES ($1,$2,$3,$4) RETURNING id',
        [id,index,`completion child ${index}`,status]);
      childIds.push(String(child.rows[0].id));
    }
    return { id, childIds };
  }
  async function state(id: string) {
    return {
      task: (await pool.query('SELECT status,auto_start,verifier_principal_id,owner_principal_id FROM tasks WHERE id=$1',[id])).rows[0],
      children: (await pool.query('SELECT id,status,title FROM subtasks WHERE task_id=$1 ORDER BY index',[id])).rows,
      history: (await pool.query('SELECT * FROM task_history WHERE task_id=$1 ORDER BY id',[id])).rows,
    };
  }
  async function finish(who: Caller,id: string) { return call(who,'PATCH',`/tasks/${id}`,{status:'completed'}); }
  async function waitForLock(queryPrefix: string) {
    const deadline=Date.now()+10_000;
    while(Date.now()<deadline) {
      const found=await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1",
        [queryPrefix+'%']);
      if(found.rows.length) return;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    throw new Error('expected real PostgreSQL writer lock wait');
  }
  // The barrier pauses a real writer after a real SQL statement, retaining
  // its actual locks. No rows, authority outcomes or query results are mocked.
  function barrier(id: string, match: (sql: string)=>boolean) {
    let release!: ()=>void;
    let entered!: ()=>void;
    let used=false;
    const held=new Promise<void>(resolve=>{ release=resolve; });
    const reached=new Promise<void>(resolve=>{ entered=resolve; });
    const original=pool.connect.bind(pool);
    const spy=jest.spyOn(pool,'connect').mockImplementation((...args: any[]): any => {
      if(args.length) return original(...args);
      return original().then((client:any)=>{
        const rawQuery=client.query.bind(client);
        const rawRelease=client.release.bind(client);
        client.query=async (sql:any, values?:any[])=>{
          const result=await rawQuery(sql,values);
          if(!used && values?.[0]===id && match(String(sql))) {
            used=true; entered(); await held;
          }
          return result;
        };
        client.release=(...releaseArgs:any[])=>{
          client.query=rawQuery; client.release=rawRelease; return rawRelease(...releaseArgs);
        };
        return client;
      });
    });
    return { reached, release, restore:()=>spy.mockRestore() };
  }
  async function bounded(promise: Promise<unknown>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([promise,new Promise((_,reject)=>{ timer=setTimeout(()=>reject(new Error('writer did not reach barrier')),10_000); })]);
    } finally { if(timer) clearTimeout(timer); }
  }

  it.each([{statuses:[]},{statuses:['completed','skipped']}])('ordinary Verifier completes terminal set %j without task-write object grant',async ({statuses})=>{
    const who=await reviewer(); const {id}=await fixture(who,statuses);
    // Canonical verify is an act, not generalized content-write.
    expect((await call(who,'PATCH',`/tasks/${id}`,{title:'forbidden content'})).status).toBeGreaterThanOrEqual(400);
    const answer=await finish(who,id);
    expect({status:answer.status,body:answer.status===200?undefined:answer.json}).toEqual({status:200});
    const after=await state(id);
    expect(after.task).toMatchObject({status:'completed',auto_start:false});
    expect(after.children.map((row:any)=>row.status)).toEqual(statuses);
    expect(after.history.length).toBeGreaterThan(0);
    expect(after.history.some((row:any)=>row.actor_principal_id===who.principalId)).toBe(true);
  });
  it('service Connector Verifier uses canonical authority without a promoted role',async()=>{
    const account=await makeAccount('service','user');
    const who=await connectorCaller('completion connector',account,NARROW_SCOPES);
    const {id}=await fixture(who,['completed']);
    expect((await finish(who,id)).status).toBe(200);
  });
  it.each(['empty','in-progress','review','stuck'])('refuses unfinished child %s without status or history changes',async status=>{
    const who=await reviewer(); const {id}=await fixture(who,[status]); const before=await state(id);
    expect((await finish(who,id)).status).toBe(409); expect(await state(id)).toEqual(before);
  });
  it.each(['ideas','todo','in-progress','stuck','completed','archived'])('refuses source %s',async status=>{
    const who=await reviewer(); const {id}=await fixture(who,[],status); const before=await state(id);
    expect((await finish(who,id)).status).toBe(403); expect(await state(id)).toEqual(before);
  });
  it.each([{title:'mixed'},{autoStart:false},{role:'reviewer'},{id:'discarded field'},{subtasks:[]}])('does not classify mixed completion as verify: %j',async extra=>{
    const who=await reviewer(); const {id}=await fixture(who); const before=await state(id);
    expect((await call(who,'PATCH',`/tasks/${id}`,{status:'completed',...extra})).status).toBeGreaterThanOrEqual(400);
    expect(await state(id)).toEqual(before);
  });
  it('refuses a writer who is not the current Verifier and a read-only presented scope',async()=>{
    const who=await reviewer(); const {id}=await fixture(who);
    const before=await state(id);
    expect((await finish(ROOT,id)).status).toBe(403);
    const account=await makeAccount('service','user');
    const narrow=await connectorCaller('completion read only',account,['tasks:read']);
    const own=await fixture(narrow);
    expect((await finish(narrow,own.id)).status).toBe(403);
    expect(await state(id)).toEqual(before);
  });

  it('uses a reassignment committed while approval waits for the Task lock',async()=>{
    const who=await reviewer(), replacement=await reviewer(); const {id}=await fixture(who);
    const gate=barrier(id,sql=>sql.startsWith('UPDATE tasks SET verifier_principal_id'));
    let assigning:Promise<Answer>|undefined, approval:Promise<Answer>|undefined;
    try {
      assigning=call(ROOT,'PATCH',`/tasks/${id}/roles`,{verifierPrincipalId:replacement.principalId});
      await bounded(gate.reached);
      approval=finish(who,id);
      await waitForLock('SELECT * FROM tasks WHERE id = $1 FOR UPDATE');
      gate.release(); expect((await assigning).status).toBe(200); expect((await approval).status).toBe(403);
      const after=await state(id);
      expect(after.task).toMatchObject({status:'review',verifier_principal_id:replacement.principalId});
      expect(after.history.some((row:any)=>JSON.stringify(row).includes('completed'))).toBe(false);
    } finally { gate.release(); gate.restore(); await assigning; await approval; }
  });
  it('serializes a later reassignment after approval without invalidating its prior identity snapshot',async()=>{
    const who=await reviewer(), replacement=await reviewer(); const {id}=await fixture(who);
    const gate=barrier(id,sql=>sql.endsWith('FOR UPDATE NOWAIT'));
    let assigning:Promise<Answer>|undefined, approval:Promise<Answer>|undefined;
    try {
      approval=finish(who,id); await bounded(gate.reached);
      assigning=call(ROOT,'PATCH',`/tasks/${id}/roles`,{verifierPrincipalId:replacement.principalId});
      // AZ-A10 clause 7: the role writer first locks the Task row to read the
      // holders it reaps and materializes, so its real wait is on that lock.
      // Owner ruling E462 S4b: the same lock also reads `verification_none`, which a Verifier clears.
      await waitForLock('SELECT shepherd_principal_id, verifier_principal_id, verification_none FROM tasks WHERE id = $1 FOR UPDATE');
      gate.release(); expect((await approval).status).toBe(200); expect((await assigning).status).toBe(200);
      const after=await state(id);
      expect(after.task).toMatchObject({status:'completed',verifier_principal_id:replacement.principalId});
      expect(after.history.some((row:any)=>row.actor_principal_id===who.principalId)).toBe(true);
    } finally { gate.release(); gate.restore(); await assigning; await approval; }
  });

  it.each(['by-id','index'])('requires explicit parent reopen through supported %s child status writer',async address=>{
    const who=await reviewer(); const {id,childIds}=await fixture(who,['completed'],'completed');
    const route=address==='by-id'?`/tasks/${id}/subtasks/by-id/${childIds[0]}/status`:`/tasks/${id}/subtasks/0/status`;
    const before=await state(id);
    const answer=await call(ROOT,'PATCH',route,{status:'review'});
    expect(answer).toMatchObject({status:409,json:{code:'TASK_REOPEN_REQUIRED',error:'Reopen the task before adding or reopening unfinished subtasks'}});
    expect(await state(id)).toEqual(before);
    expect((await call(ROOT,'PATCH',`/tasks/${id}`,{status:'review'})).status).toBe(200);
    expect((await call(ROOT,'PATCH',route,{status:'review'})).status).toBe(200);
    expect((await state(id)).children[0].status).toBe('review');
  });
  it('guards adding/replacing unfinished children but retains an authorized explicit parent reopen with edits',async()=>{
    const who=await reviewer(); const {id}=await fixture(who,[],'completed'); const before=await state(id);
    const body={subtasks:[{text:'new work',status:'empty'}]};
    expect((await call(ROOT,'PATCH',`/tasks/${id}`,body))).toMatchObject({status:409,json:{code:'TASK_REOPEN_REQUIRED'}});
    expect(await state(id)).toEqual(before);
    expect((await call(ROOT,'PATCH',`/tasks/${id}`,{status:'review',...body})).status).toBe(200);
    const after=await state(id); expect(after.task.status).toBe('review'); expect(after.children.map((row:any)=>row.status)).toEqual(['empty']);
  });

  it.each(['by-id','index'])('child-first %s supported writer commits open work and approval observes it',async address=>{
    const who=await reviewer(); const {id,childIds}=await fixture(who,['completed']);
    const route=address==='by-id'?`/tasks/${id}/subtasks/by-id/${childIds[0]}/status`:`/tasks/${id}/subtasks/0/status`;
    const gate=barrier(id,sql=>sql==='SELECT status FROM tasks WHERE id = $1 FOR UPDATE');
    let writer:Promise<Answer>|undefined,approval:Promise<Answer>|undefined;
    try {
      writer=call(ROOT,'PATCH',route,{status:'review'}); await bounded(gate.reached);
      approval=finish(who,id); await waitForLock('SELECT * FROM tasks WHERE id = $1 FOR UPDATE');
      gate.release(); expect((await writer).status).toBe(200); expect((await approval).status).toBe(409);
      const after=await state(id); expect(after.task.status).toBe('review'); expect(after.children[0].status).toBe('review');
      expect(after.history).toHaveLength(0);
    } finally { gate.release(); gate.restore(); await writer; await approval; }
  });
  it.each(['by-id','index'])('approval-first blocks %s reopening and then refuses it against Completed',async address=>{
    const who=await reviewer(); const {id,childIds}=await fixture(who,['completed']);
    const route=address==='by-id'?`/tasks/${id}/subtasks/by-id/${childIds[0]}/status`:`/tasks/${id}/subtasks/0/status`;
    const gate=barrier(id,sql=>sql.endsWith('FOR UPDATE NOWAIT'));
    let writer:Promise<Answer>|undefined,approval:Promise<Answer>|undefined;
    try {
      approval=finish(who,id); await bounded(gate.reached);
      writer=call(ROOT,'PATCH',route,{status:'review'}); await waitForLock('SELECT status FROM tasks WHERE id = $1 FOR UPDATE');
      gate.release(); expect((await approval).status).toBe(200);
      expect(await writer).toMatchObject({status:409,json:{code:'TASK_REOPEN_REQUIRED'}});
      const after=await state(id); expect(after.task.status).toBe('completed'); expect(after.children[0].status).toBe('completed');
      expect(after.history.filter((row:any)=>row.actor_principal_id===who.principalId)).toHaveLength(1);
    } finally { gate.release(); gate.restore(); await writer; await approval; }
  });

  it.each(['insert-first','approval-first'])('serializes supported insertion in %s order',async order=>{
    const who=await reviewer(); const {id}=await fixture(who);
    const body={subtasks:[{text:'new concurrent work',status:'empty'}]};
    const gate=barrier(id,sql=>order==='insert-first'
      ?sql==='SELECT * FROM tasks WHERE id = $1 FOR UPDATE':sql.endsWith('FOR UPDATE NOWAIT'));
    let writer:Promise<Answer>|undefined,approval:Promise<Answer>|undefined;
    try {
      if(order==='insert-first') { writer=call(ROOT,'PATCH',`/tasks/${id}`,body); await bounded(gate.reached); approval=finish(who,id); }
      else { approval=finish(who,id); await bounded(gate.reached); writer=call(ROOT,'PATCH',`/tasks/${id}`,body); }
      await waitForLock('SELECT * FROM tasks WHERE id = $1 FOR UPDATE');
      gate.release();
      const written=await writer, approved=await approval, after=await state(id);
      if(order==='insert-first') {
        expect(written.status).toBe(200); expect(approved.status).toBe(409);
        expect(after.task.status).toBe('review'); expect(after.children.map((row:any)=>row.status)).toEqual(['empty']);
        expect(after.history.some((row:any)=>JSON.stringify(row).includes('completed'))).toBe(false);
      } else {
        expect(approved.status).toBe(200); expect(written).toMatchObject({status:409,json:{code:'TASK_REOPEN_REQUIRED'}});
        expect(after.task.status).toBe('completed'); expect(after.children).toHaveLength(0);
        expect(after.history.filter((row:any)=>row.actor_principal_id===who.principalId)).toHaveLength(1);
      }
    } finally { gate.release(); gate.restore(); await writer; await approval; }
  });

  it('NOWAIT refusal leaves no partial status/history and releases the parent for a child-first transaction',async()=>{
    const who=await reviewer(); const {id,childIds}=await fixture(who,['completed']);
    const before=await state(id), client=await pool.connect();
    try {
      await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout='500ms'");
      await client.query('SELECT id FROM subtasks WHERE id=$1 FOR UPDATE',[childIds[0]]);
      expect(await finish(who,id)).toMatchObject({status:409,json:{code:'TASK_COMPLETION_BUSY',error:'Task is being changed; retry completion'}});
      expect(await state(id)).toEqual(before);
      await client.query('UPDATE tasks SET updated_at=NOW() WHERE id=$1',[id]);
      await client.query('UPDATE subtasks SET status=$1 WHERE id=$2',['review',childIds[0]]);
      await client.query('COMMIT');
      expect((await state(id)).task.status).toBe('review');
      expect((await state(id)).children[0].status).toBe('review');
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  it('verifies the actual immediate nondeferrable FK blocks a concurrent child insert',async()=>{
    const constraints=await pool.query(
      "SELECT condeferrable,condeferred,convalidated FROM pg_constraint WHERE contype='f' AND conrelid='subtasks'::regclass AND confrelid='tasks'::regclass");
    expect(constraints.rows).toEqual([{condeferrable:false,condeferred:false,convalidated:true}]);
    const who=await reviewer(); const {id}=await fixture(who);
    const parent=await pool.connect(), child=await pool.connect();
    let inserting:Promise<any>|undefined;
    try {
      await parent.query('BEGIN'); await parent.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[id]);
      await child.query('BEGIN');
      inserting=child.query("INSERT INTO subtasks (task_id,index,title,status) VALUES ($1,0,'FK probe','empty') RETURNING id",[id]);
      await waitForLock('INSERT INTO subtasks (task_id,index,title,status)');
      expect((await state(id)).children).toHaveLength(0);
      await parent.query('ROLLBACK'); expect((await inserting).rows).toHaveLength(1);
      await child.query('ROLLBACK'); expect((await state(id)).children).toHaveLength(0);
    } finally { await parent.query('ROLLBACK'); if(inserting) await inserting; await child.query('ROLLBACK'); parent.release(); child.release(); }
  });
  it.each(['qa','reviewer'])('external %s still needs the exact current independent Verifier',async role=>{
    const who=await sessionCallerFor('external review role',await makeAccount('human',role));
    const {id}=await fixture(await reviewer());
    // An admin object Grant supplies canonical verify, so the DB identity
    // check is measured rather than a vacuous point-stage refusal.
    await pool.query("INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id) VALUES('principal',$1,'task',$2,'admin',$3)",
      [who.principalId,id,ROOT_PRINCIPAL]);
    const before=await state(id);
    expect(await finish(who,id)).toMatchObject({status:403,json:{code:'TASK_COMPLETION_FORBIDDEN'}});
    expect(await state(id)).toEqual(before);
    const own=await fixture(who,[],'todo');
    expect(await finish(who,own.id)).toMatchObject({status:403,json:{code:'TASK_COMPLETION_FORBIDDEN'}});
    const valid=await fixture(who);
    expect((await finish(who,valid.id)).status).toBe(200);
  });
  // Card c3880767: agentInstructions and role are keys that are no field.
  // PATCH drops them before the write, so the write itself sees a pure
  // {status}; the raw body still decides the shape, so it stays mixed.
  it.each([{agentInstructions:'discarded'},{role:'agent'},{title:'mixed'},{notes:'mixed'}])('elevated assigned Verifier cannot normalize mixed completion into pure %j',async extra=>{
    const {id}=await fixture(ROOT); const before=await state(id);
    expect(await call(ROOT,'PATCH',`/tasks/${id}`,{status:'completed',...extra}))
      .toMatchObject({status:403,json:{code:'TASK_COMPLETION_PATCH_REQUIRED'}});
    expect(await state(id)).toEqual(before);
  });
  // Card c3880767: id and created name server-written columns. They were once
  // deleted from the body before the write; they are now refused by name, so
  // the completion never starts.
  it.each(['id','created'])('elevated assigned Verifier completion carrying %s is refused SERVER_WRITTEN_FIELD',async key=>{
    const {id}=await fixture(ROOT); const before=await state(id);
    expect(await call(ROOT,'PATCH',`/tasks/${id}`,{status:'completed',[key]:'discarded'}))
      .toMatchObject({status:400,json:{code:'SERVER_WRITTEN_FIELD',details:{field:key}}});
    expect(await state(id)).toEqual(before);
  });
  it('fresh role demotion during a parent wait defeats an earlier authenticated Verifier snapshot',async()=>{
    const who=await reviewer(); const {id}=await fixture(who), before=await state(id), blocker=await pool.connect();
    let approval:Promise<Answer>|undefined;
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[id]);
      approval=finish(who,id); await waitForLock('SELECT * FROM tasks WHERE id = $1 FOR UPDATE');
      await blocker.query("UPDATE principals SET role='viewer' WHERE id=$1",[who.principalId]);
      await blocker.query('COMMIT');
      expect(await approval).toMatchObject({status:403,json:{code:'TASK_COMPLETION_FORBIDDEN'}});
      expect(await state(id)).toEqual(before);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await approval; }
  });
  it.each(['resolver-first','writer-first'])('structured resolver and supported child writer share parent-first order: %s',async order=>{
    const who=await reviewer(); const {id,childIds}=await fixture(who,['review']);
    const gate=barrier(id,sql=>sql==='SELECT status FROM tasks WHERE id = $1 FOR UPDATE');
    const {taskManagerDB}=require('../services/TaskManagerDB');
    let resolver:Promise<boolean>|undefined,writer:Promise<Answer>|undefined;
    try {
      if(order==='resolver-first') {
        resolver=taskManagerDB.resolveReviewedSubtasks(id,'accepted','test verdict'); await bounded(gate.reached);
        writer=call(ROOT,'PATCH',`/tasks/${id}/subtasks/by-id/${childIds[0]}/status`,{status:'review'});
      } else {
        writer=call(ROOT,'PATCH',`/tasks/${id}/subtasks/by-id/${childIds[0]}/status`,{status:'review'}); await bounded(gate.reached);
        resolver=taskManagerDB.resolveReviewedSubtasks(id,'accepted','test verdict');
      }
      await waitForLock('SELECT status FROM tasks WHERE id = $1 FOR UPDATE');
      gate.release(); await resolver; expect((await writer).status).toBe(200);
      const after=await state(id); expect(after.task.status).toBe('review');
      expect(after.children[0].status).toBe(order==='resolver-first'?'review':'completed');
      expect(after.history).toHaveLength(0);
    } finally { gate.release(); gate.restore(); await resolver; await writer; }
  });

  it('ordinary canonical writer may repeat unchanged Completed while editing metadata and ignored fields',async()=>{
    const who=await reviewer(); const {id}=await fixture(who,['completed'],'completed');
    const before=await state(id);
    const answer=await call(OUTSIDER,'PATCH',`/tasks/${id}`,{status:'completed',title:'lawful metadata edit',agentInstructions:'ignored',role:'agent'});
    expect(answer.status).toBe(200);
    const after=await state(id);
    expect(after.task).toEqual(before.task); expect(after.children).toEqual(before.children);
    expect((await pool.query('SELECT title FROM tasks WHERE id=$1',[id])).rows[0].title).toBe('lawful metadata edit');
    expect(after.history).toEqual(before.history);
  });
  it('verify-only assigned Verifier cannot use unchanged mixed Completed for content-write',async()=>{
    const who=await reviewer(); const {id}=await fixture(who,[],'completed'); const before=await state(id);
    expect((await call(who,'PATCH',`/tasks/${id}`,{status:'completed',title:'forbidden metadata'})).status).toBeGreaterThanOrEqual(400);
    expect(await state(id)).toEqual(before);
  });

  it('breakdown generation uses the same reopen-first guard and returns its actionable conflict',async()=>{
    const who=await reviewer(); const {id}=await fixture(who,[],'completed');
    await pool.query("UPDATE tasks SET title='Implement a dashboard feature' WHERE id=$1",[id]);
    const before=await state(id);
    expect(await call(ROOT,'POST',`/tasks/${id}/breakdown`,{})).toMatchObject({status:409,json:{code:'TASK_REOPEN_REQUIRED'}});
    expect(await state(id)).toEqual(before);
  });

  it.each(['internal-first','reopen-first'])('explicit internal reviewer completion serializes prerequisites: %s',async order=>{
    const who=await reviewer(); const {id,childIds}=await fixture(who,['completed']);
    const gate=barrier(id,sql=>order==='internal-first'
      ?sql.endsWith('FOR UPDATE NOWAIT'):sql==='SELECT status FROM tasks WHERE id = $1 FOR UPDATE');
    const {taskManagerDB}=require('../services/TaskManagerDB');
    // The exact explicit actor used by TaskReviewerService.defaultDependencies.
    // This exercises its real transaction writer, not a mocked completion result.
    const internal={principalId:null,handle:'task-reviewer-service',role:'reviewer',authMethod:'system'};
    let approval:Promise<any>|undefined, writer:Promise<Answer>|undefined;
    const complete=()=>taskManagerDB.updateTask(id,{status:'completed'},internal)
      .then((task:any)=>({task}), (error:any)=>({error}));
    try {
      if(order==='internal-first') {
        approval=complete(); await bounded(gate.reached);
        writer=call(ROOT,'PATCH',`/tasks/${id}/subtasks/by-id/${childIds[0]}/status`,{status:'review'});
        await waitForLock('SELECT status FROM tasks WHERE id = $1 FOR UPDATE');
      } else {
        writer=call(ROOT,'PATCH',`/tasks/${id}/subtasks/by-id/${childIds[0]}/status`,{status:'review'}); await bounded(gate.reached);
        approval=complete(); await waitForLock('SELECT * FROM tasks WHERE id = $1 FOR UPDATE');
      }
      gate.release();
      const approved=await approval, written=await writer, after=await state(id);
      if(order==='internal-first') {
        expect(approved.task.status).toBe('completed'); expect(written).toMatchObject({status:409,json:{code:'TASK_REOPEN_REQUIRED'}});
        expect(after.task.status).toBe('completed'); expect(after.children[0].status).toBe('completed');
        expect(after.history).toHaveLength(1);
      } else {
        expect(written.status).toBe(200); expect(approved.error.status).toBe(409);
        expect(after.task.status).toBe('review'); expect(after.children[0].status).toBe('review');
        expect(after.history).toHaveLength(0);
      }
    } finally { gate.release(); gate.restore(); await approval; await writer; }
  });

});
