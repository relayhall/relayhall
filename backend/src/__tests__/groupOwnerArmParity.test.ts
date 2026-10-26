/**
 * Card ee81ee0f — AZ-A12 build 2 (clauses 6-8, ruling E72): the STRUCTURE of
 * the Group-owner arm, measured on the predicate text itself (no database).
 * The behaviour over stored rows is groupOwnerArmLive.test.ts.
 *
 *   T  the tier is chosen in TypeScript from the action: read/use/invoke need
 *      the member (use) tier, write/claim/finish/release the edit tier, and
 *      admin, shepherd and verify have NO tier - for them no Group arm is
 *      rendered on any type, on either plane.
 *   F  ONE shared fragment: the evaluator files name neither `group_members`
 *      nor the steward relation; the fragment composes LENSES-c's live-steward
 *      fragment for the edit tier and binds nothing of its own.
 *   A  Account side only (clause 8): on the delegation chain the Group arms
 *      appear only among the Account link's sources, never inside
 *      `authorityCore` (the grant, profile and exact-Project-Grant sources
 *      every delegated link evaluates), and never for a parented acting
 *      identity on the Account plane.
 *   R  the restriction rules (clause 7): a restricted Phase or Task keeps the
 *      edit tier and loses the use tier on path (a); path (b) is suppressed by
 *      restriction and gated by the Project anchor, and renders nothing when
 *      the shape lacks its metadata (fail closed).
 *   M  in-memory fast-path parity: the point evaluator never allows on a
 *      Group owner value, for any action, so every Group-owned row reaches the
 *      SQL adapter (R40).
 */
import fs from 'fs';
import path from 'path';
import {
  AUTHORIZATION_ACTIONS,
  authorizationService,
  type AuthorizationActor,
  type AuthorizationSqlResource,
} from '../services/AuthorizationService';
import { authorizationRepository } from '../services/AuthorizationRepository';
import {
  GROUP_EDIT_TIER_ACTIONS,
  GROUP_OWNABLE_TYPES,
  GROUP_USE_TIER_ACTIONS,
  groupOwnerCondition,
  groupOwnerTierFor,
} from '../utils/groupOwnerCondition';
import { liveStewardCondition } from '../utils/liveStewardCondition';

const SRC = path.join(__dirname, '..');
const read = (file: string): string => fs.readFileSync(path.join(SRC, file), 'utf8');

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CONNECTOR = '22222222-2222-4222-8222-222222222222';
const GROUP = '33333333-3333-4333-8333-333333333333';
const FRAGMENT_MARK = 'owning_group';

const account: AuthorizationActor = {
  principalId: ACCOUNT, handle: 'account', role: 'editor', scopes: ['tasks:read', 'tasks:write'], authenticated: true,
};
const connector: AuthorizationActor = {
  principalId: CONNECTOR, handle: 'connector', role: 'user', scopes: ['tasks:read', 'tasks:write'], authenticated: true,
  delegation: {
    links: [
      {
        principalId: CONNECTOR, kind: 'service', role: 'user', parentPrincipalId: ACCOUNT, boundTaskId: null,
        legacyIdentity: false, ownExpression: { scopes: 'parent', objects: 'parent' },
      },
      {
        principalId: ACCOUNT, kind: 'human', role: 'editor', parentPrincipalId: null, boundTaskId: null,
        legacyIdentity: false, ownExpression: null,
      },
    ],
  },
};

const shape = (type: string): AuthorizationSqlResource => authorizationRepository.sqlResource(type as any).resource;
const SHAPED_TYPES = ['task', 'phase', 'project', 'report', 'blueprint', 'skill', 'personality', 'service'];

function sources(actor: AuthorizationActor, action: string, resource: AuthorizationSqlResource) {
  return authorizationService.sqlCondition(actor, action as any, resource, 1, { includeSources: true }).sources ?? [];
}

describe('T - the tier is chosen from the action', () => {
  it('maps every evaluator action to exactly one tier, and admin, shepherd and verify to none', () => {
    const table = Object.fromEntries(AUTHORIZATION_ACTIONS.map((action) => [action, groupOwnerTierFor(action)]));
    expect(table).toEqual({
      read: 'use', use: 'use', invoke: 'use',
      write: 'edit', claim: 'edit', finish: 'edit', release: 'edit',
      admin: null, shepherd: null, verify: null,
    });
    expect([...GROUP_USE_TIER_ACTIONS].sort()).toEqual(['invoke', 'read', 'use']);
    expect([...GROUP_EDIT_TIER_ACTIONS].sort()).toEqual(['claim', 'finish', 'invoke', 'read', 'release', 'use', 'write']);
  });

  it.each(['admin', 'shepherd', 'verify'])('renders no Group arm for %s on any type, on either plane', (action) => {
    for (const type of SHAPED_TYPES) {
      for (const actor of [account, connector]) {
        const decision = authorizationService.sqlCondition(actor, action as any, shape(type), 1);
        expect([type, decision.sql.includes(FRAGMENT_MARK)]).toEqual([type, false]);
      }
    }
  });

  it('renders the arm only for the Group-ownable types', () => {
    // Card d67e6990 (AZ-A12 build 4, M-c): the Skill owner column joined the four.
    expect([...GROUP_OWNABLE_TYPES].sort()).toEqual(['phase', 'project', 'report', 'skill', 'task']);
    for (const type of SHAPED_TYPES) {
      const rendered = authorizationService.sqlCondition(account, 'read', shape(type), 1).sql.includes(FRAGMENT_MARK);
      expect([type, rendered]).toEqual([type, GROUP_OWNABLE_TYPES.includes(type)]);
    }
  });

  it('the use tier tests membership only; the edit tier composes the live-steward fragment', () => {
    const use = groupOwnerCondition({ owner: 'p.owner_principal_id', account: '$1', tier: 'use' });
    const edit = groupOwnerCondition({ owner: 'p.owner_principal_id', account: '$1', tier: 'edit' });
    expect(use).not.toContain('steward_row');
    expect(edit).toContain(liveStewardCondition({
      group: 'owning_group.id', account: 'owning_group_account.id', roles: "ARRAY['owner', 'manager']::text[]",
    }));
    for (const text of [use, edit]) {
      expect(text).toContain("owning_group.kind = 'group'");
      expect(text).toContain("owning_group.status = 'active'");
      expect(text).toContain("owning_group_account.status = 'active'");
      expect(text.match(/\$\d+/g)).toEqual(['$1']);
    }
  });

  it('a write decision binds no more parameters than its text references (the equalityLazy rule)', () => {
    for (const action of AUTHORIZATION_ACTIONS) {
      for (const type of ['task', 'phase', 'project', 'report']) {
        for (const actor of [account, connector]) {
          const { sql, params } = authorizationService.sqlCondition(actor, action, shape(type), 1);
          const referenced = new Set((sql.match(/\$(\d+)/g) ?? []).map((token) => Number(token.slice(1))));
          expect([action, type, referenced.size]).toEqual([action, type, params.length]);
        }
      }
    }
  });
});

describe('F - one shared fragment', () => {
  it('the evaluator files name neither group_members nor the steward relation', () => {
    for (const file of ['services/AuthorizationService.ts', 'services/AuthorizationRepository.ts']) {
      expect([file, /\bgroup_members\b|\bgroup_stewards\b/.test(read(file))]).toEqual([file, false]);
    }
  });

  it('the fragment reads the steward relation only through LENSES-c\'s fragment', () => {
    const text = read('utils/groupOwnerCondition.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(text).not.toMatch(/\bgroup_stewards\b/);
    expect(text).toContain('liveStewardCondition(');
  });

  it('both planes and every Group-ownable type render the SAME fragment text', () => {
    const expected = groupOwnerCondition({ owner: 'p.owner_principal_id', account: '$1', tier: 'edit' });
    const accountSql = authorizationService.sqlCondition(account, 'write', shape('project'), 1).sql;
    expect(accountSql).toContain(expected);
    const chainSource = sources(connector, 'write', shape('project'))
      .find((source) => source.basis === 'account-group-owner');
    expect(chainSource).toBeDefined();
    expect(chainSource?.sql.replace(/\$\d+/g, '$1')).toBe(expected);
  });
});

describe('A - Account side only (clause 8)', () => {
  it.each(['read', 'write'])('on the chain, %s: the Group arms are Account-link sources and never inside authorityCore', (action) => {
    for (const type of ['task', 'phase', 'project', 'report']) {
      const all = sources(connector, action, shape(type));
      for (const source of all) {
        if (['grant', 'profile', 'inherited-project-grant', 'role-grant'].includes(source.basis)) {
          expect([type, source.basis, source.sql.includes(FRAGMENT_MARK)]).toEqual([type, source.basis, false]);
        }
      }
      const group = all.filter((source) => source.sql.includes(FRAGMENT_MARK) && source.basis !== 'delegation-chain');
      expect(group.length).toBeGreaterThan(0);
      for (const source of group) expect(source.basis.startsWith('account-group-')).toBe(true);
      // The fragment binds the ACCOUNT's id, never the Connector's.
      const { sql, params } = authorizationService.sqlCondition(connector, action as any, shape(type), 1);
      const bound = (sql.match(/owning_group_account\.id = \$(\d+)::uuid/g) ?? [])
        .map((match) => params[Number(match.replace(/.*\$(\d+).*/, '$1')) - 1]);
      expect(bound.length).toBeGreaterThan(0);
      expect(new Set(bound)).toEqual(new Set([ACCOUNT]));
    }
  });

  it('a parented legacy identity on the Account plane gets no Group arm', () => {
    const legacy: AuthorizationActor = {
      ...connector,
      delegation: { links: connector.delegation!.links.map((link, index) => (index === 0 ? { ...link, legacyIdentity: true } : link)) },
    };
    for (const type of ['task', 'phase', 'project', 'report']) {
      expect(authorizationService.sqlCondition(legacy, 'read', shape(type), 1).sql.includes(FRAGMENT_MARK)).toBe(false);
    }
  });
});

describe('R - restriction and the inherited path (clause 7)', () => {
  it('a restricted shape keeps the edit tier and gates the use tier on read', () => {
    const task = shape('task');
    const readArms = sources(account, 'read', task).filter((source) => source.basis === 'group-owner');
    expect(readArms).toHaveLength(1);
    expect(readArms[0].sql).toContain(`(NOT (${task.restrictedAccess}) AND `);
    expect(readArms[0].sql).toContain('steward_row');
    const phaseRead = sources(account, 'read', shape('phase')).find((source) => source.basis === 'group-owner');
    expect(phaseRead?.sql).toContain('NOT (ph.restricted_access)');
    const writeArm = sources(account, 'write', task).find((source) => source.basis === 'group-owner');
    expect(writeArm).toBeDefined();
    expect(writeArm?.sql).not.toContain('NOT (');
  });

  it('path (b) reads the Project owner under the anchor and NOT restricted, for the Task write subset only', () => {
    const task = shape('task');
    expect(task.projectOwner).toBe('p.owner_principal_id');
    for (const action of AUTHORIZATION_ACTIONS) {
      const arm = sources(account, action, task).find((source) => source.basis === 'group-project-owner');
      const expected = ['read', 'write', 'claim', 'finish', 'release'].includes(action);
      expect([action, Boolean(arm)]).toEqual([action, expected]);
      if (arm) {
        expect(arm.sql).toContain(`((${task.inheritanceAnchor}) AND NOT (${task.restrictedAccess})`);
        expect(arm.sql).toContain(`owning_group.id = ${task.projectOwner}`);
        expect(arm.sql.includes('steward_row')).toBe(action !== 'read');
      }
    }
  });

  it('path (b) renders nothing when the shape lacks its metadata (fail closed), and never on other types', () => {
    const task = shape('task');
    for (const missing of ['projectOwner', 'inheritanceAnchor', 'restrictedAccess'] as const) {
      const partial = { ...task, [missing]: undefined };
      expect([missing, sources(account, 'read', partial).some((s) => s.basis === 'group-project-owner')]).toEqual([missing, false]);
    }
    for (const type of ['phase', 'project', 'report']) {
      expect(sources(account, 'read', shape(type)).some((s) => s.basis === 'group-project-owner')).toBe(false);
    }
  });

  it('the Report arm reads its account owner, never its author', () => {
    const arm = sources(account, 'read', shape('report')).find((source) => source.basis === 'group-owner');
    expect(arm?.sql).toContain('owning_group.id = r.account_owner_principal_id');
    expect(arm?.sql).not.toContain('r.author_principal_id');
  });
});

describe('M - the in-memory fast path never allows on a Group owner value', () => {
  it.each(['task', 'phase', 'project', 'report'])('%s: every action falls through to SQL', (type) => {
    const resource = {
      type: type as any, id: '44444444-4444-4444-8444-444444444444',
      ownerPrincipalId: GROUP, accountOwnerPrincipalId: GROUP,
    };
    for (const action of AUTHORIZATION_ACTIONS) {
      for (const actor of [account, connector]) {
        expect([type, action, authorizationService.authorizeResource(actor, action, resource, []).allowed])
          .toEqual([type, action, false]);
      }
    }
  });
});
