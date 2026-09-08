#!/usr/bin/env python3
"""Three missing named schema mutations, only on a disposable backend copy.

Runs existing B76 unchanged and fourteen actual-import boundary assertions.
No database. Exact failure sets exclude compiler errors and unrelated reds.
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


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inventory(base):
    result = {}
    patterns = ['node_modules', 'dist', 'coverage', '.env*', '*.log', '__pycache__', '*.pyc']
    for parent, folders, files in os.walk(base):
        folders[:] = [name for name in folders if not any(fnmatch.fnmatch(name, pattern) for pattern in patterns)]
        for name in files:
            if not any(fnmatch.fnmatch(name, pattern) for pattern in patterns):
                path = Path(parent) / name
                result[str(path.relative_to(base))] = digest(path.read_bytes())
    return dict(sorted(result.items()))


def replace_once(source, before, after):
    if source.count(before) != 1:
        raise AssertionError('Source mutation anchor missing or ambiguous')
    return source.replace(before, after, 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', required=True, type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    out = args.output_dir.resolve()
    if out == root or root in out.parents:
        raise ValueError('Evidence must remain outside the source tree')
    out.mkdir(parents=True, exist_ok=False)
    env = dict(os.environ)
    for key in list(env):
        if key.startswith(('DB_', 'PG')) or key in ['DATABASE_URL', 'RELAYHALL_TEST_DB_URL']:
            env.pop(key)
    env.update(NODE_ENV='test', DB_HOST='127.0.0.1', DB_PORT='59999', DB_NAME='none')
    tests = ['src/__tests__/blueprintDocumentBoundaries.test.ts', 'src/__tests__/blueprintSchemaBoundaryControls.test.ts']
    controls = [
        ('d3-reference-name-substitution', 'function substitutable(path: string[]): boolean {',
         "function substitutable(path: string[]): boolean {\n  if (path[0] === 'references' && path[path.length - 1] === 'name') return true;",
         ['Blueprint substitution territory D3 refuses forbidden substitution reference',
          'Blueprint named schema import controls D3 actual import refuses substitution into a reference name']),
        ('d5-schema-grants',
         "object(input, ['schemaVersion', 'blueprint', 'parameters', 'references', 'target', 'phases', 'tasks', 'humanGates', 'reports', 'dependencies'],",
         "object(input, ['schemaVersion', 'blueprint', 'parameters', 'references', 'target', 'phases', 'tasks', 'humanGates', 'reports', 'dependencies', 'grants'],",
         ['Blueprint named schema import controls D5 actual import refuses forbidden creation kind grants']),
        ('d12-verifier-literal-uuid', '  walk(d, (v, path) => {',
         "  walk(d, (v, path) => {\n    if (path.length === 4 && path[0] === 'tasks' && /^\\d+$/.test(path[1]) && path[2] === 'roles' && path[3] === 'verifier' && BLUEPRINT_FORBIDDEN_LITERAL_SHAPES.uuid.test(v)) return;",
         ['Blueprint document checkpoints D12 ' + point + ' refuses UUID in roles.verifier' for point in ['save', 'publish', 'export']]),
    ]
    receipts = []
    with tempfile.TemporaryDirectory(prefix='rh-blueprint-schema-') as temporary:
        copied = Path(temporary) / 'backend'
        shutil.copytree(root / 'backend', copied, ignore=shutil.ignore_patterns('node_modules', 'dist', 'coverage', '.env*', '*.log', '__pycache__', '*.pyc'))
        sources = inventory(copied)
        (out / 'source-sha256.json').write_text(json.dumps(sources, indent=2) + '\n')
        (copied / 'node_modules').symlink_to((root / 'backend/node_modules').resolve(), target_is_directory=True)
        production = copied / 'src/utils/blueprintDocument.ts'
        original = production.read_bytes()

        def invoke(label):
            report = out / (label + '.json')
            with (out / (label + '.log')).open('w') as stream:
                run = subprocess.run(['node', str(copied / 'node_modules/jest/bin/jest.js'), '--runInBand',
                                      '--runTestsByPath', *tests, '--json', '--outputFile', str(report)],
                                     cwd=copied, env=env, stdout=stream, stderr=subprocess.STDOUT, timeout=180)
            if not report.exists():
                raise AssertionError(label + ': structured assertion result missing')
            data = json.loads(report.read_text())
            assertions = [a for suite in data.get('testResults', []) for a in suite.get('assertionResults', [])]
            if len(assertions) != 90 or data.get('numTotalTestSuites') != 2 or any(a['status'] not in ['passed', 'failed'] for a in assertions):
                raise AssertionError(label + ': test inventory drift, skipped assertion or compile/import failure')
            return run.returncode, assertions

        def green(label):
            code, assertions = invoke(label)
            if code or any(a['status'] != 'passed' for a in assertions):
                raise AssertionError(label + ': all90 assertions must pass')
            return assertions

        baseline = green('baseline')
        for name, old, new, expected in controls:
            if any(sum(a['fullName'] == wanted for a in baseline) != 1 for wanted in expected):
                raise AssertionError(name + ': declared exact assertion set is absent')
            row = {'control': name, 'expected': sorted(expected), 'beforeSha256': digest(original)}
            try:
                production.write_text(replace_once(original.decode(), old, new))
                row['mutatedSha256'] = digest(production.read_bytes())
                code, assertions = invoke(name)
                failures = [a for a in assertions if a['status'] == 'failed']
                row.update(exit=code, actual=sorted(a['fullName'] for a in failures),
                           failures=[{'name': a['fullName'], 'messages': a['failureMessages']} for a in failures])
                row['red'] = (code != 0 and row['actual'] == row['expected']
                              and all(any('expect(' in message for message in a['failureMessages']) for a in failures))
                if not row['red']:
                    raise AssertionError(name + ': exact intended assertion set did not fail')
            finally:
                production.write_bytes(original)
                row['restored'] = production.read_bytes() == original
                receipts.append(row)
                (out / 'receipt.json').write_text(json.dumps(receipts, indent=2) + '\n')
        green('restored')
        current = inventory(root / 'backend')
        changed = [p for p in sorted(set(sources) | set(current)) if sources.get(p) != current.get(p)]
        (out / 'source-readback.json').write_text(json.dumps({'changed': changed}, indent=2) + '\n')
        if changed:
            raise AssertionError('Live source drift invalidates copied proof')
    result = {'baseline': 90, 'restored': 90, 'acceptedControls': 3, 'liveSourceUnchanged': True, 'copyRemoved': not copied.exists()}
    (out / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
