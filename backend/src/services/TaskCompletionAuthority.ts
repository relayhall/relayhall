import { taskAccountControl, recordAccountTaskDisposition } from './AccountControlService';
import type { PoolClient } from 'pg';
import type { TaskActor } from './TaskHistoryService';
import { authorizationRepository } from './AuthorizationRepository';
import { taskAuthoritySnapshot } from './TaskAuthoritySnapshot';
import { ForbiddenFault } from '../utils/httpErrors';
import { verifierStanding } from './VerificationModes';

/** The ordinary-account whole-Task approval path, distinct from the internal
 * structured reviewer. The caller has locked the current Task and subtasks. */
export async function assertTaskCompletionAuthority(
  client: PoolClient,
  current: { id: string; status: string; archived_at?: unknown; verifier_principal_id?: string | null; owner_principal_id?: string | null },
  actor: TaskActor,
): Promise<void> {
  const account = await taskAccountControl(client, current.id, actor);
  if (account && !current.archived_at) {
    await recordAccountTaskDisposition(client, current.id, actor, account, 'completed');
    return;
  }
  const refuse = () => { throw new ForbiddenFault('Completion requires the current independent Verifier', 'TASK_COMPLETION_FORBIDDEN'); };
  if (current.status !== 'review' || current.archived_at || !actor.principalId
    || current.owner_principal_id === actor.principalId) return refuse();
  // Section 6.8 (E462 S4b): the exact Verifier, or a `verifier-agent` of it.
  // The `verify` predicate below decides both and applies the chain guard.
  if (!(await verifierStanding(client, current, actor.principalId))) return refuse();
  const actors = await taskAuthoritySnapshot(client, actor, current.id);
  if (!actors) return refuse();
  for (const value of actors) {
    if (!(await authorizationRepository.authorizedIds(value, 'task', [current.id], 'verify', client)).has(current.id)) return refuse();
  }
}

/** A mixed request may repeat Completed while editing metadata, but only a
 * real canonical writer may do so. This is not a verification transition. */
export async function assertCompletedTaskWriteAuthority(
  client: PoolClient, current: { id: string; status: string }, actor: TaskActor,
): Promise<void> {
  if (current.status !== 'completed') {
    throw new ForbiddenFault('Completion requires a status-only task update', 'TASK_COMPLETION_PATCH_REQUIRED');
  }
  const actors = await taskAuthoritySnapshot(client, actor, current.id);
  if (!actors) throw new ForbiddenFault('Task-write authority is required', 'TASK_WRITE_FORBIDDEN');
  for (const value of actors) {
    if (!(await authorizationRepository.authorizedIds(value, 'task', [current.id], 'write', client)).has(current.id)) {
      throw new ForbiddenFault('Task-write authority is required', 'TASK_WRITE_FORBIDDEN');
    }
  }
}
