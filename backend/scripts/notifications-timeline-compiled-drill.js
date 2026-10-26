#!/usr/bin/env node
/**
 * Card 5854f0d6 — Notifications and Timeline, Slice A (owner ruling E394),
 * against the COMPILED process.
 *
 * The live suite (src/__tests__/notificationsTimelineLive.test.ts) runs the
 * production router in-process. This drill boots `dist/server.js` itself - the
 * artefact the container runs - against a REAL migrated PostgreSQL, signs two
 * fixture Accounts in through `POST /auth/session`, registers a real Connector
 * holding only `tasks:read` through `POST /services`, and checks, over HTTP:
 *
 *   - each Account's Timeline lists its own Task, Report and the status move it
 *     made, and none of the other Account's rows, on any page;
 *   - the tasks:read-only bearer reads its Account's task rows and no Report;
 *   - a task.updated row names the fields changed and never a value;
 *   - the actor census over the compiled routes: a Phase, a Report and a Task
 *     created by alpha store alpha as their actor, and alpha's person-filtered
 *     Timeline finds each row (the round 1 blocker: POST /phases wrote NULL);
 *   - "Needs your action" lists a Task in Review to its Verifier and to no one
 *     else, and its counts equal its items; Decisions never reach the bearer;
 *   - `POST /notifications/timeline/seen` clamps to the newest row the CALLER
 *     may see (never the board-wide head) and never moves back, and a method
 *     outside the family's routes is refused by the scope map;
 *   - the Action Center's text search (owner ruling E453): alpha's search for
 *     its own title finds its rows, and for bravo's title finds nothing, while
 *     bravo's own search for it finds bravo's rows; a search text over the
 *     maximum is a 400;
 *   - the seen mark (owner ruling E455): alpha marks its Verify item seen, the
 *     item stays listed and seen and the unseen count drops; a key alpha cannot
 *     see is ignored (nothing stored, nothing said), and the bearer marks its
 *     own list over the compiled route;
 *   - the old `GET /tasks/notifications` still answers (it retires one release
 *     after Slice B, not in this slice).
 *
 * Usage (after `npm run build`, from backend/):
 *   RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \
 *     node scripts/notifications-timeline-compiled-drill.js
 *
 * DESTRUCTIVE: writes principals, passwords, sessions, a service, a credential,
 * tasks, reports and feed rows. It refuses any deployment database and any
 * non-local host. Exit 0 = every check held; the process it started is always
 * stopped.
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const bcrypt = require('bcrypt');
const { Client } = require('pg');

const BACKEND = path.resolve(__dirname, '..');
const DIST_SERVER = path.join(BACKEND, 'dist', 'server.js');
const url = new URL(String(process.env.RELAYHALL_TEST_DB_URL || ''));
const dbName = decodeURIComponent(url.pathname.slice(1));
const localDisposable = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && /test|contract|fixture/.test(dbName);
const ciService = process.env.CI === 'true' && url.hostname === 'postgres' && dbName === 'relayhall_ci';
if (!['postgres:', 'postgresql:'].includes(url.protocol)
  || (!localDisposable && !ciService)
  || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod'].includes(dbName)) {
  console.error('RELAYHALL_TEST_DB_URL must name a local disposable test database (or, in CI, the job service)');
  process.exit(2);
}
if (!fs.existsSync(DIST_SERVER)) {
  console.error('dist/server.js is missing: run npm run build first');
  process.exit(2);
}

const PASSWORD = crypto.randomBytes(18).toString('base64url');
const ACCOUNT_PASSWORD = `${crypto.randomBytes(18).toString('base64url')}Aa1!`;
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
const tag = () => crypto.randomBytes(4).toString('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `  -> ${JSON.stringify(detail)}`}`);
};

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function main() {
  const db = new Client({ connectionString: process.env.RELAYHALL_TEST_DB_URL });
  await db.connect();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-timeline-drill-'));
  const child = spawn(process.execPath, [DIST_SERVER], {
    cwd: BACKEND,
    env: {
      PATH: process.env.PATH || '',
      NODE_ENV: 'production',
      PORT: String(port),
      DB_HOST: url.hostname, DB_PORT: url.port || '5432', DB_NAME: dbName,
      DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password),
      DATA_DIR: dataDir,
      JWT_SECRET,
      DASHBOARD_PASSWORD_HASH: bcrypt.hashSync(PASSWORD, 4),
      RELAYHALL_SESSIONS: 'on',
      // The TEST keyset jest.config.js injects, shared with the other
      // compiled-process drills on one database (machinery queue 9b761f09).
      RELAYHALL_CREDENTIAL_KEYS: JSON.stringify({ testkey: Buffer.alloc(32, 7).toString('base64') }),
      RELAYHALL_CREDENTIAL_ACTIVE_KEY: 'testkey',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += String(d); });
  child.stderr.on('data', (d) => { output += String(d); });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    const deadline = Date.now() + 90_000;
    let up = false;
    while (Date.now() < deadline && !up) {
      try { up = (await fetch(`${origin}/health`)).ok; } catch { /* not yet */ }
      if (!up) await sleep(250);
    }
    if (!up) throw new Error(`the compiled server did not come up:\n${output.slice(-2000)}`);
    check('dist/server.js boots against the migrated database', true);

    const send = async (method, route, { token, cookie, body, headers } = {}) => {
      const response = await fetch(`${origin}${route}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(headers || {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      return { status: response.status, json, setCookie: response.headers.getSetCookie ? response.headers.getSetCookie() : [] };
    };
    const idem = () => ({ 'Idempotency-Key': `nt-compiled-${crypto.randomUUID()}` });

    const login = await send('POST', '/auth/login', { body: { password: PASSWORD } });
    const root = { token: login.json && login.json.token };
    check('a real dashboard login answers a root token', login.status === 200 && typeof root.token === 'string', login.status);

    const accounts = {};
    for (const label of ['alpha', 'bravo']) {
      const handle = `nt-compiled-${label}-${tag()}`;
      const id = String((await db.query(
        `INSERT INTO principals (kind, handle, display_name, status, role) VALUES ('human', $1, $1, 'active', 'user') RETURNING id`,
        [handle])).rows[0].id);
      const set = await send('PUT', `/principals/${id}/password`, { ...root, body: { password: ACCOUNT_PASSWORD } });
      const session = await send('POST', '/auth/session', { body: { account: handle, password: ACCOUNT_PASSWORD } });
      const cookie = session.setCookie.map((c) => c.split(';')[0]).join('; ');
      check(`${label}: a password set by root and a real session login`, set.status === 200 && session.status === 200 && cookie.length > 0,
        { set: set.status, session: session.status });
      accounts[label] = { id, cookie, handle };
    }
    const alpha = { cookie: accounts.alpha.cookie };
    const bravo = { cookie: accounts.bravo.cookie };

    const task = async (who, title) => {
      const created = await send('POST', '/tasks', { ...who, body: { title, description: 'compiled timeline drill', status: 'todo' } });
      return String(created.json && created.json.task && created.json.task.id);
    };
    const TA = await task(alpha, `NT compiled alpha ${tag()}`);
    const TB = await task(bravo, `NT compiled bravo SECRET ${tag()}`);
    const RA = await send('POST', '/reports', { ...alpha, headers: idem(), body: { title: `NT compiled alpha report ${tag()}`, content: 'alpha', task_ids: [TA] } });
    // bravo's Report is private: a deployment's default visibility may let
    // another Account read a Report, and the anchor below would then (rightly)
    // admit it. A private one is bravo's alone.
    const RB = await send('POST', '/reports', { ...bravo, headers: idem(), body: { title: `NT compiled bravo SECRET report ${tag()}`, content: 'bravo', task_ids: [TB], visibility: 'private' } });
    const VALUE = `VALUE-${tag()}`;
    const moved = await send('PATCH', `/tasks/${TA}`, { ...alpha, headers: idem(), body: { title: `NT compiled alpha ${VALUE}`, status: 'in-progress' } });
    check('fixtures: two tasks, two reports and a status move through the real routes',
      TA.length === 36 && TB.length === 36 && RA.status === 201 && RB.status === 201 && moved.status === 200,
      { RA: RA.status, RB: RB.status, moved: moved.status });

    const pages = async (who, query, limit = 25) => {
      const items = [];
      let before = null;
      for (let guard = 0; guard < 400; guard += 1) {
        const answer = await send('GET', `/notifications/timeline?${query}${query ? '&' : ''}limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`, who);
        if (answer.status !== 200) return { status: answer.status, items };
        items.push(...answer.json.items);
        if (!answer.json.hasMore) return { status: 200, items };
        before = answer.json.nextCursor;
      }
      return { status: 0, items };
    };

    const forAlpha = await pages(alpha, 'acl=true');
    const alphaIds = new Set(forAlpha.items.map((item) => item.object.id));
    check("alpha's Timeline lists its own task and report rows", forAlpha.status === 200
      && alphaIds.has(TA) && alphaIds.has(RA.json.report.id), { status: forAlpha.status, size: forAlpha.items.length });
    // The outside anchor: what alpha's own point reads of bravo's objects answer.
    const anchorTask = await send('GET', `/tasks/${TB}`, alpha);
    const anchorReport = await send('GET', `/reports/${RB.json.report.id}`, alpha);
    const leaked = forAlpha.items.filter((item) => item.object.id === TB || item.object.id === RB.json.report.id
      || JSON.stringify(item).includes('bravo SECRET'));
    check("alpha's Timeline holds none of bravo's rows, on any page, and alpha's point reads of them are refused",
      leaked.length === 0 && anchorTask.status === 404 && anchorReport.status === 404,
      { leaked: leaked.map((item) => [item.kind, item.object.type, item.detail && item.detail.name]),
        pointTask: anchorTask.status, pointReport: anchorReport.status });
    // And every report and task row alpha's Timeline names is readable at its own point route.
    const named = [...new Map(forAlpha.items.filter((item) => item.object.type === 'task' || item.object.type === 'report')
      .map((item) => [`${item.object.type}:${item.object.id}`, item])).values()];
    const unreadable = [];
    for (const item of named) {
      const point = await send('GET', `/${item.object.type}s/${item.object.id}`, alpha);
      if (point.status !== 200) unreadable.push([item.object.type, point.status]);
    }
    check("the outside anchor: every task and report row alpha's Timeline names is readable at its point route",
      named.length > 0 && unreadable.length === 0, { named: named.length, unreadable });
    const statusRow = forAlpha.items.find((item) => item.object.id === TA && item.kind === 'status');
    check('the status move is listed with from/to, the field names and the actor', statusRow
      && statusRow.detail.from === 'todo' && statusRow.detail.to === 'in-progress'
      && JSON.stringify(statusRow.detail.fields) === JSON.stringify(['status', 'title'])
      && statusRow.actor.handle === accounts.alpha.handle, statusRow);
    const stored = (await db.query(
      "SELECT payload FROM feed_events WHERE object_id = $1 AND name = 'task.updated' ORDER BY cursor DESC LIMIT 1", [TA])).rows[0];
    check('the stored payload names fields and never a value', stored && !JSON.stringify(stored.payload).includes(VALUE), stored);

    // The actor census over the compiled routes (design section 4.3).
    const project = await send('POST', '/projects', { ...alpha, headers: idem(), body: { name: `NT compiled alpha project ${tag()}` } });
    const projectId = project.json && project.json.project && project.json.project.id;
    const phase = await send('POST', '/phases', { ...alpha, headers: idem(), body: { projectId, name: `NT compiled alpha phase ${tag()}` } });
    const written = [
      ['phase.created', phase.json && phase.json.phase && phase.json.phase.id],
      ['report.created', RA.json.report.id],
      ['task.created', TA],
    ];
    const census = [];
    const byAlpha = await pages(alpha, `person=${accounts.alpha.id}&acl=true`);
    const alphaKeys = new Set(byAlpha.items.map((item) => item.key));
    for (const [name, id] of written) {
      const row = (await db.query(
        'SELECT cursor::text AS cursor, actor_principal_id::text AS actor FROM feed_events WHERE object_id = $1 AND name = $2 ORDER BY cursor DESC LIMIT 1',
        [id, name])).rows[0];
      census.push({ name, stored: row ? row.actor === accounts.alpha.id : false, listed: row ? alphaKeys.has(`feed:${row.cursor}`) : false });
    }
    check("the actor census: alpha's Phase, Report and Task rows store alpha and alpha's person filter finds each",
      project.status === 201 && phase.status === 201 && census.every((entry) => entry.stored && entry.listed),
      { project: project.status, phase: phase.status, census });

    const slug = `nt-compiled-connector-${tag()}`;
    const registered = await send('POST', '/services', { ...alpha, body: {
      slug, name: slug, description: 'compiled timeline drill connector.', kind: 'connector',
      issueCredential: { scopes: ['tasks:read'], label: slug, transport: 'api' },
    } });
    const bearer = { token: registered.json && registered.json.onboarding && registered.json.onboarding.credential.secretOnce };
    check('alpha registers a tasks:read-only Connector with a credential', registered.status === 201 && typeof bearer.token === 'string',
      registered.status);
    await db.query(`INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb)
      SELECT 'principal', principal_id, 'task', $2, 'read' FROM services WHERE slug = $1`, [slug, TA]);
    const forBearer = await pages(bearer, 'acl=true');
    check('the tasks:read-only bearer reads task rows and no report row', forBearer.status === 200
      && forBearer.items.some((item) => item.object.id === TA)
      && forBearer.items.every((item) => item.object.type === 'task'), forBearer.items.map((item) => item.object.type));

    await db.query("UPDATE tasks SET status = 'review', verifier_principal_id = $2 WHERE id = $1", [TB, accounts.alpha.id]);
    await db.query(`INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb) VALUES ('principal', $1, 'task', $2, 'read')`,
      [accounts.alpha.id, TB]);
    const alphaActions = await send('GET', '/notifications/actions', alpha);
    const bravoActions = await send('GET', '/notifications/actions', bravo);
    const bearerActions = await send('GET', '/notifications/actions', bearer);
    const counted = (answer) => answer.json && answer.json.counts.total === answer.json.items.length;
    check('Needs your action: the Verifier lists the Task in Review, the others do not, and counts equal items',
      alphaActions.status === 200 && alphaActions.json.items.some((item) => item.kind === 'verify' && item.object.id === TB)
      && !bravoActions.json.items.some((item) => item.kind === 'verify' && item.object.id === TB)
      && counted(alphaActions) && counted(bravoActions) && counted(bearerActions),
      { alpha: alphaActions.status, items: alphaActions.json && alphaActions.json.counts });
    check('Decisions and Skill reviews never reach a bearer', bearerActions.status === 200
      && bearerActions.json.counts.decision === 0 && bearerActions.json.counts.skill === 0, bearerActions.json && bearerActions.json.counts);

    // bravo writes last, so the board-wide head is a row alpha cannot see.
    const TB_LAST = await task(bravo, `NT compiled bravo SECRET last ${tag()}`);
    const boardHead = String((await db.query('SELECT max(cursor)::text AS c FROM feed_events')).rows[0].c);
    const alphaHead = await send('GET', '/notifications/timeline?acl=true&limit=1', alpha);
    const head = String(alphaHead.json && alphaHead.json.headCursor.feed);
    const seen = await send('POST', '/notifications/timeline/seen', { ...alpha, body: { cursor: '99999999999' } });
    const back = await send('POST', '/notifications/timeline/seen', { ...alpha, body: { cursor: '1' } });
    check("the last-seen cursor clamps to alpha's own head (never the board's) and never moves back",
      alphaHead.status === 200 && BigInt(head) < BigInt(boardHead)
      && seen.status === 200 && seen.json.lastSeen === head && back.json.lastSeen === head,
      { head, boardHeadAbove: BigInt(head) < BigInt(boardHead), seen: seen.json, back: back.json });
    const refused = await send('DELETE', '/notifications/timeline', alpha);
    const bearerSeen = await send('POST', '/notifications/timeline/seen', { ...bearer, body: { cursor: '1' } });
    check('a method outside the family\'s routes is refused; the seen POST rides tasks:read',
      refused.status === 403 && bearerSeen.status === 200, { refused: refused.status, bearerSeen: bearerSeen.status });

    // E453: the text search, through the compiled route.
    const titleOf = async (id) => String((await db.query('SELECT title FROM tasks WHERE id = $1', [id])).rows[0].title);
    const alphaTitle = await titleOf(TA);
    // bravo's LAST Task: alpha verifies TB (and reads it by grant), but never this one.
    const bravoTitle = await titleOf(TB_LAST);
    const ownSearch = await pages(alpha, `q=${encodeURIComponent(alphaTitle.toUpperCase())}`);
    const foreignSearch = await pages(alpha, `q=${encodeURIComponent(bravoTitle)}&acl=true`);
    const bravoSearch = await pages(bravo, `q=${encodeURIComponent(bravoTitle)}`);
    // The outside anchor: alpha's own point read of that Task is refused.
    const lastAnchor = await send('GET', `/tasks/${TB_LAST}`, alpha);
    check("the text search: alpha finds its own title (any case) and nothing of bravo's; bravo finds its own",
      lastAnchor.status === 404 && ownSearch.status === 200 && ownSearch.items.length > 0 && ownSearch.items.every((item) => item.object.id === TA)
      && foreignSearch.status === 200 && foreignSearch.items.length === 0
      && bravoSearch.status === 200 && bravoSearch.items.some((item) => item.object.id === TB_LAST),
      { own: ownSearch.items.length, foreign: foreignSearch.items.map((item) => item.object.id), bravo: bravoSearch.items.length });
    const tooLong = await send('GET', `/notifications/timeline?q=${'x'.repeat(101)}`, alpha);
    check('a search text over the maximum is a 400', tooLong.status === 400 && tooLong.json && tooLong.json.code === 'INVALID_TIMELINE_FILTER',
      tooLong.status);

    // E455: the seen mark, through the compiled route.
    const verifyKey = `verify:${TB}`;
    const marked = await send('POST', '/notifications/actions/seen', { ...alpha, body: { keys: [verifyKey] } });
    const reread = await send('GET', '/notifications/actions', alpha);
    const verifyItem = reread.json && reread.json.items.find((item) => item.key === verifyKey);
    const unseen = (answer) => answer.json.items.filter((item) => !item.seen).length;
    check('the seen mark: the item stays listed and seen, and the unseen count drops and equals the unseen items',
      marked.status === 200 && marked.json.marked === 1 && verifyItem && verifyItem.seen === true
      && reread.json.counts.unseen === unseen(reread) && reread.json.counts.unseen === unseen(alphaActions) - 1
      && reread.json.counts.total === alphaActions.json.counts.total,
      { marked: marked.status, counts: reread.json && reread.json.counts, item: verifyItem });
    const absentKey = `verify:${crypto.randomUUID()}`;
    await db.query("UPDATE tasks SET status = 'review', verifier_principal_id = NULL, account_owner_principal_id = $2 WHERE id = $1",
      [(await task(bravo, `NT compiled bravo SECRET review ${tag()}`)), accounts.bravo.id]);
    const bravoItems = (await send('GET', '/notifications/actions', bravo)).json.items;
    const hiddenKey = (bravoItems.find((item) => item.kind === 'verify' && item.reasons.includes('no-verifier')) || {}).key;
    const hiddenMark = await send('POST', '/notifications/actions/seen', { ...alpha, body: { keys: [hiddenKey] } });
    const absentMark = await send('POST', '/notifications/actions/seen', { ...alpha, body: { keys: [absentKey] } });
    const storedHidden = Number((await db.query(
      'SELECT count(*)::int AS n FROM notification_action_seen WHERE principal_id = $1 AND item_key = $2', [accounts.alpha.id, hiddenKey])).rows[0].n);
    check("a key alpha cannot see is ignored like one that never existed: nothing is stored and nothing is said",
      typeof hiddenKey === 'string' && hiddenMark.status === 200 && absentMark.status === 200
      && hiddenMark.json.marked === 0 && absentMark.json.marked === 0
      && JSON.stringify(hiddenMark.json.counts) === JSON.stringify(absentMark.json.counts) && storedHidden === 0,
      { hiddenKey, hidden: hiddenMark.json, absent: absentMark.json && absentMark.json.marked, storedHidden });
    const bearerMark = await send('POST', '/notifications/actions/seen', { ...bearer, body: { all: true } });
    const malformed = await send('POST', '/notifications/actions/seen', { ...alpha, body: { keys: ['not a key'] } });
    check('the bearer marks its own list (tasks:read); a malformed request is a 400',
      bearerMark.status === 200 && typeof bearerMark.json.marked === 'number' && malformed.status === 400
      && malformed.json && malformed.json.code === 'INVALID_ACTIONS_SEEN',
      { bearer: bearerMark.status, malformed: malformed.status });

    const old = await send('GET', '/tasks/notifications?who=all&limit=5', alpha);
    check('the old history route still answers in this slice', old.status === 200 && Array.isArray(old.json.notifications), old.status);
  } finally {
    child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await exited;
    clearTimeout(killer);
    await db.end();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(JSON.stringify({ checks: checks.length, failed: failed.length }));
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
