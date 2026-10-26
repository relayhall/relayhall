/**
 * AZ-A12 build 2 (card ee81ee0f; amendment AZ-A12 clauses 6-8, ratified E72):
 * THE ONE SHARED FRAGMENT by which the evaluator's owner arm resolves a Group
 * owner.
 *
 * Today's owner arm is `X = actor`, where X is the owner value the arm already
 * reads (the Project owner, the Phase's Project owner, the Task's
 * `COALESCE(account owner, Project owner)`, the Report's account owner). It
 * becomes `X = actor` OR X is an ACTIVE Group principal G and the acting
 * Account is an ACTIVE member of G, at the TIER the action requires:
 *
 *   use  (member):            read, use, invoke
 *   edit (manager or owner):  read, write, claim, finish, release, use, invoke
 *
 * `admin`, `shepherd` and `verify` are NEVER admitted through Group ownership:
 * `groupOwnerTierFor` answers null for them and the evaluator then renders no
 * Group arm at all, so no row of this fragment can reach those actions.
 *
 * The edit tier composes LENSES-c's live-steward fragment
 * (`utils/liveStewardCondition`, design delta C.2) rather than writing a second
 * one: a manager or owner row confers the edit tier only while it is LIVE
 * (holder active, a member of the Group by any source, not an elevated role).
 *
 * The tier is chosen in TypeScript from the action (`groupOwnerTierFor`), so
 * the text and the bound parameters of a statement are fixed per action, the
 * `equalityLazy` discipline of `AuthorizationService.sqlCondition`. The role
 * list is a literal, so the edit tier binds nothing of its own.
 *
 * Every Group-owner arm in the evaluator - the Account plane, the Account side
 * of the delegation chain and therefore every list surface that reads the
 * predicate (`listScope`, `authorizedIds`, the authority preview, the mint
 * ceiling) - goes through THIS text and no other. Point/list parity is then
 * structural, as it is for `GrantService.activeGrantCondition`.
 *
 * The aliases (`owning_group`, `owning_group_member`, `owning_group_account`)
 * are long and unique because the fragment is embedded inside
 * outer queries that alias `principals` and `group_members` themselves.
 */
import { liveStewardCondition } from './liveStewardCondition';

/** The tier names of AZ-A12 clause 6. */
export type GroupOwnerTier = 'use' | 'edit';

/** The actions each tier admits (clause 6's table), as RUNTIME lists so the
 * parity test can walk them. Kept as plain strings so this file need not
 * import the evaluator it is imported by. */
export const GROUP_USE_TIER_ACTIONS: readonly string[] = ['read', 'use', 'invoke'];
export const GROUP_EDIT_TIER_ACTIONS: readonly string[] = ['read', 'write', 'claim', 'finish', 'release', 'use', 'invoke'];

/** The resource types whose owner value may name a Group in this build
 * (clause 4: `projects.owner_principal_id`, `tasks.account_owner_principal_id`
 * and `reports.account_owner_principal_id`; a Phase reads its Project's
 * owner; and build 4's `skills.owner_principal_id`, M-c, migration 162, card
 * d67e6990, whose use tier is read and `use`, and edit tier write). */
export const GROUP_OWNABLE_TYPES: readonly string[] = ['project', 'phase', 'task', 'report', 'skill'];

/**
 * The tier an action REQUIRES through Group ownership, or null when no tier
 * admits it. The use tier is the lowest tier that admits the action; an edit
 * holder is always also a member, so the member condition covers them for
 * read/use/invoke wherever no restriction rule intervenes.
 */
export function groupOwnerTierFor(action: string): GroupOwnerTier | null {
  if (GROUP_USE_TIER_ACTIONS.includes(action)) return 'use';
  if (GROUP_EDIT_TIER_ACTIONS.includes(action)) return 'edit';
  return null;
}

export interface GroupOwnerInput {
  /** SQL expression for the owner value X (a uuid column or COALESCE). */
  owner: string;
  /** SQL expression for the acting ACCOUNT's principal id (a bound uuid parameter). */
  account: string;
  /** The tier the condition tests. */
  tier: GroupOwnerTier;
}

/**
 * TRUE iff `owner` names an active Group principal of which `account` is an
 * active member, and - for the edit tier - holds a LIVE owner or manager row.
 */
export function groupOwnerCondition(input: GroupOwnerInput): string {
  const edit = input.tier === 'edit'
    ? `\n                AND ${liveStewardCondition({
      group: 'owning_group.id',
      account: 'owning_group_account.id',
      roles: "ARRAY['owner', 'manager']::text[]",
    })}`
    : '';
  return `EXISTS (SELECT 1 FROM principals owning_group
               JOIN group_members owning_group_member
                 ON owning_group_member.group_id = owning_group.id
               JOIN principals owning_group_account
                 ON owning_group_account.id = owning_group_member.account_principal_id
                AND owning_group_account.status = 'active'
              WHERE owning_group.id = ${input.owner}
                AND owning_group.kind = 'group'
                AND owning_group.status = 'active'
                AND owning_group_account.id = ${input.account}::uuid${edit})`;
}
