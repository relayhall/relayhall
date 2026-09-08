/**
 * Plugin types for RelayHall frontend
 * 
 * These types match the backend PluginLoader API responses.
 */

/**
 * A sidebar navigation item from a plugin
 */
export interface PluginSidebarItem {
  /** Display label in sidebar */
  label: string;
  /** Lucide icon name (e.g., "book", "box") */
  icon: string;
  /** Frontend route path (e.g., "/journal") */
  path: string;
  /** Optional API path for badge count */
  badge?: string | null;
}

/**
 * A UI route that the plugin exposes
 */
export interface PluginRoute {
  /** Frontend path (e.g., "/journal") */
  path: string;
  /** Plugin-internal path to proxy to (e.g., "/ui/") */
  proxy_to: string;
}

/**
 * Plugin info as returned by GET /api/plugins
 */
export interface PluginInfo {
  /** Plugin name (e.g., "claw-journal") */
  name: string;
  /** Semantic version (e.g., "1.0.0") */
  version: string;
  /** Human-readable description */
  description: string;
  /** Whether the plugin's health check passed */
  healthy: boolean;
  /** Sidebar navigation items */
  sidebar: PluginSidebarItem[];
  /** UI routes the plugin exposes */
  routes: PluginRoute[];
  /** Plugin API base path */
  api_base: string;
  /** Plugin category (e.g., "productivity") */
  category?: string;
}

/**
 * API response from GET /api/plugins
 */
export interface PluginsResponse {
  plugins: PluginInfo[];
}

/**
 * Extended sidebar item with plugin metadata for rendering
 */
export interface PluginNavItem extends PluginSidebarItem {
  /** Plugin name this item belongs to */
  pluginName: string;
  /** Whether the plugin is healthy */
  healthy: boolean;
}
