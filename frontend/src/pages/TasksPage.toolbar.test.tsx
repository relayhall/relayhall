// @vitest-environment jsdom
//
// RH-UI.11 (A1) — toolbar & filter unification (design 986be411 §2/§3).
// Pins, on the production TasksPage under a real router:
//   - the search reveal (amendment 2d5e2caa Ruling 2): panel hidden until
//     Search is activated; Escape returns focus to the control; deep links
//     carrying filters open revealed;
//   - the Board|Map segmented switcher: radio-group semantics, live Map
//     entry, enumerated ?view= fallback;
//   - distinct toolbar actions with sentence-case labels;
//   - the one-URL-encoding round trip for the whole filter state;
//   - the ≤767px recomposition: search icon-button + overflow menu.

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { authenticatedFetch } from '../utils/auth';
import { TasksPage, resolveTaskView } from './TasksPage';

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
  // react-query exactly like every other surface — so the harness supplies a
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

describe('search reveal (amendment 2d5e2caa Ruling 2)', () => {
  test('the panel is hidden until Search is activated, then focuses the input', async () => {
    await renderTasksPage();

    expect(screen.queryByPlaceholderText('Search tasks by title or description...')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Search and filter' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    const search = screen.getByPlaceholderText('Search tasks by title or description...');
    expect(search.closest('.search-filter-panel')).toHaveClass('search-filter-panel-open');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  test('Escape in the panel collapses it and returns focus to the Search control', async () => {
    await renderTasksPage();

    fireEvent.click(screen.getByRole('button', { name: 'Search and filter' }));
    const search = screen.getByPlaceholderText('Search tasks by title or description...');
    search.focus();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByPlaceholderText('Search tasks by title or description...')).toBeNull();
    expect(screen.getByRole('button', { name: 'Search and filter' })).toHaveFocus();
  });

  test('a deep link carrying a restored filter opens with the panel revealed', async () => {
    await renderTasksPage('/tasks?q=hello');

    const search = screen.getByPlaceholderText('Search tasks by title or description...');
    expect(search.closest('.search-filter-panel')).toHaveClass('search-filter-panel-open');
  });
});

describe('Board|Map view switcher (§2.2)', () => {
  test('renders as one radio group with Board selected and the Map entry LIVE', async () => {
    await renderTasksPage();

    const viewGroup = screen.getByRole('radiogroup', { name: 'Task view' });
    const board = screen.getByRole('radio', { name: 'Board' });
    const map = screen.getByRole('radio', { name: 'Map' });

    expect(viewGroup).toContainElement(board);
    expect(viewGroup).toContainElement(map);
    expect(board).toHaveAttribute('aria-checked', 'true');
    expect(board).toHaveAttribute('tabindex', '0');
    // A7a: the Map exists, so the entry stops being an honest placeholder.
    expect(map).toBeEnabled();
    expect(map).toHaveAttribute('aria-checked', 'false');
    // Roving tab stop: the unselected member is reachable by arrow, not tab.
    expect(map).toHaveAttribute('tabindex', '-1');
  });

  test('falls back from an unknown ?view= value to the enumerated Board default', async () => {
    await renderTasksPage('/tasks?view=sideways');

    expect(screen.getByRole('radio', { name: 'Board' })).toHaveAttribute('aria-checked', 'true');
    expect(resolveTaskView('sideways')).toBe('board');
    expect(resolveTaskView(null)).toBe('board');
    // The enumerated set still rejects anything not in the registry, but a
    // LIVE registry entry now resolves to itself.
    expect(resolveTaskView('map')).toBe('map');
  });

  test('a ?view=map deep link selects the Map and renders it instead of the board grid', async () => {
    await renderTasksPage('/tasks?view=map');

    const board = screen.getByRole('radio', { name: 'Board' });
    const map = screen.getByRole('radio', { name: 'Map' });
    // The a11y invariant this test exists for (review f4ec788c B1) still
    // holds, now with the selection on the Map: exactly one selected,
    // tabbable radio, and no disabled selection stranded without a tab stop.
    expect(map).toHaveAttribute('aria-checked', 'true');
    expect(map).toHaveAttribute('tabindex', '0');
    expect(map).toBeEnabled();
    expect(board).toHaveAttribute('aria-checked', 'false');
    expect(board).toHaveAttribute('tabindex', '-1');
    // The Map replaces the board grid rather than rendering beside it.
    expect(document.querySelector('.tasks-page-board')).toBeNull();
    expect(screen.getByRole('region', { name: 'Task map' })).toBeInTheDocument();
  });
});

describe('distinct toolbar actions (§2.3–§2.5)', () => {
  test('Show archived is an eye-icon toggle with aria-pressed; Archive completed keeps the unique archive icon and a server-total badge', async () => {
    boardColumns.completed.total = 2;
    boardColumns.archived.total = 3;
    await renderTasksPage();

    const showArchived = screen.getByRole('button', { name: 'Show archived' });
    const archiveCompleted = screen.getByRole('button', { name: 'Archive completed' });

    expect(showArchived).toHaveAttribute('aria-pressed', 'false');
    expect(showArchived.querySelector('.lucide-eye')).not.toBeNull();
    expect(showArchived.querySelector('.lucide-archive')).toBeNull();
    expect(archiveCompleted.querySelector('.lucide-archive')).not.toBeNull();
    expect(archiveCompleted.querySelector('.tasks-action-count')).toHaveTextContent('2');
    expect(screen.getByRole('button', { name: 'Create new task' })).toHaveTextContent('New task');

    fireEvent.click(showArchived);
    expect(showArchived).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('one URL encoding for view and filters (§3)', () => {
  test('a deep link restores the full filter state, drives the board query server-side, and round-trips', async () => {
    const entry = '/tasks?view=board&q=linked&projects=RelayHall&statuses=review&tags=frontend,ux&assignee=alice&phases=phase-1&archived=true&priorities=high';
    await renderTasksPage(entry);

    expect(screen.getByPlaceholderText('Search tasks by title or description...')).toHaveValue('linked');
    expect(screen.getByRole('button', { name: 'Show archived' })).toHaveAttribute('aria-pressed', 'true');

    const firstBoardRequest = vi.mocked(authenticatedFetch).mock.calls
      .map(([input]) => String(input))
      .find(url => url.includes('/tasks/board?'));
    expect(firstBoardRequest).toBeDefined();
    const firstBoardQuery = new URL(firstBoardRequest!, 'https://relayhall.local').searchParams;
    expect(firstBoardQuery.get('q')).toBe('linked');
    expect(firstBoardQuery.get('projects')).toBe('RelayHall');
    // A status filter narrows the fetched columns; archived is always fetched
    // so the hidden-archived count stays honest.
    expect(firstBoardQuery.get('statuses')).toBe('review,archived');
    expect(firstBoardQuery.get('tags')).toBe('frontend,ux');
    expect(firstBoardQuery.get('owner')).toBe('alice');
    expect(firstBoardQuery.get('phaseIds')).toBe('phase-1');
    expect(firstBoardQuery.get('includeArchived')).toBe('true');
    expect(firstBoardQuery.get('priorities')).toBe('high');

    const encodedSearch = screen.getByTestId('location-search').textContent!;
    expect(encodedSearch).toContain('q=linked');
    cleanup();
    vi.mocked(authenticatedFetch).mockClear();
    await renderTasksPage(`/tasks${encodedSearch}`);

    expect(screen.getByPlaceholderText('Search tasks by title or description...')).toHaveValue('linked');
    expect(screen.getByRole('button', { name: 'Show archived' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('radio', { name: 'Board' })).toHaveAttribute('aria-checked', 'true');
  });

  test('the legacy ?tag= entry alias still lands as a tag filter', async () => {
    await renderTasksPage('/tasks?tag=frontend');
    const encodedSearch = screen.getByTestId('location-search').textContent!;
    expect(encodedSearch).toContain('tags=frontend');
    expect(encodedSearch).not.toContain('tag=frontend&');
  });
});

describe('mobile toolbar recomposition (§2 mobile)', () => {
  beforeEach(() => {
    setViewportWidth(390);
  });

  test('search collapses behind an icon-button whose visibility never depends on filter state', async () => {
    await renderTasksPage();

    const toggle = screen.getByRole('button', { name: 'Search and filter' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByPlaceholderText('Search tasks by title or description...').closest('.search-filter-panel'))
      .toHaveClass('search-filter-panel-open');
    // Collapsing again hides the bar but the TOGGLE stays — visibility is
    // structural, never a function of the filter count.
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Search and filter' })).toBeInTheDocument();
  });

  test('selecting the Map at 390px removes the Board status tabs entirely', async () => {
    // Review b74ba787 B2: `.tasks-mobile-tabs` rendered on isMobile alone, so
    // ?view=map at 390px kept live Ideas/To Do/In Progress buttons above the
    // Map, driving mobileActiveTab — state the Map does not consume.
    await renderTasksPage('/tasks?view=map');

    expect(screen.getByRole('region', { name: 'Task map' })).toBeInTheDocument();
    // Absent, not merely hidden: a hidden control is still a control.
    expect(document.querySelector('.tasks-mobile-tabs')).toBeNull();
    expect(document.querySelectorAll('.tasks-mobile-tab')).toHaveLength(0);
    // And the Board grid itself is gone, as the switcher test already pins.
    expect(document.querySelector('.tasks-page-board')).toBeNull();
  });

  test('the Board at 390px still has its status tabs', async () => {
    // The other half of the guard: gating the tabs on the view must not take
    // them away from the surface that owns them.
    await renderTasksPage('/tasks');

    expect(document.querySelector('.tasks-mobile-tabs')).not.toBeNull();
    expect(document.querySelectorAll('.tasks-mobile-tab').length).toBeGreaterThan(0);
  });

  test('Show archived and Archive completed live in the overflow menu with full labels; Escape closes and refocuses the trigger', async () => {
    boardColumns.completed.total = 4;
    await renderTasksPage();

    // The two actions never render as adjacent identical-icon buttons.
    expect(screen.queryByRole('button', { name: 'Show archived' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive completed' })).toBeNull();

    const trigger = screen.getByRole('button', { name: 'More actions' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const menu = screen.getByRole('menu', { name: 'More actions' });
    const showArchivedItem = screen.getByRole('menuitemcheckbox', { name: 'Show archived' });
    const archiveCompletedItem = screen.getByRole('menuitem', { name: 'Archive completed 4' });
    expect(menu).toContainElement(showArchivedItem);
    expect(menu).toContainElement(archiveCompletedItem);
    // The menu is mounted outside its trigger.
    expect(trigger.contains(menu)).toBe(false);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'More actions' })).toBeNull();
    expect(trigger).toHaveFocus();
  });
});
