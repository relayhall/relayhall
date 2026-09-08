import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { authenticatedFetch } from '../../utils/auth';
import { timelineRendererFor } from './taskTimelineRendererRegistry';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Button } from '../Button';
import { IconButton } from '../ui/IconButton';
import type { DirectoryPrincipal } from '../principals/principalDirectory';
import { formatDateTime, formatDayLabel } from '../../utils/dateFormat';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

export type TimelineSource = 'stream' | 'history' | 'review' | 'session';
export type TimelineProvenance = 'system' | 'authored' | 'reported' | 'legacy';

export type TimelineFilter = 'all' | 'handover' | 'system';

const TIMELINE_FILTERS: ReadonlyArray<{ value: TimelineFilter; label: string }> = [
  { value: 'all', label: 'All activity' },
  { value: 'handover', label: 'Handovers & reports' },
  { value: 'system', label: 'System & ownership' },
];

const MAX_ANCHOR_SEARCH_PAGES = 20;
const OWNER_ROLE_LABELS: Readonly<Record<string, string>> = {
  claimant: 'Assignee',
  shepherd: 'Shepherd',
  verifier: 'Verifier',
};

export interface TimelineEvent {
  id: string;
  at: string;
  createdAt: string;
  source: TimelineSource;
  provenance: TimelineProvenance;
  eventType: string;
  title: string;
  description: string | null;
  actor: string | null;
  actorDetail: { principalId: string | null; handle: string | null; role: string | null } | null;
  sessionKey: string | null;
  harness: string | null;
  metadata: Record<string, unknown>;
  redaction?: { mode: string; redactedAt: string } | null;
}

interface TimelinePage {
  events: TimelineEvent[];
  sourcesUnavailable: TimelineSource[];
  nextCursor: string | null;
}

async function fetchTimeline(taskId: string, filter: TimelineFilter, before: string | null): Promise<TimelinePage> {
  const params = new URLSearchParams({ filter, limit: '50' });
  if (before) params.set('before', before);
  const response = await authenticatedFetch(`${API_BASE_URL}/tasks/${encodeURIComponent(taskId)}/timeline?${params.toString()}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.message || 'Timeline could not be loaded.');
  return {
    events: Array.isArray(data.events) ? data.events : [],
    sourcesUnavailable: Array.isArray(data.sourcesUnavailable) ? data.sourcesUnavailable : [],
    nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : null,
  };
}

function absoluteDate(value: string): string {
  return formatDateTime(value, value);
}

function relativeDate(value: string): string {
  const at = new Date(value).valueOf();
  if (!Number.isFinite(at)) return 'time unknown';
  const seconds = Math.round((at - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
  return formatter.format(Math.round(hours / 24), 'day');
}

function dayLabel(value: string): string {
  return formatDayLabel(value, 'Date unknown');
}

function shortPrincipalId(principalId: string): string {
  return principalId.length > 16 ? `${principalId.slice(0, 8)}…${principalId.slice(-4)}` : principalId;
}

function actorLabel(event: TimelineEvent, directory?: Map<string, DirectoryPrincipal>): string {
  const resolved = event.actorDetail?.principalId ? directory?.get(event.actorDetail.principalId) : undefined;
  const identity = resolved?.displayName || resolved?.handle
    || event.actorDetail?.handle
    || (event.actorDetail?.principalId ? shortPrincipalId(event.actorDetail.principalId) : null);
  if (identity) {
    const role = event.actorDetail?.role ? OWNER_ROLE_LABELS[event.actorDetail.role] : null;
    return role ? `${identity} · ${role}` : identity;
  }
  if (event.actor === 'system' || (!event.actor && event.provenance === 'system')) return 'system';
  return event.actor ? `unattributed · ${event.actor}` : 'unattributed';
}

function TimelineEventItem({ event, highlighted, directory }: { event: TimelineEvent; highlighted: boolean; directory?: Map<string, DirectoryPrincipal> }) {
  const [expanded, setExpanded] = useState(false);
  const renderer = timelineRendererFor(event);
  const Icon = renderer.icon;
  const detailId = `event-${event.id}-detail`;
  const redacted = Boolean(event.redaction);
  const displayTitle = redacted ? 'History entry redacted' : event.title;
  return <li id={`event-${event.id}`} className={`task-timeline-event task-timeline-event--${renderer.className}${redacted ? ' task-timeline-event--redacted' : ''}${highlighted ? ' task-timeline-event--highlighted' : ''}`}>
    <div className="task-timeline-event-icon"><Icon size={16} aria-hidden="true" /></div>
    <div className="task-timeline-event-body">
      <div className="task-timeline-event-summary">
        <strong title={displayTitle}>{displayTitle}</strong>
        {!redacted ? <IconButton
          variant="ghost"
          ariaExpanded={expanded}
          ariaControls={detailId}
          ariaLabel={`${expanded ? 'Hide' : 'Show'} details for ${event.title}`}
          icon={<ChevronDown size={16} aria-hidden="true" />}
          onClick={() => setExpanded(value => !value)}
        /> : null}
      </div>
      <div className="task-timeline-event-meta">
        <span title={event.actorDetail?.principalId ?? undefined}>{actorLabel(event, directory)}</span>
        <time dateTime={event.at} title={absoluteDate(event.at)}>{relativeDate(event.at)}</time>
      </div>
      {redacted && event.redaction ? <p className="task-timeline-redaction-tombstone">
        <span>{event.redaction.mode}</span> · redacted <time dateTime={event.redaction.redactedAt}>{absoluteDate(event.redaction.redactedAt)}</time>
      </p> : expanded ? <div id={detailId} className="task-timeline-event-detail">{renderer.renderDetail(event)}</div> : null}
    </div>
  </li>;
}

export function TaskTimeline({ taskId, directory }: { taskId: string; directory?: Map<string, DirectoryPrincipal> }) {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedFilter = searchParams.get('filter');
  const filter: TimelineFilter = TIMELINE_FILTERS.some(item => item.value === requestedFilter)
    ? requestedFilter as TimelineFilter : 'all';
  useEffect(() => {
    if (requestedFilter === filter) return;
    const next = new URLSearchParams(searchParams);
    next.set('filter', filter);
    setSearchParams(next, { replace: true });
  }, [requestedFilter, filter, searchParams, setSearchParams]);
  const timelineQuery = useInfiniteQuery({
    queryKey: ['task-timeline', taskId, filter],
    queryFn: ({ pageParam }) => fetchTimeline(taskId, filter, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: lastPage => lastPage.nextCursor || undefined,
  });
  const seen = new Set<string>();
  const events = (timelineQuery.data?.pages || []).flatMap(page => page.events).filter(event => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
  const sourcesUnavailable = Array.from(new Set((timelineQuery.data?.pages || []).flatMap(page => page.sourcesUnavailable)));
  const groups = events.reduce<Array<{ day: string; events: TimelineEvent[] }>>((result, event) => {
    const day = dayLabel(event.at);
    const group = result[result.length - 1];
    if (group?.day === day) group.events.push(event);
    else result.push({ day, events: [event] });
    return result;
  }, []);
  let anchoredElementId = location.hash.startsWith('#event-') ? location.hash.slice(1) : '';
  try { anchoredElementId = decodeURIComponent(anchoredElementId); } catch { anchoredElementId = ''; }
  const anchoredEventId = anchoredElementId.startsWith('event-') ? anchoredElementId.slice('event-'.length) : '';
  const anchorFound = Boolean(anchoredEventId && events.some(event => event.id === anchoredEventId));
  const loadedPageCount = timelineQuery.data?.pages.length || 0;
  const nextAnchorCursor = timelineQuery.data?.pages[loadedPageCount - 1]?.nextCursor || null;
  const anchorSearchKey = `${taskId}|${filter}|${anchoredEventId}`;
  const anchorSearchRef = useRef<{ key: string; requestedCursor: string | null }>({ key: '', requestedCursor: null });
  useEffect(() => {
    if (anchorSearchRef.current.key !== anchorSearchKey) {
      anchorSearchRef.current = { key: anchorSearchKey, requestedCursor: null };
    }
    if (!anchoredElementId || !anchoredEventId || !timelineQuery.isSuccess) return;
    if (!anchorFound) {
      if (!timelineQuery.hasNextPage || timelineQuery.isFetchingNextPage
        || loadedPageCount >= MAX_ANCHOR_SEARCH_PAGES || !nextAnchorCursor
        || anchorSearchRef.current.requestedCursor === nextAnchorCursor) return;
      anchorSearchRef.current.requestedCursor = nextAnchorCursor;
      void timelineQuery.fetchNextPage();
      return;
    }
    const target = document.getElementById(anchoredElementId);
    if (!target) return;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    target.scrollIntoView?.({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' });
  }, [anchorFound, anchoredElementId, anchoredEventId, anchorSearchKey, loadedPageCount,
    nextAnchorCursor, timelineQuery.fetchNextPage, timelineQuery.hasNextPage,
    timelineQuery.isFetchingNextPage, timelineQuery.isSuccess]);
  const anchorSearchExhausted = Boolean(anchoredEventId && timelineQuery.isSuccess && !anchorFound
    && !timelineQuery.isFetchingNextPage
    && (!timelineQuery.hasNextPage || loadedPageCount >= MAX_ANCHOR_SEARCH_PAGES));

  const selectFilter = (nextFilter: TimelineFilter) => {
    const next = new URLSearchParams(searchParams);
    next.set('filter', nextFilter);
    setSearchParams(next, { replace: true });
  };
  return <section className="task-timeline" aria-label="Task activity">
    {/* The kit SegmentedControl (RH-UI.20 §7): one segmented recipe
        estate-wide; this filter had drifted to a third variant. */}
    <SegmentedControl
      ariaLabel="Timeline filter"
      className="task-timeline-filters"
      value={filter}
      onChange={selectFilter}
      options={TIMELINE_FILTERS.map(item => ({ value: item.value, label: item.label }))}
    />
    <p className="task-timeline-audit-caption" role="note">The ledger-grade stream is durable. Best-effort task History is an audit trail, not a ledger; gaps are possible.</p>
    {sourcesUnavailable.length ? <p className="task-timeline-partial-error" role="alert">
      Some history could not be loaded — <Button variant="secondary" size="compact" onClick={() => void timelineQuery.refetch()}>Retry</Button>
      <span className="sr-only"> Unavailable sources: {sourcesUnavailable.join(', ')}.</span>
    </p> : null}
    {timelineQuery.isLoading ? <p role="status">Loading Timeline…</p>
      : timelineQuery.error ? <div role="alert">{timelineQuery.error instanceof Error ? timelineQuery.error.message : 'Timeline could not be loaded.'} <Button variant="secondary" size="compact" onClick={() => void timelineQuery.refetch()}>Retry</Button></div>
        : groups.length ? groups.map(group => <section key={group.day} className="task-timeline-day" aria-label={group.day}>
          <h3>{group.day}</h3>
          <ol>{group.events.map(item => <TimelineEventItem key={item.id} event={item} highlighted={item.id === anchoredEventId} directory={directory} />)}</ol>
        </section>) : <p>No History has been recorded for this Task.</p>}
    {anchorSearchExhausted ? <p role="status">Event not found in loaded history.</p> : null}
    {timelineQuery.hasNextPage ? <Button
      variant="secondary"
      size="compact"
      className="task-timeline-older"
      disabled={timelineQuery.isFetchingNextPage}
      onClick={() => void timelineQuery.fetchNextPage()}
    >{timelineQuery.isFetchingNextPage ? 'Loading older activity…' : 'Show older activity'}</Button> : null}
  </section>;
}
