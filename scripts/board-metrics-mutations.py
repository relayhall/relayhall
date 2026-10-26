#!/usr/bin/env python3
"""Mutation drill for the plugin bridge's board metrics (card e220be94; owner
ruling E353).

Each control below edits ONE literal anchor in a disposable copy of the tree and
runs two backend suites, the live one against a REAL disposable PostgreSQL
through the production protected router with real session and bearer
authentication:

  backend/src/__tests__/boardMetricsLive.test.ts  (router + stored task and stream rows)
  backend/src/__tests__/boardMetrics.test.ts      (the shape, the reach predicate, the failure paths)

The eight controls: a global queue count (another Account's Tasks leak in);
throughput counting another Account's handbacks; the rolling-hour window
widened; unarmed todo Tasks counted as waiting; an unknown measurement shown
as 0; the freshness stamp dropped; the caller-reach guard dropped at the route;
the tasks:read scope check dropped at the route.

Each run gets one of three verdicts:
  RED           every test ran, and exactly the declared tests failed, each at
                an expect().
  MISS          every test ran to an assertion, and the failed set is not the
                declared set (none failed, or others did).
  INCONCLUSIVE  the suites did not reach the declared assertions (a timeout, a
                compile error, a suite that did not load, an unreachable
                database, a test that failed by a thrown error). No verdict on
                the control; the drill still fails (exit status 3).
A failure is at an assertion when its message carries `expect(`. Every control
declares a different set, so no two can be satisfied by one assertion. The
source tree is never edited: its bytes are fingerprinted before and after.

The backend dependencies must be installed (`npm ci` in backend/); the copy
links backend/node_modules.

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \\
    python3 scripts/board-metrics-mutations.py --output-dir /tmp/board-metrics-drill
  python3 scripts/board-metrics-mutations.py --describe   # checks every anchor, no database
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
SUITES = [
    'src/__tests__/boardMetricsLive.test.ts',
    'src/__tests__/boardMetrics.test.ts',
]
SERVICE = 'backend/src/services/BoardMetricsService.ts'
ROUTE = 'backend/src/routes/pluginHost.ts'

# The declared tests, by their full jest names.
Q = "(Q) queue: the caller Account's armed todo Tasks "
T = "(T) throughput: the caller Account's handbacks in the rolling hour "
U = '(U) unknown is unknown, never 0 '
F = '(F) freshness and the existing fields '
SHAPE = 'board metrics shape (card e220be94) '
FAILURE = 'board metrics service failure paths (card e220be94) '
Q_TWO_ACCOUNTS = Q + "two Accounts each see only their own armed todo Tasks; another Account's Tasks are never counted"
Q_ARMED_TODO = Q + ('only armed todo Tasks wait: unarmed todo, ideas, in-progress, review, stuck, completed and archived '
                    'are not counted')
T_HANDBACK = T + "a REST handback into Review moves its own Account's throughput by one and no other Account's"
T_WINDOW = T + 'only handover.finish entries inside the rolling hour count: an older handback and other entries do not'
U_STATEMENT = U + 'a statement that cannot complete is unknown with a null value, and the bridge still answers'
U_REACH = U + ('a caller whose object reach is narrower than its Account is answered unknown; a full-reach Connector '
               'reads the count')
U_SCOPE = U + 'a credential with services:read alone is answered unknown; the same reach with tasks:read reads the count'
F_STAMP = F + ('every reported metric carries a server observedAt from the read, and metrics and metricsSources are '
               'unchanged')
SHAPE_FRESH = SHAPE + 'freshness: every reported metric carries observedAt, and is stale past 90 seconds'
FAILURE_UNKNOWN = FAILURE + 'a failed connection or statement is unknown, never 0, and the read does not throw'
FAILURE_BROKEN = FAILURE + ('a broken connection is destroyed with its error, never pooled; a statement error returns a '
                            'usable client')

ACCOUNT_PREDICATE = 'AND COALESCE(t.account_owner_principal_id, p.owner_principal_id) = $1`'
ANY_ACCOUNT = 'AND $1::uuid IS NOT NULL`'

# (name, file, anchor, replacement, the exact set of tests that must fail)
CONTROLS = [
    # (1) A global count leaks: the queue statement no longer binds the
    # caller's Account, so every Account's armed todo Tasks are counted.
    ('the queue counts every Account (a global count leaks)', SERVICE,
     "WHERE t.status = 'todo' AND t.auto_start IS TRUE\n    " + ACCOUNT_PREDICATE,
     "WHERE t.status = 'todo' AND t.auto_start IS TRUE\n    " + ANY_ACCOUNT,
     {Q_TWO_ACCOUNTS, Q_ARMED_TODO, U_STATEMENT, U_REACH, U_SCOPE}),
    # (2) Another Account's Tasks are counted: the throughput statement no
    # longer binds the caller's Account.
    ("throughput counts another Account's handbacks", SERVICE,
     'AND e.created_at <= transaction_timestamp()\n    ' + ACCOUNT_PREDICATE,
     'AND e.created_at <= transaction_timestamp()\n    ' + ANY_ACCOUNT,
     {T_HANDBACK, T_WINDOW, U_STATEMENT, U_SCOPE}),
    # (3) The rolling hour widened to a day: a two-hour-old handback counts.
    ('the rolling-hour window widened to a day', SERVICE,
     'make_interval(secs => $2)',
     'make_interval(secs => $2 * 24)',
     {T_WINDOW}),
    # (4) Parked (unarmed) todo Tasks are counted as waiting.
    ('unarmed todo Tasks counted as waiting', SERVICE,
     "WHERE t.status = 'todo' AND t.auto_start IS TRUE\n",
     "WHERE t.status = 'todo'\n",
     {Q_ARMED_TODO}),
    # (5) Zero shown for unknown: a statement that fails is reported as 0.
    ('an unknown measurement shown as 0', SERVICE,
     "      return { unknown: 'unavailable' };\n    }\n  }\n",
     "      return { count: 0, observedAtMs: Date.now() };\n    }\n  }\n",
     {U_STATEMENT, FAILURE_UNKNOWN, FAILURE_BROKEN}),
    # (6) The freshness stamp dropped from the reported queue metric (typed so
    # the copy still compiles; JSON omits an undefined field).
    ('the freshness stamp dropped', SERVICE,
     "        observedAt: new Date(queue.observedAtMs).toISOString(), stale:",
     "        observedAt: undefined as unknown as string, stale:",
     {SHAPE_FRESH, F_STAMP}),
    # (7) The caller-reach guard dropped at the route: a Connector with an
    # explicit object selector receives the Account-wide counts.
    ('the caller-reach guard dropped at the route', ROUTE,
     'accountWideReach(account!, authReq.principal?.id, authReq.delegationLinks)',
     '(accountWideReach(account!, authReq.principal?.id, authReq.delegationLinks) || true)',
     {U_REACH}),
    # (8) The scope ceiling dropped at the route: a credential holding only
    # services:read (the bridge's route scope) receives the Task aggregates.
    ('the tasks:read scope check dropped at the route', ROUTE,
     "scopesSatisfy(authReq.scopes, 'tasks:read')",
     "(scopesSatisfy(authReq.scopes, 'tasks:read') || true)",
     {U_SCOPE}),
]

IGNORED = ('.git', 'graphify-out', 'node_modules', 'dist', 'coverage', '__pycache__', '.pytest_cache')
NOT_MEASURED = (
    ('a hook or test outlived its budget', r'Exceeded timeout|Test timed out|Hook timed out'),
    ('the source did not compile', r'TS\d{4}'),
    ('a syntax error', r'SyntaxError'),
    ('the suite did not load', r'Test suite failed to run'),
    ('the database was unreachable', r'ECONNREFUSED'),
)
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
    local = url.hostname in ('127.0.0.1', 'localhost', '::1') and re.search('test|contract|fixture', name)
    ci = os.environ.get('CI') == 'true' and url.hostname == 'postgres' and name == 'relayhall_ci'
    if url.scheme not in ('postgres', 'postgresql') or name in ('relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod') \
            or not (local or ci):
        raise SystemExit('RELAYHALL_TEST_DB_URL must name a disposable local test database')


def run_suites(copy, out, label):
    report = out / f'{label}.json'
    timed_out = False
    with (out / f'{label}.log').open('w') as log:
        try:
            code = subprocess.run(
                ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--testPathIgnorePatterns=/node_modules/',
                 '--runTestsByPath', *SUITES, '--json', f'--outputFile={report}'],
                cwd=copy / 'backend', stdout=log, stderr=subprocess.STDOUT, timeout=SUITE_RUN_TIMEOUT_SECONDS).returncode
        except subprocess.TimeoutExpired:
            code, timed_out = None, True
    result = json.loads(report.read_text()) if report.exists() else {}
    tests = [dict(a, fullName=a['fullName'].strip())
             for f in result.get('testResults', []) for a in f.get('assertionResults', [])]
    suite_messages = re.sub(r'\x1b\[[0-9;]*m', '', ' '.join(str(f.get('message', '')) for f in result.get('testResults', [])))
    return code, tests, suite_messages, timed_out


def at_assertion(test):
    return 'expect(' in re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(test.get('failureMessages', [])))


def verdict(code, tests, names, must_fail, suite_messages, timed_out):
    failing = [t for t in tests if t['status'] == 'failed']
    messages = re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(m for t in failing for m in t.get('failureMessages', [])))
    if timed_out:
        return 'INCONCLUSIVE', f'the runner exceeded {SUITE_RUN_TIMEOUT_SECONDS} s'
    if not tests:
        return 'INCONCLUSIVE', 'no structured assertions: the suites wrote no JSON'
    if {t['fullName'] for t in tests} != names:
        return 'INCONCLUSIVE', 'the suites did not run the tests the baseline ran'
    for reason, pattern in NOT_MEASURED:
        if re.search(pattern, messages + suite_messages):
            return 'INCONCLUSIVE', reason
    thrown = [t for t in failing if not at_assertion(t)]
    if thrown:
        return 'INCONCLUSIVE', f'{len(thrown)} test(s) failed by a thrown error, not an assertion'
    failed = {t['fullName'] for t in failing}
    if code != 0 and failed == must_fail:
        return 'RED', 'exactly the declared tests failed, each at an assertion'
    if not failed:
        return 'MISS', 'no test failed'
    return 'MISS', f'{len(failed & must_fail)} of {len(must_fail)} declared and {len(failed - must_fail)} undeclared tests failed'


def inconclusive(what, reason):
    print(f'INCONCLUSIVE {what}: {reason}. The suites never reached their declared assertions, so this run is '
          f'no verdict; re-run the drill.', flush=True)
    raise SystemExit(INCONCLUSIVE_EXIT)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--describe', action='store_true')
    args = parser.parse_args()

    for _, path, anchor, replacement, _ in CONTROLS:
        once((ROOT / path).read_text(encoding='utf-8'), anchor, replacement)
    sets = [frozenset(c[4]) for c in CONTROLS]
    if len(set(sets)) != len(sets):
        raise SystemExit('two controls declare the same set of tests')
    if args.describe:
        print(json.dumps([{'control': c[0], 'file': c[1], 'mustFail': sorted(c[4])} for c in CONTROLS], indent=2))
        return

    require_disposable_database()
    if not (ROOT / 'backend' / 'node_modules').is_dir():
        raise SystemExit('backend/node_modules is missing: run npm ci in backend/ first')
    if not args.output_dir:
        raise SystemExit('--output-dir is required')
    out = args.output_dir.resolve()
    if out == ROOT or ROOT in out.parents:
        raise SystemExit('--output-dir must lie outside the repository')
    out.mkdir(parents=True, exist_ok=False)

    before = fingerprints(ROOT)
    copy = Path(tempfile.mkdtemp(prefix='board-metrics-drill-'))
    receipts = []
    try:
        shutil.copytree(ROOT, copy, dirs_exist_ok=True, ignore=shutil.ignore_patterns(*IGNORED, '*.log'))
        (copy / 'backend/node_modules').symlink_to((ROOT / 'backend/node_modules').resolve(), target_is_directory=True)

        code, tests, suite_messages, timed_out = run_suites(copy, out, 'baseline')
        names = {t['fullName'] for t in tests}
        state, reason = verdict(code, tests, names, set(), suite_messages, timed_out)
        if state == 'INCONCLUSIVE':
            inconclusive('baseline', reason)
        if code != 0 or not tests or any(t['status'] != 'passed' for t in tests):
            raise SystemExit('baseline is not green')
        for _, _, _, _, must_fail in CONTROLS:
            if not must_fail <= names:
                raise SystemExit(f'a declared test is absent from the suites: {sorted(must_fail - names)}')

        for index, (name, path, anchor, replacement, must_fail) in enumerate(CONTROLS, start=1):
            target = copy / path
            original = target.read_text(encoding='utf-8')
            target.write_text(once(original, anchor, replacement), encoding='utf-8')
            try:
                code, tests, suite_messages, timed_out = run_suites(copy, out, f'control-{index}')
            finally:
                target.write_text(original, encoding='utf-8')
            restored = hashlib.sha256(target.read_bytes()).hexdigest() == hashlib.sha256(original.encode('utf-8')).hexdigest()
            failed = {t['fullName'] for t in tests if t['status'] == 'failed'}
            state, reason = verdict(code, tests, names, must_fail, suite_messages, timed_out)
            receipts.append({'control': name, 'file': path, 'mustFail': sorted(must_fail),
                             'failed': sorted(failed), 'red': state == 'RED', 'verdict': state, 'reason': reason,
                             'restored': restored})
            (out / 'receipts.json').write_text(json.dumps(receipts, indent=2))
            print(f"{'RED ' if state == 'RED' else state} {name} -> {len(failed)} failed ({reason})", flush=True)
            if not restored:
                raise SystemExit(f'the mutated file was not restored after control {index}')
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
