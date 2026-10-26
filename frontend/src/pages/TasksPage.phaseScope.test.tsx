// @vitest-environment jsdom
//
// Card 096fda30 (owner E67), on the production TasksPage under a real router:
// a Phase the selected Projects exclude is CLEARED — when the Project
// selection changes, and when a link or stored filter state arrives with one —
// and the clearing is said in the filter bar. The board is never left
// narrowed to nothing by a Phase from another Project.
//
// The board query is the evidence: a cleared Phase must be gone from
// `phaseIds` on the wire and from `phases` in the address bar, not merely
// unticked on screen.

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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
  TaskColumn: ({ status }: { status: string }) => <section data-status={status} />,
}));
vi.mock('../components/Toast', () => ({ ToastContainer: () => null }));

const RELAYHALL_ID = '11111111-1111-4111-8111-111111111111';
const SHOP_ID = '22222222-2222-4222-8222-222222222222';
const PHASES = [
  { id: 'phase-rh-1', name: '01 · Authored knowledge', position: 10, projectId: RELAYHALL_ID, status: 'in-progress' },
  { id: 'phase-rh-2', name: '10 · Release lane', position: 11, projectId: RELAYHALL_ID, status: 'todo' },
  { id: 'phase-shop-1', name: 'Shop launch', position: 1, projectId: SHOP_ID, status: 'todo' },
];
const PROJECTS = [
  { id: RELAYHALL_ID, name: 'RelayHall', status: 'active' },
  { id: SHOP_ID, name: 'Storefront', status: 'active' },
];
const CLEARED_NOTICE = 'Phase filter "#10 01 · Authored knowledge" was cleared: it is not in the selected projects.';

const ALL_STATUSES = ['ideas', 'todo', 'in-progress', 'review', 'stuck', 'completed', 'archived'];
const createBoardColumns = () => Object.fromEntries(
  ALL_STATUSES.map(status => [status, { items: [], total: 0, offset: 0, limit: 6, hasMore: false }]),
);

const flushRequests = async () => {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }
};

const LocationProbe = () => {
  const location = useLocation();
  return <output data-testid="location-search">{location.search}</output>;
};

const renderTasksPage = async (initialEntry = '/tasks') => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
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

const boardQueries = () => vi.mocked(authenticatedFetch).mock.calls
  .map(([input]) => String(input))
  .filter(url => url.includes('/tasks/board?'))
  .map(url => new URL(url, 'https://relayhall.local').searchParams);
const lastBoardQuery = () => boardQueries().at(-1)!;
const addressBar = () => new URLSearchParams(screen.getByTestId('location-search').textContent!);
// The board has other live regions; the Phase scope notice is the filter bar's.
const notice = () => {
  const region = screen.getAllByRole('status').find(element => element.classList.contains('filter-bar-notice'));
  expect(region).toBeDefined();
  return region!;
};

let directory: () => Promise<Response>;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  directory = async () => new Response(JSON.stringify({ success: true, projects: PROJECTS }));
  vi.mocked(authenticatedFetch).mockImplementation(async input => {
    const url = String(input);
    if (url.includes('/tasks/filter-options')) {
      return new Response(JSON.stringify({ success: true, tags: [], projects: ['RelayHall', 'Storefront'] }));
    }
    if (url.includes('/tasks/board?')) {
      return new Response(JSON.stringify({ success: true, columns: createBoardColumns() }));
    }
    if (url.endsWith('/phases')) {
      return new Response(JSON.stringify({ success: true, phases: PHASES }));
    }
    if (url.endsWith('/projects?includeHidden=true&includeArchived=true')) return directory();
    throw new Error(`Unexpected request: ${url}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('a Project change clears a Phase of another Project', () => {
  test('selecting Storefront clears a selected RelayHall Phase before any board request carries both', async () => {
    await renderTasksPage('/tasks?phases=phase-rh-1');
    expect(lastBoardQuery().get('phaseIds')).toBe('phase-rh-1');
    const before = boardQueries().length;

    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    fireEvent.click(screen.getByLabelText('#Storefront'));
    await flushRequests();

    const after = boardQueries().slice(before);
    expect(after.length).toBeGreaterThan(0);
    for (const query of after) {
      expect(query.get('projects')).toBe('Storefront');
      expect(query.get('phaseIds')).toBeNull();
    }
    expect(addressBar().get('projects')).toBe('Storefront');
    expect(addressBar().get('phases')).toBeNull();
    expect(notice()).toHaveTextContent(CLEARED_NOTICE);
  });

  test('an in-scope Phase and the backlog survive the same change', async () => {
    await renderTasksPage('/tasks?phases=phase-shop-1,null');
    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    fireEvent.click(screen.getByLabelText('#Storefront'));
    await flushRequests();
    expect(lastBoardQuery().get('phaseIds')).toBe('phase-shop-1,null');
    expect(notice()).toBeEmptyDOMElement();
  });

  test('the notice is dismissible and goes once the Project selection changes again', async () => {
    await renderTasksPage('/tasks?phases=phase-rh-1');
    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    fireEvent.click(screen.getByLabelText('#Storefront'));
    await flushRequests();
    fireEvent.click(within(notice()).getByRole('button', { name: 'Dismiss notice' }));
    expect(notice()).toBeEmptyDOMElement();

    cleanup();
    vi.mocked(authenticatedFetch).mockClear();
    await renderTasksPage('/tasks?phases=phase-rh-1');
    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    fireEvent.click(screen.getByLabelText('#Storefront'));
    await flushRequests();
    expect(notice()).toHaveTextContent(CLEARED_NOTICE);
    fireEvent.click(screen.getByLabelText('#RelayHall'));
    await flushRequests();
    expect(notice()).toBeEmptyDOMElement();
  });

  test('the Phase dropdown on the board lists only the selected Project’s Phases', async () => {
    await renderTasksPage('/tasks?projects=Storefront');
    fireEvent.click(screen.getByRole('button', { name: 'Phase' }));
    act(() => { vi.advanceTimersByTime(20); });
    expect(screen.getByRole('textbox', { name: 'Search phases' })).toHaveFocus();
    expect(screen.getByRole('group', { name: 'Storefront' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'RelayHall' })).toBeNull();
    expect(screen.queryByLabelText('#10 01 · Authored knowledge')).toBeNull();
    expect(screen.getByLabelText('#1 Shop launch')).toBeInTheDocument();
  });
});

describe('a link or stored state carrying a Phase outside its Projects is treated the same way on load', () => {
  test('a link: the Phase is cleared from the board query and the address bar, and the clearing is said', async () => {
    await renderTasksPage('/tasks?projects=Storefront&phases=phase-rh-1');
    expect(lastBoardQuery().get('projects')).toBe('Storefront');
    expect(lastBoardQuery().get('phaseIds')).toBeNull();
    expect(addressBar().get('phases')).toBeNull();
    expect(addressBar().get('projects')).toBe('Storefront');
    expect(notice()).toHaveTextContent(CLEARED_NOTICE);
  });

  test('a link whose Phases all belong to its Projects is left exactly as written', async () => {
    await renderTasksPage('/tasks?projects=Storefront&phases=phase-shop-1,null');
    expect(lastBoardQuery().get('phaseIds')).toBe('phase-shop-1,null');
    expect(addressBar().get('phases')).toBe('phase-shop-1,null');
    expect(notice()).toBeEmptyDOMElement();
  });

  test('stored filter state', async () => {
    localStorage.setItem('relayhall-task-filters', JSON.stringify({
      searchQuery: '', priorities: [], tags: [], projects: ['Storefront'], phases: ['phase-rh-1', 'phase-shop-1'], statuses: [],
    }));
    await renderTasksPage('/tasks');
    expect(lastBoardQuery().get('phaseIds')).toBe('phase-shop-1');
    expect(JSON.parse(localStorage.getItem('relayhall-task-filters')!).phases).toEqual(['phase-shop-1']);
    expect(notice()).toHaveTextContent('Phase filter "#10 01 · Authored knowledge" was cleared');
  });

  test('a Project directory that answers late still clears, once it lands', async () => {
    let answer!: (response: Response) => void;
    directory = () => new Promise<Response>(resolve => { answer = resolve; });
    await renderTasksPage('/tasks?projects=Storefront&phases=phase-rh-1');
    // Undecidable yet: nothing is hidden and nothing is cleared on a guess.
    expect(lastBoardQuery().get('phaseIds')).toBe('phase-rh-1');
    expect(notice()).toBeEmptyDOMElement();

    await act(async () => answer(new Response(JSON.stringify({ success: true, projects: PROJECTS }))));
    await flushRequests();
    expect(lastBoardQuery().get('phaseIds')).toBeNull();
    expect(addressBar().get('phases')).toBeNull();
    expect(notice()).toHaveTextContent(CLEARED_NOTICE);
  });

  test('when the Project directory cannot be read, nothing is cleared', async () => {
    directory = async () => { throw new Error('directory unavailable'); };
    await renderTasksPage('/tasks?projects=Storefront&phases=phase-rh-1');
    expect(lastBoardQuery().get('phaseIds')).toBe('phase-rh-1');
    expect(addressBar().get('phases')).toBe('phase-rh-1');
    expect(notice()).toBeEmptyDOMElement();
  });
});
