/**
 * aad1894b / 91af25a6 — LINKING A REPORT TO A TASK IS AN OWNERSHIP DECISION,
 * AND IT IS DECIDED AGAINST THE CANONICAL AUTHOR COLUMN.
 *
 * `TaskElementService.linkReport` authorizes attaching an existing Report to a
 * Task with three arms: root, "you wrote it", or "this Task already carries
 * it". The middle arm compared `reports.author_actor_id` — the UNTAGGED
 * provenance string — to the acting principal's UUID, and that column carries
 * two different encodings from two live writers:
 *
 *   `routes/reports.ts`      stores `req.userId`, the authenticated HANDLE;
 *   `TaskElementService`     stores the acting principal's UUID.
 *
 * One comparison, two spellings, and it was wrong in BOTH directions:
 *
 *   91af25a6 — THE AUTHOR WAS REFUSED. A principal that filed a Report through
 *   `POST /reports` and then named it while appending to, or finishing, its own
 *   Task was answered 400 `REPORT_NOT_LINKABLE` on its own Report. The row
 *   spelled its author as a handle; the predicate offered a UUID. Fail-closed,
 *   and a surface that did not work for the writer it was built for.
 *
 *   aad1894b — A STRANGER WAS ADMITTED. `HANDLE_PATTERN`
 *   (`utils/credentialAuthority.ts`) admits a UUID-shaped handle, so principal
 *   A's handle can BE principal B's id. A Report A filed through REST then
 *   carries `author_actor_id = A.handle = B.id`, and B passed the own-Report
 *   arm on A's Report: B could attach another principal's Report to a Task of
 *   B's own choosing — a write to A's row, and, through the access-vehicle
 *   recompute that rides the same transaction, a conferral.
 *
 * The repair is one column: `author_principal_id`, a UUID from both writers and
 * a foreign key to `principals(id)`, which cannot collide with a handle and is
 * already what `AuthorizationRepository.sqlResource('report')` reads as owner.
 *
 * ── THE PROPERTY ──
 *
 * Over one Report and four callers — its author, the principal whose id the
 * author's handle spells, an unrelated principal, and root — the own-Report arm
 * admits exactly the AUTHOR and root. It is a matrix over the arms this repair
 * touches, not a universal quantifier over the authorization surface: Access
 * Profiles, grants and group membership decide whether a caller may write the
 * TASK at all, and this suite builds each caller its own Task so that gate is
 * open for every row in the matrix and the ownership arm is the thing measured.
 *
 * ── THE ANCHORS, AND WHY THE FIXTURES CANNOT BE VACUOUS ──
 *
 * The collision is not asserted, it is READ BACK: the suite proves A's handle
 * equals B's id in `principals`, that both principals exist, and that the
 * Report row `POST /reports` actually wrote carries the handle spelling. And
 * before any behavioural claim, it measures BOTH predicates against the very
 * rows the matrix runs on and requires them to DISAGREE — so a fixture that had
 * quietly stopped discriminating the repaired predicate from the ambiguous one
 * fails here rather than passing everything downstream.
 *
 * ── WHY IT IS NOT IN THE DEFAULT JEST RUN ──
 *
 * It connects to `RELAYHALL_TEST_DB_URL` and FAILS — never skips — when the
 * variable is unset. The predicate under test is SQL over a collision that only
 * PostgreSQL can resolve, and a mocked pool hands back a row already chosen:
 * it can only replay the rule this gate exists to measure. Excluded by
 * `testPathIgnorePatterns`, run by `npm run test:report-link` on the VM gate
 * chain and UNCONDITIONALLY in CI against the `services: postgres` block.
 *
 * ── THE DESTRUCTIVE CONTRACT, STATED ──
 *
 * This suite WRITES to principals, projects, tasks, reports, task_references,
 * task_stream_entries, task_stream_quarantine, auth_sessions and feed events.
 * It refuses any URL naming a deployment database (`relayhall_dev`,
 * `relayhall_tst`, `relayhall_prod`, `relayhall`). Bring the database up with
 * `database/init.sql` and `npm run migrate`, and throw it away afterwards.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// ─────────────────────────── the database contract ───────────────────────────

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error(
    'RELAYHALL_TEST_DB_URL is not set. This gate measures who may link a Report to a Task against a REAL '
    + 'PostgreSQL, over two principals whose identifiers collide. It refuses to skip: the predicate under '
    + 'test is SQL and the collision is resolved by the database. Create a disposable database, load '
    + 'database/init.sql, run npm run migrate, and set RELAYHALL_TEST_DB_URL to it.',
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
process.env.JWT_SECRET = process.env.JWT_SECRET || 'report-link-suite-secret-0123456789abcdef';
process.env.RELAYHALL_SESSIONS = 'on';
// The auto-promotion cap is a deployment setting, and the ownership half of
// this suite measures whose Reports it counts. One is the smallest cap that can
// be reached and re-reached inside a test run; the suite sets it for itself
// rather than depending on how the machine that runs it is configured.
process.env.TASK_STREAM_AUTO_PROMOTION_PER_HOUR = '1';

const express = require('express');

const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { TASK_STREAM_ENTRY_LIMIT } = require('../services/TaskElementService');

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
  handle: string;
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

/** The Report's author. Its HANDLE is a UUID — and it is B's id. */
let AUTHOR: Caller;
/** The collided principal: `AUTHOR.handle === COLLIDED.principalId`. */
let COLLIDED: Caller;
/** Neither the author nor collided with it. The ordinary refusal. */
let STRANGER: Caller;
/** Role `admin`, which reaches the `root` sentinel scope. */
let ROOT: Caller;

/** One Task per caller, each owned by that caller, so every row in the matrix
 * clears the Task-write gate and the OWNERSHIP arm is what decides. */
const TASKS: Record<string, string> = {};

/** What `POST /reports` wrote for AUTHOR: the handle spelling. */
let REST_REPORT: string;
/** A historical row: provenance present, canonical author NULL (migration 063
 * could not attribute it). Its provenance string spells STRANGER's id. */
let UNATTRIBUTED_REPORT: string;
/** Already carried by STRANGER's Task before anyone tries to link it. */
let ALREADY_LINKED_REPORT: string;

async function makeAccount(role: string, handle?: string): Promise<{ id: string; handle: string }> {
  const chosen = handle ?? `report-link-${tag()}`;
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $2, 'active', $3) RETURNING id, handle`,
    [chosen, `report link suite ${role}`, role],
  );
  return { id: String(result.rows[0].id), handle: String(result.rows[0].handle) };
}

/** A login session, exactly as the SSO return path mints one. */
async function sessionCallerFor(label: string, account: { id: string; handle: string }): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId: account.id });
  return {
    label,
    principalId: account.id,
    handle: account.handle,
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` },
  };
}

async function makeProject(owner: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO projects (name, status, visibility, owner_principal_id)
     VALUES ($1, 'active', 'private', $2) RETURNING id`,
    [`report link ${tag()}`, owner],
  );
  return String(result.rows[0].id);
}

async function makeTask(owner: string, status = 'todo'): Promise<string> {
  const projectId = await makeProject(owner);
  const result = await pool.query(
    `INSERT INTO tasks (title, status, visibility, project_id, owner_principal_id,
                        creator_principal_id, shepherd_principal_id)
     VALUES ($1, $2, 'private', $3, $4, $4, $4) RETURNING id`,
    [`report link task ${tag()}`, status, projectId, owner],
  );
  return String(result.rows[0].id);
}

/** A Report row written straight to the table, for the two shapes no live
 * writer produces on demand: a historical row with no canonical author, and a
 * row already carried by a Task. */
async function insertReport(actorId: string | null, principalId: string | null, taskIds: string[]): Promise<string> {
  const result = await pool.query(
    `INSERT INTO reports (title, content, author, author_actor_id, author_principal_id, visibility, task_ids)
     VALUES ($1, 'report link body', 'report-link-suite', $2, $3, 'default', $4::uuid[]) RETURNING id`,
    [`report link ${tag()}`, actorId, principalId, taskIds],
  );
  return String(result.rows[0].id);
}

const reportRow = async (reportId: string): Promise<any> => {
  const result = await pool.query(
    'SELECT author_actor_id, author_principal_id, task_ids, auto_promoted FROM reports WHERE id = $1',
    [reportId],
  );
  return result.rows[0];
};

const carriesTask = async (reportId: string, taskId: string): Promise<boolean> => {
  const row = await reportRow(reportId);
  return (row.task_ids || []).map(String).includes(taskId);
};

const referenceCount = async (taskId: string, reportId: string): Promise<number> => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS n FROM task_references
      WHERE task_id = $1 AND kind = 'report' AND target_id = $2`,
    [taskId, reportId],
  );
  return result.rows[0].n;
};

/** An entry over the stream limit, which is what triggers auto-promotion. */
const oversized = (): string => 'o'.repeat(TASK_STREAM_ENTRY_LIMIT + 64);

beforeAll(async () => {
  await new Promise<void>((resolve) => { server = buildApp().listen(0, '127.0.0.1', () => resolve()); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // COLLIDED first: the AUTHOR's handle has to BE its id, and that is the
  // collision the whole suite turns on.
  const collided = await makeAccount('user');
  COLLIDED = await sessionCallerFor('collided principal', collided);
  const author = await makeAccount('user', collided.id);
  AUTHOR = await sessionCallerFor('report author', author);
  STRANGER = await sessionCallerFor('stranger', await makeAccount('user'));
  ROOT = await sessionCallerFor('root', await makeAccount('admin'));

  for (const who of [AUTHOR, COLLIDED, STRANGER, ROOT]) {
    TASKS[who.label] = await makeTask(who.principalId);
  }

  // The row under test is written by the PRODUCTION REST writer, as its author.
  const filed = await call(AUTHOR, 'POST', '/reports', {
    title: `report link rest ${tag()}`,
    content: 'a Report its author filed through the REST surface',
  });
  expect(`file a Report: ${filed.status}`).toBe('file a Report: 201');
  REST_REPORT = String(filed.json.report.id);

  UNATTRIBUTED_REPORT = await insertReport(STRANGER.principalId, null, []);
  ALREADY_LINKED_REPORT = await insertReport(null, null, [TASKS[STRANGER.label]]);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

/** The act under test, through the production router: name an existing Report
 * while appending to a Task. */
const link = (who: Caller, reportId: string): Promise<Answer> => call(
  who, 'POST', `/tasks/${TASKS[who.label]}/stream`,
  { content: `linking ${reportId}`, reportId },
);

// ───────────────── the fixtures are real, and they discriminate ──────────────

describe('the collision is real, and the two predicates disagree on it', () => {
  it('the AUTHOR\'s handle IS the COLLIDED principal\'s id', async () => {
    const rows = await pool.query('SELECT handle FROM principals WHERE id = $1', [AUTHOR.principalId]);
    expect(`author handle equals collided id: ${rows.rows[0].handle === COLLIDED.principalId}`)
      .toBe('author handle equals collided id: true');
    // Both principals exist, so both readings of the string name a real
    // identity — the collision is a genuine ambiguity, not a dangling value.
    const both = await pool.query(
      'SELECT count(*)::int AS n FROM principals WHERE id = ANY($1::uuid[])',
      [[AUTHOR.principalId, COLLIDED.principalId]],
    );
    expect(`both principals present: ${both.rows[0].n}`).toBe('both principals present: 2');
  });

  it('POST /reports really wrote the HANDLE spelling beside the canonical id', async () => {
    // Not assumed from the route's source: read back from the row. If the REST
    // writer ever stops storing the handle, this fixture stops reproducing the
    // defect and the suite says so here instead of passing everything below.
    const row = await reportRow(REST_REPORT);
    expect(`provenance: ${row.author_actor_id}`).toBe(`provenance: ${AUTHOR.handle}`);
    expect(`provenance is the collided id: ${row.author_actor_id === COLLIDED.principalId}`)
      .toBe('provenance is the collided id: true');
    expect(`canonical author: ${row.author_principal_id}`).toBe(`canonical author: ${AUTHOR.principalId}`);
  });

  it('the ambiguous predicate and the canonical one answer DIFFERENTLY on these rows', async () => {
    // The non-vacuity control for everything below. Both predicates are put to
    // PostgreSQL against the exact rows the matrix runs on. If they agreed, the
    // behavioural assertions would hold for the broken predicate too, and this
    // suite would be measuring nothing.
    const disagreement = await pool.query(
      `SELECT (author_actor_id = $2) AS ambiguous,
              (author_principal_id = $2::uuid) AS canonical
         FROM reports WHERE id = $1`,
      [REST_REPORT, COLLIDED.principalId],
    );
    expect(`collided caller — ambiguous: ${disagreement.rows[0].ambiguous}, canonical: ${disagreement.rows[0].canonical}`)
      .toBe('collided caller — ambiguous: true, canonical: false');

    const authorSide = await pool.query(
      `SELECT (author_actor_id = $2) AS ambiguous,
              (author_principal_id = $2::uuid) AS canonical
         FROM reports WHERE id = $1`,
      [REST_REPORT, AUTHOR.principalId],
    );
    expect(`author — ambiguous: ${authorSide.rows[0].ambiguous}, canonical: ${authorSide.rows[0].canonical}`)
      .toBe('author — ambiguous: false, canonical: true');
  });
});

// ───────────────────────── 91af25a6: the author is admitted ──────────────────

describe('91af25a6 — the author can link the Report it wrote', () => {
  it('appending names the author\'s own REST-filed Report, and it links', async () => {
    const answer = await link(AUTHOR, REST_REPORT);
    expect(`author links own Report: ${answer.status} ${answer.json?.code ?? ''}`.trim())
      .toBe('author links own Report: 201');
    expect(`Task carried: ${await carriesTask(REST_REPORT, TASKS[AUTHOR.label])}`).toBe('Task carried: true');
    // The link is the whole act, not just the array: the Task reference the
    // same transaction writes is what the Task surface renders.
    expect(`reference rows: ${await referenceCount(TASKS[AUTHOR.label], REST_REPORT)}`).toBe('reference rows: 1');
  });

  it('FINISH names it too — the other call site of the same arm', async () => {
    // `linkReport` is reached from the atomic finish as well as from append,
    // and the card names both. A repair applied to one caller would leave the
    // other refusing, so the finish path is measured, not inferred.
    const finishTask = await makeTask(AUTHOR.principalId, 'in-progress');
    const report = await call(AUTHOR, 'POST', '/reports', {
      title: `report link finish ${tag()}`, content: 'filed through REST, named at finish',
    });
    expect(`file: ${report.status}`).toBe('file: 201');
    const reportId = String(report.json.report.id);

    const answer = await call(AUTHOR, 'POST', `/tasks/${finishTask}/finish`, {
      handover: 'handing back', reportId,
    });
    expect(`author finishes naming own Report: ${answer.status} ${answer.json?.code ?? ''}`.trim())
      .toBe('author finishes naming own Report: 200');
    expect(`Task carried: ${await carriesTask(reportId, finishTask)}`).toBe('Task carried: true');
  });
});

// ──────────────── aad1894b: the collided principal is refused ────────────────

describe('aad1894b — the mirror collision does not admit the wrong principal', () => {
  it('the principal whose id the provenance string spells is REFUSED', async () => {
    const answer = await link(COLLIDED, REST_REPORT);
    expect(`collided principal links another\'s Report: ${answer.status} ${answer.json?.code}`)
      .toBe('collided principal links another\'s Report: 400 REPORT_NOT_LINKABLE');
  });

  it('and the refusal left the author\'s row alone', async () => {
    // A refusal that had already appended the Task id would be the disclosure
    // this repair exists for, arriving with a 400 on top of it.
    expect(`collided Task carried: ${await carriesTask(REST_REPORT, TASKS[COLLIDED.label])}`)
      .toBe('collided Task carried: false');
    expect(`reference rows: ${await referenceCount(TASKS[COLLIDED.label], REST_REPORT)}`).toBe('reference rows: 0');
  });

  it('the whole append is refused — no stream entry survives it', async () => {
    // The link rides the append's transaction. If the entry landed and only
    // the link rolled back, the caller would have written to its Task on the
    // strength of a Report it may not name.
    const entries = await pool.query(
      `SELECT COUNT(*)::int AS n FROM task_stream_entries
        WHERE task_id = $1 AND author_principal_id = $2`,
      [TASKS[COLLIDED.label], COLLIDED.principalId],
    );
    expect(`stream entries on the collided Task: ${entries.rows[0].n}`).toBe('stream entries on the collided Task: 0');
  });
});

// ───────────────────── the ordinary refusals, and NULL ───────────────────────

describe('a Report is linkable by its owner, and NULL is not an owner', () => {
  it('an unrelated principal is refused', async () => {
    const answer = await link(STRANGER, REST_REPORT);
    expect(`stranger links another\'s Report: ${answer.status} ${answer.json?.code}`)
      .toBe('stranger links another\'s Report: 400 REPORT_NOT_LINKABLE');
  });

  it('a row with NO canonical author is owned by NOBODY — including the principal its provenance string names', async () => {
    // The fail-closed half, and the historical shape: migration 063 left
    // `author_principal_id` NULL wherever it could not attribute the row, and
    // `author_actor_id` still spells a real principal's identifier. Under the
    // old predicate that string WAS the authorization. It is not one now.
    const row = await reportRow(UNATTRIBUTED_REPORT);
    expect(`fixture provenance: ${row.author_actor_id}`).toBe(`fixture provenance: ${STRANGER.principalId}`);
    expect(`fixture canonical author: ${row.author_principal_id}`).toBe('fixture canonical author: null');

    const answer = await link(STRANGER, UNATTRIBUTED_REPORT);
    expect(`link an unattributed Report: ${answer.status} ${answer.json?.code}`)
      .toBe('link an unattributed Report: 400 REPORT_NOT_LINKABLE');
    expect(`Task carried: ${await carriesTask(UNATTRIBUTED_REPORT, TASKS[STRANGER.label])}`)
      .toBe('Task carried: false');
  });
});

// ───────────── the arms the repair did not touch still admit ─────────────────

describe('the other two arms are unchanged — the repair is not a shutter', () => {
  it('root links a Report it did not write', async () => {
    const answer = await link(ROOT, REST_REPORT);
    expect(`root links: ${answer.status} ${answer.json?.code ?? ''}`.trim()).toBe('root links: 201');
    expect(`Task carried: ${await carriesTask(REST_REPORT, TASKS[ROOT.label])}`).toBe('Task carried: true');
  });

  it('a Report the Task already carries stays linkable by that Task\'s writer', async () => {
    const answer = await link(STRANGER, ALREADY_LINKED_REPORT);
    expect(`already-carried Report: ${answer.status} ${answer.json?.code ?? ''}`.trim())
      .toBe('already-carried Report: 201');
    expect(`reference rows: ${await referenceCount(TASKS[STRANGER.label], ALREADY_LINKED_REPORT)}`)
      .toBe('reference rows: 1');
  });
});

// ─────────────── the second census site: the auto-promotion cap ──────────────

describe('the auto-promotion cap counts the promoting principal\'s own Reports', () => {
  /**
   * `promotionAllowed` is the other place in this file that compared the
   * provenance string to a principal, and it is an ownership decision too:
   * "how many auto-promoted Reports are THIS principal's, this hour". It now
   * reads `author_principal_id`.
   *
   * What these tests measure is stated plainly, because the repair's own
   * warrant is narrow: `auto_promoted = TRUE` has ONE writer in the tree, and
   * that writer puts the SAME UUID into both columns, so the swap preserves the
   * count on every row the product can produce. These are therefore a
   * REGRESSION GUARD on the cap and on the ownership of what it counts — that
   * an auto-promoted Report is owned by the principal that promoted it, and
   * that the cap is per-principal — not a red proof that the column changed an
   * answer. Nothing here would redden on the swap alone, and saying so is the
   * point: the guard is what makes the two columns stay in step.
   */
  let promoted: string;

  it('an oversized append promotes, and the Report is OWNED by the promoting principal', async () => {
    const answer = await call(COLLIDED, 'POST', `/tasks/${TASKS[COLLIDED.label]}/stream`, { content: oversized() });
    expect(`oversized append: ${answer.status}`).toBe('oversized append: 201');
    expect(`promoted a Report: ${Boolean(answer.json?.reportId)}`).toBe('promoted a Report: true');
    promoted = String(answer.json.reportId);

    const row = await reportRow(promoted);
    expect(`auto promoted: ${row.auto_promoted}`).toBe('auto promoted: true');
    // The property the cap's repair rests on: the canonical column is written,
    // and it names the promoting principal. If this writer ever stopped filling
    // it, the cap would silently stop counting and this test says so.
    expect(`canonical author: ${row.author_principal_id}`).toBe(`canonical author: ${COLLIDED.principalId}`);
    expect(`provenance: ${row.author_actor_id}`).toBe(`provenance: ${COLLIDED.principalId}`);
  });

  it('the same principal\'s next oversized append is quarantined, not promoted', async () => {
    const answer = await call(COLLIDED, 'POST', `/tasks/${TASKS[COLLIDED.label]}/stream`, { content: oversized() });
    expect(`second oversized append: ${answer.status}`).toBe('second oversized append: 201');
    expect(`quarantined: ${Boolean(answer.json?.quarantineId)}`).toBe('quarantined: true');
    expect(`promoted again: ${Boolean(answer.json?.reportId)}`).toBe('promoted again: false');
  });

  it('a DIFFERENT principal is not charged for it', async () => {
    // The cap is per-principal. A count that had drifted onto the wrong owner
    // — which is what an ambiguous comparison invites — would refuse this one.
    const answer = await call(STRANGER, 'POST', `/tasks/${TASKS[STRANGER.label]}/stream`, { content: oversized() });
    expect(`another principal's first oversized append: ${answer.status}`).toBe('another principal\'s first oversized append: 201');
    expect(`promoted: ${Boolean(answer.json?.reportId)}`).toBe('promoted: true');
  });
});

// ───────────────────────────── the source backstop ───────────────────────────

describe('the census, as a backstop', () => {
  /**
   * A source census cannot see whether a predicate RAN — that is what
   * everything above is for. What it can see is a NEW comparison arriving in
   * this file, on a path no fixture here happens to cross. It is the backstop,
   * and it is stated as one.
   */
  const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'TaskElementService.ts'), 'utf8',
  );

  it('the own-Report arm names the canonical author column', () => {
    expect(SOURCE).toContain('($3::boolean OR author_principal_id = $4::uuid OR $1::uuid = ANY(task_ids))');
  });

  it('the cap names it too', () => {
    expect(SOURCE).toContain('WHERE auto_promoted = TRUE AND author_principal_id = $1::uuid');
  });

  it('the provenance string is bound to a parameter in exactly one place, and it is a WRITE', () => {
    // Both census sites, and any third one a later change might add. The column
    // may still be WRITTEN and READ here — it is provenance, and an audit needs
    // it — but it may not be bound against an identity in a decision. Rather
    // than trying to tell a comparison from an assignment by pattern, the whole
    // set is pinned: one line, quoted, and it is the redaction UPDATE's SET.
    const bound = SOURCE.split('\n')
      .filter((line) => /author_actor_id\s*=\s*\$/.test(line))
      .map((line) => line.trim());
    expect(bound).toEqual(['author = $5, author_actor_id = $6,']);
  });

  it('nothing compares the provenance string in TypeScript either', () => {
    const jsComparisons = SOURCE.split('\n')
      .filter((line) => /author_actor_id\s*(===|!==|==\s|!=\s)/.test(line))
      .map((line) => line.trim());
    expect(jsComparisons).toEqual([]);
  });
});
