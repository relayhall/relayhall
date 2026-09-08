// migrate.ts - Database migration runner with baseline stamping
//
// Migration story (see src/migrations/README.md for the full history):
//   - database/init.sql is the authoritative fresh-install baseline. It contains
//     the complete schema through migration 042 (regenerated from the live schema).
//   - src/migrations/BASELINE lists every migration file that is already part of
//     that baseline. Those files are STAMPED into schema_migrations without being
//     executed — on fresh databases (after init.sql) and on existing databases
//     whose ledger is missing entries that were applied out-of-band.
//   - RETIRED lists immutable post-baseline migrations superseded by a forward
//     cleanup; those are stamped for history but never executed.
//   - Only files in neither manifest are executed.
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { pool } from './connection';
import { logCaughtFailure, logCaughtWarning } from '../utils/secretSafeLog';

const MIGRATIONS_DIR = path.join(__dirname, '../migrations');
const BASELINE_MANIFEST = path.join(MIGRATIONS_DIR, 'BASELINE');
const RETIRED_MANIFEST = path.join(MIGRATIONS_DIR, 'RETIRED');

/** Tables that must exist on any correctly initialised RelayHall database. */
const CRITICAL_TABLES = ['schema_migrations', 'tasks', 'sessions', 'task_timeline_events'];

interface MigrationRecord {
  id: number;
  name: string;
  executed_at: Date;
}

/** Read a migration manifest: one filename per line, '#' comments allowed. */
function readManifest(manifestPath: string): string[] {
  if (!existsSync(manifestPath)) return [];
  return readFileSync(manifestPath, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
}

export function readBaselineManifest(): string[] {
  return readManifest(BASELINE_MANIFEST);
}

/** Immutable post-baseline migrations for extracted subsystems: stamp, never run. */
export function readRetiredManifest(): string[] {
  return readManifest(RETIRED_MANIFEST);
}

/** List all .sql migration files on disk, sorted. */
export function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
}

/**
 * Immutable migration compatibility shims. Some older production estates
 * legitimately contain values admitted by their then-current CHECK while the
 * historical forward file converts those values before dropping that CHECK.
 * Prefixing the statement inside the same implicit transaction makes those
 * files replayable without editing their immutable bytes or leaving a partial
 * precondition behind if the migration fails.
 */
export function migrationCompatibilityPrefix(file: string): string {
  if (file === '086_task_element_substrate.sql') {
    // Early 052 estates can carry the ledger entry and review-attempt table
    // without the lease table added by the final reviewed 052 bytes. 086 is
    // the first later migration to reference that table, so establish the
    // missing additive substrate in the same transaction before immutable
    // 086 runs. The definition is identical to 052 and remains a no-op on
    // complete estates and clean installs.
    return `
CREATE TABLE IF NOT EXISTS task_execution_leases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  resource_key TEXT NOT NULL,
  harness TEXT NOT NULL CHECK (harness IN ('hermes', 'openclaw')),
  session_key TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'released', 'expired', 'failed')),
  claimed_task_updated_at TIMESTAMPTZ NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  failure_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_execution_leases_active_task
  ON task_execution_leases(task_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_execution_leases_active_resource
  ON task_execution_leases(resource_key) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_task_execution_leases_expiry
  ON task_execution_leases(status, expires_at);
`;
  }
  if (file === '066_explicit_review_workflow.sql' || file === '068_kebab_case_subtask_states.sql') {
    return 'ALTER TABLE subtasks DROP CONSTRAINT IF EXISTS subtasks_status_check;\n';
  }
  return '';
}

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Pre-baseline prod tables were created without UNIQUE(name); ON CONFLICT needs the arbiter index
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS schema_migrations_name_key ON schema_migrations (name)`
  );
}

async function getExecutedMigrations(): Promise<string[]> {
  const result = await pool.query<MigrationRecord>(
    'SELECT name FROM schema_migrations ORDER BY id'
  );
  return result.rows.map(r => r.name);
}

async function recordMigration(name: string): Promise<void> {
  await pool.query(
    'INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
    [name]
  );
}

async function tableExists(name: string): Promise<boolean> {
  const result = await pool.query(
    'SELECT to_regclass($1) IS NOT NULL AS exists',
    [`public.${name}`]
  );
  return result.rows[0]?.exists === true;
}

/**
 * Core migration logic. Does NOT close the pool — safe to call from server startup.
 * @param closePoolWhenDone Pass true when running as a standalone CLI script.
 */
export async function runMigrations(closePoolWhenDone = false): Promise<void> {
  console.log('🔄 Starting database migrations...\n');

  try {
    await ensureMigrationsTable();
    const executed = await getExecutedMigrations();
    const baseline = readBaselineManifest();
    const retired = readRetiredManifest();
    const files = listMigrationFiles();

    // Immutable history is part of the contract: every manifest entry must
    // still exist byte-for-byte on disk.
    const baselineMissingOnDisk = baseline.filter(b => !files.includes(b));
    if (baselineMissingOnDisk.length > 0) {
      throw new Error(
        'BASELINE manifest entries have no immutable migration file on disk: ' +
        baselineMissingOnDisk.join(', ')
      );
    }

    const retiredMissingOnDisk = retired.filter(name => !files.includes(name));
    if (retiredMissingOnDisk.length > 0) {
      throw new Error(
        'RETIRED manifest entries have no immutable migration file on disk: ' +
        retiredMissingOnDisk.join(', ')
      );
    }

    const manifestOverlap = baseline.filter(name => retired.includes(name));
    if (manifestOverlap.length > 0) {
      throw new Error(`Migration manifest overlap: ${manifestOverlap.join(', ')}`);
    }

    // ── Phase 1: stamp inert migrations ───────────────────────────────────
    // BASELINE is already reflected by init.sql or historical production
    // state. RETIRED is superseded by a later forward migration. Both remain
    // immutable and are recorded WITHOUT execution.
    const toStamp = [...baseline, ...retired].filter(name => !executed.includes(name));
    if (toStamp.length > 0) {
      // Refuse to stamp into a database that never got the base schema —
      // stamping there would silently produce an empty-but-"migrated" DB.
      if (!(await tableExists('tasks'))) {
        throw new Error(
          'Baseline stamping refused: table "tasks" does not exist. ' +
          'This database has not been initialized — apply database/init.sql first, ' +
          'then re-run migrations.'
        );
      }
      console.log(`🏷️  Stamping ${toStamp.length} inert migration(s) as applied (not executed):`);
      for (const name of toStamp) {
        await recordMigration(name);
        console.log(`   🏷️  ${name}`);
      }
      console.log('');
    }

    // ── Phase 2: execute active forward migrations ────────────────────────
    let migratedCount = 0;
    for (const file of files) {
      if (baseline.includes(file) || retired.includes(file)) continue; // stamped above
      if (executed.includes(file)) {
        console.log(`⏭️  Skipping (already executed): ${file}`);
        continue;
      }

      console.log(`▶️  Running: ${file}`);
      const filePath = path.join(MIGRATIONS_DIR, file);
      const sql = migrationCompatibilityPrefix(file) + readFileSync(filePath, 'utf8');

      try {
        await pool.query(sql);
        await recordMigration(file);
        console.log(`✅ Completed: ${file}\n`);
        migratedCount++;
      } catch (err) {
        console.error(`❌ Failed: ${file}`);
        logCaughtFailure('[Migrations] migration file failed', err);
        throw err;
      }
    }

    if (toStamp.length === 0 && migratedCount === 0) {
      console.log('\n✨ Database is up to date. No migrations to run.');
    } else {
      console.log(
        `\n✅ Migration run complete: ${toStamp.length} stamped, ${migratedCount} executed.`
      );
    }
  } catch (err) {
    if (closePoolWhenDone) {
      logCaughtFailure('[Migrations] run failed', err);
      process.exit(1);
    }
    throw err;
  }

  if (closePoolWhenDone) {
    await pool.end();
  }
}

/**
 * Schema/ledger consistency check. Returns a list of human-readable problems
 * (empty = healthy). Never throws for "drift" — only for connection failures.
 */
export async function checkSchemaConsistency(): Promise<string[]> {
  const problems: string[] = [];

  for (const table of CRITICAL_TABLES) {
    if (!(await tableExists(table))) {
      problems.push(`critical table missing: "${table}"`);
    }
  }

  // Without a ledger there is nothing more to compare.
  if (problems.some(p => p.includes('"schema_migrations"'))) {
    return problems;
  }

  const executed = await getExecutedMigrations();
  const files = listMigrationFiles();
  const baseline = readBaselineManifest();
  const retired = readRetiredManifest();

  for (const file of files) {
    if (!executed.includes(file)) {
      problems.push(
        `migration file never applied/stamped: ${file}` +
        ([...baseline, ...retired].includes(file) ? ' (inert — run "npm run migrate" to stamp it)' : '')
      );
    }
  }

  for (const name of executed) {
    if (!files.includes(name)) {
      problems.push(`ledger entry has no matching file on disk: ${name} (renamed or deleted migration)`);
    }
  }

  return problems;
}

/**
 * Boot-time consistency check: verifies ledger-vs-directory agreement and the
 * presence of critical tables. Logs a LOUD warning on drift — never crashes
 * and never blocks server startup.
 */
export async function runStartupChecks(): Promise<void> {
  try {
    const problems = await checkSchemaConsistency();
    if (problems.length === 0) {
      const executed = await getExecutedMigrations();
      console.log(
        `✅ Schema consistency check passed (${executed.length} ledger entries, ` +
        'directory and critical tables OK)'
      );
      return;
    }
    console.warn('╔═══════════════════════════════════════════════════════════╗');
    console.warn('║ ⚠️  SCHEMA DRIFT DETECTED — database vs migrations         ║');
    console.warn('╚═══════════════════════════════════════════════════════════╝');
    for (const problem of problems) {
      console.warn(`   ⚠️  ${problem}`);
    }
    console.warn('   ➜ See backend/src/migrations/README.md (task 475a54c9) for the migration story.');
  } catch (err) {
    logCaughtWarning('[Migrations] schema consistency check could not run', err);
  }
}

/**
 * Run pending migrations on server startup when AUTO_MIGRATE=true.
 * Safe to import from server.ts — does not close the pool.
 *
 * Usage in server.ts:
 *   import { runMigrationsOnStartup } from './db/migrate';
 *   await runMigrationsOnStartup();
 */
export async function runMigrationsOnStartup(): Promise<void> {
  if (process.env.AUTO_MIGRATE !== 'true') return;
  console.log('🔄 AUTO_MIGRATE=true — running pending migrations on startup...');
  await runMigrations(false); // keep pool alive
}

// Run if called directly (npm run migrate)
if (require.main === module) {
  runMigrations(true).catch(err => {
    logCaughtFailure('[Migrations] run failed', err);
    process.exit(1);
  });
}
