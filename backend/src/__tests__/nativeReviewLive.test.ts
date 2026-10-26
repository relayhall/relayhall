/** Actual auth/routes/ledger and PostgreSQL locks. Disposable targets only. */
import http from 'http';
import crypto from 'crypto';
const url=process.env.RELAYHALL_TEST_DB_URL;
if(!url) throw new Error('RELAYHALL_TEST_DB_URL is required');
const parsed=new URL(url),database=decodeURIComponent(parsed.pathname.slice(1));
if(!['postgres:','postgresql:'].includes(parsed.protocol) || !(['localhost','127.0.0.1'].includes(parsed.hostname) || (process.env.CI==='true' && parsed.hostname==='postgres'))
  || !(database==='relayhall_native_review_test' || (process.env.CI==='true' && database==='relayhall_ci'))) throw new Error('Disposable native review database only');
Object.assign(process.env,{DB_HOST:parsed.hostname,DB_PORT:parsed.port,DB_NAME:database,DB_USER:decodeURIComponent(parsed.username),DB_PASSWORD:decodeURIComponent(parsed.password),NODE_ENV:'test',RELAYHALL_SESSIONS:'on',JWT_SECRET:crypto.randomBytes(32).toString('hex'),RELAYHALL_TELEMETRY_PEPPERS:JSON.stringify({test:crypto.randomBytes(32).toString('base64')}),RELAYHALL_TELEMETRY_ACTIVE_PEPPER:'test'});
const express=require('express');
const {pool}=require('../db/connection');
const {registerProtectedRoutes}=require('../routeRegistry');
const {authMiddleware}=require('../middleware/auth');
const {sharedAuthorizationMiddleware}=require('../middleware/sharedAuthorization');
const {apiErrorHandler}=require('../utils/apiErrors');
const {loginSessionService,SESSION_COOKIE_NAME}=require('../services/LoginSessionService');
const {principalService}=require('../services/PrincipalService');
const {reviewDigest}=require('../utils/nativeReview');
const mcpRoutes=require('../mcp/httpRoute');
const {telemetryProjectionService}=require('../services/TelemetryProjectionService');
jest.setTimeout(120000);
let server:http.Server,origin:string;
type Caller={id:string;headers:Record<string,string>};
const tag=()=>`native-${crypto.randomBytes(6).toString('hex')}`;
async function call(who:Caller,method:string,path:string,body?:unknown) {
  const response=await fetch(origin+path,{method,headers:{'Content-Type':'application/json',...who.headers},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json() as any};
}
async function human(role='admin'):Promise<Caller> {
  const row=(await pool.query("INSERT INTO principals(kind,handle,display_name,status,role) VALUES('human',$1,$1,'active',$2) RETURNING id",[tag(),role])).rows[0];
  const session=await loginSessionService.mint({principalId:row.id});
  return {id:row.id,headers:{Cookie:`${SESSION_COOKIE_NAME}=${session.token}`}};
}
async function fixture() {
  const parent=await human(),owner=await human('user');
  const verifier=(await pool.query(`INSERT INTO principals(kind,handle,display_name,status,parent_principal_id,purpose,own_expression)
    VALUES('service',$1,$1,'active',$2,'disposable native review', $3) RETURNING id`,[tag(),parent.id,JSON.stringify({scopes:'parent',objects:'parent'})])).rows[0].id;
  const serviceId=crypto.randomUUID();
  const descriptor={options:[],telemetry:{tier:'presence',products:['claude-code']},nativeReview:{protocolVersion:1,sourceProduct:'claude-code'}};
  await pool.query(`INSERT INTO services(id,slug,name,kind,status,principal_id,telemetry_tier,current_descriptor_version)
    VALUES($1,$2,$2,'connector','published',$3,'presence',1)`,[serviceId,tag(),verifier]);
  await pool.query('INSERT INTO service_descriptor_versions(service_id,version,descriptor,content_hash) VALUES($1,1,$2,$3)',[serviceId,JSON.stringify(descriptor),reviewDigest(descriptor)]);
  const issued=await principalService.issueCredential({principalId:verifier,scopes:['tasks:read','tasks:write','services:read','services:invoke','reports:read','reports:write','telemetry:write'],transport:'any'},{handle:'native-review-fixture',authMethod:'system'});
  const caller:Caller={id:verifier,headers:{Authorization:`Bearer ${issued.fullKey}`}};
  const taskId=(await pool.query(`INSERT INTO tasks(title,description,status,visibility,creator_principal_id,owner_principal_id,verifier_principal_id,shepherd_principal_id,definition_of_done)
    VALUES($1,'Verify exact evidence','review','shared',$2,$3,$4,$2,$5) RETURNING id`,[tag(),parent.id,owner.id,verifier,JSON.stringify(['Verify exact evidence'])])).rows[0].id;
  const reportId=(await pool.query(`INSERT INTO reports(title,content,content_hash,summary,task_ids,author_principal_id,author_actor_id,origin,visibility)
    VALUES($1,'immutable receipt',$2,'fixture',$3,$4,$5,'api','shared') RETURNING id`,[tag(),crypto.createHash('sha256').update('immutable receipt').digest('hex'),[taskId],parent.id,parent.id])).rows[0].id;
  return {parent,owner,caller,serviceId,taskId,reportId};
}
async function prepared(f:Awaited<ReturnType<typeof fixture>>) {
  const path=`/tasks/${f.taskId}/native-reviews`;
  const input=await call(f.caller,'GET',path+'/inputs'); expect(input.status).toBe(200);
  const requestBody={serviceId:f.serviceId,descriptorVersion:1,requestKey:crypto.randomUUID(),expectedInputDigest:input.body.result.inputDigest};
  const created=await call(f.parent,'POST',path,requestBody); expect(created.status).toBe(200);
  const request=created.body.result,token=crypto.randomBytes(32).toString('hex');
  const pulled=await call(f.caller,'GET',`/services/${f.serviceId}/review-requests`);
  expect(pulled.status).toBe(200);expect(pulled.body.result.map((row:any)=>row.id)).toContain(request.id);
  const lease=await call(f.caller,'POST',`${path}/${request.id}/lease`,{leaseToken:token});expect(lease.status).toBe(200);
  return {path,input:input.body.result,request,token,requestBody};
}
async function attest(f:Awaited<ReturnType<typeof fixture>>,r:Awaited<ReturnType<typeof prepared>>) {
  const response=await call(f.caller,'POST',`${r.path}/${r.request.id}/attest`,{leaseToken:r.token,correlation:{session_id:'real-init-fixture'}});
  expect(response.status).toBe(200);
}
function verdict(r:Awaited<ReturnType<typeof prepared>>) {
  return {leaseToken:r.token,inputDigest:r.input.inputDigest,verdict:{summary:'Exact fixture evidence reviewed',criteria:r.input.criteria.map((c:any)=>({id:c.id,decision:'pass',rationale:'Bound receipt',evidence:r.input.reportIds}))}};
}
beforeAll(async()=>{
  const app=express();app.use(express.json());
  registerProtectedRoutes((mount:string,...handlers:any[])=>app.use(mount,authMiddleware,sharedAuthorizationMiddleware,...handlers));app.use(mcpRoutes.MCP_ROUTE_PATH,mcpRoutes.default ?? mcpRoutes);app.use(apiErrorHandler);
  await new Promise<void>(resolve=>{server=app.listen(0,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async()=>{if(server) await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();});

test('registered pull, same lease retry, actual attestation, attributed conditional verdict and exact replay preserve owner',async()=>{
  const f=await fixture(),r=await prepared(f);
  const reviewEvents=(await pool.query("SELECT name,object_type,object_id,payload FROM feed_events WHERE name='task.review_requested' AND object_id=$1",[f.taskId])).rows;
  expect(reviewEvents).toHaveLength(1);
  expect(reviewEvents[0]).toEqual({name:'task.review_requested',object_type:'task',object_id:f.taskId,
    payload:{reviewId:r.request.id,serviceId:f.serviceId}});
  expect(JSON.stringify(reviewEvents[0])).not.toContain('immutable receipt');
  expect((await call(f.caller,'POST',`${r.path}/${r.request.id}/lease`,{leaseToken:r.token})).status).toBe(200);
  expect((await call(f.caller,'POST',`${r.path}/${r.request.id}/lease`,{leaseToken:'a'.repeat(64)})).status).toBe(409);
  await attest(f,r);
  const links=(await pool.query('SELECT * FROM task_native_review_sessions WHERE review_id=$1',[r.request.id])).rows;
  expect(links).toHaveLength(1);expect(links[0].connector_id).toBe(f.caller.id);expect(links[0].account_id).toBe(f.parent.id);
  expect(JSON.stringify(links)).not.toContain('real-init-fixture');
  const body=verdict(r),first=await call(f.caller,'POST',`${r.path}/${r.request.id}/verdict`,body);
  expect(first.status).toBe(200);expect(first.body.result.state).toBe('passed');
  expect(first.body.result.finishedAt).toBeTruthy();
  const authorList=await call(f.caller,'GET',r.path);
  expect(authorList.status).toBe(200);
  expect(authorList.body.result.find((item:any)=>item.id===r.request.id).verdict.reportId).toBe(first.body.result.verdict.reportId);
  // Task access can remain granted while the output Report becomes unreadable.
  await pool.query("UPDATE reports SET visibility='private' WHERE id=$1",[first.body.result.verdict.reportId]);
  const ownerList=await call(f.owner,'GET',r.path);
  expect(ownerList.status).toBe(200);
  const redacted=ownerList.body.result.find((item:any)=>item.id===r.request.id);
  expect(redacted).toMatchObject({state:'passed',verdict:null});
  expect(redacted.finishedAt).toBeTruthy();
  expect(JSON.stringify(redacted)).not.toContain(first.body.result.verdict.reportId);
  expect((await call(f.caller,'POST',`${r.path}/${r.request.id}/verdict`,body)).body).toEqual(first.body);
  const task=(await pool.query('SELECT status,completed_at,owner_principal_id,verifier_principal_id,execution_profile FROM tasks WHERE id=$1',[f.taskId])).rows[0];
  expect(task.status).toBe('completed');expect(task.completed_at).toBeTruthy();expect(task.owner_principal_id).toBe(f.owner.id);expect(task.verifier_principal_id).toBe(f.caller.id);
  const history=(await pool.query("SELECT actor_principal_id FROM task_history WHERE task_id=$1 AND new_value='completed'",[f.taskId])).rows;
  expect(history.map((h:any)=>h.actor_principal_id)).toContain(f.caller.id);
  const reports=(await pool.query('SELECT author_principal_id,task_ids FROM reports WHERE id=$1',[first.body.result.verdict.reportId])).rows;
  expect(reports[0].author_principal_id).toBe(f.caller.id);
  const changed=verdict(r);changed.verdict.summary='changed retry';expect((await call(f.caller,'POST',`${r.path}/${r.request.id}/verdict`,changed)).status).toBe(409);
});
test.each(['report','criterion','reference','dependency','verifier','retired-service','replaced-descriptor','expired-lease'])('current %s change refuses conditional verdict without completing',async change=>{
  const f=await fixture(),r=await prepared(f);await attest(f,r);
  if(change==='report') await pool.query("UPDATE reports SET content='changed same id' WHERE id=$1",[f.reportId]);
  if(change==='criterion') await pool.query('UPDATE tasks SET definition_of_done=$2 WHERE id=$1',[f.taskId,JSON.stringify(['changed criterion'])]);
  if(change==='reference') await pool.query("INSERT INTO task_references(task_id,kind,target_uri,label) VALUES($1,'reference','https://example.invalid','changed')",[f.taskId]);
  if(change==='dependency') {const dep=(await pool.query("INSERT INTO tasks(title,status,shepherd_principal_id) VALUES($1,'todo',$2) RETURNING id",[tag(),f.parent.id])).rows[0];await pool.query('INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES($1,$2)',[f.taskId,dep.id]);}
  if(change==='verifier') await pool.query('UPDATE tasks SET verifier_principal_id=$2 WHERE id=$1',[f.taskId,f.parent.id]);
  if(change==='retired-service') await pool.query("UPDATE services SET status='retired' WHERE id=$1",[f.serviceId]);
  if(change==='replaced-descriptor') {
    await pool.query("INSERT INTO service_descriptor_versions(service_id,version,descriptor,content_hash) SELECT service_id,2,descriptor-'nativeReview',content_hash FROM service_descriptor_versions WHERE service_id=$1 AND version=1",[f.serviceId]);
    await pool.query('UPDATE services SET current_descriptor_version=2 WHERE id=$1',[f.serviceId]);
  }
  if(change==='expired-lease') await pool.query("UPDATE task_native_reviews SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[r.request.id]);
  const response=await call(f.caller,'POST',`${r.path}/${r.request.id}/verdict`,verdict(r));expect([403,404,409]).toContain(response.status);
  expect((await pool.query('SELECT status FROM tasks WHERE id=$1',[f.taskId])).rows[0].status).toBe('review');
  expect((await pool.query('SELECT id FROM task_review_attempts WHERE task_id=$1',[f.taskId])).rowCount).toBe(0);
});
test('Report/reference/dependency updates and deletions cannot enter an active evidence barrier',async()=>{
  const f=await fixture();
  const ref=(await pool.query("INSERT INTO task_references(task_id,kind,target_uri,label) VALUES($1,'reference','https://example.invalid','before') RETURNING id",[f.taskId])).rows[0].id;
  const dep=(await pool.query("INSERT INTO tasks(title,status,shepherd_principal_id) VALUES($1,'completed',$2) RETURNING id",[tag(),f.parent.id])).rows[0].id;
  await pool.query('INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES($1,$2)',[f.taskId,dep]);
  const client=await pool.connect();try {
    await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(1397653301,hashtext($1::text))',[f.taskId]);
    for(const [sql,args] of [["UPDATE reports SET content='changed' WHERE id=$1",[f.reportId]],['DELETE FROM task_references WHERE id=$1',[ref]],['DELETE FROM task_dependencies WHERE task_id=$1',[f.taskId]],["UPDATE task_references SET label='changed' WHERE id=$1",[ref]] ] as [string,string[]][]) {
      await expect(pool.query(sql,args)).rejects.toMatchObject({code:'PZ001'});
    }
  } finally {await client.query('ROLLBACK');client.release();}
});
test('different authenticated identity cannot lease; missing declared capability blocks before provider',async()=>{
  const f=await fixture(),r=await prepared(f);
  expect((await call(f.owner,'POST',`${r.path}/${r.request.id}/lease`,{leaseToken:r.token})).status).toBe(403);
  await pool.query("UPDATE service_descriptor_versions SET descriptor=descriptor-'nativeReview' WHERE service_id=$1",[f.serviceId]);
  expect((await call(f.caller,'POST',`${r.path}/${r.request.id}/attest`,{leaseToken:r.token,correlation:{session_id:'init'}})).status).toBe(409);
});

test('a rejected native verdict returns implementation to Todo without stealing its owner',async()=>{
  const f=await fixture();
  // The date exists when the immutable review snapshot is captured.
  await pool.query("UPDATE tasks SET completed_at=NOW()-INTERVAL '1 day' WHERE id=$1",[f.taskId]);
  const r=await prepared(f);await attest(f,r);
  const body=verdict(r);body.verdict.criteria[0].decision='reject';
  const response=await call(f.caller,'POST',`${r.path}/${r.request.id}/verdict`,body);
  expect(response.status).toBe(200);expect(response.body.result.state).toBe('rejected');
  const task=(await pool.query('SELECT status,completed_at,owner_principal_id,attempt_count FROM tasks WHERE id=$1',[f.taskId])).rows[0];
  expect(task).toMatchObject({status:'todo',completed_at:null,owner_principal_id:f.owner.id,attempt_count:1});
  expect((await call(f.caller,'POST',`${r.path}/${r.request.id}/verdict`,body)).body).toEqual(response.body);
});

test('rework excludes an unreadable prior native output unless explicitly linked',async()=>{
  const f=await fixture(),first=await prepared(f);await attest(f,first);
  const rejected=verdict(first);rejected.verdict.criteria[0].decision='reject';
  const prior=await call(f.caller,'POST',`${first.path}/${first.request.id}/verdict`,rejected);
  expect(prior.status).toBe(200);expect(prior.body.result.state).toBe('rejected');
  const priorOutput=prior.body.result.verdict.reportId as string;
  await pool.query("UPDATE reports SET visibility='private' WHERE id=$1",[priorOutput]);

  const shepherd=await human('user');
  await pool.query("UPDATE tasks SET status='review',shepherd_principal_id=$2,updated_at=NOW() WHERE id=$1",[f.taskId,shepherd.id]);
  const content='corrected implementation evidence';
  const corrected=(await pool.query(`INSERT INTO reports(title,content,content_hash,summary,task_ids,author_principal_id,author_actor_id,origin,visibility)
    VALUES($1,$2,$3,'corrected',$4,$5,$6,'api','shared') RETURNING id`,
    [tag(),content,crypto.createHash('sha256').update(content).digest('hex'),[f.taskId],f.parent.id,String(f.parent.id)])).rows[0].id as string;
  for(const [type,id,verb] of [['service',f.serviceId,'invoke'],['report',f.reportId,'read'],['report',corrected,'read']] as const) {
    await pool.query(`INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id)
      VALUES('principal',$1,$2,$3,$4,$5)`,[shepherd.id,type,id,verb,f.parent.id]);
  }
  const path=`/tasks/${f.taskId}/native-reviews`;
  expect([403,404]).toContain((await call(shepherd,'GET',`/reports/${priorOutput}`)).status);
  const input=await call(shepherd,'GET',path+'/inputs');
  expect(input.status).toBe(200);
  expect(input.body.result.reportIds).toContain(corrected);
  expect(input.body.result.reportIds).not.toContain(priorOutput);
  const explicit=(await pool.query(`INSERT INTO task_references(task_id,kind,target_id,label)
    VALUES($1,'report',$2,'explicit prior review') RETURNING id`,[f.taskId,priorOutput])).rows[0].id;
  expect((await call(shepherd,'GET',path+'/inputs')).status).toBe(403);
  await pool.query('DELETE FROM task_references WHERE id=$1',[explicit]);

  const requestBody={serviceId:f.serviceId,descriptorVersion:1,requestKey:crypto.randomUUID(),expectedInputDigest:input.body.result.inputDigest};
  const created=await call(shepherd,'POST',path,requestBody);
  expect(created.status).toBe(200);
  const next={path,input:input.body.result,request:created.body.result,token:crypto.randomBytes(32).toString('hex'),requestBody};
  expect(next.request.reportIds).not.toContain(priorOutput);
  expect((await call(f.caller,'POST',`${path}/${next.request.id}/lease`,{leaseToken:next.token})).status).toBe(200);
  await attest(f,next);
  const accepted=await call(f.caller,'POST',`${path}/${next.request.id}/verdict`,verdict(next));
  expect(accepted.status).toBe(200);
  expect(accepted.body.result.state).toBe('passed');
  expect([403,404]).toContain((await call(shepherd,'GET',`/reports/${priorOutput}`)).status);
  expect((await pool.query('SELECT status FROM tasks WHERE id=$1',[f.taskId])).rows[0].status).toBe('completed');
});

test('uncertain launch cannot be pulled/released/replaced; explicit authored reconciliation never completes',async()=>{
  const f=await fixture(),r=await prepared(f);
  expect((await call(f.caller,'POST',`${r.path}/${r.request.id}/uncertain`,{leaseToken:r.token})).status).toBe(200);
  expect((await call(f.caller,'GET',`/services/${f.serviceId}/review-requests`)).body.result).toEqual([]);
  expect((await call(f.caller,'POST',`${r.path}/${r.request.id}/lease`,{leaseToken:r.token})).status).toBe(409);
  expect((await call(f.parent,'POST',r.path,{...r.requestBody,requestKey:crypto.randomUUID()})).status).toBe(409);
  const proof={evidenceReportId:f.reportId,inputDigest:r.input.inputDigest};
  // Caller cannot pass somebody else's authored evidence as its reconciliation.
  expect((await call(f.caller,'POST',`${r.path}/${r.request.id}/reconcile`,proof)).status).toBe(403);
  const reconciled=await call(f.parent,'POST',`${r.path}/${r.request.id}/reconcile`,proof);
  expect(reconciled.status).toBe(200);expect(reconciled.body.result.state).toBe('cancelled');
  expect((await call(f.parent,'POST',`${r.path}/${r.request.id}/reconcile`,proof)).body).toEqual(reconciled.body);
  expect((await pool.query('SELECT status,owner_principal_id FROM tasks WHERE id=$1',[f.taskId])).rows[0]).toMatchObject({status:'review',owner_principal_id:f.owner.id});
  expect((await pool.query('SELECT id FROM task_review_attempts WHERE task_id=$1',[f.taskId])).rowCount).toBe(0);
  expect((await call(f.parent,'POST',r.path,{...r.requestBody,requestKey:crypto.randomUUID()})).status).toBe(200);
});

test.each(['credential','parent-ceiling','own-cap'])('current %s revocation refuses verdict',async change=>{
  const f=await fixture(),r=await prepared(f);await attest(f,r);
  if(change==='credential') await pool.query('UPDATE principal_credentials SET revoked_at=NOW() WHERE principal_id=$1',[f.caller.id]);
  if(change==='parent-ceiling') await pool.query("UPDATE principals SET role='viewer' WHERE id=$1",[f.parent.id]);
  if(change==='own-cap') await pool.query('UPDATE principals SET own_expression=$2 WHERE id=$1',[f.caller.id,JSON.stringify({scopes:[],objects:[]})]);
  const response=await call(f.caller,'POST',`${r.path}/${r.request.id}/verdict`,verdict(r));
  expect([401,403,404]).toContain(response.status);
  expect((await pool.query('SELECT status FROM tasks WHERE id=$1',[f.taskId])).rows[0].status).toBe('review');
});

test('real telemetry ingest produces the same full triple; other Accounts and expired links never expose it',async()=>{
  const f=await fixture(),r=await prepared(f);await attest(f,r);
  const envelope={schema_version:'rh.ai.telemetry/1.0',event_id:crypto.randomUUID(),kind:'session',phase:'started',
    source:{product:'claude-code',adapter:'fixture'},correlation:{session_id:'real-init-fixture'}};
  const ingested=await call(f.caller,'POST','/telemetry/events',envelope);expect(ingested.status).toBe(200);
  const visible=await call(f.parent,'GET',r.path);expect(visible.status).toBe(200);
  const session=visible.body.result[0].session;
  expect(session).toMatchObject({state:'available',connectorId:f.caller.id,sourceProduct:'claude-code'});
  expect(session.sessionRef).toMatch(/^rhp_/);expect(JSON.stringify(session)).not.toContain('real-init-fixture');
  const otherRoot=await human();
  expect((await call(otherRoot,'GET','/principals/me')).body.scopes).toContain('root');
  expect((await call(otherRoot,'GET',r.path)).body.result[0].session).toEqual(session);
  const restricted=await call(f.owner,'GET',r.path);
  const ownerIdentity=await call(f.owner,'GET','/principals/me');
  expect(ownerIdentity.body.principal.id).toBe(f.owner.id);
  expect(ownerIdentity.body.scopes).not.toContain('root');
  expect(f.owner.id).not.toBe(f.parent.id);
  expect(restricted.body.result[0].session).toEqual({state:'restricted'});
  await pool.query("UPDATE task_native_review_sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE review_id=$1",[r.request.id]);
  await pool.query("UPDATE task_native_reviews SET session_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[r.request.id]);
  expect((await call(f.parent,'GET',r.path)).body.result[0].session).toEqual({state:'expired'});
  const {telemetryRetentionService}=require('../services/TelemetryRetentionService');
  const sweep=await telemetryRetentionService.sweep();
  expect(sweep.receipts.find((row:any)=>row.payloadClass==='native_review_session_link').removed).toBeGreaterThanOrEqual(1);
  expect((await pool.query('SELECT 1 FROM task_native_review_sessions WHERE review_id=$1',[r.request.id])).rowCount).toBe(0);
  expect((await call(f.parent,'GET',r.path)).body.result[0].session).toEqual({state:'expired'});
});

async function subtaskFixture(f:Awaited<ReturnType<typeof fixture>>, statuses:string[]) {
  for(let index=0;index<statuses.length;index++) await pool.query(
    'INSERT INTO subtasks(task_id,index,title,status,note) VALUES($1,$2,$3,$4,$5)',
    [f.taskId,index,`Criterion for subtask ${index}`,statuses[index],'Bound implementation receipt']);
}
test.each([
  [['review'],'terminal_slice_and_task','completed',2],
  [['completed','review','empty'],'subtask_slice','todo',1],
  [['completed','skipped'],'task_final','completed',1],
])('explicit native scope %j judges exactly its criteria and truthfully reports resulting Task state',async(statuses,kind,status,count)=>{
  const f=await fixture();await subtaskFixture(f,statuses as string[]);
  const r=await prepared(f);
  expect(r.input.reviewScope.kind).toBe(kind);expect(r.request.reviewScope).toEqual(r.input.reviewScope);
  expect(r.input.criteria).toHaveLength(count as number);
  if(kind==='terminal_slice_and_task') expect(r.input.criteria.some((c:any)=>c.text.startsWith('Whole Task:'))).toBe(true);
  await attest(f,r);
  const response=await call(f.caller,'POST',`${r.path}/${r.request.id}/verdict`,verdict(r));
  expect(response.status).toBe(200);expect(response.body.result.verdict.result.status).toBe(status);
  const report=(await pool.query('SELECT content FROM reports WHERE id=$1',[response.body.result.verdict.reportId])).rows[0];
  expect(JSON.parse(report.content)).toMatchObject({reviewScope:r.input.reviewScope,taskStatus:status});
  expect((await pool.query('SELECT status,owner_principal_id FROM tasks WHERE id=$1',[f.taskId])).rows[0]).toMatchObject({status,owner_principal_id:f.owner.id});
});
test.each([['empty'],['empty','review'],['review','empty','review'],['review','in-progress']])('unready/gapped %j refuses inputs and dispatch before lease',async(...statuses)=>{
  const f=await fixture();await subtaskFixture(f,statuses);
  const path=`/tasks/${f.taskId}/native-reviews`;
  expect((await call(f.caller,'GET',path+'/inputs')).status).toBe(409);
  expect((await call(f.parent,'POST',path,{serviceId:f.serviceId,descriptorVersion:1,requestKey:crypto.randomUUID(),expectedInputDigest:'a'.repeat(64)})).status).toBe(409);
  expect((await pool.query('SELECT id FROM task_native_reviews WHERE task_id=$1',[f.taskId])).rowCount).toBe(0);
});
test('last slice cannot pass without the explicitly bound whole Task criterion',async()=>{
  const f=await fixture();await subtaskFixture(f,['review']);const r=await prepared(f);await attest(f,r);
  const body=verdict(r);body.verdict.criteria=body.verdict.criteria.filter((c:any)=>c.id.startsWith('subtask-'));
  expect((await call(f.caller,'POST',`${r.path}/${r.request.id}/verdict`,body)).status).toBe(400);
  expect((await pool.query('SELECT status FROM tasks WHERE id=$1',[f.taskId])).rows[0].status).toBe('review');
});
test('stale never-leased request can be cancelled, exact request replay survives descriptor drift',async()=>{
  const f=await fixture(),path=`/tasks/${f.taskId}/native-reviews`;
  const input=(await call(f.caller,'GET',path+'/inputs')).body.result;
  const body={serviceId:f.serviceId,descriptorVersion:1,requestKey:crypto.randomUUID(),expectedInputDigest:input.inputDigest};
  const original=await call(f.parent,'POST',path,body);expect(original.status).toBe(200);
  await pool.query("UPDATE service_descriptor_versions SET descriptor=descriptor-'nativeReview' WHERE service_id=$1",[f.serviceId]);
  expect((await call(f.parent,'POST',path,body)).body).toEqual(original.body);
  expect((await call(f.parent,'POST',path,{...body,expectedInputDigest:'b'.repeat(64)})).status).toBe(409);
  const cancel={inputDigest:input.inputDigest},route=`${path}/${original.body.result.id}/cancel`;
  expect((await call(f.owner,'POST',route,cancel)).status).toBe(403);
  const response=await call(f.parent,'POST',route,cancel);expect(response.status).toBe(200);expect(response.body.result.state).toBe('cancelled');
  expect((await call(f.parent,'POST',route,cancel)).body).toEqual(response.body);
});
test('never-leased cancellation cannot erase a granted lease',async()=>{
  const f=await fixture(),r=await prepared(f);
  expect((await call(f.parent,'POST',`${r.path}/${r.request.id}/cancel`,{inputDigest:r.input.inputDigest})).status).toBe(409);
});
test('read-only inputs work while a child writer holds its uncommitted row; writer barrier remains exclusive for mutations',async()=>{
  const f=await fixture();await subtaskFixture(f,['review']);
  const client=await pool.connect();try {
    await client.query('BEGIN');await client.query("UPDATE subtasks SET note='uncommitted' WHERE task_id=$1",[f.taskId]);
    expect((await call(f.caller,'GET',`/tasks/${f.taskId}/native-reviews/inputs`)).status).toBe(200);
  } finally {await client.query('ROLLBACK');client.release();}
});

test('supported subtask and dependency writers return typed 409 during native verdict barrier',async()=>{
  const f=await fixture();await subtaskFixture(f,['review']);
  const sub=(await pool.query('SELECT id FROM subtasks WHERE task_id=$1',[f.taskId])).rows[0].id;
  const dep=(await pool.query("INSERT INTO tasks(title,status,visibility,shepherd_principal_id) VALUES($1,'completed','shared',$2) RETURNING id",[tag(),f.parent.id])).rows[0].id;
  await pool.query('INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES($1,$2)',[f.taskId,dep]);
  const client=await pool.connect();try {
    await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(1397653301,hashtext($1::text))',[f.taskId]);
    for(const [method,path,body] of [
      ['PATCH',`/tasks/${f.taskId}/subtasks/by-id/${sub}/status`,{status:'review',reviewNote:'changed'}],
      ['DELETE',`/tasks/${f.taskId}/dependencies/${dep}`,undefined],
    ] as [string,string,unknown][]) {
      const response=await call(f.parent,method,path,body);
      expect(response.status).toBe(409);expect(response.body.code).toBe('TASK_REVIEW_EVIDENCE_BUSY');
    }
  } finally {await client.query('ROLLBACK');client.release();}
});


test('actual REST/MCP session privacy recomputes scope, expiry and current Task read before projection', async () => {
  const f=await fixture(),r=await prepared(f);await attest(f,r);
  const envelope={schema_version:'rh.ai.telemetry/1.0',event_id:crypto.randomUUID(),kind:'session',phase:'started',
    source:{product:'claude-code',adapter:'fixture'},correlation:{session_id:'real-init-fixture'}};
  async function connector(parentId:string,servicesRead:boolean) {
    const id=(await pool.query("INSERT INTO principals(kind,handle,display_name,status,role,parent_principal_id,purpose,own_expression) VALUES('service',$1,$1,'active','user',$2,'privacy fixture',$3::jsonb) RETURNING id",
      [tag(),parentId,JSON.stringify({scopes:'parent',objects:'parent'})])).rows[0].id;
    const scopes=['tasks:read','tasks:write','principals:read',...(servicesRead?['services:read']:[])];
    const issued=await principalService.issueCredential({principalId:id,scopes,transport:'any'},
      {principalId:f.parent.id,handle:'privacy-fixture',authMethod:'system'});
    return {id,parentId,token:issued.fullKey,headers:{Authorization:'Bearer '+issued.fullKey}};
  }
  async function mcp(who:any,name:string,args:any) {
    const response=await fetch(origin+mcpRoutes.MCP_ROUTE_PATH,{method:'POST',headers:{...who.headers,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},
      body:JSON.stringify({jsonrpc:'2.0',id:11,method:'tools/call',params:{name,arguments:args}})});
    const json:any=await response.json();
    const text=(json.result?.content??[]).map((part:any)=>part.text??'').join(String.fromCharCode(10));
    return {status:response.status,error:Boolean(json.error||json.result?.isError),text};
  }
  const allowed=await connector(f.parent.id,true);
  const denied=await connector(f.parent.id,false);
  const foreignParent=await human('user'),foreign=await connector(foreignParent.id,true);
  for(const who of [allowed,denied,foreign]) {
    const boot=await mcp(who,'relayhall_brief_compile',{session:true});
    expect({status:boot.status,error:boot.error}).toEqual({status:200,error:false});
  }
  const projection=jest.spyOn(telemetryProjectionService,'session');
  async function state(who:any,expected:any,projectionCalls:number) {
    projection.mockClear();
    const restResult=await call(who,'GET',r.path);
    expect(restResult.status).toBe(200);
    expect(JSON.stringify(restResult.body.result[0].session)).toBe(JSON.stringify(expected));
    expect(projection).toHaveBeenCalledTimes(projectionCalls);
    projection.mockClear();
    const viaMcp=await mcp(who,'relayhall_task_native_review',{task:f.taskId,action:'list'});
    expect(viaMcp.error).toBe(false);
    const json=JSON.parse(viaMcp.text);
    expect(JSON.stringify(json.result[0].session)).toBe(JSON.stringify(expected));
    expect(projection).toHaveBeenCalledTimes(projectionCalls);
    if(expected.state!=='available') {
      for(const text of [JSON.stringify(restResult.body.result[0].session),JSON.stringify(json.result[0].session)]) {
        for(const forbidden of ['sessionRef','connectorId','sourceProduct','expires','count','real-init-fixture']) expect(text).not.toContain(forbidden);
      }
    }
  }
  try {
    // An attested link is truthful but unavailable until real fixture telemetry arrives.
    await state(allowed,{state:'unavailable'},1);
    expect((await call(f.caller,'POST','/telemetry/events',envelope)).status).toBe(200);
    // Build the navigation expectation independently of either read response.
    const attested=(await pool.query('SELECT session_ref FROM task_native_review_sessions WHERE review_id=$1',[r.request.id])).rows;
    expect(attested).toHaveLength(1);
    expect(attested[0].session_ref).toEqual(expect.any(String));
    expect(attested[0].session_ref.length).toBeGreaterThan(0);
    await state(allowed,{state:'available',sessionRef:attested[0].session_ref,
      connectorId:f.caller.id,sourceProduct:'claude-code'},1);
    await state(denied,{state:'restricted'},0);
    await state(foreign,{state:'restricted'},0);
    // Current scope is narrowed after a previously available read.
    await pool.query('UPDATE principals SET own_expression=$2::jsonb WHERE id=$1',
      [allowed.id,JSON.stringify({scopes:['tasks:read','tasks:write','principals:read'],objects:'parent'})]);
    await state(allowed,{state:'restricted'},0);
    await pool.query("UPDATE task_native_review_sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE review_id=$1",[r.request.id]);
    await pool.query("UPDATE task_native_reviews SET session_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[r.request.id]);
    await state(denied,{state:'restricted'},0);await state(foreign,{state:'restricted'},0);
    await pool.query('UPDATE principals SET own_expression=$2::jsonb WHERE id=$1',
      [allowed.id,JSON.stringify({scopes:'parent',objects:'parent'})]);
    await state(allowed,{state:'expired'},0);
    // The Task itself may remain private and readable only by a revocable grant.
    await pool.query("UPDATE tasks SET visibility='private' WHERE id=$1",[f.taskId]);
    for(const principal of [foreign.id,foreign.parentId]) await pool.query(
      "INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id) VALUES('principal',$1,'task',$2,'read',$3)",
      [principal,f.taskId,f.parent.id]);
    await state(foreign,{state:'restricted'},0);
    await pool.query("DELETE FROM grants WHERE grantee_id=ANY($1::uuid[]) AND resource_type='task' AND resource_id=$2",
      [[foreign.id,foreign.parentId],f.taskId]);
    projection.mockClear();
    const lost=await call(foreign,'GET',r.path);expect(lost.status).toBe(404);
    const lostMcp=await mcp(foreign,'relayhall_task_native_review',{task:f.taskId,action:'list'});
    expect(lostMcp.error).toBe(true);expect(projection).not.toHaveBeenCalled();
    expect(JSON.stringify(lost.body)).not.toContain('expired');expect(lostMcp.text).not.toContain('expired');
  } finally {projection.mockRestore();}
});
