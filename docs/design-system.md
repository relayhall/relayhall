# RelayHall design system

**Authority:** the ratified RH-DESIGN.6 specification (board report `9f01ba4b`, 2026-08-10) governs
this contract; this document is its in-repo carrier and the reference the gates enforce. Naming
follows the vocabulary authority. Direction: **slate ledger** — audit-grade sobriety, near-monochrome
slate surfaces, one restrained teal accent, typography-led identity, minimal ornament.

## 1. Token architecture — three layers

All styling flows through custom properties declared in `frontend/src/styles/variables.css`.

1. **Primitive ramps** (`--slate-*`, `--teal-*`, status ramps) are **private**. Components must
   never reference them; only the semantic layer may. New primitives require a design decision,
   not a convenience edit.
2. **Semantic tokens** are **the only layer components may use**: `--bg-*`, `--text-*`,
   `--border-*`, `--accent-*`, `--danger-*`, `--status-*`, `--focus-ring`, plus the theme-bound
   elevation/overlay/scrim set (`--shadow-1..3`, `--overlay-*`, `--scrim`). A Theme binds this
   layer to primitives via `[data-theme="…"]`; `relay-dark` **also binds under
   `html:not([data-theme])`** so the app renders before the theme engine runs. Shadow/overlay/scrim
   **values** are per-theme bindings; the scale steps are fixed.
3. **Component tokens** exist sparingly, scoped in the component's own sheet and bound only to
   semantic tokens (`StatusOrb.css` is the model).

**Every Theme binds the semantic layer completely.** The fallback selector is
`html:not([data-theme])` and deliberately *not* `:root`, because `:root` matches the root element
whatever Theme it carries: a light Theme that forgot one token would silently inherit the dark
value, and every resolved-value check would still pass. Scoping the fallback to "no Theme chosen"
makes that an error instead — `check-design-contrast.py` reports the token as undefined for the
theme, and `check-theme-parity.py` reports the missing binding. **Theme-invariant tokens**
(typography, spacing, radii, motion, z-index, layout) are declared once in their own `:root` block
and must never be re-declared inside a Theme.

Known accepted wart (documented, hardening lane): `--text-sm` (a size) and `--text-primary`
(a colour) share a prefix.

The legacy raw ramps quarantined at the bottom of `variables.css` are compatibility bindings for
pre-existing component CSS; RH-UI.1b removes every reference and then the block itself. Do not add
references to them.

## 2. Hard rules (mechanically enforced)

- **No colour literals outside token-definition files.** `scripts/check-design-tokens.py` enforces
  a per-file ratchet frozen in `scripts/design-literal-baseline.json`: counts may only decrease,
  new files admit zero literals, and the updater refuses to loosen anything. The only
  token-definition file today is `styles/variables.css`.
- **No undefined tokens.** Same gate, existence check — a `var()` reference must resolve.
- **No inline-style colours in TSX.** Pinned by the acceptance-contract suite
  (`frontend/src/acceptanceContracts.test.ts`) as a source-text ratchet.
- **Fonts only via `--font-body` / `--font-mono`.** IBM Plex Sans and IBM Plex Mono are
  self-hosted woff2 (complete faces, `font-display: swap`, declared in `styles/fonts.css`);
  licences in `docs/third-party-licenses.md` (SIL OFL 1.1).
- **Focus ring:** the accent-derived `--focus-ring` token. `outline: none` is legal only next to a
  `:focus-visible` replacement. The rendered skip link (`.skip-link`, target `#main-content`) must
  stay first in the tab order.
- **Breakpoints:** the canon is **640 / 768 / 1024 / 1280** (px, `min-`/`max-width`). Pre-existing
  strays are repaired by RH-UI.1b; new stylesheets use the canon only.
- **Class naming:** new stylesheets namespace classes by component (`.taskpanel-…`), shared
  vocabulary lives only in `styles/` sheets. The pre-existing collisions are de-collided in
  RH-UI.1b.
- **Iconography:** lucide only in chrome; colour from tokens; emoji never as interface furniture
  (user content is unaffected — a Task title or Report body may contain anything a principal
  types). Chrome icons sit on the **16 / 20 / 24** grid: 16 inline with text and in dense rows,
  20 for section and card headers, 24 for primary affordances. Sizes **above 24 are illustration
  scale** (hero glyphs, avatars, empty-state art) and are not icon-grid members. Decorative icons
  that sit beside their own text label carry `aria-hidden="true"`; an icon-only control always
  carries an accessible name. All of it is enforced by `scripts/check-emoji-chrome.py`.
- **Plugin theming:** plugins style themselves from the published `--rh-*` semantic tokens
  (`GET /api/plugins/theme.css`, public by necessity — iframes cannot authenticate). Primitive
  ramps are never published. See `docs/plugin-development.md`.
- **Status colours never double as brand colours**, and destructive/success affordances always use
  the status/danger tokens, never the accent.
- **A filled affordance uses `--text-on-fill` for its label.** Every fill in this palette is
  light; a light label fails AA on all of them (2.26:1 on the accent), while the dark ink
  clears 4.9–11.2:1. The on-fill pairs are in the matrix below, so this cannot regress.

## 3. Palette

| Role | Token | Value |
|---|---|---|
| App background | `--bg-app` | slate `#0f1216` |
| Surface | `--bg-surface` | slate `#161a20` |
| Elevated | `--bg-elevated` | slate `#1d232b` |
| Primary text | `--text-primary` | `#f2f4f7` |
| Secondary text | `--text-secondary` | `#d9dee5` |
| Tertiary text | `--text-tertiary` | `#8892a0` |
| Accent | `--accent-color` | teal `#14b8a6` |
| Ink on filled affordances | `--text-on-fill` | slate `#0f1216` |
| Accent hover | `--accent-hover` | teal `#2dd4bf` |
| Danger | `--danger-color` | `#ef4444` |
| Success / warning / danger / info | `--status-*` | green / amber / red / cyan |

The table above is `relay-dark`. The other two Themes bind the same semantic layer:

### relay-light

The same ledger read on paper. Surfaces climb toward white as they rise, and **ink and affordances
move to the dark end of every ramp** — a status colour is simultaneously label text (4.5:1 against
the surface) and an affordance fill (4.5:1 under white on-fill ink), contrast is symmetric, so one
value has to clear both readings. That is why this Theme never reuses relay-dark's mid-ramp brights.

| Role | Token | Value |
|---|---|---|
| App background | `--bg-app` | slate `#e9edf2` |
| Surface | `--bg-surface` | slate `#f7f9fb` |
| Elevated | `--bg-elevated` | `#ffffff` |
| Primary text | `--text-primary` | slate `#0f1216` |
| Secondary text | `--text-secondary` | slate `#2a323d` |
| Tertiary text | `--text-tertiary` | slate `#5b6675` |
| Accent | `--accent-color` | teal `#0f766e` |
| Ink on filled affordances | `--text-on-fill` | `#ffffff` |
| Danger | `--danger-color` | `#b91c1c` |
| Success / warning / danger / info | `--status-*` | `#166534` / `#854d0e` / `#b91c1c` / `#0e7490` |

The focus ring is **solid** here, not translucent: relay-dark's alpha ring works because it
composites over dark surfaces, and the same alpha over near-white paper lands at ~3:1, one rounding
away from failing 1.4.11.

### high-contrast

A Theme in its own right (A16/D10), not an overlay flag. Pure black ground, near-white ink, the
bright end of every ramp. **Borders are solid rather than alpha** and carry the structure that
elevation shadows cannot convey on black — a composited hairline is exactly what fails for the
people who choose this Theme. Every matrix pair clears 11:1.

| Role | Token | Value |
|---|---|---|
| App background / surface | `--bg-app`, `--bg-surface` | `#000000` |
| Elevated | `--bg-elevated` | slate `#0f1216` |
| Primary text | `--text-primary` | `#ffffff` |
| Accent | `--accent-color` | teal `#5eead4` |
| Ink on filled affordances | `--text-on-fill` | `#000000` |
| Borders | `--border-subtle/default/strong` | `#8892a0` / `#d9dee5` / `#ffffff` |
| Success / warning / danger / info | `--status-*` | `#86efac` / `#fcd34d` / `#fca5a5` / `#67e8f9` |

The deployment accent override is validated against all three Themes' surfaces at save (RH-UI.4).

## 3a. Brand assets — which mark goes where

The identity is **wordmark-led** (D16). The wordmark is **Cut A**: IBM Plex Sans SemiBold, tracking
-6, hand-kerned, "Relay" in `--text-primary` and "Hall" in `--accent-color`. The monogram is the
same letterforms cut to `RH` for compact contexts.

**There is one monogram on two grounds, and the binding is not a matter of taste.** Read this before
"fixing" the inconsistency:

| Binding | Asset | Where it goes | Why |
|---|---|---|---|
| **Tile A** — slate ground, R in ink / H in accent | `frontend/public/brand/monogram-tile-a-slate.svg` | in-app, wherever the mark sits on one of our own surfaces | it belongs to the slate-ledger direction; the accent stays a highlight rather than a field |
| **Tile B** — solid accent ground, mark knocked out in `--text-on-fill` | `frontend/public/favicon*.svg`, `apple-touch-icon.png`, `docs/brand/org-avatar-512.png` | favicon, app icon, org avatar | Tile A's slate ground **disappears into dark browser chrome at 16px**; Tile B is legible there and too loud inside the product |
| **mono** | `*-mono.svg` | single-colour print, and anywhere the accent cannot be trusted to reproduce | monochrome variants exist by construction (D16), which is only true if they are shipped |

A third tile (slate ground with a slate edge) was cut and **not adopted**: its 12-unit edge falls
under one device pixel at 16px, so it collapsed into Tile A at exactly the size it existed to
differentiate. Measured, not argued — owner ruling `9aa295f2`.

**The favicon has three cuts, one per Theme**, because the three Themes bind three different accents
and three different on-fill inks; `THEME_FAVICONS` in `frontend/src/utils/theme.ts` selects between
them at runtime. `relay-dark`'s cut keeps the fixed name `favicon.svg` because `index.html` must
reference an icon before any script runs. The **rasters** (`favicon-16/32/64.png`, `favicon.ico`,
`apple-touch-icon.png`, the org avatar) bake the **default Theme**: a bookmark bar never learns which
Theme is active.

**Assets are generated, never hand-drawn.** `scripts/make-brand-assets.py` pulls every outline from
the IBM Plex woff2 the product already serves and reads its colours out of `variables.css`, so the
marks cannot drift off-palette. Edit the generator and re-run it; do not edit an `.svg` by hand.
`scripts/check-brand-assets.py` proves the committed set — dimensions, ICO members, palette
conformance **in the SVG source and in the decoded raster pixels**, reference integrity from
`index.html` and `THEME_FAVICONS`, and the 16px favicon's legibility as both **ground-to-ink
contrast and mark area** (a tile with one contrasting pixel is not a mark). The retired marks are
refused by basename, by gradient signature and by **content hash**, and
`frontend/public`, `frontend/public/brand` and `docs/brand` are a **closed set, subdirectories
included**: an undeclared image may not sit anywhere beneath them, which is what keeps a retired
raster from returning under a new name. The traversal is recursive — a first cut checked only
immediate children while still reporting the directories closed, and an image one level down passed
unseen. Rasters are measured against the *segments* between palette colours, because antialiasing puts
edge pixels on the line between the two they blend.

The **in-app** wordmark is not an `<img>`: its outlines live in
`frontend/src/brand/wordmarkPaths.ts` and are painted with `var(--text-primary)` and
`var(--accent-color)` so the mark follows the active Theme. The `.svg` files exist for the contexts
that need a file — a README, an org avatar, a social card — and those bake `relay-dark`.

## 4. Contrast pairing matrix

`scripts/check-design-contrast.py` consumes the fenced JSON block below (single source of truth),
resolves each token against `variables.css` for the requested theme, composites alpha colours over
their pair background, and fails the build if any pair misses its threshold class: **text = 4.5:1**
(WCAG 2.2 AA 1.4.3), **ui = 3:1** (1.4.11, non-text). Exemptions are declared with rationale;
the script verifies every exempted token still exists so stale exemptions surface.

```json contrast-matrix
{
  "thresholds": { "text": 4.5, "ui": 3.0 },
  "pairs": [
    { "fg": "--text-primary", "bg": "--bg-app", "class": "text" },
    { "fg": "--text-primary", "bg": "--bg-surface", "class": "text" },
    { "fg": "--text-primary", "bg": "--bg-elevated", "class": "text" },
    { "fg": "--text-secondary", "bg": "--bg-app", "class": "text" },
    { "fg": "--text-secondary", "bg": "--bg-surface", "class": "text" },
    { "fg": "--text-secondary", "bg": "--bg-elevated", "class": "text" },
    { "fg": "--text-secondary", "bg": "--bg-surface-hover", "class": "text" },
    { "fg": "--text-tertiary", "bg": "--bg-app", "class": "text" },
    { "fg": "--text-tertiary", "bg": "--bg-surface", "class": "text" },
    { "fg": "--text-tertiary", "bg": "--bg-elevated", "class": "text" },
    { "fg": "--text-accent", "bg": "--bg-surface", "class": "text" },
    { "fg": "--text-success", "bg": "--bg-surface", "class": "text" },
    { "fg": "--text-warning", "bg": "--bg-surface", "class": "text" },
    { "fg": "--text-error", "bg": "--bg-surface", "class": "text" },
    { "fg": "--text-info", "bg": "--bg-surface", "class": "text" },
    { "fg": "--text-warning", "bg": "--bg-elevated", "class": "text" },
    { "fg": "--text-error", "bg": "--bg-elevated", "class": "text" },
    { "fg": "--text-info", "bg": "--bg-elevated", "class": "text" },
    { "fg": "--accent-color", "bg": "--bg-app", "class": "ui" },
    { "fg": "--accent-color", "bg": "--bg-surface", "class": "ui" },
    { "fg": "--accent-hover", "bg": "--bg-surface", "class": "ui" },
    { "fg": "--status-success", "bg": "--bg-surface", "class": "ui" },
    { "fg": "--status-warning", "bg": "--bg-surface", "class": "ui" },
    { "fg": "--status-danger", "bg": "--bg-surface", "class": "ui" },
    { "fg": "--status-info", "bg": "--bg-surface", "class": "ui" },
    { "fg": "--focus-ring-color", "bg": "--bg-app", "class": "ui" },
    { "fg": "--focus-ring-color", "bg": "--bg-surface", "class": "ui" },

    { "fg": "--text-on-fill", "bg": "--accent-color", "class": "text" },
    { "fg": "--text-on-fill", "bg": "--accent-hover", "class": "text" },
    { "fg": "--text-on-fill", "bg": "--danger-color", "class": "text" },
    { "fg": "--text-on-fill", "bg": "--status-success", "class": "text" },
    { "fg": "--text-on-fill", "bg": "--status-warning", "class": "text" },
    { "fg": "--text-on-fill", "bg": "--status-danger", "class": "text" },
    { "fg": "--text-on-fill", "bg": "--status-info", "class": "text" }
  ],
  "exemptions": [
    { "token": "--text-quaternary",
      "rationale": "disabled/placeholder text class - exempt per WCAG 1.4.3 (inactive components)" },
    { "token": "--border-subtle",
      "rationale": "decorative separator - component identification never relies on it alone" },
    { "token": "--border-default",
      "rationale": "decorative separator - inputs carry background contrast plus the focus ring" },
    { "token": "--border-strong",
      "rationale": "decorative emphasis - border contrast uplift is filed in the hardening lane" }
  ]
}
```

**All three Themes run the whole matrix**, in both CI files, as three separate steps
(`--theme relay-dark|relay-light|high-contrast`). A pair that passes in one Theme and fails in
another is a failed build, not a footnote: the matrix is the accessibility contract, and a Theme
that cannot satisfy it is not shippable.

## 5. Themes and the theme engine

Three built-in Themes (vocabulary A16), and `system` — which is **not** a Theme but a resolution
directive following `prefers-color-scheme`.

**Resolution chain** (`frontend/src/utils/theme.ts`, spec §5.5):
the principal's preference → the deployment's default Theme (Appearance, RH-UI.4) → `relay-dark`.
`system` resolves to `relay-light` or `relay-dark`. Switching writes one attribute — `data-theme`
on the document element — so it happens without a reload and without a flash.

**The value space lives in four places** and `scripts/check-theme-parity.py` proves they agree:
the CSS `[data-theme="…"]` blocks, the frontend engine's `BUILT_IN_THEMES`, the plugin theme
service's `BUILT_IN_THEMES` and token tables, and migration `080`'s `CHECK` constraint. The gate
also resolves the stylesheet and compares every value the plugin service publishes, because those
tables are resolved copies and a copy is a thing that drifts.

**Reduced motion** is a tri-state: `system` (default — the attribute is absent and
`prefers-reduced-motion` is in charge), `reduce`, `no-preference`. A boolean cannot express
"follow my operating system" as distinct from "force motion on", and those are different answers.

**The FOUC guard** is one inline script in `frontend/index.html`, marked `data-theme-boot`. It
resolves the same chain from the cache the engine writes, before the first paint. It is the one
inline script RelayHall serves and the only one the §5.6 CSP admits by hash:

theme-boot-csp-hash: sha256-p62EDMEN+tmK7OL9Aevygjmux5c2p3gl5X5SGltb4Jw=

`scripts/check-theme-boot-hash.py` proves that record against **both** `frontend/index.html` and
the built `frontend/dist/index.html` — Vite minifies inline scripts, and a CSP hash that does not
match the bytes served fails silently, as a theme flash nobody can reproduce. The snippet is
therefore written pre-minified on one line; keep it that way. RH-UI.4 copies this value into the
nginx CSP.

**`theme-color` and the favicon** follow the active Theme. The meta value is read back out of the
cascade (`--bg-app`) rather than duplicated in TypeScript. The favicon variant is a declared map
(`THEME_FAVICONS`) with an entry per Theme, pinned by test to files that exist in
`frontend/public/`; RH-UI.3 supplies the light-ground artwork and changes one line.

**Preferences are per principal and IDOR-proof by construction.** `principal_preferences` is keyed
on the principal itself, and `GET`/`PUT /api/preferences` derive the principal from the
authenticated session: no identifier is accepted in a path or a body, so there is no row for a
request to address but its own.

## 6. Interaction and state patterns

Canonical shapes (exemplars live in the components named):

- **Empty:** icon + one line + primary action (`CoreSurfacePlaceholder`).
- **Loading:** skeleton at page level; inline spinner for in-flight actions.
- **Error:** fixed-text envelope inline with retry; toast only for background failures.
- **Disabled:** `aria-disabled` + `--text-quaternary`, never colour alone.
- **Permission-denied is distinct from empty:** lock icon + the scope you need.
- **Modals:** focus-trapped, Escape-safe.
- **Detail views:** the Task side-panel → full page is the canonical shape.
- **Touch targets:** ≥ 44px.

## 7. Motion

Duration/easing only via `--transition-*` / `--ease-*`. `prefers-reduced-motion` remains a global
kill-switch and must keep covering route transitions.

## 8. Voice

Sentence case everywhere. Plain declarative labels. No exclamation marks.

## 9. Screenshot and presentation rules

For any screenshot committed, published, or attached to reviews or documentation:

- Default RelayHall branding only — never a deployment's Appearance.
- Demo data only — never estate or production content.
- Dark theme primary; at least one light-theme shot per set once `relay-light` ships.
- Viewport 1440×900; device frames only for mobile shots; no browser chrome unless the chrome
  itself is being demonstrated.
- Residue gates green on every asset before it lands.

## 10. Enforcement inventory

| Check | Where | Proves itself via |
|---|---|---|
| Token existence | `scripts/check-design-tokens.py` | `scripts/test-design-token-gate.py` |
| Literal-colour ratchet | same gate + `scripts/design-literal-baseline.json` | same self-test (monotonicity fixtures) |
| Contrast pairing matrix, **per Theme** | `scripts/check-design-contrast.py` (§4 block), three CI steps | `scripts/test-design-contrast-gate.py` |
| Theme value space and completeness | `scripts/check-theme-parity.py` | `scripts/test-theme-parity-gate.py` |
| Theme boot-snippet CSP hash | `scripts/check-theme-boot-hash.py` (source **and** built HTML) | `scripts/test-theme-boot-hash-gate.py` |
| Accessibility structure (axe) | `frontend/src/a11y.smoke.test.tsx` (`npm run test:a11y`) | a known-bad fixture in the same file |
| Exceptions never reach logs (ratchet) | `scripts/check-error-log-hygiene.py` + `scripts/error-log-baseline.json` | `scripts/test-error-log-hygiene-gate.py` |
| Inline-style colours | `frontend/src/acceptanceContracts.test.ts` | vitest |
| Rendered-class ownership | `scripts/check-rendered-classes.py` | `scripts/test-rendered-class-gate.py` |
| Semantic/brand separation | `scripts/check-semantic-tokens.py` | `scripts/test-semantic-token-gate.py` |
| Colour-mapping semantics | `scripts/colour-sweep-map.json` + `scripts/test-colour-sweep-map.py` | self-proving |
| Sweep-script behaviour | `scripts/sweep-*.py` | `scripts/test-sweep-scripts.py` |
| Class ownership | `scripts/audit-css-collisions.py --check` | hostile probe in review |
| Iconography (emoji + size grid) | `scripts/check-emoji-chrome.py` | `scripts/test-emoji-chrome-gate.py` |
| Terminology | `scripts/check-doc-terminology.py` | `scripts/test-terminology-gate.py` |
| Brand asset set (shape, palette, references, 16px legibility) | `scripts/check-brand-assets.py` | `scripts/test-brand-asset-gate.py` |

All run in both CI files; the two CI files must stay byte-identical (`cmp`).
