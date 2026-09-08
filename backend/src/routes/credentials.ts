import { auditService } from '../services/AuditService';
import { auditChainFor } from '../utils/auditChain';
import { pool } from '../db/connection';
import { logCaughtFailure } from '../utils/secretSafeLog';
// Credential lifecycle (spec b48bb799 §3.3): revoke and rotate.
// Issuance and listing hang off the owning principal in routes/principals.ts;
// these two act on a credential by id because that is how an operator holds
// them — from a listing, or from an incident.
import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { principalService, isMissingRelationError, CredentialPolicyError } from '../services/PrincipalService';
import { credentialLifecycleService, CredentialLifecycleError } from '../services/CredentialLifecycleService';
import { StepUpError } from '../services/StepUpService';
import { resolveActorRole } from '../utils/taskAutomationRole';
import { resolveIssuerAuthority } from '../utils/credentialAuthority';
import { auditActorFromRequest } from '../utils/auditActor';
import { isBearerCredentialKind, isLoginSessionKind } from '../utils/administratorSession';

const router = Router();

function sendCredentialLifecycleError(res: Response, err: unknown): boolean {
  if (err instanceof CredentialLifecycleError || err instanceof CredentialPolicyError || err instanceof StepUpError) {
    res.status(err.status).json({ error: 'Refused', code: err.code, message: err.message });
    return true;
  }
  return false;
}

// POST /credentials/:id/reveal — encrypted re-reveal (AZ-S3, design §7.1/
// §7.2, AZ-20/T16/T20/T30): bearer callers only within their own
// descendant lineage; session callers under a single-use step-up token
// bound to exactly this reveal. Graced/revoked/expired never reveal.
router.post('/:id/reveal', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // NO blanket manage gate here (review 94aad5aa B2): reveal dispatches
    // by AUTHENTICATION KIND per §7.1 —
    //   bearer      → presenting-credential lineage + authority ceiling;
    //   session     → own-subtree (404-concealed outside) + single-use
    //                 step-up; a ROOT session may target any credential,
    //                 still under step-up.
    // The service enforces every arm; the route only classifies the caller.
    if (!req.principal?.id) {
      res.status(403).json({ error: 'Forbidden', code: 'PRINCIPAL_REQUIRED', message: 'Reveal requires a resolved principal identity' });
      return;
    }
    const revealed = await credentialLifecycleService.reveal(req.params.id, {
      principalId: req.principal.id,
      handle: req.principal.handle,
      isRootSession: Boolean(req.scopes?.includes('root')) && !isBearerCredentialKind(req.authMethod),
      viaBearer: isBearerCredentialKind(req.authMethod),
      presentingScopes: req.scopes ?? [],
      stepUpToken: typeof req.body?.stepUpToken === 'string' ? req.body.stepUpToken : null,
    }, auditActorFromRequest(req));
    res.json({ success: true, token: revealed.token });
  } catch (err) {
    if (sendCredentialLifecycleError(res, err)) return;
    if (isMissingRelationError(err)) {
      res.status(503).json({ error: 'Service Unavailable', message: 'Identity substrate is not migrated yet' });
      return;
    }
    const errorId = logCaughtFailure('[Credentials API] reveal failed:', err);
    res.status(500).json({ error: 'Internal Server Error', code: 'REVEAL_FAILED', message: 'Failed to reveal the credential', errorId });
  }
});

function requireManageAuthority(req: AuthRequest, res: Response) {
  const authority = resolveIssuerAuthority({
    scopes: req.scopes,
    role: resolveActorRole({
      handle: req.userId || '',
      principalRole: req.principal?.role ?? null,
      sessionRole: req.sessionRole ?? null,
    }),
  });
  if (!authority.canManage) {
    res.status(403).json({ error: 'Forbidden', message: authority.reason || 'Not permitted' });
    return null;
  }
  return authority;
}

// POST /credentials/:id/revoke — effective on the very next request, because
// authenticateCbKey filters on revoked_at IS NULL per call with no caching.
router.post('/:id/revoke', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const existing = await principalService.getCredentialWithPrincipal(req.params.id);
    // §9.2/§9.3 (RH-P3.AZ-S5): revocation is SELF-SERVICE inside the
    // caller's OWN DESCENDANT subtree — a bearer Connector retiring the
    // Agents it minted (relayhall_agent_revoke), or a session Account
    // retiring credentials under its own identities. The protective
    // direction needs no owner-plane authority; everything else keeps the
    // manage gate, and a caller outside the lineage learns nothing beyond
    // the refusal.
    // Any credential kind this product recognises — both families, both
    // named by the shared seam rather than by three literals here.
    const selfServiceCaller = isBearerCredentialKind(req.authMethod)
      || isLoginSessionKind(req.authMethod);
    const inSubtree = selfServiceCaller && existing && req.principal?.id
      ? await credentialLifecycleService.isDescendant(req.principal.id, String(existing.principal.id))
      : false;
    if (!inSubtree && !requireManageAuthority(req, res)) return;
    if (!existing) {
      res.status(404).json({ error: 'Not Found', message: 'Credential not found' });
      return;
    }
    if (existing.credential.revokedAt) {
      // Idempotent: re-revoking is a no-op, not an error. An operator racing
      // an incident should not have to care whether they already did this.
      res.json({ success: true, alreadyRevoked: true });
      return;
    }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : 'manual_revoke';
    if (!reason || reason.length > 500) {
      res.status(400).json({ error: 'Bad Request', message: 'reason must be between 1 and 500 characters' });
      return;
    }
    await principalService.revokeCredentialById(req.params.id, reason, auditActorFromRequest(req));
    console.log('[Credentials API] credential revoked');
    res.json({ success: true, revoked: true });
  } catch (err) {
    if (isMissingRelationError(err)) {
      res.status(503).json({ error: 'Service Unavailable', message: 'Identity substrate is not migrated yet' });
      return;
    }
    const errorId = logCaughtFailure('[Credentials API] revoke failed:', err);
    res.status(500).json({ error: 'Internal Server Error', code: 'CREDENTIAL_REVOKE_FAILED', message: 'Failed to revoke credential', errorId });
  }
});

// POST /credentials/:id/rotate — mint a replacement with the same label and
// scopes, and put the old key on a bounded grace window so an in-flight
// consumer is not cut off mid-request.
router.post('/:id/rotate', async (req: AuthRequest, res: Response): Promise<void> => {
  // §5.2 rule 8 (review e5e437a0 B2): every rotation REFUSAL is a durable
  // denied audit with the affected chain when the credential resolves.
  const auditRotateDenial = async (refusal: string): Promise<void> => {
    let principalId: string | null = null;
    try {
      const found = await principalService.getCredentialWithPrincipal(req.params.id);
      principalId = found?.principal.id ?? null;
    } catch { principalId = null; }
    await auditService.record({
      action: 'credential.rotate', actor: auditActorFromRequest(req), outcome: 'denied',
      resourceType: 'credential', resourceId: req.params.id,
      metadata: { refusal, chain: principalId ? await auditChainFor(pool, principalId) : [] },
    }).catch(() => undefined);
  };
  // §7.3 (sol r2-F1): rotation is an EXACT COPY — a rotation request
  // attempting ANY scope or transport change is refused.
  {
    const forbidden = ['scopes', 'transport', 'label'].filter((field) => req.body && field in req.body);
    if (forbidden.length > 0) {
      await auditRotateDenial('ROTATION_IS_EXACT_COPY');
      res.status(422).json({ error: 'Unprocessable Entity', code: 'ROTATION_IS_EXACT_COPY', message: `Rotation inherits ${forbidden.join('/')} verbatim (design 4d961e37 §7.3) — narrowing happens through the principal-level own() expression` });
      return;
    }
  }
  if (!requireManageAuthority(req, res)) return;
  try {
    const existing = await principalService.getCredentialWithPrincipal(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Not Found', message: 'Credential not found' });
      return;
    }
    // Revoked/graced sources refuse through the TYPED service policy
    // (409 ROTATE_FROM_RETIRED — §7.3, review 87fec3e2 B4); no untyped
    // pre-check shadows it here.
    if (existing.principal.status !== 'active') {
      await auditRotateDenial('PRINCIPAL_NOT_ACTIVE');
      res.status(400).json({
        error: 'Bad Request',
        message: 'Cannot rotate a credential for a disabled principal',
      });
      return;
    }

    // §7.3 (review 87fec3e2 B4): the 0–7d bound is a CONTRACT, not a
    // clamp — out-of-range or non-numeric input refuses typed.
    let graceHours = 24;
    if (req.body?.graceHours !== undefined) {
      const parsed = Number(req.body.graceHours);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 168) {
        await auditRotateDenial('INVALID_GRACE');
        res.status(422).json({ error: 'Unprocessable Entity', code: 'INVALID_GRACE', message: 'graceHours must be a number between 0 and 168 (§7.3)' });
        return;
      }
      graceHours = parsed;
    }

    const issued = await principalService.rotateCredential(req.params.id, graceHours, auditActorFromRequest(req));
    if (!issued) {
      res.status(404).json({ error: 'Not Found', message: 'Credential not found' });
      return;
    }
    console.log('[Credentials API] credential rotated');
    res.status(201).json({
      success: true,
      id: issued.credentialId,
      keyId: issued.keyId,
      secretOnce: issued.fullKey,
      previousKeyId: existing.credential.keyId,
      graceHours,
      warning: 'This is the only time the full key is shown. Store it now.',
    });
  } catch (err) {
    if (isMissingRelationError(err)) {
      res.status(503).json({ error: 'Service Unavailable', message: 'Identity substrate is not migrated yet' });
      return;
    }
    // Service-thrown CredentialPolicyError refusals are audited durably in
    // the service itself (review a9e0e07d B2); the route does not re-audit
    // them, avoiding duplicate ledger rows.
    if (sendCredentialLifecycleError(res, err)) return;
    const errorId = logCaughtFailure('[Credentials API] rotate failed:', err);
    res.status(500).json({ error: 'Internal Server Error', code: 'CREDENTIAL_ROTATE_FAILED', message: 'Failed to rotate credential', errorId });
  }
});

export default router;
