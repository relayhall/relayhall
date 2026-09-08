#!/usr/bin/env python3
"""Self-proof for scripts/check-design-tokens.py (task e98447ee, A15.2 pattern).

Feeds fixture CSS strings through the production gate functions — no
repository files are written or read, so the proof is deterministic and
independent of tree state. Known-bad fixtures must fail; known-good landmines
must pass.
"""
from __future__ import annotations

import importlib.util
import sys
from importlib.machinery import SourceFileLoader
from pathlib import Path

GATE_PATH = Path(__file__).resolve().parent / "check-design-tokens.py"
loader = SourceFileLoader("design_token_gate", str(GATE_PATH))
spec = importlib.util.spec_from_loader("design_token_gate", loader)
assert spec is not None
gate = importlib.util.module_from_spec(spec)
loader.exec_module(gate)

# A minimal definitions sheet standing in for styles/variables.css.
BASE_SHEET = ":root { --bg-surface: #131826; --accent-color: #06b6d4; }"

# Each entry: (label, css text). MUST produce at least one failure against
# BASE_SHEET's definitions. The five named tokens pin the RH-P1.5c regression
# class (task e98447ee; the P1.5c page-level contract lives in
# frontend/src/acceptanceContracts.test.ts).
MUST_FAIL = [
    ("bg-secondary", ".a { background: var(--bg-secondary); }"),
    ("bg-primary", ".a { background: var(--bg-primary); }"),
    ("border-primary", ".a { border: 1px solid var(--border-primary); }"),
    ("color-primary", ".a { color: var(--color-primary); }"),
    ("bg-hover", ".a:hover { background: var(--bg-hover); }"),
    ("undefined with fallback still fails", ".a { color: var(--no-such-token, #fff); }"),
    ("undefined nested fallback", ".a { color: var(--accent-color, var(--also-missing)); }"),
    ("commented pseudo-definition cannot satisfy a live reference",
     "/* { --ghost: not-a-declaration; } */ .a { color: var(--ghost); }"),
    ("unquoted URL comment marker cannot hide an adjacent live reference",
     ".a { background: url(https://example.test/a/*/b.png); color: var(--url-adjacent-live); }"),
]

# Each entry: (label, css text). MUST produce zero failures.
MUST_PASS = [
    ("defined token", ".a { background: var(--bg-surface); }"),
    ("defined token with fallback", ".a { color: var(--accent-color, #4a9eff); }"),
    ("runtime property with token fallback", ".a { color: var(--personality-color, var(--accent-color)); }"),
    ("runtime-set branding property", ".a { color: var(--config-accent); }"),
    ("locally defined outside :root", ".orb--active { --orb-color: #0f0; } .orb { color: var(--orb-color); }"),
    ("definition after use in the same sheet", ".a { color: var(--late); } .b { --late: #fff; }"),
    ("commented undefined reference is inert", ".a { color: var(--accent-color); } /* var(--ghost) */"),
]


# Literal-colour ratchet fixtures (RH-DESIGN.6 §4.2). Each entry:
# (label, path, css text, baseline dict, expect_failures).
RATCHET_BASELINE = {"legacy.css": {"hex": 2, "rgb": 1}}
# Named CSS colours are literals too (RH-UI.1c): `color: white` on a filled
# affordance shipped a 2.26:1 label past a hex-and-rgb-only ratchet.
NAMED_CASES = [
    ("named colour in a colour property fails", "fresh.css", ".a { color: white; }", {}, True),
    ("named colour in background fails", "fresh.css", ".a { background: red; }", {}, True),
    ("named colour in a border shorthand fails", "fresh.css", ".a { border: 1px solid black; }", {}, True),
    ("CSS Color 4 name fails", "fresh.css", ".a { color: rebeccapurple; }", {}, True),
    ("long named colour fails", "fresh.css", ".a { color: lightgoldenrodyellow; }", {}, True),
    ("named colours are ASCII case-insensitive", "fresh.css", ".a { color: AliceBlue; }", {}, True),
    ("text-decoration shorthand carries colour", "fresh.css", ".a { text-decoration: underline red; }", {}, True),
    ("column-rule shorthand carries colour", "fresh.css", ".a { column-rule: 1px solid rebeccapurple; }", {}, True),
    ("drop-shadow carries colour", "fresh.css", ".a { filter: drop-shadow(0 0 2px chartreuse); }", {}, True),
    ("gradient carries colours", "fresh.css", ".a { background-image: linear-gradient(red, aliceblue); }", {}, True),
    ("raw custom property carries colour", "fresh.css", ":root { --bad: rebeccapurple; }", {}, True),
    ("var fallback carries colour", "fresh.css", ".a { color: var(--x, red); }", {}, True),
    ("nested var fallback carries colour", "fresh.css",
     ".a { color: var(--x, color-mix(in srgb, red, blue)); }", {}, True),
    ("custom-property fallback carries colour", "fresh.css",
     ":root { --bad: var(--x, rebeccapurple); }", {}, True),
    ("escaped named colour fails", "fresh.css", r".a { color: r\65 d; }", {}, True),
    ("simple escaped named colour fails", "fresh.css", r".a { color: \red; }", {}, True),
    ("six-digit escaped named colour fails", "fresh.css", r".a { color: \000072 ed; }", {}, True),
    ("escaped colour property fails", "fresh.css", r".a { c\6flor: red; }", {}, True),
    ("webkit text stroke carries colour", "fresh.css",
     ".a { -webkit-text-stroke: 1px red; }", {}, True),
    ("mask image carries gradient colours", "fresh.css",
     ".a { mask-image: linear-gradient(red, black); }", {}, True),
    ("list style image carries gradient colours", "fresh.css",
     ".a { list-style-image: linear-gradient(red, black); }", {}, True),
    ("shape outside carries gradient colours", "fresh.css",
     ".a { shape-outside: linear-gradient(red, black); }", {}, True),
    ("transparent is a keyword, not a colour", "fresh.css", ".a { background: transparent; }", {}, False),
    ("currentColor is a keyword", "fresh.css", ".a { fill: currentColor; }", {}, False),
    ("inherit is a keyword", "fresh.css", ".a { color: inherit; }", {}, False),
    ("a token whose NAME contains a colour word is fine",
     "fresh.css", ".a { color: var(--teal-500); }", {}, False),
    ("escaped custom property containing a colour is fine",
     "fresh.css", r".a { color: var(--r\65 d-500); }", {}, False),
    ("a CLASS containing a colour word is fine",
     "fresh.css", ".btn-red { padding: 0; }", {}, False),
    ("URL path containing a colour word is inert",
     "fresh.css", ".a { background-image: url(/red/icon.svg); }", {}, False),
    ("quoted URL containing a colour word is inert",
     "fresh.css", ".a { background: url('rebeccapurple.svg') center; }", {}, False),
    ("quoted background prose is inert",
     "fresh.css", ".a { background: 'red'; }", {}, False),
    ("quoted punctuation cannot forge declarations",
     "fresh.css", ".a { content: '; color: red; {'; color: var(--accent-color); }", {}, False),
    ("commented colour declaration is inert",
     "fresh.css", ".a { /* color: red; */ color: var(--accent-color); }", {}, False),
    ("animation name containing a colour word is inert",
     "fresh.css", ".a { animation-name: red; }", {}, False),
    ("non-colour function argument is inert",
     "fresh.css", ".a { content: attr(red); }", {}, False),
    ("prose in a non-colour property is fine",
     "fresh.css", ".a { font-family: 'Gold Sans'; }", {}, False),
]
RATCHET_CASES = [
    ("new file with a hex literal fails",
     "fresh.css", ".a { color: #fff; }", {}, True),
    ("new file with an rgb literal fails",
     "fresh.css", ".a { color: rgba(0,0,0,.5); }", {}, True),
    ("new file with tokens only passes",
     "fresh.css", ".a { color: var(--accent-color); }", {}, False),
    ("file exactly at its frozen counts passes",
     "legacy.css", ".a { color: #fff; border-color: #000; background: rgba(0,0,0,.5); }",
     RATCHET_BASELINE, False),
    ("count above the freeze fails",
     "legacy.css", ".a { color: #fff; border-color: #000; outline-color: #111; background: rgba(0,0,0,.5); }",
     RATCHET_BASELINE, True),
    ("count below the freeze fails until the baseline is tightened",
     "legacy.css", ".a { color: #fff; background: rgba(0,0,0,.5); }",
     RATCHET_BASELINE, True),
    ("token-definition file is exempt",
     "frontend/src/styles/variables.css", ":root { --x: #fff; --y: rgba(0,0,0,.5); }",
     {}, False),
    ("commented colour literals are inert",
     "fresh.css", "/* .a { color: #fff; background: red; } */ .b { color: var(--accent-color); }",
     {}, False),
]


def main() -> int:
    problems: list[str] = []

    for label, css in MUST_FAIL:
        defined = gate.collect_definitions([BASE_SHEET, css])
        failures: list[str] = []
        gate.check_css_text("fixture.css", css, defined, failures)
        if not failures:
            problems.append(f"known-bad fixture passed: {label}")

    for label, css in MUST_PASS:
        defined = gate.collect_definitions([BASE_SHEET, css])
        failures = []
        gate.check_css_text("fixture.css", css, defined, failures)
        if failures:
            problems.append(f"known-good fixture failed: {label} -> {failures}")

    for label, path, css, baseline, expect_fail in RATCHET_CASES + NAMED_CASES:
        failures = []
        gate.check_literal_text(path, css, baseline, failures)
        if expect_fail and not failures:
            problems.append(f"ratchet known-bad fixture passed: {label}")
        if not expect_fail and failures:
            problems.append(f"ratchet known-good fixture failed: {label} -> {failures}")

    # Pin the complete CSS Color 4 set, mixed case and identifier boundaries.
    if len(gate.CSS_NAMED_COLOURS) != 148:
        problems.append(f"named-colour set has {len(gate.CSS_NAMED_COLOURS)} entries, expected 148")
    for colour in gate.CSS_NAMED_COLOURS:
        if gate.count_literals(f".a {{ color: {colour}; }}")["named"] != 1:
            problems.append(f"complete named-colour set missed: {colour}")
        mixed = colour[:1].upper() + colour[1:]
        if gate.count_literals(f".a {{ color: {mixed}; }}")["named"] != 1:
            problems.append(f"case-insensitive named-colour match missed: {mixed}")
        if gate.count_literals(f".a {{ color: var(--{colour}-500); }}")["named"]:
            problems.append(f"named-colour fragment matched inside identifier: {colour}")

    # Hex, rgb()/rgba() and names share the same comment/string/url mask.
    hostile_counts = [
        ("comment payloads", "/* #fff rgb(1 2 3) red */", {"hex": 0, "rgb": 0, "named": 0}),
        ("quoted payloads", ".a { background: '#fff rgb(1 2 3) red'; }",
         {"hex": 0, "rgb": 0, "named": 0}),
        ("URL payloads", ".a { background: url(\"#fff;rgb(1 2 3);red\"); }",
         {"hex": 0, "rgb": 0, "named": 0}),
        ("URL plus live hex", ".a { background: url(#fff) #000; }",
         {"hex": 1, "rgb": 0, "named": 0}),
        ("data URL plus live name",
         ".a { background: url('data:image/svg+xml;fill=#fff;name=red') red; }",
         {"hex": 0, "rgb": 0, "named": 1}),
        ("comment-looking URL plus live literals",
         ".a { background: URL(https://example.test/a/*/b.png) #000 red; }",
         {"hex": 1, "rgb": 0, "named": 1}),
        ("uppercase functions", ".a { color: RGB(1 2 3); background: RGBA(1,2,3,.5); }",
         {"hex": 0, "rgb": 2, "named": 0}),
        ("escaped rgb function", r".a { color: r\67 b(1 2 3); }",
         {"hex": 0, "rgb": 1, "named": 0}),
    ]
    for label, css, expected in hostile_counts:
        actual = gate.count_literals(css)
        if actual != expected:
            problems.append(f"masked hostile fixture miscounted ({label}): {actual} != {expected}")

    # Successor-review regression matrix: declarations are balanced component
    # values, image-bearing shorthands count, and function metadata does not.
    reviewer_named_counts = [
        ("mask shorthand", ".a{mask:linear-gradient(red,blue)}", 2),
        ("webkit mask shorthand", ".a{-webkit-mask:linear-gradient(red,blue)}", 2),
        ("mask border source", ".a{mask-border-source:linear-gradient(red,blue)}", 2),
        ("mask border shorthand", ".a{mask-border:linear-gradient(red,blue)}", 2),
        ("list style image shorthand", ".a{list-style:linear-gradient(red,blue)}", 2),
        ("content image", ".a{content:linear-gradient(red,blue)}", 2),
        ("custom property curly component", ":root{--palette:{primary:red}}", 1),
        ("custom property bracket + inner semicolon", ":root{--palette:[slot:0; red]}", 1),
        ("mixed balanced components",
         ".a{--palette:fn([slot:0; red], {primary:blue});color:gold}", 3),
        ("property initial value",
         '@property --tone { syntax:"<color>"; initial-value:red }', 1),
        ("attr attribute name", ".a{color:attr(red type(<color>))}", 0),
        ("env variable name", ".a{color:env(red)}", 0),
        ("paint worklet name", ".a{background:paint(red)}", 0),
        ("paint arguments remain live", ".a{background:paint(red, blue)}", 1),
        ("escaped paint close keeps inner semicolon nested",
         r".a{background:paint(foo\), x; red)}", 1),
        ("hex-escaped paint close keeps inner semicolon nested",
         r".a{background:paint(foo\29 , x; blue)}", 1),
        ("escaped paint close in custom property",
         r":root{--img:paint(foo\), x; rebeccapurple)} .a{background:var(--img)}", 1),
        ("escaped top-level semicolon is data", r".a{color:\; red}", 1),
        ("escaped top-level open curly is data", r".a{color:\{ red}", 1),
        ("escaped top-level close curly is data", r".a{color:\} red}", 1),
        ("escaped function close keeps inner semicolon nested",
         r".a{background:fn(foo\), x; red)}", 1),
        ("escaped bracket close keeps inner semicolon nested",
         r".a{background:fn([foo\], x; blue])}", 1),
        ("custom property escaped semicolon is data",
         r":root{--tone:\; rebeccapurple}", 1),
        ("custom curly escaped close is data",
         r":root{--tone:{slot:foo\}; red}}", 1),
        ("custom curly hex-escaped close is data",
         r":root{--tone:{slot:foo\7d ; blue}}", 1),
        ("property range ignores escaped close",
         r"@property --tone { initial-value:\} red; }", 1),
        ("attr fallback remains live", ".a{color:attr(red type(<color>), blue)}", 1),
        ("env fallback remains live", ".a{color:env(red, blue)}", 1),
    ]
    for label, css, expected in reviewer_named_counts:
        actual = gate.count_literals(css)["named"]
        if actual != expected:
            problems.append(f"reviewer fixture miscounted ({label}): {actual} != {expected}")

    mask_source = ".a { background: url(#fff);\ncontent: 'red'; }"
    masked = gate.mask_css_non_syntax(mask_source)
    if len(masked) != len(mask_source) or masked.count("\n") != 1:
        problems.append(f"non-syntax mask changed offsets/line mapping: {masked!r}")

    # Stale baseline entries must fail until removed.
    failures = []
    gate.check_stale_baseline({"gone.css": {"hex": 1}}, {"present.css"}, failures)
    if not failures:
        problems.append("stale baseline entry was not reported")

    # The updater only ever tightens: refuses raises and new files, accepts drops.
    new, refusals = gate.tighten_baseline(
        RATCHET_BASELINE,
        {"legacy.css": {"hex": 3, "rgb": 1}},  # raise attempt
    )
    if not refusals:
        problems.append("baseline updater accepted a count raise")
    new, refusals = gate.tighten_baseline(
        RATCHET_BASELINE,
        {"intruder.css": {"hex": 1, "rgb": 0}},  # new-file attempt
    )
    if not refusals:
        problems.append("baseline updater admitted a new file")
    new, refusals = gate.tighten_baseline(
        RATCHET_BASELINE,
        {"legacy.css": {"hex": 1, "rgb": 0}},  # legitimate tightening
    )
    if refusals or new != {"legacy.css": {"hex": 1}}:
        problems.append(f"baseline updater mishandled a legitimate drop: {new} {refusals}")

    # Shadow-composite rule (review c562131e): a shadow property whose whole
    # value is one var() must resolve to a composite, never a bare colour.
    defs = {"--accent-soft": "rgba(20, 184, 166, 0.15)",
            "--glow-accent": "0 8px 32px var(--accent-soft)",
            "--shadow-1": "0 2px 8px rgba(0, 0, 0, 0.25)",
            "--shadow-md": "var(--shadow-1)"}
    failures = []
    gate.check_shadow_composites(
        "f.css", ".a:hover { box-shadow: var(--accent-soft); }", defs, failures)
    if not failures:
        problems.append("colour-only token accepted in box-shadow")
    failures = []
    gate.check_shadow_composites(
        "f.css", ".a { box-shadow: var(--glow-accent); }", defs, failures)
    gate.check_shadow_composites(
        "f.css", ".a { text-shadow: var(--shadow-md); }", defs, failures)  # indirect
    gate.check_shadow_composites(
        "f.css", ".a { box-shadow: 0 1px 2px var(--accent-soft); }", defs, failures)
    if failures:
        problems.append(f"composite shadow rejected: {failures}")

    # Soft breakpoint gate: off-canon warns, canon and complements stay silent.
    warns = gate.breakpoint_warnings("f.css", "@media (max-width: 900px) { .a { color: var(--x); } }")
    if not warns:
        problems.append("off-canon breakpoint did not warn")
    warns = gate.breakpoint_warnings(
        "f.css", "@media (max-width: 767px) {} @media (min-width: 1280px) {}")
    if warns:
        problems.append(f"canon breakpoints warned: {warns}")
    warns = gate.breakpoint_warnings(
        "f.css", "/* @media (max-width: 900px) {} */ @media (min-width: 1280px) {}")
    if warns:
        problems.append(f"commented breakpoint warned: {warns}")

    # Preserve line mappings and literal comment markers inside CSS strings.
    stripped = gate.strip_css_comments('a { content: "/* literal */"; }\n/* gone\ncomment */\nb {}')
    if '"/* literal */"' not in stripped or stripped.count("\n") != 3 or "gone" in stripped:
        problems.append(f"CSS comment stripper damaged strings/line mapping: {stripped!r}")

    # Comment-looking bytes are valid data inside an unquoted url() token. The
    # complete token must survive byte-for-byte, while a real adjacent comment
    # is still removed and later declarations remain visible to the gate.
    url_css = (
        ".a { background: URL(https://example.test/a/*/b.png); "
        "/* remove me */ color: var(--url-adjacent-live); }"
    )
    stripped = gate.strip_css_comments(url_css)
    if "URL(https://example.test/a/*/b.png)" not in stripped or "remove me" in stripped:
        problems.append(f"CSS comment stripper damaged url() data or retained a comment: {stripped!r}")
    failures = []
    gate.check_css_text("url.css", url_css, set(), failures)
    if not any("--url-adjacent-live" in failure for failure in failures):
        problems.append(f"url() payload hid an adjacent live token reference: {failures}")

    # Whitespace before '(' makes URL an ordinary identifier, not a url()
    # function. Comment markers inside the following block therefore remain
    # real comments and must never be shielded by css_url_end().
    spaced_url_css = (
        ".a { background: URL (x/* var(--spaced-url-ghost) */y); "
        "color: var(--ok); }"
    )
    stripped = gate.strip_css_comments(spaced_url_css)
    failures = []
    gate.check_css_text("spaced-url.css", spaced_url_css, {"--ok"}, failures)
    if "--spaced-url-ghost" in stripped or failures:
        problems.append(f"spaced URL identifier shielded a real comment: {stripped!r} {failures}")

    spaced_unterminated = (
        ".a { background: URL (x/*/y); color: var(--spaced-adjacent-ghost); }"
    )
    stripped = gate.strip_css_comments(spaced_unterminated)
    failures = []
    gate.check_css_text("spaced-unterminated.css", spaced_unterminated, set(), failures)
    if "--spaced-adjacent-ghost" in stripped or failures:
        problems.append(
            f"spaced URL identifier shielded an unterminated real comment: {stripped!r} {failures}"
        )

    if problems:
        print("Design-token gate self-test FAILED:", file=sys.stderr)
        for p in problems:
            print(f"  {p}", file=sys.stderr)
        return 1
    print(
        f"Design-token gate self-test passed ({len(MUST_FAIL)} undefined-token fixtures fail, "
        f"{len(MUST_PASS)} defined/runtime fixtures pass, {len(RATCHET_CASES) + len(NAMED_CASES)} ratchet fixtures, "
        f"{len(reviewer_named_counts)} reviewer regressions, stale-entry + updater monotonicity proven)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
