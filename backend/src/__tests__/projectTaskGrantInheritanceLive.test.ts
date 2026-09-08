/** Approved 0e6f09a0 / card 8e254c6a: exact Project Grants, evaluated live.
 * Ordinary authenticated HTTP callers exercise the production router and SQL.
 * Fixture provisioning does not claim credential issuance UI acceptance.
 * Requires an explicitly disposable PostgreSQL; never skips or uses a mock DB.
 */
import http from 'http';
import crypto from 'crypto';

const databaseUrl = process.env.RELAYHALL_TEST_DB_URL;
if (!databaseUrl) throw new Error('RELAYHALL_TEST_DB_URL is required; this live gate never skips');
const parsed = new URL(databaseUrl);
const database = decodeURIComponent(parsed.pathname.slice(1));
const local = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) && /test|contract|fixture/.test(database);
const ci = process.env.CI === 'true' && parsed.hostname === 'postgres' && database === 'relayhall_ci';
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
  || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod'].includes(database) || (!local && !ci)) {
  throw new Error('Refusing a non-disposable database target');
}
Object.assign(process.env, { DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: database,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex') });

/* eslint-disable @typescript-eslint/no-var-requires */
const express = require('express');
const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware, actorFromRequest } = require('../middleware/sharedAuthorization');
const { authorizationRepository } = require('../services/AuthorizationRepository');
const { principalService } = require('../services/PrincipalService');
const { accessProfileService } = require('../services/AccessProfileService');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { stepUpService } = require('../services/StepUpService');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');

jest.setTimeout(120_000);
type Caller = { id: string; headers: Record<string, string> };
let server: http.Server;
let origin: string;
let root: Caller;
const actors = new Map<string, any>();
const tag = () => `inherit-${crypto.randomBytes(6).toString('hex')}`;
const system = { handle: 'inheritance-live-fixture', authMethod: 'system' as const };

async function request(who: Caller, method: string, path: string, body?: unknown) {
  const response = await fetch(origin + path, { method,
    headers: { 'Content-Type': 'application/json', ...who.headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}
const read = (who: Caller, id: string) => request(who, 'GET', `/tasks/${id}`);
const write = (who: Caller, id: string) => request(who, 'PATCH', `/tasks/${id}`, { title: tag() });
async function account(role = 'user'): Promise<Caller> {
  const row = await pool.query(`INSERT INTO principals(kind,handle,display_name,status,role)
    VALUES('human',$1,$1,'active',$2) RETURNING id`, [tag(), role]);
  const id = String(row.rows[0].id);
  const session = await loginSessionService.mint({ principalId: id });
  return { id, headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.token}` } };
}
async function connector(parent: Caller, objects: unknown = 'parent', scopes = ['tasks:read', 'tasks:write']): Promise<Caller> {
  const row = await pool.query(`INSERT INTO principals(kind,handle,display_name,status,role,parent_principal_id,purpose,own_expression)
    VALUES('service',$1,$1,'active','user',$2,'inheritance fixture',$3::jsonb) RETURNING id`,
  [tag(), parent.id, JSON.stringify({ scopes: 'parent', objects })]);
  const id = String(row.rows[0].id);
  const credential = await principalService.issueCredential({ principalId: id, scopes, transport: 'any' }, system);
  return { id, headers: { Authorization: `Bearer ${credential.fullKey}` } };
}
async function project(owner = root.id): Promise<string> {
  const row = await pool.query(`INSERT INTO projects(name,status,visibility,owner_principal_id)
    VALUES($1,'active','private',$2) RETURNING id`, [tag(), owner]);
  return String(row.rows[0].id);
}
async function task(projectId: string | null, phaseId: string | null = null, restricted = false): Promise<string> {
  const row = await pool.query(`INSERT INTO tasks(title,status,visibility,project_id,phase_id,restricted_access,creator_principal_id)
    VALUES($1,'todo','private',$2,$3,$4,$5) RETURNING id`, [tag(), projectId, phaseId, restricted, root.id]);
  return String(row.rows[0].id);
}
async function grant(id: string, projectId: string | null, verb = 'read', type = 'project', granteeType = 'principal'): Promise<string> {
  const row = await pool.query(`INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [granteeType, id, type, projectId, verb, root.id]);
  return String(row.rows[0].id);
}
async function fixture(verb = 'read') {
  const caller = await account(); const projectId = await project(); const taskId = await task(projectId);
  const grantId = await grant(caller.id, projectId, verb);
  return { caller, projectId, taskId, grantId };
}
async function expectHidden(who: Caller, taskId: string) {
  const hidden = await read(who, taskId); const absent = await read(who, crypto.randomUUID());
  expect(hidden.status).toBe(404); expect(hidden).toEqual(absent);
}
async function actor(who: Caller) {
  await request(who, 'GET', '/tasks?limit=1');
  const result = actors.get(who.id); expect(result).toBeDefined(); return result;
}
beforeAll(async () => {
  const app = express(); app.use(express.json(jsonBodyOptions)); app.use(express.urlencoded({ extended: true }));
  registerProtectedRoutes((path: string, ...handlers: any[]) => app.use(path, authMiddleware,
    (req: any, _res: any, next: any) => { const resolved = actorFromRequest(req); actors.set(resolved.principalId, resolved); next(); },
    sharedAuthorizationMiddleware, ...handlers));
  app.use(apiErrorHandler);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as any).port}`; root = await account('admin');
});
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  await pool.end();
});

describe('exact Project Grant inheritance (approved 0e6f09a0)', () => {
  it.each(['read', 'write', 'admin'])('%s Project Grant gives precisely its ordinary Task read/write subset', async verb => {
    const f = await fixture(verb);
    expect((await read(f.caller, f.taskId)).status).toBe(200);
    expect((await write(f.caller, f.taskId)).status).toBe(verb === 'read' ? 403 : 200);
    const current = await actor(f.caller);
    for (const action of ['shepherd', 'verify', 'admin']) {
      expect([...(await authorizationRepository.authorizedIds(current, 'task', [f.taskId], action))]).toEqual([]);
    }
    if (verb !== 'read') {
      expect((await request(f.caller, 'PATCH', `/tasks/${f.taskId}`, { armed: true })).status).toBe(200);
    }
  });

  it('exact-only source excludes wildcard Project Grants, Project Profiles and Project ownership', async () => {
    const p = await project(); const t = await task(p); const wild = await account();
    await grant(wild.id, null, 'write'); await expectHidden(wild, t);
    const profiled = await account();
    const profile = await accessProfileService.create({ name: tag() }, system);
    const version = await accessProfileService.createVersion(profile.id,
      [{ resourceType: 'project', selectorForm: 'exact', selectorIds: [p], verbs: ['write'] }], system);
    await accessProfileService.publish(profile.id, version.id, system);
    await accessProfileService.assign(profile.id, { assigneeType: 'principal', assigneeId: profiled.id }, system);
    expect((await request(profiled, 'GET', `/projects/${p}/context`)).status).toBe(200);
    await expectHidden(profiled, t);
    const owner = await account(); const owned = await project(owner.id);
    expect((await request(owner, 'GET', `/projects/${owned}/context`)).status).toBe(200);
    await expectHidden(owner, await task(owned));
    const stranger = await account(); await grant(stranger.id, await project(), 'write'); await expectHidden(stranger, t);
  });

  it('Project admin remains a read/write source at the canonical selector-only boundary', async () => {
    // Operator has an ordinary admin route ceiling. The canonical selector gate
    // deliberately removes global administrator authority; no forged actor is used.
    const caller = await account('operator'); const p = await project(); const t = await task(p);
    await grant(caller.id, p, 'admin'); const resolved = await actor(caller);
    expect((await authorizationRepository.selectorCoveredIds(resolved, 'task', [t], 'write')).has(t)).toBe(true);
    expect((await authorizationRepository.selectorCoveredIds(resolved, 'task', [t], 'admin')).has(t)).toBe(false);
    await grant(caller.id, t, 'admin', 'task');
    expect((await authorizationRepository.selectorCoveredIds(resolved, 'task', [t], 'admin')).has(t)).toBe(true);
  });

  it('Task and Phase restrictions disable only inheritance and preserve exact Task grants', async () => {
    const f = await fixture('write');
    const phase = await pool.query(`INSERT INTO phases(project_id,name,restricted_access) VALUES($1,$2,TRUE) RETURNING id`, [f.projectId, tag()]);
    const taskRestricted = await task(f.projectId, null, true);
    const phaseRestricted = await task(f.projectId, String(phase.rows[0].id));
    for (const t of [taskRestricted, phaseRestricted]) {
      await expectHidden(f.caller, t); await grant(f.caller.id, t, 'write', 'task');
      expect((await read(f.caller, t)).status).toBe(200); expect((await write(f.caller, t)).status).toBe(200);
    }
    expect((await read(f.caller, f.taskId)).status).toBe(200);
  });

  it('uses the current own Project, never Phase ancestry, and requires an active existing Project', async () => {
    const f = await fixture('write'); const other = await project();
    const phase = await pool.query(`INSERT INTO phases(project_id,name) VALUES($1,$2) RETURNING id`, [f.projectId, tag()]);
    // Canonical schema rejects contradictory ancestry; do not disable it for a fixture.
    await expect(task(other, String(phase.rows[0].id))).rejects.toMatchObject({ code: '23503' });
    await expectHidden(f.caller, await task(null));
    const created = await request(root, 'POST', '/tasks', { title: tag(), project: f.projectId, visibility: 'private' });
    expect(created.status).toBe(201);
    const later = String(created.json.task.id); expect((await read(f.caller, later)).status).toBe(200);
    expect((await request(root, 'PATCH', `/tasks/${later}`, { project: other })).status).toBe(200);
    await expectHidden(f.caller, later);
    expect((await request(root, 'PATCH', `/tasks/${later}`, { project: f.projectId })).status).toBe(200);
    expect((await read(f.caller, later)).status).toBe(200);
    await pool.query(`UPDATE projects SET status='archived' WHERE id=$1`, [f.projectId]);
    await expectHidden(f.caller, f.taskId);
    await pool.query(`UPDATE projects SET status='active' WHERE id=$1`, [f.projectId]);
    expect((await read(f.caller, f.taskId)).status).toBe(200);
    await pool.query('DELETE FROM projects WHERE id=$1', [f.projectId]);
    await expectHidden(f.caller, f.taskId);
  });

  it('revocation and expiry remove subsequent access without creating Task Grants or changing ownership', async () => {
    const f = await fixture('write');
    const before = await pool.query('SELECT owner_principal_id,creator_principal_id FROM tasks WHERE id=$1', [f.taskId]);
    const grantsBefore = await pool.query('SELECT id FROM grants ORDER BY id');
    expect((await write(f.caller, f.taskId)).status).toBe(200);
    expect((await pool.query('SELECT id FROM grants ORDER BY id')).rows).toEqual(grantsBefore.rows);
    expect((await pool.query('SELECT owner_principal_id,creator_principal_id FROM tasks WHERE id=$1', [f.taskId])).rows).toEqual(before.rows);
    await pool.query(`UPDATE grants SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1`, [f.grantId]);
    await expectHidden(f.caller, f.taskId);
    await pool.query('UPDATE grants SET expires_at=NULL WHERE id=$1', [f.grantId]);
    expect((await read(f.caller, f.taskId)).status).toBe(200);
    await pool.query('DELETE FROM grants WHERE id=$1', [f.grantId]); await expectHidden(f.caller, f.taskId);
  });

  it('Group membership is live and a disabled principal loses resource access', async () => {
    const caller = await account(); const p = await project(); const t = await task(p);
    const group = await pool.query('INSERT INTO groups(name) VALUES($1) RETURNING id', [tag()]);
    const groupId = String(group.rows[0].id);
    const unrelatedMember = await account();
    await pool.query('INSERT INTO group_members(group_id,account_principal_id) VALUES($1,$2)', [groupId, unrelatedMember.id]);
    await grant(groupId, p, 'write', 'project', 'group');
    await expectHidden(caller, t);
    await pool.query('INSERT INTO group_members(group_id,account_principal_id) VALUES($1,$2)', [groupId, caller.id]);
    expect((await read(caller, t)).status).toBe(200); expect((await write(caller, t)).status).toBe(200);
    await pool.query('DELETE FROM group_members WHERE group_id=$1 AND account_principal_id=$2', [groupId, caller.id]);
    await expectHidden(caller, t);
    await pool.query('INSERT INTO group_members(group_id,account_principal_id) VALUES($1,$2)', [groupId, caller.id]);
    await grant(caller.id, p, 'write'); // Both direct and Group sources remain live.
    // The canonical mutation refreshes the principal cache at commit. A raw
    // fixture UPDATE would not represent the ordinary suspension operation.
    expect((await request(root, 'PATCH', `/principals/${caller.id}`, { status: 'disabled' })).status).toBe(200);
    expect((await read(caller, t)).status).toBe(401);
  });

  it('Connector scopes and every link Task object ceiling intersect inherited authority', async () => {
    const f = await fixture('write'); const other = await task(f.projectId);
    const rule = [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [f.taskId], verbs: ['read', 'write'] }];
    const narrow = await connector(f.caller, rule);
    // A child source still cannot widen its own cap. Connector-to-Connector
    // ancestry is forbidden; the actual three-link Agent case follows below.
    await grant(narrow.id, f.projectId, 'write');
    for (const caller of [narrow]) {
      expect((await read(caller, f.taskId)).status).toBe(200);
      expect((await write(caller, f.taskId)).status).toBe(200);
      await expectHidden(caller, other);
    }
    const projectOnly = await connector(f.caller,
      [{ resourceType: 'project', selectorForm: 'exact', selectorIds: [f.projectId], verbs: ['read', 'write'] }]);
    await expectHidden(projectOnly, f.taskId);
    const readOnly = await connector(f.caller, 'parent', ['tasks:read']);
    expect((await read(readOnly, f.taskId)).status).toBe(200);
    expect((await write(readOnly, f.taskId)).status).toBe(403);
    await pool.query('DELETE FROM grants WHERE id=$1', [f.grantId]);
    await expectHidden(narrow, f.taskId);
  });

  it('ordinary Agent mint retains its bound Task write cap after live parent authority changes', async () => {
    const f = await fixture('write'); const other = await task(f.projectId);
    // Credential issuance is unchanged: exact Task grants prove the request at mint.
    // Revoke them after legitimate issuance; subsequent resource checks use only Project authority.
    // The unchanged conservative mint algebra proves each exact selector and
    // verb separately; it does not infer read from write or union exact Grants.
    const temporary = await Promise.all([f.taskId, other].flatMap(id => ['read','write'].map(verb => grant(f.caller.id, id, verb, 'task'))));
    const step = await stepUpService.mint(f.caller.id, 'agent.mint', f.taskId, 'password');
    const minted = await request(f.caller, 'POST', '/delegation/agent-mints', {
      targetTaskId: f.taskId, stepUpToken: step.token, requestedScopes: ['tasks:read', 'tasks:write'],
      requestedRules: [f.taskId, other].map(id => ({ resourceType: 'task', selectorForm: 'exact', selectorIds: [id], verbs: ['read', 'write'] })),
    });
    if (minted.status !== 201) throw new Error(`Ordinary mint refused: ${minted.status} ${String(minted.json?.code)}`);
    expect(minted.status).toBe(201);
    const pack = minted.json.pack;
    const agent: Caller = { id: pack.principalId, headers: { Authorization: `Bearer ${pack.secretOnce}` } };
    await pool.query('DELETE FROM grants WHERE id=ANY($1::uuid[])', [temporary]);
    expect((await read(agent, f.taskId)).status).toBe(200);
    expect((await read(agent, other)).status).toBe(200);
    expect((await write(agent, f.taskId)).status).toBe(200);
    expect((await write(agent, other)).status).toBe(403);
    await pool.query('DELETE FROM grants WHERE id=$1', [f.grantId]);
    await expectHidden(agent, other); // Bound-task context read is an existing independent arm.
  });

  it('a legitimately minted three-link Agent remains bounded by its intermediate Connector', async () => {
    const f = await fixture('write'); const other = await task(f.projectId);
    const rules = [f.taskId, other].map(id => ({ resourceType: 'task', selectorForm: 'exact', selectorIds: [id], verbs: ['read', 'write'] }));
    const temporary = await Promise.all([f.taskId, other].flatMap(id => ['read','write'].map(verb => grant(f.caller.id, id, verb, 'task'))));
    const parent = await connector(f.caller, rules);
    const step = await stepUpService.mint(root.id, 'warrant.create', parent.id, 'password');
    const warrant = await request(root, 'POST', '/warrants', {
      name: tag(), holderPrincipalId: parent.id, anchors: [{ anchorType: 'project', anchorId: f.projectId }],
      ceilingRules: rules, ceilingScopes: ['tasks:read','tasks:write'],
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), stepUpToken: step.token,
    });
    if (warrant.status !== 201) throw new Error(`Warrant fixture refused: ${warrant.status} ${String(warrant.json?.code)}`);
    const minted = await request(parent, 'POST', '/delegation/agent-mints', {
      via: 'warrant', warrantId: warrant.json.warrant.id, targetTaskId: f.taskId,
      requestedScopes: ['tasks:read','tasks:write'], requestedRules: rules,
    });
    if (minted.status !== 201) throw new Error(`Three-link mint refused: ${minted.status} ${String(minted.json?.code)}`);
    const agent: Caller = { id: minted.json.pack.principalId, headers: { Authorization: `Bearer ${minted.json.pack.secretOnce}` } };
    await pool.query('DELETE FROM grants WHERE id=ANY($1::uuid[])', [temporary]);
    expect((await read(agent, other)).status).toBe(200);
    // Canonical narrowing after legitimate issuance; no schema trigger or
    // issuer is bypassed to construct an otherwise unreachable Agent.
    await pool.query('UPDATE principals SET own_expression=$2::jsonb WHERE id=$1',
      [parent.id, JSON.stringify({ scopes: 'parent', objects: rules.slice(0, 1) })]);
    expect((await read(agent, f.taskId)).status).toBe(200);
    expect((await write(agent, f.taskId)).status).toBe(200);
    await expectHidden(agent, other);
    await pool.query('DELETE FROM grants WHERE id=$1', [f.grantId]);
    expect((await write(agent, f.taskId)).status).toBe(403);
  });

  it('point, paginated SQL list, HTTP search and selector coverage agree before and after revocation', async () => {
    const f = await fixture('read'); const ids = [f.taskId, await task(f.projectId), await task(f.projectId, null, true), await task(await project())];
    const marker = tag(); await pool.query('UPDATE tasks SET title=$1 WHERE id=ANY($2::uuid[])', [marker, ids]);
    const projectName = (await pool.query('SELECT name FROM projects WHERE id=$1', [f.projectId])).rows[0].name;
    const query = `projects=${encodeURIComponent(projectName)}&statuses=todo`;
    const measure = async (expectedCount: number) => {
      const expected: string[] = [];
      for (const id of ids) if ((await read(f.caller, id)).status === 200) expected.push(id);
      expect(expected.length).toBe(expectedCount);
      const resolved = await actor(f.caller);
      const scope = authorizationRepository.listScope(resolved, 'task', 'read');
      const condition = scope.render(2);
      const where = `${scope.id}=ANY($1::uuid[]) AND (${condition.sql})`;
      const count = await pool.query(`SELECT COUNT(*)::int AS count FROM ${scope.from} WHERE ${where}`, [ids, ...condition.params]);
      expect(count.rows[0].count).toBe(expected.length);
      const paged: string[] = [];
      for (let offset = 0; offset < expected.length + 1; offset++) {
        const rows = await pool.query(`SELECT ${scope.id}::text AS id FROM ${scope.from} WHERE ${where} ORDER BY ${scope.id} LIMIT 1 OFFSET ${offset}`, [ids, ...condition.params]);
        paged.push(...rows.rows.map((row: any) => row.id));
      }
      expect(paged.sort()).toEqual(expected.sort());
      const search = await request(f.caller, 'GET', `/tasks?q=${marker}`);
      expect(search.status).toBe(200); expect(search.json.tasks.map((row: any) => row.id).sort()).toEqual(expected.sort());
      for (const surface of ['ids', 'graph']) {
        const response = await request(f.caller, 'GET', `/tasks/${surface}?${query}`);
        expect(response.status).toBe(200);
        const found = new Set<string>();
        const walk = (value: any): void => {
          if (typeof value === 'string' && ids.includes(value)) found.add(value);
          else if (Array.isArray(value)) value.forEach(walk);
          else if (value && typeof value === 'object') Object.values(value).forEach(walk);
        };
        walk(response.json); expect([...found].sort()).toEqual(expected.sort());
      }
      const aggregate = await request(f.caller, 'GET', `/tasks/aggregates?${query}&groupBy=project`);
      expect(aggregate.status).toBe(200); expect(aggregate.json.total).toBe(expected.length);
      const board = await request(f.caller, 'GET', `/tasks/board?${query}&perColumn=1`);
      expect(board.status).toBe(200);
      const column = board.json.columns.todo;
      expect(column.total).toBe(expected.length); expect(column.items.length).toBe(Math.min(1, expected.length));
      expect(column.hasMore).toBe(expected.length > 1);
      expect([...(await authorizationRepository.selectorCoveredIds(resolved, 'task', ids))].sort()).toEqual(expected.sort());
    };
    await measure(2); await pool.query('DELETE FROM grants WHERE id=$1', [f.grantId]); await measure(0);
  });
});
