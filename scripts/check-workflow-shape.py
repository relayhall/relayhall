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

 10. THE FRONTEND UNIT TESTS ARE SHARDED WITHOUT LOSING A SHARD. When
     `scripts/frontend-test-shards.json` exists, `ci.yml` must carry the job
     `frontend-unit` whose matrix is EXACTLY the shards that file declares
     (`shard: [1, ..., N]`, no `include` or `exclude` that could add or drop one,
     `fail-fast: false` so every shard reports), whose `if:` and `needs:` equal
     the `frontend` job's (a shard that runs while the job it belongs to is
     skipped, or the reverse, is a test that silently stops running), whose one
     test step runs `frontend-test-shard.py run --shard ${{ matrix.shard }}/N`,
     and the `frontend` job must run `frontend-test-shard.py check` once and no
     longer carry a serial `npm run test:unit` step. Rule 10 is the workflow half
     of the sharding contract; that the shards cover the file set exactly once is
     held by `scripts/frontend-test-shard.py check` and its control
     `scripts/test-frontend-test-shard-gate.py`. Keyed on the plan file's
     presence, like rules 8 and 9, and the control requires the real repository
     to carry it.

Rules 7-9 arrived with card 5de6ed89 (RH-CI.SPEED), which split one hour-long
workflow into two. Rule 10 arrived with E473, which split the Frontend job's
serial unit-test step because it had become the critical path of the fast tier. Rules 8 and 9 are the ones that make the split reversible
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

import json
import pathlib
import re
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

# Rule 10. The plan file whose presence puts the Frontend shards under the
# contract, and the two jobs of `ci.yml` the rule is about.
SHARD_PLAN = 'scripts/frontend-test-shards.json'
SHARDED_JOB = 'frontend'
SHARD_JOB = 'frontend-unit'
SHARD_COMMAND = 'python3 ../scripts/frontend-test-shard.py'
FAST_TIER = 'ci.yml'

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


def _runs(job: dict) -> list[str]:
    """Every `run:` string of a job's steps, in order."""
    return [step['run'] for step in (job.get('steps') or [])
            if isinstance(step, dict) and isinstance(step.get('run'), str)]


def check_frontend_shards(root: pathlib.Path, documents: dict) -> list[str]:
    """Rule 10: the Frontend unit-test shards in `ci.yml` are the shards the plan declares."""
    plan_path = root / SHARD_PLAN
    if not plan_path.exists():
        return []

    where = f'{FAST_TIER} (rule 10)'
    try:
        shards = json.loads(plan_path.read_text(encoding='utf-8')).get('shards')
    except (ValueError, AttributeError) as error:
        return [f'{SHARD_PLAN}: is not a JSON object ({error})']
    if isinstance(shards, bool) or not isinstance(shards, int) or shards < 2:
        return [f'{SHARD_PLAN}: `shards` is {shards!r}; it must be an integer of at least 2']

    document = documents.get(FAST_TIER)
    jobs = (document or {}).get('jobs')
    if not isinstance(jobs, dict):
        return [f'{where}: {FAST_TIER} has no jobs, but {SHARD_PLAN} puts the Frontend unit tests in shards']
    sharded, unit = jobs.get(SHARDED_JOB), jobs.get(SHARD_JOB)
    problems: list[str] = []
    if not isinstance(sharded, dict):
        problems.append(f'{where}: job {SHARDED_JOB!r} is missing')
    if not isinstance(unit, dict):
        problems.append(f'{where}: job {SHARD_JOB!r} is missing - the Frontend unit tests run nowhere')
    if problems:
        return problems

    strategy = unit.get('strategy') or {}
    matrix = strategy.get('matrix') if isinstance(strategy, dict) else None
    expected = list(range(1, shards + 1))
    if not isinstance(matrix, dict) or matrix.get('shard') != expected:
        problems.append(
            f'{where}: job {SHARD_JOB!r} matrix `shard` is '
            f'{matrix.get("shard") if isinstance(matrix, dict) else matrix!r}, but {SHARD_PLAN} declares '
            f'{shards} shards, so the matrix must be exactly {expected} - a missing shard is a slice of the '
            'tests that never runs')
    if isinstance(matrix, dict) and set(matrix) != {'shard'}:
        problems.append(
            f'{where}: job {SHARD_JOB!r} matrix carries {sorted(set(matrix) - {"shard"})}; `include` and '
            '`exclude` can add or drop a shard behind the declared list, so the matrix is `shard` and nothing else')
    if not isinstance(strategy, dict) or strategy.get('fail-fast') is not False:
        problems.append(
            f'{where}: job {SHARD_JOB!r} must set `fail-fast: false` so one red shard does not hide '
            'whether the others are green')
    for key in ('if', 'needs'):
        if unit.get(key) != sharded.get(key):
            problems.append(
                f'{where}: job {SHARD_JOB!r} `{key}` is {unit.get(key)!r} but job {SHARDED_JOB!r} has '
                f'{sharded.get(key)!r}; the shards and the job they belong to must be skipped together')
    wanted_name = f'Frontend unit tests (shard ${{{{ matrix.shard }}}} of {shards})'
    if unit.get('name') != wanted_name:
        problems.append(f'{where}: job {SHARD_JOB!r} is named {unit.get("name")!r}, expected {wanted_name!r}')

    # `continue-on-error` turns a red shard green: the step (or job) fails, the
    # forge still reports the run as a success, and a slice of the tests has
    # stopped gating anything. Any value is refused, `false` included: the key
    # has no honest use here, and a value that is an expression cannot be read.
    if 'continue-on-error' in unit:
        problems.append(
            f'{where}: job {SHARD_JOB!r} sets `continue-on-error`; a red shard would still leave the run '
            'green, so the tests of that shard would no longer gate anything')
    for index, step in enumerate(unit.get('steps') or []):
        if isinstance(step, dict) and 'continue-on-error' in step:
            named = step.get('name', f'<step {index}>')
            problems.append(
                f'{where}: job {SHARD_JOB!r} step {named!r} sets `continue-on-error`; a red shard would '
                'still leave the run green, so the tests of that shard would no longer gate anything')

    wanted_run = f'{SHARD_COMMAND} run --shard ${{{{ matrix.shard }}}}/{shards}'
    shard_steps = [run for run in _runs(unit) if 'frontend-test-shard.py' in run]
    if shard_steps != [wanted_run]:
        problems.append(
            f'{where}: job {SHARD_JOB!r} must have exactly one shard step `{wanted_run}`, found {shard_steps}')

    for job_name, job in jobs.items():
        for run in _runs(job or {}):
            if re.search(r'npm run test:unit(\s|$)', run):
                problems.append(
                    f'{where}: job {job_name!r} still runs `npm run test:unit` serially; the shards '
                    'would run every test a second time and the serial step stays the critical path')
    checks = [run for run in _runs(sharded) if 'frontend-test-shard.py' in run]
    if checks != [f'{SHARD_COMMAND} check']:
        problems.append(
            f'{where}: job {SHARDED_JOB!r} must run `{SHARD_COMMAND} check` exactly once '
            f'(the coverage proof), found {checks}')
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
    problems.extend(check_frontend_shards(root, documents))

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
