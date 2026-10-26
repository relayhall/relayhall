#!/usr/bin/env node
/** Populated pre-149 AZ-A10 backfill proof on a disposable local PG16 database. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const target = process.env.RELAYHALL_TEST_DB_URL;
if (!target) throw new Error('RELAYHALL_TEST_DB_URL is required');
const url = new URL(target);
const name = decodeURIComponent(url.pathname.slice(1));
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !/test|fixture/.test(name)
    || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod'].includes(name)) {
  throw new Error('AZ-A10 backfill proof refuses a non-disposable database');
}
const databaseName = `relayhall_p2b_upgrade_test_${crypto.randomBytes(4).toString('hex')}`;
const connection = { host: url.hostname, port: Number(url.port || 5432),
  user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
const migrations = path.resolve(__dirname, '../src/migrations');
const read = name => fs.readFileSync(path.join(migrations, name), 'utf8');
const manifest = name => read(name).split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#'));
const uuid = async (db, sql, args = []) => String((await db.query(sql, args)).rows[0].id);

async function main() {
  const admin = new Client({ ...connection, database: name });
  await admin.connect();
  let db;
  try {
    await admin.query(`CREATE DATABASE ${databaseName}`);
    db = new Client({ ...connection, database: databaseName });
    await db.connect();
    await db.query(fs.readFileSync(path.resolve(__dirname, '../../database/init.sql'), 'utf8'));
    const inert = new Set([...manifest('BASELINE'), ...manifest('RETIRED')]);
    for (const file of inert) await db.query('INSERT INTO schema_migrations(name) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
    // These are the immutable runner's three compatibility prefixes. The
    // fixture starts from init.sql, so the 086 lease table already exists;
    // only the two historical subtask CHECK shims affect this replay.
    const migrationCompatibilityPrefix = file =>
      ['066_explicit_review_workflow.sql', '068_kebab_case_subtask_states.sql'].includes(file)
        ? 'ALTER TABLE subtasks DROP CONSTRAINT IF EXISTS subtasks_status_check;\n' : '';
    for (const file of fs.readdirSync(migrations).filter(x => x.endsWith('.sql') && x < '149_az_a10_role_grants.sql').sort()) {
      if (inert.has(file)) continue;
      await db.query(migrationCompatibilityPrefix(file) + read(file));
      await db.query('INSERT INTO schema_migrations(name) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
    }
    const assigner = await uuid(db, `INSERT INTO principals(kind,handle,status,role)
      VALUES('human',$1,'active','user') RETURNING id`, [`p2b-assigner-${databaseName}`]);
    const owner = await uuid(db, `INSERT INTO principals(kind,handle,status,role)
      VALUES('human',$1,'active','user') RETURNING id`, [`p2b-owner-${databaseName}`]);
    const holder = await uuid(db, `INSERT INTO principals(kind,handle,status,role,parent_principal_id,own_expression)
      VALUES('service',$1,'active',NULL,$2,'{"scopes":"parent","objects":"parent"}'::jsonb) RETURNING id`,
      [`p2b-holder-${databaseName}`, assigner]);
    await db.query(`INSERT INTO principal_credentials(principal_id,credential_type,secret_hash,scopes,expires_at,
      created_by_principal_id) VALUES($1,'api_key','holder-fixture-hash','["reports:read","tasks:read"]'::jsonb,
      NOW()+INTERVAL '1 day',$2)`, [holder, assigner]);
    const service = await uuid(db, `INSERT INTO services(slug,name,kind,principal_id)
      VALUES($1,$1,'connector',$2) RETURNING id`, [`p2b-${crypto.randomBytes(5).toString('hex')}`, holder]);
    const project = await uuid(db, `INSERT INTO projects(name) VALUES($1) RETURNING id`, [`P2-B ${databaseName}`]);
    const task = await uuid(db, `INSERT INTO tasks(title,status,project_id,shepherd_principal_id,
      owner_principal_id,creator_principal_id,execution_service_id,execution_descriptor_version)
      VALUES($1,'todo',$2,$3,$3,$3,$4,1) RETURNING id`, [`P2-B historical ${databaseName}`, project, owner, service]);
    const allowedReport = await uuid(db, `INSERT INTO reports(title,content,task_ids,visibility)
      VALUES('allowed report','fixture',ARRAY[$1]::uuid[],'private') RETURNING id`, [task]);
    const deniedReport = await uuid(db, `INSERT INTO reports(title,content,task_ids,visibility)
      VALUES('out-of-cap report','fixture',ARRAY[$1]::uuid[],'private') RETURNING id`, [task]);
    // Inside the assigner's cap and outside every pinned Agent ceiling: the
    // ceiling is the only thing that keeps this one from a warrant Agent.
    const ceilingReport = await uuid(db, `INSERT INTO reports(title,content,task_ids,visibility)
      VALUES('outside-ceiling report','fixture',ARRAY[$1]::uuid[],'private') RETURNING id`, [task]);
    const ownerTask = await uuid(db, `INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,
      granted_by_principal_id) VALUES('principal',$1,'task',$2,'read',$1) RETURNING id`, [assigner, task]);
    await db.query(`INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,
      granted_by_principal_id) VALUES('principal',$1,'task',$2,'write',$1),
      ('principal',$1,'report',$3,'read',$1),
      ('principal',$1,'report',$4,'read',$1)`, [assigner, task, allowedReport, ceilingReport]);
    await db.query(`INSERT INTO access_vehicle_links(task_id,assignee_principal_id,landed_on_principal_id,
      vehicle_kind,target_kind,target_id,created_by_vehicle,created_by_principal_id)
      VALUES($1,$2,$3,'auto-grant','grant',$4,FALSE,$3)`, [task, holder, assigner, ownerTask]);

    // A live historical Agent bound outside its pinned ceiling must stop the
    // upgrade before migration removes the old bound-task default.
    const profile = await uuid(db, `INSERT INTO access_profiles(name,created_by_principal_id)
      VALUES($1,$2) RETURNING id`, [`p2b-ceiling-${databaseName}`, assigner]);
    const version = await uuid(db, `INSERT INTO access_profile_versions(profile_id,version_number,created_by_principal_id)
      VALUES($1,1,$2) RETURNING id`, [profile, assigner]);
    await db.query(`INSERT INTO access_profile_rules(version_id,resource_type,selector_form,selector_ids,verbs)
      VALUES($1,'report','exact',ARRAY[$2]::uuid[],ARRAY['read']::text[])`, [version, allowedReport]);
    const warrant = await uuid(db, `INSERT INTO warrants(name,holder_principal_id,created_by_principal_id,
      ceiling_profile_version_id,status,expires_at) VALUES($1,$2,$3,$4,'active',NOW()+INTERVAL '1 day') RETURNING id`,
      [`p2b-warrant-${databaseName}`, holder, assigner, version]);
    const agent = await uuid(db, `INSERT INTO principals(kind,handle,status,parent_principal_id,bound_task_id,
      own_expression,minted_under_warrant_id) VALUES('agent',$1,'active',$2,$3,
      '{"scopes":["tasks:read","reports:read"],"objects":[]}'::jsonb,$4) RETURNING id`,
      [`p2b-agent-${databaseName}`, holder, task, warrant]);
    await db.query(`INSERT INTO principal_credentials(principal_id,credential_type,secret_hash,scopes,expires_at,
      created_by_principal_id) VALUES($1,'api_key','fixture-hash','["tasks:read","reports:read"]'::jsonb,NOW()+INTERVAL '1 day',$2)`,
      [agent, holder]);
    const migration149 = process.env.AZ_A10_MIGRATION_SQL
      ? fs.readFileSync(process.env.AZ_A10_MIGRATION_SQL, 'utf8')
      : read('149_az_a10_role_grants.sql');
    await assert.rejects(db.query(migration149), /bound row exceeds pinned warrant ceiling/);
    assert.equal((await db.query(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists`)).rows[0].exists, true);
    assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM grants WHERE grantee_id=$1`, [agent])).rows[0].n, 0);
    assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM access_vehicle_links WHERE vehicle_kind='auto-grant'
      AND task_id=$1`, [task])).rows[0].n, 1);

    await db.query(`UPDATE principals SET status='disabled' WHERE id=$1`, [agent]);
    const goodProfile = await uuid(db, `INSERT INTO access_profiles(name,created_by_principal_id)
      VALUES($1,$2) RETURNING id`, [`p2b-good-ceiling-${databaseName}`, assigner]);
    const goodVersion = await uuid(db, `INSERT INTO access_profile_versions(profile_id,version_number,created_by_principal_id)
      VALUES($1,1,$2) RETURNING id`, [goodProfile, assigner]);
    await db.query(`INSERT INTO access_profile_rules(version_id,resource_type,selector_form,selector_ids,verbs)
      VALUES($1,'task','exact',ARRAY[$2]::uuid[],ARRAY['read']::text[]),
      ($1,'report','exact',ARRAY[$3]::uuid[],ARRAY['read']::text[])`, [goodVersion, task, allowedReport]);
    const goodWarrant = await uuid(db, `INSERT INTO warrants(name,holder_principal_id,created_by_principal_id,
      ceiling_profile_version_id,status,expires_at) VALUES($1,$2,$3,$4,'active',NOW()+INTERVAL '1 day') RETURNING id`,
      [`p2b-good-warrant-${databaseName}`, holder, assigner, goodVersion]);
    const goodAgent = await uuid(db, `INSERT INTO principals(kind,handle,status,parent_principal_id,bound_task_id,
      own_expression,minted_under_warrant_id) VALUES('agent',$1,'active',$2,$3,
      '{"scopes":["tasks:read","reports:read"],"objects":[]}'::jsonb,$4) RETURNING id`,
      [`p2b-good-agent-${databaseName}`, holder, task, goodWarrant]);
    await db.query(`INSERT INTO principal_credentials(principal_id,credential_type,secret_hash,scopes,expires_at,
      created_by_principal_id) VALUES($1,'api_key','good-fixture-hash','["tasks:read","reports:read"]'::jsonb,
      NOW()+INTERVAL '1 day',$2)`, [goodAgent, holder]);
    await db.query(migration149);
    const roleRows = (await db.query(`SELECT g.resource_type,g.resource_id,g.verb,g.granted_by_principal_id,
      l.created_by_vehicle FROM grants g JOIN access_vehicle_links l ON l.target_id=g.id
      WHERE l.task_id=$1 AND l.vehicle_kind='role' AND l.landed_on_principal_id=$2`, [task, holder])).rows;
    assert.deepEqual(roleRows.map(r => `${r.resource_type}:${r.resource_id}:${r.verb}`).sort(),
      [`report:${allowedReport}:read`, `report:${ceilingReport}:read`, `task:${task}:read`, `task:${task}:write`].sort());
    assert(roleRows.every(r => String(r.granted_by_principal_id) === assigner));
    const agentRoleRows = (await db.query(`SELECT g.resource_type,g.resource_id,g.verb,g.granted_by_principal_id
      FROM grants g JOIN access_vehicle_links l ON l.target_id=g.id
      WHERE l.task_id=$1 AND l.vehicle_kind='role' AND l.landed_on_principal_id=$2`, [task, goodAgent])).rows;
    assert.deepEqual(agentRoleRows.map(r => `${r.resource_type}:${r.resource_id}:${r.verb}`).sort(),
      [`report:${allowedReport}:read`, `task:${task}:read`].sort());
    assert(agentRoleRows.every(r => String(r.granted_by_principal_id) === holder));
    assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM grants WHERE grantee_id=$1
      AND resource_type='report' AND resource_id=$2`, [goodAgent, deniedReport])).rows[0].n, 0);
    assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM grants WHERE grantee_id=$1
      AND resource_type='report' AND resource_id=$2`, [goodAgent, ceilingReport])).rows[0].n, 0);
    assert.equal((await db.query(`SELECT metadata->>'reason' AS reason FROM audit_events
      WHERE action='grant.reference_skipped' AND resource_type='report' AND resource_id=$1
        AND metadata->>'assigneePrincipalId'=$2`, [ceilingReport, goodAgent])).rows[0]?.reason,
      'reference exceeds pinned warrant ceiling');
    assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM grants WHERE grantee_id=$1
      AND resource_type='report' AND resource_id=$2`, [holder, deniedReport])).rows[0].n, 0);
    Object.assign(process.env, { DB_HOST: connection.host, DB_PORT: String(connection.port),
      DB_NAME: databaseName, DB_USER: connection.user, DB_PASSWORD: connection.password });
    const { delegationService } = require('../dist/services/DelegationService');
    const { authorizationRepository } = require('../dist/services/AuthorizationRepository');
    const { pool } = require('../dist/db/connection');
    const chain = await delegationService.resolveChain(holder, db);
    assert.equal(chain.alive, true);
    const visible = await authorizationRepository.authorizedIds({
      principalId: holder, handle: 'p2b-holder', role: null, scopes: null,
      authenticated: true, delegation: { links: chain.links },
    }, 'report', [allowedReport, deniedReport], 'read', db);
    assert(visible.has(allowedReport));
    assert(!visible.has(deniedReport));
    const agentChain = await delegationService.resolveChain(goodAgent, db);
    assert.equal(agentChain.alive, true);
    const agentVisible = await authorizationRepository.authorizedIds({
      principalId: goodAgent, handle: 'p2b-good-agent', role: null, scopes: null,
      authenticated: true, delegation: { links: agentChain.links },
    }, 'report', [allowedReport, deniedReport, ceilingReport], 'read', db);
    assert(agentVisible.has(allowedReport));
    assert(!agentVisible.has(deniedReport));
    assert(!agentVisible.has(ceilingReport));
    await pool.end();
    const skipped = (await db.query(`SELECT metadata FROM audit_events WHERE action='grant.reference_skipped'
      AND resource_type='report' AND resource_id=$1
      AND metadata->>'assigneePrincipalId'=$2 ORDER BY occurred_at DESC LIMIT 1`, [deniedReport, holder])).rows[0];
    assert.match(skipped.metadata.reason, /exceeds provable assigner cap/);
    assert.equal((await db.query('SELECT id FROM grants WHERE id=$1', [ownerTask])).rows.length, 1);
    assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM access_vehicle_links WHERE target_id=$1
      AND created_by_vehicle=FALSE`, [ownerTask])).rows[0].n, 0);
    console.log(JSON.stringify({ result: 'PASS', database: databaseName, pre149AgentRefusal: true,
      allowedRows: roleRows.length, authorizedAgentRows: agentRoleRows.length,
      deniedReportNoGrantOrRead: true, ceilingReportNoAgentGrantOrRead: true, ownerPlanePreserved: true }));
  } finally {
    if (db) await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
