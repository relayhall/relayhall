/**
 * THE SETTINGS ROUTE CENSUS — nothing is reachable that the navigation does
 * not name, and nothing is named that is not reachable.
 *
 * Card `d0f030a9`. A consolidation whose shell and whose router are two
 * hand-kept lists is a consolidation that comes apart one page at a time: a
 * route stays mounted with no way in (a surface only a bookmark reaches), or a
 * navigation entry outlives its page (a link to a 404). Neither shows up in a
 * render test, because a render test is written from the same list.
 *
 * THE ANCHORS ARE OUTSIDE THE CONFIG. This file reads `App.tsx` as SOURCE and
 * `109_access_surfaces.sql` as SOURCE, and compares both against
 * `config/settingsNavigation`. Editing the navigation to agree with itself
 * cannot satisfy either comparison — the router and the ratified Access-surface
 * catalogue are written by different hands, in different languages, in
 * different packages.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, test } from 'vitest';
import { settingsNavEntries, settingsNavGroups, settingsChildRoutePath } from './settingsNavigation';
import { SETTINGS_ROUTE_ALIASES } from './settingsRouteAliases';
import { SettingsEntryGuard, settingsChildRoutes } from './settingsRoutes';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_TSX = path.resolve(HERE, '..', 'App.tsx');
const CATALOGUE_SQL = path.resolve(HERE, '..', '..', '..', 'backend', 'src', 'migrations', '109_access_surfaces.sql');

const appSource = fs.readFileSync(APP_TSX, 'utf8');

/** Source with block and line comments removed — prose is not implementation. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The body of `<Route path="/settings" …>` in App.tsx, as source. */
function settingsShellBody(): string {
  const open = '<Route path="/settings" element={<SettingsPage />}>';
  const start = appSource.indexOf(open);
  expect(start, 'App.tsx must mount one /settings shell route').toBeGreaterThan(-1);
  const end = appSource.indexOf('\n      </Route>', start);
  expect(end, 'the /settings route must be closed at its own indent').toBeGreaterThan(start);
  return appSource.slice(start + open.length, end);
}

/**
 * THE GENERATED CHILDREN, as the router will see them.
 *
 * ROUND-2 REVIEW P1. This used to be a regex over App.tsx for `<Route path="…"`
 * compared against a second list, and the pair agreeing said nothing about
 * whether the mounted children were GUARDED — which is what the review found
 * they were not. The children are now produced by `settingsChildRoutes`, so
 * this reads the real elements and asks about each one's element, not only its
 * path. A render is still not needed: a `<Route>` is a description.
 */
function generatedChildren(): Array<{ path: string; guardEntryId: string | null; guarded: boolean }> {
  return settingsChildRoutes(() => null).map((route) => {
    const props = route.props as { path?: string; element?: { type?: unknown; props?: { entry?: { id?: string } } } };
    const element = props.element;
    return {
      path: props.path ?? '',
      guarded: Boolean(element) && element!.type === SettingsEntryGuard,
      guardEntryId: element?.props?.entry?.id ?? null,
    };
  });
}

describe('the router mounts the navigation, generated — not a second list of it', () => {
  const children = generatedChildren();

  test('App.tsx mounts the generator and types no child route of its own', () => {
    const body = settingsShellBody();
    expect(body).toContain('{settingsChildRoutes((entry) => SETTINGS_PAGES[entry.id])}');
    // The index route is the only literal `<Route>` left inside the shell. A
    // hand-typed child would be an UNGUARDED child, which is the round-2 P1
    // defect with the guard merely relocated.
    expect(body).toContain('<Route index element={<SettingsIndexRedirect />} />');
    const literalRoutes = [...body.matchAll(/<Route\s+([a-zA-Z]+)/g)].map((m) => m[1]);
    expect(literalRoutes).toEqual(['index']);
  });

  /**
   * ROUND-3 REVIEW RC1, AND THE REGRESS IT NAMES.
   *
   * The case above reads the body BETWEEN the shell route's opener and its
   * closing tag. A SIBLING route — `<Route path="/settings/rogue" …>` written
   * anywhere else in the file — is a settings URL React Router matches as its
   * own branch, reaching neither the shell nor `SettingsEntryGuard`, and the
   * window above cannot see it. The review demonstrated the bypass with
   * `matchRoutes` directly.
   *
   * THE REPAIR IS NOT A WIDER WINDOW. A window is a claim about WHERE a route
   * may be written, and each round has found the next place: round 2 found the
   * spelling the matcher missed, round 3 found the position the census missed.
   * This asks a question with no window in it — every occurrence of the
   * settings prefix in the WHOLE file — so there is no "outside" for the next
   * one to be in.
   */
  test('no route anywhere in App.tsx claims the /settings space except the shell', () => {
    const claims = [...appSource.matchAll(/<Route\s[^>]*?path=(?:"([^"]*)"|\{([^}]*)\})/g)]
      .map((match) => ({ path: match[1] ?? `{${match[2]}}`, at: match.index ?? 0 }));

    // Not vacuous: App.tsx really does mount routes, and one of them is /settings.
    expect(claims.length).toBeGreaterThan(5);

    const settingsClaims = claims.filter((claim) => claim.path === '/settings' || claim.path.startsWith('/settings/'));
    expect(
      settingsClaims.map((claim) => claim.path),
      'exactly one literal route may claim /settings — every child is generated inside it',
    ).toEqual(['/settings']);

    // The generated children mount with RELATIVE paths inside the shell, so a
    // literal absolute `/settings/...` anywhere is by construction a sibling.
    // Say it a second way, in raw text, in case the route regex is ever wrong:
    // the prefix appears once as a route path and otherwise only in strings the
    // navigation and the alias table own.
    const literalPrefixes = [...appSource.matchAll(/path=\{?"(\/settings[^"]*)"/g)].map((m) => m[1]);
    expect(literalPrefixes).toEqual(['/settings']);
  });

  test('the dynamic plugin mount is the one route source the census cannot read', () => {
    // Named rather than left implicit. `pluginRoutes` are supplied at runtime by
    // whatever manifests a deployment installs, so no source read can bound
    // their paths — the review found that `PluginLoader.validateManifest`
    // constrains `api.base_path` and not `ui.routes[].path`, so a manifest can
    // in principle claim a `/settings/...` URL as a sibling of the shell.
    //
    // That is OUT OF THIS CARD'S DELTA and is recorded, not repaired here: the
    // fix belongs in the plugin route namespace, on the loader that validates
    // manifests, and widening this frontend card to police it would put the
    // rule in the second place rather than the owning one. What this case does
    // is make the gap VISIBLE — if the mount ever stops being the only
    // unreadable route source, this fails and someone re-reads the census.
    const dynamicMounts = [...appSource.matchAll(/\{!?\w+ && (\w+)\.map\(/g)].map((m) => m[1]);
    expect(dynamicMounts).toEqual(['pluginRoutes']);
  });

  test('the page map is exhaustive BY TYPE, so a new entry cannot ship without a page', () => {
    // The Record over the id union is the gate: widen it to `string` and a
    // missing page compiles and mounts nothing.
    expect(appSource).toContain('const SETTINGS_PAGES: Record<SettingsNavEntryId, ReactNode> = {');
  });

  test('one generated child per navigation entry, at the entry\'s own path', () => {
    expect(children).toHaveLength(settingsNavEntries.length);
    for (const [index, entry] of settingsNavEntries.entries()) {
      expect(children[index].path).toBe(settingsChildRoutePath(entry));
      expect(`/settings/${children[index].path}`).toBe(entry.path);
    }
  });

  test('EVERY generated child is the concealment guard, for its own entry', () => {
    for (const [index, entry] of settingsNavEntries.entries()) {
      expect(children[index].guarded, `${entry.path} is mounted without SettingsEntryGuard`).toBe(true);
      expect(children[index].guardEntryId).toBe(entry.id);
    }
  });

  test('no duplicate mount, no duplicate entry', () => {
    const paths = children.map((child) => child.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(new Set(settingsNavEntries.map((entry) => entry.path)).size).toBe(settingsNavEntries.length);
  });

  test('the shell has an index route, so /settings itself is never a dead end', () => {
    expect(appSource).toContain('<Route index element={<SettingsIndexRedirect />} />');
  });

  test('nothing in the frontend decides concealment by comparing a pathname', () => {
    // The removed helper by name, and the shape it had. A second matcher
    // beside the router's is the defect class, not one missed spelling.
    //
    // COMMENTS ARE STRIPPED FIRST. Both files EXPLAIN the removed matcher —
    // that is what keeps the next reader from writing it again — and an
    // absence check that cannot tell an explanation from an implementation
    // would push the explanation out of the tree, which is the opposite of
    // what it is for.
    for (const file of ['pages/SettingsPage.tsx', 'config/settingsRoutes.tsx', 'config/settingsNavigation.ts']) {
      const code = withoutComments(fs.readFileSync(path.resolve(HERE, '..', file), 'utf8'));
      expect(code, `${file} still compares a pathname`).not.toContain('location.pathname');
      expect(code, `${file} still calls the removed matcher`).not.toContain('settingsEntryConcealed');
    }
    expect(withoutComments(appSource)).not.toContain('settingsEntryConcealed');
    // ...and the check is not vacuous: the stripper leaves the code it should.
    expect(withoutComments(fs.readFileSync(path.resolve(HERE, 'settingsRoutes.tsx'), 'utf8')))
      .toContain('useOutletContext');
  });
});

describe('the router mounts EVERY alias, generically', () => {
  test('the alias routes are generated from the map rather than typed out', () => {
    // A generated mount cannot omit an entry. A hand-typed list can, and the
    // omission is invisible until somebody follows the dead bookmark.
    expect(appSource).toContain('SETTINGS_ROUTE_ALIASES.map((alias) => (');
    expect(appSource).toContain('path={alias.from}');
    expect(appSource).toContain('element={<SettingsRouteAlias alias={alias} />}');
  });

  test('no alias source is ALSO mounted as a page — that is the redirect loop', () => {
    for (const alias of SETTINGS_ROUTE_ALIASES) {
      expect(
        appSource.includes(`<Route path="${alias.from}" element={<`),
        `${alias.from} is both an alias and a page route`,
      ).toBe(false);
    }
  });

  test('the personal preferences page is mounted inside the shell and nowhere else', () => {
    expect(generatedChildren().map((child) => `/settings/${child.path}`)).toContain('/settings/preferences');
    expect(appSource).not.toContain('<Route path="/preferences" element={<PreferencesPage />} />');
  });
});

describe('the navigation agrees with the ratified Access-surface catalogue', () => {
  const sql = fs.readFileSync(CATALOGUE_SQL, 'utf8');

  /** key -> menu_path, read from the seeded catalogue. `null` where none. */
  function catalogueMenuPaths(): Map<string, string | null> {
    const found = new Map<string, string | null>();
    for (const match of sql.matchAll(/\('(settings\.[\w.-]+)',([\s\S]*?),\s*'core'\)/g)) {
      const menu = match[2].trimEnd().split(',').pop()!.trim();
      found.set(match[1], menu === 'NULL' ? null : menu.replace(/^'|'$/g, ''));
    }
    return found;
  }

  const catalogue = catalogueMenuPaths();

  test('the catalogue parsed — a silent zero-row read would make every case below vacuous', () => {
    expect(catalogue.size).toBeGreaterThanOrEqual(13);
    expect(catalogue.get('settings.appearance')).toBe('/settings/appearance');
    expect(catalogue.get('settings.webhooks')).toBeNull();
  });

  test('every surface key the navigation names is a registered surface', () => {
    for (const entry of settingsNavEntries) {
      if (entry.surfaceKey === null) continue;
      expect(
        catalogue.has(entry.surfaceKey),
        `navigation entry '${entry.id}' names surface '${entry.surfaceKey}', which the catalogue does not register`,
      ).toBe(true);
    }
  });

  test('every catalogued surface with a /settings/ menu entry is in the navigation', () => {
    for (const [key, menuPath] of catalogue) {
      if (menuPath === null || !menuPath.startsWith('/settings/')) continue;
      const entry = settingsNavEntries.find((candidate) => candidate.surfaceKey === key);
      expect(entry, `surface '${key}' declares menu_path '${menuPath}' and no navigation entry claims it`).toBeTruthy();
      expect(entry!.path).toBe(menuPath);
    }
  });

  test('Preferences moved, and its catalogued menu_path is still a working alias', () => {
    // The catalogue records `/preferences` for `settings.preferences`. This
    // card moved the PAGE to `/settings/preferences` and left `/preferences` an
    // alias, so the catalogued path still resolves. It is deliberately not
    // rewritten by this card: the surface's read/write families are the
    // `/preferences` API routes, which did not move, and amending a seeded
    // catalogue row is a migration this frontend card does not own.
    expect(catalogue.get('settings.preferences')).toBe('/preferences');
    const alias = SETTINGS_ROUTE_ALIASES.find((candidate) => candidate.from === '/preferences');
    expect(alias, 'the catalogued menu_path must remain reachable').toBeTruthy();
    expect(alias!.to).toBe('/settings/preferences');
    expect(settingsNavEntries.find((entry) => entry.surfaceKey === 'settings.preferences')!.path)
      .toBe('/settings/preferences');
  });

  test('no navigation entry claims a surface the catalogue gives no menu entry at all', () => {
    for (const entry of settingsNavEntries) {
      if (entry.surfaceKey === null) continue;
      expect(
        catalogue.get(entry.surfaceKey),
        `'${entry.surfaceKey}' has no menu_path, so it is not a navigable surface`,
      ).not.toBeNull();
    }
  });
});

describe('the information architecture is well formed', () => {
  test('every entry sits in a declared group', () => {
    const groups = new Set(settingsNavGroups.map((group) => group.id));
    for (const entry of settingsNavEntries) expect(groups.has(entry.group)).toBe(true);
  });

  test('every declared group has at least one entry', () => {
    for (const group of settingsNavGroups) {
      expect(
        settingsNavEntries.some((entry) => entry.group === group.id),
        `group '${group.id}' has no entries`,
      ).toBe(true);
    }
  });

  test('ids, paths and labels are each unique', () => {
    for (const field of ['id', 'path', 'label'] as const) {
      const values = settingsNavEntries.map((entry) => entry[field]);
      expect(new Set(values).size, `duplicate ${field}`).toBe(values.length);
    }
  });

  test('every entry is under the /settings prefix — the shell owns its own space', () => {
    for (const entry of settingsNavEntries) expect(entry.path.startsWith('/settings/')).toBe(true);
  });
});
