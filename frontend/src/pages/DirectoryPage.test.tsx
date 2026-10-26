// @vitest-environment jsdom
/**
 * The admin lens's Directory page (RH-LENSES-d, card 4e159741): Identity
 * providers, sync health and the remote-group catalog with *Use this group*,
 * and its DESIGNED empty states (design 96f0bd3d s8.4 rule 3: an
 * administrator with no Identity provider is a normal first-week state).
 *
 * The page decides no authority: a section whose route refuses the session is
 * absent, the catalog is whatever the server's projection answered, and
 * *Use this group* is offered to the admin lens and decided by the route.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type Reply = { status: number; body: unknown };
let replies: Record<string, Reply> = {};
const posted: Array<{ url: string; body: unknown }> = [];

vi.mock('../utils/auth', () => ({
  auth: { getToken: () => 't', clearToken: () => {}, isAuthenticated: () => true },
  authenticatedFetch: vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^\/api/, '');
    if (init?.method === 'POST') {
      posted.push({ url: path, body: init.body ? JSON.parse(String(init.body)) : null });
      const reply = replies[`POST ${path}`] ?? { status: 404, body: { error: 'not found' } };
      return { ok: reply.status < 300, status: reply.status, json: async () => reply.body };
    }
    const reply = replies[path] ?? { status: 404, body: { error: 'not found' } };
    return { ok: reply.status < 300, status: reply.status, json: async () => reply.body };
  }),
}));

import { DirectoryPage } from './DirectoryPage';

const PROVIDER = { id: 'idp-1', name: 'Company SSO', status: 'active' };
const UNBOUND = {
  id: '11111111-1111-4111-8111-111111111111', identityProviderId: 'idp-1', externalGroupRef: 'cn=engineering',
  displayName: 'Engineering', memberCount: 12, sources: ['claim'], lastSeenAt: '2026-10-19T10:00:00.000Z',
  boundGroupId: null, boundGroupName: null,
};
const BOUND = {
  ...UNBOUND, id: '22222222-2222-4222-8222-222222222222', externalGroupRef: 'cn=design', displayName: 'Design',
  memberCount: 3, sources: ['scim'], boundGroupId: 'g-1', boundGroupName: 'Design team',
};

function populated(admin = true) {
  replies = {
    '/principals/me/lenses': { status: 200, body: admin ? { lenses: ['member', 'admin'], admin: true } : { lenses: ['member'], admin: false } },
    '/identity-providers': { status: 200, body: { success: true, identityProviders: [PROVIDER] } },
    '/groups/directory-sync': { status: 200, body: { success: true, providers: [{ provider: 'idp-1', lastSuccessAt: '2026-10-19T09:00:00.000Z', lastErrorPresent: false, stalenessThresholdHours: 24, stale: false }] } },
    '/directory-group-references': { status: 200, body: { success: true, references: [UNBOUND, BOUND] } },
  };
}

function renderPage() {
  render(<MemoryRouter><DirectoryPage /></MemoryRouter>);
}

beforeEach(() => { posted.length = 0; });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('the catalog', () => {
  test('lists every row the server projected, with counts and never people', async () => {
    populated();
    renderPage();
    const table = await screen.findByRole('table', { name: /every directory group/i });
    expect(within(table).getByText('Engineering')).toBeInTheDocument();
    expect(within(table).getByText('cn=engineering')).toBeInTheDocument();
    expect(within(table).getByText('12')).toBeInTheDocument();
    expect(within(table).getAllByText('Company SSO')).toHaveLength(2);
    expect(within(table).getByRole('link', { name: 'Design team' })).toHaveAttribute('href', '/groups');
  });

  test('Use this group is offered for an unbound row only, and posts the chosen name', async () => {
    populated();
    replies['POST /directory-group-references/11111111-1111-4111-8111-111111111111/use'] = {
      status: 201, body: { success: true, groupId: 'g-2', groupName: 'Engineers', memberCountApplied: 12, externalGroupRef: 'cn=engineering' },
    };
    renderPage();
    const use = await screen.findByRole('button', { name: 'Use the directory group Engineering' });
    expect(screen.getAllByRole('button', { name: /^Use the directory group/ })).toHaveLength(1);
    await userEvent.click(use);
    const name = screen.getByLabelText('Group name');
    expect(name).toHaveValue('Engineering');
    await userEvent.clear(name);
    await userEvent.type(name, 'Engineers');
    await userEvent.click(screen.getByRole('button', { name: 'Create and bind' }));
    await waitFor(() => expect(posted).toEqual([{ url: '/directory-group-references/11111111-1111-4111-8111-111111111111/use', body: { name: 'Engineers' } }]));
    expect(await screen.findByRole('status')).toHaveTextContent('Created the group "Engineers" from cn=engineering, with 12 members.');
  });

  test('a refusal is shown in the server\'s own words and nothing is claimed', async () => {
    populated();
    replies['POST /directory-group-references/11111111-1111-4111-8111-111111111111/use'] = {
      status: 409, body: { success: false, code: 'DIRECTORY_BIND_TOO_MANY_ACCOUNTS', message: 'This reference is carried by more Accounts than the bind bound allows' },
    };
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Use the directory group Engineering' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create and bind' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('more Accounts than the bind bound allows');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('without the admin lens the act is not offered; the rows the server answered are still shown as they are', async () => {
    populated(false);
    renderPage();
    await screen.findByRole('table', { name: /every directory group/i });
    expect(screen.queryByRole('button', { name: /^Use the directory group/ })).not.toBeInTheDocument();
    expect(screen.getByText('Not used')).toBeInTheDocument();
  });
});

describe('designed empty states', () => {
  test('an administrator with no Identity provider is told what to do next', async () => {
    replies = {
      '/principals/me/lenses': { status: 200, body: { lenses: ['member', 'admin'], admin: true } },
      '/identity-providers': { status: 200, body: { success: true, identityProviders: [] } },
      '/groups/directory-sync': { status: 200, body: { success: true, providers: [] } },
      '/directory-group-references': { status: 200, body: { success: true, references: [] } },
    };
    renderPage();
    expect(await screen.findByText('No Identity provider is connected yet.')).toBeInTheDocument();
    expect(screen.getByText(/No directory has synchronised yet/)).toBeInTheDocument();
    expect(screen.getByText('No directory groups to show.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Advanced' })).toHaveAttribute('href', '/settings/access-manager');
  });

  test('a session the root-ceilinged reads refuse sees those sections ABSENT, never an error', async () => {
    replies = {
      '/principals/me/lenses': { status: 200, body: { lenses: ['member'], admin: false } },
      '/identity-providers': { status: 403, body: { error: 'Forbidden' } },
      '/groups/directory-sync': { status: 403, body: { error: 'Forbidden' } },
      '/directory-group-references': { status: 200, body: { success: true, references: [] } },
    };
    renderPage();
    expect(await screen.findByText('No directory groups to show.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Identity providers' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sync health' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('a stale directory is named as stale', async () => {
    populated();
    replies['/groups/directory-sync'] = { status: 200, body: { success: true, providers: [{ provider: 'idp-1', lastSuccessAt: null, lastErrorPresent: true, stalenessThresholdHours: 24, stale: true }] } };
    renderPage();
    expect(await screen.findByText('Stale (over 24 h)')).toBeInTheDocument();
    expect(screen.getByText('Last attempt failed')).toBeInTheDocument();
  });
});
