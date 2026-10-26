/**
 * WHICH NAVIGATION ENTRY IS THE CURRENT PAGE: ONE RULE FOR EVERY MENU.
 *
 * Owner bug report E406 (20 Oct 2026). The sidebar marked an entry active
 * with `pathname.startsWith(to)`, a CHARACTER prefix, so on the Advanced page
 * (`/settings/access-manager`) the Access entry (`/settings/access`) lit up
 * as well: two entries claimed to be the page you were on.
 *
 * The rule is now about whole path SEGMENTS, and exactly one entry wins:
 *
 *  1. An entry matches when the pathname IS its path, or lies below it
 *     (its path followed by `/`). `/settings/access` matches
 *     `/settings/access` and `/settings/access/anything`, never
 *     `/settings/access-manager` or `/settings/accessory`.
 *  2. The dashboard (`/`) matches only itself; every pathname starts with
 *     `/`, so the segment rule would light it everywhere.
 *  3. When more than one entry still matches (a nested route, say a plugin
 *     entry at `/tasks/insights` beside Tasks at `/tasks`), the LONGEST path
 *     wins; on a tie the first entry in drawing order wins. So at most one
 *     entry is active, never two.
 *
 * The comparison ignores case and a trailing slash on the entry's path, as
 * the router's own matching does, so an entry is active on every spelling the
 * router sends to its page and no other.
 *
 * Every navigation that marks a current page (the sidebar, its plugin entries
 * and the Settings shell's section list) decides it HERE, through
 * `activeNavEntry`; none keeps a matcher of its own.
 */

/** The entry's path, lower-cased, without a trailing slash (`/` stays `/`). */
function normalisedTarget(path: string): string {
  const trimmed = path.toLowerCase().replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** Does `pathname` sit on or below `to`, by whole path segments? */
export function navPathMatches(pathname: string, to: string): boolean {
  const target = normalisedTarget(to);
  const current = pathname.toLowerCase();
  if (target === '/') return current === '/';
  return current === target || current.startsWith(`${target}/`);
}

/**
 * The ONE entry that is the current page, or `null` when none matches: the
 * longest matching path, the first such entry on a tie.
 */
export function activeNavEntry<T extends { path: string }>(pathname: string, entries: readonly T[]): T | null {
  let winner: T | null = null;
  let winnerLength = -1;
  for (const entry of entries) {
    if (!navPathMatches(pathname, entry.path)) continue;
    const length = normalisedTarget(entry.path).length;
    if (length > winnerLength) {
      winner = entry;
      winnerLength = length;
    }
  }
  return winner;
}
