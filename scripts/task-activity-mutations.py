#!/usr/bin/env python3
"""Mutation drill for truthful task activity (card b595b3b0).

Task activity is decided in three places:

  backend/src/routes/tasks.ts          GET /tasks/activity narrows the ids to the
                                       Tasks the caller may read, then reads them
  backend/src/services/TelemetryService.ts
                                       activityForTasks: one query over frames
                                       written by the CURRENT claimant under the
                                       CURRENT assignment epoch; no frame = unknown
  frontend/src/hooks/useTaskActivity.ts, frontend/src/components/tasks/TaskCard.tsx,
  frontend/src/pages/TasksPage.tsx     one bounded refresh per surface, paused in a
                                       hidden tab, obsolete reads discarded, rows kept
                                       across a board update; the board reads and the
                                       card shows activity only for In Progress, and
                                       only what the read said

Each control below edits literal anchors of ONE of those places in a disposable
copy of the tree and runs the suites that guard it:

  backend   backend/src/__tests__/taskActivityLive.test.ts  (REST door, real PostgreSQL)
  frontend  frontend/src/hooks/useTaskActivity.test.tsx
            frontend/src/components/tasks/TaskActivityBadge.test.tsx
            frontend/src/pages/TasksPage.activity.test.tsx

The controls are the regressions the card forbids: another Task's activity
returned to a reader who may not read it; an absent observation presented as
activity; a reassignment away and back reviving an earlier observation; the
card inferring liveness from the lifecycle status; a hidden tab still polling;
an older read overwriting a newer one. The follow-ups of card 30d198df add five:
a board update emptying every badge; the board reading cards outside In
Progress; a card outside In Progress showing a badge; clock skew refusing the
whole batch; a row kept across a set change losing its own deadline.

Each run gets one of three verdicts:
  RED           every test ran, exactly the declared tests failed, each at an
                assertion.
  MISS          every test ran to an assertion, and the failed set is not the
                declared set (none failed, or others did).
  INCONCLUSIVE  the suites did not reach the declared assertions (a timeout, a
                compile error, a suite that did not load, an unreachable
                database, a test that failed by a thrown error). No verdict on
                the control; the drill still fails (exit status 3).
Tests are declared by their full names. Every control declares a different
set, so no two can be satisfied by one assertion. The source tree is never
edited: its bytes are fingerprinted before and after.

backend/ and frontend/ dependencies must be installed (`npm ci` in each); the
copy links both node_modules.

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/relayhall_task_activity_test \\
    python3 scripts/task-activity-mutations.py --output-dir /tmp/task-activity-drill
  python3 scripts/task-activity-mutations.py --describe   # checks every anchor, no database
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parents[1]
BACKEND_SUITES = ['src/__tests__/taskActivityLive.test.ts']
FRONTEND_SUITES = [
    'src/hooks/useTaskActivity.test.tsx',
    'src/components/tasks/TaskActivityBadge.test.tsx',
    'src/pages/TasksPage.activity.test.tsx',
]
ROUTE = 'backend/src/routes/tasks.ts'
SERVICE = 'backend/src/services/TelemetryService.ts'
HOOK = 'frontend/src/hooks/useTaskActivity.ts'
CARD = 'frontend/src/components/tasks/TaskCard.tsx'
PAGE = 'frontend/src/pages/TasksPage.tsx'

# The declared tests, by their full names.
ATTRIBUTION = 'task activity attribution uses current server-owned assignment '
AUTHORITY = 'bounded task activity read follows current task authority '
ISOLATION = 'task activity isolation between readers and Tasks '
REASSIGNED = ATTRIBUTION + 'a reassignment away and back never revives the earlier observation on the read surface'
ASSIGNEE_ONLY = ATTRIBUTION + "only the current Assignee's frames under the current assignment count; the caller cannot choose the stamp"
SERVICE_ARM = ATTRIBUTION + "without an assigned Service the Assignee counts; with one, only that Service's principal does"
COLLECTION = AUTHORITY + 'collection filters private ids, revocation clears, uppercase/duplicates normalize and hostile batches refuse'
COARSE = AUTHORITY + 'authorized batch returns only current coarse evidence and derived server-clock staleness'
OTHER_TASK = ISOLATION + "a reader of one Task never sees another Task's activity, even in the same batch"
ACCESS_LOST = ISOLATION + 'access lost returns nothing for that Task while the other Task stays readable'
NO_OBSERVATION = ISOLATION + "lifecycle, a fresh update and the worker's other evidence never present activity without an attributed observation"
CARD_LIFECYCLE = 'legacy session and lifecycle cannot turn a board card into running'
HIDDEN_BOARD = 'a hidden tab makes no activity request until it is visible again'
OUT_OF_ORDER = 'out-of-order: an older read that resolves after a newer one cannot overwrite it'
HUNG = 'hung transport is bounded and a late timed-out response cannot restore activity'
BOARD_UPDATE = 'a board update to a card keeps its badge: no empty map and no restarted read'
BOARD_READ = 'the board reads activity for its visible In Progress cards in one batch and hands each card only its own row'
ONE_REFRESH = 'one timed refresh for the whole board, not one poller per card'
NARROW_READ = "at narrow width only the open column's In Progress cards are read"
OUTSIDE = {f'a {status} card shows no activity badge and takes no activity style'
           for status in ('ideas', 'todo', 'review', 'stuck', 'completed', 'archived')}
SKEW = 'a receivedAt up to 5 s after observedAt is clock skew: accepted at age zero, never extra lifetime'
KEPT_DEADLINE = 'a kept row keeps its own deadline across a set change and still turns stale'

# (name, suite kind, [(file, anchor, replacement)], the exact set of tests that must fail)
CONTROLS = [
    # (1) The route reads every requested id, not only the ids the caller may read.
    ('read activity for ids the caller may not read', 'backend',
     [(ROUTE, '    const activity = await telemetryService.activityForTasks(allowed);\n',
       '    const activity = await telemetryService.activityForTasks([...new Set([...allowed, ...ids])]);\n')],
     {COLLECTION, OTHER_TASK, ACCESS_LOST}),
    # (2) A Task with no attributed observation is presented as active - the
    # shape every lifecycle- or legacy-session-derived "Running" took.
    ('present activity without an attributed observation', 'backend',
     [(SERVICE, "      if (!row) return { taskId, state: 'unknown', receivedAt: null, kind: null };\n",
       "      if (!row) return { taskId, state: 'active', receivedAt: null, kind: null };\n")],
     {COLLECTION, COARSE, REASSIGNED, OTHER_TASK, ACCESS_LOST, NO_OBSERVATION, ASSIGNEE_ONLY, SERVICE_ARM}),
    # (3) The read ignores the assignment epoch, so reassigning away and back
    # revives a frame written under the earlier assignment.
    ('read frames from an earlier assignment epoch', 'backend',
     [(SERVICE, "          AND f.payload->>'_taskAssignmentEpoch'=e.epoch::text\n        ORDER BY f.task_id,",
       "        ORDER BY f.task_id,")],
     {REASSIGNED}),
    # (4) The board card infers liveness from the lifecycle status when the read
    # said nothing.
    ('the card infers activity from the lifecycle status', 'frontend',
     [(CARD, '          <TaskActivityBadge activity={taskActivity} />\n',
       "          <TaskActivityBadge activity={taskActivity ?? (task.status === 'in-progress' ? { state: 'active', receivedAt: null } : undefined)} />\n")],
     {CARD_LIFECYCLE}),
    # (5) A hidden tab still reads.
    ('a hidden tab still reads activity', 'frontend',
     [(HOOK, '      if (disposed || document.hidden || ids.length === 0) return;\n',
       '      if (disposed || ids.length === 0) return;\n')],
     {HIDDEN_BOARD}),
    # (6) An obsolete read can still publish: no abort race and no generation
    # check. The reassignment case stays green (declared by measurement): its
    # late result carries the OLD assignment binding, which the hook never returns.
    ('an obsolete read publishes over a newer one', 'frontend',
     [(HOOK, '        const rows = await Promise.race([readTaskActivity(ids, requestController.signal), aborted]);\n',
       '        const rows = await readTaskActivity(ids, requestController.signal);\n'),
      (HOOK, '        if (!disposed && !document.hidden && current === generation) publish(rows);\n',
       '        if (!disposed && !document.hidden) publish(rows);\n')],
     {OUT_OF_ORDER, HUNG}),
    # (7) Card 30d198df (1): the updated time is part of what a row is bound
    # to, so every board update drops every badge to nothing and restarts the read.
    ('a board update empties every badge', 'frontend',
     [(HOOK, '  return JSON.stringify([task.ownerPrincipalId ?? null, task.executionServiceId ?? null,\n',
       '  return JSON.stringify([task.updated ?? null, task.ownerPrincipalId ?? null, task.executionServiceId ?? null,\n')],
     {BOARD_UPDATE}),
    # (8) Card 30d198df (2): the board reads every visible card, not only In Progress.
    ('the board reads cards outside In Progress', 'frontend',
     [(PAGE, '      .flatMap(column => boardData[column].items).filter(activityApplies)\n',
       '      .flatMap(column => boardData[column].items)\n')],
     {BOARD_READ, ONE_REFRESH, NARROW_READ}),
    # (9) Card 30d198df (2): a card outside In Progress shows a badge.
    ('a card outside In Progress shows a badge', 'frontend',
     [(CARD, '  const activityShown = activityApplies(task);\n', '  const activityShown = true;\n')],
     OUTSIDE),
    # (10) Card 30d198df (5): no skew tolerance, so a database clock a little
    # ahead of the API clock refuses the whole batch.
    ('clock skew refuses the whole batch', 'frontend',
     [(HOOK, '            || Date.parse(row.receivedAt) > observedAt + CLOCK_SKEW_TOLERANCE_MS)) {\n',
       '            || Date.parse(row.receivedAt) > observedAt)) {\n')],
     {SKEW}),
    # (11) A row kept across a set change is shown without its own expiry, so
    # it stays active past its deadline while the new read is pending.
    ('a kept row loses its deadline', 'frontend',
     [(HOOK, '    if (kept.size > 0 && !document.hidden) publish(kept);\n', '')],
     {KEPT_DEADLINE}),
]

IGNORED = ('.git', 'graphify-out', 'node_modules', 'dist', 'coverage', '__pycache__', '.pytest_cache')
NOT_MEASURED = (
    ('a hook or test outlived its budget', r'Exceeded timeout|Test timed out|Hook timed out'),
    ('the source did not compile', r'TS\d{4}'),
    ('a syntax error', r'SyntaxError'),
    ('the suite did not load', r'Test suite failed to run|Failed to load url|Transform failed'),
    ('the database was unreachable', r'ECONNREFUSED'),
)
ANSI = re.compile(r'\x1b\[[0-9;]*m')
SUITE_RUN_TIMEOUT_SECONDS = 1200
INCONCLUSIVE_EXIT = 3


def once(text, anchor, replacement):
    count = text.count(anchor)
    if count != 1:
        raise SystemExit(f'anchor matched {count} times, expected 1: {anchor[:100]!r}')
    return text.replace(anchor, replacement, 1)


def fingerprints(tree):
    found = {}
    for path in tree.rglob('*'):
        relative = path.relative_to(tree)
        if path.is_file() and not any(part in IGNORED for part in relative.parts) and not path.name.endswith('.log'):
            found[str(relative)] = hashlib.sha256(path.read_bytes()).hexdigest()
    return found


def require_disposable_database():
    url = urlparse(os.environ.get('RELAYHALL_TEST_DB_URL', ''))
    name = unquote(url.path.lstrip('/'))
    local = url.hostname in ('127.0.0.1', 'localhost') and name == 'relayhall_task_activity_test'
    ci = os.environ.get('CI') == 'true' and url.hostname == 'postgres' and name == 'relayhall_ci'
    if url.scheme not in ('postgres', 'postgresql') or not (local or ci):
        raise SystemExit('RELAYHALL_TEST_DB_URL must name the disposable task activity test database')


def run_suites(copy, out, label, kind):
    report = out / f'{label}.json'
    if kind == 'backend':
        command = ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--testPathIgnorePatterns=/node_modules/',
                   '--runTestsByPath', *BACKEND_SUITES, '--json', f'--outputFile={report}']
        cwd, env = copy / 'backend', dict(os.environ)
    else:
        command = ['node', 'node_modules/vitest/vitest.mjs', 'run', '--pool=forks', '--maxWorkers=1', '--minWorkers=1',
                   '--reporter=json', f'--outputFile={report}', *FRONTEND_SUITES]
        cwd, env = copy / 'frontend', dict(os.environ, NODE_ENV='test')
    timed_out = False
    with (out / f'{label}.log').open('w') as log:
        try:
            code = subprocess.run(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT,
                                  timeout=SUITE_RUN_TIMEOUT_SECONDS).returncode
        except subprocess.TimeoutExpired:
            code, timed_out = None, True
    result = json.loads(report.read_text()) if report.exists() else {}
    tests = [dict(a, fullName=a['fullName'].strip())
             for f in result.get('testResults', []) for a in f.get('assertionResults', [])]
    suite_messages = ANSI.sub('', ' '.join(str(f.get('message', '')) for f in result.get('testResults', [])))
    suite_messages += ANSI.sub('', (out / f'{label}.log').read_text(errors='replace')) if kind == 'frontend' and not tests else ''
    return code, tests, suite_messages, timed_out


def at_assertion(test):
    """jest reports `expect(`; vitest's JSON keeps only the assertion message,
    which begins `expected ` (or names an AssertionError); a Testing Library
    `getBy*` query that finds no element is that idiom's assertion."""
    text = ANSI.sub('', '\n'.join(test.get('failureMessages', [])))
    return ('expect(' in text or 'AssertionError' in text or text.startswith('expected ')
            or re.match(r'(TestingLibraryElementError: )?Unable to find an? (element|label)', text) is not None)


def verdict(code, tests, names, must_fail, suite_messages, timed_out):
    failing = [t for t in tests if t['status'] == 'failed']
    messages = ANSI.sub('', '\n'.join(m for t in failing for m in t.get('failureMessages', [])))
    if timed_out:
        return 'INCONCLUSIVE', f'the runner exceeded {SUITE_RUN_TIMEOUT_SECONDS} s'
    if not tests:
        return 'INCONCLUSIVE', 'no structured assertions: the suites wrote no JSON'
    if sorted(t['fullName'] for t in tests) != names:
        return 'INCONCLUSIVE', 'the suites did not run the tests the baseline ran'
    for reason, pattern in NOT_MEASURED:
        if re.search(pattern, messages + suite_messages):
            return 'INCONCLUSIVE', reason
    thrown = [t for t in failing if not at_assertion(t)]
    if thrown:
        return 'INCONCLUSIVE', f'{len(thrown)} test(s) failed by a thrown error, not an assertion'
    failed = {t['fullName'] for t in failing}
    if not failed:
        return 'MISS', 'no test failed'
    if failed != must_fail:
        return 'MISS', f'{len(failed & must_fail)} of {len(must_fail)} declared and {len(failed - must_fail)} undeclared tests failed'
    if code != 0:
        return 'RED', 'exactly the declared tests failed, each at an assertion'
    return 'MISS', 'the runner exited 0'


def inconclusive(what, reason):
    print(f'INCONCLUSIVE {what}: {reason}. The suites never reached their declared assertions, so this run is '
          f'no verdict; re-run the drill.', flush=True)
    raise SystemExit(INCONCLUSIVE_EXIT)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--describe', action='store_true')
    args = parser.parse_args()

    for _, _, edits, _ in CONTROLS:
        texts = {}
        for path, anchor, replacement in edits:
            texts[path] = once(texts.get(path) or (ROOT / path).read_text(encoding='utf-8'), anchor, replacement)
    sets = [frozenset(c[3]) for c in CONTROLS]
    if len(set(sets)) != len(sets) or any(not s for s in sets):
        raise SystemExit('every control must declare a non-empty set of tests that no other control declares')
    if args.describe:
        print(json.dumps([{'control': c[0], 'suites': c[1], 'files': sorted({e[0] for e in c[2]}),
                           'mustFail': sorted(c[3])} for c in CONTROLS], indent=2))
        return

    require_disposable_database()
    for side in ('backend', 'frontend'):
        if not (ROOT / side / 'node_modules').is_dir():
            raise SystemExit(f'{side}/node_modules is missing: run npm ci in {side}/ first')
    if not args.output_dir:
        raise SystemExit('--output-dir is required')
    out = args.output_dir.resolve()
    if out == ROOT or ROOT in out.parents:
        raise SystemExit('--output-dir must lie outside the repository')
    out.mkdir(parents=True, exist_ok=False)

    before = fingerprints(ROOT)
    copy = Path(tempfile.mkdtemp(prefix='task-activity-drill-'))
    receipts = []
    try:
        shutil.copytree(ROOT, copy, dirs_exist_ok=True, ignore=shutil.ignore_patterns(*IGNORED, '*.log'))
        for side in ('backend', 'frontend'):
            (copy / side / 'node_modules').symlink_to((ROOT / side / 'node_modules').resolve(), target_is_directory=True)

        baselines = {}
        for kind in ('backend', 'frontend'):
            code, tests, suite_messages, timed_out = run_suites(copy, out, f'baseline-{kind}', kind)
            names = sorted(t['fullName'] for t in tests)
            state, reason = verdict(code, tests, names, set(), suite_messages, timed_out)
            if state == 'INCONCLUSIVE':
                inconclusive(f'{kind} baseline', reason)
            if code != 0 or not tests or any(t['status'] != 'passed' for t in tests):
                raise SystemExit(f'{kind} baseline is not green')
            baselines[kind] = names
        for _, kind, _, must_fail in CONTROLS:
            names = baselines[kind]
            absent = sorted(title for title in must_fail if title not in names)
            if absent:
                raise SystemExit(f'a declared test is absent from the {kind} suites: {absent}')
            shared = sorted(title for title in must_fail if names.count(title) != 1)
            if shared:
                raise SystemExit(f'a declared name names more than one test: {shared}')

        for index, (name, kind, edits, must_fail) in enumerate(CONTROLS, start=1):
            originals = {path: (copy / path).read_text(encoding='utf-8') for path, _, _ in edits}
            mutated = dict(originals)
            for path, anchor, replacement in edits:
                mutated[path] = once(mutated[path], anchor, replacement)
            for path, text in mutated.items():
                (copy / path).write_text(text, encoding='utf-8')
            try:
                code, tests, suite_messages, timed_out = run_suites(copy, out, f'control-{index}', kind)
            finally:
                for path, text in originals.items():
                    (copy / path).write_text(text, encoding='utf-8')
            restored = all(hashlib.sha256((copy / path).read_bytes()).hexdigest()
                           == hashlib.sha256(text.encode('utf-8')).hexdigest() for path, text in originals.items())
            failed = {t['fullName'] for t in tests if t['status'] == 'failed'}
            state, reason = verdict(code, tests, baselines[kind], must_fail, suite_messages, timed_out)
            receipts.append({'control': name, 'suites': kind, 'files': sorted(originals), 'mustFail': sorted(must_fail),
                             'failed': sorted(failed), 'red': state == 'RED', 'verdict': state, 'reason': reason,
                             'restored': restored})
            (out / 'receipts.json').write_text(json.dumps(receipts, indent=2))
            print(f"{'RED ' if state == 'RED' else state} {name} -> {len(failed)} failed ({reason})", flush=True)
            if not restored:
                raise SystemExit(f'the mutated files were not restored after control {index}')
            if state == 'INCONCLUSIVE':
                inconclusive(f'control {index} ({name})', reason)
            if state != 'RED':
                for title in sorted(failed ^ must_fail):
                    print(f"   {'undeclared' if title in failed else 'missing'}: {title}", flush=True)
                raise SystemExit(f'control did not fail at its declared assertions: {name}')
    finally:
        shutil.rmtree(copy, ignore_errors=True)
        after = fingerprints(ROOT)
        (out / 'closure.json').write_text(json.dumps({
            'sourceUnchanged': before == after, 'copyRemoved': not copy.exists(), 'controls': len(receipts),
        }, indent=2))
    if before != fingerprints(ROOT):
        raise SystemExit('the source tree changed during the drill')
    print(f'all {len(receipts)} controls red at their declared assertions; source unchanged')


if __name__ == '__main__':
    main()
