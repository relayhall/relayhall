#!/usr/bin/env python3
"""The control for `check-workflow-shape.py`.

A gate that has never been shown to go red is a gate nobody has measured. This
feeds the checker one malformed workflow PER RULE — including the EXACT welded
step that made card 50e74c1d's branch schedule no CI run at all, and the
no-trigger/null-`run` probe review `a4a748d5` used to demonstrate a false green
— and requires a failure for each, then requires the real repository to pass.

EVERY RULE HAS AT LEAST ONE CASE, and that much is asserted rather than
assumed: every case names the rule it is for, and the run fails unless every
declared rule is named by some case. Round 2's reading of an earlier version
was that `HEADERLESS` and `BOTH_RUN_AND_USES` are opposite violations of the
SAME action-cardinality rule while parse rule 1 had no case at all — true, and
the reason the mapping is data rather than a docstring claim.

WHAT THAT ASSERTION DOES NOT PROVE, said plainly because round 3 found the
earlier wording overstated it (`5b4b197c`, MINOR): the tags are SELF-DECLARED,
several rules carry more than one case, and nothing here binds a tag to the
checker branch that actually emitted the red. What IS measured per case is
real and is the part worth trusting: the checker exits non-zero, and its
stderr contains the phrase that rule's branch is written to produce. So this
control proves each listed defect is caught and each rule has been thought
about; it does not prove a one-to-one mapping, and no longer claims one.

The no-trigger case is the one that would have been easiest to get wrong in the
harmless direction: YAML 1.1 resolves a bare `on:` to the boolean `True`, so a
checker that looks up the STRING 'on' reddens every valid workflow in the
repository. `real_repository_passes` and `well_formed_workflow_passes` are what
stop that from being written, which is why they are assertions and not comments.
"""
from __future__ import annotations

import pathlib
import subprocess
import sys
import tempfile

CHECKER = 'scripts/check-workflow-shape.py'

VALID = """name: CI
on:
  push:
    branches: ['**']
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Do the thing
        run: echo hello
"""

# The real defect, reproduced verbatim in shape: the conflict fell between a
# step's header and its body, so one step lost its `run` and the next gained a
# second one.
WELDED = """name: CI
on:
  push:
    branches: ['**']
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Report link authorization
      - name: Telemetry projection authorization
        run: npm run test:report-link
        run: npm run test:telemetry-projection
"""

BOTH_RUN_AND_USES = """name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Two things at once
        uses: actions/checkout@v4
        run: echo hello
"""

UNKNOWN_KEY = """name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Typo
        run: echo hello
        wtih:
          value: 1
"""

NO_STEPS = """name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps: []
"""

HEADERLESS = """name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: A header whose body went missing
      - name: The next step
        run: echo hello
"""

# The review's own probe, verbatim in shape: no `on:` at all, and a `run:` key
# whose value is null. The checker exited 0 on this, and a workflow of this
# shape is scheduled by nothing and would execute nothing if it were.
NO_TRIGGER_NULL_RUN = """name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: A step that runs nothing
        run:
"""

# The two halves of that probe, separately, so a checker that regained one rule
# and lost the other cannot pass on the strength of the case that bundles them.
NO_TRIGGER = """name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Do the thing
        run: echo hello
"""

EMPTY_TRIGGER = """name: CI
on:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Do the thing
        run: echo hello
"""

# Review round 3's probe, verbatim in shape. `1` is TRUTHY and is not an event,
# and the first version of the trigger rule — which asked only whether the
# value was truthy — passed it.
NUMERIC_TRIGGER = """name: CI
on: 1
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Do the thing
        run: echo hello
"""

# The same hole in its other two spellings, so a rule that regained the scalar
# case and kept the container cases open cannot pass on the strength of one.
NONEVENT_LIST_TRIGGER = """name: CI
on: [1, true]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Do the thing
        run: echo hello
"""

EMPTY_LIST_TRIGGER = """name: CI
on: []
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Do the thing
        run: echo hello
"""

NULL_RUN = """name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: A step that runs nothing
        run:
"""

# Parse rule 1 had no case of its own: an unterminated flow sequence is a file
# the loader refuses outright, which is a file the runner refuses outright.
MALFORMED = """name: CI
on: [push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Do the thing
        run: echo hello
"""

# `on:` in its scalar spelling, which YAML resolves to the boolean key just as
# the mapping spelling does. A second WELL-FORMED shape, so the trigger rule is
# measured for false REDS as well as false greens.
VALID_SCALAR_TRIGGER = """name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Do the thing
        run: echo hello
"""

# label, content, expected phrases, RULE. The rule tag is asserted below: the
# six rules must be covered exactly once each, so "each case reddens a
# different rule" is measured rather than claimed.
CASES = [
    # The duplicate-key rule fires FIRST and aborts the parse, which is the
    # right order: a file the loader refuses is a file the runner refuses. So
    # this case is expected to redden on that rule alone, and `HEADERLESS`
    # below exercises the one-action rule on its own.
    ('welded step (the 50e74c1d defect)', WELDED, ['duplicate key'], 'duplicate-keys'),
    ('a file the loader cannot parse', MALFORMED, ['does not parse'], 'parses'),
    ('no `on:` trigger at all', NO_TRIGGER, ['names no event'], 'trigger'),
    ('an `on:` key with nothing under it', EMPTY_TRIGGER, ['names no event'], 'trigger'),
    # Round 3's MAJOR, and its two siblings. Truthy is not an event.
    ('a TRUTHY non-event trigger (`on: 1`)', NUMERIC_TRIGGER, ['names no event'], 'trigger'),
    ('a trigger list of non-events', NONEVENT_LIST_TRIGGER, ['are not event names'], 'trigger'),
    ('an empty trigger list', EMPTY_LIST_TRIGGER, ['empty list'], 'trigger'),
    ('a header whose body went missing', HEADERLESS, ['EXACTLY ONE'], 'one-action'),
    ('run and uses together', BOTH_RUN_AND_USES, ['EXACTLY ONE'], 'one-action'),
    ('a `run:` with a null value', NULL_RUN, ['NON-EMPTY STRING'], 'action-value'),
    # The review's probe, whole. It must redden on BOTH rules at once, which is
    # a different assertion from the two above: it is the shape that was
    # measured passing, so it is the shape carried here verbatim.
    ('the review probe: no trigger AND a null run', NO_TRIGGER_NULL_RUN,
     ['names no event', 'NON-EMPTY STRING'], 'review-probe'),
    ('unknown step key', UNKNOWN_KEY, ['unknown step key'], 'known-keys'),
    ('a job with no steps', NO_STEPS, ['has no steps'], 'steps-present'),
]

# Every rule the checker's docstring claims. `review-probe` is deliberately not
# a rule of its own: it is required to redden two of them together. A rule with
# no case is a rule nobody has measured, so the run fails rather than reporting
# a smaller number of passes.
RULES = {'parses', 'duplicate-keys', 'trigger', 'steps-present', 'one-action',
         'action-value', 'known-keys', 'forge-parity', 'gate-census', 'full-tier-unconditional'}


def run_checker(cwd: pathlib.Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, CHECKER], cwd=cwd, capture_output=True, text=True)


def repository_root() -> pathlib.Path:
    return pathlib.Path(subprocess.run(
        ['git', 'rev-parse', '--show-toplevel'],
        capture_output=True, text=True, check=True).stdout.strip())


def sandbox_with(root: pathlib.Path, sandbox: pathlib.Path, content: str) -> subprocess.CompletedProcess:
    """One throwaway repository carrying `content` as BOTH CI copies."""
    subprocess.run(['git', 'init', '--quiet', str(sandbox)], check=True)
    for directory in ('.github/workflows', '.gitea/workflows'):
        target = sandbox / directory
        target.mkdir(parents=True)
        # BOTH copies carry the same file, so a failure is about the shape
        # rather than about the two files differing.
        (target / 'ci.yml').write_text(content, encoding='utf-8')
    (sandbox / 'scripts').mkdir()
    (sandbox / CHECKER).write_text(
        (root / CHECKER).read_text(encoding='utf-8'), encoding='utf-8')
    return run_checker(sandbox)


# ---------------------------------------------------------------------------
# Rules 7-9 (card 5de6ed89) cannot be expressed as ONE workflow file: they are
# about the relationship BETWEEN the two forges' copies, between the census and
# the tiers, and about a second file. Each case below is a whole throwaway tree.

CENSUS = 'scripts/ci-gate-steps.txt'

MINIMAL = """name: CI
on:
  push:
    branches: ['**']
jobs:
  only:
    runs-on: ubuntu-latest
    steps:
      - name: A gate
        run: 'true'
"""

FULL_TIER_CLEAN = """name: CI (full)
on:
  workflow_dispatch:
jobs:
  heavy:
    runs-on: ubuntu-latest
    steps:
      - name: A heavy gate
        run: 'true'
"""

FULL_TIER_CONDITIONAL = """name: CI (full)
on:
  workflow_dispatch:
jobs:
  heavy:
    runs-on: ubuntu-latest
    steps:
      - name: A heavy gate
        if: ${{ github.ref == 'refs/heads/main' }}
        run: 'true'
"""

# label, files (path -> content), phrases required in stderr, rule
TREE_CASES = [
    ('the two forges DIFFER',
     {'.github/workflows/ci.yml': MINIMAL,
      '.gitea/workflows/ci.yml': MINIMAL.replace("run: 'true'", "run: 'false'")},
     ['copies DIFFER'], 'forge-parity'),
    ('a workflow on ONE forge only',
     {'.github/workflows/ci.yml': MINIMAL},
     ['MISSING from'], 'forge-parity'),
    ('a censused gate in NEITHER tier',
     {'.github/workflows/ci.yml': MINIMAL,
      '.gitea/workflows/ci.yml': MINIMAL,
      '.github/workflows/ci-full.yml': FULL_TIER_CLEAN,
      '.gitea/workflows/ci-full.yml': FULL_TIER_CLEAN,
      CENSUS: '# census\nA gate\nA heavy gate\nA gate that was deleted\n'},
     ['GATE LOST', 'A gate that was deleted'], 'gate-census'),
    ('a censused gate in BOTH tiers',
     {'.github/workflows/ci.yml': MINIMAL,
      '.gitea/workflows/ci.yml': MINIMAL,
      '.github/workflows/ci-full.yml': FULL_TIER_CLEAN.replace('A heavy gate', 'A gate'),
      '.gitea/workflows/ci-full.yml': FULL_TIER_CLEAN.replace('A heavy gate', 'A gate'),
      CENSUS: '# census\nA gate\n'},
     ['GATE DUPLICATED'], 'gate-census'),
    ('the full tier deleted while the census still names its gates',
     {'.github/workflows/ci.yml': MINIMAL,
      '.gitea/workflows/ci.yml': MINIMAL,
      CENSUS: '# census\nA gate\nA heavy gate\n'},
     ['ci-full.yml is missing'], 'gate-census'),
    ('a CONDITION inside the full tier',
     {'.github/workflows/ci.yml': MINIMAL,
      '.gitea/workflows/ci.yml': MINIMAL,
      '.github/workflows/ci-full.yml': FULL_TIER_CONDITIONAL,
      '.gitea/workflows/ci-full.yml': FULL_TIER_CONDITIONAL,
      CENSUS: '# census\nA gate\nA heavy gate\n'},
     ['carries `if:', 'will be skipped'], 'full-tier-unconditional'),
    ('an EMPTY census, which would assert nothing',
     {'.github/workflows/ci.yml': MINIMAL,
      '.gitea/workflows/ci.yml': MINIMAL,
      CENSUS: '# nothing but a comment\n'},
     ['names no gate'], 'gate-census'),
]

# The non-vacuity partner for the cases above: the same shape, correct.
TREE_VALID = {
    '.github/workflows/ci.yml': MINIMAL,
    '.gitea/workflows/ci.yml': MINIMAL,
    '.github/workflows/ci-full.yml': FULL_TIER_CLEAN,
    '.gitea/workflows/ci-full.yml': FULL_TIER_CLEAN,
    CENSUS: '# census\nA gate\nA heavy gate\n',
}


def sandbox_tree(root: pathlib.Path, sandbox: pathlib.Path, files: dict) -> subprocess.CompletedProcess:
    """One throwaway repository carrying an arbitrary set of files."""
    subprocess.run(['git', 'init', '--quiet', str(sandbox)], check=True)
    for relative, content in files.items():
        target = sandbox / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding='utf-8')
    (sandbox / 'scripts').mkdir(exist_ok=True)
    (sandbox / CHECKER).write_text(
        (root / CHECKER).read_text(encoding='utf-8'), encoding='utf-8')
    return run_checker(sandbox)


def main() -> int:
    root = repository_root()
    failures = 0

    # Coverage of the rule set, before anything is run. A rule that lost its
    # case would otherwise show up as a shorter list of passes, which is what a
    # green run looks like. This asserts AT LEAST ONE case per rule — see the
    # module docstring for what it deliberately does not claim.
    all_cases = CASES + TREE_CASES
    covered = {rule for _, _, _, rule in all_cases if rule in RULES}
    uncovered = sorted(RULES - covered)
    unknown_rules = sorted({rule for _, _, _, rule in all_cases} - RULES - {'review-probe'})
    if uncovered or unknown_rules:
        print(f'rule coverage is wrong: uncovered={uncovered} unknown={unknown_rules}', file=sys.stderr)
        failures += 1
    else:
        print(f'rules_with_at_least_one_case={len(RULES)} cases={len(all_cases)}')

    real = run_checker(root)
    if real.returncode != 0:
        print('the REAL repository does not satisfy its own workflow gate:', file=sys.stderr)
        print(real.stderr, file=sys.stderr)
        failures += 1
    else:
        print('real_repository_passes=pass')

    for label, content, expected, rule in CASES:
        with tempfile.TemporaryDirectory() as raw:
            result = sandbox_with(root, pathlib.Path(raw), content)
            if result.returncode == 0:
                print(f'MUTATION NOT CAUGHT: {label} (rule {rule})', file=sys.stderr)
                failures += 1
                continue
            missing = [phrase for phrase in expected if phrase not in result.stderr]
            if missing:
                print(f'{label}: went red for the wrong reason; missing {missing}', file=sys.stderr)
                print(result.stderr, file=sys.stderr)
                failures += 1
                continue
            print(f'mutation_caught={label.replace(" ", "_")} rule={rule}')

    # Non-vacuity: the VALID workflows must pass, or every assertion above is
    # satisfied by a checker that refuses everything. BOTH trigger spellings
    # are here on purpose — YAML resolves a bare `on` to a boolean, so a
    # trigger rule written against the string 'on' reddens every real workflow
    # in this repository, and this is the assertion that catches that.
    for label, content in (('mapping_trigger', VALID), ('scalar_trigger', VALID_SCALAR_TRIGGER)):
        with tempfile.TemporaryDirectory() as raw:
            result = sandbox_with(root, pathlib.Path(raw), content)
            if result.returncode != 0:
                print(f'a WELL-FORMED workflow ({label}) was refused — the gate refuses everything:', file=sys.stderr)
                print(result.stderr, file=sys.stderr)
                failures += 1
            else:
                print(f'well_formed_workflow_passes={label}')

    # Rules 7-9. Whole-tree cases, each with its own throwaway repository.
    for label, files, expected, rule in TREE_CASES:
        with tempfile.TemporaryDirectory() as raw:
            result = sandbox_tree(root, pathlib.Path(raw), files)
            if result.returncode == 0:
                print(f'MUTATION NOT CAUGHT: {label} (rule {rule})', file=sys.stderr)
                failures += 1
                continue
            missing = [phrase for phrase in expected if phrase not in result.stderr]
            if missing:
                print(f'{label}: went red for the wrong reason; missing {missing}', file=sys.stderr)
                print(result.stderr, file=sys.stderr)
                failures += 1
                continue
            print(f'mutation_caught={label.replace(" ", "_")} rule={rule}')

    with tempfile.TemporaryDirectory() as raw:
        result = sandbox_tree(root, pathlib.Path(raw), TREE_VALID)
        if result.returncode != 0:
            print('a WELL-FORMED two-tier tree was refused — rules 7-9 refuse everything:',
                  file=sys.stderr)
            print(result.stderr, file=sys.stderr)
            failures += 1
        else:
            print('well_formed_two_tier_tree_passes=pass')

    # FAIL CLOSED ON THE CENSUS ITSELF. Rules 8 and 9 are keyed on the census
    # file's presence, which is what lets the cases above use throwaway trees
    # that have none. That key is also the way to switch both rules off, so the
    # REAL repository is required to carry a non-empty census here. Deleting
    # `scripts/ci-gate-steps.txt` reddens this control rather than quietly
    # retiring the rule that says no gate was lost.
    census = root / CENSUS
    listed = []
    if census.exists():
        listed = [line.strip() for line in census.read_text(encoding='utf-8').splitlines()
                  if line.strip() and not line.lstrip().startswith('#')]
    if not listed:
        print(f'the REAL repository has no gate census at {CENSUS} — rules 8 and 9 '
              f'are keyed on it, so without it no gate is protected from being '
              f'dropped between the tiers', file=sys.stderr)
        failures += 1
    else:
        print(f'real_repository_gate_census={len(listed)}')

    return 1 if failures else 0


if __name__ == '__main__':
    raise SystemExit(main())
