/*
 * The dashboard Activity widget (Notifications and Timeline design section
 * 4.6; card 5854f0d6, Slice B; owner ruling E394, choice C11).
 *
 * It shows the newest eight Timeline rows from `GET /notifications/timeline`
 * (never the retiring `GET /dashboard/activity`), sorted by time even when the
 * page carries more rows than asked for (the windowed sources ride beside the
 * feed's page), links each row and the full Timeline, and says a failure, the
 * 503 TIMELINE_READ_TIMEOUT and an empty Timeline in words — it no longer
 * hides itself.
 */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ActivityFeed } from './ActivityFeed';
import type { TimelineItem } from '../notifications/timeline';

const fetchMock = vi.fn();
vi.mock('../../utils/auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString().replace('Z', '000Z');
const feed = (cursor: number, minutesAgo: number): TimelineItem => ({
  key: `feed:${cursor}`, at: at(minutesAgo), kind: 'status', label: 'Status moved',
  object: { type: 'task', id: `t-${cursor}`, title: `Task ${cursor}` }, project: null, actor: { handle: 'owner-one' },
  detail: { name: 'task.updated', from: 'todo', to: 'review' },
});
const approval = (id: string, minutesAgo: number): TimelineItem => ({
  key: `approval-event:${id}`, at: at(minutesAgo), kind: 'approval', label: 'Approval',
  object: { type: 'approval', id, title: 'Mint target' }, project: null, actor: { handle: null },
  detail: { action: 'approval.denied', approvalKind: 'agent-mint' },
});
const page = (items: TimelineItem[]) => ({
  ok: true, status: 200,
  json: async () => ({ success: true, items, nextCursor: null, hasMore: false, headCursor: { feed: null, approvals: null, skills: null }, lastSeen: null }),
});

const renderFeed = () => render(<MemoryRouter><ActivityFeed /></MemoryRouter>);

beforeEach(() => { fetchMock.mockReset(); });
afterEach(() => { cleanup(); });

describe('ActivityFeed shows the newest eight Timeline rows', () => {
  it('reads the Timeline (8 rows, default filters), never /dashboard/activity', async () => {
    fetchMock.mockResolvedValue(page([feed(3, 1)]));
    renderFeed();
    await screen.findByRole('link', { name: 'Task 3' });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(['/api/notifications/timeline?limit=8']);
  });

  it('a page with more rows than asked (the windowed sources) is sorted by time and cut to eight', async () => {
    const items = [
      ...Array.from({ length: 8 }, (_, i) => feed(100 - i, 10 + i * 10)),
      approval('a-new', 5), approval('a-mid', 35), approval('a-old', 500),
    ];
    fetchMock.mockResolvedValue(page(items));
    renderFeed();
    const region = await screen.findByRole('region', { name: 'Activity' });
    await within(region).findByRole('link', { name: 'Task 100' });
    const rows = within(region).getAllByRole('listitem');
    expect(rows).toHaveLength(8);
    expect(rows.map((row) => within(row).getAllByRole('link')[0].getAttribute('href'))).toEqual([
      '/action-center?tab=approvals&approval=a-new', '/tasks/t-100', '/tasks/t-99', '/tasks/t-98',
      '/action-center?tab=approvals&approval=a-mid', '/tasks/t-97', '/tasks/t-96', '/tasks/t-95',
    ]);
    expect(rows[1]).toHaveTextContent('Status moved: todo → review, by owner-one');
    expect(rows[0]).toHaveTextContent('Approval: Agent mint denied');
    expect(rows[0]).not.toHaveTextContent(', by');
    expect(within(region).getByRole('link', { name: 'Open the Timeline' })).toHaveAttribute('href', '/action-center?tab=timeline');
  });

  it('an empty Timeline says so (the widget no longer hides itself)', async () => {
    fetchMock.mockResolvedValue(page([]));
    renderFeed();
    expect(await screen.findByText('Nothing has happened that you can see yet.')).toBeInTheDocument();
  });

  it('503 TIMELINE_READ_TIMEOUT says it took too long; a failure says so; both offer Retry', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({ code: 'TIMELINE_READ_TIMEOUT' }) });
    renderFeed();
    expect(await screen.findByRole('alert')).toHaveTextContent('Recent activity took too long to read.');
    cleanup();
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ code: 'TIMELINE_READ_FAILED' }) });
    renderFeed();
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load recent activity.');
    fetchMock.mockResolvedValue(page([feed(7, 2)]));
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('link', { name: 'Task 7' })).toBeInTheDocument();
  });
});
