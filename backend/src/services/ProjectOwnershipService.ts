import type { PoolClient } from 'pg';
import { resourceAccountControl } from './AccountControlService';
import { pool } from '../db/connection';
import { authorizationRepository } from './AuthorizationRepository';
import { authorizationService, type AuthorizationActor } from './AuthorizationService';
import { scopesForRole } from '../utils/identityScopes';
import { isLoginSessionKind } from '../utils/administratorSession';
import { ResourceContractError } from './ProjectResourceService';
import { projectService, type Project, type CreateProjectInput, type CreationActor } from './ProjectService';
import { auditService, type AuditActor } from './AuditService';
import { feedEventService } from './FeedEventService';
import { logCaughtFailure } from '../utils/secretSafeLog';
import {
  groupOwnershipStandingTest, groupTransferAuditFields, groupTransferDecider, GroupOwnershipTransferError,
  type GroupTransferStanding,
} from './GroupOwnershipTransfer';
import {
  auditStewardTransferRefusal, consumeStewardTransferStepUp, stewardTransferStanding, type StewardTransferCaller,
  type StewardTransferRefusalTarget,
} from './GroupOwnerStewardTransfer';
import { runCreationTransaction } from '../db/creationTransaction';
import type { TaskActor } from './TaskHistoryService';

export type OwnerAccessReason =
  | 'REQUIRES_HUMAN_LOGIN'
  | 'SESSION_SCOPE_CEILING'
  | 'CURRENT_ROLE_CEILING'
  | 'NO_PROJECT_ADMIN';

export interface OwnerAccess {
  allowed: boolean;
  reason: OwnerAccessReason | null;
  owner?: { id: string; handle: string; displayName: string | null; status: string } | null;
}

export interface OwnerMutationActor {
  authorization: AuthorizationActor;
  authMethod?: AuditActor['authMethod'];
  audit: AuditActor;
  sessionId?: string | null;
  credentialId?: string | null;
  /** AZ-A12 clause 9(e): the request facts and the body's step-up token. */
  standing?: GroupTransferStanding;
}

/** A Group the owner selector offers (clause 12): featured first, then by name. */
export interface GroupOwnerCandidate { id: string; name: string; featured: boolean }

interface PrincipalRow {
  id: string;
  handle: string;
  kind: string;
  status: string;
  role: string | null;
  parent_principal_id: string | null;
}

type Queryable = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function activeHuman(row: PrincipalRow | undefined): boolean {
  return !!row && row.kind === 'human' && row.status === 'active' && !row.parent_principal_id;
}

function freshActor(row: PrincipalRow): AuthorizationActor {
  return {
    authenticated: true,
    principalId: row.id,
    handle: row.handle,
    role: row.role,
    scopes: scopesForRole(row.role),
  };
}

/** This decision explains an affordance; it never replaces the locked write check. */
async function decide(
  projectId: string,
  actor: AuthorizationActor,
  authMethod: AuditActor['authMethod'] | undefined,
  current: PrincipalRow | undefined,
  queryable: Queryable,
  authority?: OwnerMutationActor,
  groupInvolved = false,
): Promise<OwnerAccess> {
  const deny = (reason: OwnerAccessReason): OwnerAccess => ({ allowed: false, reason });
  // AZ-A12 clause 9(e): the Main arm is never a decider when the source or the
  // target is a Group; arm (ii) below runs unchanged.
  if (!groupInvolved && authority && (authority.sessionId || authority.credentialId)
    && await resourceAccountControl(queryable as PoolClient, 'project', projectId, {
      principalId: actor.principalId ?? null, handle: actor.handle ?? '', authorization: actor,
      authMethod, sessionId: authority.sessionId, credentialId: authority.credentialId,
    })) return { allowed: true, reason: null };

  if (!actor.authenticated || !actor.principalId || !isLoginSessionKind(authMethod)
    || (actor.delegation?.links?.length ?? 0) > 1 || !activeHuman(current)) {
    return deny('REQUIRES_HUMAN_LOGIN');
  }
  const fresh = freshActor(current!);
  if (!authorizationService.authorizeRoute(fresh, 'projects:admin').allowed) {
    return deny('CURRENT_ROLE_CEILING');
  }
  if (!authorizationService.authorizeRoute(actor, 'projects:admin').allowed) {
    return deny('SESSION_SCOPE_CEILING');
  }
  for (const candidate of [actor, fresh]) {
    if (!(await authorizationRepository.authorizedIds(candidate, 'project', [projectId], 'admin', queryable)).has(projectId)) {
      return deny('NO_PROJECT_ADMIN');
    }
  }
  return { allowed: true, reason: null };
}

let invalidationSink: (recipientIds: string[]) => void = () => undefined;

/** Wired by the server to its existing dashboard WebSocket. No object IDs travel there. */
export function setProjectOwnerInvalidationSink(sink: (recipientIds: string[]) => void): void {
  invalidationSink = sink;
}

/**
 * AZ-A12 clause 13 (card a9b1e69c): who the owner-change hint reaches. The
 * prior and the new owner, as before, and — where either is a Group — the
 * Group's ACTIVE member Accounts, whose authority over the object moved with
 * it. A Group principal never holds a socket (it never authenticates, clause
 * 3(a)), so its own id in the list reaches nobody. The hint carries no object
 * id; next-request authorization stays authoritative.
 */
export async function ownerChangeRecipients(queryable: Queryable, ownerIds: Array<string | null>): Promise<string[]> {
  const owners = [...new Set(ownerIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (owners.length === 0) return [];
  const members = await queryable.query(
    `SELECT DISTINCT member.id::text AS id
       FROM group_members membership
       JOIN principals owning_group ON owning_group.id = membership.group_id AND owning_group.kind = 'group'
       JOIN principals member ON member.id = membership.account_principal_id AND member.status = 'active'
      WHERE membership.group_id = ANY($1::uuid[])`,
    [owners],
  );
  return [...new Set([...owners, ...(members?.rows ?? []).map((row: any) => String(row.id))])];
}

export class ProjectOwnershipService {
  async access(projectId: string, actor: OwnerMutationActor): Promise<OwnerAccess> {
    const current = actor.authorization.principalId
      ? await pool.query(
        `SELECT id, handle, kind, status, role, parent_principal_id
           FROM principals WHERE id = $1`,
        [actor.authorization.principalId],
      ) : { rows: [] };
    const decision = await decide(projectId, actor.authorization, actor.authMethod, current.rows[0], pool, actor);
    const owner = await pool.query(
      `SELECT q.id, q.handle, q.display_name, q.status
         FROM projects p LEFT JOIN principals q ON q.id = p.owner_principal_id
        WHERE p.id = $1`, [projectId],
    );
    const row = owner.rows[0];
    return {
      ...decision,
      owner: row?.id ? {
        id: row.id, handle: row.handle,
        displayName: row.display_name ?? null, status: row.status,
      } : null,
    };
  }

  async candidates(): Promise<Array<{ id: string; handle: string; displayName: string | null }>> {
    const found = await pool.query(
      `SELECT id, handle, display_name, role FROM principals
        WHERE kind = 'human' AND status = 'active' AND parent_principal_id IS NULL
        ORDER BY lower(handle), id`,
    );
    return found.rows.filter((row) => {
      const target = freshActor({ ...row, kind: 'human', status: 'active', parent_principal_id: null });
      return authorizationService.authorizeRoute(target, 'projects:read').allowed
        && authorizationService.authorizeRoute(target, 'projects:write').allowed;
    }).map((row) => ({ id: row.id, handle: row.handle, displayName: row.display_name ?? null }));
  }

  /**
   * AZ-A12 clause 12 (E45 (1)): the Groups the owner selector offers, featured
   * first and then by name, and only to a session the transfer act would admit
   * (root or an administrator login session, clause 9(a)); everyone else gets
   * none. A disabled Group principal is no target (9(a)), so it is not offered.
   */
  async groupCandidates(standing: GroupTransferStanding | undefined): Promise<GroupOwnerCandidate[]> {
    if (!standing || !groupTransferDecider(standing).ok) return [];
    const found = await pool.query(
      `SELECT g.id::text AS id, g.name, g.featured
         FROM groups g JOIN principals gp ON gp.id = g.id AND gp.kind = 'group' AND gp.status = 'active'
        ORDER BY g.featured DESC, lower(g.name), g.id`,
    );
    return found.rows.map((row) => ({ id: String(row.id), name: String(row.name), featured: Boolean(row.featured) }));
  }

  async change(
    projectId: string,
    newOwnerId: string | null,
    revision: string,
    actor: OwnerMutationActor,
  ): Promise<Project> {
    const client = await pool.connect();
    let committed = false;
    let moved: { priorOwnerId: string | null; newOwnerId: string | null } | null = null;
    let result: Project;
    try {
      await client.query('BEGIN');
      const transfer = await this.transferWithin(client, projectId, newOwnerId, revision, actor, false);
      result = transfer.project;
      moved = transfer.moved;
      await client.query('COMMIT');
      committed = true;
    } catch (error) {
      if (!committed) await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (moved) await this.notify(moved.priorOwnerId, moved.newOwnerId);
    return result;
  }

  /**
   * AZ-A12 clause 10(b): the create form's owner selector is create + the
   * clause 9(a) transfer in ONE transaction, under 9(a)'s deciders (root or an
   * administrator login session, with a step-up bound to (`ownership.transfer`,
   * the new Project's id)). The id is allocated by the caller so that the
   * step-up can name it before the Project exists. Only a Group is selected
   * here: a person at create is unchanged (clause 10(a)), and there is no
   * second path. Any refusal rolls the creation back with the transfer.
   */
  async createWithGroupOwner(
    input: CreateProjectInput,
    allocatedId: string,
    ownerGroupId: string,
    creator: CreationActor,
    taskActor: TaskActor,
    actor: OwnerMutationActor,
  ): Promise<Project> {
    let moved: { priorOwnerId: string | null; newOwnerId: string | null } | null = null;
    const project = await runCreationTransaction(pool, taskActor, async (transaction) => {
      const created = await projectService.create(input, creator, transaction, allocatedId);
      const transfer = await this.transferWithin(transaction.client, created.id, ownerGroupId, created.revision, actor, true);
      moved = transfer.moved;
      return transfer.project;
    }, 'ordinary', { isolation: 'read-committed' });
    const done = moved as { priorOwnerId: string | null; newOwnerId: string | null } | null;
    if (done) await this.notify(done.priorOwnerId, done.newOwnerId);
    return project;
  }

  /**
   * PUT /projects/:id/owner/steward - LENSES-c gate (ii) and DD-5 (c1-B, card
   * b5c83682; design delta C.6). The GATE IS THE DECIDER: `decide()` and the
   * Main arm are not consulted (services/GroupOwnerStewardTransfer). In order,
   * in one transaction, every refusal before the step-up is spent: the row
   * lock (404, archived 409); the target's spelling (422); the standing (steps
   * 1 to 3); for (ii) today's person-target checks; the If-Match revision; and
   * only then the step-up bound to ('ownership.transfer', the Project id).
   * The write, its audit row (deciderStanding group-owner), the feed events
   * and the post-commit hint are the administrator route's, unchanged.
   *
   * EVERY refusal of the act, not only the standing's, is audited as a denied
   * project.owner.change row by the one writer, after the ROLLBACK and outside
   * the transaction (C.6, C.7), in the act's catch; `refusal` learns the facts
   * the row names as the act reads them.
   */
  async changeAsGroupOwner(
    projectId: string,
    newOwnerId: string | null,
    revision: string,
    actor: { audit: AuditActor; caller: StewardTransferCaller; stepUpToken: string },
  ): Promise<Project> {
    const refusal: StewardTransferRefusalTarget = {
      objectType: 'project', objectId: String(projectId).toLowerCase(), currentOwnerId: null,
      targetOwnerId: typeof newOwnerId === 'string' ? newOwnerId.toLowerCase() : null,
      audit: { actor: actor.audit, action: 'project.owner.change' },
    };
    const client = await pool.connect();
    let committed = false;
    let moved: { priorOwnerId: string | null; newOwnerId: string | null } | null = null;
    let result: Project;
    try {
      await client.query('BEGIN');
      const projectRows = await client.query('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
      const project = projectRows.rows[0];
      if (!project) throw new ResourceContractError(404, 'PROJECT_NOT_FOUND', 'Project not found');
      if (project.status === 'archived') throw new ResourceContractError(409, 'PROJECT_ARCHIVED', 'Project is archived and read-only');
      if (newOwnerId !== null && (typeof newOwnerId !== 'string' || !UUID.test(newOwnerId))) {
        throw new ResourceContractError(422, 'INVALID_OWNER', 'ownerPrincipalId must be a principal UUID or null', 'ownerPrincipalId');
      }
      const normalizedOwnerId = newOwnerId === null ? null : newOwnerId.toLowerCase();
      const priorOwnerId: string | null = project.owner_principal_id ?? null;
      refusal.objectId = String(project.id).toLowerCase();
      refusal.currentOwnerId = priorOwnerId;
      const input = {
        objectType: 'project' as const, objectId: String(project.id).toLowerCase(),
        currentOwnerId: priorOwnerId, targetOwnerId: normalizedOwnerId,
        caller: actor.caller, writeScope: 'projects:write' as const,
        audit: { actor: actor.audit, action: 'project.owner.change' as const },
      };
      const standing = await stewardTransferStanding(client, input);
      if (standing.shape === 'out') {
        // Today's person-target checks (the administrator route's), on top of membership.
        const targetRows = await client.query(
          `SELECT id, handle, kind, status, role, parent_principal_id FROM principals WHERE id = $1 FOR SHARE`, [normalizedOwnerId]);
        const target = targetRows.rows[0] as PrincipalRow | undefined;
        if (!activeHuman(target)) {
          throw new ResourceContractError(422, 'INVALID_OWNER', 'The selected owner is not an active human Account', 'ownerPrincipalId');
        }
        const targetActor = freshActor(target!);
        if (!authorizationService.authorizeRoute(targetActor, 'projects:read').allowed
          || !authorizationService.authorizeRoute(targetActor, 'projects:write').allowed) {
          throw new ResourceContractError(422, 'INEFFECTIVE_OWNER', 'The selected Account cannot read and write Projects', 'ownerPrincipalId');
        }
      }
      if (!revision) throw new ResourceContractError(400, 'REVISION_REQUIRED', 'The last observed Project revision is required');
      if (revision !== project.revision) {
        throw new ResourceContractError(412, 'REVISION_MISMATCH', 'The Project changed; reload and retry');
      }
      const evidence = await consumeStewardTransferStepUp(client, input, standing, actor.stepUpToken);
      await client.query(
        `UPDATE projects SET owner_principal_id = $2, revision = gen_random_uuid(),
                updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [projectId, normalizedOwnerId],
      );
      await auditService.record({
        action: 'project.owner.change', actor: actor.audit,
        resourceType: 'project', resourceId: projectId,
        metadata: {
          oldOwnerPrincipalId: priorOwnerId, newOwnerPrincipalId: normalizedOwnerId,
          // Clause 9(f), with the third standing (D-12), and which shape admitted it.
          ...groupTransferAuditFields(evidence), stewardShape: standing.shape, owningGroupId: standing.groupId,
        },
      }, client);
      await feedEventService.emit(client, {
        name: 'project.acl_changed', objectType: 'project', objectId: projectId,
        actorPrincipalId: standing.callerId, actorHandle: actor.audit.handle,
        ownerPrincipalId: priorOwnerId, payload: {},
      });
      const phases = await client.query('SELECT id FROM phases WHERE project_id = $1 ORDER BY id', [projectId]);
      for (const phase of phases.rows) {
        await feedEventService.emit(client, {
          name: 'phase.acl_changed', objectType: 'phase', objectId: phase.id,
          projectId, actorPrincipalId: standing.callerId, actorHandle: actor.audit.handle,
          ownerPrincipalId: priorOwnerId, payload: {},
        });
      }
      result = await projectService.getById(projectId, client);
      moved = { priorOwnerId, newOwnerId: normalizedOwnerId };
      await client.query('COMMIT');
      committed = true;
    } catch (error) {
      if (!committed) await client.query('ROLLBACK');
      if (!committed) await auditStewardTransferRefusal(refusal, error);
      throw error;
    } finally {
      client.release();
    }
    if (moved) await this.notify(moved.priorOwnerId, moved.newOwnerId);
    return result;
  }

  /**
   * THE TRANSFER ACT ON A CHANGE-REQUEST DECISION (change-request design
   * section 3 `project.owner`, section 7.1; T2 S5, card 9ce0b0b0): the same
   * `transferWithin` the direct PUT runs, on the decide transaction, with the
   * DECIDER as the acting principal: its own session facts (`actor`) meet the
   * act's own decider (`decide()`: the person owner on a stored session with
   * projects:write, else an object administrator) and, for a transfer into,
   * out of or between Groups, the standing test with the decision's consumed
   * step-up as its evidence (section 5.3). Nothing here is admitted that the
   * direct door would refuse this decider. The revision is the one the
   * decision reads under the row lock (the stale check held the owner equal
   * to the filed one). `ledger` rides the act's own project.owner.change row.
   * The owner-change hint is sent after COMMIT by `afterCommit`.
   */
  async changeWithin(
    client: PoolClient,
    projectId: string,
    newOwnerId: string,
    actor: OwnerMutationActor,
    ledger: Record<string, unknown>,
  ): Promise<{ project: Project; afterCommit: () => Promise<void> }> {
    const locked = await client.query('SELECT revision FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
    if (locked.rows.length === 0) throw new ResourceContractError(404, 'PROJECT_NOT_FOUND', 'Project not found');
    const transfer = await this.transferWithin(client, projectId, newOwnerId, String(locked.rows[0].revision), actor, false, ledger);
    const moved = transfer.moved;
    return {
      project: transfer.project,
      afterCommit: async () => { if (moved) await this.notify(moved.priorOwnerId, moved.newOwnerId); },
    };
  }

  private async notify(priorOwnerId: string | null, newOwnerId: string | null): Promise<void> {
    // Post-commit notification is a best-effort UI hint. The audit/feed and
    // next-request authorization remain authoritative if no socket receives it.
    // AZ-A12 clause 13: a Group owner's hint fans out to its members; if that
    // read fails, the two owner ids are still told.
    let recipients = [priorOwnerId, newOwnerId].filter((id): id is string => !!id);
    try {
      recipients = await ownerChangeRecipients(pool, [priorOwnerId, newOwnerId]);
    } catch (error) {
      logCaughtFailure('[Project ownership] owner-change recipients unavailable', error);
    }
    try {
      invalidationSink(recipients);
    } catch (error) {
      logCaughtFailure('[Project ownership] UI invalidation failed', error);
    }
  }

  /** The transfer act on the caller's transaction (the Project row is locked here). */
  private async transferWithin(
    client: PoolClient,
    projectId: string,
    newOwnerId: string | null,
    revision: string,
    actor: OwnerMutationActor,
    creation: boolean,
    ledger: Record<string, unknown> | null = null,
  ): Promise<{ project: Project; moved: { priorOwnerId: string | null; newOwnerId: string | null } | null }> {
    const projectRows = await client.query('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
    const project = projectRows.rows[0];
    if (!project) throw new ResourceContractError(404, 'PROJECT_NOT_FOUND', 'Project not found');
    if (project.status === 'archived') throw new ResourceContractError(409, 'PROJECT_ARCHIVED', 'Project is archived and read-only');
    if (newOwnerId !== null && (typeof newOwnerId !== 'string' || !UUID.test(newOwnerId))) {
      throw new ResourceContractError(422, 'INVALID_OWNER', 'ownerPrincipalId must be a principal UUID or null', 'ownerPrincipalId');
    }
    // UUID spelling is case-insensitive in PostgreSQL. Use the same canonical
    // spelling for no-op detection, audit metadata and socket recipients.
    const normalizedOwnerId = newOwnerId === null ? null : newOwnerId.toLowerCase();
    const issuerId = actor.authorization.principalId;
    const ids = [...new Set([issuerId, normalizedOwnerId].filter((id): id is string => !!id))].sort();
    const principals = new Map<string, PrincipalRow>();
    for (const id of ids) {
      const rows = await client.query(
        `SELECT id, handle, kind, status, role, parent_principal_id
           FROM principals WHERE id = $1 FOR SHARE`, [id],
      );
      if (rows.rows[0]) principals.set(id, rows.rows[0]);
    }
    const targetRow = normalizedOwnerId === null ? undefined : principals.get(normalizedOwnerId);
    if (creation && targetRow?.kind !== 'group') {
      throw new ResourceContractError(422, 'OWNER_AT_CREATE_GROUP_ONLY',
        'The create form selects a Group owner only; a person owner at creation is unchanged (AZ-A12 clause 10)', 'ownerPrincipalId');
    }
    // AZ-A12 clause 9(e): after the row lock and BEFORE decide(), the standing
    // test for any transfer into, out of or between Groups.
    const evidence = await groupOwnershipStandingTest(client, {
      objectType: 'project', objectId: String(project.id).toLowerCase(),
      currentOwnerId: project.owner_principal_id ?? null, targetOwnerId: normalizedOwnerId,
      standing: actor.standing ?? { principalId: null, stepUpToken: '' },
      audit: actor.audit, auditAction: 'project.owner.change',
    });
    const access = await decide(projectId, actor.authorization, actor.authMethod,
      issuerId ? principals.get(issuerId) : undefined, client, actor, evidence !== null);
    if (!access.allowed) {
      throw new ResourceContractError(403, access.reason!, 'A current human Project administrator is required');
    }
    if (!revision) throw new ResourceContractError(400, 'REVISION_REQUIRED', 'The last observed Project revision is required');
    if (revision !== project.revision) {
      throw new ResourceContractError(412, 'REVISION_MISMATCH', 'The Project changed; reload and retry');
    }
    if (normalizedOwnerId !== null && targetRow?.kind === 'group') {
      // Clause 9(a): an ACTIVE Group principal; a disabled one is refused as a target.
      if (targetRow.status !== 'active' || !evidence) {
        throw new GroupOwnershipTransferError(422, 'INVALID_OWNER', 'The selected Group is not an active Group principal', null, 'ownerPrincipalId');
      }
    } else if (normalizedOwnerId !== null) {
      const target = principals.get(normalizedOwnerId);
      if (!activeHuman(target)) {
        throw new ResourceContractError(422, 'INVALID_OWNER', 'The selected owner is not an active human Account', 'ownerPrincipalId');
      }
      const targetActor = freshActor(target!);
      if (!authorizationService.authorizeRoute(targetActor, 'projects:read').allowed
        || !authorizationService.authorizeRoute(targetActor, 'projects:write').allowed) {
        throw new ResourceContractError(422, 'INEFFECTIVE_OWNER', 'The selected Account cannot read and write Projects', 'ownerPrincipalId');
      }
    }
    const priorOwnerId: string | null = project.owner_principal_id ?? null;
    if (priorOwnerId === normalizedOwnerId) {
      return { project: await projectService.getById(projectId, client), moved: null };
    }
    await client.query(
      `UPDATE projects SET owner_principal_id = $2, revision = gen_random_uuid(),
              updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [projectId, normalizedOwnerId],
    );
    await auditService.record({
      action: 'project.owner.change', actor: actor.audit,
      resourceType: 'project', resourceId: projectId,
      metadata: {
        oldOwnerPrincipalId: priorOwnerId, newOwnerPrincipalId: normalizedOwnerId,
        // Section 7.1 (T2 S5): an approved change's decision rides this row;
        // the act's own fields below are written after it and are never overridden.
        ...(ledger ?? {}),
        // Clause 9(f): kinds, member count, step-up and the admitting arm.
        ...groupTransferAuditFields(evidence),
        ...(creation ? { atCreation: true } : {}),
      },
    }, client);
    await feedEventService.emit(client, {
      name: 'project.acl_changed', objectType: 'project', objectId: projectId,
      actorPrincipalId: issuerId, actorHandle: actor.audit.handle,
      ownerPrincipalId: priorOwnerId, payload: {},
    });
    // Phase.create locks its parent Project first; this set cannot gain an
    // unobserved Phase while the Project row is locked by this transaction.
    const phases = await client.query('SELECT id FROM phases WHERE project_id = $1 ORDER BY id', [projectId]);
    for (const phase of phases.rows) {
      await feedEventService.emit(client, {
        name: 'phase.acl_changed', objectType: 'phase', objectId: phase.id,
        projectId, actorPrincipalId: issuerId, actorHandle: actor.audit.handle,
        ownerPrincipalId: priorOwnerId, payload: {},
      });
    }
    return {
      project: await projectService.getById(projectId, client),
      moved: { priorOwnerId, newOwnerId: normalizedOwnerId },
    };
  }
}

export const projectOwnershipService = new ProjectOwnershipService();
