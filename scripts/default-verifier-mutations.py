#!/usr/bin/env python3
"""Mutation drill for the default Verifier (card 41e24358; design ba22fd01,
ratified E298).

Each control below edits literal anchors in a disposable copy of the tree, runs
`backend/src/__tests__/defaultVerifierLive.test.ts` against a REAL disposable
PostgreSQL through the production router and the MCP ingress, and requires the
suite to go red at EXACTLY the predeclared set of tests, for an assertion (not
a compile error, a timeout or a crashed fixture). Every control reddens a
different set, so no two controls can be satisfied by one assertion.

The controls withdraw, one at a time, what the ratified design says must hold:
the Phase step of the inheritance order (Part 3), each arm of the usable
predicate (Part 4: principal, chain, scope, independence), the Review warning's
never-a-refusal rule on the move, the finish and the create (Part 5, E284), the
MCP create's defaults-only rule and its non-archived-Phase clause (Part 6,
Q2 (b)), and the default write's
session-only gate, its owner arm and its Group refusal (Part 2), and the Phase
route's refusal choice (owner ruling E311, card 5216d735): a readable non-owner
answered by name, an unreadable or restricted Phase concealed.
The source tree is never edited: its bytes are fingerprinted before and after.

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \\
    python3 scripts/default-verifier-mutations.py --output-dir /tmp/default-verifier-drill
  python3 scripts/default-verifier-mutations.py --describe   # checks every anchor, no database
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
SUITE = 'src/__tests__/defaultVerifierLive.test.ts'
TASKS = 'backend/src/services/TaskManagerDB.ts'
VERIFIER = 'backend/src/services/VerifierUsability.ts'
ROUTE = 'backend/src/routes/tasks.ts'
DEFAULT_ROUTE = 'backend/src/routes/defaultVerifierRoute.ts'
POINT_STAGE = 'backend/src/middleware/sharedAuthorization.ts'

# The tests each control must turn red, by title (assertionResults[].title).
ORDER_PHASE = 'order 2 - Phase beats Project: the landing Phase default is inherited-phase'
ORDER_INBOX = 'order 2b - the inbox decision comes first: a card without phaseId takes the inbox Phase default'
ROLE_AUDIT = 'the inherited role write is audited with its source and where it came from'
UNUSABLE_DEFAULT = ('a disabled Project default leaves the card without a Verifier and answers 201 with '
                    'DEFAULT_VERIFIER_UNUSABLE')
ARM_PRINCIPAL = 'arm principal: a disabled principal'
ARM_CHAIN = 'arm chain: a Connector whose last credential is revoked'
ARM_SCOPE = 'arm scope: a Connector whose only credential lacks tasks:write'
ARM_INDEPENDENCE = 'arm independence: the Verifier is the Assignee'
PARITY = 'point/list parity: GET /tasks?verifierUnusable=true lists exactly the cards the point check finds unusable'
BOARD = 'the board read and MCP task_list carry the same filter'
TASK_READ = 'the Task read carries the predicate for the Review banner'
CANDIDATES = 'candidates: usable people and Connectors, never a Group, an Agent or an unusable principal'
BLOCK_PATCH = ('never-blocking: REST PATCH into Review without a Verifier answers 200 with the warning, '
               'and the move committed')
BLOCK_MCP_MOVE = 'never-blocking: MCP task_move prints the warning and is not an error'
BLOCK_FINISH = 'never-blocking: REST finish into Review answers 200 with the warning'
BLOCK_MCP_FINISH = 'never-blocking: MCP task_finish prints the warning line'
BLOCK_CREATE = 'never-blocking: a card created directly in Review without a Verifier answers 201 with the warning'
MCP_REFUSAL = 'mcp-refusal: a non-default principal is refused VERIFIER_NOT_ALLOWED and no card exists'
MCP_UNUSABLE = 'mcp-refusal: a default that cannot judge is refused too'
MCP_ARCHIVED_PHASE = 'mcp-refusal: an archived Phase default named explicitly is refused over MCP and REST'
GATE_GRANT = 'route-gate grant: a Project write Grant is not ownership'
GATE_READABLE = ('route-gate readable non-owner: read on the Phase or on its Project reaches the named 403 on the '
                 'Phase route, audited once each')
GATE_UNREADABLE = ('route-gate unreadable: a caller who can read neither the Phase nor its Project is concealed 404 '
                   'on both routes, with no audit row')
GATE_RESTRICTED = ('route-gate restricted Phase: read on its Project alone does not reach a restricted Phase, which '
                   'stays concealed 404 with no audit row')
GATE_BEARER = 'route-gate bearer: a Connector credential is refused SESSION_ONLY and audited'
GATE_GROUP_OWNED = 'route-gate group-owned: only root or an administrator on a Group-owned Project (Q3 (a))'
GATE_VALUES = 'route-gate values: a Group and an Agent are refused by name, an unusable principal names its arm'

REFUSE = "sendApiError(res, 409, 'VERIFIER_NOT_USABLE', 'refused'); return;"

# (name, [(file, anchor, replacement), ...], the exact set of tests that must fail)
CONTROLS = [
    ('Part 3 (brief: drop the Phase arm): the landing Phase default is never read', [
        (TASKS, "      if (phaseId) {\n        const phase = await client.query('SELECT default_verifier_principal_id FROM phases WHERE id = $1', [phaseId]);",
         "      if (phaseId && phaseId === 'never') {\n        const phase = await client.query('SELECT default_verifier_principal_id FROM phases WHERE id = $1', [phaseId]);"),
    ], {ORDER_PHASE, ORDER_INBOX, ROLE_AUDIT}),
    ('Part 4 arm 4 (brief: drop the Assignee check): a Verifier equal to the Assignee is usable', [
        (VERIFIER, "  if (!verifierIsIndependent(verifier, card.ownerPrincipalId)) {",
         "  if (!verifierIsIndependent(verifier, card.ownerPrincipalId) && verifier === 'never') {"),
    ], {ARM_INDEPENDENCE}),
    ('Part 4 arm 1: a non-active principal passes the principal arm', [
        (VERIFIER, "  if (!row || String(row.status) !== 'active' || row.kind === 'group') {",
         "  if (!row || row.kind === 'group') {"),
    ], {ARM_PRINCIPAL, UNUSABLE_DEFAULT, PARITY}),
    ('Part 4 arm 2: a dead chain passes the chain arm', [
        (VERIFIER, "  if (!chain.alive) return { usable: false, failedArm: 'chain' };",
         "  if (!chain.alive && chain.links.length < 0) return { usable: false, failedArm: 'chain' };"),
    ], {ARM_CHAIN, TASK_READ, PARITY}),
    ('Part 4 arm 3: tasks:write is not required', [
        (VERIFIER, "    if (scopesSatisfy(effective, VERIFIER_REQUIRED_SCOPE)) return { usable: true };",
         "    if (scopesSatisfy(effective, VERIFIER_REQUIRED_SCOPE) || effective.length >= 0) return { usable: true };"),
    ], {ARM_SCOPE, PARITY, BOARD, MCP_UNUSABLE, GATE_VALUES, CANDIDATES}),
    ('Part 5 / E284 (brief: turn the warning into a refusal): the Review move refuses without a usable Verifier', [
        (ROUTE, "    const verifierWarnings = updates.status === 'review' && priorStatus !== 'review'\n"
                "      ? await reviewVerifierWarnings(req, task.id) : [];\n",
         "    const verifierWarnings = updates.status === 'review' && priorStatus !== 'review'\n"
         "      ? await reviewVerifierWarnings(req, task.id) : [];\n"
         f"    if (verifierWarnings.length > 0) {{ {REFUSE} }}\n"),
    ], {BLOCK_PATCH, BLOCK_MCP_MOVE}),
    ('Part 5 / E284: finish refuses without a usable Verifier', [
        (ROUTE, "      ? await reviewVerifierWarnings(req, req.params.id) : [];\n",
         "      ? await reviewVerifierWarnings(req, req.params.id) : [];\n"
         f"    if (verifierWarnings.length > 0) {{ {REFUSE} }}\n"),
    ], {BLOCK_FINISH, BLOCK_MCP_FINISH}),
    ('Part 5 / E284: a create directly in Review refuses without a usable Verifier', [
        (ROUTE, "      ...(task.status === 'review' ? await reviewVerifierWarnings(req, task.id) : []),\n    ];\n",
         "      ...(task.status === 'review' ? await reviewVerifierWarnings(req, task.id) : []),\n    ];\n"
         f"    if (createWarnings.some((entry) => entry.code === 'VERIFIER_NOT_USABLE')) {{ {REFUSE} }}\n"),
    ], {BLOCK_CREATE}),
    ('Part 6 / Q2 (b) (brief: accept any Verifier over MCP): a non-default principal is admitted', [
        (TASKS, "      if (!defaults.rows.some((row) => String(row.id).toLowerCase() === value)) throw notAllowed('not a default of this Project');",
         "      if (!defaults.rows.some((row) => String(row.id).toLowerCase() === value) && value === 'never') throw notAllowed('not a default of this Project');"),
    ], {MCP_REFUSAL, MCP_ARCHIVED_PHASE}),
    ('Part 6 / Q2 (b): an archived Phase still lends its default to an explicit choice', [
        (TASKS, "WHERE ph.project_id = $1 AND ph.status <> 'archived' AND ph.default_verifier_principal_id IS NOT NULL",
         "WHERE ph.project_id = $1 AND ph.default_verifier_principal_id IS NOT NULL"),
    ], {MCP_ARCHIVED_PHASE}),
    ('Part 2: the default write admits a bearer credential', [
        (DEFAULT_ROUTE, "  if (!isLoginSessionKind(authReq.authMethod)) {",
         "  if (!isLoginSessionKind(authReq.authMethod) && String(authReq.authMethod) === 'never') {"),
    ], {GATE_BEARER}),
    ('Part 2 / Q3 (a): write authority that is not ownership sets the default', [
        (DEFAULT_ROUTE, "  if (owner.kind === 'human' && owner.id && facts.principalId && owner.id === facts.principalId) return 'owner';\n  return null;",
         "  if (owner.kind === 'human' && owner.id && facts.principalId && owner.id === facts.principalId) return 'owner';\n  return 'owner';"),
    ], {GATE_GRANT, GATE_GROUP_OWNED, GATE_READABLE}),
    ('E311 (card 5216d735): the Phase route conceals a readable non-owner again', [
        (POINT_STAGE, "    if (!point.allowed && point.exists && req.method.toUpperCase() === 'PUT'",
         "    if (!point.allowed && point.exists && req.method.toUpperCase() === 'NEVER'"),
    ], {GATE_READABLE}),
    ('E311: the concealment rule is dropped, so a caller who cannot read the Phase reaches the handler', [
        (POINT_STAGE, "      && (!point.concealed || await phaseReadableThroughProject(actor, String(point.resourceId)))) {",
         "      && (point.exists || await phaseReadableThroughProject(actor, String(point.resourceId)))) {"),
    ], {GATE_UNREADABLE, GATE_RESTRICTED}),
    ('E311 / ruling 44ee41f2: a restricted Phase lends its Project read to the refusal choice', [
        (POINT_STAGE, "  if (!row || row.restricted_access) return false;", "  if (!row) return false;"),
    ], {GATE_RESTRICTED}),
    ('Part 2 / AZ-A12 clause 3(c): a Group value is not refused by name', [
        (DEFAULT_ROUTE, "  if (row?.kind === 'group') {", "  if (row?.kind === 'group' && row.id === 'never') {"),
    ], {GATE_VALUES}),
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


def run_suite(copy, out, label):
    report = out / f'{label}.json'
    command = ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--testPathIgnorePatterns=/node_modules/',
               '--runTestsByPath', SUITE, '--json', f'--outputFile={report}']
    with (out / f'{label}.log').open('w') as log:
        code = subprocess.run(command, cwd=copy / 'backend', stdout=log, stderr=subprocess.STDOUT, timeout=900).returncode
    result = json.loads(report.read_text()) if report.exists() else {}
    tests = [a for f in result.get('testResults', []) for a in f.get('assertionResults', [])]
    suite_messages = ' '.join(str(f.get('message', '')) for f in result.get('testResults', []))
    return code, tests, re.sub(r'\x1b\[[0-9;]*m', '', suite_messages)


def apply(copy, edits):
    """Apply every edit of one control; return the originals to restore."""
    originals = {}
    for path, anchor, replacement in edits:
        target = copy / path
        text = target.read_text()
        originals.setdefault(path, text)
        target.write_text(once(text, anchor, replacement))
    return originals


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--describe', action='store_true')
    args = parser.parse_args()

    for _, edits, _ in CONTROLS:
        texts = {}
        for path, anchor, replacement in edits:
            texts[path] = once(texts.get(path, (ROOT / path).read_text()), anchor, replacement)
    sets = [frozenset(c[2]) for c in CONTROLS]
    if len(set(sets)) != len(sets) or any(not s for s in sets):
        raise SystemExit('every control must declare a non-empty must-fail set that no other control shares')
    if args.describe:
        print(json.dumps([{'control': c[0], 'files': sorted({e[0] for e in c[1]}), 'mustFail': sorted(c[2])}
                          for c in CONTROLS], indent=2))
        return

    require_disposable_database()
    if not args.output_dir:
        raise SystemExit('--output-dir is required')
    out = args.output_dir.resolve()
    if out == ROOT or ROOT in out.parents:
        raise SystemExit('--output-dir must lie outside the repository')
    out.mkdir(parents=True, exist_ok=False)

    before = fingerprints(ROOT)
    copy = Path(tempfile.mkdtemp(prefix='default-verifier-drill-'))
    receipts = []
    try:
        shutil.copytree(ROOT, copy, dirs_exist_ok=True, ignore=shutil.ignore_patterns(*IGNORED, '*.log'))
        (copy / 'backend/node_modules').symlink_to((ROOT / 'backend/node_modules').resolve(), target_is_directory=True)

        code, tests, _ = run_suite(copy, out, 'baseline')
        titles = [t['title'] for t in tests]
        if code != 0 or not tests or any(t['status'] != 'passed' for t in tests):
            raise SystemExit('baseline is not green')
        if len(set(titles)) != len(titles):
            raise SystemExit('two tests share a title, so a declared title would not name one test')
        for _, _, must_fail in CONTROLS:
            if not set(must_fail) <= set(titles):
                raise SystemExit(f'a declared test is absent from the suite: {sorted(set(must_fail) - set(titles))}')

        for index, (name, edits, must_fail) in enumerate(CONTROLS, start=1):
            originals = apply(copy, edits)
            try:
                code, tests, suite_messages = run_suite(copy, out, f'control-{index}')
            finally:
                for path, text in originals.items():
                    (copy / path).write_text(text)
            failed = {t['title'] for t in tests if t['status'] == 'failed'}
            messages = re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(
                m for t in tests if t['status'] == 'failed' for m in t.get('failureMessages', [])))
            semantic = code != 0 and [t['title'] for t in tests] == titles and failed == set(must_fail) \
                and all('expect(' in '\n'.join(t.get('failureMessages', [])) for t in tests if t['status'] == 'failed') \
                and not re.search(r'TS\d{4}|SyntaxError|Test suite failed to run|Exceeded timeout|ECONNREFUSED',
                                  messages + suite_messages)
            receipts.append({'control': name, 'files': sorted({e[0] for e in edits}), 'mustFail': sorted(must_fail),
                             'failed': sorted(failed), 'red': semantic})
            (out / 'receipts.json').write_text(json.dumps(receipts, indent=2))
            print(f"{'RED ' if semantic else 'MISS'} {name} -> {sorted(failed)}", flush=True)
            if not semantic:
                raise SystemExit(f'control did not fail at its declared assertions: {name}')

        # Restored: the copy is green again, byte for byte the source.
        code, tests, _ = run_suite(copy, out, 'restored')
        if code != 0 or [t['title'] for t in tests] != titles or any(t['status'] != 'passed' for t in tests):
            raise SystemExit('the restored copy is not green')
    finally:
        restored = {k: v for k, v in fingerprints(copy).items() if k in before} if copy.exists() else {}
        shutil.rmtree(copy, ignore_errors=True)
        after = fingerprints(ROOT)
        (out / 'closure.json').write_text(json.dumps({
            'sourceUnchanged': before == after,
            'copyRestoredToSource': bool(restored) and all(before.get(k) == v for k, v in restored.items()),
            'copyRemoved': not copy.exists(), 'controls': len(receipts),
        }, indent=2))
    if before != fingerprints(ROOT):
        raise SystemExit('the source tree changed during the drill')
    print(f'all {len(receipts)} controls red at their declared assertions; restored green; source unchanged')


if __name__ == '__main__':
    main()
