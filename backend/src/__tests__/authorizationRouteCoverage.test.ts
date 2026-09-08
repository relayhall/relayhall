/**
 * Shared-authorization route coverage.
 *
 * ── Why this file was rewritten (REJECT 492c7d11 B2, RH-P3.C4) ──
 *
 * The version this replaces claimed that `/mcp` was the ONLY authenticated
 * mount outside the shared funnel. It proved no such thing: it compared a
 * hand-maintained manifest to ITSELF and looked for one source substring. The
 * reviewer added
 *
 *     app.use('/shadow-auth', someCustomAuthentication, someShadowRouter);
 *
 * to a disposable copy of server.ts and the gate still reported PASS 5/5 —
 * including that very assertion. A manifest compared to itself cannot catch a
 * surface that grew.
 *
 * So this censuses the mounts the server ACTUALLY registers, out of the
 * TypeScript AST, and asserts two things about them: the exact census (any
 * change to the mount surface fails, which is what makes it a review event)
 * and a classification of every entry against the manifests (which says WHY).
 * Five mutations — the reviewer's included — prove the gate goes red.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import {
  PROTECTED_ROUTE_MOUNTS,
  PUBLIC_ROUTE_MOUNTS,
  ROUTE_ONLY_RESOURCE_MOUNTS,
  ROW_AUTHORIZED_ROUTE_MOUNTS,
  HANDLER_ROW_AUTHORIZED_ROUTE_MOUNTS,
  SELF_AUTHENTICATING_ROUTE_MOUNTS,
} from '../utils/authorizationRouteManifest';
import { POINT_RESOURCE_ROUTE_TYPES } from '../middleware/sharedAuthorization';
import { PROTECTED_ROUTE_REGISTRATIONS } from '../routeRegistry';
import { MCP_ROUTE_PATH } from '../mcp/httpRoute';
import { OAUTH_ROUTE_PATH, OAUTH_WELL_KNOWN_ROUTE_PATH } from '../utils/oauthMetadata';

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.ts'), 'utf8');
// RH-P3.C4: the mount list moved OUT of server.ts so both ingresses iterate
// one source. The gate moved with it and now covers both — a router is
// reachable over MCP only if it is reachable over REST, and vice versa.
const registry = fs.readFileSync(path.join(root, 'routeRegistry.ts'), 'utf8');
const mcpIngress = fs.readFileSync(path.join(root, 'mcp', 'inProcess.ts'), 'utf8');

function quotedCalls(functionName: string): string[] {
  const pattern = new RegExp(`${functionName}\\(\\s*['"]([^'"]+)['"]`, 'g');
  return [...server.matchAll(pattern)].map((match) => match[1]);
}

// ───────────────────────────── the mount census ─────────────────────────────

interface Mount {
  /** `use` | `get` | `post` | … — never `set`, `listen` or another app call. */
  method: string;
  /** The mount path, when it is a string literal. */
  literal: string | null;
  /** The identifier used as a path, when the path is symbolic. */
  symbol: string | null;
  /** Stable shape names of the remaining arguments, in order. */
  guards: string[];
}

const MOUNT_METHODS = new Set(['use', 'get', 'post', 'put', 'patch', 'delete', 'all', 'options', 'head']);

/** A stable, reviewable name for one argument's shape. */
function shapeOf(node: ts.Node): string {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isIdentifier(callee)) return `${callee.text}()`;
    if (ts.isPropertyAccessExpression(callee)) return `${callee.expression.getText()}.${callee.name.text}()`;
    return '<call>';
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return '<inline handler>';
  if (ts.isSpreadElement(node)) return `...${shapeOf(node.expression)}`;
  if (ts.isStringLiteral(node)) return `'${node.text}'`;
  return ts.SyntaxKind[node.kind];
}

export function censusMounts(source: string): Mount[] {
  const sourceFile = ts.createSourceFile('server.ts', source, ts.ScriptTarget.ES2020, true);
  const mounts: Mount[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'app'
      && MOUNT_METHODS.has(node.expression.name.text)
      && node.arguments.length > 0
    ) {
      const [first, ...rest] = node.arguments;
      const literal = ts.isStringLiteral(first) ? first.text : null;
      // An identifier in first position is a PATH only when handlers follow
      // it; `app.use(apiRateLimit)` is global middleware, not a mount.
      const symbol = literal === null && ts.isIdentifier(first) && rest.length > 0 ? first.text : null;
      const guards = (literal !== null || symbol !== null ? rest : node.arguments.slice()).map(shapeOf);
      mounts.push({ method: node.expression.name.text, literal, symbol, guards });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return mounts;
}

/**
 * THE MOUNT SURFACE, in registration order. Changing it is a
 * security-significant code-review event, which is exactly why it is spelled
 * out rather than derived: a reviewer reads this list and knows what the
 * server exposes and what guards each entry.
 */
const EXPECTED_MOUNTS: Mount[] = [
  { method: 'use', literal: null, symbol: null, guards: ['helmet()'] },
  { method: 'use', literal: null, symbol: null, guards: ['cors()'] },
  { method: 'use', literal: null, symbol: null, guards: ['morgan()'] },
  { method: 'use', literal: null, symbol: null, guards: ['express.json()'] },
  { method: 'use', literal: null, symbol: null, guards: ['express.urlencoded()'] },
  { method: 'use', literal: null, symbol: null, guards: ['apiRateLimit'] },
  { method: 'get', literal: '/readiness', symbol: null, guards: ['<inline handler>'] },
  { method: 'get', literal: '/health/functional', symbol: null, guards: ['<inline handler>'] },
  { method: 'get', literal: '/health', symbol: null, guards: ['healthHandler'] },
  { method: 'get', literal: '/health/orchestration', symbol: null, guards: ['orchestrationConfigurationHandler'] },
  { method: 'get', literal: '/', symbol: null, guards: ['<inline handler>'] },
  // THE shared funnel, inside `protectedRouter`.
  { method: 'use', literal: null, symbol: 'path', guards: ['authMiddleware', 'sharedAuthorizationMiddleware', '...handlers'] },
  { method: 'use', literal: '/auth', symbol: null, guards: ['authRoutes'] },
  { method: 'use', literal: '/config', symbol: null, guards: ['configRoutes'] },
  { method: 'use', literal: '/appearance', symbol: null, guards: ['appearanceRoutes'] },
  // RH-P3.C6: the OAuth 2.1 authorization server, public by contract.
  { method: 'use', literal: null, symbol: 'OAUTH_ROUTE_PATH', guards: ['oauthRoutes'] },
  { method: 'use', literal: null, symbol: 'OAUTH_WELL_KNOWN_ROUTE_PATH', guards: ['oauthWellKnownRoutes'] },
  // RH-KW1 candidate B: the knowledge-assertion JWKS, on the SAME well-known
  // path and deliberately outside the auth mesh (design 94747de9 §10.2,
  // owner decision D8). A relying source must verify an assertion before,
  // and independently of, any credential it holds for core. The handler
  // renders public keys from process configuration, reads no database and
  // takes no parameters, so it produces identical bytes for every caller.
  { method: 'use', literal: null, symbol: 'OAUTH_WELL_KNOWN_ROUTE_PATH', guards: ['knowledgeJwksRoutes'] },
  { method: 'use', literal: null, symbol: null, guards: ['createPluginProxy()'] },
  { method: 'use', literal: '/plugins', symbol: null, guards: ['publicPluginThemeRoutes'] },
  { method: 'get', literal: '/openapi.json', symbol: null, guards: ['authMiddleware', 'sharedAuthorizationMiddleware', '<inline handler>'] },
  // The board's in-process MCP ingress: authenticated, but by itself.
  { method: 'use', literal: null, symbol: 'MCP_ROUTE_PATH', guards: ['mcpRoutes'] },
  { method: 'use', literal: null, symbol: null, guards: ['apiErrorHandler'] },
  { method: 'use', literal: null, symbol: null, guards: ['<inline handler>'] },
  { method: 'use', literal: null, symbol: null, guards: ['<inline handler>'] },
];

/**
 * Every literal path server.ts may mount directly. Deliberately short: the
 * protected families are mounted by `registerProtectedRoutes`, so the only
 * protected literal here is the one route that is a handler, not a router.
 */
const ALLOWED_LITERAL_MOUNTS = new Set<string>([
  ...PUBLIC_ROUTE_MOUNTS,
  // The public theme router mounts at `/plugins`; the manifest names the one
  // public path it actually serves, `/plugins/theme.css`.
  '/plugins',
  // The single protected route registered outside the registry sweep.
  '/openapi.json',
]);

/** Path-less global middleware, in the exact order the server installs it. */
const EXPECTED_GLOBAL_MIDDLEWARE = [
  'helmet()', 'cors()', 'morgan()', 'express.json()', 'express.urlencoded()',
  'apiRateLimit', 'createPluginProxy()', 'apiErrorHandler',
  '<inline handler>', '<inline handler>',
];

export function classifyMounts(mounts: Mount[]): string[] {
  const violations: string[] = [];
  const globals: string[] = [];
  let funnels = 0;

  for (const mount of mounts) {
    if (mount.literal !== null) {
      if (!ALLOWED_LITERAL_MOUNTS.has(mount.literal)) {
        violations.push(`app.${mount.method}('${mount.literal}') is an unclassified mount — it is in no manifest`);
        continue;
      }
      // Only `/openapi.json` may install the shared authentication by hand;
      // every other protected family goes through `registerProtectedRoutes`.
      if (mount.literal !== '/openapi.json' && mount.guards.includes('authMiddleware')) {
        violations.push(`app.${mount.method}('${mount.literal}') installs authMiddleware outside the shared funnel`);
      }
      continue;
    }
    if (mount.symbol !== null) {
      if (mount.symbol === 'path'
        && mount.guards[0] === 'authMiddleware'
        && mount.guards[1] === 'sharedAuthorizationMiddleware') {
        funnels += 1;
        continue;
      }
      // RH-P3.C6: two symbolic PUBLIC mounts. Each manifest entry is checked
      // against the ACTUAL mounted constant, and neither mount may carry an
      // authentication guard — a public protocol surface that quietly grew
      // `authMiddleware` would be stamping `api` on OAuth traffic.
      const publicSymbols: Record<string, string> = {
        OAUTH_ROUTE_PATH,
        OAUTH_WELL_KNOWN_ROUTE_PATH,
      };
      if (mount.symbol in publicSymbols) {
        const resolved = publicSymbols[mount.symbol];
        if (!(PUBLIC_ROUTE_MOUNTS as readonly string[]).includes(resolved)) {
          violations.push(`${mount.symbol} resolves to '${resolved}', which no manifest declares public`);
        }
        if (mount.guards.includes('authMiddleware')) {
          violations.push(`${mount.symbol} installs authMiddleware outside the shared funnel`);
        }
        continue;
      }
      if (mount.symbol === 'MCP_ROUTE_PATH') {
        // The manifest is checked against the ACTUAL mounted constant.
        if (!(SELF_AUTHENTICATING_ROUTE_MOUNTS as readonly string[]).includes(MCP_ROUTE_PATH)) {
          violations.push(`MCP_ROUTE_PATH resolves to '${MCP_ROUTE_PATH}', which no manifest declares self-authenticating`);
        }
        continue;
      }
      violations.push(`app.${mount.method}(${mount.symbol}, …) mounts on a symbolic path no manifest declares`);
      continue;
    }
    globals.push(mount.guards.join(' + '));
  }

  if (funnels !== 1) violations.push(`expected exactly ONE shared authentication funnel, found ${funnels}`);
  if (globals.join('|') !== EXPECTED_GLOBAL_MIDDLEWARE.join('|')) {
    violations.push(`global middleware changed: expected [${EXPECTED_GLOBAL_MIDDLEWARE.join(', ')}], found [${globals.join(', ')}]`);
  }
  return violations;
}

describe('shared authorization route coverage', () => {
  it('funnels every protected mount through authentication and the shared predicate', () => {
    expect(server).toMatch(
      /app\.use\(path, authMiddleware, sharedAuthorizationMiddleware, \.\.\.handlers\)/,
    );
    expect(server).not.toMatch(/app\.use\(\s*['"][^'"]+['"],\s*authMiddleware,/);
    // The REST ingress mounts the registry and nothing else by hand.
    expect(server).toContain('registerProtectedRoutes(protectedRouter);');
    expect(server).not.toMatch(/protectedRouter\(\s*['"]/);

    const actual = new Set([
      ...PROTECTED_ROUTE_REGISTRATIONS.map((registration) => registration.path),
      ...quotedCalls('app.get').filter((route) => route === '/openapi.json'),
    ]);
    expect([...actual].sort()).toEqual([...PROTECTED_ROUTE_MOUNTS].sort());
  });

  it('funnels the in-process MCP ingress through the SAME registry and ceiling', () => {
    // Both ingresses iterate one list, so a family cannot be reachable on one
    // surface and missing on the other (design 4d961e37 §7.5).
    expect(mcpIngress).toContain('registerProtectedRoutes(');
    expect(mcpIngress).toContain('mcpAuthMiddleware, sharedAuthorizationMiddleware');
    // The MCP ingress must never install the REST authentication, which
    // stamps `api` — that would silently reclassify every MCP call.
    expect(mcpIngress).not.toMatch(/\bauthMiddleware\b/);
    expect(registry).toContain('export function registerProtectedRoutes(');
  });

  it('censuses EVERY mount the server actually registers', () => {
    const mounts = censusMounts(server);
    // A census that found nothing would pass vacuously.
    expect(mounts.length).toBeGreaterThanOrEqual(15);
    expect(mounts).toEqual(EXPECTED_MOUNTS);
  });

  it('classifies every censused mount against the manifests', () => {
    expect(classifyMounts(censusMounts(server))).toEqual([]);
  });

  it('pins /mcp as the ONLY authenticated mount outside the shared funnel', () => {
    expect([...SELF_AUTHENTICATING_ROUTE_MOUNTS]).toEqual(['/mcp']);
    // The manifest is compared to the ACTUAL mounted constant, not to itself.
    expect(MCP_ROUTE_PATH).toBe('/mcp');
    const censused = censusMounts(server);
    expect(censused.filter((mount) => mount.symbol === 'MCP_ROUTE_PATH')).toHaveLength(1);
    // Nothing else authenticates outside the funnel: the only other mount
    // naming the shared authentication is `/openapi.json`.
    const handAuthenticated = censused
      .filter((mount) => mount.guards.includes('authMiddleware') && mount.symbol !== 'path')
      .map((mount) => mount.literal ?? mount.symbol);
    expect(handAuthenticated).toEqual(['/openapi.json']);
    // Its transport class is declared, so the T26 unclassified-route rule
    // does not reject the very credentials it exists to serve.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { routeTransportClassFor } = require('../utils/transportMap');
    expect(routeTransportClassFor(MCP_ROUTE_PATH)).toBe('mcp');
  });

  describe('the census FAILS when the surface regresses (REJECT 492c7d11 B2)', () => {
    const fails = (mutated: string): string => {
      expect(mutated).not.toBe(server);
      const mounts = censusMounts(mutated);
      // Both layers must react: the exact census, and the classifier.
      expect(mounts).not.toEqual(EXPECTED_MOUNTS);
      return classifyMounts(mounts).join('\n');
    };

    it("catches the reviewer's own mutation: a second authenticated mount", () => {
      // The gate this replaces stayed PASS 5/5 through exactly this line.
      expect(fails(`${server}\napp.use('/shadow-auth', someCustomAuthentication, someShadowRouter);\n`))
        .toContain('/shadow-auth');
    });

    it('catches a self-authenticating mount on a symbolic path no manifest declares', () => {
      expect(fails(`${server}\napp.use(SHADOW_ROUTE_PATH, shadowRoutes);\n`)).toContain('SHADOW_ROUTE_PATH');
    });

    it('catches a global middleware slipped into the stack', () => {
      expect(fails(server.replace('app.use(apiRateLimit);', 'app.use(apiRateLimit);\napp.use(shadowGlobalAuth);')))
        .toContain('global middleware changed');
    });

    it('catches a second shared funnel', () => {
      expect(fails(`${server}\napp.use(path, authMiddleware, sharedAuthorizationMiddleware, ...handlers);\n`))
        .toContain('exactly ONE shared authentication funnel');
    });

    it('catches authentication installed on a known public literal', () => {
      expect(fails(server.replace("app.use('/config', configRoutes);", "app.use('/config', authMiddleware, configRoutes);")))
        .toContain('outside the shared funnel');
    });

    it('catches a guard quietly removed from an existing mount', () => {
      // Not only additions: dropping the shared ceiling from /openapi.json
      // must fail too, and only the exact census can see that.
      const mutated = server.replace(
        "app.get('/openapi.json', authMiddleware, sharedAuthorizationMiddleware,",
        "app.get('/openapi.json', authMiddleware,",
      );
      expect(mutated).not.toBe(server);
      expect(censusMounts(mutated)).not.toEqual(EXPECTED_MOUNTS);
    });
  });

  it('pins the deliberately public mounts as a short review-visible list', () => {
    expect([...PUBLIC_ROUTE_MOUNTS]).toEqual([
      '/', '/health', '/readiness', '/health/functional', '/health/orchestration',
      '/auth', '/config', '/oauth', '/.well-known', '/appearance',
      '/plugin-proxy', '/plugins/theme.css',
    ]);
    expect(server).toContain("app.use('/auth', authRoutes)");
    expect(server).toContain("app.use('/config', configRoutes)");
    expect(server).toContain('app.use(OAUTH_ROUTE_PATH, oauthRoutes)');
    expect(server).toContain('app.use(OAUTH_WELL_KNOWN_ROUTE_PATH, oauthWellKnownRoutes)');
    // The manifest entries are compared to the constants the server mounts.
    expect(OAUTH_ROUTE_PATH).toBe('/oauth');
    expect(OAUTH_WELL_KNOWN_ROUTE_PATH).toBe('/.well-known');
    expect(server).toContain("app.use('/appearance', appearanceRoutes)");
    expect(server).toContain('app.use(createPluginProxy(pluginLoader))');
    expect(server).toContain("app.use('/plugins', publicPluginThemeRoutes)");
  });

  it('classifies every current object-bearing family for point and list authorization', () => {
    const pointMounts = Object.keys(POINT_RESOURCE_ROUTE_TYPES).map((name) => `/${name}`);
    // Blueprint GET can be a use-only declaration projection. Its handler
    // chooses read/use before the SAME canonical row predicate; a generic
    // point GET->read gate would incorrectly deny that ratified surface.
    expect([...HANDLER_ROW_AUTHORIZED_ROUTE_MOUNTS]).toEqual(['/blueprints']);
    expect(pointMounts.filter(mount => (HANDLER_ROW_AUTHORIZED_ROUTE_MOUNTS as readonly string[]).includes(mount))).toEqual([]);
    expect([...pointMounts, ...HANDLER_ROW_AUTHORIZED_ROUTE_MOUNTS].sort())
      .toEqual([...ROW_AUTHORIZED_ROUTE_MOUNTS].sort());
    for (const mount of HANDLER_ROW_AUTHORIZED_ROUTE_MOUNTS) {
      expect(PROTECTED_ROUTE_MOUNTS).toContain(mount);
      expect(PROTECTED_ROUTE_REGISTRATIONS.map(route => route.path)).toContain(mount);
    }
    expect([...ROUTE_ONLY_RESOURCE_MOUNTS]).toEqual(['/plugins']);

    // A family satisfies this by calling the shared adapter itself, or by
    // calling the ONE composition that wraps it. `/reports` is the second
    // case (card 72258a60): its three narrowings moved into
    // `services/ReportVisibility` so the dashboard's `reportCount` could run
    // exactly the same rule, and a census that only accepted the raw name
    // would have read that as the narrowing disappearing.
    //
    // The composition is not taken on trust: the file it names is read, and
    // it must itself reach the shared adapter. This census still cannot see
    // whether a narrowing RAN — that is what `listPointParity` measures — but
    // it can refuse to be satisfied by a name that resolves to nothing.
    const COMPOSED_NARROWINGS: Record<string, { via: string; module: string; adapter: string }> = {
      '/reports': { via: 'filterVisibleReports', module: 'services/ReportVisibility.ts', adapter: 'filterAuthorizedResources' },
      '/blueprints': { via: 'blueprintRegistry.list(caller(req))', module: 'services/BlueprintRegistryService.ts', adapter: 'authorizationRepository.listScope' },
    };
    for (const mount of ROW_AUTHORIZED_ROUTE_MOUNTS) {
      const routeFile = mount.slice(1);
      const source = fs.readFileSync(path.join(root, 'routes', `${routeFile}.ts`), 'utf8');
      const composed = COMPOSED_NARROWINGS[mount];
      if (!composed) {
        expect(source).toContain('filterAuthorizedResources');
        continue;
      }
      expect(`${mount} calls ${composed.via}: ${source.includes(composed.via)}`)
        .toBe(`${mount} calls ${composed.via}: true`);
      const via = fs.readFileSync(path.join(root, ...composed.module.split('/')), 'utf8');
      expect(`${composed.module} reaches the shared adapter: ${via.includes(composed.adapter)}`)
        .toBe(`${composed.module} reaches the shared adapter: true`);
      if (mount === '/blueprints') {
        expect(source).toContain('blueprintRegistry.get(req.params.id,caller(req)');
        expect(via).toContain("authorizationRepository.listScope(caller.actor, 'blueprint', action)");
        expect(via).toContain("authorizationRepository.listScope(caller.actor, 'blueprint', read ? 'read' : 'use')");
        expect(via).toContain("this.resolve(identifier, caller, read ? 'read' : 'use')");
      }
    }

    const batchSource = fs.readFileSync(path.join(root, 'routes', 'tasksBatch.ts'), 'utf8');
    expect(batchSource).toContain('filterAuthorizedResources(');
    expect(batchSource).toContain("'write'");
  });
});
