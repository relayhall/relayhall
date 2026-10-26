import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const url = new URL(process.env.RELAYHALL_TEST_DB_URL || 'postgresql://invalid/invalid');
const name = decodeURIComponent(url.pathname.slice(1));
const local = ['127.0.0.1','localhost','[::1]'].includes(url.hostname) && /test|contract|fixture/.test(name);
const ci = process.env.CI === 'true' && url.hostname === 'postgres' && name === 'relayhall_ci';
if (!['postgres:','postgresql:'].includes(url.protocol) || (!local && !ci)
  || ['relayhall','relayhall_dev','relayhall_tst','relayhall_prod'].includes(name)) {
  throw new Error('Task column retirement proof requires a supported disposable database; it never skips');
}
Object.assign(process.env, {DB_HOST:url.hostname,DB_PORT:url.port||'5432',DB_NAME:name,
  DB_USER:decodeURIComponent(url.username),DB_PASSWORD:decodeURIComponent(url.password)});
const {pool} = require('../db/connection');
const {taskManagerDB} = require('../services/TaskManagerDB');
const {TaskSessionEvidenceService} = require('../services/TaskSessionEvidenceService');
const {TASK_COLUMN_CONTRACT,SERVER_WRITTEN_TASK_COLUMN_KEYS} = require('../utils/taskColumnContract');
const columns=['completed_by','active_agent','acp_session_key','session_refs','last_checked','auto_created'];
const keys=['completedBy','activeAgent','acpSessionKey','sessionRefs','lastChecked','autoCreated'];
const tag='retirement-'+crypto.randomUUID();
jest.setTimeout(60000);

/*
 * Card d0e0c54f (machinery queue 9b761f09): this suite runs inside the shared
 * full-tier chain, so every row it writes is removed again. Each Task and
 * session attempt it creates is recorded here, and `removeOwnRows` deletes
 * them child-first (the session tables RESTRICT their parents; the Task's own
 * children CASCADE). The one exception is `feed_events`: its trigger refuses
 * every DELETE by design (an append-only ledger), so its one row per created
 * Task stays, and the final test names that table rather than skipping it.
 */
const createdTasks:string[]=[];
const createdAttempts:string[]=[];
let tasksCreated=0;
const OWNED_TABLES=['tasks','task_history','task_assignments','task_native_assignment_epochs','task_review_state',
  'session_attempts','task_attempt_links','session_events','session_aliases'];
const APPEND_ONLY_TABLES=['feed_events'];
let countsBefore:Record<string,number>={};

async function tableCounts(tables:string[]):Promise<Record<string,number>>{
  const out:Record<string,number>={};
  for(const table of tables){out[table]=Number((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);}
  return out;
}

async function createTask(title:string){
  const task=await taskManagerDB.createTask({title});
  createdTasks.push(String(task.id));
  tasksCreated+=1;
  return task;
}

async function removeOwnRows():Promise<void>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    if(createdAttempts.length){
      await client.query('DELETE FROM session_aliases WHERE attempt_id = ANY($1::uuid[])',[createdAttempts]);
      await client.query('DELETE FROM session_events WHERE attempt_id = ANY($1::uuid[])',[createdAttempts]);
      await client.query('DELETE FROM task_attempt_links WHERE attempt_id = ANY($1::uuid[])',[createdAttempts]);
      await client.query('DELETE FROM session_attempts WHERE attempt_id = ANY($1::uuid[])',[createdAttempts]);
    }
    if(createdTasks.length) await client.query('DELETE FROM tasks WHERE id = ANY($1::uuid[])',[createdTasks]);
    await client.query('COMMIT');
    createdAttempts.length=0;createdTasks.length=0;
  }catch(error){await client.query('ROLLBACK');throw error;}
  finally{client.release();}
}

beforeAll(async()=>{countsBefore=await tableCounts([...OWNED_TABLES,...APPEND_ONLY_TABLES]);});
afterAll(async()=>{try{await removeOwnRows();}finally{await pool.end();}});

test('all six columns and Task read/request-contract keys are physically retired',async()=>{
  const result=await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='tasks'");
  for(const column of columns){
    expect(result.rows.map((row:any)=>row.column_name)).not.toContain(column);
    expect(TASK_COLUMN_CONTRACT).not.toHaveProperty(column);
  }
  const task=await createTask(tag);
  for(const key of [...columns,...keys]){
    expect(task).not.toHaveProperty(key);
    expect(SERVER_WRITTEN_TASK_COLUMN_KEYS.has(key)).toBe(false);
  }
  const scope=await taskManagerDB.queryScopeRows(['todo']);
  expect(scope.find((row:any)=>row.id===task.id)).toMatchObject({agent:null,title:tag});
});

test('canonical implementation links are Task-scoped, reject uncertain/legacy provenance, and reveal no aliases',async()=>{
  const task=await createTask(tag+'-sessions');
  const other=await createTask(tag+'-other');
  const service=new TaskSessionEvidenceService(pool);
  const fixtures=[
    ['authoritative','operator','released','implementation',task.id,'completed'],
    ['quarantined','operator','bound','implementation',task.id,'completed'],
    ['ambiguous','operator','bound','implementation',task.id,'completed'],
    ['authoritative','legacy_field','bound','implementation',task.id,'completed'],
    ['authoritative','backfill','bound','implementation',task.id,'completed'],
    ['authoritative','operator','unresolved','implementation',task.id,'completed'],
    ['authoritative','operator','superseded','implementation',task.id,'completed'],
    ['authoritative','operator','bound','review',task.id,'completed'],
    ['authoritative','operator','bound','implementation',other.id,'completed'],
  ];
  const ids:string[]=[];
  for(let index=0;index<fixtures.length;index++){
    const [confidence,source,state,role,taskId,lifecycle]=fixtures[index];const id=crypto.randomUUID();ids.push(id);createdAttempts.push(id);
    await pool.query(`INSERT INTO session_attempts(attempt_id,harness,runtime_kind,first_observed_at,started_at,ended_at,identity_confidence,identity_reason,created_by_adapter)
      VALUES($1,'openclaw','fixture',NOW(),NOW(),NOW(),$2,'fixture','retirement-test')`,[id,confidence]);
    await pool.query(`INSERT INTO task_attempt_links(task_id,attempt_id,role,attempt_number,link_state,source,evidence_ref)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[taskId,id,role,index+1,state,source,tag]);
    const payload=JSON.stringify({lifecycle});
    await pool.query(`INSERT INTO session_events(attempt_id,source,source_instance,stream_generation,event_kind,payload,payload_hash,redaction_policy_version,idempotency_key)
      VALUES($1,'fixture','retirement','1','lifecycle',$2::jsonb,$3,'fixture',$4)`,[id,payload,crypto.createHash('sha256').update(payload).digest('hex'),id]);
    await pool.query(`INSERT INTO session_aliases(attempt_id,source,source_instance,alias_kind,alias_value,valid_from,authority,evidence_ref)
      VALUES($1::uuid,'fixture',$1::text,'private-fixture','not-public-'||$1::text,NOW(),'source_authoritative','fixture')`,[id]);
  }
  expect(await service.reviewEvidence(task.id)).toEqual({sessionRefs:[ids[0]],completedBy:{sessionKey:ids[0],harness:'openclaw'}});
  const publicRows=await service.listForTasks([task.id]);
  expect(publicRows).toHaveLength(1);
  expect(JSON.stringify(publicRows)).not.toContain('not-public');
  expect(JSON.stringify(publicRows)).not.toContain(other.id);
  // Existence or end time alone never becomes a completion claim.
  await pool.query(`INSERT INTO session_events(attempt_id,source,source_instance,stream_generation,event_kind,payload,payload_hash,redaction_policy_version,idempotency_key)
    VALUES($1,'fixture','retirement','1','lifecycle','{}',$2,'fixture',$3)`,
    [ids[0],crypto.createHash('sha256').update('{}').digest('hex'),crypto.randomUUID()]);
  expect((await service.reviewEvidence(task.id)).completedBy).toBeNull();
});

/*
 * Migration 151 belongs to this suite (both arrived in one commit). It is run
 * against a SEEDED COPY of the real upgrade path, never a hand-written stand-in
 * and never public.tasks: a scratch schema holds `tasks` copied from the live
 * table's shape (LIKE ... INCLUDING ALL) plus the six columns at their pre-151
 * types and indexes (database/init.sql), seeded with a real Task row. Removing
 * any DROP COLUMN line from the migration reddens the first test below.
 */
const MIGRATION=fs.readFileSync(path.join(__dirname,'../migrations/151_retire_writerless_task_columns.sql'),'utf8');
const PRE_151_COLUMNS=`
  ADD COLUMN auto_created boolean DEFAULT false,
  ADD COLUMN last_checked timestamp with time zone,
  ADD COLUMN session_refs jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN active_agent jsonb,
  ADD COLUMN completed_by jsonb,
  ADD COLUMN acp_session_key text`;

async function withPre151Copy(run:(client:any,schema:string,seededId:string)=>Promise<void>):Promise<void>{
  const schema='retire151_'+crypto.randomBytes(6).toString('hex');
  const client=await pool.connect();
  try{
    const seed=await createTask(tag+'-seed');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`CREATE TABLE ${schema}.tasks (LIKE public.tasks INCLUDING ALL)`);
    await client.query(`ALTER TABLE ${schema}.tasks ${PRE_151_COLUMNS}`);
    await client.query(`CREATE INDEX ON ${schema}.tasks USING btree (acp_session_key) WHERE (acp_session_key IS NOT NULL)`);
    await client.query(`CREATE INDEX ON ${schema}.tasks USING gin (session_refs)`);
    await client.query(`INSERT INTO ${schema}.tasks SELECT t.*, true, NOW(), '["fixture"]'::jsonb, '{}'::jsonb, '{}'::jsonb, 'fixture'
      FROM public.tasks t WHERE t.id = $1`,[seed.id]);
    await run(client,schema,String(seed.id));
  }finally{
    await client.query('ROLLBACK').catch(()=>undefined);
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
  }
}

async function columnsOf(client:any,schema:string):Promise<string[]>{
  const result=await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2',[schema,'tasks']);
  return result.rows.map((row:any)=>String(row.column_name)).sort();
}

async function applyMigration(client:any,schema:string):Promise<void>{
  // The migration names `tasks` unqualified, so it lands on the copy.
  await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
  await client.query(MIGRATION);
}

test('migration 151 on a seeded copy of the pre-151 tasks table drops exactly the six columns and keeps every row and other column',async()=>{
  const publicColumns=await columnsOf(pool,'public');
  await withPre151Copy(async(client,schema,seededId)=>{
    expect(await columnsOf(client,schema)).toEqual([...publicColumns,...columns].sort());
    const before=(await client.query(`SELECT * FROM ${schema}.tasks`)).rows;
    await client.query('BEGIN');
    await applyMigration(client,schema);
    await client.query('COMMIT');
    expect(await columnsOf(client,schema)).toEqual(publicColumns);
    const after=(await client.query(`SELECT * FROM ${schema}.tasks`)).rows;
    expect(after).toEqual(before.map((row:any)=>Object.fromEntries(Object.entries(row).filter(([key])=>!columns.includes(key)))));
    expect(after.map((row:any)=>String(row.id))).toEqual([seededId]);
  });
  // The live table was never the target.
  expect(await columnsOf(pool,'public')).toEqual(publicColumns);
});

test('the exact drop migration rolls back on a later failure and refuses an unexpected dependent view',async()=>{
  await withPre151Copy(async(client,schema)=>{
    const before=(await client.query(`SELECT * FROM ${schema}.tasks`)).rows;
    const shape=await columnsOf(client,schema);
    await client.query('BEGIN');
    await applyMigration(client,schema);
    await expect(client.query('SELECT 1/0')).rejects.toMatchObject({code:'22012'});
    await client.query('ROLLBACK');
    expect(await columnsOf(client,schema)).toEqual(shape);
    expect((await client.query(`SELECT * FROM ${schema}.tasks`)).rows).toEqual(before);
    await client.query(`CREATE VIEW ${schema}.retirement_dependency AS SELECT completed_by FROM ${schema}.tasks`);
    await client.query('BEGIN');
    await expect(applyMigration(client,schema)).rejects.toMatchObject({code:'2BP01'});
    await client.query('ROLLBACK');
    expect(await columnsOf(client,schema)).toEqual(shape);
    expect((await client.query(`SELECT * FROM ${schema}.tasks`)).rows).toEqual(before);
  });
});

test('the suite leaves no rows behind: every table it writes is back to its starting count',async()=>{
  await removeOwnRows();
  const owned=await tableCounts(OWNED_TABLES);
  expect(owned).toEqual(Object.fromEntries(OWNED_TABLES.map((table)=>[table,countsBefore[table]])));
  // The append-only feed keeps one row per created Task (its trigger refuses DELETE), and nothing more.
  expect(tasksCreated).toBeGreaterThan(0);
  expect((await tableCounts(APPEND_ONLY_TABLES)).feed_events-countsBefore.feed_events).toBe(tasksCreated);
});
