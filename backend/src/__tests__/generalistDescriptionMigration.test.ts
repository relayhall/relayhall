// Pins migration 074's target selection (task 796ba3f0).
//
// 074 rewrites ONLY the 065-seeded built-in Generalist description (the
// retired phrase "work items" → ratified Task vocabulary). 065 seeds with
// ON CONFLICT (slug) DO NOTHING, so on an upgrade database the slug
// 'generalist' may belong to a row with different provenance or edited
// bytes — user data the migration must not touch. The live-PG proofs are
// backend/scripts/test-fresh-install-replay.js (fresh chain) and the
// upgrade fixture run recorded on the task; this static pin keeps the guard
// from being weakened where no database is available.
import { readFileSync } from 'fs';
import { join } from 'path';

const sql = readFileSync(
  join(__dirname, '../migrations/074_generalist_description_vocabulary.sql'),
  'utf8'
);

describe('migration 074 target selection (task 796ba3f0)', () => {
  it('selects the rewrite target by built-in provenance AND the exact 065 byte string', () => {
    expect(sql).toMatch(/slug = 'generalist'/);
    expect(sql).toMatch(/AND source = 'built-in'/);
    expect(sql).toMatch(/AND description = 'A balanced default for ordinary work items\.'/);
  });

  it('keys the UPDATE by the resolved built-in id, never by bare slug', () => {
    expect(sql).toMatch(/WHERE id = builtin_generalist/);
    expect(sql).not.toMatch(/UPDATE personalities[\s\S]*?WHERE slug/);
  });

  it('writes the ratified wording', () => {
    expect(sql).toMatch(/'A balanced default for ordinary tasks\.'/);
  });
});
