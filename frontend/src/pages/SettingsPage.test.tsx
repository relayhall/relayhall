// @vitest-environment jsdom
/**
 * The consolidated Settings shell (card `d0f030a9`, contract `8dbc0b81`).
 *
 * WHAT THESE PIN.
 *
 *  1. ONE shell, three groups, and the entries in a stable order.
 *  2. THE VISIBILITY IS THE SERVER'S. Every case below sets
 *     `settingsSurfaces` — the answer `AccessSurfaceService.armDecision`
 *     computed — and asserts the shell rendered exactly it. The shell holding
 *     its own predicate is the defect: before this card it gated on
 *     `scopes.includes('root')`, so an Account placed at Administrative `use`
 *     (which the arm admits on Appearance's read families) was shown nothing.
 *  3. NOT RENDERED, NOT DISABLED. A hidden entry is absent from the accessible
 *     tree entirely — no link, no disabled control, no label anywhere in the
 *     navigation. A disabled control still discloses that the deployment has
 *     the surface, which is what the arm's 404 concealment prevents at the
 *     HTTP seam and what this asserts at the render seam.
 *  4. THE FALLBACK IS THE OLD BEHAVIOUR, EXACTLY. When the board answers no
 *     `settingsSurfaces` at all, every entry resolves to what it was reachable
 *     by before SETGOV — which is narrower than the arm on every entry, so a
 *     board that cannot read its catalogue degrades closed.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SettingsIndexRedirect, SettingsPage } from './SettingsPage';
import { settingsNavEntries } from '../config/settingsNavigation';
import type { SettingsSurfaceVisibility } from '../config/settingsNavigation';
import { settingsChildRoutes } from '../config/settingsRoutes';

const useMyPrincipal = vi.fn();
vi.mock('../hooks/usePrincipals', () => ({ useMyPrincipal: () => useMyPrincipal() }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const ROOT = { id: 'p-root', role: 'orchestrator' };
const ACCOUNT = { id: 'p1', role: 'user' };

/** Every surface key the navigation names, at one visibility. */
function allSurfaces(visible: boolean): SettingsSurfaceVisibility[] {
  return settingsNavEntries
    .map((entry) => entry.surfaceKey)
    .filter((key): key is string => key !== null)
    .map((key) => ({ key, visible }));
}

function withVisibility(base: SettingsSurfaceVisibility[], overrides: Record<string, boolean>) {
  return base.map((surface) => (
    surface.key in overrides ? { ...surface, visible: overrides[surface.key] } : surface
  ));
}

function session(me: unknown, scopes: string[] | null, settingsSurfaces: SettingsSurfaceVisibility[] | null) {
  useMyPrincipal.mockReturnValue({ me, scopes, settingsSurfaces, loading: false });
}

/**
 * The shell, mounted over THE PRODUCTION ROUTE GENERATOR.
 *
 * ROUND-2 REVIEW P1. This harness used to build its own `<Route>` per entry,
 * which meant it measured a route table nothing shipped: the guard could be
 * absent from the real one and every case here would still pass. It now calls
 * `settingsChildRoutes` — the same function `App.tsx` calls — and supplies
 * only the page element, which is the only thing App.tsx supplies either.
 */
function renderShell(initial = '/settings/access') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />}>
          <Route index element={<SettingsIndexRedirect />} />
          {settingsChildRoutes((entry) => <div>{entry.label} content</div>)}
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

/** The settings navigation landmark, by its accessible name. */
function nav() {
  return screen.getByRole('navigation', { name: 'Settings sections' });
}

/** Is this label ANYWHERE in the navigation — as a link, a control, or text? */
function navMentions(label: string): boolean {
  return within(nav()).queryAllByText(label).length > 0;
}

describe('the Settings shell renders the information architecture', () => {
  test('root sees all three groups, in order, with every entry', () => {
    session(ROOT, ['root'], allSurfaces(true));
    renderShell();

    const headings = within(nav()).getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Preferences', 'Access administration', 'Deployment']);

    for (const entry of settingsNavEntries) {
      expect(within(nav()).getByRole('link', { name: new RegExp(entry.label) })).toHaveAttribute(
        'href',
        entry.path,
      );
    }
  });

  test('the active entry carries aria-current="page", not only a class', () => {
    session(ROOT, ['root'], allSurfaces(true));
    renderShell('/settings/access');

    const active = within(nav()).getByRole('link', { name: /Access grants/ });
    expect(active).toHaveAttribute('aria-current', 'page');
    expect(within(nav()).getByRole('link', { name: /Appearance/ })).not.toHaveAttribute('aria-current');
  });

  test('every rendered entry has a routed page behind it', () => {
    session(ROOT, ['root'], allSurfaces(true));
    renderShell('/settings/appearance');
    expect(screen.getByText('Appearance content')).toBeInTheDocument();
  });
});

describe('the SETGOV visibility predicate decides each entry, and the server owns it', () => {
  test('an Account the arm admits on Appearance SEES Appearance — the case the root gate got wrong', () => {
    // The arm's answer for a non-root Account in a Group placed at
    // Administrative `use`: it may READ the Appearance families, so the entry
    // is its to see. `scopes` holds no `root` — under the previous shell this
    // Account was shown the Access manager and nothing else.
    session(ACCOUNT, ['tasks:read'], withVisibility(allSurfaces(false), {
      'settings.preferences': true,
      'settings.access-manager': true,
      'settings.appearance': true,
    }));
    renderShell('/settings/appearance');

    expect(within(nav()).getByRole('link', { name: /Appearance/ })).toBeInTheDocument();
    expect(within(nav()).getByRole('heading', { level: 2, name: 'Deployment' })).toBeInTheDocument();
  });

  test('a surface the arm conceals is NOT RENDERED — not a disabled control, not a label', () => {
    session(ACCOUNT, ['tasks:read'], withVisibility(allSurfaces(false), {
      'settings.preferences': true,
      'settings.access-manager': true,
    }));
    renderShell('/settings/access-manager');

    // Present.
    expect(within(nav()).getByRole('link', { name: /Access manager/ })).toBeInTheDocument();
    expect(within(nav()).getByRole('link', { name: /Preferences/ })).toBeInTheDocument();

    // Absent — and absent in every form, which is the property. A `queryByRole`
    // on `link` alone would pass on a disabled <button> carrying the same word.
    for (const label of ['Appearance', 'Access grants', 'Identities']) {
      expect(navMentions(label)).toBe(false);
    }
    // The whole Deployment group goes with its only entry.
    expect(within(nav()).queryByRole('heading', { level: 2, name: 'Deployment' })).not.toBeInTheDocument();
  });

  test('the shell does not second-guess the server: an entry marked visible is rendered', () => {
    // The server is the authority. If it says an authority-mutation surface is
    // visible — which for a non-root session it never does, and
    // `settingsSurfaceMenu.test.ts` is what holds that — the shell renders it
    // rather than applying a second, divergent rule of its own.
    session(ACCOUNT, ['tasks:read'], withVisibility(allSurfaces(false), {
      'settings.preferences': true,
      'settings.access-grants': true,
    }));
    renderShell('/settings/access');
    expect(within(nav()).getByRole('link', { name: /Access grants/ })).toBeInTheDocument();
  });

  test('My connections has no catalogue surface and belongs to every authenticated Account', () => {
    session(ACCOUNT, ['tasks:read'], allSurfaces(false));
    renderShell('/settings/connections');
    expect(within(nav()).getByRole('link', { name: /My connections/ })).toBeInTheDocument();
  });
});

describe('a board that answers no settingsSurfaces degrades to the pre-SETGOV gate', () => {
  test('a non-root Account gets exactly the self-scope set it got before this card', () => {
    session(ACCOUNT, ['tasks:read'], null);
    renderShell('/settings/access-manager');

    expect(within(nav()).getByRole('link', { name: /Access manager/ })).toBeInTheDocument();
    expect(within(nav()).getByRole('link', { name: /My connections/ })).toBeInTheDocument();
    expect(within(nav()).getByRole('link', { name: /Preferences/ })).toBeInTheDocument();
    for (const label of ['Appearance', 'Access grants', 'Identities']) {
      expect(navMentions(label)).toBe(false);
    }
  });

  test('root still gets everything', () => {
    session(ROOT, ['root'], null);
    renderShell();
    for (const entry of settingsNavEntries) {
      expect(within(nav()).getByRole('link', { name: new RegExp(entry.label) })).toBeInTheDocument();
    }
  });

  test('a surface key the deployment does not register falls back too, and does not vanish', () => {
    // An answer that simply omits `settings.preferences`: not "invisible",
    // "unregistered". Preferences was reachable by every Account before this
    // card, so it stays reachable.
    session(ACCOUNT, ['tasks:read'], [{ key: 'settings.appearance', visible: false }]);
    renderShell('/settings/preferences');
    expect(within(nav()).getByRole('link', { name: /Preferences/ })).toBeInTheDocument();
    expect(navMentions('Appearance')).toBe(false);
  });
});

describe('a concealed child is REFUSED, not rendered behind a hidden link', () => {
  // ROUND-1 REVIEW P1. The navigation was filtered and the outlet was not, so a
  // direct visit to a concealed child still MOUNTED that page. The old suite
  // asserted only that the LABEL was absent, which the defect satisfied.
  test.each([
    ['/settings/access', 'Access grants'],
    ['/settings/principals', 'Identities'],
    ['/settings/appearance', 'Appearance'],
  ])('a direct visit to %s renders a refusal, never %s content', (path, label) => {
    session(ACCOUNT, ['tasks:read'], withVisibility(allSurfaces(false), {
      'settings.preferences': true,
      'settings.access-manager': true,
    }));
    renderShell(path);
    expect(screen.getByRole('alert')).toHaveTextContent('no access to that settings page');
    expect(screen.queryByText(`${label} content`)).not.toBeInTheDocument();
  });

  test('the refusal names no surface — it cannot be used to probe for one', () => {
    session(ACCOUNT, ['tasks:read'], withVisibility(allSurfaces(false), { 'settings.preferences': true }));
    renderShell('/settings/access');
    const alert = screen.getByRole('alert');
    for (const entry of settingsNavEntries) {
      expect(alert.textContent).not.toContain(entry.label);
    }
  });

  test('the refusal is the SAME sentence whichever concealed child was asked for', () => {
    const texts: (string | null)[] = [];
    for (const path of ['/settings/access', '/settings/principals', '/settings/appearance']) {
      session(ACCOUNT, ['tasks:read'], withVisibility(allSurfaces(false), { 'settings.preferences': true }));
      renderShell(path);
      texts.push(screen.getByRole('alert').textContent);
      cleanup();
    }
    expect(new Set(texts).size).toBe(1);
  });

  test('a child the session CAN see still renders, so the guard is not a blanket', () => {
    session(ACCOUNT, ['tasks:read'], withVisibility(allSurfaces(false), {
      'settings.preferences': true,
      'settings.access-manager': true,
    }));
    renderShell('/settings/access-manager');
    expect(screen.getByText('Access manager content')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('root reaches every child', () => {
    for (const entry of settingsNavEntries) {
      session(ROOT, ['root'], allSurfaces(true));
      renderShell(entry.path);
      expect(screen.getByText(`${entry.label} content`)).toBeInTheDocument();
      cleanup();
    }
  });
});

/**
 * EVERY SPELLING THE ROUTER ACCEPTS — the four-cell probe, committed.
 *
 * ROUND-2 REVIEW P1. The first repair decided concealment by comparing
 * `location.pathname` to the entry's path with `===`, and React Router accepts
 * spellings that equal no entry path: a trailing slash and any casing are its
 * own documented defaults. `/settings/access/` and `/settings/ACCESS` both
 * routed to the `access` child and neither was concealed. The probe that found
 * it was run by hand against the installed router and reported in prose; prose
 * does not fail a build.
 *
 * BOTH DIRECTIONS ARE ASSERTED, and the second is what makes the first mean
 * anything. A spelling the router REJECTED would render no page and no
 * refusal, and a one-directional test would read that as a pass — the whole
 * suite could be satisfied by a router that matched nothing. So each spelling
 * is first shown to REACH the page when the entry is visible, and only then
 * shown to be REFUSED when it is concealed.
 *
 * It runs over every entry rather than over `access`: the defect was a class —
 * "the shell decided a routing question with something that is not the router"
 * — and a case pinned to one path is a case about that path.
 */
const SPELLINGS: Array<[string, (path: string) => string]> = [
  ['canonical', (path) => path],
  ['a trailing slash', (path) => `${path}/`],
  ['upper case', (path) => `/settings/${path.slice('/settings/'.length).toUpperCase()}`],
  ['a capitalised segment', (path) => {
    const tail = path.slice('/settings/'.length);
    return `/settings/${tail.charAt(0).toUpperCase()}${tail.slice(1)}`;
  }],
];

describe('concealment is decided by the matcher the router used, whatever the spelling', () => {
  const CASES: Array<[string, string, string, string]> = [];
  for (const entry of settingsNavEntries) {
    for (const [spelling, spell] of SPELLINGS) {
      CASES.push([entry.label, spelling, spell(entry.path), entry.surfaceKey ?? '']);
    }
  }

  test.each(CASES)(
    '%s written with %s (%s) REACHES the page when the entry is visible',
    (label, _spelling, url) => {
      session(ROOT, ['root'], allSurfaces(true));
      renderShell(url);
      expect(screen.getByText(`${label} content`)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    },
  );

  test.each(CASES.filter(([, , , surfaceKey]) => surfaceKey !== ''))(
    '%s written with %s (%s) is REFUSED when the entry is concealed',
    (label, _spelling, url, surfaceKey) => {
      // EXACTLY ONE entry concealed, and it is the one this URL names. A
      // fixture that concealed everything would land on the shell's OTHER
      // refusal ("no settings to administer") and never reach the guard at
      // all, so this shape is what makes the assertion about the guard.
      session(ACCOUNT, ['tasks:read'], withVisibility(allSurfaces(true), { [surfaceKey]: false }));
      renderShell(url);
      expect(screen.getByRole('alert')).toHaveTextContent('no access to that settings page');
      expect(screen.queryByText(`${label} content`)).not.toBeInTheDocument();
    },
  );

  test('the probe is not vacuous: the alternate spellings are genuinely different strings', () => {
    const entry = settingsNavEntries[0];
    const spelled = SPELLINGS.map(([, spell]) => spell(entry.path));
    expect(new Set(spelled).size).toBe(SPELLINGS.length);
    for (const url of spelled.slice(1)) expect(url).not.toBe(entry.path);
  });
});

describe('the /settings index and the refusal', () => {
  test('root lands on the first entry it can see', () => {
    session(ROOT, ['root'], allSurfaces(true));
    renderShell('/settings');
    expect(screen.getByText('Preferences content')).toBeInTheDocument();
  });

  test('the landing is COMPUTED from what is visible, not a hardcoded page', () => {
    session(ACCOUNT, ['tasks:read'], withVisibility(allSurfaces(false), { 'settings.access-manager': true }));
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <Routes>
          <Route path="/settings" element={<SettingsPage />}>
            <Route index element={<SettingsIndexRedirect />} />
            <Route path="connections" element={<div>My connections content</div>} />
            <Route path="access-manager" element={<div>Access manager content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    // My connections is `self` and comes first in the Preferences group once
    // Preferences itself is concealed; the landing follows the rendered order
    // rather than a hardcoded page.
    expect(screen.getByText('My connections content')).toBeInTheDocument();
  });

  test('an unresolved identity gets the refusal and no navigation at all', () => {
    session(null, null, null);
    renderShell();
    expect(screen.getByRole('alert')).toHaveTextContent('no settings to administer');
    expect(screen.queryByRole('navigation', { name: 'Settings sections' })).not.toBeInTheDocument();
  });

  test('the refusal names no surface', () => {
    session(null, null, null);
    renderShell();
    const alert = screen.getByRole('alert');
    for (const entry of settingsNavEntries) {
      expect(alert.textContent).not.toContain(entry.label);
    }
  });
});


describe('failed or pending identity refresh does not expose a stale audience', () => {
  test.each(['failed', 'loading'])('%s wins over an old privileged answer before child mount', state => {
    useMyPrincipal.mockReturnValue({ me: ROOT, scopes: ['root'], settingsSurfaces: allSurfaces(true), loading: state === 'loading', failed: state === 'failed', reload: vi.fn() });
    renderShell('/settings/access');
    expect(screen.queryByRole('navigation', { name: 'Settings sections' })).not.toBeInTheDocument();
    expect(screen.queryByText('Access grants content')).not.toBeInTheDocument();
    if (state === 'failed') expect(screen.getByRole('alert')).toHaveTextContent('Settings could not be loaded');
    else expect(screen.getByRole('status')).toHaveTextContent('Loading settings');
  });
});
