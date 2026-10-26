import { pool } from '../db/connection';
import type { PoolClient } from 'pg';
import { taskAccountControl } from './AccountControlService';
import { taskAuthoritySnapshot } from './TaskAuthoritySnapshot';
import { authorizationRepository } from './AuthorizationRepository';
import { auditService } from './AuditService';
import { feedEventService } from './FeedEventService';
import type { TaskActor } from './TaskHistoryService';
import { ResourceContractError } from './ProjectResourceService';
import { isStoredLoginSessionKind } from '../utils/administratorSession';
import { sessionIdleMs } from './LoginSessionService';

/** Exact Verifier or explicit account owner/Main only; a verify grant, legacy
 * reviewer role, Shepherd assignment or administrator role is not appointment. */
async function mayWrite(client: PoolClient, task: any, actor: TaskActor): Promise<boolean> {
  if (await taskAccountControl(client, task.id, actor)) return true;
  if (!actor.principalId || task.verifier_principal_id !== actor.principalId
    || task.owner_principal_id === actor.principalId) return false;
  if (!actor.credentialId) {
    if (!actor.sessionId || !isStoredLoginSessionKind(actor.authMethod)) return false;
    const session = await client.query(`SELECT id FROM auth_sessions WHERE id=$1 AND principal_id=$2
      AND revoked_at IS NULL AND expires_at>clock_timestamp()
      AND last_seen_at>clock_timestamp()-($3::double precision*interval '1 millisecond')`,
    [actor.sessionId, actor.principalId, sessionIdleMs()]);
    if (session.rows.length !== 1) return false;
  }
  const snapshots = await taskAuthoritySnapshot(client, actor, task.id);
  if (!snapshots) return false;
  for (const snapshot of snapshots) {
    if (!(await authorizationRepository.authorizedIds(snapshot, 'task', [task.id], 'verify', client)).has(task.id)) return false;
  }
  return true;
}

export class TaskSuccessCriteriaService {
  async access(taskId: string, actor: TaskActor): Promise<boolean> {
    const client = await pool.connect();
    try {
      const task = (await client.query('SELECT * FROM tasks WHERE id=$1', [taskId])).rows[0];
      return !!task && task.status !== 'archived' && await mayWrite(client, task, actor);
    } finally { client.release(); }
  }

  async change(taskId: string, body: unknown, actor: TaskActor): Promise<void> {
    const input = body as Record<string, unknown> | null;
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== 1 || !Object.prototype.hasOwnProperty.call(input, 'successCriteria')) {
      throw new ResourceContractError(422, 'INVALID_SUCCESS_CRITERIA', 'Supply only successCriteria as a string or an array of strings');
    }
    const criteria = input.successCriteria;
    if (!(typeof criteria === 'string' && criteria.length <= 100000
      || Array.isArray(criteria) && criteria.length <= 200 && criteria.every(item => typeof item === 'string' && item.length <= 10000))) {
      throw new ResourceContractError(422, 'INVALID_SUCCESS_CRITERIA', 'successCriteria must be a string (at most 100000 characters) or up to 200 strings (at most 10000 characters each)');
    }
    const client = await pool.connect();
    let ended = false;
    try {
      await client.query('BEGIN');
      const task = (await client.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [taskId])).rows[0];
      if (!task) throw new ResourceContractError(404, 'TASK_NOT_FOUND', 'Task not found');
      if (!await mayWrite(client, task, actor)) {
        await auditService.record({ action: 'task.success_criteria.change', actor: {
          principalId: actor.principalId, handle: actor.handle, authMethod: actor.authMethod ?? 'unknown', credentialId: actor.credentialId,
        }, outcome: 'denied', resourceType: 'task', resourceId: taskId, metadata: { refusal: 'TASK_VERIFIER_REQUIRED' } }, client);
        await client.query('COMMIT'); ended = true;
        throw new ResourceContractError(403, 'TASK_VERIFIER_REQUIRED', 'The assigned Verifier or account owner/Main must write success criteria');
      }
      if (task.status === 'archived') throw new ResourceContractError(409, 'TASK_ARCHIVED', 'Restore the Task before changing success criteria');
      await client.query('UPDATE tasks SET success_criteria=$2,updated_at=clock_timestamp() WHERE id=$1', [taskId, JSON.stringify(criteria)]);
      // Content never enters the ledger or feed; failure of either sink rolls
      // the criteria back with its audit receipt.
      await auditService.record({ action: 'task.success_criteria.change', actor: {
        principalId: actor.principalId, handle: actor.handle, authMethod: actor.authMethod ?? 'unknown', credentialId: actor.credentialId,
      }, resourceType: 'task', resourceId: taskId, metadata: { field: 'successCriteria' } }, client);
      await feedEventService.emit(client, { name: 'task.updated', objectType: 'task', objectId: taskId,
        projectId: task.project_id, actorPrincipalId: actor.principalId, actorHandle: actor.handle,
        ownerPrincipalId: task.account_owner_principal_id, payload: { fields: ['successCriteria'] } });
      await client.query('COMMIT'); ended = true;
    } catch (error) { if (!ended) await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
export const taskSuccessCriteriaService = new TaskSuccessCriteriaService();
