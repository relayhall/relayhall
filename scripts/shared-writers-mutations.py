#!/usr/bin/env python3
"""Mutation drill for the shared-area writer list (card 549cc51f; owner rulings
E298, E299 with the F1 repair, E310).

Each control below edits ONE literal anchor in a disposable copy of the tree and
runs four backend suites, the live one against a REAL disposable PostgreSQL
through the production router and the MCP ingress:

  backend/src/__tests__/knowledgeSharedWritersLive.test.ts  (router + MCP + stored rows)
  backend/src/__tests__/knowledgeSharedWriters.test.ts      (input rules, source resolution)
  backend/src/__tests__/knowledgeLifecycleExporter.test.ts  (the snapshot element)
  backend/src/__tests__/c4McpSurface.test.ts                (the MCP surface census)

The five controls are the five the lane brief names: remove the administrator
gate; remove the step-up consume; accept a bearer credential; remove the E299
F3 filter from the exporter; compose the list's write path from an MCP tool.

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
    python3 scripts/shared-writers-mutations.py --output-dir /tmp/shared-writers-drill
  python3 scripts/shared-writers-mutations.py --describe   # checks every anchor, no database
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
    'src/__tests__/knowledgeSharedWritersLive.test.ts',
    'src/__tests__/knowledgeSharedWriters.test.ts',
    'src/__tests__/knowledgeLifecycleExporter.test.ts',
    'src/__tests__/c4McpSurface.test.ts',
]
ROUTES = 'backend/src/routes/knowledgeSharedWriters.ts'
SERVICE = 'backend/src/services/KnowledgeSharedWriterService.ts'
EXPORTER = 'backend/src/services/KnowledgeLifecycleExporter.ts'
REGISTRY = 'backend/src/mcp/registry.ts'

# The declared tests, by their full jest names.
G = '(G) the gate on a change - every refusal named, audited, nothing written, no step-up spent '
L = '(L) the list - a services:read disclosure; the administration view for administrators only '
A = '(A) the acts - one transaction, one audit row each, the step-up burned with the write '
S = '(S) the snapshot element (E299 F3) '
P = '(P) MCP - one read tool, no write path '
X = 'shared_writers (card 549cc51f) '
L_ADMIN_VIEW = L + ('the administration view is answered to a root or an administrator session only: an editor session, '
                    'a bearer and an API key are refused by name')
G_BEARER = G + 'an rh_ bearer holding root is refused SHARED_WRITER_REQUIRES_SESSION, audited, nothing written, its step-up unspent'
G_LEGACY = G + 'the legacy API key is refused SHARED_WRITER_REQUIRES_SESSION, audited, nothing written'
G_EDITOR = G + 'a non-administrator session is refused SHARED_WRITER_REQUIRES_ADMINISTRATOR, audited, nothing written, its step-up unspent'
G_MISSING = G + 'a missing step-up is refused STEP_UP_REQUIRED with the challenge, audited, nothing written'
G_WRONG = G + 'a step-up minted for the other act, or for another Account, is refused STEP_UP_REQUIRED and stays unspent'
G_REPLAY = G + 'a replayed step-up is refused: the token is single-use'
A_ACTS = A + ('a root session adds and removes; each act writes one audit row with the before and after list, the reason '
              'and the step-up token id')
A_OPERATOR = A + 'an administrator (operator) session adds with standing administrator'
A_RETRY = A + ('a keyed retry of an add replays the stored answer; the same key from a bearer of the same Account is '
               'refused, not replayed')
S_E299 = S + ('THE E299 TEST, live: a listed Account outside the export selection does not deny the snapshot; the element '
              'omits it')
S_DISABLED = S + 'a disabled listed Account is dropped from the element at once'
X_E299 = X + ('THE E299 TEST: a listed Account outside the export selection does not deny the snapshot; the element omits it')
X_ACTIVE = X + 'only ACTIVE exported human Accounts are emitted: a disabled, a service and an unknown id are dropped'
X_CAP = X + 'the writer-list read cap: 10000 rows are carried, 10001 refuse the whole snapshot'
P_READ = P + 'MCP: relayhall_knowledge_shared_writers_list reads the list through the ingress, with youCanWrite for the caller'
P_NO_WRITE = P + 'MCP: no tool reaches the writer-list changes'
C4_READ_ONLY = 'what stays out of the agent plane reaches the shared-area writer list only to READ it (card 549cc51f, E310)'

# (name, file, anchor, replacement, the exact set of tests that must fail)
CONTROLS = [
    # (1) The administrator gate: every login session is given administrator
    # standing. The editor's add (with a live step-up of its own) succeeds,
    # and the editor reads the administration view.
    ('remove the administrator gate', ROUTES,
     "  if (administrator.ok) return { ok: true, standing: 'administrator' };\n  return administrator;\n}\n",
     "  if (administrator.ok) return { ok: true, standing: 'administrator' };\n"
     "  return { ok: true, standing: 'administrator' };\n}\n",
     {G_EDITOR, L_ADMIN_VIEW}),
    # (2) The step-up consume: the act no longer spends, or needs, a token.
    ('remove the step-up consume', SERVICE,
     "      const stepUp = await stepUpService.consume(client, {\n"
     "        token: typeof input.stepUpToken === 'string' ? input.stepUpToken : '',\n"
     "        principalId: input.principalId,\n"
     "        action: SHARED_WRITER_STEP_UP_ACTIONS[kind],\n"
     "        targetId: accountId,\n"
     "      });\n",
     "      void stepUpService;\n"
     "      const stepUp = { tokenId: '00000000-0000-4000-8000-000000000000', method: 'mutated' };\n",
     {G_MISSING, G_WRONG, G_REPLAY, A_ACTS, A_OPERATOR}),
    # (3) A bearer credential (or the legacy key) reaches the standing test,
    # where a root-holding bearer is admitted as root. The keyed-retry case
    # (A_RETRY) is NOT declared: its bearer holds no root, so with this gate
    # gone administratorSessionOf still refuses it by the same code, and the
    # case stays green (measured: the first run declared it and MISSED).
    ('accept a bearer credential', ROUTES,
     "  if (!isLoginSessionKind(req.authMethod)) {\n    return administrator.ok\n",
     "  if (!isLoginSessionKind(req.authMethod) && req.authMethod === undefined) {\n    return administrator.ok\n",
     {G_BEARER, G_LEGACY, L_ADMIN_VIEW}),
    # (4) E299 F3: the element names every listed id, exported or not.
    ('remove the F3 filter from the snapshot element', EXPORTER,
     '.filter(id=>ids.has(id)).sort()}];',
     '.sort()}];',
     {X_E299, X_ACTIVE, X_CAP, S_E299, S_DISABLED}),
    # (5) The MCP read tool composes the list's write path instead.
    ('compose the write path from an MCP tool', REGISTRY,
     "board(ctx, { method: 'GET', path: '/knowledge-shared-writers'",
     "board(ctx, { method: 'POST', path: '/knowledge-shared-writers'",
     {C4_READ_ONLY, P_READ, P_NO_WRITE}),
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
    copy = Path(tempfile.mkdtemp(prefix='shared-writers-drill-'))
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
