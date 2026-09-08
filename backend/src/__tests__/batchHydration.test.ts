/**
 * batchHydration.test.ts — card 6a351638 (R19): the E4 board-startup miss was
 * per-row hydration multiplied by the estate. queryTasks/queryBoardColumns
 * issued four child-table queries PLUS a project-name lookup per returned
 * row (~20,000 queries when filter-options hydrated all 5,200 fixture tasks),
 * and the resulting event-loop and pool contention queued the whole board
 * startup behind it.
 *
 * The discriminating property is the QUERY COUNT: hydrating N rows must cost
 * a CONSTANT number of round-trips, not 1+5N. The counting fake below answers
 * both the per-row and the batched statement shapes from one in-memory
 * dataset, so the assertion discriminates purely on how many times the pool
 * is asked — red against the per-row code, green against the batched code —
 * while the parity block proves the batched output is byte-shaped like the
 * per-row output it replaced.
 */
import { TaskManagerDB } from '../services/TaskManagerDB';

jest.mock('../db/connection', () => ({ pool: { query: jest.fn(async () => ({ rows: [] })) } }));
jest.mock('../services/NotificationManager', () => ({ notificationManager: { notifyStatusChange: jest.fn() } }));
jest.mock('../services/AuditService', () => ({ auditService: { record: jest.fn() } }));
jest.mock('../services/LifecyclePolicyService', () => ({ lifecyclePolicyService: { evaluate: jest.fn() } }));
jest.mock('../services/TaskHistoryService', () => ({
  taskHistoryService: { record: jest.fn(), recordStatusChange: jest.fn() },
  TaskActor: {},
}));

const TASK_COUNT = 40;
const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const PROJECT_A = 'aaaaaaaa-0000-4000-8000-000000000000';
const PROJECT_B = 'bbbbbbbb-0000-4000-8000-000000000000';

type Counted = { count: number };

function makeFakePool(counter: Counted) {
  const taskRows = Array.from({ length: TASK_COUNT }, (_, i) => ({
    id: uuid(i + 1),
    title: `Task ${i + 1}`,
    description: '',
    status: 'todo',
    priority: 'normal',
    project_id: i % 3 === 0 ? PROJECT_A : (i % 3 === 1 ? PROJECT_B : null),
    phase_id: null, notes: null, auto_start: false, blocked_reason: null,
    status_reason: null, active_agent: null, completed_by: null, attempt_count: 0,
    session_refs: [], parent_id: null, personality_id: null,
    created_at: '2026-08-21T00:00:00Z', updated_at: '2026-08-21T00:00:00Z',
    started_at: null, completed_at: null, archived_at: null, archive_disposition: null,
    at_slug: null, at_name: null, at_color: null, at_category: null,
  }));
  const subtaskRows = taskRows.flatMap((t, i) => [0, 1].map(index => ({
    id: i * 2 + index + 1, task_id: t.id, index,
    title: `Sub ${index} of ${t.title}`, status: index === 0 ? 'completed' : 'empty',
    note: null, completed_at: null, created_at: '', updated_at: '',
  })));
  const tagRows = taskRows.flatMap(t => [{ task_id: t.id, tag: 'zeta' }, { task_id: t.id, tag: 'alpha' }]);
  const depRows = taskRows.slice(1).map((t, i) => ({ task_id: t.id, depends_on_task_id: taskRows[i].id }));
  const linkRows = taskRows.map((t, i) => ({ id: i + 1, task_id: t.id, type: 'doc', title: 'L', url: 'https://x' }));
  const projectRows = [
    { id: PROJECT_A, name: 'Alpha Project' },
    { id: PROJECT_B, name: 'Beta Project' },
  ];

  const forTask = <T extends { task_id: string }>(rows: T[], id: string) => rows.filter(r => r.task_id === id);
  const forTasks = <T extends { task_id: string }>(rows: T[], ids: string[]) => {
    const wanted = new Set(ids);
    return rows.filter(r => wanted.has(r.task_id));
  };

  const query = async (text: string, params: unknown[] = []) => {
    counter.count += 1;
    const sql = text.replace(/\s+/g, ' ').trim();

    if (/^SELECT t\.\*/i.test(sql) && /FROM tasks t/i.test(sql)) return { rows: taskRows };

    // Child fetches — BOTH shapes served, so only the round-trip count and
    // output parity discriminate between the per-row and batched paths.
    if (/FROM subtasks/i.test(sql)) {
      const rows = /= ANY\(/i.test(sql) ? forTasks(subtaskRows, params[0] as string[]) : forTask(subtaskRows, params[0] as string);
      return { rows: [...rows].sort((a, b) => a.task_id.localeCompare(b.task_id) || a.index - b.index) };
    }
    if (/FROM task_tags/i.test(sql)) {
      const rows = /= ANY\(/i.test(sql) ? forTasks(tagRows, params[0] as string[]) : forTask(tagRows, params[0] as string);
      return { rows: [...rows].sort((a, b) => a.task_id.localeCompare(b.task_id) || a.tag.localeCompare(b.tag)) };
    }
    if (/FROM task_dependencies/i.test(sql)) {
      const rows = /= ANY\(/i.test(sql) ? forTasks(depRows, params[0] as string[]) : forTask(depRows, params[0] as string);
      return { rows };
    }
    if (/FROM task_links/i.test(sql)) {
      const rows = /= ANY\(/i.test(sql) ? forTasks(linkRows, params[0] as string[]) : forTask(linkRows, params[0] as string);
      return { rows };
    }
    if (/FROM projects/i.test(sql)) {
      if (/= ANY\(/i.test(sql)) {
        const wanted = new Set(params[0] as string[]);
        return { rows: projectRows.filter(p => wanted.has(p.id)) };
      }
      return { rows: projectRows.filter(p => p.id === params[0]) };
    }
    throw new Error(`fake pool: unhandled statement: ${sql.slice(0, 100)}`);
  };

  return { query, connect: async () => ({ query, release: () => undefined }) } as never;
}

describe('batched hydration — card 6a351638 (R19)', () => {
  test('hydrating 40 rows costs a CONSTANT number of round-trips, not 1+5N', async () => {
    const counter = { count: 0 };
    const manager = new TaskManagerDB(makeFakePool(counter));
    const tasks = await manager.queryTasks({});
    expect(tasks).toHaveLength(TASK_COUNT);
    // Batched: 1 main + 4 child fetches + 1 projects = 6. The pre-repair
    // per-row path costs 1 + 40×(4 children + a project resolve for two of
    // every three rows) ≈ 188. Anything that grows with the row count fails.
    expect(counter.count).toBeLessThanOrEqual(8);
  });

  test('the batched output keeps the per-row shape exactly', async () => {
    const counter = { count: 0 };
    const manager = new TaskManagerDB(makeFakePool(counter));
    const tasks = await manager.queryTasks({});
    const second = tasks.find(t => t.title === 'Task 2')!;
    expect(second.subtasks.map(s => ({ text: s.text, status: s.status, completed: s.completed })))
      .toEqual([
        { text: 'Sub 0 of Task 2', status: 'completed', completed: true },
        { text: 'Sub 1 of Task 2', status: 'empty', completed: false },
      ]);
    expect(second.tags).toEqual(['alpha', 'zeta']);
    expect(second.dependsOn).toEqual([uuid(1)]);
    expect(second.links).toEqual([{ type: 'doc', title: 'L', url: 'https://x' }]);
    expect(second.project).toBe('Beta Project');
    const third = tasks.find(t => t.title === 'Task 3')!;
    expect(third.project).toBeUndefined();
    const first = tasks.find(t => t.title === 'Task 1')!;
    expect(first.project).toBe('Alpha Project');
    expect(first.dependsOn).toEqual([]);
  });
});
