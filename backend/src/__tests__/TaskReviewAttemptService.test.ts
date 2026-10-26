import { buildCanonicalReviewSlice, hashReviewReports, TaskReviewAttemptService, VERDICT_REFERENCE_BUSY_RETRIES } from '../services/TaskReviewAttemptService';
import { accessVehicleService, AssignmentAccessError } from '../services/AccessVehicleService';

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
    review_slice_version: 1,
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
  return { service: new TaskReviewAttemptService(pool), client, calls, pool };
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
        current_task_updated_at: snapshot, review_slice_version: 1,
        review_slice: [{ index: 1 }, { index: 2 }],
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

// Card 0616c363: the verdict owner rolls back and retries ASSIGNMENT_REFERENCE_BUSY,
// bounded; a supplied transaction stays its caller's to roll back and retry.
describe('TaskReviewAttemptService verdict owner retries a busy reference', () => {
  const busy = () => new AssignmentAccessError(409, 'ASSIGNMENT_REFERENCE_BUSY', 'Assignment reference lifecycle busy; roll back and retry the transaction');
  afterEach(() => jest.restoreAllMocks());
  function owned() {
    const h = harness(), pauses: number[] = [];
    const service = new TaskReviewAttemptService(h.pool, 300000, { referenceBusyPause: async (attempt) => { pauses.push(attempt); } });
    return { ...h, service, pauses, sql: (text: string) => h.calls.filter(call => call.sql === text).length };
  }

  test('a busy attempt is rolled back and released, then re-run whole on a fresh transaction', async () => {
    const { service, client, pauses, sql } = owned();
    const detach = jest.spyOn(accessVehicleService, 'detach').mockRejectedValueOnce(busy()).mockResolvedValue(undefined as never);
    expect(await service.recordVerdict('attempt-1', 'pass', [], { summary: 'accepted' })).toEqual({ status: 'completed', attemptCount: 0, applied: true });
    expect(detach).toHaveBeenCalledTimes(2); expect(pauses).toEqual([1]);
    expect({ begin: sql('BEGIN'), rollback: sql('ROLLBACK'), commit: sql('COMMIT') }).toEqual({ begin: 2, rollback: 1, commit: 1 });
    expect(client.release).toHaveBeenCalledTimes(2);
  });

  test('sustained contention is bounded and still answers the typed 409', async () => {
    const { service, pauses, sql } = owned();
    const detach = jest.spyOn(accessVehicleService, 'detach').mockRejectedValue(busy());
    await expect(service.recordVerdict('attempt-1', 'pass', [], { summary: 'accepted' }))
      .rejects.toMatchObject({ status: 409, code: 'ASSIGNMENT_REFERENCE_BUSY' });
    expect(detach).toHaveBeenCalledTimes(VERDICT_REFERENCE_BUSY_RETRIES + 1);
    expect(pauses).toEqual(Array.from({ length: VERDICT_REFERENCE_BUSY_RETRIES }, (_, index) => index + 1));
    expect({ rollback: sql('ROLLBACK'), commit: sql('COMMIT') }).toEqual({ rollback: VERDICT_REFERENCE_BUSY_RETRIES + 1, commit: 0 });
  });

  test('a supplied transaction is never retried here, and other failures are not retried', async () => {
    const { service, client, pauses, sql } = owned();
    jest.spyOn(accessVehicleService, 'detach').mockRejectedValue(busy());
    await expect(service.recordVerdict('attempt-1', 'pass', [], { summary: 'accepted' }, undefined, false, client as any))
      .rejects.toMatchObject({ code: 'ASSIGNMENT_REFERENCE_BUSY' });
    expect({ pauses, begin: sql('BEGIN'), rollback: sql('ROLLBACK') }).toEqual({ pauses: [], begin: 0, rollback: 0 });
    jest.spyOn(accessVehicleService, 'detach').mockRejectedValue(new Error('storage failure'));
    await expect(service.recordVerdict('attempt-1', 'pass', [], { summary: 'accepted' })).rejects.toThrow('storage failure');
    expect({ pauses, rollback: sql('ROLLBACK') }).toEqual({ pauses: [], rollback: 1 });
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

  function beginHarness(options: { existing?: boolean; max?: number; status?: string } = {}) {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const client = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes('SELECT status, updated_at')) return { rowCount: 1, rows: [{ status: options.status || 'review', updated_at: snapshot, attempt_count: 0, max_retries: 3 }] };
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

  test('returns a typed conflict when a concurrent verdict moved the task out of Review', async () => {
    const { service, calls } = beginHarness({ status: 'completed' });
    await expect(service.beginAttempt(task, { report: 'same-evidence' }))
      .rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(calls.some(call => call.sql === 'ROLLBACK')).toBe(true);
    expect(calls.some(call => call.sql.includes('INSERT INTO task_review_attempts'))).toBe(false);
  });
});

describe('TaskReviewAttemptService flat Task evidence', () => {
  const reports = [{ id: 'report-1', title: 'Independent findings', summary: 'Changes required', content: 'Exact design review bytes' }];
  const reportDigest = hashReviewReports(reports);
  const receipt = 'a'.repeat(64);
  const task = { id: 'task-1', updated: snapshot, subtasks: [], attemptCount: 0 } as any;

  test('builds a singleton version-2 Task marker instead of a fictitious subtask', () => {
    expect(buildCanonicalReviewSlice(task, { implementationReceiptHash: receipt, reportDigest })).toEqual([{
      kind: 'flat_task_review', taskId: task.id, taskSnapshotUpdatedAt: snapshot,
      evidenceReceipt: receipt, reportDigest,
    }]);
    expect(() => buildCanonicalReviewSlice(task)).toThrow('immutable evidence');
  });

  function flatHarness(options: { changedReport?: boolean; addedSubtask?: boolean; staleSnapshot?: boolean } = {}) {
    const marker = buildCanonicalReviewSlice(task, { implementationReceiptHash: receipt, reportDigest });
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const client = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes('SELECT a.*')) return { rowCount: 1, rows: [{
          id: 'attempt-flat', task_id: task.id, status: 'running', task_status: 'review',
          attempt_count: 0, max_retries: 3, task_snapshot_updated_at: snapshot,
          current_task_updated_at: options.staleSnapshot ? '2026-08-06T12:00:01.000Z' : snapshot,
          review_slice_version: 2, review_slice: marker, implementation_receipt_hash: receipt,
        }] };
        if (sql.includes('pg_try_advisory_xact_lock')) return { rowCount: 1, rows: [{ acquired: true }] };
        if (sql.includes('FROM reports')) return { rowCount: 1, rows: options.changedReport
          ? [{ ...reports[0], content: 'changed bytes' }] : reports };
        if (sql.includes('SELECT id FROM subtasks')) return {
          rowCount: options.addedSubtask ? 1 : 0, rows: options.addedSubtask ? [{ id: 'new' }] : [],
        };
        return { rowCount: 1, rows: [] };
      }),
      release: jest.fn(),
    };
    return { service: new TaskReviewAttemptService({ connect: jest.fn(async () => client) } as any), calls };
  }

  test('passes an unchanged flat Task without writing any subtask row', async () => {
    const { service, calls } = flatHarness();
    expect(await service.recordVerdict('attempt-flat', 'pass', [], { summary: 'approved' }))
      .toEqual({ status: 'completed', attemptCount: 0, applied: true });
    expect(calls.some((call) => call.sql.includes('UPDATE subtasks'))).toBe(false);
    const taskWrite = calls.find((call) => call.sql.startsWith('UPDATE tasks'));
    expect(taskWrite?.sql).toContain("completed_at=CASE WHEN $2::varchar='completed' THEN NOW() ELSE NULL END");
    expect(taskWrite?.params?.[1]).toBe('completed');
  });

  test('rejects an unchanged flat Task once with retry budget and no subtask write', async () => {
    const { service, calls } = flatHarness();
    expect(await service.recordVerdict('attempt-flat', 'reject', [{ message: 'fix' }], { summary: 'changes' }))
      .toEqual({ status: 'todo', attemptCount: 1, applied: true });
    expect(calls.some((call) => call.sql.includes('UPDATE subtasks'))).toBe(false);
    const taskWrite = calls.find((call) => call.sql.startsWith('UPDATE tasks'));
    expect(taskWrite?.sql).toContain("completed_at=CASE WHEN $2::varchar='completed' THEN NOW() ELSE NULL END");
    expect(taskWrite?.params?.[1]).toBe('todo');
  });

  test.each([
    ['linked Report bytes', { changedReport: true }, 'Linked Report evidence changed'],
    ['new subtask', { addedSubtask: true }, 'Flat Task gained a subtask'],
    ['Task snapshot', { staleSnapshot: true }, 'Task snapshot changed'],
  ])('refuses stale %s before applying a flat verdict', async (_label, options, reason) => {
    const { service, calls } = flatHarness(options);
    await expect(service.recordVerdict('attempt-flat', 'pass', [], { summary: 'stale' })).rejects.toThrow(reason);
    expect(calls.some((call) => call.sql.startsWith('UPDATE tasks'))).toBe(false);
    expect(calls.some((call) => call.sql === 'ROLLBACK')).toBe(true);
  });
});
