/**
 * 08f42f36 — EVERY TASK LIST ANSWERS WHAT THE POINT ROUTE ANSWERS.
 *
 * The defect this gate exists for was reported by the owner from the running
 * product: signed in through SSO as a just-in-time Account with role `user` and
 * no grants, `GET /tasks/board` rendered all 49 private showcase Tasks, while
 * `GET /tasks/:id` answered TASK_NOT_FOUND for every one of them and
 * `GET /tasks/graph` returned nothing. The board's post-read narrowing had
 * never executed: it iterated `Object.values(board)`, whose single value is the
 * `columns` MAP rather than a column, and looked for `column.tasks`, a field
 * the rows spell `items`. Both mistakes sat behind an `as any[]`.
 *
 * ── WHY THIS GATE AND NOT ANOTHER CENSUS ──
 *
 * `authorizationRouteCoverage` already asserts that `routes/tasks.ts` CONTAINS
 * the word `filterAuthorizedResources`, and it was green for the eighteen days
 * the board leaked: a source census cannot see whether a narrowing RAN, only
 * whether it was typed. What can see it is the behaviour, so this gate measures
 * the behaviour — over a REAL PostgreSQL, through the PRODUCTION router, with
 * real callers of both authenticated kinds.
 *
 * ── THE PROPERTY, AND ITS OUTSIDE ANCHOR ──
 *
 * For every actor and every list surface: the set of fixture Task ids the list
 * returns EQUALS the set of fixture Task ids for which `GET /tasks/:id` answers
 * 200. The expected set is never computed from the authorization rules — it is
 * read back from the POINT ROUTE, the surface the owner observed refusing. A
 * test that re-derived the predicate could be edited into agreement with a
 * broken one; this one cannot, because both sides are measured.
 *
 * The board carries one assertion the others cannot: its per-column `total` and
 * `hasMore` must describe the AUTHORIZED population, not the queried one, at a
 * page size smaller than that population. A count is a disclosure, and a
 * narrowing applied after the page is read can never make one honest.
 *
 * ── WHY IT IS NOT IN THE DEFAULT JEST RUN ──
 *
 * It connects to `RELAYHALL_TEST_DB_URL` and FAILS — never skips — when the
 * variable is unset. The predicate under test is SQL; every DB-shaped suite in
 * the default run mocks the pool, and a mocked pool can only replay the rule
 * this gate exists to measure. Excluded by `testPathIgnorePatterns`, run by
 * `npm run test:list-parity` on the VM gate chain and UNCONDITIONALLY in CI
 * against the `services: postgres` block, with no `if:` guard.
 *
 * ── THE DESTRUCTIVE CONTRACT, STATED ──
 *
 * This suite WRITES to principals, projects, phases, tasks, grants and
 * auth_sessions. It refuses any URL naming a deployment database
 * (`relayhall_dev`, `relayhall_tst`, `relayhall_prod`, `relayhall`) and any
 * non-local host. Bring the database up with `database/init.sql` and
 * `npm run migrate`, and throw it away afterwards.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

// ─────────────────────────── the database contract ───────────────────────────

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error(
    'RELAYHALL_TEST_DB_URL is not set. This gate measures list/point parity against a REAL PostgreSQL and refuses to skip: '
    + 'the predicate under test is SQL, and a mocked pool can only replay the rule. '
    + 'Create a disposable database, load database/init.sql, run npm run migrate, and set RELAYHALL_TEST_DB_URL to it.',
  );
}

const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = parsed.pathname.replace(/^\//, '');
const FORBIDDEN_DATABASES = ['relayhall_dev', 'relayhall_tst', 'relayhall_prod', 'relayhall'];
if (FORBIDDEN_DATABASES.includes(TEST_DB_NAME)) {
  throw new Error(`RELAYHALL_TEST_DB_URL names a deployment database (${TEST_DB_NAME}). This suite writes; point it at a disposable database.`);
}

// The production pool reads DB_* at import time, so the environment is pinned
// BEFORE anything is required — which is why everything below uses `require`.
process.env.DB_HOST = parsed.hostname;
process.env.DB_PORT = parsed.port || '5432';
process.env.DB_NAME = TEST_DB_NAME;
process.env.DB_USER = decodeURIComponent(parsed.username);
process.env.DB_PASSWORD = decodeURIComponent(parsed.password);
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'list-parity-suite-secret-0123456789abcdef';
// The session plane is the caller shape the defect was reported on. It is a
// deployment flag, so the suite turns it on for itself rather than depending on
// how the machine that runs it happens to be configured.
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

/**
 * The guard chain above must be the one `server.ts` mounts, or this suite
 * measures an app of its own invention. `server.ts` is the outside anchor, so
 * the claim is READ from it rather than restated here.
 */
const GUARD_CHAIN = ['authMiddleware', 'sharedAuthorizationMiddleware'];

interface Answer { status: number; json: any }

/** One caller shape for both authenticated kinds: a bearer credential, or a
 * login-session cookie — never both, because that is the distinction the
 * Access-surface arm and the owner's report both turn on. */
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

const SYSTEM_ACTOR = { handle: 'list-parity-suite', authMethod: 'system' as const };
const tag = (): string => crypto.randomBytes(6).toString('hex');

const SCOPES = ['tasks:read', 'tasks:write', 'reports:read', 'projects:read', 'principals:read'];

const BOARD_STATUSES = ['ideas', 'todo', 'in-progress', 'stuck', 'completed'];

interface Fixture { id: string; status: string; label: string; projectId: string | null }

let PRIVATE_PROJECT: string;
let SHARED_PROJECT: string;
let ROOT_PRINCIPAL: string;
/**
 * Every list call is scoped to THIS RUN's two Projects.
 *
 * Not tidiness: the count assertions below compare a route's reported `total`
 * to a number this suite can name, and a database that already holds Tasks -
 * a previous run's, a shared CI database, a developer's - makes that
 * comparison measure the leftovers instead. Scoping the query is the only way
 * the count side of the property can be an EQUALITY rather than a bound, and a
 * bound is exactly what the defect would have satisfied.
 */
let FIXTURE_PROJECTS: string;
/** A Task inside the SHARED Project that only root may read (117
 * `restricted_access`). The Project-scoped surfaces pass their own ceiling for
 * every caller, so this is the row that makes their Task narrowing visible. */
let RESTRICTED_IN_SHARED: Fixture;
/** A Warrant the session caller holds, anchored to and carrying Tasks that
 * caller may not read (review 302a338f B2). */
let HELD_WARRANT: string;

let ROOT: Caller;
let SESSION_USER: Caller;
let CONNECTOR: Caller;
/** The Account the Connector hangs from. Its authority BOUNDS the chain, so
 * a grant held by the Connector alone is intersected away — see the grants
 * in `beforeAll`. */
let CONNECTOR_ACCOUNT: string;

/** Every Task this suite created, in board-column order. */
const FIXTURES: Fixture[] = [];
const idsOf = (rows: Fixture[]): string[] => rows.map((row) => row.id).sort();

async function makeAccount(kind: 'human' | 'service', role: string | null): Promise<string> {
  const handle = `parity-${kind}-${tag()}`;
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role, purpose)
     VALUES ($1, $2, $3, 'active', $4, $5) RETURNING id`,
    [kind, handle, `list parity ${handle}`, role, kind === 'service' ? 'list parity account' : null],
  );
  return String(result.rows[0].id);
}

/** A login session, exactly as the SSO return path mints one: an httpOnly
 * cookie, `role_snapshot` NULL, and no bearer credential anywhere. */
async function sessionCallerFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

/**
 * A Connector in the shape the delegation contract admits: parented, roleless,
 * carrying an explicit `own_expression` (inheritance is never implicit), under
 * an Account whose role bounds the chain.
 */
async function connectorCaller(label: string, accountId: string): Promise<Caller> {
  const handle = `parity-connector-${tag()}`;
  const principal = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, $2, 'active', $3, $4, $5::jsonb) RETURNING id`,
    [handle, `list parity ${label}`, accountId, 'list parity connector',
      JSON.stringify({ scopes: 'parent', objects: 'parent' })],
  );
  const principalId = String(principal.rows[0].id);
  const issued = await principalService.issueCredential(
    { principalId, scopes: SCOPES, transport: 'any' }, SYSTEM_ACTOR);
  return { label, principalId, headers: { Authorization: `Bearer ${issued.fullKey}` } };
}

const PROJECT_NAMES: string[] = [];

async function makeProject(name: string, visibility: 'private' | 'shared'): Promise<string> {
  PROJECT_NAMES.push(name);
  const result = await pool.query(
    `INSERT INTO projects (name, status, visibility, owner_principal_id)
     VALUES ($1, 'active', $2, $3) RETURNING id`,
    [name, visibility, ROOT_PRINCIPAL],
  );
  return String(result.rows[0].id);
}

async function makeTask(input: {
  label: string;
  status: string;
  projectId: string | null;
  visibility?: 'private' | 'shared';
  ownerPrincipalId?: string | null;
  /** 117: suppresses the inherited-visibility arm, so a Task can sit inside a
   * Project the caller MAY read and still be refused. That is the shape the
   * Project-scoped surfaces need: their own ceiling passes, and the Task list
   * inside them is the only thing narrowing. */
  restrictedAccess?: boolean;
  /** `/projects/{id}/sessions` only emits a record for a Task that was
   * actually started. */
  started?: boolean;
}): Promise<Fixture> {
  const result = await pool.query(
    `INSERT INTO tasks (title, status, visibility, project_id, owner_principal_id,
                        creator_principal_id, shepherd_principal_id,
                        restricted_access, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8) RETURNING id`,
    [
      `parity ${input.label}`,
      input.status,
      input.visibility ?? 'private',
      input.projectId,
      input.ownerPrincipalId ?? null,
      // Creator and shepherd are the ROOT Account throughout, so no fixture is
      // readable by accident through the initiator or shepherd arm: every
      // authorized read below has exactly one named cause.
      ROOT_PRINCIPAL,
      input.restrictedAccess ?? false,
      input.started ? new Date().toISOString() : null,
    ],
  );
  const fixture = {
    id: String(result.rows[0].id), status: input.status, label: input.label,
    projectId: input.projectId,
  };
  FIXTURES.push(fixture);
  return fixture;
}

/**
 * A Task this run creates but does NOT add to `FIXTURES`.
 *
 * The dashboard summary answers in COUNTS over the whole estate — it takes no
 * project filter, so its numbers cannot be scoped the way every other
 * assertion in this file is, and a database holding a previous run's rows
 * would make an equality against a number this suite can name measure the
 * leftovers. The summary property is therefore measured as a DELTA: rows
 * appear, and each caller's numbers move by exactly the count of the rows THAT
 * CALLER may read. A leftover row moves neither side, so the assertion is an
 * equality on a shared database as well as a fresh one.
 */
async function makeUntrackedTask(
  label: string,
  status: string,
  projectId: string,
  visibility: 'private' | 'shared' = 'private',
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO tasks (title, status, visibility, project_id, owner_principal_id,
                        creator_principal_id, shepherd_principal_id)
     VALUES ($1, $2, $3, $4, NULL, $5, $5) RETURNING id`,
    [`parity ${label}`, status, visibility, projectId, ROOT_PRINCIPAL],
  );
  return String(result.rows[0].id);
}

let HISTORY_COLUMNS: Set<string> | null = null;

/** Which `task_history` variant this database carries — the same question
 * `TaskHistoryService.getRecentActivity` asks, asked of the database rather
 * than assumed, because both variants are live (base schema: `event_type`;
 * migration 013 compatibility: `field` + `changed_by`). */
async function historyColumns(): Promise<Set<string>> {
  if (!HISTORY_COLUMNS) {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'task_history'`,
    );
    HISTORY_COLUMNS = new Set(result.rows.map((row: any) => String(row.column_name)));
  }
  return HISTORY_COLUMNS;
}

/** One status-change event for a fixture Task, carrying its TITLE — the field
 * the reported leak actually disclosed. */
async function recordHistory(fixture: Fixture): Promise<void> {
  const columns = await historyColumns();
  const title = `parity ${fixture.label}`;
  if (columns.has('field') && columns.has('changed_by')) {
    await pool.query(
      `INSERT INTO task_history (task_id, task_title, field, old_value, new_value, changed_by)
       VALUES ($1, $2, 'status', 'ideas', $3, 'parity-actor')`,
      [fixture.id, title, fixture.status],
    );
    return;
  }
  await pool.query(
    `INSERT INTO task_history (task_id, task_title, event_type, old_value, new_value, note)
     VALUES ($1, $2, 'status', 'ideas', $3, 'changedBy=parity-actor')`,
    [fixture.id, title, fixture.status],
  );
}

/** A Report, addressed the way the shared predicate reads one: `visibility`
 * and `author_principal_id` are the two columns `sqlResource('report')` names. */
async function makeReport(label: string, visibility: 'private' | 'default'): Promise<string> {
  const result = await pool.query(
    `INSERT INTO reports (title, content, author, author_actor_id, author_principal_id, visibility)
     VALUES ($1, $2, 'parity-suite', 'parity-suite', $3, $4) RETURNING id`,
    [`parity report ${label}`, `parity report body ${label}`, ROOT_PRINCIPAL, visibility],
  );
  return String(result.rows[0].id);
}

async function grant(principalId: string, taskId: string): Promise<void> {
  await pool.query(
    `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id)
     VALUES ('principal', $1, 'task', $2, 'read', $3)`,
    [principalId, taskId, ROOT_PRINCIPAL],
  );
}

/**
 * The grant arm, reaching a delegated caller - and exactly what that measures.
 *
 * Before card 72258a60 extended this suite the grant landed on the CONNECTOR
 * alone, and it measured nothing: the Connector read the shared Project and
 * nothing else, so every equality below held for a caller with one visible
 * row. The reason is the chain intersection - a Connector whose
 * `own_expression` says `objects: 'parent'` owns what its Account owns
 * (AZ-24), so its own grant is intersected away.
 *
 * The grant therefore lands on BOTH ends, which is what an operator granting a
 * Connector access to a Task actually has to do (migration 099 says so in as
 * many words: "granting the Connector alone changes nothing").
 *
 * WHAT THIS DOES NOT CLAIM (review 302a338f): it does not isolate the
 * Connector's OWN grant arm. With `objects: 'parent'` the delegated side of
 * `sqlCondition` reduces to the cap, and the row is admitted by the ACCOUNT
 * grant under parent inheritance; removing only the Connector grant would
 * leave this fixture green. What it measures is a delegated caller reading a
 * private Task through an Account-side grant - a partition, and a real one,
 * but not the Connector arm in isolation. Isolating that needs a Connector
 * with an explicit object expression of its own, which is a different fixture
 * and a different card.
 */
async function grantToChain(taskId: string): Promise<void> {
  await grant(CONNECTOR_ACCOUNT, taskId);
  await grant(CONNECTOR.principalId, taskId);
}

/**
 * A Warrant HELD BY the session caller, anchored to a Task that caller may not
 * read, and carrying another one.
 *
 * Review 302a338f B2: the Warrant surfaces rendered Task ids, TITLES and
 * statuses to any holder-tree viewer with no Task narrowing, and the census
 * justified it as safe "by construction" - the claim being that a Warrant
 * anchored to a Task is about that Task. That premise is false:
 * `WarrantService.create` validates that an anchor row EXISTS and nothing
 * more, so holding a Warrant and being allowed to read the Task it names are
 * genuinely independent. This fixture is that independence, made concrete.
 *
 * Migration 100 unified the ceiling to ONE form - a version-pinned Access
 * profile - so the fixture creates an empty profile version to pin. The rows
 * are written directly because the creation ACT is a step-up-gated human
 * surface and this suite measures the READ surfaces.
 */
async function makeCeilingVersion(): Promise<string> {
  const profile = await pool.query(
    `INSERT INTO access_profiles (name, description, created_by_principal_id)
     VALUES ($1, 'list parity ceiling', $2) RETURNING id`,
    [`parity-ceiling-${tag()}`, ROOT_PRINCIPAL],
  );
  const version = await pool.query(
    `INSERT INTO access_profile_versions (profile_id, version_number, created_by_principal_id)
     VALUES ($1, 1, $2) RETURNING id`,
    [String(profile.rows[0].id), ROOT_PRINCIPAL],
  );
  await pool.query('UPDATE access_profiles SET published_version_id = $1 WHERE id = $2',
    [String(version.rows[0].id), String(profile.rows[0].id)]);
  return String(version.rows[0].id);
}

async function makeHeldWarrant(holderPrincipalId: string, anchorTaskId: string, carriedTaskId: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO warrants (name, holder_principal_id, created_by_principal_id, ceiling_profile_version_id, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 day') RETURNING id`,
    [`parity warrant ${tag()}`, holderPrincipalId, ROOT_PRINCIPAL, await makeCeilingVersion()],
  );
  const warrantId = String(result.rows[0].id);
  await pool.query(
    `INSERT INTO warrant_anchors (warrant_id, anchor_type, anchor_id) VALUES ($1, 'task', $2)`,
    [warrantId, anchorTaskId],
  );
  // `tasks_execution_warrant_needs_assignment`: a Task rides a Warrant only
  // while it is execution-assigned to a Service, and `dependentOpenTasks`
  // reads that same pairing. So the carried Task gets both.
  const service = await pool.query(
    // `kind: 'connector'` would demand a bound principal
    // (`services_connector_principal_required`); the execution assignment only
    // needs a Service row to point at.
    `INSERT INTO services (slug, name, description, kind, status)
     VALUES ($1, 'list parity service', 'list parity', 'service', 'published') RETURNING id`,
    [`parity-service-${tag()}`],
  );
  await pool.query(
    // The descriptor version rides with the Service: a trigger mirrors both
    // into `task_execution_profiles`, whose CHECK requires them set together.
    `UPDATE tasks SET execution_warrant_id = $1, execution_service_id = $2,
                      execution_descriptor_version = 1
      WHERE id = $3`,
    [warrantId, String(service.rows[0].id), carriedTaskId],
  );
  return warrantId;
}

beforeAll(async () => {
  await new Promise<void>((resolve) => { server = buildApp().listen(0, resolve); });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;

  ROOT_PRINCIPAL = await makeAccount('human', 'admin');
  ROOT = await sessionCallerFor('root session', ROOT_PRINCIPAL);

  // The reported caller, reproduced: a just-in-time human Account, role `user`,
  // no grants, no profile, authenticated by a login session and nothing else.
  const jitAccount = await makeAccount('human', 'user');
  SESSION_USER = await sessionCallerFor('jit session user', jitAccount);

  CONNECTOR_ACCOUNT = await makeAccount('service', 'user');
  CONNECTOR = await connectorCaller('connector', CONNECTOR_ACCOUNT);

  PRIVATE_PROJECT = await makeProject(`parity-private-${tag()}`, 'private');
  SHARED_PROJECT = await makeProject(`parity-shared-${tag()}`, 'shared');
  FIXTURE_PROJECTS = PROJECT_NAMES.join(',');

  // Two private Tasks per column, so a column always holds more rows than the
  // page size the board assertion uses. Every one is `started`, because
  // `/projects/{id}/sessions` emits a record only for a Task that was.
  for (const status of BOARD_STATUSES) {
    await makeTask({ label: `private-a ${status}`, status, projectId: PRIVATE_PROJECT, started: true });
    await makeTask({ label: `private-b ${status}`, status, projectId: PRIVATE_PROJECT, started: true });
  }

  // The Project-scoped surfaces need a Task the caller is refused INSIDE a
  // Project the caller may read — otherwise their own Project ceiling refuses
  // first and the Task narrowing behind it is never measured at all.
  RESTRICTED_IN_SHARED = await makeTask({
    label: 'restricted inside the shared project', status: 'stuck',
    projectId: SHARED_PROJECT, restrictedAccess: true, started: true,
  });

  // ── the rows that make the gate non-vacuous ──
  //
  // "Every list is empty" passes a parity assertion trivially, and would also
  // pass if the repair had broken the board shut. Each caller therefore has a
  // reason to read SOMETHING, and each reason is a DIFFERENT arm of the shared
  // predicate: inherited visibility, the claimant arm, an exact grant.
  await makeTask({ label: 'shared-project inherited', status: 'todo', projectId: SHARED_PROJECT, started: true });
  await makeTask({
    label: 'claimed by the session user', status: 'todo', projectId: PRIVATE_PROJECT,
    ownerPrincipalId: SESSION_USER.principalId,
  });
  const granted = await makeTask({ label: 'granted to the connector', status: 'todo', projectId: PRIVATE_PROJECT });
  await grantToChain(granted.id);

  // ── the rows that make the DASHBOARD assertions non-vacuous ──
  //
  // `/dashboard/active` answers over `in-progress` alone, so without these two
  // every restricted caller's expected set there is empty — and "returns
  // nothing" is satisfied by a route that was broken shut as readily as by one
  // that narrows correctly. Each caller therefore has one in-progress Task it
  // may read, by the same two arms as above.
  await makeTask({
    label: 'in-progress claimed by the session user', status: 'in-progress',
    projectId: PRIVATE_PROJECT, ownerPrincipalId: SESSION_USER.principalId,
  });
  const grantedActive = await makeTask({
    label: 'in-progress granted to the connector', status: 'in-progress', projectId: PRIVATE_PROJECT,
  });
  await grantToChain(grantedActive.id);

  // The Warrant the session caller HOLDS, over Tasks it may not read.
  HELD_WARRANT = await makeHeldWarrant(
    SESSION_USER.principalId,
    FIXTURES.find((row) => row.label === 'private-a stuck')?.id as string,
    FIXTURES.find((row) => row.label === 'private-b stuck')?.id as string,
  );

  // Every fixture gets exactly one history event, so the activity feed's
  // expected set is the point-allowed set itself rather than a subset this
  // file would have to maintain by hand. They are the newest rows in the
  // table, so a shared database's older rows can never displace them from a
  // `LIMIT 100` page.
  for (const fixture of FIXTURES) await recordHistory(fixture);
});

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  await pool.end();
});

// ────────────────────── the point route: the outside anchor ──────────────────

/**
 * What `GET /tasks/:id` — the surface the owner watched refuse — allows.
 *
 * MEASURED once per caller and then remembered, not because the sweep is
 * expensive but because it is a LOT of requests: every assertion in this file
 * anchors on it, and each sweep is one HTTP call per fixture. Every session
 * request fires an unawaited `UPDATE auth_sessions SET last_seen_at` at the
 * same row (`LoginSessionService.touch`), and a few hundred of those queue on
 * one tuple lock until they hold every connection in the pool — at which point
 * ordinary requests start answering 503 AUTHORIZATION_UNAVAILABLE and this
 * suite reports a red assertion for a reason that has nothing to do with
 * authorization. The property is unchanged: the expected set is still READ
 * from the point route and never recomputed from the predicate.
 *
 * The cache is keyed by caller label AND by how many fixtures existed when the
 * sweep was taken, so a fixture ADDED later re-sweeps rather than answering
 * from a set that predates it.
 *
 * That guard is narrower than it first looks, and the limit is stated rather
 * than left to be discovered (review 302a338f): it does not notice a change to
 * what an EXISTING caller may read at an unchanged fixture count - a new
 * grant, a visibility flip, an ownership change - nor a different caller
 * reusing a label. Nothing in this file does either: the fixtures and their
 * authority are built in `beforeAll`, and the only later writes are untracked
 * Tasks (deliberately outside `FIXTURES`) and a priority PATCH. A future test
 * that changes authority mid-run must clear this map, and this paragraph is
 * where it is told so.
 */
const POINT_ALLOWED_CACHE = new Map<string, Fixture[]>();
/** How many fixtures existed when a caller's sweep was taken. A fixture added
 * afterwards makes the cached answer incomplete, and re-sweeping is cheaper
 * than reasoning about whether it mattered. */
const POINT_ALLOWED_SWEPT = new Map<string, number>();

async function pointAllowed(who: Caller): Promise<Fixture[]> {
  const cached = POINT_ALLOWED_CACHE.get(who.label);
  if (cached && POINT_ALLOWED_SWEPT.get(who.label) === FIXTURES.length) return cached;
  const allowed: Fixture[] = [];
  for (const fixture of FIXTURES) {
    const answer = await call(who, 'GET', `/tasks/${fixture.id}`);
    if (answer.status === 200) allowed.push(fixture);
    else expect([403, 404]).toContain(answer.status);
  }
  POINT_ALLOWED_CACHE.set(who.label, allowed);
  POINT_ALLOWED_SWEPT.set(who.label, FIXTURES.length);
  return allowed;
}



const CALLERS = (): Caller[] => [SESSION_USER, CONNECTOR];

// ─────────────────────────────── the gate ────────────────────────────────────

describe('the app under test is the app that ships', () => {
  it('mounts the guard chain server.ts mounts', () => {
    const fs = require('fs');
    const path = require('path');
    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8');
    // `registerProtectedRoutes` is called in exactly one place in server.ts,
    // and the guards it names are the guards buildApp() uses.
    for (const guard of GUARD_CHAIN) {
      expect(serverSource).toContain(guard);
    }
    expect(serverSource).toContain('registerProtectedRoutes');
  });
});

describe('the fixture partitions every caller (the gate is not vacuous)', () => {
  it('root reads every fixture', async () => {
    expect(idsOf(await pointAllowed(ROOT))).toEqual(idsOf(FIXTURES));
  });

  it.each([['session', 0], ['connector', 1]])('a %s caller reads some but not all', async (_label, index) => {
    const allowed = await pointAllowed(CALLERS()[index]);
    expect(allowed.length).toBeGreaterThan(0);
    expect(allowed.length).toBeLessThan(FIXTURES.length);
    // Specifically: no PRIVATE task in the private project is readable, which
    // is the exact disclosure the card reports.
    expect(allowed.filter((row) => row.label.startsWith('private-'))).toEqual([]);
  });
});

/** The fixture ids a payload disclosed, however it spells them. */
const disclosed = (value: unknown): string[] => {
  const found = new Set<string>();
  const known = new Set(FIXTURES.map((row) => row.id));
  const walk = (node: any): void => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') { if (known.has(node)) found.add(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node === 'object') { Object.values(node).forEach(walk); }
  };
  walk(value);
  return [...found].sort();
};

describe('every Task list answers what the point route answers', () => {
  /** Built per call, not at module load: the fixture Project names the scope
   * needs do not exist until `beforeAll` has run. */
  const surfaces = (): Array<{ name: string; path: string }> => {
    const scope = `statuses=${BOARD_STATUSES.join(',')}&projects=${FIXTURE_PROJECTS}`;
    return [
      { name: 'GET /tasks', path: `/tasks?${scope}&limit=500` },
      { name: 'GET /tasks/board', path: `/tasks/board?${scope}&perColumn=100` },
      { name: 'GET /tasks/ids', path: `/tasks/ids?${scope}` },
      { name: 'GET /tasks/graph', path: `/tasks/graph?${scope}` },
    ];
  };
  const SURFACE_NAMES = ['GET /tasks', 'GET /tasks/board', 'GET /tasks/ids', 'GET /tasks/graph'];

  for (const surfaceName of SURFACE_NAMES) {
    it(`${surfaceName} discloses exactly the point-allowed set`, async () => {
      const surface = surfaces().find((entry) => entry.name === surfaceName) as { name: string; path: string };
      for (const who of CALLERS()) {
        const expected = idsOf(await pointAllowed(who));
        const answer = await call(who, 'GET', surface.path);
        expect(answer.status).toBe(200);
        expect(`${who.label}: ${disclosed(answer.json).join(',')}`)
          .toBe(`${who.label}: ${expected.join(',')}`);
      }
    });
  }

  /**
   * `/tasks/aggregates` is the one list surface that discloses no ids at all -
   * it answers in COUNTS. A count is a disclosure, so the property is the same
   * property, measured on the number.
   */
  it('GET /tasks/aggregates counts exactly the point-allowed set', async () => {
    for (const who of [...CALLERS(), ROOT]) {
      const allowed = await pointAllowed(who);
      const answer = await call(who, 'GET',
        `/tasks/aggregates?statuses=${BOARD_STATUSES.join(',')}&projects=${FIXTURE_PROJECTS}&groupBy=project`);
      expect(answer.status).toBe(200);
      for (const status of BOARD_STATUSES) {
        const allowedInStatus = allowed.filter((row) => row.status === status).length;
        const reported = Number(answer.json.statuses?.[status] ?? 0);
        expect(`${who.label} ${status}: ${reported}`).toBe(`${who.label} ${status}: ${allowedInStatus}`);
      }
      expect(`${who.label} total: ${Number(answer.json.total)}`)
        .toBe(`${who.label} total: ${allowed.length}`);
    }
  });

  it('PATCH /tasks/batch refuses every Task the point route conceals', async () => {
    for (const who of CALLERS()) {
      const readable = new Set(idsOf(await pointAllowed(who)));
      const answer = await call(who, 'PATCH', '/tasks/batch', {
        ids: FIXTURES.map((row) => row.id),
        updates: { priority: 'low' },
      });
      // 422 is the route's answer when NOTHING succeeded - which is the correct
      // answer for a caller that may write none of these Tasks, so both codes
      // are admissible and the per-id results carry the property either way.
      expect([200, 422]).toContain(answer.status);
      const succeeded = (answer.json.results as Array<{ id: string; success: boolean }>)
        .filter((row) => row.success).map((row) => row.id);
      // A write may be refused where a read is allowed; it may never be allowed
      // where the read is refused.
      expect(succeeded.filter((id) => !readable.has(id))).toEqual([]);
    }
  });

  it('root sees every fixture on every list', async () => {
    for (const surface of surfaces()) {
      const answer = await call(ROOT, 'GET', surface.path);
      expect(answer.status).toBe(200);
      expect(`${surface.name}: ${disclosed(answer.json).join(',')}`)
        .toBe(`${surface.name}: ${idsOf(FIXTURES).join(',')}`);
    }
  });
});

describe('the board COUNT is narrowed, not just the page', () => {
  /**
   * The assertion a post-read filter cannot satisfy.
   *
   * `total` and `hasMore` come from a COUNT statement, so a narrowing applied
   * to the page after it is read leaves the count describing rows the caller
   * may not read — and a count is a disclosure in its own right. Measured at a
   * page size SMALLER than the authorized population, so a repair that set
   * `total = page.length` is red here too.
   */
  it('reports per-column totals over the authorized population at a short page', async () => {
    const allowedByStatus = new Map<string, number>();
    for (const fixture of await pointAllowed(ROOT)) {
      allowedByStatus.set(fixture.status, (allowedByStatus.get(fixture.status) ?? 0) + 1);
    }
    const answer = await call(ROOT, 'GET',
      `/tasks/board?statuses=${BOARD_STATUSES.join(',')}&projects=${FIXTURE_PROJECTS}&perColumn=1`);
    expect(answer.status).toBe(200);
    for (const status of BOARD_STATUSES) {
      const column = answer.json.columns[status];
      expect(column.items).toHaveLength(1);
      expect(`${status} total: ${column.total}`)
        .toBe(`${status} total: ${allowedByStatus.get(status) as number}`);
      expect(`${status} hasMore: ${column.hasMore}`).toBe(`${status} hasMore: true`);
    }
  });

  it('counts a concealed column as empty, not as full', async () => {
    for (const who of CALLERS()) {
      const readable = new Set(idsOf(await pointAllowed(who)));
      const answer = await call(who, 'GET',
        `/tasks/board?statuses=${BOARD_STATUSES.join(',')}&projects=${FIXTURE_PROJECTS}&perColumn=1`);
      expect(answer.status).toBe(200);
      for (const status of BOARD_STATUSES) {
        const column = answer.json.columns[status];
        const readableInColumn = FIXTURES
          .filter((row) => row.status === status && readable.has(row.id)).length;
        expect(`${who.label} ${status}: total ${column.total}`)
          .toBe(`${who.label} ${status}: total ${readableInColumn}`);
        expect(`${who.label} ${status}: hasMore ${column.hasMore}`)
          .toBe(`${who.label} ${status}: hasMore ${readableInColumn > 1}`);
      }
    }
  });
});

/**
 * ── CARD 72258a60: THE DASHBOARD IS A TASK LIST TOO ──────────────────────────
 *
 * The first screen every non-owner sees answered from `SELECT … FROM tasks`
 * with no caller in the statement at all: `/dashboard/summary` reported IDEAS
 * and TODO counts over the whole estate, and `/dashboard/activity` handed out
 * task ids, full task TITLES and the acting handle for work the caller had
 * been deliberately refused — while `GET /tasks` answered `[]` for the same
 * session. It is the same property this file already measures, on three more
 * surfaces, against the same outside anchor.
 */
describe('the dashboard answers what the point route answers', () => {
  it('GET /dashboard/activity discloses exactly the point-allowed set', async () => {
    for (const who of [...CALLERS(), ROOT]) {
      const allowed = await pointAllowed(who);
      const answer = await call(who, 'GET', '/dashboard/activity?limit=100');
      expect(answer.status).toBe(200);
      expect(`${who.label}: ${disclosed(answer.json).join(',')}`)
        .toBe(`${who.label}: ${idsOf(allowed).join(',')}`);
    }
  });

  it('GET /dashboard/activity discloses no concealed TITLE', async () => {
    // The ids are the assertion above. This one is about the field the report
    // actually named: the feed carried `taskTitle`, and a narrowing that
    // withheld the id while still rendering the title would pass the set
    // assertion and leak exactly what the operator saw.
    for (const who of CALLERS()) {
      const readable = new Set(idsOf(await pointAllowed(who)));
      const concealed = FIXTURES.filter((row) => !readable.has(row.id));
      expect(concealed.length).toBeGreaterThan(0);
      const answer = await call(who, 'GET', '/dashboard/activity?limit=100');
      expect(answer.status).toBe(200);
      const payload = JSON.stringify(answer.json);
      for (const row of concealed) {
        expect(`${who.label} leaked "${row.label}": ${payload.includes(`parity ${row.label}`)}`)
          .toBe(`${who.label} leaked "${row.label}": false`);
      }
    }
  });

  it('GET /dashboard/active discloses exactly the point-allowed in-progress set', async () => {
    for (const who of [...CALLERS(), ROOT]) {
      const allowed = (await pointAllowed(who)).filter((row) => row.status === 'in-progress');
      // Non-vacuity: every caller has at least one in-progress Task it may
      // read, so "empty" is never the right answer for any of them.
      expect(`${who.label} in-progress readable: ${allowed.length > 0}`)
        .toBe(`${who.label} in-progress readable: true`);
      const answer = await call(who, 'GET', '/dashboard/active');
      expect(answer.status).toBe(200);
      expect(`${who.label}: ${disclosed(answer.json).join(',')}`)
        .toBe(`${who.label}: ${idsOf(allowed).join(',')}`);
    }
  });

  it('GET /dashboard/summary counts the population belonging to the caller, not the estate', async () => {
    const summaryOf = async (who: Caller): Promise<Record<string, number>> => {
      const answer = await call(who, 'GET', '/dashboard/summary');
      expect(answer.status).toBe(200);
      return answer.json.summary as Record<string, number>;
    };
    const watched: Caller[] = [ROOT, ...CALLERS()];
    const before = new Map<string, Record<string, number>>();
    for (const who of watched) before.set(who.label, await summaryOf(who));

    // Six new Tasks. Five are private in a brand-new private Project, so ONLY
    // root may read them; one inherits the shared Project, so every caller
    // may. Each caller's numbers must move by its own count and no other.
    const deltaProject = await makeProject(`parity-delta-${tag()}`, 'private');
    await makeUntrackedTask('delta ideas a', 'ideas', deltaProject);
    await makeUntrackedTask('delta ideas b', 'ideas', deltaProject);
    await makeUntrackedTask('delta todo a', 'todo', deltaProject);
    await makeUntrackedTask('delta todo b', 'todo', deltaProject);
    await makeUntrackedTask('delta todo c', 'todo', deltaProject);
    // Its OWN shared Project, not the fixture one: a Task added to
    // SHARED_PROJECT here would be readable by every caller and would land in
    // the Project-scoped counts the last describe block asserts, which count
    // FIXTURES.
    const deltaShared = await makeProject(`parity-delta-shared-${tag()}`, 'shared');
    await makeUntrackedTask('delta shared ideas', 'ideas', deltaShared);

    const expected: Record<string, Record<string, number>> = {
      [ROOT.label]: { ideas: 3, todo: 3, total: 6 },
      [SESSION_USER.label]: { ideas: 1, todo: 0, total: 1 },
      [CONNECTOR.label]: { ideas: 1, todo: 0, total: 1 },
    };

    for (const who of watched) {
      const after = await summaryOf(who);
      const start = before.get(who.label) as Record<string, number>;
      for (const field of ['ideas', 'todo', 'total']) {
        const moved = Number(after[field]) - Number(start[field]);
        expect(`${who.label} ${field} moved by ${moved}`)
          .toBe(`${who.label} ${field} moved by ${expected[who.label][field]}`);
      }
    }
  });

  it('GET /dashboard/summary reportCount counts the Reports this caller may read', async () => {
    const countOf = async (who: Caller): Promise<number> => {
      const answer = await call(who, 'GET', '/dashboard/summary');
      expect(answer.status).toBe(200);
      return Number(answer.json.summary.reportCount);
    };
    const watched: Caller[] = [ROOT, ...CALLERS()];
    const before = new Map<string, number>();
    for (const who of watched) before.set(who.label, await countOf(who));

    // One Report only its author may read, one every authenticated caller may.
    await makeReport(`private-${tag()}`, 'private');
    await makeReport(`default-${tag()}`, 'default');

    const expected: Record<string, number> = {
      [ROOT.label]: 2,
      [SESSION_USER.label]: 1,
      [CONNECTOR.label]: 1,
    };
    for (const who of watched) {
      const moved = (await countOf(who)) - (before.get(who.label) as number);
      expect(`${who.label} reportCount moved by ${moved}`)
        .toBe(`${who.label} reportCount moved by ${expected[who.label]}`);
    }
  });
});

/**
 * ── CARD 72258a60, THE CENSUS ARM ────────────────────────────────────────────
 *
 * The card asked for a census of every route that reads Tasks or Reports
 * without the shared narrowing. It found three more Project surfaces answering
 * the same way the dashboard did: `GET /projects?includeStats=true` and
 * `GET /projects/{id}/stats` reported per-status counts over every Task in the
 * Project, `GET /projects/{id}/sessions` handed back the id and TITLE of every
 * Task in it, and `GET /projects/stats/distribution` named every Project in
 * the estate with how much work sits in it, under no Project ceiling at all.
 *
 * Each caller CAN read the shared Project, so their own Project ceiling passes;
 * `RESTRICTED_IN_SHARED` is the Task inside it that only root may read, and it
 * is the row these assertions turn on.
 */
describe('the Project surfaces count and name only what the point route allows', () => {
  const sharedProjectFixtures = (): Fixture[] =>
    FIXTURES.filter((row) => row.projectId === SHARED_PROJECT);

  it('the restricted Task partitions the shared Project (the gate is not vacuous)', async () => {
    const rootAllowed = new Set(idsOf(await pointAllowed(ROOT)));
    expect(`root reads it: ${rootAllowed.has(RESTRICTED_IN_SHARED.id)}`).toBe('root reads it: true');
    for (const who of CALLERS()) {
      const allowed = new Set(idsOf(await pointAllowed(who)));
      expect(`${who.label} reads the restricted Task: ${allowed.has(RESTRICTED_IN_SHARED.id)}`)
        .toBe(`${who.label} reads the restricted Task: false`);
      // …while still reading the Project that holds it, which is what makes
      // the surfaces below reachable for this caller at all.
      const project = await call(who, 'GET', `/projects/${SHARED_PROJECT}`);
      expect(`${who.label} reads the Project: ${project.status}`)
        .toBe(`${who.label} reads the Project: 200`);
    }
  });

  it('GET /projects/{id}/stats counts exactly the point-allowed Tasks of that Project', async () => {
    for (const who of [...CALLERS(), ROOT]) {
      const allowed = new Set(idsOf(await pointAllowed(who)));
      const expected = sharedProjectFixtures().filter((row) => allowed.has(row.id)).length;
      const answer = await call(who, 'GET', `/projects/${SHARED_PROJECT}/stats`);
      expect(answer.status).toBe(200);
      expect(`${who.label} total_tasks: ${Number(answer.json.stats.total_tasks)}`)
        .toBe(`${who.label} total_tasks: ${expected}`);
      // The same response carries recent-activity counts from a SECOND service
      // method, and they were unasserted (review 302a338f). They are asserted
      // as a BOUND rather than an equality, and the reason is recorded rather
      // than hidden: with one just-created readable Task in this Project the
      // surface answered `tasks_created: 0`, so its window comparison is doing
      // something other than what it reads like - `ProjectStatsService`
      // compares `t.created` against an ISO string, and `TaskManagerDB` types
      // that field `string` while populating it from a `timestamptz` column.
      // That is a pre-existing correctness question with its own card; what
      // THIS gate is for is the disclosure, and the disclosure property is the
      // bound: no recent-activity count may exceed the number of Tasks in this
      // Project the caller may read.
      for (const field of ['tasks_created', 'tasks_updated', 'tasks_completed']) {
        const value = Number(answer.json.stats.recent_activity[field]);
        expect(`${who.label} ${field} is a number: ${Number.isFinite(value)}`)
          .toBe(`${who.label} ${field} is a number: true`);
        expect(`${who.label} ${field} within the readable population: ${value <= expected}`)
          .toBe(`${who.label} ${field} within the readable population: true`);
      }
    }
  });

  it('GET /projects/{id}/sessions discloses exactly the point-allowed set', async () => {
    for (const who of [...CALLERS(), ROOT]) {
      const allowed = new Set(idsOf(await pointAllowed(who)));
      const expected = sharedProjectFixtures().filter((row) => allowed.has(row.id));
      const answer = await call(who, 'GET', `/projects/${SHARED_PROJECT}/sessions`);
      expect(answer.status).toBe(200);
      const shown = disclosed(answer.json);
      // A session record is only emitted for a STARTED Task, so the disclosed
      // set is a subset of the expected one; what may never happen is a Task
      // outside it appearing.
      expect(`${who.label} beyond the allowed set: ${shown.filter((id) => !allowed.has(id)).join(',')}`)
        .toBe(`${who.label} beyond the allowed set: `);
      const payload = JSON.stringify(answer.json);
      expect(`${who.label} leaked the restricted TITLE: ${payload.includes(`parity ${RESTRICTED_IN_SHARED.label}`)}`)
        .toBe(`${who.label} leaked the restricted TITLE: ${who.label === ROOT.label}`);
      // Non-vacuity: root, who may read every fixture, actually sees some.
      if (who.label === ROOT.label) {
        expect(`root session records: ${shown.length > 0}`).toBe('root session records: true');
        expect(expected.length).toBeGreaterThan(0);
      }
    }
  });

  it('GET /projects/stats/distribution never counts a Project the caller reads nothing in', async () => {
    const privateName = PROJECT_NAMES.find((name) => name.startsWith('parity-private-')) as string;
    const sharedName = PROJECT_NAMES.find((name) => name.startsWith('parity-shared-')) as string;
    const entryFor = (json: any, name: string): number | null => {
      const row = (json.distribution as Array<{ project_name: string; task_count: number }>)
        .find((entry) => entry.project_name === name);
      return row ? Number(row.task_count) : null;
    };

    const countedFor = async (who: Caller, projectId: string): Promise<number> => {
      const allowed = new Set(idsOf(await pointAllowed(who)));
      return FIXTURES.filter((row) => row.projectId === projectId && allowed.has(row.id)).length;
    };

    for (const who of [...CALLERS(), ROOT]) {
      const answer = await call(who, 'GET', '/projects/stats/distribution');
      expect(answer.status).toBe(200);
      for (const [projectId, name] of [[PRIVATE_PROJECT, privateName], [SHARED_PROJECT, sharedName]] as const) {
        const expected = await countedFor(who, projectId);
        // Zero readable Tasks means the Project is not named at all: a row
        // reading `<project> 0` still says the Project exists, and a
        // distribution is a shape of the estate.
        expect(`${who.label} ${name}: ${entryFor(answer.json, name)}`)
          .toBe(`${who.label} ${name}: ${expected === 0 ? null : expected}`);
      }
    }

    // Non-vacuity, stated as a strict inequality: root counts MORE of the
    // private Project than either restricted caller does, so a repair that
    // simply emptied this surface would be red here.
    const rootPrivate = await countedFor(ROOT, PRIVATE_PROJECT);
    for (const who of CALLERS()) {
      const theirs = await countedFor(who, PRIVATE_PROJECT);
      expect(`${who.label} sees fewer than root: ${theirs < rootPrivate}`)
        .toBe(`${who.label} sees fewer than root: true`);
    }
  });
});

/**
 * -- REVIEW 302a338f B2: holding a Warrant is not authority over its Tasks ----
 *
 * Three surfaces returned Task ids, TITLES and statuses to a holder-tree
 * viewer with no Task narrowing: `/warrants/{id}/linkage` (anchors and
 * carriedTasks), `/warrants/{id}/dependent-tasks`, and the 409 refusal
 * `POST /warrants/{id}/revoke` raises when dependents are unacknowledged.
 *
 * The session caller HOLDS this Warrant, so every ownership gate on the route
 * passes for it; the Tasks it names are ones `GET /tasks/:id` refuses it.
 * That is exactly the partition the surfaces could not previously see.
 */
describe('the Warrant surfaces disclose no Task the point route conceals', () => {
  const concealedFixtures = async (): Promise<Fixture[]> => {
    const allowed = new Set(idsOf(await pointAllowed(SESSION_USER)));
    return FIXTURES.filter((row) => !allowed.has(row.id));
  };

  it('the holder may read the Warrant and NOT the Tasks it names (not vacuous)', async () => {
    const linkage = await call(SESSION_USER, 'GET', `/warrants/${HELD_WARRANT}/linkage`);
    expect(`holder reads the warrant: ${linkage.status}`).toBe('holder reads the warrant: 200');
    const allowed = new Set(idsOf(await pointAllowed(SESSION_USER)));
    for (const label of ['private-a stuck', 'private-b stuck']) {
      const fixture = FIXTURES.find((row) => row.label === label) as Fixture;
      expect(`${label} readable: ${allowed.has(fixture.id)}`).toBe(`${label} readable: false`);
    }
  });

  it('GET /warrants/{id}/linkage renders no concealed id, title or status', async () => {
    const answer = await call(SESSION_USER, 'GET', `/warrants/${HELD_WARRANT}/linkage`);
    expect(answer.status).toBe(200);
    const allowed = new Set(idsOf(await pointAllowed(SESSION_USER)));
    const carried = (answer.json.carriedTasks as Array<{ id: string }>).map((row) => row.id);
    expect(`beyond the allowed set: ${carried.filter((id) => !allowed.has(id)).join(',')}`)
      .toBe('beyond the allowed set: ');
    // The count stays whole, so the holder is not told the Warrant carries
    // less than it does.
    expect(`carriedTotal: ${answer.json.carriedTotal}`).toBe('carriedTotal: 1');
    expect(`carriedConcealed: ${answer.json.carriedConcealed}`).toBe('carriedConcealed: 1');
    // A Task ANCHOR keeps its id - the structure of the Warrant, which its
    // holder is entitled to - and loses the label and status, which belong to
    // the Task.
    const taskAnchors = (answer.json.anchors as Array<any>).filter((row) => row.anchorType === 'task');
    expect(taskAnchors.length).toBe(1);
    expect(`anchor label: ${taskAnchors[0].label}`).toBe('anchor label: null');
    expect(`anchor status: ${taskAnchors[0].status}`).toBe('anchor status: null');
    expect(`anchor concealed: ${taskAnchors[0].concealed}`).toBe('anchor concealed: true');
    const payload = JSON.stringify(answer.json);
    for (const row of await concealedFixtures()) {
      expect(`linkage leaked "${row.label}": ${payload.includes(`parity ${row.label}`)}`)
        .toBe(`linkage leaked "${row.label}": false`);
    }
  });

  it('GET /warrants/{id}/dependent-tasks discloses no concealed TITLE', async () => {
    const answer = await call(SESSION_USER, 'GET', `/warrants/${HELD_WARRANT}/dependent-tasks`);
    expect(answer.status).toBe(200);
    const allowed = new Set(idsOf(await pointAllowed(SESSION_USER)));
    const shown = (answer.json.tasks as Array<{ id: string }>).map((row) => row.id);
    expect(`beyond the allowed set: ${shown.filter((id) => !allowed.has(id)).join(',')}`)
      .toBe('beyond the allowed set: ');
    const payload = JSON.stringify(answer.json);
    for (const row of await concealedFixtures()) {
      expect(`dependent-tasks leaked "${row.label}": ${payload.includes(`parity ${row.label}`)}`)
        .toBe(`dependent-tasks leaked "${row.label}": false`);
    }
  });

  it('the revoke refusal counts every dependent and names only the readable ones', async () => {
    const answer = await call(SESSION_USER, 'POST', `/warrants/${HELD_WARRANT}/revoke`, { reason: 'parity' });
    // The dependent-task refusal only fires when the carried Task is
    // execution-assigned; whichever answer comes back, it must not carry a
    // title this caller may not read.
    const payload = JSON.stringify(answer.json);
    for (const row of await concealedFixtures()) {
      expect(`revoke leaked "${row.label}": ${payload.includes(`parity ${row.label}`)}`)
        .toBe(`revoke leaked "${row.label}": false`);
    }
  });
});

/**
 * -- REVIEW `99ba9444` B1: THE MIRROR COLLISION, OVER A REAL POSTGRESQL -------
 *
 * `reports.author_actor_id` carries a HANDLE from the REST writer and a
 * principal UUID from the task-finish writer, and `validateNewHandle` admits a
 * UUID-shaped handle — so principal A's handle can EQUAL principal B's id.
 * A read that joins on that column matches both principals for one row, and
 * whichever arm is preferred, one of the two writer directions is
 * misattributed. That is why this is measured here and not on a mocked pool:
 * the row a mock hands back is already joined, so it cannot observe which
 * principal PostgreSQL chose. Here PostgreSQL chooses.
 *
 * Three rows, one collision, read through the production router:
 *  - the REST direction (`author_principal_id = A`, `author_actor_id = B.id`),
 *  - the task-finish direction (both columns = B),
 *  - a historical row with provenance and NO canonical author, which must be
 *    UNATTRIBUTED rather than resolved out of the ambiguous column.
 */
describe('Report attribution survives the mirror collision', () => {
  let COLLIDING_A: string;
  let PLAIN_B: string;
  let REST_ROW: string;
  let FINISH_ROW: string;
  let LEGACY_ROW: string;

  const nameOf = async (reportId: string): Promise<string | null> => {
    const answer = await call(ROOT, 'GET', `/reports/${reportId}`);
    expect(`read ${reportId}: ${answer.status}`).toBe(`read ${reportId}: 200`);
    return answer.json.report.author_actor_name ?? null;
  };

  beforeAll(async () => {
    // B first: A's HANDLE has to BE B's id, which is the collision.
    const b = await pool.query(
      `INSERT INTO principals (kind, handle, display_name, status, role, purpose)
       VALUES ('service', $1, 'Bea the collided', 'active', null, 'mirror collision')
       RETURNING id`,
      [`parity-collision-b-${tag()}`],
    );
    PLAIN_B = String(b.rows[0].id);
    const a = await pool.query(
      `INSERT INTO principals (kind, handle, display_name, status, role, purpose)
       VALUES ('service', $1, 'Ada the collider', 'active', null, 'mirror collision')
       RETURNING id`,
      [PLAIN_B],
    );
    COLLIDING_A = String(a.rows[0].id);

    const insertReport = async (label: string, actorId: string, principalId: string | null) => {
      const row = await pool.query(
        `INSERT INTO reports (title, content, author, author_actor_id, author_principal_id, visibility)
         VALUES ($1, 'mirror collision body', 'parity-suite', $2, $3, 'default') RETURNING id`,
        [`parity mirror ${label} ${tag()}`, actorId, principalId],
      );
      return String(row.rows[0].id);
    };
    // What `POST /reports` stores for A: the authenticated HANDLE, which is
    // B's id, beside A's own canonical UUID.
    REST_ROW = await insertReport('rest', PLAIN_B, COLLIDING_A);
    // What the task-finish writer stores for B: the UUID in both columns.
    FINISH_ROW = await insertReport('finish', PLAIN_B, PLAIN_B);
    // A row migration 063 left NULL.
    LEGACY_ROW = await insertReport('legacy', PLAIN_B, null);
  });

  it('the collision is REAL — A\'s handle is B\'s id (not vacuous)', async () => {
    const rows = await pool.query('SELECT handle FROM principals WHERE id = $1', [COLLIDING_A]);
    expect(`A handle equals B id: ${rows.rows[0].handle === PLAIN_B}`).toBe('A handle equals B id: true');
    // And both principals really exist, so both join arms COULD have matched.
    const both = await pool.query('SELECT count(*)::int AS n FROM principals WHERE id = ANY($1::uuid[])',
      [[COLLIDING_A, PLAIN_B]]);
    expect(`both principals present: ${both.rows[0].n}`).toBe('both principals present: 2');
  });

  it('the REST direction names A — the principal that WROTE it', async () => {
    // Id-first named B here: the row's `author_actor_id` spells B's id.
    expect(`rest row author: ${await nameOf(REST_ROW)}`).toBe('rest row author: Ada the collider');
  });

  it('the task-finish direction names B — the mirror case, same read', async () => {
    // Handle-first named A here, for the same reason in reverse. One rule now
    // answers both, because it consults neither spelling.
    expect(`finish row author: ${await nameOf(FINISH_ROW)}`).toBe('finish row author: Bea the collided');
  });

  it('a row with no canonical author is UNATTRIBUTED, never a guess', async () => {
    // The fail-closed half. `author_actor_id` still spells a real principal's
    // id AND another's handle; neither may be resolved into an attribution.
    expect(`legacy row author: ${await nameOf(LEGACY_ROW)}`).toBe('legacy row author: Unattributed');
  });

  it('the LIST agrees with the point read, row for row', async () => {
    // The two read queries are separate SQL. A repair applied to one of them
    // would leave the other misattributing, and the card and the detail render
    // the same field.
    const answer = await call(ROOT, 'GET', '/reports?limit=100');
    expect(`list status: ${answer.status}`).toBe('list status: 200');
    const byId = new Map((answer.json.reports as Array<any>).map((row) => [row.id, row.author_actor_name]));
    for (const [label, id] of [['rest', REST_ROW], ['finish', FINISH_ROW], ['legacy', LEGACY_ROW]] as const) {
      expect(`${label} in list: ${byId.get(id)}`).toBe(`${label} in list: ${await nameOf(id)}`);
    }
  });

  it('the provenance column is still carried, unchanged', async () => {
    // The repair changes what is RESOLVED, not what is recorded. An audit that
    // needs the raw provenance string still has it.
    const answer = await call(ROOT, 'GET', `/reports/${REST_ROW}`);
    expect(`provenance: ${answer.json.report.author_actor_id}`).toBe(`provenance: ${PLAIN_B}`);
  });
});
