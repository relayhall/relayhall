#!/usr/bin/env python3
"""Mutation drill for the sidebar widget grow opt-in (owner ruling E438(1), card d1471ea9).

`ui.sidebar_widget.grow: true` lets a plugin sidebar widget take the content
height its own frame reports, up to the host ceiling of 1600 px. Each guard on
that path has one control below, which edits ONE literal anchor in a disposable
copy of the tree and runs the suites that pin the guard (no database):

  frontend  src/components/PluginSidebarWidget.test.tsx   (vitest)
  backend   src/__tests__/pluginHostContract.test.ts       (jest, contract units)
  backend   src/__tests__/pluginInstallationRoutes.test.ts (jest, real loader and registry)

  grow-opt-in     every widget grows, not only one that declares grow: true
  grow-ceiling    an opted-in widget takes any reported height (no host ceiling)
  resize-origin   a resize message is honoured without the origin and source-window check
  grow-boolean    a grow that is not a boolean loads
  grow-exposure   the registry never carries grow: true to the dashboard

Each run gets one of three verdicts:
  RED           every test ran, and exactly the declared tests failed, each at
                an assertion (jest's expect(), or vitest's chai message).
  MISS          every test ran to an assertion, and the failed set is not the
                declared set (none failed, or others did).
  INCONCLUSIVE  the suites did not reach the declared assertions (a timeout, a
                suite that did not load, a test that failed by a thrown error).
                No verdict on the control; the drill still fails (exit status 3).
Every control declares a different set, so no two can be satisfied by one
assertion. The source tree is never edited: its bytes are fingerprinted before
and after.

The frontend and backend dependencies must be installed (`npm ci` in each);
the copy links those node_modules directories.

Usage (from the repository root):
  python3 scripts/plugin-widget-grow-mutations.py --output-dir /tmp/plugin-widget-grow-drill
  python3 scripts/plugin-widget-grow-mutations.py --describe   # checks every anchor, runs nothing
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

WIDGET = 'frontend/src/components/PluginSidebarWidget.tsx'
CONTRACT = 'backend/src/services/PluginHostContract.ts'
LOADER = 'backend/src/services/PluginLoader.ts'
FRONTEND_SUITES = ['src/components/PluginSidebarWidget.test.tsx']
BACKEND_SUITES = ['src/__tests__/pluginHostContract.test.ts', 'src/__tests__/pluginInstallationRoutes.test.ts']

# Tests by file and full name (describe blocks and title). Each declared name is exactly one test of its
# file (checked at baseline); the inventory is compared as a multiset, since an it.each elsewhere in a
# suite may print two cases under one name.
W = 'src/components/PluginSidebarWidget.test.tsx'
C = 'src/__tests__/pluginHostContract.test.ts'
I = 'src/__tests__/pluginInstallationRoutes.test.ts'
W_FALLBACK = 'unchanged plugins keep manifest fallback; valid messages shrink and grow within declaration'
W_BOUNDS = 'manifest bounds remain enforced even when the plugin requests more space'
W_NO_OPT_IN = 'grow (E438): without the opt-in a 565 px report stays clamped at the declared height and 240'
W_OPT_IN_CHANGE = 'grow (E438): changing the opt-in replaces the frame at its declared height'
W_CEILING = 'grow (E438): a report above the 1600 px host ceiling is clamped, never trusted'
W_REJECTS = 'rejects invalid numbers, payloads, origins and source windows'
W_OWN_FRAME = 'each iframe accepts only its own resize messages'
W_RESET = 'identity, URL and manifest changes reset fallback and detach old iframe'
W_FOREIGN = 'grow (E438): malformed and foreign reports are ignored'
C_REFUSE = 'sidebar widget grow opt-in (E438) refuses a grow that is not a boolean ({}) by the sidebar widget reason code'
I_EXPOSE = ('installation namespace and health destination safety exposes the sidebar widget grow opt-in to the '
            'dashboard only when it is true (true)')

CONTROLS = [
    ('grow-opt-in', 'vitest', WIDGET,
     '  const grow = plugin.sidebar_widget.grow === true;\n',
     '  const grow = true;\n',
     {(W, W_FALLBACK), (W, W_BOUNDS), (W, W_NO_OPT_IN), (W, W_OPT_IN_CHANGE)}),
    ('grow-ceiling', 'vitest', WIDGET,
     '  const ceiling = grow ? SIDEBAR_WIDGET_GROW_CEILING : declared;\n',
     '  const ceiling = grow ? Number.POSITIVE_INFINITY : declared;\n',
     {(W, W_CEILING)}),
    ('resize-origin', 'vitest', WIDGET,
     "      if (!trustedPluginMessage(event, node) || event.data?.type !== 'iframeResize') return;\n",
     "      if (event.data?.type !== 'iframeResize') return;\n",
     {(W, W_REJECTS), (W, W_OWN_FRAME), (W, W_RESET), (W, W_FOREIGN)}),
    ('grow-boolean', 'jest', CONTRACT,
     "if (widget && widget.grow !== undefined && typeof widget.grow !== 'boolean') throw",
     'if (false) throw',
     {(C, C_REFUSE.format(label)) for label in ('the string true', 'one', 'zero', 'null', 'an object', 'a list')}),
    ('grow-exposure', 'jest', LOADER,
     '  return grow === true ? { ...declared, grow: true } : declared;\n',
     '  return grow === true ? declared : declared;\n',
     {(I, I_EXPOSE)}),
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


def run_runner(copy, out, label, runner):
    report = out / f'{label}-{runner}.json'
    if runner == 'vitest':
        cwd, command = copy / 'frontend', ['node', 'node_modules/vitest/vitest.mjs', 'run', *FRONTEND_SUITES,
                                           '--reporter=json', f'--outputFile={report}']
    else:
        cwd, command = copy / 'backend', ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--runTestsByPath',
                                          *BACKEND_SUITES, '--json', f'--outputFile={report}']
    env = {k: v for k, v in os.environ.items() if not k.startswith('DB_') and k != 'RELAYHALL_TEST_DB_URL'}
    env.update(NODE_ENV='test', CI='true')
    timed_out = False
    with (out / f'{label}-{runner}.log').open('w') as log:
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
    """A failure at an assertion: jest prints the matcher call (`expect(`); vitest's JSON
    reporter gives the chai message alone (`expected '500px' to be '176px'`). A thrown
    error (`TypeError: ...`, `x is not a function`) matches neither."""
    text = re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(messages))
    return bool(text) and ('expect(' in text or 'AssertionError' in text or re.match(r'\s*expected\b', text) is not None)


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
    args = parser.parse_args()

    for _, _, path, anchor, replacement, _ in CONTROLS:
        once((ROOT / path).read_text(encoding='utf-8'), anchor, replacement)
    sets = [frozenset(c[5]) for c in CONTROLS]
    if len(set(sets)) != len(sets) or not all(sets):
        raise SystemExit('two controls declare the same set of tests, or one declares none')
    if args.describe:
        print(json.dumps([{'control': c[0], 'runner': c[1], 'file': c[2], 'mustFail': sorted(map(list, c[5]))}
                          for c in CONTROLS], indent=2))
        return

    for side, entry in (('frontend', 'vitest/vitest.mjs'), ('backend', 'jest/bin/jest.js')):
        if not (ROOT / side / 'node_modules' / entry).is_file():
            raise SystemExit(f'{side}/node_modules is missing: run npm ci in {side}/ first')
    if not args.output_dir:
        raise SystemExit('--output-dir is required')
    out = args.output_dir.resolve()
    if out == ROOT or ROOT in out.parents:
        raise SystemExit('--output-dir must lie outside the repository')
    out.mkdir(parents=True, exist_ok=False)

    before = fingerprints(ROOT)
    copy = Path(tempfile.mkdtemp(prefix='plugin-widget-grow-drill-'))
    receipts = []
    try:
        shutil.copytree(ROOT, copy, dirs_exist_ok=True, ignore=shutil.ignore_patterns(*IGNORED))
        for side in ('frontend', 'backend'):
            (copy / side / 'node_modules').symlink_to((ROOT / side / 'node_modules').resolve(), target_is_directory=True)

        baseline = {}
        for runner in ('vitest', 'jest'):
            code, tests, suite_messages, timed_out = run_runner(copy, out, 'baseline', runner)
            names = [t['key'] for t in tests]
            state, reason = verdict(code, tests, names, set(), suite_messages, timed_out)
            if state == 'INCONCLUSIVE':
                inconclusive(f'baseline ({runner})', reason)
            if code != 0 or any(t['status'] != 'passed' for t in tests):
                raise SystemExit(f'baseline is not green ({runner})')
            baseline[runner] = names
        for name, runner, _, _, _, must_fail in CONTROLS:
            for key in must_fail:
                if baseline[runner].count(key) != 1:
                    raise SystemExit(f'{name}: declared test {key!r} is not exactly one test of its file')

        for index, (name, runner, path, anchor, replacement, must_fail) in enumerate(CONTROLS, start=1):
            target = copy / path
            original = target.read_text(encoding='utf-8')
            target.write_text(once(original, anchor, replacement), encoding='utf-8')
            try:
                code, tests, suite_messages, timed_out = run_runner(copy, out, f'control-{index}', runner)
            finally:
                target.write_text(original, encoding='utf-8')
            failed = {t['key'] for t in tests if t['status'] == 'failed'}
            state, reason = verdict(code, tests, baseline[runner], must_fail, suite_messages, timed_out)
            receipts.append({'control': name, 'runner': runner, 'file': path,
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
