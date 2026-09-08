/**
 * RH-LENSES-b (card 4287af8a) — THE HOME GROUP, AND THE CREATION-DEFAULT
 * DECISION.
 *
 * Governing design: RH-DESIGN.LENSES v7.1 (report 96f0bd3d) sections 7.2 and
 * 7.3, ANNEX v7.1 (report d6637a92) sections A7.4 and A8.2; owner design record
 * 99d6b0ad decisions 3, 4 and 6; owner ruling 60307311 s1.3/s1.4/s1.5.
 *
 * ── THE POINTER IS NOT THE ANSWER (derivation D-L2) ─────────────────────────
 *
 * `account_home_groups` stores a POINTER. `homeGroup(a)` is DERIVED at read:
 * the pointer resolves iff the Group is still `featured`, `a` is still a member
 * of it by any source, and `a` is still `active`. Otherwise it resolves to NULL
 * and the pointer row SURVIVES. There is no cleanup trigger: a trigger plus a
 * read check is two mechanisms that can disagree, and a trigger alone silently
 * destroys an administrator's choice the moment a directory sync briefly drops
 * a membership.
 *
 * ── ONE DERIVATION, TWO CONSUMERS ───────────────────────────────────────────
 *
 * `GET /principals/me/home-group` and the creation default of s7.3 read the
 * SAME classification, from `classifyHomeGroup` below. They differ in one
 * respect only, and it is the respect that matters: the creation default reads
 * the state on the PROJECT'S OWN CLIENT under a `SELECT ... FOR SHARE` on the
 * Group row, so the state cannot change between resolution and write. A second
 * copy of these four clauses, written for the write path, is exactly the drift
 * D-L2 exists to refuse.
 *
 * ── THE ACTING-CHANNEL TEST IS FIRST, AND IT IS FAIL-CLOSED ─────────────────
 *
 * Owner decision 6 (design s12; DBD-15) selected the design's own stated
 * fallback: the creation default is written ONLY for a ROOT LOGIN SESSION. The
 * `relayhall.authority_actor` channel and the trigger-level internal-writer
 * closure defer with the rule-4 arm (`3e76cfcc`), so there is no allowlist to
 * join and no channel to invent. Every other creator — a `principal_api_key`
 * bearer HOWEVER SCOPED, a non-root login session, a delegated Connector, and
 * any internal caller that supplies no actor at all — creates the project,
 * writes no grant, and audits `actor_channel_unavailable`.
 */
import { pool } from '../db/connection';
import { auditService, type AuditActor } from './AuditService';
import { isLoginSessionKind } from '../utils/administratorSession';

export interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class HomeGroupError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'HomeGroupError';
  }
}

const err = (status: number, code: string, message: string, field?: string) =>
  new HomeGroupError(status, code, message, field);

// ─────────────────── the closed sets, and they are closed ────────────────────

/**
 * Why a home pointer does not resolve. These four are the last four values of
 * the skip-reason enumeration below, and they are the SAME values because they
 * are the same four clauses read by the same function.
 */
export const HOME_GROUP_UNRESOLVED_REASONS = [
  'no_home_group', 'not_featured', 'not_a_member', 'actor_inactive',
] as const;
export type HomeGroupUnresolvedReason = (typeof HOME_GROUP_UNRESOLVED_REASONS)[number];

/**
 * THE COMPLETE v1 SKIP-REASON ENUMERATION (design s7.3.2), in the record's own
 * order, `actor_channel_unavailable` first because it is the reason most
 * creators will see.
 *
 * BUILD OBLIGATION B-L20: this is a CLOSED SET the audit writer validates
 * against, not a free string. `recordAccessDefaultSkip` THROWS on a value this
 * array does not carry, so an unenumerated reason fails the write — and because
 * that write happens inside the project's own transaction, it fails the whole
 * act rather than being recorded. A reason nobody declared is a defect, and a
 * defect that reaches the ledger as data is a defect nobody will find.
 */
export const CREATION_DEFAULT_SKIP_REASONS = [
  'actor_channel_unavailable',
  ...HOME_GROUP_UNRESOLVED_REASONS,
] as const;
export type CreationDefaultSkipReason = (typeof CREATION_DEFAULT_SKIP_REASONS)[number];

export function isCreationDefaultSkipReason(value: unknown): value is CreationDefaultSkipReason {
  return typeof value === 'string'
    && (CREATION_DEFAULT_SKIP_REASONS as readonly string[]).includes(value);
}

/** The verbs the creation default confers. Read, and write; nothing else. */
export const CREATION_DEFAULT_VERBS = ['read', 'write'] as const;

/** `grants.origin` for a row this act writes. */
export const CREATION_DEFAULT_ORIGIN = 'creation-default';

// ───────────────────────── the derivation, as data ───────────────────────────

/**
 * The four facts derivation D-L2 reads. Every field is a SERVER-READ value; not
 * one of them comes from a request body.
 */
export interface HomeGroupState {
  /** The stored pointer's group id, or null when no pointer row exists. */
  pointerGroupId: string | null;
  /** Whether the pointed-at Group row still exists. */
  groupExists: boolean;
  /** `groups.featured` at the moment of the read. */
  featured: boolean;
  /** Membership of the pointed-at Group, by ANY source (local or directory). */
  isMember: boolean;
  /** `principals.status = 'active'` for the Account. */
  actorActive: boolean;
}

export type HomeGroupResolution =
  | { resolved: true; groupId: string }
  | { resolved: false; reason: HomeGroupUnresolvedReason };

/**
 * Derivation D-L2, and the ONLY copy of it.
 *
 * PRECEDENCE, stated rather than discovered: the clauses are evaluated in the
 * order design s7.3.2 enumerates them. When more than one clause fails the
 * first one in that order names the cause. Each clause refuses on its own —
 * that independence is what control R-11-v1 drills, one flip per clause.
 */
export function classifyHomeGroup(state: HomeGroupState): HomeGroupResolution {
  if (!state.pointerGroupId || !state.groupExists) {
    return { resolved: false, reason: 'no_home_group' };
  }
  if (!state.featured) return { resolved: false, reason: 'not_featured' };
  if (!state.isMember) return { resolved: false, reason: 'not_a_member' };
  if (!state.actorActive) return { resolved: false, reason: 'actor_inactive' };
  return { resolved: true, groupId: state.pointerGroupId };
}

// ──────────────────────── the acting channel (step 2) ────────────────────────

/**
 * The acting identity, as the creation default needs to see it. Every field is
 * SERVER-DERIVED: `authMethod` is set by the authentication middleware and
 * never by a header, and `scopes` is the middleware-resolved scope set.
 */
export interface CreationActor {
  principalId: string | null;
  authMethod: string | undefined;
  scopes: string[] | null | undefined;
  /** The audit attribution for every row this act writes. */
  audit: AuditActor;
}

/**
 * STEP 2 of s7.3.1, first and fail-closed.
 *
 * TRUE only for a ROOT LOGIN SESSION: the request arrived on one of the two
 * doors a PERSON comes through (`isLoginSessionKind`, the landed seam at
 * `utils/administratorSession.ts` — imported, never re-implemented, so the
 * repository-wide census in `__tests__/administratorSessionSeam.test.ts` stays
 * true) AND the resolved scopes contain `root` AND a principal resolved.
 *
 * An ABSENT actor is not a root session. Internal callers — seeders, fixtures,
 * an import path — reach `ProjectService.create` with no actor at all, and they
 * take the skip branch like every other non-session creator.
 */
export function isRootLoginSessionActor(actor: CreationActor | undefined | null): boolean {
  if (!actor || !actor.principalId) return false;
  if (!isLoginSessionKind(actor.authMethod)) return false;
  return (actor.scopes ?? []).includes('root');
}

export type CreationDefaultDecision =
  | { apply: true; groupId: string }
  | { apply: false; reason: CreationDefaultSkipReason };

/**
 * The whole decision, as a pure function of two server-read facts.
 *
 * The acting-channel test is FIRST: a caller outside the root-session channel
 * never reaches the re-derivation, so no home pointer of theirs is even read.
 */
export function decideCreationDefault(
  isRootSession: boolean,
  resolution: HomeGroupResolution | null,
): CreationDefaultDecision {
  if (!isRootSession) return { apply: false, reason: 'actor_channel_unavailable' };
  if (resolution === null) {
    // Not a defensive branch: `null` means the caller did not re-derive, and a
    // root-session creator whose home group was never resolved must not be
    // given a default by omission. Fail loudly rather than skip silently.
    throw new Error(
      'decideCreationDefault: a root login session reached the decision with no re-derived '
      + 'home-group resolution (design 96f0bd3d s7.3.1 step 3).',
    );
  }
  if (!resolution.resolved) return { apply: false, reason: resolution.reason };
  return { apply: true, groupId: resolution.groupId };
}

// ───────────────────────────── reading the state ─────────────────────────────

/**
 * Read the four facts for one Account, and - when this is a WRITE - hold a row
 * lock on every one of them.
 *
 * -- WHY ALL FOUR (round-1 review finding B1) --------------------------------
 *
 * The first cut locked the Group row alone, which is the one lock design
 * 96f0bd3d s7.3.1 step 3 names. But `FOR SHARE` on `groups` serialises writers
 * of THAT row and nothing else: the pointer clear writes `account_home_groups`,
 * the membership removal writes `group_members`, and termination writes
 * `principals`. None of them touches the Group row, so after their ordinary
 * SELECT a concurrent writer could commit before the grant INSERT and the act
 * would write two rows from a state that no longer held.
 *
 * The record states the PROPERTY - "the state cannot change between resolution
 * and write" - and the property is the contract; the single named lock was
 * enough for one clause of four. Each clause now takes the row lock its own
 * writer must pass, and the act holds all four through its commit.
 *
 * -- THE LOCK ORDER, AND IT IS DECLARED --------------------------------------
 *
 *     groups  ->  principals  ->  account_home_groups  ->  group_members
 *
 * Taking four row locks in an order some existing writer contradicts is a
 * deadlock, not a defect a later review finds. `principals` before
 * `account_home_groups` is the load-bearing pair: `principal.terminate` holds
 * the `principals` row (its status UPDATE) and only then reaches
 * `account_home_groups` (B-L7b's clear), so the reverse order here would
 * deadlock against the very act this card wired. Every other writer of these
 * tables enters through `groups` first, or touches one of them only.
 *
 * Every lock is FOR SHARE, never FOR UPDATE: this act READS these rows and
 * needs only their writers to wait. Two concurrent creation defaults never
 * block each other.
 *
 * The read routes pass `lockForWrite: false`: a read that took locks would let
 * any authenticated caller block `PATCH /groups/{id}`, every membership act and
 * every termination.
 *
 * Each lock is its own statement rather than a clause on a join, because
 * PostgreSQL refuses a locking clause on the nullable side of an outer join -
 * and the pointer may name a Group that is gone.
 */
export async function readHomeGroupState(
  queryable: Queryable,
  accountPrincipalId: string,
  options: { lockForWrite: boolean },
): Promise<HomeGroupState & { source: string | null }> {
  const share = options.lockForWrite ? ' FOR SHARE' : '';

  // (1) Which Group to lock. This read is only a POINTER at the lock target;
  // every clause below is read again once every lock is held.
  const target = await queryable.query(
    'SELECT group_id FROM account_home_groups WHERE account_principal_id = $1',
    [accountPrincipalId],
  );
  if (target.rows.length === 0) {
    // No pointer, so no Group to lock - but the Account's own row still is, so
    // `no_home_group` is decided against a status this act HOLDS rather than one
    // it merely saw.
    return {
      pointerGroupId: null, groupExists: false, featured: false, isMember: false,
      actorActive: await isActive(queryable, accountPrincipalId, share), source: null,
    };
  }
  const lockedGroupId = String(target.rows[0].group_id);

  // (2) THE GROUP. A concurrent `PATCH /groups/{id}` clearing `featured` either
  // commits BEFORE this line - in which case step 3 reads the cleared value and
  // the act skips - or waits behind it until the project's transaction commits.
  const group = await queryable.query(
    `SELECT featured FROM groups WHERE id = $1${share}`,
    [lockedGroupId],
  );
  const groupExists = group.rows.length > 0;
  const featured = groupExists ? group.rows[0].featured === true : false;

  // (3) THE ACTOR, second in the declared order. `principal.terminate` UPDATEs
  // this row and only then clears the pointer, so locking it here - and before
  // the pointer below - closes the status window AND keeps the two acts in the
  // same order.
  const actorActive = await isActive(queryable, accountPrincipalId, share);

  // (4) THE POINTER, re-read with every lock held. A pointer cleared or re-aimed
  // while this act waited must not be honoured: the act never grants against a
  // pointer it did not lock for, and a pointer that now names a DIFFERENT Group
  // is treated as absent rather than chased, because chasing it would mean
  // granting against a Group whose `featured` this transaction never locked.
  const pointer = await queryable.query(
    `SELECT group_id, source FROM account_home_groups
      WHERE account_principal_id = $1${share}`,
    [accountPrincipalId],
  );
  const stillPointing = pointer.rows.length > 0
    && String(pointer.rows[0].group_id) === lockedGroupId;
  const source: string | null = pointer.rows.length ? String(pointer.rows[0].source) : null;

  // (5) THE MEMBERSHIP. A concurrent removal of this pair's `group_members`
  //     row waits here.
  const member = await queryable.query(
    `SELECT 1 FROM group_members
      WHERE group_id = $1 AND account_principal_id = $2${share}`,
    [lockedGroupId, accountPrincipalId],
  );

  return {
    pointerGroupId: stillPointing ? lockedGroupId : null,
    groupExists,
    featured,
    isMember: member.rows.length > 0,
    actorActive,
    source,
  };
}

async function isActive(
  queryable: Queryable, principalId: string, share: string,
): Promise<boolean> {
  const status = await queryable.query(
    `SELECT (status = 'active') AS active FROM principals WHERE id = $1${share}`,
    [principalId],
  );
  return status.rows.length > 0 && status.rows[0].active === true;
}

// ────────────────────────────── the audit writer ─────────────────────────────

/**
 * B-L20: the skip reason is validated against the closed set BEFORE the row is
 * written. An unenumerated reason throws, and because this runs inside the
 * project's transaction the whole act rolls back — the reason never reaches the
 * ledger as an unrecognised string that no reader can enumerate.
 */
export async function recordAccessDefaultSkip(
  queryable: Queryable,
  actor: AuditActor,
  projectId: string,
  reason: string,
): Promise<void> {
  if (!isCreationDefaultSkipReason(reason)) {
    throw new Error(
      `project.access_default_skip: '${reason}' is not one of the ratified skip reasons `
      + `(${CREATION_DEFAULT_SKIP_REASONS.join(', ')}). Design 96f0bd3d s7.3.2 is a CLOSED SET `
      + '(build obligation B-L20): add the value to the enumeration deliberately, or fix the caller.',
    );
  }
  await auditService.record({
    action: 'project.access_default_skip',
    actor,
    resourceType: 'project',
    resourceId: projectId,
    metadata: { reason },
  }, queryable);
}

export async function recordAccessDefaultApply(
  queryable: Queryable,
  actor: AuditActor,
  projectId: string,
  groupId: string,
): Promise<void> {
  await auditService.record({
    action: 'project.access_default_apply',
    actor,
    resourceType: 'project',
    resourceId: projectId,
    metadata: { projectId, groupId, verbs: [...CREATION_DEFAULT_VERBS] },
  }, queryable);
}

// ───────────────────────────── the service ───────────────────────────────────

export interface HomeGroupView {
  /** The DERIVED answer: the Group id, or null. */
  groupId: string | null;
  groupName: string | null;
  /** The stored pointer, which survives an unresolving state. */
  pointer: { groupId: string; source: string } | null;
  /** Why it does not resolve, when it does not. Null when it resolves. */
  unresolvedReason: HomeGroupUnresolvedReason | null;
}

export class HomeGroupService {
  /**
   * `GET /principals/{me|id}/home-group`: the resolved value, the raw pointer,
   * and WHY it does not resolve if it does not (design s7.2's writer table).
   */
  async view(accountPrincipalId: string): Promise<HomeGroupView> {
    requirePrincipalId(accountPrincipalId);
    const state = await readHomeGroupState(pool, accountPrincipalId, { lockForWrite: false });
    const resolution = classifyHomeGroup(state);
    const pointer = state.pointerGroupId
      ? { groupId: state.pointerGroupId, source: state.source ?? 'self' } : null;
    if (!resolution.resolved) {
      return { groupId: null, groupName: null, pointer, unresolvedReason: resolution.reason };
    }
    const named = await pool.query('SELECT name FROM groups WHERE id = $1', [resolution.groupId]);
    return {
      groupId: resolution.groupId,
      groupName: named.rows.length ? String(named.rows[0].name) : null,
      pointer,
      unresolvedReason: null,
    };
  }

  /**
   * Set the pointer.
   *
   * The Group must be `featured` AND the Account a member of it. Those are the
   * conditions owner decision 3's "the person may switch among their featured
   * groups" states, and they are checked HERE as an admission rule — which is
   * not the same thing as trusting them later. The creation default re-derives
   * every one of them at its own write, under a lock, because a pointer written
   * correctly this morning says nothing about the state this afternoon.
   *
   * This act CONFERS NOTHING. Authority moves at one later act, s7.3's.
   */
  async set(
    accountPrincipalId: string,
    groupId: unknown,
    source: 'self' | 'admin',
    actor: AuditActor,
  ): Promise<HomeGroupView> {
    requirePrincipalId(accountPrincipalId);
    if (typeof groupId !== 'string' || !UUID_PATTERN.test(groupId)) {
      throw err(422, 'INVALID_HOME_GROUP_VALUE', 'groupId must be a full UUID', 'groupId');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // THE PROTOCOL (round-1 review finding B2). FOR SHARE, held to COMMIT:
      // the clear act and the Group delete take this row FOR UPDATE, so a
      // pointer can no longer appear between their count and their delete.
      // Two people choosing the same home group never block each other.
      const group = await client.query(
        'SELECT id, featured FROM groups WHERE id = $1 FOR SHARE', [groupId]);
      if (group.rows.length === 0) {
        throw err(404, 'GROUP_NOT_FOUND', 'No such group', 'groupId');
      }
      if (group.rows[0].featured !== true) {
        throw err(422, 'GROUP_NOT_FEATURED',
          'a home group is chosen from the FEATURED groups; this one is not featured', 'groupId');
      }
      // Termination locks the principal before clearing its pointer. Hold the
      // same row until COMMIT so an in-flight setter cannot undo offboarding.
      // The shared order is groups -> principals -> account_home_groups.
      const account = await client.query(
        'SELECT id, status FROM principals WHERE id = $1 FOR SHARE', [accountPrincipalId]);
      if (account.rows.length === 0 || account.rows[0].status !== 'active') {
        throw err(422, 'HOME_GROUP_ACCOUNT_INACTIVE',
          'A home group can be set only for an active Account');
      }
      const member = await client.query(
        'SELECT 1 FROM group_members WHERE group_id = $1 AND account_principal_id = $2',
        [groupId, accountPrincipalId],
      );
      if (member.rows.length === 0) {
        throw err(422, 'NOT_A_GROUP_MEMBER',
          'a home group is one the Account belongs to; this Account is not a member of it', 'groupId');
      }
      await client.query(
        `INSERT INTO account_home_groups (account_principal_id, group_id, source, set_by_principal_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (account_principal_id) DO UPDATE
           SET group_id = EXCLUDED.group_id,
               source = EXCLUDED.source,
               set_by_principal_id = EXCLUDED.set_by_principal_id,
               set_at = now()`,
        [accountPrincipalId, groupId, source, actor.principalId ?? null],
      );
      await auditService.record({
        action: 'home_group.set',
        actor,
        resourceType: 'principal',
        resourceId: accountPrincipalId,
        metadata: { accountPrincipalId, groupId, source },
      }, client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      // The refusal is a DURABLE audited denial, written on the POOL: a denial
      // recorded on the transaction this refusal aborts is a denial the
      // rollback erases (the s5.2 rule-8 pattern in CredentialLifecycleService).
      if (e instanceof HomeGroupError) {
        await auditService.record({
          action: 'home_group.set',
          actor,
          outcome: 'denied',
          resourceType: 'principal',
          resourceId: accountPrincipalId,
          metadata: { accountPrincipalId, groupId: String(groupId), source, refusal: e.code },
        }).catch(() => undefined);
      }
      throw e;
    } finally {
      client.release();
    }
    return this.view(accountPrincipalId);
  }

  /** Clear the caller's own pointer. Clearing an absent pointer is a no-op. */
  async clear(accountPrincipalId: string, actor: AuditActor): Promise<HomeGroupView> {
    requirePrincipalId(accountPrincipalId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const removed = await client.query(
        'DELETE FROM account_home_groups WHERE account_principal_id = $1 RETURNING group_id, source',
        [accountPrincipalId],
      );
      if (removed.rows.length > 0) {
        await auditService.record({
          action: 'home_group.clear',
          actor,
          resourceType: 'principal',
          resourceId: accountPrincipalId,
          metadata: {
            accountPrincipalId,
            groupId: String(removed.rows[0].group_id),
            source: String(removed.rows[0].source),
            via: 'self',
          },
        }, client);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    return this.view(accountPrincipalId);
  }

  /**
   * How many Accounts point at this Group. `GroupService.remove` asks before it
   * deletes, so the operator gets `GROUP_IS_A_HOME_GROUP` naming the COUNT and
   * never the identities — the count is operational, the identities are
   * directory disclosure the delete surface has no reason to make.
   */
  async countPointersTo(groupId: string, queryable: Queryable = pool): Promise<number> {
    const result = await queryable.query(
      'SELECT COUNT(*)::int AS n FROM account_home_groups WHERE group_id = $1', [groupId],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  /**
   * The ROOT-PLANE clear act behind `DELETE /groups/{id}/home-pointers`: every
   * pointer at one Group, cleared in ONE transaction, each clear audited
   * (design s7.2). This is the `identity_provider_login_groups` pattern — the
   * operator removes the dependency first, and that removal is itself audited.
   */
  async clearPointersToGroup(groupId: string, actor: AuditActor): Promise<{ cleared: number }> {
    if (!UUID_PATTERN.test(groupId)) {
      throw err(400, 'INVALID_GROUP_ID', 'group id must be a full UUID');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // FOR UPDATE, held to COMMIT: every pointer-set path takes this row FOR
      // SHARE, so no pointer can be written at this Group between the delete
      // below and this transaction's commit. Without it the act could report
      // success with a pointer still standing (round-1 review finding B2).
      const exists = await client.query(
        'SELECT 1 FROM groups WHERE id = $1 FOR UPDATE', [groupId]);
      if (exists.rows.length === 0) throw err(404, 'GROUP_NOT_FOUND', 'No such group');
      const cleared = await clearPointersOnClient(
        client, actor,
        'DELETE FROM account_home_groups WHERE group_id = $1'
        + ' RETURNING account_principal_id, group_id, source',
        [groupId], 'group.home_pointer_clear',
      );
      await client.query('COMMIT');
      return { cleared };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

}

/**
 * BUILD OBLIGATION B-L7b: the home-pointer clear, wired into offboarding.
 *
 * Termination flips `principals.status` rather than deleting the row, so the
 * CASCADE never fires and the pointer of a terminated Account would sit there
 * indefinitely — resolving to NULL (correct) but still holding
 * `ON DELETE RESTRICT` over a Group nobody can now delete without an operator
 * hunting for who, exactly, is still pointing at it. So the pointer goes with
 * the termination, in the SAME transaction, and each clear is audited.
 *
 * Exported as a function taking the caller's client because the terminate act
 * owns its own transaction and this must not open a second one.
 */
export async function clearHomePointersForPrincipals(
  client: Queryable, principalIds: string[], actor: AuditActor, via: string,
): Promise<number> {
  if (principalIds.length === 0) return 0;
  return clearPointersOnClient(
    client, actor,
    'DELETE FROM account_home_groups WHERE account_principal_id = ANY($1::uuid[])'
    + ' RETURNING account_principal_id, group_id, source',
    [principalIds], via,
  );
}

/**
 * Delete the rows and audit ONE `home_group.clear` per Account.
 *
 * `deleteSql` is a `DELETE ... RETURNING`, not a SELECT followed by a DELETE of
 * the ids it saw (round-1 review finding B2). The set that is audited IS the
 * set that was removed, in one statement: an enumeration that has to be right
 * is a second chance to be wrong, and the row that arrives between the two
 * statements is exactly the row the act promised to have cleared.
 */
async function clearPointersOnClient(
  client: Queryable, actor: AuditActor, deleteSql: string, params: unknown[], via: string,
): Promise<number> {
  const rows = await client.query(deleteSql, params);
  if (rows.rows.length === 0) return 0;
  for (const row of rows.rows) {
    await auditService.record({
      action: 'home_group.clear',
      actor,
      resourceType: 'principal',
      resourceId: String(row.account_principal_id),
      metadata: {
        accountPrincipalId: String(row.account_principal_id),
        groupId: String(row.group_id),
        source: String(row.source),
        via,
      },
    }, client);
  }
  return rows.rows.length;
}

function requirePrincipalId(id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw err(400, 'INVALID_PRINCIPAL_ID', 'principal id must be a full UUID');
  }
}

export const homeGroupService = new HomeGroupService();
