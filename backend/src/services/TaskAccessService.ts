// TaskAccessService.ts — the attributed writer for `tasks.restricted_access`
// (RH-AZ.PROJ-a, card b363a38c; migration 117).
//
// Owner ruling 44ee41f2 made Project visibility INHERITED by default and made
// restriction an EXPLICIT exceptional policy — never a side effect of adding a
// grant, and never reachable from an ordinary content edit. Migration 085 gave
// the Phase that policy and `PhaseService.setRestrictedAccess` its only writer.
// Run packet 16896595 decision 3 extends the same inheritance to the Task, so
// the Task takes the same opt-out on the same terms, through this one method.
//
// NOTHING HERE ENFORCES AUTHORIZATION. The route in front of it carries the
// `tasks:admin` route scope and the shared point-authorization gate; this
// service's job is that the change is ATTRIBUTED and LEDGERED atomically, and
// that no other code path can reach the column. The database refuses an
// unattributed write outright (117's `ledger_task_access_change` trigger
// RAISEs), so the two GUCs below are not an optimisation — they are the only
// way the UPDATE can succeed at all.
//
// There is deliberately NO revision guard: `tasks` carries no `revision`
// column (unlike `phases`), so the concurrency control here is the row lock
// plus the unchanged-value refusal, which is what makes a double submit a 409
// rather than a second ledger row.
import { pool } from '../db/connection';
import { feedEventService } from './FeedEventService';
import { ConflictFault, InvalidRequestFault, NotFoundFault } from '../utils/httpErrors';

/** The Task lifecycle's terminal, reversible deactivation. An archived row is
 *  READ-ONLY: 085's precedent refuses an archived Phase outright
 *  (`PhaseService.withPhaseLock(..., { requireActivePhase: true })`), and an
 *  ACL flip on an archived object would move `updated_at` and append a ledger
 *  row for an object that has left the board (review cf04a642 finding 2). */
const ARCHIVED_STATUS = 'archived';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TASK_ACCESS_REASON_MIN_LENGTH = 3;
export const TASK_ACCESS_REASON_MAX_LENGTH = 1000;

export interface SetTaskAccessInput {
  restricted?: unknown;
  reason?: unknown;
  actorPrincipalId?: unknown;
}

export interface TaskAccessPolicy {
  taskId: string;
  restrictedAccess: boolean;
}

export class TaskAccessService {
  /**
   * Change the exceptional confidentiality mode of ONE Task and append its
   * audit record in the SAME transaction. A Task's own `visibility` is a
   * separate, ordinary field: this method never touches it, and setting
   * `restricted_access` suppresses only the arm the Task INHERITS from its
   * Phase and Project.
   */
  async setRestrictedAccess(id: string, input: SetTaskAccessInput): Promise<TaskAccessPolicy> {
    if (!UUID_PATTERN.test(String(id))) {
      throw new NotFoundFault('Task not found', 'TASK_NOT_FOUND');
    }
    if (typeof input.actorPrincipalId !== 'string' || !UUID_PATTERN.test(input.actorPrincipalId)) {
      throw new InvalidRequestFault(
        'a resolved Principal is required for access-policy changes', 'INVALID_TASK_ACCESS',
      );
    }
    if (typeof input.restricted !== 'boolean') {
      throw new InvalidRequestFault('restricted must be a boolean', 'INVALID_TASK_ACCESS');
    }
    if (typeof input.reason !== 'string'
      || input.reason.trim().length < TASK_ACCESS_REASON_MIN_LENGTH
      || input.reason.trim().length > TASK_ACCESS_REASON_MAX_LENGTH) {
      throw new InvalidRequestFault(
        `reason must be ${TASK_ACCESS_REASON_MIN_LENGTH}..${TASK_ACCESS_REASON_MAX_LENGTH} characters`,
        'INVALID_TASK_ACCESS',
      );
    }
    const reason = input.reason.trim();
    const actorPrincipalId = input.actorPrincipalId;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(
        'SELECT id, project_id, status, restricted_access FROM tasks WHERE id = $1 FOR UPDATE', [id],
      );
      if (found.rows.length === 0) {
        throw new NotFoundFault('Task not found', 'TASK_NOT_FOUND');
      }
      if (String(found.rows[0].status) === ARCHIVED_STATUS) {
        throw new ConflictFault(
          'Task is archived and read-only; unarchive it first', 'TASK_ARCHIVED',
        );
      }
      const current = Boolean(found.rows[0].restricted_access);
      if (current === input.restricted) {
        throw new ConflictFault(
          'Task access policy already has the requested value', 'TASK_ACCESS_UNCHANGED',
        );
      }
      // The ledger trigger reads BOTH of these and RAISEs without them, so an
      // attributed write is the only writable shape. `set_config(..., TRUE)`
      // scopes them to this transaction: a rollback takes the attribution with
      // it, and a later statement on a recycled pool connection cannot inherit
      // an actor that never authorised it.
      await client.query('SELECT set_config($1, $2, TRUE)', ['relayhall.task_access_actor', actorPrincipalId]);
      await client.query('SELECT set_config($1, $2, TRUE)', ['relayhall.task_access_reason', reason]);
      const result = await client.query(
        `UPDATE tasks SET restricted_access = $2, updated_at = NOW()
          WHERE id = $1 RETURNING id, restricted_access`,
        [id, input.restricted],
      );
      // RH-P3.C1: flipping restricted access IS the ACL change the contract
      // names, and it is announced CONTENT-FREE — the reason lives in the
      // ledger, which is read behind the admin route, never in the feed.
      await feedEventService.emit(client, {
        name: 'task.acl_changed',
        objectType: 'task',
        objectId: id,
        projectId: (found.rows[0].project_id as string | null) ?? null,
        payload: {},
      });
      await client.query('COMMIT');
      return {
        taskId: String(result.rows[0].id),
        restrictedAccess: Boolean(result.rows[0].restricted_access),
      };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
}

export const taskAccessService = new TaskAccessService();
