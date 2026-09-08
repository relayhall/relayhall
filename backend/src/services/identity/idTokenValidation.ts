/**
 * idTokenValidation — §5.3 of design `d95136d7`: ID token validation, as
 * TWELVE REFUSALS.
 *
 * Each is a refusal, not a promise. This is the C6 idiom and it is the right
 * one: the surface is defined by what it will not accept. Each refusal carries
 * its OWN error code, because the W2 definition of done requires twelve
 * negative tests with twelve red proofs — "mutate that check, that ONE test
 * goes red" — and a shared code would let one mutation turn several tests red
 * while another turned none.
 *
 *   1  alg       asymmetric, in the allowlist AND advertised; `none` and HMAC refused
 *   2  kid       resolves in the cached JWKS, or in exactly one cooldown-bounded refresh
 *   3  signature verified BEFORE any claim is read
 *   4  iss       byte-equal to the configured issuer
 *   5  aud       contains the client id; a multi-valued aud requires azp
 *   6  exp/iat/nbf within clock skew
 *   7  nonce     equal to the pending row's nonce; an absent nonce is a refusal
 *   8  sub       present, non-empty, <= 255 bytes, opaque
 *   9  auth_time required and fresh whenever the request carried max_age
 *  10  required_claims present with permitted values
 *  11  UserInfo, if consulted, returns the same sub
 *  12  token size and claim count bounded, refused BEFORE parsing
 *
 * TWELVE, and the correction is stated rather than renumbered silently. An
 * earlier draft listed a thirteenth refusal — replay — which was refusal 7 and
 * the pending row wearing a third number: no distinct store, key or rejection
 * point, so it could pass vacuously while inflating the count this module
 * promises red proofs for. Replay is ONE property with ONE red proof, and it
 * lives on the pending row (SS-18).
 *
 * ── ORDER IS PART OF THE CONTRACT ──
 *
 * Refusal 12 runs before parsing; 1 and 2 run on the header; 3 runs before any
 * payload claim is read, logged as identity, or used for a lookup. A validator
 * that reads `iss` to pick a key before checking the signature has already
 * trusted the attacker's bytes.
 */
import crypto from 'crypto';

export const ID_TOKEN_REFUSALS = [
  'ALG_NOT_ALLOWED',
  'KID_UNRESOLVED',
  'SIGNATURE_INVALID',
  'ISSUER_MISMATCH',
  'AUDIENCE_MISMATCH',
  'TIME_WINDOW',
  'NONCE_MISMATCH',
  'SUBJECT_INVALID',
  'AUTH_TIME_STALE',
  'REQUIRED_CLAIM_MISSING',
  'USERINFO_SUBJECT_MISMATCH',
  'TOKEN_TOO_LARGE',
  'TOKEN_MALFORMED',
] as const;
export type IdTokenRefusal = (typeof ID_TOKEN_REFUSALS)[number];

export class IdTokenError extends Error {
  constructor(public readonly code: IdTokenRefusal, message: string) {
    super(message);
    this.name = 'IdTokenError';
  }
}

// The type annotation is on the VARIABLE, not just the arrow: TypeScript only
// treats a call as control-flow-terminating when the callee is a const with an
// explicit type annotation. Without it every refusal below would need a `!`.
const refuse: (code: IdTokenRefusal, message: string) => never = (code, message) => {
  throw new IdTokenError(code, message);
};

/**
 * Refusal 1's allowlist: asymmetric families only. `none` is absent because it
 * is not an algorithm, and the HMAC families are absent because an HS256 token
 * verified with the client secret as key is the classic alg-confusion path —
 * the secret is known to both parties, so "signed" would mean "sent by
 * anyone who has our secret", including anyone who ever read our database.
 */
export const ALLOWED_ID_TOKEN_ALGS = [
  'RS256', 'RS384', 'RS512',
  'PS256', 'PS384', 'PS512',
  'ES256', 'ES384', 'ES512',
] as const;

/** Refusal 12's bounds. Generous for a real token, finite for a hostile one. */
export const MAX_ID_TOKEN_BYTES = 16 * 1024;
export const MAX_ID_TOKEN_CLAIMS = 100;

export interface IdTokenHeader {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
}

export interface IdTokenClaims {
  iss?: unknown;
  sub?: unknown;
  aud?: unknown;
  azp?: unknown;
  exp?: unknown;
  iat?: unknown;
  nbf?: unknown;
  nonce?: unknown;
  auth_time?: unknown;
  [claim: string]: unknown;
}

/**
 * The envelope half — everything needed to decide that these BYTES came from
 * the Identity provider, before any claim is read. A back-channel logout token
 * is validated as an ID token for exactly this part (§8.2), so it is factored
 * out rather than restated: two copies of a signature check is how one of them
 * ends up accepting what the other refuses.
 */
export interface SignedTokenEnvelopeInput {
  token: string;
  /** Algorithms the Identity provider ADVERTISES; refusal 1 intersects. */
  advertisedAlgs: readonly string[];
  /** Resolve a `kid` to a JWK. The cooldown lives in the discovery service. */
  resolveKey: (kid: string) => Promise<crypto.JsonWebKey>;
}

export interface IdTokenValidationInput extends SignedTokenEnvelopeInput {
  /** The configured issuer — compared byte-for-byte, never normalised. */
  issuer: string;
  clientId: string;
  clockSkewSeconds: number;
  /** Refusal 7. The RAW nonce is never stored, so the comparison is by hash. */
  expectedNonceHash: string;
  hashNonce: (nonce: string) => string;
  /** Refusal 9. Present only for a step-up (§8.3). */
  maxAgeRequested?: number | null;
  /** The instant the pending row was created — NOT "now" (§8.3). */
  requestedAt?: Date | null;
  /** Refusal 10: claim -> permitted values. */
  requiredClaims?: Record<string, string | string[]>;
  now?: () => number;
}

export interface ValidatedIdToken {
  header: IdTokenHeader;
  claims: IdTokenClaims;
  subject: string;
  /** `sid`, where the Identity provider emits one (back-channel correlation). */
  sid: string | null;
}

function decodeSegment(segment: string, what: string): unknown {
  let json: string;
  try {
    json = Buffer.from(segment, 'base64url').toString('utf8');
  } catch {
    return refuse('TOKEN_MALFORMED', `the ID token ${what} is not base64url`);
  }
  try {
    return JSON.parse(json);
  } catch {
    return refuse('TOKEN_MALFORMED', `the ID token ${what} is not JSON`);
  }
}

/**
 * Refusal 3. The signature is verified against the key `kid` named, with the
 * algorithm the HEADER declared and refusal 1 already constrained — so an
 * attacker cannot pick a weaker verification than the one that was checked.
 */
function verifySignature(alg: string, signingInput: string, signature: Buffer, jwk: crypto.JsonWebKey): boolean {
  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    return false;
  }
  const digest = `sha${alg.slice(2)}` as const;
  const data = Buffer.from(signingInput, 'utf8');
  try {
    if (alg.startsWith('RS')) {
      return crypto.verify(digest, data, { key, padding: crypto.constants.RSA_PKCS1_PADDING }, signature);
    }
    if (alg.startsWith('PS')) {
      return crypto.verify(
        digest,
        data,
        { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST },
        signature,
      );
    }
    // ES: JWS carries the raw r||s pair, not the DER sequence OpenSSL defaults
    // to. `ieee-p1363` is that encoding by name.
    return crypto.verify(digest, data, { key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    return false;
  }
}

/**
 * Refusals 12, 1, 2 and 3 — the envelope. Shared by ID tokens and back-channel
 * logout tokens, because §8.2 requires a logout token to be "validated exactly
 * as an ID token" for this part.
 */
export async function verifySignedToken(input: SignedTokenEnvelopeInput): Promise<{ header: IdTokenHeader; claims: IdTokenClaims }> {
  // ── refusal 12: bounded, and BEFORE parsing ─────────────────────────────
  if (typeof input.token !== 'string' || Buffer.byteLength(input.token, 'utf8') > MAX_ID_TOKEN_BYTES) {
    refuse('TOKEN_TOO_LARGE', 'the ID token exceeds the accepted size');
  }
  const parts = input.token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    refuse('TOKEN_MALFORMED', 'the ID token is not a three-part compact JWS');
  }
  const [headerSegment, payloadSegment, signatureSegment] = parts;

  const header = decodeSegment(headerSegment, 'header') as IdTokenHeader;
  if (typeof header !== 'object' || header === null) refuse('TOKEN_MALFORMED', 'the ID token header is not an object');

  // ── refusal 1: alg ──────────────────────────────────────────────────────
  const alg = typeof header.alg === 'string' ? header.alg : '';
  if (!(ALLOWED_ID_TOKEN_ALGS as readonly string[]).includes(alg)) {
    refuse('ALG_NOT_ALLOWED', `the ID token algorithm '${alg}' is not an accepted asymmetric algorithm`);
  }
  // UNCONDITIONAL (review round 3, R2 B1). This used to be guarded by
  // `advertisedAlgs.length > 0`, so a provider whose discovery document omits
  // `id_token_signing_alg_values_supported` — which the service maps to [] —
  // advertised NOTHING and yet had every allowlisted algorithm accepted.
  // §5.3 refusal 1 requires `alg` in BOTH the asymmetric allowlist and the
  // provider's advertised set, and an empty advertised set contains nothing.
  // OpenID Discovery makes the field REQUIRED, so absence is a malformed
  // document, not a permissive one.
  if (!input.advertisedAlgs.includes(alg)) {
    refuse('ALG_NOT_ALLOWED', `the Identity provider does not advertise '${alg}' for ID tokens`);
  }

  // ── refusal 2: kid ──────────────────────────────────────────────────────
  const kid = typeof header.kid === 'string' && header.kid.length > 0 ? header.kid : null;
  if (kid === null) refuse('KID_UNRESOLVED', 'the ID token header names no key');
  let jwk: crypto.JsonWebKey;
  try {
    jwk = await input.resolveKey(kid);
  } catch {
    // The resolver's own message is DISCARDED rather than substituted in. Its
    // two failure modes — an unpublished `kid` and a cooling-down refresh
    // window (T-SS9) — are distinguishable to an attacker probing with random
    // `kid` values, and a validator that reports which one it hit would tell
    // them when the window reopens.
    refuse('KID_UNRESOLVED', 'the ID token signing key could not be resolved');
  }

  // ── refusal 3: signature, BEFORE any claim is read ──────────────────────
  let signature: Buffer;
  try {
    signature = Buffer.from(signatureSegment, 'base64url');
  } catch {
    return refuse('TOKEN_MALFORMED', 'the ID token signature is not base64url');
  }
  if (!verifySignature(alg, `${headerSegment}.${payloadSegment}`, signature, jwk)) {
    refuse('SIGNATURE_INVALID', 'the ID token signature does not verify against the named key');
  }

  // Only now is the payload data rather than an attacker's suggestion.
  const claims = decodeSegment(payloadSegment, 'payload') as IdTokenClaims;
  if (typeof claims !== 'object' || claims === null) refuse('TOKEN_MALFORMED', 'the ID token payload is not an object');
  // Refusal 12's second half. The SIZE bound is enforced before parsing, as
  // §5.3 requires; the CLAIM COUNT cannot be, because counting claims means
  // parsing them. Parsing them before the signature check would break refusal
  // 3, which is the stronger rule — so the count is enforced at the first
  // moment the payload is trustworthy, and an oversized token never reaches
  // here because the byte bound already refused it.
  if (Object.keys(claims).length > MAX_ID_TOKEN_CLAIMS) {
    refuse('TOKEN_TOO_LARGE', 'the ID token carries more claims than the accepted bound');
  }

  return { header, claims };
}

export async function validateIdToken(input: IdTokenValidationInput): Promise<ValidatedIdToken> {
  const now = input.now ? input.now() : Date.now();
  const skewMs = Math.max(0, input.clockSkewSeconds) * 1000;
  const { header, claims } = await verifySignedToken(input);

  // ── refusal 4: iss, byte-equal ──────────────────────────────────────────
  if (claims.iss !== input.issuer) {
    refuse('ISSUER_MISMATCH', 'the ID token issuer is not the configured issuer');
  }

  // ── refusal 5: aud (and azp when aud is multi-valued) ───────────────────
  const audience = claims.aud;
  const audiences = Array.isArray(audience) ? audience : [audience];
  if (!audiences.includes(input.clientId)) {
    refuse('AUDIENCE_MISMATCH', 'the ID token audience does not contain the configured client id');
  }
  if (audiences.length > 1 && claims.azp !== input.clientId) {
    refuse('AUDIENCE_MISMATCH', 'a multi-valued audience requires azp to equal the configured client id');
  }

  // ── refusal 6: exp / iat / nbf within skew ──────────────────────────────
  const seconds = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value * 1000 : null;
  const exp = seconds(claims.exp);
  const iat = seconds(claims.iat);
  if (exp === null || iat === null) refuse('TIME_WINDOW', 'the ID token has no usable exp or iat');
  if (exp + skewMs <= now) refuse('TIME_WINDOW', 'the ID token has expired');
  if (iat - skewMs > now) refuse('TIME_WINDOW', 'the ID token was issued in the future');
  const nbf = seconds(claims.nbf);
  if (nbf !== null && nbf - skewMs > now) refuse('TIME_WINDOW', 'the ID token is not yet valid');

  // ── refusal 7: nonce ────────────────────────────────────────────────────
  const nonce = typeof claims.nonce === 'string' && claims.nonce.length > 0 ? claims.nonce : null;
  if (nonce === null) refuse('NONCE_MISMATCH', 'the ID token carries no nonce');
  if (input.hashNonce(nonce) !== input.expectedNonceHash) {
    refuse('NONCE_MISMATCH', 'the ID token nonce does not match the pending authentication request');
  }

  // ── refusal 8: sub — opaque, never parsed, split, lowercased, normalised ─
  const subject = claims.sub;
  if (typeof subject !== 'string' || subject.length === 0 || Buffer.byteLength(subject, 'utf8') > 255) {
    refuse('SUBJECT_INVALID', 'the ID token subject is absent, empty or over 255 bytes');
  }

  // ── refusal 9: auth_time, whenever the request carried max_age ──────────
  if (input.maxAgeRequested !== null && input.maxAgeRequested !== undefined) {
    const authTime = seconds(claims.auth_time);
    if (authTime === null) {
      refuse('AUTH_TIME_STALE', 'the request carried max_age but the ID token has no auth_time');
    }
    // §8.3: compared against the instant the step-up was REQUESTED, not against
    // "now". An authentication that predates the request did not satisfy it —
    // which is how an Identity provider that ignores max_age is DETECTED
    // rather than trusted.
    const requestedAtMs = input.requestedAt ? input.requestedAt.getTime() : now;
    // NO skew allowance here, and that is the point (review R2 round 1, F2).
    // Everywhere else skew absorbs clock drift between two machines. This
    // comparison is not measuring drift: it exists to DETECT a provider that
    // ignored max_age=0 and replayed an older authentication, and both
    // timestamps come from a causal ordering we control — the request was made
    // before the token was issued. Adding skew to auth_time bought an attacker
    // a whole skew window of pre-request authentication.
    if (authTime < requestedAtMs) {
      refuse('AUTH_TIME_STALE', 'the ID token auth_time predates the step-up request');
    }
  }

  // ── refusal 10: required_claims ─────────────────────────────────────────
  for (const [claim, permitted] of Object.entries(input.requiredClaims ?? {})) {
    const actual = claims[claim];
    const allowed = Array.isArray(permitted) ? permitted : [permitted];
    if (typeof actual !== 'string' || !allowed.includes(actual)) {
      refuse('REQUIRED_CLAIM_MISSING', `the ID token does not carry a permitted value for the required claim '${claim}'`);
    }
  }

  return {
    header,
    claims,
    subject,
    sid: typeof claims.sid === 'string' && claims.sid.length > 0 ? claims.sid : null,
  };
}


/**
 * §8.2 — the back-channel logout token.
 *
 * Validated as an ID token for refusals 1-6 and 8 (shared envelope above, plus
 * the issuer/audience/time claims here) **PLUS** four rules that are specific
 * to a logout notification:
 *
 *   * the `events` claim must contain the OIDC back-channel logout member;
 *   * a `nonce` claim must be **ABSENT** — its presence means an ID token is
 *     being replayed as a logout token, which is the T-SS10 vector;
 *   * `sid` or `sub` must be present, because a token that identifies nothing
 *     could only be a request to revoke everything;
 *   * `now - iat` must not exceed MAX_LOGOUT_TOKEN_AGE_SECONDS.
 *
 * The maximum age is not decoration. SS-23 stores a replay row until the later
 * of the token's own expiry and this bound; without a bound on age, a
 * long-lived token could outlive its replay row and become fresh again
 * (round-5 F6). The two changes only work together, so they are written
 * together.
 *
 * Refusal 7 (nonce present and matching) is deliberately INVERTED here rather
 * than skipped: a logout token carrying a nonce is refused.
 */
export const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
export const MAX_LOGOUT_TOKEN_AGE_SECONDS = 300;

export interface LogoutTokenValidationInput extends SignedTokenEnvelopeInput {
  issuer: string;
  clientId: string;
  clockSkewSeconds: number;
  now?: () => number;
}

export interface ValidatedLogoutToken {
  claims: IdTokenClaims;
  sid: string | null;
  subject: string | null;
  /** SS-23's replay key: the `jti` when the provider emits one. */
  jti: string | null;
  /** The token's own expiry, so the replay row cannot be swept too early. */
  expiresAt: Date;
}

export async function validateLogoutToken(input: LogoutTokenValidationInput): Promise<ValidatedLogoutToken> {
  const now = input.now ? input.now() : Date.now();
  const skewMs = Math.max(0, input.clockSkewSeconds) * 1000;
  const { claims } = await verifySignedToken(input);

  if (claims.iss !== input.issuer) {
    refuse('ISSUER_MISMATCH', 'the logout token issuer is not the configured issuer');
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(input.clientId)) {
    refuse('AUDIENCE_MISMATCH', 'the logout token audience does not contain the configured client id');
  }
  if (audiences.length > 1 && claims.azp !== input.clientId) {
    refuse('AUDIENCE_MISMATCH', 'a multi-valued audience requires azp to equal the configured client id');
  }

  const seconds = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value * 1000 : null;
  const exp = seconds(claims.exp);
  const iat = seconds(claims.iat);
  if (exp === null || iat === null) refuse('TIME_WINDOW', 'the logout token has no usable exp or iat');
  if (exp + skewMs <= now) refuse('TIME_WINDOW', 'the logout token has expired');
  if (iat - skewMs > now) refuse('TIME_WINDOW', 'the logout token was issued in the future');
  if (now - iat > MAX_LOGOUT_TOKEN_AGE_SECONDS * 1000 + skewMs) {
    refuse('TIME_WINDOW', 'the logout token is older than the maximum accepted age');
  }
  // §8.2 takes ID-token refusals 1-6 and 8, and refusal 6 includes nbf. It was
  // absent here while the ID-token path had it (review R2 round 1, F3): a
  // correctly signed token explicitly NOT YET VALID was consumed and could
  // revoke sessions.
  const nbf = seconds(claims.nbf);
  if (nbf !== null && nbf - skewMs > now) {
    refuse('TIME_WINDOW', 'the logout token is not yet valid');
  }

  // An ID token replayed as a logout token carries a nonce. A logout token
  // never legitimately does.
  if (claims.nonce !== undefined) {
    refuse('NONCE_MISMATCH', 'a logout token must not carry a nonce (an ID token is being replayed)');
  }

  const events = claims.events;
  const hasEvent =
    typeof events === 'object' &&
    events !== null &&
    Object.prototype.hasOwnProperty.call(events, BACKCHANNEL_LOGOUT_EVENT);
  if (!hasEvent) {
    refuse('REQUIRED_CLAIM_MISSING', 'the logout token does not carry the back-channel logout event');
  }

  const sid = typeof claims.sid === 'string' && claims.sid.length > 0 ? claims.sid : null;
  const subject = typeof claims.sub === 'string' && claims.sub.length > 0 ? claims.sub : null;
  if (sid === null && subject === null) {
    refuse('SUBJECT_INVALID', 'the logout token names neither a sid nor a sub');
  }
  if (subject !== null && Buffer.byteLength(subject, 'utf8') > 255) {
    refuse('SUBJECT_INVALID', 'the logout token subject is over 255 bytes');
  }

  return {
    claims,
    sid,
    subject,
    jti: typeof claims.jti === 'string' && claims.jti.length > 0 ? claims.jti : null,
    expiresAt: new Date(exp),
  };
}

/**
 * Refusal 11, as its own step because UserInfo is its own request.
 *
 * A mismatch is a refusal AND THE RESPONSE IS DISCARDED — a UserInfo document
 * for a different subject must not reach profile mapping by any path.
 */
export function assertUserInfoSubject(userInfo: unknown, expectedSubject: string): void {
  const sub =
    typeof userInfo === 'object' && userInfo !== null ? (userInfo as { sub?: unknown }).sub : undefined;
  if (typeof sub !== 'string' || sub !== expectedSubject) {
    refuse('USERINFO_SUBJECT_MISMATCH', 'the UserInfo response names a different subject than the ID token');
  }
}
