/**
 * c3ClaimLeaseLifecycle.test.ts — RH-P3.C3.
 *
 * Cheap, fast pins for the three corrections this candidate makes to the
 * claim/finish/recover lifecycle. The BEHAVIOURAL proof — idempotency of
 * claim/renew/release under retry and under concurrency, the refusals driven
 * through the production task-role reads, and the meltdown recovery end to
 * end — runs against REAL PostgreSQL through the production services in
 * `backend/scripts/test-c3-lease-lifecycle.js`. Runbook `daf703a6` §2 names
 * "mocks-of-the-thing" as a standing rejection class, so nothing here is
 * offered as proof of behaviour; these are structural regressions that
 * survive in CI without a database.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { TaskElementService } from '../services/TaskElementService';

const SRC = join(__dirname, '..');
const taskManagerSource = readFileSync(join(SRC, 'services/TaskManagerDB.ts'), 'utf8');
const elementSource = readFileSync(join(SRC, 'services/TaskElementService.ts'), 'utf8');

/** The body of a declared method, sliced to the next named declaration. */
function methodBody(source: string, decl: string, next: string): string {
  const start = source.indexOf(decl);
  const end = source.indexOf(next, start + decl.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('C3 — the Verifier cannot finish the work it must judge', () => {
  const TASK = '22222222-2222-4222-8222-222222222222';
  const VERIFIER = '33333333-3333-4333-8333-333333333333';
  const REPORT = '44444444-4444-4444-8444-444444444444';

  function poolFor(taskRow: Record<string, unknown>) {
    const statements: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: null, rows: [] };
        if (sql.includes('FROM tasks t') && sql.includes('task_assignments')) {
          return { rowCount: 1, rows: [taskRow] };
        }
        throw new Error(`finish reached storage it should not have: ${sql}`);
      }),
      release: jest.fn(),
    };
    return { pool: { connect: jest.fn(async () => client) } as unknown as Pool, client, statements };
  }

  const row = (roles: Record<string, string | null>) => ({
    id: TASK, title: 'melting', status: 'in-progress', visibility: 'default',
    project_id: null, masking_enabled: false,
    claimant_principal_id: null, shepherd_principal_id: null, verifier_principal_id: null,
    ...roles,
  });

  test('the assigned Verifier is refused, and writes nothing', async () => {
    const fake = poolFor(row({ verifier_principal_id: VERIFIER }));
    const service = new TaskElementService(fake.pool);
    await expect(service.finish(TASK, { reportId: REPORT }, { principalId: VERIFIER, handle: 'v' } as any))
      .rejects.toMatchObject({ status: 403, code: 'CLAIMANT_VERIFIER_CONFLICT' });
    expect(fake.statements).toContain('ROLLBACK');
    expect(fake.statements.some((sql) => sql.includes('UPDATE tasks'))).toBe(false);
  });

  test('a principal holding no Task role is still refused, with its own code', async () => {
    const fake = poolFor(row({ verifier_principal_id: VERIFIER }));
    const service = new TaskElementService(fake.pool);
    await expect(service.finish(TASK, { reportId: REPORT }, { principalId: 'someone-else', handle: 'x' } as any))
      .rejects.toMatchObject({ status: 403, code: 'TASK_ROLE_REQUIRED' });
  });

  test('the claimant is not refused by the Verifier gate', async () => {
    // Positive control: the same gate, the same row shape, the claimant —
    // it must get PAST the role check. It then fails on the next storage
    // read, which this fake deliberately refuses to serve, and that failure
    // is neither of the two refusal codes above.
    const fake = poolFor(row({ claimant_principal_id: VERIFIER, verifier_principal_id: null }));
    const service = new TaskElementService(fake.pool);
    await expect(service.finish(TASK, { reportId: REPORT }, { principalId: VERIFIER, handle: 'c' } as any))
      .rejects.not.toMatchObject({ code: 'CLAIMANT_VERIFIER_CONFLICT' });
    await expect(service.finish(TASK, { reportId: REPORT }, { principalId: VERIFIER, handle: 'c' } as any))
      .rejects.not.toMatchObject({ code: 'TASK_ROLE_REQUIRED' });
  });

  test('the refusal reads the role from the production task_assignments row', () => {
    // Not a fixture and not a second source: `taskContext` joins the 086
    // task-role table the shared predicate reads, and `finish` gates on it.
    expect(elementSource).toContain('JOIN task_assignments a ON a.task_id = t.id');
    const body = methodBody(elementSource, '  async finish(', '  async createReference(');
    expect(body).toContain('this.authorRole(task, actor.principalId)');
    expect(body).toContain('CLAIMANT_VERIFIER_CONFLICT');
    // The refusal reads the FIELD, never authorRole's first match.
    expect(body).toContain('task.verifier_principal_id === actor.principalId');
  });

  test('a principal that is BOTH shepherd and verifier is still refused', async () => {
    // Live QA on DEV caught this: authorRole resolves claimant -> shepherd ->
    // verifier and returns the FIRST hit, so this identity reported
    // "shepherd" and finished the Task it was assigned to judge.
    const fake = poolFor(row({ shepherd_principal_id: VERIFIER, verifier_principal_id: VERIFIER }));
    const service = new TaskElementService(fake.pool);
    await expect(service.finish(TASK, { reportId: REPORT }, { principalId: VERIFIER, handle: 'sv' } as any))
      .rejects.toMatchObject({ status: 403, code: 'CLAIMANT_VERIFIER_CONFLICT' });
    expect(fake.statements.some((sql) => sql.includes('UPDATE tasks'))).toBe(false);
  });

  test('a shepherd who is NOT the verifier still finishes', () => {
    // Positive control for the line above: shepherd authority over the
    // lifecycle is untouched (strategy §2.6.4 gives it force-release,
    // reassign and park) — only the Verifier arm is closed.
    const fake = poolFor(row({ shepherd_principal_id: VERIFIER, verifier_principal_id: null }));
    const service = new TaskElementService(fake.pool);
    return expect(service.finish(TASK, { reportId: REPORT }, { principalId: VERIFIER, handle: 's' } as any))
      .rejects.not.toMatchObject({ code: 'CLAIMANT_VERIFIER_CONFLICT' });
  });
});

describe('C3 — the AZ-S7 vehicle swap has exactly one implementation', () => {
  // Owner ruling AZ-A3: one branch rather than two, so no fix can land on
  // one path and not the other. Meltdown recovery re-assigns just as
  // updateTask does; a second copy of detach/clear/attach is the drift this
  // pin exists to prevent.
  test('the detach-then-attach SWAP exists once, and recovery did not copy it', () => {
    // The estate has other, DIFFERENT vehicle acts — the R2(b) terminal reap
    // and the deletion reap detach WITHOUT attaching, and the R4 reopen
    // attaches without detaching. None of those is the swap. What must not
    // exist twice is the re-assignment sequence: drop the outgoing
    // assignee's access, clear the warrant pointer, attach the incoming
    // one. It lives in the helper, and the recovery calls the helper rather
    // than reproducing it.
    const helper = methodBody(taskManagerSource, '  private async swapExecutionVehicle(', '  async createTask(');
    expect(helper).toContain('accessVehicleService.detach(');
    expect(helper).toContain('SET execution_warrant_id = NULL');
    expect(helper).toContain('this.attachExecutionVehicle(');

    const recover = methodBody(taskManagerSource, '  async recoverTask(', '  /** Dedicated server-owned Task-role');
    expect(recover).not.toContain('accessVehicleService.detach(');
    expect(recover).not.toContain('this.attachExecutionVehicle(');
  });

  test('both re-assigning paths go through the helper', () => {
    const callers = taskManagerSource.split('this.swapExecutionVehicle(').length - 1;
    expect(callers).toBe(2);
    expect(methodBody(taskManagerSource, '  async recoverTask(', '  /** Dedicated server-owned Task-role'))
      .toContain('this.swapExecutionVehicle(');
    expect(methodBody(taskManagerSource, '  async updateTask(', '  async deleteTask('))
      .toContain('this.swapExecutionVehicle(');
  });
});

describe('C3 — meltdown recovery is one operation over the ratified parts', () => {
  const body = () => methodBody(
    taskManagerSource,
    '  async recoverTask(',
    '  /** Dedicated server-owned Task-role',
  );

  test('force-release, lease release, reassign and requeue commit together', () => {
    const recover = body();
    // ONE transaction: every part between a single BEGIN and a single COMMIT.
    expect(recover.split("await client.query('BEGIN')").length - 1).toBe(1);
    expect(recover.split("await client.query('COMMIT')").length - 1).toBe(1);
    expect(recover).toContain("action: 'task.lifecycle_override.force_release'");
    expect(recover).toContain("SET status = 'released'");
    expect(recover).toContain('this.swapExecutionVehicle(');
    expect(recover).toContain("SET status = 'todo'");
    expect(recover).toContain('owner_principal_id = NULL');
    expect(recover).toContain('syncTaskReadiness(');
    expect(recover).toContain("action: 'task.lifecycle_override.recovery'");
  });

  test('the seed is the newest live Report on the ratified two-arm linkage', () => {
    const recover = body();
    // The SAME two arms the task.stuck derivation uses for report activity,
    // so "linked to this Task" means one thing on this board.
    expect(recover).toContain('unnest(r.task_ids)');
    expect(recover).toContain("tr.kind = 'report'");
    expect(recover).toContain('r.deleted_at IS NULL');
    expect(recover).toContain('LIMIT 1');
  });

  test('arming is never touched by a recovery', () => {
    // §2.6.4: arming gates the transition, not just the announcement. A
    // recovery that silently armed work would re-open the premature-pickup
    // incidents arming exists to close.
    expect(body()).not.toContain('auto_start =');
  });

  test('the recovery mints no new dotted event name', () => {
    // Review r1 B1 (verdict 2834c857): `task.recovered` was new vocabulary
    // invented locally in a durable, queryable column. The recovery now
    // rides the transition event migration 086 already defines, and says
    // WHICH kind of transition it is in metadata.
    const recover = body();
    expect(recover).toContain("'task.transitioned'");
    expect(recover).not.toContain("'task.recovered'");
    expect(recover).toContain('recovery: true');
    // The whole tree: the only stream event types are the ones that were
    // already there. A grep is not liveness evidence, but it IS the right
    // shape for a naming census — the question is whether a NAME exists.
    const minted = new Set();
    for (const source of [taskManagerSource, elementSource]) {
      for (const m of source.matchAll(/event_type[,)\s]*[^\n]*'([a-z]+\.[a-z_]+)'/g)) minted.add(m[1]);
    }
    for (const name of minted) {
      expect(['task.transitioned', 'handover.finish', 'handover.note', 'outpost.reported']).toContain(name);
    }
  });

  test('a terminal Task is refused rather than re-vehicled', () => {
    const recover = body();
    expect(recover).toContain("previousStatus === 'completed'");
    expect(recover).toContain("previousStatus === 'archived'");
    expect(recover).toContain("outcome: 'task_terminal'");
  });
});
