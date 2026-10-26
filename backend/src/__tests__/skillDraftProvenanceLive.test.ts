/**
 * Card f87776ad (owner ruling D37(d)): the dashboard's "New draft -> Save
 * immutable draft" answered a human session 409 SKILL_LIFECYCLE_CONFLICT
 * ("Illegal Skill lifecycle change") whenever the form carried the loaded
 * Version's "agent-drafted" provenance into the new draft, while REST PUT
 * /skills/:id with the default provenance succeeded.
 *
 * Provenance attests the KIND of the Principal that created a Version. The
 * guard is migration 083's insert trigger (`relayhall_validate_new_skill_version`):
 * human-authored needs a human creator, agent-drafted an agent or service
 * creator, imported any creator. That rule is unchanged here; what changed is
 * that the server now refuses a mismatch BEFORE the trigger, as a 422 that
 * names the provenance field and the caller's kind, instead of letting the
 * trigger's 23514 surface as a generic lifecycle conflict.
 *
 * Every assertion drives the PRODUCTION router over a real PostgreSQL with a
 * real login session (human) and a real bearer credential (service). It fails,
 * never skips, without a disposable database. The red proof on main is the
 * defective combination itself: a human session's PUT carrying
 * provenance "agent-drafted" answers 409 SKILL_LIFECYCLE_CONFLICT there.
 *
 * Card eb7c0271 rides the same run (the PA block at the end): publishing a
 * Skill Version writes exactly one successful `skill.publish` audit row.
 * fcd321b3 extends the same gate to every registry write and actor-aware
 * denial, plus the E112-absorbed Account create/update audit scope.
 *
 * Card 9cdc6b27 rides it too (ID-1): a Skill NAME in the path passes the
 * authorization stage, which resolves Skills by name, and on main reached a
 * uuid-typed read whose cast failure answered 500 INTERNAL_ERROR.
 */
import crypto from 'crypto';
import http from 'http';

const raw = process.env.RELAYHALL_TEST_DB_URL;
if (!raw) throw new Error('Skill draft provenance proof requires an explicit disposable database (RELAYHALL_TEST_DB_URL)');
const url = new URL(raw);
const dbName = decodeURIComponent(url.pathname.slice(1));
if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !(/^skill_provenance_[a-z0-9_]+$/.test(dbName) || (dbName === 'relayhall_ci' && process.env.CI === 'true'))
    || !(['127.0.0.1', 'localhost'].includes(url.hostname) || (url.hostname === 'postgres' && process.env.CI === 'true'))) {
  throw new Error('Skill draft provenance proof refuses a non-contract database/host');
}
Object.assign(process.env, {
  DB_HOST: url.hostname, DB_PORT: url.port || '5432', DB_NAME: dbName,
  DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password),
  NODE_ENV: 'test', JWT_SECRET: crypto.randomBytes(32).toString('hex'), RELAYHALL_SESSIONS: 'on',
});
const express = require('express');
const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { principalService } = require('../services/PrincipalService');
const { auditService } = require('../services/AuditService');

jest.setTimeout(60_000);

type Caller = { id: string; kind: 'human' | 'service'; headers: Record<string, string> };
let server: http.Server;
let origin: string;
let author: Caller;
let reviewer: Caller;
let connector: Caller;

const unique = (prefix: string) => `${prefix}-${crypto.randomBytes(6).toString('hex')}`;

async function call(who: Caller, method: string, route: string, body?: unknown, revision?: string) {
  const response = await fetch(origin + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...who.headers, ...(revision ? { 'If-Match': revision } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as any };
}

async function human(): Promise<Caller> {
  const id = (await pool.query(
    `INSERT INTO principals(kind, handle, display_name, status, role)
     VALUES ('human', $1, $1, 'active', 'admin') RETURNING id`, [unique('skillprov-human')],
  )).rows[0].id;
  const session = await loginSessionService.mint({ principalId: id });
  return { id, kind: 'human', headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.token}` } };
}

async function service(parent: Caller): Promise<Caller> {
  const id = (await pool.query(
    `INSERT INTO principals(kind, handle, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, 'active', $2, 'Skill draft provenance fixture', $3) RETURNING id`,
    [unique('skillprov-connector'), parent.id, JSON.stringify({ scopes: 'parent', objects: 'parent' })],
  )).rows[0].id;
  const issued = await principalService.issueCredential(
    { principalId: id, scopes: ['skills:read', 'skills:write'], transport: 'any' },
    { handle: 'fixture', authMethod: 'system' },
  );
  return { id, kind: 'service', headers: { Authorization: `Bearer ${issued.fullKey}` } };
}

function skillMd(name: string, body: string): string {
  return ['---', `name: ${name}`, 'description: Skill draft provenance proof', '---', '', body, ''].join('\n');
}

/** The body SkillDetailModal.saveDraft sends for "New draft" on an existing Skill. */
function dashboardDraft(name: string, provenance: string | undefined, body = 'Edited in the dashboard.') {
  return { skill_md: skillMd(name, body), config: {}, tags: [], ...(provenance === undefined ? {} : { provenance }) };
}

async function versions(skillId: string) {
  return (await pool.query(
    `SELECT version, provenance, created_by_principal_id FROM skill_versions WHERE skill_id = $1 ORDER BY version`,
    [skillId],
  )).rows;
}

async function revisionOf(skillId: string): Promise<string> {
  return (await pool.query('SELECT revision::text AS revision FROM skills WHERE id = $1', [skillId])).rows[0].revision;
}

/** v1 drafted by the service Principal, as relayhall-connector-bootstrap v1 was. */
async function connectorDraftedSkill() {
  const name = unique('skillprov');
  const created = await call(connector, 'POST', '/skills', {
    name, description: 'Skill draft provenance proof', usage_instructions: 'Drafted by a Connector.',
  });
  expect(created.status).toBe(201);
  expect(created.body.skill.current_version.provenance).toBe('agent-drafted');
  return { name, id: created.body.skill.id as string, revision: created.body.skill.revision as string };
}

function expectNamedProvenanceRefusal(result: { status: number; body: any }, provenance: string, kind: string) {
  expect({ status: result.status, code: result.body.code }).toEqual({ status: 422, code: 'INVALID_SKILL_VALUE' });
  expect(result.body.details).toEqual(expect.objectContaining({ field: 'provenance', provenance, principalKind: kind }));
  expect(result.body.error).toMatch(/provenance/);
  expect(result.body.error).toContain(provenance);
  expect(result.body.error).toContain(kind);
}

beforeAll(async () => {
  // Schema-only disposable databases need the migration 062/084 fallback identity.
  await pool.query(`INSERT INTO principals(kind, handle, display_name, role)
    VALUES ('human', 'dashboard_user', 'Owner', 'orchestrator') ON CONFLICT (handle) DO NOTHING`);
  const app = express();
  app.use(express.json());
  registerProtectedRoutes((mount: string, ...handlers: any[]) => {
    app.use(mount, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
    app.use('/api' + mount, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  author = await human();
  reviewer = await human();
  connector = await service(author);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// fcd321b3 + E112: full write/denial coverage uses the actual protected routers.
const AUDIT_ACTS = ['create', 'create-version', 'submit-review', 'reject', 'retire', 'set-global', 'delete', 'project-pin', 'project-unpin'] as const;
type AuditAct = typeof AUDIT_ACTS[number];
async function prepareAuditAct(act: AuditAct) {
  const marker = unique('private-audit-body');
  let id: string;
  if (act === 'delete') id = (await pool.query('INSERT INTO skills(name) VALUES($1) RETURNING id', [marker])).rows[0].id;
  else {
    const created = await call(author, 'POST', '/skills', { name: marker, description: marker, usage_instructions: marker });
    expect(created.status).toBe(201); id = created.body.skill.id;
  }
  let projectId: string | undefined;
  if (['reject', 'retire', 'set-global', 'project-pin', 'project-unpin'].includes(act)) {
    expect((await call(author, 'POST', `/skills/${id}/versions/1/submit-review`, { note: marker }, await revisionOf(id))).status).toBe(200);
  }
  if (['retire', 'set-global', 'project-pin', 'project-unpin'].includes(act)) {
    expect((await call(reviewer, 'POST', `/skills/${id}/versions/1/publish`, { note: marker }, await revisionOf(id))).status).toBe(200);
  }
  if (act.startsWith('project-')) {
    const project = await call(author, 'POST', '/projects', { name: marker });
    expect(project.status).toBe(201); projectId = project.body.project.id;
    if (act === 'project-unpin') expect((await call(author, 'PUT', `/projects/${projectId}/skills/${id}`, { version: 1 })).status).toBe(200);
  }
  const invoke = async () => {
    const revision = await revisionOf(id);
    switch (act) {
      case 'create': return call(author, 'POST', '/skills', { name: marker + '-new', description: marker, usage_instructions: marker });
      case 'create-version': return call(author, 'PUT', `/skills/${id}`, { description: marker }, revision);
      case 'submit-review': return call(author, 'POST', `/skills/${id}/versions/1/submit-review`, { note: marker }, revision);
      case 'reject': return call(reviewer, 'POST', `/skills/${id}/versions/1/reject`, { note: marker }, revision);
      case 'retire': return call(reviewer, 'POST', `/skills/${id}/versions/1/retire`, { note: marker }, revision);
      case 'set-global': return call(author, 'PATCH', `/skills/${id}/audience`, { is_global: true }, revision);
      case 'delete': return call(author, 'DELETE', `/skills/${id}`, undefined, revision);
      case 'project-pin': return call(author, 'PUT', `/projects/${projectId}/skills/${id}`, { version: 1 });
      case 'project-unpin': return call(author, 'DELETE', `/projects/${projectId}/skills/${id}`);
    }
  };
  return { id, marker, projectId, invoke };
}
async function allAuditRows(id: string, action?: string) {
  return (await pool.query(`SELECT ${AUDIT_COLUMNS} FROM audit_events a WHERE a.resource_id=$1 AND ($2::text IS NULL OR a.action=$2) ORDER BY a.occurred_at,a.id`, [id, action ?? null])).rows;
}
async function skillState(id: string) {
  const row = (await pool.query('SELECT revision::text,is_global FROM skills WHERE id=$1', [id])).rows[0] ?? null;
  const versions = (await pool.query('SELECT id::text,version,status FROM skill_version_state WHERE skill_id=$1 ORDER BY version', [id])).rows;
  const pins = (await pool.query('SELECT project_id::text,skill_version_id::text FROM project_skills WHERE skill_id=$1 ORDER BY project_id', [id])).rows;
  return { row, versions, pins };
}
test.each(AUDIT_ACTS)('AU successful %s writes one safe actor-aware row', async act => {
  const f = await prepareAuditAct(act); const before = await allAuditRows(f.id);
  const spy = jest.spyOn(auditService, 'record');
  let result: any; let writeCalls: any[];
  try { result = await f.invoke(); writeCalls = spy.mock.calls.slice(); }
  finally { spy.mockRestore(); }
  expect([200, 201]).toContain(result.status);
  const writes = writeCalls!.filter(([write]) => write.action === `skill.${act.replace(/-/g, '_')}` && write.outcome !== 'denied');
  expect(writes).toHaveLength(1); expect(writes[0][1]).not.toBe(pool); expect(writes[0][1].query).toEqual(expect.any(Function));
  const id = act === 'create' ? result.body.skill.id : f.id;
  const rows = await allAuditRows(id);
  const added = act === 'create' ? rows : rows.slice(before.length);
  expect(added).toHaveLength(1);
  const who = ['reject', 'retire'].includes(act) ? reviewer : author;
  expect(added[0]).toMatchObject({ action: `skill.${act.replace(/-/g, '_')}`, outcome: 'success', actor_principal_id: who.id, auth_method: 'session', resource_type: 'skill', resource_id: id });
  // Card d67e6990: a create also records the owner it wrote (the creating Account).
  expect(Object.keys(added[0].metadata).sort()).toEqual(act === 'create' ? ['ownerPrincipalId', 'provenance', 'skillVersionId', 'version'] : act === 'create-version' ? ['provenance', 'skillVersionId', 'version'] : act === 'set-global' ? ['isGlobal'] : act === 'delete' ? ['isGlobal'] : act.startsWith('project-') ? ['projectId', 'skillVersionId'] : ['previousStatus', 'skillVersionId', 'status', 'version']);
  expect(JSON.stringify(added)).not.toContain(f.marker);
});
test.each(AUDIT_ACTS)('AU %s audit-write failure rolls back the business write', async act => {
  const f = await prepareAuditAct(act); const before = await skillState(f.id); const previousAudit = await allAuditRows(f.id);
  const record = auditService.record.bind(auditService);
  const spy = jest.spyOn(auditService, 'record').mockImplementation((write: any, queryable: any) => write.action === `skill.${act.replace(/-/g, '_')}` ? Promise.reject(new Error('Audit sink unavailable')) : record(write, queryable));
  try { expect((await f.invoke()).status).toBe(500); }
  finally { spy.mockRestore(); }
  expect(await skillState(f.id)).toEqual(before); expect(await allAuditRows(f.id)).toEqual(previousAudit);
  if (act === 'create') expect((await pool.query('SELECT id FROM skills WHERE name=$1', [f.marker + '-new'])).rows).toEqual([]);
});
test('AU actor-aware publish and decision denials each write one content-free denied row', async () => {
  const f = await skillInReview();
  for (const [who, route, code] of [
    [author, 'publish', 'INDEPENDENT_REVIEW_REQUIRED'],
    [reviewer, 'reject', 'REVISION_MISMATCH'],
    [await humanWithRole('editor'), 'publish', 'FORBIDDEN'],
    [await serviceWithSkillsAdmin(reviewer), 'publish', 'HUMAN_REVIEW_REQUIRED'],
  ] as Array<[Caller, string, string]>) {
    const before = await allAuditRows(f.id);
    const result = await call(who, 'POST', `/skills/${f.id}/versions/1/${route}`, { note: 'Private denial note' }, route === 'reject' ? crypto.randomUUID() : await revisionOf(f.id));
    expect(result.body.code).toBe(code);
    const added = (await allAuditRows(f.id)).slice(before.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ action: `skill.${route}`, outcome: 'denied', actor_principal_id: who.id, metadata: { refusal: code, status: result.status } });
    expect(added[0].auth_method).toBe(who.kind === 'service' ? 'principal_api_key' : 'session');
    if (who.kind === 'service') expect(added[0].credential_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(added)).not.toContain('Private denial note');
  }
  expect(await statusOf(f.versionId)).toBe('review');
});
test.each([false, true])('AU direct service refusal records its known actor, explicit request evidence=%s', async explicit => {
  const f = await skillInReview(); const before = await allAuditRows(f.id);
  const actor = explicit ? { principalId: author.id, handle: (await principalRow(author.id)).handle, authMethod: 'system' } : undefined;
  await expect(skillManager.transition(f.id, '1', 'published', author.id, 'Private direct decision', await revisionOf(f.id), actor)).rejects.toMatchObject({ code: 'INDEPENDENT_REVIEW_REQUIRED', status: 409 });
  const added = (await allAuditRows(f.id)).slice(before.length);
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ action: 'skill.publish', outcome: 'denied', actor_principal_id: author.id, auth_method: explicit ? 'system' : 'unknown', metadata: { refusal: 'INDEPENDENT_REVIEW_REQUIRED', status: 409 } });
  expect(JSON.stringify(added)).not.toContain('Private direct decision'); expect(await statusOf(f.versionId)).toBe('review');
});
test('AU direct precondition refusal is audited while unknown actors remain unknown', async () => {
  const f = await skillInReview(); const before = await allAuditRows(f.id);
  await expect(skillManager.setGlobal(f.id, false, '', { principalId: author.id, handle: 'known internal actor', authMethod: 'system' })).rejects.toMatchObject({ code: 'REVISION_REQUIRED' });
  expect((await allAuditRows(f.id)).slice(before.length)).toEqual([expect.objectContaining({ action: 'skill.set_global', outcome: 'denied', actor_principal_id: author.id, auth_method: 'system', metadata: { refusal: 'REVISION_REQUIRED', status: 400 } })]);
  const known = await allAuditRows(f.id);
  await expect(skillManager.setGlobal(f.id, false, '')).rejects.toMatchObject({ code: 'REVISION_REQUIRED' });
  expect(await allAuditRows(f.id)).toEqual(known);
});
test('AU a known legacy transport actor is recorded without inventing a Principal', async () => {
  const handle = unique('known-legacy-actor');
  await expect(skillManager.create({ name: unique('refused-without-principal'), usage_instructions: 'Private refused instructions' }, undefined,
    { principalId: null, handle, authMethod: 'local_admin' })).rejects.toMatchObject({ code: 'PRINCIPAL_REQUIRED', status: 403 });
  const rows = (await pool.query(`SELECT ${AUDIT_COLUMNS} FROM audit_events a WHERE actor_handle=$1`, [handle])).rows;
  expect(rows).toEqual([expect.objectContaining({ action: 'skill.create', outcome: 'denied', actor_principal_id: null, actor_handle: handle, auth_method: 'local_admin', metadata: { refusal: 'PRINCIPAL_REQUIRED', status: 403 } })]);
  expect(JSON.stringify(rows)).not.toContain('Private refused instructions');
});
test.each(AUDIT_ACTS)('AU refused %s preserves state and audits one safe refusal through /api', async act => {
  const f = await prepareAuditAct(act); const beforeState = await skillState(f.id);
  const routes: Record<AuditAct, [string, string, unknown]> = {
    create: ['POST', '/api/skills', { name: unique('audit-denied'), is_global: true, usage_instructions: 'Private refused prose' }],
    'create-version': ['PUT', `/api/skills/${f.id}`, {}],
    'submit-review': ['POST', `/api/skills/${f.id}/versions/1/submit-review`, { note: 'Private refused prose' }],
    reject: ['POST', `/api/skills/${f.id}/versions/1/reject`, { note: 'Private refused prose' }],
    retire: ['POST', `/api/skills/${f.id}/versions/1/retire`, { note: 'Private refused prose' }],
    'set-global': ['PATCH', `/api/skills/${f.id}/audience`, { is_global: true, privateField: 'Private refused prose' }],
    delete: ['DELETE', `/api/skills/${f.id}`, { privateField: 'Private refused prose' }],
    'project-pin': ['PUT', `/api/projects/${f.projectId}/skills/${f.id}`, { version: 999999 }],
    'project-unpin': ['DELETE', `/api/projects/${f.projectId}/skills/${f.id}`, { privateField: 'Private refused prose' }],
  };
  const action = `skill.${act.replace(/-/g, '_')}`;
  const before = (await pool.query('SELECT id FROM audit_events WHERE actor_principal_id=$1 AND action=$2', [author.id, action])).rows;
  const [method, path, body] = routes[act];
  const result = await call(author, method, path, body, crypto.randomUUID());
  expect(result.status).toBeGreaterThanOrEqual(400); expect(result.status).toBeLessThan(500);
  const rows = (await pool.query(`SELECT ${AUDIT_COLUMNS} FROM audit_events a WHERE a.actor_principal_id=$1 AND a.action=$2 ORDER BY occurred_at,id`, [author.id, action])).rows;
  // Use the count delta and the last event in this in-band fixture.
  expect(rows).toHaveLength(before.length + 1); const event = rows.at(-1);
  expect(event).toMatchObject({ outcome: 'denied', actor_principal_id: author.id, auth_method: 'session', metadata: { refusal: result.body.code ?? 'REQUEST_REFUSED', status: result.status } });
  expect(JSON.stringify(event)).not.toContain('Private refused prose'); expect(JSON.stringify(event)).not.toContain(f.marker);
  expect(await skillState(f.id)).toEqual(beforeState);
});
test('AU denial audit failure is explicit and does not change the refused Skill', async () => {
  const f = await skillInReview(); const beforeState = await skillState(f.id); const beforeAudit = await allAuditRows(f.id);
  const record = auditService.record.bind(auditService);
  const spy = jest.spyOn(auditService, 'record').mockImplementation((write: any, queryable: any) => write.outcome === 'denied' && write.action === 'skill.reject' ? Promise.reject(new Error('Audit sink unavailable')) : record(write, queryable));
  try {
    const result = await call(reviewer, 'POST', `/api/skills/${f.id}/versions/1/reject`, { note: 'Private denied note' }, crypto.randomUUID());
    expect(result.status).toBe(500); expect(result.body.code).toBe('AUDIT_WRITE_FAILED');
  } finally { spy.mockRestore(); }
  expect(await skillState(f.id)).toEqual(beforeState); expect(await allAuditRows(f.id)).toEqual(beforeAudit);
});
test.each(['skill.create', 'principal.update'])('AU failure after %s audit INSERT rolls back audit and object together', async action => {
  const handle = unique('late-rollback'); let id: string | undefined;
  if (action === 'principal.update') { const created = await call(author, 'POST', '/principals', { kind: 'human', handle }); expect(created.status).toBe(201); id = created.body.principal.id; }
  const before = id ? await allAuditRows(id) : [];
  let insertedAuditId: string | undefined;
  const record = auditService.record.bind(auditService);
  const spy = jest.spyOn(auditService, 'record').mockImplementation(async (write: any, queryable: any) => {
    const result = await record(write, queryable);
    if (write.action === action) { insertedAuditId = result.id; throw new Error('Failure after audit insert'); }
    return result;
  });
  try { expect((await call(author, action === 'skill.create' ? 'POST' : 'PATCH', action === 'skill.create' ? '/skills' : `/principals/${id}`, action === 'skill.create' ? { name: handle, usage_instructions: 'Late rollback fixture' } : { status: 'disabled' })).status).toBe(500); }
  finally { spy.mockRestore(); }
  expect(insertedAuditId).toBeDefined();
  expect((await pool.query('SELECT id FROM audit_events WHERE id=$1', [insertedAuditId])).rows).toEqual([]);
  if (id) { expect(await allAuditRows(id)).toEqual(before); expect((await pool.query('SELECT status FROM principals WHERE id=$1', [id])).rows[0].status).toBe('active'); }
  else expect((await pool.query('SELECT id FROM skills WHERE name=$1', [handle])).rows).toEqual([]);
});
test('AU principal create and update have safe exact shapes and preserve business behavior', async () => {
  const handle = unique('audit-account'); const marker = unique('private-account-text');
  const created = await call(author, 'POST', '/principals', { handle, kind: 'human', role: 'viewer', displayName: marker });
  expect(created.status).toBe(201); const id = created.body.principal.id;
  expect(await allAuditRows(id)).toEqual([expect.objectContaining({ action: 'principal.create', outcome: 'success', actor_principal_id: author.id, auth_method: 'session', metadata: { kind: 'human', handle, role: 'viewer' } })]);
  const changed = await call(author, 'PATCH', `/principals/${id}`, { displayName: marker + '-changed', status: 'disabled' });
  expect(changed.status).toBe(200); expect(changed.body.principal.status).toBe('disabled');
  const rows = await allAuditRows(id);
  expect(rows).toHaveLength(2); expect(rows[1]).toMatchObject({ action: 'principal.update', actor_principal_id: author.id, metadata: { changedFields: ['displayName', 'status'], previousStatus: 'active', status: 'disabled' } });
  expect(JSON.stringify(rows)).not.toContain(marker);
  expect((await call(author, 'PATCH', `/principals/${id}`, { status: 'active' })).status).toBe(200);
  expect((await allAuditRows(id)).at(-1).metadata).toEqual({ changedFields: ['status'], previousStatus: 'disabled', status: 'active' });
  const cache = jest.spyOn(principalService, 'cachePrincipal');
  try {
    const noop = await call(author, 'PATCH', `/principals/${id}`, { role: 'admin' });
    expect(noop.status).toBe(200); expect(noop.body.principal.role).toBe('viewer');
    expect(cache).not.toHaveBeenCalled();
    expect((await allAuditRows(id)).at(-1).metadata).toEqual({ changedFields: [] });
  } finally { cache.mockRestore(); }
});
test.each(['create', 'update'])('AU principal %s audit failure leaves no uncommitted row or cached value', async act => {
  const handle = unique('audit-rollback');
  let id: string | undefined;
  if (act === 'update') {
    const created = await call(author, 'POST', '/principals', { handle, kind: 'human' }); expect(created.status).toBe(201); id = created.body.principal.id;
    await principalService.getPrincipalById(id);
  }
  const record = auditService.record.bind(auditService);
  const spy = jest.spyOn(auditService, 'record').mockImplementation((write: any, queryable: any) => write.action === `principal.${act}` ? Promise.reject(new Error('Audit sink unavailable')) : record(write, queryable));
  try { expect((await call(author, act === 'create' ? 'POST' : 'PATCH', act === 'create' ? '/principals' : `/principals/${id}`, act === 'create' ? { handle, kind: 'human' } : { status: 'disabled' })).status).toBe(500); }
  finally { spy.mockRestore(); }
  if (id) { expect((await principalService.getPrincipalById(id)).status).toBe('active'); expect((await pool.query('SELECT status FROM principals WHERE id=$1', [id])).rows[0].status).toBe('active'); }
  else expect((await pool.query('SELECT id FROM principals WHERE handle=$1', [handle])).rows).toEqual([]);
});

test('SP-1 REST default: a human PUT with no provenance drafts the next Version as human-authored', async () => {
  const skill = await connectorDraftedSkill();
  const result = await call(author, 'PUT', `/skills/${skill.id}`, dashboardDraft(skill.name, undefined), skill.revision);
  expect(result.status).toBe(201);
  expect(await versions(skill.id)).toEqual([
    { version: 1, provenance: 'agent-drafted', created_by_principal_id: connector.id },
    { version: 2, provenance: 'human-authored', created_by_principal_id: author.id },
  ]);
});

test('SP-2 the defective combination: a human saving the loaded agent-drafted provenance is refused by name and writes nothing', async () => {
  const skill = await connectorDraftedSkill();
  const result = await call(author, 'PUT', `/skills/${skill.id}`, dashboardDraft(skill.name, 'agent-drafted'), skill.revision);
  // On main this answered 409 SKILL_LIFECYCLE_CONFLICT "Illegal Skill lifecycle change".
  expect(result.body.code).not.toBe('SKILL_LIFECYCLE_CONFLICT');
  expectNamedProvenanceRefusal(result, 'agent-drafted', 'human');
  expect(result.body.details.allowed).toEqual(['human-authored', 'imported']);
  expect(await versions(skill.id)).toHaveLength(1);
  expect(await revisionOf(skill.id)).toBe(skill.revision);
});

test('SP-3 the fixed dashboard default: a human session saves a human-authored draft in one call', async () => {
  const skill = await connectorDraftedSkill();
  const saved = await call(author, 'PUT', `/skills/${skill.id}`, dashboardDraft(skill.name, 'human-authored'), skill.revision);
  expect(saved.status).toBe(201);
  expect(saved.body.skill.current_version).toEqual(expect.objectContaining({ version: 2, status: 'draft', provenance: 'human-authored' }));
  const imported = await call(author, 'PUT', `/skills/${skill.id}`,
    { ...dashboardDraft(skill.name, 'imported', 'Imported text.'), source_uri: 'https://example.invalid/skill.md' },
    saved.body.skill.revision);
  expect(imported.status).toBe(201);
  expect((await versions(skill.id)).map((row: any) => [row.version, row.provenance, row.created_by_principal_id])).toEqual([
    [1, 'agent-drafted', connector.id], [2, 'human-authored', author.id], [3, 'imported', author.id],
  ]);
});

test('SP-4 the mirror: a service Principal drafts agent-drafted and is refused human-authored by name', async () => {
  const skill = await connectorDraftedSkill();
  const refused = await call(connector, 'PUT', `/skills/${skill.id}`, dashboardDraft(skill.name, 'human-authored'), skill.revision);
  expectNamedProvenanceRefusal(refused, 'human-authored', 'service');
  expect(refused.body.details.allowed).toEqual(['agent-drafted', 'imported']);
  expect(await versions(skill.id)).toHaveLength(1);
  const drafted = await call(connector, 'PUT', `/skills/${skill.id}`, dashboardDraft(skill.name, 'agent-drafted'), skill.revision);
  expect(drafted.status).toBe(201);
  expect((await versions(skill.id)).at(-1)).toEqual({ version: 2, provenance: 'agent-drafted', created_by_principal_id: connector.id });
});

test('SP-5 the create path refuses a mismatched provenance by name and creates no Skill', async () => {
  for (const [who, provenance, kind] of [[author, 'agent-drafted', 'human'], [connector, 'human-authored', 'service']] as const) {
    const name = unique('skillprov-create');
    const refused = await call(who, 'POST', '/skills', {
      name, description: 'Skill draft provenance proof', usage_instructions: 'Never stored.', provenance,
    });
    expectNamedProvenanceRefusal(refused, provenance, kind);
    expect((await pool.query('SELECT count(*)::int AS n FROM skills WHERE name = $1', [name])).rows[0].n).toBe(0);
  }
  const human = await call(author, 'POST', '/skills', {
    name: unique('skillprov-create'), description: 'Skill draft provenance proof', usage_instructions: 'Stored.',
  });
  expect(human.status).toBe(201);
  expect(human.body.skill.current_version.provenance).toBe('human-authored');
});

test('SP-6 the independent-review publication rule is unchanged', async () => {
  const skill = await connectorDraftedSkill();
  const draft = await call(author, 'PUT', `/skills/${skill.id}`, dashboardDraft(skill.name, 'human-authored'), skill.revision);
  expect(draft.status).toBe(201);
  const review = await call(author, 'POST', `/skills/${skill.id}/versions/2/submit-review`, {}, draft.body.skill.revision);
  expect(review.status).toBe(200);
  const revision = await revisionOf(skill.id);
  const self = await call(author, 'POST', `/skills/${skill.id}/versions/2/publish`, {}, revision);
  expect({ status: self.status, code: self.body.code }).toEqual({ status: 409, code: 'INDEPENDENT_REVIEW_REQUIRED' });
  const independent = await call(reviewer, 'POST', `/skills/${skill.id}/versions/2/publish`, {}, revision);
  expect(independent.status).toBe(200);
  expect(independent.body.version).toEqual(expect.objectContaining({ version: 2, status: 'published', provenance: 'human-authored' }));
});

test('SP-7 the database guard itself is unchanged: a direct mismatched insert is still refused', async () => {
  const skill = await connectorDraftedSkill();
  await expect(pool.query(
    `INSERT INTO skill_versions (id, skill_id, version, skill_md, description, provenance, created_by_principal_id)
     VALUES (gen_random_uuid(), $1, 2, $2, 'Skill draft provenance proof', 'agent-drafted', $3)`,
    [skill.id, skillMd(skill.name, 'Direct insert.'), author.id],
  )).rejects.toMatchObject({ code: '23514', message: 'agent-drafted provenance requires an agent or service Principal' });
  expect(await versions(skill.id)).toHaveLength(1);
});

/*
 * ---- PA: card eb7c0271, the skill.publish audit row -------------------------
 * Publishing a Skill Version writes exactly ONE audit_events row through the
 * one audit writer (AuditService.record), on the publish transaction, recorded
 * against the parent Skill as its siblings profile.publish and
 * blueprint.publish are recorded against theirs. A refused publish writes no
 * row of any kind. The red proof on main: every publish below answers 200 and
 * no audit row names the Skill, because SkillManager.transition wrote none.
 *
 * The approvals hub's skill-publish item is a read adapter over the review
 * queue (E44 Q2): no Approval record exists for it, its id IS the Version id,
 * and decideVia.publish is the same route. Its row is correlated by
 * metadata.skillVersionId and carries no approvalId, because none exists.
 */
const jwt = require('jsonwebtoken');
const { skillManager } = require('../services/SkillManager');

const AUDIT_COLUMNS = `a.action, a.outcome, a.actor_principal_id::text AS actor_principal_id, a.actor_handle,
  a.auth_method, a.credential_id::text AS credential_id, a.resource_type, a.resource_id, a.metadata`;

/** Historical publish-shape pins; the AU block separately pins every other act and denial. */
async function auditRowsNaming(skillId: string) {
  return (await pool.query(
    `SELECT ${AUDIT_COLUMNS} FROM audit_events a
      WHERE a.action='skill.publish' AND a.outcome='success' AND (a.resource_id = $1 OR strpos(a.metadata::text, $1) > 0
         OR EXISTS (SELECT 1 FROM skill_versions v WHERE v.skill_id = $1::uuid
                     AND (a.resource_id = v.id::text OR strpos(a.metadata::text, v.id::text) > 0)))
      ORDER BY a.occurred_at, a.id`, [skillId],
  )).rows;
}

async function principalRow(id: string): Promise<{ id: string; handle: string }> {
  return (await pool.query('SELECT id::text AS id, handle FROM principals WHERE id = $1', [id])).rows[0];
}

async function digestOf(versionId: string): Promise<string> {
  return (await pool.query('SELECT content_sha256 FROM skill_versions WHERE id = $1', [versionId])).rows[0].content_sha256;
}

async function statusOf(versionId: string): Promise<string> {
  return (await pool.query('SELECT status FROM skill_version_state WHERE id = $1', [versionId])).rows[0].status;
}

async function humanWithRole(role: string): Promise<Caller> {
  const id = (await pool.query(
    `INSERT INTO principals(kind, handle, display_name, status, role)
     VALUES ('human', $1, $1, 'active', $2) RETURNING id`, [unique('skillaudit-human'), role],
  )).rows[0].id;
  const session = await loginSessionService.mint({ principalId: id });
  return { id, kind: 'human', headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.token}` } };
}

/** A human signed in through the break-glass dashboard login: the v2 token routes/auth.ts mints. */
async function breakGlassAdministrator(): Promise<Caller> {
  const handle = unique('skillaudit-breakglass');
  const id = (await pool.query(
    `INSERT INTO principals(kind, handle, display_name, status, role)
     VALUES ('human', $1, $1, 'active', 'orchestrator') RETURNING id`, [handle],
  )).rows[0].id;
  const token = jwt.sign({ v: 2, sub: id, handle, kind: 'human' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  return { id, kind: 'human', headers: { Authorization: `Bearer ${token}` } };
}

/** A service Principal whose credential holds skills:admin, so the route ceiling admits it. */
async function serviceWithSkillsAdmin(parent: Caller): Promise<Caller> {
  const id = (await pool.query(
    `INSERT INTO principals(kind, handle, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, 'active', $2, 'Skill publish audit fixture', $3) RETURNING id`,
    [unique('skillaudit-connector'), parent.id, JSON.stringify({ scopes: 'parent', objects: 'parent' })],
  )).rows[0].id;
  const issued = await principalService.issueCredential(
    { principalId: id, scopes: ['skills:read', 'skills:write', 'skills:admin'], transport: 'any' },
    { handle: 'fixture', authMethod: 'system' },
  );
  return { id, kind: 'service', headers: { Authorization: `Bearer ${issued.fullKey}` } };
}

/** A human-authored Skill whose Version 1 its author has submitted for review. */
async function skillInReview(by: Caller = author) {
  const name = unique('skillaudit');
  const created = await call(by, 'POST', '/skills', {
    name, description: 'Skill publish audit proof', usage_instructions: 'Drafted for review.',
  });
  expect(created.status).toBe(201);
  const id = created.body.skill.id as string;
  const review = await call(by, 'POST', `/skills/${id}/versions/1/submit-review`, {}, created.body.skill.revision);
  expect(review.status).toBe(200);
  return { id, name, versionId: review.body.version.id as string, revision: await revisionOf(id) };
}

async function expectedPublishRow(skillId: string, publisherId: string, authMethod: string,
    versionId: string, version: number, previousPublishedVersionId: string | null) {
  const publisher = await principalRow(publisherId);
  return {
    action: 'skill.publish', outcome: 'success',
    actor_principal_id: publisher.id, actor_handle: publisher.handle, auth_method: authMethod, credential_id: null,
    resource_type: 'skill', resource_id: skillId,
    metadata: {
      skillVersionId: versionId, version, previousStatus: 'review', status: 'published',
      previousPublishedVersionId, contentSha256: await digestOf(versionId),
    },
  };
}

test('PA-1 an administrator login session publishes: exactly one skill.publish row, exact shape, on the Audit route', async () => {
  const skill = await skillInReview();
  expect(await auditRowsNaming(skill.id)).toEqual([]);
  const published = await call(reviewer, 'POST', `/skills/${skill.id}/versions/1/publish`, {}, skill.revision);
  expect(published.status).toBe(200);
  expect(published.body.version).toEqual(expect.objectContaining({ id: skill.versionId, version: 1, status: 'published' }));
  const expected = await expectedPublishRow(skill.id, reviewer.id, 'session', skill.versionId, 1, null);
  expect(await auditRowsNaming(skill.id)).toEqual([expected]);
  // The Audit log page reads GET /audit; the owner's "Action starts with: skill" filter finds the row.
  const listed = await call(reviewer, 'GET', `/audit?actionPrefix=skill&resourceType=skill&resourceId=${skill.id}`);
  expect(listed.status).toBe(200);
  expect(listed.body.events).toEqual(expect.arrayContaining([expect.objectContaining({
    action: 'skill.publish', outcome: 'success', actorPrincipalId: reviewer.id, authMethod: 'session',
    resourceType: 'skill', resourceId: skill.id, metadata: expected.metadata,
  })]));
  expect(listed.body.events.filter((row: any) => row.action === 'skill.publish')).toHaveLength(1);
});

test('PA-2 the break-glass dashboard token publishes: the row records auth method dashboard_jwt', async () => {
  const breakGlass = await breakGlassAdministrator();
  const skill = await skillInReview();
  const published = await call(breakGlass, 'POST', `/skills/${skill.id}/versions/1/publish`, {}, skill.revision);
  expect(published.status).toBe(200);
  expect(await auditRowsNaming(skill.id)).toEqual([
    await expectedPublishRow(skill.id, breakGlass.id, 'dashboard_jwt', skill.versionId, 1, null),
  ]);
});

test('PA-3 the approvals hub skill-publish item publishes through decideVia.publish: one row, keyed by the hub item id', async () => {
  const skill = await skillInReview();
  const hub = await call(reviewer, 'GET', '/approvals?view=hub&kind=skill-publish');
  expect(hub.status).toBe(200);
  const item = hub.body.approvals.find((entry: any) => entry.id === skill.versionId);
  expect(item).toEqual(expect.objectContaining({
    kind: 'skill-publish', decidable: true, skill: expect.objectContaining({ id: skill.id, version: 1 }),
  }));
  expect(item.decideVia.publish).toBe(`/skills/${skill.id}/versions/1/publish`);
  const published = await call(reviewer, 'POST', item.decideVia.publish, {}, await revisionOf(skill.id));
  expect(published.status).toBe(200);
  const rows = await auditRowsNaming(skill.id);
  expect(rows).toEqual([await expectedPublishRow(skill.id, reviewer.id, 'session', skill.versionId, 1, null)]);
  expect(rows[0].metadata.skillVersionId).toBe(item.id);
  expect(rows[0].metadata).not.toHaveProperty('approvalId');
});

test('PA-4 a refused publish writes a denied row, no successful publish row, and preserves review', async () => {
  const skill = await skillInReview();
  const editor = await humanWithRole('editor');
  const adminConnector = await serviceWithSkillsAdmin(reviewer);
  const path = `/skills/${skill.id}/versions/1/publish`;
  const refusals: Array<[string, Caller, string, number, string]> = [
    ['the creator (independent review)', author, skill.revision, 409, 'INDEPENDENT_REVIEW_REQUIRED'],
    ['a session without skills:admin (route ceiling)', editor, skill.revision, 403, 'FORBIDDEN'],
    ['a service credential holding skills:admin', adminConnector, skill.revision, 403, 'HUMAN_REVIEW_REQUIRED'],
    ['a stale If-Match', reviewer, crypto.randomUUID(), 412, 'REVISION_MISMATCH'],
  ];
  for (const [label, who, revision, status, code] of refusals) {
    const before = await allAuditRows(skill.id);
    const refused = await call(who, 'POST', path, {}, revision);
    expect({ label, status: refused.status, code: refused.body.code }).toEqual({ label, status, code });
    // The shared authorization middleware's refusal, before the route handler runs.
    if (code === 'FORBIDDEN') expect(refused.body.error).toBe('This identity is not authorized for the requested operation');
    expect({ label, rows: await auditRowsNaming(skill.id) }).toEqual({ label, rows: [] });
    const added = (await allAuditRows(skill.id)).slice(before.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ action: 'skill.publish', outcome: 'denied', actor_principal_id: who.id, metadata: { refusal: code, status } });
  }
  // A Version still in draft cannot be published; the trigger's refusal rolls the transaction back.
  const draft = await call(author, 'PUT', `/skills/${skill.id}`, dashboardDraft(skill.name, 'human-authored'), skill.revision);
  expect(draft.status).toBe(201);
  const early = await call(reviewer, 'POST', `/skills/${skill.id}/versions/2/publish`, {}, draft.body.skill.revision);
  expect({ status: early.status, code: early.body.code }).toEqual({ status: 409, code: 'SKILL_LIFECYCLE_CONFLICT' });
  expect(await auditRowsNaming(skill.id)).toEqual([]);
  expect(await statusOf(skill.versionId)).toBe('review');
  // The same Version then publishes, and writes its one row.
  const published = await call(reviewer, 'POST', path, {}, await revisionOf(skill.id));
  expect(published.status).toBe(200);
  expect(await auditRowsNaming(skill.id)).toEqual([
    await expectedPublishRow(skill.id, reviewer.id, 'session', skill.versionId, 1, null),
  ]);
});

test('PA-5 publishing the next Version records the Version it replaced', async () => {
  const skill = await skillInReview();
  expect((await call(reviewer, 'POST', `/skills/${skill.id}/versions/1/publish`, {}, skill.revision)).status).toBe(200);
  const draft = await call(author, 'PUT', `/skills/${skill.id}`, dashboardDraft(skill.name, 'human-authored'), await revisionOf(skill.id));
  expect(draft.status).toBe(201);
  const review = await call(author, 'POST', `/skills/${skill.id}/versions/2/submit-review`, {}, draft.body.skill.revision);
  expect(review.status).toBe(200);
  const second = await call(reviewer, 'POST', `/skills/${skill.id}/versions/2/publish`, {}, await revisionOf(skill.id));
  expect(second.status).toBe(200);
  expect(await auditRowsNaming(skill.id)).toEqual([
    await expectedPublishRow(skill.id, reviewer.id, 'session', skill.versionId, 1, null),
    await expectedPublishRow(skill.id, reviewer.id, 'session', review.body.version.id, 2, skill.versionId),
  ]);
});

test('PA-6 the publish note is free prose: it reaches the lifecycle event and never the audit row', async () => {
  const skill = await skillInReview();
  const marker = `skillaudit-note-${crypto.randomBytes(8).toString('hex')}`;
  const published = await call(reviewer, 'POST', `/skills/${skill.id}/versions/1/publish`,
    { note: `Reviewed and approved. ${marker}` }, skill.revision);
  expect(published.status).toBe(200);
  expect((await pool.query(
    `SELECT note FROM skill_version_events WHERE skill_version_id = $1 AND status = 'published'`, [skill.versionId],
  )).rows).toEqual([{ note: `Reviewed and approved. ${marker}` }]);
  expect(await auditRowsNaming(skill.id)).toEqual([
    await expectedPublishRow(skill.id, reviewer.id, 'session', skill.versionId, 1, null),
  ]);
  expect((await pool.query(
    `SELECT count(*)::int AS n FROM audit_events a WHERE strpos(row_to_json(a)::text, $1) > 0`, [marker],
  )).rows[0].n).toBe(0);
});

test('PA-7 a direct service call with no request actor still writes the row, as auth method unknown', async () => {
  const skill = await skillInReview();
  const version = await skillManager.transition(skill.id, '1', 'published', reviewer.id, undefined, skill.revision);
  expect(version.status).toBe('published');
  expect(await auditRowsNaming(skill.id)).toEqual([
    await expectedPublishRow(skill.id, reviewer.id, 'unknown', skill.versionId, 1, null),
  ]);
});

test('PA-8 the row shares the publish transaction: a failed audit write fails the publish, a later failure leaves no row', async () => {
  const { auditService } = require('../services/AuditService');
  const { feedEventService } = require('../services/FeedEventService');
  const skill = await skillInReview();
  const path = `/skills/${skill.id}/versions/1/publish`;
  const record = auditService.record.bind(auditService);
  const auditDown = jest.spyOn(auditService, 'record').mockImplementation((write: any, queryable: any) => (
    write.action === 'skill.publish' ? Promise.reject(new Error('audit sink unavailable')) : record(write, queryable)));
  try {
    expect((await call(reviewer, 'POST', path, {}, skill.revision)).status).toBe(500);
  } finally { auditDown.mockRestore(); }
  expect(await statusOf(skill.versionId)).toBe('review');
  expect(await auditRowsNaming(skill.id)).toEqual([]);
  // A failure AFTER the row is written (the feed event) rolls the row back with the publish.
  const emit = feedEventService.emit.bind(feedEventService);
  const feedDown = jest.spyOn(feedEventService, 'emit').mockImplementation((client: any, event: any) => (
    event.name === 'skill.updated' && event.objectId === skill.id
      ? Promise.reject(new Error('feed unavailable')) : emit(client, event)));
  try {
    expect((await call(reviewer, 'POST', path, {}, skill.revision)).status).toBe(500);
  } finally { feedDown.mockRestore(); }
  expect(await statusOf(skill.versionId)).toBe('review');
  expect(await auditRowsNaming(skill.id)).toEqual([]);
  expect(await revisionOf(skill.id)).toBe(skill.revision);
  const published = await call(reviewer, 'POST', path, {}, skill.revision);
  expect(published.status).toBe(200);
  expect(await auditRowsNaming(skill.id)).toEqual([
    await expectedPublishRow(skill.id, reviewer.id, 'session', skill.versionId, 1, null),
  ]);
});

test('ID-1 a Skill name or a malformed Version in the path is refused 400 by name, never 500; unknown ids keep 404', async () => {
  const skill = await connectorDraftedSkill();
  const byName = await call(author, 'GET', `/skills/${skill.name}`);
  // On main this answered 500 INTERNAL_ERROR (card 9cdc6b27).
  expect([byName.status, byName.body.code]).toEqual([400, 'INVALID_SKILL_ID']);
  const draftByName = await call(author, 'PUT', `/skills/${skill.name}`, dashboardDraft(skill.name, undefined), skill.revision);
  expect([draftByName.status, draftByName.body.code]).toEqual([400, 'INVALID_SKILL_ID']);
  expect(await versions(skill.id)).toHaveLength(1);
  expect(await revisionOf(skill.id)).toBe(skill.revision);
  const versionWord = await call(author, 'GET', `/skills/${skill.id}/versions/latest`);
  expect([versionWord.status, versionWord.body.code]).toEqual([400, 'INVALID_SKILL_VERSION_ID']);
  expect((await call(author, 'GET', `/skills/${crypto.randomUUID()}`)).status).toBe(404);
  expect((await call(author, 'GET', `/skills/${unique('no-such-skill')}`)).status).toBe(404);
  const byId = await call(author, 'GET', `/skills/${skill.id}`);
  expect([byId.status, byId.body.skill.name]).toEqual([200, skill.name]);
});
