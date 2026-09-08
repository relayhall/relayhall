/** Production-router descriptor proof; isolated DB only, excluded from default Jest. */
import http from 'http';
import crypto from 'crypto';
const url=process.env.RELAYHALL_TEST_DB_URL;if(!url)throw new Error('RELAYHALL_TEST_DB_URL required for descriptor live proof');
const parsed=new URL(url);const db=decodeURIComponent(parsed.pathname.slice(1));
const local=['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)&&/(test|contract|fixture)/i.test(db)&&!db.toLowerCase().includes('clawboard');
const ci=process.env.CI==='true'&&parsed.hostname==='postgres'&&parsed.port==='5432'&&db==='relayhall_ci'&&parsed.username==='relayhall_ci';
if(!local&&!ci)throw new Error('Descriptor proof requires the exact owned fixture or CI database');
Object.assign(process.env,{DB_HOST:parsed.hostname,DB_PORT:parsed.port,DB_NAME:db,DB_USER:decodeURIComponent(parsed.username),DB_PASSWORD:decodeURIComponent(parsed.password),NODE_ENV:'test',RELAYHALL_SESSIONS:'on',JWT_SECRET:'descriptor-fixture-only-key-0123456789'});delete process.env.BOOT_CHECK;
const express=require('express');const {pool}=require('../db/connection');
const {registerProtectedRoutes}=require('../routeRegistry');const {authMiddleware}=require('../middleware/auth');const {sharedAuthorizationMiddleware}=require('../middleware/sharedAuthorization');const {apiErrorHandler}=require('../utils/apiErrors');const {jsonBodyOptions}=require('../utils/jsonBodyTypes');
const {loginSessionService,SESSION_COOKIE_NAME}=require('../services/LoginSessionService');const {principalService}=require('../services/PrincipalService');const {serviceRegistry}=require('../services/ServiceRegistry');
let server:http.Server;let origin:string;let author:{id:string;headers:Record<string,string>};let reviewer:typeof author;
const tag=()=>crypto.randomBytes(8).toString('hex');
async function account(){const id=(await pool.query("INSERT INTO principals(kind,handle,display_name,status,role) VALUES('human',$1,$1,'active','admin') RETURNING id",['descriptor-'+tag()])).rows[0].id;const {token}=await loginSessionService.mint({principalId:id});return {id,headers:{Cookie:`${SESSION_COOKIE_NAME}=${token}`}};}
async function call(who:typeof author,method:string,path:string,body?:unknown,key?:string){const response=await fetch(origin+path,{method,headers:{'Content-Type':'application/json',...who.headers,...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json() as any};}
function ok(result:{status:number;body:any},status=200){expect(result.status===status?{status:result.status}:result).toEqual({status});return result.body;}
function document(service:string){return {schemaVersion:'rh.blueprint/1.0',blueprint:{key:'descriptor-'+tag(),name:'Descriptor proof',version:1,summary:'',description:'',tags:[],provenance:'human-authored'},parameters:[{key:'answer',label:'Answer',promptText:'Text?',type:'string',required:false,default:'Inspect'}],references:[{kind:'service',name:service,requirement:'required',minVersion:2}],target:{mode:'new-project',project:{name:'Descriptor '+tag()}},phases:[],tasks:[{key:'inspect',title:'Inspect',defaults:{executionProfile:{service,options:{command:'Run {{answer}}'} as any}}}],humanGates:[],reports:[],dependencies:[]};}
async function publish(doc:any){const id=ok(await call(author,'POST','/blueprints',doc),201).blueprint.id;ok(await call(author,'POST',`/blueprints/${id}/versions/1/submit`,{}));ok(await call(reviewer,'POST',`/blueprints/${id}/versions/1/publish`,{}));return id;}
async function connector(){let service=await serviceRegistry.register({slug:'descriptor-'+tag(),name:'Descriptor fixture',kind:'connector'},author.id);const first=await serviceRegistry.publishDescriptor(service.id,{options:[{key:'command',type:'number'}]},String(service.revision),author.id);service=await serviceRegistry.update(service.id,{status:'published'},String(first.service.revision),author.id);const next=await serviceRegistry.publishDescriptor(service.id,{options:[{key:'command',type:'string'},{key:'mode',type:'enum',values:[{value:'Inspect'}]},{key:'privateMarker',type:'string',default:'Visible descriptor marker'}]},String(service.revision),author.id);return next.service;}
beforeAll(async()=>{const app=express();app.use(express.json(jsonBodyOptions));registerProtectedRoutes((mount:string,...handlers:any[])=>app.use(mount,authMiddleware,sharedAuthorizationMiddleware,...handlers));app.use(apiErrorHandler);await new Promise<void>(resolve=>{server=app.listen(0,'127.0.0.1',resolve)});origin=`http://127.0.0.1:${(server.address() as any).port}`;author=await account();reviewer=await account();});
afterAll(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();});jest.setTimeout(90000);
test('D3 live pinned descriptor string values are literal; enum substitutions refuse and execution defaults stage without assignment',async()=>{
 const service=await connector();const doc=document(service.slug);const id=await publish(doc);const input={target:{mode:'new-project'},parameterValues:{answer:'{{other}}'}};
 const before=(await pool.query('SELECT count(*)::int AS n FROM grants')).rows[0].n;
 const result=ok(await call(author,'POST',`/blueprints/${id}/instantiations/preview`,input));
 expect(result.plan.tasks[0].executionProfile).toEqual({serviceId:service.id,descriptorVersion:2,options:{command:'Run {{other}}'}});
 expect(result.plan.tasks[0].defaults.executionProfile.options).toEqual({command:'Run {{other}}'});
 expect(JSON.stringify(result)).not.toContain('Visible descriptor marker');expect(JSON.stringify(result)).not.toContain('"descriptor":');
 const receipt=ok(await call(author,'POST',`/blueprints/${id}/instantiations`,input,tag()),201);
 expect(receipt.executionSetup).toEqual({required:true,taskCount:1});
 expect((await pool.query('SELECT execution_service_id,auto_start FROM tasks WHERE id=$1',[receipt.tasks.inspect])).rows[0]).toEqual({execution_service_id:null,auto_start:false});
 // D7: the server-owned Blueprint channel writes no ordinary creator Grant pair.
 expect((await pool.query('SELECT count(*)::int AS n FROM grants')).rows[0].n).toBe(before);
 expect((await pool.query('SELECT * FROM access_vehicle_links WHERE task_id=$1',[receipt.tasks.inspect])).rows).toEqual([]);
 const bad=document(service.slug);bad.tasks[0].defaults.executionProfile.options={mode:'{{answer}}'};const badId=await publish(bad);
 expect(await call(author,'POST',`/blueprints/${badId}/instantiations/preview`,{target:{mode:'new-project'},parameterValues:{answer:'Inspect'}})).toMatchObject({status:422,body:{field:'tasks.inspect.defaults.executionProfile.options.mode'}});
});
test('D6 live caller explicitly narrowed away from a Service cannot obtain its descriptor through preview',async()=>{
 const service=await connector();const id=await publish(document(service.slug));
 const parent=(await pool.query("INSERT INTO principals(kind,handle,display_name,status,role,purpose) VALUES('service',$1,$1,'active','user','Fixture') RETURNING id",['descriptor-parent-'+tag()])).rows[0].id;
 const child=(await pool.query("INSERT INTO principals(kind,handle,display_name,status,parent_principal_id,role,purpose,own_expression) VALUES('service',$1,$1,'active',$2,'user','Fixture',$3::jsonb) RETURNING id",['descriptor-child-'+tag(),parent,JSON.stringify({scopes:'parent',objects:'parent'})])).rows[0].id;
 const credential=await principalService.issueCredential({principalId:child,scopes:['blueprints:use'],transport:'any'},{principalId:author.id,handle:'fixture',authMethod:'system'});
 for(const who of [parent,child])await pool.query("INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id) VALUES('principal',$1,'blueprint',$2,'use',$3)",[who,id,author.id]);
 // Published Services have a canonical visibility arm; narrow it explicitly.
 await pool.query('UPDATE principals SET own_expression=$2::jsonb WHERE id=$1',[child,JSON.stringify({scopes:'parent',objects:[
  {resourceType:'blueprint',selectorForm:'all-of-type',selectorIds:[],verbs:['use']},
  {resourceType:'service',selectorForm:'all-except',selectorIds:[service.id],verbs:['read']},
 ]})]);
 const limited={id:child,headers:{Authorization:`Bearer ${credential.fullKey}`}};
 const result=ok(await call(limited,'POST',`/blueprints/${id}/instantiations/preview`,{target:{mode:'new-project'},parameterValues:{}}));
 expect(result.plan.references).toEqual([{kind:'service',name:service.slug,outcome:'missing-required',resolved:null,reason:'The named element is unavailable or not granted',requiredAccess:'services:read and services:invoke'}]);expect(result.plan.tasks[0].executionProfile).toBeNull();
 expect(JSON.stringify(result)).not.toContain('Visible descriptor marker');expect(JSON.stringify(result)).not.toContain(service.id);
});