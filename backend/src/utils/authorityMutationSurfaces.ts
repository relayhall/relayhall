/**
 * THE AUTHORITY-MUTATION SURFACE CLOSURE.
 *
 * Owner ruling `70af4d82` §1.1 (2026-09-02), on escalation `94c77997`; annex
 * `85a2218d` D21 as RESCOPED at that sitting; design `7a9317b2` §4.3 as
 * CORRECTED by the same record; companion `0c321078` A25.4.
 *
 * ── WHAT WAS MEASURED ──
 *
 * Over HTTP, against a real migrated PostgreSQL and a real compiled process, a
 * `viewer`-role Account holding no `root`, no `:write` and no `:admin` scope,
 * in a Group placed at Administrative `configure` by an ordinary root matrix
 * act, created a `task`/`admin` grant to a Group, created a Group, added a
 * foreign Account to it, and published a `task` / `all-of-type` /
 * `read+write+admin` profile version. Every one returned 201.
 *
 * The cause is not this design's arm. `routes/grants.ts`, `routes/groups.ts`
 * and `routes/accessProfiles.ts` carry NO descendant-subtree check: `4d961e37`
 * §5.2 rule 4 has been satisfied VACUOUSLY for those families since they were
 * written, because their whole gate is the `root` route ceiling and no non-root
 * session could reach them. The Access-surface arm is precisely the mechanism
 * that substitutes for that ceiling — so it is what makes the state reachable.
 *
 * ── WHAT THIS MODULE DOES UNTIL THE ARM EXISTS ──
 *
 * The rule-4 arm is chartered as design card `3e76cfcc` (AUTHZ amendment
 * AZ-A7). Until it lands, the three Access surfaces whose write families mutate
 * authority itself are `governable` and belong to NO Access bundle, and no
 * authority over them is writable or readable through this design at all:
 *
 *   1. migration 109 seeds them into no `access_bundle_members` row, and
 *      Administrative's members are exactly #14, #21, #22, #23;
 *   2. every WRITE SURFACE of both authority stores refuses a row naming one of
 *      them, with an audited denial that names the surface and this card —
 *      `GrantService.create` for `grants`, the profile-rule selector check for
 *      `access_profile_rules`, and (when candidate B lands `/access-bundles`)
 *      the matrix membership write, which calls the same helpers;
 *   3. the ARM ITSELF never admits them: `evaluateSurfaceStage` returns the
 *      ratified root refusal BEFORE the level is computed, so a row inserted by
 *      any path that bypasses (2) — raw SQL included — confers nothing, and the
 *      refusal a non-root caller sees on `/grants`, `/groups` and
 *      `/access-profiles` is byte-identical to the one it saw before SETGOV
 *      (ruling §1.1: "Their behaviour today is unchanged: root-only, as before
 *      SETGOV").
 *
 * (2) and (3) are the two halves the annex drills SEPARATELY, on the same
 * pattern AZ-A5 clause 3 already uses for the typed wildcard: either can be
 * removed without the other failing, which is why neither alone is the closure.
 *
 * ── WHEN `3e76cfcc` LANDS ──
 *
 * Empty `AUTHORITY_MUTATION_SURFACE_KEYS` and delete this module's call sites.
 * Nothing else here is load-bearing: the surfaces stay registered `governable`
 * throughout, so the catalogue, the census and `resolveSurface` never change.
 */
import { auditService, type AuditActor } from '../services/AuditService';
import { logCaughtFailure } from './secretSafeLog';

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/**
 * The audited denial act. `<object>.refused` is the ledger's established denial
 * spelling (`legacy.refused` in `GrantService`, `surface.refused` in the arm),
 * and 087's CHECK on `audit_events.action` is `^[a-z][a-z0-9_.]{2,127}$` — it
 * admits `_` and `.` and NOT `-`, so the object is spelled `access_bundle`
 * here even though the noun is "Access bundle".
 *
 * The first spelling of this constant carried a hyphen. Every insert violated
 * the CHECK, the swallowing `catch` below hid it, the refusals still refused —
 * and annex D21 clause (ii)'s audit assertion is what found it. That is why
 * the assertion asks for the ROW and not for the call.
 */
export const AUTHORITY_MUTATION_REFUSAL_ACT = 'access_bundle.refused';

/** The design card that lifts this closure (AUTHZ amendment AZ-A7). */
export const RULE_FOUR_ARM_CARD = '3e76cfcc';

/**
 * §1.1 inventory rows #15, #17 and #18 — the three `governable` Access surfaces
 * whose declared families mutate AUTHORITY ITSELF. Named by KEY, enumerated and
 * never a pattern: shrinking this list is a security-significant code-review
 * event of the same class as growing `UNGOVERNED_ROOT_FAMILIES`, and it is the
 * owner's to shrink (ruling `70af4d82` §1.3).
 */
export const AUTHORITY_MUTATION_SURFACE_KEYS: readonly string[] = [
  'settings.access-grants',           // #15 — POST /grants, DELETE /grants/:id
  'settings.identities',              // #17 — the identity plane
  'settings.access-profiles-groups',  // #18 — profiles, versions, assignments, Groups
] as const;

export function isAuthorityMutationSurfaceKey(key: string): boolean {
  return AUTHORITY_MUTATION_SURFACE_KEYS.includes(key);
}

/**
 * The one refusal sentence. It names the SURFACE and the MISSING ARM, because a
 * denial an operator cannot act on is a support ticket: ruling `70af4d82` §1.1
 * requires both.
 */
export function authorityMutationRefusalMessage(surfaceKey: string): string {
  return (
    `Access surface '${surfaceKey}' mutates authority itself and may not be conferred by any `
    + 'Access bundle, profile rule or grant: its handlers carry no rule-4 arm, so an access level '
    + 'over it would be a second owner plane (owner ruling 70af4d82 §1.1 on escalation 94c77997). '
    + `The arm is design card ${RULE_FOUR_ARM_CARD} (AUTHZ amendment AZ-A7); until it lands these `
    + 'surfaces stay root-only, exactly as before SETGOV.'
  );
}

/**
 * The audited denial — one spelling for every write surface, so D9's family is
 * one query rather than three. It is deliberately NOT `surface.refused`: that
 * act is the ARM's, carries a computed access level, and §3.6's audit
 * assertion counts it.
 */
export async function auditAuthorityMutationRefusal(
  actor: AuditActor,
  surfaceKey: string,
  act: string,
): Promise<void> {
  await auditService.record({
    action: AUTHORITY_MUTATION_REFUSAL_ACT,
    actor,
    outcome: 'denied',
    resourceType: 'surface',
    resourceId: null,
    metadata: { surfaceKey, act, refusal: 'AUTHORITY_MUTATION_SURFACE', arm: RULE_FOUR_ARM_CARD },
    // A ledger that is down must not turn a REFUSAL into a 500 — the caller is
    // refused either way, which is the safe direction. But it must not be
    // SILENT either: the hyphen defect described above lived exactly here.
  }).catch((error) => logCaughtFailure('[AuthorityMutationSurfaces] audited denial not written:', error));
}

/**
 * Of the Access-surface ids named, which are authority-mutation surfaces?
 * Resolved from the CATALOGUE rather than from a hardcoded id list, because ids
 * are generated per deployment; the KEY is the ratified identifier.
 */
export async function authorityMutationSurfacesAmong(
  surfaceIds: readonly string[],
  queryable: Queryable,
): Promise<Array<{ id: string; key: string }>> {
  const ids = [...new Set(surfaceIds)];
  if (ids.length === 0 || AUTHORITY_MUTATION_SURFACE_KEYS.length === 0) return [];
  const result = await queryable.query(
    `SELECT id::text AS id, key FROM access_surfaces
      WHERE id = ANY($1::uuid[]) AND key = ANY($2::text[])
      ORDER BY key`,
    [ids, [...AUTHORITY_MUTATION_SURFACE_KEYS]],
  );
  return result.rows.map((row: any) => ({ id: String(row.id), key: String(row.key) }));
}
