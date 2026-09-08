/**
 * settingsSurfaceMenu.test.ts — the Settings menu and the arm are ONE decision.
 *
 * Card `d0f030a9` (RH-UI.SETTINGS.2). The Settings shell must not render a
 * navigation entry for a surface the session cannot reach: SETGOV `83defda6`
 * and design `7a9317b2` §9.6 both say a surface a session may not see is not
 * SHOWN, never merely disabled — a disabled control discloses the deployment's
 * shape, which is precisely what the arm's 404 concealment on a read family
 * exists to prevent.
 *
 * A SECOND PREDICATE IS THE DEFECT THIS FILE EXISTS TO REFUSE. The obvious
 * implementation is a rule in the frontend that agrees with the arm today. It
 * will not agree in a year: the arm's clauses are the authority-mutation
 * closure (`70af4d82` §1.1), the authentication-kind test (I6), the
 * governance switch and the level floor, each amendable on its own. So
 * `settingsSurfaces` is composed FROM `armDecision`, the shell renders its
 * answer, and this file measures the composition ACROSS THE SEAM: for every
 * surface and every session shape, it drives the REAL `evaluateSurfaceStage`
 * over HTTP-shaped requests and asserts the menu agrees with what the request
 * path actually did. A menu that merely re-states its own rule cannot pass
 * that; only one that shares the decision can.
 *
 * WHAT IS NOT HERE. The pool is a mock, so these are the STATIC half, exactly
 * as `accessSurfaces.test.ts` is: a mock fails only as it is told to. The
 * runtime half — a real `none` Account meeting a real 404, and the menu it is
 * served on the same session — is `scripts/setgov-live-drill.mjs` and the DEV
 * capture in the candidate's evidence.
 */
const db = {
  queries: [] as Array<{ text: string; params?: unknown[] }>,
  script: [] as Array<(text: string, params?: unknown[]) => { rows: any[] } | null>,
};

function scripted(text: string, params?: unknown[]): { rows: any[] } {
  db.queries.push({ text, params });
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

import fs from 'fs';
import path from 'path';
import * as ts from 'typescript';
import {
  accessSurfaceService,
  type AccessLevel,
  type AccessSurfaceRecord,
  type SurfaceGovernance,
} from '../services/AccessSurfaceService';
import { evaluateSurfaceStage } from '../middleware/sharedAuthorization';
import { requireSessionViewer } from '../routes/warrants';
import { AUTHORITY_MUTATION_SURFACE_KEYS } from '../utils/authorityMutationSurfaces';
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

/**
 * The menu-bearing shape of the seeded catalogue: one surface of each
 * governance, plus one authority-mutation surface, plus one that declares no
 * menu entry at all.
 */
const CATALOGUE: AccessSurfaceRecord[] = [
  surface(),
  surface({
    id: ID(2),
    key: 'settings.access-manager',
    label: 'Access manager',
    governance: 'always-self',
    readFamilies: ['GET /approvals'],
    writeFamilies: ['POST /approvals/:id/approve'],
    menuPath: '/settings/access-manager',
  }),
  surface({
    id: ID(3),
    key: 'settings.identity-providers',
    label: 'Identity providers',
    governance: 'locked',
    lockedReference: 'A23.1',
    readFamilies: ['GET /identity-providers'],
    writeFamilies: ['POST /identity-providers'],
    menuPath: '/settings/identity-providers',
  }),
  surface({
    id: ID(4),
    key: 'settings.access-grants',
    label: 'Access grants',
    governance: 'governable',
    readFamilies: ['GET /grants'],
    writeFamilies: ['POST /grants'],
    menuPath: '/settings/access',
  }),
  surface({
    id: ID(5),
    key: 'settings.webhooks',
    label: 'Webhooks',
    governance: 'governable',
    readFamilies: ['GET /webhooks'],
    writeFamilies: ['POST /webhooks'],
    menuPath: null,
  }),
  // ROUND-1 REVIEW C1. The fixture omitted the second authority-mutation
  // surface that HAS a menu path, so a menu special-casing `settings.identities`
  // to visible passed while the real arm refuses it through the closure. The
  // navigation names this key; the drill must too.
  surface({
    id: ID(6),
    key: 'settings.identities',
    label: 'Identities',
    governance: 'governable',
    readFamilies: ['GET /principals/remediation-queue'],
    writeFamilies: [],
    menuPath: '/settings/principals',
  }),
  // ...and no PLUGIN-origin menu surface existed either, so the arm's
  // deliberate plugin exception to the authentication-kind clause (I6: there
  // the arm can only NARROW) was never exercised through the menu. A menu that
  // hid every plugin surface, or showed every one, passed identically.
  surface({
    id: ID(7),
    key: 'plugin.example.panel',
    label: 'Example panel',
    governance: 'governable',
    origin: 'plugin',
    pluginName: 'example',
    readFamilies: ['GET /plugins/example/panel'],
    writeFamilies: ['POST /plugins/example/panel'],
    menuPath: '/settings/plugins/example',
  }),
];

// ── WHAT THE DRILL BELOW IS DRIVEN OVER, AND WHY NONE OF IT IS TYPED HERE ───
//
// ROUND-2 REVIEW C1. The agreement drill used to run over the hand-written
// `CATALOGUE` above and a hand-written list of three sessions, and the review
// defeated it twice with things those lists did not happen to contain:
//
//   * `if (surface.key === 'settings.preferences') { … }` — a real menu-bearing
//     surface the shell navigates to, absent from the fixture, so the
//     special-case was invisible and a non-root login session silently lost a
//     page its handler admits;
//   * a `{ rootAuthorized: true, authMethod: 'principal_api_key' }` session —
//     absent from the list, and the exact shape of the P2 production defect.
//
// Round 1 had already been defeated once the same way (`settings.identities`
// and a plugin surface were missing), and the repair then was to ADD the two
// rows. That is repairing the coordinate: a fixture is a claim about a
// catalogue, and the next round finds the next row it does not make.
//
// So the fixture is off the assertion path. The surface keys come from the
// frontend's own navigation module — the file that decides which surfaces the
// shell has entries for at all — read with the TypeScript parser, and the
// sessions are the COMPLETE authentication-method vocabulary crossed with
// both values of `rootAuthorized`. Neither list can omit a case, because
// neither is a list anybody writes.

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const NAVIGATION_TS = path.join(
  REPO_ROOT, 'frontend', 'src', 'config', 'settingsNavigation.ts',
);

/**
 * `settingsNavEntries` from the frontend, as `{ path, surfaceKey }`.
 *
 * A source read across the package boundary, deliberately: the backend cannot
 * import the frontend, and re-typing the entries here would put the drill back
 * on a list that can disagree with what ships. The parser is the compiler's,
 * so this reads the DECLARATION rather than matching text that looks like one.
 */
function navigationEntries(): Array<{ path: string; surfaceKey: string | null }> {
  const source = ts.createSourceFile(
    NAVIGATION_TS, fs.readFileSync(NAVIGATION_TS, 'utf8'), ts.ScriptTarget.Latest, true,
  );
  const entries: Array<{ path: string; surfaceKey: string | null }> = [];
  const literal = (node: ts.Node | undefined): string | null => {
    if (!node) return null;
    if (ts.isStringLiteralLike(node)) return node.text;
    return null;
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === 'settingsNavEntries'
      && node.initializer
      && ts.isArrayLiteralExpression(node.initializer)
    ) {
      // ROUND-3 REVIEW C1. This used to `continue` past an element it could
      // not read, so an array of six entries where one is an identifier, a
      // spread or a call returned FIVE — a plausible, non-empty, WRONG set that
      // every non-vacuity guard accepts. A parser that skips what it does not
      // understand is a parser that reports a subset as a total. It refuses
      // instead: every element must be readable, or nothing is.
      for (const element of node.initializer.elements) {
        if (!ts.isObjectLiteralExpression(element)) {
          throw new Error(
            `settingsNavEntries contains an element this parser cannot read (${
              ts.SyntaxKind[element.kind]}: ${element.getText(source).slice(0, 60)}). `
            + 'The drill below is derived from this array, so a subset would be a silently '
            + 'narrower drill. Teach the parser or change the source.',
          );
        }
        const field = (name: string): ts.Expression | undefined => {
          for (const property of element.properties) {
            if (ts.isPropertyAssignment(property)
              && ts.isIdentifier(property.name)
              && property.name.text === name) return property.initializer;
          }
          return undefined;
        };
        const entryPath = literal(field('path'));
        if (entryPath === null) {
          throw new Error(
            `settingsNavEntries has an entry whose 'path' is not a string literal: ${
              element.getText(source).slice(0, 80)}`,
          );
        }
        entries.push({ path: entryPath, surfaceKey: literal(field('surfaceKey')) });
      }
      // ...and the count is the array's own, so a spread that reads as zero
      // elements, or a future syntax that reads as fewer, cannot pass either.
      expect(entries.length).toBe(node.initializer.elements.length);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return entries;
}

const NAVIGATED = navigationEntries().filter((entry) => entry.surfaceKey !== null);

/**
 * One catalogue record per navigated surface, all at one governance.
 *
 * The DRILL varies governance rather than assigning one per key, so no key is
 * only ever seen through one clause of the switch — which is what let a
 * per-key special case hide behind "that surface is always-self anyway".
 */
function navigatedCatalogue(
  governance: SurfaceGovernance,
  origin: 'core' | 'plugin' = 'core',
): AccessSurfaceRecord[] {
  // The navigated keys bind the drill to what ships; the unnameable ones make
  // the property universal (round-3 review C1). A plugin-origin catalogue keeps
  // its own key namespace, because a `plugin.*` key on a `core` record would be
  // a fiction the arm never sees.
  const keys = [
    ...NAVIGATED.map((entry) => ({ key: entry.surfaceKey as string, menuPath: entry.path })),
    ...UNNAMEABLE_KEYS
      .filter((key) => (origin === 'plugin') === key.startsWith('plugin.'))
      .map((key) => ({ key, menuPath: `/settings/drill/${key}` })),
  ];
  return keys.map((entry, index) => surface({
    id: ID(index + 1),
    key: entry.key,
    label: entry.key,
    governance,
    lockedReference: governance === 'locked' ? 'A23.1' : null,
    origin,
    pluginName: origin === 'plugin' ? 'example' : null,
    readFamilies: [`GET /drill/${entry.key.replace(/[.]/g, '/')}`],
    writeFamilies: [`POST /drill/${entry.key.replace(/[.]/g, '/')}`],
    menuPath: entry.menuPath,
  }));
}

/**
 * KEYS PRODUCTION CANNOT NAME — round-3 review C1, and the end of the regress.
 *
 * The derived key set is still a LIST, and round 3 defeated it with a key no
 * list could contain: `plugin.unlisted.panel`. Plugin surfaces come from
 * whatever manifests a deployment installs, so there is no static enumeration
 * of the real ones to derive from, and every round so far has been "add the row
 * the last round named".
 *
 * These keys exist in NO source file. A special case in `settingsSurfaces` or
 * `menuEntryVisible` cannot name them, because there is nothing to name — so
 * the drill below is not asking "are these particular surfaces decided
 * correctly", it is asking "is ANY surface decided correctly", which is the
 * property the menu actually claims. Together with the navigated keys, which
 * bind the drill to what ships, that closes both halves: a special case on a
 * real key is caught by the first set, and a special case on any key at all is
 * caught by the second.
 */
const UNNAMEABLE_KEYS = [
  'settings.zqx-core-drill-7f31',
  'plugin.zqx-drill-7f31.panel',
  'plugin.another-zqx-drill.thing',
];

/** Every `authMethod` the audit vocabulary admits — the complete input space. */
const EVERY_AUTH_METHOD = [
  'local_admin', 'dashboard_jwt', 'principal_api_key',
  'legacy_api_key', 'reports_read_key', 'session', 'system', 'unknown',
];

interface DrillSession { principalId: string | null; authMethod: string; rootAuthorized: boolean }

/**
 * Every authentication kind, at both values of root, WITH AND WITHOUT a
 * resolved principal. Nothing chosen.
 *
 * ROUND-3 REVIEW C1: `principalId` used to be fixed at `PRINCIPAL`, so a branch
 * on `principalId === null` was invisible — and the interface permits null.
 * The domain is measured now rather than excluded, which is why
 * `menuEntryVisible`'s `always-self` clause gained the resolved-principal half
 * of the gate it speaks for.
 */
const EVERY_SESSION: DrillSession[] = EVERY_AUTH_METHOD.flatMap((authMethod) => (
  [false, true].flatMap((rootAuthorized) => (
    [PRINCIPAL, null].map((principalId) => ({ principalId, authMethod, rootAuthorized }))
  ))
));

/** Answer `listSurfaces` with the catalogue, and the arm's level query with `level`. */
function serveCatalogue(level: AccessLevel, catalogue: AccessSurfaceRecord[] = CATALOGUE): void {
  db.script.push((text) => {
    if (text.includes('FROM access_surfaces')) {
      return {
        rows: catalogue.map((s) => ({
          id: s.id,
          key: s.key,
          label: s.label,
          governance: s.governance,
          locked_reference: s.lockedReference,
          read_families: s.readFamilies,
          write_families: s.writeFamilies,
          excluded_families: s.excludedFamilies,
          menu_path: s.menuPath,
          origin: s.origin,
          plugin_name: s.pluginName,
          retired_at: s.retiredAt,
        })),
      };
    }
    if (text.includes('AS can_read')) {
      return { rows: [{ can_read: level !== 'none', can_write: level === 'configure' }] };
    }
    return null;
  });
}

beforeEach(() => {
  db.queries = [];
  db.script = [];
});

/** A menu entry by key, or `undefined` when the menu omitted it entirely. */
async function menuEntry(
  key: string,
  session: { principalId: string | null; authMethod: string | undefined; rootAuthorized: boolean },
) {
  const entries = await accessSurfaceService.settingsSurfaces(session);
  return entries.find((entry) => entry.key === key);
}

const LOGIN = { principalId: PRINCIPAL, authMethod: 'session', rootAuthorized: false };
const BEARER = { principalId: PRINCIPAL, authMethod: 'principal_api_key', rootAuthorized: false };
const ROOT = { principalId: PRINCIPAL, authMethod: 'session', rootAuthorized: true };

describe('the menu answers only about surfaces that declare a menu entry', () => {
  it('omits a surface with no menu_path, however reachable it is', async () => {
    serveCatalogue('configure');
    const entries = await accessSurfaceService.settingsSurfaces(LOGIN);
    expect(entries.map((entry) => entry.key)).not.toContain('settings.webhooks');
    // ...and it is genuinely reachable, so the omission is about the MENU and
    // not about authority.
    expect(await accessSurfaceService.armDecision(LOGIN, CATALOGUE[4], 'read')).toMatchObject({ admitted: true });
  });

  it('answers every menu-bearing surface, for every session', async () => {
    serveCatalogue('none');
    for (const session of [LOGIN, BEARER, ROOT]) {
      db.script = [];
      serveCatalogue('none');
      const entries = await accessSurfaceService.settingsSurfaces(session);
      // A CONCEALED PLUGIN row is not enumerated at all (P3), so the answered
      // set depends on the session: a bearer sees no governable surface, and a
      // plugin surface it cannot see is not named to it either.
      const expected = [
        'settings.access-grants', 'settings.access-manager', 'settings.appearance',
        'settings.identities', 'settings.identity-providers',
      ];
      const keys = entries.map((entry) => entry.key).sort();
      expect(keys.filter((k) => !k.startsWith('plugin.'))).toEqual(expected);
    }
  });
});

describe('the ratified clauses, each measured on the menu', () => {
  it('root sees every registered entry — it satisfies the route stage and never reaches the arm', async () => {
    serveCatalogue('none');
    const entries = await accessSurfaceService.settingsSurfaces(ROOT);
    expect(entries.every((entry) => entry.visible)).toBe(true);
  });

  it('an always-self surface is visible to any authenticated session', async () => {
    serveCatalogue('none');
    expect(await menuEntry('settings.access-manager', LOGIN)).toMatchObject({ visible: true });
  });

  it('a locked surface is invisible below root — the ratified gate decides it, and it says no', async () => {
    serveCatalogue('configure');
    expect(await menuEntry('settings.identity-providers', LOGIN)).toEqual({ key: 'settings.identity-providers', visible: false });
  });

  it('a governable surface at use is visible; at none it is not', async () => {
    serveCatalogue('use');
    expect(await menuEntry('settings.appearance', LOGIN)).toMatchObject({ visible: true, level: 'use' });
    db.script = [];
    serveCatalogue('none');
    expect(await menuEntry('settings.appearance', LOGIN)).toEqual({ key: 'settings.appearance', visible: false });
  });

  it('an authority-mutation surface is invisible even at configure (ruling 70af4d82 §1.1)', async () => {
    serveCatalogue('configure');
    expect(await menuEntry('settings.access-grants', LOGIN)).toEqual({ key: 'settings.access-grants', visible: false });
    // And the closure is the one the arm names, not a second list here.
    expect(AUTHORITY_MUTATION_SURFACE_KEYS).toContain('settings.access-grants');
  });

  it('a bearer credential sees no governable entry, however the authority store reads (I6)', async () => {
    serveCatalogue('configure');
    expect(await menuEntry('settings.appearance', BEARER)).toEqual({ key: 'settings.appearance', visible: false });
    // ...and the always-self entry is withheld too (P2): the in-handler
    // self-scope arm those surfaces rely on is itself a LOGIN-SESSION arm.
    db.script = [];
    serveCatalogue('configure');
    expect(await menuEntry('settings.access-manager', BEARER))
      .toEqual({ key: 'settings.access-manager', visible: false });
  });

  it('reports no level on a surface the arm never consults — a level there would be a fiction', async () => {
    serveCatalogue('configure');
    const entries = await accessSurfaceService.settingsSurfaces(LOGIN);
    for (const entry of entries) {
      if (!entry.visible) continue;
      if (entry.governance !== 'governable') expect(entry.level).toBe('none');
    }
  });

  // ROUND-1 REVIEW P3. A concealed row discloses its KEY and nothing else, and
  // a concealed PLUGIN row is not enumerated at all: the full shape handed a
  // session that may not reach a surface a map of it, which is what the arm's
  // 404 on a read family exists to prevent.
  it('a concealed core row carries its key and nothing else', async () => {
    serveCatalogue('none');
    const entries = await accessSurfaceService.settingsSurfaces(LOGIN);
    for (const entry of entries) {
      if (entry.visible) continue;
      expect(Object.keys(entry).sort()).toEqual(['key', 'visible']);
    }
    // ...and the drill is not vacuous: something WAS concealed.
    expect(entries.some((entry) => !entry.visible)).toBe(true);
  });

  it('a concealed plugin row is not enumerated at all', async () => {
    serveCatalogue('none');
    const bearer = await accessSurfaceService.settingsSurfaces(BEARER);
    expect(bearer.some((entry) => entry.key.startsWith('plugin.'))).toBe(false);
    // A plugin surface the session CAN see is still named, so the omission is
    // about concealment and not about plugins.
    db.script = [];
    serveCatalogue('use');
    const login = await accessSurfaceService.settingsSurfaces(LOGIN);
    expect(login.some((entry) => entry.key === 'plugin.example.panel' && entry.visible)).toBe(true);
  });

  // ROUND-1 REVIEW P2. `always-self` is decided by the in-handler self-scope
  // arm, and THAT arm is a login-session arm (`requireSessionViewer` refuses a
  // bearer credential outright). The menu used to admit any authenticated
  // method here and so told a bearer caller it could see the Access manager
  // while every primary function of that page answered 403.
  it('an always-self surface is NOT shown to a bearer credential', async () => {
    serveCatalogue('none');
    expect(await menuEntry('settings.access-manager', BEARER))
      .toEqual({ key: 'settings.access-manager', visible: false });
    db.script = [];
    serveCatalogue('none');
    expect(await menuEntry('settings.access-manager', LOGIN)).toMatchObject({ visible: true });
  });
});

// ── THE CROSS-SEAM AGREEMENT ───────────────────────────────────────────────

interface FakeResponse {
  statusCode: number | null;
  body: unknown;
  status(code: number): FakeResponse;
  json(payload: unknown): FakeResponse;
}

function response(): FakeResponse {
  const res: FakeResponse = {
    statusCode: null,
    body: null,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: unknown) { res.body = payload; return res; },
  };
  return res;
}

/** The first declared read family of a surface, as a (method, path) request. */
function readRequest(s: AccessSurfaceRecord, session: { principalId: string | null; authMethod: string | undefined }) {
  const [method, path] = s.readFamilies[0].split(' ');
  return {
    req: {
      method,
      path,
      baseUrl: '',
      principal: session.principalId ? { id: session.principalId, role: 'user' } : undefined,
      authMethod: session.authMethod,
      scopes: [],
      userId: 'someone',
    } as any,
    path,
  };
}

/**
 * THE PROPERTY. For every surface the shell navigates to, at every governance,
 * and for every session the authentication vocabulary admits, the menu's
 * `visible` equals what the REQUEST PATH actually did — measured by running
 * `evaluateSurfaceStage`, not by re-deriving its rule.
 *
 * ROUND-2 REVIEW C1: the keys come from `settingsNavigation.ts` and the
 * sessions from `EVERY_AUTH_METHOD` × root, so a key or a session shape cannot
 * be missing from the drill by having been left out of a fixture.
 *
 * A ROOT session is not driven against the stage, because a root session never
 * reaches it — the route stage admits and `evaluateSurfaceStage` is not called
 * at all. The two root claims are anchored separately, below: `requireSessionViewer`
 * for what a root bearer can actually do, and a differential for what root
 * changes about a bearer's menu (nothing).
 */
describe('the menu agrees with what the request path actually does', () => {
  const LEVELS: AccessLevel[] = ['none', 'use', 'configure'];
  const GOVERNANCES: SurfaceGovernance[] = ['governable', 'always-self', 'locked'];
  const NON_ROOT = EVERY_SESSION.filter((session) => !session.rootAuthorized);

  it('the derivation is not vacuous — the navigation really parsed', () => {
    expect(NAVIGATED.length).toBeGreaterThanOrEqual(5);
    for (const entry of NAVIGATED) {
      expect(entry.surfaceKey).toMatch(/^settings\./);
      expect(entry.path).toMatch(/^\/settings\//);
    }
    // The two keys the review used to defeat the hand fixture are in it now
    // BECAUSE the navigation names them, not because they were added.
    expect(NAVIGATED.map((entry) => entry.surfaceKey))
      .toEqual(expect.arrayContaining(['settings.preferences', 'settings.identities']));
    expect(EVERY_SESSION).toHaveLength(EVERY_AUTH_METHOD.length * 2 * 2);
    // ...and the session product really does carry the null-principal half.
    expect(EVERY_SESSION.some((session) => session.principalId === null)).toBe(true);
  });

  /**
   * THE BACKSTOP UNDER THE DRILL — round-3 review C1, and the end of its regress.
   *
   * Three rounds have now defeated this drill by naming a key it did not hold:
   * `settings.identities`, then `settings.preferences`, then
   * `plugin.unlisted.panel`. The first two were repaired by adding the row and
   * then by deriving the rows; the third cannot be repaired that way at all,
   * because plugin keys come from whatever manifests a deployment installs and
   * no static list of the real ones exists. A special case naming a key outside
   * the drill is inert against ANY drill. That is a property of fixtures, not
   * of this one.
   *
   * So this stops asking which keys the drill holds and asks what a special
   * case must DO: spell a key. The decision path spells none — the arm, the
   * menu and the per-surface visibility rule contain no surface-key literal,
   * and the one ratified key list lives in its own module behind
   * `isAuthorityMutationSurfaceKey`, which the drill separately checks the arm
   * consults. A literal appearing there is a special case whatever key it
   * names, including one no fixture could hold.
   */
  it('the decision path spells NO surface key — a special case would have to', () => {
    const DECISION_FILES = [
      path.join('backend', 'src', 'services', 'AccessSurfaceService.ts'),
      path.join('backend', 'src', 'middleware', 'sharedAuthorization.ts'),
    ];

    /** Every string literal in a file that looks like a surface key. */
    const keyLiterals = (relative: string): string[] => {
      const full = path.join(REPO_ROOT, relative);
      const source = ts.createSourceFile(full, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true);
      const found: string[] = [];
      const visit = (node: ts.Node): void => {
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
          && /^(settings|plugin)\.[\w.-]+$/.test(node.text)) {
          found.push(`${relative}:${
            source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${node.text}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return found;
    };

    for (const file of DECISION_FILES) {
      expect([file, keyLiterals(file)]).toEqual([file, []]);
    }

    // NOT VACUOUS, and this is the part that matters: the scanner really does
    // find surface keys where they legitimately live, so an empty result above
    // is an absence and not a broken reader.
    const ratified = keyLiterals(path.join('backend', 'src', 'utils', 'authorityMutationSurfaces.ts'));
    expect(ratified.length).toBeGreaterThanOrEqual(3);
    expect(ratified.join(' ')).toContain('settings.access-grants');

    // ...and the arm reaches that list through the named predicate rather than
    // by re-spelling it, which is why the decision path can be literal-free.
    const arm = fs.readFileSync(
      path.join(REPO_ROOT, 'backend', 'src', 'services', 'AccessSurfaceService.ts'), 'utf8',
    );
    expect(arm).toContain('isAuthorityMutationSurfaceKey(surface.key)');
  });

  it('the drill runs over keys no production file can name (round-3 review C1)', () => {
    // The whole point of the unnameable keys is that a special case cannot
    // mention them, so this checks the premise rather than trusting it: the
    // strings must appear in NO backend or frontend source.
    const roots = [
      path.join(REPO_ROOT, 'backend', 'src'),
      path.join(REPO_ROOT, 'frontend', 'src'),
    ];
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); }
        else if (/\.(ts|tsx|sql)$/.test(entry.name)) files.push(full);
      }
    };
    for (const root of roots) walk(root);
    expect(files.length).toBeGreaterThan(100);

    for (const key of UNNAMEABLE_KEYS) {
      const mentions = files.filter((file) => (
        // This file is allowed to name them; it is where they are invented.
        !file.endsWith('settingsSurfaceMenu.test.ts') && fs.readFileSync(file, 'utf8').includes(key)
      ));
      // jest's expect takes no message, so the key travels in the VALUE.
      expect([key, mentions]).toEqual([key, []]);
    }
    // ...and they are genuinely driven: each appears in a built catalogue.
    const core = navigatedCatalogue('governable', 'core').map((s) => s.key);
    const plugin = navigatedCatalogue('governable', 'plugin').map((s) => s.key);
    for (const key of UNNAMEABLE_KEYS) {
      expect([key, [...core, ...plugin].includes(key)]).toEqual([key, true]);
    }
  });

  for (const governance of GOVERNANCES) {
    for (const origin of (['core', 'plugin'] as const)) {
    for (const level of LEVELS) {
      it(`${governance} ${origin} at ${level}: every navigated surface matches the read-family verdict, for every authentication kind`, async () => {
        const catalogue = navigatedCatalogue(governance, origin);
        const disagreements: string[] = [];
        let measuredAdmitted = 0;
        let measuredRefused = 0;

        for (const session of NON_ROOT) {
          for (const s of catalogue) {
            db.script = [];
            serveCatalogue(level, catalogue);
            const entry = await menuEntry(s.key, session);
            // The menu ANSWERS about every menu-bearing CORE surface, whatever
            // it answers — a core surface silently dropped is one whose
            // visibility nothing states. A concealed PLUGIN row is deliberately
            // OMITTED (round-1 review P3), and absence is then the answer
            // `not visible`.
            if (s.origin === 'core') expect(entry).toBeTruthy();
            const shown = entry ? entry.visible : false;

            db.script = [];
            serveCatalogue(level, catalogue);
            const { req, path: requestPath } = readRequest(s, session);
            const admitted = await evaluateSurfaceStage(req, response() as any, requestPath, ROOT_SCOPE);
            if (admitted) measuredAdmitted += 1; else measuredRefused += 1;

            const expected = (governance === 'governable')
              // Measured, across the seam.
              ? admitted
              // The arm is not consulted for these; the ratified in-handler
              // gate (always-self) or the root ceiling (locked) decides, and
              // `always-self` is a LOGIN-SESSION answer (round-1 review P2)
              // because that in-handler arm refuses a bearer outright —
              // anchored on the real `requireSessionViewer` below.
              // `always-self` is decided by the surface's own in-handler gate,
              // and that gate refuses a bearer AND a caller with no resolved
              // principal (`requireSessionViewer`, both clauses). The oracle
              // states the whole of it — round-3 review C1's null domain.
              : (governance === 'always-self'
                && isLoginSessionKind(session.authMethod)
                && session.principalId !== null);

            if (governance !== 'governable') expect(admitted).toBe(false);
            if (shown !== expected) {
              disagreements.push(`${s.key} auth=${session.authMethod} governance=${governance} level=${level}: menu=${shown} expected=${expected}`);
            }
          }
        }

        expect(disagreements).toEqual([]);
        // The drill must exercise the stage in both directions somewhere, or
        // "the menu agrees" is agreement with a constant.
        expect(measuredAdmitted + measuredRefused).toBeGreaterThan(0);
        if (governance === 'governable' && level !== 'none') expect(measuredAdmitted).toBeGreaterThan(0);
        expect(measuredRefused).toBeGreaterThan(0);
      });
    }
    }
  }

  it('a surface with no menu_path is answered about by nobody, at every governance', async () => {
    for (const governance of GOVERNANCES) {
      const catalogue = [
        ...navigatedCatalogue(governance),
        surface({ id: ID(9), key: 'settings.unnavigated', governance, menuPath: null,
          readFamilies: ['GET /drill/unnavigated'], writeFamilies: ['POST /drill/unnavigated'] }),
      ];
      db.script = [];
      serveCatalogue('configure', catalogue);
      const entries = await accessSurfaceService.settingsSurfaces(LOGIN);
      expect(entries.map((entry) => entry.key)).not.toContain('settings.unnavigated');
    }
  });

  it('a PLUGIN-origin menu surface keeps the arm\'s deliberate exception to I6', async () => {
    // The one shape the navigation cannot supply: plugin surfaces are not in
    // the frontend's entry list, and the arm treats them differently on
    // purpose (there it can only NARROW). Driven for every session kind.
    const catalogue = navigatedCatalogue('governable', 'plugin');
    for (const session of EVERY_SESSION.filter((candidate) => !candidate.rootAuthorized)) {
      for (const s of catalogue) {
        db.script = [];
        serveCatalogue('use', catalogue);
        const entry = await menuEntry(s.key, session);
        const shown = entry ? entry.visible : false;

        db.script = [];
        serveCatalogue('use', catalogue);
        const { req, path: requestPath } = readRequest(s, session);
        const admitted = await evaluateSurfaceStage(req, response() as any, requestPath, ROOT_SCOPE);
        expect([s.key, session.authMethod, shown]).toEqual([s.key, session.authMethod, admitted]);
        // A concealed plugin row is OMITTED (round-1 review P3), so absence is
        // the answer here and `entry` being undefined must mean refused.
        if (!entry) expect(admitted).toBe(false);
      }
    }
  });

  it('the drill is not vacuous: at least one surface is admitted and at least one refused', async () => {
    const catalogue = navigatedCatalogue('governable');
    const admitted: boolean[] = [];
    for (const s of catalogue) {
      db.script = [];
      serveCatalogue('use', catalogue);
      const { req, path: requestPath } = readRequest(s, LOGIN);
      admitted.push(await evaluateSurfaceStage(req, response() as any, requestPath, ROOT_SCOPE));
    }
    expect(admitted).toContain(true);   // Appearance and Preferences at `use`
    expect(admitted).toContain(false);  // Access grants, the authority-mutation closure
  });
});

// ── ROUND-2 REVIEW P2: WHAT ROOT DOES, AND DOES NOT, BUY ───────────────────

/**
 * The root short-circuit ran FIRST, so a `rootAuthorized` machine bearer was
 * handed every registered row in full — `settings.access-manager` included —
 * while `requireSessionViewer` refuses a bearer BEFORE it considers root at
 * all. The menu said visible where the surface refuses: round-1 P2's defect,
 * entered by the door round-1 P2 did not close.
 *
 * THE INVARIANT, BY NAME: **I6, the authentication-kind clause** — for a core
 * surface the arm is consulted only for an authenticated login session
 * presenting no bearer credential, and a bearer-authenticated actor's
 * authority rows are IGNORED rather than merely insufficient. Root satisfying
 * the ROUTE STAGE (design §3.2 I1) is not a statement about a surface's own
 * in-handler gate, and on the menu-bearing core surfaces that gate is a
 * login-session gate. So the short-circuit is sound exactly under I6.
 *
 * NEITHER CASE BELOW RESTATES THE NEW CLAUSE. The first anchors the menu on
 * the REAL gate — `requireSessionViewer`, the function `routes/warrants.ts`
 * and `routes/approvals.ts` share — and the second is a differential: root must
 * change NOTHING about a bearer's menu, which is a property the reordered code
 * has and the original did not, stated without naming either.
 */
describe('root is not a thing a bearer credential can hold its way into', () => {
  /** A bearer holding root. Not issuable today (AZ-18); constructed anyway. */
  const ROOT_BEARER = { principalId: PRINCIPAL, authMethod: 'principal_api_key', rootAuthorized: true };
  const ROOT_SESSION = { principalId: PRINCIPAL, authMethod: 'session', rootAuthorized: true };

  /** The REAL in-handler gate, asked about the same caller. */
  async function realGateAdmits(session: { authMethod: string; rootAuthorized: boolean }): Promise<boolean> {
    const res = response();
    const viewer = await requireSessionViewer(
      {
        method: 'GET', path: '/warrants', baseUrl: '',
        principal: { id: PRINCIPAL, role: 'user' },
        authMethod: session.authMethod,
        scopes: session.rootAuthorized ? ['root'] : [],
        userId: 'someone',
      } as any,
      res as any,
      'warrants.list',
    );
    return viewer !== null;
  }

  it('the gate this menu speaks for refuses a root bearer and admits a root session', async () => {
    // The anchor. Without it, "not visible for a root bearer" is this file
    // agreeing with the clause it is testing; with it, the menu is measured
    // against what the surface's own gate does to that caller.
    expect(await realGateAdmits(ROOT_BEARER)).toBe(false);
    expect(await realGateAdmits(ROOT_SESSION)).toBe(true);
  });

  it('a bearer holding root is refused the always-self entry the gate refuses it', async () => {
    const catalogue = navigatedCatalogue('always-self');
    db.script = [];
    serveCatalogue('configure', catalogue);
    const entries = await accessSurfaceService.settingsSurfaces(ROOT_BEARER);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry).toEqual({ key: entry.key, visible: false });
    }
    // ...and the same session at the same catalogue IS admitted by the menu
    // when it is a login session, so the refusal is about the kind and not
    // about the fixture.
    db.script = [];
    serveCatalogue('configure', catalogue);
    const asSession = await accessSurfaceService.settingsSurfaces(ROOT_SESSION);
    expect(asSession.every((entry) => entry.visible)).toBe(true);
  });

  it('root changes NOTHING about a machine caller\'s menu, at every governance and level', async () => {
    // The differential. It reddens the moment `rootAuthorized` is consulted
    // before the authentication kind, for every non-login kind at once, and it
    // never mentions where in the function the test belongs.
    const differences: string[] = [];
    for (const governance of (['governable', 'always-self', 'locked'] as SurfaceGovernance[])) {
      for (const level of (['none', 'use', 'configure'] as AccessLevel[])) {
        for (const authMethod of EVERY_AUTH_METHOD.filter((method) => !isLoginSessionKind(method))) {
          const catalogue = navigatedCatalogue(governance);
          db.script = [];
          serveCatalogue(level, catalogue);
          const withRoot = await accessSurfaceService.settingsSurfaces(
            { principalId: PRINCIPAL, authMethod, rootAuthorized: true },
          );
          db.script = [];
          serveCatalogue(level, catalogue);
          const without = await accessSurfaceService.settingsSurfaces(
            { principalId: PRINCIPAL, authMethod, rootAuthorized: false },
          );
          if (JSON.stringify(withRoot) !== JSON.stringify(without)) {
            differences.push(`${authMethod} ${governance} ${level}: ${JSON.stringify(withRoot)} vs ${JSON.stringify(without)}`);
          }
        }
      }
    }
    expect(differences).toEqual([]);
  });

  it('...and root DOES change a login session\'s menu, or the differential is trivial', async () => {
    const catalogue = navigatedCatalogue('locked');
    db.script = [];
    serveCatalogue('configure', catalogue);
    const asRoot = await accessSurfaceService.settingsSurfaces(ROOT_SESSION);
    db.script = [];
    serveCatalogue('configure', catalogue);
    const asPlain = await accessSurfaceService.settingsSurfaces(LOGIN);
    expect(JSON.stringify(asRoot)).not.toBe(JSON.stringify(asPlain));
    expect(asRoot.every((entry) => entry.visible)).toBe(true);
    expect(asPlain.every((entry) => entry.visible)).toBe(false);
  });
});

describe('the stage keeps the refusal shapes the design ratified', () => {
  const cases: Array<[string, AccessLevel, 'read' | 'write', number]> = [
    ['a read family at none is CONCEALED, not refused', 'none', 'read', 404],
    ['a write family at use names the surface', 'use', 'write', 403],
    ['a write family at none is concealed with the read', 'none', 'write', 404],
  ];

  it.each(cases)('%s', async (_name, level, family, expected) => {
    serveCatalogue(level);
    const s = CATALOGUE[0];
    const [method, path] = (family === 'read' ? s.readFamilies[0] : s.writeFamilies[0]).split(' ');
    const req = {
      method, path, baseUrl: '',
      principal: { id: PRINCIPAL, role: 'user' }, authMethod: 'session', scopes: [], userId: 'someone',
    } as any;
    const res = response();
    expect(await evaluateSurfaceStage(req, res as any, path, ROOT_SCOPE)).toBe(false);
    expect(res.statusCode).toBe(expected);
  });

  it('a path on NO declared family is refused unchanged, with the ratified 403', async () => {
    serveCatalogue('configure');
    const req = {
      method: 'GET', path: '/appearance/asset-history/logo', baseUrl: '',
      principal: { id: PRINCIPAL, role: 'user' }, authMethod: 'session', scopes: [], userId: 'someone',
    } as any;
    const res = response();
    expect(await evaluateSurfaceStage(req, res as any, '/appearance/asset-history/logo', ROOT_SCOPE)).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('a scope-gated family never reaches the arm at all (I1, annex D16)', async () => {
    serveCatalogue('configure');
    const req = {
      method: 'GET', path: '/tasks', baseUrl: '',
      principal: { id: PRINCIPAL, role: 'user' }, authMethod: 'session', scopes: [], userId: 'someone',
    } as any;
    const res = response();
    expect(await evaluateSurfaceStage(req, res as any, '/tasks', 'tasks:admin' as any)).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(db.queries.some((q) => q.text.includes('FROM access_surfaces'))).toBe(false);
  });
});

describe('a governance value the switch does not know is a refusal, never a fallthrough', () => {
  it('answers an unknown governance invisible below root', async () => {
    const hostile = surface({
      id: ID(9),
      key: 'settings.hostile',
      label: 'Hostile',
      governance: 'unheard-of' as SurfaceGovernance,
      menuPath: '/settings/hostile',
    });
    serveCatalogue('configure', [hostile]);
    expect(await menuEntry('settings.hostile', LOGIN)).toEqual({ key: 'settings.hostile', visible: false });
  });

  it('and the arm refuses it with NOT_GOVERNABLE rather than computing a level', async () => {
    const hostile = surface({ governance: 'unheard-of' as SurfaceGovernance });
    serveCatalogue('configure', [hostile]);
    expect(await accessSurfaceService.armDecision(LOGIN, hostile, 'read')).toEqual({
      admitted: false, level: 'none', refusal: 'NOT_GOVERNABLE',
    });
  });
});
