#!/usr/bin/env python3
"""Self-proof for scripts/check-theme-parity.py (A15.2 pattern).

Runs the production gate as a subprocess against fixture artifacts, so the
proof covers the CLI surface and every rule the gate claims to enforce. A
gate that passes because it stopped looking is the failure this file exists
to make impossible: each rule gets a fixture that violates exactly it.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

GATE = Path(__file__).resolve().parent / "check-theme-parity.py"

GOOD_CSS = """
/* A comment naming [data-theme="ghost"] must never select a block. */
:root {
  --slate-900: #0f1216;
  --white: #ffffff;
  --space-2: 0.5rem;
}

html:not([data-theme]),
[data-theme="relay-dark"] {
  --bg-app: var(--slate-900);
  --text-primary: var(--white);
}

[data-theme="relay-light"] {
  --bg-app: var(--white);
  --text-primary: var(--slate-900);
}

[data-theme="high-contrast"] {
  --bg-app: #000000;
  --text-primary: var(--white);
}
"""

GOOD_FRONTEND = """
export const BUILT_IN_THEMES = ['relay-dark', 'relay-light', 'high-contrast'] as const;
export const DEFAULT_THEME: BuiltInTheme = 'relay-dark';
"""

GOOD_BACKEND = """
export const BUILT_IN_THEMES = ['relay-dark', 'relay-light', 'high-contrast'] as const;
export const DEFAULT_THEME: BuiltInTheme = 'relay-dark';

const RELAY_DARK: TokenTable = {
  'bg-app': '#0f1216',
  'space-2': '0.5rem',
};

const RELAY_LIGHT: TokenTable = {
  'bg-app': '#ffffff',
  'space-2': '0.5rem',
};

const HIGH_CONTRAST: TokenTable = {
  'bg-app': '#000000',
  'space-2': '0.5rem',
};

const THEME_TABLES: Readonly<Record<BuiltInTheme, TokenTable>> = {
  'relay-dark': RELAY_DARK,
  'relay-light': RELAY_LIGHT,
  'high-contrast': HIGH_CONTRAST,
};
"""

GOOD_SQL = """
CREATE TABLE principal_preferences (
  theme VARCHAR(32) CHECK (theme IN ('relay-dark','relay-light','high-contrast','system'))
);
"""


def write(tmp: Path, name: str, body: str) -> Path:
    path = tmp / name
    path.write_text(body, encoding="utf-8")
    return path


def run_gate(css: str, frontend: str, backend: str, sql: str, tmp: Path,
             tag: str) -> subprocess.CompletedProcess:
    scope = tmp / tag
    scope.mkdir()
    empty_src = scope / "src"
    empty_src.mkdir()
    return subprocess.run(
        [sys.executable, str(GATE),
         "--css", str(write(scope, "tokens.css", css)),
         "--frontend", str(write(scope, "theme.ts", frontend)),
         "--backend", str(write(scope, "pluginTheme.ts", backend)),
         "--sql", str(write(scope, "080.sql", sql)),
         "--src", str(empty_src),
         "--declared", str(write(scope, "declared.json", "[]"))],
        capture_output=True, text=True)


def run_island_gate(tmp: Path, tag: str, component: str,
                    declared: str) -> subprocess.CompletedProcess:
    """Rule 7 only: the value-space inputs stay coherent, the component varies."""
    scope = tmp / tag
    scope.mkdir()
    src = scope / "src" / "pages"
    src.mkdir(parents=True)
    (src / "PreviewPage.tsx").write_text(component, encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(GATE),
         "--css", str(write(scope, "tokens.css", GOOD_CSS)),
         "--frontend", str(write(scope, "theme.ts", GOOD_FRONTEND)),
         "--backend", str(write(scope, "pluginTheme.ts", GOOD_BACKEND)),
         "--sql", str(write(scope, "080.sql", GOOD_SQL)),
         "--src", str(scope / "src"),
         "--declared", str(write(scope, "declared.json", declared))],
        capture_output=True, text=True)


def main() -> int:
    problems: list[str] = []

    # The real repository must pass.
    live = subprocess.run([sys.executable, str(GATE)], capture_output=True, text=True)
    if live.returncode != 0:
        problems.append(f"repository run failed: {live.stderr.strip()}")

    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)

        def expect(tag: str, description: str, *, css: str = GOOD_CSS,
                   frontend: str = GOOD_FRONTEND, backend: str = GOOD_BACKEND,
                   sql: str = GOOD_SQL, should_pass: bool) -> None:
            result = run_gate(css, frontend, backend, sql, tmp, tag)
            if should_pass and result.returncode != 0:
                problems.append(f"{description} should pass: {result.stderr.strip()}")
            if not should_pass and result.returncode == 0:
                problems.append(f"{description} passed")

        expect("baseline", "the coherent fixture set", should_pass=True)

        # 1. Value-space drift, one artifact at a time.
        expect("fe-drift", "an engine missing a Theme the CSS binds", should_pass=False,
               frontend=GOOD_FRONTEND.replace(", 'high-contrast'", ""))
        expect("be-drift", "a plugin service missing a Theme the CSS binds", should_pass=False,
               backend=GOOD_BACKEND.replace(", 'high-contrast'", ""))
        expect("sql-drift", "a stored value space missing a Theme", should_pass=False,
               sql=GOOD_SQL.replace("'high-contrast',", ""))
        expect("sql-extra", "a stored value space with an unknown Theme", should_pass=False,
               sql=GOOD_SQL.replace("'system'", "'system','relay-sepia'"))
        expect("no-system", "a stored value space without the `system` directive",
               should_pass=False, sql=GOOD_SQL.replace(",'system'", ""))
        expect("system-as-theme", "`system` minted as a Theme rather than a directive",
               should_pass=False,
               css=GOOD_CSS + '\n[data-theme="system"] { --bg-app: #000000; --text-primary: #ffffff; }',
               frontend=GOOD_FRONTEND.replace("'high-contrast']", "'high-contrast', 'system']"),
               backend=GOOD_BACKEND.replace("'high-contrast']", "'high-contrast', 'system']"))

        # 2. Default-Theme agreement.
        expect("default-drift", "an engine defaulting to a different Theme", should_pass=False,
               frontend=GOOD_FRONTEND.replace("DEFAULT_THEME: BuiltInTheme = 'relay-dark'",
                                              "DEFAULT_THEME: BuiltInTheme = 'relay-light'"))

        # 3. The no-Theme fallback.
        expect("no-fallback", "a default Theme that only binds under an explicit attribute",
               should_pass=False,
               css=GOOD_CSS.replace("html:not([data-theme]),\n", ""))

        # 4. Completeness in both directions.
        expect("incomplete", "a Theme that does not bind what the default binds",
               should_pass=False,
               css=GOOD_CSS.replace("""[data-theme="relay-light"] {
  --bg-app: var(--white);
  --text-primary: var(--slate-900);
}""", '[data-theme="relay-light"] { --bg-app: var(--white); }'))
        expect("theme-only-token", "a token only one Theme binds", should_pass=False,
               css=GOOD_CSS.replace(
                   '[data-theme="high-contrast"] {\n  --bg-app: #000000;',
                   '[data-theme="high-contrast"] {\n  --bg-only-here: #123456;\n  --bg-app: #000000;'))

        # 5. The inheritance channel, re-opened from the :root side.
        expect("shared-root", "a theme-bound token also declared theme-independently",
               should_pass=False,
               css=GOOD_CSS.replace("  --space-2: 0.5rem;",
                                    "  --space-2: 0.5rem;\n  --bg-app: #123456;"))

        # 6. The published tables are resolved copies of the stylesheet.
        expect("published-drift", "a published value the stylesheet disagrees with",
               should_pass=False,
               backend=GOOD_BACKEND.replace("'bg-app': '#ffffff',", "'bg-app': '#fefefe',"))
        expect("published-unknown", "a published token that is not a semantic token",
               should_pass=False,
               backend=GOOD_BACKEND.replace("'space-2': '0.5rem',\n};",
                                            "'space-2': '0.5rem',\n  'not-a-token': '#000000',\n};", 1))
        expect("published-uneven", "Themes publishing different token sets", should_pass=False,
               backend=GOOD_BACKEND.replace(
                   "const HIGH_CONTRAST: TokenTable = {\n  'bg-app': '#000000',\n  'space-2': '0.5rem',\n};",
                   "const HIGH_CONTRAST: TokenTable = {\n  'bg-app': '#000000',\n};"))

        # 7. Themed islands. The caption bug that motivated the rule: the
        # attribute one element too high swallows page chrome into the preview.
        DECLARED = '[["pages/PreviewPage.tsx", "swatch-surface", "the preview tile"]]'
        CORRECT = '''export const PreviewPage = () => (
  <li className="swatch">
    <span className="swatch-surface" data-theme={theme}><span>Aa</span></span>
    <span className="swatch-name">{label}</span>
  </li>
);'''
        TOO_WIDE = '''export const PreviewPage = () => (
  <li className="swatch" data-theme={theme}>
    <span className="swatch-surface"><span>Aa</span></span>
    <span className="swatch-name">{label}</span>
  </li>
);'''
        result = run_island_gate(tmp, "island-ok", CORRECT, DECLARED)
        if result.returncode != 0:
            problems.append(f"a declared island on its declared class failed: {result.stderr.strip()}")
        result = run_island_gate(tmp, "island-too-wide", TOO_WIDE, DECLARED)
        if result.returncode == 0:
            problems.append("an island scoped one element too high passed")
        result = run_island_gate(tmp, "island-undeclared", CORRECT, "[]")
        if result.returncode == 0:
            problems.append("an undeclared themed island passed")
        result = run_island_gate(
            tmp, "island-stale",
            "export const PreviewPage = () => <li className=\"swatch\" />;", DECLARED)
        if result.returncode == 0:
            problems.append("a stale island declaration passed")

        # Fail closed on inputs the gate cannot read.
        missing = subprocess.run(
            [sys.executable, str(GATE), "--css", str(tmp / "nope.css")],
            capture_output=True, text=True)
        if missing.returncode == 0:
            problems.append("a missing stylesheet passed")
        empty = run_gate(GOOD_CSS, "export const NOTHING = 1;", GOOD_BACKEND, GOOD_SQL,
                         tmp, "no-enum")
        if empty.returncode == 0:
            problems.append("an engine with no BUILT_IN_THEMES array passed")

    if problems:
        print("Theme parity gate self-test FAILED:", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        return 1
    print("Theme parity gate self-test passed (20 fixtures: repository run, 6 value-space "
          "shapes, default agreement, no-Theme fallback, 2 completeness directions, shared "
          "root, 3 published-table shapes, 4 themed-island shapes, 2 fail-closed inputs).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
