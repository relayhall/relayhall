/** Real handler/validator/PG roundtrip. Disposable fixture identities only. */
import http from 'http';
import crypto from 'crypto';
const url=process.env.RELAYHALL_TEST_DB_URL;
if(!url) throw new Error('disposable database URL required');
const parsed=new URL(url);
if(parsed.protocol!=='postgres:'||parsed.hostname!=='127.0.0.1'||parsed.pathname!=='/relayhall_unicode_import_test') throw new Error('owned disposable Unicode database only');
Object.assign(process.env,{DB_HOST:parsed.hostname,DB_PORT:parsed.port,DB_NAME:'relayhall_unicode_import_test',DB_USER:'relayhall_test',DB_PASSWORD:'',NODE_ENV:'test',RELAYHALL_SESSIONS:'on',JWT_SECRET:crypto.randomBytes(32).toString('hex')});
const express=require('express');
const {pool}=require('../db/connection');
const {registerProtectedRoutes}=require('../routeRegistry');
const {authMiddleware}=require('../middleware/auth');
const {sharedAuthorizationMiddleware}=require('../middleware/sharedAuthorization');
const {apiErrorHandler}=require('../utils/apiErrors');
const {loginSessionService,SESSION_COOKIE_NAME}=require('../services/LoginSessionService');
const {ReportManager}=require('../services/ReportManager');
let server:http.Server,origin:string,cookie:string;
const sample='caf\u00e9 cafe\u0301 \u2014 \u2013 \u65e5\u672c\u8a9e \u0627\u0644\u0639\u0631\u0628\u064a\u0629 \ud83d\ude80\r\nline2';
const hex=(s:string)=>Buffer.from(s,'utf8').toString('hex');
async function call(method:string,path:string,body?:unknown,escaped=false){
 let wire=body===undefined?undefined:JSON.stringify(body);
 if(wire&&escaped)wire=wire.replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
 const r=await fetch(origin+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie},body:wire});
 return {status:r.status,body:await r.json() as any};
}
beforeAll(async()=>{
 await pool.query("INSERT INTO principals(kind,handle,display_name,role) VALUES('human','dashboard_user','Owner','orchestrator') ON CONFLICT(handle) DO NOTHING");
 const id=(await pool.query("INSERT INTO principals(kind,handle,display_name,status,role) VALUES('human',$1,$1,'active','admin') RETURNING id",['unicode-'+crypto.randomUUID()])).rows[0].id;
 const session=await loginSessionService.mint({principalId:id});cookie=`${SESSION_COOKIE_NAME}=${session.token}`;
 const app=express();app.use(express.json());registerProtectedRoutes((mount:string,...handlers:any[])=>app.use(mount,authMiddleware,sharedAuthorizationMiddleware,...handlers));app.use(apiErrorHandler);
 await new Promise<void>(resolve=>{server=app.listen(0,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${(server.address() as any).port}`;
},15000);
afterAll(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();});
for(const escaped of [false,true]){
 test(`Task handler and PG exact import text (escaped=${escaped})`,async()=>{
  const r=await call('POST','/tasks',{title:sample,description:sample,notes:sample,status:'todo',autoStart:false},escaped);expect(r.status).toBe(201);
  const id=r.body.task.id;const row=(await pool.query("SELECT encode(convert_to(title,'UTF8'),'hex') title,encode(convert_to(description,'UTF8'),'hex') description,encode(convert_to(notes,'UTF8'),'hex') notes FROM tasks WHERE id=$1",[id])).rows[0];expect(row).toEqual({title:hex(sample),description:hex(sample),notes:hex(sample)});
  const got=await call('GET',`/tasks/${id}`);expect(got.status).toBe(200);for(const k of ['title','description','notes'])expect(got.body.task[k]).toBe(sample);
 });
 test(`Report handler and PG exact content/hash (escaped=${escaped})`,async()=>{
  const r=await call('POST','/reports',{title:sample,content:sample,summary:sample,visibility:'private'},escaped);expect(r.status).toBe(201);
  const id=r.body.report.id;const row=(await pool.query("SELECT encode(convert_to(title,'UTF8'),'hex') title,encode(convert_to(content,'UTF8'),'hex') content,content_hash FROM reports WHERE id=$1",[id])).rows[0];expect(row).toEqual({title:hex(sample),content:hex(sample),content_hash:ReportManager.computeContentHash(sample)});
  const got=await call('GET',`/reports/${id}`);expect(got.status).toBe(200);expect(got.body.report.content).toBe(sample);expect(got.body.report.title).toBe(sample);
 });
 test(`Skill REST imported draft exact raw markdown/config (escaped=${escaped})`,async()=>{
  const name='unicode-'+crypto.randomUUID();const md=`---\r\nname: ${name}\r\ndescription: "caf\u00e9 cafe\u0301"\r\n---\r\n\r\n${sample}`;
  const r=await call('POST','/skills',{name,skill_md:md,provenance:'imported',source_uri:'https://example.invalid/unicode',config:{sample},tags:['caf\u00e9'],is_global:false},escaped);expect(r.status).toBe(201);
  const id=r.body.skill.id;const row=(await pool.query("SELECT encode(convert_to(skill_md,'UTF8'),'hex') md,description,config,tags,provenance,source_uri FROM skill_versions WHERE skill_id=$1 ORDER BY version DESC LIMIT 1",[id])).rows[0];expect(row.md).toBe(hex(md));expect(row.description).toBe('caf\u00e9 cafe\u0301');expect(row.config).toEqual({sample});expect(row.tags).toEqual(['caf\u00e9']);expect(row.provenance).toBe('imported');expect(row.source_uri).toBe('https://example.invalid/unicode');
  const got=await call('GET',`/skills/${id}`);expect(got.status).toBe(200);expect(got.body.skill.current_version.status).toBe('draft');expect(got.body.skill.is_global).toBe(false);
  const version=await call('GET',`/skills/${id}/versions/1/content`);expect(version.status).toBe(200);expect(version.body.version.skill_md).toBe(md);
 });
}
