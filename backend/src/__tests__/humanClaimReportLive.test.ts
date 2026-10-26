/**
 * Card 3fc32dd1: the human Claim and the progress Report path, measured through
 * the production router with dashboard login sessions against a real
 * disposable PostgreSQL. Disposable targets only.
 *
 * The owner's production smoke created and armed a Task, clicked Claim Task,
 * received HTTP 200 and saw nothing else. Creation does not assign a Task: that
 * 200 was the claim itself, and the human became the Assignee. The claimant
 * that may maintain a progress Report is the Task's Assignee
 * (tasks.owner_principal_id, mirrored as task_assignments.claimant_principal_id),
 * a human Account exactly as a Connector, and maintenance opens while the Task
 * is In progress. These tests hold the whole dashboard path to that, hold every
 * claim refusal to the reason the lifecycle projection shows, and hold every
 * claim outcome to one task.claim audit row.
 */
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
jest.setTimeout(120000);
let server:http.Server,origin:string;
type Caller={id:string;headers:Record<string,string>};
const tag=()=>`human-claim-${crypto.randomBytes(6).toString('hex')}`;
async function call(who:Caller,method:string,path:string,body?:unknown) {
  const response=await fetch(origin+path,{method,headers:{'Content-Type':'application/json',...who.headers},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json() as any};
}
/** A dashboard login session, exactly as the SSO return path mints one. */
async function human(role='user'):Promise<Caller> {
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

/** The dashboard's own create: POST /tasks as the signed-in human. */
async function created(who:Caller) {
  const response=await call(who,'POST','/tasks',{title:tag(),status:'todo'});
  expect(response.status).toBe(201);return response.body.task;
}
const view=async(who:Caller,taskId:string)=>{
  const response=await call(who,'GET',`/tasks/${taskId}`);expect(response.status).toBe(200);return response.body.task;
};
const claim=(who:Caller,taskId:string)=>call(who,'POST',`/tasks/${taskId}/claim`,{});
const save=(who:Caller,taskId:string,body:unknown)=>call(
  {...who,headers:{...who.headers,'Idempotency-Key':`human-claim-save-${crypto.randomUUID()}`}},'POST',`/tasks/${taskId}/reports`,body);
const assignee=async(taskId:string)=>(await pool.query('SELECT owner_principal_id FROM tasks WHERE id=$1',[taskId])).rows[0].owner_principal_id;
/** Every task.claim row for one Task, oldest first: who, and how it ended. */
async function claimAudit(taskId:string) {
  return (await pool.query(`SELECT outcome,actor_principal_id,metadata FROM audit_events
    WHERE action='task.claim' AND resource_type='task' AND resource_id=$1 ORDER BY occurred_at,id`,[taskId])).rows
    .map((row:any)=>({outcome:row.outcome,actor:row.actor_principal_id,reason:row.metadata?.reason??null}));
}
const claimedEntries=async(taskId:string)=>(await pool.query(
  "SELECT COUNT(*)::int AS n FROM task_stream_entries WHERE task_id=$1 AND event_type='task.claimed'",[taskId])).rows[0].n;
/** Task READ and WRITE for a second human: everything except the Assignee role. */
async function grantWrite(principalId:string,taskId:string,by:string) {
  for (const verb of ['read','write'])
    await pool.query(`INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id)
      VALUES('principal',$1,'task',$2,$3,$4)`,[principalId,taskId,verb,by]);
}

// Both human roles: the production owner signs in as an administrator.
test.each(['user','admin'])('dashboard path (%s): a created Task is unassigned, Claim makes the human its Assignee and claimant, and In progress opens save, bounded list, per-Report read and hash-guarded edit',async role=>{
  const owner=await human(role),task=await created(owner);
  // Creation does not assign the creator: the owner's 200 was the claim itself.
  expect(task.ownerPrincipalId).toBeNull();
  expect((await view(owner,task.id)).reportMaintenanceAccess).toEqual({allowed:false,reason:'TASK_CLAIMANT_REQUIRED'});
  expect((await call(owner,'PATCH',`/tasks/${task.id}`,{autoStart:true})).status).toBe(200);
  expect((await view(owner,task.id)).lifecycleAccess.claim).toEqual({allowed:true,reason:null});

  const claimed=await claim(owner,task.id);
  expect(claimed.status).toBe(200);
  expect(claimed.body.claim).toEqual({outcome:'claimed'});
  expect([claimed.body.task.ownerPrincipalId,claimed.body.task.status]).toEqual([owner.id,'todo']);
  expect(await claimAudit(task.id)).toEqual([{outcome:'success',actor:owner.id,reason:null}]);
  expect(await claimedEntries(task.id)).toBe(1);
  // The human Assignee is the claimant: the same column a Connector's claim writes.
  expect((await pool.query('SELECT claimant_principal_id FROM task_assignments WHERE task_id=$1',[task.id])).rows[0].claimant_principal_id).toBe(owner.id);
  expect((await view(owner,task.id)).reportMaintenanceAccess).toEqual({allowed:false,reason:'TASK_REPORT_FROZEN'});

  // Claiming again is the accepted retry; the answer says so and nothing new is written.
  const again=await claim(owner,task.id);
  expect([again.status,again.body.claim]).toEqual([200,{outcome:'already_assignee'}]);
  expect(await claimAudit(task.id)).toHaveLength(1);
  expect(await claimedEntries(task.id)).toBe(1);

  // Before In progress the claimant is refused as frozen, not as unclaimed.
  const early=await save(owner,task.id,{title:'Too early',content:'not yet'});
  expect([early.status,early.body.code]).toEqual([409,'TASK_REPORT_FROZEN']);
  expect((await call(owner,'PATCH',`/tasks/${task.id}`,{status:'in-progress'})).status).toBe(200);
  expect((await view(owner,task.id)).reportMaintenanceAccess).toEqual({allowed:true,reason:null});

  const first=await save(owner,task.id,{title:'Progress',content:'first draft body'});
  expect(first.status).toBe(201);
  const reportId=first.body.report.id,firstHash=first.body.report.content_hash;
  expect([first.body.report.author_principal_id,first.body.report.source_task_id]).toEqual([owner.id,task.id]);

  // The bounded envelope: one summary, its hash, no body, no further page.
  const listed=await call(owner,'GET',`/tasks/${task.id}/reports?scope=progress`);
  expect(listed.status).toBe(200);
  expect(listed.body.reports.map((row:any)=>[row.id,row.relevance,row.contentHash])).toEqual([[reportId,'progress',firstHash]]);
  expect(listed.body.reports[0]).not.toHaveProperty('content');
  expect(listed.body.pagination).toMatchObject({total:1,returned:1,hasMore:false,nextCursor:null});

  const read=await call(owner,'GET',`/tasks/${task.id}/reports/${reportId}`);
  expect([read.status,read.body.report.content,read.body.report.content_hash]).toEqual([200,'first draft body',firstHash]);

  const edited=await save(owner,task.id,{reportId,expectedContentHash:firstHash,title:'Progress',content:'second draft body'});
  expect([edited.status,edited.body.report.id]).toEqual([200,reportId]);
  expect(edited.body.report.content_hash).not.toBe(firstHash);
  const stale=await save(owner,task.id,{reportId,expectedContentHash:firstHash,title:'Progress',content:'lost update'});
  expect([stale.status,stale.body.code]).toEqual([409,'TASK_REPORT_CONFLICT']);
  const reread=await call(owner,'GET',`/tasks/${task.id}/reports/${reportId}`);
  expect([reread.body.report.content,reread.body.report.content_hash]).toEqual(['second draft body',edited.body.report.content_hash]);
});

test('a non-Assignee human with Task write is refused the claim and Report maintenance; the claim refusal is audited',async()=>{
  const owner=await human(),other=await human(),task=await created(owner);
  await grantWrite(other.id,task.id,owner.id);
  expect((await call(owner,'PATCH',`/tasks/${task.id}`,{autoStart:true})).status).toBe(200);
  expect((await claim(owner,task.id)).status).toBe(200);
  expect((await call(owner,'PATCH',`/tasks/${task.id}`,{status:'in-progress'})).status).toBe(200);
  const mine=await save(owner,task.id,{title:'Owner progress',content:'owner body'});
  expect(mine.status).toBe(201);

  const seen=await view(other,task.id);
  expect(seen.lifecycleAccess.claim).toEqual({allowed:false,reason:'TASK_ALREADY_ASSIGNED'});
  expect(seen.reportMaintenanceAccess).toEqual({allowed:false,reason:'TASK_CLAIMANT_REQUIRED'});

  const refused=await claim(other,task.id);
  expect([refused.status,refused.body.success,refused.body.code,refused.body.details]).toEqual([409,false,'TASK_ALREADY_ASSIGNED',{reason:'TASK_ALREADY_ASSIGNED'}]);
  expect(await assignee(task.id)).toBe(owner.id);
  expect(await claimAudit(task.id)).toEqual([
    {outcome:'success',actor:owner.id,reason:null},
    {outcome:'denied',actor:other.id,reason:'TASK_ALREADY_ASSIGNED'},
  ]);

  const created_=await save(other,task.id,{title:'Not mine',content:'refused'});
  expect([created_.status,created_.body.code]).toEqual([403,'TASK_CLAIMANT_REQUIRED']);
  const overwrite=await save(other,task.id,{reportId:mine.body.report.id,expectedContentHash:mine.body.report.content_hash,title:'Owner progress',content:'overwritten'});
  expect([overwrite.status,overwrite.body.code]).toEqual([403,'TASK_CLAIMANT_REQUIRED']);
  expect((await pool.query('SELECT content FROM reports WHERE source_task_id=$1',[task.id])).rows).toEqual([{content:'owner body'}]);
});

// Each refusal the route can reach: the projection names the reason first, the
// route answers that reason (never 200), the Assignee is unchanged, and one
// denied task.claim row records it.
test.each([
  ['unarmed','TASK_NOT_ARMED','TASK_NOT_ARMED'],
  ['verifier','INDEPENDENT_VERIFIER','CLAIMANT_VERIFIER_CONFLICT'],
  ['blocked','TASK_BLOCKED','TASK_DEPENDENCY_BLOCKED'],
  ['assigned','TASK_ALREADY_ASSIGNED','TASK_ALREADY_ASSIGNED'],
])('%s: claim refusal answers 409 with the projected reason and an audited denial',async(mode,reason,code)=>{
  const user=await human(),task=await created(user);
  let holder:string|null=null;
  if (mode!=='unarmed') await pool.query('UPDATE tasks SET auto_start=TRUE WHERE id=$1',[task.id]);
  if (mode==='verifier') await pool.query('UPDATE tasks SET verifier_principal_id=$2 WHERE id=$1',[task.id,user.id]);
  if (mode==='blocked') {
    const prerequisite=(await pool.query("INSERT INTO tasks(title,status) VALUES($1,'todo') RETURNING id",[tag()])).rows[0].id;
    await pool.query('INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES($1,$2)',[task.id,prerequisite]);
  }
  if (mode==='assigned') {holder=(await human()).id;await pool.query('UPDATE tasks SET owner_principal_id=$2 WHERE id=$1',[task.id,holder]);}
  expect((await view(user,task.id)).lifecycleAccess.claim).toEqual({allowed:false,reason});
  const refused=await claim(user,task.id);
  expect([refused.status,refused.body.success,refused.body.code,refused.body.details]).toEqual([409,false,code,{reason}]);
  expect(await assignee(task.id)).toBe(holder);
  expect(await claimAudit(task.id)).toEqual([{outcome:'denied',actor:user.id,reason}]);
  expect(await claimedEntries(task.id)).toBe(0);
});

test('authority refusal is a 403 before the claim route, and the projection already disabled it',async()=>{
  const owner=await human(),reader=await human(),task=await created(owner);
  await pool.query(`INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id)
    VALUES('principal',$1,'task',$2,'read',$3)`,[reader.id,task.id,owner.id]);
  expect((await call(owner,'PATCH',`/tasks/${task.id}`,{autoStart:true})).status).toBe(200);
  expect((await view(reader,task.id)).lifecycleAccess.claim).toEqual({allowed:false,reason:'TASK_WRITE_REQUIRED'});
  const refused=await claim(reader,task.id);
  expect([refused.status,refused.body.success]).toEqual([403,false]);
  expect(await assignee(task.id)).toBeNull();
});
