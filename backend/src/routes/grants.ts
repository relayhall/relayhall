// grants.ts — grant management (RH-P2.3). OWNER-PLANE by §2.9: grant
// creation/widening/revocation stays out of the agent plane, so the scope
// map routes EVERY /grants method to the root sentinel (A12.1 — the v1
// admin credential class). Introspection of one's OWN grants lives on
// /principals/{id}/grants at principals:read (the A12.5 pattern), not here.
import { logCaughtFailure } from '../utils/secretSafeLog';
import { Router, Request, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { sendApiError } from '../utils/apiErrors';
import { grantService, GrantError, GrantRecord } from '../services/GrantService';
import { principalService } from '../services/PrincipalService';
import { auditActorFromRequest } from '../utils/auditActor';

const router = Router();

/**
 * WHO A GRANT IS HELD BY — resolved by the SERVER, on the row itself.
 *
 * Card f03d459e: a brand-new install presented "Access grants 1", and the one
 * row read `Unknown principal · read · report / Every resource of this type ·
 * No expiry · Revoke`. The grantee was real - the seeded compatibility identity
 * `reports_reader`, carrying the pre-grant migration 063 promises must exist
 * BEFORE any visibility tightening, migrated into `grants` by 078. Migration
 * 065 hides that identity from every listing (it is dormant until
 * `RELAYHALL_REPORTS_READ_API_KEY` configures it), and the page resolved
 * grantee names by looking them up in a listing that legitimately excludes it.
 *
 * The repair is not to widen that listing, and it is NOT to withdraw the grant:
 * 063 records the pre-grant as a LOCKED requirement, and the identity becomes
 * live the moment an operator configures the key, so a fresh install that
 * dropped it would differ from an upgraded one in authority.
 *
 * The repair is that a grants row arrives NAMING its own grantee. A governance
 * surface whose only affordance is "Revoke" must be able to say what it is
 * asking about, and it cannot do that by joining two lists that were never
 * required to agree. This is an owner-plane surface (root in the scope map),
 * so the caller already sees every grant; naming the holder discloses nothing
 * the row did not already.
 */
export interface GrantIdentitySummary {
  id: string;
  handle: string;
  displayName: string | null;
  kind: string;
  status: string;
  /** A seeded compatibility identity, hidden from the directory until an
   * integration configures it (migration 065). Shown so the operator can tell
   * a dormant seeded grant from one somebody made. */
  compatibility: boolean;
}

async function identitySummary(id: string | null): Promise<GrantIdentitySummary | null> {
  if (!id) return null;
  const principal = await principalService.getPrincipalById(id);
  if (!principal) return null;
  return {
    id: principal.id,
    handle: principal.handle,
    displayName: principal.displayName,
    kind: principal.kind,
    status: principal.status,
    compatibility: principal.metadata?.compatibility === true,
  };
}

/** Every grant, carrying its resolved grantee and granter. Resolution is
 * batched by the principal cache, and a grantee whose row is genuinely gone
 * still resolves to `null` — the surface then says so about a specific id
 * rather than about a name it could not find. */
async function withIdentities(grants: GrantRecord[]): Promise<Array<GrantRecord & {
  grantee: GrantIdentitySummary | null;
  grantedBy: GrantIdentitySummary | null;
}>> {
  return Promise.all(grants.map(async (grant) => ({
    ...grant,
    grantee: grant.granteeType === 'principal' ? await identitySummary(grant.granteeId) : null,
    grantedBy: await identitySummary(grant.grantedByPrincipalId ?? null),
  })));
}

function sendGrantError(res: Response, e: unknown): boolean {
  if (e instanceof GrantError) {
    sendApiError(res, e.status, e.code, e.message, undefined, e.field ? { field: e.field } : undefined);
    return true;
  }
  return false;
}

function logGrantRouteFailure(context: string, e: unknown): string {
  return logCaughtFailure(`[Grants API] ${context} failed:`, e);
}

function checkQueryKeys(req: Request, res: Response, allowed: string[]): boolean {
  for (const key of Object.keys(req.query)) {
    if (!allowed.includes(key)) {
      sendApiError(res, 400, 'UNKNOWN_FIELD', `Unknown query parameter '${key}'`);
      return false;
    }
    if (Array.isArray(req.query[key])) {
      sendApiError(res, 400, 'INVALID_QUERY_VALUE', `Duplicate query parameter '${key}'`);
      return false;
    }
  }
  return true;
}

/**
 * GET /api/grants — list grants (owner plane). Filters: ?granteeId=, ?resourceType=.
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!checkQueryKeys(req, res, ['granteeId', 'resourceType'])) return;
    const grants = await grantService.list({
      granteeId: req.query.granteeId as string | undefined,
      resourceType: req.query.resourceType as string | undefined,
    });
    res.json({ success: true, grants: await withIdentities(grants) });
  } catch (e) {
    if (sendGrantError(res, e)) return;
    const errorId = logGrantRouteFailure('list grants', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to list grants', undefined, { errorId });
  }
});

/**
 * POST /api/grants — create a grant (owner plane). v1: principals-only.
 */
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!checkQueryKeys(req, res, [])) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const allowed = ['granteeType', 'granteeId', 'resourceType', 'resourceId', 'verb', 'expiresAt'];
    for (const key of Object.keys(body)) {
      if (!allowed.includes(key)) {
        sendApiError(res, 400, 'UNKNOWN_FIELD', `Unknown field '${key}' — accepted fields are: ${allowed.join(', ')}`);
        return;
      }
    }
    const grant = await grantService.create(body, auditActorFromRequest(req));
    res.status(201).json({ success: true, grant });
  } catch (e) {
    if (sendGrantError(res, e)) return;
    const errorId = logGrantRouteFailure('create grant', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to create the grant', undefined, { errorId });
  }
});

/**
 * DELETE /api/grants/{id} — revoke (owner plane). Revocation is deletion:
 * grants are live authority configuration, not history (070 doctrine).
 */
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!checkQueryKeys(req, res, [])) return;
    const removed = await grantService.remove(req.params.id, auditActorFromRequest(req));
    res.json({ success: true, grant: removed });
  } catch (e) {
    if (sendGrantError(res, e)) return;
    const errorId = logGrantRouteFailure('remove grant', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to remove the grant', undefined, { errorId });
  }
});

export default router;
