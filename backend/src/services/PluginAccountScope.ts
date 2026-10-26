import type { AuthRequest } from '../middleware/auth';
import { bearerLayerFor, ACCOUNT_BEARER_LAYER } from '../utils/bearerLayers';
import { principalService } from './PrincipalService';
/** No global arm: plugin data always belongs to the actual Account, including root callers. */
export function pluginAccountId(req: AuthRequest): string | null {
  const links = req.delegationLinks;
  return links?.length ? links[links.length - 1].principalId : req.principal?.id ?? null;
}
export async function activePluginAccount(req: AuthRequest): Promise<string | null> {
  const account = pluginAccountId(req);
  if (!account || !req.principal?.id || req.principal.status !== 'active') return null;
  const owner = await principalService.getPrincipalById(account);
  return owner?.status === 'active' && bearerLayerFor(owner.kind,owner.parentPrincipalId) === ACCOUNT_BEARER_LAYER ? account : null;
}
