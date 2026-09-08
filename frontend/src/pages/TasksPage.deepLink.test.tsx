import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { authenticatedFetch } from '../utils/auth';
import { resolveTaskDeepLinkId, TasksPage } from './TasksPage';

const taskId = '8ede2a98-de8f-4cfb-9e74-5891d545d6d9';
let searchParams = new URLSearchParams(`focus=${taskId}`);
const setSearchParams = vi.fn();
const navigate = vi.fn();
const subscribe = vi.fn(() => vi.fn());

vi.mock('react-router-dom', () => ({
  useParams: () => ({}),
  useSearchParams: () => [searchParams, setSearchParams],
  useNavigate: () => navigate,
}));
vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ subscribe }) }));
vi.mock('../hooks/useToast', () => ({
  useToast: () => ({ toasts: [], success: vi.fn(), warning: vi.fn() }),
}));
vi.mock('../components/tasks/TaskColumn', () => ({
  TaskColumn: ({
    status,
    tasks,
    deepLinkTaskId,
  }: {
    status: string;
    tasks: Array<{ id: string }>;
    deepLinkTaskId: string | null;
  }) => (
    <div
      data-status={status}
      data-task-detail-open={Boolean(deepLinkTaskId && tasks.some(task => task.id === deepLinkTaskId))}
    />
  ),
}));
vi.mock('../components/tasks/FilterBar', () => ({ FilterBar: () => null }));
vi.mock('../components/Toast', () => ({ ToastContainer: () => null }));

const boardResponse = {
  success: true,
  columns: Object.fromEntries(
    ['ideas', 'todo', 'in-progress', 'review', 'stuck', 'completed', 'archived']
      .map(status => [status, { items: [], total: 0, offset: 0, limit: 6, hasMore: false }]),
  ),
};
let focusedStatus = 'todo';
let boardIncludesTask = false;
const focusedTask = () => ({ id: taskId, title: 'Focused task', status: focusedStatus, priority: 'normal', tags: [] });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  vi.resetAllMocks();
  subscribe.mockReturnValue(vi.fn());
  focusedStatus = 'todo';
  boardIncludesTask = false;
  searchParams = new URLSearchParams(`focus=${taskId}`);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      innerWidth: 1280,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => []),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });

  vi.mocked(authenticatedFetch).mockImplementation(async input => {
    const url = String(input);
    if (url.includes('/tasks/filter-options')) {
      return new Response(JSON.stringify({ success: true, tags: [], projects: [] }), { status: 200 });
    }
    if (url.includes('/tasks/board?')) {
      const response: any = structuredClone(boardResponse);
      if (boardIncludesTask) {
        response.columns.todo.items = [focusedTask()];
        response.columns.todo.total = 1;
      }
      return new Response(JSON.stringify(response), { status: 200 });
    }
    if (url.endsWith(`/tasks/${taskId}`)) {
      return new Response(JSON.stringify({ success: true, task: focusedTask() }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
});

async function renderLoadedPage(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(<TasksPage />);
    await settle();
    await settle();
    await settle();
  });
  return renderer!;
}

function openTaskDetails(renderer: ReactTestRenderer) {
  return renderer.root.findAll(node => node.props['data-task-detail-open'] === true);
}

describe('TasksPage task deep-link resolution', () => {
  test('keeps icon-only mobile board actions explicitly named', async () => {
    const renderer = await renderLoadedPage();
    const names = renderer.root
      .findAll(node => node.type === 'button')
      .map(node => node.props['aria-label'])
      .filter(Boolean);
    expect(names).toEqual(expect.arrayContaining([
      'Show archived',
      'Archive completed',
      'Create new task',
    ]));
    act(() => renderer.unmount());
  });

  test.each(['id', 'open', 'task', 'focus'])('resolves the legacy %s form and replaces it with the canonical full-UUID path', async alias => {
    searchParams = new URLSearchParams(`${alias}=${taskId}`);
    const directNavigation = await renderLoadedPage();
    expect(navigate).toHaveBeenCalledWith(`/tasks/${taskId}`, { replace: true });
    expect(openTaskDetails(directNavigation)).toHaveLength(0);
    expect(vi.mocked(authenticatedFetch)).toHaveBeenCalledWith(`/api/tasks/${taskId}`);
    act(() => directNavigation.unmount());

    vi.mocked(authenticatedFetch).mockClear();
    navigate.mockClear();
    const refreshedNavigation = await renderLoadedPage();
    expect(navigate).toHaveBeenCalledWith(`/tasks/${taskId}`, { replace: true });
    expect(vi.mocked(authenticatedFetch)).toHaveBeenCalledWith(`/api/tasks/${taskId}`);
    act(() => refreshedNavigation.unmount());
  });

  test('resolves a short ID against loaded board Tasks without calling the UUID-only detail endpoint', async () => {
    boardIncludesTask = true;
    searchParams = new URLSearchParams(`focus=${taskId.slice(0, 8)}`);
    const renderer = await renderLoadedPage();
    expect(navigate).toHaveBeenCalledWith(`/tasks/${taskId}`, { replace: true });
    expect(vi.mocked(authenticatedFetch)).not.toHaveBeenCalledWith(`/api/tasks/${taskId.slice(0, 8)}`);
    act(() => renderer.unmount());
  });

  test('resolves a Review task without rewriting it to another state', async () => {
    focusedStatus = 'review';
    const renderer = await renderLoadedPage();
    expect(navigate).toHaveBeenCalledWith(`/tasks/${taskId}`, { replace: true });
    const stuck = renderer.root.findAll(node => node.props['data-status'] === 'stuck' && node.props['data-task-detail-open'] === true);
    expect(stuck).toHaveLength(0);
    act(() => renderer.unmount());
  });

  test.each(['ideas', 'todo', 'in-progress', 'review', 'stuck', 'completed', 'archived'])(
    'keeps focus=%s reserved for board-column navigation',
    column => {
      expect(resolveTaskDeepLinkId(undefined, new URLSearchParams(`focus=${column}`))).toBeNull();
    },
  );

  test('preserves existing route and query aliases ahead of focus', () => {
    const params = new URLSearchParams(`id=id-alias&open=open-alias&task=task-alias&focus=${taskId}`);
    expect(resolveTaskDeepLinkId('route-id', params)).toBe('route-id');
    expect(resolveTaskDeepLinkId(undefined, params)).toBe('id-alias');
  });

  test('returns null when no task deep-link parameter is present', () => {
    expect(resolveTaskDeepLinkId(undefined, new URLSearchParams())).toBeNull();
  });
});
