#!/usr/bin/env python3
"""Mutation drill for verification modes (owner ruling E462, the universal
harness connector design, section 6.8, slice S4b).

Each control edits ONE literal anchor in a DISPOSABLE COPY of the tree, runs
the live suite (src/__tests__/verificationModesLive.test.ts) against a REAL
disposable PostgreSQL through the production routers and real sockets, and
requires that suite to go red at EXACTLY the predeclared set of tests, by an
assertion (never a compile error, a suite that failed to run, or a jest
timeout). The controls withdraw, one at a time, the guards section 6.8 names:

  - who may set `none`: never an Agent, never a principal in G(Task);
  - when: never once the Task started (a claim or handback entry, a lease, a
    `started_at`), never again once cleared;
  - creation: refused beside a Verifier, the inherited default suppressed and
    its displacement audited;
  - clearing: a Verifier clears `none` in the same write;
  - finish: a `none` Task completes, Subtasks in Review complete, dependents
    become ready (and are rung), the setter re-check (SELF_SET); a move to
    Review is refused;
  - the assigned-connector claim without a Verifier;
  - the `verifier-agent` arm (parent, role, live Warrant, holder, a service
    Verifier, G on the Agent and the Verifier) and the exact-Verifier guard;
  - G(Task) itself (its claimant, handback and Agent seeds, its walks, a
    person never in it);
  - the legacy qa arm and the "no usable Verifier" filter skip `none`;
  - the wake's verify guard reads G, the endpoint speaks protocol 2 while any
    open socket does, and the Timeline knows the entry.

The source tree is never edited: its bytes are fingerprinted before and after.
The suite creates its own principals and Tasks with random handles, so the
runs share one database; nothing here creates, drops or restores a database.

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \\
    python3 scripts/verification-modes-mutations.py --output-dir /tmp/verification-modes-drill
  python3 scripts/verification-modes-mutations.py --describe   # checks every anchor, no database
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parents[1]
SUITE = 'src/__tests__/verificationModesLive.test.ts'
MODES = 'backend/src/services/VerificationModes.ts'
GUARD = 'backend/src/utils/verificationGuardSql.ts'
MANAGER = 'backend/src/services/TaskManagerDB.ts'
ELEMENT = 'backend/src/services/TaskElementService.ts'
CLAIM = 'backend/src/services/AssignedClaimAuthority.ts'
AUTHZ = 'backend/src/services/AuthorizationService.ts'
USABLE = 'backend/src/services/VerifierUsability.ts'
WAKE = 'backend/src/services/ConnectorWakeService.ts'
TIMELINE = 'backend/src/services/UnifiedTaskTimeline.ts'
SOURCES = [MODES, GUARD, MANAGER, ELEMENT, CLAIM, AUTHZ, USABLE, WAKE, TIMELINE]

# Tests, by title.
MIGRATION = 'S4b migration 170: none never beside a Verifier, a setter is always named, once cleared never again'
CREATE = 'S4b create with verificationNone: the creator (its Shepherd) sets it; the Task reads mode none with an audit row and a Timeline entry'
DISPLACED = 'S4b create with verificationNone displaces the inherited Project default Verifier and audits it'
CREATE_REFUSES = 'S4b create refuses verificationNone beside verifierPrincipalId, and a non-boolean'
SHEPHERD_SETS = 'S4b the Shepherd sets none on a To-Do Task; its Verifier is cleared and audited as displaced'
AGENT = 'S4b an Agent never sets none, even as the Shepherd of the Task'
CHAIN_SETTER = 'S4b the execution connector (in G(Task)) never waives its own verification, even as Shepherd'
NO_AUTHORITY = 'S4b a principal without the roles authority cannot set none'
STARTED = 'S4b none is refused once the Task started: in progress, a claim entry, a started_at or an execution lease'
CLEARED = 'S4b assigning a Verifier clears none in the same write; once cleared it can never be set again'
FINISH = 'S4b finish on a none Task completes it, completes Subtasks in Review, and its dependent gets task.ready and an implement ring'
FINISH_CONTROL = 'S4b finish on an ordinary Task still hands back into Review (control)'
NO_REVIEW = 'S4b a move to Review on a none Task is refused'
SELF_SET = 'S4b finish refuses VERIFICATION_NONE_SELF_SET when the setter shares the implementing chain'
ACCOUNT = 'S4b the Account on its login session sets none on the Account-control basis'
ASSIGNED_CLAIM = 'S4b the assigned connector claims a none Task without a Verifier; without none it still needs one'
AGENT_ARM = 'S4b a verifier Agent of the service Verifier, minted under its live Warrant, completes the Task'
ARM_NEGATIVES = 'S4b the verifier-agent arm refuses a wrong parent, the wrong role, another Task, a dead Warrant and a human Verifier'
IMPLEMENTING = 'S4b a verifier Agent of the implementing connector is refused, and so is that connector as exact Verifier'
HUMAN = 'S4b a human Account Verifier is never refused by the guard, even when her own connector implemented'
SIBLING = 'S4b the exact service Verifier outside G(Task) still completes (sibling connectors are allowed)'
REJECT = 'S4b the verifier Agent may reject through the reviewer gate'
LEGACY = 'S4b a none Task is never "without a usable Verifier", and the legacy qa arm never judges it'
WAKE_G = 'S4b the verify wake reads G(Task): a connector whose Agent once handed the Task back is its own work'
G_MEMORY = 'S4b G(Task) remembers a released claimant and its descendants, never its Account or a sibling'
PROTOCOL = 'S4b a Verifier connector with a protocol-2 socket open is rung for verify even after a protocol-1 socket subscribed'
IDEAS_CREATE = 'S4b create with verificationNone in Ideas: an explicit ideas status and the inbox-phase default both set it'
IDEAS_ROLES = 'S4b after creation the roles route sets none only in To Do: an Ideas Task is refused'
G_ACCOUNT = 'S4b a Main connector in G(Task) never sets none, even on the Account-control basis; the human Account does'
ALL_TESTS = [MIGRATION, CREATE, DISPLACED, CREATE_REFUSES, SHEPHERD_SETS, AGENT, CHAIN_SETTER, NO_AUTHORITY, STARTED,
             CLEARED, FINISH, FINISH_CONTROL, NO_REVIEW, SELF_SET, ACCOUNT, ASSIGNED_CLAIM, AGENT_ARM, ARM_NEGATIVES,
             IMPLEMENTING, HUMAN, SIBLING, REJECT, LEGACY, WAKE_G, G_MEMORY, PROTOCOL, IDEAS_CREATE, IDEAS_ROLES, G_ACCOUNT]

# (name, file, anchor, replacement, the exact set of tests that must fail).
# Replacements keep every local read, so each mutant compiles (noUnusedLocals).
CONTROLS = [
    ('an Agent may set none', MODES,
     "if (!chain.alive || chain.links[0]?.kind === 'agent') {",
     "if (!chain.alive || (chain.links[0]?.kind === 'agent' && taskId === '')) {",
     {AGENT}),
    ('the Account-control path is not recognised', MODES,
     "  if (await taskAccountControl(client, taskId, actor)) return 'account-control';",
     "  if ((await taskAccountControl(client, taskId, actor)) && taskId === '') return 'account-control';",
     {ACCOUNT, CREATE, G_ACCOUNT}),
    ('a principal in G(Task) may set none', MODES,
     'if ((await guardedPrincipalIds(client, taskId)).has(actor.principalId)) {',
     "if ((await guardedPrincipalIds(client, taskId)).has(actor.principalId) && taskId === '') {",
     {CHAIN_SETTER, G_ACCOUNT}),
    # The G check runs before the Account-control return: a Main connector in G is refused on that basis too.
    ('the Account-control path skips G(Task)', MODES,
     'if ((await guardedPrincipalIds(client, taskId)).has(actor.principalId)) {',
     'if ((await guardedPrincipalIds(client, taskId)).has(actor.principalId) && !(await taskAccountControl(client, taskId, actor))) {',
     {G_ACCOUNT}),
    ('a create that lands in Ideas cannot set none', MODES,
     "  const landing = atCreation ? ['todo', 'ideas'] : ['todo'];",
     "  const landing = atCreation ? ['todo'] : ['todo'];",
     {IDEAS_CREATE}),
    ('the roles route sets none on an Ideas Task', MODES,
     "  const landing = atCreation ? ['todo', 'ideas'] : ['todo'];",
     "  const landing = atCreation ? ['todo', 'ideas'] : ['todo', 'ideas'];",
     {IDEAS_ROLES}),
    ('a claim or handback entry does not mean started', MODES,
     "e.event_type IN ('task.claimed', 'handover.finish')) AS has_work_entry,",
     "e.event_type IN ('task.claimed', 'handover.finish') AND FALSE) AS has_work_entry,",
     {STARTED}),
    ('an execution lease does not mean started', MODES,
     'EXISTS (SELECT 1 FROM task_execution_leases l WHERE l.task_id = t.id) AS has_lease',
     'EXISTS (SELECT 1 FROM task_execution_leases l WHERE l.task_id = t.id AND FALSE) AS has_lease',
     {STARTED}),
    ('a cleared none may be set again', MODES,
     '  if (row.verification_none_cleared_at) {',
     "  if (row.verification_none_cleared_at && taskId === '') {",
     {CLEARED}),
    ('the finish re-check ignores the setter chain', MODES,
     '  if (!setter || guarded.has(setter)) {',
     "  if (!setter || (guarded.has(setter) && task.id === '')) {",
     {SELF_SET}),
    ('a Verifier is created beside none', MANAGER,
     '        if (explicitVerifier !== undefined && explicitVerifier !== null) {',
     "        if (explicitVerifier !== undefined && explicitVerifier !== null && taskId === '') {",
     {CREATE_REFUSES}),
    ('none does not suppress the inherited default', MANAGER,
     'const createdVerifier = verificationNoneRequested ? null : await this.resolveCreateVerifier(client, {',
     "const createdVerifier = verificationNoneRequested && taskId === '' ? null : await this.resolveCreateVerifier(client, {",
     {DISPLACED}),
    ('the displaced default is not audited', MANAGER,
     '        displacedDefault = await this.defaultVerifierFor(client, projectId, data.phaseId ?? null);',
     '        displacedDefault = (await this.defaultVerifierFor(client, projectId, data.phaseId ?? null)) && null;',
     {DISPLACED}),
    ('a Verifier does not clear none', MANAGER,
     "          fields.push('verification_none = FALSE');\n", '',
     {CLEARED}),
    ('a move to Review is admitted on a none Task', MANAGER,
     "if (updates.status === 'review' && current.status !== 'review' && current.verification_none === true) {",
     "if (updates.status === 'review' && current.status !== 'review' && current.verification_none === true && id === '') {",
     {NO_REVIEW}),
    ('a none finish hands back into Review', ELEMENT,
     '      if (task.verification_none === true) {\n        const completed',
     "      if (task.verification_none === true && taskId === '') {\n        const completed",
     {FINISH, SELF_SET}),
    ('a none finish leaves Subtasks in Review', ELEMENT,
     "        WHERE task_id = $1 AND status = 'review' RETURNING id`, [task.id]);",
     "        WHERE task_id = $1 AND status = 'review' AND FALSE RETURNING id`, [task.id]);",
     {FINISH}),
    ('a none finish never readies its dependents', ELEMENT,
     '    await syncDependentsReadiness(client, task.id, readinessActor);\n',
     "    if (task.id === '') await syncDependentsReadiness(client, task.id, readinessActor);\n",
     {FINISH}),
    ('the assigned claim still needs a Verifier for none', CLAIM,
     '      AND ((${t}.verification_none AND ${t}.verifier_principal_id IS NULL)',
     '      AND ((FALSE AND ${t}.verifier_principal_id IS NULL)',
     {ASSIGNED_CLAIM}),
    ('the verifier-agent arm ignores the parent', GUARD,
     '        AND va_a.parent_principal_id = va_t.verifier_principal_id\n', '',
     {ARM_NEGATIVES}),
    ('the verifier-agent arm ignores the bound role', GUARD,
     "        AND va_a.bound_task_id = va_t.id AND va_a.bound_task_role = 'verifier'\n",
     '        AND va_a.bound_task_id = va_t.id\n',
     {ARM_NEGATIVES}),
    ('the verifier-agent arm takes a dead Warrant', GUARD,
     "        AND va_w.status = 'active' AND (va_w.expires_at IS NULL OR va_w.expires_at > clock_timestamp())\n", '',
     {ARM_NEGATIVES}),
    ('the verifier-agent arm takes another holder\'s Warrant', GUARD,
     '        AND va_w.holder_principal_id = va_s.id\n', '',
     {ARM_NEGATIVES}),
    ('the verifier-agent arm takes a person as Verifier', GUARD,
     "        AND va_s.kind = 'service' AND va_s.status = 'active'\n",
     "        AND va_s.status = 'active'\n",
     {ARM_NEGATIVES}),
    ('the verifier-agent arm ignores G(Task)', GUARD,
     '        AND va_s.id NOT IN ${guardedPrincipalsSql(taskId)}\n        AND va_a.id NOT IN ${guardedPrincipalsSql(taskId)})`;',
     ')`;',
     {IMPLEMENTING}),
    ('the exact service Verifier in G(Task) still judges', MODES,
     "(t.verifier_principal_id = $2::uuid AND NOT ${exactVerifierGuardedSql('t.id')}) AS exact,",
     "(t.verifier_principal_id = $2::uuid AND NOT (${exactVerifierGuardedSql('t.id')} AND FALSE)) AS exact,",
     {IMPLEMENTING}),
    ('G(Task) forgets a past claimant', GUARD,
     "WHERE g_e.task_id = ${taskId} AND g_e.event_type = 'task.claimed'",
     "WHERE g_e.task_id = ${taskId} AND g_e.event_type = 'task.claimed' AND FALSE",
     {G_MEMORY}),
    ('G(Task) forgets a handback author', GUARD,
     "WHERE g_e.task_id = ${taskId} AND g_e.event_type = 'handover.finish'",
     "WHERE g_e.task_id = ${taskId} AND g_e.event_type = 'handover.finish' AND FALSE",
     {WAKE_G}),
    ('G(Task) does not walk up to the parent', GUARD,
     '      UNION SELECT g_p.parent_principal_id FROM principals g_p JOIN g_up ON g_p.id = g_up.id\n             WHERE g_p.parent_principal_id IS NOT NULL\n',
     '      UNION SELECT g_p.parent_principal_id FROM principals g_p JOIN g_up ON g_p.id = g_up.id\n             WHERE g_p.parent_principal_id IS NOT NULL AND FALSE\n',
     {IMPLEMENTING, WAKE_G, SELF_SET}),
    ('G(Task) does not walk down to descendants', GUARD,
     '      UNION SELECT g_c.id FROM principals g_c JOIN g_down ON g_c.parent_principal_id = g_down.id\n',
     '      UNION SELECT g_c.id FROM principals g_c JOIN g_down ON g_c.parent_principal_id = g_down.id AND FALSE\n',
     {G_MEMORY}),
    ('a person is in G(Task)', GUARD,
     "     WHERE g_m.kind <> 'human')`;",
     "     WHERE g_m.kind <> 'human' OR TRUE)`;",
     # G is checked before the Account-control path, so a person in G is also refused as setter:
     # the human Account control and the claimed-Task case answer CHAIN_GUARDED instead.
     {HUMAN, G_MEMORY, G_ACCOUNT, STARTED}),
    ('the legacy qa arm judges a none Task', AUTHZ,
     '? `(${resource.verifier} IS NULL AND NOT ${resource.verificationNone})`',
     '? `(${resource.verifier} IS NULL)`',
     {LEGACY}),
    ('a none Task is "without a usable Verifier"', USABLE,
     '  return `(NOT ${task}.verification_none AND (${task}.verifier_principal_id IS NULL',
     '  return `(TRUE AND (${task}.verifier_principal_id IS NULL',
     {LEGACY}),
    # Both arms go: in that test the connector is also the exact Verifier, so either arm alone keeps the guard.
    ('the verify wake ignores G(Task)', WAKE,
     "($2::uuid IN ${guardedPrincipalsSql('t.id')} OR ${exactVerifierGuardedSql('t.id')}) AS own_work",
     "(($2::uuid IN ${guardedPrincipalsSql('t.id')} OR ${exactVerifierGuardedSql('t.id')}) AND FALSE) AS own_work",
     {WAKE_G}),
    ('the endpoint protocol is the most recent subscription', WAKE,
     '    const kinds = speaksProtocol2(endpoint)\n',
     '    const kinds = speaksProtocol2(endpoint) && [...endpoint.sockets.values()].pop() === 2\n',
     {PROTOCOL}),
    ('the verification-mode entry is not a known System type', TIMELINE,
     "  'task.verification_mode',\n", '',
     {CREATE}),
]

# A failure that is not an assertion proves nothing about the guard.
NOT_AN_ASSERTION = re.compile(r'Exceeded timeout of|error TS\d+|Test suite failed to run|Cannot find module')


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fingerprint() -> dict:
    return {str(p.relative_to(ROOT)): sha(p) for p in (ROOT / 'backend/src').rglob('*') if p.is_file()}


def check_anchors(base: Path) -> None:
    for name, rel, old, new, expected in CONTROLS:
        text = (base / rel).read_text(encoding='utf-8')
        if text.count(old) != 1:
            raise RuntimeError(f'anchor for {name!r} occurs {text.count(old)} times in {rel}')
        if old == new:
            raise RuntimeError(f'control {name!r} changes nothing')
        unknown = expected - set(ALL_TESTS)
        if unknown or not expected:
            raise RuntimeError(f'control {name!r} names tests the suite does not have: {sorted(unknown)}')
    suite = (base / 'backend' / SUITE).read_text(encoding='utf-8')
    titles = re.findall(r"^test\((['\"])(S4b .*?)\1, async", suite, flags=re.M)
    names = [title for _q, title in titles]
    if sorted(names) != sorted(ALL_TESTS):
        raise RuntimeError(f'the suite titles and the drill disagree: {sorted(set(names) ^ set(ALL_TESTS))}')


def disposable(raw: str) -> None:
    url = urlparse(raw)
    name = unquote(url.path.lstrip('/'))
    local = url.hostname in ('127.0.0.1', 'localhost', '::1') and re.search(r'test|contract|fixture', name)
    ci = os.environ.get('CI') == 'true' and url.hostname == 'postgres' and name == 'relayhall_ci'
    if url.scheme not in ('postgres', 'postgresql') or name in ('relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod') \
            or not (local or ci):
        raise RuntimeError('Refusing a non-disposable database target')


def run_suite(copy: Path, out: Path, label: str, env: dict) -> dict:
    report = out / f'{label}.json'
    cmd = ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--testPathIgnorePatterns=/node_modules/',
           '--runTestsByPath', SUITE, f'--cacheDirectory={out / "jest-cache"}', '--json', f'--outputFile={report}']
    with (out / f'{label}.log').open('w', encoding='utf-8') as log:
        subprocess.run(cmd, cwd=copy / 'backend', env=env, stdout=log, stderr=subprocess.STDOUT, check=False)
    return json.loads(report.read_text(encoding='utf-8'))


def outcomes(data: dict) -> dict:
    # A suite that failed to run (a mutant that does not compile) proves nothing: refuse it by name.
    if data.get('numRuntimeErrorTestSuites', 0) or not data.get('numTotalTests'):
        messages = ' '.join(r.get('message', '') for r in data.get('testResults', []))[:400]
        raise RuntimeError(f'the suite did not run: {messages}')
    found = {}
    for result in data.get('testResults', []):
        for case in result.get('assertionResults', []):
            found[case['title']] = (case['status'], ' '.join(case.get('failureMessages') or []))
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--output-dir')
    parser.add_argument('--describe', action='store_true')
    args = parser.parse_args()
    check_anchors(ROOT)
    if args.describe:
        for name, rel, _old, _new, expected in CONTROLS:
            print(f'{name}  [{rel}]  -> {len(expected)} test(s)')
        print(f'{len(CONTROLS)} controls, every anchor found exactly once')
        return 0
    if not args.output_dir:
        parser.error('--output-dir is required unless --describe')
    raw = os.environ.get('RELAYHALL_TEST_DB_URL', '')
    disposable(raw)
    out = Path(args.output_dir).resolve()
    out.mkdir(mode=0o700, parents=True, exist_ok=False)
    before = fingerprint()
    copy = out / 'private-copy'
    copy.mkdir()
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    for rel in filter(None, tracked):
        source = ROOT / rel
        if source.is_file():
            (copy / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, copy / rel)
    # The working tree's own edits to the files the drill reads (a lane runs it before committing).
    for rel in SOURCES + ['backend/' + SUITE]:
        (copy / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / rel, copy / rel)
    (copy / 'backend/node_modules').symlink_to((ROOT / 'backend/node_modules').resolve(), target_is_directory=True)
    check_anchors(copy)
    env = {k: v for k, v in os.environ.items() if not k.startswith(('DB_', 'PG')) and k != 'DATABASE_URL'}
    env.update(RELAYHALL_TEST_DB_URL=raw, NODE_ENV='test')
    receipts = []
    try:
        baseline = outcomes(run_suite(copy, out, 'baseline', env))
        green = sorted(t for t, (status, _m) in baseline.items() if status == 'passed')
        if green != sorted(ALL_TESTS):
            raise RuntimeError(f'baseline is not green: {sorted(set(ALL_TESTS) - set(green))}')
        for index, (name, rel, old, new, expected) in enumerate(CONTROLS, start=1):
            path = copy / rel
            original = path.read_bytes()
            path.write_bytes(original.decode('utf-8').replace(old, new, 1).encode('utf-8'))
            try:
                found = outcomes(run_suite(copy, out, f'control-{index:02d}', env))
            finally:
                path.write_bytes(original)
            failed = {t for t, (status, _m) in found.items() if status == 'failed'}
            passed = {t for t, (status, _m) in found.items() if status == 'passed'}
            bad = [t for t in failed if NOT_AN_ASSERTION.search(found[t][1])]
            exact = failed == expected and passed == set(ALL_TESTS) - expected and not bad
            receipts.append({'control': name, 'file': rel, 'expected': sorted(expected), 'failed': sorted(failed),
                             'notAnAssertion': sorted(bad), 'exact': exact})
            (out / 'receipts.json').write_text(json.dumps(receipts, indent=2), encoding='utf-8')
            print(('EXACT ' if exact else 'MISMATCH ') + name, flush=True)
            if not exact:
                raise RuntimeError(f'control {name!r}: expected {sorted(expected)}, failed {sorted(failed)}, '
                                   f'not an assertion {sorted(bad)}')
        restored = outcomes(run_suite(copy, out, 'restored', env))
        if sorted(t for t, (s, _m) in restored.items() if s == 'passed') != sorted(ALL_TESTS):
            raise RuntimeError('the restored copy is not green')
    finally:
        shutil.rmtree(copy, ignore_errors=True)
    if fingerprint() != before:
        raise RuntimeError('the source tree changed during the drill')
    (out / 'receipt.json').write_text(json.dumps({
        'status': 'PASS', 'controls': receipts, 'baseline': len(ALL_TESTS), 'restored': len(ALL_TESTS),
        'sourceUnchanged': True, 'scriptSha256': sha(Path(__file__)),
    }, indent=2), encoding='utf-8')
    print(f'PASS: {len(ALL_TESTS)} baseline/restored and {len(CONTROLS)} exact live controls; source unchanged')
    return 0


if __name__ == '__main__':
    sys.exit(main())
