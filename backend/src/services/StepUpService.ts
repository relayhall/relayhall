// StepUpService.ts — single-use elevation tokens (RH-P3.AZ-S3; AUTHZ
// design 4d961e37 §7.6, AZ-23, T16).
//
// A step-up token is SHORT-LIVED (5 minutes), SINGLE-USE, and bound to ONE
// named action + target object id. It is minted only after password
// re-entry (OIDC re-auth joins with the Phase-5 SSO binding) and burned by
// the consuming endpoint in the same transaction as the elevated act.
// Step-up authorizes the ACT — it never widens any ceiling (§5.2 rule 1).
import crypto from 'crypto';
import { pool } from '../db/connection';

const STEP_UP_TTL_MS = 5 * 60 * 1000;

export class StepUpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'StepUpError';
  }
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export class StepUpService {
  /** Mint after the CALLER has re-proven the password (the route verifies
   * it before calling). Returns the one-time token value. */
  async mint(principalId: string, action: string, targetId: string, method: 'password' | 'oidc'): Promise<{ token: string; tokenId: string; expiresAt: string }> {
    const token = `rhsu_${crypto.randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + STEP_UP_TTL_MS);
    const result = await pool.query(
      `INSERT INTO step_up_tokens (token_hash, principal_id, action, target_id, method, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [hashToken(token), principalId, action, targetId, method, expiresAt.toISOString()],
    );
    return { token, tokenId: String(result.rows[0].id), expiresAt: expiresAt.toISOString() };
  }

  /**
   * Consume: burns the token if — and only if — it is live, unconsumed,
   * belongs to the calling principal and is bound to EXACTLY this
   * action + target (T16: a plain session, a foreign token, a replay or a
   * re-targeted token all refuse). Returns the audit evidence.
   */
  async consume(
    queryable: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> },
    input: { token: string; principalId: string; action: string; targetId: string },
  ): Promise<{ tokenId: string; method: string }> {
    const result = await queryable.query(
      `UPDATE step_up_tokens
          SET consumed_at = NOW()
        WHERE token_hash = $1
          AND principal_id = $2
          AND action = $3
          AND target_id = $4
          AND consumed_at IS NULL
          AND expires_at > NOW()
        RETURNING id, method`,
      [hashToken(input.token), input.principalId, input.action, input.targetId],
    );
    if (result.rows.length === 0) {
      throw new StepUpError(403, 'STEP_UP_REQUIRED',
        'This act requires a live single-use step-up token bound to exactly this action and target (§7.6)');
    }
    return { tokenId: String(result.rows[0].id), method: String(result.rows[0].method) };
  }
}

export const stepUpService = new StepUpService();
