import { TaskManagerDB } from '../services/TaskManagerDB';

const mockQuery = jest.fn();

jest.mock('../db/connection', () => ({
  pool: {
    query: (...args: any[]) => mockQuery(...args),
    // RH-P3.C1: transactional writes (claimTask & co.) ride a client. The
    // shim absorbs BEGIN/COMMIT/ROLLBACK and the feed emission so the
    // positional mockQuery expectations keep addressing the pinned queries.
    connect: jest.fn(async () => ({
      query: (...args: any[]) => {
        const sql = String(args[0]);
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK'
          || sql.includes('pg_advisory_xact_lock') || sql.startsWith('INSERT INTO feed_events')) {
          return Promise.resolve({ rows: [] });
        }
        return mockQuery(...args);
      },
      release: jest.fn(),
    })),
  },
}));

const baseRow = {
  id: '1ad5375c-2f1d-4768-a71c-864f6edfeee7',
  title: 'Dependency picker fix',
  description: 'Fix dependency search',
  status: 'todo',
  priority: 'high',
  project_id: null,
  thinking_budget: 'high',
  thinking_auto_estimated: false,
  model: null,
  execution_mode: 'interactive',
  auto_created: false,
  auto_start: true,
  blocked_reason: null,
  status_reason: null,
  active_agent: null,
  completed_by: null,
  attempt_count: 0,
  session_refs: [],
  parent_id: null,
  personality_id: null,
  created_at: '2026-04-10T00:00:00.000Z',
  updated_at: '2026-04-10T00:00:00.000Z',
  started_at: null,
  completed_at: null,
  archived_at: null,
  at_slug: null,
  at_name: null,
  at_color: null,
  at_category: null,
};

describe('TaskManagerDB queryTasks search', () => {
  let taskManager: TaskManagerDB;

  beforeEach(() => {
    taskManager = new TaskManagerDB();
    mockQuery.mockReset();
  });

  function mockHydrateQueries() {
    mockQuery
      .mockResolvedValueOnce({ rows: [baseRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
  }

  test('searches by title fragments, excludes the current task, and ranks exact matches first', async () => {
    mockHydrateQueries();

    const tasks = await taskManager.queryTasks({
      q: 'dependency picker',
      excludeTaskId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      limit: 12,
    });

    expect(tasks).toHaveLength(1);

    const [query, params] = mockQuery.mock.calls[0];
    expect(query).toContain('t.status <> \'archived\'');
    expect(query).toContain('t.title ILIKE');
    expect(query).toContain('t.id::text ILIKE');
    expect(query).toContain('REPLACE(LOWER(t.id::text), \'-\', \'\') LIKE');
    expect(query).toContain('LEFT(REPLACE(LOWER(t.id::text), \'-\', \'\'), 8)');
    expect(query).toContain('LOWER(t.title) =');
    expect(query).toContain('t.id <>');
    expect(query).toContain('LIMIT 12');
    expect(params).toEqual([
      '%dependency picker%',
      '%dependency picker%',
      'dependency picker',
      'dependency picker',
      'dependen',
      'dependency picker',
      'dependency picker%',
      '%dependency picker%',
      'dependency picker%',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    ]);
  });

  test('normalizes hyphenless and short id searches', async () => {
    mockHydrateQueries();

    await taskManager.queryTasks({ q: '1ad5375c2f1d4768a71c864f6edfeee7', limit: 5 });

    let [, params] = mockQuery.mock.calls[0];
    expect(params[0]).toBe('%1ad5375c2f1d4768a71c864f6edfeee7%');
    expect(params[1]).toBe('%1ad5375c2f1d4768a71c864f6edfeee7%');
    expect(params[2]).toBe('1ad5375c2f1d4768a71c864f6edfeee7');
    expect(params[3]).toBe('1ad5375c2f1d4768a71c864f6edfeee7');
    expect(params[4]).toBe('1ad5375c');

    mockQuery.mockReset();
    mockHydrateQueries();

    await taskManager.queryTasks({ q: '1ad5375c', limit: 5 });

    [, params] = mockQuery.mock.calls[0];
    expect(params[0]).toBe('%1ad5375c%');
    expect(params[1]).toBe('%1ad5375c%');
    expect(params[2]).toBe('1ad5375c');
    expect(params[3]).toBe('1ad5375c');
    expect(params[4]).toBe('1ad5375c');
  });
});

describe('TaskManagerDB getCurrentTask', () => {
  beforeEach(() => mockQuery.mockReset());

  test('returns the most recently updated in-progress task', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ ...baseRow, status: 'in-progress' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const task = await new TaskManagerDB().getCurrentTask();
    expect(task?.id).toBe(baseRow.id);

    const [query, params] = mockQuery.mock.calls[0];
    expect(query).toContain('WHERE t.status = $1');
    expect(query).toContain('ORDER BY t.updated_at DESC');
    expect(query).toContain('LIMIT 1');
    expect(params).toEqual(['in-progress']);
  });

  test('returns null when no task is in progress', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(new TaskManagerDB().getCurrentTask()).resolves.toBeNull();
  });
});

describe('TaskManagerDB claim eligibility', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    // C2 added a readiness sync inside the claim transaction. This suite
    // mocks the pool query-by-query, so an unqueued call would otherwise
    // return undefined and crash on `.rows`. A default keeps the queued
    // sequence and every index-based assertion below exactly as they were.
    mockQuery.mockResolvedValue({ rows: [] });
  });

  function mockIdentityColumns() {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ present: 1 }] })
      .mockResolvedValueOnce({ rows: [{ present: 1 }] });
  }

  test('claims only armed tasks whose semantic dependencies are complete', async () => {
    mockIdentityColumns();
    mockQuery.mockResolvedValueOnce({ rows: [{ id: baseRow.id }] });

    await expect(new TaskManagerDB().claimTask(baseRow.id, 'principal-id')).resolves.toBe('claimed');
    const [query] = mockQuery.mock.calls[2];
    expect(query).toContain('AND auto_start = TRUE');
    expect(query).toContain("prerequisite.status = 'completed'");
    expect(query).toContain("prerequisite.archive_disposition = 'completed'");
  });

  test('returns a typed unarmed result for parked tasks', async () => {
    mockIdentityColumns();
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ owner_principal_id: null, auto_start: false, verifier_principal_id: null, dependency_blocked: false }] });

    await expect(new TaskManagerDB().claimTask(baseRow.id, 'principal-id')).resolves.toBe('unarmed');
  });

  test('returns a typed dependency-blocked result', async () => {
    mockIdentityColumns();
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ owner_principal_id: null, auto_start: true, verifier_principal_id: null, dependency_blocked: true }] });

    await expect(new TaskManagerDB().claimTask(baseRow.id, 'principal-id')).resolves.toBe('dependency_blocked');
  });
});
