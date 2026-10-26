// PrincipalRoleService.ts — THE ROLE-CHANGE SEAM (owner ruling `60307311`
// §1.2; lifted for the universal change request, design ratified by owner
// ruling E325, section 3 `identity.role`; card 9ce0b0b0, train T2 slice S4).
//
// ONE seam changes one principal's role, and both doors call it: the direct
// act `POST /principals/:id/role` (an administrator login session) and the
// decision of an approved `identity.role` change (the DECIDER is the issuing
// principal). `prepare` runs the act's checks before anything is written (the
// direct door before it opens its transaction, as it always has); `apply`
// writes the role and its `principal.role.changed` ledger row inside the
// caller's transaction, so they commit together or not at all; `change` is
// the decision's door, the target read FOR UPDATE on the decide client. It
// refuses by the same codes on both doors:
//
//   - ROLE_REQUIRED / UNKNOWN_ROLE: the value is one of ASSIGNABLE_ROLES;
//   - PRINCIPAL_NOT_FOUND: the target exists;
//   - GROUP_PRINCIPAL_MANAGED_BY_GROUPS: a Group's lifecycle runs on /groups;
//   - SELF_ROLE_CHANGE_REFUSED: the issuer never changes its own role;
//   - PRINCIPAL_REFUSES_ROLE_CHANGE: the request-less internal actor;
//   - LOCAL_ADMINISTRATOR_ROLE_FIXED: the break-glass identity's role is fixed;
//   - ROLE_ABOVE_YOUR_AUTHORITY: canAssignRole(issuerRole, role), the same
//     ceiling POST /principals applies, so an elevated role (admin,
//     orchestrator) is given only by an `admin` issuer;
//   - ELEVATED_ROLE_REQUIRES_ACCOUNT: an elevated role belongs only to a
//     parentless human Account.
//
// The read caches are NOT refreshed here (the write may still roll back): the
// caller publishes the returned row with `principalService.cachePrincipal`
// after its COMMIT, exactly as the direct door always has.
import type { PoolClient } from 'pg';
import { principalService, type Principal } from './PrincipalService';
import { auditService, type AuditActor } from './AuditService';
import { ASSIGNABLE_ROLES, ELEVATED_ROLES, canAssignRole, refusesCredentials } from '../utils/credentialAuthority';
import { localAdministratorHandle } from '../config/localAdministrator';

export class RoleChangeError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** The principal the refusal is about (null when none was resolved). */
    public readonly targetId: string | null,
  ) {
    super(message);
    this.name = 'RoleChangeError';
  }
}

export interface RoleChangeInput {
  targetId: string;
  role: unknown;
  /** Who gives the role: its principal (null for none) and its resolved role. */
  issuer: { principalId: string | null; issuerRole: string };
  actor: AuditActor;
  /** The seam the ledger row names (the direct door, or the change decision). */
  seam: string;
  /** Extra ledger fields (the change decision's approval id, standing and step-up). */
  metadata?: Record<string, unknown>;
}

export interface RoleChangeResult {
  updated: Principal;
  previousRole: string | null;
}

/** The checks of the act on a target already read, without writing: the filing door reads them too. */
export function roleChangeProblem(target: { id: string; handle: string; kind: string; parentPrincipalId: string | null },
  role: string, issuer: { principalId: string | null; issuerRole: string }): RoleChangeError | null {
  if (target.kind === 'group') {
    return new RoleChangeError(422, 'GROUP_PRINCIPAL_MANAGED_BY_GROUPS',
      'This principal is a Group. A Group principal is managed only through /groups (AZ-A12 clause 2).', target.id);
  }
  if (issuer.principalId && issuer.principalId.toLowerCase() === target.id.toLowerCase()) {
    return new RoleChangeError(403, 'SELF_ROLE_CHANGE_REFUSED',
      'An administrator does not change their own role — ask another administrator.', target.id);
  }
  if (refusesCredentials(target.handle)) {
    return new RoleChangeError(422, 'PRINCIPAL_REFUSES_ROLE_CHANGE',
      `'${target.handle}' is the request-less internal actor and carries no assignable role`, target.id);
  }
  if (target.handle === localAdministratorHandle()) {
    return new RoleChangeError(422, 'LOCAL_ADMINISTRATOR_ROLE_FIXED',
      'The named local administrator is the break-glass identity; its role is fixed so the deployment always has a way back in (the same rule that refuses to disable it).',
      target.id);
  }
  if (!canAssignRole(issuer.issuerRole, role)) {
    return new RoleChangeError(403, 'ROLE_ABOVE_YOUR_AUTHORITY',
      `Cannot assign role '${role}' — it is above your own authority ('${issuer.issuerRole}').`, target.id);
  }
  if (ELEVATED_ROLES.has(role) && (target.kind !== 'human' || target.parentPrincipalId !== null)) {
    return new RoleChangeError(422, 'ELEVATED_ROLE_REQUIRES_ACCOUNT',
      `An elevated role belongs only to a parentless human Account; '${target.handle}' is a ${target.kind}${target.parentPrincipalId ? ' with a parent' : ''} (design 4d961e37 §7.1; migration 096 principals_elevated_parentless).`,
      target.id);
  }
  return null;
}

/** The role value as the act reads it: trimmed, required, one of ASSIGNABLE_ROLES. */
export function assignableRole(raw: unknown, targetId: string | null): string {
  const role = typeof raw === 'string' ? raw.trim() : '';
  if (!role) throw new RoleChangeError(400, 'ROLE_REQUIRED', 'role is required', targetId);
  if (!ASSIGNABLE_ROLES.has(role)) {
    throw new RoleChangeError(400, 'UNKNOWN_ROLE',
      `'${role}' is not a role. Assignable roles: ${[...ASSIGNABLE_ROLES].sort().join(', ')}.`, targetId);
  }
  return role;
}

/** A role change whose checks passed, ready to be written. */
export interface PreparedRoleChange {
  target: { id: string; handle: string; kind: string; parentPrincipalId: string | null };
  role: string;
  previousRole: string | null;
  issuer: { principalId: string | null; issuerRole: string };
}

export class PrincipalRoleService {
  /**
   * THE CHECKS of the act, before anything is written: the role value, the
   * target, and the act's refusals. `current` is the target row the caller
   * already holds (the decision reads it FOR UPDATE on its own client); the
   * direct door reads it as it always has, through the principal read.
   */
  async prepare(input: {
    targetId: string;
    role: unknown;
    issuer: { principalId: string | null; issuerRole: string };
    current?: { id: string; handle: string; kind: string; role: string | null; parentPrincipalId: string | null } | null;
  }): Promise<PreparedRoleChange> {
    const role = assignableRole(input.role, input.targetId);
    const found = input.current !== undefined ? input.current : await principalService.getPrincipalById(input.targetId);
    if (!found) throw new RoleChangeError(404, 'PRINCIPAL_NOT_FOUND', 'Principal not found', input.targetId);
    const target = { id: String(found.id), handle: String(found.handle), kind: String(found.kind), parentPrincipalId: found.parentPrincipalId ?? null };
    const problem = roleChangeProblem(target, role, input.issuer);
    if (problem) throw problem;
    return { target, role, previousRole: found.role ?? null, issuer: input.issuer };
  }

  /**
   * THE WRITE AND ITS LEDGER ROW, inside `client`'s transaction: the role, and
   * `principal.role.changed` with the before and after roles, the issuer's
   * role and the seam. Both commit together or neither does.
   */
  async apply(client: PoolClient, prepared: PreparedRoleChange,
    input: { actor: AuditActor; seam: string; metadata?: Record<string, unknown> }): Promise<RoleChangeResult> {
    const updated = await principalService.updatePrincipal(prepared.target.id, { role: prepared.role }, client);
    if (!updated) throw new RoleChangeError(404, 'PRINCIPAL_NOT_FOUND', 'Principal not found', prepared.target.id);
    await auditService.record({
      action: 'principal.role.changed', actor: input.actor,
      resourceType: 'principal', resourceId: updated.id,
      metadata: {
        targetHandle: updated.handle,
        before: prepared.previousRole,
        after: updated.role,
        issuerRole: prepared.issuer.issuerRole,
        seam: input.seam,
        ...(input.metadata ?? {}),
      },
    }, client);
    return { updated, previousRole: prepared.previousRole };
  }

  /**
   * CHANGE ONE PRINCIPAL'S ROLE inside `client`'s transaction (the seam of
   * section 3 `identity.role`, the decision's door): the target row read FOR
   * UPDATE on that client, the checks, then the write and its ledger row.
   */
  async change(client: PoolClient, input: RoleChangeInput): Promise<RoleChangeResult> {
    const row = (await client.query(
      'SELECT id, handle, kind, role, parent_principal_id FROM principals WHERE id = $1 FOR UPDATE', [input.targetId])).rows[0];
    const current = row ? {
      id: String(row.id), handle: String(row.handle), kind: String(row.kind), role: row.role ?? null,
      parentPrincipalId: row.parent_principal_id ? String(row.parent_principal_id) : null,
    } : null;
    const prepared = await this.prepare({ targetId: input.targetId, role: input.role, issuer: input.issuer, current });
    return this.apply(client, prepared, { actor: input.actor, seam: input.seam, metadata: input.metadata });
  }
}

export const principalRoleService = new PrincipalRoleService();
