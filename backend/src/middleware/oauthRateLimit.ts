/**
 * oauthRateLimit — the stricter per-source budget on the authorization
 * server's endpoints (RH-P3.C6; strategy §2.12 abuse controls).
 *
 * WHY A SECOND CEILING. `/oauth` is unauthenticated by contract, and two of
 * its endpoints do expensive or guessable things: `/authorize` makes the board
 * perform an OUTBOUND fetch of a caller-named document, and `/token` accepts a
 * code that an attacker would otherwise be free to guess at the API-wide rate.
 * The C8 ceiling (300/min across the whole API) is the estate-level backstop;
 * this is the surface-appropriate budget underneath it, exactly as the login
 * path keeps its own stricter throttle under the same ceiling.
 *
 * The mechanism is C8's, not a new one: the same `ApiRateLimiter` fixed window,
 * the same proxy-aware source keying, the same bounded in-memory state (TTL
 * sweep + entry ceiling). Reusing the class is deliberate — a second
 * hand-written limiter would be a second place for the sweep to be forgotten.
 */
import { ApiRateLimiter } from './apiRateLimit';
import { loginClientKey } from './loginRateLimit';

/** Requests allowed per source per window across the whole `/oauth` mount. */
export const OAUTH_RATE_LIMIT_MAX_REQUESTS = 60;
export const OAUTH_RATE_LIMIT_WINDOW_MS = 60_000;

export const oauthEndpointThrottle = new ApiRateLimiter(
  OAUTH_RATE_LIMIT_MAX_REQUESTS,
  OAUTH_RATE_LIMIT_WINDOW_MS,
);

/**
 * The source key. Identical derivation to the login throttle's, so a client
 * behind the estate proxy is keyed by its real address and one scanner cannot
 * throttle everybody by collapsing into a single proxy bucket.
 */
export const oauthClientKey = loginClientKey;
