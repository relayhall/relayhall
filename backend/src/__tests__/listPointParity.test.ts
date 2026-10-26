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
async function connectorCaller(label: string, accountId: string, scopes: string[] = SCOPES): Promise<Caller> {
  const handle = `parity-connector-${tag()}`;
  const principal = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, $2, 'active', $3, $4, $5::jsonb) RETURNING id`,
    [handle, `list parity ${label}`, accountId, 'list parity connector',
      JSON.stringify({ scopes: 'parent', objects: 'parent' })],
  );
  const principalId = String(principal.rows[0].id);
  const issued = await principalService.issueCredential(
    { principalId, scopes, transport: 'any' }, SYSTEM_ACTOR);
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
  /** Give this Task a lawful canonical implementation link, so session
   * disclosure assertions remain positive and non-vacuous after retirement. */
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
  if (input.started) {
    const attemptId=crypto.randomUUID();
    await pool.query(`INSERT INTO session_attempts(attempt_id,harness,runtime_kind,first_observed_at,started_at,identity_confidence,identity_reason,created_by_adapter)
      VALUES($1,'hermes','parity-fixture',NOW(),NOW(),'authoritative','fixture','parity-fixture')`,[attemptId]);
    await pool.query(`INSERT INTO task_attempt_links(task_id,attempt_id,role,attempt_number,link_state,source,evidence_ref)
      VALUES($1,$2,'implementation',1,'bound','operator','parity-fixture')`,[fixture.id,attemptId]);
  }
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
   * The MCP arm of the graph surface: `relayhall_task_graph`'s real handler,
   * through the real in-process ingress, against this real database, under
   * the CONNECTOR's own bearer credential. Only the bearer caller can be
   * driven: the MCP ingress refuses login-session cookies by design, so the
   * session caller has no MCP arm to measure.
   *
   * Two equalities, both anchored outside the tool: the tool's disclosure
   * equals the point-allowed set, AND equals what `GET /tasks/graph` disclosed
   * to the same caller over REST — so a tool that quietly composed a wider or
   * narrower read than the route would be red here even if its own set
   * happened to look plausible.
   */
  it('relayhall_task_graph (MCP) discloses exactly what GET /tasks/graph and the point route disclose', async () => {
    const { toolByName } = require('../mcp/registry');
    const tool = toolByName('relayhall_task_graph');
    expect(tool).toBeDefined();
    const ctx = { authorization: CONNECTOR.headers.Authorization, toolName: 'relayhall_task_graph' };
    const args = { statuses: BOARD_STATUSES, projects: FIXTURE_PROJECTS.split(','), response_format: 'detailed' };
    const text: string = await tool.handler(args, ctx);
    const mcp = JSON.parse(text);
    const expected = idsOf(await pointAllowed(CONNECTOR));
    expect(`mcp connector: ${disclosed(mcp).join(',')}`).toBe(`mcp connector: ${expected.join(',')}`);
    const surface = surfaces().find((entry) => entry.name === 'GET /tasks/graph') as { name: string; path: string };
    const rest = await call(CONNECTOR, 'GET', surface.path);
    expect(rest.status).toBe(200);
    expect(`rest connector: ${disclosed(rest.json).join(',')}`).toBe(`rest connector: ${disclosed(mcp).join(',')}`);
    // The etag is the same validator the route emits, and it revalidates.
    expect(typeof mcp.etag).toBe('string');
    const revalidated: string = await tool.handler({ ...args, ifNoneMatch: mcp.etag }, ctx);
    expect(revalidated).toContain('not modified');
    // Non-vacuity: the connector reads SOMETHING through the tool, and not
    // everything.
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(FIXTURES.length);
    // The concealed TITLES are absent from the tool's text, not only the ids.
    const readable = new Set(expected);
    for (const row of FIXTURES.filter((fixture) => !readable.has(fixture.id))) {
      expect(`mcp leaked "${row.label}": ${text.includes(`parity ${row.label}`)}`)
        .toBe(`mcp leaked "${row.label}": false`);
    }
  });

  it('relayhall_task_graph (MCP) refuses unknown arguments before reaching the board', async () => {
    const { toolByName } = require('../mcp/registry');
    const ctx = { authorization: CONNECTOR.headers.Authorization, toolName: 'relayhall_task_graph' };
    await expect(toolByName('relayhall_task_graph').handler({ limit: 10 }, ctx)).rejects.toThrow(/Unknown arguments: limit/);
  });

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
      // A session record is only emitted for a canonically linked Task, so the disclosed
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

/**
 * -- THE MAP READ OVER MCP: A READABLE TASK GRANTS NOTHING ELSE --------------
 *
 * `GET /tasks/graph` narrows three collections on their own: Task rows,
 * the Phases those rows reference, and the Reports linked to them. The mocked
 * suite (`scaleReadContracts`) proves the tool inherits that narrowing through
 * the in-process ingress; this block proves it against PostgreSQL, where the
 * predicate is SQL and the mocked repository cannot stand in for it.
 *
 * The partition: one Task the CONNECTOR may read, placed in a Phase marked
 * `restricted_access`, and cited by two Reports — one `default` (readable by
 * every authenticated caller), one `private` (readable by its author, root,
 * alone). Root over REST is the positive control: it sees the Phase and both
 * Reports, so an empty answer would be red rather than green.
 *
 * The Task is readable through the EXACT-GRANT arm (`grantToChain`, the same
 * pattern the count fixtures use), not through the shared Project. Measured
 * against PostgreSQL, a Task inside a restricted Phase does NOT inherit the
 * Project's visibility for this caller — `GET /tasks/{id}` answered 404 for a
 * Project-inherited fixture — so the inherited arm cannot carry this
 * partition. A grant names the Task alone: it says nothing about the Phase
 * the Task sits in, nor about the Reports that cite it, which is exactly
 * what the negatives below need — the Task is admitted by one explicit cause
 * and the Phase and private Report still have none.
 *
 * Fixtures are built in THIS block's own `beforeAll`, after every count
 * assertion above has run, because the new Task is deliberately outside
 * `FIXTURES` and would otherwise move the Project-scoped equalities.
 */
describe('relayhall_task_graph (MCP) conceals restricted Phases and private Reports on readable Tasks', () => {
  let PHASED_TASK: string;
  let RESTRICTED_PHASE: string;
  let OPEN_REPORT: string;
  let PRIVATE_REPORT: string;
  const PHASE_NAME = `parity sealed phase ${tag()}`;
  const PHASE_GOAL = 'parity confidential goal';
  const OPEN_TITLE = `parity open linked report ${tag()}`;
  const PRIVATE_TITLE = `parity private linked report ${tag()}`;

  /** A Report created through the production writer, so the Task link is the
   * one the route's linked-report read follows, then re-addressed to the
   * visibility the shared predicate reads (`sqlResource('report')`). */
  const linkedReport = async (title: string, visibility: 'private' | 'default'): Promise<string> => {
    const created = await call(ROOT, 'POST', '/reports', {
      title, content: `body of ${title}`, task_ids: [PHASED_TASK],
    });
    expect(`create ${title}: ${created.status}`).toMatch(/^create .*: 20[01]$/);
    const id = String(created.json.report?.id ?? created.json.id);
    await pool.query('UPDATE reports SET visibility = $1, author_principal_id = $2 WHERE id = $3',
      [visibility, ROOT_PRINCIPAL, id]);
    return id;
  };

  beforeAll(async () => {
    // Phases carry their own restricted-access policy (owner ruling 44ee41f2),
    // the same column Tasks use.
    const phase = await pool.query(
      `INSERT INTO phases (project_id, name, goal, position, restricted_access)
       VALUES ($1, $2, $3, 0, true) RETURNING id`,
      [SHARED_PROJECT, PHASE_NAME, PHASE_GOAL],
    );
    RESTRICTED_PHASE = String(phase.rows[0].id);
    PHASED_TASK = await makeUntrackedTask('phased and cited', 'todo', SHARED_PROJECT);
    await pool.query('UPDATE tasks SET phase_id = $1 WHERE id = $2', [RESTRICTED_PHASE, PHASED_TASK]);
    // The Task inside the restricted Phase is made readable to the connector
    // by an explicit read grant on the Task — the fixture's ONE named cause.
    // The grant is on the Task row only; the Phase and the Reports carry none.
    await grantToChain(PHASED_TASK);
    OPEN_REPORT = await linkedReport(OPEN_TITLE, 'default');
    PRIVATE_REPORT = await linkedReport(PRIVATE_TITLE, 'private');
  });

  const graphArgs = () => ({
    statuses: ['todo'], projects: [PROJECT_NAMES.find((name) => name.startsWith('parity-shared-')) as string],
    response_format: 'detailed',
  });

  it('the partition is real: root sees the Phase and both Reports over REST (not vacuous)', async () => {
    const answer = await call(ROOT, 'GET',
      `/tasks/graph?statuses=todo&projects=${encodeURIComponent(graphArgs().projects[0])}`);
    expect(answer.status).toBe(200);
    expect(answer.json.nodes.map((n: any) => n.id)).toContain(PHASED_TASK);
    expect(answer.json.phases.map((p: any) => p.id)).toContain(RESTRICTED_PHASE);
    expect(answer.json.reports.map((r: any) => r.id).sort()).toEqual([OPEN_REPORT, PRIVATE_REPORT].sort());
    // …and the connector may read the Task (by its grant) but NOT the Phase.
    expect(`connector reads the granted task: ${(await call(CONNECTOR, 'GET', `/tasks/${PHASED_TASK}`)).status}`)
      .toBe('connector reads the granted task: 200');
    expect([403, 404]).toContain((await call(CONNECTOR, 'GET', `/phases/${RESTRICTED_PHASE}`)).status);
    expect([403, 404]).toContain((await call(CONNECTOR, 'GET', `/reports/${PRIVATE_REPORT}`)).status);
    expect((await call(CONNECTOR, 'GET', `/reports/${OPEN_REPORT}`)).status).toBe(200);
  });

  it('the connector reads the Task through the tool, with the open Report and WITHOUT the Phase or the private Report', async () => {
    const { toolByName } = require('../mcp/registry');
    const ctx = { authorization: CONNECTOR.headers.Authorization, toolName: 'relayhall_task_graph' };
    const text: string = await toolByName('relayhall_task_graph').handler(graphArgs(), ctx);
    const mcp = JSON.parse(text);
    const node = mcp.nodes.find((n: any) => n.id === PHASED_TASK);
    expect(`node present: ${Boolean(node)}`).toBe('node present: true');
    // Allowed projection: the node keeps its phaseId (structure), the open
    // Report arrives with its title.
    expect(`phaseId: ${node.phaseId}`).toBe(`phaseId: ${RESTRICTED_PHASE}`);
    expect(mcp.reports.map((r: any) => r.id)).toContain(OPEN_REPORT);
    expect(text).toContain(OPEN_TITLE);
    // Hidden projection: no Phase identity, no private Report — by id or by text.
    expect(`restricted phase listed: ${mcp.phases.some((p: any) => p.id === RESTRICTED_PHASE)}`)
      .toBe('restricted phase listed: false');
    expect(`phase name leaked: ${text.includes(PHASE_NAME)}`).toBe('phase name leaked: false');
    expect(`phase goal leaked: ${text.includes(PHASE_GOAL)}`).toBe('phase goal leaked: false');
    expect(`private report listed: ${mcp.reports.some((r: any) => r.id === PRIVATE_REPORT)}`)
      .toBe('private report listed: false');
    expect(`private title leaked: ${text.includes(PRIVATE_TITLE)}`).toBe('private title leaked: false');
    // The same answer the route gives the same caller over REST.
    const rest = await call(CONNECTOR, 'GET',
      `/tasks/graph?statuses=todo&projects=${encodeURIComponent(graphArgs().projects[0])}`);
    expect(rest.status).toBe(200);
    expect(rest.json.phases.map((p: any) => p.id).sort()).toEqual(mcp.phases.map((p: any) => p.id).sort());
    expect(rest.json.reports.map((r: any) => r.id).sort()).toEqual(mcp.reports.map((r: any) => r.id).sort());
    // The concise form prints counts only, so it cannot leak either.
    const concise: string = await toolByName('relayhall_task_graph').handler({ ...graphArgs(), response_format: 'concise' }, ctx);
    for (const secret of [PHASE_NAME, PHASE_GOAL, PRIVATE_TITLE, OPEN_TITLE]) {
      expect(`concise carries "${secret}": ${concise.includes(secret)}`).toBe(`concise carries "${secret}": false`);
    }
  });
});

/**
 * -- 1e0f3bd4: A PROJECT'S PHASE LIST ANSWERS WHAT THE PHASE POINT ROUTE ANSWERS
 *
 * `GET /projects/{id}/phases` reaches Phase rows through the Project route
 * family, so its route ceiling is `projects:read` and its object stage proves
 * the PROJECT. A Phase marked `restricted_access` suppresses what its Project
 * lends (owner ruling 44ee41f2), so proving the Project proves nothing about
 * such a Phase: the list has to ask the Phase read decision for every row,
 * the decision `GET /phases` and `GET /phases/{id}` already ask.
 *
 * The outside anchor is the point route, as everywhere in this file: the
 * expected set is the fixture Phases for which `GET /phases/{id}` answers 200
 * to the same caller. The caller holds `phases:read`, so a refused point read
 * is the object decision (the concealed 404), never the scope ceiling. Root is
 * the positive control: it lists all three fixture Phases and reads each one.
 *
 * A caller WITHOUT `phases:read` cannot anchor on the point route (its point
 * read stops at the scope ceiling), so for it the restricted rows are asserted
 * absent and the unrestricted one present: the list keeps serving the
 * ordinary Project disclosure the route family grants.
 *
 * Fixtures are built in this block's own `beforeAll` and sit in the SHARED
 * Project, after every count assertion above has run.
 */
describe('GET /projects/{id}/phases lists only the Phases the Phase point route allows', () => {
  let PHASE_READER: Caller;
  let OPEN_PHASE: string;
  let SEALED_PHASE: string;
  let SEALED_ARCHIVED_PHASE: string;
  let PHASE_WARRANT: string;
  /** The positive arms the restriction preserves (card bdf7b876): an exact
   * Phase grant on the sealed Phase, and the owner of a Project of its own. */
  let PHASE_GRANTEE: Caller;
  let PROJECT_OWNER: Caller;
  let OWNED_PROJECT: string;
  const OWNED_LABELS = new Map<string, string>();
  const SEALED_NAME = `parity sealed list phase ${tag()}`;
  const SEALED_GOAL = 'parity sealed list goal';
  const LABELS = new Map<string, string>();

  const makePhase = async (label: string, name: string, restricted: boolean, status: string): Promise<string> => {
    const row = await pool.query(
      `INSERT INTO phases (project_id, name, goal, position, restricted_access, status)
       VALUES ($1, $2, $3, 50, $4, $5) RETURNING id`,
      [SHARED_PROJECT, name, restricted ? SEALED_GOAL : 'parity open list goal', restricted, status],
    );
    const id = String(row.rows[0].id);
    LABELS.set(id, label);
    return id;
  };

  /** The fixture Phases one list answer carries, by label, sorted. */
  const listedLabels = async (who: Caller, includeArchived: boolean): Promise<string[]> => {
    const answer = await call(who, 'GET',
      `/projects/${SHARED_PROJECT}/phases${includeArchived ? '?includeArchived=true' : ''}`);
    expect(`${who.label} list status: ${answer.status}`).toBe(`${who.label} list status: 200`);
    return (answer.json.phases as Array<{ id: string }>)
      .map((phase) => LABELS.get(phase.id)).filter((label): label is string => Boolean(label)).sort();
  };

  /** The fixture Phases the point route reads for this caller, by label. */
  const pointLabels = async (who: Caller, includeArchived: boolean): Promise<string[]> => {
    const allowed: string[] = [];
    for (const [id, label] of LABELS) {
      if (!includeArchived && label === 'sealed-archived') continue;
      const answer = await call(who, 'GET', `/phases/${id}`);
      if (answer.status === 200) allowed.push(label);
      else expect(`${who.label} point ${label}: ${answer.status}`).toBe(`${who.label} point ${label}: 404`);
    }
    return allowed.sort();
  };

  beforeAll(async () => {
    PHASE_READER = await connectorCaller('phase reader', CONNECTOR_ACCOUNT, [...SCOPES, 'phases:read']);
    OPEN_PHASE = await makePhase('open', `parity open list phase ${tag()}`, false, 'todo');
    SEALED_PHASE = await makePhase('sealed', SEALED_NAME, true, 'todo');
    SEALED_ARCHIVED_PHASE = await makePhase('sealed-archived', `${SEALED_NAME} archived`, true, 'archived');
    // A Warrant the session caller HOLDS, anchored to the open and the sealed
    // Phase: holding it reads neither (the review 302a338f B2 independence,
    // for Phase anchors).
    const warrant = await pool.query(
      `INSERT INTO warrants (name, holder_principal_id, created_by_principal_id, ceiling_profile_version_id, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 day') RETURNING id`,
      [`parity phase warrant ${tag()}`, SESSION_USER.principalId, ROOT_PRINCIPAL, await makeCeilingVersion()],
    );
    PHASE_WARRANT = String(warrant.rows[0].id);
    for (const anchor of [OPEN_PHASE, SEALED_PHASE]) {
      await pool.query(
        `INSERT INTO warrant_anchors (warrant_id, anchor_type, anchor_id) VALUES ($1, 'phase', $2)`,
        [PHASE_WARRANT, anchor],
      );
    }
    // Restricted mode suppresses only the inherited Project arm: an exact
    // Phase grant and the Project's owner still read the sealed Phase, so
    // they must still list it. The grantee is a plain Account session; the
    // owner's Project is SHARED, so a caller who neither owns it nor holds a
    // grant reads that Project and is the negative control on the same rows.
    PHASE_GRANTEE = await sessionCallerFor('phase grantee', await makeAccount('human', 'user'));
    await pool.query(
      `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id)
       VALUES ('principal', $1, 'phase', $2, 'read', $3)`,
      [PHASE_GRANTEE.principalId, SEALED_PHASE, ROOT_PRINCIPAL],
    );
    PROJECT_OWNER = await sessionCallerFor('project owner', await makeAccount('human', 'user'));
    const owned = await pool.query(
      `INSERT INTO projects (name, status, visibility, owner_principal_id)
       VALUES ($1, 'active', 'shared', $2) RETURNING id`,
      [`parity owned phase project ${tag()}`, PROJECT_OWNER.principalId],
    );
    OWNED_PROJECT = String(owned.rows[0].id);
    for (const [label, restricted] of [['open', false], ['sealed', true]] as Array<[string, boolean]>) {
      const row = await pool.query(
        `INSERT INTO phases (project_id, name, goal, position, restricted_access, status)
         VALUES ($1, $2, $3, 50, $4, 'todo') RETURNING id`,
        [OWNED_PROJECT, `parity owned ${label} phase ${tag()}`, `parity owned ${label} goal`, restricted],
      );
      OWNED_LABELS.set(String(row.rows[0].id), label);
    }
  });

  it('the partition is real: root lists and reads all three, the phase reader reads only the open one (not vacuous)', async () => {
    expect(await listedLabels(ROOT, true)).toEqual(['open', 'sealed', 'sealed-archived']);
    expect(await pointLabels(ROOT, true)).toEqual(['open', 'sealed', 'sealed-archived']);
    expect(`open point read: ${(await call(PHASE_READER, 'GET', `/phases/${OPEN_PHASE}`)).status}`)
      .toBe('open point read: 200');
    expect(`sealed point read: ${(await call(PHASE_READER, 'GET', `/phases/${SEALED_PHASE}`)).status}`)
      .toBe('sealed point read: 404');
    expect(`sealed archived point read: ${(await call(PHASE_READER, 'GET', `/phases/${SEALED_ARCHIVED_PHASE}`)).status}`)
      .toBe('sealed archived point read: 404');
  });

  it('a Project reader holding phases:read lists exactly the Phases GET /phases/{id} answers', async () => {
    for (const includeArchived of [false, true]) {
      const listed = await listedLabels(PHASE_READER, includeArchived);
      const allowed = await pointLabels(PHASE_READER, includeArchived);
      const beyond = listed.filter((label) => !allowed.includes(label));
      expect(`listed beyond the point-allowed set (includeArchived=${includeArchived}): ${beyond.join(',')}`)
        .toBe(`listed beyond the point-allowed set (includeArchived=${includeArchived}): `);
      expect(listed).toEqual(allowed);
    }
    // The same rows GET /phases lists for this caller, through the one predicate.
    const flat = await call(PHASE_READER, 'GET', `/phases?projectId=${SHARED_PROJECT}&includeArchived=true`);
    expect(flat.status).toBe(200);
    const nested = await call(PHASE_READER, 'GET', `/projects/${SHARED_PROJECT}/phases?includeArchived=true`);
    expect((nested.json.phases as Array<{ id: string }>).map((p) => p.id).sort())
      .toEqual((flat.json.phases as Array<{ id: string }>).map((p) => p.id).sort());
    const text = JSON.stringify(nested.json);
    expect(`sealed name leaked: ${text.includes(SEALED_NAME)}`).toBe('sealed name leaked: false');
    expect(`sealed goal leaked: ${text.includes(SEALED_GOAL)}`).toBe('sealed goal leaked: false');
  });

  it('a Project reader without phases:read still lists the open Phase and never a restricted one', async () => {
    for (const who of CALLERS()) {
      for (const includeArchived of [false, true]) {
        const listed = await listedLabels(who, includeArchived);
        expect(`${who.label} listed (includeArchived=${includeArchived}): ${listed.join(',')}`)
          .toBe(`${who.label} listed (includeArchived=${includeArchived}): open`);
      }
    }
  });

  it('an exact Phase grantee lists the restricted Phase GET /phases/{id} answers it', async () => {
    for (const includeArchived of [false, true]) {
      const listed = await listedLabels(PHASE_GRANTEE, includeArchived);
      const allowed = await pointLabels(PHASE_GRANTEE, includeArchived);
      // Not vacuous: the grant reaches the sealed Phase through the restriction.
      expect(`grantee reads sealed (includeArchived=${includeArchived}): ${allowed.includes('sealed')}`)
        .toBe(`grantee reads sealed (includeArchived=${includeArchived}): true`);
      expect(`grantee listed (includeArchived=${includeArchived}): ${listed.join(',')}`)
        .toBe(`grantee listed (includeArchived=${includeArchived}): ${allowed.join(',')}`);
    }
  });

  it('a Project owner lists the restricted Phase of its own Project, and a plain reader of it does not', async () => {
    const ownedListed = async (who: Caller): Promise<string[]> => {
      const answer = await call(who, 'GET', `/projects/${OWNED_PROJECT}/phases?includeArchived=true`);
      expect(`${who.label} owned list status: ${answer.status}`).toBe(`${who.label} owned list status: 200`);
      return (answer.json.phases as Array<{ id: string }>)
        .map((phase) => OWNED_LABELS.get(phase.id)).filter((label): label is string => Boolean(label)).sort();
    };
    const ownedPoint = async (who: Caller): Promise<string[]> => {
      const allowed: string[] = [];
      for (const [id, label] of OWNED_LABELS) {
        const answer = await call(who, 'GET', `/phases/${id}`);
        if (answer.status === 200) allowed.push(label);
        else expect(`${who.label} point owned ${label}: ${answer.status}`).toBe(`${who.label} point owned ${label}: 404`);
      }
      return allowed.sort();
    };
    expect(`owner reads: ${(await ownedPoint(PROJECT_OWNER)).join(',')}`).toBe('owner reads: open,sealed');
    expect(`owner listed: ${(await ownedListed(PROJECT_OWNER)).join(',')}`)
      .toBe(`owner listed: ${(await ownedPoint(PROJECT_OWNER)).join(',')}`);
    // The negative control on the same rows: a reader of the shared Project
    // who neither owns it nor holds a grant reads and lists only the open one.
    expect(`plain reader reads: ${(await ownedPoint(SESSION_USER)).join(',')}`).toBe('plain reader reads: open');
    expect(`plain reader listed: ${(await ownedListed(SESSION_USER)).join(',')}`)
      .toBe(`plain reader listed: ${(await ownedPoint(SESSION_USER)).join(',')}`);
  });

  it('GET /warrants/{id}/linkage names an open Phase anchor and conceals a restricted one', async () => {
    const answer = await call(SESSION_USER, 'GET', `/warrants/${PHASE_WARRANT}/linkage`);
    expect(`linkage status: ${answer.status}`).toBe('linkage status: 200');
    const byId = new Map((answer.json.anchors as Array<any>).map((row) => [row.anchorId, row]));
    // Structure stays: both anchors keep their type and id.
    expect(`anchors: ${[...byId.keys()].map((id) => LABELS.get(id)).sort().join(',')}`).toBe('anchors: open,sealed');
    expect(`open anchor concealed: ${byId.get(OPEN_PHASE).concealed}`).toBe('open anchor concealed: false');
    expect(`sealed anchor concealed: ${byId.get(SEALED_PHASE).concealed}`).toBe('sealed anchor concealed: true');
    const text = JSON.stringify(answer.json);
    expect(`sealed name leaked: ${text.includes(SEALED_NAME)}`).toBe('sealed name leaked: false');
    expect(`open label: ${String(byId.get(OPEN_PHASE).label).startsWith('parity open list phase')}`).toBe('open label: true');
  });
});

/**
 * -- CARD bdf7b876: A WARRANT'S PROJECT ANCHORS ---------------------------------
 *
 * The Phase-anchor case above, for Project anchors. Holding a Warrant and
 * reading the Project it is anchored to are independent: `WarrantService.create`
 * validates that the anchor row EXISTS and nothing more (review 302a338f B2).
 * The linkage therefore asks, for every Project anchor, the Project read
 * decision `GET /projects` asks, keeps the anchor's type and id (the Warrant's
 * own structure, which its holder is entitled to) and conceals the Project's
 * name and status.
 *
 * The outside anchor is the point route: whether an anchor may be named is
 * read from `GET /projects/{id}` for the same caller, never recomputed. The
 * shared Project is the readable anchor; a private Project the holder reads
 * nothing in is the sealed one. Fixtures are built in this block's own
 * `beforeAll`, after every count assertion above has run.
 */
describe('a Warrant\'s Project anchors answer what the Project point route answers', () => {
  let PROJECT_WARRANT: string;
  let SEALED_PROJECT: string;
  const SEALED_PROJECT_NAME = `parity sealed anchor project ${tag()}`;

  /** Whether `GET /projects/{id}` answers 200 to this caller; a refusal is
   * the concealed 404 and nothing else. */
  const pointReads = async (who: Caller, projectId: string): Promise<boolean> => {
    const answer = await call(who, 'GET', `/projects/${projectId}`);
    if (answer.status !== 200) {
      expect(`${who.label} project point read: ${answer.status}`).toBe(`${who.label} project point read: 404`);
    }
    return answer.status === 200;
  };

  beforeAll(async () => {
    const sealed = await pool.query(
      `INSERT INTO projects (name, status, visibility, owner_principal_id)
       VALUES ($1, 'active', 'private', $2) RETURNING id`,
      [SEALED_PROJECT_NAME, ROOT_PRINCIPAL],
    );
    SEALED_PROJECT = String(sealed.rows[0].id);
    const warrant = await pool.query(
      `INSERT INTO warrants (name, holder_principal_id, created_by_principal_id, ceiling_profile_version_id, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 day') RETURNING id`,
      [`parity project warrant ${tag()}`, SESSION_USER.principalId, ROOT_PRINCIPAL, await makeCeilingVersion()],
    );
    PROJECT_WARRANT = String(warrant.rows[0].id);
    for (const anchor of [SHARED_PROJECT, SEALED_PROJECT]) {
      await pool.query(
        `INSERT INTO warrant_anchors (warrant_id, anchor_type, anchor_id) VALUES ($1, 'project', $2)`,
        [PROJECT_WARRANT, anchor],
      );
    }
  });

  it('the partition is real: root reads both Projects, the holder only the shared one (not vacuous)', async () => {
    expect(`root reads shared: ${await pointReads(ROOT, SHARED_PROJECT)}`).toBe('root reads shared: true');
    expect(`root reads sealed: ${await pointReads(ROOT, SEALED_PROJECT)}`).toBe('root reads sealed: true');
    expect(`holder reads shared: ${await pointReads(SESSION_USER, SHARED_PROJECT)}`).toBe('holder reads shared: true');
    expect(`holder reads sealed: ${await pointReads(SESSION_USER, SEALED_PROJECT)}`).toBe('holder reads sealed: false');
  });

  it('GET /warrants/{id}/linkage names a readable Project anchor and conceals an unreadable one', async () => {
    const answer = await call(SESSION_USER, 'GET', `/warrants/${PROJECT_WARRANT}/linkage`);
    expect(`linkage status: ${answer.status}`).toBe('linkage status: 200');
    const byId = new Map((answer.json.anchors as Array<any>)
      .filter((row) => row.anchorType === 'project')
      .map((row) => [row.anchorId, row]));
    // Structure stays: both anchors keep their type and id.
    expect(`project anchors: ${[SHARED_PROJECT, SEALED_PROJECT].map((id) => byId.has(id)).join(',')}`)
      .toBe('project anchors: true,true');
    const sharedReadable = await pointReads(SESSION_USER, SHARED_PROJECT);
    const sealedReadable = await pointReads(SESSION_USER, SEALED_PROJECT);
    expect(`shared project anchor concealed: ${byId.get(SHARED_PROJECT).concealed}`)
      .toBe(`shared project anchor concealed: ${!sharedReadable}`);
    expect(`sealed project anchor concealed: ${byId.get(SEALED_PROJECT).concealed}`)
      .toBe(`sealed project anchor concealed: ${!sealedReadable}`);
    expect(`sealed project label: ${byId.get(SEALED_PROJECT).label}`).toBe('sealed project label: null');
    expect(`sealed project status: ${byId.get(SEALED_PROJECT).status}`).toBe('sealed project status: null');
    const text = JSON.stringify(answer.json);
    expect(`sealed project name leaked: ${text.includes(SEALED_PROJECT_NAME)}`).toBe('sealed project name leaked: false');
    // The readable anchor still carries the Project's own name and status.
    const shared = await call(SESSION_USER, 'GET', `/projects/${SHARED_PROJECT}`);
    expect(`shared project label: ${byId.get(SHARED_PROJECT).label}`)
      .toBe(`shared project label: ${shared.json.project.name}`);
    expect(`shared project status: ${byId.get(SHARED_PROJECT).status}`)
      .toBe(`shared project status: ${shared.json.project.status}`);
  });
});

/**
 * -- OWNER RULING E338 (W62, option A): A TASK BRIEF SHOWS ITS PHASE ONLY TO A
 *    CALLER THE PHASE POINT ROUTE ANSWERS ---------------------------------------
 *
 * A Task carries no goal of its own and inherits its Phase's, so a compiled
 * Brief embeds the Phase's name, goal and description. Before E338 it did so
 * for any caller who could read the Task, while the Phase lists, the Map and a
 * Warrant's linkage concealed a Phase that caller could not read. The ruling:
 * the Brief applies the same Phase read decision, and for a caller it refuses
 * omits the name, goal and description and states only that the Task sits in
 * a restricted Phase.
 *
 * The outside anchor is the point route, as everywhere in this file: whether a
 * caller's Brief may show the Phase is read from `GET /phases/{id}` for that
 * same caller, never recomputed. Every caller here holds `phases:read`, so the
 * point route answers on object authority alone (200 or the concealed 404).
 *
 * The Phase is restricted and sits in the PRIVATE Project. Callers:
 *  - a plain Account holding a read Grant on the Task only (the W62 case);
 *  - a Connector whose chain holds the Task only, over REST and MCP;
 *  - an Agent bound to a sibling Task, minted under a Warrant anchored to
 *    that sibling, holding the Task by an explicit read rule, under a chain
 *    that holds the Task only;
 *  - a reader of the Project holding the Task too, at the task AND the
 *    project altitude (reading the Project proves nothing about the Phase);
 *  - the negative controls: an exact Phase grantee and root, who see the
 *    Phase exactly as before; and an Agent BOUND to the Task under the same
 *    Task-only chain. Its read defaults to its Task context - the bound Task,
 *    that Task's Phase and its Project - on the acting identity alone (§8.2,
 *    the `bound-task-context` arm of `sqlCondition`), so the Phase read
 *    decision admits it: `GET /phases/{id}` answers it 200 and its Brief shows
 *    the Phase. E338 applies the existing decision and adds no rule of its
 *    own, so that is the asserted answer; whether the bound-task context
 *    should stop at a restricted Phase is a separate question.
 *
 * Fixtures are built in this block's own `beforeAll`, after every count
 * assertion above has run; the Task is untracked (outside `FIXTURES`).
 */
describe('a Task Brief shows its Phase only to a caller GET /phases/{id} answers (owner ruling E338)', () => {
  const PHASE_NAME = `parity brief sealed phase ${tag()}`;
  const PHASE_GOAL = `parity brief sealed goal ${tag()}`;
  const PHASE_DESCRIPTION = `parity brief sealed description ${tag()}`;
  const SECRETS = [PHASE_NAME, PHASE_GOAL, PHASE_DESCRIPTION];
  const PHASE_SCOPES = [...SCOPES, 'phases:read'];
  let SEALED: string;
  let TASK: string;
  let TASK_ONLY: Caller;
  let TASK_CONNECTOR: Caller;
  let SIBLING: string;
  let RULE_AGENT: Caller;
  let BOUND_AGENT: Caller;
  let PROJECT_READER: Caller;
  let PHASE_GRANTEE: Caller;

  /** The sentence under test, read from the module that renders it. Required
   * lazily so a build without it fails these cases, not the whole file. */
  const notice = (): string => require('../utils/briefPhase').RESTRICTED_PHASE_NOTICE;

  const grantRead = async (principalId: string, resourceType: 'task' | 'phase' | 'project', resourceId: string): Promise<void> => {
    await pool.query(
      `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id)
       VALUES ('principal', $1, $2, $3, 'read', $4)`,
      [principalId, resourceType, resourceId, ROOT_PRINCIPAL],
    );
  };

  /** A Warrant held by `holder`, anchored to `anchorTaskId`. */
  const taskWarrant = async (holder: string, anchorTaskId: string): Promise<string> => {
    const warrant = await pool.query(
      `INSERT INTO warrants (name, holder_principal_id, created_by_principal_id, ceiling_profile_version_id, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 day') RETURNING id`,
      [`parity brief warrant ${tag()}`, holder, ROOT_PRINCIPAL, await makeCeilingVersion()],
    );
    const id = String(warrant.rows[0].id);
    await pool.query(`INSERT INTO warrant_anchors (warrant_id, anchor_type, anchor_id) VALUES ($1, 'task', $2)`, [id, anchorTaskId]);
    return id;
  };

  /** An Agent as the mint writes it: bound to `boundTaskId`, parented by
   * `connector`, carrying `objects` as its own object rules (none = the
   * read-time bound-task default), minted under a Warrant its Account holds,
   * anchored to the bound Task. */
  const agentCaller = async (label: string, connector: Caller, accountId: string,
    boundTaskId: string, objects: unknown[]): Promise<Caller> => {
    const row = await pool.query(
      `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, bound_task_id,
                               own_expression, minted_under_warrant_id)
       VALUES ('agent', $1, $1, 'active', $2, $3, $4::jsonb, $5) RETURNING id`,
      [`parity-agent-${tag()}`, connector.principalId, boundTaskId,
        JSON.stringify({ scopes: 'parent', objects }), await taskWarrant(accountId, boundTaskId)],
    );
    const principalId = String(row.rows[0].id);
    const issued = await principalService.issueCredential({
      principalId, scopes: ['tasks:read', 'phases:read'], transport: 'any',
      expiresAt: new Date(Date.now() + 3600_000),
    }, SYSTEM_ACTOR);
    return { label, principalId, headers: { Authorization: `Bearer ${issued.fullKey}` } };
  };

  /** Whether `GET /phases/{id}` answers 200; a refusal is the concealed 404. */
  const phasePointReads = async (who: Caller): Promise<boolean> => {
    const answer = await call(who, 'GET', `/phases/${SEALED}`);
    if (answer.status !== 200) {
      expect(`${who.label} phase point read: ${answer.status}`).toBe(`${who.label} phase point read: 404`);
    }
    return answer.status === 200;
  };

  const leaked = (text: string): string => SECRETS.filter((secret) => text.includes(secret)).join(' | ');

  const taskBrief = async (who: Caller, body: Record<string, unknown> = {}): Promise<Answer> => {
    const answer = await call(who, 'POST', `/tasks/${TASK}/brief`, body);
    expect(`${who.label} task brief: ${answer.status}`).toBe(`${who.label} task brief: 200`);
    return answer;
  };

  /** One compiled Brief, judged against the point route for the same caller:
   * shown in full when it reads the Phase, otherwise the sentence and the id
   * and nothing of the name, goal or description, anywhere in the JSON. */
  const expectPhaseAsPointRouteAnswers = async (who: Caller, answer: Answer, fields = SECRETS): Promise<void> => {
    const readsPhase = await phasePointReads(who);
    const text = JSON.stringify(answer.json);
    const brief = String(answer.json?.brief ?? '');
    if (readsPhase) {
      expect(`${who.label} sees: ${fields.filter((secret) => brief.includes(secret)).length}`)
        .toBe(`${who.label} sees: ${fields.length}`);
      expect(`${who.label} told restricted: ${brief.includes(notice())}`).toBe(`${who.label} told restricted: false`);
    } else {
      expect(`${who.label} leaked: ${leaked(text)}`).toBe(`${who.label} leaked: `);
      expect(`${who.label} told restricted: ${brief.includes(notice())}`).toBe(`${who.label} told restricted: true`);
      expect(`${who.label} keeps the phase id: ${brief.includes(`"id": "${SEALED}"`) && brief.includes('"restricted": true')}`)
        .toBe(`${who.label} keeps the phase id: true`);
    }
  };

  beforeAll(async () => {
    const phase = await pool.query(
      `INSERT INTO phases (project_id, name, goal, description, position, restricted_access)
       VALUES ($1, $2, $3, $4, 60, true) RETURNING id`,
      [PRIVATE_PROJECT, PHASE_NAME, PHASE_GOAL, PHASE_DESCRIPTION],
    );
    SEALED = String(phase.rows[0].id);
    TASK = await makeUntrackedTask('in the sealed brief phase', 'todo', PRIVATE_PROJECT);
    await pool.query('UPDATE tasks SET phase_id = $1 WHERE id = $2', [SEALED, TASK]);

    // W62 itself: a plain Account holding a read Grant on the Task and nothing else.
    TASK_ONLY = await sessionCallerFor('task-only account', await makeAccount('human', 'user'));
    await grantRead(TASK_ONLY.principalId, 'task', TASK);

    // A Connector and two Agents whose chain holds the Task only. The Grant
    // lands on both ends of the Connector chain (see `grantToChain`).
    const taskAccount = await makeAccount('service', 'user');
    TASK_CONNECTOR = await connectorCaller('task-only connector', taskAccount, PHASE_SCOPES);
    for (const principalId of [taskAccount, TASK_CONNECTOR.principalId]) await grantRead(principalId, 'task', TASK);
    SIBLING = await makeUntrackedTask('sibling outside the sealed phase', 'todo', PRIVATE_PROJECT);
    RULE_AGENT = await agentCaller('agent holding the task by rule', TASK_CONNECTOR, taskAccount, SIBLING,
      [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [TASK], verbs: ['read'] }]);
    BOUND_AGENT = await agentCaller('agent bound to the task', TASK_CONNECTOR, taskAccount, TASK, []);

    // A reader of the private Project. The restricted Phase suppresses what
    // the Project lends the Task too, so the Task needs its own Grant.
    PROJECT_READER = await sessionCallerFor('project reader', await makeAccount('human', 'user'));
    await grantRead(PROJECT_READER.principalId, 'project', PRIVATE_PROJECT);
    await grantRead(PROJECT_READER.principalId, 'task', TASK);

    // Negative control: an exact Phase grant reaches the restricted Phase.
    PHASE_GRANTEE = await sessionCallerFor('phase grantee', await makeAccount('human', 'user'));
    await grantRead(PHASE_GRANTEE.principalId, 'task', TASK);
    await grantRead(PHASE_GRANTEE.principalId, 'phase', SEALED);
  });

  it('the partition is real: every caller reads the Task, and only the controls read the Phase (not vacuous)', async () => {
    for (const who of [ROOT, TASK_ONLY, TASK_CONNECTOR, RULE_AGENT, PROJECT_READER, PHASE_GRANTEE, BOUND_AGENT]) {
      expect(`${who.label} reads the task: ${(await call(who, 'GET', `/tasks/${TASK}`)).status}`)
        .toBe(`${who.label} reads the task: 200`);
    }
    const reads = async (who: Caller): Promise<string> => `${who.label} reads the phase: ${await phasePointReads(who)}`;
    for (const who of [ROOT, PHASE_GRANTEE, BOUND_AGENT]) expect(await reads(who)).toBe(`${who.label} reads the phase: true`);
    for (const who of [TASK_ONLY, TASK_CONNECTOR, RULE_AGENT, PROJECT_READER]) {
      expect(await reads(who)).toBe(`${who.label} reads the phase: false`);
    }
    expect(`project reader reads the project: ${(await call(PROJECT_READER, 'GET', `/projects/${PRIVATE_PROJECT}`)).status}`)
      .toBe('project reader reads the project: 200');
  });

  it('POST /tasks/{id}/brief shows the Phase exactly when GET /phases/{id} answers the same caller', async () => {
    for (const who of [TASK_ONLY, TASK_CONNECTOR, RULE_AGENT, PROJECT_READER, ROOT, PHASE_GRANTEE, BOUND_AGENT]) {
      await expectPhaseAsPointRouteAnswers(who, await taskBrief(who));
    }
  });

  it('the AGENTS.md shape conceals the same way', async () => {
    for (const who of [TASK_ONLY, RULE_AGENT, ROOT]) {
      await expectPhaseAsPointRouteAnswers(who, await taskBrief(who, { format: 'agentsmd' }));
    }
  });

  it('relayhall_brief_compile (MCP, taskId) answers as the point route does for Connectors and Agents, in both formats', async () => {
    const { toolByName } = require('../mcp/registry');
    const tool = toolByName('relayhall_brief_compile');
    for (const who of [TASK_CONNECTOR, RULE_AGENT, BOUND_AGENT]) {
      const ctx = { authorization: who.headers.Authorization, toolName: 'relayhall_brief_compile' };
      const readsPhase = await phasePointReads(who);
      const detailed: string = await tool.handler({ taskId: TASK, response_format: 'detailed' }, ctx);
      const concise: string = await tool.handler({ taskId: TASK }, ctx);
      for (const [format, text] of [['detailed', detailed], ['concise', concise]]) {
        if (readsPhase) {
          expect(`${who.label} ${format} shows the name: ${text.includes(PHASE_NAME)}`)
            .toBe(`${who.label} ${format} shows the name: true`);
        } else {
          expect(`${who.label} ${format} leaked: ${leaked(text)}`).toBe(`${who.label} ${format} leaked: `);
          expect(`${who.label} ${format} told restricted: ${text.includes(notice())}`)
            .toBe(`${who.label} ${format} told restricted: true`);
        }
      }
    }
  });

  it('POST /projects/{id}/brief with the taskId conceals the Phase from a Project reader, and shows it to root', async () => {
    for (const who of [PROJECT_READER, ROOT]) {
      const answer = await call(who, 'POST', `/projects/${PRIVATE_PROJECT}/brief`, { taskId: TASK });
      expect(`${who.label} project brief: ${answer.status}`).toBe(`${who.label} project brief: 200`);
      // The project altitude renders the Phase's name and goal (never its description).
      await expectPhaseAsPointRouteAnswers(who, answer, [PHASE_NAME, PHASE_GOAL]);
      expect(`${who.label} project brief carries the description: ${JSON.stringify(answer.json).includes(PHASE_DESCRIPTION)}`)
        .toBe(`${who.label} project brief carries the description: false`);
    }
  });

  it('the session and phase altitudes carry nothing of the Phase to a caller who cannot read it', async () => {
    const session = await call(RULE_AGENT, 'POST', '/principals/me/brief', {});
    expect(`agent session brief: ${session.status}`).toBe('agent session brief: 200');
    expect(`agent session brief leaked: ${leaked(JSON.stringify(session.json))}`).toBe('agent session brief leaked: ');
    for (const who of [TASK_ONLY, RULE_AGENT]) {
      const phaseBrief = await call(who, 'POST', `/phases/${SEALED}/brief`, {});
      expect(`${who.label} phase brief: ${phaseBrief.status}`).toBe(`${who.label} phase brief: 404`);
      expect(`${who.label} phase brief leaked: ${leaked(JSON.stringify(phaseBrief.json))}`).toBe(`${who.label} phase brief leaked: `);
    }
  });
});
