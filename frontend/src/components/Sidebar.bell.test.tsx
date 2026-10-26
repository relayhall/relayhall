// @vitest-environment jsdom
/**
 * Where the bell sits in the sidebar (card b1e3b16d, lane L1; design T2).
 *
 * A control in the account row — since owner ruling E21 its only control,
 * after the avatar and the account name — never a navigation entry; in
 * the closed mobile state, a SIBLING of the identity chip drawn over the cell
 * the chip reserves for it — the chip itself stays the non-action
 * `Sidebar.access.test.tsx` pins; withheld, like the row, from an identity
 * with no resolved principal.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

const useMyPrincipal = vi.fn();
vi.mock('../hooks/usePrincipals', () => ({ useMyPrincipal: () => useMyPrincipal() }));
vi.mock('../contexts/PluginContext', () => ({
  usePlugins: () => ({ plugins: [], pluginSidebarItems: [], loading: false }),
}));
vi.mock('../utils/auth', () => ({
  auth: { getToken: () => 't', clearToken: () => {}, isAuthenticated: () => true },
  authenticatedFetch: vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    // The bell reads the action list (card 5854f0d6, Slice B): an empty one.
    json: async () => (String(url).includes('/notifications/actions')
      ? { success: true, items: [], counts: { decision: 0, verify: 0, stuck: 0, skill: 0, total: 0 },
        capped: { decision: false, verify: false, stuck: false, skill: false } }
      : { success: true, approvals: [] }),
  })),
}));
vi.mock('../utils/browserSession', () => ({ useBrowserSession: () => undefined }));

import { Sidebar } from './Sidebar';

const renderSidebar = () => render(<MemoryRouter><Sidebar connected /></MemoryRouter>);
const bells = () => screen.queryAllByRole('button', { name: /^Notifications/, hidden: true });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the bell in the account row', () => {
  test('sits in the row, after the account name, as its only control, and is not navigation', () => {
    // Owner ruling E21: the row is the avatar, the account name and the bell.
    // The Settings link that preceded the bell here now sits above Logout
    // (pinned in Sidebar.access.test.tsx), so the bell follows the handle.
    useMyPrincipal.mockReturnValue({ me: { id: 'p1', role: 'user', handle: 'river' }, scopes: ['tasks:read'], loading: false });
    const { container } = renderSidebar();
    const row = container.querySelector('.sidebar-account') as HTMLElement;
    const bell = within(row).getByRole('button', { name: /^Notifications/ });
    const handle = within(row).getByText('river');
    expect(handle.compareDocumentPosition(bell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.lastElementChild).toBe(bell);
    expect(within(row).queryByRole('link')).not.toBeInTheDocument();
    expect(bell).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.getByRole('navigation', { name: 'Main navigation' }).contains(bell)).toBe(false);
    // still exactly one account destination
    expect(screen.queryAllByRole('link', { name: /^Settings$/ })).toHaveLength(1);
  });

  test('a resolved identity with no handle still gets the bell', () => {
    useMyPrincipal.mockReturnValue({ me: { id: 'p1', role: 'user' }, scopes: ['tasks:read'], loading: false });
    const { container } = renderSidebar();
    expect(within(container.querySelector('.sidebar-account') as HTMLElement)
      .getByRole('button', { name: /^Notifications/ })).toBeInTheDocument();
  });

  test('an unresolved identity gets no bell anywhere', () => {
    useMyPrincipal.mockReturnValue({ me: null, scopes: null, loading: false });
    renderSidebar();
    expect(bells()).toHaveLength(0);
  });
});

describe('the bell in the closed mobile state', () => {
  const mobile = () => vi.stubGlobal('matchMedia', () => ({
    matches: true, addEventListener: () => {}, removeEventListener: () => {},
  }));

  test('rides the floating bar beside the chip, outside the inert rail, and the chip stays a non-action', () => {
    mobile();
    useMyPrincipal.mockReturnValue({ me: { id: 'p1', role: 'user', handle: 'river' }, scopes: ['tasks:read'], loading: false });
    const { container } = renderSidebar();
    const chip = container.querySelector('.sidebar-mobile-account') as HTMLElement;
    expect(chip).toHaveClass('sidebar-mobile-account--beside-bell');
    expect(chip.querySelector('a, button, svg')).toBeNull();
    const floating = container.querySelector('.sidebar-mobile-bell') as HTMLElement;
    expect(floating).toHaveClass('sidebar-mobile-bell--in-chip');
    expect(floating.tagName).toBe('BUTTON');
    expect(document.getElementById('sidebar-navigation')!.contains(floating)).toBe(false);
    // reading order: menu control, identity, bell
    expect(chip.compareDocumentPosition(floating) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // the only bell a person can reach while the rail is inert is this one
    expect(screen.getAllByRole('button', { name: /^Notifications/ })).toEqual([floating]);
  });

  test('stands alone when there is no handle, and so no chip', () => {
    mobile();
    useMyPrincipal.mockReturnValue({ me: { id: 'p1', role: 'user' }, scopes: ['tasks:read'], loading: false });
    const { container } = renderSidebar();
    expect(container.querySelector('.sidebar-mobile-account')).toBeNull();
    const floating = container.querySelector('.sidebar-mobile-bell') as HTMLElement;
    expect(floating).toBeInTheDocument();
    expect(floating).not.toHaveClass('sidebar-mobile-bell--in-chip');
  });

  test('yields to the drawer, whose account row then carries the bell', async () => {
    mobile();
    useMyPrincipal.mockReturnValue({ me: { id: 'p1', role: 'user', handle: 'river' }, scopes: ['tasks:read'], loading: false });
    const { container } = renderSidebar();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open menu' }));
    expect(container.querySelector('.sidebar-mobile-bell')).toBeNull();
    const row = container.querySelector('.sidebar-account') as HTMLElement;
    expect(within(row).getByRole('button', { name: /^Notifications/ })).toBeInTheDocument();
  });

  test('in the open drawer, one Escape closes only the bell panel and leaves the drawer open', async () => {
    mobile();
    useMyPrincipal.mockReturnValue({ me: { id: 'p1', role: 'user', handle: 'river' }, scopes: ['tasks:read'], loading: false });
    const { container } = renderSidebar();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    const row = container.querySelector('.sidebar-account') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /^Notifications/ }));
    expect(screen.getByRole('dialog', { name: 'Needs your action' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Needs your action' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close menu' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(row).getByRole('button', { name: /^Notifications/ })).toHaveFocus();
    // and the next Escape is the drawer's, as before
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveAttribute('aria-expanded', 'false');
  });

  test('is withheld from an unresolved identity', () => {
    mobile();
    useMyPrincipal.mockReturnValue({ me: null, scopes: null, loading: false });
    const { container } = renderSidebar();
    expect(container.querySelector('.sidebar-mobile-bell')).toBeNull();
    expect(bells()).toHaveLength(0);
  });
});
