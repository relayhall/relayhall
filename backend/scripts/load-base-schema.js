#!/usr/bin/env node
/**
 * Load `database/init.sql` — the base schema every migration is a delta against
 * — through the `pg` driver rather than through `psql`.
 *
 * Card fb06c930. The retry contract's CI gate needs a real PostgreSQL with the
 * base schema loaded before `npm run migrate` runs, and the FIRST CI run on the
 * candidate branch established two facts about this runner:
 *
 *   1. the Gitea act runner DOES honour a `services:` block — a healthy
 *      `postgres:16` service container came up beside the backend job, which
 *      owner ruling 94ecf329 item 4 made a build requirement and which this
 *      repository had never exercised;
 *   2. `gitea/runner-images:ubuntu-latest` has NO `psql` client. A CI step that
 *      shelled out to `psql` would have failed on a missing binary and said
 *      nothing whatever about the contract.
 *
 * `init.sql` contains no psql meta-commands (checked: zero lines beginning with
 * a backslash), so the driver can execute it as one script. `pg` is already a
 * production dependency, so this adds nothing to install.
 *
 * DESTRUCTIVE: it writes the schema into whatever database DB_* names. Point it
 * at a disposable database only — never DEV, TST or PROD.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const FORBIDDEN = ['relayhall_dev', 'relayhall_tst', 'relayhall_prod', 'relayhall'];

async function main() {
  const database = process.env.DB_NAME;
  if (!database) throw new Error('DB_NAME is not set; refusing to guess which database to initialise');
  if (FORBIDDEN.includes(database)) {
    throw new Error(`refusing to load the base schema into '${database}' — that is a deployment database`);
  }
  const file = path.resolve(__dirname, '..', '..', 'database', 'init.sql');
  const sql = fs.readFileSync(file, 'utf8');

  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    database,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
  await client.connect();
  try {
    await client.query(sql);
    console.log(`base schema loaded into ${database} from ${file}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[load-base-schema] failed:', err.message);
  process.exit(1);
});
