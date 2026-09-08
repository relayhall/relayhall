/**
 * Unified archive policy (task 7d2a60a6).
 *
 * Archiving is allowed from ANY status, through BOTH paths:
 *   - PATCH /tasks/:id { status: 'archived', archiveReason? }  -> updateTask()
 *   - POST /tasks/:id/archive { reason? }                      -> archiveTask()
 * with identical semantics: same disposition heuristic
 * (computeArchiveDisposition), same warning for non-completed tasks
 * (archiveWarningForStatus), same optional reason note appended to task notes
 * (archiveReasonNote). Un-archiving clears the disposition.
 *
 * These tests run both paths against identical fixtures (completed,
 * in-progress-with-subtask-history, ideas) and assert the persisted
 * archive_disposition / notes and the returned warning match.
 */
import {
  TaskManagerDB,
  computeArchiveDisposition,
  archiveWarningForStatus,
  archiveReasonNote,
} from '../services/TaskManagerDB';

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

jest.mock('../services/NotificationManager', () => ({
  notificationManager: { notifyStatusChange: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../services/TaskHistoryService', () => ({
  taskHistoryService: { recordChange: jest.fn() },
}));

const TASK_ID = '7d2a60a6-1111-4222-8333-444455556666';

interface FixtureOptions {
  status: string;
  notes?: string | null;
  subtasks?: Array<{ status: string }>;
  archiveDisposition?: string | null;
}

/**
 * In-memory fake of the pg Pool for the queries TaskManagerDB issues during
 * updateTask/archiveTask/getTask. UPDATE statements are applied to the row so
 * subsequent reads observe the new state, like the real database would.
 */
function makeFakeDb(opts: FixtureOptions) {
  const row: Record<string, any> = {
    id: TASK_ID,
    title: 'Unify archive policy',
    description: 'Archive semantics test fixture',
    status: opts.status,
    priority: 'normal',
    project_id: null,
    thinking_budget: 'medium',
    thinking_auto_estimated: false,
    model: null,
    execution_mode: null,
    execution_profile: null,
    definition_of_done: null,
    constraints: null,
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
    started_at: opts.status === 'in-progress' ? '2026-07-01T01:00:00.000Z' : null,
    completed_at: opts.status === 'completed' ? '2026-07-02T00:00:00.000Z' : null,
    archived_at: opts.status === 'archived' ? '2026-07-03T00:00:00.000Z' : null,
    archive_disposition: opts.archiveDisposition ?? null,
    notes: opts.notes ?? null,
    at_slug: null,
    at_name: null,
    at_color: null,
    at_category: null,
  };

  const subtaskRows = (opts.subtasks || []).map((s, i) => ({
    id: i + 1,
    task_id: TASK_ID,
    index: i,
    title: `subtask ${i}`,
    status: s.status,
    note: null,
    completed_at: s.status === 'completed' ? '2026-07-01T12:00:00.000Z' : null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  }));

  const updates: Array<{ sql: string; params: any[] }> = [];

  const query = jest.fn(async (sql: string, params?: any[]) => {
    const text = String(sql);
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [] };
    if (/UPDATE tasks SET/i.test(text)) {
      updates.push({ sql: text, params: params || [] });
      // Apply "col = $n" assignments to the row, like the real UPDATE would.
      const re = /([a-z_]+) = \$(\d+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        row[m[1]] = (params || [])[parseInt(m[2], 10) - 1];
      }
      return { rows: [] };
    }
    // The point read appends `DUE_AT_ISO_RETURNING` (the FEAT-A projection), so
    // the match admits the extra projections rather than the bare `*` alone. A row
    // carrying `due_at` without `due_at_iso` still throws in `readRowDueAt`, which
    // is the fail-closed behaviour this double must not paper over.
    if (/SELECT \*(?:,[\s\S]*?)? FROM tasks WHERE id = \$1/i.test(text)) {
      return { rows: params && params[0] === TASK_ID ? [{ ...row }] : [] };
    }
    if (/FROM tasks t LEFT JOIN personalities/i.test(text)) {
      return { rows: params && params[0] === TASK_ID ? [{ ...row }] : [] };
    }
    if (/FROM subtasks/i.test(text)) return { rows: subtaskRows.map(s => ({ ...s })) };
    if (/FROM task_tags/i.test(text)) return { rows: [] };
    if (/FROM task_dependencies/i.test(text)) return { rows: [] };
    if (/FROM task_links/i.test(text)) return { rows: [] };
    // queryTasks (getAllTasks after archive) and anything else: empty set.
    return { rows: [] };
  });

  const client = { query, release: jest.fn() };
  const pool: any = { query, connect: jest.fn(async () => client) };

  return { pool, row, updates };
}

// Fixtures per the decided policy matrix. Disposition follows
// computeArchiveDisposition: completed status -> 'completed'; otherwise
// 'abandoned' unless every subtask ended completed/skipped.
const CASES: Array<{
  name: string;
  fixture: FixtureOptions;
  expectedDisposition: 'completed' | 'abandoned';
  expectWarning: boolean;
}> = [
  {
    name: 'completed task',
    fixture: { status: 'completed', subtasks: [{ status: 'completed' }] },
    expectedDisposition: 'completed',
    expectWarning: false,
  },
  {
    name: 'in-progress task with subtask history',
    fixture: { status: 'in-progress', subtasks: [{ status: 'completed' }, { status: 'in-progress' }] },
    expectedDisposition: 'abandoned',
    expectWarning: true,
  },
  {
    name: 'ideas task',
    fixture: { status: 'ideas' },
    expectedDisposition: 'abandoned',
    expectWarning: true,
  },
];

const CASE_TABLE: Array<[string, (typeof CASES)[number]]> = CASES.map(c => [c.name, c]);

const REASON = 'superseded by task 7d2a60a6';

describe('archive policy helpers', () => {
  test('archiveWarningForStatus: no warning for completed, exact warning otherwise', () => {
    expect(archiveWarningForStatus('completed', 'completed')).toBeUndefined();
    expect(archiveWarningForStatus('in-progress', 'abandoned'))
      .toBe('archiving non-completed task (disposition: abandoned)');
    expect(archiveWarningForStatus('ideas', 'abandoned'))
      .toBe('archiving non-completed task (disposition: abandoned)');
    // Non-completed task whose subtasks all ended done still warns, with the
    // actually-recorded disposition embedded.
    expect(archiveWarningForStatus('in-progress', 'completed'))
      .toBe('archiving non-completed task (disposition: completed)');
  });

  test('archiveReasonNote formats identically for both paths', () => {
    expect(archiveReasonNote('abandoned', 'no longer needed')).toBe('Archived (abandoned): no longer needed');
    expect(archiveReasonNote('completed', 'done ages ago')).toBe('Archived (completed): done ages ago');
  });

  test('warning matches disposition heuristic for the test matrix', () => {
    for (const c of CASES) {
      const disposition = computeArchiveDisposition(c.fixture.status, c.fixture.subtasks || []);
      expect(disposition).toBe(c.expectedDisposition);
      const warning = archiveWarningForStatus(c.fixture.status, disposition);
      if (c.expectWarning) {
        expect(warning).toBe(`archiving non-completed task (disposition: ${c.expectedDisposition})`);
      } else {
        expect(warning).toBeUndefined();
      }
    }
  });
});

describe('PATCH path: updateTask(status -> archived)', () => {
  test.each(CASE_TABLE)('%s', async (_name, c) => {
    const { pool, row } = makeFakeDb(c.fixture);
    const manager = new TaskManagerDB(pool);

    const task = await manager.updateTask(TASK_ID, { status: 'archived' as any });

    expect(row.status).toBe('archived');
    expect(row.archive_disposition).toBe(c.expectedDisposition);
    expect(task.archiveDisposition).toBe(c.expectedDisposition);
    // No reason given -> notes untouched.
    expect(row.notes).toBeNull();
  });

  test.each(CASE_TABLE)('%s with archiveReason', async (_name, c) => {
    const { pool, row } = makeFakeDb(c.fixture);
    const manager = new TaskManagerDB(pool);

    await manager.updateTask(TASK_ID, { status: 'archived' as any, archiveReason: REASON });

    expect(row.archive_disposition).toBe(c.expectedDisposition);
    expect(row.notes).toBe(`Archived (${c.expectedDisposition}): ${REASON}`);
  });

  test('archiveReason appends to existing notes on a new line', async () => {
    const { pool, row } = makeFakeDb({ status: 'ideas', notes: 'original note' });
    const manager = new TaskManagerDB(pool);

    await manager.updateTask(TASK_ID, { status: 'archived' as any, archiveReason: REASON });

    expect(row.notes).toBe(`original note\nArchived (abandoned): ${REASON}`);
  });

  test('blank archiveReason is ignored', async () => {
    const { pool, row } = makeFakeDb({ status: 'ideas' });
    const manager = new TaskManagerDB(pool);

    await manager.updateTask(TASK_ID, { status: 'archived' as any, archiveReason: '   ' });

    expect(row.archive_disposition).toBe('abandoned');
    expect(row.notes).toBeNull();
  });

  test('un-archive clears the disposition', async () => {
    const { pool, row } = makeFakeDb({ status: 'archived', archiveDisposition: 'abandoned' });
    const manager = new TaskManagerDB(pool);

    const task = await manager.updateTask(TASK_ID, { status: 'todo' as any });

    expect(row.status).toBe('todo');
    expect(row.archive_disposition).toBeNull();
    expect(task.archiveDisposition).toBeNull();
  });
});

describe('endpoint path: archiveTask()', () => {
  test.each(CASE_TABLE)('%s', async (_name, c) => {
    const { pool, row } = makeFakeDb(c.fixture);
    const manager = new TaskManagerDB(pool);

    const result = await manager.archiveTask(TASK_ID);

    expect(result.success).toBe(true);
    expect(result.archived).toBe(true);
    expect(result.disposition).toBe(c.expectedDisposition);
    expect(row.status).toBe('archived');
    expect(row.archive_disposition).toBe(c.expectedDisposition);
    if (c.expectWarning) {
      expect(result.warning).toBe(`archiving non-completed task (disposition: ${c.expectedDisposition})`);
    } else {
      expect(result.warning).toBeUndefined();
    }
    expect(result.task.status).toBe('archived');
  });

  test.each(CASE_TABLE)('%s with reason', async (_name, c) => {
    const { pool, row } = makeFakeDb(c.fixture);
    const manager = new TaskManagerDB(pool);

    const result = await manager.archiveTask(TASK_ID, { reason: REASON });

    expect(result.disposition).toBe(c.expectedDisposition);
    expect(row.notes).toBe(`Archived (${c.expectedDisposition}): ${REASON}`);
  });

  test('archiving an already-archived task is an idempotent no-op', async () => {
    const { pool, row, updates } = makeFakeDb({ status: 'archived', archiveDisposition: 'completed' });
    const manager = new TaskManagerDB(pool);

    const result = await manager.archiveTask(TASK_ID, { reason: 'should be ignored' });

    expect(result).toMatchObject({ success: true, archived: true, disposition: 'completed' });
    expect(result.warning).toBeUndefined();
    expect(updates).toHaveLength(0);
    expect(row.archive_disposition).toBe('completed');
    expect(row.notes).toBeNull();
  });

  test('unknown task still throws', async () => {
    const { pool } = makeFakeDb({ status: 'ideas' });
    const manager = new TaskManagerDB(pool);

    await expect(manager.archiveTask('00000000-0000-4000-8000-000000000000'))
      .rejects.toThrow(/not found/i);
  });
});

describe('both paths produce identical results', () => {
  test.each(CASE_TABLE)('%s', async (_name, c) => {
    const patchDb = makeFakeDb(c.fixture);
    const endpointDb = makeFakeDb(c.fixture);
    const patchManager = new TaskManagerDB(patchDb.pool);
    const endpointManager = new TaskManagerDB(endpointDb.pool);

    // PATCH path: route computes the warning from the prior status + the
    // disposition on the returned task (see routes/tasks.ts PATCH /:id).
    const priorStatus = c.fixture.status;
    const patched = await patchManager.updateTask(TASK_ID, {
      status: 'archived' as any,
      archiveReason: REASON,
    });
    const patchWarning = archiveWarningForStatus(priorStatus, patched.archiveDisposition as any);

    // Endpoint path.
    const result = await endpointManager.archiveTask(TASK_ID, { reason: REASON });

    expect(result.disposition).toBe(patched.archiveDisposition);
    expect(result.warning).toBe(patchWarning);
    expect(endpointDb.row.archive_disposition).toBe(patchDb.row.archive_disposition);
    expect(endpointDb.row.notes).toBe(patchDb.row.notes);
    expect(endpointDb.row.status).toBe(patchDb.row.status);
  });
});
