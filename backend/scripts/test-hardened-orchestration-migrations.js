#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');

const backendDir = path.resolve(__dirname, '..');
const initSql = fs.readFileSync(path.resolve(backendDir, '../database/init.sql'), 'utf8');
const baseConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'relayhall_dev',
  password: process.env.DB_PASSWORD || 'dev_password_change_me',
};
const suffix = `${process.pid}_${Date.now()}`;
const databases = [`relayhall_hardened_upgrade_${suffix}`, `relayhall_hardened_fresh_${suffix}`];

function quoteIdent(value) {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error(`unsafe database identifier: ${value}`);
  return `"${value}"`;
}

async function withPool(database, fn) {
  const pool = new Pool({ ...baseConfig, database });
  try { return await fn(pool); } finally { await pool.end(); }
}

function runRealMigration(database) {
  const result = spawnSync(
    process.execPath,
    [path.resolve(backendDir, 'node_modules/ts-node/dist/bin.js'), path.resolve(backendDir, 'src/db/migrate.ts')],
    { cwd: backendDir, env: { ...process.env, ...baseConfig, DB_NAME: database }, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`real migration runner failed for ${database}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return result.stdout;
}

async function assertRepairedSchema(database, expectedLegacyRows) {
  await withPool(database, async (pool) => {
    const columns = await pool.query(`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='task_review_attempts'
        AND column_name IN ('review_slice_version','review_slice_hash','review_slice','implementation_receipt_hash')
      ORDER BY column_name`);
    assert.equal(columns.rowCount, 4);
    for (const row of columns.rows) assert.equal(row.is_nullable, 'NO', `${row.column_name} must be NOT NULL`);
    assert.match(columns.rows.find(r => r.column_name === 'review_slice_version').column_default, /1/);

    const constraints = await pool.query(`
      SELECT conname, convalidated
      FROM pg_constraint
      WHERE conrelid='public.task_review_attempts'::regclass
        AND conname LIKE 'task_review_attempts_review_slice%'
      ORDER BY conname`);
    const names = new Set(constraints.rows.map(r => r.conname));
    for (const name of [
      'task_review_attempts_review_slice_version_supported',
      'task_review_attempts_review_slice_hash_sha256',
      'task_review_attempts_review_slice_nonempty_array',
      'task_review_attempts_review_slice_schema',
    ]) assert(names.has(name), `missing ${name}`);
    assert(constraints.rows.every(r => r.convalidated), 'review-slice constraints must be validated');

    const retries = await pool.query(`
      SELECT is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='tasks' AND column_name='max_retries'`);
    assert.equal(retries.rows[0].is_nullable, 'NO');
    assert.match(retries.rows[0].column_default, /3/);
    const retriesConstraint = await pool.query(`
      SELECT convalidated FROM pg_constraint
      WHERE conrelid='public.tasks'::regclass AND conname='tasks_max_retries_bounded'`);
    assert.equal(retriesConstraint.rows[0].convalidated, true);

    const ledger = await pool.query(`
      SELECT name, count(*)::int AS n FROM schema_migrations
      WHERE name IN ('051_task_reviewer_fields.sql','052_hardened_orchestration.sql','053_hardened_orchestration_upgrade.sql','054_task_notification_payload.sql')
      GROUP BY name ORDER BY name`);
    assert.deepEqual(ledger.rows.map(r => [r.name, r.n]), [
      ['051_task_reviewer_fields.sql', 1],
      ['052_hardened_orchestration.sql', 1],
      ['053_hardened_orchestration_upgrade.sql', 1],
      ['054_task_notification_payload.sql', 1],
    ]);

    const notificationPayload = await pool.query(`
      SELECT is_nullable, column_default FROM information_schema.columns
       WHERE table_schema='public' AND table_name='task_notification_deliveries' AND column_name='payload'`);
    assert.equal(notificationPayload.rowCount, 1, 'notification retry payload column must exist');
    assert.equal(notificationPayload.rows[0].is_nullable, 'NO');

    const legacy = await pool.query(`
      SELECT review_slice_version, review_slice->0->>'kind' AS kind,
             length(review_slice_hash) AS slice_hash_len,
             length(implementation_receipt_hash) AS receipt_hash_len
      FROM task_review_attempts WHERE review_slice_version=0`);
    assert.equal(legacy.rowCount, expectedLegacyRows);
    if (expectedLegacyRows) {
      assert.equal(legacy.rows[0].kind, 'legacy_review_attempt');
      assert.equal(legacy.rows[0].slice_hash_len, 64);
      assert.equal(legacy.rows[0].receipt_hash_len, 64);
    }

    let candidateTask = await pool.query(`SELECT id, updated_at FROM tasks ORDER BY created_at LIMIT 1`);
    if (candidateTask.rowCount === 0) {
      candidateTask = await pool.query(`INSERT INTO tasks (title, status) VALUES ('fresh constraint fixture','review') RETURNING id,updated_at`);
    }
    assert.equal(candidateTask.rowCount, 1, 'fixture database must contain a task for constraint probes');
    for (const invalidMaxRetries of [0, 11]) {
      await assert.rejects(
        pool.query(
          `INSERT INTO tasks (title, status, max_retries)
           VALUES ($1, 'todo', $2)`,
          [`invalid max_retries insert ${invalidMaxRetries}`, invalidMaxRetries],
        ),
        /violates check constraint "tasks_max_retries_bounded"/,
        `INSERT must reject max_retries=${invalidMaxRetries}`,
      );
      await assert.rejects(
        pool.query(`UPDATE tasks SET max_retries=$1 WHERE id=$2`, [invalidMaxRetries, candidateTask.rows[0].id]),
        /violates check constraint "tasks_max_retries_bounded"/,
        `UPDATE must reject max_retries=${invalidMaxRetries}`,
      );
    }
    const invalidShape = await pool.query(`SELECT task_review_slice_matches_version(1::smallint, '[{"kind":"legacy_review_attempt"}]'::jsonb) AS valid`);
    assert.equal(invalidShape.rows[0].valid, false, 'legacy shape must not satisfy canonical v1');
    await assert.rejects(
      pool.query(`INSERT INTO task_review_attempts
        (task_id, attempt_no, status, task_snapshot_updated_at, review_slice_version,
         review_slice_hash, review_slice, implementation_receipt_hash, idempotency_key)
       VALUES ($1,99,'pending',$2,1,repeat('a',64),
              '[{"kind":"legacy_review_attempt"}]'::jsonb,repeat('b',64),'invalid-v1-shape')`,
        [candidateTask.rows[0].id, candidateTask.rows[0].updated_at]),
      /violates check constraint/,
    );
  });
}

async function assertConcurrentClaimCapacity(database) {
  // Import the real TypeScript service after pointing its otherwise-unused
  // default pool at the disposable database. The exercised service receives
  // the explicit pool below; closing the imported default avoids open handles.
  process.env.DB_NAME = database;
  require('ts-node/register/transpile-only');
  const serviceModule = require('../src/services/TaskOrchestrationService');
  const connectionModule = require('../src/db/connection');
  await withPool(database, async (pool) => {
    const project = await pool.query(
      `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
      [`claim-race-${suffix}`],
    );
    const tasks = await pool.query(`
      INSERT INTO tasks (title, status, project_id, auto_start, execution_profile)
      VALUES
        ('concurrent claim A', 'todo', $1, true, '{"harness":"hermes","mode":"subagent"}'::jsonb),
        ('concurrent claim B', 'todo', $1, true, '{"harness":"hermes","mode":"subagent"}'::jsonb)
      RETURNING id, updated_at`, [project.rows[0].id]);
    const service = new serviceModule.TaskOrchestrationService(pool, {
      enabled: true,
      maxActiveGlobal: 1,
      maxActivePerProject: 1,
      leaseTtlSeconds: 900,
    });
    const claims = tasks.rows.map((task, index) => service.claimReadyTask({
      taskId: task.id,
      snapshotUpdatedAt: task.updated_at.toISOString(),
      harness: 'hermes',
      resourceKey: `claim-race-resource-${index}`,
    }));
    const settled = await Promise.allSettled(claims);
    const claimSummary = settled.map(result => result.status === 'fulfilled'
      ? 'fulfilled'
      : `rejected:${result.reason?.code || result.reason?.message || String(result.reason)}`);
    assert.equal(
      settled.filter(result => result.status === 'fulfilled').length,
      1,
      `exactly one concurrent claim may acquire the global capacity slot (${claimSummary.join(', ')})`,
    );
    const rejected = settled.find(result => result.status === 'rejected');
    assert(rejected, 'one concurrent claim must be rejected');
    assert.equal(rejected.reason.code, 'GLOBAL_CAPACITY_EXHAUSTED');
    const leases = await pool.query(
      `SELECT count(*)::int AS n FROM task_execution_leases WHERE status='active'`,
    );
    assert.equal(leases.rows[0].n, 1, 'database must retain only one active lease');
    const activeTasks = await pool.query(
      `SELECT count(*)::int AS n FROM tasks WHERE id=ANY($1::uuid[]) AND status='in-progress'`,
      [tasks.rows.map(row => row.id)],
    );
    assert.equal(activeTasks.rows[0].n, 1, 'only the successfully leased task may advance');
  });
  await connectionModule.pool.end();
}

async function assertDbBackedReviewVerdict(database) {
  process.env.DB_NAME = database;
  require('ts-node/register/transpile-only');
  const { TaskReviewAttemptService } = require('../src/services/TaskReviewAttemptService');
  await withPool(database, async (pool) => {
    const taskRow = await pool.query(`
      INSERT INTO tasks (title, status, auto_start, max_retries, notes)
      VALUES ('review race proof', 'review', false, 2, 'commit 0123456789012345678901234567890123456789')
      RETURNING id, updated_at`);
    const taskId = taskRow.rows[0].id;
    await pool.query(`
      INSERT INTO subtasks (task_id, index, title, status, note)
      VALUES ($1,0,'accepted prerequisite','completed','accepted'),
             ($1,1,'reviewed slice','review','commit 0123456789012345678901234567890123456789'),
             ($1,2,'future slice','empty',NULL)`, [taskId]);
    const task = {
      id: taskId,
      title: 'review race proof',
      status: 'review',
      priority: 'normal',
      description: '',
      subtasks: [
        { id: '0', text: 'accepted prerequisite', status: 'completed' },
        { id: '1', text: 'reviewed slice', status: 'review', reviewNote: 'commit 0123456789012345678901234567890123456789' },
        { id: '2', text: 'future slice', status: 'empty' },
      ],
      links: [], tags: [], blockedBy: [], autoCreated: false, autoStart: false,
      created: taskRow.rows[0].updated_at.toISOString(),
      updated: taskRow.rows[0].updated_at.toISOString(),
      attemptCount: 0,
      maxRetries: 2,
      notes: 'commit 0123456789012345678901234567890123456789',
    };
    const service = new TaskReviewAttemptService(pool, 300000);
    const attempt = await service.beginAttempt(task, { command: 'focused tests passed' });
    assert.equal(attempt.reviewSlice.length, 1, 'later empty work is outside the contiguous review slice');
    const verdicts = await Promise.all([
      service.recordVerdict(attempt.id, 'reject', [{ message: 'repair exact slice' }], { reviewer: 'A' }),
      service.recordVerdict(attempt.id, 'reject', [{ message: 'duplicate delayed verdict' }], { reviewer: 'B' }),
    ]);
    assert.equal(verdicts.filter(result => result.applied).length, 1, 'duplicate verdict mutates exactly once');
    const persisted = await pool.query('SELECT status, attempt_count FROM tasks WHERE id=$1', [taskId]);
    assert.deepEqual([persisted.rows[0].status, persisted.rows[0].attempt_count], ['todo', 1]);
    const subtasks = await pool.query('SELECT index,status FROM subtasks WHERE task_id=$1 ORDER BY index', [taskId]);
    assert.deepEqual(subtasks.rows.map(row => [row.index, row.status]), [[0,'completed'],[1,'empty'],[2,'empty']]);
    const attempts = await pool.query('SELECT count(*)::int AS n,status FROM task_review_attempts WHERE task_id=$1 GROUP BY status', [taskId]);
    assert.deepEqual([attempts.rows[0].n, attempts.rows[0].status], [1, 'rejected']);
  });
}

async function assertReceiptBackedNotificationRetry(database) {
  process.env.DB_NAME = database;
  require('ts-node/register/transpile-only');
  const { TaskNotificationService } = require('../src/services/TaskNotificationService');
  await withPool(database, async (pool) => {
    const task = await pool.query(`INSERT INTO tasks (title,status) VALUES ('notification retry proof','stuck') RETURNING id`);
    let calls = 0;
    const service = new TaskNotificationService(pool, async request => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('provider details remain private'), { code: 'ECONNRESET' });
      return {
        transport: 'discord',
        destinationId: request.destination,
        providerMessageId: 'provider-message-1',
        acknowledgedAt: new Date().toISOString(),
      };
    });
    const request = {
      taskId: task.rows[0].id,
      kind: 'review-escalation',
      stateVersion: 'attempt-3',
      destination: 'discord-thread-fixture',
      message: 'bounded review retries exhausted',
    };
    assert.equal((await service.deliver(request)).status, 'failed');
    await pool.query(`UPDATE task_notification_deliveries SET next_attempt_at=NOW()-INTERVAL '1 second' WHERE task_id=$1`, [task.rows[0].id]);
    assert.equal((await service.deliver(request)).status, 'sent');
    assert.equal((await service.deliver(request)).status, 'deduplicated');
    assert.equal(calls, 2, 'transport must run once for the failed attempt and once for the receipt-backed retry');
    const delivery = await pool.query(`SELECT status,attempt_count,receipt,last_error_code FROM task_notification_deliveries WHERE task_id=$1`, [task.rows[0].id]);
    assert.equal(delivery.rowCount, 1, 'stable idempotency key must retain exactly one delivery row');
    assert.equal(delivery.rows[0].status, 'sent');
    assert.equal(delivery.rows[0].attempt_count, 2);
    assert.equal(delivery.rows[0].receipt.providerMessageId, 'provider-message-1');
    assert.equal(delivery.rows[0].last_error_code, null);
  });
}

async function main() {
  const admin = new Pool({ ...baseConfig, database: process.env.DB_NAME || 'postgres' });
  try {
    for (const database of databases) await admin.query(`CREATE DATABASE ${quoteIdent(database)}`);

    const upgrade = databases[0];
    await withPool(upgrade, async (pool) => {
      await pool.query(initSql);
      await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
      await pool.query(`
        CREATE TABLE task_review_attempts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','passed','rejected','escalated','timed_out','cancelled')),
          task_snapshot_updated_at TIMESTAMPTZ NOT NULL,
          implementation_session_key TEXT,
          reviewer_session_key TEXT,
          implementation_commit TEXT,
          evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
          verdict JSONB,
          findings JSONB NOT NULL DEFAULT '[]'::jsonb,
          error_code TEXT,
          idempotency_key TEXT NOT NULL UNIQUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          started_at TIMESTAMPTZ,
          deadline_at TIMESTAMPTZ,
          finished_at TIMESTAMPTZ,
          UNIQUE(task_id, attempt_no)
        )`);
      const task = await pool.query(`INSERT INTO tasks (title, status) VALUES ('historical upgrade fixture','review') RETURNING id,updated_at`);
      await pool.query(`INSERT INTO task_review_attempts
        (task_id,attempt_no,status,task_snapshot_updated_at,implementation_session_key,implementation_commit,evidence,idempotency_key)
        VALUES ($1,1,'running',$2,'hermes:fixture','deadbeef','{"tests":"historical"}'::jsonb,'historical-attempt-1')`,
        [task.rows[0].id, task.rows[0].updated_at]);
      await pool.query(`INSERT INTO schema_migrations(name) VALUES ('051_task_reviewer_fields.sql'),('052_hardened_orchestration.sql') ON CONFLICT(name) DO NOTHING`);
      await pool.query(`ALTER TABLE tasks ALTER COLUMN max_retries DROP NOT NULL, ALTER COLUMN max_retries DROP DEFAULT`);
      await pool.query(`UPDATE tasks SET max_retries=NULL WHERE id=$1`, [task.rows[0].id]);
    });
    runRealMigration(upgrade);
    await assertRepairedSchema(upgrade, 1);
    const beforeReplay = await withPool(upgrade, p => p.query('SELECT count(*)::int AS n FROM schema_migrations').then(r => r.rows[0].n));
    const replayOutput = runRealMigration(upgrade);
    assert.match(replayOutput, /up to date/i);
    const afterReplay = await withPool(upgrade, p => p.query('SELECT count(*)::int AS n FROM schema_migrations').then(r => r.rows[0].n));
    assert.equal(afterReplay, beforeReplay, 'replay must not append ledger rows');

    const fresh = databases[1];
    await withPool(fresh, pool => pool.query(initSql));
    runRealMigration(fresh);
    await assertRepairedSchema(fresh, 0);
    await assertConcurrentClaimCapacity(fresh);
    await assertDbBackedReviewVerdict(fresh);
    await assertReceiptBackedNotificationRetry(fresh);

    console.log('PASS hardened orchestration migration proof: historical upgrade, fresh chain, replay, concurrent claim capacity, exactly-once review verdict, and receipt-backed notification retry');
  } finally {
    for (const database of databases) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [database]).catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`).catch(() => {});
    }
    await admin.end();
  }
}

main().catch(error => { console.error(error); process.exit(1); });
