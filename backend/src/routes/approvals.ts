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
import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { approvalService, ApprovalError } from '../services/ApprovalService';
import { AgentMintError } from '../services/AgentMintService';
import { stepUpService, StepUpError } from '../services/StepUpService';
import { credentialLifecycleService } from '../services/CredentialLifecycleService';
import { requireSessionViewer, type SessionViewer } from './warrants';
import { auditActorFromRequest } from '../utils/auditActor';
import { logCaughtFailure } from '../utils/secretSafeLog';
import { pool } from '../db/connection';

const router = Router();

function sendApprovalError(res: Response, e: unknown): boolean {
  if (e instanceof ApprovalError || e instanceof AgentMintError || e instanceof StepUpError) {
    res.status(e.status).json({ error: 'Refused', code: e.code, message: e.message });
    return true;
  }
  return false;
}

async function concealForeign(viewer: SessionViewer, requesterPrincipalId: string): Promise<boolean> {
  if (viewer.isRoot) return false;
  if (requesterPrincipalId === viewer.principalId) return false;
  return !(await credentialLifecycleService.isDescendant(viewer.principalId, requesterPrincipalId));
}

// GET /approvals — the queue, self-scoped; ?status= filters.
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const viewer = await requireSessionViewer(req, res, 'approval');
  if (!viewer) return;
  try {
    const statusFilter = typeof req.query.status === 'string'
      && ['pending', 'approved', 'denied', 'collected', 'lapsed'].includes(req.query.status)
      ? req.query.status : undefined;
    res.json({ success: true, approvals: await approvalService.list(viewer, statusFilter) });
  } catch (e) {
    if (sendApprovalError(res, e)) return;
    const errorId = logCaughtFailure('[Approvals API] list failed:', e);
    res.status(500).json({ error: 'Internal Server Error', code: 'APPROVAL_LIST_FAILED', message: 'Failed to list approvals', errorId });
  }
});

// GET /approvals/:id — one approval with its event ledger.
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const viewer = await requireSessionViewer(req, res, 'approval');
  if (!viewer) return;
  try {
    const approval = await approvalService.get(req.params.id);
    if (await concealForeign(viewer, approval.requesterPrincipalId)) {
      res.status(404).json({ error: 'Refused', code: 'APPROVAL_NOT_FOUND', message: 'No such approval' });
      return;
    }
    res.json({ success: true, approval, events: await approvalService.events(approval.id) });
  } catch (e) {
    if (sendApprovalError(res, e)) return;
    const errorId = logCaughtFailure('[Approvals API] get failed:', e);
    res.status(500).json({ error: 'Internal Server Error', code: 'APPROVAL_READ_FAILED', message: 'Failed to read the approval', errorId });
  }
});

async function decide(req: AuthRequest, res: Response, decision: 'approve' | 'deny'): Promise<void> {
  const viewer = await requireSessionViewer(req, res, 'approval');
  if (!viewer) return;
  try {
    const approval = await approvalService.get(req.params.id);
    if (await concealForeign(viewer, approval.requesterPrincipalId)) {
      res.status(404).json({ error: 'Refused', code: 'APPROVAL_NOT_FOUND', message: 'No such approval' });
      return;
    }
    const stepUpToken = typeof req.body?.stepUpToken === 'string' ? req.body.stepUpToken : '';
    const stepUp = await stepUpService.consume(pool, {
      token: stepUpToken,
      principalId: viewer.principalId,
      action: 'approval.decide',
      targetId: req.params.id,
    });
    const decided = await approvalService.decide({
      approvalId: req.params.id,
      decision,
      editedScopes: decision === 'approve' ? req.body?.editedScopes : undefined,
      editedRules: decision === 'approve' ? req.body?.editedRules : undefined,
      denialReason: decision === 'deny' ? req.body?.reason : undefined,
      deciderPrincipalId: viewer.principalId,
      stepUp,
    }, auditActorFromRequest(req));
    res.json({ success: true, approval: decided });
  } catch (e) {
    if (sendApprovalError(res, e)) return;
    const errorId = logCaughtFailure(`[Approvals API] ${decision} failed:`, e);
    res.status(500).json({ error: 'Internal Server Error', code: 'APPROVAL_DECIDE_FAILED', message: `Failed to ${decision} the approval`, errorId });
  }
}

// POST /approvals/:id/approve — approve, possibly EDITED DOWN (§6.1):
// body may carry editedScopes / editedRules within the request.
router.post('/:id/approve', (req: AuthRequest, res: Response) => decide(req, res, 'approve'));

// POST /approvals/:id/deny — deny with an optional reason.
router.post('/:id/deny', (req: AuthRequest, res: Response) => decide(req, res, 'deny'));

export default router;
