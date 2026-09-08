// CharterService.ts — the Charter as a first-class object (task f2735f1b).
//
// A Charter is a Project's authority index (vocabulary amendment A9): it
// locates every governing agreement with status and precedence and asserts
// nothing new — conflicts always resolve to the underlying document. One
// Charter per Project; owner-plane writes (route-level: the write surface
// sits behind the root sentinel); versioned so every content state is
// attributable and restorable. Charter content is authored governance text,
// but the compiler still renders it under an explicit heading rather than
// interpolating it into instructions it did not write.
import { pool } from '../db/connection';
import crypto from 'crypto';

export const CHARTER_CONTENT_MAX_LENGTH = 131072;

export interface Charter {
  id: string;
  projectId: string;
  content: string;
  contentHash: string;
  version: number;
  revision: string;
  updatedByPrincipalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CharterVersionMeta {
  version: number;
  contentHash: string;
  actorPrincipalId: string | null;
  createdAt: string;
}

export interface CharterVersion extends CharterVersionMeta {
  content: string;
}

/**
 * A Charter LOOKUP FAILURE is not confirmed absence (review 6fa91e28 F1):
 * when the compiler cannot establish whether a project has a Charter, the
 * Brief must fail closed rather than compile without the authority index.
 * This error is thrown by the compile paths for exactly that case, and the
 * compile surfaces map it to a non-2xx response.
 */
export class CharterLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CharterLookupError';
  }
}

export class CharterError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'CharterError';
  }
}

const err = (status: number, code: string, message: string, field?: string) =>
  new CharterError(status, code, message, field);

interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function mapRow(row: any): Charter {
  return {
    id: row.id,
    projectId: row.project_id,
    content: row.content,
    contentHash: row.content_hash,
    version: row.version,
    revision: row.revision,
    updatedByPrincipalId: row.updated_by_principal_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVersionMeta(row: any): CharterVersionMeta {
  return {
    version: row.version,
    contentHash: row.content_hash,
    actorPrincipalId: row.actor_principal_id ?? null,
    createdAt: row.created_at,
  };
}

// Concealment before validation: an absent project must 404 identically
// whatever the body carries, or body validity leaks project existence.
async function lockProject(
  executor: Queryable,
  projectId: string,
  requireActive: boolean,
): Promise<void> {
  const result = await executor.query(
    'SELECT id, status FROM projects WHERE id = $1 FOR UPDATE',
    [projectId],
  );
  if (result.rows.length === 0) {
    throw err(404, 'PROJECT_NOT_FOUND', 'Project not found');
  }
  if (requireActive && result.rows[0].status === 'archived') {
    throw err(409, 'PROJECT_ARCHIVED', 'Project is archived and read-only; restore it first');
  }
}

async function requireProject(projectId: string): Promise<void> {
  const result = await pool.query('SELECT id FROM projects WHERE id = $1', [projectId]);
  if (result.rows.length === 0) {
    throw err(404, 'PROJECT_NOT_FOUND', 'Project not found');
  }
}

function validateContent(content: unknown): string {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw err(422, 'INVALID_CHARTER_VALUE', 'Charter content must be a non-empty string', 'content');
  }
  if (content.length > CHARTER_CONTENT_MAX_LENGTH) {
    throw err(
      400,
      'VALUE_TOO_LONG',
      `Charter content exceeds ${CHARTER_CONTENT_MAX_LENGTH} characters — a Charter is an index, not a copy`,
      'content',
    );
  }
  return content;
}

export class CharterService {
  /** Read the head Charter for a project. Reads serve archived projects too. */
  async get(projectId: string): Promise<Charter> {
    await requireProject(projectId);
    const result = await pool.query(
      'SELECT * FROM project_charters WHERE project_id = $1',
      [projectId],
    );
    if (result.rows.length === 0) {
      throw err(404, 'CHARTER_NOT_FOUND', 'This project has no Charter yet');
    }
    return mapRow(result.rows[0]);
  }

  /** Head Charter or null, for callers that treat absence as ordinary (the Brief compiler). */
  async find(projectId: string): Promise<Charter | null> {
    const result = await pool.query(
      'SELECT * FROM project_charters WHERE project_id = $1',
      [projectId],
    );
    return result.rows.length === 0 ? null : mapRow(result.rows[0]);
  }

  /**
   * Create or replace the head content (the single write surface).
   * Create: no revision expected. Replace: revision-bound via If-Match.
   * Identical content is a no-op that bumps nothing. Every content change
   * appends a project_charter_versions row for attribution/restore.
   */
  async put(
    projectId: string,
    content: unknown,
    revision: string | undefined,
    actorPrincipalId: string | null,
  ): Promise<{ charter: Charter; created: boolean; changed: boolean }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await lockProject(client, projectId, true);
      const validated = validateContent(content);
      const hash = sha256Hex(validated);

      const existing = await client.query(
        'SELECT * FROM project_charters WHERE project_id = $1 FOR UPDATE',
        [projectId],
      );

      if (existing.rows.length === 0) {
        const inserted = await client.query(
          `INSERT INTO project_charters (project_id, content, content_hash, version, updated_by_principal_id)
           VALUES ($1, $2, $3, 1, $4)
           RETURNING *`,
          [projectId, validated, hash, actorPrincipalId],
        );
        const head = inserted.rows[0];
        await client.query(
          `INSERT INTO project_charter_versions (charter_id, version, content, content_hash, actor_principal_id)
           VALUES ($1, 1, $2, $3, $4)`,
          [head.id, validated, hash, actorPrincipalId],
        );
        await client.query('COMMIT');
        return { charter: mapRow(head), created: true, changed: true };
      }

      const head = existing.rows[0];
      if (typeof revision !== 'string' || revision.length === 0) {
        throw err(400, 'REVISION_REQUIRED', 'The last observed revision is required (If-Match)');
      }
      if (revision !== head.revision) {
        throw err(412, 'REVISION_MISMATCH', 'The Charter changed since it was last read; reload and retry');
      }

      if (head.content === validated) {
        await client.query('COMMIT');
        return { charter: mapRow(head), created: false, changed: false };
      }

      const nextVersion = head.version + 1;
      const updated = await client.query(
        `UPDATE project_charters
         SET content = $2, content_hash = $3, version = $4,
             revision = gen_random_uuid(), updated_by_principal_id = $5, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [head.id, validated, hash, nextVersion, actorPrincipalId],
      );
      await client.query(
        `INSERT INTO project_charter_versions (charter_id, version, content, content_hash, actor_principal_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [head.id, nextVersion, validated, hash, actorPrincipalId],
      );
      await client.query('COMMIT');
      return { charter: mapRow(updated.rows[0]), created: false, changed: true };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** Version metadata, newest first. */
  async listVersions(projectId: string): Promise<CharterVersionMeta[]> {
    const charter = await this.get(projectId);
    const result = await pool.query(
      `SELECT version, content_hash, actor_principal_id, created_at
       FROM project_charter_versions
       WHERE charter_id = $1
       ORDER BY version DESC`,
      [charter.id],
    );
    return result.rows.map(mapVersionMeta);
  }

  /** One historical version, including content — restore = PUT it back. */
  async getVersion(projectId: string, version: number): Promise<CharterVersion> {
    if (!Number.isInteger(version) || version < 1) {
      throw err(400, 'INVALID_QUERY_VALUE', 'version must be a positive integer', 'version');
    }
    const charter = await this.get(projectId);
    const result = await pool.query(
      `SELECT version, content, content_hash, actor_principal_id, created_at
       FROM project_charter_versions
       WHERE charter_id = $1 AND version = $2`,
      [charter.id, version],
    );
    if (result.rows.length === 0) {
      throw err(404, 'CHARTER_VERSION_NOT_FOUND', 'No such Charter version');
    }
    const row = result.rows[0];
    return { ...mapVersionMeta(row), content: row.content };
  }
}

export const charterService = new CharterService();
