/**
 * SsoInvitationService — the Invitation (vocabulary A23.8; design `d95136d7`
 * §6.3; SS-20, SS-22; threat row T-SS19).
 *
 * ── WHY THIS OBJECT EXISTS ──
 *
 * SS-20: **no provisioning mode ever selects an existing Account by matching a
 * claim string.** Anyone able to present the matched value would acquire that
 * Account's grants, and writing the `sub` link afterwards would make the
 * misbinding durable — a takeover path, and a contradiction of SS-11.
 *
 * SS-20 on its own was policy with no vehicle, and a withdrawn takeover path
 * whose replacement cannot be built is not a repair (round-4 F3). This is the
 * replacement: the Account is named by an INVITATION, server-side, or it is not
 * named at all. Handle, display name and email are profile attributes written
 * onto an Account some other proof already selected — never selectors.
 *
 * ── THE SECRET ──
 *
 * At least 128 bits of randomness, stored ONLY as a SHA-256 digest, so nothing
 * on the board can re-issue it. The raw code is returned exactly once, to the
 * owner-plane act that minted it.
 *
 * ── CONSUMPTION IS ONE CONDITIONAL STATEMENT, WITH THE PROVIDER IN THE
 *    PREDICATE ──
 *
 *     UPDATE ... SET consumed_at = now() WHERE secret_hash = $1
 *       AND consumed_at IS NULL AND expires_at > now()
 *       AND identity_provider_id = $2 RETURNING *
 *
 * so an invitation minted for one Identity provider cannot be spent at another;
 * two concurrent callbacks cannot both spend one invitation; and expiry is
 * evaluated IN THE SAME STATEMENT rather than checked before it.
 */
import crypto from 'crypto';
import { PoolClient } from 'pg';
import { pool } from '../../db/connection';
import { auditService, type AuditActor } from '../AuditService';

/**
 * 32 bytes = 256 bits, comfortably past SS-22's "at least 128 bits". The
 * acceptance asserts the bound on this constant AND on a minted code, so a
 * future edit that shortens it fails a test rather than quietly weakening the
 * brute-force bound.
 */
export const INVITATION_SECRET_BYTES = 32;
export const INVITATION_MIN_ENTROPY_BITS = 128;

export function mintInvitationCode(): string {
  return crypto.randomBytes(INVITATION_SECRET_BYTES).toString('base64url');
}

export function hashInvitationCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

export interface SsoInvitation {
  id: string;
  identityProviderId: string;
  accountPrincipalId: string | null;
  newAccountIntent: boolean;
  intendedHandle: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
}

const SELECT_COLUMNS = `
  id, identity_provider_id, account_principal_id, new_account_intent,
  intended_handle, expires_at, consumed_at`;

function mapRow(row: Record<string, unknown>): SsoInvitation {
  return {
    id: String(row.id),
    identityProviderId: String(row.identity_provider_id),
    accountPrincipalId:
      row.account_principal_id === null || row.account_principal_id === undefined
        ? null
        : String(row.account_principal_id),
    newAccountIntent: row.new_account_intent === true,
    intendedHandle:
      row.intended_handle === null || row.intended_handle === undefined ? null : String(row.intended_handle),
    expiresAt: row.expires_at as Date,
    consumedAt: (row.consumed_at as Date | null) ?? null,
  };
}

export class SsoInvitationService {
  /**
   * Mint an Invitation. Owner-plane act, root-gated at the route (owner D4),
   * audited, and the ONLY moment the raw code exists outside the recipient.
   */
  async mint(
    input: {
      identityProviderId: string;
      accountPrincipalId?: string | null;
      newAccountIntent?: boolean;
      intendedHandle?: string | null;
      ttlSeconds?: number;
    },
    actor: AuditActor,
  ): Promise<{ invitation: SsoInvitation; code: string }> {
    const newAccountIntent = input.newAccountIntent ?? false;
    const code = mintInvitationCode();
    const result = await pool.query(
      `INSERT INTO sso_invitations
         (identity_provider_id, account_principal_id, new_account_intent, secret_hash,
          intended_handle, expires_at, created_by_principal_id)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6), $7)
       RETURNING ${SELECT_COLUMNS}`,
      [
        input.identityProviderId,
        input.accountPrincipalId ?? null,
        newAccountIntent,
        hashInvitationCode(code),
        input.intendedHandle ?? null,
        input.ttlSeconds ?? 7 * 24 * 3600,
        actor.principalId ?? null,
      ],
    );
    const invitation = mapRow(result.rows[0]);
    await auditService.record({
      action: 'sso_invitation.mint',
      actor,
      resourceType: 'sso_invitation',
      resourceId: invitation.id,
      metadata: {
        identity_provider_id: invitation.identityProviderId,
        account_principal_id: invitation.accountPrincipalId,
        new_account_intent: invitation.newAccountIntent,
        // The code itself is never audited. An audit ledger that records the
        // secret is a second copy of the secret.
      },
    });
    return { invitation, code };
  }

  /**
   * Look an Invitation up WITHOUT consuming it, so `/auth/sso/start` can refuse
   * an obviously dead code before sending anyone to the Identity provider.
   *
   * This is a convenience, never the authorisation: the callback consumes with
   * the conditional statement below, and that is the only check that counts.
   * A caller that raced this lookup gains nothing.
   */
  async peek(code: string, identityProviderId: string): Promise<SsoInvitation | undefined> {
    const result = await pool.query(
      `SELECT ${SELECT_COLUMNS} FROM sso_invitations
        WHERE secret_hash = $1 AND identity_provider_id = $2
          AND consumed_at IS NULL AND expires_at > now()`,
      [hashInvitationCode(code), identityProviderId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async getById(id: string): Promise<SsoInvitation | undefined> {
    const result = await pool.query(`SELECT ${SELECT_COLUMNS} FROM sso_invitations WHERE id = $1`, [id]);
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  /**
   * Consume — ONE statement, provider IN THE PREDICATE, expiry evaluated here.
   *
   * Returns undefined for absent, already-consumed, expired, or minted-for-a
   * -different-Identity-provider. The caller cannot tell those apart, which is
   * deliberate.
   */
  async consume(
    id: string,
    identityProviderId: string,
    client: PoolClient | typeof pool = pool,
  ): Promise<SsoInvitation | undefined> {
    const result = await client.query(
      `UPDATE sso_invitations SET consumed_at = now()
        WHERE id = $1 AND identity_provider_id = $2
          AND consumed_at IS NULL AND expires_at > now()
        RETURNING ${SELECT_COLUMNS}`,
      [id, identityProviderId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  /** Bind the consumed Invitation to the link it produced, for the trail. */
  async recordLink(id: string, linkId: string, client: PoolClient | typeof pool = pool): Promise<void> {
    await client.query('UPDATE sso_invitations SET consumed_link_id = $2 WHERE id = $1', [id, linkId]);
  }

  async listForProvider(identityProviderId: string): Promise<SsoInvitation[]> {
    const result = await pool.query(
      `SELECT ${SELECT_COLUMNS} FROM sso_invitations WHERE identity_provider_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [identityProviderId],
    );
    return result.rows.map(mapRow);
  }
}

export const ssoInvitationService = new SsoInvitationService();
