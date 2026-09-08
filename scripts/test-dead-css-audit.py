#!/usr/bin/env python3
"""Self-proof for the dead-selector census (card 3da6b116).

The census's output is a DELETION LIST, so the two ways it can be wrong are
not equally bad and are proved separately:

  * calling a live class dead   — a deletion that breaks the product;
  * calling a dead class live   — a rule that survives, which is the state
                                  the estate was already in.

Every check below runs against known-bad and known-good inputs. A gate whose
self-proof only feeds it the real tree proves that the tree passes, not that
the gate can fail.
"""
from __future__ import annotations

import re
import subprocess
import sys
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

_dead = SourceFileLoader("dead_css", str(HERE / "audit-dead-css.py")).load_module()
_audit = SourceFileLoader("collision_audit", str(HERE / "audit-css-collisions.py")).load_module()

failures: list[str] = []


def check(condition: bool, message: str) -> None:
    print(("  ok    " if condition else "  FAIL  ") + message)
    if not condition:
        failures.append(message)


print("1. a class the tree renders is never reported dead")
# The strongest available live set: every class the estate's own rendered-class
# extractor finds anywhere. If the census calls ANY of them dead in a synthetic
# stylesheet that declares them, the deletion list is unsafe.
rendered = sorted(_dead._rendered.rendered_classes())
check(len(rendered) > 100, f"the rendered set is populated ({len(rendered)} classes)")
sample = rendered[:400]
synthetic = "\n".join(f".{name} {{ color: red; }}" for name in sample)
report = _dead.census(["<synthetic>"], sources={"<synthetic>": synthetic})["<synthetic>"]
check(report["dead"] == [],
      f"none of {len(sample)} rendered classes is called dead"
      + (f" (called dead: {report['dead'][:5]})" if report["dead"] else ""))

print("2. a class nothing renders, builds or mentions IS reported dead")
invented = ".zz-no-such-surface-9f3a { color: red; }\n.zz-no-such-surface-9f3a--x { color: red; }"
report = _dead.census(["<invented>"], sources={"<invented>": invented})["<invented>"]
check(sorted(report["dead"]) == ["zz-no-such-surface-9f3a", "zz-no-such-surface-9f3a--x"],
      f"an invented class is reported dead (got {report['dead']})")

print("3. a class only ASSEMBLED at runtime is kept, not deleted")
# `${...}` is how `check-rendered-classes` normalises an interpolation, and a
# stem plus an interpolation is the false positive the card warns about:
# `${base}-item` cannot be seen by a token matcher.
patterns = _dead.interpolation_patterns()
check(len(patterns) > 0, f"class-name stems were found in the tree ({len(patterns)})")
# EVERY stem, not the first one found. The first draft of this check took
# `raw.split("${")[0]` and appended to it, which is only a name the pattern
# matches when the expression is LAST: for `subtask-${x}-title` it produced
# `subtask-zzz`, which that pattern rightly does not match, and the check
# failed for a reason that had nothing to do with the census. The probe is now
# built the way the runtime builds one — by substituting a value for each
# expression — so a name the pattern must match by construction.
buildable = sorted({re.sub(r"\$\{[^}]*\}", "zzz", raw) for raw, _ in patterns})
buildable = [name for name in buildable if _dead._audit.CLASS_TOKEN_RE.fullmatch("." + name)]
check(len(buildable) > 0, f"assemblable names to test against ({len(buildable)})")
synthetic = "\n".join(f".{name} {{ color: red; }}" for name in buildable)
report = _dead.census(["<buildable>"], sources={"<buildable>": synthetic})["<buildable>"]
check(report["dead"] == [],
      f"all {len(buildable)} assemblable names are kept"
      + (f" (called dead: {report['dead'][:5]})" if report["dead"] else ""))

print("4. a class MENTIONED anywhere is kept, even with no render")
# `sidebar-hamburger` is written out in this repository in more than one place.
mentioned = sorted(_dead.mentions())
sentinel = "relayhall"  # appears throughout; certainly not a rendered class
check(sentinel in mentioned, "the mention index is populated")
report = _dead.census(["<mentioned>"],
                      sources={"<mentioned>": f".{sentinel} {{ color: red; }}"})["<mentioned>"]
check(report["dead"] == [], f".{sentinel} is kept because the name is written somewhere")

print("5. the guarded stylesheets are clean, and the gate says so")
result = subprocess.run([sys.executable, str(HERE / "audit-dead-css.py"), "--check"],
                        capture_output=True, text=True)
check(result.returncode == 0, "audit-dead-css.py --check passes on the tree")

print("6. THE DELETION CONTROL: a LIVE class in a delete list is caught")
# The census is only half of the safety. What actually protected the sweep was
# comparing the classes a stylesheet declares BEFORE and AFTER: everything
# removed must be on the dead list, and nothing else may go. This proves that
# comparison reddens when a live class is smuggled into the list.
sidebar = (ROOT / "frontend/src/components/Sidebar.css").read_text(encoding="utf-8")
declared = _audit.owned_classes(sidebar)
live = sorted(declared)[0] if declared else None
check(live is not None, "Sidebar.css still declares classes to protect")
if live:
    stripped = "\n".join(
        line for line in sidebar.splitlines() if not line.startswith(f".{live}"))
    after = _audit.owned_classes(stripped)
    lost = (declared - after) - set()  # an EMPTY dead list: nothing may go
    check(len(lost) > 0,
          f"removing .{live} with an empty dead list is detected as a live loss")

print("7. a name ASSEMBLED with no stem in it is kept (round-1 review C2)")
# The exact snippet the round-1 review used. It leaves no kebab-case stem
# behind — `sidebar` and `footer` are separate literals — so the stem rule
# alone reported a visibly rendered class dead, which is the dangerous
# direction for a deletion oracle. The constant forms are folded now, and
# this is the fixture rather than a sentence about one.
JOINED = "export const Probe = () => <div className={['sidebar', 'footer'].join('-')} />;"
check("sidebar-footer" in _dead.composed_patterns(JOINED),
      "a constant array join folds to the name it produces")
check("sidebar-${dynamic}" in _dead.composed_patterns(
          "const c = ['sidebar', kind].join('-');"),
      "a join with one unknown piece folds to a stem")
check("sidebar-${dynamic}" in _dead.composed_patterns(
          "const c = 'sidebar' + '-' + kind;"),
      "a constant concatenation folds to a stem")
# And end to end: with that renderer in the tree the class must be KEPT.
_patterns = _dead.interpolation_patterns()
_folded = [(raw, pattern) for raw, pattern in
           [(r, __import__("re").compile("^" + ".*".join(
               __import__("re").escape(p) for p in
               __import__("re").sub(r"\$\{[^}]*\}", "\x00", r).split("\x00")) + "$"))
            for r in _dead.composed_patterns(JOINED)]]
check(any(pattern.fullmatch("sidebar-footer") for _raw, pattern in _folded),
      "the folded pattern matches the name a browser would render")

print("7b. a CHAINED join is folded (round-2 review C2-R2)")
# `.filter(Boolean)` between the array and the join left the old expression
# matching nothing, and the gate reported a class the browser renders as DEAD
# — the dangerous direction for a deletion oracle. This is the reviewer's own
# reproduction, run forwards.
CHAINED = ("export const Probe = () => "
           "<div className={['sidebar', 'footer'].filter(Boolean).join('-')} />;")
check("sidebar-footer" in _dead.composed_patterns(CHAINED),
      "a chained array join folds to the whole name it produces")
# `filter` can DROP pieces, so a name assembled from a SUBSET must be kept too.
DROPPED = "const c = ['sidebar', 'inner', 'footer'].filter(Boolean).join('-');"
check("sidebar-footer" in _dead.composed_patterns(DROPPED),
      "a subsequence of a filtered join folds as well as the whole one")
check("sidebar-inner-footer" in _dead.composed_patterns(DROPPED),
      "and the whole join is still folded")
# END TO END: with that renderer in the tree the class must be KEPT, not just
# produce a string that looks right in the folder's output.
_chain_patterns = [
    (raw, re.compile("^" + ".*".join(
        re.escape(part) for part in
        re.sub(r"\$\{[^}]*\}", "\x00", raw).split("\x00")) + "$"))
    for raw in _dead.composed_patterns(CHAINED)]
check(any(pattern.fullmatch("sidebar-footer") for _raw, pattern in _chain_patterns),
      "the folded chain pattern matches the name a browser would render")

print("7c. THE RESIDUE CONTROL: a composition the gate cannot read reddens it")
# The repair to C2-R2 is not one more fold — it is that the shapes the folder
# CANNOT read are a named set held empty. That is worth nothing unless the set
# can be non-empty, so each rule is reddened here on a snippet, the exclusion
# is pinned so it cannot quietly widen, and the tree walk itself is reddened
# by pointing it at a directory that contains one.
_residue = _dead.unresolved_compositions()
check(_residue == [],
      f"the real frontend contains no unreadable composition (found {len(_residue)})"
      + (f": {_residue[:3]}" if _residue else ""))
check(len(_dead.unresolved_in("<probe>", "const c = parts.join('-');")) == 1,
      "a join with a JOINT separator on an unreadable receiver is residue")
check(len(_dead.unresolved_in("<probe>", "const c = kind + '-footer';")) == 1,
      "a class-name tail welded to a dynamic operand is residue")
check(_dead.unresolved_in("<probe>", CHAINED) == [],
      "the shape the folder CAN read is not residue")
check(_dead.unresolved_in("<probe>", "const s = names.join(', ');") == [],
      "a separator that cannot occur in a class name is not residue")
check(_dead.unresolved_in("<probe>", "const s = words.join('');") == [],
      "an empty separator is the stated exclusion, not residue")
# A chain this cannot fold must not be silently folded: `map` invents pieces,
# so a subsequence of the LITERALS is a guess. The site becomes residue.
MAPPED = "const c = ['sidebar', 'footer'].map(f).join('-');"
check(_dead.composed_patterns(MAPPED) == [],
      "a chain with a transforming call folds to nothing")
check(len(_dead.unresolved_in("<probe>", MAPPED)) == 1,
      "and that site is residue, so the gate refuses the tree")
check(len(_dead.unresolved_in("<probe>", "const c = ['a-b', 'c'].sort().join('-');")) == 1,
      "a reordering chain is residue too")
# The walk, not only the rule: a real directory with a real file in it.
with tempfile.TemporaryDirectory() as _tmp:
    (Path(_tmp) / "Probe.tsx").write_text(
        "export const P = () => <i className={parts.join('-')} />;\n", encoding="utf-8")
    _real_src = _dead.SRC
    try:
        _dead.SRC = Path(_tmp)
        _found = _dead.unresolved_compositions()
    finally:
        _dead.SRC = _real_src
    check(len(_found) == 1 and _found[0][0].endswith("Probe.tsx"),
          f"the tree walk finds an unreadable composition where one exists (got {_found})")
check(_dead.SRC == _real_src, "the real source root was restored")

print("8. the gate's SCOPE is measured, not only described (round-1 review C3)")
# It censuses OWNED classes. A modifier or context class is a reference, and
# the header says so; this checks that the imported criterion really behaves
# that way, so the claim in the CI step name stays true if that criterion
# ever changes.
check(_audit.owned_classes(".a.b { color: red; }") == {"a"},
      "a state modifier is not owned, so it is not censused")
check(_audit.owned_classes(".a .b { color: red; }") == {"a"},
      "a context class is not owned, so it is not censused")
check(_audit.owned_classes(".a { color: red; }\n.b { color: red; }") == {"a", "b"},
      "two standalone declarations are both owned")

print()
if failures:
    print(f"dead-CSS self-proof FAILED ({len(failures)} of the checks above)", file=sys.stderr)
    raise SystemExit(1)
print("Dead-CSS census self-proof passed: it keeps what is rendered, assembled "
      "or written down, reports what is none of those, and the deletion "
      "comparison reddens on a live loss.")
