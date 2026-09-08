/**
 * taskReadiness — RH-P3.C2: `task.ready` derivation (card subtask 2,
 * runbook daf703a6 §5, analysis d8507677 §4).
 *
 * A task is READY when all FOUR hold:
 *   1. it is ASSIGNED,
 *   2. its status is `todo`,
 *   3. it is ARMED (`auto_start`), and
 *   4. every dependency is satisfied.
 *
 * ── The assignment clause (ruling ccd53781 R2; review r2, B7) ──
 *
 * Ratified strategy 4e40f06f §2.6.4: "The `task.ready` derived event is the
 * only 'go' signal: it fires when a task is ASSIGNED, in todo, armed, and
 * dependency-satisfied." The first cut of this candidate derived readiness
 * from clauses 2-4 only, so an armed, unassigned, dependency-free task
 * announced a go signal immediately — and any broadly-granted subscriber
 * could act on work assigned to nobody. That defeats per-assignee delivery
 * and re-opens the premature-pickup incidents arming exists to close.
 *
 * The ASSIGNMENT FIELD OF RECORD is `tasks.execution_service_id` (migration
 * 077, mirrored to `task_execution_profiles.service_id` by 086): the
 * Connector-first execution profile naming the registered Service the task
 * targets. Owner decision D6 on run packet c17ebfff records why it, and not
 * one of the two nearby concepts that are NOT this:
 *   - AUTHZ 4d961e37 §4 "assignment" is ACCESS-PROFILE assignment (a
 *     profile_id granted to a principal or group) — an authorization-plane
 *     concept with no task in it;
 *   - `task_assignments` (086) carries claimant/shepherd/verifier, and the
 *     claimant is set AT CLAIM TIME, so it cannot gate a signal whose whole
 *     purpose is to precede the claim.
 *
 * Unassigned eligible work is not lost: it is discovered by PULL — "my ready
 * tasks" = grants ∪ current assignments, capped by the registration's
 * visibility tier (§2.6.4) — which is exactly how a webhook-less connector
 * finds work on its own cron.
 *
 * Readiness is always DERIVED here, never stored as a status. The
 * `task_readiness` table records only whether the current transition has been
 * ANNOUNCED.
 *
 * The dependency-satisfaction predicate is deliberately identical to the
 * authoritative one in TaskOrchestrationService.claimReadyTask: a parent
 * counts when it is `completed`, or `archived` with an archive disposition of
 * `completed`. If those two ever diverge, the board announces tasks as ready
 * that the claim path then refuses — an infinite poll loop for every
 * scheduler subscribed to `task.ready`. They are pinned together by an
 * executable equivalence test in `c2TaskReadiness.test.ts`, not by a source
 * grep: a grep passes happily when a THIRD clause is added to one side.
 *
 * Every function here takes the CALLER'S transaction client: a readiness
 * announcement must be visible exactly when the change that caused it is,
 * which is the emission contract C1 established for the feed.
 */
import { feedEventService, type FeedEmitClient } from '../services/FeedEventService';

export interface ReadinessActor {
  principalId?: string | null;
  handle?: string | null;
}

/**
 * A parent dependency is satisfied when it is completed, or archived with a
 * completed disposition. Exported as ONE SQL fragment so the single-task and
 * set-based paths cannot drift, and so the equivalence test has something
 * executable to compare against the claim gate.
 *
 * The predicate is consumed as `(...) IS NOT TRUE`, never as `NOT (...)`.
 * `archive_disposition` is nullable, and under three-valued logic
 * `NOT (status = 'archived' AND disposition = 'completed')` evaluates to NULL
 * for an archived parent with a NULL disposition — a WHERE clause does not
 * select NULL, so NOT EXISTS reported the child READY while the claim path,
 * using ordinary JavaScript booleans, refused it with UNMET_DEPENDENCY
 * (review r1, B3). `IS NOT TRUE` folds NULL in with FALSE, so an
 * indeterminate disposition fails CLOSED and the two agree.
 */
export const DEPENDENCY_SATISFIED_SQL =
  `(parent.status = 'completed' OR (parent.status = 'archived' AND parent.archive_disposition = 'completed'))`;

/**
 * The readiness predicate over a `tasks` alias `t`, as SQL. Everything that
 * decides readiness lives here and nowhere else.
 */
export const READY_PREDICATE_SQL = `
  t.execution_service_id IS NOT NULL
  AND t.status = 'todo'
  AND t.auto_start = TRUE
  AND NOT EXISTS (
    SELECT 1
      FROM task_dependencies d
      JOIN tasks parent ON parent.id = d.depends_on_task_id
     WHERE d.task_id = t.id
       AND (${DEPENDENCY_SATISFIED_SQL}) IS NOT TRUE
  )`;

export interface ReadinessState {
  ready: boolean;
  projectId: string | null;
  ownerPrincipalId: string | null;
  /**
   * The ASSIGNEE (services.id) this readiness belongs to, read under the same
   * row lock that decided readiness. The work plane addresses its doorbell to
   * this Connector; re-reading it in a second statement would let the
   * assignment change between the decision and the delivery.
   */
  executionServiceId: string | null;
}

/**
 * Evaluate readiness for one task, taking a ROW LOCK on it.
 *
 * The lock is load-bearing, not defensive. Without it this is a read followed
 * by a claim under READ COMMITTED: a concurrent transaction can disarm the
 * task between the two, and this one then announces a task that is no longer
 * ready AND leaves a `task_readiness` row behind that silently swallows the
 * NEXT genuine announcement (pre-review F4). Locking the row makes the
 * evaluation and the claim agree about the same version of it.
 *
 * Deadlock is not reachable through this lock: the only cross-row ordering it
 * introduces follows dependency edges, and the dependency graph is a DAG
 * (enforced by the board's dependency-integrity rules), so no cycle of waits
 * can form.
 *
 * Returns null when the task is gone.
 */
export async function evaluateReadiness(
  client: FeedEmitClient,
  taskId: string,
): Promise<ReadinessState | null> {
  const result = await client.query(
    `SELECT t.status, t.auto_start, t.project_id, t.owner_principal_id,
            t.execution_service_id,
            (${READY_PREDICATE_SQL}) AS ready
       FROM tasks t
      WHERE t.id = $1
        FOR UPDATE OF t`,
    [taskId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    ready: row.ready === true,
    projectId: row.project_id ?? null,
    ownerPrincipalId: row.owner_principal_id ?? null,
    executionServiceId: row.execution_service_id ? String(row.execution_service_id) : null,
  };
}

/**
 * Re-evaluate one task and emit `task.ready` on the transition INTO the ready
 * state, or retract the announcement on the transition out of it.
 *
 * The announcement is claimed with INSERT ... ON CONFLICT DO NOTHING
 * RETURNING, so exactly one transaction emits even when several evaluate
 * concurrently — a plain "SELECT then INSERT" would let two writers both
 * observe an empty table and announce the same transition twice.
 *
 * Returns true when an event was emitted.
 */
export async function syncTaskReadiness(
  client: FeedEmitClient,
  taskId: string,
  actor?: ReadinessActor | null,
): Promise<boolean> {
  const state = await evaluateReadiness(client, taskId);
  if (!state) return false;

  if (!state.ready) {
    // Leaving the ready state retracts the announcement so that re-entering
    // it later announces again. No event is emitted for the retraction: the
    // status/arming change that caused it already emitted `task.updated`.
    await client.query('DELETE FROM task_readiness WHERE task_id = $1', [taskId]);
    return false;
  }

  // Exactly-once per (task, ASSIGNEE) transition. The conditional DO UPDATE
  // returns a row when the announcement is new OR when the assignee has
  // changed since it was made, and returns nothing while the same assignee
  // stays ready — so a reassignment rings the new assignee's doorbell without
  // a plain re-announcement storm on every unrelated update (pre-review P1).
  const claimed = await client.query(
    `INSERT INTO task_readiness (task_id, announced_service_id)
          VALUES ($1, $2)
     ON CONFLICT (task_id) DO UPDATE
            SET announced_service_id = EXCLUDED.announced_service_id,
                ready_emitted_at = NOW()
          WHERE task_readiness.announced_service_id IS DISTINCT FROM EXCLUDED.announced_service_id
       RETURNING task_id`,
    [taskId, state.executionServiceId],
  );
  if (!claimed.rows || claimed.rows.length === 0) return false;

  await emitReady(client, taskId, state.projectId, state.ownerPrincipalId, actor);
  return true;
}

async function emitReady(
  client: FeedEmitClient,
  taskId: string,
  projectId: string | null,
  ownerPrincipalId: string | null,
  actor?: ReadinessActor | null,
): Promise<void> {
  await feedEventService.emit(client, {
    name: 'task.ready',
    objectType: 'task',
    objectId: taskId,
    actorPrincipalId: actor?.principalId ?? null,
    actorHandle: actor?.handle ?? null,
    projectId,
    ownerPrincipalId,
    // Content-free, like every feed event: readiness is a fact about the
    // task's identity and state, and a consumer pulls the task for detail.
    payload: {},
  });
}

/**
 * Re-evaluate every task that DEPENDS on `taskId`.
 *
 * Completing a task is the one change that can make OTHER tasks ready, and it
 * is the case a per-task hook alone would miss: nothing about the dependent's
 * own row changes, so without this fan-out a task unblocked by its parent's
 * completion would never be announced.
 *
 * Evaluation, retraction and announcement-claiming are each ONE set-based
 * statement rather than a per-dependent round trip. That matters because
 * `feedEventService.emit` takes `pg_advisory_xact_lock(hashtext('feed_events'))`,
 * which is transaction-scoped and therefore serializes feed emission
 * DEPLOYMENT-WIDE from the first emission until COMMIT. Completing a hub task
 * with many dependents used to hold that global lock across three round trips
 * per dependent (pre-review F8); it now holds it across the emissions alone.
 * Batching the emissions themselves would need a batch API on the C1 feed
 * service and is filed as hardening rather than smuggled in here.
 */
export async function syncDependentsReadiness(
  client: FeedEmitClient,
  taskId: string,
  actor?: ReadinessActor | null,
): Promise<number> {
  const dependents = await client.query(
    `SELECT d.task_id FROM task_dependencies d WHERE d.depends_on_task_id = $1`,
    [taskId],
  );
  if (!dependents.rows || dependents.rows.length === 0) return 0;
  const ids = dependents.rows.map((row: any) => String(row.task_id));

  // Lock and evaluate the whole dependent set in one statement.
  const ready = await client.query(
    `SELECT t.id, t.project_id, t.owner_principal_id, t.execution_service_id
       FROM tasks t
      WHERE t.id = ANY($1::uuid[])
        AND ${READY_PREDICATE_SQL}
      ORDER BY t.id
        FOR UPDATE OF t`,
    [ids],
  );
  const readyRows = ready.rows ?? [];
  const readyIds = readyRows.map((row: any) => String(row.id));

  // Dependents that are no longer ready lose their announcement, so that
  // re-entering the ready state announces again.
  await client.query(
    `DELETE FROM task_readiness
      WHERE task_id = ANY($1::uuid[])
        AND NOT (task_id = ANY($2::uuid[]))`,
    [ids, readyIds],
  );
  if (readyIds.length === 0) return 0;

  // One claim for the whole set; only newly-claimed ids — or ids whose
  // assignee changed — announce. Same conditional as the single-task path, so
  // the two cannot disagree about what counts as a new announcement.
  const claimed = await client.query(
    `INSERT INTO task_readiness (task_id, announced_service_id)
          SELECT * FROM unnest($1::uuid[], $2::uuid[])
     ON CONFLICT (task_id) DO UPDATE
            SET announced_service_id = EXCLUDED.announced_service_id,
                ready_emitted_at = NOW()
          WHERE task_readiness.announced_service_id IS DISTINCT FROM EXCLUDED.announced_service_id
       RETURNING task_id`,
    [readyIds, readyRows.map((row: any) => (row.execution_service_id ? String(row.execution_service_id) : null))],
  );
  const claimedIds = new Set((claimed.rows ?? []).map((row: any) => String(row.task_id)));

  let emitted = 0;
  for (const row of readyRows) {
    if (!claimedIds.has(String(row.id))) continue;
    await emitReady(client, String(row.id), row.project_id ?? null, row.owner_principal_id ?? null, actor);
    emitted += 1;
  }
  return emitted;
}
