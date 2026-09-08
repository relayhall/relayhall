#!/usr/bin/env python3
"""A workflow the runner cannot parse produces NO RUN AT ALL.

WHY THIS EXISTS. Card 50e74c1d rebased onto a `main` that had added its own
real-PostgreSQL gate at the same anchor, and the keep-both conflict resolution
fell BETWEEN one step's header and its body. The result was a `steps:` list
where one entry had a `name` and nothing else, and the next had TWO `run:`
keys. Every local gate stayed green — `yaml.safe_load` silently keeps the last
of a duplicate key, and nothing else read the file — while Gitea Actions
scheduled no run whatsoever for that branch. The push looked successful, the
branch looked fine, and CI was simply SILENT for two commits.

That is the failure mode this gate is about: not a workflow that fails, but a
workflow that never runs. Silence is indistinguishable from "not started yet"
until someone counts.

WHAT IT ENFORCES, over both `.github/workflows/*.yml` and `.gitea/workflows/*.yml`:

  1. the file parses;
  2. NO DUPLICATE KEYS anywhere in it — the loader below refuses them rather
     than resolving them, because "last one wins" is exactly how a welded step
     passes for valid;
  3. an `on:` trigger that NAMES EVENTS — a non-empty string, a list of
     non-empty strings, or a mapping keyed by them — because a workflow with no
     event to fire on schedules nothing at all, the same silence reached by a
     different road. Truthiness is NOT the test: review round 3 rejected a
     first version of this rule that accepted `on: 1`;
  4. every job has a non-empty `steps` list;
  5. every step carries EXACTLY ONE of `run` or `uses`, AND that key's VALUE is
     a non-empty string — a step with neither is a header whose body went
     missing, a step with both is two steps welded together, and a step whose
     `run:` is null is a header that only LOOKS like it has a body;
  6. every step's keys are known workflow keys, so a typo (`with:` spelled
     `wtih:`) is a failure rather than an ignored block.

  7. THE TWO FORGES CARRY THE SAME FILES. Every workflow basename exists in
     both `.github/workflows` and `.gitea/workflows` and the two copies are
     byte-identical. A gate that runs on one forge and not the other is a gate
     whose result depends on where you pushed;
  8. NO GATE IS LOST BETWEEN THE TIERS. `scripts/ci-gate-steps.txt` holds the
     name of every gate step this repository ran when CI was split into a fast
     tier (`ci.yml`, every push) and a full tier (`ci-full.yml`, on demand),
     and each of those names must appear EXACTLY ONCE across the two
     workflows. Once, not at-least-once: a gate quietly present in both tiers
     pays its cost on every push, and a gate present in neither has been
     deleted by a refactor rather than by a decision. The rule FAILS CLOSED —
     a name that disappears from the workflows is an error, and the census
     file's own deletion is caught by this gate's control,
     `scripts/test-workflow-shape-gate.py`, which requires it to exist and be
     non-empty in the real repository;
  9. THE FULL TIER HAS NO CONDITIONS. No job and no step in `ci-full.yml`
     carries an `if:`. Its trigger is the only thing that decides whether it
     runs. This is the whole reason the split is safe to make: the owner ruling
     of 2026-09-07 moved the full matrix off every push, and the guard on that
     ruling is that when the full matrix DOES run, nothing in it can be skipped.

Rules 7-9 arrived with card 5de6ed89 (RH-CI.SPEED), which split one hour-long
workflow into two. Rules 8 and 9 are the ones that make the split reversible
rather than lossy: 8 says the set of gates did not change, 9 says the full tier
still means what it meant when it was unconditional.

Rules 3 and the value half of rule 5 were added by review `a4a748d5` (MAJOR),
which ran this checker against a workflow carrying no `on:` and a null `run:`
and watched it exit 0. The gate caught the exact incident it was written for
and green-lit the class it advertised; a gate that closes one coordinate of a
class is a gate that will be trusted for the rest of it.

Then review `5b4b197c` (MAJOR) said the SAME THING ABOUT THE REPAIR: rule 3
tested truthiness, so `on: 1` — truthy, and not an event — still passed. That
is the second time this rule was written to the coordinate rather than to the
class, which is the argument for `_trigger_problems` below asking about SHAPE
in all three spellings instead of asking whether a value is present.

`on` IS THE TRAP IN RULE 3, and it is worth naming. YAML 1.1 — which PyYAML
implements — resolves the bare word `on` to the BOOLEAN `True`, so a correct
workflow's trigger arrives under the key `True` and `document.get('on')`
returns `None` for every valid file in this repository. A rule 3 written the
obvious way would therefore have failed everything, been "fixed" by deleting
it, and left the hole open. Both spellings are accepted below: the boolean
PyYAML produces for `on:`, and the string a quoted `"on":` produces.

Its own control is `scripts/test-workflow-shape-gate.py`, which feeds it the
exact malformed file that caused the silence, the review's own no-trigger and
null-`run` probe, and a case for every rule above, and requires a red for each.
"""
from __future__ import annotations

import pathlib
import subprocess
import sys

import yaml

STEP_KEYS = {
    'name', 'id', 'if', 'run', 'uses', 'with', 'env', 'shell',
    'working-directory', 'continue-on-error', 'timeout-minutes',
}

WORKFLOW_DIRS = ('.github/workflows', '.gitea/workflows')

# The census of gate step names (rule 8). Its ABSENCE means "this tree is not
# under the two-tier contract", which is true of the throwaway repositories
# this gate's own control builds and of nothing else. Its presence in the real
# repository is asserted by that control, so deleting it to silence rule 8
# reddens the control instead.
GATE_CENSUS = 'scripts/ci-gate-steps.txt'

# The full tier. Rule 9 is stated about this file by name because it is the
# file the owner ruling made conditional-by-trigger; `ci.yml` is expected to
# carry `if:` (that is what the path focus IS).
FULL_TIER = 'ci-full.yml'

# The key a bare `on:` actually lands under. Named rather than written as a
# literal `True` at the lookup, because `document[True]` reads like a mistake.
TRUE_KEY = True


class NoDuplicateKeyLoader(yaml.SafeLoader):
    """`yaml.SafeLoader`, minus the part that hides a duplicate key."""


def _no_duplicates(loader: yaml.Loader, node: yaml.Node, deep: bool = False):
    mapping = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise yaml.constructor.ConstructorError(
                None, None,
                f'duplicate key {key!r} at line {key_node.start_mark.line + 1}',
                key_node.start_mark,
            )
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


NoDuplicateKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _no_duplicates)


def repository_root() -> pathlib.Path:
    return pathlib.Path(subprocess.run(
        ['git', 'rev-parse', '--show-toplevel'],
        capture_output=True, text=True, check=True).stdout.strip())


def _trigger_problems(path: pathlib.Path, trigger: object) -> list[str]:
    """Rule 3: `on:` must name EVENTS, not merely be truthy.

    Review round 3 rejected the first version of this rule for testing
    truthiness alone: `on: 1` is truthy, is not an event, and passed. A
    workflow whose trigger the runner cannot parse into events is scheduled by
    nothing, which is the very class this gate exists for — so the rule now
    asks about SHAPE, in the three spellings the workflow syntax admits:

      a string   `on: push`
      a sequence `on: [push, pull_request]`  — every member a non-empty string
      a mapping  `on: {push: {...}}`         — every key a non-empty string

    Anything else — a number, a boolean, a null, an empty container, a member
    that is not an event name — is refused. The event VOCABULARY is not
    checked: a typo like `pusg` is a different failure with a different owner,
    and this gate does not claim to hold the forge's event list.
    """
    where = f'{path}: `on:` trigger'
    if isinstance(trigger, str):
        return [] if trigger.strip() else [f'{where} is an empty string']
    if isinstance(trigger, (list, tuple)):
        if not trigger:
            return [f'{where} is an empty list — it names no event']
        bad = [item for item in trigger if not (isinstance(item, str) and item.strip())]
        return [f'{where} lists {bad!r}, which are not event names'] if bad else []
    if isinstance(trigger, dict):
        if not trigger:
            return [f'{where} is an empty mapping — it names no event']
        bad = [key for key in trigger if not (isinstance(key, str) and key.strip())]
        return [f'{where} is keyed by {bad!r}, which are not event names'] if bad else []
    return [
        f'{where} is {trigger!r}, which names no event — a workflow with no event '
        'to fire on is NEVER SCHEDULED AT ALL. It must be an event name, a list of '
        'them, or a mapping keyed by them.'
    ]


def check_file(path: pathlib.Path) -> list[str]:
    problems: list[str] = []
    try:
        document = yaml.load(path.read_text(encoding='utf-8'), Loader=NoDuplicateKeyLoader)
    except yaml.YAMLError as error:
        return [f'{path}: does not parse: {error}']

    if not isinstance(document, dict):
        return [f'{path}: is not a mapping']

    # Rule 3. `TRUE_KEY` first: see the module docstring — YAML 1.1 turns the
    # bare word `on` into a boolean, so this is the key a WELL-FORMED workflow
    # actually has. The string form is accepted too, for a quoted `"on":`.
    trigger = document[TRUE_KEY] if TRUE_KEY in document else document.get('on')
    problems.extend(_trigger_problems(path, trigger))

    jobs = document.get('jobs')
    if not isinstance(jobs, dict) or not jobs:
        problems.append(f'{path}: has no jobs')
        return problems

    for job_name, job in jobs.items():
        steps = (job or {}).get('steps')
        if not isinstance(steps, list) or not steps:
            problems.append(f'{path}: job {job_name!r} has no steps')
            continue
        for index, step in enumerate(steps):
            where = f'{path}: job {job_name!r} step {index}'
            if not isinstance(step, dict):
                problems.append(f'{where}: is not a mapping')
                continue
            named = step.get('name', '<unnamed>')
            actions = [key for key in ('run', 'uses') if key in step]
            if len(actions) != 1:
                problems.append(
                    f'{where} ({named!r}): carries {actions or "neither run nor uses"} — '
                    'a step must have EXACTLY ONE of `run` or `uses`')
            else:
                # PRESENCE IS NOT A BODY. `run:` followed by nothing parses to
                # None and counts as present, which is how the checker green-lit
                # a step that executes nothing (review `a4a748d5`). The value
                # has to be a non-empty string before the key means anything.
                value = step[actions[0]]
                if not isinstance(value, str) or not value.strip():
                    problems.append(
                        f'{where} ({named!r}): `{actions[0]}` is {value!r} — '
                        'it must be a NON-EMPTY STRING, not merely a present key')
            # `key=repr` because a stray non-string key (YAML turns a bare `on`
            # into a boolean) would make a bare `sorted` raise instead of report.
            unknown = sorted(set(step) - STEP_KEYS, key=repr)
            if unknown:
                problems.append(f'{where} ({named!r}): unknown step key(s) {unknown}')
    return problems


def _step_names(document: dict) -> list[str]:
    """Every `name:` a step in this document carries, in file order."""
    names: list[str] = []
    jobs = document.get('jobs')
    if not isinstance(jobs, dict):
        return names
    for job in jobs.values():
        for step in ((job or {}).get('steps') or []):
            if isinstance(step, dict) and isinstance(step.get('name'), str):
                names.append(step['name'])
    return names


def _conditions(document: dict) -> list[str]:
    """Every `if:` in this document, named by where it sits (rule 9)."""
    found: list[str] = []
    jobs = document.get('jobs')
    if not isinstance(jobs, dict):
        return found
    for job_name, job in jobs.items():
        job = job or {}
        if 'if' in job:
            found.append(f'job {job_name!r} carries `if: {job["if"]!r}`')
        for index, step in enumerate((job.get('steps') or [])):
            if isinstance(step, dict) and 'if' in step:
                named = step.get('name', f'<step {index}>')
                found.append(f'job {job_name!r} step {named!r} carries `if: {step["if"]!r}`')
    return found


def check_forge_parity(root: pathlib.Path) -> list[str]:
    """Rule 7. The two forges carry the same workflow files, byte for byte."""
    problems: list[str] = []
    seen = {
        directory: {path.name: path for path in (root / directory).glob('*.yml')}
        for directory in WORKFLOW_DIRS
    }
    github, gitea = seen[WORKFLOW_DIRS[0]], seen[WORKFLOW_DIRS[1]]
    for name in sorted(set(github) | set(gitea)):
        if name not in github or name not in gitea:
            present = WORKFLOW_DIRS[0] if name in github else WORKFLOW_DIRS[1]
            missing = WORKFLOW_DIRS[1] if name in github else WORKFLOW_DIRS[0]
            problems.append(
                f'{name}: present in {present} and MISSING from {missing} — a workflow '
                'that exists on one forge only runs gates that depend on where you pushed')
            continue
        if github[name].read_bytes() != gitea[name].read_bytes():
            problems.append(
                f'{name}: the {WORKFLOW_DIRS[0]} and {WORKFLOW_DIRS[1]} copies DIFFER')
    return problems


def check_gate_census(root: pathlib.Path, documents: dict) -> list[str]:
    """Rules 8 and 9, both keyed on the census file's presence.

    `documents` maps a workflow FILE NAME to its parsed document — one entry per
    basename, read from the `.gitea` copy, because rule 7 has already required
    the two forges to be identical and counting both would make every gate
    appear exactly twice.
    """
    census_path = root / GATE_CENSUS
    if not census_path.exists():
        return []

    problems: list[str] = []
    required = [
        line.strip()
        for line in census_path.read_text(encoding='utf-8').splitlines()
        if line.strip() and not line.lstrip().startswith('#')
    ]
    if not required:
        return [f'{GATE_CENSUS}: names no gate — an empty census asserts nothing']

    # Rule 9 first: the full tier must EXIST, and carry no condition.
    if FULL_TIER not in documents:
        problems.append(
            f'{FULL_TIER} is missing. The gate census exists, so this repository is '
            'under the two-tier contract and the full tier is where most of that '
            'census lives — without it every gate below is simply gone.')
    else:
        for where in _conditions(documents[FULL_TIER]):
            problems.append(
                f'{FULL_TIER}: {where}. Nothing in the full tier may be conditional: '
                'its TRIGGER decides whether it runs, and a gate that can be skipped '
                'is a gate that will be skipped on the promotion it was written for.')

    # Rule 8: exactly once across the tiers.
    counts: dict[str, list[str]] = {}
    for file_name, document in documents.items():
        for name in _step_names(document):
            counts.setdefault(name, []).append(file_name)

    for name in required:
        where = counts.get(name, [])
        if not where:
            problems.append(
                f'GATE LOST: {name!r} is in {GATE_CENSUS} and in NO workflow. '
                'Removing a gate is a decision; delete its census line in the same '
                'commit if that is what you mean.')
        elif len(where) > 1:
            problems.append(
                f'GATE DUPLICATED: {name!r} runs in {sorted(set(where))} — the census '
                'requires exactly one tier per gate.')
    return problems


def main() -> int:
    root = repository_root()
    files = sorted(
        path
        for directory in WORKFLOW_DIRS
        for path in (root / directory).glob('*.yml')
    )
    if not files:
        print('No workflow files found — this gate would pass by saying nothing.', file=sys.stderr)
        return 1

    problems: list[str] = []
    documents: dict = {}
    for path in files:
        problems.extend(check_file(path.relative_to(root) if path.is_relative_to(root) else path))
        # One parsed document per BASENAME, from whichever copy parses. Rule 7
        # holds them identical, so the choice cannot change an answer.
        if path.name not in documents:
            try:
                document = yaml.load(path.read_text(encoding='utf-8'), Loader=NoDuplicateKeyLoader)
            except yaml.YAMLError:
                document = None
            if isinstance(document, dict):
                documents[path.name] = document

    problems.extend(check_forge_parity(root))
    problems.extend(check_gate_census(root, documents))

    if problems:
        print('Workflow shape contract FAILED:', file=sys.stderr)
        for problem in problems:
            print(f'  {problem}', file=sys.stderr)
        print(
            '\nA workflow the runner cannot parse — or one it parses and will never schedule, '
            'or one whose step executes nothing — produces NO RUN AT ALL, which reads as '
            '"CI has not started yet" rather than as a failure. A gate that is in the census '
            'and in neither tier produces no run either, and looks exactly like success.',
            file=sys.stderr)
        return 1

    census = root / GATE_CENSUS
    gates = 0
    if census.exists():
        gates = len([
            line for line in census.read_text(encoding='utf-8').splitlines()
            if line.strip() and not line.lstrip().startswith('#')
        ])
    print(f'Workflow shape contract passed ({len(files)} workflow file(s), '
          f'{gates} censused gate step(s))')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
