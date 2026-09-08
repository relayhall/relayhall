import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { pool } from '../db/connection';
import { auditService, AuditActor } from './AuditService';
import { CredentialPolicyError, Principal, principalService } from './PrincipalService';
import { refusesCredentials } from '../utils/credentialAuthority';

/**
 * The per-Account password credential — SS-W1's authentication vehicle
 * (design `d95136d7` §8.1).
 *
 * The row is `principal_credentials.credential_type='password'` with a bcrypt
 * `secret_hash`, which migration 062 already permits (`062:34-38`); no
 * migration is needed and none is added by this wave.
 *
 * **This is not a bearer credential and this file must never become one.**
 * AUTHZ `4d961e37` §7.1 forbids bearer keys on Accounts and, in the same
 * sentence, names passwords as how Accounts authenticate: a password is
 * presented once, at the login endpoint, to obtain a session. It is accepted
 * on no board route, it authorises nothing on its own, and it can never be an
 * `Authorization: Bearer` value. `key_id` is deliberately left NULL, so these
 * rows never touch `ux_pcred_active_key_id` (annex Appendix C).
 */

export const BCRYPT_ROUNDS = 10;

/**
 * bcrypt silently truncates its input at 72 bytes. Accepting a longer
 * password would mean two different passwords authenticating one Account
 * without anyone being told, so a too-long password is refused by name.
 */
export const MAX_PASSWORD_BYTES = 72;
export const MIN_PASSWORD_LENGTH = 12;

/** A refusal of the password policy, in the shape both callers report it. */
export interface PasswordPolicyRefusal {
  code: 'PASSWORD_TOO_SHORT' | 'PASSWORD_TOO_LONG';
  message: string;
}

/**
 * THE password policy, stated once.
 *
 * `set()` below and the first-run act (`FirstRunService`) both write a
 * `credential_type='password'` row, and a policy stated in two places is a
 * policy that can differ in two places: a first-run administrator admitted at
 * 8 characters would be a weaker credential than the same Account could set
 * for itself a minute later. Returns null when the value is acceptable.
 */
export function checkPasswordPolicy(password: unknown): PasswordPolicyRefusal | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return {
      code: 'PASSWORD_TOO_SHORT',
      message: `A password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    };
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return {
      code: 'PASSWORD_TOO_LONG',
      message: `A password must be at most ${MAX_PASSWORD_BYTES} bytes (bcrypt truncates beyond that)`,
    };
  }
  return null;
}

/**
 * A throwaway hash compared against when no password credential exists, so an
 * unknown Account costs the same wall-clock as a wrong password and the
 * endpoint does not enumerate handles by timing. Built once, from random
 * bytes, so no fixed hash literal sits in the published source.
 */
let equalisingHash: string | undefined;
async function equalisingCompare(password: string): Promise<void> {
  if (!equalisingHash) {
    equalisingHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), BCRYPT_ROUNDS);
  }
  await bcrypt.compare(password, equalisingHash);
}

export interface VerifiedPassword {
  principal: Principal;
  /** The `principal_credentials` row that proved it, for the session's FK. */
  credentialId: string;
}

export class AccountPasswordService {
  /**
   * Set (or replace) an Account's password.
   *
   * The predecessor row is revoked in the same transaction as the successor's
   * insert, so an Account can never hold two live passwords and a failed
   * replacement can never leave it with none.
   */
  async set(principalId: string, password: unknown, actor: AuditActor): Promise<void> {
    const refuse = async (status: number, code: string, message: string): Promise<never> => {
      await auditService.record({
        action: 'credential.password.set', actor, outcome: 'denied',
        resourceType: 'principal', resourceId: principalId,
        metadata: { refusal: code },
      }).catch(() => undefined);
      throw new CredentialPolicyError(status, code, message);
    };

    const policy = checkPasswordPolicy(password);
    if (policy) {
      await refuse(422, policy.code, policy.message);
    }
    const value = password as string;

    const principal = await principalService.getPrincipalById(principalId);
    if (!principal) {
      await refuse(422, 'PRINCIPAL_NOT_FOUND', 'principalId resolves to no principal');
    }
    const target = principal as Principal;
    if (refusesCredentials(target.handle)) {
      await refuse(422, 'PRINCIPAL_REFUSES_CREDENTIALS',
        `'${target.handle}' is the request-less internal actor and holds no credential`);
    }
    if (target.kind !== 'human') {
      // AUTHZ §7.1: humans authenticate by password/SSO login sessions.
      // Service Accounts act through their Connectors, Agents through the
      // delegation machinery — neither has a login page to reach.
      await refuse(422, 'PASSWORD_IS_FOR_HUMANS',
        'Only human Accounts hold a password (design 4d961e37 §7.1)');
    }
    if (target.status !== 'active') {
      await refuse(409, 'PRINCIPAL_NOT_ACTIVE',
        'A disabled or terminated Account cannot be given a password');
    }

    const secretHash = await bcrypt.hash(value, BCRYPT_ROUNDS);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE principal_credentials
            SET revoked_at = now()
          WHERE principal_id = $1 AND credential_type = 'password' AND revoked_at IS NULL`,
        [principalId],
      );
      await client.query(
        `INSERT INTO principal_credentials (principal_id, credential_type, secret_hash, label, created_by_principal_id)
         VALUES ($1, 'password', $2, 'Login password', $3)`,
        [principalId, secretHash, actor.principalId ?? null],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    await auditService.record({
      action: 'credential.password.set', actor,
      resourceType: 'principal', resourceId: principalId,
      metadata: { handle: target.handle },
    }).catch(() => undefined);
  }

  /** Retire an Account's password without deleting its history. */
  async clear(principalId: string, actor: AuditActor): Promise<number> {
    const result = await pool.query(
      `UPDATE principal_credentials
          SET revoked_at = now()
        WHERE principal_id = $1 AND credential_type = 'password' AND revoked_at IS NULL`,
      [principalId],
    );
    const cleared = result.rowCount ?? 0;
    if (cleared > 0) {
      await auditService.record({
        action: 'credential.password.clear', actor,
        resourceType: 'principal', resourceId: principalId,
        metadata: { revoked: cleared },
      }).catch(() => undefined);
    }
    return cleared;
  }

  /** Whether an Account currently holds a live password credential. */
  async has(principalId: string): Promise<boolean> {
    const result = await pool.query(
      `SELECT 1 FROM principal_credentials
        WHERE principal_id = $1 AND credential_type = 'password' AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
        LIMIT 1`,
      [principalId],
    );
    return result.rows.length > 0;
  }

  /**
   * Verify a handle + password pair.
   *
   * Every failure arm costs one bcrypt compare, so "no such Account", "that
   * Account has no password" and "wrong password" are indistinguishable to a
   * caller timing the endpoint. The single `undefined` return keeps them
   * indistinguishable in the response too.
   */
  async verify(handle: unknown, password: unknown): Promise<VerifiedPassword | undefined> {
    const candidateHandle = typeof handle === 'string' ? handle.trim().toLowerCase() : '';
    const candidatePassword = typeof password === 'string' ? password : '';
    if (!candidateHandle || !candidatePassword) {
      await equalisingCompare(candidatePassword);
      return undefined;
    }

    const principal = await principalService.getPrincipalByHandle(candidateHandle);
    if (!principal || principal.kind !== 'human' || principal.status !== 'active') {
      await equalisingCompare(candidatePassword);
      return undefined;
    }

    const result = await pool.query(
      `SELECT id, secret_hash FROM principal_credentials
        WHERE principal_id = $1 AND credential_type = 'password' AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY created_at DESC
        LIMIT 1`,
      [principal.id],
    );
    const row = result.rows[0];
    if (!row || typeof row.secret_hash !== 'string' || !row.secret_hash) {
      await equalisingCompare(candidatePassword);
      return undefined;
    }

    const matches = await bcrypt.compare(candidatePassword, row.secret_hash);
    if (!matches) return undefined;

    // Round-1 review P1: this is the FOURTH write in the shape card 8491557e
    // exists for — fire-and-forget liveness telemetry, on the same credential
    // row for one Account, on the shared pool — and it was missed by the census
    // that found the other three. Unbounded, concurrent successful password
    // logins for one Account convoy on that row's tuple lock while holding
    // pooled connections, which is the availability failure the card closes.
    // It carries no SQL of its own any more: the one bounded writer owns the
    // statement, so a fifth caller cannot arrive by copying this one.
    principalService.bumpCredentialLastUsed(String(row.id));
    return { principal, credentialId: String(row.id) };
  }
}

export const accountPasswordService = new AccountPasswordService();
