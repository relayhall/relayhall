/**
 * routes/sso — the relying-party leg (design `d95136d7` §3.2; SS-1, SS-2,
 * SS-17; threat rows T-SS3, T-SS5, T-SS15).
 *
 * ── WHY THIS ROUTER IS MOUNTED INSIDE `/auth` ──
 *
 * SS-1: `PUBLIC_ROUTE_MOUNTS` does not grow. `/auth` is already public
 * (`authorizationRouteManifest.ts`), and growing that list is documented in the
 * tree as "a security-significant code-review event". Not growing it is the
 * right outcome — but it also means the AST MOUNT census cannot see these
 * routes, because it counts mounts and these are four routes under an existing
 * one.
 *
 * That is precisely why SS-2 exists, and why `ssoRouteCensus.test.ts` ships
 * with this file: an explicit expected set of `/auth/sso/*` method+path pairs,
 * red-proofed by adding an unlisted route. Without it this design would quietly
 * REDUCE review visibility while appearing to preserve it.
 *
 * ── AND WHY IT IMPORTS NOTHING FROM THE AUTHORIZATION-SERVER LEG ──
 *
 * SS-1 again: no relying-party module imports `services/OAuthAuthorizationService`
 * or `utils/oauthMetadata`, and no authorization-server module imports this
 * one. `ssoImportDirection.test.ts` enforces the direction, because a reader
 * who cannot instantly tell which role a route serves will eventually wire one
 * into the other — and these two legs share every noun in the protocol.
 */
import { Router, Request, Response } from 'express';
import { pool } from '../db/connection';
import { readCookie } from '../utils/cookies';
import { logCaughtFailure } from '../utils/secretSafeLog';
import { isFlagOn, FLAG_SESSIONS } from '../utils/featureFlags';
import { SESSION_COOKIE_NAME, loginSessionService, sessionAbsoluteMs } from '../services/LoginSessionService';
import { identityProviderService } from '../services/identity/IdentityProviderService';
import {
  SSO_STATE_COOKIE_NAME,
  SsoAuthenticationError,
  assertNotACallerComposedTarget,
  ssoAuthenticationService,
} from '../services/identity/SsoAuthenticationService';
import { SsoLogoutError, ssoLogoutService } from '../services/identity/SsoLogoutService';
import { SsoOutboundError } from '../services/identity/ssoOutbound';
import { IdTokenError } from '../services/identity/idTokenValidation';
import { SsoDiscoveryError } from '../services/identity/SsoDiscoveryService';

/**
 * SS-2's expected set, exported so the census test reads the SAME list the
 * router is built from. A census with its own private copy of the answer is a
 * model of the router, and a model can be edited to agree with a lie about it.
 */
export const SSO_ROUTE_CENSUS = [
  'POST /start',
  'GET /callback',
  'POST /logout',
  'POST /backchannel-logout',
] as const;

/**
 * §5.1: short-TTL, httpOnly, SameSite=Lax, Secure. `Lax` and not `Strict`
 * because the callback IS a cross-site top-level navigation from the Identity
 * provider — `Strict` would drop the cookie exactly when it is needed, and the
 * flow would fail closed for every legitimate user.
 */
const STATE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
};
const CLEAR_STATE_COOKIE_OPTIONS = { ...STATE_COOKIE_OPTIONS };

const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
};

/**
 * One refusal shape for every SSO failure, so nothing leaks by variation.
 *
 * THE CAUGHT ERROR'S OWN MESSAGE NEVER REACHES THE RESPONSE. §5.2 step 4
 * requires a provider error to be "surfaced as a refusal with a fixed message;
 * provider error text is audited, never rendered", and the same rule is the
 * right one for our own text: the caller gets a stable code and a fixed
 * sentence, while the operator gets the detail in the audit ledger and the
 * logs. `errorEnvelopeDiscipline`'s AST taint gate enforces this, and it
 * caught the first draft of this function doing exactly the wrong thing.
 */
const SSO_REFUSAL_MESSAGES: Record<string, string> = {
  SSO_NOT_CONFIGURED: 'this deployment has no enabled Identity provider',
  SSO_PROVIDER_INACTIVE: 'that Identity provider is not enabled',
  SSO_STATE_MISSING: 'the callback carries no state',
  SSO_STATE_UNKNOWN: 'that authentication request is unknown, expired or already used',
  SSO_COOKIE_MISMATCH: 'the authentication could not be tied to this browser',
  SSO_ISSUER_MISMATCH: 'the response does not match the request',
  SSO_PROVIDER_ERROR: 'the Identity provider refused the authentication',
  SSO_TOKEN_EXCHANGE_FAILED: 'the token exchange did not complete',
  SSO_RETURN_REF_INVALID: 'the return reference must be an opaque server-side reference',
  SSO_INVITATION_REQUIRED: 'this Identity provider binds new people by invitation only',
  SSO_INVITATION_INVALID: 'that invitation is not valid for this Identity provider',
  SSO_SUBJECT_ALREADY_LINKED: 'that subject is already linked to another Account',
  SSO_HANDLE_COLLISION: 'that handle is already taken',
  SSO_ACCOUNT_UNAVAILABLE: 'no Account could be resolved for this authentication',
  SSO_LOGIN_GROUP_REFUSED: 'this account is not a member of a group permitted to sign in at this Identity provider',
  SSO_CLAIM_MATCH_REFUSED: 'claim matching is refused for this Account',
  SSO_ID_TOKEN_REFUSED: 'the ID token was refused',
  SSO_PROVIDER_UNREACHABLE: 'the Identity provider could not be reached or validated',
  LOGOUT_ISSUER_UNKNOWN: 'that logout token names no enabled Identity provider',
  LOGOUT_TOKEN_INVALID: 'the logout token was refused',
  LOGOUT_TOKEN_REPLAYED: 'that logout token has already been used',
  LOGOUT_NOT_ADVERTISED: 'back-channel logout is not enabled for that Identity provider',
};

function refusalMessage(code: string): string {
  return SSO_REFUSAL_MESSAGES[code] ?? 'the authentication could not be completed';
}

/**
 * Forward a TYPED in-house refusal, or return false and let the caller ride
 * `logCaughtFailure` and the generic 500 envelope.
 *
 * This is the shape `routes/oauth.ts` (`sendOAuthError`) and the AZ-S4 senders
 * already use, and it is what `errorEnvelopeDiscipline`'s taint gate steers
 * towards: the caught value is read ONLY inside an instanceof-guarded arm, and
 * the message sent is a fixed sentence looked up by code — never the error's
 * own text. The first draft of this file derived a response message from the
 * caught error and the gate caught it, which is the gate doing its job.
 */
/**
 * The NAMED code of a typed in-house refusal, or null for anything else.
 * The caught value is read only inside instanceof-guarded arms, and only
 * its code is read — never its text. An ID-token refusal collapses to one
 * code: the caller learns the ID token was refused, and WHICH check fired
 * is useful to an operator reading the logs and useless to an attacker, who
 * already knows which check they broke.
 */
function ssoRefusalCode(error: unknown): string | null {
  if (error instanceof SsoAuthenticationError || error instanceof SsoLogoutError) return error.code;
  if (error instanceof IdTokenError) return 'SSO_ID_TOKEN_REFUSED';
  if (error instanceof SsoDiscoveryError || error instanceof SsoOutboundError) return 'SSO_PROVIDER_UNREACHABLE';
  return null;
}

function sendSsoRefusal(res: Response, error: unknown): boolean {
  const code = ssoRefusalCode(error);
  if (!code) return false;
  const status = code === 'SSO_NOT_CONFIGURED' || code === 'SSO_PROVIDER_INACTIVE'
    ? 503
    : code === 'SSO_PROVIDER_UNREACHABLE'
      ? 502
      : 400;
  res.status(status).json({ error: 'SSO refused', code, message: refusalMessage(code) });
  return true;
}

/**
 * Where a PERSON lands when the callback refuses them (card `a07f3277`).
 *
 * The callback is reached by top-level navigation from the
 * Identity provider, so a JSON refusal parks a human on raw callback JSON
 * with no way on — the owner met exactly that. A browser (an `Accept` that prefers HTML)
 * is redirected to the login page with the refusal's NAMED code, which the
 * page renders as its person-visible sentence; a fetch or a test (an
 * `Accept` that does not prefer HTML) keeps the JSON envelope, so nothing
 * that asserts on it changes. Only the CODE travels — a fixed vocabulary,
 * validated on the other side — never the error's text.
 *
 * `/dashboard/` is the SPA's base in every deployment (`vite.config.ts`;
 * `frontend/nginx.conf` sends `/` there too).
 */
const LOGIN_PAGE_PATH = '/dashboard/';
function refusedLoginPageUrl(code: string): string {
  return `${LOGIN_PAGE_PATH}?sso_refused=${encodeURIComponent(code)}`;
}

/**
 * The one collaborator this router cannot own: the browser capability cookie
 * the dashboard needs for `<img>`/`<iframe>` loads.
 *
 * It is INJECTED rather than imported, because `routes/auth` mounts this router
 * and importing back into it would be circular. W1 learned what happens when a
 * session login skips this cookie: the dashboard renders with no media. A
 * federated login is a session login, so it gets exactly the same treatment,
 * and making the dependency explicit is what stops it being forgotten.
 */
export interface SsoRouterDependencies {
  issueBrowserAccessCookie: (res: Response, principalId?: string | null) => void;
}

export function createSsoRouter(deps: SsoRouterDependencies): Router {
const router = Router();

// POST /api/auth/sso/start — begin authentication (§3.2).
// Body carries AT MOST an opaque return reference and an invitation code.
// Never a URL: SS-17 refuses anything a caller could compose.
router.post('/start', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    assertNotACallerComposedTarget(body.returnRef);

    const started = await ssoAuthenticationService.startAuthentication({
      identityProviderId: typeof body.identityProviderId === 'string' ? body.identityProviderId : undefined,
      invitationCode: typeof body.invitationCode === 'string' ? body.invitationCode : null,
      stepUp: body.stepUp === true,
    });

    res.cookie(SSO_STATE_COOKIE_NAME, started.stateCookieValue, {
      ...STATE_COOKIE_OPTIONS,
      maxAge: Math.max(0, started.expiresAt.getTime() - Date.now()),
    });
    // The authorize URL is returned rather than redirected to, so the browser
    // makes the navigation and the caller can be a fetch() from the login page.
    res.json({ authorizeUrl: started.authorizeUrl, expiresAt: started.expiresAt.toISOString() });
  } catch (error) {
    if (sendSsoRefusal(res, error)) return;
    const errorId = logCaughtFailure('[SSO] start failed:', error);
    res.status(500).json({ error: 'Internal Server Error', code: 'SSO_START_FAILED', message: 'SSO start failed', errorId });
  }
});

// GET /api/auth/sso/callback — the registered redirect_uri (§3.2, §5.2).
router.get('/callback', async (req: Request, res: Response): Promise<void> => {
  const query = req.query as Record<string, unknown>;
  try {
    const completed = await ssoAuthenticationService.completeAuthentication({
      state: typeof query.state === 'string' ? query.state : null,
      code: typeof query.code === 'string' ? query.code : null,
      iss: typeof query.iss === 'string' ? query.iss : null,
      error: typeof query.error === 'string' ? query.error : null,
      errorDescription: typeof query.error_description === 'string' ? query.error_description : null,
      cookieState: readCookie(req.headers.cookie, SSO_STATE_COOKIE_NAME),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // T-SS15: the pre-login state cookie is DISCARDED, never upgraded, and the
    // session token is freshly random (minted in LoginSessionService).
    res.clearCookie(SSO_STATE_COOKIE_NAME, CLEAR_STATE_COOKIE_OPTIONS);
    res.cookie(SESSION_COOKIE_NAME, completed.sessionToken, {
      ...SESSION_COOKIE_OPTIONS,
      maxAge: sessionAbsoluteMs(),
    });
    // W1 learned this the hard way: without the browser capability cookie the
    // dashboard renders with no media for a session user. A federated login is
    // a session login, so it needs exactly the same treatment.
    deps.issueBrowserAccessCookie(res, completed.principalId);
    res.redirect(302, completed.returnTo);
  } catch (error) {
    res.clearCookie(SSO_STATE_COOKIE_NAME, CLEAR_STATE_COOKIE_OPTIONS);
    // a07f3277: a person is sent back to the login page with the named
    // refusal; everything else keeps the JSON envelope. No login-session
    // cookie is set on either path — the refusal happened before the mint.
    const refusalCode = ssoRefusalCode(error);
    if (refusalCode && req.accepts(['json', 'html']) === 'html') {
      res.redirect(302, refusedLoginPageUrl(refusalCode));
      return;
    }
    if (sendSsoRefusal(res, error)) return;
    const errorId = logCaughtFailure('[SSO] callback failed:', error);
    res.status(500).json({ error: 'Internal Server Error', code: 'SSO_CALLBACK_FAILED', message: 'SSO callback failed', errorId });
  }
});

// POST /api/auth/sso/logout — end the local session, and optionally hand back
// the Identity provider's RP-initiated logout URL (§8.2).
router.post('/logout', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!isFlagOn(FLAG_SESSIONS)) {
      res.status(404).json({ error: 'Not Found', message: 'Login sessions are not enabled' });
      return;
    }
    const token = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
    const session = token ? await loginSessionService.resolve(token) : undefined;
    if (!session) {
      res.status(401).json({ error: 'Unauthorized', message: 'No live login session' });
      return;
    }

    // The Identity provider URL must be built BEFORE the revoke, because
    // SSO-R16 binds ID-token disposal to session death and the hint is read
    // from the row the revoke clears.
    const providerId = await providerIdForSession(session.sessionId);
    let providerLogoutUrl: string | null = null;
    if (providerId) {
      const provider = await identityProviderService.get(providerId);
      if (provider) {
        // The post-logout destination is a SERVER value, never a caller value.
        providerLogoutUrl = await ssoLogoutService.rpInitiatedLogoutUrl(
          provider,
          session.sessionId,
          postLogoutRedirectUri(),
        );
      }
    }

    await ssoLogoutService.localLogout(session.sessionId);
    res.clearCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
    res.json({ success: true, providerLogoutUrl });
  } catch (error) {
    const errorId = logCaughtFailure('[SSO] logout failed:', error);
    res.status(500).json({ error: 'Internal Server Error', code: 'SSO_LOGOUT_FAILED', message: 'Logout failed', errorId });
  }
});

// POST /api/auth/sso/backchannel-logout — authenticated BY THE LOGOUT TOKEN
// itself (§3.2, §8.2). No session, no bearer credential, no cookie.
router.post('/backchannel-logout', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = typeof body.logout_token === 'string' ? body.logout_token : null;
    if (!token) {
      res.status(400).json({ error: 'Bad Request', code: 'LOGOUT_TOKEN_MISSING', message: 'logout_token is required' });
      return;
    }
    const result = await ssoLogoutService.backchannelLogout(token);
    // OpenID Connect Back-Channel Logout 1.0: 200 with no body on success.
    res.status(200).json({ success: true, sessionsRevoked: result.sessionsRevoked });
  } catch (error) {
    if (sendSsoRefusal(res, error)) return;
    const errorId = logCaughtFailure('[SSO] back-channel logout failed:', error);
    res.status(500).json({ error: 'Internal Server Error', code: 'SSO_BACKCHANNEL_FAILED', message: 'Back-channel logout failed', errorId });
  }
});

  return router;
}

/** Which Identity provider proved this session, if any (SS-19). */
async function providerIdForSession(sessionId: string): Promise<string | null> {
  const result = await pool.query('SELECT identity_provider_id FROM auth_sessions WHERE id = $1', [sessionId]);
  const value = result.rows[0]?.identity_provider_id;
  return value === null || value === undefined ? null : String(value);
}

/**
 * Where the Identity provider sends the browser after an RP-initiated logout.
 * A SERVER value, composed from the configured public origin — never anything
 * a caller supplied (the same rule as the `redirect_uri`, T-SS13).
 */
function postLogoutRedirectUri(): string {
  const declared = (process.env.RELAYHALL_PUBLIC_APP_URL || process.env.RELAYHALL_PUBLIC_API_URL || '').trim();
  return `${declared.replace(/\/+$/, '')}/`;
}
