#!/usr/bin/env node
/**
 * Card ee81ee0f — AZ-A12 build 2 against the COMPILED process.
 *
 * The live suite (src/__tests__/groupOwnerArmLive.test.ts) drives the
 * production router in-process. This drill boots `dist/server.js` itself — the
 * artefact the container runs — against a REAL migrated PostgreSQL, gives five
 * fixture Accounts a real password through `PUT /principals/:id/password`
 * (dashboard login), signs each in through `POST /auth/session`, and replays
 * the Group-owner tiers over HTTP:
 *
 *   - drill 1: a member reads a Group-owned Task and Project and is refused a
 *     write; a manager and an owner-role holder write; a viewer member reads
 *     and never writes; a non-member is answered as though the Task were
 *     absent;
 *   - drill 3: path (b) - a Task someone else owns is read by a member and
 *     written by a manager; a restricted Task is hidden from a member and
 *     written by a manager; an archived Project fails path (b) closed;
 *   - drill 2: disabling the Group principal hides the Task from the member
 *     on the next request, and enabling it restores the tier;
 *   - drill 10: the manager is refused CHARTER_APPROVAL_FORBIDDEN; the
 *     owner-role holder, with no step-up, is asked for one (STEP_UP_REQUIRED,
 *     LENSES-c gate (i), design delta D-11); the dashboard administrator
 *     approves.
 *
 * Usage (after `npm run build`, from backend/):
 *   RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \
 *     node scripts/group-owner-compiled-drill.js
 *
 * DESTRUCTIVE: writes principals, passwords, groups, members, role rows,
 * projects, tasks, Charter, session and audit rows. It refuses any deployment
 * database and any non-local host. Exit 0 = every check held; the process it
 * started is always stopped.
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
// The CI arm is the one the live suites share (machinery queue 9b761f09 gave
// this drill a full-tier step): the job's own service, by exact name.
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

const INSERT_GROUP = `
  WITH group_principal AS (
    INSERT INTO principals (id, kind, handle, display_name, status)
    SELECT minted.id, 'group', 'group:' || minted.id::text, left($1::text, 255), 'active'
      FROM (SELECT gen_random_uuid() AS id) minted
    RETURNING id
  )
  INSERT INTO groups (id, name, description, featured)
  SELECT group_principal.id, $1::text, 'AZ-A12 build 2 compiled drill', FALSE FROM group_principal
  RETURNING id`;

async function main() {
  const db = new Client({ connectionString: process.env.RELAYHALL_TEST_DB_URL });
  await db.connect();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-group-owner-drill-'));
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
      // The TEST keyset jest.config.js injects (and the authority-edit drill
      // uses): on a database other writers share, the server's startup
      // canary decrypts the newest stored credentials, and a per-run random
      // key would refuse every row they stored (machinery queue 9b761f09).
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
      if (!up) await new Promise((r) => setTimeout(r, 250));
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
      return { status: response.status, json, text, setCookie: response.headers.getSetCookie ? response.headers.getSetCookie() : [] };
    };

    const login = await send('POST', '/auth/login', { body: { password: PASSWORD } });
    const admin = login.json && login.json.token;
    check('a real dashboard login answers a token', login.status === 200 && typeof admin === 'string', login.status);

    // Five Accounts, each signed in through the real password act and the real session login.
    const accounts = {};
    for (const [label, role] of [['member', 'editor'], ['manager', 'editor'], ['owner', 'editor'], ['viewer', 'viewer'], ['stranger', 'editor']]) {
      const handle = `aza12b2-compiled-${label}-${tag()}`;
      const id = (await db.query(
        `INSERT INTO principals (kind, handle, display_name, status, role) VALUES ('human', $1, $1, 'active', $2) RETURNING id`,
        [handle, role])).rows[0].id;
      const set = await send('PUT', `/principals/${id}/password`, { token: admin, body: { password: ACCOUNT_PASSWORD } });
      const session = await send('POST', '/auth/session', { body: { account: handle, password: ACCOUNT_PASSWORD } });
      const cookie = session.setCookie.map((c) => c.split(';')[0]).join('; ');
      check(`${label}: a password set by the administrator and a real session login`,
        set.status === 200 && session.status === 200 && cookie.length > 0, { set: set.status, session: session.status });
      accounts[label] = { id: String(id), cookie };
    }

    const G = (await db.query(INSERT_GROUP, [`compiled group ${tag()}`])).rows[0].id;
    for (const label of ['member', 'manager', 'owner', 'viewer']) {
      await db.query(`INSERT INTO group_members (group_id, account_principal_id, source) VALUES ($1, $2, 'local')`, [G, accounts[label].id]);
    }
    await db.query(`INSERT INTO group_stewards (group_id, account_principal_id, role) VALUES ($1, $2, 'manager'), ($1, $3, 'owner')`,
      [G, accounts.manager.id, accounts.owner.id]);
    const project = async (owner, status = 'active') => String((await db.query(
      `INSERT INTO projects (name, status, visibility, owner_principal_id) VALUES ($1, $2, 'private', $3) RETURNING id`,
      [`compiled project ${tag()}`, status, owner])).rows[0].id);
    const task = async (projectId, accountOwner = null, restricted = false) => String((await db.query(
      `INSERT INTO tasks (title, status, visibility, project_id, restricted_access, account_owner_principal_id)
       VALUES ($1, 'todo', 'private', $2, $3, $4) RETURNING id`,
      [`compiled task ${tag()}`, projectId, restricted, accountOwner])).rows[0].id);
    const P = await project(G);
    const TA = await task(P);
    const TB = await task(P, accounts.stranger.id);
    const TR = await task(P, null, true);
    const archived = await project(G, 'archived');
    const TX = await task(archived, accounts.stranger.id);

    const as = (label) => ({ cookie: accounts[label].cookie });
    const status = async (label, method, route, body) => (await send(method, route, { ...as(label), body })).status;
    const write = (label, id) => status(label, 'PATCH', `/tasks/${id}`, { title: `compiled ${tag()}` });

    check('drill 1: a member reads the Group-owned Task and Project', await status('member', 'GET', `/tasks/${TA}`) === 200
      && await status('member', 'GET', `/projects/${P}`) === 200, null);
    check('drill 1: a member is refused a write (403)', await write('member', TA) === 403, null);
    check('drill 1: a manager writes', await write('manager', TA) === 200, null);
    check('drill 1: an owner-role holder writes', await write('owner', TA) === 200, null);
    check('drill 1: a viewer member reads and never writes', await status('viewer', 'GET', `/tasks/${TA}`) === 200
      && await write('viewer', TA) === 403, null);
    check('drill 1: a non-member is answered as though the Task were absent (404)', await status('stranger', 'GET', `/tasks/${TA}`) === 404, null);

    check('drill 3: path (b) - a member reads a Task someone else owns', await status('member', 'GET', `/tasks/${TB}`) === 200, null);
    check('drill 3: path (b) - a manager writes it; a member does not', await write('manager', TB) === 200 && await write('member', TB) === 403, null);
    check('drill 3: a restricted Task is hidden from a member and written by a manager',
      await status('member', 'GET', `/tasks/${TR}`) === 404 && await write('manager', TR) === 200, null);
    check('drill 3: an archived Project fails path (b) closed', await status('member', 'GET', `/tasks/${TX}`) === 404
      && await status('manager', 'GET', `/tasks/${TX}`) === 404, null);

    await db.query(`UPDATE principals SET status = 'disabled' WHERE id = $1`, [G]);
    check('drill 2: a disabled Group principal hides the Task from the member on the next request',
      await status('member', 'GET', `/tasks/${TA}`) === 404, null);
    await db.query(`UPDATE principals SET status = 'active' WHERE id = $1`, [G]);
    check('drill 2: enabling it restores the tier', await status('member', 'GET', `/tasks/${TA}`) === 200, null);

    const approve = (opts) => send('POST', `/projects/${P}/charter/approve`, { ...opts, body: { content: `# Compiled charter ${tag()}` } });
    // Card b5c83682 (LENSES-c gate (i), design delta D-11): the owner-role
    // holder now reaches the Group-owner Charter arm, which asks a session with
    // no step-up for one; the manager stays refused. The same repair, by name,
    // as drill 10 in groupOwnerArmLive.test.ts.
    const refused = await approve(as('manager'));
    check('drill 10: the manager is refused CHARTER_APPROVAL_FORBIDDEN', refused.status === 403
      && refused.json && refused.json.code === 'CHARTER_APPROVAL_FORBIDDEN', refused.json);
    const asked = await approve(as('owner'));
    check('drill 10: the owner-role holder without a step-up is asked for one (STEP_UP_REQUIRED, gate (i), D-11)',
      asked.status === 403 && asked.json && asked.json.code === 'STEP_UP_REQUIRED'
        && asked.json.stepUp && asked.json.stepUp.action === 'charter.approve', asked.json);
    const approved = await approve({ token: admin });
    check('drill 10: the dashboard administrator approves', approved.status === 201, approved.json);
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
