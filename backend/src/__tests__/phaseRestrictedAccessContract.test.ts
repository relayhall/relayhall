import fs from 'fs';
import path from 'path';

const source = (relative: string) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

describe('explicit Phase restricted-access contract (owner ruling 44ee41f2)', () => {
  it('defaults to inheritance and ledgers every attributed policy change', () => {
    const sql = source('migrations/085_phase_restricted_access.sql');
    expect(sql).toMatch(/restricted_access BOOLEAN NOT NULL DEFAULT FALSE/i);
    expect(sql).toContain('phase_access_events');
    expect(sql).toContain('phases_restricted_access_ledger');
    expect(sql).toContain("current_setting('relayhall.phase_access_actor'");
    expect(sql).toContain('require attributed audit context');
    expect(sql).toContain('append-only');
  });

  it('keeps restriction out of ordinary edits and behind a dedicated admin route', () => {
    const route = source('routes/phases.ts');
    const scopes = source('utils/scopeMap.ts');
    expect(route).toContain("router.patch('/:id/access'");
    expect(route).toContain("['revision', 'restricted', 'reason']");
    expect(route).not.toContain("['revision', 'name', 'goal', 'status', 'position', 'restrictedAccess']");
    expect(scopes).toMatch(/phases\\\/\[\^\/\]\+\\\/access.*phases:admin/);
  });

  it('uses the explicit column, never grant presence, to suppress inheritance', () => {
    const evaluator = source('services/AuthorizationService.ts');
    const repository = source('services/AuthorizationRepository.ts');
    expect(evaluator).toContain('!resource.restrictedAccess');
    expect(evaluator).not.toContain('hasExactGrantSet');
    expect(repository).toContain("restrictedAccess: 'ph.restricted_access'");
    expect(repository).not.toContain('has_exact_grant_set');
  });
});
