#!/usr/bin/env npx tsx
/**
 * The TWO-CLIENT RACE that owner decision D6 requires, against a REAL
 * PostgreSQL (RH-TW1a candidate B, card `beac9c79`).
 *
 * This cannot be a jest test and it cannot use a double. The property under
 * test is that two SEPARATE CONNECTIONS attempting the same principal in the
 * same interval produce exactly ONE acceptance — and a double decides only
 * what it is told to, while a single connection cannot race itself. The shipped
 * `Map` the gate replaces would pass any single-process test ever written and
 * still let every worker accept its own frame.
 *
 * DESTRUCTIVE-BY-POINTING WARNING: this applies migration SQL to whatever
 * database DB_HOST/DB_NAME name. Point it at a DISPOSABLE database only — never
 * at the live ClawBoard database, never at TST, never at PROD.
 *
 * Everything runs in a throwaway schema. Because a race needs two real
 * connections that can SEE each other's committed rows, this script cannot hide
 * inside one rolled-back transaction like the migration probe does: it creates
 * the schema, commits, and DROPs it in a finally block.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import {
  TelemetryRateLimitService, TELEMETRY_MIN_INTERVAL_MS,
} from '../src/services/TelemetryRateLimitService';
import { TelemetryService } from '../src/services/TelemetryService';

const migrationsDir = path.resolve(__dirname, '../src/migrations');
const receiverLimits = fs.readFileSync(path.join(migrationsDir, '112_telemetry_receiver_limits.sql'), 'utf8');

const schema = `telemetry_limits_probe_${process.pid}_${Date.now()}`;
const connection = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'relayhall_dev',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'relayhall_dev',
};

// Review `63193024` R4-M1 — THREE BOUNDS, DELIBERATELY ORDERED.
//
// A `Promise.race` rejects the CALLER; it does not cancel the query. So a
// timer alone turns a hang into an abandoned query that still owns its pooled
// client — and `pool.end()`, which resolves only once `_clients` is empty
// (`pg-pool/index.js:119-136`), then hangs in the cleanup path of a probe
// whose assertions had already failed. The bounds below make that impossible,
// and their ORDER is the contract:
//
//   1. RED_PROOF_ASSERT_MS — the assertion timer fires FIRST, so a blocked
//      call is reported as a failed assertion at a predictable moment.
//   2. INGEST_ABORT_MS     — the SERVER-side abort fires NEXT, so the
//      abandoned query ends on its own and returns its client.
//   3. DRAIN_MS            — the drain bound fires LAST, so cleanup can never
//      outlive work that is already guaranteed to end.
//
// Each must be strictly larger than the one before it.
const RED_PROOF_ASSERT_MS = 3000;
const INGEST_ABORT_MS = 6000;
const DRAIN_MS = 15000;

/**
 * A pool pinned to the throwaway schema, so every client in it sees the table.
 *
 * `abortQueriesAfterMs` is what makes a BLOCKED query unwind rather than wait
 * forever: `pg` sends `statement_timeout` in the startup packet
 * (`pg/lib/client.js:486`), so the SERVER aborts the query, it rejects like any
 * other error, and the client goes back to the pool. `query_timeout` is the
 * client-side backstop for the case where the server never answers at all.
 */
function poolInSchema(max: number, abortQueriesAfterMs?: number): Pool {
  return new Pool({
    ...connection,
    max,
    options: `-c search_path=${schema},public`,
    ...(abortQueriesAfterMs === undefined ? {} : {
      statement_timeout: abortQueriesAfterMs,
      query_timeout: abortQueriesAfterMs + 1000,
    }),
  });
}

/**
 * `pool.end()` under a bound, as an ASSERTION rather than an await.
 *
 * R4-M1: every cleanup here used to be a bare `await pool.end()`. That resolves
 * only when every client is back, so one stuck query converted a probe that had
 * FAILED into a probe that hung — the worst possible failure mode for a control
 * whose entire job is to fail loudly. Draining is now a property under test.
 */
async function drain(label: string, pool: Pool, ms = DRAIN_MS): Promise<void> {
  let timer: NodeJS.Timeout;
  // Review `a6410ce2` round-5 NOTE: mapping a REJECTED `end()` to 'drained'
  // too would have made this prove BOUNDED settlement rather than SUCCESSFUL
  // settlement. The rejection is preserved, so a failed drain fails here.
  const ended = pool.end().then(() => 'drained' as const);
  const guard = new Promise<'stuck'>((resolve) => {
    timer = setTimeout(() => resolve('stuck'), ms);
  });
  try {
    assert.equal(await Promise.race([ended, guard]), 'drained',
      `${label} still held a client after ${ms}ms — a query was abandoned, not unwound`);
  } finally { clearTimeout(timer!); }
}

const admin = new Pool({ ...connection, max: 1 });

async function main(): Promise<void> {
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    await admin.query(`SET search_path TO ${schema}, public`);
    await admin.query(`CREATE TABLE ${schema}.principals (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`);
    await admin.query(`SET search_path TO ${schema}, public; ${receiverLimits}`);

    const principal = (await admin.query(
      `INSERT INTO ${schema}.principals DEFAULT VALUES RETURNING id`)).rows[0].id as string;
    const other = (await admin.query(
      `INSERT INTO ${schema}.principals DEFAULT VALUES RETURNING id`)).rows[0].id as string;

    // ---- THE RACE -------------------------------------------------------
    // Eight concurrent attempts on eight distinct connections, same principal,
    // same surface, same instant. Exactly one may win.
    const racers = poolInSchema(8);
    try {
      const service = new TelemetryRateLimitService(racers);
      const now = new Date();
      const decisions = await Promise.all(
        Array.from({ length: 8 }, () => service.tryAccept(principal, 'events', now)),
      );
      const accepted = decisions.filter((d) => d.accepted).length;
      assert.equal(accepted, 1,
        `exactly one concurrent attempt may be accepted; ${accepted} were. The gate is not atomic.`);
      assert.equal(decisions.length - accepted, 7, 'every other attempt must be refused');

      // The refusals were COUNTED, not silent (D6: bounded state with defined
      // cleanup, and an operator-visible signal).
      const row = (await admin.query(
        `SELECT accepted_count, refused_count FROM ${schema}.telemetry_rate_limits
          WHERE principal_id = $1 AND surface = 'events'`, [principal])).rows[0];
      assert.equal(Number(row.accepted_count), 1, 'one acceptance recorded');
      assert.equal(Number(row.refused_count), 7, 'seven refusals recorded');

      // ---- the interval actually elapses ------------------------------
      const later = new Date(now.getTime() + TELEMETRY_MIN_INTERVAL_MS.events + 1);
      const after = await service.tryAccept(principal, 'events', later);
      assert.equal(after.accepted, true, 'a write after the interval must be accepted');

      // …and the control for that: one millisecond too early is refused, so
      // the acceptance above is the interval elapsing and not the gate simply
      // accepting everything on a second call.
      const tooEarly = await service.tryAccept(
        principal, 'events', new Date(later.getTime() + TELEMETRY_MIN_INTERVAL_MS.events - 1));
      assert.equal(tooEarly.accepted, false, 'a write inside the interval must be refused');
      assert.ok(tooEarly.retryAfterMs > 0, 'a refusal must say how long to wait');

      // ---- separate principals do not share a budget -------------------
      const otherDecision = await service.tryAccept(other, 'events', later);
      assert.equal(otherDecision.accepted, true, 'a different principal must be unaffected');

      // ---- separate surfaces do not share a budget ---------------------
      const frames = await service.tryAccept(principal, 'frames', later);
      assert.equal(frames.accepted, true, 'frames and events are budgeted separately');

      // ---- the DRAIN BOUND is itself under test ------------------------
      // R4-M1 replaced every `await pool.end()` with `drain()`. A cleanup
      // bound that nothing ever exercises is precisely the kind of control
      // this review chain keeps finding holes in, so it gets a direct one:
      // a pool holding a query that CANNOT return must make `drain` throw
      // inside its bound instead of waiting on it. Without this the helper
      // would be assumed, not proven.
      const stuckPool = poolInSchema(1);
      const lockHolder = await racers.connect();
      try {
        await lockHolder.query('BEGIN');
        await lockHolder.query(
          `UPDATE telemetry_rate_limits SET refused_count = refused_count
            WHERE principal_id = $1 AND surface = 'events'`, [principal]);
        const blocked = stuckPool.query(
          `UPDATE telemetry_rate_limits SET refused_count = refused_count + 1
            WHERE principal_id = $1 AND surface = 'events'`, [principal]);
        void blocked.catch(() => undefined);
        await assert.rejects(() => drain('a deliberately stuck pool', stuckPool, 2000),
          /still held a client after 2000ms/,
          'drain() must FAIL on a pool whose client cannot come back — never wait for it');

        // …and a drain that REJECTS is not a drain either (the round-5 NOTE):
        // the pool is already ending, so pg-pool refuses the second `end()`,
        // and that rejection must reach the caller rather than read as success.
        await assert.rejects(() => drain('an already-ending pool', stuckPool, 2000),
          /more than once/,
          'a rejected pool.end() must surface, not be reported as a successful drain');
      } finally {
        // Releasing the lock lets the abandoned query finish, so the `end()`
        // already in flight inside `drain` settles and leaves no open handle.
        await lockHolder.query('ROLLBACK').catch(() => undefined);
        lockHolder.release();
      }

      // ---- THE PROOF R3-B1 NEEDED: drive `ingest` ITSELF ---------------
      //
      // Review `fc4829d2` R3-B1 was a HANG on the ordinary rate-limited path,
      // and every existing proof missed it for the same reason: the probe
      // exercised `tryAccept` directly (winning case inside a transaction,
      // refusing cases with no transaction), and the unit double shares one
      // lock-free function — a double cannot deadlock. So this case drives
      // `TelemetryService.ingest` itself: a committed frame, then an IMMEDIATE
      // refusal on the same key, under a BOUNDED TIMEOUT so a hang fails
      // loudly instead of stalling the run.
      const ingestPool = poolInSchema(4, INGEST_ABORT_MS);
      try {
        await admin.query(`CREATE TABLE IF NOT EXISTS ${schema}.telemetry_frames (
          id BIGSERIAL PRIMARY KEY,
          principal_id UUID NOT NULL REFERENCES ${schema}.principals(id) ON DELETE CASCADE,
          task_id UUID,
          kind TEXT NOT NULL,
          status TEXT,
          payload JSONB NOT NULL,
          received_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

        // BOTH must be injected: `TelemetryService`'s default limiter is the
        // module singleton bound to the DEFAULT pool, which knows nothing of
        // this throwaway schema. Passing only the pool sends the refusal
        // counter to the wrong connection.
        const service = new TelemetryService(
          ingestPool as never, new TelemetryRateLimitService(ingestPool));
        const framePrincipal = (await admin.query(
          `INSERT INTO ${schema}.principals DEFAULT VALUES RETURNING id`)).rows[0].id as string;

        const bounded = async <T>(label: string, work: Promise<T>, ms = 8000): Promise<T> => {
          let timer: NodeJS.Timeout;
          const guard = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} did not return within ${ms}ms — R3-B1 has returned`)), ms);
          });
          try { return await Promise.race([work, guard]); } finally { clearTimeout(timer!); }
        };

        const first = await bounded('first frame', service.ingest(framePrincipal, { kind: 'heartbeat' }));
        assert.equal(first.accepted, true, 'the first frame must be accepted');

        // The exact shape that hung: same principal, same surface, immediately.
        const second = await bounded('rate-limited frame', service.ingest(framePrincipal, { kind: 'heartbeat' }));
        assert.equal(second.accepted, false, 'the second frame inside the interval must be refused');
        assert.equal(second.accepted === false && second.code, 'RATE_LIMITED');

        const counters = (await admin.query(
          `SELECT accepted_count, refused_count FROM ${schema}.telemetry_rate_limits
            WHERE principal_id = $1 AND surface = 'frames'`, [framePrincipal])).rows[0];
        assert.equal(Number(counters.accepted_count), 1, 'exactly one acceptance recorded');
        assert.equal(Number(counters.refused_count), 1, 'exactly ONE refusal increment recorded');
        assert.equal(Number((await admin.query(
          `SELECT COUNT(*)::int AS n FROM ${schema}.telemetry_frames WHERE principal_id = $1`,
          [framePrincipal])).rows[0].n), 1, 'the refused frame stored nothing');

        // ---- F4 through `ingest`: a failed insert must not charge ------
        // A task_id that violates nothing here would not exercise it, so the
        // FK is made to fail with a task_id that cannot exist.
        await admin.query(`CREATE TABLE IF NOT EXISTS ${schema}.tasks (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid())`);
        await admin.query(`ALTER TABLE ${schema}.telemetry_frames
          ADD CONSTRAINT frames_task_fk FOREIGN KEY (task_id) REFERENCES ${schema}.tasks(id)`);
        const fkPrincipal = (await admin.query(
          `INSERT INTO ${schema}.principals DEFAULT VALUES RETURNING id`)).rows[0].id as string;
        const refusedByFk = await bounded('FK-refused frame', service.ingest(fkPrincipal, {
          kind: 'heartbeat', taskId: '00000000-0000-4000-8000-00000000dead',
        }));
        assert.equal(refusedByFk.accepted, false, 'an unknown Task must be refused');
        assert.equal(refusedByFk.accepted === false && refusedByFk.code, 'TASK_NOT_FOUND');
        assert.equal(Number((await admin.query(
          `SELECT COUNT(*)::int AS n FROM ${schema}.telemetry_rate_limits WHERE principal_id = $1`,
          [fkPrincipal])).rows[0].n), 0,
        'a frame the statement aborted must leave NO limiter row — the budget was never charged');
        // …and the corrected retry, immediately, is accepted.
        const corrected = await bounded('corrected retry', service.ingest(fkPrincipal, { kind: 'heartbeat' }));
        assert.equal(corrected.accepted, true, 'the immediate corrected retry must be accepted');

        // ---- RED PROOF 1: the ACTUAL ingest, blocked, must FAIL FAST ---
        //
        // Review `63193024` R4-M1: RED PROOF 2 below re-creates the R3-B1 wait
        // with a raw UPDATE, so it proves the LOCK SHAPE hangs — it never
        // proves anything about `ingest`. This one puts the REAL
        // `TelemetryService.ingest` into exactly that wait: a second connection
        // holds the limiter row in an open transaction, so the gate's
        // `ON CONFLICT` must queue behind it, which is precisely how R3-B1
        // stalled the ordinary rate-limited path.
        //
        // Three things are asserted that no synthetic control can reach: the
        // assertion timer fires INSIDE its bound; the abandoned ingest then
        // UNWINDS ITSELF rather than keeping its client forever; and the pool
        // is left with nothing checked out, which is the exact precondition
        // `pool.end()` needs in order to drain.
        const blockerPool = poolInSchema(1);
        const blocker = await blockerPool.connect();
        try {
          await blocker.query('BEGIN');
          // Locks the row without changing it — an UPDATE always writes a new
          // tuple version, so the gate's ON CONFLICT cannot proceed past it.
          await blocker.query(
            `UPDATE telemetry_rate_limits SET refused_count = refused_count
              WHERE principal_id = $1 AND surface = 'frames'`, [framePrincipal]);

          const stuck = service.ingest(framePrincipal, { kind: 'heartbeat' });
          void stuck.catch(() => undefined); // the race abandons it; do not die on the late rejection

          await assert.rejects(
            () => bounded('actual ingest behind a held limiter row', stuck, RED_PROOF_ASSERT_MS),
            /did not return within/,
            'a blocked `ingest` must be REPORTED by the assertion timer, not waited on');

          // …and the abandoned work must END. This is the whole of R4-M1: the
          // race rejected the caller, and nothing about that cancels the query.
          const settled = await bounded('the abandoned ingest unwinds itself',
            stuck.then(() => 'resolved' as const, () => 'rejected' as const), DRAIN_MS);
          assert.equal(settled, 'rejected',
            `the ${INGEST_ABORT_MS}ms server-side abort must end the blocked ingest so its client returns`);

          // The pool itself is the evidence: a client that never came back
          // would still be checked out here, and `end()` would hang on it.
          assert.equal(ingestPool.waitingCount, 0, 'nothing may still be queued for a client');
          assert.equal(ingestPool.idleCount, ingestPool.totalCount,
            'every client must be back in the pool — an abandoned query still holds one');
          await bounded('the ingest pool still serves', ingestPool.query('SELECT 1'), RED_PROOF_ASSERT_MS);
        } finally {
          await blocker.query('ROLLBACK').catch(() => undefined);
          blocker.release();
          await drain('the blocker pool', blockerPool);
        }

        // ---- RED PROOF 2: re-introduce the two-connection wait ---------
        // Exactly the shape R3-B1 described — the gate inside a transaction,
        // then the refusal counter on a SECOND connection against the same
        // row. It must TIME OUT; if it ever completes, this control has
        // stopped proving anything and the timeout above is meaningless.
        const victim = await ingestPool.connect();
        let deadlocked = false;
        try {
          await victim.query('BEGIN');
          await victim.query(
            `INSERT INTO telemetry_rate_limits (principal_id, surface, last_accepted_at, accepted_count)
                  VALUES ($1,'frames',NOW(),1)
             ON CONFLICT (principal_id, surface) DO UPDATE
                    SET last_accepted_at = EXCLUDED.last_accepted_at
                  WHERE telemetry_rate_limits.last_accepted_at <= NOW() - INTERVAL '1 hour'`,
            [framePrincipal]);
          await bounded('two-connection wait (must hang)', ingestPool.query(
            `UPDATE telemetry_rate_limits SET refused_count = refused_count + 1
              WHERE principal_id = $1 AND surface = 'frames'`, [framePrincipal]), RED_PROOF_ASSERT_MS);
        } catch (err) {
          deadlocked = /did not return within/.test((err as Error).message);
        } finally {
          await victim.query('ROLLBACK').catch(() => undefined);
          victim.release();
        }
        assert.equal(deadlocked, true,
          'the RED PROOF must hang: if a second connection can update the row while a transaction '
          + 'holds it, the bounded-timeout assertions above prove nothing');
      } finally {
        await drain('the ingest pool', ingestPool);
      }

      // ---- CHURN: many principals, bounded state -----------------------
      // D6 asks for a churn test. The point is that the table grows with the
      // number of reporting principals and not with the number of attempts.
      const churnPool = poolInSchema(4);
      try {
        const churn = new TelemetryRateLimitService(churnPool);
        const ids: string[] = [];
        for (let i = 0; i < 25; i += 1) {
          ids.push((await admin.query(
            `INSERT INTO ${schema}.principals DEFAULT VALUES RETURNING id`)).rows[0].id as string);
        }
        // Ten attempts each — 250 attempts, 25 principals.
        for (let attempt = 0; attempt < 10; attempt += 1) {
          await Promise.all(ids.map((id) => churn.tryAccept(id, 'events', later)));
        }
        const rows = Number((await admin.query(
          `SELECT COUNT(*)::int AS n FROM ${schema}.telemetry_rate_limits WHERE surface = 'events'`)).rows[0].n);
        assert.equal(rows, 25 + 2,
          `state must be bounded by PRINCIPALS, not attempts; found ${rows} rows for 250 attempts`);
      } finally {
        await drain('the churn pool', churnPool);
      }

      // ---- the retention sweep removes a principal that stopped --------
      await admin.query(
        `UPDATE ${schema}.telemetry_rate_limits SET last_accepted_at = now() - INTERVAL '48 hours'
          WHERE principal_id = $1`, [other]);
      await admin.query(
        `DELETE FROM ${schema}.telemetry_rate_limits WHERE last_accepted_at < now() - (24 * INTERVAL '1 hour')`);
      const survivors = Number((await admin.query(
        `SELECT COUNT(*)::int AS n FROM ${schema}.telemetry_rate_limits WHERE principal_id = $1`,
        [other])).rows[0].n);
      assert.equal(survivors, 0, 'rows untouched past the retention window must be pruned');
    } finally {
      await drain('the racer pool', racers);
    }

    console.log('PROBE_RESULT=PASS');
    console.log('✅ receiver-limit probe: 8 concurrent connections produced exactly ONE acceptance and 7 counted '
      + 'refusals; the interval elapses and its too-early control refuses; principals and surfaces are budgeted '
      + 'separately; `ingest` itself accepted then refused within the interval under a bounded timeout with exactly one refusal increment, an FK-aborted frame charged nothing and its corrected retry won; a REAL `ingest` blocked behind a held limiter row FAILED inside its assertion bound, then unwound itself and returned its client, and the red proof of the old two-connection wait still hangs; `drain` itself FAILS on a pool whose client cannot come back, and every pool here drained under that bound; 250 attempts across 25 principals left 25 rows; the retention sweep prunes.');
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await drain('the admin pool', admin);
  }
}

main().catch((err: Error) => {
  console.error('receiver-limit probe FAILED:', err.message);
  console.error((err.stack ?? '').split('\n').slice(0, 5).join('\n'));
  console.error('PROBE_RESULT=FAIL');
  process.exit(1);
});
