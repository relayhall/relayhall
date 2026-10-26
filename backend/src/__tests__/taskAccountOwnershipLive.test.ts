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
async function human(role="user"):Promise<Caller>{
 const row=(await pool.query("INSERT INTO principals(kind,handle,status,role) VALUES('human',$1,'active',$2) RETURNING id",[name(),role])).rows[0];
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

const { auditService } = require('../services/AuditService');
async function ownership(who:Caller,id:string){
 const result=await call(who,'GET',`/tasks/${id}/account-owner`);expect(result.status).toBe(200);return result.body.ownership;
}
function changeBody(state:any,target:string){return {accountOwnerPrincipalId:target,
 expectedAccountOwnerPrincipalId:state.accountOwnerPrincipalId,expectedUpdatedAt:state.updatedAt,reason:'Owner-approved account correction'};}
async function transfer(who:Caller,id:string,body:any){return call(who,'PUT',`/tasks/${id}/account-owner`,body);}

test('appointed Main transfers account ownership, preserves task roles and independent grants, destination gains Main control',async()=>{
 const f=await fixture();
 await call(f.owner,'POST',`/principals/${f.main.id}/owner-control`,{enabled:true,reason:'fixture'});
 const before=(await pool.query('SELECT creator_principal_id,owner_principal_id,shepherd_principal_id,verifier_principal_id,status FROM tasks WHERE id=$1',[f.task.id])).rows[0];
 const grants=(await pool.query("SELECT id FROM grants WHERE resource_type='task' AND resource_id=$1 ORDER BY id",[f.task.id])).rows;
 const state=await ownership(f.main,f.task.id);
 expect(await transfer(f.main,f.task.id,changeBody(state,f.foreign.id))).toMatchObject({status:200,body:{ownership:{changed:true,accountOwnerPrincipalId:f.foreign.id}}});
 const after=(await pool.query('SELECT creator_principal_id,owner_principal_id,shepherd_principal_id,verifier_principal_id,status FROM tasks WHERE id=$1',[f.task.id])).rows[0];
 expect(after).toEqual(before);
 expect((await pool.query("SELECT id FROM grants WHERE resource_type='task' AND resource_id=$1 ORDER BY id",[f.task.id])).rows).toEqual(grants);
 expect((await call(f.foreign,'GET',`/tasks/${f.task.id}`)).body.task.ownerControl).toBe(true);
 expect((await call(f.main,'GET',`/tasks/${f.task.id}`)).body.task.ownerControl).toBe(false);
 const audit=(await pool.query("SELECT metadata FROM audit_events WHERE resource_id=$1 AND action='task.account_owner.change'",[f.task.id])).rows;
 expect(audit).toHaveLength(1);expect(audit[0].metadata).toMatchObject({oldAccountOwnerPrincipalId:f.owner.id,newAccountOwnerPrincipalId:f.foreign.id,independentVerification:false});
});
test('human owner and qualified human admin can transfer; other-account and unappointed service cannot',async()=>{
 const f=await fixture();const state=await ownership(f.owner,f.task.id);const body=changeBody(state,f.foreign.id);
 const hidden=await transfer(f.foreign,f.task.id,body);
 const absent=await transfer(f.foreign,crypto.randomUUID(),body);
 expect(hidden.status).toBe(404);expect(hidden.body).toEqual(absent.body);
 expect((await transfer(f.main,f.task.id,body)).status).toBe(403);
 expect((await transfer(f.owner,f.task.id,body)).status).toBe(200);
 const admin=await human('admin');const now=await ownership(admin,f.task.id);
 expect((await transfer(admin,f.task.id,changeBody(now,f.owner.id))).status).toBe(200);
});
test('revoked Main and task-bound agent cannot transfer',async()=>{
 const f=await fixture();const body=changeBody(await ownership(f.owner,f.task.id),f.foreign.id);
 await call(f.owner,'POST',`/principals/${f.main.id}/owner-control`,{enabled:true,reason:'fixture'});
 await call(f.owner,'POST',`/principals/${f.main.id}/owner-control`,{enabled:false,reason:'fixture'});
 expect((await transfer(f.main,f.task.id,body)).status).toBe(403);
 const agent=await connector(f.owner);
 await pool.query("UPDATE principals SET kind='agent',bound_task_id=$2 WHERE id=$1",[agent.id,f.task.id]);
 expect([403,404]).toContain((await transfer(agent,f.task.id,body)).status);
});
test('stale timestamp, stale owner and competing transfers never overwrite newer state',async()=>{
 const f=await fixture();const admin=await human('admin');const other=await human();
 const state=await ownership(admin,f.task.id);const body=changeBody(state,f.foreign.id);
 expect((await transfer(admin,f.task.id,{...body,expectedUpdatedAt:'old'})).status).toBe(412);
 expect((await transfer(admin,f.task.id,{...body,expectedAccountOwnerPrincipalId:other.id})).status).toBe(412);
 const outcomes=await Promise.all([transfer(admin,f.task.id,body),transfer(admin,f.task.id,changeBody(state,other.id))]);
 expect(outcomes.map(x=>x.status).sort()).toEqual([200,412]);
 expect((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='task.account_owner.change' AND resource_id=$1",[f.task.id])).rows[0].n).toBe(1);
});
test('invalid targets, empty reason and archived task are refused',async()=>{
 const f=await fixture();const body=changeBody(await ownership(f.owner,f.task.id),f.foreign.id);
 expect((await transfer(f.owner,f.task.id,{...body,reason:''})).status).toBe(422);
 expect((await transfer(f.owner,f.task.id,{...body,accountOwnerPrincipalId:f.main.id})).status).toBe(422);
 await pool.query("UPDATE principals SET status='disabled' WHERE id=$1",[f.foreign.id]);
 expect((await transfer(f.owner,f.task.id,body)).status).toBe(422);
 await call(f.owner,'POST',`/tasks/${f.task.id}/archive`,{});
 expect((await transfer(f.owner,f.task.id,body)).status).toBe(409);
});
test('audit failure rolls back owner, timestamp, history and access event',async()=>{
 const f=await fixture();const state=await ownership(f.owner,f.task.id);const original=auditService.record;
 const eventsBefore=(await pool.query("SELECT count(*)::int AS n FROM feed_events WHERE name='task.acl_changed' AND object_id=$1",[f.task.id])).rows[0].n;
 auditService.record=async()=>{throw new Error('synthetic audit failure');};
 try{expect((await transfer(f.owner,f.task.id,changeBody(state,f.foreign.id))).status).toBe(503);}finally{auditService.record=original;}
 expect(await ownership(f.owner,f.task.id)).toEqual(state);
 expect((await pool.query("SELECT count(*)::int AS n FROM feed_events WHERE name='task.acl_changed' AND object_id=$1",[f.task.id])).rows[0].n).toBe(eventsBefore);
});

test('session downgrade while waiting for Task lock removes administrator transfer authority',async()=>{
 const f=await fixture();const admin=await human('admin');const body=changeBody(await ownership(admin,f.task.id),f.foreign.id);
 const lock=await pool.connect();let pending:Promise<any>|undefined;
 try{
  await lock.query('BEGIN');await lock.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[f.task.id]);
  pending=transfer(admin,f.task.id,body);
  let waiting=false;
  for(let i=0;i<100;i++){
   const row=await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT *, updated_at::text AS owner_revision FROM tasks%'");
   if(row.rows[0].n>0){waiting=true;break;}
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  expect(waiting).toBe(true);
  await pool.query("UPDATE auth_sessions SET role_snapshot='viewer' WHERE principal_id=$1",[admin.id]);
  await lock.query('COMMIT');expect((await pending).status).toBe(403);
 }finally{await lock.query('ROLLBACK');lock.release();if(pending)await pending;}
 expect((await ownership(f.owner,f.task.id)).accountOwnerPrincipalId).toBe(f.owner.id);
});


test('Main MCP transports exact conditional transfer and preserves stale-state refusal',async()=>{
 const f=await fixture();
 await pool.query('UPDATE principals SET owner_control_account_id=$2 WHERE id=$1',[f.main.id,f.owner.id]);
 const {toolByName}=require('../mcp/registry');
 const read=toolByName('relayhall_task_account_owner_get');
 const write=toolByName('relayhall_task_account_owner_change');
 const ctx={authorization:f.main.headers.Authorization,toolName:read.name};
 const state=JSON.parse(await read.handler({task:f.task.id},ctx)).ownership;
 const args={task:f.task.id,...changeBody(state,f.foreign.id)};
 const receipt=JSON.parse(await write.handler(args,{...ctx,toolName:write.name}));
 expect(receipt.ownership).toMatchObject({changed:true,accountOwnerPrincipalId:f.foreign.id});
 // A transfer cannot be replayed by refreshing its condition implicitly.
 await expect(write.handler(args,{...ctx,toolName:write.name})).rejects.toThrow();
 expect((await pool.query('SELECT account_owner_principal_id FROM tasks WHERE id=$1',[f.task.id])).rows[0].account_owner_principal_id).toBe(f.foreign.id);
});
