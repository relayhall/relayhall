// @vitest-environment jsdom
// Real TasksPage/FilterBar scope-refetch regression; only card rendering is stubbed.
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
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
  useMyPrincipal: () => ({ me: null }),
}));
vi.mock('../components/tasks/TaskColumn', () => ({
  TaskColumn: ({ status, tasks, onRestoreArchived }: { status: string; tasks: Array<{id:string;title:string}>; onRestoreArchived?: (id:string) => void }) => <section data-status={status}>{tasks.map(task => <button key={task.id}>{task.title}</button>)}{onRestoreArchived && <button onClick={() => onRestoreArchived('old')}>Restore old task</button>}</section>,
}));
vi.mock('../components/Toast', () => ({ ToastContainer: () => null }));

const ALL_STATUSES = ['ideas', 'todo', 'in-progress', 'review', 'stuck', 'completed', 'archived'];
const createBoardColumns = () => Object.fromEntries(
  ALL_STATUSES.map(status => [status, { items: [], total: 0, offset: 0, limit: 6, hasMore: false }]),
);
let boardColumns = createBoardColumns();

const flushRequests = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const LocationProbe = () => {
  const location = useLocation();
  return <output data-testid="location-search">{location.search}</output>;
};

const renderTasksPage = async (initialEntry = '/tasks') => {
  // ?view=map renders the real Map, which reads the graph through
  // react-query exactly like every other surface â€” so the harness supplies a
  // client. Retries off: a failing fetch must surface immediately in a test
  // rather than being retried into a timeout.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/tasks" element={<><TasksPage /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await flushRequests();
};

const setViewportWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  boardColumns = createBoardColumns();
  setViewportWidth(1280);
  vi.mocked(authenticatedFetch).mockImplementation(async input => {
    const url = String(input);
    if (url.includes('/tasks/filter-options')) {
      return new Response(JSON.stringify({ success: true, tags: ['frontend', 'ux'], projects: ['RelayHall'] }));
    }
    if (url.includes('/tasks/board?')) {
      return new Response(JSON.stringify({ success: true, columns: boardColumns }));
    }
    if (url.endsWith('/phases')) {
      return new Response(JSON.stringify({ success: true, phases: [] }));
    }
    throw new Error(`Unexpected request: ${url}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});


test('project refetch retains the real dropdown and focus while withholding stale board actions', async () => {
  boardColumns.todo.items = [{ id: 'old', title: 'Old scope task' }] as never[];
  boardColumns.todo.total = 1;
  await renderTasksPage();
  fireEvent.click(screen.getByRole('button', { name: 'Search and filter' }));
  fireEvent.click(screen.getByRole('button', { name: 'Project' }));
  const checkbox = screen.getByRole('checkbox', { name: '#RelayHall' });
  checkbox.focus();
  let resolve!: (r: Response) => void;
  const pending = new Promise<Response>(r => { resolve = r; });
  vi.mocked(authenticatedFetch).mockImplementation(input => {
    const url = String(input);
    if (url.includes('/tasks/board?')) return pending;
    return Promise.resolve(new Response(JSON.stringify({ success: true, phases: [] })));
  });
  fireEvent.click(checkbox);
  await flushRequests();
  expect(screen.getByRole('checkbox', { name: '#RelayHall' })).toBe(checkbox);
  expect(checkbox).toBeChecked();
  expect(checkbox).toHaveFocus();
  expect(screen.queryByRole('button', { name: 'Old scope task' })).toBeNull();
  expect(screen.getByRole('button', { name: /Archive completed/ })).toBeDisabled();
  const next = createBoardColumns();
  next.todo.items = [{ id: 'new', title: 'New scope task' }] as never[];
  next.todo.total = 1;
  await act(async () => { resolve(new Response(JSON.stringify({ success: true, columns: next }))); });
  await flushRequests();
  expect(screen.getByRole('button', { name: 'New scope task' })).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: '#RelayHall' })).toBe(checkbox);
  expect(checkbox).toHaveFocus();
  expect(screen.getByRole('button', { name: /Archive completed/ })).toBeEnabled();
});

const openProject = async () => {
  await renderTasksPage();
  fireEvent.click(screen.getByRole('button', { name: 'Search and filter' }));
  fireEvent.click(screen.getByRole('button', { name: 'Project' }));
  return screen.getByRole('checkbox', { name: '#RelayHall' });
};

test('a failed scoped response retains filters, hides old results and allows a fresh retry', async () => {
  boardColumns.todo.items = [{ id: 'old', title: 'Old scope task' }] as never[];
  const checkbox = await openProject();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(authenticatedFetch).mockImplementation(async () => new Response(JSON.stringify({ success: false }), { status: 500 }));
  fireEvent.click(checkbox);
  await flushRequests();
  expect(screen.getByRole('checkbox', { name: '#RelayHall' })).toBe(checkbox);
  expect(screen.getByRole('alert')).toHaveTextContent('Tasks could not be loaded');
  expect(screen.queryByRole('button', { name: 'Old scope task' })).toBeNull();
  expect(screen.getByRole('button', { name: /Archive completed/ })).toBeDisabled();
  vi.mocked(authenticatedFetch).mockImplementation(async () => new Response(JSON.stringify({ success: true, columns: createBoardColumns() })));
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await flushRequests();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('button', { name: /Archive completed/ })).toBeEnabled();
  log.mockRestore();
});

test('a superseded filter response cannot expose old scope rows or finish the current loading state', async () => {
  const checkbox = await openProject();
  const resolve: Array<(r: Response) => void> = [];
  vi.mocked(authenticatedFetch).mockImplementation(() => new Promise<Response>(r => resolve.push(r)));
  fireEvent.click(checkbox);
  await flushRequests();
  fireEvent.click(checkbox);
  await flushRequests();
  expect(resolve).toHaveLength(2);
  const stale = createBoardColumns();
  stale.todo.items = [{ id: 'stale', title: 'Stale project result' }] as never[];
  await act(async () => resolve[0](new Response(JSON.stringify({ success: true, columns: stale }))));
  await flushRequests();
  expect(screen.queryByRole('button', { name: 'Stale project result' })).toBeNull();
  expect(screen.getByRole('button', { name: /Archive completed/ })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: '#RelayHall' })).toBe(checkbox);
  const current = createBoardColumns();
  current.todo.items = [{ id: 'current', title: 'Current result' }] as never[];
  await act(async () => resolve[1](new Response(JSON.stringify({ success: true, columns: current }))));
  await flushRequests();
  expect(screen.getByRole('button', { name: 'Current result' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Stale project result' })).toBeNull();
});

test('first load still uses the full-page loader until its response arrives', async () => {
  let resolve!: (r: Response) => void;
  vi.mocked(authenticatedFetch).mockImplementation(input => String(input).includes('/tasks/board?')
    ? new Promise<Response>(r => { resolve = r; })
    : Promise.resolve(new Response(JSON.stringify({ success: true, tags: [], projects: [] }))));
  await renderTasksPage();
  expect(screen.getByText('Loading tasks...')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Search and filter' })).toBeNull();
  await act(async () => resolve(new Response(JSON.stringify({ success: true, columns: createBoardColumns() }))));
  await flushRequests();
  expect(screen.getByRole('button', { name: 'Search and filter' })).toBeInTheDocument();
});

test('an old bulk IDs response cannot open a confirmation after the filter scope changes', async () => {
  const checkbox = await openProject();
  let resolveIds!: (r: Response) => void;
  let resolveBoard!: (r: Response) => void;
  vi.mocked(authenticatedFetch).mockImplementation(input => {
    if (String(input).includes('/tasks/ids?')) return new Promise<Response>(r => { resolveIds = r; });
    return new Promise<Response>(r => { resolveBoard = r; });
  });
  fireEvent.click(screen.getByRole('button', { name: /Archive completed/ }));
  fireEvent.click(checkbox);
  await flushRequests();
  await act(async () => resolveIds(new Response(JSON.stringify({ success: true, ids: ['old-completed'], total: 1 }))));
  await flushRequests();
  expect(screen.queryByRole('dialog')).toBeNull();
  await act(async () => resolveBoard(new Response(JSON.stringify({ success: true, columns: createBoardColumns() }))));
  await flushRequests();
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('first-load HTTP failure exposes the filter shell and a retry instead of old cards', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(authenticatedFetch).mockImplementation(async input => String(input).includes('/tasks/board?')
    ? new Response(JSON.stringify({ success: false }), { status: 500 })
    : new Response(JSON.stringify({ success: true, tags: [], projects: [] })));
  await renderTasksPage();
  expect(screen.getByRole('button', { name: 'Search and filter' })).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Tasks could not be loaded');
  expect(screen.getByRole('button', { name: /Archive completed/ })).toBeDisabled();
  log.mockRestore();
});

test('a mutation completing after a filter change cannot refresh with its old query closure', async () => {
  await renderTasksPage('/tasks?archived=true');
  fireEvent.click(screen.getByRole('button', { name: 'Search and filter' }));
  fireEvent.click(screen.getByRole('button', { name: 'Project' }));
  const checkbox = screen.getByRole('checkbox', { name: '#RelayHall' });
  let resolveMutation!: (r: Response) => void;
  let resolveBoard!: (r: Response) => void;
  const boardRequests: string[] = [];
  vi.mocked(authenticatedFetch).mockImplementation(input => {
    if (String(input).endsWith('/unarchive')) return new Promise<Response>(r => { resolveMutation = r; });
    boardRequests.push(String(input));
    return new Promise<Response>(r => { resolveBoard = r; });
  });
  fireEvent.click(screen.getByRole('button', { name: 'Restore old task' }));
  fireEvent.click(checkbox);
  await flushRequests();
  await act(async () => resolveMutation(new Response(JSON.stringify({ success: true, restoredTo: 'todo' }))));
  await flushRequests();
  expect(boardRequests).toHaveLength(1);
  expect(new URL(boardRequests[0], 'http://localhost').searchParams.get('projects')).toBe('RelayHall');
  expect(screen.getByRole('button', { name: /Archive completed/ })).toBeDisabled();
  const current = createBoardColumns();
  current.todo.items = [{ id: 'current', title: 'Current project task' }] as never[];
  await act(async () => resolveBoard(new Response(JSON.stringify({ success: true, columns: current }))));
  await flushRequests();
  expect(screen.getByRole('button', { name: 'Current project task' })).toBeInTheDocument();
});

test('late bulk outcome stays attributed while current filter query remains coherent', async () => {
 const checkbox = await openProject();
 let resolve!: (r: Response) => void;
 const pending = new Promise<Response>(r => { resolve = r; });
 const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 vi.mocked(authenticatedFetch).mockImplementation(input => {
  const url = String(input);
  if (url.includes('/tasks/ids?')) return Promise.resolve(new Response(JSON.stringify({success: true, ids: [id], total: 1})));
  if (url.endsWith('/tasks/bulk-archive')) return pending;
  if (url.includes('/tasks/board?')) return Promise.resolve(new Response(JSON.stringify({success: true, columns: createBoardColumns()})));
  return Promise.resolve(new Response(JSON.stringify({success: true, phases: []})));
 });
 fireEvent.click(screen.getByRole('button', {name: 'Archive completed'})); await flushRequests();
 fireEvent.click(screen.getByRole('button', {name: 'Archive 1'})); await flushRequests();
 fireEvent.click(checkbox); await flushRequests();
 const before = vi.mocked(authenticatedFetch).mock.calls.length;
 await act(async () => resolve(new Response(JSON.stringify({success: true, results: [{id, archived: false, code: 'NOT_COMPLETED'}]}))));
 await flushRequests();
 expect(screen.getByText(id)).toBeInTheDocument(); expect(screen.getByText('NOT_COMPLETED')).toBeInTheDocument();
 expect(checkbox).toBeChecked();
 for (const [url] of vi.mocked(authenticatedFetch).mock.calls.slice(before).filter(([url]) => String(url).includes('/tasks/board?')))
  expect(new URL(String(url), 'https://relayhall.local').searchParams.get('projects')).toBe('RelayHall');
});
