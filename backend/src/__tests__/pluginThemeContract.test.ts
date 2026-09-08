/**
 * Plugin theme contract (RH-DESIGN.6 §4.4, task c7239175).
 *
 * The generated stylesheet is loaded into a plugin's own document, so the
 * hostile cases here are the point: nothing a caller supplies may reach the
 * output except through validation and canonical re-serialization (S-F7).
 */
import {
  BUILT_IN_THEMES,
  DEFAULT_THEME,
  canonicalAccent,
  generateThemeCss,
  resolveTheme,
} from '../services/pluginTheme';

describe('plugin theme contract', () => {
  it('publishes semantic tokens under the ratified --rh- prefix only', () => {
    const css = generateThemeCss();
    expect(css).toContain('--rh-bg-surface:');
    expect(css).toContain('--rh-text-primary:');
    expect(css).toContain('--rh-accent-color:');
    expect(css).toContain('--rh-status-danger:');
    // the retired estate prefix must never reappear
    expect(css).not.toMatch(/--cb-/);
    // primitive ramps are private and must not be published
    expect(css).not.toMatch(/--rh-(slate|teal|amber|cyan)-/);
  });

  it('resolves theme names through a closed enum', () => {
    expect(resolveTheme('relay-dark')).toBe('relay-dark');
    expect(resolveTheme(undefined)).toBe(DEFAULT_THEME);
    expect(resolveTheme('nope')).toBe(DEFAULT_THEME);
    expect(BUILT_IN_THEMES).toContain(DEFAULT_THEME);
  });

  it('publishes all three built-in Themes, and only those (RH-UI.2)', () => {
    // v1 ships exactly three (A16/D10). The enum stays CLOSED: an unbound name
    // still resolves to the default rather than emitting an empty stylesheet,
    // which is what makes the value safe to interpolate.
    expect([...BUILT_IN_THEMES].sort()).toEqual(['high-contrast', 'relay-dark', 'relay-light']);
    for (const theme of BUILT_IN_THEMES) {
      expect(resolveTheme(theme)).toBe(theme);
      const css = generateThemeCss({ theme });
      expect(css).toContain(`Theme: ${theme}`);
      expect(css).toContain('--rh-bg-app:');
      expect(css).toContain('--rh-text-on-fill:');
      // primitive ramps stay private in every Theme, not just the default
      expect(css).not.toMatch(/--rh-(slate|teal|amber|cyan|green|red)-/);
    }
    // Every Theme publishes the same token set: a plugin styled against one
    // Theme must not lose a variable when the deployment switches to another.
    const tokensFor = (theme: string) =>
      [...generateThemeCss({ theme }).matchAll(/--rh-([\w-]+):/g)].map((m) => m[1]).sort();
    const baseline = tokensFor('relay-dark');
    for (const theme of BUILT_IN_THEMES) {
      expect(tokensFor(theme)).toEqual(baseline);
    }
    // and they are genuinely different stylesheets, not three copies
    expect(generateThemeCss({ theme: 'relay-light' }))
      .not.toBe(generateThemeCss({ theme: 'relay-dark' }));
    expect(generateThemeCss({ theme: 'high-contrast' }))
      .not.toBe(generateThemeCss({ theme: 'relay-dark' }));
  });

  it('never lets a hostile theme name reach the output', () => {
    const hostile = [
      '../../etc/passwd',
      'relay-dark; } body { display: none } .x {',
      '</style><script>alert(1)</script>',
      'relay-dark") url(https://evil.example/x',
    ];
    for (const theme of hostile) {
      const css = generateThemeCss({ theme });
      expect(css).not.toContain('script');
      expect(css).not.toContain('evil.example');
      expect(css).not.toContain('display: none');
      expect(css).not.toContain('passwd');
      expect(css).toContain(`Theme: ${DEFAULT_THEME}`);
    }
  });

  it('canonicalises accepted accents and drops everything else', () => {
    expect(canonicalAccent('#14B8A6')).toBe('#14b8a6');
    expect(canonicalAccent('  #0F0  ')).toBe('#00ff00');
    for (const bad of [
      'red',
      'rgb(1,2,3)',
      '#14b8a',
      '#14b8a6; } body { background: url(https://evil.example/x)',
      'var(--rh-bg-app)',
      'expression(alert(1))',
      '',
      null,
      undefined,
    ]) {
      expect(canonicalAccent(bad as string)).toBeNull();
    }
  });

  it('emits only the canonical form of an accepted accent', () => {
    const css = generateThemeCss({ accent: '#14B8A6' });
    expect(css).toContain('--rh-accent-color: #14b8a6;');
    expect(css).not.toContain('#14B8A6');
  });

  it('drops a hostile accent instead of sanitising it into the output', () => {
    const css = generateThemeCss({ accent: '#000; } body { display: none } .x {' });
    expect(css).not.toContain('display: none');
    expect(css).toContain('--rh-accent-color: #14b8a6;'); // the theme's own value
  });

  it('produces a stylesheet that is structurally a single :root block', () => {
    const css = generateThemeCss();
    expect(css.match(/\{/g)).toHaveLength(1);
    expect(css.match(/\}/g)).toHaveLength(1);
    expect(css.trimStart().startsWith('/*')).toBe(true);
  });
});
