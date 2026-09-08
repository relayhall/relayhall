/**
 * THE TRACE PRINTS IN EXACTLY THE OLD CASES — measured, not argued.
 *
 * Card `d0f030a9` moved clauses 4b/5/6/7 out of `evaluateSurfaceStage` and into
 * `AccessSurfaceService.armDecision`. The trace line used to be positioned
 * BETWEEN the family test and the level computation, so its position WAS its
 * condition. It is now gated on `decision.levelComputed`.
 *
 * Annex `85a2218d` D16's invocation record is a claim about the ORDERING — that
 * a scope-gated family never reaches the arm — so a trace that fired one
 * refusal earlier, or one later, would quietly change what D16 measures. The
 * brief asks a reviewer to satisfy themselves the new gate is equivalent. This
 * file does not ask them to take it on trust: it drives the REAL stage over
 * the whole input space that can reach it, records exactly which requests
 * printed a trace line, and asserts that set against the condition the OLD
 * position expressed — past 4b, past 5, and family !== null.
 *
 * The oracle is deliberately NOT `decision.levelComputed`. Deriving both sides
 * from the flag under test would be a test that agrees with itself; the oracle
 * is rebuilt from the three clauses as the base wrote them.
 */
const db = {
  script: [] as Array<(text: string, params?: unknown[]) => { rows: any[] } | null>,
};

function scripted(text: string, params?: unknown[]): { rows: any[] } {
  for (const handler of db.script) {
    const result = handler(text, params);
    if (result) return result;
  }
  return { rows: [] };
}

jest.mock('../db/connection', () => ({
  pool: {
    query: jest.fn(async (text: string, params?: unknown[]) => scripted(text, params)),
    connect: jest.fn(async () => ({
      query: jest.fn(async (text: string, params?: unknown[]) => scripted(text, params)),
      release: jest.fn(),
    })),
  },
}));

import { SURFACE_ARM_TRACE_PREFIX } from '../middleware/sharedAuthorization';
import { accessSurfaceService, type AccessLevel, type AccessSurfaceRecord } from '../services/AccessSurfaceService';
import { isAuthorityMutationSurfaceKey } from '../utils/authorityMutationSurfaces';
import { isLoginSessionKind } from '../utils/administratorSession';
import { ROOT_SCOPE } from '../utils/scopeMap';

const ID = (n: number): string => `0000000${n}-0000-4000-8000-000000000000`;
const PRINCIPAL = 'aaaaaaaa-0000-4000-8000-000000000000';

function surface(over: Partial<AccessSurfaceRecord> = {}): AccessSurfaceRecord {
  return {
    id: ID(1),
    key: 'settings.appearance',
    label: 'Appearance',
    governance: 'governable',
    lockedReference: null,
    readFamilies: ['GET /appearance/versions'],
    writeFamilies: ['PUT /appearance'],
    excludedFamilies: [],
    menuPath: '/settings/appearance',
    origin: 'core',
    pluginName: null,
    retiredAt: null,
    ...over,
  };
}

/** One surface of each shape the stage can meet past its own clauses 2-4. */
const CATALOGUE: AccessSurfaceRecord[] = [
  surface(),
  surface({ id: ID(2), key: 'settings.access-grants', label: 'Access grants',
    readFamilies: ['GET /grants'], writeFamilies: ['POST /grants'], menuPath: '/settings/access' }),
  surface({ id: ID(3), key: 'settings.webhooks', label: 'Webhooks', origin: 'plugin', pluginName: 'x',
    readFamilies: ['GET /webhooks'], writeFamilies: ['POST /webhooks'], menuPath: null }),
];

/**
 * THE MENU-SILENCE CATALOGUE — every shape `settingsSurfaces` can ASK ABOUT.
 *
 * ROUND-3 REVIEW P4-control. `CATALOGUE` above is the REQUEST-stage fixture and
 * its only plugin row declares no `menuPath`, so the menu never reached a
 * plugin arm and a mutation that traced plugin invocations stayed green. This
 * one is built for the other side of the branch: menu-bearing rows at every
 * governance and both origins, plus the two rows the menu must skip.
 */
const MENU_CATALOGUE: AccessSurfaceRecord[] = [
  surface({ id: ID(1), key: 'settings.appearance', governance: 'governable', origin: 'core',
    menuPath: '/settings/appearance' }),
  surface({ id: ID(2), key: 'settings.access-manager', governance: 'always-self', origin: 'core',
    readFamilies: ['GET /approvals'], writeFamilies: ['POST /approvals'], menuPath: '/settings/access-manager' }),
  surface({ id: ID(3), key: 'settings.identity-providers', governance: 'locked', lockedReference: 'A23.1',
    origin: 'core', readFamilies: ['GET /identity-providers'], writeFamilies: ['POST /identity-providers'],
    menuPath: '/settings/identity-providers' }),
  // THE ROW ROUND 3 FOUND MISSING: a menu-bearing PLUGIN surface, so the menu
  // actually asks a plugin arm — the arm's deliberate I6 exception, and the
  // only invocation the mutation could add without any other case noticing.
  surface({ id: ID(4), key: 'plugin.example.panel', governance: 'governable', origin: 'plugin',
    pluginName: 'example', readFamilies: ['GET /plugins/example/panel'],
    writeFamilies: ['POST /plugins/example/panel'], menuPath: '/settings/plugins/example' }),
  surface({ id: ID(5), key: 'plugin.other.locked', governance: 'always-self', origin: 'plugin',
    pluginName: 'other', readFamilies: ['GET /plugins/other'], writeFamilies: ['POST /plugins/other'],
    menuPath: '/settings/plugins/other' }),
  // ...and the two the menu must skip entirely, so "silent" is not the silence
  // of a catalogue with nothing menu-bearing in it.
  surface({ id: ID(6), key: 'settings.webhooks', governance: 'governable', origin: 'core',
    readFamilies: ['GET /webhooks'], writeFamilies: ['POST /webhooks'], menuPath: null }),
  surface({ id: ID(7), key: 'plugin.hidden.thing', governance: 'governable', origin: 'plugin',
    pluginName: 'hidden', readFamilies: ['GET /plugins/hidden'], writeFamilies: ['POST /plugins/hidden'],
    menuPath: null }),
];

function serveMenu(level: AccessLevel): void {
  db.script.push((text) => {
    if (text.includes('FROM access_surfaces')) {
      return {
        rows: MENU_CATALOGUE.map((s) => ({
          id: s.id, key: s.key, label: s.label, governance: s.governance,
          locked_reference: s.lockedReference, read_families: s.readFamilies,
          write_families: s.writeFamilies, excluded_families: s.excludedFamilies,
          menu_path: s.menuPath, origin: s.origin, plugin_name: s.pluginName, retired_at: s.retiredAt,
        })),
      };
    }
    if (text.includes('AS can_read')) {
      return { rows: [{ can_read: level !== 'none', can_write: level === 'configure' }] };
    }
    return null;
  });
}

function serve(level: AccessLevel): void {
  db.script.push((text) => {
    if (text.includes('FROM access_surfaces')) {
      return {
        rows: CATALOGUE.map((s) => ({
          id: s.id, key: s.key, label: s.label, governance: s.governance,
          locked_reference: s.lockedReference, read_families: s.readFamilies,
          write_families: s.writeFamilies, excluded_families: s.excludedFamilies,
          menu_path: s.menuPath, origin: s.origin, plugin_name: s.pluginName, retired_at: s.retiredAt,
        })),
      };
    }
    if (text.includes('AS can_read')) {
      return { rows: [{ can_read: level !== 'none', can_write: level === 'configure' }] };
    }
    return null;
  });
}

function response() {
  const res: any = { statusCode: null, status(c: number) { res.statusCode = c; return res; }, json() { return res; } };
  return res;
}

/** THE ORACLE, rebuilt from the three clauses as the BASE expressed them. */
function baseWouldTrace(
  s: AccessSurfaceRecord,
  authMethod: string,
  method: string,
  path: string,
): boolean {
  if (s.governance !== 'governable') return false;              // stage clause 3/4
  if (isAuthorityMutationSurfaceKey(s.key)) return false;       // clause 4b, returned first
  if (s.origin === 'core' && !isLoginSessionKind(authMethod)) return false; // clause 5
  return accessSurfaceService.familyClassFor(s, method, path) !== null;     // clause 6
}

const AUTH_METHODS = ['session', 'dashboard_jwt', 'principal_api_key', 'legacy_api_key', 'system'];
const LEVELS: AccessLevel[] = ['none', 'use', 'configure'];

describe('the arm trace fires on exactly the requests the old position fired on', () => {
  let traced: string[] = [];
  let spy: jest.SpyInstance;

  beforeEach(() => {
    db.script = [];
    traced = [];
    spy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(' ');
      if (line.startsWith(SURFACE_ARM_TRACE_PREFIX)) traced.push(line);
    });
  });
  afterEach(() => spy.mockRestore());

  it('agrees with the base oracle over the whole reachable input space', async () => {
    process.env.RELAYHALL_SURFACE_ARM_TRACE = '1';
    jest.resetModules();
    // The module read the env at import; re-import so the flag is live.
    const stage = require('../middleware/sharedAuthorization') as typeof import('../middleware/sharedAuthorization');

    const disagreements: string[] = [];
    let expectedTrue = 0;
    let expectedFalse = 0;

    for (const s of CATALOGUE) {
      // Every declared family, plus one path on NO declared family.
      const requests: Array<[string, string]> = [
        ...s.readFamilies.map((f) => f.split(' ') as [string, string]),
        ...s.writeFamilies.map((f) => f.split(' ') as [string, string]),
        ['GET', `${s.readFamilies[0].split(' ')[1]}/undeclared-tail`],
      ];
      for (const [method, path] of requests) {
        for (const authMethod of AUTH_METHODS) {
          for (const level of LEVELS) {
            db.script = [];
            serve(level);
            traced = [];
            await stage.evaluateSurfaceStage(
              { method, path, baseUrl: '', principal: { id: PRINCIPAL, role: 'user' },
                authMethod, scopes: [], userId: 'someone' } as any,
              response(),
              path,
              ROOT_SCOPE,
            );
            const actual = traced.length > 0;
            const expected = baseWouldTrace(s, authMethod, method, path);
            if (expected) expectedTrue += 1; else expectedFalse += 1;
            if (actual !== expected) {
              disagreements.push(`${s.key} ${method} ${path} auth=${authMethod} level=${level}: traced=${actual} base=${expected}`);
            }
          }
        }
      }
    }

    delete process.env.RELAYHALL_SURFACE_ARM_TRACE;

    // The drill must exercise BOTH answers, or agreement is trivial.
    expect(expectedTrue).toBeGreaterThan(0);
    expect(expectedFalse).toBeGreaterThan(0);
    expect(disagreements).toEqual([]);
  });

  /**
   * ROUND-2 REVIEW P4-CONTROL, and the case the SECOND version MISSED.
   *
   * D16's record is a claim about the invocations REQUESTS made. The menu asks
   * the same arm about the same surfaces and must leave no trace of it, or the
   * record counts invocations nobody made — and the only thing expressing that
   * is `tracePath !== undefined`, since a menu question passes none.
   *
   * Every case above drives the request stage, which passes a `tracePath`
   * always. So deleting `&& tracePath !== undefined` changed nothing any of
   * them could see: the oracle agreed, the throwing-level case agreed, and the
   * suite stayed green while the menu started writing into the record. A
   * control that cannot observe the silence it depends on is not measuring the
   * clause; it is measuring the half of it that happens to be exercised.
   *
   * This drives the OTHER side of the branch: the menu, and a direct arm call
   * with no path, both with tracing ON — and then the same surface through a
   * REQUEST, so the silence is a filtered result and not a dead flag.
   *
   * ROUND-3 REVIEW P4-control, AND THE REGRESS IT NAMES. The first version of
   * this case sampled: core menu rows at one level, because the fixture's only
   * plugin row declared no `menuPath` and the menu therefore never asked a
   * plugin arm. The mutation
   *
   *     if (SURFACE_ARM_TRACE && (tracePath !== undefined || surface.origin === 'plugin'))
   *
   * left every case green while every menu-bearing plugin invocation entered
   * D16. That is three rounds of writing the case for the cell the last round
   * missed — the trace's position, then the menu at all, then the menu's other
   * origin — and each time the next cell was the finding.
   *
   * So it stops sampling. The property is UNIVERSAL: a menu computation emits
   * nothing, for every surface in the catalogue, at every governance, both
   * origins, every authentication kind and every level. It is now asserted
   * over that whole product, with the number of arm invocations the menu
   * actually made counted alongside — so the silence cannot be the silence of
   * a drill that asked nothing.
   */
  it('a MENU computation is silent for EVERY surface, kind and level — and a REQUEST is not', async () => {
    process.env.RELAYHALL_SURFACE_ARM_TRACE = '1';
    jest.resetModules();
    // Re-import BOTH: the flag is read at module scope in the service, so the
    // instance imported at the top of this file still has it off.
    const service = require('../services/AccessSurfaceService') as typeof import('../services/AccessSurfaceService');
    const stage = require('../middleware/sharedAuthorization') as typeof import('../middleware/sharedAuthorization');

    // 1. THE MENU, UNIVERSALLY. Every authentication kind × every level, over a
    //    catalogue holding every governance and BOTH origins, menu-bearing and
    //    not. Round 3's mutation added a plugin-origin trace and every sampled
    //    case stayed green, so this stops sampling: the property is that a menu
    //    computation emits nothing, and it is asserted where it is claimed.
    const noise: string[] = [];
    let armsAsked = 0;
    for (const authMethod of ['session', 'dashboard_jwt', 'principal_api_key', 'legacy_api_key', 'system']) {
      for (const level of LEVELS) {
        for (const rootAuthorized of [false, true]) {
          db.script = [];
          serveMenu(level);
          traced = [];
          const entries = await service.accessSurfaceService.settingsSurfaces(
            { principalId: PRINCIPAL, authMethod, rootAuthorized },
          );
          // Count the arm invocations this menu question actually made, so the
          // silence below is the silence of a drill that DID something. A menu
          // reaches the arm exactly for a governable surface it consults.
          armsAsked += entries.length;
          if (traced.length > 0) {
            noise.push(`auth=${authMethod} level=${level} root=${rootAuthorized}: ${JSON.stringify(traced)}`);
          }
        }
      }
    }
    expect(noise).toEqual([]);
    expect(armsAsked).toBeGreaterThan(0);

    // ...and the drill really did reach a PLUGIN arm through the menu, which is
    // the invocation round 3's mutation added and no earlier case observed.
    db.script = [];
    serveMenu('use');
    traced = [];
    const pluginVisible = await service.accessSurfaceService.settingsSurfaces(
      { principalId: PRINCIPAL, authMethod: 'principal_api_key', rootAuthorized: false },
    );
    expect(pluginVisible.some((entry) => entry.key === 'plugin.example.panel' && entry.visible)).toBe(true);
    expect(traced).toEqual([]);

    // 2. A DIRECT ARM CALL with no mounted path — the same absence, without the
    //    menu around it, for a core row and a plugin row.
    for (const s of [MENU_CATALOGUE[0], MENU_CATALOGUE[3]]) {
      db.script = [];
      serveMenu('use');
      traced = [];
      const decision = await service.accessSurfaceService.armDecision(
        { principalId: PRINCIPAL, authMethod: 'session' }, s, 'read',
      );
      expect([s.key, decision.admitted]).toEqual([s.key, true]);
      expect([s.key, traced]).toEqual([s.key, []]);
    }

    // 3. THE CONTROL ON THE SILENCE. The identical surfaces, reached as
    //    REQUESTS, DO record — so `traced` was empty because the line did not
    //    fire, not because the flag, the spy or the fixture was inert.
    for (const s of [CATALOGUE[0]]) {
      db.script = [];
      serve('use');
      traced = [];
      const [method, requestPath] = s.readFamilies[0].split(' ');
      await stage.evaluateSurfaceStage(
        { method, path: requestPath, baseUrl: '', principal: { id: PRINCIPAL, role: 'user' },
          authMethod: 'session', scopes: [], userId: 'someone' } as any,
        response(), requestPath, ROOT_SCOPE,
      );
      expect([s.key, traced.length]).toEqual([s.key, 1]);
      expect(traced[0]).toContain(s.key);
    }

    delete process.env.RELAYHALL_SURFACE_ARM_TRACE;
  });

  /**
   * ROUND-1 REVIEW P4, and the case the first version of this file MISSED.
   *
   * The base emitted the line BEFORE awaiting `surfaceLevel`, so a level query
   * that threw still left an invocation in D16's record. The first extraction
   * gated the line on a flag the decision returned AFTER that await, which
   * cannot express "we got as far as the await" — a throwing query silently
   * removed a line the base emitted. The oracle above never noticed because
   * every case it drove had a level query that answered.
   */
  it('still records the invocation when the level query THROWS', async () => {
    process.env.RELAYHALL_SURFACE_ARM_TRACE = '1';
    jest.resetModules();
    const stage = require('../middleware/sharedAuthorization') as typeof import('../middleware/sharedAuthorization');

    db.script = [];
    serve('none');
    // The catalogue read answers; the LEVEL read does not.
    db.script.unshift((text: string) => {
      if (text.includes('AS can_read')) throw new Error('level query failed');
      return null;
    });

    const [method, path] = CATALOGUE[0].readFamilies[0].split(' ');
    let threw = false;
    try {
      await stage.evaluateSurfaceStage(
        { method, path, baseUrl: '', principal: { id: PRINCIPAL, role: 'user' },
          authMethod: 'session', scopes: [], userId: 'someone' } as any,
        response(), path, ROOT_SCOPE,
      );
    } catch { threw = true; }
    delete process.env.RELAYHALL_SURFACE_ARM_TRACE;

    // The throw is the stage's to handle (it answers 503); what this asserts is
    // that the arm was RECORDED as invoked before the query that failed.
    expect(threw).toBe(true);
    expect(traced).toHaveLength(1);
    expect(traced[0]).toContain(CATALOGUE[0].key);
  });
});
