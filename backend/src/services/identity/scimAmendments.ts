/**
 * The vocabulary amendments this SCIM family is BUILT ON — and the gate that
 * makes "built on" mean something.
 *
 * RH-LENSES-a, card `74e02a05`; acceptance **A-L34**, which says in as many
 * words: *"The SCIM Groups slice is **absent** from the build unless amendment
 * **A24.1** is recorded as ratified — a build gate, not a comment."*
 *
 * ── WHY A MODULE AND NOT A SENTENCE IN A TEST ─────────────────────────────
 *
 * A comment saying *"this rung depends on A24.1"* is worth nothing: it is true
 * whatever the code does, and it stays true after somebody quietly ships a
 * surface the owner never allowed. So the dependency is a MECHANISM. The six
 * `/Groups` routes and their six `SCIM_ROUTE_CENSUS` entries are BOTH derived
 * from the row below. **Delete the row and the slice is gone** — not flagged,
 * not warned about, gone — and the census and the router are still in
 * agreement, because both read the same decision.
 *
 * ── WHY THIS RUNG NEEDED AN AMENDMENT AT ALL ──────────────────────────────
 *
 * Vocabulary **A24** reads *"It authorizes **EXACTLY**: creating parentless
 * HUMAN Accounts at the fixed minimal role; updating directory-lifecycle
 * attributes …; writing `expected` Identity links and `source='directory'`
 * group memberships, all scoped to its own Identity provider."* **"EXACTLY"
 * closes the set.** A persistent reference store that survives independently
 * and feeds a non-SCIM catalog is not on it, and a design that read the store
 * into that sentence would be laundering. A24.1 is the smallest expressible
 * widening: one write class, no new scope, no new verb, and A17.8's bar on new
 * scope FAMILIES untouched.
 */

export interface ScimAmendment {
  /** The amendment's identifier in the vocabulary. */
  id: string;
  /** Who ratified it, and where that is recorded. */
  ratifiedBy: string;
  /** The companion record it folds into at ratification. */
  foldsInto: string;
  /** What it authorizes, in the amendment's own words. */
  authorizes: string;
}

/**
 * THE RATIFICATION REGISTER. A row here is a claim that an owner said yes, and
 * it carries where they said it so the claim can be checked.
 */
export const RATIFIED_SCIM_AMENDMENTS: ScimAmendment[] = [
  {
    id: 'A24.1',
    ratifiedBy:
      'ALLOWED by the owner at the sitting of 2026-09-04 (ruling 60307311; register 9d07f5fe, '
      + '23:20 UTC: "directory-provisioning:write may record group carriage -> SCIM /Groups feeds '
      + 'the catalog")',
    foldsInto: 'vocabulary companion 0c321078',
    authorizes:
      '(a) creating, updating, reading and deleting provider-scoped directory group reference '
      + 'resources and their metadata for its own Identity provider, INCLUDING a reference no '
      + 'Account carries, together with the reconciliation reads those writes require; and '
      + '(b) recording which Accounts provisioned by that same Identity provider carry those '
      + "references. Neither row holds authority, neither is read by any authorization predicate, "
      + 'and neither confers anything until an administrator binds a reference to a Group by an '
      + "owner-plane act. A24's negative half is unchanged.",
  },
];

/** The amendment the `/Groups` rung is built on. Named once, read by both the
 *  census and the route registration, so they cannot disagree. */
export const SCIM_GROUPS_RUNG_AMENDMENT = 'A24.1';

/**
 * Is this amendment recorded as ratified?
 *
 * The register is a PARAMETER with a default rather than a closed-over
 * constant, so the gate's discrimination can be measured directly — handed an
 * empty register it must answer false — instead of being inferred from the
 * fact that the routes happen to exist today.
 */
export function scimAmendmentRatified(
  id: string,
  register: readonly ScimAmendment[] = RATIFIED_SCIM_AMENDMENTS,
): boolean {
  return register.some((amendment) => amendment.id === id);
}
