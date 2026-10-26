/**
 * Machinery queue 9b761f09, the 157-replay class: a live suite that replays a
 * published migration with a COMMITTED query must never put back an object a
 * later migration redefined, because the full tier's live job runs every live
 * suite on ONE database and the next suite would meet the older definition.
 *
 * The replay of 157 in the shared-writer suite did exactly that: it redefined
 * the retry-contract CHECKs with 157's closed set after 164 and 166 had widened
 * them, and the subtask-structure and retry-contract suites that ran after it
 * went red. That replay (and 166's, which redefines the same CHECKs) now runs
 * in a rolled-back transaction (support/migrationReplay.ts).
 *
 * This census needs no database. It finds every place a test executes a
 * numbered migration's text, pins the committed ones BY NAME, and fails as soon
 * as a later migration redefines an object a committed replay defines - in the
 * commit that adds that later migration, naming the suite to move.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  definedObjects, laterRedefinitions, MIGRATIONS_DIR, replaySites, TESTS_DIR, treeReplaySites,
} from './support/migrationReplayCensus';
import { replayedChecks } from './support/migrationReplay';

/**
 * The committed replays, by suite and file, each with why it must commit. A
 * mutation drill that edits a migration needs the suite's replay of the edited
 * copy to land on the database before the tests that measure it, and the next
 * run's replay of the original to restore it; a backfill measured through the
 * HTTP router needs its rows visible to other connections. Everything else
 * replays in a rolled-back transaction.
 */
const COMMITTED_REPLAYS: Record<string, string> = {
  'groupPrincipalLive.test.ts 146_group_principal_kind.sql':
    'scripts/group-principal-mutations.py edits 146 and relies on this replay to land and restore it',
  'groupStewardsLive.test.ts 152_lenses_c_group_stewards.sql':
    'scripts/lenses-stewards-mutations.py edits 152 and relies on this replay to land and restore it',
  'notificationReadStateLive.test.ts 144_notification_read_state.sql':
    'the backfill is measured through the router on another connection; scripts/notification-hub-mutations.py edits 144',
  'personalityVersionLive.test.ts 130_personality_versions.sql':
    'PV-L9 measures that a replay preserves recorded history on committed rows',
};

/** Replays that MUST stay inside a rolled-back transaction: they redefine the retry-contract CHECKs. */
const ROLLED_BACK_REPLAYS = [
  'knowledgeSharedWritersLive.test.ts 157_knowledge_shared_writers.sql',
  'pluginAvailabilityLive.test.ts 166_plugin_availability_settings.sql',
];

const key = (site: { suite: string; migration: string }) => `${site.suite} ${site.migration}`;

describe('migration replay census (157-replay class)', () => {
  const sites = treeReplaySites();

  it('finds every replay site it is pinned to find, committed and rolled back (a census that finds nothing proves nothing)', () => {
    const committed = [...new Set(sites.filter((site) => site.committed).map(key))].sort();
    expect(committed).toEqual(Object.keys(COMMITTED_REPLAYS).sort());
    const rolledBack = new Set(sites.filter((site) => !site.committed).map(key));
    for (const name of ROLLED_BACK_REPLAYS) expect({ name, rolledBack: rolledBack.has(name) }).toEqual({ name, rolledBack: true });
    // The register's lower bound: the tree replays migrations in at least
    // these many places today; a census regex that stops matching shows here.
    expect(sites.length).toBeGreaterThanOrEqual(20);
  });

  it('no committed replay re-runs a file whose objects a later migration redefined', () => {
    const offenders = [...new Set(sites.filter((site) => site.committed).map(key))]
      .map((name) => ({ name, later: laterRedefinitions(name.split(' ')[1]) }))
      .filter((entry) => entry.later.length > 0);
    // A non-empty list names the suite and the later migration: replay that
    // file with replayInRolledBackTransaction (support/migrationReplay.ts), or,
    // where a drill needs the replay to commit, restore what it narrowed.
    expect(offenders).toEqual([]);
  });

  it('every rolled-back replay that re-adds a CHECK a later migration widened sets aside the rows only that migration admits (the data half)', () => {
    // Re-adding a CHECK validates every row of its table; on the shared
    // database an earlier suite may have committed rows only a later
    // migration's wider definition of the same constraint admits (the
    // Timeline suite's task.subtask.* retry records against 157's CHECKs).
    // Such a replay must call setAsideRowsOnlyLaterMigrationsAdmit inside its
    // transaction. A CHECK no later migration redefines cannot meet such rows.
    const exposed = (migration: string): string[] => {
      const later = new Set(laterRedefinitions(migration).flatMap((entry) => entry.objects));
      return replayedChecks(fs.readFileSync(path.join(MIGRATIONS_DIR, migration), 'utf8'))
        .map((check) => `con:${check.constraint}`).filter((name) => later.has(name));
    };
    const required = [...new Set(sites.filter((site) => !site.committed && exposed(site.migration).length > 0).map(key))].sort();
    // Not vacuous: 157's replay re-adds both retry-contract CHECKs, which 164 and 166 redefine.
    expect(required).toContain('knowledgeSharedWritersLive.test.ts 157_knowledge_shared_writers.sql');
    expect(exposed('157_knowledge_shared_writers.sql')).toEqual([
      'con:operation_idempotency_operation_policy', 'con:operation_idempotency_operation_scope',
    ]);
    const missing = required.filter((name) => {
      const source = fs.readFileSync(path.join(TESTS_DIR, name.split(' ')[0]), 'utf8');
      return !source.includes('setAsideRowsOnlyLaterMigrationsAdmit(');
    });
    expect(missing).toEqual([]);
  });

  it("replayedChecks reads 157's two retry-contract CHECKs by name with their whole predicate, never a comment or a body", () => {
    const checks = replayedChecks(fs.readFileSync(path.join(MIGRATIONS_DIR, '157_knowledge_shared_writers.sql'), 'utf8'));
    expect(checks.map((check) => `${check.table}.${check.constraint}`)).toEqual([
      'operation_idempotency_records.operation_idempotency_operation_policy',
      'operation_idempotency_records.operation_idempotency_operation_scope',
    ]);
    for (const check of checks) {
      expect(check.predicate.startsWith('(operation IN (')).toBe(true);
      expect(check.predicate.split('(').length).toBe(check.predicate.split(')').length);
      expect(check.predicate).toContain("'knowledge.sharedwriter.remove'");
      expect(check.predicate).not.toContain('task.subtask');
    }
    const synthetic = `-- ALTER TABLE t ADD CONSTRAINT in_a_comment CHECK (true);
      CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN EXECUTE 'ALTER TABLE u ADD CONSTRAINT in_a_body CHECK (true)'; END; $$ LANGUAGE plpgsql;
      ALTER TABLE t ADD CONSTRAINT t_paren CHECK (x IN ('a)', '(b') AND (y > 0));`;
    expect(replayedChecks(synthetic)).toEqual([{ table: 't', constraint: 't_paren', predicate: "x IN ('a)', '(b') AND (y > 0)" }]);
  });

  it('definedObjects reads constraints, functions, triggers, indexes, views, comments and column alters, never a function body or a comment', () => {
    const sql = `-- ALTER TABLE ignored ADD CONSTRAINT in_a_comment CHECK (true);
      ALTER TABLE t DROP CONSTRAINT IF EXISTS t_policy;
      ALTER TABLE t ADD CONSTRAINT t_policy CHECK (x IN ('a'));
      CREATE OR REPLACE FUNCTION public.f_guard() RETURNS trigger AS $$
      BEGIN EXECUTE 'ALTER TABLE u ADD CONSTRAINT in_a_body CHECK (true)'; RETURN NEW; END; $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_guard ON t;
      CREATE TRIGGER trg_guard BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f_guard();
      CREATE UNIQUE INDEX IF NOT EXISTS idx_t_one ON t (x);
      CREATE OR REPLACE VIEW v_t AS SELECT 1;
      COMMENT ON COLUMN t.x IS 'x';
      ALTER TABLE t ALTER COLUMN x SET DEFAULT 'a', ALTER COLUMN y TYPE text;
      INSERT INTO t (x) VALUES ('a') ON CONFLICT DO NOTHING;`;
    expect([...definedObjects(sql)].sort()).toEqual([
      'col:t.x', 'col:t.y', 'con:t_policy', 'doc:t.x', 'fn:f_guard', 'idx:idx_t_one', 'trg:trg_guard', 'view:v_t',
    ]);
  });

  it('laterRedefinitions names each later file and the objects it shares, and nothing for an untouched file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-census-'));
    try {
      fs.writeFileSync(path.join(dir, '200_first.sql'), 'ALTER TABLE t ADD CONSTRAINT t_policy CHECK (true);\nCREATE INDEX IF NOT EXISTS idx_a ON t (a);');
      fs.writeFileSync(path.join(dir, '201_other.sql'), 'CREATE INDEX IF NOT EXISTS idx_b ON t (b);');
      fs.writeFileSync(path.join(dir, '202_widen.sql'), 'ALTER TABLE t DROP CONSTRAINT IF EXISTS t_policy;\nALTER TABLE t ADD CONSTRAINT t_policy CHECK (false);');
      fs.writeFileSync(path.join(dir, 'README.md'), 'not a migration');
      expect(laterRedefinitions('200_first.sql', dir)).toEqual([{ later: '202_widen.sql', objects: ['con:t_policy'] }]);
      expect(laterRedefinitions('201_other.sql', dir)).toEqual([]);
      expect(laterRedefinitions('202_widen.sql', dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaySites tells a committed pool replay from a rolled-back client replay, and ignores reads and parameterised queries', () => {
    const source = `
      const MIGRATION_FILE = path.join(__dirname, '..', 'migrations', '157_knowledge_shared_writers.sql');
      const MIGRATION = fs.readFileSync(path.join(__dirname, '..', 'migrations', '144_notification_read_state.sql'), 'utf8');
      const migrationSql = (): string => fs.readFileSync(MIGRATION_FILE, 'utf8');
      it('a', async () => { const sql = fs.readFileSync(MIGRATION_FILE, 'utf8'); await pool.query(sql); });
      it('b', async () => { await client.query('BEGIN'); await client.query(migrationSql()); await client.query('ROLLBACK'); });
      it('c', async () => { await pool().query(fs.readFileSync(MIGRATION, 'utf8')); expect(MIGRATION).toContain('x'); });
      async function probe(sql: string, params: unknown[]) { await client.query(sql, params); }`;
    expect(replaySites('s.test.ts', source).map(({ migration, committed }) => ({ migration, committed }))).toEqual([
      { migration: '157_knowledge_shared_writers.sql', committed: true },
      { migration: '157_knowledge_shared_writers.sql', committed: false },
      { migration: '144_notification_read_state.sql', committed: true },
    ]);
    // A file that never rolls back commits its client replays too.
    expect(replaySites('t.test.ts', source.replace(/ROLLBACK/g, 'COMMIT')).map((site) => site.committed))
      .toEqual([true, true, true]);
  });
});
