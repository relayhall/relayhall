/**
 * Card 742fae98 (epic 5854f0d6): the Map's Reports display mode, proven over a
 * REAL PostgreSQL through the PRODUCTION protected router with real login
 * sessions for two Accounts.
 *
 *   (N) The count a task's "Reports · N" node and its Expanded report area
 *       show is computed by the dashboard from `GET /tasks/graph`'s `reports`
 *       list, one entry per (Report, Task) pair. That list is narrowed by the
 *       SERVER, Report by Report: two Accounts reading the same Task get
 *       different lists when one of them may not read some of its Reports,
 *       and neither the id nor the title of an unreadable Report reaches the
 *       other. Each Account's point read of every Report is the outside
 *       anchor: the graph lists exactly the Reports `GET /reports/{id}`
 *       answers 200 for.
 *   (P) The Collapsed | Expanded choice is the caller's OWN preference: it is
 *       stored on the caller's `principal_preferences` row, read back on a
 *       fresh request (a reload), defaults to Collapsed, never moves another
 *       Account's choice or the caller's Theme, and the column refuses any
 *       other value at the database.
 *
 * DESTRUCTIVE: writes principals, sessions, projects, tasks, Reports and
 * preference rows. It refuses any deployment database and any non-local host,
 * and FAILS - never skips - without a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the Map Reports drill measures stored Report and preference '
    + 'rows, so it never skips. Load database/init.sql into a disposable database, run npm run migrate, and point '
    + 'RELAYHALL_TEST_DB_URL at it.');
}
const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = decodeURIComponent(parsed.pathname.slice(1));
const localDisposable = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  && /test|contract|fixture/.test(TEST_DB_NAME);
const ciService = process.env.CI === 'true' && parsed.hostname === 'postgres' && TEST_DB_NAME === 'relayhall_ci';
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
  || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod'].includes(TEST_DB_NAME)
  || (!localDisposable && !ciService)) {
  throw new Error('Map Reports drill refuses a non-disposable database target');
}

Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: TEST_DB_NAME,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
});

const express = require('express');
const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');

jest.setTimeout(120_000);

let server: http.Server;
let origin: string;

interface Caller { principalId: string; headers: Record<string, string> }
interface Answer { status: number; json: any }
const tag = (): string => crypto.randomBytes(5).toString('hex');

async function call(who: Caller, method: string, routePath: string, body?: unknown): Promise<Answer> {
  const response = await fetch(`${origin}${routePath}`, {
    method, headers: { 'Content-Type': 'application/json', ...who.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json };
}

async function person(label: string): Promise<Caller> {
  const row = await pool.query(`INSERT INTO principals (kind, handle, display_name, status, role)
    VALUES ('human', $1, $1, 'active', 'user') RETURNING id`, [`mr-${label}-${tag()}`]);
  const principalId = String(row.rows[0].id);
  const minted = await loginSessionService.mint({ principalId });
  return { principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

/** One (Report, Task) pair per entry, exactly the dashboard's grouping rule. */
function countsByTask(reports: Array<{ id: string; taskId: string }>): Map<string, number> {
  const pairs = new Set(reports.map((report) => `${report.id}\u0000${report.taskId}`));
  const counts = new Map<string, number>();
  for (const pair of pairs) {
    const taskId = pair.split('\u0000')[1];
    counts.set(taskId, (counts.get(taskId) ?? 0) + 1);
  }
  return counts;
}

describe('(N) the Map\'s per-task Report count is the server\'s readable set, per Account', () => {
  let alice: Caller;
  let bob: Caller;
  let projectName: string;
  let TASK: string;
  let QUIET_TASK: string;
  const open: string[] = [];
  const sealed: string[] = [];
  const sealedTitles: string[] = [];

  /** A Report written through the production route, then given the visibility under test. */
  async function linkedReport(taskId: string, visibility: 'default' | 'private'): Promise<string> {
    const title = `mr ${visibility} evidence ${tag()}`;
    const created = await call(alice, 'POST', '/reports', { title, content: `body of ${title}`, task_ids: [taskId] });
    expect(`create ${visibility}: ${created.status}`).toMatch(/^create \w+: 20[01]$/);
    const id = String(created.json.report?.id ?? created.json.id);
    await pool.query('UPDATE reports SET visibility = $1, author_principal_id = $2 WHERE id = $3',
      [visibility, alice.principalId, id]);
    if (visibility === 'private') sealedTitles.push(title);
    return id;
  }

  beforeAll(async () => {
    alice = await person('alice');
    bob = await person('bob');
    projectName = `mr-project-${tag()}`;
    const project = await pool.query(
      `INSERT INTO projects (name, owner_principal_id, visibility) VALUES ($1, $2, 'shared') RETURNING id`,
      [projectName, alice.principalId]);
    const projectId = String(project.rows[0].id);
    const task = async (title: string) => String((await pool.query(
      `INSERT INTO tasks (title, project_id, shepherd_principal_id, status, visibility)
       VALUES ($1, $2, $3, 'todo', 'shared') RETURNING id`, [title, projectId, alice.principalId])).rows[0].id);
    TASK = await task(`mr cited ${tag()}`);
    QUIET_TASK = await task(`mr quiet ${tag()}`);
    for (let index = 0; index < 3; index += 1) open.push(await linkedReport(TASK, 'default'));
    for (let index = 0; index < 2; index += 1) sealed.push(await linkedReport(TASK, 'private'));
  });

  const graphOf = async (who: Caller) => {
    const answer = await call(who, 'GET', `/tasks/graph?lod=task&statuses=todo&projects=${encodeURIComponent(projectName)}`);
    expect(answer.status).toBe(200);
    return answer.json;
  };

  it('the partition is real: both Accounts read the Task; Alice reads every Report, Bob only the open ones', async () => {
    for (const who of [alice, bob]) {
      expect(`task read: ${(await call(who, 'GET', `/tasks/${TASK}`)).status}`).toBe('task read: 200');
    }
    for (const id of [...open, ...sealed]) {
      expect(`alice reads ${id}: ${(await call(alice, 'GET', `/reports/${id}`)).status}`).toBe(`alice reads ${id}: 200`);
    }
    for (const id of open) {
      expect(`bob reads ${id}: ${(await call(bob, 'GET', `/reports/${id}`)).status}`).toBe(`bob reads ${id}: 200`);
    }
    for (const id of sealed) {
      expect([403, 404]).toContain((await call(bob, 'GET', `/reports/${id}`)).status);
    }
  });

  it('Alice\'s graph counts all five Reports on the Task; Bob\'s counts the three he may read', async () => {
    const aliceGraph = await graphOf(alice);
    const bobGraph = await graphOf(bob);
    for (const graph of [aliceGraph, bobGraph]) {
      expect(graph.nodes.map((node: any) => node.id).sort()).toEqual([TASK, QUIET_TASK].sort());
    }
    expect(countsByTask(aliceGraph.reports).get(TASK)).toBe(5);
    expect(countsByTask(bobGraph.reports).get(TASK)).toBe(3);
    // A Task with no readable Report has no count at all — no node to draw.
    expect(countsByTask(aliceGraph.reports).has(QUIET_TASK)).toBe(false);
    expect(countsByTask(bobGraph.reports).has(QUIET_TASK)).toBe(false);
  });

  it('the graph lists exactly the Reports each Account\'s point read allows (the outside anchor)', async () => {
    for (const who of [alice, bob]) {
      const listed = (await graphOf(who)).reports
        .filter((report: any) => report.taskId === TASK).map((report: any) => report.id).sort();
      const allowed: string[] = [];
      for (const id of [...open, ...sealed]) {
        if ((await call(who, 'GET', `/reports/${id}`)).status === 200) allowed.push(id);
      }
      expect(listed).toEqual(allowed.sort());
    }
  });

  it('nothing of an unreadable Report reaches Bob: not its id, not its title', async () => {
    const answer = await call(bob, 'GET', `/tasks/graph?lod=task&statuses=todo&projects=${encodeURIComponent(projectName)}`);
    const text = JSON.stringify(answer.json);
    for (const id of sealed) expect(`sealed id leaked: ${text.includes(id)}`).toBe('sealed id leaked: false');
    for (const title of sealedTitles) {
      expect(`sealed title leaked: ${text.includes(title)}`).toBe('sealed title leaked: false');
    }
  });

  it('a Report Bob gains access to joins his count; one Alice loses stays out of hers', async () => {
    await pool.query("UPDATE reports SET visibility = 'default' WHERE id = $1", [sealed[0]]);
    expect(countsByTask((await graphOf(bob)).reports).get(TASK)).toBe(4);
    await pool.query('UPDATE reports SET deleted_at = now() WHERE id = $1', [open[0]]);
    expect(countsByTask((await graphOf(alice)).reports).get(TASK)).toBe(4);
    expect(countsByTask((await graphOf(bob)).reports).get(TASK)).toBe(3);
  });
});

describe('(P) Collapsed | Expanded is the caller\'s own stored preference', () => {
  let carol: Caller;
  let dave: Caller;
  const stored = async (who: Caller) => (await pool.query(
    'SELECT map_reports_mode FROM principal_preferences WHERE principal_id = $1', [who.principalId])).rows[0]?.map_reports_mode;

  beforeAll(async () => {
    carol = await person('carol');
    dave = await person('dave');
  });

  it('defaults to Collapsed for an Account that has chosen nothing', async () => {
    for (const who of [carol, dave]) {
      const answer = await call(who, 'GET', '/preferences');
      expect(answer.status).toBe(200);
      expect(answer.json.data).toEqual({ theme: null, reducedMotion: 'system', mapReportsMode: 'collapsed' });
    }
  });

  it('a choice is stored on the caller\'s row and read back on a fresh request; another Account keeps its own', async () => {
    expect((await call(carol, 'PUT', '/preferences', { theme: 'relay-light' })).status).toBe(200);
    const saved = await call(carol, 'PUT', '/preferences', { mapReportsMode: 'expanded' });
    expect(saved.status).toBe(200);
    expect(saved.json.data).toEqual({ theme: 'relay-light', reducedMotion: 'system', mapReportsMode: 'expanded' });
    expect(await stored(carol)).toBe('expanded');
    // A reload is a new request with the same session: the stored row answers.
    expect((await call(carol, 'GET', '/preferences')).json.data.mapReportsMode).toBe('expanded');
    // Dave has no row and is untouched.
    expect(await stored(dave)).toBeUndefined();
    expect((await call(dave, 'GET', '/preferences')).json.data.mapReportsMode).toBe('collapsed');
    // Dave's own choice moves only Dave.
    expect((await call(dave, 'PUT', '/preferences', { mapReportsMode: 'expanded' })).status).toBe(200);
    expect((await call(carol, 'PUT', '/preferences', { mapReportsMode: 'collapsed' })).status).toBe(200);
    expect(await stored(carol)).toBe('collapsed');
    expect(await stored(dave)).toBe('expanded');
    // A Map-only patch leaves the Theme exactly where it was.
    expect((await call(carol, 'GET', '/preferences')).json.data.theme).toBe('relay-light');
  });

  it('a body naming another Account still writes only the caller\'s row', async () => {
    const answer = await call(dave, 'PUT', '/preferences', { mapReportsMode: 'collapsed', principalId: carol.principalId });
    expect(answer.status).toBe(200);
    expect(await stored(dave)).toBe('collapsed');
    expect(await stored(carol)).toBe('collapsed');
    expect((await call(carol, 'PUT', '/preferences', { mapReportsMode: 'expanded', principal_id: dave.principalId })).status).toBe(200);
    expect(await stored(carol)).toBe('expanded');
    expect(await stored(dave)).toBe('collapsed');
  });

  it('an unknown value is refused by name and writes nothing', async () => {
    const answer = await call(carol, 'PUT', '/preferences', { mapReportsMode: 'grouped' });
    expect(answer.status).toBe(400);
    expect(String(answer.json.message)).toContain('collapsed');
    expect(await stored(carol)).toBe('expanded');
  });

  it('the column itself refuses any value outside Collapsed | Expanded', async () => {
    await expect(pool.query("UPDATE principal_preferences SET map_reports_mode = 'grouped' WHERE principal_id = $1",
      [carol.principalId])).rejects.toMatchObject({ code: '23514' });
    expect(await stored(carol)).toBe('expanded');
  });
});
