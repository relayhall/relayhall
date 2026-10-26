import { authenticatedFetch } from '../../utils/auth';
import { approvalKindLabel } from '../approvals/approvals';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

/**
 * THE TIMELINE (`GET /notifications/timeline`; Notifications and Timeline
 * design section 4, Slice B; card 5854f0d6; owner ruling E394, choices C4-C9).
 *
 * Every change the caller may see, newest first, paged lazily by the server's
 * opaque keyset token (`nextCursor`). The server narrows every row by its own
 * read scope inside the query, so a page is never short and a row this client
 * shows is a row the caller may read. Everything here is presentation: the
 * filters the URL holds, the words a row is read by, the day it falls on, and
 * how pages join.
 *
 * TWO PAGING FACTS THIS CLIENT RESPECTS (the live route, beta.75 onward):
 *  - a page may hold MORE rows than `limit`: approval and skill-version rows
 *    are read at most one page of each per page, beside the feed's page
 *    (owner E438(7));
 *  - a later page may hold an approval or skill-version row whose time lies
 *    above the oldest row already shown (a long stretch continues on the next
 *    page). So pages are MERGED by time, never just appended, and the merge
 *    says how many rows landed above the bottom of what was already on screen.
 */
export type TimelineType =
  | 'task' | 'status' | 'update' | 'stuck' | 'review' | 'report' | 'phase' | 'project' | 'skill'
  | 'skill-version' | 'approval' | 'access';

/**
 * The type filter's choices: the design's labels (section 4.1). Access
 * changes are not among them: they are the separate "Access changes" switch,
 * off by default (choice C4), which the route reads as `acl`.
 */
export const TIMELINE_TYPE_OPTIONS: ReadonlyArray<{ value: Exclude<TimelineType, 'access'>; label: string }> = [
  { value: 'task', label: 'Task created or archived' },
  { value: 'status', label: 'Status moved' },
  { value: 'update', label: 'Task updated' },
  { value: 'stuck', label: 'Stuck' },
  { value: 'review', label: 'Review requested' },
  { value: 'report', label: 'Report' },
  { value: 'phase', label: 'Phase' },
  { value: 'project', label: 'Project' },
  { value: 'skill', label: 'Skill' },
  { value: 'skill-version', label: 'Skill version decided' },
  { value: 'approval', label: 'Approval' },
];

/** Every URL parameter the Timeline owns (the hub owns its own; the sets are disjoint). */
export const TIMELINE_PARAMS = ['type', 'project', 'phase', 'person', 'since', 'until', 'scope', 'acl', 'q'] as const;

/** The longest text search the route takes (owner ruling E453); a longer link is cut to it. */
export const TIMELINE_SEARCH_MAX = 100;

export const TIMELINE_PAGE_SIZE = 50;

export interface TimelineFilters {
  /** Empty: every type (except access changes, which `acl` adds). */
  types: Array<Exclude<TimelineType, 'access'>>;
  acl: boolean;
  project: string | null;
  phase: string | null;
  person: string | null;
  /** A calendar day, `YYYY-MM-DD`, in the viewer's own time zone. */
  since: string | null;
  /** The last calendar day included, `YYYY-MM-DD`. */
  until: string | null;
  /** Choice C7: "Everything I can see" unless the link asks for My work. */
  scope: 'all' | 'mine';
  /** E453: a text search over the titles and labels the caller may see, or null. */
  q: string | null;
}

/** A search text as the URL and the route hold it: trimmed, at most the maximum, or null when empty. */
export function timelineSearchText(value: string | null): string | null {
  const text = (value ?? '').trim().slice(0, TIMELINE_SEARCH_MAX).trim();
  return text === '' ? null : text;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A `YYYY-MM-DD` that names a real calendar day, or null. */
export function calendarDay(value: string | null): string | null {
  const match = value ? DAY.exec(value) : null;
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1
    && date.getDate() === Number(match[3]) ? value : null;
}

/** The start of a calendar day in the viewer's time zone, `days` later, as an ISO instant. */
export function dayStartIso(day: string, days = 0): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d + days).toISOString();
}

/**
 * The filters a URL holds. A value outside a grammar is not applied (an
 * unknown type, a malformed id or date); the filter bar then shows exactly
 * what IS applied, so a link never claims a filter the list ignores.
 */
export function timelineFilters(params: URLSearchParams): TimelineFilters {
  const known = new Set(TIMELINE_TYPE_OPTIONS.map((option) => option.value as string));
  const asked = (params.get('type') ?? '').split(',').map((part) => part.trim());
  const types = [...new Set(asked.filter((part) => known.has(part)))];
  const id = (name: string) => {
    const value = params.get(name);
    return value && UUID.test(value) ? value.toLowerCase() : null;
  };
  return {
    // The options' order, so one choice always writes one URL.
    types: TIMELINE_TYPE_OPTIONS.map((option) => option.value).filter((value) => types.includes(value)),
    // `type=access` names the Access changes switch (card 5854f0d6 review): a
    // deep link that asks for access rows turns it on rather than being dropped.
    acl: params.get('acl') === '1' || params.get('acl') === 'true' || asked.includes('access'),
    project: id('project'),
    phase: id('phase'),
    person: id('person'),
    since: calendarDay(params.get('since')),
    until: calendarDay(params.get('until')),
    scope: params.get('scope') === 'mine' ? 'mine' : 'all',
    q: timelineSearchText(params.get('q')),
  };
}

/** Write the filters into a URL's parameters (defaults are left out). */
export function writeTimelineFilters(params: URLSearchParams, filters: TimelineFilters): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const name of TIMELINE_PARAMS) next.delete(name);
  if (filters.types.length > 0) next.set('type', filters.types.join(','));
  if (filters.project) next.set('project', filters.project);
  if (filters.phase) next.set('phase', filters.phase);
  if (filters.person) next.set('person', filters.person);
  if (filters.since) next.set('since', filters.since);
  if (filters.until) next.set('until', filters.until);
  if (filters.scope === 'mine') next.set('scope', 'mine');
  if (filters.acl) next.set('acl', '1');
  if (filters.q) next.set('q', filters.q);
  return next;
}

export const NO_TIMELINE_FILTERS: TimelineFilters = {
  types: [], acl: false, project: null, phase: null, person: null, since: null, until: null, scope: 'all', q: null,
};

/** True when a filter narrows the list (Access changes WIDENS it, so it does not count; a search narrows). */
export function timelineNarrowed(filters: TimelineFilters): boolean {
  return filters.types.length > 0 || Boolean(filters.project || filters.phase || filters.person
    || filters.since || filters.until || filters.q) || filters.scope === 'mine';
}

/** The route's query string for one page under these filters. */
export function timelineQueryString(filters: TimelineFilters, page: { before?: string | null; limit?: number } = {}): string {
  const params = new URLSearchParams();
  if (filters.types.length > 0) params.set('type', filters.types.join(','));
  if (filters.acl) params.set('acl', 'true');
  if (filters.project) params.set('project', filters.project);
  if (filters.phase) params.set('phase', filters.phase);
  if (filters.person) params.set('person', filters.person);
  // A day filter is the viewer's own calendar day: from the start of `since`
  // to the start of the day after `until` (the route's `until` is exclusive).
  if (filters.since) params.set('since', dayStartIso(filters.since));
  if (filters.until) params.set('until', dayStartIso(filters.until, 1));
  if (filters.scope === 'mine') params.set('scope', 'mine');
  if (filters.q) params.set('q', filters.q);
  if (page.before) params.set('before', page.before);
  if (page.limit) params.set('limit', String(page.limit));
  const text = params.toString();
  return text ? `?${text}` : '';
}

export interface TimelineItem {
  key: string;
  /** Microsecond UTC text: sorts as a string. */
  at: string;
  kind: TimelineType;
  label: string;
  object: { type: string; id: string; title: string | null };
  project: { id: string; name: string | null } | null;
  actor: { handle: string | null };
  detail: Record<string, unknown>;
}

export interface TimelineHead { feed: string | null; approvals: string | null; skills: string | null }

export interface TimelinePage {
  items: TimelineItem[];
  nextCursor: string | null;
  hasMore: boolean;
  headCursor: TimelineHead;
  /** The caller's own last-seen feed cursor, or null on a first visit. */
  lastSeen: string | null;
}

/** Why a Timeline read failed, in the words a state can be chosen by. */
export type TimelineFailure = 'timeout' | 'invalid' | 'refused' | 'failed';

export class TimelineReadError extends Error {
  readonly httpStatus: number | null;
  readonly code: string | null;
  readonly serverMessage: string | null;

  constructor(httpStatus: number | null, code: string | null = null, serverMessage: string | null = null) {
    super(httpStatus === null ? 'The timeline read failed' : `The timeline read failed (${httpStatus})`);
    this.name = 'TimelineReadError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.serverMessage = serverMessage;
  }

  /** 503 TIMELINE_READ_TIMEOUT: the read reached the route's statement ceiling. */
  get failure(): TimelineFailure {
    if (this.httpStatus === 503 && this.code === 'TIMELINE_READ_TIMEOUT') return 'timeout';
    if (this.httpStatus === 400) return 'invalid';
    if (this.httpStatus === 401 || this.httpStatus === 403) return 'refused';
    return 'failed';
  }
}

/** The failure an error stands for: a drop or an unknown throw is a plain failure. */
export function timelineFailure(error: unknown): TimelineFailure {
  return error instanceof TimelineReadError ? error.failure : 'failed';
}

async function errorOf(response: Response): Promise<TimelineReadError> {
  const body = await response.json().catch(() => null) as { code?: unknown; error?: unknown; message?: unknown } | null;
  const code = typeof body?.code === 'string' ? body.code : null;
  const message = typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' ? body.error : null;
  return new TimelineReadError(response.status, code, message);
}

/** Read one page. A body without the list is an error, never an empty Timeline. */
export async function fetchTimelinePage(
  filters: TimelineFilters,
  page: { before?: string | null; limit?: number },
  signal?: AbortSignal,
): Promise<TimelinePage> {
  const response = await authenticatedFetch(`${API_BASE_URL}/notifications/timeline${timelineQueryString(filters, page)}`, { signal });
  if (!response.ok) throw await errorOf(response);
  const data = await response.json().catch(() => null);
  if (!data || !Array.isArray(data.items)) throw new TimelineReadError(response.status);
  const head = (data.headCursor ?? {}) as Record<string, unknown>;
  const str = (value: unknown) => (typeof value === 'string' ? value : null);
  return {
    items: data.items as TimelineItem[],
    nextCursor: str(data.nextCursor),
    hasMore: data.hasMore === true && typeof data.nextCursor === 'string',
    headCursor: { feed: str(head.feed), approvals: str(head.approvals), skills: str(head.skills) },
    lastSeen: str(data.lastSeen),
  };
}

/**
 * `POST /notifications/timeline/seen { cursor }`: move the caller's OWN
 * last-seen mark. The server clamps it to the caller's own head and never
 * moves it backwards; the answer is the mark as stored.
 */
export async function markTimelineSeen(cursor: string): Promise<string | null> {
  const response = await authenticatedFetch(`${API_BASE_URL}/notifications/timeline/seen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cursor }),
  });
  if (!response.ok) throw await errorOf(response);
  const data = await response.json().catch(() => null);
  return typeof data?.lastSeen === 'string' ? data.lastSeen : null;
}

/** The feed cursor of a feed row (`feed:<cursor>`), or null for an approval or skill-version row. */
export function feedCursorOf(item: Pick<TimelineItem, 'key'>): bigint | null {
  const match = /^feed:(\d{1,19})$/.exec(item.key);
  return match ? BigInt(match[1]) : null;
}

const sourceOf = (item: Pick<TimelineItem, 'key'>): 'feed' | 'approval' | 'skill' | 'other' =>
  item.key.startsWith('feed:') ? 'feed' : item.key.startsWith('approval-event:') ? 'approval'
    : item.key.startsWith('skill-event:') ? 'skill' : 'other';

/** True when `item` is newer than the head the list was read at. */
export function newerThanHead(item: TimelineItem, head: TimelineHead): boolean {
  const source = sourceOf(item);
  if (source === 'feed') {
    const cursor = feedCursorOf(item);
    return cursor !== null && (head.feed === null || cursor > BigInt(head.feed));
  }
  if (source === 'approval') return head.approvals === null || item.at > head.approvals;
  if (source === 'skill') return head.skills === null || item.at > head.skills;
  return false;
}

/** True when a polled head names a row the list does not hold yet. */
export function headMoved(polled: TimelineHead, base: TimelineHead): boolean {
  const feed = polled.feed !== null && (base.feed === null || BigInt(polled.feed) > BigInt(base.feed));
  const approvals = polled.approvals !== null && (base.approvals === null || polled.approvals > base.approvals);
  const skills = polled.skills !== null && (base.skills === null || polled.skills > base.skills);
  return feed || approvals || skills;
}

/** Newest first; inside one instant the design's display order (source, then id descending). */
export function compareTimeline(a: TimelineItem, b: TimelineItem): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  const sa = sourceOf(a); const sb = sourceOf(b);
  if (sa !== sb) return sa < sb ? -1 : 1;
  const ca = feedCursorOf(a); const cb = feedCursorOf(b);
  if (ca !== null && cb !== null) return ca === cb ? 0 : ca < cb ? 1 : -1;
  return a.key === b.key ? 0 : a.key < b.key ? 1 : -1;
}

/**
 * Join a page onto what is shown: no row twice, newest first. `insertedAbove`
 * counts the new rows that sort above the last row already shown — the rows
 * a long approval or skill-version stretch carried onto this page.
 */
export function mergeTimeline(current: TimelineItem[], incoming: TimelineItem[]): { items: TimelineItem[]; added: number; insertedAbove: number } {
  const seen = new Set(current.map((item) => item.key));
  const fresh = incoming.filter((item) => {
    if (seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  });
  const bottom = current[current.length - 1];
  const insertedAbove = bottom ? fresh.filter((item) => compareTimeline(item, bottom) < 0).length : 0;
  return { items: [...current, ...fresh].sort(compareTimeline), added: fresh.length, insertedAbove };
}

/** The viewer's calendar day of an instant, `YYYY-MM-DD`. */
export function localDayKey(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Rows grouped by the viewer's calendar day, in list order. */
export function timelineDays(items: TimelineItem[]): Array<{ key: string; at: string; items: TimelineItem[] }> {
  const days: Array<{ key: string; at: string; items: TimelineItem[] }> = [];
  for (const item of items) {
    const key = localDayKey(item.at);
    const last = days[days.length - 1];
    if (last && last.key === key) last.items.push(item);
    else days.push({ key, at: item.at, items: [item] });
  }
  return days;
}

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** Where a row leads: the object's own page, or null when there is none to open. */
export function timelineLink(item: TimelineItem): string | null {
  const id = encodeURIComponent(item.object.id);
  switch (item.object.type) {
    case 'task': return `/tasks/${id}`;
    case 'report': return `/reports/${id}`;
    case 'phase': return item.project ? `/projects/${encodeURIComponent(item.project.id)}/phases` : null;
    case 'project': return `/projects?open=${id}`;
    case 'skill': return `/skills?skill=${id}`;
    case 'approval': return `/action-center?tab=approvals&approval=${id}`;
    default: return null;
  }
}

/** What the row is about, in words, when its object has no readable title. */
export function timelineSubject(item: TimelineItem): string {
  if (item.object.title) return item.object.title;
  switch (item.object.type) {
    case 'approval': return approvalKindLabel(str(item.detail.approvalKind) ?? 'agent-mint');
    case 'report': return 'A Report';
    case 'phase': return 'A Phase';
    case 'project': return 'A Project';
    case 'skill': return 'A Skill';
    default: return 'A Task';
  }
}

const APPROVAL_ACTIONS: Record<string, string> = {
  'approval.requested': 'requested',
  'approval.approved': 'approved',
  'approval.denied': 'denied',
  'approval.collected': 'collected',
  'approval.lapsed': 'lapsed',
  'approval.revoked': 'revoked',
  'approval.applied': 'applied',
  'approval.export_stalled': 'export stalled',
  'approval.reverted': 'reverted',
};

const STUCK_REASONS: Record<string, string> = {
  lease_expired: 'its lease expired',
  status_stale: 'no activity for a while',
};

const VERBS: Record<string, string> = { created: 'Created', updated: 'Updated', archived: 'Archived' };

/** The line that says what happened, built only from what the row carries (never a value the server withheld). */
export function timelineWhat(item: TimelineItem): string {
  const d = item.detail;
  const name = str(d.name) ?? '';
  const verb = VERBS[name.split('.')[1] ?? ''] ?? null;
  const parts: string[] = [];
  switch (item.kind) {
    case 'status':
      parts.push(`${str(d.from) ?? '?'} → ${str(d.to) ?? '?'}`);
      break;
    case 'stuck':
      parts.push(STUCK_REASONS[str(d.reason) ?? ''] ? `Stuck: ${STUCK_REASONS[str(d.reason) ?? '']}` : 'Found stuck');
      break;
    case 'review':
      parts.push('Verification requested');
      break;
    case 'approval': {
      const action = str(d.action) ?? '';
      parts.push(`${approvalKindLabel(str(d.approvalKind) ?? 'agent-mint')} ${APPROVAL_ACTIONS[action] ?? action}`);
      break;
    }
    case 'skill-version': {
      const version = typeof d.version === 'number' ? `Version ${d.version}` : 'A version';
      parts.push(`${version} ${str(d.decision) ?? str(d.to) ?? 'decided'}`);
      break;
    }
    case 'access':
      parts.push('Access changed');
      break;
    default:
      if (verb) parts.push(verb);
  }
  if (Array.isArray(d.fields) && d.fields.length > 0) {
    parts.push(`Changed: ${d.fields.filter((field) => typeof field === 'string').join(', ')}`);
  }
  const stream = d.stream && typeof d.stream === 'object' ? str((d.stream as Record<string, unknown>).entryType) : null;
  if (stream) parts.push(`Stream entry: ${stream}`);
  if (parts.length === 0) parts.push(item.label);
  return parts.join(' · ');
}

/**
 * Who did it. A feed row with no actor was written by the board itself (the
 * stuck sweep, a TTL, the scheduler): it shows the board's name (design
 * section 4.3). An approval or skill-version row with no actor shows none —
 * a withheld actor is never named, and never named as the board.
 */
export function timelineActor(item: TimelineItem, boardName: string): string | null {
  if (item.actor.handle) return item.actor.handle;
  return item.key.startsWith('feed:') ? boardName : null;
}

/** A Report row whose Report carries a structured handover. */
export function isHandover(item: TimelineItem): boolean {
  return item.object.type === 'report' && item.detail.handover === true;
}
