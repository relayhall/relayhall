/**
 * IdentityLinkService — the Identity link (vocabulary A23.2, extending A19.2;
 * design `d95136d7` §6.2; SS-8, SS-24).
 *
 * An Identity link is NOT a credential (AZ-18): it has no secret, no hash and
 * nothing to present, and it authenticates nothing on its own. It RECORDS that
 * a proof happened. That is why one table carries both the SSO and the platform
 * producer under `link_kind` — two tables mapping external identities to
 * Accounts would be two revocation stories, which is the drift class C6
 * doctrine makes unrepresentable.
 *
 * ── WHAT THIS SERVICE DOES *NOT* HAVE TO ENFORCE ──
 *
 * Migration 104 already refuses, at the database boundary and with the
 * application out of the picture: a session referencing a link that is not
 * `proven` AND unrevoked; a `proven -> expected` reversal; a second live link
 * for one `(Identity provider, subject)`; a mixed-arm row. This service is
 * therefore free to be readable, because the invariants do not depend on it
 * being read carefully. That was the point of putting them in the schema.
 *
 * ── THE ONE INVARIANT THAT NEEDS A TRANSACTION ──
 *
 * SS-24: "unlinking a link with a live session either revokes that session in
 * the same transaction or refuses the transition — never leaves it." The
 * deferred constraint trigger makes the second half true for every writer;
 * `unlink` below makes the FIRST half true, so an operator unlinking through
 * the owner plane gets the sessions killed rather than a refusal they cannot
 * act on. Account `disable`/`terminate` reach the same rows through the
 * Account, and the two paths are asserted to agree.
 */
import { PoolClient } from 'pg';
import { pool } from '../../db/connection';
import { auditService, type AuditActor } from '../AuditService';

export type LinkKind = 'sso' | 'platform';
export type LinkState = 'expected' | 'proven';

export interface IdentityLink {
  id: string;
  accountPrincipalId: string;
  linkKind: LinkKind;
  state: LinkState;
  identityProviderId: string | null;
  subject: string | null;
  establishedAt: Date;
  promotedAt: Date | null;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  revokeReason: string | null;
}

const SELECT_COLUMNS = `
  id, account_principal_id, link_kind, state, identity_provider_id, subject,
  established_at, promoted_at, last_seen_at, revoked_at, revoke_reason`;

function mapRow(row: Record<string, unknown>): IdentityLink {
  return {
    id: String(row.id),
    accountPrincipalId: String(row.account_principal_id),
    linkKind: row.link_kind as LinkKind,
    state: row.state as LinkState,
    identityProviderId: row.identity_provider_id === null || row.identity_provider_id === undefined
      ? null
      : String(row.identity_provider_id),
    subject: row.subject === null || row.subject === undefined ? null : String(row.subject),
    establishedAt: row.established_at as Date,
    promotedAt: (row.promoted_at as Date | null) ?? null,
    lastSeenAt: (row.last_seen_at as Date | null) ?? null,
    revokedAt: (row.revoked_at as Date | null) ?? null,
    revokeReason: (row.revoke_reason as string | null) ?? null,
  };
}

export class IdentityLinkService {
  /**
   * The live link for one `(Identity provider, subject)` pair.
   *
   * The KEY IS THE PAIR (SS-4). A `sub` is unique within an issuer and nowhere
   * else: two Identity providers can emit the same `sub`, and one provider
   * re-cut can re-emit one. Looking up by subject alone would be the defect
   * §6.1 retired the `jwt_subject` vehicle over.
   */
  async findBySubject(identityProviderId: string, subject: string): Promise<IdentityLink | undefined> {
    const result = await pool.query(
      `SELECT ${SELECT_COLUMNS} FROM identity_links
        WHERE link_kind = 'sso' AND identity_provider_id = $1 AND subject = $2 AND revoked_at IS NULL`,
      [identityProviderId, subject],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async findByAccount(identityProviderId: string, accountPrincipalId: string): Promise<IdentityLink | undefined> {
    const result = await pool.query(
      `SELECT ${SELECT_COLUMNS} FROM identity_links
        WHERE link_kind = 'sso' AND identity_provider_id = $1 AND account_principal_id = $2 AND revoked_at IS NULL`,
      [identityProviderId, accountPrincipalId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async listForAccount(accountPrincipalId: string): Promise<IdentityLink[]> {
    const result = await pool.query(
      `SELECT ${SELECT_COLUMNS} FROM identity_links WHERE account_principal_id = $1 ORDER BY established_at`,
      [accountPrincipalId],
    );
    return result.rows.map(mapRow);
  }

  /**
   * Write a link that a real authentication just established.
   *
   * `invited` and `jit` write `proven` DIRECTLY — only `directory` ever writes
   * `expected`, through `establishExpected` below (the W4 producer). The
   * `promoted_at` stamp is required by the schema for any proven row, so the
   * instant a link became a proof is always recorded.
   */
  async establishProven(
    input: {
      accountPrincipalId: string;
      identityProviderId: string;
      subject: string;
      establishedByPrincipalId?: string | null;
    },
    client: PoolClient | typeof pool = pool,
  ): Promise<IdentityLink> {
    const result = await client.query(
      `INSERT INTO identity_links
         (account_principal_id, link_kind, state, identity_provider_id, subject, established_by, promoted_at, last_seen_at)
       VALUES ($1, 'sso', 'proven', $2, $3, $4, now(), now())
       RETURNING ${SELECT_COLUMNS}`,
      [input.accountPrincipalId, input.identityProviderId, input.subject, input.establishedByPrincipalId ?? null],
    );
    return mapRow(result.rows[0]);
  }

  /**
   * Write a directory EXPECTATION — the `expected` producer (SS-22, SS-24;
   * RH-P5.SSO.W4 candidate B, A24 "writing `expected` Identity links").
   *
   * The subject an expectation records is the Identity provider's
   * `externalId` for the person, by owner ruling `6bdcc16c` §1: required on
   * a directory-mode push, refused by name when absent, and NEVER inferred
   * from `userName` or an email (SS-20 — "no provisioning mode ever selects
   * an existing Account by matching a claim string"). The caller decides
   * that; this method only records what it was handed, under the key SS-4
   * fixes: the PAIR `(Identity provider, subject)`.
   *
   * `promoted_at` is not named in the statement and so is NULL by
   * construction — migration 104's `identity_links_promoted_at_matches_state`
   * would refuse anything else — and the constraint trigger on
   * `auth_sessions` refuses a login session against this row until
   * `promote` has run. An expectation authenticates nothing; that is the
   * whole difference between "the directory expected this person" and
   * "someone turned up claiming to be them".
   *
   * `client` is the SCIM rung's own transaction: the Account, its
   * provenance row and its expectation commit together or not at all.
   */
  async establishExpected(
    input: {
      accountPrincipalId: string;
      identityProviderId: string;
      subject: string;
      establishedByPrincipalId?: string | null;
    },
    client: PoolClient | typeof pool = pool,
  ): Promise<IdentityLink> {
    const result = await client.query(
      `INSERT INTO identity_links
         (account_principal_id, link_kind, state, identity_provider_id, subject, established_by)
       VALUES ($1, 'sso', 'expected', $2, $3, $4)
       RETURNING ${SELECT_COLUMNS}`,
      [input.accountPrincipalId, input.identityProviderId, input.subject, input.establishedByPrincipalId ?? null],
    );
    return mapRow(result.rows[0]);
  }

  /**
   * Promote a directory expectation into a proof — ONE conditional statement.
   *
   * Two concurrent first logins cannot both promote: the loser sees zero rows.
   * A promotion that matches nothing REFUSES rather than creating, which is the
   * difference between "the directory expected this person" and "someone turned
   * up claiming to be them".
   */
  async promote(
    identityProviderId: string,
    subject: string,
    client: PoolClient | typeof pool = pool,
  ): Promise<IdentityLink | undefined> {
    const result = await client.query(
      `UPDATE identity_links
          SET state = 'proven', promoted_at = now(), last_seen_at = now()
        WHERE link_kind = 'sso' AND identity_provider_id = $1 AND subject = $2
          AND state = 'expected' AND revoked_at IS NULL
        RETURNING ${SELECT_COLUMNS}`,
      [identityProviderId, subject],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  /** Liveness touch on a successful login. Never changes state. */
  async touch(linkId: string, client: PoolClient | typeof pool = pool): Promise<void> {
    await client.query('UPDATE identity_links SET last_seen_at = now() WHERE id = $1', [linkId]);
  }

  /**
   * Unlink — ONE TRANSACTION, sessions first (SS-24).
   *
   * The order matters and is not cosmetic. The deferred constraint trigger
   * evaluates at COMMIT, so either order commits successfully; but revoking the
   * sessions first means that if anything later in the transaction fails, the
   * link and its sessions roll back together and the system is never briefly
   * inconsistent for a concurrent reader.
   */
  async unlink(linkId: string, reason: string, actor: AuditActor): Promise<{ link: IdentityLink; sessionsRevoked: number }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const sessions = await client.query(
        // SSO-R16 binds ID-token disposal to LOGIN-SESSION DEATH, and this is one of
        // the deaths: the retained token is dropped in the same statement that
        // revokes the login session, exactly as LoginSessionService.revoke does.
        // Leaving it would keep an encrypted ID token alive on a dead login session —
        // a retention window nobody declared. Found by the SS-9 write census.
        `UPDATE auth_sessions
            SET revoked_at = now(), revoke_reason = 'admin',
                id_token_ct = NULL, id_token_key_id = NULL
          WHERE identity_link_id = $1 AND revoked_at IS NULL`,
        [linkId],
      );
      const result = await client.query(
        `UPDATE identity_links SET revoked_at = now(), revoke_reason = $2
          WHERE id = $1 AND revoked_at IS NULL
        RETURNING ${SELECT_COLUMNS}`,
        [linkId, reason],
      );
      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new Error('no such live Identity link');
      }
      await client.query('COMMIT');
      const link = mapRow(result.rows[0]);
      await auditService.record({
        action: 'identity_link.unlink',
        actor,
        resourceType: 'identity_link',
        resourceId: linkId,
        metadata: {
          account_principal_id: link.accountPrincipalId,
          identity_provider_id: link.identityProviderId,
          sessions_revoked: sessions.rowCount ?? 0,
          reason,
        },
      });
      return { link, sessionsRevoked: sessions.rowCount ?? 0 };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Every live link an Account holds, revoked with its sessions.
   *
   * This is the path Account `disable`/`terminate` (A17.10) reaches, and the
   * acceptance asserts it agrees with `unlink`: both leave the same set of live
   * sessions, which is empty.
   */
  async revokeAllForAccount(accountPrincipalId: string, reason: string): Promise<number> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        // The same SSO-R16 disposal rule on the Account-wide path.
        `UPDATE auth_sessions
            SET revoked_at = now(), revoke_reason = 'disabled_user',
                id_token_ct = NULL, id_token_key_id = NULL
          WHERE revoked_at IS NULL
            AND identity_link_id IN (SELECT id FROM identity_links WHERE account_principal_id = $1 AND revoked_at IS NULL)`,
        [accountPrincipalId],
      );
      const links = await client.query(
        `UPDATE identity_links SET revoked_at = now(), revoke_reason = $2
          WHERE account_principal_id = $1 AND revoked_at IS NULL
        RETURNING id`,
        [accountPrincipalId, reason],
      );
      await client.query('COMMIT');
      return links.rowCount ?? 0;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export const identityLinkService = new IdentityLinkService();
