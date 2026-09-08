/**
 * accountProvisioning — the two things EVERY Account producer must agree on.
 *
 * There are now three of them: `invited` and `jit` in `SsoAuthenticationService`,
 * and the inbound SCIM rung in `ScimProvisioningService` (RH-P5.SSO.W4, A24 /
 * AZ-A4 clause 3). Each creates a parentless human Account, and each has to
 * answer the same two questions the same way — so the answers live here rather
 * than being a literal each of them repeats.
 *
 * ── THE FIXED MINIMAL ROLE ──
 *
 * AZ-RT1 fixes the role a delegated creation path may use, and AZ-A4 clause 3
 * inherits that bound for the SCIM path in the same breath as it grants the
 * path at all: "MAY create parentless human Accounts **at the fixed minimal
 * role**". SS-9 says why it can never be anything else — "No external claim
 * derives a board role in v1" — so a directory that sends `roles` gets the same
 * Account as one that does not, and any elevation afterwards is an owner-plane
 * act with an audit row.
 *
 * ── THE HANDLE NORMALISATION ──
 *
 * Two producers normalising differently is not a style difference: it decides
 * whether two people COLLIDE, and brief §2.3 rules that a collision is refused
 * at provisioning time rather than silently suffixed. If the SSO rung folded
 * `A.User` to `a.user` and the SCIM rung folded it to `a-user`, the same person
 * arriving by two doors would become two Accounts and the refusal that is
 * supposed to force an operator decision would never fire.
 */

/**
 * AZ-RT1 / AZ-A4 clause 3. `principals.role` is a CHECK-constrained
 * vocabulary (migration 062) and `user` is its minimal human member:
 * `scopesForRole('user')` grants no `*:admin` verb and no `root`.
 */
export const FIXED_MINIMAL_ACCOUNT_ROLE = 'user';

/**
 * Fold an externally-supplied name into a board handle.
 *
 * `principals.handle` is `VARCHAR(64) NOT NULL UNIQUE` (migration 062), so the
 * bound is the column's and not a taste. The character class is the one the
 * SSO rung has always used; it is enumerated rather than a negated wildcard so
 * that widening it is a visible diff.
 *
 * Returns the empty string when nothing survives folding — callers REFUSE on
 * that rather than inventing a substitute, because a substitute is the silent
 * suffix by another name.
 */
export function normalizeAccountHandle(candidate: string): string {
  return String(candidate ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .slice(0, 64);
}
