/**
 * c2TaskReadiness.test.ts — RH-P3.C2: `task.ready` derivation.
 *
 * ── What this suite can and cannot prove ──
 *
 * After the pre-review repairs, the readiness PREDICATE lives in SQL
 * (`READY_PREDICATE_SQL`), because the fan-out has to evaluate a whole
 * dependent set in one locked statement. SQL semantics cannot be verified by
 * mocking a pool — so this suite proves the things that ARE verifiable here:
 * that one predicate is shared by every path, that the announcement is
 * claimed atomically, that retraction happens, and that every writer which
 * crosses the readiness boundary actually calls the sync.
 *
 * The predicate's SEMANTICS — the truth table over ASSIGNMENT × status ×
 * arming × dependency state, and its equivalence with the claim gate — are
 * verified against real Postgres by `qa/c2-readiness-matrix.sql` and
 * `qa/c2-live-probe.mjs`, which walk the matrix on DEV. That split is
 * deliberate and stated rather than papered over: the estate's jest suites all
 * mock the pool, and a source-grep "parity test" (which is what the pre-review
 * correctly called vacuous) proves nothing — adding a FOURTH clause to one
 * side leaves every `toContain` assertion green.
 *
 * ── The assignment clause (ruling ccd53781 R2; review r2, B7) ──
 *
 * Ratified §2.6.4: `task.ready` "fires when a task is ASSIGNED, in todo,
 * armed, and dependency-satisfied". The first cut omitted the assignment
 * clause entirely, so an armed unassigned task announced a go signal to every
 * broadly-granted subscriber. The field of record is
 * `tasks.execution_service_id` (owner decision D6, run packet c17ebfff).
 * Assigned-vs-unassigned controls live in the real-Postgres matrix; what is
 * provable here is that the clause is IN the one shared predicate, that it
 * fails closed, and that the assignment write path re-evaluates readiness.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  syncTaskReadiness, syncDependentsReadiness,
  DEPENDENCY_SATISFIED_SQL, READY_PREDICATE_SQL,
} from '../utils/taskReadiness';

const emitted: Array<Record<string, unknown>> = [];
jest.mock('../services/FeedEventService', () => ({
  feedEventService: {
    emit: jest.fn(async (_client: unknown, event: Record<string, unknown>) => { emitted.push(event); }),
  },
}));

const TASK = '22222222-2222-4222-8222-222222222222';
const DEP_A = '33333333-3333-4333-8333-333333333333';
const DEP_B = '44444444-4444-4444-8444-444444444444';

function client(responses: Array<{ rows: any[] }>) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    return responses.shift() ?? { rows: [] };
  });
  return { client: { query } as any, calls, query };
}

const READY_ROW = { ready: true, project_id: null, owner_principal_id: null };
const NOT_READY_ROW = { ready: false, project_id: null, owner_principal_id: null };

beforeEach(() => { emitted.length = 0; });

describe('C2 readiness: one predicate, used everywhere', () => {
  /**
   * If the single-task and set-based paths ever grow separate predicates, the
   * board announces one thing and the claim path accepts another.
   */
  test('the single-task evaluation and the fan-out use the SAME predicate constant', () => {
    const source = readFileSync(join(__dirname, '..', 'utils', 'taskReadiness.ts'), 'utf8');
    // Exactly one definition, and every query interpolates it rather than
    // restating the conditions.
    expect(source.match(/export const READY_PREDICATE_SQL/g)).toHaveLength(1);
    expect(source.match(/\$\{READY_PREDICATE_SQL\}/g)).toHaveLength(2);
    // The arming and status clauses appear ONLY inside that constant.
    expect(source.match(/t\.auto_start = TRUE/g)).toHaveLength(1);
    expect(source.match(/t\.status = 'todo'/g)).toHaveLength(1);
  });

  test('the predicate composes the dependency-satisfaction fragment rather than restating it', () => {
    expect(READY_PREDICATE_SQL).toContain(DEPENDENCY_SATISFIED_SQL);
    expect(READY_PREDICATE_SQL).toContain("t.status = 'todo'");
    expect(READY_PREDICATE_SQL).toContain('t.auto_start = TRUE');
  });

  /**
   * Pre-review F4: a read-then-claim under READ COMMITTED lets a concurrent
   * disarm slip between the two, announcing a task that is no longer ready
   * AND leaving a row that swallows the next genuine announcement.
   */
  test('evaluation takes a row lock, so the claim agrees with what was evaluated', async () => {
    const { client: c, calls } = client([{ rows: [READY_ROW] }, { rows: [{ task_id: TASK }] }]);
    await syncTaskReadiness(c, TASK);
    expect(calls[0].sql).toContain('FOR UPDATE OF t');
  });

  test('the fan-out locks the whole dependent set in one statement', async () => {
    const { client: c, calls } = client([
      { rows: [{ task_id: DEP_A }, { task_id: DEP_B }] },
      { rows: [{ id: DEP_A, project_id: null, owner_principal_id: null }] },
      { rows: [] },
      { rows: [{ task_id: DEP_A }] },
    ]);
    await syncDependentsReadiness(c, TASK);
    const evaluation = calls[1];
    expect(evaluation.sql).toContain('FOR UPDATE OF t');
    expect(evaluation.sql).toContain('t.id = ANY($1::uuid[])');
    // Set-based, not one round trip per dependent: the feed's advisory lock
    // is transaction-scoped and serializes emission deployment-wide, so the
    // window between the first emission and COMMIT is a global cost.
    expect(evaluation.params[0]).toEqual([DEP_A, DEP_B]);
  });
});

describe('C2 readiness announcement', () => {
  test('emits task.ready once, and only when the announcement row is actually claimed', async () => {
    const { client: c, calls } = client([{ rows: [READY_ROW] }, { rows: [{ task_id: TASK }] }]);
    expect(await syncTaskReadiness(c, TASK, { principalId: 'p1', handle: 'h' })).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ name: 'task.ready', objectType: 'task', objectId: TASK, payload: {} });

    const claim = calls.find((call) => call.sql.includes('INSERT INTO task_readiness'));
    // Keyed by (task, ASSIGNEE) since pre-review P1: a conditional upsert,
    // not DO NOTHING, so a reassignment re-announces while an unchanged
    // assignee stays quiet.
    expect(claim!.sql).toContain('ON CONFLICT (task_id) DO UPDATE');
    expect(claim!.sql).toContain('RETURNING task_id');
  });

  test('does NOT emit when the announcement was already claimed by another transaction', async () => {
    const { client: c } = client([{ rows: [READY_ROW] }, { rows: [] }]);
    expect(await syncTaskReadiness(c, TASK)).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  test('leaving the ready state retracts the announcement and emits nothing', async () => {
    const { client: c, calls } = client([{ rows: [NOT_READY_ROW] }]);
    expect(await syncTaskReadiness(c, TASK)).toBe(false);
    expect(emitted).toHaveLength(0);
    expect(calls.some((call) => call.sql.includes('DELETE FROM task_readiness'))).toBe(true);
  });

  test('a missing task announces nothing and retracts nothing', async () => {
    const { client: c, calls } = client([{ rows: [] }]);
    expect(await syncTaskReadiness(c, TASK)).toBe(false);
    expect(calls.some((call) => call.sql.includes('DELETE FROM task_readiness'))).toBe(false);
  });

  test('the announcement carries no content — identity and ownership metadata only', async () => {
    const { client: c } = client([
      { rows: [{ ready: true, project_id: 'proj-1', owner_principal_id: 'own-1' }] },
      { rows: [{ task_id: TASK }] },
    ]);
    await syncTaskReadiness(c, TASK);
    expect(Object.keys(emitted[0]).sort()).toEqual([
      'actorHandle', 'actorPrincipalId', 'name', 'objectId', 'objectType',
      'ownerPrincipalId', 'payload', 'projectId',
    ]);
    expect(emitted[0].payload).toEqual({});
  });
});

describe('C2 dependents fan-out', () => {
  test('announces only the dependents that are ready AND newly claimed', async () => {
    const { client: c } = client([
      { rows: [{ task_id: DEP_A }, { task_id: DEP_B }] },
      { rows: [
        { id: DEP_A, project_id: null, owner_principal_id: null },
        { id: DEP_B, project_id: null, owner_principal_id: null },
      ] },
      { rows: [] },
      // DEP_B was already announced: ON CONFLICT DO NOTHING returns only A.
      { rows: [{ task_id: DEP_A }] },
    ]);
    expect(await syncDependentsReadiness(c, TASK)).toBe(1);
    expect(emitted.map((e) => e.objectId)).toEqual([DEP_A]);
  });

  /**
   * Pre-review F3: a dependent that STOPS being ready must lose its
   * announcement, or the stale row permanently swallows the next one.
   */
  test('dependents that are no longer ready are retracted', async () => {
    const { client: c, calls } = client([
      { rows: [{ task_id: DEP_A }, { task_id: DEP_B }] },
      { rows: [{ id: DEP_A, project_id: null, owner_principal_id: null }] },
      { rows: [] },
      { rows: [{ task_id: DEP_A }] },
    ]);
    await syncDependentsReadiness(c, TASK);
    const retraction = calls.find((call) => call.sql.includes('DELETE FROM task_readiness'));
    expect(retraction).toBeDefined();
    expect(retraction!.params[0]).toEqual([DEP_A, DEP_B]);
    expect(retraction!.params[1]).toEqual([DEP_A]);   // only A survives
  });

  test('a parent with no dependents announces nothing and issues no further queries', async () => {
    const { client: c, calls } = client([{ rows: [] }]);
    expect(await syncDependentsReadiness(c, TASK)).toBe(0);
    expect(emitted).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });
});

describe('C2 readiness requires ASSIGNMENT (ruling ccd53781 R2, review r2 B7)', () => {
  test('the shared predicate carries the assignment clause', () => {
    // In the ONE predicate every path uses — not in a caller, where the
    // fan-out would quietly disagree with the single-task evaluation.
    expect(READY_PREDICATE_SQL).toContain('t.execution_service_id IS NOT NULL');
  });

  test('all four ratified clauses are present, and none has been dropped', () => {
    for (const clause of [
      't.execution_service_id IS NOT NULL',
      "t.status = 'todo'",
      't.auto_start = TRUE',
      'FROM task_dependencies d',
    ]) {
      expect(READY_PREDICATE_SQL).toContain(clause);
    }
  });

  /**
   * The evaluation reads the assignee under the SAME row lock that decided
   * readiness. Re-reading it in a second statement would let the assignment
   * change between the decision and the delivery, and the doorbell would ring
   * at whoever held the task a moment ago.
   */
  test('the evaluation returns the assignee it decided on, under the same lock', async () => {
    const { client: c, calls } = client([
      { rows: [{ ready: true, project_id: null, owner_principal_id: null, execution_service_id: 'svc-1' }] },
      { rows: [{ task_id: TASK }] },
    ]);
    await syncTaskReadiness(c, TASK, null);
    const evaluation = calls[0].sql;
    expect(evaluation).toContain('t.execution_service_id');
    expect(evaluation).toContain('FOR UPDATE OF t');
  });

  /**
   * Assignment, unassignment and reassignment all move a task across the
   * readiness boundary, so the write path that changes the field must
   * re-evaluate. It does, because updateTask synchronizes on EVERY update —
   * pinned here so a future "only sync when status changed" optimization
   * cannot silently reopen B7.
   */
  test('the assignment write path re-synchronizes readiness', () => {
    const source = readFileSync(join(__dirname, '..', 'services', 'TaskManagerDB.ts'), 'utf8');
    const update = source.slice(source.indexOf('async updateTask'));
    expect(update).toContain("addField('execution_service_id'");
    const syncIndex = update.indexOf('await syncTaskReadiness(client, id');
    expect(syncIndex).toBeGreaterThan(-1);
    // The sync is unconditional: no `if (updates.status` guard wraps it.
    const preceding = update.slice(Math.max(0, syncIndex - 400), syncIndex);
    expect(preceding).not.toMatch(/if \(updates\.status[^)]*\)\s*\{\s*$/);
  });
});

describe('C2 a reassigned task rings the NEW assignee (pre-review P1)', () => {
  /**
   * The defect: `task_readiness` recorded only THAT a task was announced, so
   * reassigning a ready task hit ON CONFLICT DO NOTHING and emitted nothing —
   * while the new assignee's own delivery cursor had already moved past the
   * original event. It would never learn about work it now owns.
   *
   * The announcement is therefore keyed by (task, ASSIGNEE), and the claim is
   * a conditional upsert rather than DO NOTHING.
   */
  test('the announcement claim is keyed by the assignee, conditionally', async () => {
    const { client: c, calls } = client([
      { rows: [{ ready: true, project_id: null, owner_principal_id: null, execution_service_id: 'svc-A' }] },
      { rows: [{ task_id: TASK }] },
    ]);
    const emittedNow = await syncTaskReadiness(c, TASK, null);
    expect(emittedNow).toBe(true);

    const claim = calls[1];
    expect(claim.sql).toContain('ON CONFLICT (task_id) DO UPDATE');
    // The condition is what makes it exactly-once per ASSIGNEE rather than
    // either once-ever (the defect) or once-per-update (an event storm).
    expect(claim.sql).toContain('announced_service_id IS DISTINCT FROM EXCLUDED.announced_service_id');
    expect(claim.params).toContain('svc-A');
  });

  test('an unchanged assignee does NOT re-announce', async () => {
    const { client: c } = client([
      { rows: [{ ready: true, project_id: null, owner_principal_id: null, execution_service_id: 'svc-A' }] },
      { rows: [] },   // the conditional matched nothing: same assignee, already told
    ]);
    expect(await syncTaskReadiness(c, TASK, null)).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  test('the fan-out claims the same way, so the two paths cannot disagree', async () => {
    const { client: c, calls } = client([
      { rows: [{ task_id: TASK }] },                                     // dependents
      { rows: [{ id: TASK, project_id: null, owner_principal_id: null, execution_service_id: 'svc-B' }] },
      { rows: [] },                                                      // retraction
      { rows: [{ task_id: TASK }] },                                     // claim
    ]);
    await syncDependentsReadiness(c, DEP_A, null);
    const claim = calls.find((call) => call.sql.includes('INSERT INTO task_readiness'))!;
    expect(claim.sql).toContain('ON CONFLICT (task_id) DO UPDATE');
    expect(claim.sql).toContain('announced_service_id IS DISTINCT FROM EXCLUDED.announced_service_id');
  });
});

describe('C2 the real-Postgres matrix verifies the SAME predicate', () => {
  /**
   * `qa/c2-readiness-matrix.sql` is where the predicate's SEMANTICS are
   * proven, because SQL semantics cannot be verified against a mocked pool.
   * That only means anything while the matrix runs the predicate this module
   * exports — so the matrix must contain it, interpolated, byte for byte.
   *
   * A predicate change that forgets the matrix fails HERE, loudly, instead of
   * leaving a green matrix that silently verifies last week's contract.
   */
  test('the matrix embeds READY_PREDICATE_SQL verbatim', () => {
    const matrix = readFileSync(
      join(__dirname, '..', '..', '..', 'qa', 'c2-readiness-matrix.sql'), 'utf8',
    );
    const interpolated = READY_PREDICATE_SQL.trim();
    expect(matrix).toContain(interpolated);
    // Twice: once in the reporting SELECT, once in the failing DO block, so a
    // partial update cannot leave the gate checking something else.
    expect(matrix.split(interpolated).length - 1).toBeGreaterThanOrEqual(2);
  });

  /**
   * A matrix without a positive control proves only that it agrees with
   * itself. These are the two that make it evidence: the pre-repair
   * dependency spelling must still mis-handle archived/NULL, and the
   * pre-ruling three-clause predicate must still announce an unassigned task.
   */
  test('the matrix keeps its positive controls', () => {
    const matrix = readFileSync(
      join(__dirname, '..', '..', '..', 'qa', 'c2-readiness-matrix.sql'), 'utf8',
    );
    expect(matrix).toContain('positive control FAILED: the pre-repair predicate no longer misbehaves');
    expect(matrix).toContain('positive control FAILED: the pre-ruling three-clause predicate no longer announces the unassigned task');
    expect(matrix).toContain('B1 FAILED: a registry-only webhook Connector was NOT in the work-plane due-set');
    expect(matrix).toContain('P1 FAILED: reassigning a ready task did NOT re-announce');
  });
});

describe('C2 arming enforcement survives the autoStart retirement', () => {
  test('both claim paths still refuse an unarmed task', () => {
    const orchestration = readFileSync(
      join(__dirname, '..', 'services', 'TaskOrchestrationService.ts'), 'utf8');
    expect(orchestration).toContain("'AUTO_START_DISABLED'");
    expect(orchestration).toContain('if (!task.auto_start)');

    const manager = readFileSync(join(__dirname, '..', 'services', 'TaskManagerDB.ts'), 'utf8');
    expect(manager).toContain("auto_start !== true) return 'unarmed'");
  });

  test('migration 101 flips the auto_start column default to FALSE', () => {
    const migration = readFileSync(
      join(__dirname, '..', 'migrations', '101_webhook_subscriptions.sql'), 'utf8');
    expect(migration).toContain('ALTER TABLE tasks ALTER COLUMN auto_start SET DEFAULT FALSE;');
  });

  /**
   * Readiness bookkeeping must NOT live on `tasks`: that table carries a
   * BEFORE UPDATE trigger bumping `updated_at`, which is the claim path's
   * optimistic-concurrency token. A readiness column there would invalidate a
   * claimant's snapshot every time the board announced a task was ready.
   */
  test('readiness bookkeeping stays off the tasks table', () => {
    const migration = readFileSync(
      join(__dirname, '..', 'migrations', '101_webhook_subscriptions.sql'), 'utf8');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS task_readiness');
    expect(migration).not.toMatch(/ALTER TABLE tasks ADD COLUMN[^\n]*ready/i);
  });
});
