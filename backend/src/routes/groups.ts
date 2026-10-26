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
import { groupService, GroupError, canonicalGroupId } from '../services/GroupService';
import type { StepUpChallenge } from '../services/StepUpService';
import { homeGroupService, HomeGroupError } from '../services/HomeGroupService';
import { auditService } from '../services/AuditService';
import { auditActorFromRequest } from '../utils/auditActor';
import { classifyLoginSession, isLoginSessionKind } from '../utils/administratorSession';
import { auditChainFor } from '../utils/auditChain';
import { pool } from '../db/connection';
import { groupStewardService } from '../services/GroupStewardService';
import { accessExplorerService, explorerViewer } from '../services/AccessExplorerService';
import { RequestFaultError } from '../utils/httpErrors';

const router = Router();

/**
 * The Group envelope (`sendApiError`'s shape), plus, on `STEP_UP_REQUIRED`
 * re-raised from the step-up store, the SU-14 `stepUp` challenge at the top
 * level where every other step-up consumer puts it (card 72b8fb97).
 */
function sendGroupRefusal(
  res: Response, status: number, code: string, message: string,
  details: Record<string, unknown> | undefined, challenge: StepUpChallenge | null,
): void {
  if (!challenge) {
    sendApiError(res, status, code, message, undefined, details);
    return;
  }
  res.status(status).json({ success: false, error: message, code, message, ...(details ? { details } : {}), stepUp: challenge });
}

function sendGroupError(res: Response, e: unknown): boolean {
  if (e instanceof GroupError) {
    const details = { ...(e.field ? { field: e.field } : {}), ...(e.details ?? {}) };
    sendGroupRefusal(res, e.status, e.code, e.message, Object.keys(details).length > 0 ? details : undefined, e.challenge);
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

/**
 * GET /api/groups/{id}/stewards — the Group roles (LENSES-c C.3;
 * principals:read). Group roles are directory data, like membership. Each row
 * carries `live` and `inertReason` (principal_inactive, elevated_role,
 * not_a_member: the first that applies), owners first.
 */
router.get('/:id/stewards', async (req: Request, res: Response): Promise<void> => {
  try {
    const stewards = await groupStewardService.list(req.params.id);
    res.json({ success: true, stewards });
  } catch (e) {
    if (sendGroupError(res, e)) return;
    const errorId = logGroupRouteFailure('list stewards', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to list the group stewards', undefined, { errorId });
  }
});

/**
 * GET /api/groups/{id}/grants — SR-2, the team-grants read (LENSES-c C.9;
 * principals:read). A root login session sees the Group's grants in full; a
 * LIVE steward of the Group, on a login session, sees them without
 * grantedByPrincipalId; every other caller gets `200` with an empty list, the
 * catalog's convention (a 403 would disclose the surface is populated).
 */
router.get('/:id/grants', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const session = isLoginSessionKind(req.authMethod);
    const grants = await groupStewardService.groupGrants(req.params.id, {
      rootSession: session && Boolean(req.scopes?.includes('root')),
      sessionPrincipalId: session ? req.principal?.id ?? null : null,
    });
    res.json({ success: true, grants });
  } catch (e) {
    if (sendGroupError(res, e)) return;
    const errorId = logGroupRouteFailure('list group grants', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to list the group grants', undefined, { errorId });
  }
});

/**
 * GET /api/groups/{id}/members/{principalId}/access — SR-3 (LENSES v5 §6.4;
 * AZ-A12 build 6, card 1e56dbef, as LENSES-c delta LC-DD-2 directs;
 * principals:read). ONLY the authority reaching that member THROUGH this
 * Group: the Group's grants and the objects the Group owns, with the
 * member's tier, from the evaluator's Group-owner arms. A root login session
 * and a LIVE steward of the Group on a login session see it; every other
 * caller gets `200` with the empty answer (the SR-2 convention).
 */
router.get('/:id/members/:principalId/access', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const access = await accessExplorerService.memberAccess(explorerViewer(req), req.params.id, req.params.principalId);
    res.json({ success: true, access });
  } catch (e) {
    if (sendGroupError(res, e)) return;
    if (e instanceof RequestFaultError) {
      sendApiError(res, e.status, e.code, e.message);
      return;
    }
    const errorId = logGroupRouteFailure('read member access through the group', e);
    sendApiError(res, 503, 'ACCESS_EXPLORER_FAILED', 'The member access could not be evaluated', undefined, { errorId });
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

/**
 * PUT /api/groups/{id}/ownership-status — enable or disable the Group's
 * PRINCIPAL (AZ-A12 clause 2, card 20f40e40). Body: {enabled, reason,
 * stepUpToken}, all required.
 *
 * A ROOT LOGIN-SESSION act with step-up, on §5.2 rule 4's list (clause 14):
 * no administrator, operator or bearer path (DD-12). The route ceiling is the
 * /groups family's `root` (scopeMap), so an operator session stops there; a
 * bearer credential that holds root stops at the login-session test below.
 * The step-up is bound to (`group.ownership_status`, the CANONICAL lowercase
 * Group id) and is consumed only after every refusal that precedes it,
 * including "already in that state".
 *
 * Disabling suspends every ownership tier derived through the Group; it does
 * not touch membership or the Group's grants (note N3). Every refusal is
 * durably audited, outside the act's rolled-back transaction.
 */
router.put('/:id/ownership-status', async (req: AuthRequest, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const enabled = body.enabled;
  const refuse = async (
    status: number, code: string, message: string, field?: string, challenge: StepUpChallenge | null = null,
  ): Promise<void> => {
    const metadata = {
      refusal: code,
      groupId: typeof req.params.id === 'string' ? req.params.id.toLowerCase() : null,
      requested: enabled === true ? 'enable' : enabled === false ? 'disable' : null,
    };
    const record = enabled === true
      ? { action: 'group.principal_enable' }
      : enabled === false ? { action: 'group.principal_disable' } : { action: 'group.ownership_status' };
    await auditService.record({
      ...record, actor: auditActorFromRequest(req), outcome: 'denied',
      resourceType: 'group', resourceId: metadata.groupId, metadata,
    }).catch(() => undefined);
    sendGroupRefusal(res, status, code, message, field ? { field } : undefined, challenge);
  };
  try {
    for (const key of Object.keys(body)) {
      if (!['enabled', 'reason', 'stepUpToken'].includes(key)) {
        await refuse(400, 'UNKNOWN_FIELD', `Unknown field '${key}' — accepted fields are: enabled, reason, stepUpToken`);
        return;
      }
    }
    const session = classifyLoginSession(req.authMethod, "Enabling or disabling a Group's ownership");
    if (!session.ok) {
      await refuse(session.status, session.code, session.message);
      return;
    }
    if (!req.scopes?.includes('root')) {
      await refuse(403, 'ROOT_SESSION_REQUIRED', "Enabling or disabling a Group's ownership requires a root login session");
      return;
    }
    try {
      // Validation only: the act itself canonicalizes the id (lowercase)
      // before it spends the step-up, so there is ONE place that does it.
      canonicalGroupId(req.params.id);
    } catch (e) {
      if (e instanceof GroupError) {
        await refuse(e.status, e.code, e.message);
        return;
      }
      throw e;
    }
    if (typeof enabled !== 'boolean') {
      await refuse(422, 'INVALID_GROUP_VALUE', 'enabled must be a boolean', 'enabled');
      return;
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < 1 || reason.length > 500) {
      await refuse(422, 'INVALID_GROUP_VALUE', 'reason is required: 1 to 500 characters', 'reason');
      return;
    }
    if (!req.principal?.id) {
      await refuse(403, 'STEP_UP_REQUIRED', 'This act requires a step-up token minted by the acting principal (§7.6)');
      return;
    }
    const stepUpToken = typeof body.stepUpToken === 'string' ? body.stepUpToken : '';
    const changed = await groupService.setOwnershipStatus(
      req.params.id, { enabled, reason }, auditActorFromRequest(req),
      { token: stepUpToken, principalId: req.principal.id },
    );
    res.json({ success: true, group: changed.group, from: changed.from, to: changed.to });
  } catch (e) {
    if (e instanceof GroupError) {
      await refuse(e.status, e.code, e.message, e.field, e.challenge);
      return;
    }
    const errorId = logGroupRouteFailure('set ownership status', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', "Failed to change the group's ownership status", undefined, { errorId });
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

/**
 * A steward act's refusal, durably audited OUTSIDE the act's transaction
 * (which has already rolled back), so a refused act leaves a ledger row and
 * nothing else. The audit takes the refusal CODE only; the caller writes the
 * response (refuseStewardAct, or sendGroupError inside a catch).
 */
async function auditStewardRefusal(
  req: AuthRequest,
  action: 'group.steward_appoint' | 'group.steward_remove',
  standing: 'root' | 'group-owner',
  code: string,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const target = typeof req.params.principalId === 'string' ? req.params.principalId
    : typeof body.accountPrincipalId === 'string' ? body.accountPrincipalId : null;
  const metadata = {
    refusal: code,
    groupId: typeof req.params.id === 'string' ? req.params.id.toLowerCase() : null,
    accountPrincipalId: typeof target === 'string' ? target.toLowerCase() : null,
    role: typeof body.role === 'string' ? body.role : null,
    standing,
    via: 'rest',
    chain: req.principal?.id ? await auditChainFor(pool, req.principal.id) : [],
  };
  await auditService.record({
    action, actor: auditActorFromRequest(req), outcome: 'denied',
    resourceType: 'group', resourceId: metadata.groupId, metadata,
  }).catch(() => undefined);
}

/** A steward act's refusal decided before any service call: audited as
 * denied, then answered by name. */
async function refuseStewardAct(
  req: AuthRequest,
  res: Response,
  action: 'group.steward_appoint' | 'group.steward_remove',
  standing: 'root' | 'group-owner',
  refusal: { status: number; code: string; message: string },
): Promise<void> {
  await auditStewardRefusal(req, action, standing, refusal.code);
  sendApiError(res, refusal.status, refusal.code, refusal.message);
}

/** The ROOT LOGIN SESSION test shared by the two root steward acts (C.3):
 * the PUT /principals/:id/home-group precedent. Returns the refusal, if any. */
function rootSessionRefusal(req: AuthRequest, act: string): { status: number; code: string; message: string } | null {
  const session = classifyLoginSession(req.authMethod, act);
  if (!session.ok) return session;
  if (!req.scopes?.includes('root')) {
    return { status: 403, code: 'ROOT_SESSION_REQUIRED', message: `${act} requires a root login session` };
  }
  return null;
}

/**
 * POST /api/groups/{id}/stewards — appoint a Group role (LENSES-c C.3; E57).
 * Body: {accountPrincipalId, role}, both required, role owner or manager.
 *
 * A ROOT LOGIN-SESSION act. The /groups family's `root` ceiling stops every
 * non-root caller (an operator session included, DD-12); the handler then
 * refuses a bearer holding root (REQUIRES_LOGIN_SESSION), which is NARROWER
 * than the sibling /groups mutations, declared in C.3. No step-up: none is
 * ruled on the root path. Membership is not required at appointment.
 */
router.post('/:id/stewards', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const refusal = rootSessionRefusal(req, 'Appointing a Group role');
    if (refusal) { await refuseStewardAct(req, res, 'group.steward_appoint', 'root', refusal); return; }
    for (const key of Object.keys((req.body ?? {}) as Record<string, unknown>)) {
      if (!['accountPrincipalId', 'role'].includes(key)) {
        await refuseStewardAct(req, res, 'group.steward_appoint', 'root', {
          status: 400, code: 'UNKNOWN_FIELD', message: `Unknown field '${key}' — accepted fields are: accountPrincipalId, role`,
        });
        return;
      }
    }
    const steward = await groupStewardService.appoint(req.params.id, req.body ?? {}, auditActorFromRequest(req));
    res.status(201).json({ success: true, steward });
  } catch (e) {
    if (e instanceof GroupError) { await auditStewardRefusal(req, 'group.steward_appoint', 'root', e.code); sendGroupError(res, e); return; }
    const errorId = logGroupRouteFailure('appoint steward', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to appoint the group role', undefined, { errorId });
  }
});

/** DELETE /api/groups/{id}/stewards/{principalId} — remove a Group role row,
 * owner or manager, live or inert (LENSES-c C.3). A root login-session act. */
router.delete('/:id/stewards/:principalId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const refusal = rootSessionRefusal(req, 'Removing a Group role');
    if (refusal) { await refuseStewardAct(req, res, 'group.steward_remove', 'root', refusal); return; }
    const removed = await groupStewardService.removeAsRoot(req.params.id, req.params.principalId, auditActorFromRequest(req));
    res.json({ success: true, removed: { accountPrincipalId: req.params.principalId.toLowerCase(), role: removed.role } });
  } catch (e) {
    if (e instanceof GroupError) { await auditStewardRefusal(req, 'group.steward_remove', 'root', e.code); sendGroupError(res, e); return; }
    const errorId = logGroupRouteFailure('remove steward', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to remove the group role', undefined, { errorId });
  }
});

/**
 * POST /api/groups/{id}/managers — GATE (iii): a Group OWNER appoints a
 * MANAGER in that Group (LENSES-c C.4; E57 (iii); c1-B, card b5c83682). Body:
 * {accountPrincipalId, stepUpToken}. The role is fixed: a body `role` key is
 * refused UNKNOWN_FIELD, so this route never writes an owner row.
 *
 * The route ceiling is `authenticated` (its own scope rule, listed before the
 * /groups rules); the boundary is the predicate in the service, in order, in
 * one transaction: a login session; a human Account acting as itself; a LIVE
 * owner-role row on this Group; an eligible appointee (an active member, not
 * already a steward, admitted by the holder rules); and only then the
 * step-up, bound to ('group.manager_appoint', the lowercase Group id). No
 * refusal spends the token, and every refusal is audited as
 * group.steward_appoint, denied, standing group-owner. Never root's path: root
 * appoints through /stewards.
 */
router.post('/:id/managers', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(body)) {
      if (!['accountPrincipalId', 'stepUpToken'].includes(key)) {
        await refuseStewardAct(req, res, 'group.steward_appoint', 'group-owner', {
          status: 400, code: 'UNKNOWN_FIELD', message: `Unknown field '${key}' — accepted fields are: accountPrincipalId, stepUpToken`,
        });
        return;
      }
    }
    const appointed = await groupStewardService.appointManagerAsOwner(
      req.params.id,
      { accountPrincipalId: body.accountPrincipalId },
      {
        authMethod: req.authMethod,
        principalId: req.principal?.id ?? null,
        chainLength: req.delegationLinks?.length ?? 0,
      },
      typeof body.stepUpToken === 'string' ? body.stepUpToken : '',
      auditActorFromRequest(req),
    );
    res.status(201).json({ success: true, steward: appointed.steward, stepUpTokenId: appointed.stepUpTokenId });
  } catch (e) {
    if (e instanceof GroupError) { await auditStewardRefusal(req, 'group.steward_appoint', 'group-owner', e.code); sendGroupError(res, e); return; }
    const errorId = logGroupRouteFailure('appoint manager', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to appoint the manager', undefined, { errorId });
  }
});

/**
 * DELETE /api/groups/{id}/managers/{principalId} — a Group OWNER removes a
 * MANAGER row in that Group (LENSES-c C.4 removal; ruling E98 Q3). Body:
 * {stepUpToken}.
 *
 * The route ceiling is `authenticated` (its own scope rule, listed before the
 * /groups rules); the boundary is the predicate in the service, in order, in
 * one transaction: a login session; a human Account acting as itself; a LIVE
 * owner-role row on this Group; the target row (absent 404, an owner row
 * STEWARD_OWNER_ROW_ROOT_ONLY); and only then the step-up, bound to
 * ('group.manager_remove', the lowercase Group id). No refusal spends the
 * token. Never root's path: root removes through /stewards.
 */
router.delete('/:id/managers/:principalId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(body)) {
      if (key !== 'stepUpToken') {
        await refuseStewardAct(req, res, 'group.steward_remove', 'group-owner', {
          status: 400, code: 'UNKNOWN_FIELD', message: `Unknown field '${key}' — accepted fields are: stepUpToken`,
        });
        return;
      }
    }
    const removed = await groupStewardService.removeManagerAsOwner(
      req.params.id,
      req.params.principalId,
      {
        authMethod: req.authMethod,
        principalId: req.principal?.id ?? null,
        chainLength: req.delegationLinks?.length ?? 0,
      },
      typeof body.stepUpToken === 'string' ? body.stepUpToken : '',
      auditActorFromRequest(req),
    );
    res.json({
      success: true,
      removed: { accountPrincipalId: req.params.principalId.toLowerCase(), role: removed.role },
      stepUpTokenId: removed.stepUpTokenId,
    });
  } catch (e) {
    if (e instanceof GroupError) { await auditStewardRefusal(req, 'group.steward_remove', 'group-owner', e.code); sendGroupError(res, e); return; }
    const errorId = logGroupRouteFailure('remove manager', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to remove the manager', undefined, { errorId });
  }
});

export default router;
