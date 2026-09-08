/**
 * Plugin theme contract (RH-DESIGN.6 §4.4, task c7239175).
 *
 * Plugins style themselves from RelayHall's SEMANTIC tokens, re-published
 * under `--rh-*` names at `GET /plugins/theme.css`. The retired estate-era
 * variable block it replaces is gone (A13/D-9).
 *
 * Injection discipline (review S-F7). This module emits CSS that a plugin
 * loads into its own document, so every byte must be ours:
 *   - theme names resolve through a CLOSED enum to STATIC token tables; an
 *     unknown name never reaches the output, it falls back to the default;
 *   - any dynamic value (today: the deployment accent, which arrives with
 *     Appearance in UI.4) is validated and CANONICALLY RE-SERIALIZED to
 *     lowercase `#rrggbb` before interpolation — the input string itself is
 *     never echoed;
 *   - anything that fails validation is dropped, not sanitised-and-used.
 *
 * Only Themes with a bound token table appear in BUILT_IN_THEMES. RH-UI.2
 * defined `relay-light` and `high-contrast`, so v1's three built-ins are all
 * present; the enum stays CLOSED, and a fourth Theme means a fourth table.
 *
 * These tables are RESOLVED copies of the semantic layer in
 * frontend/src/styles/variables.css — a plugin loads them into its own
 * document, where our primitive ramps do not exist, so every value has to be
 * final. A second copy of a palette is a second thing to drift, so
 * scripts/check-theme-parity.py resolves the stylesheet itself and fails if
 * any value here disagrees with the Theme it claims to publish.
 */

/** Built-in Theme names that have a bound token table (A16 value space). */
export const BUILT_IN_THEMES = ['relay-dark', 'relay-light', 'high-contrast'] as const;
export type BuiltInTheme = (typeof BUILT_IN_THEMES)[number];
export const DEFAULT_THEME: BuiltInTheme = 'relay-dark';

/** The published surface: semantic tokens only, never primitives. */
type TokenTable = Readonly<Record<string, string>>;

const RELAY_DARK: TokenTable = {
  'bg-app': '#0f1216',
  'bg-surface': '#161a20',
  'bg-surface-hover': '#1a1f27',
  'bg-elevated': '#1d232b',
  'text-primary': '#f2f4f7',
  'text-secondary': '#d9dee5',
  'text-tertiary': '#8892a0',
  'text-quaternary': '#5b6675',
  'text-accent': '#5eead4',
  'text-success': '#4ade80',
  'text-warning': '#fbbf24',
  'text-error': '#f87171',
  'text-info': '#22d3ee',
  // Ink for FILLED affordances. Published because a plugin drawing a button
  // on --rh-accent-color faces exactly the AA failure the product hit: every
  // fill in this palette is light, so a light label lands at 2.26:1.
  'text-on-fill': '#0f1216',
  'border-subtle': 'rgba(255, 255, 255, 0.08)',
  'border-default': 'rgba(255, 255, 255, 0.12)',
  'border-strong': 'rgba(255, 255, 255, 0.18)',
  'accent-color': '#14b8a6',
  'accent-hover': '#2dd4bf',
  'accent-active': '#0d9488',
  'danger-color': '#ef4444',
  'status-success': '#4ade80',
  'status-warning': '#fbbf24',
  'status-danger': '#f87171',
  'status-info': '#22d3ee',
  'radius-sm': '0.375rem',
  'radius-md': '0.75rem',
  'radius-lg': '1rem',
  'space-2': '0.5rem',
  'space-4': '1rem',
  'font-body': "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  'font-mono': "'IBM Plex Mono', ui-monospace, 'Cascadia Mono', 'Courier New', monospace",
};

/**
 * relay-light. Ink and affordances sit at the DARK end of every ramp: a
 * status colour is simultaneously label text (4.5:1 against the surface) and
 * an affordance fill (4.5:1 under white on-fill ink), and contrast is
 * symmetric, so one value satisfies both readings or neither.
 */
const RELAY_LIGHT: TokenTable = {
  'bg-app': '#e9edf2',
  'bg-surface': '#f7f9fb',
  'bg-surface-hover': '#f2f4f7',
  'bg-elevated': '#ffffff',
  'text-primary': '#0f1216',
  'text-secondary': '#2a323d',
  'text-tertiary': '#5b6675',
  'text-quaternary': '#8892a0',
  'text-accent': '#115e59',
  'text-success': '#166534',
  'text-warning': '#854d0e',
  'text-error': '#b91c1c',
  'text-info': '#0e7490',
  'text-on-fill': '#ffffff',
  'border-subtle': 'rgba(15, 18, 22, 0.10)',
  'border-default': 'rgba(15, 18, 22, 0.16)',
  'border-strong': 'rgba(15, 18, 22, 0.24)',
  'accent-color': '#0f766e',
  'accent-hover': '#115e59',
  'accent-active': '#134e4a',
  'danger-color': '#b91c1c',
  'status-success': '#166534',
  'status-warning': '#854d0e',
  'status-danger': '#b91c1c',
  'status-info': '#0e7490',
  'radius-sm': '0.375rem',
  'radius-md': '0.75rem',
  'radius-lg': '1rem',
  'space-2': '0.5rem',
  'space-4': '1rem',
  'font-body': "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  'font-mono': "'IBM Plex Mono', ui-monospace, 'Cascadia Mono', 'Courier New', monospace",
};

/**
 * high-contrast. A Theme in its own right (A16/D10), not an overlay flag.
 * Borders are SOLID here rather than alpha — a composited hairline is
 * precisely what fails for the people who choose this Theme.
 */
const HIGH_CONTRAST: TokenTable = {
  'bg-app': '#000000',
  'bg-surface': '#000000',
  'bg-surface-hover': '#0a0d11',
  'bg-elevated': '#0f1216',
  'text-primary': '#ffffff',
  'text-secondary': '#f2f4f7',
  'text-tertiary': '#d9dee5',
  'text-quaternary': '#b6bec9',
  'text-accent': '#5eead4',
  'text-success': '#86efac',
  'text-warning': '#fcd34d',
  'text-error': '#fca5a5',
  'text-info': '#67e8f9',
  'text-on-fill': '#000000',
  'border-subtle': '#8892a0',
  'border-default': '#d9dee5',
  'border-strong': '#ffffff',
  'accent-color': '#5eead4',
  'accent-hover': '#99f6e4',
  'accent-active': '#2dd4bf',
  'danger-color': '#fca5a5',
  'status-success': '#86efac',
  'status-warning': '#fcd34d',
  'status-danger': '#fca5a5',
  'status-info': '#67e8f9',
  'radius-sm': '0.375rem',
  'radius-md': '0.75rem',
  'radius-lg': '1rem',
  'space-2': '0.5rem',
  'space-4': '1rem',
  'font-body': "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  'font-mono': "'IBM Plex Mono', ui-monospace, 'Cascadia Mono', 'Courier New', monospace",
};

const THEME_TABLES: Readonly<Record<BuiltInTheme, TokenTable>> = {
  'relay-dark': RELAY_DARK,
  'relay-light': RELAY_LIGHT,
  'high-contrast': HIGH_CONTRAST,
};

/** Closed-enum resolution: an unknown or unbound name yields the default. */
export function resolveTheme(requested?: string | null): BuiltInTheme {
  return (BUILT_IN_THEMES as readonly string[]).includes(requested ?? '')
    ? (requested as BuiltInTheme)
    : DEFAULT_THEME;
}

const HEX_COLOUR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Validate and CANONICALISE an accent override to lowercase `#rrggbb`.
 * Returns null when the input is not exactly a hex colour — callers drop it.
 * The caller's string is never emitted; only this function's output is.
 */
export function canonicalAccent(value?: string | null): string | null {
  if (typeof value !== 'string') return null;
  const match = HEX_COLOUR.exec(value.trim());
  if (!match) return null;
  let hex = match[1].toLowerCase();
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  return `#${hex}`;
}

export interface ThemeCssOptions {
  /** Built-in Theme name; anything unrecognised resolves to the default. */
  theme?: string | null;
  /** Deployment accent override (Appearance, UI.4). Validated, or dropped. */
  accent?: string | null;
}

/** Generate the plugin-facing stylesheet. Output is entirely ours by construction. */
export function generateThemeCss(options: ThemeCssOptions = {}): string {
  const theme = resolveTheme(options.theme);
  const table = THEME_TABLES[theme];
  const accent = canonicalAccent(options.accent);

  const declarations = Object.entries(table).map(([name, value]) => {
    const emitted = accent && (name === 'accent-color') ? accent : value;
    return `  --rh-${name}: ${emitted};`;
  });

  return [
    '/* RelayHall plugin theme — generated, do not edit.',
    ` * Theme: ${theme}. Semantic tokens only; see docs/plugin-development.md. */`,
    ':root {',
    ...declarations,
    '}',
    '',
  ].join('\n');
}
