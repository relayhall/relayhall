#!/usr/bin/env python3
"""Semantic/brand separation gate (task 13cbb482; reviews d92c0168, 7679ac29).

RH-DESIGN.6 §3: "status colours never double as brand colours". The converse
matters just as much — a rule that styles a STATUS surface must not reach for
brand-accent tokens. Two review rounds found exactly that leak (warning amber
mapped to the accent family in Toast and Sidebar chrome), so the rule is now
mechanical:

a CSS rule whose selector names a status family (warning / error / danger /
success / info and their common synonyms) may not use `--accent-*`,
`--text-accent`, `--glow-accent` or `--focus-ring*` in its declarations.

Focus styling is exempt where it is genuinely the focus ring on a status
control: `:focus`/`:focus-visible` selectors keep the accent-derived ring by
design (§4.2).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import NamedTuple

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "frontend" / "src"
EXCLUDED_PARTS = {".git", "node_modules", "dist", "coverage"}
TOKEN_DEFINITION_FILES = {"frontend/src/styles/variables.css"}

STATUS_WORDS = {
    "warning": "warning", "warn": "warning", "caution": "warning",
    "error": "danger", "danger": "danger", "fail": "danger", "failed": "danger",
    "stuck": "danger", "destructive": "danger",
    "success": "success", "complete": "success", "completed": "success",
    "done": "success", "healthy": "success", "online": "success",
    "info": "info",
}
ACCENT_TOKEN_RE = re.compile(r"var\(--(accent[\w-]*|text-accent|glow-accent|focus-ring[\w-]*)")
RULE_RE = re.compile(r"([^{}@;]+)\{([^{}]*)\}")
COMMENT_BOUNDARY = "\x01"  # token boundary, never a descendant combinator


class SelectorSyntaxError(ValueError):
    """A selector is structurally incomplete or outside the bounded grammar."""


class StatusFinding(NamedTuple):
    family: str
    focused: bool = False


class _AnalysedFinding(NamedTuple):
    family: str
    focused: bool = False
    subject: bool = False


class ArmAnalysis(NamedTuple):
    findings: tuple[_AnalysedFinding, ...]
    always_focused: bool = False


def css_url_end(text: str, start: int) -> int | None:
    """Return the end of an exact, complete url(...) token at *start*."""
    if text[start:start + 3].lower() != "url":
        return None
    if start > 0 and (text[start - 1].isalnum() or text[start - 1] in {"_", "-"}):
        return None
    index = start + 3
    if index >= len(text) or text[index] != "(":
        return None

    depth = 1
    quote: str | None = None
    index += 1
    while index < len(text):
        char = text[index]
        if char == "\\":
            index += 2
            continue
        if quote is not None:
            if char == quote:
                quote = None
            index += 1
            continue
        if char in {'"', "'"}:
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return index + 1
        index += 1
    return None


def strip_css_comments(text: str) -> str:
    """Remove real comments while preserving strings and exact url() data."""
    output: list[str] = []
    index = 0
    quote: str | None = None
    while index < len(text):
        char = text[index]
        if quote is not None:
            output.append(char)
            if char == "\\" and index + 1 < len(text):
                output.append(text[index + 1])
                index += 2
                continue
            if char == quote:
                quote = None
            index += 1
            continue
        if char in {'"', "'"}:
            quote = char
            output.append(char)
            index += 1
            continue
        url_end = css_url_end(text, index)
        if url_end is not None:
            output.append(text[index:url_end])
            index = url_end
            continue
        if text.startswith("/*", index):
            end = text.find("*/", index + 2)
            if end < 0:
                raise SelectorSyntaxError("unterminated CSS comment")
            output.append(COMMENT_BOUNDARY)
            index = end + 2
            continue
        output.append(char)
        index += 1
    return "".join(output)


def _is_name_start(char: str) -> bool:
    return char == "_" or char.isalpha() or ord(char) >= 0x80


def _is_name_char(char: str) -> bool:
    return _is_name_start(char) or char.isdigit() or char == "-"


def _consume_escape(text: str, start: int) -> tuple[str, int]:
    if start >= len(text) or text[start] != "\\":
        raise AssertionError("escape must start at a backslash")
    index = start + 1
    if index >= len(text) or text[index] in "\r\n\f":
        raise SelectorSyntaxError("dangling or newline CSS escape")
    hex_start = index
    while index < len(text) and index - hex_start < 6 and text[index] in "0123456789abcdefABCDEF":
        index += 1
    if index > hex_start:
        codepoint = int(text[hex_start:index], 16)
        if index < len(text) and text[index] in " \t\r\n\f":
            index += 1
        valid = codepoint and codepoint <= 0x10FFFF and not 0xD800 <= codepoint <= 0xDFFF
        return (chr(codepoint) if valid else "\ufffd"), index
    return text[index], index + 1


def _consume_identifier(text: str, start: int) -> tuple[str, int]:
    index = start
    decoded: list[str] = []
    if index < len(text) and text[index] == "-":
        decoded.append("-")
        index += 1
        if index < len(text) and text[index] == "-":
            decoded.append("-")
            index += 1
    if index >= len(text):
        raise SelectorSyntaxError("incomplete CSS identifier")
    if text[index] == "\\":
        char, index = _consume_escape(text, index)
        decoded.append(char)
    elif _is_name_start(text[index]):
        decoded.append(text[index])
        index += 1
    elif len(decoded) == 2:  # --custom-ident
        pass
    else:
        raise SelectorSyntaxError(f"expected CSS identifier at offset {start}")
    while index < len(text):
        if text[index] == "\\":
            char, index = _consume_escape(text, index)
            decoded.append(char)
        elif _is_name_char(text[index]):
            decoded.append(text[index])
            index += 1
        else:
            break
    return "".join(decoded), index


def _consume_string(text: str, start: int) -> tuple[str, int]:
    quote = text[start]
    decoded: list[str] = []
    index = start + 1
    while index < len(text):
        char = text[index]
        if char == quote:
            return "".join(decoded), index + 1
        if char in "\r\n\f":
            raise SelectorSyntaxError("unescaped newline in CSS string")
        if char == "\\":
            if index + 1 < len(text) and text[index + 1] in "\r\n\f":
                index += 2
                continue
            char, index = _consume_escape(text, index)
            decoded.append(char)
            continue
        decoded.append(char)
        index += 1
    raise SelectorSyntaxError("unterminated CSS string")


def _balanced_end(text: str, start: int) -> int:
    pairs = {"(": ")", "[": "]"}
    opening = text[start]
    if opening not in pairs:
        raise AssertionError("balanced span must start with ( or [")
    stack = [pairs[opening]]
    index = start + 1
    while index < len(text):
        char = text[index]
        if char in {'"', "'"}:
            _, index = _consume_string(text, index)
            continue
        if char == "\\":
            _, index = _consume_escape(text, index)
            continue
        if char in pairs:
            stack.append(pairs[char])
        elif char in ")]":
            if not stack or char != stack[-1]:
                raise SelectorSyntaxError(f"unexpected `{char}` in selector")
            stack.pop()
            if not stack:
                return index + 1
        index += 1
    raise SelectorSyntaxError(f"unterminated `{opening}` in selector")


def _families_in_identifier(identifier: str) -> set[str]:
    return {
        STATUS_WORDS[segment]
        for segment in re.split(r"[-_]+", identifier.lower())
        if segment in STATUS_WORDS
    }


def _families_in_attribute_value(value: str) -> set[str]:
    families: set[str] = set()
    for token in value.split():
        families.update(_families_in_identifier(token))
    return families


def _parse_attribute(content: str) -> set[str]:
    index = 0
    size = len(content)

    def spaces(position: int) -> int:
        while position < size and content[position].isspace():
            position += 1
        return position

    index = spaces(index)
    if index >= size:
        raise SelectorSyntaxError("empty attribute selector")

    if content.startswith("*|", index):
        index += 2
        local, index = _consume_identifier(content, index)
    elif content[index] == "|":
        index += 1
        local, index = _consume_identifier(content, index)
    else:
        first, after_first = _consume_identifier(content, index)
        if after_first < size and content[after_first] == "|" and not content.startswith("|=", after_first):
            index = after_first + 1
            local, index = _consume_identifier(content, index)
        else:
            local, index = first, after_first

    index = spaces(index)
    if index == size:
        return set()
    operator = next((op for op in ("~=", "|=", "^=", "$=", "*=", "=")
                     if content.startswith(op, index)), None)
    if operator is None:
        raise SelectorSyntaxError("unsupported or malformed attribute operator")
    index += len(operator)
    index = spaces(index)
    if index >= size:
        raise SelectorSyntaxError("attribute selector is missing a value")
    if content[index] in {'"', "'"}:
        value, index = _consume_string(content, index)
    else:
        value, index = _consume_identifier(content, index)
    index = spaces(index)
    if index < size:
        flag, index = _consume_identifier(content, index)
        if flag.lower() not in {"i", "s"}:
            raise SelectorSyntaxError(f"unsupported attribute flag `{flag}`")
        index = spaces(index)
    if index != size:
        raise SelectorSyntaxError("trailing attribute selector syntax")
    if local.lower() not in {"class", "data-status", "data-state"}:
        return set()
    return _families_in_attribute_value(value)


def _split_selector_arms(selector: str) -> list[str]:
    arms: list[str] = []
    start = 0
    index = 0
    while index < len(selector):
        char = selector[index]
        if char in {'"', "'"}:
            _, index = _consume_string(selector, index)
            continue
        if char == "\\":
            _, index = _consume_escape(selector, index)
            continue
        if char in "([":
            index = _balanced_end(selector, index)
            continue
        if char in ")]":
            raise SelectorSyntaxError(f"unexpected `{char}` in selector")
        if char == ",":
            arm = selector[start:index].strip()
            if not arm:
                raise SelectorSyntaxError("empty selector-list arm")
            arms.append(arm)
            start = index + 1
        index += 1
    arm = selector[start:].strip()
    if not arm:
        raise SelectorSyntaxError("empty selector-list arm")
    arms.append(arm)
    return arms


def _analyse_arm(arm: str, *, allow_relative: bool = False) -> ArmAnalysis:
    findings: list[_AnalysedFinding] = []
    direct_families: set[str] = set()
    nested: list[tuple[StatusFinding, bool]] = []
    direct_focus = False
    functional_focus = False
    last_compound_focused = False
    index = 0
    compound_start = True
    saw_simple = False
    explicit_combinator = False

    def finish_compound(*, subject: bool) -> None:
        """Bind focus only to findings on this compound's subject."""
        nonlocal direct_families, nested, direct_focus, functional_focus
        nonlocal last_compound_focused

        compound_focused = direct_focus or functional_focus
        for finding, focus_eligible in nested:
            findings.append(_AnalysedFinding(
                finding.family,
                finding.focused or (compound_focused and focus_eligible),
                subject and focus_eligible,
            ))
        findings.extend(
            _AnalysedFinding(family, compound_focused, subject)
            for family in sorted(direct_families)
        )
        last_compound_focused = compound_focused
        direct_families = set()
        nested = []
        direct_focus = False
        functional_focus = False

    while index < len(arm):
        char = arm[index]
        if char == COMMENT_BOUNDARY:
            index += 1
            continue
        if char.isspace():
            while index < len(arm) and arm[index].isspace():
                index += 1
            if index < len(arm) and not arm.startswith("||", index) and arm[index] not in ">+~":
                if not compound_start:
                    finish_compound(subject=False)
                compound_start = True
                explicit_combinator = False
            continue
        if arm.startswith("||", index) or char in ">+~":
            width = 2 if arm.startswith("||", index) else 1
            if explicit_combinator or (not saw_simple and not allow_relative):
                raise SelectorSyntaxError("misplaced selector combinator")
            if not compound_start:
                finish_compound(subject=False)
            explicit_combinator = True
            compound_start = True
            index += width
            while index < len(arm) and arm[index].isspace():
                index += 1
            continue
        if char in ")]},;@":
            raise SelectorSyntaxError(f"unexpected `{char}` in selector arm")
        if char in {'"', "'"}:
            raise SelectorSyntaxError("string outside an attribute selector")
        if char in ".#":
            identifier, index = _consume_identifier(arm, index + 1)
            direct_families.update(_families_in_identifier(identifier))
            saw_simple = True
            explicit_combinator = False
            compound_start = False
            continue
        if char == "[":
            end = _balanced_end(arm, index)
            direct_families.update(_parse_attribute(arm[index + 1:end - 1]))
            index = end
            saw_simple = True
            explicit_combinator = False
            compound_start = False
            continue
        if char == ":":
            double = index + 1 < len(arm) and arm[index + 1] == ":"
            name, index = _consume_identifier(arm, index + (2 if double else 1))
            lowered = name.lower()
            if index < len(arm) and arm[index] == "(":
                end = _balanced_end(arm, index)
                inner = arm[index + 1:end - 1]
                if not double and lowered in {"focus", "focus-visible"}:
                    raise SelectorSyntaxError(f"non-functional pseudo `:{lowered}` has arguments")
                if not double and lowered in {"is", "where", "has", "not"}:
                    children = _analyse_selector(inner, allow_relative=(lowered == "has"))
                    if lowered in {"is", "where", "has"}:
                        child_findings = [finding for child in children for finding in child.findings]
                        if lowered == "has":
                            nested.extend(
                                (StatusFinding(finding.family, False), False)
                                for finding in child_findings
                            )
                        else:
                            nested.extend(
                                (StatusFinding(finding.family, finding.focused), finding.subject)
                                for finding in child_findings
                            )
                            functional_focus = functional_focus or all(child.always_focused for child in children)
                    # :not() is parsed for syntax only; its semantics are negative.
                index = end
            elif not double and lowered in {"focus", "focus-visible"}:
                direct_focus = True
            elif not double and lowered in {"is", "where", "has", "not"}:
                raise SelectorSyntaxError(f"functional pseudo `:{lowered}` is missing arguments")
            saw_simple = True
            explicit_combinator = False
            compound_start = False
            continue
        if char == "&":
            saw_simple = True
            explicit_combinator = False
            compound_start = False
            index += 1
            continue
        if char == "*":
            if not compound_start:
                raise SelectorSyntaxError("misplaced universal selector")
            index += 1
            if index < len(arm) and arm[index] == "|" and not arm.startswith("||", index):
                index += 1
                if index < len(arm) and arm[index] == "*":
                    index += 1
                else:
                    local, index = _consume_identifier(arm, index)
                    direct_families.update(_families_in_identifier(local))
            saw_simple = True
            explicit_combinator = False
            compound_start = False
            continue
        if char == "|" and not arm.startswith("||", index):
            if not compound_start:
                raise SelectorSyntaxError("misplaced namespace separator")
            local, index = _consume_identifier(arm, index + 1)
            direct_families.update(_families_in_identifier(local))
            saw_simple = True
            explicit_combinator = False
            compound_start = False
            continue
        if char == "\\" or char == "-" or _is_name_start(char):
            if not compound_start:
                raise SelectorSyntaxError("adjacent type selector without a combinator")
            first, after_first = _consume_identifier(arm, index)
            if after_first < len(arm) and arm[after_first] == "|" and not arm.startswith("||", after_first):
                index = after_first + 1  # first is a namespace prefix, not a local type.
                if index < len(arm) and arm[index] == "*":
                    index += 1
                else:
                    local, index = _consume_identifier(arm, index)
                    direct_families.update(_families_in_identifier(local))
            else:
                index = after_first
                direct_families.update(_families_in_identifier(first))
            saw_simple = True
            explicit_combinator = False
            compound_start = False
            continue
        raise SelectorSyntaxError(f"unsupported selector byte `{char}`")

    if explicit_combinator or not saw_simple:
        raise SelectorSyntaxError("incomplete selector arm")
    finish_compound(subject=True)
    return ArmAnalysis(tuple(findings), last_compound_focused)


def _analyse_selector(selector: str, *, allow_relative: bool = False) -> list[ArmAnalysis]:
    return [_analyse_arm(arm, allow_relative=allow_relative) for arm in _split_selector_arms(selector)]


def selector_findings(selector: str) -> tuple[StatusFinding, ...]:
    """Status families positively selected by a complete, bounded selector."""
    clean = strip_css_comments(selector)
    return tuple(StatusFinding(finding.family, finding.focused)
                 for arm in _analyse_selector(clean) for finding in arm.findings)


def status_family(selector: str) -> str | None:
    """Compatibility helper: first positive status family in *selector*."""
    findings = selector_findings(selector)
    return findings[0].family if findings else None


def check_text(path: str, text: str, failures: list[str]) -> None:
    try:
        stripped = strip_css_comments(text)
    except SelectorSyntaxError as error:
        failures.append(f"{path}: invalid CSS syntax: {error}")
        return
    for match in RULE_RE.finditer(stripped):
        selector, body = match.group(1).strip(), match.group(2)
        # Keyframe offsets are rule preludes but not element selectors.
        if re.fullmatch(r"(?i)(?:(?:from|to|\d+(?:\.\d+)?%)\s*,?\s*)+", selector):
            continue
        try:
            findings = selector_findings(selector)
        except SelectorSyntaxError as error:
            failures.append(f"{path}: invalid selector `{selector[:80]}`: {error}")
            continue
        if not findings:
            continue
        for token in ACCENT_TOKEN_RE.findall(body):
            unfocused = [finding for finding in findings if not finding.focused]
            if token.startswith("focus-ring") and not unfocused:
                continue  # exact positive focus state + focus-ring token only.
            finding = (unfocused or list(findings))[0]
            failures.append(
                f"{path}: `{selector[:60]}` is a {finding.family} surface but uses "
                f"var(--{token}) — status surfaces use the status/danger family "
                f"(RH-DESIGN.6 §3)")


def css_files() -> list[Path]:
    return sorted(
        p for p in SRC.rglob("*.css")
        if not any(part in EXCLUDED_PARTS for part in p.parts)
        and str(p.relative_to(ROOT)) not in TOKEN_DEFINITION_FILES
    )


def main() -> int:
    failures: list[str] = []
    files = css_files()
    for p in files:
        check_text(str(p.relative_to(ROOT)), p.read_text(encoding="utf-8"), failures)
    if failures:
        print("Semantic-token gate FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        return 1
    print(f"Semantic-token separation passed ({len(files)} stylesheets: no status "
          f"surface uses brand-accent tokens)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
