#!/usr/bin/env python3
"""Mutation drill for AZ-A12 build 2, the Group-owner arm (card ee81ee0f;
amendment AZ-A12 clauses 6-8; drill 11 of the amendment's test plan).

Each control below edits ONE literal anchor in a disposable copy of the tree -
the evaluator, its one shared Group-owner fragment, or a census-bound line - and
runs four suites, the live one against a REAL disposable PostgreSQL through the
production router:

  backend/src/__tests__/groupOwnerArmLive.test.ts        (drills 1, 2, 3, 4, 8, 10)
  backend/src/__tests__/groupOwnerArmParity.test.ts      (tier choice, one fragment, Account side, restriction, fast path)
  backend/src/__tests__/groupOwnerReaderRegister.test.ts (C-1, the owner-reader register)
  backend/src/__tests__/groupPrincipalRegisters.test.ts  (C-3, the kind-reader register of build 1)

A control is RED only when the suites fail at EXACTLY its declared set of
tests, each for an assertion (never a compile error, a timeout or a crashed
fixture). Every control declares a different set, so no two controls can be
satisfied by one assertion, and a mutation that reddens nothing fails the drill.
The source tree is never edited: its bytes are fingerprinted before and after.

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \\
    python3 scripts/group-owner-mutations.py --output-dir /tmp/group-owner-drill [--only ID,ID]
  python3 scripts/group-owner-mutations.py --describe   # checks every anchor, no database
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
    'src/__tests__/groupOwnerArmLive.test.ts',
    'src/__tests__/groupOwnerArmParity.test.ts',
    'src/__tests__/groupOwnerReaderRegister.test.ts',
    'src/__tests__/groupPrincipalRegisters.test.ts',
]
FRAGMENT = 'backend/src/utils/groupOwnerCondition.ts'
EVALUATOR = 'backend/src/services/AuthorizationService.ts'

# The exact set of tests each control must redden, by title (assertionResults[].title).
# Each set was measured on a disposable copy and then read control by control
# against what the mutation reintroduces (a mutation that widens the edit tier
# reddens every test that reads it; a census-bound line also reddens its
# register case). No two controls share a set.
MUST_FAIL = {
    'T1': {
        'maps every evaluator action to exactly one tier, and admin, shepherd and verify to none',
        'renders no Group arm for admin on any type, on either plane',
    },
    'T2': {
        'a disabled member and a terminated member lose the tier',
        'the use tier tests membership only; the edit tier composes the live-steward fragment',
    },
    'T3': {
        'a disabled Group principal suspends every tier; its Group grants still work (N3)',
        'the use tier tests membership only; the edit tier composes the live-steward fragment',
    },
    'T4': {
        'kind-reader register: utils/groupOwnerCondition.ts is classified line by line',
        'the use tier tests membership only; the edit tier composes the live-steward fragment',
    },
    'T5': {
        'a Connector under a manager writes through own() = parent and is capped by an own() that excludes the Task',
        'a disabled Group principal suspends every tier; its Group grants still work (N3)',
        'a disabled member and a terminated member lose the tier',
        # Card b5c83682 (LENSES-c gate (i), D-11) renamed this drill-10 row.
        'a manager is refused CHARTER_APPROVAL_FORBIDDEN; an owner-role holder without a step-up is asked for one (gate (i), D-11); an administrator is allowed',
        'a manager writes, claims, finishes and releases but gets no admin, shepherd or verify',
        'a restricted Phase is not readable by a member and stays writable by managers and owners',
        "an Agent under a manager's Connector is capped to its bound Task (T36)",
        'an inert role row (holder not a member) confers nothing; joining makes it live',
        'an owner-role holder gets exactly the manager tier: admin on the object is refused',
        "path (a): a Task with no explicit account owner takes its Project's Group tiers",
        'path (b): a Task someone else owns is read by members and written (task write subset only) by managers',
        "restriction: a restricted Task and a Task under a restricted Phase suppress path (b) for every tier and path (a)'s use tier",
        'the in-memory fast path never allows on a Group owner value; the SQL adapter does',
        'the mint ceiling admits rows inside the Group-owned Project and refuses rows outside it',
        'the use tier tests membership only; the edit tier composes the live-steward fragment',
    },
    'A1': {
        'a restricted Phase is not readable by a member and stays writable by managers and owners',
        'a restricted shape keeps the edit tier and gates the use tier on read',
        "restriction: a restricted Task and a Task under a restricted Phase suppress path (b) for every tier and path (a)'s use tier",
    },
    'B1': {
        'path (b) reads the Project owner under the anchor and NOT restricted, for the Task write subset only',
        "restriction: a restricted Task and a Task under a restricted Phase suppress path (b) for every tier and path (a)'s use tier",
    },
    'B2': {
        'an archived Project fails path (b) closed',
        'path (b) reads the Project owner under the anchor and NOT restricted, for the Task write subset only',
    },
    'B3': {
        'a directory membership removed by the sync loses the member tier',
        'a member reads and uses but does not write, on every Group-owned type',
        'a member with no live role row gets only the member tier',
        "path (a): a Task with no explicit account owner takes its Project's Group tiers",
        'path (b) reads the Project owner under the anchor and NOT restricted, for the Task write subset only',
        'path (b): a Task someone else owns is read by members and written (task write subset only) by managers',
        'the mint ceiling admits rows inside the Group-owned Project and refuses rows outside it',
    },
    'B4': {
        'path (b) reads the Project owner under the anchor and NOT restricted, for the Task write subset only',
        'path (b): a Task someone else owns is read by members and written (task write subset only) by managers',
    },
    'C1': {
        'a parented legacy identity on the Account plane gets no Group arm',
    },
    'C2': {
        'a Connector under a manager writes through own() = parent and is capped by an own() that excludes the Task',
        'a delegated link gains path (b) only through its Account side',
        "an Agent under a manager's Connector is capped to its bound Task (T36)",
        'both planes and every Group-ownable type render the SAME fragment text',
        'on the chain, read: the Group arms are Account-link sources and never inside authorityCore',
        'on the chain, write: the Group arms are Account-link sources and never inside authorityCore',
        'the mint ceiling admits rows inside the Group-owned Project and refuses rows outside it',
    },
    'M1': {
        'backend/src/services/AuthorizationService.ts is registered line by line (no unregistered match, no stale entry)',
        'phase: every action falls through to SQL',
        'project: every action falls through to SQL',
        'report: every action falls through to SQL',
        'task: every action falls through to SQL',
        'the in-memory fast path never allows on a Group owner value; the SQL adapter does',
    },
    'R1': {
        'backend/src/utils/groupOwnerCondition.ts is registered line by line (no unregistered match, no stale entry)',
    },
}

# (id, what it reintroduces, file, anchor, replacement, the exact set of tests that must fail)
CONTROLS = [
    ('T1', 'the admin action is admitted through the edit tier', FRAGMENT,
     "  if (GROUP_EDIT_TIER_ACTIONS.includes(action)) return 'edit';",
     "  if (GROUP_EDIT_TIER_ACTIONS.includes(action) || action === 'admin') return 'edit';",
     None),
    ('T2', 'the use tier stops requiring an ACTIVE member', FRAGMENT,
     "                AND owning_group_account.status = 'active'\n", '',
     None),
    ('T3', 'a disabled Group principal keeps conferring its tiers', FRAGMENT,
     "                AND owning_group.status = 'active'\n", '',
     None),
    ('T4', 'the owner value no longer has to name a principal of kind group', FRAGMENT,
     "                AND owning_group.kind = 'group'\n", '',
     None),
    ('T5', 'the edit tier is reached by an owner row only (a manager loses it)', FRAGMENT,
     "      roles: \"ARRAY['owner', 'manager']::text[]\",", "      roles: \"ARRAY['owner']::text[]\",",
     None),
    ('A1', 'a restricted Phase or Task no longer suppresses the use tier on path (a)', EVALUATOR,
     "          found.push({ basis: 'group-owner', sql: `((NOT (${resource.restrictedAccess}) AND ${member}) OR ${steward})` });",
     "          found.push({ basis: 'group-owner', sql: `(${member} OR ${steward})` });",
     None),
    ('B1', 'path (b) is no longer suppressed by restriction', EVALUATOR,
     "          sql: `((${resource.inheritanceAnchor}) AND NOT (${resource.restrictedAccess})`",
     "          sql: `((${resource.inheritanceAnchor}) AND NOT (FALSE)`",
     None),
    ('B2', 'path (b) no longer needs the live Project anchor', EVALUATOR,
     "          sql: `((${resource.inheritanceAnchor}) AND NOT (${resource.restrictedAccess})`",
     "          sql: `((TRUE) AND NOT (${resource.restrictedAccess})`",
     None),
    ('B3', 'path (b) writes with the member (use) tier', EVALUATOR,
     "        const tier = action === 'read' ? 'use' : 'edit';",
     "        const tier = action === 'read' ? 'use' : 'use';",
     None),
    ('B4', 'path (b) admits every action but admin (use, invoke, shepherd, verify)', EVALUATOR,
     "        && inheritedProjectGrantAllows('write', action)) {",
     "        && action !== 'admin') {",
     None),
    ('C1', 'a parented legacy identity is evaluated for the Group tier on the Account plane', EVALUATOR,
     "      if (actor.principalId && !actor.delegation?.links?.[0]?.parentPrincipalId) {",
     "      if (actor.principalId) {",
     None),
    ('C2', 'the chain Account side loses the Group-owner arm', EVALUATOR,
     "        for (const arm of groupOwnerArms(() => accountGroupParam ?? (accountGroupParam = nextParam(link.principalId)))) {",
     "        for (const arm of (link.principalId === '' ? groupOwnerArms(() => accountGroupParam ?? (accountGroupParam = nextParam(link.principalId))) : [])) {",
     None),
    ('M1', 'the in-memory fast path allows on any account owner value, a Group included', EVALUATOR,
     "    if (samePrincipal(actor, resource.accountOwnerPrincipalId)\n",
     "    if (samePrincipal(actor, resource.accountOwnerPrincipalId) || Boolean(resource.accountOwnerPrincipalId)\n",
     None),
    ('R1', 'a new owner reference lands without a C-1 classification', FRAGMENT,
     "export type GroupOwnerTier = 'use' | 'edit';",
     "export type GroupOwnerTier = 'use' | 'edit'; // ownerPrincipalId",
     None),
]
CONTROLS = [c[:5] + (MUST_FAIL[c[0]],) for c in CONTROLS]

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
    parser.add_argument('--only', help='comma-separated control ids to run (the full table is still checked)')
    args = parser.parse_args()

    for _, _, path, anchor, replacement, _ in CONTROLS:
        once((ROOT / path).read_text(), anchor, replacement)
    ids = [c[0] for c in CONTROLS]
    sets = [frozenset(c[5] or ()) for c in CONTROLS]
    if len(set(ids)) != len(ids):
        raise SystemExit('two controls share an id')
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
        print(json.dumps([{'id': c[0], 'reintroduces': c[1], 'file': c[2], 'mustFail': sorted(c[5])} for c in selected], indent=2))
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
    copy = Path(tempfile.mkdtemp(prefix='group-owner-drill-'))
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
        for control in CONTROLS:
            if not set(control[5]) <= set(titles):
                raise SystemExit(f'{control[0]}: a declared test is absent from the suites: {sorted(set(control[5]) - set(titles))}')
        print(f'baseline green: {len(titles)} tests', flush=True)

        for control_id, reintroduces, path, anchor, replacement, must_fail in selected:
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
            semantic = code != 0 and sorted(t['title'] for t in tests) == sorted(titles) and failed == set(must_fail) \
                and all('expect(' in '\n'.join(t.get('failureMessages', [])) for t in tests if t['status'] == 'failed') \
                and not re.search(r'TS\d{4}|SyntaxError|Test suite failed to run|Exceeded timeout|ECONNREFUSED',
                                  messages + suite_messages)
            receipts.append({'control': control_id, 'reintroduces': reintroduces, 'file': path,
                             'mustFail': sorted(must_fail), 'failed': sorted(failed), 'red': semantic})
            (out / 'receipts.json').write_text(json.dumps(receipts, indent=2))
            print(f"{'RED ' if semantic else 'MISS'} {control_id} {reintroduces} -> {len(failed)} failed", flush=True)
            if not semantic:
                print(f'   expected {sorted(must_fail)}\n   failed   {sorted(failed)}', flush=True)

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
