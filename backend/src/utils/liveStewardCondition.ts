/**
 * LENSES-c c1 (card 46cfbd1d; design delta C.2, ratified E98): THE ONE SHARED
 * FRAGMENT that decides whether a Group role row is LIVE.
 *
 * A `group_stewards` row is live only while ALL of these hold, read at use:
 *   - its holder's principal is `active`;
 *   - the holder is a member of the Group by ANY source (`group_members`);
 *   - the holder's CURRENT `principals.role` is NULL or not an elevated role
 *     (admin, operator, orchestrator). A role change can promote a holder
 *     after appointment, and the insert trigger cannot see that (D-18).
 * Otherwise the row is INERT: it confers nothing. No cleanup trigger exists;
 * leaving, being disabled, being terminated or being promoted makes the row
 * inert from that commit, and the reverse (where the state can reverse)
 * makes it live again on the next request.
 *
 * Every authority or disclosure read of `group_stewards` goes through this
 * text and no other (LC-C2, registered in groupStewardsRegisters.test.ts).
 * AZ-A12 build 2 (card ee81ee0f) composes this fragment for the edit tier
 * (utils/groupOwnerCondition.ts): a LIVE owner or manager row is what gives
 * the write subset on an object the Group owns.
 *
 * The elevated set is built from `ELEVATED_ROLES` (utils/credentialAuthority),
 * the set migration 096's `principals_elevated_parentless` names, so the
 * fragment, the role-change act and the 152 trigger cannot disagree about
 * which roles are the dangerous ones (LC-C7 asserts the trigger's list both
 * ways).
 *
 * The aliases are deliberately long and unique: the fragment is embedded in
 * outer queries that alias `group_stewards` themselves, and a shared alias
 * would silently turn `outer.group_id = inner.group_id` into a tautology.
 */
import { ELEVATED_ROLES } from './credentialAuthority';

/** The two Group roles (AZ-A12 clause 5; E57). */
export const GROUP_STEWARD_ROLES = ['owner', 'manager'] as const;
export type GroupStewardRole = (typeof GROUP_STEWARD_ROLES)[number];

/** The elevated roles as a SQL list literal, sorted so the text is stable. */
export function elevatedRoleSqlList(): string {
  return [...ELEVATED_ROLES].sort().map((role) => `'${role.replace(/'/g, "''")}'`).join(', ');
}

export interface LiveStewardInput {
  /** SQL expression for the Group id, or null for every Group the holder stewards. */
  group: string | null;
  /** SQL expression for the holder's Account principal id. */
  account: string;
  /** SQL expression for a text[] of roles, e.g. `$3::text[]` or `ARRAY['owner']`. */
  roles: string;
}

/**
 * The live rows themselves: `SELECT steward_row.group_id, steward_row.role`.
 *
 * `lock: true` appends `FOR SHARE OF steward_row, steward_member`, which a
 * GATE uses inside its own transaction: a concurrent `removeMember`, a
 * directory snapshot delete or a steward removal then waits for the act to
 * commit and cannot slip in between the check and the write (C.2).
 */
export function liveStewardRows(input: LiveStewardInput & { lock?: boolean }): string {
  const group = input.group === null ? '' : ` AND steward_row.group_id = ${input.group}`;
  return `SELECT steward_row.group_id, steward_row.role
             FROM group_stewards steward_row
             JOIN group_members steward_member
               ON steward_member.group_id = steward_row.group_id
              AND steward_member.account_principal_id = steward_row.account_principal_id
             JOIN principals steward_holder
               ON steward_holder.id = steward_row.account_principal_id
              AND steward_holder.status = 'active'
              AND (steward_holder.role IS NULL OR steward_holder.role NOT IN (${elevatedRoleSqlList()}))
            WHERE steward_row.account_principal_id = ${input.account}
              AND steward_row.role = ANY(${input.roles})${group}${input.lock ? '\n            FOR SHARE OF steward_row, steward_member' : ''}`;
}

/** The same rows as a boolean condition, for a read that only asks "is it live?". */
export function liveStewardCondition(input: LiveStewardInput): string {
  return `EXISTS (${liveStewardRows({ ...input, lock: false })})`;
}
