#!/usr/bin/env python3
"""Theme parity gate (task 07113036, RH-DESIGN.6 §5.5, vocabulary A16).

v1 ships EXACTLY three built-in Themes, and their names live in four places
that have no compiler between them:

  1. frontend/src/styles/variables.css      — the `[data-theme="…"]` blocks
  2. frontend/src/utils/theme.ts            — BUILT_IN_THEMES (the engine)
  3. backend/src/services/pluginTheme.ts    — BUILT_IN_THEMES (the published
                                              plugin stylesheet)
  4. backend/src/migrations/080_…​.sql       — the stored value space

Drift between any two is silent and user-visible: a Theme a principal can
select but no stylesheet binds renders as unstyled dark; a Theme the CSS
binds but the enum rejects is unreachable; a Theme the database allows but
the engine does not know resolves to the default with no error anywhere.

The gate also enforces the two structural rules the Themes depend on:

  COMPLETENESS — every semantic token the default Theme binds is bound by
  EVERY Theme. Missing bindings are the failure mode that motivated the
  `html:not([data-theme])` fallback selector: with a `:root`-scoped default
  an unbound token inherits the DARK value into a light Theme and every
  resolved-value check still passes. Here it is an error.

  NO SHARED ROOT — no `:root` block may declare a token that a Theme block
  declares. That is the same hole from the other side: one stray `:root`
  binding re-opens the inheritance channel completeness exists to close.

  PUBLISHED VALUES — pluginTheme.ts holds RESOLVED copies of the palette,
  because a plugin's document has no primitive ramps to resolve against. A
  copy is a thing that drifts, so every published value is resolved out of
  the stylesheet and compared.

  DECLARED THEMED ISLANDS — `data-theme` written anywhere in the frontend
  source other than the document element creates a region resolving against a
  DIFFERENT Theme than the page around it. That is legitimate for a preview
  tile and a defect for anything else, and the boundary is easy to get wrong
  by one element: RH-UI.2's own Theme previews first carried the attribute on
  the list item, which pulled each preview's CAPTION — page chrome — inside
  the island, rendering the high-contrast caption at 1.28:1 on the light
  page. Every island is therefore enumerated below with the class it must sit
  on, so adding one is a decision somebody makes on purpose.

Self-proved by scripts/test-theme-parity-gate.py. Fails closed.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSS_PATH = ROOT / "frontend" / "src" / "styles" / "variables.css"
FRONTEND_TS_PATH = ROOT / "frontend" / "src" / "utils" / "theme.ts"
BACKEND_TS_PATH = ROOT / "backend" / "src" / "services" / "pluginTheme.ts"
SQL_PATH = ROOT / "backend" / "src" / "migrations" / "080_principal_preferences.sql"

FRONTEND_SRC = ROOT / "frontend" / "src"

DEFAULT_THEME = "relay-dark"

# Themed islands: components that deliberately render a region under a Theme
# other than the page's. Each entry is (source path, the class the attribute
# must sit on, why). A `data-theme` anywhere else in the frontend source is a
# failure — see the module docstring for the defect this prevents.
DECLARED_PREVIEW_SCOPES = {
    ("pages/AppearancePage.tsx", "appearance-preview"):
        "the root-only Appearance editor's contained live preview",
    ("pages/PreferencesPage.tsx", "preferences-swatch-surface"):
        "the Theme preview tile on the user config page; its caption stays outside",
}

# The engine is allowed to write the attribute on the document element. Kept
# to one module so there is a single place the Theme is applied.
THEME_APPLIER = "frontend/src/utils/theme.ts"
# `system` is a RESOLUTION DIRECTIVE, not a Theme (A16). It is a legal stored
# preference and must never be a CSS block, a token table or an engine Theme.
RESOLUTION_DIRECTIVE = "system"

BLOCK_RE = re.compile(r"([^{}]+)\{([^{}]*)\}", re.DOTALL)
COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)
DECL_RE = re.compile(r"(--[\w-]+)\s*:")
DATA_THEME_RE = re.compile(r'\[data-theme="([^"]+)"\]')
TS_LIST_RE = re.compile(r"BUILT_IN_THEMES\s*=\s*\[([^\]]*)\]")
TS_DEFAULT_RE = re.compile(r"DEFAULT_THEME[^=]*=\s*'([^']+)'")
SQL_CHECK_RE = re.compile(r"theme\s+IN\s*\(([^)]*)\)", re.IGNORECASE)
QUOTED_RE = re.compile(r"'([^']*)'")
FULL_DECL_RE = re.compile(r"(--[\w-]+)\s*:\s*([^;}]+)[;}]")
VAR_RE = re.compile(r"var\(\s*(--[\w-]+)\s*\)")
# `const RELAY_DARK: TokenTable = { … };` — the table's own name is irrelevant;
# what matters is which Theme THEME_TABLES binds it to, parsed separately.
TS_TABLE_RE = re.compile(r"const\s+(\w+)\s*:\s*TokenTable\s*=\s*\{(.*?)\n\};", re.DOTALL)
TS_TABLE_MAP_RE = re.compile(r"THEME_TABLES\s*:[^=]*=\s*\{(.*?)\n\};", re.DOTALL)
TS_MAP_ENTRY_RE = re.compile(r"'([^']+)'\s*:\s*(\w+)\s*,")
TS_ENTRY_RE = re.compile(r"^\s*'([^']+)'\s*:\s*(\"[^\"]*\"|'[^']*')\s*,\s*$", re.MULTILINE)


def without_comments(css_text: str) -> str:
    """Comments carry no braces, so a naive block scan folds them into the NEXT
    rule's selector — and this stylesheet's header comment documents the very
    selectors this gate matches on. Strip them before anything else looks."""
    return COMMENT_RE.sub("", css_text)


def css_blocks(css_text: str) -> list[tuple[str, set[str]]]:
    """(selector, declared token names) for every rule block, in order."""
    css_text = without_comments(css_text)
    return [
        (block.group(1).strip(), set(DECL_RE.findall(block.group(2))))
        for block in BLOCK_RE.finditer(css_text)
    ]


def theme_blocks(css_text: str) -> dict[str, set[str]]:
    """Theme name -> tokens it declares. A Theme split across blocks unions."""
    found: dict[str, set[str]] = {}
    for selector, tokens in css_blocks(css_text):
        for name in DATA_THEME_RE.findall(selector):
            found.setdefault(name, set()).update(tokens)
    return found


def default_theme_selector(css_text: str) -> str | None:
    for selector, _ in css_blocks(css_text):
        if f'[data-theme="{DEFAULT_THEME}"]' in selector:
            return selector
    return None


def root_only_tokens(css_text: str) -> set[str]:
    """Tokens declared by blocks that apply regardless of the active Theme."""
    tokens: set[str] = set()
    for selector, declared in css_blocks(css_text):
        if ":root" in selector and "[data-theme=" not in selector:
            tokens.update(declared)
    return tokens


def theme_bindings(css_text: str, theme: str) -> dict[str, str]:
    """Every custom property visible to an element carrying this Theme:
    theme-independent :root blocks, then the Theme's own blocks (which win)."""
    bindings: dict[str, str] = {}
    for block in BLOCK_RE.finditer(without_comments(css_text)):
        selector, body = block.group(1).strip(), block.group(2)
        theme_scoped = f'[data-theme="{theme}"]' in selector
        root_scoped = ":root" in selector and "[data-theme=" not in selector
        if theme_scoped or root_scoped:
            for name, value in FULL_DECL_RE.findall(body + "}"):
                bindings[name] = value.strip()
    return bindings


def resolve_value(token: str, bindings: dict[str, str], depth: int = 0) -> str | None:
    if depth > 20:
        return None
    value = bindings.get(token)
    if value is None:
        return None
    match = VAR_RE.fullmatch(value.strip())
    if match:
        return resolve_value(match.group(1), bindings, depth + 1)
    return value.strip()


def published_tables(backend_ts: str) -> dict[str, dict[str, str]]:
    """Theme name -> the resolved token table pluginTheme.ts publishes for it."""
    tables = {
        name: dict(
            (key, value[1:-1]) for key, value in TS_ENTRY_RE.findall(body)
        )
        for name, body in TS_TABLE_RE.findall(backend_ts)
    }
    mapping = TS_TABLE_MAP_RE.search(backend_ts)
    if not mapping:
        raise SystemExit(
            "theme parity gate FAILED: no THEME_TABLES map in the plugin theme service")
    published: dict[str, dict[str, str]] = {}
    for theme, const_name in TS_MAP_ENTRY_RE.findall(mapping.group(1)):
        if const_name not in tables:
            raise SystemExit(
                f"theme parity gate FAILED: THEME_TABLES binds {theme} to unknown "
                f"table {const_name}")
        published[theme] = tables[const_name]
    return published


JSX_ELEMENT_RE = re.compile(r"<[a-zA-Z][^<>]*?\bdata-theme\b[^<>]*?>", re.DOTALL)
CLASSNAME_RE = re.compile(r'className="([^"]*)"')


def themed_islands(src_root: Path) -> list[tuple[str, str, str]]:
    """(path relative to src_root, class the attribute sits on, element text)
    for every `data-theme` written in frontend component source."""
    found: list[tuple[str, str, str]] = []
    for path in sorted(src_root.rglob("*.tsx")):
        text = path.read_text(encoding="utf-8")
        if "data-theme" not in text:
            continue
        relative = str(path.relative_to(src_root))
        for element in JSX_ELEMENT_RE.findall(text):
            classes = CLASSNAME_RE.search(element)
            found.append((relative, classes.group(1).strip() if classes else "", element))
    return found


def ts_theme_list(text: str, where: str) -> list[str]:
    match = TS_LIST_RE.search(text)
    if not match:
        raise SystemExit(f"theme parity gate FAILED: no BUILT_IN_THEMES array in {where}")
    return QUOTED_RE.findall(match.group(1))


def ts_default_theme(text: str, where: str) -> str:
    match = TS_DEFAULT_RE.search(text)
    if not match:
        raise SystemExit(f"theme parity gate FAILED: no DEFAULT_THEME in {where}")
    return match.group(1)


def sql_theme_values(text: str, where: str) -> list[str]:
    match = SQL_CHECK_RE.search(text)
    if not match:
        raise SystemExit(
            f"theme parity gate FAILED: no `theme IN (…)` CHECK constraint in {where}")
    return QUOTED_RE.findall(match.group(1))


def check_islands(src_root: Path, declared: dict[tuple[str, str], str]) -> list[str]:
    """Rule 7: every themed island is declared, and sits on its declared class."""
    failures: list[str] = []
    seen: set[tuple[str, str]] = set()
    for path, classes, element in themed_islands(src_root):
        match = next(
            (key for key in declared
             if key[0] == path and key[1] in classes.split()),
            None)
        if match is None:
            failures.append(
                f"{path}: undeclared themed island {' '.join(element.split())[:90]!r}. "
                "A `data-theme` region resolves against a DIFFERENT Theme than the page "
                "around it — anything inside it that is page chrome (a caption, a label) "
                "renders in the wrong Theme. Declare it in DECLARED_PREVIEW_SCOPES with "
                "the class it sits on, or move the attribute to the tile itself.")
            continue
        seen.add(match)
    for key, why in declared.items():
        if key not in seen:
            failures.append(
                f"stale declared preview scope {key[0]}::{key[1]} ({why}) — nothing there "
                "carries data-theme any more")
    return failures


def run(css_text: str, frontend_ts: str, backend_ts: str, sql_text: str) -> list[str]:
    failures: list[str] = []

    css_themes = theme_blocks(css_text)
    css_names = set(css_themes)
    frontend_names = ts_theme_list(frontend_ts, "the frontend engine")
    backend_names = ts_theme_list(backend_ts, "the plugin theme service")
    sql_values = sql_theme_values(sql_text, "the preferences migration")

    # 1. One value space, four artifacts.
    if set(frontend_names) != css_names:
        failures.append(
            f"engine Themes {sorted(frontend_names)} != CSS Theme blocks {sorted(css_names)}")
    if set(backend_names) != css_names:
        failures.append(
            f"plugin-service Themes {sorted(backend_names)} != CSS Theme blocks {sorted(css_names)}")
    expected_sql = css_names | {RESOLUTION_DIRECTIVE}
    if set(sql_values) != expected_sql:
        failures.append(
            f"stored theme value space {sorted(sql_values)} != "
            f"{sorted(expected_sql)} (the Themes plus the `{RESOLUTION_DIRECTIVE}` directive)")
    if RESOLUTION_DIRECTIVE in css_names or RESOLUTION_DIRECTIVE in frontend_names \
            or RESOLUTION_DIRECTIVE in backend_names:
        failures.append(
            f"`{RESOLUTION_DIRECTIVE}` is a resolution directive, never a Theme (A16): "
            "it must not appear as a CSS block or in a Theme enum")

    # 2. The default Theme is the same everywhere, and is a real Theme.
    for label, value in (
        ("the frontend engine", ts_default_theme(frontend_ts, "the frontend engine")),
        ("the plugin theme service", ts_default_theme(backend_ts, "the plugin theme service")),
    ):
        if value != DEFAULT_THEME:
            failures.append(f"{label} defaults to {value!r}, not {DEFAULT_THEME!r}")
    if DEFAULT_THEME not in css_names:
        failures.append(f"the CSS declares no {DEFAULT_THEME!r} Theme block")
        return failures

    # 3. The default Theme must still apply when NO Theme has been chosen.
    selector = default_theme_selector(css_text) or ""
    if "html:not([data-theme])" not in selector:
        failures.append(
            f"the {DEFAULT_THEME} block must also match `html:not([data-theme])` so the app "
            "renders before the engine runs; found selector: "
            f"{' '.join(selector.split())[-120:]!r}")

    # 4. Completeness: every Theme binds everything the default binds.
    baseline = css_themes[DEFAULT_THEME]
    for name in sorted(css_names - {DEFAULT_THEME}):
        missing = baseline - css_themes[name]
        extra = css_themes[name] - baseline
        if missing:
            failures.append(
                f"Theme {name} does not bind {len(missing)} token(s) that {DEFAULT_THEME} "
                f"binds: {', '.join(sorted(missing))}")
        if extra:
            failures.append(
                f"Theme {name} binds token(s) no other Theme does: {', '.join(sorted(extra))}")

    # 5. No theme-bound token may also be bound theme-independently.
    shared = root_only_tokens(css_text) & baseline
    if shared:
        failures.append(
            "theme-bound token(s) also declared in a theme-independent :root block, which "
            f"re-opens silent inheritance: {', '.join(sorted(shared))}")

    # 6. The published plugin tables are resolved copies — prove they still are.
    published = published_tables(backend_ts)
    if set(published) != css_names:
        failures.append(
            f"published token tables cover {sorted(published)} != "
            f"CSS Theme blocks {sorted(css_names)}")
    else:
        table_keys = {theme: set(table) for theme, table in published.items()}
        baseline_keys = table_keys[DEFAULT_THEME]
        for theme in sorted(css_names - {DEFAULT_THEME}):
            if table_keys[theme] != baseline_keys:
                difference = baseline_keys.symmetric_difference(table_keys[theme])
                failures.append(
                    f"published table for {theme} does not publish the same tokens as "
                    f"{DEFAULT_THEME}: {', '.join(sorted(difference))}")
        for theme in sorted(published):
            bindings = theme_bindings(css_text, theme)
            for token, value in sorted(published[theme].items()):
                resolved = resolve_value(f"--{token}", bindings)
                if resolved is None:
                    failures.append(
                        f"published --rh-{token} for {theme} resolves to nothing in the "
                        "stylesheet: it is not a semantic token of that Theme")
                elif resolved != value:
                    failures.append(
                        f"published --rh-{token} for {theme} is {value!r}, but the "
                        f"stylesheet resolves it to {resolved!r}")

    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--css", type=Path, default=CSS_PATH)
    parser.add_argument("--frontend", type=Path, default=FRONTEND_TS_PATH)
    parser.add_argument("--backend", type=Path, default=BACKEND_TS_PATH)
    parser.add_argument("--sql", type=Path, default=SQL_PATH)
    parser.add_argument("--src", type=Path, default=FRONTEND_SRC,
                        help="frontend component tree scanned for themed islands")
    parser.add_argument("--declared", type=Path, default=None,
                        help="fixture override: JSON list of [path, class, why] triples")
    args = parser.parse_args()

    for path in (args.css, args.frontend, args.backend, args.sql):
        if not path.exists():
            raise SystemExit(f"theme parity gate FAILED: {path} does not exist")

    failures = run(
        args.css.read_text(encoding="utf-8"),
        args.frontend.read_text(encoding="utf-8"),
        args.backend.read_text(encoding="utf-8"),
        args.sql.read_text(encoding="utf-8"),
    )
    declared = DECLARED_PREVIEW_SCOPES
    if args.declared is not None:
        declared = {(entry[0], entry[1]): entry[2]
                    for entry in json.loads(args.declared.read_text(encoding="utf-8"))}
    failures += check_islands(args.src, declared)
    if failures:
        print("Theme parity gate FAILED:", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        return 1

    themes = sorted(theme_blocks(args.css.read_text(encoding="utf-8")))
    print(
        f"Theme parity gate passed ({len(themes)} Themes: {', '.join(themes)}; "
        "one value space across CSS, engine, plugin service and migration)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
