import { OrchestrationConflictError, TaskOrchestrationService } from '../services/TaskOrchestrationService';

interface FakeOptions {
  dependencies?: any[];
  existingLease?: any;
  globalCount?: number;
  projectCount?: number;
  insertError?: any;
}

function fakePool(task: any, options: FakeOptions = {}) {
  const queries: Array<{ sql: string; params?: any[] }> = [];
  const client = {
    query: jest.fn(async (sql: string, params?: any[]) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: null, rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [{}] };
      if (sql.includes("SET status = 'expired'")) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM tasks') && sql.includes('FOR UPDATE')) return { rowCount: task ? 1 : 0, rows: task ? [task] : [] };
      if (sql.includes('FROM task_execution_leases') && sql.includes('task_id = $1') && sql.includes('FOR UPDATE')) {
        return options.existingLease
          ? { rowCount: 1, rows: [options.existingLease] }
          : { rowCount: 0, rows: [] };
      }
      if (sql.includes('FROM task_dependencies')) {
        const rows = options.dependencies || [];
        return { rowCount: rows.length, rows };
      }
      if (sql.includes('COUNT(*)::int') && sql.includes('JOIN tasks leased_task')) {
        return { rowCount: 1, rows: [{ count: options.projectCount || 0 }] };
      }
      if (sql.includes('COUNT(*)::int') && sql.includes('FROM task_execution_leases')) {
        return { rowCount: 1, rows: [{ count: options.globalCount || 0 }] };
      }
      if (sql.includes('INSERT INTO task_execution_leases')) {
        if (options.insertError) throw options.insertError;
        return {
          rowCount: 1,
          rows: [{
            id: 'lease-1', task_id: task.id, resource_key: params?.[1], harness: params?.[2],
            session_key: params?.[3], status: 'active', claimed_task_updated_at: task.updated_at,
            acquired_at: '2026-07-15T00:00:00.000Z', expires_at: '2026-07-15T00:15:00.000Z',
          }],
        };
      }
      if (sql.includes('UPDATE tasks')) return { rowCount: 1, rows: [{ id: task.id }] };
      if (sql.includes('INSERT INTO task_history')) return { rowCount: 1, rows: [] };
      // RH-P3.C1: the claim now emits task.updated in its transaction.
      if (sql.includes('INSERT INTO feed_events')) return { rowCount: 1, rows: [] };
      // RH-P3.C2 (pre-review F3): the claim also retracts the task.ready
      // announcement — a claimed task has left the ready state. The readiness
      // evaluation reuses the locked `FROM tasks ... FOR UPDATE` read above,
      // whose row carries no `ready` column, so it correctly resolves to
      // not-ready and issues the retraction handled here.
      if (sql.includes('task_readiness')) return { rowCount: 0, rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    }),
    release: jest.fn(),
  };
  return {
    pool: { connect: jest.fn(async () => client) } as any,
    client,
    queries,
  };
}

const readyTask = {
  id: 'task-1',
  title: 'Ready task',
  status: 'todo',
  auto_start: true,
  updated_at: '2026-07-15T10:00:00.000Z',
  project_id: 'project-1',
  execution_mode: 'subagent',
  execution_profile: { harness: 'hermes' },
  archive_disposition: null,
};

function claim(service: TaskOrchestrationService, overrides: Record<string, unknown> = {}) {
  return service.claimReadyTask({
    taskId: readyTask.id,
    snapshotUpdatedAt: readyTask.updated_at,
    harness: 'hermes',
    resourceKey: 'worktree:a422c1eb',
    ...overrides,
  });
}

// A service with BOTH bounds set to 1 - the tightest policy - so every
// existing assertion still runs under a bound. The unbounded default is
// proven separately below (card 590c638a, ruling 2).
function boundedService(pool: any, limits: Record<string, unknown> = {}) {
  return new TaskOrchestrationService(pool, {
    maxActiveGlobal: 1,
    maxActivePerProject: 1,
    leaseTtlSeconds: 900,
    ...limits,
  });
}

describe('TaskOrchestrationService', () => {
  test('atomically claims a ready dependency-safe auto-start task and writes history', async () => {
    const fake = fakePool(readyTask);
    const service = boundedService(fake.pool, { maxActiveGlobal: 2, maxActivePerProject: 2 });
    const result = await claim(service);

    expect(result.acquired).toBe(true);
    expect(result.lease.id).toBe('lease-1');
    expect(result.lease.harness).toBe('hermes');
    expect(fake.client.query).toHaveBeenCalledWith('COMMIT');
    expect(fake.queries.some(({ sql }) => sql.includes("status = 'in-progress'"))).toBe(true);
    expect(fake.queries.some(({ sql }) => sql.includes('INSERT INTO task_history'))).toBe(true);
    expect(fake.queries.find(({ sql }) => sql.includes('FROM task_dependencies'))?.sql).toContain('FOR UPDATE OF parent');
    expect(fake.queries.some(({ sql }) => sql.includes('pg_advisory_xact_lock'))).toBe(true);
  });

  test('returns the same non-acquiring lease for a matching replay despite timestamp precision drift', async () => {
    const existingLease = {
      id: 'lease-existing', task_id: readyTask.id, resource_key: 'worktree:a422c1eb', harness: 'hermes',
      status: 'active', claimed_task_updated_at: readyTask.updated_at,
      acquired_at: '2026-07-15T00:00:00.000Z', expires_at: '2026-07-15T00:15:00.000Z',
    };
    const fake = fakePool({ ...readyTask, status: 'in-progress' }, { existingLease });
    const result = await claim(boundedService(fake.pool), { snapshotUpdatedAt: '2026-07-15T10:00:00.001Z' });
    expect(result).toMatchObject({ acquired: false, lease: { id: 'lease-existing' } });
    expect(fake.queries.some(({ sql }) => sql.includes('INSERT INTO task_execution_leases'))).toBe(false);
    expect(fake.client.query).toHaveBeenCalledWith('COMMIT');
  });

  test('accepts an API ISO snapshot matching a PostgreSQL Date with milliseconds', async () => {
    const updatedAt = new Date('2026-07-15T10:00:00.123Z');
    const task = { ...readyTask, updated_at: updatedAt };
    const fake = fakePool(task);
    await expect(boundedService(fake.pool).claimReadyTask({
      taskId: task.id,
      snapshotUpdatedAt: updatedAt.toISOString(),
      harness: 'hermes',
      resourceKey: 'worktree:a422c1eb',
    })).resolves.toMatchObject({ acquired: true, lease: { id: 'lease-1' } });
  });

  test('fails closed when auto-start is disabled', async () => {
    const fake = fakePool({ ...readyTask, auto_start: false });
    await expect(claim(boundedService(fake.pool))).rejects.toMatchObject({ code: 'AUTO_START_DISABLED' });
    expect(fake.client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  test('rejects a harness that differs from the task execution profile', async () => {
    const fake = fakePool(readyTask);
    await expect(claim(boundedService(fake.pool), { harness: 'openclaw' }))
      .rejects.toMatchObject({ code: 'HARNESS_MISMATCH' });
  });

  test.each([
    [{ id: 'p1', status: 'todo', archive_disposition: null }],
    [{ id: 'p1', status: 'archived', archive_disposition: 'abandoned' }],
  ])('rejects operationally unmet dependencies %#', async (parent: any) => {
    const fake = fakePool(readyTask, { dependencies: [parent] });
    await expect(claim(boundedService(fake.pool)))
      .rejects.toMatchObject({ code: 'UNMET_DEPENDENCY' });
  });

  test.each([
    [{ id: 'p1', status: 'completed', archive_disposition: null }],
    [{ id: 'p1', status: 'archived', archive_disposition: 'completed' }],
  ])('accepts completion-satisfying dependencies %#', async (parent: any) => {
    const fake = fakePool(readyTask, { dependencies: [parent] });
    await expect(claim(boundedService(fake.pool))).resolves.toMatchObject({ acquired: true, lease: { id: 'lease-1' } });
  });

  test('enforces global and per-project active lease budgets', async () => {
    const global = fakePool(readyTask, { globalCount: 1 });
    await expect(claim(boundedService(global.pool)))
      .rejects.toMatchObject({ code: 'GLOBAL_CAPACITY_EXHAUSTED' });

    const project = fakePool(readyTask, { projectCount: 1 });
    await expect(claim(boundedService(project.pool, { maxActiveGlobal: 2, maxActivePerProject: 1 })))
      .rejects.toMatchObject({ code: 'PROJECT_CAPACITY_EXHAUSTED' });
  });

  test('maps unique active task/resource conflicts to a stable error', async () => {
    const fake = fakePool(readyTask, { insertError: { code: '23505' } });
    await expect(claim(boundedService(fake.pool)))
      .rejects.toEqual(expect.objectContaining<Partial<OrchestrationConflictError>>({ code: 'ACTIVE_LEASE_CONFLICT' }));
  });

  // ── RH-P3.C3: never-self-review on the scheduler plane ──────────────────
  //
  // Strategy 4e40f06f §2.6.4, RATIFIED 2026-08-02 (C4): "the server refuses
  // claimant == verifier". The principal-plane claim has carried this since
  // RH-P2.5; this plane never read the column. These are the cheap branch
  // pins — the behavioural proof runs against real PostgreSQL through the
  // production service in backend/scripts/test-c3-lease-lifecycle.js.
  test('refuses a claim by the Task Verifier', async () => {
    const fake = fakePool({ ...readyTask, verifier_principal_id: 'principal-v' });
    await expect(claim(boundedService(fake.pool), { claimantPrincipalId: 'principal-v' }))
      .rejects.toMatchObject({ code: 'CLAIMANT_VERIFIER_CONFLICT' });
    expect(fake.queries.some(({ sql }) => sql.includes('INSERT INTO task_execution_leases'))).toBe(false);
    expect(fake.client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  test('reads the Verifier from the row it already locked', async () => {
    const fake = fakePool({ ...readyTask, verifier_principal_id: 'principal-v' });
    await claim(boundedService(fake.pool), { claimantPrincipalId: 'principal-c' });
    const taskRead = fake.queries.find(({ sql }) => sql.includes('FROM tasks') && sql.includes('FOR UPDATE'));
    expect(taskRead?.sql).toContain('verifier_principal_id');
  });

  test('the refusal outranks the idempotent-replay branch', async () => {
    // The one order that actually produces this state: claimed first, given
    // its Verifier afterwards. A replay must not be handed a receipt for a
    // request the server is now required to refuse.
    const existingLease = {
      id: 'lease-existing', task_id: readyTask.id, resource_key: 'worktree:a422c1eb', harness: 'hermes',
      status: 'active', claimed_task_updated_at: readyTask.updated_at,
      acquired_at: '2026-07-15T00:00:00.000Z', expires_at: '2026-07-15T00:15:00.000Z',
    };
    const fake = fakePool(
      { ...readyTask, status: 'in-progress', verifier_principal_id: 'principal-v' },
      { existingLease },
    );
    await expect(claim(boundedService(fake.pool), { claimantPrincipalId: 'principal-v' }))
      .rejects.toMatchObject({ code: 'CLAIMANT_VERIFIER_CONFLICT' });
  });

  test('a different principal, and an absent principal, still claim', async () => {
    const other = fakePool({ ...readyTask, verifier_principal_id: 'principal-v' });
    await expect(claim(boundedService(other.pool), { claimantPrincipalId: 'principal-c' }))
      .resolves.toMatchObject({ acquired: true });
    // A missing identity is "nothing to compare", never an exemption: it
    // cannot equal a set Verifier, and it grants no extra authority — the
    // route ceiling is what keeps unauthenticated callers out.
    const anonymous = fakePool({ ...readyTask, verifier_principal_id: 'principal-v' });
    await expect(claim(boundedService(anonymous.pool))).resolves.toMatchObject({ acquired: true });
  });

  test('an unset Verifier refuses nobody', async () => {
    const fake = fakePool({ ...readyTask, verifier_principal_id: null });
    await expect(claim(boundedService(fake.pool), { claimantPrincipalId: 'principal-c' }))
      .resolves.toMatchObject({ acquired: true });
  });

  // ── Card 590c638a: the surface is ALWAYS ON; bounds are optional policy ──

  test('an unconfigured service claims: there is no switch, and no bound is checked', async () => {
    // Counts that would exhaust any finite bound - with no bound configured
    // they are never even asked for.
    const fake = fakePool(readyTask, { globalCount: 999, projectCount: 999 });
    await expect(claim(new TaskOrchestrationService(fake.pool)))
      .resolves.toMatchObject({ acquired: true, lease: { id: 'lease-1' } });
    const sql = fake.queries.map((q) => q.sql);
    expect(sql.some((s) => s.includes('COUNT(*)::int'))).toBe(false);
    // The CAPACITY lock (key 1129072962) is never taken; the feed-event
    // emitter's own advisory lock is a different lock and still runs.
    expect(fake.queries.some((q) => q.sql.includes('pg_advisory_xact_lock') && (q.params ?? []).includes(1129072962))).toBe(false);
  });

  test('effectiveConfiguration reads back what configure() set, "unlimited" for a null bound', () => {
    const service = new TaskOrchestrationService(fakePool(readyTask).pool);
    expect(service.effectiveConfiguration()).toEqual({
      claimSurface: 'always-on', maxActiveGlobal: 'unlimited', maxActivePerProject: 'unlimited', leaseTtlSeconds: 900,
    });
    service.configure({ maxActiveGlobal: 7, maxActivePerProject: 3, leaseTtlSeconds: 120 });
    expect(service.effectiveConfiguration()).toEqual({
      claimSurface: 'always-on', maxActiveGlobal: 7, maxActivePerProject: 3, leaseTtlSeconds: 120,
    });
    service.configure({ maxActiveGlobal: 7, maxActivePerProject: null, leaseTtlSeconds: 120 });
    expect(service.effectiveConfiguration().maxActivePerProject).toBe('unlimited');
  });

  test('a global bound alone: the global count is judged, the project count never asked for', async () => {
    const roomy = fakePool(readyTask, { globalCount: 1, projectCount: 999 });
    await expect(claim(boundedService(roomy.pool, { maxActiveGlobal: 2, maxActivePerProject: null })))
      .resolves.toMatchObject({ acquired: true });
    expect(roomy.queries.some((q) => q.sql.includes('JOIN tasks leased_task'))).toBe(false);

    const full = fakePool(readyTask, { globalCount: 2 });
    await expect(claim(boundedService(full.pool, { maxActiveGlobal: 2, maxActivePerProject: null })))
      .rejects.toMatchObject({ code: 'GLOBAL_CAPACITY_EXHAUSTED' });
  });

  test('a project bound alone: the project count is judged, the global count never asked for', async () => {
    const roomy = fakePool(readyTask, { globalCount: 999, projectCount: 0 });
    await expect(claim(boundedService(roomy.pool, { maxActiveGlobal: null, maxActivePerProject: 1 })))
      .resolves.toMatchObject({ acquired: true });
    expect(roomy.queries.some((q) => q.sql.includes('COUNT(*)::int') && !q.sql.includes('JOIN tasks leased_task'))).toBe(false);

    const full = fakePool(readyTask, { projectCount: 1 });
    await expect(claim(boundedService(full.pool, { maxActiveGlobal: null, maxActivePerProject: 1 })))
      .rejects.toMatchObject({ code: 'PROJECT_CAPACITY_EXHAUSTED' });
  });

  test('configure refuses a non-positive bound but accepts null', () => {
    const service = new TaskOrchestrationService(fakePool(readyTask).pool);
    expect(() => service.configure({ maxActiveGlobal: 0, maxActivePerProject: null, leaseTtlSeconds: 900 })).toThrow(/unlimited\) or a positive integer/);
    expect(() => service.configure({ maxActiveGlobal: null, maxActivePerProject: 1.5, leaseTtlSeconds: 900 })).toThrow(/unlimited\) or a positive integer/);
    expect(() => service.configure({ maxActiveGlobal: null, maxActivePerProject: null, leaseTtlSeconds: 900 })).not.toThrow();
  });
});
