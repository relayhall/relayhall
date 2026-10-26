/** Explicit Project owner: production auth/router/SQL against a disposable DB.
 * This gate fails closed without a named local test database. Never point it
 * at a deployment database or reuse real Accounts/Grants.
 */
import http from 'http';
import crypto from 'crypto';

const databaseUrl = process.env.RELAYHALL_TEST_DB_URL;
if (!databaseUrl) throw new Error('RELAYHALL_TEST_DB_URL is required for Project owner live gate');
const parsed = new URL(databaseUrl);
const database = decodeURIComponent(parsed.pathname.slice(1));
const local = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) && /test|contract|fixture/.test(database);
const ci = process.env.CI === 'true' && parsed.hostname === 'postgres' && database === 'relayhall_ci';
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
  || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod'].includes(database) || (!local && !ci)) {
  throw new Error('Refusing a non-disposable Project owner database target');
}
Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: database,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
});

/* eslint-disable @typescript-eslint/no-var-requires */
const express = require('express');
const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { principalService } = require('../services/PrincipalService');
const { auditService } = require('../services/AuditService');

jest.setTimeout(120_000);
type Caller = { id: string; headers: Record<string, string> };
let server: http.Server;
let origin: string;
let admin: Caller;
const tag = () => `owner-${crypto.randomBytes(7).toString('hex')}`;
const system = { handle: 'project-owner-live-fixture', authMethod: 'system' as const };

async function request(who: Caller, method: string, path: string, body?: unknown, revision?: string) {
  const response = await fetch(origin + path, {
    method, headers: { 'Content-Type': 'application/json', ...who.headers, ...(revision ? { 'If-Match': revision } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function account(role = 'user'): Promise<Caller> {
  const row = await pool.query(`INSERT INTO principals(kind,handle,display_name,status,role)
    VALUES('human',$1,$1,'active',$2) RETURNING id`, [tag(), role]);
  const id = String(row.rows[0].id);
  const session = await loginSessionService.mint({ principalId: id });
  return { id, headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.token}` } };
}
async function child(parent: Caller): Promise<Caller> {
  const row = await pool.query(`INSERT INTO principals(kind,handle,display_name,status,role,parent_principal_id,purpose,own_expression)
    VALUES('service',$1,$1,'active','user',$2,'owner live fixture',$3::jsonb) RETURNING id`,
    [tag(), parent.id, JSON.stringify({ scopes: 'parent', objects: 'parent' })]);
  const id = String(row.rows[0].id);
  const key = await principalService.issueCredential({ principalId: id, scopes: ['projects:read', 'phases:read', 'tasks:read'], transport: 'any' }, system);
  return { id, headers: { Authorization: `Bearer ${key.fullKey}` } };
}
async function fixture() {
  const row = await pool.query(`INSERT INTO projects(name,status,visibility,owner_principal_id)
    VALUES($1,'active','private',NULL) RETURNING id,revision`, [tag()]);
  const projectId = String(row.rows[0].id);
  const phase = await pool.query(`INSERT INTO phases(project_id,name) VALUES($1,$2) RETURNING id`, [projectId, tag()]);
  const task = await pool.query(`INSERT INTO tasks(title,status,visibility,project_id,creator_principal_id)
    VALUES($1,'todo','private',$2,$3) RETURNING id`, [tag(), projectId, admin.id]);
  return { projectId, phaseId: String(phase.rows[0].id), taskId: String(task.rows[0].id), revision: String(row.rows[0].revision) };
}
const ownerWrite = (who: Caller, projectId: string, ownerPrincipalId: string | null, revision: string) =>
  request(who, 'PUT', `/projects/${projectId}/owner`, { ownerPrincipalId }, revision);

beforeAll(async () => {
  const app = express(); app.use(express.json(jsonBodyOptions));
  registerProtectedRoutes((mount: string, ...handlers: any[]) => app.use(mount, authMiddleware, sharedAuthorizationMiddleware, ...handlers));
  app.use(apiErrorHandler);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  admin = await account('admin');
});
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  await pool.end();
});

test('null creation, assignment and transfer change Project/Phase authority, including an existing delegated child, but never Task roles', async () => {
  const f = await fixture();
  const originalRoles=(await pool.query('SELECT owner_principal_id,shepherd_principal_id,verifier_principal_id FROM tasks WHERE id=$1',[f.taskId])).rows[0];
  const oldOwner = await account(); const oldChild = await child(oldOwner);
  const nextOwner = await account();
  expect((await request(oldOwner, 'GET', `/projects/${f.projectId}`)).status).toBe(404);
  expect((await request(oldChild, 'GET', `/phases/${f.phaseId}`)).status).toBe(404);
  const initial = await request(admin, 'GET', `/projects/${f.projectId}`);
  expect(initial.body.project.ownerPrincipalId).toBeNull();
  const assigned = await ownerWrite(admin, f.projectId, oldOwner.id, f.revision);
  expect(assigned.status).toBe(200);
  expect(assigned.body.project.ownerPrincipalId).toBe(oldOwner.id);
  expect((await request(oldOwner, 'GET', `/projects/${f.projectId}`)).status).toBe(200);
  expect((await request(oldChild, 'GET', `/projects/${f.projectId}`)).status).toBe(200);
  expect((await request(oldOwner, 'GET', `/phases/${f.phaseId}`)).status).toBe(200);
  expect((await request(oldChild, 'GET', `/phases/${f.phaseId}`)).status).toBe(200);
  expect((await request(oldOwner, 'GET', `/tasks/${f.taskId}`)).status).toBe(200);

  const moved = await ownerWrite(admin, f.projectId, nextOwner.id, assigned.body.project.revision);
  expect(moved.status).toBe(200);
  expect((await request(oldOwner, 'GET', `/projects/${f.projectId}`)).status).toBe(404);
  expect((await request(oldChild, 'GET', `/phases/${f.phaseId}`)).status).toBe(404);
  expect((await request(nextOwner, 'GET', `/projects/${f.projectId}`)).status).toBe(200);
  expect((await request(nextOwner, 'GET', `/phases/${f.phaseId}`)).status).toBe(200);
  expect((await request(nextOwner, 'GET', `/tasks/${f.taskId}`)).status).toBe(200);
  expect((await request(oldOwner, 'GET', `/tasks/${f.taskId}`)).status).toBe(404);
  // Inherited account ownership changes access, never Task workflow roles.
  expect((await pool.query('SELECT owner_principal_id,shepherd_principal_id,verifier_principal_id FROM tasks WHERE id=$1',[f.taskId])).rows[0])
    .toEqual(originalRoles);
  // An explicit Task account owner takes precedence over Project inheritance.
  await pool.query('UPDATE tasks SET account_owner_principal_id=$1 WHERE id=$2',[oldOwner.id,f.taskId]);
  expect((await request(nextOwner, 'GET', `/tasks/${f.taskId}`)).status).toBe(404);
  expect((await request(oldOwner, 'GET', `/tasks/${f.taskId}`)).status).toBe(200);
  // A delegated child created only after transfer was never a former reader.
  // The content-free transition feed must not reconstruct historical owner
  // rights from this child's current parent relationship.
  const laterChild = await child(oldOwner);
  const events = await request(laterChild, 'GET', '/events?cursor=0&limit=500');
  expect(events.status).toBe(200);
  expect(events.body.events.filter((event: any) => event.objectId === f.projectId || event.objectId === f.phaseId)).toEqual([]);
});

test('ordinary user holding admin Grant cannot change owner; hidden write and absent write are concealed equally', async () => {
  const f = await fixture(); const grantee = await account(); const outsider = await account();
  await pool.query(`INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id)
    VALUES('principal',$1,'project',$2,'admin',$3)`, [grantee.id, f.projectId, admin.id]);
  const access = await request(grantee, 'GET', `/projects/${f.projectId}/owner-access`);
  expect(access.status).toBe(200);
  expect(access.body.access).toMatchObject({ allowed: false, reason: 'CURRENT_ROLE_CEILING' });
  const denied = await ownerWrite(grantee, f.projectId, grantee.id, f.revision);
  expect(denied.status).toBe(403);
  expect(denied.body.code).toBe('CURRENT_ROLE_CEILING');
  const hidden = await ownerWrite(outsider, f.projectId, outsider.id, f.revision);
  const absent = await ownerWrite(outsider, crypto.randomUUID(), outsider.id, f.revision);
  expect(hidden.status).toBe(404);
  expect(hidden).toEqual(absent);
});

test('clearing owner removes only owner-derived access and leaves an independent Grant until separately revoked', async () => {
  const f = await fixture(); const owner = await account();
  const assigned = await ownerWrite(admin, f.projectId, owner.id, f.revision);
  expect(assigned.status).toBe(200);
  const grant = await pool.query(`INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id)
    VALUES('principal',$1,'project',$2,'read',$3) RETURNING id`, [owner.id, f.projectId, admin.id]);
  const cleared = await ownerWrite(admin, f.projectId, null, assigned.body.project.revision);
  expect(cleared.status).toBe(200);
  expect(cleared.body.project.ownerPrincipalId).toBeNull();
  expect((await request(owner, 'GET', `/projects/${f.projectId}`)).status).toBe(200);
  // A Project read Grant is separate from the owner arm and does not confer
  // Phase access; only the independent Project read remains until revocation.
  expect((await request(owner, 'GET', `/phases/${f.phaseId}`)).status).toBe(404);
  await pool.query('DELETE FROM grants WHERE id=$1', [grant.rows[0].id]);
  expect((await request(owner, 'GET', `/projects/${f.projectId}`)).status).toBe(404);
  expect((await request(owner, 'GET', `/phases/${f.phaseId}`)).status).toBe(404);
});

test('competing revision-bound owner changes serialize; one wins and one receives 412', async () => {
  const f = await fixture(); const first = await account(); const second = await account();
  const results = await Promise.all([
    ownerWrite(admin, f.projectId, first.id, f.revision),
    ownerWrite(admin, f.projectId, second.id, f.revision),
  ]);
  expect(results.map(result => result.status).sort()).toEqual([200, 412]);
  const winner = results.find(result => result.status === 200)!;
  const current = await request(admin, 'GET', `/projects/${f.projectId}`);
  expect(current.body.project.ownerPrincipalId).toBe(winner.body.project.ownerPrincipalId);
  const audit = await pool.query(`SELECT COUNT(*)::int AS count FROM audit_events
    WHERE resource_type='project' AND resource_id=$1 AND action='project.owner.change'`, [f.projectId]);
  expect(audit.rows[0].count).toBe(1);
});

test('audit failure rolls back owner, revision and feed events in actual PostgreSQL', async () => {
  const f = await fixture(); const target = await account();
  const original = auditService.record;
  auditService.record = async () => { throw new Error('synthetic audit failure'); };
  try {
    const failed = await ownerWrite(admin, f.projectId, target.id, f.revision);
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('OWNER_CHANGE_UNAVAILABLE');
  } finally { auditService.record = original; }
  const stored = await pool.query('SELECT owner_principal_id, revision FROM projects WHERE id=$1', [f.projectId]);
  expect(stored.rows[0].owner_principal_id).toBeNull();
  expect(stored.rows[0].revision).toBe(f.revision);
  const feed = await pool.query(`SELECT COUNT(*)::int AS count FROM feed_events
    WHERE object_type='project' AND object_id=$1 AND name='project.acl_changed'`, [f.projectId]);
  expect(feed.rows[0].count).toBe(0);
});
