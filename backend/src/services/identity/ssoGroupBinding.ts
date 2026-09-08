/**
 * ssoGroupBinding — resolving an Identity provider's opaque group values to
 * board Groups (SS-12; design `d95136d7` §7.1; annex `e6dcadb9` §10a class 3).
 *
 * ── THE WHOLE POINT IS THAT THE CODE DOES NOT KNOW WHAT IT IS LOOKING AT ──
 *
 * `external_group_ref` is an **opaque string matched exactly** — never parsed,
 * never split on `/`, never case-folded. Shape class 3 is the reason: the same
 * column must hold a directory GUID, a `/path` and a bare name, and a naive
 * design that "helpfully" normalised any of them would bind the wrong Group or
 * none at all for two of the three.
 *
 * The exactness is therefore enforced by the QUERY, not by a convention: the
 * lookup is an equality join on the raw bytes, so a value differing by one byte
 * binds nothing. Class 3's negative control drives exactly that.
 *
 * ── WHAT THIS MODULE DELIBERATELY DOES NOT DO ──
 *
 * It does not write memberships. Applying a claim-driven snapshot through
 * `GroupService.applyDirectorySnapshot` is SS-W3 (annex §11), and owner
 * decision D2 forbids stretching into W3. This module is the binding half that
 * migration 104's columns made expressible, and it is where W2 can honestly
 * observe class 3's characteristic; W3 completes the row by turning these
 * resolutions into memberships.
 */
import { pool } from '../../db/connection';

/** Anything that can run one statement: the shared pool, or a caller's
 *  transaction client. */
interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

export interface GroupBinding {
  /** The value the Identity provider sent, byte-for-byte. */
  externalGroupRef: string;
  groupId: string;
  groupName: string;
}

/**
 * Resolve opaque values to bound board Groups for ONE Identity provider.
 *
 * Provider-scoped by the query itself: a binding registered for provider A is
 * unreachable from provider B's claim, which is the structural half of the
 * SS-14 scoping story.
 *
 * Values that bind nothing are simply absent from the result. That is not an
 * error: a directory routinely contains groups a board has never bound, and
 * refusing the login over one would make group binding a lockout mechanism.
 */
/**
 * ── THE ONE CHANGE RH-LENSES-a MAKES HERE, AND WHY (card `74e02a05`) ──
 *
 * Obligation **B-L3** says this function stays byte-identical, *"if
 * unavoidable, re-run SS-12 class-3's negative control and say so"*. It is
 * unavoidable, and this is the saying-so.
 *
 * *Use this group* INSERTs the `groups` row and, in the SAME transaction,
 * recomputes derived membership for every carrying Account — and that
 * recomputation resolves carriage through THIS function. Reading on the
 * shared pool would read COMMITTED state, which does not yet contain the
 * binding the same transaction just wrote, so every bind would create a
 * Group with no members and the one click the design exists for would do
 * nothing. That is not a defect a comment can fix.
 *
 * The change is the SMALLEST expressible one and it is behaviour-
 * preserving for every existing caller: an OPTIONAL trailing queryable
 * that defaults to the pool. The SQL, the deduplication, the opacity of
 * the values and the byte-exact equality join are untouched, which is
 * what SS-12 class 3's negative control measures.
 */
export async function resolveGroupBindings(
  identityProviderId: string,
  values: readonly string[],
  queryable: Queryable = pool,
): Promise<GroupBinding[]> {
  if (values.length === 0) return [];
  // Deduplicate without touching the bytes — a provider may legitimately repeat
  // a value, and de-duplication must not become normalisation.
  const distinct = [...new Set(values)];
  const result = await queryable.query(
    `SELECT id, name, external_group_ref
       FROM groups
      WHERE identity_provider_id = $1
        AND external_group_ref = ANY($2::text[])`,
    [identityProviderId, distinct],
  );
  return result.rows.map((row) => ({
    externalGroupRef: String(row.external_group_ref),
    groupId: String(row.id),
    groupName: String(row.name),
  }));
}
