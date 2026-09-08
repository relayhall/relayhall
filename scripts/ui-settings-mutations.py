#!/usr/bin/env python3
"""Named UI regressions on a disposable Git clone; never mutate the source tree."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

HOOK = 'src/hooks/usePrincipals.ts'
PAGE = 'src/pages/SettingsPage.tsx'
LOAD = 'src/pages/SettingsPage.loadState.test.tsx'
SHELL = 'src/pages/SettingsPage.test.tsx'
FILES = [LOAD, SHELL]
REFRESH = ['refresh clears all authority fields before 404 and rejects duplicate pending reload', 'refresh clears all authority fields before 503 and rejects duplicate pending reload']
CONTROLS = [
 ('http-failure', HOOK, "if (!res.ok) throw new Error('Principal lookup failed');", 'if (!res.ok) return;', LOAD, ['429 failure stays closed and Retry recovers from the server answer', '503 failure stays closed and Retry recovers from the server answer', REFRESH[1], 'completion after unmount cannot replace a separately mounted current principal']),
 ('network-json-failure', HOOK, 'if (!cancelled) setFailed(true);', 'if (!cancelled) setFailed(false);', LOAD, ['429 failure stays closed and Retry recovers from the server answer', '503 failure stays closed and Retry recovers from the server answer', 'network failure stays closed and Retry recovers from the server answer', 'invalid-json failure stays closed and Retry recovers from the server answer', REFRESH[1], 'completion after unmount cannot replace a separately mounted current principal']),
 ('valid-404', HOOK, 'if (res.status === 404) return;', "if (res.status === 404) throw new Error('mutation');", LOAD, ['documented 404 remains a valid unresolved identity without error Retry', REFRESH[0]]),
 ('pending-reload-admission', HOOK, '    if (pending.current) return;', '    /* mutation: admit a second pending reload */', LOAD, REFRESH),
 ('clear-old-authority', HOOK, '    setMe(null);\n    setScopes(undefined);\n    setDelegable(undefined);\n    setSettingsSurfaces(undefined);', '    /* mutation: retain stale authority */', LOAD, REFRESH),
 ('failure-before-outlet', PAGE, '  if (failed) {', '  if (false) {', SHELL, ['failed wins over an old privileged answer before child mount']),
 ('loading-before-outlet', PAGE, '  if (loading) {', '  if (false) {', SHELL, ['loading wins over an old privileged answer before child mount']),
 ('single-audience', PAGE, '  const audience = useOutletContext<SettingsNavAudience | undefined>();', '  const { audience } = useSettingsAudience();', LOAD, ['429 failure stays closed and Retry recovers from the server answer', '503 failure stays closed and Retry recovers from the server answer', 'network failure stays closed and Retry recovers from the server answer', 'invalid-json failure stays closed and Retry recovers from the server answer', 'present concealed capabilities stay concealed and retain the existing self connection landing', 'index uses the parent answer exactly once and absent context does not invent an audience']),
]


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    source = args.source.resolve()
    output = args.output.resolve()
    assert source.is_dir() and not output.exists()
    assert output != source and source not in output.parents
    assert not subprocess.check_output(['git', 'status', '--porcelain'], cwd=source, text=True).strip(), 'Source must be clean'
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip()
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=source).decode().split('\0')

    def fingerprint():
        return {p: hashlib.sha256((source / p).read_bytes()).hexdigest() for p in tracked if p}

    before = fingerprint()
    output.mkdir(parents=True)
    clone = output / 'copy'
    subprocess.run(['git', 'clone', '--no-hardlinks', str(source), str(clone)], check=True, capture_output=True)
    subprocess.run(['git', 'checkout', '--detach', sha], cwd=clone, check=True, capture_output=True)
    modules = source / 'frontend/node_modules'
    assert (modules / 'vitest/vitest.mjs').is_file()
    (clone / 'frontend/node_modules').symlink_to(modules, target_is_directory=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith('DB_') and k != 'RELAYHALL_TEST_DB_URL'}
    env.update(NODE_ENV='test', CI='true')
    receipts = []

    def suite(name, selected, expected):
        report = output / (name + '.json')
        with (output / (name + '.log')).open('w') as log:
            proc = subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *selected, '--reporter=json', '--outputFile=' + str(report)], cwd=clone / 'frontend', env=env, stdout=log, stderr=subprocess.STDOUT)
        assert report.exists(), f'{name}: no assertion report (not an accepted red)'
        data = json.loads(report.read_text())
        assertions = [a for f in data['testResults'] for a in f['assertionResults']]
        failed = [a for a in assertions if a['status'] == 'failed']
        assert all(a.get('failureMessages') for a in failed), f'{name}: missing semantic assertion diagnostics'
        assert sorted(a['title'] for a in failed) == sorted(expected), f'{name}: wrong failed test set'
        assert not data.get('testExecError') and data.get('numRuntimeErrorTestSuites', 0) == 0, f'{name}: runtime failure'
        assert proc.returncode == (1 if expected else 0), f'{name}: unexpected exit'
        assert len(assertions) == (79 if len(selected) == 2 else 11 if selected[0] == LOAD else 68), f'{name}: inventory drift'
        receipts.append({'name': name, 'accepted': True, 'exit': proc.returncode, 'assertions': len(assertions), 'failed': [a['title'] for a in failed], 'report_sha256': hashlib.sha256(report.read_bytes()).hexdigest()})
        (output / 'summary.json').write_text(json.dumps({'source_sha': sha, 'controls': receipts, 'complete': False}, indent=2) + '\n')
        print(name + ': accepted', flush=True)

    try:
        suite('baseline', FILES, [])
        for name, relative, old, new, test, expected in CONTROLS:
            path = clone / 'frontend' / relative
            original = path.read_text()
            assert original.count(old) == 1, name + ': ambiguous or missing source target'
            try:
                path.write_text(original.replace(old, new))
                suite(name, [test], expected)
            finally:
                path.write_text(original)
        suite('restored', FILES, [])
        assert fingerprint() == before, 'Live source bytes changed during replay'
        assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip() == sha
        # Git ignores node_modules directories, but the owned dependency link is
        # a symlink. Remove that harness link before asserting a clean copy.
        dependency_link = clone / 'frontend/node_modules'
        assert dependency_link.is_symlink() and dependency_link.resolve() == modules.resolve()
        dependency_link.unlink()
        assert not subprocess.check_output(['git', 'status', '--porcelain'], cwd=clone, text=True).strip(), 'Copy was not restored'
        (output / 'source-fingerprint.json').write_text(json.dumps(before, indent=2) + '\n')
        (output / 'summary.json').write_text(json.dumps({'source_sha': sha, 'controls': receipts, 'complete': True, 'source_unchanged': True, 'scope': '8 named Settings identity presentation controls; browser acceptance is separate'}, indent=2) + '\n')
    finally:
        assert fingerprint() == before, 'Live source changed; evidence must be reassessed'


if __name__ == '__main__':
    run()
