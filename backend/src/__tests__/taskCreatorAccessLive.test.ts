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


async function created(who: Caller, headers: Record<string,string>={}) {
  const title=tag(); const response=await call({...who,headers:{...who.headers,...headers}},'POST','/tasks',{title,status:'todo'});
  expect(response.status).toBe(201);return response.body.task;
}
// Explicitly model legacy grant-only resources when exercising grant revocation.
// Current creations retain account ownership independently of revocable Grants.
async function grantOnly(taskId:string) {
  await pool.query('UPDATE tasks SET account_owner_principal_id=NULL WHERE id=$1',[taskId]);
}
// Owner ruling E418(b): the single grant DELETE takes PATCH's login session and
// a step-up bound to (grant.revoke, id); a revocation here supplies both.
async function revoke(who:Caller,grantId:string) {
  const {stepUpService}=require('../services/StepUpService');
  const {token}=await stepUpService.mint(who.id,'grant.revoke',String(grantId).toLowerCase(),'password');
  return call(who,'DELETE','/grants/'+grantId,{stepUpToken:token});
}
async function grants(taskId:string) {return (await pool.query("SELECT * FROM grants WHERE resource_type='task' AND resource_id=$1 ORDER BY verb",[taskId])).rows;}

test('ordinary orphan creator receives only exact revocable read/write and can arm then claim',async()=>{
  const user=await human('user'),task=await created(user);
  const rows=await grants(task.id);expect(rows).toHaveLength(2);expect(rows.map((x:any)=>[x.grantee_id,x.verb,x.provenance])).toEqual([[user.id,'read',null],[user.id,'write',null]]);
  expect(task.ownerPrincipalId).toBeNull();expect(task.shepherdPrincipalId).toBe(user.id);
  const view=await call(user,'GET',`/tasks/${task.id}`);expect(view.status).toBe(200);
  expect(view.body.task.lifecycleAccess.arm.allowed).toBe(true);expect(view.body.task.lifecycleAccess.claim.reason).toBe('TASK_NOT_ARMED');
  expect((await call(user,'PATCH',`/tasks/${task.id}`,{autoStart:true})).status).toBe(200);
  expect((await call(user,'POST',`/tasks/${task.id}/claim`,{})).status).toBe(200);
  expect((await call(user,'GET',`/tasks/${task.id}`)).body.task.ownerPrincipalId).toBe(user.id);
});
test('unrelated Task and creator-only Shepherd cannot bypass revoked write; reads never heal',async()=>{
  const user=await human('user'),other=await human('user'),task=await created(user);
  for (const [method,path,body] of [['PATCH',`/tasks/${task.id}`,{autoStart:true}],['POST',`/tasks/${task.id}/claim`,{}]] as const) {
    const denied=await call(other,method,path,body);expect(denied.status).toBe(404);expect(denied.body.code).toBe('RESOURCE_NOT_FOUND');
  }
  await grantOnly(task.id);
  await pool.query("DELETE FROM grants WHERE resource_type='task' AND resource_id=$1 AND verb='write'",[task.id]);
  const view=await call(user,'GET',`/tasks/${task.id}`);expect(view.status).toBe(200);
  expect(view.body.task.lifecycleAccess.arm).toEqual({allowed:false,reason:'TASK_WRITE_REQUIRED'});
  expect(view.body.task.lifecycleAccess.park.allowed).toBe(true);
  expect((await call(user,'PATCH',`/tasks/${task.id}`,{autoStart:true})).status).toBe(403);
  expect((await call(user,'POST',`/tasks/${task.id}/claim`,{})).status).toBe(403);
  expect((await grants(task.id)).map((x:any)=>x.verb)).toEqual(['read']);
});
test('exact create retry does not heal later revocation or duplicate grants',async()=>{
  const user=await human('user'),key=crypto.randomUUID(),title=tag();const h={...user,headers:{...user.headers,'Idempotency-Key':key}};
  const first=await call(h,'POST','/tasks',{title,status:'todo'});expect(first.status).toBe(201);
  const taskId=first.body.task.id;await pool.query("DELETE FROM grants WHERE resource_type='task' AND resource_id=$1 AND verb='write'",[taskId]);
  const second=await call(h,'POST','/tasks',{title,status:'todo'});expect(second).toEqual(first);
  expect((await grants(taskId)).map((x:any)=>x.verb)).toEqual(['read']);
});
test('read-only credential cannot create, arm or claim despite creator grants',async()=>{
  const parent=await human('admin');
  const id=(await pool.query("INSERT INTO principals(kind,handle,status,parent_principal_id,purpose,own_expression) VALUES('service',$1,'active',$2,'Scope ceiling fixture',$3) RETURNING id",[tag(),parent.id,JSON.stringify({scopes:'parent',objects:'parent'})])).rows[0].id;
  const full=await principalService.issueCredential({principalId:id,scopes:['tasks:read','tasks:write'],transport:'any'},{handle:'fixture',authMethod:'system'});
  const fullCaller={id,headers:{Authorization:`Bearer ${full.fullKey}`}};
  const task=await created(fullCaller);
  expect((await call(fullCaller,'GET',`/tasks/${task.id}`)).body.task.lifecycleAccess.arm.allowed).toBe(true);
  expect((await call(fullCaller,'PATCH',`/tasks/${task.id}`,{autoStart:true})).status).toBe(200);
  const issued=await principalService.issueCredential({principalId:id,scopes:['tasks:read'],transport:'any'},{handle:'fixture',authMethod:'system'});
  const limited={id,headers:{Authorization:`Bearer ${issued.fullKey}`}};
  expect((await call(limited,'POST','/tasks',{title:tag()})).status).toBe(403);
  expect((await call(limited,'GET',`/tasks/${task.id}`)).body.task.lifecycleAccess.arm.reason).toBe('WRITE_SCOPE_REQUIRED');
  expect((await call(limited,'PATCH',`/tasks/${task.id}`,{autoStart:true})).status).toBe(403);
  expect((await call(limited,'POST',`/tasks/${task.id}/claim`,{})).status).toBe(403);
});
test('delegated creator and verified human sponsor receive exact access; revoked sponsor write remains denied',async()=>{
  const parent=await human('user');const id=(await pool.query(`INSERT INTO principals(kind,handle,status,parent_principal_id,purpose,own_expression) VALUES('service',$1,'active',$2,'Task creator fixture',$3) RETURNING id`,[tag(),parent.id,JSON.stringify({scopes:'parent',objects:'parent'})])).rows[0].id;
  const issued=await principalService.issueCredential({principalId:id,scopes:['tasks:read','tasks:write'],transport:'any'},{handle:'fixture',authMethod:'system'});
  const child={id,headers:{Authorization:`Bearer ${issued.fullKey}`}},task=await created(child);
  const rows=await grants(task.id);
  expect(rows).toHaveLength(4);
  expect(rows.map((x:any)=>[x.grantee_type,x.grantee_id,x.resource_type,x.resource_id,x.verb,x.provenance]).sort()).toEqual([
    ['principal',id,'task',task.id,'read',null],['principal',id,'task',task.id,'write',null],
    ['principal',parent.id,'task',task.id,'read',null],['principal',parent.id,'task',task.id,'write',null],
  ].sort());
  const view=await call(child,'GET',`/tasks/${task.id}`);
  expect(view.status).toBe(200);expect(view.body.task.lifecycleAccess.arm.allowed).toBe(true);
  expect(view.body.task.lifecycleAccess.claim.reason).toBe('TASK_NOT_ARMED');
  expect((await call(child,'PATCH',`/tasks/${task.id}`,{autoStart:true})).status).toBe(200);
  expect((await call(child,'POST',`/tasks/${task.id}/claim`,{})).status).toBe(200);
  expect((await call(child,'GET',`/tasks/${task.id}`)).body.task.ownerPrincipalId).toBe(id);

  // Creator grants never bypass a subsequently revoked ancestor write grant.
  const deniedTask=await created(child);
  await grantOnly(deniedTask.id);
  await pool.query("DELETE FROM grants WHERE grantee_id=$1 AND resource_type='task' AND resource_id=$2 AND verb='write'",[parent.id,deniedTask.id]);
  const deniedView=await call(child,'GET',`/tasks/${deniedTask.id}`);
  expect(deniedView.status).toBe(200);
  expect(deniedView.body.task.lifecycleAccess.arm).toEqual({allowed:false,reason:'TASK_WRITE_REQUIRED'});
  expect((await call(child,'PATCH',`/tasks/${deniedTask.id}`,{autoStart:true})).status).toBe(403);
  expect((await call(child,'POST',`/tasks/${deniedTask.id}/claim`,{})).status).toBe(403);
  expect((await grants(deniedTask.id)).map((x:any)=>[x.grantee_id,x.verb]).sort()).toEqual([
    [id,'read'],[id,'write'],[parent.id,'read'],
  ].sort());
});
test('grant or audit failure rolls back new Task and both grants',async()=>{
  const user=await human('user'),title=tag();const {auditService}=require('../services/AuditService');const original=auditService.record.bind(auditService);let reachedCreatorAudit=false;
  const spy=jest.spyOn(auditService,'record').mockImplementation(async(...args:any[])=>{if(args[0]?.action==='task.creator_access'){reachedCreatorAudit=true;throw new Error('controlled audit failure');}return original(...args);});
  try {expect((await call(user,'POST','/tasks',{title,status:'todo'})).status).toBe(500);}finally{spy.mockRestore();}
  expect(reachedCreatorAudit).toBe(true);
  expect((await pool.query('SELECT id FROM tasks WHERE title=$1',[title])).rows).toEqual([]);
  expect((await pool.query("SELECT id FROM grants WHERE grantee_id=$1 AND resource_type='task'",[user.id])).rows).toEqual([]);
});
test('assigned Verifier never becomes claimant through creator grants',async()=>{
  const user=await human('user'),task=await created(user);
  await pool.query('UPDATE tasks SET verifier_principal_id=$2 WHERE id=$1',[task.id,user.id]);
  expect((await call(user,'PATCH',`/tasks/${task.id}`,{autoStart:true})).status).toBe(200);
  expect((await call(user,'GET',`/tasks/${task.id}`)).body.task.lifecycleAccess.claim.reason).toBe('INDEPENDENT_VERIFIER');
  expect((await call(user,'POST',`/tasks/${task.id}/claim`,{})).status).toBe(409);
});

test.each(['review','stuck','completed'])('manual claim parity at %s preserves status and completion evidence',async status=>{
  const user=await human('user'),task=await created(user);
  await pool.query('UPDATE tasks SET status=$2,auto_start=TRUE WHERE id=$1',[task.id,status]);
  const before=(await pool.query('SELECT status,completed_at,review_history FROM tasks WHERE id=$1',[task.id])).rows[0];
  expect((await call(user,'GET',`/tasks/${task.id}`)).body.task.lifecycleAccess.claim.allowed).toBe(true);
  expect((await call(user,'POST',`/tasks/${task.id}/claim`,{})).status).toBe(200);
  expect((await pool.query('SELECT status,completed_at,review_history FROM tasks WHERE id=$1',[task.id])).rows[0]).toEqual(before);
});

// The manager refuses the unappointed delegate before inserting child payloads.
// The transaction rolls back its Task and grants, preserving the typed refusal.
test('unappointed delegate completed-subtask creation returns typed refusal and writes no Task or grant',async()=>{
 const parent=await human('user'),title=tag();
 const id=(await pool.query("INSERT INTO principals(kind,handle,status,parent_principal_id,purpose,own_expression) VALUES('service',$1,'active',$2,'Task creator fixture',$3) RETURNING id",[tag(),parent.id,JSON.stringify({scopes:'parent',objects:'parent'})])).rows[0].id;
 const issued=await principalService.issueCredential({principalId:id,scopes:['tasks:read','tasks:write'],transport:'any'},{handle:'fixture',authMethod:'system'});
 const user={id,headers:{Authorization:`Bearer ${issued.fullKey}`}};
 const before=(await pool.query("SELECT COUNT(*)::int AS n FROM grants WHERE grantee_id=$1",[user.id])).rows[0].n;
 const response=await call(user,'POST','/tasks',{title,status:'review',subtasks:[{id:crypto.randomUUID(),title:'already judged',status:'completed'},{id:crypto.randomUUID(),title:'not required',status:'skipped'}]});
 expect(response.status).toBe(403);expect(response.body.code).toBe('FORBIDDEN');
 expect(response.body.error).toBe('Only an independent Verifier identity can create a completed subtask');
 const mcpError=require('../mcp/shape').errorFromRest('relayhall_task_create',response.status,response.body,'tasks:write');
 expect(mcpError.message).toContain('HTTP 403');expect(mcpError.message).toContain('[FORBIDDEN]');expect(mcpError.message).not.toContain('TASK_CREATE_FAILED');
 expect((await pool.query('SELECT id FROM tasks WHERE title=$1',[title])).rowCount).toBe(0);
 expect((await pool.query("SELECT COUNT(*)::int AS n FROM grants WHERE grantee_id=$1",[user.id])).rows[0].n).toBe(before);
});

// Human archival is filing, and undo restores evidence; neither approves work.
async function archiveCompletedFixture(who: Caller) {
  const task = await created(who);
  // Isolated database setup of already accepted work, never a live workflow.
  await pool.query("UPDATE tasks SET status='completed',completed_at='2026-01-02T03:04:05Z',review_history=$2 WHERE id=$1",
    [task.id, JSON.stringify([{verdict:'pass', reviewer:'independent fixture', timestamp:'2026-01-02T03:04:05Z'}])]);
  return task;
}
async function archiveState(id: string) {
  return (await pool.query('SELECT status,archived_at,archive_disposition,completed_at,review_history,auto_start FROM tasks WHERE id=$1',[id])).rows[0];
}
test.each(['patch','post','bulk'])('ordinary human archives completed and restores original completion via %s', async surface => {
  const user=await human('user'), task=await archiveCompletedFixture(user), before=await archiveState(task.id);
  const response=surface==='patch' ? await call(user,'PATCH',`/tasks/${task.id}`,{status:'archived',archiveReason:'file accepted work'})
    : surface==='post' ? await call(user,'POST',`/tasks/${task.id}/archive`,{reason:'file accepted work'})
    : await call(user,'POST','/tasks/bulk-archive',{taskIds:[task.id]});
  expect(response.status).toBe(200);
  const archived=await archiveState(task.id);expect(archived.status).toBe('archived');expect(archived.archive_disposition).toBe('completed');
  expect(archived.completed_at).toEqual(before.completed_at);expect(archived.review_history).toEqual(before.review_history);
  const {dependencySatisfied}=require('../services/TaskManagerDB');expect(dependencySatisfied(archived.status,archived.archive_disposition)).toBe(true);
  const restored=await call(user,'POST',`/tasks/${task.id}/unarchive`,{});expect(restored.status).toBe(200);expect(restored.body.restoredTo).toBe('completed');expect(restored.body.derivedFrom).toBe('history');
  expect(await archiveState(task.id)).toEqual(before);
  const history=(await pool.query("SELECT actor_principal_id,old_value,new_value FROM task_history WHERE task_id=$1 AND event_type='status' ORDER BY created_at",[task.id])).rows;
  expect(history.some((x:any)=>x.old_value==='completed'&&x.new_value==='archived'&&x.actor_principal_id===user.id)).toBe(true);
  expect(history.some((x:any)=>x.old_value==='archived'&&x.new_value==='completed'&&x.actor_principal_id===user.id)).toBe(true);
  expect((await call(user,'POST',`/tasks/${task.id}/unarchive`,{})).status).toBe(409);
});
test('human undo of Todo ignores client target and cannot manufacture completion',async()=>{
  const user=await human('user'),task=await created(user);
  expect((await call(user,'POST',`/tasks/${task.id}/archive`,{})).status).toBe(200);
  expect((await archiveState(task.id)).archive_disposition).toBe('abandoned');
  const restored=await call(user,'POST',`/tasks/${task.id}/unarchive`,{status:'completed',restore:true});expect(restored.status).toBe(200);expect(restored.body.restoredTo).toBe('todo');
  const row=await archiveState(task.id);expect(row.completed_at).toBeNull();expect(row.review_history).toEqual([]);expect(row.auto_start).toBe(false);
  // Undo did not approve anything; a separate explicit owner disposition can.
  expect((await call(user,'PATCH',`/tasks/${task.id}`,{status:'completed'})).status).toBe(200);
  expect((await archiveState(task.id)).review_history).toEqual([]);
  expect((await pool.query("SELECT id FROM audit_events WHERE resource_id=$1 AND action='task.account_disposition' AND metadata->>'disposition'='completed'",[task.id])).rowCount).toBe(1);
});
test.each(['missing','disposition','timestamp'])('human restoration refuses %s completion provenance without any write',async variant=>{
  const user=await human('user'),task=await archiveCompletedFixture(user);
  expect((await call(user,'POST',`/tasks/${task.id}/archive`,{})).status).toBe(200);
  if(variant==='missing')await pool.query("DELETE FROM task_history WHERE task_id=$1 AND event_type='status' AND new_value='archived'",[task.id]);
  if(variant==='disposition')await pool.query("UPDATE tasks SET archive_disposition='abandoned' WHERE id=$1",[task.id]);
  if(variant==='timestamp')await pool.query("UPDATE tasks SET completed_at=archived_at + interval '1 day' WHERE id=$1",[task.id]);
  const before=await archiveState(task.id);const response=await call(user,'POST',`/tasks/${task.id}/unarchive`,{});
  expect(response.status).toBe(409);expect(response.body.code).toBe('TASK_RESTORE_PROVENANCE_REQUIRED');expect(await archiveState(task.id)).toEqual(before);
});
test.each(['viewer','unknown',''])('session snapshot %s cannot widen to human archive',async role=>{
  const user=await human('user'),task=await archiveCompletedFixture(user);
  await pool.query('UPDATE auth_sessions SET role_snapshot=$2 WHERE principal_id=$1',[user.id,role]);
  expect((await call(user,'POST',`/tasks/${task.id}/archive`,{})).status).toBe(403);expect((await archiveState(task.id)).status).toBe('completed');
});
test('explicit ordinary user snapshot can archive without role elevation',async()=>{
  const user=await human('user'),task=await archiveCompletedFixture(user);
  await pool.query("UPDATE auth_sessions SET role_snapshot='user' WHERE principal_id=$1",[user.id]);
  expect((await call(user,'POST',`/tasks/${task.id}/archive`,{})).status).toBe(200);
});
test('mixed archive PATCH cannot smuggle other writes or forged restoration',async()=>{
  const user=await human('user'),task=await archiveCompletedFixture(user);
  await grantOnly(task.id);
  for(const extra of [{autoStart:true},{restore:true},{archiveOperation:'restore-archive'},{subtasks:[]}]) {
    expect((await call(user,'PATCH',`/tasks/${task.id}`,{status:'archived',...extra})).status).toBe(403);
    expect((await archiveState(task.id)).status).toBe('completed');
  }
});
test('bulk archival keeps foreign private Task unchanged and permits only exact own Task',async()=>{
  const user=await human('user'),other=await human('user'),own=await archiveCompletedFixture(user),foreign=await archiveCompletedFixture(other);
  const response=await call(user,'POST','/tasks/bulk-archive',{taskIds:[own.id,foreign.id]});expect(response.status).toBe(200);
  expect((await archiveState(own.id)).status).toBe('archived');expect((await archiveState(foreign.id)).status).toBe('completed');
  expect((await call(user,'POST',`/tasks/${foreign.id}/archive`,{})).status).toBe(404);
});
test.each(['grant','retire','role','snapshot','session','expiry'])('authority %s changed while archive waits on Task lock refuses and rolls back',async change=>{
  const user=await human('user'),task=await archiveCompletedFixture(user),client=await pool.connect();
  if(change==='grant')await grantOnly(task.id);
  await client.query('BEGIN');await client.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[task.id]);
  const pending=call(user,'POST',`/tasks/${task.id}/archive`,{});
  try {
    let waiting=false;for(let n=0;n<100;n++) {const rows=await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT * FROM tasks WHERE id = $1%' AND pid<>pg_backend_pid()");if(rows.rowCount){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}expect(waiting).toBe(true);
    if(change==='grant')await pool.query("DELETE FROM grants WHERE grantee_id=$1 AND resource_id=$2 AND verb='write'",[user.id,task.id]);
    if(change==='retire')await pool.query("UPDATE principals SET status='disabled' WHERE id=$1",[user.id]);
    if(change==='role')await pool.query("UPDATE principals SET role='viewer' WHERE id=$1",[user.id]);
    if(change==='snapshot')await pool.query("UPDATE auth_sessions SET role_snapshot='viewer' WHERE principal_id=$1",[user.id]);
    if(change==='session')await pool.query("UPDATE auth_sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE principal_id=$1",[user.id]);
    if(change==='expiry')await pool.query("UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE principal_id=$1",[user.id]);
  } finally {await client.query('ROLLBACK');client.release();}
  expect((await pending).status).toBe(403);expect((await archiveState(task.id)).status).toBe('completed');
});

test('undo preserves historical Completed with null timestamp and no invented verdict',async()=>{
  const user=await human('user'),task=await archiveCompletedFixture(user);
  await pool.query("UPDATE tasks SET completed_at=NULL,review_history='[]'::jsonb WHERE id=$1",[task.id]);
  const before=await archiveState(task.id);
  expect((await call(user,'POST',`/tasks/${task.id}/archive`,{})).status).toBe(200);
  expect((await call(user,'POST',`/tasks/${task.id}/unarchive`,{})).status).toBe(200);
  expect(await archiveState(task.id)).toEqual(before);
});
test('all-subtasks disposition cannot change a proven prior Review into Completed',async()=>{
  const user=await human('user'),task=await created(user);
  await pool.query("UPDATE tasks SET status='review' WHERE id=$1",[task.id]);
  expect((await call(user,'POST',`/tasks/${task.id}/archive`,{})).status).toBe(200);
  await pool.query("UPDATE tasks SET archive_disposition='completed' WHERE id=$1",[task.id]);
  const restored=await call(user,'POST',`/tasks/${task.id}/unarchive`,{});expect(restored.status).toBe(200);expect(restored.body.restoredTo).toBe('review');expect((await archiveState(task.id)).completed_at).toBeNull();
});

test.each(['service','agent'])('actual %s with user role cannot use human archive or undo',async kind=>{
  const parent=await human('admin'),owner=await human('user'),task=kind==='agent'?await created(owner):await archiveCompletedFixture(owner);
  const id=(await pool.query("INSERT INTO principals(kind,handle,status,role,parent_principal_id,purpose,own_expression,bound_task_id) VALUES($1,$2,'active','user',$3,'Archive actor boundary',$4,$5) RETURNING id",[kind,tag(),parent.id,JSON.stringify({scopes:'parent',objects:'parent'}),kind==='agent'?task.id:null])).rows[0].id;
  const issued=await principalService.issueCredential({principalId:id,scopes:['tasks:read','tasks:write'],transport:'any'},{handle:'fixture',authMethod:'system'});
  const caller={id,headers:{Authorization:`Bearer ${issued.fullKey}`}};
  // Exact grants are fixture state, not production access repair.
  await pool.query("INSERT INTO grants(grantee_id,resource_type,resource_id,verb) VALUES($1,'task',$2,'read'),($1,'task',$2,'write')",[id,task.id]);
  expect((await call(caller,'GET',`/tasks/${task.id}`)).status).toBe(200);
  expect((await call(caller,'POST',`/tasks/${task.id}/archive`,{})).status).toBe(403);expect((await archiveState(task.id)).status).toBe(kind==='agent'?'todo':'completed');
  expect((await call(owner,'POST',`/tasks/${task.id}/archive`,{})).status).toBe(200);
  expect((await call(caller,'POST',`/tasks/${task.id}/unarchive`,{})).status).toBe(kind==='agent'?401:403);expect((await archiveState(task.id)).status).toBe('archived');
});
test('Accounts cannot manufacture bearer credentials to obtain archive authority',async()=>{
  const user=await human('user');
  await expect(principalService.issueCredential({principalId:user.id,scopes:['tasks:read','tasks:write'],transport:'any'},{handle:'fixture',authMethod:'system'})).rejects.toThrow('Accounts hold no bearer credentials');
});
test('undo waiting for Task lock observes revoked exact WRITE and leaves history unchanged',async()=>{
  const user=await human('user'),task=await archiveCompletedFixture(user);
  await grantOnly(task.id);
  expect((await call(user,'POST',`/tasks/${task.id}/archive`,{})).status).toBe(200);
  const before=await archiveState(task.id),client=await pool.connect();await client.query('BEGIN');await client.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[task.id]);
  const pending=call(user,'POST',`/tasks/${task.id}/unarchive`,{});
  try {let waiting=false;for(let n=0;n<100;n++){if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT * FROM tasks WHERE id = $1%'")).rowCount){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}expect(waiting).toBe(true);await pool.query("DELETE FROM grants WHERE grantee_id=$1 AND resource_id=$2 AND verb='write'",[user.id,task.id]);}
  finally{await client.query('ROLLBACK');client.release();}
  expect((await pending).status).toBe(403);expect(await archiveState(task.id)).toEqual(before);
});
test('atomic history failure rolls back human archive',async()=>{
  const user=await human('user'),task=await archiveCompletedFixture(user),before=await archiveState(task.id);
  await pool.query(`CREATE FUNCTION archive_fixture_history_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.task_id='${task.id}'::uuid AND NEW.new_value='archived' THEN RAISE EXCEPTION 'owned archive history rollback fixture'; END IF; RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER archive_fixture_history_failure BEFORE INSERT ON task_history FOR EACH ROW EXECUTE FUNCTION archive_fixture_history_failure()');
  try {expect((await call(user,'POST',`/tasks/${task.id}/archive`,{})).status).toBe(400);expect(await archiveState(task.id)).toEqual(before);}
  finally{await pool.query('DROP TRIGGER archive_fixture_history_failure ON task_history');await pool.query('DROP FUNCTION archive_fixture_history_failure()');}
});

test('restoration preserves an authoritative legacy Completed state without rejudging child history',async()=>{
  const user=await human('user'),task=await archiveCompletedFixture(user);
  await pool.query("INSERT INTO subtasks(task_id,index,title,status) VALUES($1,0,'historical child','review')",[task.id]);
  const before=await archiveState(task.id);
  expect((await call(user,'POST',`/tasks/${task.id}/archive`,{})).status).toBe(200);
  expect((await call(user,'POST',`/tasks/${task.id}/unarchive`,{})).status).toBe(200);
  expect(await archiveState(task.id)).toEqual(before);
  expect((await pool.query('SELECT status FROM subtasks WHERE task_id=$1',[task.id])).rows[0].status).toBe('review');
});

test('atomic history failure rolls back restoration and retains archived completion',async()=>{
  const user=await human('user'),task=await archiveCompletedFixture(user);
  expect((await call(user,'POST',`/tasks/${task.id}/archive`,{})).status).toBe(200);const before=await archiveState(task.id);
  await pool.query(`CREATE FUNCTION restore_fixture_history_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.task_id='${task.id}'::uuid AND NEW.old_value='archived' THEN RAISE EXCEPTION 'owned restore history rollback fixture'; END IF; RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER restore_fixture_history_failure BEFORE INSERT ON task_history FOR EACH ROW EXECUTE FUNCTION restore_fixture_history_failure()');
  try {expect((await call(user,'POST',`/tasks/${task.id}/unarchive`,{})).status).toBe(500);expect(await archiveState(task.id)).toEqual(before);}
  finally{await pool.query('DROP TRIGGER restore_fixture_history_failure ON task_history');await pool.query('DROP FUNCTION restore_fixture_history_failure()');}
});

test.each([['user','review'],['user','todo'],['admin','review'],['admin','todo']])('bulk completed-only eligibility for %s survives a Task-lock wait ending in %s',async(role,next)=>{
  const user=await human(role),task=await archiveCompletedFixture(user),client=await pool.connect();
  await client.query('BEGIN');await client.query('UPDATE tasks SET status=$2 WHERE id=$1',[task.id,next]);
  const pending=call(user,'POST','/tasks/bulk-archive',{taskIds:[task.id]});
  try {let waiting=false;for(let n=0;n<100;n++){if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT * FROM tasks WHERE id = $1%'")).rowCount){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}expect(waiting).toBe(true);}
  finally{await client.query('COMMIT');client.release();}
  const response=await pending;expect(response.status).toBe(200);expect(response.body.results[0].code).toBe('NOT_COMPLETED');expect(response.body.archivedCount).toBe(0);
  const row=await archiveState(task.id);expect(row.status).toBe(next);expect(row.archived_at).toBeNull();expect(row.archive_disposition).toBeNull();
  // The ordinary single archive operation remains permitted from that state.
  expect((await call(user,'POST',`/tasks/${task.id}/archive`,{})).status).toBe(200);
});


test.each(['missing-latest','intact'])('undo uses only the current archive cycle: %s',async variant=>{
  const user=await human('user'),task=await archiveCompletedFixture(user);
  expect((await call(user,'POST',`/tasks/${task.id}/archive`,{})).status).toBe(200);
  expect((await call(user,'POST',`/tasks/${task.id}/unarchive`,{})).status).toBe(200);
  // Supported author edit to Review; children are isolated pre-existing fixture evidence.
  expect((await call(user,'PATCH',`/tasks/${task.id}`,{status:'review'})).status).toBe(200);
  await pool.query("INSERT INTO subtasks(task_id,index,title,status) VALUES($1,0,'accepted child','completed')",[task.id]);
  expect((await call(user,'POST',`/tasks/${task.id}/archive`,{})).status).toBe(200);
  expect((await archiveState(task.id)).archive_disposition).toBe('completed');
  const history=await pool.query("SELECT * FROM task_history WHERE task_id=$1 AND event_type='status' ORDER BY created_at",[task.id]);
  expect(history.rows.some((row:any)=>row.old_value==='completed'&&row.new_value==='archived')).toBe(true);
  expect(history.rows.some((row:any)=>row.old_value==='archived'&&row.new_value==='completed')).toBe(true);
  expect(history.rows.some((row:any)=>row.old_value==='completed'&&row.new_value==='review')).toBe(true);
  if(variant==='missing-latest') {
    const removed=await pool.query("DELETE FROM task_history WHERE task_id=$1 AND event_type='status' AND old_value='review' AND new_value='archived' RETURNING id",[task.id]);
    expect(removed.rowCount).toBe(1);
  }
  const before=await archiveState(task.id);
  const response=await call(user,'POST',`/tasks/${task.id}/unarchive`,{});
  if(variant==='missing-latest') {
    expect(response.status).toBe(409);expect(response.body.code).toBe('TASK_RESTORE_PROVENANCE_REQUIRED');
    expect(await archiveState(task.id)).toEqual(before);
  } else {
    expect(response.status).toBe(200);expect(response.body.restoredTo).toBe('review');
    expect((await archiveState(task.id)).completed_at).toEqual(before.completed_at);
    expect((await archiveState(task.id)).review_history).toEqual(before.review_history);
  }
});


test.each(['tied','null'])('undo refuses ambiguous %s newest status history without writes',async variant=>{
  const user=await human('user'),task=await archiveCompletedFixture(user);
  expect((await call(user,'POST',`/tasks/${task.id}/archive`,{})).status).toBe(200);
  if(variant==='tied')await pool.query(`INSERT INTO task_history(task_id,event_type,old_value,new_value,created_at,actor_principal_id)
    SELECT task_id,event_type,'todo','archived',created_at,actor_principal_id FROM task_history
    WHERE task_id=$1 AND event_type='status' AND new_value='archived'`,[task.id]);
  else await pool.query("UPDATE task_history SET created_at=NULL WHERE task_id=$1 AND event_type='status' AND new_value='archived'",[task.id]);
  const before=await archiveState(task.id),response=await call(user,'POST',`/tasks/${task.id}/unarchive`,{});
  expect(response.status).toBe(409);expect(response.body.code).toBe('TASK_RESTORE_PROVENANCE_REQUIRED');
  expect(await archiveState(task.id)).toEqual(before);
});

async function delegated(parent:Caller,kind:'service'|'agent'='service',boundTaskId:string|null=null,own:any={scopes:'parent',objects:'parent'}) {
 const id=(await pool.query("INSERT INTO principals(kind,handle,status,parent_principal_id,purpose,own_expression,bound_task_id) VALUES($1,$2,'active',$3,'Sponsor fixture',$4,$5) RETURNING id",[kind,tag(),parent.id,JSON.stringify(own),boundTaskId])).rows[0].id;
 const issued=await principalService.issueCredential({principalId:id,scopes:['tasks:read','tasks:write'],transport:'any'},{handle:'fixture',authMethod:'system'});
 return {id,headers:{Authorization:'Bearer '+issued.fullKey},credentialId:issued.credentialId};
}
async function sponsorAudit(taskId:string) {
 return (await pool.query("SELECT actor_principal_id,credential_id,metadata FROM audit_events WHERE action='task.sponsor_access' AND resource_type='task' AND resource_id=$1 ORDER BY metadata->>'verb'",[taskId])).rows;
}
test('human sponsor agrees across detail, list, search, pure authority and SQL without exposing unrelated private Tasks',async()=>{
 const parent=await human('user'),other=await human('user'),child=await delegated(parent),task=await created(child),privateTask=await created(other);
 expect(task.creatorPrincipalId).toBe(child.id);expect(task.shepherdPrincipalId).toBe(child.id);expect(task.ownerPrincipalId).toBeNull();
 const list=await call(parent,'GET','/tasks?q='+encodeURIComponent(task.title));expect(list.status).toBe(200);
 expect(list.body.tasks.map((x:any)=>x.id)).toContain(task.id);
 expect((await call(parent,'GET','/tasks/'+task.id)).status).toBe(200);
 expect((await call(parent,'PATCH','/tasks/'+task.id,{description:'human sponsor edit'})).status).toBe(200);
 expect((await call(parent,'GET','/tasks/'+privateTask.id)).status).toBe(404);
 const {authorizationRepository}=require('../services/AuthorizationRepository'),{authorizationService}=require('../services/AuthorizationService');
 const who={principalId:parent.id,handle:'sponsor',role:'user',scopes:['tasks:read','tasks:write'],authenticated:true};
 const rows=await grants(task.id),ownGrants=rows.filter((x:any)=>x.grantee_id===parent.id).map((x:any)=>({id:x.id,resourceType:'task',resourceId:task.id,verb:x.verb,expiresAt:null}));
 expect(authorizationService.authorizeResource(who,'read',{type:'task',id:task.id,visibility:'private'},ownGrants).allowed).toBe(true);
 expect(await authorizationRepository.authorizedIds(who,'task',[task.id,privateTask.id],'read')).toEqual(new Set([task.id]));
 const audits=await sponsorAudit(task.id);expect(audits).toHaveLength(2);
 expect(audits.every((x:any)=>x.actor_principal_id===child.id&&x.credential_id===child.credentialId&&x.metadata.creatorPrincipalId===child.id&&x.metadata.sponsorPrincipalId===parent.id)).toBe(true);
 expect(audits[0].metadata.chain).toEqual([{principalId:child.id,kind:'service',parentPrincipalId:parent.id},{principalId:parent.id,kind:'human',parentPrincipalId:null}]);
 await expect(pool.query("UPDATE audit_events SET metadata='{}' WHERE action='task.sponsor_access' AND resource_id=$1",[task.id])).rejects.toThrow('append-only');
});
test('supported revocation preserves WRITE-implies-READ and neither replay nor reads repair grants',async()=>{
 const admin=await human(),parent=await human('user'),child=await delegated(parent),key=crypto.randomUUID(),title=tag();
 const caller={...child,headers:{...child.headers,'Idempotency-Key':key}};
 const first=await call(caller,'POST','/tasks',{title,status:'todo'});expect(first.status).toBe(201);const id=first.body.task.id;
 await grantOnly(id);
 const own=(await grants(id)).filter((x:any)=>x.grantee_id===parent.id),read=own.find((x:any)=>x.verb==='read'),write=own.find((x:any)=>x.verb==='write');
 expect((await revoke(admin,read.id)).status).toBe(200);
 expect((await call(parent,'GET','/tasks/'+id)).status).toBe(200);
 expect((await revoke(admin,write.id)).status).toBe(200);
 expect((await call(parent,'GET','/tasks/'+id)).status).toBe(404);
 expect((await call(parent,'GET','/tasks?q='+encodeURIComponent(title))).body.tasks).toEqual([]);
 expect(await call(caller,'POST','/tasks',{title,status:'todo'})).toEqual(first);
 expect((await grants(id)).filter((x:any)=>x.grantee_id===parent.id)).toEqual([]);
 expect(await sponsorAudit(id)).toHaveLength(2);
});
test('supported Connector termination preserves human entitlement and original sponsor provenance',async()=>{
 const admin=await human(),parent=await human('user'),child=await delegated(parent),task=await created(child),before=await sponsorAudit(task.id);
 expect((await call(admin,'POST','/principals/'+child.id+'/terminate',{})).status).toBe(200);
 expect((await call(parent,'GET','/tasks/'+task.id)).status).toBe(200);
 expect((await call(parent,'PATCH','/tasks/'+task.id,{description:'after Connector retirement'})).status).toBe(200);
 expect(await sponsorAudit(task.id)).toEqual(before);
});
test('reparenting does not transfer existing grants or immutable sponsor provenance',async()=>{
 const old=await human('user'),next=await human('user'),child=await delegated(old),task=await created(child),before=await sponsorAudit(task.id);
 // Adversarial owned database mutation, not a proposed product reparent API.
 await pool.query('UPDATE principals SET parent_principal_id=$2 WHERE id=$1',[child.id,next.id]);principalService.invalidatePrincipals([child.id]);
 expect((await call(old,'GET','/tasks/'+task.id)).status).toBe(200);
 expect((await call(next,'GET','/tasks/'+task.id)).status).toBe(404);
 expect(await sponsorAudit(task.id)).toEqual(before);
});
test.each(['sponsorPrincipalId','sponsor_principal_id'])('caller cannot inject %s into create or edit',async field=>{
 const parent=await human('user'),child=await delegated(parent),other=await human('user'),title=tag();
 const denied=await call(child,'POST','/tasks',{title,[field]:other.id});expect(denied.status).toBe(400);expect(denied.body.code).toBe('SERVER_WRITTEN_FIELD');
 expect((await pool.query('SELECT id FROM tasks WHERE title=$1',[title])).rows).toEqual([]);
 const task=await created(child);expect((await call(parent,'PATCH','/tasks/'+task.id,{[field]:other.id})).status).toBe(400);
});
test.each([false,true])('legitimate Agent creation supports direct human / Connector chain=%s without off-task writes',async viaConnector=>{
 const parent=await human('user'),bound=await created(parent),connector=viaConnector?await delegated(parent):parent;
 const agent=await delegated(connector,'agent',bound.id),task=await created(agent);
 expect(task.creatorPrincipalId).toBe(agent.id);expect((await call(parent,'GET','/tasks/'+task.id)).status).toBe(200);
 expect((await call(agent,'PATCH','/tasks/'+task.id,{description:'off-task'})).status).toBe(403);
 const own=(await grants(task.id)).map((x:any)=>x.grantee_id);
 expect(own.sort()).toEqual([agent.id,agent.id,parent.id,parent.id].sort());
 expect((await sponsorAudit(task.id))[0].metadata.chain.map((x:any)=>x.principalId)).toEqual(viaConnector?[agent.id,connector.id,parent.id]:[agent.id,parent.id]);
});
test('explicit Connector object cap remains closed despite the new human grants',async()=>{
 const parent=await human('user'),child=await delegated(parent,'service',null,{scopes:'parent',objects:[]}),task=await created(child);
 expect((await call(parent,'PATCH','/tasks/'+task.id,{description:'human allowed'})).status).toBe(200);
 expect((await call(child,'PATCH','/tasks/'+task.id,{description:'Connector denied'})).status).toBe(403);
});
test('sponsor-audit failure rolls back Task, both grant pairs and all provenance',async()=>{
 const parent=await human('user'),child=await delegated(parent),title=tag(),{auditService}=require('../services/AuditService'),original=auditService.record.bind(auditService);
 const before=(await pool.query("SELECT id FROM grants WHERE grantee_id=ANY($1::uuid[]) ORDER BY id",[[parent.id,child.id]])).rows;
 const spy=jest.spyOn(auditService,'record').mockImplementation(async(...args:any[])=>{if(args[0]?.action==='task.sponsor_access')throw Error('controlled sponsor audit failure');return original(...args);});
 try{expect((await call(child,'POST','/tasks',{title})).status).toBe(500);}finally{spy.mockRestore();}
 expect((await pool.query('SELECT id FROM tasks WHERE title=$1',[title])).rows).toEqual([]);
 expect((await pool.query("SELECT id FROM grants WHERE grantee_id=ANY($1::uuid[]) ORDER BY id",[[parent.id,child.id]])).rows).toEqual(before);
 expect((await pool.query("SELECT id FROM audit_events WHERE action='task.sponsor_access' AND actor_principal_id=$1",[child.id])).rows).toEqual([]);
});


test.each(['reparent','disable','revoke','expiry','grace','intermediate-expiry'])('actual principal lock wait rechecks %s at decision time without partial creation',async mutation=>{
 const parent=await human('user'),next=await human('user'),connector=await delegated(parent);
 const bound=mutation==='intermediate-expiry'?await created(parent):null;
 const child=bound?await delegated(connector,'agent',bound.id):connector;
 const title=tag(),blocker=await pool.connect(),{grantService}=require('../services/GrantService'),original=grantService.createForTaskCreator.bind(grantService);
 let enteredResolve:()=>void=()=>undefined;const entered=new Promise<void>(resolve=>{enteredResolve=resolve;});
 const spy=jest.spyOn(grantService,'createForTaskCreator').mockImplementation(async(...args:any[])=>{
  if(args[2].principalId!==child.id)return original(...args);
  await blocker.query('BEGIN');
  // Task insertion already holds FK KEY SHARE; NO KEY UPDATE permits that
  // while still blocking the production ordered FOR SHARE decision lock.
  await blocker.query('SELECT id FROM principals WHERE id=ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE',[[parent.id,connector.id,child.id]]);
  if(mutation==='reparent')await blocker.query('UPDATE principals SET parent_principal_id=$2 WHERE id=$1',[child.id,next.id]);
  if(mutation==='disable')await blocker.query("UPDATE principals SET status='disabled' WHERE id=$1",[parent.id]);
  if(mutation==='revoke')await blocker.query('UPDATE principal_credentials SET revoked_at=clock_timestamp() WHERE id=$1',[child.credentialId]);
  if(mutation==='expiry'||mutation==='intermediate-expiry')await blocker.query("UPDATE principal_credentials SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE id=$1",[mutation==='intermediate-expiry'?connector.credentialId:child.credentialId]);
  if(mutation==='grace')await blocker.query("UPDATE principal_credentials SET grace_until=clock_timestamp()+interval '300 milliseconds' WHERE id=$1",[child.credentialId]);
  const result=original(...args);enteredResolve();return result;
 });
 const pending=call(child,'POST','/tasks',{title,status:'todo'});
 try {
  await Promise.race([entered,new Promise<never>((_,reject)=>{const t=setTimeout(()=>reject(Error('create did not reach principal lock')),5000);t.unref();})]);
  let waited=false;const deadline=Date.now()+5000;
  while(Date.now()<deadline) {
   const row=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id,status,legacy_identity%') AS waiting")).rows[0];
   if(row.waiting){waited=true;break;}await new Promise(resolve=>setTimeout(resolve,20));
  }
  expect(waited).toBe(true);
  if(['expiry','grace','intermediate-expiry'].includes(mutation))await pool.query('SELECT pg_sleep(0.4)');
  await blocker.query('COMMIT');
  const result=await pending;expect(result.status).toBe(409);expect(['TASK_CREATOR_UNAVAILABLE','TASK_SPONSOR_UNAVAILABLE']).toContain(result.body.code);
 } finally {await blocker.query('ROLLBACK');blocker.release();spy.mockRestore();await pending;}
 expect((await pool.query('SELECT id FROM tasks WHERE title=$1',[title])).rows).toEqual([]);
 expect((await pool.query("SELECT id FROM audit_events WHERE action='task.sponsor_access' AND actor_principal_id=$1",[child.id])).rows).toEqual([]);
});


test('actual MCP Task-create handler reaches the same sponsor transaction and preserves retry without regrant',async()=>{
 const parent=await human('user'),child=await delegated(parent),title=tag(),{toolByName}=require('../mcp/registry');
 const tool=toolByName('relayhall_task_create'),args={title,status:'todo',idempotencyKey:crypto.randomUUID()},ctx={authorization:child.headers.Authorization,toolName:'relayhall_task_create'};
 const result=await tool.handler(args,ctx);
 const task=(await pool.query('SELECT id,creator_principal_id,shepherd_principal_id FROM tasks WHERE title=$1',[title])).rows[0];
 expect(result).toContain(task.id);expect(task.creator_principal_id).toBe(child.id);expect(task.shepherd_principal_id).toBe(child.id);
 expect((await call(parent,'GET','/tasks/'+task.id)).status).toBe(200);
 const before=await sponsorAudit(task.id);expect(before).toHaveLength(2);
 expect(await tool.handler(args,ctx)).toEqual(result);expect(await sponsorAudit(task.id)).toEqual(before);
});
test('project list, board search and restricted sibling privacy retain the exact sponsor boundary',async()=>{
 const admin=await human(),parent=await human('user'),child=await delegated(parent),other=await human('user');
 const projectResult=await call(parent,'POST','/projects',{name:tag()});expect(projectResult.status).toBe(201);const project=projectResult.body.project;
 const issued=await principalService.issueCredential({principalId:child.id,scopes:['tasks:read','tasks:write','projects:read'],transport:'any'},{handle:'fixture',authMethod:'system'});
 const withProject={id:child.id,headers:{Authorization:'Bearer '+issued.fullKey}};
 const response=await call(withProject,'POST','/tasks',{title:tag(),project:project.id,status:'todo'});expect(response.status).toBe(201);const task=response.body.task;
 const siblingResponse=await call(admin,'POST','/tasks',{title:tag(),project:project.id,status:'todo'});expect(siblingResponse.status).toBe(201);const sibling=siblingResponse.body.task;
 expect((await call(admin,'PATCH','/tasks/'+sibling.id+'/access',{restricted:true,reason:'Owned private sibling fixture'})).status).toBe(200);
 expect((await call(admin,'PATCH','/tasks/'+task.id+'/access',{restricted:true,reason:'Owned restricted sponsor fixture'})).status).toBe(200);
 const list=await call(parent,'GET','/tasks?project='+encodeURIComponent(project.id));expect(list.status).toBe(200);
 expect(list.body.tasks.map((x:any)=>x.id)).toContain(task.id);expect(list.body.tasks.map((x:any)=>x.id)).not.toContain(sibling.id);
 const board=await call(parent,'GET','/tasks/board?q='+encodeURIComponent(task.title));expect(board.status).toBe(200);expect(JSON.stringify(board.body)).toContain(task.id);
 expect((await call(parent,'GET','/tasks/'+task.id)).status).toBe(200);expect((await call(parent,'GET','/tasks/'+sibling.id)).status).toBe(404);
 expect((await call(other,'GET','/tasks/'+task.id)).status).toBe(404);expect((await call(parent,'PATCH','/tasks/'+sibling.id,{description:'denied'})).status).toBe(404);
});
test('service Account ancestry infers no human sponsor',async()=>{
 const accountId=(await pool.query("INSERT INTO principals(kind,handle,status,role,purpose) VALUES('service',$1,'active','user','Owned service Account fixture') RETURNING id",[tag()])).rows[0].id;
 const child=await delegated({id:accountId,headers:{}}),task=await created(child);
 expect((await grants(task.id)).map((x:any)=>x.grantee_id)).toEqual([child.id,child.id]);
 expect(await sponsorAudit(task.id)).toEqual([]);
});
test('supported present-day exact grants remediate two owned legacy fixtures without fabricating sponsor provenance or altering unrelated grants',async()=>{
 const admin=await human(),parent=await human('user'),child=await delegated(parent),unrelated=await created(await human('user'));
 const before=(await grants(unrelated.id));const ids=[crypto.randomUUID(),crypto.randomUUID()];
 for(const id of ids) {
  await pool.query("INSERT INTO tasks(id,title,status,creator_principal_id,shepherd_principal_id) VALUES($1,$2,'todo',$3,$3)",[id,tag(),child.id]);
  expect((await call(parent,'GET','/tasks/'+id)).status).toBe(404);
  for(const verb of ['read','write']) {
   const response=await call(admin,'POST','/grants',{granteeType:'principal',granteeId:parent.id,resourceType:'task',resourceId:id,verb});
   expect(response.status).toBe(201);
   const audit=(await pool.query("SELECT actor_principal_id,metadata FROM audit_events WHERE action='grant.create' AND resource_id=$1",[response.body.grant.id])).rows;
   expect(audit).toHaveLength(1);expect(audit[0].actor_principal_id).toBe(admin.id);
   expect(audit[0].metadata).toMatchObject({granteeId:parent.id,resourceType:'task',resourceId:id,verb});
  }
  expect((await call(parent,'GET','/tasks/'+id)).status).toBe(200);
  expect((await call(parent,'PATCH','/tasks/'+id,{description:'audited repair edit'})).status).toBe(200);
  expect(await sponsorAudit(id)).toEqual([]);
 }
 expect(await grants(unrelated.id)).toEqual(before);
});


test('integrated sponsor access archives and undoes without role changes; revocation denies undo',async()=>{
 const admin=await human(),parent=await human('user'),child=await delegated(parent),task=await created(child);
 await grantOnly(task.id);
 const original=await archiveState(task.id),audit=await sponsorAudit(task.id);
 expect(task.creatorPrincipalId).toBe(child.id);expect(task.shepherdPrincipalId).toBe(child.id);
 expect((await call(parent,'POST',`/tasks/${task.id}/archive`,{})).status).toBe(200);
 expect((await archiveState(task.id)).archive_disposition).toBe('abandoned');
 expect((await call(parent,'POST',`/tasks/${task.id}/unarchive`,{})).body.restoredTo).toBe('todo');
 expect(await archiveState(task.id)).toEqual(original);
 expect((await call(parent,'POST',`/tasks/${task.id}/archive`,{})).status).toBe(200);
 const write=(await grants(task.id)).find((x:any)=>x.grantee_id===parent.id&&x.verb==='write');
 expect((await revoke(admin,write.id)).status).toBe(200);
 const archived=await archiveState(task.id);
 expect((await call(parent,'GET',`/tasks/${task.id}`)).status).toBe(200);
 expect((await call(parent,'POST',`/tasks/${task.id}/unarchive`,{})).status).toBe(403);
 expect(await archiveState(task.id)).toEqual(archived);expect(await sponsorAudit(task.id)).toEqual(audit);
 expect((await pool.query('SELECT role FROM principals WHERE id=$1',[parent.id])).rows[0].role).toBe('user');
});

test.each(['parent','excluded'])('integrated sponsored creation and archive undo retain assigned claim %s cap after WRITE revocation',async cap=>{
 const admin=await human(),parent=await human('user'),verifier=await human('user');
 const child=await delegated(parent,'service',null,{scopes:'parent',objects:cap==='parent'?'parent':[]}),task=await created(child);
 await grantOnly(task.id);
 expect((await call(parent,'POST',`/tasks/${task.id}/archive`,{})).status).toBe(200);
 expect((await call(parent,'POST',`/tasks/${task.id}/unarchive`,{})).body.restoredTo).toBe('todo');
 // Isolated published assignment fixture; real claim/auth/epoch path follows.
 const serviceId=crypto.randomUUID();
 await pool.query("INSERT INTO services(id,slug,name,kind,status,principal_id,current_descriptor_version) VALUES($1,$2,$2,'connector','published',$3,1)",[serviceId,tag(),child.id]);
 await pool.query("INSERT INTO service_descriptor_versions(service_id,version,descriptor,content_hash) VALUES($1,1,'{\"options\":[]}'::jsonb,$2)",[serviceId,'a'.repeat(64)]);
 await pool.query('UPDATE tasks SET auto_start=true,verifier_principal_id=$2,execution_service_id=$3,execution_descriptor_version=1,execution_profile=$4 WHERE id=$1',[task.id,verifier.id,serviceId,JSON.stringify({serviceId,descriptorVersion:1,options:{}})]);
 const write=(await grants(task.id)).find((x:any)=>x.grantee_id===parent.id&&x.verb==='write');
 expect((await revoke(admin,write.id)).status).toBe(200);
 expect((await call(parent,'POST',`/tasks/${task.id}/archive`,{})).status).toBe(403);
 const epoch=(await pool.query('SELECT epoch::text FROM task_native_assignment_epochs WHERE task_id=$1',[task.id])).rows[0].epoch;
 const before=await archiveState(task.id),audit=await sponsorAudit(task.id);
 const response=await call(child,'POST',`/tasks/${task.id}/claim`,{expectedAssignmentEpoch:epoch});
 expect(response.status).toBe(cap==='parent'?200:403);
 expect((await pool.query('SELECT owner_principal_id FROM tasks WHERE id=$1',[task.id])).rows[0].owner_principal_id).toBe(cap==='parent'?child.id:null);
 if(cap==='parent') {
  const rows=(await pool.query('SELECT * FROM tasks WHERE id=$1',[task.id])).rows;
  const events=(await pool.query('SELECT * FROM feed_events WHERE object_id=$1 ORDER BY cursor',[task.id])).rows;
  expect((await call(child,'POST',`/tasks/${task.id}/claim`,{expectedAssignmentEpoch:epoch})).status).toBe(200);
  expect((await pool.query('SELECT * FROM tasks WHERE id=$1',[task.id])).rows).toEqual(rows);
  expect((await pool.query('SELECT * FROM feed_events WHERE object_id=$1 ORDER BY cursor',[task.id])).rows).toEqual(events);
 }
 expect(await archiveState(task.id)).toEqual(before);expect(await sponsorAudit(task.id)).toEqual(audit);
 expect((await pool.query('SELECT id FROM task_native_executions WHERE task_id=$1',[task.id])).rows).toEqual([]);
 expect((await grants(task.id)).some((x:any)=>x.grantee_id===parent.id&&x.verb==='write')).toBe(false);
});
