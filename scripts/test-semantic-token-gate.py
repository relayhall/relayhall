#!/usr/bin/env python3
"""Self-proof for scripts/check-semantic-tokens.py (A15.2 pattern)."""
from __future__ import annotations

import sys
from importlib.machinery import SourceFileLoader
from pathlib import Path

GATE = SourceFileLoader(
    "semantic_gate",
    str(Path(__file__).resolve().parent / "check-semantic-tokens.py")).load_module()

MUST_FAIL = [
    ("warning surface on accent fill", ".toast-warning { background: var(--accent-soft); }"),
    ("error text on brand accent", ".form-error { color: var(--text-accent); }"),
    ("success badge glowing brand", ".badge-success:hover { box-shadow: var(--glow-accent); }"),
    ("info icon on accent", ".toast-info .toast-icon { color: var(--text-accent); }"),
    ("danger state modifier", ".pill.danger { border-color: var(--accent-color); }"),
    ("warning inside kebab selector", ".task-warning-banner { color: var(--text-accent); }"),
    ("failed inside BEM selector", ".workflow__failed--row { color: var(--text-accent); }"),
    ("status local type", "svg|warning-icon { color: var(--text-accent); }"),
    ("positive is", ":is(.neutral, .warning) { color: var(--text-accent); }"),
    ("positive where", ":where(.info) { color: var(--text-accent); }"),
    ("positive relative has", ".card:has(> .error-icon) { color: var(--text-accent); }"),
    ("status outside a negation", ".warning:not(.disabled) { color: var(--text-accent); }"),
    ("focus negation is not an exemption",
     ".warning:not(:focus) { box-shadow: var(--focus-ring); }"),
    ("focus-within is not the ratified focus exemption",
     ".warning:focus-within { box-shadow: var(--focus-ring); }"),
    ("non-focus status arm cannot borrow another arm's focus",
     ".warning, .neutral:focus { box-shadow: var(--focus-ring); }"),
    ("mixed focused and non-focused is branches fail",
     ":is(.warning:focus, .warning:hover) { box-shadow: var(--focus-ring); }"),
    ("descendant status cannot borrow ancestor focus",
     ".neutral:focus .warning { box-shadow: var(--focus-ring); }"),
    ("descendant status stays unfocused after a focused status ancestor",
     ".warning:focus .error { box-shadow: var(--focus-ring); }"),
    ("relative has status cannot borrow subject focus",
     ".neutral:focus:has(.warning) { box-shadow: var(--focus-ring); }"),
    ("focus never exempts a general accent token",
     ".warning:focus-visible { color: var(--accent-color); }"),
]
MUST_PASS = [
    ("warning surface on warning tokens",
     ".toast-warning { background: var(--status-warning-soft); color: var(--text-warning); }"),
    ("danger button on danger tokens", ".btn-danger { background: var(--danger-color); }"),
    ("focus ring on a status control is the ratified exception",
     ".toast-warning:focus-visible { box-shadow: var(--focus-ring); }"),
    ("non-status surface may use the accent", ".hero-cta { background: var(--accent-color); }"),
    ("info surface on info tokens", ".toast-info { border-left: 4px solid var(--status-info); }"),
    ("negative-only status selector is inert",
     ".neutral:not(.warning) { color: var(--text-accent); }"),
    ("nested negative status selectors are inert",
     ".neutral:not(:is(.warning, .error)) { color: var(--text-accent); }"),
    ("negative inside positive remains negative",
     ".neutral:is(:not(.warning), .plain) { color: var(--text-accent); }"),
    ("arbitrary title value is inert", "[title='warning'] { color: var(--text-accent); }"),
    ("arbitrary aria value is inert", "[aria-label*='error'] { color: var(--text-accent); }"),
    ("arbitrary data value is inert", "[data-kind=warning] { color: var(--text-accent); }"),
    ("pseudo arguments are not type selectors", ":lang(warning) { color: var(--text-accent); }"),
    ("pseudo names are not status surfaces", ":warning { color: var(--text-accent); }"),
    ("namespace prefixes are not local types", "warning|button { color: var(--text-accent); }"),
    ("part names are outside the bounded semantic sources",
     "::part(warning) { color: var(--text-accent); }"),
    ("selector-looking quoted text is inert",
     "[title='x:not(.warning)'] { color: var(--text-accent); }"),
    ("near miss is not a status segment", ".warningly { color: var(--text-accent); }"),
    ("substring near miss is not a status segment",
     ".informational { color: var(--text-accent); }"),
    ("two focused status arms may use the ring",
     ".warning:focus, .error:focus-visible { box-shadow: var(--focus-ring); }"),
    ("all is branches focus the status surface",
     ".warning:is(:focus, :focus-visible) { box-shadow: var(--focus-ring); }"),
    ("direct warning focus remains exempt",
     ".warning:focus { box-shadow: var(--focus-ring); }"),
    ("positive is statuses share same-compound focus",
     ":is(.warning, .error):focus-visible { box-shadow: var(--focus-ring); }"),
    ("positive where focus branches focus the same compound",
     ".warning:where(:focus, :focus-visible) { box-shadow: var(--focus-ring); }"),
]

ATTRIBUTE_SELECTORS = [
    "[class='toast-warning']", "[class~='toast-warning']", "[class|='warning']",
    "[class^='warning-']", "[class$='-warning']", "[class*='-warning-']",
    "[data-status='warning']", "[data-status~=failed]", "[data-state|='online']",
    "[data-state^='error-' i]", r"[data-\73tatus='warning']", r"[data-state='w\61 rning']",
]

MALFORMED_SELECTORS = [
    "", ".neutral,", ",.warning", ".neutral:not(", ":is()",
    "[data-status='warning'", ".neutral\\", ".neutral)", ".a>>.warning",
    ".a[title!=warning]", ".a[title=]", ":has(>)", "'warning'", "/* unterminated",
    ":not", ":is", ":focus()", ":focus-visible(.warning)", ".warn/**/ing",
]


def main() -> int:
    problems: list[str] = []
    for label, css in MUST_FAIL:
        failures: list[str] = []
        GATE.check_text("fixture.css", css, failures)
        if not failures:
            problems.append(f"known-bad fixture passed: {label}")
    for label, css in MUST_PASS:
        failures = []
        GATE.check_text("fixture.css", css, failures)
        if failures:
            problems.append(f"known-good fixture failed: {label} -> {failures}")

    # Every ratified synonym must be found in non-final class/id/type/BEM
    # segments while longer near misses remain inert.
    selector_checks = 0
    for word, family in GATE.STATUS_WORDS.items():
        for selector in (
            f".component-{word}-compact", f"#component__{word}--compact",
            f"rh-{word}-panel",
        ):
            selector_checks += 1
            findings = GATE.selector_findings(selector)
            if not any(finding.family == family for finding in findings):
                problems.append(f"status selector missed: {selector} -> {family}: {findings}")
        landmine = f".component-{word}ish-compact"
        selector_checks += 1
        if GATE.selector_findings(landmine):
            problems.append(f"status substring falsely matched: {landmine}")

    for selector in (
        r".toast-\77 arning", r".toast\-warning", ".toast/**/.warning",
        ".neutral > .task-warning-banner", ".card:has(:not(.neutral), .warning-icon)",
        "*|warning-icon", "|warning-panel",
    ):
        selector_checks += 1
        if not GATE.selector_findings(selector):
            problems.append(f"escaped/composed selector missed: {selector}")

    for selector in ATTRIBUTE_SELECTORS:
        selector_checks += 1
        if not GATE.selector_findings(selector):
            problems.append(f"whitelisted status attribute missed: {selector}")

    for selector in (
        "[class]", "[data-status]", "[title='warning']", "[x|title='error']",
        "[data-kind='warning']", ":not([data-status='warning'])",
        "[title='/* .warning */']", "warning|button", "::part(warning)",
    ):
        selector_checks += 1
        if GATE.selector_findings(selector):
            problems.append(f"non-semantic selector falsely matched: {selector}")

    for selector in MALFORMED_SELECTORS:
        selector_checks += 1
        try:
            GATE.selector_findings(selector)
        except GATE.SelectorSyntaxError:
            continue
        problems.append(f"malformed selector silently accepted: {selector!r}")

    # The production entry point must turn parser errors into explicit gate
    # failures rather than silently treating malformed CSS as non-status.
    failures = []
    GATE.check_text("malformed.css", ".neutral:not( { color: var(--accent-color); }", failures)
    if not failures or not any("invalid selector" in failure for failure in failures):
        problems.append(f"malformed production selector did not fail closed: {failures}")

    if problems:
        print("Semantic-token gate self-test FAILED:", file=sys.stderr)
        for p in problems:
            print(f"  {p}", file=sys.stderr)
        return 1
    print(f"Semantic-token gate self-test passed ({len(MUST_FAIL)} leak fixtures fail, "
          f"{len(MUST_PASS)} correct/exempt fixtures pass, {selector_checks} selector hostiles).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
