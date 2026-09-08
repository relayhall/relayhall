#!/usr/bin/env python3
"""Self-proof for scripts/check-brand-assets.py (A15.2 pattern).

Every rule the gate claims gets a fixture that violates exactly it, and the gate
runs as a subprocess so the proof covers the CLI surface too. A gate that passes
because it stopped looking is the failure this file exists to make impossible —
and on this wave that is not a hypothetical: the draft monogram round produced a
tile that satisfied every automated check in the tree while being illegible at
the one size a favicon is drawn at.

The fixture is a real copy of the assets under test rather than synthetic bytes,
because half of what the gate reads is binary (PNG IHDR, the ICO directory,
decoded pixels). Each case copies the good tree and breaks one thing.
"""
from __future__ import annotations

import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GATE = Path(__file__).resolve().parent / "check-brand-assets.py"

# Everything the gate reads, so a fixture tree is a faithful miniature.
FIXTURE_PATHS = [
    "frontend/src/styles/variables.css",
    "frontend/index.html",
    "frontend/src/utils/theme.ts",
    "frontend/src/brand/wordmarkPaths.ts",
    "frontend/public/favicon.svg",
    "frontend/public/favicon-relay-light.svg",
    "frontend/public/favicon-high-contrast.svg",
    "frontend/public/favicon-16.png",
    "frontend/public/favicon-32.png",
    "frontend/public/favicon-64.png",
    "frontend/public/favicon.ico",
    "frontend/public/apple-touch-icon.png",
    "frontend/public/brand/wordmark.svg",
    "frontend/public/brand/wordmark-mono.svg",
    "frontend/public/brand/monogram-tile-a-slate.svg",
    "frontend/public/brand/monogram-tile-b-accent.svg",
    "frontend/public/brand/monogram-mono.svg",
    "docs/brand/org-avatar-512.png",
    "docs/brand/social-card.svg",
    "docs/brand/social-card.png",
    "docs/brand/architecture.svg",
    "docs/brand/architecture-light.svg",
]


def build_fixture(destination: Path) -> None:
    for relative in FIXTURE_PATHS:
        source = ROOT / relative
        if not source.exists():
            raise SystemExit(f"fixture source missing: {relative} — the gate cannot be proved "
                             "against a tree that does not have the asset set")
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def solid_png(path: Path, size: int, rgba) -> None:
    write_png(path, size, lambda x, y: rgba)


def retired_spiral_bytes(kind: str) -> bytes:
    """The retired mark as it stood at 9b3f963, read from git rather than stored.

    Checking a copy of the deleted artwork back into the tree to prove it stays
    deleted would be its own joke. `git show` is the honest source, and skipping
    the case when history is unavailable is better than a fixture that drifts.
    """
    result = subprocess.run(
        ["git", "show", f"9b3f963:frontend/public/{kind}"],
        cwd=ROOT, capture_output=True)
    return result.stdout if result.returncode == 0 else b""


def write_png(path: Path, size: int, rows) -> None:
    """Minimal RGBA PNG writer — filter 0 throughout. `rows(x, y) -> (r,g,b,a)`."""
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            raw.extend(rows(x, y))

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (struct.pack(">I", len(payload)) + kind + payload
                + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF))

    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw)))
        + chunk(b"IEND", b"")
    )


def run(tree: Path) -> tuple[int, str]:
    result = subprocess.run([sys.executable, str(GATE), "--root", str(tree)],
                            capture_output=True, text=True)
    return result.returncode, result.stdout + result.stderr


PASSES = 0
FAILURES: list[str] = []


def case(name: str, mutate, expect: str) -> None:
    """Break exactly one rule and require the gate to name it."""
    global PASSES
    with tempfile.TemporaryDirectory(prefix="brand-gate-") as temporary:
        tree = Path(temporary)
        build_fixture(tree)
        mutate(tree)
        code, output = run(tree)
        if code == 0:
            FAILURES.append(f"{name}: gate PASSED a tree it should have rejected")
        elif expect not in output:
            FAILURES.append(f"{name}: gate failed but never said {expect!r}\n{output}")
        else:
            PASSES += 1
            print(f"  ok   {name}")


# Every claim the module docstring makes, mapped to the code that performs it.
#
# FOUR consecutive review rounds rejected this gate for one reason: a sentence
# asserting a guarantee the implementation had not performed. Each time I fixed
# the sentence I was thinking about and missed another. Re-reading is evidently
# not a method I can rely on here, so the mapping is mechanical: if a claim's
# implementing code disappears or is renamed, this fails. It does not stop
# someone ADDING an unbacked sentence — nothing cheap can — but it does stop the
# backed ones quietly rotting, which is how three of the four rounds happened.
DOCSTRING_CLAIMS = {
    "1 SVG viewBox compared to a declared value": r"SVG_VIEW_BOXES\.get\(relative\)",
    "1 PNG dimensions from IHDR": r"png_header\(path\.read_bytes\(\)\)",
    "1 ICO member sizes from the directory": r"ico_sizes\(path\.read_bytes\(\)\)",
    "2 retired mark by basename": r"RETIRED_BASENAMES",
    "2 retired mark by gradient signature": r"SPIRAL_SIGNATURE",
    "2 retired mark by content hash": r"RETIRED_CONTENT_HASHES\[digest\]",
    "2 closed set is recursive": r"base\.rglob\(",
    "3 SVG colour literals vs the Theme palette": r"is not a colour the stylesheet declares",
    "3 raster pixels decoded": r"inspect_pixels\(relative, path\.read_bytes\(\)\)",
    "3 every ICO member decoded": r"for width, height, payload in members",
    "3 coverage assertion over declared rasters": r"never pixel-inspected",
    "4 index.html icon links resolve": r"which is not in frontend/public",
    "4 THEME_FAVICONS matches the Theme set": r"THEME_FAVICONS is",
    "5 16px contrast decoded from pixels": r"MIN_FAVICON_CONTRAST",
    "5 mark coverage floor": r"MIN_MARK_COVERAGE",
    "5 connected mark coverage floor": r"MIN_CONNECTED_MARK_COVERAGE",
    "5 mark bounding-box fill floor": r"MIN_MARK_BOX_FILL",
    "6 wordmark module carries no colour literal": r"carries colour literals",
}


def audit_claims() -> list[str]:
    source = (ROOT / "scripts" / "check-brand-assets.py").read_text(encoding="utf-8")
    return [name for name, pattern in DOCSTRING_CLAIMS.items()
            if not __import__("re").search(pattern, source)]


def main() -> int:
    global PASSES
    print("Proving scripts/check-brand-assets.py\n")

    unbacked = audit_claims()
    if unbacked:
        FAILURES.append("docstring claims with no implementing code: " + ", ".join(unbacked))
    else:
        PASSES += 1
        print(f"  ok   claim audit: all {len(DOCSTRING_CLAIMS)} docstring claims map to live code")

    # The control: an unmutated copy must pass, or every red below proves nothing.
    with tempfile.TemporaryDirectory(prefix="brand-gate-") as temporary:
        tree = Path(temporary)
        build_fixture(tree)
        code, output = run(tree)
        if code != 0:
            # Print everything gathered so far, not just this failure: an early
            # return here once swallowed the claim-audit result, which made the
            # audit look like it had not run.
            for failure in FAILURES:
                print(f"  FAIL {failure}")
            print("  FAIL control: the gate rejects a faithful copy of the tree\n" + output)
            return 1
        PASSES += 1
        print("  ok   control: a faithful copy passes")

    case("a missing SVG asset is caught",
         lambda tree: (tree / "frontend/public/brand/wordmark.svg").unlink(),
         "missing brand asset: frontend/public/brand/wordmark.svg")

    case("an SVG without an accessible title is caught",
         lambda tree: (tree / "frontend/public/brand/wordmark.svg").write_text(
             (tree / "frontend/public/brand/wordmark.svg").read_text()
             .replace("<title>RelayHall</title>", "")),
         "no accessible <title>")

    case("a PNG at the wrong size is caught",
         lambda tree: shutil.copy2(tree / "frontend/public/favicon-32.png",
                                   tree / "frontend/public/favicon-16.png"),
         "is 32x32, declared 16x16")

    def truncate_ico(tree: Path) -> None:
        path = tree / "frontend/public/favicon.ico"
        data = bytearray(path.read_bytes())
        data[4] = 2          # claim two members where three are declared
        path.write_bytes(bytes(data))

    case("an ICO missing a declared member is caught", truncate_ico, "declared [16, 32, 64]")

    case("a retired mark walking back in is caught",
         lambda tree: (tree / "frontend/public/nim-favicon.png").write_bytes(
             (tree / "frontend/public/favicon-32.png").read_bytes()),
         "retired brand asset is back")

    case("the spiral is caught even under a new filename",
         lambda tree: (tree / "frontend/public/brand/company-mark.svg").write_text(
             '<svg xmlns="http://www.w3.org/2000/svg"><linearGradient id="g">'
             '<stop style="stop-color:#7c3aed"/><stop style="stop-color:#6366f1"/>'
             '</linearGradient></svg>'),
         "spiral mark is back")

    case("an off-palette colour in a brand asset is caught",
         lambda tree: (tree / "frontend/public/brand/wordmark.svg").write_text(
             (tree / "frontend/public/brand/wordmark.svg").read_text()
             .replace("#14b8a6", "#ff8800")),
         "#ff8800 is not a colour the stylesheet declares")

    case("a light-Theme asset carrying the dark Theme's accent is caught",
         lambda tree: (tree / "frontend/public/favicon-relay-light.svg").write_text(
             (tree / "frontend/public/favicon-relay-light.svg").read_text()
             .replace("#ffffff", "#8892a0")),
         "not a colour the stylesheet declares for relay-light")

    case("an index.html icon link with no file behind it is caught",
         lambda tree: (tree / "frontend/index.html").write_text(
             (tree / "frontend/index.html").read_text()
             .replace("favicon-64.png", "favicon-999.png")),
         "which is not in frontend/public")

    case("THEME_FAVICONS drifting from the asset set is caught",
         lambda tree: (tree / "frontend/src/utils/theme.ts").write_text(
             (tree / "frontend/src/utils/theme.ts").read_text()
             .replace("'high-contrast': 'favicon-high-contrast.svg'",
                      "'high-contrast': 'favicon.svg'")),
         "THEME_FAVICONS is")

    case("THEME_FAVICONS naming a file that is not there is caught",
         lambda tree: (tree / "frontend/public/favicon-high-contrast.svg").unlink(),
         "which does not exist")

    case("a blank favicon is caught",
         lambda tree: write_png(tree / "frontend/public/favicon-16.png", 16,
                                lambda x, y: (20, 184, 166, 255)),
         "solid tile, not a mark")

    # teal-500 ground against a teal-700 mark: 2.2:1. It reads as a mark rather
    # than a solid tile, so it clears the "stands apart" filter — and then fails
    # on the ratio, which is the branch this case exists to reach.
    case("a favicon whose mark is distinguishable but under the contrast floor is caught",
         lambda tree: write_png(
             tree / "frontend/public/favicon-16.png", 16,
             lambda x, y: (20, 184, 166, 255) if not (4 <= x < 12 and 4 <= y < 12)
             else (15, 118, 110, 255)),
         "below the 3.0:1 floor")

    # ---- raster-content rules (review 566efa25 H1, task 873574b1) ---------
    # Each of these three was REPRODUCED by the reviewer against the first cut
    # of this gate, which passed all of them while printing "palette
    # conformant", "retired marks absent" and "16px favicon legible".

    case("a solid off-palette raster is caught, though its SVG source is clean",
         lambda tree: solid_png(tree / "frontend/public/favicon-32.png", 32, (255, 0, 255, 255)),
         "of the relay-dark brand palette")

    case("an undeclared image NESTED in a subdirectory is caught",
         lambda tree: (lambda d: (d.mkdir(parents=True, exist_ok=True),
                                  solid_png(d / "undeclared.png", 32, (20, 184, 166, 255))))(
             tree / "frontend/public/uploads"),
         "is a CLOSED set, subdirectories included")

    case("an undeclared image two levels down is caught",
         lambda tree: (lambda d: (d.mkdir(parents=True, exist_ok=True),
                                  solid_png(d / "buried.png", 32, (20, 184, 166, 255))))(
             tree / "docs/brand/archive/2025"),
         "is a CLOSED set, subdirectories included")

    case("an undeclared image in a brand directory is caught",
         lambda tree: solid_png(tree / "frontend/public/brand/extra-mark.png", 32, (20, 184, 166, 255)),
         "is a CLOSED set")

    def restore_spiral(tree: Path) -> None:
        payload = retired_spiral_bytes("favicon.png")
        if not payload:                      # no history in this checkout
            payload = b"\x89PNG\r\n\x1a\n" + b"unavailable"
        (tree / "frontend/public/brand/renamed-company-mark.png").write_bytes(payload)

    case("the retired spiral RASTER is caught under a new basename", restore_spiral,
         "is a CLOSED set")

    case("a favicon that is a tile with one contrasting pixel is caught",
         lambda tree: write_png(
             tree / "frontend/public/favicon-16.png", 16,
             lambda x, y: (15, 18, 22, 255) if (x == 8 and y == 8) else (20, 184, 166, 255)),
         "below the 6% floor")

    case("sixteen scattered pixels cannot satisfy recognisability",
         lambda tree: write_png(
             tree / "frontend/public/favicon-16.png", 16,
             lambda x, y: ((15, 18, 22, 255)
                           if x in (1, 5, 9, 13) and y in (1, 5, 9, 13)
                           else (20, 184, 166, 255))),
         "largest connected mark component covers")

    case("a thin hollow perimeter cannot satisfy recognisability",
         lambda tree: write_png(
             tree / "frontend/public/favicon-16.png", 16,
             lambda x, y: ((15, 18, 22, 255)
                           if x in (0, 15) or y in (0, 15)
                           else (20, 184, 166, 255))),
         "fills only 23.4% of its bounding box")

    case("one off-palette pixel cannot hide below a percentage allowance",
         lambda tree: write_png(
             tree / "frontend/public/favicon-64.png", 64,
             lambda x, y: ((255, 0, 255, 255)
                           if (x, y) == (0, 0)
                           else (20, 184, 166, 255))),
         "opaque pixels lie within")

    # ---- the class, not its instances (review 9cbad6a0) -------------------
    def corrupt_ico_payloads(tree: Path) -> None:
        """Replace member PIXELS, leaving the directory entries intact.

        Round 2's reproduction exactly: the declared 16/32/64 sizes still parse,
        so a directory-only check sees nothing wrong.
        """
        path = tree / "frontend/public/favicon.ico"
        data = bytearray(path.read_bytes())
        _, _, count = struct.unpack("<HHH", bytes(data[:6]))
        for index in range(count):
            entry = data[6 + index * 16: 22 + index * 16]
            size, offset = struct.unpack("<II", bytes(entry[8:16]))
            data[offset:offset + size] = b"X" * size
        path.write_bytes(bytes(data))

    case("corrupted ICO member pixels are caught, though the directory is intact",
         corrupt_ico_payloads, "member payload is not PNG-encoded")

    def off_palette_ico_member(tree: Path) -> None:
        """A member that decodes cleanly but is the wrong colour."""
        path = tree / "frontend/public/favicon.ico"
        data = bytearray(path.read_bytes())
        _, _, count = struct.unpack("<HHH", bytes(data[:6]))
        entry = data[6:22]
        size, offset = struct.unpack("<II", bytes(entry[8:16]))
        magenta = tree / "_magenta.png"
        solid_png(magenta, 16, (255, 0, 255, 255))
        payload = magenta.read_bytes()
        magenta.unlink()
        # Re-point this member at the new payload, appended at the end.
        new_offset = len(data)
        data[14:18] = struct.pack("<I", len(payload))
        data[18:22] = struct.pack("<I", new_offset)
        data += payload
        path.write_bytes(bytes(data))

    case("an off-palette ICO member is caught",
         off_palette_ico_member, "of the relay-dark brand palette")

    case("a truncated raster is reported, not crashed on",
         lambda tree: (tree / "frontend/public/favicon-64.png").write_bytes(
             (tree / "frontend/public/favicon-64.png").read_bytes()[:20]),
         "not a readable PNG")

    case("an SVG whose viewBox differs from the declared geometry is caught",
         lambda tree: (tree / "frontend/public/brand/wordmark.svg").write_text(
             (tree / "frontend/public/brand/wordmark.svg").read_text()
             .replace('viewBox="0 -800 4477 1060"', 'viewBox="0 0 100 100"')),
         "declared '0 -800 4477 1060'")

    case("an SVG with no viewBox at all is caught",
         lambda tree: (tree / "frontend/public/favicon.svg").write_text(
             (tree / "frontend/public/favicon.svg").read_text()
             .replace('viewBox="0 0 1000 1000"', 'data-was-viewbox="removed"')),
         "no viewBox")

    case("a colour literal in the in-app wordmark module is caught",
         lambda tree: (tree / "frontend/src/brand/wordmarkPaths.ts").write_text(
             (tree / "frontend/src/brand/wordmarkPaths.ts").read_text()
             + "\nexport const INK = '#f2f4f7';\n"),
         "carries colour literals")

    print()
    if FAILURES:
        for failure in FAILURES:
            print(f"  FAIL {failure}")
        print(f"\n{len(FAILURES)} of {PASSES + len(FAILURES)} checks failed.")
        return 1
    print(f"All {PASSES} checks passed — the brand-asset gate proves itself.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
