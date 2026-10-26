export {};
/**
 * Completion-reference fencing rules, measured on the owned PostgreSQL fixture
 * (card afd0e72b, PR25 slice B). Runs only through the guarded entry
 * `npm run test:completion-reference-lifecycle` (or the direct Jest config),
 * which asserts the explicit owned endpoint before this file loads (the
 * legacy file notifier it once stubbed is gone, card 5854f0d6). Default
 * mocked Jest excludes this file.
 *
 * One test per fencing rule the slice-B diff states and the carried PR25
 * suites do not already pin on their own:
 *  1. Task FOR UPDATE NOWAIT precedes discovery, measured against the lock the
 *     landed slice A takes for display (GET /tasks/:id reportMaintenanceAccess):
 *     a warrant revoked or expired mid-claim refuses whole, then reaps on retry,
 *     and the dead warrant can never carry the claim again.
 *  2. releaseWarrant re-decides each carried Task after its Task lock.
 *  3. The terminal verdict is the only verdict the fence can refuse: review
 *     attempt counting (counted rework, escalation) is unaffected by reference
 *     contention, and a refused terminal verdict consumes no retry budget.
 *  4. The scheduled sweep isolates a busy warrant per warrant: one tick, one
 *     retryable record, no effect on the busy warrant, the next tick consumes it.
 *  5. An ordinary terminal completion WAITS behind the slice-A display lock (it
 *     already holds its Task) instead of refusing, while a bare reference writer
 *     under the same lock refuses (the control that the lock is real).
 */
const {pool}=require('../db/connection');
const {accessVehicleService:v}=require('../services/AccessVehicleService');
const {taskManagerDB}=require('../services/TaskManagerDB');
const {TaskElementService}=require('../services/TaskElementService');
const {TaskReviewAttemptService,hashReviewReports}=require('../services/TaskReviewAttemptService');
const {warrantService}=require('../services/WarrantService');
const {runWarrantLifecycleSweep}=require('../utils/warrantLifecycleSchedule');
const crypto=require('crypto');

const tag=():string=>crypto.randomUUID();
const audit={handle:'system',authMethod:'system'};
// The internal Verifier identity TaskManagerDB.updateTask accepts for a terminal write.
const reviewer={handle:'system',authMethod:'system',role:'reviewer',principalId:null};
const BUSY={status:409,code:'ASSIGNMENT_REFERENCE_BUSY'};
let principal:string;let actor:any;

function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
async function task(status='in-progress'):Promise<string>{
 return (await pool.query('INSERT INTO tasks(title,status,owner_principal_id,creator_principal_id,shepherd_principal_id) VALUES($1,$2,$3,$3,$3) RETURNING id',['fencing-'+tag(),status,principal])).rows[0].id;
}
async function client(){const c=await pool.connect();await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='4s'");return c;}
async function profile(){
 const p=(await pool.query('INSERT INTO access_profiles(name) VALUES($1) RETURNING id',[tag()])).rows[0].id;
 const version=(await pool.query('INSERT INTO access_profile_versions(profile_id,version_number) VALUES($1,1) RETURNING id',[p])).rows[0].id;
 const w=(await pool.query('INSERT INTO warrants(name,holder_principal_id,ceiling_profile_version_id,created_by_principal_id) VALUES($1,$2,$3,$2) RETURNING id',[tag(),principal,version])).rows[0].id;
 return {p,w};
}
async function connector():Promise<string>{
 const id=tag();
 await pool.query("INSERT INTO services(id,slug,name,kind,status,principal_id,current_descriptor_version) VALUES($1,$2,$2,'connector','published',$3,1)",[id,'fencing-'+tag(),principal]);
 await pool.query('INSERT INTO service_descriptor_versions(service_id,version,descriptor,content_hash) VALUES($1,1,$2,$3)',[id,{options:[]},'a'.repeat(64)]);
 return id;
}
const executionProfile=(service:string)=>({serviceId:service,descriptorVersion:1,options:{}});
/** A warrant-carried assignment exactly as attach leaves it: link + execution pointer. */
async function carried(taskId:string,p:{p:string;w:string},service:string):Promise<string>{
 const c=await client();
 try{
  const target=await v.ensureProfileAssignment(c,{taskId,assigneePrincipalId:principal,granteeId:principal,profileId:p.p,warrantId:p.w,actor:audit});
  await c.query('UPDATE tasks SET execution_service_id=$2,execution_profile=$3,execution_descriptor_version=1,execution_warrant_id=$4 WHERE id=$1',[taskId,service,executionProfile(service),p.w]);
  await c.query('COMMIT');return target.targetId;
 }finally{await c.query('ROLLBACK');c.release();}
}
function grantFixture(){return {resource:tag()};}
function materializeGrant(c:any,taskId:string,f:{resource:string}){
 return v.ensureGrant(c,{taskId,assigneePrincipalId:principal,granteeId:principal,resourceType:'task',resourceId:f.resource,verb:'read',vehicleKind:'auto-grant',warrantId:null,actor:audit});
}
async function seedGrant(taskId:string,f:{resource:string}):Promise<string>{
 const c=await client();try{const target=await materializeGrant(c,taskId,f);await c.query('COMMIT');return target.targetId;}finally{await c.query('ROLLBACK');c.release();}
}
async function targetExists(kind:'grant'|'profile_assignment',id:string):Promise<number>{
 return (await pool.query(`SELECT id FROM ${kind==='grant'?'grants':'access_profile_assignments'} WHERE id=$1`,[id])).rowCount;
}
async function links(taskId:string){return (await pool.query('SELECT target_kind,target_id,warrant_id FROM access_vehicle_links WHERE task_id=$1 ORDER BY id',[taskId])).rows;}
async function unassignAudits(taskId:string):Promise<number>{
 return (await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='task.execution_unassign' AND resource_id=$1",[taskId])).rows[0].n;
}
async function snapshot(taskId:string){
 const result:any={};
 for(const [name,sql] of Object.entries({task:'SELECT * FROM tasks WHERE id=$1',history:'SELECT * FROM task_history WHERE task_id=$1 ORDER BY id',audit:'SELECT * FROM audit_events WHERE resource_id=$1::text ORDER BY id',feed:'SELECT * FROM feed_events WHERE object_id=$1 ORDER BY cursor',links:'SELECT * FROM access_vehicle_links WHERE task_id=$1 ORDER BY id'})) result[name]=(await pool.query(sql,[taskId])).rows;
 return result;
}
async function warrantState(warrantId:string){
 return {row:(await pool.query('SELECT * FROM warrants WHERE id=$1',[warrantId])).rows,events:(await pool.query('SELECT * FROM warrant_events WHERE warrant_id=$1 ORDER BY id',[warrantId])).rows,audit:(await pool.query('SELECT * FROM audit_events WHERE resource_id=$1::text ORDER BY id',[warrantId])).rows};
}
async function consistent(){
 expect((await pool.query(`SELECT l.id FROM access_vehicle_links l LEFT JOIN grants g ON l.target_kind='grant' AND g.id=l.target_id LEFT JOIN access_profile_assignments p ON l.target_kind='profile_assignment' AND p.id=l.target_id WHERE (l.target_kind='grant' AND g.id IS NULL) OR (l.target_kind='profile_assignment' AND p.id IS NULL)`)).rows).toHaveLength(0);
}
// Every row belongs to this uniquely owned fixture database: retire earlier
// synthetic warrants so a global sweep sees only this test's warrants.
async function retireWarrants(){await pool.query("UPDATE warrants SET status='revoked',revoked_at=NOW(),suspended_at=NULL,suspended_reason=NULL WHERE status IN ('active','suspended')");}

/** Hold the REAL slice-A display transaction (GET /tasks/:id reportMaintenanceAccess)
 * right after its `FOR UPDATE OF t` Task read, on its own pooled connection. */
async function heldDisplayLock(taskId:string){
 const reached=gate(),resume=gate();let pid=0;let lockedSql='';
 const heldPool={connect:async()=>{const c=await pool.connect();return {
  query:async(sql:string,args?:any[])=>{const result=await c.query(sql,args);
   if(/FOR UPDATE OF t/.test(sql)&&args?.[0]===taskId&&!lockedSql){lockedSql=sql;pid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;reached.release();await resume.promise;}
   return result;},
  release:()=>c.release()};}};
 const decision=new TaskElementService(heldPool).taskReportMaintenanceAccess(taskId,{principalId:principal,handle:'fencing-claimant',authorization:actor.authorization});
 await reached.promise;
 return {decision,resume,pid:()=>pid,sql:()=>lockedSql};
}
async function waitBlockedBy(blocker:number){
 const until=Date.now()+5000;
 while(Date.now()<until){
  const waiting=(await pool.query("SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'",[blocker])).rows;
  if(waiting.length)return waiting[0].pid;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 throw new Error('Expected a real PostgreSQL wait on the display backend');
}

beforeAll(async()=>{
 principal=(await pool.query("INSERT INTO principals(kind,handle,display_name,status,role) VALUES('human',$1,$1,'active','admin') RETURNING id",['fencing-'+tag()])).rows[0].id;
 actor={principalId:principal,handle:'system',authMethod:'system',role:'admin',authorization:{principalId:principal,handle:'system',role:'admin',scopes:['root'],authenticated:true,delegation:null}};
});
afterAll(async()=>{await pool.end();});
jest.setTimeout(30000);

test.each(['revoke','sweep-expire'])('Rule 1: a warrant %s mid-claim refuses whole behind the slice-A display lock, reaps on retry, and the dead warrant cannot carry the claim again',async operation=>{
 await retireWarrants();
 const p=await profile(),service=await connector(),a=await task('in-progress'),target=await carried(a,p,service);
 if(operation==='sweep-expire')await pool.query("UPDATE warrants SET expires_at=NOW()-INTERVAL '1 hour' WHERE id=$1",[p.w]);
 const results:any[]=[],retries:any[]=[],failures:any[]=[];
 const invoke=()=>operation==='revoke'
  ?warrantService.revoke(p.w,'mid-claim revoke',audit,async(rows:any[])=>rows,{acknowledgeDependents:true})
  :runWarrantLifecycleSweep({sweep:async()=>{const r=await warrantService.sweepLifecycles();results.push(r);return r;},onRetryable:(r:any)=>retries.push(r),onFailure:(e:any)=>failures.push(e)});
 const before=await snapshot(a),beforeW=await warrantState(p.w);
 const held=await heldDisplayLock(a);
 try{
  expect(held.sql()).toMatch(/FOR UPDATE OF t/);
  const started=Date.now();
  if(operation==='revoke')await expect(invoke()).rejects.toMatchObject(BUSY);
  else{
   await invoke();
   expect(results).toEqual([{expired:0,suspended:0,retryable:[{warrantId:p.w,...BUSY}]}]);
   expect(retries).toEqual([{warrantId:p.w,...BUSY}]);
  }
  // Refused at once: the warrant owner adds no wait edge behind the display lock.
  expect(Date.now()-started).toBeLessThan(2000);
  // Refused WHOLE: the warrant row, its events and audit, the Task, its link and pointer.
  expect(await snapshot(a)).toEqual(before);
  expect(await warrantState(p.w)).toEqual(beforeW);
 }finally{held.resume.release();await held.decision;}
 expect(typeof (await held.decision).allowed).toBe('boolean');
 await invoke();
 const after=await snapshot(a),afterW=await warrantState(p.w);
 expect(afterW.row[0].status).toBe(operation==='revoke'?'revoked':'expired');
 expect(after.links).toHaveLength(0);
 expect(after.task[0]).toMatchObject({execution_service_id:null,execution_profile:null,execution_warrant_id:null});
 expect(await targetExists('profile_assignment',target)).toBe(0);
 expect(await unassignAudits(a)).toBe(1);
 if(operation!=='revoke')expect(results[1]).toEqual({expired:1,suspended:0});
 expect(failures).toEqual([]);
 // The dead warrant can never carry the claim again: the ordinary assignment write refuses.
 await expect(taskManagerDB.updateTask(a,{executionProfile:executionProfile(service),executionServiceId:service,executionDescriptorVersion:1,executionWarrantId:p.w},actor)).rejects.toMatchObject({status:409,code:'WARRANT_NOT_LIVE'});
 expect(await links(a)).toHaveLength(0);
 expect((await pool.query('SELECT execution_warrant_id FROM tasks WHERE id=$1',[a])).rows[0].execution_warrant_id).toBeNull();
 await consistent();
});

test('Rule 2: releaseWarrant re-decides a carried Task after its Task lock; a Task completed between discovery and the lock keeps its executor record and gets no automatic unassign',async()=>{
 const p=await profile(),service=await connector(),a=await task('review');await carried(a,p,service);
 const r=await client(),discovered=gate(),resume=gate();let seen:any[]=[];
 const rp={query:async(sql:string,args?:any[])=>{const result=await r.query(sql,args);if(sql.includes('SELECT DISTINCT l.task_id')){seen=result.rows;discovered.release();await resume.promise;}return result;}};
 const handled=v.releaseWarrant(rp,p.w,audit,'recheck after discovery').catch((e:any)=>e);
 try{
  await discovered.promise;
  // The discovery snapshot is stale by construction: carried, assigned, NOT terminal.
  expect(seen.map((row:any)=>({task:row.task_id,status:row.status,service:row.execution_service_id}))).toEqual([{task:a,status:'review',service}]);
  expect((await taskManagerDB.updateTask(a,{status:'completed'},reviewer)).status).toBe('completed');
  resume.release();
  expect(await handled).toEqual({unassignedTaskIds:[]});
  await r.query('COMMIT');
 }finally{resume.release();await handled;await r.query('ROLLBACK');r.release();}
 const row=(await pool.query('SELECT status,execution_service_id,execution_profile,execution_descriptor_version,execution_warrant_id FROM tasks WHERE id=$1',[a])).rows[0];
 // A completed Task keeps who executed it; only the dead warrant pointer is cleared.
 expect(row).toMatchObject({status:'completed',execution_service_id:service,execution_descriptor_version:1,execution_warrant_id:null});
 expect(row.execution_profile).toEqual(executionProfile(service));
 expect(await unassignAudits(a)).toBe(0);
 expect(await links(a)).toHaveLength(0);
 await consistent();
});

test('Rule 3: review attempt counting is unaffected by reference contention; only the terminal verdict is fenced and a refused one consumes no retry budget',async()=>{
 const f=grantFixture(),a=await task('review'),b=await task('review');
 await pool.query('UPDATE tasks SET max_retries=2 WHERE id=$1',[a]);
 const target=await seedGrant(a,f);
 const ledger=new TaskReviewAttemptService(pool);
 const begin=async()=>ledger.beginAttempt(await taskManagerDB.getTask(a),{reportDigest:hashReviewReports([])});
 const state=async()=>({
  task:(await pool.query('SELECT status,attempt_count,needs_review FROM tasks WHERE id=$1',[a])).rows[0],
  attempts:(await pool.query('SELECT attempt_no,status FROM task_review_attempts WHERE task_id=$1 ORDER BY attempt_no',[a])).rows,
  links:(await pool.query('SELECT target_id FROM access_vehicle_links WHERE task_id=$1',[a])).rows,
 });
 const resubmit=()=>pool.query("UPDATE tasks SET status='review' WHERE id=$1",[a]); // synthetic re-submission only
 const c=await client();
 try{
  await materializeGrant(c,b,f); // a second, uncommitted reference to the same target
  const first=await begin();expect(first.attemptNo).toBe(1);
  await expect(ledger.recordVerdict(first.id,'pass',[],{summary:'terminal under contention'})).rejects.toMatchObject(BUSY);
  expect(await state()).toMatchObject({task:{status:'review',attempt_count:0},attempts:[{attempt_no:1,status:'running'}],links:[{target_id:target}]});
  // Counted rework proceeds under the SAME contention, once, and keeps access.
  expect(await ledger.recordVerdict(first.id,'reject',[],{summary:'counted rework'},undefined,true)).toEqual({status:'todo',attemptCount:1,applied:true});
  expect(await ledger.recordVerdict(first.id,'reject',[],{summary:'replayed rework'},undefined,true)).toMatchObject({attemptCount:1,applied:false});
  expect(await state()).toMatchObject({task:{status:'todo',attempt_count:1},attempts:[{attempt_no:1,status:'rejected'}],links:[{target_id:target}]});
  await resubmit();
  const second=await begin();expect(second.attemptNo).toBe(2);
  await expect(ledger.recordVerdict(second.id,'pass',[],{summary:'terminal again under contention'})).rejects.toMatchObject(BUSY);
  expect((await state()).task).toMatchObject({status:'review',attempt_count:1});
  // The budget is exhausted by counted attempts only: escalation, access retained.
  expect(await ledger.recordVerdict(second.id,'reject',[],{summary:'budget exhausted'},undefined,true)).toEqual({status:'stuck',attemptCount:2,applied:true});
  expect(await state()).toMatchObject({task:{status:'stuck',attempt_count:2,needs_review:true},attempts:[{attempt_no:1,status:'rejected'},{attempt_no:2,status:'escalated'}],links:[{target_id:target}]});
  await c.query('ROLLBACK');
  await resubmit();
  const third=await begin();expect(third.attemptNo).toBe(3);
  expect(await ledger.recordVerdict(third.id,'pass',[],{summary:'terminal without contention'})).toEqual({status:'completed',attemptCount:2,applied:true});
  expect(await state()).toMatchObject({task:{status:'completed',attempt_count:2},attempts:[{attempt_no:1,status:'rejected'},{attempt_no:2,status:'escalated'},{attempt_no:3,status:'passed'}],links:[]});
  expect(await targetExists('grant',target)).toBe(0);
  expect((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='grant.revoke' AND resource_id=$1",[target])).rows[0].n).toBe(1);
  await consistent();
 }finally{await c.query('ROLLBACK');c.release();}
});

test('Rule 4: one scheduled tick isolates a busy warrant; the free warrant expires and reaps in that tick, the busy one is reported once and left whole, the next tick consumes it, a third finds nothing',async()=>{
 await retireWarrants();
 const service=await connector(),p1=await profile(),p2=await profile(),a1=await task(),a2=await task();
 const t1=await carried(a1,p1,service),t2=await carried(a2,p2,service);
 await pool.query("UPDATE warrants SET expires_at=NOW()-INTERVAL '1 hour' WHERE id=ANY($1::uuid[])",[[p1.w,p2.w]]);
 const results:any[]=[],retries:any[]=[],failures:any[]=[];
 const tick=()=>runWarrantLifecycleSweep({sweep:async()=>{const r=await warrantService.sweepLifecycles();results.push(r);return r;},onRetryable:(r:any)=>retries.push(r),onFailure:(e:any)=>failures.push(e)});
 const c=await client();
 try{
  // An ordinary uncommitted Task write on a1 is the only contention.
  await c.query('UPDATE tasks SET notes=$2 WHERE id=$1',[a1,'ordinary progress']);
  const w1Before=await warrantState(p1.w),a1Before=await snapshot(a1);
  await tick();
  expect(results[0]).toEqual({expired:1,suspended:0,retryable:[{warrantId:p1.w,...BUSY}]});
  expect(retries).toEqual([{warrantId:p1.w,...BUSY}]);
  expect(await warrantState(p1.w)).toEqual(w1Before);
  expect(await snapshot(a1)).toEqual(a1Before);
  expect((await warrantState(p2.w)).row[0].status).toBe('expired');
  expect(await links(a2)).toHaveLength(0);
  expect((await pool.query('SELECT execution_service_id,execution_warrant_id FROM tasks WHERE id=$1',[a2])).rows[0]).toEqual({execution_service_id:null,execution_warrant_id:null});
  expect(await targetExists('profile_assignment',t2)).toBe(0);
  await c.query('COMMIT'); // the ordinary write wins and is kept
  await tick();
  expect(results[1]).toEqual({expired:1,suspended:0});
  expect(retries).toHaveLength(1);
  expect((await warrantState(p1.w)).row[0].status).toBe('expired');
  expect(await links(a1)).toHaveLength(0);
  expect((await pool.query('SELECT notes,execution_service_id,execution_warrant_id FROM tasks WHERE id=$1',[a1])).rows[0]).toEqual({notes:'ordinary progress',execution_service_id:null,execution_warrant_id:null});
  expect(await targetExists('profile_assignment',t1)).toBe(0);
  const settled={w1:await warrantState(p1.w),w2:await warrantState(p2.w),a1:await snapshot(a1),a2:await snapshot(a2)};
  await tick();
  expect(results[2]).toEqual({expired:0,suspended:0});
  expect({w1:await warrantState(p1.w),w2:await warrantState(p2.w),a1:await snapshot(a1),a2:await snapshot(a2)}).toEqual(settled);
  for(const w of [p1.w,p2.w])expect((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='warrant.expire' AND resource_id=$1",[w])).rows[0].n).toBe(1);
  for(const t of [a1,a2])expect(await unassignAudits(t)).toBe(1);
  expect(failures).toEqual([]);
  await consistent();
 }finally{await c.query('ROLLBACK');c.release();}
});

test('Rule 5: an ordinary terminal completion waits behind the slice-A display lock and then reaps; a bare reference writer under the same lock refuses (control)',async()=>{
 const f=grantFixture(),a=await task('review'),target=await seedGrant(a,f);
 const held=await heldDisplayLock(a);let completion:any;
 try{
  const d=await client(),started=Date.now();
  try{await expect(v.detach(d,a,audit,'bare reference writer')).rejects.toMatchObject(BUSY);}finally{await d.query('ROLLBACK');d.release();}
  // NOWAIT: refused without a wait edge, well inside this client's 4 s lock_timeout
  // (a waiting lock would also surface as 55P03 -> BUSY, but only after 4 s).
  expect(Date.now()-started).toBeLessThan(2000);
  expect(await links(a)).toHaveLength(1);
  completion=taskManagerDB.updateTask(a,{status:'completed'},reviewer);
  const settled=completion.then(()=>'settled',()=>'settled');
  await waitBlockedBy(held.pid());
  expect(await Promise.race([settled,new Promise(resolve=>setTimeout(()=>resolve('waiting'),50))])).toBe('waiting');
 }finally{held.resume.release();await held.decision;}
 expect((await completion).status).toBe('completed');
 expect(await links(a)).toHaveLength(0);
 expect(await targetExists('grant',target)).toBe(0);
 await consistent();
});
