#!/usr/bin/env python3
"""Design-token gate: token existence + literal-colour ratchet.

Existence (task e98447ee): every `var(--name …)` reference in the frontend
stylesheets must resolve to a custom property that is actually defined
somewhere in the CSS tree, or to a property set at runtime from JSX/TS
(allowlisted below). A reference to an undefined token without a fallback is
dropped wholesale at invalid-at-computed-value time — the surface renders
transparent, the border vanishes — which is exactly the RH-P1.5c
owner-preview regression; a reference with a fallback silently paints an
off-palette literal. Both are defects.

Literal-colour ratchet (task ae0f3f5c, RH-DESIGN.6 §4.2): colour literals —
hex, rgb()/rgba(), and NAMED CSS colours (`white`, `red`, …) — are allowed
ONLY in token-definition files. Named colours were added by RH-UI.1c after
`color: white` on 30 filled affordances slipped past a hex-and-rgb-only
ratchet and shipped a 2.26:1 label. `transparent`, `currentColor` and
`inherit` are keywords, not colours, and stay legal. The estate
carried 1300+ pre-existing literals when the rule landed; they are frozen
per-file in scripts/design-literal-baseline.json and may only DECREASE:
  - a file not in the baseline may contain no colour literal at all;
  - a count above its baseline entry fails (new literals never land);
  - a count below its baseline entry fails too, with instructions to tighten
    the baseline in the same commit (--update-literal-baseline), so the
    ratchet is always exact and regressions can never hide in slack;
  - a baseline entry whose file is gone fails until the entry is removed.
--update-literal-baseline rewrites the baseline from the tree but REFUSES to
raise any count or admit a new file: the ratchet only ever tightens. RH-UI.1b
drives the baseline to empty, after which the rule is absolute.

Shadow-composite rule (review c562131e): a shadow property
(`box-shadow`/`text-shadow`) whose entire value is a single `var(--t)` must
reference a token resolving to a COMPLETE shadow value (offsets + blur), never
a bare colour — `box-shadow: var(--accent-soft)` is discarded at parse time,
silently deleting the effect.

Definitions are collected from EVERY declaration in the CSS tree, not just
styles/variables.css's :root — components may legitimately define scoped
properties on their own selectors (see StatusOrb.css).

CSS comments are removed with line breaks preserved before every syntax scan.
This prevents commented pseudo-declarations from satisfying live var()
references, and keeps commented references/literals/advisory media queries
from affecting the gate while retaining truthful source line numbers.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSS_ROOT = ROOT / "frontend" / "src"
EXCLUDED_PARTS = {".git", "node_modules", "dist", "coverage"}

# The only stylesheets allowed to declare colour literals (RH-DESIGN.6 §4.1:
# primitive ramps and theme-bound values live here and nowhere else).
TOKEN_DEFINITION_FILES = {
    "frontend/src/styles/variables.css",
}

LITERAL_BASELINE_PATH = Path(__file__).resolve().parent / "design-literal-baseline.json"

# Custom properties set at runtime (element style / setProperty) and therefore
# never declared in CSS. Each entry names its set-site so the allowlist stays
# verifiable; a property removed from the code should be removed here too.
RUNTIME_PROPERTIES = {
    "--personality-color",  # PersonalitiesPage.tsx / PersonalityDetailPage.tsx card style
    "--badge-color",        # components/PersonalityBadge.tsx
    "--principal-hue",      # components/PrincipalAvatar.tsx
    "--config-primary",     # contexts/RelayHallConfigContext.tsx branding
    "--config-accent",      # contexts/RelayHallConfigContext.tsx branding
    "--config-bg",          # contexts/RelayHallConfigContext.tsx branding
    "--config-surface",     # contexts/RelayHallConfigContext.tsx branding
    "--config-text",        # contexts/RelayHallConfigContext.tsx branding
}

# Breakpoint canon (RH-DESIGN.6 §4.2): 640/768/1024/1280 plus their max-width
# complements. Off-canon values WARN, never fail (the ratified soft gate).
CANON_BREAKPOINTS = {639, 640, 767, 768, 1023, 1024, 1279, 1280}
MEDIA_PX_RE = re.compile(r"@media[^{]*?\(\s*(?:min|max)-width\s*:\s*(\d+)px")

DEFINITION_RE = re.compile(r"(?:^|[;{])\s*(--[\w-]+)\s*:", re.MULTILINE)
REFERENCE_RE = re.compile(r"var\(\s*(--[\w-]+)")
HEX_LITERAL_RE = re.compile(r"#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b")
# Every CSS named colour from CSS Color 4. `transparent` / `currentColor` /
# `inherit` are deliberately NOT here: they carry no fixed palette value.
CSS_NAMED_COLOURS = frozenset({
    "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige",
    "bisque", "black", "blanchedalmond", "blue", "blueviolet", "brown",
    "burlywood", "cadetblue", "chartreuse", "chocolate", "coral",
    "cornflowerblue", "cornsilk", "crimson", "cyan", "darkblue", "darkcyan",
    "darkgoldenrod", "darkgray", "darkgreen", "darkgrey", "darkkhaki",
    "darkmagenta", "darkolivegreen", "darkorange", "darkorchid", "darkred",
    "darksalmon", "darkseagreen", "darkslateblue", "darkslategray",
    "darkslategrey", "darkturquoise", "darkviolet", "deeppink", "deepskyblue",
    "dimgray", "dimgrey", "dodgerblue", "firebrick", "floralwhite",
    "forestgreen", "fuchsia", "gainsboro", "ghostwhite", "gold", "goldenrod",
    "gray", "green", "greenyellow", "grey", "honeydew", "hotpink",
    "indianred", "indigo", "ivory", "khaki", "lavender", "lavenderblush",
    "lawngreen", "lemonchiffon", "lightblue", "lightcoral", "lightcyan",
    "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey", "lightpink",
    "lightsalmon", "lightseagreen", "lightskyblue", "lightslategray",
    "lightslategrey", "lightsteelblue", "lightyellow", "lime", "limegreen",
    "linen", "magenta", "maroon", "mediumaquamarine", "mediumblue",
    "mediumorchid", "mediumpurple", "mediumseagreen", "mediumslateblue",
    "mediumspringgreen", "mediumturquoise", "mediumvioletred", "midnightblue",
    "mintcream", "mistyrose", "moccasin", "navajowhite", "navy", "oldlace",
    "olive", "olivedrab", "orange", "orangered", "orchid", "palegoldenrod",
    "palegreen", "paleturquoise", "palevioletred", "papayawhip", "peachpuff",
    "peru", "pink", "plum", "powderblue", "purple", "rebeccapurple", "red",
    "rosybrown", "royalblue", "saddlebrown", "salmon", "sandybrown",
    "seagreen", "seashell", "sienna", "silver", "skyblue", "slateblue",
    "slategray", "slategrey", "snow", "springgreen", "steelblue", "tan",
    "teal", "thistle", "tomato", "turquoise", "violet", "wheat", "white",
    "whitesmoke", "yellow", "yellowgreen",
})

CSS_ESCAPE = r"\\(?:[0-9a-fA-F]{1,6}[ \t\r\n\f]?|[^\r\n\f0-9a-fA-F])"
CSS_ESCAPE_RE = re.compile(CSS_ESCAPE)
CSS_NAME_START = rf"(?:[_a-zA-Z\u0080-\U0010ffff-]|{CSS_ESCAPE})"
CSS_NAME_CHAR = rf"(?:[_a-zA-Z0-9\u0080-\U0010ffff-]|{CSS_ESCAPE})"
CSS_IDENTIFIER = rf"-?{CSS_NAME_START}{CSS_NAME_CHAR}*"
CSS_IDENTIFIER_RE = re.compile(CSS_IDENTIFIER)
AT_PROPERTY_RE = re.compile(rf"@property\s+{CSS_IDENTIFIER}\s*\{{", re.IGNORECASE)

COLOUR_PROPERTY_PREFIXES = (
    "background",
    "border",
    "column-rule",
    "outline",
    "text-decoration",
    "text-emphasis",
)
COLOUR_PROPERTIES = {
    "-webkit-text-stroke",
    "-webkit-mask",
    "box-shadow",
    "content",
    "fill",
    "filter",  # drop-shadow() accepts a colour
    "list-style",
    "list-style-image",
    "mask",
    "mask-border",
    "mask-border-source",
    "mask-image",
    "shape-outside",
    "stroke",
    "text-shadow",
}

LITERAL_KINDS = ("hex", "rgb", "named")


def css_escape_end(text: str, start: int) -> int:
    """Return the end of one CSS escape beginning at *start*.

    Hex escapes consume up to six digits and their optional trailing CSS
    whitespace. Simple escapes consume the following non-newline code point.
    An invalid trailing backslash or backslash-newline consumes only the slash.
    """
    match = CSS_ESCAPE_RE.match(text, start)
    return match.end() if match is not None else start + 1


def css_url_end(text: str, start: int) -> int | None:
    """Return the end of a complete url(...) token that starts at *start*."""
    if text[start:start + 3].lower() != "url":
        return None
    if start > 0 and (text[start - 1].isalnum() or text[start - 1] in {"_", "-"}):
        return None

    i = start + 3
    if i >= len(text) or text[i] != "(":
        return None

    depth = 1
    quote: str | None = None
    i += 1
    while i < len(text):
        char = text[i]
        if char == "\\":
            i = css_escape_end(text, i)
            continue
        if quote is not None:
            if char == quote:
                quote = None
            i += 1
            continue
        if char in {'"', "'"}:
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return None


def strip_css_comments(text: str) -> str:
    """Remove real comments while preserving strings, url() data and line numbers."""
    chars = list(text)
    i = 0
    quote: str | None = None
    while i < len(chars):
        char = chars[i]
        if quote is not None:
            if char == "\\":
                i += 2
                continue
            if char == quote:
                quote = None
            i += 1
            continue
        if char in {'"', "'"}:
            quote = char
            i += 1
            continue
        url_end = css_url_end(text, i)
        if url_end is not None:
            i = url_end
            continue
        if char == "/" and i + 1 < len(chars) and chars[i + 1] == "*":
            chars[i] = chars[i + 1] = " "
            i += 2
            while i < len(chars):
                if chars[i] == "*" and i + 1 < len(chars) and chars[i + 1] == "/":
                    chars[i] = chars[i + 1] = " "
                    i += 2
                    break
                if chars[i] != "\n":
                    chars[i] = " "
                i += 1
            continue
        i += 1
    return "".join(chars)


def mask_css_non_syntax(text: str) -> str:
    """Mask comments, strings and complete url() tokens without moving bytes."""
    text = strip_css_comments(text)
    masked = list(text)

    def blank(start: int, end: int) -> None:
        for index in range(start, end):
            if masked[index] not in "\r\n":
                masked[index] = " "

    index = 0
    while index < len(text):
        char = text[index]
        if char in {'"', "'"}:
            quote = char
            end = index + 1
            while end < len(text):
                if text[end] == "\\":
                    end = min(len(text), end + 2)
                    continue
                if text[end] == quote:
                    end += 1
                    break
                end += 1
            blank(index, end)
            index = end
            continue

        url_end = css_url_end(text, index)
        if url_end is not None:
            blank(index, url_end)
            index = url_end
            continue
        index += 1
    return "".join(masked)


def decode_css_identifier(identifier: str) -> str:
    """Decode CSS identifier escapes for property and literal comparison."""
    decoded: list[str] = []
    index = 0
    while index < len(identifier):
        if identifier[index] != "\\":
            decoded.append(identifier[index])
            index += 1
            continue

        index += 1
        start = index
        while index < len(identifier) and index - start < 6 and identifier[index] in "0123456789abcdefABCDEF":
            index += 1
        if index > start:
            codepoint = int(identifier[start:index], 16)
            if index < len(identifier) and identifier[index] in " \t\r\n\f":
                index += 1
            valid = codepoint and codepoint <= 0x10FFFF and not 0xD800 <= codepoint <= 0xDFFF
            decoded.append(chr(codepoint) if valid else "\ufffd")
        elif index < len(identifier):
            decoded.append(identifier[index])
            index += 1
    return "".join(decoded)


def property_carries_colour(property_name: str, *, in_at_property: bool = False) -> bool:
    """True for declarations whose grammar can carry a fixed CSS colour."""
    name = decode_css_identifier(property_name).lower()
    return (
        name.startswith("--")
        or (in_at_property and name == "initial-value")
        or "color" in name
        or "colour" in name
        or name in COLOUR_PROPERTIES
        or name.startswith(COLOUR_PROPERTY_PREFIXES)
    )


def matching_curly_end(text: str, opening: int) -> int:
    """Return the offset after the balanced block at *opening*, or EOF."""
    depth = 1
    index = opening + 1
    while index < len(text):
        if text[index] == "\\":
            index = css_escape_end(text, index)
            continue
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return index + 1
        index += 1
    return len(text)


def at_property_ranges(masked: str) -> list[tuple[int, int]]:
    """Content ranges of balanced @property blocks in masked CSS."""
    ranges: list[tuple[int, int]] = []
    for match in AT_PROPERTY_RE.finditer(masked):
        opening = match.end() - 1
        ranges.append((opening + 1, matching_curly_end(masked, opening) - 1))
    return ranges


def declaration_value_end(text: str, start: int, *, allow_curly: bool) -> tuple[int, bool]:
    """Find a declaration's top-level semicolon/block end.

    Parentheses and square brackets always form component values. Curly simple
    blocks are valid in custom-property values; for ordinary properties a
    top-level opening curly identifies a nested selector, not a declaration.
    The boolean is false for that selector-shaped case.
    """
    closing: list[str] = []
    pairs = {"(": ")", "[": "]", "{": "}"}
    index = start
    while index < len(text):
        char = text[index]
        if char == "\\":
            index = css_escape_end(text, index)
            continue
        if char in pairs:
            if char == "{" and not closing and not allow_curly:
                return index, False
            closing.append(pairs[char])
        elif char in ")]}":
            if closing and char == closing[-1]:
                closing.pop()
            elif char == "}" and not closing:
                return index, True
        elif char == ";" and not closing:
            return index, True
        index += 1
    return len(text), True


def colour_values(masked: str) -> list[str]:
    """Return colour-bearing declaration values using balanced CSS components."""
    ranges = at_property_ranges(masked)
    depths = [0] * len(masked)
    depth = 0
    index = 0
    while index < len(masked):
        depths[index] = depth
        char = masked[index]
        if char == "\\":
            end = css_escape_end(masked, index)
            for escaped in range(index + 1, end):
                depths[escaped] = depth
            index = end
            continue
        if char == "{":
            depth += 1
        elif char == "}" and depth:
            depth -= 1
        index += 1

    values: list[str] = []
    search = 0
    while match := CSS_IDENTIFIER_RE.search(masked, search):
        start = match.start()
        search = match.end()
        if not depths[start]:
            continue
        previous = start - 1
        while previous >= 0 and masked[previous].isspace():
            previous -= 1
        if previous >= 0 and masked[previous] not in "{;":
            continue

        colon = match.end()
        while colon < len(masked) and masked[colon].isspace():
            colon += 1
        if colon >= len(masked) or masked[colon] != ":":
            continue

        in_at_property = any(first <= start < last for first, last in ranges)
        property_name = decode_css_identifier(match.group()).lower()
        if not property_carries_colour(match.group(), in_at_property=in_at_property):
            continue

        value_start = colon + 1
        value_end, is_declaration = declaration_value_end(
            masked,
            value_start,
            allow_curly=property_name.startswith("--"),
        )
        if not is_declaration:
            continue
        values.append(masked[value_start:value_end])
        search = value_end
    return values


def mask_function_roles(value: str) -> str:
    """Mask identifiers that name attr/env inputs or paint worklets.

    Only the first identifier is grammar metadata. Later component values,
    including attr()/env() fallbacks and paint() arguments, remain visible.
    """
    masked = list(value)
    for function in CSS_IDENTIFIER_RE.finditer(value):
        if function.end() >= len(value) or value[function.end()] != "(":
            continue
        if decode_css_identifier(function.group()).lower() not in {"attr", "env", "paint"}:
            continue
        first = function.end() + 1
        while first < len(value) and value[first].isspace():
            first += 1
        role = CSS_IDENTIFIER_RE.match(value, first)
        if role is None:
            continue
        for index in range(role.start(), role.end()):
            if masked[index] not in "\r\n":
                masked[index] = " "
    return "".join(masked)


def identifier_literals(value: str) -> tuple[int, int]:
    """Count decoded rgb()/rgba() functions and exact named-colour tokens."""
    value = mask_function_roles(value)
    rgb = 0
    named = 0
    for match in CSS_IDENTIFIER_RE.finditer(value):
        if match.start() and value[match.start() - 1] == "#":
            continue
        identifier = decode_css_identifier(match.group()).lower()
        if identifier in {"rgb", "rgba"} and match.end() < len(value) and value[match.end()] == "(":
            rgb += 1
        if identifier in CSS_NAMED_COLOURS:
            named += 1
    return rgb, named


def collect_definition_values(css_texts: list[str]) -> dict[str, str]:
    """Custom property -> its declared value (last declaration wins)."""
    values: dict[str, str] = {}
    for text in css_texts:
        text = strip_css_comments(text)
        for name, value in re.findall(
                r"(?:^|[;{])\s*(--[\w-]+)\s*:\s*([^;}]*)", text, re.MULTILINE):
            values[name] = value.strip()
    return values


def collect_definitions(css_texts: list[str]) -> set[str]:
    """Every custom property declared anywhere in the given CSS texts."""
    defined: set[str] = set()
    for text in css_texts:
        defined.update(DEFINITION_RE.findall(strip_css_comments(text)))
    return defined


def check_css_text(path: str, text: str, defined: set[str], failures: list[str]) -> None:
    """Report every var() reference to a token that nothing defines."""
    for number, line in enumerate(strip_css_comments(text).splitlines(), 1):
        for name in REFERENCE_RE.findall(line):
            if name in defined or name in RUNTIME_PROPERTIES:
                continue
            failures.append(f"{path}:{number}: var({name}) references an undefined design token")


def count_literals(text: str) -> dict[str, int]:
    masked = mask_css_non_syntax(text)
    rgb, _ = identifier_literals(masked)
    named = sum(identifier_literals(value)[1] for value in colour_values(masked))
    return {
        "hex": len(HEX_LITERAL_RE.findall(masked)),
        "rgb": rgb,
        "named": named,
    }


def check_literal_text(path: str, text: str, baseline: dict, failures: list[str]) -> None:
    """Enforce the per-file literal ratchet on one stylesheet's text."""
    if path in TOKEN_DEFINITION_FILES:
        return
    counts = count_literals(text)
    frozen = baseline.get(path, {})
    for kind in LITERAL_KINDS:
        have = counts.get(kind, 0)
        allowed = int(frozen.get(kind, 0))
        if have > allowed:
            failures.append(
                f"{path}: {have} {kind} colour literal(s), ratchet allows {allowed} — "
                f"use semantic tokens (RH-DESIGN.6 §4.2); literals are legal only in "
                f"token-definition files")
        elif have < allowed:
            failures.append(
                f"{path}: {kind} literals fell to {have} but the ratchet still records "
                f"{allowed} — tighten scripts/design-literal-baseline.json in the same "
                f"commit (scripts/check-design-tokens.py --update-literal-baseline)")


SHADOW_DECL_RE = re.compile(
    r"(box-shadow|text-shadow)\s*:\s*(var\(\s*--[\w-]+\s*\))\s*(?:;|\})")
VAR_NAME_RE = re.compile(r"var\(\s*(--[\w-]+)")
LENGTH_RE = re.compile(r"(?<![\w-])-?[\d.]+(px|rem|em)")


def resolves_to_composite(token: str, definitions: dict[str, str], depth: int = 0) -> bool:
    """True when the token's value carries shadow geometry (offsets/blur)."""
    if depth > 10:
        return False
    value = definitions.get(token)
    if value is None:
        return False
    if LENGTH_RE.search(value):
        return True
    inner = VAR_NAME_RE.findall(value)
    return any(resolves_to_composite(name, definitions, depth + 1) for name in inner)


def check_shadow_composites(path: str, text: str, definitions: dict[str, str],
                            failures: list[str]) -> None:
    for prop, reference in SHADOW_DECL_RE.findall(strip_css_comments(text)):
        token = VAR_NAME_RE.findall(reference)[0]
        if not resolves_to_composite(token, definitions):
            failures.append(
                f"{path}: {prop}: {reference} resolves to a colour, not a shadow — "
                f"browsers discard it; use a composite token (e.g. --glow-accent)")


def breakpoint_warnings(path: str, text: str) -> list[str]:
    """Off-canon media-query widths — advisory only (soft gate, §4.2)."""
    return [
        f"{path}: off-canon breakpoint {v}px (canon: 640/768/1024/1280 + complements)"
        for v in MEDIA_PX_RE.findall(strip_css_comments(text))
        if int(v) not in CANON_BREAKPOINTS
    ]


def check_stale_baseline(baseline: dict, present: set[str], failures: list[str]) -> None:
    for path in sorted(baseline):
        if path not in present:
            failures.append(
                f"{path}: listed in scripts/design-literal-baseline.json but absent from "
                f"the tree — remove the stale entry (--update-literal-baseline)")


def tighten_baseline(old: dict, live_counts: dict[str, dict[str, int]]) -> tuple[dict, list[str]]:
    """New baseline from the tree; refuses to raise any count or admit a file."""
    refusals: list[str] = []
    new: dict[str, dict[str, int]] = {}
    for path, counts in sorted(live_counts.items()):
        if path in TOKEN_DEFINITION_FILES or not any(counts[k] for k in LITERAL_KINDS):
            continue
        frozen = old.get(path)
        if frozen is None:
            refusals.append(f"{path}: not in the baseline — new literals are never admitted")
            continue
        entry: dict[str, int] = {}
        for kind in LITERAL_KINDS:
            allowed = int(frozen.get(kind, 0))
            if counts.get(kind, 0) > allowed:
                refusals.append(
                    f"{path}: {kind} count {counts.get(kind, 0)} exceeds frozen {allowed} — "
                    f"the ratchet only tightens")
                entry[kind] = allowed
            elif counts.get(kind, 0):
                entry[kind] = counts[kind]
        if entry:
            new[path] = entry
    return new, refusals


def css_files() -> list[Path]:
    return sorted(
        p for p in CSS_ROOT.rglob("*.css")
        if not any(part in EXCLUDED_PARTS for part in p.parts)
    )


def load_baseline() -> dict:
    if not LITERAL_BASELINE_PATH.exists():
        return {}
    return json.loads(LITERAL_BASELINE_PATH.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--update-literal-baseline", action="store_true",
        help="rewrite the literal baseline from the tree (decreases only)")
    args = parser.parse_args()

    files = css_files()
    texts = {p: p.read_text(encoding="utf-8") for p in files}
    rel = {p: str(p.relative_to(ROOT)) for p in files}
    baseline = load_baseline()

    if args.update_literal_baseline:
        live = {rel[p]: count_literals(text) for p, text in texts.items()}
        new, refusals = tighten_baseline(baseline, live)
        if refusals:
            print("Literal baseline NOT updated:", file=sys.stderr)
            for r in refusals:
                print(f"  {r}", file=sys.stderr)
            return 1
        LITERAL_BASELINE_PATH.write_text(
            json.dumps(new, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"literal baseline tightened: {len(new)} file(s) still pending sweep")
        return 0

    defined = collect_definitions(list(texts.values()))
    definition_values = collect_definition_values(list(texts.values()))
    failures: list[str] = []
    warnings: list[str] = []
    for p, text in texts.items():
        check_css_text(rel[p], text, defined, failures)
        check_literal_text(rel[p], text, baseline, failures)
        check_shadow_composites(rel[p], text, definition_values, failures)
        warnings.extend(breakpoint_warnings(rel[p], text))
    check_stale_baseline(baseline, set(rel.values()), failures)

    for w in warnings:
        print(f"WARNING: {w}", file=sys.stderr)

    if failures:
        print("Design-token gate FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        return 1
    pending = len(baseline)
    print(
        f"Design-token contract passed ({len(files)} stylesheets, {len(defined)} defined "
        f"tokens, literal ratchet: {pending} file(s) pending sweep)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
