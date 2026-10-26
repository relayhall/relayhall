/** Render governed Task history returned by the existing REST routes. */
import { budgetText, json, pageOf, responseFormatOf, sections, TEXT_BUDGET, untrusted } from './shape';

type Row = Record<string, unknown>;

function records(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter((row): row is Row => !!row && typeof row === 'object' && !Array.isArray(row)) : [];
}

function continuation(args: Row): number {
  const value = Number(args.continue_from ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function visibleStreamRow(row: Row): Row {
  // The timeline mapper suppresses tombstone/author-erasure content. Apply
  // the same rule to this raw-stream reader even if a legacy REST row carries
  // pre-redaction text; span redaction contains only the edited text.
  return row.redacted_at != null && row.redaction_mode !== 'span'
    ? { ...row, content: null }
    : row;
}

function conciseStreamRow(row: Row): Row {
  const safe = visibleStreamRow(row);
  return {
    id: safe.id, stream_offset: safe.stream_offset, created_at: safe.created_at,
    event_type: safe.event_type, provenance: safe.provenance,
    author_principal_id: safe.author_principal_id, author_handle: safe.author_handle,
    referenced_entry_id: safe.referenced_entry_id,
    redacted_at: safe.redacted_at, redaction_mode: safe.redaction_mode,
    content: safe.content,
  };
}

/** The REST list is already object- and entry-filtered; page only those rows. */
export function renderTaskStreamPage(args: Row, taskId: string, envelope: Row): string {
  const all = records(envelope.entries);
  const { limit, offset } = pageOf(args);
  const page = all.slice(offset, offset + limit);
  const nextOffset = offset + page.length < all.length ? offset + page.length : null;
  const detailed = responseFormatOf(args) === 'detailed';
  const payload = {
    taskId, entries: page.map((row) => detailed ? visibleStreamRow(row) : conciseStreamRow(row)),
    pagination: { limit, offset, total: all.length, returned: page.length, hasMore: nextOffset !== null, nextOffset },
  };
  const body = json(payload);
  const start = continuation(args);
  const textStatus = start + TEXT_BUDGET < body.length
    ? `text continues at continue_from=${start + TEXT_BUDGET}` : 'text complete';
  return sections(
    `Task ${taskId} stream: ${page.length} of ${all.length} visible entries; ${nextOffset === null ? 'row page complete' : `next offset=${nextOffset}`}; ${textStatus}.`,
    untrusted(`Task ${taskId} stream page`, budgetText(body, start)),
  );
}

function conciseTimelineEvent(row: Row): Row {
  return {
    id: row.id, at: row.at, source: row.source, provenance: row.provenance,
    eventType: row.eventType, title: row.title, description: row.description,
    actor: row.actor, actorDetail: row.actorDetail, redaction: row.redaction,
  };
}

/** Keep REST's keyset cursor and partial-source indicators intact. */
export function renderTaskTimelinePage(args: Row, taskId: string, envelope: Row): string {
  const events = records(envelope.events);
  const payload = {
    taskId, filter: envelope.filter, events: responseFormatOf(args) === 'detailed'
      ? events : events.map(conciseTimelineEvent),
    nextCursor: envelope.nextCursor ?? null,
    sourcesUnavailable: envelope.sourcesUnavailable ?? [],
    ...(envelope.sourceErrorIds ? { sourceErrorIds: envelope.sourceErrorIds } : {}),
  };
  const body = json(payload);
  const start = continuation(args);
  const textStatus = start + TEXT_BUDGET < body.length
    ? `text continues at continue_from=${start + TEXT_BUDGET}` : 'text complete';
  return sections(
    `Task ${taskId} timeline: ${events.length} events; ${payload.nextCursor ? 'more via nextCursor' : 'row page complete'}; ${textStatus}; ${Array.isArray(payload.sourcesUnavailable) && payload.sourcesUnavailable.length ? `sources unavailable: ${payload.sourcesUnavailable.join(', ')}` : 'all sources available'}.`,
    untrusted(`Task ${taskId} timeline page`, budgetText(body, start)),
  );
}
