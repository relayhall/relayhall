/** Production-router descriptor proof; isolated DB only, excluded from default Jest. */
import http from 'http';
import crypto from 'crypto';
const url=process.env.RELAYHALL_TEST_DB_URL;if(!url)throw new Error('RELAYHALL_TEST_DB_URL required for workflow setup live proof');
const parsed=new URL(url);const db=decodeURIComponent(parsed.pathname.slice(1));
const local=['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)&&/test|contract|fixture/i.test(db)&&!/^clawboard(?:_|$)/i.test(db);
const ci=process.env.CI==='true'&&parsed.hostname==='postgres'&&parsed.port==='5432'&&db==='relayhall_ci'&&parsed.username==='relayhall_ci';
if(!local&&!ci)throw new Error('Descriptor proof requires the exact owned fixture or CI database');
Object.assign(process.env,{DB_HOST:parsed.hostname,DB_PORT:parsed.port,DB_NAME:db,DB_USER:decodeURIComponent(parsed.username),DB_PASSWORD:decodeURIComponent(parsed.password),NODE_ENV:'test',RELAYHALL_SESSIONS:'on',JWT_SECRET:crypto.randomBytes(48).toString('hex')});delete process.env.BOOT_CHECK;
const express=require('express');const {pool}=require('../db/connection');
const {registerProtectedRoutes}=require('../routeRegistry');const {authMiddleware}=require('../middleware/auth');const {sharedAuthorizationMiddleware}=require('../middleware/sharedAuthorization');const {apiErrorHandler}=require('../utils/apiErrors');const {jsonBodyOptions}=require('../utils/jsonBodyTypes');
const {loginSessionService,SESSION_COOKIE_NAME}=require('../services/LoginSessionService');const {serviceRegistry}=require('../services/ServiceRegistry');const {principalService}=require('../services/PrincipalService');
let server:http.Server;let origin:string;let author:{id:string;headers:Record<string,string>};let reviewer:typeof author;
const tag=()=>crypto.randomBytes(8).toString('hex');
async function account(role="admin"){const id=(await pool.query("INSERT INTO principals(kind,handle,display_name,status,role) VALUES('human',$1,$1,'active',$2) RETURNING id",['setup-'+tag(),role])).rows[0].id;const {token}=await loginSessionService.mint({principalId:id});return {id,headers:{Cookie:`${SESSION_COOKIE_NAME}=${token}`}};}
async function call(who:typeof author,method:string,path:string,body?:unknown,key?:string){const response=await fetch(origin+path,{method,headers:{'Content-Type':'application/json',...who.headers,...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json() as any};}
function ok(result:{status:number;body:any},status=200){expect(result.status===status?{status:result.status}:result).toEqual({status});return result.body;}
function document(service:string):any{return {schemaVersion:'rh.blueprint/1.0',blueprint:{key:'descriptor-'+tag(),name:'Descriptor proof',version:1,summary:'',description:'',tags:[],provenance:'human-authored'},parameters:[{key:'answer',label:'Answer',promptText:'Text?',type:'string',required:false,default:'Inspect'}],references:[{kind:'service',name:service,requirement:'required',minVersion:2}],target:{mode:'new-project',project:{name:'Descriptor '+tag()}},phases:[],tasks:[{key:'inspect',title:'Inspect',defaults:{executionProfile:{service,options:{command:'Run {{answer}}'} as any}}}],humanGates:[],reports:[],dependencies:[]};}
async function publish(doc:any){const id=ok(await call(author,'POST','/blueprints',doc),201).blueprint.id;ok(await call(author,'POST',`/blueprints/${id}/versions/1/submit`,{}));ok(await call(reviewer,'POST',`/blueprints/${id}/versions/1/publish`,{}));return id;}
async function connector(){let service=await serviceRegistry.register({slug:'descriptor-'+tag(),name:'Descriptor fixture',kind:'connector'},author.id);const first=await serviceRegistry.publishDescriptor(service.id,{options:[{key:'command',type:'number'}]},String(service.revision),author.id);service=await serviceRegistry.update(service.id,{status:'published'},String(first.service.revision),author.id);const next=await serviceRegistry.publishDescriptor(service.id,{options:[{key:'command',type:'string'},{key:'mode',type:'enum',values:[{value:'Inspect'}]},{key:'privateMarker',type:'string',default:'Visible descriptor marker'}]},String(service.revision),author.id);const principal=(await pool.query('SELECT principal_id FROM services WHERE id=$1',[service.id])).rows[0].principal_id;
 await principalService.issueCredential({principalId:principal,scopes:['tasks:read','tasks:write'],transport:'any'},{principalId:author.id,handle:'setup-fixture',authMethod:'system'});
 return next.service;}
beforeAll(async()=>{const app=express();app.use(express.json(jsonBodyOptions));registerProtectedRoutes((mount:string,...handlers:any[])=>app.use(mount,authMiddleware,sharedAuthorizationMiddleware,...handlers));app.use(apiErrorHandler);await new Promise<void>(resolve=>{server=app.listen(0,'127.0.0.1',resolve)});origin=`http://127.0.0.1:${(server.address() as any).port}`;author=await account();reviewer=await account();});
afterAll(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();});jest.setTimeout(90000);

const {accessProfileService}=require('../services/AccessProfileService');
const {warrantService}=require('../services/WarrantService');
const {auditService}=require('../services/AuditService');
const {taskManagerDB}=require('../services/TaskManagerDB');
const audit=()=>({principalId:author.id,handle:'setup-fixture',authMethod:'session'});
async function created(who=author){
 const service=await connector();const doc=document(service.slug);
 doc.phases=[{key:'phase',name:'Phase'}];doc.tasks[0].phase='phase';
 doc.tasks.push({...doc.tasks[0],key:'follow',title:'Follow'});
 const blueprintId=await publish(doc);
 const input={target:{mode:'new-project'},parameterValues:{answer:'private runtime value '+tag()}};
 const result=ok(await call(who,'POST',`/blueprints/${blueprintId}/instantiations`,input,tag()),201);
 return{service,doc,blueprintId,input,result};
}
async function existingWarrant(f:any,holder?:string){
 const principal=(await pool.query("SELECT principal_id FROM services WHERE id=$1",[f.service.id])).rows[0].principal_id;
 const profile=await accessProfileService.create({name:'Setup access '+tag()},audit());
 const rules=[{resourceType:'task',selectorForm:'exact',selectorIds:Object.values(f.result.tasks),verbs:['read']}];
 const version=await accessProfileService.createVersion(profile.id,rules,audit());await accessProfileService.publish(profile.id,version.id,audit());
 const warrant=await warrantService.create({name:'Existing setup warrant '+tag(),holderPrincipalId:holder??principal,
  anchors:[{anchorType:'project',anchorId:f.result.projectId}],ceilingProfileId:profile.id,expiresAt:new Date(Date.now()+3600000).toISOString()},
  {principalId:author.id,isRoot:true,sessionScopes:['root'],stepUp:null},audit());
 return {warrant,profile,rules};
}
async function displayed(f:any,warrantId:string){return ok(await call(author,'POST',`/instantiations/${f.result.instantiationId}/setup/preview`,{warrantId})).plan;}
const confirm=(plan:any)=>({warrantId:plan.warrantId,tasks:plan.tasks.map((t:any)=>({id:t.id,revision:t.revision})),confirmationHash:plan.confirmationHash});
async function stored(f:any){return (await pool.query("SELECT id,execution_service_id,execution_warrant_id,auto_start,owner_principal_id FROM tasks WHERE instantiation_id=$1 ORDER BY id",[f.result.instantiationId])).rows;}
afterEach(()=>jest.restoreAllMocks());
test('ordinary authenticated Project creation gets exactly creator read/write; revocation is not healed by reads',async()=>{
 const user=await account('user');const project=ok(await call(user,'POST','/projects',{name:'Creator '+tag()}),201).project;
 const rows=(await pool.query("SELECT grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id,provenance FROM grants WHERE resource_type='project' AND resource_id=$1 ORDER BY verb",[project.id])).rows;
 expect(rows).toEqual(['read','write'].map(verb=>({grantee_type:'principal',grantee_id:user.id,resource_type:'project',resource_id:project.id,verb,granted_by_principal_id:user.id,provenance:null})));
 expect((await pool.query("SELECT owner_principal_id FROM projects WHERE id=$1",[project.id])).rows[0].owner_principal_id).toBeNull();
 ok(await call(user,'GET',`/projects/${project.id}/phases`));
 for(const row of (await pool.query("SELECT id FROM grants WHERE resource_type='project' AND resource_id=$1",[project.id])).rows)ok(await call(author,'DELETE',`/grants/${row.id}`));
 expect(await call(user,'GET',`/projects/${project.id}/phases`)).toMatchObject({status:404});
 expect((await pool.query("SELECT count(*)::int AS n FROM grants WHERE resource_type='project' AND resource_id=$1",[project.id])).rows[0].n).toBe(0);
});
test('creator policy audit failure rolls back Project and both Grants',async()=>{
 const before=(await pool.query('SELECT count(*)::int AS n FROM grants')).rows[0].n;
 const name='Creator rollback '+tag();const original=auditService.record.bind(auditService);
 jest.spyOn(auditService,'record').mockImplementation(async(...args:any[])=>{if(args[0].action==='project.creator_access')throw new Error('Synthetic policy audit failure');return original(...args)});
 const answer=await call(author,'POST','/projects',{name});expect(answer.status).toBeGreaterThanOrEqual(500);
 expect((await pool.query("SELECT id FROM projects WHERE name=$1",[name])).rows).toEqual([]);
 expect((await pool.query('SELECT count(*)::int AS n FROM grants')).rows[0].n).toBe(before);
});
test('available Service creates parked unassigned work and immutable private staging, without creator Grants',async()=>{
 const f=await created();const tasks=await stored(f);expect(tasks).toHaveLength(2);
 expect(tasks.every((t:any)=>!t.auto_start&&!t.execution_service_id&&!t.owner_principal_id&&!t.execution_warrant_id)).toBe(true);
 expect(f.result.executionSetup).toEqual({required:true,taskCount:2});expect(JSON.stringify(f.result)).not.toContain('private runtime value');
 expect((await pool.query("SELECT * FROM access_vehicle_links WHERE task_id=ANY($1::uuid[])",[Object.values(f.result.tasks)])).rows).toEqual([]);
 // D7: Blueprint creation writes no ordinary creator Grant pair.
 expect((await pool.query("SELECT verb,grantee_id FROM grants WHERE resource_type='project' AND resource_id=$1 ORDER BY verb",[f.result.projectId])).rows).toEqual([]);
 const ledger=ok(await call(author,'GET',`/instantiations/${f.result.instantiationId}`)).instantiation;
 expect(ledger.execution_defaults.map((x:any)=>x.executionProfile.options.command)).toEqual(Array(2).fill('Run '+f.input.parameterValues.answer));
 await expect(pool.query("UPDATE blueprint_instantiations SET execution_defaults='[]' WHERE id=$1",[f.result.instantiationId])).rejects.toThrow('immutable');
 const viewer=await account('user');for(const [kind,id]of [['blueprint',f.blueprintId],['project',f.result.projectId]])await pool.query("INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb) VALUES('principal',$1,$2,$3,'read')",[viewer.id,kind,id]);
 const narrowed=ok(await call(viewer,'GET',`/instantiations/${f.result.instantiationId}`)).instantiation;
 expect(narrowed.execution_defaults).toBeNull();expect(JSON.stringify(narrowed)).not.toContain(f.input.parameterValues.answer);
 expect(await call(viewer,'POST',`/instantiations/${f.result.instantiationId}/setup/preview`,{warrantId:crypto.randomUUID()})).toMatchObject({status:404,body:{code:'BLUEPRINT_SETUP_NOT_FOUND'}});
});
test('explicit setup assigns exactly displayed membership, never arms, and replays without new effects',async()=>{
 const f=await created();const {warrant}=await existingWarrant(f);const plan=await displayed(f,warrant.id);const key=tag();
 expect(plan.tasks.map((t:any)=>t.id).sort()).toEqual(Object.values(f.result.tasks).sort());
 const answer=ok(await call(author,'POST',`/instantiations/${f.result.instantiationId}/setup`,confirm(plan),key));expect(answer).toMatchObject({assigned:true,armed:false});
 expect((await stored(f)).every((t:any)=>t.execution_service_id===f.service.id&&t.execution_warrant_id===warrant.id&&!t.auto_start)).toBe(true);
 const links=(await pool.query("SELECT * FROM access_vehicle_links WHERE task_id=ANY($1::uuid[]) ORDER BY id",[Object.values(f.result.tasks)])).rows;
 expect(links).toHaveLength(2);
 expect(ok(await call(author,'POST',`/instantiations/${f.result.instantiationId}/setup`,confirm(plan),key))).toEqual(answer);
 expect((await pool.query("SELECT * FROM access_vehicle_links WHERE task_id=ANY($1::uuid[]) ORDER BY id",[Object.values(f.result.tasks)])).rows).toEqual(links);
});
test('second canonical assignment failure rolls the entire setup back, preserving created parked work',async()=>{
 const f=await created();const {warrant}=await existingWarrant(f);const plan=await displayed(f,warrant.id);const original=taskManagerDB.updateTask.bind(taskManagerDB);let calls=0;
 jest.spyOn(taskManagerDB,'updateTask').mockImplementation(async(...args:any[])=>{if(++calls===2)throw new Error('Synthetic second assignment failure');return original(...args)});
 expect((await call(author,'POST',`/instantiations/${f.result.instantiationId}/setup`,confirm(plan),tag())).status).toBeGreaterThanOrEqual(500);expect(calls).toBe(2);
 expect((await stored(f)).every((t:any)=>!t.execution_service_id&&!t.auto_start)).toBe(true);
 expect((await pool.query("SELECT * FROM access_vehicle_links WHERE task_id=ANY($1::uuid[])",[Object.values(f.result.tasks)])).rows).toEqual([]);
 expect((await pool.query("SELECT * FROM blueprint_setup_requests WHERE instantiation_id=$1",[f.result.instantiationId])).rows).toEqual([]);
});
test('changed Task revision refuses before assignment; no auto-enrollment of future Phase Tasks',async()=>{
 const f=await created();const {warrant}=await existingWarrant(f);const plan=await displayed(f,warrant.id);
 ok(await call(author,'PATCH',`/tasks/${plan.tasks[0].id}`,{title:'Changed '+tag()}));
 expect(await call(author,'POST',`/instantiations/${f.result.instantiationId}/setup`,confirm(plan),tag())).toMatchObject({status:409,body:{code:'BLUEPRINT_SETUP_CHANGED'}});
 const added=ok(await call(author,'POST','/tasks',{title:'Later Task',project:f.result.projectId,phaseId:Object.values(f.result.phases)[0],autoStart:false}),201).task;
 const next=await displayed(f,warrant.id);expect(next.tasks.map((x:any)=>x.id)).not.toContain(added.id);
 ok(await call(author,'POST',`/instantiations/${f.result.instantiationId}/setup`,confirm(next),tag()));
 expect((await pool.query("SELECT execution_service_id,auto_start FROM tasks WHERE id=$1",[added.id])).rows[0]).toEqual({execution_service_id:null,auto_start:false});
});

test('wrong-holder Warrant refuses canonical assignment and leaves the entire setup unassigned',async()=>{
 const f=await created();const other=await connector();const holder=(await pool.query('SELECT principal_id FROM services WHERE id=$1',[other.id])).rows[0].principal_id;
 const {warrant}=await existingWarrant(f,holder);const plan=await displayed(f,warrant.id);
 expect(await call(author,'POST',`/instantiations/${f.result.instantiationId}/setup`,confirm(plan),tag())).toMatchObject({status:409,body:{code:'WARRANT_HOLDER_MISMATCH'}});
 expect((await stored(f)).every((t:any)=>!t.execution_service_id&&!t.auto_start)).toBe(true);
 expect((await pool.query('SELECT * FROM blueprint_setup_requests WHERE instantiation_id=$1',[f.result.instantiationId])).rows).toEqual([]);
 expect((await pool.query('SELECT * FROM access_vehicle_links WHERE task_id=ANY($1::uuid[])',[Object.values(f.result.tasks)])).rows).toEqual([]);
});
test('publishing the current Access Profile after display requires fresh confirmation before assignment',async()=>{
 const f=await created();const {warrant,profile,rules}=await existingWarrant(f);const plan=await displayed(f,warrant.id);
 const next=await accessProfileService.createVersion(profile.id,rules,audit());await accessProfileService.publish(profile.id,next.id,audit());
 expect(await call(author,'POST',`/instantiations/${f.result.instantiationId}/setup`,confirm(plan),tag())).toMatchObject({status:409,body:{code:'BLUEPRINT_SETUP_CHANGED'}});
 expect((await stored(f)).every((t:any)=>!t.execution_service_id&&!t.auto_start)).toBe(true);
 const refreshed=await displayed(f,warrant.id);expect(refreshed.confirmationHash).not.toBe(plan.confirmationHash);
 ok(await call(author,'POST',`/instantiations/${f.result.instantiationId}/setup`,confirm(refreshed),tag()));
});
test('Warrant revocation unassigns normally; committed setup replay cannot recreate revoked authority',async()=>{
 const f=await created();const {warrant}=await existingWarrant(f);const plan=await displayed(f,warrant.id);const key=tag();
 const answer=ok(await call(author,'POST',`/instantiations/${f.result.instantiationId}/setup`,confirm(plan),key));
 expect(await call(author,'POST',`/warrants/${warrant.id}/revoke`,{reason:'Proof revocation'})).toMatchObject({status:409,body:{code:'WARRANT_HAS_DEPENDENT_TASKS'}});
 ok(await call(author,'POST',`/warrants/${warrant.id}/revoke`,{reason:'Proof revocation',acknowledgeDependents:true}));
 const after=await stored(f);expect(after.every((t:any)=>!t.execution_service_id&&!t.execution_warrant_id&&!t.auto_start)).toBe(true);
 const links=(await pool.query('SELECT * FROM access_vehicle_links WHERE task_id=ANY($1::uuid[]) ORDER BY id',[Object.values(f.result.tasks)])).rows;
 expect(ok(await call(author,'POST',`/instantiations/${f.result.instantiationId}/setup`,confirm(plan),key))).toEqual(answer);
 expect(await stored(f)).toEqual(after);expect((await pool.query('SELECT * FROM access_vehicle_links WHERE task_id=ANY($1::uuid[]) ORDER BY id',[Object.values(f.result.tasks)])).rows).toEqual(links);
 expect(await call(author,'POST',`/instantiations/${f.result.instantiationId}/setup/preview`,{warrantId:warrant.id})).toMatchObject({status:409,body:{code:'BLUEPRINT_SETUP_WARRANT_UNAVAILABLE'}});
});
test('same setup key with a different confirmation is refused without additional assignment effects',async()=>{
 const f=await created();const {warrant}=await existingWarrant(f);const plan=await displayed(f,warrant.id);const key=tag();
 ok(await call(author,'POST',`/instantiations/${f.result.instantiationId}/setup`,confirm(plan),key));
 const before=await stored(f);
 expect(await call(author,'POST',`/instantiations/${f.result.instantiationId}/setup`,{...confirm(plan),confirmationHash:'0'.repeat(64)},key)).toMatchObject({status:409,body:{code:'IDEMPOTENCY_KEY_REUSED'}});
 expect(await stored(f)).toEqual(before);
 expect((await pool.query('SELECT count(*)::int AS n FROM blueprint_setup_requests WHERE instantiation_id=$1',[f.result.instantiationId])).rows[0].n).toBe(1);
});
test('parallel exact setup attempts converge on one receipt after any serialization retry',async()=>{
 const f=await created();const {warrant}=await existingWarrant(f);const plan=await displayed(f,warrant.id);const key=tag();const route=`/instantiations/${f.result.instantiationId}/setup`;
 const answers=await Promise.all([call(author,'POST',route,confirm(plan),key),call(author,'POST',route,confirm(plan),key)]);
 expect(answers.some(answer=>answer.status===200)).toBe(true);expect(answers.every(answer=>[200,503].includes(answer.status))).toBe(true);
 const receipt=answers.find(answer=>answer.status===200)!.body;
 for(const answer of answers)expect(answer.status===200?answer.body:ok(await call(author,'POST',route,confirm(plan),key))).toEqual(receipt);
 expect((await pool.query('SELECT count(*)::int AS n FROM blueprint_setup_requests WHERE instantiation_id=$1',[f.result.instantiationId])).rows[0].n).toBe(1);
 expect((await pool.query('SELECT count(*)::int AS n FROM access_vehicle_links WHERE task_id=ANY($1::uuid[])',[Object.values(f.result.tasks)])).rows[0].n).toBe(2);
 expect((await stored(f)).every((t:any)=>t.execution_service_id===f.service.id&&!t.auto_start)).toBe(true);
});

test('composed ordinary home-group plus creator policy and Blueprint channel have exact disjoint Grant sets',async()=>{
 const group=(await pool.query("INSERT INTO groups(name,description,featured) VALUES($1,'Composed policy proof',true) RETURNING id",['Composed '+tag()])).rows[0].id;
 const member=await account('user');for(const id of [author.id,member.id])await pool.query("INSERT INTO group_members(group_id,account_principal_id,source) VALUES($1,$2,'local')",[group,id]);
 await pool.query("INSERT INTO account_home_groups(account_principal_id,group_id,source) VALUES($1,$2,'self')",[author.id,group]);
 const grantRows=async(id:string)=>(await pool.query("SELECT grantee_type,grantee_id,verb,origin,provenance FROM grants WHERE resource_type='project' AND resource_id=$1 ORDER BY grantee_type,verb",[id])).rows;
 const creator=(id:string)=>['read','write'].map(verb=>({grantee_type:'principal',grantee_id:id,verb,origin:'manual',provenance:null}));
 try{
  const ordinary=ok(await call(author,'POST','/projects',{name:'Composed ordinary '+tag()}),201).project;
  expect((await pool.query("SELECT action FROM audit_events WHERE resource_type='project' AND resource_id=$1 AND action IN ('project.access_default_apply','project.access_default_skip')",[ordinary.id])).rows).toEqual([{action:'project.access_default_apply'}]);
  expect(await grantRows(ordinary.id)).toEqual([...['read','write'].map(verb=>({grantee_type:'group',grantee_id:group,verb,origin:'creation-default',provenance:null})),...creator(author.id)]);
  const task=ok(await call(author,'POST','/tasks',{title:'Inherited Task',project:ordinary.id,autoStart:false}),201).task;
  ok(await call(member,'GET',`/tasks/${task.id}`));ok(await call(member,'PATCH',`/tasks/${task.id}`,{title:'Inherited write'}));
  for(const grant of (await pool.query("SELECT id FROM grants WHERE resource_type='project' AND resource_id=$1 AND grantee_type='group'",[ordinary.id])).rows)ok(await call(author,'DELETE',`/grants/${grant.id}`));
  expect(await grantRows(ordinary.id)).toEqual(creator(author.id));expect(await call(member,'GET',`/tasks/${task.id}`)).toMatchObject({status:404});
  const skipped=ok(await call(member,'POST','/projects',{name:'Composed skip '+tag()}),201).project;expect(await grantRows(skipped.id)).toEqual(creator(member.id));
  const f=await created();expect(await grantRows(f.result.projectId)).toEqual([]);
  expect((await pool.query("SELECT action FROM audit_events WHERE resource_type='project' AND resource_id=$1 AND action IN ('project.access_default_apply','project.access_default_skip')",[f.result.projectId])).rows).toEqual([]);
 }finally{await pool.query('DELETE FROM account_home_groups WHERE account_principal_id=$1',[author.id]);}
});
test('composed Personality reference floor uses committed immutable content versions and refuses retired references',async()=>{
 const {personalityService}=require('../services/PersonalityService');const personality=await personalityService.create({slug:'blueprint-floor-'+tag(),name:'Floor fixture',content:'Initial immutable content'});
 const doc=document('unused');doc.references=[{kind:'personality',name:personality.slug,requirement:'required',minVersion:2,usedBy:['inspect']}];delete doc.tasks[0].defaults;doc.tasks[0].references=[personality.slug];
 const id=await publish(doc);const input={target:{mode:'new-project'},parameterValues:{}};
 expect(ok(await call(author,'POST',`/blueprints/${id}/instantiations/preview`,input)).plan.references).toEqual(expect.arrayContaining([expect.objectContaining({kind:'personality',outcome:'missing-required',resolved:null})]));expect(await call(author,'POST',`/blueprints/${id}/instantiations`,input,tag())).toMatchObject({status:422});
 await personalityService.update(personality.id,{content:'Second immutable content'});
 const preview=ok(await call(author,'POST',`/blueprints/${id}/instantiations/preview`,input)).plan;expect(preview.references).toEqual(expect.arrayContaining([expect.objectContaining({kind:'personality',resolved:expect.objectContaining({id:personality.id,version:2})})]));
 const created=ok(await call(author,'POST',`/blueprints/${id}/instantiations`,input,tag()),201);expect(created.projectId).toBeTruthy();
 await personalityService.retire(personality.id,'Floor proof retired');expect(ok(await call(author,'POST',`/blueprints/${id}/instantiations/preview`,input)).plan.references).toEqual(expect.arrayContaining([expect.objectContaining({kind:'personality',outcome:'missing-required',resolved:null})]));expect(await call(author,'POST',`/blueprints/${id}/instantiations`,input,tag())).toMatchObject({status:422});
});

test('workflow setup previews a new Warrant without writes, requires step-up and commits/replays atomically',async()=>{
 const f=await created();const {profile}=await existingWarrant(f);
 const holder=(await pool.query('SELECT principal_id FROM services WHERE id=$1',[f.service.id])).rows[0].principal_id;
 const createWarrant={holderPrincipalId:holder,ceilingProfileId:profile.id,expiresAt:new Date(Date.now()+3600000).toISOString()};
 const path=`/instantiations/${f.result.instantiationId}/setup`;
 const before=Number((await pool.query('SELECT count(*) n FROM warrants')).rows[0].n);
 const plan=ok(await call(author,'POST',path+'/preview',{createWarrant})).plan;
 expect(plan).toMatchObject({assignmentOnly:false,allParked:true,requiresStepUp:true});
 expect(plan.grants).toHaveLength(2);
 expect(Number((await pool.query('SELECT count(*) n FROM warrants')).rows[0].n)).toBe(before);
 const body={createWarrant,tasks:plan.tasks.map((t:any)=>({id:t.id,revision:t.revision})),confirmationHash:plan.confirmationHash};
 expect((await call(author,'POST',path,body,tag())).body.code).toBe('STEP_UP_REQUIRED');
 expect(Number((await pool.query('SELECT count(*) n FROM warrants')).rows[0].n)).toBe(before);
 const token=await require('../services/StepUpService').stepUpService.mint(author.id,'warrant.create',holder,'password');
 const confirmed={...body,stepUpToken:token.token};const key=tag();
 const result=ok(await call(author,'POST',path,confirmed,key));
 expect(result).toMatchObject({assigned:true,armed:false});
 expect(Number((await pool.query('SELECT count(*) n FROM warrants')).rows[0].n)).toBe(before+1);
 expect(ok(await call(author,'POST',path,confirmed,key))).toEqual(result);
 for(const task of await stored(f)){expect(task.auto_start).toBe(false);expect(task.execution_warrant_id).toBe(result.warrantId);}
});

test('new workflow Warrant and its step-up are rolled back when a later assignment fails',async()=>{
 const f=await created();const {profile}=await existingWarrant(f);
 const holder=(await pool.query('SELECT principal_id FROM services WHERE id=$1',[f.service.id])).rows[0].principal_id;
 const createWarrant={holderPrincipalId:holder,ceilingProfileId:profile.id,expiresAt:new Date(Date.now()+3600000).toISOString()};
 const path=`/instantiations/${f.result.instantiationId}/setup`;
 const plan=ok(await call(author,'POST',path+'/preview',{createWarrant})).plan;
 const token=await require('../services/StepUpService').stepUpService.mint(author.id,'warrant.create',holder,'password');
 const body={createWarrant,tasks:plan.tasks.map((task:any)=>({id:task.id,revision:task.revision})),confirmationHash:plan.confirmationHash,stepUpToken:token.token};
 const before=Number((await pool.query('SELECT count(*) n FROM warrants')).rows[0].n);
 const original=taskManagerDB.updateTask.bind(taskManagerDB);let count=0;
 const fault=jest.spyOn(taskManagerDB,'updateTask').mockImplementation(async(...args:any[])=>{if(++count===2)throw new Error('Fixture assignment failure');return original(...args)});
 const key=tag();expect((await call(author,'POST',path,body,key)).status).toBeGreaterThanOrEqual(500);
 expect(Number((await pool.query('SELECT count(*) n FROM warrants')).rows[0].n)).toBe(before);
 expect((await stored(f)).every((task:any)=>!task.execution_warrant_id&&!task.execution_service_id&&!task.auto_start)).toBe(true);
 fault.mockRestore();
 const result=ok(await call(author,'POST',path,body,key));expect(result).toMatchObject({assigned:true,armed:false});
 expect(Number((await pool.query('SELECT count(*) n FROM warrants')).rows[0].n)).toBe(before+1);
});

test('capture retains the assigned Task descriptor pin and detects later Connector drift',async()=>{
 const f=await created();const {warrant}=await existingWarrant(f);const plan=await displayed(f,warrant.id);
 ok(await call(author,'POST',`/instantiations/${f.result.instantiationId}/setup`,confirm(plan),tag()));
 const oldDescriptor=(await pool.query('SELECT descriptor FROM service_descriptor_versions WHERE service_id=$1 AND version=2',[f.service.id])).rows[0].descriptor;
 await serviceRegistry.publishDescriptor(f.service.id,{options:[{key:'command',type:'string'},{key:'newOption',type:'boolean'}]},String(f.service.revision),author.id);
 const captured=ok(await call(author,'POST','/blueprints/capture',{phaseId:Object.values(f.result.phases)[0]}),201).blueprint;
 const doc=ok(await call(author,'GET',`/blueprints/${captured.id}?version=1`)).blueprint.document;
 const ref=doc.references.find((reference:any)=>reference.kind==='service');
 expect(ref.minVersion).toBe(2);expect(ref.descriptorSha256).toBe(require('../utils/blueprintDocument').blueprintDigest(oldDescriptor));
 expect(JSON.stringify(doc)).not.toContain(warrant.id);
 ok(await call(author,'POST',`/blueprints/${captured.id}/versions/1/submit`,{}));
 ok(await call(reviewer,'POST',`/blueprints/${captured.id}/versions/1/publish`,{}));
 const preview=ok(await call(author,'POST',`/blueprints/${captured.id}/instantiations/preview`,{target:{mode:'new-project'},parameterValues:{project_name:'Pin proof '+tag()}})).plan;
 expect(preview.references.find((reference:any)=>reference.kind==='service')).toMatchObject({outcome:'missing-required',resolved:null});
});
