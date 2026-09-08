import type { PoolClient } from 'pg';
// TaskHistoryService.ts - Track task changes in the database for activity feed
import { pool } from '../db/connection';
import { logCaughtFailure } from '../utils/secretSafeLog';
import type { AuthorizationListScope } from './AuthorizationRepository';

export interface TaskHistoryEvent {
  type: string;
  taskId: string;
  taskTitle: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  changedBy: string;
  timestamp: string;
}

/** Request actor threaded from routes into task writers (spec b48bb799 §2.5). */
export interface TaskActor {
  principalId: string | null;
  handle: string;
  role?: string;
  authMethod?: import('./AuditService').AuditAuthMethod;
  credentialId?: string | null;
  /**
   * RH-P3.AZ-S7: the ASSIGNER's authorization identity, carried so the
   * assignment-access coupling can apply the R3 non-escalation cap
   * (ruling 7440b579) at the TaskManagerDB choke point. Required only for
   * a write that SETS an execution assignment; every other task write
   * ignores it.
   */
  authorization?: import('./AuthorizationService').AuthorizationActor;
}

/** How long a pre-063 task_history schema read stays trusted. */
const COLUMN_CACHE_TTL_MS = 60_000;

class TaskHistoryService {
  private columnCache: Set<string> | null = null;
  private columnCacheAt = 0;

  private async getColumns(queryable: PoolClient | typeof pool = pool): Promise<Set<string>> {
    // The cache is time-bounded rather than permanent. Migrations apply to a
    // RUNNING container (CB-3 deploys code, then applies 062/063), so a
    // permanently pinned pre-063 column set would silently drop actor
    // attribution until someone restarted the process. An empty set is never
    // cached at all: that means the inspection failed, and caching it would
    // disable history recording entirely. Once the actor column is present the
    // schema is final for this change, so the cache stops expiring.
    const fresh = this.columnCache
      && (this.columnCache.has('actor_principal_id') || Date.now() - this.columnCacheAt < COLUMN_CACHE_TTL_MS);
    if (fresh) return this.columnCache!;
    try {
      // to_regclass follows the full search_path, matching how the INSERTs
      // below resolve the table. current_schema() names only the FIRST
      // existing schema, so a role-named schema would yield an empty column
      // set — which reads here as "no table" and silently stops all history
      // recording.
      const result = await queryable.query(
        `SELECT attname AS column_name FROM pg_attribute
          WHERE attrelid = to_regclass('task_history') AND attnum > 0 AND NOT attisdropped`
      );
      const columns = new Set(result.rows.map((row: any) => String(row.column_name)));
      if (columns.size > 0) {
        this.columnCache = columns;
        this.columnCacheAt = Date.now();
      }
      return columns;
    } catch (err) {
      if (queryable !== pool) throw err;
      logCaughtFailure('[TaskHistoryService] schema inspection failed', err);
      return this.columnCache ?? new Set();
    }
  }

  /**
   * Record a task change in the history table.
   * Supports both the newer task_history schema and the older live compatibility schema.
   */
  async recordChange(
    taskId: string,
    taskTitle: string,
    field: string,
    oldValue: string | null,
    newValue: string | null,
    changedBy: string = 'system',
    actorPrincipalId: string | null = null,
    client?: PoolClient
  ): Promise<void> {
    try {
      const columns = await this.getColumns(client ?? pool);
      if (client && (!columns.has('actor_principal_id') || !(columns.has('event_type') || columns.has('task_title') && columns.has('field') && columns.has('changed_by')))) throw new Error('Atomic creation requires attributed task history');
      if (columns.size === 0) return;

      // actor_principal_id (migration 063) is the authoritative actor record;
      // the handle stays in changed_by / the note for display. Column-sniffed
      // like the variants below so pre-migration DBs keep working.
      const withActorColumn = columns.has('actor_principal_id');

      if (columns.has('task_title') && columns.has('field') && columns.has('changed_by')) {
        if (withActorColumn) {
          await (client ?? pool).query(
            `INSERT INTO task_history (task_id, task_title, field, old_value, new_value, changed_by, actor_principal_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [taskId, taskTitle, field, oldValue, newValue, changedBy, actorPrincipalId]
          );
        } else {
          await (client ?? pool).query(
            `INSERT INTO task_history (task_id, task_title, field, old_value, new_value, changed_by)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [taskId, taskTitle, field, oldValue, newValue, changedBy]
          );
        }
        return;
      }

      if (columns.has('event_type')) {
        const note = [`field=${field}`, changedBy ? `changedBy=${changedBy}` : null].filter(Boolean).join(' | ');
        if (withActorColumn) {
          await (client ?? pool).query(
            `INSERT INTO task_history (task_id, event_type, old_value, new_value, note, actor_principal_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [taskId, field, oldValue, newValue, note || null, actorPrincipalId]
          );
        } else {
          await (client ?? pool).query(
            `INSERT INTO task_history (task_id, event_type, old_value, new_value, note)
             VALUES ($1, $2, $3, $4, $5)`,
            [taskId, field, oldValue, newValue, note || null]
          );
        }
      }
    } catch (err) {
      if (client) throw err;
      // Don't let history tracking break the main flow
      logCaughtFailure('[TaskHistoryService] change recording failed', err);
    }
  }

  /**
   * Newest status→archived transition's prior value for a Task, or null.
   * Variant-aware like recordChange above: the newer schema records the
   * changed field in , the older live-compatibility schema in
   *  (candidate A2; DEV runs the older variant — a query pinned
   * to  silently degraded every unarchive to the fallback).
   */
  async priorStatusBeforeArchive(taskId: string): Promise<string | null> {
    try {
      const columns = await this.getColumns();
      if (columns.size === 0) return null;
      const fieldColumn = columns.has('field') ? 'field' : (columns.has('event_type') ? 'event_type' : null);
      if (!fieldColumn) return null;
      const result = await pool.query(
        `SELECT old_value FROM task_history
         WHERE task_id = $1 AND ${fieldColumn} = 'status' AND new_value = 'archived'
         ORDER BY created_at DESC
         LIMIT 1`,
        [taskId]
      );
      const prior = result.rows[0]?.old_value;
      return typeof prior === 'string' ? prior : null;
    } catch (err) {
      logCaughtFailure('[TaskHistoryService] prior-status lookup failed', err);
      return null;
    }
  }

  /**
   * Get recent activity events.
   * Reads whichever task_history variant exists and joins tasks for titles when needed.
   */
  async getRecentActivity(
    limit: number,
    authorization: AuthorizationListScope<'task'>,
  ): Promise<TaskHistoryEvent[]> {
    try {
      const columns = await this.getColumns();
      if (columns.size === 0) return [];

      // The authority over a history row is the authority over the TASK it
      // describes, so the narrowing is a semi-join against the shared Task
      // predicate — the same `sqlCondition` `GET /tasks/:id` runs, never a
      // second copy. It sits in the WHERE and not in a post-read loop for two
      // reasons: the feed discloses task ids, full task TITLES and the acting
      // handle (card 72258a60), and `ORDER BY … LIMIT` applied before a
      // narrowing would hand a caller the estate's newest N rows and then
      // show them the few they may read, instead of THEIR newest N.
      //
      // Cast and fold to text on both sides: the base schema types
      // `task_history.task_id` as UUID, the older live-compatibility variant
      // (migration 013) as VARCHAR(255), and `lower()` is a no-op on the
      // canonical rendering a uuid column produces.
      //
      // A history row whose Task no longer exists matches nothing and is
      // withheld. That is the fail-closed answer: there is no row left to
      // authorize the disclosure of its title.
      const narrowing = authorization.render(2);
      const authorizedTaskIds = `lower(th.task_id::text) IN (
        SELECT lower(${authorization.id}::text) FROM ${authorization.from} WHERE ${narrowing.sql}
      )`;

      if (columns.has('task_title') && columns.has('field') && columns.has('changed_by')) {
        const result = await pool.query(
          `SELECT th.task_id, th.task_title, th.field, th.old_value, th.new_value, th.changed_by, th.created_at
           FROM task_history th
           WHERE ${authorizedTaskIds}
           ORDER BY th.created_at DESC
           LIMIT $1`,
          [limit, ...narrowing.params]
        );

        return result.rows.map((row: any) => ({
          type: this.getEventType(row.field),
          taskId: row.task_id,
          taskTitle: row.task_title,
          field: row.field,
          oldValue: row.old_value,
          newValue: row.new_value,
          changedBy: row.changed_by,
          timestamp: row.created_at.toISOString(),
        }));
      }

      if (columns.has('event_type')) {
        const result = await pool.query(
          `SELECT th.task_id, COALESCE(tk.title, th.task_id::text) AS task_title,
                  th.event_type, th.old_value, th.new_value, th.note, th.created_at
           FROM task_history th
           LEFT JOIN tasks tk ON tk.id = th.task_id
           WHERE ${authorizedTaskIds}
           ORDER BY th.created_at DESC
           LIMIT $1`,
          [limit, ...narrowing.params]
        );

        return result.rows.map((row: any) => ({
          type: this.getEventType(row.event_type),
          taskId: row.task_id,
          taskTitle: row.task_title,
          field: row.event_type,
          oldValue: row.old_value,
          newValue: row.new_value,
          changedBy: this.parseChangedBy(row.note),
          timestamp: row.created_at.toISOString(),
        }));
      }

      return [];
    } catch (err) {
      logCaughtFailure('[TaskHistoryService] activity fetch failed', err);
      return [];
    }
  }

  private parseChangedBy(note: string | null | undefined): string {
    const match = String(note || '').match(/changedBy=([^|]+)/);
    return match?.[1]?.trim() || 'system';
  }

  /**
   * Map field name to event type
   */
  private getEventType(field: string): string {
    switch (field) {
      case 'status': return 'status_change';
      case 'priority': return 'priority_change';
      case 'title': return 'title_change';
      case 'subtask': return 'subtask_update';
      default: return 'field_change';
    }
  }
}

export const taskHistoryService = new TaskHistoryService();
