#!/usr/bin/env node
'use strict';

// Upgrade-path regression for migration 073 (task 102187c7; review 2be77033
// blocking finding). Proves, against a live PostgreSQL, that the Verifier
// rename touches ONLY the built-in seed row:
//
//   A. a NON-built-in personality that happens to own slug 'reviewer'
//      survives byte-for-byte when 073 re-runs;
//   B. a slug collision with an existing 'verifier' row makes 073 skip
//      explicitly, mutating nothing.
//
// Point DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME at a DISPOSABLE database:
// this script applies the full schema and every active migration to it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Pool } = require('pg');

const initSql = fs.readFileSync(path.resolve(__dirname, '../../database/init.sql'), 'utf8');
const migration073 = fs.readFileSync(
  path.resolve(__dirname, '../src/migrations/073_verifier_personality_rename.sql'), 'utf8');
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

    // Fresh chain: 065 seeds the built-in Reviewer, 073 renames it.
    await client.query(initSql);
    execFileSync('node', ['./node_modules/ts-node/dist/bin.js', 'src/db/migrate.ts'], {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit',
      env: process.env,
    });

    const row = async (slug) =>
      (await client.query('SELECT row_to_json(p) AS r FROM personalities p WHERE slug = $1', [slug])).rows[0]?.r;

    const builtinVerifier = await row('verifier');
    assert.ok(builtinVerifier, 'built-in verifier row missing after the chain');
    assert.equal(builtinVerifier.source, 'built-in', 'verifier row is not the built-in seed');

    // Scenario A: a managed row owning slug 'reviewer' must survive 073 re-runs.
    await client.query(
      `INSERT INTO personalities (slug, name, description, category, content, is_custom, source)
       VALUES ('reviewer', 'My Reviewer', 'User-managed profile that predates the rename.',
               'custom', '# Reviewer\n\nUser content that must never be rewritten.', true, 'managed')`
    );
    const managedBefore = await row('reviewer');
    await client.query(migration073);
    const managedAfter = await row('reviewer');
    assert.deepEqual(managedAfter, managedBefore,
      'migration 073 mutated a non-built-in reviewer-slug personality');
    assert.deepEqual(await row('verifier'), builtinVerifier,
      'migration 073 re-run mutated the already-renamed built-in row');

    // Scenario B: a verifier-slug collision must skip explicitly, mutating nothing.
    // Retain the earlier fixture and its immutable history while freeing the slug.
    await client.query("UPDATE personalities SET slug = 'retained-managed-reviewer' WHERE slug = 'reviewer' AND source = 'managed'");
    await client.query(
      "UPDATE personalities SET slug = 'reviewer', name = 'Reviewer' WHERE slug = 'verifier' AND source = 'built-in'"
    );
    await client.query(
      `INSERT INTO personalities (slug, name, description, category, content, is_custom, source)
       VALUES ('verifier', 'My Verifier', 'User-managed row already holding the target slug.',
               'custom', '# My Verifier', true, 'managed')`
    );
    const builtinBefore = await row('reviewer');
    const collidingBefore = await row('verifier');
    await client.query(migration073); // must WARN and return
    assert.deepEqual(await row('reviewer'), builtinBefore,
      'migration 073 mutated the built-in row despite a verifier slug collision');
    assert.deepEqual(await row('verifier'), collidingBefore,
      'migration 073 mutated the colliding verifier row');

    console.log('verifier-rename upgrade proof: managed-row-preserved=PASS rerun-idempotent=PASS collision-skips-explicitly=PASS');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
