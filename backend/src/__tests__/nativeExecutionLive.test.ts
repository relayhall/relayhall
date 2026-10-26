/** Actual auth/routes/ledger and PostgreSQL locks. Disposable targets only. */
import http from 'http';
import crypto from 'crypto';
const url=process.env.RELAYHALL_TEST_DB_URL;
if(!url) throw new Error('RELAYHALL_TEST_DB_URL is required');
const parsed=new URL(url),database=decodeURIComponent(parsed.pathname.slice(1));
if(!['postgres:','postgresql:'].includes(parsed.protocol) || !(['localhost','127.0.0.1'].includes(parsed.hostname) || (process.env.CI==='true' && parsed.hostname==='postgres'))
  || !(database==='relayhall_native_review_test' || (process.env.CI==='true' && database==='relayhall_ci'))) throw new Error('Disposable native execution database only');
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
jest.setTimeout(120000);
let server:http.Server,origin:string;
type Caller={id:string;headers:Record<string,string>};
const tag=()=>`execution-${crypto.randomBytes(6).toString('hex')}`;
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
  const parent=await human(),outsider=await human('user'),verifier=await human('user');
  const owner=(await pool.query(`INSERT INTO principals(kind,handle,display_name,status,parent_principal_id,purpose,own_expression)
    VALUES('service',$1,$1,'active',$2,'disposable native execution',$3) RETURNING id`,[tag(),parent.id,JSON.stringify({scopes:'parent',objects:'parent'})])).rows[0].id;
  const serviceId=crypto.randomUUID();
  const descriptor={options:[],telemetry:{tier:'presence',products:['claude-code']},nativeExecution:{protocolVersion:1,sourceProduct:'claude-code'}};
  await pool.query(`INSERT INTO services(id,slug,name,kind,status,principal_id,telemetry_tier,current_descriptor_version)
    VALUES($1,$2,$2,'connector','published',$3,'presence',1)`,[serviceId,tag(),owner]);
  await pool.query('INSERT INTO service_descriptor_versions(service_id,version,descriptor,content_hash) VALUES($1,1,$2,$3)',[serviceId,JSON.stringify(descriptor),reviewDigest(descriptor)]);
  const scopes=['tasks:read','tasks:write','services:read','services:invoke','reports:read','reports:write','telemetry:write'];
  const issued=await principalService.issueCredential({principalId:owner,scopes,transport:'any'},{handle:'native-execution-fixture',authMethod:'system'});
  const caller:Caller={id:owner,headers:{Authorization:`Bearer ${issued.fullKey}`}};
  const taskId=(await pool.query(`INSERT INTO tasks(title,description,status,visibility,creator_principal_id,owner_principal_id,verifier_principal_id,shepherd_principal_id,execution_service_id,execution_descriptor_version,execution_profile)
    VALUES($1,'Ordinary implementation fixture','in-progress','shared',$2,$3,$4,$2,$5,1,$6) RETURNING id`,[tag(),parent.id,owner,verifier.id,serviceId,JSON.stringify({options:{}})])).rows[0].id;
  return {parent,outsider,verifier,caller,serviceId,taskId,issued,scopes};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function opened(f:Fixture) {
  const path=`/tasks/${f.taskId}/native-executions`;
  const input=await call(f.caller,'GET',path);expect(input.status).toBe(200);
  const leaseToken=crypto.randomBytes(32).toString('hex');
  const body={dispatchKey:crypto.randomUUID(),assignmentEpoch:input.body.result.assignmentEpoch,serviceId:f.serviceId,descriptorVersion:1,leaseToken,budgetSeconds:540};
  const response=await call(f.caller,'POST',path,body);expect(response.status).toBe(200);
  return {path,body,row:response.body.result,leaseToken,launchKey:crypto.randomUUID()};
}
type Run=Awaited<ReturnType<typeof opened>>;
async function launch(f:Fixture,r:Run) {
  const response=await call(f.caller,'POST',`${r.path}/${r.row.id}/authorize-launch`,{leaseToken:r.leaseToken,launchKey:r.launchKey});
  expect(response.status).toBe(200);return response;
}
async function attested(f:Fixture,r:Run,extra:Record<string,unknown>={}) {
  const body={leaseToken:r.leaseToken,slotId:crypto.randomUUID(),relationship:'primary',correlation:{session_id:'actual-native-init'},...extra};
  const response=await call(f.caller,'POST',`${r.path}/${r.row.id}/attest`,body);
  expect(response.status).toBe(200);return body;
}
beforeAll(async()=>{
  const app=express();app.use(express.json());
  registerProtectedRoutes((mount:string,...handlers:any[])=>app.use(mount,authMiddleware,sharedAuthorizationMiddleware,...handlers));app.use(apiErrorHandler);
  await new Promise<void>(resolve=>{server=app.listen(0,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();});

test('actual REST lifecycle, exact retries and no canonical completion or raw ID persistence',async()=>{
  const f=await fixture(),r=await opened(f);
  const before=(await pool.query('SELECT status,owner_principal_id,attempt_count FROM tasks WHERE id=$1',[f.taskId])).rows[0];
  expect((await call(f.caller,'POST',r.path,r.body)).body.result).toEqual(r.row);
  expect((await call(f.caller,'POST',r.path,{...r.body,budgetSeconds:541})).status).toBe(409);
  await launch(f,r);await launch(f,r);
  expect((await call(f.caller,'POST',`${r.path}/${r.row.id}/authorize-launch`,{leaseToken:r.leaseToken,launchKey:crypto.randomUUID()})).status).toBe(409);
  const body=await attested(f,r);
  const first=(await pool.query('SELECT * FROM task_native_execution_sessions WHERE execution_id=$1',[r.row.id])).rows;
  await attested(f,r,body);
  expect((await pool.query('SELECT * FROM task_native_execution_sessions WHERE execution_id=$1',[r.row.id])).rows).toEqual(first);
  expect(JSON.stringify(first)).not.toContain('actual-native-init');
  expect((await call(f.caller,'POST',`${r.path}/${r.row.id}/heartbeat`,{leaseToken:r.leaseToken})).status).toBe(200);
  const closed=await call(f.caller,'POST',`${r.path}/${r.row.id}/close`,{leaseToken:r.leaseToken,outcome:'completed'});
  expect(closed.status).toBe(200);expect(closed.body.result.state).toBe('closed');
  expect((await call(f.caller,'POST',`${r.path}/${r.row.id}/close`,{leaseToken:r.leaseToken,outcome:'completed'})).body).toEqual(closed.body);
  expect((await call(f.caller,'POST',`${r.path}/${r.row.id}/close`,{leaseToken:r.leaseToken,outcome:'failed'})).status).toBe(409);
  expect((await pool.query('SELECT status,owner_principal_id,attempt_count FROM tasks WHERE id=$1',[f.taskId])).rows[0]).toEqual(before);
  expect((await pool.query('SELECT id FROM task_review_attempts WHERE task_id=$1',[f.taskId])).rowCount).toBe(0);
});
test('concurrent opens admit one provider authorization and serialize ordinal',async()=>{
  const f=await fixture(),r=await opened(f);
  await call(f.caller,'POST',`${r.path}/${r.row.id}/cancel`,{});
  const replies=await Promise.all([1,2].map(()=>call(f.caller,'POST',r.path,{...r.body,dispatchKey:crypto.randomUUID()})));
  expect(replies.map(x=>x.status).sort()).toEqual([200,409]);
  expect(replies.find(x=>x.status===200)!.body.result.runOrdinal).toBe(2);
});
test.each(['owner-ABA','profile-ABA','service-pin','owner-handoff'])('%s invalidates old epoch and preserves unresolved fence',async change=>{
  const f=await fixture(),r=await opened(f);await launch(f,r);
  if(change==='owner-ABA') {await pool.query('UPDATE tasks SET owner_principal_id=NULL WHERE id=$1',[f.taskId]);await pool.query('UPDATE tasks SET owner_principal_id=$2 WHERE id=$1',[f.taskId,f.caller.id]);}
  if(change==='profile-ABA') {await pool.query('UPDATE tasks SET execution_profile=$2 WHERE id=$1',[f.taskId,JSON.stringify({options:{x:true}})]);await pool.query('UPDATE tasks SET execution_profile=$2 WHERE id=$1',[f.taskId,JSON.stringify({options:{}})]);}
  if(change==='service-pin') await pool.query('UPDATE tasks SET execution_service_id=NULL,execution_descriptor_version=NULL,execution_profile=NULL WHERE id=$1',[f.taskId]);
  if(change==='owner-handoff') await pool.query('UPDATE tasks SET owner_principal_id=$2 WHERE id=$1',[f.taskId,f.outsider.id]);
  const response=await call(f.caller,'POST',`${r.path}/${r.row.id}/heartbeat`,{leaseToken:r.leaseToken});expect([403,409]).toContain(response.status);
  const row=(await pool.query('SELECT state FROM task_native_executions WHERE id=$1',[r.row.id])).rows[0];expect(row.state).toBe('ownership_lost');
  const view=await call(f.parent,'GET',r.path);expect(Number(view.body.result.assignmentEpoch)).toBeGreaterThan(Number(r.body.assignmentEpoch));
  if(change==='owner-ABA' || change==='profile-ABA') expect((await call(f.caller,'POST',r.path,{...r.body,dispatchKey:crypto.randomUUID(),assignmentEpoch:view.body.result.assignmentEpoch})).status).toBe(409);
  const proof={launchKey:r.launchKey,intentDigest:'a'.repeat(64),processIdentityDigest:'b'.repeat(64),treeAbsent:true,stoppedAt:new Date().toISOString()};
  const stopped=await call(f.parent,'POST',`${r.path}/${r.row.id}/reconcile`,proof);expect(stopped.status).toBe(200);expect(stopped.body.result.state).toBe('stopped_unresolved');
  expect(stopped.body.result.outcome).toBeNull();
});
test('expiry remains uncertain, no automatic retry, exact Shepherd reconciliation and retry',async()=>{
  const f=await fixture(),r=await opened(f);await launch(f,r);
  await pool.query("UPDATE task_native_executions SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[r.row.id]);
  expect((await call(f.caller,'GET',r.path)).body.result.executions[0].state).toBe('uncertain');
  expect((await call(f.caller,'POST',`${r.path}/${r.row.id}/heartbeat`,{leaseToken:r.leaseToken})).status).toBe(409);
  expect((await call(f.parent,'POST',`${r.path}/${r.row.id}/cancel`,{})).status).toBe(409);
  const proof={launchKey:r.launchKey,intentDigest:'a'.repeat(64),processIdentityDigest:'b'.repeat(64),treeAbsent:true,stoppedAt:new Date().toISOString()};
  expect((await call(f.parent,'POST',`${r.path}/${r.row.id}/reconcile`,{...proof,treeAbsent:false})).status).toBe(400);
  expect((await call(f.parent,'POST',`${r.path}/${r.row.id}/reconcile`,proof)).status).toBe(200);
  expect((await call(f.parent,'POST',`${r.path}/${r.row.id}/reconcile`,proof)).status).toBe(200);
  expect((await call(f.parent,'POST',`${r.path}/${r.row.id}/reconcile`,{...proof,intentDigest:'c'.repeat(64)})).status).toBe(409);
  expect((await call(f.caller,'POST',r.path,{...r.body,dispatchKey:crypto.randomUUID()})).status).toBe(200);
});
test('Shepherd cannot release a live owner fence; exact owner custody or expired lease can reconcile',async()=>{
  const f=await fixture(),r=await opened(f);await launch(f,r);
  const proof={launchKey:r.launchKey,intentDigest:'a'.repeat(64),processIdentityDigest:'b'.repeat(64),treeAbsent:true,stoppedAt:new Date().toISOString()};
  const refused=await call(f.parent,'POST',`${r.path}/${r.row.id}/reconcile`,proof);
  expect(refused.status).toBe(409);expect(JSON.stringify(refused.body)).toContain('NATIVE_EXECUTION_OWNER_LEASE_LIVE');
  expect((await pool.query('SELECT state FROM task_native_executions WHERE id=$1',[r.row.id])).rows[0].state).toBe('launch_authorized');
  expect((await call(f.caller,'POST',r.path,{...r.body,dispatchKey:crypto.randomUUID()})).status).toBe(409);
  expect((await call(f.caller,'POST',`${r.path}/${r.row.id}/reconcile`,proof)).status).toBe(200);
  const later=await opened(f);await launch(f,later);
  await pool.query("UPDATE task_native_executions SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[later.row.id]);
  expect((await call(f.parent,'POST',`${later.path}/${later.row.id}/reconcile`,{...proof,launchKey:later.launchKey,stoppedAt:new Date().toISOString()})).status).toBe(200);
});
test.each([-60,60])('reconcile accepts bounded %s-second client clock skew without inventing outcome',async skew=>{
  const f=await fixture(),r=await opened(f);await launch(f,r);
  const proof={launchKey:r.launchKey,intentDigest:'a'.repeat(64),processIdentityDigest:'b'.repeat(64),treeAbsent:true,stoppedAt:new Date(Date.now()+skew*1000).toISOString()};
  const result=await call(f.caller,'POST',`${r.path}/${r.row.id}/reconcile`,proof);
  expect(result.status).toBe(200);expect(result.body.result.state).toBe('stopped_unresolved');expect(result.body.result.outcome).toBeNull();
  expect((await call(f.caller,'POST',`${r.path}/${r.row.id}/reconcile`,proof)).body).toEqual(result.body);
});
test.each([-180,180])('reconcile rejects out-of-bound %s-second clock skew',async skew=>{
  const f=await fixture(),r=await opened(f);await launch(f,r);
  expect((await call(f.caller,'POST',`${r.path}/${r.row.id}/reconcile`,{launchKey:r.launchKey,intentDigest:'a'.repeat(64),processIdentityDigest:'b'.repeat(64),treeAbsent:true,stoppedAt:new Date(Date.now()+skew*1000).toISOString()})).status).toBe(400);
});
test('parent and assigned Verifier cannot impersonate owner; missing telemetry scope refuses attestation',async()=>{
  const f=await fixture(),r=await opened(f);await launch(f,r);
  for(const caller of [f.parent,f.verifier]) expect((await call(caller,'POST',`${r.path}/${r.row.id}/heartbeat`,{leaseToken:r.leaseToken})).status).toBe(403);
  const issued=await principalService.issueCredential({principalId:f.caller.id,scopes:f.scopes.filter(s=>s!=='telemetry:write'),transport:'any'},{handle:'native-execution-fixture',authMethod:'system'});
  const limited={id:f.caller.id,headers:{Authorization:`Bearer ${issued.fullKey}`}};
  expect((await call(limited,'POST',`${r.path}/${r.row.id}/attest`,{leaseToken:r.leaseToken,slotId:crypto.randomUUID(),relationship:'primary',correlation:{session_id:'actual-native-init'}})).status).toBe(403);
  await pool.query("UPDATE principals SET own_expression=$2 WHERE id=$1",[f.caller.id,JSON.stringify({scopes:['tasks:read'],objects:'parent'})]);
  expect((await call(f.caller,'POST',`${r.path}/${r.row.id}/heartbeat`,{leaseToken:r.leaseToken})).status).toBe(403);
});
test('primary, child and explicit resumed participation preserve conversation precedence and reject slot rebinding',async()=>{
  const f=await fixture(),r=await opened(f);await launch(f,r);
  const primary=await attested(f,r,{correlation:{session_id:'native-child',conversation_id:'native-parent'}});
  const child=await attested(f,r,{parentSlotId:primary.slotId,relationship:'child',correlation:{session_id:'native-subagent'}});
  expect(child.slotId).not.toBe(primary.slotId);
  expect((await call(f.caller,'POST',`${r.path}/${r.row.id}/attest`,{...primary,correlation:{session_id:'different'}})).status).toBe(409);
  const ref=(await pool.query('SELECT session_ref FROM task_native_execution_sessions WHERE execution_id=$1 AND slot_id=$2',[r.row.id,primary.slotId])).rows[0].session_ref;
  const {telemetrySessionReference}=require('../utils/telemetryPepper');
  expect(ref).toBe(telemetrySessionReference('claude-code',{session_id:'native-parent'}));
  await call(f.caller,'POST',`${r.path}/${r.row.id}/close`,{leaseToken:r.leaseToken,outcome:'completed'});
  const next=await opened(f);await launch(f,next);await attested(f,next,{relationship:'resumed',correlation:primary.correlation});
  expect((await pool.query('SELECT session_ref FROM task_native_execution_sessions WHERE execution_id=$1',[next.row.id])).rows[0].session_ref).toBe(ref);
});
test('privacy projection hides all slots outside Account; explicit root sees actual available triple',async()=>{
  const f=await fixture(),r=await opened(f);await launch(f,r);await attested(f,r);
  const outside=await call(f.outsider,'GET','/principals/me');expect(outside.status).toBe(200);
  expect(JSON.stringify(outside.body)).not.toContain('"root"');expect(f.outsider.id).not.toBe(f.parent.id);
  const ingest=await call(f.caller,'POST','/telemetry/events',{schema_version:'rh.ai.telemetry/1.0',event_id:crypto.randomUUID(),kind:'session',phase:'started',source:{product:'claude-code',adapter:'fixture'},correlation:{session_id:'actual-native-init'}});
  expect(ingest.status).toBe(200);
  {
    expect((await call(f.outsider,'GET',r.path)).body.result.executions[0].session).toEqual({state:'restricted'});
    const own=(await call(f.caller,'GET',r.path)).body.result.executions[0].session;
    expect(own.state).toBe('attested');expect(own.sessions[0]).toMatchObject({state:'available',connectorId:f.caller.id,sourceProduct:'claude-code'});
    expect((await call(f.parent,'GET',r.path)).body.result.executions[0].session).toEqual(own);
    await pool.query("UPDATE task_native_execution_sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE execution_id=$1",[r.row.id]);
    expect((await call(f.caller,'GET',r.path)).body.result.executions[0].session.sessions).toEqual([{state:'expired'}]);
  }
});
test('slot limit, malformed correlation and prelaunch attest are refused',async()=>{
  const f=await fixture(),r=await opened(f);
  const body={leaseToken:r.leaseToken,slotId:crypto.randomUUID(),relationship:'primary',correlation:{session_id:'actual-init'}};
  expect((await call(f.caller,'POST',`${r.path}/${r.row.id}/attest`,body)).status).toBe(409);await launch(f,r);
  for(const value of ['', 'a'.repeat(129),'bad id']) expect((await call(f.caller,'POST',`${r.path}/${r.row.id}/attest`,{...body,correlation:{session_id:value}})).status).toBe(400);
  for(let index=0;index<16;index++) await attested(f,r);
  expect((await call(f.caller,'POST',`${r.path}/${r.row.id}/attest`,body)).status).toBe(409);
});
test.each(['options','descriptor'])('recovery exact profile %s change is not a false replay',async change=>{
  const f=await fixture();
  const {taskManagerDB}=require('../services/TaskManagerDB');
  const original={executionServiceId:f.serviceId,executionDescriptorVersion:1,executionProfile:{options:{mode:'a'}},executionWarrantId:null};
  expect((await taskManagerDB.recoverTask(f.taskId,original)).outcome).toBe('recovered');
  const epoch=(await pool.query('SELECT epoch FROM task_native_assignment_epochs WHERE task_id=$1',[f.taskId])).rows[0].epoch;
  expect((await taskManagerDB.recoverTask(f.taskId,original)).outcome).toBe('replayed');
  expect((await pool.query('SELECT epoch FROM task_native_assignment_epochs WHERE task_id=$1',[f.taskId])).rows[0].epoch).toBe(epoch);
  if(change==='descriptor') await pool.query('INSERT INTO service_descriptor_versions(service_id,version,descriptor,content_hash) SELECT service_id,2,descriptor,content_hash FROM service_descriptor_versions WHERE service_id=$1 AND version=1',[f.serviceId]);
  const changed=change==='options'?{...original,executionProfile:{options:{mode:'b'}}}:{...original,executionDescriptorVersion:2};
  expect((await taskManagerDB.recoverTask(f.taskId,changed)).outcome).toBe('recovered');
  const row=(await pool.query('SELECT execution_profile,execution_descriptor_version,auto_start FROM tasks WHERE id=$1',[f.taskId])).rows[0];
  expect(row.execution_profile).toEqual(changed.executionProfile);expect(row.execution_descriptor_version).toBe(changed.executionDescriptorVersion);
  expect((await taskManagerDB.recoverTask(f.taskId,changed)).outcome).toBe('replayed');
  expect(Number((await pool.query('SELECT epoch FROM task_native_assignment_epochs WHERE task_id=$1',[f.taskId])).rows[0].epoch)).toBeGreaterThan(Number(epoch));
});
test('explicit pepper rotation verifies old seed, preserves expiry and refuses unavailable prior key',async()=>{
  const f=await fixture(),r=await opened(f);await launch(f,r);const body=await attested(f,r);
  const original=process.env.RELAYHALL_TELEMETRY_PEPPERS!,active=process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER;
  const {resetTelemetryPepperCache}=require('../utils/telemetryPepper');
  try {
    const keys={...JSON.parse(original),rotated:crypto.randomBytes(32).toString('base64')};
    process.env.RELAYHALL_TELEMETRY_PEPPERS=JSON.stringify(keys);process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER='rotated';resetTelemetryPepperCache();
    await attested(f,r,body);
    const links=(await pool.query('SELECT session_ref,expires_at FROM task_native_execution_sessions WHERE execution_id=$1',[r.row.id])).rows;
    expect(links).toHaveLength(2);expect(links[0].session_ref).not.toBe(links[1].session_ref);expect(links[0].expires_at).toEqual(links[1].expires_at);
    process.env.RELAYHALL_TELEMETRY_PEPPERS=JSON.stringify({rotated:keys.rotated});resetTelemetryPepperCache();
    await attested(f,r,body); // Already acknowledged current-key retry remains valid.
    process.env.RELAYHALL_TELEMETRY_PEPPERS=JSON.stringify({third:crypto.randomBytes(32).toString('base64')});process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER='third';resetTelemetryPepperCache();
    expect((await call(f.caller,'POST',`${r.path}/${r.row.id}/attest`,body)).status).toBe(409);
  } finally {process.env.RELAYHALL_TELEMETRY_PEPPERS=original;process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER=active;resetTelemetryPepperCache();}
});
test('retention deletes identity-bound slots with receipt and no canonical attempt mutation',async()=>{
  const f=await fixture(),r=await opened(f);await launch(f,r);await attested(f,r);
  await pool.query("UPDATE task_native_execution_sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE execution_id=$1",[r.row.id]);
  const {telemetryRetentionService}=require('../services/TelemetryRetentionService');
  const sweep=await telemetryRetentionService.sweep();
  expect(sweep.receipts.find((x:any)=>x.payloadClass==='native_execution_session_link').removed).toBeGreaterThanOrEqual(1);
  expect((await pool.query('SELECT * FROM task_native_execution_sessions WHERE execution_id=$1',[r.row.id])).rowCount).toBe(0);
  expect((await call(f.caller,'GET',r.path)).body.result.executions[0].session).toEqual({state:'expired'});
});
test('task-bound child owns implementation; parent Connector cannot impersonate its attestation',async()=>{
  const f=await fixture();
  const agent=(await pool.query(`INSERT INTO principals(kind,handle,display_name,status,parent_principal_id,bound_task_id,purpose,own_expression)
    VALUES('agent',$1,$1,'active',$2,$3,'disposable execution child',$4) RETURNING id`,[tag(),f.caller.id,f.taskId,JSON.stringify({scopes:'parent',objects:'parent'})])).rows[0].id;
  await pool.query('UPDATE tasks SET owner_principal_id=$2 WHERE id=$1',[f.taskId,agent]);
  const issued=await principalService.issueCredential({principalId:agent,scopes:f.scopes,transport:'any'},{handle:'native-execution-fixture',authMethod:'system'});
  const child={id:agent,headers:{Authorization:`Bearer ${issued.fullKey}`}};
  const childFixture={...f,caller:child};const r=await opened(childFixture);await launch(childFixture,r);await attested(childFixture,r);
  const identity=(await pool.query('SELECT actor_principal_id,connector_id,account_id,agent_id FROM task_native_executions WHERE id=$1',[r.row.id])).rows[0];
  expect(identity).toEqual({actor_principal_id:agent,connector_id:f.caller.id,account_id:f.parent.id,agent_id:agent});
  expect((await call(f.caller,'POST',`${r.path}/${r.row.id}/heartbeat`,{leaseToken:r.leaseToken})).status).toBe(403);
});
test('unlaunched cancel is idempotent; retired capability refuses before any launch grant',async()=>{
  const f=await fixture(),r=await opened(f);
  await pool.query("UPDATE services SET status='retired' WHERE id=$1",[f.serviceId]);
  expect((await call(f.caller,'POST',`${r.path}/${r.row.id}/authorize-launch`,{leaseToken:r.leaseToken,launchKey:r.launchKey})).status).toBe(409);
  expect((await pool.query('SELECT launch_key FROM task_native_executions WHERE id=$1',[r.row.id])).rows[0].launch_key).toBeNull();
  expect((await call(f.parent,'POST',`${r.path}/${r.row.id}/cancel`,{})).body.result.state).toBe('cancelled');
  expect((await call(f.parent,'POST',`${r.path}/${r.row.id}/cancel`,{})).body.result.state).toBe('cancelled');
});
test('result Report must be caller-authored and actually associated; close does not finish Task',async()=>{
  const f=await fixture(),r=await opened(f);await launch(f,r);await attested(f,r);
  const report=(await pool.query(`INSERT INTO reports(title,content,summary,task_ids,author_principal_id,origin,visibility)
    VALUES($1,'bounded actual result','fixture',$2,$3,'api','shared') RETURNING id`,[tag(),[f.taskId],f.parent.id])).rows[0].id;
  const body={leaseToken:r.leaseToken,outcome:'completed',reportId:report};
  expect((await call(f.caller,'POST',`${r.path}/${r.row.id}/close`,body)).status).toBe(403);
  await pool.query('UPDATE reports SET author_principal_id=$2 WHERE id=$1',[report,f.caller.id]);
  expect((await call(f.caller,'POST',`${r.path}/${r.row.id}/close`,body)).status).toBe(200);
  expect((await call(f.caller,'GET',r.path)).body.result.executions[0].reportId).toBe(report);
  expect((await pool.query('SELECT status FROM tasks WHERE id=$1',[f.taskId])).rows[0].status).toBe('in-progress');
});
async function generationFixture() {
 const f=await fixture();await pool.query("UPDATE tasks SET status='todo',owner_principal_id=NULL,auto_start=true WHERE id=$1",[f.taskId]);
 const epoch=(await pool.query('SELECT epoch FROM task_native_assignment_epochs WHERE task_id=$1',[f.taskId])).rows[0].epoch;
 const input={schemaVersion:2,deploymentId:process.env.RELAYHALL_DEPLOYMENT_ID,requestKey:crypto.randomUUID(),assignmentEpoch:String(epoch),serviceId:f.serviceId,descriptorVersion:1,workerInstanceId:crypto.randomUUID(),workerToken:crypto.randomBytes(32).toString('hex'),sourceSha256:'a'.repeat(64),inputSha256:'b'.repeat(64),budgetSeconds:540,predecessorExecutionId:null,reviewAttemptId:null};
 const path=`/tasks/${f.taskId}/native-executions/generations`;
 const reserved=await call(f.caller,'POST',path,input);expect(reserved.status).toBe(200);return {f,input,path,g:reserved.body.result};
}
async function generationReady(x:Awaited<ReturnType<typeof generationFixture>>) {
 const {taskManagerDB:taskManager}=require('../services/TaskManagerDB');
 await taskManager.claimTask(x.f.taskId,x.f.caller.id);
 await pool.query("UPDATE tasks SET status='in-progress' WHERE id=$1",[x.f.taskId]);
 const r=await opened(x.f);return {r,body:{schemaVersion:2,executionId:r.row.id,workerInstanceId:x.input.workerInstanceId,workerToken:x.input.workerToken,launchKey:r.launchKey}};
}
test('v2 reservation burn/readback and competing reservation never grant launch',async()=>{
 const x=await generationFixture();expect(x.g.launchPermit).toBe(false);
 expect((await call(x.f.caller,'POST',x.path,x.input)).body.result.id).toBe(x.g.id);
 expect((await call(x.f.caller,'POST',x.path,{...x.input,requestKey:crypto.randomUUID()})).status).toBe(409);
 const read=await call(x.f.caller,'GET',x.path+'/'+x.g.id);expect(read.body.result.launchPermit).toBe(false);
 const {r,body}=await generationReady(x);
 expect((await call(x.f.caller,'POST',`${r.path}/${r.row.id}/authorize-launch`,{leaseToken:r.leaseToken,launchKey:r.launchKey})).status).toBe(409);
 const keyed={...x.f.caller,headers:{...x.f.caller.headers,'Idempotency-Key':crypto.randomUUID()}};
 const replies=await Promise.all([1,2].map(()=>call(keyed,'POST',`${x.path}/${x.g.id}/consume`,body)));
 expect(replies.map(z=>z.status)).toEqual([200,200]);expect(replies.filter(z=>z.body.result.freshConsume===true)).toHaveLength(1);
 expect(replies.every(z=>z.body.result.launchPermit===false)).toBe(true);
 const replay=await call(keyed,'POST',`${x.path}/${x.g.id}/consume`,body);expect(replay.body.result.freshConsume).toBe(false);
 expect((await call(x.f.caller,'POST',`${x.path}/${x.g.id}/consume`,{...body,launchKey:crypto.randomUUID()})).status).toBe(409);
});
test('v2 direct assignment cannot manufacture supported claim witness',async()=>{
 const x=await generationFixture();await pool.query("UPDATE tasks SET owner_principal_id=$2,status='in-progress' WHERE id=$1",[x.f.taskId,x.f.caller.id]);
 const r=await opened(x.f),body={schemaVersion:2,executionId:r.row.id,workerInstanceId:x.input.workerInstanceId,workerToken:x.input.workerToken,launchKey:r.launchKey};
 expect((await call(x.f.caller,'POST',`${x.path}/${x.g.id}/consume`,body)).status).toBe(409);
 expect((await pool.query('SELECT state FROM task_native_generations WHERE id=$1',[x.g.id])).rows[0].state).toBe('reserved');
});
test('v2 reassignment ABA and wrong instance leave burned reservation unconsumed',async()=>{
 const x=await generationFixture(),{body}=await generationReady(x);
 expect((await call(x.f.caller,'POST',`${x.path}/${x.g.id}/consume`,{...body,workerInstanceId:crypto.randomUUID()})).status).toBe(403);
 await pool.query('UPDATE tasks SET owner_principal_id=NULL WHERE id=$1',[x.f.taskId]);await pool.query('UPDATE tasks SET owner_principal_id=$2 WHERE id=$1',[x.f.taskId,x.f.caller.id]);
 expect((await call(x.f.caller,'POST',`${x.path}/${x.g.id}/consume`,body)).status).toBe(409);
});
async function generationCompleted(taskReport=false) {
 const x=await generationFixture(),{r,body}=await generationReady(x);
 expect((await call(x.f.caller,'POST',`${x.path}/${x.g.id}/consume`,body)).status).toBe(200);
 const content='Actual protocol test completion; no provider dispatch',hash=crypto.createHash('sha256').update(content).digest('hex');
 let report:string;
 if(taskReport){const saved=await call({...x.f.caller,headers:{...x.f.caller.headers,'Idempotency-Key':crypto.randomUUID()}},'POST',`/tasks/${x.f.taskId}/reports`,{title:tag(),content});expect(saved.status).toBe(201);report=saved.body.report.id;
  const actual=(await pool.query('SELECT origin,source_task_id,author_principal_id,content_hash FROM reports WHERE id=$1',[report])).rows[0];expect(actual).toMatchObject({origin:'task-report',source_task_id:x.f.taskId,author_principal_id:x.f.caller.id,content_hash:hash});
 }else report=(await pool.query('INSERT INTO reports(title,content,content_hash,author_principal_id,task_ids) VALUES($1,$2,$3,$4,$5) RETURNING id',[tag(),content,hash,x.f.caller.id,[x.f.taskId]])).rows[0].id;
 expect((await call(x.f.caller,'POST',`${r.path}/${r.row.id}/close`,{leaseToken:r.leaseToken,outcome:'completed',reportId:report})).status).toBe(200);
 const publicationKey=crypto.randomUUID(),requestSha256=reviewDigest({taskId:x.f.taskId,generationId:x.g.id,executionId:r.row.id,publicationKey,reportId:report,contentSha256:hash,outcome:'completed'});
 const intent={schemaVersion:2,executionId:r.row.id,workerInstanceId:x.input.workerInstanceId,workerToken:x.input.workerToken,publicationKey,reportId:report,contentSha256:hash,requestSha256,outcome:'completed'};
 return {x,r,report,intent,nativeGeneration:{schemaVersion:2,generationId:x.g.id,executionId:r.row.id,publicationKey,requestSha256}};
}
test('v2 finish joins exact Report/native/intent atomically and rolls back wrong request',async()=>{
 const y=await generationCompleted(),{x}=y;
 expect((await call(x.f.caller,'POST',`${x.path}/${x.g.id}/publication-intent`,y.intent)).status).toBe(200);
 const before=(await pool.query('SELECT count(*) FROM task_stream_entries WHERE task_id=$1',[x.f.taskId])).rows[0].count;
 expect((await call(x.f.caller,'POST',`/tasks/${x.f.taskId}/finish`,{reportId:y.report,handover:'Bound handover',nativeGeneration:{...y.nativeGeneration,requestSha256:'c'.repeat(64)}})).status).toBe(409);
 expect((await pool.query('SELECT count(*) FROM task_stream_entries WHERE task_id=$1',[x.f.taskId])).rows[0].count).toBe(before);
 expect((await pool.query('SELECT status FROM tasks WHERE id=$1',[x.f.taskId])).rows[0].status).toBe('in-progress');
 const good=await call(x.f.caller,'POST',`/tasks/${x.f.taskId}/finish`,{reportId:y.report,handover:'Bound handover',nativeGeneration:y.nativeGeneration});
 expect(good.status).toBe(200);expect((await pool.query('SELECT state FROM task_native_generations WHERE id=$1',[x.g.id])).rows[0].state).toBe('finished');
 expect((await pool.query('SELECT status FROM tasks WHERE id=$1',[x.f.taskId])).rows[0].status).toBe('review');
});
// Card 19dd180c: the finish dry run runs the joint native gate in its own
// dry-run mode - every check, then the finish UPDATE's deadline predicate read
// instead of written - so the preview answers what the joint finish answers.
test('v2 finish dry run answers the joint finish outcome and leaves the generation consumed',async()=>{
 const y=await generationCompleted(),{x}=y;
 expect((await call(x.f.caller,'POST',`${x.path}/${x.g.id}/publication-intent`,y.intent)).status).toBe(200);
 const state=async()=>({generation:(await pool.query('SELECT state FROM task_native_generations WHERE id=$1',[x.g.id])).rows[0].state,
  task:(await pool.query('SELECT status FROM tasks WHERE id=$1',[x.f.taskId])).rows[0].status,
  entries:(await pool.query('SELECT count(*)::int n FROM task_stream_entries WHERE task_id=$1',[x.f.taskId])).rows[0].n});
 const before=await state();expect(before).toMatchObject({generation:'consumed',task:'in-progress'});
 const wrong={reportId:y.report,handover:'Bound handover',nativeGeneration:{...y.nativeGeneration,requestSha256:'c'.repeat(64)}};
 const dryWrong=await call(x.f.caller,'POST',`/tasks/${x.f.taskId}/finish`,{...wrong,dryRun:true});
 const realWrong=await call(x.f.caller,'POST',`/tasks/${x.f.taskId}/finish`,wrong);
 expect(realWrong.status).toBe(409);
 expect([dryWrong.status,dryWrong.body?.code]).toEqual([realWrong.status,realWrong.body?.code]);
 const dryGood=await call(x.f.caller,'POST',`/tasks/${x.f.taskId}/finish`,{reportId:y.report,handover:'Bound handover',nativeGeneration:y.nativeGeneration,dryRun:true});
 expect([dryGood.status,dryGood.body?.valid,dryGood.body?.dryRun]).toEqual([200,true,true]);
 expect(await state()).toEqual(before);
 const good=await call(x.f.caller,'POST',`/tasks/${x.f.taskId}/finish`,{reportId:y.report,handover:'Bound handover',nativeGeneration:y.nativeGeneration});
 expect(good.status).toBe(200);expect(await state()).toMatchObject({generation:'finished',task:'review'});
});
test('v2 immutable burned evidence refuses SQL resets and expired publication',async()=>{
 const y=await generationCompleted(),{x}=y;
 await expect(pool.query('UPDATE task_native_generations SET source_digest=$2 WHERE id=$1',[x.g.id,'f'.repeat(64)])).rejects.toHaveProperty('code','PZ001');
 await expect(pool.query('DELETE FROM task_native_generations WHERE id=$1',[x.g.id])).rejects.toHaveProperty('code','PZ001');
 await pool.query("UPDATE task_native_executions SET hard_deadline=clock_timestamp()-interval '1 second' WHERE id=$1",[y.r.row.id]);
 expect((await call(x.f.caller,'POST',`${x.path}/${x.g.id}/publication-intent`,y.intent)).status).toBe(409);
 expect((await pool.query('SELECT publication_intent FROM task_native_generations WHERE id=$1',[x.g.id])).rows[0].publication_intent).toBeNull();
});
async function actualActor(who:Caller) {
 let actor:any;const app=express();app.use(express.json());app.post('/actor',authMiddleware,(req:any,res:any)=>{actor=require('../routes/tasks').requestActor(req);res.json({ok:true});});
 const s=http.createServer(app);await new Promise<void>(resolve=>s.listen(0,'127.0.0.1',resolve));
 try{const r=await fetch(`http://127.0.0.1:${(s.address() as any).port}/actor`,{method:'POST',headers:who.headers});expect(r.status).toBe(200);return actor;}finally{await new Promise<void>(resolve=>s.close(()=>resolve()));}
}
test('two independent service pools: lost winner response reads evidence, never fresh permit',async()=>{
 const x=await generationFixture(),{body}=await generationReady(x),actor=await actualActor(x.f.caller);
 const {Pool}=require('pg'),{NativeExecutionService}=require('../services/NativeExecutionService');
 const p1=new Pool({connectionString:url}),p2=new Pool({connectionString:url});
 try{const a=new NativeExecutionService(p1),b=new NativeExecutionService(p2);
 const results=await Promise.all([a.consumeGeneration(x.f.taskId,x.g.id,body,actor),b.consumeGeneration(x.f.taskId,x.g.id,body,actor)]);
 expect(results.filter(z=>z.freshConsume)).toHaveLength(1);
 // Simulated lost response: discard all winner data, reread exact server evidence.
 const reread=await b.readGeneration(x.f.taskId,x.g.id,actor);expect(reread.state).toBe('consumed');expect(reread.launchPermit).toBe(false);
 expect((await b.consumeGeneration(x.f.taskId,x.g.id,body,actor)).freshConsume).toBe(false);
 }finally{await p1.end();await p2.end();}
});
function quarantineManifest(taskId:string) {
 return {schemaVersion:1,deploymentId:process.env.RELAYHALL_DEPLOYMENT_ID,storeId:crypto.randomUUID(),snapshotSha256:'a'.repeat(64),taskId,
 legacyReservation:{taskId,reservationId:crypto.randomUUID(),cursor:'9',descriptionSha256:'b'.repeat(64),reservedAt:'2026-09-01T00:00:00Z',expiresAt:'2026-09-01T00:10:00Z'},bindRows:[],consumeRows:[],jobs:[],outbox:[{id:crypto.randomUUID(),body:'{"kind":"inert history"}',status:'accepted',tries:1,next:0}],artifacts:[{path:'edit-custody/exact.dpapi',sha256:'c'.repeat(64),byteLength:12,encrypted:true}]};
}
test('privileged quarantine dryrun/write/read preserves original values without cutover',async()=>{
 const f=await fixture();const root=f.parent,manifest=quarantineManifest(f.taskId),path=`/tasks/${f.taskId}/native-executions/quarantine`;
 expect((await call(f.caller,'POST',path+'/dry-run',manifest)).status).toBe(403);
 const dry=await call(root,'POST',path+'/dry-run',manifest);expect(dry.status).toBe(200);expect(dry.body.result.artifactPresenceVerified).toBe(false);
 expect((await pool.query('SELECT id FROM task_native_import_quarantine WHERE task_id=$1',[f.taskId])).rowCount).toBe(0);
 const saved=await call(root,'POST',path,manifest);expect(saved.status).toBe(200);
 const read=await call(root,'GET',path+'/'+saved.body.result.id);expect(read.body.result.manifest).toEqual(manifest);expect(read.body.result.backendIngestionVerified).toBe(false);
 expect((await call(root,'POST',path,{...manifest,snapshotSha256:'d'.repeat(64)})).status).toBe(409);
 const input=await call(f.caller,'GET',`/tasks/${f.taskId}/native-executions`);
 expect((await call(f.caller,'POST',`/tasks/${f.taskId}/native-executions`,{dispatchKey:crypto.randomUUID(),assignmentEpoch:input.body.result.assignmentEpoch,serviceId:f.serviceId,descriptorVersion:1,leaseToken:crypto.randomBytes(32).toString('hex'),budgetSeconds:60})).status).toBe(409);
});
test('actual finish/rejected-attempt producer allows only exact successor and burns second cycle',async()=>{
 const y=await generationCompleted(),{x}=y;
 expect((await call(x.f.caller,'POST',`${x.path}/${x.g.id}/publication-intent`,y.intent)).status).toBe(200);
 expect((await call(x.f.caller,'POST',`/tasks/${x.f.taskId}/finish`,{reportId:y.report,handover:'First cycle',nativeGeneration:y.nativeGeneration})).status).toBe(200);
 const rejected=await require('../services/TaskReviewerService').taskReviewerService.rejectTask(x.f.taskId,'Actual rejected attempt fixture');
 expect(rejected.decision).toBe('reject');
 const attempt=(await pool.query("SELECT id FROM task_review_attempts WHERE task_id=$1 AND status='rejected' ORDER BY attempt_no DESC LIMIT 1",[x.f.taskId])).rows[0].id;
 const epoch=String((await pool.query('SELECT epoch FROM task_native_assignment_epochs WHERE task_id=$1',[x.f.taskId])).rows[0].epoch);
 const next={...x.input,requestKey:crypto.randomUUID(),assignmentEpoch:epoch,predecessorExecutionId:y.r.row.id,reviewAttemptId:attempt};
 expect((await call(x.f.caller,'POST',x.path,{...next,reviewAttemptId:crypto.randomUUID()})).status).toBe(409);
 const reserved=await call(x.f.caller,'POST',x.path,next);expect(reserved.status).toBe(200);
 const x2={...x,input:next,g:reserved.body.result};const {body}=await generationReady(x2);
 const consumed=await call(x.f.caller,'POST',`${x.path}/${x2.g.id}/consume`,body);expect(consumed.status).toBe(200);expect(consumed.body.result.freshConsume).toBe(true);
 expect((await call(x.f.caller,'POST',x.path,{...next,requestKey:crypto.randomUUID()})).status).toBe(409);
 expect((await pool.query('SELECT count(*) FROM task_native_generations WHERE task_id=$1',[x.f.taskId])).rows[0].count).toBe('2');
});
test('publication Report lock crossing original deadline rolls back without intent',async()=>{
 const y=await generationCompleted(),{x}=y,c=await pool.connect();
 await c.query('BEGIN');await c.query('SELECT id FROM reports WHERE id=$1 FOR UPDATE',[y.report]);
 await pool.query("UPDATE task_native_executions SET hard_deadline=clock_timestamp()+interval '1 second' WHERE id=$1",[y.r.row.id]);
 try{const pending=call(x.f.caller,'POST',`${x.path}/${x.g.id}/publication-intent`,y.intent);
 let blocked=false;for(let i=0;i<50;i++){if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT * FROM reports WHERE id=%' LIMIT 1")).rowCount){blocked=true;break;}await new Promise(r=>setTimeout(r,10));}
 expect(blocked).toBe(true);await new Promise(r=>setTimeout(r,1100));await c.query('COMMIT');expect((await pending).status).toBe(409);
 expect((await pool.query('SELECT publication_intent FROM task_native_generations WHERE id=$1',[x.g.id])).rows[0].publication_intent).toBeNull();
 }finally{await c.query('ROLLBACK');c.release();}
});
test('consume expired native cap and malformed typed intent never advance either ledger',async()=>{
 const x=await generationFixture(),{r,body}=await generationReady(x);
 await pool.query("UPDATE task_native_executions SET hard_deadline=clock_timestamp()-interval '1 second' WHERE id=$1",[r.row.id]);
 expect((await call(x.f.caller,'POST',`${x.path}/${x.g.id}/consume`,body)).status).toBe(409);
 expect((await pool.query('SELECT state FROM task_native_generations WHERE id=$1',[x.g.id])).rows[0].state).toBe('reserved');
 expect((await pool.query('SELECT state,launch_key FROM task_native_executions WHERE id=$1',[r.row.id])).rows[0]).toEqual({state:'opened',launch_key:null});
 expect((await call(x.f.caller,'POST',x.path,{...x.input,requestKey:crypto.randomUUID(),sourceSha256:['a'.repeat(64)]})).status).toBe(400);
});
test('current reduced scope refuses new intent without resetting original burned reservation',async()=>{
 const x=await generationFixture();const limited=await principalService.issueCredential({principalId:x.f.caller.id,scopes:['tasks:read','tasks:write'],transport:'any'},{handle:'fixture-scoped',authMethod:'system'});
 const caller={id:x.f.caller.id,headers:{Authorization:`Bearer ${limited.fullKey}`}};
 expect((await call(caller,'POST',x.path,{...x.input,requestKey:crypto.randomUUID()})).status).toBe(403);
 expect((await pool.query('SELECT count(*) FROM task_native_generations WHERE task_id=$1',[x.f.taskId])).rows[0].count).toBe('1');
});

// Regression: the same semantic dependency gate covers every fresh authority use.
async function archivedPrerequisite(taskId:string, disposition:string|null) {
 const id=(await pool.query("INSERT INTO tasks(title,status,archived_at,archive_disposition) VALUES($1,'archived',NOW(),$2) RETURNING id",[tag(),disposition])).rows[0].id;
 await pool.query('INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES($1,$2)',[taskId,id]);return id;
}
test.each(['completed','abandoned',null])('archive disposition %s at open is exact semantic completion',async disposition=>{
 const f=await fixture();await archivedPrerequisite(f.taskId,disposition);
 const path=`/tasks/${f.taskId}/native-executions`,view=await call(f.caller,'GET',path);
 const body={dispatchKey:crypto.randomUUID(),assignmentEpoch:view.body.result.assignmentEpoch,serviceId:f.serviceId,descriptorVersion:1,leaseToken:crypto.randomBytes(32).toString('hex'),budgetSeconds:540};
 const response=await call(f.caller,'POST',path,body);expect(response.status).toBe(disposition==='completed'?200:409);
 expect((await pool.query('SELECT id FROM task_native_executions WHERE task_id=$1',[f.taskId])).rowCount).toBe(disposition==='completed'?1:0);
});
test.each(['completed','abandoned',null])('archive disposition %s at consume cannot advance blocked ledgers',async disposition=>{
 const x=await generationFixture(),{r,body}=await generationReady(x);await archivedPrerequisite(x.f.taskId,disposition);
 const response=await call(x.f.caller,'POST',`${x.path}/${x.g.id}/consume`,body);expect(response.status).toBe(disposition==='completed'?200:409);
 expect((await pool.query('SELECT state FROM task_native_generations WHERE id=$1',[x.g.id])).rows[0].state).toBe(disposition==='completed'?'consumed':'reserved');
 expect((await pool.query('SELECT state,launch_key FROM task_native_executions WHERE id=$1',[r.row.id])).rows[0]).toEqual(disposition==='completed'?{state:'launch_authorized',launch_key:r.launchKey}:{state:'opened',launch_key:null});
});
test.each(['completed','abandoned',null])('archive disposition %s at publication intent must still be satisfied',async disposition=>{
 const y=await generationCompleted(),{x}=y;await archivedPrerequisite(x.f.taskId,disposition);
 const response=await call(x.f.caller,'POST',`${x.path}/${x.g.id}/publication-intent`,y.intent);expect(response.status).toBe(disposition==='completed'?200:409);
 const row=(await pool.query('SELECT state,publication_intent FROM task_native_generations WHERE id=$1',[x.g.id])).rows[0];expect(row.state).toBe('consumed');
 if(disposition!=='completed')expect(row.publication_intent).toBeNull();else expect(row.publication_intent.reportId).toBe(y.report);
});
test.each(['completed','abandoned',null])('archive disposition %s at joint finish is rechecked after saved intent',async disposition=>{
 const y=await generationCompleted(),{x}=y;expect((await call(x.f.caller,'POST',`${x.path}/${x.g.id}/publication-intent`,y.intent)).status).toBe(200);
 await archivedPrerequisite(x.f.taskId,disposition);
 const before=(await pool.query('SELECT COUNT(*)::int n FROM task_stream_entries WHERE task_id=$1',[x.f.taskId])).rows[0].n;
 const response=await call(x.f.caller,'POST',`/tasks/${x.f.taskId}/finish`,{reportId:y.report,handover:'Bound handover',nativeGeneration:y.nativeGeneration});expect(response.status).toBe(disposition==='completed'?200:409);
 expect((await pool.query('SELECT status FROM tasks WHERE id=$1',[x.f.taskId])).rows[0].status).toBe(disposition==='completed'?'review':'in-progress');
 expect((await pool.query('SELECT state FROM task_native_generations WHERE id=$1',[x.g.id])).rows[0].state).toBe(disposition==='completed'?'finished':'consumed');
 if(disposition!=='completed') {
  expect((await pool.query('SELECT COUNT(*)::int n FROM task_stream_entries WHERE task_id=$1',[x.f.taskId])).rows[0].n).toBe(before);
  expect((await pool.query('SELECT id FROM task_references WHERE task_id=$1',[x.f.taskId])).rowCount).toBe(0);
 }
});
async function publicationSnapshot(taskId:string,reportId?:string) {
 return {
 task:(await pool.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows,
 streams:(await pool.query('SELECT * FROM task_stream_entries WHERE task_id=$1 ORDER BY id',[taskId])).rows,
 references:(await pool.query('SELECT * FROM task_references WHERE task_id=$1 ORDER BY id',[taskId])).rows,
 reports:(await pool.query('SELECT * FROM reports WHERE $1=ANY(task_ids) OR id=$2 ORDER BY id',[taskId,reportId??null])).rows,
 generations:(await pool.query('SELECT * FROM task_native_generations WHERE task_id=$1 ORDER BY id',[taskId])).rows,
 executions:(await pool.query('SELECT * FROM task_native_executions WHERE task_id=$1 ORDER BY id',[taskId])).rows,
 quarantine:(await pool.query('SELECT * FROM task_native_import_quarantine WHERE task_id=$1 ORDER BY id',[taskId])).rows,
 feed:(await pool.query('SELECT COUNT(*)::int n FROM feed_events')).rows,
 };
}
test.each(['inline','existing'])('quarantined legacy %s Report finish rolls back every effect',async kind=>{
 const f=await fixture(),manifest=quarantineManifest(f.taskId);
 expect((await call(f.parent,'POST',`/tasks/${f.taskId}/native-executions/quarantine`,manifest)).status).toBe(200);
 let reportId:string|undefined;const title=tag();
 if(kind==='existing') reportId=(await pool.query('INSERT INTO reports(title,content,author_principal_id,task_ids) VALUES($1,$2,$3,$4) RETURNING id',[title,'Existing unaffected Report',f.caller.id,[]])).rows[0].id;
 const before=await publicationSnapshot(f.taskId,reportId);
 const body=kind==='inline'?{report:{title,content:'Rollback this exact inline Report'},handover:'Uncommitted handover'}:{reportId,handover:'Uncommitted handover'};
 const response=await call(f.caller,'POST',`/tasks/${f.taskId}/finish`,body);expect(response.status).toBe(409);expect(JSON.stringify(response.body)).toContain('NATIVE_GENERATION_IMPORT_HOLD');
 expect(await publicationSnapshot(f.taskId,reportId)).toEqual(before);
 if(kind==='inline')expect((await pool.query('SELECT id FROM reports WHERE title=$1',[title])).rowCount).toBe(0);
});
test('nonquarantined no-generation inline legacy finish remains compatible',async()=>{
 const f=await fixture();const response=await call(f.caller,'POST',`/tasks/${f.taskId}/finish`,{report:{title:tag(),content:'Supported legacy completion'},handover:'Legacy handover'});
 expect(response.status).toBe(200);expect((await pool.query('SELECT status FROM tasks WHERE id=$1',[f.taskId])).rows[0].status).toBe('review');
 expect((await pool.query('SELECT id FROM task_native_generations WHERE task_id=$1',[f.taskId])).rowCount).toBe(0);
});

test.each(['completed','abandoned',null])('reserve uses exact archived %s semantic predicate before burn',async disposition=>{
 const f=await fixture();await pool.query("UPDATE tasks SET status='todo',owner_principal_id=NULL,auto_start=true WHERE id=$1",[f.taskId]);await archivedPrerequisite(f.taskId,disposition);
 const epoch=(await pool.query('SELECT epoch FROM task_native_assignment_epochs WHERE task_id=$1',[f.taskId])).rows[0].epoch;
 const input={schemaVersion:2,deploymentId:process.env.RELAYHALL_DEPLOYMENT_ID,requestKey:crypto.randomUUID(),assignmentEpoch:String(epoch),serviceId:f.serviceId,descriptorVersion:1,workerInstanceId:crypto.randomUUID(),workerToken:crypto.randomBytes(32).toString('hex'),sourceSha256:'a'.repeat(64),inputSha256:'b'.repeat(64),budgetSeconds:540,predecessorExecutionId:null,reviewAttemptId:null};
 const response=await call(f.caller,'POST',`/tasks/${f.taskId}/native-executions/generations`,input);expect(response.status).toBe(disposition==='completed'?200:409);
 expect((await pool.query('SELECT id FROM task_native_generations WHERE task_id=$1',[f.taskId])).rowCount).toBe(disposition==='completed'?1:0);
});

test('unbound deployment refuses versioned reservation with no generation write',async()=>{
 const f=await fixture();await pool.query("UPDATE tasks SET status='todo',owner_principal_id=NULL,auto_start=true WHERE id=$1",[f.taskId]);
 const epoch=(await pool.query('SELECT epoch FROM task_native_assignment_epochs WHERE task_id=$1',[f.taskId])).rows[0].epoch;
 const saved=process.env.RELAYHALL_DEPLOYMENT_ID;
 const input={schemaVersion:2,deploymentId:'11111111-1111-4111-8111-111111111111',requestKey:crypto.randomUUID(),assignmentEpoch:String(epoch),serviceId:f.serviceId,descriptorVersion:1,workerInstanceId:crypto.randomUUID(),workerToken:crypto.randomBytes(32).toString('hex'),sourceSha256:'a'.repeat(64),inputSha256:'b'.repeat(64),budgetSeconds:540,predecessorExecutionId:null,reviewAttemptId:null};
 try{delete process.env.RELAYHALL_DEPLOYMENT_ID;expect((await call(f.caller,'POST',`/tasks/${f.taskId}/native-executions/generations`,input)).status).toBe(409);
  expect((await pool.query('SELECT id FROM task_native_generations WHERE task_id=$1',[f.taskId])).rows).toEqual([]);
 }finally{if(saved===undefined)delete process.env.RELAYHALL_DEPLOYMENT_ID;else process.env.RELAYHALL_DEPLOYMENT_ID=saved;}
});
async function narrowNativeTask(f:Fixture, taskVerbs:string[]=['read']) {
 await pool.query('UPDATE principals SET own_expression=$2 WHERE id=$1',[f.caller.id,JSON.stringify({scopes:'parent',objects:[
  {resourceType:'service',selectorForm:'exact',selectorIds:[f.serviceId],verbs:['invoke']},
  {resourceType:'task',selectorForm:'exact',selectorIds:[f.taskId],verbs:taskVerbs}
 ]})]);
}
async function nativeLedger(f:Fixture) {
 const value:any={};
 for(const table of ['task_native_executions','task_native_generations','task_stream_entries','task_references']) {
  const column='task_id';
  value[table]=(await pool.query(`SELECT * FROM ${table} WHERE ${column}=$1 ORDER BY id`,[f.taskId])).rows;
 }
 value.task=(await pool.query('SELECT * FROM tasks WHERE id=$1',[f.taskId])).rows;
 return value;
}
test.each(['authorize-launch','heartbeat','attest','close','cancel','reconcile'])('native explicit Task READ ceiling refuses fresh %s without ledger effects',async action=>{
 const f=await fixture(),r=await opened(f);
 if(action!=='authorize-launch'&&action!=='cancel')await launch(f,r);
 await narrowNativeTask(f);const before=await nativeLedger(f);
 const body=action==='authorize-launch'?{leaseToken:r.leaseToken,launchKey:r.launchKey}:action==='attest'?{leaseToken:r.leaseToken,slotId:crypto.randomUUID(),relationship:'primary',correlation:{session_id:'no-cap-session'}}:action==='close'?{leaseToken:r.leaseToken,outcome:'failed'}:action==='reconcile'?{launchKey:r.launchKey,intentDigest:'a'.repeat(64),processIdentityDigest:'b'.repeat(64),treeAbsent:true,stoppedAt:new Date().toISOString()}:action==='cancel'?{}:{leaseToken:r.leaseToken};
 expect((await call(f.caller,'POST',`${r.path}/${r.row.id}/${action}`,body)).status).toBe(403);
 expect(await nativeLedger(f)).toEqual(before);
 expect((await call(f.caller,'GET',r.path)).status).toBe(200);
});
test('native explicit Task READ ceiling refuses new open before ordinal allocation',async()=>{
 const f=await fixture();await narrowNativeTask(f);const before=await nativeLedger(f);
 const epoch=(await pool.query('SELECT epoch FROM task_native_assignment_epochs WHERE task_id=$1',[f.taskId])).rows[0].epoch;
 expect((await call(f.caller,'POST',`/tasks/${f.taskId}/native-executions`,{dispatchKey:crypto.randomUUID(),assignmentEpoch:String(epoch),serviceId:f.serviceId,descriptorVersion:1,leaseToken:crypto.randomBytes(32).toString('hex'),budgetSeconds:540})).status).toBe(403);
 expect(await nativeLedger(f)).toEqual(before);
});
test('preclaim reserve requires explicit Task WRITE ceiling but unchanged readback is evidence only',async()=>{
 const x=await generationFixture();await narrowNativeTask(x.f);const before=await nativeLedger(x.f);
 expect((await call(x.f.caller,'POST',x.path,{...x.input,requestKey:crypto.randomUUID()})).status).toBe(403);
 expect(await nativeLedger(x.f)).toEqual(before);
 const retry=await call(x.f.caller,'POST',x.path,x.input);expect(retry.status).toBe(200);expect(retry.body.result.launchPermit).toBe(false);
 expect((await call(x.f.caller,'GET',x.path+'/'+x.g.id)).body.result.launchPermit).toBe(false);
});
test('consume denied by current explicit cap leaves both ledgers and burn unchanged',async()=>{
 const x=await generationFixture(),{body}=await generationReady(x);await narrowNativeTask(x.f);const before=await nativeLedger(x.f);
 expect((await call(x.f.caller,'POST',`${x.path}/${x.g.id}/consume`,body)).status).toBe(403);expect(await nativeLedger(x.f)).toEqual(before);
});
test('already consumed exact retry remains evidence-only after explicit write cap narrows',async()=>{
 const x=await generationFixture(),{body}=await generationReady(x);
 expect((await call(x.f.caller,'POST',`${x.path}/${x.g.id}/consume`,body)).body.result.freshConsume).toBe(true);
 await narrowNativeTask(x.f);const before=await nativeLedger(x.f),retry=await call(x.f.caller,'POST',`${x.path}/${x.g.id}/consume`,body);
 expect(retry.status).toBe(200);expect(retry.body.result.freshConsume).toBe(false);expect(retry.body.result.launchPermit).toBe(false);expect(await nativeLedger(x.f)).toEqual(before);
});
test.each(['publication','finish'])('native current explicit WRITE ceiling refuses %s all-or-nothing',async action=>{
 const y=await generationCompleted(),{x}=y;
 if(action==='finish')expect((await call(x.f.caller,'POST',`${x.path}/${x.g.id}/publication-intent`,y.intent)).status).toBe(200);
 await narrowNativeTask(x.f);const before=await nativeLedger(x.f);
 const response=action==='publication'?await call(x.f.caller,'POST',`${x.path}/${x.g.id}/publication-intent`,y.intent):await call(x.f.caller,'POST',`/tasks/${x.f.taskId}/finish`,{reportId:y.report,handover:'Forbidden cap must not hand off',nativeGeneration:y.nativeGeneration});
 expect(response.status).toBe(403);expect(await nativeLedger(x.f)).toEqual(before);
});
test.each(['exact','all-of-type','all-except','all-in-project'])('native explicit %s WRITE cap preserves authorized open',async selectorForm=>{
 const f=await fixture();let projectId:string|null=null;
 if(selectorForm==='all-in-project'){projectId=(await pool.query("INSERT INTO projects(name) VALUES($1) RETURNING id",[tag()])).rows[0].id;await pool.query('UPDATE tasks SET project_id=$2 WHERE id=$1',[f.taskId,projectId]);}
 await pool.query('UPDATE principals SET own_expression=$2 WHERE id=$1',[f.caller.id,JSON.stringify({scopes:'parent',objects:[{resourceType:'service',selectorForm:'exact',selectorIds:[f.serviceId],verbs:['invoke']},{resourceType:'task',selectorForm,selectorIds:selectorForm==='exact'?[f.taskId]:selectorForm==='all-in-project'?[projectId]:selectorForm==='all-except'?[crypto.randomUUID()]:[],verbs:['write']} ]})]);
 await opened(f);
});

test('native exact task-bound Agent cannot bypass narrowed Connector ancestor WRITE cap',async()=>{
 const f=await fixture();const agent=(await pool.query(`INSERT INTO principals(kind,handle,display_name,status,parent_principal_id,bound_task_id,purpose,own_expression) VALUES('agent',$1,$1,'active',$2,$3,'native cap test',$4) RETURNING id`,[tag(),f.caller.id,f.taskId,JSON.stringify({scopes:'parent',objects:'parent'})])).rows[0].id;
 await pool.query('UPDATE tasks SET owner_principal_id=$2 WHERE id=$1',[f.taskId,agent]);
 const issued=await principalService.issueCredential({principalId:agent,scopes:f.scopes,transport:'any'},{handle:'native-cap-fixture',authMethod:'system'});
 const child={...f,caller:{id:agent,headers:{Authorization:`Bearer ${issued.fullKey}`}}};const r=await opened(child);await launch(child,r);
 await narrowNativeTask(f);const before=await nativeLedger(child);
 expect((await call(child.caller,'POST',`${r.path}/${r.row.id}/heartbeat`,{leaseToken:r.leaseToken})).status).toBe(403);expect(await nativeLedger(child)).toEqual(before);
});
test.each(['scope','expiry','grace','own-cap'])('native Task-lock wait uses fresh %s not transaction-start authority',async change=>{
 const f=await fixture(),r=await opened(f);await launch(f,r);const before=await nativeLedger(f),c=await pool.connect();await c.query('BEGIN');await c.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[f.taskId]);
 const pending=call(f.caller,'POST',`${r.path}/${r.row.id}/heartbeat`,{leaseToken:r.leaseToken});
 try {
  let blocked=false;for(let i=0;i<100;i++){if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT * FROM tasks WHERE id=%' LIMIT 1")).rowCount){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}expect(blocked).toBe(true);
  if(change==='scope')await pool.query('UPDATE principal_credentials SET scopes=$2 WHERE principal_id=$1',[f.caller.id,JSON.stringify(['tasks:read','services:read','services:invoke'])]);
  if(change==='expiry'||change==='grace'){const column=change==='expiry'?'expires_at':'grace_until';await pool.query(`UPDATE principal_credentials SET ${column}=clock_timestamp()+interval '0.1 second' WHERE principal_id=$1`,[f.caller.id]);await new Promise(resolve=>setTimeout(resolve,150));}
  if(change==='own-cap')await narrowNativeTask(f);
  await c.query('COMMIT');expect((await pending).status).toBe(403);expect(await nativeLedger(f)).toEqual(before);
 }finally{await c.query('ROLLBACK');c.release();}
});

// Combined actual producer -> immutable generation publication -> scoped handoff.
test('actual task-report save joins consumed native generation in one finish transaction',async()=>{
 const y=await generationCompleted(true),{x}=y;
 expect((await call(x.f.caller,'POST',`${x.path}/${x.g.id}/publication-intent`,y.intent)).status).toBe(200);
 const finished=await call(x.f.caller,'POST',`/tasks/${x.f.taskId}/finish`,{reportId:y.report,handover:'Actual joined output',nativeGeneration:y.nativeGeneration});expect(finished.status).toBe(200);
 expect((await pool.query('SELECT state FROM task_native_generations WHERE id=$1',[x.g.id])).rows[0].state).toBe('finished');
 expect((await pool.query('SELECT status FROM tasks WHERE id=$1',[x.f.taskId])).rows[0].status).toBe('review');
 expect((await pool.query('SELECT report_id FROM task_report_operations WHERE task_id=$1',[x.f.taskId])).rows[0].report_id).toBe(y.report);
});

test.each([['presented','expires_at'],['presented','grace_until'],['ancestor','expires_at'],['ancestor','grace_until']])('independent natural %s %s after actual Task lock wait preserves fresh chain authority',async(target,column)=>{
 const f=await fixture();let current=f;
 if(target==='ancestor') {
  const agent=(await pool.query("INSERT INTO principals(kind,handle,status,parent_principal_id,purpose,own_expression,bound_task_id) VALUES('agent',$1,'active',$2,'Independent expiry agent',$3,$4) RETURNING id",[tag(),f.caller.id,JSON.stringify({scopes:'parent',objects:'parent'}),f.taskId])).rows[0].id;
  const key=await principalService.issueCredential({principalId:agent,scopes:f.scopes,transport:'any'},{handle:'independent-expiry-fixture',authMethod:'system'});
  await pool.query('UPDATE tasks SET owner_principal_id=$2 WHERE id=$1',[f.taskId,agent]);
  current={...f,caller:{id:agent,headers:{Authorization:'Bearer '+key.fullKey}}};
 } else {
  await principalService.issueCredential({principalId:f.caller.id,scopes:f.scopes,transport:'any'},{handle:'independent-expiry-fixture',authMethod:'system'});
 }
 const r=await opened(current);await launch(current,r);
 const before=await nativeLedger(current),lock=await pool.connect();await lock.query('BEGIN');await lock.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[f.taskId]);
 const pid=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 const pending=call(current.caller,'POST',r.path+'/'+r.row.id+'/heartbeat',{leaseToken:r.leaseToken});
 try {
  let blocked=false;for(let i=0;i<100;i++){if((await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows.length){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
  expect(blocked).toBe(true);
  const selector=target==='ancestor'?'principal_id':'id';const id=target==='ancestor'?f.caller.id:f.issued.credentialId;
  await pool.query('UPDATE principal_credentials SET '+column+"=clock_timestamp()+interval '150 milliseconds' WHERE "+selector+'=$1',[id]);
  await pool.query('SELECT pg_sleep(0.25)');
  expect((await pool.query('SELECT bool_and('+column+'<clock_timestamp()) elapsed FROM principal_credentials WHERE '+selector+'=$1',[id])).rows[0].elapsed).toBe(true);
  await lock.query('COMMIT');const response=await pending;const after=await nativeLedger(current);
  console.log('INDEPENDENT_NATIVE_CHAIN_CLOCK',JSON.stringify({target,column,status:response.status,code:response.body.code,changed:JSON.stringify(before)!==JSON.stringify(after),beforeLease:before.task_native_executions[0].lease_expires_at,afterLease:after.task_native_executions[0].lease_expires_at}));
  expect(response.status).toBe(403);expect(after).toEqual(before);
 }finally{await lock.query('ROLLBACK');lock.release();await pending;}
});

test.each(['expires_at','grace_until'])('native ancestor %s expiry preserves other live-key authority',async column=>{
 const f=await fixture();const agent=(await pool.query("INSERT INTO principals(kind,handle,status,parent_principal_id,purpose,own_expression,bound_task_id) VALUES('agent',$1,'active',$2,'Other-live-key control',$3,$4) RETURNING id",[tag(),f.caller.id,JSON.stringify({scopes:'parent',objects:'parent'}),f.taskId])).rows[0].id;
 const key=await principalService.issueCredential({principalId:agent,scopes:f.scopes,transport:'any'},{handle:'clock-control',authMethod:'system'});await principalService.issueCredential({principalId:f.caller.id,scopes:f.scopes,transport:'any'},{handle:'clock-control',authMethod:'system'});
 await pool.query('UPDATE tasks SET owner_principal_id=$2 WHERE id=$1',[f.taskId,agent]);const child={...f,caller:{id:agent,headers:{Authorization:'Bearer '+key.fullKey}}},r=await opened(child);await launch(child,r);
 const c=await pool.connect();await c.query('BEGIN');await c.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[f.taskId]);const pid=(await c.query('SELECT pg_backend_pid() pid')).rows[0].pid;const pending=call(child.caller,'POST',`${r.path}/${r.row.id}/heartbeat`,{leaseToken:r.leaseToken});
 try{let blocked=false;for(let i=0;i<100;i++){if((await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rowCount){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}expect(blocked).toBe(true);await pool.query('UPDATE principal_credentials SET '+column+"=clock_timestamp()+interval '100 milliseconds' WHERE id=$1",[f.issued.credentialId]);await pool.query('SELECT pg_sleep(0.2)');await c.query('COMMIT');expect((await pending).status).toBe(200);}
 finally{await c.query('ROLLBACK');c.release();await pending;}
});

test.each(['presented','ancestor'])('independent later descriptor wait cannot outlive %s credential authority',async target=>{
 const f=await fixture();let current=f;
 if(target==='ancestor'){
  const agent=(await pool.query("INSERT INTO principals(kind,handle,status,parent_principal_id,purpose,own_expression,bound_task_id) VALUES('agent',$1,'active',$2,'Independent later-lock agent',$3,$4) RETURNING id",[tag(),f.caller.id,JSON.stringify({scopes:'parent',objects:'parent'}),f.taskId])).rows[0].id;
  const key=await principalService.issueCredential({principalId:agent,scopes:f.scopes,transport:'any'},{handle:'independent-later-lock-fixture',authMethod:'system'});
  await pool.query('UPDATE tasks SET owner_principal_id=$2 WHERE id=$1',[f.taskId,agent]);
  current={...f,caller:{id:agent,headers:{Authorization:'Bearer '+key.fullKey}}};
 }else await principalService.issueCredential({principalId:f.caller.id,scopes:f.scopes,transport:'any'},{handle:'independent-later-lock-fixture',authMethod:'system'});
 const r=await opened(current);await launch(current,r);
 const before=await nativeLedger(current),lock=await pool.connect();await lock.query('BEGIN');
 await lock.query('SELECT service_id FROM service_descriptor_versions WHERE service_id=$1 AND version=1 FOR UPDATE',[f.serviceId]);
 const pid=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 const pending=call(current.caller,'POST',r.path+'/'+r.row.id+'/heartbeat',{leaseToken:r.leaseToken});
 try {
  let blocked=false;for(let i=0;i<100;i++){if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%FOR SHARE OF s,d%'",[pid])).rows.length){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
  expect(blocked).toBe(true);
  const selector=target==='ancestor'?'principal_id':'id',id=target==='ancestor'?f.caller.id:f.issued.credentialId;
  await pool.query("UPDATE principal_credentials SET expires_at=clock_timestamp()+interval '150 milliseconds' WHERE "+selector+"=$1",[id]);
  await pool.query('SELECT pg_sleep(0.25)');
  expect((await pool.query('SELECT bool_and(expires_at<clock_timestamp()) elapsed FROM principal_credentials WHERE '+selector+'=$1',[id])).rows[0].elapsed).toBe(true);
  await lock.query('COMMIT');const response=await pending,after=await nativeLedger(current);
  console.log('INDEPENDENT_NATIVE_LATER_LOCK',JSON.stringify({target,status:response.status,changed:JSON.stringify(before)!==JSON.stringify(after),beforeLease:before.task_native_executions[0].lease_expires_at,afterLease:after.task_native_executions[0].lease_expires_at}));
  expect(response.status).toBe(403);expect(after).toEqual(before);
 }finally{await lock.query('ROLLBACK');lock.release();await pending;}
});

test.each(['grace','scope','cap','service-cap','revoked'])('native later descriptor wait uses fresh %s authority',async change=>{
 const target=String('presented');
 const f=await fixture();let current=f;
 if(target==='ancestor'){
  const agent=(await pool.query("INSERT INTO principals(kind,handle,status,parent_principal_id,purpose,own_expression,bound_task_id) VALUES('agent',$1,'active',$2,'Independent later-lock agent',$3,$4) RETURNING id",[tag(),f.caller.id,JSON.stringify({scopes:'parent',objects:'parent'}),f.taskId])).rows[0].id;
  const key=await principalService.issueCredential({principalId:agent,scopes:f.scopes,transport:'any'},{handle:'independent-later-lock-fixture',authMethod:'system'});
  await pool.query('UPDATE tasks SET owner_principal_id=$2 WHERE id=$1',[f.taskId,agent]);
  current={...f,caller:{id:agent,headers:{Authorization:'Bearer '+key.fullKey}}};
 }else await principalService.issueCredential({principalId:f.caller.id,scopes:f.scopes,transport:'any'},{handle:'independent-later-lock-fixture',authMethod:'system'});
 const r=await opened(current);await launch(current,r);
 const before=await nativeLedger(current),lock=await pool.connect();await lock.query('BEGIN');
 await lock.query('SELECT service_id FROM service_descriptor_versions WHERE service_id=$1 AND version=1 FOR UPDATE',[f.serviceId]);
 const pid=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 const pending=call(current.caller,'POST',r.path+'/'+r.row.id+'/heartbeat',{leaseToken:r.leaseToken});
 try {
  let blocked=false;for(let i=0;i<100;i++){if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%FOR SHARE OF s,d%'",[pid])).rows.length){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
  expect(blocked).toBe(true);
  const id=f.issued.credentialId;
  if(change==='grace')await pool.query("UPDATE principal_credentials SET grace_until=clock_timestamp()+interval '150 milliseconds' WHERE id=$1",[id]);
  if(change==='scope')await pool.query('UPDATE principal_credentials SET scopes=$2 WHERE id=$1',[id,JSON.stringify(['tasks:read','services:read','services:invoke'])]);
  if(change==='cap')await narrowNativeTask(f);
  if(change==='revoked')await pool.query('UPDATE principal_credentials SET revoked_at=clock_timestamp() WHERE id=$1',[id]);
  if(change==='service-cap')await pool.query('UPDATE principals SET own_expression=$2 WHERE id=$1',[f.caller.id,JSON.stringify({scopes:'parent',objects:[{resourceType:'task',selectorForm:'exact',selectorIds:[f.taskId],verbs:['write']},{resourceType:'service',selectorForm:'exact',selectorIds:[f.serviceId],verbs:['read']}]})]);
  await pool.query('SELECT pg_sleep(0.25)');
  if(change==='grace')expect((await pool.query('SELECT grace_until<clock_timestamp() elapsed FROM principal_credentials WHERE id=$1',[id])).rows[0].elapsed).toBe(true);
  await lock.query('COMMIT');const response=await pending,after=await nativeLedger(current);
  console.log('INDEPENDENT_NATIVE_LATER_LOCK',JSON.stringify({target,status:response.status,changed:JSON.stringify(before)!==JSON.stringify(after),beforeLease:before.task_native_executions[0].lease_expires_at,afterLease:after.task_native_executions[0].lease_expires_at}));
  expect(response.status).toBe(403);expect(after).toEqual(before);
 }finally{await lock.query('ROLLBACK');lock.release();await pending;}
});

test.each([['intent','expires_at'],['intent','grace_until'],['finish','expires_at'],['finish','grace_until']])('native generation %s Report lock requires current %s authority',async(phase,column)=>{
 const y=await generationCompleted(),{x}=y;
 if(phase==='finish')expect((await call(x.f.caller,'POST',`${x.path}/${x.g.id}/publication-intent`,y.intent)).status).toBe(200);
 await principalService.issueCredential({principalId:x.f.caller.id,scopes:x.f.scopes,transport:'any'},{handle:'report-lock-control',authMethod:'system'});
 const before=await nativeLedger(x.f),taskBefore=(await pool.query('SELECT status FROM tasks WHERE id=$1',[x.f.taskId])).rows,streamBefore=(await pool.query('SELECT count(*) FROM task_stream_entries WHERE task_id=$1',[x.f.taskId])).rows;
 const lock=await pool.connect();await lock.query('BEGIN');await lock.query('SELECT id FROM reports WHERE id=$1 FOR UPDATE',[y.report]);const pid=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 const pending=phase==='intent'?call(x.f.caller,'POST',`${x.path}/${x.g.id}/publication-intent`,y.intent):call(x.f.caller,'POST',`/tasks/${x.f.taskId}/finish`,{reportId:y.report,handover:'Bound expiry refusal',nativeGeneration:y.nativeGeneration});
 try{let blocked=false;for(let i=0;i<100;i++){if((await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rowCount){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}expect(blocked).toBe(true);
 await pool.query('UPDATE principal_credentials SET '+column+"=clock_timestamp()+interval '100 milliseconds' WHERE id=$1",[x.f.issued.credentialId]);await pool.query('SELECT pg_sleep(0.2)');await lock.query('COMMIT');expect((await pending).status).toBe(403);expect(await nativeLedger(x.f)).toEqual(before);expect((await pool.query('SELECT status FROM tasks WHERE id=$1',[x.f.taskId])).rows).toEqual(taskBefore);expect((await pool.query('SELECT count(*) FROM task_stream_entries WHERE task_id=$1',[x.f.taskId])).rows).toEqual(streamBefore);
 }finally{await lock.query('ROLLBACK');lock.release();await pending;}
});

test.each(['expires_at','grace_until','scope','cap'])('native preclaim descriptor wait requires fresh %s authority before burn',async change=>{
 const f=await fixture();await pool.query("UPDATE tasks SET status='todo',owner_principal_id=NULL,auto_start=true WHERE id=$1",[f.taskId]);
 const epoch=(await pool.query('SELECT epoch FROM task_native_assignment_epochs WHERE task_id=$1',[f.taskId])).rows[0].epoch;
 const input={schemaVersion:2,deploymentId:process.env.RELAYHALL_DEPLOYMENT_ID,requestKey:crypto.randomUUID(),assignmentEpoch:String(epoch),serviceId:f.serviceId,descriptorVersion:1,workerInstanceId:crypto.randomUUID(),workerToken:crypto.randomBytes(32).toString('hex'),sourceSha256:'a'.repeat(64),inputSha256:'b'.repeat(64),budgetSeconds:540,predecessorExecutionId:null,reviewAttemptId:null};
 const before=await nativeLedger(f),lock=await pool.connect();await lock.query('BEGIN');await lock.query('SELECT service_id FROM service_descriptor_versions WHERE service_id=$1 AND version=1 FOR UPDATE',[f.serviceId]);const pid=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 const pending=call(f.caller,'POST',`/tasks/${f.taskId}/native-executions/generations`,input);
 try{let blocked=false;for(let i=0;i<100;i++){if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%FOR SHARE OF s,d%'",[pid])).rowCount){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}expect(blocked).toBe(true);
 if(change==='expires_at'||change==='grace_until'){await pool.query('UPDATE principal_credentials SET '+change+"=clock_timestamp()+interval '100 milliseconds' WHERE id=$1",[f.issued.credentialId]);await pool.query('SELECT pg_sleep(0.2)');}
 if(change==='scope')await pool.query('UPDATE principal_credentials SET scopes=$2 WHERE id=$1',[f.issued.credentialId,JSON.stringify(['tasks:read','services:read','services:invoke'])]);
 if(change==='cap')await narrowNativeTask(f);
 await lock.query('COMMIT');expect([403,409]).toContain((await pending).status);expect(await nativeLedger(f)).toEqual(before);
 }finally{await lock.query('ROLLBACK');lock.release();await pending;}
});
