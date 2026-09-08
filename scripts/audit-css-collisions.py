#!/usr/bin/env python3
"""Cross-stylesheet class-collision audit (task 13cbb482, RH-UI.1b).

A class name may be OWNED (declared standalone) by exactly one ownership
DOMAIN. Every component sheet is its own domain; the shared sheets
(styles/*, index.css, App.css) together form ONE global domain — a shared
class may legitimately carry base rules in index.css and responsive
overrides in styles/responsive-phase3.css. Two component sheets owning the
same class (or a component sheet owning a global-domain class) fight over
specificity and load order; that is the collision this audit rejects.

Criterion (round-3, refined — reviews 2a83b89b F4 + d2ca332b F1): a selector
DECLARES a class only when that class is the FIRST class token of the
selector's first compound — the rule styles the class itself (`.btn`,
`.btn:hover`, `.btn > svg`). Subsequent classes in the same compound
(`.project-card.active`) are STATE MODIFIERS applied from data at runtime;
they are references, owned by whichever sheet declares them standalone. A
class reached through an ancestor (`.tasks-page .filter-bar`) is likewise a
contextual reference. scripts/audit-design-baseline.py imports
this module so both tools measure the identical criterion.

Modes:
  (default)   report collisions with declaring sheets and TSX users
  --check     exit 1 on any cross-stylesheet ownership collision
              (the RH-UI.1b success criterion)
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "frontend" / "src"
EXCLUDED_PARTS = {".git", "node_modules", "dist", "coverage"}

CLASS_TOKEN_RE = re.compile(r"\.([A-Za-z_][\w-]*)")


def files(suffix: str) -> list[Path]:
    return sorted(
        p for p in SRC.rglob(f"*{suffix}")
        if not any(part in EXCLUDED_PARTS for part in p.parts)
    )


def strip_comments(text: str) -> str:
    return re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)


def selector_blocks(text: str):
    """Yield selector strings (the text before each top/nested `{`)."""
    for m in re.finditer(r"([^{}@;]+)\{", strip_comments(text)):
        yield m.group(1)


def _selector_positions(css_text: str):
    """(selector, inside_media) pairs, comment-stripped, brace-tracked."""
    text = strip_comments(css_text)
    stack: list[bool] = []   # per open block: is it an @media block?
    buf = []
    for ch in text:
        if ch == "{":
            sel = "".join(buf).strip()
            is_media = sel.startswith("@media")
            if sel and not sel.startswith("@"):
                yield sel, any(stack)
            stack.append(is_media)
            buf = []
        elif ch == "}":
            if stack:
                stack.pop()
            buf = []
        elif ch == ";":
            buf = []
        else:
            buf.append(ch)


def owned_classes(css_text: str, is_global: bool = False) -> set[str]:
    """Classes this sheet DECLARES: classes of the FIRST compound of any
    comma-separated selector. In the GLOBAL domain, rules inside @media are
    responsive overrides of classes owned elsewhere — not ownership."""
    owned: set[str] = set()
    for selector, in_media in _selector_positions(css_text):
        if is_global and in_media:
            continue
        for part in selector.split(","):
            part = part.strip()
            if not part:
                continue
            first_compound = re.split(r"[\s>+~]", part, maxsplit=1)[0]
            tokens = CLASS_TOKEN_RE.findall(first_compound)
            if tokens:
                owned.add(tokens[0])
    return owned


def referenced_classes(css_text: str) -> set[str]:
    """Every class token appearing anywhere in the sheet's selectors."""
    refs: set[str] = set()
    for selector in selector_blocks(css_text):
        refs.update(CLASS_TOKEN_RE.findall(selector))
    return refs


GLOBAL_DOMAIN = "styles/ + index.css + App.css (global domain)"


def domain_of(rel: str) -> str:
    parts = rel.split("/")
    if parts[-2] == "styles" or parts[-1] in ("index.css", "App.css"):
        return GLOBAL_DOMAIN
    return rel


def declarations() -> dict[str, set[str]]:
    """class -> owning DOMAINS (component sheets individually; shared sheets
    collapse into the single global domain)."""
    declared: dict[str, set[str]] = {}
    for p in files(".css"):
        rel = str(p.relative_to(ROOT))
        is_global = domain_of(rel) == GLOBAL_DOMAIN
        for name in owned_classes(p.read_text(encoding="utf-8"), is_global=is_global):
            declared.setdefault(name, set()).add(domain_of(rel))
    return declared


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="exit 1 on any cross-stylesheet ownership collision")
    args = parser.parse_args()

    declared = declarations()
    collisions = {n: sorted(fs) for n, fs in declared.items() if len(fs) > 1}

    if args.check:
        if collisions:
            print(f"CSS collision audit FAILED: {len(collisions)} class(es) "
                  f"owned by more than one domain:", file=sys.stderr)
            for name, fs in sorted(collisions.items()):
                print(f"  .{name}: {', '.join(fs)}", file=sys.stderr)
            return 1
        print(f"CSS collision audit passed ({len(declared)} classes, "
              f"each owned by exactly one domain)")
        return 0

    ts_texts = {str(p.relative_to(ROOT)): p.read_text(encoding="utf-8")
                for p in files(".tsx") + files(".ts")}
    for name, fs in sorted(collisions.items()):
        users = [rel for rel, text in ts_texts.items() if name in text]
        print(f".{name}")
        print(f"  owned by: {', '.join(fs)}")
        print(f"  referenced by: {', '.join(users) if users else '(no TS/TSX reference found)'}")
    print(f"\n{len(collisions)} colliding class(es) / {len(declared)} total")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
