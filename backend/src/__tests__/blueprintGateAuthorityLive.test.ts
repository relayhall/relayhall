/** Real PostgreSQL contract: NEVER uses inherited deployment DB settings.
 * This suite is excluded from default Jest; RELAYHALL_TEST_DB_URL is mandatory.
 * It drives the production router/auth stack, writes disposable fixtures, and
 * measures stored effects through independent SQL and ordinary object routes.
 */
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
const url = process.env.RELAYHALL_TEST_DB_URL;
if (!url) throw new Error('RELAYHALL_TEST_DB_URL is required for the Blueprint gate authority contract');
const parsed = new URL(url);
const database = decodeURIComponent(parsed.pathname.slice(1));
if (!['127.0.0.1','localhost','[::1]','postgres'].includes(parsed.hostname)
  || ['relayhall','relayhall_dev','relayhall_tst','relayhall_prod','clawboard','clawboard_dev','clawboard_prod'].includes(database)
  || (!/(test|contract|fixture)/i.test(database) && !(parsed.hostname==='postgres' && database==='relayhall_ci'))) throw new Error('Blueprint gate authority contract requires an explicitly disposable local test database');
Object.assign(process.env, { DB_HOST:parsed.hostname, DB_PORT:parsed.port || '5432', DB_NAME:database,
  DB_USER:decodeURIComponent(parsed.username), DB_PASSWORD:decodeURIComponent(parsed.password), NODE_ENV:'test',
  RELAYHALL_SESSIONS:'on', JWT_SECRET:'blueprint-gates-only-jwt-key-0123456789' });
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
interface Caller { id:string; headers:Record<string,string>; accountId?:string }
interface Answer { status:number; body:any; text:string }
let server:http.Server; let origin:string; let author:Caller; let reviewer:Caller; let user:Caller;
const tag = () => crypto.randomBytes(8).toString('hex');
const writes = () => [jest.spyOn(projectService,'create'),jest.spyOn(phaseService,'create'),jest.spyOn(taskManagerDB,'createTask'),
  jest.spyOn(taskManagerDB,'addDependency'),jest.spyOn(taskManagerDB,'assignTaskRoles'),jest.spyOn(reportManager,'create'),jest.spyOn(taskElementService,'createReference')];
async function account(role='admin'):Promise<Caller> {
  const id = (await pool.query("INSERT INTO principals(kind,handle,display_name,status,role) VALUES('human',$1,$1,'active',$2) RETURNING id",[`blueprint-gates-${tag()}`,role])).rows[0].id;
  const { token } = await loginSessionService.mint({principalId:id});
  return {id,headers:{Cookie:`${SESSION_COOKIE_NAME}=${token}`}};
}
async function narrow(scopes:string[],role='user',parentRole='user'):Promise<Caller> {
  const accountId=(await pool.query("INSERT INTO principals(kind,handle,display_name,status,role,purpose) VALUES('service',$1,$1,'active',$2,'Blueprint live fixture') RETURNING id",[`blueprint-account-${tag()}`,parentRole])).rows[0].id;
  const id=(await pool.query("INSERT INTO principals(kind,handle,display_name,status,parent_principal_id,purpose,own_expression) VALUES('service',$1,$1,'active',$2,'Blueprint connector fixture',$3::jsonb) RETURNING id",[`blueprint-connector-${tag()}`,accountId,JSON.stringify({scopes:'parent',objects:'parent'})])).rows[0].id;
  const key=await principalService.issueCredential({principalId:id,scopes,transport:'any'},{principalId:author.id,handle:'blueprint-live',authMethod:'system'});
  await pool.query('UPDATE principals SET role=$2 WHERE id=$1',[id,role]);
  return {id,accountId,headers:{Authorization:`Bearer ${key.fullKey}`}};
}
async function grant(who:Caller,kind:string,id:string,verbs:string[]) {
  for (const principal of [who.id,...(who.accountId?[who.accountId]:[])]) for(const verb of verbs) await pool.query('INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id) VALUES(\'principal\',$1,$2,$3,$4,$5)',[principal,kind,id,verb,author.id]);
}
async function call(who:Caller,method:string,path:string,body?:unknown,key?:string):Promise<Answer> {
  const response=await fetch(origin+path,{method,headers:{'Content-Type':'application/json',...who.headers,...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await response.text(); let value:any;try{value=JSON.parse(text)}catch{value=text}
  return {status:response.status,body:value,text};
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

async function skill(name:string,fixtureId=crypto.randomUUID()):Promise<string> {
  const existing=(await pool.query('SELECT id FROM skills WHERE name=$1',[name])).rows[0];
  if(existing)return existing.id;
  const id=(await pool.query('INSERT INTO skills(id,name) VALUES($1,$2) RETURNING id',[fixtureId,name])).rows[0].id;
  const version=(await pool.query("INSERT INTO skill_versions(skill_id,version,skill_md,description,provenance,created_by_principal_id) VALUES($1,1,$2,'Gate fixture Skill','human-authored',$3) RETURNING id",[id,'# '+name,author.id])).rows[0].id;
  for(const status of ['draft','review','published'])await pool.query('INSERT INTO skill_version_events(skill_version_id,status,actor_principal_id) VALUES($1,$2,$3)',[version,status,status==='published'?reviewer.id:author.id]);
  return id;
}
function gates(existing=false):any {
  const doc=document(existing);doc.phases=[];doc.reports=[];doc.dependencies=[];
  doc.parameters.push({key:'decider',label:'Decider',promptText:'Who decides?',type:'principal-ref',required:true});
  doc.tasks=[{key:'chosen',title:'Chosen arm'},{key:'unchosen',title:'Unchosen arm'},{key:'shared',title:'Shared arm'}];
  doc.humanGates=[{key:'decision',title:'Decision',decider:'{{decider}}',decisionPrompt:'Choose a response',arms:[{key:'yes',label:'Yes',tasks:['chosen','shared']},{key:'no',label:'No',tasks:['unchosen','shared']}]}];
  return doc;
}
async function gateFixture(role='user') {
  const decider=await narrow(['tasks:read','tasks:write','principals:read'],role);
  const doc=gates();const blueprintId=await publish(doc);
  const result=ok(await call(user,'POST',`/blueprints/${blueprintId}/instantiations`,request(undefined,{decider:decider.id}),tag()),201);
  return {decider,blueprintId,result};
}
/** The exact incident document includes optional references; optionality no
 * longer waives use access. Supply real published prerequisites without
 * changing the ratified document or granting authority to created Tasks. */
async function incidentPrerequisites() {
  await skill('incident-triage');
  await skill('postmortem-template');
  if (!(await pool.query("SELECT id FROM services WHERE slug='hermes'")).rows.length) {
    const {serviceRegistry}=require('../services/ServiceRegistry');
    const service=await serviceRegistry.register({slug:'hermes',name:'Incident example fixture',kind:'connector'},author.id);
    const descriptor=await serviceRegistry.publishDescriptor(service.id,{options:[]},String(service.revision),author.id);
    await serviceRegistry.update(service.id,{status:'published'},String(descriptor.service.revision),author.id);
  }
}
async function incidentGateFixture() {
  await incidentPrerequisites();
  const doc=JSON.parse(fs.readFileSync(path.join(__dirname,'../../../docs/blueprints/examples/incident-investigation.json'),'utf8'));
  doc.blueprint.key=`incident-runtime-${tag()}`;
  const decider=await narrow(['tasks:read','tasks:write','principals:read'],'qa');const blueprintId=await publish(doc);
  const receipt=ok(await call(user,'POST',`/blueprints/${blueprintId}/instantiations`,request(undefined,{incident_number:'INC-12',incident_title:`Fixture incident ${tag()}`,severity:'sev2',incident_commander:decider.id,detected_at:'2026-09-06'}),tag()),201);
  // Test-only aliases let the same lifecycle controls address the actual
  // example's gate and arms. The document and stored Task identities are intact.
  const result={...receipt,tasks:{...receipt.tasks,decision:receipt.tasks['fix-decision'],chosen:receipt.tasks['deploy-fix'],unchosen:receipt.tasks['schedule-window'],shared:receipt.tasks.announce}};
  return {decider,blueprintId,result};
}
async function armed(ids:string[]) {
  return (await pool.query('SELECT t.id,t.auto_start,a.armed FROM tasks t JOIN task_assignments a ON a.task_id=t.id WHERE t.id=ANY($1::uuid[]) ORDER BY t.id',[ids])).rows;
}
async function completeGate(fixture:any) {
  // This D7 fixture explicitly holds the canonical legacy Verifier identity
  // plus an ordinary write grant on the GATE only. It grants no arm authority.
  const {decider,result}=fixture;await grant(decider,'task',result.tasks.decision,['write']);
  const subtasks=(await pool.query('SELECT id FROM subtasks WHERE task_id=$1 ORDER BY index',[result.tasks.decision])).rows;
  for(const row of subtasks){
    ok(await call(user,'PATCH',`/tasks/${result.tasks.decision}/subtasks/by-id/${row.id}/status`,{status:'review'}));
    ok(await call(decider,'POST',`/tasks/${result.tasks.decision}/subtasks/by-id/${row.id}/approve`,{}));
  }
  ok(await call(decider,'PATCH',`/tasks/${result.tasks.decision}`,{status:'completed'}));
}
async function publishedConnector() {
  const {serviceRegistry}=require('../services/ServiceRegistry');
  const service=await serviceRegistry.register({slug:`gate-service-${tag()}`,name:'Gate reassignment fixture',kind:'connector'},author.id);
  const published=await serviceRegistry.publishDescriptor(service.id,{options:[]},String(service.revision),author.id);
  await serviceRegistry.update(service.id,{status:'published'},String(published.service.revision),author.id);
  const principalId=(await pool.query('SELECT principal_id FROM services WHERE id=$1',[service.id])).rows[0].principal_id;
  await principalService.issueCredential({principalId,scopes:['tasks:read','tasks:write'],transport:'any'},{principalId:author.id,handle:'fixture',authMethod:'system'});
  return {serviceId:service.id,principalId,accountId:author.id};
}

describe('Blueprint gate authority and concealment on disposable PostgreSQL',()=>{
 test('D6 invisible Skill and genuinely absent Skill give byte-identical preview/refusal; A resolves the positive control',async()=>{
  const name=`incident-triage-${tag()}`;const skillId=crypto.randomUUID();const a=await narrow(['blueprints:use','skills:read','skills:use','projects:write']);const b=await narrow(['blueprints:use','skills:read','skills:use','projects:write']);
  const doc=document(true);doc.references=[{kind:'skill',name,requirement:'required'}];doc.tasks[0].references=[name];const id=await publish(doc);const project=await target();
  for(const who of [a,b]){await grant(who,'blueprint',id,['use']);await grant(who,'project',project,['read','write'])}
  // Published Skills have a canonical visibility arm. B's ordinary own()
  // narrowing excludes this Skill explicitly while retaining the plan surfaces.
  await pool.query('UPDATE principals SET own_expression=$2::jsonb WHERE id=$1',[b.id,JSON.stringify({scopes:'parent',objects:[
    {resourceType:'blueprint',selectorForm:'all-of-type',selectorIds:[],verbs:['use']},
    {resourceType:'project',selectorForm:'all-of-type',selectorIds:[],verbs:['read','write']},
    {resourceType:'skill',selectorForm:'all-except',selectorIds:[skillId],verbs:['read']},
    {resourceType:'skill',selectorForm:'all-of-type',selectorIds:[],verbs:['use']},
  ]})]);
  // Capture true absence BEFORE creating the immutable Skill. Then insert it
  // normally; no rename/delete trigger or history rule is bypassed.
  const absent=await call(b,'POST',`/blueprints/${id}/instantiations/preview`,request(project));const absentRefusal=await call(b,'POST',`/blueprints/${id}/instantiations`,request(project),tag());
  await skill(name,skillId);await grant(a,'skill',skillId,['read']);
  const readOnly=ok(await call(a,'POST',`/blueprints/${id}/instantiations/preview`,request(project)));
  expect(readOnly.plan.references[0]).toMatchObject({outcome:'missing-required',requiredAccess:'skills:read and skills:use'});
  await grant(a,'skill',skillId,['use']);
  // B holds use authority but cannot read this Skill. Keep visibility as the
  // sole missing prerequisite so a privileged-read mutant cannot hide behind
  // an unrelated use denial.
  await grant(b,'skill',skillId,['use']);
  const positive=ok(await call(a,'POST',`/blueprints/${id}/instantiations/preview`,request(project)));expect(positive.plan.references[0].outcome).toBe('resolved');
  const hidden=await call(b,'POST',`/blueprints/${id}/instantiations/preview`,request(project));
  const refused=await call(b,'POST',`/blueprints/${id}/instantiations`,request(project),tag());
  // The privileged-lookup mutation must redden this byte comparison itself.
  expect(absent.text).toBe(hidden.text);expect(absentRefusal.text).toBe(refused.text);
  expect(absent.status).toBe(hidden.status);expect(absentRefusal.status).toBe(refused.status);
  expect(hidden.status).toBe(200);expect(hidden.body.plan.references[0].outcome).toBe('missing-required');expect(refused.status).toBe(422);
 });
 test('D7a-b D24a exact incident example creates parked Tasks, one shared arm and every gate dependency/role',async()=>{
  // Observe a real thrown error without replacing any database/transaction
  // behavior; expose only its code/message, never SQL values or credentials.
  const {BlueprintInstantiationService}=require('../services/BlueprintInstantiationService');
  const original=BlueprintInstantiationService.prototype.instantiate;
  jest.spyOn(BlueprintInstantiationService.prototype,'instantiate').mockImplementation(async function(this:any,...args:any[]){
    try{return await original.apply(this,args)}catch(error:any){console.error('Incident real instantiation failure',{code:error.code,message:error.message});throw error}
  });
  await incidentPrerequisites();const doc=JSON.parse(fs.readFileSync(path.join(__dirname,'../../../docs/blueprints/examples/incident-investigation.json'),'utf8'));doc.blueprint.key=`incident-gates-${tag()}`;
  const decider=await narrow(['tasks:read','tasks:write','principals:read']);const id=await publish(doc);
  const result=ok(await call(user,'POST',`/blueprints/${id}/instantiations`,request(undefined,{incident_number:'INC-12',incident_title:`Fixture incident ${tag()}`,severity:'sev2',incident_commander:decider.id,detected_at:'2026-09-06'}),tag()),201);
  const ids=Object.values(result.tasks) as string[];const rows=await armed(ids);expect(rows).toHaveLength(doc.tasks.length+doc.humanGates.length);for(const row of rows)expect(row).toMatchObject({auto_start:false,armed:false});
  expect((await pool.query('SELECT count(*)::int AS n FROM tasks WHERE project_id=$1',[result.projectId])).rows[0].n).toBe(doc.tasks.length+doc.humanGates.length);
  expect(new Set(ids).size).toBe(ids.length);const gate=result.tasks['fix-decision'];const armKeys=[...new Set<string>(doc.humanGates[0].arms.flatMap((arm:any)=>arm.tasks))];
  for(const key of armKeys){const edge=(await pool.query('SELECT * FROM task_dependencies WHERE task_id=$1 AND depends_on_task_id=$2',[result.tasks[key],gate])).rows;expect(edge).toHaveLength(1)}
  const stored=(await pool.query('SELECT task_id,shepherd_principal_id,verifier_principal_id FROM task_assignments WHERE task_id=ANY($1::uuid[])',[ids])).rows;
  expect(stored.find((row:any)=>row.task_id===gate).verifier_principal_id).toBe(decider.id);for(const key of armKeys)expect(stored.find((row:any)=>row.task_id===result.tasks[key]).shepherd_principal_id).toBe(decider.id);
  expect((await pool.query('SELECT count(*)::int AS n FROM tasks WHERE instantiation_id=$1 AND id=$2',[result.instantiationId,result.tasks.announce])).rows[0].n).toBe(1);
 });
 test('D7d parked arm claim changes from dependency-blocked to not-armed when the gate completes',async()=>{
  const fixture=await incidentGateFixture();const claimant=await narrow(['tasks:read','tasks:write']);await grant(claimant,'task',fixture.result.tasks.chosen,['read','write']);
  const before=await call(claimant,'POST',`/tasks/${fixture.result.tasks.chosen}/claim`,{});
  await completeGate(fixture);const after=await call(claimant,'POST',`/tasks/${fixture.result.tasks.chosen}/claim`,{});
  expect({before:before.body.code,after:after.body.code}).toEqual({before:'TASK_DEPENDENCY_BLOCKED',after:'TASK_NOT_ARMED'});
 });
 test('D7c-e-f completion arms nothing; ordinary writer can arm chosen tasks while role-only decider cannot',async()=>{
  const fixture=await incidentGateFixture();const {result,decider}=fixture;await completeGate(fixture);
  const ids=[result.tasks.chosen,result.tasks.unchosen,result.tasks.shared];for(const row of await armed(ids))expect(row.armed).toBe(false);
  const denied=await call(decider,'PATCH',`/tasks/${result.tasks.chosen}`,{autoStart:true});expect([403,404]).toContain(denied.status);expect((await armed([result.tasks.chosen]))[0].armed).toBe(false);
  const writer=await narrow(['tasks:read','tasks:write']);for(const id of ids)await grant(writer,'task',id,['read','write']);
  expect((await call(writer,'POST',`/tasks/${result.tasks.chosen}/claim`,{})).body.code).toBe('TASK_NOT_ARMED');
  for(const id of [result.tasks.chosen,result.tasks.shared])ok(await call(writer,'PATCH',`/tasks/${id}`,{autoStart:true}));
  const audit=(await pool.query("SELECT actor_principal_id,metadata FROM audit_events WHERE action='task.arm' AND resource_id=ANY($1::text[])",[[result.tasks.chosen,result.tasks.shared]])).rows;
  expect(audit).toHaveLength(2);for(const row of audit){expect(row.actor_principal_id).toBe(writer.id);expect(row.metadata.source).toBe('update')}
  expect((await armed([result.tasks.chosen,result.tasks.shared])).every((row:any)=>row.armed===true)).toBe(true);
  ok(await call(writer,'POST',`/tasks/${result.tasks.chosen}/claim`,{}));expect((await call(writer,'POST',`/tasks/${result.tasks.unchosen}/claim`,{})).body.code).toBe('TASK_NOT_ARMED');
 });
 test('D24b role-bound decider approves its gate subtask; unrelated principal cannot',async()=>{
  const {decider,result}=await gateFixture();const outsider=await narrow(['tasks:read','tasks:write']);await grant(outsider,'task',result.tasks.decision,['read']);
  const subtask=(await pool.query('SELECT id FROM subtasks WHERE task_id=$1 ORDER BY index LIMIT 1',[result.tasks.decision])).rows[0].id;
  ok(await call(user,'PATCH',`/tasks/${result.tasks.decision}/subtasks/by-id/${subtask}/status`,{status:'review'}));
  const denied=await call(outsider,'POST',`/tasks/${result.tasks.decision}/subtasks/by-id/${subtask}/approve`,{});expect([403,404]).toContain(denied.status);
  // No qa/orchestrator role is added to make this ratified role-only act pass.
  ok(await call(decider,'POST',`/tasks/${result.tasks.decision}/subtasks/by-id/${subtask}/approve`,{}));
  expect((await pool.query('SELECT status FROM subtasks WHERE id=$1',[subtask])).rows[0].status).toBe('completed');
 });
 test.each(['force-release','park'])('D24c role-bound Shepherd can %s while a neither-role caller cannot',async act=>{
  const {decider,result}=await gateFixture();const task=result.tasks.chosen;const outsider=await narrow(['tasks:read','tasks:write']);await grant(outsider,'task',task,['read']);
  // Precondition fixture state is independent from the act under test; it
  // confers no authority. An ordinary writer arms; SQL sets the claimant only
  // for force-release, since the incomplete gate prevents ordinary claiming.
  const writer=await narrow(['tasks:read','tasks:write']);await grant(writer,'task',task,['read','write']);
  ok(await call(writer,'PATCH',`/tasks/${task}`,{autoStart:true}));
  if(act==='force-release'){
    await pool.query('UPDATE tasks SET owner_principal_id=$2 WHERE id=$1',[task,writer.id]);
    const otherWriter=await narrow(['tasks:read','tasks:write']);await grant(otherWriter,'task',task,['read','write']);
    expect((await call(otherWriter,'POST',`/tasks/${task}/release`,{})).status).toBe(409);
    expect((await pool.query('SELECT owner_principal_id FROM tasks WHERE id=$1',[task])).rows[0].owner_principal_id).toBe(writer.id);
  }
  const method=act==='park'?'PATCH':'POST';const route=`/tasks/${task}${act==='park'?'':'/release'}`;const body=act==='park'?{autoStart:false}:{};
  expect([403,404]).toContain((await call(outsider,method,route,body)).status);ok(await call(decider,method,route,body));
  if(act==='park')expect((await armed([task]))[0].armed).toBe(false);else expect((await pool.query('SELECT owner_principal_id FROM tasks WHERE id=$1',[task])).rows[0].owner_principal_id).toBeNull();
 });
 test('D24c role-bound Shepherd reassigns execution with actual Service invoke and Grant coupling; ordinary writer is a positive control',async()=>{
  const {decider,result}=await gateFixture();const service=await publishedConnector();
  expect([403,404]).toContain((await call(decider,'PATCH',`/tasks/${result.tasks.chosen}`,{executionProfile:{serviceId:service.serviceId,options:{}}})).status);
  const writer=await narrow(['tasks:read','tasks:write','services:invoke']);const outsider=await narrow(['tasks:read','tasks:write','services:invoke']);
  // A separate credential with invoke is issued to the SAME role-bound decider;
  // no write grant is added to its Task. Service invoke remains an ordinary prerequisite.
  const issued=await principalService.issueCredential({principalId:decider.id,scopes:['tasks:read','tasks:write','services:invoke'],transport:'any'},{principalId:author.id,handle:'fixture',authMethod:'system'});
  const shepherd={...decider,headers:{Authorization:`Bearer ${issued.fullKey}`}};
  for(const who of [writer,outsider,shepherd])await grant(who,'service',service.serviceId,['invoke']);
  await grant(writer,'task',result.tasks.shared,['read','write']);await grant(outsider,'task',result.tasks.chosen,['read']);
  const body={executionProfile:{serviceId:service.serviceId,options:{}}};
  ok(await call(writer,'PATCH',`/tasks/${result.tasks.shared}`,body));
  expect((await pool.query('SELECT execution_service_id FROM tasks WHERE id=$1',[result.tasks.shared])).rows[0].execution_service_id).toBe(service.serviceId);
  expect((await pool.query("SELECT count(*)::int AS n FROM grants WHERE grantee_id=$1 AND resource_type='task' AND resource_id=$2",[service.accountId,result.tasks.shared])).rows[0].n).toBeGreaterThan(0);
  expect([403,404]).toContain((await call(outsider,'PATCH',`/tasks/${result.tasks.chosen}`,body)).status);
  ok(await call(shepherd,'PATCH',`/tasks/${result.tasks.chosen}`,body));
  expect((await pool.query('SELECT execution_service_id FROM tasks WHERE id=$1',[result.tasks.chosen])).rows[0].execution_service_id).toBe(service.serviceId);
 });
 test('D24d missing Service-Shepherd assignment authority is named before every canonical writer',async()=>{
  const doc=gates(true);const id=await publish(doc);const project=await target();const limited=await narrow(['blueprints:use','projects:write','tasks:write','principals:read']);const decider=await narrow(['tasks:read']);
  await grant(limited,'blueprint',id,['use']);await grant(limited,'project',project,['read','write']);const body=request(project,{decider:decider.id});
  const preview=ok(await call(limited,'POST',`/blueprints/${id}/instantiations/preview`,body));
  const before=await population();const spies=writes();const refusal=await call(limited,'POST',`/blueprints/${id}/instantiations`,body,tag());expect(refusal.status).toBe(403);expect(refusal.body.code).toBe('BLUEPRINT_AUTHORITY_REQUIRED');expect(refusal.body.field).toBeTruthy();
  expect(refusal.body.error).toBe('Required task-role assignment authority: tasks:write and, where applicable, services:invoke');
  for(const spy of spies)expect(spy).not.toHaveBeenCalled();expect(await population()).toEqual(before);
  expect(preview.plan.authority.some((row:any)=>row.operation==='task.roles'&&!row.allowed)).toBe(true);
 });
 test('D24 bounded Shepherd authority does not allow arm, archive, title, mixed updates or a missing route ceiling',async()=>{
  const {decider,result}=await gateFixture();const task=result.tasks.chosen;
  for(const body of [{autoStart:true},{status:'archived'},{title:'Unauthorized rename'},
    {autoStart:false,title:'Mixed park rename'},{executionProfile:null,title:'Mixed reassignment rename'}]){
    expect([403,404]).toContain((await call(decider,'PATCH',`/tasks/${task}`,body)).status);
  }
  const key=await principalService.issueCredential({principalId:decider.id,scopes:['tasks:read'],transport:'any'},{principalId:author.id,handle:'fixture',authMethod:'system'});
  const belowCeiling={...decider,headers:{Authorization:`Bearer ${key.fullKey}`}};
  expect([403,404]).toContain((await call(belowCeiling,'PATCH',`/tasks/${task}`,{autoStart:false})).status);
  expect((await pool.query('SELECT title,status,auto_start FROM tasks WHERE id=$1',[task])).rows[0]).toMatchObject({title:'Chosen arm',status:'todo',auto_start:false});
 });
 test('D20 use-only REST and real MCP handlers discover published declarations, diagnose create authority and conceal draft/target',async()=>{
  const doc=document(true);const id=await publish(doc);const draftOnly=document(true);const draftId=await draft(draftOnly);const project=await target();const hidden=await target();const limited=await narrow(['blueprints:use','projects:write']);
  await grant(limited,'blueprint',id,['use']);await grant(limited,'blueprint',draftId,['use']);await grant(limited,'project',project,['read','write']);
  const list=ok(await call(limited,'GET','/blueprints'));expect(list.blueprints.map((row:any)=>row.id)).toContain(id);expect(list.blueprints.map((row:any)=>row.id)).not.toContain(draftId);
  const detail=ok(await call(limited,'GET',`/blueprints/${id}`)).blueprint;expect(detail.parameters).toEqual(doc.parameters);expect(detail.references).toEqual(doc.references);
  const next=JSON.parse(JSON.stringify(doc));next.blueprint.version=2;ok(await call(author,'POST',`/blueprints/${id}/versions`,next),201);
  expect((await call(limited,'GET',`/blueprints/${id}?version=2`)).status).toBe(404);
  for(const suffix of ['/versions','/versions/1/export','/instantiations'])expect((await call(limited,'GET',`/blueprints/${id}${suffix}`)).status).toBe(403);
  const before=await population();const auditBefore=(await pool.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n;const spies=writes();const preview=ok(await call(limited,'POST',`/blueprints/${id}/instantiations/preview`,request(project)));
  expect(preview.plan.authority).toEqual(expect.arrayContaining([expect.objectContaining({scope:'tasks:write',allowed:false})]));expect(await population()).toEqual(before);expect((await pool.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n).toBe(auditBefore);for(const spy of spies)expect(spy).not.toHaveBeenCalled();
  expect((await call(limited,'POST',`/blueprints/${id}/instantiations`,request(project),tag())).status).toBe(403);expect((await call(limited,'POST',`/blueprints/${id}/instantiations/preview`,request(hidden))).status).toBe(404);
  const {toolByName}=require('../mcp/registry');const context={authorization:limited.headers.Authorization,toolName:'relayhall_blueprint_list'};
  const mcpList=JSON.parse(await toolByName(context.toolName).handler({response_format:'detailed'},context));expect(mcpList.blueprints.map((row:any)=>row.id)).toContain(id);expect(mcpList.blueprints.map((row:any)=>row.id)).not.toContain(draftId);
  context.toolName='relayhall_blueprint_get';const mcpGet=JSON.parse(await toolByName(context.toolName).handler({blueprintId:id,response_format:'detailed'},context));expect(mcpGet.blueprint.projection).toBe('use');expect(mcpGet.blueprint.parameters).toEqual(doc.parameters);
  await expect(toolByName(context.toolName).handler({blueprintId:id,version:2},context)).rejects.toThrow(/404/);
 });
 test('D14 ordinary issuer refuses Agent admin delegation; equal-scope Connector can publish',async()=>{
  // Connector authority intersects its Account. A legitimately administrative
  // parent supplies the admin ceiling; the Connector itself retains role user.
  const connector=await narrow(['blueprints:read','blueprints:write','blueprints:admin'],'user','operator');const doc=document();const id=await draft(doc);await grant(connector,'blueprint',id,['read','write','admin']);ok(await call(author,'POST',`/blueprints/${id}/versions/1/submit`,{}));
  const bound=(await pool.query("INSERT INTO tasks(title,status) VALUES('Agent bound fixture','todo') RETURNING id")).rows[0].id;
  const agent=(await pool.query("INSERT INTO principals(kind,handle,display_name,status,parent_principal_id,bound_task_id,purpose,own_expression) VALUES('agent',$1,$1,'active',$2,$3,'Gate test agent',$4::jsonb) RETURNING id",[`gate-agent-${tag()}`,connector.id,bound,JSON.stringify({scopes:'parent',objects:'parent'})])).rows[0].id;
  await expect(principalService.issueCredential({principalId:agent,scopes:['blueprints:admin'],transport:'any'},{principalId:author.id,handle:'fixture',authMethod:'system'})).rejects.toMatchObject({code:'ADMIN_NOT_AGENT_DELEGABLE'});
  ok(await call(connector,'POST',`/blueprints/${id}/versions/1/publish`,{}));
 });
 test('D14 defensive transition layer check (hypothetical actor seam, not a reachable Agent credential)',async()=>{
  const connector=await narrow(['blueprints:admin']);const doc=document();const id=await draft(doc);await grant(connector,'blueprint',id,['admin']);ok(await call(author,'POST',`/blueprints/${id}/versions/1/submit`,{}));
  const {blueprintRegistry}=require('../routes/blueprints');
  // An impossible Agent/root DTO isolates this defensive method guard. It is
  // never minted or authenticated and is NOT evidence of normal reachability.
  const resolution=jest.spyOn(blueprintRegistry,'resolve');
  await expect(blueprintRegistry.transition(id,1,'publish',{actor:{authenticated:true,principalId:connector.id,handle:'hypothetical-agent',role:'agent',scopes:['root'],authMethod:'principal_api_key'},audit:{principalId:connector.id,handle:'hypothetical-agent',authMethod:'principal_api_key'},rootSession:false})).rejects.toMatchObject({code:'BLUEPRINT_AGENT_ADMIN_REFUSED'});
  expect(resolution).not.toHaveBeenCalled();
 });
});
