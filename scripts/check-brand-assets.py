#!/usr/bin/env python3
"""Brand-asset gate (RH-UI.3, spec RH-DESIGN.6 §3/D16, owner ruling 9aa295f2).

The asset set is GENERATED (scripts/make-brand-assets.py) from real IBM Plex
outlines and from the palette declared in the stylesheet. This gate proves the
committed bytes still satisfy the properties that generation was supposed to
give them — without needing the generator's dependencies, because it runs in CI
against a stock `python3` with no pip step:

  1. **Completeness and shape.** Every declared asset exists, at exactly its
     declared geometry and format: PNG dimensions read from the IHDR chunk, ICO
     member sizes from the icon directory, and each SVG's viewBox compared
     against the value declared in `SVG_VIEW_BOXES`. An SVG with no declared
     geometry is itself a failure, so a new asset cannot slip in unchecked.
  2. **The retired marks stay dead, three ways.** By basename; by the spiral's own
     gradient stops (renaming a file is not deleting it); and by CONTENT HASH of
     the exact retired bytes. On top of that the brand directories are a CLOSED
     SET, **subdirectories included** — an undeclared image may not sit anywhere
     beneath them, which is what makes the rule hold for rasters, whose artwork
     no signature can recognise in general. Review `566efa25` defeated the first
     cut by restoring the spiral as a PNG under a new basename, and review
     `ce0c9d3c` then found the sweep was not recursive; both are self-proof cases
     now.
  3. **Palette conformance, in the source AND in the pixels.** Every colour
     literal in every brand SVG must be a value `variables.css` declares for that
     asset's Theme, and every committed RASTER is decoded and checked too —
     including every member payload inside the ICO. The first cut inspected SVG
     text only, so a solid magenta PNG passed while the gate printed "palette
     conformant"; the second still skipped the ICO members.

     Rasters are measured against the SEGMENTS between palette colours, because
     antialiasing puts edge pixels on the line between the two they blend: the
     committed icons score a worst case of 1.4 against a tolerance of 12, while
     an off-palette fill scores in the hundreds.

     A coverage assertion fails the gate if any declared RASTER was never
     inspected, so a raster kind nobody wired up cannot be silently certified.
     That ledger covers the raster checks ONLY — the SVG, closed-directory and
     retired-mark sweeps report the count of files they walked instead of
     asserting a general property. Extending the ledger to those families is a
     real improvement, written up in report 55c88697; what must not happen is
     this docstring promising it first.

  4. **Reference integrity.** Every icon `frontend/index.html` links, and every
     file `THEME_FAVICONS` names, exists on disk — and the map covers exactly the
     three built-in Themes. A favicon reference that 404s degrades to a blank tab
     and no test in the tree would otherwise notice.
  5. **Legibility at 16px, from pixels — contrast, area AND structure.** The icons are
     decoded here (stdlib zlib + an unfilter loop — no Pillow). Ground-to-ink
     contrast is measured with the same WCAG relative-luminance maths the contrast
     gate uses, and the mark must also COVER at least 6% of the tile. Its largest
     8-connected component must cover at least 4% of the tile and fill at least
     30% of its bounding box, so scattered pixels and a hollow perimeter cannot
     masquerade as a coherent mark. Review
     defeated a contrast-only check with a tile carrying a single contrasting
     pixel. Spec §13 makes "favicon legible at 16px (pixel evidence)" a success
     criterion, and the draft round produced a tile that passed every automated
     check while collapsing into a smudge at the only size that mattered.
     Asserted, not eyeballed.
  6. **The in-app wordmark stays token-bound.** The generated path module must
     carry no colour literal at all: `Relay` paints `--text-primary` and `Hall`
     paints `--accent-color` at runtime, which is the whole reason the paths live
     in a module instead of an <img>.

Self-proved by scripts/test-brand-asset-gate.py.
"""
from __future__ import annotations

import argparse
import hashlib
import re
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "frontend" / "public"
BRAND_PUBLIC = PUBLIC / "brand"
BRAND_PACKAGE = ROOT / "docs" / "brand"
VARIABLES_CSS = ROOT / "frontend" / "src" / "styles" / "variables.css"
INDEX_HTML = ROOT / "frontend" / "index.html"
THEME_TS = ROOT / "frontend" / "src" / "utils" / "theme.ts"
PATHS_MODULE = ROOT / "frontend" / "src" / "brand" / "wordmarkPaths.ts"

BUILT_IN_THEMES = ("relay-dark", "relay-light", "high-contrast")

# The only semantic tokens a brand asset may paint from — the same set the
# generator resolves. Widening this list is a design decision, not a fix.
BRAND_TOKENS = ("--text-primary", "--accent-color", "--bg-surface", "--text-on-fill",
                "--bg-app")

# Which Theme's palette each asset is authored against. The rasters and the
# package assets bake the default Theme: an .ico handed to a bookmark bar never
# learns which Theme is active.
SVG_ASSETS = {
    "frontend/public/brand/wordmark.svg": "relay-dark",
    "frontend/public/brand/wordmark-mono.svg": "relay-dark",
    "frontend/public/brand/monogram-tile-a-slate.svg": "relay-dark",
    "frontend/public/brand/monogram-tile-b-accent.svg": "relay-dark",
    "frontend/public/brand/monogram-mono.svg": "relay-dark",
    "frontend/public/favicon.svg": "relay-dark",
    "frontend/public/favicon-relay-light.svg": "relay-light",
    "frontend/public/favicon-high-contrast.svg": "high-contrast",
    "docs/brand/social-card.svg": "relay-dark",
    # RH-PUB.B1: the architecture diagram the public README shows, one file
    # per light/dark Theme so a <picture> follows the reader's own setting.
    "docs/brand/architecture.svg": "relay-dark",
    "docs/brand/architecture-light.svg": "relay-light",
}

# The viewBox each SVG must declare, in generator units.
#
# Review 0da307c5 found the docstring promising that SVG geometry came from the
# viewBox while the code only checked the SUBSTRING "viewBox" was present — so
# any geometry satisfied it. Rather than narrow the sentence a fifth time, the
# geometry is declared here and compared, which is what the sentence always
# said. It couples the gate to the generator's metrics deliberately: if a
# tracking or tile change moves these numbers, the gate should notice and the
# author should re-run the generator and update this table on purpose.
SVG_VIEW_BOXES = {
    "frontend/public/brand/wordmark.svg": "0 -800 4477 1060",
    "frontend/public/brand/wordmark-mono.svg": "0 -800 4477 1060",
    "frontend/public/brand/monogram-tile-a-slate.svg": "0 0 1000 1000",
    "frontend/public/brand/monogram-tile-b-accent.svg": "0 0 1000 1000",
    "frontend/public/brand/monogram-mono.svg": "0 0 1000 1000",
    "frontend/public/favicon.svg": "0 0 1000 1000",
    "frontend/public/favicon-relay-light.svg": "0 0 1000 1000",
    "frontend/public/favicon-high-contrast.svg": "0 0 1000 1000",
    "docs/brand/social-card.svg": "0 0 1280 640",
    "docs/brand/architecture.svg": "0 0 1280 848",
    "docs/brand/architecture-light.svg": "0 0 1280 848",
}

# path -> (width, height). Every raster bakes the DEFAULT Theme: an .ico handed
# to a bookmark bar never learns which Theme is active.
PNG_ASSETS = {
    "frontend/public/favicon-16.png": (16, 16),
    "frontend/public/favicon-32.png": (32, 32),
    "frontend/public/favicon-64.png": (64, 64),
    "frontend/public/apple-touch-icon.png": (180, 180),
    "docs/brand/org-avatar-512.png": (512, 512),
    "docs/brand/social-card.png": (1280, 640),
}
RASTER_THEME = "relay-dark"

# Directories that may contain brand imagery, and nothing else. Enforcing a
# CLOSED SET is what makes "the retired mark stays dead" true for rasters: a
# spiral cannot be smuggled back as a PNG under a new basename if no undeclared
# image may sit here at all. Review of RH-UI.3 reproduced exactly that evasion.
CLOSED_IMAGE_DIRECTORIES = ("frontend/public", "frontend/public/brand", "docs/brand")
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".ico", ".bmp", ".avif"}
# Build output and dependencies are not authored assets; everything else under a
# closed directory is in scope at any depth.
EXCLUDED_TREE_PARTS = {".git", "node_modules", "dist", "coverage"}

# The retired marks, by content. Filename-blocking alone was shown to be
# defeatable by `cp`; these are the exact bytes as they stood at 9b3f963.
# Honest limit, stated rather than implied: this catches the file being restored,
# NOT a re-encoding of the same artwork. The closed-set rule above is what covers
# that case, and the palette rule below catches off-palette artwork wherever it
# lands.
RETIRED_CONTENT_HASHES = {
    "2c61677516ded5cc4f3959bbbb3bf1f56fe0f9f969149511bfb9b0f36dfb8c27":
        "the retired spiral raster (frontend/public/favicon.png and nim-favicon.png at 9b3f963)",
    "7092610a123ab5608ee9f8e3cff975d13ef8ff76bb36c4bde05b4a787a4c7cc8":
        "the retired spiral SVG (frontend/public/favicon.svg and nim-favicon.svg at 9b3f963)",
}

# Antialiasing puts edge pixels ON the line between two palette colours, so
# conformance is measured as distance to the nearest SEGMENT between brand
# colours rather than to the nearest colour. Measured worst case across every
# committed raster is 1.4; the tolerance is 12, which is eight times the
# observed maximum and still hundreds away from an off-palette fill.
RASTER_SEGMENT_TOLERANCE = 12.0
# The distance tolerance already admits generated antialiasing (measured maximum
# 1.4 against 12). Once that tolerance has been applied there is no honest reason
# to permit an additional 0.5% of arbitrary pixels: at 512px that was over a
# thousand opaque outliers. Every remaining pixel must conform.
RASTER_CONFORMANCE_FLOOR = 1.0

# The mark has to actually cover some of the tile. Measured coverage across the
# committed icons is 17-23%; the floor is 6%, so a one-pixel "mark" (0.4% at
# 16px) fails with room to spare.
#
# There is deliberately NO ceiling. A first cut had one at 70%, and writing its
# self-proof showed it could never fire: coverage is the share of pixels NOT in
# the dominant colour, so it is at most 50% by construction. A rule that cannot
# fail is not a rule, and leaving it in would have been a gate claiming a
# guarantee it does not provide — the exact fault this whole revision repairs.
MIN_MARK_COVERAGE = 0.06

# Aggregate area alone is not recognisability: 16 isolated pixels clear the 6%
# floor at 16px. The selected assets have a largest 8-connected mark component
# covering 8.9–10.9% of the tile, with 56–65% bounding-box fill. These floors
# retain wide generator headroom while rejecting scattered pixels, diagonal
# one-pixel snakes and thin hollow rings.
MIN_CONNECTED_MARK_COVERAGE = 0.04
MIN_MARK_BOX_FILL = 0.30

ICO_ASSETS = {"frontend/public/favicon.ico": (16, 32, 64)}

# The favicon-variant map RH-UI.2 shipped the mechanism for; UI.3 supplies the
# files. Kept here as well as in the generator so the gate has an independent
# statement to check the TypeScript against.
THEME_FAVICON_FILES = {
    "relay-dark": "favicon.svg",
    "relay-light": "favicon-relay-light.svg",
    "high-contrast": "favicon-high-contrast.svg",
}

# Deleted by RH-UI.3, and they stay deleted.
RETIRED_BASENAMES = {"nim-favicon.svg", "nim-favicon.png", "favicon.png"}
# The spiral, identified by its own gradient rather than by its filename.
SPIRAL_SIGNATURE = ("#7c3aed", "#6366f1")

# The 16px favicon must clear the WCAG UI-component threshold between its ground
# and its ink. 3:1 is the §4.5 matrix's non-text class: a favicon is a graphical
# object, not body copy.
MIN_FAVICON_CONTRAST = 3.0

LEGIBILITY_TARGET = "frontend/public/favicon-16.png"

HEX = re.compile(r"#[0-9a-fA-F]{6}\b")


# --------------------------------------------------------------------------
# Palette (the same resolution the generator does, re-implemented in stdlib)
# --------------------------------------------------------------------------

def _blocks(css: str):
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    depth, start, selector_start = 0, 0, 0
    for index, character in enumerate(css):
        if character == "{":
            if depth == 0:
                selector, start = css[selector_start:index].strip(), index + 1
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                yield selector, css[start:index]
                selector_start = index + 1


def theme_colours(theme: str) -> set[str]:
    """The values of the BRAND tokens under `theme` — nothing wider.

    Deliberately not "every literal the stylesheet can resolve to". The first
    cut of this check did exactly that, and the self-proof caught it: because the
    primitive ramps are declared on `:root` they apply under every Theme, so the
    light favicon could carry a dark-Theme grey and still pass. The allowed set is
    the resolved value of each token in BRAND_TOKENS and nothing else, which is
    also the honest statement of the rule — a brand asset paints from the brand's
    semantic tokens, not from anywhere in the palette.
    """
    css = VARIABLES_CSS.read_text(encoding="utf-8")
    declarations: dict[str, str] = {}
    for selector, body in _blocks(css):
        applies = ":root" in selector or f'[data-theme="{theme}"]' in selector
        if theme == "relay-dark" and "html:not([data-theme])" in selector:
            applies = True
        if not applies:
            continue
        for name, value in re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", body):
            declarations[name] = value.strip()

    resolved: set[str] = set()
    for token in BRAND_TOKENS:
        value = declarations.get(token, "")
        seen = 0
        while (reference := re.fullmatch(r"var\(\s*(--[\w-]+)\s*\)", value)) and seen < 12:
            value = declarations.get(reference.group(1), "")
            seen += 1
        if re.fullmatch(r"#[0-9a-fA-F]{6}", value):
            resolved.add(value.lower())
    return resolved


# --------------------------------------------------------------------------
# Binary readers — stdlib only, on purpose
# --------------------------------------------------------------------------

def png_header(data: bytes) -> tuple[int, int, int, int]:
    """(width, height, bit_depth, colour_type) from IHDR.

    Length is checked before unpacking: a truncated file must produce a failure
    MESSAGE naming the file, not a struct.error traceback out of the gate. A gate
    that crashes has not reported anything, and in CI reads as a broken gate
    rather than a broken asset.
    """
    if len(data) < 26 or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a readable PNG (too short, or wrong magic bytes)")
    width, height, depth, colour = struct.unpack(">IIBB", data[16:26])
    return width, height, depth, colour


def ico_sizes(data: bytes) -> list[int]:
    reserved, image_type, count = struct.unpack("<HHH", data[:6])
    if reserved != 0 or image_type != 1:
        raise ValueError("not an ICO")
    sizes = []
    for index in range(count):
        entry = data[6 + index * 16: 22 + index * 16]
        width = entry[0] or 256
        height = entry[1] or 256
        if width != height:
            raise ValueError(f"non-square ICO member {width}x{height}")
        sizes.append(width)
    return sorted(sizes)


def decode_png_rgba(data: bytes) -> tuple[int, int, list[tuple[int, int, int, int]]]:
    """Minimal PNG decoder: 8-bit, non-interlaced, RGB or RGBA.

    Written out rather than imported because this gate runs in CI with no pip
    step, and the property it proves — a favicon that is actually legible at the
    size browsers draw it — is worth sixty lines of unfiltering.
    """
    width, height, depth, colour = png_header(data)
    if depth != 8 or colour not in (2, 6):
        raise ValueError(f"unsupported PNG (depth {depth}, colour type {colour})")
    channels = 3 if colour == 2 else 4

    idat, offset = bytearray(), 8
    while offset < len(data):
        length, kind = struct.unpack(">I4s", data[offset:offset + 8])
        if kind == b"IDAT":
            idat += data[offset + 8: offset + 8 + length]
        elif kind == b"IEND":
            break
        offset += 12 + length

    raw = zlib.decompress(bytes(idat))
    stride = width * channels
    previous = bytearray(stride)
    pixels: list[tuple[int, int, int, int]] = []
    position = 0
    for _ in range(height):
        filter_type = raw[position]
        line = bytearray(raw[position + 1: position + 1 + stride])
        position += 1 + stride
        for index in range(stride):
            left = line[index - channels] if index >= channels else 0
            up = previous[index]
            up_left = previous[index - channels] if index >= channels else 0
            if filter_type == 0:
                value = line[index]
            elif filter_type == 1:
                value = line[index] + left
            elif filter_type == 2:
                value = line[index] + up
            elif filter_type == 3:
                value = line[index] + (left + up) // 2
            elif filter_type == 4:
                estimate = left + up - up_left
                distances = (abs(estimate - left), abs(estimate - up), abs(estimate - up_left))
                nearest = (left, up, up_left)[distances.index(min(distances))]
                value = line[index] + nearest
            else:
                raise ValueError(f"unknown PNG filter {filter_type}")
            line[index] = value & 0xFF
        for index in range(0, stride, channels):
            red, green, blue = line[index], line[index + 1], line[index + 2]
            alpha = line[index + 3] if channels == 4 else 255
            pixels.append((red, green, blue, alpha))
        previous = line
    return width, height, pixels


def relative_luminance(rgb: tuple[int, int, int]) -> float:
    channels = []
    for value in rgb:
        srgb = value / 255
        channels.append(srgb / 12.92 if srgb <= 0.04045 else ((srgb + 0.055) / 1.055) ** 2.4)
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]


def contrast_ratio(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    first, second = relative_luminance(a), relative_luminance(b)
    lighter, darker = max(first, second), min(first, second)
    return (lighter + 0.05) / (darker + 0.05)


# ---------------------------------------------------------------------------
# The inspection ledger.
#
# THREE CONSECUTIVE REVIEW ROUNDS found one class of defect in this gate: the
# success message asserting a guarantee the implementation had not performed.
# Round 1 — "brand directories closed" while walking only immediate children.
# Round 2 — "checked in raster pixels" while never decoding the ICO payloads.
# Round 3 — a comment here claiming EVERY check recorded to this ledger and that
# the whole success line was generated from it, when only the raster checks did.
#
# So this comment now states exactly what exists, and nothing more:
#
#   * THE RASTER CHECKS record what they inspected, by path — palette
#     conformance and mark coverage, and nothing else;
#   * a coverage assertion fails the gate if any declared raster (including
#     every ICO member) is absent from that record, so a raster kind nobody
#     wired up is a FAILURE rather than a silent omission;
#   * the RASTER COUNTS in the success line are read back from that record.
#
# The SVG, closed-directory and retired-mark sweeps are NOT ledgered. Their
# success text therefore reports the count of files each actually walked, rather
# than asserting a general property about them. Extending the ledger to those
# families is a real improvement and is written up as the alternative in report
# 55c88697; what must never happen again is prose here promising it before the
# code does it.
INSPECTED: dict[str, set[str]] = {}


def record(check: str, subject: str) -> None:
    INSPECTED.setdefault(check, set()).add(subject)


def ico_members(data: bytes) -> list[tuple[int, int, bytes]]:
    """(width, height, payload) for each ICO member."""
    _, _, count = struct.unpack("<HHH", data[:6])
    members = []
    for index in range(count):
        entry = data[6 + index * 16: 22 + index * 16]
        width = entry[0] or 256
        height = entry[1] or 256
        size, offset = struct.unpack("<II", entry[8:16])
        if offset + size > len(data):
            raise ValueError(f"ICO member {width}x{height} runs past the end of the file")
        members.append((width, height, data[offset:offset + size]))
    return members


def hex_to_rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def distance_to_segment(point, start, end) -> float:
    """Euclidean distance from an RGB point to the segment between two colours."""
    dx, dy, dz = end[0] - start[0], end[1] - start[1], end[2] - start[2]
    denominator = dx * dx + dy * dy + dz * dz
    if denominator == 0:
        t = 0.0
    else:
        t = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy
             + (point[2] - start[2]) * dz) / denominator
        t = max(0.0, min(1.0, t))
    near = (start[0] + t * dx, start[1] + t * dy, start[2] + t * dz)
    return ((point[0] - near[0]) ** 2 + (point[1] - near[1]) ** 2
            + (point[2] - near[2]) ** 2) ** 0.5


def raster_palette_report(pixels, palette) -> tuple[float, tuple[int, int, int], float]:
    """(conforming fraction, worst offender, its distance).

    A rasterised icon is not a flat pair of colours: antialiasing puts edge
    pixels ON THE LINE between the two it blends. So conformance is measured
    against the segments between palette colours, not against the colours
    themselves — which is why the committed icons score a worst case of 1.4
    while a solid off-palette fill scores in the hundreds.
    """
    pairs = [(a, b) for index, a in enumerate(palette) for b in palette[index:]]
    conforming = 0
    worst_colour, worst_distance = (0, 0, 0), 0.0
    seen: dict[tuple[int, int, int], float] = {}
    for pixel in pixels:
        distance = seen.get(pixel)
        if distance is None:
            distance = min(distance_to_segment(pixel, a, b) for a, b in pairs)
            seen[pixel] = distance
        if distance <= RASTER_SEGMENT_TOLERANCE:
            conforming += 1
        elif distance > worst_distance:
            worst_colour, worst_distance = pixel, distance
    total = len(pixels) or 1
    return conforming / total, worst_colour, worst_distance


def mark_shape_report(width, height, pixels, palette) -> tuple[float, float, float, int]:
    """(area, largest connected area, box fill, component count) for the mark.

    "Is there a second colour" was the first cut of this check, and review
    defeated it with a single contrasting pixel. Area is the property that
    matters first. A later review then defeated aggregate area with scattered
    pixels, so this also measures 8-connected structure without trying to
    recognise or execute a specific image format.
    """
    assignments: dict[int, tuple[int, int, int]] = {}
    counts: dict[tuple[int, int, int], int] = {}
    for index, (red, green, blue, alpha) in enumerate(pixels):
        if alpha <= 200:
            continue
        pixel = (red, green, blue)
        closest = min(palette, key=lambda c: sum((pixel[i] - c[i]) ** 2 for i in range(3)))
        assignments[index] = closest
        counts[closest] = counts.get(closest, 0) + 1
    if len(counts) < 2:
        return 0.0, 0.0, 0.0, 0

    ground = max(counts, key=counts.get)
    pending = {index for index, closest in assignments.items() if closest != ground}
    mark_pixels = len(pending)
    components: list[set[int]] = []
    while pending:
        seed = pending.pop()
        component = {seed}
        frontier = [seed]
        while frontier:
            current = frontier.pop()
            x, y = current % width, current // width
            for neighbour_y in range(max(0, y - 1), min(height, y + 2)):
                for neighbour_x in range(max(0, x - 1), min(width, x + 2)):
                    neighbour = neighbour_y * width + neighbour_x
                    if neighbour in pending:
                        pending.remove(neighbour)
                        component.add(neighbour)
                        frontier.append(neighbour)
        components.append(component)

    largest = max(components, key=len)
    xs = [index % width for index in largest]
    ys = [index // width for index in largest]
    box_area = (max(xs) - min(xs) + 1) * (max(ys) - min(ys) + 1)
    tile_area = width * height or 1
    return (mark_pixels / tile_area, len(largest) / tile_area,
            len(largest) / box_area, len(components))


# --------------------------------------------------------------------------

def main() -> int:
    global ROOT, PUBLIC, BRAND_PUBLIC, BRAND_PACKAGE, VARIABLES_CSS, INDEX_HTML
    global THEME_TS, PATHS_MODULE

    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, default=None,
                        help="tree to check (the self-test points this at a copy)")
    arguments = parser.parse_args()

    ROOT = (arguments.root or ROOT).resolve()
    PUBLIC = ROOT / "frontend" / "public"
    BRAND_PUBLIC = PUBLIC / "brand"
    BRAND_PACKAGE = ROOT / "brand"
    VARIABLES_CSS = ROOT / "frontend" / "src" / "styles" / "variables.css"
    INDEX_HTML = ROOT / "frontend" / "index.html"
    THEME_TS = ROOT / "frontend" / "src" / "utils" / "theme.ts"
    PATHS_MODULE = ROOT / "frontend" / "src" / "brand" / "wordmarkPaths.ts"

    failures: list[str] = []

    def fail(message: str) -> None:
        failures.append(message)

    # 1. Completeness and shape --------------------------------------------
    for relative, theme in SVG_ASSETS.items():
        path = ROOT / relative
        if not path.exists():
            fail(f"missing brand asset: {relative}")
            continue
        text = path.read_text(encoding="utf-8")
        declared = SVG_VIEW_BOXES.get(relative)
        found = re.search(r'viewBox="([^"]+)"', text)
        if not found:
            fail(f"{relative}: no viewBox — the asset cannot scale")
        elif declared is None:
            fail(f"{relative}: no declared viewBox in SVG_VIEW_BOXES. Every declared SVG needs "
                 "its geometry stated, or the completeness check silently skips it.")
        elif " ".join(found.group(1).split()) != declared:
            fail(f"{relative}: viewBox is {found.group(1)!r}, declared {declared!r}. "
                 "Regenerate with scripts/make-brand-assets.py rather than hand-editing, and "
                 "update the declaration deliberately if the generator's metrics changed.")
        if "<title>RelayHall</title>" not in text:
            fail(f"{relative}: no accessible <title> naming the product")

    for relative, (want_width, want_height) in PNG_ASSETS.items():
        path = ROOT / relative
        if not path.exists():
            fail(f"missing brand asset: {relative}")
            continue
        try:
            width, height, _, _ = png_header(path.read_bytes())
        except ValueError as error:
            fail(f"{relative}: {error}")
            continue
        if (width, height) != (want_width, want_height):
            fail(f"{relative}: is {width}x{height}, declared {want_width}x{want_height}")

    for relative, want_sizes in ICO_ASSETS.items():
        path = ROOT / relative
        if not path.exists():
            fail(f"missing brand asset: {relative}")
            continue
        try:
            sizes = ico_sizes(path.read_bytes())
        except ValueError as error:
            fail(f"{relative}: {error}")
            continue
        if tuple(sizes) != tuple(sorted(want_sizes)):
            fail(f"{relative}: members {sizes}, declared {sorted(want_sizes)}")

    # 2. The retired marks stay dead, and the brand directories are CLOSED ---
    declared = set(SVG_ASSETS) | set(PNG_ASSETS) | set(ICO_ASSETS)
    seen_images: set[str] = set()
    for directory in CLOSED_IMAGE_DIRECTORIES:
        base = ROOT / directory
        if not base.is_dir():
            continue
        # RECURSIVE, not iterdir(). The first cut walked immediate children only
        # while the success line still said "brand directories closed", so an
        # image at frontend/public/uploads/anything.png passed unseen — review
        # ce0c9d3c reproduced exactly that. A closed set that stops at depth one
        # is not a closed set, and saying otherwise is the overclaim this whole
        # change exists to remove.
        for path in base.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in IMAGE_SUFFIXES:
                continue
            if set(path.parts) & EXCLUDED_TREE_PARTS:
                continue
            relative = path.relative_to(ROOT).as_posix()
            if relative in seen_images:
                continue                      # nested declared dirs overlap; report once
            seen_images.add(relative)
            if relative not in declared:
                fail(f"undeclared image {relative}: {directory} is a CLOSED set, subdirectories "
                     "included. Add it to the gate's declared assets deliberately, or delete it — "
                     "this is the rule that stops a retired mark returning as a raster under a "
                     "new name.")

    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        parts = set(path.parts)
        if parts & {".git", "node_modules", "dist", "coverage"}:
            continue
        if path.name in RETIRED_BASENAMES:
            fail(f"retired brand asset is back: {path.relative_to(ROOT)} "
                 "(deleted by RH-UI.3; the allowlist entry went with it)")
        if path.suffix.lower() in IMAGE_SUFFIXES:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest in RETIRED_CONTENT_HASHES:
                fail(f"{path.relative_to(ROOT)} IS {RETIRED_CONTENT_HASHES[digest]}, "
                     "restored under a different name. Renaming a deleted mark is not "
                     "deleting it.")
        if path.suffix == ".svg":
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            if all(stop in text for stop in SPIRAL_SIGNATURE):
                fail(f"the retired spiral mark is back at {path.relative_to(ROOT)} "
                     f"(matched by its own gradient stops {SPIRAL_SIGNATURE}, not by filename)")

    # 3. Palette conformance -----------------------------------------------
    palettes = {theme: theme_colours(theme) for theme in BUILT_IN_THEMES}
    svg_sources_inspected = 0
    for relative, theme in SVG_ASSETS.items():
        path = ROOT / relative
        if not path.exists():
            continue
        svg_sources_inspected += 1
        allowed = palettes[theme]
        for literal in {value.lower() for value in HEX.findall(path.read_text(encoding="utf-8"))}:
            if literal not in allowed:
                fail(f"{relative}: {literal} is not a colour the stylesheet declares for "
                     f"{theme}. Brand assets bake palette values; regenerate with "
                     "scripts/make-brand-assets.py rather than hand-editing the SVG.")

    # 3b. The same palette rule, applied to the PIXELS ----------------------
    # The first cut checked SVG TEXT only, so a solid magenta PNG passed while
    # the gate printed "palette conformant". Review reproduced it; this is the
    # repair, and the message below no longer claims more than was inspected.
    raster_palette = sorted(hex_to_rgb(value) for value in palettes[RASTER_THEME])

    def inspect_pixels(subject: str, payload: bytes) -> None:
        """Decode and palette-check one raster, recording that it was inspected."""
        try:
            _, _, decoded = decode_png_rgba(payload)
        except (ValueError, zlib.error) as error:
            fail(f"{subject}: cannot decode for palette inspection ({error})")
            return
        opaque = [(r, g, b) for r, g, b, a in decoded if a > 200]
        if not opaque:
            fail(f"{subject}: no opaque pixels at all")
            return
        share, worst, distance = raster_palette_report(opaque, raster_palette)
        if share < RASTER_CONFORMANCE_FLOOR:
            fail(f"{subject}: only {share * 100:.3f}% of opaque pixels lie within "
                 f"{RASTER_SEGMENT_TOLERANCE:.0f} of the {RASTER_THEME} brand palette "
                 f"(floor {RASTER_CONFORMANCE_FLOOR * 100:.1f}%). Worst offender rgb{worst} "
                 f"at distance {distance:.0f}. Brand rasters are generated from the palette; "
                 "regenerate with scripts/make-brand-assets.py rather than hand-editing.")
        record("raster palette", subject)

    for relative in PNG_ASSETS:
        path = ROOT / relative
        if not path.exists():
            continue
        inspect_pixels(relative, path.read_bytes())

    # ICO members carry their own encoded images. The directory entries were
    # checked above for declared sizes; these are the PIXELS behind them, which
    # round 2 found were never looked at while the message said otherwise.
    for relative in ICO_ASSETS:
        path = ROOT / relative
        if not path.exists():
            continue
        try:
            members = ico_members(path.read_bytes())
        except (ValueError, struct.error) as error:
            fail(f"{relative}: {error}")
            continue
        for width, height, payload in members:
            subject = f"{relative}#{width}x{height}"
            if payload[:8] != b"\x89PNG\r\n\x1a\n":
                # Refusing an un-decodable member beats skipping it: skipping is
                # exactly how an asset ends up uninspected while counted.
                fail(f"{subject}: member payload is not PNG-encoded, so its pixels cannot be "
                     "inspected. The generator writes PNG members; regenerate rather than "
                     "hand-assembling the ICO.")
                continue
            inspect_pixels(subject, payload)

    # 3c. The mark has to cover some of the tile -----------------------------
    for relative in ("frontend/public/favicon-16.png", "frontend/public/favicon-32.png",
                     "frontend/public/favicon-64.png", "frontend/public/apple-touch-icon.png"):
        path = ROOT / relative
        if not path.exists():
            continue
        try:
            width, height, decoded = decode_png_rgba(path.read_bytes())
        except (ValueError, zlib.error):
            continue  # already reported above
        if not any(alpha > 200 for _, _, _, alpha in decoded):
            continue
        coverage, connected, box_fill, components = mark_shape_report(
            width, height, decoded, raster_palette)
        record("mark coverage", relative)
        if coverage < MIN_MARK_COVERAGE:
            fail(f"{relative}: the mark covers {coverage * 100:.1f}% of the tile, below the "
                 f"{MIN_MARK_COVERAGE * 100:.0f}% floor. A tile with a few contrasting pixels "
                 "satisfies a 'there is a second colour' check and is still not a mark.")
        if connected < MIN_CONNECTED_MARK_COVERAGE:
            fail(f"{relative}: the largest connected mark component covers "
                 f"{connected * 100:.1f}% of the tile, below the "
                 f"{MIN_CONNECTED_MARK_COVERAGE * 100:.0f}% structural floor "
                 f"({components} component(s)). Aggregate area can be scattered pixels; "
                 "regenerate the coherent mark with scripts/make-brand-assets.py.")
        if box_fill < MIN_MARK_BOX_FILL:
            fail(f"{relative}: the largest connected mark component fills only "
                 f"{box_fill * 100:.1f}% of its bounding box, below the "
                 f"{MIN_MARK_BOX_FILL * 100:.0f}% structural floor. A thin hollow ring or "
                 "one-pixel path is area without a recognisable filled shape.")

    # 4. Reference integrity ------------------------------------------------
    if INDEX_HTML.exists():
        html = INDEX_HTML.read_text(encoding="utf-8")
        for href in re.findall(r'<link[^>]+rel="(?:icon|shortcut icon|apple-touch-icon)"[^>]*'
                               r'href="([^"]+)"', html):
            name = href.rsplit("/", 1)[-1]
            if not (PUBLIC / name).exists():
                fail(f"frontend/index.html links {href}, which is not in frontend/public")
    else:
        fail("frontend/index.html is missing")

    if THEME_TS.exists():
        source = THEME_TS.read_text(encoding="utf-8")
        block = re.search(r"THEME_FAVICONS[^{]*\{(.*?)\}", source, re.S)
        if not block:
            fail("frontend/src/utils/theme.ts: THEME_FAVICONS is gone — RH-UI.2 shipped the "
                 "favicon-variant mechanism and RH-UI.3's assets depend on it")
        else:
            declared = dict(re.findall(r"'([\w-]+)'\s*:\s*'([^']+)'", block.group(1)))
            if declared != THEME_FAVICON_FILES:
                fail(f"THEME_FAVICONS is {declared}, expected {THEME_FAVICON_FILES}")
            for theme, filename in declared.items():
                if theme not in BUILT_IN_THEMES:
                    fail(f"THEME_FAVICONS names {theme!r}, which is not a built-in Theme")
                if not (PUBLIC / filename).exists():
                    fail(f"THEME_FAVICONS[{theme}] = {filename}, which does not exist")
    else:
        fail("frontend/src/utils/theme.ts is missing")

    # 5. Legibility at 16px, measured from the pixels ------------------------
    target = ROOT / LEGIBILITY_TARGET
    if target.exists():
        try:
            _, _, pixels = decode_png_rgba(target.read_bytes())
        except (ValueError, zlib.error) as error:
            fail(f"{LEGIBILITY_TARGET}: cannot decode ({error})")
        else:
            opaque = [(r, g, b) for r, g, b, a in pixels if a > 200]
            if len(opaque) < 64:
                fail(f"{LEGIBILITY_TARGET}: almost nothing is opaque — the icon is effectively blank")
            else:
                counts: dict[tuple[int, int, int], int] = {}
                for pixel in opaque:
                    counts[pixel] = counts.get(pixel, 0) + 1
                ranked = sorted(counts.items(), key=lambda item: item[1], reverse=True)
                ground = ranked[0][0]
                # The ink is the most common colour that is not a near-neighbour
                # of the ground: antialiasing produces a long tail of blends, and
                # measuring against one of those measures nothing.
                ink = None
                for colour, _count in ranked[1:]:
                    if contrast_ratio(ground, colour) >= 1.6:
                        ink = colour
                        break
                if ink is None:
                    fail(f"{LEGIBILITY_TARGET}: no second colour stands apart from the ground — "
                         "at 16px this icon is a solid tile, not a mark")
                else:
                    ratio = contrast_ratio(ground, ink)
                    if ratio < MIN_FAVICON_CONTRAST:
                        fail(f"{LEGIBILITY_TARGET}: ground {ground} against ink {ink} is "
                             f"{ratio:.2f}:1, below the {MIN_FAVICON_CONTRAST}:1 floor for a "
                             "graphical object (spec §13: legible at 16px, pixel evidence)")
    else:
        fail(f"missing {LEGIBILITY_TARGET}")

    # 6. The in-app wordmark stays token-bound -------------------------------
    if PATHS_MODULE.exists():
        module = PATHS_MODULE.read_text(encoding="utf-8")
        literals = HEX.findall(module)
        if literals:
            fail(f"{PATHS_MODULE.relative_to(ROOT)} carries colour literals {sorted(set(literals))}. "
                 "The in-app wordmark paints from --text-primary and --accent-color so it follows "
                 "the active Theme; a literal there is a wordmark that ignores the Theme.")
    else:
        fail("frontend/src/brand/wordmarkPaths.ts is missing")

    # ---- COVERAGE: every declared raster must have been inspected ----------
    # This is what closes the class rather than patching its instances. If a new
    # asset kind is declared and no check registers it, the gate FAILS instead of
    # quietly certifying something it never looked at — which is exactly how the
    # ICO slipped past two rounds of review.
    expected_rasters: set[str] = set()
    for relative in PNG_ASSETS:
        if (ROOT / relative).exists():
            expected_rasters.add(relative)
    for relative in ICO_ASSETS:
        path = ROOT / relative
        if not path.exists():
            continue
        try:
            for width, height, _payload in ico_members(path.read_bytes()):
                expected_rasters.add(f"{relative}#{width}x{height}")
        except (ValueError, struct.error):
            pass                                  # already reported above
    uninspected = expected_rasters - INSPECTED.get("raster palette", set())
    if uninspected:
        fail("these declared rasters were never pixel-inspected, yet the gate was about to "
             f"report raster conformance: {sorted(uninspected)}. Every declared raster must be "
             "covered by a check, or the success message is a false guarantee.")

    if failures:
        print("Brand-asset gate FAILED:\n")
        for message in failures:
            print(f"  - {message}")
        print(f"\n{len(failures)} problem(s).")
        return 1

    # Generated from the ledger, not written by hand: every number below is the
    # size of a set something actually put an entry into.
    # Every clause below is a COUNT of something this run actually did. The
    # raster numbers are read back from the ledger; the rest are counters
    # incremented at the point of inspection. No clause asserts a property no
    # code checked — that is the whole subject of review 92bc4c5b.
    print(
        f"Brand-asset gate passed. "
        f"Palette conformance: {svg_sources_inspected} SVG sources read, and "
        f"{len(INSPECTED.get('raster palette', ()))} rasters decoded "
        f"(every PNG and every ICO member). "
        f"Mark area and connected shape measured on "
        f"{len(INSPECTED.get('mark coverage', ()))} icons. "
        f"{LEGIBILITY_TARGET} ground-to-ink contrast decoded and above "
        f"{MIN_FAVICON_CONTRAST}:1. "
        f"Closed-directory sweep walked {len(seen_images)} image files recursively. "
        f"Retired-mark sweep ran over the tree by basename, by gradient signature "
        f"and by content hash."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
