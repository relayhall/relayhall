import type { Scope } from '../utils/scopeMap';
import type { PoolClient } from 'pg';
import type { TaskActor } from './TaskHistoryService';
import { authorizationService, type AuthorizationActor } from './AuthorizationService';
import { delegationService } from './DelegationService';
import { scopesForRole } from '../utils/identityScopes';
import { resolveActorRole } from '../utils/taskAutomationRole';

/** Fresh identity authority for bounded Task lifecycle exceptions. The caller
 * owns the Task lock; no fallback actor and no extra authority-row lock order. */
export async function taskAuthoritySnapshot(
  client: PoolClient, actor: TaskActor, taskId: string, requiredScope: Scope = 'tasks:write',
): Promise<AuthorizationActor[] | null> {
  const trusted = actor.authorization;
  if (!actor.principalId || !trusted?.authenticated || trusted.principalId !== actor.principalId) return null;
  // Re-resolve on the writer's connection after acquiring the Task lock.
  // Identity, delegation, credential and grant authority use a fresh decision-
  // time snapshot, like the canonical object checks below. Do not lock their
  // rows here: credential rotation locks current then predecessor credentials,
  // and adding a different global lock order would deadlock those writers.
  const chain = await delegationService.resolveChain(actor.principalId, client);
  const acting = chain.links[0];
  if (!chain.alive || chain.links.some(link => link.status !== 'active')) return null;
  let credentialScopes: string[] | null = null;
  if (actor.credentialId) {
    const credentials = await client.query(
      `SELECT id, scopes FROM principal_credentials
        WHERE id = $1 AND principal_id = $2 AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > clock_timestamp())
          AND (grace_until IS NULL OR grace_until > clock_timestamp())`,
      [actor.credentialId, actor.principalId]);
    if (credentials.rows.length !== 1) return null;
    credentialScopes = credentials.rows[0].scopes;
  }
  if (acting.kind === 'agent' && !acting.legacyIdentity && acting.boundTaskId !== taskId) return null;

  const account = chain.links[chain.links.length - 1];
  const liveRole = resolveActorRole({ handle: trusted.handle, principalRole: acting.role });
  const liveRoleScopes = scopesForRole(liveRole);
  const requestScopes = (trusted.scopes ?? []).filter(scope => !credentialScopes || credentialScopes.includes(scope));
  const narrowedScopes = acting.parentPrincipalId && !acting.legacyIdentity
    ? delegationService.effectiveScopes(chain, requestScopes, scopesForRole(account.role))
    : requestScopes.filter(scope => liveRoleScopes.includes('root') || liveRoleScopes.includes(scope as any));
  const fresh: AuthorizationActor = {
    ...trusted, role: liveRole, scopes: narrowedScopes,
    delegation: acting.parentPrincipalId && !acting.legacyIdentity ? { links: chain.links } : null,
  };
  // Neither a role change nor a session snapshot may widen the trusted request.
  const actors = [trusted, fresh];
  if (actors.some(value => !authorizationService.authorizeRoute(value, requiredScope).allowed)) return null;
  return actors;
}
