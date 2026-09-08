/**
 * Theme engine (RH-DESIGN.6 §5.5, task 07113036 / RH-UI.2).
 *
 * A Theme (vocabulary A16) is a reusable visual configuration binding the
 * semantic design tokens. v1 ships exactly three built-ins; `system` is NOT a
 * Theme but a RESOLUTION DIRECTIVE that follows prefers-color-scheme.
 *
 * Resolution chain, in order:
 *   1. the principal's own preference (this module's `preference`),
 *   2. the deployment's default Theme (Appearance, RH-UI.4 — carried here as
 *      `deploymentDefault` so the chain is complete the day it lands),
 *   3. `relay-dark`.
 *
 * The engine writes `data-theme` on the document element and nothing else:
 * every colour in the product resolves through the semantic layer bound by
 * that attribute (frontend/src/styles/variables.css). There is deliberately
 * no per-component theme awareness to keep in sync.
 *
 * The value space here is one of FOUR artifacts that must agree — this file,
 * backend/src/services/pluginTheme.ts, the CSS theme blocks, and migration
 * 080's CHECK constraint. `scripts/check-theme-parity.py` proves they do.
 */

/** Built-in Theme names (A16 value space). Order is the display order. */
export const BUILT_IN_THEMES = ['relay-dark', 'relay-light', 'high-contrast'] as const;
export type BuiltInTheme = (typeof BUILT_IN_THEMES)[number];

/** The Theme served when nothing else resolves (§5.5). */
export const DEFAULT_THEME: BuiltInTheme = 'relay-dark';

/**
 * The `theme` preference value space: the three Themes plus the `system`
 * resolution directive. Exactly this, per the RH-UI.2 success criteria.
 */
export const THEME_PREFERENCE_VALUES = [...BUILT_IN_THEMES, 'system'] as const;
export type ThemePreference = (typeof THEME_PREFERENCE_VALUES)[number];

/**
 * Reduced motion is a tri-state, not a boolean: the spec calls for
 * "system-default, overridable", and a boolean cannot express "follow the
 * operating system" as distinct from "force motion on". `system` is the
 * default and leaves the OS media query in charge.
 */
export const REDUCED_MOTION_VALUES = ['system', 'reduce', 'no-preference'] as const;
export type ReducedMotionPreference = (typeof REDUCED_MOTION_VALUES)[number];

/**
 * A principal's stored preferences. `theme: null` means "no preference of my
 * own" — the resolution chain falls through to the deployment default. That
 * absence is a real state and is why the column is nullable rather than
 * defaulted; without it the chain's middle link would be unreachable.
 */
export interface PrincipalPreferences {
  theme: ThemePreference | null;
  reducedMotion: ReducedMotionPreference;
}

export const DEFAULT_PREFERENCES: PrincipalPreferences = {
  theme: null,
  reducedMotion: 'system',
};

/** Display labels (sentence case, vocabulary §6). */
export const THEME_LABELS: Record<ThemePreference, string> = {
  'relay-dark': 'Relay dark',
  'relay-light': 'Relay light',
  'high-contrast': 'High contrast',
  system: 'Match my system',
};

/** Distinct from THEME_LABELS.system on purpose: two radio groups on the same
 *  page must not offer two options with the same accessible name. */
export const REDUCED_MOTION_LABELS: Record<ReducedMotionPreference, string> = {
  system: 'Use my system setting',
  reduce: 'Reduce motion',
  'no-preference': 'Allow motion',
};

export function isBuiltInTheme(value: unknown): value is BuiltInTheme {
  return typeof value === 'string' && (BUILT_IN_THEMES as readonly string[]).includes(value);
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return (
    typeof value === 'string' && (THEME_PREFERENCE_VALUES as readonly string[]).includes(value)
  );
}

export function isReducedMotionPreference(value: unknown): value is ReducedMotionPreference {
  return typeof value === 'string' && (REDUCED_MOTION_VALUES as readonly string[]).includes(value);
}

/** `system` resolves through prefers-color-scheme to one of the two Themes. */
export function resolveSystemTheme(prefersLight: boolean): BuiltInTheme {
  return prefersLight ? 'relay-light' : 'relay-dark';
}

export interface ThemeResolutionInput {
  /** The principal's preference; null/undefined = they have none. */
  preference?: ThemePreference | null;
  /** The deployment default Theme (Appearance, RH-UI.4). */
  deploymentDefault?: string | null;
  /** prefers-color-scheme: light — only consulted for the `system` directive. */
  prefersLight?: boolean;
}

/**
 * The resolution chain (§5.5). Total: every input, including hostile ones,
 * yields a built-in Theme name.
 */
export function resolveTheme({
  preference,
  deploymentDefault,
  prefersLight = false,
}: ThemeResolutionInput): BuiltInTheme {
  if (isBuiltInTheme(preference)) return preference;
  if (preference === 'system') return resolveSystemTheme(prefersLight);
  if (isBuiltInTheme(deploymentDefault)) return deploymentDefault;
  return DEFAULT_THEME;
}

const LIGHT_SCHEME_QUERY = '(prefers-color-scheme: light)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** matchMedia is absent in jsdom and in very old browsers; treat it as "no". */
function mediaMatches(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

export function systemPrefersLight(): boolean {
  return mediaMatches(LIGHT_SCHEME_QUERY);
}

export function systemPrefersReducedMotion(): boolean {
  return mediaMatches(REDUCED_MOTION_QUERY);
}

/**
 * Whether motion should be reduced right now, given the preference and the
 * operating system. Used for the "what this means for you" line on the user
 * config page; the CSS itself is driven by the attribute below.
 */
export function motionIsReduced(preference: ReducedMotionPreference): boolean {
  if (preference === 'reduce') return true;
  if (preference === 'no-preference') return false;
  return systemPrefersReducedMotion();
}

/**
 * Favicon variants per Theme (§5.5: "the favicon variant follows the active
 * Theme; mechanism owned by UI.2, static assets by UI.3").
 *
 * RH-UI.3 supplied the assets, so the three entries are now three different
 * cuts of monogram Tile B rather than one file named three times: the Themes
 * bind three genuinely different accents (teal-500 / teal-700 / teal-300) and
 * three different on-fill inks, and a tab icon that ignored that would be the
 * mechanism pretending to work.
 *
 * `relay-dark` keeps the fixed name `favicon.svg` because index.html must
 * reference an icon before any script runs, and the default Theme is the honest
 * thing to show at that moment.
 *
 * Regenerate the files with `scripts/make-brand-assets.py`;
 * `scripts/check-brand-assets.py` proves this map against the built-in Theme set
 * and against the bytes on disk, and `theme.test.ts` pins it from the frontend
 * side.
 */
export const THEME_FAVICONS: Record<BuiltInTheme, string> = {
  'relay-dark': 'favicon.svg',
  'relay-light': 'favicon-relay-light.svg',
  'high-contrast': 'favicon-high-contrast.svg',
};

/** Cache key for the boot snippet's copy of the preferences (origin-scoped,
 *  the same rule browser credentials follow — one origin is one deployment). */
export const PREFERENCES_CACHE_KEY_PREFIX = 'relayhall_prefs:';

export function preferencesCacheKey(): string {
  const origin =
    typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'local';
  return `${PREFERENCES_CACHE_KEY_PREFIX}${origin}`;
}

export interface CachedPreferences extends PrincipalPreferences {
  /** Mirrored so the boot snippet can complete the chain before any fetch. */
  deploymentTheme: BuiltInTheme | null;
}

/**
 * Read the boot cache. Hostile or stale content resolves to defaults rather
 * than throwing — this runs on the paint path.
 */
export function readCachedPreferences(): CachedPreferences {
  const fallback: CachedPreferences = { ...DEFAULT_PREFERENCES, deploymentTheme: null };
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(preferencesCacheKey());
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      theme: isThemePreference(parsed.theme) ? parsed.theme : null,
      reducedMotion: isReducedMotionPreference(parsed.reducedMotion)
        ? parsed.reducedMotion
        : 'system',
      deploymentTheme: isBuiltInTheme(parsed.deploymentTheme) ? parsed.deploymentTheme : null,
    };
  } catch {
    return fallback;
  }
}

export function writeCachedPreferences(value: CachedPreferences): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(preferencesCacheKey(), JSON.stringify(value));
  } catch {
    /* private mode / quota — the engine still works, it just re-flashes once */
  }
}

/**
 * Point the theme-color meta at the resolved Theme's app background.
 *
 * The value is READ BACK from the cascade rather than duplicated in TypeScript:
 * a second copy of every theme's background colour is a second thing to drift,
 * and the literal-colour gate would reject it here anyway.
 */
function applyThemeColorMeta(): void {
  if (typeof document === 'undefined') return;
  const computed = getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim();
  if (!computed) return; // jsdom, or stylesheet not yet applied
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', computed);
}

function applyFavicon(theme: BuiltInTheme, base: string): void {
  if (typeof document === 'undefined') return;
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"][data-theme-variant]');
  if (!link) return;
  link.href = `${base}${THEME_FAVICONS[theme]}`;
}

/** Base href for public assets, matching index.html's <base>. */
function assetBase(): string {
  if (typeof document === 'undefined') return '/dashboard/';
  return document.querySelector('base')?.getAttribute('href') || '/dashboard/';
}

/**
 * Apply a resolved Theme to the document. Idempotent, and safe to call on
 * every preference change: switching is one attribute write, so it happens
 * without a reload and without a flash.
 */
export function applyTheme(theme: BuiltInTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
  syncDeploymentAccentOverride();
  applyThemeColorMeta();
  applyFavicon(theme, assetBase());
}

/** 68b1e12f: an EXPLICIT deployment accent override never applies inside
 *  high-contrast — that Theme's accent is part of its contrast contract, and
 *  the inline root style would defeat it. The override re-applies the moment
 *  any other Theme becomes active. */
let deploymentAccentOverride: string | null = null;

export function setDeploymentAccentOverride(accent: string | null): void {
  deploymentAccentOverride = accent;
  syncDeploymentAccentOverride();
}

/** WCAG relative luminance of a #rrggbb / #rgb colour. */
function accentLuminance(hex: string): number {
  const long = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
  const linear = [1, 3, 5].map(offset => {
    const value = parseInt(long.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** The ink is chosen by ACTUAL contrast ratio, the same arithmetic the server
 *  floor validates with — a luminance threshold disagrees with it exactly at
 *  the boundary (review 1f7f1726 B2). */
export function pickOnFillInk(accent: string, lightInk: string, darkInk: string): string {
  const contrast = (a: string, b: string) => {
    const [high, low] = [accentLuminance(a), accentLuminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
  };
  return contrast(accent, lightInk) >= contrast(accent, darkInk) ? lightInk : darkInk;
}

function syncDeploymentAccentOverride(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (deploymentAccentOverride && root.getAttribute('data-theme') !== 'high-contrast') {
    root.style.setProperty('--accent-color', deploymentAccentOverride);
    // The on-fill ink follows the override (68b1e12f): the server floor
    // guarantees at least one ink clears 4.5:1 on the accent; pick it here so
    // text-bearing accent fills stay AA in EVERY non-HC Theme. White ink
    // clears 4.5:1 up to luminance ~0.183; dark ink from ~0.209.
    // Ink values come from the palette TOKENS (no literal colours in TS —
    // the acceptance ratchet): white ink clears 4.5:1 up to luminance ~0.183.
    const inks = typeof getComputedStyle === 'function' ? getComputedStyle(root) : null;
    const lightInk = inks?.getPropertyValue('--white').trim();
    const darkInk = inks?.getPropertyValue('--slate-900').trim();
    if (lightInk && darkInk) {
      root.style.setProperty('--text-on-fill', pickOnFillInk(deploymentAccentOverride, lightInk, darkInk));
    }
  } else {
    root.style.removeProperty('--accent-color');
    root.style.removeProperty('--text-on-fill');
  }
}

/**
 * Apply the motion preference. `system` REMOVES the attribute rather than
 * writing a value: absence is what hands control back to the media query in
 * styles/animations.css, and writing "system" would be a third state the CSS
 * would have to know about.
 */
export function applyReducedMotion(preference: ReducedMotionPreference): void {
  if (typeof document === 'undefined') return;
  if (preference === 'system') {
    document.documentElement.removeAttribute('data-reduced-motion');
    return;
  }
  document.documentElement.setAttribute('data-reduced-motion', preference);
}
