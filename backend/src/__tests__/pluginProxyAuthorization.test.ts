import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

import {
  buildUpstreamHeaders,
  filterResponseHeaders,
  findPluginProxyRoute,
  isPluginProxyRequestAllowed,
  isBrowserAccessAuthorized,
  isHostOverridingPath,
  resolvesToPluginOrigin,
  hasTraversal,
  BROWSER_ACCESS_COOKIE,
  BROWSER_ACCESS_SCOPE,
} from '../middleware/pluginProxy';
import { PluginProxyRoute, DEFAULT_PLUGIN_PROXY_ALLOW } from '../services/PluginLoader';

const SECRET = process.env.JWT_SECRET as string;

const orb: PluginProxyRoute = {
  pathPrefix: '/plugins/nim-orb',
  target: 'http://nim-orb:3030',
  pluginName: 'nim-orb',
  allow: DEFAULT_PLUGIN_PROXY_ALLOW,
};

const gpu: PluginProxyRoute = {
  pathPrefix: '/plugins/gpu-gateway',
  target: 'http://host.docker.internal:8302',
  pluginName: 'gpu-gateway',
  allow: [
    { methods: ['GET', 'HEAD'], path: '/health', match: 'exact' },
    { methods: ['GET'], path: '/v1/queue', match: 'prefix' },
    { methods: ['POST'], path: '/v1/scaling/up', match: 'exact' },
  ],
};

const routes = [orb, gpu];

const asRequest = (headers: Record<string, string>) => ({ headers }) as never;

describe('plugin proxy route matching', () => {
  it('matches the prefix itself and any child path', () => {
    expect(findPluginProxyRoute(routes, '/plugins/nim-orb')).toBe(orb);
    expect(findPluginProxyRoute(routes, '/plugins/nim-orb/avatar')).toBe(orb);
    expect(findPluginProxyRoute(routes, '/plugins/gpu-gateway/health')).toBe(gpu);
  });

  it('does not match a sibling prefix that merely starts the same', () => {
    // The old naked startsWith() proxied /plugins/nim-orbEVIL/x to nim-orb.
    expect(findPluginProxyRoute(routes, '/plugins/nim-orbEVIL/x')).toBeUndefined();
    expect(findPluginProxyRoute(routes, '/plugins/nim-orb-other')).toBeUndefined();
  });

  it('leaves non-plugin paths alone', () => {
    expect(findPluginProxyRoute(routes, '/tasks')).toBeUndefined();
    expect(findPluginProxyRoute(routes, '/plugins')).toBeUndefined();
  });
});

describe('plugin proxy traversal rejection', () => {
  it.each([
    '/plugins/nim-orb/../../health',
    '/plugins/nim-orb/%2e%2e/%2e%2e/health',
    '/plugins/nim-orb/assets/../../secret',
  ])('rejects %s', path => {
    expect(hasTraversal(path)).toBe(true);
  });

  it.each([
    '/plugins/nim-orb/avatar',
    '/plugins/nim-orb/assets/index-abc123.js',
    '/plugins/nim-orb/file..name.js',
  ])('permits %s', path => {
    expect(hasTraversal(path)).toBe(false);
  });
});

describe('plugin proxy method and path allowlist', () => {
  it('defaults to read-only for a plugin that declares no allowlist', () => {
    expect(isPluginProxyRequestAllowed(orb, 'GET', '/avatar')).toBe(true);
    expect(isPluginProxyRequestAllowed(orb, 'HEAD', '/')).toBe(true);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(isPluginProxyRequestAllowed(orb, method, '/avatar')).toBe(false);
    }
  });

  it('honours exact and prefix rules', () => {
    expect(isPluginProxyRequestAllowed(gpu, 'GET', '/health')).toBe(true);
    expect(isPluginProxyRequestAllowed(gpu, 'GET', '/health/deep')).toBe(false);
    expect(isPluginProxyRequestAllowed(gpu, 'GET', '/v1/queue')).toBe(true);
    expect(isPluginProxyRequestAllowed(gpu, 'GET', '/v1/queue/status')).toBe(true);
    expect(isPluginProxyRequestAllowed(gpu, 'GET', '/v1/queueEVIL')).toBe(false);
  });

  it('permits a declared write and denies every undeclared one', () => {
    expect(isPluginProxyRequestAllowed(gpu, 'POST', '/v1/scaling/up')).toBe(true);
    expect(isPluginProxyRequestAllowed(gpu, 'POST', '/v1/scaling/down')).toBe(false);
    expect(isPluginProxyRequestAllowed(gpu, 'POST', '/v1/audio/speech')).toBe(false);
    expect(isPluginProxyRequestAllowed(gpu, 'DELETE', '/v1/voices')).toBe(false);
  });

  it('is case-insensitive on the method', () => {
    expect(isPluginProxyRequestAllowed(orb, 'get', '/avatar')).toBe(true);
  });
});

describe('plugin proxy authorization', () => {
  it('rejects an anonymous request', async () => {
    expect(await isBrowserAccessAuthorized(asRequest({}))).toBe(false);
  });

  it('accepts a valid dashboard bearer token', async () => {
    const token = jwt.sign({ userId: 'dashboard_user' }, SECRET, { expiresIn: '1h' });
    expect(await isBrowserAccessAuthorized(asRequest({ authorization: `Bearer ${token}` }))).toBe(true);
  });

  it('accepts the scoped capability cookie', async () => {
    const token = jwt.sign({ scope: BROWSER_ACCESS_SCOPE }, SECRET, { expiresIn: '1h' });
    expect(
      await isBrowserAccessAuthorized(asRequest({ cookie: `${BROWSER_ACCESS_COOKIE}=${token}` }))
    ).toBe(true);
  });

  it('rejects a cookie signed with the wrong secret', async () => {
    const token = jwt.sign({ scope: BROWSER_ACCESS_SCOPE }, 'not-the-secret', { expiresIn: '1h' });
    expect(
      await isBrowserAccessAuthorized(asRequest({ cookie: `${BROWSER_ACCESS_COOKIE}=${token}` }))
    ).toBe(false);
  });

  it('rejects an expired capability cookie', async () => {
    const token = jwt.sign({ scope: BROWSER_ACCESS_SCOPE }, SECRET, { expiresIn: '-1s' });
    expect(
      await isBrowserAccessAuthorized(asRequest({ cookie: `${BROWSER_ACCESS_COOKIE}=${token}` }))
    ).toBe(false);
  });

  it('rejects a token that is valid but carries a different scope', async () => {
    const token = jwt.sign({ scope: 'some-other-capability' }, SECRET, { expiresIn: '1h' });
    expect(
      await isBrowserAccessAuthorized(asRequest({ cookie: `${BROWSER_ACCESS_COOKIE}=${token}` }))
    ).toBe(false);
  });

  it('does not accept an identity JWT as plugin authority, even in the capability cookie', async () => {
    // Adapted from the retired Content Engine media cookie (P1.3 ruling A5):
    // the pinned property is unchanged — an identity token and a capability
    // token are not fungible, in either direction, on this proxy.
    const token = jwt.sign({ userId: 'dashboard_user' }, SECRET, { expiresIn: '1h' });
    expect(
      await isBrowserAccessAuthorized(asRequest({ cookie: `${BROWSER_ACCESS_COOKIE}=${token}` }))
    ).toBe(false);
  });

  it('falls back to the cookie when the bearer token is invalid', async () => {
    const good = jwt.sign({ scope: BROWSER_ACCESS_SCOPE }, SECRET, { expiresIn: '1h' });
    expect(
      await isBrowserAccessAuthorized(
        asRequest({ authorization: 'Bearer garbage', cookie: `${BROWSER_ACCESS_COOKIE}=${good}` })
      )
    ).toBe(true);
  });
});

describe('plugin proxy header hygiene', () => {
  const synthesised = {
    host: 'nim-orb:3030',
    pluginName: 'nim-orb',
    forwardedFor: '10.0.0.9',
    forwardedProto: 'https',
  };

  it('relays no RelayHall credential upstream', () => {
    const out = buildUpstreamHeaders(
      {
        accept: 'text/html',
        cookie: 'nim_auth_token_prod=secret; nim_plugin_access=cap',
        authorization: 'Bearer dashboard-jwt',
        'x-api-key': 'global-service-key',
        'x-reports-read-key': 'reports-key',
        // Arbitrary credential-shaped header (the journal publish key that
        // used to sit here left with the Journal plugin) — the allowlist must
        // drop every x-*-key regardless of whether core knows the name.
        'x-plugin-publish-key': 'plugin-key',
      },
      synthesised
    );
    for (const banned of [
      'cookie',
      'authorization',
      'x-api-key',
      'x-reports-read-key',
      'x-plugin-publish-key',
    ]) {
      expect(out).not.toHaveProperty(banned);
    }
    expect(out.accept).toBe('text/html');
  });

  it('passes through the headers plugins legitimately need', () => {
    const out = buildUpstreamHeaders(
      {
        accept: '*/*',
        'accept-encoding': 'gzip',
        'content-type': 'application/json',
        range: 'bytes=0-99',
        'last-event-id': '42',
        'if-none-match': 'W/"abc"',
      },
      synthesised
    );
    expect(out).toMatchObject({
      accept: '*/*',
      'accept-encoding': 'gzip',
      'content-type': 'application/json',
      range: 'bytes=0-99',
      'last-event-id': '42',
      'if-none-match': 'W/"abc"',
    });
  });

  it('synthesises identity headers that a client cannot spoof', () => {
    const out = buildUpstreamHeaders(
      {
        host: 'evil.example',
        'x-plugin-name': 'gpu-gateway',
        'x-forwarded-for': '1.2.3.4',
        'x-forwarded-proto': 'http',
      },
      synthesised
    );
    // gpu-gateway auto-authenticates on x-plugin-name, so spoofing it must fail.
    expect(out['x-plugin-name']).toBe('nim-orb');
    expect(out.host).toBe('nim-orb:3030');
    expect(out['x-forwarded-for']).toBe('10.0.0.9');
    expect(out['x-forwarded-proto']).toBe('https');
  });

  it('drops array-valued (repeated) headers rather than coercing them', () => {
    const out = buildUpstreamHeaders({ accept: ['a', 'b'] }, synthesised);
    expect(out).not.toHaveProperty('accept');
  });

  it('never relays set-cookie back onto the RelayHall origin', () => {
    const out = filterResponseHeaders({
      'content-type': 'text/html',
      'set-cookie': ['session=attacker'],
      'cache-control': 'no-cache',
      'access-control-allow-origin': '*',
    });
    expect(out).not.toHaveProperty('set-cookie');
    expect(out).not.toHaveProperty('access-control-allow-origin');
    expect(out).toMatchObject({ 'content-type': 'text/html', 'cache-control': 'no-cache' });
  });
});

describe('plugin proxy upstream origin pinning (SSRF)', () => {
  it('rejects a protocol-relative sub-path that would replace the upstream host', () => {
    // new URL('//host:port/x', base) REPLACES the base host, and the proxy
    // would still stamp the plugin's x-plugin-name on the pivoted request.
    expect(isHostOverridingPath('//localhost:3006/health')).toBe(true);
    expect(isHostOverridingPath('//192.0.2.150:8302/v1/voices')).toBe(true);
  });

  it('rejects the backslash form, which WHATWG folds to //', () => {
    expect(isHostOverridingPath('/\\localhost:3006/health')).toBe(true);
    expect(isHostOverridingPath('\\\\localhost:3006/health')).toBe(true);
  });

  it('permits ordinary sub-paths', () => {
    for (const p of ['/', '/avatar', '/assets/index-abc.js', '/v1/queue/status']) {
      expect(isHostOverridingPath(p)).toBe(false);
    }
  });

  it('pins the resolved upstream to the plugin origin', () => {
    expect(resolvesToPluginOrigin('http://nim-orb:3030', new URL('http://nim-orb:3030/avatar'))).toBe(true);
    expect(resolvesToPluginOrigin('http://nim-orb:3030', new URL('http://localhost:3006/health'))).toBe(false);
    expect(resolvesToPluginOrigin('http://nim-orb:3030', new URL('http://nim-orb:9999/x'))).toBe(false);
    expect(resolvesToPluginOrigin('http://nim-orb:3030', new URL('http://evil.example/x'))).toBe(false);
  });

  it('demonstrates the underlying URL behaviour the guard exists for', () => {
    // Without the guard this is what the proxy would have resolved.
    expect(new URL('//localhost:3006/health', 'http://nim-orb:3030').origin).toBe('http://localhost:3006');
  });
});

describe('the origin check is load-bearing, not redundant', () => {
  // WHATWG strips tab/CR/LF *after* a startsWith('//') check has already said
  // "not host-overriding", so these reach layer 2 as the only guard. If someone
  // deletes resolvesToPluginOrigin as redundant, this test goes red.
  it.each(['/\t/evil.com/x', '/\n/evil.com/x', '/\r/evil.com/x'])(
    'layer 1 misses %j but layer 2 catches it',
    raw => {
      expect(isHostOverridingPath(raw)).toBe(false);
      const resolved = new URL(raw, 'http://nim-orb:3030');
      expect(resolved.origin).toBe('http://evil.com');
      expect(resolvesToPluginOrigin('http://nim-orb:3030', resolved)).toBe(false);
    }
  );
});
