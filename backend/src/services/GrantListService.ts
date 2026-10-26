// GrantListService.ts — the paged, filtered read behind Settings → Access
// grants (owner ruling E407 item 1, card ff410dc4, SQ-4 + SQ-5).
//
// The Access page used to load every grant in one unbounded read (about four
// thousand rows on a busy board) and showed every one as if a person had made
// it. This service answers ONE page at a time, in a stable keyset order, with
// each row's ORIGIN derived from data the board already keeps:
//
//   system-made  the row carries assignment `provenance` (an execution,
//                Verifier or Shepherd assignment's access vehicle), or a
//                non-`manual` `origin` column value (a Project's creation
//                default, a steward row), or the append-only audit ledger
//                holds the creation-policy row written IN THE SAME
//                TRANSACTION as the grant and naming it by `metadata.grantId`
//                (`task.creator_access`, `task.sponsor_access`,
//                `report.creator_access`, `report.sponsor_access`,
//                `project.creator_access`), or the grant's own `grant.create`
//                row says `automatic: true`.
//   hand-made    the row was written by an approval (`approval_id`, an access
//                request or a change request a person decided), or its
//                `grant.create` audit row exists and none of the system
//                markers above does: the Access page, the CLI or the REST API.
//   unknown      no marker and no `grant.create` row (a row older than the
//                audit ledger, or one seeded by a migration). It is never
//                guessed into either class.
//
// Nothing here decides authority: classification is presentation. The route
// keeps its `root` ceiling (scopeMap), so the caller already sees every grant;
// every filter is applied INSIDE the one SQL statement, before LIMIT.
import { pool } from '../db/connection';
import { GRANT_RESOURCE_TYPES, GRANT_VERBS, GrantError, type GrantRecord } from './GrantService';

export const GRANT_MADE_CLASSES = ['hand', 'system', 'unknown'] as const;
export type GrantMadeClass = (typeof GRANT_MADE_CLASSES)[number];

/** How a row came to exist, as precisely as the evidence says. */
export const GRANT_MADE_VIA = [
  'direct', 'approval', 'task-creator', 'task-sponsor', 'report-creator', 'report-sponsor',
  'project-creator', 'project-default', 'steward', 'assignment', 'warrant', 'automatic',
] as const;
export type GrantMadeVia = (typeof GRANT_MADE_VIA)[number];

export const GRANT_SORTS = [
  '-created', 'created', 'grantee', '-grantee', 'resource', '-resource', 'verb', '-verb', 'expires', '-expires',
] as const;
export type GrantSort = (typeof GRANT_SORTS)[number];

export const GRANT_EXPIRY_FILTERS = ['any', 'none', 'live', 'expired', 'expiring'] as const;
export type GrantExpiryFilter = (typeof GRANT_EXPIRY_FILTERS)[number];

export const GRANT_TARGET_FILTERS = ['any', 'live', 'archived', 'missing', 'wildcard'] as const;
export type GrantTargetFilter = (typeof GRANT_TARGET_FILTERS)[number];

export const GRANT_PAGE_DEFAULT_LIMIT = 50;
export const GRANT_PAGE_MAX_LIMIT = 200;
/** "Expiring soon" = a live expiry within this many days. */
export const GRANT_EXPIRING_SOON_DAYS = 14;
const MAX_SEARCH_LENGTH = 200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The creation-policy audit actions written beside a grant in its own transaction. */
export const CREATION_POLICY_ACTIONS: Record<string, GrantMadeVia> = {
  'task.creator_access': 'task-creator',
  'task.sponsor_access': 'task-sponsor',
  'report.creator_access': 'report-creator',
  'report.sponsor_access': 'report-sponsor',
  'project.creator_access': 'project-creator',
};

export interface GrantListQuery {
  /** null = the legacy unbounded read (no `limit` and no `cursor` sent). */
  limit: number | null;
  cursor?: string;
  sort: GrantSort;
  made: GrantMadeClass | 'all';
  granteeId?: string;
  resourceType?: string;
  verb?: string;
  expiry: GrantExpiryFilter;
  target: GrantTargetFilter;
  q?: string;
}

export interface GrantMadeBy {
  class: GrantMadeClass;
  via: GrantMadeVia | null;
  /** Which evidence decided the class: a grants column, the audit ledger, or none. */
  evidence: 'column' | 'audit' | 'none';
}

export interface GrantTargetView {
  /** Title or name of a Task, Report, Project or Phase; null for other types. */
  label: string | null;
  /** The object's lifecycle status when the board keeps one for this type. */
  status: string | null;
  state: 'live' | 'archived' | 'missing' | 'wildcard' | 'unchecked';
}

/** A Group grantee is not a principal row the route can resolve; the list
 * names it from the groups table instead (null when the Group is gone). */
export type GrantListRow = GrantRecord & { madeBy: GrantMadeBy; target: GrantTargetView; granteeGroup?: { id: string; name: string | null } };

export interface GrantListPage {
  grants: GrantListRow[];
  pagination: {
    limit: number | null;
    sort: GrantSort;
    returned: number;
    total: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
  /** Per-class counts under every filter EXCEPT `made` (first page only). */
  madeCounts?: Record<GrantMadeClass, number>;
}

const err = (status: number, code: string, message: string, field?: string) =>
  new GrantError(status, code, message, field);

/**
 * Every TEXT sort key is cut to this many characters inside the statement, so
 * the key a cursor carries is bounded by construction, whatever the column:
 * a Task or Report title is at most 500 characters, but a Phase name and a
 * Group name have no length limit at all. The ORDER BY, the keyset comparison
 * and the issued key all use the same cut expression, and the grant id breaks
 * every tie, so rows whose keys agree on the first GRANT_SORT_KEY_MAX_CHARS
 * characters are ordered by id and the walk still returns each row once.
 */
export const GRANT_SORT_KEY_MAX_CHARS = 512;
/** A timestamp key is PostgreSQL's text form of a timestamptz, or `infinity`. */
export const GRANT_TIMESTAMP_KEY_MAX_CHARS = 64;
/** The cursor's JSON envelope apart from its key: the sort name, the id, punctuation. */
const CURSOR_ENVELOPE_BYTES = 128;
/**
 * The longest cursor the server can ISSUE, derived from the key bound: JSON
 * writes one character of the key in at most six bytes (a control character
 * becomes a \u escape; any other character is at most four UTF-8 bytes), and
 * base64url writes every three bytes as four characters. Every cursor this
 * list hands out fits; anything longer was not issued here and is refused.
 */
export const GRANT_CURSOR_MAX_LENGTH = 'gc1.'.length
  + Math.ceil((GRANT_SORT_KEY_MAX_CHARS * 6 + CURSOR_ENVELOPE_BYTES) / 3) * 4;

const boundedText = (expr: string) => `left(${expr}, ${GRANT_SORT_KEY_MAX_CHARS})`;

/** Sort key per sort name: the SQL expression, its SQL type and direction. */
const SORT_KEYS: Record<string, { expr: string; type: 'timestamptz' | 'text' }> = {
  created: { expr: 'c.created_at', type: 'timestamptz' },
  grantee: { expr: boundedText('lower(COALESCE(c.grantee_name, c.grantee_id::text))'), type: 'text' },
  resource: { expr: boundedText("(c.resource_type || ':' || lower(COALESCE(c.target_label, c.resource_id::text, '')))"), type: 'text' },
  verb: { expr: boundedText('c.verb'), type: 'text' },
  expires: { expr: "COALESCE(c.expires_at, 'infinity'::timestamptz)", type: 'timestamptz' },
};

function sortParts(sort: GrantSort): { key: { expr: string; type: 'timestamptz' | 'text' }; desc: boolean } {
  const desc = sort.startsWith('-');
  return { key: SORT_KEYS[desc ? sort.slice(1) : sort], desc };
}

export function encodeGrantCursor(sort: GrantSort, key: string, id: string): string {
  return 'gc1.' + Buffer.from(JSON.stringify([sort, key, id]), 'utf8').toString('base64url');
}

const cursorRefusal = () => err(400, 'INVALID_QUERY_VALUE', 'cursor is not a cursor this list issued for this sort', 'cursor');

/** A cursor is bound to the sort it was issued for: reusing it under another
 * sort would compare the wrong key, so it is refused rather than misread. Its
 * size is checked against what the server can issue: the whole cursor against
 * GRANT_CURSOR_MAX_LENGTH, and the decoded key against the bound of ITS sort
 * (a text key GRANT_SORT_KEY_MAX_CHARS characters, a timestamp key
 * GRANT_TIMESTAMP_KEY_MAX_CHARS), so every issued cursor is accepted and a
 * forged oversize one is refused by name. */
export function decodeGrantCursor(cursor: string, sort: GrantSort): { key: string; id: string } {
  if (typeof cursor !== 'string' || !cursor.startsWith('gc1.') || cursor.length > GRANT_CURSOR_MAX_LENGTH) throw cursorRefusal();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor.slice(4), 'base64url').toString('utf8'));
  } catch {
    throw cursorRefusal();
  }
  if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== sort
    || typeof parsed[1] !== 'string' || typeof parsed[2] !== 'string' || !UUID_PATTERN.test(parsed[2])) {
    throw cursorRefusal();
  }
  const keyType = SORT_KEYS[sort.startsWith('-') ? sort.slice(1) : sort]?.type;
  if (!keyType) throw cursorRefusal();
  // Counted in characters (code points), as PostgreSQL's left() counts them.
  const keyChars = Array.from(parsed[1]).length;
  if (keyChars > (keyType === 'text' ? GRANT_SORT_KEY_MAX_CHARS : GRANT_TIMESTAMP_KEY_MAX_CHARS)) throw cursorRefusal();
  return { key: parsed[1], id: parsed[2] };
}

/** PostgreSQL's answer to a key it cannot take as the sort's type: an invalid
 * or out-of-range timestamp, or a character the database cannot store. Only a
 * forged cursor carries one, so it is refused like any cursor not issued here. */
const CURSOR_KEY_SQLSTATES = new Set(['22007', '22008', '22021', '22P05']);

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback: T): T {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw err(400, 'INVALID_QUERY_VALUE', `${field} must be one of: ${allowed.join(', ')}`, field);
  }
  return value as T;
}

/** Parses the route's query object. Every parameter is additive: with none of
 * them the read is the legacy unbounded list in creation order. */
export function parseGrantListQuery(query: Record<string, unknown>): GrantListQuery {
  const paged = query.limit !== undefined || query.cursor !== undefined;
  let limit: number | null = null;
  if (paged) {
    if (query.limit === undefined) limit = GRANT_PAGE_DEFAULT_LIMIT;
    else {
      const raw = String(query.limit);
      if (!/^[0-9]{1,4}$/.test(raw) || Number(raw) < 1 || Number(raw) > GRANT_PAGE_MAX_LIMIT) {
        throw err(400, 'INVALID_QUERY_VALUE', `limit must be an integer from 1 to ${GRANT_PAGE_MAX_LIMIT}`, 'limit');
      }
      limit = Number(raw);
    }
  }
  const sort = oneOf(query.sort, GRANT_SORTS, 'sort', paged ? '-created' : 'created');
  const made = oneOf(query.made, [...GRANT_MADE_CLASSES, 'all'] as const, 'made', 'all');
  const expiry = oneOf(query.expiry, GRANT_EXPIRY_FILTERS, 'expiry', 'any');
  const target = oneOf(query.target, GRANT_TARGET_FILTERS, 'target', 'any');
  if (query.granteeId !== undefined && (typeof query.granteeId !== 'string' || !UUID_PATTERN.test(query.granteeId))) {
    throw err(400, 'INVALID_QUERY_VALUE', 'granteeId must be a full UUID', 'granteeId');
  }
  if (query.resourceType !== undefined
    && (typeof query.resourceType !== 'string' || !(GRANT_RESOURCE_TYPES as readonly string[]).includes(query.resourceType))) {
    throw err(400, 'INVALID_QUERY_VALUE', `resourceType must be one of: ${GRANT_RESOURCE_TYPES.join(', ')}`, 'resourceType');
  }
  if (query.verb !== undefined && (typeof query.verb !== 'string' || !(GRANT_VERBS as readonly string[]).includes(query.verb))) {
    throw err(400, 'INVALID_QUERY_VALUE', `verb must be one of: ${GRANT_VERBS.join(', ')}`, 'verb');
  }
  let q: string | undefined;
  if (query.q !== undefined) {
    if (typeof query.q !== 'string' || query.q.length > MAX_SEARCH_LENGTH) {
      throw err(400, 'INVALID_QUERY_VALUE', `q must be text of at most ${MAX_SEARCH_LENGTH} characters`, 'q');
    }
    q = query.q.trim() || undefined;
  }
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== 'string') throw err(400, 'INVALID_QUERY_VALUE', 'cursor must be text', 'cursor');
    decodeGrantCursor(query.cursor, sort);
  }
  return {
    limit, sort, made, expiry, target, q,
    cursor: query.cursor as string | undefined,
    granteeId: query.granteeId as string | undefined,
    resourceType: query.resourceType as string | undefined,
    verb: query.verb as string | undefined,
  };
}

/**
 * THE CLASSIFIED ROW SET: every grant with its origin class, the evidence,
 * its grantee's name and its target's label and state. One SELECT, joined
 * through indexes the board already has: the audit lookups ride
 * `ix_audit_events_resource_order (resource_type, resource_id, …)`.
 */
const CLASSIFIED_SQL = `
  SELECT g.*,
    COALESCE(gp.handle, grp.name) AS grantee_name,
    gp.display_name AS grantee_display_name,
    grp.name AS grantee_group_name,
    gb.handle AS granter_handle,
    COALESCE(t.title, r.title, p.name, ph.name) AS target_label,
    COALESCE(t.status, r.status, p.status, ph.status) AS target_status,
    CASE
      WHEN g.resource_id IS NULL THEN 'wildcard'
      WHEN g.resource_type NOT IN ('task', 'report', 'project', 'phase') THEN 'unchecked'
      WHEN COALESCE(t.id, r.id, p.id, ph.id) IS NULL THEN 'missing'
      WHEN COALESCE(t.status, r.status, p.status, ph.status) = 'archived' THEN 'archived'
      ELSE 'live'
    END AS target_state,
    CASE
      WHEN g.provenance IS NOT NULL OR g.origin <> 'manual' THEN 'system'
      WHEN policy.action IS NOT NULL THEN 'system'
      WHEN g.approval_id IS NOT NULL THEN 'hand'
      WHEN made.automatic THEN 'system'
      WHEN made.found THEN 'hand'
      ELSE 'unknown'
    END AS made_class,
    CASE
      WHEN g.provenance = 'assignment:warrant' THEN 'warrant'
      WHEN g.provenance IS NOT NULL THEN 'assignment'
      WHEN g.origin = 'creation-default' THEN 'project-default'
      WHEN g.origin = 'steward' THEN 'steward'
      WHEN policy.action IS NOT NULL THEN policy.action
      WHEN g.approval_id IS NOT NULL THEN 'approval'
      WHEN made.automatic THEN 'automatic'
      WHEN made.found THEN 'direct'
      ELSE NULL
    END AS made_via,
    CASE
      WHEN g.provenance IS NOT NULL OR g.origin <> 'manual' OR g.approval_id IS NOT NULL THEN 'column'
      WHEN policy.action IS NOT NULL OR made.found THEN 'audit'
      ELSE 'none'
    END AS made_evidence
  FROM grants g
  LEFT JOIN principals gp ON g.grantee_type = 'principal' AND gp.id = g.grantee_id
  LEFT JOIN groups grp ON g.grantee_type = 'group' AND grp.id = g.grantee_id
  LEFT JOIN principals gb ON gb.id = g.granted_by_principal_id
  LEFT JOIN tasks t ON g.resource_type = 'task' AND t.id = g.resource_id
  LEFT JOIN reports r ON g.resource_type = 'report' AND r.id = g.resource_id
  LEFT JOIN projects p ON g.resource_type = 'project' AND p.id = g.resource_id
  LEFT JOIN phases ph ON g.resource_type = 'phase' AND ph.id = g.resource_id
  LEFT JOIN LATERAL (
    SELECT CASE a.action
             WHEN 'task.creator_access' THEN 'task-creator'
             WHEN 'task.sponsor_access' THEN 'task-sponsor'
             WHEN 'report.creator_access' THEN 'report-creator'
             WHEN 'report.sponsor_access' THEN 'report-sponsor'
             ELSE 'project-creator'
           END AS action
      FROM audit_events a
     WHERE g.resource_id IS NOT NULL
       AND a.resource_type = g.resource_type
       AND a.resource_id = g.resource_id::text
       AND a.action IN ('task.creator_access', 'task.sponsor_access', 'report.creator_access',
                        'report.sponsor_access', 'project.creator_access')
       AND a.outcome = 'success'
       AND a.metadata->>'grantId' = g.id::text
     LIMIT 1
  ) policy ON TRUE
  LEFT JOIN LATERAL (
    SELECT TRUE AS found, (a.metadata->'automatic') = 'true'::jsonb AS automatic
      FROM audit_events a
     WHERE a.resource_type = 'grant'
       AND a.resource_id = g.id::text
       AND a.action = 'grant.create'
       AND a.outcome = 'success'
     ORDER BY a.occurred_at ASC, a.id ASC
     LIMIT 1
  ) made ON TRUE`;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** Builds the WHERE clause over the classified set `c`. `skipMade` leaves out
 * the origin filter, for the per-class counts. */
function filterClause(query: GrantListQuery, params: unknown[], skipMade = false): string {
  const clauses: string[] = [];
  const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
  if (!skipMade && query.made !== 'all') clauses.push(`c.made_class = ${bind(query.made)}`);
  if (query.granteeId) clauses.push(`c.grantee_id = ${bind(query.granteeId)}::uuid`);
  if (query.resourceType) clauses.push(`c.resource_type = ${bind(query.resourceType)}`);
  if (query.verb) clauses.push(`c.verb = ${bind(query.verb)}`);
  switch (query.expiry) {
    case 'none': clauses.push('c.expires_at IS NULL'); break;
    case 'live': clauses.push('(c.expires_at IS NULL OR c.expires_at > NOW())'); break;
    case 'expired': clauses.push('c.expires_at IS NOT NULL AND c.expires_at <= NOW()'); break;
    case 'expiring':
      clauses.push(`c.expires_at > NOW() AND c.expires_at <= NOW() + make_interval(days => ${bind(GRANT_EXPIRING_SOON_DAYS)}::int)`);
      break;
    default: break;
  }
  if (query.target !== 'any') clauses.push(`c.target_state = ${bind(query.target)}`);
  if (query.q) {
    const needle = bind(`%${escapeLike(query.q.toLowerCase())}%`);
    clauses.push(`(lower(COALESCE(c.grantee_name, '')) LIKE ${needle} ESCAPE '\\'`
      + ` OR lower(COALESCE(c.grantee_display_name, '')) LIKE ${needle} ESCAPE '\\'`
      + ` OR lower(COALESCE(c.granter_handle, '')) LIKE ${needle} ESCAPE '\\'`
      + ` OR lower(COALESCE(c.target_label, '')) LIKE ${needle} ESCAPE '\\'`
      + ` OR c.resource_id::text LIKE ${needle} ESCAPE '\\'`
      + ` OR c.id::text LIKE ${needle} ESCAPE '\\')`);
  }
  return clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
}

function mapListRow(row: any): GrantListRow {
  return {
    id: row.id,
    granteeType: row.grantee_type,
    granteeId: row.grantee_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id ?? null,
    verb: row.verb,
    grantedByPrincipalId: row.granted_by_principal_id ?? null,
    expiresAt: row.expires_at ?? null,
    createdAt: row.created_at,
    origin: row.origin ?? 'manual',
    madeBy: { class: row.made_class, via: row.made_via ?? null, evidence: row.made_evidence },
    target: { label: row.target_label ?? null, status: row.target_status ?? null, state: row.target_state },
    ...(row.grantee_type === 'group' ? { granteeGroup: { id: row.grantee_id, name: row.grantee_group_name ?? null } } : {}),
  };
}

/** The statement for one page, exported so a live test can EXPLAIN exactly it. */
export function buildGrantPageStatement(query: GrantListQuery): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const { key, desc } = sortParts(query.sort);
  const where = filterClause(query, params);
  let keyset = '';
  if (query.cursor) {
    const position = decodeGrantCursor(query.cursor, query.sort);
    params.push(position.key);
    const keyParam = `$${params.length}::${key.type}`;
    params.push(position.id);
    const idParam = `$${params.length}::uuid`;
    keyset = `${where ? ' AND' : 'WHERE'} (${key.expr}, c.id) ${desc ? '<' : '>'} (${keyParam}, ${idParam})`;
  }
  const direction = desc ? 'DESC' : 'ASC';
  let limitSql = '';
  if (query.limit !== null) {
    params.push(query.limit + 1);
    limitSql = `LIMIT $${params.length}`;
  }
  const sql = `SELECT c.*, (${key.expr})::text AS sort_key FROM (${CLASSIFIED_SQL}) c
    ${where}${keyset}
    ORDER BY ${key.expr} ${direction}, c.id ${direction}
    ${limitSql}`;
  return { sql, params };
}

export class GrantListService {
  async page(query: GrantListQuery): Promise<GrantListPage> {
    const statement = buildGrantPageStatement(query);
    let result;
    try {
      result = await pool.query(statement.sql, statement.params);
    } catch (e) {
      if (query.cursor && CURSOR_KEY_SQLSTATES.has(String((e as { code?: unknown })?.code ?? ''))) throw cursorRefusal();
      throw e;
    }
    const rows = query.limit === null ? result.rows : result.rows.slice(0, query.limit);
    const hasMore = query.limit !== null && result.rows.length > query.limit;
    const last = rows[rows.length - 1];

    const countParams: unknown[] = [];
    const countWhere = filterClause(query, countParams);
    const total = Number((await pool.query(
      `SELECT count(*)::int AS total FROM (${CLASSIFIED_SQL}) c ${countWhere}`, countParams)).rows[0].total);

    let madeCounts: Record<GrantMadeClass, number> | undefined;
    if (!query.cursor) {
      const classParams: unknown[] = [];
      const classWhere = filterClause(query, classParams, true);
      const byClass = await pool.query(
        `SELECT c.made_class, count(*)::int AS n FROM (${CLASSIFIED_SQL}) c ${classWhere} GROUP BY c.made_class`, classParams);
      madeCounts = { hand: 0, system: 0, unknown: 0 };
      for (const row of byClass.rows) madeCounts[row.made_class as GrantMadeClass] = Number(row.n);
    }
    return {
      grants: rows.map(mapListRow),
      pagination: {
        limit: query.limit,
        sort: query.sort,
        returned: rows.length,
        total,
        hasMore,
        nextCursor: hasMore && last ? encodeGrantCursor(query.sort, String(last.sort_key), String(last.id)) : null,
      },
      ...(madeCounts ? { madeCounts } : {}),
    };
  }
}

export const grantListService = new GrantListService();
