/**
 * Plugin API routes
 * 
 * GET /api/plugins — list all enabled plugins with sidebar items and health status
 * GET /api/plugins/theme.css — shared CSS variables for plugin theming
 */
import { Router, Request, Response } from 'express';
import { generateThemeCss } from '../services/pluginTheme';
import { PluginLoader } from '../services/PluginLoader';

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
router.get('/', (_req: Request, res: Response) => {
  if (!pluginLoader) {
    res.json({ plugins: [] });
    return;
  }

  const registry = pluginLoader.getRegistry();
  res.json({ plugins: registry });
});


/**
 * GET /plugins/:name — get details for a specific plugin
 */
router.get('/:name', (req: Request, res: Response) => {
  if (!pluginLoader) {
    res.status(404).json({ error: 'Plugin system not initialized' });
    return;
  }

  const plugin = pluginLoader.getPlugin(req.params.name);
  if (!plugin) {
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
