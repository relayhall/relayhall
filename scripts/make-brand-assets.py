#!/usr/bin/env python3
"""Produce the RelayHall brand asset set from the ratified selections.

RH-UI.3, spec RH-DESIGN.6 §3/D16, owner ruling `9aa295f2`:

  * the WORDMARK is **Cut A** — IBM Plex Sans SemiBold, tracking -6, hand-kerned,
    "Relay" in `--text-primary` and "Hall" in `--accent-color`;
  * the MONOGRAM is **one mark on two grounds** — Tile A (slate) for our own
    surfaces, Tile B (solid accent, mark knocked out in `--text-on-fill`) for the
    favicon, the apple-touch-icon and the org avatar — plus a mono counterpart.

Two properties this script exists to guarantee, both of which the gate
(`scripts/check-brand-assets.py`) then proves independently:

1. **The letterforms are real.** Every glyph outline is pulled from the same IBM
   Plex woff2 the product ships and serves. Nothing here is traced or redrawn,
   which is why the wordmark is generated rather than drawn (owner ruling
   `8457f369` §2: image models mangle letterforms).
2. **The colours are the palette's, not a designer's memory of it.** The ink,
   accent and ground values are PARSED OUT OF `frontend/src/styles/variables.css`
   at generation time, resolving `var()` indirection down to the primitive ramp.
   A palette change therefore cannot leave the brand assets behind; the gate
   fails if a committed asset carries a colour the stylesheet no longer declares.

Generation needs fontTools (outlines), cairosvg (raster) and Pillow (ICO). The
GATE needs none of them — it is stdlib-only, because it runs in CI. Run this
when the palette or the selection changes:

    python3 scripts/make-brand-assets.py

then run the gate and commit both the assets and any baseline change.
"""
from __future__ import annotations

import pathlib
import re
import struct
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
FONT_DIR = ROOT / "frontend" / "src" / "assets" / "fonts"
VARIABLES_CSS = ROOT / "frontend" / "src" / "styles" / "variables.css"
PUBLIC = ROOT / "frontend" / "public"
BRAND_PUBLIC = PUBLIC / "brand"
BRAND_PACKAGE = ROOT / "docs" / "brand"
PATHS_MODULE = ROOT / "frontend" / "src" / "brand" / "wordmarkPaths.ts"

WORD = "RelayHall"
SPLIT = 5                  # "Relay" | "Hall" — where the ink becomes accent
TRACKING = -6              # Cut A, in font units (1000/em)
FACE = "SemiBold"

# Hand kerning, in font units. Plex's own pairs are conservative for body text;
# a wordmark is set optically at display size.
KERN = {"Re": -8, "el": 0, "la": -6, "ay": -14, "yH": -22, "Ha": -10, "al": 0, "ll": 0}

# The monogram pair is set tighter still: a monogram is a lockup, not two
# letters standing near each other.
RH_TRACK = -46

# The tokens the assets are allowed to use, in the Theme they are authored for.
# `relay-dark` is the default Theme and the one the static assets bake, because
# a favicon cannot follow `data-theme` (E-M3: the mechanism is per-Theme, the
# bytes are not).
AUTHORING_THEME = "relay-dark"
REQUIRED_TOKENS = ("--text-primary", "--accent-color", "--bg-surface", "--text-on-fill",
                   "--bg-app")

# The three built-in Themes bind genuinely different accents (teal-500 / teal-700
# / teal-300) and different on-fill inks, so the favicon-variant mechanism
# RH-UI.2 shipped is only meaningful if the variants actually differ. Spec §5.5
# says so directly: "the favicon variant follows the active Theme (mechanism
# owned by UI.2; static assets by UI.3)". `relay-dark`'s variant is written to
# the fixed name `favicon.svg` because index.html must reference SOMETHING before
# any script runs, and the default Theme is the honest thing to show then.
THEME_FAVICON_FILES = {
    "relay-dark": "favicon.svg",
    "relay-light": "favicon-relay-light.svg",
    "high-contrast": "favicon-high-contrast.svg",
}


# --------------------------------------------------------------------------
# Palette, read from the stylesheet so the assets cannot drift off-token
# --------------------------------------------------------------------------

def _declaration_blocks(css: str) -> list[tuple[str, str]]:
    """(selector-text, body) for every top-level rule, comments stripped."""
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    blocks, depth, start, selector_start = [], 0, 0, 0
    for index, character in enumerate(css):
        if character == "{":
            if depth == 0:
                selector = css[selector_start:index].strip()
                start = index + 1
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                blocks.append((selector, css[start:index]))
                selector_start = index + 1
    return blocks


def load_palette(theme: str = AUTHORING_THEME) -> dict[str, str]:
    """Resolve the semantic tokens this asset set needs to literal hex.

    Follows `var(--x)` indirection into the primitive ramps, which is the whole
    point: the brand assets bake the same bytes the running product paints.
    """
    css = VARIABLES_CSS.read_text(encoding="utf-8")
    declarations: dict[str, str] = {}
    for selector, body in _declaration_blocks(css):
        applies = ":root" in selector or f'[data-theme="{theme}"]' in selector
        if theme == AUTHORING_THEME and "html:not([data-theme])" in selector:
            applies = True
        if not applies:
            continue
        for name, value in re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", body):
            declarations[name] = value.strip()

    def resolve(name: str, seen: frozenset[str] = frozenset()) -> str:
        if name in seen:
            raise SystemExit(f"palette: circular reference at {name}")
        if name not in declarations:
            raise SystemExit(f"palette: {name} is not declared for theme {theme}")
        value = declarations[name]
        reference = re.fullmatch(r"var\(\s*(--[\w-]+)\s*\)", value)
        if reference:
            return resolve(reference.group(1), seen | {name})
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
            raise SystemExit(
                f"palette: {name} resolves to {value!r}, which is not a plain hex colour. "
                "Brand assets bake bytes; they cannot carry an alpha or a gradient."
            )
        return value.lower()

    return {token: resolve(token) for token in REQUIRED_TOKENS}


# --------------------------------------------------------------------------
# Letterforms, taken from the shipped woff2
# --------------------------------------------------------------------------

def _pens():
    from fontTools.ttLib import TTFont
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.pens.transformPen import TransformPen
    from fontTools.pens.boundsPen import BoundsPen
    from fontTools.misc.transform import Transform
    return TTFont, SVGPathPen, TransformPen, BoundsPen, Transform


def glyph_run(characters: str, tracking: int, kern: dict[str, int]):
    """SVG path data for `characters`, laid out on one baseline.

    Returns (paths, advance_width, ink_top, ink_bottom). The extents are MEASURED
    rather than assumed from cap height: `y` descends below the baseline, and a
    viewBox derived from cap height alone crops its tail — a defect caught in the
    draft round by rendering the thing and looking at it.
    """
    TTFont, SVGPathPen, TransformPen, BoundsPen, Transform = _pens()
    font = TTFont(FONT_DIR / f"IBMPlexSans-{FACE}.woff2")
    cmap, glyphs, hmtx = font.getBestCmap(), font.getGlyphSet(), font["hmtx"]
    x, out, top, bottom = 0.0, [], 0.0, 0.0
    for index, character in enumerate(characters):
        name = cmap[ord(character)]
        pen = SVGPathPen(glyphs, ntos=lambda v: f"{v:.1f}")
        # y-flip: font space is y-up, SVG is y-down.
        glyphs[name].draw(TransformPen(pen, Transform(1, 0, 0, -1, x, 0)))
        out.append((character, pen.getCommands()))
        bounds = BoundsPen(glyphs)
        glyphs[name].draw(bounds)
        if bounds.bounds:
            _, y_min, _, y_max = bounds.bounds
            top, bottom = max(top, y_max), min(bottom, y_min)
        advance = hmtx[name][0] + tracking
        if index + 1 < len(characters):
            advance += kern.get(characters[index:index + 2], 0)
        x += advance
    return out, x - tracking, top, bottom


# --------------------------------------------------------------------------
# The assets
# --------------------------------------------------------------------------

GENERATED_BY = "scripts/make-brand-assets.py"


def wordmark_svg(ink: str, accent: str, note: str) -> str:
    paths, width, top, bottom = glyph_run(WORD, TRACKING, KERN)
    pad = 60
    body = "\n".join(
        f'    <path fill="{accent if index >= SPLIT else ink}" d="{d}"/>'
        for index, (_, d) in enumerate(paths)
    )
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 {-top - pad:.0f} {width + pad * 2:.0f} {(top - bottom) + pad * 2:.0f}"
     role="img" aria-label="RelayHall">
  <title>RelayHall</title>
  <desc>{note} Generated by {GENERATED_BY}; do not hand-edit.</desc>
  <g transform="translate({pad},0)">
{body}
  </g>
</svg>
'''


def monogram_svg(r_colour: str, h_colour: str, ground: str, note: str) -> str:
    paths, width, top, _ = glyph_run("RH", RH_TRACK, {})
    size, radius = 1000.0, 220.0
    # Optical fill: cap height at 46% of the tile, centred on the cap box rather
    # than the em box, so the mark sits where the eye expects it.
    scale = (size * 0.46) / top
    mark_w, mark_h = width * scale, top * scale
    tx, ty = (size - mark_w) / 2, (size + mark_h) / 2
    body = "\n".join(
        f'    <path fill="{r_colour if character == "R" else h_colour}" d="{d}"/>'
        for character, d in paths
    )
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"
     role="img" aria-label="RelayHall">
  <title>RelayHall</title>
  <desc>{note} Generated by {GENERATED_BY}; do not hand-edit.</desc>
  <rect width="1000" height="1000" rx="{radius:.0f}" fill="{ground}"/>
  <g transform="translate({tx:.1f},{ty:.1f}) scale({scale:.4f})">
{body}
  </g>
</svg>
'''


def social_card_svg(ink: str, accent: str, ground: str, on_fill: str) -> str:
    """1280x640 template: a horizontal lockup, a rule, and an empty copy band.

    A template, not a poster — RH-PUB.B1 fills the copy band when the public
    package is assembled. Nothing is published by committing it.

    The layout is computed from MEASURED ink extents rather than nominal cap
    height. The first cut stacked the tile above the wordmark using the em box,
    and the 'R' climbed into the tile's corner; caught by rendering the card and
    looking at it, which is the fourth time on this wave that looking beat
    reading.
    """
    MARGIN, TILE, GAP = 96.0, 128.0, 40.0
    paths, width, top, bottom = glyph_run(WORD, TRACKING, KERN)
    scale = 420.0 / width                       # wordmark spans 420px of the card
    body = "\n".join(
        f'      <path fill="{accent if index >= SPLIT else ink}" d="{d}"/>'
        for index, (_, d) in enumerate(paths)
    )

    tile_paths, tile_width, tile_top, _ = glyph_run("RH", RH_TRACK, {})
    tile_scale = (TILE * 0.46) / tile_top
    tile_body = "\n".join(
        f'      <path fill="{on_fill}" d="{d}"/>' for _, d in tile_paths
    )
    tile_x, tile_y = MARGIN, MARGIN + 48.0
    tile_tx = tile_x + (TILE - tile_width * tile_scale) / 2
    tile_ty = tile_y + (TILE + tile_top * tile_scale) / 2

    # Optical centring: align the wordmark's CAP box on the tile's centre line,
    # not its full ink box — the `y` descender would drag the word visibly low.
    word_x = tile_x + TILE + GAP
    word_baseline = tile_y + TILE / 2 + (top * scale) / 2
    rule_y = tile_y + TILE + 72.0

    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 640" width="1280" height="640"
     role="img" aria-label="RelayHall">
  <title>RelayHall</title>
  <desc>Social-card template, 1280x640: the horizontal lockup over an empty copy band. The band is
  empty by design — RH-PUB.B1 fills it when the public package is assembled. Generated by
  {GENERATED_BY}; do not hand-edit.</desc>
  <rect width="1280" height="640" fill="{ground}"/>
  <rect x="{tile_x:.0f}" y="{tile_y:.0f}" width="{TILE:.0f}" height="{TILE:.0f}" rx="28" fill="{accent}"/>
  <g transform="translate({tile_tx:.1f},{tile_ty:.1f}) scale({tile_scale:.4f})">
{tile_body}
  </g>
  <g transform="translate({word_x:.1f},{word_baseline:.1f}) scale({scale:.4f})">
{body}
  </g>
  <rect x="{MARGIN:.0f}" y="{rule_y:.0f}" width="240" height="4" fill="{accent}"/>
  <!-- Copy band: x {MARGIN:.0f}..1184, y {rule_y + 48:.0f}..544. Left empty on purpose. -->
</svg>
'''


# --------------------------------------------------------------------------
# Raster derivation (Tile B is the raster source — owner ruling 9aa295f2)
# --------------------------------------------------------------------------

PNG_SIZES = (16, 32, 64)
ICO_SIZES = (16, 32, 64)
APPLE_TOUCH = 180
ORG_AVATAR = 512


def _rasterise_sized(svg: str, width: int, height: int) -> bytes:
    import cairosvg
    return cairosvg.svg2png(bytestring=svg.encode("utf-8"),
                            output_width=width, output_height=height)


def rasterise(svg: str, size: int) -> bytes:
    return _rasterise_sized(svg, size, size)


def write_ico(target: pathlib.Path, svg: str) -> None:
    """Assemble the ICO by hand from per-size renders.

    Pillow's `save(format="ICO", sizes=…)` RESAMPLES the single image it is
    called on, so the earlier version built three renders and then silently
    threw two away — the 16 and 32 members were downscaled from the 64, and
    resampling invented intermediate colours that sit off the brand palette.
    The gate's new ICO pixel inspection is what surfaced it (review 9cbad6a0).

    An ICO is a directory of embedded images, so writing it directly is both
    simpler and exact: each member is byte-identical to the standalone PNG of
    the same size, which is the property that makes them provably consistent.
    """
    payloads = [rasterise(svg, size) for size in ICO_SIZES]
    header = struct.pack("<HHH", 0, 1, len(payloads))
    offset = 6 + 16 * len(payloads)
    entries, blob = [], b""
    for size, payload in zip(ICO_SIZES, payloads):
        entries.append(struct.pack(
            "<BBBBHHII",
            size if size < 256 else 0, size if size < 256 else 0,
            0, 0, 1, 32, len(payload), offset))
        offset += len(payload)
        blob += payload
    target.write_bytes(header + b"".join(entries) + blob)


def write_png(target: pathlib.Path, svg: str, size: int) -> None:
    target.write_bytes(rasterise(svg, size))


# --------------------------------------------------------------------------
# The generated path module the in-app component renders
# --------------------------------------------------------------------------

def wordmark_paths_ts() -> str:
    paths, width, top, bottom = glyph_run(WORD, TRACKING, KERN)
    pad = 60
    entries = "\n".join(
        f"  {{ role: '{'accent' if index >= SPLIT else 'ink'}', d: '{d}' }},"
        for index, (_, d) in enumerate(paths)
    )
    return f'''/* GENERATED FILE — do not hand-edit.
 *
 * Source: {GENERATED_BY} (RH-UI.3, owner ruling 9aa295f2 — wordmark Cut A).
 * Outlines are the genuine IBM Plex Sans {FACE} glyphs from the woff2 this
 * product already ships, laid out with tracking {TRACKING} and hand kerning.
 *
 * The paths live here rather than in an .svg file because the IN-APP wordmark
 * must follow the active Theme: `Relay` paints `--text-primary` and `Hall`
 * paints `--accent-color`, which an <img> can never resolve. The standalone
 * .svg assets under frontend/public/brand bake the relay-dark values for the
 * contexts that need a file (README, org avatar, social card).
 */

export interface WordmarkPath {{
  /** Which semantic token paints this glyph. */
  role: 'ink' | 'accent';
  d: string;
}}

/** viewBox of the laid-out word, in font units. */
export const WORDMARK_VIEW_BOX = '0 {-top - pad:.0f} {width + pad * 2:.0f} {(top - bottom) + pad * 2:.0f}';

/** Horizontal padding already folded into the viewBox. */
export const WORDMARK_PAD = {pad};

/**
 * How much of the rendered height sits BELOW the baseline (the `y` descender
 * plus padding), as a fraction.
 *
 * Needed because an inline mark has to sit on the same baseline as the words
 * beside it. Centring the SVG's box instead centres the descender space too and
 * lifts the letterforms visibly off the line — which is exactly how the first
 * cut of the login attribution shipped, and what looking at it caught.
 */
export const WORDMARK_DESCENDER_FRACTION = {(-bottom + pad) / ((top - bottom) + pad * 2):.6f};

export const WORDMARK_PATHS: readonly WordmarkPath[] = [
{entries}
];
'''


# --------------------------------------------------------------------------

def main() -> int:
    palette = load_palette()
    ink = palette["--text-primary"]
    accent = palette["--accent-color"]
    ground = palette["--bg-surface"]
    on_fill = palette["--text-on-fill"]

    BRAND_PUBLIC.mkdir(parents=True, exist_ok=True)
    BRAND_PACKAGE.mkdir(parents=True, exist_ok=True)
    PATHS_MODULE.parent.mkdir(parents=True, exist_ok=True)

    written: list[pathlib.Path] = []

    def write(path: pathlib.Path, text: str) -> None:
        path.write_text(text, encoding="utf-8")
        written.append(path)

    write(BRAND_PUBLIC / "wordmark.svg", wordmark_svg(
        ink, accent,
        "Wordmark, Cut A: IBM Plex Sans SemiBold, tracking -6, hand-kerned. "
        "'Relay' in the primary ink, 'Hall' in the teal accent."))
    write(BRAND_PUBLIC / "wordmark-mono.svg", wordmark_svg(
        ink, ink,
        "Wordmark, Cut A, monochrome counterpart — one ink, for single-colour print "
        "and anywhere the accent cannot be trusted to reproduce."))

    tile_a = monogram_svg(
        ink, accent, ground,
        "Monogram, Tile A: slate ground, R in the primary ink and H in the teal accent. "
        "The in-app binding — the mark wherever it sits on our own surface.")
    tile_b = monogram_svg(
        on_fill, on_fill, accent,
        "Monogram, Tile B: solid teal ground with the mark knocked out in the on-fill ink. "
        "The favicon, apple-touch-icon and org-avatar binding — Tile A's slate ground "
        "disappears into dark browser chrome at 16px.")
    write(BRAND_PUBLIC / "monogram-tile-a-slate.svg", tile_a)
    write(BRAND_PUBLIC / "monogram-tile-b-accent.svg", tile_b)
    write(BRAND_PUBLIC / "monogram-mono.svg", monogram_svg(
        ink, ink, ground,
        "Monogram, monochrome counterpart — one ink on the slate ground."))

    # The favicon IS Tile B, cut once per Theme. The rasters below are NOT
    # per-Theme: an .ico and a .png are handed to surfaces that never learn which
    # Theme is active (a bookmark bar, a pinned tile, a browser that ignores SVG
    # icons), so they bake the default Theme and say so.
    for theme, filename in THEME_FAVICON_FILES.items():
        theme_palette = load_palette(theme)
        write(PUBLIC / filename, monogram_svg(
            theme_palette["--text-on-fill"], theme_palette["--text-on-fill"],
            theme_palette["--accent-color"],
            f"Favicon, Tile B cut for the {theme} Theme: that Theme's accent as the ground with the "
            f"mark knocked out in its on-fill ink. Selected at runtime by THEME_FAVICONS."))
    for size in PNG_SIZES:
        write_png(PUBLIC / f"favicon-{size}.png", tile_b, size)
        written.append(PUBLIC / f"favicon-{size}.png")
    write_ico(PUBLIC / "favicon.ico", tile_b)
    written.append(PUBLIC / "favicon.ico")
    write_png(PUBLIC / "apple-touch-icon.png", tile_b, APPLE_TOUCH)
    written.append(PUBLIC / "apple-touch-icon.png")

    write_png(BRAND_PACKAGE / "org-avatar-512.png", tile_b, ORG_AVATAR)
    written.append(BRAND_PACKAGE / "org-avatar-512.png")

    # The card sits on the app background — the same ground a visitor sees when
    # they follow the link, so the card and the product do not disagree.
    card = social_card_svg(ink, accent, palette["--bg-app"], on_fill)
    write(BRAND_PACKAGE / "social-card.svg", card)
    (BRAND_PACKAGE / "social-card.png").write_bytes(
        _rasterise_sized(card, 1280, 640))
    written.append(BRAND_PACKAGE / "social-card.png")

    write(PATHS_MODULE, wordmark_paths_ts())

    for path in written:
        print("wrote", path.relative_to(ROOT))
    print(f"\npalette ({AUTHORING_THEME}): ink {ink} · accent {accent} · "
          f"ground {ground} · on-fill {on_fill}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
