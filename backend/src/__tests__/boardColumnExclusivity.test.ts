/**
 * A board column holds exactly the status it is named after.
 *
 * Owner-reported from the running product (task f9c9537d): a task whose status
 * was `review` rendered in BOTH the Review and the Stuck column, and Stuck's
 * per-column `total` counted it too. The cause was inherited from the predecessor
 * board's import (e854a3f) — `queryBoardColumns` widened the Stuck column's query to
 * ['stuck', 'review'].
 *
 * The rule is not "stop special-casing review". It is the CLASS: no column may
 * widen its query to sweep in another status, because a Kanban board whose
 * columns overlap cannot answer the question each column exists to answer —
 * `stuck` means something is WRONG, `review` means something is WAITING.
 *
 * These tests therefore assert the invariant over EVERY column rather than
 * checking the one that was broken. A future column that borrows another
 * status fails here without anyone remembering this incident.
 */
import { TaskManagerDB } from '../services/TaskManagerDB';
import { authorizationRepository } from '../services/AuthorizationRepository';

const mockQuery = jest.fn();

jest.mock('../db/connection', () => ({
  pool: {
    query: (...args: any[]) => mockQuery(...args),
    connect: jest.fn(),
  },
}));

const BOARD_COLUMNS = ['ideas', 'todo', 'in-progress', 'review', 'stuck', 'completed', 'archived'];

/**
 * This suite measures COLUMN MEMBERSHIP, not authorization. The board's
 * narrowing became a required parameter with card 08f42f36, so it is supplied
 * here as the WIDEST scope there is (a root actor renders the predicate as
 * `TRUE`, binding no parameters) - which is also the only scope that cannot
 * mask the defect this suite exists for: a column that borrows another status
 * must still show up as a duplicate.
 */
const WIDEST_SCOPE = authorizationRepository.listScope(
  {
    principalId: null,
    handle: 'board-column-exclusivity-suite',
    role: 'admin',
    scopes: ['root'],
    authenticated: true,
    delegation: null,
  },
  'task',
  'read',
);

/** One task per status, so any overlap between columns is visible as a duplicate. */
const TASKS = BOARD_COLUMNS.map((status, index) => ({
  id: `0000000${index}-0000-4000-8000-000000000000`,
  title: `A task in ${status}`,
  description: '',
  status,
  priority: 'normal',
  project_id: null,
  thinking_budget: 'medium',
  thinking_auto_estimated: false,
  model: null,
  execution_mode: 'main',
  auto_created: false,
  auto_start: false,
  blocked_reason: null,
  status_reason: null,
  active_agent: null,
  completed_by: null,
  attempt_count: 0,
  session_refs: [],
  parent_id: null,
  personality_id: null,
  created_at: '2026-08-12T00:00:00.000Z',
  updated_at: '2026-08-12T00:00:00.000Z',
  started_at: null,
  completed_at: null,
  archived_at: null,
  at_slug: null,
  at_name: null,
  at_color: null,
  at_category: null,
}));

/**
 * A pool that behaves like the table rather than replaying a fixed script: it
 * reads the status array the service actually passed and answers with the
 * matching rows. That is what makes the duplicate observable — a mock that
 * returned canned rows would pass whatever the query said.
 */
function serveFromStatuses() {
  mockQuery.mockImplementation(async (sql: string, params: any[] = []) => {
    if (/FROM subtasks|FROM task_tags|FROM task_dependencies|FROM task_/i.test(sql)) {
      return { rows: [] };
    }
    const statuses: string[] = (params.find(Array.isArray) as string[]) || [];
    const matching = TASKS.filter((task) => statuses.includes(task.status));
    if (/COUNT\(\*\)/i.test(sql)) {
      return { rows: [{ total: matching.length }] };
    }
    return { rows: matching };
  });
}

describe('board columns are mutually exclusive', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    serveFromStatuses();
  });

  it('asks for exactly one status per column — no column borrows another', async () => {
    await new TaskManagerDB().queryBoardColumns(BOARD_COLUMNS, {}, 6, {}, WIDEST_SCOPE);

    const statusArrays = mockQuery.mock.calls
      .map(([, params = []]) => (params as any[]).find(Array.isArray) as string[] | undefined)
      .filter((value): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string'))
      .filter((value) => value.some((v) => BOARD_COLUMNS.includes(v)));

    expect(statusArrays.length).toBeGreaterThan(0);
    for (const statuses of statusArrays) {
      expect(statuses).toHaveLength(1);
    }
    // Every column was actually asked for, so a column silently dropped would
    // not pass this by asking for nothing.
    expect(new Set(statusArrays.map((s) => s[0]))).toEqual(new Set(BOARD_COLUMNS));
  });

  it('places every task in exactly one column', async () => {
    const board = await new TaskManagerDB().queryBoardColumns(BOARD_COLUMNS, {}, 6, {}, WIDEST_SCOPE);

    const placements = new Map<string, string[]>();
    for (const [column, result] of Object.entries(board.columns)) {
      for (const task of result.items) {
        placements.set(task.id, [...(placements.get(task.id) || []), column]);
      }
    }

    expect(placements.size).toBe(TASKS.length);
    for (const [id, columns] of placements) {
      expect(`${id}: ${columns.join(" and ")}`).toBe(`${id}: ${columns[0]}`);
    }
  });

  it('keeps the Review task out of the Stuck column, and Stuck out of Review', async () => {
    // The reported symptom, stated directly, so a regression names itself.
    const board = await new TaskManagerDB().queryBoardColumns(BOARD_COLUMNS, {}, 6, {}, WIDEST_SCOPE);

    expect(board.columns.stuck.items.map((task: { status: string }) => task.status)).toEqual(['stuck']);
    expect(board.columns.review.items.map((task: { status: string }) => task.status)).toEqual(['review']);
  });

  it('counts each column total over its own contents only', async () => {
    // The card notes the per-column `total` was wrong as well as the contents:
    // it was counted with the same widened query, so Stuck over-reported even
    // when the extra card was beyond the page.
    const board = await new TaskManagerDB().queryBoardColumns(BOARD_COLUMNS, {}, 6, {}, WIDEST_SCOPE);

    for (const column of BOARD_COLUMNS) {
      expect(board.columns[column].total).toBe(1);
      expect(board.columns[column].items).toHaveLength(1);
    }
  });
});
