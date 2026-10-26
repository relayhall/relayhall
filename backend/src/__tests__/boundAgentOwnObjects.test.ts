/**
 * AZ-A10 clause 9 supersedes c334177b's implicit empty-list default.
 * An Agent with `objects: []` keeps that empty own() list. Its Task role is
 * supplied by live stored role-linked grants, still inside the delegated
 * own() intersection and the final bound-Task cap. These pins check the
 * pure read, SQL role-row source, and explicit lifecycle cap. Live grant-row
 * materialization is covered by the database-backed role-grant drills.
 */
jest.mock('../db/connection', () => ({ pool: { query: jest.fn(async () => ({ rows: [] })) } }));

import {
  authorizationService, ownObjectsFor, type DelegationActorLink,
} from '../services/AuthorizationService';
import { explicitTaskActionCaps } from '../services/ExplicitTaskActionCaps';

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONNECTOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BOUND = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OTHER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';


function link(overrides: Partial<DelegationActorLink> & { principalId: string }): DelegationActorLink {
  return {
    kind: 'service', role: null, parentPrincipalId: null, boundTaskId: null,
    legacyIdentity: false, ownExpression: { scopes: 'parent', objects: 'parent' },
    ...overrides,
  } as DelegationActorLink;
}

const agentLink = (objects: any, overrides: Partial<DelegationActorLink> = {}): DelegationActorLink => link({
  principalId: AGENT, kind: 'agent', parentPrincipalId: CONNECTOR, boundTaskId: BOUND, boundTaskRole: 'implementer',
  ownExpression: { scopes: ['tasks:read', 'tasks:write', 'reports:read', 'reports:write'], objects },
  ...overrides,
});

function agentActor(objects: any, connectorObjects: any = 'parent'): any {
  return {
    principalId: AGENT, handle: 'agent', role: null, authenticated: true,
    scopes: ['tasks:read', 'tasks:write', 'reports:read', 'reports:write'],
    delegation: {
      links: [
        agentLink(objects),
        link({ principalId: CONNECTOR, parentPrincipalId: ACCOUNT, ownExpression: { scopes: 'parent', objects: connectorObjects } }),
        link({ principalId: ACCOUNT, kind: 'human', role: 'user' }),
      ],
    },
  };
}

const TASK_SHAPE = { type: 'task', id: 't.id', owner: 't.owner_principal_id', claimant: 't.owner_principal_id' } as any;

/** Does the rendered predicate carry an explicit own() exact-id arm? */
function carriesBoundExactArm(decision: { sql: string; params: unknown[] }): boolean {
  const index = decision.params.findIndex((param) => Array.isArray(param) && param.length === 1 && param[0] === BOUND);
  return index >= 0 && decision.sql.includes(`t.id = ANY($${index + 1}::uuid[])`);
}

describe('ownObjectsFor: no implicit empty-list authority', () => {
  it('keeps a task-bound Agent’s empty own() list empty, with no synthesized exact rule', () => {
    const empty: any[] = [];
    expect(ownObjectsFor(agentLink(empty))).toBe(empty);
  });

  it('a NON-empty list is returned exactly as stored, read-only rules included', () => {
    const readOnly = [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [BOUND], verbs: ['read'] }];
    const elsewhere = [{ resourceType: 'project', selectorForm: 'exact', selectorIds: [OTHER], verbs: ['read'] }];
    // The SAME array: nothing is copied, merged or appended.
    expect(ownObjectsFor(agentLink(readOnly))).toBe(readOnly);
    expect(ownObjectsFor(agentLink(elsewhere))).toEqual(elsewhere);
  });

  it.each([
    ['a parent-width expression', agentLink('parent'), 'parent'],
    ['no own() expression at all (inheritance is never implicit, AZ-24)', link({ principalId: AGENT, kind: 'agent', parentPrincipalId: CONNECTOR, boundTaskId: BOUND, ownExpression: null }), null],
    ['a legacy Agent', agentLink([], { legacyIdentity: true }), []],
    ['an Agent with no bound Task', agentLink([], { boundTaskId: null }), []],
    ['a parentless Agent row', agentLink([], { parentPrincipalId: null }), []],
    ['a Connector with an empty list', link({ principalId: CONNECTOR, parentPrincipalId: ACCOUNT, ownExpression: { scopes: 'parent', objects: [] } }), []],
  ])('%s is left as stored', (_label, value, expected) => {
    expect(ownObjectsFor(value as DelegationActorLink)).toEqual(expected);
  });
});

describe('the SQL chain cap reads live role-linked grants', () => {
  it.each(['write', 'claim', 'finish', 'release'])('a rule-less Agent\'s %s requires a live role row, still under the §8.2 final cap', (action) => {
    const decision = authorizationService.sqlCondition(agentActor([]), action as any, TASK_SHAPE);
    expect(carriesBoundExactArm(decision)).toBe(false);
    expect(decision.sql).toContain('EXISTS (SELECT 1 FROM access_vehicle_links role_link');
    expect(decision.sql).toContain("role_link.vehicle_kind = 'role'");
    expect(decision.sql).toContain('role_grant.grantee_id = ANY(');
    expect(decision.sql).toContain('role_grant.resource_id = t.id');
    expect(decision.sql).toContain('role_grant.expires_at > clock_timestamp()');
    expect(decision.sql).toContain('role_link.expires_at > clock_timestamp()');
    expect(decision.params).toContainEqual([AGENT]);
    // T36: the final bound-Task cap still wraps the whole outcome.
    expect(decision.sql).toMatch(/AND t\.id = \$\d+\)$/);
  });

  it.each(['verify', 'shepherd'])('`write` never maps to %s through an implicit own() arm', (action) => {
    const decision = authorizationService.sqlCondition(agentActor([]), action as any, TASK_SHAPE);
    expect(carriesBoundExactArm(decision)).toBe(false);
  });

  it('admin stays above the Agent ceiling: FALSE outright', () => {
    expect(authorizationService.sqlCondition(agentActor([]), 'admin', TASK_SHAPE)).toEqual({ sql: 'FALSE', params: [] });
  });

  it('an empty own() list adds no bound-Task arm on a Report, Phase or Project', () => {
    for (const type of ['report', 'phase', 'project']) {
      const decision = authorizationService.sqlCondition(agentActor([]), 'write', { type, id: 'x.id' } as any);
      expect([type, decision.params.some((param) => Array.isArray(param) && param.includes(BOUND))]).toEqual([type, false]);
    }
  });

  it('a read-only rule list is read as written: no write-class arm for the bound Task', () => {
    const readOnly = [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [BOUND], verbs: ['read'] }];
    expect(carriesBoundExactArm(authorizationService.sqlCondition(agentActor(readOnly), 'claim', TASK_SHAPE))).toBe(false);
    expect(carriesBoundExactArm(authorizationService.sqlCondition(agentActor(readOnly), 'read', TASK_SHAPE))).toBe(true);
  });

  it('an empty Agent cap depends on a live role row instead of literal FALSE or an implicit exact rule', () => {
    const decision = authorizationService.sqlCondition(agentActor([]), 'claim', TASK_SHAPE);
    expect(decision.sql).not.toMatch(/\(FALSE AND \(FALSE OR /);
    expect(carriesBoundExactArm(decision)).toBe(false);
    expect(decision.sql).toContain('EXISTS (SELECT 1 FROM access_vehicle_links role_link');
  });
});

describe('the explicit lifecycle cap (claim admission and Report maintenance) reads through ownObjectsFor', () => {
  const task = (id: string) => ({ type: 'task', id, projectId: null } as any);

  it('an implementer Agent passes only the bound-Task write cap; the SQL predicate still requires its live role row', () => {
    expect(explicitTaskActionCaps(agentActor([]), task(BOUND), 'write')).toBe(true);
    expect(explicitTaskActionCaps(agentActor([]), task(OTHER), 'write')).toBe(false);
  });

  it.each(['verifier', 'shepherd'] as const)('a %s Agent has read but no implicit write cap', (role) => {
    const actor = agentActor([]);
    actor.delegation.links[0].boundTaskRole = role;
    expect(explicitTaskActionCaps(actor, task(BOUND), 'read')).toBe(true);
    expect(explicitTaskActionCaps(actor, task(BOUND), 'write')).toBe(false);
  });

  it('a read-only rule list fails the write cap: read as written', () => {
    const readOnly = [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [BOUND], verbs: ['read'] }];
    expect(explicitTaskActionCaps(agentActor(readOnly), task(BOUND), 'write')).toBe(false);
    expect(explicitTaskActionCaps(agentActor(readOnly), task(BOUND), 'read')).toBe(true);
  });

  it('the parent Connector\'s cap still binds: narrowed to read, the rule-less Agent fails the write cap', () => {
    const connectorReadOnly = [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [BOUND], verbs: ['read'] }];
    expect(explicitTaskActionCaps(agentActor([], connectorReadOnly), task(BOUND), 'write')).toBe(false);
  });

  it('the Agent\'s own scope cap still binds: without tasks:write the role cap cannot write', () => {
    const actor = agentActor([]);
    actor.delegation.links[0].ownExpression.scopes = ['tasks:read', 'reports:read', 'reports:write'];
    expect(explicitTaskActionCaps(actor, task(BOUND), 'write')).toBe(false);
  });
});
