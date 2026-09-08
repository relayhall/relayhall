import { blueprintProvenanceOf, type BlueprintProvenanceFields } from '../utils/blueprintProvenance';
import type { CreationTransaction } from '../db/creationTransaction';
// ReportManager.ts - PostgreSQL-backed report/notes management
import crypto from 'crypto';
import { Pool } from 'pg';
import { pool as defaultPool } from '../db/connection';
import { normalizeReportHandover, ReportHandover } from '../types/ReportHandover';
import { feedEventService } from './FeedEventService';

export interface Report extends BlueprintProvenanceFields {
  id: string;
  title: string;
  content: string;
  /** sha256 hex digest of content, computed server-side on INSERT/UPDATE (migration 056). */
  content_hash: string | null;
  summary: string | null;
  tags: string[];
  project_id: string | null;
  project_name?: string;
  task_ids: string[];
  /** Free-form, client-supplied author label. NOT verified — see author_actor_id. */
  author: string;
  /** Alias of `author` that makes its unverified nature explicit to consumers (migration 058). */
  author_unverified: string;
  /** Authenticated identity (req.userId) recorded server-side on POST; never client-settable. */
  author_actor_id: string | null;
  /**
   * The VERIFIED attribution, ready to render: the display name of the
   * principal `author_principal_id` names, falling back to that principal's
   * handle when it carries no display name.
   *
   * Card 91599cd2: the board rendered `author` - a free-form label the caller
   * supplies, recorded unverified, and confirmed spoofable in the same session
   * - as the attribution, while the value the server had actually resolved
   * from the authenticated identity was never shown anywhere. On a fresh
   * install that made every human-filed Report read "By system", because the
   * column defaults to the literal string `system`.
   *
   * Review `99ba9444` B1 moved WHICH column this resolves. It is no longer
   * `author_actor_id`: that string is not tagged with its encoding - a handle
   * from the REST writer, a principal UUID from the task-finish writer - and
   * the two can collide, so no order of arbitration between them is correct.
   *
   * `null` when the Report carries NO author at all; the literal
   * `Unattributed` when it carries one that names no readable identity, or
   * carries only HALF the pair - the shape an author-erasure leaves behind
   * (round 1 finding P1). Either way a surface renders this and decides
   * nothing.
   */
  author_actor_name: string | null;
  /** Creating surface ('api' | 'cli' | 'dashboard' | ...), from X-RelayHall-Origin (migration 059). */
  origin: string;
  /** Visibility label (migration 061). Plumbing only — enforcement is fabric-side. */
  visibility: string;
  /** Server-written marker and source linkage for RH-DESIGN.5 R3 promotions. */
  auto_promoted: boolean;
  source_task_id: string | null;
  source_stream_entry_id: string | null;
  source_outpost_visibility_tier: string | null;
  /** Optional bounded machine-readable resumption context (RH-P2.9). */
  handover: ReportHandover | null;
  pinned: boolean;
  /** Lifecycle subset (b94dd86e §4.1, A11.2): archived reports are read-only and excluded from default lists, but stay readable and linkable. */
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
  /** Tombstone timestamp (migration 060). Non-null rows are hidden unless include_deleted. */
  deleted_at: string | null;
}

export type ReportSortField = 'updated_at' | 'created_at';
export type ReportSortOrder = 'asc' | 'desc';

export interface ReportListOptions {
  /** Reports linked to this Task (task_ids containment or task_references kind='report'). */
  taskId?: string;
  q?: string;
  tags?: string[];
  project_id?: string;
  pinned?: boolean;
  limit?: number;
  offset?: number;
  /** Inclusive lower bound on updated_at (ISO8601). Clients dedupe boundary rows by id. */
  updated_since?: string;
  /** Explicit sort column. When set, ordering is `<sort> <order>, id <order>` (stable). Default keeps legacy pinned-first ordering. */
  sort?: ReportSortField;
  /** Sort direction for `sort`; ignored without it. Default 'desc'. */
  order?: ReportSortOrder;
  /** Opt-in: include soft-deleted (tombstoned) rows. Default false. */
  include_deleted?: boolean;
  /** Filter on the lifecycle status. Without it, archived rows are excluded unless include_archived. */
  status?: 'active' | 'archived';
  /** Opt-in: include archived rows in the default (no status filter) listing. */
  include_archived?: boolean;
}

export interface ReportCreateData {
  title: string;
  content: string;
  summary?: string;
  tags?: string[];
  project_id?: string;
  task_ids?: string[];
  author?: string;
  /** Set by the route layer from the authenticated identity only — never from the request body. */
  author_actor_id?: string | null;
  /**
   * The author's principal UUID, set by the route layer from the resolved
   * identity. NOT a display concern: `reports.author_principal_id` is the
   * column the shared predicate reads as this Report's OWNER and CREATOR
   * (`AuthorizationRepository.sqlResource('report')`), and neither writer
   * recorded it - migration 063 backfilled historical rows and nothing wrote
   * it going forward, so an author did not own the Report they had just
   * filed (review 302a338f B3).
   */
  author_principal_id?: string | null;
  /** Set by the route layer from the validated X-RelayHall-Origin header; defaults to 'api'. */
  origin?: string;
  /** Visibility label; validated by the route layer. Defaults to 'default'. */
  visibility?: string;
  handover?: ReportHandover | null;
  pinned?: boolean;
}

export interface ReportUpdateData {
  title?: string;
  content?: string;
  summary?: string;
  tags?: string[];
  project_id?: string | null;
  task_ids?: string[];
  author?: string;
  /** Visibility label; validated by the route layer. */
  visibility?: string;
  handover?: ReportHandover | null;
  pinned?: boolean;
}

export interface ReportListResult {
  reports: Report[];
  total: number;
  hasMore: boolean;
}

export interface ReviewerReportSummary {
  id: string;
  title: string;
  summary: string | null;
  content: string;
}

export interface StructuredHandoverReport {
  id: string;
  title: string;
  status: 'active' | 'archived';
  handover: ReportHandover;
}

/**
 * A search query that IS a report id or id-prefix: at least the 8-char short id,
 * optionally continuing as a (partial) UUID. Hex + hyphens only, so it can never
 * carry LIKE wildcards into the id match.
 */
export function isReportIdQuery(q: string): boolean {
  return /^[0-9a-f]{8}(-[0-9a-f-]{0,28})?$/i.test(q.trim());
}

/**
 * Character limits of the varchar columns in the reports table. Route
 * validation and the generated summary both read these, so the two cannot
 * drift apart from the schema or from each other.
 */
export const REPORT_TEXT_LIMITS = {
  title: 500,
  summary: 500,
  author: 100,
} as const;

/**
 * PostgreSQL-backed Report Manager
 * Manages markdown reports/notes linked to projects and tasks
 */
/** The name a Report with no canonical author is given. Never a guess
 * resolved out of the ambiguous provenance string, and never that string
 * printed as if it were a name (review `99ba9444` B1). */
export const UNATTRIBUTED = 'Unattributed';

export class ReportManager {
  private pool: Pool;

  constructor(pool?: Pool) {
    this.pool = pool || defaultPool;
  }

  /**
   * Map a database row to a Report object
   */
  /** sha256 hex digest of report content; single source of truth for content_hash. */
  static computeContentHash(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  private mapRow(row: any): Report {
    return {
      ...blueprintProvenanceOf(row),
      id: row.id,
      title: row.title,
      content: row.content,
      content_hash: row.content_hash || null,
      summary: row.summary || null,
      tags: row.tags || [],
      project_id: row.project_id || null,
      project_name: row.project_name || undefined,
      task_ids: row.task_ids || [],
      author: row.author || 'system',
      author_unverified: row.author || 'system',
      author_actor_id: row.author_actor_id || null,
      // ATTRIBUTION RESOLVES FROM THE CANONICAL COLUMN (review `99ba9444` B1).
      //
      // `author_actor_id` is a provenance string that is NOT TAGGED WITH ITS
      // ENCODING: the REST writer stores the authenticated HANDLE, the
      // task-finish writer stores the principal UUID, and `validateNewHandle`
      // admits a UUID-shaped handle (`credentialAuthority.ts`: the pattern
      // `^[a-z0-9][a-z0-9_.-]{1,63}$`, which a canonical lowercase UUID
      // satisfies). So principal A's HANDLE can equal principal B's ID, and a
      // read that joins on that column matches BOTH principals for one row.
      // Handle-first named A on the task-finish row; id-first named B on the
      // REST row. Reversing the preference only reversed which ambiguous
      // spelling wins; consistency with another ambiguous resolver is not
      // correctness, and there is no third order that is right.
      //
      // So this no longer resolves an untagged spelling at all. It resolves
      // `reports.author_principal_id` - the canonical authority column that
      // `AuthorizationRepository.sqlResource('report')` already reads as this
      // Report's OWNER and CREATOR, populated by BOTH current writers
      // (`routes/reports.ts` from `req.principal.id`, `TaskElementService
      // .createReport` from the acting principal). One join on a primary key,
      // no ambiguity to arbitrate.
      //
      // AND IT FAILS CLOSED. A row with no canonical author is UNATTRIBUTED -
      // never the raw provenance string rendered as if it were a name, and
      // never a guess resolved out of the ambiguous column. `author_actor_id`
      // itself is still carried above, unchanged, as provenance.
      // AND ATTRIBUTION NEEDS BOTH COLUMNS (round 1 finding P1). Every writer
      // records the canonical author and the provenance string together or
      // records neither, so a row carrying one without the other is not a
      // half-known author — it is a row something has ERASED. Author-erasure
      // (`TaskElementService.redact`) now clears both, but rows erased before
      // that repair still carry a live canonical column beside a NULL
      // provenance, and rendering them would name the principal the erasure
      // was ordered to remove. Both, or Unattributed.
      author_actor_name: (row.author_principal_id && row.author_actor_id)
        ? (row.author_actor_display_name || row.author_actor_handle || UNATTRIBUTED)
        : ((row.author_principal_id || row.author_actor_id) ? UNATTRIBUTED : null),
      origin: row.origin || 'api',
      visibility: row.visibility || 'default',
      auto_promoted: row.auto_promoted === true,
      source_task_id: row.source_task_id || null,
      source_stream_entry_id: row.source_stream_entry_id || null,
      source_outpost_visibility_tier: row.source_outpost_visibility_tier || null,
      handover: row.handover == null ? null : normalizeReportHandover(row.handover),
      pinned: row.pinned || false,
      status: row.status === 'archived' ? 'archived' : 'active',
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted_at: row.deleted_at || null,
    };
  }

  /**
   * List reports with pagination, filtering, and search
   */
  async list(opts: ReportListOptions = {}): Promise<ReportListResult> {
    const limit = Math.min(Math.max(opts.limit || 10, 1), 100);
    const offset = Math.max(opts.offset || 0, 0);

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    // Soft-deleted rows are invisible unless explicitly requested.
    if (!opts.include_deleted) {
      conditions.push('r.deleted_at IS NULL');
    }

    // Archived rows leave default lists (§4.4) but stay reachable by
    // explicit filter or opt-in. They still count as context elsewhere.
    if (opts.status !== undefined) {
      conditions.push(`r.status = $${paramIndex}`);
      params.push(opts.status);
      paramIndex++;
    } else if (!opts.include_archived) {
      conditions.push(`r.status = 'active'`);
    }

    // Text search on title and content — except when q IS a report id/prefix:
    // ids are exchanged constantly (agents cite them in every report), so a
    // pasted id means "this exact report", not "reports that mention this id".
    if (opts.q) {
      if (isReportIdQuery(opts.q)) {
        conditions.push(`r.id::text ILIKE $${paramIndex}`);
        params.push(`${opts.q.trim().toLowerCase()}%`);
        paramIndex++;
      } else {
        const searchPattern = `%${opts.q}%`;
        conditions.push(`(r.title ILIKE $${paramIndex} OR r.content ILIKE $${paramIndex})`);
        params.push(searchPattern);
        paramIndex++;
      }
    }

    // Tag filter (contains all specified tags)
    if (opts.tags && opts.tags.length > 0) {
      conditions.push(`r.tags @> $${paramIndex}::text[]`);
      params.push(opts.tags);
      paramIndex++;
    }

    // Project filter
    if (opts.project_id) {
      conditions.push(`r.project_id = $${paramIndex}`);
      params.push(opts.project_id);
      paramIndex++;
    }

    // Pinned filter
    if (opts.pinned !== undefined) {
      conditions.push(`r.pinned = $${paramIndex}`);
      params.push(opts.pinned);
      paramIndex++;
    }

    // Task filter (C1, design 3cdf6e65 §4.2): reports whose task_ids contain
    // the Task OR that are linked from it via task_references kind='report'.
    // camelCase per the dominant API convention — the reports-family
    // snake_case params are a recorded nonconformance, not a precedent.
    if (opts.taskId) {
      conditions.push(`(
        r.task_ids::text[] @> ARRAY[$${paramIndex}]::text[]
        OR EXISTS (
          SELECT 1 FROM task_references tr
           WHERE tr.task_id = $${paramIndex}::uuid
             AND tr.kind = 'report'
             AND tr.target_id = r.id
        )
      )`);
      params.push(opts.taskId);
      paramIndex++;
    }

    // Incremental-sync filter: rows touched at or after the given instant.
    // Inclusive (>=) so boundary rows are never lost between polls; clients
    // dedupe by id. Route layer validates ISO8601 before it reaches here.
    if (opts.updated_since) {
      conditions.push(`r.updated_at >= $${paramIndex}::timestamptz`);
      params.push(opts.updated_since);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Explicit sort (updated_at|created_at) with a stable id tiebreak; the
    // legacy pinned-first ordering remains the default behaviour.
    const sortColumn = opts.sort === 'updated_at' ? 'r.updated_at'
      : opts.sort === 'created_at' ? 'r.created_at'
      : null;
    const sortDirection = opts.order === 'asc' ? 'ASC' : 'DESC';
    const orderClause = sortColumn
      ? `ORDER BY ${sortColumn} ${sortDirection}, r.id ${sortDirection}`
      : 'ORDER BY r.pinned DESC, r.created_at DESC';

    // Get total count
    const countResult = await this.pool.query(
      `SELECT COUNT(*) as total FROM reports r ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].total, 10);

    // Get paginated results with project name join
    const dataParams = [...params, limit, offset];
    const dataResult = await this.pool.query(
      `SELECT r.*, p.name as project_name,
              ap.display_name AS author_actor_display_name,
              ap.handle AS author_actor_handle
       FROM reports r
       LEFT JOIN projects p ON r.project_id = p.id
       LEFT JOIN principals ap ON ap.id = r.author_principal_id
       ${whereClause}
       ${orderClause}
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      dataParams
    );

    const reports = dataResult.rows.map((row: any) => this.mapRow(row));

    return {
      reports,
      total,
      hasMore: offset + limit < total,
    };
  }

  /**
   * Get a single report by ID with project name resolved.
   * Soft-deleted rows return null unless opts.includeDeleted.
   */
  async getById(id: string, opts: { includeDeleted?: boolean } = {}, queryable: Pick<import('pg').PoolClient, 'query'> = this.pool): Promise<Report | null> {
    const result = await queryable.query(
      `SELECT r.*, p.name as project_name,
              ap.display_name AS author_actor_display_name,
              ap.handle AS author_actor_handle
       FROM reports r
       LEFT JOIN projects p ON r.project_id = p.id
       LEFT JOIN principals ap ON ap.id = r.author_principal_id
       WHERE r.id = $1${opts.includeDeleted ? '' : ' AND r.deleted_at IS NULL'}`,
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRow(result.rows[0]);
  }

  async getByTaskId(taskId: string): Promise<ReviewerReportSummary[]> {
    const result = await this.pool.query(
      `SELECT id, title, summary, content
       FROM reports
       WHERE $1::uuid = ANY(task_ids) AND deleted_at IS NULL
       ORDER BY pinned DESC, created_at DESC`,
      [taskId]
    );

    return result.rows.map((row: any) => ({
      id: row.id,
      title: row.title,
      summary: row.summary || null,
      content: row.content,
    }));
  }

  /**
   * Bounded handover projection for the Brief compiler. A Report must both
   * link the Task and belong to the same Project, preventing cross-Project
   * Report data from crossing the Project authorization boundary. Archived
   * Reports remain readable/linkable context; tombstones do not.
   */
  async getStructuredHandoversForTask(
    taskId: string,
    projectId: string,
  ): Promise<{ reports: StructuredHandoverReport[]; omitted: number }> {
    const result = await this.pool.query(
      `SELECT id, title, status, handover, COUNT(*) OVER() AS total_count
       FROM reports
       WHERE $1::uuid = ANY(task_ids)
         AND project_id = $2::uuid
         AND deleted_at IS NULL
         AND handover IS NOT NULL
       ORDER BY updated_at DESC, id DESC
       LIMIT 50`,
      [taskId, projectId],
    );
    const rows = result.rows;
    return {
      reports: rows.map((row: any) => ({
        id: row.id,
        title: row.title,
        status: row.status === 'archived' ? 'archived' : 'active',
        handover: normalizeReportHandover(row.handover)!,
      })),
      omitted: rows.length === 0 ? 0 : Math.max(0, Number(rows[0].total_count) - rows.length),
    };
  }

  /**
   * The feed's owner_principal_id column is a UUID, and so is
   * `reports.author_principal_id`. Read it straight: the untagged
   * `author_actor_id` this used to resolve is a HANDLE from one writer and a
   * UUID from the other, and no order of arbitration between two encodings
   * that can collide is correct (review `99ba9444` B1). Unknown records NULL.
   * Provenance itself stays on the report row's author_actor_id (round 1, F1).
   */
  private ownerPrincipalId(row: { author_principal_id?: string | null } | undefined): string | null {
    // Review `99ba9444` B1: there is nothing left to resolve. The feed's
    // `owner_principal_id` is a UUID and `reports.author_principal_id` is one
    // - a foreign key to `principals(id)` - so the owner IS that column.
    // Resolving the untagged `author_actor_id` instead is what delivered one
    // principal's transition metadata to whoever owned the colliding spelling,
    // and a row with no canonical author records NULL: provenance stays on the
    // emitting row, and the feed does not guess an owner.
    return row?.author_principal_id ?? null;
  }

  /**
   * Create a new report
   * Auto-generates summary from first 500 chars of content if not provided
   */
  async create(data: ReportCreateData, transaction?: CreationTransaction): Promise<Report> {
    if (transaction && data.author_principal_id !== transaction.actor.principalId) throw new Error('Creation actor mismatch');
    // Auto-generate summary if not provided
    const summary = data.summary || this.generateSummary(data.content);

    // RH-P3.C1: the write and its feed event commit or vanish together — a
    // single-statement pool write with a follow-up emit could record one
    // without the other, and the feed must never lie.
    const client = transaction?.client ?? await this.pool.connect();
    let createdId: string;
    try {
      if (!transaction) await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO reports (title, content, content_hash, summary, tags, project_id, task_ids, author, author_actor_id, author_principal_id, origin, visibility, handover, pinned)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)
         RETURNING id, project_id, author_principal_id`,
        [
          data.title,
          data.content,
          ReportManager.computeContentHash(data.content),
          summary,
          data.tags || [],
          data.project_id || null,
          data.task_ids || [],
          // The unverified label defaults to the AUTHENTICATED identity, not to
          // the literal 'system' the column defaults to (card 91599cd2: every
          // Report a person filed through the API read "By system"). It stays
          // a free-form label the caller may set, and stays UNVERIFIED - what
          // changed is that its default is no longer a lie.
          data.author || data.author_actor_id || 'system',
          data.author_actor_id || null,
          // The OWNER column the shared predicate reads. Without it the
          // author of a `private` Report could not read their own Report
          // (review 302a338f B3): the decision is fail-closed, so nothing
          // escalated, but the seam this card touches was answering wrongly.
          data.author_principal_id || null,
          data.origin || 'api',
          data.visibility || 'default',
          data.handover == null ? null : JSON.stringify(data.handover),
          data.pinned || false,
        ]
      );
      createdId = result.rows[0].id;
      await feedEventService.emit(client, {
        name: 'report.created',
        actorPrincipalId: transaction?.actor.principalId ?? null,
        actorHandle: transaction?.actor.handle ?? null,
        objectType: 'report',
        objectId: createdId,
        projectId: result.rows[0]?.project_id ?? null,
        ownerPrincipalId: this.ownerPrincipalId(result.rows[0]),
        payload: {},
      });
      if (!transaction) await client.query('COMMIT');
    } catch (error) {
      if (!transaction) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (!transaction) client.release();
    }

    const report = await this.getById(createdId, {}, transaction?.client ?? this.pool);
    const announce = () => { console.log('[ReportManager] Created report:', report!.id, report!.title); };
    if (transaction) transaction.afterCommit(announce); else announce();
    return report!;
  }

  /**
   * Update an existing report (partial update)
   */
  async update(id: string, data: ReportUpdateData): Promise<Report | null> {
    // Check if report exists
    const existing = await this.getById(id);
    if (!existing) {
      return null;
    }

    // Archived reports are read-only (§4.4); unarchive first.
    if (existing.status === 'archived') {
      throw new Error('REPORT_ARCHIVED');
    }

    const fields: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    const addField = (column: string, value: any) => {
      fields.push(`${column} = $${paramIndex++}`);
      params.push(value);
    };

    if (data.title !== undefined) addField('title', data.title);
    if (data.content !== undefined) {
      addField('content', data.content);
      addField('content_hash', ReportManager.computeContentHash(data.content));
    }
    if (data.summary !== undefined) addField('summary', data.summary);
    if (data.tags !== undefined) addField('tags', data.tags);
    if (data.project_id !== undefined) addField('project_id', data.project_id);
    if (data.task_ids !== undefined) addField('task_ids', data.task_ids);
    if (data.author !== undefined) addField('author', data.author);
    if (data.visibility !== undefined) addField('visibility', data.visibility);
    if (data.handover !== undefined) {
      addField('handover', data.handover == null ? null : JSON.stringify(data.handover));
    }
    if (data.pinned !== undefined) addField('pinned', data.pinned);

    // Always update updated_at
    addField('updated_at', new Date().toISOString());

    if (fields.length === 0) {
      return existing;
    }

    params.push(id);
    // RH-P3.C1: same-transaction feed emission, riding the status-qualified
    // atomic gate below.
    const client = await this.pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await client.query(
        `UPDATE reports SET ${fields.join(', ')}
         WHERE id = $${paramIndex} AND deleted_at IS NULL AND status = 'active'
         RETURNING project_id, author_principal_id`,
        params
      );
      if ((result.rowCount ?? 0) > 0) {
        await feedEventService.emit(client, {
          name: 'report.updated',
          objectType: 'report',
          objectId: id,
          projectId: result.rows[0]?.project_id ?? null,
          ownerPrincipalId: this.ownerPrincipalId(result.rows[0]),
          payload: {},
        });
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    // The earlier read provides the existing API's missing/archived response,
    // but it is not the lifecycle gate: archive may commit after that read.
    // The status-qualified UPDATE is the atomic gate. Re-read only to classify
    // a zero-row result without turning an archived row into a 404.
    if (result.rowCount === 0) {
      const current = await this.getById(id);
      if (current?.status === 'archived') {
        throw new Error('REPORT_ARCHIVED');
      }
      return current;
    }

    const updated = await this.getById(id);
    console.log('[ReportManager] Updated report:', id);
    return updated;
  }

  /**
   * Archive: finished and filed (§4.4). Read-only while archived, excluded
   * from default lists, still readable and linkable. Reversible.
   */
  async archive(id: string): Promise<Report | null> {
    // RH-P3.C1 (round 1, F2): archival changes what every consumer sees, so
    // it announces itself like any other lifecycle write, same transaction.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE reports SET status = 'archived', updated_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL AND status = 'active'
         RETURNING project_id, author_principal_id`,
        [id]
      );
      if ((result.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        return null;
      }
      await feedEventService.emit(client, {
        name: 'report.updated',
        objectType: 'report',
        objectId: id,
        projectId: result.rows[0]?.project_id ?? null,
        ownerPrincipalId: this.ownerPrincipalId(result.rows[0]),
        payload: { status: 'archived' },
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    console.log('[ReportManager] Archived report:', id);
    return this.getById(id);
  }

  /**
   * Unarchive: return an archived report to active.
   */
  async unarchive(id: string): Promise<Report | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE reports SET status = 'active', updated_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL AND status = 'archived'
         RETURNING project_id, author_principal_id`,
        [id]
      );
      if ((result.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        return null;
      }
      await feedEventService.emit(client, {
        name: 'report.updated',
        objectType: 'report',
        objectId: id,
        projectId: result.rows[0]?.project_id ?? null,
        ownerPrincipalId: this.ownerPrincipalId(result.rows[0]),
        payload: { status: 'active' },
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    console.log('[ReportManager] Unarchived report:', id);
    return this.getById(id);
  }

  /**
   * Soft delete: tombstone the report (deleted_at = NOW()). Already-deleted
   * rows are not re-stamped — they behave as missing (false).
   */
  async softDelete(id: string): Promise<boolean> {
    // RH-P3.C1: soft and hard deletion both emit the content-free
    // report.deleted tombstone — either way the Report leaves every
    // consumer's view, and downstream indexes must drop it (§2.6.1).
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        'UPDATE reports SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING project_id, author_principal_id',
        [id]
      );
      if (result.rowCount === 0) {
        await client.query('ROLLBACK');
        return false;
      }
      await feedEventService.emit(client, {
        name: 'report.deleted',
        objectType: 'report',
        objectId: id,
        projectId: result.rows[0]?.project_id ?? null,
        ownerPrincipalId: this.ownerPrincipalId(result.rows[0]),
        payload: {},
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    console.log('[ReportManager] Soft-deleted report:', id);
    return true;
  }

  /**
   * Hard delete: destroy the row. Route layer restricts this to the
   * dashboard_user identity (?hard=true escape hatch). Works on tombstoned
   * rows too, so soft-deleted reports can still be purged.
   */
  async hardDelete(id: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        'DELETE FROM reports WHERE id = $1 RETURNING project_id, author_principal_id, deleted_at',
        [id]
      );
      if (result.rowCount === 0) {
        await client.query('ROLLBACK');
        return false;
      }
      // A row that was already soft-deleted has already emitted its
      // tombstone; re-emitting on the physical removal would double-announce
      // one disappearance.
      if (result.rows[0].deleted_at === null) {
        await feedEventService.emit(client, {
          name: 'report.deleted',
          objectType: 'report',
          objectId: id,
          projectId: result.rows[0]?.project_id ?? null,
          ownerPrincipalId: this.ownerPrincipalId(result.rows[0]),
          payload: {},
        });
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    console.log('[ReportManager] Hard-deleted report:', id);
    return true;
  }

  /** @deprecated Destructive path kept for compatibility; prefer softDelete/hardDelete. */
  async delete(id: string): Promise<boolean> {
    return this.hardDelete(id);
  }

  /**
   * RH-P3.C5 — the Brief compiler's batched Report projection: exactly the
   * fields the compiled reference section renders, one query for the whole
   * id set. Tombstoned rows are excluded; archived Reports stay included —
   * archival means finished-and-filed, still readable and linkable (§4.4),
   * and a Task's handover Report is very often archived.
   */
  async getBriefProjections(ids: string[]): Promise<Array<{
    id: string;
    title: string;
    status: 'active' | 'archived';
    summary: string | null;
    content: string;
    content_hash: string | null;
    handover: ReportHandover | null;
  }>> {
    if (ids.length === 0) return [];
    const result = await this.pool.query(
      `SELECT id, title, status, summary, content, content_hash, handover
         FROM reports
        WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
        ORDER BY created_at DESC, id`,
      [ids]
    );
    return result.rows.map((row: any) => ({
      id: String(row.id),
      title: String(row.title ?? ''),
      status: row.status === 'archived' ? 'archived' : 'active',
      summary: row.summary ?? null,
      content: String(row.content ?? ''),
      content_hash: row.content_hash ?? null,
      handover: normalizeReportHandover(row.handover),
    }));
  }

  /**
   * The id and provenance of every live Report — the smallest shape the
   * visibility rule reads. Excludes tombstones.
   *
   * This REPLACES `getCount()`, which returned `SELECT COUNT(*) FROM reports`
   * and was served straight to every caller as the dashboard's `reportCount`
   * (card 72258a60). A total is a disclosure, and there is no narrowing that
   * can be applied to a number after it has been counted. The count now comes
   * from `ReportVisibility.countVisibleReports`, which runs the same three
   * narrowings `GET /reports` runs over these rows — so no surface can report
   * a Report that another surface withholds.
   */
  async listVisibilityRows(): Promise<Array<{
    id: string;
    auto_promoted: boolean;
    source_task_id: string | null;
    source_outpost_visibility_tier: string | null;
  }>> {
    const result = await this.pool.query(
      // `status = 'active'` matches the DEFAULT `GET /reports` listing, which
      // excludes archived rows (review 302a338f: the count and the list could
      // disagree about an archived Report). The count and the list answer the
      // same question about the same population, or one of them is wrong.
      `SELECT id, auto_promoted, source_task_id, source_outpost_visibility_tier
         FROM reports
        WHERE deleted_at IS NULL AND status = 'active'`,
    );
    return result.rows.map((row: any) => ({
      id: String(row.id),
      auto_promoted: row.auto_promoted === true,
      source_task_id: row.source_task_id || null,
      source_outpost_visibility_tier: row.source_outpost_visibility_tier || null,
    }));
  }

  /**
   * Generate a summary from content (first 500 chars, trimmed to last word boundary)
   */
  private generateSummary(content: string): string {
    const max = REPORT_TEXT_LIMITS.summary;
    if (content.length <= max) {
      return content.replace(/\n/g, ' ').trim();
    }

    // Strip markdown formatting for cleaner summary
    let plain = content
      .replace(/^#{1,6}\s+/gm, '')     // headers
      .replace(/\*\*(.+?)\*\*/g, '$1') // bold
      .replace(/\*(.+?)\*/g, '$1')     // italic
      .replace(/`(.+?)`/g, '$1')       // inline code
      .replace(/\n/g, ' ')             // newlines
      .trim();

    if (plain.length <= max) {
      return plain;
    }

    // Trim to the last word boundary, reserving room for the ellipsis so the
    // result still fits the column: without the reservation this returned up
    // to max + 3 characters and the insert failed as a bare 500.
    const ellipsis = '...';
    const budget = max - ellipsis.length;
    const trimmed = plain.substring(0, budget);
    const lastSpace = trimmed.lastIndexOf(' ');
    return (lastSpace > 400 ? trimmed.substring(0, lastSpace) : trimmed) + ellipsis;
  }
}

// Singleton instance
export const reportManager = new ReportManager();
