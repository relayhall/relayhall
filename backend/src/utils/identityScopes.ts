import { MINTABLE_SCOPES, ROOT_SCOPE, Scope } from './scopeMap';
import { isLoginSessionKind } from './administratorSession';

/**
 * Convert a trusted role source into an explicit route-scope ceiling.
 *
 * Authentication roles and credential scopes remain separate axes: roles
 * cap the kind of action, while this set names the live route families the
 * identity may reach. The old null sentinel combined those axes by skipping
 * scope evaluation entirely; RH-P2.6 removes that bypass.
 */
/**
 * A17.7 / A24 note, so the next reader does not have to re-derive it:
 * EVERY mintable non-admin scope is derived here, `telemetry:write` and
 * `directory-provisioning:write` included. That is not an oversight and it
 * is not a widening either.
 *
 * It cannot be narrowed here without breaking the thing it would protect.
 * `DelegationService.effectiveScopes` bounds a whole chain by the ACCOUNT
 * layer's role-derived set (§5.2 rule 1), so a scope withheld from every
 * role is a scope no Connector can hold either — the SCIM client included.
 * Withholding it would therefore force the directory's service Account to
 * carry an elevated role purely to pass its own intersection, which is a
 * worse outcome than the one being avoided, or require amending a ratified
 * delegation rule, which is not an agent session's call.
 *
 * What actually bounds `directory-provisioning:write` is not this ceiling:
 * it is the credential-to-Identity-provider binding on the surface itself
 * (`identity_providers.scim_client_principal_id`, migration 106). A caller
 * that is not an enabled provider's SCIM client is refused there whatever
 * its scopes say, and only a parentless service Account can BE one, so no
 * human login session can reach the act however its role derives.
 */
export function scopesForRole(role: string | null | undefined): Scope[] {
  const normalized = String(role || '').trim().toLowerCase();

  // These are the two owner/credential-management roles. `root` is explicit,
  // rather than inferred from a missing scope set.
  if (normalized === 'admin' || normalized === 'orchestrator') {
    return [ROOT_SCOPE];
  }

  // Operators administer product objects, but owner-plane routes and
  // credential issuance still require root.
  if (normalized === 'operator') {
    return MINTABLE_SCOPES.filter((scope) => scope !== ROOT_SCOPE);
  }

  if (['editor', 'user', 'agent', 'service', 'qa', 'reviewer'].includes(normalized)) {
    return MINTABLE_SCOPES.filter((scope) => scope !== ROOT_SCOPE && !scope.endsWith(':admin'));
  }

  if (normalized === 'viewer') {
    return MINTABLE_SCOPES.filter((scope) => scope.endsWith(':read'));
  }

  // Unknown externally supplied session roles never become an implicit
  // writer. Authenticated-only self-service routes may still admit them.
  return [];
}

/**
 * WHAT THIS SESSION MAY PUT ON A BEARER CREDENTIAL.
 *
 * `scopesForRole` above answers what a session may REACH. That is not the same
 * question as what it may DELEGATE, and card `6e25ae48` is exactly the gap
 * between them: `admin` and `orchestrator` reach everything through the `root`
 * sentinel, and `root` is the one scope `PrincipalService.issueCredential`
 * refuses outright (design 4d961e37 §5.2 rule 2 / AZ-18 — "root is never
 * delegable to a bearer credential"). A surface that offered the caller's own
 * effective set as the menu was therefore offering an administrator exactly one
 * choice, and that choice was the one the board refuses: a day-one flow the two
 * roles a fresh deployment is administered by could not complete at all.
 *
 * The answer is not to make `root` mintable and it is not to narrow a role. It
 * is to say the delegable set OUT LOUD, once, on the server, so that no surface
 * has to derive it and no frontend has to mirror a scope catalogue that would
 * rot the way a mirrored list always does:
 *
 *   - a session holding `root` may delegate every MINTABLE scope EXCEPT `root`
 *     itself. That is not a widening invented here: `routes/services.ts` skips
 *     the `ISSUE_EXCEEDS_SESSION` check entirely for a root caller, so this is
 *     precisely the set that route already accepts from one.
 *   - every other session may delegate the mintable scopes it actually holds,
 *     which is precisely what that same check admits from it.
 *
 * So this function STATES the two arms `routes/services.ts` already enforces;
 * it is not a second, softer rule sitting beside them. `root` is absent from
 * the result on both arms, which is the property the wizard depends on.
 *
 * The result is ordered by `MINTABLE_SCOPES`, not by the caller's set: a menu a
 * person reads should not reorder itself because one role's derivation happened
 * to list its scopes differently from another's.
 */
export function delegableScopes(sessionScopes: string[] | null | undefined): Scope[] {
  const held = Array.isArray(sessionScopes) ? sessionScopes : [];
  if (held.includes(ROOT_SCOPE)) {
    return MINTABLE_SCOPES.filter((scope) => scope !== ROOT_SCOPE);
  }
  return MINTABLE_SCOPES.filter((scope) => scope !== ROOT_SCOPE && held.includes(scope));
}

/**
 * WHAT THIS CALLER MAY ACTUALLY DELEGATE THROUGH A SHIPPED SURFACE.
 *
 * `delegableScopes` above answers the question for a SCOPE SET. That is not the
 * whole question, and round-1 review finding B3 (verdict `7cce6577`) is the gap:
 * `GET /principals/me` answers every authenticated caller, a bearer credential
 * included, and publishing the scope-set answer to one of those told an `rh_`
 * key holding `tasks:read` that it could delegate `tasks:read`. It cannot,
 * through either shipped issuance surface:
 *
 *   - `POST /services` with `issueCredential` refuses EVERY bearer caller before
 *     it looks at a scope at all (`SESSION_ONLY`, §7.4/§9.2);
 *   - `POST /principals/:id/credentials` goes through `resolveIssuerAuthority`,
 *     which refuses any caller not presenting `root`.
 *
 * So a field that names what a caller may delegate has to know what KIND of
 * caller it is. A login session gets the scope-set answer. A bearer gets it only
 * when it holds `root` — because that is exactly the caller
 * `resolveIssuerAuthority` admits, and for such a caller `grantableScopes` is
 * null, meaning every mintable scope, which is what the root arm returns.
 * Everything else gets nothing, which is the honest answer and the safe one.
 *
 * The rule lives here rather than in the route so it is stated once and can be
 * measured both as a unit and through the production router — the review asked
 * for the second, and a pure helper test alone would not have caught this.
 *
 * Declared amendment UX-A1 to owner design record `99d6b0ad` names this half
 * too: `/principals/me` publishes `delegableScopes` PER AUTHENTICATION KIND.
 */
export function delegableScopesForCaller(
  authMethod: string | undefined,
  callerScopes: string[] | null | undefined,
): Scope[] {
  const held = Array.isArray(callerScopes) ? callerScopes : [];
  if (isLoginSessionKind(authMethod)) return delegableScopes(held);
  if (held.includes(ROOT_SCOPE)) return delegableScopes(held);
  return [];
}

/** Preserve the legacy service key's working-plane authority without turning
 * a broadly distributed automation credential into an owner/root key. */
export const LEGACY_SERVICE_SCOPES: Scope[] = scopesForRole('service');
