/**
 * NotificationHistoryService — the notification centre's read model and the
 * per-Account read state (card b1e3b16d, hub lane L2; design draft section C,
 * C.1; owner rulings E16, E17 and E44 Q4).
 *
 * WHERE THE ROWS COME FROM. Nothing here stores a notification. Every row is a
 * ledger row the board already writes:
 *   - task moves, stuck notices and review requests: `feed_events` (append-only,
 *     commit-ordered cursor; FeedEventService);
 *   - approval history: `approval_events` (098, 142);
 *   - skill version decisions: `skill_version_events` (083).
 * The only new state is what each principal has READ (migration 144):
 * `notification_reads` (one row per item marked read) and
 * `notification_read_marks` (a per-principal high-water mark, seeded at the
 * first deploy so old history is listed but not unread).
 *
 * WHO SEES WHAT. Every arm is narrowed IN THE QUERY, so a page is never short
 * and an unreadable object never yields a row or a title:
 *   - task rows ride the SHARED task predicate (`authorizedListScope`, the
 *     TaskHistoryService semi-join pattern) — the same condition
 *     `GET /tasks/:id` runs;
 *   - a `task.stuck` row stays ADDRESSED (strategy section 2.6.4; RH-P3.C8):
 *     only COALESCE(shepherd, creator, owner) of the task, or root, sees it,
 *     under every filter;
 *   - approval rows ride the approvals self-scope (`approvalSelfScopeCondition`,
 *     the predicate `GET /approvals` lists with) and reach LOGIN SESSIONS only,
 *     because the approvals surface refuses bearer credentials;
 *   - skill rows need skills:read, and draft/review transitions need the
 *     manage scopes `GET /skills/:id/versions` already requires for
 *     unpublished versions.
 *
 * "MY WORK" (E44 Q4, the default): a task row is mine when the task's owner,
 * Account owner, creator, claimant, shepherd or verifier is me or an identity
 * under me (my connectors and their agents do my work), or when its effective
 * account owner is a Group in which I hold the EDIT tier (a live manager or
 * owner row; AZ-A12 clause 13 — a plain member's Group ownership is not
 * counted, so a large Group does not flood every bell); an approval row when
 * one of my identities filed it or I acted on it; a skill row when one of my
 * identities wrote the version or acted on it. "Everything I can see" drops
 * that narrowing and nothing else.
 *
 * WHAT IS UNREAD. A row is read when its principal marked it read, when the
 * principal's mark covers it, when the principal did it themselves, or when it
 * is a request being filed (`approval.requested`, a skill version submitted for
 * review): a request that waits is counted ONCE, in "Needs your decision", and
 * never a second time as an unread notification.
 *
 * ORDER AND PAGING. Newest first by (occurred time in microseconds, item key),
 * keyset-paged with `before`, so a page never shifts when new rows arrive.
 */
import { pool as defaultPool } from '../db/connection';
import type { Pool } from 'pg';
import type { AuthorizationListScope } from './AuthorizationRepository';
import { approvalSelfScopeCondition } from './ApprovalService';
import { groupOwnerCondition } from '../utils/groupOwnerCondition';

/**
 * AZ-A12 clause 13 (card a9b1e69c): "My work" counts GROUP ownership at the
 * EDIT tier only — a Task whose effective account owner (its own, else its
 * Project's, the evaluator's COALESCE) is a Group in which the viewer holds a
 * live manager or owner row — so a large Group does not flood every member's
 * bell. A plain member's view of the same Task is under "Everything I can see".
 */
const MY_WORK_GROUP_OWNER =
  'COALESCE(tk.account_owner_principal_id, (SELECT my_work_project.owner_principal_id FROM projects my_work_project WHERE my_work_project.id = tk.project_id))';

export const NOTIFICATION_TYPES = ['status', 'stuck', 'review', 'approval', 'skill'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export type NotificationWho = 'mine' | 'all';

export const NOTIFICATION_PAGE_DEFAULT = 50;
export const NOTIFICATION_PAGE_MAX = 100;
/** The unread count is bounded: past this many the badge says "999+". */
export const NOTIFICATION_UNREAD_CEILING = 999;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** The item-key grammar migration 144's CHECK enforces, byte for byte. */
export const ITEM_KEY_PATTERN = new RegExp(`^(feed:[0-9]{1,19}|approval-event:${UUID}|skill-event:${UUID})$`);

export interface NotificationViewer {
  principalId: string;
  isRoot: boolean;
  /** A login session (cookie or dashboard JWT): only these read approval rows. */
  isSession: boolean;
  /** An administrator login session (AZ-A9 clause 6): the approvals self-scope widens by kind. */
  isAdministrator: boolean;
  canReadSkills: boolean;
  canManageSkills: boolean;
  /** The shared task predicate, as a list scope (`authorizedListScope(req, 'task', 'read')`). */
  taskScope: AuthorizationListScope<'task'>;
}

export interface NotificationQuery {
  /** Empty = every type. */
  types: NotificationType[];
  who: NotificationWho;
  unreadOnly: boolean;
  before: { us: string; key: string } | null;
  limit: number;
}

export interface NotificationItem {
  /** The item key: `feed:<cursor>`, `approval-event:<uuid>` or `skill-event:<uuid>`. */
  id: string;
  type: NotificationType;
  /**
   * The C8 event word. Task rows keep `status_changed` and `exception` (so
   * every existing reader renders them unchanged); the new rows say what they
   * are: `review_requested`, `approval`, `skill`.
   */
  event: 'status_changed' | 'exception' | 'review_requested' | 'approval' | 'skill';
  taskId: string | null;
  taskTitle: string | null;
  from: string | null;
  to: string | null;
  timestamp: string;
  read: boolean;
  actorHandle: string | null;
  exception?: { name: string; reason?: string };
  approvalId?: string;
  approvalKind?: string;
  approvalAction?: string;
  approvalStatus?: string;
  skillId?: string;
  skillName?: string;
  skillVersion?: number;
  /** The keyset position of this row: pass it back as `before` for the next page. */
  cursor: string;
}

export interface NotificationPage {
  notifications: NotificationItem[];
  /** `before` for the next page, or null when this is the last one. */
  nextCursor: string | null;
  hasMore: boolean;
}

/** Parse `before`: `<microseconds>.<item key>`. Anything else is null. */
export function parseBefore(value: unknown): { us: string; key: string } | null | 'invalid' {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return 'invalid';
  const dot = value.indexOf('.');
  if (dot <= 0) return 'invalid';
  const us = value.slice(0, dot);
  const key = value.slice(dot + 1);
  if (!/^[0-9]{1,19}$/.test(us) || !ITEM_KEY_PATTERN.test(key)) return 'invalid';
  return { us, key };
}

/**
 * WHO ACTED ON AN APPROVAL, as the viewer's history row says it (change-request
 * design sections 4.3 and 6, ratified by owner ruling E325: the requester's view
 * never carries the decider identity). A viewer on the REQUESTER side of an item
 * — the requester is the viewer or lies in its subtree, the self-approval case
 * (a) reading — sees the handle of its own identities' acts only; every other
 * act (the decision, a lapse or revert by the board) is listed with its action
 * and time and no actor. A decider-side viewer (root, an administrator, a scoped
 * decider) keeps the handle. Every kind alike, as every requester view does.
 */
export const APPROVAL_ACTOR_HANDLE = `CASE
                 WHEN ae.actor_principal_id IN (SELECT id FROM my_subtree) THEN ae.actor_handle
                 WHEN a.requester_principal_id IN (SELECT id FROM my_subtree) THEN NULL
                 ELSE ae.actor_handle END`;

/**
 * "MY WORK" for a task row (E44 Q4; AZ-A12 clause 13), over the task aliased
 * `tk`, a `my_subtree` CTE and the placeholder `me` bound to the viewer's
 * principal id. Exported (card 5854f0d6, Notifications and Timeline design
 * section 4.3): the Timeline's "My work" scope applies THIS rule, never a copy.
 */
export function myWorkTaskCondition(me: string): string {
  return `(
            tk.owner_principal_id IN (SELECT id FROM my_subtree)
         OR tk.account_owner_principal_id IN (SELECT id FROM my_subtree)
         OR tk.creator_principal_id IN (SELECT id FROM my_subtree)
         OR tk.shepherd_principal_id IN (SELECT id FROM my_subtree)
         OR tk.verifier_principal_id IN (SELECT id FROM my_subtree)
         OR ${groupOwnerCondition({ owner: MY_WORK_GROUP_OWNER, account: me, tier: 'edit' })}
         OR EXISTS (SELECT 1 FROM task_assignments ta WHERE ta.task_id = tk.id AND (
              ta.claimant_principal_id IN (SELECT id FROM my_subtree)
           OR ta.shepherd_principal_id IN (SELECT id FROM my_subtree)
           OR ta.verifier_principal_id IN (SELECT id FROM my_subtree))))`;
}

class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/**
 * One arm's "is this row read for the viewer": an explicit read row, the
 * viewer's mark, (with no mark) the viewer's own creation time, or one of the
 * arm's own reasons (`extras`: the viewer did it; it is a request being filed).
 * COALESCEd, because a NULL actor would otherwise make the whole disjunction
 * NULL and drop the row from BOTH the read and the unread sets.
 */
function readExpression(keySql: string, timeSql: string, markSql: string, extras: string[]): string {
  return `COALESCE((${extras.map((extra) => `(${extra})`).join(' OR ')}
            OR EXISTS (SELECT 1 FROM notification_reads nr WHERE nr.principal_id = v.id AND nr.item_key = ${keySql})
            OR ${markSql}
            OR (NOT v.has_mark AND ${timeSql} <= v.created_at)), FALSE)`;
}

interface BuildOptions {
  /** Restrict to ONE item (the mark-read visibility check). */
  key?: string;
  /**
   * Only rows that CAN be unread are wanted (the unread list, the unread
   * count, mark-all). A row at or below the viewer's mark is read whatever
   * else holds, so each arm skips it IN ITS OWN SCAN: the feed arm becomes a
   * range scan on the commit-ordered cursor past the mark, which is what keeps
   * the bell's 30-second poll from reading the whole board history. The result
   * is the same set; only the work changes.
   */
  unreadOnly?: boolean;
}

export class NotificationHistoryService {
  constructor(private readonly pool: Pool = defaultPool) {}

  /**
   * The unified items query: every arm the viewer may read under the filters,
   * each row carrying `read`. Returned as SQL text plus its parameters, so the
   * page read, the bounded unread count and the filtered mark-all write all run
   * the SAME narrowing — never three copies of it.
   */
  private build(viewer: NotificationViewer, query: Pick<NotificationQuery, 'types' | 'who'>, options: BuildOptions = {}):
    { sql: string; params: unknown[] } {
    const params = new Params();
    const me = params.add(viewer.principalId);
    const types = new Set<NotificationType>(query.types.length > 0 ? query.types : NOTIFICATION_TYPES);
    const mine = query.who === 'mine';
    const keyKind = options.key ? options.key.slice(0, options.key.indexOf(':')) : null;
    const keyValue = options.key ? options.key.slice(options.key.indexOf(':') + 1) : null;
    const wants = (arm: 'feed' | 'approval-event' | 'skill-event') => keyKind === null || keyKind === arm;

    const arms: string[] = [];

    // ── task rows: status moves, stuck notices, review requests ──────────────
    const taskNames: string[] = [];
    if (types.has('status')) {
      taskNames.push(`(fe.name = 'task.updated' AND fe.payload ? 'status'
        AND (fe.payload->>'status') IS DISTINCT FROM (fe.payload->>'previousStatus'))`);
    }
    if (types.has('stuck')) {
      // ADDRESSED (2.6.4 / C8): the shepherd, else the creator, else the
      // owner — or root. Computed from the task's CURRENT roles.
      taskNames.push(viewer.isRoot
        ? `(fe.name = 'task.stuck')`
        : `(fe.name = 'task.stuck' AND COALESCE(tk.shepherd_principal_id, tk.creator_principal_id, tk.owner_principal_id) = v.id)`);
    }
    if (types.has('review')) taskNames.push(`(fe.name = 'task.review_requested')`);
    if (taskNames.length > 0 && wants('feed')) {
      const narrowing = viewer.taskScope.render(params.values.length + 1);
      params.values.push(...narrowing.params);
      const keyClause = keyKind === 'feed' ? `AND fe.cursor = ${params.add(keyValue)}::bigint` : '';
      const mineClause = mine ? `AND ${myWorkTaskCondition(me)}` : '';
      arms.push(`
        SELECT 'feed:' || fe.cursor AS item_key,
               fe.occurred_at,
               (extract(epoch FROM fe.occurred_at) * 1000000)::bigint AS occurred_us,
               CASE fe.name WHEN 'task.stuck' THEN 'stuck' WHEN 'task.review_requested' THEN 'review' ELSE 'status' END AS type,
               ${readExpression(`('feed:' || fe.cursor)`, 'fe.occurred_at', '(v.has_mark AND fe.cursor <= v.feed_cursor)',
                 ['fe.actor_principal_id = v.id'])} AS read,
               tk.id AS task_id, tk.title AS task_title,
               fe.payload->>'previousStatus' AS from_status, fe.payload->>'status' AS to_status,
               fe.payload->>'reason' AS reason, fe.actor_handle AS actor_handle,
               NULL::uuid AS approval_id, NULL::text AS approval_kind, NULL::text AS approval_action, NULL::text AS approval_status,
               NULL::uuid AS skill_id, NULL::text AS skill_name, NULL::int AS skill_version
          FROM feed_events fe
          JOIN tasks tk ON tk.id = fe.object_id
         CROSS JOIN viewer v
         WHERE fe.object_type = 'task'
           AND (${taskNames.join(' OR ')})
           AND tk.id IN (
             SELECT ${viewer.taskScope.id} FROM ${viewer.taskScope.from} WHERE ${narrowing.sql})
           ${options.unreadOnly ? 'AND fe.cursor > (SELECT CASE WHEN has_mark THEN feed_cursor ELSE 0 END FROM viewer)' : ''}
           ${mineClause}
           ${keyClause}`);
    }

    // ── approval rows: the approvals self-scope, login sessions only ─────────
    if (types.has('approval') && viewer.isSession && wants('approval-event')) {
      const scopeParams: unknown[] = [];
      const scope = approvalSelfScopeCondition(
        { principalId: viewer.principalId, isRoot: viewer.isRoot, isAdministrator: viewer.isAdministrator },
        scopeParams, 'a', params.values.length,
      );
      params.values.push(...scopeParams);
      const titleScope = viewer.taskScope.render(params.values.length + 1);
      params.values.push(...titleScope.params);
      const keyClause = keyKind === 'approval-event' ? `AND ae.id = ${params.add(keyValue)}::uuid` : '';
      const mineClause = mine ? `AND (a.requester_principal_id IN (SELECT id FROM my_subtree)
           OR ae.actor_principal_id = v.id OR a.decided_by_principal_id = v.id)` : '';
      arms.push(`
        SELECT 'approval-event:' || ae.id AS item_key,
               ae.occurred_at,
               (extract(epoch FROM ae.occurred_at) * 1000000)::bigint AS occurred_us,
               'approval' AS type,
               ${readExpression(`('approval-event:' || ae.id)`, 'ae.occurred_at', '(v.has_mark AND ae.occurred_at <= v.others_through)',
                 [`ae.action = 'approval.requested'`, 'ae.actor_principal_id = v.id'])} AS read,
               atk.id AS task_id,
               CASE WHEN atk.id IS NOT NULL AND atk.id IN (
                 SELECT ${viewer.taskScope.id} FROM ${viewer.taskScope.from} WHERE ${titleScope.sql})
                 THEN atk.title END AS task_title,
               NULL::text AS from_status, NULL::text AS to_status, NULL::text AS reason,
               ${APPROVAL_ACTOR_HANDLE} AS actor_handle,
               a.id AS approval_id, a.kind AS approval_kind, ae.action AS approval_action, a.status AS approval_status,
               NULL::uuid AS skill_id, NULL::text AS skill_name, NULL::int AS skill_version
          FROM approval_events ae
          JOIN approvals a ON a.id = ae.approval_id
          LEFT JOIN tasks atk ON atk.id = COALESCE(a.target_task_id, a.related_task_id)
         CROSS JOIN viewer v
         WHERE ${scope ?? 'TRUE'}
           ${options.unreadOnly ? 'AND ae.occurred_at > (SELECT others_through FROM viewer)' : ''}
           ${mineClause}
           ${keyClause}`);
    }

    // ── skill rows: version decisions ────────────────────────────────────────
    if (types.has('skill') && viewer.canReadSkills && wants('skill-event')) {
      const keyClause = keyKind === 'skill-event' ? `AND e.id = ${params.add(keyValue)}::uuid` : '';
      const mineClause = mine ? `AND (sv.created_by_principal_id IN (SELECT id FROM my_subtree)
           OR e.actor_principal_id IN (SELECT id FROM my_subtree))` : '';
      // Unpublished versions are visible only to the manage scopes, exactly as
      // GET /skills/:id/versions lists them (routes/skills.ts canManage).
      const statusClause = viewer.canManageSkills ? '' : `AND e.status IN ('published', 'retired')`;
      arms.push(`
        SELECT 'skill-event:' || e.id AS item_key,
               e.created_at AS occurred_at,
               (extract(epoch FROM e.created_at) * 1000000)::bigint AS occurred_us,
               'skill' AS type,
               ${readExpression(`('skill-event:' || e.id)`, 'e.created_at', '(v.has_mark AND e.created_at <= v.others_through)',
                 [`e.status = 'review'`, 'e.actor_principal_id = v.id'])} AS read,
               NULL::uuid AS task_id, NULL::text AS task_title,
               prev.status AS from_status, e.status AS to_status, NULL::text AS reason, ap.handle AS actor_handle,
               NULL::uuid AS approval_id, NULL::text AS approval_kind, NULL::text AS approval_action, NULL::text AS approval_status,
               s.id AS skill_id, s.name AS skill_name, sv.version AS skill_version
          FROM skill_version_events e
          JOIN skill_versions sv ON sv.id = e.skill_version_id
          JOIN skills s ON s.id = sv.skill_id
          LEFT JOIN principals ap ON ap.id = e.actor_principal_id
          JOIN LATERAL (
            SELECT e2.status FROM skill_version_events e2
             WHERE e2.skill_version_id = e.skill_version_id AND e2.sequence < e.sequence
             ORDER BY e2.sequence DESC LIMIT 1
          ) prev ON TRUE
         CROSS JOIN viewer v
         WHERE TRUE
           ${options.unreadOnly ? 'AND e.created_at > (SELECT others_through FROM viewer)' : ''}
           ${statusClause}
           ${mineClause}
           ${keyClause}`);
    }

    const items = arms.length > 0
      ? arms.join('\n UNION ALL \n')
      : `SELECT NULL::text AS item_key, NULL::timestamptz AS occurred_at, NULL::bigint AS occurred_us, NULL::text AS type,
                NULL::boolean AS read, NULL::uuid AS task_id, NULL::text AS task_title, NULL::text AS from_status,
                NULL::text AS to_status, NULL::text AS reason, NULL::text AS actor_handle, NULL::uuid AS approval_id,
                NULL::text AS approval_kind, NULL::text AS approval_action, NULL::text AS approval_status,
                NULL::uuid AS skill_id, NULL::text AS skill_name, NULL::int AS skill_version
          WHERE FALSE`;

    const sql = `
      WITH RECURSIVE my_subtree(id) AS (
        SELECT id FROM principals WHERE id = ${me}::uuid
        UNION
        SELECT c.id FROM principals c JOIN my_subtree s ON c.parent_principal_id = s.id
      ),
      viewer AS (
        SELECT p.id, p.created_at,
               (m.principal_id IS NOT NULL) AS has_mark,
               COALESCE(m.feed_cursor, 0) AS feed_cursor,
               COALESCE(m.others_through, p.created_at) AS others_through
          FROM principals p
          LEFT JOIN notification_read_marks m ON m.principal_id = p.id
         WHERE p.id = ${me}::uuid
      ),
      items AS (${items})`;
    return { sql, params: params.values };
  }

  /** One page of the history, newest first. */
  async list(viewer: NotificationViewer, query: NotificationQuery): Promise<NotificationPage> {
    const { sql, params } = this.build(viewer, query, { unreadOnly: query.unreadOnly });
    const values = [...params];
    const clauses: string[] = [];
    if (query.unreadOnly) clauses.push('NOT items.read');
    if (query.before) {
      values.push(query.before.us, query.before.key);
      clauses.push(`(items.occurred_us, items.item_key) < ($${values.length - 1}::bigint, $${values.length}::text)`);
    }
    const limit = Math.min(Math.max(Math.trunc(query.limit) || NOTIFICATION_PAGE_DEFAULT, 1), NOTIFICATION_PAGE_MAX);
    values.push(limit + 1);
    const result = await this.pool.query(
      `${sql}
       SELECT * FROM items
        ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY items.occurred_us DESC, items.item_key DESC
        LIMIT $${values.length}`,
      values,
    );
    const rows = result.rows.slice(0, limit);
    const hasMore = result.rows.length > limit;
    const notifications = rows.map(mapItem);
    return {
      notifications,
      hasMore,
      nextCursor: hasMore && notifications.length > 0 ? notifications[notifications.length - 1].cursor : null,
    };
  }

  /** The unread count for the filters, bounded at NOTIFICATION_UNREAD_CEILING + 1. */
  async unreadCount(viewer: NotificationViewer, query: Pick<NotificationQuery, 'types' | 'who'>): Promise<number> {
    const { sql, params } = this.build(viewer, query, { unreadOnly: true });
    const values = [...params, NOTIFICATION_UNREAD_CEILING + 1];
    const result = await this.pool.query(
      `${sql}
       SELECT count(*)::int AS unread FROM (SELECT 1 FROM items WHERE NOT items.read LIMIT $${values.length}) bounded`,
      values,
    );
    return Number(result.rows[0]?.unread ?? 0);
  }

  /**
   * Mark ONE item read for this principal. The item must be one the viewer
   * can see right now under "Everything I can see"; anything else answers
   * false, and the route answers it exactly as an absent item.
   */
  async markRead(viewer: NotificationViewer, key: string): Promise<boolean> {
    if (!ITEM_KEY_PATTERN.test(key)) return false;
    const { sql, params } = this.build(viewer, { types: [], who: 'all' }, { key });
    const values = [...params, viewer.principalId, key];
    const result = await this.pool.query(
      `${sql}
       , visible AS (SELECT item_key FROM items WHERE items.item_key = $${values.length})
       , written AS (
         INSERT INTO notification_reads (principal_id, item_key)
         SELECT $${values.length - 1}::uuid, item_key FROM visible
         ON CONFLICT (principal_id, item_key) DO NOTHING
         RETURNING 1)
       SELECT (SELECT count(*) FROM visible)::int AS visible`,
      values,
    );
    return Number(result.rows[0]?.visible ?? 0) > 0;
  }

  /**
   * Mark everything read for this principal, within the filters.
   *
   *  - FILTERED (a type, or "My work"): one read row per item the viewer can
   *    see and has not read, under exactly those filters — nothing outside the
   *    filter, nothing the viewer cannot see, and nobody else's state.
   *  - UNFILTERED ("Everything I can see", every type): the principal's mark
   *    moves to the current feed head and the current time, so everything that
   *    happened before now reads as read for them — including rows on objects
   *    they are granted later. No other principal's mark moves.
   */
  async markAllRead(viewer: NotificationViewer, query: Pick<NotificationQuery, 'types' | 'who'>): Promise<number> {
    const unfiltered = query.who === 'all' && (query.types.length === 0 || query.types.length === NOTIFICATION_TYPES.length);
    const { sql, params } = this.build(viewer, query, { unreadOnly: true });
    const values = [...params, viewer.principalId];
    const counted = await this.pool.query(
      `${sql}
       , unread AS (SELECT item_key FROM items WHERE NOT items.read)
       , written AS (
         INSERT INTO notification_reads (principal_id, item_key)
         SELECT $${values.length}::uuid, item_key FROM unread
         ${unfiltered ? 'WHERE FALSE' : ''}
         ON CONFLICT (principal_id, item_key) DO NOTHING
         RETURNING 1)
       SELECT (SELECT count(*) FROM unread)::int AS unread`,
      values,
    );
    if (unfiltered) {
      await this.pool.query(
        `INSERT INTO notification_read_marks (principal_id, feed_cursor, others_through, updated_at)
         VALUES ($1, COALESCE((SELECT max(cursor) FROM feed_events), 0), now(), now())
         ON CONFLICT (principal_id) DO UPDATE
           SET feed_cursor = GREATEST(notification_read_marks.feed_cursor, EXCLUDED.feed_cursor),
               others_through = GREATEST(notification_read_marks.others_through, EXCLUDED.others_through),
               updated_at = now()`,
        [viewer.principalId],
      );
    }
    return Number(counted.rows[0]?.unread ?? 0);
  }
}

function eventFor(row: any): NotificationItem['event'] {
  if (row.type === 'stuck') return 'exception';
  if (row.type === 'review') return 'review_requested';
  if (row.type === 'approval') return 'approval';
  if (row.type === 'skill') return 'skill';
  return 'status_changed';
}

function mapItem(row: any): NotificationItem {
  const item: NotificationItem = {
    id: String(row.item_key),
    type: row.type,
    event: eventFor(row),
    taskId: row.task_id ? String(row.task_id) : null,
    taskTitle: row.task_title === null || row.task_title === undefined ? null : String(row.task_title),
    from: row.from_status ?? null,
    to: row.to_status ?? null,
    timestamp: new Date(row.occurred_at).toISOString(),
    read: row.read === true,
    actorHandle: row.actor_handle ?? null,
    cursor: `${row.occurred_us}.${row.item_key}`,
  };
  if (row.type === 'stuck') {
    item.exception = { name: 'task.stuck', ...(row.reason ? { reason: String(row.reason) } : {}) };
  }
  if (row.type === 'approval') {
    item.approvalId = String(row.approval_id);
    item.approvalKind = String(row.approval_kind ?? 'agent-mint');
    item.approvalAction = String(row.approval_action);
    item.approvalStatus = String(row.approval_status);
  }
  if (row.type === 'skill') {
    item.skillId = String(row.skill_id);
    item.skillName = String(row.skill_name);
    item.skillVersion = Number(row.skill_version);
  }
  return item;
}

export const notificationHistoryService = new NotificationHistoryService();
