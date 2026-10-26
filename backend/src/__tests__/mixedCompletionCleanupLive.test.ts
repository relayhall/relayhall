export {};
/** Ordinary storage/transaction correctness only. No HTTP, auth sessions or providers. */
const url = process.env.RELAYHALL_TEST_DB_URL;
if (!url) throw new Error("Owned synthetic PG URL required");
const db = new URL(url);
if (!db.pathname.startsWith("/mixed_cleanup_test")) throw new Error("Only owned mixed_cleanup_test database allowed");
Object.assign(process.env, { DB_HOST: db.hostname, DB_PORT: db.port, DB_NAME: db.pathname.slice(1),
  DB_USER: decodeURIComponent(db.username), DB_PASSWORD: decodeURIComponent(db.password), NODE_ENV: "test" });
const { pool } = require("../db/connection");
const { taskManagerDB } = require("../services/TaskManagerDB");
const { TaskReviewAttemptService } = require("../services/TaskReviewAttemptService");
const { hashReviewReports } = require("../services/TaskReviewAttemptService");
const { accessVehicleService, SYSTEM_AUTHORIZATION_ACTOR } = require("../services/AccessVehicleService");
const audit = { handle: "system", authMethod: "system" };
const crypto = require("crypto");
const ledger = new TaskReviewAttemptService(pool);
const actor = { handle: "system", authMethod: "system", role: "reviewer", principalId: null };
let principal: string;
const baseline = process.env.MIXED_BASELINE === "1";
jest.setTimeout(30000);
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
async function client() { const c = await pool.connect(); await c.query("BEGIN"); await c.query("SET LOCAL statement_timeout = '10s'"); return c; }
function proxy(c: any, hook: (sql: string) => Promise<void>) { return { query: async (sql: string, args?: any[]) => { await hook(sql); return c.query(sql, args); } }; }
const transaction = (c: any) => ({ client: c, actor, afterCommit: () => undefined });
async function task(status = "review") { return (await pool.query("INSERT INTO tasks(title,status,owner_principal_id,creator_principal_id,shepherd_principal_id) VALUES($1,$2,$3,$3,$3) RETURNING id", ["mixed-"+crypto.randomUUID(),status,principal])).rows[0].id; }
async function link(t: string, g: string, automatic = true, kind = "grant", warrant: string|null = null) {
 await pool.query(`INSERT INTO access_vehicle_links(task_id,assignee_principal_id,landed_on_principal_id,vehicle_kind,warrant_id,target_kind,target_id,created_by_vehicle)
 VALUES($1,$2,$2,$3,$4,$5,$6,$7)`,[t,principal,warrant ? "warrant" : "auto-grant",warrant,kind,g,automatic]);
}
async function shared() { const a = await task(), b = await task(); const g = (await pool.query("INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,provenance) VALUES('principal',$1,'task',$2,'read','assignment:grant') RETURNING id",[principal,a])).rows[0].id; await link(a,g);await link(b,g); const attempt = await ledger.beginAttempt(await taskManagerDB.getTask(a),{ reportDigest: hashReviewReports([]) }); return {a,b,g,attempt}; }
const verdict = (id: string,c: any) => ledger.recordVerdict(id,"pass",[],{summary:"Synthetic transaction verdict"},undefined,false,c);
async function exists(g: string) { return (await pool.query("SELECT id FROM grants WHERE id=$1",[g])).rowCount; }
async function assertGone(f: any) { expect((await pool.query("SELECT * FROM access_vehicle_links WHERE task_id=ANY($1::uuid[])",[[f.a,f.b]])).rows).toHaveLength(0);expect(await exists(f.g)).toBe(0); }
async function observeBlocked(waiter: number, blocker: number) {
 const until = Date.now()+5000;
 while(Date.now()<until) { const q = await pool.query("SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked",[waiter,blocker]); if(q.rows[0].blocked) { console.log("OBSERVED PG blocking edge", {waiter,blocker}); return; } await new Promise<void>(r=>setImmediate(r)); }
 throw new Error("Expected actual PG blocking edge was not observed");
}
beforeAll(async()=> { principal=(await pool.query("INSERT INTO principals(kind,handle,display_name,status,role) VALUES('human',$1,$1,'active','operator') RETURNING id",["mixed-"+crypto.randomUUID()])).rows[0].id; });
afterAll(async()=> { await pool.end(); });
test("mixed verdict-first schedule: old stranded target, repaired conflict rollback/retry", async()=> {
 const f=await shared(),v=await client(),u=await client();const paused=gate(),resume=gate(),atFeed=gate();
 const vp=proxy(v,async sql=>{if(sql.includes("DELETE FROM access_vehicle_links")){paused.release();await resume.promise;}});
 const up=proxy(u,async sql=>{if(sql.includes("pg_advisory_xact_lock") && sql.includes("feed_events"))atFeed.release();});
 let runningV: any, runningU: any;
 try {
  runningV=verdict(f.attempt.id,vp);await paused.promise;
  runningU=taskManagerDB.updateTask(f.b,{status:"completed"},actor,undefined,transaction(up));
  if(baseline) { await atFeed.promise;await observeBlocked(u.processID,v.processID);resume.release();await runningV;await v.query("COMMIT");await runningU;await u.query("COMMIT");
    expect(await exists(f.g)).toBe(1);expect((await pool.query("SELECT * FROM access_vehicle_links WHERE target_id=$1",[f.g])).rows).toHaveLength(0);
  } else {
    await expect(runningU).rejects.toMatchObject({code:"ASSIGNMENT_REFERENCE_BUSY"});await u.query("ROLLBACK");
    expect((await pool.query("SELECT status FROM tasks WHERE id=$1",[f.b])).rows[0].status).toBe("review");
    resume.release();await runningV;await v.query("COMMIT");expect(await exists(f.g)).toBe(1);
    await taskManagerDB.updateTask(f.b,{status:"completed"},actor);await assertGone(f);
    expect(await ledger.recordVerdict(f.attempt.id,"pass",[],{})).toMatchObject({applied:false});
  }
 } finally {resume.release();if(runningV)await runningV.catch(()=>{});if(runningU)await runningU.catch(()=>{});await v.query("ROLLBACK");await u.query("ROLLBACK");v.release();u.release();}
});
(baseline ? test.skip : test)("ordinary-first holds target then waits feed; verdict conflict releases feed and retry removes last reference",async()=>{
 const f=await shared(),v=await client(),u=await client();const atFeed=gate(),resume=gate(),blockedFeed=gate();
 const up=proxy(u,async sql=>{if(sql.includes("pg_advisory_xact_lock")&&sql.includes("feed_events")){atFeed.release();await resume.promise;blockedFeed.release();}});
 let runningU:any;
 try {
  runningU=taskManagerDB.updateTask(f.b,{status:"completed"},actor,undefined,transaction(up));await atFeed.promise;
  await v.query("SELECT pg_advisory_xact_lock(hashtext('feed_events'))");resume.release();await blockedFeed.promise;await observeBlocked(u.processID,v.processID);
  await expect(verdict(f.attempt.id,v)).rejects.toMatchObject({code:"ASSIGNMENT_REFERENCE_BUSY"});await v.query("ROLLBACK");
  await runningU;await u.query("COMMIT");expect(await exists(f.g)).toBe(1);
  const c=await client();try{await verdict(f.attempt.id,c);await c.query("COMMIT");}finally{await c.query("ROLLBACK");c.release();}await assertGone(f);
 }finally{resume.release();await v.query("ROLLBACK");if(runningU)await runningU.catch(()=>{});await u.query("ROLLBACK");v.release();u.release();}
});

// Core materialization helpers are exercised as storage units, not authority
// predicates. Their public attach/recompute callers share these exact helpers.
const materialize = (c: any,t: string,resource: string) => accessVehicleService.ensureGrant(c,{
 taskId:t,assigneePrincipalId:principal,granteeId:principal,resourceType:"task",resourceId:resource,
 verb:"read",vehicleKind:"auto-grant",warrantId:null,actor:audit });
const fixedTest = baseline ? test.skip : test;
fixedTest("concurrent absent-target creation refuses immediately, rollback/retry shares one target and provenance",async()=>{
 const a=await task(),b=await task(),resource=crypto.randomUUID(),c=await client(),d=await client();
 try { const one=await materialize(c,a,resource);await expect(materialize(d,b,resource)).rejects.toMatchObject({code:"ASSIGNMENT_REFERENCE_BUSY"});await d.query("ROLLBACK");await c.query("COMMIT");
  await d.query("BEGIN");const two=await materialize(d,b,resource);expect(two.targetId).toBe(one.targetId);expect(two.createdByVehicle).toBe(true);await d.query("COMMIT");
  expect((await pool.query("SELECT * FROM grants WHERE resource_id=$1",[resource])).rows).toHaveLength(1);
  await c.query("BEGIN");await accessVehicleService.detach(c,a,audit,"synthetic sharing");await c.query("COMMIT");expect(await exists(one.targetId)).toBe(1);
  await d.query("BEGIN");await accessVehicleService.detach(d,b,audit,"synthetic last ref");await d.query("COMMIT");expect(await exists(one.targetId)).toBe(0);
 }finally{await c.query("ROLLBACK");await d.query("ROLLBACK");c.release();d.release();}
});
fixedTest.each(["creation-first","cleanup-first"])("attach materialization vs cleanup %s: bounded refusal and consistent retry",async order=>{
 const f=await shared(),t=await task(),c=await client(),d=await client();
 try {
  if(order==="creation-first") {await materialize(c,t,f.a);await expect(accessVehicleService.detach(d,f.a,audit,"synthetic")).rejects.toMatchObject({code:"ASSIGNMENT_REFERENCE_BUSY"});await d.query("ROLLBACK");await c.query("COMMIT");}
  else {await accessVehicleService.detach(c,f.a,audit,"synthetic");await expect(materialize(d,t,f.a)).rejects.toMatchObject({code:"ASSIGNMENT_REFERENCE_BUSY"});await d.query("ROLLBACK");await c.query("COMMIT");await d.query("BEGIN");await materialize(d,t,f.a);await d.query("COMMIT");}
  await c.query("BEGIN");await accessVehicleService.detach(c,f.b,audit,"synthetic");await accessVehicleService.detach(c,f.a,audit,"synthetic retry");await c.query("COMMIT");expect(await exists(f.g)).toBe(1);
  await d.query("BEGIN");await accessVehicleService.detach(d,t,audit,"synthetic last");await d.query("COMMIT");expect(await exists(f.g)).toBe(0);
 }finally{await c.query("ROLLBACK");await d.query("ROLLBACK");c.release();d.release();}
});
fixedTest("recompute removal versus creation locks the same tuple; rollback and retry retain sharing",async()=>{
 const f=await shared(),t=await task(),c=await client(),d=await client();
 try {
  // B references A only through its synthetic automatic link; recompute
  // removes that no-longer-desired reference, while retaining A own link.
  await accessVehicleService.recompute(c,f.b,audit,SYSTEM_AUTHORIZATION_ACTOR);
  await expect(materialize(d,t,f.a)).rejects.toMatchObject({code:"ASSIGNMENT_REFERENCE_BUSY"});await d.query("ROLLBACK");await c.query("ROLLBACK");
  expect((await pool.query("SELECT * FROM access_vehicle_links WHERE target_id=$1",[f.g])).rows).toHaveLength(2);
  await c.query("BEGIN");await accessVehicleService.recompute(c,f.b,audit,SYSTEM_AUTHORIZATION_ACTOR);await c.query("COMMIT");expect(await exists(f.g)).toBe(1);
  await d.query("BEGIN");await materialize(d,t,f.a);await d.query("COMMIT");
  await c.query("BEGIN");await accessVehicleService.detach(c,f.a,audit,"synthetic");await c.query("COMMIT");expect(await exists(f.g)).toBe(1);
  await d.query("BEGIN");await accessVehicleService.detach(d,t,audit,"synthetic");await d.query("COMMIT");expect(await exists(f.g)).toBe(0);
 }finally{await c.query("ROLLBACK");await d.query("ROLLBACK");c.release();d.release();}
});
fixedTest("profile target creation/sharing/cleanup has the same rollback and last-reference discipline",async()=>{
 const a=await task(),b=await task(),c=await client(),d=await client();
 const profile=(await pool.query("INSERT INTO access_profiles(name) VALUES($1) RETURNING id",["mixed-"+crypto.randomUUID()])).rows[0].id;
 const version=(await pool.query("INSERT INTO access_profile_versions(profile_id,version_number) VALUES($1,1) RETURNING id",[profile])).rows[0].id;
 const warrant=(await pool.query("INSERT INTO warrants(name,holder_principal_id,ceiling_profile_version_id) VALUES($1,$2,$3) RETURNING id",["mixed-"+crypto.randomUUID(),principal,version])).rows[0].id;
 const create=(x:any,t:string)=>accessVehicleService.ensureProfileAssignment(x,{taskId:t,assigneePrincipalId:principal,granteeId:principal,profileId:profile,warrantId:warrant,actor:audit});
 try {
  const one=await create(c,a);await expect(create(d,b)).rejects.toMatchObject({code:"ASSIGNMENT_REFERENCE_BUSY"});await d.query("ROLLBACK");await c.query("COMMIT");
  await d.query("BEGIN");const two=await create(d,b);expect(two.targetId).toBe(one.targetId);expect(two.createdByVehicle).toBe(true);await d.query("COMMIT");
  await c.query("BEGIN");await accessVehicleService.detach(c,a,audit,"synthetic");await d.query("BEGIN");await expect(accessVehicleService.detach(d,b,audit,"synthetic")).rejects.toMatchObject({code:"ASSIGNMENT_REFERENCE_BUSY"});await d.query("ROLLBACK");await c.query("ROLLBACK");
  expect((await pool.query("SELECT * FROM access_vehicle_links WHERE target_id=$1",[one.targetId])).rows).toHaveLength(2);
  await c.query("BEGIN");await accessVehicleService.detach(c,a,audit,"synthetic");await c.query("COMMIT");
  expect((await pool.query("SELECT id FROM access_profile_assignments WHERE id=$1",[one.targetId])).rowCount).toBe(1);
  await d.query("BEGIN");await accessVehicleService.detach(d,b,audit,"synthetic");await d.query("COMMIT");
  expect((await pool.query("SELECT id FROM access_profile_assignments WHERE id=$1",[one.targetId])).rowCount).toBe(0);
  expect((await pool.query("SELECT * FROM access_profile_events WHERE profile_id=$1 AND action='profile.unassigned'",[profile])).rows).toHaveLength(1);
 }finally{await c.query("ROLLBACK");await d.query("ROLLBACK");c.release();d.release();}
});

fixedTest("independent/manual targets and null-resource tuple survive last linked removal",async()=>{
 const t=await task(),c=await client();
 const manual=(await pool.query("INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb) VALUES('principal',$1,'task',NULL,'read') RETURNING id",[principal])).rows[0].id;
 const independent=(await pool.query("INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb) VALUES('principal',$1,'task',$2,'write') RETURNING id",[principal,t])).rows[0].id;
 try {const result=await materialize(c,t,null as any);expect(result.targetId).toBe(manual);expect(result.createdByVehicle).toBe(false);await c.query("COMMIT");
  await c.query("BEGIN");await accessVehicleService.detach(c,t,audit,"synthetic");await c.query("COMMIT");expect(await exists(manual)).toBe(1);expect(await exists(independent)).toBe(1);
 }finally{await c.query("ROLLBACK");c.release();}
});
