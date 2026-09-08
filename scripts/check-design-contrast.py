#!/usr/bin/env python3
"""Per-theme contrast gate (task ae0f3f5c, RH-DESIGN.6 §4.5).

Consumes the declared pairing matrix from docs/design-system.md (the fenced
block whose info string is `json contrast-matrix` — the document is the single
source of truth), resolves every named token from the theme's bindings in
frontend/src/styles/variables.css, composites alpha colours over their pair
background, and fails if any pair misses its threshold class:
text 4.5:1 (WCAG 2.2 AA 1.4.3), ui 3:1 (1.4.11).

Exempted tokens are not tested, but each must still exist in the theme so a
stale exemption surfaces as a failure rather than silence.

Theme-parameterised: --theme relay-dark (default) today; RH-UI.2 adds
relay-light and high-contrast to the CI runs when they exist. Fails closed on
a missing matrix, malformed JSON, unknown tokens, or unparsable colours.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOC_PATH = ROOT / "docs" / "design-system.md"
CSS_PATH = ROOT / "frontend" / "src" / "styles" / "variables.css"

FENCE_RE = re.compile(r"```json contrast-matrix\n(.*?)```", re.DOTALL)
DECL_RE = re.compile(r"(--[\w-]+)\s*:\s*([^;}]+)[;}]")
VAR_RE = re.compile(r"var\(\s*(--[\w-]+)\s*\)")
HEX_RE = re.compile(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
RGBA_RE = re.compile(
    r"^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$")
COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)


def load_matrix(doc_text: str) -> dict:
    m = FENCE_RE.search(doc_text)
    if not m:
        raise SystemExit("contrast gate FAILED: no `json contrast-matrix` fence in the DS doc")
    return json.loads(m.group(1))


def theme_bindings(css_text: str, theme: str) -> dict[str, str]:
    """Custom-property declarations from :root and [data-theme=<theme>] blocks,
    in document order (later blocks override).

    Comments are stripped first (RH-UI.2). A comment carries no braces, so a
    naive block scan folds it into the FOLLOWING rule's selector — and a
    stylesheet that documents its own theme selectors in prose (this one does)
    would then match blocks by their commentary rather than their code."""
    bindings: dict[str, str] = {}
    for block in re.finditer(r"([^{}]+)\{([^{}]*)\}", COMMENT_RE.sub("", css_text)):
        selector, body = block.group(1).strip(), block.group(2)
        if ":root" in selector or f'[data-theme="{theme}"]' in selector:
            for name, value in DECL_RE.findall(body + "}"):
                bindings[name] = value.strip()
    return bindings


def resolve(token: str, bindings: dict[str, str], depth: int = 0) -> str:
    if depth > 20:
        raise SystemExit(f"contrast gate FAILED: var() chain too deep at {token}")
    value = bindings.get(token)
    if value is None:
        raise SystemExit(f"contrast gate FAILED: {token} is not defined for this theme")
    m = VAR_RE.fullmatch(value.strip())
    if m:
        return resolve(m.group(1), bindings, depth + 1)
    return value.strip()


def parse_colour(value: str) -> tuple[float, float, float, float]:
    m = HEX_RE.match(value)
    if m:
        h = m.group(1)
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 1.0
    m = RGBA_RE.match(value)
    if m:
        r, g, b = (int(m.group(i)) for i in (1, 2, 3))
        a = float(m.group(4)) if m.group(4) is not None else 1.0
        return r, g, b, a
    raise SystemExit(f"contrast gate FAILED: unparsable colour value {value!r}")


def composite(fg: tuple, bg: tuple) -> tuple[float, float, float]:
    r, g, b, a = fg
    br, bg_, bb, _ = bg
    return (a * r + (1 - a) * br, a * g + (1 - a) * bg_, a * b + (1 - a) * bb)


def luminance(rgb: tuple[float, float, float]) -> float:
    def lin(c: float) -> float:
        c /= 255.0
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (lin(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(fg: tuple, bg: tuple) -> float:
    l1, l2 = luminance(fg), luminance(bg)
    if l1 < l2:
        l1, l2 = l2, l1
    return (l1 + 0.05) / (l2 + 0.05)


def run(doc_text: str, css_text: str, theme: str) -> list[str]:
    matrix = load_matrix(doc_text)
    thresholds = matrix["thresholds"]
    bindings = theme_bindings(css_text, theme)
    failures: list[str] = []

    for pair in matrix["pairs"]:
        threshold = float(thresholds[pair["class"]])
        bg = parse_colour(resolve(pair["bg"], bindings))
        if bg[3] < 1.0:
            failures.append(f"{pair['bg']}: pair backgrounds must be opaque")
            continue
        fg_raw = parse_colour(resolve(pair["fg"], bindings))
        fg = composite(fg_raw, bg) if fg_raw[3] < 1.0 else fg_raw[:3]
        ratio = contrast_ratio(fg, bg[:3])
        if ratio < threshold:
            failures.append(
                f"{pair['fg']} on {pair['bg']} ({pair['class']}): "
                f"{ratio:.2f}:1 < {threshold}:1 [{theme}]")

    for exemption in matrix.get("exemptions", []):
        resolve(exemption["token"], bindings)  # stale exemptions fail closed

    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--theme", default="relay-dark")
    parser.add_argument("--doc", type=Path, default=DOC_PATH,
                        help="DS document carrying the matrix (fixture override)")
    parser.add_argument("--css", type=Path, default=CSS_PATH,
                        help="token stylesheet (fixture override)")
    args = parser.parse_args()

    doc_text = args.doc.read_text(encoding="utf-8")
    css_text = args.css.read_text(encoding="utf-8")
    matrix = load_matrix(doc_text)
    failures = run(doc_text, css_text, args.theme)
    if failures:
        print("Design-contrast gate FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        return 1
    print(
        f"Design-contrast gate passed ({len(matrix['pairs'])} pairs, "
        f"{len(matrix.get('exemptions', []))} declared exemptions, theme {args.theme})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
