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
import { grantListService, parseGrantListQuery } from '../services/GrantListService';
import { principalService } from '../services/PrincipalService';
import { auditActorFromRequest } from '../utils/auditActor';
import { authorityEditExecutor } from '../services/AuthorityEditExecutor';
import {
  auditRouteRefusal, canonicalObjectId, editorContext, editResponse, requireEditSession, sendAuthorityEditError, splitEditBody,
} from './authorityEditRoute';
import { pool } from '../db/connection';
import { StepUpError, stepUpChallengeBody, stepUpRequiredError, stepUpService } from '../services/StepUpService';
import {
  BULK_REVOKE_STEP_UP_ACTION, bulkRevokeIdSetHash, grantBulkRevokeService,
} from '../services/GrantBulkRevokeService';

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
async function withIdentities<T extends GrantRecord>(grants: T[]): Promise<Array<T & {
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
 * GET /api/grants — list grants (owner plane, root route ceiling, unchanged).
 *
 * Owner ruling E407 item 1 (card ff410dc4): every parameter is ADDITIVE.
 * Without `limit` or `cursor` the answer is the legacy list of every matching
 * grant in creation order; with either, it is ONE keyset page
 * (`pagination.nextCursor`), newest first by default. Filters: `granteeId`,
 * `resourceType`, `verb`, `made` (hand | system | unknown | all), `expiry`
 * (any | none | live | expired | expiring), `target` (any | live | archived |
 * missing | wildcard), `q` (search), `sort`. Each row carries `madeBy` (its
 * origin, from data the board already keeps) and `target` (label and state).
 * Every filter runs inside the one SQL statement, before its LIMIT.
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!checkQueryKeys(req, res, ['granteeId', 'resourceType', 'verb', 'made', 'expiry', 'target', 'q', 'sort', 'limit', 'cursor'])) return;
    const query = parseGrantListQuery(req.query as Record<string, unknown>);
    const page = await grantListService.page(query);
    const grants = await withIdentities(page.grants);
    if (query.limit === null) {
      res.json({ success: true, grants });
      return;
    }
    res.json({ success: true, grants, pagination: page.pagination, ...(page.madeCounts ? { madeCounts: page.madeCounts } : {}) });
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
    const [resolvedGrant] = await withIdentities([grant]);
    res.status(201).json({ success: true, grant: resolvedGrant });
  } catch (e) {
    if (sendGrantError(res, e)) return;
    const errorId = logGrantRouteFailure('create grant', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to create the grant', undefined, { errorId });
  }
});

/**
 * PATCH /api/grants/{id} — AZ-A13 clause 11 (ratified 2026-10-11, E95): the
 * first edit route for grants. Edits `verb`, `expiresAt` (null = no expiry)
 * and `resourceId` (null = every object of the type) IN PLACE: the row keeps
 * its id. Under the unchanged `root` ceiling (scopeMap), and session-only
 * inside the handler, so a pre-096 legacy root key cannot edit. A narrowing
 * saves; a widening takes `lifetime` and a step-up bound to ('grant.edit', id)
 * (clause 11b). Assignment-carried and act-made rows are refused (11c).
 */
router.patch('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireEditSession(req, res, 'grant'))) return;
  try {
    if (!checkQueryKeys(req, res, [])) return;
    const id = canonicalObjectId(String(req.params.id ?? ''));
    const { fields, controls } = splitEditBody(req.body);
    const result = await authorityEditExecutor.editObject({
      // The route ceiling admitted only a root session (clause 4a).
      type: 'grant', id, fields, editor: editorContext(req, 'root'),
      stepUpToken: controls.stepUpToken, lifetime: controls.lifetime, reason: controls.reason,
      narrowAgents: controls.narrowAgents, acknowledgeDependents: controls.acknowledgeDependents,
    }, auditActorFromRequest(req));
    res.json(editResponse(result));
  } catch (e) {
    if (sendAuthorityEditError(res, e)) return;
    if (sendGrantError(res, e)) return;
    const errorId = logGrantRouteFailure('edit grant', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to edit the grant', undefined, { errorId });
  }
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVOKE_STEP_UP_ACTION = 'grant.revoke';

/** A refused step-up, answered as every step-up consumer answers it (403
 * STEP_UP_REQUIRED with the SU-14 challenge) after a durable denied audit
 * naming the act. Returns false for any other error. */
async function sendStepUpRefusal(req: AuthRequest, res: Response, e: unknown, action: string, targetId: string,
  detail: Record<string, unknown>): Promise<boolean> {
  if (!(e instanceof StepUpError)) return false;
  await auditRouteRefusal(req, 'grant', targetId, e.code, { ...detail, stepUpAction: action }, action);
  res.status(e.status).json({ error: 'Refused', code: e.code, message: e.message, ...stepUpChallengeBody(e) });
  return true;
}

/**
 * POST /api/grants/bulk-revoke — owner ruling E413: revoke, in ONE audited
 * batch, the grants that change nobody's access (checked by the authorization
 * engine itself, owner ruling E407 item 3). Owner plane: the root ceiling of
 * every /grants route, and session-only here, so every bearer (a root
 * Connector included) and every MCP call is refused SESSION_ONLY. Not in the
 * MCP registry. Body { ids (at most 500 grant ids), dryRun (default true),
 * stepUpToken (required when dryRun is false: bound to ('grant.bulk_revoke',
 * the id-set hash the dry run answers), single use) }. One call is one
 * request for the rate limit.
 */
router.post('/bulk-revoke', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireEditSession(req, res, 'grant', {
    action: 'grant.bulk_revoke',
    message: 'The bulk grant revoke is a signed-in board act with a step-up (owner ruling E413): bearer credentials, root Connectors included, are refused',
  }))) return;
  let idSetHash = '';
  try {
    if (!checkQueryKeys(req, res, [])) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const allowed = ['ids', 'dryRun', 'stepUpToken'];
    for (const key of Object.keys(body)) {
      if (!allowed.includes(key)) {
        sendApiError(res, 400, 'UNKNOWN_FIELD', `Unknown field '${key}' — accepted fields are: ${allowed.join(', ')}`);
        return;
      }
    }
    const input = {
      ids: body.ids, dryRun: body.dryRun, stepUpToken: body.stepUpToken,
      principalId: String(req.principal!.id), actor: auditActorFromRequest(req),
    };
    // The binding a refused step-up names: the act's own parser and hash.
    idSetHash = bulkRevokeIdSetHash(grantBulkRevokeService.parse(input).ids);
    const answer = await grantBulkRevokeService.run(input);
    res.json({ success: true, ...answer });
  } catch (e) {
    if (await sendStepUpRefusal(req, res, e, BULK_REVOKE_STEP_UP_ACTION, idSetHash, { act: 'grant.bulk_revoke', rule: 'E413' })) return;
    if (sendGrantError(res, e)) return;
    if (e && typeof e === 'object' && (e as { code?: string }).code === '55P03') {
      sendApiError(res, 409, 'GRANTS_BUSY', 'Another grant change holds the grants table; nothing was revoked. Try again in a moment');
      return;
    }
    const errorId = logGrantRouteFailure('bulk revoke grants', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to run the bulk grant revoke; nothing was revoked', undefined, { errorId });
  }
});

/**
 * DELETE /api/grants/{id} — revoke (owner plane). Revocation is deletion:
 * grants are live authority configuration, not history (070 doctrine).
 * Owner ruling E418(b): the SAME login-session and step-up requirement as
 * PATCH on this router. A bearer (a root Connector included) is refused
 * SESSION_ONLY; a session without a live single-use step-up bound to
 * ('grant.revoke', this grant id) is refused STEP_UP_REQUIRED; both are
 * audited as denied. Body { stepUpToken }. The token is burned in the same
 * transaction as the revoke, so a refused revoke never spends it.
 */
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireEditSession(req, res, 'grant', {
    action: 'grant.revoke',
    message: 'Revoking a grant is a signed-in board act with a step-up (owner ruling E418(b)): bearer credentials, root Connectors included, are refused',
  }))) return;
  const id = canonicalObjectId(String(req.params.id ?? ''));
  try {
    if (!checkQueryKeys(req, res, [])) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(body)) {
      if (key !== 'stepUpToken') {
        sendApiError(res, 400, 'UNKNOWN_FIELD', `Unknown field '${key}' — accepted fields are: stepUpToken`);
        return;
      }
    }
    if (!UUID_PATTERN.test(id)) throw new GrantError(400, 'INVALID_GRANT_ID', 'grant id must be a full UUID');
    const token = typeof body.stepUpToken === 'string' ? body.stepUpToken : '';
    if (!token) {
      throw await stepUpRequiredError(String(req.principal!.id), REVOKE_STEP_UP_ACTION, id,
        'Revoking a grant requires a live single-use step-up bound to (grant.revoke, this grant id) (owner ruling E418(b))');
    }
    const client = await pool.connect();
    let removed: GrantRecord;
    try {
      await client.query('BEGIN');
      const stepUp = await stepUpService.consume(client, {
        token, principalId: String(req.principal!.id), action: REVOKE_STEP_UP_ACTION, targetId: id,
      });
      removed = await grantService.remove(id, auditActorFromRequest(req), client,
        { stepUp: { tokenId: stepUp.tokenId, method: stepUp.method }, rule: 'E418(b)' });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    res.json({ success: true, grant: removed });
  } catch (e) {
    if (await sendStepUpRefusal(req, res, e, REVOKE_STEP_UP_ACTION, id, { act: 'grant.revoke', rule: 'E418(b)' })) return;
    if (sendGrantError(res, e)) return;
    const errorId = logGrantRouteFailure('remove grant', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to remove the grant', undefined, { errorId });
  }
});

export default router;
