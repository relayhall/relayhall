/**
 * 9c3a1aa4 — WHAT CREATE ACCEPTS, CREATE STORES; AND A FIELD IS NOT A HOLE.
 *
 * The card: a `notes` value in a `POST /tasks` body was accepted with 201 and
 * never persisted. The route destructured it, the payload carried it into
 * `TaskManagerDB.createTask`, and the INSERT never named the column. Nothing
 * failed; the seeder that found it had to follow every create with a PATCH.
 *
 * A test that only asserted "create stores notes" would pass against a repair
 * that special-cases one field in one INSERT, which is the shape that produced
 * the defect. So this gate measures the PROPERTY the repair is for:
 *
 *   for every Task body field both write surfaces accept, what POST /tasks
 *   stores and what PATCH /tasks/{id} stores are the same value, and a value
 *   either surface refuses the other refuses with the same code
 *
 * measured through production routes and compared both with point-route reads
 * and literal expected values. Comparing create only with update is not enough:
 * the round-1 reviewer showed both surfaces could be corrupted identically.
 *
 * ── AND THE FIELD IS NOT A HOLE ──
 *
 * A new field on a write route is a new place for authorization to be absent.
 * Both halves are measured with TWO principals against the same rows: an owner
 * who may read and write the Task, and an outsider who may not. The outsider
 * must not READ the field, must not ALTER it, and must not learn from the
 * refusal that the Task exists at all. Non-vacuity is asserted beside it: the
 * owner still reads and still writes, because a product that refused everyone
 * would satisfy every refusal assertion above.
 *
 * ── WHY IT IS NOT IN THE DEFAULT JEST RUN ──
 *
 * It connects to `RELAYHALL_TEST_DB_URL` and FAILS — never skips — when the
 * variable is unset. What is under test is a column that was missing from an
 * INSERT and an authorization predicate that is SQL; every DB-shaped suite in
 * the default run mocks the pool, and a mocked pool replays whatever the code
 * asks it for, including an INSERT that names no notes column. Excluded by
 * `testPathIgnorePatterns`, run by `npm run test:task-write-fields` and
 * UNCONDITIONALLY in CI against the `services: postgres` block.
 *
 * ── THE DESTRUCTIVE CONTRACT, STATED ──
 *
 * This suite WRITES to principals, projects and tasks. It refuses any URL
 * naming a deployment database (`relayhall_dev`, `relayhall_tst`,
 * `relayhall_prod`, `relayhall`). Bring the database up with
 * `database/init.sql` and `npm run migrate`, and throw it away afterwards.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

// ─────────────────────────── the database contract ───────────────────────────

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error(
    'RELAYHALL_TEST_DB_URL is not set. This gate measures what a Task write surface STORES and who may '
    + 'read it, against a REAL PostgreSQL. It refuses to skip: the defect it exists for was a column '
    + 'missing from an INSERT, which a mocked pool cannot notice. Create a disposable database, load '
    + 'database/init.sql, run npm run migrate, and set RELAYHALL_TEST_DB_URL to it.',
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
process.env.JWT_SECRET = process.env.JWT_SECRET || 'task-write-field-suite-secret-0123456789abcdef';
process.env.RELAYHALL_SESSIONS = 'on';

const express = require('express');

const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
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

interface Answer { status: number; json: any; raw: string }

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
  const raw = await response.text();
  let json: any = null;
  try { json = JSON.parse(raw); } catch { json = null; }
  return { status: response.status, json, raw };
}

// ────────────────────────────── the fixtures ─────────────────────────────────

const tag = (): string => crypto.randomBytes(6).toString('hex');

/** Owns the Project and the Tasks below. */
let OWNER: Caller;
/** A signed-in human Account that owns nothing here. */
let OUTSIDER: Caller;
let OWNER_PROJECT: string;

async function makeAccount(role: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $2, 'active', $3) RETURNING id`,
    [`fieldsuite-${tag()}`, 'task write field suite account', role],
  );
  return String(result.rows[0].id);
}

async function sessionCallerFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

/** A private Project, so the Tasks under it are the outsider's blind spot. */
async function makeProject(owner: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO projects (name, status, visibility, owner_principal_id)
     VALUES ($1, 'active', 'private', $2) RETURNING id`,
    [`field suite ${tag()}`, owner],
  );
  return String(result.rows[0].id);
}

/**
 * Create through the ROUTE, not through SQL — the route is what is on trial.
 *
 * Armed and in `todo` so the creator can then CLAIM it. Write authority over a
 * Task is the claimant arm (`AuthorizationService`: the Shepherd and the
 * creator receive `read`, the Assignee receives `write`), so a suite that
 * creates a Task and immediately PATCHes it is answered 403 unless the caller
 * claims first. That is the product's rule, not this file's, and the claim
 * runs through `POST /tasks/{id}/claim` for the same reason everything else
 * here does.
 */
async function createTask(who: Caller, body: Record<string, unknown>): Promise<Answer> {
  return call(who, 'POST', '/tasks', {
    title: `field suite ${tag()}`,
    project: OWNER_PROJECT,
    status: 'todo',
    autoStart: true,
    ...body,
  });
}

/**
 * Create, then make the creator the Task's ASSIGNEE.
 *
 * Write authority over a Task is the CLAIMANT arm and nothing else short of a
 * grant or an administrator role: `AuthorizationService` gives the Shepherd
 * and the creator `read`, and gives `write` to `tasks.owner_principal_id`.
 * That is the product's rule and this suite does not argue with it — it just
 * has to put the authorized caller on the authorized side of it before it can
 * measure what a WRITE does.
 *
 * The assignment is a direct row write rather than `POST /tasks/{id}/claim`
 * because the claim VERB carries the same authority requirement, so claiming
 * is not a way in for a caller that is not already the Assignee. What is on
 * trial here is the create and update body handling, not the claim protocol,
 * and every act that IS on trial goes through its production route.
 */
async function createAssigned(who: Caller, body: Record<string, unknown>): Promise<Answer> {
  const created = await createTask(who, body);
  if (created.status !== 201) return created;
  await pool.query('UPDATE tasks SET owner_principal_id = $2 WHERE id = $1',
    [String(created.json.task.id), who.principalId]);
  return created;
}

beforeAll(async () => {
  const ownerId = await makeAccount('user');
  const outsiderId = await makeAccount('user');
  OWNER = await sessionCallerFor('owner', ownerId);
  OUTSIDER = await sessionCallerFor('outsider', outsiderId);
  OWNER_PROJECT = await makeProject(ownerId);

  const app = buildApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ───────────────────── what create accepts, create stores ────────────────────

/**
 * The fields under test.
 *
 * `accepted` values must survive a create and read back identically; `refused`
 * values must be refused by BOTH surfaces with the SAME code. Adding a field
 * both write routes accept means adding a row here — the point of the table is
 * that the property is stated once and every field is measured by it.
 */
interface FieldCase {
  field: string;
  /** The `tasks` column the API field lands in, read directly for the
   *  assertions that must not trust the route that just refused. */
  column: string;
  /**
   * Round-1 review F7. This was a list of values, checked only for
   * create-equals-update. That property is satisfied by a product that
   * corrupts BOTH surfaces the same way, and the reviewer produced exactly
   * that mutation: a normalizer that rewrites one fixture string is invisible
   * to parity, to the absent control, to the refusals and to the
   * authorization assertions.
   *
   * So each accepted value now also names what it must READ BACK, as a
   * literal. `reads` is written down rather than computed: a function would be
   * an oracle re-derived from the thing under test and could be edited into
   * agreement with it, which is the same failure one level up.
   *
   * Parity stays. Between them the two say something neither says alone:
   * create and update agree with EACH OTHER, and both agree with the
   * documented contract.
   */
  accepted: Array<{ send: unknown; reads: unknown; why: string }>;
  /** A second valid value, distinct from accepted[0]: the owner-still-writes
   *  control needs something to change the field TO. */
  alternate: unknown;
  refused: Array<{ value: unknown; code: string }>;
  /** What GET returns for a value the caller never set. */
  absent: unknown;
  /**
   * How the raw row is asked for, as SQL aliased to `probe`.
   *
   * Round-2 review. `SELECT due_at` hands the driver a `timestamptz`, which it
   * parses into a JavaScript `Date` — a MILLISECOND value that cannot
   * represent what the column holds. A probe that read it would agree with a
   * product that truncated, which is the defect. So the deadline is asked for
   * as the database's own text, at the database's own precision: the probe is
   * an OUTSIDE anchor on what was stored, not a second copy of the read path.
   */
  columnSelect: string;
  /** The row value in the API's own shape; identity for a text column. */
  fromRow: (value: unknown) => unknown;
}

const FIELDS: FieldCase[] = [
  {
    field: 'notes',
    column: 'notes',
    accepted: [
      { send: 'seeded at create', reads: 'seeded at create', why: 'stored verbatim' },
      { send: 'line one\nline two', reads: 'line one\nline two', why: 'newlines are content, not structure' },
      // `hydrateTask` maps an empty column to an ABSENT field rather than to
      // an empty string. That is the product's read shape for this column and
      // predates these cards; pinning it here is how a change to it shows up.
      { send: '', reads: undefined, why: 'an empty column reads as absent' },
    ],
    alternate: 'rewritten by the owner',
    refused: [
      { value: 42, code: 'INVALID_TASK_NOTES' },
      { value: { text: 'nope' }, code: 'INVALID_TASK_NOTES' },
      { value: ['nope'], code: 'INVALID_TASK_NOTES' },
    ],
    absent: undefined,
    columnSelect: 'notes',
    fromRow: (value) => value,
  },
  {
    // Card 7d38a6e0, migration 124. Every value here is deliberate: a future
    // deadline, a PAST one (the board records deadlines, it does not police
    // them), and one spelled with an offset rather than Z — all three are
    // things a caller may legitimately send.
    field: 'dueAt',
    column: 'due_at',
    accepted: [
      { send: '2026-12-24T09:00:00.000000Z', reads: '2026-12-24T09:00:00.000000Z',
        why: 'a future deadline, already in the stored spelling' },
      { send: '2020-01-01T00:00:00.000Z', reads: '2020-01-01T00:00:00.000000Z',
        why: 'a PAST deadline: the board records them, it does not police them' },
      { send: '2026-12-24T10:00:00+01:00', reads: '2026-12-24T09:00:00.000000Z',
        why: 'an offset spelling is normalised to UTC on the way in' },
      { send: '2026-12-24T09:00Z', reads: '2026-12-24T09:00:00.000000Z',
        why: 'seconds are optional in ISO-8601 and default to zero' },
      // Round-1 review F1: the calendar is now decided from the components,
      // so a REAL leap day must still be accepted. Without this the strict
      // check could reject every 29 February and no test would notice.
      { send: '2028-02-29T12:00:00.000Z', reads: '2028-02-29T12:00:00.000000Z',
        why: '2028 is a leap year and 29 February is a real day' },
      { send: '2000-02-29T12:00:00.000Z', reads: '2000-02-29T12:00:00.000000Z',
        why: '2000 is a leap year under the 400-year rule' },
      // ── Round-2 review, the precision finding ──
      // Every one of these past three digits was ACCEPTED by the previous
      // version and read back TRUNCATED, because the value went through
      // `Date`, which counts whole milliseconds. Each row names the exact
      // string it must read back, so a repair that rounded, padded or dropped
      // a digit contradicts a literal rather than agreeing with a formula.
      { send: '2026-09-07T17:00:00.1Z', reads: '2026-09-07T17:00:00.100000Z',
        why: 'one digit is a tenth of a second, and the canonical form says so in six' },
      { send: '2026-09-07T17:00:00.123Z', reads: '2026-09-07T17:00:00.123000Z',
        why: 'three digits: the most the old path could carry, now spelled at the column precision' },
      { send: '2026-09-07T17:00:00.1234Z', reads: '2026-09-07T17:00:00.123400Z',
        why: 'four digits: the first value the old path silently truncated' },
      { send: '2026-09-07T17:00:00.123456Z', reads: '2026-09-07T17:00:00.123456Z',
        why: 'six digits is exactly what the column keeps, and it survives whole' },
      { send: '2026-09-07T17:00:00.000001Z', reads: '2026-09-07T17:00:00.000001Z',
        why: 'ONE microsecond past the second: the smallest thing the column can distinguish' },
      { send: '2026-09-07T17:00:00.999999Z', reads: '2026-09-07T17:00:00.999999Z',
        why: 'the last microsecond of the second, which a round-to-milliseconds would carry into the next one' },
      { send: '2026-12-24T10:00:00.654321+01:00', reads: '2026-12-24T09:00:00.654321Z',
        why: 'the fraction survives the offset arithmetic it is deliberately kept out of' },
    ],
    alternate: '2027-03-01T08:30:00.000000Z',
    refused: [
      // A bare calendar date names no instant: the server would have to
      // invent a timezone to store it, and inventing one is the defect.
      { value: '2026-12-24', code: 'INVALID_DUE_AT' },
      { value: 'next Tuesday', code: 'INVALID_DUE_AT' },
      { value: '2026-13-01T00:00:00Z', code: 'INVALID_DUE_AT' },
      { value: 1766566800000, code: 'INVALID_DUE_AT' },
      { value: { at: '2026-12-24T09:00:00Z' }, code: 'INVALID_DUE_AT' },
      // Round-1 review F1. Every one of these was ACCEPTED by the first
      // version, because it asked `Date` whether the value was a real instant
      // and `Date` normalises instead of refusing. Each stored a DIFFERENT
      // instant from the one the caller named, silently.
      { value: '2026-02-31T12:00:00Z', code: 'INVALID_DUE_AT' },
      { value: '2026-04-31T12:00:00Z', code: 'INVALID_DUE_AT' },
      { value: '2026-02-29T12:00:00Z', code: 'INVALID_DUE_AT' },
      { value: '2100-02-29T12:00:00Z', code: 'INVALID_DUE_AT' },
      { value: '2026-09-07T24:00:00Z', code: 'INVALID_DUE_AT' },
      { value: '2026-09-07T12:00:60Z', code: 'INVALID_DUE_AT' },
      { value: '2026-00-10T12:00:00Z', code: 'INVALID_DUE_AT' },
      { value: '2026-09-00T12:00:00Z', code: 'INVALID_DUE_AT' },
      { value: '2026-09-07T12:00:00+24:00', code: 'INVALID_DUE_AT' },
      // The empty string named no instant and was quietly read as "clear it".
      // Nothing sends it - the CLI and the interface both send null - and the
      // documented contract says null, so it is a value like any other now.
      { value: '', code: 'INVALID_DUE_AT' },
      // ── Round-2 review, the precision finding ──
      // Finer than the column keeps. Its own code, because "that is not an
      // instant" and "that is an instant this column cannot hold" are
      // different things to tell a caller — and the alternative the reviewer
      // measured was neither: silently storing a third instant.
      { value: '2026-09-07T17:00:00.1234567Z', code: 'INVALID_DUE_AT_PRECISION' },
      { value: '2026-09-07T17:00:00.123456789Z', code: 'INVALID_DUE_AT_PRECISION' },
      { value: '2026-09-07T17:00:00.0000001Z', code: 'INVALID_DUE_AT_PRECISION' },
      { value: '2026-12-24T10:00:00.1234567+01:00', code: 'INVALID_DUE_AT_PRECISION' },
    ],
    absent: null,
    columnSelect: `to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    fromRow: (value) => value,
  },
];

describe.each(FIELDS)('$field: the two write surfaces agree', (spec: FieldCase) => {
  it.each(spec.accepted)(
    'create stores $send as $reads ($why), and stores exactly what update stores',
    async ({ send: value, reads }) => {
      // The surface the card is about.
      const created = await createTask(OWNER, { [spec.field]: value });
      expect(created.status).toBe(201);
      const createdId = String(created.json.task.id);
      const afterCreate = await call(OWNER, 'GET', `/tasks/${createdId}`);
      expect(afterCreate.status).toBe(200);

      // The surface it must agree with. A second Task, created WITHOUT the
      // field and then patched with it, so the comparison is create-vs-update
      // and not create-vs-a-value-this-file-wrote-down.
      const other = await createAssigned(OWNER, {});
      expect(other.status).toBe(201);
      const otherId = String(other.json.task.id);
      const patched = await call(OWNER, 'PATCH', `/tasks/${otherId}`, { [spec.field]: value });
      expect(patched.status).toBe(200);
      const afterPatch = await call(OWNER, 'GET', `/tasks/${otherId}`);
      expect(afterPatch.status).toBe(200);

      // The two surfaces agree with each other...
      expect(afterCreate.json.task[spec.field]).toEqual(afterPatch.json.task[spec.field]);
      // ...and both agree with the contract. Round-1 review F7: parity alone
      // is satisfied by a product that corrupts both surfaces identically.
      expect(afterCreate.json.task[spec.field]).toEqual(reads);
      expect(afterPatch.json.task[spec.field]).toEqual(reads);
    },
  );

  it('a Task created without the field reads back as unset', async () => {
    // The non-vacuity control for the assertion above: if every Task read back
    // the same thing regardless of the body, "create stores what update
    // stores" would hold for a product that stores nothing at all.
    const created = await createTask(OWNER, {});
    expect(created.status).toBe(201);
    const read = await call(OWNER, 'GET', `/tasks/${created.json.task.id}`);
    expect(read.json.task[spec.field]).toEqual(spec.absent);
  });

  it.each(spec.refused)('both surfaces refuse %j with the same code', async ({ value, code }) => {
    // Round-1 review F7: a refusal that interpolated the offending value into
    // its message would put caller text on a path this product keeps clean,
    // and nothing here would have noticed. The message is FIXED; assert it.
    const echoed = (answer: Answer): boolean => {
      const rendered = typeof value === 'string' ? value : JSON.stringify(value);
      return rendered.length > 0 && answer.raw.includes(rendered);
    };

    const created = await createTask(OWNER, { [spec.field]: value });
    expect(created.status).toBe(400);
    expect(created.json.code).toBe(code);
    expect(created.json.details).toEqual({ field: spec.field });
    expect(echoed(created)).toBe(false);

    const target = await createAssigned(OWNER, {});
    expect(target.status).toBe(201);
    const patched = await call(OWNER, 'PATCH', `/tasks/${target.json.task.id}`, { [spec.field]: value });
    expect(patched.status).toBe(400);
    expect(patched.json.code).toBe(code);
    expect(patched.json.details).toEqual({ field: spec.field });
    expect(echoed(patched)).toBe(false);
  });

  it('a refused create writes nothing — the Task does not exist half-made', async () => {
    const before = await pool.query('SELECT COUNT(*)::int AS n FROM tasks WHERE project_id = $1', [OWNER_PROJECT]);
    const refusal = spec.refused[0];
    const created = await createTask(OWNER, { [spec.field]: refusal.value });
    expect(created.status).toBe(400);
    const after = await pool.query('SELECT COUNT(*)::int AS n FROM tasks WHERE project_id = $1', [OWNER_PROJECT]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

// ─────────────────── the field is not an authorization hole ──────────────────

describe.each(FIELDS)('$field: two principals, one Task', (spec: FieldCase) => {
  const SET = spec.accepted[0].send;
  let taskId: string;

  beforeAll(async () => {
    const created = await createAssigned(OWNER, { [spec.field]: SET });
    expect(created.status).toBe(201);
    taskId = String(created.json.task.id);
  });

  it('the owner reads the value it wrote — the ceiling is not simply nothing', async () => {
    const read = await call(OWNER, 'GET', `/tasks/${taskId}`);
    expect(read.status).toBe(200);
    expect(read.json.task[spec.field]).toEqual(SET);
  });

  it('the owner still WRITES it — refusing everyone would satisfy the rest', async () => {
    const rewritten = spec.alternate;
    const patched = await call(OWNER, 'PATCH', `/tasks/${taskId}`, { [spec.field]: rewritten });
    expect(patched.status).toBe(200);
    const stored = await pool.query(`SELECT ${spec.columnSelect} AS probe FROM tasks WHERE id = $1`, [taskId]);
    expect(spec.fromRow(stored.rows[0].probe)).toEqual(rewritten);
    // Put it back, so the assertions below measure the value they name.
    const restored = await call(OWNER, 'PATCH', `/tasks/${taskId}`, { [spec.field]: SET });
    expect(restored.status).toBe(200);
  });

  it('the outsider cannot read it, and the whole Task is concealed', async () => {
    const read = await call(OUTSIDER, 'GET', `/tasks/${taskId}`);
    expect(read.status).toBe(404);
    // Not merely "the field is absent from a 200": the row must not be
    // disclosed at all, and the refusal must not carry the value anywhere in
    // its body.
    expect(read.raw).not.toContain(String(SET));
  });

  it('the outsider cannot read it through a list either', async () => {
    const list = await call(OUTSIDER, 'GET', '/tasks?limit=200');
    expect(list.status).toBe(200);
    const ids = (list.json.tasks ?? []).map((task: any) => String(task.id));
    expect(ids).not.toContain(taskId);
    expect(list.raw).not.toContain(String(SET));
  });

  it('the outsider cannot alter it, and the stored value is unchanged', async () => {
    const attempt = await call(OUTSIDER, 'PATCH', `/tasks/${taskId}`, { [spec.field]: 'written by an outsider' });
    // The WRITE plane answers 403 where the read plane answers 404 — an
    // asymmetry this suite observes rather than asserts a preference about,
    // because it is the product's existing refusal shape on every Task field
    // and not something these cards introduced. What IS asserted is the part
    // that must hold for a new field: the write does not land, and the
    // refusal carries no part of the value it refused to overwrite.
    expect(attempt.status).toBeGreaterThanOrEqual(400);
    expect(attempt.raw).not.toContain(String(SET));

    // Read the row directly, not through the route that just refused: a route
    // answering a refusal while the UPDATE landed is exactly the failure this
    // assertion exists for.
    const stored = await pool.query(`SELECT ${spec.columnSelect} AS probe FROM tasks WHERE id = $1`, [taskId]);
    expect(spec.fromRow(stored.rows[0].probe)).toEqual(SET);
  });
});

// ─────────────────── a deadline, and what it is allowed to be ────────────────

describe('dueAt is an instant, and the board does not police it', () => {
  it('a deadline already in the past is ACCEPTED, deliberately', async () => {
    // The design decision, pinned. "Reject past-dated on create" was
    // considered and refused: an import, a backfill and a missed deadline are
    // all ordinary, and a board that refuses to record a date that has passed
    // makes its own history unrepresentable.
    const past = '1999-12-31T23:59:00.000Z';
    const created = await createTask(OWNER, { dueAt: past });
    expect(created.status).toBe(201);
    const read = await call(OWNER, 'GET', `/tasks/${created.json.task.id}`);
    expect(read.json.task.dueAt).toBe('1999-12-31T23:59:00.000000Z');
  });

  it('the same instant spelled two ways reads back one way', async () => {
    // Two callers who named the SAME moment must not produce two different
    // strings on read, or every client comparison has to re-parse first.
    const withOffset = await createTask(OWNER, { dueAt: '2026-12-24T10:00:00+01:00' });
    const withZulu = await createTask(OWNER, { dueAt: '2026-12-24T09:00:00Z' });
    expect(withOffset.status).toBe(201);
    expect(withZulu.status).toBe(201);
    const a = await call(OWNER, 'GET', `/tasks/${withOffset.json.task.id}`);
    const b = await call(OWNER, 'GET', `/tasks/${withZulu.json.task.id}`);
    expect(a.json.task.dueAt).toBe(b.json.task.dueAt);
    expect(a.json.task.dueAt).toBe('2026-12-24T09:00:00.000000Z');
  });

  it('null clears a deadline that was set', async () => {
    const created = await createAssigned(OWNER, { dueAt: '2026-12-24T09:00:00.000Z' });
    expect(created.status).toBe(201);
    const taskId = String(created.json.task.id);
    const cleared = await call(OWNER, 'PATCH', `/tasks/${taskId}`, { dueAt: null });
    expect(cleared.status).toBe(200);
    const read = await call(OWNER, 'GET', `/tasks/${taskId}`);
    expect(read.json.task.dueAt).toBeNull();
    const stored = await pool.query('SELECT due_at FROM tasks WHERE id = $1', [taskId]);
    expect(stored.rows[0].due_at).toBeNull();
  });

  it('the LIST and the BOARD carry it, not only the point route', async () => {
    // The board card renders the deadline chip from the board payload. A
    // field that only GET /tasks/:id returns is a field the board cannot
    // draw, and nothing in the point-route assertions above would notice.
    const due = '2026-11-05T12:00:00.000000Z';
    const created = await createTask(OWNER, { dueAt: due });
    expect(created.status).toBe(201);
    const taskId = String(created.json.task.id);

    const list = await call(OWNER, 'GET', '/tasks?limit=200');
    expect(list.status).toBe(200);
    const listed = (list.json.tasks ?? []).find((task: any) => String(task.id) === taskId);
    expect(listed).toBeDefined();
    expect(listed.dueAt).toBe(due);

    const board = await call(OWNER, 'GET', '/tasks/board?statuses=todo&perColumn=100');
    expect(board.status).toBe(200);
    const columns = board.json.columns ?? {};
    const onBoard = Object.values(columns)
      .flatMap((column: any) => column.items ?? [])
      .find((task: any) => String(task.id) === taskId);
    expect(onBoard).toBeDefined();
    expect(onBoard.dueAt).toBe(due);
  });
});

// ────────────────────── no notes mutation is invisible ───────────────────────

/**
 * `taskHistoryService.recordChange` is deliberately fire-and-forget: docs/api.md
 * says so in as many words ("that history write is best-effort and outside the
 * task's transaction"). So the assertion polls instead of reading once, and a
 * missing row still fails — it just fails after the wait rather than before it.
 */
async function historyRows(taskId: string, eventType: string, expected: number): Promise<any[]> {
  const deadline = Date.now() + 10_000;
  let rows: any[] = [];
  for (;;) {
    const result = await pool.query(
      'SELECT event_type, actor_principal_id FROM task_history WHERE task_id = $1 AND event_type = $2',
      [taskId, eventType],
    );
    rows = result.rows;
    if (rows.length >= expected || Date.now() > deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('every path that writes notes leaves an attributed history row', () => {
  /**
   * docs/api.md states this as a property of the product, not of a list of
   * routes: the text in `notes` can be forged, but a CHANGE to it cannot be
   * made silently, because every path that writes the column leaves a
   * `task_history` row carrying `actor_principal_id` — which the caller cannot
   * author or suppress. When create started writing the column it became such
   * a path, so the property is measured on create too.
   */
  it('a create that writes notes records field=notes attributed to the creator', async () => {
    const created = await createTask(OWNER, { notes: 'attributed at create' });
    expect(created.status).toBe(201);
    const taskId = String(created.json.task.id);

    // `task_history` spells the changed field `event_type`; the doctrine
    // sentence in docs/api.md calls it `field=notes`, which is the same row.
    const rows = await historyRows(taskId, 'notes', 1);
    expect(rows.length).toBe(1);
    expect(String(rows[0].actor_principal_id)).toBe(OWNER.principalId);
  });

  it('a create that writes no notes records no notes row', async () => {
    // The control: a rule that recorded a notes row on every create would
    // satisfy the assertion above and would make the trail meaningless.
    const created = await createTask(OWNER, {});
    expect(created.status).toBe(201);
    // Give the asynchronous writer the SAME window the assertion above gives
    // it, so "no row" means no row rather than "not yet".
    const noted = await createTask(OWNER, { notes: 'a control that must produce a row' });
    expect(noted.status).toBe(201);
    await historyRows(String(noted.json.task.id), 'notes', 1);

    const rows = await historyRows(String(created.json.task.id), 'notes', 1);
    expect(rows.length).toBe(0);
  });
});


// ───────────── the precision the column keeps, measured against the column ────

/**
 * ROUND-2 REVIEW, THE PRECISION FINDING — AS A PROPERTY, NOT A LIST.
 *
 * The reviewer measured one value: `2026-09-07T17:00:00.123456789Z` was
 * accepted and read back `...123Z`. The rows in the table above pin that value
 * and its neighbours, and a table is a list — the next spelling is always
 * outside it. What this describe measures is the property the list is FOR:
 *
 *   for a randomly drawn instant at microsecond precision, what
 *   `POST /tasks` stores, what `PATCH /tasks/{id}` stores, what
 *   `GET /tasks/{id}` returns and what the COLUMN holds are the same instant,
 *   to the digit; and one digit finer than the column keeps is refused by
 *   name rather than stored as something else
 *
 * Two things make it more than a re-run of the table. The draws are RANDOM
 * across the whole field — calendar, clock and all six fractional digits, with
 * the nanosecond→microsecond boundary drawn deliberately at both ends — so a
 * repair that happened to work for `.123456` and not for `.000001` cannot
 * survive it. And the stored side is read from the DATABASE, formatted by the
 * database, never through the product's own read path: a truncation that
 * happened identically on both sides of the API would still contradict the
 * column.
 *
 * The seed is printed so a failure is reproducible; set RELAYHALL_DUE_SEED to
 * replay one.
 */
describe('dueAt keeps every digit the column keeps, and refuses the ones it does not', () => {
  const SEED = Number(process.env.RELAYHALL_DUE_SEED || (Date.now() % 2_147_483_647));
  let state = SEED || 1;
  /** A small deterministic PRNG: the draws are arbitrary, not unrepeatable. */
  const next = (bound: number): number => {
    state = (state * 48271) % 2_147_483_647;
    return state % bound;
  };
  const pad = (value: number, width: number) => String(value).padStart(width, '0');

  beforeAll(() => {
    // eslint-disable-next-line no-console
    console.log(`[dueAt precision] RELAYHALL_DUE_SEED=${SEED}`);
  });

  function drawInstant(fraction: string): string {
    const year = 2020 + next(16);
    const month = 1 + next(12);
    const daysInMonth = [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28,
      31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    const day = 1 + next(daysInMonth);
    return `${year}-${pad(month, 2)}-${pad(day, 2)}T${pad(next(24), 2)}:${pad(next(60), 2)}`
      + `:${pad(next(60), 2)}.${fraction}Z`;
  }

  /** The boundary, at both ends, plus draws across the whole range. */
  const FRACTIONS = [
    '000000', '000001', '999999', '100000',
    ...Array.from({ length: 8 }, () => pad(next(1_000_000), 6)),
  ];

  it.each(FRACTIONS)('a microsecond instant ending .%s survives create → read → update', async (fraction) => {
    const first = drawInstant(fraction);
    const second = drawInstant(fraction === '000000' ? '000001' : '000000');

    // CREATE
    const created = await createAssigned(OWNER, { dueAt: first });
    expect(created.status).toBe(201);
    const taskId = String(created.json.task.id);
    expect(created.json.task.dueAt).toBe(first);

    // READ
    const read = await call(OWNER, 'GET', `/tasks/${taskId}`);
    expect(read.status).toBe(200);
    expect(read.json.task.dueAt).toBe(first);

    // THE COLUMN — the outside anchor. Not the product's read path.
    const storedAfterCreate = await pool.query(
      `SELECT to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS probe FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(storedAfterCreate.rows[0].probe).toBe(first);

    // UPDATE, to a DIFFERENT instant, and the same three agreements again.
    const patched = await call(OWNER, 'PATCH', `/tasks/${taskId}`, { dueAt: second });
    expect(patched.status).toBe(200);
    const reread = await call(OWNER, 'GET', `/tasks/${taskId}`);
    expect(reread.json.task.dueAt).toBe(second);
    const storedAfterUpdate = await pool.query(
      `SELECT to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS probe FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(storedAfterUpdate.rows[0].probe).toBe(second);
  });

  it.each(FRACTIONS)('one digit past the column — .%s + a nanosecond — is REFUSED, on BOTH surfaces', async (fraction) => {
    const microseconds = drawInstant(fraction);
    // The SAME instant with a seventh digit: the only difference between the
    // value that must be kept and the value that must be refused.
    const nanoseconds = microseconds.replace(/(\.\d{6})Z$/, '$1' + String(1 + next(9)) + 'Z');
    expect(nanoseconds).not.toBe(microseconds);

    const created = await createTask(OWNER, { dueAt: nanoseconds });
    expect(created.status).toBe(400);
    expect(created.json.code).toBe('INVALID_DUE_AT_PRECISION');

    // And nothing was stored under the guise of a refusal: a Task created
    // with the microsecond value, then PATCHed with the nanosecond one, still
    // holds the value it was created with.
    const holder = await createAssigned(OWNER, { dueAt: microseconds });
    expect(holder.status).toBe(201);
    const taskId = String(holder.json.task.id);
    const patched = await call(OWNER, 'PATCH', `/tasks/${taskId}`, { dueAt: nanoseconds });
    expect(patched.status).toBe(400);
    expect(patched.json.code).toBe('INVALID_DUE_AT_PRECISION');
    const stored = await pool.query(
      `SELECT to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS probe FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(stored.rows[0].probe).toBe(microseconds);
  });
});

// ─────────────── the day the clocks change, through the real route ───────────

/** Existing ISO callers can name either fold occurrence explicitly. These
 * controls preserve that contract after the form changes to a wall/zone pair. */
describe('a deadline from a day the clocks change is stored as the instant it names', () => {
  /** 29 March 2026: 02:00 CET becomes 03:00 CEST. 02:30 exists in NEITHER
   *  offset, which is why the form refuses it and never posts one. What it
   *  does post either side of the jump must land exactly. */
  it('either side of the spring-forward gap lands exactly, offset and all', async () => {
    const before = await createTask(OWNER, { dueAt: '2026-03-29T01:30:00+01:00' });
    const after = await createTask(OWNER, { dueAt: '2026-03-29T03:30:00+02:00' });
    expect(before.status).toBe(201);
    expect(after.status).toBe(201);
    const readBefore = await call(OWNER, 'GET', `/tasks/${before.json.task.id}`);
    const readAfter = await call(OWNER, 'GET', `/tasks/${after.json.task.id}`);
    // One hour apart on the wall clock (01:30 → 03:30) and one hour apart as
    // instants: the jump is in the LOCAL reading, not in the timeline.
    expect(readBefore.json.task.dueAt).toBe('2026-03-29T00:30:00.000000Z');
    expect(readAfter.json.task.dueAt).toBe('2026-03-29T01:30:00.000000Z');
  });

  /** 25 October 2026: 03:00 CEST becomes 02:00 CET, so 02:30 happens twice.
   *  The offset the browser captured is the only thing that tells them apart,
   *  and the server must keep them apart. */
  it('the two readings of an ambiguous wall clock stay two different instants', async () => {
    const first = await createTask(OWNER, { dueAt: '2026-10-25T02:30:00+02:00' });
    const second = await createTask(OWNER, { dueAt: '2026-10-25T02:30:00+01:00' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const readFirst = await call(OWNER, 'GET', `/tasks/${first.json.task.id}`);
    const readSecond = await call(OWNER, 'GET', `/tasks/${second.json.task.id}`);
    expect(readFirst.json.task.dueAt).toBe('2026-10-25T00:30:00.000000Z');
    expect(readSecond.json.task.dueAt).toBe('2026-10-25T01:30:00.000000Z');
    expect(readFirst.json.task.dueAt).not.toBe(readSecond.json.task.dueAt);
  });

  it('the same two, at microsecond precision, stay distinct to the digit', async () => {
    // The two findings meet here: an ambiguous wall clock AND a fraction finer
    // than `Date` can carry. Neither repair may undo the other.
    const first = await createTask(OWNER, { dueAt: '2026-10-25T02:30:00.123456+02:00' });
    const second = await createTask(OWNER, { dueAt: '2026-10-25T02:30:00.123456+01:00' });
    const readFirst = await call(OWNER, 'GET', `/tasks/${first.json.task.id}`);
    const readSecond = await call(OWNER, 'GET', `/tasks/${second.json.task.id}`);
    expect(readFirst.json.task.dueAt).toBe('2026-10-25T00:30:00.123456Z');
    expect(readSecond.json.task.dueAt).toBe('2026-10-25T01:30:00.123456Z');
  });
});

// ──────────── every canonical read path echoes the column, not a Date ────────

/**
 * ROUND-2 REVIEW, THE PRECISION FINDING — THE READ HALF.
 *
 * The write path is only half of "the stored instant is the one the caller
 * named". `pg` parses a `timestamptz` into a millisecond JavaScript `Date`, so
 * a read path that echoed `row.due_at` would answer with a DIFFERENT instant
 * however careful the write was — and it would do it on that surface only,
 * which is precisely the kind of hole a suite finds by accident or not at all.
 *
 * Every canonical Task read is measured here against ONE microsecond value:
 * the point route, the list, the board, and the 201 body the create itself
 * returns. `TaskManagerDB.readRowDueAt` fails closed for the same reason —
 * a read path that forgets the projection throws rather than truncating — and
 * these four are what makes that guard's reach visible.
 */
describe('every canonical read path echoes the microsecond, not the millisecond', () => {
  const PRECISE = '2026-11-05T12:00:00.654321Z';
  let taskId = '';
  let createBody: any;

  beforeAll(async () => {
    const created = await createTask(OWNER, { dueAt: PRECISE, status: 'todo' });
    expect(created.status).toBe(201);
    createBody = created.json.task;
    taskId = String(createBody.id);
  });

  it('the 201 body the create returns', () => {
    expect(createBody.dueAt).toBe(PRECISE);
  });

  it('the point route', async () => {
    const read = await call(OWNER, 'GET', `/tasks/${taskId}`);
    expect(read.json.task.dueAt).toBe(PRECISE);
  });

  it('the list', async () => {
    const list = await call(OWNER, 'GET', '/tasks?limit=200');
    const mine = (list.json.tasks ?? []).find((task: any) => String(task.id) === taskId);
    expect(mine).toBeDefined();
    expect(mine.dueAt).toBe(PRECISE);
  });

  it('the board', async () => {
    const board = await call(OWNER, 'GET', '/tasks/board?limit=200');
    const columns = board.json.columns ?? board.json.board?.columns ?? {};
    const all = Object.values(columns).flatMap((column: any) => column?.items ?? []);
    const mine = all.find((task: any) => String(task.id) === taskId);
    expect(mine).toBeDefined();
    expect((mine as any).dueAt).toBe(PRECISE);
  });

  it('and an UPDATE answers with it too', async () => {
    const assigned = await createAssigned(OWNER, { dueAt: PRECISE });
    expect(assigned.status).toBe(201);
    const patched = await call(OWNER, 'PATCH', `/tasks/${assigned.json.task.id}`, { priority: 'high' });
    expect(patched.status).toBe(200);
    expect(patched.json.task.dueAt).toBe(PRECISE);
  });
});

// ───────────────── the wall clock the browser no longer converts ─────────────

/**
 * ROUND 4 — THE DESIGN CHANGE, MEASURED THROUGH THE PRODUCTION ROUTER.
 *
 * Three rounds rejected this feature for one property: THE STORED INSTANT IS
 * THE ONE THE CALLER NAMED. Three repairs each moved the browser's wall-clock
 * conversion one boundary further out and each found the next one — the
 * calendar, the fraction, the four-digit year, the minute-resolution offset
 * that cannot state Europe/Paris's 1900 +00:09:21.
 *
 * The conversion is gone. The interface submits
 * `{ local: '2026-10-25T02:30:00', zone: 'Europe/Warsaw' }` — the clock as
 * written and the zone's NAME — and the server resolves it against
 * PostgreSQL's IANA database, refusing a clock that names no instant and
 * saying which offset it used for one that names two. The ISO-8601 instant
 * form is unchanged for every other caller.
 *
 * ── THE ORACLE IS NOT POSTGRESQL ──
 *
 * A test that checked PostgreSQL's answer with PostgreSQL would be the
 * mechanism grading itself. So the oracle here is Node's own ICU timezone
 * database — a DIFFERENT implementation, on different data, versioned
 * separately — asked the only question that matters: rendered back into that
 * zone, is the instant the server stored the very clock the caller wrote?
 * Where the two disagree, this suite fails, which is what a drift control is
 * for. The column itself is read directly as a second anchor, so a value that
 * agreed with ICU and disagreed with the row would still fail.
 */

/** The local wall clock of an instant, in a zone, as ICU sees it — expressed
 *  as the UTC epoch of those same components, so two clocks can be compared as
 *  numbers. Whole seconds: ICU renders no finer, and the fraction is checked
 *  separately, as text. */
function icuWallClockMs(instantMs: number, zone: string): number {
  const parts: Record<string, string> = {};
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, era: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  for (const part of formatter.formatToParts(new Date(instantMs))) parts[part.type] = part.value;
  if (parts.era !== 'AD') return Number.NaN;
  return literalUtcMs(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    // ICU spells midnight as hour 24 of the previous day in some locales; the
    // en-US h23 request above does not, and this keeps the comparison total.
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  );
}

/** Independent ICU offset probes validate the drawn cases, with literal fold
 * fixtures anchoring the native PostgreSQL policy. This sampled oracle does
 * not claim to enumerate every transition in every timezone database. */
function icuInstantsFor(wallClockMs: number, zone: string): number[] {
  const DAY = 26 * 3600 * 1000;
  const offsets = new Set<number>();
  for (const probe of [wallClockMs - DAY, wallClockMs, wallClockMs + DAY]) {
    const local = icuWallClockMs(probe, zone);
    if (!Number.isNaN(local)) offsets.add(local - probe);
  }
  const found = new Set<number>();
  for (const offset of offsets) {
    const candidate = wallClockMs - offset;
    if (icuWallClockMs(candidate, zone) === wallClockMs) found.add(candidate);
  }
  return [...found].sort((a, b) => a - b);
}

function literalUtcMs(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

/** `2026-10-25T02:30:00` → the epoch of those components read as UTC. */
function wallClockMsOf(local: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(local);
  if (!m) throw new Error(`not a wall clock: ${local}`);
  return literalUtcMs(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

/** The canonical instant, minus its fraction, as an epoch. */
function instantMsOf(canonical: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/.exec(canonical);
  if (!m) throw new Error(`not a canonical instant: ${canonical}`);
  return literalUtcMs(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

/** What the COLUMN holds, formatted by the database, never by the read path. */
async function columnDueAt(taskId: string): Promise<string | null> {
  const row = await pool.query(
    `SELECT to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS probe FROM tasks WHERE id = $1`,
    [taskId],
  );
  return row.rows[0]?.probe ?? null;
}

describe('a wall clock plus a zone is resolved by the server, and proved by a different one', () => {
  it('the ordinary case reports the native PostgreSQL policy and offset', async () => {
    const created = await createTask(OWNER, { dueAt: { local: '2026-09-07T19:00:00', zone: 'Europe/Warsaw' } });
    expect(created.status).toBe(201);
    expect(created.json.task.dueAt).toBe('2026-09-07T17:00:00.000000Z');
    expect(created.json.dueAtResolution).toEqual({
      zone: 'Europe/Warsaw',
      local: '2026-09-07T19:00:00.000000',
      instant: '2026-09-07T17:00:00.000000Z',
      offset: '+02:00',
      offsetSeconds: 7200,
      chosen: 'postgresql',
    });
    expect(await columnDueAt(String(created.json.task.id))).toBe('2026-09-07T17:00:00.000000Z');
  });

  it('sub-second digits survive a zoned write, all six of them', async () => {
    const created = await createTask(OWNER, { dueAt: { local: '2026-09-07T19:00:00.123456', zone: 'Europe/Warsaw' } });
    expect(created.status).toBe(201);
    expect(created.json.task.dueAt).toBe('2026-09-07T17:00:00.123456Z');
    expect(await columnDueAt(String(created.json.task.id))).toBe('2026-09-07T17:00:00.123456Z');
  });

  it('and a seventh digit is refused by the same name it is refused under an instant', async () => {
    const created = await createTask(OWNER, { dueAt: { local: '2026-09-07T19:00:00.1234567', zone: 'Europe/Warsaw' } });
    expect(created.status).toBe(400);
    expect(created.json.code).toBe('INVALID_DUE_AT_PRECISION');
  });
});

describe('a local time that names NO instant is refused by name, and the refusal names the zone', () => {
  /** Each of these is a different WAY for a wall clock to name nothing, and
   *  the third is not a daylight-saving change at all — Samoa skipped 30
   *  December 2011 entirely when it crossed the date line. A repair that knew
   *  only about DST would pass the first two. */
  const NOWHERE: Array<[string, string, string]> = [
    ['a spring-forward gap', '2026-03-29T02:30:00', 'Europe/Warsaw'],
    ['a thirty-minute gap', '2026-10-04T02:15:00', 'Australia/Lord_Howe'],
    ['a day the dateline removed', '2011-12-30T12:00:00', 'Pacific/Apia'],
    ['a North American gap', '2026-03-08T02:30:00', 'America/New_York'],
  ];

  it.each(NOWHERE)('%s — %s in %s is refused, and nothing is stored', async (_what, local, zone) => {
    // The oracle first: a DIFFERENT timezone database agrees there is no such
    // moment. Without this the assertion below would only say the server
    // refused something, not that it was right to.
    expect(icuInstantsFor(wallClockMsOf(local), zone)).toEqual([]);

    const created = await createTask(OWNER, { dueAt: { local, zone } });
    expect(created.status).toBe(400);
    expect(created.json.code).toBe('INVALID_DUE_AT_LOCAL_TIME');
    expect(created.json.details.field).toBe('dueAt');
    // The refusal NAMES THE ZONE, which is the one thing a person cannot work
    // out from "that time does not exist".
    expect(created.json.error).toContain(zone);
    expect(created.json.task).toBeUndefined();

    // And a PATCH refuses identically, leaving the deadline that was there.
    const holder = await createAssigned(OWNER, { dueAt: '2026-01-01T00:00:00.000000Z' });
    expect(holder.status).toBe(201);
    const taskId = String(holder.json.task.id);
    const patched = await call(OWNER, 'PATCH', `/tasks/${taskId}`, { dueAt: { local, zone } });
    expect(patched.status).toBe(400);
    expect(patched.json.code).toBe('INVALID_DUE_AT_LOCAL_TIME');
    expect(await columnDueAt(taskId)).toBe('2026-01-01T00:00:00.000000Z');
  });

  it('an hour either side of each gap is an ordinary deadline', async () => {
    // The control for the four above: a server that refused every wall clock,
    // or every wall clock on a transition day, would satisfy all of them.
    for (const [local, zone, expected] of [
      ['2026-03-29T01:30:00', 'Europe/Warsaw', '2026-03-29T00:30:00.000000Z'],
      ['2026-03-29T03:30:00', 'Europe/Warsaw', '2026-03-29T01:30:00.000000Z'],
      ['2026-10-04T01:45:00', 'Australia/Lord_Howe', '2026-10-03T15:15:00.000000Z'],
      ['2011-12-29T12:00:00', 'Pacific/Apia', '2011-12-29T22:00:00.000000Z'],
      ['2011-12-31T12:00:00', 'Pacific/Apia', '2011-12-30T22:00:00.000000Z'],
    ] as Array<[string, string, string]>) {
      const created = await createTask(OWNER, { dueAt: { local, zone } });
      expect(created.status).toBe(201);
      expect(created.json.task.dueAt).toBe(expected);
      expect(icuInstantsFor(wallClockMsOf(local), zone)).toEqual([instantMsOf(expected)]);
    }
  });
});

describe('a local time that names TWO instants is resolved deterministically, and said out loud', () => {
  const FOLDS: Array<[string, string, string, string, number]> = [
    ['Europe/Warsaw', '2026-10-25T02:30:00', '2026-10-25T01:30:00.000000Z', '+01:00', 3600],
    ['Australia/Lord_Howe', '2026-04-05T01:45:00', '2026-04-04T15:15:00.000000Z', '+10:30', 37800],
    ['America/New_York', '2026-11-01T01:30:00', '2026-11-01T06:30:00.000000Z', '-05:00', -18000],
  ];

  it.each(FOLDS)('%s: the post-transition offset is used and reported', async (zone, local, expected, offset, offsetSeconds) => {
    // The oracle: there really are two, and the one the server took is the
    // second of them. A fold that ICU did not agree was a fold would make this
    // assertion about nothing.
    const both = icuInstantsFor(wallClockMsOf(local), zone);
    expect(both).toHaveLength(2);
    expect(both[1]).toBe(instantMsOf(expected));

    const created = await createTask(OWNER, { dueAt: { local, zone } });
    expect(created.status).toBe(201);
    expect(created.json.task.dueAt).toBe(expected);
    expect(created.json.dueAtResolution).toMatchObject({
      zone, instant: expected, offset, offsetSeconds, chosen: 'postgresql',
    });
    expect(await columnDueAt(String(created.json.task.id))).toBe(expected);
  });

  it('a caller who means the OTHER one can still say so, as an instant', async () => {
    // The choice is deterministic, not the only thing expressible. The
    // ISO-8601 form states an offset and therefore names one moment; that is
    // the escape hatch, and it must keep working.
    const second = await createTask(OWNER, { dueAt: '2026-10-25T02:30:00+02:00' });
    expect(second.status).toBe(201);
    expect(second.json.task.dueAt).toBe('2026-10-25T00:30:00.000000Z');
    // …and an instant carries no resolution to report, because nothing was
    // chosen for the caller.
    expect(second.json.dueAtResolution).toBeUndefined();
  });

  it('an unambiguous zoned write reports the same policy', async () => {
    const created = await createTask(OWNER, { dueAt: { local: '2026-10-25T05:30:00', zone: 'Europe/Warsaw' } });
    expect(created.status).toBe(201);
    expect(created.json.dueAtResolution.chosen).toBe('postgresql');
  });

  it('PATCH resolves and reports identically to POST', async () => {
    const holder = await createAssigned(OWNER, {});
    expect(holder.status).toBe(201);
    const patched = await call(OWNER, 'PATCH', `/tasks/${holder.json.task.id}`, {
      dueAt: { local: '2026-10-25T02:30:00', zone: 'Europe/Warsaw' },
    });
    expect(patched.status).toBe(200);
    expect(patched.json.task.dueAt).toBe('2026-10-25T01:30:00.000000Z');
    expect(patched.json.dueAtResolution).toMatchObject({ chosen: 'postgresql', offset: '+01:00' });
  });
});

describe('a historical offset carrying SECONDS is kept to the second', () => {
  /**
   * ROUND-3 BLOCKING FINDING, CLOSED. The browser used to emit
   * `wallClock + getTimezoneOffset()`, and that function returns whole
   * MINUTES: Europe/Paris was +00:09:21 in 1900, so a deadline named 12:00:00
   * was stored 21 seconds late, silently. The browser no longer computes an
   * offset at all, and the database that does carries seconds.
   *
   * This lives in its OWN case rather than in the Europe/Warsaw gap-and-fold
   * gate, which the round-3 verdict asked for explicitly: that gate measures
   * one thing, and every offset in it is minute-aligned.
   */
  const LMT: Array<[string, string, string, string]> = [
    ['Europe/Paris', '1900-01-01T12:00:00', '1900-01-01T11:50:39.000000Z', '+00:09:21'],
    ['Asia/Kolkata', '1900-01-01T12:00:00', '1900-01-01T06:38:50.000000Z', '+05:21:10'],
    ['Africa/Monrovia', '1900-01-01T12:00:00', '1900-01-01T12:43:08.000000Z', '-00:43:08'],
  ];

  it.each(LMT)('%s in 1900', async (zone, local, expected, offset) => {
    const created = await createTask(OWNER, { dueAt: { local, zone } });
    expect(created.status).toBe(201);
    expect(created.json.task.dueAt).toBe(expected);
    // The offset is REPORTED to the second, not rounded to a minute.
    expect(created.json.dueAtResolution.offset).toBe(offset);
    expect(created.json.dueAtResolution.offsetSeconds % 60).not.toBe(0);
    // ICU, on its own data, agrees this is the instant that clock names.
    expect(icuInstantsFor(wallClockMsOf(local), zone)).toEqual([instantMsOf(expected)]);
    expect(await columnDueAt(String(created.json.task.id))).toBe(expected);
  });

  it('the same wall clock in the same zone TODAY is a whole-minute offset', async () => {
    // The control: if the seconds above came from somewhere other than the
    // zone's own history, they would show up here too.
    const created = await createTask(OWNER, { dueAt: { local: '2026-01-01T12:00:00', zone: 'Asia/Kolkata' } });
    expect(created.status).toBe(201);
    expect(created.json.dueAtResolution.offset).toBe('+05:30');
  });
});

describe('the ends of the calendar are refused by name, never mangled', () => {
  it('an instant at each end round-trips exactly', async () => {
    for (const value of ['0001-01-01T00:00:00Z', '9999-12-31T23:59:59.999999Z']) {
      const created = await createTask(OWNER, { dueAt: value });
      expect(created.status).toBe(201);
      const expected = value === '0001-01-01T00:00:00Z'
        ? '0001-01-01T00:00:00.000000Z'
        : '9999-12-31T23:59:59.999999Z';
      expect(created.json.task.dueAt).toBe(expected);
      expect(await columnDueAt(String(created.json.task.id))).toBe(expected);
    }
  });

  it('ROUND-3 FINDING (b): an offset that carries the instant past year 9999 is REFUSED', async () => {
    // Measured verbatim as the round-3 verdict measured it. It used to be
    // accepted and stored as `+010000-01-01T00:00.000000Z` — a malformed
    // string with the caller's `:59` seconds cut off by a fixed-position
    // slice of `toISOString()`.
    const created = await createTask(OWNER, { dueAt: '9999-12-31T23:59:59-00:01' });
    expect(created.status).toBe(400);
    expect(created.json.code).toBe('INVALID_DUE_AT_RANGE');
    expect(created.json.details.field).toBe('dueAt');
  });

  it('ROUND-3 FINDING (b), the other end: year 0000 and an offset that crosses it', async () => {
    // `0000-01-01T00:00:00+00:01` used to be accepted as
    // `-000001-12-31T23:59.000000Z`. Year 0000 is refused outright now: it is
    // a legal four-digit spelling and not a year PostgreSQL has.
    for (const value of ['0000-01-01T00:00:00+00:01', '0000-01-01T00:00:00Z']) {
      const created = await createTask(OWNER, { dueAt: value });
      expect(created.status).toBe(400);
      expect(created.json.code).toBe('INVALID_DUE_AT_RANGE');
    }
    // And the same through the zoned form, where PostgreSQL's missing year
    // zero shows up as a BC instant that `to_char` would print without an era.
    const zoned = await createTask(OWNER, { dueAt: { local: '0001-01-01T00:00:00', zone: 'Pacific/Apia' } });
    expect(zoned.status).toBe(400);
    expect(zoned.json.code).toBe('INVALID_DUE_AT_RANGE');
  });

  it('a zoned clock whose zone carries it past year 9999 is refused too', async () => {
    const created = await createTask(OWNER, { dueAt: { local: '9999-12-31T23:59:59.999999', zone: 'Pacific/Honolulu' } });
    expect(created.status).toBe(400);
    expect(created.json.code).toBe('INVALID_DUE_AT_RANGE');
  });

  it('and one whose zone keeps it inside is accepted — the control', async () => {
    const created = await createTask(OWNER, { dueAt: { local: '9999-12-31T23:59:59.999999', zone: 'Pacific/Kiritimati' } });
    expect(created.status).toBe(201);
    expect(created.json.task.dueAt).toBe('9999-12-31T09:59:59.999999Z');
  });

  it('every accepted deadline is spelled the one canonical way', async () => {
    // The shape the read path and the write path share, asserted as a shape
    // rather than as a list of examples: four digits of year, six of fraction,
    // a Z. Round 3's two blocking values both failed exactly this.
    for (const value of ['0001-01-01T00:00:00Z', '9999-12-31T23:59:59.999999Z',
      '2026-09-07T17:00:00+02:00'] as unknown[]) {
      const created = await createTask(OWNER, { dueAt: value });
      expect(created.status).toBe(201);
      expect(created.json.task.dueAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    }
  });
});

describe('a zone the server does not know is refused, and its name is not echoed back', () => {
  const NOT_ZONES = ['Mars/Olympus', 'Europe/Warsaw ', '+02:00', 'Etc/Nowhere', "'; DROP TABLE tasks; --"];

  it.each(NOT_ZONES)('%j', async (zone) => {
    const created = await createTask(OWNER, { dueAt: { local: '2026-09-07T19:00:00', zone } });
    expect(created.status).toBe(400);
    expect(created.json.code).toBe('INVALID_DUE_AT_ZONE');
    expect(created.json.details.field).toBe('dueAt');
    // The refusal is developer-authored text: the string the caller sent is
    // never quoted back into it. (A KNOWN zone is named, because that value
    // comes from pg_timezone_names — a closed set the server owns.)
    expect(created.json.error).not.toContain(zone);
  });

  it('and the table is still there, which is the point of a bound parameter', async () => {
    const rows = await pool.query('SELECT 1 FROM tasks LIMIT 1');
    expect(rows.rowCount).toBeGreaterThanOrEqual(0);
  });

  it('a malformed object is refused as not naming an instant at all', async () => {
    for (const value of [
      { local: '2026-09-07T19:00:00' },
      { zone: 'Europe/Warsaw' },
      { local: '2026-09-07T19:00:00', zone: 'Europe/Warsaw', extra: 1 },
      { local: '2026-09-07T19:00:00Z', zone: 'Europe/Warsaw' },
      { local: '2026-09-07T19:00:00+02:00', zone: 'Europe/Warsaw' },
      { local: '2026-09-07', zone: 'Europe/Warsaw' },
      { local: '2026-02-31T12:00:00', zone: 'Europe/Warsaw' },
      { local: '2026-09-07T24:00:00', zone: 'Europe/Warsaw' },
      { local: '2026-09-07T12:00:60', zone: 'Europe/Warsaw' },
      { local: 5, zone: 'Europe/Warsaw' },
      [{ local: '2026-09-07T19:00:00', zone: 'Europe/Warsaw' }],
    ] as unknown[]) {
      const created = await createTask(OWNER, { dueAt: value });
      expect(created.status).toBe(400);
      expect(['INVALID_DUE_AT', 'INVALID_DUE_AT_ZONE']).toContain(created.json.code);
    }
  });
});

/**
 * THE PROPERTY, over random wall clocks and real zones.
 *
 * Not a list of days someone thought of. Every draw must produce ONE of three
 * outcomes, and each is checked against ICU rather than against the server's
 * own reasoning:
 *
 *   201 — and the stored instant renders back, in that zone, as EXACTLY the
 *         clock that was sent, with the fraction untouched, and the column
 *         agrees with the response;
 *   400 INVALID_DUE_AT_LOCAL_TIME — and ICU agrees no instant names that
 *         clock in that zone;
 *   400 INVALID_DUE_AT_RANGE — and the clock really is outside the range.
 *
 * The seed is printed so a failure is reproducible; set
 * RELAYHALL_DUE_ZONE_SEED to replay one.
 */
describe('the property: a wall clock is stored as the instant it names, or refused', () => {
  const SEED = Number(process.env.RELAYHALL_DUE_ZONE_SEED || (Date.now() % 2_147_483_647));
  let state = SEED || 1;
  const next = (bound: number): number => {
    state = (state * 48271) % 2_147_483_647;
    return state % bound;
  };
  const pad = (value: number, width: number) => String(value).padStart(width, '0');

  const ZONES = [
    'Europe/Warsaw', 'Pacific/Apia', 'Asia/Kolkata', 'Australia/Lord_Howe',
    'America/New_York', 'Africa/Monrovia', 'Pacific/Kiritimati', 'Asia/Tokyo',
    'Europe/Dublin', 'America/Santiago', 'UTC',
  ];

  beforeAll(() => {
    // eslint-disable-next-line no-console
    console.log(`[dueAt zones] RELAYHALL_DUE_ZONE_SEED=${SEED}`);
  });

  /** Deliberately weighted onto transition days: a uniform draw over two
   *  centuries would hit a gap or a fold roughly never, and a property that
   *  never reaches the hazard is a property about nothing. Half the draws are
   *  the two days a year the clocks move, at the hours they move. */
  function drawLocal(): string {
    const onTransition = next(2) === 0;
    const year = 1900 + next(200);
    const month = onTransition ? (next(2) === 0 ? 3 : 10) : 1 + next(12);
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    const day = onTransition ? 22 + next(days - 21) : 1 + next(days);
    const hour = onTransition ? next(5) : next(24);
    return `${year}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(next(60), 2)}`
      + `:${pad(next(60), 2)}.${pad(next(1_000_000), 6)}`;
  }

  /**
   * A random draw can miss the hazard entirely, and a property that never
   * reaches a gap or a fold measures only the ordinary case while reading as
   * though it measured all three. So the drawn cases are joined by clocks that
   * are KNOWN to be one and the other, and the tally at the end refuses to
   * pass unless every outcome was actually reached.
   */
  const KNOWN_GAPS: Array<[string, string]> = [
    ['Europe/Warsaw', '2026-03-29T02:30:00.000001'],
    ['America/New_York', '2026-03-08T02:59:59.999999'],
    ['Australia/Lord_Howe', '2026-10-04T02:00:00.000000'],
    ['Pacific/Apia', '2011-12-30T00:00:00.000000'],
  ];
  const KNOWN_FOLDS: Array<[string, string]> = [
    ['Europe/Warsaw', '2026-10-25T02:30:00.000000'],
    ['America/New_York', '2026-11-01T01:00:00.000000'],
    ['Australia/Lord_Howe', '2026-04-05T01:45:00.123456'],
    ['Europe/Dublin', '2026-10-25T01:30:00.999999'],
  ];
  const DRAWS: Array<[string, string]> = [
    ...Array.from({ length: 40 }, () => [ZONES[next(ZONES.length)], drawLocal()] as [string, string]),
    ...Array.from({ length: 12 }, (_, i) => ['UTC', `${i % 2 ? '9999' : '0001'}-${pad(1 + next(12), 2)}-${pad(1 + next(28), 2)}T${pad(next(24), 2)}:${pad(next(60), 2)}:${pad(next(60), 2)}.${pad(next(1_000_000), 6)}`] as [string, string]),
    ...KNOWN_GAPS,
    ...KNOWN_FOLDS,
  ];
  const seen = { refused: 0, single: 0, ambiguous: 0 };

  it.each(DRAWS)('%s %s', async (zone, local) => {
    const created = await createTask(OWNER, { dueAt: { local, zone } });
    const oracle = icuInstantsFor(wallClockMsOf(local), zone);

    if (created.status === 400) {
      expect(created.json.code).toBe('INVALID_DUE_AT_LOCAL_TIME');
      // The only refusal the draws above can produce, and ICU has to agree.
      expect(oracle).toEqual([]);
      seen.refused += 1;
      return;
    }

    expect(created.status).toBe(201);
    const stored = String(created.json.task.dueAt);
    expect(stored).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    // The fraction is the caller's own, untouched.
    expect(stored.slice(20, 26)).toBe(local.slice(20, 26));
    // The whole-second instant renders back, in that zone, as the clock sent.
    expect(icuWallClockMs(instantMsOf(stored), zone)).toBe(wallClockMsOf(local));
    // ICU offers the stored instant; repeated writes must make the same choice.
    expect(oracle).toContain(instantMsOf(stored));
    expect(created.json.dueAtResolution.chosen).toBe('postgresql');
    const repeated = await createTask(OWNER, { dueAt: { local, zone } });
    expect(repeated.json.task.dueAt).toBe(stored);
    const point = await call(OWNER, 'GET', `/tasks/${created.json.task.id}`);
    expect(point.status).toBe(200);
    expect(point.json.task.dueAt).toBe(stored);
    // And the column holds what the response said it holds.
    expect(await columnDueAt(String(created.json.task.id))).toBe(stored);
    if (oracle.length > 1) seen.ambiguous += 1; else seen.single += 1;
  });

  it('and every outcome the property claims to measure was actually reached', () => {
    // The control for the property. Without it a run in which every draw was
    // an ordinary afternoon would report forty-eight passes and would have
    // measured neither the gap nor the fold — which is exactly how the first
    // version of the timezone gate reported success by not looking.
    expect(seen.refused).toBeGreaterThanOrEqual(KNOWN_GAPS.length);
    expect(seen.ambiguous).toBeGreaterThanOrEqual(KNOWN_FOLDS.length);
    expect(seen.single).toBeGreaterThanOrEqual(20);
  });
});

describe('the complete accepted numeric offset domain reaches storage without parser narrowing', () => {
  it.each([
    ['2026-09-07T12:00:00.123456+23:59', '2026-09-06T12:01:00.123456Z'],
    ['2026-09-07T12:00:00.123456-23:59', '2026-09-08T11:59:00.123456Z'],
    ['2026-09-07T12:00:00+16:00', '2026-09-06T20:00:00.000000Z'],
  ])('%s round trips exactly', async (input, expected) => {
    const created = await createAssigned(OWNER, { dueAt: input });
    expect(created.status).toBe(201);
    const point = await call(OWNER, 'GET', `/tasks/${created.json.task.id}`);
    expect(point.json.task.dueAt).toBe(expected);
    expect(await columnDueAt(String(created.json.task.id))).toBe(expected);
  });
});

describe('MCP carries the real PostgreSQL deadline decision through both Task writers', () => {
  const receipts = [
    { zone:'Europe/Warsaw', local:'2026-09-07T19:00:00.123456', instant:'2026-09-07T17:00:00.123456Z', offset:'+02:00', offsetSeconds:7200, chosen:'postgresql' },
    { zone:'Europe/Warsaw', local:'2026-10-25T02:30:00.123456', instant:'2026-10-25T01:30:00.123456Z', offset:'+01:00', offsetSeconds:3600, chosen:'postgresql' },
    { zone:'Asia/Kolkata', local:'1900-01-01T12:00:00.123456', instant:'1900-01-01T06:38:50.123456Z', offset:'+05:21:10', offsetSeconds:19270, chosen:'postgresql' },
  ];
  it.each(receipts)('live MCP receipt retains $zone $local and the stored precision', async receipt => {
    const { principalService } = require('../services/PrincipalService');
    const { toolByName } = require('../mcp/registry');
    const connector = (await pool.query(
      `INSERT INTO principals(kind,handle,display_name,status,role,parent_principal_id,purpose,own_expression)
       VALUES('service',$1,'Deadline Connector','active','user',$2,'MCP deadline fixture',$3::jsonb) RETURNING id`,
      ['deadline-connector-'+tag(), OWNER.principalId, JSON.stringify({scopes:'parent',objects:'parent'})],
    )).rows[0].id;
    const key = await principalService.issueCredential({principalId:connector,scopes:['tasks:read','tasks:write','projects:read','projects:write'],transport:'mcp'},
      {principalId:OWNER.principalId,handle:'deadline-fixture',authMethod:'system'});
    const actor = {label:'deadline Connector',principalId:connector,headers:{Authorization:`Bearer ${key.fullKey}`}};
    // Exact ordinary resource grants on both delegation layers; no root scope.
    const grant = async (kind:string,id:string) => {
      for(const principal of [connector,OWNER.principalId]) for(const verb of ['read','write']) {
        await pool.query(`INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id)
          VALUES('principal',$1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[principal,kind,id,verb,OWNER.principalId]);
      }
    };
    await grant('project',OWNER_PROJECT);
    const invoke = async (verb:string,args:Record<string,unknown>) => {
      const name='relayhall_task_'+verb;
      return toolByName(name).handler(args,{authorization:actor.headers.Authorization,toolName:name});
    };
    const dueAt = {local:receipt.local,zone:receipt.zone};
    const created = await invoke('create',{title:'MCP deadline '+tag(),project:OWNER_PROJECT,status:'todo',dueAt,idempotencyKey:'deadline-'+tag()});
    expect(JSON.parse(created.slice(created.indexOf('\n\n')+2))).toEqual({dueAtResolution:receipt});
    const taskId = /full id: ([0-9a-f-]{36})/.exec(created)?.[1];expect(taskId).toBeDefined();
    await grant('task',taskId!);
    const point = async () => {
      // REST point read uses the owning login session; an MCP-pinned key is
      // intentionally not reused as an API-transport credential.
      const read = await call(OWNER,'GET',`/tasks/${taskId}`);expect(read.status).toBe(200);return read.json.task.dueAt;
    };
    expect(await point()).toBe(receipt.instant);
    const updated = await invoke('update',{task:taskId,dueAt});
    expect(JSON.parse(updated.slice(updated.indexOf('\n\n')+2))).toEqual({dueAtResolution:receipt});
    expect(await point()).toBe(receipt.instant);
    const iso = await invoke('update',{task:taskId,dueAt:receipt.instant});
    expect(iso).not.toContain('dueAtResolution');expect(await point()).toBe(receipt.instant);
    for(const verb of ['create','update']) {
      const args=verb==='create'?{title:'Rejected MCP deadline',project:OWNER_PROJECT,idempotencyKey:'gap-'+tag()}:{task:taskId};
      await expect(invoke(verb,{...args,dueAt:{local:'2026-03-29T02:30:00',zone:'Europe/Warsaw'}})).rejects.toThrow('INVALID_DUE_AT_LOCAL_TIME');
    }
    expect(await point()).toBe(receipt.instant);
  });
});
