// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigationType } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';

import { authenticatedFetch } from '../../utils/auth';
import { TaskTimeline, type TimelineEvent } from './TaskTimeline';

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

test('uses purpose-built taxonomy renderers and an inert quoted fallback for hostile unknown events', async () => {
  const user = userEvent.setup();
  const hostile = '# heading\n<script>window.pwned = true</script>\n<img src=x onerror="window.pwned=true">\n' + 'x'.repeat(10_000);
  const { container } = renderTimeline([
    event({ id: 'transition', eventType: 'task.transitioned', title: 'Task transitioned' }),
    event({ id: 'handover', eventType: 'handover.finish', provenance: 'authored', title: 'Atomic handback finished' }),
    event({ id: 'review', source: 'review', eventType: 'review.reject', title: 'Verifier decision: reject', actor: 'agent', actorDetail: null }),
    event({ id: 'telemetry', eventType: 'outpost.progress', provenance: 'reported', title: 'Outpost progress' }),
    event({ id: 'legacy', source: 'session', provenance: 'legacy', eventType: 'session.reference', title: 'Legacy session reference' }),
    event({ id: 'unknown', eventType: 'plugin:future:hostile', provenance: 'reported', title: 'Future event', description: hostile, metadata: { payload: '<b>not markup</b>' } }),
  ]);

  expect(await screen.findByText('Task transitioned')).toBeInTheDocument();
  expect(screen.getByText('Atomic handback finished')).toBeInTheDocument();
  expect(screen.getByText('Verifier decision: reject')).toBeInTheDocument();
  expect(screen.getByText('Outpost progress')).toBeInTheDocument();
  expect(screen.getByText('Legacy session reference')).toBeInTheDocument();

  const fallback = document.getElementById('event-unknown');
  expect(fallback).not.toBeNull();
  await user.click(within(fallback!).getByRole('button', { name: 'Show details for Future event' }));
  expect(within(fallback!).getByText('reported provenance')).toBeInTheDocument();
  expect(fallback?.querySelector('blockquote')).not.toBeNull();
  expect(fallback).toHaveTextContent('BEGIN QUOTED CONTENT');
  expect(fallback).toHaveTextContent('<script>window.pwned = true</script>');
  expect(fallback).toHaveTextContent('<b>not markup</b>');
  expect(fallback?.querySelector('script, img, b')).toBeNull();
  expect(container.textContent).not.toContain('[object Object]');
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
        actor: 'wadera', actorDetail: { principalId: 'p2', handle: 'wadera', role: 'verifier' },
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
  expect(tombstone).toHaveTextContent('wadera · Verifier');
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
