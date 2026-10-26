#!/usr/bin/env node
/**
 * Card 311229fd — AZ-A12 build 3 against the COMPILED process.
 *
 * The live suite (src/__tests__/groupOwnershipTransferLive.test.ts) drives the
 * production router in-process and mints its step-up tokens through the
 * store. This drill boots `dist/server.js` itself — the artefact the container
 * runs — against a REAL migrated PostgreSQL, gives fixture Accounts a real
 * password through `PUT /principals/:id/password` (dashboard login), signs each
 * in through `POST /auth/session`, mints every step-up through the real
 * `POST /auth/step-up` password re-entry, and replays the transfer act:
 *
 *   - an operator (an administrator) moving a Project into a Group is refused
 *     STEP_UP_REQUIRED with the `stepUp` challenge until it steps up; with a
 *     real step-up the move succeeds and the audit row says
 *     deciderStanding administrator; the spent token does not replay; the undo
 *     back to the person succeeds with a fresh one;
 *   - a bearer credential holding projects:admin is refused
 *     GROUP_OWNER_SESSION_ONLY and an editor session never reaches the act,
 *     and neither spends its token;
 *   - the Task act: into a Group and back pins the person as the explicit
 *     account owner;
 *   - a disabled Group target is refused INVALID_OWNER;
 *   - owner-candidates lists Groups to the operator;
 *   - creation with a Group owner is one act under the same step-up.
 *
 * Usage (after `npm run build`, from backend/):
 *   RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \
 *     node scripts/group-ownership-transfer-compiled-drill.js
 *
 * DESTRUCTIVE: writes principals, passwords, groups, members, projects, tasks,
 * credentials, sessions, step-up tokens and audit rows. It refuses any
 * deployment database and any non-local host. Exit 0 = every check held; the
 * process it started is always stopped.
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
const ACT = 'ownership.transfer';
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
  SELECT group_principal.id, $1::text, 'AZ-A12 build 3 compiled drill', FALSE FROM group_principal
  RETURNING id`;

async function main() {
  const db = new Client({ connectionString: process.env.RELAYHALL_TEST_DB_URL });
  await db.connect();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-group-transfer-drill-'));
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
      return { status: response.status, json, setCookie: response.headers.getSetCookie ? response.headers.getSetCookie() : [] };
    };

    const login = await send('POST', '/auth/login', { body: { password: PASSWORD } });
    const admin = login.json && login.json.token;
    check('a real dashboard login answers a token', login.status === 200 && typeof admin === 'string', login.status);

    const accounts = {};
    // The Connector's parent Account needs no login: the break-glass identity
    // may not set an admin's password (non-escalation), and nothing signs in as it.
    accounts.keyholder = { id: String((await db.query(
      `INSERT INTO principals (kind, handle, display_name, status, role) VALUES ('human', $1, $1, 'active', 'admin') RETURNING id`,
      [`aza12b3-compiled-keyholder-${tag()}`])).rows[0].id), cookie: '' };
    for (const [label, role] of [['operator', 'operator'], ['editor', 'editor'], ['person', 'editor']]) {
      const handle = `aza12b3-compiled-${label}-${tag()}`;
      const id = String((await db.query(
        `INSERT INTO principals (kind, handle, display_name, status, role) VALUES ('human', $1, $1, 'active', $2) RETURNING id`,
        [handle, role])).rows[0].id);
      const set = await send('PUT', `/principals/${id}/password`, { token: admin, body: { password: ACCOUNT_PASSWORD } });
      const session = await send('POST', '/auth/session', { body: { account: handle, password: ACCOUNT_PASSWORD } });
      const cookie = session.setCookie.map((c) => c.split(';')[0]).join('; ');
      check(`${label}: a password set by the administrator and a real session login`,
        set.status === 200 && session.status === 200 && cookie.length > 0, { set: set.status, session: session.status });
      accounts[label] = { id, cookie };
    }
    const as = (label) => ({ cookie: accounts[label].cookie });
    const stepUp = async (label, targetId) => {
      const minted = await send('POST', '/auth/step-up', { ...as(label), body: { password: ACCOUNT_PASSWORD, action: ACT, targetId } });
      return minted.status === 200 ? minted.json.stepUpToken : null;
    };
    const revision = async (projectId) => String((await db.query('SELECT revision FROM projects WHERE id = $1', [projectId])).rows[0].revision);
    const moveProject = async (opts, projectId, owner, stepUpToken) => send('PUT', `/projects/${projectId}/owner`, {
      ...opts, headers: { 'If-Match': await revision(projectId) },
      body: stepUpToken === undefined ? { ownerPrincipalId: owner } : { ownerPrincipalId: owner, stepUpToken },
    });
    const moveTask = async (opts, taskId, target, stepUpToken) => {
      const state = await send('GET', `/tasks/${taskId}/account-owner`, opts);
      return send('PUT', `/tasks/${taskId}/account-owner`, { ...opts, body: {
        accountOwnerPrincipalId: target, expectedAccountOwnerPrincipalId: state.json.ownership.accountOwnerPrincipalId,
        expectedUpdatedAt: state.json.ownership.updatedAt, reason: 'compiled drill', ...(stepUpToken ? { stepUpToken } : {}),
      } });
    };

    const G = String((await db.query(INSERT_GROUP, [`compiled group ${tag()}`])).rows[0].id);
    await db.query(`INSERT INTO group_members (group_id, account_principal_id, source) VALUES ($1, $2, 'local')`, [G, accounts.person.id]);
    const D = String((await db.query(INSERT_GROUP, [`compiled disabled ${tag()}`])).rows[0].id);
    await db.query(`UPDATE principals SET status = 'disabled' WHERE id = $1`, [D]);
    const P = String((await db.query(
      `INSERT INTO projects (name, status, visibility, owner_principal_id) VALUES ($1, 'active', 'private', $2) RETURNING id`,
      [`compiled project ${tag()}`, accounts.person.id])).rows[0].id);

    const noToken = await moveProject(as('operator'), P, G);
    check('an operator without a step-up is refused STEP_UP_REQUIRED with the challenge for (ownership.transfer, P)',
      noToken.status === 403 && noToken.json && noToken.json.code === 'STEP_UP_REQUIRED'
      && noToken.json.stepUp && noToken.json.stepUp.action === ACT && noToken.json.stepUp.targetId === P, noToken.json);
    const into = await stepUp('operator', P);
    const moved = await moveProject(as('operator'), P, G, into);
    check('with a real step-up the operator moves the Project into the Group', moved.status === 200
      && moved.json.project.ownerPrincipalId === G, moved.json);
    const audit = (await db.query(
      `SELECT metadata FROM audit_events WHERE resource_id = $1 AND action = 'project.owner.change' AND outcome = 'success'`, [P])).rows;
    check('the audit row records deciderStanding administrator, the kinds and the step-up token', audit.length === 1
      && audit[0].metadata.deciderStanding === 'administrator' && audit[0].metadata.newOwnerKind === 'group'
      && typeof audit[0].metadata.stepUpTokenId === 'string', audit.map((r) => r.metadata));
    const replay = await moveProject(as('operator'), P, accounts.person.id, into);
    check('the spent token does not replay', replay.status === 403 && replay.json.code === 'STEP_UP_REQUIRED', replay.json);
    const undo = await moveProject(as('operator'), P, accounts.person.id, await stepUp('operator', P));
    check('undo: the operator returns the Project to the person with a fresh step-up', undo.status === 200
      && undo.json.project.ownerPrincipalId === accounts.person.id, undo.json);

    const holder = String((await db.query(
      `INSERT INTO principals (kind, handle, display_name, status, role, parent_principal_id, purpose, own_expression)
       VALUES ('service', $1, $1, 'active', 'user', $2, 'compiled drill connector', $3::jsonb) RETURNING id`,
      [`aza12b3-compiled-connector-${tag()}`, accounts.keyholder.id, JSON.stringify({ scopes: 'parent', objects: 'parent' })])).rows[0].id);
    const issued = await send('POST', `/principals/${holder}/credentials`, { token: admin,
      body: { scopes: ['projects:read', 'projects:write', 'projects:admin'], transport: 'any' } });
    check('a bearer credential holding projects:admin is issued', issued.status === 201 && typeof issued.json.secretOnce === 'string', issued.status);
    const bearer = await moveProject({ token: issued.json.secretOnce }, P, G);
    check('the bearer is refused GROUP_OWNER_SESSION_ONLY', bearer.status === 403 && bearer.json.code === 'GROUP_OWNER_SESSION_ONLY', bearer.json);
    const editorToken = await stepUp('editor', P);
    const editor = await moveProject(as('editor'), P, G, editorToken);
    const editorLive = (await db.query(`SELECT count(*)::int AS n FROM step_up_tokens WHERE principal_id = $1 AND consumed_at IS NULL`,
      [accounts.editor.id])).rows[0].n;
    check('an editor session never reaches the act and its token is not spent', [403, 404].includes(editor.status) && editorLive === 1,
      { status: editor.status, live: editorLive });
    check('the Project is still the person\'s', (await db.query('SELECT owner_principal_id FROM projects WHERE id = $1', [P])).rows[0].owner_principal_id === accounts.person.id, null);

    const disabled = await moveProject(as('operator'), P, D, await stepUp('operator', P));
    check('a disabled Group target is refused INVALID_OWNER', disabled.status === 422 && disabled.json.code === 'INVALID_OWNER', disabled.json);

    const T = String((await db.query(
      `INSERT INTO tasks (title, status, visibility, project_id) VALUES ($1, 'todo', 'private', $2) RETURNING id`,
      [`compiled task ${tag()}`, P])).rows[0].id);
    const taskInto = await moveTask(as('operator'), T, G, await stepUp('operator', T));
    const taskBack = await moveTask(as('operator'), T, accounts.person.id, await stepUp('operator', T));
    const explicit = (await db.query('SELECT account_owner_principal_id FROM tasks WHERE id = $1', [T])).rows[0].account_owner_principal_id;
    check('the Task act: into the Group and back pins the person as the explicit account owner',
      taskInto.status === 200 && taskBack.status === 200 && explicit === accounts.person.id,
      { into: taskInto.json, back: taskBack.json, explicit });

    const candidates = await send('GET', `/projects/${P}/owner-candidates`, as('operator'));
    check('owner-candidates lists the enabled Group, not the disabled one, to the operator', candidates.status === 200
      && candidates.json.groups.some((g) => g.id === G) && !candidates.json.groups.some((g) => g.id === D), candidates.json);

    const projectId = crypto.randomUUID();
    const created = await send('POST', '/projects', { ...as('operator'), body: {
      name: `compiled created ${tag()}`, ownerPrincipalId: G, projectId, stepUpToken: await stepUp('operator', projectId),
    } });
    check('creation with a Group owner is one act under the step-up', created.status === 201
      && created.json.project.id === projectId && created.json.project.ownerPrincipalId === G, created.json);
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
