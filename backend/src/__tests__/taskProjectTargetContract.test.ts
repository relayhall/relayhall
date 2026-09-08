/**
 * 9c177e6a — the target-Project decision, at the WRITE.
 *
 * The live gate (`taskProjectTargetAuthorization`) measures the BEHAVIOUR over
 * a real PostgreSQL through the production router. This file measures the two
 * things behaviour cannot show from outside:
 *
 *  1. that the decision's RETURN VALUE is what reaches the statement — a gate
 *     that only checks "refused when it should be" is satisfied by a decision
 *     whose answer is thrown away and a `project_id` written from somewhere
 *     else;
 *  2. that OMITTING the decision on the move path refuses rather than
 *     proceeds. `createTask` cannot be called without one (it is a required
 *     parameter and the compiler says so), but `updateTask` carries an
 *     optional one for its dozen internal callers, and "optional" is only
 *     fail-closed if the omission is REFUSED. This is the control for that.
 *
 * The pool is mocked deliberately: the question is which statement runs with
 * which parameters, which is a property of this method and not of SQL.
 */
import fs from 'fs';
import path from 'path';
import { TaskManagerDB } from '../services/TaskManagerDB';

const ACTOR = { principalId: null, handle: 'project-target-contract', role: 'orchestrator' };
const TASK_ID = '11111111-2222-3333-4444-555555555555';
const TARGET_ID = '99999999-8888-7777-6666-555555555555';

/** Every statement the method issued, in order. */
type Recorder = { statements: Array<{ sql: string; params: unknown[] }> };

/**
 * A client that answers the reads a write path makes and TRAPS the statement
 * under test: reaching the INSERT or the UPDATE throws a sentinel carrying its
 * parameters, so "the write ran" and "the write ran with THIS project_id" are
 * the same observation and neither can be faked by a later assertion.
 */
function harness(): { manager: TaskManagerDB; recorder: Recorder } {
  const recorder: Recorder = { statements: [] };
  const client = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      recorder.statements.push({ sql: String(sql), params });
      const text = String(sql).trim();
      if (/^INSERT INTO tasks/i.test(text)) {
        throw new Error(`INSERT_REACHED:${JSON.stringify(params)}`);
      }
      if (/^UPDATE tasks SET/i.test(text)) {
        throw new Error(`UPDATE_REACHED:${JSON.stringify(params)}`);
      }
      if (/^SELECT \* FROM tasks WHERE id = \$1/i.test(text)) {
        return { rows: [{ id: TASK_ID, status: 'todo', priority: 'normal', notes: null, project_id: null }] };
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  const pool = { connect: jest.fn(async () => client) } as any;
  return { manager: new TaskManagerDB(pool), recorder };
}

const wrote = (recorder: Recorder, matcher: RegExp): boolean =>
  recorder.statements.some((statement) => matcher.test(statement.sql.trim()));

const find = (recorder: Recorder, matcher: RegExp): { sql: string; params: unknown[] } => {
  const statement = recorder.statements.find((candidate) => matcher.test(candidate.sql.trim()));
  if (!statement) throw new Error(`no statement matched ${String(matcher)}`);
  return statement;
};

/**
 * The value the statement ACTUALLY binds to `project_id` - read out of the
 * statement, never out of a slot this file counted for itself.
 *
 * Round-2 review finding C3-1 (verdict `07971fae`) is why. The first version
 * asserted `insert.params[4]`, a fixed position derived by counting the
 * columns of the INSERT by eye. The reviewer changed ONE token of the
 * statement - the fifth placeholder from `$5` to `$6` - and the control stayed
 * green while `project_id` was written from the thinking budget. A position
 * this file computes is a second copy of the statement's shape, and a copy
 * cannot notice the shape changing; so the shape is PARSED, and every way the
 * parse could be ambiguous is an error rather than a guess.
 */
function boundToProjectId(sql: string, params: unknown[]): unknown {
  const shape = /INSERT INTO tasks\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(sql);
  if (!shape) throw new Error('the INSERT does not have a column list and a value list');
  const columns = shape[1].split(',').map((column) => column.trim()).filter(Boolean);
  const values = shape[2].split(',').map((value) => value.trim()).filter(Boolean);
  if (columns.length !== values.length) {
    throw new Error(`arity mismatch: ${columns.length} columns, ${values.length} values`);
  }
  const seen = new Set<string>();
  for (const value of values) {
    if (!/^\$\d+$/.test(value)) throw new Error(`the value list carries a non-placeholder: ${value}`);
    if (seen.has(value)) throw new Error(`placeholder ${value} is bound to two columns`);
    seen.add(value);
  }
  const at = columns.indexOf('project_id');
  if (at < 0) throw new Error('the INSERT names no project_id column');
  return params[Number(values[at].slice(1)) - 1];
}

/** The same question of an UPDATE's SET list, for the same reason. */
function updatedProjectId(sql: string, params: unknown[]): unknown {
  const shape = /UPDATE tasks SET ([\s\S]*?)\s+WHERE\b/i.exec(sql);
  if (!shape) throw new Error('the UPDATE does not have a SET list and a WHERE');
  const assignments = shape[1].split(',').map((clause) => clause.trim()).filter(Boolean);
  const matches = assignments.filter((clause) => /^project_id\s*=/.test(clause));
  if (matches.length !== 1) throw new Error(`the SET list assigns project_id ${matches.length} times`);
  const placeholder = /^project_id\s*=\s*(\$\d+)$/.exec(matches[0]);
  if (!placeholder) throw new Error(`project_id is not assigned from a placeholder: ${matches[0]}`);
  return params[Number(placeholder[1].slice(1)) - 1];
}

describe('the create path writes the project_id the decision returned', () => {
  it('the resolved id reaches the INSERT', async () => {
    const { manager, recorder } = harness();
    await expect(
      manager.createTask({ title: 'x', project: 'any-spelling' } as any, ACTOR as any, async () => TARGET_ID),
    ).rejects.toThrow(/^INSERT_REACHED:/);
    const insert = find(recorder, /^INSERT INTO tasks/i);
    expect(`project_id written: ${String(boundToProjectId(insert.sql, insert.params))}`)
      .toBe(`project_id written: ${TARGET_ID}`);
  });

  it('a refused target never reaches the INSERT', async () => {
    const { manager, recorder } = harness();
    await expect(
      manager.createTask({ title: 'x', project: 'any-spelling' } as any, ACTOR as any, async () => null),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', status: 404 });
    expect(`INSERT reached: ${wrote(recorder, /^INSERT INTO tasks/i)}`).toBe('INSERT reached: false');
    expect(`rolled back: ${wrote(recorder, /^ROLLBACK/i)}`).toBe('rolled back: true');
  });

  it('naming no Project never consults the decision at all', async () => {
    const { manager, recorder } = harness();
    const target = jest.fn(async () => TARGET_ID);
    await expect(manager.createTask({ title: 'x' } as any, ACTOR as any, target))
      .rejects.toThrow(/^INSERT_REACHED:/);
    expect(`decision consulted: ${target.mock.calls.length}`).toBe('decision consulted: 0');
    const insert = find(recorder, /^INSERT INTO tasks/i);
    expect(`project_id written: ${String(boundToProjectId(insert.sql, insert.params))}`)
      .toBe('project_id written: null');
  });
});

describe('the move path refuses without a decision — the fail-closed direction', () => {
  it('omitting the decision refuses the move and writes nothing', async () => {
    const { manager, recorder } = harness();
    await expect(manager.updateTask(TASK_ID, { project: 'any-spelling' } as any, ACTOR as any))
      .rejects.toMatchObject({ code: 'PROJECT_TARGET_REQUIRED', status: 403 });
    expect(`UPDATE reached: ${wrote(recorder, /^UPDATE tasks SET/i)}`).toBe('UPDATE reached: false');
  });

  it('a refused target refuses the move with the concealed answer', async () => {
    const { manager, recorder } = harness();
    await expect(manager.updateTask(TASK_ID, { project: 'any-spelling' } as any, ACTOR as any, async () => null))
      .rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', status: 404 });
    expect(`UPDATE reached: ${wrote(recorder, /^UPDATE tasks SET/i)}`).toBe('UPDATE reached: false');
  });

  it('a resolved target is the value the UPDATE carries', async () => {
    const { manager, recorder } = harness();
    await expect(manager.updateTask(TASK_ID, { project: 'any-spelling' } as any, ACTOR as any, async () => TARGET_ID))
      .rejects.toThrow(/^UPDATE_REACHED:/);
    const update = find(recorder, /^UPDATE tasks SET/i);
    // Not `params.includes(TARGET_ID)`: the value being SOMEWHERE in the
    // parameter list is satisfied by a statement that binds it to any other
    // column. The SET list says which one, so the SET list is what is read.
    expect(`project_id in the update: ${String(updatedProjectId(update.sql, update.params))}`)
      .toBe(`project_id in the update: ${TARGET_ID}`);
  });

  it('CLEARING the Project decides nothing and is not refused', async () => {
    // Removing a perimeter is not crossing one: an unphased, unprojected Task
    // inherits nothing (117). A rule that refused this would make the
    // fail-closed direction unusable and invite a caller to route around it.
    const { manager } = harness();
    const target = jest.fn(async () => TARGET_ID);
    await expect(manager.updateTask(TASK_ID, { project: null } as any, ACTOR as any, target))
      .rejects.toThrow(/^UPDATE_REACHED:/);
    expect(`decision consulted: ${target.mock.calls.length}`).toBe('decision consulted: 0');
  });
});

describe('the oracle reads the statement, and refuses when it cannot', () => {
  // Round-2 finding C3-1 asked for a derivation instead of a fixed slot. A
  // derivation is only worth having if it REFUSES the shapes a fixed slot
  // silently accepted, so each of those shapes is drilled here against the
  // parser itself - including the reviewer's own one-token mutation, verbatim.
  const COLUMNS = 'INSERT INTO tasks (\n title, description, status, priority, project_id, thinking_budget\n) VALUES (\n';
  const params = ['t', 'd', 'todo', 'normal', TARGET_ID, 'low'];

  it('reads the value the statement binds, not the slot the column sits at', () => {
    const sql = `${COLUMNS}$1, $2, $3, $4, $5, $6\n) RETURNING *`;
    expect(boundToProjectId(sql, params)).toBe(TARGET_ID);
    // The SAME parameter array, with the placeholders permuted: a fixed-index
    // oracle cannot tell these two statements apart, and this one must.
    const permuted = `${COLUMNS}$1, $2, $3, $4, $6, $5\n) RETURNING *`;
    expect(boundToProjectId(permuted, params)).toBe('low');
  });

  it("refuses the reviewer's mutation: one placeholder bound to two columns", () => {
    const sql = `${COLUMNS}$1, $2, $3, $4, $6, $6\n) RETURNING *`;
    expect(() => boundToProjectId(sql, params)).toThrow(/bound to two columns/);
  });

  it('refuses an arity mismatch, a non-placeholder, and a missing column', () => {
    expect(() => boundToProjectId(`${COLUMNS}$1, $2, $3, $4, $5\n) RETURNING *`, params))
      .toThrow(/arity mismatch/);
    expect(() => boundToProjectId(`${COLUMNS}$1, $2, $3, $4, NULL, $6\n) RETURNING *`, params))
      .toThrow(/non-placeholder/);
    expect(() => boundToProjectId(
      'INSERT INTO tasks (title, status) VALUES ($1, $2) RETURNING *', ['t', 'todo']))
      .toThrow(/names no project_id/);
  });

  it('the UPDATE oracle refuses the same evasions', () => {
    const updateParams = [TARGET_ID, 'high', 'id-1'];
    expect(updatedProjectId('UPDATE tasks SET project_id = $1, priority = $2 WHERE id = $3', updateParams))
      .toBe(TARGET_ID);
    expect(updatedProjectId('UPDATE tasks SET priority = $2, project_id = $1 WHERE id = $3', updateParams))
      .toBe(TARGET_ID);
    expect(() => updatedProjectId('UPDATE tasks SET priority = $2 WHERE id = $3', updateParams))
      .toThrow(/assigns project_id 0 times/);
    expect(() => updatedProjectId('UPDATE tasks SET project_id = NOW() WHERE id = $3', updateParams))
      .toThrow(/not assigned from a placeholder/);
  });
});

describe('no write path can reach the unauthorized resolver again', () => {
  const src = (file: string): string =>
    fs.readFileSync(path.join(process.cwd(), 'src', file), 'utf8');

  it('resolveProjectId survives ONLY on the two read filters', () => {
    // It is the helper the defect was written with: name-or-id in,
    // `project_id` out, no authorization anywhere. It still serves the LIST
    // filters, where the rows it selects are narrowed by the shared predicate
    // downstream. A third call site is how the defect comes back, and this is
    // the assertion that notices.
    const lines = src('services/TaskManagerDB.ts')
      .split('\n')
      .filter((line) => line.includes('this.resolveProjectId('));
    expect(`call sites: ${lines.length}`).toBe('call sites: 2');
    expect(`all of them are list filters: ${lines.every((line) => line.includes('filters.'))}`)
      .toBe('all of them are list filters: true');
  });

  it('both Task write routes build the decision from the request', () => {
    expect(src('routes/tasks.ts')).toContain('authorizedProjectTarget(req as AuthRequest)');
    // Twice: the create and the generic PATCH, which is also a move surface.
    expect(`tasks.ts call sites: ${src('routes/tasks.ts').split('authorizedProjectTarget(req as AuthRequest)').length - 1}`)
      .toBe('tasks.ts call sites: 2');
    expect(src('routes/tasksBatch.ts')).toContain('authorizedProjectTarget(authReq)');
  });
});
