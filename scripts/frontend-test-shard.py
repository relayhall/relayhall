#!/usr/bin/env python3
"""Split the Frontend unit tests across parallel CI jobs without changing what is tested.

    python3 scripts/frontend-test-shard.py run   --shard 2/3 [-- <extra vitest args>]
    python3 scripts/frontend-test-shard.py check
    python3 scripts/frontend-test-shard.py plan
    python3 scripts/frontend-test-shard.py weights --report <vitest-json-report> [--write]

WHY. The fast tier's critical path was one serial job, and inside it one serial
step: `npm run test:unit`, a single vitest worker over every unit-test file
(628 s on 22 Oct, 852 s on 24 Oct, growing). More CPU does not help one worker;
splitting does. This script cuts the file set into N shards, each run by its own
CI job with the SAME command shape `test:unit` uses (`NODE_ENV=test`, forks, one
worker), so a shard measures exactly what the serial step measured, on fewer files.

THE CONTRACT: the union of the shards IS the file set `npm run test:unit` runs,
each file once. The file set is vitest's own answer (`frontend-vitest-files.mjs`
asks the Node API, with the exclusions parsed out of the `test:unit` script in
`package.json`), never a list this script made up. The assignment is COMPUTED, not
stored, so a new test file is assigned the moment it exists and nobody has to
remember to register it; what is stored is only a duration estimate per file
(`scripts/frontend-test-shards.json`) used to balance the shards.

THREE PROOFS, none of which trusts the one before it:

  1. `check` partitions the real file list: no file missing from every shard
     (GAP), none in two shards (OVERLAP), none that is not a test file
     (FOREIGN), no empty shard.
  2. `check` then asks vitest what each shard's filters actually SELECT and
     requires it to equal the shard's assignment. vitest filters are substring
     matches, so a plan that partitions perfectly on paper can still run a
     neighbour (`a.test.ts` is a prefix of `a.test.tsx`); only the real
     selection shows it.
  3. `run` repeats proof 2 for its own shard before it starts, so a job that
     skips the `check` step still cannot run the wrong files.

The workflow side - that the CI matrix names exactly the shards this file
declares, and that no serial `test:unit` step is left behind - is held by rule 10
of `scripts/check-workflow-shape.py`.

BALANCE. Files are placed longest-first onto the currently lightest shard
(greedy LPT, ties broken by shard number and path, so the plan is deterministic).
A file the weights file has never seen gets the median weight, so a new test is
spread out sensibly instead of piling onto shard 1. `weights` regenerates the
estimates from a vitest JSON report of a SERIAL run:

    cd frontend && NODE_ENV=test npx vitest run --pool=forks --maxWorkers=1 \\
        --minWorkers=1 --exclude <the test:unit exclusion> \\
        --reporter=default --reporter=json --outputFile.json=/tmp/serial.json
    python3 ../scripts/frontend-test-shard.py weights --report /tmp/serial.json --write

Stale estimates only cost balance, never coverage, so they warn and never fail.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import statistics
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
FRONTEND = ROOT / 'frontend'
WEIGHTS_PATH = ROOT / 'scripts' / 'frontend-test-shards.json'
LISTER = ROOT / 'scripts' / 'frontend-vitest-files.mjs'
SCHEMA = 'frontend-test-shards/1'
TEST_FILE = re.compile(r'^src/.+\.test\.tsx?$')
# The command line `npm run test:unit` uses, minus the exclusions (which are read
# from package.json) and the files (which are the shard's). `vitest_command` puts
# the three back together.
VITEST_BASE = ['npx', 'vitest', 'run', '--pool=forks', '--maxWorkers=1', '--minWorkers=1']


class ShardError(Exception):
    """A refusal that must end the run non-zero; the message names the cause."""


# ---------------------------------------------------------------------------
# Pure functions: no filesystem, no vitest. The self-proof drives these.

def validate_weights_doc(doc: object) -> list[str]:
    """Shape problems in the weights document; empty when it is usable."""
    if not isinstance(doc, dict):
        return ['the weights document is not an object']
    problems: list[str] = []
    if doc.get('schema') != SCHEMA:
        problems.append(f'schema is {doc.get("schema")!r}, expected {SCHEMA!r}')
    shards = doc.get('shards')
    if isinstance(shards, bool) or not isinstance(shards, int) or shards < 2:
        problems.append(f'shards is {shards!r}; it must be an integer of at least 2')
    default = doc.get('defaultSeconds')
    if isinstance(default, bool) or not isinstance(default, (int, float)) or default <= 0:
        problems.append(f'defaultSeconds is {default!r}; it must be a positive number')
    weights = doc.get('weights')
    if not isinstance(weights, dict) or not weights:
        problems.append('weights is empty or not an object')
    else:
        for name, seconds in weights.items():
            if not TEST_FILE.match(str(name)):
                problems.append(f'weight key {name!r} is not a src/**/*.test.ts(x) path')
            if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or seconds < 0:
                problems.append(f'weight for {name!r} is {seconds!r}; it must be a number of seconds >= 0')
    return problems


def weight_of(name: str, doc: dict) -> float:
    weights = doc['weights']
    return float(weights[name]) if name in weights else float(doc['defaultSeconds'])


def assign(files: list[str], doc: dict, shards: int) -> list[list[str]]:
    """Greedy longest-first placement. Deterministic for a given (files, doc, shards)."""
    plan: list[list[str]] = [[] for _ in range(shards)]
    load = [0.0] * shards
    for name in sorted(files, key=lambda f: (-weight_of(f, doc), f)):
        lightest = min(range(shards), key=lambda i: (load[i], i))
        plan[lightest].append(name)
        load[lightest] += weight_of(name, doc)
    return [sorted(members) for members in plan]


def partition_problems(files: list[str], plan: list[list[str]], shards: int) -> list[str]:
    """Proof 1: does the plan cut `files` into `shards` pieces, each file exactly once."""
    problems: list[str] = []
    if len(plan) != shards:
        problems.append(f'SHARD COUNT: the plan has {len(plan)} shard(s), the contract says {shards}')
    seen: dict[str, list[int]] = {}
    for index, members in enumerate(plan, start=1):
        if not members:
            problems.append(f'EMPTY shard {index}: a job that runs nothing reports green')
        for name in members:
            seen.setdefault(name, []).append(index)
    wanted = set(files)
    for name in sorted(wanted - set(seen)):
        problems.append(f'GAP: {name} is in no shard, so it would never run')
    for name in sorted(set(seen) - wanted):
        problems.append(f'FOREIGN: {name} is in shard {seen[name]} but is not in the vitest file set')
    for name in sorted(seen):
        if len(seen[name]) > 1:
            problems.append(f'OVERLAP: {name} is in shards {seen[name]}')
    return problems


def selection_problems(plan: list[list[str]], select) -> list[str]:
    """Proof 2: what vitest SELECTS for each shard's filters must equal the assignment.

    `select(filters)` returns the files vitest would run for those filters. The real
    one calls `frontend-vitest-files.mjs`; the self-proof passes a stand-in that
    follows vitest's substring rule.
    """
    problems: list[str] = []
    for index, members in enumerate(plan, start=1):
        chosen = set(select(list(members)))
        wanted = set(members)
        for name in sorted(chosen - wanted):
            problems.append(
                f'SELECTION: the filters of shard {index} also select {name}, which belongs to '
                'another shard - a filter that is a substring of a longer path runs it twice')
        for name in sorted(wanted - chosen):
            problems.append(f'SELECTION: the filters of shard {index} do not select {name}')
    return problems


def vitest_command(excludes: list[str], extra_args: list[str], files: list[str]) -> list[str]:
    """The command a shard runs: the `test:unit` shape, its exclusions, then the shard's files.

    The exclusions are handed to vitest exactly as `test:unit` hands them, and they
    are the same globs proof 2 selects with. Without them the proof would measure a
    command other than the one that runs, and a shard file whose path contains an
    excluded path would be pulled in.
    """
    command = list(VITEST_BASE)
    for glob in excludes:
        command += ['--exclude', glob]
    return command + list(extra_args) + list(files)


def parse_shard_spec(spec: str, shards: int) -> int:
    match = re.fullmatch(r'([0-9]+)/([0-9]+)', spec or '')
    if not match:
        raise ShardError(f'--shard {spec!r} is not <index>/<count>, for example 2/{shards}')
    index, count = int(match.group(1)), int(match.group(2))
    if count != shards:
        raise ShardError(
            f'--shard {spec} names {count} shards but {WEIGHTS_PATH.name} declares {shards}: '
            'the workflow and the plan disagree, so some files would be run twice or not at all')
    if not 1 <= index <= count:
        raise ShardError(f'--shard {spec}: the index must be between 1 and {count}')
    return index


def unit_excludes(script: str) -> list[str]:
    """The `--exclude` globs of the `test:unit` script, in order."""
    found: list[str] = []
    for match in re.finditer(r"--exclude(?:=|\s+)(?:'([^']+)'|\"([^\"]+)\"|(\S+))", script):
        found.append(next(group for group in match.groups() if group))
    return found


def seconds_by_file(report: dict) -> dict[str, float]:
    """Per-file cost in seconds out of a vitest JSON report of a SERIAL run.

    A file's cost is the time between the previous file finishing and this one
    finishing: its tests PLUS the fork start, import and environment set-up that
    precede them. The tests alone are less than 60 percent of a file's real cost
    (the first measurement: 205 s of tests in a 347 s run), and a shard balanced on
    test time alone would be lopsided exactly where files are import-heavy. The
    costs sum to the wall time of the run.

    The run must have been serial (one worker): with two, files overlap and the
    differences mean nothing, so an overlap is refused rather than guessed at.
    """
    rows: list[tuple[float, float, str]] = []
    for result in report.get('testResults') or []:
        name = str(result.get('name') or '')
        marker = '/frontend/'
        relative = name.split(marker, 1)[1] if marker in name else name
        start, end = result.get('startTime'), result.get('endTime')
        if not (isinstance(start, (int, float)) and isinstance(end, (int, float)) and end >= start):
            raise ShardError(f'{relative}: the report has no usable start and end time')
        rows.append((float(end), float(start), relative))
    rows.sort()
    origin = report.get('startTime')
    previous = float(origin) if isinstance(origin, (int, float)) else None
    out: dict[str, float] = {}
    for end, start, relative in rows:
        if previous is None:
            previous = start
        if start < previous - 50:
            raise ShardError(f'{relative} started {previous - start:.0f} ms before the previous file ended: '
                             'the report is not from a serial run (--maxWorkers=1), so per-file costs are meaningless')
        out[relative] = out.get(relative, 0.0) + max(end - previous, 0.0) / 1000.0
        previous = end
    return out


# ---------------------------------------------------------------------------
# Effects: the filesystem and vitest.

def load_doc() -> dict:
    try:
        doc = json.loads(WEIGHTS_PATH.read_text(encoding='utf-8'))
    except (OSError, ValueError) as error:
        raise ShardError(f'{WEIGHTS_PATH}: cannot be read as JSON: {error}')
    problems = validate_weights_doc(doc)
    if problems:
        raise ShardError(f'{WEIGHTS_PATH.name} is unusable: ' + '; '.join(problems))
    return doc


def package_excludes() -> list[str]:
    package = json.loads((FRONTEND / 'package.json').read_text(encoding='utf-8'))
    script = (package.get('scripts') or {}).get('test:unit')
    if not isinstance(script, str):
        raise ShardError('frontend/package.json has no `test:unit` script to take the file set from')
    return unit_excludes(script)


LISTER_MARKER = 'RELAYHALL_VITEST_FILES '


def vitest_select(filters: list[str], excludes: list[str]) -> list[str]:
    command = ['node', str(LISTER)]
    for glob in excludes:
        command += ['--exclude', glob]
    if filters:
        command += ['--'] + filters
    result = subprocess.run(command, cwd=FRONTEND, capture_output=True, text=True)
    if result.returncode != 0:
        raise ShardError(f'asking vitest for its file list failed (exit {result.returncode}):\n{result.stderr.strip()}')
    marked = [line[len(LISTER_MARKER):] for line in result.stdout.splitlines() if line.startswith(LISTER_MARKER)]
    try:
        if len(marked) != 1:
            raise ValueError(f'{len(marked)} marked lines')
        files = json.loads(marked[0])
    except ValueError as error:
        raise ShardError(f'the file lister printed no single marked JSON array ({error}); end of its output:\n'
                         f'{result.stdout.strip()[-600:]}\nstderr:\n{result.stderr.strip()[-400:]}')
    return files


def full_file_set(excludes: list[str]) -> list[str]:
    files = vitest_select([], excludes)
    if not files:
        raise ShardError('vitest reports no unit-test files; refusing to call an empty set covered')
    return files


def describe(plan: list[list[str]], doc: dict) -> list[str]:
    lines = []
    for index, members in enumerate(plan, start=1):
        seconds = sum(weight_of(name, doc) for name in members)
        lines.append(f'  shard {index}/{len(plan)}: {len(members):3d} files, ~{seconds:6.1f} s estimated')
    return lines


def warn_on_weights(files: list[str], doc: dict) -> None:
    known = set(doc['weights'])
    unweighted = sorted(set(files) - known)
    stale = sorted(known - set(files))
    if unweighted:
        print(f'note: {len(unweighted)} file(s) have no estimate and use the median '
              f'({doc["defaultSeconds"]} s); regenerate with the `weights` command', file=sys.stderr)
    if stale:
        print(f'note: {len(stale)} estimate(s) name files that no longer exist', file=sys.stderr)


def cmd_plan(_: argparse.Namespace) -> int:
    doc = load_doc()
    excludes = package_excludes()
    files = full_file_set(excludes)
    plan = assign(files, doc, doc['shards'])
    print(f'{len(files)} unit-test file(s), exclusions {excludes}')
    print('\n'.join(describe(plan, doc)))
    warn_on_weights(files, doc)
    return 0


def cmd_check(_: argparse.Namespace) -> int:
    doc = load_doc()
    excludes = package_excludes()
    files = full_file_set(excludes)
    plan = assign(files, doc, doc['shards'])
    problems = partition_problems(files, plan, doc['shards'])
    if not problems:
        problems += selection_problems(plan, lambda filters: vitest_select(filters, excludes))
    print(f'{len(files)} unit-test file(s) in {doc["shards"]} shard(s)')
    print('\n'.join(describe(plan, doc)))
    warn_on_weights(files, doc)
    if problems:
        print('Frontend shard coverage FAILED:', file=sys.stderr)
        for problem in problems:
            print(f'  {problem}', file=sys.stderr)
        return 1
    print('every unit-test file is in exactly one shard, and each shard selects exactly its own files')
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    doc = load_doc()
    index = parse_shard_spec(args.shard, doc['shards'])
    excludes = package_excludes()
    files = full_file_set(excludes)
    plan = assign(files, doc, doc['shards'])
    mine = plan[index - 1]
    if not mine:
        raise ShardError(f'shard {index} is empty; refusing to report green for running nothing')
    chosen = set(vitest_select(mine, excludes))
    if chosen != set(mine):
        extra, missing = sorted(chosen - set(mine)), sorted(set(mine) - chosen)
        raise ShardError(f'shard {index}: the filters select the wrong files (extra {extra}, missing {missing})')
    print(f'shard {index}/{doc["shards"]}: {len(mine)} of {len(files)} files, '
          f'~{sum(weight_of(n, doc) for n in mine):.0f} s estimated', flush=True)
    extra_args = [a for a in (args.vitest_args or []) if a != '--']
    environment = dict(os.environ, NODE_ENV='test')
    return subprocess.run(vitest_command(excludes, extra_args, mine), cwd=FRONTEND, env=environment).returncode


def cmd_weights(args: argparse.Namespace) -> int:
    try:
        report = json.loads(pathlib.Path(args.report).read_text(encoding='utf-8'))
    except (OSError, ValueError) as error:
        raise ShardError(f'{args.report}: cannot be read as a vitest JSON report: {error}')
    excludes = package_excludes()
    files = set(full_file_set(excludes))
    measured = seconds_by_file(report)
    unknown = sorted(set(measured) - files)
    if unknown:
        raise ShardError('the report names files outside the unit-test file set (a report of '
                         f'another command?): {unknown[:5]}')
    absent = sorted(files - set(measured))
    if absent:
        raise ShardError(f'the report has no result for {len(absent)} unit-test file(s), e.g. {absent[:3]}; '
                         'it must come from a complete serial run')
    shards = args.shards
    if shards is None:
        try:
            shards = load_doc()['shards']
        except ShardError:
            shards = 3
    weights = {name: round(measured[name], 2) for name in sorted(measured)}
    doc = {
        'schema': SCHEMA,
        'shards': shards,
        'defaultSeconds': round(statistics.median(weights.values()), 2) or 0.01,
        'generated': {
            'source': 'vitest json report of a serial run',
            'files': len(weights),
            'serialSeconds': round(sum(weights.values()), 1),
        },
        'weights': weights,
    }
    problems = validate_weights_doc(doc)
    if problems:
        raise ShardError('the regenerated weights are unusable: ' + '; '.join(problems))
    plan = assign(sorted(files), doc, shards)
    print(f'{len(weights)} file(s), {doc["generated"]["serialSeconds"]} s serial, {shards} shard(s)')
    print('\n'.join(describe(plan, doc)))
    if args.write:
        WEIGHTS_PATH.write_text(json.dumps(doc, indent=2) + '\n', encoding='utf-8', newline='\n')
        print(f'wrote {WEIGHTS_PATH.relative_to(ROOT)}')
    else:
        print('dry run; pass --write to replace the weights file')
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split('\n', 1)[0])
    sub = parser.add_subparsers(dest='command', required=True)
    run = sub.add_parser('run', help='run one shard through vitest')
    run.add_argument('--shard', required=True, help='<index>/<count>, for example 2/3')
    run.add_argument('vitest_args', nargs=argparse.REMAINDER, help='extra vitest arguments after --')
    sub.add_parser('check', help='prove the shards cover the file set exactly once')
    sub.add_parser('plan', help='print the assignment summary')
    weights = sub.add_parser('weights', help='regenerate the estimates from a vitest JSON report')
    weights.add_argument('--report', required=True)
    weights.add_argument('--shards', type=int, default=None)
    weights.add_argument('--write', action='store_true')
    args = parser.parse_args(argv)
    handler = {'run': cmd_run, 'check': cmd_check, 'plan': cmd_plan, 'weights': cmd_weights}[args.command]
    try:
        return handler(args)
    except ShardError as error:
        print(f'frontend-test-shard: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
