#!/usr/bin/env python3
"""Type-scale and control-metric gate (RH-UI.20, design 77950a97 §7).

Ratified contract: the estate has ONE type scale — page title 24/700,
section 20/700, group heading 14/700, body 14, label 12, meta 12 — with a
12px floor, and TWO control sizes — 36px compact, 48px standard. Diagnosis
7fa7e605 measured 20 declared font sizes (9 below the floor) and 5 control
heights shipping concurrently; this gate makes that class of drift a CI
failure, like the icon-grid gate.

Rules over frontend/src/**/*.css:
  1. Every `font-size` declaration must be `var(--…)` of an ALLOWED token,
     `inherit`, or a declaration in DISPLAY_EXEMPT. Literal sizes fail.
  2. The allowed tokens must be DEFINED at exactly their ratified values in
     variables.css (a token edit cannot smuggle the scale off contract),
     and the retired off-scale tokens must not come back.
  3. Control heights: a `height`/`min-height` — or its writing-mode-relative
     twin `block-size`/`min-block-size`, which resolves to the same box in
     this estate's horizontal-tb surfaces — in the control band (28–56px) on
     a control-ish selector must use var(--control-compact|standard). Scanning
     only the physical properties left the logical spelling as a silent
     bypass (hardening 8244fda8, filed from the RH-UI.20 review).
     Exception: `min-height: 44px` inside an @media block is the WCAG
     touch-target floor (RH-UI.6, a previously verified fix) and passes.
  4. `--control-*` and the allowed font tokens may be DEFINED only in
     variables.css.

DISPLAY_EXEMPT lists declarations that are display/illustration scale —
hero numerals, logo glyphs, empty-state art — mirroring the icon gate's
"above the grid is illustration" principle: everything exempted here must
be LARGER than the page-title size. Entries are path -> reason; a stale
path fails the gate so the list cannot rot.

The map-tile chip exemption (§7: 9.5px minimum, map density only) becomes a
`--text-map-chip` token scoped to components/map/ when the A7 rebuild lands;
until that token exists the floor is absolute.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "frontend" / "src"
VARIABLES = SRC / "styles" / "variables.css"
EXCLUDED_PARTS = {".git", "node_modules", "dist", "coverage"}

# The ratified scale, as tokens (12/14/20/24px in rem).
ALLOWED_FONT_TOKENS: dict[str, str] = {
    "--text-xs": "0.75rem",    # 12px — label / meta (the floor)
    "--text-sm": "0.875rem",   # 14px — body / group heading
    "--text-xl": "1.25rem",    # 20px — section heading
    "--text-2xl": "1.5rem",    # 24px — page title
}
# Map-density chip token: allowed ONLY in components/map/ files, and only
# once it is defined in variables.css (A7 rebuild). 9.5px per §7.
MAP_CHIP_TOKEN = "--text-map-chip"
MAP_CHIP_VALUE_MAX_PX = 12.0
MAP_CHIP_VALUE_MIN_PX = 9.5
MAP_PATH_PART = "map"

# Off-scale tokens retired by RH-UI.20. Definition or use fails.
RETIRED_FONT_TOKENS = ("--text-base", "--text-lg", "--text-3xl")

CONTROL_TOKENS: dict[str, str] = {
    "--control-compact": "36px",
    "--control-standard": "48px",
}
CONTROL_BAND_PX = (28, 56)
CONTROL_SELECTOR_RE = re.compile(
    r"btn|button|control|select|switch|segment|toggle|input|action|picker",
    re.IGNORECASE,
)
TOUCH_FLOOR_PX = 44  # WCAG 2.5.5 target floor (RH-UI.6)

# Display/illustration-scale exemptions: path -> reason. Every exempted
# font-size must resolve ABOVE the page-title size (>24px); the gate
# verifies both existence and that constraint.
DISPLAY_EXEMPT: dict[str, str] = {
    "frontend/src/components/Sidebar.css":
        "logo glyph (60px) — brand mark, not interface type",
    "frontend/src/pages/DashboardPage.css":
        "hero stat numerals (32/36px) — data display, not interface type",
    "frontend/src/components/dashboard/StatsCard.css":
        "stat numerals (48px) — data display, not interface type",
    "frontend/src/StatusIndicator.css":
        "status orb glyph (2rem) — illustration scale",
    "frontend/src/App.css":
        "app-level hero heading (2rem) — display scale",
    "frontend/src/index.css":
        "document h1 base style (2rem) — display scale",
}

FONT_SIZE_RE = re.compile(r"font-size\s*:\s*([^;}]+)[;}]", re.IGNORECASE)
# The `font:` shorthand can smuggle a size past a font-size-only scan.
# Only keyword resets (inherit/unset/initial) and family-only values pass.
FONT_SHORTHAND_RE = re.compile(r"(?:^|[;{\s])font\s*:\s*([^;}]+)[;}]",
                               re.IGNORECASE)
VAR_RE = re.compile(r"^var\(\s*(--[a-z0-9-]+)\s*\)$")
LITERAL_PX_RE = re.compile(r"^([0-9.]+)px$")
LITERAL_REM_RE = re.compile(r"^([0-9.]+)rem$")
HEIGHT_RE = re.compile(
    r"(?:^|[;{\s])(min-height|height|min-block-size|block-size)\s*:\s*([^;}]+)[;}]",
    re.IGNORECASE)
TOKEN_DEF_RE = re.compile(r"(?:^|[{;])\s*(--[a-z0-9-]+)\s*:\s*([^;}]+)[;}]",
                          re.MULTILINE)


def px_value(value: str) -> float | None:
    value = value.strip()
    m = LITERAL_PX_RE.match(value)
    if m:
        return float(m.group(1))
    m = LITERAL_REM_RE.match(value)
    if m:
        return float(m.group(1)) * 16.0
    if value.endswith("em") and not value.endswith("rem"):
        try:
            return float(value[:-2]) * 16.0
        except ValueError:
            return None
    return None


def css_files() -> list[Path]:
    return sorted(
        p for p in SRC.rglob("*.css")
        if not any(part in EXCLUDED_PARTS for part in p.parts)
    )


def strip_comments(text: str) -> str:
    return re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), text,
                  flags=re.DOTALL)


def selector_for_offset(text: str, offset: int) -> str:
    """Best-effort: the selector text preceding the block containing offset."""
    open_brace = text.rfind("{", 0, offset)
    if open_brace == -1:
        return ""
    prev_close = max(text.rfind("}", 0, open_brace), text.rfind(";", 0, open_brace))
    return text[prev_close + 1:open_brace].strip()


def in_media_block(text: str, offset: int) -> bool:
    depth = 0
    i = offset
    while i > 0:
        i -= 1
        ch = text[i]
        if ch == "}":
            depth += 1
        elif ch == "{":
            if depth == 0:
                head = text[max(0, i - 200):i]
                if "@media" in head.split("}")[-1]:
                    return True
                # keep walking: this open brace belongs to a rule inside
                # a possible @media block
                continue
            depth -= 1
    return False


def check_font_sizes(rel: str, text: str, failures: list[str]) -> None:
    exempt = rel in DISPLAY_EXEMPT
    is_map = f"/{MAP_PATH_PART}/" in rel.replace("\\", "/")
    for m in FONT_SIZE_RE.finditer(text):
        raw = m.group(1).strip()
        line = text.count("\n", 0, m.start()) + 1
        if raw in ("inherit", "unset", "initial"):
            continue
        var_m = VAR_RE.match(raw)
        if var_m:
            token = var_m.group(1)
            if token in ALLOWED_FONT_TOKENS:
                continue
            if token == MAP_CHIP_TOKEN and is_map:
                continue
            if token == MAP_CHIP_TOKEN:
                failures.append(
                    f"{rel}:{line}: {MAP_CHIP_TOKEN} is map-density-only "
                    f"(§7 exemption); this file is outside components/map/")
                continue
            failures.append(
                f"{rel}:{line}: font-size token {token} is off the ratified "
                f"scale (allowed: {', '.join(sorted(ALLOWED_FONT_TOKENS))})")
            continue
        px = px_value(raw)
        if exempt and px is not None and px > 24:
            continue  # declared display scale
        if exempt and px is not None:
            failures.append(
                f"{rel}:{line}: font-size {raw} — DISPLAY_EXEMPT only covers "
                f"sizes above the 24px page title; use a scale token")
            continue
        failures.append(
            f"{rel}:{line}: literal font-size {raw!r} — use the scale tokens "
            f"({', '.join(sorted(ALLOWED_FONT_TOKENS))})")


def check_font_shorthand(rel: str, text: str, failures: list[str]) -> None:
    for m in FONT_SHORTHAND_RE.finditer(text):
        raw = m.group(1).strip()
        # Fail closed (adversarial pre-review F2): var() indirection and
        # system-font keywords (font: caption) can smuggle a size, so only
        # the keyword resets pass.
        if raw in ("inherit", "unset", "initial"):
            continue
        line = text.count("\n", 0, m.start()) + 1
        failures.append(
            f"{rel}:{line}: font shorthand {raw!r} — the shorthand can carry "
            f"a size; declare font-family/font-size separately with scale "
            f"tokens (only font: inherit/unset/initial pass)")


def check_heights(rel: str, text: str, failures: list[str]) -> None:
    # Structural values that cannot be an off-token control height.
    height_pass = {"auto", "inherit", "unset", "initial", "100%",
                   "fit-content", "min-content", "max-content", "0"}
    for m in HEIGHT_RE.finditer(text):
        prop, raw = m.group(1).lower(), m.group(2).strip()
        selector = selector_for_offset(text, m.start())
        if not CONTROL_SELECTOR_RE.search(selector):
            continue
        # DISPLAY_EXEMPT covers display-scale FONT SIZES only (review
        # 98c0a9e3): controls in those files still ride the 36/48 contract.
        line = text.count("\n", 0, m.start()) + 1
        var_m = VAR_RE.match(raw)
        if var_m:
            if var_m.group(1) in CONTROL_TOKENS:
                continue
            # Adversarial pre-review F3: a non-control token here is the
            # HIGH-innocence bypass (height: var(--space-10)); fail closed.
            failures.append(
                f"{rel}:{line}: {prop}: {raw} on control selector "
                f"{selector!r} — controls use var(--control-compact) or "
                f"var(--control-standard) (design 77950a97 §7)")
            continue
        if raw.lower() in height_pass:
            continue
        px = px_value(raw)
        if px is None:
            # calc(), !important, var-with-fallback, anything unparseable:
            # fail closed rather than silently passing (pre-review F3).
            failures.append(
                f"{rel}:{line}: {prop}: {raw!r} on control selector "
                f"{selector!r} is not verifiable against the two control "
                f"sizes — use var(--control-compact|standard) or a plain "
                f"out-of-band length")
            continue
        if not (CONTROL_BAND_PX[0] <= px <= CONTROL_BAND_PX[1]):
            continue
        if (prop in ("min-height", "min-block-size") and px == TOUCH_FLOOR_PX
                and in_media_block(text, m.start())):
            continue  # WCAG touch floor under a responsive query
        failures.append(
            f"{rel}:{line}: {prop}: {raw} on control selector {selector!r} — "
            f"controls use var(--control-compact) 36px or "
            f"var(--control-standard) 48px (design 77950a97 §7)")


def check_token_definitions(failures: list[str]) -> None:
    text = strip_comments(VARIABLES.read_text(encoding="utf-8"))
    defs: dict[str, list[str]] = {}
    for m in TOKEN_DEF_RE.finditer(text):
        defs.setdefault(m.group(1), []).append(m.group(2).strip())
    for token, expected in {**ALLOWED_FONT_TOKENS, **CONTROL_TOKENS}.items():
        values = defs.get(token)
        if not values:
            failures.append(
                f"variables.css: required token {token} is not defined "
                f"(expected {expected})")
        elif any(v != expected for v in values):
            failures.append(
                f"variables.css: {token} is {values} — the ratified value is "
                f"{expected}; the scale changes only by declared amendment")
    for token in RETIRED_FONT_TOKENS:
        if token in defs:
            failures.append(
                f"variables.css: {token} was retired by RH-UI.20 (off the "
                f"24/20/14/12 scale) and must not be redefined")
    if MAP_CHIP_TOKEN in defs:
        for v in defs[MAP_CHIP_TOKEN]:
            px = px_value(v)
            if px is None or not (MAP_CHIP_VALUE_MIN_PX <= px <= MAP_CHIP_VALUE_MAX_PX):
                failures.append(
                    f"variables.css: {MAP_CHIP_TOKEN} is {v!r} — the §7 map-chip "
                    f"exemption allows {MAP_CHIP_VALUE_MIN_PX}px minimum, "
                    f"below the {MAP_CHIP_VALUE_MAX_PX}px floor only")


def check_foreign_definitions(rel: str, text: str, failures: list[str]) -> None:
    guarded = set(ALLOWED_FONT_TOKENS) | set(CONTROL_TOKENS) | {MAP_CHIP_TOKEN}
    for m in TOKEN_DEF_RE.finditer(text):
        token = m.group(1)
        if token in guarded or token in RETIRED_FONT_TOKENS:
            line = text.count("\n", 0, m.start()) + 1
            failures.append(
                f"{rel}:{line}: {token} may be defined only in "
                f"styles/variables.css")


def check_retired_token_use(rel: str, text: str, failures: list[str]) -> None:
    for token in RETIRED_FONT_TOKENS:
        for m in re.finditer(re.escape(f"var({token})"), text):
            line = text.count("\n", 0, m.start()) + 1
            failures.append(
                f"{rel}:{line}: var({token}) — retired off-scale token; map to "
                f"the 24/20/14/12 scale")


def main() -> int:
    failures: list[str] = []
    files = css_files()
    present = {str(p.relative_to(ROOT)).replace("\\", "/") for p in files}

    for path, reason in sorted(DISPLAY_EXEMPT.items()):
        if path not in present:
            failures.append(
                f"{path}: listed in DISPLAY_EXEMPT ({reason}) but absent from "
                f"the tree — remove the stale exemption")

    check_token_definitions(failures)

    for p in files:
        rel = str(p.relative_to(ROOT)).replace("\\", "/")
        text = strip_comments(p.read_text(encoding="utf-8"))
        check_font_sizes(rel, text, failures)
        check_font_shorthand(rel, text, failures)
        check_heights(rel, text, failures)
        check_retired_token_use(rel, text, failures)
        if p != VARIABLES:
            check_foreign_definitions(rel, text, failures)

    if failures:
        print("Type-scale gate FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        print(f"  ({len(failures)} finding(s))", file=sys.stderr)
        return 1
    print(f"Type-scale gate passed ({len(files)} stylesheets on the "
          f"24/20/14/12 scale, controls on 36/48, "
          f"{len(DISPLAY_EXEMPT)} declared display exemptions)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
