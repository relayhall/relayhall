#!/usr/bin/env python3
"""Package B real-red controls in a disposable source copy, never the worktree.

The named assertion sets are declared before mutation. Compiler/import failures,
missing tests, unexpected extra failures, and surviving edits all fail the drill.
Persistence is mocked by this test suite; this is not a PostgreSQL acceptance run.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', required=True, type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
backend = root / 'backend'
out = args.output_dir.resolve()
out.mkdir(parents=True, exist_ok=True)
test = 'src/__tests__/blueprintDocumentBoundaries.test.ts'
doc = 'src/utils/blueprintDocument.ts'
reg = 'src/services/BlueprintRegistryService.ts'
plan = 'src/services/BlueprintPlanService.ts'
tracked = [test, doc, reg, plan, 'src/utils/executionProfile.ts', 'src/utils/serviceDescriptor.ts', 'src/utils/jsonBodyTypes.ts', 'src/server.ts', 'src/mcp/inProcess.ts', 'src/routes/blueprints.ts']
fingerprints = {p: hashlib.sha256((backend / p).read_bytes()).hexdigest() for p in tracked}
env = dict(os.environ)
for key in list(env):
    if key.startswith(('DB_', 'PG')) or key in ['DATABASE_URL', 'RELAYHALL_TEST_DB_URL']:
        env.pop(key)
env['NODE_ENV'] = 'test'

def edits(file, old, new):
    return [(file, old, new)]

# Expected labels match complete named tests in the green baseline.
controls = [
    ('publish-validator', edits(reg, 'validateBlueprintDocument(row.document, this.bodyConfiguration);', 'void row.document;'), ['D9 publish refuses', 'D12 publish refuses'], 6),
    ('export-validator', edits(reg, 'stableBlueprintJson(validateBlueprintDocument(result.document, this.bodyConfiguration))', 'stableBlueprintJson(result.document)'), ['D9 export refuses', 'D12 export refuses'], 6),
    ('password-type', edits(doc, "Object.freeze(['string', 'text', 'integer', 'boolean', 'enum', 'date',", "Object.freeze(['password', 'string', 'text', 'integer', 'boolean', 'enum', 'date',"), ['D9 parameter type set', 'D9 layered schema refuses password'], 2),
    ('hostname-shape', edits(doc, r'hostname: /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}\b/i,', 'hostname: /a^/i,'), ['D12 shape set refuses hostname'], 1),
    ('identity-includes-key', edits(doc, "identitySha256: blueprintDigest({ ...document, blueprint: { ...document.blueprint, key: '' } })", 'identitySha256: blueprintDigest(document)'), ['D12 rename changes only integrity'], 1),
    ('integrity-ignores-key', edits(doc, 'contentSha256: blueprintDigest(document)', "contentSha256: blueprintDigest({ ...document, blueprint: { ...document.blueprint, key: '' } })"), ['D12 rename changes only integrity'], 1),
    # Treating description as a Principal slot also rejects the two literal-description
    # parser-boundary fixtures through fixed-role validation. All four must fail.
    ('binding-slot-widening', edits(doc, "export const BINDING_SLOTS = Object.freeze({", "export const BINDING_SLOTS = Object.freeze({\n  'tasks.description': 'principal-ref',"), ['D21 binding slots are exactly', 'D21 ref binding outside set refuses task description', 'D18 canonical 65536 bytes reaches Blueprint import validation', 'D25 lower actual parser limit preserves named Blueprint byte refusal with envelope space'], 4),
    ('ref-text-substitution', edits(doc, "new Set(['string', 'text', 'integer', 'boolean', 'enum', 'date'])", "new Set(['principal-ref', 'string', 'text', 'integer', 'boolean', 'enum', 'date'])"), ['D21 ref binding outside set refuses'], 5),
    ('use-skips-document-validation', edits(plan, 'const document = validateBlueprintDocument(documentInput, configuration);', 'void configuration; const document = documentInput as ReturnType<typeof validateBlueprintDocument>;'), ['D13 published-at-cap'], 1),
    ('document-byte-check', edits(doc, "if (Buffer.byteLength(stableBlueprintJson(d), 'utf8') > cap)", 'if (false)'), ['D18 canonical 65537', 'D25 lower actual parser limit'], 2),
    ('hardcoded-cap', edits(doc, 'return Math.max(0, Math.min(currentBlueprintLimits().documentBytes, configuration.limit - BLUEPRINT_CAPS.envelopeBytes));', 'return 65536;'), ['D25 shared real server configuration', 'D25 lower actual parser limit'], 2),
    ('removed-body-minimum', edits(doc, 'return Math.max(0, Math.min(currentBlueprintLimits().documentBytes, configuration.limit - BLUEPRINT_CAPS.envelopeBytes));', 'return currentBlueprintLimits().documentBytes;'), ['D25 shared real server configuration', 'D25 lower actual parser limit'], 2),
    ('runtime-screen-after-substitution', edits(plan, 'const values = validateBlueprintValues(document, parameterInput, context.target.mode);\n  const materialized = substituteBlueprint(document, values);', 'const materialized = substituteBlueprint(document, parameterInput as any);\n  const values = validateBlueprintValues(document, parameterInput, context.target.mode);'), ['D22 recorded production order'], 1),
    ('runtime-screen-removed', edits(doc, "for (const [key,value] of Object.entries(supplied as RecordValue)) if (credentialShaped(key) || credentialShaped(value)) throw new BlueprintError(422,'PARAMETER_VALUE_REFUSED','Parameter value refused',credentialShaped(key) ? 'parameterValues' : key);", '/* mutation: omitted runtime screen */'), ['D22 runtime', 'D22 recorded production order'], 4),
    ('prompt-screen-removed', edits(doc, "if (['label', 'promptText', 'help'].some(k => CREDENTIAL_WORD.test(p[k] || ''))) fail(f, 'A Blueprint cannot ask for credentials');", '/* mutation: omitted prompt screen */'), ['D22 import refuses prompt'], 7),
    ('second-substitution-pass', edits(doc, 'return transform(document);', 'return transform(transform(document));'), ['D3 D21 one-pass plan text'], 1),
    ('execution-option-classifier', edits(plan, "const declared = descriptor.options.find(option => option.key === key);\n          if (declared?.type !== 'string')", "const declared = descriptor.options.find(option => option.key === key);\n          if (!declared || !['string','enum'].includes(declared.type))"), ['D3 execution option named title'], 1),
    ('uncovered-forbidden-shape', edits(doc, 'export const BLUEPRINT_FORBIDDEN_LITERAL_SHAPES = Object.freeze({', 'export const BLUEPRINT_FORBIDDEN_LITERAL_SHAPES = Object.freeze({\n  uncovered: /never-portable/i,'), ['D12 executable forbidden shape set'], 1),
]

receipt = []
with tempfile.TemporaryDirectory(prefix='rh-blueprint-document-') as temporary:
    copied = Path(temporary) / 'backend'
    shutil.copytree(backend, copied, ignore=shutil.ignore_patterns('node_modules', 'dist', 'coverage', '.env*', '*.log'))
    (copied / 'node_modules').symlink_to((backend / 'node_modules').resolve(), target_is_directory=True)
    baseline = {p: (copied / p).read_bytes() for p in tracked}
    def run(label):
        result_file = out / (label + '.json')
        with (out / (label + '.log')).open('w') as log:
            proc = subprocess.run(['node', str(copied / 'node_modules/jest/bin/jest.js'), '--runInBand', '--runTestsByPath', test,
                '--json', '--outputFile=' + str(result_file)], cwd=copied, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=120)
        if not result_file.exists():
            raise AssertionError(label + ': runner produced no assertion result')
        result = json.loads(result_file.read_text())
        assertions = [a for suite in result['testResults'] for a in suite['assertionResults']]
        assert len(assertions) == 76 and result['numTotalTests'] == 76, label + ': missing tests or compilation/import failure'
        assert all(a['status'] in ['passed', 'failed'] for a in assertions), label + ': skipped/incomplete test'
        failures = sorted(a['fullName'] for a in assertions if a['status'] == 'failed')
        return proc.returncode, failures, [a['fullName'] for a in assertions]
    code, failures, names = run('baseline')
    assert code == 0 and not failures, 'Baseline must be green'
    try:
        for name, replacements, prefixes, count in controls:
            expected = sorted(n for n in names if any(prefix in n for prefix in prefixes))
            assert len(expected) == count, name + ': expected-set definition drifted'
            for file, old, new in replacements:
                source = (copied / file).read_text()
                assert source.count(old) == 1, name + ': anchor is not unique'
                (copied / file).write_text(source.replace(old, new, 1))
            code, failures, _ = run(name)
            row = {'name': name, 'expected': expected, 'actual': failures, 'returncode': code, 'pass': code != 0 and failures == expected}
            receipt.append(row)
            (out / 'receipt.json').write_text(json.dumps({'source_sha256': fingerprints, 'controls': receipt}, indent=2))
            assert row['pass'], name + ': unexpected failure set or surviving mutant'
            for file, content in baseline.items():
                (copied / file).write_bytes(content)
            print(name + ': RED as declared; copied source restored', flush=True)
        code, failures, _ = run('restored')
        assert code == 0 and not failures, 'Restored source must be green'
    finally:
        for file, content in baseline.items():
            (copied / file).write_bytes(content)
        assert all(hashlib.sha256((backend / p).read_bytes()).hexdigest() == digest for p, digest in fingerprints.items()), 'Live worktree source changed during run; evidence must be revalidated'
print('PASS: 76 baseline/restored assertions; ' + str(len(receipt)) + ' exact-set controls; live worktree untouched', flush=True)
