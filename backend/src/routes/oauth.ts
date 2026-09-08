/**
 * routes/oauth — the OAuth 2.1 authorization server's HTTP surface
 * (RH-P3.C6; strategy 4e40f06f Phase 3, ratified C3 amendment).
 *
 * ── WHY THIS MOUNT IS PUBLIC ──
 *
 * `/oauth` is a PUBLIC mount, and that is a security-significant fact the
 * authorization-route manifest and its AST census both record. An OAuth
 * authorization server has to be reachable by a client that holds no
 * credential yet — that is what it is FOR. What is public here is protocol,
 * not board data:
 *
 *   GET  /oauth/authorize      validates, parks the request, sends the browser
 *                              to the dashboard consent page
 *   POST /oauth/token          authorization_code + PKCE → an rh_ access token
 *   POST /oauth/revoke         RFC 7009 revocation
 *
 * plus the two discovery documents, exported separately as
 * `oauthWellKnownRoutes` and mounted at the API ROOT — because RFC 8414 has a
 * client construct `<issuer>/.well-known/oauth-authorization-server`, and the
 * issuer is that root. They read nothing and hold no state.
 *
 * NO BOARD OBJECT IS READ OR WRITTEN BY ANY OF THEM. The two endpoints that
 * DO touch a person's authority — reading a pending consent and deciding it —
 * are authenticated in-handler as LOGIN SESSIONS, the same way
 * `POST /auth/step-up` authenticates on the public `/auth` mount and for the
 * same reason: the shared-authorization funnel stamps its own transport class
 * and its own actor, and a consent act is a session act (AZ-18 — bearer
 * credentials do not step up, and they do not consent either).
 *
 * The authority a consent confers is not decided here at all. It is decided on
 * every subsequent call by `delegationService.effectiveScopes` against the
 * consenting Account's live role, and gated by the shared authorization
 * predicate on the route the tool composes. This surface can hand out a
 * reference to authority; it cannot manufacture any.
 */
import { Router, type Request, type Response } from 'express';

import {
  oauthAuthorizationService, OAuthError, oauthGrantableScopes,
} from '../services/OAuthAuthorizationService';
import {
  buildAuthorizationServerMetadata, buildProtectedResourceMetadata,
  OAUTH_AS_METADATA_SUFFIX, OAUTH_PROTECTED_RESOURCE_METADATA_SUFFIX,
  consentPagePath,
} from '../utils/oauthMetadata';
import { boardEndpointFor } from '../utils/onboardingPack';
import { verifyActiveDashboardToken } from '../utils/dashboardToken';
import { principalService, type Principal } from '../services/PrincipalService';
import { oauthEndpointThrottle, oauthClientKey } from '../middleware/oauthRateLimit';
import { logCaughtFailure } from '../utils/secretSafeLog';
import type { AuditActor } from '../services/AuditService';

const router = Router();

/** The RFC 6749 §5.2 error body shape, used by every refusal on this mount. */
function oauthErrorBody(error: OAuthError): Record<string, string> {
  return { error: error.oauthError, error_description: error.message };
}

function sendOAuthError(res: Response, error: unknown, context: string): void {
  if (error instanceof OAuthError) {
    res.status(error.status).json(oauthErrorBody(error));
    return;
  }
  const errorId = logCaughtFailure(`[OAuth] ${context} failed:`, error);
  // RFC 6749 §5.2 names the field `error`; the house envelope wants a
  // SCREAMING_SNAKE `code` and a correlating `errorId` on every 500. Both fit:
  // the RFC permits additional members, so a client reads the OAuth shape and
  // an operator reads the same row the logs carry.
  res.status(500).json({
    error: 'server_error',
    code: 'OAUTH_SERVER_ERROR',
    error_description: 'The authorization server could not complete this request',
    errorId,
  });
}

/**
 * Per-source throttle on every endpoint of this mount.
 *
 * These endpoints are unauthenticated by contract, so the API-wide ceiling is
 * the only thing between them and a code-guessing or document-fetch-amplifying
 * flood. C8's estate design carries the shape; this is the stricter budget the
 * authorization surface warrants on top of it (strategy §2.12).
 */
router.use((req: Request, res: Response, next) => {
  const decision = oauthEndpointThrottle.check(oauthClientKey(req));
  if (decision.allowed) { next(); return; }
  res.setHeader('Retry-After', String(decision.retryAfterSeconds));
  res.status(429).json({
    error: 'temporarily_unavailable',
    error_description: `Too many authorization requests. Retry in ${decision.retryAfterSeconds}s.`,
  });
});

// ───────────────────────────── authorize ─────────────────────────────

/**
 * The browser entry point.
 *
 * On success this does NOT render anything: it parks the validated request and
 * 302s to the dashboard's own consent page, which is where a human decision
 * belongs (one design language, one theme, one accessibility matrix). The page
 * then reads the parked request and posts the decision back here.
 *
 * A refusal is reported by redirect ONLY when the redirect target has already
 * been proven to belong to the client (`error.redirectable`). Everything
 * earlier — an unresolvable client_id, a redirect_uri the document does not
 * declare — is answered to the browser directly, because redirecting a caller
 * to an unvalidated URL is the open-redirect bug itself.
 */
router.get('/authorize', async (req: Request, res: Response): Promise<void> => {
  const query = req.query as Record<string, unknown>;
  try {
    const pending = await oauthAuthorizationService.beginAuthorization({
      clientId: query.client_id,
      redirectUri: query.redirect_uri,
      responseType: query.response_type,
      codeChallenge: query.code_challenge,
      codeChallengeMethod: query.code_challenge_method,
      scope: query.scope,
      state: query.state,
      resource: query.resource,
      boardEndpoint: boardEndpointFor(req),
    });
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, `${consentPagePath()}?request_id=${encodeURIComponent(pending.id)}`);
  } catch (error) {
    if (error instanceof OAuthError && error.redirectable && typeof query.redirect_uri === 'string') {
      // Reachable only after the redirect_uri matched the client's document.
      const target = new URL(query.redirect_uri);
      target.searchParams.set('error', error.oauthError);
      target.searchParams.set('error_description', error.message);
      if (typeof query.state === 'string') target.searchParams.set('state', query.state);
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(302, target.toString());
      return;
    }
    sendOAuthError(res, error, 'authorize');
  }
});

// ─────────────────────── the human consent surface ───────────────────────

/**
 * Resolve the LOGIN SESSION behind a request on this public mount.
 *
 * The `/auth/step-up` precedent, verbatim in intent: the auth middleware does
 * not run here, so the bearer identity is resolved explicitly, and a `Bearer
 * rh_` credential is refused outright — consent is an act only a human session
 * performs (AZ-18). Returns null for every other outcome.
 */
async function sessionAccount(req: Request): Promise<Principal | null> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ') || header.startsWith('Bearer rh_')) return null;
  try {
    const decoded = await verifyActiveDashboardToken(header.substring(7));
    const principal = decoded.principalId
      ? await principalService.getPrincipalById(decoded.principalId)
      : decoded.userId ? await principalService.getPrincipalByHandle(decoded.userId) : undefined;
    if (!principal || principal.status !== 'active') return null;
    // A17.1: only an Account consents. A Connector or Agent row reaching this
    // path would mean a session was minted for a delegated principal, which
    // the login path never does — refuse rather than assume.
    if (principal.parentPrincipalId) return null;
    return principal;
  } catch {
    return null;
  }
}

function unauthorized(res: Response): void {
  res.status(401).json({
    error: 'invalid_token',
    error_description: 'Consent is a signed-in act: sign in to the board and try again',
  });
}

function consentActor(principal: Principal): AuditActor {
  return { principalId: principal.id, handle: principal.handle, authMethod: 'dashboard_jwt' };
}

/**
 * CSRF is not applicable to the two endpoints below, and it is worth saying
 * why rather than leaving a reviewer to work it out: they authenticate a
 * BEARER JWT in the `Authorization` header, not a cookie. A cross-site page
 * cannot set that header, so a forged navigation or form post arrives
 * unauthenticated and is refused by `sessionAccount` like any other anonymous
 * caller. The board's capability cookie confers no authority and is not read
 * here.
 */

/** What the consent page renders. */
router.get('/authorization-requests/:requestId', async (req: Request, res: Response): Promise<void> => {
  const account = await sessionAccount(req);
  if (!account) { unauthorized(res); return; }
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await oauthAuthorizationService.consentView(req.params.requestId, account.role));
  } catch (error) {
    sendOAuthError(res, error, 'consent view');
  }
});

/** The decision. The response carries where to send the browser next. */
router.post('/authorization-requests/:requestId/decision', async (req: Request, res: Response): Promise<void> => {
  const account = await sessionAccount(req);
  if (!account) { unauthorized(res); return; }
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.approve !== 'boolean') {
    res.status(400).json({ error: 'invalid_request', error_description: 'approve must be true or false' });
    return;
  }
  const grantedScopes = Array.isArray(body.grantedScopes) ? body.grantedScopes.map(String) : [];
  try {
    const outcome = await oauthAuthorizationService.decide({
      requestId: req.params.requestId,
      accountPrincipalId: account.id,
      accountRole: account.role,
      approve: body.approve,
      grantedScopes,
    }, consentActor(account));
    res.setHeader('Cache-Control', 'no-store');
    res.json(outcome);
  } catch (error) {
    sendOAuthError(res, error, 'consent decision');
  }
});

// ─────────────────────────── token and revocation ───────────────────────────

router.post('/token', async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const issued = await oauthAuthorizationService.exchangeCode({
      grantType: body.grant_type,
      code: body.code,
      clientId: body.client_id,
      redirectUri: body.redirect_uri,
      codeVerifier: body.code_verifier,
    }, { handle: 'system', authMethod: 'system' });
    // RFC 6749 §5.1: token responses are never cached.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.json({
      access_token: issued.accessToken,
      token_type: issued.tokenType,
      expires_in: issued.expiresInSeconds,
      scope: issued.scope,
    });
  } catch (error) {
    sendOAuthError(res, error, 'token');
  }
});

/**
 * RFC 7009 §2.2: the response is 200 whether or not the token existed, so a
 * caller learns nothing about which tokens are real — and revocation is
 * idempotent. The refusal that MATTERS happens on the next MCP call, where
 * per-call lookup finds `revoked_at` set (ruling TS-12).
 */
router.post('/revoke', async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    await oauthAuthorizationService.revoke(body.token, { handle: 'system', authMethod: 'system' });
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({});
  } catch (error) {
    sendOAuthError(res, error, 'revoke');
  }
});

/**
 * The discovery documents, mounted at the API root (see the header note).
 *
 * A separate router rather than a second path on the same one: the mount
 * census records every `app.use` the server performs, and two mounts that do
 * genuinely different things should read as two mounts. This one carries no
 * state, no authentication and no side effect — it renders two constants.
 */
export const oauthWellKnownRoutes = Router();

oauthWellKnownRoutes.get(OAUTH_AS_METADATA_SUFFIX, (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(buildAuthorizationServerMetadata(boardEndpointFor(req), oauthGrantableScopes()));
});

oauthWellKnownRoutes.get(OAUTH_PROTECTED_RESOURCE_METADATA_SUFFIX, (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(buildProtectedResourceMetadata(boardEndpointFor(req), oauthGrantableScopes()));
});

export default router;
