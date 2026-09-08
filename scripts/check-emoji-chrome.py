#!/usr/bin/env python3
"""Iconography gate: emoji-in-chrome and the icon size grid
(task c7239175, RH-DESIGN.6 D20 / §4.2).

Ratified rule: chrome uses lucide icons only; **emoji are never interface
furniture**. User content is unaffected — a Task title, Report body or comment
may contain any emoji a principal types, because that is data flowing through
at runtime, not a literal in our source.

This gate therefore scans SOURCE literals in the frontend tree. A pictographic
emoji in a `.ts`/`.tsx` file is interface furniture by construction: it can only
reach a user by being rendered, logged or stored by us.

Scope decisions:
  - Comment lines are skipped: prose about emoji is not chrome.
  - Typographic marks are NOT emoji and stay legal: arrows (→ ↔ ⇒), geometric
    bullets (● ▪ ◆), dashes, quotes. Only the pictographic blocks are rejected.
  - EXEMPT_PATHS lists source files that legitimately hold emoji literals
    (e.g. a fixture asserting user-content rendering). Each entry needs a
    reason; the gate fails if an exempt path no longer exists, so the list
    cannot rot.

Icons are sized on the 16/20/24 grid and coloured from tokens; see
docs/design-system.md §2.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "frontend" / "src"
EXCLUDED_PARTS = {".git", "node_modules", "dist", "coverage"}

# Pictographic emoji blocks. Deliberately excludes U+2190-21FF (arrows) and
# U+25A0-25FF (geometric shapes) — those are typography, not icons.
EMOJI_RE = re.compile(
    "["
    "\U0001F000-\U0001FAFF"   # pictographs, emoticons, transport, symbols
    "\U00002600-\U000027BF"   # misc symbols + dingbats (☀ ⚙ ✅ ✋ ➿)
    "\U00002B00-\U00002BFF"   # arrows/shapes extended (⬜ ⬛)
    "\U000023E9-\U000023FA"   # media controls (⏭ ⏸)
    "\U0001F1E6-\U0001F1FF"   # regional indicators (flags)
    "]"
)
VARIATION_SELECTOR = "️"

# path -> reason. Verified to exist; a stale entry fails the gate.
EXEMPT_PATHS: dict[str, str] = {}


# §4.2 icon grid. Chrome icons use 16/20/24. Sizes ABOVE 24 are illustration
# scale (hero glyphs, avatars, empty-state art) and were never on the icon
# grid — the rule governs interface icons, so the gate applies it there and
# leaves display art alone. Below-grid sizes are what the rule exists to stop.
ICON_GRID = (16, 20, 24)
ICON_SIZE_RE = re.compile(r"size=\{(\d+)\}")


def check_icon_sizes(path: str, text: str, failures: list[str]) -> None:
    for number, line in enumerate(text.splitlines(), 1):
        for raw in ICON_SIZE_RE.findall(line):
            size = int(raw)
            if size > max(ICON_GRID):
                continue
            if size not in ICON_GRID:
                failures.append(
                    f"{path}:{number}: icon size={size} is off the ratified grid "
                    f"{ICON_GRID} (§4.2); sizes above {max(ICON_GRID)} are "
                    f"illustration scale and exempt")


def source_files() -> list[Path]:
    return sorted(
        p for p in SRC.rglob("*")
        if p.suffix in (".ts", ".tsx")
        and not any(part in EXCLUDED_PARTS for part in p.parts)
    )


def check_text(path: str, text: str, failures: list[str]) -> None:
    in_block_comment = False
    for number, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if in_block_comment:
            if "*/" in stripped:
                in_block_comment = False
            continue
        if stripped.startswith("/*"):
            if "*/" not in stripped:
                in_block_comment = True
            continue
        if stripped.startswith("//") or stripped.startswith("*"):
            continue
        found = EMOJI_RE.findall(line.replace(VARIATION_SELECTOR, ""))
        for glyph in found:
            failures.append(
                f"{path}:{number}: emoji {glyph!r} in source — chrome uses lucide "
                f"icons only (D20). User content is unaffected; if this file "
                f"genuinely needs an emoji literal, add it to EXEMPT_PATHS with a reason.")


def main() -> int:
    failures: list[str] = []
    files = source_files()
    present = {str(p.relative_to(ROOT)) for p in files}

    for path, reason in sorted(EXEMPT_PATHS.items()):
        if path not in present:
            failures.append(
                f"{path}: listed in EXEMPT_PATHS ({reason}) but absent from the tree — "
                f"remove the stale exemption")

    for p in files:
        rel = str(p.relative_to(ROOT))
        if rel in EXEMPT_PATHS:
            continue
        source = p.read_text(encoding="utf-8")
        check_text(rel, source, failures)
        check_icon_sizes(rel, source, failures)

    if failures:
        print("Iconography gate FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        return 1
    print(f"Iconography gate passed ({len(files)} source files: no emoji in chrome, "
          f"icon sizes on the {ICON_GRID} grid, {len(EXEMPT_PATHS)} declared exemptions)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
