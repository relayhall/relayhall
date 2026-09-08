/**
 * migrationChain.test.ts — static integrity checks for the migration chain
 * (task 475a54c9). No database required: validates the BASELINE manifest,
 * the migrations directory, and the known historical quirks documented in
 * src/migrations/README.md.
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.join(__dirname, '../migrations');
const BASELINE_PATH = path.join(MIGRATIONS_DIR, 'BASELINE');
const RETIRED_PATH = path.join(MIGRATIONS_DIR, 'RETIRED');

/** Highest migration number absorbed into database/init.sql. */
const BASELINE_MAX = 42;

/** Numbers that never existed as files here — documented gaps, do not reuse. */
const KNOWN_GAPS = [1, 2, 3, 4, 5, 18, 19, 20, 21, 22, 38];

/** 035 is a documented historical duplicate (two files, both applied). */
const KNOWN_DUPLICATE_NUMBERS = [35];

/** Baseline-stamped installation seeds are immutable ledger names, but their
 * private deployment content must never return to the publishable tree. */
const NEUTRAL_LEDGER_STUBS = [
  '011_seed_tools.sql',
  '012_seed_additional_tools.sql',
  '016_seed_generic_tools.sql',
];

function listSqlFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
}

function readBaseline(): string[] {
  return readFileSync(BASELINE_PATH, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'));
}

function readRetired(): string[] {
  return readFileSync(RETIRED_PATH, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'));
}

function numberOf(file: string): number {
  const m = file.match(/^(\d+)_/);
  expect(m).not.toBeNull();
  return parseInt(m![1], 10);
}

describe('migration chain integrity', () => {
  const files = listSqlFiles();

  test('BASELINE manifest exists', () => {
    expect(existsSync(BASELINE_PATH)).toBe(true);
    expect(existsSync(RETIRED_PATH)).toBe(true);
  });

  test('RETIRED entries are existing, post-baseline, unique, and disjoint', () => {
    const baseline = readBaseline();
    const retired = readRetired();
    expect(new Set(retired).size).toBe(retired.length);
    expect([...retired].sort()).toEqual(retired);
    for (const entry of retired) {
      expect(files).toContain(entry);
      expect(numberOf(entry)).toBeGreaterThan(BASELINE_MAX);
      expect(baseline).not.toContain(entry);
    }
  });

  test('every BASELINE entry is a .sql file that exists in the migrations directory', () => {
    const baseline = readBaseline();
    expect(baseline.length).toBeGreaterThan(0);
    for (const entry of baseline) {
      expect(entry).toMatch(/^\d{3}_.+\.sql$/);
      expect(files).toContain(entry);
    }
  });

  test('BASELINE has no duplicate entries and is sorted', () => {
    const baseline = readBaseline();
    expect(new Set(baseline).size).toBe(baseline.length);
    expect([...baseline].sort()).toEqual(baseline);
  });

  test(`every migration file numbered <= ${BASELINE_MAX} is listed in BASELINE`, () => {
    const baseline = readBaseline();
    const shouldBeBaseline = files.filter(f => numberOf(f) <= BASELINE_MAX);
    expect(shouldBeBaseline).toEqual(baseline);
  });

  test(`files NOT in BASELINE are post-baseline (number > ${BASELINE_MAX})`, () => {
    const baseline = readBaseline();
    for (const f of files.filter(f => !baseline.includes(f))) {
      expect(numberOf(f)).toBeGreaterThan(BASELINE_MAX);
    }
  });

  test('post-baseline files sort after every baseline file (execution order is sane)', () => {
    const baseline = readBaseline();
    const post = files.filter(f => !baseline.includes(f));
    const maxBaseline = baseline[baseline.length - 1];
    for (const f of post) {
      expect(f > maxBaseline).toBe(true);
    }
  });

  test('no unexpected duplicate migration numbers', () => {
    const counts = new Map<number, string[]>();
    for (const f of files) {
      const n = numberOf(f);
      counts.set(n, [...(counts.get(n) || []), f]);
    }
    for (const [n, names] of counts) {
      if (KNOWN_DUPLICATE_NUMBERS.includes(n)) continue;
      expect({ number: n, files: names }).toEqual({ number: n, files: [names[0]] });
    }
  });

  test('known gaps are still gaps (numbers must not be reused)', () => {
    const numbers = new Set(files.map(numberOf));
    for (const gap of KNOWN_GAPS) {
      expect(numbers.has(gap)).toBe(false);
    }
  });

  test('all migration files are non-empty and contain no forbidden patterns', () => {
    for (const f of files) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      expect(sql.trim().length).toBeGreaterThan(0);
      // PG16 has no min/max aggregate for uuid — the original 027 bug.
      // Strip '--' line comments so documentation mentioning the bug is fine.
      const code = sql.replace(/--[^\n]*/g, '');
      expect(code).not.toMatch(/\bMIN\s*\(\s*id\s*\)/i);
    }
  });

  test('installation-specific baseline seeds remain neutral one-line ledger stubs', () => {
    for (const file of NEUTRAL_LEDGER_STUBS) {
      const content = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8').trim();
      expect(content).toBe(
        `-- ${file}: historical BASELINE ledger stub; installation-specific seed content ` +
        'removed before publication under owner ruling A14/DP-6b.'
      );
    }
  });

  test('BASELINE history contains no known private-estate residue', () => {
    const privateEstateResidue = /whisper-env|proxmox|mcporter|nimtasks|\bhomelab\b|\bansible\b|192\.168\./i;
    for (const file of readBaseline()) {
      expect({ file, content: readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8') })
        .not.toMatchObject({ content: expect.stringMatching(privateEstateResidue) });
    }
  });

  test('fragile legacy-sessions migrations are guarded for from-scratch replay', () => {
    // These reference tables that do not exist until 033 on a fresh replay;
    // each must carry a to_regclass guard so it no-ops safely.
    for (const f of [
      '026_phase5_retention_optimization.sql',
      '027_session_messages_dedup.sql',
      '029_sessions_kind_constraint.sql',
      '030_delete_ghost_sessions.sql',
    ]) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      expect(sql).toMatch(/to_regclass/);
    }
  });

  test('no POST-BASELINE migration contains an explicit COMMIT (files run as one implicit transaction)', () => {
    // Baseline files (e.g. 033) are stamped, never executed, so historical
    // BEGIN/COMMIT pairs there are inert. Files that migrate.ts actually
    // executes must not manage their own transactions.
    const baseline = readBaseline();
    for (const f of files.filter(f => !baseline.includes(f))) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
    }
  });
});
