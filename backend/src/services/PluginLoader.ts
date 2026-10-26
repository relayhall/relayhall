/**
 * PluginLoader - Discovers, validates, and manages RelayHall plugins
 * 
 * Reads relayhall.plugins.json on startup, validates plugin manifests,
 * builds an in-memory registry, and performs health checks.
 */
import fs from 'fs';
import { createHash } from 'crypto';
import { validatePluginContract, pluginPublicBasePath, isSafePluginPath, pluginLoadRefusalReason, pluginAssertionKeyShared } from './PluginHostContract';
import type { PluginSettingDeclaration } from './PluginSettingsSchema';
import path from 'path';
import { generateThemeCss, type ThemeCssOptions } from './pluginTheme';
import { randomUUID } from 'crypto';
import { logCaughtFailure } from '../utils/secretSafeLog';
import { probePluginHealth, type PluginHealthOutcome } from './PluginHealthProbe';

// ============================================
// Types
// ============================================

export interface PluginBlueprintReference {
  kind: string;
  name: string;
  service: string;
  tool: string;
}
export interface PluginSettingsEntry {
  id: string;
  label: string;
  scope: 'personal' | 'deployment';
  /** Plugin-internal UI path, protected by the matching proxy capability. */
  path: string;
  capability: string;
  /**
   * Whether the current caller cannot change this entry through the host proxy.
   * Computed by GET /plugins per request (pluginSettingReadOnly); a manifest
   * value is always replaced.
   */
  readOnly?: boolean;
}
/**
 * `ui.sidebar_widget`: height 48..240; `grow` is the E438(1) opt-in (absent = false);
 * `frame` is the E458 opt-in, exactly `'section'` (absent = the boxed block).
 */
export interface SidebarWidgetDeclaration {
  path: string;
  height: number;
  grow?: boolean;
  frame?: 'section';
}
export interface PluginManifest {
  schema_version?: 'rh.plugin/1';
  /** Named Connector tools that this plugin makes linkable in Tasks. */
  blueprintReferences?: PluginBlueprintReference[];
  name: string;
  version: string;
  description: string;
  docker: {
    image: string;
    build?: string;
    ports: Record<string, string>;
    volumes?: string[];
    environment?: Record<string, string>;
    networks?: string[];
    depends_on?: string[];
    runtime?: string | null;
    network_mode?: string | null;
  };
  api: {
    base_path: string;
    internal_port: number;
    health: string;
    endpoints?: Array<{
      method: string;
      path: string;
      description: string;
    }>;
    /**
     * Optional explicit proxy allowlist. When absent the proxy permits GET and
     * HEAD only, which covers every observed plugin request. `api.endpoints` is
     * documentation and is deliberately NOT used for enforcement — a plugin must
     * opt in to write methods here, on purpose.
     */
    allow?: Array<{
      methods: string[];
      capability?: string;
      path: string;
      match?: 'exact' | 'prefix';
    }>;
  };
  ui?: {
    enabled: boolean;
    sidebar?: Array<{
      label: string;
      icon: string;
      path: string;
      badge?: string | null;
    }>;
    routes?: Array<{
      path: string;
      proxy_to: string;
    }>;
    embedding?: 'proxy' | 'none';
    sidebar_widget?: SidebarWidgetDeclaration;
    settings?: PluginSettingsEntry[];
    /**
     * Card bedf50cc (E380): the settings the HOST stores, validates, renders
     * and resolves for this plugin. Optional: absent means no host settings.
     * Validated at load (PluginSettingsSchema); a bad schema refuses the plugin.
     */
    settings_schema?: PluginSettingDeclaration[];
  };
  config?: {
    schema?: Record<string, any>;
    defaults?: Record<string, any>;
  };
  agent?: {
    tool_name?: string;
    capabilities?: string[];
  };
  author?: string;
  license?: string;
  repository?: string;
  relayhall?: {
    min_version?: string;
    api_version?: number;
    trust?: 'installed';
    capabilities?: string[];
    category?: string;
  };
}

export interface PluginConfig {
  metrics_source_product?: string;
  /**
   * `default` is the deployment default every active Account holds: absent,
   * `[]` or exactly `["view"]` (anything else refuses the installation at
   * load). It never satisfies a non-view capability or a write; those stay
   * explicit `accounts` entries.
   */
  access?: { default?: string[]; accounts?: Record<string, string[]>; assertion_key_env?: string };
  name: string;
  source: string;
  enabled: boolean;
  config_override?: Record<string, any>;
}

export interface PluginsFileConfig {
  plugins: PluginConfig[];
}

export interface LoadedPlugin {
  name: string;
  config: PluginConfig;
  manifest: PluginManifest;
  healthy: boolean;
  lastHealthCheck: number | null;
  error?: string;
  /** Card fa519c4c: the last probe's closed outcome, kept to log changes, not every tick. */
  healthOutcome?: PluginHealthOutcome;
  healthRepeats?: number;
}

export interface PluginRegistryEntry {
  /** Current caller proxy-write description; supplied by GET /plugins, not the manifest. */
  hostProxyAccess?: { writeCapable: boolean };
  settings?: PluginSettingsEntry[];
  schema_version?: 'rh.plugin/1';
  capabilities?: string[];
  sidebar_widget?: SidebarWidgetDeclaration;
  blueprintReferences?: PluginBlueprintReference[];
  name: string;
  version: string;
  description: string;
  healthy: boolean;
  sidebar: Array<{
    label: string;
    icon: string;
    path: string;
    badge?: string | null;
  }>;
  routes: Array<{
    path: string;
    proxy_to: string;
  }>;
  api_base: string;
  internal_port: number;
  category?: string;
}

/** One compiled allowlist rule: which methods may reach which sub-path. */
export interface PluginProxyRule {
  capability?: string;
  methods: string[];
  path: string;
  match: 'exact' | 'prefix';
}

export interface PluginProxyRoute {
  pathPrefix: string;
  target: string;
  pluginName: string;
  allow: PluginProxyRule[];
}

/**
 * Read-only by default. Every plugin request observed in production is a GET,
 * so this denies nothing that is actually in use while closing the proxy to
 * writes, which reached plugin containers unauthenticated.
 */
export const DEFAULT_PLUGIN_PROXY_ALLOW: PluginProxyRule[] = [
  { methods: ['GET', 'HEAD'], path: '/', match: 'prefix' },
];

/**
 * The installations whose assertion keys are not their own (card bedf50cc,
 * E380 section 9, N16): two or more name the same `assertion_key_env`, or name
 * variables holding the same key. Key values are compared by SHA-256 digest in
 * memory only; neither a key nor a digest is ever logged or returned.
 */
export function sharedAssertionKeyInstallations(configs: PluginConfig[]): Set<string> {
  const byName = new Map<string, string[]>();
  const byDigest = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, name: string) => map.set(key, [...(map.get(key) ?? []), name]);
  for (const config of configs) {
    const variable = config.access?.assertion_key_env;
    if (typeof variable !== 'string' || variable.length === 0) continue;
    add(byName, variable, config.name);
    const value = process.env[variable];
    if (typeof value === 'string' && value.length > 0) add(byDigest, createHash('sha256').update(value).digest('hex'), config.name);
  }
  const shared = new Set<string>();
  for (const group of [...byName.values(), ...byDigest.values()]) {
    if (new Set(group).size > 1) group.forEach(name => shared.add(name));
  }
  return shared;
}

function compileAllowRules(manifest: PluginManifest): PluginProxyRule[] {
  const declared = manifest.api?.allow;
  if (!Array.isArray(declared) || declared.length === 0) {
    return DEFAULT_PLUGIN_PROXY_ALLOW;
  }
  return declared
    .filter(rule => rule && Array.isArray(rule.methods) && typeof rule.path === 'string')
    .map(rule => ({
      capability: rule.capability,
      methods: rule.methods.map(method => String(method).toUpperCase()),
      path: rule.path.startsWith('/') ? rule.path : `/${rule.path}`,
      match: rule.match === 'exact' ? 'exact' as const : 'prefix' as const,
    }));
}

/**
 * The sidebar widget as the registry describes it. Owner ruling E438(1): the
 * `grow` opt-in reaches the dashboard only when the manifest says exactly
 * true. Owner ruling E458: the `frame` opt-in reaches it only when the
 * manifest says exactly the string `section`. Every other key passes through
 * as it always has.
 */
function registrySidebarWidget(widget: SidebarWidgetDeclaration | undefined): SidebarWidgetDeclaration | undefined {
  if (!widget || typeof widget !== 'object') return widget;
  const { grow, frame, ...rest } = widget;
  const declared: SidebarWidgetDeclaration = frame === 'section' ? { ...rest, frame: 'section' } : rest;
  return grow === true ? { ...declared, grow: true } : declared;
}

// ============================================
// Plugin Loader
// ============================================

/** An unchanged failing outcome is logged again every this many ticks. */
const HEALTH_REPEAT_LOG_EVERY = 30;

export class PluginLoader {
  private configPath: string;
  private plugins: Map<string, LoadedPlugin> = new Map();
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private healthCheckIntervalMs: number;

  constructor(configPath?: string, healthCheckIntervalMs = 60000) {
    this.configPath = configPath || process.env.RELAYHALL_PLUGINS_CONFIG || './relayhall.plugins.json';
    this.healthCheckIntervalMs = healthCheckIntervalMs;
  }

  /**
   * Initialize: read config, load manifests, run initial health checks
   */
  async initialize(): Promise<void> {
    console.log('🔌 Plugin Loader: Initializing...');

    // Read plugins config
    const pluginsConfig = this.readPluginsConfig();
    if (!pluginsConfig || pluginsConfig.plugins.length === 0) {
      console.log('🔌 Plugin Loader: No plugins configured — running in core-only mode');
      return;
    }

    const enabledPlugins = pluginsConfig.plugins.filter(p => p.enabled);
    console.log(`🔌 Plugin Loader: Found ${pluginsConfig.plugins.length} plugins (${enabledPlugins.length} enabled)`);

    const names = enabledPlugins.map(p => p.name);
    if (new Set(names).size !== names.length) throw new Error('Duplicate plugin installation');

    // Card bedf50cc (slice 2 review): an installation whose own name cannot
    // compile to a public namespace (PLUGIN_NAME_INVALID, PLUGIN_NAMESPACE_EMPTY)
    // is refused on its own, with its reason code on its own log line below;
    // the other installations still load.
    const refused = new Map<string, unknown>();
    const namespaces: string[] = [];
    for (const pluginConfig of enabledPlugins) {
      try { namespaces.push(pluginPublicBasePath(pluginConfig.name)); }
      catch (err) { refused.set(pluginConfig.name, err); }
    }
    // Reject compiled collisions before registering any installation or probing health.
    if (new Set(namespaces).size !== namespaces.length) throw new Error('Duplicate plugin public namespace');
    // Card bedf50cc (E380, design section 9 and build note N16): two
    // installations whose assertion keys are the same, by variable name or by
    // key value, could mint each other's assertions; both are refused.
    for (const name of sharedAssertionKeyInstallations(enabledPlugins.filter(p => !refused.has(p.name)))) {
      refused.set(name, pluginAssertionKeyShared());
    }

    // Load each enabled plugin
    for (const pluginConfig of enabledPlugins) {
      try {
        if (refused.has(pluginConfig.name)) throw refused.get(pluginConfig.name);
        const manifest = this.loadManifest(pluginConfig);
        if (manifest) {
          validatePluginContract(manifest, pluginConfig);
          this.validateManifest(manifest);
          this.plugins.set(pluginConfig.name, {
            name: pluginConfig.name,
            config: pluginConfig,
            manifest,
            healthy: false,
            lastHealthCheck: null,
          });
          console.log(`  ✅ Loaded plugin: ${pluginConfig.name} v${manifest.version}`);
        }
      } catch (err) {
        // The reason is a fixed code from the contract's closed set (or the
        // unclassified code), never the refusal text or manifest data.
        const errorId = logCaughtFailure(`[PluginLoader] plugin load failed reason=${pluginLoadRefusalReason(err)}`, err);
        this.plugins.set(pluginConfig.name, {
          name: pluginConfig.name,
          config: pluginConfig,
          manifest: null as any,
          healthy: false,
          lastHealthCheck: null,
          error: `Plugin load failed (errorId ${errorId})`,
        });
      }
    }

    // Run initial health checks
    await this.checkAllHealth();

    // Start periodic health checks
    this.healthCheckInterval = setInterval(() => {
      this.checkAllHealth().catch(err => {
        logCaughtFailure('[PluginLoader] health check failed', err);
      });
    }, this.healthCheckIntervalMs);

    console.log(`🔌 Plugin Loader: ${this.plugins.size} plugins registered`);
  }

  /**
   * Read the plugins configuration file
   */
  private readPluginsConfig(): PluginsFileConfig | null {
    try {
      const resolvedPath = path.resolve(process.cwd(), this.configPath);
      
      if (!fs.existsSync(resolvedPath)) {
        console.log(`🔌 Plugin config not found at ${resolvedPath} — no plugins loaded`);
        return null;
      }

      const content = fs.readFileSync(resolvedPath, 'utf-8');
      const config = JSON.parse(content) as PluginsFileConfig;

      if (!config.plugins || !Array.isArray(config.plugins)) {
        console.warn('🔌 Invalid plugins config: missing "plugins" array');
        return null;
      }

      return config;
    } catch (err) {
      logCaughtFailure('[PluginLoader] configuration read failed', err);
      return null;
    }
  }

  /**
   * Load a plugin's manifest (plugin.json) from its source directory
   */
  private loadManifest(pluginConfig: PluginConfig): PluginManifest | null {
    const sourcePath = path.resolve(process.cwd(), pluginConfig.source);
    const manifestPath = path.join(sourcePath, 'plugin.json');

    if (!fs.existsSync(manifestPath)) {
      console.warn(`🔌 No plugin.json found at ${manifestPath} for ${pluginConfig.name}`);
      return null;
    }

    const content = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(content) as PluginManifest;

    // Apply config overrides
    if (pluginConfig.config_override) {
      this.applyOverrides(manifest, pluginConfig.config_override);
    }

    return manifest;
  }

  /**
   * Apply deployment-specific overrides to a manifest
   */
  private applyOverrides(manifest: PluginManifest, overrides: Record<string, any>): void {
    for (const [key, value] of Object.entries(overrides)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const target = (manifest as any)[key];
        if (typeof target === 'object' && target !== null) {
          Object.assign(target, value);
        } else {
          (manifest as any)[key] = value;
        }
      } else {
        (manifest as any)[key] = value;
      }
    }
  }

  /**
   * Validate a plugin manifest has all required fields
   */
  private validateManifest(manifest: PluginManifest): void {
    const required = ['name', 'version', 'description'];
    for (const field of required) {
      if (!(manifest as any)[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    if (!manifest.docker?.image) {
      throw new Error('Missing required field: docker.image');
    }

    if (!manifest.api?.health) {
      throw new Error('Missing required field: api.health');
    }

    // The proxy is mounted at '/', so an unconstrained base_path could shadow a
    // core route (e.g. '/tasks') for every request that reaches the app.
    const expectedBasePath = pluginPublicBasePath(manifest.name);
    if (manifest.api.base_path !== expectedBasePath) {
      throw new Error(
        `Invalid api.base_path '${manifest.api.base_path}': must be '${expectedBasePath}'`
      );
    }

    // Check for port conflicts
    const usedPorts = new Set<string>();
    for (const [, plugin] of this.plugins) {
      if (plugin.manifest?.docker?.ports) {
        for (const hostPort of Object.values(plugin.manifest.docker.ports)) {
          if (manifest.docker.ports && Object.values(manifest.docker.ports).includes(hostPort)) {
            if (usedPorts.has(hostPort)) {
              throw new Error(`Port conflict: ${hostPort} already used by another plugin`);
            }
          }
          usedPorts.add(hostPort);
        }
      }
    }
  }

  /**
   * Check health of all registered plugins
   */
  async checkAllHealth(): Promise<void> {
    const promises = Array.from(this.plugins.entries()).map(async ([_name, plugin]) => {
      if (!plugin.manifest) return;
      const outcome = await this.probeOne(plugin);
      plugin.healthy = outcome.healthy;
      plugin.lastHealthCheck = Date.now();
      this.recordHealthOutcome(plugin, outcome);
    });

    await Promise.allSettled(promises);
  }

  /**
   * Build the health URL from the manifest and probe it. Never throws: the
   * outcome is a closed value (see PluginHealthProbe).
   */
  private async probeOne(plugin: LoadedPlugin): Promise<PluginHealthOutcome> {
    const port = plugin.manifest.api.internal_port;
    const healthPath = plugin.manifest.api.health;

    // If plugin uses host network mode, use localhost
    const host = plugin.manifest.docker.network_mode === 'host'
      ? (process.env.DOCKER_HOST_ALIAS || 'host.docker.internal')
      : plugin.manifest.name;

    if (!isSafePluginPath(healthPath)) return { healthy: false, kind: 'config', detail: 'HEALTH_PATH_INVALID' };
    let url: URL;
    try {
      const origin = new URL('http://' + host + ':' + port);
      if (origin.username || origin.password || origin.pathname !== '/') return { healthy: false, kind: 'config', detail: 'HEALTH_ORIGIN_INVALID' };
      url = new URL(healthPath, origin);
      if (url.origin !== origin.origin) return { healthy: false, kind: 'config', detail: 'HEALTH_ORIGIN_INVALID' };
    } catch {
      return { healthy: false, kind: 'config', detail: 'HEALTH_ORIGIN_INVALID' };
    }
    return probePluginHealth({ url: url.toString() });
  }

  /**
   * Publish one probe outcome. A line is written when the outcome CHANGES and
   * then once per HEALTH_REPEAT_LOG_EVERY identical ticks, so a stopped
   * container is one named line a minute for a short while and not forever.
   * The line carries the installation name (validated to the closed name
   * pattern, else a fixed placeholder), the kind, the closed detail and the
   * HTTP status number; never a message, a body or a header.
   */
  private recordHealthOutcome(plugin: LoadedPlugin, outcome: PluginHealthOutcome): void {
    const previous = plugin.healthOutcome;
    const same = !!previous && previous.kind === outcome.kind && previous.detail === outcome.detail
      && previous.httpStatus === outcome.httpStatus;
    plugin.healthOutcome = outcome;
    plugin.healthRepeats = same ? (plugin.healthRepeats ?? 0) + 1 : 0;
    const label = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(plugin.name) ? plugin.name : 'unnamed';
    const describe = `plugin=${label} kind=${outcome.kind} detail=${outcome.detail}`
      + (outcome.httpStatus !== undefined ? ` http=${outcome.httpStatus}` : '');
    const due = !same || (plugin.healthRepeats! % HEALTH_REPEAT_LOG_EVERY === 0);

    if (outcome.healthy && outcome.kind === 'ok') {
      plugin.error = undefined;
      if (previous && !(previous.healthy && previous.kind === 'ok')) console.log(`[PluginLoader] plugin health restored plugin=${label}`);
      return;
    }
    const errorId = randomUUID();
    if (outcome.healthy) {
      // 'shape': answered 2xx with an undocumented body. Named, but still healthy.
      plugin.error = `Health answer shape not recognised: ${outcome.detail}`;
      if (due) console.warn(`[PluginLoader] plugin health answer not recognised ${describe} id=${errorId}`);
      return;
    }
    plugin.error = outcome.httpStatus !== undefined && outcome.kind === 'plugin_reported' && outcome.detail === 'HTTP_STATUS_NOT_OK'
      ? `Health check returned ${outcome.httpStatus}`
      : `Health check failed: ${outcome.kind}/${outcome.detail} (errorId ${errorId})`;
    if (due) console.error(`[PluginLoader] plugin health check failed ${describe} id=${errorId}`);
  }

  /**
   * Get the plugin registry for the API response
   */
  getRegistry(): PluginRegistryEntry[] {
    const entries: PluginRegistryEntry[] = [];

    for (const [, plugin] of this.plugins) {
      if (!plugin.manifest) continue;

      entries.push({
        schema_version: plugin.manifest.schema_version,
        capabilities: plugin.manifest.relayhall?.capabilities,
        sidebar_widget: plugin.manifest.ui?.enabled ? registrySidebarWidget(plugin.manifest.ui.sidebar_widget) : undefined,
        settings: plugin.manifest.schema_version === 'rh.plugin/1' && plugin.manifest.ui?.enabled ? plugin.manifest.ui.settings : undefined,
        name: plugin.manifest.name,
        blueprintReferences: (plugin.manifest.blueprintReferences || []).filter(reference =>
          typeof reference?.kind === 'string' && /^[a-z0-9][a-z0-9_-]{1,63}$/.test(reference.kind)
          && typeof reference.name === 'string' && reference.name.length > 0 && reference.name.length <= 200
          && typeof reference.service === 'string' && reference.service.length > 0
          && typeof reference.tool === 'string' && reference.tool.length > 0),
        version: plugin.manifest.version,
        description: plugin.manifest.description,
        healthy: plugin.healthy,
        sidebar: plugin.manifest.ui?.enabled && plugin.manifest.ui?.sidebar 
          ? plugin.manifest.ui.sidebar 
          : [],
        routes: plugin.manifest.ui?.enabled && plugin.manifest.ui?.routes
          ? plugin.manifest.ui.routes
          : [],
        api_base: pluginPublicBasePath(plugin.manifest.name),
        internal_port: plugin.manifest.api.internal_port,
        category: plugin.manifest.relayhall?.category,
      });
    }

    return entries;
  }

  /**
   * Get proxy routes for all plugins (used by middleware)
   */
  getProxyRoutes(): PluginProxyRoute[] {
    const routes: PluginProxyRoute[] = [];

    for (const [, plugin] of this.plugins) {
      if (!plugin.manifest) continue;
      // Always expose proxy routes even for unhealthy plugins
      // so that health checks through the proxy can succeed (avoids chicken-and-egg)

      const port = plugin.manifest.api.internal_port;
      const host = plugin.manifest.docker.network_mode === 'host'
        ? (process.env.DOCKER_HOST_ALIAS || 'host.docker.internal')
        : plugin.manifest.name;
      const allow = compileAllowRules(plugin.manifest);

      // API routes
      routes.push({
        pathPrefix: pluginPublicBasePath(plugin.manifest.name),
        target: `http://${host}:${port}`,
        pluginName: plugin.manifest.name,
        allow,
      });

      // UI routes (if plugin has UI)
      if (plugin.manifest.ui?.enabled && plugin.manifest.ui?.routes) {
        for (const route of plugin.manifest.ui.routes) {
          routes.push({
            pathPrefix: pluginPublicBasePath(plugin.manifest.name) + route.path.replace(/\/+$/, ''),
            target: `http://${host}:${port}${route.proxy_to}`,
            pluginName: plugin.manifest.name,
            allow,
          });
        }
      }
    }

    return routes;
  }

  /**
   * Get a specific plugin by name
   */
  getPlugin(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Get all loaded plugins
   */
  getAllPlugins(): LoadedPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Plugin-facing theme stylesheet (RH-DESIGN.6 §4.4). Generated from the
   * semantic token tables in services/pluginTheme.ts under --rh-* names.
   */
  getThemeCSS(options: ThemeCssOptions = {}): string {
    return generateThemeCss(options);
  }

  /**
   * Stop the plugin loader (cleanup)
   */
  stop(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    console.log('🔌 Plugin Loader: Stopped');
  }
}
