// @vitest-environment jsdom
/**
 * The Timeline tab (Notifications and Timeline design section 4.6; card
 * 5854f0d6, Slice B; owner ruling E394, choices C4, C7, C9).
 *
 * The fake route below APPLIES what it is asked — type, acl, project, phase,
 * person, since/until, scope, before, limit — so a tab that forgot to ask (or
 * asked the wrong thing) shows the wrong rows and these tests see it.
 *
 * Pinned here:
 *  - every filter the route allows is in the bar, held by the URL, and reaches
 *    the server; Access changes are off by default (C4) and the default scope
 *    is Everything I can see (C7); a malformed URL value is not applied;
 *  - owner ruling E453: the bar is FOLDED by default to the search box, a chip
 *    per applied filter (each removable) and a "Filters" toggle; unfolded, the
 *    filters are grouped (scope, type, project and phase, person, dates,
 *    access changes); the text search reaches the server as `q`;
 *  - grouped by day, newest first; each row's words, link, actor ("the board"
 *    for a board-written feed row, nobody for a withheld approval actor), the
 *    handover badge;
 *  - LAZY KEYSET PAGING: the IntersectionObserver reads the next page with the
 *    server's own `nextCursor`; the visible "Load more" does the same, also
 *    with no observer at all; no row twice; the end is said;
 *  - THE PER-PAGE CAP of the windowed sources (owner E438(7)): a page may
 *    carry more than `limit` rows, and a later page may carry a row that
 *    belongs above rows already shown — it is placed by time and said;
 *  - honest states: loading, 503 TIMELINE_READ_TIMEOUT ("took too long —
 *    narrow or retry", on the first page and on a later one), 400 in the
 *    server's words with Clear filters, a plain failure with Retry, and an
 *    empty list that says whether filters emptied it;
 *  - the seen mark: an explicit POST of the head after the unfiltered first
 *    page, never for a filtered view; the "new since your last visit" divider;
 *  - C9: the head is polled and "N new — Show" reads the list again.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../utils/auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
const PERSON = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
vi.mock('../../hooks/usePrincipals', () => ({
  usePrincipals: () => ({ principals: [
    { id: PERSON, handle: 'owner-one', kind: 'human' },
    { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', handle: 'agent-one', kind: 'agent' },
  ] }),
}));

import { TimelinePanel, dividerBefore } from './TimelinePanel';
import {
  calendarDay, dayStartIso, mergeTimeline, timelineFilters, timelineQueryString, type TimelineItem,
} from './timeline';
import { formatDayLabel } from '../../utils/dateFormat';

const PROJECT = '11111111-1111-4111-8111-111111111111';
/** Unfold the filter groups (owner ruling E453: they are folded by default). */
const unfold = async () => {
  const toggle = screen.getByRole('button', { name: /^Filters/ });
  if (toggle.getAttribute('aria-expanded') !== 'true') await userEvent.click(toggle);
};
const PHASE = '22222222-2222-4222-8222-222222222222';

/** Microsecond UTC text, as the route sends it. */
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString().replace('Z', '123Z');

type Row = TimelineItem & { person?: string; mine?: boolean; phase?: string };

function feedRow(cursor: number, minutesAgo: number, over: Partial<Row> = {}): Row {
  return {
    key: `feed:${cursor}`, at: at(minutesAgo), kind: 'status', label: 'Status moved',
    object: { type: 'task', id: `t-${cursor}`, title: `Task ${cursor}` }, project: { id: PROJECT, name: 'Relay project' },
    actor: { handle: 'owner-one' }, detail: { name: 'task.updated', from: 'todo', to: 'in-progress' },
    person: PERSON, mine: true, phase: PHASE, ...over,
  };
}

function approvalRow(id: string, minutesAgo: number, over: Partial<Row> = {}): Row {
  return {
    key: `approval-event:${id}`, at: at(minutesAgo), kind: 'approval', label: 'Approval',
    object: { type: 'approval', id, title: null }, project: null, actor: { handle: null },
    detail: { action: 'approval.approved', approvalKind: 'grant', approvalStatus: 'approved', taskId: null }, ...over,
  };
}

let rows: Row[];
let lastSeen: string | null;
let status: { code: number; error?: string; message?: string } | null;
let failBefore: { code: number; error?: string } | null;
/** Scripted pages, by `before` token ('' = first page): overrides the fake's own paging. */
let scripted: Record<string, { items: Row[]; nextCursor: string | null }> | null;
const posts: Array<{ url: string; body: unknown }> = [];
let location = '';

function LocationProbe() {
  const current = useLocation();
  location = `${current.pathname}${current.search}`;
  return null;
}

const strip = ({ person: _p, mine: _m, phase: _ph, ...item }: Row): TimelineItem => item;

function head(list: Row[]) {
  const feed = list.filter((row) => row.key.startsWith('feed:')).map((row) => Number(row.key.slice(5)));
  const times = (prefix: string) => list.filter((row) => row.key.startsWith(prefix)).map((row) => row.at).sort();
  return {
    feed: feed.length ? String(Math.max(...feed)) : null,
    approvals: times('approval-event:').pop() ?? null,
    skills: times('skill-event:').pop() ?? null,
  };
}

/** GET /notifications/timeline, as the route answers it. */
function serve(url: string) {
  const params = new URL(url, 'http://host').searchParams;
  const types = params.get('type')?.split(',') ?? [];
  const acl = params.get('acl') === 'true';
  const since = params.get('since');
  const until = params.get('until');
  let listed = rows.filter((row) => (types.length === 0 ? row.kind !== 'access' : types.includes(row.kind))
    || (acl && row.kind === 'access'));
  if (params.get('project')) listed = listed.filter((row) => row.project?.id === params.get('project'));
  if (params.get('phase')) listed = listed.filter((row) => row.phase === params.get('phase'));
  if (params.get('person')) listed = listed.filter((row) => row.person === params.get('person'));
  if (params.get('scope') === 'mine') listed = listed.filter((row) => row.mine);
  if (since) listed = listed.filter((row) => Date.parse(row.at) >= Date.parse(since));
  const q = params.get('q')?.toLowerCase();
  if (q) listed = listed.filter((row) => `${row.object.title ?? ''}`.toLowerCase().includes(q) || row.label.toLowerCase().includes(q));
  if (until) listed = listed.filter((row) => Date.parse(row.at) < Date.parse(until));
  const limit = Number(params.get('limit') ?? 50);
  const before = params.get('before') ?? '';
  if (scripted) {
    const page = scripted[before];
    return { success: true, items: page.items.map(strip), nextCursor: page.nextCursor, hasMore: page.nextCursor !== null, headCursor: head(rows), lastSeen };
  }
  const start = before ? Number(before) : 0;
  const page = listed.slice(start, start + limit);
  const more = listed.length > start + limit;
  return {
    success: true, items: page.map(strip), nextCursor: more ? String(start + limit) : null, hasMore: more,
    headCursor: head(listed), lastSeen,
  };
}

let observers: Array<{ callback: IntersectionObserverCallback; node: Element | null; live: boolean }> = [];
class FakeObserver {
  entry: { callback: IntersectionObserverCallback; node: Element | null; live: boolean };
  constructor(callback: IntersectionObserverCallback) {
    this.entry = { callback, node: null, live: true };
    observers.push(this.entry);
  }
  observe(node: Element) { this.entry.node = node; }
  unobserve() { /* not used */ }
  disconnect() { this.entry.live = false; }
  takeRecords() { return []; }
}
const intersect = async () => {
  const live = observers.filter((observer) => observer.live && observer.node);
  expect(live.length, 'a live observer on the sentinel').toBeGreaterThan(0);
  await act(async () => {
    live[live.length - 1].callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
  });
};

beforeEach(() => {
  rows = [
    feedRow(30, 5),
    feedRow(29, 30, { kind: 'update', label: 'Task updated', detail: { name: 'task.updated', fields: ['priority', 'title'], stream: { entryType: 'handover' } } }),
    feedRow(28, 60, { kind: 'report', label: 'Report', object: { type: 'report', id: 'r-1', title: 'Night report' }, detail: { name: 'report.created', handover: true } }),
    approvalRow('a1', 90),
    feedRow(27, 120, { kind: 'stuck', label: 'Stuck', actor: { handle: null }, person: undefined, detail: { name: 'task.stuck', reason: 'lease_expired' } }),
    feedRow(26, 3 * 1440, { kind: 'task', label: 'Task created or archived', detail: { name: 'task.created' }, mine: false, project: null, phase: undefined }),
    feedRow(25, 3 * 1440 + 10, { kind: 'access', label: 'Access changed', detail: { name: 'task.acl_changed' } }),
  ];
  lastSeen = null;
  status = null;
  failBefore = null;
  scripted = null;
  posts.length = 0;
  observers = [];
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const text = String(url);
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (init?.method === 'POST') {
      posts.push({ url: text, body: JSON.parse(String(init.body)) });
      return ok({ success: true, lastSeen: (posts[posts.length - 1].body as { cursor: string }).cursor });
    }
    if (text.includes('/notifications/timeline')) {
      if (failBefore && text.includes('before=')) return { ok: false, status: failBefore.code, json: async () => ({ code: failBefore!.error }) };
      if (status) return { ok: false, status: status.code, json: async () => ({ success: false, code: status!.error, error: status!.message }) };
      return ok(serve(text));
    }
    if (text.includes(`/projects/${PROJECT}/phases`)) {
      return ok({ success: true, phases: [{ id: PHASE, name: 'Build', status: 'active', position: 1 }] });
    }
    if (text.includes('/projects')) return ok({ success: true, projects: [{ id: PROJECT, name: 'Relay project' }] });
    throw new Error(`unexpected request ${text}`);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const renderAt = (entry = '/action-center?tab=timeline', props: { headPollMs?: number } = {}) => render(
  <MemoryRouter initialEntries={[entry]}><TimelinePanel {...props} /><LocationProbe /></MemoryRouter>,
);
const timelineGets = () => fetchMock.mock.calls
  .filter(([url, init]) => !init?.method && String(url).includes('/notifications/timeline'))
  .map(([url]) => String(url));
const lastQuery = () => new URL(timelineGets()[timelineGets().length - 1], 'http://host').searchParams;
const rowTitles = () => screen.queryAllByRole('listitem')
  .map((item) => item.querySelector('.timeline-panel-item-subject')?.textContent)
  .filter(Boolean);

describe('the first page: every type but access changes, everything you can see, grouped by day', () => {
  test('asks for one page with no filter, and lists the rows newest first under day headings', async () => {
    renderAt();
    expect(await screen.findByRole('link', { name: 'Task 30' })).toHaveAttribute('href', '/tasks/t-30');
    expect(timelineGets()[0]).toBe('/api/notifications/timeline?limit=50');
    expect(rowTitles()).toEqual(['Task 30', 'Task 29', 'Night report', 'Grant request', 'Task 27', 'Task 26']);
    // access changes are hidden by default (C4)
    expect(screen.queryByText('Task 25')).not.toBeInTheDocument();
    const days = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
    expect(days).toEqual([...new Set(rows.slice(0, 6).map((row) => formatDayLabel(row.at)))]);
    for (const day of screen.getAllByRole('heading', { level: 3 })) {
      expect(day.closest('section')).toHaveAccessibleName(day.textContent!);
      expect(day.closest('section')!.querySelector('ol')).not.toBeNull();
    }
  });

  test('each row says what happened, who did it, and where it was, and links to the object', async () => {
    renderAt();
    await screen.findByRole('link', { name: 'Task 30' });
    const row = (title: string) => screen.getByText(title).closest('li')!;
    expect(row('Task 30')).toHaveTextContent('Status moved');
    expect(row('Task 30')).toHaveTextContent('todo → in-progress');
    expect(row('Task 30')).toHaveTextContent('by owner-one');
    expect(row('Task 30')).toHaveTextContent('Relay project');
    expect(row('Task 29')).toHaveTextContent('Changed: priority, title · Stream entry: handover');
    expect(within(row('Night report')).getByText('Handover')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Night report' })).toHaveAttribute('href', '/reports/r-1');
    // a board-written feed row is the board's; a withheld approval actor is nobody
    expect(row('Task 27')).toHaveTextContent('Stuck: its lease expired');
    expect(row('Task 27')).toHaveTextContent('by RelayHall');
    expect(row('Grant request')).toHaveTextContent('Grant request approved');
    expect(within(row('Grant request')).queryByText(/^by /)).not.toBeInTheDocument();
    expect(within(row('Task 27')).getByText('by RelayHall')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Grant request' })).toHaveAttribute('href', '/action-center?tab=approvals&approval=a1');
    const time = row('Task 30').querySelector('time')!;
    expect(time).toHaveAttribute('dateTime', rows[0].at);
  });
});

describe('every filter the route allows: in the bar, in the URL, at the server', () => {
  test('a link with every filter set reaches the server with each of them', async () => {
    renderAt(`/action-center?tab=timeline&type=status,report&project=${PROJECT}&phase=${PHASE}&person=${PERSON}&since=2026-10-01&until=2026-10-20&scope=mine&acl=1`);
    await waitFor(() => expect(timelineGets().length).toBeGreaterThan(0));
    const query = lastQuery();
    expect(query.get('type')).toBe('status,report');
    expect(query.get('acl')).toBe('true');
    expect(query.get('project')).toBe(PROJECT);
    expect(query.get('phase')).toBe(PHASE);
    expect(query.get('person')).toBe(PERSON);
    // the viewer's own calendar days: from the start of the first to the start of the day after the last
    expect(query.get('since')).toBe(new Date(2026, 9, 1).toISOString());
    expect(query.get('until')).toBe(new Date(2026, 9, 21).toISOString());
    expect(query.get('scope')).toBe('mine');
    // The folded bar offers Clear filters beside the chips; with every filter set the list is also empty
    // (the fixture rows are recent, the link ends on 2026-10-20), so the empty state offers it too.
    expect((await screen.findAllByRole('button', { name: 'Clear filters' })).length).toBeGreaterThan(0);
  });

  test('a malformed URL value is not applied (and so not claimed)', async () => {
    renderAt('/action-center?tab=timeline&type=status,mention&project=nope&person=1&since=2026-02-30&scope=everyone&acl=maybe');
    await screen.findByRole('link', { name: 'Task 30' });
    expect(timelineGets()[0]).toBe('/api/notifications/timeline?type=status&limit=50');
  });

  test('the type checkboxes are a multi-select, in the design\'s labels, and write ?type=', async () => {
    renderAt();
    await screen.findByRole('link', { name: 'Task 30' });
    await unfold();
    const types = screen.getByRole('group', { name: 'Type: Every type' });
    expect(within(types).getAllByRole('checkbox').map((box) => box.parentElement!.textContent)).toEqual([
      'Task created or archived', 'Status moved', 'Task updated', 'Stuck', 'Review requested', 'Report', 'Phase',
      'Project', 'Skill', 'Skill version decided', 'Approval',
    ]);
    await userEvent.click(within(types).getByRole('checkbox', { name: 'Report' }));
    await userEvent.click(within(types).getByRole('checkbox', { name: 'Status moved' }));
    expect(location).toBe('/action-center?tab=timeline&type=status%2Creport');
    await waitFor(() => expect(lastQuery().get('type')).toBe('status,report'));
    await waitFor(() => expect(rowTitles()).toEqual(['Task 30', 'Night report']));
    expect(screen.getByRole('group', { name: 'Type: 2 types' })).toBeInTheDocument();
  });

  test('project, then its current phase, person, days, My work and Access changes each write the URL and reach the server', async () => {
    const user = userEvent.setup();
    renderAt();
    await screen.findByRole('link', { name: 'Task 30' });
    await unfold();
    const phase = screen.getByRole('combobox', { name: 'Current phase' });
    expect(phase).toBeDisabled();
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Project' }), 'Relay project');
    await waitFor(() => expect(lastQuery().get('project')).toBe(PROJECT));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Current phase' })).toBeEnabled());
    await user.selectOptions(screen.getByRole('combobox', { name: 'Current phase' }), await screen.findByRole('option', { name: 'Build' }));
    await waitFor(() => expect(lastQuery().get('phase')).toBe(PHASE));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Person' }), 'owner-one');
    await waitFor(() => expect(lastQuery().get('person')).toBe(PERSON));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    await waitFor(() => expect(lastQuery().get('since')).toBe(new Date(2026, 9, 1).toISOString()));
    await user.click(screen.getByRole('radio', { name: 'My work' }));
    await waitFor(() => expect(lastQuery().get('scope')).toBe('mine'));
    await user.click(screen.getByRole('checkbox', { name: 'Access changes' }));
    await waitFor(() => expect(lastQuery().get('acl')).toBe('true'));
    expect(location).toBe(`/action-center?tab=timeline&project=${PROJECT}&phase=${PHASE}&person=${PERSON}&since=2026-10-01&scope=mine&acl=1`);
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(location).toBe('/action-center?tab=timeline');
    await waitFor(() => expect(timelineGets()[timelineGets().length - 1]).toBe('/api/notifications/timeline?limit=50'));
  });

  test('choosing another project clears the phase (a phase belongs to one project)', async () => {
    renderAt(`/action-center?tab=timeline&project=${PROJECT}&phase=${PHASE}`);
    await waitFor(() => expect(lastQuery().get('phase')).toBe(PHASE));
    await unfold();
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Project' }), 'Every project');
    expect(location).toBe('/action-center?tab=timeline');
  });
});

describe('lazy keyset paging, with a visible Load more', () => {
  beforeEach(() => {
    rows = Array.from({ length: 120 }, (_, index) => feedRow(500 - index, index * 7));
  });

  test('the observer reads the next page with the server\'s cursor; no row twice; the end is said', async () => {
    renderAt();
    await screen.findByRole('link', { name: 'Task 500' });
    expect(rowTitles()).toHaveLength(50);
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
    await intersect();
    await waitFor(() => expect(rowTitles()).toHaveLength(100));
    expect(lastQuery().get('before')).toBe('50');
    expect(await screen.findByText('Loaded 50 more rows.')).toHaveAttribute('aria-live', 'polite');
    await intersect();
    await waitFor(() => expect(rowTitles()).toHaveLength(120));
    expect(lastQuery().get('before')).toBe('100');
    expect(new Set(rowTitles()).size).toBe(120);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(screen.getByText('No older activity you can see.')).toBeInTheDocument();
  });

  test('with NO IntersectionObserver the Load more button pages on its own', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    renderAt();
    await screen.findByRole('link', { name: 'Task 500' });
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(rowTitles()).toHaveLength(100));
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(rowTitles()).toHaveLength(120));
    expect(observers).toHaveLength(0);
  });

  test('while a page loads, Load more keeps keyboard focus: aria-disabled, not disabled, and a second press reads nothing (card 5854f0d6 review)', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    renderAt();
    await screen.findByRole('link', { name: 'Task 500' });
    let release: () => void = () => undefined;
    const serveNow = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('before=')) await new Promise<void>((resolve) => { release = resolve; });
      return serveNow(url, init);
    });
    const pages = () => timelineGets().filter((url) => url.includes('before=')).length;
    const button = screen.getByRole('button', { name: 'Load more' });
    button.focus();
    await userEvent.keyboard('{Enter}');
    const busy = await screen.findByRole('button', { name: 'Loading…' });
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    expect(busy).not.toBeDisabled();
    expect(document.activeElement).toBe(busy);
    await userEvent.keyboard('{Enter}');
    await userEvent.click(busy);
    expect(pages()).toBe(1);
    await act(async () => { release(); });
    await waitFor(() => expect(rowTitles()).toHaveLength(100));
    const again = screen.getByRole('button', { name: 'Load more' });
    expect(again).not.toHaveAttribute('aria-disabled');
    expect(document.activeElement).toBe(again);
  });

  test('a page read under filters keeps them: the next page asks with the same filters and the cursor', async () => {
    renderAt('/action-center?tab=timeline&type=status&scope=mine');
    await screen.findByRole('link', { name: 'Task 500' });
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(lastQuery().get('before')).toBe('50'));
    expect(lastQuery().get('type')).toBe('status');
    expect(lastQuery().get('scope')).toBe('mine');
  });

  test('503 TIMELINE_READ_TIMEOUT on a later page: said, rows kept, the observer stops, the button retries', async () => {
    failBefore = { code: 503, error: 'TIMELINE_READ_TIMEOUT' };
    renderAt();
    await screen.findByRole('link', { name: 'Task 500' });
    await intersect();
    expect(await screen.findByRole('alert')).toHaveTextContent('The next page took too long to read. Try again, or narrow the filters');
    expect(rowTitles()).toHaveLength(50);
    // no automatic retry loop after a failure
    expect(observers.filter((observer) => observer.live)).toHaveLength(0);
    failBefore = null;
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(rowTitles()).toHaveLength(100));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('the per-page cap of the windowed sources (owner E438(7))', () => {
  test('a page may hold more than the page size; a later page\'s row that belongs above is placed by time, and said', async () => {
    const page1 = [feedRow(90, 1), ...Array.from({ length: 50 }, (_, i) => approvalRow(`a${String(i).padStart(2, '0')}`, 2 + i)), feedRow(89, 100)];
    const page2 = [approvalRow('late', 60), feedRow(88, 200)];
    scripted = { '': { items: page1, nextCursor: 'tok-2' }, 'tok-2': { items: page2, nextCursor: null } };
    rows = [...page1, ...page2];
    renderAt();
    await screen.findByRole('link', { name: 'Task 90' });
    expect(screen.getAllByRole('listitem')).toHaveLength(52);
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(54));
    expect(lastQuery().get('before')).toBe('tok-2');
    // The late approval row (60 minutes ago) sits above Task 89 (100 minutes ago), not at the bottom.
    const order = screen.getAllByRole('listitem').map((item) => item.querySelector('a')?.getAttribute('href'));
    expect(order.indexOf('/notifications?tab=approvals&approval=late')).toBeLessThan(order.indexOf('/tasks/t-89'));
    expect(order[order.length - 1]).toBe('/tasks/t-88');
    expect(screen.getByRole('note')).toHaveTextContent('The last page placed 1 row among the rows above, by time');
    expect(screen.getByText(/Loaded 2 more rows\. 1 of them fall among rows already shown/)).toBeInTheDocument();
  });

  test('mergeTimeline: no row twice, newest first, and the count of rows placed above the old bottom', () => {
    const a = feedRow(10, 1); const b = feedRow(9, 50); const late = approvalRow('x', 20); const old = feedRow(8, 90);
    const merged = mergeTimeline([a, b], [b, late, old]);
    expect(merged.items.map((item) => item.key)).toEqual(['feed:10', 'approval-event:x', 'feed:9', 'feed:8']);
    expect(merged.added).toBe(2);
    expect(merged.insertedAbove).toBe(1);
  });
});

describe('honest states', () => {
  test('503 TIMELINE_READ_TIMEOUT on the first page: "took too long — narrow or retry", never an empty list', async () => {
    status = { code: 503, error: 'TIMELINE_READ_TIMEOUT', message: 'The timeline read took too long' };
    renderAt();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The timeline took too long to read. Narrow the filters (a type, a project or a date range) or try again.',
    );
    expect(screen.queryByText(/Nothing/)).not.toBeInTheDocument();
    status = null;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('link', { name: 'Task 30' })).toBeInTheDocument();
  });

  test('a 503 without the timeout code is a plain failure, not the timeout\'s advice', async () => {
    status = { code: 503, error: 'SERVICE_UNAVAILABLE' };
    renderAt();
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load the timeline.');
  });

  test('a 400 says the server\'s words and offers Clear filters', async () => {
    status = { code: 400, error: 'INVALID_TIMELINE_FILTER', message: 'project must be a UUID' };
    renderAt('/action-center?tab=timeline&type=status');
    expect(await screen.findByRole('alert')).toHaveTextContent('These filters could not be applied: project must be a UUID');
    status = null;
    await userEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Clear filters' }));
    expect(location).toBe('/action-center?tab=timeline');
  });

  test('a failure is an error with Retry', async () => {
    status = { code: 500, error: 'TIMELINE_READ_FAILED' };
    renderAt();
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load the timeline.');
    expect(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  test('empty: unfiltered says nothing happened; filtered says the filters emptied it', async () => {
    rows = [];
    renderAt();
    expect(await screen.findByText('Nothing has happened that you can see yet.')).toBeInTheDocument();
    cleanup();
    renderAt('/action-center?tab=timeline&type=phase');
    expect(await screen.findByText('Nothing on the timeline matches these filters.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Clear filters' }).length).toBeGreaterThan(0);
  });

  test('loading says so', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/notifications/timeline')) return new Promise(() => undefined);
      return { ok: true, status: 200, json: async () => ({ success: true, projects: [] }) };
    });
    renderAt();
    expect(await screen.findByText('Loading the timeline…')).toBeInTheDocument();
  });
});

describe('new since your last visit', () => {
  test('the unfiltered first page writes the seen mark by an explicit POST of the head it read', async () => {
    renderAt();
    await screen.findByRole('link', { name: 'Task 30' });
    await waitFor(() => expect(posts).toEqual([{ url: '/api/notifications/timeline/seen', body: { cursor: '30' } }]));
  });

  test('a filtered view never marks rows it did not show as seen', async () => {
    renderAt('/action-center?tab=timeline&type=report');
    await screen.findByRole('link', { name: 'Night report' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posts).toEqual([]);
  });

  test('the divider sits above the first row the last visit had seen, and says how many are new', async () => {
    lastSeen = '28';
    renderAt();
    await screen.findByRole('link', { name: 'Task 30' });
    const items = screen.getAllByRole('listitem');
    const divider = items.findIndex((item) => item.textContent === 'Above this line: new since your last visit');
    expect(divider).toBeGreaterThan(-1);
    expect(items[divider - 1]).toHaveTextContent('Task 29');
    expect(items[divider + 1]).toHaveTextContent('Night report');
    expect(screen.getByText('2 new since your last visit, above the divider.')).toBeInTheDocument();
  });

  test('a first visit, or nothing new, draws no divider', () => {
    const list = [feedRow(5, 1), approvalRow('q', 2), feedRow(4, 3)];
    expect(dividerBefore(list, null)).toBeNull();
    expect(dividerBefore(list, '5')).toBeNull();
    expect(dividerBefore(list, '4')).toEqual({ key: 'feed:4', newer: 1 });
  });

  test('C9: the head is polled; "N new — Show" reads the list again from the top', async () => {
    renderAt('/action-center?tab=timeline', { headPollMs: 25 });
    await screen.findByRole('link', { name: 'Task 30' });
    rows = [feedRow(32, 0), feedRow(31, 1), approvalRow('fresh', 2), ...rows];
    const banner = await screen.findByText('3 new', {}, { timeout: 2000 });
    const before = timelineGets().filter((url) => url.endsWith('?limit=50')).length;
    await userEvent.click(within(banner.parentElement!).getByRole('button', { name: 'Show' }));
    expect(await screen.findByRole('link', { name: 'Task 32' })).toBeInTheDocument();
    expect(timelineGets().filter((url) => url.endsWith('?limit=50')).length).toBeGreaterThan(before);
  });
});

describe('a deep link ?type=access (card 5854f0d6 review)', () => {
  test('maps to the Access changes switch, alone or beside other types', () => {
    const alone = timelineFilters(new URLSearchParams('type=access'));
    expect(alone.acl).toBe(true);
    expect(alone.types).toEqual([]);
    const mixed = timelineFilters(new URLSearchParams('type=status,access'));
    expect(mixed.acl).toBe(true);
    expect(mixed.types).toEqual(['status']);
    expect(timelineFilters(new URLSearchParams('type=status')).acl).toBe(false);
  });

  test('the switch shows on, and the server is asked for access changes', async () => {
    renderAt('/notifications?tab=timeline&type=access');
    await screen.findByRole('link', { name: 'Task 30' });
    // The filter groups are folded by default (owner ruling E453): the applied switch shows as a chip,
    // and unfolded it is the checked Access changes switch.
    expect(screen.getByRole('button', { name: 'Remove filter: Access changes' })).toBeInTheDocument();
    await unfold();
    expect(screen.getByRole('checkbox', { name: 'Access changes' })).toBeChecked();
    expect(lastQuery().get('acl')).toBe('true');
    expect(lastQuery().get('type')).toBeNull();
  });
});

describe('the URL grammar, directly', () => {
  test('calendar days are real days; the query uses the viewer\'s day starts', () => {
    expect(calendarDay('2026-10-01')).toBe('2026-10-01');
    expect(calendarDay('2026-02-30')).toBeNull();
    expect(calendarDay('2026-10-1')).toBeNull();
    expect(dayStartIso('2026-10-31', 1)).toBe(new Date(2026, 10, 1).toISOString());
    const filters = timelineFilters(new URLSearchParams(`type=report,status,report&person=${PERSON.toUpperCase()}`));
    expect(filters.types).toEqual(['status', 'report']);
    expect(filters.person).toBe(PERSON);
    expect(filters.scope).toBe('all');
    expect(filters.acl).toBe(false);
    expect(timelineQueryString(filters, { limit: 50 })).toBe(`?type=status%2Creport&person=${PERSON}&limit=50`);
  });
});

describe('the folded filter bar, its chips and the text search (owner ruling E453)', () => {
  test('folded by default: the search box, no groups, and a Filters toggle that unfolds them grouped', async () => {
    renderAt();
    await screen.findByRole('link', { name: 'Task 30' });
    const toggle = screen.getByRole('button', { name: 'Filters' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('searchbox', { name: 'Search the timeline' })).toBeInTheDocument();
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Project' })).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Applied filters' })).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(panel).not.toBeNull();
    expect(within(panel).getAllByRole('group').map((group) => group.querySelector('legend')?.textContent))
      .toEqual(['Scope', 'Type: Every type', 'Project and phase', 'Person', 'Dates', 'Access changes']);
    expect(within(panel).getByRole('radiogroup', { name: 'Whose activity' })).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });

  test('every applied filter is a chip, folded; each chip removes exactly its filter', async () => {
    renderAt(`/action-center?tab=timeline&type=status,report&project=${PROJECT}&phase=${PHASE}&person=${PERSON}&since=2026-10-01&until=2026-10-20&scope=mine&acl=1&q=relay`);
    await waitFor(() => expect(timelineGets().length).toBeGreaterThan(0));
    const chips = await screen.findByRole('list', { name: 'Applied filters' });
    await waitFor(() => expect(within(chips).getByRole('button', { name: 'Remove filter: Current phase: Build' })).toBeInTheDocument());
    expect(within(chips).getAllByRole('button').map((chip) => chip.getAttribute('aria-label'))).toEqual([
      'Remove filter: Search: “relay”', 'Remove filter: My work', 'Remove filter: Type: Status moved', 'Remove filter: Type: Report',
      'Remove filter: Project: Relay project', 'Remove filter: Current phase: Build', 'Remove filter: Person: owner-one',
      'Remove filter: From 2026-10-01', 'Remove filter: To 2026-10-20', 'Remove filter: Access changes',
    ]);
    expect(screen.getByRole('button', { name: 'Filters (9)' })).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(within(chips).getByRole('button', { name: 'Remove filter: Type: Report' }));
    expect(new URLSearchParams(location.split('?')[1]).get('type')).toBe('status');
    await userEvent.click(within(screen.getByRole('list', { name: 'Applied filters' })).getByRole('button', { name: 'Remove filter: Project: Relay project' }));
    const after = new URLSearchParams(location.split('?')[1]);
    expect([after.get('project'), after.get('phase'), after.get('person')]).toEqual([null, null, PERSON]);
    await userEvent.click(screen.getByRole('button', { name: 'Remove filter: Search: “relay”' }));
    expect(new URLSearchParams(location.split('?')[1]).get('q')).toBeNull();
    await waitFor(() => expect(screen.getByRole('searchbox', { name: 'Search the timeline' })).toHaveValue(''));
    await waitFor(() => expect(lastQuery().get('q')).toBeNull());
    // The emptied box never puts the removed search back after its pause.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(new URLSearchParams(location.split('?')[1]).get('q')).toBeNull();
  });

  test('typing a search applies it after a pause: the URL holds q, the route is asked for it, and only matches show', async () => {
    renderAt();
    await screen.findByRole('link', { name: 'Task 30' });
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search the timeline' }), '  NIGHT ');
    await waitFor(() => expect(lastQuery().get('q')).toBe('NIGHT'));
    expect(location).toBe('/action-center?tab=timeline&q=NIGHT');
    await waitFor(() => expect(rowTitles()).toEqual(['Night report']));
    expect(screen.getByRole('searchbox', { name: 'Search the timeline' })).toHaveValue('  NIGHT ');
    expect(screen.getByRole('button', { name: 'Remove filter: Search: “NIGHT”' })).toBeInTheDocument();
  });

  test('Enter applies a search at once; a search matches labels too; an empty result says the filters emptied it', async () => {
    renderAt();
    await screen.findByRole('link', { name: 'Task 30' });
    const box = screen.getByRole('searchbox', { name: 'Search the timeline' });
    await userEvent.type(box, 'stuck{Enter}');
    await waitFor(() => expect(lastQuery().get('q')).toBe('stuck'));
    await waitFor(() => expect(rowTitles()).toEqual(['Task 27']));
    await userEvent.clear(box);
    await userEvent.type(box, 'nothing like this{Enter}');
    expect(await screen.findByText('Nothing on the timeline matches these filters.')).toBeInTheDocument();
  });

  test('a searched view never marks the Timeline seen, and a link\'s overlong search is cut to the maximum', async () => {
    renderAt(`/action-center?tab=timeline&q=${'x'.repeat(130)}`);
    await waitFor(() => expect(timelineGets().length).toBeGreaterThan(0));
    expect(lastQuery().get('q')).toBe('x'.repeat(100));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(posts).toEqual([]);
    expect(timelineFilters(new URLSearchParams('q=%20%20'))).toMatchObject({ q: null });
  });
});
