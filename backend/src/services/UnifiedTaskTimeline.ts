// UnifiedTaskTimeline.ts — the C1 merged Task timeline read (RH-UI.7,
// ratified design 3cdf6e65 §4.1). Read-only: no new tables, no writes.
//
// Four sources, one deterministic order, keyset pagination:
//   1. task_stream_entries — the ledger of record (visibility + redaction
//      exactly as GET /tasks/:id/stream applies them; the caller passes the
//      rows it is allowed to see).
//   2. task_history — ONLY rows not already represented in the stream
//      (migration 086 backfilled the pre-086 ledger as provenance='legacy'
//      rows carrying legacy_source='task_history'; the exclusion below is the
//      dedup rule).
//   3. task.reviewHistory — synthesized review events, stable ids.
//   4. Legacy sessionRefs — synthesized with STABLE timestamps
//      (task.startedAt || task.created; never task.updated, which moves on
//      every write).
//
// Attribution honesty: each source maps only what it truly stores.
// `actorDetail` is per-source-nullable and never derives role-at-event-time
// from current assignments. The legacy `actor` field stays a display string
// because the live TaskDetailModal renders it directly (additive
// compatibility, §4.1); the structured record is the NEW field. Deviations
// from the §4.1 envelope sketch (actor split, `description` kept over
// `detail`) are recorded in the C1 candidate report per §4.3.

import { pool } from '../db/connection';
import type { Task } from './TaskManagerDB';
import { logCaughtFailure } from '../utils/secretSafeLog';

export type TimelineSource = 'stream' | 'history' | 'review' | 'session';
export type TimelineProvenance = 'system' | 'authored' | 'reported' | 'legacy';
export type TimelineFilter = 'all' | 'handover' | 'system';

export interface UnifiedTimelineActorDetail {
  principalId: string | null;
  handle: string | null;
  role: string | null;
}

export interface UnifiedTimelineEvent {
  /** Stable per-source id (stream row uuid, `history-<n>`, `review-<id>`, `legacy-session-…`). */
  id: string;
  /** Event instant, ISO8601. `createdAt` mirrors it for the legacy consumer. */
  at: string;
  createdAt: string;
  source: TimelineSource;
  provenance: TimelineProvenance;
  eventType: string;
  title: string;
  description: string | null;
  /** Display string only (legacy modal contract). Never fabricated. */
  actor: string | null;
  /** Structured attribution; fields are null wherever the source stores none. */
  actorDetail: UnifiedTimelineActorDetail | null;
  sessionKey: string | null;
  harness: string | null;
  metadata: Record<string, any>;
  redaction?: { mode: string; redactedAt: string } | null;
}

export interface UnifiedTimelineResult {
  events: UnifiedTimelineEvent[];
  /** Source names whose read failed — "failed" must be distinguishable from "empty". */
  sourcesUnavailable: TimelineSource[];
  nextCursor: string | null;
}

export interface UnifiedTimelineOptions {
  filter: TimelineFilter;
  before: string | null;
  limit: number;
}

const iso = (value: any): string => {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
};

/** §3.6 taxonomy: which filter view an event belongs to. Unknown, future,
 *  and plugin event types classify as null and appear only under filter=all
 *  (the fallback lane) — on every provenance, including reported/system. */
const HANDOVER_TYPE = /^(handover|report)(\.|$)/;
// Known stream system/ownership types — an EXPLICIT enumeration, not a
// pattern: the lifecycle verbs core emits today plus the 086 legacy-backfill
// field-change names (task_history / frozen task_timeline_events vocabulary).
// A future core verb is by definition unknown here and stays All-only until
// this set is extended in the same change that introduces the verb.
const KNOWN_SYSTEM_TYPES = new Set([
  'task.claimed', 'task.released', 'task.transitioned',
  'task.status_changed', 'task.priority_changed', 'task.notes_updated',
  'task.created', 'task.field_changed', 'task.arm', 'task.park',
  'session.reference',
  // 086 legacy-backfill field names
  'status', 'priority', 'notes', 'title', 'subtask', 'created', 'autoStart',
  'archived', 'claimed', 'released',
]);
// Known outpost telemetry shapes (reported provenance → System & ownership).
const KNOWN_REPORTED_TYPE = /^(outpost|session|telemetry|progress|safety)(\.|$)/;

export function timelineView(event: Pick<UnifiedTimelineEvent, 'source' | 'provenance' | 'eventType'>): 'handover' | 'system' | null {
  switch (event.source) {
    case 'review': return 'handover';
    case 'session': return 'system';
    case 'history': return 'system';
    case 'stream': {
      const type = event.eventType || '';
      // Report created/linked/auto-promoted and atomic handbacks belong to
      // Handovers & reports regardless of provenance (§3.6 rows 4, 7).
      if (HANDOVER_TYPE.test(type)) return 'handover';
      if (event.provenance === 'authored') return 'handover';
      if (event.provenance === 'reported') {
        return KNOWN_REPORTED_TYPE.test(type) ? 'system' : null;
      }
      // system + legacy: only the known vocabulary classifies; anything else
      // (future core verbs, plugin:ns:kind types) is All-only.
      return KNOWN_SYSTEM_TYPES.has(type) ? 'system' : null;
    }
    default: return null;
  }
}

/** Deterministic total order: at DESC, then source, then id DESC.
 *  Every synthesized timestamp is stable by construction, so pages cannot
 *  duplicate or drop events between fetches. */
function compareEvents(a: UnifiedTimelineEvent, b: UnifiedTimelineEvent): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

interface CursorTriple { at: string; source: string; id: string }

export function encodeCursor(event: UnifiedTimelineEvent): string {
  return Buffer.from(JSON.stringify({ at: event.at, source: event.source, id: event.id }), 'utf8').toString('base64url');
}

const CURSOR_SOURCES: readonly string[] = ['stream', 'history', 'review', 'session'];

export function decodeCursor(raw: string): CursorTriple | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    // The cursor is a previously returned tuple; `at` therefore has exactly
    // the canonical ISO-8601 UTC instant form toISOString() emits. Date.parse
    // alone accepts human-readable and date-only strings — insufficient.
    // toISOString() always emits exactly three fractional digits; anything
    // else can never be a previously returned cursor, and a same-instant
    // string variant would break lexicographic keyset comparison.
    const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    if (
      typeof parsed?.at === 'string' && ISO_INSTANT.test(parsed.at) && Number.isFinite(Date.parse(parsed.at))
      && typeof parsed?.source === 'string' && CURSOR_SOURCES.includes(parsed.source)
      && typeof parsed?.id === 'string' && parsed.id.length > 0
    ) {
      return parsed as CursorTriple;
    }
    return null;
  } catch {
    return null;
  }
}

/** True when `event` sorts strictly AFTER the cursor position (older page). */
function afterCursor(event: UnifiedTimelineEvent, cursor: CursorTriple): boolean {
  const probe = { at: cursor.at, source: cursor.source as TimelineSource, id: cursor.id } as UnifiedTimelineEvent;
  return compareEvents(event, probe) > 0;
}

// ---------------------------------------------------------------------------
// Source mappers

function humanizeStreamType(eventType: string): string {
  switch (eventType) {
    case 'handover.finish': return 'Atomic handback finished';
    case 'task.transitioned': return 'Task transitioned';
    case 'task.claimed': return 'Task claimed';
    case 'task.released': return 'Task released';
    case 'status': return 'Status changed';
    default: return eventType.replace(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  }
}

export function mapStreamRow(row: any): UnifiedTimelineEvent {
  const at = iso(row.created_at);
  const redacted = row.redacted_at != null;
  return {
    id: String(row.id),
    at,
    createdAt: at,
    source: 'stream',
    provenance: (row.provenance || 'system') as TimelineProvenance,
    eventType: String(row.event_type || ''),
    title: humanizeStreamType(String(row.event_type || '')),
    // Redacted entries surface as attributed tombstones; the ledger stores the
    // redacted form, and tombstone/author-erasure modes suppress content here.
    description: redacted && row.redaction_mode !== 'span'
      ? null
      : (row.content ? String(row.content) : null),
    actor: row.author_handle ? String(row.author_handle) : null,
    actorDetail: (row.author_principal_id || row.author_handle || row.author_role)
      ? {
        principalId: row.author_principal_id ? String(row.author_principal_id) : null,
        handle: row.author_handle ? String(row.author_handle) : null,
        role: row.author_role ? String(row.author_role) : null,
      }
      : null,
    sessionKey: null,
    harness: null,
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    redaction: redacted ? { mode: String(row.redaction_mode), redactedAt: iso(row.redacted_at) } : null,
  };
}

function historyTitle(field: string, oldValue: string | null, newValue: string | null): string {
  switch (field) {
    case 'status': return `Status changed${oldValue || newValue ? `: ${oldValue ?? '—'} → ${newValue ?? '—'}` : ''}`;
    case 'priority': return `Priority changed${oldValue || newValue ? `: ${oldValue ?? '—'} → ${newValue ?? '—'}` : ''}`;
    case 'notes': return 'Notes updated';
    case 'autoStart': return newValue === 'true' ? 'Task armed' : 'Task parked';
    case 'created': return 'Task created';
    default: return `Field changed: ${field}`;
  }
}

function historyEventType(field: string, newValue: string | null): string {
  switch (field) {
    case 'status': return 'task.status_changed';
    case 'priority': return 'task.priority_changed';
    case 'notes': return 'task.notes_updated';
    case 'autoStart': return newValue === 'true' ? 'task.arm' : 'task.park';
    case 'created': return 'task.created';
    default: return 'task.field_changed';
  }
}

export function mapHistoryRow(row: any): UnifiedTimelineEvent {
  const field = String(row.field ?? row.event_type ?? 'field');
  const at = iso(row.created_at);
  // changed_by (older schema generation) stores constants like 'system' —
  // display text, not an identity. The note-embedded changedBy= marker is the
  // newer generation's display equivalent. actor_principal_id (063) is the
  // only authoritative identity and is null for pre-063 rows.
  const noteMatch = typeof row.note === 'string' ? row.note.match(/changedBy=([^|]+)/) : null;
  const displayActor = row.changed_by ? String(row.changed_by) : (noteMatch?.[1]?.trim() || null);
  return {
    id: `history-${row.id}`,
    at,
    createdAt: at,
    source: 'history',
    provenance: 'system',
    eventType: historyEventType(field, row.new_value == null ? null : String(row.new_value)),
    title: historyTitle(field, row.old_value == null ? null : String(row.old_value), row.new_value == null ? null : String(row.new_value)),
    description: null,
    actor: displayActor,
    // Structured attribution comes ONLY from the authenticated 063 column.
    // changed_by / note markers are unauthenticated display text and must
    // never be promoted into an identity record.
    actorDetail: row.actor_principal_id
      ? { principalId: String(row.actor_principal_id), handle: null, role: null }
      : null,
    sessionKey: null,
    harness: null,
    metadata: {
      field,
      oldValue: row.old_value ?? null,
      newValue: row.new_value ?? null,
    },
    redaction: null,
  };
}

// ---------------------------------------------------------------------------

export class UnifiedTaskTimeline {
  /** Post-086 task_history rows NOT already represented in the stream.
   *  Dedup rule (§4.1): exclude rows whose id appears as
   *  legacy_source='task_history' ∧ legacy_source_id in the stream backfill.
   *  Column-sniffed like TaskHistoryService: both live schema generations
   *  (field/changed_by/task_title vs event_type/note) are read. */
  async listHistoryNotInStream(taskId: string): Promise<any[]> {
    const columnsResult = await pool.query(
      `SELECT attname AS column_name FROM pg_attribute
        WHERE attrelid = to_regclass('task_history') AND attnum > 0 AND NOT attisdropped`
    );
    const columns = new Set(columnsResult.rows.map((row: any) => String(row.column_name)));
    if (columns.size === 0) return [];
    const fieldExpr = columns.has('field') ? 'h.field' : 'h.event_type AS field';
    const changedByExpr = columns.has('changed_by') ? 'h.changed_by' : 'NULL AS changed_by';
    const noteExpr = columns.has('note') ? 'h.note' : 'NULL AS note';
    const actorExpr = columns.has('actor_principal_id') ? 'h.actor_principal_id' : 'NULL AS actor_principal_id';
    const result = await pool.query(
      `SELECT h.id, ${fieldExpr}, h.old_value, h.new_value, ${changedByExpr}, ${noteExpr}, ${actorExpr}, h.created_at
         FROM task_history h
        WHERE h.task_id::text = $1
          AND NOT EXISTS (
            SELECT 1 FROM task_stream_entries s
             WHERE s.legacy_source = 'task_history'
               AND s.legacy_source_id = h.id::text
          )
        ORDER BY h.created_at DESC, h.id DESC`,
      [taskId]
    );
    return result.rows;
  }

  buildReviewEvents(task: Task): UnifiedTimelineEvent[] {
    const entries = Array.isArray((task as any).reviewHistory) ? (task as any).reviewHistory : [];
    return entries.map((entry: any, index: number) => {
      // Stable timestamp: never task.updated (moves on every write).
      const at = iso(entry?.completedAt || entry?.createdAt || entry?.at || (task as any).startedAt || task.created);
      const decision = typeof entry?.decision === 'string' ? entry.decision
        : typeof entry?.outcome === 'string' ? entry.outcome : 'unknown';
      const triggeredBy = typeof entry?.triggeredBy === 'string' && entry.triggeredBy.trim() ? entry.triggeredBy.trim() : null;
      return {
        id: `review-${entry?.id ?? index}`,
        at,
        createdAt: at,
        source: 'review' as const,
        provenance: 'system' as const,
        eventType: `review.${/^(pass|passed)$/.test(decision) ? 'pass' : /^(reject|rejected)$/.test(decision) ? 'reject' : /escalat/.test(decision) ? 'escalate' : decision === 'running' ? 'running' : 'unknown'}`,
        title: `Verifier decision: ${decision}`,
        description: typeof entry?.summary === 'string' && entry.summary.trim() ? entry.summary.trim() : null,
        // triggeredBy is 'user'|'agent'|'system' — a category, not a principal.
        actor: triggeredBy,
        actorDetail: null,
        sessionKey: entry?.evidence?.completedBy?.sessionKey || null,
        harness: entry?.evidence?.completedBy?.harness || null,
        metadata: {
          decision,
          findings: entry?.findings,
          statusBefore: entry?.statusBefore,
          statusAfter: entry?.statusAfter,
          attemptCount: entry?.attemptCount,
        },
        redaction: null,
      };
    });
  }

  buildSessionEvents(task: Task): UnifiedTimelineEvent[] {
    // Stable by construction: startedAt/created never move after the fact.
    const at = iso((task as any).startedAt || task.created);
    return (task.sessionRefs || []).map((sessionKey: string) => ({
      id: `legacy-session-${task.id}-${sessionKey}`,
      at,
      createdAt: at,
      source: 'session' as const,
      provenance: 'legacy' as const,
      eventType: 'session.reference',
      title: 'Legacy session reference',
      description: 'Captured before durable task stream entries were enabled.',
      actor: null,
      actorDetail: null,
      sessionKey,
      harness: null,
      metadata: {},
      redaction: null,
    }));
  }

  /** Merge, classify, order, and paginate. `streamRows` are the rows the
   *  caller was authorized to see (listStream applies visibility). */
  merge(
    task: Task,
    streamRows: any[] | Error,
    historyRows: any[] | Error,
    options: UnifiedTimelineOptions,
  ): UnifiedTimelineResult {
    const sourcesUnavailable: TimelineSource[] = [];
    const events: UnifiedTimelineEvent[] = [];

    if (streamRows instanceof Error) sourcesUnavailable.push('stream');
    else events.push(...streamRows.map(mapStreamRow));

    if (historyRows instanceof Error) sourcesUnavailable.push('history');
    else events.push(...historyRows.map(mapHistoryRow));

    try {
      events.push(...this.buildReviewEvents(task));
    } catch (err) {
      logCaughtFailure('[UnifiedTaskTimeline] review synthesis failed', err);
      sourcesUnavailable.push('review');
    }
    try {
      events.push(...this.buildSessionEvents(task));
    } catch (err) {
      logCaughtFailure('[UnifiedTaskTimeline] session synthesis failed', err);
      sourcesUnavailable.push('session');
    }

    events.sort(compareEvents);

    const filtered = options.filter === 'all'
      ? events
      : events.filter((event) => timelineView(event) === options.filter);

    const cursor = options.before ? decodeCursor(options.before) : null;
    const positioned = cursor ? filtered.filter((event) => afterCursor(event, cursor)) : filtered;

    const page = positioned.slice(0, options.limit);
    const nextCursor = positioned.length > options.limit && page.length > 0
      ? encodeCursor(page[page.length - 1])
      : null;

    return { events: page, sourcesUnavailable, nextCursor };
  }
}

export const unifiedTaskTimeline = new UnifiedTaskTimeline();
