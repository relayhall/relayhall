// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Sidebar } from './Sidebar';

vi.mock('../contexts/PluginContext', () => ({ usePlugins: () => ({ plugins: [], pluginSidebarItems: [], loading: false }) }));
vi.mock('../hooks/usePrincipals', () => ({ useMyPrincipal: () => ({ me: { id: 'reader' } }) }));
vi.mock('../utils/browserSession', () => ({ useBrowserSession: () => true }));
vi.mock('./StatusOrb', () => ({ StatusOrb: () => <span>Connection status</span> }));
vi.mock('../utils/orbStatus', () => ({ orbStatusBus: { setConnected: vi.fn() }, attachOrbStatusForwarder: () => vi.fn() }));
let listeners: Set<(event: MediaQueryListEvent) => void>;
beforeEach(() => {
  localStorage.clear(); listeners = new Set();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener), removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener) }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('closes the mobile menu after navigation and restores desktop navigation after resize', async () => {
  const user = userEvent.setup();
  render(<MemoryRouter><Sidebar connected /></MemoryRouter>);
  const sidebar = document.getElementById('sidebar-navigation')!;
  expect(sidebar).toHaveAttribute('inert');
  await user.click(screen.getByRole('button', { name: 'Open menu' }));
  expect(sidebar).not.toHaveAttribute('inert');
  await user.click(within(sidebar).getByRole('link', { name: 'Reports' }));
  expect(screen.getByRole('button', { name: 'Open menu' })).toHaveAttribute('aria-expanded', 'false');
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
