/**
 * THE DISPLAY HALF of the administrator-session predicate.
 *
 * The AUTHORITY is `backend/src/utils/administratorSession.ts`: the server
 * decides who may change a role, refuses by name, and audits the refusal. This
 * module decides only whether to RENDER the control — a drift between the two
 * lists could hide a control from someone entitled to it, or show one that
 * would be refused, and could never confer authority on anybody.
 *
 * It is nevertheless pinned to the backend list by
 * `backend/src/__tests__/administratorSessionSeam.test.ts`, which reads THIS
 * file and compares the two sets: a comment asking the next editor to keep two
 * lists in step is not a control, and the drill that reads both files is.
 */

/** Mirrors `ROLE_ACT_ISSUER_ROLES` in the backend seam. */
export const ROLE_ACT_ISSUER_ROLES = ['admin', 'operator', 'orchestrator'];

/** Mirrors `ASSIGNABLE_ROLES` in `backend/src/utils/credentialAuthority.ts`. */
export const ASSIGNABLE_ROLES = [
  'admin', 'operator', 'editor', 'user', 'viewer',
  'orchestrator', 'reviewer', 'qa', 'agent',
];

/**
 * Whether to offer the role control to this viewer.
 *
 * The `root` scope stands in for the role when a principal row could not be
 * read — the same fallback the page's own `isRoot` uses — because a session
 * holding `root` is by construction at or above every role in the list.
 */
export function mayChangeRoles(
  role: string | null | undefined,
  scopes: string[] | null | undefined,
): boolean {
  if (Array.isArray(scopes) && scopes.includes('root')) return true;
  return typeof role === 'string' && ROLE_ACT_ISSUER_ROLES.includes(role);
}

/**
 * Which roles THIS issuer may assign — the display half of `canAssignRole`.
 * Only an `admin` mints the two roles that derive the `root` sentinel.
 */
export function assignableBy(issuerRole: string | null | undefined): string[] {
  if (issuerRole === 'admin') return [...ASSIGNABLE_ROLES];
  return ASSIGNABLE_ROLES.filter((role) => role !== 'admin' && role !== 'orchestrator');
}

/**
 * Whether to offer THIS issuer the password control for THAT Account
 * (card bc5cd9f0) — the display half of the route's non-escalation bound,
 * `canAssignRole(issuerRole, target.role)`.
 *
 * Derived from `assignableBy` rather than from a list of its own, so it cannot
 * become a fourth place where "who is above whom" is written down. The
 * role-less case follows `canAssignRole`, which admits a null requested role:
 * an Account carrying no role derives no authority (`scopesForRole` returns an
 * empty set for it), so there is nothing to escalate to.
 */
export function mayManagePasswordFor(
  issuerRole: string | null | undefined,
  targetRole: string | null | undefined,
): boolean {
  if (!targetRole) return true;
  return assignableBy(issuerRole).includes(targetRole);
}
