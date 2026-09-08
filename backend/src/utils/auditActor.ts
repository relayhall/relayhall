import type { AuthRequest } from '../middleware/auth';
import type { AuditActor } from '../services/AuditService';

export function auditActorFromRequest(req: AuthRequest): AuditActor {
  return {
    principalId: req.principal?.id ?? null,
    handle: req.principal?.handle ?? req.userId ?? 'unknown',
    authMethod: req.authMethod ?? 'unknown',
    credentialId: req.credentialId ?? null,
  };
}
