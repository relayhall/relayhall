// routes/approvals.ts — the /approvals surface (RH-P3.AZ-S4, card
// aa48fb12; AUTHZ design 4d961e37 §6.1, §9.1/§9.2; A17.11; T7/T8).
//
// BOARD-ONLY (T7): the approval act executes ONLY here — the board's
// authenticated human surface — after step-up. There is no
// reply-to-approve in any chat channel; the notification deep link (T8)
// carries no authority and lands on the login wall. Bearer credentials are
// refused on the whole surface (their half of the flow lives at
// /delegation/agent-mints: request and collect).
//
// SELF-SCOPE ARM (§6.1/AZ-16): an authenticated Account sees and decides
// only items whose SUBJECT (the requester) lies in its own subtree —
// 404-concealed outside it; root retains the full view. Deciding consumes
// a SINGLE-USE step-up token bound to ('approval.decide', approvalId).
//
// AZ-A9 (ratified 2026-10-10, E43; card 785e1eed P1-B and P1-B-2). Grant- and
// credential-kind items are decided HERE too, by root OR an administrator login
// session (clause 6, E15): the administrator half is `administratorSessionOf`
// with APPROVAL_DECIDE_ACT. By E43 Q1 that administrator arm covers EVERY kind
// decided here, agent-mint included: an administrator session sees and decides
// every item, beside §6.1's deciders for agent-mint (the owning Account over its
// own subtree, and root), which stay; the decision audit records which of the
// three decided (D-02). A non-administrator owning Account still LISTS its own
// subtree's items and is refused APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR when it
// decides a grant or credential item. The approve body gains `editedExpiresAt`
// (clause 8) and, for a credential request, `editedTransport`; `GET /approvals`
// gains `?kind=` beside `?status=` (clause 9), and both reads say what the
// viewer may decide (`viewer`), so a surface never offers a refused act.
//
// THE HUB VIEW (card b1e3b16d): `GET /approvals?view=hub` is the approvals
// hub's read — the same self-scoped list plus the skill-review adapter and the
// verification requests waiting on a verifier (read-only, never decidable), each
// item with refs, ownership, deciders and decidable (ApprovalHubService). It is
// opt-in: without `view` the response is exactly what it was. No route is
// added: the only mutating routes here stay approve and deny, and whether a
// session may decide is ONE function, `approvalDeciderStanding`, which `decide`
// below calls and the hub reports.
//
// THE UNIVERSAL CHANGE REQUEST, slice S2 (card 502fb19e; design ratified by
// owner ruling E325, sections 4, 5, 6 and 9.2). Three routes join, none of
// them a decision route: `POST /approvals/requests` is the SESSION door for
// filing a change (a person files as its own Account; the bearer door stays
// `/delegation/access-requests`), `GET /approvals/requests/preview` answers
// "what may I request here" and writes nothing, and `POST /approvals/:id/withdraw`
// lets the filing session lapse its own pending request. For kind `change` the
// self-scope gains the scoped-decider arm (section 5.6: an item is visible to
// the owner of every object it names, 404 elsewhere), and who decides is the
// ordered predicate of section 5.1, `changeDeciderArm`, run on the locked row:
// root, an administrator login session, or the owner tier of section 5.2.
import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import {
  approvalService, ApprovalError, APPROVAL_KINDS, ADMINISTRATOR_DECIDED_KINDS,
  type ApprovalKind, type ApprovalRecord,
} from '../services/ApprovalService';
import { AgentMintError } from '../services/AgentMintService';
import { StepUpError, stepUpChallengeBody } from '../services/StepUpService';
import { credentialLifecycleService } from '../services/CredentialLifecycleService';
import { auditService } from '../services/AuditService';
import { requireSessionViewer, type SessionViewer } from './warrants';
import { auditActorFromRequest } from '../utils/auditActor';
import { logCaughtFailure } from '../utils/secretSafeLog';
import {
  APPROVAL_DECIDE_ACT, APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR, CHANGE_REQUEST_ACT, administratorSessionOf,
} from '../utils/administratorSession';
import {
  changeEventsForRequester, changeRecordForRequester, changeRequestService, CHANGE_SESSION_FILING_FIELDS, type ChangeDeciderRequest,
} from '../services/ChangeRequestService';
import { resolveActorRole } from '../utils/taskAutomationRole';
import {
  approvalHubService, approvalDeciderStanding, HUB_KINDS, HUB_STATUS_FILTERS, isHubGroupFilter,
  type HubKind, type HubStatusFilter,
} from '../services/ApprovalHubService';
import { actorFromRequest } from '../middleware/sharedAuthorization';

const router = Router();

function sendApprovalError(res: Response, e: unknown): boolean {
  if (e instanceof ApprovalError || e instanceof AgentMintError || e instanceof StepUpError) {
    res.status(e.status).json({
      error: 'Refused', code: e.code, message: e.message,
      // AZ-A9 clause 11: {rule, subject, clause} on every AZ-A9 refusal.
      ...(e instanceof ApprovalError && e.refusal ? e.refusal : {}),
      // Card 7a99d63e (SU-14): what to step up for, on STEP_UP_REQUIRED.
      ...stepUpChallengeBody(e),
    });
    return true;
  }
  return false;
}

/** The session viewer plus its AZ-A9 standing: is it an ADMINISTRATOR login
 * session (clause 6)? The predicate is the one the role and password acts use,
 * with the decide act's own codes. */
interface ApprovalsViewer extends SessionViewer {
  administrator: ReturnType<typeof administratorSessionOf>;
  /** The server-derived authentication kind ('session' | 'dashboard_jwt'). */
  authMethod: string | null;
}

async function requireApprovalsViewer(req: AuthRequest, res: Response): Promise<ApprovalsViewer | null> {
  const viewer = await requireSessionViewer(req, res, 'approval');
  if (!viewer) return null;
  const administrator = administratorSessionOf({
    authMethod: req.authMethod,
    handle: req.userId,
    principalRole: req.principal?.role ?? null,
    sessionRole: req.sessionRole ?? null,
  }, resolveActorRole, APPROVAL_DECIDE_ACT);
  return { ...viewer, administrator, authMethod: req.authMethod ?? null };
}

/** The deciding session as the change-request decider arm reads it (section 5.1). */
function changeViewer(viewer: ApprovalsViewer): { principalId: string; isRoot: boolean; administratorOk: boolean; authMethod: string | null } {
  return { principalId: viewer.principalId, isRoot: viewer.isRoot, administratorOk: viewer.administrator.ok, authMethod: viewer.authMethod };
}

/** E325 sections 3 and 7.1 (T2 S5): the deciding session's own facts, every one server-derived, for the executor's direct predicate. */
function changeDeciderRequestOf(req: AuthRequest): ChangeDeciderRequest {
  return {
    authorization: req.authorizationActor ?? actorFromRequest(req),
    principalId: req.principal?.id ?? null, handle: req.userId ?? '', authMethod: req.authMethod,
    principalRole: req.principal?.role ?? null, sessionRole: req.sessionRole ?? null,
    scopes: req.scopes ?? [], sessionId: req.sessionId ?? null, credentialId: req.credentialId ?? null,
  };
}

/** §6.1 self-scope: the requester is the viewer or lies in its subtree. */
async function inOwnSubtree(viewer: ApprovalsViewer, approval: ApprovalRecord): Promise<boolean> {
  const requesterPrincipalId = approval.requesterPrincipalId;
  if (requesterPrincipalId === viewer.principalId) return true;
  return credentialLifecycleService.isDescendant(viewer.principalId, requesterPrincipalId);
}

async function concealForeign(viewer: ApprovalsViewer, approval: ApprovalRecord): Promise<boolean> {
  if (viewer.isRoot) return false;
  // AZ-A9 clause 6 (E43 Q1): an administrator session has the full view of
  // the kinds it decides — every kind. A non-administrator keeps the
  // self-scope arm below.
  if (viewer.administrator.ok && ADMINISTRATOR_DECIDED_KINDS.includes(approval.kind)) return false;
  if (approval.kind === 'change') {
    // E325 section 5.6: the SAME self-scope text `list` reads, the scoped-decider
    // arm included, so a scoped decider reads exactly the items it lists.
    return !(await approvalService.visibleTo(
      { principalId: viewer.principalId, isRoot: viewer.isRoot, isAdministrator: viewer.administrator.ok }, approval.id));
  }
  return !(await inOwnSubtree(viewer, approval));
}

/** What this session may decide, for the surface that offers the controls
 * (P1-B review nice-to-have 4): root, or an administrator session, decides
 * every kind; any other session decides only the agent-mint items of its own
 * subtree (§6.1), and is refused grant and credential items. */
function viewerStanding(viewer: ApprovalsViewer): { isRoot: boolean; isAdministrator: boolean } {
  return { isRoot: viewer.isRoot, isAdministrator: viewer.administrator.ok };
}

// GET /approvals — the queue, self-scoped; ?status= and ?kind= filter.
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const viewer = await requireApprovalsViewer(req, res);
  if (!viewer) return;
  try {
    if (req.query.view !== undefined) {
      await listHub(req, res, viewer);
      return;
    }
    const statusFilter = typeof req.query.status === 'string'
      && ['pending', 'approved', 'denied', 'collected', 'lapsed'].includes(req.query.status)
      ? req.query.status : undefined;
    const kindFilter = typeof req.query.kind === 'string'
      && (APPROVAL_KINDS as readonly string[]).includes(req.query.kind)
      ? req.query.kind as ApprovalKind : undefined;
    const standing = { principalId: viewer.principalId, isRoot: viewer.isRoot, isAdministrator: viewer.administrator.ok };
    // AZ-A9 clause 7: grant-kind rows carry each row as the decider reads it
    // (object titles for a decider, "every current and future object of this
    // type" for all-of-type). Agent-mint rows are returned unchanged.
    const found = await approvalService.list(standing, statusFilter, kindFilter);
    // E325 section 6: a change item its requester lists carries the field diff only, never the decider.
    const listed = await Promise.all(found.map(async (approval) => (
      approval.kind === 'change' && await changeRequestService.requesterSideOf(viewer.principalId, approval)
        ? changeRecordForRequester(approval) : approval)));
    res.json({
      success: true,
      approvals: listed.some((approval) => approval.accessRequest)
        ? await approvalService.describeAccessRequests(listed, standing)
        : listed,
      viewer: viewerStanding(viewer),
    });
  } catch (e) {
    if (sendApprovalError(res, e)) return;
    const errorId = logCaughtFailure('[Approvals API] list failed:', e);
    res.status(500).json({ error: 'Internal Server Error', code: 'APPROVAL_LIST_FAILED', message: 'Failed to list approvals', errorId });
  }
});

const refuseFilter = (res: Response, message: string): void => {
  res.status(400).json({ error: 'Bad Request', code: 'APPROVAL_FILTER_INVALID', message });
};

/**
 * `GET /approvals?view=hub[&status=pending|decided|all][&kind=][&group=]` —
 * the approvals hub (card b1e3b16d). A value outside each grammar is a 400,
 * never a silently wider list.
 */
async function listHub(req: AuthRequest, res: Response, viewer: ApprovalsViewer): Promise<void> {
  if (req.query.view !== 'hub') { refuseFilter(res, 'view must be hub'); return; }
  const status = req.query.status === undefined ? 'pending' : req.query.status;
  if (typeof status !== 'string' || !(HUB_STATUS_FILTERS as readonly string[]).includes(status)) {
    refuseFilter(res, `status must be one of ${HUB_STATUS_FILTERS.join(', ')}`);
    return;
  }
  const kind = req.query.kind;
  if (kind !== undefined && (typeof kind !== 'string' || !HUB_KINDS.includes(kind))) {
    refuseFilter(res, `kind must be one of ${HUB_KINDS.join(', ')}`);
    return;
  }
  const group = req.query.group;
  if (group !== undefined && (typeof group !== 'string' || !isHubGroupFilter(group))) {
    refuseFilter(res, 'group must be shared, private, board or a Group id');
    return;
  }
  const approvals = await approvalHubService.list({
    principalId: viewer.principalId,
    isRoot: viewer.isRoot,
    administratorOk: viewer.administrator.ok,
    principalKind: req.principal?.kind ?? null,
    scopes: req.scopes ?? null,
    actor: req.authorizationActor ?? actorFromRequest(req),
    authMethod: viewer.authMethod,
  }, {
    status: status as HubStatusFilter,
    kind: kind as HubKind | undefined,
    group: group as string | undefined,
  });
  res.json({ success: true, view: 'hub', approvals });
}

// GET /approvals/:id — one approval with its event ledger.
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const viewer = await requireApprovalsViewer(req, res);
  if (!viewer) return;
  try {
    const approval = await approvalService.get(req.params.id);
    if (await concealForeign(viewer, approval)) {
      res.status(404).json({ error: 'Refused', code: 'APPROVAL_NOT_FOUND', message: 'No such approval' });
      return;
    }
    // AZ-A9 clause 7: for a grant-kind item and a DECIDER (root or an
    // administrator session), `decision` is what the decider sees, as data;
    // the audit trail is `events`. Agent-mint items answer exactly as before.
    if ((approval.kind ?? 'agent-mint') === 'agent-mint') {
      res.json({ success: true, approval, events: await approvalService.events(approval.id), viewer: viewerStanding(viewer) });
      return;
    }
    const standing = {
      principalId: viewer.principalId, isRoot: viewer.isRoot, isAdministrator: viewer.administrator.ok,
      // clause 11 (credential kind): the ceiling is what THIS session may put
      // on a credential, read from its own scope set.
      scopes: req.scopes ?? [],
    };
    const [described] = await approvalService.describeAccessRequests([approval], standing);
    // E325 section 6: a change carries its before/after view (field diff,
    // relationship edges, summary) and whether THIS session decides it. Its
    // REQUESTER reads the field diff only: the relationship diff, the
    // decider's id and standing and the decision's ledger metadata are withheld.
    const decision = approval.kind === 'change'
      ? await changeRequestService.decisionContext(approval, changeViewer(viewer))
      : await approvalService.accessRequestDecisionContext(approval, standing);
    const requesterView = approval.kind === 'change' && decision?.view === 'requester';
    const events = await approvalService.events(approval.id);
    res.json({
      success: true,
      approval: requesterView ? changeRecordForRequester(described) : described,
      events: requesterView ? changeEventsForRequester(events, approval.requesterPrincipalId) : events,
      decision,
      viewer: viewerStanding(viewer),
    });
  } catch (e) {
    if (sendApprovalError(res, e)) return;
    const errorId = logCaughtFailure('[Approvals API] get failed:', e);
    res.status(500).json({ error: 'Internal Server Error', code: 'APPROVAL_READ_FAILED', message: 'Failed to read the approval', errorId });
  }
});

async function decide(req: AuthRequest, res: Response, decision: 'approve' | 'deny'): Promise<void> {
  const viewer = await requireApprovalsViewer(req, res);
  if (!viewer) return;
  try {
    const approval = await approvalService.get(req.params.id);
    if (await concealForeign(viewer, approval)) {
      res.status(404).json({ error: 'Refused', code: 'APPROVAL_NOT_FOUND', message: 'No such approval' });
      return;
    }
    // E325 section 5.1 (2), section 12 Q20 (a): for EVERY kind, the decider is
    // an active, non-legacy Account acting as itself — the collect-time rule,
    // applied at decide, before the step-up is spent.
    if (!(await approvalService.deciderLive(viewer.principalId))) {
      await auditService.record({
        action: 'approval.decide', actor: auditActorFromRequest(req), outcome: 'denied',
        resourceType: 'approval', resourceId: approval.id,
        metadata: { refusal: 'DECIDER_NO_LONGER_ADMITTED', kind: approval.kind, subject: 'decider', clause: 'change requests section 5.1', decision },
      }).catch(() => undefined);
      res.status(403).json({
        error: 'Refused', code: 'DECIDER_NO_LONGER_ADMITTED',
        message: 'the deciding Account is not an active, non-legacy Account acting as itself',
        rule: 'the decider is live at decide', subject: 'decider', clause: 'change requests section 5.1', kind: approval.kind,
      });
      return;
    }
    // AZ-A9 clause 6: a grant or credential request is decided by root or an
    // administrator login session. Refused BEFORE the step-up is consumed,
    // with the act's own code and a durable audit (§5.2 r8).
    // The rule is ONE function, shared with the hub's `decidable`.
    const standing = approvalDeciderStanding(
      { isRoot: viewer.isRoot, administratorOk: viewer.administrator.ok }, approval.kind ?? 'agent-mint',
      // E325 section 5.1: a change on a root-ceiling target is decided by a root session only.
      approval.change?.targetType ?? null);
    let deciderStanding: 'root' | 'administrator' | undefined;
    // D-02 (E43 Q1): an agent-mint item is decided by root, the owning
    // Account over its own subtree (§6.1), or an administrator session; the
    // decision audit records which. concealForeign above has already admitted
    // exactly these three.
    let mintDeciderStanding: 'root' | 'owner' | 'administrator' | undefined;
    if ((approval.kind ?? 'agent-mint') === 'agent-mint') {
      mintDeciderStanding = viewer.isRoot ? 'root' : (await inOwnSubtree(viewer, approval)) ? 'owner' : 'administrator';
    } else if (approval.kind === 'change') {
      // E325 section 5.1: the ordered predicate runs on the locked row in the
      // decide transaction (root, an administrator login session, or the owner
      // tier); every refusal there rolls the step-up's consumption back.
    } else {
      if (standing === 'root' || standing === 'administrator') {
        deciderStanding = standing;
      } else {
        // Fail closed: a refusal here always carries the act's own code,
        // even were the standing function ever to refuse an administrator.
        const refusal = viewer.administrator.ok
          ? { status: 403, code: APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR, message: 'Deciding a grant or credential request requires root or an administrator login session' }
          : viewer.administrator;
        await auditService.record({
          action: 'approval.decide', actor: auditActorFromRequest(req), outcome: 'denied',
          resourceType: 'approval', resourceId: approval.id,
          metadata: {
            refusal: refusal.code, kind: approval.kind, subject: 'decider', clause: 'AZ-A9 clause 6',
            decision, requesterPrincipalId: approval.requesterPrincipalId,
          },
        }).catch(() => undefined);
        res.status(refusal.status).json({
          error: 'Refused', code: refusal.code, message: refusal.message,
          rule: 'the decider is root or an administrator login session with a step-up bound to approval.decide',
          subject: 'decider', clause: 'AZ-A9 clause 6', kind: approval.kind,
        });
        return;
      }
    }
    const decided = await approvalService.decide({
      approvalId: req.params.id,
      decision,
      editedScopes: decision === 'approve' ? req.body?.editedScopes : undefined,
      editedRules: decision === 'approve' ? req.body?.editedRules : undefined,
      // AZ-A9 clause 8 (read for grant/credential kinds only).
      editedExpiresAt: decision === 'approve' ? req.body?.editedExpiresAt : undefined,
      editedGranteePrincipalId: decision === 'approve' ? req.body?.editedGranteePrincipalId : undefined,
      editedKind: decision === 'approve' ? req.body?.editedKind : undefined,
      // clauses 8 and 13 (credential kind): narrow the pin from any.
      editedTransport: decision === 'approve' ? req.body?.editedTransport : undefined,
      editedTargetPrincipalId: decision === 'approve' ? req.body?.editedTargetPrincipalId : undefined,
      // AZ-A13 clauses 6d and 6j (kind authority-edit): the lifetime of the
      // approved widening, and the object, present only to be refused.
      lifetime: decision === 'approve' ? req.body?.lifetime : undefined,
      editedObject: decision === 'approve' ? req.body?.editedObject : undefined,
      // E325 section 5.4 (kind change): the narrowed change, field by field.
      editedChange: decision === 'approve' ? req.body?.editedChange : undefined,
      denialReason: decision === 'deny' ? req.body?.reason : undefined,
      deciderPrincipalId: viewer.principalId,
      deciderStanding,
      deciderViewer: approval.kind === 'change' ? changeViewer(viewer) : undefined,
      deciderRequest: approval.kind === 'change' ? changeDeciderRequestOf(req) : undefined,
      // clause 11 (credential kind): the decider session's scope set NOW.
      deciderScopes: req.scopes ?? [],
      mintDeciderStanding,
      stepUpToken: typeof req.body?.stepUpToken === 'string' ? req.body.stepUpToken : '',
    }, auditActorFromRequest(req));
    res.json({ success: true, approval: decided });
  } catch (e) {
    if (sendApprovalError(res, e)) return;
    const errorId = logCaughtFailure(`[Approvals API] ${decision} failed:`, e);
    res.status(500).json({ error: 'Internal Server Error', code: 'APPROVAL_DECIDE_FAILED', message: `Failed to ${decision} the approval`, errorId });
  }
}

/** The session's FILING standing (section 4.1 rows 1-2): a root session, or an administrator login session. */
function filingSession(req: AuthRequest, viewer: ApprovalsViewer): { isRoot: boolean; administratorOk: boolean; authMethod: string | null } {
  const administrator = administratorSessionOf({
    authMethod: req.authMethod,
    handle: req.userId,
    principalRole: req.principal?.role ?? null,
    sessionRole: req.sessionRole ?? null,
  }, resolveActorRole, CHANGE_REQUEST_ACT);
  return { isRoot: viewer.isRoot, administratorOk: administrator.ok, authMethod: viewer.authMethod };
}

// POST /approvals/requests — FILE a change request on the SESSION door (E325
// section 9.2): a person files as its own Account, with its session's standing.
// Not retry-keyed (section 12 Q10 (a)): a repeated filing converges on
// CHANGE_PENDING naming the caller's own request.
router.post('/requests', async (req: AuthRequest, res: Response): Promise<void> => {
  const viewer = await requireApprovalsViewer(req, res);
  if (!viewer) return;
  try {
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body as Record<string, unknown> : {};
    const unknown = Object.keys(body).filter((field) => !(CHANGE_SESSION_FILING_FIELDS as readonly string[]).includes(field)).sort();
    if (unknown.length > 0 || (body.kind !== undefined && body.kind !== 'change')) {
      res.status(422).json({
        error: 'Refused', code: 'UNKNOWN_FIELD',
        message: unknown.length > 0 ? `Unknown change-request fields: ${unknown.join(', ')}` : 'the session door files kind change only',
        rule: `a session filing carries only: ${CHANGE_SESSION_FILING_FIELDS.join(', ')}`, subject: 'requester', clause: 'change requests section 9.2',
      });
      return;
    }
    const approval = await approvalService.requestChangeOnSession({
      requesterPrincipalId: viewer.principalId,
      authorizationActor: req.authorizationActor ?? actorFromRequest(req),
      session: filingSession(req, viewer),
      targetType: body.targetType, targetId: body.targetId, change: body.change,
      granteePrincipalId: body.granteePrincipalId, granteeType: body.granteeType,
      reason: body.reason, lifetime: body.lifetime, relatedTaskId: body.relatedTaskId, relatedPhaseId: body.relatedPhaseId,
    }, auditActorFromRequest(req));
    res.status(202).json({ success: true, approval: await approvalService.requesterView(approval) });
  } catch (e) {
    if (sendApprovalError(res, e)) return;
    const errorId = logCaughtFailure('[Approvals API] change request failed:', e);
    res.status(500).json({ error: 'Internal Server Error', code: 'CHANGE_REQUEST_FAILED', message: 'Failed to file the change request', errorId });
  }
});

// GET /approvals/requests/preview — "what may I request here" (E325 section
// 4.3): ?targetType=&targetId= or ?objectType=&targetId=, with an optional
// granteePrincipalId, granteeType and sourceId. Writes nothing: no audit row,
// no approval, no quota count.
router.get('/requests/preview', async (req: AuthRequest, res: Response): Promise<void> => {
  const viewer = await requireApprovalsViewer(req, res);
  if (!viewer) return;
  try {
    const q = req.query;
    const one = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
    const preview = await approvalService.previewChange({
      requesterPrincipalId: viewer.principalId, requestingCredentialId: null,
      authorizationActor: req.authorizationActor ?? actorFromRequest(req),
      door: 'session', session: filingSession(req, viewer),
      targetType: one(q.targetType), targetId: one(q.targetId), objectType: one(q.objectType), sourceId: one(q.sourceId),
      granteePrincipalId: one(q.granteePrincipalId), granteeType: one(q.granteeType),
    });
    res.json({ success: true, ...preview });
  } catch (e) {
    if (sendApprovalError(res, e)) return;
    const errorId = logCaughtFailure('[Approvals API] change request preview failed:', e);
    res.status(500).json({ error: 'Internal Server Error', code: 'CHANGE_REQUEST_PREVIEW_FAILED', message: 'Failed to preview change requests', errorId });
  }
});

// POST /approvals/:id/withdraw — the filing session lapses its OWN pending
// change request, reason WITHDRAWN (E325 section 9.2). Anything else answers
// exactly as an absent id.
router.post('/:id/withdraw', async (req: AuthRequest, res: Response): Promise<void> => {
  const viewer = await requireApprovalsViewer(req, res);
  if (!viewer) return;
  try {
    const approval = await approvalService.withdrawAccessRequest(
      { approvalId: req.params.id, requesterPrincipalId: viewer.principalId }, auditActorFromRequest(req));
    res.json({ success: true, approval: await approvalService.requesterView(approval) });
  } catch (e) {
    if (sendApprovalError(res, e)) return;
    const errorId = logCaughtFailure('[Approvals API] withdraw failed:', e);
    res.status(500).json({ error: 'Internal Server Error', code: 'APPROVAL_WITHDRAW_FAILED', message: 'Failed to withdraw the request', errorId });
  }
});

// POST /approvals/:id/approve — approve, possibly EDITED DOWN (§6.1):
// body may carry editedScopes / editedRules within the request, for a grant
// or credential request editedExpiresAt no later than the requested expiry,
// and for a credential request editedTransport narrowed from any (AZ-A9
// clauses 8 and 13). For an edit request (kind authority-edit, AZ-A13):
// editedScopes is the full approved scope set (a subset of the requested
// one that keeps what the credential holds), and `lifetime` is required:
// {choice: 'keep'} or {choice: 'until-task', taskId?, revertAt?}.
router.post('/:id/approve', (req: AuthRequest, res: Response) => decide(req, res, 'approve'));

// POST /approvals/:id/deny — deny with an optional reason.
router.post('/:id/deny', (req: AuthRequest, res: Response) => decide(req, res, 'deny'));

export default router;
