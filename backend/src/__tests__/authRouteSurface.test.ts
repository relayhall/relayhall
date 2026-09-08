/**
 * SS-W1 · route-level census of the PUBLIC `/auth` mount.
 *
 * `/auth` is already in `PUBLIC_ROUTE_MOUNTS`, so the AST mount census
 * (`authorizationRouteCoverage.test.ts`) counts one mount and cannot see a
 * new route added underneath it. SS-W1 adds four public routes there. This is
 * the same instrument SS-2 specifies for `/auth/sso/*` in W2, applied to the
 * routes this wave actually ships: an explicit expected set of method+path
 * pairs, red-proofed by adding an unlisted route.
 *
 * A route added here without a line in this set is a failure, not a silent
 * expansion of the unauthenticated surface.
 */
import type { Router } from 'express';

/** Every method+path pair the `/auth` router is allowed to expose. */
const EXPECTED_AUTH_ROUTES = [
  // Permanent break-glass, narrowed to the named local administrator (§8.5).
  'POST /login',
  // The first-run local administrator act (owner ruling 60307311 §1.1).
  // Public by necessity: it is the act for a deployment where nobody can
  // authenticate as an administrator yet.
  'POST /first-run',
  // Per-Account login sessions (SS-16).
  'POST /session',
  'DELETE /session',
  'GET /sessions',
  'DELETE /sessions',
  'DELETE /sessions/:id',
  // Pre-existing: the browser capability cookie and AZ-S3 step-up.
  'POST /browser-session',
  'POST /step-up',
].sort();

/** Read the router's own registration table — not a hand-kept list. */
function actualRoutes(router: Router): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stack = (router as any).stack as Array<any>;
  const pairs: string[] = [];
  for (const layer of stack) {
    if (!layer?.route?.path) continue;
    for (const [method, enabled] of Object.entries(layer.route.methods ?? {})) {
      if (enabled) pairs.push(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }
  return pairs.sort();
}

describe('/auth route census', () => {
  let routes: string[];

  beforeAll(async () => {
    process.env.JWT_SECRET = 'auth-route-census-secret';
    const authRouter = (await import('../routes/auth')).default;
    routes = actualRoutes(authRouter);
  });

  it('exposes exactly the enumerated public routes', () => {
    expect(routes).toEqual(EXPECTED_AUTH_ROUTES);
  });

  it('the census is non-vacuous — it sees the routes that are really there', () => {
    // A census whose expected set is empty, or whose reader returns nothing,
    // would pass the assertion above by agreeing about nothing.
    expect(routes.length).toBe(EXPECTED_AUTH_ROUTES.length);
    expect(routes).toContain('POST /login');
    expect(routes).toContain('POST /session');
  });

  it('names an unlisted route rather than tolerating it (the red proof, run here)', () => {
    // The mutation the gate exists to catch, applied to a copy of the reader's
    // output: an extra public route must make the comparison fail, and the
    // failure must name it.
    const withStowaway = [...routes, 'POST /backdoor'].sort();
    expect(withStowaway).not.toEqual(EXPECTED_AUTH_ROUTES);
    const surplus = withStowaway.filter((route) => !EXPECTED_AUTH_ROUTES.includes(route));
    expect(surplus).toEqual(['POST /backdoor']);
  });
});
