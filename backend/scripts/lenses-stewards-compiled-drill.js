#!/usr/bin/env node
/**
 * Card 46cfbd1d — LENSES-c c1-A against the COMPILED process.
 *
 * The live suite (src/__tests__/groupStewardsLive.test.ts) drives the
 * production router in-process. This drill boots `dist/server.js` itself — the
 * artefact the container runs — against a REAL migrated PostgreSQL and replays
 * the slice's acts over HTTP with a REAL dashboard login, a REAL per-Account
 * password login and a REAL password step-up:
 *
 *   - a root login session appoints an owner and a manager
 *     (POST /groups/<id>/stewards) and reads them back live, owners first;
 *   - STEWARD_INELIGIBLE refuses the Group principal itself (reason kind);
 *   - the owner signs in through POST /auth/session, sees the catalog's
 *     steward row and SR-2 without the grantor;
 *   - the owner's manager removal without a step-up is STEP_UP_REQUIRED, an
 *     owner row is STEWARD_OWNER_ROW_ROOT_ONLY, and neither spends the token;
 *     a password step-up minted for the LOWERCASE Group id removes the manager
 *     through an UPPERCASE path id;
 *   - DELETE /groups/<id> answers GROUP_HAS_STEWARDS with a count until the
 *     root removal, then deletes.
 *
 * It needs a FRESH database: load database/init.sql into an empty disposable
 * database, run `npm run migrate`, and point the drill at it before anything
 * else has written there. Do not reuse one the live suite, the mutation drill
 * or an earlier run of this drill has written to: rows left behind by those
 * runs (principals, sessions, steward rows, references, audit rows) can change
 * the answers it checks. Recreate the database for every run.
 *
 * Usage (after `npm run build`, from backend/):
 *   RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \
 *     node scripts/lenses-stewards-compiled-drill.js
 *
 * DESTRUCTIVE: writes groups, principals, members, steward rows, references,
 * grants, step-up tokens and audit rows. It refuses any deployment database
 * and any non-local host. Exit 0 = every check held; the process it started is
 * always stopped.
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
const OWNER_PASSWORD = `${crypto.randomBytes(18).toString('base64url')}Aa1!`;
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `  -> ${JSON.stringify(detail)}`}`);
};
const tag = () => crypto.randomBytes(4).toString('hex');

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-lenses-stewards-drill-'));
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

    const send = async (method, route, { token, cookie, body } = {}) => {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (cookie) headers.Cookie = cookie;
      const response = await fetch(`${origin}${route}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      return { status: response.status, json, text, setCookie: response.headers.get('set-cookie') };
    };

    const login = await send('POST', '/auth/login', { body: { password: PASSWORD } });
    const token = login.json && login.json.token;
    check('a real dashboard login answers a token', login.status === 200 && typeof token === 'string', login.status);

    const created = await send('POST', '/groups', { token, body: { name: `compiled stewards ${tag()}` } });
    const G = created.json && created.json.group && created.json.group.id;
    check('POST /groups creates the Group', created.status === 201 && typeof G === 'string', created.status);

    const account = async (label) => (await db.query(
      `INSERT INTO principals (kind, handle, display_name, status, role) VALUES ('human', $1, $1, 'active', 'editor') RETURNING id, handle`,
      [`c1a-compiled-${label}-${tag()}`])).rows[0];
    const owner = await account('owner');
    const manager = await account('manager');
    const member = await account('member');
    for (const who of [owner, manager, member]) {
      const added = await send('POST', `/groups/${G}/members`, { token, body: { accountPrincipalId: who.id } });
      check(`POST /groups/<id>/members adds the ${who.handle.split('-')[2]}`, added.status === 201, added.json);
    }

    const appointOwner = await send('POST', `/groups/${G}/stewards`, { token, body: { accountPrincipalId: owner.id, role: 'owner' } });
    check('a root login session appoints the owner', appointOwner.status === 201 && appointOwner.json.steward.live === true, appointOwner.json);
    const appointManager = await send('POST', `/groups/${G}/stewards`, { token, body: { accountPrincipalId: manager.id, role: 'manager' } });
    check('a root login session appoints the manager', appointManager.status === 201, appointManager.json);
    const asGroup = await send('POST', `/groups/${G}/stewards`, { token, body: { accountPrincipalId: G, role: 'manager' } });
    check('the Group principal itself is STEWARD_INELIGIBLE (reason kind)',
      asGroup.status === 422 && asGroup.json.code === 'STEWARD_INELIGIBLE' && asGroup.json.details.reason === 'kind', asGroup.json);
    const listed = await send('GET', `/groups/${G}/stewards`, { token });
    check('GET /groups/<id>/stewards lists the owner first, both live',
      listed.status === 200 && listed.json.stewards.map((s) => s.role).join(',') === 'owner,manager'
      && listed.json.stewards.every((s) => s.live === true && s.inertReason === null), listed.json);

    const password = await send('PUT', `/principals/${owner.id}/password`, { token, body: { password: OWNER_PASSWORD } });
    check('root gives the owner a password', password.status === 200, password.json);
    const session = await send('POST', '/auth/session', { body: { account: owner.handle, password: OWNER_PASSWORD } });
    const cookie = (session.setCookie || '').split(';')[0];
    check('the owner signs in with a per-Account login session', session.status === 200 && cookie.includes('='), session.status);

    const provider = await db.query(
      `INSERT INTO identity_providers (name, status, issuer, discovery_url, client_id, subject_immutable, group_binding_mode, groups_claim)
       VALUES ($1, 'disabled', $2, $3, 'c1a-compiled', TRUE, 'claim', 'groups') RETURNING id`,
      [`c1a compiled ${tag()}`, `https://issuer.invalid/${tag()}`, `https://issuer.invalid/${tag()}/.well-known/openid-configuration`]);
    const ref = (await db.query(
      `INSERT INTO directory_group_references (identity_provider_id, external_group_ref) VALUES ($1, $2) RETURNING id`,
      [provider.rows[0].id, `c1a-compiled-${tag()}`])).rows[0].id;
    await db.query(`INSERT INTO account_directory_group_references (directory_group_reference_id, account_principal_id, source)
                    VALUES ($1, $2, 'claim')`, [ref, member.id]);
    const catalog = await send('GET', '/directory-group-references', { cookie });
    check("the owner sees the catalog's steward row: the member's reference, counted, no identities",
      catalog.status === 200 && catalog.json.references.length === 1 && catalog.json.references[0].id === ref
      && catalog.json.references[0].memberCount === 1 && !catalog.text.includes(member.id), catalog.json);
    await db.query(`INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb) VALUES ('group', $1, 'project', NULL, 'read')`, [G]);
    const grants = await send('GET', `/groups/${G}/grants`, { cookie });
    check('SR-2: the owner sees the Group grant without grantedByPrincipalId',
      grants.status === 200 && grants.json.grants.length === 1 && !('grantedByPrincipalId' in grants.json.grants[0]), grants.json);

    const noStepUp = await send('DELETE', `/groups/${G}/managers/${manager.id}`, { cookie, body: {} });
    check('the owner removal without a step-up is STEP_UP_REQUIRED', noStepUp.status === 403 && noStepUp.json.code === 'STEP_UP_REQUIRED', noStepUp.json);
    const minted = await send('POST', '/auth/step-up', { cookie, body: { password: OWNER_PASSWORD, action: 'group.manager_remove', targetId: G } });
    const stepUpToken = minted.json && minted.json.stepUpToken;
    check('a real password step-up is minted for (group.manager_remove, the lowercase Group id)', minted.status === 200 && typeof stepUpToken === 'string', minted.status);
    const ownerRow = await send('DELETE', `/groups/${G}/managers/${owner.id}`, { cookie, body: { stepUpToken } });
    check("the owner's own row is STEWARD_OWNER_ROW_ROOT_ONLY", ownerRow.status === 403 && ownerRow.json.code === 'STEWARD_OWNER_ROW_ROOT_ONLY', ownerRow.json);
    const removed = await send('DELETE', `/groups/${G.toUpperCase()}/managers/${manager.id}`, { cookie, body: { stepUpToken } });
    check('the same token, unspent by the refusal, removes the manager through an uppercase path id',
      removed.status === 200 && removed.json.removed.role === 'manager', removed.json);
    const audit = (await db.query(
      `SELECT metadata FROM audit_events WHERE action = 'group.steward_remove' AND outcome = 'success' AND resource_id = $1`, [G])).rows;
    check('the removal is audited standing group-owner with the stepUpTokenId',
      audit.length === 1 && audit[0].metadata.standing === 'group-owner' && audit[0].metadata.stepUpTokenId === removed.json.stepUpTokenId, audit);

    for (const who of [owner, manager, member]) await send('DELETE', `/groups/${G}/members/${who.id}`, { token });
    const hasStewards = await send('DELETE', `/groups/${G}`, { token });
    check('DELETE /groups/<id> answers GROUP_HAS_STEWARDS with a count and no ids',
      hasStewards.status === 409 && hasStewards.json.code === 'GROUP_HAS_STEWARDS' && hasStewards.json.details.stewards === 1
      && !hasStewards.text.includes(owner.id), hasStewards.json);
    const rootRemove = await send('DELETE', `/groups/${G}/stewards/${owner.id}`, { token });
    check('a root login session removes the owner row', rootRemove.status === 200 && rootRemove.json.removed.role === 'owner', rootRemove.json);
    const deleted = await send('DELETE', `/groups/${G}`, { token });
    check('the cleared Group deletes', deleted.status === 200, deleted.json);
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
