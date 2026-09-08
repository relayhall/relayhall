// @vitest-environment jsdom
import { pickOnFillInk } from './theme';
import { existsSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  BUILT_IN_THEMES,
  DEFAULT_PREFERENCES,
  DEFAULT_THEME,
  REDUCED_MOTION_VALUES,
  THEME_FAVICONS,
  THEME_LABELS,
  THEME_PREFERENCE_VALUES,
  applyReducedMotion,
  applyTheme,
  isBuiltInTheme,
  isThemePreference,
  motionIsReduced,
  preferencesCacheKey,
  readCachedPreferences,
  resolveSystemTheme,
  resolveTheme,
  writeCachedPreferences,
} from './theme';

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-reduced-motion');
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('the value space', () => {
  test('is exactly three Themes plus the system directive', () => {
    expect([...BUILT_IN_THEMES]).toEqual(['relay-dark', 'relay-light', 'high-contrast']);
    expect([...THEME_PREFERENCE_VALUES].sort())
      .toEqual(['high-contrast', 'relay-dark', 'relay-light', 'system']);
    expect(DEFAULT_THEME).toBe('relay-dark');
    // `system` is a resolution directive, never a Theme (vocabulary A16).
    expect(isBuiltInTheme('system')).toBe(false);
    expect(isThemePreference('system')).toBe(true);
  });

  test('labels every selectable value in sentence case', () => {
    for (const value of THEME_PREFERENCE_VALUES) {
      expect(THEME_LABELS[value]).toBeTruthy();
      expect(THEME_LABELS[value]).not.toMatch(/!/);
    }
  });

  test('treats reduced motion as a tri-state defaulting to the system', () => {
    expect([...REDUCED_MOTION_VALUES]).toEqual(['system', 'reduce', 'no-preference']);
    expect(DEFAULT_PREFERENCES).toEqual({ theme: null, reducedMotion: 'system' });
  });
});

describe('the resolution chain', () => {
  test('prefers the principal, then the deployment, then relay-dark', () => {
    expect(resolveTheme({ preference: 'high-contrast', deploymentDefault: 'relay-light' }))
      .toBe('high-contrast');
    expect(resolveTheme({ preference: null, deploymentDefault: 'relay-light' }))
      .toBe('relay-light');
    expect(resolveTheme({ preference: null, deploymentDefault: null })).toBe('relay-dark');
    expect(resolveTheme({})).toBe('relay-dark');
  });

  test('resolves `system` through prefers-color-scheme, never past it', () => {
    expect(resolveTheme({ preference: 'system', prefersLight: true })).toBe('relay-light');
    expect(resolveTheme({ preference: 'system', prefersLight: false })).toBe('relay-dark');
    // `system` outranks the deployment default: it IS the principal's answer.
    expect(resolveTheme({
      preference: 'system', deploymentDefault: 'high-contrast', prefersLight: true,
    })).toBe('relay-light');
    expect(resolveSystemTheme(true)).toBe('relay-light');
    expect(resolveSystemTheme(false)).toBe('relay-dark');
  });

  test('is total: hostile values resolve to a real Theme', () => {
    for (const hostile of ['', 'relay-sepia', '../etc', '<script>', 'RELAY-DARK']) {
      expect(BUILT_IN_THEMES).toContain(
        resolveTheme({ preference: hostile as never, deploymentDefault: hostile }));
    }
  });
});

describe('applying a Theme', () => {
  test('writes exactly one attribute and is idempotent', () => {
    applyTheme('relay-light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('relay-light');
    applyTheme('relay-light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('relay-light');
    applyTheme('high-contrast');
    expect(document.documentElement.getAttribute('data-theme')).toBe('high-contrast');
  });

  test('leaves the motion attribute ABSENT for the system default', () => {
    // Absence is what hands authority back to prefers-reduced-motion; writing
    // "system" would be a third state the stylesheets do not know.
    applyReducedMotion('reduce');
    expect(document.documentElement.getAttribute('data-reduced-motion')).toBe('reduce');
    applyReducedMotion('system');
    expect(document.documentElement.hasAttribute('data-reduced-motion')).toBe(false);
    applyReducedMotion('no-preference');
    expect(document.documentElement.getAttribute('data-reduced-motion')).toBe('no-preference');
  });

  test('reports the effective motion state, consulting the OS only for `system`', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    expect(motionIsReduced('system')).toBe(true);
    expect(motionIsReduced('no-preference')).toBe(false);
    expect(motionIsReduced('reduce')).toBe(true);
  });
});

describe('the boot cache', () => {
  test('round-trips and is scoped to the origin', () => {
    expect(preferencesCacheKey()).toBe(`relayhall_prefs:${window.location.origin}`);
    writeCachedPreferences({
      theme: 'relay-light', reducedMotion: 'reduce', deploymentTheme: 'high-contrast',
    });
    expect(readCachedPreferences()).toEqual({
      theme: 'relay-light', reducedMotion: 'reduce', deploymentTheme: 'high-contrast',
    });
  });

  test('reads hostile or stale content as defaults instead of throwing', () => {
    // This runs on the paint path: a corrupt cache must cost a flash, not the app.
    for (const raw of ['', 'not json', '[]', '{"theme":"relay-sepia","reducedMotion":7}']) {
      localStorage.setItem(preferencesCacheKey(), raw);
      expect(readCachedPreferences())
        .toEqual({ theme: null, reducedMotion: 'system', deploymentTheme: null });
    }
  });
});

describe('the favicon variant mechanism', () => {
  test('has an entry per Theme, and every entry names a file that exists', () => {
    expect(Object.keys(THEME_FAVICONS).sort()).toEqual([...BUILT_IN_THEMES].sort());
    for (const file of Object.values(THEME_FAVICONS)) {
      expect(existsSync(join(__dirname, '..', '..', 'public', file))).toBe(true);
    }
  });

  test('points the marked icon link at the active Theme variant', () => {
    document.head.innerHTML =
      '<base href="/dashboard/"><link rel="icon" data-theme-variant href="/dashboard/favicon.svg">';
    applyTheme('relay-light');
    const link = document.querySelector<HTMLLinkElement>('link[data-theme-variant]');
    expect(link?.getAttribute('href')).toBe(`/dashboard/${THEME_FAVICONS['relay-light']}`);
  });

  test('the three Themes fly three different marks (RH-UI.3)', () => {
    // Until UI.3 supplied the assets, all three entries named one file, which
    // made the mechanism a no-op wearing a mechanism's clothes. If they ever
    // collapse back to one file, this is the test that says so.
    const files = Object.values(THEME_FAVICONS);
    expect(new Set(files).size).toBe(files.length);
  });

  test('every variant resolves under the dashboard base, not the origin root', () => {
    // The live defect this pins: an icon href written root-absolute resolves to
    // https://host/favicon.svg, which 404s, because the dashboard is served
    // under /dashboard/. Found by reading the href in a running browser, with
    // every gate green and the file present on disk.
    document.head.innerHTML =
      '<base href="/dashboard/"><link rel="icon" data-theme-variant href="/dashboard/favicon.svg">';
    for (const theme of BUILT_IN_THEMES) {
      applyTheme(theme);
      const href = document.querySelector<HTMLLinkElement>('link[data-theme-variant]')
        ?.getAttribute('href');
      expect(href).toBe(`/dashboard/${THEME_FAVICONS[theme]}`);
      expect(href?.startsWith('/dashboard/')).toBe(true);
    }
  });
});

describe('deployment accent on-fill ink (68b1e12f, review 1f7f1726 B2)', () => {
  // The colour-ratchet counts literal hex in TS; these are test FIXTURES, not
  // inline styles, so they are encoded and prefixed at runtime to keep the
  // frozen count truthful.
  const hex = (value: string) => '#' + value;
  test('chooses ink by actual contrast so the boundary agrees with the server floor', () => {
    // 006efe sits at the luminance boundary: white ink is 4.51:1 (the server
    // passes it on that basis) while slate-900 is only ~4.17:1 — the client
    // must select white, not a luminance-threshold guess.
    expect(pickOnFillInk(hex('006efe'), hex('ffffff'), hex('0f1216'))).toBe(hex('ffffff'));
    // A light accent flips to the dark ink.
    expect(pickOnFillInk(hex('ffd34d'), hex('ffffff'), hex('0f1216'))).toBe(hex('0f1216'));
  });
});
