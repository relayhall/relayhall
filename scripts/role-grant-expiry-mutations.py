#!/usr/bin/env python3
"""Mutation drill for AZ-A10 clause 6, the assignment grant rows' expiry
(card 785e1eed P2-B slice 1; E43 Q4, E62, D-11).

Each control below edits literal anchors in a disposable copy of the tree, runs
`backend/src/__tests__/roleGrantExpiryLive.test.ts` against a REAL disposable
PostgreSQL through the production router and the MCP ingress, and requires the
suite to go red at EXACTLY the predeclared set of tests, for an assertion (not
a compile error, a timeout or a crashed fixture). Every control reddens a
different set, so no two controls can be satisfied by one assertion.

The controls withdraw, one at a time, what the ratified text and the brief say
must hold: the three-month default, "any later date" (no ceiling),
`unlimited` (NULL), "an earlier date is admitted" (no floor), E62's "whoever
performs the assigning act" (no role gate on the earlier date), the past-date
refusal (D-11 bullet 5), the field's place inside the assigning act, the
before/after audit, clause 6's maximum over the links (not the minimum, not
the last writer), the owner-plane rows D4 never re-dates, clause 7's recompute
when a shared row survives a reaped link, the unchanged terminal reaper, the
recovery replay signature, the re-asserted assignment's re-date, the date's
out-of-band carriage (a raw body field is never the date; review round 1,
B1) and the access view's two dates (the link's and the row's; review round
1, N1).
The source tree is never edited: its bytes are fingerprinted before and after.

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \\
    python3 scripts/role-grant-expiry-mutations.py --output-dir /tmp/role-grant-expiry-drill
  python3 scripts/role-grant-expiry-mutations.py --describe   # checks every anchor, no database
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
SUITE = 'src/__tests__/roleGrantExpiryLive.test.ts'
EXPIRY = 'backend/src/utils/roleGrantExpiry.ts'
CARRIER = 'backend/src/services/AccessVehicleService.ts'
TASKS = 'backend/src/services/TaskManagerDB.ts'
ROUTE = 'backend/src/routes/tasks.ts'

# The tests each control must turn red, by title (assertionResults[].title).
T1 = 'T1 DEFAULT: an assignment without the field dates its link and row at materialization + 3 months, computed by PostgreSQL'
T2 = 'T2 LATER DATE: one year out is admitted and stored exactly, neither clamped nor refused'
T3 = 'T3 UNLIMITED: link and row carry NULL, the receipt says unlimited, and the row is still reaped at completed'
C1_CREATE = ('C1 root sets a one-day date at create: admitted, the row and its link expire that instant, '
             'and the access view shows it')
C1_PATCH = 'C1 root sets the same one-day date on PATCH: admitted and stored'
C1_HORIZON = ('C1 short horizon: the live predicate stops admitting the assignee through the router at the instant, '
              'with no SQL edits')
C2_REST = ('C2 any other assigner that performs the act (a Main-shaped Connector: not root, not an administrator, '
           'not the owning Account) sets the one-day date: admitted')
C2_MCP = 'C2 through MCP: relayhall_task_create by that Connector carries the one-day date and prints it in the receipt'
C3_PAST = 'C3 a past date and a date of now are refused 422 INVALID_EXPIRY naming D-11, and the create writes nothing'
C3_ZONED = 'C3 {local, zone} is resolved by PostgreSQL and the receipt names the instant and offset'
C4A = ('C4(a) roleGrantExpiresAt without an executionProfile is refused ROLE_GRANT_EXPIRY_WITHOUT_ASSIGNMENT, '
       'and nothing moves')
C4B = ('C4(b) principals the assigning act refuses cannot shorten: the assignee itself, a credential without '
       'services:invoke, a stranger')
C4C = ('C4(c) the date is not a body field: a raw roleGrantExpiry from a writer without services:invoke, '
       'or from root beside an ordinary field, moves no link or row, writes no expiry audit and never answers 500')
C4_TERMINAL = ('C4 the field beside executionWarrantId is refused ROLE_GRANT_EXPIRY_WITH_WARRANT, and a terminal task '
               'refuses it ROLE_GRANT_EXPIRY_TASK_TERMINAL')
C5_PATCH = 'C5 a shortened row is reaped at completed by PATCH, with grant.revoke'
C5_ARCHIVE = 'C5 archived and delete reap too'
C5_SWAP = 'C5 unassign and reassign reap; the incoming assignee gets its own row at the default'
C5_REOPEN = 'C5 reopen materializes NEW rows at the default; the reaped ids are never revived'
C6_CREATE = 'C6 grant.create names expiresAt and assigneePrincipalId'
C6_REDATE = ('C6 re-asserting the same assignee with a new date re-dates in place: grant.expiry_change per row with '
             'before and after, and task.execution_assign with the link date before')
C7_MAX = ('C7 three tasks link one row: a later link raises it, an earlier one never lowers it '
          '(the maximum, not the last writer)')
C7_RECOMPUTE = ('C7 completing the task that holds the latest link recomputes the row over the remaining links, '
                'audited before and after')
C7_NULL = 'C7 an unlimited link makes the row NULL, and the row returns to the remaining date when that task completes'
C7_OWNER = 'C7 an owner-plane row linked by an assignment is never re-dated'
C7_EXPIRED = 'C7 an expired assignment row found on the tuple is re-dated by the next assignment, not linked inert'
RECOVERY = ('R recovery to the same Connector with a new date re-dates in place; an exact retry replays; '
            'a different date does not')
# AZ-A10 (migration 149) dates role rows on the roles act too: this test
# assigns a verifier with a two-day date, earlier than the default.
VERIFIER_ROLE = 'dates a verifier assignment on the roles act and reaps it when the field is cleared'

# Every test that writes an assignment with a date earlier than the default.
EARLIER = {C1_CREATE, C1_PATCH, C1_HORIZON, C2_REST, C2_MCP, C5_PATCH, C5_ARCHIVE, C5_SWAP, C5_REOPEN, C6_CREATE,
           C6_REDATE, C7_MAX, C7_RECOMPUTE, C7_NULL, C7_OWNER, C7_EXPIRED, RECOVERY, VERIFIER_ROLE}

ROLE_GATE = (
    "    const roleGrantExpiry = warrantId ? null : await this.resolveRoleGrantExpiry(client, input.roleGrantExpiry);\n"
    "    if (roleGrantExpiry?.source === 'assigner' && roleGrantExpiry.applied !== null\n"
    "      && !input.assigner.scopes?.includes('root')\n"
    "      && !ADMINISTRATOR_ROLES.has(String(input.assigner.role || '').toLowerCase())) {\n"
    "      const earlier = await client.query(\n"
    "        `SELECT $1::timestamptz < ((NOW() AT TIME ZONE 'UTC') + INTERVAL '3 months') AT TIME ZONE 'UTC' AS earlier`,\n"
    "        [roleGrantExpiry.applied]);\n"
    "      const owner = await client.query(\n"
    "        `SELECT COALESCE(t.account_owner_principal_id, p.owner_principal_id) AS owner\n"
    "           FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = $1`, [input.taskId]);\n"
    "      const links = input.assigner.delegation?.links ?? [];\n"
    "      const accountId = links.length ? links[links.length - 1].principalId : input.assigner.principalId;\n"
    "      if (earlier.rows[0].earlier === true && String(owner.rows[0]?.owner) !== String(accountId)) {\n"
    "        throw err(403, 'EARLIER_DATE_RESERVED', 'only root, an administrator or the owning Account may shorten');\n"
    "      }\n"
    "    }\n"
)

# (name, [(file, anchor, replacement), ...], the exact set of tests that must fail)
CONTROLS = [
    ('D-11 bullet 1: the default is not materialization + 3 months', [
        (EXPIRY, "export const ROLE_GRANT_DEFAULT_INTERVAL = '3 months';",
         "export const ROLE_GRANT_DEFAULT_INTERVAL = '2 months';"),
    ], {T1, C5_SWAP, C5_REOPEN}),
    ('clause 6 "any later date": a later date is clamped at the default (a ceiling the text does not have)', [
        (CARRIER, "`SELECT to_char($1::timestamptz AT TIME ZONE 'UTC', ${ROLE_GRANT_EXPIRY_ISO_FORMAT}) AS iso,",
         "`SELECT to_char(LEAST($1::timestamptz, ((NOW() AT TIME ZONE 'UTC') + INTERVAL '3 months') AT TIME ZONE 'UTC')"
         " AT TIME ZONE 'UTC', ${ROLE_GRANT_EXPIRY_ISO_FORMAT}) AS iso,"),
    ], {T2, C3_ZONED}),
    ("clause 6: 'unlimited' is read as the default", [
        (CARRIER, "    if (request?.kind === 'unlimited') {",
         "    if (request?.kind === 'unlimited' && request.kind.length < 0) {"),
    ], {T3, C7_NULL}),
    ('E43 Q4 / D-11 bullet 2: a date earlier than the default is refused (the withdrawn floor)', [
        (CARRIER, "                $1::timestamptz > clock_timestamp() AS future`,",
         "                $1::timestamptz > clock_timestamp()\n"
         "                  AND $1::timestamptz >= ((NOW() AT TIME ZONE 'UTC') + INTERVAL '3 months') AT TIME ZONE 'UTC'"
         " AS future`,"),
    ], EARLIER),
    ('E62 (U-2): the earlier date is gated to root, an administrator or the owning Account (the rejected reading)', [
        (CARRIER, "    const roleGrantExpiry = warrantId ? null : await this.resolveRoleGrantExpiry(client, input.roleGrantExpiry);\n",
         ROLE_GATE),
    ], {C2_REST}),
    ('D-11 bullet 5: a past date is admitted', [
        (CARRIER, "      if (row.rows[0]?.future !== true) {",
         "      if (row.rows[0]?.future !== true && row.rows[0]?.future === 'never') {"),
    ], {C3_PAST, RECOVERY}),
    ('brief: the date is accepted without an assignment and re-dates the existing one (a non-assigner shortening)', [
        (ROUTE, "    if (payload.executionProfile === undefined || payload.executionProfile === null) {\n"
                "      throw new ProfileValidationError(422, 'ROLE_GRANT_EXPIRY_WITHOUT_ASSIGNMENT',",
         "    if (payload.executionProfile === undefined) {\n"
         "      carryAssigningActExpiry(payload, await normalizeRoleGrantExpiresAtWrite(roleGrantExpiresAt, dueAtResolver));\n"
         "      return payload;\n"
         "    }\n"
         "    if (payload.executionProfile === null) {\n"
         "      throw new ProfileValidationError(422, 'ROLE_GRANT_EXPIRY_WITHOUT_ASSIGNMENT',"),
    ], {C4A, C4B}),
    ('clause 8: the re-date audit loses the date before', [
        (CARRIER, "        automatic: true, before, after, taskId: context.taskId, reason: context.reason,",
         # `before` stays referenced (so the mutant compiles) and is never written.
         "        automatic: true, after, taskId: context.taskId, reason: context.reason,"
         " ...(before === undefined ? { before } : {}),"),
    ], {C6_REDATE, C7_RECOMPUTE, C7_EXPIRED}),
    ('clause 6: the shared row takes the MINIMUM over its links', [
        (CARRIER, "to_char(MAX(l.expires_at) AT TIME ZONE 'UTC'", "to_char(MIN(l.expires_at) AT TIME ZONE 'UTC'"),
    ], {C7_MAX, C7_RECOMPUTE, C7_EXPIRED}),
    ('clause 6: the shared row takes the LAST WRITER\'s date', [
        (CARRIER, "    const after: string | null = row.any_unlimited ? null : (row.latest_iso ?? null);",
         "    const own = await client.query(\n"
         "      `SELECT to_char(expires_at AT TIME ZONE 'UTC', ${ROLE_GRANT_EXPIRY_ISO_FORMAT}) AS iso FROM access_vehicle_links\n"
         "        WHERE target_kind = 'grant' AND target_id = $1 AND task_id = $2`, [grantId, context.taskId]);\n"
         "    const after: string | null = own.rows[0]?.iso ?? null;"),
    ], {C7_MAX, C7_RECOMPUTE, C7_NULL}),
    ('owner default D4: an owner-plane row linked by an assignment is re-dated', [
        (CARRIER, "    if (!row || !row.provenance || row.links === 0 || row.created_here !== true) return false;",
         "    if (!row || row.links === 0) return false;"),
        (CARRIER, "        WHERE id = $1 AND provenance IS NOT NULL AND expires_at IS DISTINCT FROM $2::timestamptz",
         "        WHERE id = $1 AND expires_at IS DISTINCT FROM $2::timestamptz"),
    ], {C7_OWNER}),
    ('clause 7: a shared row that survives a reaped link keeps its old date', [
        (CARRIER, "        if (link.target_kind === 'grant') {\n"
                  "          await this.recomputeRowExpiry(client, String(link.target_id), actor, { taskId, reason });\n"
                  "        }\n",
         ''),
    ], {C7_RECOMPUTE, C7_NULL}),
    ('clause 7 (unchanged by this lane): the terminal PATCH no longer reaps', [
        (TASKS, "        await accessVehicleService.detach(client, id, vehicleAuditActor,\n"
                "          'AZ-S7: the task reached a terminal status');\n",
         ''),
    ], {T3, C4_TERMINAL, C5_PATCH, C5_ARCHIVE, C5_REOPEN, C7_RECOMPUTE, C7_NULL}),
    ('OP-11: a recovery retry with a different date answers replayed and drops the date', [
        (TASKS, "      const replayed = alreadyRecovered\n"
                "        && (input.roleGrantExpiry === undefined\n"
                "          || await this.assignmentCarriesExpiry(client, taskId, input.roleGrantExpiry));",
         # The date test stays referenced (so the mutant compiles) and can never decide.
         "      const replayed = alreadyRecovered\n"
         "        && (input.roleGrantExpiry === undefined || input.roleGrantExpiry !== undefined\n"
         "          || await this.assignmentCarriesExpiry(client, taskId, input.roleGrantExpiry));"),
    ], {RECOVERY}),
    ('E62 / OP-6: re-asserting the same assignee with a date changes nothing', [
        (TASKS, "      } else if (roleGrantExpiry !== undefined && newAssignment && !wasTerminal) {",
         "      } else if (roleGrantExpiry !== undefined && newAssignment && !wasTerminal && id === 'never') {"),
    ], {C6_REDATE}),
    ('review round 1, B1: the normalized date rides the payload as a body-shaped key, so a raw body field '
     're-dates the rows without the assigning act', [
        # The round-1 carriage, exactly: writer and reader agree on the string key
        # (every lawful date still flows), and a request body can now name it.
        (EXPIRY, "const ASSIGNING_ACT_EXPIRY = Symbol('assigningActRoleGrantExpiry');",
         "const ASSIGNING_ACT_EXPIRY = 'roleGrantExpiry' as unknown as symbol;"),
    ], {C4C}),
    ('review round 1, N1 (RM5): the access view reports the link\'s date as the row\'s effective expiresAt', [
        (CARRIER, "      expiresAt: row.row_expires_iso ?? null,", "      expiresAt: row.link_expires_iso ?? null,"),
    ], {C7_MAX}),
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
    copy = Path(tempfile.mkdtemp(prefix='role-grant-expiry-drill-'))
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
