// GroupStewardService.ts — LENSES-c slice c1-A (card 46cfbd1d): the Group
// roles relation and its acts. Design delta LENSES-C steward tier (ratified
// 2026-10-11, ruling E98), clauses C.1-C.4 and C.9; AUTHZ amendment AZ-A12
// clause 5 (two Group roles, E57).
//
// THE ACTS, AND WHO PERFORMS THEM:
//   - appoint (owner or manager) and remove (any row): a ROOT LOGIN SESSION
//     (C.3). The route establishes the session and `root` before calling in;
//     there is no step-up on the root path (C.3: none is ruled).
//   - remove a MANAGER row: a live owner-role holder of the same Group, on a
//     login session, with a step-up bound to ('group.manager_remove', the
//     lowercase Group id) (C.4 removal, E98 Q3). Owner rows are root's alone.
//   - appoint a MANAGER (gate (iii), c1-B, card b5c83682): a live owner-role
//     holder of the same Group, on a login session, appointing an ACTIVE
//     member of that Group, with a step-up bound to ('group.manager_appoint',
//     the lowercase Group id) (C.4). It never writes an owner row.
//   - the manager lens's rows (C.8, c1-B): the Groups an Account LIVE-stewards,
//     owners first, read through the shared fragment only.
//   - read the rows with their live/inert flag: principals:read (C.3).
//   - read a Group's grants (SR-2, C.9): a root login session gets the full
//     rows; a live steward of the Group on a login session gets the rows
//     WITHOUT grantedByPrincipalId; everyone else gets an empty list.
//
// WHAT IT NEVER DOES: write a grant (the grant origin `steward` stays dormant, c2),
// touch the evaluator (the edit tier is AZ-A12 build 2's, ee81ee0f), act on
// termination (a terminated holder's row stays, inert, D-9), or let an owner
// appoint or remove an OWNER row (LC-DD-6: owner rows are root's alone).
//
// Every refusal is a GroupError with a name; the routes audit refusals
// durably, outside the act's rolled-back transaction, and no refusal comes
// after a step-up is consumed.
import type { PoolClient } from 'pg';

import { pool } from '../db/connection';
import { auditService, type AuditActor } from './AuditService';
import { canonicalGroupId, GroupError } from './GroupService';
import { grantService, type GrantRecord } from './GrantService';
import { stepUpService, StepUpError } from './StepUpService';
import { auditChainFor } from '../utils/auditChain';
import { ELEVATED_ROLES } from '../utils/credentialAuthority';
import { isLoginSessionKind } from '../utils/administratorSession';
import {
  GROUP_STEWARD_ROLES,
  liveStewardCondition,
  liveStewardRows,
  type GroupStewardRole,
} from '../utils/liveStewardCondition';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The step-up act the owner's manager removal consumes (C.4, §7.6). */
export const GROUP_MANAGER_REMOVE_ACT = 'group.manager_remove';
export const GROUP_MANAGER_REMOVE_REQUIRES_SESSION = 'GROUP_MANAGER_REMOVE_REQUIRES_SESSION';
export const GROUP_MANAGER_REMOVE_REQUIRES_OWNER = 'GROUP_MANAGER_REMOVE_REQUIRES_OWNER';
/** The step-up act gate (iii)'s appointment consumes (C.4, §7.6; c1-B, card b5c83682). */
export const GROUP_MANAGER_APPOINT_ACT = 'group.manager_appoint';
export const GROUP_MANAGER_APPOINT_REQUIRES_SESSION = 'GROUP_MANAGER_APPOINT_REQUIRES_SESSION';
export const GROUP_MANAGER_APPOINT_REQUIRES_OWNER = 'GROUP_MANAGER_APPOINT_REQUIRES_OWNER';

/** The kinds that may hold a Group role: a POSITIVE allowlist (C.1, CC-5). */
export const STEWARD_HOLDER_KINDS: readonly string[] = ['human', 'service'];

export type StewardIneligibleReason = 'kind' | 'parented' | 'legacy' | 'elevated_role';
export type StewardInertReason = 'principal_inactive' | 'elevated_role' | 'not_a_member';

export interface GroupStewardRecord {
  accountPrincipalId: string;
  handle: string;
  kind: string;
  status: string;
  role: GroupStewardRole;
  appointedByPrincipalId: string | null;
  appointedAt: string;
  live: boolean;
  inertReason: StewardInertReason | null;
}

/** SR-2's row for a steward viewer (dispatcher decision Q4): no grantor. */
export type StewardGrantView = Omit<GrantRecord, 'grantedByPrincipalId'>;

/**
 * One Group the caller LIVE-stewards, as the manager lens carries it (C.8;
 * design v7 §8.3 as D-6 extends it). The same shape as the lens module's
 * `StewardedGroupLensRow`, declared here because only the route that serves
 * the lens may import the lens module (I-L2's importer register).
 */
export interface StewardedGroupRow {
  id: string;
  name: string;
  memberCount: number;
  featured: boolean;
  role: GroupStewardRole;
}

export interface OwnerStandingCaller {
  authMethod: string | undefined;
  principalId: string | null;
  /** The acting chain's length; an Account acting as itself has at most one link. */
  chainLength: number;
}

export interface OwnerStandingCodes {
  requiresSession: string;
  requiresOwner: string;
  act: string;
}

const err = (status: number, code: string, message: string, field?: string, details?: Record<string, unknown>) =>
  new GroupError(status, code, message, field, details);

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

function requirePrincipalId(id: unknown, field: string, status = 422): string {
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    throw err(status, 'INVALID_GROUP_VALUE', `${field} must be a principal UUID`, field);
  }
  return id.toLowerCase();
}

/** C.1's holder rules, checked in the service before the insert; the 152
 * trigger is the backstop and answers the same reasons. */
export function stewardIneligibility(row: {
  kind: string; parent_principal_id: string | null; legacy_identity: boolean; role: string | null;
}): StewardIneligibleReason | null {
  if (!STEWARD_HOLDER_KINDS.includes(String(row.kind))) return 'kind';
  if (row.parent_principal_id) return 'parented';
  if (row.legacy_identity) return 'legacy';
  if (row.role !== null && ELEVATED_ROLES.has(String(row.role))) return 'elevated_role';
  return null;
}

/** The trigger's own message names its rule; map it to the same reason. */
function ineligibleFromTrigger(e: unknown): StewardIneligibleReason | null {
  const message = e instanceof Error ? e.message : '';
  if (!message.includes('LENSES-c C.1')) return null;
  if (message.includes('kind allowlist')) return 'kind';
  if (message.includes('parented')) return 'parented';
  if (message.includes('legacy')) return 'legacy';
  if (message.includes('elevated_role')) return 'elevated_role';
  return null;
}

/** The relation's primary key, (group_id, account_principal_id), refused a
 * second row for the same Account in the same Group: the unique_violation
 * PostgreSQL raises when two appointments race past the ALREADY_A_STEWARD
 * check (C.3, C.4: a named refusal, never a raw database error). */
export function isStewardPrimaryKeyConflict(e: unknown): boolean {
  const fault = e as { code?: unknown; constraint?: unknown } | null;
  return fault?.code === '23505' && fault?.constraint === 'group_stewards_pkey';
}

const INELIGIBLE_MESSAGE: Record<StewardIneligibleReason, string> = {
  kind: 'Group roles are held only by human or service Accounts',
  parented: 'Group roles are held only by parentless Accounts, never by a Connector or an Agent',
  legacy: 'legacy identities cannot hold a Group role',
  elevated_role: 'an admin, operator or orchestrator cannot hold a Group role (an administrator does not need stewardship)',
};

function mapSteward(row: any): GroupStewardRecord {
  return {
    accountPrincipalId: String(row.account_principal_id),
    handle: String(row.handle),
    kind: String(row.kind),
    status: String(row.status),
    role: row.role as GroupStewardRole,
    appointedByPrincipalId: row.appointed_by_principal_id ? String(row.appointed_by_principal_id) : null,
    appointedAt: row.appointed_at,
    live: row.live === true,
    inertReason: (row.inert_reason as StewardInertReason | null) ?? null,
  };
}

export class GroupStewardService {
  /**
   * GET /groups/{id}/stewards (principals:read; C.3). Owners first. `live`
   * is the shared fragment itself; `inertReason` names the first condition
   * that fails, in the order principal_inactive, elevated_role, not_a_member.
   */
  async list(groupId: string): Promise<GroupStewardRecord[]> {
    const id = canonicalGroupId(groupId);
    const exists = await pool.query('SELECT 1 FROM groups WHERE id = $1', [id]);
    if (exists.rows.length === 0) throw err(404, 'GROUP_NOT_FOUND', 'No such group');
    const result = await pool.query(
      `SELECT gs.account_principal_id, gs.role, gs.appointed_by_principal_id, gs.appointed_at,
              p.handle, p.kind, p.status,
              ${liveStewardCondition({ group: 'gs.group_id', account: 'gs.account_principal_id', roles: 'ARRAY[gs.role]' })} AS live,
              CASE WHEN p.status <> 'active' THEN 'principal_inactive'
                   WHEN p.role IS NOT NULL AND p.role = ANY($2::text[]) THEN 'elevated_role'
                   WHEN NOT EXISTS (SELECT 1 FROM group_members gm
                                     WHERE gm.group_id = gs.group_id
                                       AND gm.account_principal_id = gs.account_principal_id) THEN 'not_a_member'
                   ELSE NULL END AS inert_reason
         FROM group_stewards gs
         JOIN principals p ON p.id = gs.account_principal_id
        WHERE gs.group_id = $1
        ORDER BY CASE gs.role WHEN 'owner' THEN 0 ELSE 1 END, p.handle ASC, gs.account_principal_id ASC`,
      [id, [...ELEVATED_ROLES]],
    );
    return result.rows.map(mapSteward);
  }

  /**
   * POST /groups/{id}/stewards (C.3). The route has established a ROOT LOGIN
   * SESSION. Membership and active status are NOT required at appointment:
   * such a row is inert until they hold, and the read flags it.
   */
  async appoint(
    groupId: string,
    input: { accountPrincipalId?: unknown; role?: unknown },
    actor: AuditActor,
  ): Promise<GroupStewardRecord> {
    const id = canonicalGroupId(groupId);
    const accountPrincipalId = requirePrincipalId(input.accountPrincipalId, 'accountPrincipalId');
    if (typeof input.role !== 'string' || !(GROUP_STEWARD_ROLES as readonly string[]).includes(input.role)) {
      throw err(422, 'INVALID_GROUP_VALUE', `role is required and must be one of: ${GROUP_STEWARD_ROLES.join(', ')}`, 'role');
    }
    const role = input.role as GroupStewardRole;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const group = await client.query('SELECT 1 FROM groups WHERE id = $1 FOR SHARE', [id]);
      if (group.rows.length === 0) throw err(404, 'GROUP_NOT_FOUND', 'No such group');
      const holder = await client.query(
        'SELECT kind, parent_principal_id, legacy_identity, role FROM principals WHERE id = $1 FOR SHARE',
        [accountPrincipalId],
      );
      if (holder.rows.length === 0) {
        throw err(422, 'STEWARD_NOT_FOUND', 'accountPrincipalId resolves to no principal', 'accountPrincipalId');
      }
      const reason = stewardIneligibility(holder.rows[0]);
      if (reason) {
        throw err(422, 'STEWARD_INELIGIBLE', INELIGIBLE_MESSAGE[reason], 'accountPrincipalId', { reason });
      }
      // A WRITER read (LC-C2): the existing row's role names the 409. It is
      // never used for authority or disclosure.
      const existing = await client.query(
        'SELECT role FROM group_stewards WHERE group_id = $1 AND account_principal_id = $2 FOR UPDATE',
        [id, accountPrincipalId],
      );
      if (existing.rows.length > 0) {
        throw err(409, 'ALREADY_A_STEWARD', `That Account already holds the ${existing.rows[0].role} role in this group`,
          'accountPrincipalId', { role: existing.rows[0].role });
      }
      await client.query(
        `INSERT INTO group_stewards (group_id, account_principal_id, role, appointed_by_principal_id)
         VALUES ($1, $2, $3, $4)`,
        [id, accountPrincipalId, role, actor.principalId ?? null],
      );
      const liveAtWrite = await this.isLive(client, id, accountPrincipalId, [role]);
      await auditService.record({
        action: 'group.steward_appoint',
        actor,
        resourceType: 'group',
        resourceId: id,
        metadata: {
          groupId: id, accountPrincipalId, role, appointedBy: actor.principalId ?? null,
          standing: 'root', liveAtWrite, via: 'rest',
          chain: actor.principalId ? await auditChainFor(client, actor.principalId) : [],
        },
      }, client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      if (e instanceof GroupError) throw e;
      const conflict = await this.alreadyAStewardFromConflict(client, id, accountPrincipalId, e);
      if (conflict) throw conflict;
      const reason = ineligibleFromTrigger(e);
      if (reason) throw err(422, 'STEWARD_INELIGIBLE', INELIGIBLE_MESSAGE[reason], 'accountPrincipalId', { reason });
      throw e;
    } finally {
      client.release();
    }
    const rows = await this.list(id);
    const appointed = rows.find((row) => row.accountPrincipalId === accountPrincipalId);
    if (!appointed) throw new Error('LENSES-c: the appointed steward row is missing after commit');
    return appointed;
  }

  /** DELETE /groups/{id}/stewards/{principalId} (C.3): a root login session
   * removes ANY row, owner or manager, live or inert. */
  async removeAsRoot(groupId: string, principalId: string, actor: AuditActor): Promise<{ role: GroupStewardRole }> {
    const id = canonicalGroupId(groupId);
    const accountPrincipalId = requirePrincipalId(principalId, 'principalId', 400);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const group = await client.query('SELECT 1 FROM groups WHERE id = $1 FOR SHARE', [id]);
      if (group.rows.length === 0) throw err(404, 'GROUP_NOT_FOUND', 'No such group');
      const removed = await this.removeRow(client, id, accountPrincipalId, actor, { standing: 'root' });
      await client.query('COMMIT');
      return removed;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * GATE (iii)'s STANDING, steps 1 to 3, as ONE helper (C.4). c1-B's owner
   * appointment reuses it with its own codes. Inside the caller's transaction:
   *   1. a login session, through the one classification;
   *   2. a human Account acting as itself: kind human, active, parentless,
   *      not legacy, at most one chain link (CharterService's test);
   *   3. a LIVE owner-role row on this Group: the Group row FOR SHARE, then
   *      the shared fragment with its steward and member rows FOR SHARE.
   * An absent Group answers step 3's code, so the gate is no existence oracle.
   */
  async requireGroupOwnerStanding(
    client: Queryable,
    groupId: string,
    caller: OwnerStandingCaller,
    codes: OwnerStandingCodes,
  ): Promise<string> {
    if (!isLoginSessionKind(caller.authMethod)) {
      throw err(403, codes.requiresSession,
        `${codes.act} is a login-session act (AZ-18): bearer credentials, Connectors and Agents never perform it.`);
    }
    const notOwner = () => err(403, codes.requiresOwner,
      `${codes.act} requires a signed-in person who holds a live owner role in this group`);
    if (!caller.principalId || caller.chainLength > 1) throw notOwner();
    const self = await client.query(
      'SELECT kind, status, parent_principal_id, legacy_identity FROM principals WHERE id = $1 FOR SHARE',
      [caller.principalId],
    );
    const person = self.rows[0];
    if (!person || person.kind !== 'human' || person.status !== 'active' || person.parent_principal_id
      || person.legacy_identity) {
      throw notOwner();
    }
    const group = await client.query('SELECT 1 FROM groups WHERE id = $1 FOR SHARE', [groupId]);
    if (group.rows.length === 0) throw notOwner();
    const owner = await client.query(
      liveStewardRows({ group: '$1', account: '$2', roles: "ARRAY['owner']::text[]", lock: true }),
      [groupId, caller.principalId],
    );
    if (owner.rows.length === 0) throw notOwner();
    return caller.principalId;
  }

  /**
   * GATE (iii)'s step 4 (C.4): the appointee is ELIGIBLE. Inside the caller's
   * transaction, in this order, every refusal named:
   *   - an ACTIVE member of the Group by any source, its member row taken FOR
   *     SHARE so a concurrent removal waits for the act
   *     (MANAGER_NOT_A_GROUP_MEMBER, 422; an absent principal is no member);
   *   - not already a steward of the Group (ALREADY_A_STEWARD, 409, naming the
   *     role; the caller holds the owner row, so this also refuses
   *     self-appointment);
   *   - C.1's holder rules (STEWARD_INELIGIBLE, 422, with its reason); the 152
   *     trigger is the backstop.
   */
  async requireEligibleManagerAppointee(client: Queryable, groupId: string, accountPrincipalId: string): Promise<void> {
    const member = await client.query(
      `SELECT appointee.kind, appointee.parent_principal_id, appointee.legacy_identity, appointee.role
         FROM group_members appointee_member
         JOIN principals appointee ON appointee.id = appointee_member.account_principal_id AND appointee.status = 'active'
        WHERE appointee_member.group_id = $1 AND appointee_member.account_principal_id = $2
        FOR SHARE OF appointee_member, appointee`,
      [groupId, accountPrincipalId],
    );
    if (member.rows.length === 0) {
      throw err(422, 'MANAGER_NOT_A_GROUP_MEMBER',
        'A manager is appointed from the active members of this group; that Account is not one', 'accountPrincipalId');
    }
    // A WRITER read (LC-C2): the existing row's role names the 409; never authority.
    const existing = await client.query(
      'SELECT role FROM group_stewards WHERE group_id = $1 AND account_principal_id = $2 FOR UPDATE',
      [groupId, accountPrincipalId],
    );
    if (existing.rows.length > 0) {
      throw err(409, 'ALREADY_A_STEWARD', `That Account already holds the ${existing.rows[0].role} role in this group`,
        'accountPrincipalId', { role: existing.rows[0].role });
    }
    const reason = stewardIneligibility(member.rows[0]);
    if (reason) {
      throw err(422, 'STEWARD_INELIGIBLE', INELIGIBLE_MESSAGE[reason], 'accountPrincipalId', { reason });
    }
  }

  /**
   * POST /groups/{id}/managers (C.4, gate (iii); E57 (iii); c1-B, card
   * b5c83682). The predicate in order, in ONE transaction; every refusal
   * precedes step 5, so no refusal spends the token:
   *   1-3. requireGroupOwnerStanding, with the appointment's own codes;
   *   4.   requireEligibleManagerAppointee;
   *   5.   the step-up, consumed on the transaction client, bound to
   *        ('group.manager_appoint', the lowercase Group id).
   * Then ONE row is written, with the role fixed to manager in the statement
   * itself: this act never writes an owner row (LC-DD-6), and it reaches no
   * administrator path (an administrator holds no live owner row, C.2).
   */
  async appointManagerAsOwner(
    groupId: string,
    input: { accountPrincipalId?: unknown },
    caller: OwnerStandingCaller,
    stepUpToken: string,
    actor: AuditActor,
  ): Promise<{ steward: GroupStewardRecord; stepUpTokenId: string }> {
    const id = canonicalGroupId(groupId);
    const client = await pool.connect();
    let stepUpTokenId = '';
    let accountPrincipalId = '';
    try {
      await client.query('BEGIN');
      const ownerId = await this.requireGroupOwnerStanding(client, id, caller, {
        requiresSession: GROUP_MANAGER_APPOINT_REQUIRES_SESSION,
        requiresOwner: GROUP_MANAGER_APPOINT_REQUIRES_OWNER,
        act: 'Appointing a Group manager',
      });
      accountPrincipalId = requirePrincipalId(input.accountPrincipalId, 'accountPrincipalId');
      await this.requireEligibleManagerAppointee(client, id, accountPrincipalId);
      try {
        const evidence = await stepUpService.consume(client, {
          token: stepUpToken,
          principalId: ownerId,
          action: GROUP_MANAGER_APPOINT_ACT,
          targetId: id,
        });
        stepUpTokenId = evidence.tokenId;
      } catch (e) {
        if (e instanceof StepUpError) throw GroupError.fromStepUp(e);
        throw e;
      }
      await client.query(
        `INSERT INTO group_stewards (group_id, account_principal_id, role, appointed_by_principal_id) VALUES ($1, $2, 'manager', $3)`,
        [id, accountPrincipalId, ownerId],
      );
      const liveAtWrite = await this.isLive(client, id, accountPrincipalId, ['manager']);
      await auditService.record({
        action: 'group.steward_appoint',
        actor,
        resourceType: 'group',
        resourceId: id,
        metadata: {
          groupId: id, accountPrincipalId, role: 'manager', appointedBy: ownerId,
          standing: 'group-owner', stepUpTokenId, liveAtWrite, via: 'rest',
          chain: await auditChainFor(client, ownerId),
        },
      }, client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      if (e instanceof GroupError) throw e;
      // A concurrent appointment of the same Account committed first: the same
      // ALREADY_A_STEWARD (409). The rollback also returned this act's step-up.
      const raced = await this.alreadyAStewardFromConflict(client, id, accountPrincipalId, e);
      if (raced) throw raced;
      const reason = ineligibleFromTrigger(e);
      if (reason) throw err(422, 'STEWARD_INELIGIBLE', INELIGIBLE_MESSAGE[reason], 'accountPrincipalId', { reason });
      throw e;
    } finally {
      client.release();
    }
    const appointed = (await this.list(id)).find((row) => row.accountPrincipalId === accountPrincipalId);
    if (!appointed) throw new Error('LENSES-c: the appointed manager row is missing after commit');
    return { steward: appointed, stepUpTokenId };
  }

  /**
   * DELETE /groups/{id}/managers/{principalId} (C.4 removal; E98 Q3). The
   * predicate in order, in ONE transaction; every refusal precedes step 5, so
   * no refusal spends the token:
   *   1-3. requireGroupOwnerStanding;
   *   4.   the target row FOR UPDATE: absent is STEWARD_NOT_FOUND (404), an
   *        OWNER row is STEWARD_OWNER_ROW_ROOT_ONLY (403), a manager row is
   *        admitted live or inert;
   *   5.   the step-up, consumed on the transaction client, bound to
   *        ('group.manager_remove', the lowercase Group id).
   */
  async removeManagerAsOwner(
    groupId: string,
    principalId: string,
    caller: OwnerStandingCaller,
    stepUpToken: string,
    actor: AuditActor,
  ): Promise<{ role: GroupStewardRole; stepUpTokenId: string }> {
    const id = canonicalGroupId(groupId);
    const accountPrincipalId = requirePrincipalId(principalId, 'principalId', 400);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ownerId = await this.requireGroupOwnerStanding(client, id, caller, {
        requiresSession: GROUP_MANAGER_REMOVE_REQUIRES_SESSION,
        requiresOwner: GROUP_MANAGER_REMOVE_REQUIRES_OWNER,
        act: 'Removing a Group manager',
      });
      const removed = await this.removeRow(client, id, accountPrincipalId, actor, {
        standing: 'group-owner',
        managerOnly: true,
        stepUp: { token: stepUpToken, principalId: ownerId },
      });
      await client.query('COMMIT');
      return { role: removed.role, stepUpTokenId: String(removed.stepUpTokenId) };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Both appointment acts (C.3 root, C.4 gate (iii)): two concurrent
   * appointments of one Account both pass the ALREADY_A_STEWARD check, because
   * a FOR UPDATE on an absent row locks nothing, and the second INSERT meets
   * the primary key once the first commits. That is the same refusal, so it is
   * answered by the same name, 409 ALREADY_A_STEWARD naming the role, never a
   * raw database error. Called after the ROLLBACK, on the same connection; the
   * role read is a WRITER read (LC-C2) that only names the refusal.
   */
  private async alreadyAStewardFromConflict(
    client: Queryable, groupId: string, accountPrincipalId: string, e: unknown,
  ): Promise<GroupError | null> {
    if (!isStewardPrimaryKeyConflict(e)) return null;
    const existing = await client.query(
      'SELECT role FROM group_stewards WHERE group_id = $1 AND account_principal_id = $2',
      [groupId, accountPrincipalId],
    ).catch(() => ({ rows: [] as any[] }));
    const role = existing.rows[0]?.role as GroupStewardRole | undefined;
    return role
      ? err(409, 'ALREADY_A_STEWARD', `That Account already holds the ${role} role in this group`, 'accountPrincipalId', { role })
      : err(409, 'ALREADY_A_STEWARD', 'That Account already holds a role in this group', 'accountPrincipalId');
  }

  /** Step 4 and the write, shared by both removal acts. */
  private async removeRow(
    client: PoolClient,
    groupId: string,
    accountPrincipalId: string,
    actor: AuditActor,
    options: { standing: 'root' | 'group-owner'; managerOnly?: boolean; stepUp?: { token: string; principalId: string } },
  ): Promise<{ role: GroupStewardRole; stepUpTokenId?: string }> {
    // A WRITER read (LC-C2): the target row, locked for the delete.
    const target = await client.query(
      'SELECT role, appointed_by_principal_id FROM group_stewards WHERE group_id = $1 AND account_principal_id = $2 FOR UPDATE',
      [groupId, accountPrincipalId],
    );
    if (target.rows.length === 0) {
      throw err(404, 'STEWARD_NOT_FOUND', 'That Account holds no role in this group');
    }
    const role = target.rows[0].role as GroupStewardRole;
    if (options.managerOnly && role === 'owner') {
      throw err(403, 'STEWARD_OWNER_ROW_ROOT_ONLY',
        'An owner row is removed only by a root login session (DELETE /groups/{id}/stewards/{principalId})');
    }
    let stepUpTokenId: string | undefined;
    if (options.stepUp) {
      try {
        const evidence = await stepUpService.consume(client, {
          token: options.stepUp.token,
          principalId: options.stepUp.principalId,
          action: GROUP_MANAGER_REMOVE_ACT,
          targetId: groupId,
        });
        stepUpTokenId = evidence.tokenId;
      } catch (e) {
        // Card 72b8fb97 (found 15 Oct): keep the SU-14 challenge.
        if (e instanceof StepUpError) throw GroupError.fromStepUp(e);
        throw e;
      }
    }
    const liveAtWrite = await this.isLive(client, groupId, accountPrincipalId, [role]);
    await client.query(
      'DELETE FROM group_stewards WHERE group_id = $1 AND account_principal_id = $2',
      [groupId, accountPrincipalId],
    );
    await auditService.record({
      action: 'group.steward_remove',
      actor,
      resourceType: 'group',
      resourceId: groupId,
      metadata: {
        groupId, accountPrincipalId, role,
        appointedBy: target.rows[0].appointed_by_principal_id ?? null,
        standing: options.standing,
        ...(stepUpTokenId ? { stepUpTokenId } : {}),
        liveAtWrite, via: 'rest',
        chain: actor.principalId ? await auditChainFor(client, actor.principalId) : [],
      },
    }, client);
    return { role, stepUpTokenId };
  }

  /** The fragment, as a boolean, for one (Group, Account) pair. */
  async isLive(queryable: Queryable, groupId: string, accountPrincipalId: string, roles: readonly string[]): Promise<boolean> {
    const result = await queryable.query(
      `SELECT ${liveStewardCondition({ group: '$1', account: '$2', roles: '$3::text[]' })} AS live`,
      [groupId, accountPrincipalId, [...roles]],
    );
    return result.rows[0]?.live === true;
  }

  /**
   * The manager lens's rows (C.8; c1-B, card b5c83682): every Group in which
   * `accountPrincipalId` holds a LIVE owner or manager row, read through the
   * shared fragment and nothing else (LC-C2), owners first, then by name. The
   * member count is the Group's ACTIVE members. It writes nothing and is
   * recomputed per request (I-L2): the lens confers nothing.
   */
  async stewardedGroupsFor(accountPrincipalId: string): Promise<StewardedGroupRow[]> {
    const result = await pool.query(
      `SELECT stewarded.id::text AS id, stewarded.name, stewarded.featured, live.role,
              (SELECT count(*)::int FROM group_members counted
                 JOIN principals counted_member ON counted_member.id = counted.account_principal_id
                  AND counted_member.status = 'active'
                WHERE counted.group_id = stewarded.id) AS member_count
         FROM (${liveStewardRows({ group: null, account: '$1', roles: "ARRAY['owner', 'manager']::text[]" })}) live
         JOIN groups stewarded ON stewarded.id = live.group_id
        ORDER BY CASE live.role WHEN 'owner' THEN 0 ELSE 1 END, lower(stewarded.name), stewarded.id`,
      [accountPrincipalId],
    );
    return result.rows.map((row: any) => ({
      id: String(row.id),
      name: String(row.name),
      memberCount: Number(row.member_count),
      featured: row.featured === true,
      role: row.role as GroupStewardRole,
    }));
  }

  /**
   * SR-2 (C.9): GET /groups/{id}/grants. A root login session sees the full
   * rows; a LIVE steward of the Group on a login session sees them without
   * grantedByPrincipalId (dispatcher decision Q4); every other caller gets an
   * empty list, never a 403.
   */
  async groupGrants(
    groupId: string,
    viewer: { rootSession: boolean; sessionPrincipalId: string | null },
  ): Promise<Array<GrantRecord | StewardGrantView>> {
    const id = canonicalGroupId(groupId);
    if (viewer.rootSession) {
      const exists = await pool.query('SELECT 1 FROM groups WHERE id = $1', [id]);
      if (exists.rows.length === 0) throw err(404, 'GROUP_NOT_FOUND', 'No such group');
      return (await grantService.list({ granteeId: id })).filter((grant) => grant.granteeType === 'group');
    }
    if (!viewer.sessionPrincipalId) return [];
    if (!(await this.isLive(pool, id, viewer.sessionPrincipalId, GROUP_STEWARD_ROLES))) return [];
    return (await grantService.list({ granteeId: id }))
      .filter((grant) => grant.granteeType === 'group')
      .map(({ grantedByPrincipalId: _grantor, ...view }) => view);
  }
}

export const groupStewardService = new GroupStewardService();
