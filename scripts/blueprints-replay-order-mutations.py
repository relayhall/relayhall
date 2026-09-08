#!/usr/bin/env python3
"""D17 replay ordering: real assertions against three disposable source edits.

The caller owns a sequential database slot and its lifecycle. This driver never
starts/stops a container, creates/drops a database, or mutates the source tree.
"""
import argparse
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from urllib.parse import urlparse, unquote

INSTANTIATOR = 'backend/src/services/BlueprintInstantiationService.ts'
LIVE_TEST = 'backend/src/__tests__/blueprintLiveContract.test.ts'
SELECTOR_REPLAY = 'D-11 existing target archive precedes retry; D-17 nonroot committed replay'
SELECTOR_RETIRED = 'D-19 review is immutable, independent publication required, retirement blocks new work but permits committed replay'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inventory(base):
    result = {}
    patterns = ['node_modules', 'dist', 'coverage', '.env*', '*.log', '__pycache__', '*.pyc']
    for directory in ['backend', 'cli']:
        for parent, folders, files in os.walk(base / directory):
            folders[:] = [name for name in folders if not any(fnmatch.fnmatch(name, pattern) for pattern in patterns)]
            for name in files:
                if not any(fnmatch.fnmatch(name, pattern) for pattern in patterns):
                    path = Path(parent) / name
                    result[str(path.relative_to(base))] = digest(path.read_bytes())
    return dict(sorted(result.items()))


def database_environment(profile):
    raw = os.environ.get('RELAYHALL_TEST_DB_URL', '')
    parsed = urlparse(raw)
    expected = {
        'local': ('127.0.0.1', 55437, 'postgres', 'blueprints_contract_20260906'),
        'ci': ('postgres', 5432, 'relayhall_ci', 'relayhall_ci'),
    }[profile]
    identity = (parsed.hostname, parsed.port, unquote(parsed.username or ''), unquote(parsed.path.lstrip('/')))
    if parsed.scheme not in ('postgres', 'postgresql') or identity != expected or parsed.query or parsed.fragment:
        raise ValueError('Explicit owned disposable database profile required')
    if profile == 'ci' and os.environ.get('CI') != 'true':
        raise ValueError('CI profile requires explicit CI=true')
    env = dict(os.environ)
    for key in list(env):
        if key.startswith(('DB_', 'PG')) or key == 'DATABASE_URL':
            env.pop(key)
    env['NODE_ENV'] = 'test'
    return env


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise AssertionError('Production mutation anchor is absent or ambiguous')
    return text.replace(old, new, 1)


def mutations(original):
    """Each result is one replacement of one contiguous production region."""
    lookup = "      const existing = (await client.query('SELECT * FROM blueprint_instantiation_requests WHERE caller=$1 AND blueprint_id=$2 AND idempotency_key=$3', [caller.actor.principalId,parent.id,key])).rows[0];\n"
    version = '      const versionId = existing?.blueprint_version_id ?? parent.published_version_id;\n'
    replay = """      if (existing) {
        if (hash !== existing.request_hash) throw new BlueprintError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with different input');
        const root = await this.target(existing.response_snapshot.projectId, caller, client, true);
        this.activeTarget(root);
        return existing.response_snapshot;
      }
"""
    end = '      enforceBlueprintPlan(plan);\n'
    if original.count(lookup) != 1 or original.count(end) != 1:
        raise AssertionError('Ordering region must be unique')
    start = original.index(lookup)
    finish = original.index(end, start) + len(end)
    region = original[start:finish]
    # Moving the ledger lookup necessarily stops using its pinned version before
    # that lookup. The current published row is decided first in both mutants.
    without_replay = replace_once(region, lookup, '')
    without_replay = replace_once(without_replay, version, '      const versionId = parent.published_version_id;\n')
    without_replay = replace_once(without_replay, replay, '')
    after_authority = without_replay + lookup + replay
    after_lifecycle = replace_once(without_replay, '      this.requirePublished(version);\n',
                                   '      this.requirePublished(version);\n' + lookup + replay)
    before_target = """      const client = transaction.client;
      const historicalParent = await this.registry.resolve(identifier, caller, 'use', client, true);
      const historicalReplay = (await client.query('SELECT response_snapshot FROM blueprint_instantiation_requests WHERE caller=$1 AND blueprint_id=$2 AND idempotency_key=$3', [caller.actor.principalId,historicalParent.id,key])).rows[0];
      if (historicalReplay) return historicalReplay.response_snapshot;
"""
    return [
        ('d17-replay-after-authority', replace_once(original, region, after_authority), SELECTOR_REPLAY,
         ['BLUEPRINT_AUTHORITY_REQUIRED', 'tasks:write']),
        ('d17-replay-after-lifecycle', replace_once(original, region, after_lifecycle), SELECTOR_RETIRED,
         ['BLUEPRINT_NOT_PUBLISHED']),
        ('d17-replay-before-target-lock', replace_once(original, '      const client = transaction.client;\n', before_target), SELECTOR_REPLAY,
         ['PROJECT_NOT_FOUND']),
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', required=True, choices=['local', 'ci'])
    parser.add_argument('--output-dir', required=True, type=Path)
    parser.add_argument('--expected-tests', required=True, type=int)
    args = parser.parse_args()
    if args.expected_tests <= 0:
        raise ValueError('Exact positive live suite count required')
    root = Path(__file__).resolve().parents[1]
    out = args.output_dir.resolve()
    if out == root or root in out.parents:
        raise ValueError('Evidence must remain outside the source tree')
    env = database_environment(args.profile)
    out.mkdir(parents=True, exist_ok=False)
    ignored = shutil.ignore_patterns('node_modules', 'dist', 'coverage', '.env*', '*.log', '__pycache__', '*.pyc')
    receipts = []
    result = {'complete': False, 'profile': args.profile}
    with tempfile.TemporaryDirectory(prefix='rh-blueprint-replay-order-', dir=out.parent) as temporary:
        copied = Path(temporary) / 'source'
        for directory in ['backend', 'cli']:
            shutil.copytree(root / directory, copied / directory, ignore=ignored)
        # Fingerprint every copied input, not just the mutated service. The live
        # suite executes the CLI and also depends on migrations/configuration.
        sources = inventory(copied)
        (out / 'source-sha256.json').write_text(json.dumps(sources, indent=2) + '\n')
        (copied / 'backend/node_modules').symlink_to((root / 'backend/node_modules').resolve(), target_is_directory=True)
        original = (copied / INSTANTIATOR).read_bytes()
        candidates = mutations(original.decode())

        def invoke(label, selector=None):
            report = out / (label + '.json')
            command = ['node', str(copied / 'backend/node_modules/jest/bin/jest.js'), '--runInBand',
                       '--testPathIgnorePatterns=/node_modules/', '--runTestsByPath',
                       'src/__tests__/blueprintLiveContract.test.ts', '--json', '--outputFile', str(report)]
            if selector:
                command.extend(['--testNamePattern', selector])
            with (out / (label + '.log')).open('w') as stream:
                run = subprocess.run(command, cwd=copied / 'backend', env=env, stdout=stream,
                                     stderr=subprocess.STDOUT, timeout=240)
            if not report.is_file():
                raise AssertionError(label + ': no structured test result')
            data = json.loads(report.read_text())
            assertions = [a for suite in data.get('testResults', []) for a in suite.get('assertionResults', [])]
            if len(assertions) != args.expected_tests or data.get('numTotalTestSuites') != 1:
                raise AssertionError(label + ': test inventory drift or compile/import failure')
            failures = [a for a in assertions if a['status'] == 'failed']
            return run.returncode, data, assertions, failures

        def require_green(label):
            code, data, assertions, failures = invoke(label)
            if code or failures or data['numPassedTests'] != args.expected_tests or any(a['status'] != 'passed' for a in assertions):
                raise AssertionError(label + ': exact full baseline must pass')
            return assertions

        baseline = require_green('baseline')
        try:
            for name, mutated, selector, required in candidates:
                expected = [a['fullName'] for a in baseline if selector in a['fullName']]
                if len(expected) != 1:
                    raise AssertionError(name + ': selector must identify one baseline test')
                row = {'control': name, 'test': expected[0], 'requiredDiagnostics': required,
                       'beforeSha256': digest(original), 'mutationScope': INSTANTIATOR}
                try:
                    (copied / INSTANTIATOR).write_text(mutated)
                    row['mutatedSha256'] = digest((copied / INSTANTIATOR).read_bytes())
                    code, data, assertions, failures = invoke(name, selector)
                    messages = failures[0]['failureMessages'] if len(failures) == 1 else []
                    row.update(exit=code, failures=[{'name': a['fullName'], 'messages': a['failureMessages']} for a in failures])
                    row['red'] = (code != 0 and [a['fullName'] for a in failures] == expected
                                  and data['numFailedTests'] == 1 and data['numPassedTests'] == 0
                                  and all(any(token in message for message in messages) for token in required)
                                  and any('expect(' in message and ('Expected' in message or '- Expected' in message) for message in messages))
                    if not row['red']:
                        raise AssertionError(name + ': required semantic assertion did not redden')
                finally:
                    (copied / INSTANTIATOR).write_bytes(original)
                    row['restored'] = (copied / INSTANTIATOR).read_bytes() == original
                    receipts.append(row)
                    (out / 'receipt.json').write_text(json.dumps(receipts, indent=2) + '\n')
            require_green('restored')
            current = inventory(root)
            changed = [name for name in sorted(set(sources) | set(current)) if sources.get(name) != current.get(name)]
            (out / 'source-readback.json').write_text(json.dumps({'changed': changed}, indent=2) + '\n')
            if changed:
                raise AssertionError('Source drift invalidates copied-source receipt')
            result.update(complete=True, acceptedControls=3, baseline=args.expected_tests,
                          restored=args.expected_tests, liveSourceUnchanged=True)
        finally:
            (out / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
    result['copyRemoved'] = not copied.exists()
    (out / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
