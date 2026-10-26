#!/usr/bin/env npx tsx
/**
 * Migration 163 against a REAL PostgreSQL (RH-TW1b slice 1, card `dac2ca71`):
 * the predecessor CHECK is replaced only when it is matched EXACTLY, and every
 * other estate is refused with a named error — never "repaired" by guessing.
 *
 * TW1b candidate A's migration 118 chose its victim three ways and was wrong
 * three times (evidence `aec6ab9f` §13–14): by generated NAME, by definition
 * SUBSTRING, and by column DEPENDENCY, the last of which dropped an operator's
 * independent policy check on the same column and reported success. Each of
 * those estates is built here, in its own throwaway schema, and the outcome
 * measured in the catalog:
 *
 *   1. migration 112 as shipped         → replaced; the new vocabulary admits the
 *                                         OTLP surfaces and still refuses junk;
 *   2. the same, applied a second time  → a no-op (replay-safe);
 *   3. the predecessor RENAMED          → replaced (matched by definition);
 *   4. an INDEPENDENT check on surface  → replaced, and the independent check
 *                                         SURVIVES (the M4-R3 counterexample);
 *   5. a predecessor that DIFFERS       → RAISES; nothing is dropped;
 *   6. TWO copies of the predecessor    → RAISES; nothing is dropped.
 *
 * DESTRUCTIVE-BY-POINTING WARNING: this applies migration SQL to whatever
 * database DB_HOST/DB_NAME name. Point it at a DISPOSABLE database only. Every
 * schema it creates is dropped in a finally block.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';

const migrationsDir = path.resolve(__dirname, '../src/migrations');
const m112 = fs.readFileSync(path.join(migrationsDir, '112_telemetry_receiver_limits.sql'), 'utf8');
const m163 = fs.readFileSync(path.join(migrationsDir, '163_telemetry_otlp_rate_surfaces.sql'), 'utf8');

const database = process.env.DB_NAME || 'relayhall_dev';
if (['relayhall_dev', 'relayhall_tst', 'relayhall_prod', 'relayhall'].includes(database)) {
  throw new Error(`DB_NAME names a deployment database (${database}); point this drill at a disposable one`);
}
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'relayhall_dev',
  password: process.env.DB_PASSWORD,
  database,
  max: 1,
});

const run = `${process.pid}_${Date.now()}`;
let facts = 0;
function fact(label: string): void { facts += 1; console.log(`  ✓ ${label}`); }

async function inSchema<T>(name: string, body: (q: (sql: string, params?: unknown[]) => Promise<any>) => Promise<T>): Promise<T> {
  const schema = `otlp163_${name}_${run}`;
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query('CREATE TABLE principals (id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
    await client.query(m112);
    return await body((sql, params) => client.query(sql, params));
  } finally {
    await client.query(`SET search_path TO public`).catch(() => undefined);
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    client.release();
  }
}

type Q = (sql: string, params?: unknown[]) => Promise<any>;

/** What a real PostgreSQL renders for migration 112's surface CHECK, and for 163's. */
const PREDECESSOR = "CHECK ((surface = ANY (ARRAY['frames'::text, 'events'::text, 'events_batch'::text])))";
const SUCCESSOR = "CHECK ((surface = ANY (ARRAY['frames'::text, 'events'::text, 'events_batch'::text, "
  + "'otlp_traces'::text, 'otlp_logs'::text, 'otlp_metrics'::text])))";

/** Every CHECK on the table, name and rendered definition. */
async function checks(q: Q): Promise<Array<{ name: string; def: string }>> {
  const result = await q(
    `SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'telemetry_rate_limits'::regclass AND contype = 'c' ORDER BY conname`);
  return result.rows;
}
const without = (all: Array<{ name: string; def: string }>, def: string) => all.filter((c) => c.def !== def);

async function admits(q: Q, surface: string): Promise<boolean> {
  const principal = (await q('INSERT INTO principals DEFAULT VALUES RETURNING id')).rows[0].id;
  try {
    await q('SAVEPOINT probe');
    await q(`INSERT INTO telemetry_rate_limits (principal_id, surface, last_accepted_at) VALUES ($1, $2, now())`, [principal, surface]);
    await q('RELEASE SAVEPOINT probe');
    return true;
  } catch {
    await q('ROLLBACK TO SAVEPOINT probe');
    return false;
  }
}

async function applyExpectingFailure(q: Q): Promise<string> {
  try {
    await q('BEGIN');
    await q(m163);
    await q('COMMIT');
  } catch (err) {
    await q('ROLLBACK');
    return (err as Error).message;
  }
  throw new Error('migration 163 succeeded on an estate it must refuse');
}

async function main(): Promise<void> {
  console.log('migration 163 — exact-predecessor drill against a real PostgreSQL');

  await inSchema('plain', async (q) => {
    const before = await checks(q);
    assert.equal(before.filter((c) => c.def === PREDECESSOR).length, 1,
      'PostgreSQL renders migration 112\'s surface CHECK exactly as migration 163 names it');
    await q('BEGIN'); await q(m163); await q('COMMIT');
    const after = await checks(q);
    assert.deepEqual(without(after, SUCCESSOR), without(before, PREDECESSOR), 'every other CHECK is untouched');
    assert.equal(after.filter((c) => c.def === SUCCESSOR).length, 1);
    assert.equal(after.filter((c) => c.def === PREDECESSOR).length, 0);
    fact('112 as shipped: the predecessor is replaced and the two count CHECKs are untouched');
    await q('BEGIN');
    for (const surface of ['frames', 'events', 'events_batch', 'otlp_traces', 'otlp_logs', 'otlp_metrics']) {
      assert.equal(await admits(q, surface), true, `${surface} must be admitted`);
    }
    assert.equal(await admits(q, 'otlp_profiles'), false, 'an unknown surface must still be refused');
    await q('ROLLBACK');
    fact('the six surfaces are admitted and an unknown one is still refused');
    await q('BEGIN'); await q(m163); await q('COMMIT');
    assert.deepEqual(await checks(q), after);
    fact('applied a second time: a no-op, the catalog unchanged');
  });

  await inSchema('renamed', async (q) => {
    const predecessor = (await checks(q)).find((c) => c.def === PREDECESSOR)!;
    await q(`ALTER TABLE telemetry_rate_limits RENAME CONSTRAINT ${predecessor.name} TO some_operator_name`);
    const before = await checks(q);
    await q('BEGIN'); await q(m163); await q('COMMIT');
    const after = await checks(q);
    assert.deepEqual(without(after, SUCCESSOR), without(before, PREDECESSOR));
    assert.deepEqual(after.filter((c) => c.def === SUCCESSOR).map((c) => c.name), ['telemetry_rate_limits_surface_check']);
    assert.equal(after.some((c) => c.name === 'some_operator_name'), false);
    fact('a RENAMED predecessor is matched by its definition and replaced, never left beside the new one');
  });

  await inSchema('independent', async (q) => {
    await q(`ALTER TABLE telemetry_rate_limits ADD CONSTRAINT surface_policy CHECK (surface <> 'events_batch')`);
    const before = await checks(q);
    await q('BEGIN'); await q(m163); await q('COMMIT');
    const after = await checks(q);
    assert.deepEqual(without(after, SUCCESSOR), without(before, PREDECESSOR));
    assert.ok(after.some((c) => c.name === 'surface_policy'), 'the independent check must survive');
    await q('BEGIN');
    assert.equal(await admits(q, 'events_batch'), false, 'the independent policy check must still hold');
    assert.equal(await admits(q, 'otlp_logs'), true);
    await q('ROLLBACK');
    fact('an INDEPENDENT check on surface SURVIVES and still holds (the M4-R3 counterexample)');
  });

  await inSchema('differs', async (q) => {
    const predecessor = (await checks(q)).find((c) => c.def === PREDECESSOR)!;
    await q(`ALTER TABLE telemetry_rate_limits DROP CONSTRAINT ${predecessor.name}`);
    await q(`ALTER TABLE telemetry_rate_limits ADD CONSTRAINT local_surfaces CHECK (surface IN ('frames', 'events'))`);
    const before = await checks(q);
    const message = await applyExpectingFailure(q);
    assert.match(message, /^163: expected exactly one CHECK/);
    assert.deepEqual(await checks(q), before);
    fact(`a predecessor that DIFFERS is refused by name and nothing is dropped: "${message.slice(0, 60)}..."`);
  });

  await inSchema('twice', async (q) => {
    await q(`ALTER TABLE telemetry_rate_limits ADD CONSTRAINT second_copy CHECK (surface IN ('frames', 'events', 'events_batch'))`);
    const before = await checks(q);
    assert.equal(before.filter((c) => c.def === PREDECESSOR).length, 2);
    const message = await applyExpectingFailure(q);
    assert.match(message, /found 2 and 0/);
    assert.deepEqual(await checks(q), before);
    fact('TWO copies of the predecessor are refused rather than one being picked; nothing is dropped');
  });

  console.log(`migration 163 drill: ${facts} measured facts, PASSED`);
}

main()
  .catch((err) => { console.error('migration 163 drill FAILED:', err); process.exitCode = 1; })
  .finally(() => pool.end());
