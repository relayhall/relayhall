import type { AuthorizationActor, AuthorizationResource } from './AuthorizationService';
import { explicitTaskActionCaps } from './ExplicitTaskActionCaps';
/** Claim admission uses the same canonical explicit WRITE ceiling as reporting. */
export function explicitTaskWriteCaps(actor: AuthorizationActor, task: AuthorizationResource): boolean {
  return explicitTaskActionCaps(actor, task, 'write');
}
export function assignedClaimCaps(actor: AuthorizationActor, task: AuthorizationResource): boolean {
  const links = actor.delegation?.links;
  return Boolean(links && links.length > 1 && links[0].kind === 'service' && !links[0].legacyIdentity
    && explicitTaskWriteCaps(actor, task));
}
/** Server-owned assignment facts; callers cannot supply the derived role.
 * Section 6.8 (E462 S4b): a `none` Task (no Verifier by migration 170's CHECK)
 * is claimable without one; every other Task still needs an active Verifier
 * that is not the execution connector. */
export function assignedClaimBindingSql(t: string): string {
  return `EXISTS (SELECT 1 FROM services claim_service
    JOIN service_descriptor_versions claim_descriptor ON claim_descriptor.service_id=claim_service.id
      AND claim_descriptor.version=${t}.execution_descriptor_version
    JOIN principals claim_principal ON claim_principal.id=claim_service.principal_id
    LEFT JOIN principals claim_verifier ON claim_verifier.id=${t}.verifier_principal_id
    WHERE claim_service.id=${t}.execution_service_id AND claim_service.kind='connector'
      AND claim_service.status='published' AND claim_service.retired_at IS NULL
      AND claim_descriptor.retired_at IS NULL AND claim_principal.kind='service'
      AND claim_principal.status='active' AND NOT claim_principal.legacy_identity
      AND ((${t}.verification_none AND ${t}.verifier_principal_id IS NULL)
        OR (claim_verifier.status='active' AND claim_verifier.id<>claim_principal.id))
      AND jsonb_typeof(${t}.execution_profile)='object'
      AND ${t}.execution_profile->>'serviceId'=claim_service.id::text
      AND ${t}.execution_profile->>'descriptorVersion'=claim_descriptor.version::text)`;
}
export function assignedClaimEligibleSql(t: string): string {
  return `(${assignedClaimBindingSql(t)} AND ${t}.owner_principal_id IS NULL
    AND ${t}.status='todo' AND ${t}.auto_start=TRUE
    AND NOT EXISTS (SELECT 1 FROM task_dependencies cd JOIN tasks cp ON cp.id=cd.depends_on_task_id
      WHERE cd.task_id=${t}.id AND NOT COALESCE((cp.status='completed'
        OR (cp.status='archived' AND cp.archive_disposition='completed')),FALSE)))`;
}
export function assignedClaimPrincipalSql(t: string): string {
  return `(SELECT principal_id FROM services WHERE id=${t}.execution_service_id)`;
}
