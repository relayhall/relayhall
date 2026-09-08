import React from 'react';
import { Route, useOutletContext } from 'react-router-dom';
import {
  SettingsNavAudience,
  SettingsNavEntry,
  settingsChildRoutePath,
  settingsEntryVisible,
  settingsNavEntries,
} from './settingsNavigation';

/**
 * THE SETTINGS CHILD ROUTES, AND THE GUARD THAT IS PART OF EACH ONE.
 *
 * Card `d0f030a9`. ROUND-2 REVIEW P1 is the reason this module exists.
 *
 * ── WHAT WENT WRONG, AND WHAT CLASS IT BELONGED TO ──
 *
 * The first repair filtered the shell's `<Outlet />` by comparing
 * `location.pathname` to the entry's path with `===`. That is a SECOND
 * MATCHER, and a second matcher disagrees with the first one: React Router
 * matches `/settings/access/` and `/settings/ACCESS` to the `access` child —
 * trailing slash and case are its own defaults — while string equality says
 * those are different paths. Both spellings routed to the page and neither was
 * concealed. The class is not "two spellings were missed"; it is "the shell
 * decided a routing question with something that is not the router". A third
 * spelling, an `index` child, a splat, a future alias — every one of them is
 * the same defect again.
 *
 * ── HOW IT IS DECIDED NOW ──
 *
 * By the ROUTER. The decision moved INSIDE the route element: each settings
 * child is mounted as `<SettingsEntryGuard entry={…}>{page}</SettingsEntryGuard>`,
 * so the guard runs exactly when React Router has already decided that this
 * route is the match, and it guards exactly the entry that route belongs to.
 * There is no path comparison left anywhere in the shell. Whatever spelling
 * the router accepts — today's, and any it accepts after an upgrade — reaches
 * the guard, because reaching the page IS reaching the guard.
 *
 * The routes are GENERATED from `settingsNavEntries`, so a child cannot be
 * mounted unguarded and a child cannot be mounted that the navigation does not
 * name: there is no place to type one. `App.tsx` supplies only the page
 * element per entry, through a `Record` keyed by the entry-id union, which
 * makes a missing page a COMPILE error rather than a route that quietly
 * disappears.
 *
 * The refusal names nothing. It is the same sentence whichever entry was
 * asked for, so it cannot be used to probe which surfaces a deployment has —
 * the concealment the arm's 404 provides at the HTTP seam, provided here at
 * the render seam. It is honesty about rendering and NOT an authorization
 * boundary: the backend refuses independently and is what actually decides.
 */

/** The one refusal sentence. Exported so a test cannot drift from it. */
export const SETTINGS_CONCEALED_MESSAGE = 'This identity has no access to that settings page.';

/**
 * One settings child, guarded where the router put it.
 *
 * The audience comes from the shell through React Router's own outlet context,
 * which is the same edge the `<Outlet />` renders across — so the guard cannot
 * be mounted outside the shell and silently get a different answer. No
 * context at all is a REFUSAL, not a fallback: a guard that does not know who
 * is asking must not admit.
 */
export const SettingsEntryGuard: React.FC<{
  entry: SettingsNavEntry;
  children?: React.ReactNode;
}> = ({ entry, children }) => {
  const audience = useOutletContext<SettingsNavAudience | null>();
  if (!audience || !settingsEntryVisible(entry, audience)) {
    return (
      <div className="settings-error" role="alert">{SETTINGS_CONCEALED_MESSAGE}</div>
    );
  }
  return <>{children}</>;
};

/**
 * Every settings child route, generated. `page` supplies the element behind
 * each entry; the mount path and the guard are not the caller's to choose.
 */
export function settingsChildRoutes(
  page: (entry: SettingsNavEntry) => React.ReactNode,
): React.ReactElement[] {
  return settingsNavEntries.map((entry) => (
    <Route
      key={entry.id}
      path={settingsChildRoutePath(entry)}
      element={<SettingsEntryGuard entry={entry}>{page(entry)}</SettingsEntryGuard>}
    />
  ));
}
