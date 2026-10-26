#!/usr/bin/env node
/**
 * Card 1e56dbef — AZ-A12 build 6 (clause 12 and E45 (3)) against the COMPILED
 * process: the Access Explorer read model agrees with what the server
 * enforces, request by request.
 *
 * The live suite (src/__tests__/accessExplorerLive.test.ts) compares the read
 * model with the point decision in-process. This drill boots `dist/server.js`
 * itself - the artefact the container runs - against a REAL migrated
 * PostgreSQL, signs fixture Accounts in through `POST /auth/session`, registers
 * a real Connector with a real credential through `POST /services`, and checks:
 *
 *   - for every caller (a Group member, a manager, an outsider, the manager's
 *     Connector) and every object (a Group-owned Project, a Task on clause 7
 *     path (a), a Task on path (b)), the `read` and `write` the root Explorer
 *     states equal what the real routes answer (GET 200 or the concealed 404;
 *     PATCH a Task's title 200 or a refusal);
 *   - the caller's own object hop states the same verdict (projection self);
 *   - an outsider's object hop answers exactly as an absent id;
 *   - the Group hop names each member's tier; SR-3 answers a live steward's
 *     session and gives a plain member the empty answer;
 *   - review r1 LEAK A: an outsider's principal hop on the Connector is the
 *     GET /principals record, naming no bound Task and no Warrant;
 *   - review r1 LEAK B: a live steward of a DISABLED Group gets SR-3's empty
 *     answer, naming none of the objects that Group owns.
 *
 * Usage (after `npm run build`, from backend/):
 *   RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \
 *     node scripts/access-explorer-compiled-drill.js
 *
 * DESTRUCTIVE: writes principals, passwords, sessions, a service, credentials,
 * groups, members, role rows, projects and tasks. It refuses any deployment
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
const SCOPES = ['tasks:read', 'tasks:write', 'projects:read', 'projects:write', 'principals:read'];
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
  SELECT group_principal.id, $1::text, 'AZ-A12 build 6 compiled drill', FALSE FROM group_principal
  RETURNING id`;

async function main() {
  const db = new Client({ connectionString: process.env.RELAYHALL_TEST_DB_URL });
  await db.connect();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-access-explorer-drill-'));
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

    const login = await send('POST', '/auth/login', { body: { password: PASSWORD } });
    const root = { token: login.json && login.json.token };
    check('a real dashboard login answers a root token', login.status === 200 && typeof root.token === 'string', login.status);

    const accounts = {};
    for (const label of ['person', 'member', 'manager', 'outsider']) {
      const handle = `aza12b6-compiled-${label}-${tag()}`;
      const id = String((await db.query(
        `INSERT INTO principals (kind, handle, display_name, status, role) VALUES ('human', $1, $1, 'active', 'user') RETURNING id`,
        [handle])).rows[0].id);
      const set = await send('PUT', `/principals/${id}/password`, { ...root, body: { password: ACCOUNT_PASSWORD } });
      const session = await send('POST', '/auth/session', { body: { account: handle, password: ACCOUNT_PASSWORD } });
      const cookie = session.setCookie.map((c) => c.split(';')[0]).join('; ');
      check(`${label}: a password set by root and a real session login`, set.status === 200 && session.status === 200 && cookie.length > 0,
        { set: set.status, session: session.status });
      accounts[label] = { id, cookie, label };
    }

    const G = String((await db.query(INSERT_GROUP, [`compiled explorer ${tag()}`])).rows[0].id);
    for (const label of ['member', 'manager']) {
      await db.query(`INSERT INTO group_members (group_id, account_principal_id, source) VALUES ($1, $2, 'local')`, [G, accounts[label].id]);
    }
    await db.query(`INSERT INTO group_stewards (group_id, account_principal_id, role) VALUES ($1, $2, 'manager')`, [G, accounts.manager.id]);
    const P = String((await db.query(
      `INSERT INTO projects (name, status, visibility, owner_principal_id) VALUES ($1, 'active', 'private', $2) RETURNING id`,
      [`compiled explorer ${tag()}`, G])).rows[0].id);
    const newTask = async (accountOwner) => String((await db.query(
      `INSERT INTO tasks (title, status, visibility, project_id, creator_principal_id, account_owner_principal_id)
       VALUES ($1, 'todo', 'private', $2, $3, $4) RETURNING id`,
      [`compiled explorer task ${tag()}`, P, accounts.person.id, accountOwner])).rows[0].id);
    const TA = await newTask(null);
    const TB = await newTask(accounts.person.id);

    const slug = `aza12b6-compiled-connector-${tag()}`;
    const registered = await send('POST', '/services', { cookie: accounts.manager.cookie, body: {
      slug, name: slug, description: 'compiled drill connector.', kind: 'connector',
      issueCredential: { scopes: SCOPES, label: slug, transport: 'api' },
    } });
    const bearer = registered.json && registered.json.onboarding && registered.json.onboarding.credential.secretOnce;
    const connectorId = String((await db.query('SELECT principal_id FROM services WHERE slug = $1', [slug])).rows[0]?.principal_id || '');
    check('the manager registers a Connector with a credential', registered.status === 201 && typeof bearer === 'string' && connectorId,
      registered.status);
    const callers = [
      { label: 'member', id: accounts.member.id, auth: { cookie: accounts.member.cookie }, parent: null },
      { label: 'manager', id: accounts.manager.id, auth: { cookie: accounts.manager.cookie }, parent: null },
      { label: 'outsider', id: accounts.outsider.id, auth: { cookie: accounts.outsider.cookie }, parent: null },
      { label: 'connector', id: connectorId, auth: { token: bearer }, parent: accounts.manager.id },
    ];
    const objects = [{ label: 'P', type: 'project', id: P }, { label: 'TA', type: 'task', id: TA }, { label: 'TB', type: 'task', id: TB }];

    // The root Explorer's verdict for a caller: the object hop's holder row, else its parent's principal hop.
    const stated = async (caller, object) => {
      const hop = await send('GET', `/access-explorer/objects/${object.type}/${object.id}`, root);
      const holder = (hop.json && hop.json.explorer.holders || []).find((entry) => entry.principalId === caller.id);
      if (holder) return holder.actions.map((entry) => entry.action);
      if (!caller.parent) return [];
      const parent = await send('GET', `/access-explorer/principals/${caller.parent}?objectType=${object.type}&objectId=${object.id}`, root);
      const row = (parent.json && parent.json.explorer.children || []).find((entry) => entry.principalId === caller.id);
      return row ? row.actions.map((entry) => entry.action) : [];
    };
    const family = (type) => (type === 'project' ? 'projects' : 'tasks');
    const seen = {};
    for (const caller of callers) {
      for (const object of objects) {
        const actions = await stated(caller, object);
        seen[`${caller.label}:${object.label}`] = actions;
        const got = await send('GET', `/${family(object.type)}/${object.id}`, caller.auth);
        check(`${caller.label} on ${object.label}: the Explorer's read equals the real read`,
          actions.includes('read') === (got.status === 200) && [200, 404].includes(got.status), { actions, status: got.status });
        if (object.type === 'task') {
          const patched = await send('PATCH', `/tasks/${object.id}`, { ...caller.auth, body: { title: `compiled ${tag()}` } });
          check(`${caller.label} on ${object.label}: the Explorer's write equals the real write`,
            actions.includes('write') === (patched.status === 200), { actions, status: patched.status });
        }
        if (caller.auth.cookie && actions.includes('read')) {
          const own = await send('GET', `/access-explorer/objects/${object.type}/${object.id}`, caller.auth);
          const mine = own.json && own.json.explorer.holders.find((entry) => entry.principalId === caller.id);
          check(`${caller.label} on ${object.label}: its own object hop states the same verdict`, own.status === 200
            && own.json.explorer.projection === 'self' && own.json.explorer.holders.length === 1 && mine
            && JSON.stringify(mine.actions.map((entry) => entry.action).sort()) === JSON.stringify([...actions].sort()),
          { status: own.status, explorer: own.json && own.json.explorer });
        }
      }
    }

    // Not vacuous: the matrix above holds both answers for read and for write.
    const has = (key, action) => (seen[key] || []).includes(action);
    check('the drill is not vacuous: the Explorer states reads and writes granted and refused', has('member:P', 'read')
      && !has('member:TA', 'write') && has('manager:TB', 'write') && has('connector:TB', 'write') && !has('outsider:P', 'read')
      && !has('member:TB', 'write'), seen);

    const hidden = await send('GET', `/access-explorer/objects/project/${P}`, { cookie: accounts.outsider.cookie });
    const absent = await send('GET', `/access-explorer/objects/project/${crypto.randomUUID()}`, { cookie: accounts.outsider.cookie });
    check("an outsider's object hop answers exactly as an absent id", hidden.status === 404
      && JSON.stringify(hidden.json) === JSON.stringify(absent.json), { hidden: hidden.json, absent: absent.json });

    const groupHop = await send('GET', `/access-explorer/groups/${G}`, { cookie: accounts.outsider.cookie });
    const tiers = Object.fromEntries((groupHop.json && groupHop.json.explorer.members || []).map((m) => [m.principalId, m.tier]));
    check('the Group hop names each member\'s tier', groupHop.status === 200
      && tiers[accounts.member.id] === 'use' && tiers[accounts.manager.id] === 'edit', tiers);

    const steward = await send('GET', `/groups/${G}/members/${accounts.member.id}/access`, { cookie: accounts.manager.cookie });
    const plain = await send('GET', `/groups/${G}/members/${accounts.manager.id}/access`, { cookie: accounts.member.cookie });
    const ownedP = steward.json && steward.json.access.owned.find((entry) => entry.type === 'project' && entry.id === P);
    check('SR-3 answers a live steward\'s session with the member\'s reach through the Group', steward.status === 200
      && steward.json.access.member && steward.json.access.member.tier === 'use' && ownedP
      && JSON.stringify(ownedP.actions.map((entry) => entry.action).sort()) === JSON.stringify(['invoke', 'read', 'use']),
    steward.json);
    check('SR-3 gives a plain member the empty answer', plain.status === 200 && plain.json.access.member === null
      && plain.json.access.owned.length === 0, plain.json);

    // Review r1 LEAK A on the compiled process: an outsider reading the
    // manager's Connector, which has an Agent bound to a Task the outsider
    // cannot read, gets the GET /principals record and no bound Task.
    const agentId = String((await db.query(
      `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, bound_task_id, own_expression, source_tag)
       VALUES ('agent', $1, $1, 'active', $2, $3, '{"scopes":["tasks:read"],"objects":[]}'::jsonb, $1) RETURNING id`,
      [`aza12b6-compiled-agent-${tag()}`, connectorId, TA])).rows[0].id);
    const directory = await send('GET', '/principals', { cookie: accounts.outsider.cookie });
    const listed = new Map(((directory.json && directory.json.principals) || []).map((entry) => [entry.id, entry]));
    const outsiderHop = await send('GET', `/access-explorer/principals/${connectorId}`, { cookie: accounts.outsider.cookie });
    const outsiderText = JSON.stringify(outsiderHop.json);
    check("an outsider's principal hop is the GET /principals record: no bound Task, no Warrant", outsiderHop.status === 200
      && outsiderHop.json.explorer.projection === 'directory' && outsiderHop.json.explorer.authority === null
      && JSON.stringify(outsiderHop.json.explorer.principal) === JSON.stringify(listed.get(connectorId))
      && outsiderHop.json.explorer.children.some((child) => child.id === agentId)
      && !outsiderText.includes(TA) && !outsiderText.includes('boundTaskId') && !outsiderText.includes('mintedUnderWarrantId'),
    outsiderHop.json);

    // Review r1 LEAK B on the compiled process: a live manager of a DISABLED
    // Group gets the empty answer and none of the objects that Group owns.
    const G3 = String((await db.query(INSERT_GROUP, [`compiled explorer disabled ${tag()}`])).rows[0].id);
    for (const label of ['member', 'manager']) {
      await db.query(`INSERT INTO group_members (group_id, account_principal_id, source) VALUES ($1, $2, 'local')`, [G3, accounts[label].id]);
    }
    await db.query(`INSERT INTO group_stewards (group_id, account_principal_id, role) VALUES ($1, $2, 'manager')`, [G3, accounts.manager.id]);
    const P3 = String((await db.query(
      `INSERT INTO projects (name, status, visibility, owner_principal_id) VALUES ($1, 'active', 'private', $2) RETURNING id`,
      [`compiled explorer disabled ${tag()}`, G3])).rows[0].id);
    await db.query("UPDATE principals SET status = 'disabled' WHERE id = $1", [G3]);
    const disabledRead = await send('GET', `/projects/${P3}`, { cookie: accounts.manager.cookie });
    const disabledSr3 = await send('GET', `/groups/${G3}/members/${accounts.member.id}/access`, { cookie: accounts.manager.cookie });
    check("SR-3 gives a disabled Group's live steward the empty answer, naming none of its objects", disabledRead.status === 404
      && disabledSr3.status === 200 && disabledSr3.json.access.member === null && disabledSr3.json.access.owned.length === 0
      && !JSON.stringify(disabledSr3.json).includes(P3), { read: disabledRead.status, sr3: disabledSr3.json });
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
