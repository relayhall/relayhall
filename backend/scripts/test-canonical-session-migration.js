#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const migration = fs.readFileSync(path.resolve(__dirname, '../src/migrations/055_canonical_session_foundation.sql'), 'utf8');
const schema = `canonical_session_probe_${process.pid}_${Date.now()}`;
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
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema}, public`);
    await client.query(`
      CREATE TABLE tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE subtasks (task_id uuid NOT NULL REFERENCES tasks(id), "index" integer NOT NULL, PRIMARY KEY(task_id,"index"));
      CREATE TABLE projects (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE agent_types (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    `);
    await client.query(migration);
    // Replaying the additive migration must be harmless.
    await client.query(migration);

    const attempt = await client.query(`INSERT INTO session_attempts
      (harness,runtime_kind,first_observed_at,identity_confidence,identity_reason,created_by_adapter)
      VALUES ('hermes','hermes_chat',NOW(),'authoritative','probe','probe@1') RETURNING attempt_id`);
    const attemptId = attempt.rows[0].attempt_id;
    await client.query(`INSERT INTO session_events
      (attempt_id,source,source_instance,stream_generation,event_kind,payload,payload_hash,redaction_policy_version,idempotency_key)
      VALUES ($1,'hermes_sqlite','probe','generation:1','message','{"content":"redacted"}',repeat('a',64),'probe-v1','probe:event:1')`, [attemptId]);
    await client.query(`INSERT INTO session_ingestion_cursors
      (source,source_instance,stream_generation,cursor_position,cursor_value,source_checksum)
      VALUES ('hermes_sqlite','probe','generation:1',1,'message:1',repeat('b',64))`);
    await client.query(`INSERT INTO session_adapter_health
      (source,source_instance,adapter_version,status,last_source_at,last_success_at,checked_at,safe_details)
      VALUES ('hermes_sqlite','probe','1.0.0','healthy',NOW(),NOW(),NOW(),'{"eventsInserted":1}')`);
    const run = await client.query(`INSERT INTO session_backfill_runs
      (algorithm_version,source,source_instance,source_window,source_window_hash,status,fencing_token)
      VALUES ('probe-v1','hermes_sqlite','probe','{}',repeat('c',64),'completed',1) RETURNING run_id`);
    await client.query(`INSERT INTO session_backfill_receipts
      (run_id,batch_key,source_checksum,output_checksum,scanned_count,inserted_count,duplicate_count,quarantined_count,gap_count,cursor_after)
      VALUES ($1,'batch:1',repeat('d',64),repeat('e',64),1,1,0,0,0,'{"position":1}')`, [run.rows[0].run_id]);

    const proof = await client.query(`SELECT
      (SELECT count(*)::int FROM session_attempts) attempts,
      (SELECT count(*)::int FROM session_events) events,
      (SELECT count(*)::int FROM session_ingestion_cursors) cursors,
      (SELECT count(*)::int FROM session_adapter_health) health_rows,
      (SELECT count(*)::int FROM session_backfill_receipts) backfill_receipts`);
    assert.deepEqual(proof.rows[0], { attempts: 1, events: 1, cursors: 1, health_rows: 1, backfill_receipts: 1 });

    await client.query('ROLLBACK');
    const rolledBack = await client.query('SELECT to_regnamespace($1) AS namespace', [schema]);
    assert.equal(rolledBack.rows[0].namespace, null, 'transaction rollback must remove the probe schema');
    console.log('canonical session migration proof: apply=PASS replay=PASS fixture/backfill=PASS rollback=PASS');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
