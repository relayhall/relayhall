/** E101: real production router, Charter rows and append-only audit receipts.
 * Never runs against a deployment database; every fixture is synthetic. */
import crypto from 'crypto';
import http from 'http';
import { standaloneReportTestTarget } from './support/standaloneReportTestTarget';
const parsed = standaloneReportTestTarget(process.env.RELAYHALL_TEST_DB_URL, process.env.CI);
Object.assign(process.env, { DB_HOST: parsed.hostname, DB_PORT: parsed.port, DB_NAME: parsed.pathname.slice(1),
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password), NODE_ENV: 'test',
  RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex') });
const express = require('express');
const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { principalService } = require('../services/PrincipalService');
jest.setTimeout(30000);
type Caller = { id: string; handle: string; headers: Record<string, string>; credentialId?: string };
let server: http.Server, origin: string;
const tag = () => crypto.randomBytes(6).toString('hex');
const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
async function human(role = 'user'): Promise<Caller> {
  const handle = `charter-audit-${tag()}`;
  const id = String((await pool.query("INSERT INTO principals(kind,handle,status,role) VALUES('human',$1,'active',$2) RETURNING id", [handle, role])).rows[0].id);
  const session = await loginSessionService.mint({ principalId: id });
  return { id, handle, headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.token}` } };
}
async function project(owner: Caller): Promise<string> {
  return String((await pool.query("INSERT INTO projects(name,status,visibility,owner_principal_id) VALUES($1,'active','private',$2) RETURNING id", [`charter audit ${tag()}`, owner.id])).rows[0].id);
}
async function call(who: Caller, id: string, content: unknown, revision?: string, extra: Record<string, unknown> = {}, query = '') {
  const response = await fetch(`${origin}/projects/${id}/charter/approve${query}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...who.headers, ...(revision ? { 'If-Match': revision } : {}) },
    body: JSON.stringify({ content, ...extra }) });
  return { status: response.status, body: await response.json() as any };
}
const audits = async (id: string) => (await pool.query("SELECT action,outcome,actor_principal_id,actor_handle,auth_method,credential_id,resource_type,resource_id,metadata FROM audit_events WHERE action='charter.approve' AND resource_id=$1 ORDER BY occurred_at,id", [id])).rows;
const head = async (id: string) => (await pool.query('SELECT * FROM project_charters WHERE project_id=$1', [id])).rows;
function expected(who: Caller, id: string, outcome: string, metadata: any) {
  return { action: 'charter.approve', outcome, actor_principal_id: who.id, actor_handle: who.handle,
    auth_method: who.credentialId ? 'principal_api_key' : 'session', credential_id: who.credentialId ?? null,
    resource_type: 'project', resource_id: id, metadata };
}
const deniedMetadata = { charterVersion: null, sha: null, previousVersion: null };
beforeAll(async () => {
  const app = express(); app.use(express.json());
  registerProtectedRoutes((mount: string, ...handlers: any[]) => app.use(mount, authMiddleware, sharedAuthorizationMiddleware, ...handlers));
  app.use(apiErrorHandler);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); await pool.end(); });

test('creates exactly one metadata-only approval receipt attributed to the authenticated owner', async () => {
  const owner = await human(), id = await project(owner), content = '# Synthetic governance index';
  const approved = await call(owner, id, content);
  expect(approved.status).toBe(201);
  expect((await head(id))[0].version).toBe(1);
  expect(await audits(id)).toEqual([expected(owner, id, 'success', { charterVersion: 1, sha: sha(content), previousVersion: null })]);
});
test('replacement and identical-content approval each have one receipt with the actual previous version', async () => {
  const owner = await human(), id = await project(owner);
  const first = await call(owner, id, '# First');
  const second = await call(owner, id, '# Second', first.body.charter.revision);
  expect(second.status).toBe(200);
  const unchanged = await call(owner, id, '# Second', second.body.charter.revision);
  expect(unchanged.body.changed).toBe(false);
  expect(await audits(id)).toEqual([
    expected(owner,id,'success',{charterVersion:1,sha:sha('# First'),previousVersion:null}),
    expected(owner,id,'success',{charterVersion:2,sha:sha('# Second'),previousVersion:1}),
    expected(owner,id,'success',{charterVersion:2,sha:sha('# Second'),previousVersion:2}),
  ]);
  expect(Number((await pool.query('SELECT count(*) AS n FROM project_charter_versions WHERE charter_id=$1', [second.body.charter.id])).rows[0].n)).toBe(2);
});
test('domain-refused revision has exactly one denied receipt and unchanged Charter rows', async () => {
  const owner = await human(), id = await project(owner);
  await call(owner, id, '# Original');
  const before = await head(id);
  const refused = await call(owner, id, '# Refused', 'stale');
  expect(refused.status).toBe(412);
  expect(await head(id)).toEqual(before);
  expect((await audits(id)).filter((row: any) => row.outcome === 'denied')).toEqual([expected(owner,id,'denied',deniedMetadata)]);
});
test.each([[null,422],['',422]])('invalid content %p is denied without a Charter mutation', async (content,status) => {
  const owner = await human(), id = await project(owner);
  expect((await call(owner,id,content)).status).toBe(status);
  expect(await head(id)).toEqual([]);
  expect(await audits(id)).toEqual([expected(owner,id,'denied',deniedMetadata)]);
});
test.each([['body',''],['query','?unexpected=yes']])('route %s validation refusal is attributed and audited once', async (kind,query) => {
  const owner = await human(), id = await project(owner);
  expect((await call(owner,id,'# Rejected',undefined,kind==='body'?{unexpected:true}:{},query)).status).toBe(400);
  expect(await head(id)).toEqual([]);
  expect(await audits(id)).toEqual([expected(owner,id,'denied',deniedMetadata)]);
});
test('ordinary Project writer is refused and receives exactly one denied audit record', async () => {
  const owner = await human(), writer = await human(), id = await project(owner);
  await pool.query("INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb) VALUES('principal',$1,'project',$2,'write')",[writer.id,id]);
  expect((await call(writer,id,'# Unapproved')).status).toBe(403);
  expect(await head(id)).toEqual([]);
  expect(await audits(id)).toEqual([expected(writer,id,'denied',deniedMetadata)]);
});
test('scope denial and concealed Project denial preserve their existing answers and audit the actual actor', async () => {
  const owner = await human(), viewer = await human('viewer'), outsider = await human(), id = await project(owner);
  expect((await call(viewer,id,'# Forbidden')).status).toBe(403);
  expect((await call(outsider,id,'# Concealed')).status).toBe(404);
  expect(await audits(id)).toEqual([expected(viewer,id,'denied',deniedMetadata),expected(outsider,id,'denied',deniedMetadata)]);
  expect(await head(id)).toEqual([]);
});
test('bearer refusal includes the authenticated credential id without its key', async () => {
  const owner = await human(), id = await project(owner), handle=`charter-service-${tag()}`;
  const principalId=String((await pool.query("INSERT INTO principals(kind,handle,status,parent_principal_id,purpose,own_expression) VALUES('service',$1,'active',$2,'Synthetic Charter audit',$3) RETURNING id",[handle,owner.id,JSON.stringify({scopes:'parent',objects:'parent'})])).rows[0].id);
  const issued = await principalService.issueCredential({principalId,scopes:['projects:read','projects:write'],transport:'any'}, {handle:'charter-audit-test',authMethod:'system'});
  const credentialId=String((await pool.query('SELECT id FROM principal_credentials WHERE principal_id=$1',[principalId])).rows[0].id);
  const service: Caller={id:principalId,handle,credentialId,headers:{Authorization:`Bearer ${issued.fullKey}`}};
  expect((await call(service,id,'# Machine request')).status).toBe(403);
  expect(await audits(id)).toEqual([expected(service,id,'denied',deniedMetadata)]);
  expect(JSON.stringify(await audits(id))).not.toContain(issued.fullKey);
});
test('an audit insert failure rolls the successful approval writes back', async () => {
  const owner=await human(),id=await project(owner),fn=`charter_audit_fail_${tag()}`;
  await pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='charter.approve' AND NEW.outcome='success' THEN RAISE EXCEPTION 'synthetic audit sink unavailable'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  try { expect((await call(owner,id,'# Must roll back')).status).toBe(500); expect(await head(id)).toEqual([]); expect(await audits(id)).toEqual([]); }
  finally { await pool.query(`DROP TRIGGER ${fn} ON audit_events`); await pool.query(`DROP FUNCTION ${fn}()`); }
});
test('deferred approval commit failure leaves no successful receipt outside the transaction', async () => {
  const owner=await human(),id=await project(owner),fn=`charter_commit_fail_${tag()}`;
  await pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic approval commit failure'; END $$`);
  await pool.query(`CREATE CONSTRAINT TRIGGER ${fn} AFTER INSERT ON project_charter_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  try { expect((await call(owner,id,'# Must not leave orphan audit')).status).toBe(500); expect(await head(id)).toEqual([]); expect(await audits(id)).toEqual([]); }
  finally { await pool.query(`DROP TRIGGER ${fn} ON project_charter_versions`); await pool.query(`DROP FUNCTION ${fn}()`); }
});
test('concurrent domain refusals append receipts without taking a second pool slot', async () => {
  const owner=await human(),id=await project(owner);
  const replies=await Promise.all(Array.from({length:12},()=>call(owner,id,null)));
  expect(replies.map(reply=>reply.status)).toEqual(Array(12).fill(422));
  expect(await head(id)).toEqual([]);
  expect(await audits(id)).toEqual(Array(12).fill(expected(owner,id,'denied',deniedMetadata)));
});
