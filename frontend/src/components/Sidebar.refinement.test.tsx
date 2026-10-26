// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Sidebar } from './Sidebar';
import { MEMBER_ONLY, type MyLenses } from '../types/lenses';
import type { PluginNavItem } from '../types/plugin';

// Each test starts from a member session with no plugin entries; the
// current-page test widens both through these.
let pluginSidebarItems: PluginNavItem[] = [];
let principal: Record<string, unknown> = { me: { id: 'reader' } };
let lenses: MyLenses = MEMBER_ONLY;
vi.mock('../contexts/PluginContext', () => ({ usePlugins: () => ({ plugins: [], pluginSidebarItems, loading: false }) }));
vi.mock('../hooks/usePrincipals', () => ({ useMyPrincipal: () => principal }));
vi.mock('../hooks/useMyLenses', () => ({ useMyLenses: () => ({ lenses, loading: false }) }));
vi.mock('../utils/browserSession', () => ({ useBrowserSession: () => true }));
vi.mock('./StatusOrb', () => ({ StatusOrb: () => <span>Connection status</span> }));
vi.mock('../utils/orbStatus', () => ({ orbStatusBus: { setConnected: vi.fn() }, attachOrbStatusForwarder: () => vi.fn() }));
let listeners: Set<(event: MediaQueryListEvent) => void>;
beforeEach(() => {
  localStorage.clear(); listeners = new Set();
  pluginSidebarItems = []; principal = { me: { id: 'reader' } }; lenses = MEMBER_ONLY;
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener), removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener) }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function LocationWitness() { return <output aria-label="Current test route">{useLocation().pathname}</output>; }

test('closes the mobile menu after navigation and restores desktop navigation after resize', async () => {
  const user = userEvent.setup();
  render(<MemoryRouter><Sidebar connected /><LocationWitness /></MemoryRouter>);
  const sidebar = document.getElementById('sidebar-navigation')!;
  expect(sidebar).toHaveAttribute('inert');
  await user.click(screen.getByRole('button', { name: 'Open menu' }));
  expect(sidebar).not.toHaveAttribute('inert');
  await user.click(within(sidebar).getByRole('link', { name: 'Reports' }));
  // Navigation updates the route before Sidebar's pathname effect commits its closed state.
  // Await that observable state, retaining the accessibility and resize assertions below.
  expect(await screen.findByText('/reports', { selector: 'output' })).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: 'Open menu' })).toHaveAttribute('aria-expanded', 'false');
  expect(sidebar).toHaveAttribute('inert');
  act(() => listeners.forEach(listener => listener({ matches: false } as MediaQueryListEvent)));
  expect(sidebar).not.toHaveAttribute('inert');
  expect(sidebar).not.toHaveAttribute('aria-hidden');
  expect(within(sidebar).getByRole('link', { name: 'Reports' })).toBeInTheDocument();
});

test('a collapsed navigation group excludes hidden links and names its controlled region', async () => {
  const user = userEvent.setup();
  render(<MemoryRouter><Sidebar connected /></MemoryRouter>);
  await user.click(screen.getByRole('button', { name: 'Open menu' }));
  const toggle = screen.getByRole('button', { name: 'More' });
  if (toggle.getAttribute('aria-expanded') === 'true') await user.click(toggle);
  const group = document.getElementById(toggle.getAttribute('aria-controls')!)!;
  expect(group).toHaveAttribute('inert');
  expect(group).toHaveAttribute('aria-hidden', 'true');
  expect(screen.queryByRole('link', { name: 'Skills' })).not.toBeInTheDocument();
  await user.click(toggle);
  expect(group).not.toHaveAttribute('inert');
  expect(screen.getByRole('link', { name: 'Skills' })).toBeInTheDocument();
});

// Owner bug report E406: on the Advanced page both Access and Advanced were
// highlighted, because each link matched by a character prefix. Exactly one
// entry of the whole rail (its groups and its plugin entries, in the mobile
// drawer as on the desktop rail) is the current page, matched by whole path
// segments with the longest match winning.
test('marks exactly one entry as the current page, by whole path segments and the longest match', async () => {
  const user = userEvent.setup();
  principal = { me: { id: 'p-root', role: 'admin', handle: 'root-person' }, scopes: ['root'] };
  lenses = { lenses: ['member', 'admin'], admin: true };
  pluginSidebarItems = [
    { label: 'Insights', path: '/tasks/insights', icon: 'chart', pluginName: 'insights', healthy: true } as PluginNavItem,
    { label: 'Knowledge base', path: '/knowledgebase', icon: 'book', pluginName: 'kb', healthy: true } as PluginNavItem,
  ];
  const cases: Array<[string, string[]]> = [
    ['/settings/access-manager', ['Advanced']],
    ['/settings/access', ['Access']],
    ['/settings/access-manager/approvals', ['Advanced']],
    ['/settings/access/grant-1', ['Access']],
    ['/settings/accessory', []],
    ['/', ['Dashboard']],
    ['/tasks', ['Tasks']],
    ['/tasks/abc', ['Tasks']],
    ['/tasks/insights/week', ['Insights']],
    ['/knowledgebase', ['Knowledge base']],
    ['/knowledge', ['Knowledge']],
  ];
  for (const [path, expected] of cases) {
    render(<MemoryRouter initialEntries={[path]}><Sidebar connected /></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    const sidebar = document.getElementById('sidebar-navigation')!;
    const links = within(sidebar).getAllByRole('link');
    // The Administration entries are drawn: the case is not vacuous.
    expect(within(sidebar).getByRole('link', { name: 'Advanced' })).toBeInTheDocument();
    // The highlight is checked FIRST: the two-highlight bug is two entries
    // drawn with the active class, so a regression of the rule fails here, on
    // the highlighted list itself, before the announced page is looked at.
    const highlighted = links.filter((link) => link.classList.contains('sidebar-nav-link--active'));
    expect(highlighted.map((link) => link.getAttribute('aria-label')), `${path}: highlighted entries`).toEqual(expected);
    const current = links.filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current.map((link) => link.getAttribute('aria-label')), `${path}: aria-current entries`).toEqual(expected);
    cleanup();
  }
});
