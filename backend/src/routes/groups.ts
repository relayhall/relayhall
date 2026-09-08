// groups.ts — Group administration (RH-P3.AZ-S1, design 4d961e37 §3/§9.2,
// A17.6). MUTATION IS OWNER-PLANE (§9.1, T13): the scope map routes every
// non-GET /groups method to the root sentinel, exactly like /grants —
// group self-escalation by an agent credential dies at the route ceiling.
// INTROSPECTION rides principals:read: group listings are directory
// disclosure in the A12.5 sense. The directory-sync status read is
// operator telemetry and stays behind root with the mutation surface.
import { logCaughtFailure } from '../utils/secretSafeLog';
import { Router, Request, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { sendApiError } from '../utils/apiErrors';
import { groupService, GroupError } from '../services/GroupService';
import { homeGroupService, HomeGroupError } from '../services/HomeGroupService';
import { auditActorFromRequest } from '../utils/auditActor';

const router = Router();

function sendGroupError(res: Response, e: unknown): boolean {
  if (e instanceof GroupError) {
    sendApiError(res, e.status, e.code, e.message, undefined, e.field ? { field: e.field } : undefined);
    return true;
  }
  return false;
}

function logGroupRouteFailure(context: string, e: unknown): string {
  return logCaughtFailure(`[Groups API] ${context} failed:`, e);
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

/** GET /api/groups — list groups (principals:read). */
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    const groups = await groupService.list();
    res.json({ success: true, groups });
  } catch (e) {
    if (sendGroupError(res, e)) return;
    const errorId = logGroupRouteFailure('list groups', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to list groups', undefined, { errorId });
  }
});

/** GET /api/groups/directory-sync — AZ-30 staleness read (root; listed
 * before /:id so the literal segment never resolves as a group id). */
router.get('/directory-sync', async (_req: Request, res: Response): Promise<void> => {
  try {
    const providers = await groupService.syncStatus();
    res.json({ success: true, providers });
  } catch (e) {
    if (sendGroupError(res, e)) return;
    const errorId = logGroupRouteFailure('read sync status', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to read directory-sync status', undefined, { errorId });
  }
});

/** GET /api/groups/{id} — one group (principals:read). */
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const group = await groupService.get(req.params.id);
    res.json({ success: true, group });
  } catch (e) {
    if (sendGroupError(res, e)) return;
    const errorId = logGroupRouteFailure('read group', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to read the group', undefined, { errorId });
  }
});

/** GET /api/groups/{id}/members — kind-differentiated members (principals:read). */
router.get('/:id/members', async (req: Request, res: Response): Promise<void> => {
  try {
    const members = await groupService.members(req.params.id);
    res.json({ success: true, members });
  } catch (e) {
    if (sendGroupError(res, e)) return;
    const errorId = logGroupRouteFailure('list members', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to list group members', undefined, { errorId });
  }
});

/** POST /api/groups — create (owner plane). */
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = checkBodyKeys(req, res, ['name', 'description']);
    if (!body) return;
    const group = await groupService.create(body, auditActorFromRequest(req));
    res.status(201).json({ success: true, group });
  } catch (e) {
    if (sendGroupError(res, e)) return;
    const errorId = logGroupRouteFailure('create group', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to create the group', undefined, { errorId });
  }
});

/**
 * PATCH /api/groups/{id} — rename / redescribe / feature (owner plane).
 *
 * RH-LENSES-b (design 96f0bd3d s7.1): `featured` is presentation-level
 * promotion. It grants nothing; it decides which Groups a person may choose as
 * a home group, and it is audited as `group.feature_set` with old and new.
 *
 * Binding fields are NOT written here. They receive the service's named
 * refusal (409 DIRECTORY_BINDING_MANAGED); use the directory group reference
 * catalog to create a binding within its carriage transaction.
 */
router.patch('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = checkBodyKeys(req, res,
      ['name', 'description', 'identityProviderId', 'externalGroupRef', 'featured']);
    if (!body) return;
    const group = await groupService.update(req.params.id, body, auditActorFromRequest(req));
    res.json({ success: true, group });
  } catch (e) {
    if (sendGroupError(res, e)) return;
    const errorId = logGroupRouteFailure('update group', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to update the group', undefined, { errorId });
  }
});

/** DELETE /api/groups/{id} — delete an EMPTY group; its grant rows go with
 * it in the same transaction (owner plane). */
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const group = await groupService.remove(req.params.id, auditActorFromRequest(req));
    res.json({ success: true, group });
  } catch (e) {
    if (sendGroupError(res, e)) return;
    const errorId = logGroupRouteFailure('delete group', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to delete the group', undefined, { errorId });
  }
});

/**
 * DELETE /api/groups/{id}/home-pointers — the ROOT-PLANE CLEAR ACT
 * (RH-LENSES-b, design 96f0bd3d s7.2; acceptance A-L38).
 *
 * `GroupService.remove` refuses a Group that is anyone's home pointer, by name
 * and by count. This is the act that makes that refusal actionable: every
 * pointer at this Group cleared in ONE transaction, one audited
 * `home_group.clear` per Account. The operator removes the dependency
 * deliberately, and the removal is itself in the ledger.
 */
router.delete('/:id/home-pointers', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await homeGroupService.clearPointersToGroup(req.params.id, auditActorFromRequest(req));
    res.json({ success: true, cleared: result.cleared });
  } catch (e) {
    if (e instanceof HomeGroupError) {
      sendApiError(res, e.status, e.code, e.message);
      return;
    }
    if (sendGroupError(res, e)) return;
    const errorId = logGroupRouteFailure('clear home pointers', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to clear the home pointers', undefined, { errorId });
  }
});

/** POST /api/groups/{id}/members — add an Account member (owner plane, T13). */
router.post('/:id/members', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = checkBodyKeys(req, res, ['accountPrincipalId', 'source']);
    if (!body) return;
    const member = await groupService.addMember(req.params.id, body, auditActorFromRequest(req));
    res.status(201).json({ success: true, member });
  } catch (e) {
    if (sendGroupError(res, e)) return;
    const errorId = logGroupRouteFailure('add member', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to add the member', undefined, { errorId });
  }
});

/** DELETE /api/groups/{id}/members/{principalId} — remove a member (owner plane). */
router.delete('/:id/members/:principalId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await groupService.removeMember(req.params.id, req.params.principalId, auditActorFromRequest(req));
    res.json({ success: true });
  } catch (e) {
    if (sendGroupError(res, e)) return;
    const errorId = logGroupRouteFailure('remove member', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to remove the member', undefined, { errorId });
  }
});

export default router;
