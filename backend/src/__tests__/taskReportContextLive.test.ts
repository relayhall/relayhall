/**
 * Card 50b5e9c4 slice 3 — the bounded Task Report context's AUTHORIZED COUNT
 * over real rows, two principals and the production routes. Runs with
 * `npm run test:report-link` only; deployment databases are refused.
 *
 * What a mocked suite cannot show: which Reports the shared READ predicate
 * (owner, visibility, task-evidence audience) actually admits for each
 * caller, and whether the context's `total`, its pages and the Brief agree
 * with that. The expected set is therefore never written down here — it is
 * READ BACK from the point route (`GET /reports/:id`) for each caller, and
 * the fixture is checked to discriminate (the two callers' sets differ in
 * both directions) before anything is compared against it.
 */
/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error(
    'RELAYHALL_TEST_DB_URL is not set. This gate measures which Reports two principals are COUNTED for one Task '
    + 'against a REAL PostgreSQL. It refuses to skip. Create a disposable database, load database/init.sql, run '
    + 'npm run migrate, and set RELAYHALL_TEST_DB_URL to it.',
  );
}
const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = parsed.pathname.replace(/^\//, '');
if (['relayhall_dev', 'relayhall_tst', 'relayhall_prod', 'relayhall'].includes(TEST_DB_NAME)) {
  throw new Error(`RELAYHALL_TEST_DB_URL names a deployment database (${TEST_DB_NAME}). This suite writes; point it at a disposable database.`);
}
process.env.DB_HOST = parsed.hostname;
process.env.DB_PORT = parsed.port || '5432';
process.env.DB_NAME = TEST_DB_NAME;
process.env.DB_USER = decodeURIComponent(parsed.username);
process.env.DB_PASSWORD = decodeURIComponent(parsed.password);
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'report-context-suite-secret-0123456789abcdef';
process.env.RELAYHALL_SESSIONS = 'on';

const express = require('express');
const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');

jest.setTimeout(240_000);

let server: http.Server;
let origin: string;

interface Caller { label: string; principalId: string; headers: Record<string, string> }
interface Answer { status: number; json: any }

async function call(who: Caller, method: string, routePath: string, body?: unknown): Promise<Answer> {
  const response = await fetch(`${origin}${routePath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...who.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let json: any = null;
  try { json = JSON.parse(raw); } catch { json = null; }
  return { status: response.status, json };
}

const tag = (): string => crypto.randomBytes(5).toString('hex');

async function makeAccount(label: string): Promise<{ id: string }> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $2, 'active', 'user') RETURNING id`,
    [`report-context-${label}-${tag()}`, `report context ${label}`],
  );
  return { id: String(result.rows[0].id) };
}

async function sessionFor(label: string, account: { id: string }): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId: account.id });
  return { label, principalId: account.id, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

let A: Caller;
let B: Caller;
let C: { id: string };
let TASK: string;
/** Every Report the fixture wrote for TASK, deleted one included. */
const FIXTURE_IDS: string[] = [];
const BODY_MARKER = 'LIVE-CONTEXT-BODY';
let clock = 0;

/** Insert one Report linked to TASK. `createdAt` defaults to a strictly
 * increasing instant so "newest" is decided by the fixture. */
async function insertReport(options: {
  author: string; visibility: string; pinned?: boolean; status?: string; deleted?: boolean;
  reference?: boolean; createdAt?: string; origin?: string; sourceTask?: string;
}): Promise<string> {
  clock += 1;
  const createdAt = options.createdAt ?? new Date(Date.UTC(2026, 9, 1, 0, 0, clock)).toISOString();
  const result = await pool.query(
    `INSERT INTO reports (title, content, summary, author, author_principal_id, visibility, task_ids,
                          pinned, status, origin, source_task_id, created_at, updated_at, deleted_at)
     VALUES ($1, $2, $3, 'report-context-suite', $4, $5, ARRAY[$6::uuid], $7, $8, $9, $10, $11::timestamptz, $11::timestamptz,
             CASE WHEN $12::boolean THEN NOW() ELSE NULL END)
     RETURNING id`,
    [`context ${clock} ${tag()}`, `${BODY_MARKER}-${clock} ${'x'.repeat(3000)}`, `summary ${clock}`,
      options.author, options.visibility, TASK, options.pinned === true, options.status ?? 'active',
      options.origin ?? 'api', options.sourceTask ?? null, createdAt, options.deleted === true],
  );
  const id = String(result.rows[0].id);
  if (options.reference) {
    await pool.query(
      `INSERT INTO task_references (task_id, kind, target_id, target_uri, label, created_by_principal_id)
       VALUES ($1, 'report', $2::uuid, $3, 'context reference', $4)`,
      [TASK, id, `/reports/${id}`, options.author],
    );
  }
  FIXTURE_IDS.push(id);
  return id;
}

/** The expected set for one caller, read back from the point route. */
async function pointReadable(who: Caller): Promise<Set<string>> {
  const readable = new Set<string>();
  for (const id of FIXTURE_IDS) {
    const answer = await call(who, 'GET', `/reports/${id}`);
    if (answer.status === 200) readable.add(id);
    else expect([id, answer.status]).toEqual([id, 404]);
  }
  return readable;
}

async function walk(who: Caller, limit: number, extra = ''): Promise<{ ids: string[]; totals: number[] }> {
  const ids: string[] = [];
  const totals: number[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const query: string = `limit=${limit}${extra}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const answer = await call(who, 'GET', `/tasks/${TASK}/reports?${query}`);
    expect(answer.status).toBe(200);
    for (const report of answer.json.reports) {
      expect(Object.keys(report)).not.toContain('content');
      ids.push(report.id);
    }
    totals.push(answer.json.pagination.total);
    cursor = answer.json.pagination.nextCursor;
    if (!cursor) break;
  }
  expect(cursor).toBeNull();
  return { ids, totals };
}

let readableByA: Set<string>;
let readableByB: Set<string>;

beforeAll(async () => {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const accountA = await makeAccount('a');
  const accountB = await makeAccount('b');
  C = await makeAccount('c');
  A = await sessionFor('A', accountA);
  B = await sessionFor('B', accountB);

  const project = await pool.query(
    `INSERT INTO projects (name, status, visibility, owner_principal_id) VALUES ($1, 'active', 'private', $2) RETURNING id`,
    [`report context ${tag()}`, A.principalId],
  );
  // A owns the Task; B reads it as its Verifier.
  const task = await pool.query(
    `INSERT INTO tasks (title, status, visibility, project_id, owner_principal_id, creator_principal_id,
                        shepherd_principal_id, verifier_principal_id)
     VALUES ($1, 'in-progress', 'private', $2, $3, $3, $3, $4) RETURNING id`,
    [`report context task ${tag()}`, project.rows[0].id, A.principalId, B.principalId],
  );
  TASK = String(task.rows[0].id);

  // Oldest first, so the pinned Reports are NOT among the newest page.
  for (let i = 0; i < 5; i += 1) await insertReport({ author: A.principalId, visibility: 'private', pinned: true });
  for (let i = 0; i < 2; i += 1) await insertReport({ author: B.principalId, visibility: 'private', pinned: true });
  for (let i = 0; i < 10; i += 1) await insertReport({ author: B.principalId, visibility: 'private' });
  for (let i = 0; i < 20; i += 1) await insertReport({ author: A.principalId, visibility: 'private', status: i === 3 ? 'archived' : 'active' });
  // Referenced by their author: the task-evidence audience (the Verifier B) reads them too.
  for (let i = 0; i < 8; i += 1) await insertReport({ author: A.principalId, visibility: 'private', reference: true });
  for (let i = 0; i < 6; i += 1) await insertReport({ author: C.id, visibility: 'shared' });
  for (let i = 0; i < 9; i += 1) await insertReport({ author: C.id, visibility: 'private' });
  await insertReport({ author: A.principalId, visibility: 'private', deleted: true });
  // Three Reports inside one millisecond (the cursor must not skip any) and
  // two with the SAME instant (the id breaks the tie).
  await insertReport({ author: A.principalId, visibility: 'shared', createdAt: '2026-10-02T00:00:00.000100Z' });
  await insertReport({ author: A.principalId, visibility: 'shared', createdAt: '2026-10-02T00:00:00.000200Z' });
  await insertReport({ author: A.principalId, visibility: 'shared', createdAt: '2026-10-02T00:00:00.000300Z' });
  await insertReport({ author: A.principalId, visibility: 'shared', createdAt: '2026-10-02T00:00:01.000000Z' });
  await insertReport({ author: A.principalId, visibility: 'shared', createdAt: '2026-10-02T00:00:01.000000Z' });
  // One server-bound progress Report of the claimant's, with its genuine Reference.
  await insertReport({ author: A.principalId, visibility: 'private', origin: 'task-report', sourceTask: TASK, reference: true });

  readableByA = await pointReadable(A);
  readableByB = await pointReadable(B);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('the fixture discriminates, read back from the point route', () => {
  it('each caller reads Reports the other cannot, and neither reads them all', () => {
    const onlyA = [...readableByA].filter((id) => !readableByB.has(id));
    const onlyB = [...readableByB].filter((id) => !readableByA.has(id));
    expect([onlyA.length > 0, onlyB.length > 0]).toEqual([true, true]);
    expect(readableByA.size).toBeLessThan(FIXTURE_IDS.length - 1);
    expect(readableByB.size).toBeLessThan(FIXTURE_IDS.length - 1);
    // The fixture's own design, as a cross-check of the oracle: A reads its 5
    // pinned, 20 private, 8 referenced, the 6 + 5 shared and its progress
    // Report; B its own 12, the 8 referenced, the 11 shared and the progress
    // Report (as Verifier).
    expect([readableByA.size, readableByB.size]).toEqual([45, 32]);
  });
});

describe('GET /tasks/:id/reports counts and pages exactly what each caller may read', () => {
  it.each([['A'], ['B']])('caller %s: the default page is five summaries of the authorized total', async (label) => {
    const who = label === 'A' ? A : B;
    const expected = label === 'A' ? readableByA : readableByB;
    const answer = await call(who, 'GET', `/tasks/${TASK}/reports`);
    expect(answer.status).toBe(200);
    expect(answer.json.pagination).toMatchObject({ limit: 5, offset: 0, total: expected.size, returned: 5, hasMore: true });
    for (const report of answer.json.reports) expect(expected.has(report.id)).toBe(true);
    expect(JSON.stringify(answer.json)).not.toContain(BODY_MARKER);
  });

  it.each([['A'], ['B']])('caller %s: a cursor walk returns the authorized set exactly once, newest first', async (label) => {
    const who = label === 'A' ? A : B;
    const expected = label === 'A' ? readableByA : readableByB;
    const { ids, totals } = await walk(who, 7);
    expect(ids.length).toBe(expected.size);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...expected].sort());
    expect(new Set(totals)).toEqual(new Set([expected.size]));
    // Newest first, read back from the rows themselves.
    const created = await pool.query(
      `SELECT id::text AS id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS k FROM reports WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    const key = new Map(created.rows.map((row: { id: string; k: string }) => [row.id, row.k]));
    for (let i = 1; i < ids.length; i += 1) {
      const [newer, older] = [key.get(ids[i - 1])!, key.get(ids[i])!];
      expect(newer > older || (newer === older && ids[i - 1] > ids[i])).toBe(true);
    }
  });

  it('pinned evidence is per caller, deduplicated and bounded', async () => {
    const forA = await call(A, 'GET', `/tasks/${TASK}/reports`);
    const forB = await call(B, 'GET', `/tasks/${TASK}/reports`);
    expect(forA.json.pinned).toMatchObject({ total: 5, returned: 3, hasMore: true });
    expect(forB.json.pinned).toMatchObject({ total: 2, returned: 2, hasMore: false });
    for (const report of forA.json.pinned.reports) expect(readableByA.has(report.id)).toBe(true);
    for (const report of forB.json.pinned.reports) expect(readableByB.has(report.id)).toBe(true);
    const onPage = new Set(forA.json.reports.map((report: { id: string }) => report.id));
    for (const report of forA.json.pinned.reports) expect(onPage.has(report.id)).toBe(false);
    const pinnedOnly = await walk(A, 2, '&pinned=true');
    expect(pinnedOnly.ids.length).toBe(5);
  });

  it('scope=progress lists only the server-bound progress Report', async () => {
    const answer = await call(A, 'GET', `/tasks/${TASK}/reports?scope=progress`);
    expect(answer.json.pagination.total).toBe(1);
    expect(answer.json.reports[0].relevance).toBe('progress');
  });

  it('GET /tasks/:id carries the same bounded context for each caller', async () => {
    for (const [who, expected] of [[A, readableByA], [B, readableByB]] as Array<[Caller, Set<string>]>) {
      const answer = await call(who, 'GET', `/tasks/${TASK}`);
      expect(answer.status).toBe(200);
      expect(answer.json.task.reportContext.pagination.total).toBe(expected.size);
      expect(answer.json.task.reportContext.reports).toHaveLength(5);
    }
  });

  it('the Brief counts each caller\'s authorized Reports and names no other', async () => {
    for (const [who, expected] of [[A, readableByA], [B, readableByB]] as Array<[Caller, Set<string>]>) {
      const answer = await call(who, 'POST', `/tasks/${TASK}/brief`, {});
      expect([who.label, answer.status]).toEqual([who.label, 200]);
      const brief = String(answer.json.brief);
      const block = /`{3,}json\n([\s\S]*?)\n`{3,}/.exec(brief.slice(brief.indexOf('### Referenced reports')));
      const data = JSON.parse(block![1]);
      expect([who.label, data.total, data.returned, data.hasMore]).toEqual([who.label, expected.size, 5, true]);
      for (const id of FIXTURE_IDS) {
        if (!expected.has(id)) expect([who.label, id, brief.includes(id)]).toEqual([who.label, id, false]);
      }
      expect(brief).not.toContain(BODY_MARKER);
    }
  });

  it('the cursor is stable across a Report created between pages', async () => {
    const first = await call(A, 'GET', `/tasks/${TASK}/reports?limit=10`);
    const created = await insertReport({ author: A.principalId, visibility: 'private', createdAt: '2026-10-09T00:00:00.000000Z' });
    try {
      const rest: string[] = [];
      let cursor = first.json.pagination.nextCursor as string | null;
      while (cursor) {
        const page = await call(A, 'GET', `/tasks/${TASK}/reports?limit=10&cursor=${encodeURIComponent(cursor)}`);
        rest.push(...page.json.reports.map((report: { id: string }) => report.id));
        cursor = page.json.pagination.nextCursor;
      }
      const served = [...first.json.reports.map((report: { id: string }) => report.id), ...rest];
      expect(served).not.toContain(created);
      expect([...served].sort()).toEqual([...readableByA].sort());
      const fresh = await call(A, 'GET', `/tasks/${TASK}/reports`);
      expect(fresh.json.reports[0].id).toBe(created);
      expect(fresh.json.pagination.total).toBe(readableByA.size + 1);
    } finally {
      await pool.query('UPDATE reports SET deleted_at = NOW() WHERE id = $1', [created]);
    }
  });
});
