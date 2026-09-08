/**
 * 590e88cc — THE TASK READ PATHS DO NOT EXHAUST THE POOL AT ESTATE SCALE.
 *
 * The defect this gate exists for was reported as "intermittent 500s across
 * five task-read paths and the AutoArchive job at 5k scale", cause unknown for
 * three weeks: the response bodies were the generic envelope, the log said
 * `class=Error code=ERROR_UNCLASSIFIED` on every one of fifteen recorded
 * failures, and it would not reproduce through the API on a small estate.
 *
 * It is one producer and four victims. `GET /tasks` computed its dependency
 * fields with a `Promise.all` over the UNPAGINATED estate, three point reads
 * per Task, each of which re-read Tasks through `getTask` — one statement for
 * the row plus the four child-table statements `hydrateTasks` issues. Measured
 * on the 5,200-Task fixture at the parent commit: ONE request, no concurrency,
 * offered the pool 9,186 connection acquisitions. `max` is 20 and
 * `connectionTimeoutMillis` is 2000, so acquisitions that wait longer than two
 * seconds THROW — as a plain `Error` with no `code`, which is exactly why the
 * classifier could only say ERROR_UNCLASSIFIED. Every other caller sharing
 * those twenty connections — the board, the graph, filter-options,
 * /dashboard/active and the AutoArchive job — failed for as long as the flood
 * drained, which is why the defect looked like five unrelated faults.
 *
 * ── WHAT IS MEASURED, AND WHY EACH ONE ──
 *
 * 1. INVARIANCE. The number of pool acquisitions one `GET /tasks` makes does
 *    not grow with the size of the estate. This is the property the repair has
 *    and the defect did not, and it is measured at TWO estate sizes rather than
 *    asserted against a number this file could be edited to agree with. The
 *    vacuity guard is explicit: the two measurements must be taken over
 *    genuinely different populations, or the comparison proves nothing.
 *
 * 2. THE LOAD ITSELF. N concurrent authenticated callers over all five reported
 *    paths, with the AutoArchive job running beside them, at 5,200 Tasks: zero
 *    5xx, and the pool's own waiting counter — sampled from OUTSIDE the pool,
 *    because a sample taken from a pool client competes for the resource it
 *    measures — stays below a bound the defect exceeded by three orders of
 *    magnitude.
 *
 * 3. THE DECISIONS ARE UNCHANGED. The batched dependency read replaced three
 *    point reads, so the point reads are the ORACLE: for every fixture Task the
 *    route's `blocked`, `blockingTasks` and `dependentTasks` must equal what
 *    `getBlockingTasks` / `getDependentTasks` / `isTaskBlocked` say, and the
 *    narrowing must still hide an unreadable related Task while `blocked`
 *    continues to reflect it. A performance repair that quietly changed an
 *    authorization answer would be a worse defect than the one it fixed.
 *
 * 4. THE TWO INDEXES ARE IN THE SCHEMA. `task_links(task_id)` and
 *    `task_dependencies(depends_on_task_id)` were created by migration 020 and
 *    lost when `database/init.sql` was cut as the baseline; migration 129 puts
 *    them back. The assertion is against the LIVE schema, not against the
 *    migration file, so a future baseline re-cut that loses them again fails
 *    here rather than silently reintroducing sequential scans.
 *
 * ── WHY IT IS NOT IN THE DEFAULT JEST RUN ──
 *
 * It connects to `RELAYHALL_TEST_DB_URL` and FAILS — never skips — when the
 * variable is unset. Every claim above is about a real pool against a real
 * PostgreSQL holding thousands of rows; a mocked pool has no `waitingCount`
 * worth reading and no planner to be wrong. Excluded by
 * `testPathIgnorePatterns`, run by `npm run test:scale-load` and
 * UNCONDITIONALLY in CI against the `services: postgres` block.
 *
 * ── THE DESTRUCTIVE CONTRACT, STATED ──
 *
 * This suite WRITES thousands of rows to principals, projects, phases, tasks,
 * task_tags, task_links, subtasks, task_dependencies and auth_sessions, and it
 * ARCHIVES completed Tasks. It refuses any URL naming a deployment database
 * (`relayhall_dev`, `relayhall_tst`, `relayhall_prod`, `relayhall`) and any
 * non-local host except postgres/relayhall_ci when CI=true. Bring the database up with `database/init.sql` and
 * `npm run migrate`, and throw it away afterwards.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import { isScaleFixtureHost } from '../../scripts/scale-fixture-host';

// ─────────────────────────── the database contract ───────────────────────────

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error(
    'RELAYHALL_TEST_DB_URL is not set. This gate measures pool behaviour under load against a REAL PostgreSQL and refuses to skip: '
    + 'the property under test is how many connections a request acquires, and a mocked pool acquires none. '
    + 'Create a disposable database, load database/init.sql, run npm run migrate, and set RELAYHALL_TEST_DB_URL to it.',
  );
}

const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = parsed.pathname.replace(/^\//, '');
if (!TEST_DB_NAME) throw new Error('The URL names no database name. Refusing to write.');
const FORBIDDEN_DATABASES = ['relayhall_dev', 'relayhall_tst', 'relayhall_prod', 'relayhall'];
if (FORBIDDEN_DATABASES.includes(TEST_DB_NAME)) {
  throw new Error(`RELAYHALL_TEST_DB_URL names a deployment database (${TEST_DB_NAME}). This suite writes thousands of rows and archives Tasks; point it at a disposable database.`);
}
if (!isScaleFixtureHost(parsed.hostname, TEST_DB_NAME, process.env.CI)) {
  throw new Error(`RELAYHALL_TEST_DB_URL is not local (${parsed.hostname}). This suite writes; point it at a disposable local database.`);
}

process.env.DB_HOST = parsed.hostname;
process.env.DB_PORT = parsed.port || '5432';
process.env.DB_NAME = TEST_DB_NAME;
process.env.DB_USER = decodeURIComponent(parsed.username);
process.env.DB_PASSWORD = decodeURIComponent(parsed.password);
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'scale-load-suite-secret-0123456789abcdef';
process.env.RELAYHALL_SESSIONS = 'on';

const express = require('express');

const { pool, databasePoolConfig } = require('../db/connection');
const { Pool } = require('pg');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { taskManagerDB } = require('../services/TaskManagerDB');
const { autoArchive, AutoArchive, ARCHIVE_MAX_PER_CYCLE } = require('../services/autoArchive');
const { seedScaleFixture } = require('../../scripts/seed-scale-fixture');

jest.setTimeout(900_000);

// ─────────────────────────── the shape of the estate ─────────────────────────

/** The reported fixture: the A8 exit-battery shape the defect was found on. */
const SCALE_TASKS = Number(process.env.SCALE_LOAD_TASKS || 5200);
/** The first, deliberately small estate the invariance measurement starts from.
 * Small enough that the DEFECT would still succeed on it — the point of the
 * pair is that the defect's cost grows and the repair's does not, and a first
 * measurement that already fails proves only that the second one is bigger. */
const SMALL_TASKS = 300;

/** Every fixture this run creates carries it, so the suite can be re-run against
 * a database that still holds a previous run: a fixed label collides on the
 * unique principal handle and the collision reads as a code defect. */
const RUN_TAG = require("crypto").randomBytes(4).toString("hex");

/** The five paths the card names, in the order it names them. */
const READ_PATHS = [
  '/tasks',
  '/tasks/filter-options?includeArchived=true',
  '/tasks/board',
  '/tasks/graph',
  '/dashboard/active',
];

/**
 * Round-1 REJECT, blocking finding 2. Both concurrencies are read from the
 * environment, and `Number('0')` is 0: every loop below then ran zero times,
 * `failures` was empty, `answers.every(...)` was vacuously true and even
 * `answers.length === paths * concurrency * 2` held — a gate whose
 * non-vacuity an environment variable could switch off from outside.
 *
 * A concurrency is a positive integer or it is a configuration error, and this
 * suite refuses rather than measuring nothing.
 */
function positiveConcurrency(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer; got ${JSON.stringify(raw)}. A concurrency of zero measures nothing.`);
  }
  return value;
}

/**
 * The concurrency the five-path battery runs at, PER CALLER — so twice this
 * many concurrent readers on every one of the five paths.
 */
const SUPPORTED_CONCURRENCY = positiveConcurrency('SCALE_LOAD_CONCURRENCY', 4);

/**
 * The concurrency the FOCUSED battery runs GET /tasks at, and why it is twelve.
 *
 * Twelve is not a headroom number, it is the configuration that measures the
 * connection ACQUISITION DEADLINE. Measured on this fixture at the parent
 * values, GET /tasks alone, three runs at each concurrency:
 *
 *   connectionTimeoutMillis 2000    c=12  9/12 ×3    c=16 13,11,12/16   c=24 24,16,20/24
 *   connectionTimeoutMillis 15000   c=12 12/12 ×3    c=16 16/16 ×3      c=24 24/24 ×3
 *
 * Twelve is the LOWEST concurrency at which the old value failed in every one
 * of those runs, which makes it the cheapest configuration that told the two
 * apart when they were measured in isolation.
 *
 * BUT IT IS NOT THE RED PROOF, and this comment says so rather than letting a
 * reader assume it. Run inside this suite, after the batteries above have
 * warmed the pool and on whatever the machine is doing at the time, restoring
 * 2000 reddens this test only SOMETIMES — measured. A red proof that only
 * sometimes goes red proves only that it sometimes goes red. The deterministic
 * control for the deadline is section 3c, which does not depend on load at all;
 * the drill's M9 names that one.
 *
 * What this battery is, then, is an ACCEPTANCE at the size and shape the card
 * reports: twelve concurrent whole-estate reads, all answered.
 */
const FOCUSED_CONCURRENCY = positiveConcurrency('SCALE_LOAD_FOCUSED', 12);

/**
 * The ceiling on the pool's waiting queue under the whole battery.
 *
 * Not a latency budget and not a tuning knob: the pool holds 20 connections, so
 * a queue in the low hundreds is ordinary contention between concurrent
 * callers and drains. The defect's queue was 20,702 — three orders of magnitude
 * above this line — and the line sits far enough below that number that no
 * plausible re-growth of a per-row fan-out passes it.
 */
const WAITING_CEILING = 1000;

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

interface Caller { label: string; principalId: string; headers: Record<string, string> }
interface Answer { status: number; code: string | null; ms: number; bytes: number; json: any }

async function call(who: Caller, path: string): Promise<Answer> {
  const started = Date.now();
  const response = await fetch(`${origin}${path}`, { headers: who.headers });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  // The byte length is carried because one control's whole claim is about it.
  return {
    status: response.status, code: json?.code ?? null, ms: Date.now() - started,
    bytes: Buffer.byteLength(text), json,
  };
}

async function sessionCaller(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

// ───────────────────── acquisition counting, from outside ────────────────────

/**
 * Every way a caller can take a connection out of the pool: `pool.query` (the
 * pool checks one out, runs the statement and returns it) and `pool.connect`
 * (the caller holds one). Counting BOTH is the point — a fan-out that moved
 * from one to the other would otherwise read as a repair.
 */
let acquisitions = 0;
const realQuery = pool.query.bind(pool);
const realConnect = pool.connect.bind(pool);
function installCounter(): void {
  pool.query = (...args: any[]) => { acquisitions += 1; return realQuery(...args); };
  pool.connect = (...args: any[]) => { acquisitions += 1; return realConnect(...args); };
}
function removeCounter(): void {
  pool.query = realQuery;
  pool.connect = realConnect;
}
async function acquisitionsFor(fn: () => Promise<unknown>): Promise<number> {
  acquisitions = 0;
  installCounter();
  try { await fn(); } finally { removeCounter(); }
  return acquisitions;
}

// ────────────────────────────── fixture state ────────────────────────────────

let ROOT: Caller;
let USER: Caller;
// beforeAll MEASURES; it does not assert. A mutation that makes the route fail
// would otherwise kill the hook, and a suite that never runs names no assertion
// — so the drill could not tell which control caught it.
let smallEstateAcquisitions = 0;
let smallEstateTasks = 0;
let smallEstateStatus = 0;
let fullEstateAcquisitions = 0;
let fullEstateTasks = 0;
let fullEstateStatus = 0;

/** A Task the scoped caller may read that DEPENDS ON one it may not. */
let VISIBLE_HOLDER: string;
let HIDDEN_BLOCKER: string;

beforeAll(async () => {
  const app = buildApp();
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;

  // ── the small estate, and the first invariance measurement ────────────────
  const small = await seedScaleFixture({
    tasks: SMALL_TASKS, projects: 8, phases: 20, dependencies: 40, label: `scaleload-small-${RUN_TAG}`,
  });
  ROOT = await sessionCaller('root', small.rootPrincipalId);
  USER = await sessionCaller('user', small.userPrincipalId);

  smallEstateAcquisitions = await acquisitionsFor(async () => {
    const answer = await call(ROOT, '/tasks');
    smallEstateStatus = answer.status;
    smallEstateTasks = answer.json?.tasks?.length ?? 0;
  });

  // ── the visible-holder / hidden-blocker pair ──────────────────────────────
  // Built explicitly rather than found in the random fixture: the assertion is
  // about a SPECIFIC shape, and a shape the fixture happens to contain today
  // is a shape it can stop containing tomorrow.
  const shared = await pool.query(
    `INSERT INTO tasks (title, status, visibility, creator_principal_id, shepherd_principal_id)
     VALUES ('scaleload holder', 'todo', 'shared', $1, $1) RETURNING id`,
    [small.rootPrincipalId],
  );
  VISIBLE_HOLDER = String(shared.rows[0].id);
  const hidden = await pool.query(
    `INSERT INTO tasks (title, status, visibility, creator_principal_id, shepherd_principal_id)
     VALUES ('scaleload hidden blocker', 'todo', 'private', $1, $1) RETURNING id`,
    [small.rootPrincipalId],
  );
  HIDDEN_BLOCKER = String(hidden.rows[0].id);
  await pool.query(
    'INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)',
    [VISIBLE_HOLDER, HIDDEN_BLOCKER],
  );

  // ── the full estate, and the second measurement ───────────────────────────
  await seedScaleFixture({
    tasks: SCALE_TASKS - SMALL_TASKS, projects: 47, phases: 200, dependencies: 538, label: `scaleload-full-${RUN_TAG}`,
  });
  fullEstateAcquisitions = await acquisitionsFor(async () => {
    const answer = await call(ROOT, '/tasks');
    fullEstateStatus = answer.status;
    fullEstateTasks = answer.json?.tasks?.length ?? 0;
  });
});

afterAll(async () => {
  removeCounter();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ─────────────────────────────── 1 · invariance ──────────────────────────────

describe('the cost of a task list does not grow with the estate', () => {
  test('the two measurements were taken over genuinely different populations', () => {
    // The vacuity guard, and it fails LOUDLY rather than skipping: if both
    // reads returned about the same rows, the comparison below is between a
    // number and itself and would pass against the defect just as happily.
    // The usual cause is a database that already held a previous run's estate.
    // Both measurements came from a route that ANSWERED. The defect this gate
    // exists for made the unpaginated read fail outright at estate scale, and a
    // measurement taken from a 500 measures the failure path.
    expect({ small: smallEstateStatus, full: fullEstateStatus }).toEqual({ small: 200, full: 200 });
    expect(smallEstateTasks).toBeGreaterThan(0);
    expect({
      smallEstateTasks,
      fullEstateTasks,
      note: 'the full estate must be several times the small one; a database that is not disposable makes this comparison meaningless',
    }).toEqual(expect.objectContaining({ smallEstateTasks, fullEstateTasks }));
    expect(fullEstateTasks).toBeGreaterThan(smallEstateTasks * 5);
  });

  test('pool acquisitions per GET /tasks are invariant in the number of Tasks', () => {
    // The defect made this LINEAR: at 5,200 Tasks it offered the pool 9,186
    // acquisitions, and at 300 it would have offered roughly 530. What is
    // asserted is the shape, not a tuned number — the full estate is more than
    // seventeen times the small one, so anything that still scales with rows
    // cannot sit inside a factor of two.
    expect(fullEstateAcquisitions).toBeLessThanOrEqual(smallEstateAcquisitions * 2);
    // …and it is genuinely small, not merely equal. A repair that made both
    // measurements enormous would satisfy the comparison above.
    expect(fullEstateAcquisitions).toBeLessThan(60);
  });
});

// ─────────────────────────────── 2 · the load ────────────────────────────────

describe('the five reported read paths under concurrent load at estate scale', () => {
  test('zero 5xx, and the pool is never exhausted, with AutoArchive running beside them', async () => {
    const concurrency = SUPPORTED_CONCURRENCY;

    // Round-1 REJECT, blocking finding 3. `runArchive` catches every failure
    // and returns 0, so `typeof archived === 'number'` accepted the exact
    // pool-acquisition failure this card is about as a success — the
    // background-job half of the card was not verified under contention at
    // all. What the job must do is now COUNTED, from the database, on both
    // sides of the wave.
    const eligibleNow = async (): Promise<number> => (await pool.query(
      `SELECT COUNT(*)::int AS n FROM tasks
        WHERE status = 'completed' AND completed_at IS NOT NULL
          AND completed_at <= NOW() - INTERVAL '7 days'`,
    )).rows[0].n;
    const eligibleBefore = await eligibleNow();
    // The estate must actually give the job something to do, or its survival
    // under load is a claim about an idle job.
    expect(eligibleBefore).toBeGreaterThan(0);

    // Sampled on a wall-clock tick, from OUTSIDE the pool.
    let maxWaiting = 0;
    const sampler = setInterval(() => { maxWaiting = Math.max(maxWaiting, pool.waitingCount); }, 25);

    const answers: Array<{ path: string; caller: string; answer: Answer }> = [];
    const archive = autoArchive.runArchive();
    const wave: Promise<void>[] = [];
    for (const caller of [ROOT, USER]) {
      for (let c = 0; c < concurrency; c += 1) {
        for (const path of READ_PATHS) {
          wave.push(call(caller, path).then((answer) => { answers.push({ path, caller: caller.label, answer }); }));
        }
      }
    }
    await Promise.all(wave);
    const archived = await archive;
    clearInterval(sampler);

    const failures = answers.filter(({ answer }) => answer.status >= 500);
    // The failure report names the path, the caller and the CODE from the fixed
    // error envelope — a closed set, never a message.
    expect(failures.map((f) => `${f.caller} ${f.path} -> ${f.answer.status} ${f.answer.code}`)).toEqual([]);
    expect(answers.every(({ answer }) => answer.status === 200)).toBe(true);
    expect(answers.length).toBe(READ_PATHS.length * concurrency * 2);

    expect(maxWaiting).toBeLessThan(WAITING_CEILING);

    // The job did its whole job, beside the load. `archived` is compared to a
    // number the DATABASE produced before the wave, and the remaining eligible
    // count is read back afterwards: a swallowed failure returns 0 and reddens
    // both, and a partial cycle reddens the second.
    const expectedArchived = Math.min(eligibleBefore, ARCHIVE_MAX_PER_CYCLE);
    expect({ archived, eligibleAfter: await eligibleNow() })
      .toEqual({ archived: expectedArchived, eligibleAfter: eligibleBefore - expectedArchived });

    // p95 per path, reported for the record rather than asserted: a latency
    // ceiling on an unpaginated whole-estate list would be measuring the
    // machine that runs CI.
    const report: Record<string, unknown> = { concurrency, maxWaiting, archived };
    for (const path of READ_PATHS) {
      const rows = answers.filter((a) => a.path === path).map((a) => a.answer.ms).sort((x, y) => x - y);
      report[path] = { n: rows.length, p50: rows[Math.floor(rows.length * 0.5)], p95: rows[Math.floor(rows.length * 0.95)] };
    }
    console.log(`[scale-load] ${JSON.stringify(report)}`);
  });
});

// ───────────────────────── 3 · the decisions are unchanged ───────────────────

describe('the batched dependency read answers what the point reads answer', () => {
  test('blocked, blockingTasks and dependentTasks agree with the point forms', async () => {
    // The compared set is chosen from the rows that HAVE edges, in both
    // directions. A hundred Tasks taken off the top of the list would mostly
    // have none, and a comparison of empty arrays against empty arrays agrees
    // with every possible implementation — which is the way this control could
    // most easily have been vacuous.
    const withEdges = await pool.query(
      `SELECT e.id FROM (
         SELECT task_id AS id FROM task_dependencies
         UNION
         SELECT depends_on_task_id AS id FROM task_dependencies
       ) e
       JOIN tasks t ON t.id = e.id
       WHERE t.status <> 'archived'
       LIMIT 40`,
    );
    // Archived Tasks are excluded because the list route excludes them by
    // default, and the AutoArchive cycles above have by now archived some of
    // the fixture. Choosing a row the route is CORRECT to omit would make this
    // control fail for a reason that has nothing to do with what it measures.
    const chosen = new Set(withEdges.rows.map((row: any) => String(row.id)));
    expect(chosen.size).toBeGreaterThanOrEqual(20);

    const answer = await call(ROOT, '/tasks');
    expect(answer.status).toBe(200);
    const listed: any[] = answer.json.tasks.filter((task: any) => chosen.has(task.id));
    expect(listed.length).toBe(chosen.size);

    // The ORACLE is the untouched point form on the service, not a rule
    // restated here: the repair replaced three point reads, so the three point
    // reads are what it must still agree with.
    let compared = 0;
    let withSomethingToSay = 0;
    for (const task of listed) {
      const blocking = await taskManagerDB.getBlockingTasks(task.id);
      const dependents = await taskManagerDB.getDependentTasks(task.id);
      const blocked = await taskManagerDB.isTaskBlocked(task.id);
      expect(task.blocked).toBe(blocked);
      expect(task.blockingTasks.map((t: any) => t.id).sort())
        .toEqual(blocking.map((t: any) => t.id).sort());
      expect(task.dependentTasks.map((t: any) => t.id).sort())
        .toEqual(dependents.map((t: any) => t.id).sort());
      compared += 1;
      if (blocking.length > 0 || dependents.length > 0) withSomethingToSay += 1;
    }
    // A loop that compared nothing, or that compared only empty arrays, passes
    // every assertion inside it. What the guard must NOT require is that every
    // chosen row has a non-empty summary: a Task whose only dependency is
    // already satisfied has an empty `blockingTasks` and is correct to, and a
    // guard that forbade it would be asserting the fixture rather than the
    // property. What it requires is that the comparison is substantially
    // non-trivial in BOTH directions.
    expect(compared).toBe(listed.length);
    expect(compared).toBeGreaterThanOrEqual(20);
    expect(withSomethingToSay).toBeGreaterThanOrEqual(compared - 5);
    const withBlockers = listed.filter((task: any) => task.blockingTasks.length > 0).length;
    const withDependents = listed.filter((task: any) => task.dependentTasks.length > 0).length;
    expect({ withBlockers: withBlockers > 0, withDependents: withDependents > 0 })
      .toEqual({ withBlockers: true, withDependents: true });
    // …and at least some of them are genuinely BLOCKED, so the
    // `dependencyBlocks` filter is exercised rather than merely present.
    expect(listed.filter((task: any) => task.blocked).length).toBeGreaterThan(0);
  });

  test('an unreadable blocker is hidden from the summary and still makes the holder blocked', async () => {
    // The point route is the outside anchor for "unreadable": the expected
    // answer is READ BACK from the surface that refuses, never recomputed.
    const pointOnHidden = await call(USER, `/tasks/${HIDDEN_BLOCKER}`);
    expect(pointOnHidden.status).toBe(404);
    const pointOnHolder = await call(USER, `/tasks/${VISIBLE_HOLDER}`);
    expect(pointOnHolder.status).toBe(200);

    const answer = await call(USER, '/tasks');
    expect(answer.status).toBe(200);
    const holder = answer.json.tasks.find((task: any) => task.id === VISIBLE_HOLDER);
    expect(holder).toBeDefined();

    // Narrowed: the blocker the caller may not read is not named.
    expect(holder.blockingTasks.map((t: any) => t.id)).not.toContain(HIDDEN_BLOCKER);
    expect(holder.blockingTasks).toEqual([]);
    // Not narrowed: whether a Task is blocked is a property of the Task. A
    // `false` here would tell the caller the blocker does not exist.
    expect(holder.blocked).toBe(true);

    // And root, who may read it, is told which Task it is.
    const rootAnswer = await call(ROOT, '/tasks');
    const rootHolder = rootAnswer.json.tasks.find((task: any) => task.id === VISIBLE_HOLDER);
    expect(rootHolder.blocked).toBe(true);
    expect(rootHolder.blockingTasks.map((t: any) => t.id)).toContain(HIDDEN_BLOCKER);
  });
});

// ──────────────────── 3a · the background job is bounded ─────────────────────

describe('one AutoArchive cycle does a bounded amount of work', () => {
  test('a cycle stops at its ceiling and the next cycle takes the remainder', async () => {
    // The job used to load the WHOLE estate, hydrated, once an hour, to find
    // the handful of rows past its threshold — and then archive every one of
    // them in a single unbounded cycle. Both halves are pool time taken from
    // the request paths, which is the failure this card is about wearing a
    // different hat. The ceiling is what makes a first cycle against a large
    // completed backlog finite.
    const project = await pool.query(
      `INSERT INTO projects (name, status, visibility) VALUES ($1, 'active', 'private') RETURNING id`,
      [`scaleload archive backlog ${Date.now()}`],
    );
    // This run's root Account, not whichever one a previous run left behind.
    const owner = await pool.query(
      `SELECT id FROM principals WHERE handle LIKE $1 LIMIT 1`,
      [`scale-root-scaleload-small-${RUN_TAG}%`],
    );
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const BACKLOG = 12;
    const CEILING = 5;
    const rows: string[] = [];
    const values: unknown[] = [];
    for (let i = 0; i < BACKLOG; i += 1) {
      const base = values.length;
      rows.push(`($${base + 1}, 'completed', $${base + 2}, $${base + 3}, $${base + 4}, $${base + 4})`);
      values.push(`scaleload ${RUN_TAG} backlog ${i}`, old, String(project.rows[0].id), String(owner.rows[0].id));
    }
    await pool.query(
      `INSERT INTO tasks (title, status, completed_at, project_id, creator_principal_id, shepherd_principal_id)
       VALUES ${rows.join(', ')}`,
      values,
    );

    // The estate holds other eligible rows — the seeded fixture has completed
    // Tasks of its own — so what a cycle RETURNS is a count over the whole
    // estate and cannot be compared to this backlog. What can be compared is
    // the bound itself (every cycle returns exactly the ceiling while more than
    // the ceiling remains eligible) and this backlog's own fate (the cycle
    // orders by completed_at ASC and these rows are the oldest in the estate,
    // so they are taken first, and all of them are taken).
    const eligible = async (): Promise<number> => (await pool.query(
      `SELECT COUNT(*)::int AS n FROM tasks WHERE status = 'completed' AND completed_at IS NOT NULL AND completed_at < NOW() - INTERVAL '7 days'`,
    )).rows[0].n;
    const backlogArchived = async (): Promise<number> => (await pool.query(
      `SELECT COUNT(*)::int AS n FROM tasks WHERE title LIKE $1 AND status = 'archived'`,
      [`scaleload ${RUN_TAG} backlog %`],
    )).rows[0].n;

    // These rows are the OLDEST in the estate by four hundred days, and the
    // cycle orders by completed_at ASC, so they are taken first whatever else
    // is eligible. That is what makes the first two cycles predictable without
    // assuming this backlog is all there is: the load battery above may have
    // consumed every other eligible row, or may have left some.
    expect(await eligible()).toBeGreaterThanOrEqual(BACKLOG);

    const bounded = new AutoArchive(7, { batchSize: 2, maxPerCycle: CEILING });
    const cycles: number[] = [];
    for (let i = 0; i < Math.ceil(BACKLOG / CEILING); i += 1) {
      cycles.push(await bounded.runArchive());
    }
    // NEVER more than the ceiling — that is the bound. A batch size SMALLER
    // than the ceiling is deliberate: it proves a cycle stops on its own
    // ceiling rather than because one batch happened to run out.
    expect(cycles.filter((n) => n > CEILING)).toEqual([]);
    // The first two cycles hit the ceiling EXACTLY: twelve of this backlog's
    // rows sort ahead of everything else, so more than the ceiling remained
    // through both. Without this the bound could be satisfied by a cycle that
    // simply ran out of work.
    expect([cycles[0], cycles[1]]).toEqual([CEILING, CEILING]);
    expect(cycles.length).toBe(3);
    // Nothing is lost: a bound that dropped work would be a worse defect than
    // the one it was added for.
    expect(await backlogArchived()).toBe(BACKLOG);
  });
});

// ───────────── 3b · the residual cost is the response, not the pool ──────────

describe('the unpaginated whole-estate read holds at the concurrency that measured the deadline', () => {
  test('twelve concurrent GET /tasks all answer 200', async () => {
    // The focused battery. At the parent's 2,000ms acquisition deadline this
    // configuration lost three of twelve in every run; at 15,000ms it loses
    // none. Nothing else differs — same pool size, same queue depth, same
    // event-loop lag — so what this measures is the deadline, not the load.
    const answers = await Promise.all(
      Array.from({ length: FOCUSED_CONCURRENCY }, () => call(ROOT, '/tasks')),
    );
    expect(answers.filter((a) => a.status !== 200).map((a) => `${a.status} ${a.code}`)).toEqual([]);
    // …and it really was the whole estate, not a cheap empty answer.
    expect(answers[0].json.tasks.length).toBeGreaterThan(SCALE_TASKS * 0.8);
  });
});

describe('what the remaining cost is: the response, not the pool', () => {
  test('the two forms of one route differ by response size, and only the large one is expensive', async () => {
    // Round-1 REJECT, non-blocking finding. This control used to compare
    // twenty-four paginated requests against nothing and assert only that they
    // answered 200 — which attributes nothing to anything. Both forms now run
    // at the SAME concurrency, through the SAME route, the SAME predicate and
    // the SAME pool, and the SIZE they differ by is recorded rather than
    // quoted from a capture.
    //
    // What this establishes: if a fan-out, a missing index or a slow predicate
    // were still there, the paginated form would carry it too. It does not.
    const concurrency = FOCUSED_CONCURRENCY;
    const whole = await Promise.all(
      Array.from({ length: concurrency }, () => call(ROOT, '/tasks')),
    );
    const paged = await Promise.all(
      Array.from({ length: concurrency }, () => call(ROOT, '/tasks?limit=100')),
    );

    expect(paged.filter((a) => a.status !== 200).map((a) => `${a.status} ${a.code}`)).toEqual([]);
    expect(whole.filter((a) => a.status !== 200).map((a) => `${a.status} ${a.code}`)).toEqual([]);

    // Both really answered the same route with real content: a cheap empty
    // answer would satisfy every size claim below for the wrong reason.
    expect(paged[0].json.tasks.length).toBe(100);
    expect(whole[0].json.tasks.length).toBeGreaterThan(SCALE_TASKS * 0.8);
    expect(paged[0].json.tasks.every((task: any) => 'blocked' in task && 'blockingTasks' in task)).toBe(true);
    expect(whole[0].json.tasks.every((task: any) => 'blocked' in task && 'blockingTasks' in task)).toBe(true);

    // THE MEASUREMENT. An order of magnitude is the claim; at this fixture it
    // is closer to fifty times.
    const wholeBytes = whole[0].bytes;
    const pagedBytes = paged[0].bytes;
    expect(wholeBytes).toBeGreaterThan(pagedBytes * 10);
    const wholeP95 = [...whole].sort((a, b) => a.ms - b.ms)[Math.floor(concurrency * 0.95)].ms;
    const pagedP95 = [...paged].sort((a, b) => a.ms - b.ms)[Math.floor(concurrency * 0.95)].ms;
    console.log(`[scale-load] response-size isolation ${JSON.stringify({ concurrency, wholeBytes, pagedBytes, wholeP95, pagedP95 })}`);
    // The cost tracks the size, not the route: the large form is materially
    // slower at the same concurrency through the same pool. A factor of two is
    // far inside what was measured (roughly fifteen times) and outside what
    // machine noise produces between two waves of twelve.
    expect(wholeP95).toBeGreaterThan(pagedP95 * 2);
  });
});

// ─────────── 3c · the acquisition deadline, measured deterministically ───────

describe('the connection acquisition deadline survives an event-loop stall', () => {
  test('acquisitions queued behind a full pool are not failed by a stall the product produces', async () => {
    // WHY THIS EXISTS. The five-path and focused batteries above measure the
    // deadline only as the machine happens to schedule them: the failure
    // depends on how long the event loop stalls, and on a quiet runner it may
    // not stall enough. A red proof that only sometimes goes red proves only
    // that it sometimes goes red — so the deadline gets a control that does not
    // depend on load at all.
    //
    // The stall is the one the product produces: serializing an unpaginated
    // whole-estate response blocks the loop for 0.5-0.9s at a time, measured,
    // and several land back to back under a concurrent mix. Here it is a
    // busy-wait of a fixed length, so the measurement is the same on every
    // machine.
    //
    // The pool under test is built from `databasePoolConfig` — the PRODUCTION
    // configuration OBJECT, not a copy of its numbers — so a change to the
    // shipped value changes what this test measures. At 2,000ms every queued
    // acquisition below is rejected; at 15,000ms none is.
    const STALL_MS = 2_500;
    const QUEUED = 5;

    const probe = new Pool(databasePoolConfig);
    try {
      // Fill the pool and HOLD it, so the acquisitions below can only be
      // served by a release — never by an idle connection.
      const held = await Promise.all(
        Array.from({ length: databasePoolConfig.max }, () => probe.connect()),
      );
      expect(held.length).toBe(databasePoolConfig.max);

      const queued = Array.from({ length: QUEUED }, () => probe.connect().then(
        (client: any) => ({ ok: true, client }),
        (err: unknown) => ({ ok: false, err }),
      ));

      // Block the loop. Nothing is released and no timer can run while this
      // runs — exactly what a large synchronous serialization does.
      const until = Date.now() + STALL_MS;
      // eslint-disable-next-line no-empty
      while (Date.now() < until) {}

      // Let the timers that came due during the stall actually fire, BEFORE
      // anything is released. This is the whole measurement: an acquisition
      // whose deadline elapsed during a stall is failed here, and the
      // connection it was waiting for is available a millisecond later.
      await new Promise((resolve) => setTimeout(resolve, 100));
      for (const client of held) client.release();

      const settled = await Promise.all(queued);
      const failures = settled.filter((outcome: any) => !outcome.ok);
      for (const outcome of settled as any[]) if (outcome.ok) outcome.client.release();

      expect({
        stallMs: STALL_MS,
        deadlineMs: databasePoolConfig.connectionTimeoutMillis,
        failed: failures.length,
      }).toEqual({
        stallMs: STALL_MS,
        deadlineMs: databasePoolConfig.connectionTimeoutMillis,
        failed: 0,
      });
      // …and the stall really was longer than nothing: a control that stalled
      // for zero milliseconds would pass at any deadline.
      expect(STALL_MS).toBeGreaterThan(2_000);
    } finally {
      await probe.end();
    }
  });
});

// ───────── 3d · the destructive fixture refuses a deployment database ────────

describe('the seed script refuses the database the pool would actually reach', () => {
  test('an absent DB_NAME is refused, because the pool resolves it to a deployment database', () => {
    // Round-1 REJECT, blocking finding 1, promoted from the reviewer's probe
    // into a control. The guard used to read `process.env.DB_NAME`, find the
    // empty string, and pass — while the pool resolved that same absent
    // variable to `relayhall_dev`. A destructive script that claims to refuse
    // deployment databases would have written thousands of rows into DEV
    // whenever it ran with no environment, which is how it would most likely
    // be run by accident.
    //
    // The case is set up as an EMPTY string rather than by deleting the key:
    // `dotenv` populates absent keys from a `.env` file and skips present
    // ones, so an empty value is the only way to pin what the pool resolves
    // regardless of what is on disk.
    const saved = { ...process.env };
    let refusal: Error | null = null;
    let accepted = false;
    let resolvedDatabase = '';
    try {
      process.env.DB_NAME = '';
      process.env.DB_HOST = '';
      // A fresh module registry, so `db/connection` re-reads the environment.
      // Constructing a Pool opens nothing — `pg` connects lazily — and nothing
      // below queries it.
      jest.isolateModules(() => {
        const { databasePoolConfig } = require('../db/connection');
        resolvedDatabase = String(databasePoolConfig.database ?? '');
        const { assertDisposableTarget } = require('../../scripts/seed-scale-fixture');
        try { assertDisposableTarget(); accepted = true; } catch (err) { refusal = err as Error; }
      });
    } finally {
      process.env = saved;
    }

    // The premise, measured rather than assumed: with no DB_NAME the pool
    // really does resolve to a deployment database. If this ever stops being
    // true the control below is testing nothing, so it is asserted first.
    expect(resolvedDatabase).toBe('relayhall_dev');
    expect(accepted).toBe(false);
    expect(String((refusal as unknown as Error)?.message)).toContain('deployment database');
  });

  test('a disposable local database is accepted, so the guard is not simply always refusing', () => {
    // The positive control. A guard that refused everything would pass the
    // test above and make the script useless.
    const saved = { ...process.env };
    let accepted = false;
    try {
      process.env.DB_NAME = 'relayhall_scale_guard_probe';
      process.env.DB_HOST = '127.0.0.1';
      jest.isolateModules(() => {
        const { assertDisposableTarget } = require('../../scripts/seed-scale-fixture');
        assertDisposableTarget();
        accepted = true;
      });
    } finally {
      process.env = saved;
    }
    expect(accepted).toBe(true);
  });
});

// ──────────────────────── 4 · the schema carries the indexes ─────────────────

describe('the child-table lookup indexes exist in the live schema', () => {
  test('task_links and task_dependencies can be looked up by the columns the reads filter on', async () => {
    const result = await pool.query(
      `SELECT tablename, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename IN ('task_links', 'task_dependencies')`,
    );
    const definitions: string[] = result.rows.map((row: any) => String(row.indexdef));

    // Asserted on the DEFINITION, not the index name: what matters is that a
    // btree leads with the filtered column, whatever a future migration calls
    // it. `task_dependencies_pkey` leads with `task_id`, so it satisfies the
    // first claim and cannot satisfy the second — which is the whole reason the
    // dependents direction was a sequential scan.
    const leadsWith = (table: string, column: string): boolean => result.rows.some((row: any) =>
      String(row.tablename) === table
      && /USING btree/.test(String(row.indexdef))
      && new RegExp(`\\(\\s*${column}\\b`).test(String(row.indexdef)));

    // Asserted SEPARATELY, one statement each: the drill drops these two
    // indexes as two different mutations, and two mutations that trip one line
    // prove one control rather than two.
    expect(leadsWith('task_links', 'task_id')).toBe(true);
    expect(leadsWith('task_dependencies', 'depends_on_task_id')).toBe(true);
    expect(definitions.length).toBeGreaterThan(0);
  });
});
