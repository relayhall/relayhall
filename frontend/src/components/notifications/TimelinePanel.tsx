import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Loader2, RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react';
import { Button } from '../Button';
import { Select } from '../ui/Select';
import { SegmentedControl } from '../ui/SegmentedControl';
import { usePhaseOptions } from '../tasks/PhaseSelect';
import { usePrincipals } from '../../hooks/usePrincipals';
import { useRelayHallConfig } from '../../contexts/RelayHallConfigContext';
import { authenticatedFetch } from '../../utils/auth';
import { formatDateTime, formatDayLabel, formatTime } from '../../utils/dateFormat';
import { isIntentionalAbort } from '../../utils/fetchAbort';
import { POLL_INTERVAL_MS } from '../../utils/polledResource';
import { TimelineIcon } from './NotificationIcon';
import {
  NO_TIMELINE_FILTERS, TIMELINE_PAGE_SIZE, TIMELINE_SEARCH_MAX, TIMELINE_TYPE_OPTIONS, feedCursorOf, fetchTimelinePage,
  headMoved, isHandover, markTimelineSeen, mergeTimeline, newerThanHead, timelineActor, timelineDays, timelineFailure,
  timelineFilters, timelineLink, timelineNarrowed, timelineQueryString, timelineSearchText, timelineSubject, timelineWhat,
  writeTimelineFilters, TimelineReadError,
  type TimelineFailure, type TimelineFilters, type TimelineHead, type TimelineItem,
} from './timeline';
import './TimelinePanel.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

type ListState =
  | { status: 'loading' }
  | { status: 'error'; failure: TimelineFailure; message: string | null }
  | {
    status: 'ready';
    items: TimelineItem[];
    nextCursor: string | null;
    hasMore: boolean;
    head: TimelineHead;
    /** The last-seen mark as it stood when this list was read (before this visit's mark). */
    lastSeen: string | null;
  };

/** How many newer rows the banner counts before it says "50+". */
const NEW_COUNT_LIMIT = 50;

/** A typed search is applied this long after the last keystroke (Enter applies it at once). */
export const SEARCH_DEBOUNCE_MS = 350;

/** One active filter, as the folded bar shows it: its words, and what removing it changes. */
export interface FilterChip { key: string; label: string; remove: Partial<TimelineFilters> }

/**
 * The folded bar's chips (owner ruling E453): one per filter that is applied,
 * in the order the unfolded groups show them, each with the change that
 * removes exactly it. A type is one chip per type; removing the project also
 * removes its phase, as choosing another project does.
 */
export function filterChips(
  filters: TimelineFilters,
  names: { project: (id: string) => string; phase: (id: string) => string; person: (id: string) => string },
): FilterChip[] {
  const chips: FilterChip[] = [];
  if (filters.q) chips.push({ key: 'q', label: `Search: “${filters.q}”`, remove: { q: null } });
  if (filters.scope === 'mine') chips.push({ key: 'scope', label: 'My work', remove: { scope: 'all' } });
  for (const type of filters.types) {
    const label = TIMELINE_TYPE_OPTIONS.find((option) => option.value === type)?.label ?? type;
    chips.push({ key: `type:${type}`, label: `Type: ${label}`, remove: { types: filters.types.filter((other) => other !== type) } });
  }
  if (filters.project) chips.push({ key: 'project', label: `Project: ${names.project(filters.project)}`, remove: { project: null, phase: null } });
  if (filters.phase) chips.push({ key: 'phase', label: `Current phase: ${names.phase(filters.phase)}`, remove: { phase: null } });
  if (filters.person) chips.push({ key: 'person', label: `Person: ${names.person(filters.person)}`, remove: { person: null } });
  if (filters.since) chips.push({ key: 'since', label: `From ${filters.since}`, remove: { since: null } });
  if (filters.until) chips.push({ key: 'until', label: `To ${filters.until}`, remove: { until: null } });
  if (filters.acl) chips.push({ key: 'acl', label: 'Access changes', remove: { acl: false } });
  return chips;
}

const SCOPE_OPTIONS: Array<{ value: TimelineFilters['scope']; label: string }> = [
  { value: 'all', label: 'Everything I can see' },
  { value: 'mine', label: 'My work' },
];

/** The Projects a filter can name (archived ones too: their history stays on the Timeline). */
function useProjectOptions(): Array<{ id: string; name: string }> {
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    authenticatedFetch(`${API_BASE_URL}/projects?includeArchived=true`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled || !data || !Array.isArray(data.projects)) return;
        setProjects((data.projects as Array<{ id?: unknown; name?: unknown }>)
          .filter((project) => typeof project.id === 'string' && typeof project.name === 'string')
          .map((project) => ({ id: String(project.id).toLowerCase(), name: String(project.name) })));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  return projects;
}

/**
 * The divider "new since your last visit" goes above the first feed row the
 * last visit had already seen — and only when a row newer than the mark is
 * listed above it. Approval and skill-version rows carry no feed cursor, so
 * they never place it.
 */
export function dividerBefore(items: TimelineItem[], lastSeen: string | null): { key: string; newer: number } | null {
  if (lastSeen === null) return null;
  const mark = BigInt(lastSeen);
  let newer = 0;
  for (const item of items) {
    const cursor = feedCursorOf(item);
    if (cursor === null) continue;
    if (cursor > mark) newer += 1;
    else return newer > 0 ? { key: item.key, newer } : null;
  }
  return null;
}

function failureText(failure: TimelineFailure, message: string | null, more: boolean): string {
  switch (failure) {
    case 'timeout':
      return more
        ? 'The next page took too long to read. Try again, or narrow the filters (a type, a project or a date range).'
        : 'The timeline took too long to read. Narrow the filters (a type, a project or a date range) or try again.';
    case 'invalid':
      return `These filters could not be applied${message ? `: ${message}` : '.'}`;
    case 'refused':
      return 'The timeline is not available to this session.';
    default:
      return more ? 'Couldn’t load more.' : 'Couldn’t load the timeline.';
  }
}

const TimelineRow: React.FC<{ item: TimelineItem; boardName: string }> = ({ item, boardName }) => {
  const link = timelineLink(item);
  const subject = timelineSubject(item);
  const actor = timelineActor(item, boardName);
  return (
    <li className="timeline-panel-item">
      <span className="timeline-panel-item-icon" aria-hidden="true"><TimelineIcon kind={item.kind} /></span>
      <div className="timeline-panel-item-body">
        <span className="timeline-panel-item-label">
          {item.label}
          {isHandover(item) && <span className="timeline-panel-badge">Handover</span>}
        </span>
        {link
          ? <Link className="timeline-panel-item-subject" to={link}>{subject}</Link>
          : <span className="timeline-panel-item-subject">{subject}</span>}
        <span className="timeline-panel-item-what">{timelineWhat(item)}</span>
        <span className="timeline-panel-item-meta">
          <time dateTime={item.at} title={formatDateTime(item.at, item.at)}>{formatTime(item.at, item.at)}</time>
          {actor && <span>by {actor}</span>}
          {item.project?.name && <span>{item.project.name}</span>}
        </span>
      </div>
    </li>
  );
};

/**
 * THE TIMELINE TAB (Notifications and Timeline design section 4.6; card
 * 5854f0d6, Slice B; owner ruling E394, choices C4, C7 and C9).
 *
 * Every change you can see, newest first, grouped by day. The first page is
 * read when the tab opens; the next ones are read LAZILY: an
 * IntersectionObserver reads the next page when the end of the list comes
 * into view, and a visible "Load more" button does the same for a keyboard, a
 * screen reader or a browser without the observer. Pages are joined by time
 * (see `mergeTimeline`), never just appended, and a page that put rows above
 * the old bottom says so.
 *
 * Every filter the route allows is in the URL. The filter bar is FOLDED by
 * default (owner ruling E453) to one compact line: the text search, a chip for
 * each applied filter (each removable on its own), and a "Filters" toggle.
 * Unfolded, the filters are grouped: scope (My work or Everything I can see,
 * the default, C7), type (multi-select), project and current phase, person,
 * dates (from/to day), and Access changes (off by default, C4). The search
 * matches the titles and labels of what you can see (`q`, E453).
 *
 * "New since your last visit": a divider above the first row the last visit
 * had already seen. The visit's own mark is written by an explicit
 * `POST /notifications/timeline/seen` after the first page of the UNFILTERED
 * view is read (a filtered view never marks rows it did not show as seen),
 * never by a read.
 *
 * Live (C9): no socket. While the tab is open it reads the head every 30 s and
 * offers "N new — Show", which reads the list again from the top.
 *
 * Honest states: loading, an error that is never an empty list, the route's
 * 503 TIMELINE_READ_TIMEOUT said as "took too long — narrow or retry", a 400
 * said with the server's own words, an empty list that says whether filters
 * made it empty, and the end of the list.
 */
export const TimelinePanel: React.FC<{ headPollMs?: number }> = ({ headPollMs = POLL_INTERVAL_MS }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => timelineFilters(searchParams), [searchParams]);
  const filterKey = timelineQueryString(filters);
  const { config } = useRelayHallConfig();
  const { principals } = usePrincipals();
  const projects = useProjectOptions();
  const phases = usePhaseOptions(filters.project);
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailure, setMoreFailure] = useState<{ failure: TimelineFailure; message: string | null } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  /** Rows the last page placed among rows already shown (the per-page cap of the windowed sources). */
  const [spliced, setSpliced] = useState(0);
  const [newCount, setNewCount] = useState<{ count: number; more: boolean } | null>(null);
  const loadingRef = useRef(false);
  /** Bumped by every first-page read: a later page from an older list is dropped. */
  const generationRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const setFilters = useCallback((change: Partial<TimelineFilters>) => {
    setSearchParams((current) => writeTimelineFilters(current, { ...timelineFilters(current), ...change }));
  }, [setSearchParams]);

  // E453: the filter groups are folded until asked for; the search box is the
  // reader's own text until it is applied (after a pause, or on Enter).
  const [unfolded, setUnfolded] = useState(false);
  const [draft, setDraft] = useState(filters.q ?? '');
  useEffect(() => {
    // A search changed from outside the box (a chip, Clear filters, a link):
    // the box follows it. The box's own applied text is left as typed.
    setDraft((typed) => (timelineSearchText(typed) === filters.q ? typed : (filters.q ?? '')));
  }, [filters.q]);
  useEffect(() => {
    const next = timelineSearchText(draft);
    if (next === filtersRef.current.q) return undefined;
    const timer = setTimeout(() => setFilters({ q: next }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, setFilters]);

  // The first page, again whenever the filters change or a reload is asked for.
  useEffect(() => {
    const controller = new AbortController();
    const asked = filtersRef.current;
    generationRef.current += 1;
    setList({ status: 'loading' });
    setMoreFailure(null);
    setNewCount(null);
    setAnnouncement('');
    setSpliced(0);
    loadingRef.current = false;
    setLoadingMore(false);
    fetchTimelinePage(asked, { limit: TIMELINE_PAGE_SIZE }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setList({
          status: 'ready', items: mergeTimeline([], page.items).items,
          nextCursor: page.nextCursor, hasMore: page.hasMore, head: page.headCursor, lastSeen: page.lastSeen,
        });
        // This visit's mark: only an unfiltered view, and only up to the head it read.
        if (!timelineNarrowed(asked) && page.headCursor.feed !== null) {
          void markTimelineSeen(page.headCursor.feed).catch(() => undefined);
        }
      })
      .catch((caught) => {
        if (isIntentionalAbort(caught, controller.signal)) return;
        setList({
          status: 'error',
          failure: timelineFailure(caught),
          message: caught instanceof TimelineReadError ? caught.serverMessage : null,
        });
      });
    return () => controller.abort();
  }, [filterKey, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  const loadMore = useCallback(async () => {
    if (list.status !== 'ready' || !list.hasMore || !list.nextCursor || loadingRef.current) return;
    loadingRef.current = true;
    setLoadingMore(true);
    const generation = generationRef.current;
    try {
      const page = await fetchTimelinePage(filtersRef.current, { before: list.nextCursor, limit: TIMELINE_PAGE_SIZE });
      if (generationRef.current !== generation) return;
      setMoreFailure(null);
      const merged = mergeTimeline(list.items, page.items);
      let said = `Loaded ${merged.added} more ${merged.added === 1 ? 'row' : 'rows'}.`;
      if (merged.insertedAbove > 0) {
        said += ` ${merged.insertedAbove} of them fall among rows already shown, by time: a long run of approvals or skill decisions continues across pages.`;
      }
      setList((current) => (current.status !== 'ready' ? current
        : { ...current, items: merged.items, nextCursor: page.nextCursor, hasMore: page.hasMore }));
      setAnnouncement(said);
      setSpliced(merged.insertedAbove);
    } catch (caught) {
      if (generationRef.current !== generation) return;
      setMoreFailure({ failure: timelineFailure(caught), message: caught instanceof TimelineReadError ? caught.serverMessage : null });
    } finally {
      loadingRef.current = false;
      setLoadingMore(false);
    }
  }, [list]);

  // LAZY PAGING: the next page when the end of the list comes into view. The
  // observer stops after a failed page (the button retries), and is absent
  // where the browser has none — the "Load more" button is always there.
  const canAutoLoad = list.status === 'ready' && list.hasMore && !loadingMore && moreFailure === null;
  const itemCount = list.status === 'ready' ? list.items.length : 0;
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !canAutoLoad || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { rootMargin: '240px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [canAutoLoad, itemCount, loadMore]);

  // C9: the head, every 30 s while the tab is open. A moved head is counted
  // against the head this list was read at.
  const head = list.status === 'ready' ? list.head : null;
  useEffect(() => {
    if (!head) return;
    let stopped = false;
    let controller: AbortController | null = null;
    const poll = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const top = await fetchTimelinePage(filtersRef.current, { limit: 1 }, controller.signal);
        if (stopped || !headMoved(top.headCursor, head)) return;
        const recent = await fetchTimelinePage(filtersRef.current, { limit: NEW_COUNT_LIMIT }, controller.signal);
        if (stopped) return;
        const count = recent.items.filter((item) => newerThanHead(item, head)).length;
        setNewCount(count > 0 ? { count, more: count >= NEW_COUNT_LIMIT && recent.hasMore } : null);
      } catch {
        // A failed poll changes nothing on screen; the next one tries again.
      }
    };
    const timer = setInterval(() => { void poll(); }, headPollMs);
    return () => { stopped = true; clearInterval(timer); controller?.abort(); };
  }, [head, headPollMs]);

  const narrowed = timelineNarrowed(filters);
  const anyFilter = narrowed || filters.acl;
  const clear = () => setFilters(NO_TIMELINE_FILTERS);
  const boardName = config.displayName || 'RelayHall';
  const typeSummary = filters.types.length === 0
    ? 'Every type'
    : filters.types.length === 1
      ? TIMELINE_TYPE_OPTIONS.find((option) => option.value === filters.types[0])?.label ?? '1 type'
      : `${filters.types.length} types`;
  const sortedPrincipals = [...principals].sort((a, b) => a.handle.localeCompare(b.handle));
  const projectKnown = !filters.project || projects.some((project) => project.id === filters.project);
  const phaseKnown = !filters.phase || phases.some((phase) => phase.id.toLowerCase() === filters.phase);
  const personKnown = !filters.person || principals.some((principal) => principal.id.toLowerCase() === filters.person);
  const toggleType = (value: TimelineFilters['types'][number], on: boolean) => {
    const next = new Set(filters.types);
    if (on) next.add(value); else next.delete(value);
    setFilters({ types: TIMELINE_TYPE_OPTIONS.map((option) => option.value).filter((type) => next.has(type)) });
  };
  const chips = filterChips(filters, {
    project: (id) => projects.find((project) => project.id === id)?.name ?? 'the linked project',
    phase: (id) => phases.find((phase) => phase.id.toLowerCase() === id)?.name ?? 'the linked phase',
    person: (id) => principals.find((principal) => principal.id.toLowerCase() === id)?.handle ?? 'the linked person',
  });
  // The toggle counts what the folded groups hold (the search has its own box).
  const groupedCount = chips.filter((chip) => chip.key !== 'q').length;

  const divider = list.status === 'ready' ? dividerBefore(list.items, list.lastSeen) : null;
  const days = list.status === 'ready' ? timelineDays(list.items) : [];

  return (
    <section className="notifications-page-panel" aria-labelledby="notifications-timeline-heading">
      <div className="notifications-page-toolbar">
        <h2 id="notifications-timeline-heading">Timeline</h2>
        <Button variant="secondary" size="compact" icon={<RefreshCw size={16} />} onClick={reload} ariaLabel="Refresh the timeline">Refresh</Button>
      </div>

      <form
        className="timeline-panel-filters"
        aria-label="Timeline filters"
        role="search"
        onSubmit={(event) => { event.preventDefault(); setFilters({ q: timelineSearchText(draft) }); }}
      >
        <div className="timeline-panel-bar">
          <label className="timeline-panel-search">
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">Search the timeline</span>
            <input
              className="form-input"
              type="search"
              value={draft}
              maxLength={TIMELINE_SEARCH_MAX}
              placeholder="Search titles and labels"
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          {chips.length > 0 && (
            <ul className="timeline-panel-chips" aria-label="Applied filters">
              {chips.map((chip) => (
                <li key={chip.key}>
                  <button
                    type="button"
                    className="timeline-panel-chip"
                    aria-label={`Remove filter: ${chip.label}`}
                    onClick={() => setFilters(chip.remove)}
                  >
                    <span>{chip.label}</span>
                    <X size={16} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Button
            variant="secondary"
            size="compact"
            icon={<SlidersHorizontal size={16} />}
            ariaExpanded={unfolded}
            ariaControls="timeline-panel-groups"
            onClick={() => setUnfolded((was) => !was)}
          >
            {groupedCount > 0 ? `Filters (${groupedCount})` : 'Filters'}
          </Button>
          {anyFilter && (
            <Button variant="secondary" size="compact" onClick={clear}>Clear filters</Button>
          )}
        </div>

        {unfolded && (
          <div id="timeline-panel-groups" className="timeline-panel-groups">
            <fieldset className="timeline-panel-group">
              <legend>Scope</legend>
              <SegmentedControl<TimelineFilters['scope']>
                ariaLabel="Whose activity"
                options={SCOPE_OPTIONS}
                value={filters.scope}
                onChange={(scope) => setFilters({ scope })}
              />
            </fieldset>
            <fieldset className="timeline-panel-group timeline-panel-group--wide">
              <legend>Type: {typeSummary}</legend>
              <div className="timeline-panel-type-grid">
                {TIMELINE_TYPE_OPTIONS.map((option) => (
                  <label key={option.value} className="timeline-panel-check">
                    <input
                      type="checkbox"
                      checked={filters.types.includes(option.value)}
                      onChange={(event) => toggleType(option.value, event.target.checked)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="timeline-panel-group">
              <legend>Project and phase</legend>
              <label className="timeline-panel-field">
                Project
                <Select value={filters.project ?? ''} onChange={(event) => setFilters({ project: event.target.value || null, phase: null })}>
                  <option value="">Every project</option>
                  {!projectKnown && <option value={filters.project!}>The linked project</option>}
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </Select>
              </label>
              <label className="timeline-panel-field">
                Current phase
                <Select
                  value={filters.phase ?? ''}
                  disabled={!filters.project && !filters.phase}
                  title={!filters.project && !filters.phase ? 'Choose a project first' : undefined}
                  onChange={(event) => setFilters({ phase: event.target.value || null })}
                >
                  <option value="">Every phase</option>
                  {!phaseKnown && <option value={filters.phase!}>The linked phase</option>}
                  {phases.map((phase) => <option key={phase.id} value={phase.id.toLowerCase()}>{phase.name}</option>)}
                </Select>
              </label>
            </fieldset>
            <fieldset className="timeline-panel-group">
              <legend>Person</legend>
              <label className="timeline-panel-field">
                Person
                <Select value={filters.person ?? ''} onChange={(event) => setFilters({ person: event.target.value || null })}>
                  <option value="">Everyone</option>
                  {!personKnown && <option value={filters.person!}>The linked person</option>}
                  {sortedPrincipals.map((principal) => (
                    <option key={principal.id} value={principal.id.toLowerCase()}>{principal.handle}</option>
                  ))}
                </Select>
              </label>
            </fieldset>
            <fieldset className="timeline-panel-group">
              <legend>Dates</legend>
              <label className="timeline-panel-field">
                From
                <input
                  className="form-input"
                  type="date"
                  value={filters.since ?? ''}
                  max={filters.until ?? undefined}
                  onChange={(event) => setFilters({ since: event.target.value || null })}
                />
              </label>
              <label className="timeline-panel-field">
                To
                <input
                  className="form-input"
                  type="date"
                  value={filters.until ?? ''}
                  min={filters.since ?? undefined}
                  onChange={(event) => setFilters({ until: event.target.value || null })}
                />
              </label>
            </fieldset>
            <fieldset className="timeline-panel-group">
              <legend>Access changes</legend>
              <label className="timeline-panel-check">
                <input type="checkbox" checked={filters.acl} onChange={(event) => setFilters({ acl: event.target.checked })} />
                Access changes
              </label>
            </fieldset>
          </div>
        )}
      </form>

      {newCount && (
        <div className="timeline-panel-new" role="status">
          <span>{newCount.more ? `${newCount.count}+` : newCount.count} new</span>
          <Button variant="secondary" size="compact" onClick={reload}>Show</Button>
        </div>
      )}

      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>

      {list.status === 'loading' && (
        <div className="notifications-page-state" role="status"><Loader2 className="axm-spin" aria-hidden="true" /> Loading the timeline…</div>
      )}
      {list.status === 'error' && (
        <div className="notifications-page-failed" role="alert">
          <span>{failureText(list.failure, list.message, false)}</span>
          {list.failure === 'invalid'
            ? <Button variant="secondary" size="compact" onClick={clear}>Clear filters</Button>
            : <Button variant="secondary" size="compact" onClick={reload}>Retry</Button>}
        </div>
      )}
      {list.status === 'ready' && list.items.length === 0 && (
        <div className="notifications-page-state">
          {narrowed ? (
            <>
              <span>Nothing on the timeline matches these filters.</span>
              <Button variant="secondary" size="compact" onClick={clear}>Clear filters</Button>
            </>
          ) : (
            <span>Nothing has happened that you can see yet.</span>
          )}
        </div>
      )}
      {list.status === 'ready' && divider && (
        <p className="timeline-panel-note">
          {divider.newer} new since your last visit, above the divider.
        </p>
      )}
      {list.status === 'ready' && list.items.length > 0 && (
        <div aria-busy={loadingMore}>
          {days.map((day) => {
            const headingId = `timeline-day-${day.key}`;
            return (
              <section key={day.key} className="timeline-panel-day" aria-labelledby={headingId}>
                <h3 id={headingId}>{formatDayLabel(day.at, 'Date unknown')}</h3>
                <ol className="timeline-panel-items">
                  {day.items.map((item) => (
                    <React.Fragment key={item.key}>
                      {divider?.key === item.key && (
                        <li className="timeline-panel-divider"><span>Above this line: new since your last visit</span></li>
                      )}
                      <TimelineRow item={item} boardName={boardName} />
                    </React.Fragment>
                  ))}
                </ol>
              </section>
            );
          })}
        </div>
      )}
      {list.status === 'ready' && spliced > 0 && (
        <p className="timeline-panel-note" role="note">
          The last page placed {spliced} {spliced === 1 ? 'row' : 'rows'} among the rows above, by time: a page carries
          at most one page of approvals and of skill decisions, so a long run of them continues on the next page.
        </p>
      )}
      {list.status === 'ready' && list.hasMore && (
        <div className="timeline-panel-more">
          <div ref={sentinelRef} className="timeline-panel-sentinel" aria-hidden="true" />
          {moreFailure && (
            <span className="notifications-page-failed" role="alert">{failureText(moreFailure.failure, moreFailure.message, true)}</span>
          )}
          {/* aria-disabled, not disabled: a disabled button drops keyboard focus while the page loads. */}
          <Button
            variant="secondary"
            size="compact"
            ariaDisabled={loadingMore}
            onClick={() => { if (loadingMore) return; void loadMore(); }}
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
      {list.status === 'ready' && !list.hasMore && list.items.length > 0 && (
        <p className="timeline-panel-end">No older activity you can see.</p>
      )}
    </section>
  );
};
