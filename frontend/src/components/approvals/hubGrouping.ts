import type { ApprovalItem } from './approvals';

/**
 * T9, THE HUB'S SECTIONS (card b1e3b16d; design draft section E; owner rulings
 * E16 and E45, hub Q3 as ratified).
 *
 * The server classifies each item (`ownership`, ApprovalHubService): `group`
 * when its project is OWNED by a Group (AZ-A12 clause 12: the owner column
 * decides first, `basis: 'owner'`) or, failing that, has a live Group grant
 * (`basis: 'grant'`), `shared` when the project is shared or public with
 * neither, `private` otherwise, `board` when there is no project. This module
 * only lays those classes out, in a fixed order:
 *
 *   Owned by <Group> (by name) · Shared with <Group> (by name) · Shared
 *   projects · Private: your projects · Private to <owner> (by handle) ·
 *   Board-level
 *
 * An item with several Groups lists ONCE, under its first Group (the server
 * puts the owning Group first, then the creation-default Group), so nothing
 * appears twice. Empty sections are not drawn. An item a server did not
 * classify (an older server) lists under "All requests" rather than under a
 * class it was never given; a `group` item from a server that sends no basis
 * lists under "Group: <name>", as before.
 */
export interface HubSection<T> {
  /** Stable and safe for an element id. */
  key: string;
  title: string;
  items: T[];
}

type Classified = Pick<ApprovalItem, 'ownership'>;

const RANK = {
  'group-owner': 0, group: 1, 'group-hidden': 2, shared: 3, 'private-yours': 4, 'private-other': 5, board: 6, unclassified: 7,
} as const;

function placement(item: Classified): { rank: number; sort: string; key: string; title: string } {
  const ownership = item.ownership;
  if (!ownership) return { rank: RANK.unclassified, sort: '', key: 'unclassified', title: 'All requests' };
  switch (ownership.class) {
    case 'group': {
      // AZ-A12 clause 12: "Owned by" (the owner column) before "Shared with" (a live Group grant).
      const first = ownership.groups[0];
      const basis = first?.basis ?? ownership.basis ?? null;
      if (basis === 'owner') {
        return first
          ? { rank: RANK['group-owner'], sort: first.name.toLowerCase(), key: `group-owner-${first.id}`, title: `Owned by ${first.name}` }
          : { rank: RANK['group-hidden'], sort: '', key: 'group-owner-hidden', title: 'Owned by a Group' };
      }
      if (basis === 'grant') {
        return first
          ? { rank: RANK.group, sort: first.name.toLowerCase(), key: `group-${first.id}`, title: `Shared with ${first.name}` }
          : { rank: RANK['group-hidden'], sort: '', key: 'group-hidden', title: 'Shared with a Group' };
      }
      return first
        ? { rank: RANK.group, sort: first.name.toLowerCase(), key: `group-${first.id}`, title: `Group: ${first.name}` }
        : { rank: RANK['group-hidden'], sort: '', key: 'group-hidden', title: 'Group-owned projects' };
    }
    case 'shared':
      return { rank: RANK.shared, sort: '', key: 'shared', title: 'Shared projects' };
    case 'private':
      if (ownership.ownerIsViewer) return { rank: RANK['private-yours'], sort: '', key: 'private-yours', title: 'Private: your projects' };
      return ownership.ownerHandle
        ? { rank: RANK['private-other'], sort: ownership.ownerHandle.toLowerCase(), key: `private-${ownership.ownerHandle}`, title: `Private to ${ownership.ownerHandle}` }
        : { rank: RANK['private-other'], sort: '￿', key: 'private-other', title: 'Private to another Account' };
    default:
      return { rank: RANK.board, sort: '', key: 'board', title: 'Board-level' };
  }
}

const safeKey = (key: string): string => key.replace(/[^A-Za-z0-9_-]/g, '-');

export function groupHubItems<T extends Classified>(items: T[]): Array<HubSection<T>> {
  const sections = new Map<string, HubSection<T> & { rank: number; sort: string }>();
  for (const item of items) {
    const place = placement(item);
    const existing = sections.get(place.key);
    if (existing) existing.items.push(item);
    else sections.set(place.key, { key: safeKey(place.key), title: place.title, items: [item], rank: place.rank, sort: place.sort });
  }
  return [...sections.values()]
    .sort((a, b) => a.rank - b.rank || a.sort.localeCompare(b.sort) || a.key.localeCompare(b.key))
    .map(({ key, title, items: sectionItems }) => ({ key, title, items: sectionItems }));
}

/** The hub's list read: the hub view, its status, and the URL's kind and group filters. */
export function hubListQuery(status: string, kind: string | null, group: string | null): string {
  const params = new URLSearchParams({ view: 'hub', status });
  if (kind) params.set('kind', kind);
  if (group) params.set('group', group);
  return `?${params.toString()}`;
}

/** `?group=`: a class word or a Group id, as the server accepts it. Anything else is not a filter. */
export function isHubGroupFilter(value: string | null): value is string {
  if (!value) return false;
  return ['shared', 'private', 'board'].includes(value)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
