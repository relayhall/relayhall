import { KeyRound, Palette, Plug, ShieldCheck, SlidersHorizontal, Users, LucideIcon } from 'lucide-react';

/**
 * THE SETTINGS INFORMATION ARCHITECTURE, as data.
 *
 * Card `d0f030a9` (RH-UI.SETTINGS.2), contract report `8dbc0b81`. The sidebar
 * had TWO account destinations — `Settings` and `Preferences` — and the
 * Settings shell showed four sibling tabs in which three consecutive
 * implementation generations of the SAME concept (Access grants, Access
 * manager, Identities) read as three separate products. There is now one
 * destination and one stable left navigation, and this module is the only
 * place its shape is written down: the shell renders from it, the router's
 * children are censused against it, and the Access-surface catalogue is
 * censused against it.
 *
 * NOTHING HERE DECIDES AUTHORITY. `surfaceKey` names the ratified Access
 * surface an entry belongs to; whether this session may SEE it is answered by
 * the server (`GET /principals/me` -> `settingsSurfaces`, computed by
 * `AccessSurfaceService.armDecision` — the same function the request path
 * calls). `fallback` is used only when the board did not answer at all.
 */

export type SettingsNavGroupId = 'preferences' | 'access' | 'deployment';

/**
 * The entry ids, as a union rather than `string`.
 *
 * ROUND-2 REVIEW P1. The router mounts one child per entry and `App.tsx`
 * supplies one page element per entry through a `Record<SettingsNavEntryId, …>`
 * — so a new entry with no page, or a page for an entry that no longer exists,
 * is a COMPILE error. That is the only hand-written list left in the settings
 * route table, and it is the one the type checker counts for us.
 */
export type SettingsNavEntryId =
  | 'preferences'
  | 'connections'
  | 'access-manager'
  | 'access-grants'
  | 'identities'
  | 'appearance';

export interface SettingsNavGroupMeta {
  id: SettingsNavGroupId;
  label: string;
  order: number;
}

/**
 * What an entry was reachable by BEFORE SETGOV, and what it falls back to when
 * the board answers `settingsSurfaces: null` (an older board, or a catalogue
 * read that failed).
 *
 *  - `self` — every authenticated Account reached it. Today's `SELF_SCOPE_TABS`
 *    plus the personal Preferences page.
 *  - `root` — only the root administration plane reached it. Today's
 *    `ROOT_TABS` remainder.
 *
 * The fallback is never WIDER than the arm: on every entry the arm can only
 * ADD a non-root session that holds a written-down access level, so degrading
 * to the fallback degrades in the closed direction.
 */
export type SettingsNavFallback = 'self' | 'root';

export interface SettingsNavEntry {
  id: SettingsNavEntryId;
  /** The canonical route. The router mounts exactly this path under /settings. */
  path: string;
  label: string;
  /** The one-line description under the label; also the link's accessible hint. */
  description: string;
  icon: LucideIcon;
  group: SettingsNavGroupId;
  order: number;
  /**
   * The ratified Access-surface key (migration `109_access_surfaces.sql`), or
   * `null` for a surface the catalogue does not govern because it declares no
   * root-gated family — My connections reads `GET /principals/me/connectors`,
   * which is the caller's OWN chain and `authenticated` by its own rule.
   */
  surfaceKey: string | null;
  fallback: SettingsNavFallback;
}

export const settingsNavGroups: SettingsNavGroupMeta[] = [
  { id: 'preferences', label: 'Preferences', order: 0 },
  { id: 'access', label: 'Access administration', order: 1 },
  { id: 'deployment', label: 'Deployment', order: 2 },
];

/**
 * Every settings destination that exists TODAY, grouped. This card moved
 * pages; it added none, and an entry here with no page behind it would fail
 * the router census in `settingsRouteCensus.test.ts`.
 */
export const settingsNavEntries: SettingsNavEntry[] = [
  {
    id: 'preferences',
    path: '/settings/preferences',
    label: 'Preferences',
    description: 'Theme, motion and your own login sessions.',
    icon: SlidersHorizontal,
    group: 'preferences',
    order: 0,
    surfaceKey: 'settings.preferences',
    fallback: 'self',
  },
  {
    id: 'connections',
    path: '/settings/connections',
    label: 'My connections',
    description: 'The agents and tools connected as you.',
    icon: Plug,
    group: 'preferences',
    order: 1,
    surfaceKey: null,
    fallback: 'self',
  },
  {
    id: 'access-manager',
    path: '/settings/access-manager',
    label: 'Access manager',
    description: 'Approvals, Warrants, credentials and identity providers.',
    icon: ShieldCheck,
    group: 'access',
    order: 0,
    surfaceKey: 'settings.access-manager',
    fallback: 'self',
  },
  {
    id: 'access-grants',
    path: '/settings/access',
    label: 'Access grants',
    description: 'Direct grants over Tasks, Projects and the rest.',
    icon: KeyRound,
    group: 'access',
    order: 1,
    surfaceKey: 'settings.access-grants',
    fallback: 'root',
  },
  {
    id: 'identities',
    path: '/settings/principals',
    label: 'Identities',
    description: 'Accounts, agents and their credentials.',
    icon: Users,
    group: 'access',
    order: 2,
    surfaceKey: 'settings.identities',
    fallback: 'root',
  },
  {
    id: 'appearance',
    path: '/settings/appearance',
    label: 'Appearance',
    description: 'Deployment-wide branding, logo and default Theme.',
    icon: Palette,
    group: 'deployment',
    order: 0,
    surfaceKey: 'settings.appearance',
    fallback: 'root',
  },
];

/**
 * ONE navigation entry's visibility, as the server decided it.
 *
 * The shape of `GET /principals/me` -> `settingsSurfaces[]`. `null` from the
 * board means "not answered"; an ABSENT key means this deployment's catalogue
 * does not register that surface, which is not the same thing and is not an
 * error — the entry then falls back too.
 */
export interface SettingsSurfaceVisibility {
  key: string;
  visible: boolean;
}

/**
 * WHAT AN ANSWER MEANS, now that a concealed row carries only its key
 * (round-1 review P3 — the full row published a map of the deployment to a
 * session that may not see it):
 *
 *   present, `visible: true`   — this session may see it. The row also carries
 *                                the label and path, which it could read off
 *                                the page anyway.
 *   present, `visible: false`  — REGISTERED HERE AND CONCEALED.
 *   absent                     — either not registered in this deployment, or
 *                                a concealed PLUGIN surface the server will not
 *                                enumerate. Both fall back, and the fallback is
 *                                never wider than the arm.
 *
 * The middle and the last must not collapse into each other: "concealed" has
 * to stay hidden, and "this deployment has no such surface" has to fall back to
 * what the entry was reachable by before SETGOV.
 */

export interface SettingsNavAudience {
  /** The server's answer, or `null`/`undefined` when it did not give one. */
  surfaces: SettingsSurfaceVisibility[] | null | undefined;
  /** The pre-SETGOV root predicate — the fallback, never the primary rule. */
  canManage: boolean;
}

/**
 * May this session SEE this entry?
 *
 * A surface a session may not see is NOT RENDERED — never rendered disabled,
 * never rendered with a refusal behind it (SETGOV `83defda6`). A disabled
 * control still discloses that the deployment has the thing, which is exactly
 * what the arm's 404 concealment on a read family exists to prevent.
 */
export function settingsEntryVisible(entry: SettingsNavEntry, audience: SettingsNavAudience): boolean {
  const fallback = entry.fallback === 'self' ? true : audience.canManage;
  if (entry.surfaceKey === null) return fallback;
  if (!audience.surfaces) return fallback;
  const answered = audience.surfaces.find((surface) => surface.key === entry.surfaceKey);
  if (!answered) return fallback;
  return answered.visible;
}

/** The groups this session sees, each with the entries it sees, both ordered. */
export function visibleSettingsGroups(
  audience: SettingsNavAudience,
): { group: SettingsNavGroupMeta; items: SettingsNavEntry[] }[] {
  return [...settingsNavGroups]
    .sort((a, b) => a.order - b.order)
    .map((group) => ({
      group,
      items: settingsNavEntries
        .filter((entry) => entry.group === group.id && settingsEntryVisible(entry, audience))
        .sort((a, b) => a.order - b.order),
    }))
    .filter((section) => section.items.length > 0);
}

/**
 * THE PATH THIS ENTRY IS MOUNTED AT, relative to the `/settings` shell.
 *
 * ROUND-2 REVIEW P1. There used to be a `settingsEntryConcealed(pathname, …)`
 * here, which asked whether a rendered pathname EQUALLED an entry's path and
 * let the shell filter its own outlet with the answer. It was a second matcher
 * beside React Router's, and it disagreed with it: `/settings/access/` and
 * `/settings/ACCESS` both route to the `access` child — trailing slash and
 * case are the router's own defaults — and neither is string-equal to
 * `/settings/access`, so both rendered the page the shell meant to conceal.
 *
 * It is gone, and nothing replaced it in this module. Concealment is decided
 * inside the route element by `SettingsEntryGuard` (`config/settingsRoutes`),
 * which runs only because the ROUTER already matched that child — so the
 * matcher that admits a spelling is the matcher that guards it, by
 * construction rather than by agreement. What is left here is the derivation
 * the router mounts FROM, which is the opposite direction and holds no
 * predicate at all.
 */

/** The shell's own path. Every entry lives under it; nothing else does. */
export const SETTINGS_SHELL_PATH = '/settings';

export function settingsChildRoutePath(entry: SettingsNavEntry): string {
  return entry.path.slice(SETTINGS_SHELL_PATH.length + 1);
}

/** Where `/settings` itself lands: the first entry this session can see. */
export function firstVisibleSettingsPath(audience: SettingsNavAudience): string | null {
  return visibleSettingsGroups(audience)[0]?.items[0]?.path ?? null;
}
