/**
 * Card 46cfbd1d — LENSES-c c1-A, the census controls of the design delta's
 * test plan (G.1), as properties of SOURCE. The live suite
 * (groupStewardsLive.test.ts) measures rows; this suite keeps the tree from
 * drifting away from the shape those rows were measured on.
 *
 *   LC-C1  THE WRITER REGISTER. Every INSERT into and DELETE from
 *          group_stewards in backend/src (tests and migrations excluded) is
 *          registered by its exact trimmed line. No UPDATE writer exists, and
 *          termination is not a writer (D-9): a removal wired into
 *          CredentialLifecycleService or ServiceRegistry reddens here.
 *   LC-C2  THE READER REGISTER. Every other line naming group_stewards is
 *          classified. Authority and disclosure reads go through the shared
 *          fragment; the listed exceptions are the stewards LIST and the
 *          GROUP_HAS_STEWARDS COUNT; the two FOR UPDATE reads are WRITER
 *          reads, used for the 409 and the delete, never for authority.
 *   LC-C3  THE ROUTE REGISTER. Each new route with its scope rule as the
 *          first-match table resolves it, the managers rule's position before
 *          the /groups rules (asserted, not assumed), and its in-handler gate.
 *   LC-C7  ONE ELEVATED SET. The 152 trigger's refusal list and the
 *          fragment's role condition equal ELEVATED_ROLES, both directions.
 *
 * LC-C4 (the schema pins) and the drills are the live suite's; LC-C5 (one
 * session classification) is administratorSessionSeam.test.ts's.
 */
import fs from 'fs';
import path from 'path';

import { requiredScopeFor } from '../utils/scopeMap';
import { ELEVATED_ROLES } from '../utils/credentialAuthority';
import { elevatedRoleSqlList, liveStewardRows, liveStewardCondition } from '../utils/liveStewardCondition';

const SRC = path.join(__dirname, '..');
const read = (file: string): string => fs.readFileSync(path.join(SRC, file), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(SRC, full).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (rel === '__tests__' || rel === 'migrations' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.(ts|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

interface Hit { file: string; line: string }

function census(pattern: RegExp): Hit[] {
  const hits: Hit[] = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (pattern.test(line)) hits.push({ file: rel, line: line.trim() });
    }
  }
  return hits;
}

const isComment = (line: string): boolean => line.startsWith('*') || line.startsWith('//') || line.startsWith('/*');

// ─────────────────────────── LC-C1: the writers ───────────────────────────

const WRITE = /\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+group_stewards\b/i;

/** [file, exact trimmed line, the act] */
const WRITER_REGISTER: Array<[string, string, string]> = [
  ['services/GroupStewardService.ts', '`INSERT INTO group_stewards (group_id, account_principal_id, role, appointed_by_principal_id)',
    'C.3: the root appointment (POST /groups/:id/stewards)'],
  ['services/GroupStewardService.ts', "'DELETE FROM group_stewards WHERE group_id = $1 AND account_principal_id = $2',",
    'C.3 and C.4: removeRow, shared by the root removal and the owner removal of a manager row'],
  // LENSES-c c1-B (card b5c83682): gate (iii)'s appointment writes a MANAGER
  // row only - the role is a literal in the statement, never a parameter.
  ['services/GroupStewardService.ts', "`INSERT INTO group_stewards (group_id, account_principal_id, role, appointed_by_principal_id) VALUES ($1, $2, 'manager', $3)`,",
    "C.4: gate (iii), an owner-role holder's appointment of a manager (POST /groups/:id/managers)"],
];

describe('LC-C1 - the steward-writer register', () => {
  const writers = census(WRITE).filter((hit) => !isComment(hit.line));

  it('every INSERT into and DELETE from group_stewards is registered, line by line', () => {
    expect(writers.map((hit) => [hit.file, hit.line]).sort())
      .toEqual(WRITER_REGISTER.map(([file, line]) => [file, line]).sort());
  });

  it('no UPDATE writer exists (rows are never edited, C.1)', () => {
    expect(writers.filter((hit) => /UPDATE\s+group_stewards/i.test(hit.line))).toEqual([]);
  });

  it('termination is not a writer: neither terminate path names group_stewards (D-9)', () => {
    for (const file of ['services/CredentialLifecycleService.ts', 'services/ServiceRegistry.ts', 'routes/principals.ts']) {
      expect({ file, names: read(file).includes('group_stewards') }).toEqual({ file, names: false });
    }
  });
});

// ─────────────────────────── LC-C2: the readers ───────────────────────────

type ReaderClass = 'FRAGMENT' | 'LIST' | 'COUNT' | 'WRITER_READ' | 'SELF_DECISION';

const READER_REGISTER: Array<[string, string, ReaderClass, string]> = [
  ['utils/liveStewardCondition.ts', 'FROM group_stewards steward_row', 'FRAGMENT',
    'the ONE shared fragment: every authority and disclosure read composes it'],
  ['services/GroupStewardService.ts', 'FROM group_stewards gs', 'LIST',
    'GET /groups/:id/stewards: the rows themselves are directory data; `live` is the fragment, inertReason names the first failing condition'],
  ['services/GroupService.ts', "'SELECT COUNT(*)::int AS n FROM group_stewards WHERE group_id = $1', [id],", 'COUNT',
    'GROUP_HAS_STEWARDS: a count under the Group row lock, never identities'],
  ['services/GroupStewardService.ts', "'SELECT role FROM group_stewards WHERE group_id = $1 AND account_principal_id = $2 FOR UPDATE',", 'WRITER_READ',
    "the appointment's ALREADY_A_STEWARD check: names the existing role in the 409; never authority or disclosure"],
  // LENSES-c c1-B (card b5c83682): the same writer read, in gate (iii)'s step 4.
  ['services/GroupStewardService.ts', "'SELECT role FROM group_stewards WHERE group_id = $1 AND account_principal_id = $2 FOR UPDATE',", 'WRITER_READ',
    "gate (iii)'s ALREADY_A_STEWARD check (requireEligibleManagerAppointee): names the existing role in the 409; never authority"],
  // LENSES-c c1-B round 2 (card b5c83682; C.3, C.4): a raced appointment's 409.
  ['services/GroupStewardService.ts', "'SELECT role FROM group_stewards WHERE group_id = $1 AND account_principal_id = $2',", 'WRITER_READ',
    "both appointments' raced ALREADY_A_STEWARD: after the rollback, names the role of the row the primary key met; never authority or disclosure"],
  ['services/GroupStewardService.ts', "'SELECT role, appointed_by_principal_id FROM group_stewards WHERE group_id = $1 AND account_principal_id = $2 FOR UPDATE',", 'WRITER_READ',
    "the removal's target lock (step 4): absent is 404, an owner row is refused to an owner; never authority"],
  ['services/ChangeRequestService.ts', 'EXISTS (SELECT 1 FROM group_stewards g WHERE g.group_id = ANY($3::uuid[]) AND g.account_principal_id IN (SELECT id FROM subtree)) AS steward`,', 'SELF_DECISION',
    "card 502fb19e (E325 section 5.5): a steward-row holder of a Group grantee or subject, live or inert, never decides that change; it can only refuse, never confer authority"],
];

describe('LC-C2 - the steward-reader register', () => {
  // The writers are LC-C1's; every OTHER line is a reader and is classified here.
  const lines = census(/\bgroup_stewards\b/).filter((hit) => !isComment(hit.line) && !WRITE.test(hit.line));

  it('every non-comment line naming group_stewards is classified, and no entry outlives its line', () => {
    expect(lines.map((hit) => [hit.file, hit.line]).sort())
      .toEqual(READER_REGISTER.map(([file, line]) => [file, line]).sort());
  });

  it('the catalog and SR-2 reach steward rows only through the fragment', () => {
    expect(read('services/DirectoryCarriageService.ts')).not.toMatch(/\bgroup_stewards\b/);
    expect(read('services/DirectoryCarriageService.ts')).toContain('liveStewardRows({ group: null, account: \'$1\', roles: \'$2::text[]\' })');
    const service = read('services/GroupStewardService.ts');
    const grants = service.slice(service.indexOf('  async groupGrants('), service.indexOf('\n  }\n', service.indexOf('  async groupGrants(')));
    expect(grants).toContain('this.isLive(pool, id, viewer.sessionPrincipalId, GROUP_STEWARD_ROLES)');
    const isLive = service.slice(service.indexOf('  async isLive('), service.indexOf('\n  }\n', service.indexOf('  async isLive(')));
    expect(isLive).toContain('liveStewardCondition(');
  });

  it('the gate standing reads the fragment with its row locks', () => {
    const service = read('services/GroupStewardService.ts');
    const start = service.indexOf('  async requireGroupOwnerStanding(');
    const body = service.slice(start, service.indexOf('\n  }\n', start));
    expect(body).toContain("liveStewardRows({ group: '$1', account: '$2', roles: \"ARRAY['owner']::text[]\", lock: true })");
    expect(liveStewardRows({ group: '$1', account: '$2', roles: '$3', lock: true })).toMatch(/FOR SHARE OF steward_row, steward_member$/);
    expect(liveStewardCondition({ group: '$1', account: '$2', roles: '$3' })).not.toMatch(/FOR SHARE/);
  });
});

// ─────────────────────────── LC-C3: the routes ───────────────────────────

const ROUTES: Array<[string, string, string]> = [
  ['GET', '/groups/0b7a5ff6-3c1d-4c21-9a4f-1f1f1f1f1f1f/stewards', 'principals:read'],
  ['GET', '/groups/0b7a5ff6-3c1d-4c21-9a4f-1f1f1f1f1f1f/grants', 'principals:read'],
  ['POST', '/groups/0b7a5ff6-3c1d-4c21-9a4f-1f1f1f1f1f1f/stewards', 'root'],
  ['DELETE', '/groups/0b7a5ff6-3c1d-4c21-9a4f-1f1f1f1f1f1f/stewards/7c0e4a3e-1f2b-4c3d-8e9f-0a1b2c3d4e5f', 'root'],
  ['DELETE', '/groups/0b7a5ff6-3c1d-4c21-9a4f-1f1f1f1f1f1f/managers/7c0e4a3e-1f2b-4c3d-8e9f-0a1b2c3d4e5f', 'authenticated'],
  // c1-B (card b5c83682): gate (iii)'s appointment route; its rule is
  // asserted in order by lensesGatesRegisters.test.ts.
  ['POST', '/groups/0b7a5ff6-3c1d-4c21-9a4f-1f1f1f1f1f1f/managers', 'authenticated'],
  // Only DELETE is narrowed on a row: every other method on a managers path stays root.
  ['PUT', '/groups/0b7a5ff6-3c1d-4c21-9a4f-1f1f1f1f1f1f/managers/7c0e4a3e-1f2b-4c3d-8e9f-0a1b2c3d4e5f', 'root'],
];

describe('LC-C3 - the route register', () => {
  it.each(ROUTES)('route ceiling: %s %s resolves to %s', (method, route, scope) => {
    expect(requiredScopeFor(method, route)).toBe(scope);
  });

  it('the managers rule is listed BEFORE the /groups rules (first match wins)', () => {
    const map = read('utils/scopeMap.ts');
    const managers = map.indexOf("{ pattern: /^\\/groups\\/[^/]+\\/managers\\/[^/]+$/, methods: ['DELETE'], scope: 'authenticated' },");
    const family = map.indexOf("{ pattern: /^\\/groups(\\/|$)/, scope: 'root' },");
    const sync = map.indexOf("{ pattern: /^\\/groups\\/directory-sync$/, scope: 'root' },");
    expect(managers).toBeGreaterThan(-1);
    expect(sync).toBeGreaterThan(managers);
    expect(family).toBeGreaterThan(managers);
  });

  it('the root acts test the login session, then root, before the service', () => {
    const routes = read('routes/groups.ts');
    const helper = routes.slice(routes.indexOf('function rootSessionRefusal('), routes.indexOf('\n}\n', routes.indexOf('function rootSessionRefusal(')));
    const session = helper.indexOf('classifyLoginSession(req.authMethod, act)');
    const root = helper.indexOf("if (!req.scopes?.includes('root')) {");
    expect(session).toBeGreaterThan(-1);
    expect(root).toBeGreaterThan(session);
    for (const [route, call] of [
      ["router.post('/:id/stewards'", 'groupStewardService.appoint('],
      ["router.delete('/:id/stewards/:principalId'", 'groupStewardService.removeAsRoot('],
    ]) {
      const start = routes.indexOf(route);
      const body = routes.slice(start, routes.indexOf('\n});\n', start));
      const refusal = body.indexOf('const refusal = rootSessionRefusal(req,');
      expect({ route, refusalFirst: refusal > -1 && refusal < body.indexOf(call) }).toEqual({ route, refusalFirst: true });
    }
  });

  it('the owner removal runs the standing, then the target refusals, then the step-up, in one transaction', () => {
    const service = read('services/GroupStewardService.ts');
    const remover = service.slice(service.indexOf('  async removeManagerAsOwner('), service.indexOf('  private async removeRow('));
    expect(remover.indexOf("await client.query('BEGIN');")).toBeLessThan(remover.indexOf('this.requireGroupOwnerStanding(client,'));
    expect(remover.indexOf('this.requireGroupOwnerStanding(client,')).toBeLessThan(remover.indexOf('this.removeRow(client,'));
    // The ONE consume is removeRow's, after the refusals; the act itself never spends early.
    expect(remover).not.toContain('stepUpService.consume(');
    const row = service.slice(service.indexOf('  private async removeRow('), service.indexOf('  async isLive('));
    const notFound = row.indexOf("'STEWARD_NOT_FOUND'");
    const ownerRow = row.indexOf("'STEWARD_OWNER_ROW_ROOT_ONLY'");
    const consume = row.indexOf('stepUpService.consume(client, {');
    expect(notFound).toBeGreaterThan(-1);
    expect(ownerRow).toBeGreaterThan(notFound);
    expect(consume).toBeGreaterThan(ownerRow);
    expect(row.slice(consume)).toMatch(/action: GROUP_MANAGER_REMOVE_ACT,\s+targetId: groupId,/);
    expect(row.indexOf("'DELETE FROM group_stewards")).toBeGreaterThan(consume);
  });
});

// ─────────────────────────── LC-C7: one elevated set ───────────────────────────

describe('LC-C7 - one elevated-role set', () => {
  const sorted = [...ELEVATED_ROLES].sort();

  it('the fragment builds its role condition from ELEVATED_ROLES, both directions', () => {
    const list = elevatedRoleSqlList().split(',').map((value) => value.trim().replace(/^'|'$/g, '')).sort();
    expect(list).toEqual(sorted);
    const fragment = liveStewardRows({ group: '$1', account: '$2', roles: '$3' });
    const inFragment = /steward_holder\.role NOT IN \(([^)]*)\)/.exec(fragment)?.[1] ?? '';
    expect(inFragment.split(',').map((value) => value.trim().replace(/^'|'$/g, '')).sort()).toEqual(sorted);
  });

  it("migration 152's holder trigger refuses exactly ELEVATED_ROLES, both directions", () => {
    const migration = read('migrations/152_lenses_c_group_stewards.sql');
    const match = /IF holder_role IN \(([^)]*)\) THEN/.exec(migration);
    expect(match).not.toBeNull();
    expect(String(match?.[1]).split(',').map((value) => value.trim().replace(/^'|'$/g, '')).sort()).toEqual(sorted);
  });

  it("the trigger's kind test is a POSITIVE allowlist: human and service, nothing else", () => {
    const migration = read('migrations/152_lenses_c_group_stewards.sql');
    expect(migration).toContain("IF holder_kind NOT IN ('human', 'service') THEN");
    expect(migration).not.toMatch(/holder_kind\s*(=|<>|!=)\s*'agent'/);
  });
});
