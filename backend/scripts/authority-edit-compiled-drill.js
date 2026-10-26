#!/usr/bin/env node
/**
 * Card 1a38270d — AZ-A13 stage 2 (edit in place) against the COMPILED process.
 *
 * The live suite (src/__tests__/authorityEditLive.test.ts) drives the
 * production router in-process. This drill boots `dist/server.js` itself — the
 * artefact the container runs — against a REAL migrated PostgreSQL and replays
 * the owner's acceptance test (E95) over HTTP with a REAL login and a REAL
 * password step-up:
 *
 *   - a Connector registered under the signed-in administrator, pinned to MCP,
 *     bootstraps over MCP and is refused relayhall_phase_create (no
 *     phases:write);
 *   - PATCH /credentials/<id> without a step-up is STEP_UP_REQUIRED; with a
 *     password step-up minted through POST /auth/step-up for
 *     (credential.edit, id) it adds phases:read and phases:write IN PLACE;
 *   - the SAME token, its configuration untouched, then creates a phase on its
 *     next MCP call; the credential's id, key_id, secret hash and ciphertext
 *     are byte-unchanged and no second credential exists;
 *   - the agent's door: a second Connector files kind authority-edit over MCP,
 *     the administrator approves it on /approvals with a step-up for
 *     (approval.decide, id) and lifetime keep, and that Connector's next call
 *     creates a phase;
 *   - the Connector's own bearer on PATCH /credentials/<id> is SESSION_ONLY;
 *   - (review round 1, B1) "until this task ends" on mcp -> api is
 *     EDIT_LIFETIME_REQUIRED naming transport, and a widening whose added
 *     scopes a later narrowing left alone in the set stays due, never closed,
 *     at its task's terminal.
 *
 * Usage (after `npm run build`, from backend/):
 *   RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \
 *     node scripts/authority-edit-compiled-drill.js
 *
 * DESTRUCTIVE: writes principals, services, credentials, projects, phases,
 * approvals, step-up tokens and audit rows. It refuses any deployment database
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
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
const BASE_SCOPES = ['tasks:read', 'tasks:write', 'projects:read', 'principals:read'];
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-authority-edit-drill-'));
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
      // The mocked suite's deterministic TEST keyset (backend/jest.config.js):
      // the live suites run on this database first, and the startup canary
      // (T30) must decrypt the rows they issued.
      RELAYHALL_CREDENTIAL_KEYS: JSON.stringify({ testkey: Buffer.alloc(32, 7).toString('base64') }),
      RELAYHALL_CREDENTIAL_ACTIVE_KEY: 'testkey',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += String(d); });
  child.stderr.on('data', (d) => { output += String(d); });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const secrets = [];
  try {
    const deadline = Date.now() + 90_000;
    let up = false;
    while (Date.now() < deadline && !up) {
      try { up = (await fetch(`${origin}/health`)).ok; } catch { /* not yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    if (!up) throw new Error(`the compiled server did not come up:\n${output.slice(-2000)}`);
    check('dist/server.js boots against the migrated database', true);

    const send = async (method, route, { token, body, headers } = {}) => {
      const response = await fetch(`${origin}${route}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(headers || {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      return { status: response.status, json, text };
    };
    const mcp = async (token, name, args) => {
      const answered = await send('POST', '/mcp', {
        token, headers: { Accept: 'application/json, text/event-stream' },
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      });
      const result = answered.json && answered.json.result;
      return {
        failed: Boolean(answered.json && answered.json.error) || Boolean(result && result.isError),
        text: String((result && result.content && result.content[0] && result.content[0].text) || answered.text),
      };
    };

    const login = await send('POST', '/auth/login', { body: { password: PASSWORD } });
    const token = login.json && login.json.token;
    check('a real dashboard login answers a token', login.status === 200 && typeof token === 'string', login.status);
    const stepUp = async (action, targetId) => {
      const minted = await send('POST', '/auth/step-up', { token, body: { password: PASSWORD, action, targetId } });
      return minted.json && minted.json.stepUpToken;
    };

    const project = await send('POST', '/projects', { token, body: { name: `AZ-A13 compiled ${crypto.randomBytes(3).toString('hex')}` } });
    const projectId = project.json && project.json.project && project.json.project.id;
    check('a project to create phases in', project.status === 201 && typeof projectId === 'string', project.status);

    const register = async (transport) => {
      const slug = `az13-compiled-${crypto.randomBytes(4).toString('hex')}`;
      const registered = await send('POST', '/services', { token, body: {
        slug, name: slug, description: 'AZ-A13 compiled drill connector.', kind: 'connector',
        issueCredential: { scopes: BASE_SCOPES, label: slug, transport },
      } });
      const credential = registered.json && registered.json.onboarding && registered.json.onboarding.credential;
      if (credential && credential.secretOnce) secrets.push(String(credential.secretOnce));
      return { status: registered.status, credentialId: credential && credential.credentialId, secret: credential && credential.secretOnce };
    };
    const codex = await register('mcp');
    check('a Connector is registered under the signed-in administrator, pinned to MCP', codex.status === 201 && codex.secret, codex.status);
    const account = (await db.query(
      `SELECT a.role FROM principal_credentials c JOIN principals p ON p.id = c.principal_id JOIN principals a ON a.id = p.parent_principal_id WHERE c.id = $1`,
      [codex.credentialId])).rows[0];
    check('its Account is an administrator (the E95 shape: the root sentinel)', account && ['admin', 'orchestrator'].includes(account.role), account);
    const before = (await db.query('SELECT id, key_id, secret_hash, secret_ciphertext AS cipher, scopes FROM principal_credentials WHERE id = $1', [codex.credentialId])).rows[0];

    const bootstrap = await mcp(codex.secret, 'relayhall_brief_compile', { session: true });
    check('the Connector bootstraps over MCP', !bootstrap.failed, bootstrap.text.slice(0, 200));
    const refused = await mcp(codex.secret, 'relayhall_phase_create', { projectId, name: 'refused', idempotencyKey: `az13-refused-${crypto.randomUUID()}` });
    check('relayhall_phase_create is refused, naming phases:write', refused.failed && refused.text.includes('phases:write'), refused.text.slice(0, 300));

    const wanted = [...BASE_SCOPES, 'phases:read', 'phases:write'];
    const noStepUp = await send('PATCH', `/credentials/${codex.credentialId}`, { token, body: { scopes: wanted, lifetime: { choice: 'keep' } } });
    check('a widening without a step-up is STEP_UP_REQUIRED', noStepUp.status === 403 && noStepUp.json.code === 'STEP_UP_REQUIRED', noStepUp.json);
    const widened = await send('PATCH', `/credentials/${String(codex.credentialId).toUpperCase()}`, { token, body: {
      scopes: wanted, lifetime: { choice: 'keep' }, stepUpToken: await stepUp('credential.edit', codex.credentialId),
    } });
    check('a password step-up for (credential.edit, id) adds phases:read and phases:write in place, through an uppercase path id',
      widened.status === 200 && widened.json.edit.direction === 'widening' && widened.json.edit.objectId === codex.credentialId, widened.json);

    const created = await mcp(codex.secret, 'relayhall_phase_create', { projectId, name: 'E95 acceptance', idempotencyKey: `az13-created-${crypto.randomUUID()}` });
    check('E95: the SAME token, configuration untouched, creates a phase on its next call', !created.failed, created.text.slice(0, 300));
    const after = (await db.query('SELECT id, key_id, secret_hash, secret_ciphertext AS cipher, scopes FROM principal_credentials WHERE id = $1', [codex.credentialId])).rows[0];
    check('the credential keeps its id, key_id, secret hash and ciphertext',
      after.id === before.id && after.key_id === before.key_id && after.secret_hash === before.secret_hash && after.cipher === before.cipher,
      { keyId: [before.key_id, after.key_id] });
    const count = (await db.query('SELECT COUNT(*)::int AS n FROM principal_credentials WHERE principal_id = (SELECT principal_id FROM principal_credentials WHERE id = $1)', [codex.credentialId])).rows[0].n;
    check('no second credential exists on the connection', count === 1, count);
    const phases = (await db.query('SELECT COUNT(*)::int AS n FROM phases WHERE project_id = $1', [projectId])).rows[0].n;
    check('exactly one phase was created', phases === 1, phases);

    // The agent's door (an unpinned Connector, so REST reaches the route).
    const agentDoor = await register('any');
    const bearerEdit = await send('PATCH', `/credentials/${agentDoor.credentialId}`, { token: agentDoor.secret, body: { scopes: [...BASE_SCOPES, 'phases:read'] } });
    check('a Connector\'s own bearer on PATCH /credentials/<its id> is SESSION_ONLY', bearerEdit.status === 403 && bearerEdit.json.code === 'SESSION_ONLY', bearerEdit.json);
    await mcp(agentDoor.secret, 'relayhall_brief_compile', { session: true });
    const filed = await mcp(agentDoor.secret, 'relayhall_access_request', {
      action: 'file', kind: 'authority-edit', object: { type: 'credential' }, addScopes: ['phases:read', 'phases:write'],
      reason: 'The compiled drill needs to create a phase on its project.',
    });
    const approvalId = (/"id":\s*"([0-9a-f-]{36})"/.exec(filed.text) || [])[1];
    check('the second Connector files kind authority-edit over MCP', !filed.failed && approvalId, filed.text.slice(0, 300));
    const approved = await send('POST', `/approvals/${approvalId}/approve`, { token, body: {
      lifetime: { choice: 'keep' }, stepUpToken: await stepUp('approval.decide', approvalId),
    } });
    check('the administrator approves it on /approvals with step-up and keep', approved.status === 200 && approved.json.approval.status === 'approved', approved.json);
    const viaDoor = await mcp(agentDoor.secret, 'relayhall_phase_create', { projectId, name: 'agent door', idempotencyKey: `az13-door-${crypto.randomUUID()}` });
    check('that Connector\'s next call creates a phase', !viaDoor.failed, viaDoor.text.slice(0, 300));

    // Review round 1, B1 (clause 6j): "until this task ends" is refused for an
    // edit no revert can undo by narrowing, and a revert that cannot remove
    // everything its widening added leaves the record due instead of closed.
    const task = await send('POST', '/tasks', { token, body: { title: 'AZ-A13 compiled lifetime', description: 'compiled drill', status: 'todo', project: projectId } });
    const taskId = task.json && task.json.task && task.json.task.id;
    check('a task to bind "until this task ends" to', task.status === 201 && typeof taskId === 'string', task.status);
    const untilTask = { choice: 'until-task', taskId };
    const unrevertible = await send('PATCH', `/credentials/${codex.credentialId}`, { token, body: {
      transport: 'api', lifetime: untilTask, stepUpToken: await stepUp('credential.edit', codex.credentialId),
    } });
    check('B1: mcp -> api "until this task ends" is EDIT_LIFETIME_REQUIRED naming transport, and the pin stays mcp',
      unrevertible.status === 422 && unrevertible.json.code === 'EDIT_LIFETIME_REQUIRED'
        && JSON.stringify(unrevertible.json.unrevertible) === '["transport"]'
        && (await db.query('SELECT transport FROM principal_credentials WHERE id = $1', [codex.credentialId])).rows[0].transport === 'mcp',
      unrevertible.json);
    const emptied = await register('any');
    const widenedUntil = await send('PATCH', `/credentials/${emptied.credentialId}`, { token, body: {
      scopes: [...BASE_SCOPES, 'phases:read'], lifetime: untilTask, stepUpToken: await stepUp('credential.edit', emptied.credentialId),
    } });
    const narrowedToAdded = await send('PATCH', `/credentials/${emptied.credentialId}`, { token, body: { scopes: ['phases:read'] } });
    // Archived, the other terminal (completion needs the task's independent Verifier).
    const ended = await send('POST', `/tasks/${taskId}/archive`, { token, body: {} });
    const record = (await db.query(
      `SELECT id, edit_reverted_at FROM approvals WHERE kind = 'authority-edit' AND edit_object_id = $1 AND edit_lifetime = 'until-task'`,
      [emptied.credentialId])).rows[0];
    const scopesNow = (await db.query('SELECT scopes FROM principal_credentials WHERE id = $1', [emptied.credentialId])).rows[0].scopes;
    const item = record ? await send('GET', `/approvals/${record.id}`, { token }) : { json: null };
    const lifetime = item.json && item.json.approval && item.json.approval.authorityEdit && item.json.approval.authorityEdit.lifetime;
    check('B1: a widening whose added scopes a later narrowing left alone stays due and visible at the terminal, never closed',
      widenedUntil.status === 200 && narrowedToAdded.status === 200 && ended.status < 300 && record
        && record.edit_reverted_at === null && JSON.stringify(scopesNow) === '["phases:read"]'
        && lifetime && lifetime.due === true && lifetime.revertedAt === null,
      { widened: widenedUntil.status, narrowed: narrowedToAdded.status, ended: [ended.status, ended.json], record, scopesNow, lifetime });

    const suffixes = secrets.map((secret) => secret.split('.').pop());
    const leaked = suffixes.filter((suffix) => output.includes(suffix));
    check('no secret suffix reached the server log', leaked.length === 0 && suffixes.length === 3, leaked.length);
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
