/**
 * routeFamilies — the ONE enumeration of the protected route families, derived
 * from the routers themselves rather than from a hand list.
 *
 * SETGOV (design `7a9317b2` §2.2/§3.3, AUTHZ amendment AZ-A5 clause 2,
 * vocabulary A25.1, acceptance annex `85a2218d` D2). An Access surface
 * declares the closed set of backend route families that serve it, split into
 * `read_families`, `write_families` and `excluded_families`. This module is
 * what a family is measured against.
 *
 * ── WHY A FAMILY CARRIES ITS METHOD ──
 *
 * A family is spelled `"<METHOD> <mounted path>"` — `GET /webhooks`,
 * `POST /webhooks`, `PATCH /webhooks/:id`. It is not a bare path, and the tree
 * is what decides that: `routes/webhooks.ts` serves `GET /` and `POST /` on the
 * SAME path, and `routes/litellmAdmin.ts` serves `GET /models` and
 * `POST /models` on the same path. Sitting ruling I-10 (record `83defda6`)
 * makes the access level `use` READ-ONLY — every state-changing call on a
 * governable surface requires `configure` — and annex D2(vii) enforces it by
 * refusing a state-changing method in any `read_families` entry. Under a
 * path-only family, Webhooks and Model catalogue admin could carry no read
 * family at all, so `use` would be inexpressible for them and I-10 would be
 * unenforceable rather than merely unenforced. The method is therefore part of
 * the family, and D2(vii) is decidable by construction.
 *
 * Resolution (§3.3 property 3/4) is still by PATH: an Access surface owns the
 * paths its families name, at most one surface resolves for a request, and the
 * read/write classification is the method+path family test that follows.
 */
import type { Router } from 'express';

/**
 * `routeRegistry` is loaded LAZILY, on first enumeration, and deliberately not
 * at module scope.
 *
 * The cycle is real and it bites at EVALUATION time: every protected router
 * imports `middleware/sharedAuthorization` (for `filterAuthorizedResources`),
 * which imports the Access-surface service, which imports this module. A
 * top-level `import { PROTECTED_ROUTE_REGISTRATIONS }` therefore pulls
 * `routeRegistry` - and with it all thirty routers - into the middle of a
 * router's own evaluation, and a router that reads a constant from a
 * half-initialised sibling at module scope receives `undefined`.
 * `routes/reports.ts` reading `REPORT_TEXT_LIMITS.title` is the observed
 * instance: it threw at import in four suites before this deferral.
 *
 * Deferring the load to the first CALL means every module has finished
 * evaluating before the registrations are read, which holds on every path that
 * reaches here - the boot census, and the tests.
 */
function protectedRouteRegistrations(): ReadonlyArray<{ path: string; router: Router }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  return (require('../routeRegistry') as typeof import('../routeRegistry')).PROTECTED_ROUTE_REGISTRATIONS;
}
import { normalizePathForScope, requiredScopeFor, type RequiredScope } from './scopeMap';

/**
 * The stand-in bound to a path parameter when a family is resolved against the
 * route map. It must be a spelling no literal rule can match: `me`,
 * `what-if` and `remediation-queue` are literal segments of real rules, and
 * substituting any of them would resolve a parameterised family against the
 * WRONG rule. A UUID cannot collide with a literal segment in `scopeMap`.
 */
export const FAMILY_PARAM_SAMPLE = '00000000-0000-4000-8000-000000000000';

/** Methods that may appear in a `read_families` entry (I-10, annex D2(vii)). */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

export interface RouteFamily {
  /** `"<METHOD> <mounted path>"`, the canonical spelling stored in a surface. */
  key: string;
  method: string;
  /** Mounted path with Express parameters, e.g. `/services/:id/owner-plane`. */
  path: string;
  /** The ratified requirement `requiredScopeFor` answers for this family. */
  requirement: RequiredScope;
}

interface RouteLayer {
  route?: { path: unknown; methods?: Record<string, boolean> };
  name?: string;
  handle?: { stack?: RouteLayer[] };
}

function joinMountPath(mount: string, routePath: string): string {
  const tail = routePath === '/' ? '' : routePath;
  const joined = `${mount}${tail}`;
  return joined === '' ? '/' : joined;
}

function collectRouteLayers(router: Router, mount: string, out: Array<{ method: string; path: string }>): void {
  const stack = (router as unknown as { stack?: RouteLayer[] }).stack ?? [];
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const rawPath of paths) {
        if (typeof rawPath !== 'string') continue;
        for (const [method, enabled] of Object.entries(layer.route.methods ?? {})) {
          if (!enabled || method === '_all') continue;
          out.push({ method: method.toUpperCase(), path: joinMountPath(mount, rawPath) });
        }
      }
      continue;
    }
    // A nested router mounted inside a router. None exists at this pin; the
    // recursion is here so a future nesting is censused rather than silently
    // absent from D2's completeness check.
    if (layer.handle?.stack) collectRouteLayers(layer.handle as unknown as Router, mount, out);
  }
}

/** The path a family is resolved against `requiredScopeFor` with. */
export function familySamplePath(path: string): string {
  return path.split('/').map((segment) => (segment.startsWith(':') ? FAMILY_PARAM_SAMPLE : segment)).join('/');
}

export function familyKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

export interface ParsedFamily {
  method: string;
  path: string;
}

/** `"GET /webhooks"` → `{ method: 'GET', path: '/webhooks' }`; null if malformed. */
export function parseFamilyKey(key: unknown): ParsedFamily | null {
  if (typeof key !== 'string') return null;
  const match = /^([A-Z]+) (\/\S*)$/.exec(key.trim());
  if (!match) return null;
  return { method: match[1], path: match[2] };
}

/** The requirement the ratified route map answers for a family. */
export function familyRequirement(family: ParsedFamily): RequiredScope {
  return requiredScopeFor(family.method, familySamplePath(family.path));
}

let cachedFamilies: RouteFamily[] | null = null;

/**
 * Every (method, mounted path) the protected routers actually serve, with the
 * requirement the route map answers for it. Derived from `router.stack`, so a
 * route added to a router is censused without anyone updating a list.
 *
 * This is CATALOGUE data about the code, not an authorization decision, and it
 * cannot change while the process runs: the routers are constructed at import.
 * Memoising it is therefore not the decision cache AZ-A5 clause 7 forbids.
 */
export function enumerateProtectedRouteFamilies(): RouteFamily[] {
  if (cachedFamilies) return cachedFamilies;
  const raw: Array<{ method: string; path: string }> = [];
  for (const registration of protectedRouteRegistrations()) {
    collectRouteLayers(registration.router, registration.path, raw);
  }
  const seen = new Set<string>();
  const families: RouteFamily[] = [];
  for (const entry of raw) {
    const key = familyKey(entry.method, entry.path);
    if (seen.has(key)) continue;
    seen.add(key);
    families.push({
      key,
      method: entry.method,
      path: entry.path,
      requirement: familyRequirement({ method: entry.method, path: entry.path }),
    });
  }
  families.sort((a, b) => a.key.localeCompare(b.key));
  cachedFamilies = families;
  return families;
}

/** Test-only: drop the memoised enumeration. */
export function resetRouteFamilyCache(): void {
  cachedFamilies = null;
}

/**
 * Does this family's path match a normalised request path?
 *
 * The request path arrives through `normalizePathForScope` — the same
 * normaliser the route map uses — so the trailing-slash / `//` / case immunity
 * documented there is INHERITED rather than re-implemented (§3.3 property 3).
 * The family path is normalised the same way before comparison.
 */
export function familyPathMatches(familyPath: string, normalizedRequestPath: string): boolean {
  const pattern = normalizePathForScope(familyPath)
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${pattern}$`).test(normalizedRequestPath);
}

/**
 * Could ONE request path be matched by both of these declared family paths?
 *
 * `resolveSurfaceMatches` resolves on PATH ALONE (design §3.3), so this is the
 * true collision predicate for surface resolution — not equality of the family
 * KEY, which carries the method. Two surfaces declaring `GET /x` and `POST /x`
 * have different keys and the same path, and at runtime BOTH resolve for a
 * request to `/x`; the tie-break then silently shadows one of them.
 *
 * Matching is exact per segment with `:param` standing for any one segment, so
 * two paths collide exactly when they have the same segment count and every
 * segment pair is equal or has a parameter on at least one side — which is why
 * `/a/:id` and `/a/b` collide even though they are not equal.
 *
 * Round-1 review of SETGOV candidate A found the census asserting the opposite
 * (regression card `fd10af48`).
 */
export function familyPathsOverlap(a: string, b: string): boolean {
  const left = normalizePathForScope(a).split('/');
  const right = normalizePathForScope(b).split('/');
  if (left.length !== right.length) return false;
  return left.every((segment, i) => segment.startsWith(':') || right[i].startsWith(':') || segment === right[i]);
}

/** Does this family answer this request? Method AND path must both match. */
export function familyMatchesRequest(key: string, method: string, normalizedRequestPath: string): boolean {
  const parsed = parseFamilyKey(key);
  if (!parsed) return false;
  if (parsed.method !== method.toUpperCase()) return false;
  return familyPathMatches(parsed.path, normalizedRequestPath);
}
