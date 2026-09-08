import { 
  Home, 
  ListTodo,
  FolderKanban,
  Activity,
  BarChart3,
  Wrench,
  GraduationCap,
  Radio,
  Briefcase,
  ClipboardList,
  Bot,
  BookOpen,
  LucideIcon
} from 'lucide-react';

/**
 * Navigation configuration - Single source of truth for all navigation items.
 * Used by Sidebar and Dashboard HeroCard quick actions.
 */

/** Sidebar menu group identifiers */
export type NavGroup = 'main' | 'workspace';

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
];

/**
 * All navigation items in the application.
 * Add new pages here and they'll automatically appear in both sidebar and hero.
 */
export const navigationItems: NavItem[] = [
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
  {
    id: 'sessions',
    path: '/sessions',
    label: 'Agent sessions',
    icon: Radio,
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
];

/**
 * Get navigation items for sidebar (filtered and sorted)
 */
export const getSidebarNavItems = (): NavItem[] => {
  return navigationItems
    .filter(item => item.showInSidebar)
    .sort((a, b) => a.order - b.order);
};

/**
 * Get sidebar items grouped by their NavGroup
 */
export const getSidebarGroups = (): { group: NavGroupMeta; items: NavItem[] }[] => {
  const sidebarItems = getSidebarNavItems();
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
    .filter(item => item.showInHero)
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
