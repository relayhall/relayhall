// approvalInvalidation.ts — the AZ-31c binding hook (RH-P3.AZ-S4;
// AUTHZ design 4d961e37 §6.1, A17.11, T27).
//
// Every Approval binds to the EXACT requesting credential id. When that
// credential is REVOKED, EXPIRES, or ENTERS ROTATION GRACE, every
// outstanding pending/approved Approval bound to it is INVALIDATED —
// status lapsed, audited reason CREDENTIAL_ROTATED (the ratified reason
// token for all three exits; the metadata carries the precise trigger).
// The successor credential must re-request: approve-after-rotate → refuse
// holds BY CONSTRUCTION, not by a later check alone.
//
// This lives outside ApprovalService so PrincipalService (rotation,
// revocation) and CredentialLifecycleService (terminate) can call it
// without an import cycle. It is transaction-aware: pass the client so the
// lapse commits or rolls back WITH the credential mutation.
import { auditService } from '../services/AuditService';

interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

export async function invalidateApprovalsForCredentials(
  queryable: Queryable,
  credentialIds: string[],
  trigger: 'rotated' | 'revoked' | 'expired',
  actor: { principalId?: string | null; handle: string; authMethod: string },
): Promise<number> {
  if (credentialIds.length === 0) return 0;
  const lapsed = await queryable.query(
    `UPDATE approvals
        SET status = 'lapsed', lapse_reason = 'CREDENTIAL_ROTATED', updated_at = NOW()
      WHERE requesting_credential_id = ANY($1::uuid[])
        AND status IN ('pending', 'approved')
        -- AZ-A9 clause 1 (migration 142): an approved GRANT request is
        -- terminal — its effect is the grant rows it already wrote on the
        -- Account, which the requester's credential never carried. Only its
        -- pending sibling lapses here; the one-way trigger refuses the rest.
        AND NOT (kind = 'grant' AND status = 'approved')
        -- AZ-A13 clause 6f (migration 148): an approved EDIT request is
        -- terminal too — its effect is the edit it applied to the credential
        -- in place, and the one-way trigger refuses to move it. Its pending
        -- sibling lapses here: rotating the bound credential lapses the
        -- request, which is correct, because the target is that credential.
        AND NOT (kind = 'authority-edit' AND status = 'approved')
        -- Card 502fb19e (migration 158): an approved CHANGE whose effect core
        -- applied at decide is terminal as well; an approved two-step change
        -- that waits for its collect lapses with its filing credential.
        AND NOT (kind = 'change' AND status = 'approved' AND applied_at IS NOT NULL)
      RETURNING id, requesting_credential_id, kind`,
    [credentialIds],
  );
  for (const row of lapsed.rows) {
    // AZ-A9 clause 14: a non-mint row's lapse carries its kind. An agent-mint
    // row's metadata is unchanged (clause 16) — an absent kind IS agent-mint.
    const kind = row.kind && row.kind !== 'agent-mint' ? { kind: String(row.kind) } : {};
    await queryable.query(
      `INSERT INTO approval_events (approval_id, action, actor_principal_id, actor_handle, metadata)
       VALUES ($1, 'approval.lapsed', $2, $3, $4::jsonb)`,
      [String(row.id), actor.principalId ?? null, actor.handle || 'system',
        JSON.stringify({ reason: 'CREDENTIAL_ROTATED', trigger, credentialId: String(row.requesting_credential_id), ...kind })],
    );
    await auditService.record({
      action: 'approval.lapse',
      actor: { principalId: actor.principalId ?? null, handle: actor.handle || 'system', authMethod: actor.authMethod as any },
      resourceType: 'approval', resourceId: String(row.id),
      metadata: { reason: 'CREDENTIAL_ROTATED', trigger, credentialId: String(row.requesting_credential_id), ...kind },
    }, queryable as any);
  }
  return lapsed.rows.length;
}

/**
 * The account-status seam's lapse (universal change request, E325 section 3
 * `identity.status` and section 7.4; card 9ce0b0b0 S4): when an Account is
 * disabled, every PENDING request naming it as the grantee — a change for it,
 * or a grant request whose rows would land on it — lapses GRANTEE_DISABLED in
 * the same transaction, instead of waiting for decide to find a dead grantee.
 * A Group grantee is never matched (a Group's status runs on /groups). Answers
 * the lapsed ids.
 */
export async function lapseApprovalsForDisabledGrantee(
  queryable: Queryable,
  principalId: string,
  actor: { principalId?: string | null; handle: string; authMethod: string },
): Promise<string[]> {
  const lapsed = await queryable.query(
    `UPDATE approvals
        SET status = 'lapsed', lapse_reason = 'GRANTEE_DISABLED', updated_at = NOW()
      WHERE grantee_principal_id = $1 AND status = 'pending'
        AND (grantee_type IS NULL OR grantee_type = 'principal')
      RETURNING id, kind`,
    [principalId],
  );
  const ids: string[] = [];
  for (const row of lapsed.rows) {
    // AZ-A9 clause 14: a non-mint row's lapse carries its kind.
    const kind = row.kind && row.kind !== 'agent-mint' ? { kind: String(row.kind) } : {};
    const metadata = { reason: 'GRANTEE_DISABLED', trigger: 'account-disabled', granteePrincipalId: principalId, ...kind };
    await queryable.query(
      `INSERT INTO approval_events (approval_id, action, actor_principal_id, actor_handle, metadata)
       VALUES ($1, 'approval.lapsed', $2, $3, $4::jsonb)`,
      [String(row.id), actor.principalId ?? null, actor.handle || 'system', JSON.stringify(metadata)],
    );
    await auditService.record({
      action: 'approval.lapse',
      actor: { principalId: actor.principalId ?? null, handle: actor.handle || 'system', authMethod: actor.authMethod as any },
      resourceType: 'approval', resourceId: String(row.id), metadata,
    }, queryable as any);
    ids.push(String(row.id));
  }
  return ids.sort();
}
