// @vitest-environment jsdom
/**
 * GroupStewardsPanel - LENSES-c c1-A (card 46cfbd1d), the Access manager's
 * Group roles sub-panel. What these pin:
 *  - every reader sees role, holder and the live/inert flag with the reason,
 *    as the server derived it (the panel never decides liveness);
 *  - appoint and remove are offered to a ROOT session only; any other reader
 *    gets the list and nothing to press, and no write request ever leaves;
 *  - appoint sends exactly {accountPrincipalId, role}; remove confirms first
 *    and sends a bodiless DELETE; neither sends a step-up (none on this path);
 *  - a refusal is surfaced verbatim with its code;
 *  - the appointed instant goes through the house date formatter;
 *  - both states are axe-clean, and the controls are reachable by keyboard.
 */
import '@testing-library/jest-dom/vitest';
import axe from 'axe-core';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Principal } from '../../types/task';
import { formatDateTime } from '../../utils/dateFormat';

const GROUP = '0b7a5ff6-3c1d-4c21-9a4f-1f1f1f1f1f1f';
const ADA = '7c0e4a3e-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const BO = '11111111-2222-4333-8444-555555555555';
const CY = '22222222-3333-4444-8555-666666666666';
const APPOINTED_AT = '2026-10-14T09:30:00.000Z';

interface Call { url: string; method: string; body: unknown }
const calls: Call[] = [];
let refusal: { status: number; body: unknown } | null = null;

const STEWARDS = [
  { accountPrincipalId: ADA, handle: 'ada', kind: 'human', status: 'active', role: 'owner',
    appointedByPrincipalId: CY, appointedAt: APPOINTED_AT, live: true, inertReason: null },
  { accountPrincipalId: BO, handle: 'bo', kind: 'human', status: 'active', role: 'manager',
    appointedByPrincipalId: CY, appointedAt: APPOINTED_AT, live: false, inertReason: 'not_a_member' },
];

vi.mock('../../utils/auth', () => ({
  authenticatedFetch: vi.fn(async (url: string, options?: RequestInit) => {
    const method = options?.method ?? 'GET';
    calls.push({ url, method, body: options?.body ? JSON.parse(String(options.body)) : undefined });
    const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (method !== 'GET' && refusal) return ok(refusal.body, refusal.status);
    if (url.endsWith('/groups')) return ok({ success: true, groups: [{ id: GROUP, name: 'Engineering' }] });
    if (url.endsWith(`/groups/${GROUP}/stewards`) && method === 'GET') return ok({ success: true, stewards: STEWARDS });
    if (url.endsWith(`/groups/${GROUP}/stewards`) && method === 'POST') {
      return ok({ success: true, steward: { ...STEWARDS[0], accountPrincipalId: CY, handle: 'cy', role: 'manager',
        live: false, inertReason: 'not_a_member' } }, 201);
    }
    if (method === 'DELETE') return ok({ success: true, removed: { accountPrincipalId: BO, role: 'manager' } });
    return ok({ success: true });
  }),
}));

import { GroupStewardsPanel } from './GroupStewardsPanel';

const principals: Principal[] = [
  { id: ADA, kind: 'human', handle: 'ada', status: 'active', role: 'editor' } as Principal,
  { id: BO, kind: 'human', handle: 'bo', status: 'active', role: 'editor' } as Principal,
  { id: CY, kind: 'human', handle: 'cy', status: 'active', role: 'user' } as Principal,
  { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', kind: 'human', handle: 'root-admin', status: 'active', role: 'admin' } as Principal,
  { id: 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff', kind: 'agent', handle: 'an-agent', status: 'active', role: 'agent' } as Principal,
  { id: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000000', kind: 'service', handle: 'a-connector', status: 'active', role: 'user',
    parentPrincipalId: ADA } as Principal,
];

const surface = vi.fn();

async function auditOf(root: Element): Promise<string> {
  const results = await axe.run(root, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
  return results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`).join('\n');
}

async function openGroup(): Promise<HTMLElement> {
  const picker = await screen.findByLabelText('Group');
  await userEvent.selectOptions(picker, GROUP);
  return screen.findByRole('table', { name: 'Group roles in Engineering' });
}

beforeEach(() => { calls.length = 0; refusal = null; surface.mockReset(); });
afterEach(() => { cleanup(); });

describe('GroupStewardsPanel', () => {
  test('a non-root reader sees role, holder and the live or inert flag with its reason, and nothing to press', async () => {
    const { container } = render(<main><GroupStewardsPanel isRoot={false} principals={principals} surface={surface} /></main>);
    const table = await openGroup();
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('ada');
    expect(rows[1]).toHaveTextContent('owner');
    expect(within(rows[1]).getByText('Live')).toBeInTheDocument();
    expect(rows[2]).toHaveTextContent('manager');
    expect(within(rows[2]).getByText('Inert')).toHaveClass('axm-badge--warn');
    expect(rows[2]).toHaveTextContent('The holder is not a member of this Group.');
    expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Appoint a Group role' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Root only')).toHaveLength(2);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    expect(await auditOf(container)).toBe('');
  });

  test('the appointed instant is rendered by the house formatter', async () => {
    render(<GroupStewardsPanel isRoot={false} principals={principals} surface={surface} />);
    const table = await openGroup();
    expect(within(table).getAllByText(formatDateTime(APPOINTED_AT))).toHaveLength(2);
  });

  test('each inert reason reads as words, never only as a code', async () => {
    const { INERT_REASON_TEXT } = await import('./GroupStewardsPanel');
    expect(Object.keys(INERT_REASON_TEXT).sort()).toEqual(['elevated_role', 'not_a_member', 'principal_inactive']);
  });

  test('root appoints with exactly {accountPrincipalId, role} and no step-up; the form offers only eligible Accounts', async () => {
    const { container } = render(<main><GroupStewardsPanel isRoot principals={principals} surface={surface} /></main>);
    await openGroup();
    const form = await screen.findByRole('form', { name: 'Appoint a Group role' });
    const account = within(form).getByLabelText('Account');
    const offered = within(account).getAllByRole('option').map((option) => option.getAttribute('value')).filter(Boolean);
    // ada and bo already hold a role; the admin, the agent and the parented Connector are not offered.
    expect(offered).toEqual([CY]);
    expect(await auditOf(container)).toBe('');
    await userEvent.selectOptions(account, CY);
    await userEvent.selectOptions(within(form).getByLabelText('Role'), 'manager');
    await userEvent.click(within(form).getByRole('button', { name: 'Appoint' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.url).toMatch(new RegExp(`/groups/${GROUP}/stewards$`));
    expect(post.body).toEqual({ accountPrincipalId: CY, role: 'manager' });
    await waitFor(() => expect(surface).toHaveBeenCalledWith('notice', expect.stringContaining('inert until its holder qualifies')));
  });

  test('root removes only after confirming, with a bodiless DELETE', async () => {
    render(<GroupStewardsPanel isRoot principals={principals} surface={surface} />);
    await openGroup();
    await userEvent.click(screen.getByRole('button', { name: 'Remove the manager role of bo' }));
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove role' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true));
    const del = calls.find((call) => call.method === 'DELETE')!;
    expect(del.url).toMatch(new RegExp(`/groups/${GROUP}/stewards/${BO}$`));
    expect(del.body).toBeUndefined();
  });

  test('cancelling the confirmation sends nothing', async () => {
    render(<GroupStewardsPanel isRoot principals={principals} surface={surface} />);
    await openGroup();
    await userEvent.click(screen.getByRole('button', { name: 'Remove the owner role of ada' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  test('a refusal is surfaced verbatim with its code', async () => {
    refusal = { status: 403, body: { success: false, code: 'REQUIRES_LOGIN_SESSION', message: 'Appointing a Group role is a login-session act (AZ-18): bearer credentials never perform it.' } };
    render(<GroupStewardsPanel isRoot principals={principals} surface={surface} />);
    await openGroup();
    const form = await screen.findByRole('form', { name: 'Appoint a Group role' });
    await userEvent.selectOptions(within(form).getByLabelText('Account'), CY);
    await userEvent.selectOptions(within(form).getByLabelText('Role'), 'owner');
    await userEvent.click(within(form).getByRole('button', { name: 'Appoint' }));
    await waitFor(() => expect(surface).toHaveBeenCalledWith('error',
      'Appointing a Group role is a login-session act (AZ-18): bearer credentials never perform it. (REQUIRES_LOGIN_SESSION)'));
  });

  test('the controls are reachable by keyboard', async () => {
    render(<GroupStewardsPanel isRoot principals={principals} surface={surface} />);
    await screen.findByLabelText('Group');
    await userEvent.tab();
    expect(screen.getByLabelText('Group')).toHaveFocus();
    await userEvent.selectOptions(screen.getByLabelText('Group'), GROUP);
    await screen.findByRole('table', { name: 'Group roles in Engineering' });
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Remove the owner role of ada' })).toHaveFocus();
  });
});
