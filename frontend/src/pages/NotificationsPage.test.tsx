// @vitest-environment jsdom
/**
 * The ACTION CENTER (`/action-center`; owner rulings E453 and E455), which is
 * the notification centre of Slice B of the Notifications and Timeline design
 * (card 5854f0d6; owner ruling E394) renamed, with Agent sessions as a fifth
 * tab and a seen mark on action items. `/notifications` and `/sessions` are
 * aliases that replace themselves with it, keeping their query.
 *
 * The Notifications tab is "Needs your action" (`GET /notifications/actions`):
 * only the open items that wait on you, grouped Decisions, Verify, Stuck,
 * Skill reviews (design section 3.2), the longest-waiting first inside each,
 * each saying how long it has waited and linking to where the act is done. No
 * dismiss (choice C2); an item can be marked seen (E455) and stays listed,
 * shown as seen; a capped kind said as a floor, an error that is never an
 * empty list. The page no longer reads the retired history
 * (`/tasks/notifications*`), and the dead "not applied" deferred-filter note
 * is gone.
 *
 * The five-tab tablist (owner E84; card 502fb19e S3; Agent sessions, E453) is
 * pinned here: roles, roving tabindex, arrow keys, `?tab=` round-trips, the
 * document title, and which parameters a tab switch drops. The Timeline tab's own
 * behaviour is pinned in `components/notifications/TimelinePanel.test.tsx`.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../utils/auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
const useMyPrincipal = vi.fn();
vi.mock('../hooks/usePrincipals', () => ({
  useMyPrincipal: () => useMyPrincipal(),
  usePrincipals: () => ({ principals: [] }),
}));

import {
  ACTION_CENTER_PATH, ActionCenterAlias, NotificationsPage, actionCenterAliasTarget, notificationsTab, notificationsTitle,
} from './NotificationsPage';
import type { ActionItem } from '../components/notifications/notifications';

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();

const ITEMS: ActionItem[] = [
  { key: 'decision:d-old', kind: 'decision', reasons: ['grant'], since: hoursAgo(50),
    object: { type: 'approval', id: 'd-old', title: 'Fix the flux' }, project: { id: 'pr-1', name: 'Relay project' },
    href: '/notifications?tab=approvals&approval=d-old', detail: { approvalKind: 'grant', requesterHandle: 'conn-alpha' } },
  { key: 'decision:d-new', kind: 'decision', reasons: ['agent-mint'], since: hoursAgo(2),
    object: { type: 'approval', id: 'd-new', title: null }, project: null,
    href: '/notifications?tab=approvals&approval=d-new', detail: { approvalKind: 'agent-mint', requesterHandle: null } },
  { key: 'verify:t-v', kind: 'verify', reasons: ['verifier', 'no-verifier'], since: hoursAgo(5),
    object: { type: 'task', id: 't-v', title: 'Check the relay' }, project: { id: 'pr-1', name: null },
    href: '/tasks/t-v', detail: {} },
  { key: 'stuck:t-s', kind: 'stuck', reasons: ['episode'], since: hoursAgo(1),
    object: { type: 'task', id: 't-s', title: 'Stalled export' }, project: null,
    href: '/tasks/t-s', detail: { reason: 'lease_expired' } },
  { key: 'stuck:t-s2', kind: 'stuck', reasons: ['status'], since: new Date(Date.now() - 20 * 60_000).toISOString(),
    object: { type: 'task', id: 't-s2', title: 'Blocked import' }, project: null, href: '/tasks/t-s2', detail: {} },
  { key: 'skill:sk-1', kind: 'skill', reasons: ['skill-publish'], since: hoursAgo(26),
    object: { type: 'skill', id: 'sk-1', title: 'terraform-review' }, project: null,
    href: '/skills?skill=sk-1', detail: { versionId: 'v-3', version: 3, requesterHandle: 'editor-one' } },
];

let items: ActionItem[];
let actionsStatus: number;
let capped: Partial<Record<ActionItem['kind'], boolean>>;
let location = '';
let seenPosts: unknown[] = [];

function LocationProbe() {
  const current = useLocation();
  location = `${current.pathname}${current.search}`;
  return null;
}

const renderAt = (entry: string) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[entry]}><NotificationsPage /><LocationProbe /></MemoryRouter>
  </QueryClientProvider>,
);
const gets = () => fetchMock.mock.calls.filter(([, init]) => !init?.method).map(([url]) => String(url));

beforeEach(() => {
  items = ITEMS.map((item) => ({ ...item }));
  actionsStatus = 200;
  capped = {};
  fetchMock.mockReset();
  seenPosts = [];
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const text = String(url);
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    const answer = () => {
      const count = (kind: string) => items.filter((item) => item.kind === kind).length;
      return {
        success: true, items,
        counts: {
          decision: count('decision'), verify: count('verify'), stuck: count('stuck'), skill: count('skill'), total: items.length,
          unseen: items.filter((item) => !item.seen).length,
        },
        capped: { decision: false, verify: false, stuck: false, skill: false, ...capped },
      };
    };
    if (text.includes('/notifications/actions/seen') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { keys?: string[]; all?: boolean };
      seenPosts.push(body);
      const marked = items.filter((item) => body.all === true || body.keys?.includes(item.key));
      for (const item of marked) item.seen = true;
      return ok({ ...answer(), marked: marked.length });
    }
    if (text.includes('/notifications/actions')) {
      if (actionsStatus !== 200) return { ok: false, status: actionsStatus, json: async () => ({ code: 'X' }) };
      return ok(answer());
    }
    if (text.includes('/telemetry/presence')) return ok({ success: true, sources: [] });
    if (text.includes('/telemetry/sessions')) return ok({ success: true, sessions: [], total: 0, hiddenCount: 0, shortCount: 0, nextOffset: null });
    if (text.includes('/notifications/timeline')) return ok({ success: true, items: [], nextCursor: null, hasMore: false, headCursor: { feed: null, approvals: null, skills: null }, lastSeen: null });
    if (/\/approvals\/[^/?]+$/.test(text)) return { ok: false, status: 404, json: async () => ({ code: 'APPROVAL_NOT_FOUND' }) };
    if (text.includes('/approvals')) return ok({ success: true, approvals: [] });
    if (text.includes('/projects')) return ok({ success: true, projects: [] });
    return ok({ success: true });
  });
  useMyPrincipal.mockReturnValue({ me: { id: 'p1', handle: 'owner-account' }, scopes: ['tasks:read'], loading: false });
});
afterEach(() => { cleanup(); });

describe('the Notifications tab is "Needs your action"', () => {
  test('reads /notifications/actions and nothing of the retired history', async () => {
    renderAt('/action-center');
    expect(await screen.findByText('Fix the flux')).toBeInTheDocument();
    expect(gets()).toContain('/api/notifications/actions');
    expect(gets().some((url) => url.includes('/tasks/notifications'))).toBe(false);
    expect(screen.getByRole('region', { name: 'Needs your action' })).toBeInTheDocument();
  });

  test('grouped Decisions, Verify, Stuck, Skill reviews, each with its count, in the server\'s order inside a group', async () => {
    renderAt('/action-center');
    await screen.findByText('Fix the flux');
    const panel = screen.getByRole('region', { name: 'Needs your action' });
    const groups = within(panel).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
    expect(groups).toEqual(['Decisions (2)', 'Verify (1)', 'Stuck (2)', 'Skill reviews (1)']);
    const decisions = within(screen.getByRole('region', { name: 'Decisions (2)' })).getAllByRole('listitem');
    // the longest-waiting first, as the server sends them (no client re-sort)
    expect(decisions.map((row) => within(row).getByRole('link').textContent)).toEqual(['Fix the flux', 'Agent mint']);
    const stuck = within(screen.getByRole('region', { name: 'Stuck (2)' })).getAllByRole('listitem');
    expect(stuck.map((row) => within(row).getByRole('link').textContent)).toEqual(['Stalled export', 'Blocked import']);
  });

  test('each row says why it waits on you, for how long, and links to where the act is done', async () => {
    renderAt('/action-center');
    await screen.findByText('Fix the flux');
    const row = (title: string) => screen.getByRole('link', { name: title }).closest('li')!;
    expect(within(row('Fix the flux')).getByText('Grant request from conn-alpha waits for your decision')).toBeInTheDocument();
    expect(within(row('Fix the flux')).getByText('Relay project')).toBeInTheDocument();
    expect(within(row('Fix the flux')).getByText('Waiting 2 d')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fix the flux' })).toHaveAttribute('href', '/notifications?tab=approvals&approval=d-old');
    expect(within(row('Agent mint')).getByText('Agent mint waits for your decision')).toBeInTheDocument();
    expect(within(row('Check the relay')).getByText(
      'In Review. You are its Verifier. It has no usable Verifier, so it waits on you as its account owner',
    )).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Check the relay' })).toHaveAttribute('href', '/tasks/t-v');
    expect(within(row('Stalled export')).getByText('Stuck: its lease expired')).toBeInTheDocument();
    expect(within(row('Blocked import')).getByText('Its status is Stuck')).toBeInTheDocument();
    expect(within(row('Blocked import')).getByText('Waiting 20 min')).toBeInTheDocument();
    expect(within(row('terraform-review')).getByText('Skill version 3 waits for review, submitted by editor-one')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'terraform-review' })).toHaveAttribute('href', '/skills?skill=sk-1');
    const time = within(row('Fix the flux')).getByText('Waiting 2 d');
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('dateTime', ITEMS[0].since);
  });

  test('no dismiss and no snooze: an item leaves only when it is resolved', async () => {
    renderAt('/action-center');
    await screen.findByText('Fix the flux');
    expect(screen.queryByRole('button', { name: /Dismiss|Snooze|Hide|Remove/ })).not.toBeInTheDocument();
    expect(screen.getByText(/An item leaves this list when it is resolved\. Marking it seen keeps it here and takes it off the bell\./))
      .toBeInTheDocument();
    expect(screen.getByText(/^6 need your action\./)).toBeInTheDocument();
  });

  test('a capped kind says it is a floor, with the count shown as "N+"', async () => {
    capped = { stuck: true };
    renderAt('/action-center');
    await screen.findByText('Fix the flux');
    const stuck = screen.getByRole('region', { name: 'Stuck (2+)' });
    expect(within(stuck).getByRole('note')).toHaveTextContent('Showing the 2 that have waited longest; more are waiting.');
    expect(screen.getByText(/^6\+ need your action\./)).toBeInTheDocument();
  });

  test('an empty list says nothing needs you and points at the Timeline', async () => {
    items = [];
    renderAt('/action-center');
    expect(await screen.findByText(/Nothing needs your action\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Timeline' })).toHaveAttribute('href', '/action-center?tab=timeline');
    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);
  });

  test('a failed read is an error with Retry — never "Nothing needs your action"', async () => {
    actionsStatus = 500;
    renderAt('/action-center');
    expect(await screen.findByText(/Couldn.t check what needs your action/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing needs your action/)).not.toBeInTheDocument();
    actionsStatus = 200;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Fix the flux')).toBeInTheDocument();
  });

  test('the deferred-filter warning is gone: an old link\'s project/phase/date params are not named as ignored', async () => {
    renderAt('/action-center?project=p1&phase=ph1&since=2026-10-01&until=2026-10-02');
    await screen.findByText('Fix the flux');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.queryByText(/not filtered by|do not record that yet/)).not.toBeInTheDocument();
  });
});

describe('five tabs: Notifications, Timeline, Approvals (owner E84, card e2dd52b8 Part A), My requests (card 502fb19e S3) and Agent sessions (E453)', () => {
  const tab = (name: string) => screen.getByRole('tab', { name });

  test('a tablist of five, the selected tab controls the one panel, and the panel is named by its tab', async () => {
    renderAt('/action-center');
    await screen.findByText('Fix the flux');
    const tablist = screen.getByRole('tablist', { name: 'Action Center view' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map((node) => node.textContent)).toEqual(['Notifications', 'Timeline', 'Approvals', 'My requests', 'Agent sessions']);
    expect(tabs.map((node) => node.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false', 'false']);
    expect(tabs.map((node) => node.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    const panel = screen.getByRole('tabpanel', { name: 'Notifications' });
    expect(tabs[0]).toHaveAttribute('aria-controls', panel.id);
    expect(tabs[1]).not.toHaveAttribute('aria-controls');
    expect(panel).toHaveAttribute('tabindex', '0');
    expect(within(panel).getByRole('region', { name: 'Needs your action' })).toBeInTheDocument();
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    expect(screen.queryByRole('radiogroup', { name: 'Action Center view' })).not.toBeInTheDocument();
  });

  test('?tab=timeline mounts the Timeline, which reads /notifications/timeline', async () => {
    renderAt('/action-center?tab=timeline');
    const panel = screen.getByRole('tabpanel', { name: 'Timeline' });
    expect(within(panel).getByRole('region', { name: 'Timeline' })).toBeInTheDocument();
    await waitFor(() => expect(gets().some((url) => url.startsWith('/api/notifications/timeline'))).toBe(true));
    expect(gets().some((url) => url.includes('/tasks/notifications'))).toBe(false);
  });

  test('?tab=approvals opens the Approvals tab on the hub', async () => {
    renderAt('/action-center?tab=approvals');
    const panel = screen.getByRole('tabpanel', { name: 'Approvals' });
    expect(tab('Approvals')).toHaveAttribute('aria-selected', 'true');
    expect(await within(panel).findByText('Nothing is waiting on you.')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 }).map((node) => node.textContent)).toEqual(['Action Center']);
    expect(gets()).toContain('/api/approvals?view=hub&status=pending');
  });

  test('ArrowRight/ArrowLeft and Home/End move focus AND select, wrapping; ArrowUp/ArrowDown stay the page\'s', async () => {
    renderAt('/action-center');
    await screen.findByText('Fix the flux');
    tab('Notifications').focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(location).toBe('/action-center?tab=timeline');
    expect(tab('Timeline')).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(location).toBe('/action-center?tab=approvals');
    await userEvent.keyboard('{ArrowRight}');
    expect(location).toBe('/action-center?tab=requests');
    await userEvent.keyboard('{ArrowRight}');
    expect(location).toBe('/action-center?tab=sessions');
    await userEvent.keyboard('{ArrowRight}');
    expect(location).toBe('/action-center');
    expect(tab('Notifications')).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(location).toBe('/action-center?tab=sessions');
    await userEvent.keyboard('{Home}');
    expect(location).toBe('/action-center');
    await userEvent.keyboard('{End}');
    expect(location).toBe('/action-center?tab=sessions');
    expect(fireEvent.keyDown(tab('Agent sessions'), { key: 'ArrowDown' })).toBe(true);
    expect(location).toBe('/action-center?tab=sessions');
  });

  test('the Timeline\'s filters live with the Timeline: leaving it drops them, coming back starts clean', async () => {
    renderAt('/action-center?tab=timeline&type=status,report&scope=mine&acl=1&since=2026-10-01');
    await waitFor(() => expect(gets().some((url) => url.startsWith('/api/notifications/timeline'))).toBe(true));
    await userEvent.click(tab('Notifications'));
    expect(location).toBe('/action-center');
    await userEvent.click(tab('Timeline'));
    expect(location).toBe('/action-center?tab=timeline');
  });

  test('crossing into Approvals drops the Timeline\'s filters and the retired history\'s; the hub\'s own writes keep the tab', async () => {
    renderAt('/action-center?tab=timeline&type=stuck&who=all&unread=1&project=11111111-1111-4111-8111-111111111111');
    await userEvent.click(tab('Approvals'));
    expect(location).toBe('/action-center?tab=approvals');
    await userEvent.click(await screen.findByRole('radio', { name: 'Decided' }));
    expect(location).toBe('/action-center?tab=approvals&status=decided');
  });

  test('leaving Approvals drops the hub\'s filters and its open drawer', async () => {
    renderAt('/action-center?tab=approvals&status=all&kind=grant&group=board&approval=99999999-9999-4999-8999-999999999999');
    expect(await screen.findByRole('dialog', { name: 'Approval history' })).toBeInTheDocument();
    await userEvent.click(tab('Timeline'));
    expect(location).toBe('/action-center?tab=timeline');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(tab('Approvals'));
    expect(location).toBe('/action-center?tab=approvals');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('the document title names the open tab, and the page puts the old title back when it goes', async () => {
    document.title = 'Before';
    const view = renderAt('/action-center?tab=approvals');
    expect(document.title).toBe('Approvals · Action Center · RelayHall');
    await userEvent.click(tab('Timeline'));
    expect(document.title).toBe('Timeline · Action Center · RelayHall');
    await userEvent.click(tab('Agent sessions'));
    expect(document.title).toBe('Agent sessions · Action Center · RelayHall');
    await userEvent.click(tab('Notifications'));
    expect(document.title).toBe('Action Center · RelayHall');
    view.unmount();
    expect(document.title).toBe('Before');
    expect(notificationsTitle('approvals', 'Acme Board')).toBe('Approvals · Action Center · Acme Board');
  });

  test('unknown ?tab= values fall back to the default', () => {
    expect(notificationsTab('timeline')).toBe('timeline');
    expect(notificationsTab('approvals')).toBe('approvals');
    expect(notificationsTab('requests')).toBe('requests');
    expect(notificationsTab('sessions')).toBe('sessions');
    expect(notificationsTab('Approvals')).toBe('notifications');
    expect(notificationsTab(null)).toBe('notifications');
  });
});

describe('the Action Center (E453): its name, its aliases and the Agent sessions tab', () => {
  test('the page is named Action Center, in its heading and its tablist', async () => {
    renderAt('/action-center');
    await screen.findByText('Fix the flux');
    expect(screen.getByRole('heading', { level: 1, name: 'Action Center' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Notifications' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Notifications' })).toBeInTheDocument();
    expect(ACTION_CENTER_PATH).toBe('/action-center');
  });

  test.each([
    ['/notifications', '/action-center'],
    ['/notifications?tab=approvals&approval=d-old#who', '/action-center?tab=approvals&approval=d-old#who'],
    ['/notifications?tab=timeline&type=status&q=relay', '/action-center?tab=timeline&type=status&q=relay'],
  ])('%s keeps working: it replaces itself with %s, query and fragment kept', async (from, to) => {
    let landed = '';
    function Probe() {
      const current = useLocation();
      landed = `${current.pathname}${current.search}${current.hash}`;
      return <span>landed</span>;
    }
    const [path] = from.split(/[?#]/);
    render(
      <MemoryRouter initialEntries={[from]}>
        <Routes>
          <Route path={path} element={<ActionCenterAlias from="notifications" />} />
          <Route path="/action-center" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('landed');
    expect(landed).toBe(to);
  });

  test.each([
    ['/sessions', '/action-center?tab=sessions'],
    ['/sessions?sessionRef=rhp_x&connectorId=c-1&sourceProduct=claude-code', '/action-center?tab=sessions&sessionRef=rhp_x&connectorId=c-1&sourceProduct=claude-code'],
    ['/sessions?tab=approvals&sessionRef=rhp_y', '/action-center?tab=sessions&sessionRef=rhp_y'],
  ])('the old Agent sessions path %s lands on its tab: %s', (from, to) => {
    const [path, rest = ''] = from.split('?');
    expect(path).toBe('/sessions');
    expect(actionCenterAliasTarget('sessions', { search: rest ? `?${rest}` : '', hash: '' })).toBe(to);
  });

  test('the Agent sessions tab shows the reported sessions under the Action Center heading, not a page of its own', async () => {
    renderAt('/action-center?tab=sessions');
    const panel = screen.getByRole('tabpanel', { name: 'Agent sessions' });
    expect(within(panel).getByRole('heading', { level: 2, name: 'Agent sessions' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 }).map((node) => node.textContent)).toEqual(['Action Center']);
    expect(await within(panel).findByText('No reported sessions.')).toBeInTheDocument();
  });

  test('a session link lands on the tab, and leaving the tab drops it', async () => {
    renderAt('/action-center?tab=sessions&sessionRef=rhp_x&connectorId=c-1&sourceProduct=claude-code');
    expect(screen.getByRole('tab', { name: 'Agent sessions' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('tab', { name: 'Timeline' }));
    expect(location).toBe('/action-center?tab=timeline');
    await userEvent.click(screen.getByRole('tab', { name: 'Agent sessions' }));
    expect(location).toBe('/action-center?tab=sessions');
  });
});

describe('the seen mark (E455): per item and all at once, kept on the list until resolved', () => {
  test('each unseen item offers "Mark seen"; marking one posts its key, and it stays listed, shown as seen', async () => {
    renderAt('/action-center');
    await screen.findByText('Fix the flux');
    expect(screen.getAllByRole('button', { name: /^Mark seen: / })).toHaveLength(6);
    await userEvent.click(screen.getByRole('button', { name: 'Mark seen: Fix the flux' }));
    await waitFor(() => expect(seenPosts).toEqual([{ keys: ['decision:d-old'] }]));
    const row = (await screen.findByRole('link', { name: 'Fix the flux' })).closest('li')!;
    await waitFor(() => expect(within(row).getByText('Seen')).toBeInTheDocument());
    expect(within(row).queryByRole('button', { name: /Mark seen/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Mark seen: / })).toHaveLength(5);
    expect(screen.getByText(/^6 need your action, 5 unseen\./)).toBeInTheDocument();
  });

  test('"Mark all seen" posts { all: true }; every item stays, each shown as seen, and the button leaves', async () => {
    renderAt('/action-center');
    await screen.findByText('Fix the flux');
    await userEvent.click(screen.getByRole('button', { name: 'Mark all seen' }));
    await waitFor(() => expect(seenPosts).toEqual([{ all: true }]));
    await waitFor(() => expect(screen.getAllByText('Seen')).toHaveLength(6));
    expect(screen.queryByRole('button', { name: 'Mark all seen' })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: /^Mark seen: / })).toHaveLength(0);
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(6);
  });

  test('a seen item from the server is drawn as seen, with no Mark seen of its own', async () => {
    items = ITEMS.map((item) => ({ ...item, seen: item.key === 'verify:t-v' }));
    renderAt('/action-center');
    const row = (await screen.findByRole('link', { name: 'Check the relay' })).closest('li')!;
    expect(row).toHaveClass('action-list-item--seen');
    expect(within(row).getByText('Seen')).toBeInTheDocument();
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
  });

  test('a failed mark says so and changes nothing', async () => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => (String(url).includes('/actions/seen')
      ? { ok: false, status: 500, json: async () => ({ code: 'NOTIFICATION_ACTIONS_SEEN_FAILED' }) } : base(url, init)));
    renderAt('/action-center');
    await screen.findByText('Fix the flux');
    await userEvent.click(screen.getByRole('button', { name: 'Mark seen: Fix the flux' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t mark it seen. Try again.');
    expect(screen.queryByText('Seen')).not.toBeInTheDocument();
  });
});
