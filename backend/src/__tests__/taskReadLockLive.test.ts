/**
 * Card e5240c73 (hardening of PR25 slice A, owner ruling D22), measured on a
 * real disposable PostgreSQL through the production router. Disposable targets
 * only; runs from `npm run test:task-creator-access`.
 *
 * 1. GET /tasks/:id takes the Task row lock for its reportMaintenanceAccess
 *    projection, as slice A ratified. The wait for that lock is bounded: a
 *    writer that keeps the Task longer than TASK_READ_LOCK_TIMEOUT_MS refuses
 *    the read with 409 TASK_READ_BUSY (Retry-After: 1) instead of queueing the
 *    dashboard behind it, and MCP relayhall_task_get, which composes that
 *    route, carries the same bound and the same code. A writer that finishes
 *    inside the bound is waited for, and the read answers 200.
 * 2. NativeReviewService.evidence share-locks dependency Tasks NOWAIT. A
 *    dashboard read that holds a dependency's row (the REAL display
 *    transaction, paused right after its `FOR UPDATE OF t`) no longer fails the
 *    evidence: the one refused attempt is rolled back to a savepoint and
 *    retried once. A holder that outlasts the retry is surfaced deliberately as
 *    409 NATIVE_REVIEW_EVIDENCE_BUSY, still without a wait edge.
 * 3. A same-key replay of a Task Report save answers 409
 *    IDEMPOTENCY_REPLAY_UNAVAILABLE with Report wording that names the exact
 *    recovery route, never the Agent-mint "one-time pack" text; one Report
 *    row, no replayed 201, and the named route returns the committed Report.
 */
import http from 'http';
import crypto from 'crypto';
const url=process.env.RELAYHALL_TEST_DB_URL;
if(!url) throw new Error('RELAYHALL_TEST_DB_URL is required');
const parsed=new URL(url),database=decodeURIComponent(parsed.pathname.slice(1));
if(!['postgres:','postgresql:'].includes(parsed.protocol) || !(['localhost','127.0.0.1'].includes(parsed.hostname) || (process.env.CI==='true' && parsed.hostname==='postgres'))
  || !(database==='relayhall_native_review_test' || (process.env.CI==='true' && database==='relayhall_ci'))) throw new Error('Disposable native execution database only');
Object.assign(process.env,{DB_HOST:parsed.hostname,DB_PORT:parsed.port,DB_NAME:database,DB_USER:decodeURIComponent(parsed.username),DB_PASSWORD:decodeURIComponent(parsed.password),NODE_ENV:'test',RELAYHALL_SESSIONS:'on',JWT_SECRET:crypto.randomBytes(32).toString('hex'),RELAYHALL_TELEMETRY_PEPPERS:JSON.stringify({test:crypto.randomBytes(32).toString('base64')}),RELAYHALL_TELEMETRY_ACTIVE_PEPPER:'test'});
const express=require('express');
const {pool}=require('../db/connection');
const {registerProtectedRoutes}=require('../routeRegistry');
const {authMiddleware}=require('../middleware/auth');
const {sharedAuthorizationMiddleware}=require('../middleware/sharedAuthorization');
const {apiErrorHandler}=require('../utils/apiErrors');
const {loginSessionService,SESSION_COOKIE_NAME}=require('../services/LoginSessionService');
const {principalService}=require('../services/PrincipalService');
const {TaskElementService,TASK_READ_LOCK_TIMEOUT_MS}=require('../services/TaskElementService');
const {NativeReviewService,NATIVE_REVIEW_DEPENDENCY_RETRY_MS}=require('../services/NativeReviewService');
const registry=require('../mcp/registry');
jest.setTimeout(120000);
let server:http.Server,origin:string;
type Caller={id:string;headers:Record<string,string>};
const tag=()=>`task-read-lock-${crypto.randomBytes(6).toString('hex')}`;
async function call(who:Caller,method:string,path:string,body?:unknown,headers:Record<string,string>={}) {
  const response=await fetch(origin+path,{method,headers:{'Content-Type':'application/json',...who.headers,...headers},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,headers:response.headers,body:await response.json() as any};
}
async function human():Promise<Caller> {
  const row=(await pool.query("INSERT INTO principals(kind,handle,display_name,status,role) VALUES('human',$1,$1,'active','user') RETURNING id",[tag()])).rows[0];
  const session=await loginSessionService.mint({principalId:row.id});
  return {id:row.id,headers:{Cookie:`${SESSION_COOKIE_NAME}=${session.token}`}};
}
/** The owner's Connector: an MCP credential acting within the owner's authority. */
async function connector(owner:Caller):Promise<string> {
  const row=(await pool.query("INSERT INTO principals(kind,handle,status,parent_principal_id,purpose,own_expression) VALUES('service',$1,'active',$2,'Disposable task read lock proof',$3) RETURNING id",
    [tag(),owner.id,JSON.stringify({scopes:'parent',objects:'parent'})])).rows[0];
  const issued=await principalService.issueCredential({principalId:row.id,scopes:['tasks:read','tasks:write'],transport:'any'},{handle:'disposable-task-read-lock',authMethod:'system'});
  return `Bearer ${issued.fullKey}`;
}
/** The dashboard path to a claimed, In progress Task whose claimant may maintain its Report. */
async function claimedTask(owner:Caller):Promise<string> {
  const created=await call(owner,'POST','/tasks',{title:tag(),status:'todo'});
  expect(created.status).toBe(201);
  const taskId=created.body.task.id;
  expect((await call(owner,'PATCH',`/tasks/${taskId}`,{autoStart:true})).status).toBe(200);
  expect((await call(owner,'POST',`/tasks/${taskId}/claim`,{})).status).toBe(200);
  expect((await call(owner,'PATCH',`/tasks/${taskId}`,{status:'in-progress'})).status).toBe(200);
  return taskId;
}
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
/** A real PostgreSQL lock wait on `blocker`, observed from outside both sessions. */
async function waitBlockedBy(blocker:number):Promise<number> {
  const until=Date.now()+5000;
  while(Date.now()<until){
    const waiting=(await pool.query("SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'",[blocker])).rows;
    if(waiting.length)return waiting[0].pid;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error('Expected a real PostgreSQL lock wait behind the holder');
}
/** A writer-shaped holder: a second connection holding the Task row FOR UPDATE. */
async function holdTask(taskId:string) {
  const holder=await pool.connect();
  await holder.query('BEGIN');
  await holder.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[taskId]);
  const pid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
  let ended=false;
  const end=async()=>{if(ended)return;ended=true;try{await holder.query('ROLLBACK');}finally{holder.release();}};
  return {pid,end};
}

beforeAll(async()=>{
  // Schema-only disposable clones need the migration 062/084 fallback identity.
  await pool.query("INSERT INTO principals(kind,handle,display_name,role) VALUES('human','dashboard_user','Owner','orchestrator') ON CONFLICT(handle) DO NOTHING");
  const app=express();app.use(express.json());
  registerProtectedRoutes((mount:string,...handlers:any[])=>app.use(mount,authMiddleware,sharedAuthorizationMiddleware,...handlers));app.use(apiErrorHandler);
  await new Promise<void>(resolve=>{server=app.listen(0,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();});

describe('GET /tasks/:id waits a bounded time for the Task row lock',()=>{
  test('a holder that outlasts the bound refuses the REST read and the MCP read with 409 TASK_READ_BUSY; the holder is untouched',async()=>{
    const owner=await human(),task=await claimedTask(owner),bearer=await connector(owner);
    const before=await call(owner,'GET',`/tasks/${task}`);
    expect([before.status,before.body.task.reportMaintenanceAccess]).toEqual([200,{allowed:true,reason:null}]);
    const holder=await holdTask(task);
    try {
      let started=Date.now();
      const pending=call(owner,'GET',`/tasks/${task}`);
      // The read really queues on the row lock: it is not refused before waiting.
      await waitBlockedBy(holder.pid);
      const refused=await pending;let elapsed=Date.now()-started;
      expect([refused.status,refused.body.success,refused.body.code]).toEqual([409,false,'TASK_READ_BUSY']);
      expect(refused.body.message).toContain(`more than ${TASK_READ_LOCK_TIMEOUT_MS} ms`);
      expect(refused.body.details).toEqual({lockTimeoutMs:TASK_READ_LOCK_TIMEOUT_MS});
      expect(refused.headers.get('retry-after')).toBe('1');
      expect(elapsed).toBeGreaterThanOrEqual(TASK_READ_LOCK_TIMEOUT_MS-100);
      expect(elapsed).toBeLessThan(TASK_READ_LOCK_TIMEOUT_MS+1500);

      // MCP relayhall_task_get composes the same route: same bound, same typed refusal.
      started=Date.now();
      const tool=registry.toolByName('relayhall_task_get');
      await expect(tool.handler({task},{authorization:bearer,toolName:'relayhall_task_get'}))
        .rejects.toThrow(/relayhall_task_get failed \(HTTP 409\) \[TASK_READ_BUSY\]/);
      elapsed=Date.now()-started;
      expect(elapsed).toBeGreaterThanOrEqual(TASK_READ_LOCK_TIMEOUT_MS-100);
      expect(elapsed).toBeLessThan(TASK_READ_LOCK_TIMEOUT_MS+1500);

      // Neither refusal disturbed the holder: it still owns the row.
      expect((await pool.query("SELECT state FROM pg_stat_activity WHERE pid=$1",[holder.pid])).rows[0].state).toBe('idle in transaction');
    } finally { await holder.end(); }
    // Once the holder is gone the same reads answer, with the same projection.
    const after=await call(owner,'GET',`/tasks/${task}`);
    expect([after.status,after.body.task.reportMaintenanceAccess]).toEqual([200,{allowed:true,reason:null}]);
    const tool=registry.toolByName('relayhall_task_get');
    expect(JSON.parse(await tool.handler({task,response_format:'detailed'},{authorization:bearer,toolName:'relayhall_task_get'})).task.id).toBe(task);
  });

  test('a holder that commits inside the bound is still waited for (the lock is unchanged), and the read answers 200',async()=>{
    const owner=await human(),task=await claimedTask(owner);
    const holder=await holdTask(task);
    const started=Date.now();
    let read:any;
    try {
      const pending=call(owner,'GET',`/tasks/${task}`);
      await waitBlockedBy(holder.pid);
      await new Promise(resolve=>setTimeout(resolve,300));
      await holder.end();
      read=await pending;
    } finally { await holder.end(); }
    const elapsed=Date.now()-started;
    expect([read.status,read.body.task.reportMaintenanceAccess]).toEqual([200,{allowed:true,reason:null}]);
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(TASK_READ_LOCK_TIMEOUT_MS);
  });
});

describe('NativeReviewService.evidence and a dashboard read of a dependency Task',()=>{
  async function reviewFixture() {
    const principal=(await pool.query("INSERT INTO principals(kind,handle,display_name,status,role) VALUES('human',$1,$1,'active','admin') RETURNING id",[tag()])).rows[0].id;
    const dependency=(await pool.query("INSERT INTO tasks(title,status,owner_principal_id,creator_principal_id,shepherd_principal_id) VALUES($1,'completed',$2,$2,$2) RETURNING id",[tag(),principal])).rows[0].id;
    const task=(await pool.query("INSERT INTO tasks(title,status,owner_principal_id,creator_principal_id,shepherd_principal_id,definition_of_done) VALUES($1,'review',$2,$2,$2,$3) RETURNING id",[tag(),principal,JSON.stringify(['The review reads its evidence'])])).rows[0].id;
    await pool.query('INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES($1,$2)',[task,dependency]);
    await pool.query("INSERT INTO reports(title,content,summary,task_ids,author_principal_id,author_actor_id,origin) VALUES('Lock fixture evidence','owned body','fixture',$1,$2::uuid,$2::uuid::text,'api')",[[task],principal]);
    const actor={principalId:principal,handle:'task-read-lock',authorization:{principalId:principal,handle:'task-read-lock',role:'admin',scopes:['root'],authenticated:true,delegation:null}};
    return {dependency,task,actor};
  }
  /** Hold the REAL display transaction GET /tasks/:id runs (reportMaintenanceAccess)
   * right after its `FOR UPDATE OF t` Task read, on its own pooled connection. */
  async function heldDisplayRead(taskId:string,actor:unknown) {
    const reached=gate(),resume=gate();let pid=0;
    const heldPool={connect:async()=>{const c=await pool.connect();return {
      query:async(sql:string,args?:any[])=>{const result=await c.query(sql,args);
        if(/FOR UPDATE OF t/.test(sql)&&args?.[0]===taskId&&!pid){pid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;reached.release();await resume.promise;}
        return result;},
      release:()=>c.release()};}};
    const decision=new TaskElementService(heldPool).taskReportMaintenanceAccess(taskId,actor);
    await reached.promise;
    return {decision,resume,pid:()=>pid};
  }
  /** The review's own transaction, with every refused lock attempt recorded. */
  async function reviewTransaction(taskId:string) {
    const c=await pool.connect();
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='15s'");
    const row=(await c.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[taskId])).rows[0];
    return {c,row};
  }

  test('a held dashboard read refuses the first dependency share lock; the one retry succeeds and the evidence is read',async()=>{
    const f=await reviewFixture();
    const held=await heldDisplayRead(f.dependency,f.actor);
    const {c,row}=await reviewTransaction(f.task);
    const refused:string[]=[];let display:any;
    const watched={query:async(sql:string,args?:any[])=>{
      let result;
      try { result=await c.query(sql,args); } catch(error:any) { if(error?.code==='55P03')refused.push(sql); throw error; }
      // The dashboard read ends between the refused attempt and the retry.
      if(sql.startsWith('ROLLBACK TO SAVEPOINT')){held.resume.release();display=await held.decision;}
      return result;
    }};
    try {
      const started=Date.now();
      const input=await new NativeReviewService(pool)['evidence'](watched,row);
      const elapsed=Date.now()-started;
      // The first attempt met the display read's row lock for real...
      expect(refused).toHaveLength(1);
      expect(refused[0]).toContain('FOR SHARE OF d,t NOWAIT');
      expect(display).toEqual({allowed:false,reason:'TASK_REPORT_FROZEN'});
      // ...and the review still read its evidence, after one short pause.
      expect(input.inputDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(input.reports.map((report:any)=>report.title)).toEqual(['Lock fixture evidence']);
      expect(elapsed).toBeGreaterThanOrEqual(NATIVE_REVIEW_DEPENDENCY_RETRY_MS);
      expect(elapsed).toBeLessThan(NATIVE_REVIEW_DEPENDENCY_RETRY_MS+1500);
      // The dependency share lock is now held by the review: the dependency is fenced.
      await expect(pool.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE NOWAIT',[f.dependency])).rejects.toMatchObject({code:'55P03'});
    } finally { await c.query('ROLLBACK');c.release();held.resume.release();await held.decision; }
  });

  test('a holder that outlasts the retry is surfaced as 409 NATIVE_REVIEW_EVIDENCE_BUSY without a wait edge, and the review transaction stays usable',async()=>{
    const f=await reviewFixture();
    const holder=await holdTask(f.dependency);
    const {c,row}=await reviewTransaction(f.task);
    const refused:string[]=[];
    const watched={query:async(sql:string,args?:any[])=>{
      try { return await c.query(sql,args); } catch(error:any) { if(error?.code==='55P03')refused.push(sql); throw error; }
    }};
    try {
      const started=Date.now();
      await expect(new NativeReviewService(pool)['evidence'](watched,row)).rejects.toMatchObject({status:409,code:'NATIVE_REVIEW_EVIDENCE_BUSY'});
      const elapsed=Date.now()-started;
      // Exactly one retry, each attempt refused at once: no lock wait behind the holder.
      expect(refused).toHaveLength(2);
      expect(elapsed).toBeGreaterThanOrEqual(NATIVE_REVIEW_DEPENDENCY_RETRY_MS);
      expect(elapsed).toBeLessThan(NATIVE_REVIEW_DEPENDENCY_RETRY_MS+1500);
      expect((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))",[holder.pid])).rows[0].n).toBe(0);
      // Only the savepoint was rolled back; the review's own transaction is intact.
      expect((await c.query('SELECT id FROM tasks WHERE id=$1',[f.task])).rows).toHaveLength(1);
    } finally { await c.query('ROLLBACK');c.release();await holder.end(); }
  });
});

describe('a same-key replay of a Task Report save',()=>{
  test('answers 409 with Report wording naming the exact recovery route; one row, no replayed 201, and that route returns the committed Report',async()=>{
    const owner=await human(),task=await claimedTask(owner);
    const key=`task-read-lock-replay-${crypto.randomUUID()}`,body={title:'Progress',content:'committed once'};
    const first=await call(owner,'POST',`/tasks/${task}/reports`,body,{'Idempotency-Key':key});
    expect(first.status).toBe(201);
    const requestHash=first.body.operation.requestHash;
    const again=await call(owner,'POST',`/tasks/${task}/reports`,body,{'Idempotency-Key':key});
    expect([again.status,again.body.success,again.body.code]).toEqual([409,false,'IDEMPOTENCY_REPLAY_UNAVAILABLE']);
    expect(again.headers.get('retry-replayed')).toBeNull();
    const recovery=`/tasks/${task}/report-operations/${key}?requestHash=${requestHash}`;
    expect(again.body.message).toContain('Task Report save has already been committed under that key');
    expect(again.body.message).toContain(`GET ${recovery}`);
    expect(again.body.message).toContain('relayhall_task_report_reconcile');
    expect(`${again.body.message} ${again.body.suggestion}`).not.toMatch(/mint|one-time pack|agent_reveal|credential/i);
    expect(again.body.details).toEqual({recovery:{method:'GET',path:recovery,requestHash,mcpTool:'relayhall_task_report_reconcile'}});
    // Behaviour unchanged: one Report, one operation mapping, nothing replayed.
    expect((await pool.query('SELECT count(*)::int AS n FROM reports WHERE source_task_id=$1',[task])).rows[0].n).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM task_report_operations WHERE task_id=$1',[task])).rows[0].n).toBe(1);
    // The route the refusal names is the one that recovers the committed result.
    const read=await call(owner,'GET',again.body.details.recovery.path);
    expect([read.status,read.body.report.id,read.body.report.content]).toEqual([200,first.body.report.id,'committed once']);
  });
});
