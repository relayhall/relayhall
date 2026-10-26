/**
 * Routes for the shared-area writer list of a knowledge source (card 549cc51f;
 * owner rulings E298, E299 and E310). Mounted at `/knowledge-shared-writers`
 * through routeRegistry.ts.
 */
import { Router, Response } from 'express';
import type { AuthRequest } from '../middleware/auth';
import { filterAuthorizedResources } from '../middleware/sharedAuthorization';
import { knowledgeAccountPrincipalId } from '../services/KnowledgeArmEvaluator';
import { ROOT_SCOPE } from '../utils/scopeMap';
import { pool } from '../db/connection';
import { sendApiError } from '../utils/apiErrors';
import { logCaughtFailure } from '../utils/secretSafeLog';
import { idempotent } from '../middleware/idempotency';
import {
  knowledgeSharedWriterService, resolveSharedWriterSource, SharedWriterError, SHARED_WRITER_AUDIT_ACTIONS,
  SHARED_WRITER_AUDIT_RESOURCE_TYPE, SHARED_WRITER_SCOPE, canonicalAccountId, type SharedWriterChangeKind,
} from '../services/KnowledgeSharedWriterService';
import { StepUpError } from '../services/StepUpService';
import { auditService } from '../services/AuditService';
import { auditActorFromRequest } from '../utils/auditActor';
import { administratorSessionOf, isLoginSessionKind, SHARED_WRITER_ACT } from '../utils/administratorSession';
import { resolveActorRole } from '../utils/taskAutomationRole';

/**
 * The shared-area writer list (card 549cc51f; owner rulings E298, E299, E310),
 * mounted at `/knowledge-shared-writers`. It lives in a route module of its
 * own: routes/knowledge.ts forwards no source selector of its own (the
 * knowledge handle is the only one there), while this list is chosen by an
 * explicit `source` query parameter or body field.
 *
 *   GET  /knowledge-shared-writers          the list (services:read)
 *   POST /knowledge-shared-writers          add one Account
 *   POST /knowledge-shared-writers/remove   remove one Account
 *
 * THE GATE ON A CHANGE (E299, the F1 repair), in this order: a LOGIN SESSION
 * (a bearer credential or an API key is refused SHARED_WRITER_REQUIRES_SESSION,
 * audited, before anything is looked up); a resolved principal; then root, or an
 * administrator session through `administratorSessionOf` with SHARED_WRITER_ACT
 * (anyone else is refused SHARED_WRITER_REQUIRES_ADMINISTRATOR, audited). The
 * scope map routes the two POSTs to `authenticated` because the gate is the
 * authentication KIND plus a role, which a scope string cannot say, and because
 * an `operator` administrator holds no `root`. The service then decides the act
 * itself: Accounts only, the reason, the step-up burned in the write's own
 * transaction, the audit row and the notice.
 *
 * Both POSTs are retry-keyed and credential-scoped (`knowledge.sharedwriter.add`,
 * `knowledge.sharedwriter.remove`): a login session scopes as `user:<handle>`.
 * No path carries an id: the Account is a body field, so no route here joins the
 * non-UUID path census.
 */
export const knowledgeSharedWritersRouter = Router();

type SharedWriterStanding = 'root' | 'administrator';

/**
 * The standing a caller holds for a CHANGE (or for the administration view),
 * or the refusal to answer. A bearer is refused before root is considered, so a
 * root-holding machine credential buys nothing here.
 */
function sharedWriterStanding(req: AuthRequest):
  { ok: true; standing: SharedWriterStanding } | { ok: false; status: number; code: string; message: string } {
  const administrator = administratorSessionOf({
    authMethod: req.authMethod,
    handle: req.userId,
    principalRole: req.principal?.role ?? null,
    sessionRole: req.sessionRole ?? null,
  }, resolveActorRole, SHARED_WRITER_ACT);
  // A bearer credential, an API key or the reports key: refused before root is
  // considered, with the act's own code and a sentence naming the login session
  // (administratorSessionOf answers exactly that for every non-login kind).
  if (!isLoginSessionKind(req.authMethod)) {
    return administrator.ok
      ? { ok: false, status: 403, code: SHARED_WRITER_ACT.requiresSession, message: 'A login session is required' }
      : administrator;
  }
  if (!req.principal?.id) {
    return { ok: false, status: 403, code: 'PRINCIPAL_REQUIRED', message: 'This act requires a resolved principal identity' };
  }
  if (req.scopes?.includes(ROOT_SCOPE)) return { ok: true, standing: 'root' };
  if (administrator.ok) return { ok: true, standing: 'administrator' };
  return administrator;
}

/** The refusals this family answers itself: typed, instanceof-guarded, literal text. */
function sendSharedWriterError(res: Response, e: unknown): boolean {
  if (e instanceof SharedWriterError || e instanceof StepUpError) {
    res.status(e.status).json({
      success: false, error: 'Refused', code: e.code, message: e.message,
      ...(e instanceof SharedWriterError && e.field ? { field: e.field } : {}),
      ...(e instanceof StepUpError && e.challenge ? { stepUp: e.challenge } : {}),
    });
    return true;
  }
  return false;
}

/** A gate refusal, audited as denied before it answers. */
async function refuseSharedWriterGate(req: AuthRequest, res: Response, kind: SharedWriterChangeKind,
  refusal: { status: number; code: string; message: string }): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  await auditService.record({
    action: SHARED_WRITER_AUDIT_ACTIONS[kind], actor: auditActorFromRequest(req), outcome: 'denied',
    resourceType: SHARED_WRITER_AUDIT_RESOURCE_TYPE, resourceId: canonicalAccountId(body.accountId),
    metadata: { refusal: refusal.code, authMethod: req.authMethod ?? 'unknown', scope: SHARED_WRITER_SCOPE },
  }).catch(() => undefined);
  res.status(refusal.status).json({ success: false, error: 'Refused', code: refusal.code, message: refusal.message });
}

knowledgeSharedWritersRouter.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const view = req.query.view;
    if (view !== undefined && view !== 'administration') {
      sendApiError(res, 400, 'SHARED_WRITER_INVALID', "view must be 'administration' when it is given", 'view');
      return;
    }
    const administration = view === 'administration';
    if (administration) {
      const standing = sharedWriterStanding(req);
      if (!standing.ok) {
        res.status(standing.status).json({ success: false, error: 'Refused', code: standing.code, message: standing.message });
        return;
      }
    }
    const source = await resolveSharedWriterSource(pool, req.query.source);
    // The source row through the shared predicate, as GET /knowledge-sources
    // composes it: a source the caller cannot see is concealed.
    const visible = await filterAuthorizedResources(req, 'read', [source], (row) => ({ type: 'service', id: row.id }));
    if (!visible.length) {
      sendApiError(res, 404, 'SHARED_WRITER_SOURCE_NOT_FOUND', 'No such knowledge source');
      return;
    }
    const { writers, youCanWrite } = await knowledgeSharedWriterService.list(source, knowledgeAccountPrincipalId(req));
    res.json({
      success: true,
      source,
      scope: SHARED_WRITER_SCOPE,
      writers: administration ? writers : writers.map(({ accountId, label }) => ({ accountId, label })),
      youCanWrite,
    });
  } catch (e) {
    if (sendSharedWriterError(res, e)) return;
    const errorId = logCaughtFailure('list shared-area writers', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to list the shared-area writers', undefined, { errorId });
  }
});

async function changeSharedWriters(req: AuthRequest, res: Response, kind: SharedWriterChangeKind): Promise<void> {
  try {
    const standing = sharedWriterStanding(req);
    if (!standing.ok) {
      await refuseSharedWriterGate(req, res, kind, standing);
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await knowledgeSharedWriterService.change(kind, {
      source: body.source,
      accountId: body.accountId,
      reason: body.reason,
      ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
      stepUpToken: body.stepUpToken,
      principalId: String(req.principal?.id),
      actor: auditActorFromRequest(req),
      standing: standing.standing,
    });
    res.json({ success: true, action: kind, ...result });
  } catch (e) {
    if (sendSharedWriterError(res, e)) return;
    const errorId = logCaughtFailure(`change the shared-area writers (${kind})`, e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to change the shared-area writers', undefined, { errorId });
  }
}

knowledgeSharedWritersRouter.post('/', idempotent('knowledge.sharedwriter.add'),
  (req: AuthRequest, res: Response) => changeSharedWriters(req, res, 'add'));
knowledgeSharedWritersRouter.post('/remove', idempotent('knowledge.sharedwriter.remove'),
  (req: AuthRequest, res: Response) => changeSharedWriters(req, res, 'remove'));
