import { authenticatedFetch } from '../../utils/auth';
import { createPolledResource, ReadFailure } from '../../utils/polledResource';
import { approvalKindLabel } from '../approvals/approvals';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

/**
 * "NEEDS YOUR ACTION" (`GET /notifications/actions`; Notifications and Timeline
 * design section 3, Slice B; card 5854f0d6; owner ruling E394, choices C1-C3).
 *
 * The open items that wait on the caller, each derived by the server from
 * current board state through the code's own predicates. An item leaves the
 * list when its condition ends, never when it is read, and nothing here
 * dismisses or snoozes one (choice C2). Owner ruling E455 adds one mark: an
 * item can be marked SEEN (one item, or all of them). A seen item stays listed
 * until it is resolved, shown as seen; a new occurrence of it is unseen again.
 * The bell, the Notifications tab and the dashboard card show this one list,
 * read through one shared 30 s poll, so they say the same numbers at the same
 * moment; the bell's number is `counts.unseen` and nothing else.
 *
 * The four kinds (choice C1), in the order the server groups them and the
 * design names them: Decisions, Verify, Stuck, Skill reviews. Inside a kind
 * the server lists the longest-waiting item first. Each kind is capped at 200
 * items with a `capped` flag; a capped count is a floor and says so.
 *
 * A kind this client has not learned yet (a newer server) is listed under
 * "Other", last, with plain words (card 5854f0d6 review): the bell's number
 * is the server's total, so every row it counts must be a row it shows.
 */
export const ACTION_KINDS = ['decision', 'verify', 'stuck', 'skill'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
/** A group: one of the four kinds, or "other" for every kind this client does not know. */
export type ActionGroupKind = ActionKind | 'other';

/** The group headings, in the design's order (section 3.2), then "Other". */
export const ACTION_GROUPS: ReadonlyArray<{ kind: ActionGroupKind; heading: string }> = [
  { kind: 'decision', heading: 'Decisions' },
  { kind: 'verify', heading: 'Verify' },
  { kind: 'stuck', heading: 'Stuck' },
  { kind: 'skill', heading: 'Skill reviews' },
  { kind: 'other', heading: 'Other' },
];

export interface ActionItem {
  key: string;
  /** `other` for a kind this client does not know; the server's own word is in `serverKind`. */
  kind: ActionGroupKind;
  /** The kind as the server named it, kept for an `other` row. */
  serverKind?: string;
  /** Why the item is open: `verifier`, `native-review`, `no-verifier`, `status`, `episode`, or a hub kind. */
  reasons: string[];
  /** Since when it has waited (ISO). */
  since: string;
  object: { type: 'task' | 'approval' | 'skill'; id: string; title: string | null };
  project: { id: string; name: string | null } | null;
  /** Where the act is done: a dashboard path. */
  href: string;
  detail: Record<string, unknown>;
  /** E455: the caller marked this occurrence seen. It stays listed until it is resolved. */
  seen?: boolean;
}

export interface ActionsSummary {
  items: ActionItem[];
  /** `total` counts every listed item; `unseen` only the ones not marked seen (the bell's number). */
  counts: Record<ActionKind | 'total' | 'unseen', number>;
  /** `other`: a kind this client does not know was cut at its cap. */
  capped: Record<ActionKind, boolean> & { other?: boolean };
}

const isKind = (value: unknown): value is ActionKind => (ACTION_KINDS as readonly unknown[]).includes(value);

/**
 * Read the action list. A refusal, a failure or a body without the list and
 * its total is an ERROR, never an empty list: "nothing needs you" is a claim
 * only a successful read may make.
 */
export async function fetchActions(signal?: AbortSignal): Promise<ActionsSummary> {
  const response = await authenticatedFetch(`${API_BASE_URL}/notifications/actions`, { signal });
  if (!response.ok) throw new ReadFailure(response.status);
  const data = await response.json().catch(() => null);
  if (!data || !Array.isArray(data.items) || typeof data.counts?.total !== 'number') throw new ReadFailure(response.status);
  const counts = data.counts as Record<string, unknown>;
  const capped = (data.capped ?? {}) as Record<string, unknown>;
  // A kind this client has not learned is shown under "Other", never under
  // another kind's heading and never dropped while the bell counts it.
  const items = (data.items as ActionItem[])
    .filter((item) => item && typeof item === 'object' && typeof item.kind === 'string')
    .map((item) => (isKind(item.kind) ? item : { ...item, kind: 'other' as const, serverKind: String(item.kind) }))
    .map((item) => ({ ...item, seen: item.seen === true }));
  const total = Number(counts.total) || 0;
  return {
    items,
    counts: {
      decision: Number(counts.decision) || 0,
      verify: Number(counts.verify) || 0,
      stuck: Number(counts.stuck) || 0,
      skill: Number(counts.skill) || 0,
      total,
      // A server without the seen mark has no unseen count: every item is unseen.
      unseen: typeof counts.unseen === 'number' ? counts.unseen : total,
    },
    capped: {
      decision: capped.decision === true,
      verify: capped.verify === true,
      stuck: capped.stuck === true,
      skill: capped.skill === true,
      other: Object.entries(capped).some(([kind, value]) => !isKind(kind) && value === true),
    },
  };
}

/** The ONE shared read of the action list: the bell, the tab and the dashboard card. */
export const actionItems = createPolledResource<ActionsSummary>(fetchActions);

/**
 * `POST /notifications/actions/seen` (E455): mark the caller's own items seen,
 * the named ones or all of them, then read the shared list again so every
 * surface shows the new numbers. A refusal or failure throws.
 */
export async function markActionsSeen(request: { keys: string[] } | { all: true }): Promise<number> {
  const response = await authenticatedFetch(`${API_BASE_URL}/notifications/actions/seen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new ReadFailure(response.status);
  const data = await response.json().catch(() => null);
  await actionItems.refresh();
  return typeof data?.marked === 'number' ? data.marked : 0;
}

/** True when any kind was cut at its cap, so the total is a floor. */
export function actionsCapped(summary: Pick<ActionsSummary, 'capped'>): boolean {
  return ACTION_GROUPS.some(({ kind }) => summary.capped[kind] === true);
}

/** "3", or "200+" when a kind's cap cut the list. */
export function actionCountLabel(summary: Pick<ActionsSummary, 'counts' | 'capped'>): string {
  return `${summary.counts.total}${actionsCapped(summary) ? '+' : ''}`;
}

/** "2 unseen", or "" when every item is unseen or there are none (then the total says it all). */
export function unseenLabel(summary: Pick<ActionsSummary, 'counts'>): string {
  const { unseen, total } = summary.counts;
  return total > 0 && unseen < total ? `${unseen} unseen` : '';
}

/** "3 need your action" / "1 needs your action". */
export function needYourAction(summary: Pick<ActionsSummary, 'counts' | 'capped'>): string {
  const plural = summary.counts.total !== 1 || actionsCapped(summary);
  return `${actionCountLabel(summary)} ${plural ? 'need' : 'needs'} your action`;
}

/** The items of one group, in the server's order (oldest first). */
export function itemsOfKind(summary: Pick<ActionsSummary, 'items'>, kind: ActionGroupKind): ActionItem[] {
  return summary.items.filter((item) => item.kind === kind);
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

/** What the item is about: its title, or plain words when the server sent none. */
export function actionSubject(item: ActionItem): string {
  const title = text(item.object?.title);
  if (title) return title;
  if (item.kind === 'decision') return approvalKindLabel(text(item.detail?.approvalKind) ?? 'agent-mint');
  if (item.kind === 'skill') return 'A skill';
  if (item.kind === 'other') return 'An item';
  return 'A task';
}

const VERIFY_REASONS: Record<string, string> = {
  verifier: 'You are its Verifier',
  'native-review': 'A native review names you as Verifier',
  'no-verifier': 'It has no usable Verifier, so it waits on you as its account owner',
};

const STUCK_REASONS: Record<string, string> = {
  lease_expired: 'Stuck: its lease expired',
  status_stale: 'Stuck: no activity for a while',
};

/** The line that says why the item waits on you. */
export function actionReason(item: ActionItem): string {
  switch (item.kind) {
    case 'decision': {
      const kind = approvalKindLabel(text(item.detail.approvalKind) ?? 'agent-mint');
      const requester = text(item.detail.requesterHandle);
      return requester ? `${kind} from ${requester} waits for your decision` : `${kind} waits for your decision`;
    }
    case 'verify': {
      const words = item.reasons.map((reason) => VERIFY_REASONS[reason]).filter(Boolean);
      return words.length > 0 ? `In Review. ${words.join('. ')}` : 'In Review, waiting on you to verify';
    }
    case 'stuck': {
      if (item.reasons.includes('status')) return 'Its status is Stuck';
      return STUCK_REASONS[text(item.detail.reason) ?? ''] ?? 'Stuck: no activity';
    }
    case 'skill': {
      const version = typeof item.detail.version === 'number' ? ` version ${item.detail.version}` : ' version';
      const requester = text(item.detail.requesterHandle);
      return `Skill${version} waits for review${requester ? `, submitted by ${requester}` : ''}`;
    }
    default:
      return 'Waits for your action. This dashboard does not know this kind of item yet; open it to see what it needs.';
  }
}

/** A dashboard path, or null: the link is only ever a path inside this dashboard. */
export function actionHref(item: Pick<ActionItem, 'href'>): string | null {
  return typeof item.href === 'string' && item.href.startsWith('/') && !item.href.startsWith('//') ? item.href : null;
}

/** How long an item has waited: "Waiting 5 min", "Waiting 3 h", "Waiting 2 d". */
export function waitedFor(since: string, now: number = Date.now()): string {
  const at = Date.parse(since);
  if (Number.isNaN(at)) return 'Waiting';
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return 'Waiting under a minute';
  if (minutes < 60) return `Waiting ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Waiting ${hours} h`;
  return `Waiting ${Math.floor(hours / 24)} d`;
}

/** "5m ago", "3h ago", "2d ago", "Just now". */
export const timeAgo = (dateStr: string): string => {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return 'Just now';
};
