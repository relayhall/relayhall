#!/usr/bin/env python3
"""Self-proof for the RH-UI.1b sweep scripts (reviews 2a83b89b, d2ca332b).

Hostile fixtures for the two writer sweeps, run against their production
functions — no repository files are touched:

Class sweep (d2ca332b F1): a class token in a URL, a state/enum value, a
tooltip, an id/htmlFor and an ordinary string must stay byte-identical, while
the same token inside className attribute values (plain string, expression
string, template segment, and a nested string inside a template
interpolation) is rewritten.

Colour sweep (d2ca332b F3): a literal fallback whose mapping equals the outer
token collapses to a bare var(); a fallback mapped to a different token stays
as an independently resolvable var(--x, var(--y)); pseudo-class selectors are
never respaced (2a83b89b-era regression, round-1 UI.1a pin).
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from importlib.machinery import SourceFileLoader
from pathlib import Path

HERE = Path(__file__).resolve().parent
class_sweep = SourceFileLoader("class_sweep", str(HERE / "sweep-class-collisions.py")).load_module()
colour_sweep = SourceFileLoader("colour_sweep", str(HERE / "sweep-colour-literals.py")).load_module()

TSX_FIXTURE = """
const url = '/dashboard/active';
const [statusFilter] = useState<string[]>(['active']);
const tip = "Show active tasks";
const id = "active";
<label htmlFor="active">Active</label>
<div className="active card" />
<div className={'active'} />
<div className={`panel active ${isOn ? 'active' : ''}`} />
"""


def main() -> int:
    problems: list[str] = []

    out = class_sweep.replace_in_classnames(TSX_FIXTURE, "active", "page-active")
    for untouched in ("'/dashboard/active'", "(['active'])", '"Show active tasks"',
                      'const id = "active"', 'htmlFor="active"'):
        if untouched not in out:
            problems.append(f"non-class string was rewritten: {untouched}")
    for rewritten in ('className="page-active card"', "className={'page-active'}",
                      "`panel page-active ${isOn ? 'page-active' : ''}`"):
        if rewritten not in out:
            problems.append(f"className token was NOT rewritten: {rewritten}")

    # compose mode: shared base class kept, namespaced variant appended, idempotent
    composed = class_sweep.replace_in_classnames(
        '<div className="form-row wide" />', "form-row", "form-row x-form-row")
    if 'className="form-row x-form-row wide"' not in composed:
        problems.append(f"compose mode failed: {composed}")
    if class_sweep.replace_in_classnames(composed, "form-row", "form-row x-form-row") != composed:
        problems.append("compose mode is not idempotent")

    # A `}` inside a string, template raw segment or comment is data, not the
    # end of className={...}. Text that merely spells className inside a
    # normal string/comment is not a JSX attribute and must remain inert.
    hostile = r'''
const fake = "className={'active'}";
// className={'active'}
/* className={'active'} */
<div className = {flag ? "literal } active" : `raw } ${other ? 'active' : ''}`} />
<div className={cx({ active: flag /* } */ }, 'active')} />
<div className = 'active card' />
'''
    out = class_sweep.replace_in_classnames(hostile, "active", "page-active")
    if 'const fake = "className={\'active\'}";' not in out:
        problems.append("className text inside an ordinary string was rewritten")
    if "// className={'active'}" not in out or "/* className={'active'} */" not in out:
        problems.append("className text inside a comment was rewritten")
    for rewritten in (
            '"literal } page-active"',
            "${other ? 'page-active' : ''}",
            "{ active: flag /* } */ }, 'page-active')",
            "className = 'page-active card'"):
        if rewritten not in out:
            problems.append(f"string-aware className span missed: {rewritten}")
    spans = class_sweep.classname_spans(hostile)
    if len(spans) != 3:
        problems.append(f"expected 3 real className spans, got {spans}")

    nested_template = (
        "<div className={`${flag ? {x: 1} : { active: true, "
        "label: 'active' }} active`} />")
    nested_out = class_sweep.replace_in_classnames(
        nested_template, "active", "page-active")
    if "{ active: true" not in nested_out or "{ page-active: true" in nested_out:
        problems.append(f"nested template interpolation code was rewritten: {nested_out}")
    if "label: 'page-active'" not in nested_out or "} page-active`" not in nested_out:
        problems.append(f"nested template literal strings were not rewritten: {nested_out}")

    regex_expression = "<div className={/[}]/.test(value) ? 'active' : ''} />"
    regex_expression_out = class_sweep.replace_in_classnames(
        regex_expression, "active", "page-active")
    if "/[}]/" not in regex_expression_out or "'page-active'" not in regex_expression_out:
        problems.append(f"regex brace ended a className expression: {regex_expression_out}")

    regex_template = (
        "<div className={`${/[}]/.test(value) ? { active: true } : "
        "'active'} active`} />")
    regex_template_out = class_sweep.replace_in_classnames(
        regex_template, "active", "page-active")
    if "{ active: true }" not in regex_template_out or "{ page-active: true }" in regex_template_out:
        problems.append(f"regex brace exposed template code: {regex_template_out}")
    if "'page-active'" not in regex_template_out or "} page-active`" not in regex_template_out:
        problems.append(f"regex template class strings were not rewritten: {regex_template_out}")

    regex_fixture = r'''
const matcher = /className={'active'}/;
const escaped = /className=\{["']active["']\}/gi;
<div className={'active'} />
'''
    regex_out = class_sweep.replace_in_classnames(
        regex_fixture, "active", "page-active")
    if "/className={'active'}/" not in regex_out or "[\"']active[\"']" not in regex_out:
        problems.append(f"regex-literal data was rewritten: {regex_out}")
    if "<div className={'page-active'} />" not in regex_out:
        problems.append(f"real JSX after regex literals was not rewritten: {regex_out}")

    # A page-owned responsive layout must not be copied back into the legacy
    # global selector. This exact exclusion prevents the dashboard's old
    # six-column mobile rule from overriding its namespaced two-column rule.
    rename_table = json.loads((HERE / "class-rename-map.json").read_text(encoding="utf-8"))
    responsive_path = "frontend/src/styles/responsive-phase3.css"
    variants = {"dashboard-page-dashboard-stats-grid"}
    allowed = class_sweep.global_variants_for_sheet(
        rename_table, responsive_path, "dashboard-stats-grid", variants)
    if allowed:
        problems.append(f"dashboard responsive exclusion failed: {sorted(allowed)}")
    responsive_fixture = (
        "@media (max-width: 767px) {\n"
        "  .dashboard-stats-grid { grid-template-columns: repeat(6, 1fr); }\n"
        "}\n")
    excluded = class_sweep.duplicate_responsive_selectors(
        responsive_fixture, "dashboard-stats-grid", allowed)
    if excluded != responsive_fixture or "dashboard-page-dashboard-stats-grid" in excluded:
        problems.append(f"page-owned dashboard selector leaked into legacy rule: {excluded}")
    duplicated = class_sweep.duplicate_responsive_selectors(
        responsive_fixture, "dashboard-stats-grid", variants)
    if ".dashboard-page-dashboard-stats-grid" not in duplicated:
        problems.append("responsive duplication control did not exercise the variant path")

    mapping = {"hex": {"#d1d5db": "var(--text-secondary)",
                       "#0a0e1a": "var(--bg-app)"},
               "rgb": {}, "legacy": {}}
    unmapped: Counter = Counter()
    css = ".a { color: var(--text-secondary, #d1d5db); background: var(--bg-surface, #0a0e1a); }"
    out = colour_sweep.sweep_text(css, mapping, unmapped, apply=True)
    if "var(--text-secondary, var(--text-secondary))" in out or \
       "color: var(--text-secondary);" not in out:
        problems.append(f"self-referential fallback not collapsed: {out}")
    if "var(--bg-surface, var(--bg-app))" not in out:
        problems.append(f"independent fallback not preserved: {out}")
    if unmapped:
        problems.append(f"fixture literals unmapped: {unmapped}")

    # gradient fade endpoint: a fully transparent literal must stay transparent
    grad_map = {"hex": {}, "rgb": {"rgba(255,255,255,0.05)": "var(--overlay-weak)",
                                   "rgba(255,255,255,0)": "transparent"}, "legacy": {}}
    css = (".card::before { background: linear-gradient(135deg,"
           " rgba(255, 255, 255, 0.05) 0%, rgba(255, 255, 255, 0) 100%); }")
    out = colour_sweep.sweep_text(css, grad_map, unmapped, apply=True)
    if "transparent 100%" not in out or "var(--overlay-weak) 0%" not in out:
        problems.append(f"gradient endpoints wrong: {out}")
    if out.count("var(--overlay-weak)") != 1:
        problems.append(f"transparent endpoint became visible: {out}")

    css = ".skip-link:focus-visible { top: 1rem; }"
    out = colour_sweep.sweep_text(css, mapping, unmapped, apply=True)
    if ".skip-link:focus-visible" not in out:
        problems.append("pseudo-class selector was respaced")

    # url() payloads are references/data, not stylesheet colour literals.
    # They must remain byte-identical in both apply and check modes, while a
    # real colour later in the same declaration still rewrites.
    url_mapping = {"hex": {"#fff": "var(--text-primary)"},
                   "rgb": {}, "legacy": {"--red-500": "var(--danger-color)"}}
    url_cases = [
        "url(#fff)",
        "URL( '#fff' )",
        'url("#fff")',
        "url(data:image/svg+xml,%3Csvg%20fill='%23fff'%3E)",
        "url(#red-500)",
    ]
    for url_value in url_cases:
        css = f".a {{ filter: {url_value}; }}"
        local_unmapped: Counter = Counter()
        out = colour_sweep.sweep_text(css, url_mapping, local_unmapped, apply=True)
        if out != css:
            problems.append(f"url() payload was rewritten: {css} -> {out}")
        if local_unmapped:
            problems.append(f"url() payload was counted as unmapped: {local_unmapped}")

    semicolon_urls = [
        'url("https://example.test/a;param:foo#fff")',
        'url("data:text/plain;charset=utf-8,token:foo#fff")',
    ]
    for url_value in semicolon_urls:
        css = f".a {{ background: {url_value}; }}"
        local_unmapped = Counter()
        out = colour_sweep.sweep_text(css, url_mapping, local_unmapped, apply=True)
        if out != css:
            problems.append(f"semicolon-bearing url() was rewritten: {css} -> {out}")
        if local_unmapped:
            problems.append(f"semicolon-bearing url() counted as unmapped: {local_unmapped}")
        check_unmapped = Counter()
        checked = colour_sweep.sweep_text(
            css, {"hex": {}, "rgb": {}, "legacy": {}}, check_unmapped, apply=False)
        if checked != css or check_unmapped:
            problems.append(
                f"semicolon-bearing url() check was not inert: {checked}, {check_unmapped}")

        mixed = f".a {{ background: {url_value} #fff; }}"
        local_unmapped = Counter()
        out = colour_sweep.sweep_text(mixed, url_mapping, local_unmapped, apply=True)
        if url_value not in out or f"{url_value} var(--text-primary)" not in out:
            problems.append(f"semicolon url boundary hid a live colour: {out}")
        if local_unmapped:
            problems.append(f"semicolon url/live-colour fixture unmapped: {local_unmapped}")

    css = ".a { filter: url(#fff) drop-shadow(0 0 1px #fff); }"
    local_unmapped = Counter()
    out = colour_sweep.sweep_text(css, url_mapping, local_unmapped, apply=True)
    if "url(#fff)" not in out or "drop-shadow(0 0 1px var(--text-primary))" not in out:
        problems.append(f"url boundary hid a live colour: {out}")
    if local_unmapped:
        problems.append(f"mixed url/live-colour fixture unmapped: {local_unmapped}")

    if problems:
        print("sweep-scripts self-test FAILED:", file=sys.stderr)
        for x in problems:
            print(f"  {x}", file=sys.stderr)
        return 1
    print("sweep-scripts self-test passed (5 data-string holds, 3 className rewrites, "
          "balanced template/regex isolation, page-owned responsive exclusion, "
          "fallback collapse/preserve, selector integrity, url() payload isolation).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
