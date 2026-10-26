#!/usr/bin/env python3
"""Mutation drill for AZ-A9 grant and credential requests (card 785e1eed P1-B,
P1-B-2).

Each control below edits ONE literal anchor in a disposable copy of the tree,
runs its suite — `--suite grant` (the default):
`backend/src/__tests__/accessRequestsGrantLive.test.ts`; `--suite credential`:
`backend/src/__tests__/accessRequestsCredentialLive.test.ts` — against a REAL
disposable PostgreSQL through the production router and the MCP ingress, and
requires the suite to go red at EXACTLY the predeclared set of tests, for an
assertion (not a compile error, a timeout or a crashed fixture). Every control
reddens a different set, so no two controls can be satisfied by one assertion.

The controls withdraw, one at a time, what the amendment's clauses say must
hold: the inert-grantee refusal (clause 4), ALREADY_HELD (clause 5), the
approved expiry on every written row (clause 12), the decider ceiling at
decide (clause 11), the bearer-only plane of the five routes (clause 9), the
administrator-or-root decider (clause 6), the admin-verb closure (clause 5),
both terminal writers' revocation hooks and the phase arm (clause 12a), and
the narrowing rule on the expiry (clause 8), and (E43 Q1, D-03) the
administrator arm on every kind. The credential controls withdraw what clause
13 binds: the ceiling of the one issuance executor and of decide (clause 11),
the collect binding to the requesting credential, the *:admin closure, the
scope narrowing (clause 8), the clause-12a credential revoke, the secret kept
out of the ledger, ALREADY_HELD, the decider's standing at collect and the
administrator-or-root decider (clause 6).
A control may name its own suite as a sixth field: card 0616c363's control
withdraws the verdict owner's bounded ASSIGNMENT_REFERENCE_BUSY retry in
TaskReviewAttemptService (the REVIEW file this drill already owns) and runs
`backend/src/__tests__/taskReportAcceptanceLive.test.ts`, which no other drill
owns; that suite gets its own green baseline first.
The source tree is never edited: its bytes are fingerprinted before and after.

Each run gets one of three verdicts (card f3049b43; the verdict card 696f3bb8
gave scripts/mint-ceiling-mutations.py):
  RED           the suite ran every test the baseline ran, and exactly the
                declared tests failed, each at an expect().
  MISS          the suite ran every test to an assertion, and the failed set is
                not the declared set (none failed, or others did).
  INCONCLUSIVE  the suite did not reach the declared assertions: it wrote no
                JSON (killed, or crashed before reporting; the exit status is
                named), it did not run the tests the baseline ran, a hook or
                test outlived its budget, the source did not compile, the suite
                did not load, the database was unreachable, a test failed by a
                thrown error rather than an assertion, or the runner itself ran
                out of time. That is no verdict on the control, so it is never
                reported as a MISS; the drill still fails (exit status 3).
Full-tier run 6176 printed `MISS <control> -> []` for the clause-13
ALREADY_HELD control, a line that cannot tell "no test reddened" from "the
suite reported no tests"; the same control on the same commit is RED when the
suite runs, so the line now says which it was.

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \\
    python3 scripts/access-request-mutations.py [--suite credential] --output-dir /tmp/access-request-drill
  python3 scripts/access-request-mutations.py [--suite credential] --describe   # checks every anchor, no database
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parents[1]
SUITE = 'src/__tests__/accessRequestsGrantLive.test.ts'
CREDENTIAL_SUITE = 'src/__tests__/accessRequestsCredentialLive.test.ts'
REPORT_ACCEPTANCE_SUITE = 'src/__tests__/taskReportAcceptanceLive.test.ts'
APPROVAL = 'backend/src/services/ApprovalService.ts'
ISSUANCE = 'backend/src/services/ConnectorCredentialIssuance.ts'
TERMINAL = 'backend/src/utils/accessRequestTerminal.ts'
DELEGATION = 'backend/src/routes/delegation.ts'
# Card b1e3b16d: the decider rule became ONE function the decide route and the
# approvals hub share (approvalDeciderStanding), so clause 6 is withdrawn there.
DECIDERS = 'backend/src/services/ApprovalHubService.ts'
REVIEW = 'backend/src/services/TaskReviewAttemptService.ts'
TASKS = 'backend/src/services/TaskManagerDB.ts'
PHASES = 'backend/src/services/PhaseService.ts'

# The tests each control must turn red, by title (assertionResults[].title).
INERT = 'GRANTEE_INERT: an explicit delegated grantee (the Connector itself) is inert'
MCP_REFUSALS = 'the same refusals by name through the tool: GRANTEE_INERT, the admin verb, and BUNDLED_ROWS_NOT_AVAILABLE for credential'
HELD = 'ALREADY_HELD when A already covers the row, naming the covering grant'
FILED_NOTHING = 'filed nothing: every refusal above left no approval row'
ADMIN_VERB = 'the admin verb is never admissible'
DECIDE_CEILING = 'a stored row no filing could produce (a surface rule) is refused at decide and writes nothing'
NON_ADMIN = ('the non-administrator owning Account lists the item, and its approve is refused '
             'APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR without spending its step-up')
VERDICT = "recordVerdict: the verifier's passing verdict on the related task does the same"
PATCH = ('updateTask: completing the related task by PATCH revokes the rows and lapses the pending sibling; '
         'reopening restores nothing')
HANDOVER = ("a row another task's assignment LINKS is handed over to that assignment, not deleted "
            '(ruling 7440b579 R1), and is reaped when that assignment ends')
PHASE_DONE = 'phase arm: a phase-only request is revoked when its phase reaches completed'
LONGER = 'widening by a longer expiry is refused EDIT_ONLY_NARROWS and the request stays pending'
# Every test whose approval must WRITE rows: an approval without the approved
# expiry writes none (migration 142's grants_approval_shape refuses a
# request-made row with no expires_at too), so each of these reddens.
ADMIN_APPROVES = 'the administrator approves: one grant row with approval_id, the approved expiry, origin manual, no provenance'
LIVE_ADMITS = 'the live predicate now admits Account A on X — and its Connector, through the router'
ROOT_APPROVES = 'root approves too'
NARROWED = 'dropping a row and a verb and shortening the expiry writes exactly that'
EXPIRED_REPLACED = 'an EXPIRED identical row is replaced in the decide transaction'
ROTATED = 'a rotated bound credential lapses the PENDING grant request and leaves the APPROVED one terminal'
HARD_DELETE = 'a hard delete of the related task reaps before the row goes'
PHASE_ARCHIVED = 'phase arm: and when its phase is archived'
# Card 0616c363: the deterministic overlap (a second connection holds the
# shared target's reference key) is refused once and must be retried.
BUSY_RETRY = ('a terminal verdict refused ASSIGNMENT_REFERENCE_BUSY by a benign overlap rolls back, retries and '
              'reaps the last reference once')
# P1-B-2: the carried deltas that approve a grant request write rows too.
REPOINT = ("nice-to-have 2: an expired row a vehicle CREATED is replaced, and the link now names the approval's "
           'row with created_by_vehicle FALSE')
REQUESTER_VIEW = ('E49 (a): the requester view names each created row and its state, and revokedAt once clause 12a '
                  'revoked them')
WRITES = {ADMIN_APPROVES, LIVE_ADMITS, ROOT_APPROVES, NARROWED, EXPIRED_REPLACED, ROTATED, HARD_DELETE,
          PHASE_ARCHIVED, PHASE_DONE, VERDICT, PATCH, HANDOVER, REPOINT, REQUESTER_VIEW}
# E43 Q1 (D-03): an administrator session lists, opens and decides a foreign agent-mint item.
EVERY_KIND = ("E43 Q1: an administrator (operator) session sees grant items in full, and lists, opens and decides "
              "the owner's agent-mint item")
SESSION = [f'a login session on {method} {path} is refused AGENT_PLANE_ONLY, with a durable audit' for method, path in (
    ('POST', '/delegation/access-requests'),
    ('GET', '/delegation/access-requests'),
    ('GET', '/delegation/access-requests/:id'),
    ('POST', '/delegation/access-requests/:id/withdraw'),
    ('POST', '/delegation/access-requests/:id/collect'),
)]

# (name, file, anchor, replacement, the exact set of tests that must fail)
CONTROLS = [
    ('clause 4: a delegated grantee is not refused GRANTEE_INERT', APPROVAL,
     '        if (named?.parentPrincipalId) {',
     '        if (named?.parentPrincipalId && named.parentPrincipalId.length < 0) {',
     {INERT, MCP_REFUSALS}),
    ('clause 5: a row the grantee Account already covers is not refused ALREADY_HELD', APPROVAL,
     '          if (!(await this.accountCovers(granteeId, single))) continue;',
     '          if (granteeId.length > 0 || !(await this.accountCovers(granteeId, single))) continue;',
     {HELD, FILED_NOTHING}),
    ('clause 12: approval writes the grant rows without the approved expiry', APPROVAL,
     'resourceId, verb, expiresAt: input.expiresAt.toISOString(),',
     'resourceId, verb, expiresAt: null,',
     WRITES),
    ('clause 11: the decider ceiling is not checked at decide', APPROVAL,
     '    await this.assertDeciderCeiling(input.deciderPrincipalId, grantDecision.rules, kind);\n',
     '',
     {DECIDE_CEILING}),
    ('clause 9: the five routes admit a login session', DELEGATION,
     '  if (isBearerCredentialKind(req.authMethod) && req.principal?.id) {',
     '  if ((isBearerCredentialKind(req.authMethod) || req.authMethod !== undefined) && req.principal?.id) {',
     set(SESSION)),
    ('clause 6: a non-administrator owning Account decides a grant request', DECIDERS,
     "  return viewer.administratorOk ? 'administrator' : null;",
     "  return viewer.administratorOk || kind.length > 0 ? 'administrator' : null;",
     {NON_ADMIN}),
    ('clause 5: the admin verb is admissible', APPROVAL,
     '      if (rule.verbs.some((verb) => !ACCESS_REQUEST_VERBS.includes(verb))) {',
     "      if (rule.verbs.some((verb) => !ACCESS_REQUEST_VERBS.includes(verb) && verb !== 'admin')) {",
     {ADMIN_VERB, FILED_NOTHING, MCP_REFUSALS}),
    ('clause 12a: the verifier verdict (recordVerdict) does not revoke', REVIEW,
     '        await reapAccessRequestsAtTerminal(client, {\n'
     "          type: 'task', id: String(row.task_id), to: 'completed', via: 'recordVerdict',",
     '        if (row.task_id === null) await reapAccessRequestsAtTerminal(client, {\n'
     "          type: 'task', id: String(row.task_id), to: 'completed', via: 'recordVerdict',",
     {VERDICT}),
    ('clause 12a: the terminal PATCH (updateTask) does not revoke', TASKS,
     '        await reapAccessRequestsAtTerminal(client, {\n'
     "          type: 'task', id, to: String(updates.status) as 'completed' | 'archived', via: 'updateTask',\n"
     '        }, vehicleAuditActor);\n',
     '',
     {PATCH, HANDOVER, REQUESTER_VIEW}),
    ('clause 12a phase arm (E43 Q3): phase completed does not revoke', PHASES,
     "        await reapAccessRequestsAtTerminal(client, { type: 'phase', id, to: 'completed', via: 'phase.update' },\n"
     '          PHASE_TERMINAL_ACTOR);\n',
     '',
     {PHASE_DONE}),
    ('clause 8: the approved expiry may be later than the requested one', APPROVAL,
     '    if (parsed.getTime() > requestedExpiresAt.getTime()) {',
     '    if (parsed.getTime() > requestedExpiresAt.getTime() * 2) {',
     {LONGER}),
    ('E43 Q1 (D-03): the administrator arm is back to grant and credential only', APPROVAL,
     'export const ADMINISTRATOR_DECIDED_KINDS: readonly ApprovalKind[] = [...APPROVAL_KINDS];',
     "export const ADMINISTRATOR_DECIDED_KINDS: readonly ApprovalKind[] = ['grant', 'credential'];",
     {EVERY_KIND}),
    ('0616c363: the verdict owner does not retry a verdict refused ASSIGNMENT_REFERENCE_BUSY', REVIEW,
     '        if (!isReferenceBusy(error) || attempt > VERDICT_REFERENCE_BUSY_RETRIES) throw error;',
     '        if (!isReferenceBusy(error) || attempt > 0) throw error;',
     {BUSY_RETRY}, REPORT_ACCEPTANCE_SUITE),
]

# ─────────────── the credential suite (clause 13; P1-B-2) ───────────────
C_ADMIN_SCOPE = 'a *:admin scope is refused by name and audited with the requester chain'
C_HELD = 'ALREADY_HELD: scopes a live credential already carries are refused, naming that credential — never a secret'
C_FILED_NOTHING = 'filed nothing: every refusal above left no approval row'
C_OWNER_REFUSED = ('the non-administrator owning Account lists the item, and its approve is refused '
                   'APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR without spending its step-up')
C_WIDER_SCOPE = 'widening by a scope never requested is refused and the request stays pending'
C_BINDING = '(6) another credential of the same Connector, and another Connector, are answered exactly as an absent id'
C_COLLECTS = '(6) the requesting credential collects: 201 with the secret ONCE, the credential as approved, recorded on the approval'
C_SECRET = '(7) the secret is in no approval row, event, audit row, idempotency record or log line'
C_TASK_REVOKE = ('completing the related task revokes the issued credential (the next request is refused), lapses what '
                 'waits, and reopening restores nothing')
C_PHASE_REVOKE = ("phase arm: a phase-only request's credential is revoked when the phase completes; an "
                  'approved-uncollected one lapses at archive')
C_DECIDE_CEILING = ('the decide-time ceiling: approval refuses scopes beyond what the deciding session may put on a '
                    'credential (a direct service call: no v1 decider session is narrower than a request can be)')
C_DEMOTED = ('a decider that lost its standing between approve and collect issues nothing: '
             'DECIDER_NO_LONGER_ADMITTED, still approved')
C_EXECUTOR = ('the edit-in-place entry point (card 3c2db4b7; a direct call BY DESIGN, no route yet): the executor caps '
              'by the authority it is given')
C_MCP_REFUSALS = 'the same refusals by name through the tool: root, *:admin, ALREADY_HELD'

CREDENTIAL_CONTROLS = [
    ('clause 11: the one issuance executor does not cap by the authority it is given', ISSUANCE,
     "  if (exceeding.length > 0) {\n    throw refuse(403, 'DECIDER_CEILING_EXCEEDED',",
     "  if (exceeding.length < 0) {\n    throw refuse(403, 'DECIDER_CEILING_EXCEEDED',",
     {C_EXECUTOR}),
    ('clause 11: decide does not cap the approved scopes by the deciding session', APPROVAL,
     "    if (exceeding.length > 0) {\n      throw refuse(403, 'DECIDER_CEILING_EXCEEDED',",
     "    if (exceeding.length < 0) {\n      throw refuse(403, 'DECIDER_CEILING_EXCEEDED',",
     {C_DECIDE_CEILING}),
    ('§6.1 / clause 13: collect is not bound to the requesting credential', APPROVAL,
     '      // same Connector is answered exactly as an absent id.\n'
     '      if (!row.requesting_credential_id || String(row.requesting_credential_id) !== input.presentingCredentialId) {',
     '      // same Connector is answered exactly as an absent id.\n'
     '      if (!row.requesting_credential_id || (String(row.requesting_credential_id) !== input.presentingCredentialId'
     ' && input.presentingCredentialId.length < 0)) {',
     {C_BINDING}),
    ('clauses 11 and 13: a *:admin scope is admitted at filing', ISSUANCE,
     "    if (scope.endsWith(':admin')) {",
     "    if (scope.endsWith(':admin') && scope.length < 0) {",
     {C_ADMIN_SCOPE, C_MCP_REFUSALS}),
    ('clause 8: the decider may approve a scope never requested', APPROVAL,
     '      const check = scopesWithin(requestedScopes, candidate);\n      if (!check.within) {',
     '      const check = scopesWithin(requestedScopes, candidate);\n      if (!check.within && candidate.length < 0) {',
     {C_WIDER_SCOPE}),
    ('clause 12a: the terminal reaper does not revoke an issued credential', TERMINAL,
     '    const revokedNow = await principalService.revokeCredentialById(credentialId, reason, actor, client as PoolClient);',
     '    const revokedNow = credentialId.length < 0 && Boolean(principalService) && Boolean(client as PoolClient) && Boolean(actor);',
     {C_TASK_REVOKE, C_PHASE_REVOKE}),
    ('§7.4 / clause 13: the secret is written into the collected event', APPROVAL,
     '        kind, issuedCredentialId: issued.credentialId, keyId: issued.keyId, mintedPrincipalId: requesterId,',
     '        kind, issuedCredentialId: issued.credentialId, keyId: issued.fullKey, mintedPrincipalId: requesterId,',
     {C_COLLECTS, C_SECRET}),
    ('clause 13 (clause 5 by analogy): scopes a live credential already carries are not refused ALREADY_HELD', APPROVAL,
     '      if (!covers || !pinCovers) continue;',
     '      if (!covers || !pinCovers || connectorId.length > 0) continue;',
     {C_HELD, C_FILED_NOTHING, C_MCP_REFUSALS}),
    ("clause 13: collect does not re-check the decider's standing", APPROVAL,
     "    if (!row || String(row.status) !== 'active' || row.legacy_identity || !ROLE_ACT_ISSUER_ROLES.includes(role)) {",
     "    if ((!row || String(row.status) !== 'active' || row.legacy_identity || !ROLE_ACT_ISSUER_ROLES.includes(role)) && role.length < 0) {",
     {C_DEMOTED}),
    ('clause 6: a non-administrator owning Account decides a credential request', DECIDERS,
     "  return viewer.administratorOk ? 'administrator' : null;",
     "  return viewer.administratorOk || kind.length > 0 ? 'administrator' : null;",
     {C_OWNER_REFUSED}),
]

SUITES = {'grant': (SUITE, CONTROLS), 'credential': (CREDENTIAL_SUITE, CREDENTIAL_CONTROLS)}

def suite_of(control, default):
    """A control's suite: its optional sixth field, else the --suite default."""
    return control[5] if len(control) > 5 else default


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


# Signatures of a run that never reached its assertions (the set the RED test
# has always excluded, now named).
NOT_MEASURED = (
    ('a hook or test outlived its budget', r'Exceeded timeout'),
    ('the source did not compile', r'TS\d{4}'),
    ('a syntax error', r'SyntaxError'),
    ('the suite did not load', r'Test suite failed to run'),
    ('the database was unreachable', r'ECONNREFUSED'),
)
SUITE_RUN_TIMEOUT_SECONDS = 900
INCONCLUSIVE_EXIT = 3


def run_suite(copy, out, label, suite):
    report = out / f'{label}.json'
    command = ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--testPathIgnorePatterns=/node_modules/',
               '--runTestsByPath', suite, '--json', f'--outputFile={report}']
    timed_out = False
    with (out / f'{label}.log').open('w') as log:
        try:
            code = subprocess.run(command, cwd=copy / 'backend', stdout=log, stderr=subprocess.STDOUT,
                                  timeout=SUITE_RUN_TIMEOUT_SECONDS).returncode
        except subprocess.TimeoutExpired:
            code, timed_out = None, True
    try:
        result = json.loads(report.read_text()) if report.exists() else {}
    except ValueError:
        result = {}
    tests = [a for f in result.get('testResults', []) for a in f.get('assertionResults', [])]
    suite_messages = ' '.join(str(f.get('message', '')) for f in result.get('testResults', []))
    return code, tests, re.sub(r'\x1b\[[0-9;]*m', '', suite_messages), timed_out


def exit_status(code):
    """The jest process's exit status in words: a negative code is the signal that ended it."""
    if code is None:
        return 'no exit status'
    if code < 0:
        try:
            return f'killed by {signal.Signals(-code).name}'
        except ValueError:
            return f'killed by signal {-code}'
    return f'exit status {code}'


def verdict(code, tests, titles, must_fail, suite_messages, timed_out):
    """RED, MISS or INCONCLUSIVE, with the reason (see the module docstring).

    RED is exactly the test this drill has always applied: a non-zero exit, the
    baseline's tests in the baseline's order, exactly the declared tests failed,
    each at an expect(), and no signature of a run that never measured."""
    failing = [t for t in tests if t['status'] == 'failed']
    messages = re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(m for t in failing for m in t.get('failureMessages', [])))
    if timed_out:
        return 'INCONCLUSIVE', f'the runner exceeded {SUITE_RUN_TIMEOUT_SECONDS} s'
    for reason, pattern in NOT_MEASURED:
        if re.search(pattern, messages + suite_messages):
            return 'INCONCLUSIVE', f'{reason} ({exit_status(code)})'
    if not tests:
        return 'INCONCLUSIVE', f'no structured assertions: the suite reported no tests ({exit_status(code)})'
    if [t['title'] for t in tests] != titles:
        return 'INCONCLUSIVE', (f'the suite did not run the tests the baseline ran ({len(tests)} reported, '
                                f'{len(titles)} in the baseline; {exit_status(code)})')
    thrown = [t for t in failing if 'expect(' not in '\n'.join(t.get('failureMessages', []))]
    if thrown:
        return 'INCONCLUSIVE', f'{len(thrown)} test(s) failed by a thrown error, not an assertion'
    failed = {t['title'] for t in failing}
    if code != 0 and failed == set(must_fail):
        return 'RED', 'exactly the declared tests failed, each at an assertion'
    if not failed:
        return 'MISS', f'every test ran and none failed ({exit_status(code)})'
    if failed == set(must_fail):
        return 'MISS', f'exactly the declared tests failed but jest reported {exit_status(code)}'
    return 'MISS', (f'{len(failed & set(must_fail))} of {len(must_fail)} declared and '
                    f'{len(failed - set(must_fail))} undeclared tests failed')


def inconclusive(what, reason):
    print(f'INCONCLUSIVE {what}: {reason}. The suite never reached its declared assertions, so this run is '
          f'no verdict on the control; re-run the drill.', flush=True)
    raise SystemExit(INCONCLUSIVE_EXIT)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--describe', action='store_true')
    parser.add_argument('--suite', choices=sorted(SUITES), default='grant')
    args = parser.parse_args()
    suite, controls = SUITES[args.suite]

    for control in controls:
        once((ROOT / control[1]).read_text(), control[2], control[3])
    sets = [frozenset(c[4]) for c in controls]
    if len(set(sets)) != len(sets) or any(not s for s in sets):
        raise SystemExit('every control must declare a non-empty must-fail set that no other control shares')
    if args.describe:
        print(json.dumps([{'control': c[0], 'file': c[1], 'suite': suite_of(c, suite), 'mustFail': sorted(c[4])}
                          for c in controls], indent=2))
        return

    require_disposable_database()
    if not args.output_dir:
        raise SystemExit('--output-dir is required')
    out = args.output_dir.resolve()
    if out == ROOT or ROOT in out.parents:
        raise SystemExit('--output-dir must lie outside the repository')
    out.mkdir(parents=True, exist_ok=False)

    before = fingerprints(ROOT)
    copy = Path(tempfile.mkdtemp(prefix='access-request-drill-'))
    receipts = []
    try:
        shutil.copytree(ROOT, copy, dirs_exist_ok=True, ignore=shutil.ignore_patterns(*IGNORED, '*.log'))
        (copy / 'backend/node_modules').symlink_to((ROOT / 'backend/node_modules').resolve(), target_is_directory=True)

        baselines = {}
        for each in dict.fromkeys([suite] + [suite_of(c, suite) for c in controls]):
            label = 'baseline' if each == suite else f'baseline-{Path(each).name.split(".")[0]}'
            code, tests, suite_messages, timed_out = run_suite(copy, out, label, each)
            titles = [t['title'] for t in tests]
            state, reason = verdict(code, tests, titles, set(), suite_messages, timed_out)
            if state == 'INCONCLUSIVE':
                inconclusive(f'baseline {each}', reason)
            if code != 0 or not tests or any(t['status'] != 'passed' for t in tests):
                raise SystemExit(f'baseline is not green: {each}')
            if len(set(titles)) != len(titles):
                raise SystemExit(f'two tests share a title, so a declared title would not name one test: {each}')
            baselines[each] = titles
        for control in controls:
            titles = baselines[suite_of(control, suite)]
            if not set(control[4]) <= set(titles):
                raise SystemExit(f'a declared test is absent from the suite: {sorted(set(control[4]) - set(titles))}')

        for index, control in enumerate(controls, start=1):
            name, path, anchor, replacement, must_fail = control[:5]
            control_suite = suite_of(control, suite)
            titles = baselines[control_suite]
            target = copy / path
            original = target.read_text()
            target.write_text(once(original, anchor, replacement))
            try:
                code, tests, suite_messages, timed_out = run_suite(copy, out, f'control-{index}', control_suite)
            finally:
                target.write_text(original)
            failed = {t['title'] for t in tests if t['status'] == 'failed'}
            state, reason = verdict(code, tests, titles, must_fail, suite_messages, timed_out)
            receipts.append({'control': name, 'file': path, 'suite': control_suite, 'mustFail': sorted(must_fail),
                             'failed': sorted(failed), 'red': state == 'RED', 'verdict': state, 'reason': reason})
            (out / 'receipts.json').write_text(json.dumps(receipts, indent=2))
            print(f"{'RED ' if state == 'RED' else state} {name} -> {sorted(failed)} ({reason})", flush=True)
            if state == 'INCONCLUSIVE':
                inconclusive(f'control {index} ({name})', reason)
            if state != 'RED':
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
