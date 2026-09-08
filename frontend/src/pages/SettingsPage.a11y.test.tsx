// @vitest-environment jsdom
/**
 * axe over the Settings shell, for the audiences the shell actually has.
 *
 * Card `d0f030a9`, contract `8dbc0b81`: "keyboard navigation, focus
 * management, screen-reader labeling … and axe checks pass".
 *
 * HONEST SCOPE, as `a11y.smoke.test.tsx` states it: jsdom has no layout
 * engine, so axe's colour-contrast rule is inapplicable here and is not what
 * this file covers — the per-Theme pairing matrix owns contrast, and this card
 * introduced no new colour pairing. What jsdom IS authoritative about is
 * structure: landmarks and their names, heading order, list semantics, link
 * names, `aria-current`, duplicated ids, ARIA validity. That is what a
 * navigation rewrite can break, and it is what is measured here.
 *
 * THE AUDIENCE MATTERS. The shell renders a DIFFERENT tree per session, so an
 * audit of the root tree alone would leave the tree most people see — and the
 * one where a whole group disappears — unmeasured. Every audience the
 * predicate produces is audited.
 */
import '@testing-library/jest-dom/vitest';
import axe from 'axe-core';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';
import { settingsNavEntries } from '../config/settingsNavigation';
import { settingsChildRoutes } from '../config/settingsRoutes';
import type { SettingsSurfaceVisibility } from '../config/settingsNavigation';

const useMyPrincipal = vi.fn();
vi.mock('../hooks/usePrincipals', () => ({ useMyPrincipal: () => useMyPrincipal() }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

/** needs a layout engine to composite colours; the pairing matrix owns this. */
const RULES_JSDOM_CANNOT_JUDGE = { 'color-contrast': { enabled: false } } as const;

async function auditOf(container: HTMLElement): Promise<axe.Result[]> {
  const results = await axe.run(container, {
    rules: RULES_JSDOM_CANNOT_JUDGE,
    resultTypes: ['violations'],
  });
  return results.violations;
}

function describeViolations(violations: axe.Result[]): string {
  return violations
    .map((v) => `${v.id} (${v.impact}): ${v.help}\n      ${v.nodes.map((n) => n.html).join('\n      ')}`)
    .join('\n');
}

function allSurfaces(visible: boolean): SettingsSurfaceVisibility[] {
  return settingsNavEntries
    .map((entry) => entry.surfaceKey)
    .filter((key): key is string => key !== null)
    .map((key) => ({ key, visible }));
}

function renderShell(at = '/settings/appearance') {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        {/* The production route generator, not a second route table
            (round-2 review P1) — so the accessibility of the REFUSAL is
            measured on the element that actually renders it. */}
        <Route path="/settings" element={<SettingsPage />}>
          {settingsChildRoutes((entry) => (
            <section aria-label={entry.label}><h2>{entry.label}</h2></section>
          ))}
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const AUDIENCES: Array<[string, unknown, string[] | null, SettingsSurfaceVisibility[] | null]> = [
  ['a root administrator, every group rendered', { id: 'r', role: 'orchestrator' }, ['root'], allSurfaces(true)],
  ['an Account at use on Appearance only', { id: 'a', role: 'user' }, ['tasks:read'],
    [{ key: 'settings.preferences', visible: true }, { key: 'settings.appearance', visible: true },
      { key: 'settings.access-manager', visible: false }, { key: 'settings.access-grants', visible: false },
      { key: 'settings.identities', visible: false }]],
  ['an Account with only its self-scope entries', { id: 'a', role: 'user' }, ['tasks:read'], null],
];

describe('axe finds nothing structural in the Settings shell', () => {
  test.each(AUDIENCES)('%s', async (_name, me, scopes, surfaces) => {
    useMyPrincipal.mockReturnValue({ me, scopes, settingsSurfaces: surfaces, loading: false });
    const { container } = renderShell(
      // Land on a page the audience can actually see, so the audit measures a
      // real screen rather than an empty outlet.
      surfaces === null ? '/settings/connections' : '/settings/appearance',
    );
    const violations = await auditOf(container);
    expect(describeViolations(violations)).toBe('');
    expect(violations).toHaveLength(0);
  });

  test('the refusal screen is clean too', async () => {
    useMyPrincipal.mockReturnValue({ me: null, scopes: null, settingsSurfaces: null, loading: false });
    const { container } = renderShell();
    expect(await auditOf(container)).toHaveLength(0);
  });
});

describe('the shell is navigable by keyboard, and says where you are', () => {
  test('every visible entry is reachable by Tab, in the rendered order', async () => {
    useMyPrincipal.mockReturnValue({
      me: { id: 'r', role: 'orchestrator' }, scopes: ['root'], settingsSurfaces: allSurfaces(true), loading: false,
    });
    renderShell();
    const user = userEvent.setup();

    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(settingsNavEntries.length);

    // Focus order follows DOM order, which follows the group/entry order the
    // configuration declares — nothing here reorders with a tabindex.
    for (const link of links) {
      await user.tab();
      expect(document.activeElement).toBe(link);
    }
  });

  test('the group headings are real headings, so a screen reader can jump between them', () => {
    useMyPrincipal.mockReturnValue({
      me: { id: 'r', role: 'orchestrator' }, scopes: ['root'], settingsSurfaces: allSurfaces(true), loading: false,
    });
    renderShell();
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    // One h1 for the page, an h2 per group — no level is skipped.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Settings');
    expect(within(nav).getAllByRole('heading', { level: 2 }).length).toBeGreaterThan(0);
  });

  test('each group is a list, and its accessible name is its heading', () => {
    useMyPrincipal.mockReturnValue({
      me: { id: 'r', role: 'orchestrator' }, scopes: ['root'], settingsSurfaces: allSurfaces(true), loading: false,
    });
    renderShell();
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const lists = within(nav).getAllByRole('list');
    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) {
      expect(list).toHaveAccessibleName();
    }
  });
});
