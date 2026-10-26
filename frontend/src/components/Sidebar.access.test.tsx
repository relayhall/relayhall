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
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

// An invented, handle-shaped fixture identity; the monogram is derived from it.
const OWNER_HANDLE = 'river';
const MONOGRAM = OWNER_HANDLE[0].toUpperCase();

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

/**
 * WHERE the one entry sits (owner ruling E21, 10 Oct 2026).
 *
 * Card 89c4eb9a scope A had moved it up into the account row; E21 moves it
 * back down, IMMEDIATELY ABOVE Logout, because Settings is used less often
 * than the rest of the rail. Destination, name, icon and condition are the
 * ones the block above pins — only the place changes. These pin the place in
 * the order a person meets it: every main navigation entry first, then
 * Settings, then Logout, with nothing between the last two, and the keyboard
 * walking the same order the eye does.
 */
describe('the Settings entry sits below the main items, immediately above Logout', () => {
  const settingsAndLogout = () => {
    const settings = screen.getByRole('link', { name: 'Settings' });
    const logout = screen.getByRole('button', { name: 'Logout' });
    return { settings, logout };
  };

  test('after every main navigation entry, before Logout, and adjacent to it', () => {
    useMyPrincipal.mockReturnValue({ me: { id: 'p1', role: 'user', handle: OWNER_HANDLE }, scopes: ['tasks:read'], loading: false });
    const { container } = render(<MemoryRouter><Sidebar connected /></MemoryRouter>);
    const { settings, logout } = settingsAndLogout();
    const navLinks = within(screen.getByRole('navigation', { name: 'Main navigation' })).getAllByRole('link', { hidden: true });
    expect(navLinks.length).toBeGreaterThan(0);
    for (const link of navLinks) {
      expect(link.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(settings.compareDocumentPosition(logout) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Immediately above: the same foot section, nothing rendered between them.
    expect(settings.nextElementSibling).toBe(logout);
    expect(settings.parentElement).toBe(container.querySelector('.logout-section'));
    // and it is no longer in the account row, nor in the main navigation
    expect((container.querySelector('.sidebar-account') as HTMLElement).contains(settings)).toBe(false);
    expect(screen.getByRole('navigation', { name: 'Main navigation' }).contains(settings)).toBe(false);
  });

  test('keyboard order follows the visual order: Settings, then Logout', async () => {
    useMyPrincipal.mockReturnValue({ me: { id: 'p1', role: 'user', handle: OWNER_HANDLE }, scopes: ['tasks:read'], loading: false });
    renderSidebar();
    const { settings, logout } = settingsAndLogout();
    expect(settings).not.toHaveAttribute('tabindex');
    expect(logout).not.toHaveAttribute('tabindex');
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    settings.focus();
    expect(settings).toHaveFocus();
    await user.tab();
    expect(logout).toHaveFocus();
    await user.tab({ shift: true });
    expect(settings).toHaveFocus();
  });

  test('keeps its route, its icon and its single visible name', () => {
    useMyPrincipal.mockReturnValue({ me: { id: 'p1', role: 'user', handle: OWNER_HANDLE }, scopes: ['tasks:read'], loading: false });
    renderSidebar();
    const { settings } = settingsAndLogout();
    expect(settings).toHaveAttribute('href', '/settings');
    expect(settings).toHaveAttribute('title', 'Settings');
    expect(settings.querySelector('svg.lucide-settings')).toHaveAttribute('aria-hidden', 'true');
  });
});

/**
 * The account ROW (card 89c4eb9a scope A; owner ruling E21, 10 Oct 2026).
 *
 * E21: "a small avatar with the name of the sign-in account and a notification
 * bell". The row is exactly those three — the monogram, the handle, the bell —
 * and nothing else: no `Signed in as` caption or tooltip, no Settings link
 * (it sits above Logout now, pinned above), no other control.
 */
describe('the account row', () => {
  test('carries only the avatar, the account name and the bell', () => {
    useMyPrincipal.mockReturnValue({ me: { id: 'p1', role: 'user', handle: OWNER_HANDLE }, scopes: ['tasks:read'], loading: false });
    const { container } = render(<MemoryRouter><Sidebar connected /></MemoryRouter>);
    const row = container.querySelector('.sidebar-account') as HTMLElement;
    expect(row).toBeInTheDocument();
    expect(row).toHaveAttribute('title', OWNER_HANDLE);
    expect(row.querySelector('.sidebar-account-avatar')!.textContent).toBe(MONOGRAM);
    expect(within(row).getByText(OWNER_HANDLE)).toBeVisible();
    // The three parts, in order, and no fourth.
    const parts = Array.from(row.children);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toHaveClass('sidebar-account-avatar');
    expect(parts[1]).toHaveClass('sidebar-account-text');
    expect(parts[2]).toHaveClass('sidebar-account-bell');
    expect(parts[1].children).toHaveLength(1); // the handle, and no caption beside it
    expect(row.querySelectorAll('a')).toHaveLength(0);
    expect(Array.from(row.querySelectorAll('button'))).toEqual([within(row).getByRole('button', { name: /^Notifications/ })]);
    // `Signed in as` is gone everywhere in the rail — text, tooltip and name.
    expect(within(row).queryByText(/Signed in as/)).not.toBeInTheDocument();
    expect(document.querySelector('[title*="Signed in as"], [aria-label*="Signed in as"]')).toBeNull();
    expect(document.body.textContent).not.toContain('Signed in as');
  });

  test('the Settings affordance carries its VISIBLE word, not just a glyph', () => {
    useMyPrincipal.mockReturnValue({ me: { id: 'p1', role: 'user', handle: OWNER_HANDLE }, scopes: ['tasks:read'], loading: false });
    renderSidebar();
    const link = screen.getByRole('link', { name: 'Settings' });
    const label = link.querySelector('.sidebar-preferences-text')!;
    expect(label).toHaveTextContent('Settings');
    // The word is ordinary rendered text. One stylesheet rule clips it — the
    // 96px compact rail, which withholds every other text label as well — and
    // it does not use `display: none`, so the accessible name is this same
    // word everywhere. Nothing hides it in the full rail or the drawer.
    expect(label).not.toHaveClass('sr-only');
    expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  test('the rail reads account, identity, navigation, then Settings above Logout', () => {
    useMyPrincipal.mockReturnValue({ me: { id: 'p1', role: 'user', handle: OWNER_HANDLE }, scopes: ['tasks:read'], loading: false });
    const { container } = render(<MemoryRouter><Sidebar connected /></MemoryRouter>);
    const row = container.querySelector('.sidebar-account')!;
    const host = container.querySelector('.sidebar-avatar-section')!;
    const nav = container.querySelector('.sidebar-nav-section')!;
    const foot = container.querySelector('.logout-section')!;
    expect(row.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(host.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(nav.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('an unresolved identity gets no row at all', () => {
    useMyPrincipal.mockReturnValue({ me: null, scopes: null, loading: false });
    const { container } = render(<MemoryRouter><Sidebar connected /></MemoryRouter>);
    expect(container.querySelector('.sidebar-account')).toBeNull();
  });

  test('a resolved identity with no handle still gets the row, the bell and Settings, and claims no handle', () => {
    useMyPrincipal.mockReturnValue({ me: { id: 'p1', role: 'user' }, scopes: ['tasks:read'], loading: false });
    const { container } = render(<MemoryRouter><Sidebar connected /></MemoryRouter>);
    const row = container.querySelector('.sidebar-account') as HTMLElement;
    expect(row).toBeInTheDocument();
    expect(row).not.toHaveAttribute('title');
    expect(row.querySelector('.sidebar-account-text')).toBeNull();
    expect(screen.queryByText('Signed in as')).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /^Notifications/ })).toBeInTheDocument();
    expect(within(row).queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' }).nextElementSibling)
      .toBe(screen.getByRole('button', { name: 'Logout' }));
  });
});

/**
 * The CLOSED mobile state (card 89c4eb9a, the P2 scope A deferred). Below the
 * hamburger breakpoint with the drawer closed the rail is inert and
 * off-screen, so the identity is carried by a chip on the control's row. These
 * pin what could rot: that the chip is there; that it shows the account row's
 * monogram and the handle and, since owner ruling E21, nothing else — no
 * `Signed in as` label, tooltip or name; that it is NOT an action (no link, no
 * button — the one account destination stays in the drawer, above Logout);
 * that it claims no handle it does not have; and that it yields to the drawer,
 * whose own account row then carries the identity.
 */
describe('the closed mobile state', () => {
  const mobile = () => vi.stubGlobal('matchMedia', () => ({
    matches: true, addEventListener: () => {}, removeEventListener: () => {},
  }));
  afterEach(() => { vi.unstubAllGlobals(); });

  test('carries the identity as a monogram + handle chip, with no `Signed in as` copy', () => {
    mobile();
    useMyPrincipal.mockReturnValue({ me: { id: 'p1', role: 'user', handle: OWNER_HANDLE }, scopes: ['tasks:read'], loading: false });
    const { container } = render(<MemoryRouter><Sidebar connected /></MemoryRouter>);
    const chip = container.querySelector('.sidebar-mobile-account') as HTMLElement;
    expect(chip).toBeInTheDocument();
    expect(chip).not.toHaveAttribute('aria-label');
    expect(chip).toHaveAttribute('title', OWNER_HANDLE);
    expect(chip.textContent).toBe(`${MONOGRAM}${OWNER_HANDLE}`);
    expect(document.querySelector('[title*="Signed in as"], [aria-label*="Signed in as"]')).toBeNull();
    const monogram = chip.querySelector('.sidebar-mobile-account-avatar')!;
    expect(monogram.textContent).toBe(MONOGRAM);
    expect(monogram).toHaveAttribute('aria-hidden', 'true');
    const handle = chip.querySelector('.sidebar-mobile-account-handle')!;
    expect(handle).toHaveTextContent(OWNER_HANDLE);
    expect(handle).not.toHaveAttribute('aria-hidden');
    // and it sits OUTSIDE the inert rail, so it is visible while the rail is not
    expect(document.getElementById('sidebar-navigation')!.contains(chip)).toBe(false);
  });

  test('is not an action: no link, no button, no Settings glyph', () => {
    mobile();
    useMyPrincipal.mockReturnValue({ me: { id: 'p1', role: 'user', handle: OWNER_HANDLE }, scopes: ['tasks:read'], loading: false });
    const { container } = render(<MemoryRouter><Sidebar connected /></MemoryRouter>);
    const chip = container.querySelector('.sidebar-mobile-account') as HTMLElement;
    expect(chip.tagName).toBe('SPAN');
    expect(chip.querySelector('a, button, svg')).toBeNull();
    expect(chip).not.toHaveAttribute('tabindex');
    // The ONE account destination is still in the drawer, and only there.
    const links = screen.getAllByRole('link', { name: 'Settings', hidden: true });
    expect(links).toHaveLength(1);
    expect(document.getElementById('sidebar-navigation')!.contains(links[0])).toBe(true);
  });

  test('claims no handle it does not have', () => {
    mobile();
    useMyPrincipal.mockReturnValue({ me: { id: 'p1', role: 'user' }, scopes: ['tasks:read'], loading: false });
    const { container } = render(<MemoryRouter><Sidebar connected /></MemoryRouter>);
    expect(container.querySelector('.sidebar-mobile-account')).toBeNull();
  });

  test('yields to the drawer, whose account row then carries the identity', async () => {
    mobile();
    useMyPrincipal.mockReturnValue({ me: { id: 'p1', role: 'user', handle: OWNER_HANDLE }, scopes: ['tasks:read'], loading: false });
    const { container } = render(<MemoryRouter><Sidebar connected /></MemoryRouter>);
    expect(container.querySelector('.sidebar-mobile-account')).toBeInTheDocument();
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open menu' }));
    expect(container.querySelector('.sidebar-mobile-account')).toBeNull();
    const row = container.querySelector('.sidebar-account') as HTMLElement;
    expect(within(row).getByText(OWNER_HANDLE)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close menu' }));
    expect(container.querySelector('.sidebar-mobile-account')).toBeInTheDocument();
  });
});
