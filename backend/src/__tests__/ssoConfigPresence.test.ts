/**
 * SS-W2 · the `/config` SSO presence block (design `d95136d7` §3.2).
 *
 * The block exists so a login page can render the right button. It must carry
 * PRESENCE ONLY — "whether SSO is enabled, the display name to show, and
 * whether local password login is available. It carries NO issuer URL, no
 * client id, no endpoint."
 *
 * The interesting assertion is the negative one, and it is written so it cannot
 * pass vacuously: the Identity provider double below carries a distinctive
 * issuer, client id and discovery URL, and the test asserts that NONE of those
 * byte sequences appears anywhere in the serialised response. A test that only
 * checked for the absence of a key named `issuer` would miss a leak that
 * renamed the field.
 */
import express from 'express';
import http from 'http';

const activeProvider = jest.fn();

jest.mock('../services/identity/IdentityProviderService', () => ({
  identityProviderService: {
    activeProvider: (...args: unknown[]) => activeProvider(...args),
  },
}));
// Only the LOOKUP is doubled, and the rest of the module is kept: `config/
// relayhall` also imports `BUILT_IN_APPEARANCE` from here, and a wholesale
// double silently removed it — which surfaced as a request that never
// answered rather than as an obvious mock error. Returning `undefined` makes
// `getPublicConfig` use that built-in identity, the same path the route's own
// catch arm takes.
jest.mock('../services/AppearanceService', () => ({
  ...jest.requireActual('../services/AppearanceService'),
  appearanceService: { get: jest.fn().mockResolvedValue(undefined) },
}));

const SECRET_SHAPED = {
  issuer: 'https://idp.example.test/realms/UNIQUE-ISSUER-MARKER',
  clientId: 'UNIQUE-CLIENT-ID-MARKER',
  discoveryUrl: 'https://idp.example.test/realms/UNIQUE-ISSUER-MARKER/.well-known/openid-configuration',
};

/** The house idiom: a real listener and `http.request`, as in the W1 suites. */
async function getConfig(): Promise<{ status: number; body: any; raw: string }> {
  const configRoutes = (await import('../routes/config')).default;
  const app = express();
  app.use('/config', configRoutes);
  const server = await new Promise<http.Server>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    return await new Promise((resolve, reject) => {
      const request = http.request(`http://127.0.0.1:${port}/config`, { method: 'GET' }, (response) => {
        let raw = '';
        response.on('data', (chunk) => {
          raw += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(raw), raw }));
      });
      request.on('error', reject);
      request.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('§3.2 — the /config SSO presence block', () => {
  beforeEach(() => {
    jest.resetModules();
    activeProvider.mockReset();
  });

  it('reports SSO disabled when no Identity provider is enabled', async () => {
    activeProvider.mockResolvedValue(undefined);
    const { body } = await getConfig();
    expect(body.auth.sso).toEqual({ enabled: false, displayName: null });
    // W1's own field is untouched beside it.
    expect(typeof body.auth.sessions).toBe('boolean');
  });

  it('reports the display name when an Identity provider is enabled', async () => {
    activeProvider.mockResolvedValue({ ...SECRET_SHAPED, name: 'Acme SSO', status: 'active' });
    const { body } = await getConfig();
    expect(body.auth.sso.enabled).toBe(true);
    expect(body.auth.sso.displayName).toBe('Acme SSO');
  });

  it('leaks NO issuer, client id or endpoint — asserted on the raw bytes', async () => {
    activeProvider.mockResolvedValue({ ...SECRET_SHAPED, name: 'Acme SSO', status: 'active' });
    const { raw, body } = await getConfig();
    // NON-VACUITY: the fixture really did carry those values, and the block
    // really did render, so an empty response cannot pass this test.
    expect(body.auth.sso.enabled).toBe(true);
    expect(raw).toContain('Acme SSO');
    // The negative, on the bytes rather than on key names.
    expect(raw).not.toContain('UNIQUE-ISSUER-MARKER');
    expect(raw).not.toContain('UNIQUE-CLIENT-ID-MARKER');
    expect(raw).not.toContain('.well-known');
    // And the block's shape is exactly the three ratified fields.
    expect(Object.keys(body.auth.sso).sort()).toEqual(['displayName', 'enabled']);
  });

  it('still serves a login page when the Identity provider lookup fails', async () => {
    // The login page must render even when the database is unreachable. Failing
    // closed here means "no SSO button", never "no login page".
    activeProvider.mockRejectedValue(new Error('database unreachable'));
    const { status, body } = await getConfig();
    expect(status).toBe(200);
    expect(body.auth.sso.enabled).toBe(false);
  });
});
