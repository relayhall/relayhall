/**
 * routeFamiliesNested.test.ts — card 2c000125 (parent card dac2ca71): the route
 * census composes a nested router's mount prefix into every family it
 * contributes.
 *
 * THE DEFECT THESE PIN. `collectRouteLayers` recursed into a nested router
 * with the OUTER mount unchanged, so a router mounted at a sub-path inside a
 * protected router contributed families WITHOUT its own prefix: receivers
 * mounted as a sub-router at `/otlp/v1` inside `/telemetry` were censused as
 * `POST /telemetry/traces` — a path the app does not serve — which resolved
 * against the route map to no rule, failed closed to root, and refused the
 * boot ("root-gated family ... is in no Access surface").
 *
 * WHAT IS THE ORACLE. Express itself. Every fixture is mounted on a real
 * Express app and every derived family is REQUESTED at its sample path; the
 * family set is also compared with the flat-mounted equivalent, which the old
 * derivation already spelled correctly. A family the app does not serve, or a
 * nested family spelled differently from its flat twin, fails here.
 *
 * THE CENSUS HALF. The fixtures are added to the REAL protected registrations
 * (the registry module is wrapped, not replaced), so the Access-surface census
 * runs over the real tree plus the nested mount: a nested mount of governed
 * telemetry routes adds no finding; a nested mount of an ungoverned root route
 * is refused under its FULL path (negative control); a mount whose prefix
 * cannot be derived is a named census finding, never a silently wrong family.
 */
import express, { Router, type Request, type Response } from 'express';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

jest.mock('../db/connection', () => ({
  pool: {
    query: jest.fn(async () => ({ rows: [] })),
    connect: jest.fn(async () => ({ query: jest.fn(async () => ({ rows: [] })), release: jest.fn() })),
  },
}));

/** Fixture registrations appended to the real protected registrations. */
const mockExtraRegistrations: Array<{ path: string; router: Router }> = [];
jest.mock('../routeRegistry', () => {
  const actual = jest.requireActual('../routeRegistry');
  return {
    ...actual,
    get PROTECTED_ROUTE_REGISTRATIONS() {
      return [...actual.PROTECTED_ROUTE_REGISTRATIONS, ...mockExtraRegistrations];
    },
  };
});

import {
  enumerateProtectedRouteFamilies,
  familySamplePath,
  resetRouteFamilyCache,
} from '../utils/routeFamilies';
import { accessSurfaceService } from '../services/AccessSurfaceService';

const HIT = 'x-route-fixture';

/** A handler that proves the request reached a fixture route. */
const hit = (_req: Request, res: Response): void => {
  res.status(200).set(HIT, 'hit').end();
};

interface Fixture {
  /** Registration mount, unique per fixture so its families can be isolated. */
  mount: string;
  router: Router;
  /** The families the fixture serves, spelled as Express mounts them. */
  expected: string[];
  /** The families the prefix-dropping derivation produced instead. */
  prefixDropped: string[];
  /** The same routes mounted FLAT: the spelling the census always got right. */
  flat: () => Router;
}

function oneLevel(): Fixture {
  // The shape TW1b met live: receivers as a sub-router at a two-segment prefix.
  const router = Router();
  const receivers = Router();
  receivers.post('/traces', hit);
  receivers.post('/logs', hit);
  receivers.get('/', hit);
  router.use('/otlp/v1', receivers);
  router.get('/discovery', hit);
  return {
    mount: '/zz-nest-one',
    router,
    expected: [
      'GET /zz-nest-one/discovery',
      'GET /zz-nest-one/otlp/v1',
      'POST /zz-nest-one/otlp/v1/logs',
      'POST /zz-nest-one/otlp/v1/traces',
    ],
    prefixDropped: ['POST /zz-nest-one/traces', 'POST /zz-nest-one/logs'],
    flat: () => {
      const flat = Router();
      flat.post('/otlp/v1/traces', hit);
      flat.post('/otlp/v1/logs', hit);
      flat.get('/otlp/v1', hit);
      flat.get('/discovery', hit);
      return flat;
    },
  };
}

function twoLevels(): Fixture {
  const router = Router();
  const middle = Router();
  const leaf = Router();
  leaf.get('/leaf', hit);
  leaf.delete('/leaf/:leafId', hit);
  middle.use('/y/z', leaf);
  middle.get('/mid', hit);
  router.use('/x', middle);
  return {
    mount: '/zz-nest-two',
    router,
    expected: [
      'DELETE /zz-nest-two/x/y/z/leaf/:leafId',
      'GET /zz-nest-two/x/mid',
      'GET /zz-nest-two/x/y/z/leaf',
    ],
    prefixDropped: ['GET /zz-nest-two/leaf', 'GET /zz-nest-two/mid'],
    flat: () => {
      const flat = Router();
      flat.get('/x/y/z/leaf', hit);
      flat.delete('/x/y/z/leaf/:leafId', hit);
      flat.get('/x/mid', hit);
      return flat;
    },
  };
}

function pathless(): Fixture {
  const router = Router();
  const inner = Router();
  inner.get('/plain', hit);
  router.use(inner);
  return {
    mount: '/zz-nest-pathless',
    router,
    expected: ['GET /zz-nest-pathless/plain'],
    prefixDropped: [],
    flat: () => {
      const flat = Router();
      flat.get('/plain', hit);
      return flat;
    },
  };
}

function atSlash(): Fixture {
  const router = Router();
  const inner = Router();
  inner.put('/slash', hit);
  router.use('/', inner);
  return {
    mount: '/zz-nest-slash',
    router,
    expected: ['PUT /zz-nest-slash/slash'],
    prefixDropped: [],
    flat: () => {
      const flat = Router();
      flat.put('/slash', hit);
      return flat;
    },
  };
}

function parameterised(): Fixture {
  const router = Router();
  const inner = Router({ mergeParams: true });
  inner.patch('/owner-plane', hit);
  inner.get('/', hit);
  router.use('/services/:serviceId', inner);
  return {
    mount: '/zz-nest-param',
    router,
    expected: [
      'GET /zz-nest-param/services/:serviceId',
      'PATCH /zz-nest-param/services/:serviceId/owner-plane',
    ],
    prefixDropped: ['PATCH /zz-nest-param/owner-plane'],
    flat: () => {
      const flat = Router();
      flat.patch('/services/:serviceId/owner-plane', hit);
      flat.get('/services/:serviceId', hit);
      return flat;
    },
  };
}

function optionalSegment(): Fixture {
  const router = Router();
  const inner = Router();
  inner.post('/signal', hit);
  router.use('/v/:version?', inner);
  return {
    mount: '/zz-nest-optional',
    router,
    expected: ['POST /zz-nest-optional/v/:version?/signal'],
    prefixDropped: ['POST /zz-nest-optional/signal'],
    flat: () => {
      const flat = Router();
      flat.post('/v/:version?/signal', hit);
      return flat;
    },
  };
}

function caseSensitive(): Fixture {
  const router = Router({ caseSensitive: true });
  const inner = Router();
  inner.get('/r', hit);
  router.use('/CaseD.v2', inner);
  return {
    mount: '/zz-nest-case',
    router,
    expected: ['GET /zz-nest-case/CaseD.v2/r'],
    prefixDropped: ['GET /zz-nest-case/r'],
    flat: () => {
      const flat = Router({ caseSensitive: true });
      flat.get('/CaseD.v2/r', hit);
      return flat;
    },
  };
}

const FIXTURES: Array<[string, () => Fixture]> = [
  ['a sub-router at a two-segment prefix (the TW1b shape)', oneLevel],
  ['nesting two levels deep', twoLevels],
  ['a path-less use()', pathless],
  ["a router mounted at '/'", atSlash],
  ['a parameterised prefix', parameterised],
  ['an optional segment in the prefix', optionalSegment],
  ['a case-sensitive router with a dotted prefix', caseSensitive],
];

/** The census families under one fixture mount, after registering `extra`. */
function familiesUnder(mount: string, extra: Array<{ path: string; router: Router }>): string[] {
  mockExtraRegistrations.splice(0, mockExtraRegistrations.length, ...extra);
  resetRouteFamilyCache();
  return enumerateProtectedRouteFamilies()
    .filter((family) => family.path === mount || family.path.startsWith(`${mount}/`))
    .map((family) => family.key)
    .sort();
}

/** One real HTTP request against an Express app serving `mount` → `router`. */
async function served(mount: string, router: Router, method: string, path: string): Promise<{ status: number; hit: boolean }> {
  const app = express();
  app.use(mount, router);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method, path }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, hit: res.headers[HIT] === 'hit' }));
      });
      req.on('error', reject);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

afterEach(() => {
  mockExtraRegistrations.splice(0, mockExtraRegistrations.length);
  resetRouteFamilyCache();
});

describe('a nested router contributes its families under its own mount prefix', () => {
  it.each(FIXTURES)('%s: the derived families are the ones Express serves', async (_name, build) => {
    const fixture = build();
    const derived = familiesUnder(fixture.mount, [{ path: fixture.mount, router: fixture.router }]);
    expect(derived).toEqual([...fixture.expected].sort());

    // Express is the oracle: every derived family answers at its sample path.
    for (const key of derived) {
      const [method, path] = key.split(' ');
      const answer = await served(fixture.mount, build().router, method, familySamplePath(path));
      expect({ key, ...answer }).toEqual({ key, status: 200, hit: true });
    }
    // ...and the spelling the prefix-dropping derivation produced is a path the
    // app does NOT serve. Deriving it is what refused the boot.
    for (const key of fixture.prefixDropped) {
      expect(derived).not.toContain(key);
      const [method, path] = key.split(' ');
      const answer = await served(fixture.mount, build().router, method, familySamplePath(path));
      expect({ key, ...answer }).toEqual({ key, status: 404, hit: false });
    }
  });

  it.each(FIXTURES)('%s: the nested mount censuses exactly as its flat twin does', (_name, build) => {
    const fixture = build();
    const nested = familiesUnder(fixture.mount, [{ path: fixture.mount, router: fixture.router }]);
    const flat = familiesUnder(fixture.mount, [{ path: fixture.mount, router: fixture.flat() }]);
    expect(nested).toEqual(flat);
  });

  it('a prefix that is not a plain Express path is refused by name, never guessed', () => {
    const regexpMounted = Router();
    const inner = Router();
    inner.get('/probe', hit);
    regexpMounted.use(/^\/re(?=\/|$)/i, inner);
    mockExtraRegistrations.splice(0, mockExtraRegistrations.length, { path: '/zz-nest-regexp', router: regexpMounted });
    resetRouteFamilyCache();
    expect(() => enumerateProtectedRouteFamilies()).toThrow(/cannot derive the mount prefix of a nested router under '\/zz-nest-regexp'/);
  });

  it('an array-mounted sub-router is refused by name, never censused under one spelling', () => {
    const arrayMounted = Router();
    const inner = Router();
    inner.get('/probe', hit);
    arrayMounted.use(['/a', '/b'], inner);
    mockExtraRegistrations.splice(0, mockExtraRegistrations.length, { path: '/zz-nest-array', router: arrayMounted });
    resetRouteFamilyCache();
    expect(() => enumerateProtectedRouteFamilies()).toThrow(/cannot derive the mount prefix of a nested router under '\/zz-nest-array'/);
  });
});

describe('the Access-surface census over the real tree plus a nested mount', () => {
  /** The census with NO surfaces declared: every root family is a finding. */
  const census = (extra: Array<{ path: string; router: Router }>): string[] => {
    mockExtraRegistrations.splice(0, mockExtraRegistrations.length, ...extra);
    resetRouteFamilyCache();
    return accessSurfaceService.censusFindings([]);
  };

  /** The telemetry receivers as TW1b first mounted them: two levels deep. */
  function nestedTelemetry(): Router {
    const telemetry = Router();
    const otlp = Router();
    const v1 = Router();
    for (const signal of ['traces', 'logs', 'metrics']) v1.post(`/${signal}`, hit);
    otlp.use('/v1', v1);
    otlp.post('/:version/:signal', hit);
    telemetry.use('/otlp', otlp);
    return telemetry;
  }

  it('ADMITS a nested mount of governed routes: it adds no finding to the real tree', () => {
    const baseline = census([]);
    const withNested = census([{ path: '/telemetry', router: nestedTelemetry() }]);
    expect(withNested).toEqual(baseline);
    // The live refusal, by its own words, is absent.
    for (const signal of ['traces', 'logs', 'metrics']) {
      expect(withNested.join('\n')).not.toContain(`'POST /telemetry/${signal}'`);
    }
    // ...because the nested families resolve to the receivers' real rule.
    const families = new Map(enumerateProtectedRouteFamilies().map((family) => [family.key, family.requirement]));
    expect(families.get('POST /telemetry/otlp/v1/traces')).toBe('telemetry:write');
    expect(families.get('POST /telemetry/otlp/:version/:signal')).toBe('telemetry:write');
  });

  it('REFUSES a nested mount of an ungoverned root family, under its full path (negative control)', () => {
    const baseline = census([]);
    const outer = Router();
    const deep = Router();
    deep.get('/probe', hit);
    outer.use('/deep', deep);
    const withUngoverned = census([{ path: '/zz-ungoverned', router: outer }]);
    expect(withUngoverned.filter((finding) => !baseline.includes(finding))).toEqual([
      "root-gated family 'GET /zz-ungoverned/deep/probe' is in no Access surface and not in UNGOVERNED_ROOT_FAMILIES",
    ]);
  });

  it('a nested mount whose prefix cannot be derived is a census finding that names it', () => {
    const baseline = census([]);
    const outer = Router();
    const inner = Router();
    inner.get('/probe', hit);
    outer.use(/^\/re(?=\/|$)/i, inner);
    const findings = census([{ path: '/zz-nest-regexp', router: outer }]);
    const added = findings.filter((finding) => !baseline.includes(finding));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/cannot derive the mount prefix of a nested router under '\/zz-nest-regexp'/);
  });
});
