/**
 * A24 · `directory-provisioning:write` — BOTH halves, at the seam that decides.
 *
 * A24 mints the scope for "the directory provisioning surface (the SCIM 2.0
 * endpoints)" and then spends a whole sentence on what it never authorizes:
 * "role elevation, grants, scope or credential administration, or any read
 * beyond provisioning reconciliation". The wave brief calls that negative half
 * "as binding as the positive half", and it needs its own proof.
 *
 * ── WHAT THIS FILE PROVES, AT EXACTLY ITS STRENGTH ──
 *
 * 1. The scope reaches the SCIM family. Driven from `SCIM_ROUTE_CENSUS`, so a
 *    route added to the router without a census line is caught by the census
 *    test and a route added to BOTH lands here automatically.
 *
 * 2. The scope reaches NOTHING else. This is the claim that could most easily
 *    be faked by a hand-written list of five other families, so it is not:
 *    the probe corpus is generated from `PROTECTED_ROUTE_MOUNTS` and
 *    `PUBLIC_ROUTE_MOUNTS` — the manifests the mount census already forces to
 *    be complete — crossed with every HTTP method. A family added to the
 *    board arrives in this population without anyone remembering to add it.
 *
 * 3. A credential holding EXACTLY this scope is REFUSED at the acts A24 names,
 *    evaluated through the real `AuthorizationService` rather than by reading
 *    the table. And it is refused under BOTH actor shapes — with and without a
 *    live delegation chain — because those take different ceilings, and a
 *    refusal that holds only at the lower one would be resting on the role
 *    ceiling rather than on the scope. Each shape is asserted to refuse for
 *    the reason it actually refuses for, so the two cannot stand in for each
 *    other.
 *
 * It does NOT prove that the SCIM handlers honour A24 internally — that the
 * created Account is parentless, minimally-roled and Identity-provider-scoped.
 * That is
 * `scimProvisioningContract.test.ts`, and the two are deliberately separate:
 * this one is about who may reach the door, that one about what happens inside.
 */
import { AuthorizationService } from '../services/AuthorizationService';
import {
  ALL_SCOPES,
  MINTABLE_SCOPES,
  isMintableScope,
  requiredScopeFor,
  type RequiredScope,
} from '../utils/scopeMap';
import { PROTECTED_ROUTE_MOUNTS, PUBLIC_ROUTE_MOUNTS } from '../utils/authorizationRouteManifest';
import { SCIM_ROUTE_CENSUS } from '../routes/scim';

const SCOPE = 'directory-provisioning:write';
const SCIM_MOUNT = '/scim';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const authorization = new AuthorizationService();

/** The census entry `POST /v2/Users` as the server sees it: `/scim/v2/Users`. */
function mountedPathFor(censusEntry: string): { method: string; path: string } {
  const [method, routePath] = censusEntry.split(' ');
  // `:id` is a path parameter; any value stands for it, and a UUID is what the
  // surface really emits.
  return {
    method,
    path: `${SCIM_MOUNT}${routePath.replace(':id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')}`,
  };
}

/**
 * Every path this board serves that is NOT the SCIM family, generated from the
 * mount manifests rather than listed here.
 *
 * Three depths per mount, because the scope map's rules are written at
 * different depths and a one-depth probe would miss a narrower rule.
 */
function nonScimProbePaths(): string[] {
  const mounts = [...PROTECTED_ROUTE_MOUNTS, ...PUBLIC_ROUTE_MOUNTS]
    .filter((mount) => mount !== SCIM_MOUNT);
  const paths: string[] = [];
  for (const mount of mounts) {
    const base = mount === '/' ? '' : mount;
    paths.push(base === '' ? '/' : base);
    paths.push(`${base}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
    paths.push(`${base}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/probe`);
  }
  // Unmapped paths too: they fail closed to `root`, and that must stay true.
  paths.push('/nothing-here', '/scimmish', '/scim-not-really');
  return paths;
}

/** The SCIM client as it really arrives: a Connector holding ONE scope. */
function scimClientActor(withChain: boolean) {
  return {
    principalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    handle: 'estate-directory-connector',
    role: 'agent',
    scopes: [SCOPE],
    authenticated: true,
    delegation: withChain
      ? {
          links: [
            { principalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', kind: 'service' as const, role: null, parentPrincipalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', boundTaskId: null, legacyIdentity: false, ownExpression: { scopes: 'parent' as const, objects: 'parent' as const } },
            { principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'service' as const, role: 'agent', parentPrincipalId: null, boundTaskId: null, legacyIdentity: false, ownExpression: null },
          ],
        }
      : null,
  };
}

describe('A24 — the scope exists as ratified vocabulary with a live surface', () => {
  it('is ratified vocabulary and mintable, because its route surface is live', () => {
    expect(ALL_SCOPES).toContain(SCOPE);
    expect(MINTABLE_SCOPES).toContain(SCOPE);
    expect(isMintableScope(SCOPE)).toBe(true);
  });

  it('is not `root`, and does not make root reachable', () => {
    // AZ-18: root is never delegable to a bearer credential, which is the whole
    // reason A24 had to be declared. Holding A24's scope must not satisfy root.
    expect(authorization.authorizeRoute(scimClientActor(false), 'root').allowed).toBe(false);
    expect(authorization.authorizeRoute(scimClientActor(true), 'root').allowed).toBe(false);
  });
});

describe('A24 positive half — the scope reaches the SCIM family, and root still does', () => {
  it.each([...SCIM_ROUTE_CENSUS])('%s requires directory-provisioning:write', (entry) => {
    const { method, path } = mountedPathFor(entry);
    expect(requiredScopeFor(method, path)).toBe(SCOPE);
  });

  it.each([...SCIM_ROUTE_CENSUS])('%s admits the SCIM client under both actor shapes', (entry) => {
    const { method, path } = mountedPathFor(entry);
    const required = requiredScopeFor(method, path);
    expect(authorization.authorizeRoute(scimClientActor(false), required).allowed).toBe(true);
    expect(authorization.authorizeRoute(scimClientActor(true), required).allowed).toBe(true);
  });

  it('the global sentinel still reaches the family (A12.1)', () => {
    for (const entry of SCIM_ROUTE_CENSUS) {
      const { method, path } = mountedPathFor(entry);
      const owner = { principalId: 'o', handle: 'owner', role: 'orchestrator', scopes: ['root'], authenticated: true };
      expect(authorization.authorizeRoute(owner, requiredScopeFor(method, path)).allowed).toBe(true);
    }
  });

  it('NON-VACUITY: an ordinary working credential does NOT reach the family', () => {
    // Without this, every assertion above would also pass if `requiredScopeFor`
    // returned 'authenticated' for /scim, which satisfies everyone.
    const worker = { principalId: 'w', handle: 'worker', role: 'agent', scopes: ['tasks:read', 'tasks:write'], authenticated: true };
    for (const entry of SCIM_ROUTE_CENSUS) {
      const { method, path } = mountedPathFor(entry);
      expect(authorization.authorizeRoute(worker, requiredScopeFor(method, path)).allowed).toBe(false);
    }
  });
});

describe('A24 negative half — the scope reaches nothing but that family', () => {
  it('is the required scope of NO path outside /scim, over the whole mount manifest', () => {
    const offenders: string[] = [];
    for (const path of nonScimProbePaths()) {
      for (const method of METHODS) {
        if (requiredScopeFor(method, path) === SCOPE) offenders.push(`${method} ${path}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('NON-VACUITY: the same probe generator DOES see the scope on the SCIM family', () => {
    // The census above is only meaningful if its instrument can find the scope
    // at all. Same generator, same call, one path added.
    const found: string[] = [];
    for (const path of [...nonScimProbePaths(), '/scim/v2/Users']) {
      for (const method of METHODS) {
        if (requiredScopeFor(method, path) === SCOPE) found.push(`${method} ${path}`);
      }
    }
    expect(found).toContain('POST /scim/v2/Users');
    expect(found.every((entry) => entry.endsWith('/scim/v2/Users'))).toBe(true);
  });

  const REFUSED_ACTS: Array<{ act: string; method: string; path: string }> = [
    // "role elevation" — the Account mutation surface.
    { act: 'role elevation', method: 'PATCH', path: '/principals/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    // "grants"
    { act: 'grant creation', method: 'POST', path: '/grants' },
    { act: 'grant revocation', method: 'DELETE', path: '/grants/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    // "scope or credential administration"
    { act: 'credential minting', method: 'POST', path: '/credentials' },
    { act: 'credential listing', method: 'GET', path: '/credentials' },
    { act: 'access-profile mutation', method: 'POST', path: '/access-profiles' },
    // "any read beyond provisioning reconciliation"
    { act: 'principal directory read', method: 'GET', path: '/principals' },
    { act: 'task read', method: 'GET', path: '/tasks' },
    { act: 'report read', method: 'GET', path: '/reports' },
    { act: 'audit ledger read', method: 'GET', path: '/audit' },
    { act: 'group listing', method: 'GET', path: '/groups' },
    // Its own Identity provider configuration, including naming the SCIM client: the
    // directory must not be able to widen or re-point its own binding.
    { act: 'provider read', method: 'GET', path: '/identity-providers' },
    { act: 'naming its own SCIM client', method: 'PUT', path: '/identity-providers/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/scim-client' },
  ];

  it.each(REFUSED_ACTS)('refuses $act ($method $path) with no delegation chain', ({ method, path }) => {
    const decision = authorization.authorizeRoute(scimClientActor(false), requiredScopeFor(method, path));
    expect(decision.allowed).toBe(false);
  });

  it.each(REFUSED_ACTS)('refuses $act ($method $path) WITH a live delegation chain', ({ method, path }) => {
    // A Connector under a live chain takes the ceiling-3 arm of `actingCeiling`,
    // so the role ceiling stops refusing for it. Every refusal here is therefore
    // the SCOPE refusing, which is the claim A24 actually makes.
    const decision = authorization.authorizeRoute(scimClientActor(true), requiredScopeFor(method, path));
    expect(decision.allowed).toBe(false);
  });

  it('the chained shape really does reach the higher ceiling (so the test above is not resting on it)', () => {
    // If this ever went false, every "WITH a live delegation chain" assertion
    // would silently degrade into a second copy of the unchained one.
    const rootRequired: RequiredScope = 'root';
    expect(authorization.authorizeRoute(scimClientActor(false), rootRequired).denial).toBe('ROLE_CEILING');
    expect(authorization.authorizeRoute(scimClientActor(true), rootRequired).denial).toBe('SCOPE_CEILING');
  });
});
