/** Real PostgreSQL contract: NEVER uses inherited deployment DB settings.
 * This suite is excluded from default Jest; RELAYHALL_TEST_DB_URL is mandatory.
 * It drives the production router/auth stack, writes disposable fixtures, and
 * measures stored effects through independent SQL and ordinary object routes.
 */
import http from 'http';
import crypto from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
const url = process.env.RELAYHALL_TEST_DB_URL;
if (!url) throw new Error('RELAYHALL_TEST_DB_URL is required for the Blueprint live contract');
const parsed = new URL(url);
const database = decodeURIComponent(parsed.pathname.slice(1));
if (!['127.0.0.1','localhost','[::1]','postgres'].includes(parsed.hostname)
  || ['relayhall','relayhall_dev','relayhall_tst','relayhall_prod','clawboard','clawboard_dev','clawboard_prod'].includes(database)
  || (!/(test|contract|fixture)/i.test(database) && !(parsed.hostname === 'postgres' && database === 'relayhall_ci'))) throw new Error('Blueprint live contract requires an explicitly disposable local test database');
Object.assign(process.env, { DB_HOST:parsed.hostname, DB_PORT:parsed.port || '5432', DB_NAME:database,
  DB_USER:decodeURIComponent(parsed.username), DB_PASSWORD:decodeURIComponent(parsed.password), NODE_ENV:'test',
  RELAYHALL_SESSIONS:'on', JWT_SECRET:'blueprint-live-only-jwt-key-0123456789' });
delete process.env.BOOT_CHECK;
const express = require('express');
const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { principalService } = require('../services/PrincipalService');
const { projectService } = require('../services/ProjectService');
const { phaseService } = require('../services/PhaseService');
const { taskManagerDB } = require('../services/TaskManagerDB');
const { reportManager } = require('../services/ReportManager');
const { taskElementService } = require('../services/TaskElementService');
const { toolByName } = require('../mcp/registry');
const { blueprintDigest, blueprintDigests, stableBlueprintJson, blueprintLimits } = require('../utils/blueprintDocument');
interface Caller { id:string; headers:Record<string,string>; accountId?:string }
interface Answer { status:number; body:any; text:string }
let server:http.Server; let origin:string; let author:Caller; let reviewer:Caller; let user:Caller;
const tag = () => crypto.randomBytes(8).toString('hex');
const writes = () => [jest.spyOn(projectService,'create'),jest.spyOn(phaseService,'create'),jest.spyOn(taskManagerDB,'createTask'),
  jest.spyOn(taskManagerDB,'addDependency'),jest.spyOn(taskManagerDB,'assignTaskRoles'),jest.spyOn(reportManager,'create'),jest.spyOn(taskElementService,'createReference')];
async function account(role='admin'):Promise<Caller> {
  const id = (await pool.query("INSERT INTO principals(kind,handle,display_name,status,role) VALUES('human',$1,$1,'active',$2) RETURNING id",[`blueprint-live-${tag()}`,role])).rows[0].id;
  const { token } = await loginSessionService.mint({principalId:id});
  return {id,headers:{Cookie:`${SESSION_COOKIE_NAME}=${token}`}};
}
async function narrow(scopes:string[],parentRole='user'):Promise<Caller> {
  const accountId=(await pool.query("INSERT INTO principals(kind,handle,display_name,status,role,purpose) VALUES('service',$1,$1,'active',$2,'Blueprint live fixture') RETURNING id",[`blueprint-account-${tag()}`,parentRole])).rows[0].id;
  const id=(await pool.query("INSERT INTO principals(kind,handle,display_name,status,parent_principal_id,purpose,own_expression,role) VALUES('service',$1,$1,'active',$2,'Blueprint connector fixture',$3::jsonb,'user') RETURNING id",[`blueprint-connector-${tag()}`,accountId,JSON.stringify({scopes:'parent',objects:'parent'})])).rows[0].id;
  const key=await principalService.issueCredential({principalId:id,scopes,transport:'any'},{principalId:author.id,handle:'blueprint-live',authMethod:'system'});
  return {id,accountId,headers:{Authorization:`Bearer ${key.fullKey}`}};
}
async function grant(who:Caller,kind:string,id:string|null,verbs:string[]) {
  for (const principal of [who.id,...(who.accountId?[who.accountId]:[])]) for(const verb of verbs) await pool.query('INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id) VALUES(\'principal\',$1,$2,$3,$4,$5)',[principal,kind,id,verb,author.id]);
}
async function call(who:Caller,method:string,path:string,body?:unknown,key?:string):Promise<Answer> {
  const response=await fetch(origin+path,{method,headers:{'Content-Type':'application/json',...who.headers,...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await response.text(); let value:any;try{value=JSON.parse(text)}catch{value=text}
  return {status:response.status,body:value,text};
}
async function cli(who:Caller,args:string[]):Promise<{code:number;body:any;stdout:string;stderr:string}> {
 const token=who.headers.Authorization?.replace(/^Bearer /,'');if(!token)throw new Error('CLI fixture requires an ordinary bearer credential');
 return new Promise((resolve,reject)=>{const child=spawn('python3',[path.resolve(__dirname,'../../../cli/relayhall'),'--api',origin,'blueprint',...args],{env:{...process.env,RELAYHALL_TOKEN:token},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',reject);child.once('close',code=>{let body;try{body=JSON.parse(stdout)}catch{body=undefined}resolve({code:code??-1,body,stdout,stderr})})});
}
async function mcp(who:Caller,verb:string,args:any={}) {
 const name='relayhall_blueprint_'+verb;
 return JSON.parse(await toolByName(name).handler({...args,response_format:'detailed'},{authorization:who.headers.Authorization,toolName:name}));
}
function ok(answer:Answer,status=200) { expect({status:answer.status,...(answer.status===status?{}:{body:answer.body})}).toEqual({status}); return answer.body; }
function document(existing=false):any {
 return {schemaVersion:'rh.blueprint/1.0',blueprint:{key:`live-${tag()}`,name:'Live contract',version:1,summary:'',description:'',tags:[],provenance:'human-authored'},
 parameters:[{key:'name',label:'Name',promptText:'Which name?',type:'string',required:false,default:`Project ${tag()}`},
  {key:'unused',label:'Unused',promptText:'Optional note?',type:'string',required:false},
  ...(existing?[{key:'project',label:'Project',promptText:'Which existing Project?',type:'project-ref',required:true}]:[])],
 target:existing?{mode:'existing-project',project:'{{project}}'}:{mode:'new-project',project:{name:'{{name}}'}},
 phases:[{key:'prepare',name:'Prepare',position:0}],tasks:[{key:'first',title:'First {{name}}',phase:'prepare',subtasks:[{text:'Check'}]},{key:'second',title:'Second',phase:'prepare'}],
 dependencies:[{task:'second',dependsOn:'first'}],references:[],humanGates:[],reports:[{key:'record',title:'Record',content:'Ordinary record',tasks:['first','second']}]};
}
async function prerequisiteSkill(name:string) {
 const id=(await pool.query('INSERT INTO skills(name) VALUES($1) RETURNING id',[name])).rows[0].id;
 const version=(await pool.query("INSERT INTO skill_versions(skill_id,version,skill_md,description,provenance,created_by_principal_id) VALUES($1,1,$2,'Synthetic typed reference fixture','human-authored',$3) RETURNING id",[id,'# '+name,author.id])).rows[0].id;
 for(const status of ['draft','review','published'])await pool.query('INSERT INTO skill_version_events(skill_version_id,status,actor_principal_id) VALUES($1,$2,$3)',[version,status,status==='published'?reviewer.id:author.id]);return id;
}
async function draft(doc:any) { return ok(await call(author,'POST','/blueprints',doc),201).blueprint.id as string; }
async function publish(doc:any) { const id=await draft(doc);ok(await call(author,'POST',`/blueprints/${id}/versions/1/submit`,{}));ok(await call(reviewer,'POST',`/blueprints/${id}/versions/1/publish`,{}));return id; }
async function target() { return (await pool.query("INSERT INTO projects(name,status,visibility) VALUES($1,'active','private') RETURNING id",[`Existing ${tag()}`])).rows[0].id as string; }
async function population() {
 const tables=['projects','phases','tasks','subtasks','task_dependencies','reports','blueprint_instantiations','blueprint_instantiation_requests','grants'];
 return Object.fromEntries(await Promise.all(tables.map(async table=>[table,Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n)])));
}
const request=(project?:string,parameterValues:any={})=>({target:project?{mode:'existing-project',project}:{mode:'new-project'},parameterValues:{...parameterValues,...(project?{project}:{})}});
beforeAll(async()=> { const app=express();app.use(express.json(jsonBodyOptions));registerProtectedRoutes((mount:string,...handlers:any[])=>app.use(mount,authMiddleware,sharedAuthorizationMiddleware,...handlers));app.use(apiErrorHandler);await new Promise<void>(resolve=>{server=app.listen(0,'127.0.0.1',resolve)});origin=`http://127.0.0.1:${(server.address() as any).port}`;author=await account();reviewer=await account();user=await account(); });
afterEach(()=>jest.restoreAllMocks());
afterAll(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end()});
jest.setTimeout(90000);

describe('Blueprint live creation, visibility and retry boundaries',()=>{
 test('D-1 identity: every actual canonical writer carries the caller on the same client; all objects have detached stamps',async()=>{
  const doc=document();const skillName='proof-skill-'+tag();const skillId=await prerequisiteSkill(skillName);doc.references=[{kind:'skill',name:skillName,minVersion:1,requirement:'required',usedBy:['first']}];doc.tasks[0].references=[skillName];doc.parameters.push({key:'verifier',label:'Verifier',promptText:'Who verifies?',type:'principal-ref',required:true});doc.tasks[1].roles={verifier:'{{verifier}}'};const id=await publish(doc);const auditBefore=new Set((await pool.query('SELECT id FROM audit_events')).rows.map((row:any)=>row.id));const spies=writes();const response=await call(user,'POST',`/blueprints/${id}/instantiations`,request(undefined,{verifier:reviewer.id}),tag());for(const args of spies[2].mock.calls as any[][])expect(args[1].principalId).toBe(user.id);const result=ok(response,201);
  expect(spies.slice(0,4).map(spy=>spy.mock.calls.length)).toEqual([1,1,2,1]);expect(spies[5]).toHaveBeenCalledTimes(1);expect(spies[4]).toHaveBeenCalledTimes(1);expect(spies[6]).toHaveBeenCalledTimes(1);
  expect((await pool.query('SELECT target_id,created_by_principal_id FROM task_references WHERE task_id=$1',[result.tasks.first])).rows).toEqual([{target_id:skillId,created_by_principal_id:user.id}]);
  expect((await pool.query('SELECT reference_outcomes FROM blueprint_instantiations WHERE id=$1',[result.instantiationId])).rows[0].reference_outcomes).toEqual([expect.objectContaining({name:skillName,outcome:'resolved'})]);
  const client=(spies[0].mock.calls[0] as any[])[2].client;
  for(const [index,txIndex] of [[0,2],[1,1],[2,3],[3,3],[4,3],[5,1],[6,3]]) for(const args of spies[index].mock.calls as any[][]){expect(args[txIndex].actor.principalId).toBe(user.id);expect(args[txIndex].client).toBe(client)}
  expect((spies[0].mock.calls[0] as any[])[1].principalId).toBe(user.id);for(const args of spies[2].mock.calls as any[][])expect(args[1].principalId).toBe(user.id);
  const project=(await pool.query('SELECT instantiated_by_principal_id,instantiation_id,owner_principal_id FROM projects WHERE id=$1',[result.projectId])).rows[0];expect(project.instantiated_by_principal_id).toBe(user.id);expect(project.owner_principal_id).toBeNull();
  const task=ok(await call(user,'GET',`/tasks/${result.tasks.first}`)).task;expect(task.instantiationId).toBe(result.instantiationId);expect(task.subtasks[0].instantiationId).toBe(result.instantiationId);
  const row=(await pool.query('SELECT actor_principal_id FROM blueprint_instantiations WHERE id=$1',[result.instantiationId])).rows[0];expect(row.actor_principal_id).toBe(user.id);
  const auditRows=(await pool.query('SELECT id,actor_principal_id,action FROM audit_events')).rows.filter((row:any)=>!auditBefore.has(row.id));expect(auditRows.length).toBeGreaterThan(0);for(const audit of auditRows)expect(audit.actor_principal_id).toBe(user.id);
  const feed=(await pool.query('SELECT name,actor_principal_id FROM feed_events WHERE object_id=ANY($1::uuid[])',[[...Object.values(result.tasks),...Object.values(result.phases),...Object.values(result.reports)]])).rows;expect(feed.length).toBeGreaterThanOrEqual(5);for(const event of feed)expect(event.actor_principal_id).toBe(user.id);
  const history=(await pool.query('SELECT actor_principal_id FROM task_history WHERE task_id=ANY($1::uuid[])',[Object.values(result.tasks)])).rows;expect(history.length).toBeGreaterThanOrEqual(2);for(const change of history)expect(change.actor_principal_id).toBe(user.id);
 });
 test('D-3 supplied nested placeholder is stored literally in an ordinary Task title',async()=>{
  const doc=document(true);doc.parameters.push({key:'other_param',label:'Other',promptText:'Other text?',type:'string',required:false,default:'Must not replace'});
  const id=await publish(doc);const project=await target();const result=ok(await call(user,'POST',`/blueprints/${id}/instantiations`,request(project,{name:'{{other_param}}'}),tag()),201);
  expect((await pool.query('SELECT title FROM tasks WHERE id=$1',[result.tasks.first])).rows[0].title).toBe('First {{other_param}}');
 });
 test('D-10 required key, default-equivalent reordered retry, changed input and no Grant creation',async()=>{
  const doc=document();const id=await publish(doc);const route=`/blueprints/${id}/instantiations`;const before=await population();
  for(const key of [undefined,'x'.repeat(15),'x'.repeat(129)])expect(await call(user,'POST',route,request(),key)).toMatchObject({status:400,body:{code:'IDEMPOTENCY_KEY_REQUIRED'}});
  expect(await population()).toEqual(before);const key=tag();const first=ok(await call(user,'POST',route,request(),key),201);const after=await population();expect(after.grants).toBe(before.grants);
  const equivalent={parameterValues:{name:doc.parameters[0].default},target:{mode:'new-project'}};
  const replay=await call(user,'POST',route,equivalent,key);expect(replay.status).toBe(201);expect(replay.body).toEqual(first);expect(await population()).toEqual(after);
  expect(await call(user,'POST',route,request(undefined,{name:'Changed'}),key)).toMatchObject({status:409,body:{code:'IDEMPOTENCY_KEY_REUSED'}});expect(await population()).toEqual(after);
 });
 test('D-16 preview has zero work writes and matches actual object and edge counts',async()=>{
  const doc=document();doc.phases=Array.from({length:3},(_,i)=>({key:'phase-'+i,name:'Phase '+i,position:i}));
  doc.tasks=Array.from({length:14},(_,i)=>({key:'work-'+String(i).padStart(2,'0'),title:'Work '+i,phase:'phase-'+i%3,...(i===0?{subtasks:[{text:'Check'}]}:{})}));
  doc.dependencies=doc.tasks.slice(1).map((task:any,i:number)=>({task:task.key,dependsOn:doc.tasks[i].key}));doc.reports[0].tasks=doc.tasks.map((task:any)=>task.key);
  const id=await publish(doc);const before=await population();const auditBefore=(await pool.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n;const spies=writes();
  const preview=ok(await call(user,'POST',`/blueprints/${id}/instantiations/preview`,request()));
  expect(preview.plan.counts).toMatchObject({projects:1,phases:3,tasks:14});expect(await population()).toEqual(before);for(const spy of spies)expect(spy).not.toHaveBeenCalled();
  expect((await pool.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n).toBe(auditBefore);
  const created=ok(await call(user,'POST',`/blueprints/${id}/instantiations`,request(),tag()),201);
  expect(Object.keys(created.tasks)).toEqual(preview.plan.tasks.map((task:any)=>task.key));expect(Object.keys(created.phases).length).toBe(preview.plan.counts.phases);
  const actual=(await pool.query('SELECT id,title,status,priority,auto_start,phase_id FROM tasks WHERE id=ANY($1::uuid[])',[Object.values(created.tasks)])).rows;
  expect(preview.plan.tasks.map((task:any)=>actual.find((row:any)=>row.id===created.tasks[task.key]))).toEqual(preview.plan.tasks.map((task:any)=>({id:created.tasks[task.key],title:task.title,status:task.status??'todo',priority:task.priority??'normal',auto_start:false,phase_id:created.phases[task.phaseKey]})));
  const edges=(await pool.query('SELECT task_id,depends_on_task_id FROM task_dependencies WHERE task_id=ANY($1::uuid[])',[Object.values(created.tasks)])).rows;
  expect(edges).toHaveLength(preview.plan.dependencies.length);expect(edges).toEqual(expect.arrayContaining(preview.plan.dependencies.map((edge:any)=>({task_id:created.tasks[edge.task],depends_on_task_id:created.tasks[edge.dependsOn]}))));
 });
 test('D-19 review is immutable, independent publication required, retirement blocks new work but permits committed replay',async()=>{
  const doc=document();const id=await draft(doc);const route=`/blueprints/${id}/versions/1`;
  expect(await call(reviewer,'POST',route+'/publish',{})).toMatchObject({status:409,body:{code:'BLUEPRINT_VERSION_STATE',error:'Required version state: review'}});
  expect(await call(reviewer,'POST',route+'/retire',{})).toMatchObject({status:409,body:{error:'Required version state: published'}});
  ok(await call(author,'POST',route+'/submit',{}));expect((await call(reviewer,'POST',route+'/retire',{})).status).toBe(409);
  const changed={...doc,tasks:doc.tasks.map((task:any,i:number)=>i===0?{...task,title:'Unreviewed changed title'}:task)};
  const refusedEdit=await call(author,'PATCH',route,changed);
  expect((await pool.query('SELECT document FROM blueprint_versions WHERE blueprint_id=$1 AND version=1',[id])).rows[0].document).toEqual(doc);
  expect(refusedEdit.status).toBe(409);
  expect((await call(author,'POST',route+'/publish',{})).status).toBe(403);ok(await call(author,'POST',route+'/withdraw',{}));ok(await call(author,'PATCH',route,doc));ok(await call(author,'POST',route+'/submit',{}));
  expect((await call(reviewer,'POST',route+'/reject',{})).status).toBe(422);ok(await call(reviewer,'POST',route+'/reject',{note:'Review changes required'}));
  expect(ok(await call(author,'GET',`/blueprints/${id}/versions`)).versions).toEqual([expect.objectContaining({version:1,status:'draft',status_note:'Review changes required'})]);
  ok(await call(author,'PATCH',route,doc));ok(await call(author,'POST',route+'/submit',{}));ok(await call(reviewer,'POST',route+'/publish',{}));
  const key=tag();const created=ok(await call(user,'POST',`/blueprints/${id}/instantiations`,request(),key),201);ok(await call(reviewer,'POST',route+'/retire',{}));
  expect((await call(reviewer,'POST',route+'/retire',{})).status).toBe(409);
  expect(await call(user,'POST',`/blueprints/${id}/instantiations`,request(),key)).toEqual({status:201,body:created,text:expect.any(String)});expect(await call(user,'POST',`/blueprints/${id}/instantiations`,request(),tag())).toMatchObject({status:409,body:{code:'BLUEPRINT_NOT_PUBLISHED'}});
 });
 test('D-4 fifth of ten lacks authority and no canonical create is invoked',async()=>{
  const doc=document(true);doc.phases=[];doc.dependencies=[];doc.reports=[];
  doc.parameters.push({key:'steward',label:'Steward',promptText:'Who stewards the fifth task?',type:'principal-ref',required:true});
  doc.tasks=Array.from({length:10},(_,i)=>({key:'t'+String(i+1).padStart(2,'0'),title:'Task '+(i+1),...(i===4?{roles:{shepherd:'{{steward}}'}}:{})}));
  const id=await publish(doc);const project=await target();const limited=await narrow(['blueprints:use','projects:write','tasks:write','principals:read']);const steward=await narrow(['tasks:read']);
  await grant(limited,'blueprint',id,['use']);await grant(limited,'project',project,['read','write']);const body=request(project,{steward:steward.id});
  const preview=ok(await call(limited,'POST',`/blueprints/${id}/instantiations/preview`,body));
  expect(preview.plan.tasks.map((task:any)=>task.key)).toEqual(Array.from({length:10},(_,i)=>'t'+String(i+1).padStart(2,'0')));
  expect(preview.plan.authority.filter((item:any)=>!item.allowed)).toEqual([expect.objectContaining({operation:'task.roles',localKey:'t05'})]);
  const before=await population();const spies=writes();const refusal=await call(limited,'POST',`/blueprints/${id}/instantiations`,body,tag());
  expect(refusal).toMatchObject({status:403,body:{code:'BLUEPRINT_AUTHORITY_REQUIRED',field:'t05'}});expect(await population()).toEqual(before);
  expect((await pool.query("SELECT outcome,metadata FROM audit_events WHERE resource_id=$1 AND action='blueprint.instantiate_refused' ORDER BY occurred_at DESC LIMIT 1",[id])).rows[0]).toEqual({outcome:'denied',metadata:{reason:'missing-authority',createdIds:[]}});
  // Deliberately last: a per-object authority mutant rolls rows back, but
  // reaches four canonical creates before the fifth Task is refused.
  for(const spy of spies)expect(spy).not.toHaveBeenCalled();
 });
 test('D-4/D-20 use-only preview diagnoses missing authority and refused creation invokes no writer',async()=>{
  const doc=document(true);const id=await publish(doc);const project=await target();const limited=await narrow(['blueprints:use','projects:write']);await grant(limited,'blueprint',id,['use']);await grant(limited,'project',project,['read','write']);
  const spies=writes();const before=await population();const preview=ok(await call(limited,'POST',`/blueprints/${id}/instantiations/preview`,request(project)));
  expect(preview.plan.authority).toEqual(expect.arrayContaining([expect.objectContaining({operation:'task.create',scope:'tasks:write',allowed:false})]));
  const denied=await call(limited,'POST',`/blueprints/${id}/instantiations`,request(project),tag());expect(denied.status).toBe(403);const audit=(await pool.query("SELECT actor_principal_id,outcome,metadata FROM audit_events WHERE resource_id=$1 AND action='blueprint.instantiate_refused' ORDER BY occurred_at DESC LIMIT 1",[id])).rows[0];expect(audit).toEqual({actor_principal_id:limited.id,outcome:'denied',metadata:{reason:'missing-authority',createdIds:[]}});for(const spy of spies)expect(spy).not.toHaveBeenCalled();expect(await population()).toEqual(before);
  const list=ok(await call(limited,'GET','/blueprints'));expect(list.blueprints.some((row:any)=>row.id===id)).toBe(true);ok(await call(limited,'GET',`/blueprints/${id}`));
  expect((await call(limited,'GET',`/blueprints/${id}/versions`)).status).toBe(403);expect((await call(limited,'GET',`/blueprints/${id}/instantiations`)).status).toBe(403);
 });
 test('D-11 existing target archive precedes retry; D-17 nonroot committed replay survives lost Task scope but not target concealment',async()=>{
  const doc=document(true);const id=await publish(doc);const project=await target();const limited=await narrow(['blueprints:use','projects:write','phases:write','tasks:write','reports:write']);await grant(limited,'blueprint',id,['use']);await grant(limited,'project',project,['read','write']);
  const key=tag();const body=request(project);const created=ok(await call(limited,'POST',`/blueprints/${id}/instantiations`,body,key),201);
  // Revocation in the parent expression constrains the existing credential,
  // without minting another caller or changing the key's identity.
  await pool.query("UPDATE principals SET own_expression=$2::jsonb WHERE id=$1",[limited.id,JSON.stringify({scopes:['blueprints:use','projects:write','phases:write','reports:write'],objects:'parent'})]);
  expect(await call(limited,'POST',`/blueprints/${id}/instantiations`,body,key)).toEqual({status:201,body:created,text:expect.any(String)});
  const freshDenied=await call(limited,'POST',`/blueprints/${id}/instantiations`,body,tag());expect(freshDenied.status).toBe(403);expect(freshDenied.body.error).toContain('tasks:write');
  await pool.query("DELETE FROM grants WHERE resource_type='project' AND resource_id=$1 AND grantee_id=ANY($2::uuid[])",[project,[limited.id,limited.accountId]]);
  expect(await call(limited,'POST',`/blueprints/${id}/instantiations`,body,key)).toMatchObject({status:404,body:{code:'PROJECT_NOT_FOUND'}});await grant(limited,'project',project,['read']);
  expect(await call(limited,'POST',`/blueprints/${id}/instantiations`,body,key)).toEqual({status:201,body:created,text:expect.any(String)});
  await pool.query("UPDATE projects SET status='archived' WHERE id=$1",[project]);expect(await call(limited,'POST',`/blueprints/${id}/instantiations`,body,key)).toMatchObject({status:409,body:{code:'PROJECT_ARCHIVED'}});
 });
 test('D-22 runtime secret rejection is identical on preview/create and leaves every work/ledger population unchanged',async()=>{
  const doc=document();const id=await publish(doc);const before=await population();const secret='rh_live_abcdefghijklmnopqrstuvwxyz';
  const preview=await call(user,'POST',`/blueprints/${id}/instantiations/preview`,request(undefined,{name:secret}));const create=await call(user,'POST',`/blueprints/${id}/instantiations`,request(undefined,{name:secret}),tag());
  expect(preview.status).toBe(422);expect(create.status).toBe(422);expect(preview.body).toEqual(create.body);expect(preview.text).not.toContain(secret);expect(create.text).not.toContain(secret);expect(await population()).toEqual(before);
 });
 test('D-23 raw unused value is available only to original caller/root; unrelated visible reader gets type and digest',async()=>{
  const doc=document(true);const id=await publish(doc);const project=await target();const raw='unused-personal-'+tag();const body=request(project,{unused:raw});const created=ok(await call(user,'POST',`/blueprints/${id}/instantiations`,body,tag()),201);
  const outsider=await narrow(['blueprints:read']);await grant(outsider,'blueprint',id,['read']);await grant(outsider,'project',project,['read']);
  const owner=ok(await call(user,'GET',`/instantiations/${created.instantiationId}`)).instantiation;expect(owner.parameter_values.unused).toBe(raw);
  const answer=await call(outsider,'GET',`/instantiations/${created.instantiationId}`);const redacted=ok(answer).instantiation;expect(redacted.parameter_values).toBeNull();expect(answer.text).not.toContain(raw);expect(redacted.parameter_projection.unused).toEqual({type:'string',sha256:blueprintDigest(raw)});
  expect(JSON.stringify({...redacted,positiveControl:raw})).toContain(raw);
 });
 test('atomic rollback includes canonical objects, history and audit when a later Report writer fails',async()=>{
  const doc=document();const id=await publish(doc);const before=await population();
  const auditBefore=Number((await pool.query('SELECT count(*) AS n FROM audit_events')).rows[0].n);
  const historyBefore=Number((await pool.query('SELECT count(*) AS n FROM task_history')).rows[0].n);
  const logs=jest.spyOn(console,'log').mockImplementation(()=>undefined);
  const feedBefore=Number((await pool.query('SELECT count(*) AS n FROM feed_events')).rows[0].n);
  const original=reportManager.create.bind(reportManager);jest.spyOn(reportManager,'create').mockImplementation(async(...args:any[])=>{await original(...args);throw new Error('Injected late canonical failure')});
  const result=await call(user,'POST',`/blueprints/${id}/instantiations`,request(),tag());expect(result.status).toBe(503);expect(await population()).toEqual(before);
  expect(Number((await pool.query('SELECT count(*) AS n FROM audit_events')).rows[0].n)).toBe(auditBefore);
  expect(Number((await pool.query('SELECT count(*) AS n FROM task_history')).rows[0].n)).toBe(historyBefore);
  expect(Number((await pool.query('SELECT count(*) AS n FROM feed_events')).rows[0].n)).toBe(feedBefore);
  expect(logs.mock.calls.some(args=>/Created report|Added dependency|Created task/.test(String(args[0])))).toBe(false);
 });
 test('D-12 import preserves an exported v3 snapshot, changes only explicit key rename, stays draft and next authored version is4',async()=>{
  const doc=document();const id=await publish(doc);const originalKey=tag();
  const original=ok(await call(user,'POST',`/blueprints/${id}/instantiations`,request(),originalKey),201);
  const originalTasks=(await pool.query('SELECT * FROM tasks WHERE id=ANY($1::uuid[]) ORDER BY id',[Object.values(original.tasks)])).rows;
  for(const version of [2,3]){const next=JSON.parse(JSON.stringify(doc));next.blueprint.version=version;next.tasks[0].title='Revised version '+version;next.tasks.push({key:'additional',title:'Additional work'});ok(await call(author,'POST',`/blueprints/${id}/versions`,next),201)}
  ok(await call(author,'POST',`/blueprints/${id}/versions/3/submit`,{}));ok(await call(reviewer,'POST',`/blueprints/${id}/versions/3/publish`,{}));
  const exported=ok(await call(author,'GET',`/blueprints/${id}/versions/3/export`));expect(exported.blueprint.version).toBe(3);
  const versions=ok(await call(author,'GET',`/blueprints/${id}/versions`)).versions;expect(versions.find((row:any)=>row.version===1)).toEqual(expect.objectContaining({status:'retired',status_note:'superseded by version 3',status_changed_at:expect.any(String)}));
  expect((await pool.query('SELECT * FROM tasks WHERE id=ANY($1::uuid[]) ORDER BY id',[Object.values(original.tasks)])).rows).toEqual(originalTasks);
  expect((await pool.query('SELECT count(*)::int AS n FROM tasks WHERE project_id=$1',[original.projectId])).rows[0].n).toBe(2);
  expect(ok(await call(user,'POST',`/blueprints/${id}/instantiations`,request(),originalKey),201)).toEqual(original);
  const fresh=ok(await call(user,'POST',`/blueprints/${id}/instantiations`,request(undefined,{name:'Fresh '+tag()}),tag()),201);expect(fresh.blueprint.version).toBe(3);expect(Object.keys(fresh.tasks)).toHaveLength(3);
  expect(ok(await call(user,'GET',`/tasks/${fresh.tasks.first}`)).task.title).toBe('Revised version 3');
  const publishAudit=(await pool.query("SELECT metadata FROM audit_events WHERE resource_id=$1 AND action='blueprint.publish' ORDER BY occurred_at DESC LIMIT 1",[id])).rows[0].metadata;expect(publishAudit.superseded_version).toBe(1);
  expect((await call(author,'POST','/blueprints/import',{document:exported})).body.code).toBe('BLUEPRINT_KEY_IN_USE');
  const importedRows:any[]=[];
  for(const rename of [`import-b-${tag()}`,`import-c-${tag()}`]){
   const imported=ok(await call(author,'POST','/blueprints/import',{document:exported,rename}),201).blueprint;expect(imported.version).toBe(3);expect(imported.status).toBe('draft');
   const read=ok(await call(author,'GET',`/blueprints/${imported.id}?version=3`)).blueprint;
   expect(stableBlueprintJson(read.document)).toBe(stableBlueprintJson({...exported,blueprint:{...exported.blueprint,key:rename}}));
   expect(read.identitySha256).toBe(blueprintDigests(exported).identitySha256);expect(read.contentSha256).not.toBe(blueprintDigests(exported).contentSha256);
   expect((await call(user,'POST',`/blueprints/${imported.id}/instantiations`,request(),tag())).body.code).toBe('BLUEPRINT_NOT_PUBLISHED');
   const fourth={...read.document,blueprint:{...read.document.blueprint,version:4}};ok(await call(author,'POST',`/blueprints/${imported.id}/versions`,fourth),201);
   expect(ok(await call(author,'GET',`/blueprints/${imported.id}/versions`)).versions.map((version:any)=>version.version)).toEqual([4,3]);importedRows.push(read);
  }
  expect(importedRows[0].contentSha256).not.toBe(importedRows[1].contentSha256);
  const ordinary={...exported,blueprint:{...exported.blueprint,key:`ordinary-${tag()}`}};expect((await call(author,'POST','/blueprints',ordinary)).status).toBe(422);
 });
 test('D-19 supersession retires v1 atomically and only v2 accepts fresh work',async()=>{
  const doc=document();const id=await publish(doc);const key=tag();const old=ok(await call(user,'POST',`/blueprints/${id}/instantiations`,request(),key),201);
  const second={...doc,blueprint:{...doc.blueprint,version:2},tasks:doc.tasks.map((task:any,i:number)=>i===0?{...task,title:'Version two only'}:task)};
  ok(await call(author,'POST',`/blueprints/${id}/versions`,second),201);ok(await call(author,'POST',`/blueprints/${id}/versions/2/submit`,{}));ok(await call(reviewer,'POST',`/blueprints/${id}/versions/2/publish`,{}));
  const state=(await pool.query('SELECT b.published_version_id,v.id,v.version,v.status,v.status_note,v.status_changed_at FROM blueprints b JOIN blueprint_versions v ON v.blueprint_id=b.id WHERE b.id=$1 ORDER BY v.version',[id])).rows;
  expect(state.map((row:any)=>({version:row.version,status:row.status,status_note:row.status_note}))).toEqual([{version:1,status:'retired',status_note:'superseded by version 2'},{version:2,status:'published',status_note:null}]);
  expect(state[0].status_changed_at).toBeInstanceOf(Date);expect(state.map((row:any)=>row.published_version_id)).toEqual([state[1].id,state[1].id]);
  expect((await pool.query("SELECT metadata FROM audit_events WHERE resource_id=$1 AND action='blueprint.publish' ORDER BY occurred_at DESC LIMIT 1",[id])).rows[0].metadata).toMatchObject({version:2,superseded_version:1,status:'published'});
  const fresh=ok(await call(user,'POST',`/blueprints/${id}/instantiations`,request(undefined,{name:'Fresh '+tag()}),tag()),201);
  expect(fresh.blueprint.version).toBe(2);expect((await pool.query('SELECT blueprint_version,title FROM tasks WHERE id=$1',[fresh.tasks.first])).rows[0]).toEqual({blueprint_version:2,title:'Version two only'});
  expect((await pool.query('SELECT blueprint_version FROM projects WHERE id=$1',[fresh.projectId])).rows[0].blueprint_version).toBe(2);
  const {BlueprintInstantiationService}=require('../services/BlueprintInstantiationService');const seam=new BlueprintInstantiationService({bodyConfiguration:jsonBodyOptions},()=>({}));
  try{seam.requirePublished(state[0]);throw new Error('Retired row was accepted at the creation service seam')}catch(error){expect(error).toMatchObject({status:409,code:'BLUEPRINT_NOT_PUBLISHED'})}
  expect(ok(await call(user,'POST',`/blueprints/${id}/instantiations`,request(),key),201)).toEqual(old);
 });
 test('D-19 supersession rolls back the pointer and both statuses when predecessor retirement fails',async()=>{
  const doc=document();const id=await publish(doc);const second={...doc,blueprint:{...doc.blueprint,version:2}};
  ok(await call(author,'POST',`/blueprints/${id}/versions`,second),201);ok(await call(author,'POST',`/blueprints/${id}/versions/2/submit`,{}));
  const before=(await pool.query('SELECT published_version_id FROM blueprints WHERE id=$1',[id])).rows[0].published_version_id;
  const connect=pool.connect.bind(pool);
  jest.spyOn(pool,'connect').mockImplementation((...args:any[])=>{
   if(args.length)return connect(...args);
   return connect().then((client:any)=>{const query=client.query;const release=client.release;
    client.query=function(...queryArgs:any[]){if(typeof queryArgs[0]==='string'&&queryArgs[0].includes("UPDATE blueprint_versions SET status='retired'"))return Promise.reject(new Error('Injected predecessor retirement failure'));return query.apply(client,queryArgs)};
    client.release=function(...releaseArgs:any[]){client.query=query;client.release=release;return release.apply(client,releaseArgs)};return client;
   });
  });
  expect((await call(reviewer,'POST',`/blueprints/${id}/versions/2/publish`,{})).status).toBe(503);
  expect((await pool.query('SELECT published_version_id FROM blueprints WHERE id=$1',[id])).rows[0].published_version_id).toBe(before);
  expect((await pool.query('SELECT version,status FROM blueprint_versions WHERE blueprint_id=$1 ORDER BY version',[id])).rows).toEqual([{version:1,status:'published'},{version:2,status:'review'}]);
 });
 test('D-13 a published cap-sized plan refuses after live limits tighten, while its committed retry still converges',async()=>{
  const doc=document();doc.tasks=Array.from({length:100},(_,index)=>({key:'work-'+index,title:'Work '+index}));doc.dependencies=[];doc.reports=[];
  const id=await publish(doc);const key=tag();const created=ok(await call(user,'POST',`/blueprints/${id}/instantiations`,request(),key),201);expect(Object.keys(created.tasks)).toHaveLength(100);
  const previous=blueprintLimits.tasks;blueprintLimits.tasks=99;
  try{const spies=writes();const before=await population();const refused=await call(user,'POST',`/blueprints/${id}/instantiations`,request(undefined,{name:'Tightened '+tag()}),tag());expect(refused.status).toBe(422);expect(refused.body.field).toBe('tasks');for(const spy of spies)expect(spy).not.toHaveBeenCalled();expect(await population()).toEqual(before);expect(ok(await call(user,'POST',`/blueprints/${id}/instantiations`,request(),key),201)).toEqual(created)}finally{blueprintLimits.tasks=previous}
 });
 test('D-17 new-root replay loses concealment even though its caller can still read their created Task, then restores without Task write',async()=>{
  const doc=document();const id=await publish(doc);const limited=await narrow(['blueprints:use','projects:write','phases:write','tasks:write','tasks:read','reports:write']);await grant(limited,'blueprint',id,['use']);await grant(limited,'project',null,['read']);
  const key=tag();const body=request();const created=ok(await call(limited,'POST',`/blueprints/${id}/instantiations`,body,key),201);
  await pool.query("DELETE FROM grants WHERE resource_type='project' AND grantee_id=ANY($1::uuid[])",[[limited.id,limited.accountId]]);
  expect(await call(limited,'POST',`/blueprints/${id}/instantiations`,body,key)).toMatchObject({status:404,body:{code:'PROJECT_NOT_FOUND'}});ok(await call(limited,'GET',`/tasks/${created.tasks.first}`));
  await grant(limited,'project',created.projectId,['read']);await pool.query('UPDATE principals SET own_expression=$2::jsonb WHERE id=$1',[limited.id,JSON.stringify({scopes:['blueprints:use'],objects:'parent'})]);
  expect(await call(limited,'POST',`/blueprints/${id}/instantiations`,body,key)).toEqual({status:201,body:created,text:expect.any(String)});
 });
 test('D-23 nonroot author and a separate root read raw unused/bound values; another visible reader receives neither literal',async()=>{
  const doc=document(true);doc.parameters.push({key:'verifier',label:'Verifier',promptText:'Who verifies?',type:'principal-ref',required:true});doc.tasks[1].roles={verifier:'{{verifier}}'};
  const id=await publish(doc);const project=await target();const limited=await narrow(['blueprints:use','blueprints:read','projects:write','phases:write','tasks:write','reports:write','principals:read']);await grant(limited,'blueprint',id,['use','read']);await grant(limited,'project',project,['read','write']);
  const raw='Unused '+tag();const created=ok(await call(limited,'POST',`/blueprints/${id}/instantiations`,request(project,{unused:raw,verifier:reviewer.id}),tag()),201);
  const read=async(who:Caller)=>ok(await call(who,'GET',`/instantiations/${created.instantiationId}`)).instantiation;
  for(const who of [limited,author]){const ledger=await read(who);expect(ledger.parameter_values.unused).toBe(raw);expect(ledger.parameter_values.verifier).toBe(reviewer.id)}
  const other=await narrow(['blueprints:read']);await grant(other,'blueprint',id,['read']);await grant(other,'project',project,['read']);const hidden=await read(other);
  expect(JSON.stringify(hidden)).not.toContain(raw);expect(JSON.stringify(hidden)).not.toContain(reviewer.id);expect(hidden.parameter_projection.verifier).toEqual({type:'principal-ref',sha256:blueprintDigest(reviewer.id)});
  expect(JSON.stringify({...hidden,positiveControl:[raw,reviewer.id]})).toContain(raw);expect(JSON.stringify({...hidden,positiveControl:[raw,reviewer.id]})).toContain(reviewer.id);
 });
 test('D-15/D-20 real REST, executable CLI and registered MCP share use-only plans, complete receipts and refusal behavior',async()=>{
  const doc=document(true);const id=await publish(doc);const project=await target();
  const limited=await narrow(['blueprints:use','projects:write','phases:write','tasks:write','reports:write']);await grant(limited,'blueprint',id,['use']);await grant(limited,'project',project,['read','write']);
  const body=request(project);const before=await population();
  const restGet=ok(await call(limited,'GET',`/blueprints/${id}`));const cliGet=await cli(limited,['get',id]);expect(cliGet.code).toBe(0);expect(cliGet.body).toEqual(restGet);expect(await mcp(limited,'get',{blueprintId:id})).toEqual(restGet);
  const restList=ok(await call(limited,'GET','/blueprints'));expect((await cli(limited,['list'])).body).toEqual(restList);expect(await mcp(limited,'list')).toEqual(restList);
  const preview=ok(await call(limited,'POST',`/blueprints/${id}/instantiations/preview`,body));const cliPreview=await cli(limited,['preview',id,'--project',project]);expect(cliPreview.code).toBe(0);expect(cliPreview.body).toEqual(preview);expect(await mcp(limited,'preview',{blueprintId:id,...body})).toEqual(preview);expect(await population()).toEqual(before);
  const key=tag();const receipt=ok(await call(limited,'POST',`/blueprints/${id}/instantiations`,body,key),201);const after=await population();
  const cliReplay=await cli(limited,['instantiate',id,'--project',project,'--idempotency-key',key]);expect(cliReplay.code).toBe(0);expect(cliReplay.body).toEqual(receipt);expect(cliReplay.stderr).toContain('Idempotency-Key: '+key);expect(await mcp(limited,'instantiate',{blueprintId:id,...body,idempotencyKey:key})).toEqual(receipt);expect(await population()).toEqual(after);
  const cliFresh=await cli(limited,['instantiate',id,'--project',project,'--idempotency-key',tag()]);expect(cliFresh.code).toBe(0);const afterCli=await population();
  const mcpFresh=await mcp(limited,'instantiate',{blueprintId:id,...body,idempotencyKey:tag()});const afterMcp=await population();
  const difference=(next:Record<string,any>,prior:Record<string,any>)=>Object.fromEntries(Object.keys(next).map(name=>[name,next[name]-prior[name]]));
  const expectedDelta={projects:0,phases:preview.plan.counts.phases,tasks:preview.plan.counts.tasks,subtasks:preview.plan.counts.subtasks,task_dependencies:preview.plan.counts.dependencies,reports:preview.plan.counts.reports,blueprint_instantiations:1,blueprint_instantiation_requests:1,grants:0};
  expect([difference(after,before),difference(afterCli,after),difference(afterMcp,afterCli)]).toEqual([expectedDelta,expectedDelta,expectedDelta]);
  expect(new Set([receipt,cliFresh.body,mcpFresh].map(value=>value.instantiationId)).size).toBe(3);
  for(const value of [receipt,cliFresh.body,mcpFresh]){expect(Object.keys(value.tasks)).toEqual(preview.plan.tasks.map((task:any)=>task.key));expect(value.blueprint).toEqual(receipt.blueprint)}
  expect(new Set([receipt,cliFresh.body,mcpFresh].flatMap(value=>Object.values(value.tasks))).size).toBe(3*preview.plan.counts.tasks);

  await pool.query('UPDATE principals SET own_expression=$2::jsonb WHERE id=$1',[limited.id,JSON.stringify({scopes:['blueprints:use','projects:write'],objects:'parent'})]);
  const denied=await call(limited,'POST',`/blueprints/${id}/instantiations`,body,tag());expect(denied.status).toBe(403);const cliDenied=await cli(limited,['instantiate',id,'--project',project,'--idempotency-key',tag()]);expect(cliDenied.code).toBe(1);expect(cliDenied.stderr).toContain(denied.body.code);await expect(mcp(limited,'instantiate',{blueprintId:id,...body,idempotencyKey:tag()})).rejects.toThrow(denied.body.code);expect(await population()).toEqual(afterMcp);
  const draftDoc=document();const draftId=await draft(draftDoc);await grant(limited,'blueprint',draftId,['use']);expect((await call(limited,'GET',`/blueprints/${draftId}?version=1`)).status).toBe(404);expect((await cli(limited,['get',draftId,'--version','1'])).code).toBe(1);await expect(mcp(limited,'get',{blueprintId:draftId,version:1})).rejects.toThrow();
  expect((await call(limited,'GET',`/blueprints/${id}/versions/1/export`)).status).toBe(403);expect((await cli(limited,['export',id,'--version','1'])).code).toBe(1);
 });
 test('D-26 executable CLI lifecycle registration drives actual draft/review/publication/retirement rows and immutable review',async()=>{
  const writer=await narrow(['blueprints:read','blueprints:write','blueprints:admin'],'operator');const independent=await narrow(['blueprints:read','blueprints:write','blueprints:admin'],'operator');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'blueprint-cli-live-'));const file=path.join(directory,'document.json');const doc=document();fs.writeFileSync(file,JSON.stringify(doc));
  try{
   const created=await cli(writer,['create','--file',file]);expect(created.code).toBe(0);const id=created.body.blueprint.id;await grant(writer,'blueprint',id,['read','write','admin']);await grant(independent,'blueprint',id,['read','write','admin']);
   const status=async()=> (await pool.query('SELECT status FROM blueprint_versions WHERE blueprint_id=$1 AND version=1',[id])).rows[0].status;
   const draftPublish=await cli(independent,['publish',id,'--version','1']);expect(draftPublish.code).toBe(1);expect(draftPublish.stderr).toContain('BLUEPRINT_VERSION_STATE');
   expect((await cli(writer,['submit',id,'--version','1'])).code).toBe(0);expect(await status()).toBe('review');
   expect((await call(writer,'PATCH',`/blueprints/${id}/versions/1`,doc)).status).toBe(409);
   expect((await cli(writer,['withdraw',id,'--version','1'])).code).toBe(0);expect(await status()).toBe('draft');
   const withdrawnEdit={...doc,blueprint:{...doc.blueprint,summary:'Edited after CLI withdrawal'}};expect((await call(writer,'PATCH',`/blueprints/${id}/versions/1`,withdrawnEdit)).status).toBe(200);
   expect((await cli(writer,['submit',id,'--version','1'])).code).toBe(0);const missingNote=await cli(independent,['reject',id,'--version','1']);expect(missingNote.code).toBe(2);expect(missingNote.stderr).toContain('--note');expect(await status()).toBe('review');const rejected=await cli(independent,['reject',id,'--version','1','--note','Please revise']);expect({code:rejected.code,...(rejected.code===0?{}:{stderr:rejected.stderr})}).toEqual({code:0});expect(await status()).toBe('draft');
   const history=await cli(writer,['get',id,'--version','1']);expect(history.code).toBe(0);expect(history.body.blueprint.statusNote).toBe('Please revise');
   const rejectedEdit={...doc,blueprint:{...doc.blueprint,summary:'Edited after CLI rejection'}};expect((await call(writer,'PATCH',`/blueprints/${id}/versions/1`,rejectedEdit)).status).toBe(200);
   expect((await cli(writer,['submit',id,'--version','1'])).code).toBe(0);expect((await cli(writer,['publish',id,'--version','1'])).code).toBe(1);expect((await cli(independent,['publish',id,'--version','1'])).code).toBe(0);expect(await status()).toBe('published');
   expect((await cli(independent,['retire',id,'--version','1'])).code).toBe(0);expect(await status()).toBe('retired');
  }finally{fs.rmSync(directory,{recursive:true,force:true})}
 });

 test('D-21 bound Principal is written only to its typed slot, absent from every created user-text column',async()=>{
  const doc=document();doc.parameters.push({key:'verifier',label:'Verifier',promptText:'Who verifies?',type:'principal-ref',required:true});doc.tasks[1].roles={verifier:'{{verifier}}'};
  const id=await publish(doc);const created=ok(await call(user,'POST',`/blueprints/${id}/instantiations`,request(undefined,{verifier:reviewer.id}),tag()),201);
  expect((await pool.query('SELECT verifier_principal_id FROM tasks WHERE id=$1',[created.tasks.second])).rows[0].verifier_principal_id).toBe(reviewer.id);
  const textRows=[
   ...(await pool.query('SELECT name,description,goal FROM projects WHERE id=$1',[created.projectId])).rows,
   ...(await pool.query('SELECT name,goal FROM phases WHERE id=ANY($1::uuid[])',[Object.values(created.phases)])).rows,
   ...(await pool.query('SELECT title,description,definition_of_done,constraints,notes,tags FROM tasks WHERE id=ANY($1::uuid[])',[Object.values(created.tasks)])).rows,
   ...(await pool.query('SELECT title,note FROM subtasks WHERE task_id=ANY($1::uuid[])',[Object.values(created.tasks)])).rows,
   ...(await pool.query('SELECT title,summary,content,tags FROM reports WHERE id=ANY($1::uuid[])',[Object.values(created.reports)])).rows,
  ];expect(textRows).toHaveLength(6);expect(JSON.stringify(textRows)).not.toContain(reviewer.id);
  const before=textRows[2].title;expect(before).toBeDefined();textRows[2].title=reviewer.id;expect(JSON.stringify(textRows)).toContain(reviewer.id);
 });
 test('D-22 refused runtime value reaches no hash, substitution, writer, ledger, audit or log sink; actual regex screen precedes all',async()=>{
  const doc=document();const id=await publish(doc);const secret='rh_live_'+tag()+tag();const documentModule=require('../utils/blueprintDocument');const planModule=require('../services/BlueprintPlanService');
  const order:string[]=[];const realTest=RegExp.prototype.test;const screen=jest.spyOn(RegExp.prototype,'test').mockImplementation(function(this:RegExp,value:string){const result=realTest.call(this,value);if(value===secret&&this.source.includes('PRIVATE KEY')&&this.source.includes('AKIA'))order.push('screen');return result});
  const hash=jest.spyOn(planModule,'blueprintRequestHash');const substitution=jest.spyOn(documentModule,'substituteBlueprint');const canonical=writes();const logs=[jest.spyOn(console,'log').mockImplementation(()=>undefined),jest.spyOn(console,'error').mockImplementation(()=>undefined),jest.spyOn(console,'warn').mockImplementation(()=>undefined)];
  const before=await population();
  for(const suffix of ['/preview','']){const answer=await call(user,'POST',`/blueprints/${id}/instantiations${suffix}`,request(undefined,{name:secret}),suffix?undefined:tag());expect(answer.status).toBe(422);expect(answer.text).not.toContain(secret)}
  expect(order).toEqual(['screen','screen']);expect(hash).not.toHaveBeenCalled();expect(substitution).not.toHaveBeenCalled();for(const writer of canonical)expect(writer).not.toHaveBeenCalled();expect(await population()).toEqual(before);
  for(const logger of logs)expect(JSON.stringify(logger.mock.calls)).not.toContain(secret);
  // Enumerate actual persisted sinks independently of the refusal response.
  for(const table of ['projects','phases','tasks','subtasks','task_references','reports','audit_events','task_history','feed_events','blueprint_instantiations','blueprint_instantiation_requests']){
   const rows=(await pool.query(`SELECT count(*)::int AS n FROM ${table} sink WHERE strpos(to_jsonb(sink)::text,$1)>0`,[secret])).rows;expect({table,n:rows[0].n}).toEqual({table,n:0});
  }
  const control=(await pool.query("SELECT strpos(jsonb_build_object('text',$1::text)::text,$1)>0 AS found",[secret])).rows[0];expect(control.found).toBe(true);screen.mockRestore();
 });

 test('canonical Project name conflict keeps its typed409 refusal and rolls back the entire attempted instantiation',async()=>{
  const doc=document();const id=await publish(doc);ok(await call(user,'POST',`/blueprints/${id}/instantiations`,request(),tag()),201);const before=await population();
  const refused=await call(user,'POST',`/blueprints/${id}/instantiations`,request(),tag());expect(refused.status).toBe(409);expect(refused.body).toMatchObject({code:'PROJECT_NAME_CONFLICT',field:'name'});expect(await population()).toEqual(before);
 });

});

describe('Phase capture owner contract', () => {
 async function source() {
   const projectId = await target();
   const phaseId = ok(await call(author,'POST','/phases',{projectId,name:'Delivery',goal:'A reusable outcome'}),201).phase.id;
   const task = ok(await call(author,'POST','/tasks',{project:projectId,phaseId,title:'Prepare work',description:'Describe the work',
     definitionOfDone:['Reviewed','Recorded'],successCriteria:['Proof passes'],constraints:['Use fixtures'],
     priority:'high',subtasks:[{text:'Inspect',status:'empty',completed:false}]}),201).task;
   return {projectId,phaseId,task};
 }
 test('CAPTURE-1 preserves the plan through independent publication, export and renamed import', async () => {
   const sourceWork=await source();
   const receipt=ok(await call(author,'POST','/blueprints/capture',{phaseId:sourceWork.phaseId}),201).blueprint;
   expect(receipt).toMatchObject({version:1,status:'draft'});
   const doc=ok(await call(author,'GET',`/blueprints/${receipt.id}?version=1`)).blueprint.document;
   expect(doc.tasks[0]).toMatchObject({title:'Prepare work',priority:'high',definitionOfDone:['Reviewed','Recorded'],successCriteria:['Proof passes'],constraints:['Use fixtures'],subtasks:[{text:'Inspect'}]});
   expect(JSON.stringify(doc)).not.toContain(sourceWork.task.id);
   expect(JSON.stringify(doc)).not.toContain(sourceWork.phaseId);
   expect(doc.target.mode).toBe('new-project');
   const listed=ok(await call(author,'GET','/blueprints')).blueprints.find((row:any)=>row.id===receipt.id);
   expect(listed.target).toEqual({mode:'new-project',allowExisting:true});
   ok(await call(author,'POST',`/blueprints/${receipt.id}/versions/1/submit`,{}));
   expect((await call(author,'POST',`/blueprints/${receipt.id}/versions/1/publish`,{})).body.code).toBe('BLUEPRINT_SELF_REVIEW_REFUSED');
   ok(await call(reviewer,'POST',`/blueprints/${receipt.id}/versions/1/publish`,{}));
   const exported=ok(await call(author,'GET',`/blueprints/${receipt.id}/versions/1/export`));
   const imported=ok(await call(author,'POST','/blueprints/import',{document:exported,rename:'capture-import-'+tag()}),201).blueprint;
   const roundTrip=ok(await call(author,'GET',`/blueprints/${imported.id}?version=1`)).blueprint.document;
   expect({...roundTrip,blueprint:{...roundTrip.blueprint,key:exported.blueprint.key}}).toEqual(exported);
 });
 test('CAPTURE-2 captured text placeholders resolve in ordinary parked Tasks', async () => {
   const sourceWork=await source();
   const receipt=ok(await call(author,'POST','/blueprints/capture',{phaseId:sourceWork.phaseId}),201).blueprint;
   const doc=ok(await call(author,'GET',`/blueprints/${receipt.id}?version=1`)).blueprint.document;
   doc.parameters.push({key:'outcome',type:'text',required:true,label:'Outcome',promptText:'What outcome?'});
   doc.tasks[0].successCriteria=['{{outcome}}'];
   ok(await call(author,'PATCH',`/blueprints/${receipt.id}/versions/1`,doc));
   ok(await call(author,'POST',`/blueprints/${receipt.id}/versions/1/submit`,{}));
   ok(await call(reviewer,'POST',`/blueprints/${receipt.id}/versions/1/publish`,{}));
   const created=ok(await call(author,'POST',`/blueprints/${receipt.id}/instantiations`,request(undefined,{outcome:'All checks pass',project_name:'Captured '+tag()}),tag()),201);
   const task=ok(await call(author,'GET',`/tasks/${created.tasks['task-1']}`)).task;
   expect(task.successCriteria).toEqual(['All checks pass']);expect(task.autoStart).toBe(false);expect(task.ownerPrincipalId).toBeFalsy();
 });
 test('CAPTURE-3 empty plans remain drafts and cannot enter review',async()=>{
   const doc=document();doc.tasks=[];doc.phases=[];doc.dependencies=[];doc.reports=[];
   const id=await draft(doc);
   expect(await call(author,'POST',`/blueprints/${id}/versions/1/submit`,{})).toMatchObject({status:422,body:{code:'BLUEPRINT_EMPTY_PLAN',field:'tasks'}});
   expect(ok(await call(author,'GET',`/blueprints/${id}?version=1`)).blueprint.status).toBe('draft');
 });
 test('CAPTURE-4 write scope cannot bypass the Project-read boundary',async()=>{
   const sourceWork=await source();const caller=await narrow(['blueprints:write','projects:read','phases:read','tasks:read']);
   const result=await call(caller,'POST','/blueprints/capture',{phaseId:sourceWork.phaseId});
   expect(result.status).toBe(404);
   expect(result.text).not.toContain('Prepare work');
 });
 test('CAPTURE-5 missing Blueprint write scope refuses capture',async()=>{
   const sourceWork=await source();const caller=await narrow(['projects:read','phases:read','tasks:read']);
   expect((await call(caller,'POST','/blueprints/capture',{phaseId:sourceWork.phaseId})).status).toBe(403);
 });
});
