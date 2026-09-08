/**
 * The plugin theme stylesheet must be reachable WITHOUT authentication
 * (RH-DESIGN.6 §4.4 / review S-F13).
 *
 * Plugin iframes cannot attach an authorization header — the plugin proxy is
 * public for exactly that reason — so an authenticated stylesheet is
 * unreachable by its only caller. Before this contract the route sat behind
 * authMiddleware and 401'd for every real request. This test pins the mount
 * order: the public sub-router must answer before the authenticated one.
 */
import express from 'express';
import http from 'http';
import pluginsRoutes, { publicPluginThemeRoutes } from '../routes/plugins';

const denyAll: express.RequestHandler = (_req, res) => {
  res.status(401).json({ error: 'unauthenticated' });
};

function withServer(fn: (base: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const app = express();
    // Mount exactly as server.ts does: public theme first, then auth + registry.
    app.use('/plugins', publicPluginThemeRoutes);
    app.use('/plugins', denyAll, pluginsRoutes);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as { port: number };
    try {
      await fn(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

describe('GET /plugins/theme.css', () => {
  it('serves the stylesheet with no credentials', withServer(async (base) => {
    const res = await fetch(`${base}/plugins/theme.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
    const body = await res.text();
    expect(body).toContain('--rh-bg-surface:');
    expect(body).not.toMatch(/--cb-/);
  }));

  it('honours ?theme= through the closed enum and never echoes it', withServer(async (base) => {
    const res = await fetch(`${base}/plugins/theme.css?theme=%3C%2Fstyle%3E%3Cscript%3E`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('script');
    expect(body).toContain('Theme: relay-dark');
  }));

  it('still requires authentication for the plugin registry itself', withServer(async (base) => {
    const res = await fetch(`${base}/plugins/`);
    expect(res.status).toBe(401);
  }));
});
