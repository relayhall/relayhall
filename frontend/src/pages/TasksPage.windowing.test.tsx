// @vitest-environment jsdom
//
// RH-UI.14 (A4) — board load-on-scroll, virtualization, WS patch-in-place
// (design 986be411 §5, E4). Pins:
//   - the column page is 50 over the A3 read contract;
//   - task.updated / task.created PATCH the loaded window in place (no board
//     refetch) with the pulse surfaced to the column;
//   - load-more accumulation dedups by id (the documented drift coping);
//   - the reconnect reconcile reads the graph delta and refetches ONLY the
//     changed columns;
//   - TaskColumn virtualization: windowed render with spacers above the
//     threshold, exact render below it, roving keep-alive off-window.

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { authenticatedFetch } from '../utils/auth';
import { TasksPage } from './TasksPage';

const wsHandlers = new Map<string, (msg: unknown) => void>();
const wsState = { connected: true };

vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    subscribe: (type: string, handler: (msg: unknown) => void) => {
      wsHandlers.set(type, handler);
      return () => {};
    },
    connected: wsState.connected,
  }),
}));
vi.mock('../hooks/useToast', () => ({
  useToast: () => ({ toasts: [], success: vi.fn(), warning: vi.fn() }),
}));
vi.mock('../hooks/usePrincipals', () => ({
  usePrincipals: () => ({ byId: new Map(), principals: [] }),
  useMyPrincipal: () => ({ me: null }),
}));
vi.mock('../components/tasks/TaskColumn', async () => {
  const actual = await vi.importActual<typeof import('../components/tasks/TaskColumn')>('../components/tasks/TaskColumn');
  return {
    TaskColumn: (props: any) => (
      <section
        data-status={props.status}
        data-count={props.tasks.length}
        data-total={props.total}
        data-pulsed={[...(props.pulsedTaskIds ?? [])].join(',')}
      >
        {props.tasks.map((task: any) => <span key={task.id} data-task={task.id} />)}
        {props.hasMore && <button onClick={props.onLoadMore}>load more {props.status}</button>}
      </section>
    ),
    __actualTaskColumn: actual.TaskColumn,
  };
});
vi.mock('../components/Toast', () => ({ ToastContainer: () => null }));

const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const mkTask = (n: number, status: string) => ({
  id: uuid(n), title: `Task ${n}`, description: '', status, priority: 'normal',
  tags: [], subtasks: [], links: [], sessionRefs: [], autoCreated: false, autoStart: false,
  blockedBy: [], dependsOn: [], project: null, phaseId: null,
  created: `2026-08-15T10:${String(n % 60).padStart(2, '0')}:00.000Z`,
  updated: '2026-08-15T12:00:00.000Z',
});

const ALL = ['ideas', 'todo', 'in-progress', 'review', 'stuck', 'completed', 'archived'];
let boardColumns: Record<string, any>;
let secondPageItems: any[] = [];
let graphNodes: Array<{ id: string; status: string }> = [];
const boardRequests: string[] = [];
const graphRequests: string[] = [];

const flush = async () => {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
};

const renderPage = async () => {
  render(
    <MemoryRouter initialEntries={['/tasks']}>
      <Routes><Route path="/tasks" element={<TasksPage />} /></Routes>
    </MemoryRouter>,
  );
  await flush();
};

beforeEach(() => {
  localStorage.clear();
  wsHandlers.clear();
  wsState.connected = true;
  boardRequests.length = 0;
  graphRequests.length = 0;
  secondPageItems = [];
  graphNodes = [];
  boardColumns = Object.fromEntries(ALL.map(status => [status, { items: [], total: 0, offset: 0, limit: 50, hasMore: false }]));
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  vi.mocked(authenticatedFetch).mockImplementation(async input => {
    const url = String(input);
    if (url.includes('/tasks/filter-options')) return new Response(JSON.stringify({ success: true, tags: [], projects: [] }));
    if (url.includes('/tasks/board?')) {
      boardRequests.push(url);
      const offsetTodo = new URL(url, 'https://x').searchParams.get('offset_todo');
      if (offsetTodo && Number(offsetTodo) > 0) {
        return new Response(JSON.stringify({ success: true, columns: { todo: { items: secondPageItems, total: boardColumns.todo.total, offset: Number(offsetTodo), limit: 50, hasMore: false } } }));
      }
      return new Response(JSON.stringify({ success: true, columns: boardColumns }));
    }
    if (url.includes('/tasks/graph?')) {
      graphRequests.push(url);
      return new Response(JSON.stringify({ success: true, lod: 'task', nodes: graphNodes, edges: [], generatedAt: new Date().toISOString(), fullCount: graphNodes.length }));
    }
    if (url.endsWith('/phases')) return new Response(JSON.stringify({ success: true, phases: [] }));
    throw new Error(`Unexpected request: ${url}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('column page 50 over the A3 contract', () => {
  test('the board fetch requests perColumn=50', async () => {
    await renderPage();
    const query = new URL(boardRequests[0], 'https://x').searchParams;
    expect(query.get('perColumn')).toBe('50');
  });
});

describe('WS patch-in-place (§5: never a full refetch)', () => {
  test('task.updated moves the card between loaded columns, adjusts totals, pulses — with NO board refetch', async () => {
    boardColumns.todo = { items: [mkTask(1, 'todo'), mkTask(2, 'todo')], total: 2, offset: 0, limit: 50, hasMore: false };
    boardColumns['in-progress'] = { items: [mkTask(3, 'in-progress')], total: 1, offset: 0, limit: 50, hasMore: false };
    await renderPage();
    const fetchesBefore = boardRequests.length;

    await act(async () => {
      wsHandlers.get('task.updated')?.({ task: { ...mkTask(1, 'in-progress') } });
    });
    await flush();

    expect(boardRequests.length).toBe(fetchesBefore);
    const todo = document.querySelector('[data-status="todo"]')!;
    const inProgress = document.querySelector('[data-status="in-progress"]')!;
    expect(todo.getAttribute('data-count')).toBe('1');
    expect(todo.getAttribute('data-total')).toBe('1');
    expect(inProgress.getAttribute('data-count')).toBe('2');
    expect(inProgress.getAttribute('data-total')).toBe('2');
    expect(inProgress.querySelector(`[data-task="${uuid(1)}"]`)).not.toBeNull();
    expect(inProgress.closest('body')!.querySelector(`[data-pulsed*="${uuid(1)}"]`)).not.toBeNull();
  });

  test('task.created inserts in place without a refetch', async () => {
    boardColumns.todo = { items: [mkTask(5, 'todo')], total: 1, offset: 0, limit: 50, hasMore: false };
    await renderPage();
    const fetchesBefore = boardRequests.length;
    await act(async () => {
      wsHandlers.get('task.created')?.({ task: mkTask(9, 'todo') });
    });
    await flush();
    expect(boardRequests.length).toBe(fetchesBefore);
    const todo = document.querySelector('[data-status="todo"]')!;
    expect(todo.getAttribute('data-count')).toBe('2');
    expect(todo.getAttribute('data-total')).toBe('2');
  });
});

describe('totals adjust only with certainty; filters gate WS rows (review 3bb32ead B2/B3)', () => {
  test('an off-window task.updated never bumps the server total — it schedules the bounded reconcile', async () => {
    vi.useFakeTimers();
    boardColumns.todo = { items: [mkTask(31, 'todo')], total: 200, offset: 0, limit: 50, hasMore: true };
    await renderPage();
    const fetchesBefore = boardRequests.length;

    // An EXISTING task outside the loaded window (unknown prior membership).
    await act(async () => { wsHandlers.get('task.updated')?.({ task: mkTask(77, 'todo') }); });
    const todo = document.querySelector('[data-status="todo"]')!;
    expect(todo.getAttribute('data-total')).toBe('200');
    expect(todo.getAttribute('data-count')).toBe('1');
    // The bounded debounced reconcile fires instead.
    await act(async () => { vi.advanceTimersByTime(400); await Promise.resolve(); await Promise.resolve(); });
    vi.useRealTimers();
    await flush();
    expect(boardRequests.length).toBe(fetchesBefore + 1);
  });

  test('a task.created that does not match the active filters never enters the filtered view', async () => {
    localStorage.setItem('relayhall-task-filters', JSON.stringify({ searchQuery: '', priorities: [], tags: ['keep'], projects: [], phases: [], statuses: [] }));
    boardColumns.todo = { items: [{ ...mkTask(41, 'todo'), tags: ['keep'] }], total: 50, offset: 0, limit: 50, hasMore: false };
    await renderPage();
    const fetchesBefore = boardRequests.length;

    await act(async () => { wsHandlers.get('task.created')?.({ task: { ...mkTask(90, 'todo'), tags: ['other'] } }); });
    const todo = document.querySelector('[data-status="todo"]')!;
    expect(todo.getAttribute('data-count')).toBe('1');
    expect(todo.getAttribute('data-total')).toBe('50');
    expect(boardRequests.length).toBe(fetchesBefore);
  });

  test('a NONMATCHING off-window task.updated schedules the reconcile — a possibly-counted row never leaves totals stale (review 34eeaa31 B1)', async () => {
    vi.useFakeTimers();
    localStorage.setItem('relayhall-task-filters', JSON.stringify({ searchQuery: '', priorities: [], tags: ['keep'], projects: [], phases: [], statuses: [] }));
    boardColumns.todo = { items: [{ ...mkTask(61, 'todo'), tags: ['keep'] }], total: 200, offset: 0, limit: 50, hasMore: true };
    await renderPage();
    const fetchesBefore = boardRequests.length;

    // Existing OFF-WINDOW row whose new payload no longer matches: prior
    // membership unknown, so the total may be stale until the reconcile.
    await act(async () => { wsHandlers.get('task.updated')?.({ task: { ...mkTask(78, 'todo'), tags: ['other'] } }); });
    const todo = document.querySelector('[data-status="todo"]')!;
    expect(todo.getAttribute('data-total')).toBe('200');
    expect(todo.getAttribute('data-count')).toBe('1');
    await act(async () => { vi.advanceTimersByTime(400); await Promise.resolve(); await Promise.resolve(); });
    vi.useRealTimers();
    await flush();
    expect(boardRequests.length).toBe(fetchesBefore + 1);
  });

  test('a loaded task that stops matching the filters leaves the view and the total shrinks', async () => {
    localStorage.setItem('relayhall-task-filters', JSON.stringify({ searchQuery: '', priorities: [], tags: ['keep'], projects: [], phases: [], statuses: [] }));
    boardColumns.todo = { items: [{ ...mkTask(51, 'todo'), tags: ['keep'] }, { ...mkTask(52, 'todo'), tags: ['keep'] }], total: 2, offset: 0, limit: 50, hasMore: false };
    await renderPage();

    await act(async () => { wsHandlers.get('task.updated')?.({ task: { ...mkTask(51, 'todo'), tags: ['other'] } }); });
    const todo = document.querySelector('[data-status="todo"]')!;
    expect(todo.getAttribute('data-count')).toBe('1');
    expect(todo.getAttribute('data-total')).toBe('1');
    expect(todo.querySelector('[data-task="' + uuid(51) + '"]')).toBeNull();
  });
});

describe('load-more accumulation dedups by id (A3 drift coping)', () => {
  test('an overlapping second page collapses the shift duplicate', async () => {
    boardColumns.todo = { items: [mkTask(11, 'todo'), mkTask(12, 'todo')], total: 4, offset: 0, limit: 50, hasMore: true };
    secondPageItems = [mkTask(12, 'todo'), mkTask(13, 'todo')];
    await renderPage();
    fireEvent.click(screen.getByText('load more todo'));
    await flush();
    const todo = document.querySelector('[data-status="todo"]')!;
    expect(todo.getAttribute('data-count')).toBe('3');
    expect(todo.querySelectorAll(`[data-task="${uuid(12)}"]`)).toHaveLength(1);
  });
});

describe('reconnect reconcile (§5: delta first, refetch only changed columns)', () => {
  test('a false→true connection edge reads the graph delta and refetches only the changed columns', async () => {
    vi.useFakeTimers();
    boardColumns.todo = { items: [mkTask(21, 'todo')], total: 1, offset: 0, limit: 50, hasMore: false };
    await renderPage();
    const fetchesBefore = boardRequests.length;

    wsState.connected = false;
    await act(async () => { wsHandlers.get('task.updated')?.({ task: mkTask(21, 'todo') }); });
    graphNodes = [{ id: uuid(21), status: 'todo' }];
    wsState.connected = true;
    await act(async () => { wsHandlers.get('task.updated')?.({ task: mkTask(21, 'todo') }); });
    await act(async () => { vi.advanceTimersByTime(700); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    vi.useRealTimers();
    await flush();

    expect(graphRequests.length).toBe(1);
    expect(graphRequests[0]).toContain('updatedSince=');
    const reconcile = boardRequests.slice(fetchesBefore);
    expect(reconcile.length).toBe(1);
    expect(new URL(reconcile[0], 'https://x').searchParams.get('statuses')).toBe('todo');
  });
});

describe('TaskColumn virtualization (real component)', () => {
  const noop = () => {};
  const columnProps = (tasks: any[]) => ({
    status: 'todo' as any, title: 'To Do', tasks, total: tasks.length, hasMore: false,
    onDragStart: noop, onDragEnd: noop, onDrop: noop, onUpdateTask: noop,
    onSubtaskTransition: async () => {}, onDeleteTask: noop, onQuickAdd: noop,
    collapsed: false, onToggleCollapse: noop, isMobile: false, onMoveTask: noop,
    archiveAvailable: false, onArchiveTask: noop, rovingTaskId: null, onOpenerFocus: noop,
    onTagClick: noop, deepLinkTaskId: null, onDeepLinkHandled: noop,
    principalsById: new Map(), viewerPrincipalId: null,
  });

  test('below the threshold every card renders exactly (unit fixtures stay byte-true)', async () => {
    const { __actualTaskColumn: Actual } = await import('../components/tasks/TaskColumn') as any;
    const tasks = Array.from({ length: 20 }, (_, index) => mkTask(index + 100, 'todo'));
    render(<MemoryRouter><Actual {...columnProps(tasks)} /></MemoryRouter>);
    expect(document.querySelectorAll('.task-card-wrapper')).toHaveLength(20);
    expect(document.querySelector('.task-column-virtual-spacer')).toBeNull();
  });

  test('above the threshold only the window renders, spacers carry the rest, and the roving card is kept alive', async () => {
    const { __actualTaskColumn: Actual } = await import('../components/tasks/TaskColumn') as any;
    const tasks = Array.from({ length: 200 }, (_, index) => mkTask(index + 300, 'todo'));
    const offWindowId = tasks[180].id;
    render(<MemoryRouter><Actual {...columnProps(tasks)} rovingTaskId={offWindowId} /></MemoryRouter>);
    const wrappers = document.querySelectorAll('.task-card-wrapper');
    expect(wrappers.length).toBeLessThan(200);
    expect(wrappers.length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.task-column-virtual-spacer').length).toBeGreaterThanOrEqual(1);
    // Keep-alive: the roving stop's opener exists in the render tree even
    // though its row sits far outside the scrolled window (C2 §2.2).
    expect(document.querySelector(`.task-card-open-button[data-task-id="${offWindowId}"]`)).not.toBeNull();
  });
});
