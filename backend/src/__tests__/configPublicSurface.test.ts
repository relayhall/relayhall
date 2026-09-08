import path from 'path';

describe('GET /config source contract', () => {
  it('exposes the exact flat Appearance allowlist and retires bot/branding', () => {
    const examplePath = path.resolve(__dirname, '../../..', 'relayhall.config.example.json');
    let publicConfig: Record<string, unknown> = {};
    let legacyTitle: string | null = null;
    jest.isolateModules(() => {
      const previous = process.env.RELAYHALL_CONFIG;
      process.env.RELAYHALL_CONFIG = examplePath;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const cfg = require('../config/relayhall');
        publicConfig = cfg.getPublicConfig(cfg.relayhallConfig);
        legacyTitle = cfg.getLegacyAppearanceDisplayName();
      } finally {
        if (previous === undefined) delete process.env.RELAYHALL_CONFIG;
        else process.env.RELAYHALL_CONFIG = previous;
      }
    });
    expect(Object.keys(publicConfig).sort()).toEqual([
      'accentColor', 'assets', 'auth', 'defaultTheme', 'displayName', 'features',
      'loginSubtitle', 'loginTitle',
    ]);
    expect(publicConfig).not.toHaveProperty('bot');
    expect(publicConfig).not.toHaveProperty('branding');
    expect(Object.keys(publicConfig.features as object).sort())
      .toEqual(['auditLog', 'projects', 'skills', 'taskBoard']);
    // SS-W1's presence block. An unauthenticated caller learns whether this
    // deployment offers login sessions and NOTHING else — no handle, no
    // Account list, no administrator name.
    //
    // SS-W2 extended it with the SSO presence fields (design d95136d7 §3.2),
    // and this assertion is extended with them, as the instruction here said
    // it must be. The sub-block is enumerated too: `enabled` and
    // `displayName`, and NOTHING else — no issuer, no client id, no endpoint.
    // A leak would have to widen this list in a diff a reviewer reads.
    //
    // Card 27322abb (owner ruling 60307311 §1.1) adds `firstRun` — whether this
    // deployment still has no administrator Account. A boolean, and the same
    // rule applies to it: it is enumerated here, so a later identity fact
    // cannot join the pre-login payload without this line changing in a diff a
    // reviewer reads.
    const auth = publicConfig.auth as Record<string, unknown>;
    expect(Object.keys(auth).sort()).toEqual(['firstRun', 'sessions', 'sso']);
    expect(typeof auth.sessions).toBe('boolean');
    expect(typeof auth.firstRun).toBe('boolean');
    // Not supplied by this caller: the fail-closed default, which withholds
    // the step rather than advertising one the caller could not establish.
    expect(auth.firstRun).toBe(false);
    const sso = auth.sso as Record<string, unknown>;
    expect(Object.keys(sso).sort()).toEqual(['displayName', 'enabled']);
    expect(typeof sso.enabled).toBe('boolean');
    // With no Identity provider supplied, the block is present and negative —
    // the login page must be able to render before anything is configured.
    expect(sso.enabled).toBe(false);
    expect(sso.displayName).toBeNull();
    expect(legacyTitle).toBe('RelayHall');
  });

  it('serves the accent only as an explicit deployment override, never the built-in default', () => {
    const examplePath = path.resolve(__dirname, '../../..', 'relayhall.config.example.json');
    jest.isolateModules(() => {
      const previous = process.env.RELAYHALL_CONFIG;
      process.env.RELAYHALL_CONFIG = examplePath;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const cfg = require('../config/relayhall');
        const view = (overrides: { accentColor: string | null }) => ({
          overrides: { displayName: null, loginTitle: null, loginSubtitle: null, defaultTheme: null, accentColor: overrides.accentColor, description: null, links: [], teamMarkdown: null },
          effective: { displayName: 'RelayHall', loginTitle: 't', loginSubtitle: 's', defaultTheme: 'relay-dark', accentColor: '#14b8a6', description: null, links: [], teamMarkdown: null },
          assets: { logo: null, favicon: null, mark: null },
          updatedAt: null,
        });
        // No appearance row at all (DB-outage fallback) -> null, not the default hex.
        expect(cfg.getPublicConfig(cfg.relayhallConfig).accentColor).toBeNull();
        // Blank overrides -> null: the frontend must not inject the built-in
        // default as a root inline style, which would clobber the per-theme
        // accent bindings (relay-light teal-700, high-contrast teal-300).
        expect(cfg.getPublicConfig(cfg.relayhallConfig, view({ accentColor: null })).accentColor).toBeNull();
        // Explicit override -> served verbatim.
        expect(cfg.getPublicConfig(cfg.relayhallConfig, view({ accentColor: '#8b5cf6' })).accentColor).toBe('#8b5cf6');
      } finally {
        if (previous === undefined) delete process.env.RELAYHALL_CONFIG;
        else process.env.RELAYHALL_CONFIG = previous;
      }
    });
  });
});
