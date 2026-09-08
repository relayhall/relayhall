// GroupService.ts — the Groups substrate (RH-P3.AZ-S1, card c3716fe7;
// AUTHZ design 4d961e37 §3, vocabulary amendment A17.6; sync semantics
// AZ-30).
//
// A Group is a board-minted object with an immutable id whose MEMBERS ARE
// ACCOUNTS ONLY — human and service Accounts, kind-differentiated in every
// listing; agent-kind and parented identities are never members (typed
// refusal here, trigger-enforced in migration 094). Group MUTATION is
// owner-plane (the /groups scope rules route every non-GET method to the
// root sentinel, T13); introspection rides principals:read (§9.1).
//
// Membership source (AZ-30): 'local' rows are board-authored and SURVIVE
// directory removal as explicit, audited exceptions (T33); 'directory'
// rows belong to the sync snapshot and are dropped when the directory no
// longer lists the member (T31). The provider binding is Phase 5 (task
// 2ae39bda). DirectoryCarriageService now owns directory ingestion;
// recordSyncFailure/syncStatus carry the fail-closed bookkeeping seam: a failed sync KEEPS the last snapshot
// and only moves the attempt watermark, and staleness past the threshold
// (default 24h) is surfaced to callers (T32).
//
// The group GRANT arm lives in GrantService.activeGrantCondition (the 078
// seam, consumed at this slice): membership resolves by join at query
// time, restricted to ACTIVE member principals so a disabled — and, post-
// 096, terminated — Account loses group authority IMMEDIATELY (T34).
// Deleting a group deletes its grant rows in the same transaction: grants
// are live configuration (070 doctrine), and a grant naming a dead group
// id would be unreachable-but-present configuration noise.
import type { PoolClient } from 'pg';

import { pool } from '../db/connection';
import { consumeDirectoryMembershipPermit } from './DirectoryCarriageService';
import { auditService, type AuditActor } from './AuditService';
// RH-LENSES-b (card 4287af8a): the home-group POINTER's dependency on a Group.
// `ON DELETE RESTRICT` on `account_home_groups.group_id` needs a PATH, and this
// is it — the count for the named refusal below (design 96f0bd3d s7.2).
import { homeGroupService } from './HomeGroupService';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The carriage service supplies its locked transaction and observation flag.
 * Omitting the options is refused: standalone snapshots bypass carriage. */
export interface ApplyAccountDirectorySnapshotOptions {
  client?: PoolClient;
  advanceWatermark?: boolean;
}

export const GROUP_MEMBER_SOURCES = ['local', 'directory'] as const;
export type GroupMemberSource = (typeof GROUP_MEMBER_SOURCES)[number];

export interface GroupRecord {
  id: string;
  name: string;
  description: string;
  createdByPrincipalId: string | null;
  createdAt: string;
  updatedAt: string;
  memberCount: number;
  /**
   * SS-12 — the directory binding, both columns or neither (migration 104's
   * `groups_directory_binding_complete`). A Group with no binding is local-only
   * and no sync path touches it, which is AZ-30's `source=local` rule one level
   * up. `externalGroupRef` is an OPAQUE string: it is surfaced for display and
   * matched byte-exactly, never parsed.
   */
  identityProviderId: string | null;
  externalGroupRef: string | null;
  /**
   * RH-LENSES-b (design 96f0bd3d s7.1): presentation-level promotion. It
   * GRANTS NOTHING and no authorization predicate reads it; it is one input to
   * the DERIVED home-group resolver of s7.2.
   */
  featured: boolean;
}

export interface GroupMemberRecord {
  groupId: string;
  accountPrincipalId: string;
  handle: string;
  kind: 'human' | 'service';
  status: string;
  source: GroupMemberSource;
  addedByPrincipalId: string | null;
  addedAt: string;
}

export interface DirectorySyncStatus {
  provider: string;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastErrorPresent: boolean;
  stalenessThresholdHours: number;
  stale: boolean;
}

export class GroupError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'GroupError';
  }
}

const err = (status: number, code: string, message: string, field?: string) =>
  new GroupError(status, code, message, field);

function mapGroup(row: any): GroupRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    createdByPrincipalId: row.created_by_principal_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    memberCount: Number(row.member_count ?? 0),
    identityProviderId: row.identity_provider_id ?? null,
    externalGroupRef: row.external_group_ref ?? null,
    featured: row.featured === true,
  };
}

function mapMember(row: any): GroupMemberRecord {
  return {
    groupId: row.group_id,
    accountPrincipalId: row.account_principal_id,
    handle: row.handle,
    kind: row.kind,
    status: row.status,
    source: row.source,
    addedByPrincipalId: row.added_by_principal_id ?? null,
    addedAt: row.added_at,
  };
}

function requireGroupId(id: unknown): string {
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    throw err(400, 'INVALID_GROUP_ID', 'group id must be a full UUID');
  }
  return id;
}

/**
 * EXPORTED for RH-LENSES-a (card `74e02a05`), and exported rather than
 * copied for the obvious reason: *Use this group* writes a `groups` row
 * inside the carriage transaction, and a second name rule would be a second
 * answer to "what may a Group be called?". The bound is 120 characters and
 * it is this function's, not the schema's -- `groups_name_nonempty` only
 * refuses blank.
 */
export function validateGroupName(name: unknown): string {
  return validateName(name);
}

/** EXPORTED for the same reason as `validateGroupName`. */
export function validateGroupDescription(description: unknown): string {
  return validateDescription(description);
}

function validateName(name: unknown): string {
  if (typeof name !== 'string' || name.trim() === '') {
    throw err(422, 'INVALID_GROUP_VALUE', 'name must be a non-empty string', 'name');
  }
  if (name.trim().length > 120) {
    throw err(422, 'INVALID_GROUP_VALUE', 'name must be at most 120 characters', 'name');
  }
  return name.trim();
}

function validateDescription(description: unknown): string {
  if (description === undefined || description === null) return '';
  if (typeof description !== 'string') {
    throw err(422, 'INVALID_GROUP_VALUE', 'description must be a string', 'description');
  }
  if (description.length > 2000) {
    throw err(422, 'INVALID_GROUP_VALUE', 'description must be at most 2000 characters', 'description');
  }
  return description;
}

const GROUP_WITH_COUNT = `
  SELECT gr.*, (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = gr.id) AS member_count
    FROM groups gr`;

export class GroupService {
  async list(): Promise<GroupRecord[]> {
    const result = await pool.query(`${GROUP_WITH_COUNT} ORDER BY lower(gr.name) ASC, gr.id ASC`);
    return result.rows.map(mapGroup);
  }

  async get(id: string): Promise<GroupRecord> {
    requireGroupId(id);
    const result = await pool.query(`${GROUP_WITH_COUNT} WHERE gr.id = $1`, [id]);
    if (result.rows.length === 0) throw err(404, 'GROUP_NOT_FOUND', 'No such group');
    return mapGroup(result.rows[0]);
  }

  /** Members, kind-differentiated (A17.6) with live principal status so
   * callers can see suspended Accounts (their authority is already gone at
   * query time — T34 lives in the grant arm, not in this listing). */
  async members(groupId: string): Promise<GroupMemberRecord[]> {
    await this.get(groupId);
    const result = await pool.query(
      `SELECT gm.group_id, gm.account_principal_id, gm.source, gm.added_by_principal_id,
              gm.added_at, p.handle, p.kind, p.status
         FROM group_members gm
         JOIN principals p ON p.id = gm.account_principal_id
        WHERE gm.group_id = $1
        ORDER BY p.handle ASC`,
      [groupId],
    );
    return result.rows.map(mapMember);
  }

  async create(input: { name?: unknown; description?: unknown }, actor: AuditActor): Promise<GroupRecord> {
    const name = validateName(input.name);
    const description = validateDescription(input.description);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO groups (name, description, created_by_principal_id)
         VALUES ($1, $2, $3) RETURNING *, 0 AS member_count`,
        [name, description, actor.principalId ?? null],
      );
      const group = mapGroup(result.rows[0]);
      await auditService.record({
        action: 'group.create',
        actor,
        resourceType: 'group',
        resourceId: group.id,
        metadata: { name: group.name },
      }, client);
      await client.query('COMMIT');
      return group;
    } catch (e) {
      await client.query('ROLLBACK');
      if (e instanceof Error && e.message.includes('duplicate key')) {
        throw err(409, 'GROUP_NAME_EXISTS', 'A group with that name already exists (names are case-insensitive)');
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async update(
    id: string,
    input: {
      name?: unknown;
      description?: unknown;
      identityProviderId?: unknown;
      externalGroupRef?: unknown;
      featured?: unknown;
    },
    actor: AuditActor,
  ): Promise<GroupRecord> {
    requireGroupId(id);
    const sets: string[] = [];
    const params: unknown[] = [];
    const changed: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = validateName(input.name);
      params.push(name);
      sets.push(`name = $${params.length}`);
      changed.name = name;
    }
    if (input.description !== undefined) {
      const description = validateDescription(input.description);
      params.push(description);
      sets.push(`description = $${params.length}`);
      changed.description = true;
    }
    // RH-LENSES-a's closure stands (dispatcher ruling, C9 composition):
    // PATCH /groups/{id} does NOT write a directory binding. The directory
    // group reference catalog is the single seam that binds a Group, inside
    // its carriage transaction, so a write attempted here is refused by name
    // rather than half-applied beside a rename.
    if ('identityProviderId' in input || 'externalGroupRef' in input) {
      throw err(409, 'DIRECTORY_BINDING_MANAGED',
        'Directory bindings are managed through the directory group reference catalog.');
    }
    // RH-LENSES-b s7.1. `featured` is written here because `PATCH /groups/{id}`
    // is the surface the design names, and that surface is already behind the
    // root sentinel for every non-GET method (`scopeMap.ts`, the /groups family)
    // — the ceiling is inherited, not invented. It is AUDITED as its own act,
    // `group.feature_set` with old and new, because a promotion that changes
    // which Groups a person may choose as their home is not a rename.
    let featuredValue: boolean | null = null;
    if (input.featured !== undefined) {
      if (typeof input.featured !== 'boolean') {
        throw err(422, 'INVALID_GROUP_VALUE', 'featured must be a boolean', 'featured');
      }
      featuredValue = input.featured;
      params.push(featuredValue);
      sets.push(`featured = $${params.length}`);
    }
    if (sets.length === 0) {
      throw err(422, 'INVALID_GROUP_VALUE',
        'nothing to update: provide name, description or featured');
    }
    params.push(id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The OLD value, read under the row lock inside this transaction, so
      // `group.feature_set` records a transition and not a guess: an audit row
      // saying `to: true` with no `from` cannot tell a promotion from a no-op.
      let featureSet: { from: boolean; to: boolean } | null = null;
      if (featuredValue !== null) {
        const prior = await client.query('SELECT featured FROM groups WHERE id = $1 FOR UPDATE', [id]);
        if (prior.rows.length === 0) throw err(404, 'GROUP_NOT_FOUND', 'No such group');
        featureSet = { from: prior.rows[0].featured === true, to: featuredValue };
      }
      const result = await client.query(
        `UPDATE groups SET ${sets.join(', ')}, updated_at = NOW()
          WHERE id = $${params.length}
          RETURNING *, (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = groups.id) AS member_count`,
        params,
      );
      if (result.rows.length === 0) throw err(404, 'GROUP_NOT_FOUND', 'No such group');
      const group = mapGroup(result.rows[0]);
      if (featureSet) {
        await auditService.record({
          action: 'group.feature_set',
          actor,
          resourceType: 'group',
          resourceId: group.id,
          metadata: { groupId: group.id, from: featureSet.from, to: featureSet.to },
        }, client);
      }
      if (Object.keys(changed).length > 0) {
        await auditService.record({
          action: 'group.update',
          actor,
          resourceType: 'group',
          resourceId: group.id,
          metadata: changed,
        }, client);
      }
      await client.query('COMMIT');
      return group;
    } catch (e) {
      await client.query('ROLLBACK');
      if (e instanceof Error && e.message.includes('duplicate key')) {
        // Two unique indexes can raise this now, and reporting a binding
        // collision as a NAME collision would send an operator to fix the
        // wrong field. The specific one is checked first.
        if (e.message.includes('ux_groups_directory_binding')) {
          throw err(
            409,
            'GROUP_BINDING_EXISTS',
            'another Group is already bound to that external group reference at this Identity provider',
          );
        }
        throw err(409, 'GROUP_NAME_EXISTS', 'A group with that name already exists (names are case-insensitive)');
      }
      throw e;
    } finally {
      client.release();
    }
  }

  /** Delete a group and, in the same transaction, its grant rows — grants
   * are live configuration (070 doctrine), so authority dies with the
   * group, loudly and audited. Membership rows must be removed first: a
   * populated group is not silently disbanded. */
  async remove(id: string, actor: AuditActor): Promise<GroupRecord> {
    requireGroupId(id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // RH-LENSES-b, round-1 review finding B2: the Group row is taken FOR
      // UPDATE before anything is counted. Every pointer-set path takes it FOR
      // SHARE, so a home pointer cannot arrive between the count below and this
      // DELETE - which is what turned the named, count-only
      // GROUP_IS_A_HOME_GROUP refusal into a raw foreign-key violation, the
      // exact 500 that refusal exists to replace.
      await client.query('SELECT 1 FROM groups WHERE id = $1 FOR UPDATE', [id]);
      const members = await client.query(
        'SELECT COUNT(*)::int AS n FROM group_members WHERE group_id = $1', [id],
      );
      if ((members.rows[0]?.n ?? 0) > 0) {
        throw err(409, 'GROUP_NOT_EMPTY', 'Remove every member before deleting the group');
      }
      // SSO-R4: a Group that gates federated login is not deletable out from
      // under the whitelist that names it. Migration 105's FK is ON DELETE
      // RESTRICT, so the delete below would fail anyway — but it would fail as
      // a raw constraint violation naming a table the operator has no reason to
      // know about. The refusal is issued HERE, by name, and it says which
      // Identity provider still lists the Group, because the alternative is a
      // 500 that reads as a bug. This is the W2 Identity-provider-deletion lesson
      // (evidence `6f63a606` finding 1) applied one table over: the schema
      // makes the bad state impossible, and the service explains it.
      const gating = await client.query(
        `SELECT p.name
           FROM identity_provider_login_groups w
           JOIN identity_providers p ON p.id = w.identity_provider_id
          WHERE w.group_id = $1
          ORDER BY p.name`,
        [id],
      );
      if (gating.rows.length > 0) {
        const names = gating.rows.map((row) => String(row.name)).join(', ');
        throw err(
          409,
          'GROUP_GATES_LOGIN',
          `This group admits federated login at: ${names}. Remove it from that Identity provider's allowed login groups before deleting it.`,
        );
      }
      // RH-LENSES-b (design 96f0bd3d s7.2), acceptance A-L38. Migration 126's FK
      // on `account_home_groups.group_id` is ON DELETE RESTRICT, so the delete
      // below would fail anyway — as a raw constraint violation naming a table
      // the operator has no reason to know about. The refusal is issued HERE, by
      // name, and it names a COUNT and never the identities: how many people
      // still point at this Group is operational, who they are is directory
      // disclosure the delete surface has no reason to make. The root-plane act
      // `DELETE /groups/{id}/home-pointers` clears them, audited, first — the
      // `identity_provider_login_groups` pattern one table over.
      const homePointers = await homeGroupService.countPointersTo(id, client);
      if (homePointers > 0) {
        throw err(
          409,
          'GROUP_IS_A_HOME_GROUP',
          `${homePointers} ${homePointers === 1 ? 'Account has' : 'Accounts have'} this group as their home group. `
          + 'Clear those home pointers (DELETE /groups/{id}/home-pointers) before deleting it.',
        );
      }
      const grants = await client.query(
        `DELETE FROM grants WHERE grantee_type = 'group' AND grantee_id = $1 RETURNING id`, [id],
      );
      const result = await client.query(
        'DELETE FROM groups WHERE id = $1 RETURNING *, 0 AS member_count', [id],
      );
      if (result.rows.length === 0) throw err(404, 'GROUP_NOT_FOUND', 'No such group');
      const group = mapGroup(result.rows[0]);
      await auditService.record({
        action: 'group.delete',
        actor,
        resourceType: 'group',
        resourceId: group.id,
        metadata: { name: group.name, revokedGrantRows: grants.rows.length },
      }, client);
      await client.query('COMMIT');
      return group;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** Add an Account member. The 094 trigger enforces the Account shape
   * (never agent-kind; parentless once 096 lands); the service adds the
   * ACTIVE requirement for new rows — suspending an Account later does not
   * remove its rows, it silences them at query time (T34). */
  async addMember(
    groupId: string,
    input: { accountPrincipalId?: unknown; source?: unknown },
    actor: AuditActor,
  ): Promise<GroupMemberRecord> {
    await this.get(groupId);
    const principalId = input.accountPrincipalId;
    if (typeof principalId !== 'string' || !UUID_PATTERN.test(principalId)) {
      throw err(422, 'INVALID_GROUP_VALUE', 'accountPrincipalId must be a principal UUID', 'accountPrincipalId');
    }
    const source = input.source === undefined ? 'local' : input.source;
    if (source !== 'local') {
      throw err(409, 'DIRECTORY_MEMBERSHIP_MANAGED', 'Directory membership is derived from directory carriage.', 'source');
    }
    const principal = await pool.query(
      'SELECT id, handle, kind, status, parent_principal_id, legacy_identity FROM principals WHERE id = $1', [principalId],
    );
    if (principal.rows.length === 0) {
      throw err(422, 'MEMBER_NOT_FOUND', 'accountPrincipalId resolves to no principal', 'accountPrincipalId');
    }
    const row = principal.rows[0];
    if (row.kind === 'agent') {
      throw err(422, 'MEMBER_NOT_ACCOUNT', 'group members must be Accounts (A17.6): agent identities are never members', 'accountPrincipalId');
    }
    if (row.parent_principal_id) {
      throw err(422, 'MEMBER_NOT_ACCOUNT', 'group members must be parentless Accounts (A17.6): parented identities are never members', 'accountPrincipalId');
    }
    if (row.legacy_identity) {
      // T37 (§10): legacy identities are frozen out; the refusal is audited.
      await auditService.record({
        action: 'legacy.refused', actor, outcome: 'denied',
        resourceType: 'principal', resourceId: principalId,
        metadata: { act: 'group.member_add', groupId },
      });
      throw err(409, 'LEGACY_FROZEN', 'legacy identities are frozen out of Group membership (§10, T37)', 'accountPrincipalId');
    }
    if (row.status !== 'active') {
      throw err(422, 'MEMBER_DISABLED', 'members must be active Accounts at add time', 'accountPrincipalId');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO group_members (group_id, account_principal_id, source, added_by_principal_id)
         VALUES ($1, $2, 'local', $3) RETURNING *`,
        [groupId, principalId, actor.principalId ?? null],
      );
      await auditService.record({
        action: 'group.member_add',
        actor,
        resourceType: 'group',
        resourceId: groupId,
        metadata: { accountPrincipalId: principalId, handle: row.handle, kind: row.kind, source },
      }, client);
      await client.query('COMMIT');
      return mapMember({ ...result.rows[0], handle: row.handle, kind: row.kind, status: row.status });
    } catch (e) {
      await client.query('ROLLBACK');
      if (e instanceof Error && e.message.includes('duplicate key')) {
        throw err(409, 'MEMBER_EXISTS', 'That Account is already a member of the group');
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async removeMember(groupId: string, principalId: string, actor: AuditActor): Promise<void> {
    requireGroupId(groupId);
    if (!UUID_PATTERN.test(principalId)) {
      throw err(400, 'INVALID_GROUP_VALUE', 'member id must be a principal UUID');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        "DELETE FROM group_members WHERE group_id = $1 AND account_principal_id = $2 AND source = 'local' RETURNING source",
        [groupId, principalId],
      );
      if (result.rows.length === 0) {
        throw err(404, 'MEMBER_NOT_FOUND', 'That Account is not a member of the group');
      }
      await auditService.record({
        action: 'group.member_remove',
        actor,
        resourceType: 'group',
        resourceId: groupId,
        metadata: { accountPrincipalId: principalId, source: result.rows[0].source },
      }, client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** Retired full-snapshot entry point. Kept as a named refusal for old callers. */
  async applyDirectorySnapshot(
    provider: string,
    entries: Array<{ groupId: string; accountPrincipalId: string }>,
    actor: AuditActor,
  ): Promise<{ added: number; removed: number }> {
    if (typeof provider !== 'string' || provider.trim() === '') {
      throw err(422, 'INVALID_GROUP_VALUE', 'provider must be a non-empty string', 'provider');
    }
    for (const entry of entries) {
      if (!UUID_PATTERN.test(String(entry.groupId)) || !UUID_PATTERN.test(String(entry.accountPrincipalId))) {
        throw err(422, 'INVALID_GROUP_VALUE', 'snapshot entries must carry full UUIDs');
      }
    }
    void actor;
    throw err(409, 'DIRECTORY_MEMBERSHIP_MANAGED',
      'Directory snapshots must be applied through the directory carriage service.');
  }

  /** Internal membership sink. A single-use permit binds the exact transaction,
   * provider, Account, result set and observation flag to the carriage ledger. */
  async applyAccountDirectorySnapshot(
    provider: string,
    accountPrincipalId: string,
    groupIds: readonly string[],
    actor: AuditActor,
    options: ApplyAccountDirectorySnapshotOptions = {},
  ): Promise<{ added: number; removed: number }> {
    if (typeof provider !== 'string' || provider.trim() === '') {
      throw err(422, 'INVALID_GROUP_VALUE', 'identityProviderId must be a non-empty string', 'identityProviderId');
    }
    if (!UUID_PATTERN.test(String(accountPrincipalId))) {
      throw err(422, 'INVALID_GROUP_VALUE', 'accountPrincipalId must be a full UUID', 'accountPrincipalId');
    }
    for (const groupId of groupIds) {
      if (!UUID_PATTERN.test(String(groupId))) {
        throw err(422, 'INVALID_GROUP_VALUE', 'snapshot entries must carry full UUIDs');
      }
    }
    const client = consumeDirectoryMembershipPermit(
      options.client, provider, accountPrincipalId, groupIds, options.advanceWatermark !== false,
    );
    const advanceWatermark = options.advanceWatermark !== false;
    try {
      // The permitted client remains owned by the carriage transaction.

      const wanted = new Set(groupIds.map((groupId) => String(groupId)));
      // Scoped to THIS Account by the statement itself — see the note above.
      const existing = await client.query(
        `SELECT group_id FROM group_members
          WHERE source = 'directory' AND account_principal_id = $1 FOR UPDATE`,
        [accountPrincipalId],
      );
      let removed = 0;
      for (const row of existing.rows) {
        if (!wanted.has(String(row.group_id))) {
          await client.query(
            'DELETE FROM group_members WHERE group_id = $1 AND account_principal_id = $2',
            [row.group_id, accountPrincipalId],
          );
          await auditService.record({
            action: 'group.member_remove',
            actor,
            resourceType: 'group',
            resourceId: String(row.group_id),
            metadata: {
              accountPrincipalId,
              source: 'directory',
              via: 'directory-sync',
              provider,
              scope: 'account',
            },
          }, client);
          removed += 1;
        }
      }
      let added = 0;
      for (const groupId of wanted) {
        const result = await client.query(
          `INSERT INTO group_members (group_id, account_principal_id, source, added_by_principal_id)
           VALUES ($1, $2, 'directory', $3)
           ON CONFLICT (group_id, account_principal_id) DO NOTHING
           RETURNING group_id`,
          [groupId, accountPrincipalId, actor.principalId ?? null],
        );
        if (result.rows.length > 0) {
          await auditService.record({
            action: 'group.member_add',
            actor,
            resourceType: 'group',
            resourceId: groupId,
            metadata: {
              accountPrincipalId,
              source: 'directory',
              via: 'directory-sync',
              provider,
              scope: 'account',
            },
          }, client);
          added += 1;
        }
      }
      // THE WATERMARK IS AN OBSERVATION, NOT A SIDE EFFECT. It advances
      // for a claim login and a SCIM push, which are things the directory
      // said; it does NOT advance for a bind, a rebind, a housekeeping
      // delete or a provider removal, which are the board's own acts.
      // Advancing it for those would refresh a provider's "last
      // successful snapshot" when nothing was received and silence
      // AZ-30's staleness alarm — a contradiction of SS-13's fail-closed
      // observability contract, and the defect design round 2 found.
      if (advanceWatermark) {
        await client.query(
          `INSERT INTO directory_sync_state (provider, last_success_at, last_attempt_at, last_error_present)
           VALUES ($1, NOW(), NOW(), FALSE)
           ON CONFLICT (provider) DO UPDATE
             SET last_success_at = NOW(), last_attempt_at = NOW(), last_error_present = FALSE`,
          [provider],
        );
      }

      return { added, removed };
    } catch (e) {
      // The carriage transaction owns rollback.

      throw e;
    }
  }

  /** T32: a failed sync KEEPS the snapshot — only the attempt watermark and
   * the error flag move. Staleness is judged from last_success_at. */
  async recordSyncFailure(provider: string): Promise<void> {
    await pool.query(
      `INSERT INTO directory_sync_state (provider, last_attempt_at, last_error_present)
       VALUES ($1, NOW(), TRUE)
       ON CONFLICT (provider) DO UPDATE
         SET last_attempt_at = NOW(), last_error_present = TRUE`,
      [provider],
    );
  }

  /** Staleness alarm read (T32): stale once last_success_at is older than
   * the per-provider threshold (default 24h) — or when a provider has
   * never succeeded at all. */
  async syncStatus(): Promise<DirectorySyncStatus[]> {
    const result = await pool.query(
      `SELECT provider, last_success_at, last_attempt_at, last_error_present,
              staleness_threshold_hours,
              (last_success_at IS NULL
               OR last_success_at < NOW() - make_interval(hours => staleness_threshold_hours)) AS stale
         FROM directory_sync_state ORDER BY provider ASC`,
    );
    return result.rows.map((row) => ({
      provider: row.provider,
      lastSuccessAt: row.last_success_at ?? null,
      lastAttemptAt: row.last_attempt_at ?? null,
      lastErrorPresent: Boolean(row.last_error_present),
      stalenessThresholdHours: Number(row.staleness_threshold_hours),
      stale: Boolean(row.stale),
    }));
  }
}

export const groupService = new GroupService();
