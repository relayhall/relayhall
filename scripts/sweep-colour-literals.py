#!/usr/bin/env python3
"""Deterministic colour-literal sweep (task 13cbb482, RH-UI.1b subtask 0).

Rewrites colour literals in the frontend stylesheets to semantic design
tokens, driven entirely by the committed mapping table
scripts/colour-sweep-map.json — so the sweep is reviewable as data,
re-runnable byte-for-byte, and idempotent (replacements are var()
references, which the literal patterns never match again).

Mapping semantics:
  { "hex":  { "#ef4444": "var(--danger-color)", ... },
    "rgb":  { "rgba(255,255,255,0.08)": {"border": "var(--border-subtle)",
                                          "*": "var(--overlay-medium)"}, ... } }
Values are either a replacement string for every context, or an object keyed
by property class — border | background | shadow | text | * — resolved from
the CSS property the literal appears under. rgb() keys are normalised by
stripping whitespace and lowercasing.

After substitution every declaration is NORMALISED: a fallback that became
self-referential — `var(--x, var(--x))` — collapses to `var(--x)` (review
d2ca332b F3: the pre-token fallback floor is superseded by the existence
gate, and a self-reference cannot resolve independently anyway); a fallback
mapped to a DIFFERENT token stays as an independently resolvable
`var(--x, var(--y))`.

A third section, "legacy", maps retired raw-ramp token REFERENCES
(`var(--purple-500)` and friends) to semantic tokens with the same
context-keyed semantics — the mechanism that empties the legacy-compatibility
block so it can be deleted.

Modes:
  (default)   apply the mapping in place
  --check     apply nothing; list every distinct literal the mapping does not
              cover, with per-value use counts (exit 1 if any remain)

The token-definition file (styles/variables.css) is never touched. The gate
that enforces the end state is scripts/check-design-tokens.py's ratchet; this
script is the mechanism that gets the tree there.
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
MAP_PATH = Path(__file__).resolve().parent / "colour-sweep-map.json"
EXCLUDED_PARTS = {".git", "node_modules", "dist", "coverage"}
TOKEN_FILES = {"frontend/src/styles/variables.css"}

DECL_START_RE = re.compile(r"([-\w]+)\s*:\s*")
HEX_RE = re.compile(r"#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b")
RGB_RE = re.compile(r"rgba?\([^)]*\)")
SELF_FALLBACK_RE = re.compile(r"var\(\s*(--[\w-]+)\s*,\s*var\(\s*\1\s*\)\s*\)")

# Matches the token name in any var() form, including with a fallback —
# `var(--old, …)` rewrites to `var(--new, …)` (the fallback is preserved).
LEGACY_REF_RE = re.compile(r"(var\(\s*)(--[\w-]+)")

BORDER_PROPS = ("border", "outline", "stroke")
BACKGROUND_PROPS = ("background", "fill")
SHADOW_PROPS = ("box-shadow", "text-shadow", "filter")
TEXT_PROPS = ("color", "caret-color", "-webkit-text-fill-color", "text-decoration")


def property_class(prop: str) -> str:
    prop = prop.lower()
    if prop.startswith(SHADOW_PROPS):
        return "shadow"
    if prop.startswith(BORDER_PROPS):
        return "border"
    if prop.startswith(BACKGROUND_PROPS):
        return "background"
    if prop == "color" or prop.startswith(TEXT_PROPS):
        return "text"
    if prop == "scrollbar-color":
        return "border"
    return "*"


def normalise(value: str) -> str:
    return re.sub(r"\s+", "", value.lower())


def lookup(entry, prop_cls: str) -> str | None:
    if entry is None:
        return None
    if isinstance(entry, str):
        return entry
    return entry.get(prop_cls) or entry.get("*")


def url_spans(value: str) -> list[tuple[int, int]]:
    """Return complete CSS url() spans, including quoted/nested payloads."""
    spans: list[tuple[int, int]] = []
    cursor = 0
    while match := re.search(r"(?<![\w-])url\s*\(", value[cursor:], re.IGNORECASE):
        start = cursor + match.start()
        index = cursor + match.end()
        depth = 1
        quote = ""
        while index < len(value) and depth:
            char = value[index]
            if quote:
                if char == "\\":
                    index = min(len(value), index + 2)
                    continue
                if char == quote:
                    quote = ""
            elif char in "\"'":
                quote = char
            elif char == "\\":
                index = min(len(value), index + 2)
                continue
            elif char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
            index += 1
        spans.append((start, index))
        cursor = index
    return spans


def declaration_spans(text: str) -> list[tuple[int, int, str, int]]:
    """Return declarations without splitting strings or CSS functions."""
    spans: list[tuple[int, int, str, int]] = []
    index = 0
    while index < len(text):
        if text.startswith("/*", index):
            close = text.find("*/", index + 2)
            index = len(text) if close < 0 else close + 2
            continue
        if text[index] in "\"'":
            quote = text[index]
            index += 1
            while index < len(text):
                if text[index] == "\\":
                    index = min(len(text), index + 2)
                    continue
                if text[index] == quote:
                    index += 1
                    break
                index += 1
            continue
        if text[index] not in "{;":
            index += 1
            continue

        start = index + 1
        while start < len(text):
            if text[start].isspace():
                start += 1
                continue
            if text.startswith("/*", start):
                close = text.find("*/", start + 2)
                start = len(text) if close < 0 else close + 2
                continue
            break
        match = DECL_START_RE.match(text, start)
        if match is None:
            index += 1
            continue

        prop = match.group(1)
        value_start = match.end()
        cursor = value_start
        depth = 0
        quote = ""
        while cursor < len(text):
            char = text[cursor]
            if quote:
                if char == "\\":
                    cursor = min(len(text), cursor + 2)
                    continue
                if char == quote:
                    quote = ""
            elif text.startswith("/*", cursor):
                close = text.find("*/", cursor + 2)
                cursor = len(text) if close < 0 else close + 2
                continue
            elif char in "\"'":
                quote = char
            elif char == "\\":
                cursor = min(len(text), cursor + 2)
                continue
            elif char == "(":
                depth += 1
            elif char == ")" and depth:
                depth -= 1
            elif depth == 0 and char in ";}":
                break
            cursor += 1
        spans.append((start, cursor, prop, value_start))
        index = cursor
    return spans


def css_files() -> list[Path]:
    return sorted(
        p for p in SRC.rglob("*.css")
        if not any(part in EXCLUDED_PARTS for part in p.parts)
        and str(p.relative_to(ROOT)) not in TOKEN_FILES
    )


def sweep_text(text: str, mapping: dict, unmapped: Counter, apply: bool) -> str:
    hex_map = mapping.get("hex", {})
    rgb_map = mapping.get("rgb", {})
    legacy_map = mapping.get("legacy", {})

    def rewrite_declaration(original: str, prop: str, value: str) -> str:
        cls = property_class(prop)
        replaced = 0

        def sub_hex(hm: re.Match) -> str:
            nonlocal replaced
            key = hm.group(0).lower()
            repl = lookup(hex_map.get(key), cls)
            if repl is None:
                unmapped[f"{key} [{cls}]"] += 1
                return hm.group(0)
            replaced += 1
            return repl if apply else hm.group(0)

        def sub_rgb(rm: re.Match) -> str:
            nonlocal replaced
            key = normalise(rm.group(0))
            repl = lookup(rgb_map.get(key), cls)
            if repl is None:
                unmapped[f"{key} [{cls}]"] += 1
                return rm.group(0)
            replaced += 1
            return repl if apply else rm.group(0)

        def sub_legacy(lm: re.Match) -> str:
            nonlocal replaced
            entry = legacy_map.get(lm.group(2))
            if entry is None:
                return lm.group(0)
            repl = lookup(entry, cls)
            if repl is None:
                unmapped[f"{lm.group(2)} [{cls}]"] += 1
                return lm.group(0)
            inner = re.fullmatch(r"var\(\s*(--[\w-]+)\s*\)", repl)
            if inner is None:
                unmapped[f"{lm.group(2)} [{cls}] (unusable mapping {repl!r})"] += 1
                return lm.group(0)
            replaced += 1
            return (lm.group(1) + inner.group(1)) if apply else lm.group(0)

        def rewrite_segment(segment: str) -> str:
            segment = HEX_RE.sub(sub_hex, segment)
            segment = RGB_RE.sub(sub_rgb, segment)
            return LEGACY_REF_RE.sub(sub_legacy, segment)

        # A URL payload is data/reference syntax, never a stylesheet colour
        # declaration. Rewriting `url(#fff)` corrupts SVG filter/paint-server
        # references, and counting it as unmapped makes --check lie.
        pieces: list[str] = []
        cursor = 0
        for start, end in url_spans(value):
            pieces.append(rewrite_segment(value[cursor:start]))
            pieces.append(value[start:end])
            cursor = end
        pieces.append(rewrite_segment(value[cursor:]))
        value = "".join(pieces)
        before = None
        while before != value:
            before = value
            value = SELF_FALLBACK_RE.sub(r"var(\1)", value)
            if value != before:
                replaced += 1
        # A declaration with no replacement is returned byte-identical.
        if not apply or not replaced:
            return original
        return f"{prop}: {value.lstrip()}" if not value.startswith(" ") else f"{prop}:{value}"

    pieces: list[str] = []
    cursor = 0
    for start, end, prop, value_start in declaration_spans(text):
        pieces.append(text[cursor:start])
        original = text[start:end]
        pieces.append(rewrite_declaration(original, prop, text[value_start:end]))
        cursor = end
    pieces.append(text[cursor:])
    return "".join(pieces)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="report unmapped literals; change nothing")
    args = parser.parse_args()

    mapping = json.loads(MAP_PATH.read_text(encoding="utf-8"))
    unmapped: Counter = Counter()
    changed = 0
    for p in css_files():
        text = p.read_text(encoding="utf-8")
        new = sweep_text(text, mapping, unmapped, apply=not args.check)
        if not args.check and new != text:
            p.write_text(new, encoding="utf-8")
            changed += 1

    if unmapped:
        print(f"{len(unmapped)} distinct literal(s) not covered by the mapping:",
              file=sys.stderr)
        for key, count in unmapped.most_common():
            print(f"  {key} x{count}", file=sys.stderr)
        if args.check:
            return 1
        print("(unmapped literals left in place — extend scripts/colour-sweep-map.json)",
              file=sys.stderr)
        return 1
    if args.check:
        print("colour sweep: mapping covers every literal outside the token file")
        return 0
    print(f"colour sweep applied: {changed} stylesheet(s) rewritten")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
