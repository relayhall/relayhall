#!/usr/bin/env python3
"""Design-estate audit freeze (task ae0f3f5c, RH-UI.1a subtask 0).

Re-measures, mechanically and deterministically, every number the RH-DESIGN.6
specification's §1.2 design-system audit asserted about the frontend styling
estate. The frozen result for the wave's base SHA is committed as
scripts/design-baseline.json; the sweep tasks (RH-UI.1b literals/collisions,
RH-UI.1c iconography) re-run this script to prove their deltas against the
freeze instead of against prose claims.

This is a measurement tool, not a gate: it never fails on drift. The gates that
enforce the design-system contract are check-design-tokens.py (token existence
+ literal-colour ratchet) and check-design-contrast.py (pairing matrix); both
self-prove in CI.

Usage:
  python3 scripts/audit-design-baseline.py            # print measurements JSON
  python3 scripts/audit-design-baseline.py --write    # rewrite the committed freeze
  python3 scripts/audit-design-baseline.py --diff     # compare live tree vs freeze
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "frontend" / "src"
BASELINE_PATH = Path(__file__).resolve().parent / "design-baseline.json"
EXCLUDED_PARTS = {".git", "node_modules", "dist", "coverage"}

TOKEN_FILE = "frontend/src/styles/variables.css"  # the only literal-bearing token file today

DEFINITION_RE = re.compile(r"(?:^|[;{])\s*(--[\w-]+)\s*:", re.MULTILINE)
REFERENCE_RE = re.compile(r"var\(\s*(--[\w-]+)")
HEX_RE = re.compile(r"#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b")
RGBA_RE = re.compile(r"\brgba?\(")
CSS_IMPORT_RE = re.compile(r"^\s*import\s+['\"].*\.css['\"]", re.MULTILINE)
INLINE_STYLE_RE = re.compile(r"style=\{\{")
LUCIDE_IMPORT_RE = re.compile(
    r"import\s*\{([^}]*)\}\s*from\s*['\"]lucide-react['\"]", re.DOTALL)
MEDIA_PX_RE = re.compile(r"@media[^{]*?\(\s*(?:min|max)-width\s*:\s*(\d+)px")
# Interface-furniture emoji (spec §1.2 "two systems" finding). Ranges cover the
# pictograph blocks observed in the tree; VS16/ZWJ sequences count once.
EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF☀-➿⬀-⯿←-⇿✀-➿]"
)


def _files(root: Path, suffixes: tuple[str, ...]) -> list[Path]:
    return sorted(
        p for p in root.rglob("*")
        if p.suffix in suffixes and not any(part in EXCLUDED_PARTS for part in p.parts)
    )


def measure() -> dict:
    css_paths = _files(SRC, (".css",))
    ts_paths = _files(SRC, (".ts", ".tsx"))
    tsx_paths = [p for p in ts_paths if p.suffix == ".tsx"]
    css_texts = {p: p.read_text(encoding="utf-8") for p in css_paths}
    ts_texts = {p: p.read_text(encoding="utf-8") for p in ts_paths}

    all_css = "\n".join(css_texts.values())
    all_ts = "\n".join(ts_texts.values())

    defined = sorted(set(DEFINITION_RE.findall(all_css)))
    referenced_css = set(REFERENCE_RE.findall(all_css))
    # Runtime references: any literal occurrence of the token name in TS/TSX
    # (setProperty / getPropertyValue / template strings).
    unreferenced = sorted(
        t for t in defined if t not in referenced_css and t not in all_ts)

    hex_outside = 0
    rgba_outside = 0
    for p, text in css_texts.items():
        if str(p.relative_to(ROOT)) == TOKEN_FILE:
            continue
        hex_outside += len(HEX_RE.findall(text))
        rgba_outside += len(RGBA_RE.findall(text))

    # Collision criterion is owned (delegated) by audit-css-collisions.py so
    # both tools measure identically (review 2a83b89b F4).
    from importlib.machinery import SourceFileLoader
    collision_audit = SourceFileLoader(
        "collision_audit", str(Path(__file__).resolve().parent / "audit-css-collisions.py")
    ).load_module()
    duplicated = {
        n: sorted(fs)
        for n, fs in collision_audit.declarations().items() if len(fs) > 1
    }

    lucide_names: set[str] = set()
    lucide_files = 0
    for text in ts_texts.values():
        found = LUCIDE_IMPORT_RE.findall(text)
        if found:
            lucide_files += 1
            for group in found:
                lucide_names.update(
                    n.strip().split(" as ")[0].strip()
                    for n in group.split(",") if n.strip())

    emoji_total = sum(
        len(EMOJI_RE.findall(ts_texts[p])) for p in tsx_paths)

    breakpoints = Counter(
        int(v) for text in css_texts.values() for v in MEDIA_PX_RE.findall(text))

    return {
        "stylesheets": len(css_paths),
        "css_lines": sum(text.count("\n") + 1 for text in css_texts.values()),
        "tokens_defined": len(defined),
        "tokens_defined_never_referenced": len(unreferenced),
        "tokens_unreferenced_names": unreferenced,
        "hex_literals_css_outside_token_file": hex_outside,
        "rgb_literals_css_outside_token_file": rgba_outside,
        "hex_literals_ts_tsx": len(HEX_RE.findall(all_ts)),
        "inline_style_objects_tsx": len(INLINE_STYLE_RE.findall(all_ts)),
        "css_import_statements": len(CSS_IMPORT_RE.findall(all_ts)),
        "class_names_declared_in_multiple_stylesheets": len(duplicated),
        "lucide_distinct_icons": len(lucide_names),
        "lucide_importing_files": lucide_files,
        "emoji_occurrences_tsx": emoji_total,
        "outline_none_declarations": len(
            re.findall(r"outline\s*:\s*none", all_css)),
        "focus_visible_selectors": len(re.findall(r":focus-visible", all_css)),
        "font_face_rules": len(re.findall(r"@font-face", all_css)),
        "prefers_color_scheme_queries": len(
            re.findall(r"prefers-color-scheme", all_css)),
        "data_theme_selectors": len(re.findall(r"\[data-theme", all_css)),
        "media_query_breakpoints_px": {
            str(k): v for k, v in sorted(breakpoints.items())},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--write", action="store_true",
                      help="rewrite scripts/design-baseline.json from the live tree")
    mode.add_argument("--diff", action="store_true",
                      help="print keys whose live value differs from the freeze")
    args = parser.parse_args()

    live = measure()
    if args.write:
        BASELINE_PATH.write_text(
            json.dumps(live, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"wrote {BASELINE_PATH.relative_to(ROOT)}")
        return 0
    if args.diff:
        frozen = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
        changed = sorted(
            k for k in frozen.keys() | live.keys() if frozen.get(k) != live.get(k))
        for key in changed:
            print(f"{key}: frozen={frozen.get(key)!r} live={live.get(key)!r}")
        print(f"{len(changed)} measurement(s) differ from the freeze")
        return 0
    print(json.dumps(live, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
