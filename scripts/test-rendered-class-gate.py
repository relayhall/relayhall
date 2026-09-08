#!/usr/bin/env python3
"""Self-proof for scripts/check-rendered-classes.py (A15.2 pattern).

The regression this gate exists for: a class rendered by one component while
its owning declaration was namespaced or ancestor-scoped inside another
component's sheet — leaving nothing to style it.
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path

HERE = Path(__file__).resolve().parent
GATE = SourceFileLoader("rendered_gate", str(HERE / "check-rendered-classes.py")).load_module()
AUDIT = SourceFileLoader("collision_audit", str(HERE / "audit-css-collisions.py")).load_module()


def owned_of(css: str, is_global: bool = False) -> set[str]:
    return AUDIT.owned_classes(css, is_global=is_global)


def main() -> int:
    problems: list[str] = []

    # The exact defect: only an ancestor-scoped rule remains.
    scoped = owned_of(".project-detail-modal .modal-overlay { position: fixed; }")
    if "modal-overlay" in scoped:
        problems.append("an ancestor-scoped rule was counted as ownership")
    if "project-detail-modal" not in scoped:
        problems.append("the ancestor itself should be owned")

    # A namespaced rename also does not own the bare class.
    renamed = owned_of(".create-project-modal-modal-overlay { position: fixed; }")
    if "modal-overlay" in renamed:
        problems.append("a namespaced rename was counted as ownership of the bare class")

    # A state modifier in the same compound is a reference, not ownership.
    modifier = owned_of(".project-card.active { border-color: red; }")
    if "active" in modifier:
        problems.append("a state modifier was counted as ownership")

    # A standalone rule DOES own, including with pseudo-classes and children.
    for css, name in ((".modal-overlay { position: fixed; }", "modal-overlay"),
                      (".modal-overlay:hover { opacity: 1; }", "modal-overlay"),
                      (".modal-overlay > .inner { top: 0; }", "modal-overlay")):
        if name not in owned_of(css):
            problems.append(f"standalone declaration not counted as ownership: {css!r}")

    # Static values are recovered from the expression forms used in the live
    # tree. Runtime-built class words are excluded without evaluating code.
    fixture = r'''
      const fakeString = "<div className={'string-fake'} />";
      const fakeTemplate = `className={flag ? 'template-fake' : 'also-fake'}`;
      const className = flag ? 'variable-fake' : 'also-variable-fake';
      thing.className = 'property-fake';
      const fakeRegex = /<div className={'regex-fake'} \/>/;
      // className={flag ? 'line-comment-fake' : 'also-fake'}
      /* className={`block-comment-fake`} */
      <div className="direct-one direct-two" />
      <div className = {flag ? 'ternary-on' : "ternary-off"} />
      <div className={flag && 'logical-on'} />
      <div className={override || 'fallback-class'} />
      <div className={mode === 'a' ? 'nested-a' : mode === 'b' ? 'nested-b' : 'nested-c'} />
      <div className={clsx('helper-base', enabled && 'helper-on', unknown('not-a-class'))} />
      <div className={`base size-${size} ${ready ? 'ready' : 'not-ready'} tail-${variant}-suffix`} />
      <div className={[
        'array-base',
        enabled && `array-on mode-${mode} ${dark ? 'dark' : 'light'}`,
      ].filter(Boolean).join(' ')} />
      <div className={ok ? 'brace-safe } still-safe' : 'brace-fallback'} />
    '''
    actual = GATE.rendered_class_names(fixture)
    expected = {
        "direct-one", "direct-two", "ternary-on", "ternary-off", "logical-on",
        "fallback-class", "nested-a", "nested-b", "nested-c", "helper-base", "helper-on",
        "base", "ready", "not-ready", "array-base", "array-on", "dark", "light",
        "brace-safe", "still-safe", "brace-fallback",
    }
    missing = sorted(expected - actual)
    if missing:
        problems.append(f"static class literals were missed: {missing}")
    forbidden = {
        "string-fake", "template-fake", "also-fake", "line-comment-fake",
        "block-comment-fake", "variable-fake", "also-variable-fake", "property-fake",
        "regex-fake", "not-a-class", "size-", "tail-", "-suffix", "mode-",
    }
    leaked = sorted(forbidden & actual)
    if leaked:
        problems.append(f"fake or dynamic class fragments leaked: {leaked}")

    # Interpolation-only values remain absent while adjacent static classes stay.
    dynamic_only = GATE.rendered_class_names(
        "<div className={`btn btn-${variant} is-${state}`} />")
    if dynamic_only != {"btn"}:
        problems.append(f"dynamic fragment filtering is wrong: {sorted(dynamic_only)}")

    # The baseline may only shrink: a NEW orphan must be rejected, not frozen.
    with tempfile.TemporaryDirectory() as d:
        fake = Path(d) / "baseline.json"
        fake.write_text(json.dumps({"known-orphan": ["x.tsx"]}))
        original = GATE.BASELINE_PATH
        try:
            GATE.BASELINE_PATH = fake
            baseline = json.loads(fake.read_text())
            new_orphans = {"known-orphan": ["x.tsx"], "brand-new": ["y.tsx"]}
            added = sorted(set(new_orphans) - set(baseline))
            if added != ["brand-new"]:
                problems.append("new-orphan detection is wrong")
        finally:
            GATE.BASELINE_PATH = original

    # And the live tree passes.
    result = subprocess.run([sys.executable, str(HERE / "check-rendered-classes.py")],
                            capture_output=True, text=True)
    if result.returncode != 0:
        problems.append(f"live tree fails the gate: {result.stderr.strip()[:200]}")

    if problems:
        print("Rendered-class gate self-test FAILED:", file=sys.stderr)
        for p in problems:
            print(f"  {p}", file=sys.stderr)
        return 1
    print("Rendered-class gate self-test passed (ancestor-scoped, namespaced and "
          "state-modifier rules are not ownership; standalone rules are; static "
          "conditional/template values found; fake and dynamic fragments excluded; "
          "baseline shrinks only; live tree green).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
