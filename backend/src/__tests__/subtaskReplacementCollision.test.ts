/**
 * subtaskReplacementCollision.test.ts — card 36071c86: PATCH /tasks/:id with a
 * replacement subtasks array 500s on UNIQUE(task_id,index).
 *
 * The defect lives in SQL interplay — the vacate offset versus the incoming
 * index range — which the mocked-pool test style cannot see with inert mocks.
 * So the pool here is a targeted fake that EXECUTES the update path's own
 * statements against an in-memory subtasks table and ENFORCES the real
 * uniqueness rule: any INSERT or per-row UPDATE that lands on an occupied
 * (task_id, index) throws the exact 23505 the live database threw. Run
 * against the unrepaired vacate (offset = MAX(index)+1 only), the four-element
 * replacement over three existing rows fails exactly like DEV did; with the
 * repaired GREATEST offset it must succeed. The fake resolves the vacate
 * offset by evaluating the statement's own subquery semantics over the fake
 * table — it does not hard-code either offset.
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

const TASK_ID = '11111111-1111-4111-8111-111111111111';

type Row = { id: number; task_id: string; index: number; title: string; status: string; note: string | null; completed_at: string | null };

class FakeDb {
  subtasks: Row[] = [];
  private nextId = 1;
  taskRow: Record<string, unknown>;

  constructor(initialTitles: string[]) {
    for (const title of initialTitles) this.insert(TASK_ID, this.subtasks.length, title, 'empty', null, null);
    this.taskRow = {
      id: TASK_ID, title: 'Fixture task', description: '', status: 'todo', priority: 'normal',
      project_id: null, phase_id: null, notes: null, auto_start: false, blocked_reason: null,
      status_reason: null, active_agent: null, completed_by: null, attempt_count: 0,
      session_refs: '[]', parent_id: null, personality_id: null,
      created_at: '2026-08-21T00:00:00Z', updated_at: '2026-08-21T00:00:00Z',
      started_at: null, completed_at: null, archived_at: null, archive_disposition: null,
    };
  }

  /** The real constraint, enforced the way the database enforces it. */
  private assertFree(taskId: string, index: number, exceptRowId?: number) {
    if (this.subtasks.some(r => r.task_id === taskId && r.index === index && r.id !== exceptRowId)) {
      const err = new Error('duplicate key value violates unique constraint "subtasks_task_id_index_key"') as Error & { code: string };
      err.code = '23505';
      throw err;
    }
  }

  insert(taskId: string, index: number, title: string, status: string, note: string | null, completedAt: string | null): Row {
    this.assertFree(taskId, index);
    const row: Row = { id: this.nextId++, task_id: taskId, index, title, status, note, completed_at: completedAt };
    this.subtasks.push(row);
    return row;
  }

  query(text: string, params: unknown[] = []): { rows: unknown[] } {
    const sql = text.replace(/\s+/g, ' ').trim();

    if (/^(BEGIN|COMMIT|ROLLBACK|SET CONSTRAINTS)/i.test(sql)) return { rows: [] };
    // The point read appends `DUE_AT_ISO_RETURNING` (the FEAT-A projection), so
    // the match admits the extra projections rather than the bare `*` alone. A row
    // carrying `due_at` without `due_at_iso` still throws in `readRowDueAt`, which
    // is the fail-closed behaviour this double must not paper over.
    if (/^SELECT \*(?:,[\s\S]*?)? FROM tasks WHERE id = \$1/i.test(sql)) return { rows: [this.taskRow] };
    if (/^SELECT t\.\*, at\.slug AS at_slug/i.test(sql)) {
      return { rows: [{ ...this.taskRow, at_slug: null, at_name: null, at_color: null, at_category: null }] };
    }
    if (/^UPDATE tasks SET /i.test(sql)) return { rows: [] };
    if (/^SELECT id, task_id, index, title, status, note, completed_at, created_at, updated_at, blueprint_key, blueprint_version, blueprint_content_sha256, blueprint_identity_sha256, instantiation_id FROM subtasks/i.test(sql)) {
      // Serves the per-row shape and the batched `= ANY` shape alike (the
      // 6a351638 batched hydration changed the read side of this path).
      const wanted = Array.isArray(params[0]) ? new Set(params[0] as string[]) : new Set([params[0] as string]);
      return {
        rows: [...this.subtasks]
          .filter(r => wanted.has(r.task_id))
          .sort((a, b) => a.task_id.localeCompare(b.task_id) || a.index - b.index)
          .map(r => ({ ...r, created_at: '', updated_at: '', blueprint_key: null, blueprint_version: null,
            blueprint_content_sha256: null, blueprint_identity_sha256: null, instantiation_id: null })),
      };
    }
    if (/^SELECT index, status FROM subtasks WHERE task_id = \$1$/i.test(sql)) {
      return { rows: this.subtasks.map(r => ({ index: r.index, status: r.status })) };
    }
    if (/^SELECT status FROM subtasks WHERE task_id = \$1$/i.test(sql)) {
      return { rows: this.subtasks.map(r => ({ status: r.status })) };
    }
    if (/^SELECT id FROM subtasks WHERE task_id = \$1 FOR UPDATE$/i.test(sql)) {
      return { rows: this.subtasks.map(r => ({ id: r.id })) };
    }
    if (/^UPDATE subtasks SET index = index \+/i.test(sql)) {
      // Evaluate the statement's own arithmetic over the fake table: the
      // MAX(index)+1 subquery, wrapped in GREATEST($2) when the repaired SQL
      // says so. Nothing about either offset is hard-coded here.
      const maxPlusOne = this.subtasks.reduce((m, r) => Math.max(m, r.index), -1) + 1;
      const offset = /GREATEST/i.test(sql) ? Math.max(maxPlusOne, Number(params[1])) : maxPlusOne;
      // Single-statement shift: transiently safe only if every new position is
      // outside the old range — which the database also relies on. Verify,
      // then apply, then re-check global uniqueness like the constraint would.
      for (const r of this.subtasks) r.index += offset;
      const seen = new Set<string>();
      for (const r of this.subtasks) {
        const key = `${r.task_id}:${r.index}`;
        if (seen.has(key)) { const e = new Error('duplicate key value violates unique constraint "subtasks_task_id_index_key"') as Error & { code: string }; e.code = '23505'; throw e; }
        seen.add(key);
      }
      return { rows: [] };
    }
    if (/^UPDATE subtasks SET index = \$3, title = \$4, status = \$5, note = \$6, completed_at = \$7 WHERE task_id = \$1 AND id = \$2$/i.test(sql)) {
      const [taskId, rowId, index, title, status, note, completedAt] = params as [string, string, number, string, string, string | null, string | null];
      const row = this.subtasks.find(r => r.task_id === taskId && String(r.id) === String(rowId));
      if (!row) return { rows: [] };
      this.assertFree(taskId, Number(index), row.id);
      Object.assign(row, { index: Number(index), title, status, note, completed_at: completedAt });
      return { rows: [] };
    }
    if (/^INSERT INTO subtasks \(task_id, index, title, status, note, completed_at\)/i.test(sql)) {
      const [taskId, index, title, status, note, completedAt] = params as [string, number, string, string, string | null, string | null];
      const row = this.insert(taskId, Number(index), title, status, note, completedAt);
      return { rows: [{ id: row.id }] };
    }
    if (/^DELETE FROM subtasks WHERE task_id = \$1 AND id = ANY\(\$2::int\[\]\)$/i.test(sql)) {
      const [taskId, ids] = params as [string, Array<string | number>];
      const remove = new Set(ids.map(String));
      this.subtasks = this.subtasks.filter(r => !(r.task_id === taskId && remove.has(String(r.id))));
      return { rows: [] };
    }
    if (/FROM task_tags/i.test(sql)
      || /FROM task_dependencies/i.test(sql)
      || /FROM task_links/i.test(sql)) return { rows: [] };
    if (/FROM projects WHERE id/i.test(sql)) return { rows: [] };
    // RH-P3.C1 feed emission rides the update transaction.
    if (/pg_advisory_xact_lock/i.test(sql)) return { rows: [] };
    if (/INSERT INTO feed_events/i.test(sql)) return { rows: [] };

    throw new Error(`FakeDb: unhandled statement in the subtasks update path: ${sql.slice(0, 120)}`);
  }

  pool() {
    const self = this;
    const client = {
      query: async (text: string, params?: unknown[]) => self.query(text, params),
      release: () => undefined,
    };
    return {
      connect: async () => client,
      query: async (text: string, params?: unknown[]) => self.query(text, params),
    } as never;
  }
}

const replacement = (titles: string[]) => titles.map(text => ({ text } as never));

describe('subtasks replacement vs UNIQUE(task_id,index) — card 36071c86', () => {
  test('THE LIVE 500: a replacement array LONGER than the existing set must not collide', async () => {
    const db = new FakeDb(['a', 'b', 'c']);
    const manager = new TaskManagerDB(db.pool());
    const task = await manager.updateTask(TASK_ID, { subtasks: replacement(['w', 'x', 'y', 'z']) } as never);
    expect(task.subtasks.map(s => s.text)).toEqual(['w', 'x', 'y', 'z']);
    expect(db.subtasks.map(r => r.index).sort((p, q) => p - q)).toEqual([0, 1, 2, 3]);
  });

  test('control: same-length replacement (never collided, must keep working)', async () => {
    const db = new FakeDb(['a', 'b', 'c']);
    const manager = new TaskManagerDB(db.pool());
    const task = await manager.updateTask(TASK_ID, { subtasks: replacement(['x', 'y', 'z']) } as never);
    expect(task.subtasks.map(s => s.text)).toEqual(['x', 'y', 'z']);
  });

  test('control: shrink replacement deletes the tail rows', async () => {
    const db = new FakeDb(['a', 'b', 'c']);
    const manager = new TaskManagerDB(db.pool());
    const task = await manager.updateTask(TASK_ID, { subtasks: replacement(['only', 'two']) } as never);
    expect(task.subtasks.map(s => s.text)).toEqual(['only', 'two']);
    expect(db.subtasks).toHaveLength(2);
  });

  test('control: stable-id reorder still swaps cleanly (the vacate step’s original job)', async () => {
    const db = new FakeDb(['first', 'second', 'third']);
    const [r0, r1, r2] = [...db.subtasks];
    const manager = new TaskManagerDB(db.pool());
    const task = await manager.updateTask(TASK_ID, {
      subtasks: [
        { id: r2.id, text: 'third' }, { id: r1.id, text: 'second' }, { id: r0.id, text: 'first' },
      ] as never,
    } as never);
    expect(task.subtasks.map(s => s.text)).toEqual(['third', 'second', 'first']);
    expect(db.subtasks.find(r => r.id === r2.id)?.index).toBe(0);
    expect(db.subtasks.find(r => r.id === r0.id)?.index).toBe(2);
  });

  test('control: growth by MORE than double (parked range far below the incoming range)', async () => {
    const db = new FakeDb(['a']);
    const manager = new TaskManagerDB(db.pool());
    const task = await manager.updateTask(TASK_ID, { subtasks: replacement(['1', '2', '3', '4', '5']) } as never);
    expect(task.subtasks).toHaveLength(5);
    expect(db.subtasks.map(r => r.index).sort((p, q) => p - q)).toEqual([0, 1, 2, 3, 4]);
  });
});
