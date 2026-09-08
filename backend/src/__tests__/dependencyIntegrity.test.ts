// dependencyIntegrity.test.ts — task af900dd2: dependency referential integrity
//
// Covers:
//  * POST/PATCH-level validation errors: unknown dependsOn ids and
//    self-dependencies raise typed DependencyValidationError (routes map → 400)
//  * blocked semantics single source of truth: dependencyBlocks /
//    dependencySatisfied (archived-completed satisfies, live-incomplete blocks,
//    archived-abandoned does not block)
//  * archive disposition: computeArchiveDisposition heuristic, set on the
//    transition into archived, cleared on un-archive, and mirrored by the
//    migration 040 backfill
import { readFileSync } from 'fs';
import path from 'path';
import {
  TaskManagerDB,
  DependencyValidationError,
  dependencyBlocks,
  dependencySatisfied,
  computeArchiveDisposition,
} from '../services/TaskManagerDB';

const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockClient = {
  query: (...args: any[]) => mockClientQuery(...args),
  release: jest.fn(),
};

jest.mock('../db/connection', () => ({
  pool: {
    query: (...args: any[]) => mockQuery(...args),
    connect: jest.fn(() => Promise.resolve(mockClient)),
  },
}));

jest.mock('../services/NotificationManager', () => ({
  notificationManager: { notifyStatusChange: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../services/TaskHistoryService', () => ({
  taskHistoryService: { recordChange: jest.fn() },
}));

const TASK_A = '11111111-1111-4111-8111-111111111111';
const TASK_B = '22222222-2222-4222-8222-222222222222';
const TASK_C = '33333333-3333-4333-8333-333333333333';
const MISSING_1 = '44444444-4444-4444-8444-444444444444';
const MISSING_2 = '55555555-5555-4555-8555-555555555555';

function makeRow(id: string, overrides: Record<string, any> = {}) {
  return {
    id,
    title: `Task ${id.slice(0, 8)}`,
    description: '',
    status: 'todo',
    priority: 'normal',
    project_id: null,
    thinking_budget: 'low',
    thinking_auto_estimated: false,
    model: null,
    execution_mode: null,
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
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    started_at: null,
    completed_at: null,
    archived_at: null,
    archive_disposition: null,
    at_slug: null,
    at_name: null,
    at_color: null,
    at_category: null,
    ...overrides,
  };
}

/**
 * SQL-dispatching mock for pool/client queries so multi-step flows
 * (createTask/updateTask/getTask + hydrate) run against fixture rows.
 */
function makeDispatcher(fixtures: {
  taskRows?: Record<string, any>;
  subtaskRows?: Record<string, Array<{ status: string }>>;
  depRows?: Record<string, Array<{ depends_on_task_id: string }>>;
  insertReturning?: any;
}) {
  const { taskRows = {}, subtaskRows = {}, depRows = {}, insertReturning } = fixtures;
  return (sql: any, params: any[] = []) => {
    const text = typeof sql === 'string' ? sql : sql?.text || '';
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text.trim())) return Promise.resolve({ rows: [] });
    if (text.includes('INSERT INTO tasks')) return Promise.resolve({ rows: [insertReturning] });
    if (text.includes('SELECT id FROM tasks WHERE id = ANY')) {
      const found = (params[0] as string[]).filter(id => taskRows[id]);
      return Promise.resolve({ rows: found.map(id => ({ id })) });
    }
    // The point read appends `DUE_AT_ISO_RETURNING` (the FEAT-A projection), so
    // the match admits the extra projections rather than the bare `*` alone. A row
    // carrying `due_at` without `due_at_iso` still throws in `readRowDueAt`, which
    // is the fail-closed behaviour this double must not paper over.
    if (/SELECT \*(?:,[\s\S]*?)? FROM tasks WHERE id/i.test(text)) {
      const row = taskRows[params[0]];
      return Promise.resolve({ rows: row ? [row] : [] });
    }
    if (text.includes('FROM tasks t') && text.includes('WHERE t.id = $1')) {
      const row = taskRows[params[0]];
      return Promise.resolve({ rows: row ? [row] : [] });
    }
    // The hydrate reads arrive in the per-row shape ($1 = one id) or the
    // batched `= ANY` shape ($1 = id[]) since the 6a351638 batched hydration;
    // both are served, with task_id present for the batched grouping.
    const idsOf = (value: any): string[] => (Array.isArray(value) ? value : [value]);
    if (text.includes('FROM subtasks')) {
      const rows = idsOf(params[0]).flatMap((taskId) =>
        (subtaskRows[taskId] || []).map((s, i) => ({
          id: i + 1,
          task_id: taskId,
          title: `subtask ${i}`,
          note: null,
          blocked_reason: null,
          completed_at: null,
          created_at: null,
          updated_at: null,
          ...s,
        })));
      return Promise.resolve({ rows });
    }
    if (text.includes('FROM task_dependencies WHERE task_id')) {
      const rows = idsOf(params[0]).flatMap((taskId) =>
        (depRows[taskId] || []).map((dep) => ({ task_id: taskId, ...dep })));
      return Promise.resolve({ rows });
    }
    // tags, links, projects, UPDATE tasks, INSERT INTO task_* etc.
    return Promise.resolve({ rows: [], rowCount: 1 });
  };
}

describe('dependency blocked semantics (single source of truth)', () => {
  test('live, not-completed dependencies block', () => {
    for (const status of ['ideas', 'todo', 'in-progress', 'review', 'stuck']) {
      expect(dependencyBlocks(status)).toBe(true);
    }
  });

  test('only completed or archived-completed dependencies unblock', () => {
    expect(dependencyBlocks('completed')).toBe(false);
    expect(dependencyBlocks('archived', 'completed')).toBe(false);
    expect(dependencyBlocks('archived', 'abandoned')).toBe(true);
    expect(dependencyBlocks('archived', null)).toBe(true);
  });

  test('satisfied: completed, or archived with disposition completed', () => {
    expect(dependencySatisfied('completed')).toBe(true);
    expect(dependencySatisfied('completed', null)).toBe(true);
    expect(dependencySatisfied('archived', 'completed')).toBe(true);
  });

  test('not satisfied: live deps and archived-abandoned/unknown deps', () => {
    expect(dependencySatisfied('todo')).toBe(false);
    expect(dependencySatisfied('in-progress', null)).toBe(false);
    expect(dependencySatisfied('archived', 'abandoned')).toBe(false);
    expect(dependencySatisfied('archived', null)).toBe(false);
    expect(dependencySatisfied('archived', undefined)).toBe(false);
  });
});

describe('computeArchiveDisposition heuristic (runtime + migration 040 backfill)', () => {
  test('completed at archive time → completed', () => {
    expect(computeArchiveDisposition('completed', [])).toBe('completed');
    expect(computeArchiveDisposition('completed', [{ status: 'empty' }])).toBe('completed');
  });

  test('all subtasks completed/skipped → completed even if status was not completed', () => {
    expect(computeArchiveDisposition('in-progress', [{ status: 'completed' }, { status: 'skipped' }])).toBe('completed');
  });

  test('unfinished work → abandoned', () => {
    expect(computeArchiveDisposition('todo', [])).toBe('abandoned');
    expect(computeArchiveDisposition('in-progress', [{ status: 'completed' }, { status: 'in-progress' }])).toBe('abandoned');
    expect(computeArchiveDisposition(null, [{ status: 'empty' }])).toBe('abandoned');
  });

  test('migration 040 backfill mirrors the same heuristic', () => {
    const sql = readFileSync(
      path.join(__dirname, '../migrations/040_archive_disposition.sql'),
      'utf8'
    );
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS archive_disposition');
    expect(sql).toContain("WHEN t.completed_at IS NOT NULL THEN 'completed'");
    expect(sql).toContain("s.status NOT IN ('completed', 'skipped')");
    expect(sql).toContain("ELSE 'abandoned'");
    expect(sql).toContain("WHERE t.status = 'archived'");
    expect(sql).toContain('archive_disposition IS NULL');
  });
});

describe('dependsOn referential integrity validation', () => {
  let tm: TaskManagerDB;

  beforeEach(() => {
    tm = new TaskManagerDB();
    mockQuery.mockReset();
    mockClientQuery.mockReset();
  });

  test('unknown dependency ids raise UNKNOWN_DEPENDENCY listing every offender', async () => {
    mockQuery.mockImplementation(makeDispatcher({ taskRows: { [TASK_B]: makeRow(TASK_B) } }));

    const err: DependencyValidationError = await (tm as any)
      .validateDependencies([TASK_B, MISSING_1, MISSING_2], TASK_A)
      .then(() => { throw new Error('expected rejection'); }, (e: any) => e);

    expect(err).toBeInstanceOf(DependencyValidationError);
    expect(err.code).toBe('UNKNOWN_DEPENDENCY');
    expect(err.offendingIds).toEqual([MISSING_1, MISSING_2]);
    expect(err.message).toContain(MISSING_1);
    expect(err.message).toContain(MISSING_2);
  });

  test('malformed (non-uuid) ids are unknown dependencies, not SQL cast errors', async () => {
    mockQuery.mockImplementation(makeDispatcher({ taskRows: {} }));

    const err: DependencyValidationError = await (tm as any)
      .validateDependencies(['not-a-uuid'], TASK_A)
      .then(() => { throw new Error('expected rejection'); }, (e: any) => e);

    expect(err.code).toBe('UNKNOWN_DEPENDENCY');
    expect(err.offendingIds).toEqual(['not-a-uuid']);
    // must not have attempted the uuid[] cast with the malformed id
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('self-dependency raises SELF_DEPENDENCY', async () => {
    const err: DependencyValidationError = await (tm as any)
      .validateDependencies([TASK_A], TASK_A)
      .then(() => { throw new Error('expected rejection'); }, (e: any) => e);

    expect(err).toBeInstanceOf(DependencyValidationError);
    expect(err.code).toBe('SELF_DEPENDENCY');
    expect(err.offendingIds).toEqual([TASK_A]);
  });

  test('existing dependencies of any status (archived included) pass validation', async () => {
    mockQuery.mockImplementation(makeDispatcher({
      taskRows: {
        [TASK_B]: makeRow(TASK_B, { status: 'archived', archive_disposition: 'abandoned' }),
        [TASK_C]: makeRow(TASK_C, { status: 'completed' }),
      },
    }));

    await expect((tm as any).validateDependencies([TASK_B, TASK_C], TASK_A)).resolves.toBeUndefined();
  });

  test('createTask with valid dependsOn no longer trips the self-dependency check (regression)', async () => {
    const insertReturning = makeRow(TASK_A);
    const dispatcher = makeDispatcher({
      taskRows: { [TASK_B]: makeRow(TASK_B) },
      insertReturning,
    });
    mockQuery.mockImplementation(dispatcher);
    mockClientQuery.mockImplementation(dispatcher);

    const task = await tm.createTask({ title: 'child', dependsOn: [TASK_B] } as any, undefined, async () => null);
    expect(task.id).toBe(TASK_A);

    const depInsert = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO task_dependencies'));
    expect(depInsert).toBeDefined();
    expect(depInsert![1]).toEqual([TASK_A, TASK_B]);
  });

  test('createTask with unknown dependsOn rejects with UNKNOWN_DEPENDENCY and rolls back', async () => {
    const dispatcher = makeDispatcher({ taskRows: {} });
    mockQuery.mockImplementation(dispatcher);
    mockClientQuery.mockImplementation(dispatcher);

    await expect(tm.createTask({ title: 'child', dependsOn: [MISSING_1] } as any, undefined, async () => null))
      .rejects.toMatchObject({ code: 'UNKNOWN_DEPENDENCY', offendingIds: [MISSING_1] });

    const rollback = mockClientQuery.mock.calls.find(([sql]) => String(sql).startsWith('ROLLBACK'));
    expect(rollback).toBeDefined();
  });
});

describe('blocked recomputation across dependency status changes', () => {
  let tm: TaskManagerDB;

  beforeEach(() => {
    tm = new TaskManagerDB();
    mockQuery.mockReset();
    mockClientQuery.mockReset();
  });

  function fixtures(depOverrides: Record<string, any>) {
    return makeDispatcher({
      taskRows: {
        [TASK_A]: makeRow(TASK_A),
        [TASK_B]: makeRow(TASK_B, depOverrides),
      },
      depRows: { [TASK_A]: [{ depends_on_task_id: TASK_B }] },
    });
  }

  test('live incomplete dependency blocks', async () => {
    mockQuery.mockImplementation(fixtures({ status: 'in-progress' }));
    expect(await tm.isTaskBlocked(TASK_A)).toBe(true);
    const blocking = await tm.getBlockingTasks(TASK_A);
    expect(blocking.map(t => t.id)).toEqual([TASK_B]);
  });

  test('completed dependency does not block', async () => {
    mockQuery.mockImplementation(fixtures({ status: 'completed' }));
    expect(await tm.isTaskBlocked(TASK_A)).toBe(false);
  });

  test('archived-completed dependency is satisfied and does not block', async () => {
    mockQuery.mockImplementation(fixtures({ status: 'archived', archive_disposition: 'completed' }));
    expect(await tm.isTaskBlocked(TASK_A)).toBe(false);
  });

  test('archived-abandoned dependency remains blocked fail-closed', async () => {
    mockQuery.mockImplementation(fixtures({ status: 'archived', archive_disposition: 'abandoned' }));
    expect(await tm.isTaskBlocked(TASK_A)).toBe(true);
  });

  test('missing dependency row does not block', async () => {
    mockQuery.mockImplementation(makeDispatcher({
      taskRows: { [TASK_A]: makeRow(TASK_A) },
      depRows: { [TASK_A]: [{ depends_on_task_id: MISSING_1 }] },
    }));
    expect(await tm.isTaskBlocked(TASK_A)).toBe(false);
  });
});

describe('archive disposition on status transitions', () => {
  let tm: TaskManagerDB;

  beforeEach(() => {
    tm = new TaskManagerDB();
    mockQuery.mockReset();
    mockClientQuery.mockReset();
  });

  function archiveUpdateCall() {
    return mockClientQuery.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE tasks SET'));
  }

  function dispositionParam() {
    const call = archiveUpdateCall();
    expect(call).toBeDefined();
    const [sql, params] = call!;
    const fields = String(sql).match(/UPDATE tasks SET (.*) WHERE/s)![1].split(', ');
    const idx = fields.findIndex(f => f.startsWith('archive_disposition ='));
    expect(idx).toBeGreaterThanOrEqual(0);
    return params[idx];
  }

  function setupUpdate(currentOverrides: Record<string, any>, subtasks: Array<{ status: string }>) {
    const currentRow = makeRow(TASK_A, currentOverrides);
    const dispatcher = makeDispatcher({
      taskRows: { [TASK_A]: currentRow },
      subtaskRows: { [TASK_A]: subtasks },
    });
    mockQuery.mockImplementation(dispatcher);
    mockClientQuery.mockImplementation(dispatcher);
  }

  test('archiving a completed task records disposition completed', async () => {
    setupUpdate({ status: 'completed', completed_at: '2026-07-02T00:00:00.000Z' }, [{ status: 'empty' }]);
    await tm.updateTask(TASK_A, { status: 'archived' } as any);
    expect(dispositionParam()).toBe('completed');
  });

  test('archiving an unfinished task records disposition abandoned', async () => {
    setupUpdate({ status: 'in-progress' }, [{ status: 'in-progress' }]);
    await tm.updateTask(TASK_A, { status: 'archived' } as any);
    expect(dispositionParam()).toBe('abandoned');
  });

  test('archiving a non-completed task whose subtasks all ended done records completed', async () => {
    setupUpdate({ status: 'stuck' }, [{ status: 'completed' }, { status: 'skipped' }]);
    await tm.updateTask(TASK_A, { status: 'archived' } as any);
    expect(dispositionParam()).toBe('completed');
  });

  test('un-archiving clears the disposition so a re-archive recomputes it', async () => {
    setupUpdate({ status: 'archived', archived_at: '2026-07-02T00:00:00.000Z', archive_disposition: 'abandoned' }, []);
    await tm.updateTask(TASK_A, { status: 'todo' } as any);
    expect(dispositionParam()).toBeNull();
  });

  test('non-status updates never touch archive_disposition', async () => {
    setupUpdate({ status: 'todo' }, []);
    await tm.updateTask(TASK_A, { title: 'renamed' } as any);
    const [sql] = archiveUpdateCall()!;
    expect(String(sql)).not.toContain('archive_disposition');
  });
});
