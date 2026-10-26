/**
 * SsoAuthenticationRequestService — the pending-authentication row (SS-18;
 * design `d95136d7` §5.0; threat rows T-SS2, T-SS3, T-SS10c).
 *
 * This row is the vehicle EVERY §5.3 refusal depends on. Without it, `state`,
 * `nonce`, PKCE and consume-on-attempt have nowhere to live — which is exactly
 * what v1 of the design got wrong: it described the row in prose and never gave
 * it a schema.
 *
 * ── WHAT IS STORED, AND WHAT DELIBERATELY IS NOT ──
 *
 * The RAW `state` and `nonce` are never stored — only their SHA-256 digests. A
 * database read must not let its holder complete a pending flow. The PKCE
 * verifier is the one exception, because it must be SENT: it is encrypted under
 * the AUTHZ §7.2 envelope keyset (the same keyset, canary and rotation as
 * SS-7), bound by AEAD additional data to its own row id, and revealed on no
 * surface.
 *
 * ── SINGLE-USE IS ENFORCED BY THE WRITE ──
 *
 * Consumption is ONE conditional statement:
 *
 *     UPDATE ... SET consumed_at = now() WHERE state_hash = $1
 *       AND consumed_at IS NULL AND expires_at > now() RETURNING *
 *
 * so two concurrent callbacks cannot both proceed — the loser sees zero rows
 * and is refused. A check-then-act would be a race, and this programme has paid
 * for that shape before. The W2 red proof replaces this statement with
 * check-then-act and requires the concurrency test to go red.
 *
 * The row is consumed ON THE ATTEMPT, not on success — C6's own rule for
 * authorization codes, for the same reason: a verifier must not be guessable
 * online.
 *
 * ── EXPIRY IS EVALUATED LIVE, NEVER LEFT TO THE SWEEP ──
 *
 * `expires_at > now()` is in the consuming statement itself, so an expired row
 * is refused between sweeps. The sweep only deletes rows that are ALREADY dead
 * — exactly the AUTHZ §7.3 split where liveness is evaluated in the hot path
 * and the sweep merely persists the outcome.
 */
import crypto from 'crypto';
import { pool } from '../../db/connection';
import { decryptCredentialSecret, encryptCredentialSecret } from '../../utils/credentialCrypto';

/** SHA-256 hex. The same function hashes on the way in and on comparison. */
export function hashOpaqueValue(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** §5.1: `state` and `nonce` are INDEPENDENT 128-bit random values. */
export function mintOpaqueValue(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/** RFC 7636 S256. `plain` is never used and never accepted as a downgrade. */
export function pkceChallengeFor(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export function mintPkceVerifier(): string {
  // 43-128 characters of the unreserved set; 32 random bytes base64url is 43.
  return crypto.randomBytes(32).toString('base64url');
}

export interface PendingAuthenticationRequest {
  id: string;
  identityProviderId: string;
  nonceHash: string;
  redirectUri: string;
  returnRef: string | null;
  maxAgeRequested: number | null;
  requestedAt: Date;
  expiresAt: Date;
  /**
   * Card a3e76724: the step-up this request re-authenticates FOR, or null for
   * a login. Written by the server from the calling login session, never from
   * a caller value; the callback proves it only for the SAME Account.
   */
  stepUp: StepUpBinding | null;
}

export interface StepUpBinding {
  principalId: string;
  action: string;
  targetId: string;
}

export interface CreatePendingRequestInput {
  identityProviderId: string;
  state: string;
  nonce: string;
  pkceVerifier: string;
  redirectUri: string;
  returnRef?: string | null;
  maxAgeRequested?: number | null;
  /** Card a3e76724: present only for a step-up re-authentication. */
  stepUp?: StepUpBinding | null;
  ttlSeconds: number;
}

/**
 * Card a3e76724: how a step-up proof stands when its Account tries to
 * collect it. Every arm except `collected` is a refusal the route types.
 */
export type StepUpCollection =
  | { status: 'collected'; binding: StepUpBinding; identityProviderId: string; requestId: string }
  | { status: 'unknown' | 'pending' | 'refused' | 'already_collected' | 'expired' };

/**
 * How long a proven re-authentication may wait to be exchanged for its token.
 * The dialog collects the moment the Identity provider window lands, so the
 * window only has to cover a person switching back to the dashboard; it is
 * short because the token minted from it lives another five minutes.
 */
export const STEP_UP_PROOF_WINDOW_SECONDS = 120;

const PENDING_COLUMNS = `id, identity_provider_id, nonce_hash, redirect_uri, return_ref,
                 max_age_requested, requested_at, expires_at,
                 step_up_principal_id, step_up_action, step_up_target_id`;

export class SsoAuthenticationRequestService {
  async create(input: CreatePendingRequestInput): Promise<PendingAuthenticationRequest> {
    // The id is minted here so the AEAD additional data binds the encrypted
    // verifier to its own row before the row exists.
    const id = crypto.randomUUID();
    const verifier = encryptCredentialSecret(input.pkceVerifier, id);
    const stepUp = input.stepUp ?? null;
    const result = await pool.query(
      `INSERT INTO sso_authentication_requests
         (id, identity_provider_id, state_hash, nonce_hash, pkce_verifier_ct, pkce_key_id,
          redirect_uri, return_ref, max_age_requested, expires_at,
          step_up_principal_id, step_up_action, step_up_target_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(secs => $10), $11, $12, $13)
       RETURNING ${PENDING_COLUMNS}`,
      [
        id,
        input.identityProviderId,
        hashOpaqueValue(input.state),
        hashOpaqueValue(input.nonce),
        verifier.ciphertext,
        verifier.encryptionKeyId,
        input.redirectUri,
        input.returnRef ?? null,
        input.maxAgeRequested ?? null,
        input.ttlSeconds,
        stepUp?.principalId ?? null,
        stepUp?.action ?? null,
        stepUp?.targetId ?? null,
      ],
    );
    return mapRow(result.rows[0]);
  }

  /**
   * Consume on the ATTEMPT. One statement, one winner.
   *
   * Returns undefined when the row is absent, already consumed, or expired —
   * three conditions the caller must NOT be able to tell apart, because
   * distinguishing them tells an attacker whether a `state` value existed.
   */
  async consume(state: string): Promise<{ request: PendingAuthenticationRequest; pkceVerifier: string } | undefined> {
    const result = await pool.query(
      `UPDATE sso_authentication_requests
          SET consumed_at = now(), consumed_outcome = 'attempted'
        WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING ${PENDING_COLUMNS}, pkce_verifier_ct, pkce_key_id`,
      [hashOpaqueValue(state)],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      request: mapRow(row),
      pkceVerifier: decryptCredentialSecret(String(row.pkce_verifier_ct), String(row.pkce_key_id), String(row.id)),
    };
  }

  /** Record how a consumed attempt ended, for the support trail. */
  async recordOutcome(id: string, outcome: string): Promise<void> {
    await pool.query('UPDATE sso_authentication_requests SET consumed_outcome = $2 WHERE id = $1', [
      id,
      outcome.slice(0, 64),
    ]);
  }

  /**
   * Card a3e76724: a step-up attempt that was refused AFTER its row was
   * consumed. Only an outcome still reading `attempted` is overwritten, so a
   * specific one an earlier arm recorded (`cookie_mismatch`, `iss_mismatch`)
   * survives; what this adds is that a refusal thrown by token validation can
   * no longer look like a callback that is still in flight.
   */
  async recordStepUpRefusal(id: string): Promise<void> {
    await pool.query(
      `UPDATE sso_authentication_requests SET consumed_outcome = 'step_up_refused'
        WHERE id = $1 AND step_up_principal_id IS NOT NULL AND consumed_outcome = 'attempted'`,
      [id],
    );
  }

  /**
   * Card a3e76724: the callback PROVED this step-up — fresh `auth_time`, same
   * Account. Written once: the row is already consumed by this callback, and
   * the predicate refuses a second proof of the same row.
   */
  async markStepUpProven(id: string, principalId: string): Promise<boolean> {
    const result = await pool.query(
      `UPDATE sso_authentication_requests
          SET step_up_proven_at = now(), consumed_outcome = 'step_up_proven'
        WHERE id = $1 AND step_up_principal_id = $2 AND step_up_proven_at IS NULL
          AND consumed_at IS NOT NULL`,
      [id, principalId],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /**
   * Card a3e76724: exchange a proof for the right to mint ONE step-up token.
   *
   * ONE conditional statement, one winner — the same shape `consume` uses —
   * so a replayed or concurrent collection cannot mint twice. The Account is
   * part of the predicate: a request id is not a capability, and another
   * Account presenting it is answered exactly as an id that names nothing.
   */
  async collectStepUp(id: string, principalId: string): Promise<StepUpCollection> {
    const result = await pool.query(
      `UPDATE sso_authentication_requests
          SET step_up_collected_at = now(), consumed_outcome = 'step_up_collected'
        WHERE id = $1 AND step_up_principal_id = $2
          AND step_up_proven_at IS NOT NULL AND step_up_collected_at IS NULL
          AND step_up_proven_at > now() - make_interval(secs => $3)
        RETURNING id, identity_provider_id, step_up_principal_id, step_up_action, step_up_target_id`,
      [id, principalId, STEP_UP_PROOF_WINDOW_SECONDS],
    );
    const won = result.rows[0];
    if (won) {
      return {
        status: 'collected',
        requestId: String(won.id),
        identityProviderId: String(won.identity_provider_id),
        binding: {
          principalId: String(won.step_up_principal_id),
          action: String(won.step_up_action),
          targetId: String(won.step_up_target_id),
        },
      };
    }
    // The loser is told WHY, but only about its own row: the read carries the
    // same Account predicate, so a foreign or absent id is `unknown`.
    const seen = await pool.query(
      `SELECT consumed_at, consumed_outcome, expires_at, step_up_proven_at, step_up_collected_at
         FROM sso_authentication_requests WHERE id = $1 AND step_up_principal_id = $2`,
      [id, principalId],
    );
    const row = seen.rows[0];
    if (!row) return { status: 'unknown' };
    if (row.step_up_collected_at) return { status: 'already_collected' };
    if (row.step_up_proven_at) return { status: 'expired' };
    if (!row.consumed_at) {
      return new Date(row.expires_at as Date).getTime() > Date.now() ? { status: 'pending' } : { status: 'expired' };
    }
    // Consumed, not proven. `attempted` is a callback still between its
    // consume and its verdict; anything else is that verdict.
    return row.consumed_outcome === 'attempted' ? { status: 'pending' } : { status: 'refused' };
  }

  /**
   * The sweep, run by the existing scheduled maintenance worker as one more
   * task — not a new daemon.
   *
   * Eligibility is `expires_at < now()` OR consumed and older than the
   * retention window (default 24h, kept only so a support question about a
   * failed login has an audit trail). LIVE, UNCONSUMED, UNEXPIRED ROWS ARE
   * STRUCTURALLY OUT OF REACH of this predicate, which is the property the W2
   * acceptance proves in both directions.
   */
  async sweep(retentionHours = 24): Promise<number> {
    const result = await pool.query(
      `DELETE FROM sso_authentication_requests
        WHERE expires_at < now()
           OR (consumed_at IS NOT NULL AND consumed_at < now() - make_interval(hours => $1))`,
      [retentionHours],
    );
    return result.rowCount ?? 0;
  }
}

function mapRow(row: Record<string, unknown>): PendingAuthenticationRequest {
  return {
    id: String(row.id),
    identityProviderId: String(row.identity_provider_id),
    nonceHash: String(row.nonce_hash),
    redirectUri: String(row.redirect_uri),
    returnRef: row.return_ref === null || row.return_ref === undefined ? null : String(row.return_ref),
    maxAgeRequested:
      row.max_age_requested === null || row.max_age_requested === undefined ? null : Number(row.max_age_requested),
    requestedAt: row.requested_at as Date,
    expiresAt: row.expires_at as Date,
    stepUp:
      row.step_up_principal_id === null || row.step_up_principal_id === undefined
        ? null
        : {
          principalId: String(row.step_up_principal_id),
          action: String(row.step_up_action),
          targetId: String(row.step_up_target_id),
        },
  };
}

export const ssoAuthenticationRequestService = new SsoAuthenticationRequestService();
