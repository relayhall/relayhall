// @vitest-environment jsdom
//
// RH-UI.12 (A2) — bulk archive-completed of the filtered scope + unarchive to
// the prior state (design 986be411 §4, E3/E5; resolves 7092b73d). Pins, on
// the production TasksPage:
//   - the id set comes from the server-side IDs-only scope read with the
//     current filters — never the loaded column window;
//   - the accessible confirm dialog (focus lands inside, count in the title,
//     Escape cancels) replaces the native confirm();
//   - client batching above the server cap, per-Task failures surfaced
//     honestly;
//   - unarchive goes through POST /tasks/:id/unarchive and announces the
//     server-derived target.

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { authenticatedFetch } from '../utils/auth';
import { TasksPage } from './TasksPage';

const toastSuccess = vi.fn();
const toastWarning = vi.fn();

vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: () => ({ subscribe: vi.fn(() => vi.fn()) }),
}));
vi.mock('../hooks/useToast', () => ({
  useToast: () => ({ toasts: [], success: toastSuccess, warning: toastWarning }),
}));
vi.mock('../hooks/usePrincipals', () => ({
  usePrincipals: () => ({ byId: new Map(), principals: [] }),
  useMyPrincipal: () => ({ me: null }),
}));
vi.mock('../components/tasks/TaskColumn', () => ({
  TaskColumn: ({ status, onRestoreArchived }: { status: string; onRestoreArchived?: (id: string) => void }) => (
    <section data-status={status}>
      {status === 'archived' && onRestoreArchived && (
        <button onClick={() => onRestoreArchived('11111111-1111-4111-8111-111111111111')}>Unarchive</button>
      )}
    </section>
  ),
}));
vi.mock('../components/Toast', () => ({ ToastContainer: () => null }));

const ALL_STATUSES = ['ideas', 'todo', 'in-progress', 'review', 'stuck', 'completed', 'archived'];
const createBoardColumns = () => Object.fromEntries(
  ALL_STATUSES.map(status => [status, { items: [], total: 0, offset: 0, limit: 6, hasMore: false }]),
);
let boardColumns = createBoardColumns();
let scopeIds: string[] = [];
const bulkCalls: Array<{ taskIds: string[] }> = [];
let bulkResponder: (body: { taskIds: string[] }) => { status: number; payload: unknown } = body => ({
  status: 200,
  payload: {
    success: true,
    results: body.taskIds.map(id => ({ id, archived: true, code: 'ARCHIVED' })),
    archivedCount: body.taskIds.length,
    failedCount: 0,
  },
});
let unarchiveResponder: () => { status: number; payload: unknown } = () => ({
  status: 200,
  payload: { success: true, task: { id: 'x' }, restoredTo: 'in-progress', derivedFrom: 'history' },
});

const flushRequests = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const renderTasksPage = async (initialEntry = '/tasks') => {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/tasks" element={<TasksPage />} />
      </Routes>
    </MemoryRouter>,
  );
  await flushRequests();
};

beforeEach(() => {
  localStorage.clear();
  boardColumns = createBoardColumns();
  scopeIds = [];
  bulkCalls.length = 0;
  toastSuccess.mockReset();
  toastWarning.mockReset();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  vi.mocked(authenticatedFetch).mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes('/tasks/filter-options')) {
      return new Response(JSON.stringify({ success: true, tags: [], projects: [] }));
    }
    if (url.includes('/tasks/board?')) {
      return new Response(JSON.stringify({ success: true, columns: boardColumns }));
    }
    if (url.endsWith('/phases')) {
      return new Response(JSON.stringify({ success: true, phases: [] }));
    }
    if (url.includes('/tasks/ids?')) {
      return new Response(JSON.stringify({ success: true, ids: scopeIds, total: scopeIds.length }));
    }
    if (url.endsWith('/tasks/bulk-archive')) {
      const body = JSON.parse(String(init?.body)) as { taskIds: string[] };
      bulkCalls.push(body);
      const { status, payload } = bulkResponder(body);
      return new Response(JSON.stringify(payload), { status });
    }
    if (url.includes('/unarchive')) {
      const { status, payload } = unarchiveResponder();
      return new Response(JSON.stringify(payload), { status });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const uuid = (index: number) => {
  const hex = index.toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-000000000000`;
};

describe('bulk archive-completed of the filtered scope (E3)', () => {
  test('reads the server-side id scope with the current filters and confirms with the server total', async () => {
    scopeIds = [uuid(1), uuid(2), uuid(3)];
    boardColumns.completed.total = 3;
    await renderTasksPage('/tasks?q=probe&projects=RelayHall');

    fireEvent.click(screen.getByRole('button', { name: 'Archive completed' }));
    await flushRequests();

    const idsRequest = vi.mocked(authenticatedFetch).mock.calls
      .map(([input]) => String(input))
      .find(url => url.includes('/tasks/ids?'));
    expect(idsRequest).toBeDefined();
    const idsQuery = new URL(idsRequest!, 'https://relayhall.local').searchParams;
    expect(idsQuery.get('statuses')).toBe('completed');
    expect(idsQuery.get('q')).toBe('probe');
    expect(idsQuery.get('projects')).toBe('RelayHall');

    const dialog = screen.getByRole('dialog', { name: 'Archive 3 completed tasks?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // Focus lands inside the dialog (§9 focus trap).
    expect(dialog.contains(document.activeElement)).toBe(true);
    // The scope summary names the active filters.
    expect(dialog.textContent).toContain('RelayHall');

    fireEvent.click(screen.getByRole('button', { name: 'Archive 3' }));
    await flushRequests();
    expect(bulkCalls).toHaveLength(1);
    expect(bulkCalls[0].taskIds).toEqual(scopeIds);
    expect(toastSuccess).toHaveBeenCalledWith('Archived 3 completed tasks');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('batches above the server cap and surfaces per-Task failures honestly', async () => {
    scopeIds = Array.from({ length: 450 }, (_, index) => uuid(index + 1));
    boardColumns.completed.total = 450;
    bulkResponder = body => ({
      status: 200,
      payload: {
        success: true,
        results: body.taskIds.map((id, index) => index === 0 && bulkCalls.length === 1
          ? { id, archived: false, code: 'NOT_COMPLETED', error: 'Task is stuck, not completed' }
          : { id, archived: true, code: 'ARCHIVED' }),
        archivedCount: 0,
        failedCount: 0,
      },
    });
    await renderTasksPage();

    fireEvent.click(screen.getByRole('button', { name: 'Archive completed' }));
    await flushRequests();
    fireEvent.click(screen.getByRole('button', { name: 'Archive 450' }));
    await flushRequests();
    await flushRequests();

    // Client batch is 50 (under the server cap of 200) after the live-QA
    // proxy-abort finding — 450 ids make nine batches.
    expect(bulkCalls).toHaveLength(9);
    expect(bulkCalls.every(call => call.taskIds.length <= 50)).toBe(true);
    expect(bulkCalls.reduce((sum, call) => sum + call.taskIds.length, 0)).toBe(450);
    expect(toastSuccess).toHaveBeenCalledWith('Archived 449 completed tasks');
    expect(toastWarning).toHaveBeenCalledWith('1 task could not be archived (NOT_COMPLETED)', 10000);
  });

  test('an empty scope warns instead of opening the dialog', async () => {
    scopeIds = [];
    await renderTasksPage();
    fireEvent.click(screen.getByRole('button', { name: 'Archive completed' }));
    await flushRequests();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toastWarning).toHaveBeenCalledWith('No completed tasks to archive in the current view');
  });

  test('Escape cancels the dialog without archiving', async () => {
    scopeIds = [uuid(1)];
    await renderTasksPage();
    fireEvent.click(screen.getByRole('button', { name: 'Archive completed' }));
    await flushRequests();
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await flushRequests();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(bulkCalls).toHaveLength(0);
  });
});

describe('unarchive to the prior state (E5, resolves 7092b73d)', () => {
  test('the archived-column action calls the unarchive endpoint and announces the derived target', async () => {
    await renderTasksPage('/tasks?archived=true');

    fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
    await flushRequests();

    const unarchiveRequest = vi.mocked(authenticatedFetch).mock.calls
      .map(([input]) => String(input))
      .find(url => url.includes('/unarchive'));
    expect(unarchiveRequest).toContain('/tasks/11111111-1111-4111-8111-111111111111/unarchive');
    expect(toastSuccess).toHaveBeenCalledWith('Unarchived to In Progress');
  });

  test('a server refusal is surfaced, never swallowed', async () => {
    unarchiveResponder = () => ({ status: 409, payload: { success: false, error: 'Task is not archived: x' } });
    await renderTasksPage('/tasks?archived=true');
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
    await flushRequests();
    expect(toastWarning).toHaveBeenCalledWith('Task is not archived: x');
    unarchiveResponder = () => ({
      status: 200,
      payload: { success: true, task: { id: 'x' }, restoredTo: 'in-progress', derivedFrom: 'history' },
    });
  });
});
