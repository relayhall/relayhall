/**
 * Plugin Proxy Middleware
 *
 * Routes requests to /api/plugins/{name}/* and /plugins/{name}/*
 * to the appropriate plugin container.
 *
 * Plugin containers are a SEPARATE TRUST DOMAIN. Three rules follow:
 *
 * 1. Callers must be authenticated. Iframes cannot send an Authorization
 *    header, so a scoped capability cookie is accepted alongside Bearer JWTs.
 *    That cookie authorises nothing except this proxy.
 * 2. Only allowlisted methods and paths are forwarded (GET/HEAD by default).
 * 3. No RelayHall credential is ever relayed upstream, and no plugin response
 *    header that could act on the RelayHall origin is relayed back.
 */
import { Request, Response, NextFunction } from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import { PluginLoader, PluginProxyRoute } from '../services/PluginLoader';
import { getJwtSecret } from '../config/secrets';
import { lookupPrincipalBounded, verifyActiveDashboardToken } from '../utils/dashboardToken';

/** Upstream socket budget. Without this a stalled plugin pins a socket forever. */
const PROXY_TIMEOUT_MS = 30_000;

export const BROWSER_ACCESS_COOKIE = 'nim_browser_access';
export const BROWSER_ACCESS_SCOPE = 'browser-access';

/**
 * Request headers forwarded upstream. Everything absent from this list is
 * dropped — notably cookie, authorization, x-api-key and every x-*-key.
 */
const FORWARDED_REQUEST_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'content-type',
  'if-modified-since',
  'if-none-match',
  'last-event-id',
  'range',
  'user-agent',
]);

/**
 * Response headers relayed back. set-cookie is deliberately absent: a plugin
 * must not be able to plant a cookie on the RelayHall origin.
 */
const FORWARDED_RESPONSE_HEADERS = new Set([
  'accept-ranges',
  'cache-control',
  'content-encoding',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'expires',
  'last-modified',
]);

/**
 * Build the upstream header set: allowlisted client headers plus the four
 * synthesised ones. No RelayHall credential can survive this — cookie,
 * authorization, x-api-key and every x-*-key are absent from the allowlist.
 */
export function buildUpstreamHeaders(
  headers: Record<string, string | string[] | undefined>,
  synthesised: { host: string; pluginName: string; forwardedFor: string; forwardedProto: string }
): Record<string, string> {
  const upstream: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!FORWARDED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    if (typeof value === 'string') upstream[name.toLowerCase()] = value;
  }
  // Synthesised last so a client cannot spoof them.
  upstream.host = synthesised.host;
  upstream['x-plugin-name'] = synthesised.pluginName;
  upstream['x-forwarded-for'] = synthesised.forwardedFor;
  upstream['x-forwarded-proto'] = synthesised.forwardedProto;
  return upstream;
}

/** Relay only inert response headers; set-cookie must never reach the RelayHall origin. */
export function filterResponseHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (FORWARDED_RESPONSE_HEADERS.has(name.toLowerCase()) && value !== undefined) {
      out[name.toLowerCase()] = value;
    }
  }
  return out;
}

function readCookie(header: string | undefined, name: string): string {
  for (const part of (header || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}

/**
 * A caller is authorised when it presents a valid dashboard JWT, or the scoped
 * browser capability cookie. It carries no userId and grants nothing beyond the
 * browser subresource routes that accept it.
 */
export async function isBrowserAccessAuthorized(req: Request): Promise<boolean> {
  const secret = getJwtSecret();

  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    try {
      // Identity only. A capability is not interchangeable with another
      // capability: an unrelated scoped token must not open the proxy.
      await verifyActiveDashboardToken(authHeader.slice(7));
      return true;
    } catch (err) {
      // A token rejected because the identity is DISABLED must not then be
      // rescued by the cookie sitting in the same request.
      if (err instanceof Error && err.message === 'identity is disabled') return false;
      // fall through to the cookie
    }
  }

  const cookieToken = readCookie(req.headers.cookie, BROWSER_ACCESS_COOKIE);
  if (!cookieToken) return false;
  try {
    const decoded = jwt.verify(cookieToken, secret) as { scope?: string; sub?: string };
    if (decoded?.scope !== BROWSER_ACCESS_SCOPE) return false;
    // A cookie without a sub cannot be checked, so it stays valid until it
    // expires (12h). That is now a narrow case: the mint resolves legacy
    // {userId} identities too, so a sub is absent only when the principal
    // could not be resolved at all, or the cookie predates the change.
    if (!decoded.sub) return true;
    // Bounded, like every other principal lookup on a request path: an
    // unbounded await here re-created the never-answering-DB hang on exactly
    // the subresource paths (<img>, iframes, forward-auth) that used to be
    // pure signature checks.
    const principal = await lookupPrincipalBounded({ principalId: decoded.sub });
    // Unresolvable (or a DB blip) allows, matching every other identity path:
    // an outage must not lock anyone out.
    return !principal || principal.status === 'active';
  } catch {
    return false;
  }
}

/** Prefix match on a path-segment boundary: '/plugins/orb' must not match '/plugins/orbEVIL'. */
export function findPluginProxyRoute(
  routes: PluginProxyRoute[],
  path: string
): PluginProxyRoute | undefined {
  return routes.find(
    route => path === route.pathPrefix || path.startsWith(`${route.pathPrefix}/`)
  );
}

/** Whether a method+sub-path pair is permitted by the route's compiled allowlist. */
export function isPluginProxyRequestAllowed(
  route: PluginProxyRoute,
  method: string,
  targetPath: string
): boolean {
  const upperMethod = method.toUpperCase();
  return route.allow.some(rule => {
    if (!rule.methods.includes(upperMethod)) return false;
    if (rule.match === 'exact') return targetPath === rule.path;
    if (rule.path === '/') return true;
    return targetPath === rule.path || targetPath.startsWith(`${rule.path}/`);
  });
}

/**
 * A sub-path beginning '//' (or '/\\', which WHATWG folds to '//') is
 * protocol-relative: `new URL('//host:port/x', base)` REPLACES the base host.
 * Without this the proxy resolves an attacker-chosen upstream and still stamps
 * the plugin's x-plugin-name on it — an SSRF pivot out of the plugin network.
 */
export function isHostOverridingPath(targetPath: string): boolean {
  const normalised = targetPath.replace(/\\/g, '/');
  return normalised.startsWith('//');
}

/** The resolved upstream must be the plugin's own origin, never anything else. */
export function resolvesToPluginOrigin(target: string, resolved: URL): boolean {
  try {
    return resolved.origin === new URL(target).origin;
  } catch {
    return false;
  }
}

/** Reject traversal before any URL resolution, in raw and percent-encoded form. */
export function hasTraversal(rawPath: string): boolean {
  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    // Malformed encoding: fall back to the raw form rather than accepting it.
  }
  return decoded.split('/').includes('..');
}

export function createPluginProxy(pluginLoader: PluginLoader) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const routes = pluginLoader.getProxyRoutes();
    const route = findPluginProxyRoute(routes, req.path);

    // No matching plugin route — continue to next middleware
    if (!route) {
      next();
      return;
    }

    if (!(await isBrowserAccessAuthorized(req))) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Plugin access requires an authenticated session',
      });
      return;
    }

    if (hasTraversal(req.path)) {
      res.status(404).json({ error: 'Not Found' });
      return;
    }

    const targetPath = req.path.slice(route.pathPrefix.length) || '/';

    // 404 rather than 405: do not disclose which methods a plugin implements.
    if (!isPluginProxyRequestAllowed(route, req.method, targetPath)) {
      res.status(404).json({ error: 'Not Found' });
      return;
    }

    if (isHostOverridingPath(targetPath)) {
      res.status(404).json({ error: 'Not Found' });
      return;
    }

    const targetUrl = new URL(targetPath, route.target);
    // Belt and braces: whatever the path did, the upstream must still be the plugin.
    if (!resolvesToPluginOrigin(route.target, targetUrl)) {
      res.status(404).json({ error: 'Not Found' });
      return;
    }
    targetUrl.search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

    const upstreamHeaders = buildUpstreamHeaders(req.headers, {
      host: `${targetUrl.hostname}:${targetUrl.port}`,
      pluginName: route.pluginName,
      forwardedFor: req.ip || req.socket.remoteAddress || '',
      forwardedProto: req.protocol,
    });

    const proxyReq = http.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers: upstreamHeaders,
        timeout: PROXY_TIMEOUT_MS,
      },
      (proxyRes) => {
        // Clear helmet/cors middleware headers that were set via res.setHeader()
        // before writeHead() merges them — plugins manage their own security headers
        const helmetHeaders = [
          'content-security-policy',
          'cross-origin-opener-policy',
          'cross-origin-resource-policy',
          'origin-agent-cluster',
          'referrer-policy',
          'strict-transport-security',
          'x-content-type-options',
          'x-dns-prefetch-control',
          'x-download-options',
          'x-frame-options',
          'x-permitted-cross-domain-policies',
          'x-powered-by',
          'x-xss-protection',
          'access-control-allow-origin',
          'access-control-allow-credentials',
          'vary',
        ];
        for (const h of helmetHeaders) {
          res.removeHeader(h);
        }

        res.writeHead(proxyRes.statusCode || 502, filterResponseHeaders(proxyRes.headers));
        proxyRes.pipe(res);
      }
    );

    const failUpstream = (label: string, detail: string) => {
      console.error(`🔌 Proxy ${label} for ${route.pluginName}: ${detail}`);
      if (res.headersSent) {
        res.end();
        return;
      }
      // Generic body: the upstream error string can disclose internal topology.
      res.status(502).json({ error: 'Plugin unavailable', plugin: route.pluginName });
    };

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      failUpstream('timeout', `no response within ${PROXY_TIMEOUT_MS}ms`);
    });
    proxyReq.on('error', (err) => failUpstream('error', err.message));

    // Abandon the upstream socket when the client goes away.
    res.on('close', () => proxyReq.destroy());

    // Pipe request body
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
  };
}
