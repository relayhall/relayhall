// @vitest-environment jsdom
// Card b595b3b0: the board reads task activity for the cards it shows, in one
// bounded batch, and only those; card rendering is stubbed to expose what each
// column receives. Card 30d198df (2): of those, only the In Progress cards.
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { authenticatedFetch } from '../utils/auth';
import { TasksPage } from './TasksPage';

vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: () => ({ subscribe: vi.fn(() => vi.fn()) }),
}));
vi.mock('../hooks/useToast', () => ({
  useToast: () => ({ toasts: [], success: vi.fn(), warning: vi.fn() }),
}));
vi.mock('../hooks/usePrincipals', () => ({
  usePrincipals: () => ({ byId: new Map(), principals: [] }),
  useMyPrincipal: () => ({ me: { id: 'viewer' } }),
}));
vi.mock('../components/tasks/TaskColumn', () => ({
  TaskColumn: ({ status, tasks, taskActivity }: { status: string; tasks: Array<{ id: string; title: string }>; taskActivity?: Map<string, { state: string }> }) => (
    <section data-status={status}>
      {tasks.map(task => <p key={task.id}>{`${task.title}: ${taskActivity?.get(task.id)?.state ?? 'none'}`}</p>)}
    </section>
  ),
}));
vi.mock('../components/Toast', () => ({ ToastContainer: () => null }));

const ALL_STATUSES = ['ideas', 'todo', 'in-progress', 'review', 'stuck', 'completed', 'archived'];
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TASKS: Record<string, Array<{ id: string; title: string; status: string }>> = {
  ideas: [{ id: uuid(1), title: 'Idea', status: 'ideas' }],
  todo: [{ id: uuid(2), title: 'Planned', status: 'todo' }],
  'in-progress': [{ id: uuid(3), title: 'Working', status: 'in-progress' }, { id: uuid(4), title: 'Quiet', status: 'in-progress' }],
  review: [{ id: uuid(5), title: 'Reviewing', status: 'review' }],
  stuck: [], completed: [],
  archived: [{ id: uuid(6), title: 'Old', status: 'archived' }],
};
const columns = () => Object.fromEntries(ALL_STATUSES.map(status => [status,
  { items: TASKS[status], total: TASKS[status].length, offset: 0, limit: 6, hasMore: false }]));
let activityCalls: string[][] = [];

const flush = async () => {
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
};

const renderBoard = async (entry = '/tasks') => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes><Route path="/tasks" element={<TasksPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await flush(); await flush();
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  activityCalls = [];
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  vi.mocked(authenticatedFetch).mockImplementation(async input => {
    const url = String(input);
    if (url.includes('/tasks/activity?ids=')) {
      const ids = url.split('ids=')[1].split(',');
      activityCalls.push(ids);
      const now = Date.now();
      return new Response(JSON.stringify({ success: true, observedAt: new Date(now).toISOString(), staleAfterMs: 540000,
        activity: ids.map(taskId => taskId === uuid(3)
          ? { taskId, state: 'active', kind: 'heartbeat', receivedAt: new Date(now - 1000).toISOString() }
          : { taskId, state: 'unknown', kind: null, receivedAt: null }) }));
    }
    if (url.includes('/tasks/filter-options')) return new Response(JSON.stringify({ success: true, tags: [], projects: [] }));
    if (url.includes('/tasks/board?')) return new Response(JSON.stringify({ success: true, columns: columns() }));
    if (url.endsWith('/phases')) return new Response(JSON.stringify({ success: true, phases: [] }));
    throw new Error(`Unexpected request: ${url}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

test('the board reads activity for its visible In Progress cards in one batch and hands each card only its own row', async () => {
  await renderBoard();
  expect(activityCalls).toHaveLength(1);
  // Collapsed columns (ideas, archived by default) are not visible and not read;
  // visible cards outside In Progress (todo, review) are not read either.
  expect([...activityCalls[0]].sort()).toEqual([uuid(3), uuid(4)]);
  expect(screen.getByText('Working: active')).toBeInTheDocument();
  expect(screen.getByText('Quiet: unknown')).toBeInTheDocument();
  expect(screen.getByText('Planned: none')).toBeInTheDocument();
  expect(screen.getByText('Reviewing: none')).toBeInTheDocument();
});

test('one timed refresh for the whole board, not one poller per card', async () => {
  await renderBoard();
  expect(activityCalls).toHaveLength(1);
  await act(async () => { vi.advanceTimersByTime(29_000); });
  expect(activityCalls).toHaveLength(1);
  await act(async () => { vi.advanceTimersByTime(1_000); }); await flush();
  expect(activityCalls).toHaveLength(2);
  expect([...activityCalls[1]].sort()).toEqual([uuid(3), uuid(4)]);
});

test('at narrow width only the open column\'s In Progress cards are read', async () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
  await renderBoard();
  // The To-do tab opens first: it has no In Progress card, so nothing is read.
  await act(async () => { vi.advanceTimersByTime(60_000); }); await flush();
  expect(activityCalls).toEqual([]);
  const tab = [...document.querySelectorAll('.tasks-mobile-tab')]
    .find(button => button.querySelector('.tasks-mobile-tab-label')?.textContent === 'In') as HTMLElement;
  fireEvent.click(tab); await flush();
  expect(activityCalls).toHaveLength(1);
  expect([...activityCalls[0]].sort()).toEqual([uuid(3), uuid(4)]);
});

test('a hidden tab makes no activity request until it is visible again', async () => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  await renderBoard();
  await act(async () => { vi.advanceTimersByTime(120_000); });
  expect(activityCalls).toHaveLength(0);
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); }); await flush();
  expect(activityCalls).toHaveLength(1);
  expect(screen.getByText('Working: active')).toBeInTheDocument();
});
