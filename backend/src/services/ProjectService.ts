import { grantService } from './GrantService';
import { authorizationService, type AuthorizationActor } from './AuthorizationService';
import { blueprintProvenanceOf, type BlueprintProvenanceFields } from '../utils/blueprintProvenance';
import { auditService } from './AuditService';
import type { CreationTransaction } from '../db/creationTransaction';
// ProjectService.ts - CRUD operations for projects
import { pool } from '../db/connection';
import { NotFoundFault } from '../utils/httpErrors';
import { v4 as uuidv4 } from 'uuid';
import { ResourceContractError } from './ProjectResourceService';
import { lifecyclePolicyService } from './LifecyclePolicyService';
import { feedEventService } from './FeedEventService';
import type { AuditActor } from './AuditService';
import {
  CREATION_DEFAULT_ORIGIN,
  CREATION_DEFAULT_VERBS,
  classifyHomeGroup,
  decideCreationDefault,
  isRootLoginSessionActor,
  readHomeGroupState,
  recordAccessDefaultApply,
  recordAccessDefaultSkip,
  type CreationActor as HomeGroupCreationActor,
  type HomeGroupResolution,
} from './HomeGroupService';


/**
 * The canonical bounded Project record (contract 21a04c23 §3.1; review
 * c99117a1 finding 1): ordinary reads expose canonical fields and the opaque
 * revision only. Compatibility-held legacy bytes (resources/tool_instructions
 * JSONB, source_dir/nfs_dir, project_links) remain stored untouched and are
 * represented exclusively by the management counts surface
 * (GET /projects/{id}/compatibility).
 */
export interface Project extends BlueprintProvenanceFields {
  id: string;
  name: string;
  description?: string;
  /** The Project's outcome statement (migration 079). A PROPERTY at two
   *  altitudes with phase.goal, never a table (vocabulary D-6); rendered in
   *  compiled Briefs alongside the Phase goal (task-element design E-12). */
  goal?: string | null;
  status: 'active' | 'archived';
  /** Opaque revision, rotated on every mutation; If-Match binds it. */
  revision: string;
  is_hidden?: boolean;
  created_at: string;
  updated_at: string;
}

/** Canonical home-group actor plus the already resolved creation authority. */
export interface CreationActor extends HomeGroupCreationActor {
  authorization?: AuthorizationActor;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  goal?: string | null;
  status?: 'active' | 'archived';
  is_hidden?: boolean;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  goal?: string | null;
  status?: 'active' | 'archived';
  is_hidden?: boolean;
}

/**
 * Serialize all mutations that could create an active-name collision on the
 * same normalized name (review 73df8efe finding 1): a transaction-scoped
 * advisory lock keyed on the trimmed, case-folded name. Two concurrent
 * creates/renames/restores of the same name queue behind each other, so the
 * SELECT-then-write conflict check is race-free without a schema constraint
 * that legacy duplicate data could violate.
 */
async function lockProjectName(client: { query: (t: string, p?: any[]) => Promise<any> }, name: string): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('relayhall_project_name:' || lower(trim($1)), 0))`,
    [name],
  );
}

export class ProjectService {
  /**
   * Create a new project - and, for a ROOT LOGIN SESSION only, apply the
   * creation default of RH-LENSES-b (design 96f0bd3d s7.3.1) in this SAME
   * transaction.
   *
   * -- WHY THE ACT IS ACTOR-AWARE AT ALL --------------------------------
   *
   * Before this card `create` took no actor and the route passed five
   * caller-supplied fields. The creation default is decided by WHO is
   * creating and by SERVER STATE about them, so the actor has to reach the
   * service. It is OPTIONAL, and every field of it is server-derived:
   * `authMethod` is written by the authentication middleware and never read
   * from a header, `scopes` is the middleware-resolved set, and an ABSENT
   * actor is not a root session.
   *
   * -- ALL OF IT, OR NONE OF IT ----------------------------------------
   *
   * Best-effort attachment is refused. A project that exists without its
   * declared default is one whose team cannot see it and whose creator
   * believes they can - a support ticket, not an exception. The grant rows,
   * the audit row and the project INSERT share one transaction.
   *
   * -- WHAT IS NOT WRITTEN, AND IT IS DELIBERATE ------------------------
   *
   * `projects.owner_principal_id` (063:40, indexed :61) stays unwritten.
   * `AuthorizationService`'s owner arm (:265-266 at this SHA) allows any
   * non-`task` resource whose owner column equals the actor, so writing it
   * at create would hand every creator an owner-arm authority they do not
   * have today. Owner decision 6 OFFERS that as separable hardening with
   * the consequence named; this composition retains that boundary; creator read/write use revocable Grants.
   */
  async create(input: CreateProjectInput, actor?: CreationActor, transaction?: CreationTransaction, allocatedId?: string): Promise<Project> {
    if (allocatedId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(allocatedId)) throw new Error('Invalid allocated Project id');
    if (allocatedId !== undefined && !transaction) throw new Error('Allocated Project id requires a creation transaction');
    const caller = actor;
    if (transaction && actor?.principalId !== transaction.actor.principalId) throw new Error('Creation actor mismatch');
    const client = transaction?.client ?? await pool.connect();
    try {
      if (!transaction) await client.query('BEGIN');

      const id = allocatedId ?? uuidv4();
      const status = input.status || 'active';
      const isHidden = input.is_hidden || false;

      // Name is unique among non-archived projects (trimmed, case-insensitive).
      await lockProjectName(client, input.name);
      const collision = await client.query(
        `SELECT id FROM projects WHERE status != 'archived' AND lower(trim(name)) = lower(trim($1))`,
        [input.name],
      );
      if (collision.rows.length > 0) {
        throw new ResourceContractError(409, 'PROJECT_NAME_CONFLICT', 'An active project already uses that name', 'name');
      }

      await lifecyclePolicyService.evaluate(client, {
        action: 'project.create',
        subject: { kind: 'project', id },
        proposed: { status, isHidden },
      });

      await client.query(
        `INSERT INTO projects (id, name, description, goal, status, is_hidden)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [id, input.name, input.description || null, input.goal || null, status, isHidden]
      );

      // The server-owned Blueprint channel omits the home-group act entirely;
      // it does not invent a skip reason. Ordinary creation retains that act.
      if (transaction?.source !== 'blueprint') await this.applyCreationDefault(client, id, actor);

      // Dispatcher ruling D7: the actual-creator Grant pair is a policy of ORDINARY Project
      // creation only; the server-owned Blueprint channel writes no creator pair, so it is
      // guarded by the same clause as the home-group act above.
      if (transaction?.source !== 'blueprint' && caller?.principalId) {
        if (!caller.authorization || caller.authorization.principalId !== caller.principalId
          || !authorizationService.authorizeRoute(caller.authorization, 'projects:write').allowed) {
          throw new ResourceContractError(403, 'PROJECT_CREATOR_REQUIRED', 'The authenticated creation authority is required');
        }
        await grantService.createForProjectCreator(client, id, caller.authorization, caller.audit);
      }
      if (caller?.principalId) await auditService.record({ action: 'project.create', actor: caller.audit, resourceType: 'project', resourceId: id }, client);
      const project = await this.getById(id, client);
      if (!transaction) await client.query('COMMIT');
      return project;
    } catch (err) {
      if (!transaction) await client.query('ROLLBACK');
      throw err;
    } finally {
      if (!transaction) client.release();
    }
  }
  /**
   * RH-LENSES-b s7.3.1 steps 2-5, on the project's OWN client.
   *
   * STEP 2 - THE ACTING-CHANNEL TEST, FIRST AND FAIL-CLOSED. Owner decision 6
   * (DBD-15) took the design's own stated fallback: the default is written only
   * for a ROOT LOGIN SESSION. A `principal_api_key` bearer HOWEVER SCOPED, a
   * non-root login session, a delegated Connector, and an internal caller with
   * no actor at all - every one of them creates the project, writes no home-group grant,
   * and audits `actor_channel_unavailable`. The `relayhall.authority_actor`
   * channel and the trigger-level internal-writer closure defer with the
   * rule-4 arm, so there is no channel to invent here.
   *
   * STEP 3 - THE RE-DERIVATION, and it is what makes A-L21 true. Every clause
   * is read on THIS client under a row lock of its own - the Group, the
   * Account, the pointer and the membership, in the order
   * `readHomeGroupState` declares. Round-1 review finding B1: a lock on the
   * Group row ALONE leaves the other three writable between their SELECT and
   * this act's INSERT, and the record states the property, not the lock.
   *
   * The pointer was written by an act that conferred nothing; this is the act
   * that moves authority, and it trusts nothing it read before its own
   * transaction opened and nothing it cannot hold until that transaction
   * commits.
   */
  private async applyCreationDefault(
    client: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> },
    projectId: string,
    actor?: CreationActor,
  ): Promise<void> {
    const isRootSession = isRootLoginSessionActor(actor);
    const auditActor: AuditActor = actor?.audit ?? { handle: 'system', authMethod: 'system' };

    let resolution: HomeGroupResolution | null = null;
    if (isRootSession) {
      const state = await readHomeGroupState(client, actor!.principalId!, { lockForWrite: true });
      resolution = classifyHomeGroup(state);
    }

    const decision = decideCreationDefault(isRootSession, resolution);
    if (!decision.apply) {
      // B-L20: the writer validates the reason against the CLOSED SET and throws
      // on anything else, which rolls this transaction back rather than recording
      // a reason no reader of the ledger can enumerate.
      await recordAccessDefaultSkip(client, auditActor, projectId, decision.reason);
      return;
    }

    for (const verb of CREATION_DEFAULT_VERBS) {
      await client.query(
        `INSERT INTO grants
           (grantee_type, grantee_id, resource_type, resource_id, verb,
            granted_by_principal_id, origin)
         VALUES ('group', $1, 'project', $2, $3, $4, $5)`,
        [decision.groupId, projectId, verb, actor!.principalId, CREATION_DEFAULT_ORIGIN],
      );
      // RH-P3.C1 (strategy 4e40f06f s2.6.1): an ACL change over a feed object is
      // itself a feed event, so downstream indexes see it. A grant written by
      // this act is the same class of ACL change `GrantService.create` emits for,
      // and it is emitted on the same terms - content-free, and with no
      // `ownerPrincipalId` because the grantee is a Group and not a principal.
      await feedEventService.emit(client as any, {
        name: 'project.acl_changed',
        objectType: 'project',
        objectId: projectId,
        actorPrincipalId: actor!.principalId,
        actorHandle: auditActor.handle ?? null,
        ownerPrincipalId: null,
        payload: {},
      });
    }
    await recordAccessDefaultApply(client, auditActor, projectId, decision.groupId);
  }

  /**
   * Get project by ID
   */
  async getById(id: string, queryable: Pick<import('pg').PoolClient, 'query'> = pool): Promise<Project> {
    const projectResult = await queryable.query(
      'SELECT * FROM projects WHERE id = $1',
      [id]
    );
    
    if (projectResult.rows.length === 0) {
      throw new NotFoundFault(`Project not found: ${id}`, 'PROJECT_NOT_FOUND');
    }
    
    return this.mapRowToProject(projectResult.rows[0]);
  }

  /**
   * Map database row to Project interface
   */
  private mapRowToProject(row: any): Project {
    return {
      ...blueprintProvenanceOf(row),
      id: row.id,
      name: row.name,
      description: row.description,
      goal: row.goal ?? null,
      status: row.status,
      revision: row.revision,
      is_hidden: row.is_hidden || false,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * List all projects (optionally filter by status, include/exclude hidden)
   */
  async list(
    status?: 'active' | 'archived',
    includeHidden: boolean = true,
    includeArchived: boolean = true,
  ): Promise<Project[]> {
    let query = 'SELECT * FROM projects';
    const params: any[] = [];
    const conditions: string[] = [];
    
    if (status) {
      conditions.push(`status = $${params.length + 1}`);
      params.push(status);
    } else if (!includeArchived) {
      // Contract §2.2: the default collection excludes archived projects;
      // they are reachable only through an explicit archived view.
      conditions.push(`status != 'archived'`);
    }
    
    if (!includeHidden) {
      conditions.push(`is_hidden = FALSE`);
    }
    
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    
    query += ' ORDER BY created_at DESC';
    
    const result = await pool.query(query, params);
    return result.rows.map((row) => this.mapRowToProject(row));
  }

  /**
   * Lock a project row, enforce the revision precondition, and return it.
   * REVISION_REQUIRED when absent, REVISION_MISMATCH (412) when stale.
   */
  private async lockWithRevision(client: { query: (t: string, p?: any[]) => Promise<any> }, id: string, revision: string): Promise<any> {
    const result = await client.query('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [id]);
    if (result.rows.length === 0) {
      throw new ResourceContractError(404, 'PROJECT_NOT_FOUND', 'Project not found');
    }
    if (typeof revision !== 'string' || revision.length === 0) {
      throw new ResourceContractError(400, 'REVISION_REQUIRED', 'The last observed revision is required (If-Match)');
    }
    if (revision !== result.rows[0].revision) {
      throw new ResourceContractError(412, 'REVISION_MISMATCH', 'The project changed since it was last read; reload and retry');
    }
    return result.rows[0];
  }

  /**
   * Update project details. Revision-bound and transactional: the caller
   * supplies the last observed revision (If-Match); archived projects refuse
   * every detail mutation (restore is the only ordinary mutation).
   */
  async update(id: string, input: UpdateProjectInput, revision: string): Promise<Project> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await this.lockWithRevision(client, id, revision);
      if (existing.status === 'archived') {
        throw new ResourceContractError(409, 'PROJECT_ARCHIVED', 'Project is archived and read-only; restore it first');
      }
      if (input.status === 'archived') {
        throw new ResourceContractError(409, 'PROJECT_ARCHIVED', 'Use POST /projects/{id}/archive to archive a project');
      }

      await lifecyclePolicyService.evaluate(client, {
        action: 'project.update',
        subject: { kind: 'project', id, revision: existing.revision },
        current: { status: existing.status, isHidden: Boolean(existing.is_hidden) },
        proposed: {
          status: input.status ?? existing.status,
          isHidden: input.is_hidden ?? Boolean(existing.is_hidden),
        },
      });

      const updates: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (input.name !== undefined) {
        await lockProjectName(client, input.name);
        const collision = await client.query(
          `SELECT id FROM projects WHERE status != 'archived' AND id != $1 AND lower(trim(name)) = lower(trim($2))`,
          [id, input.name],
        );
        if (collision.rows.length > 0) {
          throw new ResourceContractError(409, 'PROJECT_NAME_CONFLICT', 'An active project already uses that name', 'name');
        }
        updates.push(`name = $${paramIndex++}`);
        params.push(input.name);
      }

      if (input.description !== undefined) {
        updates.push(`description = $${paramIndex++}`);
        params.push(input.description);
      }

      // Goal (079): the Project-altitude outcome statement. Empty string
      // clears it, matching how the CLI and GUI express "no goal".
      if (input.goal !== undefined) {
        updates.push(`goal = $${paramIndex++}`);
        params.push(input.goal === '' ? null : input.goal);
      }

      if (input.status !== undefined) {
        updates.push(`status = $${paramIndex++}`);
        params.push(input.status);
      }

      if (input.is_hidden !== undefined) {
        updates.push(`is_hidden = $${paramIndex++}`);
        params.push(input.is_hidden);
      }

      if (updates.length > 0) {
        params.push(id);
        await client.query(
          `UPDATE projects SET ${updates.join(', ')}, revision = gen_random_uuid(), updated_at = CURRENT_TIMESTAMP
           WHERE id = $${paramIndex}`,
          params
        );
      }

      await client.query('COMMIT');
      return await this.getById(id);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Archive a project. Revision-bound; reversible (unarchive). Ordinary
   * removal IS archive — there is no owner-facing deletion.
   */
  async archive(id: string, revision: string): Promise<Project> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await this.lockWithRevision(client, id, revision);
      if (existing.status !== 'archived') {
        await lifecyclePolicyService.evaluate(client, {
          action: 'project.archive',
          subject: { kind: 'project', id, revision: existing.revision },
          current: { status: existing.status },
          proposed: { status: 'archived' },
        });
        await client.query(
          `UPDATE projects SET status = 'archived', revision = gen_random_uuid(), updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [id],
        );
      }
      await client.query('COMMIT');
      return await this.getById(id);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Restore a project from archive — the only ordinary mutation of an
   * archived project. Requires the exact revision and rechecks active-name
   * uniqueness atomically (409 PROJECT_NAME_CONFLICT on collision).
   */
  async unarchive(id: string, revision: string): Promise<Project> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await this.lockWithRevision(client, id, revision);
      if (existing.status === 'archived') {
        await lockProjectName(client, existing.name);
        const collision = await client.query(
          `SELECT id FROM projects WHERE status != 'archived' AND id != $1 AND lower(trim(name)) = lower(trim($2))`,
          [id, existing.name],
        );
        if (collision.rows.length > 0) {
          throw new ResourceContractError(409, 'PROJECT_NAME_CONFLICT', 'An active project already uses that name', 'name');
        }
        await lifecyclePolicyService.evaluate(client, {
          action: 'project.restore',
          subject: { kind: 'project', id, revision: existing.revision },
          current: { status: existing.status },
          proposed: { status: 'active' },
        });
        await client.query(
          `UPDATE projects SET status = 'active', revision = gen_random_uuid(), updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [id],
        );
      }
      await client.query('COMMIT');
      return await this.getById(id);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

}

export const projectService = new ProjectService();
