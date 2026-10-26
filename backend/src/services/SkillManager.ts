// SkillManager.ts - immutable Agent Skills registry and exact consumer pins.
import { PoolClient } from 'pg';
import { pool } from '../db/connection';
import { v4 as uuidv4 } from 'uuid';
import { buildSkillDocument, parseSkillDocument, SkillDocumentError } from '../utils/skillDocument';
import { auditService, type AuditActor } from './AuditService';
import { feedEventService, feedActorFields } from './FeedEventService';
import { lifecyclePolicyService } from './LifecyclePolicyService';
import { auditSkillRefusals } from '../utils/skillRefusalAudit';
import { groupOwnerCondition } from '../utils/groupOwnerCondition';
import {
  groupOwnershipStandingTest, groupTransferAuditFields, type GroupTransferStanding,
} from './GroupOwnershipTransfer';

export type SkillVersionStatus = 'draft' | 'review' | 'published' | 'retired';
export type SkillProvenance = 'human-authored' | 'imported' | 'agent-drafted';

/**
 * Card f87776ad (owner ruling D37(d)). Provenance attests the KIND of the
 * Principal that creates a Version. Migration 083's insert trigger
 * (`relayhall_validate_new_skill_version`) enforces it and stays the guard:
 * human-authored needs a human creator, agent-drafted an agent or service
 * creator, imported any creator. These tables MIRROR that trigger so the
 * refusal can name the field and the caller's kind; left to the trigger, its
 * 23514 surfaced as a generic 409 SKILL_LIFECYCLE_CONFLICT ("Illegal Skill
 * lifecycle change"), which is how a human dashboard session saving the
 * loaded agent-drafted provenance read as a lifecycle defect.
 */
export const SKILL_PROVENANCE_BY_PRINCIPAL_KIND: Readonly<Record<string, readonly SkillProvenance[]>> = {
  human: ['human-authored', 'imported'],
  agent: ['agent-drafted', 'imported'],
  service: ['agent-drafted', 'imported'],
};
const PROVENANCE_REQUIREMENT: Readonly<Record<SkillProvenance, string>> = {
  'human-authored': 'a human Principal',
  'agent-drafted': 'an agent or service Principal',
  imported: 'any Principal',
};

export interface SkillVersion {
  id: string;
  skill_id: string;
  version: number;
  skill_md?: string;
  content_sha256: string;
  description: string;
  category: string | null;
  tags: string[];
  config: Record<string, unknown>;
  provenance: SkillProvenance;
  source_uri: string | null;
  created_by_principal_id: string | null;
  created_at: string;
  status: SkillVersionStatus;
  status_actor_principal_id: string | null;
  status_note: string | null;
  status_changed_at: string;
}

export interface Skill {
  id: string;
  name: string;
  is_global: boolean;
  current_published_version_id: string | null;
  revision: string;
  created_at: string;
  updated_at: string;
  current_version: SkillVersion | null;
  /** The exact broad/default Version, distinct from a newer visible draft. */
  published_version: SkillVersion | null;
  // Flattened metadata keeps list consumers compact and backwards-readable.
  version: number | null;
  status: SkillVersionStatus | null;
  category: string | null;
  description: string | null;
  tags: string[];
  config: Record<string, unknown>;
  provenance: SkillProvenance | null;
  content_sha256: string | null;
  /** AZ-A12 M-c (migration 162): the owner, a person Account or a Group
   * principal; null = unowned. Kind and display name are joined server-side
   * so a reader names a Group owner without listing Group principals. */
  owner_principal_id: string | null;
  owner_kind: 'human' | 'group' | null;
  owner_display_name: string | null;
}

/**
 * Card d67e6990 (D24 part 1) and AZ-A12 clause 6's skill row: who sees a
 * Skill's UNPUBLISHED Versions.
 *
 * A published Version is shared registry content and stays visible to every
 * reader exactly as before. An unpublished Version (draft or review) is the
 * owner's working copy: it is shown to a registry manager (`skills:write`,
 * `skills:admin` or `root`, the earlier `canManage`) only when the Skill is
 * unowned (the registry's earlier behaviour), owned by the caller's Account,
 * or owned by a Group of which that Account is an active member (the clause-6
 * fragment, use tier). A registry administrator (`root` or `skills:admin`)
 * also sees, on a LIST, every Skill whose newest Version waits in review (the
 * publication queue they decide), and every owner's drafts when they ask for
 * them (`owner=all`); on a POINT read by id an administrator sees any draft.
 * A caller who may not see a Skill's drafts sees its published Version, and a
 * Skill with no published Version is neither listed nor found for them.
 */
export interface SkillViewer {
  /** The acting chain's Account (its parentless principal), or null. */
  accountId: string | null;
  /** May see unpublished Versions at all: skills:write, skills:admin or root. */
  manage: boolean;
  /** Registry administration: root or skills:admin. */
  administrator: boolean;
  /** List only: an administrator asked for every owner's drafts. */
  allOwners?: boolean;
}

/** The SQL for "this viewer may see the drafts of Skill `s`". `param` is the
 * placeholder the caller bound the viewer's Account id to (never interpolated
 * data). Point reads admit any administrator; lists admit the review queue and
 * `owner=all`.
 *
 * Exported (card 5854f0d6, Notifications and Timeline design R2-N4): the
 * Timeline's skill rows and skill-version rows apply THIS function, the one
 * `GET /skills` and `GET /skills/:id/versions` apply, never a re-typed copy. */
export function draftVisibilitySql(viewer: SkillViewer, param: string | null, point: boolean): string {
  if (!viewer.manage) return 'FALSE';
  const arms = ['s.owner_principal_id IS NULL'];
  if (param) {
    arms.push(`s.owner_principal_id = ${param}::uuid`);
    arms.push(groupOwnerCondition({ owner: 's.owner_principal_id', account: param, tier: 'use' }));
  }
  if (viewer.administrator) {
    if (point || viewer.allOwners) arms.push('TRUE');
    else {
      arms.push(`EXISTS (SELECT 1 FROM skill_version_state review_queue
                 WHERE review_queue.skill_id = s.id AND review_queue.status = 'review')`);
    }
  }
  return `(${arms.join('\n         OR ')})`;
}

/** The input of the owner assignment act (`PUT /skills/:id/owner`). */
export interface SkillOwnerChange {
  ownerPrincipalId: string;
  reason: string;
}

export interface CreateSkillInput {
  name: string;
  skill_md?: string;
  description?: string;
  usage_instructions?: string;
  category?: string;
  tags?: string[];
  config?: Record<string, unknown>;
  provenance?: SkillProvenance;
  source_uri?: string;
  is_global?: boolean;
}

export interface UpdateSkillInput {
  skill_md?: string;
  description?: string;
  usage_instructions?: string;
  category?: string;
  tags?: string[];
  config?: Record<string, unknown>;
  provenance?: SkillProvenance;
  source_uri?: string;
}

export interface ProjectSkillLink {
  id: string;
  project_id: string;
  skill_id: string;
  skill_version_id: string;
  created_at: string;
  skill?: Skill;
  version?: SkillVersion;
}

export interface SkillSearchOptions {
  category?: string;
  tag?: string;
  search?: string;
}

export class SkillContractError extends Error {
  constructor(public status: number, public code: string, message: string,
      public details?: Record<string, unknown>) {
    super(message);
    this.name = 'SkillContractError';
  }
}

function contractFromDocument(error: unknown): never {
  if (error instanceof SkillDocumentError) {
    throw new SkillContractError(422, 'INVALID_SKILL_DOCUMENT', error.message);
  }
  throw error;
}

function requireActor(actorPrincipalId: string | undefined): string {
  if (!actorPrincipalId) {
    throw new SkillContractError(403, 'PRINCIPAL_REQUIRED', 'A resolved Principal is required for Skill changes');
  }
  return actorPrincipalId;
}

/** Direct internal callers without transport evidence remain explicitly unknown. */
function skillAuditActor(principalId: string | undefined, actor?: AuditActor): AuditActor {
  return { handle: 'unknown', authMethod: 'unknown', ...actor, principalId: principalId ?? actor?.principalId ?? null };
}

export class SkillManager {
  /**
   * `ownerAccountId` is the creating chain's Account (card d67e6990): it
   * becomes the Skill's owner when it is an active, parentless, non-legacy
   * human principal, so the person who drafts a Skill can version, submit and
   * revise it through the owner arm. Any other value leaves the Skill unowned,
   * as every Skill was before migration 162. Never a Group (clause 10(a)).
   */
  async create(input: CreateSkillInput, actorPrincipalId?: string, audit?: AuditActor,
      ownerAccountId?: string | null): Promise<Skill> {
    return auditSkillRefusals('skill.create', skillAuditActor(actorPrincipalId, audit), null, async () => {
    const actor = requireActor(actorPrincipalId);
    if (input.is_global) {
      throw new SkillContractError(422, 'PUBLISH_BEFORE_GLOBAL', 'Publish a reviewed version before making a Skill global');
    }
    const payload = this.prepareDocument(input.name, input);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const provenance = input.provenance || 'human-authored';
      await this.assertProvenanceForCreator(client, actor, provenance);
      const skillId = uuidv4();
      const owner = await client.query(
        `INSERT INTO skills (id, name, is_global, owner_principal_id)
         VALUES ($1, $2, FALSE, (SELECT id FROM principals WHERE id = $3::uuid AND kind = 'human'
           AND status = 'active' AND parent_principal_id IS NULL AND NOT legacy_identity))
         RETURNING owner_principal_id`,
        [skillId, input.name, ownerAccountId ?? null],
      );
      const ownerPrincipalId: string | null = owner.rows[0]?.owner_principal_id ?? null;
      const versionId = uuidv4();
      await client.query(
        `INSERT INTO skill_versions
           (id, skill_id, version, skill_md, description, category, tags, config,
            provenance, source_uri, created_by_principal_id)
         VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [versionId, skillId, payload.skillMd, payload.description, input.category || null,
          input.tags || [], JSON.stringify(input.config || {}), provenance,
          input.source_uri || null, actor],
      );
      await client.query(
        `INSERT INTO skill_version_events (skill_version_id, status, actor_principal_id, note)
         VALUES ($1, 'draft', $2, 'Initial immutable Skill Version')`,
        [versionId, actor],
      );
      // RH-P3.C1: same-transaction feed emission.
      await auditService.record({ action: 'skill.create', actor: skillAuditActor(actor, audit), resourceType: 'skill', resourceId: skillId,
        metadata: { skillVersionId: versionId, version: 1, provenance, ownerPrincipalId } }, client);
      await feedEventService.emit(client, {
        name: 'skill.created', objectType: 'skill', objectId: skillId,
        actorPrincipalId: actor ?? null, payload: {},
      });
      await client.query('COMMIT');
      return await this.getById(skillId, true);
    } catch (error) {
      await client.query('ROLLBACK');
      contractFromDocument(error);
    } finally {
      client.release();
    }
    });
  }

  /**
   * `viewer` is either the earlier boolean (true = every unpublished Version,
   * for internal callers and writers reading back their own write) or a
   * SkillViewer, which applies the card-d67e6990 draft visibility.
   */
  async getById(id: string, viewer: boolean | SkillViewer = false): Promise<Skill> {
    let result;
    if (typeof viewer === 'boolean') {
      result = await pool.query(this.catalogQuery(viewer) + ' WHERE s.id = $1', [id]);
    } else {
      // The Account is bound only where the draft SQL reads it (a manager).
      const bind = viewer.manage && viewer.accountId ? viewer.accountId : null;
      const draft = draftVisibilitySql(viewer, bind ? '$2' : null, true);
      result = await pool.query(
        this.catalogQuery(viewer.manage, draft)
          + ` WHERE s.id = $1 AND (${draft} OR s.current_published_version_id IS NOT NULL)`,
        bind ? [id, bind] : [id],
      );
    }
    if (result.rows.length === 0) {
      throw new SkillContractError(404, 'SKILL_NOT_FOUND', `Skill not found: ${id}`);
    }
    return this.mapSkillRow(result.rows[0]);
  }

  /** Whether `viewer` may see Skill `id`'s unpublished Versions (point rule). */
  async viewerSeesDrafts(id: string, viewer: boolean | SkillViewer): Promise<boolean> {
    if (typeof viewer === 'boolean') return viewer;
    if (!viewer.manage) return false;
    const draft = draftVisibilitySql(viewer, viewer.accountId ? '$2' : null, true);
    const result = await pool.query(`SELECT ${draft} AS visible FROM skills s WHERE s.id = $1`,
      viewer.accountId ? [id, viewer.accountId] : [id]);
    return result.rows[0]?.visible === true;
  }

  async getByName(name: string, includeUnpublished = false): Promise<Skill | null> {
    const result = await pool.query(this.catalogQuery(includeUnpublished) + ' WHERE s.name = $1', [name]);
    return result.rows[0] ? this.mapSkillRow(result.rows[0]) : null;
  }

  async list(options: SkillSearchOptions = {}, viewer: boolean | SkillViewer = false): Promise<Skill[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown): void => {
      params.push(value);
      conditions.push(sql.replace('?', `$${params.length}`));
    };
    const includeUnpublished = typeof viewer === 'boolean' ? viewer : viewer.manage;
    let draft: string | undefined;
    if (typeof viewer !== 'boolean' && viewer.manage) {
      let param: string | null = null;
      if (viewer.accountId) { params.push(viewer.accountId); param = `$${params.length}`; }
      draft = draftVisibilitySql(viewer, param, false);
      conditions.push(`(${draft} OR s.current_published_version_id IS NOT NULL)`);
    }
    if (!includeUnpublished) conditions.push('s.current_published_version_id IS NOT NULL');
    if (options.category) add('v.category = ?', options.category);
    if (options.tag) add('? = ANY(v.tags)', options.tag);
    if (options.search) {
      params.push(`%${options.search}%`);
      conditions.push(`(s.name ILIKE $${params.length} OR v.description ILIKE $${params.length})`);
    }
    let query = this.catalogQuery(includeUnpublished, draft);
    if (conditions.length) query += ` WHERE ${conditions.join(' AND ')}`;
    query += ' ORDER BY s.name ASC';
    const result = await pool.query(query, params);
    return result.rows.map(row => this.mapSkillRow(row));
  }

  /** Existing PUT semantics become insertion of the next immutable draft. */
  async update(id: string, input: UpdateSkillInput, expectedRevision: string, actorPrincipalId?: string, audit?: AuditActor): Promise<Skill> {
    return auditSkillRefusals('skill.create_version', skillAuditActor(actorPrincipalId, audit), id, async () => {
    const actor = requireActor(actorPrincipalId);
    this.requireRevision(expectedRevision);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const catalog = await client.query('SELECT * FROM skills WHERE id = $1 FOR UPDATE', [id]);
      this.assertRevision(catalog.rows[0], expectedRevision, id);
      const provenance = input.provenance || 'human-authored';
      await this.assertProvenanceForCreator(client, actor, provenance);
      const previous = await client.query(
        `SELECT * FROM skill_version_state WHERE skill_id = $1 ORDER BY version DESC LIMIT 1`, [id],
      );
      if (!previous.rows[0]) throw new SkillContractError(409, 'SKILL_HISTORY_MISSING', 'Skill has no base Version');
      const base = previous.rows[0];
      const payload = this.prepareDocument(catalog.rows[0].name, input, base);
      const versionId = uuidv4();
      await client.query(
        `INSERT INTO skill_versions
           (id, skill_id, version, skill_md, description, category, tags, config,
            provenance, source_uri, created_by_principal_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [versionId, id, Number(base.version) + 1, payload.skillMd, payload.description,
          input.category !== undefined ? input.category || null : base.category,
          input.tags !== undefined ? input.tags : (base.tags || []),
          JSON.stringify(input.config !== undefined ? input.config : (base.config || {})),
          provenance, input.source_uri || null, actor],
      );
      await client.query(
        `INSERT INTO skill_version_events (skill_version_id, status, actor_principal_id, note)
         VALUES ($1, 'draft', $2, 'Created as next immutable Skill Version')`,
        [versionId, actor],
      );
      await client.query(
        `UPDATE skills SET revision = gen_random_uuid(), updated_at = now()
         WHERE id = $1 AND revision = $2::uuid`, [id, expectedRevision],
      );
      await auditService.record({ action: 'skill.create_version', actor: skillAuditActor(actor, audit), resourceType: 'skill', resourceId: id,
        metadata: { skillVersionId: versionId, version: Number(base.version) + 1, provenance } }, client);
      await feedEventService.emit(client, {
        name: 'skill.updated', objectType: 'skill', objectId: id,
        actorPrincipalId: actor ?? null, payload: {},
      });
      await client.query('COMMIT');
      return await this.getById(id, true);
    } catch (error) {
      await client.query('ROLLBACK');
      contractFromDocument(error);
    } finally {
      client.release();
    }
    });
  }

  async listVersions(skillId: string, viewer: boolean | SkillViewer = false): Promise<SkillVersion[]> {
    await this.assertSkillExists(skillId);
    const includeUnpublished = await this.viewerSeesDrafts(skillId, viewer);
    const result = await pool.query(
      `SELECT * FROM skill_version_state WHERE skill_id = $1
       ${includeUnpublished ? '' : "AND status = 'published'"} ORDER BY version DESC`, [skillId],
    );
    return result.rows.map(row => this.mapVersionRow(row, false));
  }

  async getVersion(skillId: string, versionRef: string, includeContent: boolean,
      viewer: boolean | SkillViewer = false): Promise<SkillVersion> {
    const includeUnpublished = await this.viewerSeesDrafts(skillId, viewer);
    const byNumber = /^\d+$/.test(versionRef);
    const result = await pool.query(
      `SELECT * FROM skill_version_state
       WHERE skill_id = $1 AND ${byNumber ? 'version = $2::integer' : 'id = $2::uuid'}
       ${includeUnpublished ? '' : "AND status = 'published'"}`,
      [skillId, versionRef],
    );
    if (!result.rows[0]) {
      throw new SkillContractError(404, 'SKILL_VERSION_NOT_FOUND', `Skill Version not found: ${versionRef}`);
    }
    return this.mapVersionRow(result.rows[0], includeContent);
  }

  /**
   * Card eb7c0271: a publication writes ONE `skill.publish` audit row through
   * the one audit writer, on this transaction, so the row commits or rolls
   * back with the publish: a refused or failed publish leaves no row, and a
   * failed audit write fails the publish. `audit` is the request's actor
   * (auditActorFromRequest); a direct service caller without one is recorded
   * as auth method `unknown`. The row's principal is always `actor`, the
   * Principal the lifecycle event and trigger 083 check. The note is free
   * prose and never enters the row.
   */
  async transition(skillId: string, versionRef: string, status: SkillVersionStatus,
      actorPrincipalId: string | undefined, note: string | undefined, expectedRevision: string,
      audit?: AuditActor): Promise<SkillVersion> {
    const action = status === 'published' ? 'skill.publish' : status === 'review' ? 'skill.submit_review'
      : status === 'draft' ? 'skill.reject' : 'skill.retire';
    return auditSkillRefusals(action, skillAuditActor(actorPrincipalId, audit), skillId, async () => {
    const actor = requireActor(actorPrincipalId);
    this.requireRevision(expectedRevision);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const catalog = await client.query('SELECT * FROM skills WHERE id = $1 FOR UPDATE', [skillId]);
      this.assertRevision(catalog.rows[0], expectedRevision, skillId);
      const version = await this.findVersionForUpdate(client, skillId, versionRef);
      let publisherHandle = '';
      if (status === 'published') {
        const principal = await client.query('SELECT kind, handle FROM principals WHERE id = $1', [actor]);
        if (principal.rows[0]?.kind !== 'human') {
          throw new SkillContractError(403, 'HUMAN_REVIEW_REQUIRED', 'Publishing requires a human Principal');
        }
        if (version.created_by_principal_id === actor) {
          throw new SkillContractError(409, 'INDEPENDENT_REVIEW_REQUIRED', 'A creator cannot publish their own Skill Version');
        }
        publisherHandle = String(principal.rows[0].handle ?? '');
      }
      await lifecyclePolicyService.evaluate(client, {
        action: 'skill-version.transition',
        subject: { kind: 'skill-version', id: version.id, revision: expectedRevision },
        current: { skillId, status: version.status },
        proposed: { skillId, status },
      });
      await client.query(
        `INSERT INTO skill_version_events (skill_version_id, status, actor_principal_id, note)
         VALUES ($1, $2, $3, $4)`, [version.id, status, actor, note || null],
      );
      if (status === 'published') {
        const recordedBy: AuditActor = audit ?? { handle: publisherHandle, authMethod: 'unknown' };
        await auditService.record({
          action: 'skill.publish',
          actor: { ...recordedBy, principalId: actor },
          resourceType: 'skill',
          resourceId: skillId,
          metadata: {
            skillVersionId: String(version.id),
            version: Number(version.version),
            previousStatus: version.status,
            status,
            previousPublishedVersionId: catalog.rows[0].current_published_version_id ?? null,
            contentSha256: version.content_sha256,
          },
        }, client);
      } else {
        const event = status === 'review' ? { action: 'skill.submit_review' }
          : status === 'draft' ? { action: 'skill.reject' } : { action: 'skill.retire' };
        await auditService.record({ ...event, actor: skillAuditActor(actor, audit), resourceType: 'skill', resourceId: skillId,
          metadata: { skillVersionId: String(version.id), version: Number(version.version), previousStatus: version.status, status } }, client);
      }
      // draft/review transitions do not touch the catalog trigger, so rotate here.
      if (status === 'draft' || status === 'review') {
        await client.query(
          'UPDATE skills SET revision = gen_random_uuid(), updated_at = now() WHERE id = $1', [skillId],
        );
      }
      // RH-P3.C1: Version lifecycle transitions (publish/retire included) are
      // catalog-visible changes; consumers re-pull the Skill on this signal.
      await feedEventService.emit(client, {
        name: 'skill.updated', objectType: 'skill', objectId: skillId,
        actorPrincipalId: actor ?? null, payload: { versionStatus: status },
      });
      await client.query('COMMIT');
      return await this.getVersion(skillId, version.id, true, true);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    });
  }

  async setGlobal(skillId: string, isGlobal: boolean, expectedRevision: string, audit?: AuditActor): Promise<Skill> {
    return auditSkillRefusals('skill.set_global', skillAuditActor(undefined, audit), skillId, async () => {
    this.requireRevision(expectedRevision);
    // RH-P3.C1: a visibility flip is exactly the kind of change downstream
    // indexes must hear about, so the write and its event share a transaction.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE skills SET is_global = $2, revision = gen_random_uuid(), updated_at = now()
         WHERE id = $1 AND revision = $3::uuid RETURNING id`, [skillId, isGlobal, expectedRevision],
      );
      if (!result.rows[0]) {
        await client.query('ROLLBACK');
        await this.classifyRevisionFailure(skillId);
      } else {
        await auditService.record({ action: 'skill.set_global', actor: skillAuditActor(undefined, audit), resourceType: 'skill', resourceId: skillId,
          metadata: { isGlobal } }, client);
        await feedEventService.emit(client, {
          name: 'skill.updated', objectType: 'skill', objectId: skillId,
          // Card 5854f0d6 (design section 4.3): the acting principal.
          ...feedActorFields(audit), payload: {},
        });
        await client.query('COMMIT');
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return this.getById(skillId, true);
    });
  }

  /**
   * Card d67e6990 (D24 part 1): the owner assignment act, `PUT
   * /skills/{id}/owner`, the route AZ-A12 clause 9 leaves to be declared for
   * `skills.owner_principal_id`.
   *
   * The route ceiling is `skills:admin` and the point stage asks the `admin`
   * action on the Skill, so a registry administrator (or the person owner, who
   * holds the owner arm) reaches this method. A transfer INTO, OUT OF or
   * BETWEEN Groups additionally runs clause 9(e)'s standing test here, after
   * the row lock: a login session, root or an administrator, and a single-use
   * step-up bound to (`ownership.transfer`, skill id). A transfer between
   * persons never reaches those checks (clause 16).
   *
   * The target is an active, parentless, non-legacy human Account, or an
   * active Group principal admitted by the standing test. One `skill.owner.change`
   * audit row commits with the write (clause 9(f)'s fields when a Group is
   * involved); refusals are audited by the route (`attachSkillRefusalAudit`)
   * and, for the standing test, by the test itself outside the transaction.
   * Publication is untouched: the independent-review rule binds the Version's
   * creator whoever owns the Skill.
   */
  async changeOwner(skillId: string, input: SkillOwnerChange, expectedRevision: string,
      audit: AuditActor, standing: GroupTransferStanding): Promise<{ skill: Skill; changed: boolean }> {
    this.requireRevision(expectedRevision);
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!input || typeof input.ownerPrincipalId !== 'string' || !UUID.test(input.ownerPrincipalId)) {
      throw new SkillContractError(422, 'INVALID_SKILL_OWNER', 'ownerPrincipalId must be the id of an active person Account or Group',
        { field: 'ownerPrincipalId' });
    }
    if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000) {
      throw new SkillContractError(422, 'INVALID_SKILL_VALUE', 'reason must be a non-blank string of at most 2000 characters',
        { field: 'reason' });
    }
    const targetId = input.ownerPrincipalId.toLowerCase();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        'SELECT id::text AS id, revision::text AS revision, owner_principal_id::text AS owner FROM skills WHERE id = $1 FOR UPDATE',
        [skillId]);
      const row = locked.rows[0];
      this.assertRevision(row, expectedRevision, skillId);
      const previous: string | null = row.owner ?? null;
      const evidence = await groupOwnershipStandingTest(client, {
        objectType: 'skill', objectId: String(row.id).toLowerCase(),
        currentOwnerId: previous, targetOwnerId: targetId,
        standing, audit, auditAction: 'skill.owner.change',
      });
      const person = await client.query(
        `SELECT id FROM principals WHERE id = $1 AND kind = 'human' AND status = 'active'
           AND parent_principal_id IS NULL AND NOT legacy_identity FOR SHARE`, [targetId]);
      if (person.rows.length !== 1) {
        // Clause 9(a): an ACTIVE Group principal is a target too, admitted only
        // through the standing test above; a disabled one is refused.
        const group = evidence
          ? await client.query(`SELECT id FROM principals WHERE id = $1 AND kind = 'group' AND status = 'active' FOR SHARE`, [targetId])
          : { rows: [] };
        if (group.rows.length !== 1) {
          throw new SkillContractError(422, 'INVALID_SKILL_OWNER',
            'The owner must be an active person Account or an active Group', { field: 'ownerPrincipalId' });
        }
      }
      if (previous === targetId) {
        await client.query('COMMIT');
        return { skill: await this.getById(skillId, true), changed: false };
      }
      await client.query(
        `UPDATE skills SET owner_principal_id = $2, revision = gen_random_uuid(), updated_at = now() WHERE id = $1`,
        [skillId, targetId]);
      await auditService.record({
        action: 'skill.owner.change', actor: skillAuditActor(audit.principalId ?? undefined, audit),
        resourceType: 'skill', resourceId: skillId,
        metadata: {
          oldOwnerPrincipalId: previous, newOwnerPrincipalId: targetId, reason: input.reason.trim(),
          // Clause 9(f): kinds, member count, step-up and the admitting arm.
          ...groupTransferAuditFields(evidence),
        },
      }, client);
      await feedEventService.emit(client, {
        name: 'skill.updated', objectType: 'skill', objectId: skillId,
        actorPrincipalId: audit.principalId ?? null, payload: { owner: 'changed' },
      });
      await client.query('COMMIT');
      return { skill: await this.getById(skillId, true), changed: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async delete(id: string, expectedRevision: string, audit?: AuditActor): Promise<void> {
    return auditSkillRefusals('skill.delete', skillAuditActor(undefined, audit), id, async () => {
    this.requireRevision(expectedRevision);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT id, revision, is_global FROM skills WHERE id = $1 FOR UPDATE', [id]);
      if (!current.rows[0] || current.rows[0].revision !== expectedRevision) {
        await this.classifyRevisionFailure(id);
      }
      const history = await client.query('SELECT count(*)::integer AS count FROM skill_versions WHERE skill_id = $1', [id]);
      const pins = await client.query('SELECT count(*)::integer AS count FROM project_skills WHERE skill_id = $1', [id]);
      if ((history.rows[0]?.count || 0) > 0 || (pins.rows[0]?.count || 0) > 0) {
        throw new SkillContractError(409, 'SKILL_HAS_HISTORY', 'Hard delete is refused while immutable history or project pins exist; retire a Version instead');
      }
      await lifecyclePolicyService.evaluate(client, {
        action: 'skill.delete',
        subject: { kind: 'skill', id, revision: expectedRevision },
        proposed: null,
      });
      // RH-P3.C1: content-free deletion tombstone in the deleting
      // transaction. globallyVisible records that the Skill was readable by
      // every authenticated principal, so its tombstone reaches the audience
      // that could see it while it lived (round 1, F4).
      await feedEventService.emit(client, {
        name: 'skill.deleted', objectType: 'skill', objectId: id,
        globallyVisible: current.rows[0].is_global === true, payload: {},
      });
      await client.query('DELETE FROM skills WHERE id = $1 RETURNING id', [id]);
      await auditService.record({ action: 'skill.delete', actor: skillAuditActor(undefined, audit), resourceType: 'skill', resourceId: id,
        metadata: { isGlobal: current.rows[0].is_global === true } }, client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    });
  }

  async pinToProject(projectId: string, skillId: string, versionRef: string, audit?: AuditActor): Promise<ProjectSkillLink> {
    return auditSkillRefusals('skill.project_pin', skillAuditActor(undefined, audit), skillId, async () => {
    const version = await this.getVersion(skillId, versionRef, false, true);
    if (version.status !== 'published') {
      throw new SkillContractError(409, 'PUBLISHED_VERSION_REQUIRED', 'New project pins require a published Skill Version');
    }
    // RH-P3.C2 (pre-review F6): a pin change is a Skill change every
    // consumer can observe, and it is now the ONLY signal for it — the
    // emitter-only `skill.pin.changed` webhook retired with this candidate.
    // Emission rides the write's own transaction, per the C1 contract.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO project_skills (id, project_id, skill_id, skill_version_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, skill_id) DO UPDATE SET skill_version_id = EXCLUDED.skill_version_id
         RETURNING *`, [uuidv4(), projectId, skillId, version.id],
      );
      await auditService.record({ action: 'skill.project_pin', actor: skillAuditActor(undefined, audit), resourceType: 'skill', resourceId: skillId,
        metadata: { projectId, skillVersionId: String(version.id) } }, client);
      await feedEventService.emit(client, {
        name: 'skill.updated', objectType: 'skill', objectId: skillId,
        ...feedActorFields(audit),
        payload: { projectPin: 'set' },
      });
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    });
  }

  async unlinkFromProject(projectId: string, skillId: string, audit?: AuditActor): Promise<void> {
    return auditSkillRefusals('skill.project_unpin', skillAuditActor(undefined, audit), skillId, async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        'DELETE FROM project_skills WHERE project_id = $1 AND skill_id = $2 RETURNING id,skill_version_id', [projectId, skillId],
      );
      if (!result.rows[0]) {
        await client.query('ROLLBACK');
        throw new SkillContractError(404, 'SKILL_PIN_NOT_FOUND', 'Project Skill pin not found');
      }
      await auditService.record({ action: 'skill.project_unpin', actor: skillAuditActor(undefined, audit), resourceType: 'skill', resourceId: skillId,
        metadata: { projectId, skillVersionId: String(result.rows[0].skill_version_id) } }, client);
      await feedEventService.emit(client, {
        name: 'skill.updated', objectType: 'skill', objectId: skillId,
        ...feedActorFields(audit),
        payload: { projectPin: 'cleared' },
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    });
  }

  async getProjectSkills(projectId: string): Promise<ProjectSkillLink[]> {
    const result = await pool.query(
      `SELECT ps.id AS pin_id, ps.project_id, ps.skill_id, ps.skill_version_id,
              ps.created_at AS pin_created_at,
              s.name, s.is_global, s.current_published_version_id, s.revision,
              s.created_at AS skill_created_at, s.updated_at AS skill_updated_at,
              s.owner_principal_id, skill_owner.kind AS owner_kind,
              COALESCE(skill_owner.display_name, skill_owner.handle) AS owner_display_name,
              v.*, v.id AS pinned_version_id, v.created_at AS version_created_at
       FROM project_skills ps JOIN skills s ON s.id = ps.skill_id
       LEFT JOIN principals skill_owner ON skill_owner.id = s.owner_principal_id
       JOIN skill_version_state v ON v.id = ps.skill_version_id
       WHERE ps.project_id = $1 ORDER BY s.name ASC`, [projectId],
    );
    return result.rows.map(row => ({
      id: row.pin_id, project_id: row.project_id, skill_id: row.skill_id,
      skill_version_id: row.skill_version_id, created_at: row.pin_created_at,
      skill: this.mapSkillRow({ ...row, id: row.skill_id, version_id: row.pinned_version_id,
        version_created_at: row.version_created_at }),
      version: this.mapVersionRow({ ...row, id: row.pinned_version_id, created_at: row.version_created_at }, false),
    }));
  }

  async getEffectiveSkillsForProject(projectId: string): Promise<Array<{
    name: string; category: string | null; description: string; instructions: string;
    is_global: boolean; has_override: boolean; skill_version_id: string; version: number;
    content_sha256: string; provenance: SkillProvenance; status: SkillVersionStatus;
  }>> {
    const result = await pool.query(
      `WITH selected AS (
         SELECT s.id AS catalog_skill_id, s.name, s.is_global, v.*,
                FALSE AS project_pin
         FROM skills s JOIN skill_version_state v ON v.id = s.current_published_version_id
         WHERE s.is_global AND v.status = 'published'
         UNION ALL
         SELECT s.id AS catalog_skill_id, s.name, s.is_global, v.*,
                TRUE AS project_pin
         FROM project_skills ps JOIN skills s ON s.id = ps.skill_id
         JOIN skill_version_state v ON v.id = ps.skill_version_id
         WHERE ps.project_id = $1
       )
       SELECT DISTINCT ON (catalog_skill_id) * FROM selected
       ORDER BY catalog_skill_id, project_pin DESC, name ASC`, [projectId],
    );
    return result.rows.map(row => ({
      name: row.name, category: row.category, description: row.description,
      instructions: row.skill_md, is_global: row.is_global, has_override: false,
      skill_version_id: row.id, version: Number(row.version), content_sha256: row.content_sha256,
      provenance: row.provenance, status: row.status,
    }));
  }

  /**
   * Card f87776ad: refuse a provenance the creating Principal's kind cannot
   * record, naming the field, the value, the kind and what that kind may
   * record. Reads the same `principals` row the insert trigger reads, on the
   * same transaction. An unknown creator is left to the trigger, unchanged.
   */
  private async assertProvenanceForCreator(client: PoolClient, actor: string,
      provenance: SkillProvenance): Promise<void> {
    const creator = await client.query('SELECT kind FROM principals WHERE id = $1', [actor]);
    const kind = creator.rows[0]?.kind as string | undefined;
    if (!kind) return;
    const allowed = SKILL_PROVENANCE_BY_PRINCIPAL_KIND[kind] ?? ['imported'];
    if (allowed.includes(provenance)) return;
    throw new SkillContractError(422, 'INVALID_SKILL_VALUE',
      `provenance '${provenance}' cannot be recorded by a ${kind} Principal: ${provenance} provenance `
        + `requires ${PROVENANCE_REQUIREMENT[provenance]}; a ${kind} Principal may record ${allowed.join(' or ')}`,
      { field: 'provenance', provenance, principalKind: kind, allowed: [...allowed] });
  }

  private prepareDocument(name: string, input: CreateSkillInput | UpdateSkillInput, base?: any): {
    skillMd: string; description: string;
  } {
    const description = input.description !== undefined
      ? input.description : (base?.description || name);
    const skillMd = input.skill_md !== undefined
      ? input.skill_md
      : buildSkillDocument(name, description || name,
        input.usage_instructions !== undefined ? input.usage_instructions : (this.markdownBody(base?.skill_md) || ''));
    try {
      const parsed = parseSkillDocument(skillMd, name);
      return { skillMd, description: parsed.description };
    } catch (error) {
      contractFromDocument(error);
    }
  }

  private markdownBody(skillMd?: string): string {
    if (!skillMd) return '';
    const normalized = skillMd.replace(/\r\n/g, '\n');
    const close = normalized.indexOf('\n---\n', 4);
    return close < 0 ? '' : normalized.slice(close + 5).replace(/^\n/, '');
  }

  /** `draft`, when given, is the viewer's draft-visibility SQL: the newest
   * Version is shown only where it holds, else the published one. */
  private catalogQuery(includeUnpublished: boolean, draft?: string): string {
    const visible = draft ? `AND (${draft} OR sv.id = s.current_published_version_id)` : '';
    const join = includeUnpublished
      ? `LEFT JOIN LATERAL (
           SELECT * FROM skill_version_state sv WHERE sv.skill_id = s.id ${visible}
           ORDER BY sv.version DESC LIMIT 1
         ) v ON TRUE`
      : 'LEFT JOIN skill_version_state v ON v.id = s.current_published_version_id';
    return `SELECT s.*, v.id AS version_id, v.version, v.content_sha256, v.description,
                   v.category, v.tags, v.config, v.provenance, v.source_uri,
                   v.created_by_principal_id, v.created_at AS version_created_at,
                   v.status, v.status_actor_principal_id, v.status_note, v.status_changed_at,
                   to_jsonb(pv) AS published_version_data,
                   skill_owner.kind AS owner_kind,
                   COALESCE(skill_owner.display_name, skill_owner.handle) AS owner_display_name
            FROM skills s ${join}
            LEFT JOIN skill_version_state pv ON pv.id = s.current_published_version_id
            LEFT JOIN principals skill_owner ON skill_owner.id = s.owner_principal_id`;
  }

  private mapSkillRow(row: any): Skill {
    const current = row.version_id ? this.mapVersionRow({ ...row, id: row.version_id,
      skill_id: row.skill_id || row.id, created_at: row.version_created_at }, false) : null;
    return {
      id: row.skill_id || row.id, name: row.name, is_global: row.is_global,
      current_published_version_id: row.current_published_version_id, revision: row.revision,
      created_at: row.skill_created_at || row.created_at, updated_at: row.skill_updated_at || row.updated_at,
      current_version: current,
      published_version: row.published_version_data
        ? this.mapVersionRow(row.published_version_data, false) : null,
      version: current?.version ?? null, status: current?.status ?? null,
      category: current?.category ?? null, description: current?.description ?? null,
      tags: current?.tags ?? [], config: current?.config ?? {}, provenance: current?.provenance ?? null,
      content_sha256: current?.content_sha256 ?? null,
      owner_principal_id: row.owner_principal_id ?? null,
      owner_kind: row.owner_kind === 'human' || row.owner_kind === 'group' ? row.owner_kind : null,
      owner_display_name: row.owner_display_name ?? null,
    };
  }

  private mapVersionRow(row: any, includeContent: boolean): SkillVersion {
    return {
      id: row.id, skill_id: row.skill_id, version: Number(row.version),
      ...(includeContent ? { skill_md: row.skill_md } : {}),
      content_sha256: row.content_sha256, description: row.description, category: row.category,
      tags: row.tags || [], config: typeof row.config === 'string' ? JSON.parse(row.config) : (row.config || {}),
      provenance: row.provenance, source_uri: row.source_uri, created_by_principal_id: row.created_by_principal_id,
      created_at: row.created_at, status: row.status, status_actor_principal_id: row.status_actor_principal_id,
      status_note: row.status_note, status_changed_at: row.status_changed_at,
    };
  }

  private requireRevision(revision: string): void {
    if (!revision) throw new SkillContractError(400, 'REVISION_REQUIRED', 'The last observed revision is required (If-Match)');
  }

  private assertRevision(row: any, expected: string, id: string): void {
    if (!row) throw new SkillContractError(404, 'SKILL_NOT_FOUND', `Skill not found: ${id}`);
    if (row.revision !== expected) {
      throw new SkillContractError(412, 'REVISION_MISMATCH', 'The Skill changed since it was last read; reload and retry');
    }
  }

  private async classifyRevisionFailure(id: string): Promise<never> {
    const exists = await pool.query('SELECT 1 FROM skills WHERE id = $1', [id]);
    if (!exists.rows[0]) throw new SkillContractError(404, 'SKILL_NOT_FOUND', `Skill not found: ${id}`);
    throw new SkillContractError(412, 'REVISION_MISMATCH', 'The Skill changed since it was last read; reload and retry');
  }

  private async assertSkillExists(id: string): Promise<void> {
    const result = await pool.query('SELECT 1 FROM skills WHERE id = $1', [id]);
    if (!result.rows[0]) throw new SkillContractError(404, 'SKILL_NOT_FOUND', `Skill not found: ${id}`);
  }

  private async findVersionForUpdate(client: PoolClient, skillId: string, ref: string): Promise<any> {
    const byNumber = /^\d+$/.test(ref);
    const result = await client.query(
      `SELECT * FROM skill_version_state WHERE skill_id = $1
       AND ${byNumber ? 'version = $2::integer' : 'id = $2::uuid'}`, [skillId, ref],
    );
    if (!result.rows[0]) throw new SkillContractError(404, 'SKILL_VERSION_NOT_FOUND', `Skill Version not found: ${ref}`);
    return result.rows[0];
  }
}

export const skillManager = new SkillManager();
