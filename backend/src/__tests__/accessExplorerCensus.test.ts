/**
 * Card 1e56dbef — AZ-A12 build 6 (clause 12, E45 (3)): the Access Explorer's
 * fast-tier CENSUS CONTROLS. The live suite (accessExplorerLive.test.ts)
 * proves on a generated matrix that the read model agrees with the enforcing
 * evaluator; these controls keep that agreement from rotting silently when the
 * evaluator changes:
 *
 *   E-1  every key of the evaluator's resource shape (`AuthorizationSqlResource`,
 *        read from AuthorizationService.ts) is classified as a principal
 *        coordinate the Explorer nominates from, or as a non-principal key, and
 *        every shape `sqlResource` returns uses only classified keys;
 *   E-2  every source basis `sqlCondition` can emit (read from its text) is
 *        either nominated for or stated as a board-wide class, never both;
 *   E-3  the verdict is the evaluator's: the service renders `sqlCondition`
 *        with `includeSources`, reads the Group tier through the shared
 *        fragment, and never scans `effectiveAccess` (LENSES v7 B-L6);
 *   E-4  the route family: GET at `principals:read`, everything else `root`,
 *        transport `any`, mounted once in the registry and the manifest, and
 *        no MCP tool reaches it.
 */
import fs from 'fs';
import path from 'path';
import {
  BOARD_WIDE_BASES, EXPLORER_TYPES, NOMINATED_BASES, SHAPE_NON_PRINCIPAL_KEYS, SHAPE_PRINCIPAL_ARRAY_KEYS,
  SHAPE_PRINCIPAL_KEYS, SHAPE_PRINCIPAL_LIST_KEYS,
} from '../services/AccessExplorerService';
import { authorizationRepository } from '../services/AuthorizationRepository';
import { requiredScopeFor } from '../utils/scopeMap';
import { routeTransportClassFor } from '../utils/transportMap';
import { PROTECTED_ROUTE_MOUNTS } from '../utils/authorizationRouteManifest';
import { PROTECTED_ROUTE_REGISTRATIONS } from '../routeRegistry';
import { buildOpenApiSpec } from '../openapi/spec';

const SRC = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

function shapeKeys(): string[] {
  const text = read('services/AuthorizationService.ts');
  const start = text.indexOf('export interface AuthorizationSqlResource {');
  expect(start).toBeGreaterThan(-1);
  const end = text.indexOf('\n}\n', start);
  const body = text.slice(start, end);
  return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((match) => match[1]).sort();
}

function evaluatorBases(): string[] {
  const text = read('services/AuthorizationService.ts');
  const start = text.indexOf('  sqlCondition(');
  expect(start).toBeGreaterThan(-1);
  const body = text.slice(start);
  const found = new Set<string>();
  for (const pattern of [
    /addArm\('([a-z-]+)'/g,
    /basis: '([a-z-]+)'/g,
    /coreBasis\.set\([^,]+, '([a-z-]+)'\)/g,
    /addPrincipalArm\([^,]+, '([a-z-]+)'\)/g,
    /basis = '([a-z-]+)'/g,
  ]) {
    for (const match of body.matchAll(pattern)) found.add(match[1]);
  }
  // The Group-owner arm's union type, and the Account-side prefix it gains on a chain.
  for (const match of body.matchAll(/'(group-[a-z-]+)'/g)) found.add(match[1]);
  if (body.includes('`account-${arm.basis}`')) {
    for (const basis of [...found].filter((entry) => entry.startsWith('group-'))) found.add(`account-${basis}`);
  }
  return [...found].sort();
}

describe('E-1 the evaluator shape keys are classified', () => {
  const classified = [
    ...SHAPE_PRINCIPAL_KEYS, ...SHAPE_PRINCIPAL_LIST_KEYS, ...SHAPE_PRINCIPAL_ARRAY_KEYS, ...SHAPE_NON_PRINCIPAL_KEYS,
  ];

  it('every key AuthorizationSqlResource declares is in exactly one list', () => {
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual(shapeKeys());
  });

  it.each(EXPLORER_TYPES)('the %s shape uses classified keys only', (type) => {
    const { resource } = authorizationRepository.sqlResource(type);
    expect(Object.keys(resource).filter((key) => !classified.includes(key as never))).toEqual([]);
  });
});

describe('E-2 every source basis is nominated or board-wide', () => {
  it('the census finds the bases sqlCondition emits, and the two lists partition them', () => {
    const bases = evaluatorBases();
    expect(bases.length).toBeGreaterThan(15);
    const declared = [...NOMINATED_BASES, ...BOARD_WIDE_BASES];
    expect(new Set(declared).size).toBe(declared.length);
    expect([...declared].sort()).toEqual(bases);
  });
});

describe('E-3 the verdict is the evaluator, not a second rule set', () => {
  const service = read('services/AccessExplorerService.ts');
  it('renders sqlCondition with its sources, and the Group tier through the shared fragment', () => {
    expect(service).toContain('authorizationService.sqlCondition(actor, action, resource, params.length + 1, { includeSources: true })');
    expect(service).toContain('for (const action of AUTHORIZATION_ACTIONS) {');
    expect(service).toContain("groupOwnerCondition({ owner: '$1::uuid', account: 'm.account_principal_id', tier: 'edit' })");
    expect(service).toContain('authorizationRepository.sqlResource(type as GrantResourceType)');
  });
  it('never scans effectiveAccess and never re-implements the grant or profile seams', () => {
    expect(service).not.toMatch(/effectiveAccess\(/);
    expect(service).not.toMatch(/activeGrantCondition|activeProfileCondition/);
    expect(service).not.toMatch(/\bgrantAllows\(/);
  });
});

describe('E-4 the route family', () => {
  it('GET is principals:read and every other method is root', () => {
    for (const route of ['/access-explorer/objects/task/x', '/access-explorer/groups/x', '/access-explorer/principals/x']) {
      expect([route, requiredScopeFor('GET', route)]).toEqual([route, 'principals:read']);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        expect([route, method, requiredScopeFor(method, route)]).toEqual([route, method, 'root']);
      }
    }
    expect(requiredScopeFor('GET', '/groups/x/members/y/access')).toBe('principals:read');
  });
  it('is declared for every transport, mounted once and listed in the manifest', () => {
    expect(routeTransportClassFor('/access-explorer/objects/task/x')).toBe('any');
    expect(PROTECTED_ROUTE_REGISTRATIONS.filter((entry) => entry.path === '/access-explorer')).toHaveLength(1);
    expect((PROTECTED_ROUTE_MOUNTS as readonly string[]).filter((mount) => mount === '/access-explorer')).toHaveLength(1);
  });
  it('declares GET routes only, and no MCP tool reaches the family', () => {
    const routes = read('routes/accessExplorer.ts');
    expect([...routes.matchAll(/^router\.(\w+)\(/gm)].map((match) => match[1])).toEqual(['get', 'get', 'get']);
    expect(read('mcp/registry.ts')).not.toContain('/access-explorer');
    expect(read('mcp/registry.ts')).not.toContain('/members/${');
  });
  it('the OpenAPI document and the API reference name every route of the family and SR-3', () => {
    const spec = buildOpenApiSpec() as { paths: Record<string, Record<string, unknown>> };
    const paths = Object.keys(spec.paths);
    const docs = fs.readFileSync(path.join(SRC, '..', '..', 'docs', 'api.md'), 'utf8');
    for (const route of ['/access-explorer/objects/{type}/{id}', '/access-explorer/groups/{id}',
      '/access-explorer/principals/{id}', '/groups/{id}/members/{principalId}/access']) {
      expect([route, paths.includes(route), Object.keys(spec.paths[route] ?? {}).filter((key) => !key.startsWith('x-'))]).toEqual([route, true, ['get']]);
      expect([route, docs.includes(route)]).toEqual([route, true]);
    }
  });
});
