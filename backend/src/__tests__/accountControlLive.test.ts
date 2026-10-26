/** Real PostgreSQL and HTTP authority checks on a disposable local database. */
import crypto from 'crypto';
import http from 'http';
import { standaloneReportTestTarget } from './support/standaloneReportTestTarget';
const parsed=standaloneReportTestTarget(process.env.RELAYHALL_TEST_DB_URL,process.env.CI);
Object.assign(process.env, { DB_HOST: parsed.hostname, DB_PORT: parsed.port,
  DB_NAME: parsed.pathname.slice(1), DB_USER: decodeURIComponent(parsed.username),
  DB_PASSWORD: decodeURIComponent(parsed.password), NODE_ENV:'test', RELAYHALL_SESSIONS:'on',
  JWT_SECRET: crypto.randomBytes(32).toString('hex') });
const express = require('express');
const {pool} = require('../db/connection');
const {authMiddleware} = require('../middleware/auth');
const {sharedAuthorizationMiddleware} = require('../middleware/sharedAuthorization');
const {loginSessionService,SESSION_COOKIE_NAME} = require('../services/LoginSessionService');
const {principalService} = require('../services/PrincipalService');
const {apiErrorHandler} = require('../utils/apiErrors');
jest.setTimeout(30000);
type Caller = {id:string; headers:Record<string,string>};
let server:http.Server, origin:string;
const name=()=> 'owner-control-'+crypto.randomBytes(7).toString('hex');
async function human():Promise<Caller>{
 const row=(await pool.query("INSERT INTO principals(kind,handle,status,role) VALUES('human',$1,'active','user') RETURNING id",[name()])).rows[0];
 const session=await loginSessionService.mint({principalId:row.id});
 return {id:row.id,headers:{Cookie:`${SESSION_COOKIE_NAME}=${session.token}`}};
}
async function connector(parent:Caller):Promise<Caller>{
 const row=(await pool.query("INSERT INTO principals(kind,handle,status,parent_principal_id,purpose,own_expression) VALUES('service',$1,'active',$2,'Disposable owner-control proof',$3) RETURNING id",
 [name(),parent.id,JSON.stringify({scopes:'parent',objects:'parent'})])).rows[0];
 const credential=await principalService.issueCredential({principalId:row.id,
 scopes:['tasks:read','tasks:write','projects:read','projects:write','phases:read','phases:write','reports:read','reports:write'],transport:'any'},
 {handle:'disposable-owner-control',authMethod:'system'});
 return {id:row.id,headers:{Authorization:`Bearer ${credential.fullKey}`}};
}
async function call(who:Caller,method:string,path:string,body?:unknown,headers:Record<string,string>={}){
 const res=await fetch(origin+path,{method,headers:{'Content-Type':'application/json',...who.headers,...headers},
 body:body===undefined?undefined:JSON.stringify(body)});
 return {status:res.status,body:await res.json() as any};
}
async function fixture(){
 const owner=await human(),main=await connector(owner),foreign=await human();
 const project=(await pool.query("INSERT INTO projects(name,owner_principal_id) VALUES($1,$2) RETURNING id,name",[name(),owner.id])).rows[0];
 const created=await call(main,'POST','/tasks',{title:name(),project:project.name,subtasks:[{text:'first',status:'empty'},{text:'second',status:'empty'}]});
 expect(created).toMatchObject({status:201});
 return {owner,main,foreign,project,task:created.body.task};
}
beforeAll(async()=>{
 const app=express();app.use(express.json());
 for(const [path,file] of [['tasks','tasks'],['reports','reports'],['principals','principals'],['projects','projects'],['phases','phases']]){
  app.use('/'+path,authMiddleware,sharedAuthorizationMiddleware,require('../routes/'+file).default);
 }
 app.use(apiErrorHandler);
 await new Promise<void>(resolve=>{server=app.listen(0,'127.0.0.1',resolve);});
 origin='http://127.0.0.1:'+(server.address() as any).port;
});
afterAll(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();});
test('owner/Main complete explicit children and task; no verifier verdict is invented',async()=>{
 const f=await fixture();
 expect((await call(f.owner,'GET','/tasks/'+f.task.id)).body.task.ownerControl).toBe(true);
 expect((await call(f.main,'GET','/tasks/'+f.task.id)).body.task.ownerControl).toBe(false);
 expect((await pool.query('SELECT account_owner_principal_id FROM tasks WHERE id=$1',[f.task.id])).rows[0].account_owner_principal_id).toBe(f.owner.id);
 expect((await call(f.main,'PATCH','/tasks/'+f.task.id,{status:'completed'})).status).toBe(403);
 expect((await call(f.foreign,'POST','/principals/'+f.main.id+'/owner-control',{enabled:true,reason:'foreign'})).status).toBe(403);
 expect((await call(f.owner,'POST','/principals/'+f.main.id+'/owner-control',{enabled:true,reason:'acceptance fixture'})).status).toBe(200);
 expect((await call(f.main,'GET','/tasks/'+f.task.id)).body.task.ownerControl).toBe(true);
 expect((await call(f.main,'PATCH','/tasks/'+f.task.id,{status:'completed'})).status).toBe(409);
 for(const subtask of f.task.subtasks){
  expect(await call(f.main,'PATCH',`/tasks/${f.task.id}/subtasks/by-id/${subtask.id}/status`,{status:'completed'})).toMatchObject({status:200});
 }
 expect(await call(f.main,'PATCH','/tasks/'+f.task.id,{status:'completed'})).toMatchObject({status:200,body:{task:{status:'completed'}}});
 expect((await pool.query('SELECT verifier_principal_id,review_history FROM tasks WHERE id=$1',[f.task.id])).rows[0])
  .toMatchObject({verifier_principal_id:null});
 const audit=(await pool.query("SELECT metadata FROM audit_events WHERE resource_id=$1 AND action='task.account_disposition'",[f.task.id])).rows;
 expect(audit).toHaveLength(3);
 expect(audit.every((row:any)=>row.metadata.independentVerification===false)).toBe(true);
 expect((await call(f.foreign,'GET','/tasks/'+f.task.id)).status).toBe(404);
});
test('owner can administer directly; revoked Main appointment immediately loses closure ability',async()=>{
 const f=await fixture();
 expect((await call(f.owner,'GET','/tasks/'+f.task.id)).status).toBe(200);
 expect((await call(f.owner,'POST','/principals/'+f.main.id+'/owner-control',{enabled:true,reason:'fixture'})).status).toBe(200);
 expect((await call(f.owner,'POST','/principals/'+f.main.id+'/owner-control',{enabled:false,reason:'revoke fixture'})).status).toBe(200);
 const subtask=f.task.subtasks[0];
 expect((await call(f.main,'PATCH',`/tasks/${f.task.id}/subtasks/by-id/${subtask.id}/status`,{status:'completed'})).status).toBe(403);
 expect((await call(f.owner,'PATCH',`/tasks/${f.task.id}/subtasks/by-id/${subtask.id}/status`,{status:'completed'})).status).toBe(200);
 expect((await call(f.owner,'POST','/tasks/'+f.task.id+'/archive',{})).status).toBe(200);
 expect((await call(f.owner,'POST','/tasks/'+f.task.id+'/unarchive',{})).status).toBe(200);
});
test('Main cannot appoint itself and private report ownership stays with the creator account',async()=>{
 const f=await fixture();
 expect((await call(f.main,'POST','/principals/'+f.main.id+'/owner-control',{enabled:true,reason:'self escalation'})).status).toBe(403);
 const report=await call(f.main,'POST','/reports',{title:name(),content:'Private owner proof',visibility:'private'});
 expect(report).toMatchObject({status:201});
 expect((await pool.query('SELECT account_owner_principal_id FROM reports WHERE id=$1',[report.body.report.id])).rows[0].account_owner_principal_id).toBe(f.owner.id);
 expect((await call(f.owner,'PATCH','/reports/'+report.body.report.id,{summary:'owner maintained'})).status).toBe(200);
 expect((await call(f.foreign,'GET','/reports/'+report.body.report.id)).status).toBe(404);
});

test('ordinary owner creates and manages Project, Phase and Report without global admin',async()=>{
 const owner=await human(),foreign=await human();
 const project=await call(owner,'POST','/projects',{name:name()});
 expect(project).toMatchObject({status:201});
 const pid=project.body.project.id;
 expect((await pool.query('SELECT owner_principal_id FROM projects WHERE id=$1',[pid])).rows[0].owner_principal_id).toBe(owner.id);
 const phase=await call(owner,'POST','/phases',{name:'Acceptance phase',projectId:pid});
 expect(phase).toMatchObject({status:201});
 const phid=phase.body.phase.id;
 expect((await call(owner,'PATCH','/phases/'+phid,{goal:'owner edit',revision:phase.body.phase.revision})).status).toBe(200);
 expect((await call(owner,'POST','/phases/'+phid+'/archive',{revision:(await call(owner,'GET','/phases/'+phid)).body.phase.revision})).status).toBe(200);
 expect((await call(owner,'POST','/phases/'+phid+'/unarchive',{revision:(await call(owner,'GET','/phases/'+phid)).body.phase.revision})).status).toBe(200);
 expect((await call(foreign,'DELETE','/phases/'+phid)).status).toBeGreaterThanOrEqual(400);
 expect((await call(owner,'DELETE','/phases/'+phid)).status).toBe(200);
 const report=await call(owner,'POST','/reports',{title:name(),content:'owner deletion proof',visibility:'private'});
 expect(report).toMatchObject({status:201});
 expect((await call(foreign,'DELETE','/reports/'+report.body.report.id+'?hard=true')).status).toBeGreaterThanOrEqual(400);
 expect((await call(owner,'DELETE','/reports/'+report.body.report.id+'?hard=true')).status).toBe(200);
 expect((await call(owner,'POST','/projects/'+pid+'/archive',{}, {'If-Match':(await call(owner,'GET','/projects/'+pid)).body.project.revision})).status).toBe(200);
 expect((await call(owner,'POST','/projects/'+pid+'/unarchive',{}, {'If-Match':(await call(owner,'GET','/projects/'+pid)).body.project.revision})).status).toBe(200);
});


test('appointed write-scoped Main manages owned Phase, Report and Project transfer without global admin',async()=>{
 const f=await fixture();
 expect((await call(f.owner,'POST','/principals/'+f.main.id+'/owner-control',{enabled:true,reason:'fixture'})).status).toBe(200);
 const phase=await call(f.main,'POST','/phases',{name:name(),projectId:f.project.id});
 expect(phase).toMatchObject({status:201});
 expect((await call(f.main,'DELETE','/phases/'+phase.body.phase.id)).status).toBe(200);
 const report=await call(f.main,'POST','/reports',{title:name(),content:'Main hard delete proof',visibility:'private'});
 expect(report).toMatchObject({status:201});
 expect((await call(f.main,'DELETE','/reports/'+report.body.report.id+'?hard=true')).status).toBe(200);
 const audit=(await pool.query("SELECT actor_principal_id,metadata FROM audit_events WHERE resource_id=$1 AND action='report.hard_delete'",[report.body.report.id])).rows;
 expect(audit).toHaveLength(1);expect(audit[0]).toMatchObject({actor_principal_id:f.main.id,metadata:{accountPrincipalId:f.owner.id}});
 const revision=(await call(f.main,'GET','/projects/'+f.project.id)).body.project.revision;
 expect(await call(f.main,'PUT','/projects/'+f.project.id+'/owner',{ownerPrincipalId:f.foreign.id},{'If-Match':revision})).toMatchObject({status:200});
 // Former owner's Main cannot administratively dispose the transferred project.
 expect((await call(f.main,'DELETE','/projects/'+f.project.id)).status).toBeGreaterThanOrEqual(400);
});

test('reparenting and actual credential revocation do not retain appointed Main authority',async()=>{
 const f=await fixture();
 expect((await call(f.owner,'POST','/principals/'+f.main.id+'/owner-control',{enabled:true,reason:'fixture'})).status).toBe(200);
 const path=`/tasks/${f.task.id}/subtasks/by-id/${f.task.subtasks[0].id}/status`;
 await pool.query('UPDATE principals SET parent_principal_id=$2 WHERE id=$1',[f.main.id,f.foreign.id]);
 expect((await call(f.main,'PATCH',path,{status:'completed'})).status).toBeGreaterThanOrEqual(400);
 await pool.query('UPDATE principals SET parent_principal_id=$2 WHERE id=$1',[f.main.id,f.owner.id]);
 await pool.query('UPDATE principal_credentials SET revoked_at=clock_timestamp() WHERE principal_id=$1',[f.main.id]);
 expect((await call(f.main,'PATCH',path,{status:'completed'})).status).toBe(401);
});

test('hard deletion rechecks Main appointment after waiting on the Report lock',async()=>{
 const f=await fixture();
 await call(f.owner,'POST','/principals/'+f.main.id+'/owner-control',{enabled:true,reason:'fixture'});
 const report=await call(f.main,'POST','/reports',{title:name(),content:'revocation contention',visibility:'private'});
 expect(report).toMatchObject({status:201});const id=report.body.report.id;
 const blocker=await pool.connect();
 try{
  await blocker.query('BEGIN');await blocker.query('SELECT id FROM reports WHERE id=$1 FOR UPDATE',[id]);
  const pending=call(f.main,'DELETE','/reports/'+id+'?hard=true');
  let waiting=false;
  for(let i=0;i<100;i++){
   const rows=await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM reports WHERE id=%FOR UPDATE'");
   if(rows.rowCount){waiting=true;break;}await new Promise(r=>setTimeout(r,20));
  }
  expect(waiting).toBe(true);
  expect((await call(f.owner,'POST','/principals/'+f.main.id+'/owner-control',{enabled:false,reason:'revoke while blocked'})).status).toBe(200);
  await blocker.query('COMMIT');expect((await pending).status).toBe(403);
  expect((await pool.query('SELECT id FROM reports WHERE id=$1',[id])).rowCount).toBe(1);
 }finally{await blocker.query('ROLLBACK');blocker.release();}
});


test('Main authority is not inherited by nested or task-bound delegated agents',async()=>{
 const f=await fixture();
 await call(f.owner,'POST','/principals/'+f.main.id+'/owner-control',{enabled:true,reason:'fixture'});
 await expect(connector(f.main)).rejects.toThrow('Connector');
 const path=`/tasks/${f.task.id}/subtasks/by-id/${f.task.subtasks[0].id}/status`;
 const bound=await connector(f.owner);
 await pool.query("UPDATE principals SET kind='agent',bound_task_id=$2,owner_control_account_id=$3 WHERE id=$1",[bound.id,f.task.id,f.owner.id]);
 expect((await call(bound,'PATCH',path,{status:'completed'})).status).toBeGreaterThanOrEqual(400);
 expect((await call(f.owner,'POST','/principals/'+bound.id+'/owner-control',{enabled:true,reason:'agent escalation'})).status).toBe(403);
});


test('explicit MCP owner completion cannot fall back to an unassigned global reviewer role',async()=>{
 const f=await fixture();
 await pool.query("UPDATE principals SET role='qa',handle=$2 WHERE id=$1",[f.main.id,'qa-'+crypto.randomBytes(8).toString('hex')]);
 const path=`/tasks/${f.task.id}/subtasks/by-id/${f.task.subtasks[0].id}/status`;
 await pool.query("UPDATE subtasks SET status='review' WHERE task_id=$1",[f.task.id]);
 const body={status:'completed',completionMode:'owner',reviewNote:'administrative disposition'};
 expect((await pool.query('SELECT role FROM principals WHERE id=$1',[f.main.id])).rows[0].role).toBe('qa');
 expect(await call(f.main,'PATCH',path,body)).toMatchObject({status:403,body:{code:'ACCOUNT_CONTROL_REQUIRED'}});
 expect((await pool.query('SELECT status FROM subtasks WHERE id=$1',[f.task.subtasks[0].id])).rows[0].status).toBe('review');
 expect((await call(f.owner,'POST','/principals/'+f.main.id+'/owner-control',{enabled:true,reason:'fixture'})).status).toBe(200);
 expect(await call(f.main,'PATCH',path,body)).toMatchObject({status:200});
 expect((await call(f.owner,'POST','/principals/'+f.main.id+'/owner-control',{enabled:false,reason:'fixture revoke'})).status).toBe(200);
 const second=`/tasks/${f.task.id}/subtasks/by-id/${f.task.subtasks[1].id}/status`;
 expect(await call(f.main,'PATCH',second,body)).toMatchObject({status:403,body:{code:'ACCOUNT_CONTROL_REQUIRED'}});
 expect((await call(f.owner,'PATCH',second,body)).status).toBe(200);
 const audit=(await pool.query("SELECT metadata FROM audit_events WHERE resource_id=$1 AND action='task.account_disposition'",[f.task.id])).rows;
 expect(audit).toHaveLength(2);
 expect(audit.every((row:any)=>row.metadata.independentVerification===false)).toBe(true);
});


test('owner/Main create completed tasks and children without inventing verification; delegates and incomplete children refuse atomically',async()=>{
 const f=await fixture();
 const completed={status:'completed',subtasks:[{text:'accepted externally',status:'completed'},{text:'not applicable',status:'skipped'}]};
 const deniedTitle=name();
 expect((await call(f.main,'POST','/tasks',{title:deniedTitle,...completed})).status).toBe(403);
 expect((await pool.query('SELECT id FROM tasks WHERE title=$1',[deniedTitle])).rowCount).toBe(0);
 expect((await call(f.owner,'POST','/principals/'+f.main.id+'/owner-control',{enabled:true,reason:'completed creation proof'})).status).toBe(200);
 for(const who of [f.owner,f.main]){
  const result=await call(who,'POST','/tasks',{title:name(),...completed,project:f.project.name});
  expect(result).toMatchObject({status:201,body:{task:{status:'completed'}}});
  const id=result.body.task.id;
  const row=(await pool.query('SELECT account_owner_principal_id,verifier_principal_id,review_history FROM tasks WHERE id=$1',[id])).rows[0];
  expect(row.account_owner_principal_id).toBe(f.owner.id);expect(row.verifier_principal_id).toBeNull();
  expect(row.review_history || []).toEqual([]);
  const audit=(await pool.query("SELECT metadata FROM audit_events WHERE resource_id=$1 AND action='task.account_disposition'",[id])).rows;
  expect(audit).toHaveLength(1);expect(audit[0].metadata).toMatchObject({basis:'account-owner-control',independentVerification:false,disposition:'explicit-task-create'});
  const incomplete=name();
  expect((await call(who,'POST','/tasks',{title:incomplete,status:'completed',subtasks:[{text:'unfinished',status:'empty'}]})).status).toBe(409);
  expect((await pool.query('SELECT id FROM tasks WHERE title=$1',[incomplete])).rowCount).toBe(0);
  expect((await call(f.foreign,'GET','/tasks/'+id)).status).toBe(404);
 }
 expect((await call(f.owner,'POST','/principals/'+f.main.id+'/owner-control',{enabled:false,reason:'revoke completed creation'})).status).toBe(200);
 expect((await call(f.main,'POST','/tasks',{title:name(),...completed})).status).toBe(403);
 expect((await call(f.foreign,'POST','/tasks',{title:name(),...completed,project:f.project.name})).status).toBe(404);
});
