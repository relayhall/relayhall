import { AuthorizationActor, AuthorizationResource, AuthorizationService } from '../services/AuthorizationService';

const service = new AuthorizationService();
const principalId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';

function actor(overrides: Partial<AuthorizationActor> = {}): AuthorizationActor {
  return {
    principalId,
    handle: 'worker',
    role: 'agent',
    scopes: ['tasks:read', 'tasks:write'],
    authenticated: true,
    ...overrides,
  };
}

function task(overrides: Partial<AuthorizationResource> = {}): AuthorizationResource {
  return {
    type: 'task',
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    visibility: 'private',
    ...overrides,
  };
}

describe('AuthorizationService', () => {
  it('enforces scoped route ceilings and fails closed on a missing scope set', () => {
    expect(service.authorizeRoute(actor(), 'tasks:read')).toEqual({ allowed: true, basis: 'route' });
    expect(service.authorizeRoute(actor(), 'reports:read')).toEqual({ allowed: false, denial: 'SCOPE_CEILING' });
    expect(service.authorizeRoute(actor({ scopes: ['root'] }), 'reports:admin')).toEqual({ allowed: true, basis: 'root' });
    expect(service.authorizeRoute(actor({ scopes: null }), 'reports:write')).toEqual({ allowed: false, denial: 'SCOPE_CEILING' });
    expect(service.authorizeRoute(actor({ role: 'orchestrator', scopes: null }), 'reports:admin')).toEqual({ allowed: false, denial: 'SCOPE_CEILING' });
    expect(service.authorizeRoute(actor({ role: 'viewer', scopes: null }), 'tasks:write')).toEqual({ allowed: false, denial: 'ROLE_CEILING' });
  });

  it('caps grants at the actor role ceiling', () => {
    const grant = [{ resourceType: 'task' as const, resourceId: task().id, verb: 'admin' as const }];
    expect(service.authorizeResource(actor({ role: 'viewer' }), 'admin', task(), grant)).toEqual({
      allowed: false,
      denial: 'ROLE_CEILING',
    });
    expect(service.authorizeResource(actor(), 'write', task(), grant).allowed).toBe(true);
  });

  it('keeps claimant, Shepherd and Verifier authority action-specific', () => {
    expect(service.authorizeResource(actor(), 'finish', task({ claimantPrincipalId: principalId })).basis).toBe('claimant');
    expect(service.authorizeResource(actor(), 'release', task({ claimantPrincipalId: principalId })).basis).toBe('claimant');
    expect(service.authorizeResource(actor(), 'verify', task({ claimantPrincipalId: principalId })).allowed).toBe(false);
    expect(service.authorizeResource(actor(), 'shepherd', task({ shepherdPrincipalId: principalId })).basis).toBe('shepherd');
    expect(service.authorizeResource(actor(), 'release', task({ shepherdPrincipalId: principalId })).basis).toBe('shepherd');
    expect(service.authorizeResource(actor(), 'write', task({ shepherdPrincipalId: principalId })).allowed).toBe(false);
    expect(service.authorizeResource(actor(), 'verify', task({ verifierPrincipalId: principalId })).basis).toBe('verifier');
    expect(service.authorizeResource(actor(), 'finish', task({ verifierPrincipalId: principalId })).allowed).toBe(false);
  });

  it('limits the legacy Verifier transition arm to Tasks without an assignment', () => {
    expect(service.authorizeResource(actor({ role: 'reviewer' }), 'verify', task()).basis).toBe('verifier');
    expect(service.authorizeResource(
      actor({ role: 'reviewer' }),
      'verify',
      task({ verifierPrincipalId: otherId }),
    ).allowed).toBe(false);
  });

  it('grants initiators read but no mutation authority', () => {
    expect(service.authorizeResource(actor(), 'read', task({ creatorPrincipalId: principalId })).basis).toBe('initiator');
    expect(service.authorizeResource(actor(), 'write', task({ creatorPrincipalId: principalId })).allowed).toBe(false);
    expect(service.authorizeResource(actor(), 'read', task({ spawnedByPrincipalId: principalId })).basis).toBe('initiator');
  });

  it('orders exact grants before wildcard grants and ignores expiry', () => {
    const now = new Date('2026-08-13T02:00:00Z');
    const grants = [
      { resourceType: 'task' as const, resourceId: null, verb: 'read' as const },
      { resourceType: 'task' as const, resourceId: task().id, verb: 'write' as const },
      { resourceType: 'task' as const, resourceId: task().id, verb: 'admin' as const, expiresAt: '2026-08-13T01:00:00Z' },
    ];
    expect(service.authorizeResource(actor(), 'read', task(), grants, now).basis).toBe('exact-grant');
    expect(service.authorizeResource(actor(), 'write', task(), grants, now).basis).toBe('exact-grant');
  });

  it('keeps use and invoke disjoint from read/write', () => {
    const resource = { type: 'service' as const, id: task().id, visibility: 'private' as const };
    const invoke = [{ resourceType: 'service' as const, resourceId: resource.id, verb: 'invoke' as const }];
    expect(service.authorizeResource(actor(), 'invoke', resource, invoke).allowed).toBe(true);
    expect(service.authorizeResource(actor(), 'read', resource, invoke).allowed).toBe(false);
  });

  it('normalizes shared/default visibility to authenticated read only', () => {
    expect(service.authorizeResource(actor(), 'read', task({ visibility: 'shared' })).basis).toBe('visibility');
    expect(service.authorizeResource(actor(), 'read', task({ visibility: 'default' })).basis).toBe('visibility');
    expect(service.authorizeResource(actor(), 'write', task({ visibility: 'public' })).allowed).toBe(false);
  });

  it('inherits Phase visibility by default and restricts only through the explicit mode', () => {
    const phase: AuthorizationResource = {
      type: 'phase',
      id: task().id,
      inheritedVisibility: 'shared',
      restrictedAccess: false,
    };
    expect(service.authorizeResource(actor(), 'read', phase).basis).toBe('visibility');
    // Adding an exact grant never toggles or suppresses inherited access.
    expect(service.authorizeResource(actor(), 'read', phase, [{
      resourceType: 'phase', resourceId: phase.id, verb: 'read',
    }]).basis).toBe('exact-grant');
    expect(service.authorizeResource(actor(), 'read', { ...phase, restrictedAccess: true }).allowed).toBe(false);
    expect(service.authorizeResource(actor(), 'read', { ...phase, restrictedAccess: true }, [{
      resourceType: 'phase', resourceId: phase.id, verb: 'read',
    }]).basis).toBe('exact-grant');
    expect(service.authorizeResource(actor({ role: 'orchestrator' }), 'read', {
      ...phase, restrictedAccess: true,
    }).basis).toBe('administrator');
  });

  it('does not treat a Task claimant as generic owner/admin', () => {
    expect(service.authorizeResource(actor(), 'admin', task({ ownerPrincipalId: principalId })).allowed).toBe(false);
    expect(service.authorizeResource(actor(), 'finish', task({ ownerPrincipalId: principalId })).basis).toBe('claimant');
    expect(service.authorizeResource(actor(), 'read', task({ ownerPrincipalId: otherId })).allowed).toBe(false);
  });

  it('generates the list predicate from the same Task-role and grant arms', () => {
    const decision = service.sqlCondition(actor(), 'read', {
      type: 'task',
      id: 't.id',
      claimant: 't.owner_principal_id',
      creator: 't.creator_principal_id',
      shepherd: 't.shepherd_principal_id',
      verifier: 't.verifier_principal_id',
      visibility: 't.visibility',
    });
    expect(decision.sql).toContain('t.owner_principal_id = $1');
    expect(decision.sql).toContain('t.shepherd_principal_id = $1');
    expect(decision.sql).toContain('t.verifier_principal_id = $1');
    expect(decision.sql).toContain("g.grantee_type = 'principal'");
    // The typed wildcard is unchanged for the eight ratified object types and
    // is withheld from `surface` alone (AZ-A5 clause 3, annex D19). The claim
    // this control makes — the list predicate composes the SAME grant arm, with
    // the live resource-id column substituted — is untouched.
    expect(decision.sql).toContain('(g.resource_id = t.id OR (g.resource_id IS NULL AND g.resource_type <> \'surface\'))');
    expect(decision.sql).toContain("t.visibility IN ('public', 'shared', 'default')");
    expect(decision.sql).not.toContain('<RESOURCE_ID_COLUMN>');
    expect(decision.params[0]).toBe(principalId);
    expect(decision.params).toEqual(expect.arrayContaining(['task', 'read', 'write', 'admin']));
  });

  it('keeps SQL grant verbs in parity with the pure evaluator', () => {
    const actions = ['read', 'write', 'use', 'invoke', 'verify'] as const;
    for (const action of actions) {
      const pureAllowed = (['read', 'write', 'use', 'invoke', 'admin'] as const)
        .filter((verb) => service.authorizeResource(actor(), action, task(), [{
          resourceType: 'task', resourceId: task().id, verb,
        }]).allowed);
      const sql = service.sqlCondition(actor(), action, { type: 'task', id: 't.id' });
      const sqlVerbs = sql.params.filter((value) => ['read', 'write', 'use', 'invoke', 'admin'].includes(String(value)));
      // Since AZ-S2 the profile arm mirrors the grant arm verb-for-verb:
      // each allowed verb binds once for grants and once for profiles.
      expect(sqlVerbs).toEqual(pureAllowed.flatMap((verb) => [verb, verb]));
    }
  });

  it('emits the explicit Phase restriction predicate and the role ceiling in SQL', () => {
    const phase = service.sqlCondition(actor(), 'read', {
      type: 'phase',
      id: 'ph.id',
      inheritedVisibility: 'p.visibility',
      restrictedAccess: 'ph.restricted_access',
    });
    expect(phase.sql).toContain('NOT (ph.restricted_access)');
    expect(phase.sql).not.toContain('resource_id = ph.id)) AND p.visibility');
    expect(service.sqlCondition(actor({ role: 'viewer' }), 'write', {
      type: 'task', id: 't.id',
    })).toEqual({ sql: 'FALSE', params: [] });
  });
});
