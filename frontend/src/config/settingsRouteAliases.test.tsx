// @vitest-environment jsdom
/**
 * THE REDIRECT MAP — one drill per published path this card moved.
 *
 * Contract `8dbc0b81`, "Compatibility and deep-link contract": a bookmark, a
 * notification link and a pasted approval deep link keep working, "without
 * loops or lost query state".
 *
 * THE DEFECT THIS REPLACES was not a missing alias. `/appearance` and
 * `/principals` were already aliased — with a bare, STRING-TARGET navigation,
 * which drops `?approval=…` and `#section` on the floor. An approval deep link
 * mailed to a person therefore arrived as a bare page with the approval id
 * gone, and nothing failed: the redirect worked, the state did not survive it.
 * So the loop assertion alone would have passed on the broken shape, and every
 * case below asserts the QUERY AND THE FRAGMENT as well as the path.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SettingsRouteAlias } from '../pages/SettingsPage';
import { SETTINGS_ROUTE_ALIASES, settingsAliasTarget } from './settingsRouteAliases';
import { settingsNavEntries } from './settingsNavigation';

vi.mock('../hooks/usePrincipals', () => ({
  useMyPrincipal: () => ({ me: { id: 'p1', role: 'user' }, scopes: ['root'], settingsSurfaces: null, loading: false }),
}));

afterEach(cleanup);

/** Renders the alias table and prints wherever the router lands. */
function Landing() {
  const location = useLocation();
  return <div data-testid="landed">{`${location.pathname}${location.search}${location.hash}`}</div>;
}

function followFrom(entry: string) {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        {SETTINGS_ROUTE_ALIASES.map((alias) => (
          <Route key={alias.from} path={alias.from} element={<SettingsRouteAlias alias={alias} />} />
        ))}
        {settingsNavEntries.map((navEntry) => (
          <Route key={navEntry.id} path={navEntry.path} element={<Landing />} />
        ))}
        <Route path="*" element={<div data-testid="landed">NO ROUTE</div>} />
      </Routes>
    </MemoryRouter>,
  );
  return screen.getByTestId('landed').textContent;
}

describe('every moved path still resolves — one case per alias', () => {
  // Generated from the map, so an alias added without a drill is impossible
  // and an alias whose drill was deleted fails as a missing case.
  test.each(SETTINGS_ROUTE_ALIASES.map((alias) => [alias.from, alias.to] as const))(
    '%s lands on %s',
    (from, to) => {
      expect(followFrom(from)).toBe(to);
    },
  );

  test.each(SETTINGS_ROUTE_ALIASES.map((alias) => [alias.from, alias.to] as const))(
    '%s carries its query string and fragment across',
    (from, to) => {
      expect(followFrom(`${from}?approval=8f1c2d3e&tab=pending#decision`))
        .toBe(`${to}?approval=8f1c2d3e&tab=pending#decision`);
    },
  );

  test('the Access-manager approval deep link is the one this protects', () => {
    // /settings/access-manager was never moved and is not an alias, so the
    // link the notification mails is untouched by this card. What WAS at risk
    // is a person landing through a moved path with the same query on it.
    expect(followFrom('/preferences?approval=8f1c2d3e'))
      .toBe('/settings/preferences?approval=8f1c2d3e');
  });
});

describe('the map cannot loop, and every target is real', () => {
  test('no alias target is another alias source', () => {
    const sources = new Set(SETTINGS_ROUTE_ALIASES.map((alias) => alias.from));
    for (const alias of SETTINGS_ROUTE_ALIASES) {
      expect(sources.has(alias.to)).toBe(false);
    }
  });

  test('no alias points at itself', () => {
    for (const alias of SETTINGS_ROUTE_ALIASES) expect(alias.to).not.toBe(alias.from);
  });

  test('every target is a navigation entry the shell actually renders', () => {
    const paths = new Set(settingsNavEntries.map((entry) => entry.path));
    for (const alias of SETTINGS_ROUTE_ALIASES) expect(paths.has(alias.to)).toBe(true);
  });

  test('no two aliases claim the same source', () => {
    const sources = SETTINGS_ROUTE_ALIASES.map((alias) => alias.from);
    expect(new Set(sources).size).toBe(sources.length);
  });
});

describe('settingsAliasTarget composes the target', () => {
  test('an empty query and fragment add nothing', () => {
    expect(settingsAliasTarget(SETTINGS_ROUTE_ALIASES[0], {})).toBe(SETTINGS_ROUTE_ALIASES[0].to);
    expect(settingsAliasTarget(SETTINGS_ROUTE_ALIASES[0], { search: '', hash: '' }))
      .toBe(SETTINGS_ROUTE_ALIASES[0].to);
  });

  test('the query precedes the fragment, as a URL requires', () => {
    expect(settingsAliasTarget({ from: '/a', to: '/b', note: '' }, { search: '?x=1', hash: '#y' }))
      .toBe('/b?x=1#y');
  });
});
