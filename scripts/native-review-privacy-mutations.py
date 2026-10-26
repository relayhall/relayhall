#!/usr/bin/env python3
"""Mutation drill for the native verification session privacy matrix (card
1444cc80, restriction first).

The session a native verification request reports is decided in ONE place,
NativeReviewService.list: a reader that may read the Task but not the session
(no services:read, no telemetry read scope, or another Account than the
attested link's) is answered {state: 'restricted'} for an expired link and a
live one alike, with no expiry, no navigation triple (sessionRef, connectorId,
sourceProduct), no count and no cardinality.

Each control below edits ONE literal anchor of that function in a disposable
copy of the tree and runs two backend suites, the live one against a REAL
disposable PostgreSQL through the production router and the MCP ingress:

  backend/src/__tests__/nativeReviewLive.test.ts            (REST + MCP as current principals)
  backend/src/__tests__/nativeReviewSessionPrivacy.test.ts  (the service, mocked)

The three controls are the three the lane brief names: evaluate the link's
expiry before the restriction; add the native triple to a restricted session;
add a count to a restricted session.

Each run gets one of three verdicts:
  RED           every test ran, exactly the declared tests failed, each at an
                expect(), and the values received name the control's own leak
                (an expiry, the triple, a count) and no other control's.
  MISS          every test ran to an assertion, and the failed set is not the
                declared set (none failed, or others did), or the received
                values do not name the control's own leak.
  INCONCLUSIVE  the suites did not reach the declared assertions (a timeout, a
                compile error, a suite that did not load, an unreachable
                database, a test that failed by a thrown error). No verdict on
                the control; the drill still fails (exit status 3).
Tests are declared by their full jest names. A failure is at an assertion when
its message carries `expect(`. Every control declares a different set, so no
two can be satisfied by one assertion. The source tree is never edited: its
bytes are fingerprinted before and after.

The backend dependencies must be installed (`npm ci` in backend/); the copy
links backend/node_modules.

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/relayhall_native_review_test \\
    python3 scripts/native-review-privacy-mutations.py --output-dir /tmp/native-review-privacy-drill
  python3 scripts/native-review-privacy-mutations.py --describe   # checks every anchor, no database
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
    'src/__tests__/nativeReviewLive.test.ts',
    'src/__tests__/nativeReviewSessionPrivacy.test.ts',
]
SERVICE = 'backend/src/services/NativeReviewService.ts'

# The declared tests, by their full jest names.
LIVE_MATRIX = 'actual REST/MCP session privacy recomputes scope, expiry and current Task read before projection'
LIVE_TRIPLE = 'real telemetry ingest produces the same full triple; other Accounts and expired links never expose it'
EXPIRED, LIVE = '2000-01-01T00:00:00Z', '2099-01-01T00:00:00Z'
DENIED = 'denied service scope hides session state '
MISSING = 'missing telemetry scope hides session state '
FOREIGN = 'foreign account hides session state '
RECOMPUTED = 'current scope is recomputed after a previously available read'
PURGED = 'purged link cannot reveal expiry to a denied or unbound account'
EVERY_DENIED_READER = {DENIED + EXPIRED, DENIED + LIVE, MISSING + EXPIRED, MISSING + LIVE, FOREIGN + EXPIRED, FOREIGN + LIVE}

# The one place a session is decided.
RESTRICTED_FIRST = "      let session:Record<string,unknown>=restricted?{state:'restricted'}:\n"
EXPIRY_AFTER = ("      if(link && !restricted) {\n"
                "        if(new Date(link.expires_at)<=new Date()) session={state:'expired'};\n")

# What a control's leak looks like in the values a failed assertion received
# (a JSON key or value, quoted, escaped or not): the evidence a control is red
# for its own leak and not for another control's.
LEAKS = {
    'expiry': r'\\?"expired\\?"',
    'triple': r'\\?"sessionRef\\?"',
    'count': r'\\?"count\\?"',
}

# (name, file, anchor, replacement, the exact set of tests that must fail, the leak received)
CONTROLS = [
    # (1) The pre-repair order: the link's expiry is evaluated before the
    # restriction, so a denied reader of an expired link learns 'expired'.
    # A denied reader of a LIVE link is still restricted, so only the expired
    # cases of the service suite redden, and the live matrix.
    ('evaluate the link expiry before the restriction', SERVICE,
     EXPIRY_AFTER,
     "      if(link && new Date(link.expires_at)<=new Date()) session={state:'expired'};\n" + EXPIRY_AFTER,
     {LIVE_MATRIX, DENIED + EXPIRED, MISSING + EXPIRED, FOREIGN + EXPIRED},
     'expiry'),
    # (2) The native triple is added to a restricted session. Where no link
    # remains (the purged case) the triple is undefined and toEqual ignores
    # it, so that case stays green (declared by measurement).
    ('add the native triple to a restricted session', SERVICE,
     RESTRICTED_FIRST,
     "      let session:Record<string,unknown>=restricted?{state:'restricted',sessionRef:link?.session_ref,"
     "connectorId:link?.connector_id,sourceProduct:link?.source_product}:\n",
     {LIVE_MATRIX, LIVE_TRIPLE, RECOMPUTED} | EVERY_DENIED_READER,
     'triple'),
    # (3) A count is added to a restricted session; with no link it is 0, so
    # the purged case reddens too.
    ('add a count to a restricted session', SERVICE,
     RESTRICTED_FIRST,
     "      let session:Record<string,unknown>=restricted?{state:'restricted',count:links.length}:\n",
     {LIVE_MATRIX, LIVE_TRIPLE, RECOMPUTED, PURGED} | EVERY_DENIED_READER,
     'count'),
]

IGNORED = ('.git', 'graphify-out', 'node_modules', 'dist', 'coverage', '__pycache__', '.pytest_cache')
NOT_MEASURED = (
    ('a hook or test outlived its budget', r'Exceeded timeout|Test timed out|Hook timed out'),
    ('the source did not compile', r'TS\d{4}'),
    ('a syntax error', r'SyntaxError'),
    ('the suite did not load', r'Test suite failed to run'),
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
    local = url.hostname in ('127.0.0.1', 'localhost') and name == 'relayhall_native_review_test'
    ci = os.environ.get('CI') == 'true' and url.hostname == 'postgres' and name == 'relayhall_ci'
    if url.scheme not in ('postgres', 'postgresql') or not (local or ci):
        raise SystemExit('RELAYHALL_TEST_DB_URL must name the disposable native review test database')


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
    suite_messages = ANSI.sub('', ' '.join(str(f.get('message', '')) for f in result.get('testResults', [])))
    return code, tests, suite_messages, timed_out


def at_assertion(test):
    return 'expect(' in ANSI.sub('', '\n'.join(test.get('failureMessages', [])))


def received(failing):
    """The lines of the failure messages that show what a test received: a
    `Received:` line or a `+` line of a diff (never the code frame)."""
    lines = ANSI.sub('', '\n'.join(m for t in failing for m in t.get('failureMessages', []))).splitlines()
    return '\n'.join(line for line in lines if re.match(r'\s*(Received:|\+ )', line))


def verdict(code, tests, names, must_fail, leak, suite_messages, timed_out):
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
    seen = received(failing)
    if leak is not None:
        if not re.search(LEAKS[leak], seen):
            return 'MISS', f'the declared tests failed, but no received value names the {leak} leak'
        others = [other for other in LEAKS if other != leak and re.search(LEAKS[other], seen)]
        if others:
            return 'MISS', f'the received values also name another control\'s leak: {others}'
    if code != 0:
        return 'RED', 'exactly the declared tests failed, each at an assertion, for the control\'s own leak'
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

    for _, path, anchor, replacement, _, _ in CONTROLS:
        once((ROOT / path).read_text(encoding='utf-8'), anchor, replacement)
    sets = [frozenset(c[4]) for c in CONTROLS]
    if len(set(sets)) != len(sets) or any(not s for s in sets):
        raise SystemExit('every control must declare a non-empty set of tests that no other control declares')
    leaks = [c[5] for c in CONTROLS]
    if len(set(leaks)) != len(leaks) or any(leak not in LEAKS for leak in leaks):
        raise SystemExit('every control must name its own leak')
    if args.describe:
        print(json.dumps([{'control': c[0], 'file': c[1], 'leak': c[5], 'mustFail': sorted(c[4])} for c in CONTROLS],
                         indent=2))
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
    copy = Path(tempfile.mkdtemp(prefix='native-review-privacy-drill-'))
    receipts = []
    try:
        shutil.copytree(ROOT, copy, dirs_exist_ok=True, ignore=shutil.ignore_patterns(*IGNORED, '*.log'))
        (copy / 'backend/node_modules').symlink_to((ROOT / 'backend/node_modules').resolve(), target_is_directory=True)

        code, tests, suite_messages, timed_out = run_suites(copy, out, 'baseline')
        # The tests the baseline ran, with multiplicity: two parameterised
        # cases of the live suite share a name, and neither is declared.
        names = sorted(t['fullName'] for t in tests)
        state, reason = verdict(code, tests, names, set(), None, suite_messages, timed_out)
        if state == 'INCONCLUSIVE':
            inconclusive('baseline', reason)
        if code != 0 or not tests or any(t['status'] != 'passed' for t in tests):
            raise SystemExit('baseline is not green')
        for _, _, _, _, must_fail, _ in CONTROLS:
            absent = sorted(title for title in must_fail if title not in names)
            if absent:
                raise SystemExit(f'a declared test is absent from the suites: {absent}')
            shared = sorted(title for title in must_fail if names.count(title) != 1)
            if shared:
                raise SystemExit(f'a declared name names more than one test: {shared}')

        for index, (name, path, anchor, replacement, must_fail, leak) in enumerate(CONTROLS, start=1):
            target = copy / path
            original = target.read_text(encoding='utf-8')
            target.write_text(once(original, anchor, replacement), encoding='utf-8')
            try:
                code, tests, suite_messages, timed_out = run_suites(copy, out, f'control-{index}')
            finally:
                target.write_text(original, encoding='utf-8')
            restored = hashlib.sha256(target.read_bytes()).hexdigest() == hashlib.sha256(original.encode('utf-8')).hexdigest()
            failed = {t['fullName'] for t in tests if t['status'] == 'failed'}
            state, reason = verdict(code, tests, names, must_fail, leak, suite_messages, timed_out)
            receipts.append({'control': name, 'file': path, 'leak': leak, 'mustFail': sorted(must_fail),
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
