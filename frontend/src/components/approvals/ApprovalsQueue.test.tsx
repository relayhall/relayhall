// @vitest-environment jsdom
/**
 * The extracted approval queue and its two mounts (card b1e3b16d, lane L1;
 * design B.1, T8–T11).
 *
 * Both PAGES are rendered, not the component on its own: the claim is that the
 * Access manager panel and the hub at `/approvals` show the same list from the
 * same component, so the evidence is the two real pages side by side. Then the
 * hub's own behaviour: `?approval=<id>` opens the item's drawer with the
 * approval's own ledger from `GET /approvals/:id`, a 404 is rendered as "no such
 * approval" (concealment), and `?status=` is URL state. The Access manager's
 * published deep link keeps its old behaviour — expand and mark in place, no
 * drawer — which its own suite pins too.
 *
 * Owner E84 (card e2dd52b8 Part A): the notification centre's Approvals tab is
 * a third mount of the same hub, so the drawer cases run there too —
 * `?tab=approvals&approval=<id>` lands on the item exactly as
 * `/approvals?approval=<id>` does.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const useMyPrincipal = vi.fn();
const usePrincipals = vi.fn();
vi.mock('../../hooks/usePrincipals', () => ({
  useMyPrincipal: () => useMyPrincipal(),
  usePrincipals: () => usePrincipals(),
}));

type Reply = { status: number; body: unknown };
const calls: string[] = [];
let listReply: (url: string) => Reply;
let itemReply: (id: string) => Reply;

vi.mock('../../utils/auth', () => ({
  authenticatedFetch: vi.fn(async (url: string, init?: RequestInit) => {
    const text = String(url);
    calls.push(`${init?.method ?? 'GET'} ${text}`);
    let reply: Reply = { status: 200, body: { success: true } };
    const item = text.match(/\/approvals\/([^/?]+)$/);
    if (item) reply = itemReply(decodeURIComponent(item[1]));
    else if (/\/approvals(\?|$)/.test(text)) reply = listReply(text);
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
  }),
  auth: { getToken: () => 't', clearToken: () => {} },
}));

import { AccessManagerPage } from '../../pages/AccessManagerPage';
import { ApprovalsPage } from '../../pages/ApprovalsPage';
import { NotificationsPage } from '../../pages/NotificationsPage';

const PENDING_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const DECIDED_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function approval(id: string, status: string, handle: string, title: string) {
  return {
    id, status, requesterPrincipalId: `p-${handle}`, requesterHandle: handle,
    targetTaskId: `t-${id}`, targetTaskTitle: title, requestedScopes: ['tasks:read', 'tasks:write'],
    requestedRules: [], approvedScopes: null, lapseReason: null, denialReason: null,
    requestedAt: '2026-10-09T10:00:00.000Z', pendingExpiresAt: '2026-10-10T10:00:00.000Z', collectExpiresAt: null,
  };
}

const PENDING = [
  approval(PENDING_ID, 'pending', 'conn-alpha', 'Fix the flux'),
  approval('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'pending', 'conn-beta', 'Tune the relay'),
];
const DECIDED = [approval(DECIDED_ID, 'denied', 'conn-gamma', 'Old request')];

const EVENTS = [
  { id: 3, occurredAt: '2026-10-09T12:00:00.000Z', approvalId: PENDING_ID, action: 'approval.denied', actorPrincipalId: 'p-root', actorHandle: 'root', metadata: { reason: 'too broad' } },
  { id: 1, occurredAt: '2026-10-09T10:00:00.000Z', approvalId: PENDING_ID, action: 'approval.requested', actorPrincipalId: 'p-conn-alpha', actorHandle: 'conn-alpha', metadata: {} },
];

let location = '';
function LocationProbe() {
  const current = useLocation();
  location = `${current.pathname}${current.search}`;
  return null;
}

function renderAt(entry: string, page: 'hub' | 'access-manager' | 'tab') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      {page === 'hub' ? <ApprovalsPage /> : page === 'tab' ? <NotificationsPage /> : <AccessManagerPage />}
      <LocationProbe />
    </MemoryRouter>,
  );
}

const titles = (root: HTMLElement) =>
  [...root.querySelectorAll('.axm-item-title')].map((node) => node.textContent);

beforeEach(() => {
  calls.length = 0;
  location = '';
  useMyPrincipal.mockReturnValue({ me: { id: 'p-root', role: 'orchestrator', handle: 'root' }, scopes: ['root'], loading: false });
  usePrincipals.mockReturnValue({ principals: [] });
  listReply = (url) => ({
    status: 200,
    body: { success: true, approvals: url.includes('status=pending') ? PENDING : [...PENDING, ...DECIDED] },
  });
  itemReply = (id) => (id === PENDING_ID
    ? { status: 200, body: { success: true, approval: PENDING[0], events: EVENTS } }
    : { status: 404, body: { error: 'Refused', code: 'APPROVAL_NOT_FOUND', message: 'No such approval' } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('one queue, two mounts', () => {
  test('the Access manager panel and the hub render the same list, in the same order', async () => {
    const panel = renderAt('/settings/access-manager', 'access-manager');
    await screen.findByText('conn-beta');
    const fromPanel = titles(panel.container);
    const panelCalls = [...calls];
    cleanup();
    calls.length = 0;
    const hub = renderAt('/approvals', 'hub');
    await screen.findByText('conn-beta');
    const fromHub = titles(hub.container);
    expect(fromPanel).toEqual([
      'conn-alphawants an agent on “Fix the flux”',
      'conn-betawants an agent on “Tune the relay”',
    ]);
    expect(fromHub).toEqual(fromPanel);
    // both asked the same self-scoped list: the panel its own question, the
    // hub the same list through the hub view (card b1e3b16d)
    expect(panelCalls).toContain('GET /api/approvals?status=pending');
    expect(calls).toContain('GET /api/approvals?view=hub&status=pending');
  });

  test('the panel keeps its heading and its own filter, and links into the hub', async () => {
    renderAt('/settings/access-manager', 'access-manager');
    expect(await screen.findByRole('heading', { name: /Pending approvals/ })).toBeInTheDocument();
    const queue = screen.getByRole('region', { name: /Pending approvals/ });
    expect(within(queue).getByRole('combobox')).toHaveValue('pending');
    expect(screen.getByRole('link', { name: 'Open in approvals hub' })).toHaveAttribute('href', '/approvals');
    expect(screen.queryByRole('button', { name: /^History/ })).not.toBeInTheDocument();
  });

  test('the panel deep link still expands and marks in place, opens no drawer, and carries the id into the hub', async () => {
    renderAt(`/settings/access-manager?approval=${PENDING_ID}`, 'access-manager');
    const item = (await screen.findByText('conn-alpha')).closest('li');
    expect(item).toHaveClass('axm-item--linked');
    expect(await screen.findByText('tasks:write')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(calls.some((call) => call.endsWith(`/approvals/${PENDING_ID}`))).toBe(false);
    expect(screen.getByRole('link', { name: 'Open in approvals hub' }))
      .toHaveAttribute('href', `/approvals?approval=${PENDING_ID}`);
  });

  test.each(['access-manager', 'hub'] as const)('%s: a failed list read says so and never says "No pending"', async (page) => {
    listReply = () => ({ status: 500, body: { error: 'Internal Server Error', code: 'APPROVAL_LIST_FAILED', message: 'Failed to list approvals' } });
    renderAt(page === 'hub' ? '/approvals' : '/settings/access-manager', page);
    expect(await screen.findByText(/Couldn.t load approvals/)).toBeInTheDocument();
    expect(screen.queryByText(/No pending/)).not.toBeInTheDocument();
  });
});

describe('the hub drawer', () => {
  test('?approval=<id> opens the drawer with the approval\'s own ledger, newest first', async () => {
    renderAt(`/approvals?approval=${PENDING_ID}`, 'hub');
    const drawer = await screen.findByRole('dialog', { name: 'Approval history' });
    await within(drawer).findByText('Who did what');
    expect(calls).toContain(`GET /api/approvals/${PENDING_ID}`);
    const rows = within(drawer).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Denied');
    expect(rows[0]).toHaveTextContent('by root');
    expect(rows[1]).toHaveTextContent('Requested');
    expect(rows[1]).toHaveTextContent('by conn-alpha');
    expect(within(drawer).getByRole('link', { name: 'Fix the flux' })).toHaveAttribute('href', `/tasks/t-${PENDING_ID}`);
    // the list behind it marks the same item
    expect(screen.getAllByText('conn-alpha')[0].closest('li')).toHaveClass('axm-item--linked');
  });

  test('History opens the drawer by URL and closing removes it from the URL', async () => {
    renderAt('/approvals', 'hub');
    await screen.findByText('conn-alpha');
    await userEvent.click(screen.getByRole('button', { name: 'History: conn-alpha, Fix the flux' }));
    expect(await screen.findByRole('dialog', { name: 'Approval history' })).toBeInTheDocument();
    expect(location).toBe(`/approvals?approval=${PENDING_ID}`);
    await userEvent.click(screen.getByRole('button', { name: 'Close approval history' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(location).toBe('/approvals');
  });

  test('Escape closes the drawer', async () => {
    renderAt(`/approvals?approval=${PENDING_ID}`, 'hub');
    const drawer = await screen.findByRole('dialog', { name: 'Approval history' });
    await within(drawer).findByText('Who did what');
    drawer.focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(location).toBe('/approvals');
  });

  test('a concealed or unknown id reads as "No such approval." and hints nothing else', async () => {
    renderAt('/approvals?approval=99999999-9999-4999-8999-999999999999', 'hub');
    const drawer = await screen.findByRole('dialog', { name: 'Approval history' });
    expect(await within(drawer).findByText('No such approval.')).toBeInTheDocument();
    expect(within(drawer).queryByText('Who did what')).not.toBeInTheDocument();
  });

  test('a failed read offers Retry, which reads again', async () => {
    let failures = 1;
    itemReply = () => (failures-- > 0
      ? { status: 500, body: { error: 'Internal Server Error' } }
      : { status: 200, body: { success: true, approval: PENDING[0], events: EVENTS } });
    renderAt(`/approvals?approval=${PENDING_ID}`, 'hub');
    const drawer = await screen.findByRole('dialog', { name: 'Approval history' });
    expect(await within(drawer).findByText(/Couldn.t load this approval/)).toBeInTheDocument();
    await userEvent.click(within(drawer).getByRole('button', { name: 'Retry' }));
    expect(await within(drawer).findByText('Who did what')).toBeInTheDocument();
  });
});

describe('the same drawer on the notification centre\'s Approvals tab (owner E84, card e2dd52b8 Part A)', () => {
  const TAB = '/notifications?tab=approvals';

  test('?tab=approvals&approval=<id> opens the item\'s drawer with its own ledger, and the list marks the item', async () => {
    renderAt(`${TAB}&approval=${PENDING_ID}`, 'tab');
    const panel = screen.getByRole('tabpanel', { name: 'Approvals' });
    const drawer = await screen.findByRole('dialog', { name: 'Approval history' });
    await within(drawer).findByText('Who did what');
    expect(calls).toContain(`GET /api/approvals/${PENDING_ID}`);
    const rows = within(drawer).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Denied');
    expect(rows[1]).toHaveTextContent('Requested');
    expect(within(drawer).getByRole('link', { name: 'Fix the flux' })).toHaveAttribute('href', `/tasks/t-${PENDING_ID}`);
    expect(within(panel).getAllByText('conn-alpha')[0].closest('li')).toHaveClass('axm-item--linked');
  });

  test('History opens the drawer by URL on the tab, and closing removes only the approval', async () => {
    renderAt(TAB, 'tab');
    await screen.findByText('conn-alpha');
    await userEvent.click(screen.getByRole('button', { name: 'History: conn-alpha, Fix the flux' }));
    expect(await screen.findByRole('dialog', { name: 'Approval history' })).toBeInTheDocument();
    expect(location).toBe(`${TAB}&approval=${PENDING_ID}`);
    await userEvent.click(screen.getByRole('button', { name: 'Close approval history' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(location).toBe(TAB);
  });

  test('a concealed or unknown id reads as "No such approval." on the tab too', async () => {
    renderAt(`${TAB}&approval=99999999-9999-4999-8999-999999999999`, 'tab');
    const drawer = await screen.findByRole('dialog', { name: 'Approval history' });
    expect(await within(drawer).findByText('No such approval.')).toBeInTheDocument();
    expect(within(drawer).queryByText('Who did what')).not.toBeInTheDocument();
  });

  test('the tab lists what the hub page lists, from the same read', async () => {
    const page = renderAt('/approvals', 'hub');
    await screen.findByText('conn-beta');
    const fromPage = titles(page.container);
    cleanup();
    calls.length = 0;
    const tab = renderAt(TAB, 'tab');
    await screen.findByText('conn-beta');
    expect(titles(tab.container)).toEqual(fromPage);
    expect(calls).toContain('GET /api/approvals?view=hub&status=pending');
  });
});

describe('the hub\'s status filter is URL state', () => {
  test('pending by default, asked of the server', async () => {
    renderAt('/approvals', 'hub');
    await screen.findByText('conn-alpha');
    expect(screen.getByRole('radio', { name: 'Pending' })).toHaveAttribute('aria-checked', 'true');
    expect(calls).toContain('GET /api/approvals?view=hub&status=pending');
  });

  test('?status=decided lists only decided items', async () => {
    renderAt('/approvals?status=decided', 'hub');
    expect(await screen.findByText('conn-gamma')).toBeInTheDocument();
    expect(screen.queryByText('conn-alpha')).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Decided' })).toHaveAttribute('aria-checked', 'true');
  });

  test('choosing All writes ?status=all and lists every state', async () => {
    renderAt('/approvals', 'hub');
    await screen.findByText('conn-alpha');
    await userEvent.click(screen.getByRole('radio', { name: 'All' }));
    expect(location).toBe('/approvals?status=all');
    expect(await screen.findByText('conn-gamma')).toBeInTheDocument();
    expect(screen.getByText('conn-alpha')).toBeInTheDocument();
  });
});
