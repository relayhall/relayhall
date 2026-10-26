#!/usr/bin/env python3
"""Mutation drill for wake protocol 2 (owner ruling E462, the universal harness
connector design, sections 6.1-6.3 and 6.7).

Each control edits ONE literal anchor in a DISPOSABLE COPY of the tree, runs
the live suite (src/__tests__/connectorWakeKindsDb.integration.test.ts)
against a REAL disposable PostgreSQL through the production routers and real
sockets, and requires that suite to go red at EXACTLY the predeclared set of
tests, by an assertion (never a compile error, a suite that failed to run, or
a jest timeout). The controls withdraw, one at a time, what the design names:

  - the per-Task predicate: the Verify item's subtree arm, the read scope in
    the query, and the Stuck item's exact addressee;
  - the per-kind withdrawal: an item that closed (or that the Connector can no
    longer see) and a Verifier that changed;
  - the dedupe per (Task, kind, principal): in flight, and after settling;
  - the protocol gate that keeps `?wake=1` as it was: kinds evaluated only for
    a protocol-2 endpoint, framed only to protocol-2 sockets, settled only by a
    protocol-2 acknowledgement;
  - the own-work guard (the execution Connector, an Assignee in its subtree),
    which since S4b is the chain guard G(Task): its execution-connector seed
    and its current-Assignee seed walked up to the Connector;
  - the `wake.outcome` frame: the acknowledging socket only, in order, only
    while the Connector can read the Task; and its Timeline classification.

The source tree is never edited: its bytes are fingerprinted before and after.
The suite creates its own principals and Tasks with random handles, so the
runs share one database; nothing here creates, drops or restores a database.

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \\
    python3 scripts/connector-wake-kinds-mutations.py --output-dir /tmp/wake-kinds-drill
  python3 scripts/connector-wake-kinds-mutations.py --describe   # checks every anchor, no database
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parents[1]
SUITE = 'src/__tests__/connectorWakeKindsDb.integration.test.ts'
WAKE = 'backend/src/services/ConnectorWakeService.ts'
ACTIONS = 'backend/src/services/NotificationActionsService.ts'
TIMELINE = 'backend/src/services/UnifiedTaskTimeline.ts'
# Owner ruling E462 S4b: the own-work guard reads the chain guard G(Task) here.
GUARD = 'backend/src/utils/verificationGuardSql.ts'

# Tests, by title.
EXACT = 'S4 verify rings the exact Verifier connector with the kind, and its ack is a verify receipt'
SUBTREE = 'S4 verify rings the connector whose Agent is the Verifier, never another reader, and matches the pull'
HIDDEN = 'S4 verify never rings a connector that may not see the Task, even with its own Agent as the Verifier'
LOST_READ = 'S4 a connector that loses read while the wake waits is withdrawn before the next send'
LEAVES = 'S4 verify is withdrawn when the Task leaves Review'
VERIFIER_CHANGE = 'S4 verify is withdrawn when the Verifier changes, even inside the same subtree'
WRITER = 'S4 a Verifier change through the roles writer withdraws the old wake and rings the new Verifier connector'
DEDUPE_IN_FLIGHT = 'S4 dedupe in flight: a second opening event for the same occurrence rings nothing more'
DEDUPE_SETTLED = 'S4 dedupe after settling: the same open occurrence is not rung again'
WAKE1 = 'S4 a wake=1 connector is never rung for verify, and its implement wake is unchanged'
MIXED_FRAME = 'S4 on a mixed endpoint only the wake=2 socket hears verify'
MIXED_ACK = 'S4 a wake=1 acknowledgement cannot settle a verify wake'
OWN_EXECUTION = 'S4 a connector is never rung to verify a Task it executes'
OWN_ASSIGNEE = 'S4 a connector is never rung to verify a Task its own subtree is the Assignee of'
STUCK_ADDRESSEE = 'S4 stuck rings its exact addressee: the Shepherd, never the Assignee under a Shepherd'
STUCK_CLOSES = 'S4 stuck is withdrawn when its item closes'
OUTCOME_SOCKET = 'S4 an outcome is accepted only on the acknowledging socket, and becomes a connector.trigger entry and audit row'
OUTCOME_TIMELINE = "S4 the connector.trigger entry is on the Task Timeline's System view"
OUTCOME_ORDER = 'S4 outcomes are taken in order: finished needs started, and nothing follows the end'
OUTCOME_READ = 'S4 an outcome from a connector that can no longer read the Task writes nothing'
RESTART = 'S4 restart: a wake lost with the process is found by the catch-up pull, with no new core state'
ALL_TESTS = [EXACT, SUBTREE, HIDDEN, LOST_READ, LEAVES, VERIFIER_CHANGE, WRITER, DEDUPE_IN_FLIGHT, DEDUPE_SETTLED,
             WAKE1, MIXED_FRAME, MIXED_ACK, OWN_EXECUTION, OWN_ASSIGNEE, STUCK_ADDRESSEE, STUCK_CLOSES,
             OUTCOME_SOCKET, OUTCOME_TIMELINE, OUTCOME_ORDER, OUTCOME_READ, RESTART]

# (name, file, anchor, replacement, the exact set of tests that must fail).
CONTROLS = [
    ('the Verify item ignores the Verifier subtree', ACTIONS,
     "(vt.status = 'review' AND vt.verifier_principal_id IN (SELECT id FROM my_subtree)) AS as_verifier,",
     "(vt.status = 'review' AND (vt.verifier_principal_id IN (SELECT id FROM my_subtree) OR TRUE)) AS as_verifier,",
     {SUBTREE}),
    # The list reads the same query, so the hidden Task's own pull lists it too.
    ('the Verify query is not narrowed by the read scope', ACTIONS,
     'AND ${scope.sql})\n            AND (${onlyParam}::uuid[] IS NULL',
     'AND (${scope.sql} OR TRUE))\n            AND (${onlyParam}::uuid[] IS NULL',
     {LOST_READ, HIDDEN}),
    ('the Stuck item reaches the Assignee under a Shepherd', ACTIONS,
     'WHERE COALESCE(st.shepherd_principal_id, st.creator_principal_id, st.owner_principal_id) = $1::uuid',
     'WHERE (st.owner_principal_id = $1::uuid OR COALESCE(st.shepherd_principal_id, st.creator_principal_id, st.owner_principal_id) = $1::uuid)',
     {STUCK_ADDRESSEE}),
    ('a closed or unreadable item keeps ringing', WAKE,
     "const itemOpen = kinds.occurrence(wake.kind as 'verify' | 'stuck', wake.taskId) !== null;",
     "const itemOpen = kinds.occurrence(wake.kind as 'verify' | 'stuck', wake.taskId) !== null || wake.attempts >= 0;",
     {LOST_READ, LEAVES, STUCK_CLOSES}),
    ('a changed Verifier keeps ringing', WAKE,
     '    const sameVerifier = wake.kind !== \'verify\'\n',
     '    const sameVerifier = wake.kind !== \'verify\' || wake.attempts >= 0\n',
     {VERIFIER_CHANGE}),
    ('the in-flight dedupe is gone', WAKE,
     '          if (flying && flying.occurrence === open.occurrence) continue;\n', '',
     {DEDUPE_IN_FLIGHT}),
    # `key` stays read, so the mutant compiles (an unused local is a compile error).
    ('a rung occurrence is forgotten', WAKE,
     'if (!flying && this.rung.get(key) === open.occurrence) continue;',
     "if (!flying && this.rung.get(key) === open.occurrence && key === '') continue;",
     {DEDUPE_SETTLED}),
    # S4b fold: the endpoint speaks protocol 2 while any open socket does.
    ('a protocol-1 endpoint is evaluated for verify and stuck', WAKE,
     'const kinds = speaksProtocol2(endpoint)', 'const kinds = endpoint.sockets.size > 0',
     {WAKE1}),
    ('a verify frame reaches a protocol-1 socket', WAKE,
     "(wake.kind === 'implement' || protocol === 2))", "(wake.kind === 'implement' || protocol >= 1))",
     {MIXED_FRAME}),
    ('a protocol-1 acknowledgement settles any kind', WAKE,
     "if (protocol === null || (wake.kind !== 'implement' && protocol !== 2)) return false;",
     'if (protocol === null) return false;',
     {MIXED_ACK}),
    # S4b: the own-work guard is G(Task); each control drops one of its seeds.
    ('the execution Connector is rung to verify its Task', GUARD,
     '       WHERE g_t.id = ${taskId}\n      UNION SELECT g_t.owner_principal_id',
     '       WHERE g_t.id = ${taskId} AND FALSE\n      UNION SELECT g_t.owner_principal_id',
     {OWN_EXECUTION}),
    ('an Assignee in the subtree is not own work', GUARD,
     'UNION SELECT g_t.owner_principal_id FROM tasks g_t WHERE g_t.id = ${taskId}\n',
     'UNION SELECT g_t.owner_principal_id FROM tasks g_t WHERE g_t.id = ${taskId} AND FALSE\n',
     {OWN_ASSIGNEE}),
    ('an outcome is taken from any socket of the principal', WAKE,
     'if (!wake || wake.principalId !== identity.principalId || wake.socket !== socket) return false;',
     # `socket` stays read, so the mutant compiles.
     'if (!wake || wake.principalId !== identity.principalId || socket === null) return false;',
     {OUTCOME_SOCKET}),
    ('outcomes are taken out of order', WAKE,
     "    if (report.outcome === 'finished' ? !wake.started : wake.started) return false;\n", '',
     {OUTCOME_ORDER}),
    ('an outcome is written without read', WAKE,
     '    if (!readable) {', "    if (!readable && report.wakeId === '') {",
     {OUTCOME_READ}),
    ('the trigger entry is not a known System type', TIMELINE,
     "  'connector.trigger',\n", '',
     {OUTCOME_TIMELINE}),
]

# A failure that is not an assertion proves nothing about the guard.
NOT_AN_ASSERTION = re.compile(r'Exceeded timeout of|error TS\d+|Test suite failed to run|Cannot find module')


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fingerprint() -> dict:
    return {str(p.relative_to(ROOT)): sha(p) for p in (ROOT / 'backend/src').rglob('*') if p.is_file()}


def check_anchors(base: Path) -> None:
    for name, rel, old, new, expected in CONTROLS:
        text = (base / rel).read_text(encoding='utf-8')
        if text.count(old) != 1:
            raise RuntimeError(f'anchor for {name!r} occurs {text.count(old)} times in {rel}')
        if old == new:
            raise RuntimeError(f'control {name!r} changes nothing')
        unknown = expected - set(ALL_TESTS)
        if unknown or not expected:
            raise RuntimeError(f'control {name!r} names tests the suite does not have: {sorted(unknown)}')
    suite = (base / 'backend' / SUITE).read_text(encoding='utf-8')
    titles = re.findall(r"^test\((['\"])(S4 .*?)\1, async", suite, flags=re.M)
    names = [title for _q, title in titles]
    if sorted(names) != sorted(ALL_TESTS):
        raise RuntimeError(f'the suite titles and the drill disagree: {sorted(set(names) ^ set(ALL_TESTS))}')


def disposable(raw: str) -> None:
    url = urlparse(raw)
    name = unquote(url.path.lstrip('/'))
    local = url.hostname in ('127.0.0.1', 'localhost', '::1') and re.search(r'test|contract|fixture', name)
    ci = os.environ.get('CI') == 'true' and url.hostname == 'postgres' and name == 'relayhall_ci'
    if url.scheme not in ('postgres', 'postgresql') or name in ('relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod') \
            or not (local or ci):
        raise RuntimeError('Refusing a non-disposable database target')


def run_suite(copy: Path, out: Path, label: str, env: dict) -> dict:
    report = out / f'{label}.json'
    cmd = ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--testPathIgnorePatterns=/node_modules/',
           '--runTestsByPath', SUITE, f'--cacheDirectory={out / "jest-cache"}', '--json', f'--outputFile={report}']
    with (out / f'{label}.log').open('w', encoding='utf-8') as log:
        subprocess.run(cmd, cwd=copy / 'backend', env=env, stdout=log, stderr=subprocess.STDOUT, check=False)
    return json.loads(report.read_text(encoding='utf-8'))


def outcomes(data: dict) -> dict:
    # A suite that failed to run (a mutant that does not compile) proves nothing: refuse it by name.
    if data.get('numRuntimeErrorTestSuites', 0) or not data.get('numTotalTests'):
        messages = ' '.join(r.get('message', '') for r in data.get('testResults', []))[:400]
        raise RuntimeError(f'the suite did not run: {messages}')
    found = {}
    for result in data.get('testResults', []):
        for case in result.get('assertionResults', []):
            found[case['title']] = (case['status'], ' '.join(case.get('failureMessages') or []))
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--output-dir')
    parser.add_argument('--describe', action='store_true')
    args = parser.parse_args()
    check_anchors(ROOT)
    if args.describe:
        for name, rel, _old, _new, expected in CONTROLS:
            print(f'{name}  [{rel}]  -> {len(expected)} test(s)')
        print(f'{len(CONTROLS)} controls, every anchor found exactly once')
        return 0
    if not args.output_dir:
        parser.error('--output-dir is required unless --describe')
    raw = os.environ.get('RELAYHALL_TEST_DB_URL', '')
    disposable(raw)
    out = Path(args.output_dir).resolve()
    out.mkdir(mode=0o700, parents=True, exist_ok=False)
    before = fingerprint()
    copy = out / 'private-copy'
    copy.mkdir()
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    for rel in filter(None, tracked):
        source = ROOT / rel
        if source.is_file():
            (copy / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, copy / rel)
    # The working tree's own edits to the files the drill reads (a lane runs it before committing).
    for rel in [WAKE, ACTIONS, TIMELINE, GUARD, 'backend/' + SUITE]:
        (copy / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / rel, copy / rel)
    (copy / 'backend/node_modules').symlink_to((ROOT / 'backend/node_modules').resolve(), target_is_directory=True)
    check_anchors(copy)
    env = {k: v for k, v in os.environ.items() if not k.startswith(('DB_', 'PG')) and k != 'DATABASE_URL'}
    env.update(RELAYHALL_TEST_DB_URL=raw, NODE_ENV='test')
    receipts = []
    try:
        baseline = outcomes(run_suite(copy, out, 'baseline', env))
        green = sorted(t for t, (status, _m) in baseline.items() if status == 'passed')
        if green != sorted(ALL_TESTS):
            raise RuntimeError(f'baseline is not green: {sorted(set(ALL_TESTS) - set(green))}')
        for index, (name, rel, old, new, expected) in enumerate(CONTROLS, start=1):
            path = copy / rel
            original = path.read_bytes()
            path.write_bytes(original.decode('utf-8').replace(old, new, 1).encode('utf-8'))
            try:
                found = outcomes(run_suite(copy, out, f'control-{index:02d}', env))
            finally:
                path.write_bytes(original)
            failed = {t for t, (status, _m) in found.items() if status == 'failed'}
            passed = {t for t, (status, _m) in found.items() if status == 'passed'}
            bad = [t for t in failed if NOT_AN_ASSERTION.search(found[t][1])]
            exact = failed == expected and passed == set(ALL_TESTS) - expected and not bad
            receipts.append({'control': name, 'file': rel, 'expected': sorted(expected), 'failed': sorted(failed),
                             'notAnAssertion': sorted(bad), 'exact': exact})
            (out / 'receipts.json').write_text(json.dumps(receipts, indent=2), encoding='utf-8')
            print(('EXACT ' if exact else 'MISMATCH ') + name, flush=True)
            if not exact:
                raise RuntimeError(f'control {name!r}: expected {sorted(expected)}, failed {sorted(failed)}, '
                                   f'not an assertion {sorted(bad)}')
        restored = outcomes(run_suite(copy, out, 'restored', env))
        if sorted(t for t, (s, _m) in restored.items() if s == 'passed') != sorted(ALL_TESTS):
            raise RuntimeError('the restored copy is not green')
    finally:
        shutil.rmtree(copy, ignore_errors=True)
    if fingerprint() != before:
        raise RuntimeError('the source tree changed during the drill')
    (out / 'receipt.json').write_text(json.dumps({
        'status': 'PASS', 'controls': receipts, 'baseline': len(ALL_TESTS), 'restored': len(ALL_TESTS),
        'sourceUnchanged': True, 'scriptSha256': sha(Path(__file__)),
    }, indent=2), encoding='utf-8')
    print(f'PASS: {len(ALL_TESTS)} baseline/restored and {len(CONTROLS)} exact live controls; source unchanged')
    return 0


if __name__ == '__main__':
    sys.exit(main())
