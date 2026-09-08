/** Actual example export/import/creation across three clean PostgreSQL databases.
 * Run only through the owned fixture driver. Test accounts are synthetic: this
 * is neither the seven-step agent interview nor human clean-room acceptance.
 */
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
const stage=process.env.BLUEPRINT_EXAMPLE_STAGE;
const profile=process.env.BLUEPRINT_EXAMPLE_PROFILE;
const artifactRoot=process.env.BLUEPRINT_EXAMPLE_ARTIFACTS;
const url=process.env.RELAYHALL_TEST_DB_URL;
const refuse=():never=>{throw new Error('EXAMPLE_CONFIG_REFUSED: exact profile, stage and disposable database required')};
if(!url||!artifactRoot||!path.isAbsolute(artifactRoot)||!['a','b','c'].includes(stage??''))refuse();
const parsed=(()=>{try{return new URL(url!)}catch{return refuse()}})();
const database=decodeURIComponent(parsed.pathname.slice(1));
const local=profile==='local'&&parsed.hostname==='127.0.0.1'&&parsed.port==='55437'&&parsed.username==='postgres';
const ci=profile==='ci'&&process.env.CI==='true'&&parsed.hostname==='postgres'&&parsed.port==='5432'&&parsed.username==='relayhall_ci';
if(!['postgres:','postgresql:'].includes(parsed.protocol)||!parsed.password||parsed.search||parsed.hash||!(local||ci)||database!==`blueprint_examples_test_${stage}_20260906`)refuse();
Object.assign(process.env,{DB_HOST:parsed.hostname,DB_PORT:parsed.port,DB_NAME:database,DB_USER:decodeURIComponent(parsed.username),DB_PASSWORD:decodeURIComponent(parsed.password),NODE_ENV:'test',RELAYHALL_SESSIONS:'on',JWT_SECRET:'blueprint-examples-only-jwt-0123456789'});
delete process.env.BOOT_CHECK;
const express=require('express');
const {pool}=require('../db/connection');
const {registerProtectedRoutes}=require('../routeRegistry');
const {authMiddleware}=require('../middleware/auth');
const {sharedAuthorizationMiddleware}=require('../middleware/sharedAuthorization');
const {apiErrorHandler}=require('../utils/apiErrors');
const {jsonBodyOptions}=require('../utils/jsonBodyTypes');
const {loginSessionService,SESSION_COOKIE_NAME}=require('../services/LoginSessionService');
type Row=Record<string,any>;
interface Caller{id:string;handle:string;headers:Record<string,string>}
let server:http.Server;let origin:string;let author:Caller;let reviewer:Caller;let user:Caller;
const principals:Record<string,Caller>={};const skillIds:Record<string,string>={};
const names=['project-design','governed-deployment','incident-investigation'];
const sourceFolder=path.resolve(__dirname,'../../../docs/blueprints/examples');
const artifacts=artifactRoot as string;
const tag=()=>crypto.randomBytes(8).toString('hex');
function canonical(value:any):string{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 return JSON.stringify(value);
}
const digest=(value:any)=>crypto.createHash('sha256').update(canonical(value)).digest('hex');
function digests(doc:Row){return {content:digest(doc),identity:digest({...doc,blueprint:{...doc.blueprint,key:''}})}}
const read=(name:string)=>JSON.parse(fs.readFileSync(path.join(artifacts,name+'.json'),'utf8'));
const write=(name:string,value:any)=>fs.writeFileSync(path.join(artifacts,name+'.json'),JSON.stringify(value,null,2));
const source=(name:string)=>JSON.parse(fs.readFileSync(path.join(sourceFolder,name+'.json'),'utf8'));
async function account(handle:string):Promise<Caller>{
 const id=(await pool.query("INSERT INTO principals(kind,handle,display_name,status,role) VALUES('human',$1,$1,'active','admin') RETURNING id",[handle])).rows[0].id;
 const {token}=await loginSessionService.mint({principalId:id});return {id,handle,headers:{Cookie:`${SESSION_COOKIE_NAME}=${token}`}};
}
async function call(who:Caller,method:string,route:string,body?:unknown,key?:string){
 const response=await fetch(origin+route,{method,headers:{'Content-Type':'application/json',...who.headers,...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const text=await response.text();let value:any;try{value=JSON.parse(text)}catch{value=text}return {status:response.status,body:value};
}
function ok(answer:{status:number;body:any},status=200){expect(answer).toMatchObject({status});return answer.body;}
async function skill(name:string){
 expect((await pool.query('SELECT id FROM skills WHERE name=$1',[name])).rows).toHaveLength(0);
 const id=(await pool.query('INSERT INTO skills(name) VALUES($1) RETURNING id',[name])).rows[0].id;
 const version=(await pool.query("INSERT INTO skill_versions(skill_id,version,skill_md,description,provenance,created_by_principal_id) VALUES($1,1,$2,'Synthetic example prerequisite','human-authored',$3) RETURNING id",[id,'# '+name,author.id])).rows[0].id;
 for(const status of ['draft','review','published'])await pool.query('INSERT INTO skill_version_events(skill_version_id,status,actor_principal_id) VALUES($1,$2,$3)',[version,status,status==='published'?reviewer.id:author.id]);
 skillIds[name]=id;
}
beforeAll(async()=>{
 expect((await pool.query('SELECT current_database() AS name')).rows[0].name).toBe(database);
 expect((await pool.query('SELECT count(*)::int AS n FROM blueprints')).rows[0].n).toBe(0);
 expect((await pool.query("SELECT id FROM services WHERE slug='hermes'")).rows).toHaveLength(0);
 const app=express();app.use(express.json(jsonBodyOptions));registerProtectedRoutes((mount:string,...handlers:any[])=>app.use(mount,authMiddleware,sharedAuthorizationMiddleware,...handlers));app.use(apiErrorHandler);
 await new Promise<void>(resolve=>{server=app.listen(0,'127.0.0.1',resolve)});origin=`http://127.0.0.1:${(server.address() as any).port}`;
 author=await account('example-author');reviewer=await account('example-reviewer');user=await account('example-caller');
 for(const key of ['author_principal','verifier_principal','ratifier_principal','approver','deployer','incident_commander','scribe'])principals[key]=await account('example-'+key.replace(/_/g,'-'));
 for(const name of ['design-review-brief','deployment-runbook','incident-triage','postmortem-template'])await skill(name);
 const identities={database,principals:Object.fromEntries(Object.entries(principals).map(([key,p])=>[key,p.id])),skills:skillIds};
 if(stage!=='a'){
  const originIds=read('a-identities');expect(identities.database).not.toBe(originIds.database);
  for(const key of Object.keys(principals))expect(identities.principals[key]).not.toBe(originIds.principals[key]);
  for(const key of Object.keys(skillIds))expect(skillIds[key]).not.toBe(originIds.skills[key]);
 }
 write(stage+'-identities',identities);
});
afterAll(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end()});
jest.setTimeout(90000);
async function parameters(name:string){
 if(name==='project-design'){
  const id=(await pool.query("INSERT INTO projects(name,status,visibility) VALUES('Example existing project','active','private') RETURNING id")).rows[0].id;
  return {target:{mode:'existing-project',project:id},parameterValues:{design_name:'Portable design',owning_project:id,author_principal:principals.author_principal.handle,verifier_principal:principals.verifier_principal.handle,ratifier_principal:principals.ratifier_principal.handle,governing_documents:'Reviewed governing record',review_rounds_cap:4}};
 }
 if(name==='governed-deployment')return {target:{mode:'new-project'},parameterValues:{change_name:'Portable change',target_environment:'staging',repository:'example repository',approver:principals.approver.handle,deployer:principals.deployer.handle,rollback_window_hours:24}};
 return {target:{mode:'new-project'},parameterValues:{incident_number:'INC-42',incident_title:'Fixture incident',severity:'sev2',affected_hostname:'example-host',incident_commander:principals.incident_commander.handle,scribe:principals.scribe.handle,detected_at:'2026-09-06'}};
}
async function publish(id:string,version:number){
 ok(await call(author,'POST',`/blueprints/${id}/versions/${version}/submit`,{}));
 expect((await call(author,'POST',`/blueprints/${id}/versions/${version}/publish`,{})).status).toBe(403);
 ok(await call(reviewer,'POST',`/blueprints/${id}/versions/${version}/publish`,{}));
}
const sort=(rows:any[])=>rows.sort((a,b)=>canonical(a).localeCompare(canonical(b)));
async function storedShape(doc:Row,created:Row,preview:Row){
 const taskIds=Object.values(created.tasks);const taskKey=Object.fromEntries(Object.entries(created.tasks).map(([key,id])=>[String(id),key]));
 const phaseKey=Object.fromEntries(Object.entries(created.phases).map(([key,id])=>[String(id),key]));
 const principalKey=Object.fromEntries(Object.entries(principals).map(([key,p])=>[p.id,key]));
 const tasks=(await pool.query('SELECT t.id,t.title,t.description,t.definition_of_done,t.phase_id,t.auto_start,t.execution_profile,t.execution_service_id,t.blueprint_key,t.blueprint_version,t.blueprint_content_sha256,t.blueprint_identity_sha256,t.instantiation_id,a.armed,a.shepherd_principal_id,a.verifier_principal_id FROM tasks t JOIN task_assignments a ON a.task_id=t.id WHERE t.id=ANY($1::uuid[])',[taskIds])).rows;
 const phases=(await pool.query('SELECT id,name,position FROM phases WHERE id=ANY($1::uuid[])',[Object.values(created.phases)])).rows;
 const subtasks=(await pool.query('SELECT task_id,title AS text,index,status,completed_at FROM subtasks WHERE task_id=ANY($1::uuid[]) ORDER BY task_id,index',[taskIds])).rows;
 const edges=(await pool.query('SELECT task_id,depends_on_task_id FROM task_dependencies WHERE task_id=ANY($1::uuid[])',[taskIds])).rows;
 const reports=(await pool.query('SELECT id,title,content,task_ids FROM reports WHERE id=ANY($1::uuid[])',[Object.values(created.reports)])).rows;
 const refs=(await pool.query("SELECT task_id,kind,target_id,label FROM task_references WHERE task_id=ANY($1::uuid[]) AND kind='skill'",[taskIds])).rows;
 const expectedDigests=digests(doc);
 expect(tasks).toHaveLength(doc.tasks.length+doc.humanGates.length);expect(phases).toHaveLength(doc.phases.length);expect(reports).toHaveLength(doc.reports.length);
 expect(subtasks).toHaveLength(doc.tasks.reduce((n:number,t:Row)=>n+(t.subtasks?.length??0),0)+doc.humanGates.reduce((n:number,g:Row)=>n+g.arms.length,0));
 for(const task of tasks){expect(task).toMatchObject({auto_start:false,armed:false,execution_service_id:null,blueprint_key:doc.blueprint.key,blueprint_version:doc.blueprint.version,blueprint_content_sha256:expectedDigests.content,blueprint_identity_sha256:expectedDigests.identity,instantiation_id:created.instantiationId});expect(task.execution_profile).toBeNull()}
 for(const subtask of subtasks)expect(subtask).toMatchObject({completed_at:null,status:'empty'});
 const expectedEdges=new Set(doc.dependencies.map((edge:Row)=>edge.task+'|'+edge.dependsOn));
 for(const gate of doc.humanGates){
  const deciderKey=/^\{\{(.+)\}\}$/.exec(gate.decider)![1];const gateTask=tasks.find((t:Row)=>t.id===created.tasks[gate.key]);
  expect(gateTask.verifier_principal_id).toBe(principals[deciderKey].id);expect(gateTask.definition_of_done).toContain(gate.decisionPrompt);
  expect(subtasks.filter((s:Row)=>s.task_id===gateTask.id).map((s:Row)=>s.text)).toEqual(gate.arms.map((a:Row)=>a.label));
  for(const arm of gate.arms)for(const key of arm.tasks){expectedEdges.add(key+'|'+gate.key);expect(tasks.find((t:Row)=>t.id===created.tasks[key]).shepherd_principal_id).toBe(principals[deciderKey].id)}
 }
 // Independently enumerated descendants of the SHIPPED examples (design
 // ARM-THE-ARMS), not a call to/reimplementation of expandedDependencies.
 if(doc.parameters.some((p:Row)=>p.key==='change_name'))expectedEdges.add('close-change|go-no-go');
 if(doc.parameters.some((p:Row)=>p.key==='incident_number'))for(const edge of ['postmortem|fix-decision','postmortem-review|fix-decision'])expectedEdges.add(edge);
 const actualEdges=edges.map((e:Row)=>taskKey[e.task_id]+'|'+taskKey[e.depends_on_task_id]).sort();expect(actualEdges).toEqual([...expectedEdges].sort());
 expect(preview.dependencies.map((e:Row)=>e.task+'|'+e.dependsOn).sort()).toEqual(actualEdges);
 for(const ref of refs){expect(ref.target_id).toBe(skillIds[ref.label]);expect(taskKey[ref.task_id]).toBeDefined()}
 const expectedRefs=sort(doc.tasks.flatMap((t:Row)=>(t.references??[]).filter((name:string)=>skillIds[name]).map((name:string)=>({task:t.key,name}))));
 expect(sort(refs.map((r:Row)=>({task:taskKey[r.task_id],name:r.label})))).toEqual(expectedRefs);
 const projectCount=(await pool.query('SELECT count(*)::int AS n FROM projects WHERE instantiation_id=$1',[created.instantiationId])).rows[0].n;
 const counts={projects:projectCount,phases:phases.length,tasks:tasks.length,subtasks:subtasks.length,reports:reports.length,edges:edges.length};
 const fixedCounts:Record<string,Row>={'project-design':{projects:0,phases:3,tasks:10,subtasks:2,reports:0,edges:10},'governed-deployment':{projects:1,phases:4,tasks:10,subtasks:2,reports:1,edges:11},'incident-investigation':{projects:1,phases:4,tasks:10,subtasks:5,reports:1,edges:11}};
 const originalName=doc.parameters.some((p:Row)=>p.key==='incident_number')?'incident-investigation':doc.blueprint.key;expect(counts).toEqual(fixedCounts[originalName]);
 for(const table of ['phases','tasks','subtasks','reports']){
  const rows=(await pool.query(`SELECT blueprint_key,blueprint_version,blueprint_content_sha256,blueprint_identity_sha256 FROM ${table} WHERE instantiation_id=$1`,[created.instantiationId])).rows;
  expect(rows).toHaveLength(counts[table as keyof typeof counts]);for(const row of rows)expect(row).toEqual({blueprint_key:doc.blueprint.key,blueprint_version:doc.blueprint.version,blueprint_content_sha256:expectedDigests.content,blueprint_identity_sha256:expectedDigests.identity});
 }
 if(doc.target.mode==='new-project')expect((await pool.query('SELECT blueprint_key,blueprint_content_sha256,blueprint_identity_sha256 FROM projects WHERE id=$1',[created.projectId])).rows[0]).toEqual({blueprint_key:doc.blueprint.key,blueprint_content_sha256:expectedDigests.content,blueprint_identity_sha256:expectedDigests.identity});
 const ordinary=ok(await call(user,'GET',`/tasks/${taskIds[0]}`)).task;expect(ordinary.instantiationId).toBe(created.instantiationId);expect(ordinary.blueprintKey).toBe(doc.blueprint.key);
 return {counts,edges:actualEdges,phases:sort(phases.map((p:Row)=>({key:phaseKey[p.id],name:p.name,position:p.position}))),
  tasks:sort(tasks.map((t:Row)=>({key:taskKey[t.id],title:t.title,description:t.description,definitionOfDone:t.definition_of_done,phase:phaseKey[t.phase_id]??null,shepherd:principalKey[t.shepherd_principal_id]??null,verifier:principalKey[t.verifier_principal_id]??null,autoStart:t.auto_start,armed:t.armed}))),
  subtasks:sort(subtasks.map((s:Row)=>({task:taskKey[s.task_id],text:s.text,index:s.index,status:s.status,completedAt:s.completed_at}))),
  reports:sort(reports.map((r:Row)=>({title:r.title,content:r.content,tasks:r.task_ids.map((id:string)=>taskKey[id]).sort()}))),
  references:sort(refs.map((r:Row)=>({task:taskKey[r.task_id],kind:r.kind,name:r.label}))),
  gates:preview.humanGates.map((g:Row)=>({key:g.key,decider:principalKey[g.decider.id],arms:g.arms,allParked:g.allParked}))};
}
async function instantiate(doc:Row,id:string,name:string,overrides:Row={}){
 const selected=await parameters(name);const body={...selected,parameterValues:{...selected.parameterValues,...overrides}};const before=Number((await pool.query('SELECT count(*) AS n FROM grants')).rows[0].n);
 let preview=ok(await call(user,'POST',`/blueprints/${id}/instantiations/preview`,body)).plan;
 if(preview.references.some((reference:Row)=>reference.outcome==='missing-optional')){
  expect(preview.refusals[0].code).toBe('BLUEPRINT_REFERENCE_ACCESS_REQUIRED');
  expect((await call(user,'POST',`/blueprints/${id}/instantiations`,body,tag())).status).toBe(422);
  for(const reference of preview.references.filter((reference:Row)=>reference.outcome==='missing-optional')){
   if(reference.kind==='service'){
    const {serviceRegistry}=require('../services/ServiceRegistry');
    const service=await serviceRegistry.register({slug:reference.name,name:'Example Connector',kind:'connector'},author.id);
    const descriptor=await serviceRegistry.publishDescriptor(service.id,{options:[]},String(service.revision),author.id);
    await serviceRegistry.update(service.id,{status:'published'},String(descriptor.service.revision),author.id);
   } else if(reference.kind==='personality'){
    await require('../services/PersonalityService').personalityService.create({slug:reference.name,name:'Example Personality',content:'Synthetic example prerequisite'});
   } else throw new Error('Unexpected missing example prerequisite');
  }
  preview=ok(await call(user,'POST',`/blueprints/${id}/instantiations/preview`,body)).plan;
 }
 expect(preview.refusals).toEqual([]);
 const created=ok(await call(user,'POST',`/blueprints/${id}/instantiations`,body,tag()),201);
 if(name!=='project-design'){
  expect(preview.references).toContainEqual(expect.objectContaining({kind:'service',name:'hermes',outcome:'resolved'}));
  expect(created.warnings).toEqual([]);
 }
 expect(Number((await pool.query('SELECT count(*) AS n FROM grants')).rows[0].n)).toBe(before);
 const shape=await storedShape(doc,created,preview);return {shape,created,warnings:created.warnings};
}
async function imported(document:Row,rename?:string){
 const payload={document,...(rename?{rename}:{})};const value=ok(await call(author,'POST','/blueprints/import',payload),201).blueprint;
 expect(value).toMatchObject({status:'draft',version:document.blueprint.version});
 const expected={...document,blueprint:{...document.blueprint,...(rename?{key:rename}:{})}};
 const view=ok(await call(author,'GET',`/blueprints/${value.id}?version=${document.blueprint.version}`)).blueprint;
 expect(canonical(view.document)).toBe(canonical(expected));expect(view.contentSha256).toBe(digests(expected).content);expect(view.identitySha256).toBe(digests(expected).identity);
 expect((await call(user,'POST',`/blueprints/${value.id}/instantiations`,await parameters(document.parameters.some((p:Row)=>p.key==='incident_number')?'incident-investigation':document.blueprint.key),tag())).body.code).toBe('BLUEPRINT_NOT_PUBLISHED');
 await publish(value.id,document.blueprint.version);return {id:value.id,doc:expected,view};
}
describe('three-installation actual Blueprint example round trips',()=>{
 if(stage==='a')test.each(names)('%s origin publishes, exports portable bytes and stores exact ordinary graph',async name=>{
  const doc=source(name);const id=ok(await call(author,'POST','/blueprints',doc),201).blueprint.id;await publish(id,doc.blueprint.version);
  const exported=ok(await call(author,'GET',`/blueprints/${id}/versions/${doc.blueprint.version}/export`));expect(canonical(exported)).toBe(canonical(doc));
  const result=await instantiate(doc,id,name);write('origin-'+name,{document:exported,digests:digests(doc),...result});
 });
 if(stage==='b'){
  test.each(names)('%s imports into clean B and stores the same exact graph with B identities',async name=>{
   const originResult=read('origin-'+name);const importedResult=await imported(originResult.document);const result=await instantiate(importedResult.doc,importedResult.id,name);
   expect(result.shape).toEqual(originResult.shape);expect(result.created.projectId).not.toBe(originResult.created.projectId);for(const key of Object.keys(result.created.tasks))expect(result.created.tasks[key]).not.toBe(originResult.created.tasks[key]);
   write('b-'+name,{...result,digests:digests(importedResult.doc)});
  });
  test('incident explicit rename in B changes integrity only and stamps the imported local digest',async()=>{
   const original=read('origin-incident-investigation');const item=await imported(original.document,'incident-response');
   // A second instance in B needs a distinct ordinary Project name. The
   // unchanged-name A/B case above already compares every stored text field.
   const result=await instantiate(item.doc,item.id,'incident-investigation',{incident_number:'INC-43'});
   for(const field of ['counts','edges','gates'] as const)expect(result.shape[field]).toEqual(original.shape[field]);expect(item.view.contentSha256).not.toBe(original.digests.content);expect(item.view.identitySha256).toBe(original.digests.identity);write('b-renamed',{digests:digests(item.doc),...result});
  });
 }
 if(stage==='c'){
  test('incident second clean rename has its own integrity, shared identity and C provenance',async()=>{
   const original=read('origin-incident-investigation');const b=read('b-renamed');const item=await imported(original.document,'inc-sop');const result=await instantiate(item.doc,item.id,'incident-investigation');
   expect(result.shape).toEqual(original.shape);expect(item.view.contentSha256).not.toBe(original.digests.content);expect(item.view.contentSha256).not.toBe(b.digests.content);expect(item.view.identitySha256).toBe(original.digests.identity);write('c-renamed',{digests:digests(item.doc),...result});
  });
  test('a task title change alters both independently recomputed digests; external claimed hashes are not accepted',async()=>{
   const original=read('origin-incident-investigation');const changed=JSON.parse(JSON.stringify(original.document));changed.tasks[0].title='Changed triage {{incident_number}}';
   const item=await imported(changed,'incident-edited');expect(item.view.contentSha256).not.toBe(original.digests.content);expect(item.view.identitySha256).not.toBe(original.digests.identity);
   const forged=await call(author,'POST','/blueprints/import',{document:original.document,rename:'incident-forged',contentSha256:original.digests.content,identitySha256:original.digests.identity});expect(forged.status).toBe(422);
   expect((await pool.query("SELECT id FROM blueprints WHERE key='incident-forged'")).rows).toHaveLength(0);
  });
 }
});
