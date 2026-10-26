/**
 * The one current-page rule (owner bug report E406): whole path segments, the
 * dashboard only on itself, and the longest match wins so at most one entry
 * is active.
 */
import { describe, expect, test } from 'vitest';
import { activeNavEntry, navPathMatches } from './navActive';

const ADMINISTRATION = [
  { id: 'people', path: '/settings/principals' },
  { id: 'access', path: '/settings/access' },
  { id: 'advanced', path: '/settings/access-manager' },
];

const activeId = (pathname: string, entries: readonly { id: string; path: string }[]) =>
  activeNavEntry(pathname, entries)?.id ?? null;

describe('an entry matches by whole path segments', () => {
  test('a longer sibling that shares a character prefix does not match', () => {
    expect(navPathMatches('/settings/access-manager', '/settings/access')).toBe(false);
    expect(navPathMatches('/settings/accessory', '/settings/access')).toBe(false);
    expect(navPathMatches('/tasksx', '/tasks')).toBe(false);
  });

  test('the page itself and every route below it match', () => {
    expect(navPathMatches('/settings/access', '/settings/access')).toBe(true);
    expect(navPathMatches('/settings/access/', '/settings/access')).toBe(true);
    expect(navPathMatches('/settings/access/grant-1', '/settings/access')).toBe(true);
    expect(navPathMatches('/tasks/abc', '/tasks')).toBe(true);
  });

  test('case and a trailing slash on the entry are ignored, as the router ignores them', () => {
    expect(navPathMatches('/Settings/ACCESS', '/settings/access')).toBe(true);
    expect(navPathMatches('/journal/today', '/journal/')).toBe(true);
    expect(navPathMatches('/journalist', '/journal/')).toBe(false);
  });

  test('the dashboard matches only itself', () => {
    expect(navPathMatches('/', '/')).toBe(true);
    expect(navPathMatches('/tasks', '/')).toBe(false);
    expect(navPathMatches('/settings/access', '/')).toBe(false);
  });
});

describe('exactly one entry is the current page', () => {
  test('on /settings/access-manager only Advanced, on /settings/access only Access', () => {
    expect(activeId('/settings/access-manager', ADMINISTRATION)).toBe('advanced');
    expect(activeId('/settings/access', ADMINISTRATION)).toBe('access');
  });

  test('a nested child route still activates its parent', () => {
    expect(activeId('/settings/access-manager/approvals', ADMINISTRATION)).toBe('advanced');
    expect(activeId('/settings/access/grant-1', ADMINISTRATION)).toBe('access');
  });

  test('when two entries match, the longest path wins, whatever the drawing order', () => {
    const entries = [
      { id: 'tasks', path: '/tasks' },
      { id: 'insights', path: '/tasks/insights' },
    ];
    expect(activeId('/tasks/insights/week', entries)).toBe('insights');
    expect(activeId('/tasks/insights/week', [...entries].reverse())).toBe('insights');
    expect(activeId('/tasks/abc', entries)).toBe('tasks');
  });

  test('two entries with the same path: the first drawn wins, so still only one', () => {
    const first = { id: 'first', path: '/knowledge' };
    const second = { id: 'second', path: '/knowledge/' };
    expect(activeNavEntry('/knowledge', [first, second])).toBe(first);
  });

  test('no entry matches: none is active', () => {
    expect(activeId('/settings/accessory', ADMINISTRATION)).toBeNull();
    expect(activeId('/about', [{ id: 'dashboard', path: '/' }, ...ADMINISTRATION])).toBeNull();
  });

  test('the dashboard is active on / and nowhere else', () => {
    const entries = [{ id: 'dashboard', path: '/' }, { id: 'tasks', path: '/tasks' }];
    expect(activeId('/', entries)).toBe('dashboard');
    expect(activeId('/tasks', entries)).toBe('tasks');
  });
});
