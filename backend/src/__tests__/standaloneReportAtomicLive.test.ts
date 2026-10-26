/** a799: actual PostgreSQL, auth, Report route, canonical grants and retry ledger.
 * Disposable synthetic identities only; this is not DEV/TST human acceptance. */
import http from 'http';
import crypto from 'crypto';
import { standaloneReportTestTarget } from './support/standaloneReportTestTarget';
const parsed=standaloneReportTestTarget(process.env.RELAYHALL_TEST_DB_URL,process.env.CI),database=parsed.pathname.slice(1);
Object.assign(process.env,{DB_HOST:parsed.hostname,DB_PORT:parsed.port,DB_NAME:database,
 DB_USER:decodeURIComponent(parsed.username),DB_PASSWORD:decodeURIComponent(parsed.password),
 NODE_ENV:'test',RELAYHALL_SESSIONS:'on',JWT_SECRET:crypto.randomBytes(32).toString('hex')});
const express=require('express');
const {pool}=require('../db/connection');
const {authMiddleware}=require('../middleware/auth');
const {sharedAuthorizationMiddleware}=require('../middleware/sharedAuthorization');
const reports=require('../routes/reports').default;
const {apiErrorHandler}=require('../utils/apiErrors');
const {principalService}=require('../services/PrincipalService');
const {loginSessionService,SESSION_COOKIE_NAME}=require('../services/LoginSessionService');
jest.setTimeout(30000);
type Caller={id:string;headers:Record<string,string>};
let server:http.Server,origin:string;
const tag=()=>`report-atomic-${crypto.randomBytes(6).toString('hex')}`;
async function call(who:Caller,method:string,path:string,body?:unknown,key?:string){
 const response=await fetch(origin+path,{method,headers:{'Content-Type':'application/json',...who.headers,...(key?{'Idempotency-Key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 const text=await response.text();return {status:response.status,text,body:JSON.parse(text),replay:response.headers.get('Retry-Replayed')};
}
async function human():Promise<Caller>{
 const row=(await pool.query("INSERT INTO principals(kind,handle,display_name,status,role) VALUES('human',$1,$1,'active','user') RETURNING id",[tag()])).rows[0];
 const session=await loginSessionService.mint({principalId:row.id});
 return {id:row.id,headers:{Cookie:`${SESSION_COOKIE_NAME}=${session.token}`}};
}
async function fixture(){
 const parent=await human();
 const row=(await pool.query("INSERT INTO principals(kind,handle,status,parent_principal_id,purpose,own_expression) VALUES('service',$1,'active',$2,'Disposable a799 fixture',$3) RETURNING id",[tag(),parent.id,JSON.stringify({scopes:'parent',objects:'parent'})])).rows[0];
 const credential=await principalService.issueCredential({principalId:row.id,scopes:['reports:read','reports:write'],transport:'any'},{handle:'a799-disposable-fixture',authMethod:'system'});
 return {parent,creator:{id:row.id,headers:{Authorization:`Bearer ${credential.fullKey}`}} as Caller};
}
async function grants(id:string){return (await pool.query("SELECT grantee_id,resource_type,resource_id,verb,provenance FROM grants WHERE resource_type='report' AND resource_id=$1 ORDER BY grantee_id,verb",[id])).rows;}
async function noCreation(title:string,creator:string,key:string){
 expect((await pool.query('SELECT id FROM reports WHERE title=$1',[title])).rowCount).toBe(0);
 expect((await pool.query("SELECT id FROM grants WHERE resource_type='report' AND granted_by_principal_id=$1",[creator])).rowCount).toBe(0);
 expect((await pool.query("SELECT id FROM audit_events WHERE actor_principal_id=$1 AND resource_type='report'",[creator])).rowCount).toBe(0);
 expect((await pool.query("SELECT object_id FROM feed_events WHERE actor_principal_id=$1 AND object_type='report'",[creator])).rowCount).toBe(0);
 expect((await pool.query("SELECT state FROM operation_idempotency_records WHERE operation='report.create' AND idempotency_key=$1",[key])).rowCount).toBe(0);
}
beforeAll(async()=>{
 expect((await pool.query('SELECT current_database() AS name')).rows[0].name).toBe(database);
 await pool.query("INSERT INTO principals(kind,handle,display_name,role) VALUES('human','dashboard_user','Test fallback','orchestrator') ON CONFLICT(handle) DO NOTHING");
 const app=express();app.use(express.json());app.use('/reports',authMiddleware,sharedAuthorizationMiddleware,reports);app.use(apiErrorHandler);
 await new Promise<void>(resolve=>{server=app.listen(0,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();});

test('actual canonical creation gives four exact grants; creator/sponsor maintain and unrelated human is denied',async()=>{
 const f=await fixture(),foreign=await human(),key=crypto.randomUUID();
 const result=await call(f.creator,'POST','/reports',{title:tag(),content:'synthetic private evidence',visibility:'private'},key);
 expect(result.status).toBe(201);const id=result.body.report.id,rows=await grants(id);
 expect(rows).toHaveLength(4);expect(rows.every((r:any)=>r.resource_id===id&&r.resource_type==='report'&&r.provenance===null)).toBe(true);
 expect(rows.map((r:any)=>r.grantee_id).sort()).toEqual([f.creator.id,f.creator.id,f.parent.id,f.parent.id].sort());
 expect((await call(f.creator,'PATCH',`/reports/${id}`,{summary:'creator update'})).status).toBe(200);
 expect((await call(f.parent,'PATCH',`/reports/${id}`,{summary:'sponsor update'})).status).toBe(200);
 expect((await call(foreign,'GET',`/reports/${id}`)).status).toBe(404);
 expect((await call(foreign,'PATCH',`/reports/${id}`,{summary:'forbidden'})).status).toBe(404);
 const receipt=(await pool.query("SELECT response_body,state FROM operation_idempotency_records WHERE operation='report.create' AND idempotency_key=$1",[key])).rows;
 expect(receipt).toEqual([{response_body:result.text,state:'completed'}]);
 expect((await pool.query("SELECT action FROM audit_events WHERE resource_type='report' AND resource_id=$1 AND action IN ('report.creator_access','report.sponsor_access')",[id])).rowCount).toBe(4);
});

test.each(['audit','receipt'])('real PostgreSQL %s error rolls back Report, feed, grants, audit and successful receipt',async phase=>{
 const f=await fixture(),title=tag(),key=crypto.randomUUID();
 const table=phase==='audit'?'audit_events':'operation_idempotency_records';
 const condition=phase==='audit'?"NEW.action='report.creator_access'":"NEW.operation='report.create' AND NEW.state='completed'";
 await pool.query(`CREATE FUNCTION a799_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'controlled a799 rollback'; END IF; RETURN NEW; END $$`);
 await pool.query(`CREATE TRIGGER a799_refuse BEFORE ${phase==='audit'?'INSERT':'UPDATE'} ON ${table} FOR EACH ROW EXECUTE FUNCTION a799_refuse()`);
 try{expect((await call(f.creator,'POST','/reports',{title,content:'rollback fixture'},key)).status).toBe(500);}
 finally{await pool.query(`DROP TRIGGER a799_refuse ON ${table}`);await pool.query('DROP FUNCTION a799_refuse()');}
 await noCreation(title,f.creator.id,key);
});

test('concurrent same key while first transaction is blocked creates once, then replays the exact committed response',async()=>{
 const f=await fixture(),key=crypto.randomUUID(),title=tag(),body={title,content:'concurrent fixture'};
 const blocker=await pool.connect();await blocker.query('SELECT pg_advisory_lock(79920261005::bigint)');
 await pool.query("CREATE FUNCTION a799_block() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='report.creator_access' THEN PERFORM pg_advisory_xact_lock(79920261005::bigint); END IF; RETURN NEW; END $$");
 await pool.query('CREATE TRIGGER a799_block BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION a799_block()');
 let first:ReturnType<typeof call>|undefined;
 try{
  first=call(f.creator,'POST','/reports',body,key);
  const until=Date.now()+2500;let waiting=false;
  while(Date.now()<until){waiting=(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory' AND query LIKE '%INSERT INTO audit_events%' ")).rowCount>0;if(waiting)break;await new Promise(r=>setTimeout(r,20));}
  expect(waiting).toBe(true);
  const second=await call(f.creator,'POST','/reports',body,key);expect(second.status).toBe(409);
  expect((await pool.query('SELECT id FROM reports WHERE title=$1',[title])).rowCount).toBe(0);
  await blocker.query('SELECT pg_advisory_unlock(79920261005::bigint)');
  const committed=await first;expect(committed.status).toBe(201);
  const replay=await call(f.creator,'POST','/reports',body,key);expect(replay.status).toBe(201);expect(replay.replay).toBe('true');expect(replay.text).toBe(committed.text);
  expect((await pool.query('SELECT id FROM reports WHERE title=$1',[title])).rowCount).toBe(1);expect(await grants(committed.body.report.id)).toHaveLength(4);
 }finally{await blocker.query('SELECT pg_advisory_unlock_all()');blocker.release();if(first)await first;await pool.query('DROP TRIGGER a799_block ON audit_events');await pool.query('DROP FUNCTION a799_block()');}
});

test('keyed replay does not recreate grants; durable owner access stays bounded by credentials and original account',async()=>{
 const f=await fixture(),key=crypto.randomUUID(),body={title:tag(),content:'revocation fixture',visibility:'private'};
 const first=await call(f.creator,'POST','/reports',body,key);expect(first.status).toBe(201);const id=first.body.report.id;
 await pool.query("DELETE FROM grants WHERE resource_type='report' AND resource_id=$1 AND verb='write'",[id]);
 const replay=await call(f.creator,'POST','/reports',body,key);expect(replay.status).toBe(201);expect(replay.text).toBe(first.text);expect(replay.replay).toBe('true');
 expect((await grants(id)).map((r:any)=>r.verb)).toEqual(['read','read']);
 // Durable account ownership now survives individual grant removal. The
 // connector still intersects the actual credential and delegation caps.
 expect((await call(f.parent,'PATCH',`/reports/${id}`,{summary:'owner retains control'})).status).toBe(200);
 await pool.query("UPDATE principal_credentials SET scopes=jsonb_build_array('reports:read') WHERE principal_id=$1",[f.creator.id]);
 expect((await call(f.creator,'PATCH',`/reports/${id}`,{summary:'credential denied'})).status).toBe(403);
 const newParent=await human();await pool.query('UPDATE principals SET parent_principal_id=$2 WHERE id=$1',[f.creator.id,newParent.id]);
 expect((await call(newParent,'GET',`/reports/${id}`)).status).toBe(404);
 expect((await call(f.parent,'GET',`/reports/${id}`)).status).toBe(200);
 expect((await grants(id)).some((r:any)=>r.grantee_id===newParent.id)).toBe(false);
});

test.each(['scope','reparent'])('%s change while creation waits for principal lock refuses without a partial Report',async mutation=>{
 const f=await fixture(),newParent=await human(),title=tag(),key=crypto.randomUUID(),blocker=await pool.connect();
 await blocker.query('BEGIN');await blocker.query('SELECT id FROM principals WHERE id=$1 FOR NO KEY UPDATE',[f.creator.id]);
 let pending:ReturnType<typeof call>|undefined;
 try{
  pending=call(f.creator,'POST','/reports',{title,content:'authority race'},key);
  const until=Date.now()+2500;let waiting=false;
  while(Date.now()<until){waiting=(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT id,status,legacy_identity FROM principals%' ")).rowCount>0;if(waiting)break;await new Promise(r=>setTimeout(r,20));}
  expect(waiting).toBe(true);
  if(mutation==='scope') await blocker.query("UPDATE principals SET own_expression=$2 WHERE id=$1",[f.creator.id,JSON.stringify({scopes:['reports:read'],objects:'parent'})]);
  else await blocker.query('UPDATE principals SET parent_principal_id=$2 WHERE id=$1',[f.creator.id,newParent.id]);
  await blocker.query('COMMIT');
  const result=await pending;expect(result.status).toBe(mutation==='scope'?403:409);
  expect(result.body.code).toBe(mutation==='scope'?'REPORT_CREATOR_REQUIRED':'REPORT_SPONSOR_UNAVAILABLE');
  await noCreation(title,f.creator.id,key);
 }finally{await blocker.query('ROLLBACK');blocker.release();if(pending)await pending;}
});
