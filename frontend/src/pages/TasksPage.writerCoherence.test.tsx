// @vitest-environment jsdom
//
// Hardening 76d06394 — board-state writer coherence.
//
// The defect this pins: the synchronous snapshot (boardDataRef) used to be
// mirrored only DURING RENDER, while the fetch/load-more/deep-link writers
// used functional setState. Inside one batch — no render in between — the
// snapshot is stale, so a WS patch computed from it and written as a PLAIN
// value silently discards whatever the functional writer had just enqueued.
//
// HONESTY NOTE (falsification checked, per the wave's standing lesson).
// The behavioral interleaving below was run against the PRE-FIX source and
// PASSED there too: React commits the queued write before any later event
// can observe the snapshot, so the stale window is not reachable through
// the public surface. Those two tests are therefore BEHAVIOR-PRESERVATION
// pins, not proof of the fix — they must keep holding, but they do not
// falsify the defect. The falsifying regression for this card is the
// STRUCTURAL probe at the bottom of this file, which was verified to fail
// against the pre-fix source.

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { authenticatedFetch } from '../utils/auth';
import { TasksPage } from './TasksPage';

const wsHandlers = new Map<string, (msg: unknown) => void>();

vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    subscribe: (type: string, handler: (msg: unknown) => void) => {
      wsHandlers.set(type, handler);
      return () => {};
    },
    connected: true,
  }),
}));
vi.mock('../hooks/useToast', () => ({
  useToast: () => ({ toasts: [], success: vi.fn(), warning: vi.fn() }),
}));
vi.mock('../hooks/usePrincipals', () => ({
  usePrincipals: () => ({ byId: new Map(), principals: [] }),
  useMyPrincipal: () => ({ me: null }),
}));
vi.mock('../components/tasks/TaskColumn', () => ({
  TaskColumn: (props: any) => (
    <section data-status={props.status} data-count={props.tasks.length} data-total={props.total}>
      {props.tasks.map((task: any) => (
        <span key={task.id} data-task={task.id} data-title={task.title} />
      ))}
      {props.hasMore && <button onClick={props.onLoadMore}>load more {props.status}</button>}
    </section>
  ),
}));
vi.mock('../components/Toast', () => ({ ToastContainer: () => null }));

const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const mkTask = (n: number, status: string, title?: string) => ({
  id: uuid(n), title: title ?? `Task ${n}`, description: '', status, priority: 'normal',
  tags: [], subtasks: [], links: [], sessionRefs: [], autoCreated: false, autoStart: false,
  blockedBy: [], dependsOn: [], project: null, phaseId: null,
  created: '2026-08-16T10:00:00.000Z', updated: '2026-08-16T12:00:00.000Z',
});

const ALL = ['ideas', 'todo', 'in-progress', 'review', 'stuck', 'completed', 'archived'];
let boardColumns: Record<string, any>;
// Load-more page two, released by the test so a WS patch can land in the
// same batch as its resolution.
let pendingSecondPage: ((response: Response) => void) | null = null;

const flush = async () => {
  await act(async () => {
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  });
};

const renderPage = async () => {
  render(
    <MemoryRouter initialEntries={['/tasks']}>
      <Routes><Route path="/tasks" element={<TasksPage />} /></Routes>
    </MemoryRouter>,
  );
  await flush();
};

const todoColumn = () => document.querySelector('[data-status="todo"]')!;
const loadedIds = () => [...todoColumn().querySelectorAll('[data-task]')]
  .map(node => node.getAttribute('data-task'));
const titleOf = (n: number) =>
  todoColumn().querySelector(`[data-task="${uuid(n)}"]`)?.getAttribute('data-title');

beforeEach(() => {
  localStorage.clear();
  wsHandlers.clear();
  pendingSecondPage = null;
  boardColumns = Object.fromEntries(ALL.map(status =>
    [status, { items: [], total: 0, offset: 0, limit: 50, hasMore: false }]));
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  vi.mocked(authenticatedFetch).mockImplementation(async input => {
    const url = String(input);
    if (url.includes('/tasks/filter-options')) {
      return new Response(JSON.stringify({ success: true, tags: [], projects: [] }));
    }
    if (url.includes('/tasks/board?')) {
      const offsetTodo = new URL(url, 'https://x').searchParams.get('offset_todo');
      if (offsetTodo && Number(offsetTodo) > 0) {
        const page = new Response(JSON.stringify({
          success: true,
          columns: {
            todo: {
              items: [mkTask(2, 'todo')], total: 2,
              offset: Number(offsetTodo), limit: 50, hasMore: false,
            },
          },
        }));
        if (pendingSecondPage === null) return page;
        // Hand control of the resolution to the test.
        return new Promise<Response>(resolve => { pendingSecondPage = resolve; });
      }
      return new Response(JSON.stringify({ success: true, columns: boardColumns }));
    }
    if (url.includes('/tasks/graph?')) {
      return new Response(JSON.stringify({
        success: true, lod: 'task', nodes: [], edges: [],
        generatedAt: new Date().toISOString(), fullCount: 0,
      }));
    }
    if (url.endsWith('/phases')) return new Response(JSON.stringify({ success: true, phases: [] }));
    throw new Error(`Unexpected request: ${url}`);
  });
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('board-state writer coherence (76d06394)', () => {
  test('a WS patch batched with an in-flight load-more keeps BOTH results', async () => {
    boardColumns.todo = {
      items: [mkTask(1, 'todo')], total: 2, offset: 0, limit: 50, hasMore: true,
    };
    await renderPage();
    expect(loadedIds()).toEqual([uuid(1)]);

    // Arm the deferred second page, then start the load-more.
    pendingSecondPage = () => {};
    await act(async () => { fireEvent.click(screen.getByText('load more todo')); });
    await flush();

    const release = pendingSecondPage!;
    await act(async () => {
      // Both writers must land in ONE batch with NO render in between —
      // the only window in which a stale snapshot can overwrite an
      // already-queued update. Awaiting between them would let React
      // commit and refresh the snapshot, which is precisely how a lenient
      // version of this test passes against the defect it claims to pin.
      release(new Response(JSON.stringify({
        success: true,
        columns: {
          todo: { items: [mkTask(2, 'todo')], total: 2, offset: 1, limit: 50, hasMore: false },
        },
      })));
      // Microtask 1 resolves the fetch, microtask 2 resolves .json() and
      // queues the load-more write; the WS patch runs in microtask 3 —
      // still the same batch.
      queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
        wsHandlers.get('task.updated')!({ task: mkTask(1, 'todo', 'Task 1 patched') });
      })));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await flush();

    // Neither writer may erase the other.
    expect(loadedIds()).toEqual([uuid(1), uuid(2)]);
    expect(titleOf(1)).toBe('Task 1 patched');
  });

  test('two WS patches in one batch compose instead of overwriting', async () => {
    boardColumns.todo = {
      items: [mkTask(1, 'todo'), mkTask(2, 'todo')], total: 2, offset: 0, limit: 50, hasMore: false,
    };
    await renderPage();
    expect(loadedIds()).toEqual([uuid(1), uuid(2)]);

    await act(async () => {
      wsHandlers.get('task.updated')!({ task: mkTask(1, 'todo', 'first patched') });
      wsHandlers.get('task.updated')!({ task: mkTask(2, 'todo', 'second patched') });
    });
    await flush();

    expect(titleOf(1)).toBe('first patched');
    expect(titleOf(2)).toBe('second patched');
  });
});

describe('every board-state writer goes through the coherent commit path', () => {
  // FALSIFYING regression (verified to fail against the pre-fix source):
  // the defect was structural — a snapshot mirrored during render plus
  // functional writers that never advanced it. The behavioral interleaving
  // it enabled could NOT be forced through the public surface (React commits
  // between the queued write and any later event, refreshing the snapshot),
  // so a behavioral test would pass either way and pin nothing. This probe
  // pins the structure the hardening card actually requires instead.
  test('no raw setBoardData writer and no render-time snapshot mutation', async () => {
    const source = ((await import('./TasksPage.tsx?raw')) as any).default as string;
    expect(source.length).toBeGreaterThan(0);

    // The snapshot is never assigned at render scope (a discarded render
    // would otherwise publish state React never committed).
    expect(source).not.toMatch(/^\s{2}boardDataRef\.current = boardData;/m);

    // setBoardData is reachable only from its declaration and from the one
    // commit helper that advances the snapshot in the same breath.
    const callSites = [...source.matchAll(/setBoardData\(/g)];
    expect(callSites).toHaveLength(1);
    const commitHelper = source.match(
      /const commitBoard = useCallback\([\s\S]*?\n {2}\}, \[\]\);/);
    expect(commitHelper).not.toBeNull();
    expect(commitHelper![0]).toContain('boardDataRef.current = next;');
    expect(commitHelper![0]).toContain('setBoardData(next);');

    // Every board writer names the helper.
    expect(source).toMatch(/commitBoard\(patchFromSnapshot\)/);
    expect([...source.matchAll(/commitBoard\(/g)].length).toBeGreaterThanOrEqual(6);
  });
});
