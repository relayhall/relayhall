#!/usr/bin/env python3
"""Mutation drill for the default search scope (card 40e0e542, owner ruling
E127 (5), selector amendment v1.2).

Each control below edits ONE literal anchor in a disposable copy of the tree and
runs four suites, the live one against a REAL disposable PostgreSQL through the
production router and the MCP ingress:

  backend/src/__tests__/knowledgeDefaultScope.test.ts       (executor, builder, descriptor, route)
  backend/src/__tests__/knowledgeSelectorSchemaPin.test.ts  (the selector-v2 sha256 pin)
  backend/src/__tests__/knowledgeDefaultScopeLive.test.ts   (router + MCP + stub source)
  frontend/src/pages/KnowledgePage.test.tsx                 (the Knowledge page, vitest)

The first four controls are the four the lane brief names: drop the
subtraction; forward includeArchive to the source as a field; let
archiveCategories escape the declared set; change the schema without moving the
sha-parity pin. The last three are the rider's (the L3 review): make the scope
sentence unconditional again; drop the opt-in from the search ledger; remove the
Knowledge page's fix for a tick made before the principal read resolves.

Each run gets one of three verdicts:
  RED           every test ran, and exactly the declared tests failed, each at
                an expect().
  MISS          every test ran to an assertion, and the failed set is not the
                declared set (none failed, or others did).
  INCONCLUSIVE  the suites did not reach the declared assertions (a timeout, a
                compile error, a suite that did not load, an unreachable
                database, a test that failed by a thrown error). No verdict on
                the control; the drill still fails (exit status 3).
A jest failure is at an assertion when its message carries `expect(`; a vitest
failure when every message is an assertion's own (`expected ...`), because the
vitest JSON report carries the message without the error's name.
Every control declares a different set, so no two can be satisfied by one
assertion. The source tree is never edited: its bytes are fingerprinted before
and after.

The backend and frontend dependencies must both be installed (`npm ci` in
backend/ and frontend/); the copy links both node_modules directories.

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \\
    python3 scripts/knowledge-default-scope-mutations.py --output-dir /tmp/default-scope-drill
  python3 scripts/knowledge-default-scope-mutations.py --describe   # checks every anchor, no database
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
    'src/__tests__/knowledgeDefaultScope.test.ts',
    'src/__tests__/knowledgeSelectorSchemaPin.test.ts',
    'src/__tests__/knowledgeDefaultScopeLive.test.ts',
]
FRONTEND_SUITES = ['src/pages/KnowledgePage.test.tsx']
V2 = 'backend/src/services/KnowledgeV2.ts'
EXECUTOR = 'backend/src/services/KnowledgeFanoutExecutor.ts'
DESCRIPTOR = 'backend/src/utils/serviceDescriptor.ts'
SCHEMA = 'docs/contracts/knowledge-v2/selector-v2.schema.json'
PROVENANCE = 'backend/src/services/KnowledgeProvenanceWrapper.ts'
PAGE = 'frontend/src/pages/KnowledgePage.tsx'

UNIT = 'card 40e0e542 — '
U_SUBTRACT = UNIT + 'the subtraction scopedSourceCategories: (requested ?? declared) minus the archive by default; unchanged on opt-in or without an archive'
U_DEFAULT = UNIT + 'the subtraction DEFAULT: the source is asked for its declared categories minus the archive, and every handle binds that narrowed filter'
U_FLAG = UNIT + 'the subtraction THE FLAG NEVER LEAVES THE CORE: whatever includeArchive says, the source request carries exactly q, limit, protocol_version, filter, assertion and budget_ms'
U_ALL_ARCHIVE = UNIT + 'the subtraction a source whose declared categories are ALL archive is skipped with reason categories by default (never dialed) and consulted on opt-in'
U_EXPLICIT = UNIT + 'the subtraction explicit categories: archive-only is skipped by default, a mixed request is narrowed, and opt-in keeps the request'
U_STRAY = UNIT + 'the subtraction a source that answers an ARCHIVE hit to a default search has it dropped and named in invalidResults; no handle carries it'
U_ESCAPE = UNIT + 'the descriptor field archiveCategories outside the declared categories is refused, so the real archive cannot stay in the default search'
PIN = 'selector-v2 schema pin (card 40e0e542) the selector-v2 schema file is the pinned bytes (MOVES with card 40e0e542)'
L_DEFAULT_REST = ('(1) a default search excludes the archive and says so REST: MIXED is asked for its categories minus the '
                  'archive, ARCHIVE_ONLY is not dialed, and the coverage says archive excluded')
L_DEFAULT_MCP = ('(1) a default search excludes the archive and says so MCP: the same narrowed request, and the answer opens '
                 'by saying the archive was excluded')
L_ALL_ARCHIVE = ('(3) a source whose categories are ALL archive is skipped with reason categories by default — never dialed '
                 '— and consulted on opt-in')
L_NOT_RELEASED = ('(4) a caller without the right gains nothing through the flag a caller the source does not release its '
                  'archive to: the default answers; the opt-in is refused BY THE SOURCE and the refusal passes through')
L_HANDLE = ('(5) a handle from a default search cannot open an archive document a default-search handle whose document the '
            'source has since filed as archive is refused by the core, and the source was sent the narrowed filter')
L_STRAY = ('(5) a handle from a default search cannot open an archive document an archive hit a source returns to a '
           'default search is dropped and named in invalidResults; no handle is issued for it')
L_INVARIANTS = ('(6) every coverage record and every source request every coverage record this suite saw names '
                'searchedCategories for exactly its consulted sources and states archive per the invariants')
L_FLAG = ('(6) every coverage record and every source request NO SOURCE REQUEST EVER CARRIED THE FLAG: every search and '
          'get body has exactly the wire keys, a closed filter and claims without it')
# The rider (the L3 review).
U_SENTENCE = (UNIT + 'the coverage record and the answer the scope sentence is true in each situation: no declaring source, '
              'the default, the opt-in, and an opt-in every declaring source refused')
U_LEDGER = UNIT + "the coverage record and the answer the search ledger records the caller's archive opt-in on every fan-out entry"
L_SENTENCE = ('(R) the rider: the scope sentence and the search ledger MCP: a source that declares no archive, the opt-in, '
              'and an opt-in every declaring source refused each get a true sentence')
L_LEDGER = ("(R) the rider: the scope sentence and the search ledger the search ledger records the caller's archive opt-in "
            'on every fan-out entry, default and opt-in')
F_RACE = ('a tick made before GET /principals/me resolves is kept and stored once the principal is known, never '
          'overwritten by the stored value')

# (name, file, anchor, replacement, the exact set of tests that must fail)
CONTROLS = [
    # Without the subtraction a default search reaches the archive. Where the
    # source answers, the coverage builder refuses to state "archive excluded"
    # (a 500 over REST, an error over MCP), so every default-scope control goes
    # red, and the record of default answers control 6 reads is empty.
    ('drop the subtraction', V2,
     '  if (input.includeArchive || !input.archive?.length) return input.requested === undefined ? undefined : [...input.requested];',
     '  if (input.includeArchive || input.archive !== null) return input.requested === undefined ? undefined : [...input.requested];',
     {U_SUBTRACT, U_DEFAULT, U_ALL_ARCHIVE, U_EXPLICIT, U_STRAY,
      L_DEFAULT_REST, L_DEFAULT_MCP, L_ALL_ARCHIVE, L_NOT_RELEASED, L_HANDLE, L_STRAY, L_INVARIANTS}),
    ('forward includeArchive to the source as a field', EXECUTOR,
     '    ...(source.protocolVersion === 2 ? { protocol_version: 2, filter: normalizeKnowledgeFilter(request.kinds, source.searchCategories) } : {}),\n',
     '    ...(source.protocolVersion === 2 ? { protocol_version: 2, filter: normalizeKnowledgeFilter(request.kinds, source.searchCategories) } : {}),\n'
     '    ...(request.includeArchive !== undefined ? { includeArchive: request.includeArchive } : {}),\n',
     {U_FLAG, L_FLAG}),
    ('let archiveCategories escape the declared set', DESCRIPTOR,
     "|| !archive.every((category) => typeof category === 'string' && declaredCategories.includes(category))) {",
     "|| !archive.every((category) => typeof category === 'string' && (declaredCategories.includes(category) || category.length > 0))) {",
     {U_ESCAPE}),
    ('change the schema without moving the sha-parity pin', SCHEMA,
     '"title": "Knowledge selector and dynamic Compartment v2 contracts",',
     '"title": "Knowledge selector and dynamic Compartment v2 contracts (unpinned edit)",',
     {PIN}),
    # The rider. The sentence returns to its unconditional form: a search no
    # consulted source holds an archive for says "archive excluded", and an
    # opt-in every archive source refused says the archive was searched.
    ('make the scope sentence unconditional', PROVENANCE,
     "  const declaredBy = coverage.archive?.declaredBy ?? [];\n"
     "  if (declaredBy.length === 0) return 'Searched: current knowledge (no consulted source declares an archive).';\n"
     "  if (coverage.archive.included !== true) return 'Searched: current knowledge; archive excluded (pass includeArchive: true).';\n"
     "  if (declaredBy.every((id) => coverage.refusedBySource.includes(id))) {\n"
     "    return 'Scope requested: current knowledge and the archive; the archive sources refused.';\n"
     "  }\n"
     "  return 'Searched: current knowledge and the archive (includeArchive: true).';\n",
     "  return coverage.archive?.included === true\n"
     "    ? 'Searched: current knowledge and the archive (includeArchive: true).'\n"
     "    : 'Searched: current knowledge; archive excluded (pass includeArchive: true).';\n",
     {U_SENTENCE, L_SENTENCE}),
    ('drop the opt-in from the search ledger', EXECUTOR,
     '      fanout: fanout.map((entry) => ({ ...entry, archiveIncluded: request.includeArchive === true })),\n',
     '      fanout,\n',
     {U_LEDGER, L_LEDGER}),
    # The page as it was: the stored value overwrites a tick made before the
    # principal read resolved, and that tick is never stored.
    ('remove the Include archive race fix', PAGE,
     '  const archiveTouched=useRef(false);\n'
     '  useEffect(()=>{if(!archiveKey)return;if(archiveTouched.current)writeIncludeArchive(archiveKey,includeArchive);'
     'else setIncludeArchive(readIncludeArchive(archiveKey));},[archiveKey,includeArchive]);\n'
     '  const changeIncludeArchive=(value:boolean)=>{archiveTouched.current=true;setIncludeArchive(value);};\n',
     '  useEffect(()=>{if(archiveKey)setIncludeArchive(readIncludeArchive(archiveKey));},[archiveKey]);\n'
     '  const changeIncludeArchive=(value:boolean)=>{setIncludeArchive(value);if(archiveKey)writeIncludeArchive(archiveKey,value);};\n',
     {F_RACE}),
]

IGNORED = ('.git', 'graphify-out', 'node_modules', 'dist', 'coverage', '__pycache__', '.pytest_cache')
NOT_MEASURED = (
    ('a hook or test outlived its budget', r'Exceeded timeout|Test timed out|Hook timed out'),
    ('a frontend module did not load', r'Failed to load url|Failed to resolve import|Transform failed'),
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


def run_runner(name, command, cwd, report, log_path, env=None):
    timed_out = False
    with log_path.open('w') as log:
        try:
            code = subprocess.run(command, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, env=env,
                                  timeout=SUITE_RUN_TIMEOUT_SECONDS).returncode
        except subprocess.TimeoutExpired:
            code, timed_out = None, True
    result = json.loads(report.read_text()) if report.exists() else {}
    tests = [dict(a, runner=name, fullName=a['fullName'].strip())
             for f in result.get('testResults', []) for a in f.get('assertionResults', [])]
    suite_messages = ' '.join(str(f.get('message', '')) for f in result.get('testResults', []))
    return code, tests, suite_messages, timed_out


def run_suites(copy, out, label):
    backend = run_runner(
        'jest',
        ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--testPathIgnorePatterns=/node_modules/',
         '--runTestsByPath', *SUITES, '--json', f'--outputFile={out / f"{label}.json"}'],
        copy / 'backend', out / f'{label}.json', out / f'{label}.log')
    frontend = run_runner(
        'vitest',
        ['node', 'node_modules/vitest/vitest.mjs', 'run', '--pool=forks', '--maxWorkers=1', '--minWorkers=1',
         *FRONTEND_SUITES, '--reporter=json', f'--outputFile={out / f"{label}.frontend.json"}'],
        copy / 'frontend', out / f'{label}.frontend.json', out / f'{label}.frontend.log',
        env=dict(os.environ, NODE_ENV='test'))
    codes = [backend[0], frontend[0]]
    code = None if None in codes else max(codes)
    suite_messages = re.sub(r'\x1b\[[0-9;]*m', '', backend[2] + ' ' + frontend[2])
    return code, backend[1] + frontend[1], suite_messages, backend[3] or frontend[3]


def at_assertion(test):
    messages = [re.sub(r'\x1b\[[0-9;]*m', '', m) for m in test.get('failureMessages', [])]
    if test['runner'] == 'vitest':
        return bool(messages) and all(m.startswith('expected ') for m in messages)
    return 'expect(' in '\n'.join(messages)


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
    for side in ('backend', 'frontend'):
        if not (ROOT / side / 'node_modules').is_dir():
            raise SystemExit(f'{side}/node_modules is missing: run npm ci in {side}/ first')
    if not args.output_dir:
        raise SystemExit('--output-dir is required')
    out = args.output_dir.resolve()
    if out == ROOT or ROOT in out.parents:
        raise SystemExit('--output-dir must lie outside the repository')
    out.mkdir(parents=True, exist_ok=False)

    before = fingerprints(ROOT)
    copy = Path(tempfile.mkdtemp(prefix='default-scope-drill-'))
    receipts = []
    try:
        shutil.copytree(ROOT, copy, dirs_exist_ok=True, ignore=shutil.ignore_patterns(*IGNORED, '*.log'))
        (copy / 'backend/node_modules').symlink_to((ROOT / 'backend/node_modules').resolve(), target_is_directory=True)
        (copy / 'frontend/node_modules').symlink_to((ROOT / 'frontend/node_modules').resolve(), target_is_directory=True)

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
