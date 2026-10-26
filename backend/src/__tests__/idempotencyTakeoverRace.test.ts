/** Focused acquisition races over REAL PostgreSQL; not an auth or live-user proof. */
import http from 'http';
import crypto from 'crypto';
import { Pool } from 'pg';
const url = process.env.RELAYHALL_TEST_DB_URL;
if (!url) throw new Error('owned disposable PostgreSQL URL required');
const target = new URL(url);
if (target.hostname !== '127.0.0.1' || target.pathname !== '/relayhall_idempotency_rebranch_test') {
  throw new Error('only the owned disposable rebranch database is permitted');
}
Object.assign(process.env, { DB_HOST:target.hostname, DB_PORT:target.port, DB_NAME:'relayhall_idempotency_rebranch_test',
  DB_USER:'relayhall_test', DB_PASSWORD:'', NODE_ENV:'test' });
const express = require('express');
const { idempotent, canonicalRequestHash, setIdempotencyPool, resetIdempotencyPool } = require('../middleware/idempotency');
const { pool: housePool } = require('../db/connection');
const { apiErrorHandler } = require('../utils/apiErrors');
const db = new Pool({ connectionString:url });
const competitor = new Pool({ connectionString:url, max:1 });
const principal = crypto.randomUUID();
const credentialScope = `cred:${principal}`;
let server:http.Server, origin:string, calls=0, current:any, body={ act:'same' };
let intercept:((sql:string, args:unknown[], execute:()=>Promise<any>)=>Promise<any>) | null = null;
let writes=0, lost=0;
const adapter:any = { query:async(sql:string,args:unknown[])=>{
  if (/^(INSERT|UPDATE|DELETE)/.test(sql.trim())) writes++;
  const execute=()=>db.query(sql,args);
  return intercept ? intercept(sql,args,execute) : execute();
} };
const hash = (payload=body)=>canonicalRequestHash({params:{},body:payload});
async function row() { return (await db.query('SELECT * FROM operation_idempotency_records WHERE idempotency_key=$1',[current.key])).rows[0]; }
async function seed(policy='return',state='in_flight',expired=false,requestHash=hash()) {
  const op=policy==='refuse'?'agent.mint.request':'task.create';
  const s=credentialScope;
  current={key:crypto.randomUUID(),op,scope:s};
  return (await db.query(`INSERT INTO operation_idempotency_records
    (scope,operation,idempotency_key,request_hash,state,replay_policy,created_at,expires_at,response_status,response_body,response_content_type)
    VALUES($1,$2,$3,$4,$5,$6,now()-interval '2 minutes',now()+$7::interval,$8,$9,$10) RETURNING request_id`,
    [s,op,current.key,requestHash,state,policy,expired?'-1 second':'1 day',state==='completed'&&policy==='return'?202:null,
      state==='completed'&&policy==='return'?'stored-bytes':null,state==='completed'&&policy==='return'?'text/plain':null])).rows[0].request_id;
}
async function call(payload=body,key=current.key,path=current.op==='task.create'?'/return':'/refuse') {
  const r=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:JSON.stringify(payload)});
  return {status:r.status,text:await r.text(),id:r.headers.get('retry-request-id'),replayed:r.headers.get('retry-replayed'),type:r.headers.get('content-type')};
}
function assertConflict(r:any,code:string,id:string) {
  expect(r.status).toBe(409);expect(JSON.parse(r.text).code).toBe(code);expect(r.id).toBe(id);
  expect(r.replayed).toBeNull();expect(calls).toBe(0);
}
// A real second connection COMMIT happens before the actual takeover query.
// No fake query results, polling sleeps, or scheduler timing assumptions.
function race(change:()=>Promise<void>) {
  let once=false;
  intercept=async(sql,_args,execute)=>{
    if (!once && sql.includes('SET request_hash = $4')) {
      once=true;
      await competitor.query('BEGIN');
      try { await change();await competitor.query('COMMIT'); }
      catch(e) { await competitor.query('ROLLBACK');throw e; }
      const result=await execute();expect(result.rowCount).toBe(0);lost++;return result;
    }
    return execute();
  };
}
async function complete(policy='return',different=false) {
  await competitor.query(`UPDATE operation_idempotency_records SET state='completed',request_hash=$2,
    response_status=$3,response_body=$4,response_content_type=$5 WHERE idempotency_key=$1`,
    [current.key,different?hash({act:'other'}):hash(),policy==='return'?202:null,
      policy==='return'?'stored-bytes':null,policy==='return'?'text/plain':null]);
}
beforeAll(async()=>{
  expect((await db.query('SELECT current_database() AS name')).rows[0].name).toBe('relayhall_idempotency_rebranch_test');
  setIdempotencyPool(adapter);
  const app=express();app.use(express.json());
  app.use((req:any,_res:any,next:any)=>{req.principal={id:principal};req.credentialId=principal;next();});
  app.post('/return',idempotent('task.create'),(_req:any,res:any)=>{calls++;res.status(201).json({effect:calls});});
  app.post('/refuse',idempotent('agent.mint.request'),(_req:any,res:any)=>{calls++;res.status(201).json({effect:calls});});
  app.use(apiErrorHandler);
  await new Promise<void>(resolve=>{server=app.listen(0,'127.0.0.1',resolve);});
  origin=`http://127.0.0.1:${(server.address() as any).port}`;
},15000);
beforeEach(()=>{intercept=null;calls=0;writes=0;lost=0;});
afterAll(async()=>{intercept=null;resetIdempotencyPool();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
  await Promise.all([db.end(),competitor.end(),housePool.end()]);});

test('lost takeover reclassifies equal-hash refuse completion',async()=>{
  const id=await seed('refuse');race(()=>complete('refuse'));const r=await call();
  expect(lost).toBe(1);assertConflict(r,'IDEMPOTENCY_REPLAY_UNAVAILABLE',id);expect((await row()).state).toBe('completed');
});
test('lost takeover reclassifies different-hash completed request',async()=>{
  const id=await seed();race(()=>complete('return',true));const r=await call();
  expect(lost).toBe(1);assertConflict(r,'IDEMPOTENCY_KEY_REUSED',id);expect(r.text).not.toContain('stored-bytes');
});
test('lost takeover replays exact equal-hash completed bytes',async()=>{
  const id=await seed();race(()=>complete());const r=await call();expect(lost).toBe(1);
  expect({status:r.status,text:r.text,id:r.id,replayed:r.replayed}).toEqual({status:202,text:'stored-bytes',id,replayed:'true'});
  expect(r.type).toMatch(/^text\/plain/);expect(calls).toBe(0);
});
test('lost takeover observes competing fresh reservation',async()=>{
  const id=await seed();race(async()=>{await competitor.query('UPDATE operation_idempotency_records SET created_at=now() WHERE idempotency_key=$1',[current.key]);});
  const r=await call();expect(lost).toBe(1);assertConflict(r,'IDEMPOTENCY_KEY_IN_FLIGHT',id);expect((await row()).state).toBe('in_flight');
});
test('lost takeover observes expiry and acquires a fresh reserved act once',async()=>{
  const id=await seed();race(async()=>{await competitor.query("UPDATE operation_idempotency_records SET created_at=now(),expires_at=now()-interval '1 second' WHERE idempotency_key=$1",[current.key]);});
  const r=await call();expect(lost).toBe(1);expect(r.status).toBe(201);expect(calls).toBe(1);expect(r.id).not.toBe(id);
  expect(r.replayed).toBeNull();expect((await row()).state).toBe('completed');
});
test('disappearance after lost takeover never enters handler without a reservation',async()=>{
  const id=await seed();race(async()=>{await competitor.query('DELETE FROM operation_idempotency_records WHERE idempotency_key=$1',[current.key]);});
  const r=await call();expect(lost).toBe(1);expect(r.status).toBe(201);expect(calls).toBe(1);expect(r.id).not.toBe(id);
  expect((await row()).request_id).toBe(r.id);expect((await row()).state).toBe('completed');
});
test('refresh between expired observation and DELETE survives',async()=>{
  const id=await seed('return','in_flight',true);let once=false;
  intercept=async(sql,_args,execute)=>{
    if(!once && sql.trim().startsWith('DELETE')){once=true;await competitor.query("UPDATE operation_idempotency_records SET created_at=now(),expires_at=now()+interval '1 day' WHERE idempotency_key=$1",[current.key]);
      const result=await execute();expect(result.rowCount).toBe(0);return result;}
    return execute();};
  const r=await call();assertConflict(r,'IDEMPOTENCY_KEY_IN_FLIGHT',id);expect((await row()).request_id).toBe(id);
});
test('exception before acquisition cannot delete a competitor reservation',async()=>{
  const id=await seed();intercept=async(sql,_args,execute)=>{if(sql.trim().startsWith('SELECT request_hash'))throw new Error('owned-test-read-failure');return execute();};
  const r=await call();expect(r.status).toBe(500);expect(calls).toBe(0);const remaining=await row();
  expect(remaining).toBeDefined();expect(remaining.request_id).toBe(id);expect(remaining.state).toBe('in_flight');
});
test('finite failed takeover budget still classifies final fresh completion',async()=>{
  const id=await seed();let attempts=0;
  intercept=async(sql,_args,execute)=>{
    if(sql.includes('SET request_hash = $4')){
      attempts++;await complete();const result=await execute();expect(result.rowCount).toBe(0);
      if(attempts<3)await competitor.query("UPDATE operation_idempotency_records SET state='in_flight',response_status=NULL,response_body=NULL,response_content_type=NULL,created_at=now()-interval '2 minutes' WHERE idempotency_key=$1",[current.key]);
      return result;
    }return execute();};
  const r=await call();expect(attempts).toBe(3);expect(writes).toBe(4);expect(r.status).toBe(202);expect(r.id).toBe(id);expect(r.replayed).toBe('true');expect(calls).toBe(0);
});
test('finite repeated CAS loss ends without unreserved effects',async()=>{
  const id=await seed();let attempts=0;
  intercept=async(sql,_args,execute)=>{if(sql.includes('SET request_hash = $4')){attempts++;await complete();const result=await execute();expect(result.rowCount).toBe(0);
    await competitor.query("UPDATE operation_idempotency_records SET state='in_flight',response_status=NULL,response_body=NULL,response_content_type=NULL,created_at=now()-interval '2 minutes' WHERE idempotency_key=$1",[current.key]);return result;}return execute();};
  const r=await call();expect(attempts).toBe(3);expect(writes).toBe(4);assertConflict(r,'IDEMPOTENCY_KEY_IN_FLIGHT',id);
});
test.each(['return','refuse'])('initial completed %s and reread have same classification',async(policy)=>{
  const id=await seed(policy,'completed');const r=await call();
  if(policy==='refuse')assertConflict(r,'IDEMPOTENCY_REPLAY_UNAVAILABLE',id);
  else{expect(r.status).toBe(202);expect(r.text).toBe('stored-bytes');expect(r.id).toBe(id);expect(r.replayed).toBe('true');expect(calls).toBe(0);}
});
test('unkeyed route remains unreserved',async()=>{await seed();const r=await call(body,'');expect(r.status).toBe(201);expect(r.id).toBeNull();expect(r.replayed).toBeNull();expect(calls).toBe(1);expect(writes).toBe(0);});
