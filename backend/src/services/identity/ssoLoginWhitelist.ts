/**
 * ssoLoginWhitelist — the SSO-R4 login group whitelist (design `d95136d7` §7.2
 * doctrine; sitting `5a7fd9af` ruling SSO-R4; owner decision W3-D2 on run
 * packet `05492f21`).
 *
 * ── WHAT THIS DECIDES, AND WHAT IT MUST NEVER DECIDE ──
 *
 * ONE question: may this Account obtain a federated login session at this
 * Identity provider at all. It decides nothing about what the login session may then
 * do. Authority stays exactly where AUTHZ `4d961e37` §3 puts it — grants,
 * resolved by the query-time membership join — so T-SS18's parity assertion is
 * untouched: an Account admitted here holds byte-identical effective scopes to
 * the same Account arriving through the password door. This module gates the
 * DOOR, never the ROOM.
 *
 * It is therefore never consulted on the local password path, and it can never
 * reach `POST /auth/login` (§8.5 break-glass, permanent by design). An Identity provider
 * misconfiguration locks nobody out of the board.
 *
 * ── WHY MEMBERSHIP IS READ WITHOUT A `source` FILTER ──
 *
 * W3-D2: a `local` assignment and a `directory`-synced one BOTH admit. The
 * question the whitelist asks is whether the board considers this person a
 * member, not how the board came to know it. Filtering to `source='directory'`
 * would mean an operator could not admit anyone the directory does not already
 * carry — which would make the feature unusable in exactly the deployment that
 * wants it most, a board whose Identity provider emits no groups at all (class 4).
 *
 * ── WHY THE EVALUATION IS AGAINST STORED MEMBERSHIP, NOT THE CLAIM ──
 *
 * §7.2 is the governing doctrine: *"a login never carries group authority"* —
 * a claim is an INPUT to the stored snapshot, never a parallel source riding on
 * the login session. So the caller applies the snapshot first (when the claim is
 * usable) and then evaluates THIS, against rows. The consequence is the one the
 * owner ruled deliberately: when claims are unavailable — absent, unparseable,
 * truncated, or an overage indicator — nothing is written, and the whitelist is
 * evaluated against the RETAINED membership. Absence never admits anyone who
 * was not already a member, and it never evicts a member whose Identity provider
 * failed to enumerate their groups this time. A deployment whose users cross an
 * issuer's overage threshold does not lose the ability to log in, which a
 * fresh-claims-required rule would have done to them permanently. (Which real
 * products truncate a large groups claim is evidence for the agnosticism
 * claim and lives in annex `e6dcadb9` §10a, never in this source: §4.5(b)
 * keeps vendor-identifying literals out of the relying party, and its gate
 * caught this sentence naming one.)
 *
 * That behaviour needs no code here at all: it falls out of evaluating stored
 * rows. It is written down because a reader who does not see a
 * claims-unavailable branch should know it is absent ON PURPOSE.
 */
import { pool } from '../../db/connection';

/** Why a decision came out the way it did — recorded in the audit ledger. */
export const LOGIN_WHITELIST_REASONS = [
  /** The Identity provider does not gate logins by Group. */
  'whitelist_disabled',
  /** Gated, and the Account holds at least one admitting membership. */
  'member',
  /** Gated, but the allowed-Group list is EMPTY: refuse everyone, fail closed. */
  'no_allowed_groups',
  /** Gated, the list has entries, and the Account is in none of them. */
  'not_a_member',
] as const;
export type LoginWhitelistReason = (typeof LOGIN_WHITELIST_REASONS)[number];

export interface LoginWhitelistDecision {
  admitted: boolean;
  reason: LoginWhitelistReason;
  /** How many Groups the Identity provider lists. Zero with `enabled` is fail-closed. */
  allowedGroupCount: number;
  /** The admitting Group ids, in board order. Empty on every refusal. */
  matchedGroupIds: string[];
}

/**
 * Evaluate the whitelist for ONE Account at ONE Identity provider.
 *
 * The count and the membership are read in a single statement so a Group
 * removed between "is the list empty?" and "is this Account in it?" cannot
 * produce a decision that matches neither state — the check-then-act shape this
 * programme has paid for more than once (SS-18's consume, SS-24's promotion).
 */
export async function evaluateLoginWhitelist(input: {
  identityProviderId: string;
  accountPrincipalId: string;
  enabled: boolean;
}): Promise<LoginWhitelistDecision> {
  if (!input.enabled) {
    return { admitted: true, reason: 'whitelist_disabled', allowedGroupCount: 0, matchedGroupIds: [] };
  }

  const result = await pool.query(
    `SELECT w.group_id,
            (m.account_principal_id IS NOT NULL) AS is_member
       FROM identity_provider_login_groups w
       LEFT JOIN group_members m
              ON m.group_id = w.group_id
             AND m.account_principal_id = $2
      WHERE w.identity_provider_id = $1
      ORDER BY w.added_at`,
    [input.identityProviderId, input.accountPrincipalId],
  );

  const allowedGroupCount = result.rows.length;
  if (allowedGroupCount === 0) {
    // Enabled with nothing allowed refuses everyone. W3-D2 rules this fail
    // closed: an unfinished configuration must not read as "admit all".
    return { admitted: false, reason: 'no_allowed_groups', allowedGroupCount: 0, matchedGroupIds: [] };
  }

  const matchedGroupIds = result.rows
    .filter((row) => row.is_member === true)
    .map((row) => String(row.group_id));

  return matchedGroupIds.length > 0
    ? { admitted: true, reason: 'member', allowedGroupCount, matchedGroupIds }
    : { admitted: false, reason: 'not_a_member', allowedGroupCount, matchedGroupIds: [] };
}
