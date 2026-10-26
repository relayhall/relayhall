#!/usr/bin/env node
/**
 * Card a9b1e69c — AZ-A12 build 5 (clauses 12 and 13, D-16) against the
 * COMPILED process: G.2 drill 9, "Feed and hub".
 *
 * The live suite (src/__tests__/groupOwnerHubLive.test.ts) drives the
 * production router in-process. This drill boots `dist/server.js` itself — the
 * artefact the container runs — against a REAL migrated PostgreSQL, signs
 * fixture Accounts in through `POST /auth/session`, mints the step-up through
 * the real `POST /auth/step-up`, opens real dashboard WebSockets, and checks:
 *
 *   - the Project record and the Task account-owner read name a Group owner
 *     by kind and name (clause 12);
 *   - the hub lists a request about a Group-owned project under its owning
 *     Group with basis owner, and one about a person-owned project with a live
 *     Group grant with basis grant (clause 12, D-16);
 *   - when an operator moves a Group-owned project out to a person with a real
 *     step-up, the owner-change socket hint reaches a member's socket and not
 *     a non-member's, and the project.acl_changed event whose recorded owner is
 *     the Group reaches the member's and the manager's feed and not the
 *     non-member's (clause 13).
 *
 * Usage (after `npm run build`, from backend/):
 *   RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \
 *     node scripts/group-owner-hub-compiled-drill.js
 *
 * DESTRUCTIVE: writes principals, passwords, sessions, services, credentials,
 * groups, members, steward rows, projects, tasks, grants, approvals, step-up
 * tokens and feed rows. It refuses any deployment database and any non-local
 * host. Exit 0 = every check held; the process it started is always stopped.
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const bcrypt = require('bcrypt');
const { Client } = require('pg');
const WebSocket = require('ws');

const BACKEND = path.resolve(__dirname, '..');
const DIST_SERVER = path.join(BACKEND, 'dist', 'server.js');
const url = new URL(String(process.env.RELAYHALL_TEST_DB_URL || ''));
const dbName = decodeURIComponent(url.pathname.slice(1));
// The CI arm is the one the live suites share: the job's own service, by exact name.
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
const FOUR_SCOPES = ['tasks:read', 'tasks:write', 'reports:read', 'reports:write'];
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

const INSERT_GROUP = `
  WITH group_principal AS (
    INSERT INTO principals (id, kind, handle, display_name, status)
    SELECT minted.id, 'group', 'group:' || minted.id::text, left($1::text, 255), 'active'
      FROM (SELECT gen_random_uuid() AS id) minted
    RETURNING id
  )
  INSERT INTO groups (id, name, description, featured)
  SELECT group_principal.id, $1::text, 'AZ-A12 build 5 compiled drill', FALSE FROM group_principal
  RETURNING id`;

/** A dashboard socket for `cookie`, recording every message it receives. */
function openSocket(origin, cookie) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/ws`, { headers: { Cookie: cookie } });
    const messages = [];
    socket.on('message', (data) => {
      try { messages.push(JSON.parse(String(data))); } catch { messages.push({ raw: String(data) }); }
    });
    socket.once('open', () => resolve({ socket, messages }));
    socket.once('error', reject);
  });
}

async function main() {
  const db = new Client({ connectionString: process.env.RELAYHALL_TEST_DB_URL });
  await db.connect();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-group-owner-hub-drill-'));
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
  const sockets = [];
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

    const login = await send('POST', '/auth/login', { body: { password: PASSWORD } });
    const admin = login.json && login.json.token;
    check('a real dashboard login answers a token', login.status === 200 && typeof admin === 'string', login.status);

    const accounts = {};
    for (const [label, role] of [['operator', 'operator'], ['owner', 'user'], ['member', 'user'], ['manager', 'user'], ['outsider', 'user']]) {
      const handle = `aza12b5-compiled-${label}-${tag()}`;
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

    const groupName = `compiled owning ${tag()}`;
    const G = String((await db.query(INSERT_GROUP, [groupName])).rows[0].id);
    const H = String((await db.query(INSERT_GROUP, [`compiled granted ${tag()}`])).rows[0].id);
    for (const label of ['member', 'manager']) {
      await db.query(`INSERT INTO group_members (group_id, account_principal_id, source) VALUES ($1, $2, 'local')`, [G, accounts[label].id]);
    }
    await db.query(`INSERT INTO group_stewards (group_id, account_principal_id, role) VALUES ($1, $2, 'manager')`, [G, accounts.manager.id]);

    const newProject = async (label) => {
      const created = await send('POST', '/projects', { ...as('owner'), body: { name: `compiled ${label} ${tag()}` } });
      return created.status === 201 ? String(created.json.project.id) : null;
    };
    const newTask = async (projectId) => {
      const created = await send('POST', '/tasks', { ...as('owner'), body: { title: `compiled task ${tag()}`, description: 'compiled drill', status: 'todo', project: projectId } });
      return created.status === 201 ? String(created.json.task.id) : null;
    };
    const P = await newProject('owned');
    const PG = await newProject('granted');
    const TP = await newTask(P);
    const TG = await newTask(PG);
    check('the owner creates two projects and a task in each', P && PG && TP && TG, { P, PG, TP, TG });

    // A connector of the owner files a mint request on each task (the hub's items).
    const slug = `aza12b5-compiled-connector-${tag()}`;
    const registered = await send('POST', '/services', { ...as('owner'), body: {
      slug, name: slug, description: 'compiled drill connector.', kind: 'connector',
      issueCredential: { scopes: FOUR_SCOPES, label: slug, transport: 'api' },
    } });
    const bearer = registered.json && registered.json.onboarding && registered.json.onboarding.credential.secretOnce;
    check('the owner registers a connector with a credential', registered.status === 201 && typeof bearer === 'string', registered.status);
    const mint = async (taskId) => {
      const requested = await send('POST', '/delegation/agent-mints', { token: bearer,
        headers: { 'Idempotency-Key': `aza12b5-compiled-${crypto.randomUUID()}` },
        body: { targetTaskId: taskId, requestedScopes: FOUR_SCOPES, via: 'approval' } });
      return requested.status === 202 ? String(requested.json.approval.id) : null;
    };
    const mintOwned = await mint(TP);
    const mintGranted = await mint(TG);
    check('the connector files a mint request on each task', mintOwned && mintGranted, { mintOwned, mintGranted });

    // Ownership by fixture (the act is drilled by the build 3 drill); a Task with no explicit account owner.
    await db.query('UPDATE projects SET owner_principal_id = $2 WHERE id = $1', [P, G]);
    await db.query('UPDATE tasks SET account_owner_principal_id = NULL WHERE id = $1', [TP]);
    await db.query(`INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, origin)
                    VALUES ('group', $1, 'project', $2, 'read', 'manual')`, [H, PG]);

    const record = await send('GET', `/projects/${P}`, as('owner'));
    check('the Project record names the Group owner by kind and name', record.status === 200
      && record.json.project.ownerPrincipalId === G && record.json.project.ownerKind === 'group'
      && record.json.project.ownerDisplayName === groupName, record.json && record.json.project);
    const read = await send('GET', `/tasks/${TP}/account-owner`, as('manager'));
    check('the Task account-owner read names the effective Group owner by kind and name', read.status === 200
      && read.json.ownership.accountOwnerPrincipalId === G && read.json.ownership.ownerKind === 'group'
      && read.json.ownership.ownerDisplayName === groupName, read.json);

    const hub = await send('GET', '/approvals?view=hub', as('operator'));
    const item = (id) => (hub.json && hub.json.approvals || []).find((entry) => entry.id === id);
    const owned = item(mintOwned);
    const granted = item(mintGranted);
    check('the hub lists the Group-owned project under its owning Group, basis owner', hub.status === 200 && owned
      && owned.ownership.class === 'group' && owned.ownership.basis === 'owner' && owned.ownership.groups[0]
      && owned.ownership.groups[0].id === G && owned.ownership.groups[0].basis === 'owner', owned && owned.ownership);
    check('the hub lists the person-owned project with a live Group grant by the fallback, basis grant', granted
      && granted.ownership.class === 'group' && granted.ownership.basis === 'grant' && granted.ownership.ownerKind === 'human'
      && granted.ownership.groups[0] && granted.ownership.groups[0].id === H, granted && granted.ownership);

    // Clause 13: the operator moves the Group-owned project out to the owner, with a real step-up.
    const member = await openSocket(origin, accounts.member.cookie);
    const outsider = await openSocket(origin, accounts.outsider.cookie);
    sockets.push(member.socket, outsider.socket);
    const cursor = String((await db.query('SELECT COALESCE(max(cursor), 0)::text AS c FROM feed_events')).rows[0].c);
    const minted = await send('POST', '/auth/step-up', { ...as('operator'), body: { password: ACCOUNT_PASSWORD, action: ACT, targetId: P } });
    const revision = String((await db.query('SELECT revision FROM projects WHERE id = $1', [P])).rows[0].revision);
    const moved = await send('PUT', `/projects/${P}/owner`, { ...as('operator'), headers: { 'If-Match': revision },
      body: { ownerPrincipalId: accounts.owner.id, stepUpToken: minted.json && minted.json.stepUpToken } });
    check('the operator moves the Group-owned project to the owner with a real step-up', minted.status === 200
      && moved.status === 200 && moved.json.project.ownerPrincipalId === accounts.owner.id
      && moved.json.project.ownerKind === 'human', { minted: minted.status, moved: moved.json });

    const hinted = (box) => box.messages.some((message) => message.type === 'project.authority_changed');
    const waitUntil = Date.now() + 5000;
    while (Date.now() < waitUntil && !hinted(member)) await sleep(100);
    await sleep(500);
    check('the owner-change hint reaches the member\'s socket', hinted(member), member.messages.map((m) => m.type));
    check('the owner-change hint does not reach a non-member\'s socket', !hinted(outsider), outsider.messages.map((m) => m.type));

    const feed = async (label) => {
      const answer = await send('GET', `/events?cursor=${cursor}&limit=500`, as(label));
      return (answer.json && answer.json.events || [])
        .filter((event) => event.name === 'project.acl_changed' && event.objectId === P && event.ownerPrincipalId === G);
    };
    check('the Group-owner transition event reaches the member\'s feed', (await feed('member')).length === 1, null);
    check('the Group-owner transition event reaches the manager\'s feed', (await feed('manager')).length === 1, null);
    check('the Group-owner transition event does not reach a non-member\'s feed', (await feed('outsider')).length === 0, null);
  } finally {
    for (const socket of sockets) { try { socket.close(); } catch { /* closed */ } }
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
