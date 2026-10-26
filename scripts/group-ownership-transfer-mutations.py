#!/usr/bin/env python3
"""Mutation drill for AZ-A12 build 3, the Group ownership transfer act (card
311229fd; amendment AZ-A12 clauses 9, 10(b), 12 and 14; drill 11 of the
amendment's test plan).

Each control below edits ONE literal anchor in a disposable copy of the tree -
the standing test, the transfer acts, the owner selector, the creation path or
the Group-owned create's retry scope - and runs three suites, the live one against a REAL disposable
PostgreSQL through the production router and the MCP route:

  backend/src/__tests__/groupOwnershipTransferLive.test.ts (drill 6 and the act's controls)
  backend/src/__tests__/groupOwnerReaderRegister.test.ts   (C-1, the owner-reader register)
  backend/src/__tests__/groupPrincipalRegisters.test.ts    (C-3, the kind-reader register)

A control is RED only when the suites fail at EXACTLY its declared set of
tests, each for an assertion (never a compile error, a timeout or a crashed
fixture). Every control declares a different set, so no two controls can be
satisfied by one assertion, and a mutation that reddens nothing fails the drill.
The source tree is never edited: its bytes are fingerprinted before and after.

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \\
    python3 scripts/group-ownership-transfer-mutations.py --output-dir /tmp/transfer-drill [--only ID,ID]
  python3 scripts/group-ownership-transfer-mutations.py --describe   # checks every anchor, no database
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
    'src/__tests__/groupOwnershipTransferLive.test.ts',
    'src/__tests__/groupOwnerReaderRegister.test.ts',
    'src/__tests__/groupPrincipalRegisters.test.ts',
]
STANDING = 'backend/src/services/GroupOwnershipTransfer.ts'
PROJECT = 'backend/src/services/ProjectOwnershipService.ts'
TASK = 'backend/src/services/TaskAccountOwnershipService.ts'
RETRY = 'backend/src/middleware/idempotency.ts'

# The exact set of tests each control must redden, by title
# (assertionResults[].title), measured on a disposable copy with --measure and
# then read control by control against what the mutation reintroduces.
MUST_FAIL = {
    'D1': {
        "a Main-appointed Connector holding projects:admin is refused person -> Group GROUP_OWNER_SESSION_ONLY, and still moves person -> person",
        "a Task that takes its Group owner from its Project (COALESCE) is a Group source: the standing test applies",
        "a bearer without a token is refused GROUP_OWNER_SESSION_ONLY, never STEP_UP_REQUIRED, on both acts",
        "a session that is neither root nor an administrator is refused GROUP_OWNER_REQUIRES_ADMINISTRATOR and its token stays live (service seam)",
        "creation refuses an editor, a bearer and a missing step-up, and leaves no Project behind",
        "the MCP tool relayhall_task_account_owner_change is refused GROUP_OWNER_SESSION_ONLY for a Group target",
        "the refusal is audited outside the rolled-back transaction: the denied row exists, the object is unchanged",
        "a same-key replay of a Group-owned create by a second credential of the same principal is decided afresh, never served",
    },
    'R1': {
        "a session that is neither root nor an administrator is refused GROUP_OWNER_REQUIRES_ADMINISTRATOR and its token stays live (service seam)",
        "an administrator creates a Group-owned Project with a step-up bound to the allocated id, in one transaction",
        "records kinds, the member count, the step-up token, deciderStanding and the full chain",
        "undo: an operator moves a Project into a Group and back; both audit rows record deciderStanding administrator",
    },
    'O1': {
        "a Task that takes its Group owner from its Project (COALESCE) is a Group source: the standing test applies",
        "a bearer without a token is refused GROUP_OWNER_SESSION_ONLY, never STEP_UP_REQUIRED, on both acts",
        "creation refuses an editor, a bearer and a missing step-up, and leaves no Project behind",
        "the MCP tool relayhall_task_account_owner_change is refused GROUP_OWNER_SESSION_ONLY for a Group target",
        "the refusal is audited outside the rolled-back transaction: the denied row exists, the object is unchanged",
    },
    'A1': {
        "the refusal is audited outside the rolled-back transaction: the denied row exists, the object is unchanged",
    },
    'U1': {
        "a Task that takes its Group owner from its Project (COALESCE) is a Group source: the standing test applies",
        "a disabled Group principal is refused as a Project target and its token stays live",
        "a disabled Group principal is refused as a Task target and its token stays live",
        "a step-up bound to another act or another object is refused STEP_UP_REQUIRED with the challenge for this binding",
        "an administrator creates a Group-owned Project with a step-up bound to the allocated id, in one transaction",
        "clause 9(d): grants are untouched by a transfer into and out of a Group",
        "records kinds, the member count, the step-up token, deciderStanding and the full chain",
        "root and an administrator move a Project person -> Group -> Group -> person and clear a Group-owned Project",
        "root and an administrator move a Task person -> Group -> Group -> person",
        "the Main arm is never a decider once a Group is involved (service seam)",
        "the break-glass dashboard JWT reaches the Project act and not the Task act (R87)",
        "undo on a Task pins an explicit person, and a later Project transfer leaves the Task with that person",
        "undo: an operator moves a Project into a Group and back; both audit rows record deciderStanding administrator",
        "a same-key replay of a Group-owned create by a second credential of the same principal is decided afresh, never served",
    },
    'F1': {
        "an administrator creates a Group-owned Project with a step-up bound to the allocated id, in one transaction",
        "records kinds, the member count, the step-up token, deciderStanding and the full chain",
        "undo: an operator moves a Project into a Group and back; both audit rows record deciderStanding administrator",
    },
    'C1': {
        "owner-candidates lists enabled Groups, featured first, to root and administrator sessions only",
    },
    'M1': {
        "the Main arm is never a decider once a Group is involved (service seam)",
    },
    'T1': {
        "a disabled Group principal is refused as a Project target and its token stays live",
    },
    'K1': {
        "a person owner at creation is refused OWNER_AT_CREATE_GROUP_ONLY",
        "kind-reader register: services/ProjectOwnershipService.ts is classified line by line",
    },
    'T2': {
        "a disabled Group principal is refused as a Task target and its token stays live",
        "kind-reader register: services/TaskAccountOwnershipService.ts is classified line by line",
    },
    'I1': {
        "a same-key replay of a Group-owned create by a second credential of the same principal is decided afresh, never served",
    },
    'E1': {
        "a Task that takes its Group owner from its Project (COALESCE) is a Group source: the standing test applies",
        "backend/src/services/TaskAccountOwnershipService.ts is registered line by line (no unregistered match, no stale entry)",
        "records kinds, the member count, the step-up token, deciderStanding and the full chain",
    },
}

# (id, what it reintroduces, file, anchor, replacement)
CONTROLS = [
    ('D1', 'the standing test admits every caller (steps 1 and 2 removed)', STANDING,
     "  if (!decider.ok) return refuse(decider.status, decider.code, decider.message);\n  const deciderStanding = decider.standing;\n",
     "  const deciderStanding = decider.ok ? decider.standing : 'administrator';\n"),
    ('R1', 'a session holding projects:admin is read as root', STANDING,
     "  if (Array.isArray(standing.scopes) && standing.scopes.includes('root')) return { ok: true, standing: 'root' };",
     "  if (Array.isArray(standing.scopes) && (standing.scopes.includes('root') || standing.scopes.includes('projects:admin'))) return { ok: true, standing: 'root' };"),
    ('O1', 'the step-up is asked for before the standing is tested', STANDING,
     "  // Steps 1 and 2: a login session; root, or an administrator.\n",
     "  if (!input.standing.stepUpToken) return refuse(403, 'STEP_UP_REQUIRED', 'reordered');\n"),
    ('A1', 'the refusal audit is written inside the transaction it rolls back', STANDING,
     "      },\n    }).catch(() => undefined);\n    throw new GroupOwnershipTransferError(status, code, message, challenge);",
     "      },\n    }, client as any).catch(() => undefined);\n    throw new GroupOwnershipTransferError(status, code, message, challenge);"),
    ('U1', 'the step-up is bound to another act than ownership.transfer', STANDING,
     "      action: OWNERSHIP_TRANSFER_STEP_UP_ACTION,\n",
     "      action: 'approval.decide',\n"),
    ('F1', 'the success audit loses the clause 9(f) fields', STANDING,
     "  if (!evidence) return {};\n",
     "  if (!evidence || evidence.deciderStanding) return {};\n"),
    ('C1', 'the owner selector lists Groups to every caller', PROJECT,
     "    if (!standing || !groupTransferDecider(standing).ok) return [];",
     "    if (!standing || !groupTransferDecider({ ...standing, authMethod: 'session', scopes: ['root'] }).ok) return [];"),
    ('M1', 'the appointed Main decides a transfer involving a Group', PROJECT,
     "  if (!groupInvolved && authority && (authority.sessionId || authority.credentialId)",
     "  if ((groupInvolved || !groupInvolved) && authority && (authority.sessionId || authority.credentialId)"),
    ('T1', 'a disabled Group principal is accepted as a Project target', PROJECT,
     "      if (targetRow.status !== 'active' || !evidence) {",
     "      if (!evidence) {"),
    ('K1', 'the create form accepts a person owner', PROJECT,
     "    if (creation && targetRow?.kind !== 'group') {",
     "    if (creation && targetRow?.kind === 'service') {"),
    ('T2', 'a disabled Group principal is accepted as a Task target', TASK,
     "kind='group' AND status='active' FOR SHARE`, [targetId])",
     "kind='group' FOR SHARE`, [targetId])"),
    ('I1', 'the Group-owned create is retried under a principal-scoped operation (the B4 replay class)', RETRY,
     "  'project.groupowned.create': { scope: 'credential', replay: 'return' },",
     "  'project.groupowned.create': { scope: 'principal', replay: 'return' },"),
    ('E1', 'a Task reads its explicit owner, not its effective owner, for the standing test', TASK,
     "        currentOwnerId: effective.rows[0]?.owner ?? null, targetOwnerId: targetId,",
     "        currentOwnerId: (effective.rows[0] ? task.account_owner_principal_id : null) ?? null, targetOwnerId: targetId,"),
]

IGNORED = ('.git', 'graphify-out', 'node_modules', 'dist', 'coverage', '__pycache__', '.pytest_cache')


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
    return url


def run_suites(copy, out, label):
    report = out / f'{label}.json'
    command = ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--testPathIgnorePatterns=/node_modules/',
               '--runTestsByPath', *SUITES, '--json', f'--outputFile={report}']
    with (out / f'{label}.log').open('w') as log:
        code = subprocess.run(command, cwd=copy / 'backend', stdout=log, stderr=subprocess.STDOUT, timeout=1800).returncode
    result = json.loads(report.read_text()) if report.exists() else {}
    tests = [a for f in result.get('testResults', []) for a in f.get('assertionResults', [])]
    suite_messages = ' '.join(str(f.get('message', '')) for f in result.get('testResults', []))
    return code, tests, re.sub(r'\x1b\[[0-9;]*m', '', suite_messages)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--describe', action='store_true')
    parser.add_argument('--measure', action='store_true',
                        help='print each control\'s failing set instead of judging it (to write the must-fail table)')
    parser.add_argument('--only', help='comma-separated control ids to run (the full table is still checked)')
    args = parser.parse_args()

    for _, _, path, anchor, replacement in CONTROLS:
        once((ROOT / path).read_text(), anchor, replacement)
    ids = [c[0] for c in CONTROLS]
    if len(set(ids)) != len(ids):
        raise SystemExit('two controls share an id')
    if not args.measure:
        sets = [frozenset(MUST_FAIL.get(i, ())) for i in ids]
        if set(MUST_FAIL) != set(ids):
            raise SystemExit(f'the must-fail table names {sorted(MUST_FAIL)}, the controls are {sorted(ids)}')
        if len(set(sets)) != len(sets) or any(not s for s in sets):
            raise SystemExit('every control must declare a non-empty must-fail set that no other control shares')
    selected = CONTROLS
    if args.only:
        wanted = set(args.only.split(','))
        unknown = wanted - set(ids)
        if unknown:
            raise SystemExit(f'unknown control ids: {sorted(unknown)}')
        selected = [c for c in CONTROLS if c[0] in wanted]
    if args.describe:
        print(json.dumps([{'id': c[0], 'reintroduces': c[1], 'file': c[2], 'mustFail': sorted(MUST_FAIL.get(c[0], ()))}
                          for c in selected], indent=2))
        print(f'{len(selected)} controls, every anchor found exactly once, every must-fail set distinct')
        return

    require_disposable_database()
    if not args.output_dir:
        raise SystemExit('--output-dir is required')
    out = args.output_dir.resolve()
    if out == ROOT or ROOT in out.parents:
        raise SystemExit('--output-dir must lie outside the repository')
    out.mkdir(parents=True, exist_ok=False)

    before = fingerprints(ROOT)
    copy = Path(tempfile.mkdtemp(prefix='group-transfer-drill-'))
    receipts = []
    closure_green = False
    try:
        shutil.copytree(ROOT, copy, dirs_exist_ok=True, ignore=shutil.ignore_patterns(*IGNORED, '*.log'))
        (copy / 'backend/node_modules').symlink_to((ROOT / 'backend/node_modules').resolve(), target_is_directory=True)

        code, tests, _ = run_suites(copy, out, 'baseline')
        titles = [t['title'] for t in tests]
        if code != 0 or not tests or any(t['status'] != 'passed' for t in tests):
            raise SystemExit('baseline is not green')
        if len(set(titles)) != len(titles):
            raise SystemExit('two tests share a title, so a declared title would not name one test')
        if not args.measure:
            for control_id in ids:
                if not MUST_FAIL[control_id] <= set(titles):
                    raise SystemExit(f'{control_id}: a declared test is absent from the suites: '
                                     f'{sorted(MUST_FAIL[control_id] - set(titles))}')
        print(f'baseline green: {len(titles)} tests', flush=True)

        measured = {}
        for control_id, reintroduces, path, anchor, replacement in selected:
            target = copy / path
            original = target.read_text()
            target.write_text(once(original, anchor, replacement))
            try:
                code, tests, suite_messages = run_suites(copy, out, f'control-{control_id}')
            finally:
                target.write_text(original)
            failed = {t['title'] for t in tests if t['status'] == 'failed'}
            messages = re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(
                m for t in tests if t['status'] == 'failed' for m in t.get('failureMessages', [])))
            clean = code != 0 and sorted(t['title'] for t in tests) == sorted(titles) \
                and all('expect(' in '\n'.join(t.get('failureMessages', [])) for t in tests if t['status'] == 'failed') \
                and not re.search(r'TS\d{4}|SyntaxError|Test suite failed to run|Exceeded timeout|ECONNREFUSED',
                                  messages + suite_messages)
            measured[control_id] = sorted(failed)
            must_fail = MUST_FAIL.get(control_id, set())
            semantic = clean and bool(failed) and (args.measure or failed == set(must_fail))
            receipts.append({'control': control_id, 'reintroduces': reintroduces, 'file': path,
                             'mustFail': sorted(must_fail), 'failed': sorted(failed), 'red': semantic})
            (out / 'receipts.json').write_text(json.dumps(receipts, indent=2))
            print(f"{'RED ' if semantic else 'MISS'} {control_id} {reintroduces} -> {len(failed)} failed", flush=True)
            if not semantic:
                print(f'   expected {sorted(must_fail)}\n   failed   {sorted(failed)}', flush=True)
        if args.measure:
            (out / 'measured.json').write_text(json.dumps(measured, indent=2, sort_keys=True))

        code, tests, _ = run_suites(copy, out, 'closure')
        closure_green = code == 0 and all(t['status'] == 'passed' for t in tests) and sorted(t['title'] for t in tests) == sorted(titles)
        print(f"closure baseline {'green' if closure_green else 'NOT GREEN'}", flush=True)
    finally:
        shutil.rmtree(copy, ignore_errors=True)
        after = fingerprints(ROOT)
        (out / 'source-closure.json').write_text(json.dumps({
            'sourceUnchanged': before == after, 'copyRemoved': not copy.exists(), 'controls': len(receipts),
        }, indent=2))
    if before != fingerprints(ROOT):
        raise SystemExit('the source tree changed during the drill')
    misses = [r['control'] for r in receipts if not r['red']]
    if misses or not closure_green:
        raise SystemExit(f'controls that did not fail at their declared assertions: {misses}; closure green: {closure_green}')
    print(f'all {len(receipts)} controls red at their declared assertions; closure green; source unchanged')


if __name__ == '__main__':
    main()
