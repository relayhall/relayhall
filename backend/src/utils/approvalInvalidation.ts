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
      RETURNING id, requesting_credential_id`,
    [credentialIds],
  );
  for (const row of lapsed.rows) {
    await queryable.query(
      `INSERT INTO approval_events (approval_id, action, actor_principal_id, actor_handle, metadata)
       VALUES ($1, 'approval.lapsed', $2, $3, $4::jsonb)`,
      [String(row.id), actor.principalId ?? null, actor.handle || 'system',
        JSON.stringify({ reason: 'CREDENTIAL_ROTATED', trigger, credentialId: String(row.requesting_credential_id) })],
    );
    await auditService.record({
      action: 'approval.lapse',
      actor: { principalId: actor.principalId ?? null, handle: actor.handle || 'system', authMethod: actor.authMethod as any },
      resourceType: 'approval', resourceId: String(row.id),
      metadata: { reason: 'CREDENTIAL_ROTATED', trigger, credentialId: String(row.requesting_credential_id) },
    }, queryable as any);
  }
  return lapsed.rows.length;
}
