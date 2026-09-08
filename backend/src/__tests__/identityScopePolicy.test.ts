import { scopesForRole, LEGACY_SERVICE_SCOPES } from '../utils/identityScopes';
import { AuthorizationService } from '../services/AuthorizationService';

const authorization = new AuthorizationService();
const routeActor = (role: string, scopes: string[] | null) => ({
  principalId: '11111111-1111-4111-8111-111111111111',
  handle: 'scope-policy-test',
  role,
  scopes,
  authenticated: true,
});

describe('all-identity-path scope policy', () => {
  it('keeps owner roles explicit root identities without elevating the legacy service key', () => {
    expect(scopesForRole('orchestrator')).toEqual(['root']);
    expect(scopesForRole('admin')).toEqual(['root']);
    expect(LEGACY_SERVICE_SCOPES).toEqual(expect.arrayContaining(['tasks:read', 'tasks:write']));
    expect(LEGACY_SERVICE_SCOPES).not.toContain('root');
    expect(LEGACY_SERVICE_SCOPES.some((scope) => scope.endsWith(':admin'))).toBe(false);
  });

  it('lets operators administer objects without opening owner-plane root routes', () => {
    const scopes = scopesForRole('operator');
    expect(scopes).toEqual(expect.arrayContaining(['tasks:admin', 'services:admin', 'principals:admin']));
    expect(scopes).not.toContain('root');
  });

  it('gives working roles live read/write/use/invoke scopes but no admin verb', () => {
    for (const role of ['editor', 'user', 'agent', 'service', 'qa', 'reviewer']) {
      const scopes = scopesForRole(role);
      expect(scopes).toEqual(expect.arrayContaining(['tasks:read', 'tasks:write', 'skills:use', 'services:invoke']));
      expect(scopes.some((scope) => scope.endsWith(':admin'))).toBe(false);
      expect(scopes).not.toContain('root');
    }
  });

  it('keeps viewers disclosure-only and unknown roles empty', () => {
    const viewer = scopesForRole('viewer');
    expect(viewer).toEqual(expect.arrayContaining(['tasks:read', 'projects:read', 'reports:read']));
    expect(viewer.every((scope) => scope.endsWith(':read'))).toBe(true);
    expect(scopesForRole('unexpected-idp-role')).toEqual([]);
    expect(scopesForRole(null)).toEqual([]);
  });

  it('proves the resulting route ceilings preserve owners and constrain every lower role', () => {
    expect(authorization.authorizeRoute(routeActor('orchestrator', scopesForRole('orchestrator')), 'root').allowed).toBe(true);
    expect(authorization.authorizeRoute(routeActor('service', LEGACY_SERVICE_SCOPES), 'root')).toEqual({
      allowed: false,
      denial: 'ROLE_CEILING',
    });
    expect(authorization.authorizeRoute(routeActor('operator', scopesForRole('operator')), 'tasks:admin').allowed).toBe(true);
    expect(authorization.authorizeRoute(routeActor('operator', scopesForRole('operator')), 'root')).toEqual({
      allowed: false,
      denial: 'SCOPE_CEILING',
    });
    expect(authorization.authorizeRoute(routeActor('viewer', scopesForRole('viewer')), 'tasks:read').allowed).toBe(true);
    expect(authorization.authorizeRoute(routeActor('viewer', scopesForRole('viewer')), 'tasks:write').allowed).toBe(false);
    expect(authorization.authorizeRoute(routeActor('', scopesForRole('unexpected')), 'tasks:read').allowed).toBe(false);
    expect(authorization.authorizeRoute(routeActor('', scopesForRole('unexpected')), 'authenticated').allowed).toBe(true);
    expect(authorization.authorizeRoute(routeActor('orchestrator', null), 'authenticated').allowed).toBe(false);
  });
});
