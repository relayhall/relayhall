// PersonalityService.ts — CRUD for board-native Personalities
import { pool } from '../db/connection';
import { ConflictFault } from '../utils/httpErrors';
import { feedEventService } from './FeedEventService';
import { PERSONALITY_VERSION_JOIN, PERSONALITY_VERSION_IDENTITY, PERSONALITY_DETAIL_SELECT, projectPersonalityVersion } from '../utils/personalityVersion';

type PersonalityQueryable = { query(text: string, values?: any[]): Promise<{ rows: any[] }> };

/** Provenance of a personality row. Personalities are board-native: built-in
 *  seeds plus board-managed rows created over REST/CLI/MCP/GUI. The 'git' and
 *  'legacy-db' values are historical — rows imported by the retired repository
 *  sync (removed 2026-08-09, owner ruling) or predating provenance. Stored
 *  values stay valid forever; both render as read-only imported rows. */
export type PersonalitySource = 'built-in' | 'managed' | 'git' | 'legacy-db';

export interface Personality {
  id: string;
  version: number;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  color: string | null;
  content: string | null;
  source_file: string | null;
  is_custom: boolean;
  source: PersonalitySource;
  retired_at: string | null;
  retired_reason: string | null;
  retired_in_favor_of: string | null;
  created_at: string;
  updated_at: string;
}

export interface PersonalitySummary {
  id: string;
  version: number;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  color: string | null;
  is_custom: boolean;
  source: PersonalitySource;
  retired_at: string | null;
}

export class PersonalityService {
  private async current(queryable: PersonalityQueryable, field: 'id' | 'slug', value: string): Promise<Personality | null> {
    const result = await queryable.query(`SELECT ${PERSONALITY_DETAIL_SELECT}
      FROM ${PERSONALITY_VERSION_JOIN} WHERE p.${field} = $1`, [value]);
    return result.rows[0] ? projectPersonalityVersion(result.rows[0], true) : null;
  }

  private async written(queryable: PersonalityQueryable, id: string): Promise<Personality> {
    const current = await this.current(queryable, 'id', id);
    if (!current) throw new Error('Personality write omitted its current immutable version');
    return current;
  }

  /**
   * List personalities. Retired (soft-deleted duplicate) rows are EXCLUDED by
   * default so consumers — including `relayhall doctor` — see one live row per
   * name/slug. Pass includeRetired to surface them (e.g. an admin registry view).
   */
  async list(category?: string, includeRetired = false): Promise<PersonalitySummary[]> {
    let query = `SELECT p.id, p.slug, p.name, p.description, p.category, p.color, p.is_custom, p.source, p.retired_at,
      ${PERSONALITY_VERSION_IDENTITY} FROM ${PERSONALITY_VERSION_JOIN}`;
    const params: any[] = [];
    const where: string[] = [];
    if (!includeRetired) {
      where.push(`p.retired_at IS NULL`);
    }
    if (category) {
      params.push(category);
      where.push(`p.category = $${params.length}`);
    }
    if (where.length) {
      query += ` WHERE ` + where.join(' AND ');
    }
    query += ` ORDER BY p.category, p.name`;
    const result = await pool.query(query, params);
    return result.rows.map(row => projectPersonalityVersion(row, false));
  }

  async getById(id: string): Promise<Personality | null> {
    return this.current(pool, 'id', id);
  }

  async getBySlug(slug: string): Promise<Personality | null> {
    return this.current(pool, 'slug', slug);
  }

  /** Get sessions that used this personality */
  async getLinkedSessions(personalityId: string): Promise<any[]> {
    const result = await pool.query(`
      SELECT session_key, kind, label, model, started_at, ended_at, total_cost_usd, message_count
      FROM sessions
      WHERE personality_id = $1
      ORDER BY started_at DESC
      LIMIT 50
    `, [personalityId]);
    return result.rows;
  }

  /** Get tasks that used this personality */
  async getLinkedTasks(personalityId: string): Promise<any[]> {
    const result = await pool.query(`
      SELECT t.id, t.title, t.status, t.priority, p.name as project, t.created_at, t.completed_at
      FROM tasks t
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE t.personality_id = $1
      ORDER BY t.created_at DESC
      LIMIT 50
    `, [personalityId]);
    return result.rows;
  }

  async categories(): Promise<string[]> {
    const result = await pool.query(
      `SELECT DISTINCT category FROM personalities WHERE category IS NOT NULL AND retired_at IS NULL ORDER BY category`
    );
    return result.rows.map(r => r.category);
  }

  async create(input: {
    slug: string;
    name: string;
    description?: string | null;
    category?: string | null;
    color?: string | null;
    content?: string | null;
  }): Promise<Personality | null> {
    // RH-P3.C1: the write and its feed event share a transaction.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO personalities
           (slug, name, description, category, color, content, source_file, is_custom, source)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, true, 'managed')
         ON CONFLICT (slug) DO NOTHING
         RETURNING *`,
        [input.slug, input.name, input.description ?? null, input.category ?? null,
         input.color ?? null, input.content ?? null]
      );
      const current = result.rows[0] ? await this.written(client, result.rows[0].id) : null;
      if (current && current.version !== 1) throw new Error('Personality creation omitted its initial immutable version');
      if (current) {
        await feedEventService.emit(client, {
          name: 'personality.created', objectType: 'personality',
          objectId: result.rows[0].id, payload: {},
        });
      }
      await client.query('COMMIT');
      return current;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async update(id: string, input: {
    name?: string;
    description?: string | null;
    category?: string | null;
    color?: string | null;
    content?: string | null;
  }): Promise<Personality | null> {
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [field, column] of [
      ['name', 'name'], ['description', 'description'], ['category', 'category'],
      ['color', 'color'], ['content', 'content'],
    ] as const) {
      if (input[field] !== undefined) {
        values.push(input[field]);
        sets.push(`${column} = $${values.length}`);
      }
    }
    if (!sets.length) return this.getById(id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE personalities SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $1 AND source = 'managed' AND retired_at IS NULL RETURNING *`,
        values
      );
      const current = result.rows[0] ? await this.written(client, result.rows[0].id) : null;
      if (current) {
        await feedEventService.emit(client, {
          name: 'personality.updated', objectType: 'personality',
          objectId: id, payload: {},
        });
      }
      await client.query('COMMIT');
      return current;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async retire(id: string, reason?: string): Promise<Personality | null> {
    const existing = await this.getById(id);
    if (!existing || existing.retired_at) return null;
    if (existing.source !== 'managed' || existing.slug === 'generalist') {
      throw new ConflictFault('Only managed, non-generalist personalities can be retired', 'PERSONALITY_NOT_MANAGED');
    }
    // RH-P3.C1: retirement removes the Personality from every consumer's
    // catalogue view — a content-free deletion tombstone, per the §2.6.1
    // propagation rule. The row itself is preserved (soft removal).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE personalities
            SET retired_at = now(), retired_reason = $2, updated_at = now()
          WHERE id = $1 AND retired_at IS NULL RETURNING *`,
        [id, reason || 'retired by an administrator']
      );
      const current = result.rows[0] ? await this.written(client, result.rows[0].id) : null;
      if (current) {
        await feedEventService.emit(client, {
          name: 'personality.deleted', objectType: 'personality',
          objectId: id, payload: {},
        });
      }
      await client.query('COMMIT');
      return current;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Safely retire a duplicate personality: repoint every task and session that
   * references the loser to the canonical winner (across ALL statuses,
   * including archived), then soft-delete the loser via retired_at. The row is
   * preserved — never hard-deleted — so historical detail/provenance survives.
   *
   * Matched by slug (IDs vary per environment). Idempotent: a no-op if the
   * loser is absent or already retired, or if the winner is absent.
   *
   * @returns null if nothing was done, otherwise the repoint counts.
   */
  async retireDuplicate(
    loserSlug: string,
    winnerSlug: string,
    reason?: string,
  ): Promise<{ tasksRepointed: number; sessionsRepointed: number; loserId: string; winnerId: string } | null> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const loser = await client.query('SELECT id, retired_at FROM personalities WHERE slug = $1', [loserSlug]);
      const winner = await client.query('SELECT id FROM personalities WHERE slug = $1', [winnerSlug]);
      if (loser.rowCount === 0 || winner.rowCount === 0 || loser.rows[0].retired_at !== null) {
        await client.query('ROLLBACK');
        return null;
      }

      const loserId: string = loser.rows[0].id;
      const winnerId: string = winner.rows[0].id;

      const t = await client.query('UPDATE tasks SET personality_id = $1 WHERE personality_id = $2 RETURNING id, project_id, owner_principal_id', [winnerId, loserId]);
      const s = await client.query('UPDATE sessions SET personality_id = $1 WHERE personality_id = $2', [winnerId, loserId]);

      await client.query(
        `UPDATE personalities
           SET retired_at = now(),
               retired_reason = $2,
               retired_in_favor_of = $3,
               updated_at = now()
         WHERE id = $1`,
        [loserId, reason || `duplicate personality name; retired in favor of ${winnerSlug}`, winnerId],
      );

      // RH-P3.C1 (round 1, F2): each repointed Task changed as its
      // consumers see it; every one announces itself in this transaction.
      for (const repointed of t.rows) {
        await feedEventService.emit(client, {
          name: 'task.updated', objectType: 'task', objectId: repointed.id,
          projectId: repointed.project_id ?? null,
          ownerPrincipalId: repointed.owner_principal_id ?? null,
          payload: {},
        });
      }
      await feedEventService.emit(client, {
        name: 'personality.deleted', objectType: 'personality',
        objectId: loserId, payload: {},
      });
      await client.query('COMMIT');
      return {
        tasksRepointed: t.rowCount ?? 0,
        sessionsRepointed: s.rowCount ?? 0,
        loserId,
        winnerId,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

export const personalityService = new PersonalityService();
