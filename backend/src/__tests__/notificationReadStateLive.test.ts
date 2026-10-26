/**
 * Card b1e3b16d, hub lane L2: the notification history and the per-Account
 * read state (migration 144), over a REAL PostgreSQL and the PRODUCTION router.
 *
 * Every number below is read back from rows the board wrote, through
 * `GET /tasks/notifications`, `POST /tasks/notifications/:id/read` and
 * `POST /tasks/notifications/read-all` behind the real authentication and the
 * real shared-authorization middleware:
 *
 *   (1) read state is PER PRINCIPAL: A marks a row read and B, who sees the same
 *       row, still has it unread; A's unread count drops by exactly one;
 *   (2) mark-all is scoped: a filtered read-all writes rows only for items the
 *       caller sees under the filter, and leaves every other principal's state
 *       and every row the caller cannot see untouched; the unfiltered form moves
 *       only the caller's own mark;
 *   (3) history is not capped at 50: sixty rows page through `before` with no
 *       gap and no repeat;
 *   (4) an unreadable task never yields a row or a title, under any filter;
 *   (5) the task.stuck notice stays ADDRESSED (RH-P3.C8, strategy 2.6.4): the
 *       shepherd-else-creator-else-owner sees it, a reader of the task who is not
 *       the addressee never does (not even under "Everything I can see"), and
 *       root does;
 *   (6) "My work" (the default) versus "Everything I can see";
 *   (7) an approval event reaches only sessions inside the approvals self-scope,
 *       never a bearer credential; a filed request is listed but never unread;
 *   (8) keyset paging is stable while rows are appended concurrently;
 *   (9) the migration replays as a no-op, and its backfill gives a principal a
 *       mark at the feed head so old history is listed but not unread;
 *  (10) read state survives a service restart (a fresh module registry, a fresh
 *       pool, a fresh app);
 *  (11) a key the caller cannot see answers exactly as an absent one;
 *  (12) a skill version decision reaches the version's author.
 *
 * DESTRUCTIVE: writes principals, sessions, projects, tasks, grants, skills,
 * feed rows, approvals and read state. It refuses any deployment database and
 * any non-local host, and FAILS - never skips - without a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the notification read-state drill measures stored rows, so it '
    + 'never skips. Load database/init.sql into a disposable database, run npm run migrate, and point '
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
  throw new Error('Notification read-state drill refuses a non-disposable database target');
}

Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: TEST_DB_NAME,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
});

jest.setTimeout(180_000);

interface App { server: http.Server; origin: string; pool: any; modules: Record<string, any> }

/** One running copy of the board: its own module registry, so a second call is a RESTART. */
async function startApp(): Promise<App> {
  let modules: Record<string, any> = {};
  jest.isolateModules(() => {
    modules = {
      express: require('express'),
      connection: require('../db/connection'),
      routeRegistry: require('../routeRegistry'),
      auth: require('../middleware/auth'),
      shared: require('../middleware/sharedAuthorization'),
      apiErrors: require('../utils/apiErrors'),
      jsonBodyTypes: require('../utils/jsonBodyTypes'),
      sessions: require('../services/LoginSessionService'),
      stepUp: require('../services/StepUpService'),
      feed: require('../services/FeedEventService'),
      grants: require('../services/GrantService'),
      skills: require('../services/SkillManager'),
    };
  });
  const app = modules.express();
  app.use(modules.express.json(modules.jsonBodyTypes.jsonBodyOptions));
  modules.routeRegistry.registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, modules.auth.authMiddleware, modules.shared.sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(modules.apiErrors.apiErrorHandler);
  const server: http.Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return {
    server, pool: modules.connection.pool, modules,
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  };
}

async function stopApp(app: App): Promise<void> {
  await new Promise<void>((resolve) => app.server.close(() => resolve()));
  await app.pool.end();
}

let APP: App;
const pool = () => APP.pool;

interface Caller { label: string; principalId: string; headers: Record<string, string> }
interface Answer { status: number; json: any }

async function call(who: Caller, method: string, routePath: string, body?: unknown): Promise<Answer> {
  const response = await fetch(`${APP.origin}${routePath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...who.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json };
}

const tag = (): string => crypto.randomBytes(5).toString('hex');

async function makeAccount(role: string, label: string): Promise<string> {
  const result = await pool().query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $1, 'active', $2) RETURNING id`,
    [`l2-${label}-${tag()}`, role],
  );
  return String(result.rows[0].id);
}

async function sessionFor(label: string, principalId: string): Promise<Caller> {
  const minted = await APP.modules.sessions.loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${APP.modules.sessions.SESSION_COOKIE_NAME}=${minted.token}` } };
}

async function makeTask(owner: Caller, title: string): Promise<string> {
  const created = await call(owner, 'POST', '/tasks', { title, description: 'notification drill', status: 'todo' });
  expect(created.status).toBe(201);
  return String(created.json?.task?.id);
}

/** Append a feed row exactly as an emitting write does: inside a transaction, through the feed service. */
async function emit(name: string, taskId: string, payload: Record<string, unknown>, actor?: Caller): Promise<void> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    await APP.modules.feed.feedEventService.emit(client, {
      name, objectType: 'task', objectId: taskId, payload,
      actorPrincipalId: actor?.principalId ?? null, actorHandle: actor?.label ?? null,
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const move = (taskId: string, from: string, to: string, actor?: Caller) =>
  emit('task.updated', taskId, { status: to, previousStatus: from }, actor);

async function grantRead(principalId: string, taskId: string): Promise<void> {
  await pool().query(
    `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb) VALUES ('principal', $1, 'task', $2, 'read')`,
    [principalId, taskId],
  );
}

async function history(who: Caller, query = ''): Promise<Answer> {
  return call(who, 'GET', `/tasks/notifications${query ? `?${query}` : ''}`);
}

/** Every row of the history under a query, page by page. */
async function allPages(who: Caller, query: string, limit = 50): Promise<any[]> {
  const rows: any[] = [];
  let before: string | null = null;
  for (let guard = 0; guard < 50; guard += 1) {
    const answer = await history(who, `${query}&limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`);
    expect(answer.status).toBe(200);
    rows.push(...answer.json.notifications);
    if (!answer.json.hasMore) return rows;
    before = answer.json.nextCursor;
  }
  throw new Error('paging did not terminate');
}

const rowsFor = (answer: Answer, taskId: string) => answer.json.notifications.filter((n: any) => n.taskId === taskId);

/**
 * An ABSENCE is checked over EVERY page, never the first: a row that leaked
 * but sorted past page one would otherwise pass as "not there" (the first
 * mutation drill of this suite caught exactly that).
 */
async function everyRow(who: Caller, query: string): Promise<any[]> {
  return allPages(who, query, 100);
}
const everyRowFor = async (who: Caller, query: string, taskId: string) =>
  (await everyRow(who, query)).filter((n: any) => n.taskId === taskId);

let A: Caller;          // an ordinary Account: creates the shared task
let B: Caller;          // an ordinary Account granted read on A's task
let C: Caller;          // an ordinary Account with nothing
let ROOT: Caller;       // role admin: derives root
let T_SHARED: string;   // A's task, B may read it
let T_PRIVATE: string;  // B's own task, A cannot read it

beforeAll(async () => {
  APP = await startApp();
  A = await sessionFor('alice', await makeAccount('user', 'alice'));
  B = await sessionFor('bob', await makeAccount('user', 'bob'));
  C = await sessionFor('carol', await makeAccount('user', 'carol'));
  ROOT = await sessionFor('root', await makeAccount('admin', 'root'));
  T_SHARED = await makeTask(A, `L2 shared ${tag()}`);
  T_PRIVATE = await makeTask(B, `L2 SECRET private ${tag()}`);
  await grantRead(B.principalId, T_SHARED);
});

afterAll(async () => {
  if (APP) await stopApp(APP);
});

describe('(1) read state is per principal', () => {
  let KEY: string;

  beforeAll(async () => {
    await move(T_SHARED, 'todo', 'in-progress', ROOT);
  });

  it('A (My work) and B (Everything I can see) both list the move unread', async () => {
    const forA = await history(A, 'type=status');
    const forB = await history(B, 'type=status&who=all');
    const rowA = rowsFor(forA, T_SHARED).find((n: any) => n.to === 'in-progress');
    const rowB = rowsFor(forB, T_SHARED).find((n: any) => n.to === 'in-progress');
    expect(rowA).toMatchObject({ event: 'status_changed', from: 'todo', to: 'in-progress', read: false, type: 'status' });
    expect(rowB?.id).toBe(rowA.id);
    expect(rowB.read).toBe(false);
    KEY = rowA.id;
    expect(KEY).toMatch(/^feed:\d+$/);
  });

  it('A marks it read: A reads it as read and its unread count drops by one; B still has it unread', async () => {
    const beforeA = (await history(A, 'type=status')).json.unreadCount;
    const beforeB = (await history(B, 'type=status&who=all')).json.unreadCount;
    const marked = await call(A, 'POST', `/tasks/notifications/${encodeURIComponent(KEY)}/read`);
    expect(marked.status).toBe(200);
    const afterA = await history(A, 'type=status');
    const afterB = await history(B, 'type=status&who=all');
    expect(afterA.json.notifications.find((n: any) => n.id === KEY).read).toBe(true);
    expect(afterA.json.unreadCount).toBe(beforeA - 1);
    expect(afterB.json.notifications.find((n: any) => n.id === KEY).read).toBe(false);
    expect(afterB.json.unreadCount).toBe(beforeB);
    const stored = await pool().query('SELECT principal_id FROM notification_reads WHERE item_key = $1', [KEY]);
    expect(stored.rows.map((r: any) => String(r.principal_id))).toEqual([A.principalId]);
  });

  it('marking twice is idempotent, and ?unread=true leaves the row out for A only', async () => {
    expect((await call(A, 'POST', `/tasks/notifications/${encodeURIComponent(KEY)}/read`)).status).toBe(200);
    expect((await history(A, 'unread=true&type=status')).json.notifications.map((n: any) => n.id)).not.toContain(KEY);
    expect((await history(B, 'unread=true&type=status&who=all')).json.notifications.map((n: any) => n.id)).toContain(KEY);
  });

  it('a row the caller did itself is never unread', async () => {
    await move(T_SHARED, 'in-progress', 'review', A);
    const row = (await history(A, 'type=status')).json.notifications.find((n: any) => n.to === 'review' && n.taskId === T_SHARED);
    expect(row.read).toBe(true);
    const forB = (await history(B, 'type=status&who=all')).json.notifications.find((n: any) => n.id === row.id);
    expect(forB.read).toBe(false);
  });
});

describe('(2) mark-all is scoped to the caller, the filter and what the caller can see', () => {
  beforeAll(async () => {
    await move(T_SHARED, 'review', 'todo', ROOT);
    await move(T_PRIVATE, 'todo', 'in-progress', ROOT);
    await emit('task.review_requested', T_SHARED, { reviewId: crypto.randomUUID() }, ROOT);
  });

  it('a filtered read-all (type=status) marks A\'s visible status rows only: not the review request, not B\'s private task, not B', async () => {
    const bBefore = await pool().query('SELECT item_key FROM notification_reads WHERE principal_id = $1 ORDER BY 1', [B.principalId]);
    const done = await call(A, 'POST', '/tasks/notifications/read-all?type=status');
    expect(done.status).toBe(200);
    expect(done.json.markedCount).toBeGreaterThan(0);
    expect((await history(A, 'type=status&unread=true')).json.unreadCount).toBe(0);
    // The review request is outside the filter and stays unread.
    const review = (await history(A, 'type=review')).json.notifications.filter((n: any) => n.taskId === T_SHARED);
    expect(review.length).toBeGreaterThan(0);
    expect(review.every((n: any) => n.read === false && n.event === 'review_requested')).toBe(true);
    // Nothing was written for a row A cannot see.
    const privateKeys = (await pool().query(
      `SELECT 'feed:' || cursor AS key FROM feed_events WHERE object_id = $1`, [T_PRIVATE])).rows.map((r: any) => r.key);
    const aKeys = (await pool().query('SELECT item_key FROM notification_reads WHERE principal_id = $1', [A.principalId])).rows.map((r: any) => r.item_key);
    expect(aKeys.filter((key: string) => privateKeys.includes(key))).toEqual([]);
    // B's state did not move.
    const bAfter = await pool().query('SELECT item_key FROM notification_reads WHERE principal_id = $1 ORDER BY 1', [B.principalId]);
    expect(bAfter.rows).toEqual(bBefore.rows);
    expect((await history(B, 'type=status&who=all&unread=true')).json.unreadCount).toBeGreaterThan(0);
  });

  it('the unfiltered read-all (who=all, every type) moves only the caller\'s own mark', async () => {
    const marksBefore = await pool().query(
      'SELECT principal_id, feed_cursor, others_through FROM notification_read_marks WHERE principal_id <> $1 ORDER BY 1', [C.principalId]);
    const done = await call(C, 'POST', '/tasks/notifications/read-all?who=all');
    expect(done.status).toBe(200);
    const marksAfter = await pool().query(
      'SELECT principal_id, feed_cursor, others_through FROM notification_read_marks WHERE principal_id <> $1 ORDER BY 1', [C.principalId]);
    expect(marksAfter.rows).toEqual(marksBefore.rows);
    const mark = await pool().query('SELECT feed_cursor FROM notification_read_marks WHERE principal_id = $1', [C.principalId]);
    const head = await pool().query('SELECT max(cursor) AS head FROM feed_events');
    expect(String(mark.rows[0].feed_cursor)).toBe(String(head.rows[0].head));
  });
});

describe('(3) history is not capped at fifty', () => {
  const MOVES = 60;
  let T_MANY: string;

  beforeAll(async () => {
    T_MANY = await makeTask(A, `L2 many ${tag()}`);
    const statuses = ['todo', 'in-progress', 'review'];
    for (let i = 0; i < MOVES; i += 1) await move(T_MANY, statuses[i % 3], statuses[(i + 1) % 3], ROOT);
  });

  it('pages of 25 cover all sixty rows exactly once, newest first', async () => {
    const rows = (await allPages(A, 'type=status', 25)).filter((n: any) => n.taskId === T_MANY);
    expect(rows).toHaveLength(MOVES);
    expect(new Set(rows.map((n: any) => n.id)).size).toBe(MOVES);
    const times = rows.map((n: any) => Date.parse(n.timestamp));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    const stored = await pool().query(
      `SELECT count(*)::int AS n FROM feed_events WHERE object_id = $1 AND name = 'task.updated'`, [T_MANY]);
    expect(stored.rows[0].n).toBe(MOVES);
  });

  it('a page is never larger than its limit and reports hasMore truthfully', async () => {
    const first = await history(A, 'type=status&limit=50');
    expect(first.json.notifications).toHaveLength(50);
    expect(first.json.hasMore).toBe(true);
    expect(first.json.nextCursor).toBe(first.json.notifications[49].cursor);
  });

  it('refuses a limit past 100 and a cursor it did not issue', async () => {
    expect((await history(A, 'limit=101')).status).toBe(400);
    expect((await history(A, 'before=garbage')).json.code).toBe('INVALID_NOTIFICATION_CURSOR');
    expect((await history(A, 'type=everything')).json.code).toBe('INVALID_NOTIFICATION_FILTER');
  });
});

describe('(4) an unreadable task never yields a row or a title', () => {
  it('A sees nothing of B\'s private task under any filter, and no title leaks', async () => {
    for (const query of ['who=mine', 'who=all', 'who=all&type=status', 'who=all&type=stuck', 'who=all&type=review', 'who=all&unread=true']) {
      const rows = await everyRow(A, query);
      expect(rows.filter((n: any) => n.taskId === T_PRIVATE)).toEqual([]);
      expect(JSON.stringify(rows)).not.toContain('SECRET');
    }
  });

  it('C, with no grant at all, sees neither task', async () => {
    const rows = await everyRow(C, 'who=all');
    expect(rows.filter((n: any) => n.taskId === T_SHARED)).toEqual([]);
    expect(rows.filter((n: any) => n.taskId === T_PRIVATE)).toEqual([]);
  });

  it('B sees its own private task\'s move', async () => {
    expect(rowsFor(await history(B, 'type=status'), T_PRIVATE).length).toBeGreaterThan(0);
  });
});

describe('(5) the stuck notice stays addressed (RH-P3.C8)', () => {
  let KEY: string;

  beforeAll(async () => {
    await emit('task.stuck', T_SHARED, { reason: 'status_stale' });
  });

  it('the addressee (shepherd, else creator, else owner) sees a useful notice', async () => {
    const task = await pool().query(
      'SELECT COALESCE(shepherd_principal_id, creator_principal_id, owner_principal_id) AS recipient FROM tasks WHERE id = $1', [T_SHARED]);
    expect(String(task.rows[0].recipient)).toBe(A.principalId);
    const stuck = rowsFor(await history(A, 'type=stuck'), T_SHARED);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toMatchObject({ event: 'exception', exception: { name: 'task.stuck', reason: 'status_stale' }, read: false });
    expect(stuck[0].taskTitle).toMatch(/^L2 shared/);
    KEY = stuck[0].id;
  });

  it('B reads the task but is not the addressee: no stuck row under any filter, and the key is concealed', async () => {
    for (const query of ['type=stuck', 'who=all&type=stuck', 'who=all']) {
      expect((await everyRow(B, query)).map((n: any) => n.id)).not.toContain(KEY);
    }
    expect((await call(B, 'POST', `/tasks/notifications/${encodeURIComponent(KEY)}/read`)).status).toBe(404);
  });

  it('root sees the full addressed set', async () => {
    expect((await history(ROOT, 'who=all&type=stuck')).json.notifications.map((n: any) => n.id)).toContain(KEY);
  });
});

describe('(6) My work is the default; Everything I can see widens it', () => {
  it('B is not a role holder on A\'s task: the default leaves it out, who=all brings it in', async () => {
    const mine = await history(B, 'type=status');
    expect(mine.json.who).toBe('mine');
    expect(await everyRowFor(B, 'type=status', T_SHARED)).toEqual([]);
    expect((await everyRowFor(B, 'type=status&who=all', T_SHARED)).length).toBeGreaterThan(0);
  });

  it('the work of an identity under the Account is the Account\'s work', async () => {
    const connector = await pool().query(
      `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id)
       VALUES ('service', $1, $1, 'active', $2) RETURNING id`, [`l2-conn-${tag()}`, C.principalId]);
    const T_CONN = await makeTask(B, `L2 connector-created ${tag()}`);
    await pool().query('UPDATE tasks SET creator_principal_id = $1 WHERE id = $2', [connector.rows[0].id, T_CONN]);
    await grantRead(C.principalId, T_CONN);
    await move(T_CONN, 'todo', 'in-progress', ROOT);
    expect(rowsFor(await history(C, 'type=status'), T_CONN).length).toBe(1);
  });
});

describe('(7) approval events stay inside the approvals self-scope and reach sessions only', () => {
  let APPROVAL_ID: string;
  let CONNECTOR_ID: string;
  let CONNECTOR_BEARER: Caller;

  beforeAll(async () => {
    // A's own connector, registered through the owner's wizard path.
    const slug = `l2-connector-${tag()}`;
    const registered = await call(A, 'POST', '/services', {
      slug, name: slug, description: 'Notification drill connector.', kind: 'connector',
      issueCredential: { scopes: ['tasks:read', 'tasks:write'], label: slug, transport: 'api' },
    });
    expect(registered.status).toBe(201);
    CONNECTOR_ID = String((await pool().query('SELECT principal_id FROM services WHERE slug = $1', [slug])).rows[0].principal_id);
    CONNECTOR_BEARER = {
      label: slug, principalId: CONNECTOR_ID,
      headers: { Authorization: `Bearer ${registered.json.onboarding.credential.secretOnce}` },
    };
    const requested = await call({ ...CONNECTOR_BEARER, headers: { ...CONNECTOR_BEARER.headers, 'Idempotency-Key': `l2-mint-${crypto.randomUUID()}` } },
      'POST', '/delegation/agent-mints', { targetTaskId: T_SHARED, requestedScopes: ['tasks:read'], via: 'approval' });
    expect([requested.status, requested.json?.path]).toEqual([202, 'approval']);
    APPROVAL_ID = String(requested.json.approval.id);
  });

  it('the requested event is listed for A (My work) but never unread: it waits in Needs your decision', async () => {
    const rows = (await history(A, 'type=approval')).json.notifications.filter((n: any) => n.approvalId === APPROVAL_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: 'approval', approvalAction: 'approval.requested', approvalStatus: 'pending', read: true, approvalKind: 'agent-mint' });
    expect(rows[0].id).toMatch(/^approval-event:/);
  });

  it('root decides: the decision reaches A unread; B and C see no row of it', async () => {
    const stepUp = await APP.modules.stepUp.stepUpService.mint(ROOT.principalId, 'approval.decide', APPROVAL_ID, 'password');
    const denied = await call(ROOT, 'POST', `/approvals/${APPROVAL_ID}/deny`, { stepUpToken: stepUp.token, reason: 'drill' });
    expect(denied.status).toBe(200);
    const forA = (await history(A, 'type=approval')).json.notifications.filter((n: any) => n.approvalId === APPROVAL_ID);
    expect(forA.map((n: any) => [n.approvalAction, n.read])).toEqual([['approval.denied', false], ['approval.requested', true]]);
    for (const other of [B, C]) {
      expect((await everyRow(other, 'who=all&type=approval')).filter((n: any) => n.approvalId === APPROVAL_ID)).toEqual([]);
    }
    expect((await call(B, 'POST', `/tasks/notifications/${encodeURIComponent(forA[0].id)}/read`)).status).toBe(404);
  });

  it('a bearer credential never reads approval rows, even its own request\'s', async () => {
    const answer = await call(CONNECTOR_BEARER, 'GET', '/tasks/notifications?who=all&type=approval&limit=100');
    expect(answer.status).toBe(200);
    expect(answer.json.notifications).toEqual([]);
    expect(answer.json.hasMore).toBe(false);
  });

  it('root reads every approval event under who=all', async () => {
    const answer = await history(ROOT, 'who=all&type=approval');
    expect(answer.json.notifications.filter((n: any) => n.approvalId === APPROVAL_ID)).toHaveLength(2);
  });
});

describe('(8) keyset paging is stable while rows are appended', () => {
  it('rows appended between pages never appear on a later page, and no row repeats or goes missing', async () => {
    const T_PAGE = await makeTask(A, `L2 paging ${tag()}`);
    for (let i = 0; i < 12; i += 1) await move(T_PAGE, i % 2 ? 'todo' : 'in-progress', i % 2 ? 'in-progress' : 'todo', ROOT);
    const snapshot = (await allPages(A, 'type=status', 100)).filter((n: any) => n.taskId === T_PAGE).map((n: any) => n.id);
    expect(snapshot).toHaveLength(12);

    const seen: string[] = [];
    let before: string | null = null;
    let appended = 0;
    for (let guard = 0; guard < 100; guard += 1) {
      const answer = await history(A, `type=status&limit=5${before ? `&before=${encodeURIComponent(before)}` : ''}`);
      seen.push(...answer.json.notifications.filter((n: any) => n.taskId === T_PAGE).map((n: any) => n.id));
      // Concurrent appends: two new moves after every page, in parallel.
      await Promise.all([move(T_PAGE, 'todo', 'review', ROOT), move(T_PAGE, 'review', 'todo', ROOT)]);
      appended += 2;
      if (!answer.json.hasMore) break;
      before = answer.json.nextCursor;
    }
    // Every row that existed before paging began was seen exactly once, in
    // order; the appended rows, newer than the first page, never entered a
    // later page.
    expect(seen).toEqual(snapshot);
    expect(appended).toBeGreaterThan(0);
    const now = (await allPages(A, 'type=status', 100)).filter((n: any) => n.taskId === T_PAGE);
    expect(now).toHaveLength(12 + appended);
  });
});

describe('(9) the migration replays as a no-op, and its backfill marks old history read', () => {
  const MIGRATION = path.resolve(__dirname, '..', 'migrations', '144_notification_read_state.sql');

  it('re-running the file changes nothing that exists', async () => {
    const before = await pool().query('SELECT principal_id, feed_cursor, others_through FROM notification_read_marks ORDER BY 1');
    const readsBefore = await pool().query('SELECT count(*)::int AS n FROM notification_reads');
    await pool().query(fs.readFileSync(MIGRATION, 'utf8'));
    const after = await pool().query('SELECT principal_id, feed_cursor, others_through FROM notification_read_marks ORDER BY 1');
    const readsAfter = await pool().query('SELECT count(*)::int AS n FROM notification_reads');
    // Principals created since the first run gain a mark; no existing one moves.
    const afterById = new Map(after.rows.map((r: any) => [String(r.principal_id), r]));
    for (const row of before.rows) expect(afterById.get(String(row.principal_id))).toEqual(row);
    expect(readsAfter.rows[0].n).toBe(readsBefore.rows[0].n);
  });

  it('a principal with no mark reads only what happened after it was created; the backfill moves it to the feed head', async () => {
    const D = await sessionFor('dave', await makeAccount('user', 'dave'));
    await grantRead(D.principalId, T_SHARED);
    await pool().query('DELETE FROM notification_read_marks WHERE principal_id = $1', [D.principalId]);
    const created = (await pool().query('SELECT created_at FROM principals WHERE id = $1', [D.principalId])).rows[0].created_at;
    const old = (await history(D, 'who=all&type=status')).json.notifications.filter((n: any) => n.taskId === T_SHARED);
    expect(old.length).toBeGreaterThan(0);
    expect(old.every((n: any) => n.read === (Date.parse(n.timestamp) <= new Date(created).getTime()))).toBe(true);
    await move(T_SHARED, 'todo', 'in-progress', ROOT);
    expect((await history(D, 'who=all&type=status&unread=true')).json.unreadCount).toBeGreaterThan(0);
    // The migration's backfill, replayed: D now has a mark at the feed head.
    await pool().query(fs.readFileSync(MIGRATION, 'utf8'));
    const head = (await pool().query('SELECT max(cursor) AS head FROM feed_events')).rows[0].head;
    const marks = (await pool().query('SELECT feed_cursor FROM notification_read_marks WHERE principal_id = $1', [D.principalId])).rows;
    expect(marks.map((row: any) => String(row.feed_cursor))).toEqual([String(head)]);
    expect((await history(D, 'who=all&type=status&unread=true')).json.unreadCount).toBe(0);
  });

  it('the item-key CHECK refuses a key outside the grammar', async () => {
    await expect(pool().query(
      `INSERT INTO notification_reads (principal_id, item_key) VALUES ($1, 'feed:abc')`, [A.principalId],
    )).rejects.toMatchObject({ code: '23514' });
  });
});

describe('(10) read state survives a restart', () => {
  it('a row A marked read is still read after the board restarts on a fresh module registry and pool', async () => {
    const T_RESTART = await makeTask(A, `L2 restart ${tag()}`);
    await move(T_RESTART, 'todo', 'in-progress', ROOT);
    const row = rowsFor(await history(A, 'type=status'), T_RESTART)[0];
    expect(row.read).toBe(false);
    expect((await call(A, 'POST', `/tasks/notifications/${encodeURIComponent(row.id)}/read`)).status).toBe(200);
    const oldOrigin = APP.origin;
    await stopApp(APP);
    APP = await startApp();
    expect(APP.origin).not.toBe(oldOrigin);
    const again = rowsFor(await history(A, 'type=status'), T_RESTART)[0];
    expect(again).toMatchObject({ id: row.id, read: true });
    expect(await everyRowFor(B, 'type=status&who=all', T_RESTART)).toEqual([]);
  });
});

describe('(11) concealment of keys', () => {
  it('a malformed key, an absent key and an invisible key answer the same 404 and write nothing', async () => {
    const privateKey = (await pool().query(
      `SELECT 'feed:' || cursor AS key FROM feed_events WHERE object_id = $1 ORDER BY cursor LIMIT 1`, [T_PRIVATE])).rows[0].key;
    const before = (await pool().query('SELECT count(*)::int AS n FROM notification_reads')).rows[0].n;
    const answers = await Promise.all([
      call(A, 'POST', `/tasks/notifications/${encodeURIComponent(privateKey)}/read`),
      call(A, 'POST', '/tasks/notifications/feed:999999999999/read'),
      call(A, 'POST', '/tasks/notifications/not-a-key/read'),
      call(A, 'POST', `/tasks/notifications/approval-event:${crypto.randomUUID()}/read`),
    ]);
    expect(answers.map((answer) => [answer.status, answer.json?.code])).toEqual([
      [404, 'NOTIFICATION_NOT_FOUND'], [404, 'NOTIFICATION_NOT_FOUND'], [404, 'NOTIFICATION_NOT_FOUND'], [404, 'NOTIFICATION_NOT_FOUND'],
    ]);
    expect((await pool().query('SELECT count(*)::int AS n FROM notification_reads')).rows[0].n).toBe(before);
  });
});

describe('(12) a skill version decision reaches the version\'s author', () => {
  it('A writes a version, it goes to review, root publishes it: A reads one unread skill row; the submission is never unread', async () => {
    const { skillManager } = APP.modules.skills;
    const skill = await skillManager.create({
      name: `l2-skill-${tag()}`, description: 'Notification drill skill.', usage_instructions: 'Drill body.',
    }, A.principalId);
    const revision = async () => String((await pool().query('SELECT revision FROM skills WHERE id = $1', [skill.id])).rows[0].revision);
    await skillManager.transition(skill.id, '1', 'review', A.principalId, undefined, await revision());
    await skillManager.transition(skill.id, '1', 'published', ROOT.principalId, undefined, await revision());
    const rows = (await history(A, 'type=skill')).json.notifications.filter((n: any) => n.skillId === skill.id);
    expect(rows.map((n: any) => [n.event, n.from, n.to, n.read])).toEqual([
      ['skill', 'review', 'published', false],
      ['skill', 'draft', 'review', true],
    ]);
    // C did not write it: nothing under My work; under who=all a writer
    // (role user holds skills:write) sees both transitions, as
    // GET /skills/:id/versions would list them.
    expect((await history(C, 'type=skill')).json.notifications.filter((n: any) => n.skillId === skill.id)).toEqual([]);
    const forC = (await history(C, 'who=all&type=skill')).json.notifications.filter((n: any) => n.skillId === skill.id);
    expect(forC.map((n: any) => [n.to, n.read])).toEqual([['published', false], ['review', true]]);
    // A viewer (read scopes only) never sees an unpublished version's
    // transition: only the publication.
    const V = await sessionFor('viewer', await makeAccount('viewer', 'viewer'));
    const forV = (await history(V, 'who=all&type=skill')).json.notifications.filter((n: any) => n.skillId === skill.id);
    expect(forV.map((n: any) => n.to)).toEqual(['published']);
  });
});
