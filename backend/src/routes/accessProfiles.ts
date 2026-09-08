// accessProfiles.ts — Access profile administration (RH-P3.AZ-S2, design
// 4d961e37 §4/§9.2, A17.4). MUTATION IS OWNER-PLANE (§9.1): every non-GET
// /access-profiles method routes to the root sentinel in the scope map.
// LISTINGS ride principals:read (§9.1 introspection). The what-if preview
// discloses ANOTHER principal's authority and is owner-plane (root),
// listed before /:id in both router and scope map so the literal segment
// never resolves as a profile id. The SELF preview lives at
// GET /principals/me/effective-access on the principals router.
import { logCaughtFailure } from '../utils/secretSafeLog';
import { Router, Request, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { sendApiError } from '../utils/apiErrors';
import { accessProfileService, AccessProfileError } from '../services/AccessProfileService';
import { auditActorFromRequest } from '../utils/auditActor';

const router = Router();

function sendAccessProfileError(res: Response, e: unknown): boolean {
  if (e instanceof AccessProfileError) {
    sendApiError(res, e.status, e.code, e.message, undefined, e.field ? { field: e.field } : undefined);
    return true;
  }
  return false;
}

function logAccessProfileRouteFailure(context: string, e: unknown): string {
  return logCaughtFailure(`[AccessProfiles API] ${context} failed:`, e);
}

function checkBodyKeys(req: Request, res: Response, allowed: string[]): Record<string, unknown> | null {
  const body = (req.body ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      sendApiError(res, 400, 'UNKNOWN_FIELD', `Unknown field '${key}' — accepted fields are: ${allowed.join(', ')}`);
      return null;
    }
  }
  return body;
}

/** GET /api/access-profiles — list (principals:read). */
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    const profiles = await accessProfileService.list();
    res.json({ success: true, profiles });
  } catch (e) {
    if (sendAccessProfileError(res, e)) return;
    const errorId = logAccessProfileRouteFailure('list profiles', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to list access profiles', undefined, { errorId });
  }
});

/** GET /api/access-profiles/what-if?principalId= — owner-plane preview of
 * ANOTHER principal's effective object authority (root; §9.5). */
router.get('/what-if', async (req: Request, res: Response): Promise<void> => {
  try {
    const principalId = req.query.principalId;
    if (typeof principalId !== 'string') {
      sendApiError(res, 400, 'INVALID_QUERY_VALUE', 'principalId query parameter is required');
      return;
    }
    const access = await accessProfileService.effectiveAccess(principalId);
    res.json({ success: true, access });
  } catch (e) {
    if (sendAccessProfileError(res, e)) return;
    const errorId = logAccessProfileRouteFailure('what-if preview', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to compute the preview', undefined, { errorId });
  }
});

/** GET /api/access-profiles/{id} — one profile (principals:read). */
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const profile = await accessProfileService.get(req.params.id);
    res.json({ success: true, profile });
  } catch (e) {
    if (sendAccessProfileError(res, e)) return;
    const errorId = logAccessProfileRouteFailure('read profile', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to read the access profile', undefined, { errorId });
  }
});

/** GET /api/access-profiles/{id}/versions — immutable history (principals:read). */
router.get('/:id/versions', async (req: Request, res: Response): Promise<void> => {
  try {
    const versions = await accessProfileService.versions(req.params.id);
    res.json({ success: true, versions });
  } catch (e) {
    if (sendAccessProfileError(res, e)) return;
    const errorId = logAccessProfileRouteFailure('list versions', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to list versions', undefined, { errorId });
  }
});

/** GET /api/access-profiles/{id}/assignments — (principals:read). */
router.get('/:id/assignments', async (req: Request, res: Response): Promise<void> => {
  try {
    const assignments = await accessProfileService.assignments(req.params.id);
    res.json({ success: true, assignments });
  } catch (e) {
    if (sendAccessProfileError(res, e)) return;
    const errorId = logAccessProfileRouteFailure('list assignments', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to list assignments', undefined, { errorId });
  }
});

/** GET /api/access-profiles/{id}/events — append-only provenance (root). */
router.get('/:id/events', async (req: Request, res: Response): Promise<void> => {
  try {
    const limitRaw = req.query.limit === undefined ? 100 : Number(req.query.limit);
    if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 500) {
      sendApiError(res, 400, 'INVALID_QUERY_VALUE', 'limit must be an integer between 1 and 500');
      return;
    }
    const events = await accessProfileService.events(req.params.id, limitRaw);
    res.json({ success: true, events });
  } catch (e) {
    if (sendAccessProfileError(res, e)) return;
    const errorId = logAccessProfileRouteFailure('list events', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to list profile events', undefined, { errorId });
  }
});

/** POST /api/access-profiles — create (owner plane). */
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = checkBodyKeys(req, res, ['name', 'description']);
    if (!body) return;
    const profile = await accessProfileService.create(body, auditActorFromRequest(req));
    res.status(201).json({ success: true, profile });
  } catch (e) {
    if (sendAccessProfileError(res, e)) return;
    const errorId = logAccessProfileRouteFailure('create profile', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to create the access profile', undefined, { errorId });
  }
});

/** PATCH /api/access-profiles/{id} — rename / redescribe (owner plane). */
router.patch('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = checkBodyKeys(req, res, ['name', 'description']);
    if (!body) return;
    const profile = await accessProfileService.update(req.params.id, body, auditActorFromRequest(req));
    res.json({ success: true, profile });
  } catch (e) {
    if (sendAccessProfileError(res, e)) return;
    const errorId = logAccessProfileRouteFailure('update profile', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to update the access profile', undefined, { errorId });
  }
});

/** DELETE /api/access-profiles/{id} — never-used drafts only (owner plane). */
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await accessProfileService.remove(req.params.id, auditActorFromRequest(req));
    res.json({ success: true });
  } catch (e) {
    if (sendAccessProfileError(res, e)) return;
    const errorId = logAccessProfileRouteFailure('delete profile', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to delete the access profile', undefined, { errorId });
  }
});

/** POST /api/access-profiles/{id}/versions — create an immutable version
 * carrying selector→verbs rules (owner plane). */
router.post('/:id/versions', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = checkBodyKeys(req, res, ['rules']);
    if (!body) return;
    const version = await accessProfileService.createVersion(req.params.id, body.rules, auditActorFromRequest(req));
    res.status(201).json({ success: true, version });
  } catch (e) {
    if (sendAccessProfileError(res, e)) return;
    const errorId = logAccessProfileRouteFailure('create version', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to create the version', undefined, { errorId });
  }
});

/** POST /api/access-profiles/{id}/publish — transactional publish-swap
 * (owner plane). The pointer only moves forward (§4). */
router.post('/:id/publish', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = checkBodyKeys(req, res, ['versionId']);
    if (!body) return;
    const profile = await accessProfileService.publish(req.params.id, body.versionId, auditActorFromRequest(req));
    res.json({ success: true, profile });
  } catch (e) {
    if (sendAccessProfileError(res, e)) return;
    const errorId = logAccessProfileRouteFailure('publish version', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to publish the version', undefined, { errorId });
  }
});

/** POST /api/access-profiles/{id}/assignments — assign (owner plane; T35 +
 * the AZ-S2 parented-assignee guard live in the service). */
router.post('/:id/assignments', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = checkBodyKeys(req, res, ['assigneeType', 'assigneeId']);
    if (!body) return;
    const assignment = await accessProfileService.assign(req.params.id, body, auditActorFromRequest(req));
    res.status(201).json({ success: true, assignment });
  } catch (e) {
    if (sendAccessProfileError(res, e)) return;
    const errorId = logAccessProfileRouteFailure('assign profile', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to assign the profile', undefined, { errorId });
  }
});

/** DELETE /api/access-profiles/{id}/assignments/{assignmentId} — unassign
 * (owner plane; one delete, effective immediately — AZ-4). */
router.delete('/:id/assignments/:assignmentId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await accessProfileService.unassign(req.params.id, req.params.assignmentId, auditActorFromRequest(req));
    res.json({ success: true });
  } catch (e) {
    if (sendAccessProfileError(res, e)) return;
    const errorId = logAccessProfileRouteFailure('unassign profile', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to unassign the profile', undefined, { errorId });
  }
});

export default router;
