// @vitest-environment jsdom
/**
 * The manager lens's My team page (LENSES-c c1-B, card b5c83682; design delta
 * C.8, LENSES v7 s8.4 "My team"). Each Group the server lists in the lens
 * answer is shown with its roles, members and team grants; an OWNER is offered
 * gate (iii) - appoint a manager from the members, remove a manager row -
 * each sent with a fresh step-up for exactly (the act, the Group); a manager is
 * offered neither, and a refusal is shown in the board's words.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const GROUP_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MANAGER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

let role: 'owner' | 'manager' = 'owner';
let lensRows: unknown[] = [];
let actStatus = 201;
const acts: Array<{ method: string; path: string; body: any }> = [];
const proofs: Array<{ action: string; targetId: string }> = [];

vi.mock('../utils/auth', () => ({
  auth: { getToken: () => 't', clearToken: () => {}, isAuthenticated: () => true },
  authenticatedFetch: vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^\/api/, '');
    const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    if (path === '/principals/me/lenses') {
      return reply(200, lensRows.length > 0
        ? { lenses: ['member', 'manager'], admin: false, manager: { stewardedGroups: lensRows } }
        : { lenses: ['member'], admin: false });
    }
    if (path === '/auth/step-up/methods') return reply(200, { success: true, methods: ['password'], preferred: 'password' });
    if (path === '/auth/step-up') {
      proofs.push(JSON.parse(String(init?.body)));
      return reply(200, { success: true, stepUpToken: `rhsu_team_${proofs.length}` });
    }
    if (init?.method === 'POST' || init?.method === 'DELETE') {
      acts.push({ method: init.method, path, body: JSON.parse(String(init.body)) });
      if (actStatus >= 400) return reply(actStatus, { success: false, code: 'MANAGER_NOT_A_GROUP_MEMBER', message: 'That Account is not an active member' });
      return reply(actStatus, { success: true });
    }
    if (path === `/groups/${GROUP_ID}/members`) {
      return reply(200, { success: true, members: [
        { accountPrincipalId: OWNER_ID, handle: 'olivia', kind: 'human', status: 'active', source: 'local' },
        { accountPrincipalId: MANAGER_ID, handle: 'marco', kind: 'human', status: 'active', source: 'directory' },
        { accountPrincipalId: MEMBER_ID, handle: 'mia', kind: 'human', status: 'active', source: 'local' },
      ] });
    }
    if (path === `/groups/${GROUP_ID}/stewards`) {
      return reply(200, { success: true, stewards: [
        { accountPrincipalId: OWNER_ID, handle: 'olivia', role: 'owner', live: true, inertReason: null },
        { accountPrincipalId: MANAGER_ID, handle: 'marco', role: 'manager', live: false, inertReason: 'not_a_member' },
      ] });
    }
    if (path === `/groups/${GROUP_ID}/grants`) {
      return reply(200, { success: true, grants: [{ id: 'g1', resourceType: 'project', resourceId: null, verb: 'read', expiresAt: null }] });
    }
    return reply(404, {});
  }),
}));

import { TeamPage } from './TeamPage';

beforeEach(() => {
  role = 'owner';
  lensRows = [{ id: GROUP_ID, name: 'Platform', memberCount: 3, featured: true, role }];
  actStatus = 201;
  acts.length = 0;
  proofs.length = 0;
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const renderPage = () => render(<MemoryRouter><TeamPage /></MemoryRouter>);

async function confirmInDialog() {
  const dialog = within(await screen.findByRole('dialog'));
  await userEvent.type(await dialog.findByLabelText('Password'), 'test-password');
  await userEvent.click(dialog.getByRole('button', { name: 'Continue' }));
}

describe('the groups the lens lists', () => {
  test('each group with its roles (and the inert flag), its members and its team grants', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: /Platform/ })).toBeInTheDocument();
    const roles = await screen.findByRole('table', { name: 'Roles in Platform' });
    expect(within(roles).getByText('Inactive: not a member')).toBeInTheDocument();
    expect(within(await screen.findByRole('table', { name: 'Members of Platform' })).getByText('mia')).toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: 'What Platform is granted' })).getByText('Every project')).toBeInTheDocument();
  });

  test('a caller with no live role sees the empty state and no group', async () => {
    lensRows = [];
    renderPage();
    expect(await screen.findByText('You hold no role in a group.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('gate (iii): an owner appoints and removes managers, with a step-up', () => {
  test('appointing a member mints a step-up for (group.manager_appoint, the group) and sends it with the appointee', async () => {
    renderPage();
    const select = await screen.findByLabelText('Member');
    // A member who already holds a role is not offered.
    expect(within(select).queryByText('marco')).not.toBeInTheDocument();
    await userEvent.selectOptions(select, MEMBER_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Appoint manager' }));
    await confirmInDialog();
    await waitFor(() => expect(acts).toHaveLength(1));
    expect(proofs[0]).toMatchObject({ action: 'group.manager_appoint', targetId: GROUP_ID });
    expect(acts[0]).toEqual({ method: 'POST', path: `/groups/${GROUP_ID}/managers`, body: { accountPrincipalId: MEMBER_ID, stepUpToken: 'rhsu_team_1' } });
    expect(await screen.findByRole('status')).toHaveTextContent('mia is now a manager of Platform.');
  });

  test('removing a manager row mints a step-up for (group.manager_remove, the group)', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Remove marco as a manager of Platform' }));
    await confirmInDialog();
    await waitFor(() => expect(acts).toHaveLength(1));
    expect(proofs[0]).toMatchObject({ action: 'group.manager_remove', targetId: GROUP_ID });
    expect(acts[0]).toEqual({ method: 'DELETE', path: `/groups/${GROUP_ID}/managers/${MANAGER_ID}`, body: { stepUpToken: 'rhsu_team_1' } });
  });

  test('the owner row is never offered for removal', async () => {
    renderPage();
    await screen.findByRole('table', { name: 'Roles in Platform' });
    expect(screen.queryByRole('button', { name: /Remove olivia/ })).not.toBeInTheDocument();
  });

  test("a refusal is shown in the board's words, and nothing else is claimed", async () => {
    actStatus = 422;
    renderPage();
    await userEvent.selectOptions(await screen.findByLabelText('Member'), MEMBER_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Appoint manager' }));
    await confirmInDialog();
    expect(await screen.findByRole('alert')).toHaveTextContent('That Account is not an active member');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('a manager is offered neither act', async () => {
    role = 'manager';
    lensRows = [{ id: GROUP_ID, name: 'Platform', memberCount: 3, featured: false, role }];
    renderPage();
    await screen.findByRole('table', { name: 'Roles in Platform' });
    expect(screen.queryByLabelText('Member')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
    expect(acts).toEqual([]);
  });
});
