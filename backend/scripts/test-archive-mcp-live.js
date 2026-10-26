/** Disposable PostgreSQL and compiled MCP/REST archive parity drill. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const db = process.env.RELAYHALL_TEST_DB_URL;
if (!db) throw new Error('RELAYHALL_TEST_DB_URL is required');
const target = new URL(db);
const dbName = decodeURIComponent(target.pathname.slice(1));
const localTarget = ['127.0.0.1', 'localhost'].includes(target.hostname) && /(test|fixture|contract)/i.test(dbName);
// The full CI tier's own disposable service, exactly; the same arm as role-grant-expiry-mutations.py.
const ciService = process.env.CI === 'true' && target.hostname === 'postgres' && dbName === 'relayhall_ci';
if (!(localTarget || ciService)
  || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod'].includes(dbName)) {
  throw new Error('Archive MCP drill requires an explicitly disposable local test database');
}
Object.assign(process.env, {
  DB_HOST: target.hostname, DB_PORT: target.port || '5432', DB_NAME: dbName,
  DB_USER: decodeURIComponent(target.username), DB_PASSWORD: decodeURIComponent(target.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
  RELAYHALL_CREDENTIAL_KEYS: JSON.stringify({ archiveFixture: crypto.randomBytes(32).toString('base64') }),
  RELAYHALL_CREDENTIAL_ACTIVE_KEY: 'archiveFixture',
});

const express = require('express');
const { pool } = require('../dist/db/connection');
const { registerProtectedRoutes } = require('../dist/routeRegistry');
const { authMiddleware } = require('../dist/middleware/auth');
const { sharedAuthorizationMiddleware } = require('../dist/middleware/sharedAuthorization');
const { apiErrorHandler } = require('../dist/utils/apiErrors');
const { jsonBodyOptions } = require('../dist/utils/jsonBodyTypes');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../dist/services/LoginSessionService');
const { principalService } = require('../dist/services/PrincipalService');
const { MCP_ROUTE_PATH } = require('../dist/mcp/httpRoute');
const mcpRoutes = require('../dist/mcp/httpRoute').default;
const tag = () => crypto.randomBytes(7).toString('hex');
const key = () => `archive-parity-${crypto.randomUUID()}`;
let server, origin;

async function rest(who, method, path, body) {
  const response = await fetch(origin + path, { method,
    headers: { 'Content-Type': 'application/json', ...who.headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function mcp(who, name, args = {}) {
  const response = await fetch(origin + MCP_ROUTE_PATH, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      Authorization: who.headers.Authorization },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const envelope = await response.json();
  const text = String(envelope.result?.content?.[0]?.text ?? '');
  let value;
  try { value = JSON.parse(text); } catch { value = null; }
  return { status: response.status, error: Boolean(envelope.error || envelope.result?.isError), text, value };
}
async function human() {
  const id = (await pool.query("INSERT INTO principals(kind,handle,status,role) VALUES('human',$1,'active','user') RETURNING id", [`archive-human-${tag()}`])).rows[0].id;
  const { token } = await loginSessionService.mint({ principalId: id });
  return { id, headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` } };
}
async function connector(parent, kind = 'service', boundTaskId = null, transport = 'mcp') {
  const id = (await pool.query("INSERT INTO principals(kind,handle,status,parent_principal_id,bound_task_id,purpose,own_expression) VALUES($1,$2,'active',$3,$4,'Disposable archive parity fixture',$5) RETURNING id",
    [kind, `archive-${kind}-${tag()}`, parent.id, boundTaskId, JSON.stringify({ scopes: 'parent', objects: 'parent' })])).rows[0].id;
  const issued = await principalService.issueCredential({ principalId: id,
    scopes: ['tasks:read', 'tasks:write', 'projects:read', 'projects:write'], transport },
  { handle: 'archive-parity-fixture', authMethod: 'system' });
  return { id, headers: { Authorization: `Bearer ${issued.fullKey}` } };
}
async function task(owner, projectName) {
  const created = await rest(owner, 'POST', '/tasks', { title: `Archive ${tag()}`, project: projectName });
  assert.equal(created.status, 201, `Task create ${created.status}`);
  return created.body.task.id;
}
async function status(id) {
  return (await pool.query('SELECT status,archive_disposition,notes FROM tasks WHERE id=$1', [id])).rows[0];
}
async function archiveFootprint(id) {
  const [history, dispositionAudit] = await Promise.all([
    pool.query("SELECT count(*)::int AS n FROM task_history WHERE task_id=$1 AND new_value='archived'", [id]),
    pool.query("SELECT count(*)::int AS n FROM audit_events WHERE resource_id=$1 AND action='task.account_disposition'", [id]),
  ]);
  return { task: await status(id), history: history.rows[0].n, dispositionAudit: dispositionAudit.rows[0].n };
}
function ok(result, label) {
  assert.equal(result.status, 200, `${label} HTTP ${result.status}`);
  assert.equal(result.error, false, `${label} MCP error: ${result.text}`);
  return result.value;
}

async function run() {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  app.use(MCP_ROUTE_PATH, mcpRoutes);
  registerProtectedRoutes((path, ...handlers) => app.use(path, authMiddleware, sharedAuthorizationMiddleware, ...handlers));
  app.use(apiErrorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  const owner = await human(), stranger = await human();
  const main = await connector(owner), plain = await connector(owner), plainRest = await connector(owner, 'service', null, 'api'), foreign = await connector(stranger);
  const project = (await pool.query('INSERT INTO projects(name,owner_principal_id) VALUES($1,$2) RETURNING name', [`Archive project ${tag()}`, owner.id])).rows[0].name;
  const foreignProject = (await pool.query('INSERT INTO projects(name,owner_principal_id) VALUES($1,$2) RETURNING name', [`Foreign project ${tag()}`, stranger.id])).rows[0].name;
  assert.equal((await rest(owner, 'POST', `/principals/${main.id}/owner-control`, { enabled: true, reason: 'archive parity fixture' })).status, 200);
  for (const caller of [main, plain, foreign]) ok(await mcp(caller, 'relayhall_brief_compile', { session: true }), 'bootstrap');

  const one = await task(owner, project);
  const archiveKey = key();
  const archived = ok(await mcp(main, 'relayhall_task_archive', { task: one, reason: 'filed by Main', idempotencyKey: archiveKey }), 'Main archive');
  assert.equal(archived.archived, true);
  assert.equal(archived.disposition, 'abandoned');
  assert.match(archived.warning, /non-completed/);
  assert.equal((await status(one)).status, 'archived');
  assert.match((await status(one)).notes, /filed by Main/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM task_history WHERE task_id=$1 AND new_value='archived' AND actor_principal_id=$2", [one, main.id])).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE resource_id=$1 AND action='task.account_disposition' AND actor_principal_id=$2", [one, main.id])).rows[0].n, 1);
  const archivedFootprint = await archiveFootprint(one);
  const deniedArchivedMcp = await mcp(plain, 'relayhall_task_archive', { task: one, idempotencyKey: key() });
  assert.equal(deniedArchivedMcp.error, true, 'plain MCP writer must be refused on an already archived Task');
  assert.match(deniedArchivedMcp.text, /TASK_ARCHIVE_FORBIDDEN/);
  const deniedArchivedRest = await rest(plainRest, 'POST', `/tasks/${one}/archive`, {});
  assert.equal(deniedArchivedRest.status, 403, 'plain REST writer must be refused on an already archived Task');
  assert.equal(deniedArchivedRest.body.code, 'TASK_ARCHIVE_FORBIDDEN');
  const deniedArchivedBulkMcp = ok(await mcp(plain, 'relayhall_task_archive_bulk', { taskIds: [one] }), 'plain MCP bulk refusal receipt');
  assert.equal(deniedArchivedBulkMcp.results[0].code, 'FORBIDDEN');
  const deniedArchivedBulkRest = await rest(plainRest, 'POST', '/tasks/bulk-archive', { taskIds: [one] });
  assert.equal(deniedArchivedBulkRest.status, 200);
  assert.equal(deniedArchivedBulkRest.body.results[0].code, 'FORBIDDEN');
  assert.deepEqual(await archiveFootprint(one), archivedFootprint, 'denied archived calls must have no side effects');
  const originalNotes = (await status(one)).notes;
  ok(await mcp(main, 'relayhall_task_archive', { task: one, reason: 'ignored repeat', idempotencyKey: archiveKey }), 'archive repeat');
  assert.equal((await status(one)).notes, originalNotes);
  const mainBulkRepeat = ok(await mcp(main, 'relayhall_task_archive_bulk', { taskIds: [one] }), 'Main bulk archived retry');
  assert.equal(mainBulkRepeat.results[0].code, 'ALREADY_ARCHIVED');
  assert.deepEqual(await archiveFootprint(one), archivedFootprint, 'authorized archived retries must be no-ops');
  const restored = ok(await mcp(main, 'relayhall_task_restore', { task: one }), 'Main restore');
  assert.equal(restored.restoredTo, 'todo');
  assert.equal((await status(one)).status, 'todo');

  // Existing MCP move to archived and human REST archive remain positive controls.
  ok(await mcp(main, 'relayhall_task_move', { task: one, status: 'archived' }), 'existing move archive');
  assert.equal((await status(one)).status, 'archived');
  ok(await mcp(main, 'relayhall_task_restore', { task: one }), 'restore after move');
  assert.equal((await rest(owner, 'POST', `/tasks/${one}/archive`, {})).status, 200);
  assert.equal((await rest(owner, 'POST', `/tasks/${one}/unarchive`, {})).status, 200);

  const plainTarget = await task(owner, project), beforePlain = await status(plainTarget);
  const deniedPlain = await mcp(plain, 'relayhall_task_archive', { task: plainTarget, idempotencyKey: key() });
  assert.equal(deniedPlain.error, true, 'plain writer archive must refuse');
  assert.match(deniedPlain.text, /TASK_ARCHIVE_FORBIDDEN/);
  assert.deepEqual(await status(plainTarget), beforePlain);
  const agent = await connector(owner, 'agent', plainTarget);
  ok(await mcp(agent, 'relayhall_brief_compile', { session: true }), 'Agent bootstrap');
  const deniedAgent = await mcp(agent, 'relayhall_task_archive', { task: plainTarget, idempotencyKey: key() });
  assert.equal(deniedAgent.error, true);
  assert.deepEqual(await status(plainTarget), beforePlain);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE resource_id=$1 AND action='task.account_disposition'", [plainTarget])).rows[0].n, 0);
  const foreignTarget = await task(stranger, foreignProject);
  const deniedForeign = await mcp(main, 'relayhall_task_archive', { task: foreignTarget, idempotencyKey: key() });
  assert.equal(deniedForeign.error, true);
  assert.equal((await status(foreignTarget)).status, 'todo');

  const completedA = await task(owner, project), completedB = await task(owner, project), todo = await task(owner, project);
  for (const id of [completedA, completedB]) assert.equal((await rest(owner, 'PATCH', `/tasks/${id}`, { status: 'completed' })).status, 200);
  const bulk = ok(await mcp(main, 'relayhall_task_archive_bulk', { taskIds: [completedA, foreignTarget, todo, completedB], reason: 'bulk filing' }), 'Main bulk');
  assert.deepEqual(bulk.results.map(row => row.code), ['ARCHIVED', 'NOT_FOUND', 'NOT_COMPLETED', 'ARCHIVED']);
  assert.equal(bulk.archivedCount, 2);
  assert.equal((await status(foreignTarget)).status, 'todo');
  assert.equal((await status(todo)).status, 'todo');
  const bulkRepeat = ok(await mcp(main, 'relayhall_task_archive_bulk', { taskIds: [completedA, todo] }), 'bulk repeat');
  assert.deepEqual(bulkRepeat.results.map(row => row.code), ['ALREADY_ARCHIVED', 'NOT_COMPLETED']);
  const missing = crypto.randomUUID();
  const missingSingle = await mcp(main, 'relayhall_task_archive', { task: missing, idempotencyKey: key() });
  assert.equal(missingSingle.error, true);
  const missingBulk = ok(await mcp(main, 'relayhall_task_archive_bulk', { taskIds: [missing] }), 'bulk missing');
  assert.deepEqual(missingBulk.results.map(row => row.code), ['NOT_FOUND']);
  const invalidRestore = await mcp(main, 'relayhall_task_restore', { task: todo });
  assert.equal(invalidRestore.error, true);
  await pool.query("DELETE FROM task_history WHERE task_id=$1 AND event_type='status' AND new_value='archived'", [completedA]);
  const invalidProvenance = await mcp(main, 'relayhall_task_restore', { task: completedA });
  assert.equal(invalidProvenance.error, true);
  assert.match(invalidProvenance.text, /TASK_RESTORE_PROVENANCE_REQUIRED/);
  assert.equal((await status(completedA)).status, 'archived');

  const next = await task(owner, project);
  const beforeRevokedArchived = await archiveFootprint(completedB);
  assert.equal((await rest(owner, 'POST', `/principals/${main.id}/owner-control`, { enabled: false, reason: 'archive parity revoke' })).status, 200);
  const deniedRevoked = await mcp(main, 'relayhall_task_archive', { task: next, idempotencyKey: key() });
  assert.equal(deniedRevoked.error, true);
  const deniedRevokedArchived = await mcp(main, 'relayhall_task_archive', { task: completedB, idempotencyKey: key() });
  assert.equal(deniedRevokedArchived.error, true, 'revoked Main must be refused on an archived Task');
  const deniedRevokedBulk = ok(await mcp(main, 'relayhall_task_archive_bulk', { taskIds: [completedB] }), 'revoked Main bulk refusal receipt');
  assert.equal(deniedRevokedBulk.results[0].code, 'FORBIDDEN');
  assert.deepEqual(await archiveFootprint(completedB), beforeRevokedArchived);
  assert.equal((await status(next)).status, 'todo');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE resource_id=$1 AND action='task.account_disposition'", [next])).rows[0].n, 0);
  console.log(JSON.stringify({ compiledMcp: true, single: 'pass', restore: 'pass', moveControl: 'pass', humanRestControl: 'pass', plainRefusal: 'pass', archivedMcpRestRefusal: 'pass', archivedNoop: 'pass', agentRefusal: 'pass', foreignRefusal: 'pass', bulk: 'pass', missing: 'pass', provenanceRefusal: 'pass', revokedRefusal: 'pass' }));
}

run().then(async () => { await new Promise(resolve => server.close(resolve)); await pool.end(); }, async error => {
  console.error(error.message);
  if (server) await new Promise(resolve => server.close(resolve));
  await pool.end();
  process.exitCode = 1;
});
