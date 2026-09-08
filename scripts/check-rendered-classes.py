#!/usr/bin/env python3
"""Rendered-class ownership gate (RH-UI.1b follow-up).

Every class a component RENDERS must be OWNED by some stylesheet — declared
standalone, not merely referenced through an ancestor or as a state modifier.

This exists because of a real regression. RH-UI.1b's de-collision sweep
namespaced and ancestor-scoped colliding classes; for classes rendered by MORE
than one component it moved the owning declaration out from under the other
renderers. `.modal-overlay` ended up owned by nobody, so Skill and Project
modals lost `position: fixed` and rendered inline in document flow, cut off.
Every existing gate passed: the tokens resolved, the collision audit was clean,
the tests were green, the build succeeded. Nothing checked that a rendered
class still had a rule.

The baseline in scripts/rendered-class-baseline.json freezes the classes that
were already unowned before this gate existed (mostly dead class names left on
elements). Like the literal ratchet it may only SHRINK: a new orphan fails, and
a fixed one must be removed from the baseline in the same commit.

Dynamic class fragments (`btn-${variant}`) are excluded: the constructed name
is only knowable at runtime, and the acceptance suite pins those separately.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from importlib.machinery import SourceFileLoader
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "frontend" / "src"
BASELINE_PATH = Path(__file__).resolve().parent / "rendered-class-baseline.json"

_audit = SourceFileLoader(
    "collision_audit",
    str(Path(__file__).resolve().parent / "audit-css-collisions.py")).load_module()

INTERPOLATION_RE = re.compile(r"[\w-]*\$\{[^}]*\}[\w-]*")
CLASS_NAME_RE = re.compile(r"[A-Za-z_][\w-]*")


def _skip_line_comment(source: str, start: int) -> int:
    end = source.find("\n", start + 2)
    return len(source) if end < 0 else end + 1


def _skip_block_comment(source: str, start: int) -> int:
    end = source.find("*/", start + 2)
    return len(source) if end < 0 else end + 2


def _looks_like_regex_start(source: str, start: int) -> bool:
    if start + 1 < len(source) and source[start + 1] == ">":
        return False
    j = start - 1
    while j >= 0 and source[j].isspace():
        j -= 1
    if j < 0 or source[j] in "=(:,[!&|?{};":
        return True
    end = j + 1
    while j >= 0 and (source[j].isalnum() or source[j] in "_$"):
        j -= 1
    return source[j + 1:end] in {"case", "delete", "in", "instanceof", "of",
                                 "return", "throw", "typeof", "void", "yield"}


def _skip_regex(source: str, start: int) -> int:
    in_class = False
    i = start + 1
    while i < len(source):
        if source[i] == "\\" and i + 1 < len(source):
            i += 2
        elif source[i] == "[":
            in_class = True
            i += 1
        elif source[i] == "]" and in_class:
            in_class = False
            i += 1
        elif source[i] == "/" and not in_class:
            i += 1
            while i < len(source) and source[i].isalpha():
                i += 1
            return i
        elif source[i] in "\r\n":
            return i
        else:
            i += 1
    return len(source)


def _read_quoted(source: str, start: int) -> tuple[int, str]:
    """Return (first index after the literal, its static content)."""
    quote = source[start]
    chars: list[str] = []
    i = start + 1
    while i < len(source):
        if source[i] == "\\" and i + 1 < len(source):
            chars.append(source[i + 1])
            i += 2
        elif source[i] == quote:
            return i + 1, "".join(chars)
        else:
            chars.append(source[i])
            i += 1
    return len(source), "".join(chars)


def _find_matching_brace(source: str, start: int) -> int:
    """Find a JavaScript expression's closing brace without evaluating it."""
    depth = 1
    i = start + 1
    while i < len(source):
        if source.startswith("//", i):
            i = _skip_line_comment(source, i)
        elif source.startswith("/*", i):
            i = _skip_block_comment(source, i)
        elif source[i] == "/" and _looks_like_regex_start(source, i):
            i = _skip_regex(source, i)
        elif source[i] in "\"'":
            i, _ = _read_quoted(source, i)
        elif source[i] == "`":
            i, _, _ = _read_template(source, i)
        elif source[i] == "{":
            depth += 1
            i += 1
        elif source[i] == "}":
            depth -= 1
            if depth == 0:
                return i
            i += 1
        else:
            i += 1
    return len(source)


def _read_template(source: str, start: int) -> tuple[int, str, list[str]]:
    """Read a template and expose static text plus nested expressions.

    Each interpolation becomes a marker.  The marker lets the existing
    dynamic-fragment rule discard the whole class word touching it, while
    string literals inside the expression can still be inspected separately.
    """
    chars: list[str] = []
    expressions: list[str] = []
    i = start + 1
    while i < len(source):
        if source[i] == "\\" and i + 1 < len(source):
            chars.append(source[i + 1])
            i += 2
        elif source[i] == "`":
            return i + 1, "".join(chars), expressions
        elif source.startswith("${", i):
            close = _find_matching_brace(source, i + 1)
            expressions.append(source[i + 2:close])
            chars.append("${dynamic}")
            i = min(close + 1, len(source))
        else:
            chars.append(source[i])
            i += 1
    return len(source), "".join(chars), expressions


def _matching_delimiter(source: str, start: int) -> int:
    pairs = {"(": ")", "[": "]", "{": "}"}
    stack = [source[start]]
    i = start + 1
    while i < len(source):
        if source.startswith("//", i):
            i = _skip_line_comment(source, i)
        elif source.startswith("/*", i):
            i = _skip_block_comment(source, i)
        elif source[i] == "/" and _looks_like_regex_start(source, i):
            i = _skip_regex(source, i)
        elif source[i] in "\"'":
            i, _ = _read_quoted(source, i)
        elif source[i] == "`":
            i, _, _ = _read_template(source, i)
        elif source[i] in pairs:
            stack.append(source[i])
            i += 1
        elif stack and source[i] == pairs[stack[-1]]:
            stack.pop()
            if not stack:
                return i
            i += 1
        else:
            i += 1
    return len(source)


def _top_level_indices(expression: str, token: str) -> list[int]:
    positions: list[int] = []
    pairs = {"(": ")", "[": "]", "{": "}"}
    stack: list[str] = []
    i = 0
    while i < len(expression):
        if expression.startswith("//", i):
            i = _skip_line_comment(expression, i)
        elif expression.startswith("/*", i):
            i = _skip_block_comment(expression, i)
        elif expression[i] == "/" and _looks_like_regex_start(expression, i):
            i = _skip_regex(expression, i)
        elif expression[i] in "\"'":
            i, _ = _read_quoted(expression, i)
        elif expression[i] == "`":
            i, _, _ = _read_template(expression, i)
        elif expression[i] in pairs:
            stack.append(expression[i])
            i += 1
        elif stack and expression[i] == pairs[stack[-1]]:
            stack.pop()
            i += 1
        elif not stack and expression.startswith(token, i):
            positions.append(i)
            i += len(token)
        else:
            i += 1
    return positions


def _find_top_level_ternary(expression: str) -> tuple[int, int] | None:
    questions = _top_level_indices(expression, "?")
    questions = [q for q in questions
                 if (q == 0 or expression[q - 1] != "?")
                 and (q + 1 == len(expression) or expression[q + 1] not in "?.")]
    if not questions:
        return None
    first = questions[0]
    nested = 0
    qset = set(questions[1:])
    for i in sorted(qset | set(_top_level_indices(expression, ":"))):
        if i <= first:
            continue
        if i in qset:
            nested += 1
        elif nested:
            nested -= 1
        else:
            return first, i
    return None


def _split_top_level(expression: str, delimiter: str) -> list[str]:
    positions = _top_level_indices(expression, delimiter)
    if not positions:
        return [expression]
    parts: list[str] = []
    start = 0
    for pos in positions:
        parts.append(expression[start:pos])
        start = pos + len(delimiter)
    parts.append(expression[start:])
    return parts


def _static_values(expression: str) -> list[str]:
    """Collect possible literal results without evaluating condition operands."""
    expression = expression.strip()
    while expression.startswith("("):
        close = _matching_delimiter(expression, 0)
        if close != len(expression) - 1:
            break
        expression = expression[1:close].strip()
    if not expression:
        return []

    ternary = _find_top_level_ternary(expression)
    if ternary:
        question, colon = ternary
        return (_static_values(expression[question + 1:colon])
                + _static_values(expression[colon + 1:]))

    for operator in ("||", "??", "+"):
        parts = _split_top_level(expression, operator)
        if len(parts) > 1:
            return [value for part in parts for value in _static_values(part)]
    parts = _split_top_level(expression, "&&")
    if len(parts) > 1:
        return _static_values(parts[-1])

    if expression[0] in "\"'":
        end, value = _read_quoted(expression, 0)
        return [value] if not expression[end:].strip() else []

    if expression[0] == "`":
        end, value, nested = _read_template(expression, 0)
        tail = expression[end:].strip()
        if tail and not re.fullmatch(r"(?:\.trim\s*\(\s*\))+", tail):
            return []
        values = [value]
        for inner in nested:
            values.extend(_static_values(inner))
        return values

    if expression[0] == "[":
        close = _matching_delimiter(expression, 0)
        if close < len(expression):
            return [value for item in _split_top_level(expression[1:close], ",")
                    for value in _static_values(item)]

    helper = re.match(r"(?:clsx|classNames|cn|cx)\s*\(", expression)
    if helper:
        open_paren = expression.find("(", helper.start())
        close = _matching_delimiter(expression, open_paren)
        if close < len(expression):
            return [value for arg in _split_top_level(
                expression[open_paren + 1:close], ",") for value in _static_values(arg)]
    return []


def _classname_values(source: str) -> list[str]:
    """Collect literals from real className attributes in TSX source."""
    values: list[str] = []
    in_jsx_tag = False
    i = 0
    while i < len(source):
        if source.startswith("//", i):
            i = _skip_line_comment(source, i)
            continue
        if source.startswith("/*", i):
            i = _skip_block_comment(source, i)
            continue
        if source[i] == "/" and _looks_like_regex_start(source, i):
            i = _skip_regex(source, i)
            continue
        if source[i] in "\"'":
            i, _ = _read_quoted(source, i)
            continue
        if source[i] == "`":
            i, _, _ = _read_template(source, i)
            continue
        if in_jsx_tag and source[i] == "{":
            close = _find_matching_brace(source, i)
            i = min(close + 1, len(source))
            continue
        if source[i] == "<" and i + 1 < len(source):
            tag_start = i + 1
            if source[tag_start] == "/":
                tag_start += 1
            before_tag = i == 0 or source[i - 1].isspace() or source[i - 1] in "=([{,:;>"
            if (before_tag and tag_start < len(source)
                    and (source[tag_start].isalpha() or source[tag_start] in "_>")):
                in_jsx_tag = True
        elif source[i] == ">" and in_jsx_tag:
            in_jsx_tag = False
        if in_jsx_tag and source.startswith("className", i):
            before_ok = i == 0 or not (source[i - 1].isalnum() or source[i - 1] in "_$")
            end = i + len("className")
            after_ok = end == len(source) or not (source[end].isalnum() or source[end] in "_$")
            if before_ok and after_ok:
                j = end
                while j < len(source) and source[j].isspace():
                    j += 1
                if j < len(source) and source[j] == "=":
                    j += 1
                    while j < len(source) and source[j].isspace():
                        j += 1
                    if j < len(source) and source[j] in "\"'":
                        i, value = _read_quoted(source, j)
                        values.append(value)
                        continue
                    if j < len(source) and source[j] == "{":
                        close = _find_matching_brace(source, j)
                        values.extend(_static_values(source[j + 1:close]))
                        i = min(close + 1, len(source))
                        continue
        i += 1
    return values


def rendered_class_names(source: str) -> set[str]:
    names: set[str] = set()
    for value in _classname_values(source):
        value = INTERPOLATION_RE.sub(" ", value)
        names.update(name for name in value.split() if CLASS_NAME_RE.fullmatch(name))
    return names


def owned_classes() -> set[str]:
    owned: set[str] = set()
    for p in sorted(SRC.rglob("*.css")):
        rel = str(p.relative_to(ROOT))
        is_global = _audit.domain_of(rel) == _audit.GLOBAL_DOMAIN
        owned |= _audit.owned_classes(p.read_text(encoding="utf-8"), is_global=is_global)
    return owned


def rendered_classes() -> dict[str, set[str]]:
    rendered: dict[str, set[str]] = {}
    for p in sorted(SRC.rglob("*.tsx")):
        rel = str(p.relative_to(ROOT))
        for name in rendered_class_names(p.read_text(encoding="utf-8")):
            rendered.setdefault(name, set()).add(rel)
    return rendered


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--update-baseline", action="store_true",
                        help="rewrite the baseline from the tree (shrinks only)")
    args = parser.parse_args()

    owned = owned_classes()
    rendered = rendered_classes()
    orphans = {c: sorted(f) for c, f in rendered.items() if c not in owned}
    baseline = (json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
                if BASELINE_PATH.exists() else {})

    if args.update_baseline:
        added = sorted(set(orphans) - set(baseline))
        if added:
            print("baseline NOT updated — these are NEW orphans, fix them instead of "
                  "freezing them:", file=sys.stderr)
            for c in added:
                print(f"  .{c}: rendered by {', '.join(orphans[c])}", file=sys.stderr)
            return 1
        BASELINE_PATH.write_text(json.dumps(orphans, indent=2, sort_keys=True) + "\n",
                                 encoding="utf-8")
        print(f"rendered-class baseline tightened: {len(orphans)} known orphan(s)")
        return 0

    failures: list[str] = []
    for name in sorted(set(orphans) - set(baseline)):
        failures.append(
            f".{name}: rendered by {', '.join(orphans[name])} but NO stylesheet owns it — "
            f"the element renders unstyled (declare it, or namespace the render to a class "
            f"that is owned)")
    for name in sorted(set(baseline) - set(orphans)):
        failures.append(
            f".{name}: listed in the baseline but now owned — remove it from "
            f"scripts/rendered-class-baseline.json in this commit")

    if failures:
        print("Rendered-class ownership gate FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        return 1
    print(f"Rendered-class ownership passed ({len(rendered)} rendered classes; "
          f"{len(baseline)} known-unowned held at baseline)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
