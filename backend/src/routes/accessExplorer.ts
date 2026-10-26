// accessExplorer.ts — the Access Explorer read model (AZ-A12 build 6, card
// 1e56dbef; amendment AZ-A12 clause 12 and E45 (3), ratified E72).
//
// READ-ONLY. Every route is a GET under the family's `principals:read`
// ceiling (design 4d961e37 §5.3: Groups, membership, Group roles and Group
// ownership are directory data). The handlers narrow further: the object hop
// answers only a caller that may read the object (404 otherwise, as for an
// absent one), and another principal's authority is shown only to a `root`
// caller (the what-if standard) - anyone else sees its own, and a login
// session also its descendants'. A principal whose authority the caller may
// not see is shown exactly as GET /principals shows it (its record, its
// filter: `toApiPrincipal` and the manage guard, both from routes/principals).
// The page design is card c07f9402's; this
// family is the read model and its API only. There is no MCP tool for it.
//
// Every refusal is an AccessExplorerError, a RequestFaultError whose status,
// code and message are developer-authored literals; anything else is logged
// through the secret-safe sink and answered with a fixed 503 envelope (the
// evaluation fails closed, never partially).
import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { sendApiError } from '../utils/apiErrors';
import { logCaughtFailure } from '../utils/secretSafeLog';
import { RequestFaultError } from '../utils/httpErrors';
import { accessExplorerService, objectContext, explorerViewer, type ExplorerViewer } from '../services/AccessExplorerService';
import { issuerAuthority, toApiPrincipal } from './principals';

const router = Router();

/**
 * The viewer of one request, with the management guard `GET /principals`
 * asks before it lists hidden principals (`requireManageAuthority`), so the
 * directory projection filters exactly as that list does.
 */
function viewerOf(req: AuthRequest): ExplorerViewer {
  return { ...explorerViewer(req), manage: issuerAuthority(req).canManage === true };
}

const FAILED_MESSAGE = 'The access explorer could not evaluate this read; it fails closed';

/** GET /access-explorer/objects/{type}/{id} — the object, its owner and the holders of authority on it. */
router.get('/objects/:type/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const explorer = await accessExplorerService.object(viewerOf(req), req.params.type, req.params.id);
    res.json({ success: true, explorer });
  } catch (e) {
    // AccessExplorerError is a RequestFaultError: developer-authored refusals.
    if (e instanceof RequestFaultError) {
      sendApiError(res, e.status, e.code, e.message);
      return;
    }
    const errorId = logCaughtFailure('[Access Explorer] object hop failed:', e);
    sendApiError(res, 503, 'ACCESS_EXPLORER_FAILED', FAILED_MESSAGE, undefined, { errorId });
  }
});

/** GET /access-explorer/groups/{id} — a Group's members with their tiers; optional objectType + objectId. */
router.get('/groups/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const context = objectContext(req.query as Record<string, unknown>);
    const explorer = await accessExplorerService.group(viewerOf(req), req.params.id, context);
    res.json({ success: true, explorer });
  } catch (e) {
    // AccessExplorerError is a RequestFaultError: developer-authored refusals.
    if (e instanceof RequestFaultError) {
      sendApiError(res, e.status, e.code, e.message);
      return;
    }
    const errorId = logCaughtFailure('[Access Explorer] group hop failed:', e);
    sendApiError(res, 503, 'ACCESS_EXPLORER_FAILED', FAILED_MESSAGE, undefined, { errorId });
  }
});

/** GET /access-explorer/principals/{id} — an Account's Connectors, a Connector's cap, grants, profiles and warrants. */
router.get('/principals/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const context = objectContext(req.query as Record<string, unknown>);
    const explorer = await accessExplorerService.principal(viewerOf(req), req.params.id, context, toApiPrincipal);
    res.json({ success: true, explorer });
  } catch (e) {
    // AccessExplorerError is a RequestFaultError: developer-authored refusals.
    if (e instanceof RequestFaultError) {
      sendApiError(res, e.status, e.code, e.message);
      return;
    }
    const errorId = logCaughtFailure('[Access Explorer] principal hop failed:', e);
    sendApiError(res, 503, 'ACCESS_EXPLORER_FAILED', FAILED_MESSAGE, undefined, { errorId });
  }
});

export default router;
