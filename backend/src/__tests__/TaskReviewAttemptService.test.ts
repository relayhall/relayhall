import { buildCanonicalReviewSlice, TaskReviewAttemptService } from '../services/TaskReviewAttemptService';

const snapshot = '2026-08-06T12:00:00.000Z';

function harness(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const row = {
    id: 'attempt-1',
    task_id: 'task-1',
    status: 'running',
    task_status: 'review',
    attempt_count: 0,
    max_retries: 3,
    task_snapshot_updated_at: snapshot,
    current_task_updated_at: snapshot,
    review_slice: [{ index: 1, subtaskId: 's1' }],
    ...overrides,
  };
  const client = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT a.*')) return { rowCount: 1, rows: [row] };
      if (sql.includes('UPDATE subtasks')) return { rowCount: 1, rows: [{ index: 1 }] };
      if (sql.includes('SELECT status FROM subtasks')) return { rowCount: 2, rows: [{ status: 'completed' }, { status: 'skipped' }] };
      return { rowCount: 1, rows: [] };
    }),
    release: jest.fn(),
  };
  const pool = { connect: jest.fn(async () => client) } as any;
  return { service: new TaskReviewAttemptService(pool), client, calls };
}

describe('TaskReviewAttemptService immutable verdict slice', () => {
  test('PASS resolves only the stored review indexes and completes an all-done parent atomically', async () => {
    const { service, calls, client } = harness();
    const result = await service.recordVerdict('attempt-1', 'pass', [], { summary: 'accepted exact slice' });
    expect(result).toEqual({ status: 'completed', attemptCount: 0, applied: true });
    const resolution = calls.find(call => call.sql.includes('UPDATE subtasks'))!;
    expect(resolution.params?.[1]).toEqual([1]);
    expect(resolution.params?.[2]).toBe('completed');
    expect(calls.some(call => call.sql.includes('SELECT status FROM subtasks'))).toBe(true);
    expect(calls.some(call => call.sql === 'COMMIT')).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });

  test('REJECT resets only the stored slice and returns the parent to To Do', async () => {
    const { service, calls } = harness();
    const result = await service.recordVerdict('attempt-1', 'reject', [{ message: 'bad' }], { summary: 'fix this' });
    expect(result).toEqual({ status: 'todo', attemptCount: 1, applied: true });
    const resolution = calls.find(call => call.sql.includes('UPDATE subtasks'))!;
    expect(resolution.params?.[1]).toEqual([1]);
    expect(resolution.params?.[2]).toBe('empty');
  });

  test('fails closed when the task snapshot changed after the attempt began', async () => {
    const { service, calls } = harness({ current_task_updated_at: '2026-08-06T12:00:01.000Z' });
    await expect(service.recordVerdict('attempt-1', 'pass', [], { summary: 'stale' }))
      .rejects.toThrow('Task snapshot changed before Verifier verdict');
    expect(calls.some(call => call.sql.includes('UPDATE subtasks'))).toBe(false);
    expect(calls.some(call => call.sql === 'ROLLBACK')).toBe(true);
  });

  test('rolls back when any immutable slice row is no longer awaiting review', async () => {
    const { service, client, calls } = harness();
    client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT a.*')) return { rowCount: 1, rows: [{
        id: 'attempt-1', task_id: 'task-1', status: 'running', task_status: 'review',
        attempt_count: 0, max_retries: 3, task_snapshot_updated_at: snapshot,
        current_task_updated_at: snapshot, review_slice: [{ index: 1 }, { index: 2 }],
      }] };
      if (sql.includes('UPDATE subtasks')) return { rowCount: 1, rows: [{ index: 1 }] };
      return { rowCount: 1, rows: [] };
    });
    await expect(service.recordVerdict('attempt-1', 'pass', [], { summary: 'partial' }))
      .rejects.toThrow('Immutable review slice changed before Verifier verdict');
    expect(calls.some(call => call.sql === 'ROLLBACK')).toBe(true);
    expect(calls.some(call => call.sql.startsWith('UPDATE tasks'))).toBe(false);
  });
});

describe('TaskReviewAttemptService attempt sequencing', () => {
  const task = {
    id: 'task-1',
    updated: snapshot,
    attemptCount: 0,
    subtasks: [{
      id: 'subtask-1', text: 'Review me', status: 'review', completedAt: snapshot,
      reviewNote: 'evidence-report-1',
    }],
  } as any;

  function beginHarness(options: { existing?: boolean; max?: number } = {}) {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const client = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes('SELECT status, updated_at')) return { rowCount: 1, rows: [{ status: 'review', updated_at: snapshot, attempt_count: 0, max_retries: 3 }] };
        if (sql.includes('task_snapshot_updated_at=$2')) {
          return options.existing
            ? { rowCount: 1, rows: [{ id: 'existing', attempt_no: 1, idempotency_key: 'same', review_slice: buildCanonicalReviewSlice(task), status: 'escalated' }] }
            : { rowCount: 0, rows: [] };
        }
        if (sql.includes('COALESCE(MAX(attempt_no)')) return { rowCount: 1, rows: [{ attempt_no: (options.max ?? 0) + 1 }] };
        if (sql.includes('INSERT INTO task_review_attempts')) return { rowCount: 1, rows: [{ id: 'new', attempt_no: (options.max ?? 0) + 1, idempotency_key: 'new-key', review_slice: buildCanonicalReviewSlice(task), status: 'running' }] };
        return { rowCount: 1, rows: [] };
      }),
      release: jest.fn(),
    };
    const pool = { connect: jest.fn(async () => client) } as any;
    return { service: new TaskReviewAttemptService(pool), calls };
  }

  test('uses the immutable ledger sequence after a non-budget escalation', async () => {
    const { service, calls } = beginHarness({ max: 1 });
    const attempt = await service.beginAttempt(task, { report: 'evidence-report-2' });
    expect(attempt.attemptNo).toBe(2);
    const insert = calls.find(call => call.sql.includes('INSERT INTO task_review_attempts'))!;
    expect(insert.params?.[1]).toBe(2);
  });

  test('returns the existing attempt for an identical immutable snapshot', async () => {
    const { service, calls } = beginHarness({ existing: true, max: 1 });
    const attempt = await service.beginAttempt(task, { report: 'same-evidence' });
    expect(attempt).toMatchObject({ id: 'existing', attemptNo: 1, status: 'escalated' });
    expect(calls.some(call => call.sql.includes('COALESCE(MAX(attempt_no)'))).toBe(false);
    expect(calls.some(call => call.sql.includes('INSERT INTO task_review_attempts'))).toBe(false);
  });
});
