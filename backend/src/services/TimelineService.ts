/**
 * TimelineService — "everything you can see, newest first" (Notifications and
 * Timeline design, Slice A; card 5854f0d6; owner ruling E394, choices C4-C9).
 *
 * THE SPINE is `feed_events` (091): append-only, commit-ordered by `cursor`.
 * The rows shown are a WHITELIST of feed names (TIMELINE_FEED_NAMES); every
 * other name is excluded, including `task.ready` (a go signal for the Assignee
 * alone) and every `*.deleted` tombstone. Access changes (`*.acl_changed`) are
 * listed only when asked for (choice C4). Two windowed arms join it: approval
 * ledger rows (`approval_events`, login sessions only; choice C5) and skill
 * version decisions (`skill_version_events`: published, returned, retired).
 *
 * AUTHORIZATION IS IN THE QUERY (design section 4.5), never a post-filter, so a
 * page is never short and a row the caller may not read never yields a title.
 * Each object type's arm carries the caller's scope CEILING for that type (an
 * arm whose ceiling the caller lacks is omitted) and that type's LIST SCOPE,
 * the shared predicate `authorizedListScope` renders, in correlated EXISTS
 * form. Reports add `reportVisibilitySql` (soft delete, promoted, outpost);
 * Skills add the `GET /skills` catalogue rule (`draftVisibilitySql`); skill
 * version rows the R2-B2 rule; approval rows `approvalSelfScopeCondition` and
 * the E325 requester-side actor withholding (`APPROVAL_ACTOR_HANDLE`).
 *
 * PAGING (design section 4.1). The feed arm pages by keyset on `cursor DESC`:
 * cursor order is commit order, so a row written between page reads lands
 * above the reader and is never skipped. Approval and skill-version rows are
 * slotted by TIME WINDOWS the opaque token carries: page N lists them with
 * `time < before` and `time >= floorN`, where floorN = LEAST(before, the oldest
 * feed row on page N) or -infinity when the feed has no more rows; the next
 * token carries floorN, so the floor never rises and each such row is on
 * exactly one page. When the feed arm returns no row (filtered out, or nothing
 * visible), each windowed arm pages on its own `(time, id)` keyset capped at the
 * page size (R2-N1). A row committed after page 1 with a time inside a window
 * already served appears after a refresh, never mid-scroll.
 *
 * Times travel as microsecond UTC text so a window bound is exact; a JS Date
 * would drop the microseconds and lose rows at a boundary.
 *
 * THE TEXT SEARCH (`q`, owner ruling E453 on the Action Center): a row matches
 * when its object's title or its own label holds the text, case-insensitively,
 * with the caller's own wildcards taken literally. It is a conjunct of the SAME
 * statement as the arms, before the LIMIT (section 4.5: never a post-filter, so
 * a searched page is never short), and it only narrows: every row is still
 * admitted by its own arm, so a title matches only on an object the caller may
 * already read. On an approval row the only title is the Task's, matched only
 * through the task list scope, exactly as it is shown.
 */
import { pool as defaultPool } from '../db/connection';
import type { Pool } from 'pg';
import type { AuthorizationListScope } from './AuthorizationRepository';
import { approvalSelfScopeCondition } from './ApprovalService';
import { APPROVAL_ACTOR_HANDLE, myWorkTaskCondition } from './NotificationHistoryService';
import { reportVisibilitySql } from './ReportVisibility';
import { draftVisibilitySql, type SkillViewer } from './SkillManager';

/** The type filter's values, one per Timeline label. */
export const TIMELINE_TYPES = [
  'task', 'status', 'update', 'stuck', 'review', 'report', 'phase', 'project', 'skill',
  'skill-version', 'approval', 'access',
] as const;
export type TimelineType = (typeof TIMELINE_TYPES)[number];

/** The feed names each feed-backed type shows: the whitelist, and nothing else. */
export const TIMELINE_FEED_NAMES: Readonly<Record<Exclude<TimelineType, 'skill-version' | 'approval'>, readonly string[]>> = {
  task: ['task.created', 'task.archived'],
  status: ['task.updated'],
  update: ['task.updated'],
  stuck: ['task.stuck'],
  review: ['task.review_requested'],
  report: ['report.created', 'report.updated'],
  phase: ['phase.created', 'phase.updated'],
  project: ['project.updated'],
  skill: ['skill.created', 'skill.updated'],
  access: ['task.acl_changed', 'report.acl_changed', 'phase.acl_changed', 'project.acl_changed', 'skill.acl_changed'],
};

/** The plain-words label of each type (design section 4.1). */
export const TIMELINE_LABELS: Readonly<Record<TimelineType, string>> = {
  task: 'Task created or archived',
  status: 'Status moved',
  update: 'Task updated',
  stuck: 'Stuck',
  review: 'Review requested',
  report: 'Report',
  phase: 'Phase',
  project: 'Project',
  skill: 'Skill',
  'skill-version': 'Skill version decided',
  approval: 'Approval',
  access: 'Access changed',
};

export const TIMELINE_PAGE_DEFAULT = 50;
export const TIMELINE_PAGE_MAX = 100;
/** E453: the longest search text `q` takes (after trimming). */
export const TIMELINE_SEARCH_MAX = 100;

/** The ILIKE pattern of a search text: the caller's own `%`, `_` and backslash match themselves (ESCAPE backslash). */
export function timelineSearchPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

/** The types whose Timeline label holds the search text, case-insensitively. */
export function timelineLabelMatches(q: string): Set<TimelineType> {
  const needle = q.toLowerCase();
  return new Set(TIMELINE_TYPES.filter((type) => TIMELINE_LABELS[type].toLowerCase().includes(needle)));
}

/**
 * THE TIMELINE'S READ TRANSACTION. Every statement of one Timeline read runs
 * in ONE read-only transaction (one snapshot for the feed, the windowed arms
 * and the head) under two transaction-scoped settings, never pool-global
 * state:
 *
 *   jit = off            the arms' authorization predicates are large
 *                        expressions whose ESTIMATED cost grows with the
 *                        board (correlated subplans priced per feed row), far
 *                        past PostgreSQL's JIT thresholds, while the read
 *                        itself takes milliseconds. Measured on a board of
 *                        100,000 feed rows, compiling one statement took
 *                        about seven seconds against tens of milliseconds
 *                        without JIT. (A full-tier run also saw a backend die
 *                        with signal 11 inside such a statement; with JIT off
 *                        that code path is never entered.) The precedent is
 *                        the metrics scrape and the authority preview (card
 *                        3471b8bf).
 *   statement_timeout    a ceiling on any one statement, so a plan that goes
 *                        bad fails one request (503, TIMELINE_READ_TIMEOUT)
 *                        instead of holding a connection and a backend.
 */
export const TIMELINE_STATEMENT_TIMEOUT_MS = 5000;
export const TIMELINE_TRANSACTION_SETTINGS: readonly string[] = [
  'SET LOCAL jit = off',
  `SET LOCAL statement_timeout = '${TIMELINE_STATEMENT_TIMEOUT_MS}ms'`,
];

/** One statement runner: a client inside the Timeline's transaction. */
export interface TimelineDb {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/** A statement the Timeline cancelled at its own ceiling (SQLSTATE 57014, query_canceled). */
export function isTimelineTimeout(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === '57014');
}

/** A status move: a `task.updated` whose payload moves the status. */
const STATUS_MOVE = `(fe.payload ? 'status' AND (fe.payload->>'status') IS DISTINCT FROM (fe.payload->>'previousStatus'))`;

/** The feed rows whose LABEL is one of `types`: a predicate on the row's own name and payload (constants only). */
function feedLabelSql(types: Set<TimelineType>): string {
  const parts: string[] = [];
  for (const type of types) {
    if (type === 'status') parts.push(`(fe.name = 'task.updated' AND ${STATUS_MOVE})`);
    else if (type === 'update') parts.push(`(fe.name = 'task.updated' AND NOT ${STATUS_MOVE})`);
    else {
      const names = (TIMELINE_FEED_NAMES as Record<string, readonly string[] | undefined>)[type] ?? [];
      if (names.length > 0) parts.push(`fe.name IN (${names.map((name) => `'${name}'`).join(', ')})`);
    }
  }
  return parts.length > 0 ? `(${parts.join(' OR ')})` : 'FALSE';
}

/** `column ILIKE pattern` with the backslash as the escape character (the pattern is a bound parameter). */
const ilike = (column: string, pattern: string): string => `${column} ILIKE ${pattern} ESCAPE '\\'`;

/** Microsecond UTC text: exact, sortable as a string, and parsed back by `::timestamptz`. */
const utcText = (column: string): string => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface TimelineViewer {
  principalId: string;
  isRoot: boolean;
  /** A login session: only these read approval rows (as the approvals surface). */
  isSession: boolean;
  isAdministrator: boolean;
  /** The per-type scope ceilings (`tasks:read` is the route ceiling). */
  ceilings: { reports: boolean; phases: boolean; projects: boolean; skills: boolean };
  taskScope: AuthorizationListScope<'task'>;
  reportScope: AuthorizationListScope<'report'>;
  phaseScope: AuthorizationListScope<'phase'>;
  projectScope: AuthorizationListScope<'project'>;
  skillScope: AuthorizationListScope<'skill'>;
  /** `filterPromotedReports`'s actor: root is exempt from narrowing 3. */
  reportActor: { principalId: string; root: boolean };
  /** The registry's own draft viewer (routes/skills.ts viewerOf). */
  skillViewer: SkillViewer;
}

/** The opaque paging token, decoded. Times are microsecond UTC text. */
export interface TimelineCursor {
  feedBefore: string | null;
  approvalsBefore: string | null;
  skillBefore: string | null;
  /** Capped mode (R2-N1): each windowed arm's own keyset, `[time, id]`. */
  approvalsKey: [string, string] | null;
  skillKey: [string, string] | null;
  capped: boolean;
}

export interface TimelineQuery {
  /** Empty = every type except `access`, which `acl` adds. */
  types: TimelineType[];
  acl: boolean;
  project: string | null;
  phase: string | null;
  person: string | null;
  since: string | null;
  until: string | null;
  scope: 'all' | 'mine';
  /** E453: a text search over the titles and labels the caller may see; null when not searching. */
  q: string | null;
  before: TimelineCursor | null;
  limit: number;
}

export interface TimelineItem {
  key: string;
  at: string;
  kind: TimelineType;
  label: string;
  object: { type: string; id: string; title: string | null };
  project: { id: string; name: string | null } | null;
  actor: { handle: string | null };
  detail: Record<string, unknown>;
}

export interface TimelinePage {
  items: TimelineItem[];
  nextCursor: string | null;
  hasMore: boolean;
  headCursor: { feed: string | null; approvals: string | null; skills: string | null };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A windowed arm with nothing left: a (time, id) key below every row. */
const SPENT_KEY: [string, string] = ['0001-01-01T00:00:00.000000Z', '00000000-0000-0000-0000-000000000000'];
const UTC_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function encodeTimelineCursor(cursor: TimelineCursor): string {
  return Buffer.from(JSON.stringify({
    v: 1, f: cursor.feedBefore, a: cursor.approvalsBefore, s: cursor.skillBefore,
    ak: cursor.approvalsKey, sk: cursor.skillKey, c: cursor.capped,
  }), 'utf8').toString('base64url');
}

/** Decode `before`; anything this route did not issue is 'invalid'. */
export function decodeTimelineCursor(value: unknown): TimelineCursor | null | 'invalid' {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) return 'invalid';
  let raw: any;
  try { raw = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { return 'invalid'; }
  if (!raw || typeof raw !== 'object' || raw.v !== 1 || typeof raw.c !== 'boolean') return 'invalid';
  const time = (t: unknown): t is string => typeof t === 'string' && UTC_TEXT.test(t);
  const key = (k: unknown): [string, string] | null | 'invalid' => {
    if (k === null || k === undefined) return null;
    return Array.isArray(k) && k.length === 2 && time(k[0]) && typeof k[1] === 'string' && UUID.test(k[1])
      ? [k[0], k[1]] : 'invalid';
  };
  if (raw.f !== null && !(typeof raw.f === 'string' && /^[0-9]{1,19}$/.test(raw.f))) return 'invalid';
  if (raw.a !== null && !time(raw.a)) return 'invalid';
  if (raw.s !== null && !time(raw.s)) return 'invalid';
  const ak = key(raw.ak); const sk = key(raw.sk);
  if (ak === 'invalid' || sk === 'invalid') return 'invalid';
  return { feedBefore: raw.f, approvalsBefore: raw.a, skillBefore: raw.s, approvalsKey: ak, skillKey: sk, capped: raw.c };
}

class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
  /** Render a list scope's predicate here, binding its parameters after ours. */
  scope(scope: AuthorizationListScope<any>): string {
    const rendered = (scope as AuthorizationListScope<any>).render(this.values.length + 1);
    this.values.push(...rendered.params);
    return rendered.sql;
  }
}

/** The `my_subtree` CTE the My-work rule and the approval actor rule read. */
const SUBTREE_CTE = (me: string) => `WITH RECURSIVE my_subtree(id) AS (
        SELECT id FROM principals WHERE id = ${me}::uuid
        UNION
        SELECT c.id FROM principals c JOIN my_subtree s ON c.parent_principal_id = s.id
      )`;

function wantedTypes(query: Pick<TimelineQuery, 'types' | 'acl'>): Set<TimelineType> {
  const base: TimelineType[] = query.types.length > 0
    ? [...query.types]
    : TIMELINE_TYPES.filter((type) => type !== 'access');
  if (query.acl && !base.includes('access')) base.push('access');
  return new Set(base);
}

export class TimelineService {
  constructor(private readonly pool: Pool = defaultPool) {}

  /**
   * The feed arm's statement. Exported shape (sql + params) so the EXPLAIN
   * tests read the very statement a page runs.
   */
  buildFeedQuery(viewer: TimelineViewer, query: TimelineQuery, options: { before: string | null; limit: number }):
    { sql: string; params: unknown[] } | null {
    const types = wantedTypes(query);
    const names = new Set<string>();
    for (const type of types) {
      const feedNames = (TIMELINE_FEED_NAMES as Record<string, readonly string[] | undefined>)[type];
      for (const name of feedNames ?? []) names.add(name);
    }
    if (names.size === 0) return null;
    const p = new Params();
    const me = p.add(viewer.principalId);
    const clauses: string[] = [`fe.name = ANY(${p.add([...names].sort())}::text[])`];
    // `status` and `update` split one feed name by its payload.
    if (types.has('status') !== types.has('update')) {
      clauses.push(types.has('status')
        ? `(fe.name <> 'task.updated' OR ${STATUS_MOVE})`
        : `(fe.name <> 'task.updated' OR NOT ${STATUS_MOVE})`);
    }
    if (options.before !== null) clauses.push(`fe.cursor < ${p.add(options.before)}::bigint`);
    if (query.project) clauses.push(`fe.project_id = ${p.add(query.project)}::uuid`);
    if (query.phase) {
      const phase = p.add(query.phase);
      clauses.push(`((fe.object_type = 'task' AND EXISTS (SELECT 1 FROM tasks phase_task
                 WHERE phase_task.id = fe.object_id AND phase_task.phase_id = ${phase}::uuid))
             OR (fe.object_type = 'phase' AND fe.object_id = ${phase}::uuid))`);
    }
    if (query.person) clauses.push(`fe.actor_principal_id = ${p.add(query.person)}::uuid`);
    const window: string[] = [];
    if (query.since) window.push(`occurred_at >= ${p.add(query.since)}::timestamptz`);
    if (query.until) window.push(`occurred_at < ${p.add(query.until)}::timestamptz`);
    if (window.length > 0) {
      clauses.push(...window.map((bound) => `fe.${bound}`));
      // THE DATE WINDOW'S CURSOR BOUNDS. The window is a range on occurred_at
      // (ix_feed_events_occurred), and occurred_at is not commit order, so the
      // date is never turned into an approximate cursor. Its EXACT cursor
      // bounds are: the least and the greatest cursor of a row inside it. They
      // bound the cursor-ordered scan, so a window holding few rows this
      // caller may read never walks the rest of the feed, whatever the planner
      // estimates (a full-tier job database once planned this window as a walk
      // of the whole primary key). They change no answer: every row inside the
      // window lies between them. Each bound aggregates the window's own rows
      // (`OFFSET 0` keeps that subquery whole, so the planner reads it as a
      // range on the date index instead of rewriting min/max into a walk of
      // the primary key from one end).
      const inside = window.map((bound) => `window_row.${bound}`).join(' AND ');
      const windowCursors = `(SELECT window_row.cursor FROM feed_events window_row WHERE ${inside} OFFSET 0) window_rows`;
      clauses.push(`fe.cursor >= (SELECT min(window_rows.cursor) FROM ${windowCursors})`);
      clauses.push(`fe.cursor <= (SELECT max(window_rows.cursor) FROM ${windowCursors})`);
    }
    if (query.scope === 'mine') {
      clauses.push(`((fe.object_type = 'task' AND EXISTS (SELECT 1 FROM tasks tk
                 WHERE tk.id = fe.object_id AND ${myWorkTaskCondition(me)}))
             OR (fe.object_type <> 'task' AND (fe.actor_principal_id IN (SELECT id FROM my_subtree)
                 OR fe.owner_principal_id IN (SELECT id FROM my_subtree))))`);
    }

    if (query.q) {
      // E453: the text search, a conjunct of this statement (before the LIMIT).
      // A row matches by its own label, or by the title of its object. The
      // titled objects are read only to name candidates, so this conjunct can
      // only REMOVE rows: each row is still admitted by its own arm below, and
      // a title therefore matches only on an object the caller may read. It is
      // bounded: each object table is read once for the candidate set, never
      // once per feed row.
      const pattern = p.add(timelineSearchPattern(query.q));
      const titled = [`SELECT 'task'::text, q_task.id FROM tasks q_task WHERE ${ilike('q_task.title', pattern)}`];
      if (viewer.ceilings.reports) titled.push(`SELECT 'report'::text, q_report.id FROM reports q_report WHERE ${ilike('q_report.title', pattern)}`);
      if (viewer.ceilings.phases) titled.push(`SELECT 'phase'::text, q_phase.id FROM phases q_phase WHERE ${ilike('q_phase.name', pattern)}`);
      if (viewer.ceilings.projects) titled.push(`SELECT 'project'::text, q_project.id FROM projects q_project WHERE ${ilike('q_project.name', pattern)}`);
      if (viewer.ceilings.skills) titled.push(`SELECT 'skill'::text, q_skill.id FROM skills q_skill WHERE ${ilike('q_skill.name', pattern)}`);
      clauses.push(`(${feedLabelSql(timelineLabelMatches(query.q))}
             OR (fe.object_type, fe.object_id) IN (${titled.join(' UNION ALL ')}))`);
    }

    // ── the arms: each type's ceiling, then its list scope, IN the query ──
    const arms: string[] = [];
    const task = viewer.taskScope;
    arms.push(`(fe.object_type = 'task' AND EXISTS (SELECT 1 FROM ${task.from}
               WHERE ${task.id} = fe.object_id AND ${p.scope(task)}))`);
    if (viewer.ceilings.reports) {
      const report = viewer.reportScope;
      const alias = report.id.split('.')[0];
      const narrowing = p.scope(report);
      const visibility = reportVisibilitySql(alias, { taskScope: viewer.taskScope, ...viewer.reportActor }, p.values);
      arms.push(`(fe.object_type = 'report' AND EXISTS (SELECT 1 FROM ${report.from}
               WHERE ${report.id} = fe.object_id AND ${narrowing} AND ${visibility}))`);
    }
    if (viewer.ceilings.phases) {
      const phase = viewer.phaseScope;
      arms.push(`(fe.object_type = 'phase' AND EXISTS (SELECT 1 FROM ${phase.from}
               WHERE ${phase.id} = fe.object_id AND ${p.scope(phase)}))`);
    }
    if (viewer.ceilings.projects) {
      const project = viewer.projectScope;
      arms.push(`(fe.object_type = 'project' AND EXISTS (SELECT 1 FROM ${project.from}
               WHERE ${project.id} = fe.object_id AND ${p.scope(project)}))`);
    }
    if (viewer.ceilings.skills) {
      const skill = viewer.skillScope;
      const narrowing = p.scope(skill);
      const account = viewer.skillViewer.manage && viewer.skillViewer.accountId ? p.add(viewer.skillViewer.accountId) : null;
      arms.push(`(fe.object_type = 'skill' AND EXISTS (SELECT 1 FROM ${skill.from}
               WHERE ${skill.id} = fe.object_id AND ${narrowing}
                 AND (s.current_published_version_id IS NOT NULL OR ${draftVisibilitySql(viewer.skillViewer, account, false)})))`);
    }
    clauses.push(`(${arms.join('\n            OR ')})`);

    const limit = p.add(options.limit);
    const sql = `${SUBTREE_CTE(me)}
      SELECT fe.cursor::text AS cursor, fe.name, fe.object_type, fe.object_id::text AS object_id,
             ${utcText('fe.occurred_at')} AS at, fe.project_id::text AS project_id, fe.payload,
             COALESCE(fe.actor_handle, actor_principal.handle) AS actor_handle
        FROM feed_events fe
        LEFT JOIN principals actor_principal ON actor_principal.id = fe.actor_principal_id
       WHERE ${clauses.join('\n         AND ')}
       ORDER BY fe.cursor DESC
       LIMIT ${limit}`;
    return { sql, params: p.values };
  }

  /** The approval arm's statement (login sessions only), windowed or keyset-capped. */
  buildApprovalQuery(viewer: TimelineViewer, query: TimelineQuery,
    window: { before: string | null; floor: string | null; key: [string, string] | null; limit: number | null }):
    { sql: string; params: unknown[] } | null {
    if (!viewer.isSession || !wantedTypes(query).has('approval')) return null;
    const p = new Params();
    const me = p.add(viewer.principalId);
    const scopeParams: unknown[] = [];
    const scope = approvalSelfScopeCondition(
      { principalId: viewer.principalId, isRoot: viewer.isRoot, isAdministrator: viewer.isAdministrator },
      scopeParams, 'a', p.values.length,
    );
    p.values.push(...scopeParams);
    const clauses: string[] = [scope ?? 'TRUE'];
    // A (time, id) key, when the token carries one, already lies inside `before`
    // and also keeps the rows that share the key's time.
    if (window.before && !window.key) clauses.push(`ae.occurred_at < ${p.add(window.before)}::timestamptz`);
    if (window.floor) clauses.push(`ae.occurred_at >= ${p.add(window.floor)}::timestamptz`);
    if (window.key) {
      clauses.push(`(ae.occurred_at, ae.id) < (${p.add(window.key[0])}::timestamptz, ${p.add(window.key[1])}::uuid)`);
    }
    if (query.project) clauses.push(`COALESCE(atk.project_id, rph.project_id) = ${p.add(query.project)}::uuid`);
    if (query.phase) {
      const phase = p.add(query.phase);
      clauses.push(`(atk.phase_id = ${phase}::uuid OR a.related_phase_id = ${phase}::uuid)`);
    }
    // R2-B3: a person matches only where the actor SHOWN to this viewer is
    // that person; a withheld actor never matches.
    if (query.person) clauses.push(`ae.actor_principal_id = ${p.add(query.person)}::uuid AND (${APPROVAL_ACTOR_HANDLE}) IS NOT NULL`);
    if (query.since) clauses.push(`ae.occurred_at >= ${p.add(query.since)}::timestamptz`);
    if (query.until) clauses.push(`ae.occurred_at < ${p.add(query.until)}::timestamptz`);
    if (query.scope === 'mine') {
      clauses.push(`(a.requester_principal_id IN (SELECT id FROM my_subtree)
             OR ae.actor_principal_id = ${me}::uuid OR a.decided_by_principal_id = ${me}::uuid)`);
    }
    if (query.q && !timelineLabelMatches(query.q).has('approval')) {
      // E453: an approval row's only title is its Task's, and it matches only
      // where the caller reads that Task (the task list scope), exactly as the
      // title is shown below.
      const searched = viewer.taskScope;
      const pattern = p.add(timelineSearchPattern(query.q));
      clauses.push(`EXISTS (SELECT 1 FROM ${searched.from} WHERE ${searched.id} = atk.id AND ${p.scope(searched)}
                 AND ${ilike(`${searched.id.split('.')[0]}.title`, pattern)})`);
    }
    const task = viewer.taskScope;
    const titleScope = p.scope(task);
    const limit = window.limit === null ? '' : `LIMIT ${p.add(window.limit)}`;
    const sql = `${SUBTREE_CTE(me)}
      SELECT ae.id::text AS id, ${utcText('ae.occurred_at')} AS at, ae.action,
             a.id::text AS approval_id, a.kind AS approval_kind, a.status AS approval_status,
             atk.id::text AS task_id,
             CASE WHEN atk.id IS NOT NULL AND EXISTS (SELECT 1 FROM ${task.from}
                    WHERE ${task.id} = atk.id AND ${titleScope}) THEN atk.title END AS task_title,
             COALESCE(atk.project_id, rph.project_id)::text AS project_id,
             ${APPROVAL_ACTOR_HANDLE} AS actor_handle
        FROM approval_events ae
        JOIN approvals a ON a.id = ae.approval_id
        LEFT JOIN tasks atk ON atk.id = COALESCE(a.target_task_id, a.related_task_id)
        LEFT JOIN phases rph ON rph.id = a.related_phase_id
       WHERE ${clauses.join('\n         AND ')}
       ORDER BY ae.occurred_at DESC, ae.id DESC
       ${limit}`;
    return { sql, params: p.values };
  }

  /** The skill-version arm's statement (`skills:read`), windowed or keyset-capped. */
  buildSkillVersionQuery(viewer: TimelineViewer, query: TimelineQuery,
    window: { before: string | null; floor: string | null; key: [string, string] | null; limit: number | null }):
    { sql: string; params: unknown[] } | null {
    // Skills carry no project, so a project or phase filter leaves this arm out (R2-N3).
    if (!viewer.ceilings.skills || !wantedTypes(query).has('skill-version') || query.project || query.phase) return null;
    const p = new Params();
    const me = p.add(viewer.principalId);
    const account = viewer.skillViewer.manage && viewer.skillViewer.accountId ? p.add(viewer.skillViewer.accountId) : null;
    const skill = viewer.skillScope;
    const clauses: string[] = [
      `(e.status IN ('published', 'retired') OR (e.status = 'draft' AND prev.status = 'review'))`,
      `EXISTS (SELECT 1 FROM ${skill.from} WHERE ${skill.id} = sv.skill_id AND ${p.scope(skill)})`,
      // R2-B2: a published or retired decision on a Skill with a published
      // version, or a manager for whom the registry's own point draft rule
      // holds. Never a re-typed copy of either rule.
      `((e.status IN ('published', 'retired') AND s.current_published_version_id IS NOT NULL)
             OR ${draftVisibilitySql(viewer.skillViewer, account, true)})`,
    ];
    if (window.before && !window.key) clauses.push(`e.created_at < ${p.add(window.before)}::timestamptz`);
    if (window.floor) clauses.push(`e.created_at >= ${p.add(window.floor)}::timestamptz`);
    if (window.key) {
      clauses.push(`(e.created_at, e.id) < (${p.add(window.key[0])}::timestamptz, ${p.add(window.key[1])}::uuid)`);
    }
    if (query.person) clauses.push(`e.actor_principal_id = ${p.add(query.person)}::uuid`);
    if (query.since) clauses.push(`e.created_at >= ${p.add(query.since)}::timestamptz`);
    if (query.until) clauses.push(`e.created_at < ${p.add(query.until)}::timestamptz`);
    if (query.scope === 'mine') {
      clauses.push(`(sv.created_by_principal_id IN (SELECT id FROM my_subtree)
             OR e.actor_principal_id IN (SELECT id FROM my_subtree))`);
    }
    // E453: the name of a Skill this arm already admits, or the row's own label.
    if (query.q && !timelineLabelMatches(query.q).has('skill-version')) {
      clauses.push(ilike('s.name', p.add(timelineSearchPattern(query.q))));
    }
    const limit = window.limit === null ? '' : `LIMIT ${p.add(window.limit)}`;
    const sql = `${SUBTREE_CTE(me)}
      SELECT e.id::text AS id, ${utcText('e.created_at')} AS at, e.status, prev.status AS previous_status,
             s.id::text AS skill_id, s.name AS skill_name, sv.version, version_actor.handle AS actor_handle
        FROM skill_version_events e
        JOIN skill_versions sv ON sv.id = e.skill_version_id
        JOIN skills s ON s.id = sv.skill_id
        LEFT JOIN principals version_actor ON version_actor.id = e.actor_principal_id
        LEFT JOIN LATERAL (
          SELECT e2.status FROM skill_version_events e2
           WHERE e2.skill_version_id = e.skill_version_id AND e2.sequence < e.sequence
           ORDER BY e2.sequence DESC LIMIT 1
        ) prev ON TRUE
       WHERE ${clauses.join('\n         AND ')}
       ORDER BY e.created_at DESC, e.id DESC
       ${limit}`;
    return { sql, params: p.values };
  }

  /**
   * Run `work` inside the Timeline's transaction on one pooled client:
   * read-only for a page, read-write for the last-seen mark. The settings are
   * `SET LOCAL`, so they end with the transaction.
   */
  async transaction<T>(mode: 'read' | 'write', work: (db: TimelineDb) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(mode === 'read' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      for (const setting of TIMELINE_TRANSACTION_SETTINGS) await client.query(setting);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async page(viewer: TimelineViewer, query: TimelineQuery): Promise<TimelinePage> {
    return this.transaction('read', (db) => this.pageWith(db, viewer, query));
  }

  /** One page on `db`, a client already inside the Timeline's transaction. */
  async pageWith(db: TimelineDb, viewer: TimelineViewer, query: TimelineQuery): Promise<TimelinePage> {
    const limit = Math.min(Math.max(Math.trunc(query.limit) || TIMELINE_PAGE_DEFAULT, 1), TIMELINE_PAGE_MAX);
    const token = query.before;
    const run = async (built: { sql: string; params: unknown[] } | null): Promise<any[]> =>
      built ? (await db.query(built.sql, built.params)).rows : [];

    // The feed arm. In capped mode it already returned nothing once, and its
    // keyset has not moved, so it is not asked again.
    const feedRows = token?.capped ? [] : await run(this.buildFeedQuery(viewer, query, {
      before: token?.feedBefore ?? null, limit: limit + 1,
    }));
    const feedPage = feedRows.slice(0, limit);
    const feedHasMore = feedRows.length > limit;

    let approvalRows: any[];
    let skillRows: any[];
    let next: TimelineCursor | null;
    if (feedPage.length > 0) {
      // Windowed mode: floorN = LEAST(before, the oldest feed row here), or
      // -infinity when the feed has no more rows. The floor never rises.
      const oldest = feedPage.reduce((min: string, row: any) => (row.at < min ? row.at : min), feedPage[0].at as string);
      const floorOf = (before: string | null): string | null => {
        if (!feedHasMore) return null;
        return before !== null && before < oldest ? before : oldest;
      };
      const approvalsFloor = floorOf(token?.approvalsBefore ?? null);
      const skillFloor = floorOf(token?.skillBefore ?? null);
      // Each window reads at most a page (plus one to know it was cut): a
      // window spanning months of sparse feed rows never returns an unbounded
      // number of rows. A cut window continues below its last row on the next
      // page, on its own (time, id) keyset; an uncut one hands on its floor.
      const approvals = await run(this.buildApprovalQuery(viewer, query,
        { before: token?.approvalsBefore ?? null, floor: approvalsFloor, key: token?.approvalsKey ?? null, limit: limit + 1 }));
      const skills = await run(this.buildSkillVersionQuery(viewer, query,
        { before: token?.skillBefore ?? null, floor: skillFloor, key: token?.skillKey ?? null, limit: limit + 1 }));
      approvalRows = approvals.slice(0, limit);
      skillRows = skills.slice(0, limit);
      const carry = (rows: any[], cut: boolean, floor: string | null): { before: string | null; key: [string, string] | null } => {
        if (cut) {
          const last = rows[rows.length - 1];
          return { before: String(last.at), key: [String(last.at), String(last.id)] };
        }
        // A floor of -infinity (the feed is done) leaves nothing below: the arm is spent.
        return floor === null ? { before: null, key: SPENT_KEY } : { before: floor, key: null };
      };
      const approvalsCut = approvals.length > limit;
      const skillCut = skills.length > limit;
      const nextApprovals = carry(approvalRows, approvalsCut, approvalsFloor);
      const nextSkills = carry(skillRows, skillCut, skillFloor);
      next = feedHasMore || approvalsCut || skillCut ? {
        feedBefore: String(feedPage[feedPage.length - 1].cursor),
        approvalsBefore: nextApprovals.before, skillBefore: nextSkills.before,
        approvalsKey: nextApprovals.key, skillKey: nextSkills.key,
        // The feed is done but a window was cut: page on in capped mode.
        capped: !feedHasMore,
      } : null;
    } else {
      // Capped mode (R2-N1): each windowed arm on its own (time, id) keyset.
      const approvals = await run(this.buildApprovalQuery(viewer, query, {
        before: token?.approvalsBefore ?? null, floor: null, key: token?.approvalsKey ?? null, limit: limit + 1,
      }));
      const skills = await run(this.buildSkillVersionQuery(viewer, query, {
        before: token?.skillBefore ?? null, floor: null, key: token?.skillKey ?? null, limit: limit + 1,
      }));
      approvalRows = approvals.slice(0, limit);
      skillRows = skills.slice(0, limit);
      const approvalsMore = approvals.length > limit;
      const skillMore = skills.length > limit;
      const last = (rows: any[], fallback: [string, string] | null): [string, string] | null =>
        rows.length > 0 ? [String(rows[rows.length - 1].at), String(rows[rows.length - 1].id)] : fallback;
      next = approvalsMore || skillMore ? {
        feedBefore: token?.feedBefore ?? null,
        approvalsBefore: token?.approvalsBefore ?? null, skillBefore: token?.skillBefore ?? null,
        // An arm with no more rows keeps a keyset below everything it has.
        approvalsKey: approvalsMore ? last(approvalRows, null) : SPENT_KEY,
        skillKey: skillMore ? last(skillRows, null) : SPENT_KEY,
        capped: true,
      } : null;
    }

    const items = await this.describe(db, viewer, feedPage, approvalRows, skillRows);
    return {
      items,
      hasMore: next !== null,
      nextCursor: next ? encodeTimelineCursor(next) : null,
      headCursor: await this.head(db, viewer, query),
    };
  }

  /** The newest visible row of each source under the same filters (the "N new" banner compares all three). */
  async head(db: TimelineDb, viewer: TimelineViewer, query: TimelineQuery): Promise<TimelinePage['headCursor']> {
    const first = async (built: { sql: string; params: unknown[] } | null, field: string): Promise<string | null> => {
      if (!built) return null;
      const rows = (await db.query(built.sql, built.params)).rows;
      return rows[0] ? String(rows[0][field]) : null;
    };
    const top = { before: null, floor: null, key: null, limit: 1 };
    return {
      feed: await first(this.buildFeedQuery(viewer, query, { before: null, limit: 1 }), 'cursor'),
      approvals: await first(this.buildApprovalQuery(viewer, query, top), 'at'),
      skills: await first(this.buildSkillVersionQuery(viewer, query, top), 'at'),
    };
  }

  /** Rows to items, sorted by (at DESC, source, id DESC) for display. Titles
   * are read only for objects the arms already admitted; a project's name only
   * where the caller reads that project. */
  private async describe(db: TimelineDb, viewer: TimelineViewer, feed: any[], approvals: any[], skills: any[]): Promise<TimelineItem[]> {
    const ids = (type: string) => [...new Set(feed.filter((row) => row.object_type === type).map((row) => String(row.object_id)))];
    const titles = new Map<string, { title: string | null; handover?: boolean }>();
    const read = async (type: string, sql: string) => {
      const wanted = ids(type);
      if (wanted.length === 0) return;
      for (const row of (await db.query(sql, [wanted])).rows) {
        titles.set(`${type}:${row.id}`, { title: row.title ?? null, ...(row.handover !== undefined ? { handover: row.handover } : {}) });
      }
    };
    await read('task', 'SELECT id::text AS id, title FROM tasks WHERE id = ANY($1::uuid[])');
    await read('report', 'SELECT id::text AS id, title, (handover IS NOT NULL) AS handover FROM reports WHERE id = ANY($1::uuid[])');
    await read('phase', 'SELECT id::text AS id, name AS title FROM phases WHERE id = ANY($1::uuid[])');
    await read('project', 'SELECT id::text AS id, name AS title FROM projects WHERE id = ANY($1::uuid[])');
    await read('skill', 'SELECT id::text AS id, name AS title FROM skills WHERE id = ANY($1::uuid[])');

    const projectIds = [...new Set([...feed, ...approvals].map((row) => row.project_id).filter(Boolean).map(String))];
    const projectNames = new Map<string, string>();
    if (viewer.ceilings.projects && projectIds.length > 0) {
      const p = new Params();
      const wanted = p.add(projectIds);
      const scope = viewer.projectScope;
      const narrowing = p.scope(scope);
      const rows = (await db.query(
        `SELECT ${scope.id}::text AS id, p.name FROM ${scope.from} WHERE ${scope.id} = ANY(${wanted}::uuid[]) AND ${narrowing}`,
        p.values,
      )).rows;
      for (const row of rows) projectNames.set(String(row.id), String(row.name));
    }
    const projectOf = (id: unknown) => (id && projectNames.has(String(id))
      ? { id: String(id), name: projectNames.get(String(id)) ?? null } : null);

    const items: Array<TimelineItem & { source: string; sortId: string }> = [];
    for (const row of feed) {
      const kind = feedKind(row);
      const known = titles.get(`${row.object_type}:${row.object_id}`);
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      const detail: Record<string, unknown> = { name: row.name };
      if (kind === 'status') { detail.from = payload.previousStatus ?? null; detail.to = payload.status ?? null; }
      if (Array.isArray(payload.fields)) detail.fields = payload.fields;
      if (payload.stream && typeof payload.stream === 'object') detail.stream = payload.stream;
      if (kind === 'stuck' && payload.reason) detail.reason = payload.reason;
      if (row.object_type === 'report') detail.handover = known?.handover === true;
      items.push({
        key: `feed:${row.cursor}`, at: String(row.at), kind, label: TIMELINE_LABELS[kind],
        object: { type: String(row.object_type), id: String(row.object_id), title: known?.title ?? null },
        project: projectOf(row.project_id),
        actor: { handle: row.actor_handle ?? null },
        detail, source: 'feed', sortId: String(row.cursor).padStart(20, '0'),
      });
    }
    for (const row of approvals) {
      items.push({
        key: `approval-event:${row.id}`, at: String(row.at), kind: 'approval', label: TIMELINE_LABELS.approval,
        object: { type: 'approval', id: String(row.approval_id), title: row.task_title ?? null },
        project: projectOf(row.project_id),
        actor: { handle: row.actor_handle ?? null },
        detail: {
          action: row.action, approvalKind: row.approval_kind, approvalStatus: row.approval_status,
          taskId: row.task_title !== null && row.task_title !== undefined ? row.task_id : null,
        },
        source: 'approval', sortId: String(row.id),
      });
    }
    for (const row of skills) {
      items.push({
        key: `skill-event:${row.id}`, at: String(row.at), kind: 'skill-version', label: TIMELINE_LABELS['skill-version'],
        object: { type: 'skill', id: String(row.skill_id), title: row.skill_name ?? null },
        project: null,
        actor: { handle: row.actor_handle ?? null },
        detail: {
          version: Number(row.version),
          decision: row.status === 'draft' ? 'returned' : row.status,
          from: row.previous_status ?? null, to: row.status,
        },
        source: 'skill-version', sortId: String(row.id),
      });
    }
    items.sort((x, y) => (x.at === y.at
      ? (x.source === y.source ? (x.sortId < y.sortId ? 1 : x.sortId > y.sortId ? -1 : 0) : (x.source < y.source ? -1 : 1))
      : (x.at < y.at ? 1 : -1)));
    return items.map(({ source: _source, sortId: _sortId, ...item }) => item);
  }

  /**
   * `POST /notifications/timeline/seen`: the caller's OWN last-seen feed
   * cursor (`notification_read_marks.feed_cursor`), clamped to the newest feed
   * row the CALLER may see (every type, access changes included) and never
   * moved backwards (R2-N2). The clamp is the caller's head, not the board's
   * max(cursor), so the echoed value never discloses rows the caller cannot
   * read. A principal with no mark gets one; its `others_through` starts at
   * its own creation time, the history's no-mark default, so nothing else
   * reads differently.
   */
  async markSeen(viewer: TimelineViewer, cursor: string): Promise<string> {
    return this.transaction('write', async (db) => {
      const head = await this.head(db, viewer, {
        types: [], acl: true, project: null, phase: null, person: null, since: null, until: null,
        scope: 'all', q: null, before: null, limit: 1,
      });
      const result = await db.query(
        `INSERT INTO notification_read_marks (principal_id, feed_cursor, others_through, updated_at)
         SELECT p.id, LEAST($2::bigint, COALESCE($3::bigint, 0)), p.created_at, now()
           FROM principals p WHERE p.id = $1::uuid
         ON CONFLICT (principal_id) DO UPDATE
           SET feed_cursor = GREATEST(notification_read_marks.feed_cursor, EXCLUDED.feed_cursor),
               updated_at = now()
         RETURNING feed_cursor::text AS feed_cursor`,
        [viewer.principalId, cursor, head.feed],
      );
      return String(result.rows[0]?.feed_cursor ?? '0');
    });
  }

  /** The caller's own last-seen feed cursor, or null when it has no mark. */
  async lastSeen(principalId: string): Promise<string | null> {
    const result = await this.pool.query(
      'SELECT feed_cursor::text AS feed_cursor FROM notification_read_marks WHERE principal_id = $1::uuid', [principalId]);
    return result.rows[0] ? String(result.rows[0].feed_cursor) : null;
  }
}

function feedKind(row: any): TimelineType {
  const name = String(row.name);
  if (name.endsWith('.acl_changed')) return 'access';
  if (name === 'task.created' || name === 'task.archived') return 'task';
  if (name === 'task.stuck') return 'stuck';
  if (name === 'task.review_requested') return 'review';
  if (name === 'task.updated') {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    return 'status' in payload && payload.status !== payload.previousStatus ? 'status' : 'update';
  }
  if (name.startsWith('report.')) return 'report';
  if (name.startsWith('phase.')) return 'phase';
  if (name.startsWith('project.')) return 'project';
  return 'skill';
}

export const timelineService = new TimelineService();
