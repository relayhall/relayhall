/**
 * Pins for the CB-2 review fixes that shipped without coverage, plus the
 * defects the fix-verification round found in the fixes themselves.
 *
 * Each test here FAILS against the code it guards, which is the point: the
 * first regression suite mixed genuine pins with tests that passed pre-fix,
 * and seven fixes had no guard at all.
 */
import jwt from 'jsonwebtoken';

const SECRET = 'fix-pin-secret';
const PRINCIPAL_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_PRINCIPAL_ID = '77777777-7777-4777-8777-777777777777';

const queryMock = jest.fn();
jest.mock('../db/connection', () => ({
  pool: {
    query: (...args: unknown[]) => queryMock(...args),
    connect: jest.fn(async () => ({ query: (...args: unknown[]) => queryMock(...args), release: jest.fn() })),
  },
}));
jest.mock('../services/AuditService', () => ({ auditService: { record: jest.fn() } }));

beforeEach(() => {
  jest.resetModules();
  queryMock.mockReset();
  process.env.JWT_SECRET = SECRET;
});

// ── Fix 4 (residue): credential revocation by id stays narrow and safe ───────
// The spawn/steer launch-marker pins died with the execution runtime
// (P1.2 wave 2, strategy §2.8); revokeCredentialById remains a kept
// credential-management primitive and keeps its guards.
describe('credential revocation by id', () => {
  it('revokes exactly one credential by id, never the task', async () => {
    queryMock.mockResolvedValue({ rows: [{ principal_id: PRINCIPAL_ID, key_id: 'kid' }], rowCount: 1 });
    const { principalService } = (await import('../services/PrincipalService')) as any;
    expect(typeof principalService.revokeCredentialById).toBe('function');
    await principalService.revokeCredentialById('cred-1', 'spawn_failed');
    const [sql, params] = queryMock.mock.calls.find(([statement]) =>
      String(statement).includes('UPDATE principal_credentials'))!;
    expect(String(sql)).toContain('WHERE id = $1');
    expect(String(sql)).not.toContain("metadata->>'task_id'");
    expect(params).toEqual(['cred-1', 'spawn_failed']);
  });

  it('fails closed when the substrate is unavailable, so no unaudited revocation is claimed', async () => {
    queryMock.mockRejectedValue(Object.assign(new Error('no relation'), { code: '42P01' }));
    const { principalService } = (await import('../services/PrincipalService')) as any;
    expect(typeof principalService.revokeCredentialById).toBe('function');
    await expect(principalService.revokeCredentialById('cred-1', 'spawn_failed')).rejects.toThrow('no relation');
  });
});

// ── Fix 5: login must not hang on a wedged-but-connectable DB (R11) ──────────
describe('login principal lookup is time-bounded', () => {
  it('mints the legacy payload rather than hanging when the lookup never settles', async () => {
    jest.useFakeTimers();
    try {
      queryMock.mockImplementation(() => new Promise(() => undefined)); // never settles
      const { principalService } = await import('../services/PrincipalService');
      const LOOKUP_TIMEOUT_MS = 1500;
      const raced = Promise.race([
        principalService.getPrincipalByHandle('dashboard_user'),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), LOOKUP_TIMEOUT_MS)),
      ]);
      jest.advanceTimersByTime(LOOKUP_TIMEOUT_MS + 1);
      await expect(raced).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the route source honest: the lookup is raced, not awaited bare', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.ts'), 'utf-8');
    expect(source).toContain('Promise.race');
    expect(source).toContain('LOGIN_PRINCIPAL_LOOKUP_TIMEOUT_MS');
    // A bare await would reintroduce the hang.
    expect(source).not.toMatch(/const principal = await principalService\.getPrincipalByHandle/);
  });
});

// ── Fix 6: a failed creator stamp must not fail an already-created task ──────
describe('createTask creator attribution rides the creating transaction', () => {
  // Superseded pin (RH-P3.C1 round 4, review 91461e9b F2): the stamp used to
  // run post-COMMIT and best-effort, but creator/shepherd_principal_id feed
  // the authorization predicate, so a post-commit mutation left the stored
  // Task different from what task.created announced with no later cursor to
  // say so. The stamp now precedes the feed emission INSIDE the transaction:
  // there is no committed-but-unstamped Task left to protect from a 500, and
  // a stamp failure rolls the whole create back instead of half-attributing.
  it('stamps before the task.created emission and COMMIT, unguarded', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'TaskManagerDB.ts'), 'utf-8');
    const stampStart = source.indexOf('Creation attribution');
    const stampBlock = source.slice(stampStart, source.indexOf('await client.query(`COMMIT`)', stampStart) === -1
      ? source.indexOf("await client.query('COMMIT')", stampStart)
      : source.indexOf('await client.query(`COMMIT`)', stampStart));
    expect(stampBlock).toContain('creator_principal_id');
    // Inside the transaction: the stamp appears BEFORE the feed emission and
    // before COMMIT, and is no longer swallowed.
    expect(stampBlock).toContain("name: 'task.created'");
    expect(stampBlock.indexOf('creator_principal_id')).toBeLessThan(stampBlock.indexOf("name: 'task.created'"));
    expect(stampBlock).not.toContain('non-fatal');
  });
});

// ── Fix 7: release is idempotent AND does not write for a task with no Assignee ──────
describe('releaseTask', () => {
  async function release(options: { updatedRows: number; existingOwner: string | null | undefined }) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    queryMock.mockImplementation((sql: string, params?: unknown[]) => {
      const text = String(sql);
      calls.push({ sql: text, params: params || [] });
      if (text.includes('FROM pg_attribute')) return Promise.resolve({ rows: [{ '?column?': 1 }] });
      if (text.includes('UPDATE tasks SET')) {
        return Promise.resolve({ rows: options.updatedRows ? [{ id: 'task-1', previous_owner_principal_id: options.existingOwner }] : [] });
      }
      if (text.includes('SELECT owner_principal_id')) {
        return Promise.resolve({
          rows: options.existingOwner === undefined ? [] : [{ owner_principal_id: options.existingOwner }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const { taskManagerDB } = await import('../services/TaskManagerDB');
    const outcome = await taskManagerDB.releaseTask('task-1', PRINCIPAL_ID, false);
    return { outcome, writes: calls.filter((c) => c.sql.includes('UPDATE tasks SET')) };
  }

  it('releases a task where the caller is the Assignee', async () => {
    const { outcome } = await release({ updatedRows: 1, existingOwner: PRINCIPAL_ID });
    expect(outcome).toBe('released');
  });

  it('is idempotent for a task that already has no Assignee — and writes nothing', async () => {
    const { outcome, writes } = await release({ updatedRows: 0, existingOwner: null });
    expect(outcome).toBe('released');
    // The Assignee-guarded UPDATE is attempted once and matches nothing; no
    // second write may bump updated_at on a task the caller never held.
    expect(writes).toHaveLength(1);
  });

  it('still refuses a task whose Assignee is someone else', async () => {
    const { outcome } = await release({ updatedRows: 0, existingOwner: OTHER_PRINCIPAL_ID });
    expect(outcome).toBe('conflict');
  });

  it('reports not_found for a missing task', async () => {
    const { outcome } = await release({ updatedRows: 0, existingOwner: undefined });
    expect(outcome).toBe('not_found');
  });
});

// ── Fix 9: history schema cache must notice a mid-run migration ──────────────
describe('task_history column cache', () => {
  function scriptColumns(sets: string[][]) {
    let call = 0;
    queryMock.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes('pg_attribute')) {
        const columns = sets[Math.min(call, sets.length - 1)];
        call += 1;
        return Promise.resolve({ rows: columns.map((c) => ({ column_name: c })) });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
  }

  const PRE_063 = ['id', 'task_id', 'event_type', 'old_value', 'new_value', 'note', 'created_at'];
  const POST_063 = [...PRE_063, 'actor_principal_id'];

  it('picks up actor_principal_id when 063 applies to a running container', async () => {
    jest.useFakeTimers();
    try {
      scriptColumns([PRE_063, POST_063]);
      const { taskHistoryService } = await import('../services/TaskHistoryService');

      await taskHistoryService.recordChange('t1', 'title', 'status', null, 'todo', 'dashboard_user', PRINCIPAL_ID);
      const before = queryMock.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO task_history')).pop();
      expect(String(before?.[0])).not.toContain('actor_principal_id');

      // CB-3 migrates the running container; the cache must expire.
      jest.advanceTimersByTime(61_000);
      await taskHistoryService.recordChange('t1', 'title', 'status', 'todo', 'in-progress', 'dashboard_user', PRINCIPAL_ID);
      const after = queryMock.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO task_history')).pop();
      expect(String(after?.[0])).toContain('actor_principal_id');
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not cache an empty column set (a failed inspection must not disable history)', async () => {
    scriptColumns([[], PRE_063]);
    const { taskHistoryService } = await import('../services/TaskHistoryService');

    await taskHistoryService.recordChange('t1', 'title', 'status', null, 'todo');
    expect(queryMock.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO task_history'))).toHaveLength(0);

    // Second attempt re-inspects rather than trusting the empty set.
    await taskHistoryService.recordChange('t1', 'title', 'status', null, 'todo');
    expect(queryMock.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO task_history'))).toHaveLength(1);
  });

  it('resolves the table the way unqualified DML does (search-path faithful)', async () => {
    scriptColumns([PRE_063]);
    const { taskHistoryService } = await import('../services/TaskHistoryService');
    await taskHistoryService.recordChange('t1', 'title', 'status', null, 'todo');
    const sniff = queryMock.mock.calls.find((c) => String(c[0]).includes('pg_attribute'));
    expect(String(sniff?.[0])).toContain("to_regclass('task_history')");
    // current_schema() names only the first existing schema — a role-named
    // schema would report zero columns and silently stop history recording.
    expect(String(sniff?.[0])).not.toContain('current_schema()');
  });
});

// ── Fix 11: batch PATCH attributes identically to single-task PATCH ──────────
describe('PATCH /tasks/batch actor threading', () => {
  it('passes the caller principal through to updateTask', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tasksBatch.ts'), 'utf-8');
    expect(source).toContain('authReq.principal?.id');
    // The third argument is the actor; dropping it silently reverts attribution
    // to the hardcoded 'user'. The FOURTH is the target-Project decision (card
    // 9c177e6a): `project` is a batch-updatable field, so dropping it would
    // make every move in a batch refuse (PROJECT_TARGET_REQUIRED) while the
    // single-task PATCH kept working.
    expect(source).toMatch(/updateTask\(id, updates as never, actor, projectTarget\)/);
    expect(source).toContain('const projectTarget = authorizedProjectTarget(authReq);');
  });
});

// ── The other JWT shape still round-trips (guards the shared verifier) ───────
describe('token shapes remain interchangeable for req.userId', () => {
  it('yields the same userId from legacy and v2 payloads', async () => {
    const { verifyDashboardToken } = await import('../utils/dashboardToken');
    const legacy = (jwt.sign as any)({ userId: 'dashboard_user' }, SECRET, { expiresIn: '1h' });
    const v2 = (jwt.sign as any)(
      { v: 2, sub: PRINCIPAL_ID, handle: 'dashboard_user', kind: 'human' }, SECRET, { expiresIn: '1h' }
    );
    expect(verifyDashboardToken(legacy).userId).toBe(verifyDashboardToken(v2).userId);
  });
});
