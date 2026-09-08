#!/usr/bin/env python3
"""Self-test for scripts/check-type-scale.py (RH-UI.20).

Proves the gate itself: each rule must FIRE on a violating fixture and stay
QUIET on a conforming one. Runs the real check functions against synthetic
CSS text so the test exercises the shipped logic, not a re-implementation.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "check_type_scale", SCRIPTS / "check-type-scale.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

FAILURES: list[str] = []


def expect(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok  {name}")
    else:
        FAILURES.append(name)
        print(f"  FAIL {name} {detail}", file=sys.stderr)


def run_font(rel: str, css: str) -> list[str]:
    out: list[str] = []
    gate.check_font_sizes(rel, gate.strip_comments(css), out)
    return out


def run_height(rel: str, css: str) -> list[str]:
    out: list[str] = []
    gate.check_heights(rel, gate.strip_comments(css), out)
    return out


def main() -> int:
    print("type-scale gate self-test")

    # Rule 1: literal font sizes fail; allowed tokens pass.
    expect("literal px font-size fires",
           bool(run_font("frontend/src/pages/X.css", ".a { font-size: 13px; }")))
    expect("literal rem font-size fires",
           bool(run_font("frontend/src/pages/X.css", ".a { font-size: 0.6rem; }")))
    expect("allowed token passes",
           not run_font("frontend/src/pages/X.css",
                        ".a { font-size: var(--text-sm); }"))
    expect("inherit passes",
           not run_font("frontend/src/pages/X.css", ".a { font-size: inherit; }"))
    expect("off-scale token fires",
           bool(run_font("frontend/src/pages/X.css",
                         ".a { font-size: var(--text-lg); }")))
    expect("comment does not fire",
           not run_font("frontend/src/pages/X.css",
                        "/* font-size: 13px; */ .a { color: red; }"))

    # Display exemption: only sizes above 24px, only in listed files.
    exempt_rel = sorted(gate.DISPLAY_EXEMPT)[0]
    expect("exempt file passes above 24px",
           not run_font(exempt_rel, ".hero { font-size: 48px; }"))
    expect("exempt file still fails at or below 24px",
           bool(run_font(exempt_rel, ".hero { font-size: 13px; }")))
    expect("non-exempt file fails above 24px",
           bool(run_font("frontend/src/pages/X.css", ".hero { font-size: 48px; }")))

    # Map-chip token scoping.
    expect("map-chip token passes inside components/map/",
           not run_font("frontend/src/components/map/MapView.css",
                        ".chip { font-size: var(--text-map-chip); }"))
    expect("map-chip token fires outside components/map/",
           bool(run_font("frontend/src/pages/X.css",
                         ".chip { font-size: var(--text-map-chip); }")))

    # Font shorthand smuggling (fail-closed per adversarial pre-review F2).
    out_sh: list[str] = []
    gate.check_font_shorthand(
        "frontend/src/pages/X.css",
        ".a { font: 500 10px/1.2 sans-serif; }", out_sh)
    expect("font shorthand with a size fires", bool(out_sh))
    out_sh = []
    gate.check_font_shorthand(
        "frontend/src/pages/X.css",
        ".a { --f: 9px sans-serif; font: var(--f); }", out_sh)
    expect("font shorthand via var indirection fires", bool(out_sh))
    out_sh = []
    gate.check_font_shorthand(
        "frontend/src/pages/X.css", ".a { font: caption; }", out_sh)
    expect("system-font keyword fires", bool(out_sh))
    out_sh = []
    gate.check_font_shorthand(
        "frontend/src/pages/X.css", ".a { font: inherit; }", out_sh)
    expect("font: inherit passes", not out_sh)

    # var() with inner whitespace is legal CSS (pre-review F6).
    expect("var with inner spaces passes",
           not run_font("frontend/src/pages/X.css",
                        ".a { font-size: var( --text-sm ); }"))

    # Rule 3: control heights.
    expect("literal control height fires",
           bool(run_height("frontend/src/pages/X.css",
                           ".x-button { height: 40px; }")))
    expect("control token passes",
           not run_height("frontend/src/pages/X.css",
                          ".x-button { height: var(--control-compact); }"))
    expect("non-control selector passes",
           not run_height("frontend/src/pages/X.css",
                          ".x-thumbnail { height: 40px; }"))
    expect("out-of-band height passes",
           not run_height("frontend/src/pages/X.css",
                          ".x-button { height: 24px; }"))
    expect("touch floor passes inside @media",
           not run_height("frontend/src/pages/X.css",
                          "@media (max-width: 768px) { .x-button { min-height: 44px; } }"))
    expect("44px outside @media fires",
           bool(run_height("frontend/src/pages/X.css",
                           ".x-button { min-height: 44px; }")))
    # Fail-closed height rules (adversarial pre-review F3/F4).
    expect("non-control token height on control fires",
           bool(run_height("frontend/src/pages/X.css",
                           ".x-button { height: var(--space-10); }")))
    expect("calc() height on control fires",
           bool(run_height("frontend/src/pages/X.css",
                           ".x-button { height: calc(36px + 4px); }")))
    expect("!important height on control fires",
           bool(run_height("frontend/src/pages/X.css",
                           ".x-button { height: 40px !important; }")))
    expect("control token with fallback fires",
           bool(run_height("frontend/src/pages/X.css",
                           ".x-button { min-height: var(--control-compact, 20px); }")))
    expect("uppercase HEIGHT fires",
           bool(run_height("frontend/src/pages/X.css",
                           ".x-button { HEIGHT: 40px; }")))
    expect("structural keyword passes",
           not run_height("frontend/src/pages/X.css",
                          ".x-button { height: 100%; }"))
    # Logical dimensions are the same contract (hardening 8244fda8): the
    # physical-only scan was a silent bypass.
    expect("literal min-block-size on a control fires",
           bool(run_height("frontend/src/pages/X.css",
                           ".x-button { min-block-size: 40px; }")))
    expect("foreign token via block-size fires",
           bool(run_height("frontend/src/pages/X.css",
                           ".x-button { block-size: var(--space-10); }")))
    expect("control token via min-block-size passes",
           not run_height("frontend/src/pages/X.css",
                          ".x-button { min-block-size: var(--control-standard); }"))
    expect("uppercase MIN-BLOCK-SIZE fires",
           bool(run_height("frontend/src/pages/X.css",
                           ".x-button { MIN-BLOCK-SIZE: 40px; }")))
    expect("out-of-band block-size passes",
           not run_height("frontend/src/pages/X.css",
                          ".x-button { block-size: 200px; }"))
    expect("touch floor via min-block-size passes inside @media",
           not run_height("frontend/src/pages/X.css",
                          "@media (max-width: 768px) { .x-button { min-block-size: 44px; } }"))
    expect("non-control selector with block-size passes",
           not run_height("frontend/src/pages/X.css",
                          ".x-thumbnail { block-size: 40px; }"))

    # DISPLAY_EXEMPT is font-size-only (review 98c0a9e3): a control height
    # in a display-exempt file must still fail.
    expect("control height fires inside a display-exempt file",
           bool(run_height(sorted(gate.DISPLAY_EXEMPT)[0],
                           ".x-button { height: 28px; }")))

    # Rule 4: guarded tokens defined outside variables.css.
    out: list[str] = []
    gate.check_foreign_definitions(
        "frontend/src/pages/X.css", ".a { --control-compact: 40px; }", out)
    expect("foreign --control-* definition fires", bool(out))
    out = []
    gate.check_foreign_definitions(
        "frontend/src/pages/X.css", ".a { --my-own-token: 3px; }", out)
    expect("unrelated custom property passes", not out)

    # Retired token use.
    out = []
    gate.check_retired_token_use(
        "frontend/src/pages/X.css", ".a { font-size: var(--text-base); }", out)
    expect("retired token use fires", bool(out))

    # Rule 2 runs against the real variables.css: the live tree must define
    # the ratified values (this doubles as the wiring proof).
    out = []
    gate.check_token_definitions(out)
    expect("live variables.css defines the ratified scale", not out,
           f"({out[:3]})")

    # Stale-exemption logic: every DISPLAY_EXEMPT path must exist on disk.
    missing = [p for p in gate.DISPLAY_EXEMPT if not (gate.ROOT / p).is_file()]
    expect("no stale DISPLAY_EXEMPT entries", not missing, f"({missing})")

    if FAILURES:
        print(f"type-scale gate self-test FAILED ({len(FAILURES)}): "
              f"{', '.join(FAILURES)}", file=sys.stderr)
        return 1
    print("type-scale gate self-test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
