import { 
  Home, 
  ListTodo,
  FolderKanban,
  Activity,
  BarChart3,
  Wrench,
  GraduationCap,
  Inbox,
  Briefcase,
  ClipboardList,
  Bot,
  BookOpen,
  Network,
  UsersRound,
  Users,
  KeyRound,
  SlidersHorizontal,
  ShieldCheck,
  LucideIcon
} from 'lucide-react';
import { MEMBER_ONLY, type MyLenses } from '../types/lenses';
import {
  settingsEntryVisible,
  settingsNavEntries,
  type SettingsNavAudience,
  type SettingsNavEntryId,
} from './settingsNavigation';

/**
 * Navigation configuration - Single source of truth for all navigation items.
 * Used by Sidebar and Dashboard HeroCard quick actions.
 */

/** Sidebar menu group identifiers */
export type NavGroup = 'main' | 'workspace' | 'administration';

/**
 * Which lens OFFERS an entry (RH-LENSES-d, card 4e159741; design 96f0bd3d
 * s8.4). `member` is every signed-in person; `admin` is a root LOGIN SESSION,
 * as `GET /principals/me/lenses` decides it; `manager` (LENSES-c c1-B, card
 * b5c83682; design delta C.8) is a holder of a live owner or manager role in a
 * Group. A lens decides only whether the entry is RENDERED: every page behind
 * it keeps its own server ceiling.
 */
export type NavLens = 'member' | 'manager' | 'admin';

export interface NavItem {
  /** Unique identifier for the nav item */
  id: string;
  /** Route path (e.g., '/tasks') */
  path: string;
  /** Display label in sidebar */
  label: string;
  /** Optional alternate label for dashboard quick actions */
  heroLabel?: string;
  /** Lucide icon component */
  icon: LucideIcon;
  /** Whether to show in sidebar navigation */
  showInSidebar: boolean;
  /** Whether to show in dashboard hero quick actions */
  showInHero: boolean;
  /** Sort order (lower = first) */
  order: number;
  /** Sidebar group — 'main' (always visible) or 'workspace' (collapsible) */
  group: NavGroup;
  /** The lens that offers it; absent means `member`. */
  lens?: NavLens;
  /**
   * The Settings entry this destination IS, when it is one. A lens is
   * NECESSARY, NEVER SUFFICIENT (design s8.4 rule 2): such an entry is offered
   * only when the Settings shell would also show it to this session, which is
   * the Access-surface arm's own answer (`settingsSurfaces`).
   */
  settingsEntry?: SettingsNavEntryId;
}

/** Group metadata for rendering collapsible sections */
export interface NavGroupMeta {
  id: NavGroup;
  label: string;
  icon: LucideIcon;
  /** Whether the group is collapsible */
  collapsible: boolean;
  /** Default collapsed state */
  defaultCollapsed: boolean;
  order: number;
}

export const navGroups: NavGroupMeta[] = [
  { id: 'main', label: 'Main', icon: Home, collapsible: false, defaultCollapsed: false, order: 0 },
  // Vocabulary `b94dd86e` §7 retires the capitalised group label `Workspace`
  // because it collides with the `workspace` Resource kind, and names this
  // line as the only site in the tree. The group id is never rendered, so it
  // keeps its value and the stored collapse state with it — only the label a
  // person reads changes. `More` is a placeholder chosen to be accurate about
  // a group holding Skills, Tools, Personalities, Audit log and Stats (a
  // capability word would be false about the last two); the owner can replace
  // this one string without touching anything else.
  { id: 'workspace', label: 'More', icon: Briefcase, collapsible: true, defaultCollapsed: false, order: 1 },
  // RH-LENSES-d: the admin lens's sections (design 96f0bd3d s8.4; owner design
  // record 99d6b0ad s3.3). Rendered only for a session the server names admin.
  { id: 'administration', label: 'Administration', icon: ShieldCheck, collapsible: true, defaultCollapsed: false, order: 2 },
];

/**
 * All navigation items in the application.
 * Add new pages here and they'll automatically appear in both sidebar and hero.
 */
export const navigationItems: NavItem[] = [
  { id: 'knowledge', path: '/knowledge', label: 'Knowledge', icon: BookOpen, showInSidebar: true, showInHero: false, order: 5, group: 'main' },
  // === Main group (always visible, not collapsible) ===
  {
    id: 'dashboard',
    path: '/',
    label: 'Dashboard',
    icon: Home,
    showInSidebar: true,
    showInHero: false,
    order: 0,
    group: 'main',
  },
  // Owner ruling E453: the Action Center, directly under Dashboard. It holds
  // Notifications (Needs your action), the Timeline, Approvals, My requests
  // and Agent sessions, which left the menu for its tab (`/sessions` is an
  // alias of that tab).
  {
    id: 'action-center',
    path: '/action-center',
    label: 'Action Center',
    icon: Inbox,
    showInSidebar: true,
    showInHero: true,
    order: 1,
    group: 'main',
  },
  {
    id: 'tasks',
    path: '/tasks',
    label: 'Tasks',
    heroLabel: 'Tasks',
    icon: ListTodo,
    showInSidebar: true,
    showInHero: true,
    order: 2,
    group: 'main',
  },
  {
    id: 'projects',
    path: '/projects',
    label: 'Projects',
    icon: FolderKanban,
    showInSidebar: true,
    showInHero: true,
    order: 3,
    group: 'main',
  },
  {
    id: 'reports',
    path: '/reports',
    label: 'Reports',
    icon: ClipboardList,
    showInSidebar: true,
    showInHero: true,
    order: 4,
    group: 'main',
  },
  // LENSES-c c1-B (card b5c83682; design delta C.8, v7 s8.4 "My team"): the
  // manager lens's one section - each Group the person live-stewards, its
  // members, its roles and its team grants, and, for an owner, appointing and
  // removing managers with a step-up. Every request it makes keeps its route.
  {
    id: 'team', path: '/team', label: 'My team', icon: UsersRound,
    showInSidebar: true, showInHero: false, order: 6, group: 'main', lens: 'manager',
  },
  // === Workspace group (collapsible) ===
  {
    id: 'skills',
    path: '/skills',
    label: 'Skills',
    icon: GraduationCap,
    showInSidebar: true,
    showInHero: true,
    order: 10,
    group: 'workspace',
  },
  {
    id: 'blueprints',
    path: '/blueprints',
    label: 'Blueprints',
    icon: BookOpen,
    showInSidebar: true,
    showInHero: true,
    order: 10,
    group: 'workspace',
  },
  {
    id: 'tools',
    path: '/tools',
    label: 'Tools',
    icon: Wrench,
    showInSidebar: true,
    showInHero: true,
    // Same order as Skills: the stable sort keeps array position, slotting
    // Tools directly after Skills without renumbering later entries.
    order: 10,
    group: 'workspace',
  },
  {
    id: 'personalities',
    path: '/personalities',
    label: 'Personalities',
    heroLabel: 'Personalities',
    icon: Bot,
    showInSidebar: true,
    showInHero: true,
    order: 11,
    group: 'workspace',
  },
  {
    id: 'audit',
    path: '/audit',
    label: 'Audit log',
    icon: Activity,
    showInSidebar: true,
    showInHero: true,
    order: 10,
    group: 'workspace',
  },
  {
    id: 'stats',
    path: '/stats',
    label: 'Stats',
    icon: BarChart3,
    showInSidebar: true,
    showInHero: true,
    order: 10,
    group: 'workspace',
  },
  // === Administration group (the admin lens; RH-LENSES-d) ===
  // Directory: Identity providers, their sync health and the remote-group
  // catalog. Groups: board Groups, their directory binding and the featured
  // flag. People, Access and Advanced are the Settings pages that already
  // administer those things, offered here only when Settings would show them.
  {
    id: 'admin-directory', path: '/directory', label: 'Directory', icon: Network,
    showInSidebar: true, showInHero: false, order: 20, group: 'administration', lens: 'admin',
  },
  {
    id: 'admin-groups', path: '/groups', label: 'Groups', icon: UsersRound,
    showInSidebar: true, showInHero: false, order: 21, group: 'administration', lens: 'admin',
  },
  {
    id: 'admin-people', path: '/settings/principals', label: 'People', icon: Users,
    showInSidebar: true, showInHero: false, order: 22, group: 'administration', lens: 'admin', settingsEntry: 'identities',
  },
  {
    id: 'admin-access', path: '/settings/access', label: 'Access', icon: KeyRound,
    showInSidebar: true, showInHero: false, order: 23, group: 'administration', lens: 'admin', settingsEntry: 'access-grants',
  },
  {
    id: 'admin-advanced', path: '/settings/access-manager', label: 'Advanced', icon: SlidersHorizontal,
    showInSidebar: true, showInHero: false, order: 24, group: 'administration', lens: 'admin', settingsEntry: 'access-manager',
  },
];

/**
 * Who the sidebar is drawn for: the server's lens answer and the Settings
 * shell's own audience. The default is a member whose Settings surfaces are
 * unknown, which is the narrowest navigation there is.
 */
export interface NavAudience {
  lenses: MyLenses;
  settings: SettingsNavAudience;
}

export const MEMBER_AUDIENCE: NavAudience = {
  lenses: MEMBER_ONLY,
  settings: { surfaces: null, canManage: false },
};

/**
 * Is this entry OFFERED to this audience? The lens first (an `admin` entry
 * needs the admin lens), then, for an entry that is a Settings page, the
 * Access-surface arm's answer for that page. Both must hold: the lens is
 * necessary, never sufficient.
 */
export function navItemOffered(item: NavItem, audience: NavAudience = MEMBER_AUDIENCE): boolean {
  if ((item.lens ?? 'member') === 'admin' && !audience.lenses.admin) return false;
  if (item.lens === 'manager' && !audience.lenses.lenses.includes('manager')) return false;
  if (item.settingsEntry) {
    const entry = settingsNavEntries.find((candidate) => candidate.id === item.settingsEntry);
    if (!entry || !settingsEntryVisible(entry, audience.settings)) return false;
  }
  return true;
}

/**
 * Get navigation items for sidebar (filtered and sorted)
 */
export const getSidebarNavItems = (audience: NavAudience = MEMBER_AUDIENCE): NavItem[] => {
  return navigationItems
    .filter(item => item.showInSidebar && navItemOffered(item, audience))
    .sort((a, b) => a.order - b.order);
};

/**
 * Get sidebar items grouped by their NavGroup
 */
export const getSidebarGroups = (audience: NavAudience = MEMBER_AUDIENCE): { group: NavGroupMeta; items: NavItem[] }[] => {
  const sidebarItems = getSidebarNavItems(audience);
  return navGroups
    .sort((a, b) => a.order - b.order)
    .map(group => ({
      group,
      items: sidebarItems.filter(item => item.group === group.id),
    }))
    .filter(g => g.items.length > 0);
};

/**
 * Get navigation items for hero quick actions (filtered and sorted)
 */
export const getHeroNavItems = (): NavItem[] => {
  return navigationItems
    .filter(item => item.showInHero && (item.lens ?? 'member') === 'member')
    .sort((a, b) => a.order - b.order);
};

/**
 * Get display label for a nav item (uses heroLabel if available and in hero context)
 */
export const getNavLabel = (item: NavItem, context: 'sidebar' | 'hero' = 'sidebar'): string => {
  if (context === 'hero' && item.heroLabel) {
    return item.heroLabel;
  }
  return item.label;
};
