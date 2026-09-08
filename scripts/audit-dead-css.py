#!/usr/bin/env python3
"""Dead-OWNED-CLASS census — the rendered-class gate, run backwards (card 3da6b116).

WHAT IT DECIDES, EXACTLY (round-1 review CONTROL C3). It censuses the classes
a stylesheet OWNS, which `audit-css-collisions.owned_classes` defines as the
first class token of a selector's first compound — the class a rule styles.
It therefore says NOTHING about:

  * state modifiers and context classes (`.a.b`, `.a .b`): `b` is a reference
    here, owned by whichever sheet declares it standalone;
  * whether a whole selector is JOINTLY reachable — `.sidebar.sidebar-compact`
    survives this gate even where nothing renders `sidebar-compact`, because
    `sidebar` is rendered and owns the rule.

That is a deliberate reuse of the criterion CI already trusts rather than a
second one, and the CI step is named for what it checks. Whole-selector
reachability is a different analysis (co-occurrence, not membership) and is
filed as its own card rather than bolted on here.


`check-rendered-classes.py` asks: does every class a component RENDERS have a
rule? This asks the other half: does every class a stylesheet DECLARES have a
renderer? A rule nothing matches is not merely weight. It distorts every
measurement taken over the file it lives in — walkthrough item R16 ranked
Sidebar.css as the estate's worst raw-px spacing offender, and item R17 counted
ten sub-AA `--text-quaternary` declarations in it of which nine were in rules
nothing renders. A contrast claim is a claim about text somebody reads.

WHY THIS IS NOT A FOURTH CENSUS. The rendered-class set comes from
`check-rendered-classes.py`, which gets it from `audit-css-collisions.py` —
the same extractor CI already trusts, with the same reviewed criterion for
what counts as a declaration and what counts as a render. Writing another one
would be writing a second answer to a question the estate already answers.

IT FAILS CLOSED. "Dead" is the conclusion, so every reason to doubt it wins.
A declared class is reported dead only when ALL of these hold:

  1. It is not in the shared rendered-class set.
  2. It cannot be produced by any class-name template in the tree. Every
     `${...}` interpolation found in a class expression becomes a pattern, and
     a class matching one is UNKNOWN, not dead — `${base}-item` is exactly the
     false positive the card warns about. A constant array join folds too,
     including through a chain that can drop pieces
     (`['sidebar', 'footer'].filter(Boolean).join('-')`), in which case every
     subsequence is folded and not only the whole join.

  2b. AND the frontend composes no class name in a shape this gate cannot
     read. `unresolved_compositions` names those shapes and the gate holds
     that set EMPTY, so "what else might the folder miss?" is answered by a
     fail-closed check rather than by one more round of folding.
  3. Its name does not appear ANYWHERE else in the repository outside the
     stylesheets themselves — not in a `querySelector`, not in a plugin, not
     in a test, not in a document. A mention is not proof of a render, but it
     is proof that a human wrote the name somewhere on purpose, which is
     enough to keep a rule.

So the census under-reports by construction. That is the correct direction of
error for a tool whose output is a deletion list.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from importlib.machinery import SourceFileLoader
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "frontend" / "src"
HERE = Path(__file__).resolve().parent

_rendered = SourceFileLoader(
    "rendered_classes", str(HERE / "check-rendered-classes.py")).load_module()
_audit = SourceFileLoader(
    "collision_audit", str(HERE / "audit-css-collisions.py")).load_module()

# The sheets this gate holds clean. It is a RATCHET: a file joins the list when
# its dead rules are removed, and never leaves it.
GUARDED = [
    "frontend/src/components/Sidebar.css",
]

# Directories no census reads, and the files that would answer their own
# question if they were read.
EXCLUDED_PARTS = {".git", "node_modules", "dist", "coverage", "build"}
SELF = {
    "scripts/audit-dead-css.py",
    "scripts/test-dead-css-audit.py",
    "scripts/dead-css-census.json",
}

TEXT_SUFFIXES = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".html",
    ".py", ".sh", ".sql", ".yml", ".yaml", ".txt", ".conf",
}

# A class-name FRAGMENT that is assembled at runtime: `nim-orb-${state}`.
# The estate's own definition, imported rather than re-stated.
INTERPOLATION_RE = _rendered.INTERPOLATION_RE


def _repo_files() -> list[Path]:
    return [
        p for p in ROOT.rglob("*")
        if p.is_file()
        and not any(part in EXCLUDED_PARTS for part in p.parts)
        and p.suffix in TEXT_SUFFIXES
        and str(p.relative_to(ROOT)).replace("\\", "/") not in SELF
    ]


# A static fragment is treated as a class-name STEM only when it looks like
# one in this estate: kebab-case, at least one hyphen, at least four
# characters. `sidebar-` qualifies; the `s` of `s${i}` and the `m` of
# `${mins}m` do not, and admitting those was the first draft's mistake — a
# one-letter stem matches most of the file and silently empties the census.
STEM_RE = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-?$")


def _is_stem(fragment: str) -> bool:
    return (len(fragment) >= 4 and "-" in fragment and bool(STEM_RE.fullmatch(fragment)))


# `[a, b].join('-')` and `'a' + '-' + b`: a class name ASSEMBLED from pieces,
# where no single piece is a stem. Round-1 review CONTROL C2 found this with
# `className={['sidebar', 'footer'].join('-')}`, which the census reported dead
# while the browser rendered it. Folding the constant forms is bounded work
# with a terminating shape; what remains beyond it is stated, not hidden — and
# since round-2 review CONTROL C2-R2 it is also FAILED CLOSED
# (`unresolved_compositions`) rather than only stated.
#
# The array may be followed by a CHAIN of calls before `.join`. Round 2 found
# `['sidebar', 'footer'].filter(Boolean).join('-')` reported dead while the
# browser rendered it, because the old expression required `.join` immediately
# after `]`. The chain is admitted here, and — because a call like `filter` can
# DROP pieces — every subsequence of the pieces is folded, not only the whole
# join. Widening the kept set is the safe direction for a deletion list.
#
# ONLY THREE METHODS ARE ADMITTED, and the restriction is the point. `filter`,
# `slice` and `flat` can drop or flatten pieces but never invent one, so the
# subsequence fold covers everything they can produce. `map` invents pieces,
# `sort` and `reverse` reorder them, `concat` adds them — under any of those
# the fold would be a GUESS about a deletion list. A chain this does not admit
# therefore does not match at all, which sends the site to
# `unresolved_compositions` and fails the gate closed.
FOLDABLE_CHAIN_METHODS = ("filter", "slice", "flat")
JOIN_RE = re.compile(
    r"\[([^\[\]]*)\]"
    r"((?:\s*\.\s*(?:" + "|".join(FOLDABLE_CHAIN_METHODS) + r")\s*\([^()]*\))*?)"
    r"\s*\.\s*join\(\s*(['\"])([^'\"]*)\3\s*\)")
# Any `.join('<literal>')`, whatever its receiver: the residue census below
# subtracts from these the ones JOIN_RE could read.
ANY_JOIN_RE = re.compile(r"\.\s*join\(\s*(['\"])([^'\"]*)\1\s*\)")
# A separator that can weld two fragments into ONE kebab-case class name.
# A space joins a class LIST — each piece is then a whole name that rule 3
# sees — and `, `, `/`, a newline cannot occur in a class name at all.
CLASS_JOINT_RE = re.compile(r"^[A-Za-z0-9_-]+$")
# A class-name TAIL welded onto something dynamic: `kind + '-footer'`. The
# fold below reads a concatenation that STARTS with a literal; this is the
# other direction, and it is fail-closed rather than folded.
DYNAMIC_TAIL_RE = re.compile(
    r"(?:\+\s*(['\"])([-_][A-Za-z0-9][\w-]*)\1)"
    r"|(?:(['\"])([-_][A-Za-z0-9][\w-]*)\3\s*\+)")
# Above this many pieces the subsequence fold stops being bounded work, and
# the site becomes residue instead of a fold.
MAX_JOIN_PIECES = 10
STRING_LITERAL_RE = re.compile(r"^\s*(['\"])([^'\"]*)\1\s*$")
QUOTED_PIECE_RE = re.compile(r"(['\"])([\w-]*)\1")
CONCAT_RE = re.compile(
    r"(['\"])([A-Za-z][\w-]*)\1\s*\+\s*(?:(['\"])([\w-]*)\3\s*\+\s*)*")


def _join_pieces(inner: str) -> list[str]:
    """The pieces of a bracketed array literal, unknown ones as a slot."""
    pieces: list[str] = []
    for item in inner.split(","):
        literal = STRING_LITERAL_RE.match(item)
        if literal:
            pieces.append(literal.group(2))
        elif item.strip():
            pieces.append("${dynamic}")
    return pieces


def _subsequences(pieces: list[str]) -> list[list[str]]:
    """Every non-empty subsequence, in order. Caller bounds the length."""
    return [[piece for index, piece in enumerate(pieces) if mask >> index & 1]
            for mask in range(1, 1 << len(pieces))]


def composed_patterns(source: str) -> list[str]:
    """Raw class-name shapes a constant join or concatenation can produce.

    Pure, so the self-proof can hand it the exact snippet the review used
    instead of hoping the tree still contains one.
    """
    raws: list[str] = []
    for inner, chain, _quote, separator in JOIN_RE.findall(source):
        pieces = _join_pieces(inner)
        if len(pieces) < 2 or len(pieces) > MAX_JOIN_PIECES:
            continue
        if chain.strip():
            # A call between the array and the join may drop pieces, so every
            # subsequence is a name the browser can be handed.
            for subset in _subsequences(pieces):
                raws.append(separator.join(subset))
        else:
            raws.append(separator.join(pieces))
    # `'sidebar' + '-' + kind` folds to the stem `sidebar-`.
    for match in CONCAT_RE.finditer(source):
        folded = "".join(pair[1] for pair in QUOTED_PIECE_RE.findall(match.group(0)))
        if folded:
            raws.append(folded + "${dynamic}")
    return raws


def interpolation_patterns() -> list[tuple[str, re.Pattern[str]]]:
    """Every class-name shape the tree can ASSEMBLE rather than write out.

    WHAT A BARE SLOT DOES NOT MEAN. `_read_template` normalises every
    interpolation to `${dynamic}`, so a className like `sidebar ${dynamic}`
    says "the class `sidebar`, plus whatever that expression yields". Treating
    such a slot as matching every name — the safest-looking reading — makes
    the census report nothing at all, in a tree with about a hundred of them.
    It is also stronger than the truth: for a bare slot to yield the name
    `sidebar-footer`, that name has to EXIST somewhere. Either it is written
    out, in which case rule 3's mention pass keeps it, or it is assembled from
    a stem and an expression, which is what this function collects.

    So the collection is deliberately wider than className attributes: every
    template literal and every string literal in the tree whose static part
    ends in a class-name stem contributes a pattern. `sidebar-${kind}` in a
    helper, and `'sidebar-' + kind`, both leave `sidebar-` behind, and both
    are caught. What is NOT caught is a name assembled from pieces none of
    which is a stem — `\'side\' + \'bar-\' + kind` — and that is stated here
    rather than papered over.
    """
    patterns: list[tuple[str, re.Pattern[str]]] = []
    seen: set[str] = set()

    def add(raw: str) -> None:
        body = re.sub(r"\$\{[^}]*\}", "\x00", raw)
        parts = [p for p in body.split("\x00")]
        if not any(_is_stem(p) for p in parts if p):
            return
        key = body
        if key in seen:
            return
        seen.add(key)
        patterns.append((raw, re.compile("^" + ".*".join(
            re.escape(part) for part in parts) + "$")))

    for path in sorted(SRC.rglob("*")):
        if path.suffix not in {".ts", ".tsx"} or any(part in EXCLUDED_PARTS for part in path.parts):
            continue
        source = path.read_text(encoding="utf-8")
        # Template literals anywhere in the file, not just className.
        for raw in set(re.findall(r"[A-Za-z0-9_-]*(?:\$\{[^}`]*\}[A-Za-z0-9_-]*)+", source)):
            add(raw)
        # A string literal ending in a hyphen is a concatenation stem.
        for literal in set(re.findall(r"['\"]([A-Za-z][A-Za-z0-9-]*-)['\"]", source)):
            add(literal + "${dynamic}")
        # And the constant compositions that leave no stem at all (C2).
        for raw in set(composed_patterns(source)):
            add(raw)
    return patterns


def unresolved_in(rel: str, source: str) -> list[tuple[str, int, str]]:
    """The unreadable class compositions in ONE source.

    Pure, so the self-proof can hand it a snippet and watch it redden instead
    of hoping the tree contains one.
    """
    found: list[tuple[str, int, str]] = []

    def line_of(offset: int) -> int:
        return source.count("\n", 0, offset) + 1

    readable_ends = set()
    for match in JOIN_RE.finditer(source):
        pieces = _join_pieces(match.group(1))
        if 2 <= len(pieces) <= MAX_JOIN_PIECES:
            readable_ends.add(match.end())
    for match in ANY_JOIN_RE.finditer(source):
        if not CLASS_JOINT_RE.fullmatch(match.group(2)):
            continue
        if match.end() in readable_ends:
            continue
        found.append((rel, line_of(match.start()),
                      "a join on a receiver this gate cannot read: "
                      + " ".join(match.group(0).split())))
    for match in DYNAMIC_TAIL_RE.finditer(source):
        found.append((rel, line_of(match.start()),
                      "a class-name tail welded to a dynamic operand: "
                      + " ".join(match.group(0).split())))
    return found


def unresolved_compositions() -> list[tuple[str, int, str]]:
    """Class-name compositions in the frontend that this gate CANNOT read.

    Round-2 review CONTROL C2-R2. The answer to "which composed name can the
    folder still miss?" is not a longer folder — every round would find one
    more shape, and the one that lands in a deletion list is the one nobody
    thought of. It is a set the gate NAMES and holds EMPTY, so a shape it
    cannot read cannot arrive silently: adding one reddens this gate, and the
    author either writes it in a shape the folder reads or teaches the folder.

    Two shapes are in the set, and they are the two that can produce a
    kebab-case class name none of whose pieces is written out anywhere:

      A. `<something>.join(SEP)` where SEP is made only of characters legal in
         a class name and is not empty — a JOINT — and the receiver is not a
         bracketed array literal `composed_patterns` can read.
      B. a string literal beginning with `-` or `_` on either side of a `+`:
         `kind + '-footer'`, the concatenation whose leading operand is
         dynamic. (`'sidebar-' + kind`, the other direction, folds to a stem.)

    WHAT IS DELIBERATELY OUT OF THE SET, by name and with its reason:
    `.join('')` on a receiver this cannot read. An empty separator introduces
    no hyphen or underscore, so it cannot weld fragments into a composite name
    in this estate; it can only concatenate pieces that are already whole
    names, and a whole name written anywhere is kept by rule 3.
    """
    residue: list[tuple[str, int, str]] = []
    for path in sorted(SRC.rglob("*")):
        if path.suffix not in {".ts", ".tsx"} or any(part in EXCLUDED_PARTS for part in path.parts):
            continue
        try:
            rel = str(path.relative_to(ROOT)).replace("\\", "/")
        except ValueError:
            # SRC outside ROOT: the self-proof points it at a throwaway
            # directory to prove this walk can find something.
            rel = str(path)
        if rel in SELF:
            continue
        residue.extend(unresolved_in(rel, path.read_text(encoding="utf-8")))
    return residue


def mentions() -> dict[str, set[str]]:
    """Where each identifier-shaped token appears outside the stylesheets."""
    index: dict[str, set[str]] = {}
    token = re.compile(r"[A-Za-z_][\w-]*")
    for path in _repo_files():
        rel = str(path.relative_to(ROOT)).replace("\\", "/")
        if rel.startswith("frontend/src/") and rel.endswith(".css"):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for name in set(token.findall(text)):
            index.setdefault(name, set()).add(rel)
    return index


def census(stylesheets: list[str], sources: dict[str, str] | None = None) -> dict:
    """The census over the named stylesheets.

    `sources` supplies CSS text for a name instead of reading a file. The
    self-proof needs it: a gate whose only input is the real tree can only
    ever demonstrate that the tree passes, never that the gate can fail, and
    writing throwaway stylesheets into a repository that has an exact-match
    file allowlist is a worse answer than a parameter.
    """
    rendered: set[str] = set(_rendered.rendered_classes())
    patterns = interpolation_patterns()
    mention_index = mentions()

    report: dict[str, dict] = {}
    for rel in stylesheets:
        if sources is not None and rel in sources:
            css = sources[rel]
        else:
            css = (ROOT / rel).read_text(encoding="utf-8")
        is_global = rel.startswith("frontend/src/styles/") or rel in {
            "frontend/src/index.css", "frontend/src/App.css"}
        declared = _audit.owned_classes(css, is_global=is_global)
        dead, live, unknown = [], [], []
        for name in sorted(declared):
            if name in rendered:
                live.append(name)
                continue
            built = [raw for raw, pattern in patterns if pattern.fullmatch(name)]
            if built:
                unknown.append({"class": name, "reason": "buildable", "by": sorted(set(built))[:4]})
                continue
            where = sorted(mention_index.get(name, set()))
            if where:
                unknown.append({"class": name, "reason": "mentioned", "in": where[:4]})
                continue
            dead.append(name)
        report[rel] = {
            "declared": len(declared),
            "rendered": sorted(live),
            "unknown": unknown,
            "dead": dead,
        }
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stylesheet", action="append", default=None,
                        help="a repo-relative CSS path (default: the guarded list)")
    parser.add_argument("--check", action="store_true",
                        help="exit 1 when a guarded stylesheet OWNS a class nothing renders")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    sheets = args.stylesheet or GUARDED
    report = census(sheets)

    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0

    failed = False
    residue = unresolved_compositions()
    if residue:
        print("UNREADABLE CLASS COMPOSITIONS "
              "(no dead verdict below is safe while one of these stands):")
        for rel, line, detail in residue:
            print(f"    {rel}:{line}  {detail}")
        failed = True
    for rel, result in report.items():
        print(f"{rel}: {result['declared']} owned, "
              f"{len(result['rendered'])} rendered, "
              f"{len(result['unknown'])} kept as unknown, "
              f"{len(result['dead'])} dead")
        for entry in result["unknown"]:
            detail = entry.get("by") or entry.get("in")
            print(f"    kept  .{entry['class']}  ({entry['reason']}: {', '.join(detail)})")
        for name in result["dead"]:
            print(f"    DEAD  .{name}")
        if result["dead"]:
            failed = True

    if args.check and failed:
        print("\nDead-owned-class gate FAILED: a guarded stylesheet OWNS a class "
              "nothing renders, nothing can assemble and nothing mentions — or the "
              "frontend composes a class name in a shape this gate cannot read, "
              "which makes every dead verdict unsafe. (Modifier and context "
              "classes are out of scope by construction; see this file's "
              "header.)", file=sys.stderr)
        return 1
    if args.check:
        print("\nDead-owned-class gate passed: every class the guarded stylesheets "
              "OWN is rendered, assemblable or named somewhere on purpose, and the "
              "frontend composes no class name in a shape this gate cannot read.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
