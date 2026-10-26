/**
 * Plugin API routes
 * 
 * GET /api/plugins — list all enabled plugins with sidebar items and health status
 * GET /api/plugins/theme.css — shared CSS variables for plugin theming
 */
import { Router, Request, Response } from 'express';
import { generateThemeCss } from '../services/pluginTheme';
import { PluginLoader } from '../services/PluginLoader';
import type { AuthRequest } from '../middleware/auth';
import { activePluginAccount } from '../services/PluginAccountScope';
import { isPluginV1, pluginAccountCan, pluginCanWriteThroughProxy, pluginSettingReadOnly } from '../services/PluginHostContract';
import { pluginAvailableTo, pluginSettingsService } from '../services/PluginSettingsService';

const router = Router();

/** Public sub-router: only the theme stylesheet, mounted before auth. */
export const publicPluginThemeRoutes = Router();

/**
 * GET /plugins/theme.css — the plugin theme contract (RH-DESIGN.6 §4.4).
 *
 * PUBLIC by design: plugin iframes cannot send a JWT (same reason the plugin
 * proxy is public), so an authenticated stylesheet could never load — the
 * route 401'd for every real caller before this contract. It carries only
 * canonical semantic token values, no deployment or principal data.
 *
 * `?theme=` accepts a built-in Theme name; anything else resolves to the
 * deployment default through the closed enum in services/pluginTheme.ts.
 */
publicPluginThemeRoutes.get('/theme.css', (req: Request, res: Response) => {
  const theme = typeof req.query.theme === 'string' ? req.query.theme : undefined;
  res
    .type('text/css')
    .set('Cache-Control', 'no-cache')
    .send(pluginLoader ? pluginLoader.getThemeCSS({ theme }) : generateThemeCss({ theme }));
});
let pluginLoader: PluginLoader | null = null;

export function getPluginRegistry() { return pluginLoader?.getRegistry() ?? []; }

export function setPluginLoader(loader: PluginLoader) {
  pluginLoader = loader;
}

/**
 * GET /plugins — list all registered plugins
 */
router.get('/', async (req: Request, res: Response) => {
  if (!pluginLoader) {
    res.json({ plugins: [] });
    return;
  }

  const listed = pluginLoader.getRegistry();
  let account: string | null = null;
  if (listed.some(entry => isPluginV1(pluginLoader!.getPlugin(entry.name)?.manifest))) {
    try { account = await activePluginAccount(req as AuthRequest); }
    catch { res.status(503).json({ code: 'PLUGIN_UNAVAILABLE' }); return; }
  }
  // Card bedf50cc (E380): availability is ANDed with the file's view grant
  // for v1 entries, never substituted for it; legacy entries are outside
  // policy and listed as before (C10). One statement reads every state.
  let availability: Awaited<ReturnType<typeof pluginSettingsService.availabilityFor>>;
  try {
    availability = await pluginSettingsService.availabilityFor(listed.filter(entry =>
      isPluginV1(pluginLoader!.getPlugin(entry.name)?.manifest)).map(entry => entry.name), account);
  } catch { res.status(503).json({ code: 'PLUGIN_UNAVAILABLE' }); return; }
  const registry = listed.filter(entry => {
    const plugin = pluginLoader!.getPlugin(entry.name);
    return !plugin || !isPluginV1(plugin.manifest) || (pluginAccountCan(plugin.config, account)
      && availability.get(entry.name)?.enabled === true);
  });
  // Only disclose settings destinations granted to the active Account. The
  // proxy independently rechecks the same capability on every request. The
  // deployment view default reaches `view` entries only; every other entry
  // needs the explicit per-Account capability (pluginAccountCan).
  const scopes = (req as AuthRequest).scopes ?? [];
  const proxyRoutes = pluginLoader.getProxyRoutes();
  res.json({ plugins: registry.map(entry => {
    const plugin = pluginLoader!.getPlugin(entry.name);
    // Registry and manifest values are never trusted to assert caller access.
    const { hostProxyAccess: _ignored, ...visible } = entry;
    const v1 = plugin && isPluginV1(plugin.manifest);
    const baseRoute = v1 && proxyRoutes.find(route =>
      route.pluginName === entry.name && route.pathPrefix === entry.api_base);
    // Each visible settings entry says whether THIS caller can change it,
    // computed from the compiled base route's rules for the entry's own path
    // (a manifest-supplied readOnly is replaced). No base route: read-only.
    return { ...visible, settings: v1
      ? (entry.settings ?? []).filter(setting => pluginAccountCan(plugin.config, account, setting.capability))
        .map(setting => ({ ...setting,
          readOnly: pluginSettingReadOnly(plugin.config, account, scopes, baseRoute ? baseRoute.allow : [], setting.path) }))
      : [], ...(baseRoute && account ? { hostProxyAccess: {
        writeCapable: pluginCanWriteThroughProxy(plugin.config, account, scopes, baseRoute.allow),
      } } : {}) };
  }) });
});


/**
 * GET /plugins/:name — get details for a specific plugin
 */
router.get('/:name', async (req: Request, res: Response) => {
  if (!pluginLoader) {
    res.status(404).json({ error: 'Plugin system not initialized' });
    return;
  }

  const plugin = pluginLoader.getPlugin(req.params.name);
  // Card bedf50cc (E380): the active Account (activePluginAccount, as every
  // other plugin site), and availability ANDed with the view grant for a v1
  // plugin. A hidden plugin answers this route's existing 404.
  let visible = !!plugin;
  if (plugin && isPluginV1(plugin.manifest)) {
    try {
      const account = await activePluginAccount(req as AuthRequest);
      visible = pluginAccountCan(plugin.config, account) && await pluginAvailableTo(plugin, account);
    } catch { res.status(503).json({ code: 'PLUGIN_UNAVAILABLE' }); return; }
  }
  if (!plugin || !visible) {
    res.status(404).json({ error: `Plugin not found: ${req.params.name}` });
    return;
  }

  res.json({
    name: plugin.name,
    version: plugin.manifest?.version,
    description: plugin.manifest?.description,
    healthy: plugin.healthy,
    lastHealthCheck: plugin.lastHealthCheck,
    error: plugin.error,
    sidebar: plugin.manifest?.ui?.sidebar || [],
    endpoints: plugin.manifest?.api?.endpoints || [],
    category: plugin.manifest?.relayhall?.category,
  });
});

export default router;
