// @vitest-environment jsdom
//
// Owner ruling E395 on the production TasksPage under a real router, on the
// Board AND on the Map (one filter bar and one filter state serve both): a
// filter's own clear control leaves exactly the state a manual deselect of
// its selection leaves - the address bar, the stored filter state and the
// request the view sends - and leaves every other filter as it was. The
// selected items lead the list on the page as in the component.

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
// The Map's own rendering is not under test: what it is asked for is.
vi.mock('../components/map/MapView', () => ({
  MapView: ({ query }: { query: unknown }) => <output data-testid="map-query">{JSON.stringify(query)}</output>,
}));

const RELAYHALL_ID = '11111111-1111-4111-8111-111111111111';
const SHOP_ID = '22222222-2222-4222-8222-222222222222';
const PHASES = [
  { id: 'phase-rh-1', name: 'Release lane', position: 10, projectId: RELAYHALL_ID, status: 'todo' },
  { id: 'phase-shop-1', name: 'Shop launch', position: 1, projectId: SHOP_ID, status: 'todo' },
  { id: 'phase-shop-2', name: 'Checkout polish', position: 2, projectId: SHOP_ID, status: 'todo' },
];
const PROJECTS = [
  { id: RELAYHALL_ID, name: 'RelayHall', status: 'active' },
  { id: SHOP_ID, name: 'Storefront', status: 'active' },
];
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

const renderTasksPage = async (initialEntry: string) => {
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

const addressBar = () => new URLSearchParams(screen.getByTestId('location-search').textContent!);
const lastBoardQuery = () => vi.mocked(authenticatedFetch).mock.calls
  .map(([input]) => String(input))
  .filter(url => url.includes('/tasks/board?'))
  .map(url => new URL(url, 'https://relayhall.local').searchParams.toString())
  .at(-1) ?? null;
/** What the view on screen asks the server for. */
const viewRequest = (view: 'board' | 'map') =>
  view === 'map' ? screen.getByTestId('map-query').textContent : lastBoardQuery();
const trigger = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}\\b`) });

const LINK_FILTERS = 'priorities=high&statuses=review,todo&tags=alpha&projects=Storefront&phases=phase-shop-1';

/** Each filter, its address-bar key, and the selection a reader would untick by hand. */
const FILTERS = [
  { name: 'Priority', param: 'priorities', untick: ['high'] },
  { name: 'Status', param: 'statuses', untick: ['Review', 'To do'] },
  { name: 'Tags', param: 'tags', untick: ['alpha'] },
  { name: 'Project', param: 'projects', untick: ['#Storefront'] },
  { name: 'Phase', param: 'phases', untick: ['#1 Shop launch'] },
] as const;

interface Outcome { address: string; stored: string | null; request: string | null }
const outcome = (view: 'board' | 'map'): Outcome => ({
  address: screen.getByTestId('location-search').textContent!,
  stored: localStorage.getItem('relayhall-task-filters'),
  request: viewRequest(view),
});

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  vi.mocked(authenticatedFetch).mockImplementation(async input => {
    const url = String(input);
    if (url.includes('/tasks/filter-options')) {
      return new Response(JSON.stringify({ success: true, tags: ['alpha', 'beta'], projects: ['RelayHall', 'Storefront'] }));
    }
    if (url.includes('/tasks/board?')) {
      return new Response(JSON.stringify({ success: true, columns: createBoardColumns() }));
    }
    if (url.endsWith('/phases')) return new Response(JSON.stringify({ success: true, phases: PHASES }));
    if (url.endsWith('/projects?includeHidden=true&includeArchived=true')) {
      return new Response(JSON.stringify({ success: true, projects: PROJECTS }));
    }
    throw new Error(`Unexpected request: ${url}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe.each(['board', 'map'] as const)('on the %s', view => {
  test.each(FILTERS)('the $name x leaves the state a manual deselect leaves, and clears only that filter', async filter => {
    const link = `/tasks?view=${view}&${LINK_FILTERS}`;

    // By hand: open the filter and untick every selected item.
    await renderTasksPage(link);
    fireEvent.click(trigger(filter.name));
    act(() => { vi.advanceTimersByTime(20); });
    for (const label of filter.untick) fireEvent.click(screen.getByLabelText(label));
    await flushRequests();
    const byHand = outcome(view);
    cleanup();
    localStorage.clear();
    vi.mocked(authenticatedFetch).mockClear();

    // With the filter's own x.
    await renderTasksPage(link);
    fireEvent.click(screen.getByRole('button', { name: `Clear ${filter.name} filter` }));
    await flushRequests();
    const cleared = outcome(view);

    expect(cleared).toEqual(byHand);
    expect(addressBar().get(filter.param)).toBeNull();
    const kept = new URLSearchParams(LINK_FILTERS);
    kept.delete(filter.param);
    for (const [key, value] of kept) expect(addressBar().get(key), key).toBe(value);
    expect(addressBar().get('view')).toBe(view);
    expect(screen.queryByRole('button', { name: `Clear ${filter.name} filter` })).toBeNull();
    if (view === 'map') {
      expect(JSON.parse(cleared.request!)[filter.param]).toEqual([]);
    }
  });

  test('the in-menu Clear of one filter reaches the view request, the others stay', async () => {
    await renderTasksPage(`/tasks?view=${view}&${LINK_FILTERS}`);
    fireEvent.click(trigger('Project'));
    act(() => { vi.advanceTimersByTime(20); });
    const menu = trigger('Project').closest('.filter-dropdown')!.querySelector<HTMLElement>('.filter-dropdown-menu')!;
    // The page's Project list leads with the selection.
    expect(within(within(menu).getByRole('group', { name: 'Selected' })).getAllByRole('checkbox')
      .map(box => box.closest('label')!.textContent)).toEqual(['#Storefront']);
    fireEvent.click(within(menu).getByRole('button', { name: 'Clear Project filter' }));
    await flushRequests();
    expect(addressBar().get('projects')).toBeNull();
    expect(addressBar().get('phases')).toBe('phase-shop-1');
    if (view === 'map') {
      expect(JSON.parse(viewRequest('map')!)).toMatchObject({
        projects: [], phases: ['phase-shop-1'], tags: ['alpha'], priorities: ['high'], statuses: ['review', 'todo'],
      });
    } else {
      const request = new URLSearchParams(viewRequest('board')!);
      expect(request.get('projects')).toBeNull();
      expect(request.get('phaseIds')).toBe('phase-shop-1');
      expect(request.get('tags')).toBe('alpha');
    }
  });
});
