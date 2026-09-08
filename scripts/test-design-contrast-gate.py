#!/usr/bin/env python3
"""Self-proof for scripts/check-design-contrast.py (A15.2 pattern).

Runs the production gate end-to-end as a subprocess against fixture documents
and stylesheets in a temporary directory, so the proof covers the CLI surface
(matrix discovery, resolution, failure exit codes), not just the arithmetic.
Known-bad fixtures must fail with the computed ratio in the message; the gate
must fail closed on malformed or missing inputs.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

GATE = Path(__file__).resolve().parent / "check-design-contrast.py"


def make_doc(tmp: Path, matrix_json: str, fenced: bool = True) -> Path:
    doc = tmp / "ds.md"
    body = f"```json contrast-matrix\n{matrix_json}\n```" if fenced else matrix_json
    doc.write_text(f"# fixture\n\n{body}\n", encoding="utf-8")
    return doc


def make_css(tmp: Path, css: str) -> Path:
    sheet = tmp / "tokens.css"
    sheet.write_text(css, encoding="utf-8")
    return sheet


def run_gate(doc: Path, css: Path, theme: str = "relay-dark") -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(GATE), "--doc", str(doc), "--css", str(css), "--theme", theme],
        capture_output=True, text=True)


GOOD_CSS = """
:root, [data-theme="relay-dark"] {
  --bg-app: #0f1216;
  --text-primary: #f2f4f7;
  --veil: rgba(255, 255, 255, 0.9);
  --alias: var(--text-primary);
}
"""

GOOD_MATRIX = """{
  "thresholds": { "text": 4.5, "ui": 3.0 },
  "pairs": [
    { "fg": "--text-primary", "bg": "--bg-app", "class": "text" },
    { "fg": "--alias", "bg": "--bg-app", "class": "text" },
    { "fg": "--veil", "bg": "--bg-app", "class": "ui" }
  ],
  "exemptions": [ { "token": "--text-primary", "rationale": "fixture" } ]
}"""

LOW_CONTRAST_MATRIX = """{
  "thresholds": { "text": 4.5 },
  "pairs": [ { "fg": "--dim", "bg": "--dark", "class": "text" } ],
  "exemptions": []
}"""

LOW_CONTRAST_CSS = ':root { --dim: #777777; --dark: #666666; }'


def main() -> int:
    problems: list[str] = []
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)

        # Real repository run must pass (the gate as CI runs it).
        real = subprocess.run([sys.executable, str(GATE)], capture_output=True, text=True)
        if real.returncode != 0:
            problems.append(f"repository run failed: {real.stderr.strip()}")

        # Known-good fixture: opaque, alias-resolved and alpha-composited pairs pass.
        r = run_gate(make_doc(tmp, GOOD_MATRIX), make_css(tmp, GOOD_CSS))
        if r.returncode != 0:
            problems.append(f"known-good fixture failed: {r.stderr.strip()}")

        # Known-bad pair must fail and report the computed ratio.
        r = run_gate(make_doc(tmp, LOW_CONTRAST_MATRIX), make_css(tmp, LOW_CONTRAST_CSS))
        if r.returncode == 0:
            problems.append("low-contrast fixture passed")
        elif ":1 < 4.5:1" not in r.stderr:
            problems.append(f"low-contrast failure lacks the computed ratio: {r.stderr.strip()}")

        # Fail closed: malformed JSON, missing fence, unknown token, stale exemption.
        r = run_gate(make_doc(tmp, "{ not json"), make_css(tmp, GOOD_CSS))
        if r.returncode == 0:
            problems.append("malformed matrix passed")
        r = run_gate(make_doc(tmp, GOOD_MATRIX, fenced=False), make_css(tmp, GOOD_CSS))
        if r.returncode == 0:
            problems.append("missing fence passed")
        r = run_gate(make_doc(tmp, GOOD_MATRIX), make_css(tmp, ":root { --bg-app: #0f1216; }"))
        if r.returncode == 0:
            problems.append("unknown token passed")
        stale = GOOD_MATRIX.replace("--text-primary\", \"rationale", "--gone\", \"rationale")
        r = run_gate(make_doc(tmp, stale.replace(
            '{ "token": "--text-primary", "rationale": "fixture" }',
            '{ "token": "--gone", "rationale": "fixture" }')), make_css(tmp, GOOD_CSS))
        if r.returncode == 0:
            problems.append("stale exemption passed")

        # Theme parameterisation: bindings scoped to another theme are invisible.
        themed_css = '[data-theme="relay-light"] { --bg-app: #ffffff; --text-primary: #111111; }'
        r = run_gate(make_doc(tmp, GOOD_MATRIX), make_css(tmp, themed_css), theme="relay-dark")
        if r.returncode == 0:
            problems.append("bindings from a different theme leaked into relay-dark")
        r = run_gate(make_doc(tmp, """{
  "thresholds": { "text": 4.5 },
  "pairs": [ { "fg": "--text-primary", "bg": "--bg-app", "class": "text" } ],
  "exemptions": []
}"""), make_css(tmp, themed_css), theme="relay-light")
        if r.returncode != 0:
            problems.append(f"relay-light themed fixture failed: {r.stderr.strip()}")

        # Comments never select a block (RH-UI.2). The block scan is
        # brace-based, so an unstripped comment naming a theme selector would
        # be read as part of the FOLLOWING rule's selector and pull another
        # theme's bindings into the run.
        commented_css = (
            '/* the [data-theme="relay-light"] block binds these */\n'
            '[data-theme="high-contrast"] { --bg-app: #ffffff; --text-primary: #111111; }'
        )
        r = run_gate(make_doc(tmp, """{
  "thresholds": { "text": 4.5 },
  "pairs": [ { "fg": "--text-primary", "bg": "--bg-app", "class": "text" } ],
  "exemptions": []
}"""), make_css(tmp, commented_css), theme="relay-light")
        if r.returncode == 0:
            problems.append("a comment naming relay-light selected another theme's block")

    if problems:
        print("Design-contrast gate self-test FAILED:", file=sys.stderr)
        for p in problems:
            print(f"  {p}", file=sys.stderr)
        return 1
    print("Design-contrast gate self-test passed (9 fixtures: repo run, alias/alpha pass, "
          "ratio-reporting failure, 4 fail-closed shapes, theme scoping, comment scoping).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
