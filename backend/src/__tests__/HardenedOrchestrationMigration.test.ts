import { existsSync, readFileSync } from 'fs';
import path from 'path';

const migrationPath = path.join(__dirname, '../migrations/053_hardened_orchestration_upgrade.sql');
const migration = readFileSync(migrationPath, 'utf8');

describe('hardened orchestration forward upgrade migration', () => {
  test('repairs schemas that already recorded the original 051/052', () => {
    expect(migration).toMatch(/ALTER TABLE task_review_attempts[\s\S]*ADD COLUMN IF NOT EXISTS review_slice_hash TEXT/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS review_slice_version SMALLINT/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS review_slice JSONB/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS implementation_receipt_hash TEXT/i);
  });

  test('gives synthetic legacy slices their own version before enforcing not-null', () => {
    const backfill = migration.indexOf("'legacy_review_attempt'");
    const legacyVersion = migration.indexOf('SET review_slice_version = 0');
    const receiptBackfill = migration.indexOf("'legacy_implementation_receipt'");
    const notNull = migration.indexOf('ALTER COLUMN review_slice_hash SET NOT NULL');
    expect(backfill).toBeGreaterThan(0);
    expect(legacyVersion).toBeGreaterThan(backfill);
    expect(receiptBackfill).toBeGreaterThan(legacyVersion);
    expect(notNull).toBeGreaterThan(receiptBackfill);
    expect(migration).toMatch(/digest\([\s\S]*'sha256'/i);
  });

  test('constrains both supported versions to their documented JSON shape', () => {
    expect(migration).toContain('task_review_slice_matches_version');
    expect(migration).toContain("slice_version = 0");
    expect(migration).toContain("slice_version = 1");
    for (const field of ['subtaskId', 'index', 'title', 'status', 'updatedAt', 'evidenceReceipt']) {
      expect(migration).toContain(`'${field}'`);
    }
    for (const name of [
      'task_review_attempts_review_slice_hash_sha256',
      'task_review_attempts_review_slice_version_supported',
      'task_review_attempts_review_slice_nonempty_array',
      'task_review_attempts_review_slice_schema',
      'task_review_attempts_implementation_receipt_hash_sha256',
      'tasks_max_retries_bounded',
    ]) {
      expect(migration).toContain(`ADD CONSTRAINT ${name}`);
      expect(migration).toContain(`VALIDATE CONSTRAINT ${name}`);
    }
  });

  test('ships a real PostgreSQL upgrade/fresh/replay proof runner', () => {
    expect(existsSync(path.join(__dirname, '../../scripts/test-hardened-orchestration-migrations.js'))).toBe(true);
  });

  test('is forward-only and does not delete legacy attempts', () => {
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\s+task_review_attempts\b/i);
    expect(migration).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});
