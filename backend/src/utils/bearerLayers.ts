/**
 * THE BEARER LAYERS — which delegated principal kinds can present a bearer
 * credential, named by the layer the ledger already records.
 *
 * ── WHY THIS IS AN EXPORT ───────────────────────────────────────────────────
 *
 * `CredentialLifecycleService.reveal` has always classified a credential's
 * holder as `agent`, `connector` or `account-legacy-shape` — inline, in one
 * ternary, for one audit field. Round-4b review `252fe7e6` B1 found the
 * consequence at the other end of the estate: the SETGOV acceptance drill's
 * D17 matrix is a claim about EVERY bearer-capable principal kind, and with no
 * production enumeration to read, the drill derived that dimension from its own
 * fixture manifest — a place the drill itself writes — and then checked it
 * against a second copy of the same list. A drill that supplies both sides of
 * an equality can always be reduced without going red.
 *
 * So the classification moves here, unchanged, and the ENUMERATION comes with
 * it. Nothing about `reveal` behaves differently; what changes is that the set
 * of bearer layers is now a fact production states once and consumers read.
 *
 * ── WHAT A LAYER IS ─────────────────────────────────────────────────────────
 *
 * `principals.kind` is `human | agent | service` (migration 062) and
 * `parent_principal_id` is the delegation edge (096). A principal with a parent
 * is a DELEGATED identity and is the only kind of principal that presents an
 * `rh_…` credential on the working plane: `kind = 'agent'` is a task-bound
 * agent identity, and any other parented kind is a Connector's delegated
 * identity (097 makes `principal_id` REQUIRED for connector-kind registry
 * rows). A parentless holder is the legacy Account shape, which is not a
 * delegated bearer at all and is therefore NOT in `DELEGATED_BEARER_LAYERS`.
 */

/** The parentless holder — an Account's own credential, not a delegated bearer. */
export const ACCOUNT_BEARER_LAYER = 'account-legacy-shape' as const;

/**
 * EVERY delegated bearer layer. Enumerated and never a pattern: growing this
 * list is a security-significant code-review event, because every control that
 * asserts a property "for each bearer kind" is measured over exactly this set.
 */
export const DELEGATED_BEARER_LAYERS = ['agent', 'connector'] as const;

export type DelegatedBearerLayer = (typeof DELEGATED_BEARER_LAYERS)[number];
export type BearerLayer = DelegatedBearerLayer | typeof ACCOUNT_BEARER_LAYER;

/**
 * The layer one principal row belongs to, from the two columns that decide it.
 * The expression is `CredentialLifecycleService`'s, verbatim.
 */
export function bearerLayerFor(
  kind: string | null | undefined,
  parentPrincipalId: string | null | undefined,
): BearerLayer {
  if (!parentPrincipalId) return ACCOUNT_BEARER_LAYER;
  return String(kind) === 'agent' ? 'agent' : 'connector';
}

/** Is this a DELEGATED bearer layer (as opposed to the Account shape)? */
export function isDelegatedBearerLayer(layer: string): layer is DelegatedBearerLayer {
  return (DELEGATED_BEARER_LAYERS as readonly string[]).includes(layer);
}
