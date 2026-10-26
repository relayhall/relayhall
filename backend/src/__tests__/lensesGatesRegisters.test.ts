/**
 * Card b5c83682 - LENSES-c build c1-B, the census controls of the design
 * delta's test plan (G.1) for the owner-only gates and the manager lens, as
 * properties of SOURCE. The live suite (lensesGatesLive.test.ts) measures rows;
 * this suite keeps the tree from drifting away from the shape they were
 * measured on. The writer and reader registers (LC-C1, LC-C2) and LC-C7 stay in
 * groupStewardsRegisters.test.ts, which now registers gate (iii)'s INSERT.
 *
 *   LC-C3  THE ROUTE REGISTER for c1-B's routes: each scope rule as the
 *          first-match table resolves it, the explicit rule's POSITION asserted
 *          (the managers POST rule before the /groups rules; the task steward
 *          rule before the /tasks family rules, CC-8; the project steward rule
 *          before the project owner and family rules), and the point stage's
 *          action for each route.
 *   C.4    gate (iii)'s predicate order: the standing, then the appointee, then
 *          the ONE step-up consume, then the manager-only INSERT.
 *   C.5    gate (i): the administrator test runs first and unchanged; the
 *          Group-owner arm runs only after it refused, on the live-owner
 *          fragment with its locks, and consumes ('charter.approve', project).
 *   C.6    gate (ii) and DD-5: the steward routes never consult decide() or
 *          mayTransfer(); the standing precedes the revision and both precede
 *          the step-up.
 *   C.7    no gate evaluates the admin verb.
 *   C.8    the manager lens reads the live-steward fragment and nothing else.
 */
import fs from 'fs';
import path from 'path';

import { requiredScopeFor } from '../utils/scopeMap';
import { pointAuthorizationTarget } from '../middleware/sharedAuthorization';

const SRC = path.join(__dirname, '..');
const read = (file: string): string => fs.readFileSync(path.join(SRC, file), 'utf8');
const G = '0b7a5ff6-3c1d-4c21-9a4f-1f1f1f1f1f1f';
const P = '7c0e4a3e-1f2b-4c3d-8e9f-0a1b2c3d4e5f';

/** The body of a method or function, from its signature to the first close at its own indentation. */
function bodyOf(source: string, signature: string, close = '\n  }\n'): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`signature not found: ${signature}`);
  return source.slice(start, source.indexOf(close, start));
}

// ─────────────────────────── LC-C3: the routes ───────────────────────────

const ROUTES: Array<[string, string, string]> = [
  ['POST', `/groups/${G}/managers`, 'authenticated'],
  // Only POST (and c1-A's DELETE on a row) is narrowed: every other method stays where it was.
  ['PUT', `/groups/${G}/managers`, 'root'],
  ['GET', `/groups/${G}/managers`, 'principals:read'],
  ['PUT', `/projects/${P}/owner/steward`, 'projects:write'],
  ['PUT', `/tasks/${P}/account-owner/steward`, 'tasks:write'],
  ['POST', `/projects/${P}/charter/approve`, 'projects:write'],
  // The administrator routes are unchanged (the task one stays shadowed, CC-8 / LC-DD-18).
  ['PUT', `/projects/${P}/owner`, 'projects:admin'],
  ['PUT', `/tasks/${P}/account-owner`, 'tasks:write'],
];

describe('LC-C3 - the c1-B route register', () => {
  it.each(ROUTES)('c1-B route ceiling: %s %s resolves to %s', (method, route, scope) => {
    expect(requiredScopeFor(method, route)).toBe(scope);
  });

  const map = read('utils/scopeMap.ts');
  const at = (rule: string): number => {
    const index = map.indexOf(rule);
    expect({ rule, present: index > -1 }).toEqual({ rule, present: true });
    return index;
  };

  it('the managers POST rule is listed BEFORE the /groups rules (first match wins)', () => {
    const managers = at("{ pattern: /^\\/groups\\/[^/]+\\/managers$/, methods: ['POST'], scope: 'authenticated' },");
    expect(at("{ pattern: /^\\/groups\\/directory-sync$/, scope: 'root' },")).toBeGreaterThan(managers);
    expect(at("{ pattern: /^\\/groups(\\/|$)/, methods: ['GET'], scope: 'principals:read' },")).toBeGreaterThan(managers);
    expect(at("{ pattern: /^\\/groups(\\/|$)/, scope: 'root' },")).toBeGreaterThan(managers);
  });

  it('the task steward rule is listed BEFORE the /tasks family rules (CC-8)', () => {
    const steward = at("{ pattern: /^\\/tasks\\/[^/]+\\/account-owner\\/steward$/, methods: ['PUT'], scope: 'tasks:write' },");
    expect(at("{ pattern: /^\\/tasks(\\/|$)/, methods: ['GET'], scope: 'tasks:read' },")).toBeGreaterThan(steward);
    expect(at("{ pattern: /^\\/tasks(\\/|$)/, scope: 'tasks:write' },")).toBeGreaterThan(steward);
  });

  it('the project steward rule is listed BEFORE the project owner rule and the /projects family rules', () => {
    const steward = at("{ pattern: /^\\/projects\\/[^/]+\\/owner\\/steward$/, methods: ['PUT'], scope: 'projects:write' },");
    expect(at("{ pattern: /^\\/projects\\/[^/]+\\/owner$/, methods: ['PUT'], scope: 'projects:admin' },")).toBeGreaterThan(steward);
    expect(at("{ pattern: /^\\/projects(\\/|$)/, scope: 'projects:write' },")).toBeGreaterThan(steward);
  });

  it('the point stage asks write on both steward routes and on the Charter approval (the gate is in the handler)', () => {
    expect(pointAuthorizationTarget('PUT', `/projects/${P}/owner/steward`)).toMatchObject({ type: 'project', action: 'write' });
    expect(pointAuthorizationTarget('PUT', `/tasks/${P}/account-owner/steward`)).toMatchObject({ type: 'task', action: 'write' });
    expect(pointAuthorizationTarget('POST', `/projects/${P}/charter/approve`)).toMatchObject({ type: 'project', action: 'write' });
  });

  it('each new route is mounted on its router, and every handler calls its gate', () => {
    expect(read('routes/groups.ts')).toContain("router.post('/:id/managers',");
    expect(read('routes/groups.ts')).toContain('groupStewardService.appointManagerAsOwner(');
    expect(read('routes/projects.ts')).toContain("router.put('/:id/owner/steward',");
    expect(read('routes/projects.ts')).toContain('projectOwnershipService.changeAsGroupOwner(');
    expect(read('routes/tasks.ts')).toContain("router.put('/:id/account-owner/steward',");
    expect(read('routes/tasks.ts')).toContain('taskAccountOwnershipService.changeAsGroupOwner(');
  });
});

// ─────────────────────────── C.4: gate (iii) ───────────────────────────

describe('C.4 - gate (iii) runs its predicate in order, in one transaction', () => {
  const service = read('services/GroupStewardService.ts');

  it('the appointment runs the standing, then the appointee, then the ONE step-up, then the manager INSERT', () => {
    const act = bodyOf(service, '  async appointManagerAsOwner(');
    const begin = act.indexOf("await client.query('BEGIN');");
    const standing = act.indexOf('this.requireGroupOwnerStanding(client,');
    const appointee = act.indexOf('this.requireEligibleManagerAppointee(client,');
    const consume = act.indexOf('stepUpService.consume(client, {');
    const insert = act.indexOf("VALUES ($1, $2, 'manager', $3)");
    expect(begin).toBeGreaterThan(-1);
    expect(standing).toBeGreaterThan(begin);
    expect(appointee).toBeGreaterThan(standing);
    expect(consume).toBeGreaterThan(appointee);
    expect(insert).toBeGreaterThan(consume);
    expect(act.slice(consume)).toMatch(/action: GROUP_MANAGER_APPOINT_ACT,\s+targetId: id,/);
    expect(act.match(/stepUpService\.consume\(/g)).toHaveLength(1);
  });

  it('the appointment uses its own codes and never writes an owner', () => {
    const act = bodyOf(service, '  async appointManagerAsOwner(');
    expect(act).toContain('requiresSession: GROUP_MANAGER_APPOINT_REQUIRES_SESSION,');
    expect(act).toContain('requiresOwner: GROUP_MANAGER_APPOINT_REQUIRES_OWNER,');
    expect(act).not.toMatch(/'owner'/);
  });

  it('the appointee check takes the member row FOR SHARE and reads the holder rules before any write', () => {
    const check = bodyOf(service, '  async requireEligibleManagerAppointee(');
    expect(check).toMatch(/FROM group_members[\s\S]*FOR SHARE/);
    expect(check).toContain("'MANAGER_NOT_A_GROUP_MEMBER'");
    expect(check).toContain("'ALREADY_A_STEWARD'");
    expect(check).toContain('stewardIneligibility(');
    expect(check.indexOf("'MANAGER_NOT_A_GROUP_MEMBER'")).toBeLessThan(check.indexOf("'ALREADY_A_STEWARD'"));
  });

  it('the route refuses a body role key by name, before the service', () => {
    const routes = read('routes/groups.ts');
    const handler = bodyOf(routes, "router.post('/:id/managers',", '\n});\n');
    expect(handler).toContain("['accountPrincipalId', 'stepUpToken']");
    expect(handler.indexOf("code: 'UNKNOWN_FIELD'")).toBeLessThan(handler.indexOf('groupStewardService.appointManagerAsOwner('));
  });
});

// ─────────────────────────── C.5: gate (i) ───────────────────────────

describe('C.5 - gate (i) runs only after the administrator test has refused', () => {
  const charter = read('services/CharterService.ts');
  const approver = bodyOf(charter, 'async function requireCharterApprover(', '\n}\n');

  it('the administrator test is evaluated before the Group-owner arm, and the arm is the only step-up consumer', () => {
    const admin = approver.indexOf("'admin', executor)");
    const arm = approver.indexOf('await charterGroupOwnerArm(');
    expect(admin).toBeGreaterThan(-1);
    expect(arm).toBeGreaterThan(admin);
    expect(approver).not.toContain('stepUpService.consume(');
  });

  it('the arm requires an ACTIVE Group owner, the live owner fragment with its locks, and consumes (charter.approve, project id)', () => {
    const arm = bodyOf(charter, 'async function charterGroupOwnerArm(', '\n}\n');
    expect(arm).toContain("owner.kind !== 'group' || owner.status !== 'active'");
    expect(arm).toContain("liveStewardRows({ group: '$1', account: '$2', roles: \"ARRAY['owner']::text[]\", lock: true })");
    expect(arm).toMatch(/action: CHARTER_APPROVE_ACT,\s+targetId: canonicalProjectId,/);
    expect(arm.indexOf('liveStewardRows(')).toBeLessThan(arm.indexOf('stepUpService.consume('));
  });

  it('the approve route admits the stepUpToken key and threads it through the approval actor', () => {
    const routes = read('routes/projects.ts');
    const handler = bodyOf(routes, "router.post('/:id/charter/approve',", '\n});\n');
    expect(handler).toContain("const allowed = ['content', 'stepUpToken'];");
    expect(handler).toContain('stepUpToken: typeof body.stepUpToken === \'string\' ? body.stepUpToken : undefined');
  });
});

// ─────────────────────────── C.6: gate (ii) and DD-5 ───────────────────────────

describe('C.6 - the steward transfers decide by the gate alone', () => {
  const project = read('services/ProjectOwnershipService.ts');
  const tasks = read('services/TaskAccountOwnershipService.ts');
  const gate = read('services/GroupOwnerStewardTransfer.ts');

  it('neither steward act consults decide() or mayTransfer(), and both run the standing before the step-up', () => {
    for (const [name, act] of [
      ['project', bodyOf(project, '  async changeAsGroupOwner(')],
      ['task', bodyOf(tasks, '  async changeAsGroupOwner(')],
    ]) {
      expect({ name, decide: /\bdecide\(/.test(act), mayTransfer: /\bmayTransfer\(/.test(act) })
        .toEqual({ name, decide: false, mayTransfer: false });
      const standing = act.indexOf('stewardTransferStanding(client,');
      const consume = act.indexOf('consumeStewardTransferStepUp(client,');
      expect({ name, standing: standing > -1, consumeAfter: consume > standing }).toEqual({ name, standing: true, consumeAfter: true });
    }
  });

  it('the project act checks the If-Match revision before the step-up', () => {
    const act = bodyOf(project, '  async changeAsGroupOwner(');
    expect(act.indexOf("'REVISION_MISMATCH'")).toBeGreaterThan(-1);
    expect(act.indexOf("'REVISION_MISMATCH'")).toBeLessThan(act.indexOf('consumeStewardTransferStepUp(client,'));
  });

  it('the task act checks its preconditions before the step-up', () => {
    const act = bodyOf(tasks, '  async changeAsGroupOwner(');
    expect(act.indexOf("'ACCOUNT_OWNER_STATE_CHANGED'")).toBeGreaterThan(-1);
    expect(act.indexOf("'ACCOUNT_OWNER_STATE_CHANGED'")).toBeLessThan(act.indexOf('consumeStewardTransferStepUp(client,'));
  });

  it('the standing admits exactly the two shapes, on the live owner fragment with its locks', () => {
    expect(gate).toContain("'STEWARD_TRANSFER_SHAPE_REFUSED'");
    expect(gate).toContain("'NOT_THE_CURRENT_OWNER'");
    expect(gate).toContain("'TARGET_NOT_A_GROUP_MEMBER'");
    expect(gate).toContain("liveStewardRows({ group: '$1', account: '$2', roles: \"ARRAY['owner']::text[]\", lock: true })");
    expect(gate).toMatch(/action: OWNERSHIP_TRANSFER_STEP_UP_ACTION,\s+targetId: input\.objectId,/);
  });
});

// ─────────────────────────── C.7: never the admin verb ───────────────────────────

describe('C.7 - no gate evaluates the admin verb', () => {
  it('the gate modules and acts name no admin action and no *:admin scope', () => {
    const sources: Array<[string, string]> = [
      ['GroupOwnerStewardTransfer.ts', read('services/GroupOwnerStewardTransfer.ts')],
      ['appointManagerAsOwner', bodyOf(read('services/GroupStewardService.ts'), '  async appointManagerAsOwner(')],
      ['requireEligibleManagerAppointee', bodyOf(read('services/GroupStewardService.ts'), '  async requireEligibleManagerAppointee(')],
      ['charterGroupOwnerArm', bodyOf(read('services/CharterService.ts'), 'async function charterGroupOwnerArm(', '\n}\n')],
      ['project changeAsGroupOwner', bodyOf(read('services/ProjectOwnershipService.ts'), '  async changeAsGroupOwner(')],
      ['task changeAsGroupOwner', bodyOf(read('services/TaskAccountOwnershipService.ts'), '  async changeAsGroupOwner(')],
    ];
    for (const [name, source] of sources) {
      const code = source.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n');
      expect({ name, admin: /'admin'|:admin'/.test(code) }).toEqual({ name, admin: false });
    }
  });
});

// ─────────────────────────── C.8: the manager lens ───────────────────────────

describe('C.8 - the manager lens reads the live-steward fragment', () => {
  it('the stewarded Groups come from the fragment with both roles, owners first', () => {
    const lens = bodyOf(read('services/GroupStewardService.ts'), '  async stewardedGroupsFor(');
    expect(lens).toContain("liveStewardRows({ group: null, account: '$1', roles: \"ARRAY['owner', 'manager']::text[]\" })");
    expect(lens).toMatch(/ORDER BY CASE live\.role WHEN 'owner' THEN 0 ELSE 1 END/);
    expect(lens).not.toMatch(/\bgroup_stewards\b/);
  });

  it('the route hands the rows to the derivation, which emits the arm only when there is at least one', () => {
    const route = read('routes/principals.ts');
    expect(route).toContain('const stewardedGroups = await groupStewardService.stewardedGroupsFor(req.principal.id);');
    expect(route).toContain('res.json(lensesFor({ authMethod: req.authMethod, rootAuthorized, stewardedGroups }));');
    const lenses = read('utils/lenses.ts');
    expect(lenses).toContain('if (stewardedGroups.length > 0) {');
  });
});
