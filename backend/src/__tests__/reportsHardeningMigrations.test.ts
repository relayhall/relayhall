/**
 * reportsHardeningMigrations.test.ts — static checks for the reports
 * hardening migration files (task c655d243). No database required; DB-side
 * behaviour is proven by the dev-stack smoke tests recorded on the task.
 * Grows one describe block per landed item.
 */
import { readFileSync, existsSync } from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.join(__dirname, '../migrations');
const BASELINE_PATH = path.join(MIGRATIONS_DIR, 'BASELINE');

function read(name: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
}

function baseline(): string[] {
  return readFileSync(BASELINE_PATH, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
}

describe('056_reports_content_hash.sql', () => {
  const FILE = '056_reports_content_hash.sql';

  it('exists and is not swallowed by the BASELINE manifest', () => {
    expect(existsSync(path.join(MIGRATIONS_DIR, FILE))).toBe(true);
    expect(baseline()).not.toContain(FILE);
  });

  it('adds the column idempotently and backfills only NULL rows with sha256 hex', () => {
    const sql = read(FILE);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS content_hash VARCHAR\(64\)/);
    expect(sql).toMatch(/CREATE EXTENSION IF NOT EXISTS pgcrypto/);
    expect(sql).toMatch(/encode\(digest\(content, 'sha256'\), 'hex'\)/);
    expect(sql).toMatch(/WHERE content_hash IS NULL/);
  });
});

describe('061_reports_visibility.sql', () => {
  const FILE = '061_reports_visibility.sql';

  it('exists and is not swallowed by the BASELINE manifest', () => {
    expect(existsSync(path.join(MIGRATIONS_DIR, FILE))).toBe(true);
    expect(baseline()).not.toContain(FILE);
  });

  it('adds a NOT NULL text column defaulting to default (plumbing only)', () => {
    const sql = read(FILE);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'default'/);
  });
});

describe('060_reports_soft_delete.sql', () => {
  const FILE = '060_reports_soft_delete.sql';

  it('exists and is not swallowed by the BASELINE manifest', () => {
    expect(existsSync(path.join(MIGRATIONS_DIR, FILE))).toBe(true);
    expect(baseline()).not.toContain(FILE);
  });

  it('adds a nullable tombstone column with a partial index', () => {
    const sql = read(FILE);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_reports_deleted_at/);
    expect(sql).toMatch(/WHERE deleted_at IS NOT NULL/);
  });
});

describe('059_reports_origin.sql', () => {
  const FILE = '059_reports_origin.sql';

  it('exists and is not swallowed by the BASELINE manifest', () => {
    expect(existsSync(path.join(MIGRATIONS_DIR, FILE))).toBe(true);
    expect(baseline()).not.toContain(FILE);
  });

  it('adds a NOT NULL origin column defaulting to api (covers legacy rows)', () => {
    const sql = read(FILE);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS origin VARCHAR\(32\) NOT NULL DEFAULT 'api'/);
  });
});

describe('058_reports_author_actor_id.sql', () => {
  const FILE = '058_reports_author_actor_id.sql';

  it('exists and is not swallowed by the BASELINE manifest', () => {
    expect(existsSync(path.join(MIGRATIONS_DIR, FILE))).toBe(true);
    expect(baseline()).not.toContain(FILE);
  });

  it('adds the column idempotently with a partial index and no backfill', () => {
    const sql = read(FILE);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS author_actor_id VARCHAR\(100\)/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_reports_author_actor_id/);
    expect(sql).not.toMatch(/UPDATE reports/); // historical rows stay NULL
  });
});

describe('057_reports_updated_at_trigger.sql', () => {
  const FILE = '057_reports_updated_at_trigger.sql';

  it('exists and is not swallowed by the BASELINE manifest', () => {
    expect(existsSync(path.join(MIGRATIONS_DIR, FILE))).toBe(true);
    expect(baseline()).not.toContain(FILE);
  });

  it('re-runnably installs a BEFORE UPDATE trigger using the shared touch function', () => {
    const sql = read(FILE);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION update_updated_at_column\(\)/);
    expect(sql).toMatch(/NEW\.updated_at = CURRENT_TIMESTAMP/);
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS update_reports_updated_at ON reports/);
    expect(sql).toMatch(/BEFORE UPDATE ON reports/);
    expect(sql).toMatch(/FOR EACH ROW/);
    expect(sql).toMatch(/EXECUTE FUNCTION update_updated_at_column\(\)/);
  });
});
