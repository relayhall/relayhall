#!/usr/bin/env node
'use strict';

// Fresh-install replay gate (task 468faa10, review 90d8abd9 finding 1).
//
// Proves the DOCUMENTED fresh-install sequence end-to-end against a live
// PostgreSQL: apply database/init.sql (the 042-era baseline, which keeps the
// retired agent_types names the historical chain requires), then run the real
// migration runner, and assert the chain finishes in the ratified Personality
// schema (migration 069).
//
// Point DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME at a DISPOSABLE database:
// this script applies the full schema and every active migration to it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Pool } = require('pg');

const initSql = fs.readFileSync(path.resolve(__dirname, '../../database/init.sql'), 'utf8');
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'relayhall_dev',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'relayhall_dev',
});

async function main() {
  const client = await pool.connect();
  try {
    const populated = await client.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'"
    );
    assert.equal(populated.rows[0].n, 0, 'refusing to run: target database is not empty');

    // 1. The baseline, exactly as a fresh install applies it.
    await client.query(initSql);

    // 2. The real migration runner (stamps BASELINE, executes 043+ in order).
    execFileSync('node', ['./node_modules/ts-node/dist/bin.js', 'src/db/migrate.ts'], {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit',
      env: process.env,
    });

    // 3. The chain must end in the ratified Personality schema.
    const q = async (sql) => (await client.query(sql)).rows;
    assert.equal((await q("SELECT to_regclass('public.personalities') AS r"))[0].r, 'personalities');
    assert.equal((await q("SELECT to_regclass('public.agent_types') AS r"))[0].r, null);
    assert.equal((await q("SELECT to_regclass('public.attempt_personality_links') AS r"))[0].r, 'attempt_personality_links');
    assert.equal((await q("SELECT to_regclass('public.attempt_persona_links') AS r"))[0].r, null);
    for (const [table, column] of [['tasks', 'personality_id'], ['sessions', 'personality_id'], ['principals', 'personality_id']]) {
      const rows = await q(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}' AND column_name='${column}'`);
      assert.equal(rows.length, 1, `${table}.${column} missing`);
      const old = await q(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}' AND column_name='agent_type_id'`);
      assert.equal(old.length, 0, `${table}.agent_type_id survived`);
    }
    const constraints = (await q(
      "SELECT c.conname FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid WHERE r.relname = 'personalities' ORDER BY 1"
    )).map(r => r.conname);
    for (const expected of ['personalities_pkey', 'personalities_slug_key', 'personalities_source_check']) {
      assert.ok(constraints.includes(expected), `missing constraint ${expected}`);
    }
    // Migration 073 (RH-VOCAB.9 / A15.6) renames the built-in reviewer
    // personality to verifier at the end of the chain.
    const seeds = await q("SELECT count(*)::int AS n FROM personalities WHERE slug IN ('generalist','planner','implementer','verifier','researcher')");
    assert.equal(seeds[0].n, 5, 'built-in seeds missing after replay');

    // 4. The chain must end in the ratified Skills schema (migration 072,
    //    RH-VOCAB.3 / A14): registry renamed, links renamed, curated basics
    //    seeded — and ONLY the curated basics (the A14.4 data reset).
    assert.equal((await q("SELECT to_regclass('public.skills') AS r"))[0].r, 'skills');
    assert.equal((await q("SELECT to_regclass('public.tools') AS r"))[0].r, null);
    assert.equal((await q("SELECT to_regclass('public.project_skills') AS r"))[0].r, 'project_skills');
    assert.equal((await q("SELECT to_regclass('public.project_tools') AS r"))[0].r, null);
    const skillCol = await q("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='project_skills' AND column_name='skill_id'");
    assert.equal(skillCol.length, 1, 'project_skills.skill_id missing');
    const oldCol = await q("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='project_skills' AND column_name='tool_id'");
    assert.equal(oldCol.length, 0, 'project_skills.tool_id survived');
    const skillConstraints = (await q(
      "SELECT c.conname FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid WHERE r.relname IN ('skills','project_skills') ORDER BY 1"
    )).map(r => r.conname);
    for (const expected of ['skills_pkey', 'skills_name_key', 'project_skills_pkey', 'project_skills_project_id_skill_id_key', 'project_skills_skill_id_fkey']) {
      assert.ok(skillConstraints.includes(expected), `missing constraint ${expected}`);
    }
    const skillRows = (await q('SELECT name FROM skills ORDER BY name')).map(r => r.name);
    assert.deepEqual(
      skillRows,
      ['api-access', 'project-management', 'report-management', 'skill-management', 'task-management'],
      'skills registry must hold exactly the curated basics after the A14.4 reset'
    );

    const oldSeed = await q("SELECT count(*)::int AS n FROM personalities WHERE slug = 'reviewer'");
    assert.equal(oldSeed[0].n, 0, 'reviewer personality slug survived migration 073');

    // Migration 074 (task 796ba3f0) rewrites the 065-seeded Generalist
    // description to ratified vocabulary at the end of the chain.
    const generalist = await q("SELECT description FROM personalities WHERE slug = 'generalist' AND source = 'built-in'");
    assert.equal(generalist.length, 1, 'built-in generalist missing after replay');
    assert.equal(generalist[0].description, 'A balanced default for ordinary tasks.', 'generalist description not rewritten by migration 074');
    const residue = await q("SELECT count(*)::int AS n FROM personalities WHERE description LIKE '%work item%'");
    assert.equal(residue[0].n, 0, 'retired phrase survived in a personality description');

    // Migration 075 (task f2735f1b) ships the Charter schema — head table,
    // append-only versions table, and no seed rows by design.
    for (const table of ['project_charters', 'project_charter_versions']) {
      const reg = await q(`SELECT to_regclass('public.${table}') AS r`);
      assert.ok(reg[0].r, `${table} missing after replay (migration 075)`);
    }
    const charterSeeds = await q('SELECT count(*)::int AS n FROM project_charters');
    assert.equal(charterSeeds[0].n, 0, 'migration 075 must not seed charter rows');

    // Migration 076 (task a4af8cf2) ships the Service registry schema —
    // services head table and descriptor versions. Migration 116 adds the
    // reserved in-process board source; external registries start empty.
    for (const table of ['services', 'service_descriptor_versions']) {
      const reg = await q(`SELECT to_regclass('public.${table}') AS r`);
      assert.ok(reg[0].r, `${table} missing after replay (migration 076)`);
    }
    const serviceSeeds = await q('SELECT slug, kind, knowledge_query_endpoint, knowledge_get_endpoint, knowledge_core_credential_ref FROM services');
    assert.equal(serviceSeeds.length, 1, 'only the reserved board source may exist');
    assert.equal(serviceSeeds[0].slug, 'board');
    assert.equal(serviceSeeds[0].kind, 'service');
    for (const field of ['knowledge_query_endpoint', 'knowledge_get_endpoint', 'knowledge_core_credential_ref']) {
      assert.equal(serviceSeeds[0][field], null, `board ${field} must not dial an estate service`);
    }
    const serviceConstraints = await q(
      "SELECT conname FROM pg_constraint WHERE conrelid = 'public.services'::regclass AND contype IN ('u','c') ORDER BY conname",
    );
    const constraintNames = serviceConstraints.map((r) => r.conname);
    assert.ok(constraintNames.includes('services_slug_key'), 'services slug uniqueness missing (076)');
    const versionUnique = await q(
      "SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'public.service_descriptor_versions'::regclass AND contype = 'u'",
    );
    assert.ok(versionUnique[0].n >= 1, 'service_descriptor_versions (service_id, version) uniqueness missing (076)');

    // Migration 077 (task a44b9b06) adds the connector-first execution
    // profile pin columns to tasks; no rows are touched.
    for (const column of ['execution_service_id', 'execution_descriptor_version']) {
      const col = await q(
        `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = '${column}'`,
      );
      assert.equal(col[0].n, 1, `tasks.${column} missing after replay (migration 077)`);
    }
    const pinFk = await q(
      "SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'public.tasks'::regclass AND contype = 'f' AND confrelid = 'public.services'::regclass",
    );
    assert.equal(pinFk[0].n, 1, 'tasks.execution_service_id FK to services missing (077)');

    // Migration 078 (task 03f50650) ships the grants schema — the
    // target-shape polymorphic authority table — and migrates the single
    // 064 pre-grant row into it (the one deliberate non-empty exception;
    // inherited bytes, not new content).
    const grantsReg = await q("SELECT to_regclass('public.grants') AS r");
    assert.ok(grantsReg[0].r, 'grants table missing after replay (migration 078)');
    const grantConstraints = await q(
      "SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'public.grants'::regclass AND contype = 'u'",
    );
    assert.ok(grantConstraints[0].n >= 1, 'grants unique constraint missing (078)');
    // Index names are schema-wide: assert BOTH lookup indexes actually landed
    // ON grants, not merely that the names exist somewhere (a6811c12).
    const grantIndexes = await q(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'grants' ORDER BY indexname",
    );
    const indexNames = grantIndexes.map((r) => r.indexname);
    assert.ok(indexNames.includes('ix_grants_grantee_lookup'), 'grants grantee index missing (078 — name collision?)');
    assert.ok(indexNames.includes('ix_grants_resource'), 'grants resource index missing (078)');
    // 131 retires the unconfigured legacy report-reader and its seed grant.
    assert.equal((await q('SELECT count(*)::int AS n FROM grants'))[0].n, 0,
      'fresh installation must not grant access to a legacy report-reader');
    assert.equal((await q('SELECT count(*)::int AS n FROM resource_grants'))[0].n, 0);
    assert.deepEqual((await q('SELECT handle FROM principals ORDER BY handle')).map(r => r.handle),
      ['dashboard_user', 'system'], 'only bootstrap and internal actors may be present');
    assert.equal((await q("SELECT count(*)::int AS n FROM principals WHERE legacy_identity OR purpose LIKE 'LEGACY%'")).pop().n, 0);
    for (const table of ['projects','tasks','reports','sessions','agents','principal_credentials',
      'auth_sessions','identity_providers','groups','access_profile_assignments','blueprints',
      'notification_endpoints','webhooks','audit_events','feed_events','bot_status']) {
      assert.equal((await q(`SELECT count(*)::int AS n FROM ${table}`))[0].n, 0,
        `${table} must start empty`);
    }
    // The superseded table remains; only pristine seed authority was removed.
    const oldReg = await q("SELECT to_regclass('public.resource_grants') AS r");
    assert.ok(oldReg[0].r, 'superseded resource_grants was dropped (must be held per the compatibility rule)');

    // Migration 079 (task 8be358d2) ships the Phase object: the grouping
    // layer between Project and Task, plus the Goal property at both
    // altitudes. Schema only — a deployment's Phases are its own content.
    const phasesReg = await q("SELECT to_regclass('public.phases') AS r");
    assert.ok(phasesReg[0].r, 'phases table missing after replay (migration 079)');
    const phaseSeeds = await q('SELECT count(*)::int AS n FROM phases');
    assert.equal(phaseSeeds[0].n, 0, 'migration 079 must not seed phase rows');
    // Index names are schema-wide (the 078/a6811c12 lesson): assert each new
    // index landed ON THE RIGHT TABLE, not merely that the name exists.
    const phaseIndexes = (await q("SELECT indexname FROM pg_indexes WHERE tablename = 'phases'")).map((r) => r.indexname);
    assert.ok(phaseIndexes.includes('ix_phases_project_order'), 'phases ordering index missing (079 — name collision?)');
    const taskIndexes = (await q("SELECT indexname FROM pg_indexes WHERE tablename = 'tasks'")).map((r) => r.indexname);
    assert.ok(taskIndexes.includes('ix_tasks_phase'), 'tasks phase index missing (079 — name collision?)');
    const phaseCol = await q(
      "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'phase_id'",
    );
    assert.equal(phaseCol[0].n, 1, 'tasks.phase_id missing after replay (079)');
    const goalCol = await q(
      "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'goal'",
    );
    assert.equal(goalCol[0].n, 1, 'projects.goal missing after replay (079)');
    // The Project/Phase consistency invariant is a DATABASE fact, not a
    // service-layer promise: the composite FK plus the CHECK that closes
    // MATCH SIMPLE's null hole.
    const phaseConstraints = (await q(
      "SELECT conname FROM pg_constraint WHERE conrelid = 'public.tasks'::regclass",
    )).map((r) => r.conname);
    assert.ok(phaseConstraints.includes('tasks_phase_project_fk'), 'composite phase/project FK missing (079)');
    assert.ok(phaseConstraints.includes('tasks_phase_requires_project'), 'phase-requires-project CHECK missing (079)');
    const phaseUnique = await q(
      "SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'public.phases'::regclass AND contype = 'u'",
    );
    assert.ok(phaseUnique[0].n >= 1, 'phases (id, project_id) uniqueness missing — the composite FK target (079)');

    // 080/081 finish the presentation chain: principal preferences and the
    // deployment Appearance singleton/history/asset store.
    for (const table of ['principal_preferences', 'appearances', 'appearance_versions', 'appearance_assets']) {
      const reg = await q(`SELECT to_regclass('public.${table}') AS r`);
      assert.ok(reg[0].r, `${table} missing after replay (080/081)`);
    }
    const appearanceSeeds = await q('SELECT count(*)::int AS n FROM appearances');
    assert.equal(appearanceSeeds[0].n, 0, 'migration 081 must not seed deployment identity');
    const oneActiveIndex = await q(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'appearance_assets' AND indexname = 'idx_appearance_assets_one_active_per_kind'",
    );
    assert.equal(oneActiveIndex.length, 1, 'active-asset uniqueness index missing (081)');
    assert.match(oneActiveIndex[0].indexdef, /WHERE active/i, 'active-asset uniqueness is not partial');

    const ledger = await q("SELECT count(*)::int AS n FROM schema_migrations WHERE name ~ '^(069|070|071|072|073|074|075|076|077|078|079|080|081)' ");
    assert.equal(ledger[0].n, 13, '069-081 not recorded in the ledger');

    // Forward cleanup must preserve real upgrades, including revoked
    // credentials and actor-handle history that has no principal FK.
    const cleanup = fs.readFileSync(path.resolve(__dirname, '../src/migrations/131_pristine_install_identity_cleanup.sql'), 'utf8');
    const seedSql = fs.readFileSync(path.resolve(__dirname, '../src/migrations/062_identity_substrate.sql'), 'utf8');
    const values = seedSql.split('INSERT INTO principals (kind, handle, display_name, role, harness) VALUES')[1].split('ON CONFLICT')[0].trim();
    const fixtures = `INSERT INTO principals (kind, handle, display_name, role, harness, legacy_identity, status, metadata, purpose)
      SELECT kind, handle, display_name, role, harness, kind = 'agent', 'disabled',
        '{"compatibility":true,"hidden_until_configured":true}'::jsonb,
        CASE WHEN kind = 'service' THEN 'LEGACY - pending owner review' ELSE NULL END
      FROM (VALUES ${values}) AS seeds(kind, handle, display_name, role, harness)
      WHERE handle NOT IN ('system','dashboard_user');
      INSERT INTO resource_grants (resource_type,resource_id,grantee_principal_id,permission,granted_by_principal_id)
      SELECT 'report','*',r.id,'read',o.id FROM principals r, principals o
      WHERE r.handle='reports_reader' AND o.handle='dashboard_user';
      INSERT INTO grants (grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id)
      SELECT 'principal',r.id,'report',NULL,'read',o.id FROM principals r, principals o
      WHERE r.handle='reports_reader' AND o.handle='dashboard_user';
      INSERT INTO bot_status(mood,status_text,author,author_harness,run_type)
      VALUES ('neutral','Ready for work','system','unknown','legacy');`;
    const cases = [
      ['pristine', '', false],
      ['administrator', "INSERT INTO principals(kind,handle,role) VALUES ('human','fresh-admin','admin')", true],
      ['revoked credential', `INSERT INTO principal_credentials(principal_id,credential_type,secret_hash,revoked_at)
        SELECT id,'password','test-only',NOW() FROM principals WHERE handle='reports_reader'`, true],
      ['custom purpose', "UPDATE principals SET purpose='Owner configured purpose' WHERE handle='reports_reader'", true],
      ['custom display', "UPDATE principals SET display_name='Configured reader' WHERE handle='reports_reader'", true],
      ['configured metadata', "UPDATE principals SET metadata=metadata || '{\"configured\":true}'::jsonb WHERE handle='reports_reader'", true],
      ['modified status', "UPDATE bot_status SET status_text='Owner status'", true],
      ['actor-handle history', "UPDATE bot_status SET author='reports_reader'", true],
      ['unknown populated table', "CREATE TABLE future_history(actor_handle text); INSERT INTO future_history VALUES ('reports_reader')", true],
      ['seed-table text identity', `UPDATE service_descriptor_versions SET created_by_principal_id=
        (SELECT id FROM principals WHERE handle='reports_reader')`, true],
      ['seed-table foreign key', `UPDATE access_profiles SET created_by_principal_id=
        (SELECT id FROM principals WHERE handle='reports_reader')`, true],
      ['extra canonical verb', `INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id)
        SELECT grantee_type,grantee_id,resource_type,resource_id,'write',granted_by_principal_id FROM grants`, true],
      ['extra canonical resource', `INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id)
        SELECT grantee_type,grantee_id,'task',resource_id,verb,granted_by_principal_id FROM grants`, true],
      ['superseded expiry', "UPDATE resource_grants SET expires_at=NOW()+INTERVAL '1 day'", true],
      ['changed authority', "UPDATE grants SET granted_by_principal_id=NULL", true],
    ];
    for (const [name, mutation, preserve] of cases) {
      await client.query('BEGIN');
      try {
        await client.query(fixtures);
        if (mutation) await client.query(mutation);
        const before = {};
        for (const table of ['principals','grants','resource_grants','bot_status']) {
          before[table] = await q(`SELECT * FROM ${table} ORDER BY id`);
        }
        await client.query(cleanup);
        if (preserve) {
          for (const table of Object.keys(before)) {
            assert.deepEqual(await q(`SELECT * FROM ${table} ORDER BY id`), before[table],
              `131 ${name}: every ${table} field must remain unchanged`);
          }
        }
        assert.equal((await q("SELECT count(*)::int AS n FROM principals WHERE metadata->>'compatibility'='true'"))[0].n,
          preserve ? 8 : 0, `131 ${name}: identities`);
        assert.equal((await q('SELECT count(*)::int AS n FROM grants'))[0].n, preserve ? before.grants.length : 0, `131 ${name}: grants`);
        assert.equal((await q('SELECT count(*)::int AS n FROM resource_grants'))[0].n, preserve ? 1 : 0, `131 ${name}: historical grants`);
        assert.equal((await q('SELECT count(*)::int AS n FROM bot_status'))[0].n, preserve ? 1 : 0, `131 ${name}: status seed`);
        console.log(`131 preservation case PASS: ${name}`);
      } finally { await client.query('ROLLBACK'); }
    }
    await client.query(cleanup); // Idempotent on the already-clean installation.
    console.log(`131 preservation proof: ${cases.length} isolated transaction cases PASS`);

    console.log('fresh-install replay proof: baseline=APPLIED chain=EXECUTED personality-schema=PASS skills-schema=PASS appearance-schema=PASS seeds=PASS ledger=PASS');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
