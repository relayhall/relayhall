import fs from 'fs';
import path from 'path';
import { allSubtaskStatusesDone, TaskManagerDB } from '../services/TaskManagerDB';
import { pool } from '../db/connection';

jest.mock('../db/connection', () => {
  // RH-P3.C1: subtask writes ride a transaction client now. The shim
  // delegates real queries to pool.query (so existing expectations still
  // see them) and absorbs the transaction/feed-emission statements.
  const pool: any = { query: jest.fn() };
  pool.connect = jest.fn(async () => ({
    query: (...args: any[]) => {
      const sql = String(args[0]);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK'
        || sql.includes('pg_advisory_xact_lock') || sql.startsWith('INSERT INTO feed_events')) {
        return Promise.resolve({ rows: [] });
      }
      return pool.query(...args);
    },
    release: jest.fn(),
  }));
  return { pool };
});

const read = (file: string): string => fs.readFileSync(path.join(__dirname, '..', '..', '..', file), 'utf8');

describe('explicit independent-review workflow contract', () => {
  test('completion requires every subtask to be completed or skipped', () => {
    expect(allSubtaskStatusesDone([])).toBe(true);
    expect(allSubtaskStatusesDone(['completed', 'skipped'])).toBe(true);
    for (const state of ['empty', 'in-progress', 'review', 'stuck', 'in_progress', 'blocked']) {
      expect(allSubtaskStatusesDone(['completed', state])).toBe(false);
    }
  });

  test('CLI and MCP publish review-aware task and subtask transitions', () => {
    const cli = read('cli/relayhall');
    // RH-P3.C4: the MCP surface moved in-process; the out-of-process Python
    // adapter is retired and THE registry is where the verbs are declared.
    const mcp = read('backend/src/mcp/registry.ts');
    expect(cli).toContain('relayhall move TASK_ID review');
    expect(cli).toContain('stuck-subtask');
    expect(cli).toContain('# Subtask workflow (six states:');
    expect(cli).toContain('Independent Verifier approves review → completed');
    expect(cli).toContain('move abc123 review --notes "Ready for independent review"');
    expect(cli).not.toContain('# Subtask workflow (tri-state)');
    expect(cli).not.toContain('move abc123 stuck --notes "Ready"');
    expect(cli).not.toContain('\n  relayhall help\n');
    expect(mcp).toContain('relayhall_task_move');
    expect(mcp).toContain('relayhall_subtask_set');
    expect(mcp).toContain("'review', 'completed', 'stuck', 'skipped'");
  });

  test('migration canonicalizes legacy blocked subtasks as stuck', () => {
    const migration = read('backend/src/migrations/066_explicit_review_workflow.sql');
    expect(migration).toContain("SET status = 'stuck'");
    expect(migration).toContain("status IN ('empty', 'in_progress', 'review', 'completed', 'stuck', 'skipped')");
  });

  test('migration 068 unifies the stored subtask vocabulary on kebab-case', () => {
    const migration = read('backend/src/migrations/068_kebab_case_subtask_states.sql');
    expect(migration).toContain("SET status = 'in-progress'");
    expect(migration).toContain("WHERE status = 'in_progress'");
    expect(migration).toContain("status IN ('empty', 'in-progress', 'review', 'completed', 'stuck', 'skipped')");
  });

  test('migration 068 lands the A11 per-object subsets with the declared mapping', () => {
    const migration = read('backend/src/migrations/068_kebab_case_subtask_states.sql');
    // A11.1: paused stays visible, completed is filed.
    expect(migration).toContain("SET status = 'active', updated_at = COALESCE(updated_at, NOW())\nWHERE status = 'paused'");
    expect(migration).toContain("SET status = 'archived', updated_at = COALESCE(updated_at, NOW())\nWHERE status = 'completed'");
    expect(migration).toContain("CHECK (status IN ('active', 'archived'))");
    // A11.2: the status column, not the deleted_at tombstone, carries archived.
    expect(migration).toContain("ALTER TABLE reports ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active'");
  });
});


describe('central Verifier-owned subtask enforcement', () => {
  const task = (status: any) => ({
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Lifecycle proof',
    status: 'review',
    priority: 'normal',
    created: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    subtasks: [{ id: 's1', title: 'slice', status, completed: status === 'completed' }],
  } as any);

  beforeEach(() => jest.clearAllMocks());

  test('creation cannot pre-complete subtasks or bypass the parent invariant', async () => {
    const manager = new TaskManagerDB();
    await expect(manager.createTask({
      title: 'bypass',
      status: 'todo',
      subtasks: [{ id: 's1', text: 'slice', status: 'completed', completed: true }],
    }, { principalId: null, handle: 'dashboard_operator', role: 'orchestrator' }, async () => null))
      .rejects.toThrow('Only an independent Verifier identity can create a completed subtask');
    await expect(manager.createTask({
      title: 'unfinished parent',
      status: 'completed',
      subtasks: [{ id: 's1', text: 'slice', status: 'review', completed: false }],
    }, { principalId: null, handle: 'human_reviewer', role: 'reviewer' }, async () => null))
      .rejects.toThrow('only when every subtask is completed or skipped');
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test.each(['agent', 'orchestrator'] as const)(
    '%s cannot complete through the central manager',
    async (role) => {
      const manager = new TaskManagerDB();
      jest.spyOn(manager, 'getTask').mockResolvedValue(task('review'));
      await expect(manager.updateSubtaskStatus(task('review').id, 0, 'completed', role))
        .rejects.toThrow('Only an independent Verifier identity');
      expect(pool.query).not.toHaveBeenCalled();
    },
  );

  test.each(['qa', 'reviewer'] as const)(
    '%s can approve a reviewed subtask',
    async (role) => {
      const manager = new TaskManagerDB();
      jest.spyOn(manager, 'getTask')
        .mockResolvedValueOnce(task('review'))
        .mockResolvedValueOnce(task('completed'));
      (pool.query as jest.Mock).mockResolvedValue({ rows: [] });
      const updated = await manager.updateSubtaskStatus(task('review').id, 0, 'completed', role);
      expect(updated.subtasks?.[0].status).toBe('completed');
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE subtasks'),
        expect.arrayContaining(['completed']),
      );
    },
  );

  test.each(['empty', 'in-progress', 'stuck', 'skipped'] as const)(
    'a Verifier cannot complete a subtask directly from %s',
    async (status) => {
      const manager = new TaskManagerDB();
      jest.spyOn(manager, 'getTask').mockResolvedValue(task(status));
      await expect(manager.updateSubtaskStatus(task(status).id, 0, 'completed', 'reviewer'))
        .rejects.toThrow(`A subtask can only be completed from review (current status: ${status})`);
      expect(pool.query).not.toHaveBeenCalled();
    },
  );

  test('an implementation agent may report stuck but cannot resume it', async () => {
    const manager = new TaskManagerDB();
    jest.spyOn(manager, 'getTask')
      .mockResolvedValueOnce(task('in-progress'))
      .mockResolvedValueOnce(task('stuck'));
    (pool.query as jest.Mock).mockResolvedValue({ rows: [] });
    const stuck = await manager.updateSubtaskStatus(task('review').id, 0, 'stuck', 'agent', undefined, 'needs owner input');
    expect(stuck.subtasks?.[0].status).toBe('stuck');

    jest.restoreAllMocks();
    const second = new TaskManagerDB();
    jest.spyOn(second, 'getTask').mockResolvedValue(task('stuck'));
    await expect(second.updateSubtaskStatus(task('review').id, 0, 'in-progress', 'agent'))
      .rejects.toThrow('Cannot resume a stuck subtask');
  });

  test('an orchestrator may mark an intentionally omitted subtask skipped', async () => {
    const manager = new TaskManagerDB();
    jest.spyOn(manager, 'getTask')
      .mockResolvedValueOnce(task('empty'))
      .mockResolvedValueOnce(task('skipped'));
    (pool.query as jest.Mock).mockResolvedValue({ rows: [] });
    const updated = await manager.updateSubtaskStatus(task('review').id, 0, 'skipped', 'orchestrator');
    expect(updated.subtasks?.[0].status).toBe('skipped');
  });
});


describe('reviewer route authority', () => {
  const tasksRoute = read('backend/src/routes/tasks.ts');
  test.each(["router.post('/reviewer/:id/run'", "router.post('/reviewer/:id/reject'"])(
    '%s requires an independent Verifier identity',
    (routeMarker) => {
      const start = tasksRoute.indexOf(routeMarker);
      expect(start).toBeGreaterThan(-1);
      const handler = tasksRoute.slice(start, start + 900);
      expect(handler).toContain('rejectNonReviewerAction');
      expect(handler).not.toContain('rejectImplementationAgentOrchestratorAction');
    },
  );
});
