// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigationType } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';

import { authenticatedFetch } from '../../utils/auth';
import { TaskTimeline, type TimelineEvent } from './TaskTimeline';
import { TIMELINE_RENDERER_REGISTRY } from './taskTimelineRendererRegistry';

vi.mock('../../utils/auth', () => ({ authenticatedFetch: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.mocked(authenticatedFetch).mockReset();
  vi.unstubAllGlobals();
});

const taskId = '8ede2a98-de8f-4cfb-9e74-5891d545d6d9';
const at = '2026-08-14T12:00:00.000Z';
const event = (overrides: Partial<TimelineEvent>): TimelineEvent => ({
  id: 'event-1',
  at,
  createdAt: at,
  source: 'stream',
  provenance: 'system',
  eventType: 'task.transitioned',
  title: 'Task transitioned',
  description: 'Todo → In progress',
  actor: 'agent-1',
  actorDetail: { principalId: 'principal-1', handle: 'agent-1', role: 'claimant' },
  sessionKey: null,
  harness: null,
  metadata: {},
  redaction: null,
  ...overrides,
});

function LocationProbe() {
  const location = useLocation();
  const navigationType = useNavigationType();
  return <output data-testid="timeline-location">{location.search}|{navigationType}</output>;
}

function renderTimeline(events: TimelineEvent[], initialEntry = `/tasks/${taskId}`) {
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(new Response(JSON.stringify({
    success: true,
    taskId,
    filter: 'all',
    events,
    sourcesUnavailable: [],
    nextCursor: null,
  }), { status: 200 }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <TaskTimeline taskId={taskId} />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test('completion shows the authenticated history actor without inventing a legacy session',async()=>{
  renderTimeline([event({source:'history',eventType:'history.status',title:'Status changed',actor:'claude-reviewer',
    actorDetail:{principalId:'reviewer-id',handle:'claude-reviewer',role:'verifier'},sessionKey:null,
    metadata:{field:'status',newValue:'completed'}})]);
  expect(await screen.findByText('Completed by claude-reviewer · Verifier')).toBeInTheDocument();
  expect(screen.queryByText(/legacy session/i)).not.toBeInTheDocument();
});

// E387(2)/E388: the visual BEGIN/END fence retired; the untrusted-data
// property it stood for is kept. Board text still renders through React text
// escaping, so markup in it stays inert, and an unknown event type falls
// through to the generic renderer as a compact key: value list.
test('uses purpose-built taxonomy renderers and an inert plain-text fallback for hostile unknown events', async () => {
  const user = userEvent.setup();
  const hostile = '# heading\n<script>window.pwned = true</script>\n<img src=x onerror="window.pwned=true">\n' + 'x'.repeat(10_000);
  const { container } = renderTimeline([
    event({ id: 'transition', eventType: 'task.transitioned', title: 'Task transitioned' }),
    event({ id: 'handover', eventType: 'handover.finish', provenance: 'authored', title: 'Atomic handback finished' }),
    event({ id: 'review', source: 'review', eventType: 'review.reject', title: 'Verifier decision: reject', actor: 'agent', actorDetail: null }),
    event({ id: 'telemetry', eventType: 'outpost.progress', provenance: 'reported', title: 'Outpost progress' }),
    event({ id: 'legacy', source: 'session', provenance: 'legacy', eventType: 'session.reference', title: 'Legacy session reference' }),
    event({ id: 'unknown', eventType: 'plugin:future:hostile', provenance: 'reported', title: 'Future event', description: hostile, metadata: { payload: '<b>not markup</b>', nested: { depth: 2, tags: ['a', 'b'] } } }),
  ]);

  expect(await screen.findByText('Task transitioned')).toBeInTheDocument();
  expect(screen.getByText('Atomic handback finished')).toBeInTheDocument();
  expect(screen.getByText('Verifier decision: reject')).toBeInTheDocument();
  expect(screen.getByText('Outpost progress')).toBeInTheDocument();
  expect(screen.getByText('Legacy session reference')).toBeInTheDocument();

  const fallback = document.getElementById('event-unknown');
  expect(fallback).not.toBeNull();
  await user.click(within(fallback!).getByRole('button', { name: 'Show details for Future event' }));
  const detail = fallback!.querySelector('.task-timeline-event-detail') as HTMLElement;
  expect(within(detail).getByText('Reported provenance')).toBeInTheDocument();
  expect(detail).not.toHaveTextContent('BEGIN QUOTED CONTENT');
  expect(detail.querySelector('pre')).toBeNull();
  expect(detail).toHaveTextContent('<script>window.pwned = true</script>');
  // Unknown metadata is a compact key: value list, never JSON.
  const facts = detail.querySelector('dl.task-timeline-facts') as HTMLElement;
  expect(facts).not.toBeNull();
  expect(Array.from(facts.querySelectorAll('dt')).map(node => node.textContent)).toEqual(['Payload', 'Nested']);
  expect(facts).toHaveTextContent('<b>not markup</b>');
  expect(facts).toHaveTextContent('Depth: 2; Tags: a, b');
  expect(facts.textContent).not.toMatch(/[{}"]/);
  expect(fallback?.querySelector('script, img, b')).toBeNull();
  expect(container.textContent).not.toContain('[object Object]');
});

const historyEvent = (id: string, field: string, oldValue: string | null, newValue: string | null, title: string): TimelineEvent => event({
  id, source: 'history', provenance: 'system', description: null, title,
  eventType: field === 'status' ? 'task.status_changed' : field === 'priority' ? 'task.priority_changed' : field === 'notes' ? 'task.notes_updated'
    : field === 'autoStart' ? (newValue === 'true' ? 'task.arm' : 'task.park') : field === 'created' ? 'task.created' : 'task.field_changed',
  metadata: { field, oldValue, newValue },
});

test('E387(2): an expanded system change reads as plain words, never as a fenced JSON block', async () => {
  const user = userEvent.setup();
  renderTimeline([
    historyEvent('status', 'status', null, 'todo', 'Status changed: — → todo'),
    historyEvent('priority', 'priority', 'normal', 'high', 'Priority changed: normal → high'),
    historyEvent('notes-empty', 'notes', null, null, 'Notes updated'),
    historyEvent('arm', 'autoStart', 'false', 'true', 'Task armed'),
    historyEvent('field', 'trackerUrl', null, 'https://tracker.example/1', 'Field changed: trackerUrl'),
  ]);
  await screen.findByText('Status changed: — → todo');
  for (const button of screen.getAllByRole('button', { name: /^Show details for / })) await user.click(button);

  const detailOf = (id: string) => document.getElementById(`event-${id}`)!.querySelector('.task-timeline-event-detail') as HTMLElement;
  expect(detailOf('status').querySelector('.task-timeline-change')).toHaveTextContent('Status: — → Todo');
  expect(detailOf('priority').querySelector('.task-timeline-change')).toHaveTextContent('Priority: Normal → High');
  expect(detailOf('notes-empty')).toHaveTextContent('Notes were updated.');
  expect(detailOf('arm').querySelector('.task-timeline-change')).toHaveTextContent('Armed: No → Yes');
  expect(detailOf('field').querySelector('.task-timeline-change')).toHaveTextContent('Tracker URL: — → https://tracker.example/1');
  for (const id of ['status', 'priority', 'notes-empty', 'arm', 'field']) {
    const detail = detailOf(id);
    expect(detail).not.toHaveTextContent('BEGIN QUOTED CONTENT');
    expect(detail.textContent).not.toMatch(/[{}"]/);
    expect(detail.querySelector('pre, code, blockquote')).toBeNull();
  }
});

test('E387(2): every registered event type and the generic fallback render detail without fences, JSON or monospace', async () => {
  const user = userEvent.setup();
  const types = [...Object.keys(TIMELINE_RENDERER_REGISTRY), 'plugin:unregistered'];
  renderTimeline(types.map((eventType, index) => event({
    id: `type-${index}`, eventType, title: `Event ${index}`,
    provenance: index % 3 === 0 ? 'system' : index % 3 === 1 ? 'authored' : 'reported',
    description: index % 2 ? `Body <i>${index}</i>` : null,
    metadata: { decision: 'reject', findings: [{ code: 'F1', note: 'Missing proof' }], attemptCount: index, empty: null },
  })));
  await screen.findByText('Event 0');
  for (const button of screen.getAllByRole('button', { name: /^Show details for / })) await user.click(button);
  types.forEach((eventType, index) => {
    const detail = document.getElementById(`event-type-${index}`)!.querySelector('.task-timeline-event-detail') as HTMLElement;
    expect(detail, eventType).not.toBeNull();
    expect(detail.textContent, eventType).not.toContain('BEGIN QUOTED CONTENT');
    expect(detail.textContent, eventType).not.toMatch(/[{}"]/);
    expect(detail.querySelector('pre, code, i'), eventType).toBeNull();
    expect(detail, eventType).toHaveTextContent('Findings');
    expect(detail, eventType).toHaveTextContent('Code: F1; Note: Missing proof');
    if (index % 2) expect(detail, eventType).toHaveTextContent(`Body <i>${index}</i>`);
  });
});

test('system events are compact rows; authored and reported events show an inert three-line preview of their own text', async () => {
  const user = userEvent.setup();
  renderTimeline([
    historyEvent('status', 'status', 'todo', 'review', 'Status changed: todo → review'),
    event({ id: 'note', eventType: 'handover.note', provenance: 'authored', title: 'Handover note', description: 'Line one <script>window.pwned = true</script>\nLine two' }),
    event({ id: 'hidden', eventType: 'handover.note', provenance: 'authored', title: 'Redacted note', description: 'secret body',
      redaction: { mode: 'tombstone', redactedAt: at } }),
  ]);
  const status = (await screen.findByText('Status changed: todo → review')).closest('li')!;
  expect(status).toHaveClass('task-timeline-event--system');
  expect(status.querySelector('.task-timeline-event-preview')).toBeNull();

  const note = document.getElementById('event-note')!;
  expect(note).not.toHaveClass('task-timeline-event--system');
  const preview = note.querySelector('.task-timeline-event-preview') as HTMLElement;
  expect(preview).toHaveTextContent('Line one <script>window.pwned = true</script> Line two');
  expect(note.querySelector('script')).toBeNull();
  await user.click(within(note).getByRole('button', { name: 'Show details for Handover note' }));
  expect(note.querySelector('.task-timeline-event-preview')).toBeNull();
  const quote = note.querySelector('.task-timeline-quoted-content') as HTMLElement;
  expect(quote).toHaveTextContent('Authored note detail');
  expect(quote).toHaveTextContent('Line one <script>window.pwned = true</script>');
  expect(quote.querySelector('pre, script')).toBeNull();

  expect(document.getElementById('event-hidden')).not.toHaveTextContent('secret body');
});

test('the audit caption is the last item of the Timeline, after the events', async () => {
  const { container } = renderTimeline([event({ id: 'one', title: 'Only event' })]);
  await screen.findByText('Only event');
  const timeline = container.querySelector('.task-timeline')!;
  const children = Array.from(timeline.children);
  expect(children[children.length - 1]).toHaveClass('task-timeline-audit-caption');
  expect(children.findIndex(node => node.classList.contains('task-timeline-day'))).toBeLessThan(children.length - 1);
});

test('uses purpose-built renderers for the default authored and reported event types produced by C1', async () => {
  renderTimeline([
    event({ id: 'authored-default', eventType: 'handover.note', provenance: 'authored', title: 'Authored working note' }),
    event({ id: 'reported-default', eventType: 'outpost.reported', provenance: 'reported', title: 'Reported working note' }),
  ]);

  expect((await screen.findByText('Authored working note')).closest('li')).toHaveClass('task-timeline-event--handover-note');
  expect(screen.getByText('Reported working note').closest('li')).toHaveClass('task-timeline-event--outpost-reported');
  expect(document.querySelectorAll('.task-timeline-event--generic')).toHaveLength(0);
});

test('round-trips the three ratified filters through ?filter= and re-queries with replace navigation', async () => {
  const user = userEvent.setup();
  vi.mocked(authenticatedFetch).mockImplementation(async input => new Response(JSON.stringify({
    success: true,
    taskId,
    filter: new URL(String(input), 'https://relayhall.test').searchParams.get('filter'),
    events: [],
    sourcesUnavailable: [],
    nextCursor: null,
  }), { status: 200 }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/tasks/${taskId}?filter=handover`]}>
        <TaskTimeline taskId={taskId} />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  const filters = await screen.findByRole('radiogroup', { name: 'Timeline filter' });
  expect(within(filters).getAllByRole('radio').map(item => item.textContent)).toEqual([
    'All activity', 'Handovers & reports', 'System & ownership',
  ]);
  expect(within(filters).getByRole('radio', { name: 'Handovers & reports' })).toHaveAttribute('aria-checked', 'true');
  expect(authenticatedFetch).toHaveBeenCalledWith(expect.stringMatching(/filter=handover.*limit=50/));

  within(filters).getByRole('radio', { name: 'Handovers & reports' }).focus();
  await user.keyboard('{End}');
  expect(await screen.findByTestId('timeline-location')).toHaveTextContent('?filter=system|REPLACE');
  expect(within(filters).getByRole('radio', { name: 'System & ownership' })).toHaveAttribute('aria-checked', 'true');
  expect(authenticatedFetch).toHaveBeenCalledWith(expect.stringMatching(/filter=system.*limit=50/));
});

test('appends keyset pages in endpoint order without duplicate events', async () => {
  const user = userEvent.setup();
  vi.mocked(authenticatedFetch).mockImplementation(async input => {
    const before = new URL(String(input), 'https://relayhall.test').searchParams.get('before');
    return new Response(JSON.stringify({
      success: true,
      taskId,
      filter: 'all',
      events: before === 'cursor-2'
        ? [event({ id: 'two', title: 'Second event' }), event({ id: 'three', title: 'Third event' })]
        : [event({ id: 'one', title: 'First event' }), event({ id: 'two', title: 'Second event' })],
      sourcesUnavailable: [],
      nextCursor: before ? null : 'cursor-2',
    }), { status: 200 });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/tasks/${taskId}?filter=all`]}>
        <TaskTimeline taskId={taskId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  await screen.findByText('First event');
  await user.click(screen.getByRole('button', { name: 'Show older activity' }));
  expect(await screen.findByText('Third event')).toBeInTheDocument();
  expect(Array.from(container.querySelectorAll('.task-timeline-event')).map(item => item.id)).toEqual([
    'event-one', 'event-two', 'event-three',
  ]);
  expect(authenticatedFetch).toHaveBeenCalledWith(expect.stringContaining('before=cursor-2'));
  expect(screen.queryByRole('button', { name: 'Show older activity' })).not.toBeInTheDocument();
});

test('scrolls an arriving #event-{id} anchor below the sticky header and highlights without forced motion', async () => {
  const scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: true,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
  renderTimeline([event({ id: 'anchored', title: 'Anchored event' })], `/tasks/${taskId}?filter=all#event-anchored`);

  const anchored = (await screen.findByText('Anchored event')).closest('li');
  expect(anchored).toHaveAttribute('id', 'event-anchored');
  expect(anchored).toHaveClass('task-timeline-event--highlighted');
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' });
  vi.unstubAllGlobals();
});

test('follows nextCursor until an arriving event anchor is loaded, then scrolls and highlights it', async () => {
  const scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
  vi.mocked(authenticatedFetch).mockImplementation(async input => {
    const before = new URL(String(input), 'https://relayhall.test').searchParams.get('before');
    return new Response(JSON.stringify({
      success: true,
      taskId,
      filter: 'all',
      events: before === 'older-cursor'
        ? [event({ id: 'target', title: 'Older anchored event' })]
        : [event({ id: 'newest', title: 'Newest event' })],
      sourcesUnavailable: [],
      nextCursor: before ? null : 'older-cursor',
    }), { status: 200 });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/tasks/${taskId}?filter=all#event-target`]}>
        <TaskTimeline taskId={taskId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  const anchored = (await screen.findByText('Older anchored event')).closest('li');
  expect(authenticatedFetch).toHaveBeenCalledTimes(2);
  expect(authenticatedFetch).toHaveBeenLastCalledWith(expect.stringContaining('before=older-cursor'));
  expect(anchored).toHaveClass('task-timeline-event--highlighted');
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
});

test('maps storage roles to owner-facing labels and keeps principal-only attribution truthful', async () => {
  renderTimeline([
    event({ id: 'assignee', title: 'Assignee event', actorDetail: { principalId: 'principal-1', handle: 'ada', role: 'claimant' } }),
    event({ id: 'shepherd', title: 'Shepherd event', actorDetail: { principalId: 'principal-2', handle: 'sam', role: 'shepherd' } }),
    event({ id: 'verifier', title: 'Verifier event', actorDetail: { principalId: 'principal-3', handle: 'vera', role: 'verifier' } }),
    event({ id: 'other', title: 'Other event', actorDetail: { principalId: 'principal-4', handle: 'ollie', role: 'other' } }),
    event({ id: 'null-role', title: 'Null role event', actorDetail: { principalId: 'principal-5', handle: 'nora', role: null } }),
    event({ id: 'principal-only', title: 'Principal-only event', actorDetail: { principalId: '12345678-1234-1234-1234-123456789abc', handle: null, role: 'claimant' } }),
  ]);

  expect(await screen.findByText('ada · Assignee')).toBeInTheDocument();
  expect(screen.getByText('sam · Shepherd')).toBeInTheDocument();
  expect(screen.getByText('vera · Verifier')).toBeInTheDocument();
  expect(screen.getByText('ollie')).toBeInTheDocument();
  expect(screen.getByText('nora')).toBeInTheDocument();
  expect(screen.getByText('12345678…9abc · Assignee')).toBeInTheDocument();
  expect(screen.queryByText(/claimant|reviewer|Attributed principal/)).not.toBeInTheDocument();
  expect(document.getElementById('event-other')).not.toHaveTextContent('other');
});

test('keeps attribution nullable, renders redaction tombstones, and tells the truth about partial history', async () => {
  const user = userEvent.setup();
  vi.mocked(authenticatedFetch).mockResolvedValue(new Response(JSON.stringify({
    success: true,
    taskId,
    filter: 'all',
    events: [
      event({ id: 'display-only', actor: 'agent', actorDetail: null, title: 'Display-only actor' }),
      event({ id: 'system', actor: null, actorDetail: null, provenance: 'system', title: 'System event' }),
      event({
        id: 'redacted', title: 'Private authored note', description: 'secret body', provenance: 'authored',
        actor: 'river', actorDetail: { principalId: 'p2', handle: 'river', role: 'verifier' },
        redaction: { mode: 'tombstone', redactedAt: '2026-08-14T13:00:00.000Z' },
      }),
    ],
    sourcesUnavailable: ['stream'],
    nextCursor: null,
  }), { status: 200 }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/tasks/${taskId}?filter=all`]}><TaskTimeline taskId={taskId} /></MemoryRouter>
    </QueryClientProvider>,
  );

  expect(await screen.findByText('unattributed · agent')).toBeInTheDocument();
  expect(screen.getByText('system')).toBeInTheDocument();
  const tombstone = document.getElementById('event-redacted');
  expect(tombstone).toHaveTextContent('river · Verifier');
  expect(tombstone).toHaveTextContent('History entry redacted');
  expect(tombstone).toHaveTextContent('tombstone');
  expect(tombstone).not.toHaveTextContent('secret body');
  expect(screen.queryByText('claimant')).not.toBeInTheDocument();

  const notice = screen.getByRole('alert');
  expect(notice).toHaveTextContent('Some history could not be loaded — Retry');
  await user.click(within(notice).getByRole('button', { name: 'Retry' }));
  expect(authenticatedFetch).toHaveBeenCalledTimes(2);
  expect(container.querySelector('.task-timeline-audit-caption')).toHaveTextContent('ledger-grade stream');
  expect(container.querySelector('.task-timeline-audit-caption')).toHaveTextContent('audit trail, not a ledger');
});
