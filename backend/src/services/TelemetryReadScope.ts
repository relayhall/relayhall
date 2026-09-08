/**
 * TelemetryReadScope — the ONE narrowing every telemetry projection read
 * carries, and the reason a projection cannot be read unnarrowed (RH-TW1c,
 * card `50e74c1d`).
 *
 * ── WHAT IT IS ──
 *
 * Design `7d5c0cdc` §5.3 makes the selectable object the **telemetry source**
 * — `(owning connector_id, source.product)` — and roots it in **the owning
 * Connector's Account**: "a grant can never match a source whose owning
 * Account lies outside the grantor's subtree". At TW1c there are no telemetry
 * grants yet (the `telemetry-contents:read` selector machinery is TW5 scope
 * and this module does not claim it exists), so the reachable narrowing is
 * the subtree root itself:
 *
 *   - `root` — the A12.1 global sentinel — reads every source;
 *   - every other caller reads exactly the sources whose `account_id` is the
 *     Account at the head of its OWN authenticated chain.
 *
 * **Administrators are narrowed like everyone else.** That is not an
 * oversight: owner ruling `623632b0` option (a) settled the same question for
 * `knowledge-contents:read` — "the selector is enforced for every NON-ROOT
 * caller, administrators included", because an arm that returns TRUE for a
 * whole ROLE is a flat estate-wide grant. A presence projection names who is
 * running which AI product, when, and how much it cost; it is a disclosure of
 * the same family, so it inherits the same rule rather than the work-plane's
 * blanket administrator arm.
 *
 * ── WHY IT IS A TYPE AND A REQUIRED PARAMETER ──
 *
 * `middleware/sharedAuthorization.ts` states the shape this follows, for the
 * Task narrowing, in its own words: the service is given the same decision
 * "as a REQUIRED parameter, so a caller that forgets it fails to compile, and
 * the service stays ignorant of Express". Every method on
 * `TelemetryProjectionService` therefore takes a `TelemetryReadScope` as its
 * FIRST parameter, with no default and no optional marker. There is no
 * "unscoped" overload to reach for, no `scope?: TelemetryReadScope`, and no
 * `{ kind: 'all' }` member: the widest value in the union is `root`, and only
 * `telemetryReadScopeFor` can produce it — from the sentinel scope, never from
 * a role, a handle or a header.
 *
 * ── FAIL CLOSED ──
 *
 * `telemetryReadScopeFor` returns `null` — never a scope — for a caller it
 * cannot place: unauthenticated, or authenticated with no resolvable Account.
 * A null is a refusal at the route, not a wide read. The union has no member
 * that means "everything I could not narrow".
 *
 * ── READ SCOPE STRING ──
 *
 * There is deliberately NO `telemetry:read`. Design §5.3: "Tier 0/1 events and
 * rollups ride existing read scopes", and A17.7's condition is that no
 * `telemetry:read` exists — `telemetryFrames.test.ts` asserts its absence from
 * `ALL_SCOPES` and this card does not disturb that. The existing read scope
 * these surfaces ride is `services:read`, because the object they are about IS
 * a registry row: per `utils/connectorRegistry.ts` a Connector is "a `services`
 * row with `kind = 'connector'` whose REQUIRED `principal_id` names the acting
 * principal". The scope-map rules live in `utils/scopeMap.ts`; the row-level
 * narrowing lives here, and the two are not substitutes for one another — the
 * scope is the ceiling, this is the subtree.
 */
import type { AuthorizationActor } from './AuthorizationService';

/**
 * The narrowing, as a closed union.
 *
 * `root` is the A12.1 sentinel and nothing else; `account` names ONE Account
 * principal. There is no third member, so "read everything" is not expressible
 * by any caller that is not root.
 */
export type TelemetryReadScope =
  | { readonly kind: 'root' }
  | { readonly kind: 'account'; readonly accountId: string };

/** A rendered SQL fragment plus the parameters it binds, offset-aware. */
export interface TelemetryScopeSql {
  readonly sql: string;
  readonly params: unknown[];
}

/**
 * The Account at the head of an authenticated chain, or the acting principal
 * when there is no chain.
 *
 * The chain arrives ACTING FIRST and Account last (`middleware/auth.ts` builds
 * it from `DelegationService.resolveChain`), which is the same ordering
 * `TelemetryPrincipalService.derive` reads on the WRITE side — the read side
 * takes the head of the same chain so a Connector reads back exactly the
 * Account its own events were written under.
 *
 * A caller with no delegation chain is Account-plane: it IS its own Account.
 * That is the ordinary signed-in person, and it is why a human sees their own
 * Connectors' sources without any grant.
 */
function accountAtHeadOfChain(actor: AuthorizationActor): string | null {
  const links = actor.delegation?.links ?? null;
  if (links && links.length > 1 && !links[0].legacyIdentity) {
    const head = links[links.length - 1];
    if (head?.principalId) return String(head.principalId);
  }
  return actor.principalId ? String(actor.principalId) : null;
}

/**
 * Derive the scope, or refuse.
 *
 * `null` means REFUSE. It is returned for an unauthenticated caller and for an
 * authenticated one whose Account cannot be resolved, and the route turns it
 * into a 403 — the union deliberately offers nothing wider to fall back on.
 */
export function telemetryReadScopeFor(actor: AuthorizationActor): TelemetryReadScope | null {
  if (!actor.authenticated) return null;
  // A12.1: the global sentinel, and ONLY the sentinel. Not a role, not a
  // handle — `AuthorizationService.sqlCondition` reads the same field the same
  // way, so root-ness cannot mean two things in one deployment.
  if (actor.scopes?.includes('root')) return { kind: 'root' };
  const accountId = accountAtHeadOfChain(actor);
  if (!accountId) return null;
  return { kind: 'account', accountId };
}

/**
 * Render the narrowing against an `account_id` column expression.
 *
 * `column` is a column reference this module's callers write as a literal —
 * never caller text. Parameters start at `paramOffset`, in the same convention
 * `AuthorizationService.sqlCondition` uses, so a projection query can compose
 * this with its own placeholders.
 */
export function renderTelemetryScopeSql(
  scope: TelemetryReadScope,
  column: string,
  paramOffset: number,
): TelemetryScopeSql {
  if (scope.kind === 'root') return { sql: 'TRUE', params: [] };
  return { sql: `${column} = $${paramOffset}`, params: [scope.accountId] };
}

/** A stable, loggable label. Carries no Account identifier for the root arm. */
export function describeTelemetryReadScope(scope: TelemetryReadScope): string {
  return scope.kind === 'root' ? 'root' : `account:${scope.accountId}`;
}
