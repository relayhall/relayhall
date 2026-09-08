/**
 * credentialAcceptance — the ONE credential-acceptance predicate.
 *
 * RH-P3.C2 (review r1/r2 finding B2; ruling ccd53781 "not ruled — mandatory
 * repair"). AUTHZ design 4d961e37 §7.2/§7.3/§7.5.
 *
 * ── Why this module exists ──
 *
 * Two review rounds found the same class of defect: the webhook delivery
 * worker derived an actor from a credential row WITHOUT the gates the real
 * pull path applies, so a credential that `GET /api/events` rejects could
 * still receive that endpoint's data by push. The reviewer reproduced it with
 * an `mcp`-pinned credential: REST ingress returns 403 TRANSPORT_MISMATCH,
 * while the worker accepted the row and cleared `tasks:read`.
 *
 * Repairing that by copying the checks into the worker would have left two
 * implementations to drift apart — and "resembles production" is exactly what
 * the AZ-S3 loop proved insufficient (verdict 87fec3e2 B1: a synthetic actor
 * passed its tests while the real derivation returned empty authority). So
 * the predicate lives HERE and every acceptance path calls it:
 *
 *   - middleware/auth.ts        — REST ingress, per request
 *   - services/PrincipalService — rh_ bearer key authentication
 *   - services/SubscriberActorService — the delivery worker, per pass
 *
 * Parity is therefore BY CONSTRUCTION: a gate added here is enforced on every
 * path at once, and a delivery path can no longer be more permissive than the
 * pull path it mirrors.
 *
 * ── What this module deliberately does NOT do ──
 *
 * It never compares a secret. Proving possession needs the plaintext token and
 * a timing-safe comparison, which belongs to the authenticating path and is
 * meaningless to a background worker that holds no token. What the worker CAN
 * assert is that the credential is one a holder could still authenticate with:
 * right type, a usable stored secret, not revoked, not expired, inside its
 * rotation grace, on an active principal, and permitted on the transport class
 * of the surface being mirrored.
 */
import { routeTransportClassFor, type TransportClass } from './transportMap';

export type CredentialDenial =
  | 'CREDENTIAL_TYPE'
  | 'CREDENTIAL_SECRET_UNUSABLE'
  | 'CREDENTIAL_REVOKED'
  | 'CREDENTIAL_EXPIRED'
  | 'CREDENTIAL_GRACE_ELAPSED'
  | 'PRINCIPAL_NOT_ACTIVE';

/**
 * Whether a stored credential row carries key material a real bearer token
 * could actually authenticate with (review r3, B3).
 *
 * "Non-empty secret_hash" was too weak by half. The production pull path
 * addresses a credential BY `key_id` (`WHERE c.key_id = $1`, from a parsed
 * `rh_<env>_<keyId>.<secret>` token) and then timing-safely compares the
 * presented digest against `secret_hash` decoded as SHA-256 hex. A row with a
 * NULL key id can never be addressed, and a `secret_hash` that is not a
 * 64-character hex digest can never match — so no bearer exists that could
 * pull, while the delivery worker was happily pushing. That is the same
 * safety-floor class as round-2 B2: push authority where pull authority does
 * not exist.
 *
 * Defined here so selection, worker acceptance and pull authentication all
 * ask the SAME question.
 */
const SHA256_HEX = /^[0-9a-f]{64}$/i;

export function isUsableBearerKeyMaterial(keyId: unknown, secretHash: unknown): boolean {
  if (typeof keyId !== 'string' || keyId.trim().length === 0) return false;
  if (typeof secretHash !== 'string') return false;
  return SHA256_HEX.test(secretHash);
}

export interface CredentialAcceptanceInput {
  /** `principal_credentials.credential_type`. Only `api_key` bears tokens. */
  credentialType: unknown;
  /** `principal_credentials.key_id` — how a bearer token addresses this row. */
  keyId?: unknown;
  /** `principal_credentials.secret_hash` — the stored SHA-256 hex digest. */
  secretHash?: unknown;
  /**
   * Legacy shorthand for callers that only know whether a digest exists.
   * Supply `keyId`/`secretHash` instead wherever the row is available: a
   * boolean cannot express "addressable and matchable" (review r3, B3).
   */
  secretHashPresent?: boolean;
  revokedAt: unknown;
  expiresAt: unknown;
  /** §7.3 rotation watermark: a graced predecessor dies AT this instant. */
  graceUntil: unknown;
  /** `principals.status` — active | disabled | terminated (A17.10). */
  principalStatus: unknown;
}

export type CredentialAcceptance =
  | { ok: true }
  | { ok: false; denial: CredentialDenial };

/** A timestamp column as epoch ms, or null when absent/unparseable. */
function instant(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The complete non-secret acceptance sequence, in the production order.
 *
 * `now` is injectable so the grace and expiry boundaries can be pinned
 * exactly at, before and after the watermark rather than raced.
 */
export function evaluateCredentialAcceptance(
  input: CredentialAcceptanceInput,
  now: number = Date.now(),
): CredentialAcceptance {
  // §7.2: only `api_key` credentials bear tokens. A password or JWT-subject
  // row is not a bearer credential and must never be accepted as one — the
  // production query pins this with `AND c.credential_type = 'api_key'`.
  if (String(input.credentialType ?? '') !== 'api_key') {
    return { ok: false, denial: 'CREDENTIAL_TYPE' };
  }
  // Key material that no bearer could authenticate with means nothing may be
  // delivered under it either. When the row itself is available this is the
  // full check — addressable key id AND a digest of the right shape.
  const haveRow = input.keyId !== undefined || input.secretHash !== undefined;
  const usable = haveRow
    ? isUsableBearerKeyMaterial(input.keyId, input.secretHash)
    : input.secretHashPresent === true;
  if (!usable) return { ok: false, denial: 'CREDENTIAL_SECRET_UNUSABLE' };

  if (instant(input.revokedAt) !== null) return { ok: false, denial: 'CREDENTIAL_REVOKED' };

  const expiresAt = instant(input.expiresAt);
  if (expiresAt !== null && expiresAt <= now) return { ok: false, denial: 'CREDENTIAL_EXPIRED' };

  // §7.3: the grace watermark is evaluated LIVE — a graced predecessor
  // authenticates until grace_until and dies then, sweep or no sweep (the
  // between-sweep replay pin). A worker that ignored it would keep delivering
  // under a credential its holder can no longer use.
  const graceUntil = instant(input.graceUntil);
  if (graceUntil !== null && graceUntil <= now) return { ok: false, denial: 'CREDENTIAL_GRACE_ELAPSED' };

  if (String(input.principalStatus ?? '') !== 'active') {
    return { ok: false, denial: 'PRINCIPAL_NOT_ACTIVE' };
  }
  return { ok: true };
}

export type TransportDecision =
  | { allowed: true }
  | { allowed: false; code: 'TRANSPORT_MISMATCH' };

/**
 * The §7.5 transport pin, against SERVER-DERIVED provenance.
 *
 * `stamped` is the class the ingress stamped after transport termination — it
 * is never read from headers, so forged provenance cannot reclassify a call.
 * An UNCLASSIFIED route rejects every non-`any` pin (T26, fail closed).
 *
 * The delivery worker passes the class of the surface it is MIRRORING
 * (`GET /events`, stamped `api`, because a real pull of that surface arrives
 * over REST), so a credential pinned to `mcp` is refused delivery exactly as
 * it is refused the pull.
 */
export function evaluateTransportPin(
  credentialTransport: TransportClass | string | null | undefined,
  mountedPath: string,
  stamped: TransportClass,
): TransportDecision {
  const pin = (credentialTransport as TransportClass) ?? 'any';
  if (pin === 'any') return { allowed: true };
  const routeClass = routeTransportClassFor(mountedPath);
  if (routeClass === undefined || pin !== stamped) {
    return { allowed: false, code: 'TRANSPORT_MISMATCH' };
  }
  return { allowed: true };
}

/**
 * The pull surface a webhook delivery mirrors: `GET /api/events`, which the
 * subscriber would call over REST with its own credential. Named once so the
 * worker and its tests cannot drift from the route the ceiling is taken
 * against (utils/scopeMap `requiredScopeFor('GET', '/events')`).
 */
export const DELIVERY_MIRRORED_PATH = '/events';
export const DELIVERY_MIRRORED_TRANSPORT: TransportClass = 'api';
