#!/usr/bin/env node
/**
 * Card 20f40e40 — AZ-A12 build 1 against the COMPILED process.
 *
 * The live suite (src/__tests__/groupPrincipalLive.test.ts) drives the
 * production router in-process. This drill boots `dist/server.js` itself — the
 * artefact the container runs — against a REAL migrated PostgreSQL and replays
 * the build's acts over HTTP with a REAL login and a REAL password step-up:
 *
 *   - POST /groups writes the kind=group principal (canonical handle);
 *   - GET /principals leaves it out, ?kind=group lists it;
 *   - PATCH and POST .../terminate on /principals/<groupId> answer
 *     GROUP_PRINCIPAL_MANAGED_BY_GROUPS (422), both rows unchanged;
 *   - a JWT naming the Group is 401;
 *   - PUT /groups/<id>/ownership-status: no step-up is STEP_UP_REQUIRED; a
 *     password step-up minted through POST /auth/step-up for the LOWERCASE id
 *     disables through an UPPERCASE path id, and a second one enables again;
 *   - DELETE /groups/<id> refuses GROUP_OWNS_OBJECTS with counts while a
 *     Project names the Group as owner, then deletes and terminates the
 *     Group principal once it is cleared.
 *
 * Usage (after `npm run build`, from backend/):
 *   RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \
 *     node scripts/group-principal-compiled-drill.js
 *
 * DESTRUCTIVE: writes groups, principals, projects, step-up tokens and audit
 * rows. It refuses any deployment database and any non-local host. Exit 0 =
 * every check held; the process it started is always stopped.
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
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
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-group-principal-drill-'));
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

    const send = async (method, route, { token, body } = {}) => {
      const response = await fetch(`${origin}${route}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      return { status: response.status, json, text };
    };

    const login = await send('POST', '/auth/login', { body: { password: PASSWORD } });
    const token = login.json && login.json.token;
    check('a real dashboard login answers a token', login.status === 200 && typeof token === 'string', login.status);
    const stepUp = async (targetId) => {
      const minted = await send('POST', '/auth/step-up', { token, body: { password: PASSWORD, action: 'group.ownership_status', targetId } });
      return minted.json && minted.json.stepUpToken;
    };

    const name = `compiled drill ${crypto.randomBytes(4).toString('hex')}`;
    const created = await send('POST', '/groups', { token, body: { name } });
    const groupId = created.json && created.json.group && created.json.group.id;
    check('POST /groups creates the Group', created.status === 201 && typeof groupId === 'string', created.status);
    const principal = (await db.query('SELECT kind, handle, display_name, status, role, parent_principal_id FROM principals WHERE id = $1', [groupId])).rows[0];
    check('the Group principal is written with the Group: kind group, handle group:<id>, the name, active, no role, no parent',
      principal && principal.kind === 'group' && principal.handle === `group:${groupId}` && principal.display_name === name
      && principal.status === 'active' && principal.role === null && principal.parent_principal_id === null, principal);

    const listed = await send('GET', '/principals', { token });
    check('GET /principals lists no Group', listed.status === 200 && !listed.json.principals.some((p) => p.kind === 'group'), listed.status);
    const groups = await send('GET', '/principals?kind=group', { token });
    check('GET /principals?kind=group lists it', groups.status === 200 && groups.json.principals.some((p) => p.id === groupId), groups.status);

    const before = (await db.query('SELECT row_to_json(p)::text AS j FROM principals p WHERE id = $1', [groupId])).rows[0].j;
    const patched = await send('PATCH', `/principals/${groupId}`, { token, body: { displayName: 'renamed', status: 'disabled' } });
    check('PATCH /principals/<groupId> is GROUP_PRINCIPAL_MANAGED_BY_GROUPS', patched.status === 422 && patched.json.code === 'GROUP_PRINCIPAL_MANAGED_BY_GROUPS', patched.json);
    const terminated = await send('POST', `/principals/${groupId.toUpperCase()}/terminate`, { token, body: {} });
    check('POST /principals/<GROUPID>/terminate is GROUP_PRINCIPAL_MANAGED_BY_GROUPS', terminated.status === 422 && terminated.json.code === 'GROUP_PRINCIPAL_MANAGED_BY_GROUPS', terminated.json);
    const after = (await db.query('SELECT row_to_json(p)::text AS j FROM principals p WHERE id = $1', [groupId])).rows[0].j;
    check('the Group principal row is byte-unchanged', before === after, null);
    const refusals = (await db.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'principal.mutation_refused' AND resource_id = $1`, [groupId])).rows[0].n;
    check('both refusals are audited principal.mutation_refused', refusals === 2, refusals);

    const forged = jwt.sign({ v: 2, sub: groupId, handle: `group:${groupId}`, kind: 'group' }, JWT_SECRET, { expiresIn: '5m' });
    const asGroup = await send('GET', '/principals/me', { token: forged });
    check('a JWT naming the Group is 401', asGroup.status === 401, asGroup.status);

    const noStepUp = await send('PUT', `/groups/${groupId}/ownership-status`, { token, body: { enabled: false, reason: 'compiled drill' } });
    check('ownership-status without a step-up is STEP_UP_REQUIRED', noStepUp.status === 403 && noStepUp.json.code === 'STEP_UP_REQUIRED', noStepUp.json);
    const disabled = await send('PUT', `/groups/${groupId.toUpperCase()}/ownership-status`, { token, body: { enabled: false, reason: 'compiled drill', stepUpToken: await stepUp(groupId) } });
    check('a password step-up for the lowercase id disables through an uppercase path id', disabled.status === 200 && disabled.json.group.ownershipStatus === 'disabled', disabled.json);
    const enabled = await send('PUT', `/groups/${groupId}/ownership-status`, { token, body: { enabled: true, reason: 'compiled drill', stepUpToken: await stepUp(groupId) } });
    check('a second step-up enables it again', enabled.status === 200 && enabled.json.group.ownershipStatus === 'active', enabled.json);
    const audits = (await db.query(
      `SELECT action, metadata->>'from' AS f, metadata->>'to' AS t FROM audit_events
        WHERE resource_id = $1 AND action IN ('group.principal_disable', 'group.principal_enable') AND outcome = 'success' ORDER BY occurred_at, id`, [groupId])).rows;
    check('both acts are audited with from and to',
      audits.length === 2 && audits[0].action === 'group.principal_disable' && audits[0].t === 'disabled' && audits[1].action === 'group.principal_enable' && audits[1].t === 'active', audits);

    const project = await send('POST', '/projects', { token, body: { name: `Compiled drill ${crypto.randomBytes(3).toString('hex')}` } });
    const projectId = project.json && project.json.project && project.json.project.id;
    await db.query('UPDATE projects SET owner_principal_id = $1 WHERE id = $2', [groupId, projectId]);
    const owns = await send('DELETE', `/groups/${groupId}`, { token });
    check('DELETE refuses GROUP_OWNS_OBJECTS with counts and no ids',
      owns.status === 409 && owns.json.code === 'GROUP_OWNS_OBJECTS' && owns.json.details.owned.projects === 1 && !owns.text.includes(projectId), owns.json);
    await db.query('UPDATE projects SET owner_principal_id = NULL WHERE id = $1', [projectId]);
    const deleted = await send('DELETE', `/groups/${groupId}`, { token });
    const gone = (await db.query('SELECT count(*)::int AS n FROM groups WHERE id = $1', [groupId])).rows[0].n;
    const final = (await db.query('SELECT status, terminated_at FROM principals WHERE id = $1', [groupId])).rows[0];
    check('a cleared Group deletes and its principal is terminated with terminated_at',
      deleted.status === 200 && gone === 0 && final.status === 'terminated' && final.terminated_at !== null, { status: deleted.status, gone, final });
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
