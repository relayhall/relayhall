#!/usr/bin/env python3
"""Mutation drill for the plugin deployment view default (card 8fe6d7bb).

`access.default: ["view"]` in the deployment plugin file gives every active
Account view of an installation. It must never satisfy a non-view capability,
never admit a write through the host proxy, never make the registry describe an
Account as write-capable (for the plugin or for one settings entry, card
bedf50cc), never show a non-view settings entry, never load in a
malformed shape, never count when its stored shape is wrong, and never reach a
request without an active Account.

Each control below edits ONE literal anchor in a disposable copy of the tree and
runs four jest suites (no database):

  backend/src/__tests__/pluginHostContract.test.ts        (contract units)
  backend/src/__tests__/pluginHostProxy.test.ts           (host proxy over HTTP)
  backend/src/__tests__/pluginInstallationRoutes.test.ts  (registry and settings filter)
  backend/src/__tests__/pluginViewDefault.test.ts         (real file, loader, registry,
                                                           bridge and proxy, live upstream)

Each run gets one of three verdicts:
  RED           every test ran, and exactly the declared tests failed, each at
                an expect().
  MISS          every test ran to an assertion, and the failed set is not the
                declared set (none failed, or others did).
  INCONCLUSIVE  the suites did not reach the declared assertions (a timeout, a
                compile error, a suite that did not load, a test that failed by
                a thrown error). No verdict on the control; the drill still
                fails (exit status 3).
Every control declares a different set, so no two can be satisfied by one
assertion. The source tree is never edited: its bytes are fingerprinted before
and after.

The backend dependencies must be installed (`npm ci` in backend/); the copy
links that node_modules directory.

Usage (from the repository root):
  python3 scripts/plugin-view-default-mutations.py --output-dir /tmp/plugin-view-default-drill
  python3 scripts/plugin-view-default-mutations.py --describe   # checks every anchor, runs nothing
"""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SUITES = [
    'src/__tests__/pluginHostContract.test.ts',
    'src/__tests__/pluginHostProxy.test.ts',
    'src/__tests__/pluginInstallationRoutes.test.ts',
    'src/__tests__/pluginViewDefault.test.ts',
]
CONTRACT = 'backend/src/services/PluginHostContract.ts'
PROXY = 'backend/src/middleware/pluginProxy.ts'
ROUTES = 'backend/src/routes/plugins.ts'

UNIT = 'deployment view default (card 8fe6d7bb) '
U_VIEW_ONLY = UNIT + 'the default grants view to every Account and never a non-view capability'
U_EXPLICIT = UNIT + 'the per-Account list still grants non-view capabilities explicitly, and without a default it is exact'
U_NO_WRITE = UNIT + 'the default never makes the host proxy write description true'
U_USE_TIME = UNIT + 'a default that bypassed load validation is ignored at use time'
U_NO_ACCOUNT = UNIT + 'the default never reaches a request without an active Account'
U_REFUSE = UNIT + 'refuses a malformed default at load: '
LIVE = 'deployment view default through the loader, registry, bridge and proxy (card 8fe6d7bb) '
L_LIST = LIVE + 'lists a default-view installation to an Account with no entry, never one without the default'
L_SETTINGS = LIVE + 'shows an Account with no entry the view settings only, while explicit entries keep their settings'
L_DESCRIBE = LIVE + 'describes no write for an Account that holds only the default'
L_READ_ONLY = LIVE + 'states every settings entry read-only for an Account that holds only the default (card bedf50cc)'
L_PROXY_NON_VIEW = LIVE + 'never admits a non-view capability through the proxy on the default'
L_INACTIVE = LIVE + 'gives an inactive Account nothing from the default'
L_LOAD = LIVE + 'refuses an installation with a malformed default at load and still loads the others'
P_DEFAULT = ('v1 proxy authorization and assertion transport the deployment view default admits a read and never a '
             'write, even on a rule labelled view (card 8fe6d7bb)')
# Pre-existing tests that pin "an explicit view entry is not a write grant".
R_VIEW_MANAGE = ('settings registry Account capability filtering classifies a view GET and manage POST on the same '
                 'path from the write rule')
R_ROOT = 'settings registry Account capability filtering needs both a write scope and the current Account grant, including for root'
R_NEXT = ('settings registry Account capability filtering changes on the next registry request without sharing '
          'metadata across Accounts')
U_ROOT = 'caller-specific host proxy write description requires the write scope and an explicit Account grant even for root'
# Card bedf50cc: the per-entry settings readOnly flag.
S_UNIT = 'settings entry read-only description (card bedf50cc) '
S_VIEW_POST = S_UNIT + 'a view entry with a POST rule under another capability is writable only for an Account holding that capability'
S_PRECEDENCE = S_UNIT + 'follows the proxy precedence and ignores writes that reach only a descendant or a sibling'
S_SCOPE = S_UNIT + 'requires the write scope and an active Account, even for root'
S_DEFAULT = S_UNIT + 'the deployment view default never makes a settings entry writable'
R_PER_ENTRY = ('settings registry Account capability filtering states per settings entry whether this Account can change '
               'it (view entry, POST under another capability)')

# (name, file, anchor, replacement, the exact set of tests that must fail)
CONTROLS = [
    # The default satisfies any capability: an Account with no entry reaches
    # the manage settings entry and the manage read through the proxy.
    ('the default satisfies a non-view capability', CONTRACT,
     '  return capability === PLUGIN_DEFAULT_CAPABILITY && pluginDefaultGrantsView(config);\n',
     '  return pluginDefaultGrantsView(config);\n',
     {U_VIEW_ONLY, U_EXPLICIT, L_SETTINGS, L_PROXY_NON_VIEW, P_DEFAULT}),
    # The proxy's write branch consults the default: a write rule labelled
    # view (unloadable, so only a bypassed rule) admits an Account with no entry.
    ('the proxy write path admits the default', PROXY,
     '          ? pluginAccountHasExplicitGrant(plugin!.config,account,capability)\n',
     '          ? (pluginAccountHasExplicitGrant(plugin!.config,account,capability) || pluginAccountCan(plugin!.config,account,capability))\n',
     {P_DEFAULT}),
    # The registry's write description consults view (default or explicit).
    ('the write description admits the default', CONTRACT,
     '        !pluginAccountHasExplicitGrant(config, accountId, rule.capability)) continue;\n',
     '        !(pluginAccountHasExplicitGrant(config, accountId, rule.capability) || pluginAccountCan(config, accountId))) continue;\n',
     {U_NO_WRITE, L_DESCRIBE, R_VIEW_MANAGE, R_ROOT, R_NEXT, U_ROOT}),
    # The settings filter applies the default to a non-view entry.
    ('the settings filter applies the default to a non-view entry', ROUTES,
     '      ? (entry.settings ?? []).filter(setting => pluginAccountCan(plugin.config, account, setting.capability))\n',
     "      ? (entry.settings ?? []).filter(setting => pluginAccountCan(plugin.config, account, plugin.config.access?.default?.length ? 'view' : setting.capability))\n",
     {L_SETTINGS}),
    # Load validation accepts any array as a default: the array-shaped
    # malformed rows load, and the installation that must refuse is listed.
    ('a malformed default loads', CONTRACT,
     '  return Array.isArray(value) && value.length <= 1 && value.every(entry => entry === PLUGIN_DEFAULT_CAPABILITY);\n',
     '  return Array.isArray(value);\n',
     {U_REFUSE + '["generate"]', U_REFUSE + '["view","generate"]', U_REFUSE + '["view","view"]',
      U_REFUSE + '[{}]', U_REFUSE + '["*"]', U_REFUSE + '["VIEW"]', L_LIST, L_LOAD}),
    # The use-time shape check honours any non-empty array.
    ('a default that bypassed validation counts at use time', CONTRACT,
     '  return Array.isArray(value) && value.length === 1 && value[0] === PLUGIN_DEFAULT_CAPABILITY;\n',
     '  return Array.isArray(value) && value.length > 0;\n',
     {U_USE_TIME}),
    # The Account guard goes: a request with no active Account gets the default.
    ('the default reaches a request without an Account', CONTRACT,
     '  if (!accountId) return false;\n  if (pluginAccountHasExplicitGrant(config, accountId, capability)) return true;\n',
     '  if (pluginAccountHasExplicitGrant(config, accountId, capability)) return true;\n',
     {U_NO_ACCOUNT, L_INACTIVE}),
    # Card bedf50cc: the per-entry readOnly flag consults view (default or
    # explicit): an Account holding only view is told it can change an entry
    # whose write rule needs a capability it does not hold.
    ('the settings read-only flag admits the default', CONTRACT,
     '    if (pluginAccountHasExplicitGrant(config, accountId, rule.capability)) return false;\n',
     '    if (pluginAccountHasExplicitGrant(config, accountId, rule.capability) || pluginAccountCan(config, accountId)) return false;\n',
     {S_VIEW_POST, S_PRECEDENCE, S_SCOPE, S_DEFAULT, R_PER_ENTRY, L_SETTINGS, L_READ_ONLY}),
]

IGNORED = ('.git', 'graphify-out', 'node_modules', 'dist', 'coverage', '__pycache__', '.pytest_cache')
NOT_MEASURED = (
    ('a hook or test outlived its budget', r'Exceeded timeout|Test timed out|Hook timed out'),
    ('the source did not compile', r'TS\d{4}'),
    ('a syntax error', r'SyntaxError'),
    ('the suite did not load', r'Test suite failed to run'),
)
SUITE_RUN_TIMEOUT_SECONDS = 900
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


def run_suites(copy, out, label):
    report = out / f'{label}.json'
    timed_out = False
    with (out / f'{label}.log').open('w') as log:
        try:
            code = subprocess.run(
                ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--runTestsByPath', *SUITES,
                 '--json', f'--outputFile={report}'],
                cwd=copy / 'backend', stdout=log, stderr=subprocess.STDOUT,
                timeout=SUITE_RUN_TIMEOUT_SECONDS).returncode
        except subprocess.TimeoutExpired:
            code, timed_out = None, True
    result = json.loads(report.read_text()) if report.exists() else {}
    tests = [dict(a, fullName=a['fullName'].strip())
             for f in result.get('testResults', []) for a in f.get('assertionResults', [])]
    suite_messages = re.sub(r'\x1b\[[0-9;]*m', '', ' '.join(str(f.get('message', '')) for f in result.get('testResults', [])))
    return code, tests, suite_messages, timed_out


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
    thrown = [t for t in failing if 'expect(' not in '\n'.join(t.get('failureMessages', []))]
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

    if not (ROOT / 'backend' / 'node_modules').is_dir():
        raise SystemExit('backend/node_modules is missing: run npm ci in backend/ first')
    if not args.output_dir:
        raise SystemExit('--output-dir is required')
    out = args.output_dir.resolve()
    if out == ROOT or ROOT in out.parents:
        raise SystemExit('--output-dir must lie outside the repository')
    out.mkdir(parents=True, exist_ok=False)

    before = fingerprints(ROOT)
    copy = Path(tempfile.mkdtemp(prefix='plugin-view-default-drill-'))
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
            failed = {t['fullName'] for t in tests if t['status'] == 'failed'}
            state, reason = verdict(code, tests, names, must_fail, suite_messages, timed_out)
            receipts.append({'control': name, 'file': path, 'mustFail': sorted(must_fail),
                             'failed': sorted(failed), 'red': state == 'RED', 'verdict': state, 'reason': reason})
            (out / 'receipts.json').write_text(json.dumps(receipts, indent=2))
            print(f"{'RED ' if state == 'RED' else state} {name} -> {len(failed)} failed ({reason})", flush=True)
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
