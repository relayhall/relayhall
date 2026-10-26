// @vitest-environment jsdom
/**
 * The admin lens's Groups page (RH-LENSES-d, card 4e159741; design 96f0bd3d
 * s8.4: "Groups (bindings, featured)"). The featured switch is offered to the
 * admin lens and decided by `PATCH /groups/{id}`; a refusal is shown in the
 * server's words and the row does not change.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let groups: Array<Record<string, unknown>> = [];
let admin = true;
let patchStatus = 200;
const patched: Array<{ url: string; body: unknown }> = [];

vi.mock('../utils/auth', () => ({
  auth: { getToken: () => 't', clearToken: () => {}, isAuthenticated: () => true },
  authenticatedFetch: vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^\/api/, '');
    if (path === '/principals/me/lenses') {
      return { ok: true, status: 200, json: async () => (admin ? { lenses: ['member', 'admin'], admin: true } : { lenses: ['member'], admin: false }) };
    }
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body));
      patched.push({ url: path, body });
      if (patchStatus !== 200) {
        return { ok: false, status: patchStatus, json: async () => ({ success: false, message: 'The route requires the root scope' }) };
      }
      groups = groups.map((group) => (path.endsWith(String(group.id)) ? { ...group, featured: body.featured } : group));
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
    if (path === '/groups') return { ok: true, status: 200, json: async () => ({ success: true, groups }) };
    return { ok: false, status: 404, json: async () => ({}) };
  }),
}));

import { GroupsPage } from './GroupsPage';

const ENGINEERING = { id: 'g-1', name: 'Engineering', description: 'Builders', memberCount: 12, identityProviderId: 'idp-1', externalGroupRef: 'cn=engineering', featured: false };
const LOCAL = { id: 'g-2', name: 'Reviewers', description: '', memberCount: 2, identityProviderId: null, externalGroupRef: null, featured: true };

beforeEach(() => { groups = [ENGINEERING, LOCAL]; admin = true; patchStatus = 200; patched.length = 0; });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const renderPage = () => render(<MemoryRouter><GroupsPage /></MemoryRouter>);

describe('the group list', () => {
  test('every group with its members, its directory binding and its featured state', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: 'Every board group' });
    expect(within(table).getByText('cn=engineering')).toBeInTheDocument();
    expect(within(table).getByText('Local group')).toBeInTheDocument();
    expect(within(table).getByText('12')).toBeInTheDocument();
  });

  test('the admin lens features a group through PATCH /groups/{id}, and the list shows the server\'s answer', async () => {
    renderPage();
    const toggle = await screen.findByRole('checkbox', { name: /Not featured \(Engineering\)/ });
    await userEvent.click(toggle);
    await waitFor(() => expect(patched).toEqual([{ url: '/groups/g-1', body: { featured: true } }]));
    expect(await screen.findByRole('status')).toHaveTextContent('"Engineering" is now featured.');
    expect(await screen.findByRole('checkbox', { name: /Featured \(Engineering\)/ })).toBeChecked();
  });

  test('a refused change is shown in the server\'s words and the row does not change', async () => {
    patchStatus = 403;
    renderPage();
    await userEvent.click(await screen.findByRole('checkbox', { name: /Not featured \(Engineering\)/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The route requires the root scope');
    expect(screen.getByRole('checkbox', { name: /Not featured \(Engineering\)/ })).not.toBeChecked();
  });

  test('without the admin lens the switch is not offered; the state is read-only text', async () => {
    admin = false;
    renderPage();
    await screen.findByRole('table', { name: 'Every board group' });
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(screen.getByRole('row', { name: /Reviewers/ })).getByText('Featured')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /Engineering/ })).getByText('Not featured')).toBeInTheDocument();
  });
});

describe('the designed empty state', () => {
  test('no groups yet: start from the Directory', async () => {
    groups = [];
    renderPage();
    expect(await screen.findByText('No groups yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Directory' })).toHaveAttribute('href', '/directory');
  });
});
