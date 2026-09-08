// SkillManager.ts - immutable Agent Skills registry and exact consumer pins.
import { PoolClient } from 'pg';
import { pool } from '../db/connection';
import { v4 as uuidv4 } from 'uuid';
import { buildSkillDocument, parseSkillDocument, SkillDocumentError } from '../utils/skillDocument';
import { feedEventService } from './FeedEventService';
import { lifecyclePolicyService } from './LifecyclePolicyService';

export type SkillVersionStatus = 'draft' | 'review' | 'published' | 'retired';
export type SkillProvenance = 'human-authored' | 'imported' | 'agent-drafted';

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
  constructor(public status: number, public code: string, message: string) {
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

export class SkillManager {
  async create(input: CreateSkillInput, actorPrincipalId?: string): Promise<Skill> {
    const actor = requireActor(actorPrincipalId);
    if (input.is_global) {
      throw new SkillContractError(422, 'PUBLISH_BEFORE_GLOBAL', 'Publish a reviewed version before making a Skill global');
    }
    const payload = this.prepareDocument(input.name, input);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const skillId = uuidv4();
      await client.query(
        `INSERT INTO skills (id, name, is_global) VALUES ($1, $2, FALSE)`,
        [skillId, input.name],
      );
      const versionId = uuidv4();
      await client.query(
        `INSERT INTO skill_versions
           (id, skill_id, version, skill_md, description, category, tags, config,
            provenance, source_uri, created_by_principal_id)
         VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [versionId, skillId, payload.skillMd, payload.description, input.category || null,
          input.tags || [], JSON.stringify(input.config || {}), input.provenance || 'human-authored',
          input.source_uri || null, actor],
      );
      await client.query(
        `INSERT INTO skill_version_events (skill_version_id, status, actor_principal_id, note)
         VALUES ($1, 'draft', $2, 'Initial immutable Skill Version')`,
        [versionId, actor],
      );
      // RH-P3.C1: same-transaction feed emission.
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
  }

  async getById(id: string, includeUnpublished = false): Promise<Skill> {
    const result = await pool.query(this.catalogQuery(includeUnpublished) + ' WHERE s.id = $1', [id]);
    if (result.rows.length === 0) {
      throw new SkillContractError(404, 'SKILL_NOT_FOUND', `Skill not found: ${id}`);
    }
    return this.mapSkillRow(result.rows[0]);
  }

  async getByName(name: string, includeUnpublished = false): Promise<Skill | null> {
    const result = await pool.query(this.catalogQuery(includeUnpublished) + ' WHERE s.name = $1', [name]);
    return result.rows[0] ? this.mapSkillRow(result.rows[0]) : null;
  }

  async list(options: SkillSearchOptions = {}, includeUnpublished = false): Promise<Skill[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown): void => {
      params.push(value);
      conditions.push(sql.replace('?', `$${params.length}`));
    };
    if (!includeUnpublished) conditions.push('s.current_published_version_id IS NOT NULL');
    if (options.category) add('v.category = ?', options.category);
    if (options.tag) add('? = ANY(v.tags)', options.tag);
    if (options.search) {
      params.push(`%${options.search}%`);
      conditions.push(`(s.name ILIKE $${params.length} OR v.description ILIKE $${params.length})`);
    }
    let query = this.catalogQuery(includeUnpublished);
    if (conditions.length) query += ` WHERE ${conditions.join(' AND ')}`;
    query += ' ORDER BY s.name ASC';
    const result = await pool.query(query, params);
    return result.rows.map(row => this.mapSkillRow(row));
  }

  /** Existing PUT semantics become insertion of the next immutable draft. */
  async update(id: string, input: UpdateSkillInput, expectedRevision: string, actorPrincipalId?: string): Promise<Skill> {
    const actor = requireActor(actorPrincipalId);
    this.requireRevision(expectedRevision);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const catalog = await client.query('SELECT * FROM skills WHERE id = $1 FOR UPDATE', [id]);
      this.assertRevision(catalog.rows[0], expectedRevision, id);
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
          input.provenance || 'human-authored', input.source_uri || null, actor],
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
  }

  async listVersions(skillId: string, includeUnpublished = false): Promise<SkillVersion[]> {
    await this.assertSkillExists(skillId);
    const result = await pool.query(
      `SELECT * FROM skill_version_state WHERE skill_id = $1
       ${includeUnpublished ? '' : "AND status = 'published'"} ORDER BY version DESC`, [skillId],
    );
    return result.rows.map(row => this.mapVersionRow(row, false));
  }

  async getVersion(skillId: string, versionRef: string, includeContent: boolean,
      includeUnpublished = false): Promise<SkillVersion> {
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

  async transition(skillId: string, versionRef: string, status: SkillVersionStatus,
      actorPrincipalId: string | undefined, note: string | undefined, expectedRevision: string): Promise<SkillVersion> {
    const actor = requireActor(actorPrincipalId);
    this.requireRevision(expectedRevision);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const catalog = await client.query('SELECT * FROM skills WHERE id = $1 FOR UPDATE', [skillId]);
      this.assertRevision(catalog.rows[0], expectedRevision, skillId);
      const version = await this.findVersionForUpdate(client, skillId, versionRef);
      if (status === 'published') {
        const principal = await client.query('SELECT kind FROM principals WHERE id = $1', [actor]);
        if (principal.rows[0]?.kind !== 'human') {
          throw new SkillContractError(403, 'HUMAN_REVIEW_REQUIRED', 'Publishing requires a human Principal');
        }
        if (version.created_by_principal_id === actor) {
          throw new SkillContractError(409, 'INDEPENDENT_REVIEW_REQUIRED', 'A creator cannot publish their own Skill Version');
        }
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
  }

  async setGlobal(skillId: string, isGlobal: boolean, expectedRevision: string): Promise<Skill> {
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
        await feedEventService.emit(client, {
          name: 'skill.updated', objectType: 'skill', objectId: skillId, payload: {},
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
  }

  async delete(id: string, expectedRevision: string): Promise<void> {
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
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async pinToProject(projectId: string, skillId: string, versionRef: string): Promise<ProjectSkillLink> {
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
      await feedEventService.emit(client, {
        name: 'skill.updated', objectType: 'skill', objectId: skillId,
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
  }

  async unlinkFromProject(projectId: string, skillId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        'DELETE FROM project_skills WHERE project_id = $1 AND skill_id = $2 RETURNING id', [projectId, skillId],
      );
      if (!result.rows[0]) {
        await client.query('ROLLBACK');
        throw new SkillContractError(404, 'SKILL_PIN_NOT_FOUND', 'Project Skill pin not found');
      }
      await feedEventService.emit(client, {
        name: 'skill.updated', objectType: 'skill', objectId: skillId,
        payload: { projectPin: 'cleared' },
      });
      await client.query('COMMIT');
    } catch (error) {
      if (!(error instanceof SkillContractError)) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getProjectSkills(projectId: string): Promise<ProjectSkillLink[]> {
    const result = await pool.query(
      `SELECT ps.id AS pin_id, ps.project_id, ps.skill_id, ps.skill_version_id,
              ps.created_at AS pin_created_at,
              s.name, s.is_global, s.current_published_version_id, s.revision,
              s.created_at AS skill_created_at, s.updated_at AS skill_updated_at,
              v.*, v.id AS pinned_version_id, v.created_at AS version_created_at
       FROM project_skills ps JOIN skills s ON s.id = ps.skill_id
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

  private catalogQuery(includeUnpublished: boolean): string {
    const join = includeUnpublished
      ? `LEFT JOIN LATERAL (
           SELECT * FROM skill_version_state sv WHERE sv.skill_id = s.id ORDER BY sv.version DESC LIMIT 1
         ) v ON TRUE`
      : 'LEFT JOIN skill_version_state v ON v.id = s.current_published_version_id';
    return `SELECT s.*, v.id AS version_id, v.version, v.content_sha256, v.description,
                   v.category, v.tags, v.config, v.provenance, v.source_uri,
                   v.created_by_principal_id, v.created_at AS version_created_at,
                   v.status, v.status_actor_principal_id, v.status_note, v.status_changed_at,
                   to_jsonb(pv) AS published_version_data
            FROM skills s ${join}
            LEFT JOIN skill_version_state pv ON pv.id = s.current_published_version_id`;
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
