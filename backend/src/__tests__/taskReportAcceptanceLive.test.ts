/** Task Report correction real-PostgreSQL gate. Runs with test:report-link only;
 * deployment databases are refused. Inherits canonical-author link fixtures;
 * adds mandatory logical-key save/reconciliation, middleware persistence fault,
 * genuine terminal human ancestry, revocation, rollback and concurrent finish.
 * Fault triggers/spies are test-only; storage and mounted routes are real PG.
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


// Author correction regressions: real disposable PostgreSQL and mounted REST.
const keyed=async(who:Caller,task:string,body:any,key:string)=>{
 const response=await fetch(`${origin}/tasks/${task}/reports`,{method:'POST',headers:{'Content-Type':'application/json',...who.headers,'Idempotency-Key':key},body:JSON.stringify(body)});
 return {status:response.status,json:await response.json() as any};
};
test('PG keyed save and exact read reconciliation return one committed Report',async()=>{
 const task=await makeTask(AUTHOR.principalId,'in-progress');const body={title:'Keyed progress',content:'durable logical output'};const key=`correction-save-${tag()}`;
 const first=await keyed(AUTHOR,task,body,key);expect(first.status).toBe(201);
 const again=await keyed(AUTHOR,task,body,key);expect(again.status).toBe(409);
 const read=await call(AUTHOR,'GET',`/tasks/${task}/report-operations/${key}?requestHash=${first.json.operation.requestHash}`);expect(read.status).toBe(200);expect(read.json.report.id).toBe(first.json.report.id);
 expect((await pool.query('SELECT count(*)::int n FROM reports WHERE source_task_id=$1',[task])).rows[0].n).toBe(1);
 await pool.query('UPDATE reports SET content=$2,content_hash=$3 WHERE id=$1',[first.json.report.id,'changed after save','f'.repeat(64)]);
 expect((await call(AUTHOR,'GET',`/tasks/${task}/report-operations/${key}?requestHash=${first.json.operation.requestHash}`)).status).toBe(409);
 await pool.query('UPDATE tasks SET owner_principal_id=$2 WHERE id=$1',[task,COLLIDED.principalId]);
 expect((await call(AUTHOR,'GET',`/tasks/${task}/report-operations/${key}?requestHash=${first.json.operation.requestHash}`)).status).toBe(403);
});
test('PG unkeyed create is refused without writing',async()=>{
 const task=await makeTask(AUTHOR.principalId,'in-progress');const response=await call(AUTHOR,'POST',`/tasks/${task}/reports`,{title:'no key',content:'no key'});expect(response.status).toBe(400);
 expect((await pool.query('SELECT count(*)::int n FROM reports WHERE source_task_id=$1',[task])).rows[0].n).toBe(0);
});
test('PG genuine canonical-author reference retains terminal human reader; unlink and reassignment revoke',async()=>{
 const task=await makeTask(AUTHOR.principalId,'in-progress');await pool.query('UPDATE tasks SET verifier_principal_id=$2 WHERE id=$1',[task,STRANGER.principalId]);
 const first=await keyed(AUTHOR,task,{title:'terminal evidence',content:'private evidence'},`terminal-${tag()}`);expect(first.status).toBe(201);
 await pool.query("UPDATE tasks SET status='completed' WHERE id=$1",[task]);
 await pool.query('DELETE FROM access_vehicle_links WHERE task_id=$1',[task]);
 expect((await call(STRANGER,'GET',`/reports/${first.json.report.id}`)).status).toBe(200);
 await pool.query('UPDATE tasks SET verifier_principal_id=$2 WHERE id=$1',[task,COLLIDED.principalId]);
 expect((await call(STRANGER,'GET',`/reports/${first.json.report.id}`)).status).toBe(404);
 await pool.query("DELETE FROM task_references WHERE task_id=$1 AND kind='report'",[task]);
 expect((await call(COLLIDED,'GET',`/reports/${first.json.report.id}`)).status).toBe(404);
});

test('PG live human parent audience revokes on expired/revoked/inactive/cyclic chain',async()=>{
 const task=await makeTask(AUTHOR.principalId,'in-progress');const made=await keyed(AUTHOR,task,{title:'ancestor evidence',content:'private'},`ancestor-${tag()}`);expect(made.status).toBe(201);
 const child=(await pool.query("INSERT INTO principals(kind,handle,display_name,status,parent_principal_id) VALUES ('service',$1,'test verifier','active',$2) RETURNING id",[`service-${tag()}`,STRANGER.principalId])).rows[0].id;
 const credential=(await pool.query("INSERT INTO principal_credentials(principal_id,credential_type,secret_hash,scopes,expires_at) VALUES($1,'api_key','offline-test','[\"tasks:read\"]',clock_timestamp()+interval '1 hour') RETURNING id",[child])).rows[0].id;
 await pool.query("UPDATE tasks SET verifier_principal_id=$2,status='completed' WHERE id=$1",[task,child]);
 const read=()=>call(STRANGER,'GET',`/reports/${made.json.report.id}`);
 expect((await read()).status).toBe(200);
 await pool.query('UPDATE principal_credentials SET revoked_at=clock_timestamp() WHERE id=$1',[credential]);expect((await read()).status).toBe(404);
 await pool.query("UPDATE principal_credentials SET revoked_at=NULL,expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[credential]);expect((await read()).status).toBe(404);
 await pool.query("UPDATE principal_credentials SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",[credential]);
 await pool.query("UPDATE principals SET status='disabled' WHERE id=$1",[child]);expect((await read()).status).toBe(404);
 await pool.query('ALTER TABLE principals DISABLE TRIGGER USER');try{await pool.query("UPDATE principals SET status='active',parent_principal_id=id WHERE id=$1",[child]);expect((await read()).status).toBe(404);}finally{await pool.query('UPDATE principals SET parent_principal_id=$2 WHERE id=$1',[child,STRANGER.principalId]);await pool.query('ALTER TABLE principals ENABLE TRIGGER USER');}
 await pool.query('UPDATE principals SET parent_principal_id=$2 WHERE id=$1',[child,STRANGER.principalId]);expect((await read()).status).toBe(200);
 await pool.query('UPDATE task_references SET created_by_principal_id=$2 WHERE task_id=$1',[task,COLLIDED.principalId]);expect((await read()).status).toBe(404);
});
test('PG committed Report survives failed middleware receipt persistence and same-key takeover without duplicate',async()=>{
 const task=await makeTask(AUTHOR.principalId,'in-progress');const key=`middleware-${tag()}`;const body={title:'durable mapping',content:'one logical output'};
 await pool.query("CREATE FUNCTION author_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation='task.report.save' AND NEW.state='completed' THEN RAISE EXCEPTION 'test receipt persistence failure'; END IF; RETURN NEW; END $$");
 await pool.query('CREATE TRIGGER author_fail_receipt BEFORE UPDATE ON operation_idempotency_records FOR EACH ROW EXECUTE FUNCTION author_fail_receipt()');
 try{const failed=await keyed(AUTHOR,task,body,key);expect(failed.status).toBeGreaterThanOrEqual(500);}finally{await pool.query('DROP TRIGGER author_fail_receipt ON operation_idempotency_records');await pool.query('DROP FUNCTION author_fail_receipt()');}
 const committed=(await pool.query('SELECT * FROM task_report_operations WHERE task_id=$1',[task])).rows[0];expect(committed).toBeDefined();
 await pool.query("UPDATE operation_idempotency_records SET created_at=clock_timestamp()-interval '61 seconds' WHERE operation='task.report.save' AND idempotency_key=$1",[key]);
 const retry=await keyed(AUTHOR,task,body,key);expect(retry.status).toBe(201);expect(retry.json.report.id).toBe(committed.report_id);
 expect((await pool.query('SELECT count(*)::int n FROM reports WHERE source_task_id=$1',[task])).rows[0].n).toBe(1);
});

test('PG linkage failure rolls back Report and logical mapping together',async()=>{
 const task=await makeTask(AUTHOR.principalId,'in-progress');
 await pool.query("CREATE FUNCTION author_fail_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test link failure'; END $$");await pool.query('CREATE TRIGGER author_fail_link BEFORE INSERT ON task_references FOR EACH ROW EXECUTE FUNCTION author_fail_link()');
 try{expect((await keyed(AUTHOR,task,{title:'rollback',content:'rollback'},`rollback-${tag()}`)).status).toBe(500);}finally{await pool.query('DROP TRIGGER author_fail_link ON task_references');await pool.query('DROP FUNCTION author_fail_link()');}
 expect((await pool.query('SELECT count(*)::int n FROM reports WHERE source_task_id=$1',[task])).rows[0].n).toBe(0);expect((await pool.query('SELECT count(*)::int n FROM task_report_operations WHERE task_id=$1',[task])).rows[0].n).toBe(0);
});

test('PG session revoked while save waits for Task lock refuses without Report or mapping',async()=>{
 const fresh=await sessionCallerFor('blocked-author',{id:AUTHOR.principalId,handle:AUTHOR.handle});const task=await makeTask(AUTHOR.principalId,'in-progress');const lock=await pool.connect();
 await lock.query('BEGIN');await lock.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[task]);
 const answer=keyed(fresh,task,{title:'blocked',content:'blocked'},`blocked-${tag()}`);await new Promise(resolve=>setTimeout(resolve,100));
 await pool.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE principal_id=$1',[AUTHOR.principalId]);await lock.query('COMMIT');lock.release();
 expect((await answer).status).toBe(403);expect((await pool.query('SELECT count(*)::int n FROM reports WHERE source_task_id=$1',[task])).rows[0].n).toBe(0);
 AUTHOR=await sessionCallerFor('author',{id:AUTHOR.principalId,handle:AUTHOR.handle});
});
test('PG save and finish serialize on the same Task lock',async()=>{
 const task=await makeTask(AUTHOR.principalId,'in-progress');const first=await keyed(AUTHOR,task,{title:'racing',content:'before'},`before-${tag()}`);expect(first.status).toBe(201);
 const [save,finish]=await Promise.all([keyed(AUTHOR,task,{title:'racing',content:'after',reportId:first.json.report.id,expectedContentHash:first.json.report.content_hash},`race-${tag()}`),call(AUTHOR,'POST',`/tasks/${task}/finish`,{reportId:first.json.report.id,handover:'real concurrent handoff'})]);
 expect(finish.status).toBe(200);expect([200,409]).toContain(save.status);expect((await pool.query('SELECT status FROM tasks WHERE id=$1',[task])).rows[0].status).toBe('review');
 const after=await keyed(AUTHOR,task,{title:'late',content:'late',reportId:first.json.report.id,expectedContentHash:first.json.report.content_hash},`late-${tag()}`);expect(after.status).toBe(409);
});

test('PG recompute exception rolls back already-written Report/reference and operation',async()=>{
 const vehicle=require('../services/AccessVehicleService').accessVehicleService;const spy=jest.spyOn(vehicle,'recompute').mockRejectedValueOnce(new Error('test recompute failure'));
 const task=await makeTask(AUTHOR.principalId,'in-progress');try{expect((await keyed(AUTHOR,task,{title:'recompute rollback',content:'rollback'},`recompute-${tag()}`)).status).toBe(500);}finally{spy.mockRestore();}
 for(const table of ['reports','task_report_operations'])expect((await pool.query(`SELECT count(*)::int n FROM ${table} WHERE ${table==='reports'?'source_task_id':'task_id'}=$1`,[task])).rows[0].n).toBe(0);
 expect((await pool.query('SELECT count(*)::int n FROM task_references WHERE task_id=$1',[task])).rows[0].n).toBe(0);
});

test('PG legacy private standalone Report genuine author reference reaches current terminal parent human without grants',async()=>{
 const task=await makeTask(AUTHOR.principalId,'in-progress');const report=await insertReport(AUTHOR.handle,AUTHOR.principalId,[]);
 await pool.query("UPDATE reports SET visibility='private',origin='api',source_task_id=NULL WHERE id=$1",[report]);
 expect((await call(AUTHOR,'POST',`/tasks/${task}/stream`,{content:'canonical legacy evidence',reportId:report})).status).toBe(201);
 const child=(await pool.query("INSERT INTO principals(kind,handle,display_name,status,parent_principal_id) VALUES('service',$1,'legacy task owner','active',$2) RETURNING id",[`legacy-service-${tag()}`,STRANGER.principalId])).rows[0].id;
 await pool.query("INSERT INTO principal_credentials(principal_id,credential_type,secret_hash,scopes) VALUES($1,'api_key','test-only','[\"tasks:read\"]')",[child]);
 await pool.query("UPDATE tasks SET status='completed',creator_principal_id=$2,owner_principal_id=$2,shepherd_principal_id=$2,verifier_principal_id=NULL WHERE id=$1",[task,child]);
 expect((await call(STRANGER,'GET',`/reports/${report}`)).status).toBe(200);
 await pool.query('DELETE FROM task_references WHERE task_id=$1',[task]);expect((await call(STRANGER,'GET',`/reports/${report}`)).status).toBe(404);
});

// Explicit delegated ceilings apply even when current claimant supplies the role arm.
async function delegatedReportFixture(kind='service') {
 const principalService=require('../services/PrincipalService').principalService;
 const bound=kind==='agent'?await makeTask(AUTHOR.principalId,'in-progress'):null;
 const id=(await pool.query("INSERT INTO principals(kind,handle,status,parent_principal_id,purpose,own_expression,bound_task_id) VALUES($1,$2,'active',$3,'Report caps fixture',$4,$5) RETURNING id",[kind,`report-cap-${tag()}`,AUTHOR.principalId,JSON.stringify({scopes:'parent',objects:'parent'}),bound])).rows[0].id;
 const task=bound??await makeTask(id,'in-progress');await pool.query('UPDATE tasks SET owner_principal_id=$2 WHERE id=$1',[task,id]);await pool.query('UPDATE tasks SET verifier_principal_id=$2 WHERE id=$1',[task,STRANGER.principalId]);
 if(kind==='agent')await pool.query('UPDATE principals SET bound_task_id=$2 WHERE id=$1',[id,task]);
 await pool.query("INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id) VALUES('principal',$1,'task',$2,'read',$1)",[AUTHOR.principalId,task]);
 const issued=await principalService.issueCredential({principalId:id,scopes:['tasks:read','tasks:write'],transport:'any'},{handle:'fixture',authMethod:'system'});
 const caller:Caller={label:'delegated',principalId:id,handle:id,headers:{Authorization:`Bearer ${issued.fullKey}`}};
 return {id,task,issued,caller,project:(await pool.query('SELECT project_id FROM tasks WHERE id=$1',[task])).rows[0].project_id};
}
async function ownCaps(id:string,objects:any,scopes:any='parent') {await pool.query('UPDATE principals SET own_expression=$2 WHERE id=$1',[id,objects===null?null:JSON.stringify({scopes,objects})]);}
test.each(['exact','all-of-type','all-except','all-in-project'])('PG explicit %s write and read caps preserve claimant reporting without parent WRITE',async form=>{
 const f=await delegatedReportFixture();const ids=form==='all-of-type'?[]:form==='all-except'?[crypto.randomUUID()]:form==='all-in-project'?[f.project]:[f.task];
 await ownCaps(f.id,[{resourceType:'task',selectorForm:form,selectorIds:ids,verbs:['write']}]);
 const key=`cap-positive-${tag()}`,body={title:'cap positive',content:'exact output'};const saved=await keyed(f.caller,f.task,body,key);expect(saved.status).toBe(201);
 // READ is an independent scope/verb ceiling, not WRITE required by reconciliation.
 await ownCaps(f.id,[{resourceType:'task',selectorForm:form,selectorIds:ids,verbs:['read']}],['tasks:read']);
 await pool.query("UPDATE principal_credentials SET scopes='[\"tasks:read\"]'::jsonb WHERE id=$1",[f.issued.credentialId]);
 expect((await call(f.caller,'GET',`/tasks/${f.task}/report-operations/${key}?requestHash=${saved.json.operation.requestHash}`)).status).toBe(200);
});
test.each(['empty','null','wrong-exact','excluded','wrong-project','read-only'])('PG explicit %s refuses new save without Report or mapping',async mode=>{
 const f=await delegatedReportFixture();let objects:any=[];
 if(mode==='null')objects=null;
 if(mode==='wrong-exact')objects=[{resourceType:'task',selectorForm:'exact',selectorIds:[crypto.randomUUID()],verbs:['write']}];
 if(mode==='excluded')objects=[{resourceType:'task',selectorForm:'all-except',selectorIds:[f.task],verbs:['write']}];
 if(mode==='wrong-project')objects=[{resourceType:'task',selectorForm:'all-in-project',selectorIds:[crypto.randomUUID()],verbs:['write']}];
 if(mode==='read-only')objects=[{resourceType:'task',selectorForm:'exact',selectorIds:[f.task],verbs:['read']}];
 await ownCaps(f.id,objects);expect((await keyed(f.caller,f.task,{title:'deny',content:'deny'},`deny-${tag()}`)).status).toBe(403);
 for(const table of ['reports','task_report_operations'])expect((await pool.query(`SELECT count(*)::int n FROM ${table} WHERE ${table==='reports'?'source_task_id':'task_id'}=$1`,[f.task])).rows[0].n).toBe(0);
});
test('PG explicit objects exclusion during actual Task lock wait blocks save and later exact-key read',async()=>{
 const f=await delegatedReportFixture(),key=`original-${tag()}`;const saved=await keyed(f.caller,f.task,{title:'before',content:'before'},key);expect(saved.status).toBe(201);
 const lock=await pool.connect();await lock.query('BEGIN');await lock.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[f.task]);const pid=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 const pending=keyed(f.caller,f.task,{title:'after',content:'after'},`blocked-${tag()}`);
 let blocked=false;for(let i=0;i<100;i++){if((await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows.length){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}
 expect(blocked).toBe(true);await ownCaps(f.id,[]);await lock.query('COMMIT');lock.release();expect((await pending).status).toBe(403);
 expect((await pool.query('SELECT count(*)::int n FROM reports WHERE source_task_id=$1',[f.task])).rows[0].n).toBe(1);
 expect((await pool.query('SELECT count(*)::int n FROM task_report_operations WHERE task_id=$1',[f.task])).rows[0].n).toBe(1);
 expect((await call(f.caller,'GET',`/tasks/${f.task}/report-operations/${key}?requestHash=${saved.json.operation.requestHash}`)).status).toBe(403);
});
test('PG ancestor explicit empty cap excludes delegated claimant',async()=>{
 const f=await delegatedReportFixture('agent');const ancestor=(await pool.query("INSERT INTO principals(kind,handle,status,parent_principal_id,purpose,own_expression) VALUES('service',$1,'active',$2,'ancestor cap',$3) RETURNING id",[`ancestor-${tag()}`,AUTHOR.principalId,JSON.stringify({scopes:'parent',objects:[]})])).rows[0].id;
 await pool.query("INSERT INTO principal_credentials(principal_id,credential_type,secret_hash,scopes) VALUES($1,'api_key','test-only','[\"tasks:read\",\"tasks:write\"]')",[ancestor]);await pool.query('UPDATE principals SET parent_principal_id=$2 WHERE id=$1',[f.id,ancestor]);
 expect((await keyed(f.caller,f.task,{title:'ancestor',content:'ancestor'},`ancestor-cap-${tag()}`)).status).toBe(403);
});
test('PG Agent bound Task cap is retained',async()=>{
 const f=await delegatedReportFixture('agent');expect((await keyed(f.caller,f.task,{title:'bound',content:'bound'},`bound-${tag()}`)).status).toBe(201);
 await pool.query('UPDATE principals SET bound_task_id=$2 WHERE id=$1',[f.id,await makeTask(AUTHOR.principalId,'todo')]);expect((await keyed(f.caller,f.task,{title:'wrong bound',content:'wrong bound'},`wrong-bound-${tag()}`)).status).toBe(403);
});

test.each(['objects','credential-scopes','natural-expiry'])('PG exact-key read refreshes %s after actual lock wait',async mode=>{
 const f=await delegatedReportFixture(),key=`read-wait-${tag()}`;const saved=await keyed(f.caller,f.task,{title:'retained',content:'retained'},key);expect(saved.status).toBe(201);
 if(mode==='natural-expiry'){
  // Another credential keeps the chain alive; it cannot replace the presented credential.
  await pool.query("INSERT INTO principal_credentials(principal_id,credential_type,secret_hash,scopes) VALUES($1,'api_key','another-live-test','[\"tasks:read\",\"tasks:write\"]')",[f.id]);
  await pool.query("UPDATE principal_credentials SET expires_at=clock_timestamp()+interval '800 milliseconds' WHERE id=$1",[f.issued.credentialId]);
 }
 const lock=await pool.connect();await lock.query('BEGIN');await lock.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[f.task]);const pid=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 const pending=call(f.caller,'GET',`/tasks/${f.task}/report-operations/${key}?requestHash=${saved.json.operation.requestHash}`);
 let blocked=false;for(let i=0;i<100;i++){if((await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows.length){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}expect(blocked).toBe(true);
 if(mode==='objects')await ownCaps(f.id,[]);
 if(mode==='credential-scopes')await pool.query("UPDATE principal_credentials SET scopes='[\"tasks:write\"]'::jsonb WHERE id=$1",[f.issued.credentialId]);
 if(mode==='natural-expiry')await new Promise(resolve=>setTimeout(resolve,1000));
 await lock.query('COMMIT');lock.release();expect((await pending).status).toBe(403);
 expect((await pool.query('SELECT content_hash FROM reports WHERE id=$1',[saved.json.report.id])).rows[0].content_hash).toBe(saved.json.report.content_hash);
});

test.each(['objects','credential-scopes','credential-revoked'])('NEW mapped Task Report handoff refreshes %s after actual lock wait',async mode=>{
 const f=await delegatedReportFixture(),key=`mapped-handoff-${tag()}`,saved=await keyed(f.caller,f.task,{title:'actual mapped Task Report',content:'immutable mapped evidence'},key);expect(saved.status).toBe(201);
 const row=(await pool.query('SELECT r.*,o.task_id mapped_task,o.author_principal_id mapped_author FROM reports r JOIN task_report_operations o ON o.report_id=r.id WHERE r.id=$1',[saved.json.report.id])).rows[0];
 expect(row.origin).toBe('task-report');expect(row.source_task_id).toBe(f.task);expect(row.author_principal_id).toBe(f.id);expect(row.mapped_task).toBe(f.task);expect(row.mapped_author).toBe(f.id);
 const snapshot=async()=>({task:(await pool.query('SELECT * FROM tasks WHERE id=$1',[f.task])).rows,
  report:(await pool.query('SELECT * FROM reports WHERE id=$1',[saved.json.report.id])).rows,
  operations:(await pool.query('SELECT * FROM task_report_operations WHERE task_id=$1',[f.task])).rows,
  stream:(await pool.query('SELECT * FROM task_stream_entries WHERE task_id=$1 ORDER BY stream_offset',[f.task])).rows,
  references:(await pool.query('SELECT * FROM task_references WHERE task_id=$1 ORDER BY id',[f.task])).rows});
 const before=await snapshot(),lock=await pool.connect();await lock.query('BEGIN');await lock.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[f.task]);const pid=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 const pending=call(f.caller,'POST',`/tasks/${f.task}/finish`,{reportId:saved.json.report.id,handover:'current mapped output handoff'});
 try{
  let blocked=false;for(let i=0;i<100;i++){if((await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows.length){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}expect(blocked).toBe(true);
  if(mode==='objects')await ownCaps(f.id,[{resourceType:'task',selectorForm:'exact',selectorIds:[f.task],verbs:['read']}]);
  if(mode==='credential-scopes')await pool.query("UPDATE principal_credentials SET scopes='[\"tasks:read\"]'::jsonb WHERE id=$1",[f.issued.credentialId]);
  if(mode==='credential-revoked')await pool.query('UPDATE principal_credentials SET revoked_at=clock_timestamp() WHERE id=$1',[f.issued.credentialId]);
  await lock.query('COMMIT');expect((await pending).status).toBe(403);expect(await snapshot()).toEqual(before);
 }finally{await lock.query('ROLLBACK');lock.release();await pending;}
});
test('NEW mapped Task Report handoff preserves valid claimant without positive parent WRITE',async()=>{
 const f=await delegatedReportFixture();const saved=await keyed(f.caller,f.task,{title:'valid mapped',content:'valid mapped'},`valid-mapped-${tag()}`);expect(saved.status).toBe(201);
 expect((await call(f.caller,'POST',`/tasks/${f.task}/finish`,{reportId:saved.json.report.id,handover:'valid mapped handoff'})).status).toBe(200);
 expect((await pool.query('SELECT status FROM tasks WHERE id=$1',[f.task])).rows[0].status).toBe('review');
});
test.each(['foreign-task','foreign-author','missing-map','changed-hash'])('NEW mapped Task Report handoff rejects %s mapping without Task or stream effects',async mode=>{
 const f=await delegatedReportFixture(),saved=await keyed(f.caller,f.task,{title:'mapped',content:'mapped'},`mapping-${tag()}`);expect(saved.status).toBe(201);
 if(mode==='foreign-task')await pool.query('UPDATE task_report_operations SET task_id=$2 WHERE report_id=$1',[saved.json.report.id,await makeTask(AUTHOR.principalId)]);
 if(mode==='foreign-author')await pool.query('UPDATE task_report_operations SET author_principal_id=$2 WHERE report_id=$1',[saved.json.report.id,STRANGER.principalId]);
 if(mode==='missing-map')await pool.query('DELETE FROM task_report_operations WHERE report_id=$1',[saved.json.report.id]);
 if(mode==='changed-hash')await pool.query('UPDATE task_report_operations SET content_hash=$2 WHERE report_id=$1',[saved.json.report.id,'f'.repeat(64)]);
 const before=(await pool.query('SELECT * FROM task_stream_entries WHERE task_id=$1 ORDER BY stream_offset',[f.task])).rows;
 expect((await call(f.caller,'POST',`/tasks/${f.task}/finish`,{reportId:saved.json.report.id,handover:'invalid mapping'})).status).toBe(409);
 expect((await pool.query('SELECT status FROM tasks WHERE id=$1',[f.task])).rows[0].status).toBe('in-progress');expect((await pool.query('SELECT * FROM task_stream_entries WHERE task_id=$1 ORDER BY stream_offset',[f.task])).rows).toEqual(before);
});
// Card 50b5e9c4 round-1 B1. GET /tasks/:id/reports now answers summaries, never
// bodies. A delegated claimant whose credential carries tasks:read+tasks:write
// and NOT reports:read must still continue its own progress Report from a fresh
// session: find it, read its body and content hash, and edit with that hash.
test('PG delegated claimant without reports:read reads and edits its own progress Report through Task authority',async()=>{
 const f=await delegatedReportFixture();
 expect([...(await pool.query('SELECT scopes FROM principal_credentials WHERE id=$1',[f.issued.credentialId])).rows[0].scopes].sort()).toEqual(['tasks:read','tasks:write']);
 // The stored one-line summary is the head of the body by design (500 characters);
 // the tail past it marks the BODY, which no summary may carry.
 const body1=`first version ${'x'.repeat(1000)} CLAIMANT-TAIL-1`,body2=`second version ${'y'.repeat(1000)} CLAIMANT-TAIL-2`;
 const first=await keyed(f.caller,f.task,{title:'claimant progress',content:body1},`b1-save-${tag()}`);
 expect(first.status).toBe(201);const reportId=first.json.report.id,firstHash=first.json.report.content_hash;
 expect(firstHash).toMatch(/^[a-f0-9]{64}$/);
 // The list: a summary, no body, carrying the content hash an edit needs.
 const listed=await call(f.caller,'GET',`/tasks/${f.task}/reports?scope=progress`);
 expect(listed.status).toBe(200);
 expect(listed.json.reports.map((row:any)=>[row.id,row.contentHash,'content' in row])).toEqual([[reportId,firstHash,false]]);
 expect(listed.raw).not.toContain('CLAIMANT-TAIL');
 expect(listed.json.retrieval).toContain(`GET /api/tasks/${f.task}/reports/{reportId}`);
 // The Report read stays reports:read; the Task-authority read serves the body.
 expect((await call(f.caller,'GET',`/reports/${reportId}`)).status).toBe(403);
 const read=await call(f.caller,'GET',`/tasks/${f.task}/reports/${reportId}`);
 expect([read.status,read.json.report.id,read.json.report.content,read.json.report.content_hash])
  .toEqual([200,reportId,body1,firstHash]);
 // Edit with the hash read back, from that read alone.
 const edited=await keyed(f.caller,f.task,{reportId,title:'claimant progress',content:body2,expectedContentHash:read.json.report.content_hash},`b1-edit-${tag()}`);
 expect(edited.status).toBe(200);
 const again=await call(f.caller,'GET',`/tasks/${f.task}/reports/${reportId}`);
 expect([again.json.report.content,again.json.report.content_hash]).toEqual([body2,edited.json.report.content_hash]);
 expect(again.json.report.content_hash).not.toBe(firstHash);
 // The same path over MCP: the in-process registry, the same credential.
 const registry=require('../mcp/registry');
 const mcp=await registry.toolByName('relayhall_task_report_get').handler({task:f.task,reportId},{authorization:f.caller.headers.Authorization,toolName:'relayhall_task_report_get'});
 expect(mcp).toContain(`content_hash ${edited.json.report.content_hash}`);expect(mcp).toContain('CLAIMANT-TAIL-2');
 const mcpList=JSON.parse(await registry.toolByName('relayhall_task_report_list').handler({task:f.task,scope:'progress',response_format:'detailed'},{authorization:f.caller.headers.Authorization,toolName:'relayhall_task_report_list'}));
 expect(mcpList.reports.map((row:any)=>row.contentHash)).toEqual([edited.json.report.content_hash]);
 expect(JSON.stringify(mcpList)).not.toContain('CLAIMANT-TAIL');
 // Only this Task's progress Reports: another Report linked to the Task that the
 // claimant reads in its summaries is one 404 here, without its body.
 const linked=(await pool.query("INSERT INTO reports(title,content,summary,author,author_principal_id,visibility,task_ids,origin) VALUES('linked evidence','LINKED-ONLY-BODY','linked summary','fixture',$1,'private',ARRAY[$2::uuid],'api') RETURNING id",[f.id,f.task])).rows[0].id;
 const linkedList=await call(f.caller,'GET',`/tasks/${f.task}/reports`);
 expect(linkedList.json.reports.map((row:any)=>[row.id,row.contentHash])).toEqual([[linked,null],[reportId,edited.json.report.content_hash]]);
 const refused=await call(f.caller,'GET',`/tasks/${f.task}/reports/${linked}`);
 expect([refused.status,refused.json.code]).toEqual([404,'TASK_REPORT_NOT_FOUND']);expect(refused.raw).not.toContain('LINKED-ONLY-BODY');
});
test('legacy inline Report handoff remains compatible',async()=>{
 const f=await delegatedReportFixture();expect((await call(f.caller,'POST',`/tasks/${f.task}/finish`,{report:{title:'legacy inline',content:'legacy inline'},handover:'legacy handoff'})).status).toBe(200);
});

test.each([['save','expires_at'],['save','grace_until'],['finish','expires_at'],['finish','grace_until']])('legal Agent %s refreshes ancestor %s after actual Task lock wait',async(action,column)=>{
 const f=await delegatedReportFixture('agent');
 const ancestor=(await pool.query("INSERT INTO principals(kind,handle,status,parent_principal_id,purpose,own_expression) VALUES('service',$1,'active',$2,'legal Report ancestor',$3) RETURNING id",[`report-ancestor-${tag()}`,AUTHOR.principalId,JSON.stringify({scopes:'parent',objects:'parent'})])).rows[0].id;
 const cred=(await pool.query("INSERT INTO principal_credentials(principal_id,credential_type,secret_hash,scopes) VALUES($1,'api_key','disposable-ancestor','[\"tasks:read\",\"tasks:write\"]') RETURNING id",[ancestor])).rows[0].id;
 await pool.query('UPDATE principals SET parent_principal_id=$2 WHERE id=$1',[f.id,ancestor]);
 const first=await keyed(f.caller,f.task,{title:'actual Agent output',content:'bound evidence'},`agent-first-${tag()}`);expect(first.status).toBe(201);
 const snapshot=async()=>({task:(await pool.query('SELECT * FROM tasks WHERE id=$1',[f.task])).rows,report:(await pool.query('SELECT * FROM reports WHERE source_task_id=$1 ORDER BY id',[f.task])).rows,operations:(await pool.query('SELECT * FROM task_report_operations WHERE task_id=$1 ORDER BY operation_key',[f.task])).rows,stream:(await pool.query('SELECT * FROM task_stream_entries WHERE task_id=$1 ORDER BY stream_offset',[f.task])).rows,references:(await pool.query('SELECT * FROM task_references WHERE task_id=$1 ORDER BY id',[f.task])).rows});
 const before=await snapshot(),lock=await pool.connect();await lock.query('BEGIN');await lock.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[f.task]);const pid=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 const pending=action==='save'?keyed(f.caller,f.task,{title:'later output',content:'later'},`agent-blocked-${tag()}`):call(f.caller,'POST',`/tasks/${f.task}/finish`,{reportId:first.json.report.id,handover:'Agent handoff'});
 try{let blocked=false;for(let i=0;i<100;i++){if((await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rowCount){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}expect(blocked).toBe(true);
  await pool.query(`UPDATE principal_credentials SET ${column}=clock_timestamp()+interval '150 milliseconds' WHERE id=$1`,[cred]);await new Promise(resolve=>setTimeout(resolve,200));
  await lock.query('COMMIT');expect((await pending).status).toBe(403);expect(await snapshot()).toEqual(before);
 }finally{await lock.query('ROLLBACK');lock.release();await pending;}
});


// PR25 slice A (0e9eeb1e): the dashboard enables claimant Report controls from
// GET /tasks/{id}.reportMaintenanceAccess. Measure that projection on REAL PG
// against the locked save it mirrors: the current claimant is allowed with no
// grant of its own on the Task, a non-claimant and a frozen Task are refused,
// and the read itself writes no grant, Report or vehicle link.
test('PG GET Task reportMaintenanceAccess agrees with the locked save for claimant, non-claimant and frozen Task',async()=>{
 const task=await makeTask(AUTHOR.principalId,'in-progress');
 const census=async()=>(await pool.query(`SELECT
   (SELECT count(*)::int FROM grants WHERE resource_id=$1) AS grants,
   (SELECT count(*)::int FROM reports WHERE source_task_id=$1) AS reports,
   (SELECT count(*)::int FROM access_vehicle_links WHERE task_id=$1) AS links`,[task])).rows[0];
 const before=await census();
 expect(before.grants).toBe(0);
 const own=await call(AUTHOR,'GET',`/tasks/${task}`);expect(own.status).toBe(200);
 expect(own.json.task.reportMaintenanceAccess).toEqual({allowed:true,reason:null});
 const other=await call(ROOT,'GET',`/tasks/${task}`);expect(other.status).toBe(200);
 expect(other.json.task.reportMaintenanceAccess).toEqual({allowed:false,reason:'TASK_CLAIMANT_REQUIRED'});
 expect(await census()).toEqual(before);
 const saved=await keyed(AUTHOR,task,{title:'Display-allowed progress',content:'claimant draft'},`display-${tag()}`);
 expect(saved.status).toBe(201);
 const refused=await keyed(ROOT,task,{title:'Display-denied progress',content:'not the claimant'},`display-root-${tag()}`);
 expect(refused.status).toBe(403);expect(refused.json.code).toBe('TASK_CLAIMANT_REQUIRED');
 await pool.query("UPDATE tasks SET status='review' WHERE id=$1",[task]);
 const frozen=await call(AUTHOR,'GET',`/tasks/${task}`);expect(frozen.status).toBe(200);
 expect(frozen.json.task.reportMaintenanceAccess).toEqual({allowed:false,reason:'TASK_REPORT_FROZEN'});
 const late=await keyed(AUTHOR,task,{title:'Late progress',content:'after handoff'},`display-late-${tag()}`);
 expect(late.status).toBe(409);expect(late.json.code).toBe('TASK_REPORT_FROZEN');
 expect((await pool.query('SELECT count(*)::int n FROM reports WHERE source_task_id=$1',[task])).rows[0].n).toBe(1);
});

// F1: exercise the shared committing verdict path with REAL PG transactions.
// SQL below seeds only this disposable suite: it does not substitute for the
// public reporting/MCP fixture or manufacture ordinary caller authority.
describe('F1 completion access transaction', () => {
  const { TaskReviewAttemptService, hashReviewReports } = require('../services/TaskReviewAttemptService');
  const { taskManagerDB } = require('../services/TaskManagerDB');
  const ledger = new TaskReviewAttemptService(pool);

  async function reviewTask(states: string[] = []) {
    const taskId = await makeTask(AUTHOR.principalId, 'review');
    for (let index = 0; index < states.length; index++) {
      await pool.query(
        `INSERT INTO subtasks(task_id,index,title,status,note)
         VALUES($1,$2,$3,$4,'immutable synthetic evidence')`,
        [taskId, index, 'Synthetic criterion ' + index, states[index]],
      );
    }
    return taskId;
  }
  async function linkGrant(taskId: string, grantId: string, automatic = true) {
    await pool.query(
      `INSERT INTO access_vehicle_links(task_id,assignee_principal_id,landed_on_principal_id,
        vehicle_kind,target_kind,target_id,created_by_vehicle)
       VALUES($1,$2,$3,'auto-grant','grant',$4,$5)`,
      [taskId, AUTHOR.principalId, STRANGER.principalId, grantId, automatic],
    );
  }
  async function grant(taskId: string, automatic = true, resourceId = taskId) {
    const row = (await pool.query(
      `INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,provenance)
       VALUES('principal',$1,'task',$2,'read',$3) RETURNING id`,
      [STRANGER.principalId, resourceId, automatic ? 'assignment:grant' : null],
    )).rows[0];
    await linkGrant(taskId, row.id, automatic);
    return row.id as string;
  }
  async function begin(taskId: string, native = false) {
    const task = await taskManagerDB.getTask(taskId);
    const scope = native ? require('../utils/nativeReview').nativeReviewScope(
      { description: 'Synthetic task criterion' }, task.subtasks,
    ).scope : undefined;
    return ledger.beginAttempt(task, { reportDigest: hashReviewReports([]), evidence: 'immutable synthetic evidence' }, undefined, scope);
  }
  async function state(taskId: string, client = pool) {
    const task = (await client.query('SELECT status,completed_at,attempt_count FROM tasks WHERE id=$1', [taskId])).rows[0];
    const links = (await client.query('SELECT target_id FROM access_vehicle_links WHERE task_id=$1', [taskId])).rows;
    const attempts = (await client.query('SELECT status FROM task_review_attempts WHERE task_id=$1 ORDER BY attempt_no', [taskId])).rows;
    return { task, links, attempts };
  }
  const exists = async (id: string, client = pool) => (await client.query('SELECT id FROM grants WHERE id=$1', [id])).rowCount;
  const verdict = (id: string, client?: any) => ledger.recordVerdict(id, 'pass', [], { summary: 'Exact synthetic receipt accepted' }, undefined, false, client);

  test.each([
    ['flat', [], false], ['subtask', ['review', 'skipped'], false],
    ['native task final', ['completed'], true], ['native terminal slice', ['review', 'skipped'], true],
  ])('%s transition and teardown are invisible until the SAME transaction commits', async (_name, statuses, native) => {
    const taskId = await reviewTask(statuses as string[]), grantId = await grant(taskId), attempt = await begin(taskId, native as boolean);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect(await verdict(attempt.id, client)).toMatchObject({ status: 'completed', applied: true });
      expect((await state(taskId, client)).links).toHaveLength(0);
      expect(await exists(grantId, client)).toBe(0);
      const outside = await state(taskId);
      expect(outside.task.status).toBe('review'); expect(outside.links).toHaveLength(1);
      expect(outside.attempts).toEqual([{ status: 'running' }]); expect(await exists(grantId)).toBe(1);
      await client.query('COMMIT');
      const committed = await state(taskId);
      expect(committed.task.status).toBe('completed'); expect(committed.task.completed_at).toBeTruthy();
      expect(committed.links).toHaveLength(0); expect(committed.attempts).toEqual([{ status: 'passed' }]);
      expect(await exists(grantId)).toBe(0);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  test('caller rollback restores terminal write, links, target, ledger, subtask and feed together', async () => {
    const taskId = await reviewTask(['review']), grantId = await grant(taskId), attempt = await begin(taskId, true);
    const before = await state(taskId);
    const feedBefore = (await pool.query('SELECT count(*)::int AS n FROM feed_events WHERE object_id=$1', [taskId])).rows[0].n;
    const client = await pool.connect();
    try { await client.query('BEGIN'); await verdict(attempt.id, client); await client.query('ROLLBACK'); }
    finally { client.release(); }
    expect(await state(taskId)).toEqual(before); expect(await exists(grantId)).toBe(1);
    expect((await pool.query('SELECT status FROM subtasks WHERE task_id=$1', [taskId])).rows).toEqual([{ status: 'review' }]);
    expect((await pool.query('SELECT count(*)::int AS n FROM feed_events WHERE object_id=$1', [taskId])).rows[0].n).toBe(feedBefore);
  });

  test('a real teardown storage failure rolls back the internally committed verdict; retry succeeds', async () => {
    const taskId = await reviewTask(['review']), grantId = await grant(taskId), attempt = await begin(taskId);
    const before = await state(taskId);
    // Own synthetic database only; narrow fault by exact UUID and remove in finally.
    const name = 'f1_fault_' + tag();
    await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $fault$
      BEGIN IF OLD.id='${grantId}'::uuid THEN RAISE EXCEPTION 'F1 synthetic teardown failure'; END IF; RETURN OLD; END $fault$`);
    await pool.query(`CREATE TRIGGER ${name} BEFORE DELETE ON grants FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try {
      await expect(verdict(attempt.id)).rejects.toThrow('F1 synthetic teardown failure');
      expect(await state(taskId)).toEqual(before); expect(await exists(grantId)).toBe(1);
      expect((await pool.query('SELECT status FROM subtasks WHERE task_id=$1', [taskId])).rows).toEqual([{ status: 'review' }]);
      expect((await pool.query('SELECT cursor FROM feed_events WHERE object_id=$1', [taskId])).rows).toHaveLength(0);
      expect((await pool.query("SELECT id FROM audit_events WHERE resource_id=$1 AND action='grant.revoke'", [grantId])).rows).toHaveLength(0);
    } finally { await pool.query(`DROP TRIGGER ${name} ON grants; DROP FUNCTION ${name}()`); }
    expect(await verdict(attempt.id)).toMatchObject({ status: 'completed', applied: true });
    expect(await exists(grantId)).toBe(0);
  });

  test('manual/independent grants and shared automatic refcounts survive until the last linked task completes', async () => {
    const first = await reviewTask(), second = await reviewTask();
    const shared = await grant(first); await linkGrant(second, shared);
    const manual = await grant(first, false, crypto.randomUUID());
    const independent = (await pool.query(`INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb)
      VALUES('principal',$1,'task',$2,'write') RETURNING id`, [STRANGER.principalId, first])).rows[0].id;
    const protectedByProvenance = await grant(first, false, crypto.randomUUID());
    await pool.query('UPDATE access_vehicle_links SET created_by_vehicle=true WHERE target_id=$1', [protectedByProvenance]);
    const a = await begin(first), b = await begin(second);
    await verdict(a.id);
    expect((await state(first)).links).toHaveLength(0); expect((await state(second)).links).toHaveLength(1);
    expect(await exists(shared)).toBe(1);
    await verdict(b.id); expect(await exists(shared)).toBe(0);
    for (const id of [manual, independent, protectedByProvenance]) expect(await exists(id)).toBe(1);
  });

  test('concurrent identical verdicts and replay apply/reap exactly once', async () => {
    const taskId = await reviewTask(), grantId = await grant(taskId), attempt = await begin(taskId);
    const results = await Promise.all([verdict(attempt.id), verdict(attempt.id), verdict(attempt.id)]);
    expect(results.filter((r: any) => r.applied)).toHaveLength(1);
    expect(results.every((r: any) => r.status === 'completed')).toBe(true);
    expect(await verdict(attempt.id)).toMatchObject({ status: 'completed', applied: false });
    expect((await state(taskId)).links).toHaveLength(0); expect(await exists(grantId)).toBe(0);
    expect((await pool.query("SELECT id FROM audit_events WHERE resource_id=$1 AND action='grant.revoke'", [grantId])).rows).toHaveLength(1);
    expect((await pool.query("SELECT cursor FROM feed_events WHERE object_id=$1 AND name='task.updated'", [taskId])).rows).toHaveLength(1);
  });

  test('concurrent terminal verdicts on two Tasks sharing a target safely reap the last reference', async () => {
    const first = await reviewTask(), second = await reviewTask(), shared = await grant(first);
    await linkGrant(second, shared); const a = await begin(first), b = await begin(second);
    await Promise.all([verdict(a.id), verdict(b.id)]);
    expect((await state(first)).links).toHaveLength(0); expect((await state(second)).links).toHaveLength(0);
    expect(await exists(shared)).toBe(0);
  });

  // Card 0616c363: the overlap above made deterministic. A second connection
  // holds the advisory key lockReferenceTarget computes for the shared grant's
  // logical tuple, so the first terminal verdict is refused
  // ASSIGNMENT_REFERENCE_BUSY at once. While that verdict is rolled back the
  // overlapping writer finishes: the key is released and the other Task's
  // verdict commits first. The verdict owner's retry then finds itself the last
  // reference and reaps the target exactly once.
  test('a terminal verdict refused ASSIGNMENT_REFERENCE_BUSY by a benign overlap rolls back, retries and reaps the last reference once', async () => {
    const first = await reviewTask(), second = await reviewTask(), shared = await grant(first);
    await linkGrant(second, shared); const a = await begin(first), b = await begin(second);
    const key = 'relayhall:vehicle-reference:'
      + JSON.stringify(['grant', 'principal', STRANGER.principalId, 'task', first, 'read'].map(value => value.toLowerCase()));
    const holder = await pool.connect(), pauses: number[] = [];
    const overlapping = new TaskReviewAttemptService(pool, 300000, {
      referenceBusyPause: async (attempt: number) => {
        pauses.push(attempt);
        if (attempt === 1) { await holder.query('COMMIT'); await verdict(b.id); }
      },
    });
    let outcome: any;
    try {
      await holder.query('BEGIN');
      expect((await holder.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked', [key])).rows[0].locked).toBe(true);
      outcome = await overlapping.recordVerdict(a.id, 'pass', [], { summary: 'Exact synthetic receipt accepted' })
        .catch((error: any) => ({ refused: { status: error?.status, code: error?.code } }));
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    expect(outcome).toEqual({ status: 'completed', attemptCount: 0, applied: true });
    expect(pauses).toEqual([1]);
    for (const taskId of [first, second]) {
      expect(await state(taskId)).toMatchObject({ task: { status: 'completed' }, links: [], attempts: [{ status: 'passed' }] });
    }
    expect(await exists(shared)).toBe(0);
    expect((await pool.query("SELECT id FROM audit_events WHERE resource_id=$1 AND action='grant.revoke'", [shared])).rows).toHaveLength(1);
  });

  test.each([
    ['unfinished subtask PASS', ['review', 'empty'], false, 'pass', 'todo'],
    ['unfinished native PASS', ['review', 'empty'], true, 'pass', 'todo'],
    ['flat rework', [], false, 'reject', 'todo'],
    ['subtask rework', ['review'], false, 'reject', 'todo'],
    ['escalation', [], false, 'escalate', 'stuck'],
  ])('%s does not prematurely reap assignment access', async (_name, statuses, native, decision, status) => {
    const taskId = await reviewTask(statuses as string[]), grantId = await grant(taskId), attempt = await begin(taskId, native as boolean);
    expect(await ledger.recordVerdict(attempt.id, decision, [], { summary: 'Synthetic nonterminal disposition' })).toMatchObject({ status, applied: true });
    expect((await state(taskId)).links).toHaveLength(1); expect(await exists(grantId)).toBe(1);
  });

  test('changed immutable flat Report evidence refuses verdict and retains access', async () => {
    const taskId = await reviewTask(), grantId = await grant(taskId), attempt = await begin(taskId);
    await insertReport(AUTHOR.handle, AUTHOR.principalId, [taskId]);
    await expect(verdict(attempt.id)).rejects.toThrow('Linked Report evidence changed');
    expect((await state(taskId)).task.status).toBe('review');
    expect((await state(taskId)).attempts).toEqual([{ status: 'running' }]);
    expect((await state(taskId)).links).toHaveLength(1); expect(await exists(grantId)).toBe(1);
  });
});
