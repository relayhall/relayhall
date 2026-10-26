// @vitest-environment jsdom
/**
 * The two new pages are LINK-ONLY and GUARDED (card b1e3b16d, lane L1;
 * design B.1; owner ruling E16: the left menu stays as it is). Owner ruling
 * E453 later CHANGED the menu: the notification centre is the Action Center,
 * with a left-menu entry under Dashboard at `/action-center`, and Agent
 * sessions left the menu for its tab. `/notifications` and `/sessions` are
 * aliases (they replace themselves with the Action Center), so neither old
 * path is a menu entry or a page of its own.
 *
 * LINK-ONLY is asserted against the navigation itself, not against a copy of
 * it: `getSidebarNavItems()`, the hero quick actions and the Settings entries
 * are compared with the lists main shipped (d12d8144), so a new entry for
 * either page — or any other drift — reddens here. The existing census suites
 * (`settingsRouteCensus`, `Sidebar.*`) are untouched by this lane.
 *
 * MOUNTED is a source pin on App.tsx, labelled as one (the route table needs
 * every provider to render; `RouteUnavailablePage.test.tsx` makes the same
 * choice): each page is a literal top-level route outside the Settings shell.
 *
 * GUARDED: each page asks nothing of an identity with no resolved principal
 * (the approval routes refuse it as PRINCIPAL_REQUIRED) and says why, and
 * shows a checking state while the identity is unresolved.
 */
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../utils/auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
const useMyPrincipal = vi.fn();
const usePrincipals = vi.fn();
vi.mock('../hooks/usePrincipals', () => ({
  useMyPrincipal: () => useMyPrincipal(),
  usePrincipals: () => usePrincipals(),
}));

import { getHeroNavItems, getSidebarNavItems, navigationItems } from '../config/navigation';
import { settingsNavEntries } from '../config/settingsNavigation';
import { ApprovalsPage } from './ApprovalsPage';
import { NotificationsPage } from './NotificationsPage';

const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx'), 'utf-8');
const NEW_PATHS = ['/approvals', '/notifications', '/sessions'];

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, approvals: [], notifications: [] }) });
  usePrincipals.mockReturnValue({ principals: [] });
});
afterEach(() => { cleanup(); });

describe('link-only: no menu names either page', () => {
  test('the sidebar navigation is exactly what main shipped, with the Action Center under Dashboard (E453)', () => {
    expect(getSidebarNavItems().map((item) => `${item.id} ${item.path}`)).toEqual([
      'dashboard /', 'action-center /action-center', 'tasks /tasks', 'projects /projects', 'reports /reports',
      'knowledge /knowledge', 'skills /skills', 'blueprints /blueprints', 'tools /tools', 'audit /audit',
      'stats /stats', 'personalities /personalities',
    ]);
  });

  test('the hero quick actions are exactly what main shipped, the Action Center in Agent sessions\' place (E453)', () => {
    expect(getHeroNavItems().map((item) => item.id)).toEqual([
      'action-center', 'tasks', 'projects', 'reports', 'skills', 'blueprints', 'tools', 'audit', 'stats', 'personalities',
    ]);
  });

  test('the Settings entries are exactly what main shipped', () => {
    expect(settingsNavEntries.map((entry) => entry.path)).toEqual([
      '/settings/plugins', '/settings/preferences', '/settings/connections', '/settings/access-manager',
      '/settings/access', '/settings/principals', '/settings/appearance',
      // Card 08792425 (member N6): the Services page, where knowledge sources register.
      '/settings/services',
    ]);
  });

  test('the Action Center entry is named so and opens /action-center', () => {
    const entry = getSidebarNavItems().find((item) => item.id === 'action-center');
    expect([entry?.label, entry?.path, entry?.group]).toEqual(['Action Center', '/action-center', 'main']);
  });

  test('no old or link-only path appears in any navigation list', () => {
    const named = [...navigationItems.map((item) => item.path), ...settingsNavEntries.map((entry) => entry.path)];
    for (const path of NEW_PATHS) {
      expect(named.some((candidate) => candidate === path || candidate.startsWith(`${path}/`))).toBe(false);
    }
  });
});

describe('mounted: each page is a literal top-level route (source pin)', () => {
  test.each([
    ['/approvals', '<Route path="/approvals" element={<ApprovalsPage />} />'],
    ['/action-center', '<Route path="/action-center" element={<NotificationsPage />} />'],
    // E453: the old paths are aliases of the Action Center, never pages of their own.
    ['/notifications', '<Route path="/notifications" element={<ActionCenterAlias from="notifications" />} />'],
    ['/sessions', '<Route path="/sessions" element={<ActionCenterAlias from="sessions" />} />'],
  ])('%s', (path, literal) => {
    expect(app.split(literal).length - 1).toBe(1);
    // outside the Settings shell, so the Settings census and its guard are not involved
    const shellOpen = app.indexOf('<Route path="/settings" element={<SettingsPage />}>');
    const shellClose = app.indexOf('\n      </Route>', shellOpen);
    const at = app.indexOf(literal);
    expect(at < shellOpen || at > shellClose).toBe(true);
    // and no other route claims the path
    const claims = [...app.matchAll(/<Route\s[^>]*?path="([^"]*)"/g)].map((match) => match[1]);
    expect(claims.filter((claim) => claim === path)).toEqual([path]);
  });
});

describe('guarded: nothing is asked of an unresolved identity', () => {
  test.each([
    ['the hub', () => <ApprovalsPage />, /approvals hub needs a resolved identity/],
    ['the Action Center', () => <NotificationsPage />, /The Action Center needs a resolved identity/],
  ])('%s refuses an identity with no principal and reads nothing', async (_name, page, message) => {
    useMyPrincipal.mockReturnValue({ me: null, scopes: null, loading: false });
    render(<MemoryRouter>{page()}</MemoryRouter>);
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    ['the hub', () => <ApprovalsPage />],
    ['the Action Center', () => <NotificationsPage />],
  ])('%s shows a checking state while the identity resolves, and reads nothing yet', async (_name, page) => {
    useMyPrincipal.mockReturnValue({ me: null, scopes: undefined, loading: true });
    render(<MemoryRouter>{page()}</MemoryRouter>);
    expect(screen.getByText(/Checking authority/)).toBeInTheDocument();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a resolved identity gets the hub, which reads the self-scoped queue', async () => {
    useMyPrincipal.mockReturnValue({ me: { id: 'p1', handle: 'river' }, scopes: ['tasks:read'], loading: false });
    render(<MemoryRouter initialEntries={['/approvals']}><ApprovalsPage /></MemoryRouter>);
    expect(screen.getByRole('heading', { level: 1, name: 'Approvals' })).toBeInTheDocument();
    expect(await screen.findByText('No pending decisions.')).toBeInTheDocument();
    expect(await screen.findByText('Nothing is waiting on you.')).toBeInTheDocument();
    // The hub reads the same self-scoped queue through its view (card b1e3b16d).
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain('/api/approvals?view=hub&status=pending');
  });
});
