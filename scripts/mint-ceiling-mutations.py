#!/usr/bin/env python3
"""Mutation drill for the Agent mint ceiling (card 785e1eed P1-C).

Each control below edits ONE literal anchor in a disposable copy of the tree,
runs `backend/src/__tests__/mintCeilingParityLive.test.ts` against a REAL
disposable PostgreSQL, and requires the suite to go red at exactly the
predeclared set of tests, for an assertion (not a compile error, a timeout or
a crashed fixture). Eight controls make the ceiling WIDER than the live
predicate: three in the live arm (exact rules), three in the algebra arm
(all-of-type, all-except, all-in-project: every source holds every verb, the
own() caps are dropped, every Account is an administrator), and two that each
withdraw one half of the check at filing. One makes it narrower again (the
pre-repair algebra).
The source tree is never edited: its bytes are fingerprinted before and after.

Each run gets one of three verdicts (card 696f3bb8):
  RED           the suite ran every test, and exactly the declared tests failed,
                each at an expect().
  MISS          the suite ran every test to an assertion, and the failed set is
                not the declared set (none failed, or others did).
  INCONCLUSIVE  the suite did not reach the declared assertions: a hook or test
                outlived its budget, the source did not compile, the suite did
                not load, the database was unreachable, a test failed by a
                thrown error rather than an assertion, or the runner itself ran
                out of time. That is no verdict on the control, so it is never
                reported as a MISS; the drill still fails (exit status 3).

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \\
    python3 scripts/mint-ceiling-mutations.py --output-dir /tmp/mint-ceiling-drill
  python3 scripts/mint-ceiling-mutations.py --describe   # checks every anchor, no database
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
SUITE = 'src/__tests__/mintCeilingParityLive.test.ts'
MINT = 'backend/src/services/AgentMintService.ts'
APPROVAL = 'backend/src/services/ApprovalService.ts'

PARITY = 'the filing verdict equals the live verdict in EVERY cell: never wider, never narrower'
OWNER = "1: an Account that OWNS the Task's Project, with no grant row, mints {task exact X [read, write]}"
PROJECT = '3: an Account holding a Project-level grant mints a Task-exact rule'
REST = 'REST: 403 MINT_EXCEEDS_REQUESTER naming the rule, no Approval row, an audited denial'
MCP = 'MCP relayhall_agent_mint: the same refusal, through the same route'
DECIDE = "DECIDE: authority withdrawn after filing refuses with the filing refusal's exact code and words"
SCOPE = 'the scope half of T2 refuses at filing too, naming the scope'
BOTH = 'both verdicts occur, in every rule shape (a ceiling that always says yes or always no fails above)'
# Section 6, the algebra arm: the cells that refuse.
ALG_EXACT_ALL = '6a: an exact grant only, all-of-type [read]: refused'
ALG_EXACT_EXCEPT = '6b: an exact grant only, all-except [Z] [read]: refused'
ALG_WILDCARD_ADMIN = '6d: a wildcard Task write grant, all-of-type [admin]: refused (write confers no admin)'
ALG_PROFILE_WIDER = '6f: a profile all-in-project [P] write, all-in-project [P, P2] [read, write]: refused'
ALG_PROFILE_USE = '6g: a profile all-in-project [P] write, all-in-project [P] [use]: refused (write confers no use)'
ALG_CONNECTOR_CAP = ('6h: a Connector own() capped to exact [X] under a wildcard-grant Account, '
                     'all-of-type [read]: refused')
ALGEBRA_REFUSALS = {ALG_EXACT_ALL, ALG_EXACT_EXCEPT, ALG_WILDCARD_ADMIN, ALG_PROFILE_WIDER, ALG_PROFILE_USE,
                    ALG_CONNECTOR_CAP}

# (name, file, anchor, replacement, the exact set of tests that must fail)
CONTROLS = [
    ('wider: a write rule is asked only about read', MINT,
     'return AUTHORIZATION_ACTIONS.filter((action) => verbs.some((verb) => grantAllows(verb, action)));',
     'return AUTHORIZATION_ACTIONS.filter((action) => verbs.some((verb) => grantAllows(verb, action))).slice(0, 1);',
     # The same mapping feeds the algebra arm's verb implication: `admin` then
     # confers only read, which a write source holds.
     {PARITY, ALG_WILDCARD_ADMIN}),
    ("wider: the requester's own Task roles count", MINT,
     "    principalId: null,\n    handle: 'agent-mint-ceiling',",
     "    principalId: chain[0].principalId,\n    handle: 'agent-mint-ceiling',",
     {PARITY}),
    ("wider: the chain's own() caps are dropped", MINT,
     '        ...chain.map((link) => ({',
     '        ...chain.filter((link) => !link.parentPrincipalId).map((link) => ({',
     {PARITY}),
    ('wider (M1): every algebra source holds every verb', MINT,
     '      .every((action) => source.verbs.some((held) => grantAllows(held, action)))),',
     '      .every((action) => source.verbs.length > 0 || source.verbs.some((held) => grantAllows(held, action)))),',
     {ALG_WILDCARD_ADMIN, ALG_PROFILE_USE}),
    ("wider (M2): the algebra arm drops the chain's own() caps", MINT,
     "if (own && own.objects !== 'parent' && !rulesCovered(",
     "if (links.length < 0 && own && own.objects !== 'parent' && !rulesCovered(",
     {ALG_CONNECTOR_CAP}),
    ('wider (M3): the algebra arm treats every Account as an administrator', MINT,
     "if (ADMINISTRATOR_ROLES.has(String(link.role || '').toLowerCase())) continue;",
     "if (ADMINISTRATOR_ROLES.size > 0 || ADMINISTRATOR_ROLES.has(String(link.role || '').toLowerCase())) continue;",
     {ALG_EXACT_ALL, ALG_EXACT_EXCEPT, ALG_WILDCARD_ADMIN, ALG_PROFILE_WIDER, ALG_PROFILE_USE}),
    ('wider: the object half is not checked at filing', APPROVAL,
     '      await agentMintService.assertObjectAuthorityCovers(input.requesterPrincipalId, rules);\n',
     '',
     {REST, MCP, DECIDE, PARITY, BOTH} | ALGEBRA_REFUSALS),
    ('wider: the scope half is not checked at filing', APPROVAL,
     'agentMintService.assertScopesWithinEffective(effectiveNow, scopes);',
     'agentMintService.assertScopesWithinEffective([...effectiveNow, ...scopes], scopes);',
     {SCOPE}),
    ('narrower: the live arm is withdrawn (the pre-repair algebra decides)', MINT,
     "const notHeld = rule.selectorForm === 'exact' && hasLiveShape(rule.resourceType)",
     "const notHeld = (rule.selectorForm as string) === 'pre-repair' && hasLiveShape(rule.resourceType)",
     {OWNER, PROJECT, PARITY}),
]

IGNORED = ('.git', 'graphify-out', 'node_modules', 'dist', 'coverage', '__pycache__', '.pytest_cache')

# Card 696f3bb8. Signatures of a run that never reached its assertions. A hook
# timeout fails every test of its describe at once (CI run 5685 job 14991: the
# section 5 matrix outlived the file-wide 300 000 ms budget), which is not the
# control's doing and must not read as a MISS.
NOT_MEASURED = (
    ('a hook or test outlived its budget', r'Exceeded timeout'),
    ('the source did not compile', r'TS\d{4}'),
    ('a syntax error', r'SyntaxError'),
    ('the suite did not load', r'Test suite failed to run'),
    ('the database was unreachable', r'ECONNREFUSED'),
)
# The whole suite on a saturated runner, the parity matrix's own 900 000 ms
# hook budget included, with room for the other sections.
SUITE_RUN_TIMEOUT_SECONDS = 1800
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


def run_suite(copy, out, label):
    report = out / f'{label}.json'
    command = ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--testPathIgnorePatterns=/node_modules/',
               '--runTestsByPath', SUITE, '--json', f'--outputFile={report}']
    timed_out = False
    with (out / f'{label}.log').open('w') as log:
        try:
            code = subprocess.run(command, cwd=copy / 'backend', stdout=log, stderr=subprocess.STDOUT,
                                  timeout=SUITE_RUN_TIMEOUT_SECONDS).returncode
        except subprocess.TimeoutExpired:
            code, timed_out = None, True
    result = json.loads(report.read_text()) if report.exists() else {}
    tests = [a for f in result.get('testResults', []) for a in f.get('assertionResults', [])]
    suite_messages = ' '.join(str(f.get('message', '')) for f in result.get('testResults', []))
    return code, tests, re.sub(r'\x1b\[[0-9;]*m', '', suite_messages), timed_out


def verdict(code, tests, titles, must_fail, suite_messages, timed_out):
    """RED, MISS or INCONCLUSIVE, with the reason (see the module docstring)."""
    failing = [t for t in tests if t['status'] == 'failed']
    messages = re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(m for t in failing for m in t.get('failureMessages', [])))
    if timed_out:
        return 'INCONCLUSIVE', f'the runner exceeded {SUITE_RUN_TIMEOUT_SECONDS} s'
    if not tests:
        return 'INCONCLUSIVE', 'no structured assertions: the suite wrote no JSON'
    if {t['title'] for t in tests} != titles:
        return 'INCONCLUSIVE', 'the suite did not run the tests the baseline ran'
    for reason, pattern in NOT_MEASURED:
        if re.search(pattern, messages + suite_messages):
            return 'INCONCLUSIVE', reason
    thrown = [t for t in failing if 'expect(' not in '\n'.join(t.get('failureMessages', []))]
    if thrown:
        return 'INCONCLUSIVE', f'{len(thrown)} test(s) failed by a thrown error, not an assertion'
    failed = {t['title'] for t in failing}
    if code != 0 and failed == must_fail:
        return 'RED', 'exactly the declared tests failed, each at an assertion'
    if not failed:
        return 'MISS', 'no test failed'
    return 'MISS', f'{len(failed & must_fail)} of {len(must_fail)} declared and {len(failed - must_fail)} undeclared tests failed'


def inconclusive(what, reason):
    print(f'INCONCLUSIVE {what}: {reason}. The suite never reached its declared assertions, so this run is '
          f'no verdict; re-run the drill.', flush=True)
    raise SystemExit(INCONCLUSIVE_EXIT)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--describe', action='store_true')
    args = parser.parse_args()

    for _, path, anchor, replacement, _ in CONTROLS:
        once((ROOT / path).read_text(), anchor, replacement)
    if args.describe:
        print(json.dumps([{'control': c[0], 'file': c[1], 'mustFail': sorted(c[4])} for c in CONTROLS], indent=2))
        return

    require_disposable_database()
    if not args.output_dir:
        raise SystemExit('--output-dir is required')
    out = args.output_dir.resolve()
    if out == ROOT or ROOT in out.parents:
        raise SystemExit('--output-dir must lie outside the repository')
    out.mkdir(parents=True, exist_ok=False)

    before = fingerprints(ROOT)
    copy = Path(tempfile.mkdtemp(prefix='mint-ceiling-drill-'))
    receipts = []
    try:
        shutil.copytree(ROOT, copy, dirs_exist_ok=True, ignore=shutil.ignore_patterns(*IGNORED, '*.log'))
        (copy / 'backend/node_modules').symlink_to((ROOT / 'backend/node_modules').resolve(), target_is_directory=True)

        code, tests, suite_messages, timed_out = run_suite(copy, out, 'baseline')
        titles = {t['title'] for t in tests}
        state, reason = verdict(code, tests, titles, set(), suite_messages, timed_out)
        if state == 'INCONCLUSIVE':
            inconclusive('baseline', reason)
        if code != 0 or not tests or any(t['status'] != 'passed' for t in tests):
            raise SystemExit('baseline is not green')
        for _, _, _, _, must_fail in CONTROLS:
            if not must_fail <= titles:
                raise SystemExit(f'a declared test is absent from the suite: {sorted(must_fail - titles)}')

        for index, (name, path, anchor, replacement, must_fail) in enumerate(CONTROLS, start=1):
            target = copy / path
            original = target.read_text()
            target.write_text(once(original, anchor, replacement))
            try:
                code, tests, suite_messages, timed_out = run_suite(copy, out, f'control-{index}')
            finally:
                target.write_text(original)
            failed = {t['title'] for t in tests if t['status'] == 'failed'}
            state, reason = verdict(code, tests, titles, must_fail, suite_messages, timed_out)
            receipts.append({'control': name, 'file': path, 'mustFail': sorted(must_fail),
                             'failed': sorted(failed), 'red': state == 'RED', 'verdict': state, 'reason': reason})
            (out / 'receipts.json').write_text(json.dumps(receipts, indent=2))
            print(f"{'RED ' if state == 'RED' else state} {name} -> {sorted(failed)} ({reason})", flush=True)
            if state == 'INCONCLUSIVE':
                inconclusive(f'control {index} ({name})', reason)
            if state != 'RED':
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
