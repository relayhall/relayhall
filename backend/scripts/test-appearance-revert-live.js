#!/usr/bin/env node
'use strict';

/** Live PostgreSQL contract for byte-exact Appearance revert (RH-UI.4). */
const assert = require('node:assert/strict');
const { pool } = require('../dist/db/connection');
const { appearanceService } = require('../dist/services/AppearanceService');

async function main() {
  const first = Buffer.from('first-logo-bytes');
  const second = Buffer.from('second-logo-bytes');
  const a = await pool.query(
    `INSERT INTO appearance_assets
       (kind, bytes, mime, width, height, byte_size, sha256, active)
     VALUES ('logo', $1, 'image/png', 1, 1, $2, $3, FALSE) RETURNING id`,
    [first, first.length, '1'.repeat(64)]
  );
  const b = await pool.query(
    `INSERT INTO appearance_assets
       (kind, bytes, mime, width, height, byte_size, sha256, active)
     VALUES ('logo', $1, 'image/png', 1, 1, $2, $3, TRUE) RETURNING id`,
    [second, second.length, '2'.repeat(64)]
  );
  await pool.query(
    `INSERT INTO appearances (singleton, display_name, links)
     VALUES (TRUE, 'Second', '[]'::jsonb)`
  );
  await pool.query(
    `INSERT INTO appearance_versions (version_no, snapshot, asset_refs, reason)
     VALUES
       (1, $1::jsonb, $2::jsonb, 'save'),
       (2, $3::jsonb, $4::jsonb, 'save')`,
    [
      JSON.stringify({ displayName: 'First', links: [] }),
      JSON.stringify({ logo: a.rows[0].id }),
      JSON.stringify({ displayName: 'Second', links: [] }),
      JSON.stringify({ logo: b.rows[0].id }),
    ]
  );

  const reverted = await appearanceService.revert(1, null);
  assert.equal(reverted.version.versionNo, 3);
  assert.equal(reverted.version.reason, 'revert');
  const active = await pool.query("SELECT id, bytes FROM appearance_assets WHERE kind='logo' AND active");
  assert.equal(active.rows.length, 1);
  assert.equal(active.rows[0].id, a.rows[0].id);
  assert.deepEqual(active.rows[0].bytes, first);
  const head = await pool.query('SELECT display_name FROM appearances WHERE singleton=TRUE');
  assert.equal(head.rows[0].display_name, 'First');
  console.log('appearance revert proof: append-only=PASS active-ref=PASS byte-exact=PASS');
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => pool.end());
