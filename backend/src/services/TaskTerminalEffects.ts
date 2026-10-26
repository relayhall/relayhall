/**
 * The terminal effects of a Task reaching `completed` or `archived`, in ONE
 * place (universal harness connector design, section 6.8; owner ruling E462,
 * slice S4b; check VM-B4). `TaskManagerDB.updateTask` runs them on every
 * status move into a terminal state, and `TaskElementService.finish` runs the
 * same helper when a `none` Task's finish completes it, so the second path is
 * not a second copy.
 *
 *   - the AZ-S7 vehicle detach (ruling 7440b579 R2(b): reaped at
 *     task-terminal), unless the caller's own vehicle swap already did it;
 *   - AZ-A9 clause 12a: the access requests and their grant rows and
 *     credentials are reaped, in this transaction and after the detach.
 *
 * The readiness announcements (`syncTaskReadiness` for this Task, then
 * `syncDependentsReadiness` so dependents get `task.ready` and the
 * `implement` ring) are those two shared functions, run by both callers after
 * their feed row.
 */
import type { PoolClient } from 'pg';
import type { AuditActor } from './AuditService';
import { accessVehicleService } from './AccessVehicleService';
import { reapAccessRequestsAtTerminal, type AccessRequestTerminalSubject } from '../utils/accessRequestTerminal';

export async function runTaskTerminalEffects(client: PoolClient, input: {
  taskId: string;
  to: 'completed' | 'archived';
  via: AccessRequestTerminalSubject['via'];
  actor: AuditActor;
  /** False when the caller's vehicle swap already detached at this transition. */
  detachVehicle: boolean;
}): Promise<void> {
  if (input.detachVehicle) {
    await accessVehicleService.detach(client, input.taskId, input.actor,
      'AZ-S7: the task reached a terminal status');
  }
  await reapAccessRequestsAtTerminal(client, {
    type: 'task', id: input.taskId, to: input.to, via: input.via,
  }, input.actor);
}
