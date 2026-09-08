import crypto from 'crypto';
import net from 'net';
import { pool } from '../db/connection';
import { encryptCredentialSecret } from '../utils/credentialCrypto';
import { presenceWriter, PRESENCE_THROTTLE_MS } from '../db/boundedPresenceWrites';

/**
 * Per-Account login sessions — SS-W1 of the SSO design (`d95136d7` §8.1,
 * acceptance annex `e6dcadb9` §11).
 *
 * This activates the `auth_sessions` substrate migration 062 shipped dormant.
 * It is NOT a stopgap for OIDC: it is the substrate the relying-party leg
 * plugs into, so session issue, expiry, logout, listing and revocation are
 * built once here and reused by SS-W2 unchanged.
 *
 * A login session is not a bearer credential (AUTHZ `4d961e37` A17.1/§7.1):
 * the opaque token is delivered only as an httpOnly cookie, is never accepted
 * in an `Authorization` header, and authorises nothing on its own — the
 * authority is the Account's, resolved live on every request.
 */

/** The cookie the dormant middleware step already reads (062, spec §2.1/6). */
export const SESSION_COOKIE_NAME = 'relayhall_session';

/** Exactly the values 062:70 enumerates for `auth_sessions.revoke_reason`. */
export const REVOKE_REASONS = [
  'logout',
  'idp_backchannel',
  'disabled_user',
  'admin',
  'expired_sweep',
] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];

/** Idle window: a session unused for this long stops resolving. */
const DEFAULT_IDLE_MINUTES = 720; // 12 hours
/**
 * Absolute cap: parity with the 30-day dashboard JWT this sits beside, so
 * activating sessions is not silently a session-length regression.
 */
const DEFAULT_ABSOLUTE_HOURS = 720; // 30 days

function boundedEnvInt(envName: string, fallback: number, min: number, max: number): number {
  const raw = process.env[envName];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  if (parsed < min || parsed > max) return fallback;
  return parsed;
}

/** Read at call time, like the feature flags, so tests can vary per case. */
export function sessionIdleMs(): number {
  return boundedEnvInt('RELAYHALL_SESSION_IDLE_MINUTES', DEFAULT_IDLE_MINUTES, 1, 43_200) * 60_000;
}

export function sessionAbsoluteMs(): number {
  return boundedEnvInt('RELAYHALL_SESSION_ABSOLUTE_HOURS', DEFAULT_ABSOLUTE_HOURS, 1, 8_760) * 3_600_000;
}

/**
 * The coalescing window for the liveness touch, BOUNDED BY THE IDLE WINDOW IT
 * FEEDS (card 8491557e).
 *
 * `resolve` refuses a session whose `last_seen_at` is older than
 * `sessionIdleMs()`. A coalescing window at or above that span could therefore
 * let an ACTIVELY USED session idle out between two permitted writes — a bound
 * on a liveness write becoming a liveness bug. The idle window is
 * operator-configurable down to ONE MINUTE, which is the flat 60s budget
 * exactly, so the window is capped at a quarter of it: a deployment that
 * shortens the idle timeout tightens this throttle with it instead of quietly
 * signing people out.
 *
 * Read at call time, like the windows above, so a test can vary it per case.
 */
export function sessionTouchThrottleMs(): number {
  return Math.max(1_000, Math.min(PRESENCE_THROTTLE_MS, Math.floor(sessionIdleMs() / 4)));
}

/** The raw token is never stored; only this digest reaches the database. */
export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface MintedLoginSession {
  /** Returned to the caller ONCE, for the cookie. Never persisted. */
  token: string;
  sessionId: string;
  expiresAt: Date;
}

export interface ResolvedLoginSession {
  sessionId: string;
  principalId: string;
  /** Always NULL for sessions this service mints — see `mint` (SS-9). */
  roleSnapshot: string | null;
}

export interface LoginSessionSummary {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
}

/** `auth_sessions.ip` is INET: a non-address string would fail the insert. */
function normaliseIp(value: unknown): string | null {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return candidate && net.isIP(candidate) !== 0 ? candidate : null;
}

function normaliseUserAgent(value: unknown): string | null {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return candidate ? candidate.slice(0, 512) : null;
}

export class LoginSessionService {
  /**
   * THE typed login-session mint — the only production INSERT into
   * `auth_sessions`.
   *
   * `role_snapshot` is not a parameter of this function and is not named by
   * the statement, so it can only ever be NULL. That is SS-9 enforced by
   * construction rather than by a convention someone has to remember: with a
   * NULL snapshot `resolveActorRole` falls through to `principals.role`, so
   * no external claim can ever mint a board role through a session. 062:61
   * documented the opposite intent; that comment is corrected in this
   * candidate and the mechanism it described is withdrawn.
   */
  async mint(input: {
    principalId: string;
    /** The `principal_credentials` row that proved this login, when there is one. */
    credentialId?: string | null;
    ip?: unknown;
    userAgent?: unknown;
    /**
     * SS-19 (migration 104). Both NULL for a local password session; both
     * populated for a federated one, so provider-scoped revocation is true by
     * construction rather than by a WHERE clause someone has to remember.
     */
    identityProviderId?: string | null;
    identityLinkId?: string | null;
    /** The Identity provider's `sid`, for back-channel logout correlation. */
    oidcSid?: string | null;
    /**
     * SSO-R16: the raw ID token, retained ONLY when this Identity provider
     * opted in. It is encrypted here under the AUTHZ §7.2 envelope keyset and
     * never stored in the clear; disposal is bound to session death.
     */
    idToken?: string | null;
  }): Promise<MintedLoginSession> {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + sessionAbsoluteMs());
    // The session id is minted here so the AEAD additional data can bind the
    // retained ID token to its own row before the row exists.
    const sessionId = crypto.randomUUID();
    const retained = input.idToken ? encryptCredentialSecret(input.idToken, sessionId) : null;
    const result = await pool.query(
      `INSERT INTO auth_sessions
         (id, principal_id, token_hash, credential_id, ip, user_agent, expires_at,
          identity_provider_id, identity_link_id, oidc_sid, id_token_ct, id_token_key_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        sessionId,
        input.principalId,
        hashSessionToken(token),
        input.credentialId ?? null,
        normaliseIp(input.ip),
        normaliseUserAgent(input.userAgent),
        expiresAt,
        input.identityProviderId ?? null,
        input.identityLinkId ?? null,
        input.oidcSid ?? null,
        retained?.ciphertext ?? null,
        retained?.encryptionKeyId ?? null,
      ],
    );
    return { token, sessionId: String(result.rows[0].id), expiresAt };
  }

  /**
   * Resolve a presented token to a live session.
   *
   * Both expiries are enforced HERE, on the read, rather than by a sweep: the
   * absolute cap through `expires_at`, and the idle window against
   * `last_seen_at`. A sweep that stops running must never be able to extend a
   * session's life.
   */
  async resolve(token: string): Promise<ResolvedLoginSession | undefined> {
    const idleCutoff = new Date(Date.now() - sessionIdleMs());
    const result = await pool.query(
      `SELECT s.id AS session_id, s.role_snapshot, s.principal_id
         FROM auth_sessions s
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL
          AND s.expires_at > now() AND s.last_seen_at > $2`,
      [hashSessionToken(token), idleCutoff],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      sessionId: String(row.session_id),
      principalId: String(row.principal_id),
      roleSnapshot: (row.role_snapshot as string | null) ?? null,
    };
  }

  /**
   * SSO-R16 — dispose retained ID tokens on LOGIN SESSIONS that died WITHOUT
   * being revoked (review R2 finding F1, candidate be42278; naming per A23.7,
   * round-2 R1 F2 and R2 F1 — this concept is a login session, never a bare
   * "session" for this concept).
   *
   * The ruling binds disposal to LOGIN-SESSION DEATH, and W3 first read "death"
   * as "revocation": the explicit paths dispose in the same statement that
   * revokes, and the SS-9 census enumerates their column sets. But a login
   * login session also dies by ABSOLUTE EXPIRY and by IDLE TIMEOUT, and those deaths
   * perform no update at all — `resolve` simply stops returning the row. A
   * census over update column sets is structurally blind to a death that writes
   * nothing, which is exactly how the gap survived: the repair had fixed the two
   * statements the census named and left the commonest death beside them.
   *
   * The split is the house one (AUTHZ §7.3, and SS-18 says it in as many
   * words): **liveness is enforced LIVE in the hot path — `resolve` refuses an
   * expired or idle login session whether or not any sweep has ever run — and
   * the sweep merely persists the physical consequence.** So a dead login
   * login session authenticates nothing the instant it dies; what this bounds is how
   * long the encrypted artefact survives on the dead row, which is one sweep
   * interval.
   *
   * Disposal is deliberately NOT attempted on the read path. `resolve` cannot
   * distinguish "this token names a dead login session" from "this token names
   * nothing", so writing there would let anyone drive a write per presented
   * token — an amplifier bought for no extra guarantee.
   *
   * Live login sessions are structurally out of reach of the predicate, and the
   * acceptance proves that direction too: a sweep that disposed of a live login
   * login session's token would break RP-initiated logout for everyone.
   */
  async disposeRetainedTokensOnDeadLoginSessions(): Promise<number> {
    const idleCutoff = new Date(Date.now() - sessionIdleMs());
    const result = await pool.query(
      `UPDATE auth_sessions
          SET id_token_ct = NULL, id_token_key_id = NULL
        WHERE (id_token_ct IS NOT NULL OR id_token_key_id IS NOT NULL)
          AND (revoked_at IS NOT NULL OR expires_at <= now() OR last_seen_at <= $1)`,
      [idleCutoff],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Liveness touch — the ONLY column this lifecycle update is permitted.
   *
   * BOUNDED AND COALESCED through the shared presence writer (card 8491557e).
   * Unthrottled, this wrote the SAME ROW on every authenticated request that
   * carried a session cookie; concurrent UPDATEs of one row serialise on a
   * tuple lock while holding a pooled connection, so a burst from a single
   * session could spend the whole 20-connection pool on bookkeeping and answer
   * 503 AUTHORIZATION_UNAVAILABLE to unrelated requests.
   *
   * Returns whether a write was actually STARTED, so the burst gate can tell a
   * real write from a coalesced one without reading the database.
   */
  touch(sessionId: string): boolean {
    return presenceWriter.submit(
      `session:${sessionId}`,
      () => pool.query('UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1', [sessionId]),
      sessionTouchThrottleMs(),
    );
  }

  /**
   * Revocation — the only other permitted lifecycle update, and its columns.
   *
   * SSO-R16 binds ID-token disposal to session death, so the retained token is
   * dropped in the SAME statement that revokes the session. A disposal that
   * ran later, or on a schedule, would be a retention window nobody declared.
   */
  async revoke(sessionId: string, reason: RevokeReason): Promise<boolean> {
    const result = await pool.query(
      `UPDATE auth_sessions
          SET revoked_at = now(), revoke_reason = $2, id_token_ct = NULL, id_token_key_id = NULL
        WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId, reason],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** "Sign out everywhere", and the vehicle W2's back-channel logout reuses. */
  async revokeAllForPrincipal(
    principalId: string,
    reason: RevokeReason,
    exceptSessionId?: string | null,
  ): Promise<number> {
    const result = await pool.query(
      `UPDATE auth_sessions
          SET revoked_at = now(), revoke_reason = $2, id_token_ct = NULL, id_token_key_id = NULL
        WHERE principal_id = $1 AND revoked_at IS NULL
          AND ($3::uuid IS NULL OR id <> $3::uuid)`,
      [principalId, reason, exceptSessionId ?? null],
    );
    return result.rowCount ?? 0;
  }

  /**
   * An Account's own live sessions. Expired and idle-timed-out rows are
   * filtered by the same two predicates `resolve` applies, so the list can
   * never show a session that would no longer authenticate.
   */
  async list(principalId: string): Promise<LoginSessionSummary[]> {
    const idleCutoff = new Date(Date.now() - sessionIdleMs());
    const result = await pool.query(
      `SELECT s.id, s.created_at, s.last_seen_at, s.expires_at, s.ip, s.user_agent
         FROM auth_sessions s
        WHERE s.principal_id = $1 AND s.revoked_at IS NULL
          AND s.expires_at > now() AND s.last_seen_at > $2
        ORDER BY s.last_seen_at DESC`,
      [principalId, idleCutoff],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      ip: row.ip === null || row.ip === undefined ? null : String(row.ip),
      userAgent: row.user_agent === null || row.user_agent === undefined ? null : String(row.user_agent),
    }));
  }

  /** Ownership check for the self-service revoke route. */
  async ownsSession(principalId: string, sessionId: string): Promise<boolean> {
    const result = await pool.query(
      'SELECT 1 FROM auth_sessions WHERE id = $1 AND principal_id = $2',
      [sessionId, principalId],
    );
    return result.rows.length > 0;
  }
}

export const loginSessionService = new LoginSessionService();
