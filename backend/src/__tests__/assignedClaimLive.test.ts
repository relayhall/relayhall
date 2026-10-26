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
beforeAll(async()=>{
  // Schema-only disposable clones need the migration 062/084 fallback identity.
  // No credential is minted; this is never the caller or grant recipient.
  await pool.query("INSERT INTO principals(kind,handle,display_name,role) VALUES('human','dashboard_user','Owner','orchestrator') ON CONFLICT(handle) DO NOTHING");
  const app=express();app.use(express.json());
  registerProtectedRoutes((mount:string,...handlers:any[])=>app.use(mount,authMiddleware,sharedAuthorizationMiddleware,...handlers));app.use(apiErrorHandler);
  await new Promise<void>(resolve=>{server=app.listen(0,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();});

async function assigned() {
  const parent=await human('user'),verifier=await human('user');
  const own={scopes:'parent',objects:'parent'};
  const principal=(await pool.query(`INSERT INTO principals(kind,handle,status,parent_principal_id,purpose,own_expression)
    VALUES('service',$1,'active',$2,'Assigned claim fixture',$3) RETURNING id`,[tag(),parent.id,JSON.stringify(own)])).rows[0].id;
  const serviceId=crypto.randomUUID();
  await pool.query(`INSERT INTO services(id,slug,name,kind,status,principal_id,current_descriptor_version)
    VALUES($1,$2,$2,'connector','published',$3,1)`,[serviceId,tag(),principal]);
  await pool.query(`INSERT INTO service_descriptor_versions(service_id,version,descriptor,content_hash)
    VALUES($1,1,'{"options":[]}'::jsonb,$2)`,[serviceId,'a'.repeat(64)]);
  const profile={serviceId,descriptorVersion:1,options:{}};
  const taskId=(await pool.query(`INSERT INTO tasks(title,status,auto_start,visibility,creator_principal_id,shepherd_principal_id,
    verifier_principal_id,execution_service_id,execution_descriptor_version,execution_profile)
    VALUES($1,'todo',true,'private',$2,$2,$3,$4,1,$5) RETURNING id`,[tag(),parent.id,verifier.id,serviceId,JSON.stringify(profile)])).rows[0].id;
  // The READ-only assignment vehicle is modeled explicitly; it supplies no WRITE.
  await pool.query(`INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id) VALUES('principal',$1,'task',$2,'read',$3)`,[parent.id,taskId,parent.id]);
  const issued=await principalService.issueCredential({principalId:principal,scopes:['tasks:read','tasks:write'],transport:'any'},{handle:'fixture',authMethod:'system'});
  const caller={id:principal,headers:{Authorization:`Bearer ${issued.fullKey}`}};
  const epoch=(await pool.query('SELECT epoch::text FROM task_native_assignment_epochs WHERE task_id=$1',[taskId])).rows[0].epoch;
  return {parent,verifier,caller,serviceId,taskId,issued,epoch,profile};
}
async function claim(f:any,epoch=f.epoch) {return call(f.caller,'POST',`/tasks/${f.taskId}/claim`,{expectedAssignmentEpoch:epoch});}
async function unchanged(f:any) {expect((await pool.query('SELECT owner_principal_id FROM tasks WHERE id=$1',[f.taskId])).rows[0].owner_principal_id).toBeNull();}
test('assigned Connector admission is claim-only, epoch-bound and retry has zero effects',async()=>{
  const f=await assigned(),view=await call(f.caller,'GET',`/tasks/${f.taskId}`);
  expect(view.status).toBe(200);expect(view.body.task.lifecycleAccess.claim).toEqual({allowed:true,reason:null,expectedAssignmentEpoch:f.epoch});
  expect(view.body.task.lifecycleAccess.arm.allowed).toBe(false);
  expect((await call(f.caller,'PATCH',`/tasks/${f.taskId}`,{autoStart:false})).status).toBe(403);
  expect((await call(f.caller,'POST',`/tasks/${f.taskId}/claim`,{})).status).toBe(403);
  expect((await claim(f)).status).toBe(200);
  const before=(await pool.query('SELECT t.*,e.epoch FROM tasks t JOIN task_native_assignment_epochs e ON e.task_id=t.id WHERE t.id=$1',[f.taskId])).rows;
  const events=(await pool.query(`SELECT COUNT(*)::int AS n FROM feed_events WHERE object_id=$1 AND name='task.updated'`,[f.taskId])).rows[0].n;
  expect((await claim(f)).status).toBe(200);
  expect((await pool.query('SELECT t.*,e.epoch FROM tasks t JOIN task_native_assignment_epochs e ON e.task_id=t.id WHERE t.id=$1',[f.taskId])).rows).toEqual(before);
  expect((await pool.query(`SELECT COUNT(*)::int AS n FROM feed_events WHERE object_id=$1 AND name='task.updated'`,[f.taskId])).rows[0].n).toBe(events);
  expect((await pool.query('SELECT id FROM task_native_executions WHERE task_id=$1',[f.taskId])).rows).toEqual([]);
});
test.each(['unarmed','review','completed','inactive-verifier','self-verifier','service-retired','descriptor-retired','profile-mismatch','credential-revoked','scope-read','own-none','own-read','own-other','own-except','parent-inactive','uncompleted-dependency'])('%s refuses with no owner',async mode=>{
  const f=await assigned();
  if(mode==='unarmed') await pool.query('UPDATE tasks SET auto_start=false WHERE id=$1',[f.taskId]);
  if(mode==='review'||mode==='completed') await pool.query('UPDATE tasks SET status=$2 WHERE id=$1',[f.taskId,mode]);
  if(mode==='inactive-verifier') await pool.query("UPDATE principals SET status='disabled' WHERE id=$1",[f.verifier.id]);
  if(mode==='self-verifier') await pool.query('UPDATE tasks SET verifier_principal_id=$2 WHERE id=$1',[f.taskId,f.caller.id]);
  if(mode==='service-retired') await pool.query("UPDATE services SET status='retired',retired_at=NOW() WHERE id=$1",[f.serviceId]);
  if(mode==='descriptor-retired') await pool.query('UPDATE service_descriptor_versions SET retired_at=NOW() WHERE service_id=$1',[f.serviceId]);
  if(mode==='profile-mismatch') await pool.query('UPDATE tasks SET execution_profile=$2 WHERE id=$1',[f.taskId,JSON.stringify({...f.profile,descriptorVersion:2})]);
  if(mode==='credential-revoked') await pool.query('UPDATE principal_credentials SET revoked_at=NOW() WHERE id=$1',[f.issued.credentialId]);
  if(mode==='scope-read') await pool.query("UPDATE principal_credentials SET scopes='[\"tasks:read\"]'::jsonb WHERE id=$1",[f.issued.credentialId]);
  if(mode.startsWith('own-')) {
    const objects=mode==='own-none'?[]:[{resourceType:'task',selectorForm:mode==='own-except'?'all-except':'exact',selectorIds:[mode==='own-other'?crypto.randomUUID():f.taskId],verbs:[mode==='own-read'?'read':'write']}];
    await pool.query('UPDATE principals SET own_expression=$2 WHERE id=$1',[f.caller.id,JSON.stringify({scopes:'parent',objects})]);
  }
  if(mode==='parent-inactive') await pool.query("UPDATE principals SET status='disabled' WHERE id=$1",[f.parent.id]);
  if(mode==='uncompleted-dependency') {const d=(await pool.query("INSERT INTO tasks(title,status) VALUES($1,'todo') RETURNING id",[tag()])).rows[0].id;await pool.query('INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES($1,$2)',[f.taskId,d]);}
  expect((await claim(f)).status).toBeGreaterThanOrEqual(400);await unchanged(f);
});
test.each(['exact','all-of-type','all-except','all-in-project'])('positive explicit %s Task cap is honored',async form=>{
  const f=await assigned();let ids:string[]=[f.taskId];
  if(form==='all-of-type') ids=[];
  if(form==='all-except') ids=[crypto.randomUUID()];
  if(form==='all-in-project') {const project=(await pool.query("INSERT INTO projects(name,description) VALUES($1,'') RETURNING id",[tag()])).rows[0].id;await pool.query('UPDATE tasks SET project_id=$2 WHERE id=$1',[f.taskId,project]);ids=[project];}
  await pool.query('UPDATE principals SET own_expression=$2 WHERE id=$1',[f.caller.id,JSON.stringify({scopes:'parent',objects:[{resourceType:'task',selectorForm:form,selectorIds:ids,verbs:['write']}]})]);
  const view=await call(f.caller,'GET',`/tasks/${f.taskId}`);
  expect(view.status).toBe(200);expect(view.body.task.lifecycleAccess.claim.expectedAssignmentEpoch).toBe(f.epoch);
  expect((await claim(f)).status).toBe(200);
});
test('release/assignment ABA cannot reacquire with the old epoch',async()=>{
  const f=await assigned();expect((await claim(f)).status).toBe(200);
  await pool.query('UPDATE tasks SET owner_principal_id=NULL WHERE id=$1',[f.taskId]);
  const r=await claim(f);expect(r.status).toBe(409);expect(r.body.code).toBe('TASK_ASSIGNMENT_EPOCH_MISMATCH');await unchanged(f);
  const epoch=(await pool.query('SELECT epoch::text FROM task_native_assignment_epochs WHERE task_id=$1',[f.taskId])).rows[0].epoch;
  expect((await claim(f,epoch)).status).toBe(200);
});
test('competing request claims serialize to one epoch/event',async()=>{
  const f=await assigned();const n=(await pool.query(`SELECT COUNT(*)::int AS n FROM feed_events WHERE object_id=$1 AND name='task.updated'`,[f.taskId])).rows[0].n;const results=await Promise.all([claim(f),claim(f)]);expect(results.map(r=>r.status)).toEqual([200,200]);
  expect((await pool.query('SELECT epoch::text FROM task_native_assignment_epochs WHERE task_id=$1',[f.taskId])).rows[0].epoch).toBe(String(BigInt(f.epoch)+1n));
  expect((await pool.query(`SELECT COUNT(*)::int AS n FROM feed_events WHERE object_id=$1 AND name='task.updated'`,[f.taskId])).rows[0].n).toBe(n+1);
});
test.each(['own-objects','own-scope','credential','parent-status','descriptor','epoch-ABA','credential-scope','credential-expiry','account-role','service','verifier','dependency-null'])('fresh %s refusal after actual Task lock wait',async mode=>{
  const f=await assigned(),lock=await pool.connect();await lock.query('BEGIN');await lock.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[f.taskId]);
  const lockPid=(await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const waiting=claim(f);let blocked=false;
  try {
    for(let i=0;i<100;i++){const rows=(await pool.query('SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[lockPid])).rows;if(rows.length){blocked=true;break;}await new Promise(r=>setTimeout(r,20));}
    expect(blocked).toBe(true);
    if(mode==='own-objects') await pool.query('UPDATE principals SET own_expression=$2 WHERE id=$1',[f.caller.id,JSON.stringify({scopes:'parent',objects:[]})]);
    if(mode==='own-scope') await pool.query('UPDATE principals SET own_expression=$2 WHERE id=$1',[f.caller.id,JSON.stringify({scopes:['tasks:read'],objects:'parent'})]);
    if(mode==='credential') await pool.query('UPDATE principal_credentials SET revoked_at=NOW() WHERE id=$1',[f.issued.credentialId]);
    if(mode==='parent-status') await pool.query("UPDATE principals SET status='disabled' WHERE id=$1",[f.parent.id]);
    if(mode==='descriptor') await pool.query('UPDATE service_descriptor_versions SET retired_at=NOW() WHERE service_id=$1',[f.serviceId]);
    if(mode==='credential-scope') await pool.query('UPDATE principal_credentials SET scopes=$2 WHERE id=$1',[f.issued.credentialId,JSON.stringify(['tasks:read'])]);
    if(mode==='credential-expiry') await pool.query("UPDATE principal_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.issued.credentialId]);
    if(mode==='account-role') await pool.query("UPDATE principals SET role='viewer' WHERE id=$1",[f.parent.id]);
    if(mode==='service') await pool.query("UPDATE services SET status='retired',retired_at=clock_timestamp() WHERE id=$1",[f.serviceId]);
    if(mode==='verifier') await pool.query("UPDATE principals SET status='disabled' WHERE id=$1",[f.verifier.id]);
    if(mode==='dependency-null') {const d=(await pool.query("INSERT INTO tasks(title,status,archive_disposition) VALUES($1,'archived',NULL) RETURNING id",[tag()])).rows[0].id;await lock.query('INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES($1,$2)',[f.taskId,d]);}
    if(mode==='epoch-ABA') {await lock.query('UPDATE tasks SET execution_profile=$2 WHERE id=$1',[f.taskId,JSON.stringify({...f.profile,options:{changed:true}})]);await lock.query('UPDATE tasks SET execution_profile=$2 WHERE id=$1',[f.taskId,JSON.stringify(f.profile)]);}
    await lock.query('COMMIT');expect((await waiting).status).toBeGreaterThanOrEqual(400);await unchanged(f);
  } finally {await lock.query('ROLLBACK');lock.release();await waiting;}
});

test.each([null,'abandoned','completed'])('archived dependency %s uses semantic completion, not SQL NULL',async disposition=>{
  const f=await assigned(),d=(await pool.query("INSERT INTO tasks(title,status,archive_disposition) VALUES($1,'archived',$2) RETURNING id",[tag(),disposition])).rows[0].id;
  await pool.query('INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES($1,$2)',[f.taskId,d]);
  const result=await claim(f);expect(result.status).toBe(disposition==='completed'?200:403);
  if(disposition!=='completed') await unchanged(f);
});
test('different and descendant principals cannot use the exact assigned Connector role',async()=>{
  const f=await assigned();
  for(const kind of ['service','agent']) {
    const id=(await pool.query(`INSERT INTO principals(kind,handle,status,parent_principal_id,bound_task_id,purpose,own_expression)
      VALUES($1,$2,'active',$3,$4,'Other claimant fixture',$5) RETURNING id`,[kind,tag(),kind==='agent'?f.caller.id:f.parent.id,kind==='agent'?f.taskId:null,JSON.stringify({scopes:'parent',objects:'parent'})])).rows[0].id;
    const issued=await principalService.issueCredential({principalId:id,scopes:['tasks:read','tasks:write'],transport:'any'},{handle:'fixture',authMethod:'system'});
    expect((await claim({...f,caller:{id,headers:{Authorization:`Bearer ${issued.fullKey}`}}})).status).toBeGreaterThanOrEqual(400);
    await unchanged(f);
  }
});
test('presented credential expiry refuses even if another credential remains active',async()=>{
  const f=await assigned();await principalService.issueCredential({principalId:f.caller.id,scopes:['tasks:read','tasks:write'],transport:'any'},{handle:'fixture',authMethod:'system'});
  await pool.query("UPDATE principal_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.issued.credentialId]);
  expect((await claim(f)).status).toBeGreaterThanOrEqual(400);await unchanged(f);
});
test('two different principals competing leave exactly one owner',async()=>{
  const f=await assigned();
  // Two independently eligible principals: the assigned Connector's narrow
  // admission and an ordinary human's legacy positive WRITE fixture.
  await pool.query(`INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id)
    VALUES('principal',$1,'task',$2,'write',$1)`,[f.parent.id,f.taskId]);
  const replies=await Promise.all([claim(f),call(f.parent,'POST',`/tasks/${f.taskId}/claim`,{})]);
  expect(replies.filter(r=>r.status===200)).toHaveLength(1);
  expect(replies.filter(r=>r.status>=400 && r.status<500)).toHaveLength(1);
  const winner=replies[0].status===200?f.caller.id:f.parent.id;
  expect((await pool.query('SELECT owner_principal_id FROM tasks WHERE id=$1',[f.taskId])).rows[0].owner_principal_id).toBe(winner);
  expect((await pool.query('SELECT epoch::text FROM task_native_assignment_epochs WHERE task_id=$1',[f.taskId])).rows[0].epoch).toBe(String(BigInt(f.epoch)+1n));
});
test('actual MCP handler forwards epoch to in-process authenticated route and PostgreSQL',async()=>{
  const f=await assigned(),tool=require('../mcp/registry').toolByName('relayhall_task_claim');
  const result=await tool.handler({task:f.taskId,expectedAssignmentEpoch:f.epoch},{authorization:f.caller.headers.Authorization,toolName:'relayhall_task_claim'});
  expect(result).toContain(f.taskId);
  expect((await pool.query('SELECT owner_principal_id FROM tasks WHERE id=$1',[f.taskId])).rows[0].owner_principal_id).toBe(f.caller.id);
});

test('new Task claim role matches shared SQL/point/display/pure decision without generic WRITE',async()=>{
 const f=await assigned(),{delegationService}=require('../services/DelegationService'),{authorizationRepository,mapResource}=require('../services/AuthorizationRepository'),{authorizationService}=require('../services/AuthorizationService');
 const chain=await delegationService.resolveChain(f.caller.id);
 const actor={principalId:f.caller.id,handle:'fixture',role:'service',scopes:['tasks:read','tasks:write'],authenticated:true,delegation:{links:chain.links}};
 const row=(await pool.query('SELECT * FROM tasks WHERE id=$1',[f.taskId])).rows[0];
 const resource={...mapResource('task',row),assignedClaimEligible:true,assignedClaimPrincipalId:f.caller.id};
 expect(authorizationService.authorizeResource(actor,'claim',resource,[]).allowed).toBe(true);
 expect((await authorizationRepository.authorizePoint(actor,'task',f.taskId,'claim')).allowed).toBe(true);
 expect((await authorizationRepository.authorizedIds(actor,'task',[f.taskId],'claim')).has(f.taskId)).toBe(true);
 expect((await authorizationRepository.authorizedIds(actor,'task',[f.taskId],'write')).has(f.taskId)).toBe(false);
});
test('missing or READ-only delegated expression refuses; no grant denies are invented',async()=>{
 for(const own of [null,{scopes:'parent',objects:[]},{scopes:['tasks:read'],objects:'parent'}]) {
  const f=await assigned();await pool.query('UPDATE principals SET own_expression=$2 WHERE id=$1',[f.caller.id,own&&JSON.stringify(own)]);
  expect((await claim(f)).status).toBeGreaterThanOrEqual(400);await unchanged(f);
 }
});

test.each(['expires_at','grace_until'])('legacy legal Agent claim refreshes ancestor %s after Task lock wait',async column=>{
 const f=await assigned();
 // This exercises existing authorized legacy claim, not assigned Connector admission.
 await pool.query("INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id) VALUES('principal',$1,'task',$2,'write',$1)",[f.parent.id,f.taskId]);
 const agent=(await pool.query("INSERT INTO principals(kind,handle,status,parent_principal_id,purpose,own_expression,bound_task_id) VALUES('agent',$1,'active',$2,'legal legacy claimant',$3,$4) RETURNING id",[tag(),f.caller.id,JSON.stringify({scopes:'parent',objects:'parent'}),f.taskId])).rows[0].id;
 const issued=await principalService.issueCredential({principalId:agent,scopes:['tasks:read','tasks:write'],transport:'any'},{handle:'fixture',authMethod:'system'}),who={id:agent,headers:{Authorization:`Bearer ${issued.fullKey}`}};
 expect((await call(who,'GET',`/tasks/${f.taskId}`)).status).toBe(200);
 const before={task:(await pool.query('SELECT * FROM tasks WHERE id=$1',[f.taskId])).rows,epoch:(await pool.query('SELECT * FROM task_native_assignment_epochs WHERE task_id=$1',[f.taskId])).rows,events:(await pool.query('SELECT * FROM feed_events WHERE object_id=$1 ORDER BY cursor',[f.taskId])).rows};
 const lock=await pool.connect();await lock.query('BEGIN');await lock.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[f.taskId]);const pid=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid,pending=call(who,'POST',`/tasks/${f.taskId}/claim`,{});
 try{let blocked=false;for(let i=0;i<100;i++){if((await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rowCount){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}expect(blocked).toBe(true);
  await pool.query(`UPDATE principal_credentials SET ${column}=clock_timestamp()+interval '150 milliseconds' WHERE id=$1`,[f.issued.credentialId]);await new Promise(resolve=>setTimeout(resolve,200));await lock.query('COMMIT');
  expect((await pending).status).toBe(403);expect((await pool.query('SELECT * FROM tasks WHERE id=$1',[f.taskId])).rows).toEqual(before.task);expect((await pool.query('SELECT * FROM task_native_assignment_epochs WHERE task_id=$1',[f.taskId])).rows).toEqual(before.epoch);expect((await pool.query('SELECT * FROM feed_events WHERE object_id=$1 ORDER BY cursor',[f.taskId])).rows).toEqual(before.events);
 }finally{await lock.query('ROLLBACK');lock.release();await pending;}
});

test('actual assigned claim route refuses delegated own root sentinel without Task mutation',async()=>{
 const f=await assigned(),before=(await pool.query('SELECT * FROM tasks WHERE id=$1',[f.taskId])).rows;
 await pool.query('UPDATE principals SET own_expression=$2 WHERE id=$1',[f.caller.id,JSON.stringify({scopes:['root'],objects:'parent'})]);
 // The canonical delegation parser rejects the invalid own root sentinel before dispatch.
 const response=await claim(f);expect(response.status).toBe(503);expect(response.body.code).toBe('DELEGATION_EVALUATOR_FAILED');expect((await pool.query('SELECT * FROM tasks WHERE id=$1',[f.taskId])).rows).toEqual(before);
 expect((await pool.query('SELECT epoch::text FROM task_native_assignment_epochs WHERE task_id=$1',[f.taskId])).rows[0].epoch).toBe(f.epoch);
});
