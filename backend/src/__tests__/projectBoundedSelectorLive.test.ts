/**
 * RH-AZ.PROJ-b (card 95572530) — THE PROJECT-BOUNDED SELECTOR FORM, LIVE.
 *
 * The unit suite `projectBoundedSelectorForm.test.ts` proves what a string and
 * a pure function can carry honestly. It cannot prove the one thing that
 * matters about a selector form: that the SQL it composes selects the right
 * ROWS. There is no PostgreSQL in the default jest run, and a suite that
 * modelled the database would be a model that can be edited into agreeing with
 * a broken predicate.
 *
 * So this gate measures the behaviour, over a REAL PostgreSQL, through the
 * PRODUCTION router, with two authenticated principals — and it takes its
 * EXPECTED SETS from `GET /tasks/:id`, the same outside anchor
 * `listPointParity.test.ts` uses. Nothing here recomputes the authorization
 * rule; both sides are measured.
 *
 * ── THE FIVE PROPERTIES ────────────────────────────────────────────────────
 *
 *  1 BOUNDED    an `all-in-project` rule over Project ALPHA reaches exactly
 *               the Tasks in ALPHA — never one in BETA. That is the whole
 *               claim: `all-of-type` would have reached both.
 *  2 FUTURE-INCLUSIVE INSIDE the perimeter: a Task created in ALPHA AFTER the
 *               version was published and assigned is reachable with no
 *               profile change. That is what makes the form more than a long
 *               `exact` list.
 *  3 CLOSED OUTSIDE it: a Task created in BETA after publication is not.
 *  4 NO WIDENING the second principal's readable set is IDENTICAL before and
 *               after the first principal's project-bounded profile exists,
 *               and a third principal with no profile reads nothing at all
 *               throughout. A new selector form must not move authority that
 *               was not written in terms of it.
 *  5 LIST/POINT PARITY the list surfaces return exactly the ids the point
 *               route allows, for both principals. The arm is composed in ONE
 *               place; this is the assertion that says so behaviourally rather
 *               than by reading the source.
 *
 * ── AND THE TWO CLOSURES, DRILLED SEPARATELY ───────────────────────────────
 *
 *  6 THE WRITE CLOSURE IN SQL: migration 125's
 *    `access_profile_rules_project_bounded_types` refuses an inadmissible row
 *    to a caller writing RAW SQL, bypassing every validator. This is the half
 *    AZ-A5 could not reach for `surface`, and it is drilled by trying it.
 *  7 THE EVALUATOR CLOSURE, with the SQL half REMOVED: the constraint is
 *    dropped, the inadmissible row is inserted, and the decision is required to
 *    be byte-identical — because `renderAuthoritySeam` rendered that arm as
 *    `FALSE` for a shape with no project coordinate. Either half may be
 *    removed without the other failing; that is what makes them two halves and
 *    not one control counted twice (the AZ-A5 annex 85a2218d D3 pattern).
 *
 * ── WHY IT IS NOT IN THE DEFAULT JEST RUN ──────────────────────────────────
 *
 * It connects to `RELAYHALL_TEST_DB_URL` and FAILS — never skips — when the
 * variable is unset. Excluded by `testPathIgnorePatterns`, run by
 * `npm run test:project-bounded` on the VM gate chain and UNCONDITIONALLY in
 * CI against the `services: postgres` block, with no `if:` guard.
 *
 * ── THE DESTRUCTIVE CONTRACT, STATED ───────────────────────────────────────
 *
 * This suite WRITES to principals, projects, tasks, reports, access_profiles,
 * access_profile_versions, access_profile_rules, access_profile_assignments
 * and auth_sessions, and it DROPS AND RESTORES one CHECK constraint. It
 * refuses any URL naming a deployment database (`relayhall_dev`,
 * `relayhall_tst`, `relayhall_prod`, `relayhall`). Bring the database up with
 * `database/init.sql` and `npm run migrate`, and throw it away afterwards.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

// ─────────────────────────── the database contract ───────────────────────────

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error(
    'RELAYHALL_TEST_DB_URL is not set. This gate measures which ROWS a project-bounded selector reaches, '
    + 'against a REAL PostgreSQL, and refuses to skip: the predicate under test is SQL, and a mocked pool '
    + 'can only replay the rule. Create a disposable database, load database/init.sql, run npm run migrate, '
    + 'and set RELAYHALL_TEST_DB_URL to it.',
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
process.env.JWT_SECRET = process.env.JWT_SECRET || 'project-bounded-suite-secret-0123456789abcdef';
process.env.RELAYHALL_SESSIONS = 'on';

const express = require('express');

const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { accessProfileService, assertProjectBoundedSelectors } = require('../services/AccessProfileService');

jest.setTimeout(240_000);

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
interface Caller { label: string; principalId: string; headers: Record<string, string> }

async function call(who: Caller, method: string, routePath: string): Promise<Answer> {
  const response = await fetch(`${origin}${routePath}`, {
    method, headers: { 'Content-Type': 'application/json', ...who.headers },
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json };
}

// ────────────────────────────── the fixtures ─────────────────────────────────

const SYSTEM_ACTOR = { principalId: null, handle: 'project-bounded-suite', authMethod: 'system' as const };
const tag = (): string => crypto.randomBytes(6).toString('hex');

let ROOT_PRINCIPAL: string;
let ROOT: Caller;

/** The two perimeters. Both PRIVATE, so no fixture is reachable through the
 *  inherited-visibility arm and every authorized read below has exactly one
 *  named cause: the profile rule under test. */
let ALPHA: string;
let BETA: string;

/** The principal whose profile carries the project-bounded rule. */
let BOUNDED: Caller;
/** The control principal: an `exact` rule over one BETA Task. Its readable set
 *  must be identical before and after BOUNDED's profile exists. */
let PINNED: Caller;
/** The vacuity control: same scopes, same role, no profile at all. If this
 *  principal ever reads a fixture, some other arm is firing and every
 *  assertion in this file is measuring the wrong thing. */
let STRANGER: Caller;

interface Fixture { id: string; label: string; project: 'alpha' | 'beta' }
const FIXTURES: Fixture[] = [];
const idsOf = (rows: Fixture[]): string[] => rows.map((row) => row.id).sort();
const inProject = (which: 'alpha' | 'beta'): Fixture[] => FIXTURES.filter((f) => f.project === which);

async function makeAccount(role: string): Promise<string> {
  const handle = `pbsel-${role}-${tag()}`;
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $2, 'active', $3) RETURNING id`,
    [handle, `project-bounded ${handle}`, role],
  );
  return String(result.rows[0].id);
}

async function sessionCallerFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

async function makeProject(name: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO projects (name, status, visibility, owner_principal_id)
     VALUES ($1, 'active', 'private', $2) RETURNING id`,
    [name, ROOT_PRINCIPAL],
  );
  return String(result.rows[0].id);
}

async function makeTask(label: string, which: 'alpha' | 'beta'): Promise<Fixture> {
  const result = await pool.query(
    `INSERT INTO tasks (title, status, visibility, project_id, owner_principal_id,
                        creator_principal_id, shepherd_principal_id)
     VALUES ($1, 'todo', 'private', $2, NULL, $3, $3) RETURNING id`,
    // Creator and shepherd are ROOT throughout, and there is no owner, so no
    // fixture is readable by accident through a task-role or initiator arm.
    [`pbsel ${label}`, which === 'alpha' ? ALPHA : BETA, ROOT_PRINCIPAL],
  );
  const fixture: Fixture = { id: String(result.rows[0].id), label, project: which };
  FIXTURES.push(fixture);
  return fixture;
}

/** Publish one version of a fresh profile and assign it to one principal. */
async function profileFor(principalId: string, name: string, rules: unknown[]): Promise<string> {
  const profile = await accessProfileService.create({ name: `${name} ${tag()}` }, SYSTEM_ACTOR);
  const version = await accessProfileService.createVersion(profile.id, rules, SYSTEM_ACTOR);
  await accessProfileService.publish(profile.id, version.id, SYSTEM_ACTOR);
  await accessProfileService.assign(
    profile.id, { assigneeType: 'principal', assigneeId: principalId }, SYSTEM_ACTOR);
  return profile.id;
}

// ────────────────────── the point route: the outside anchor ──────────────────

/**
 * What `GET /tasks/:id` allows this caller, measured one request per fixture.
 *
 * Deliberately NOT cached: this suite changes authority mid-run (it publishes a
 * profile between measurements) and adds fixtures after publication, which is
 * exactly the case `listPointParity`'s cache documents itself as unable to
 * notice. Re-sweeping is cheaper than reasoning about whether it mattered.
 */
async function pointAllowed(who: Caller): Promise<Fixture[]> {
  const allowed: Fixture[] = [];
  for (const fixture of FIXTURES) {
    const answer = await call(who, 'GET', `/tasks/${fixture.id}`);
    if (answer.status === 200) allowed.push(fixture);
    else expect([403, 404]).toContain(answer.status);
  }
  return allowed;
}

/**
 * The ids one list surface returns, narrowed to this run's fixtures.
 *
 * `GET /tasks` answers rows; `GET /tasks/ids` answers a bare `ids` array of
 * strings and returns EMPTY unless `statuses` is given. The first version of
 * this helper knew only the row shape, so `/tasks/ids` read as "returned
 * nothing" and the parity assertion went red against a route that was
 * answering correctly. A harness that cannot read a surface's answer reports a
 * defect in the surface, which is the most expensive kind of harness bug.
 */
async function listed(who: Caller, path: string): Promise<string[]> {
  const answer = await call(who, 'GET', path);
  expect(answer.status).toBe(200);
  const body = answer.json ?? {};
  const mine = new Set(FIXTURES.map((f) => f.id));
  if (Array.isArray(body.ids)) {
    return body.ids.map(String).filter((id: string) => mine.has(id)).sort();
  }
  const rows: any[] = Array.isArray(body.tasks) ? body.tasks
    : Array.isArray(body.data) ? body.data
      : Array.isArray(body.items) ? body.items : [];
  // A surface whose answer this helper cannot read must FAIL, never read as an
  // empty set: an unparsed body and a refused one are not the same thing.
  expect(Array.isArray(body.tasks) || Array.isArray(body.data) || Array.isArray(body.items))
    .toBe(true);
  return rows.map((row) => String(row.id)).filter((id) => mine.has(id)).sort();
}

// ─────────────────────────────── the fixtures ────────────────────────────────

/** Measured BEFORE any profile exists, so property 4 is a comparison against a
 *  number this suite watched rather than one it assumed. */
let PINNED_BASELINE: string[];

beforeAll(async () => {
  await new Promise<void>((resolve) => { server = buildApp().listen(0, resolve); });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;

  ROOT_PRINCIPAL = await makeAccount('admin');
  ROOT = await sessionCallerFor('root', ROOT_PRINCIPAL);

  ALPHA = await makeProject(`pbsel-alpha-${tag()}`);
  BETA = await makeProject(`pbsel-beta-${tag()}`);

  await makeTask('alpha-1', 'alpha');
  await makeTask('alpha-2', 'alpha');
  const beta1 = await makeTask('beta-1', 'beta');

  // Three callers of the SAME shape — human Account, role `user`, session
  // cookie, no grants — so the only thing that ever differs between them is
  // which profile rule they carry.
  BOUNDED = await sessionCallerFor('bounded', await makeAccount('user'));
  PINNED = await sessionCallerFor('pinned', await makeAccount('user'));
  STRANGER = await sessionCallerFor('stranger', await makeAccount('user'));

  // The control principal's authority is written FIRST and never touched
  // again, so property 4 compares like with like.
  await profileFor(PINNED.principalId, 'pbsel pinned',
    [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [beta1.id], verbs: ['read'] }]);
  PINNED_BASELINE = idsOf(await pointAllowed(PINNED));
});

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  await pool.end();
});

// ═══════════════════════════════════════════════════════════════════════════
// 0 · VACUITY — the fixtures exist and nothing else can explain a read
// ═══════════════════════════════════════════════════════════════════════════

describe('0 · the fixtures are real and the arms are otherwise silent', () => {
  it('root reads every fixture, so a refusal below is a refusal and not a 404', async () => {
    // Without this, a suite that mistyped an id would report "refused" for
    // every caller and pass every narrowing assertion it makes.
    expect(idsOf(await pointAllowed(ROOT))).toEqual(idsOf(FIXTURES));
  });

  it('a principal with no profile reads NOTHING, before or after', async () => {
    expect(await pointAllowed(STRANGER)).toEqual([]);
  });

  it('the pinned control reads exactly its one pinned Task', async () => {
    expect(PINNED_BASELINE).toEqual([inProject('beta')[0].id]);
  });

  it('the bounded principal reads nothing YET — its profile does not exist', async () => {
    expect(await pointAllowed(BOUNDED)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1-3 · THE PERIMETER: bounded, future-inclusive inside, closed outside
// ═══════════════════════════════════════════════════════════════════════════

describe('1-3 · an all-in-project rule reaches its perimeter and stops at its edge', () => {
  it('reaches every Task in the named Project and NO Task outside it', async () => {
    await profileFor(BOUNDED.principalId, 'pbsel bounded', [
      { resourceType: 'task', selectorForm: 'all-in-project', selectorIds: [ALPHA], verbs: ['read'] },
    ]);
    // The expected set is read back from `GET /tasks/:id`, never recomputed
    // from the rule. `all-of-type` — the only pre-125 way to express
    // future-inclusive Task authority — would have returned all three.
    expect(idsOf(await pointAllowed(BOUNDED))).toEqual(idsOf(inProject('alpha')));
    expect(idsOf(await pointAllowed(BOUNDED))).not.toContain(inProject('beta')[0].id);
  });

  it('reaches a Task created in the perimeter AFTER publication, with no profile change', async () => {
    // The property that separates this form from a long `exact` list. Nothing
    // is republished, reassigned or recompiled between these two lines: the
    // evaluator joins the live rows.
    const before = idsOf(await pointAllowed(BOUNDED));
    const late = await makeTask('alpha-3-created-late', 'alpha');
    const after = idsOf(await pointAllowed(BOUNDED));
    expect(after).toEqual([...before, late.id].sort());
  });

  it('does NOT reach a Task created OUTSIDE the perimeter after publication', async () => {
    // The mirror, and the reason the form is a narrowing: future-inclusive
    // INSIDE the perimeter, closed outside it.
    const late = await makeTask('beta-2-created-late', 'beta');
    expect(idsOf(await pointAllowed(BOUNDED))).not.toContain(late.id);
    expect(idsOf(await pointAllowed(BOUNDED))).toEqual(idsOf(inProject('alpha')));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · NO WIDENING
// ═══════════════════════════════════════════════════════════════════════════

describe('4 · nothing that was not written in terms of the new form moved', () => {
  it('the pinned principal reads exactly what it read before the new form existed', async () => {
    // Two Tasks have been created and one profile published since
    // PINNED_BASELINE was measured. Its authority is an `exact` list of one id,
    // and it must still be that.
    expect(idsOf(await pointAllowed(PINNED))).toEqual(PINNED_BASELINE);
  });

  it('the principal with no profile still reads nothing', async () => {
    expect(await pointAllowed(STRANGER)).toEqual([]);
  });

  it('root still reads everything, including the Tasks created late', async () => {
    expect(idsOf(await pointAllowed(ROOT))).toEqual(idsOf(FIXTURES));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · LIST/POINT PARITY — the arm is composed in ONE place
// ═══════════════════════════════════════════════════════════════════════════

describe('5 · every list surface answers what the point route answers', () => {
  const STATUSES = ['ideas', 'todo', 'in-progress', 'stuck', 'completed'].join(',');
  const SURFACES = ['/tasks?limit=200', `/tasks/ids?statuses=${STATUSES}`];

  it('holds for the bounded principal and for the pinned control', async () => {
    for (const who of [BOUNDED, PINNED, STRANGER]) {
      const expected = idsOf(await pointAllowed(who));
      for (const surface of SURFACES) {
        expect({ caller: who.label, surface, ids: await listed(who, surface) })
          .toEqual({ caller: who.label, surface, ids: expected });
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6-7 · THE TWO CLOSURES, EACH REMOVABLE WITHOUT THE OTHER FAILING
// ═══════════════════════════════════════════════════════════════════════════

describe('6 · the write closure, in SQL, against a caller who bypasses every validator', () => {
  it('refuses an all-in-project rule on a resource type with no project coordinate', async () => {
    const version = await pool.query(
      `SELECT id FROM access_profile_versions ORDER BY created_at DESC LIMIT 1`,
    );
    await expect(pool.query(
      `INSERT INTO access_profile_rules (version_id, resource_type, selector_form, selector_ids, verbs)
       VALUES ($1, 'report', 'all-in-project', ARRAY[$2]::uuid[], ARRAY['read'])`,
      [version.rows[0].id, ALPHA],
    )).rejects.toThrow(/access_profile_rules_project_bounded_types/);
  });

  it('refuses an all-in-project rule with an EMPTY perimeter', async () => {
    // An empty perimeter is `all-of-type` under another name, and the shape
    // CHECK says so in SQL rather than only in the validator.
    const version = await pool.query(
      `SELECT id FROM access_profile_versions ORDER BY created_at DESC LIMIT 1`,
    );
    await expect(pool.query(
      `INSERT INTO access_profile_rules (version_id, resource_type, selector_form, selector_ids, verbs)
       VALUES ($1, 'task', 'all-in-project', '{}', ARRAY['read'])`,
      [version.rows[0].id],
    )).rejects.toThrow(/access_profile_rules_selector_shape/);
  });

  it('still accepts the form on a type that DOES carry a project coordinate', async () => {
    // The positive control on the same constraint: it is not a rule that
    // refuses every project-bounded row.
    const version = await pool.query(
      `SELECT id FROM access_profile_versions ORDER BY created_at DESC LIMIT 1`,
    );
    await expect(pool.query(
      `INSERT INTO access_profile_rules (version_id, resource_type, selector_form, selector_ids, verbs)
       VALUES ($1, 'phase', 'all-in-project', ARRAY[$2]::uuid[], ARRAY['read'])
       RETURNING id`,
      [version.rows[0].id, ALPHA],
    )).resolves.toBeTruthy();
  });
});

describe('8 · the project-existence check holds a lock, measured by blocking a delete', () => {
  /**
   * ROUND-1 REVIEW F3. `assertProjectBoundedSelectors` ran an ordinary SELECT,
   * and the call sites claimed that sharing the version's transaction stopped a
   * Project being deleted between the check and the write. Under READ COMMITTED
   * it does not, and `selector_ids` is a UUID ARRAY so no foreign key catches it
   * either. The repair is `FOR KEY SHARE`.
   *
   * A lock is a claim about what OTHER sessions cannot do, so it is measured
   * from another session: the validator runs on an open transaction, and a
   * DELETE of the same Project from the pool must BLOCK. `statement_timeout`
   * turns "blocks forever" into a bounded, observable `57014`.
   *
   * The controls that stop this passing vacuously:
   *   - a DIFFERENT Project deletes freely while the lock is held, so the
   *     timeout is the lock and not a table-wide stall or a slow database;
   *   - after ROLLBACK the SAME delete succeeds, so the timeout was the lock
   *     and not something permanent about that row.
   */
  const LOCK_PROBE_MS = 1200;

  /** A Project with nothing pointing at it, so a DELETE can only be stopped by
   *  a lock and never by a foreign key. */
  async function emptyProject(): Promise<string> {
    const result = await pool.query(
      `INSERT INTO projects (name, status, visibility, owner_principal_id)
       VALUES ($1, 'active', 'private', $2) RETURNING id`,
      [`pbsel-lockprobe-${tag()}`, ROOT_PRINCIPAL],
    );
    return String(result.rows[0].id);
  }

  async function deleteWithTimeout(projectId: string): Promise<'deleted' | 'blocked'> {
    const probe = await pool.connect();
    try {
      await probe.query('BEGIN');
      await probe.query(`SET LOCAL statement_timeout = ${LOCK_PROBE_MS}`);
      await probe.query('DELETE FROM projects WHERE id = $1', [projectId]);
      await probe.query('COMMIT');
      return 'deleted';
    } catch (error: any) {
      await probe.query('ROLLBACK').catch(() => undefined);
      // 57014 = query_canceled, which under SET LOCAL statement_timeout on a
      // DELETE of one row by primary key means it waited on a lock.
      if (error?.code === '57014') return 'blocked';
      throw error;
    } finally {
      probe.release();
    }
  }

  it('blocks a concurrent DELETE of a named Project until the version commits', async () => {
    const locked = await emptyProject();
    const untouched = await emptyProject();

    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      // The PRODUCTION validator, on this open transaction — not a hand-written
      // SELECT that merely resembles it.
      await assertProjectBoundedSelectors(
        [{ resourceType: 'task', selectorForm: 'all-in-project', selectorIds: [locked], verbs: ['read'] }],
        holder,
      );

      expect(await deleteWithTimeout(locked)).toBe('blocked');
      // NEGATIVE CONTROL: a Project the validator did not name is untouched, so
      // what blocked above is this row's lock and not a stalled database.
      expect(await deleteWithTimeout(untouched)).toBe('deleted');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }

    // …and the lock was released with the transaction: the same delete that
    // timed out a moment ago now succeeds.
    expect(await deleteWithTimeout(locked)).toBe('deleted');
  });

  it('takes no lock, and no query at all, when no rule is project-bounded', async () => {
    // The lock is scoped to the rules that need it: an ordinary profile version
    // must not start locking Project rows because this validator exists.
    const free = await emptyProject();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await assertProjectBoundedSelectors(
        [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [free], verbs: ['read'] }],
        holder,
      );
      expect(await deleteWithTimeout(free)).toBe('deleted');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });
});

describe('7 · the evaluator closure, with the SQL half REMOVED', () => {
  /**
   * The two halves are independent or they are one control counted twice.
   * Here the CHECK is dropped, the row it would have refused is written, and
   * the decision is required to be unchanged — because `renderAuthoritySeam`
   * renders the project-bounded arm as the literal `FALSE` for a resource
   * shape that declares no project coordinate.
   *
   * ── WHY IT RUNS ON AN OPEN TRANSACTION (live-drill finding F3) ──
   *
   * The first version dropped the constraint on the pool, inserted the row,
   * measured through the router, and put both back in a `finally`. It could
   * not: `access_profile_rules` carries `trg_apr_immutable`, an AZ-11 trigger
   * that refuses UPDATE and DELETE, so the smuggled row cannot be removed —
   * and with it still present, restoring the CHECK fails too. A drill that
   * cannot undo itself leaves the database it measured in a state it did not
   * describe.
   *
   * PostgreSQL makes DDL transactional, so BEGIN → DROP CONSTRAINT → INSERT →
   * measure → ROLLBACK leaves nothing behind, trigger included. The production
   * predicate accepts an open transaction as its `queryable` for exactly this
   * reason (RH-P3.AZ-S7): it is the shipped `authorizedIds`, never a copy.
   *
   * ── WHAT THE SEAM ANCHOR IS FOR ──
   *
   * A direct call proves nothing about the route that feeds it, so the first
   * assertion below requires `authorizedIds` on the POOL to return exactly
   * what `GET /tasks/:id` returned for the same caller. That equality is what
   * makes the hand-built actor a faithful stand-in for the middleware's; the
   * transaction assertions are then statements about the surface sections 1-5
   * measured, not about a function called in isolation.
   */
  const { authorizationRepository } = require('../services/AuthorizationRepository');

  const actorFor = (who: Caller) => ({
    principalId: who.principalId,
    handle: who.label,
    role: 'user',
    scopes: ['tasks:read', 'reports:read'],
    authenticated: true,
  });

  it('the direct predicate answers exactly what the point route answers', async () => {
    const throughRouter = idsOf(await pointAllowed(BOUNDED));
    const direct = await authorizationRepository.authorizedIds(
      actorFor(BOUNDED), 'task', FIXTURES.map((f) => f.id), 'read');
    expect([...direct].sort()).toEqual(throughRouter);
  });

  it('a report rule of the project-bounded form, smuggled past the CHECK, changes no decision', async () => {
    const report = await pool.query(
      `INSERT INTO reports (title, content, author, author_actor_id, author_principal_id, visibility)
       VALUES ($1, 'pbsel probe', 'pbsel', 'pbsel', $2, 'private') RETURNING id`,
      [`pbsel report ${tag()}`, ROOT_PRINCIPAL],
    );
    const reportId = String(report.rows[0].id);

    const version = await pool.query(
      `SELECT ap.published_version_id AS id
         FROM access_profile_assignments apa
         JOIN access_profiles ap ON ap.id = apa.profile_id
        WHERE apa.assignee_id = $1 LIMIT 1`,
      [BOUNDED.principalId],
    );
    expect(version.rows).toHaveLength(1);

    const actor = actorFor(BOUNDED);
    const taskIds = FIXTURES.map((f) => f.id);
    const expectedTasks = idsOf(inProject('alpha'));

    // The committed state, for comparison. The caller reaches its perimeter
    // and does not reach the Report.
    const reportsBefore = await authorizationRepository.authorizedIds(actor, 'report', [reportId], 'read');
    expect([...reportsBefore]).toEqual([]);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'ALTER TABLE access_profile_rules DROP CONSTRAINT access_profile_rules_project_bounded_types',
      );
      await client.query(
        `INSERT INTO access_profile_rules (version_id, resource_type, selector_form, selector_ids, verbs)
         VALUES ($1, 'report', 'all-in-project', ARRAY[$2]::uuid[], ARRAY['read'])`,
        [version.rows[0].id, ALPHA],
      );
      // POSITIVE CONTROL on the smuggling itself: the row really is there, on
      // this caller's published version, and the transaction can see it. A
      // drill whose bad state never landed proves nothing.
      const landed = await client.query(
        `SELECT 1 FROM access_profile_rules
          WHERE version_id = $1 AND resource_type = 'report' AND selector_form = 'all-in-project'`,
        [version.rows[0].id],
      );
      expect(landed.rows).toHaveLength(1);

      // …and the evaluator ignores it, on the same open transaction.
      const reportsAfter = await authorizationRepository.authorizedIds(
        actor, 'report', [reportId], 'read', client);
      expect([...reportsAfter]).toEqual([]);
      // The Task side is untouched by the smuggled row: still exactly ALPHA.
      const tasksAfter = await authorizationRepository.authorizedIds(
        actor, 'task', taskIds, 'read', client);
      expect([...tasksAfter].sort()).toEqual(expectedTasks);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }

    // ROLLBACK restored the constraint, trigger and all: the same INSERT is
    // refused again on the pool.
    await expect(pool.query(
      `INSERT INTO access_profile_rules (version_id, resource_type, selector_form, selector_ids, verbs)
       VALUES ($1, 'report', 'all-in-project', ARRAY[$2]::uuid[], ARRAY['read'])`,
      [version.rows[0].id, ALPHA],
    )).rejects.toThrow(/access_profile_rules_project_bounded_types/);
  });
});
