import { taskAccountControl, recordAccountTaskDisposition } from './AccountControlService';
import type { PoolClient } from 'pg';
import type { TaskActor } from './TaskHistoryService';
import { taskAuthoritySnapshot } from './TaskAuthoritySnapshot';
import { authorizationRepository } from './AuthorizationRepository';
import { scopesForRole } from '../utils/identityScopes';
import { resolveActorRole } from '../utils/taskAutomationRole';
import { sessionIdleMs } from './LoginSessionService';
import { ForbiddenFault } from '../utils/httpErrors';
import { isStoredLoginSessionKind } from '../utils/administratorSession';

/** Archive/undo is not approval. Caller holds the Task lock. Authority is
 * server-resolved at decision time; the global automation role stays intact. */
export async function assertHumanTaskArchiveAuthority(client: PoolClient, taskId: string, actor?: TaskActor, recordDisposition = true): Promise<void> {
  const account = await taskAccountControl(client, taskId, actor);
  if (account && actor) {
    if (recordDisposition) await recordAccountTaskDisposition(client, taskId, actor, account, 'archive-or-restore');
    return;
  }
  const refuse = (): never => { throw new ForbiddenFault('Archiving and restoring require a current human Account with Task WRITE', 'TASK_ARCHIVE_FORBIDDEN'); };
  if (!actor?.principalId || !actor.authorization?.authenticated
    || actor.authorization.principalId !== actor.principalId) return refuse();
  // Accounts authenticate with login sessions; they cannot mint bearers.
  if (!isStoredLoginSessionKind(actor.authMethod)) return refuse();
  const identity = await client.query("SELECT kind, status, parent_principal_id, role FROM principals WHERE id = $1", [actor.principalId]);
  const principal = identity.rows[0];
  if (!principal || principal.kind !== 'human' || principal.status !== 'active' || principal.parent_principal_id !== null) return refuse();
  {
    if (!actor.sessionId) return refuse();
    const sessions = await client.query(`SELECT role_snapshot FROM auth_sessions
      WHERE id = $1 AND principal_id = $2 AND revoked_at IS NULL
        AND expires_at > clock_timestamp()
        AND last_seen_at > clock_timestamp() - ($3::double precision * interval '1 millisecond')`,
    [actor.sessionId, actor.principalId, sessionIdleMs()]);
    if (sessions.rows.length !== 1) return refuse();
    const role = resolveActorRole({ handle: actor.handle, principalRole: principal.role, sessionRole: sessions.rows[0].role_snapshot });
    const scopes = scopesForRole(role);
    if (!scopes.includes('root') && !scopes.includes('tasks:write')) return refuse();
  }
  const actors = await taskAuthoritySnapshot(client, actor, taskId);
  if (!actors) return refuse();
  for (const value of actors) {
    if (!(await authorizationRepository.authorizedIds(value, 'task', [taskId], 'write', client)).has(taskId)) return refuse();
  }
}
