/**
 * ssoRedirectUri — the registered `redirect_uri`, and the one place it is
 * constructed (design `d95136d7` §5.1; threat row T-SS13).
 *
 * ── WHY THIS IS NOT `boardEndpointFor` ──
 *
 * The tree already has a helper that answers "what is this board's public
 * endpoint": `utils/onboardingPack.boardEndpointFor`. It is correct for what it
 * does — it prefers the declared `RELAYHALL_PUBLIC_API_URL` and FALLS BACK to
 * `X-Forwarded-Proto` / `X-Forwarded-Host` / `Host` so an onboarding pack names
 * the origin the caller actually reached.
 *
 * That fallback must never reach the relying party. §5.1: the `redirect_uri` is
 * "constructed from the deployment's configured public origin - never from the
 * `Host` or `X-Forwarded-Host` header of the request that started the flow (a
 * header-derived `redirect_uri` is an account-takeover primitive on a
 * deployment behind a permissive proxy)". An attacker who can set `Host` would
 * otherwise have the board mint an authorization request whose callback points
 * at their own origin, and the authorization code would be delivered there.
 *
 * So the guarantee is STRUCTURAL rather than a rule someone has to remember:
 * these functions take no request, have no request parameter, and cannot
 * consult a header even by mistake. The same device makes SS-6 checkable in
 * `ssoOutbound`. T-SS13's vector asserts the value is byte-identical under
 * hostile headers, which it must be, because the headers are unreachable from
 * here.
 */

/** The registered callback path. SS-2's route census names the same string. */
export const SSO_CALLBACK_PATH = '/auth/sso/callback';

/** The environment variable a deployment declares its public origin in. */
export const SSO_PUBLIC_ORIGIN_ENV = 'RELAYHALL_PUBLIC_API_URL';

export class SsoPublicOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsoPublicOriginError';
  }
}

/**
 * The deployment's configured public API origin, with no fallback.
 *
 * An unset value is a REFUSAL, not a guess. A deployment that has not declared
 * where it lives cannot safely federate: every alternative source for this
 * value is attacker-influenceable, so there is nothing to fall back TO.
 */
export function ssoPublicApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  const declared = (env[SSO_PUBLIC_ORIGIN_ENV] ?? '').trim();
  if (declared === '') {
    throw new SsoPublicOriginError(
      `${SSO_PUBLIC_ORIGIN_ENV} must be set before an Identity provider can be used: the redirect_uri is constructed from it and from nothing else (T-SS13)`,
    );
  }
  return declared.replace(/\/+$/, '');
}

/** The exact string sent as `redirect_uri` and recorded on the pending row. */
export function ssoRedirectUri(env: NodeJS.ProcessEnv = process.env): string {
  return `${ssoPublicApiUrl(env)}${SSO_CALLBACK_PATH}`;
}
