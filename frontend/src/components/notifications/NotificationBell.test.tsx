// @vitest-environment jsdom
/**
 * The bell and its popover, reworked for "Needs your action" (Notifications
 * and Timeline design section 3.2; card 5854f0d6, Slice B; owner ruling E394).
 *
 * Pinned here:
 *  - THE BADGE IS THE UNSEEN COUNT (owner ruling E455): the badge says
 *    `counts.unseen` of `GET /notifications/actions` and nothing else — not the
 *    length of the rows, not unread history, not a separate approvals poll —
 *    and the accessible name says the total that needs action and, when some
 *    are seen, how many are unseen; a seen item still open is listed;
 *  - an unknown count is never shown as a number (an error is a mark), and a
 *    capped count says it is a floor;
 *  - the popover: header "Needs your action" with the count, the items grouped
 *    Decisions / Verify / Stuck / Skill reviews in the server's order, each
 *    linked to where the act is done; the footer "All notifications",
 *    "Timeline", "Approvals";
 *  - FOCUS ORDER: opening moves focus to the popover; Tab walks the rows in
 *    list order and then the three footer links; Escape returns to the bell;
 *  - THE PINNED LAYOUT, read from the stylesheet: the panel is a column that
 *    does not scroll, the head and the foot do not shrink, and only the body
 *    scrolls (design N6, the later card 394131bd);
 *  - one shared read for every bell on screen, and no request to the retired
 *    history or approvals routes.
 */
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../utils/auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));

import { NotificationBell, bellBadge, bellName } from './NotificationBell';
import { fetchActions, type ActionItem, type ActionsSummary } from './notifications';
import type { PolledState } from '../../utils/polledResource';

type Answer = { status: number; body: unknown } | 'hang' | 'drop';
let answer: Answer;

function reply(value: Answer) {
  if (value === 'hang') return new Promise(() => undefined);
  if (value === 'drop') return Promise.reject(new TypeError('Failed to fetch'));
  return Promise.resolve({ ok: value.status >= 200 && value.status < 300, status: value.status, json: async () => value.body });
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();

function actionItem(kind: ActionItem['kind'], id: string, over: Partial<ActionItem> = {}): ActionItem {
  const object = kind === 'decision' ? { type: 'approval' as const, id, title: `Decision ${id}` }
    : kind === 'skill' ? { type: 'skill' as const, id, title: `skill-${id}` }
      : { type: 'task' as const, id, title: `Task ${id}` };
  const href = kind === 'decision' ? `/notifications?tab=approvals&approval=${id}` : kind === 'skill' ? `/skills?skill=${id}` : `/tasks/${id}`;
  return {
    key: `${kind}:${id}`, kind, reasons: kind === 'verify' ? ['verifier'] : kind === 'stuck' ? ['status'] : [String(kind)],
    since: hoursAgo(3), object, project: null, href,
    detail: kind === 'decision' ? { approvalKind: 'grant', requesterHandle: 'conn-a' } : {}, ...over,
  };
}

/** The route's envelope, counted the way the route counts (total = items listed). */
function actionsOk(items: ActionItem[], over: { total?: number; unseen?: number; capped?: Partial<Record<ActionItem['kind'], boolean>> } = {}): Answer {
  const count = (kind: string) => items.filter((item) => item.kind === kind).length;
  return {
    status: 200,
    body: {
      success: true, items,
      counts: {
        decision: count('decision'), verify: count('verify'), stuck: count('stuck'), skill: count('skill'), total: over.total ?? items.length,
        unseen: over.unseen ?? items.filter((item) => !item.seen).length,
      },
      capped: { decision: false, verify: false, stuck: false, skill: false, ...over.capped },
    },
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => {
    if (String(url).includes('/notifications/actions')) return reply(answer);
    throw new Error(`unexpected request ${url}`);
  });
});
afterEach(() => { cleanup(); });

const renderBell = () => render(<MemoryRouter><NotificationBell /></MemoryRouter>);
const bell = () => screen.getByRole('button', { name: /^Notifications/ });

const MIXED = [
  actionItem('decision', 'd1'), actionItem('decision', 'd2'),
  actionItem('verify', 'v1'),
  actionItem('stuck', 's1'),
  actionItem('skill', 'k1', { detail: { version: 3, requesterHandle: 'editor-one' } }),
];

describe('the bell counts the action list\'s total, and nothing else', () => {
  test('five open items: the badge is 5 and the name says so', async () => {
    answer = actionsOk(MIXED);
    const { container } = renderBell();
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications: 5 need your action'));
    expect(container.querySelector('.notification-bell-badge')).toHaveTextContent('5');
    const asked = fetchMock.mock.calls.map(([url]) => String(url));
    expect(asked).toEqual(['/api/notifications/actions']);
  });

  test('the count is the server\'s total, not the number of rows sent', async () => {
    answer = actionsOk([actionItem('verify', 'v1')], { total: 37, unseen: 37 });
    const { container } = renderBell();
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications: 37 need your action'));
    expect(container.querySelector('.notification-bell-badge')).toHaveTextContent('37');
  });

  test('one item reads in the singular', async () => {
    answer = actionsOk([actionItem('stuck', 's1')]);
    renderBell();
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications: 1 needs your action'));
  });

  test('no badge at zero, and the name says the zero it read', async () => {
    answer = actionsOk([]);
    const { container } = renderBell();
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications: 0 need your action'));
    expect(container.querySelector('.notification-bell-badge')).toBeNull();
  });

  test('a capped kind makes the count a floor: "+"', async () => {
    answer = actionsOk([actionItem('verify', 'v1'), actionItem('verify', 'v2')], { capped: { verify: true } });
    const { container } = renderBell();
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications: 2+ need your action'));
    expect(container.querySelector('.notification-bell-badge')).toHaveTextContent('2+');
  });

  test.each([
    ['refused (403)', { status: 403, body: { code: 'PRINCIPAL_REQUIRED' } } as Answer],
    ['failed (500)', { status: 500, body: {} } as Answer],
    ['answered without the list', { status: 200, body: { success: true } } as Answer],
    ['dropped', 'drop' as Answer],
  ])('a read that was %s is a mark and "unavailable", never a number', async (_label, failed) => {
    answer = failed;
    const { container } = renderBell();
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications: action count unavailable'));
    const badge = container.querySelector('.notification-bell-badge')!;
    expect(badge).toHaveClass('notification-bell-badge--unknown');
    expect(badge).toHaveTextContent('!');
  });

  test('nothing while the count is loading', async () => {
    answer = 'hang';
    const { container } = renderBell();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bell()).toHaveAccessibleName('Notifications');
    expect(container.querySelector('.notification-bell-badge')).toBeNull();
  });
});

describe('the arithmetic, directly', () => {
  const ready = (summary: ActionsSummary): PolledState<ActionsSummary> => ({ status: 'ready', value: summary });
  const summary = (total: number, capped = false, unseen = total): ActionsSummary => ({
    items: [], counts: { decision: 0, verify: total, stuck: 0, skill: 0, total, unseen },
    capped: { decision: false, verify: capped, stuck: false, skill: false },
  });

  test('the badge is the unseen count; zero hides it; an error is unknown; loading is nothing', () => {
    expect(bellBadge(ready(summary(4)))).toEqual({ kind: 'count', total: 4, capped: false });
    expect(bellBadge(ready(summary(4, false, 1)))).toEqual({ kind: 'count', total: 1, capped: false });
    expect(bellBadge(ready(summary(4, false, 0)))).toEqual({ kind: 'none' });
    expect(bellBadge(ready(summary(0)))).toEqual({ kind: 'none' });
    expect(bellBadge(ready(summary(200, true)))).toEqual({ kind: 'count', total: 200, capped: true });
    expect(bellBadge({ status: 'error', httpStatus: 500 })).toEqual({ kind: 'unknown' });
    expect(bellBadge({ status: 'loading' })).toEqual({ kind: 'none' });
  });

  test('fetchActions keeps an unknown kind as "other", with the server\'s word, and its cap (card 5854f0d6 review)', async () => {
    answer = {
      status: 200,
      body: {
        success: true,
        items: [actionItem('stuck', 's1'), { ...actionItem('stuck', 'h1'), key: 'handover:h1', kind: 'handover' }, null, { key: 'no-kind' }],
        counts: { decision: 0, verify: 0, stuck: 1, skill: 0, handover: 1, total: 2 },
        capped: { decision: false, verify: false, stuck: false, skill: false, handover: true },
      },
    };
    const read = await fetchActions();
    expect(read.items.map((item) => [item.key, item.kind, item.serverKind])).toEqual([
      ['stuck:s1', 'stuck', undefined],
      ['handover:h1', 'other', 'handover'],
    ]);
    expect(read.capped.other).toBe(true);
    expect(read.counts.total).toBe(2);
  });

  test('the name never turns an unknown count into a number', () => {
    expect(bellName({ status: 'loading' })).toBe('Notifications');
    expect(bellName({ status: 'error', httpStatus: null })).toBe('Notifications: action count unavailable');
    expect(bellName(ready(summary(200, true)))).toBe('Notifications: 200+ need your action');
    expect(bellName(ready(summary(5, false, 2)))).toBe('Notifications: 5 need your action, 2 unseen');
    expect(bellName(ready(summary(5, false, 0)))).toBe('Notifications: 5 need your action, 0 unseen');
  });
});

describe('the popover', () => {
  test('header and count, the items grouped by kind in the server\'s order, each linked; the three footer links', async () => {
    answer = actionsOk(MIXED);
    renderBell();
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications: 5 need your action'));
    await userEvent.click(bell());
    const panel = screen.getByRole('dialog', { name: 'Needs your action' });
    expect(bell()).toHaveAttribute('aria-expanded', 'true');
    expect(bell()).toHaveAttribute('aria-controls', panel.id);
    expect(within(panel).getByRole('heading', { level: 2, name: 'Needs your action' })).toBeInTheDocument();
    expect(panel.querySelector('.notification-bell-panel-count')).toHaveTextContent('5');
    const groups = within(panel).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
    expect(groups).toEqual(['Decisions (2)', 'Verify (1)', 'Stuck (1)', 'Skill reviews (1)']);
    expect(within(within(panel).getByRole('list', { name: 'Decisions (2)' })).getAllByRole('listitem')).toHaveLength(2);
    // The server's own href; `/notifications` is an alias of the Action Center.
    expect(within(panel).getByRole('link', { name: 'Decision d1' })).toHaveAttribute('href', '/notifications?tab=approvals&approval=d1');
    expect(within(panel).getByRole('link', { name: 'Task v1' })).toHaveAttribute('href', '/tasks/v1');
    expect(within(panel).getByRole('link', { name: 'skill-k1' })).toHaveAttribute('href', '/skills?skill=k1');
    expect(within(panel).getAllByText('Grant request from conn-a waits for your decision')).toHaveLength(2);
    expect(within(panel).getByText('Skill version 3 waits for review, submitted by editor-one')).toBeInTheDocument();
    expect(within(panel).getAllByText('Waiting 3 h')).toHaveLength(5);
    const foot = within(panel).getByRole('navigation', { name: 'Notification views' });
    expect(within(foot).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['All notifications', '/action-center'],
      ['Timeline', '/action-center?tab=timeline'],
      ['Approvals', '/action-center?tab=approvals'],
    ]);
    // E455: one "Mark all seen" in the header while anything is unseen; no per-row control here.
    expect(within(panel).getAllByRole('button', { name: /Mark/ }).map((button) => button.textContent)).toEqual(['Mark all seen']);
  });

  test('a kind this dashboard does not know is listed under Other, so every row the bell counts is a row it shows (card 5854f0d6 review)', async () => {
    const handover = {
      ...actionItem('verify', 'x1'), key: 'handover:x1', kind: 'handover' as unknown as ActionItem['kind'], reasons: ['handover'],
    };
    answer = actionsOk([actionItem('decision', 'd1'), handover]);
    renderBell();
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications: 2 need your action'));
    await userEvent.click(bell());
    const panel = screen.getByRole('dialog', { name: 'Needs your action' });
    const groups = within(panel).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
    expect(groups).toEqual(['Decisions (1)', 'Other (1)']);
    // The badge's number and the rows listed agree.
    expect(within(panel).getAllByRole('listitem')).toHaveLength(2);
    const other = within(panel).getByRole('list', { name: 'Other (1)' });
    expect(within(other).getByRole('link', { name: 'Task x1' })).toHaveAttribute('href', '/tasks/x1');
    expect(within(other).getByText(/^Waits for your action\./)).toBeInTheDocument();
  });

  test('an empty list says nothing needs you; a failed read says so with Retry, never "nothing"', async () => {
    answer = actionsOk([]);
    renderBell();
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications: 0 need your action'));
    await userEvent.click(bell());
    expect(screen.getByText('Nothing needs your action.')).toBeInTheDocument();
    cleanup();
    answer = { status: 500, body: {} };
    renderBell();
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications: action count unavailable'));
    await userEvent.click(bell());
    const panel = screen.getByRole('dialog', { name: 'Needs your action' });
    expect(within(panel).getByRole('alert')).toHaveTextContent(/Couldn.t check what needs your action/);
    expect(within(panel).queryByText('Nothing needs your action.')).not.toBeInTheDocument();
    answer = actionsOk([actionItem('stuck', 's9')]);
    await userEvent.click(within(panel).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications: 1 needs your action'));
  });

  test('FOCUS ORDER: the popover, then each row in list order, then the footer links; Escape returns to the bell', async () => {
    answer = actionsOk(MIXED);
    renderBell();
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications: 5 need your action'));
    await userEvent.click(bell());
    const panel = screen.getByRole('dialog', { name: 'Needs your action' });
    expect(panel).toHaveFocus();
    const order: string[] = [];
    for (let step = 0; step < 9; step += 1) {
      await userEvent.tab();
      order.push(document.activeElement?.textContent ?? '');
    }
    expect(order).toEqual([
      'Mark all seen',
      'Decision d1', 'Decision d2', 'Task v1', 'Task s1', 'skill-k1',
      'All notifications', 'Timeline', 'Approvals',
    ]);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Needs your action' })).not.toBeInTheDocument();
    expect(bell()).toHaveFocus();
    expect(bell()).toHaveAttribute('aria-expanded', 'false');
  });

  test('focus moving outside closes it and leaves focus where it went; a row\'s link closes it', async () => {
    answer = actionsOk(MIXED);
    render(<MemoryRouter><NotificationBell /><button type="button">Elsewhere</button></MemoryRouter>);
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications: 5 need your action'));
    await userEvent.click(bell());
    const panel = screen.getByRole('dialog', { name: 'Needs your action' });
    within(panel).getByRole('link', { name: 'Timeline' }).focus();
    expect(screen.getByRole('dialog', { name: 'Needs your action' })).toBeInTheDocument();
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    await act(async () => { elsewhere.focus(); });
    expect(screen.queryByRole('dialog', { name: 'Needs your action' })).not.toBeInTheDocument();
    expect(elsewhere).toHaveFocus();
    await userEvent.click(bell());
    await userEvent.click(screen.getByRole('link', { name: 'Task v1' }));
    expect(screen.queryByRole('dialog', { name: 'Needs your action' })).not.toBeInTheDocument();
  });

  test('two bells on screen share ONE read', async () => {
    answer = actionsOk(MIXED);
    render(<MemoryRouter><NotificationBell /><NotificationBell /></MemoryRouter>);
    await waitFor(() => {
      for (const button of screen.getAllByRole('button', { name: /^Notifications/ })) {
        expect(button).toHaveAccessibleName('Notifications: 5 need your action');
      }
    });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/notifications/actions'))).toHaveLength(1);
  });
});

describe('THE PINNED LAYOUT, read from the stylesheet (design N6; card 394131bd)', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'NotificationBell.css'), 'utf-8');
  const rule = (selector: string): string => {
    const match = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`));
    expect(match, `${selector} is missing`).not.toBeNull();
    return match![1];
  };
  const declared = (body: string, property: string) => body.match(new RegExp(`(?:^|[;{\\s])${property}:\\s*([^;]+);`))?.[1].trim() ?? null;

  test('the panel is a column with a ceiling, and never scrolls itself', () => {
    const panel = rule('.notification-bell-panel');
    expect(declared(panel, 'display')).toBe('flex');
    expect(declared(panel, 'flex-direction')).toBe('column');
    expect(declared(panel, 'overflow')).toBe('hidden');
    expect(declared(panel, 'max-height')).toMatch(/^min\(/);
    expect(declared(panel, 'overflow-y')).toBeNull();
  });

  test('the head and the foot keep their height; only the body scrolls', () => {
    expect(declared(rule('.notification-bell-panel-head'), 'flex')).toBe('none');
    expect(declared(rule('.notification-bell-panel-foot'), 'flex')).toBe('none');
    const body = rule('.notification-bell-panel-body');
    expect(declared(body, 'overflow-y')).toBe('auto');
    expect(declared(body, 'min-height')).toBe('0');
    expect(declared(body, 'flex')).toBe('1 1 auto');
  });

  test('the rendered popover puts head, body and foot in that order', async () => {
    answer = actionsOk(MIXED);
    renderBell();
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications: 5 need your action'));
    await userEvent.click(bell());
    const panel = screen.getByRole('dialog', { name: 'Needs your action' });
    expect(Array.from(panel.children).map((child) => child.className)).toEqual([
      'notification-bell-panel-head', 'notification-bell-panel-body', 'notification-bell-panel-foot',
    ]);
    // Every row sits in the scrolling body, never in the pinned head or foot.
    const body = panel.querySelector('.notification-bell-panel-body')!;
    expect(body.querySelectorAll('li')).toHaveLength(5);
    expect(panel.querySelector('.notification-bell-panel-head li, .notification-bell-panel-foot li')).toBeNull();
  });
});

describe('the seen mark (owner ruling E455): the bell counts only unseen items', () => {
  test('two of five seen: the badge is 3, the name says 5 need action and 3 unseen, and all five stay listed', async () => {
    answer = actionsOk(MIXED.map((item, index) => ({ ...item, seen: index < 2 })));
    const { container } = renderBell();
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications: 5 need your action, 3 unseen'));
    expect(container.querySelector('.notification-bell-badge')).toHaveTextContent('3');
    await userEvent.click(bell());
    const panel = screen.getByRole('dialog', { name: 'Needs your action' });
    expect(panel.querySelectorAll('li')).toHaveLength(5);
    expect(within(panel).getAllByText('Seen')).toHaveLength(2);
  });

  test('everything seen: no badge, the items still listed, and no Mark all seen', async () => {
    answer = actionsOk(MIXED.map((item) => ({ ...item, seen: true })));
    const { container } = renderBell();
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications: 5 need your action, 0 unseen'));
    expect(container.querySelector('.notification-bell-badge')).toBeNull();
    await userEvent.click(bell());
    const panel = screen.getByRole('dialog', { name: 'Needs your action' });
    expect(panel.querySelectorAll('li')).toHaveLength(5);
    expect(within(panel).queryByRole('button', { name: 'Mark all seen' })).not.toBeInTheDocument();
  });

  test('"Mark all seen" posts { all: true } and reads the list again; the badge goes, the rows stay', async () => {
    let seen = false;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/notifications/actions/seen')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({ all: true });
        seen = true;
        return reply({ status: 200, body: { success: true, marked: 5 } });
      }
      if (String(url).includes('/notifications/actions')) return reply(actionsOk(MIXED.map((item) => ({ ...item, seen }))));
      throw new Error(`unexpected request ${url}`);
    });
    const { container } = renderBell();
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications: 5 need your action'));
    await userEvent.click(bell());
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Needs your action' })).getByRole('button', { name: 'Mark all seen' }));
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications: 5 need your action, 0 unseen'));
    expect(container.querySelector('.notification-bell-badge')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Needs your action' }).querySelectorAll('li')).toHaveLength(5);
  });

  test('a server without the unseen count is read as every item unseen (never a smaller number)', async () => {
    answer = { status: 200, body: { success: true, items: MIXED, counts: { decision: 2, verify: 1, stuck: 1, skill: 1, total: 5 },
      capped: { decision: false, verify: false, stuck: false, skill: false } } };
    const { container } = renderBell();
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications: 5 need your action'));
    expect(container.querySelector('.notification-bell-badge')).toHaveTextContent('5');
  });
});
