#!/usr/bin/env python3
"""Mutation drill for knowledge source registration (card 08792425, member N6;
the default-store design's choice C7, the core half of two-way registration).

Each control below edits ONE literal anchor in a disposable copy of the tree and
runs two backend suites, the live one against a REAL disposable PostgreSQL
through the production routers and the MCP ingress:

  backend/src/__tests__/knowledgeSourceRegistrationLive.test.ts  (routers + stored rows + the dial)
  backend/src/__tests__/knowledgeSourceRegistration.test.ts      (bundle, confirmation, gate, return bundle)

except the audit-order control (the beta.76 fix-forward), which runs only the
deterministic order suite:

  backend/src/__tests__/refusalAuditOrder.test.ts                (the denied row is written before the answer)

The live suite cannot carry that control: with the answer sent first, WHICH of
its audit reads loses the race varies from run to run, so no exact declared set
exists there. The order suite holds the audit write open and records when the
response leaves, so the same tests fail every time.

The controls withdraw one guard each, as the card names them: the step-up
(burned in the act's transaction, bound to the action and the fingerprint);
the session-only gate (every bearer, a root bearer included, refused); the
fingerprint confirmation (checked against the bundle, and recorded in the
audit row); no secret in the return bundle; and each arm of the free-reference
check (round-2 repair): a reference that resolves now, an environment entry
that is the same name after folding, and a reference any Service row records;
and the order of a refused act: its denied audit row is written before the
refusal answers.

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
    python3 scripts/knowledge-registration-mutations.py --output-dir /tmp/knowledge-registration-drill
  python3 scripts/knowledge-registration-mutations.py --describe   # checks every anchor, no database
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
    'src/__tests__/knowledgeSourceRegistrationLive.test.ts',
    'src/__tests__/knowledgeSourceRegistration.test.ts',
]
ORDER_SUITE = 'src/__tests__/refusalAuditOrder.test.ts'
ALL_SUITES = [*SUITES, ORDER_SUITE]
SERVICE = 'backend/src/services/KnowledgeSourceRegistration.ts'
ROUTE = 'backend/src/routes/knowledgeSourceRegistrations.ts'

LS = '(S) the step-up is bound to the action and the fingerprint '
LG = '(G) the gate refuses every bearer and every non-administrator, audited, nothing written '
LB = '(B) an invalid bundle or an unconfirmed fingerprint is refused by name before any step-up is spent '
LA = '(A) to (L): one registration, end to end '
UG = '(G) the gate is the authentication kind first, then root or an administrator '
UC = '(C) the fingerprint confirmation '
UR = '(R) the return bundle and the state carry public material and names only '
LK = '(K) the derived channel-credential reference must be free '
LO = '(O) the registration act answers a refusal only after its denied audit row is written '

STEP_UP = {
    LS + 'refuses a missing token with the challenge naming the action and the fingerprint',
    LS + 'refuses a token bound to another action and spends nothing',
    LS + 'refuses a token bound to another fingerprint and spends nothing',
    LS + "refuses a token bound to another Account's and spends nothing",
    LS + 'refuses a spent token on replay',
    LA + '(A) an administrator session registers the source in one act with one audit row',
}
SESSION_ONLY = {
    LG + 'a root bearer is refused on the act and on every read',
    LG + 'the legacy API key is refused on the act and on every read',
    UG + 'refuses a root bearer as a non-session',
    UG + 'refuses the legacy API key as a non-session',
}
CONFIRMATION_CHECKED = {
    LB + 'a fingerprint that does not match',
    UC + 'records how it was confirmed, and refuses a mismatch or a missing method by name',
}
CONFIRMATION_RECORDED = {
    LA + '(A) an administrator session registers the source in one act with one audit row',
}
NO_SECRET = {
    UR + 'carries the audience, the issuer, the public assertion and lifecycle keys, and no secret',
}
REFERENCE_RESOLVES = {
    LK + '(a) a reference that already resolves is refused, then the same step-up registers once the entry is gone',
    LK + '(a) the name derived from the bundle name, with no slug given, is checked the same way',
    LK + '(a) a Service deleted while its bearer stays placed cannot pass that bearer to a new endpoint under its old slug',
}
REFERENCE_ENVIRONMENT_ENTRY = {
    LK + '(b) an entry under the exact name that does not resolve (no bearer yet) is refused as an entry',
    *(LK + f'(b) an entry that is the same name after folding ({label}) is refused as an entry' for label in (
        'upper case', 'other separators', 'surrounding and inner whitespace', 'Unicode compatibility forms',
        'an invisible character')),
}
REFERENCE_SERVICE_ROW = {
    LA + '(D) duplicates are refused by name: the endpoint, the fingerprint and the slug; nothing written, nothing spent',
    *(LK + f'(c) a reference recorded by {label} is refused, whatever its slug' for label in (
        'a published Service', 'a retired Service', 'a draft Service, case and separators folded')),
}

AUDIT_BEFORE_ANSWER = {
    *(LO + f'a refusal from the act ({label}) answers only after its denied row is written' for label in (
        'an invalid bundle', 'a step-up refusal', 'a Service registry refusal', 'a lifecycle policy denial',
        'a taken channel-credential reference')),
    LO + 'the denied row carries the named details of the refusal it answers',
    LO + 'a failed denied-audit write still answers the refusal by name, after the attempt, and is logged as a warning '
         'without the caught text',
}

# (name, file, anchor, replacement, the exact set of tests that must fail)
CONTROLS = [
    ('the step-up is not burned: the act runs on any token, or none', SERVICE,
     '    const stepUp = await burnStepUp(client, { stepUpToken: input.stepUpToken, principalId: input.principalId, fingerprint: bundle.certificateSha256 });\n',
     "    const stepUp = true ? { tokenId: '00000000-0000-4000-8000-000000000000', method: 'none' }\n"
     '      : await burnStepUp(client, { stepUpToken: input.stepUpToken, principalId: input.principalId, fingerprint: bundle.certificateSha256 });\n',
     STEP_UP),
    ('the session-only gate admits a bearer', ROUTE,
     '  if (!isLoginSessionKind(req.authMethod)) {\n    return {\n',
     '  if (false && !isLoginSessionKind(req.authMethod)) {\n    return {\n',
     SESSION_ONLY),
    ('the confirmed fingerprint is not compared with the bundle', SERVICE,
     '  if (normalizeFingerprint(confirmed) !== bundle.certificateSha256) {\n',
     '  if (false && normalizeFingerprint(confirmed) !== bundle.certificateSha256) {\n',
     CONFIRMATION_CHECKED),
    ('the audit row does not record the confirmed fingerprint', SERVICE,
     '        certificateSha256: bundle.certificateSha256,\n        fingerprintConfirmation: input.confirmation,\n',
     '',
     CONFIRMATION_RECORDED),
    ('the return bundle carries the resolved channel credential', SERVICE,
     '    credentialReference: service.knowledgeCoreCredentialRef,\n    assertionKeys:',
     '    credentialReference: service.knowledgeCoreCredentialRef,\n'
     '    ...({ channelCredential: resolveChannelCredential(service.knowledgeCoreCredentialRef) } as object),\n'
     '    assertionKeys:',
     NO_SECRET),
    ('the free-reference check admits a reference that resolves now', SERVICE,
     "  if (resolveChannelCredential(reference) !== null) {\n    referenceTaken('resolves',",
     "  if (false && resolveChannelCredential(reference) !== null) {\n    referenceTaken('resolves',",
     REFERENCE_RESOLVES),
    ('the free-reference check admits an environment entry of the same folded name', SERVICE,
     '  if (entry !== undefined) {\n',
     '  if (false && entry !== undefined) {\n',
     REFERENCE_ENVIRONMENT_ENTRY),
    ('the free-reference check admits a reference another Service row records', SERVICE,
     '  if (holder) {\n',
     '  if (false && holder) {\n',
     REFERENCE_SERVICE_ROW),
    ('a refusal of the act answers before its denied audit row is written (respond first)', ROUTE,
     '  if (beforeAnswer) await beforeAnswer(code, details);\n  answer();\n',
     '  answer();\n  if (beforeAnswer) await beforeAnswer(code, details);\n',
     AUDIT_BEFORE_ANSWER),
]
# The suites a control runs, when not SUITES (see the module docstring).
CONTROL_SUITES = {
    'a refusal of the act answers before its denied audit row is written (respond first)': [ORDER_SUITE],
}

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


def run_suites(copy, out, label, suites):
    report = out / f'{label}.json'
    timed_out = False
    with (out / f'{label}.log').open('w') as log:
        try:
            code = subprocess.run(
                ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--testPathIgnorePatterns=/node_modules/',
                 '--runTestsByPath', *suites, '--json', f'--outputFile={report}'],
                cwd=copy / 'backend', stdout=log, stderr=subprocess.STDOUT, timeout=SUITE_RUN_TIMEOUT_SECONDS).returncode
        except subprocess.TimeoutExpired:
            code, timed_out = None, True
    result = json.loads(report.read_text()) if report.exists() else {}
    backend = os.path.realpath(copy / 'backend')
    tests = [dict(a, fullName=a['fullName'].strip(), suite=os.path.relpath(os.path.realpath(f.get('name', '')), backend))
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
    if set(CONTROL_SUITES) - {c[0] for c in CONTROLS}:
        raise SystemExit('a suite override names no control')
    if args.describe:
        print(json.dumps([{'control': c[0], 'file': c[1], 'suites': CONTROL_SUITES.get(c[0], SUITES), 'mustFail': sorted(c[4])}
                          for c in CONTROLS], indent=2))
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
    copy = Path(tempfile.mkdtemp(prefix='knowledge-registration-drill-'))
    receipts = []
    try:
        shutil.copytree(ROOT, copy, dirs_exist_ok=True, ignore=shutil.ignore_patterns(*IGNORED, '*.log'))
        (copy / 'backend/node_modules').symlink_to((ROOT / 'backend/node_modules').resolve(), target_is_directory=True)

        code, tests, suite_messages, timed_out = run_suites(copy, out, 'baseline', ALL_SUITES)
        state, reason = verdict(code, tests, {t['fullName'] for t in tests}, set(), suite_messages, timed_out)
        if state == 'INCONCLUSIVE':
            inconclusive('baseline', reason)
        if code != 0 or not tests or any(t['status'] != 'passed' for t in tests):
            raise SystemExit('baseline is not green')
        ran = {t['suite'] for t in tests}
        if ran != set(ALL_SUITES):
            raise SystemExit(f'the baseline did not run exactly the suites: {sorted(ran ^ set(ALL_SUITES))}')
        names_of = {}
        for name, _, _, _, must_fail in CONTROLS:
            names_of[name] = {t['fullName'] for t in tests if t['suite'] in CONTROL_SUITES.get(name, SUITES)}
            if not must_fail <= names_of[name]:
                raise SystemExit(f'a declared test is absent from the suites: {sorted(must_fail - names_of[name])}')

        for index, (name, path, anchor, replacement, must_fail) in enumerate(CONTROLS, start=1):
            names = names_of[name]
            target = copy / path
            original = target.read_text(encoding='utf-8')
            target.write_text(once(original, anchor, replacement), encoding='utf-8')
            try:
                code, tests, suite_messages, timed_out = run_suites(copy, out, f'control-{index}', CONTROL_SUITES.get(name, SUITES))
            finally:
                target.write_text(original, encoding='utf-8')
            restored = hashlib.sha256(target.read_bytes()).hexdigest() == hashlib.sha256(original.encode('utf-8')).hexdigest()
            failed = {t['fullName'] for t in tests if t['status'] == 'failed'}
            state, reason = verdict(code, tests, names, must_fail, suite_messages, timed_out)
            receipts.append({'control': name, 'file': path, 'suites': CONTROL_SUITES.get(name, SUITES), 'mustFail': sorted(must_fail),
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
