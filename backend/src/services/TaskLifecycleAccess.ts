import { assignedClaimBindingSql, assignedClaimPrincipalSql, assignedClaimCaps } from './AssignedClaimAuthority';
import { pool } from '../db/connection';
import { authorizationRepository } from './AuthorizationRepository';
import { authorizationService, type AuthorizationActor } from './AuthorizationService';

export interface LifecycleAccessDecision { allowed: boolean; reason: string | null; expectedAssignmentEpoch?: string; }
export interface TaskLifecycleAccess {
  arm: LifecycleAccessDecision;
  park: LifecycleAccessDecision;
  claim: LifecycleAccessDecision;
}

/** Display-only current decision; every mutation repeats its own checks.
 * Never include identities, grant rows, or inaccessible dependency details. */
export async function taskLifecycleAccess(actor: AuthorizationActor, task: {
  id: string; status: string; autoStart: boolean; ownerPrincipalId?: string | null;
  verifierPrincipalId?: string | null; projectId?: string | null;
}, blocked: boolean): Promise<TaskLifecycleAccess> {
  const deny = (reason: string): LifecycleAccessDecision => ({ allowed: false, reason });
  const yes: LifecycleAccessDecision = { allowed: true, reason: null };
  if (!authorizationService.authorizeRoute(actor, 'tasks:write').allowed) {
    return { arm: deny('WRITE_SCOPE_REQUIRED'), park: deny('WRITE_SCOPE_REQUIRED'), claim: deny('WRITE_SCOPE_REQUIRED') };
  }
  const allowed = async (action: 'write' | 'shepherd' | 'claim') =>
    (await authorizationRepository.authorizedIds(actor, 'task', [task.id], action)).has(task.id);
  const write = await allowed('write');
  const park = write || await allowed('shepherd');
  let claim: LifecycleAccessDecision = await allowed('claim') ? yes : deny('TASK_WRITE_REQUIRED');
  if (claim.allowed && task.verifierPrincipalId === actor.principalId) claim = deny('INDEPENDENT_VERIFIER');
  if (claim.allowed && task.ownerPrincipalId && task.ownerPrincipalId !== actor.principalId) claim = deny('TASK_ALREADY_ASSIGNED');
  if (claim.allowed && !task.autoStart) claim = deny('TASK_NOT_ARMED');
  if (claim.allowed && blocked) claim = deny('TASK_BLOCKED');
  if (claim.allowed && actor.delegation?.links[0]?.kind === 'service') {
    const row = (await pool.query(`SELECT e.epoch::text, t.project_id FROM tasks t JOIN task_native_assignment_epochs e ON e.task_id=t.id
      WHERE t.id=$1 AND ${assignedClaimBindingSql('t')} AND ${assignedClaimPrincipalSql('t')}=$2`, [task.id,actor.principalId])).rows[0];
    // The public Task carries a Project name, not its selector coordinate.
    // Use the server-owned UUID read by this same current assignment query.
    if (row && assignedClaimCaps(actor, {type: 'task',id: task.id,projectId: row.project_id}))
      claim = {...claim, expectedAssignmentEpoch: row.epoch};
  }
  return { arm: write ? yes : deny('TASK_WRITE_REQUIRED'), park: park ? yes : deny('TASK_WRITE_REQUIRED'), claim };
}
