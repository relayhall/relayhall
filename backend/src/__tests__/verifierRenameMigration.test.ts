// Pins migration 073's target selection (review 2be77033 blocking finding).
//
// A15.6 licenses renaming ONLY the built-in personality seeded by 065. 065
// seeds with ON CONFLICT (slug) DO NOTHING, so on an upgrade database the
// slug 'reviewer' may belong to a managed/git/legacy row — user data the
// migration must not touch. The live-PG proof is
// backend/scripts/test-verifier-rename-upgrade.js; this static pin keeps the
// guard from being weakened in environments where no database is available.
import { readFileSync } from 'fs';
import { join } from 'path';

const sql = readFileSync(
  join(__dirname, '../migrations/073_verifier_personality_rename.sql'),
  'utf8'
);

describe('migration 073 target selection (A15.6, review 2be77033)', () => {
  it('selects the rename target by built-in provenance, never by slug alone', () => {
    expect(sql).toMatch(/slug = 'reviewer' AND source = 'built-in'/);
  });

  it('keys the destructive UPDATE by the resolved built-in id', () => {
    expect(sql).toMatch(/WHERE id = builtin_reviewer/);
    // No UPDATE in the file may target rows by bare slug.
    expect(sql).not.toMatch(/UPDATE personalities[\s\S]*?WHERE slug/);
  });

  it('skips explicitly on a verifier slug collision instead of mutating', () => {
    expect(sql).toMatch(/EXISTS \(SELECT 1 FROM personalities WHERE slug = 'verifier'\)/);
    expect(sql).toMatch(/RAISE WARNING/);
  });
});
