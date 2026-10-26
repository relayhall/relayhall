#!/usr/bin/env python3
"""Mutation drill for plugin availability and host-stored plugin settings
(card bedf50cc; stage 1 of the design ratified by owner ruling E380).

Each control below edits ONE literal anchor in a disposable copy of the tree and
runs three backend suites, the live one against a REAL disposable PostgreSQL
through the production routers, the host proxy and the backend effective read:

  backend/src/__tests__/pluginAvailabilityLive.test.ts  (routers + proxy + stored rows)
  backend/src/__tests__/pluginSettingsSchema.test.ts    (schema, values, resolution)
  backend/src/__tests__/pluginOwnSessionGate.test.ts    (the own-write gate, a delegated login session)

The controls withdraw what the design's section 13 names: the availability
gate at the proxy, the bridge and the registry; the Account derivation; the
lock check; the Account's own session gate and the administrator gate; and
the jti check of the backend effective read. The round-2 repair adds five:
the issuer pin and the capability re-check (N15) of the backend effective
read, the ADMINISTRATOR_ROLES narrowing (C5), the no-delegation-link
condition of the own-write gate (section 7), and the backend-only values an
Account's own save keeps (N13).

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
    python3 scripts/plugin-availability-mutations.py --output-dir /tmp/plugin-availability-drill
  python3 scripts/plugin-availability-mutations.py --describe   # checks every anchor, no database
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
    'src/__tests__/pluginAvailabilityLive.test.ts',
    'src/__tests__/pluginSettingsSchema.test.ts',
    'src/__tests__/pluginOwnSessionGate.test.ts',
]
PROXY = 'backend/src/middleware/pluginProxy.ts'
SERVICE = 'backend/src/services/PluginSettingsService.ts'
HOST = 'backend/src/routes/pluginHost.ts'
REGISTRY = 'backend/src/routes/plugins.ts'
ADMIN = 'backend/src/routes/pluginAdmin.ts'
SCHEMA = 'backend/src/services/PluginSettingsSchema.ts'
ASSERTION = 'backend/src/services/PluginAssertion.ts'

A = '(A) availability narrows, never widens '
A1 = A + 'A1 the bridge, the registry, the settings read and the proxy follow every state and switch for an Account the file allows'
A3 = A + 'A3 an explicit generate grant without view does not bypass availability on the proxy'
C = '(C) concealment '
C1 = C + 'C1 every host route answers the byte-identical 404 for unknown, legacy, file-invisible, disabled and switched-off plugins'
C2 = C + 'C2 the choice route and the eligible list find a switched-off default_on or available plugin, and nothing else about it'
C3 = C + 'C3 required answers 409 CHOICE_NOT_ALLOWED; a kept choice applies again when the state returns'
R = '(R) resolution across the three layers '
R2 = R + 'R2 a lock overrides the Account value and keeps it stored; unlocking restores it'
R3 = R + ("R3 a save from the form keeps the Account's own deliver: backend value; naming the key validates and replaces it, "
          'null removes it (N13)')
E = '(E) the plugin backend effective-settings read '
E2 = E + 'E2 refuses a wrong audience, an expired token, a wrong algorithm, alg none, a forged signature and a wrong issuer'
E3 = E + 'E3 refuses a validly signed token whose jti the core never issued for that sub'
E7 = E + 'E7 an assertion whose capability the installation file no longer grants is refused within its lifetime (N15)'
G = '(G) the administrator gate '
G1 = G + 'G1 an admin and an operator session write with a step-up; an editor and an orchestrator session are refused and audited'
G2 = G + 'G2 a root bearer, an Account bearer and the API key are refused as non-sessions (C11), reads included'
G4 = G + 'G4 administrator reads need the session check only'
U1 = "(U) the Account's own session gate U1 the Account's own writes need its own login session: a bearer and a delegated Connector are refused SESSION_ONLY"
X1 = "(X) isolation X1 one Account never reads or writes another's values or choices; no parameter names an Account (outside-anchor read)"
S = 'plugin settings resolution with locks (card bedf50cc, design section 5) '
S_LOCK = S + 'a locked key ignores the Account value, and unlocking restores it'
S_LOCK_DEFAULT = S + 'a locked key with no deployment value answers the default, still locked'
OWN = ("the Account's own plugin-write gate (card bedf50cc, design section 7) admits the Account's own login session, "
       'and refuses the same session carrying a delegation link SESSION_ONLY, audited')

# (name, file, anchor, replacement, the exact set of tests that must fail)
CONTROLS = [
    ('the proxy no longer ANDs availability', PROXY,
     '        if (!(await pluginAvailableTo(plugin, account))) {\n',
     '        if (false && !(await pluginAvailableTo(plugin, account))) {\n',
     {A1, A3, C1}),
    ('the bridge no longer ANDs availability', HOST,
     "    if (!availability.enabled) { res.status(404).json({code:'PLUGIN_NOT_FOUND'}); return; }\n",
     '',
     {A1, C1, C2, C3, X1}),
    ('the registry no longer ANDs availability', REGISTRY,
     '      && availability.get(entry.name)?.enabled === true);\n',
     '      && (availability.get(entry.name)?.enabled === true || true));\n',
     {A1, C1}),
    ('the Account follows a caller-supplied parameter', HOST,
     '  const account = await activePluginAccount(req as AuthRequest);\n  if (!plugin?.manifest',
     "  const account = (typeof req.query.account === 'string' && req.query.account) || await activePluginAccount(req as AuthRequest);\n  if (!plugin?.manifest",
     {X1}),
    ('the lock check is dropped at resolution', SCHEMA,
     "(declaration.scope === 'account_overridable' && !isLocked))",
     "(declaration.scope === 'account_overridable'))",
     {R2, S_LOCK, S_LOCK_DEFAULT}),
    ("the Account's own session gate admits any caller of the Account", HOST,
     '  if (isLoginSessionKind(req.authMethod) && req.principal?.id && !(req.delegationLinks?.length)) {\n',
     '  if ((isLoginSessionKind(req.authMethod) || true) && req.principal?.id) {\n',
     {U1, OWN}),
    ('the administrator gate admits any caller', ADMIN,
     '  if (standing.ok) return true;\n',
     '  if (standing.ok) return true;\n  if (standing.code) return true;\n',
     {G1, G2, G4}),
    ('the jti check of the backend effective read is dropped', ASSERTION,
     '  if (!issuedEntry || issuedEntry.plugin !== pluginName || issuedEntry.sub !== sub || issuedEntry.capability !== capability) return null;\n',
     '  if (false && !issuedEntry) return null;\n',
     {E3}),
    # Round 2 (the review's four green-under-mutation gaps, and N13).
    ('the issuer pin of the backend effective read is dropped', ASSERTION,
     "    claims = jwt.verify(token, key, { algorithms: ['HS256'], issuer: 'relayhall', audience: pluginName });\n",
     "    claims = jwt.verify(token, key, { algorithms: ['HS256'], audience: pluginName });\n",
     {E2}),
    ("the backend effective read no longer re-checks the assertion's capability (N15)", HOST,
     '    if (!pluginAccountCan(plugin.config, sub, capability)) { sendPluginNotFound(res); return; }\n',
     '    if (!pluginAccountCan(plugin.config, sub, capability) && false) { sendPluginNotFound(res); return; }\n',
     {E7}),
    ('the administrator gate admits every role-change issuer role, orchestrator included (no ADMINISTRATOR_ROLES narrowing, C5)', ADMIN,
     '  if (!ADMINISTRATOR_ROLES.includes(outcome.issuerRole)) {\n',
     "  if (![...ADMINISTRATOR_ROLES, 'orchestrator'].includes(outcome.issuerRole)) {\n",
     {G1}),
    ("the Account's own session gate admits a login session carrying a delegation link", HOST,
     '  if (isLoginSessionKind(req.authMethod) && req.principal?.id && !(req.delegationLinks?.length)) {\n',
     '  if (isLoginSessionKind(req.authMethod) && req.principal?.id) {\n',
     {OWN}),
    ("an Account's own save no longer keeps its stored deliver: backend values (N13)", SERVICE,
     '      const after = { ...sent, ...keptBackend, ...kept };\n',
     '      const after = { ...sent, ...(false ? keptBackend : {}), ...kept };\n',
     {R3}),
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
    copy = Path(tempfile.mkdtemp(prefix='plugin-availability-drill-'))
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
