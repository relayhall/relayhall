#!/usr/bin/env python3
"""Mutation drill for the notification history and the approvals hub view
(card b1e3b16d: hub lane L2 and the review-and-approve page).

Each control below edits literal anchors in a DISPOSABLE COPY of the tree, runs
ONE live suite against a REAL disposable PostgreSQL through the production
router, and requires that suite to go red at EXACTLY the predeclared set of
tests, for an assertion (not a compile error, a timeout or a crashed fixture).
Every control reddens a different set, so no two controls can be satisfied by
one assertion.

The controls withdraw, one at a time, what the lane promises:
  - read state is per principal, persisted (it survives a restart), seeded by
    the migration's backfill, never counting your own acts or a filed request;
  - the history narrows by the task predicate, the approvals self-scope and the
    login-session gate, keeps the stuck notice addressed, and honours My work,
    unread, and mark-all's filter and the caller's own mark;
  - the hub classifies group / shared / private / board with live Group grants
    only and the creation-default Group first, conceals unreadable titles,
    lists every kind (the skill-review adapter) but never to a version's
    creator, reports decidable by the decide route's rule, filters by group,
    leaves the default GET /approvals answer alone, and adds no decision route;
  - the verification requests waiting on a verifier are listed (a kind the page
    must not miss), only while active, only on a task the session may read,
    and never as decidable.

The source tree is never edited: its bytes are fingerprinted before and after.

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \\
    python3 scripts/notification-hub-mutations.py --output-dir /tmp/notification-hub-drill
  python3 scripts/notification-hub-mutations.py --describe   # checks every anchor, no database
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
L2 = 'src/__tests__/notificationReadStateLive.test.ts'
HUB = 'src/__tests__/approvalsHubLive.test.ts'
HISTORY = 'backend/src/services/NotificationHistoryService.ts'
MIGRATION = 'backend/src/migrations/144_notification_read_state.sql'
HUB_SERVICE = 'backend/src/services/ApprovalHubService.ts'
ROUTE = 'backend/src/routes/approvals.ts'

# L2 tests, by title.
B_UNREAD = "A marks it read: A reads it as read and its unread count drops by one; B still has it unread"
UNREAD_ONLY = 'marking twice is idempotent, and ?unread=true leaves the row out for A only'
OWN_ACT = 'a row the caller did itself is never unread'
FILTERED_ALL = ("a filtered read-all (type=status) marks A's visible status rows only: not the review request, "
                "not B's private task, not B")
OWN_MARK = "the unfiltered read-all (who=all, every type) moves only the caller's own mark"
NO_LEAK = "A sees nothing of B's private task under any filter, and no title leaks"
NO_GRANT = 'C, with no grant at all, sees neither task'
ADDRESSED = 'B reads the task but is not the addressee: no stuck row under any filter, and the key is concealed'
MINE_DEFAULT = "B is not a role holder on A's task: the default leaves it out, who=all brings it in"
REQUESTED_READ = 'the requested event is listed for A (My work) but never unread: it waits in Needs your decision'
DECIDED_SCOPE = 'root decides: the decision reaches A unread; B and C see no row of it'
BEARER = "a bearer credential never reads approval rows, even its own request's"
BACKFILL = ('a principal with no mark reads only what happened after it was created; the backfill moves it to '
            'the feed head')
RESTART = 'a row A marked read is still read after the board restarts on a fresh module registry and pool'
CONCEALED_KEYS = 'a malformed key, an absent key and an invisible key answer the same 404 and write nothing'
SKILL_ROWS = ("A writes a version, it goes to review, root publishes it: A reads one unread skill row; "
              "the submission is never unread")

# Hub tests, by title.
CLASSES = 'each mint request carries the class its project earns'
ORDER = 'several Groups list under the creation-default Group first, then by name'
ROOT_PRIVATE = "root sees another Account's private project as private to its owner"
CONCEAL = "OWNER lists its connector's request about a task it can no longer read: the id, never the title"
OWNER_DECIDES = "OWNER: its connector's mint requests are decidable; the grant request waits on an administrator"
ROUTE_AGREES = 'the route agrees with the hub, item by item: refused where not decidable, decided where decidable'
ADAPTER_LISTS = 'root, a human with skills:admin who did not write it, lists it as a skill-publish item'
ADAPTER_AUTHOR = 'a version is never listed to the author who wrote it, even one holding skills:admin'
ADAPTER_PUBLISHES = 'its decideVia publishes it through the EXISTING route, and it leaves the hub'
KIND_FILTER = 'kind narrows to one kind; skill-publish narrows to the adapter'
GROUP_FILTER = 'group narrows by class word or by Group id'
DEFAULT_UNCHANGED = 'the default GET /approvals answer carries no hub field and the very rows the service lists'
HUB_IDS = 'the hub lists exactly the ids the default list does, for every session'
ROUTE_CENSUS = ('the approvals router mounts exactly the two decision routes beside the reads and the change-request doors, and no other')
VERIFY_LISTED = ('the task owner lists a pending request on its task: who asked, which task, when, and the verifier, '
                 'never decidable')
VERIFY_ACTIVE = 'a leased request is listed as leased; a lapsed or finished one is not'
VERIFY_SCOPE = 'a request on a task the session cannot read is not listed, and its title appears nowhere; root lists it'
VERIFY_KIND = 'kind=native-review lists only them; the other kinds and status=decided list none of them'
VERIFY_NO_DECISION = 'nothing decides it here: the approvals routes answer 404 for its id, and the request is untouched'

# (name, suite, [(file, anchor, replacement), ...], the exact set of tests that must fail)
CONTROLS = [
    ('read state is shared between principals', L2,
     [(HISTORY, 'FROM notification_reads nr WHERE nr.principal_id = v.id AND nr.item_key = ${keySql})',
       'FROM notification_reads nr WHERE nr.item_key = ${keySql})')],
     {B_UNREAD, UNREAD_ONLY}),
    ('read state lives only as long as the process (the restart mutation)', L2,
     [(HISTORY, "export const ITEM_KEY_PATTERN = new RegExp(",
       "const MODULE_LOADED_AT = new Date().toISOString();\nexport const ITEM_KEY_PATTERN = new RegExp("),
      (HISTORY, 'FROM notification_reads nr WHERE nr.principal_id = v.id AND nr.item_key = ${keySql})',
       "FROM notification_reads nr WHERE nr.principal_id = v.id AND nr.item_key = ${keySql} "
       "AND nr.read_at >= '${MODULE_LOADED_AT}'::timestamptz)")],
     {RESTART}),
    ('the migration backfills no read mark', L2,
     [(MIGRATION, 'INSERT INTO notification_read_marks (principal_id, feed_cursor, others_through)\n'
                  'SELECT p.id, COALESCE((SELECT max(fe.cursor) FROM feed_events fe), 0), now()\n'
                  '  FROM principals p\n'
                  'ON CONFLICT (principal_id) DO NOTHING;\n', '')],
     {BACKFILL}),
    ('the stuck notice is not addressed', L2,
     [(HISTORY, "(fe.name = 'task.stuck' AND COALESCE(tk.shepherd_principal_id, tk.creator_principal_id, "
                "tk.owner_principal_id) = v.id)", "(fe.name = 'task.stuck')")],
     {ADDRESSED}),
    ('task rows are not narrowed by the task predicate', L2,
     [(HISTORY, 'FROM ${viewer.taskScope.from} WHERE ${narrowing.sql})',
       'FROM ${viewer.taskScope.from} WHERE ${narrowing.sql} OR TRUE)')],
     {NO_LEAK, NO_GRANT, BACKFILL, RESTART}),
    ('approval rows are not narrowed by the approvals self-scope', L2,
     [(HISTORY, "         WHERE ${scope ?? 'TRUE'}", "         WHERE ${scope ?? 'TRUE'} OR TRUE")],
     {DECIDED_SCOPE}),
    ('a bearer credential reads approval rows', L2,
     [(HISTORY, "if (types.has('approval') && viewer.isSession && wants('approval-event')) {",
       "if (types.has('approval') && wants('approval-event')) {")],
     {BEARER}),
    ('My work is ignored', L2,
     [(HISTORY, "const mine = query.who === 'mine';", "const mine = query.who === 'mine' && query.who !== 'mine';")],
     {MINE_DEFAULT, SKILL_ROWS}),
    ('your own act counts as unread', L2,
     [(HISTORY, "['fe.actor_principal_id = v.id']", "['FALSE']")],
     {OWN_ACT}),
    ('a filed request counts as unread', L2,
     [(HISTORY, "[`ae.action = 'approval.requested'`, 'ae.actor_principal_id = v.id']",
       "['ae.actor_principal_id = v.id']")],
     {REQUESTED_READ, DECIDED_SCOPE}),
    ('a filtered mark-all reaches past its filter', L2,
     [(HISTORY, '    const unfiltered = query.who === \'all\'',
       '    query = { types: [], who: \'all\' };\n    const unfiltered = query.who === \'all\'')],
     {FILTERED_ALL}),
    ("an unfiltered mark-all moves every principal's mark", L2,
     [(HISTORY, '         VALUES ($1, COALESCE((SELECT max(cursor) FROM feed_events), 0), now(), now())',
       '         SELECT p.id, COALESCE((SELECT max(cursor) FROM feed_events), 0), now(), now()'
       ' FROM principals p WHERE $1::uuid IS NOT NULL')],
     {OWN_MARK}),
    ('?unread=true is ignored', L2,
     [(HISTORY, "    if (query.unreadOnly) clauses.push('NOT items.read');\n", '')],
     {UNREAD_ONLY}),
    ('mark read does not check that the caller can see the item', L2,
     [(HISTORY, '       , visible AS (SELECT item_key FROM items WHERE items.item_key = $${values.length})',
       '       , visible AS (SELECT $${values.length}::text AS item_key)')],
     {ADDRESSED, DECIDED_SCOPE, CONCEALED_KEYS}),

    ('a shared project is classified private', HUB,
     [(HUB_SERVICE, "  if (project.visibility === 'shared' || project.visibility === 'public') {",
       "  if (project.visibility === 'nobody') {")],
     {CLASSES}),
    ('several Groups are ordered by name only', HUB,
     [(HUB_SERVICE, "        ORDER BY bool_or(gr.origin = 'creation-default') DESC, g.name, g.id",
       '        ORDER BY g.name, g.id')],
     {ORDER}),
    ('an expired Group grant makes a project group-owned', HUB,
     [(HUB_SERVICE, "          AND gr.resource_id = ANY($1::uuid[])\n          AND (gr.expires_at IS NULL OR gr.expires_at > NOW())\n",
       "          AND gr.resource_id = ANY($1::uuid[])\n")],
     {CLASSES, ROOT_PRIVATE, GROUP_FILTER}),
    ('an unreadable title is not concealed', HUB,
     [(HUB_SERVICE, '        id ? { id, title: readable.has(id) || decidesAccessRequest ? title : null } : null',
       '        id ? { id, title: readable.has(id) || decidesAccessRequest || id.length > 0 ? title : null } : null')],
     {CONCEAL}),
    ('decidable is not the decide route\'s rule', HUB,
     [(HUB_SERVICE, "        decidable: record.status === 'pending' && standing !== null && live,",
       "        decidable: record.status === 'pending' && (standing !== null || kind.length > 0) && live,")],
     {OWNER_DECIDES, ROUTE_AGREES}),
    ('a kind is missing: the skill-review adapter lists nothing', HUB,
     [(HUB_SERVICE, "    if (viewer.principalKind !== 'human' || !scopesSatisfy(viewer.scopes, 'skills:admin')) return [];",
       "    if (viewer.principalKind !== 'human' || !scopesSatisfy(viewer.scopes, 'skills:admin') "
       "|| viewer.principalId.length > 0) return [];")],
     {ADAPTER_LISTS, ADAPTER_AUTHOR, ADAPTER_PUBLISHES, KIND_FILTER}),
    ("the adapter lists a version to its own creator", HUB,
     [(HUB_SERVICE, '          AND svs.created_by_principal_id IS DISTINCT FROM $1::uuid',
       '          AND $1::uuid IS NOT NULL')],
     {ADAPTER_AUTHOR}),
    ('?group= is ignored', HUB,
     [(HUB_SERVICE, '    const filtered = query.group ? items.filter((item) => matchesGroup(item.ownership, query.group as string)) : items;',
       '    const filtered = query.group && query.group.length < 0 ? items.filter((item) => matchesGroup(item.ownership, query.group as string)) : items;')],
     {GROUP_FILTER}),
    ('the default GET /approvals answer becomes the hub view', HUB,
     [(ROUTE, '    if (req.query.view !== undefined) {',
       '    if (req.query.view !== undefined || req.query.status !== undefined) {')],
     {CONCEAL, DEFAULT_UNCHANGED, HUB_IDS}),
    ('a decision route is added', HUB,
     [(ROUTE, "router.post('/:id/deny', (req: AuthRequest, res: Response) => decide(req, res, 'deny'));",
       "router.post('/:id/deny', (req: AuthRequest, res: Response) => decide(req, res, 'deny'));\n"
       "router.post('/:id/decide', (req: AuthRequest, res: Response) => decide(req, res, 'approve'));")],
     {ROUTE_CENSUS}),
    ('a kind is missing: no verification request waiting on a verifier is listed', HUB,
     [(HUB_SERVICE, '      items.push(...await this.verificationRequests(viewer));',
       '      void this.verificationRequests;')],
     {VERIFY_LISTED, VERIFY_ACTIVE, VERIFY_SCOPE, VERIFY_KIND, VERIFY_NO_DECISION}),
    ('a verification request is reported decidable', HUB,
     [(HUB_SERVICE, '        decidable: false,\n        decideVia: {},',
       '        decidable: true,\n        decideVia: {},')],
     {VERIFY_LISTED, VERIFY_ACTIVE, VERIFY_SCOPE, VERIFY_NO_DECISION}),
    ('a verification request is listed on a task the session cannot read', HUB,
     [(HUB_SERVICE, '    const rows = result.rows.filter((row: any) => readableTasks.has(String(row.task_id)));',
       '    const rows = result.rows.filter((row: any) => readableTasks.size >= 0 || row);')],
     {VERIFY_SCOPE, VERIFY_KIND}),
    ('a lapsed verification request is listed', HUB,
     [(HUB_SERVICE, "        WHERE (r.state = 'pending' AND r.request_expires_at > NOW())",
       "        WHERE (r.state = 'pending')")],
     {VERIFY_ACTIVE, VERIFY_KIND}),
    ('a verification request is classified board-level whatever its project', HUB,
     [(HUB_SERVICE, "        ownership: classify(project, groups.get(row.project_id ?? '') ?? [], viewer.principalId,",
       "        ownership: classify(null, groups.get(row.project_id ?? '') ?? [], viewer.principalId,")],
     {VERIFY_LISTED}),
]

IGNORED = ('.git', 'graphify-out', 'node_modules', 'dist', 'coverage', '__pycache__', '.pytest_cache')


def once(text, anchor, replacement):
    count = text.count(anchor)
    if count != 1:
        raise SystemExit(f'anchor matched {count} times, expected 1: {anchor[:100]!r}')
    return text.replace(anchor, replacement, 1)


def apply(tree, edits):
    """Apply a control's edits to `tree`; return the originals to restore."""
    originals = {}
    for path, anchor, replacement in edits:
        target = tree / path
        if path not in originals:
            originals[path] = target.read_text()
        target.write_text(once(target.read_text(), anchor, replacement))
    return originals


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


def run_suite(copy, out, suite, label):
    report = out / f'{label}.json'
    command = ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--testPathIgnorePatterns=/node_modules/',
               '--runTestsByPath', suite, '--json', f'--outputFile={report}']
    with (out / f'{label}.log').open('w') as log:
        code = subprocess.run(command, cwd=copy / 'backend', stdout=log, stderr=subprocess.STDOUT, timeout=900).returncode
    result = json.loads(report.read_text()) if report.exists() else {}
    tests = [a for f in result.get('testResults', []) for a in f.get('assertionResults', [])]
    suite_messages = ' '.join(str(f.get('message', '')) for f in result.get('testResults', []))
    return code, tests, re.sub(r'\x1b\[[0-9;]*m', '', suite_messages)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--describe', action='store_true')
    parser.add_argument('--discover', action='store_true',
                        help='report what each control reddens and continue (for writing the must-fail sets)')
    args = parser.parse_args()

    for _, _, edits, _ in CONTROLS:
        texts = {}
        for path, anchor, replacement in edits:
            texts[path] = once(texts.get(path, (ROOT / path).read_text()), anchor, replacement)
    sets = [(c[1], frozenset(c[3])) for c in CONTROLS]
    if len(set(sets)) != len(sets) or any(not s for _, s in sets):
        raise SystemExit('every control must declare a non-empty must-fail set that no other control shares')
    if args.describe:
        print(json.dumps([{'control': c[0], 'suite': c[1], 'files': sorted({e[0] for e in c[2]}),
                           'mustFail': sorted(c[3])} for c in CONTROLS], indent=2))
        return

    require_disposable_database()
    if not args.output_dir:
        raise SystemExit('--output-dir is required')
    out = args.output_dir.resolve()
    if out == ROOT or ROOT in out.parents:
        raise SystemExit('--output-dir must lie outside the repository')
    out.mkdir(parents=True, exist_ok=False)

    before = fingerprints(ROOT)
    copy = Path(tempfile.mkdtemp(prefix='notification-hub-drill-'))
    receipts = []
    try:
        shutil.copytree(ROOT, copy, dirs_exist_ok=True, ignore=shutil.ignore_patterns(*IGNORED, '*.log'))
        (copy / 'backend/node_modules').symlink_to((ROOT / 'backend/node_modules').resolve(), target_is_directory=True)

        titles = {}
        for suite in (L2, HUB):
            label = 'baseline-' + Path(suite).stem
            code, tests, _ = run_suite(copy, out, suite, label)
            names = [t['title'] for t in tests]
            if code != 0 or not tests or any(t['status'] != 'passed' for t in tests):
                raise SystemExit(f'baseline is not green: {suite}')
            if len(set(names)) != len(names):
                raise SystemExit(f'two tests share a title in {suite}, so a declared title would not name one test')
            titles[suite] = names
        for _, suite, _, must_fail in CONTROLS:
            if not set(must_fail) <= set(titles[suite]):
                raise SystemExit(f'a declared test is absent from {suite}: {sorted(set(must_fail) - set(titles[suite]))}')

        for index, (name, suite, edits, must_fail) in enumerate(CONTROLS, start=1):
            originals = apply(copy, edits)
            try:
                code, tests, suite_messages = run_suite(copy, out, suite, f'control-{index}')
            finally:
                for path, text in originals.items():
                    (copy / path).write_text(text)
            failed = {t['title'] for t in tests if t['status'] == 'failed'}
            messages = re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(
                m for t in tests if t['status'] == 'failed' for m in t.get('failureMessages', [])))
            semantic = code != 0 and [t['title'] for t in tests] == titles[suite] and failed == set(must_fail) \
                and all('expect(' in '\n'.join(t.get('failureMessages', [])) for t in tests if t['status'] == 'failed') \
                and not re.search(r'TS\d{4}|SyntaxError|Test suite failed to run|Exceeded timeout|ECONNREFUSED',
                                  messages + suite_messages)
            receipts.append({'control': name, 'suite': suite, 'files': sorted(originals), 'mustFail': sorted(must_fail),
                             'failed': sorted(failed), 'red': semantic})
            (out / 'receipts.json').write_text(json.dumps(receipts, indent=2))
            print(f"{'RED ' if semantic else 'MISS'} {name} -> {sorted(failed)}", flush=True)
            if not semantic and not args.discover:
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
