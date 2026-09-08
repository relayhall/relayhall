// @vitest-environment jsdom
/**
 * TasksPage.virtualKeyboard.test.tsx — A4 round 2 (review 3bb32ead B1):
 * the roving keyboard contract ACROSS the virtualization boundary, on the
 * production TasksPage with the production TaskColumn/TaskCard (nothing
 * board-side mocked). 200 loaded Tasks mount only a window; End must land on
 * the TRUE loaded column end, arrows must cross the mounted boundary, and
 * exactly one opener stays in the tab order throughout.
 */
import '@testing-library/jest-dom/vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { authenticatedFetch } from '../utils/auth';
import { TasksPage } from './TasksPage';

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useParams: () => ({}),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: '/tasks', search: '', hash: '', state: null, key: 'test' }),
}));
vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ subscribe: vi.fn(() => vi.fn()), connected: true }) }));
vi.mock('../hooks/useToast', () => ({
  useToast: () => ({ toasts: [], success: vi.fn(), warning: vi.fn() }),
}));
vi.mock('../hooks/usePrincipals', () => ({
  usePrincipals: () => ({ byId: new Map(), principals: [] }),
  useMyPrincipal: () => ({ me: null }),
}));
vi.mock('../components/tasks/FilterBar', () => ({ FilterBar: () => null }));
vi.mock('../components/Toast', () => ({ ToastContainer: () => null }));

const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
const makeTask = (n: number) => ({
  id: uuid(n), title: `Card ${n}`, status: 'todo', priority: 'normal', tags: [], subtasks: [],
  created: `2026-08-15T0${n % 2}:${String(n % 60).padStart(2, '0')}:00.000Z`, updated: '',
});
const COUNT = 200;
const board = {
  success: true,
  columns: Object.fromEntries(
    ['ideas', 'todo', 'in-progress', 'review', 'stuck', 'completed', 'archived'].map(status => [
      status,
      status === 'todo'
        ? { items: Array.from({ length: COUNT }, (_, index) => makeTask(index + 1)), total: COUNT, offset: 0, limit: 200, hasMore: false }
        : { items: [], total: 0, offset: 0, limit: 200, hasMore: false },
    ]),
  ),
};

beforeEach(() => {
  vi.clearAllMocks();
  window.matchMedia = window.matchMedia || (((query: string) => ({
    matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, onchange: null, dispatchEvent: () => false,
  })) as any);
  vi.mocked(authenticatedFetch).mockImplementation(async input => {
    const url = String(input);
    if (url.includes('/tasks/filter-options')) return new Response(JSON.stringify({ success: true, tags: [], projects: [] }), { status: 200 });
    if (url.includes('/tasks/board?')) return new Response(JSON.stringify(board), { status: 200 });
    if (url.includes('/principals')) return new Response(JSON.stringify({ success: true, principals: [] }), { status: 200 });
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
});
afterEach(() => cleanup());

const openers = () => Array.from(document.querySelectorAll('.task-card-open-button')) as HTMLElement[];
const press = (key: string) => fireEvent.keyDown(window, { key });

describe('roving keyboard across the virtualization boundary (review 3bb32ead B1)', () => {
  test('End lands on the TRUE loaded column end even though only a window is mounted', async () => {
    render(<TasksPage />);
    await waitFor(() => expect(openers().length).toBeGreaterThan(0));
    // Virtualization is active: far fewer than 200 cards are mounted.
    expect(openers().length).toBeLessThan(COUNT);

    openers()[0].focus();
    press('End');
    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active?.getAttribute('data-task-id')).toBe(uuid(COUNT));
    });
    // One-tab-stop invariant survives the jump.
    const tabbable = openers().filter(node => node.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0].getAttribute('data-task-id')).toBe(uuid(COUNT));
  });

  test('ArrowUp from the end crosses back over the boundary; Home returns to the first loaded card', async () => {
    render(<TasksPage />);
    await waitFor(() => expect(openers().length).toBeGreaterThan(0));
    openers()[0].focus();
    press('End');
    await waitFor(() => expect((document.activeElement as HTMLElement)?.getAttribute('data-task-id')).toBe(uuid(COUNT)));

    press('ArrowUp');
    await waitFor(() => expect((document.activeElement as HTMLElement)?.getAttribute('data-task-id')).toBe(uuid(COUNT - 1)));

    press('Home');
    await waitFor(() => expect((document.activeElement as HTMLElement)?.getAttribute('data-task-id')).toBe(uuid(1)));
  });
});
