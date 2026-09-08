// @vitest-environment jsdom
/**
 * TasksPage.boardKeyboard.test.tsx — C2 §2.2 board keyboard contract
 * (review 324cebef B4): a true roving tab stop over card openers — exactly
 * one opener tabbable, arrows move the stop within/across columns, Home/End
 * jump column ends, edges clamp, and the handler never captures arrows from
 * inputs or other controls. Runs against the REAL TaskColumn/TaskCard tree.
 */
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { authenticatedFetch } from '../utils/auth';
import { TasksPage } from './TasksPage';

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useParams: () => ({}),
  useLocation: () => ({ pathname: '/tasks', search: '?view=board&q=roving', hash: '', state: null, key: 'test' }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useNavigate: () => navigate,
}));
vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ subscribe: vi.fn(() => vi.fn()) }) }));
vi.mock('../hooks/useToast', () => ({
  useToast: () => ({ toasts: [], success: vi.fn(), warning: vi.fn() }),
}));
vi.mock('../components/tasks/FilterBar', () => ({ FilterBar: () => null }));
vi.mock('../components/Toast', () => ({ ToastContainer: () => null }));

const makeTask = (id: string, title: string, status: string) => ({
  id, title, status, priority: 'normal', tags: [], subtasks: [], created: '', updated: '',
});
const board = {
  success: true,
  columns: {
    // ideas is populated but COLLAPSED by default: its cards render no
    // openers, so the roving stop must never land there (review 9d14f226)
    ideas: {
      items: [makeTask('11111111-1111-4111-8111-000000000009', 'Hidden idea', 'ideas')],
      total: 1, offset: 0, limit: 6, hasMore: false,
    },
    todo: {
      items: [
        makeTask('11111111-1111-4111-8111-000000000001', 'Todo one', 'todo'),
        makeTask('11111111-1111-4111-8111-000000000002', 'Todo two', 'todo'),
      ], total: 2, offset: 0, limit: 6, hasMore: false,
    },
    'in-progress': {
      items: [makeTask('11111111-1111-4111-8111-000000000003', 'Progress one', 'in-progress')],
      total: 1, offset: 0, limit: 6, hasMore: false,
    },
    review: { items: [], total: 0, offset: 0, limit: 6, hasMore: false },
    stuck: { items: [], total: 0, offset: 0, limit: 6, hasMore: false },
    completed: { items: [], total: 0, offset: 0, limit: 6, hasMore: false },
    archived: { items: [], total: 0, offset: 0, limit: 6, hasMore: false },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  window.matchMedia = window.matchMedia || (((query: string) => ({
    matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, onchange: null, dispatchEvent: () => false,
  })) as any);
  vi.mocked(authenticatedFetch).mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/tasks/filter-options')) {
      return new Response(JSON.stringify({ success: true, tags: [], projects: [] }), { status: 200 });
    }
    if (url.includes('/tasks/board?')) {
      return new Response(JSON.stringify(board), { status: 200 });
    }
    if (url.includes('/principals')) {
      return new Response(JSON.stringify({ success: true, principals: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
});
afterEach(() => cleanup());

const openers = () => Array.from(document.querySelectorAll('.task-card-open-button')) as HTMLElement[];
const arrow = (key: string) => fireEvent.keyDown(window, { key });

async function renderBoard() {
  render(<TasksPage />);
  await waitFor(() => expect(openers().length).toBe(3));
  return openers();
}

describe('board roving tab stop (C2 §2.2)', () => {
  test('exactly ONE opener is in the tab order after load', async () => {
    const all = await renderBoard();
    expect(all.filter(o => o.tabIndex === 0)).toHaveLength(1);
    expect(all.filter(o => o.tabIndex === -1)).toHaveLength(2);
  });

  test('ArrowDown/ArrowUp move focus AND the roving stop within the column; edges clamp', async () => {
    const all = await renderBoard();
    const [todoOne, todoTwo] = all;
    todoOne.focus();
    arrow('ArrowDown');
    expect(document.activeElement).toBe(todoTwo);
    await waitFor(() => expect(todoTwo.tabIndex).toBe(0));
    expect(todoOne.tabIndex).toBe(-1);
    arrow('ArrowDown'); // bottom edge clamps
    expect(document.activeElement).toBe(todoTwo);
    arrow('ArrowUp');
    expect(document.activeElement).toBe(todoOne);
    await waitFor(() => expect(todoOne.tabIndex).toBe(0));
    arrow('ArrowUp'); // top edge clamps
    expect(document.activeElement).toBe(todoOne);
  });

  test('ArrowRight/ArrowLeft cross columns; Home/End jump to column ends', async () => {
    const all = await renderBoard();
    const [todoOne, todoTwo, progressOne] = all;
    todoTwo.focus();
    arrow('ArrowRight');
    expect(document.activeElement).toBe(progressOne);
    await waitFor(() => expect(progressOne.tabIndex).toBe(0));
    arrow('ArrowLeft');
    // the roving row index clamped to 0 in the one-card column, so the
    // return lands on the todo column's first opener
    expect(document.activeElement).toBe(todoOne);
    arrow('Home');
    expect(document.activeElement).toBe(todoOne);
    arrow('End');
    expect(document.activeElement).toBe(todoTwo);
  });

  test('arrows are NOT captured while focus is on an input or any non-opener control', async () => {
    const all = await renderBoard();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    arrow('ArrowDown');
    expect(document.activeElement).toBe(input);
    expect(all.every(o => o !== document.activeElement)).toBe(true);
    input.remove();
    // a non-opener button keeps its own arrows too
    const handle = document.querySelector('.task-card-drag-handle') as HTMLElement;
    handle.focus();
    arrow('ArrowDown');
    expect(document.activeElement).toBe(handle);
  });

  test('focusing any opener re-roves the single tab stop', async () => {
    const all = await renderBoard();
    const [todoOne, , progressOne] = all;
    todoOne.focus();
    await waitFor(() => expect(todoOne.tabIndex).toBe(0));
    progressOne.focus();
    await waitFor(() => expect(progressOne.tabIndex).toBe(0));
    expect(todoOne.tabIndex).toBe(-1);
    expect(openers().filter(o => o.tabIndex === 0)).toHaveLength(1);
  });
});


describe('roving stop selects only RENDERED openers (review 9d14f226)', () => {
  test('a populated but collapsed first column never captures the stop', async () => {
    // ideas holds the board-order-first task but is collapsed by default:
    // exactly one RENDERED opener (in todo) must carry tabIndex 0.
    const all = await renderBoard();
    expect(all.map(o => o.textContent)).not.toContain('Hidden idea');
    const zero = all.filter(o => o.tabIndex === 0);
    expect(zero).toHaveLength(1);
    expect(zero[0].textContent).toBe('Todo one');
  });

  test('mobile renders one column and keeps a valid single stop across tab switches', async () => {
    (window as any).innerWidth = 390;
    window.dispatchEvent(new Event('resize'));
    render(<TasksPage />);
    await waitFor(() => expect(openers().length).toBeGreaterThan(0));
    // only the active tab column is mounted
    const columns = Array.from(document.querySelectorAll('.task-column'));
    expect(columns.length).toBeLessThanOrEqual(1);
    expect(openers().filter(o => o.tabIndex === 0)).toHaveLength(1);
    // switch to the in-progress tab: the stop must land on a rendered opener
    const progressTab = Array.from(document.querySelectorAll('.tasks-mobile-tab'))
      .find(tab => tab.textContent?.trim().startsWith('In')) as HTMLElement;
    expect(progressTab).toBeTruthy();
    fireEvent.click(progressTab);
    await waitFor(() => {
      const current = openers();
      expect(current.length).toBe(1);
      expect(current.filter(o => o.tabIndex === 0)).toHaveLength(1);
    });
    (window as any).innerWidth = 1280;
    window.dispatchEvent(new Event('resize'));
  });
});

describe('responsive geometry pin (C2 §2.1, review 324cebef B2)', () => {
  test('the 48px left padding survives the mobile breakpoint', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const css = fs.readFileSync(path.resolve(__dirname, '../components/tasks/TaskCard.css'), 'utf-8');
    // base rule
    expect(css).toMatch(/\.task-card-compact \{[^}]*padding-left: 48px/s);
    // the mobile override must keep the left band clear — never a bare
    // four-side reset
    const mobile = css.slice(css.indexOf('@media (max-width: 767px)'));
    const mobileCompact = mobile.match(/\.task-card-compact \{[^}]*\}/s);
    expect(mobileCompact).toBeTruthy();
    expect(mobileCompact![0]).toContain('48px');
    expect(mobileCompact![0]).not.toMatch(/padding: 12px;\s*\}/);
  });

  test('raised card layers are pointer-transparent so the open surface takes card-body hits', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const css = fs.readFileSync(path.resolve(__dirname, '../components/tasks/TaskCard.css'), 'utf-8');
    const raised = css.match(/\.task-card-compact-header,[\s\S]*?\{[\s\S]*?\}/);
    expect(raised).toBeTruthy();
    expect(raised![0]).toContain('pointer-events: none');
    expect(css).toMatch(/\.task-card-compact-header button,[\s\S]*?pointer-events: auto/);
    // opener focus stays inset — the duplicate positive offset must not return
    const focus = css.match(/\.task-card-open-button:focus-visible \{[\s\S]*?\}/);
    expect(focus![0]).toContain('outline-offset: -2px');
    expect(focus![0]).not.toContain('outline-offset: 2px');
  });
});

describe('board-origin URL handoff (review f4ec788c B2)', () => {
  test('activating a card opener captures the FULL board URL for the details return path', async () => {
    sessionStorage.clear();
    const all = await renderBoard();
    const opener = document.querySelector('.task-card-open-button') as HTMLButtonElement;
    expect(opener).not.toBeNull();
    fireEvent.click(opener);
    const raw = sessionStorage.getItem('relayhall-task-board-origin');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).boardUrl).toBe('/tasks?view=board&q=roving');
    void all;
  });
});
