/**
 * SS-W2 · SS-1 (role separation) and SS-2 (route-level census).
 *
 * ── WHY BOTH LIVE HERE ──
 *
 * The relying-party leg mounts under the EXISTING public `/auth` mount, so
 * `PUBLIC_ROUTE_MOUNTS` does not grow (SS-1). The price is that the AST mount
 * census (`authorizationRouteCoverage.test.ts`) cannot see these routes: it
 * counts mounts, and these are routes under a mount it already knows. Without
 * a replacement, this wave would QUIETLY REDUCE review visibility while
 * appearing to preserve it.
 *
 * SS-2 is that replacement, and it is deliberately not a model of the router.
 * The expected set is read from the router MODULE, and the actual set is read
 * from the express Router's own layer stack — the thing that actually serves
 * requests. A census with its own private copy of the answer proves only that
 * two constants agree.
 */
import type { Response } from 'express';
import fs from 'fs';
import path from 'path';
import { SSO_ROUTE_CENSUS, createSsoRouter } from '../routes/sso';

const RP_DIR = path.join(__dirname, '..', 'services', 'identity');
const RP_ROUTES = [path.join(__dirname, '..', 'routes', 'sso.ts')];

interface ExpressLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

/**
 * Ask the ROUTER what it serves, rather than asking a list what it expects.
 *
 * There is exactly ONE of these, and the red proof below calls it too. A red
 * proof that re-implements the check it claims to break proves that the copy
 * behaves as written, not that the census does — this programme has been
 * rejected twice for that shape ("a test that models the thing can be edited
 * to agree with a lie about it").
 */
function routesOf(router: ReturnType<typeof createSsoRouter>): string[] {
  const layers = (router as unknown as { stack: ExpressLayer[] }).stack;
  const found: string[] = [];
  for (const layer of layers) {
    if (!layer.route) continue;
    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (enabled) found.push(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }
  return found.sort();
}

function buildRouter() {
  return createSsoRouter({ issueBrowserAccessCookie: (_res: Response) => undefined });
}

const actualRoutes = (): string[] => routesOf(buildRouter());

/**
 * THE import-direction predicate. Both the scan and its red proof call this
 * one function, so the proof exercises the production check rather than a
 * restatement of it.
 */
function crossesSeam(line: string, forbidden: readonly string[]): boolean {
  const trimmed = line.trim();
  // Only IMPORT statements count. The forbidden words appear in prose above,
  // and a gate that refused the words would refuse the design's own citations.
  if (!trimmed.startsWith('import ') && !trimmed.includes('require(')) return false;
  return forbidden.some((needle) => trimmed.includes(needle));
}

function rpSourceFiles(): string[] {
  const services = fs
    .readdirSync(RP_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join(RP_DIR, name));
  return [...services, ...RP_ROUTES];
}

describe('SS-2 — the route-level census the mount census cannot give', () => {
  it('serves EXACTLY the enumerated set of /auth/sso routes', () => {
    expect(actualRoutes()).toEqual([...SSO_ROUTE_CENSUS].sort());
  });

  it('RED PROOF: an unlisted route fails the census', () => {
    // The mutation the acceptance names — "red-proofed by adding an unlisted
    // route" — driven through the SAME layer walk the census uses, against a
    // real router, so no production byte has to move and no copy of the check
    // can drift away from it.
    const router = buildRouter();
    router.get('/an-unlisted-route', (_req, res) => res.json({}));
    const found = routesOf(router);
    expect(found).not.toEqual([...SSO_ROUTE_CENSUS].sort());
    expect(found).toContain('GET /an-unlisted-route');
  });

  it('the census names only /auth/sso-relative paths, never an absolute mount', () => {
    for (const entry of SSO_ROUTE_CENSUS) {
      const [, routePath] = entry.split(' ');
      expect(routePath.startsWith('/')).toBe(true);
      expect(routePath.startsWith('/auth')).toBe(false);
    }
  });
});

describe('SS-1 — the two OAuth roles never import each other', () => {
  const FORBIDDEN_IN_RP = ['OAuthAuthorizationService', 'oauthMetadata'];
  const AS_FORBIDDEN = ['services/identity', 'routes/sso', './sso'];

  it('no relying-party module imports the authorization-server leg', () => {
    const offenders: string[] = [];
    for (const file of rpSourceFiles()) {
      const source = fs.readFileSync(file, 'utf8');
      for (const line of source.split('\n')) {
        if (crossesSeam(line, FORBIDDEN_IN_RP)) offenders.push(`${path.basename(file)}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no authorization-server module imports the relying-party leg', () => {
    const asFiles = [
      path.join(__dirname, '..', 'services', 'OAuthAuthorizationService.ts'),
      path.join(__dirname, '..', 'utils', 'oauthMetadata.ts'),
      path.join(__dirname, '..', 'routes', 'oauth.ts'),
    ].filter((file) => fs.existsSync(file));
    expect(asFiles.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of asFiles) {
      const source = fs.readFileSync(file, 'utf8');
      for (const line of source.split('\n')) {
        if (crossesSeam(line, AS_FORBIDDEN)) offenders.push(`${path.basename(file)}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('RED PROOF: the direction check catches an import that crosses the seam', () => {
    // The mutation the §11a SS-1 row names — "red-proofed by adding one import"
    // — driven through `crossesSeam`, the SAME predicate the two scans above
    // use. If that predicate is ever weakened, this test goes red with them.
    expect(crossesSeam("import { oauthIssuer } from '../utils/oauthMetadata';", FORBIDDEN_IN_RP)).toBe(true);
    expect(crossesSeam("import { oauthAuthorizationService } from '../services/OAuthAuthorizationService';", FORBIDDEN_IN_RP)).toBe(true);
    // NEGATIVE CONTROL: prose naming the same symbols is not an import, so the
    // predicate must NOT fire — otherwise every design citation would be an
    // offender and the gate would be unsatisfiable rather than strict.
    expect(crossesSeam(' * SS-1: no RP module imports OAuthAuthorizationService or oauthMetadata.', FORBIDDEN_IN_RP)).toBe(false);
    // NEGATIVE CONTROL: an ordinary relying-party import is not a crossing.
    expect(crossesSeam("import { pool } from '../db/connection';", FORBIDDEN_IN_RP)).toBe(false);
    // And the same predicate, in the other direction, on the other list.
    expect(crossesSeam("import { ssoAuthenticationService } from '../services/identity/SsoAuthenticationService';", AS_FORBIDDEN)).toBe(true);
  });

  it('the relying party mounts no route on the /oauth or /.well-known prefixes', () => {
    for (const entry of SSO_ROUTE_CENSUS) {
      expect(entry).not.toContain('/oauth');
      expect(entry).not.toContain('/.well-known');
    }
  });
});
