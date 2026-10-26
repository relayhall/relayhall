import { scopesForRole } from '../utils/identityScopes';
import { resolveActorRole } from '../utils/taskAutomationRole';
import { isStoredLoginSessionKind } from '../utils/administratorSession';
import type { PoolClient } from 'pg';
import type { TaskActor } from './TaskHistoryService';
import type { ChainLink } from './DelegationService';
import { delegationService } from './DelegationService';
import { taskAuthoritySnapshot } from './TaskAuthoritySnapshot';
import { authorizationRepository } from './AuthorizationRepository';
import { auditService } from './AuditService';
import { sessionIdleMs } from './LoginSessionService';

/** Explicit account authority only. A name, role or broad own-expression is
 * not a Main appointment. A stale appointment cannot survive reparenting. */
export function controllerAccount(links: ChainLink[]): string | null {
  if (!links.length || links.some(link => link.status !== 'active' || link.legacyIdentity)) return null;
  const [acting, parent] = links;
  if (links.length === 1 && acting.kind === 'human' && !acting.parentPrincipalId) return acting.principalId;
  if (links.length !== 2 || acting.kind !== 'service' || acting.boundTaskId
    || parent.kind !== 'human' || parent.parentPrincipalId
    || acting.parentPrincipalId !== parent.principalId
    || acting.ownerControlAccountId !== parent.principalId) return null;
  return parent.principalId;
}

/** Called under the resource transaction. Null is ordinary restricted
 * lifecycle authority, never permission to skip another check. */
export async function resourceAccountControl(client: PoolClient, type: 'task' | 'project' | 'phase' | 'report',
  taskId: string, actor?: TaskActor): Promise<string | null> {
  const writeScope = ({task:'tasks:write',project:'projects:write',phase:'phases:write',report:'reports:write'} as const)[type];
  if (!actor?.principalId || !actor.authorization?.authenticated
    || actor.authorization.principalId !== actor.principalId) return null;
  const chain = await delegationService.resolveChain(actor.principalId, client);
  if (!chain.alive) return null;
  const account = controllerAccount(chain.links);
  if (!account) return null;
  if (chain.links[0].kind === 'human') {
    if (!isStoredLoginSessionKind(actor.authMethod) || !actor.sessionId) return null;
    const session = await client.query(
      `SELECT id, role_snapshot FROM auth_sessions WHERE id=$1 AND principal_id=$2
       AND revoked_at IS NULL AND expires_at > clock_timestamp()
       AND last_seen_at > clock_timestamp() - ($3::double precision * interval '1 millisecond')`,
      [actor.sessionId, actor.principalId, sessionIdleMs()]);
    if (session.rows.length !== 1) return null;
    const liveSessionRole = resolveActorRole({ handle: actor.handle,
      principalRole: chain.links[0].role, sessionRole: session.rows[0].role_snapshot });
    const sessionScopes = scopesForRole(liveSessionRole);
    if (!sessionScopes.includes('root') && !sessionScopes.includes(writeScope)) return null;
  } else {
    if (!actor.credentialId) return null;
    const credential = await client.query(
      `SELECT scopes FROM principal_credentials WHERE id=$1 AND principal_id=$2
       AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > clock_timestamp())
       AND (grace_until IS NULL OR grace_until > clock_timestamp())`,
      [actor.credentialId, actor.principalId]);
    const scopes = credential.rows[0]?.scopes;
    if (!Array.isArray(scopes) || !scopes.includes(writeScope)) return null;
  }
  const snapshots = await taskAuthoritySnapshot(client, actor, taskId, writeScope);
  if (!snapshots) return null;
  const ownershipSql = {
    task: 'SELECT t.id FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=$1 AND COALESCE(t.account_owner_principal_id,p.owner_principal_id)=$2',
    project: 'SELECT id FROM projects WHERE id=$1 AND owner_principal_id=$2',
    phase: 'SELECT ph.id FROM phases ph JOIN projects p ON p.id=ph.project_id WHERE ph.id=$1 AND p.owner_principal_id=$2',
    report: 'SELECT id FROM reports WHERE id=$1 AND account_owner_principal_id=$2',
  };
  const owned = await client.query(ownershipSql[type], [taskId, account]);
  if (owned.rows.length !== 1) return null;
  for (const snapshot of snapshots) {
    if (!(await authorizationRepository.authorizedIds(snapshot, type, [taskId], 'write', client)).has(taskId)) return null;
  }
  return account;
}

export async function recordAccountTaskDisposition(client: PoolClient, taskId: string,
  actor: TaskActor, accountId: string, disposition: string, subtaskId?: string): Promise<void> {
  await auditService.record({
    action: 'task.account_disposition',
    actor: { principalId: actor.principalId, handle: actor.handle,
      authMethod: actor.authMethod ?? 'unknown', credentialId: actor.credentialId ?? null },
    resourceType: 'task', resourceId: taskId,
    metadata: { accountPrincipalId: accountId, disposition, subtaskId: subtaskId ?? null,
      basis: 'account-owner-control', independentVerification: false },
  }, client);
}

export async function taskAccountControl(client: PoolClient, taskId: string, actor?: TaskActor): Promise<string | null> {
  return resourceAccountControl(client, 'task', taskId, actor);
}
