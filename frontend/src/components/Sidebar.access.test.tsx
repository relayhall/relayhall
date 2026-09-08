// @vitest-environment jsdom
/**
 * The Sidebar's ONE account destination (card `d0f030a9`, contract `8dbc0b81`;
 * previously AZ-S4, design `4d961e37` §6.1/AZ-16, review `644a2538` F2).
 *
 * WHAT CHANGED AND WHY IT IS A FIX, not only a consolidation.
 *
 *  1. There is one entry, not two. `Settings` and `Preferences` sat side by
 *     side, so a person's own theme looked like a different product from their
 *     own access. Preferences is now the first entry INSIDE the shell.
 *  2. Its title no longer varies with authority. The old entry read
 *     "Administration settings" for root and "Access manager" for everybody
 *     else, which published the session's authority into the DOM before the
 *     shell was ever opened — a small disclosure of the same kind the arm's
 *     404 concealment refuses at the HTTP seam. One destination, one name.
 *  3. An identity with no resolved principal still gets NO entry. The shell
 *     has nothing to show it, and a link to a refusal is not navigation.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

const useMyPrincipal = vi.fn();
vi.mock('../hooks/usePrincipals', () => ({ useMyPrincipal: () => useMyPrincipal() }));
vi.mock('../contexts/PluginContext', () => ({
  usePlugins: () => ({ plugins: [], pluginSidebarItems: [], loading: false }),
}));
vi.mock('../utils/auth', () => ({
  auth: { getToken: () => 't', clearToken: () => {}, isAuthenticated: () => true },
  authenticatedFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
}));
vi.mock('../utils/browserSession', () => ({ useBrowserSession: () => undefined }));

import { Sidebar } from './Sidebar';

function renderSidebar() {
  render(<MemoryRouter><Sidebar connected /></MemoryRouter>);
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('the Sidebar carries one Settings entry', () => {
  test('root reaches the shell', () => {
    useMyPrincipal.mockReturnValue({ me: { id: 'p0', role: 'orchestrator' }, scopes: ['root'], loading: false });
    renderSidebar();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
  });

  test('a non-root Account reaches the same shell, by the same name', () => {
    useMyPrincipal.mockReturnValue({ me: { id: 'p1', role: 'user' }, scopes: ['tasks:read'], loading: false });
    renderSidebar();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
  });

  test('the entry discloses nothing about the session that holds it', () => {
    const titles: (string | null)[] = [];
    for (const session of [
      { me: { id: 'p0', role: 'orchestrator' }, scopes: ['root'], loading: false },
      { me: { id: 'p1', role: 'user' }, scopes: ['tasks:read'], loading: false },
    ]) {
      useMyPrincipal.mockReturnValue(session);
      renderSidebar();
      titles.push(screen.getByRole('link', { name: 'Settings' }).getAttribute('title'));
      cleanup();
    }
    expect(titles[0]).toBe(titles[1]);
  });

  test('there is exactly ONE account destination — Preferences is no longer a sibling', () => {
    useMyPrincipal.mockReturnValue({ me: { id: 'p1', role: 'user' }, scopes: ['tasks:read'], loading: false });
    renderSidebar();
    expect(screen.queryByRole('link', { name: 'Preferences' })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('link', { name: /^Settings$/ })).toHaveLength(1);
  });

  test('an unresolved identity gets no Settings entry at all', () => {
    useMyPrincipal.mockReturnValue({ me: null, scopes: null, loading: false });
    renderSidebar();
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
  });
});
