import { grantAllows, ownObjectsFor, type AuthorizationActor, type AuthorizationResource } from './AuthorizationService';
import type { DelegationActorLink } from './AuthorizationService';

/** AZ-A10 11c, shared by route admission and current-authority projection. */
export function verifierTaskActAllowed(
  acting: Pick<DelegationActorLink, 'kind' | 'boundTaskRole' | 'boundTaskId'> | undefined,
  target: { type: string; action: string; identifier: string } | null,
): boolean {
  if (acting?.kind !== 'agent' || acting.boundTaskRole !== 'verifier') return true;
  return Boolean(target && target.type === 'task' && target.action === 'verify' && target.identifier === acting.boundTaskId);
}
/** Explicit delegated Task ceilings for scoped lifecycle exceptions.
 * This does not confer positive object authority or change legacy Task roles. */
export function explicitTaskActionCaps(actor: AuthorizationActor, task: AuthorizationResource & { projectId?: string | null }, action: 'read' | 'write'): boolean {
  const links = actor.delegation?.links;
  if (!actor.authenticated || !actor.principalId || task.type !== 'task'
    || (links && links[0]?.principalId !== actor.principalId)) return false;
  if (!links || links.length < 2 || links[0].legacyIdentity) return true;
  if (links[0].kind === 'agent' && links[0].boundTaskId !== task.id) return false;
  return links.filter(link => link.parentPrincipalId).every(link => {
    const own = link.ownExpression;
    if (!own || (own.scopes !== 'parent' && !own.scopes.includes(action === 'write' ? 'tasks:write' : 'tasks:read'))) return false;
    // AZ-A10: an empty own() object list is capped by the bound role's
    // stored rows. This helper is only a cap, never a positive grant; the
    // authorization predicate checks the live role link and its expiry.
    const objects = ownObjectsFor(link) ?? [];
    if (objects === 'parent') return true;
    if (objects.length === 0 && link.kind === 'agent' && link.boundTaskId === task.id) {
      return action === 'read' || link.boundTaskRole === 'implementer';
    }
    return objects.some(rule => {
      if (rule.resourceType !== 'task' || !rule.verbs.some(v => grantAllows(v, action))) return false;
      switch (rule.selectorForm) {
        case 'all-of-type': return true;
        case 'exact': return rule.selectorIds.includes(task.id);
        case 'all-except': return !rule.selectorIds.includes(task.id);
        case 'all-in-project': return Boolean(task.projectId && rule.selectorIds.includes(task.projectId));
        default: return false;
      }
    });
  });
}
