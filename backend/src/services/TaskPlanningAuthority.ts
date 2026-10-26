import type { PoolClient } from 'pg';
import type { TaskActor } from './TaskHistoryService';
import type { AuthorizationAction } from './AuthorizationService';
import { authorizationRepository } from './AuthorizationRepository';
import { taskAuthoritySnapshot } from './TaskAuthoritySnapshot';
import { ForbiddenFault } from '../utils/httpErrors';

/**
 * The caller holds the Task row FOR UPDATE. Planning is not a new role:
 * task-write AND (the exact current Shepherd AND shepherd authority, OR
 * canonical task administration) must all hold in this transaction.
 * Never use the system-actor fallback from assignment materialization here.
 */
export async function assertTaskPlanningAuthority(
  client: PoolClient,
  current: { id: string; status: string; archived_at?: unknown; shepherd_principal_id?: string | null },
  actor: TaskActor,
): Promise<void> {
  const refuse = () => { throw new ForbiddenFault('Planning transitions require task-write and current Shepherd or task-admin authority', 'TASK_PLANNING_FORBIDDEN'); };
  const trusted = actor.authorization;
  if (!['ideas', 'todo'].includes(current.status) || current.archived_at
    || !actor.principalId || !trusted?.authenticated || trusted.principalId !== actor.principalId) return refuse();

  const actors = await taskAuthoritySnapshot(client, actor, current.id);
  if (!actors) return refuse();
  const allowed = async (action: AuthorizationAction): Promise<boolean> => {
    for (const value of actors) {
      if (!(await authorizationRepository.authorizedIds(value, 'task', [current.id], action, client)).has(current.id)) return false;
    }
    return true;
  };
  if (!(await allowed('write'))) return refuse();
  if (current.shepherd_principal_id === actor.principalId && await allowed('shepherd')) return;
  if (await allowed('admin')) return;
  return refuse();
}
