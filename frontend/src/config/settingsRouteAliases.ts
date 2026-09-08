/**
 * THE REDIRECT MAP — every path this card moved, and where it now lands.
 *
 * Card `d0f030a9`, contract `8dbc0b81` "Compatibility and deep-link contract".
 * A bookmark, a notification link and a pasted approval deep link must all keep
 * working, so a moved route is never deleted: it becomes an alias that replaces
 * itself in history with its target.
 *
 * TWO PROPERTIES, both drilled in `settingsRouteAliases.test.tsx`:
 *
 *  1. THE QUERY AND THE FRAGMENT SURVIVE. The aliases this shell replaced used
 *     a bare `<Navigate to="/settings/appearance" replace />`, whose target is
 *     a STRING: `?approval=<id>` and `#section` were dropped on the floor, so
 *     an Access-manager deep link mailed to a person arrived as a bare page.
 *     `settingsAliasTarget` carries both across.
 *  2. NO ALIAS IS A TARGET. A map where one entry's `to` is another's `from`
 *     is a redirect loop one refactor away; the census refuses it.
 *
 * An alias carries NO AUTHORITY. It is a client-side path rewrite: the login
 * wall, the route stage and the Access-surface arm all still decide the target,
 * and a person who follows a link to a surface they may not see meets the
 * shell's own refusal, not the page — `settingsEntryConcealed` in
 * `settingsNavigation`, which round-1 review P1 is the reason this sentence is
 * now true rather than merely intended.
 */
export interface SettingsRouteAlias {
  /** The path as it was published. */
  from: string;
  /** The path it resolves to now. */
  to: string;
  /** Why it exists — read by nobody but the person reading this file. */
  note: string;
}

export const SETTINGS_ROUTE_ALIASES: readonly SettingsRouteAlias[] = [
  {
    from: '/preferences',
    to: '/settings/preferences',
    note: 'RH-UI.2 put the personal preferences page at the sidebar root; this card moves it into the Settings shell as the first Preferences entry.',
  },
  {
    from: '/appearance',
    to: '/settings/appearance',
    note: 'Pre-RH-UI.SETTINGS deployment appearance. Already an alias; it now keeps the query and the fragment.',
  },
  {
    from: '/principals',
    to: '/settings/principals',
    note: 'Pre-RH-UI.SETTINGS identity directory. Already an alias; it now keeps the query and the fragment.',
  },
] as const;

/** The alias target with the caller's query string and fragment carried over. */
export function settingsAliasTarget(
  alias: SettingsRouteAlias,
  location: { search?: string; hash?: string },
): string {
  return `${alias.to}${location.search ?? ''}${location.hash ?? ''}`;
}
