/**
 * 8491557e — A BURST OF AUTHENTICATED REQUESTS NEVER SPENDS THE POOL ON
 * BOOKKEEPING, AND NEVER ANSWERS 503 ON THE AUTHORIZATION PATH.
 *
 * The defect this gate exists for was found by LANE FIX-A while running the
 * list/point parity gate against a real PostgreSQL. `LoginSessionService.touch`
 * issued an UNAWAITED `UPDATE auth_sessions SET last_seen_at = now()` on every
 * authenticated request carrying a session cookie — the SAME ROW every time for
 * a given session. Concurrent UPDATEs of one row serialise on a tuple lock, and
 * each waiting statement holds a pooled connection while it waits. With
 * `max: 20` and `connectionTimeoutMillis: 2000`, a burst filled the pool with
 * bookkeeping writes that OUTLIVED their requests: `pg_stat_activity` showed
 * twenty backends on that one statement, nineteen waiting on `Lock: tuple`,
 * while unrelated requests answered 503 AUTHORIZATION_UNAVAILABLE and 500
 * DASHBOARD_SUMMARY_READ_FAILED, with the cause redacted by `logCaughtFailure`.
 *
 * ── WHY THIS GATE AND NOT A UNIT TEST ──
 *
 * `boundedPresenceWrites.test.ts` measures the writer's decisions and runs in
 * the default jest run. It cannot see the thing that actually broke: a tuple
 * lock is a property of PostgreSQL, a pooled connection is a property of `pg`,
 * and the 503 was produced by the real middleware chain. Every one of those is
 * mocked away in the default run, so this gate measures the behaviour — over a
 * REAL PostgreSQL, through the PRODUCTION router, with a real login session.
 *
 * ── THE PROPERTY, AND ITS OUTSIDE ANCHOR ──
 *
 * Under a burst of N concurrent authenticated requests from one session:
 *
 *   1. every response is 200 — no 503, no 500, no pool timeout;
 *   2. the number of backends PostgreSQL sees running the touch statement
 *      never exceeds the shipped bound;
 *   3. `last_seen_at` still ADVANCES.
 *
 * (2) is sampled from `pg_stat_activity` on a SEPARATE connection that is not
 * in the pool under test — the same instrument the defect was observed with,
 * asked of the database rather than of the process. A writer that reported its
 * own concurrency would be an oracle rebuilt inside the thing it measures.
 *
 * (3) is the VACUITY control, and it is the reason the gate is not satisfied by
 * a repair that simply stops writing. Deleting `touch` outright passes (1) and
 * (2) perfectly; it also silently converts every long-lived session into one
 * that idles out while in use. The bound must make the write CHEAP, not absent,
 * so the gate asserts the column moved — read back from the database, not from
 * the writer's counters.
 *
 * ── WHY IT IS NOT IN THE DEFAULT JEST RUN ──
 *
 * It connects to `RELAYHALL_TEST_DB_URL` and FAILS — never skips — when the
 * variable is unset, for the same reason the list/point parity gate does.
 * Excluded by `testPathIgnorePatterns`, run by `npm run test:touch-burst` on
 * the VM gate chain and UNCONDITIONALLY in CI against the `services: postgres`
 * block, with no `if:` guard.
 *
 * ── THE DESTRUCTIVE CONTRACT, STATED ──
 *
 * This suite WRITES to principals, projects, tasks and auth_sessions. It
 * refuses any URL naming a deployment database (`relayhall_dev`,
 * `relayhall_tst`, `relayhall_prod`, `relayhall`) and any non-local host. Bring
 * the database up with `database/init.sql` and `npm run migrate`, and throw it
 * away afterwards.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

// ─────────────────────────── the database contract ───────────────────────────

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error(
    'RELAYHALL_TEST_DB_URL is not set. This gate measures pool behaviour under a burst against a REAL '
    + 'PostgreSQL and refuses to skip: the contention under test is a tuple lock, and a mocked pool has '
    + 'neither locks nor connections. Create a disposable database, load database/init.sql, run '
    + 'npm run migrate, and set RELAYHALL_TEST_DB_URL to it.',
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
process.env.JWT_SECRET = process.env.JWT_SECRET || 'touch-burst-suite-secret-0123456789abcdef';
// The session plane is the caller shape the defect appears on.
process.env.RELAYHALL_SESSIONS = 'on';

const express = require('express');
const { Client } = require('pg');

const { pool, databasePoolConfig } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { presenceWriter, PRESENCE_MAX_IN_FLIGHT } = require('../db/boundedPresenceWrites');

jest.setTimeout(240_000);

// ──────────────────────────────── the app ────────────────────────────────────

let server: http.Server;
let origin: string;
/** Not in the pool under test: the instrument must not perturb what it measures. */
let observer: any;

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
 * Node's global `fetch` multiplexes over a small connection pool, which would
 * cap the CONCURRENCY this gate exists to create — the burst would arrive as a
 * queue and the defect would not reproduce. So the requests go through an
 * agent whose socket ceiling is above the burst size, and the burst is real.
 */
const agent = new http.Agent({ keepAlive: false, maxSockets: 512 });

interface Answer { status: number; body: string }

function call(cookie: string, path: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${origin}${path}`,
      { method: 'GET', agent, headers: { Cookie: cookie } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ────────────────────────────── the fixtures ─────────────────────────────────

const tag = (): string => crypto.randomBytes(6).toString('hex');

let ACCOUNT_ID: string;
let SESSION_ID: string;
let COOKIE: string;
let TASK_ID: string;

/** The statement whose convoy exhausted the pool. */
const TOUCH_STATEMENT = 'UPDATE auth_sessions SET last_seen_at';

/**
 * How many backends are running the touch statement RIGHT NOW, asked of
 * PostgreSQL rather than of the process under test.
 *
 * `state <> 'idle'` matters: `pg_stat_activity.query` holds the LAST statement
 * a backend ran, so an idle pooled connection still reports the touch it
 * finished with, and counting those would report a convoy that had already
 * dispersed.
 */
async function touchBackendsNow(): Promise<number> {
  const result = await observer.query(
    `SELECT count(*)::int AS n
       FROM pg_stat_activity
      WHERE datname = $1
        AND state <> 'idle'
        AND pid <> pg_backend_pid()
        AND query LIKE $2`,
    [TEST_DB_NAME, `%${TOUCH_STATEMENT}%`],
  );
  return Number(result.rows[0].n);
}

async function lastSeenAt(): Promise<Date> {
  const result = await pool.query('SELECT last_seen_at FROM auth_sessions WHERE id = $1', [SESSION_ID]);
  return new Date(result.rows[0].last_seen_at);
}

beforeAll(async () => {
  observer = new Client({ ...databasePoolConfig, max: undefined });
  await observer.connect();

  const account = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, 'touch burst account', 'active', 'admin') RETURNING id`,
    [`burst-human-${tag()}`],
  );
  ACCOUNT_ID = String(account.rows[0].id);

  const project = await pool.query(
    `INSERT INTO projects (name, status, visibility, owner_principal_id)
     VALUES ($1, 'active', 'private', $2) RETURNING id`,
    [`burst project ${tag()}`, ACCOUNT_ID],
  );
  const task = await pool.query(
    `INSERT INTO tasks (title, status, visibility, project_id, owner_principal_id,
                        creator_principal_id, shepherd_principal_id)
     VALUES ($1, 'todo', 'private', $2, $3, $3, $3) RETURNING id`,
    [`burst task ${tag()}`, String(project.rows[0].id), ACCOUNT_ID],
  );
  TASK_ID = String(task.rows[0].id);

  const minted = await loginSessionService.mint({ principalId: ACCOUNT_ID });
  SESSION_ID = minted.sessionId;
  COOKIE = `${SESSION_COOKIE_NAME}=${minted.token}`;

  const app = buildApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as { port: number };
  origin = `http://127.0.0.1:${address.port}`;

  // One warm-up request: the FIRST request of a session legitimately writes,
  // and the burst below is about what the SECOND through Nth do.
  const warmUp = await call(COOKIE, `/tasks/${TASK_ID}`);
  expect(warmUp.status).toBe(200);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  agent.destroy();
  if (observer) await observer.end();
  await pool.end();
});

// ─────────────────────────────── the burst ───────────────────────────────────

/**
 * Large enough to exceed the pool several times over — the convoy needs more
 * concurrent writers than the pool has connections before it can spend it.
 */
const BURST = 150;

interface BurstOutcome {
  answers: Answer[];
  peakTouchBackends: number;
  samples: number;
}

/** Fire the burst while sampling what PostgreSQL is doing. */
async function burst(paths: string[]): Promise<BurstOutcome> {
  let peak = 0;
  let samples = 0;
  let sampling = true;

  const sampler = (async () => {
    while (sampling) {
      try {
        const n = await touchBackendsNow();
        samples += 1;
        if (n > peak) peak = n;
      } catch {
        /* the observer losing a sample must not fail the gate it observes */
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  })();

  const answers = await Promise.all(paths.map((path) => call(COOKIE, path)));
  sampling = false;
  await sampler;
  return { answers, peakTouchBackends: peak, samples };
}

describe('a burst of authenticated requests from one session', () => {
  let outcome: BurstOutcome;
  let before: Date;
  let after: Date;
  let counters: any;

  beforeAll(async () => {
    presenceWriter.reset();
    before = await lastSeenAt();
    // Interleave the point route with the two surfaces the defect was observed
    // failing on, so the assertion covers the reported symptom and not only the
    // route that provokes it.
    const paths: string[] = [];
    for (let i = 0; i < BURST; i += 1) {
      paths.push(i % 5 === 0 ? '/dashboard/summary' : `/tasks/${TASK_ID}`);
    }
    outcome = await burst(paths);
    counters = presenceWriter.counters();
    // Let any in-flight bookkeeping land before the column is read back.
    await new Promise((r) => setTimeout(r, 500));
    after = await lastSeenAt();
  });

  it('answers every request — no 503 on the authorization path, no 500', () => {
    const bad = outcome.answers
      .map((a, i) => ({ i, status: a.status, body: a.body.slice(0, 200) }))
      .filter((a) => a.status !== 200);
    expect(bad).toEqual([]);
    expect(outcome.answers).toHaveLength(BURST);
  });

  it('never exceeds the shipped bound on backends running the bookkeeping write', () => {
    // Measured from pg_stat_activity on a connection outside the pool.
    expect(outcome.samples).toBeGreaterThan(0);
    expect(outcome.peakTouchBackends).toBeLessThanOrEqual(PRESENCE_MAX_IN_FLIGHT);
  });

  it('never lets bookkeeping approach the pool it shares', () => {
    expect(outcome.peakTouchBackends).toBeLessThan(Number(databasePoolConfig.max));
    expect(counters.peakInFlight).toBeLessThanOrEqual(PRESENCE_MAX_IN_FLIGHT);
  });

  it('coalesces the burst into a handful of writes', () => {
    // At LEAST one bookkeeping offer per request - and in fact more, because
    // the guard chain runs once per MOUNTED ROUTER and routeRegistry mounts
    // /tasks twice (tasksBatchRoutes ahead of tasksRoutes, so /tasks/batch
    // matches before /tasks/:id). That is worth stating rather than rounding
    // away: unbounded, a point-route request issued TWO of these writes, so
    // the convoy the card measured built about twice as fast as "one write per
    // request" would suggest.
    expect(counters.submitted).toBeGreaterThanOrEqual(BURST);
    // The property under test: NOT per request. One session inside one window
    // reaches the database a handful of times at most, however many times the
    // write was offered. Stated as a bound rather than an exact count, because
    // an exact count would pin the scheduler rather than the behaviour.
    expect(counters.started).toBeLessThanOrEqual(4);
    expect(counters.started * 20).toBeLessThan(counters.submitted);
  });

  it('still advances last_seen_at — the bound makes the write cheap, not absent', () => {
    // The vacuity control. Deleting `touch` passes every assertion above.
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('never moves last_seen_at backwards across a second burst', async () => {
    const middle = await lastSeenAt();
    // Past the coalescing window, so the second burst is entitled to write.
    presenceWriter.reset();
    const second = await burst(new Array(BURST).fill(`/tasks/${TASK_ID}`));
    expect(second.answers.filter((a) => a.status !== 200)).toEqual([]);
    expect(second.peakTouchBackends).toBeLessThanOrEqual(PRESENCE_MAX_IN_FLIGHT);
    await new Promise((r) => setTimeout(r, 500));
    const end = await lastSeenAt();
    expect(end.getTime()).toBeGreaterThanOrEqual(middle.getTime());
  });
});
