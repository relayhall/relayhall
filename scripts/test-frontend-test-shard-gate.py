#!/usr/bin/env python3
"""The control for `frontend-test-shard.py`: every way a shard plan can lose a test, made red.

The splitter's whole promise is that cutting the Frontend unit tests into parallel
jobs changes nothing about WHAT is tested. A promise like that is worth exactly the
mutations that were shown to break it, so this feeds the proofs one defective plan
per failure class and requires a red for each, then requires a correct plan to pass
(non-vacuity: a checker that refuses everything satisfies every red assertion).

It needs no node and no installed packages - the cuts are pure functions - so it
runs in the always-on contract job. The part that needs vitest (the real file list
and the real filter selection) runs in the Frontend job as the `check` command.

EVERY MUTANT IS RED ALONE. Each defective plan is built from a known-good one by a
single edit and is required to produce exactly the problem class that edit causes,
not merely "some problem": a mutant that tripped two classes would hide which proof
caught it.
"""
from __future__ import annotations

import importlib.util
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(subprocess.run(
    ['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True, check=True,
    cwd=pathlib.Path(__file__).resolve().parent).stdout.strip())
SHARD_SCRIPT = ROOT / 'scripts' / 'frontend-test-shard.py'

spec = importlib.util.spec_from_file_location('frontend_test_shard', SHARD_SCRIPT)
shard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shard)

failures = 0


def expect(label: str, condition: bool, detail: str = '') -> None:
    global failures
    if condition:
        print(f'ok {label}')
    else:
        failures += 1
        print(f'FAIL {label} {detail}'.rstrip(), file=sys.stderr)


def classes(problems: list[str]) -> set[str]:
    return {problem.split(':', 1)[0].split(' ', 1)[0] for problem in problems}


# A file set shaped like the real one: a long tail of short tests, a few heavy ones,
# and the `a.test.ts` / `a.test.tsx` pair that makes a substring filter ambiguous.
FILES = (
    [f'src/pages/Page{i:02d}.test.tsx' for i in range(20)]
    + [f'src/lib/helper{i:02d}.test.ts' for i in range(15)]
    + ['src/a11y.smoke.test.tsx', 'src/components/map/mapHooks.test.tsx',
       'src/ambiguous.test.ts', 'src/ambiguous.test.tsx']
)
WEIGHTS = {name: 1.0 + (index % 7) for index, name in enumerate(FILES)}
WEIGHTS['src/a11y.smoke.test.tsx'] = 40.0
WEIGHTS['src/components/map/mapHooks.test.tsx'] = 25.0
DOC = {'schema': shard.SCHEMA, 'shards': 3, 'defaultSeconds': 2.0, 'weights': WEIGHTS}

# ---- the document that describes the plan
expect('a correct weights document validates', shard.validate_weights_doc(DOC) == [])
for label, mutate in (
    ('wrong schema', lambda d: d.update(schema='other/1')),
    ('one shard is not a split', lambda d: d.update(shards=1)),
    ('shard count not an integer', lambda d: d.update(shards='3')),
    ('non-positive default', lambda d: d.update(defaultSeconds=0)),
    ('empty weights', lambda d: d.update(weights={})),
    ('negative weight', lambda d: d['weights'].update({FILES[0]: -1})),
    ('weight for something that is not a test file', lambda d: d['weights'].update({'package.json': 1})),
):
    broken = json.loads(json.dumps(DOC))
    mutate(broken)
    expect(f'weights document refused: {label}', shard.validate_weights_doc(broken) != [])
expect('a non-object weights document is refused', shard.validate_weights_doc([]) != [])

# ---- the assignment itself
for count in (2, 3, 4, 5):
    plan = shard.assign(FILES, DOC, count)
    expect(f'assignment partitions the set exactly ({count} shards)',
           shard.partition_problems(FILES, plan, count) == [],
           repr(shard.partition_problems(FILES, plan, count)))
    loads = [sum(shard.weight_of(n, DOC) for n in members) for members in plan]
    heaviest_file = max(shard.weight_of(n, DOC) for n in FILES)
    expect(f'assignment is balanced to within one file ({count} shards)',
           max(loads) - min(loads) <= heaviest_file, f'loads={loads}')
expect('assignment is deterministic', shard.assign(FILES, DOC, 3) == shard.assign(list(reversed(FILES)), DOC, 3))

unweighted = FILES + ['src/brand/NewThing.test.tsx']
plan_new = shard.assign(unweighted, DOC, 3)
expect('a file the weights file has never seen is still assigned exactly once',
       shard.partition_problems(unweighted, plan_new, 3) == [])

# ---- mutants of the plan, each red alone, each in its own class
good = shard.assign(FILES, DOC, 3)
expect('the unmutated plan is clean (non-vacuity for every mutant below)',
       shard.partition_problems(FILES, good, 3) == [])


def without(plan, name):
    return [[n for n in members if n != name] for members in plan]


victim = good[1][0]
expect('mutant GAP: a file dropped from every shard',
       classes(shard.partition_problems(FILES, without(good, victim), 3)) == {'GAP'},
       repr(shard.partition_problems(FILES, without(good, victim), 3)))

overlap = [list(members) for members in good]
overlap[2].append(good[0][0])
expect('mutant OVERLAP: a file in two shards',
       classes(shard.partition_problems(FILES, overlap, 3)) == {'OVERLAP'},
       repr(shard.partition_problems(FILES, overlap, 3)))

foreign = [list(members) for members in good]
foreign[0].append('src/not-a-test-in-the-set.test.ts')
expect('mutant FOREIGN: a path that is not in the vitest file set',
       classes(shard.partition_problems(FILES, foreign, 3)) == {'FOREIGN'},
       repr(shard.partition_problems(FILES, foreign, 3)))

emptied = [list(members) for members in good]
emptied[0] = []
moved = good[0]
emptied[1] = sorted(emptied[1] + moved)
expect('mutant EMPTY: a shard with nothing to run (coverage intact, so only this proof can say so)',
       classes(shard.partition_problems(FILES, emptied, 3)) == {'EMPTY'},
       repr(shard.partition_problems(FILES, emptied, 3)))

expect('mutant SHARD COUNT: the plan has fewer shards than the contract',
       classes(shard.partition_problems(FILES, [good[0] + good[1], good[2]], 3)) == {'SHARD'})


# A defective ASSIGNER, not just a defective plan: the real flow is assign -> check.
def assign_dropping_last(files, doc, count):
    plan = shard.assign(files, doc, count)
    plan[-1] = plan[-1][:-1]
    return plan


expect('mutant ASSIGNER that drops the last file of the last shard is caught by the same proof',
       classes(shard.partition_problems(FILES, assign_dropping_last(FILES, DOC, 3), 3)) == {'GAP'})


def assign_round_robin_with_spill(files, doc, count):
    plan = shard.assign(files, doc, count)
    plan[0].append(plan[1][0])
    return plan


expect('mutant ASSIGNER that places one file twice is caught',
       classes(shard.partition_problems(FILES, assign_round_robin_with_spill(FILES, DOC, 3), 3)) == {'OVERLAP'})


# ---- the real vitest selection is a SUBSTRING match; stand in for it faithfully
def substring_select(filters):
    return [name for name in FILES if any(f in name for f in filters)]


# Force the pair onto different shards so the prefix shows up as a double selection.
forced = [[n for n in members if not n.startswith('src/ambiguous.test.')] for members in good]
forced[0].append('src/ambiguous.test.ts')
forced[1].append('src/ambiguous.test.tsx')
expect('the forced plan still partitions on paper', shard.partition_problems(FILES, forced, 3) == [])
selection = shard.selection_problems(forced, substring_select)
expect('mutant SELECTION: a path that is a prefix of another is caught only by the real selection',
       classes(selection) == {'SELECTION'} and any('ambiguous.test.tsx' in line for line in selection),
       repr(selection))
expect('a plan whose filters select exactly the assignment passes the selection proof',
       shard.selection_problems(good, lambda filters: list(filters)) == [])
expect('mutant SELECTION: a shard whose filters select nothing it was given is caught',
       any('do not select' in line for line in shard.selection_problems(good, lambda filters: filters[1:])))

# ---- the --shard argument
expect('--shard 2/3 parses', shard.parse_shard_spec('2/3', 3) == 2)
for bad in ('0/3', '4/3', '2/4', '2', 'a/b', '', '2/3/1'):
    try:
        shard.parse_shard_spec(bad, 3)
    except shard.ShardError:
        expect(f'--shard {bad!r} is refused', True)
    else:
        expect(f'--shard {bad!r} is refused', False)

# ---- the exclusion is read from the real script, not remembered
script = json.loads((ROOT / 'frontend' / 'package.json').read_text(encoding='utf-8'))['scripts']['test:unit']
read = shard.unit_excludes(script)
expect('the real test:unit exclusion is read from package.json',
       read == ['src/components/tasks/taskDueDateTimezone.test.tsx'], repr(read))
expect('exclusions are parsed from quoted, double-quoted and bare forms',
       shard.unit_excludes("vitest run --exclude 'a b/c.ts' --exclude \"d.ts\" --exclude=e.ts --exclude f.ts")
       == ['a b/c.ts', 'd.ts', 'e.ts', 'f.ts'])

# ---- the command a shard runs is the command the proofs measured
# `run` proves its selection (proof 3) with the package's exclusions, so it must hand
# vitest those same exclusions, or the proof would describe a different command.
# Drive `cmd_run` itself with the effects replaced: what vitest would be asked to
# select, and what the subprocess would be asked to run.
import argparse


def drive_run(command_builder=None):
    """Run `cmd_run` for shard 1/3 over `FILES`; return (selection excludes, executed command)."""
    seen = {'select': [], 'command': None}

    class Done:
        returncode = 0

    def fake_select(filters, excludes):
        seen['select'].append(list(excludes))
        return [name for name in FILES if any(f in name for f in filters)]

    def fake_subprocess(command, **_):
        seen['command'] = list(command)
        return Done()

    saved = (shard.load_doc, shard.package_excludes, shard.full_file_set, shard.vitest_select,
             shard.subprocess.run, shard.vitest_command)
    shard.load_doc = lambda: DOC
    shard.package_excludes = lambda: ['src/excluded/tz.test.tsx', 'src/excluded/other.test.tsx']
    shard.full_file_set = lambda excludes: list(FILES)
    shard.vitest_select = fake_select
    shard.subprocess.run = fake_subprocess
    if command_builder is not None:
        shard.vitest_command = command_builder
    try:
        code = shard.cmd_run(argparse.Namespace(shard='1/3', vitest_args=['--', '--reporter=dot']))
    finally:
        (shard.load_doc, shard.package_excludes, shard.full_file_set, shard.vitest_select,
         shard.subprocess.run, shard.vitest_command) = saved
    return code, seen


def exclusions_of(command):
    return [command[i + 1] for i, word in enumerate(command[:-1]) if word == '--exclude']


code, seen = drive_run()
mine = shard.assign(FILES, DOC, 3)[0]
expected_excludes = ['src/excluded/tz.test.tsx', 'src/excluded/other.test.tsx']
expect('run exits with the vitest exit code', code == 0)
expect('run hands vitest every package exclusion, in order',
       exclusions_of(seen['command']) == expected_excludes, repr(seen['command']))
expect('run hands vitest exactly the exclusions its own selection proof used',
       seen['select'] == [expected_excludes] and exclusions_of(seen['command']) == seen['select'][0],
       repr(seen['select']))
expect('the command is the test:unit shape, then the exclusions, then the extra arguments, then the shard files',
       seen['command'] == shard.VITEST_BASE + ['--exclude', expected_excludes[0], '--exclude', expected_excludes[1]]
       + ['--reporter=dot'] + mine, repr(seen['command']))
expect('the command carries the same pool and worker flags as the test:unit script',
       all(flag in script for flag in shard.VITEST_BASE[3:]), repr(shard.VITEST_BASE))
# Mutant: the pre-fix command (no exclusions) must be red by the same assertion.
old_builder = lambda excludes, extra, files: shard.VITEST_BASE + list(extra) + list(files)
_, mutant = drive_run(old_builder)
expect('mutant COMMAND: a run that drops the exclusions is caught by the same assertions',
       exclusions_of(mutant['command']) != mutant['select'][0], repr(mutant['command']))

# ---- the JSON report reader
report = {'startTime': 0, 'testResults': [
    {'name': '/work/frontend/src/b.test.ts', 'startTime': 3600, 'endTime': 4500},
    {'name': '/work/frontend/src/a.test.ts', 'startTime': 1000, 'endTime': 3500},
]}
timed = shard.seconds_by_file(report)
expect('per-file cost is the time since the previous file ended, so set-up time is counted',
       timed == {'src/a.test.ts': 3.5, 'src/b.test.ts': 1.0}, repr(timed))
expect('the per-file costs add up to the wall time of the serial run',
       abs(sum(timed.values()) - 4.5) < 1e-9)
overlapping = {'startTime': 0, 'testResults': [
    {'name': '/work/frontend/src/a.test.ts', 'startTime': 100, 'endTime': 4000},
    {'name': '/work/frontend/src/b.test.ts', 'startTime': 200, 'endTime': 5000},
]}
try:
    shard.seconds_by_file(overlapping)
except shard.ShardError:
    expect('a report from a parallel run is refused, not guessed at', True)
else:
    expect('a report from a parallel run is refused, not guessed at', False)
try:
    shard.seconds_by_file({'testResults': [{'name': '/w/frontend/src/a.test.ts'}]})
except shard.ShardError:
    expect('a report entry with no times is refused', True)
else:
    expect('a report entry with no times is refused', False)

# ---- the committed weights file
doc = json.loads((ROOT / 'scripts' / 'frontend-test-shards.json').read_text(encoding='utf-8'))
expect('the committed weights file is usable', shard.validate_weights_doc(doc) == [],
       repr(shard.validate_weights_doc(doc)))
on_disk = sorted(
    str(p.relative_to(ROOT / 'frontend')).replace('\\', '/')
    for p in (ROOT / 'frontend' / 'src').rglob('*')
    if p.is_file() and p.name.endswith(('.test.ts', '.test.tsx')))
real_files = [n for n in on_disk if n not in shard.unit_excludes(script)]
real_plan = shard.assign(real_files, doc, doc['shards'])
expect('the committed weights cut the files on disk into a clean partition',
       shard.partition_problems(real_files, real_plan, doc['shards']) == [])
# Balance is reported, never asserted: a test added since the estimates were taken
# only costs balance, and a threshold here would turn that into a red on an
# unrelated change. `weights --report ... --write` is the repair.
real_loads = [round(sum(shard.weight_of(n, doc) for n in members), 1) for members in real_plan]
print(f'info estimated shard loads for the files on disk: {real_loads}')

print(f'failures={failures}')
raise SystemExit(1 if failures else 0)
