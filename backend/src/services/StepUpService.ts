// StepUpService.ts — single-use elevation tokens (RH-P3.AZ-S3; AUTHZ
// design 4d961e37 §7.6, AZ-23, T16).
//
// A step-up token is SHORT-LIVED (5 minutes), SINGLE-USE, and bound to ONE
// named action + target object id. It is minted only after the caller has
// proven itself again — password re-entry (`method = 'password'`), or, for an
// Account whose proof is its Identity provider, a fresh re-authentication
// there bound to the same Account, action and target (`method = 'oidc'`,
// card a3e76724; `POST /auth/step-up` then `/auth/step-up/collect`) — and
// burned by the consuming endpoint in the same transaction as the elevated
// act. The consumer neither knows nor cares which proof minted it; it records
// the method in its own audit evidence.
// Step-up authorizes the ACT — it never widens any ceiling (§5.2 rule 1).
import crypto from 'crypto';
import { pool } from '../db/connection';
import { logCaughtFailure } from '../utils/secretSafeLog';
import type { StepUpMethod } from './stepUpMethods';

const STEP_UP_TTL_MS = 5 * 60 * 1000;

/**
 * Card 7a99d63e (SU-13, SU-14): what a refused consumer tells the caller to
 * step up FOR, in the vocabulary of the OAuth 2.0 Step-Up Authentication
 * Challenge (RFC 9470: `insufficient_user_authentication`, `max_age`).
 *
 * RelayHall borrows the vocabulary, not the protocol: its step-up consumers
 * are session-authenticated owner-plane routes, so the challenge rides the
 * JSON body of the existing `403 STEP_UP_REQUIRED` (never a 401, which the
 * dashboard reads as a dead session) and no `WWW-Authenticate` header is
 * sent. It carries no capability: `action` and `targetId` are the binding the
 * caller's own act just tried, and `max_age` is the freshness RelayHall
 * enforces on every step-up (always 0: `auth_time` no earlier than the
 * request).
 *
 * Card 72b8fb97 (SU-14's `methods` member): `methods` is which proofs the
 * CALLER's own Account can give, the same set `GET /auth/step-up/methods`
 * answers (`stepUpMethodsFor`, one decision). It describes the caller only,
 * and is absent only when that lookup itself failed: the refusal is the
 * same `403 STEP_UP_REQUIRED` either way, and the dashboard still asks the
 * methods route. `acr_values` joins when the strength slice ships.
 */
export interface StepUpChallenge {
  error: 'insufficient_user_authentication';
  action: string;
  targetId: string;
  max_age: 0;
  methods?: StepUpMethod[];
}

export class StepUpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly challenge: StepUpChallenge | null = null,
  ) {
    super(message);
    this.name = 'StepUpError';
  }
}

/**
 * The `stepUp` member a route sender spreads into a `STEP_UP_REQUIRED` body,
 * or nothing. Read only from a typed `StepUpError`, never from a caught
 * value's text.
 */
export function stepUpChallengeBody(e: unknown): { stepUp?: StepUpChallenge } {
  return e instanceof StepUpError && e.challenge ? { stepUp: e.challenge } : {};
}

/**
 * The SU-14 challenge for `principalId`'s act on (`action`, `targetId`).
 * Never throws: a failed methods lookup is logged and leaves `methods` out,
 * so a refusal can never become a different answer because of it.
 */
export async function stepUpChallengeFor(
  principalId: string, action: string, targetId: string, queryable?: StepUpQueryable,
): Promise<StepUpChallenge> {
  const challenge: StepUpChallenge = { error: 'insufficient_user_authentication', action, targetId, max_age: 0 };
  try {
    // Required lazily: the methods decision reaches the Identity-provider
    // services, which this low-level store must not load at import time.
    const { stepUpMethodsFor } = require('./stepUpMethods') as typeof import('./stepUpMethods');
    const { methods } = await stepUpMethodsFor({
      principalId,
      localAdministratorPasswordConfigured: Boolean(process.env.DASHBOARD_PASSWORD_HASH),
      // Review r1 (card 72b8fb97): on the consumer's held client, so the
      // challenge never waits for a second pool connection while the act
      // holds its own and its row locks. Plain reads; the act is refused
      // and rolled back by its owner either way.
      ...(queryable ? { queryable } : {}),
    });
    challenge.methods = methods;
  } catch (e) {
    logCaughtFailure('[StepUp] challenge methods lookup failed:', e);
  }
  return challenge;
}

/** A `403 STEP_UP_REQUIRED` carrying the SU-14 challenge, for a consumer that
 * refuses before it reaches `consume` (no token was presented at all). */
export async function stepUpRequiredError(
  principalId: string, action: string, targetId: string, message: string, queryable?: StepUpQueryable,
): Promise<StepUpError> {
  return new StepUpError(403, 'STEP_UP_REQUIRED', message, await stepUpChallengeFor(principalId, action, targetId, queryable));
}

/** The client a step-up consumer holds (its transaction's, or the pool). */
export type StepUpQueryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

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
      throw await stepUpRequiredError(input.principalId, input.action, input.targetId,
        'This act requires a live single-use step-up token bound to exactly this action and target (§7.6)', queryable);
    }
    return { tokenId: String(result.rows[0].id), method: String(result.rows[0].method) };
  }
}

export const stepUpService = new StepUpService();
