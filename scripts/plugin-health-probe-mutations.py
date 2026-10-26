#!/usr/bin/env python3
"""Mutation drill for the plugin health probe (card fa519c4c, subtask 2085337).

The plugin loader's health check names the installation and classifies every
outcome with a closed, secret-free code (services/PluginHealthProbe.ts and the
loader's recordHealthOutcome). Each guard on that path has one control below,
which edits ONE literal anchor in a disposable copy of the tree and runs the
suites that pin the guard (jest, no database):

  backend  src/__tests__/pluginHealthProbe.test.ts          (real sockets, real fetch, recorded bodies)
  backend  src/__tests__/pluginInstallationRoutes.test.ts   (the loader pin: a redirect is never followed)

  cause-code      the fetch failure's cause code is not read (every refusal is TRANSPORT_OTHER)
  cause-getter    the cause is read through a getter-capable access, not an own data property
  timeout-flag    a request that outlives the bound is not a timeout
  redirect-named  a 3xx is reported as a plain non-2xx instead of a redirect
  redirect-follow the probe follows a redirect
  unhealthy-words a 2xx whose own status says degraded or error still counts as healthy
  ok-words        the GPU Gateway's recorded status word "healthy" is not an ok word
  shape-healthy   an undocumented 2xx body marks the plugin unhealthy
  body-bound      the body read has no size bound
  name-in-line    the log line does not name the installation
  address-in-line the log line carries the manifest's address (a host and port)
  repeat-log      an unchanged failure is logged on every tick
  restore-log     a recovery is not announced
  status-text     a non-2xx loses the status number the registry has always shown

Each run gets one of three verdicts:
  RED           every test ran, and exactly the declared tests failed, each at
                an assertion (jest's expect()).
  MISS          every test ran to an assertion, and the failed set is not the
                declared set (none failed, or others did).
  INCONCLUSIVE  the suites did not reach the declared assertions (a timeout, a
                suite that did not load, a test that failed by a thrown error).
                No verdict on the control; the drill still fails (exit status 3).
Every control declares a different set, so no two can be satisfied by one
assertion. The source tree is never edited: its bytes are fingerprinted before
and after.

The backend dependencies must be installed (`npm ci` in backend/); the copy links
that node_modules directory.

Usage (from the repository root):
  python3 scripts/plugin-health-probe-mutations.py --output-dir /tmp/plugin-health-probe-drill
  python3 scripts/plugin-health-probe-mutations.py --describe   # checks every anchor, runs nothing
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

ROOT = Path(__file__).resolve().parents[1]
IGNORED = ('.git', 'node_modules', 'dist', 'coverage', '.pytest_cache', '__pycache__')
SUITE_RUN_TIMEOUT_SECONDS = 900
INCONCLUSIVE_EXIT = 3

PROBE = 'backend/src/services/PluginHealthProbe.ts'
LOADER = 'backend/src/services/PluginLoader.ts'
BACKEND_SUITES = ['src/__tests__/pluginHealthProbe.test.ts', 'src/__tests__/pluginInstallationRoutes.test.ts']

# Tests by file and full name (describe blocks and title). Each declared name is exactly one test of its
# file (checked at baseline); the inventory is compared as a multiset.
P = 'src/__tests__/pluginHealthProbe.test.ts'
I = 'src/__tests__/pluginInstallationRoutes.test.ts'
CLS = 'classifyHealthTransportFailure: typed markers only '
REAL = 'probePluginHealth against real sockets '
INT = 'interpretHealthAnswer: the documented and the recorded shapes '
LDR = 'the loader names the installation and logs only closed codes '

INST = 'installation namespace and health destination safety '

# (name, file, anchor, replacement, tests that must fail)
CONTROLS = [
    ('cause-code', PROBE,
     "      const code = ownDataProperty(carrier as object, 'code');\n",
     "      const code: unknown = undefined;\n",
     {(P, CLS + 'cause code EAI_AGAIN is HOST_NOT_FOUND'),
      (P, CLS + 'cause code ECONNREFUSED is CONNECTION_REFUSED'),
      (P, CLS + 'cause code ECONNRESET is CONNECTION_RESET'),
      (P, CLS + 'cause code EHOSTUNREACH is HOST_UNREACHABLE'),
      (P, CLS + 'cause code ENOTFOUND is HOST_NOT_FOUND'),
      (P, CLS + 'cause code UND_ERR_CONNECT_TIMEOUT is CONNECT_TIMEOUT'),
      (P, CLS + 'cause code UND_ERR_SOCKET is SOCKET_CLOSED'),
      (P, LDR + 'a refusing plugin is named, classified, unhealthy, and the TypeError line is gone'),
      (P, LDR + 'an unchanged failure is logged once, not on every tick, and a changed one is logged again'),
      (P, REAL + 'a refused connection is a named transport failure, not an anonymous TypeError'),
      (P, REAL + 'a socket destroyed before any answer is a named transport failure')}),
    ('cause-getter', PROBE,
     "    let carrier: unknown = ownDataProperty(caught, 'cause');\n",
     "    let carrier: unknown = (caught as { cause?: unknown }).cause;\n",
     {(P, CLS + 'never runs a getter on the caught value and never throws')}),
    ('timeout-flag', PROBE,
     "  if (timedOut) return { healthy: false, kind: 'timeout', detail: 'REQUEST_TIMEOUT' };\n",
     "  if (timedOut && (false as boolean)) return { healthy: false, kind: 'timeout', detail: 'REQUEST_TIMEOUT' };\n",
     {(P, CLS + 'the probe timer flag decides a timeout, whatever was thrown'),
      (P, REAL + 'a body that stalls after the headers is a timeout, not a hang'),
      (P, REAL + 'a server that never answers is a timeout at the bound')}),
    ('redirect-named', PROBE,
     "  if (status >= 300 && status < 400) return {",
     "  if (false as boolean) return {",
     {(P, INT + 'a 301 is a redirect that is named, not followed'),
      (P, INT + 'a 302 is a redirect that is named, not followed'),
      (P, INT + 'a 308 is a redirect that is named, not followed'),
      (P, REAL + 'a redirect is named and never followed')}),
    ('redirect-follow', PROBE,
     "        redirect: 'manual',\n",
     "        redirect: 'follow',\n",
     {(I, INST + 'pins the health origin and never follows a redirect (a 3xx is handed back and named)'),
      (P, REAL + 'a redirect is named and never followed')}),
    ('unhealthy-words', PROBE,
     "  'error', 'unhealthy', 'down', 'fail', 'failed', 'failing', 'unavailable', 'degraded',\n",
     "  'zzz-never-served',\n",
     {(P, INT + 'a 200 whose status word is FAILED is a plugin-reported failure'),
      (P, INT + 'a 200 whose status word is degraded is a plugin-reported failure'),
      (P, INT + 'a 200 whose status word is down is a plugin-reported failure'),
      (P, INT + 'a 200 whose status word is error is a plugin-reported failure'),
      (P, INT + 'a 200 whose status word is unhealthy is a plugin-reported failure'),
      (P, LDR + 'logs no host, port, address, body, header or message text'),
      (P, REAL + 'a 200 that states itself degraded is plugin-reported')}),
    ('ok-words', PROBE,
     "['ok', 'healthy', 'up', 'pass', 'passing', 'ready']",
     "['ok', 'up', 'pass', 'passing', 'ready']",
     {(P, INT + 'GPU Gateway answers a healthy 200 with no shape note'),
      (P, LDR + 'the recorded Orb, Usage Limits, Content Engine and GPU Gateway answers log nothing and stay healthy'),
      (P, REAL + 'the recorded GPU Gateway answer is healthy')}),
    ('shape-healthy', PROBE,
     "({ healthy: true, kind: 'shape', detail, httpStatus: status })",
     "({ healthy: false, kind: 'shape', detail, httpStatus: status })",
     {(P, INT + 'a bare string on a 200 is a named shape outcome that stays healthy'),
      (P, INT + 'a boolean status on a 200 is a named shape outcome that stays healthy'),
      (P, INT + 'a list on a 200 is a named shape outcome that stays healthy'),
      (P, INT + 'an empty body on a 200 is a named shape outcome that stays healthy'),
      (P, INT + 'an object without status on a 200 is a named shape outcome that stays healthy'),
      (P, INT + 'an unknown status word on a 200 is a named shape outcome that stays healthy'),
      (P, INT + 'an unread oversized 200 stays healthy and is named'),
      (P, INT + 'plain text ok on a 200 is a named shape outcome that stays healthy'),
      (P, LDR + 'a 200 with an undocumented body is named as a warning and the plugin stays healthy'),
      (P, REAL + 'a body over the read bound stays healthy and is not buffered whole'),
      (P, REAL + 'a plain-text ok is healthy with a named shape note')}),
    ('body-bound', PROBE,
     "        if (total > limit) {",
     "        if (total > limit * 1000000) {",
     {(P, REAL + 'a body over the read bound stays healthy and is not buffered whole')}),
    ('name-in-line', LOADER,
     "    const label = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(plugin.name) ? plugin.name : 'unnamed';\n",
     "    const label = 'unnamed';\n",
     {(P, LDR + 'a 200 with an undocumented body is named as a warning and the plugin stays healthy'),
      (P, LDR + 'a non-2xx keeps the number the registry has always shown'),
      (P, LDR + 'a refusing plugin is named, classified, unhealthy, and the TypeError line is gone'),
      (P, LDR + 'an unchanged failure is logged once, not on every tick, and a changed one is logged again'),
      (P, LDR + 'logs no host, port, address, body, header or message text'),
      (P, LDR + 'recovery is announced once and clears the error')}),
    ('address-in-line', LOADER,
     "    const describe = `plugin=${label} kind=${outcome.kind}",
     "    const describe = `plugin=${label}@${plugin.manifest.name}:${plugin.manifest.api.internal_port} kind=${outcome.kind}",
     {(P, LDR + 'a 200 with an undocumented body is named as a warning and the plugin stays healthy'),
      (P, LDR + 'a non-2xx keeps the number the registry has always shown'),
      (P, LDR + 'a refusing plugin is named, classified, unhealthy, and the TypeError line is gone'),
      (P, LDR + 'an unchanged failure is logged once, not on every tick, and a changed one is logged again'),
      (P, LDR + 'logs no host, port, address, body, header or message text')}),
    ('repeat-log', LOADER,
     "    const due = !same || (plugin.healthRepeats! % HEALTH_REPEAT_LOG_EVERY === 0);\n",
     "    const due = !same || true || (plugin.healthRepeats! % HEALTH_REPEAT_LOG_EVERY === 0);\n",
     {(P, LDR + 'an unchanged failure is logged again every 30th tick'),
      (P, LDR + 'an unchanged failure is logged once, not on every tick, and a changed one is logged again')}),
    ('restore-log', LOADER,
     "      if (previous && !(previous.healthy && previous.kind === 'ok')) console.log(",
     "      if (false as boolean) console.log(",
     {(P, LDR + 'recovery is announced once and clears the error')}),
    ('status-text', LOADER,
     "outcome.kind === 'plugin_reported' && outcome.detail === 'HTTP_STATUS_NOT_OK'\n",
     "outcome.kind === 'plugin_reported' && outcome.detail === 'NONE'\n",
     {(P, LDR + 'a non-2xx keeps the number the registry has always shown')}),
]


def once(text, anchor, replacement):
    count = text.count(anchor)
    if count != 1:
        raise SystemExit(f'anchor matched {count} times, expected 1: {anchor[:100]!r}')
    return text.replace(anchor, replacement, 1)


def fingerprints(tree):
    found = {}
    for directory, subdirectories, files in os.walk(tree):
        subdirectories[:] = [d for d in subdirectories if d not in IGNORED]
        for file in files:
            path = Path(directory) / file
            if path.is_file() and not path.is_symlink():
                found[str(path.relative_to(tree))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return found


def run_jest(copy, out, label):
    report = out / f'{label}-jest.json'
    cwd = copy / 'backend'
    command = ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--runTestsByPath', *BACKEND_SUITES,
               '--json', f'--outputFile={report}']
    env = {k: v for k, v in os.environ.items() if not k.startswith('DB_') and k != 'RELAYHALL_TEST_DB_URL'}
    env.update(NODE_ENV='test', CI='true')
    timed_out = False
    with (out / f'{label}-jest.log').open('w') as log:
        try:
            code = subprocess.run(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT,
                                  timeout=SUITE_RUN_TIMEOUT_SECONDS).returncode
        except subprocess.TimeoutExpired:
            code, timed_out = None, True
    result = json.loads(report.read_text()) if report.exists() else {}
    tests = []
    for suite in result.get('testResults', []):
        relative = os.path.relpath(suite['name'], cwd)
        for assertion in suite.get('assertionResults', []):
            tests.append({'key': (relative, (assertion.get('fullName') or assertion['title']).strip()), 'status': assertion['status'],
                          'failureMessages': assertion.get('failureMessages') or []})
    suite_messages = ' '.join(str(s.get('message', '')) for s in result.get('testResults', []))
    if result.get('numRuntimeErrorTestSuites', 0) or result.get('testExecError'):
        suite_messages += ' runtime-error-suite'
    return code, tests, re.sub(r'\x1b\[[0-9;]*m', '', suite_messages), timed_out


def at_assertion(messages):
    """A failure at an assertion: jest prints the matcher call (`expect(`). A thrown error
    (`TypeError: ...`, `x is not a function`) does not."""
    text = re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(messages))
    return bool(text) and 'expect(' in text


def verdict(code, tests, names, must_fail, suite_messages, timed_out):
    failing = [t for t in tests if t['status'] == 'failed']
    if timed_out:
        return 'INCONCLUSIVE', f'the runner exceeded {SUITE_RUN_TIMEOUT_SECONDS} s'
    if not tests:
        return 'INCONCLUSIVE', 'no structured assertions: the runner wrote no JSON'
    if [t['key'] for t in tests if t['status'] != 'passed' and t['status'] != 'failed']:
        return 'INCONCLUSIVE', 'a test was skipped or left pending'
    if sorted(t['key'] for t in tests) != sorted(names):
        return 'INCONCLUSIVE', 'the suites did not run the tests the baseline ran'
    if 'runtime-error-suite' in suite_messages or 'Test suite failed to run' in suite_messages:
        return 'INCONCLUSIVE', 'a suite did not load'
    thrown = [t for t in failing if not at_assertion(t['failureMessages'])]
    if thrown:
        return 'INCONCLUSIVE', f'{len(thrown)} test(s) failed by a thrown error, not an assertion'
    failed = {t['key'] for t in failing}
    if code not in (0, None) and failed == must_fail:
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
    parser.add_argument('--discover', action='store_true',
                        help='run every control and print the tests it reddens, without judging them')
    args = parser.parse_args()

    for _, path, anchor, replacement, _ in CONTROLS:
        once((ROOT / path).read_text(encoding='utf-8'), anchor, replacement)
    sets = [frozenset(c[4]) for c in CONTROLS]
    if not args.discover and not args.describe and (len(set(sets)) != len(sets) or not all(sets)):
        raise SystemExit('two controls declare the same set of tests, or one declares none')
    if args.describe:
        print(json.dumps([{'control': c[0], 'file': c[1], 'mustFail': sorted(map(list, c[4]))}
                          for c in CONTROLS], indent=2))
        return

    if not (ROOT / 'backend' / 'node_modules' / 'jest/bin/jest.js').is_file():
        raise SystemExit('backend/node_modules is missing: run npm ci in backend/ first')
    if not args.output_dir:
        raise SystemExit('--output-dir is required')
    out = args.output_dir.resolve()
    if out == ROOT or ROOT in out.parents:
        raise SystemExit('--output-dir must lie outside the repository')
    out.mkdir(parents=True, exist_ok=False)

    before = fingerprints(ROOT)
    copy = Path(tempfile.mkdtemp(prefix='plugin-health-probe-drill-'))
    receipts = []
    try:
        shutil.copytree(ROOT, copy, dirs_exist_ok=True, ignore=shutil.ignore_patterns(*IGNORED))
        (copy / 'backend' / 'node_modules').symlink_to((ROOT / 'backend' / 'node_modules').resolve(), target_is_directory=True)

        code, tests, suite_messages, timed_out = run_jest(copy, out, 'baseline')
        names = [t['key'] for t in tests]
        state, reason = verdict(code, tests, names, set(), suite_messages, timed_out)
        if state == 'INCONCLUSIVE':
            inconclusive('baseline', reason)
        if code != 0 or any(t['status'] != 'passed' for t in tests):
            raise SystemExit('baseline is not green')
        baseline = names
        for name, _, _, _, must_fail in CONTROLS:
            for key in must_fail:
                if baseline.count(key) != 1:
                    raise SystemExit(f'{name}: declared test {key!r} is not exactly one test of its file')

        for index, (name, path, anchor, replacement, must_fail) in enumerate(CONTROLS, start=1):
            target = copy / path
            original = target.read_text(encoding='utf-8')
            target.write_text(once(original, anchor, replacement), encoding='utf-8')
            try:
                code, tests, suite_messages, timed_out = run_jest(copy, out, f'control-{index}')
            finally:
                target.write_text(original, encoding='utf-8')
            failed = {t['key'] for t in tests if t['status'] == 'failed'}
            if args.discover:
                print(json.dumps({name: sorted([('P' if k[0] == P else 'I'), k[1]] for k in failed)}), flush=True)
                continue
            state, reason = verdict(code, tests, baseline, must_fail, suite_messages, timed_out)
            receipts.append({'control': name, 'file': path,
                             'mustFail': sorted(map(list, must_fail)), 'failed': sorted(map(list, failed)),
                             'red': state == 'RED', 'verdict': state, 'reason': reason})
            (out / 'receipts.json').write_text(json.dumps(receipts, indent=2))
            print(f"{'RED ' if state == 'RED' else state} {name} -> {len(failed)} failed ({reason})", flush=True)
            if state == 'INCONCLUSIVE':
                inconclusive(f'control {index} ({name})', reason)
            if state != 'RED':
                for key in sorted(failed ^ must_fail):
                    print(f"   {'undeclared' if key in failed else 'missing'}: {key[0]} :: {key[1]}", flush=True)
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
