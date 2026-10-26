// @vitest-environment jsdom
/**
 * The Sidebar draws the sections the SERVER's lens answer offers (RH-LENSES-d,
 * card 4e159741; design 96f0bd3d s8.4).
 *
 *  - The admin lens's Administration group appears exactly when
 *    `GET /principals/me/lenses` says `admin: true`, and it is ABSENT
 *    otherwise, not rendered empty or disabled.
 *  - Nothing is derived on the client: a session whose scopes include `root`
 *    but whose lens answer is a member's (a bearer holding root, say) is drawn
 *    as a member. This is acceptance A-L30 as the dashboard sees it.
 *  - Failing closed: no answer, a refused answer or an unreadable one draws
 *    the member sections, never the administration ones.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

const useMyPrincipal = vi.fn();
const lensAnswer = vi.fn();
vi.mock('../hooks/usePrincipals', () => ({ useMyPrincipal: () => useMyPrincipal() }));
vi.mock('../contexts/PluginContext', () => ({
  usePlugins: () => ({ plugins: [], pluginSidebarItems: [], loading: false }),
}));
vi.mock('../utils/auth', () => ({
  auth: { getToken: () => 't', clearToken: () => {}, isAuthenticated: () => true },
  authenticatedFetch: vi.fn(async (url: string) => {
    if (String(url).endsWith('/principals/me/lenses')) return lensAnswer();
    return { ok: true, status: 200, json: async () => ({}) };
  }),
}));
vi.mock('../utils/browserSession', () => ({ useBrowserSession: () => undefined }));

import { Sidebar } from './Sidebar';
import { authenticatedFetch } from '../utils/auth';

const answer = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const ROOT_SESSION = { me: { id: 'p0', role: 'admin', handle: 'root-person' }, scopes: ['root'], loading: false };

afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function renderSettled() {
  render(<MemoryRouter><Sidebar connected /></MemoryRouter>);
  await waitFor(() => expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) => String(url).endsWith('/principals/me/lenses'))).toBe(true));
  // Let the answer land.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('the admin lens offers the Administration group', () => {
  test('the server says admin: the group and its sections are drawn', async () => {
    useMyPrincipal.mockReturnValue(ROOT_SESSION);
    lensAnswer.mockResolvedValue(answer(200, { lenses: ['member', 'admin'], admin: true }));
    await renderSettled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Administration' })).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Directory' })).toHaveAttribute('href', '/directory');
    expect(screen.getByRole('link', { name: 'Groups' })).toHaveAttribute('href', '/groups');
    expect(screen.getByRole('link', { name: 'People' })).toHaveAttribute('href', '/settings/principals');
    expect(screen.getByRole('link', { name: 'Access' })).toHaveAttribute('href', '/settings/access');
    expect(screen.getByRole('link', { name: 'Advanced' })).toHaveAttribute('href', '/settings/access-manager');
  });

  test('the member sections are drawn for the admin lens as well: the union is shown', async () => {
    useMyPrincipal.mockReturnValue(ROOT_SESSION);
    lensAnswer.mockResolvedValue(answer(200, { lenses: ['member', 'admin'], admin: true }));
    await renderSettled();
    await waitFor(() => expect(screen.getByRole('link', { name: 'Directory' })).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Tasks' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Projects' })).toBeInTheDocument();
  });
});

describe('nothing is derived on the client, and the absence is real', () => {
  test('root scopes with a member answer draw a member: the server decides, not the scope set', async () => {
    useMyPrincipal.mockReturnValue(ROOT_SESSION);
    lensAnswer.mockResolvedValue(answer(200, { lenses: ['member'], admin: false }));
    await renderSettled();
    expect(screen.getByRole('link', { name: 'Tasks' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Administration' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Directory' })).not.toBeInTheDocument();
  });

  for (const [label, outcome] of [
    ['a refused read', () => Promise.resolve(answer(403, { error: 'Forbidden' }))],
    ['a board without the route', () => Promise.resolve(answer(404, { error: 'Not Found' }))],
    ['a network failure', () => Promise.reject(new Error('offline'))],
    ['an unreadable body', () => Promise.resolve({ ok: true, status: 200, json: async () => { throw new Error('not json'); } })],
    ['a body that claims admin in one field only', () => Promise.resolve(answer(200, { lenses: ['member'], admin: true }))],
  ] as const) {
    test(`${label} draws the member sections and no Administration group`, async () => {
      useMyPrincipal.mockReturnValue(ROOT_SESSION);
      lensAnswer.mockImplementation(outcome);
      await renderSettled();
      expect(screen.getByRole('link', { name: 'Tasks' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Administration' })).not.toBeInTheDocument();
    });
  }

  test('a Settings page the Access-surface arm conceals is not offered, even with the admin lens', async () => {
    useMyPrincipal.mockReturnValue({
      ...ROOT_SESSION,
      settingsSurfaces: [
        { key: 'settings.identities', visible: false },
        { key: 'settings.access-grants', visible: true },
        { key: 'settings.access-manager', visible: true },
      ],
    });
    lensAnswer.mockResolvedValue(answer(200, { lenses: ['member', 'admin'], admin: true }));
    await renderSettled();
    await waitFor(() => expect(screen.getByRole('link', { name: 'Directory' })).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'People' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Access' })).toBeInTheDocument();
  });
});
