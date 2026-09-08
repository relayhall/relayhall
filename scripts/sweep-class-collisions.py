#!/usr/bin/env python3
"""Cross-stylesheet class de-collision sweep (task 13cbb482, RH-UI.1b).

Applies the committed rename table scripts/class-rename-map.json:

  { "renames":    { "<stylesheet rel path>": { "old-class": "new-class", … } },
    "tsx":        { "<tsx/ts rel path>":     { "old-class": "new-class", … } },
    "contextual": { "<stylesheet rel path>": { "class": ".ancestor", … } } }

"contextual" covers sheets that style a class RENDERED by another component
(or built dynamically by more than one): the rule keeps the class name but is
scoped under the styling component's own root — `.cls` becomes
`.ancestor .cls` — so the sheet references the class without owning it
(scripts/audit-css-collisions.py ownership criterion).

After renames, GLOBAL sheets (styles/*, index.css, App.css) that reference a
renamed class — responsive overrides, shared form/base rules — get each such
selector COMMA-DUPLICATED with the namespaced variant (round-3+, review
3748677b F1): the canonical owner keeps matching the original selector and
every renamed variant regains its shared/responsive behaviour. Idempotent:
a variant already present is never duplicated again.

`global_selector_exclusions` records exact sheet/selector/variant exceptions
where a namespaced component deliberately owns its responsive behaviour.

Renames whose canonical owner is the GLOBAL domain use COMPOSE mode (the
"compose" section lists them per file): the className keeps the shared base
class and gains the namespaced variant ("form-row" -> "form-row
skill-detail-modal-form-row"), so global base/responsive rules keep matching
while the component sheet owns only its variant.

TS/TSX repointing rewrites tokens ONLY inside the string/template literals of
`className` attribute values (round-3, review d2ca332b F1): a class token in a
URL, enum/status value, tooltip or any other string is data, not styling, and
is never touched. Template interpolations inside className values are recursed
as code so nested class-string fragments still rewrite.

For every collision the table keeps ONE canonical declaring sheet (shared
styles/ sheets win; otherwise the sheet whose paired component is the class's
main user) and renames the class in every other declaring sheet to a
component-namespaced name, repointing exactly the source files listed under
"tsx". Replacement is token-level (never a substring of a longer class), in
CSS selector position for stylesheets and anywhere the token appears in the
listed TS/TSX sources.

Deterministic, idempotent (renamed names never re-match), re-runnable; the
end state is proven by scripts/audit-css-collisions.py --check.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAP_PATH = Path(__file__).resolve().parent / "class-rename-map.json"


def skip_quoted(text: str, start: int, quote: str) -> int:
    """Index after a JS quote, or EOF for an unterminated literal."""
    index = start + 1
    while index < len(text):
        if text[index] == "\\":
            index = min(len(text), index + 2)
            continue
        if text[index] == quote:
            return index + 1
        index += 1
    return len(text)


def skip_template(text: str, start: int) -> int:
    """Index after a template literal, including balanced ${...} code."""
    index = start + 1
    while index < len(text):
        if text[index] == "\\":
            index = min(len(text), index + 2)
            continue
        if text[index] == "`":
            return index + 1
        if text.startswith("${", index):
            index = balanced_brace_end(text, index + 1)
            continue
        index += 1
    return len(text)


def balanced_brace_end(text: str, start: int) -> int:
    """Index after a JS expression brace, ignoring non-code braces."""
    depth = 1
    index = start + 1
    while index < len(text):
        char = text[index]
        if text.startswith("//", index):
            newline = text.find("\n", index + 2)
            index = len(text) if newline < 0 else newline + 1
            continue
        if text.startswith("/*", index):
            end = text.find("*/", index + 2)
            index = len(text) if end < 0 else end + 2
            continue
        if char == "/" and regex_literal_start(text, index):
            end = skip_regex_literal(text, index)
            if end > index + 1:
                index = end
                continue
        if char in "\"'":
            index = skip_quoted(text, index, char)
            continue
        if char == "`":
            index = skip_template(text, index)
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index + 1
        index += 1
    return len(text)


def regex_literal_start(text: str, start: int) -> bool:
    """Conservatively identify a JavaScript regex-literal slash.

    Division follows an expression; regex literals follow the start of an
    expression. JSX closing tags are explicitly excluded from the otherwise
    expression-prefix-like ``<`` case.
    """
    if text[start] != "/" or text.startswith(("//", "/*"), start):
        return False
    before = start - 1
    while before >= 0 and text[before].isspace():
        before -= 1
    if before < 0:
        return True
    if text[before] == "<":
        return False
    if text[before] in "([{:,;=!?&|+*%~^->":
        return True
    word_end = before + 1
    word_start = before
    while word_start >= 0 and (text[word_start].isalnum() or text[word_start] in "_$"):
        word_start -= 1
    word = text[word_start + 1:word_end]
    return word in {
        "await", "case", "delete", "do", "else", "in", "instanceof",
        "new", "return", "throw", "typeof", "void", "yield",
    }


def skip_regex_literal(text: str, start: int) -> int:
    """Index after a JavaScript regex literal and flags, or start + 1."""
    index = start + 1
    in_class = False
    while index < len(text):
        char = text[index]
        if char in "\r\n":
            return start + 1
        if char == "\\":
            index = min(len(text), index + 2)
            continue
        if char == "[":
            in_class = True
        elif char == "]":
            in_class = False
        elif char == "/" and not in_class:
            index += 1
            while index < len(text) and text[index].isalpha():
                index += 1
            return index
        index += 1
    return start + 1


def mask_js_non_code(text: str) -> str:
    """Mask strings/templates/comments so fake className text is invisible."""
    masked = list(text)

    def blank(start: int, end: int) -> None:
        for index in range(start, end):
            if masked[index] not in "\r\n":
                masked[index] = " "

    index = 0
    while index < len(text):
        char = text[index]
        if text.startswith("//", index):
            newline = text.find("\n", index + 2)
            end = len(text) if newline < 0 else newline
            blank(index, end)
            index = end
            continue
        if text.startswith("/*", index):
            close = text.find("*/", index + 2)
            end = len(text) if close < 0 else close + 2
            blank(index, end)
            index = end
            continue
        if char == "/" and regex_literal_start(text, index):
            end = skip_regex_literal(text, index)
            if end > index + 1:
                blank(index, end)
                index = end
                continue
        if char in "\"'":
            end = skip_quoted(text, index, char)
            blank(index, end)
            index = end
            continue
        if char == "`":
            end = skip_template(text, index)
            blank(index, end)
            index = end
            continue
        index += 1
    return "".join(masked)


def classname_spans(text: str) -> list[tuple[int, int]]:
    """Character spans of real className attribute values."""
    spans: list[tuple[int, int]] = []
    code = mask_js_non_code(text)
    covered_until = 0
    for match in re.finditer(r"\bclassName\s*=", code):
        start = match.end()
        while start < len(text) and text[start].isspace():
            start += 1
        if start < covered_until or start >= len(text):
            continue
        if text[start] in "\"'":
            end = skip_quoted(text, start, text[start])
        elif text[start] == "{":
            end = balanced_brace_end(text, start)
        else:
            continue
        spans.append((start, end))
        covered_until = end
    return spans


def replace_in_classnames(text: str, old: str, new: str) -> str:
    """Apply the string-literal replacement ONLY inside className values."""
    out = []
    last = 0
    for start, end in classname_spans(text):
        out.append(text[last:start])
        out.append(replace_in_strings(text[start:end], old, new))
        last = end
    out.append(text[last:])
    return "".join(out)


def replace_in_strings(text: str, old: str, new: str) -> str:
    """Replace the class token ONLY inside string/template literals — a bare
    identifier in code (`const [shake, …]`) must never match (round-2
    lesson: classes named like variables)."""
    # compose-mode idempotency: if the replacement's distinctive tail is
    # already present in the segment, the segment is done
    tail = new.split()[-1]
    token = re.compile(rf"(?<![\w-]){re.escape(old)}(?![\w-])")

    tail_token = re.compile(rf"(?<![\w-]){re.escape(tail)}(?![\w-])")

    def rewrite_template(segment: str) -> str:
        # Compose mode remains idempotent at the complete literal boundary.
        if tail_token.search(segment):
            return segment
        parts = ["`"]
        raw_start = 1
        index = 1
        while index < len(segment):
            if segment[index] == "\\":
                index = min(len(segment), index + 2)
                continue
            if segment.startswith("${", index):
                parts.append(token.sub(new, segment[raw_start:index]))
                end = balanced_brace_end(segment, index + 1)
                if end <= index + 2 or end > len(segment):
                    parts.append(segment[index:])
                    return "".join(parts)
                parts.append("${")
                # Interpolation is code: recurse only into its real string and
                # template literals, leaving identifiers/object keys untouched.
                parts.append(replace_in_strings(segment[index + 2:end - 1], old, new))
                parts.append("}")
                index = end
                raw_start = end
                continue
            if segment[index] == "`":
                parts.append(token.sub(new, segment[raw_start:index]))
                parts.append("`")
                parts.append(segment[index + 1:])
                return "".join(parts)
            index += 1
        parts.append(token.sub(new, segment[raw_start:]))
        return "".join(parts)

    out: list[str] = []
    index = 0
    while index < len(text):
        if text.startswith("//", index):
            newline = text.find("\n", index + 2)
            end = len(text) if newline < 0 else newline
            out.append(text[index:end])
            index = end
            continue
        if text.startswith("/*", index):
            close = text.find("*/", index + 2)
            end = len(text) if close < 0 else close + 2
            out.append(text[index:end])
            index = end
            continue
        char = text[index]
        if char == "/" and regex_literal_start(text, index):
            end = skip_regex_literal(text, index)
            if end > index + 1:
                out.append(text[index:end])
                index = end
                continue
        if char in "\"'":
            end = skip_quoted(text, index, char)
            segment = text[index:end]
            out.append(segment if tail_token.search(segment) else token.sub(new, segment))
            index = end
            continue
        if char == "`":
            end = skip_template(text, index)
            out.append(rewrite_template(text[index:end]))
            index = end
            continue
        out.append(char)
        index += 1
    return "".join(out)


def css_class_re(name: str) -> re.Pattern:
    return re.compile(rf"\.{re.escape(name)}(?![\w-])")


def global_variants_for_sheet(
        table: dict, rel: str, old: str, variants: set[str]) -> set[str]:
    """Return responsive variants allowed for one legacy global selector.

    A page may intentionally own its responsive layout after de-collision. In
    that case, copying the namespaced selector back into a legacy global rule
    would restore the collision that the rename removed. The exception stays
    declarative in class-rename-map.json and is scoped to an exact sheet,
    legacy selector, and namespaced variant.
    """
    excluded = set(
        table.get("global_selector_exclusions", {})
        .get(rel, {})
        .get(old, [])
    )
    return variants - excluded


def duplicate_responsive_selectors(
        css: str, old: str, variants: set[str]) -> str:
    """Duplicate a legacy selector for permitted namespaced variants."""
    token = re.compile(rf"\.{re.escape(old)}(?![\w-])")
    out = []
    last = 0
    # media-context tracking: only responsive overrides duplicate
    for match in re.finditer(r"([^{}@;]+)(\{)", css):
        selector = match.group(1)
        out.append(css[last:match.start(1)])
        prefix = css[:match.start(1)]
        in_media = prefix.count("@media") and (
            prefix.rfind("@media") > -1 and
            prefix[prefix.rfind("@media"):].count("{") >
            prefix[prefix.rfind("@media"):].count("}"))
        if in_media and token.search(selector):
            parts = [part for part in selector.split(",")]
            extra = []
            for part in parts:
                if not token.search(part):
                    continue
                for new in sorted(variants):
                    duplicate = token.sub(f".{new}", part.strip())
                    if not re.search(rf"\.{re.escape(new)}(?![\w-])", selector):
                        extra.append(duplicate)
            if extra:
                selector = selector.rstrip() + ",\n" + ",\n".join(extra) + " "
        out.append(selector)
        last = match.end(1)
    out.append(css[last:])
    return "".join(out)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="verify every mapped file/class exists; change nothing")
    args = parser.parse_args()

    table = json.loads(MAP_PATH.read_text(encoding="utf-8"))
    problems: list[str] = []
    changed = 0

    for rel, renames in sorted(table.get("renames", {}).items()):
        p = ROOT / rel
        if not p.exists():
            problems.append(f"{rel}: mapped stylesheet missing")
            continue
        text = p.read_text(encoding="utf-8")
        new_text = text
        for old, new in sorted(renames.items()):
            pattern = css_class_re(old)
            if not pattern.search(new_text):
                if not css_class_re(new).search(new_text):
                    problems.append(f"{rel}: .{old} not declared (nor .{new})")
                continue
            new_text = pattern.sub(f".{new}", new_text)
        if not args.check and new_text != text:
            p.write_text(new_text, encoding="utf-8")
            changed += 1

    for rel, renames in sorted(table.get("tsx", {}).items()):
        p = ROOT / rel
        if not p.exists():
            problems.append(f"{rel}: mapped source missing")
            continue
        text = p.read_text(encoding="utf-8")
        new_text = text
        compose = set(table.get("compose", {}).get(rel, []))
        for old, new in sorted(renames.items()):
            replacement = f"{old} {new}" if old in compose else new
            candidate = replace_in_classnames(new_text, old, replacement)
            if candidate == new_text:
                if replace_in_strings(new_text, new, new) == new_text and new not in new_text:
                    problems.append(f"{rel}: token {old} not present (nor {new})")
                continue
            new_text = candidate
        if not args.check and new_text != text:
            p.write_text(new_text, encoding="utf-8")
            changed += 1

    GLOBAL_SHEETS = [
        "frontend/src/styles/responsive-phase3.css",
        "frontend/src/styles/animations.css",
        "frontend/src/styles/forms.css",
        "frontend/src/index.css",
        "frontend/src/App.css",
    ]
    all_renames: dict[str, set[str]] = {}
    for renames in table.get("renames", {}).values():
        for old, new in renames.items():
            all_renames.setdefault(old, set()).add(new)
    for rel in GLOBAL_SHEETS:
        p = ROOT / rel
        if not p.exists():
            continue
        text = p.read_text(encoding="utf-8")
        new_text = text

        for old, variants in sorted(all_renames.items()):
            allowed = global_variants_for_sheet(table, rel, old, variants)
            new_text = duplicate_responsive_selectors(new_text, old, allowed)
        if not args.check and new_text != text:
            p.write_text(new_text, encoding="utf-8")
            changed += 1

    for rel, scoping in sorted(table.get("contextual", {}).items()):
        p = ROOT / rel
        if not p.exists():
            problems.append(f"{rel}: contextual-mapped stylesheet missing")
            continue
        text = p.read_text(encoding="utf-8")
        new_text = text

        def scope_selectors(css: str, name: str, ancestor: str) -> str:
            out = []
            last = 0
            for m in re.finditer(r"([^{}@;]+)(\{)", css):
                selector = m.group(1)
                parts = []
                changed = False
                for part in selector.split(","):
                    lead = re.match(r"(\s*(?:/\*.*?\*/\s*)*)(.*)", part, re.DOTALL)
                    junk, rest = lead.group(1), lead.group(2).strip()
                    first = re.split(r"[\s>+~]", rest, maxsplit=1)[0] if rest else ""
                    if re.search(rf"\.{re.escape(name)}(?![\w-])", first):
                        parts.append(f"{junk}{ancestor} {rest}")
                        changed = True
                    else:
                        parts.append(part)
                out.append(css[last:m.start(1)])
                out.append(",".join(parts) if changed else selector)
                last = m.end(1)
            out.append(css[last:])
            return "".join(out)

        for name, ancestor in sorted(scoping.items()):
            new_text = scope_selectors(new_text, name, ancestor)
        if not args.check and new_text != text:
            p.write_text(new_text, encoding="utf-8")
            changed += 1

    if problems:
        print("class de-collision sweep FAILED:", file=sys.stderr)
        for x in problems:
            print(f"  {x}", file=sys.stderr)
        return 1
    if args.check:
        print("class rename map is consistent with the tree")
        return 0
    print(f"class de-collision sweep applied: {changed} file(s) rewritten")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
