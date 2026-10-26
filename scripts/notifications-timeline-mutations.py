#!/usr/bin/env python3
"""Mutation drill for "Needs your action" and the Timeline (card 5854f0d6;
Notifications and Timeline design, Slice A, section 7; owner ruling E394).

Each control edits literal anchors in a DISPOSABLE COPY of the tree, runs the
live suite (src/__tests__/notificationsTimelineLive.test.ts) against a REAL
disposable PostgreSQL through the production router, and requires that suite to
go red at EXACTLY the predeclared set of tests, for an assertion (not a compile
error, a timeout or a crashed fixture). Every control reddens a different set,
so no two controls can be satisfied by one assertion.

The controls withdraw, one at a time, what the design promises:
  - the in-query scope: the task arm's list scope, each arm's scope CEILING
    (reports, phases, projects, skills, skill versions), the approval arm's
    login-session gate and its self-scope;
  - the report conjuncts (soft delete, promoted, outpost) and the skill
    conjuncts (the catalogue rule, the R2-B2 version rule);
  - the R2-B3 rule that a withheld approval actor never matches a person;
  - the action list: the hub's `decidable` check, skill reviews kept out of
    Decisions, the unusable-Verifier arm and the sweep's activity clock;
  - paging: the feed cursor keyset, each capped arm's (time, id) tuple compare
    (approvals and skill versions) and the window floor that never rises
    (R2-B1);
  - the payload emits: the public append's one row, the assigned-only rule and
    field names never values;
  - the actor census (section 4.3): a Phase created through the route, over
    REST and over the MCP ingress, records who created it;
  - the query on a realistic board (the fix-forward after the full tier): the
    date window's exact cursor bounds (without them the window is planned as a
    walk of the primary key), each window's cap of one page per source, and
    the Timeline transaction's settings (JIT off, a statement ceiling);
  - the Action Center's text search (owner ruling E453): a title matched
    outside the arms' scope, an approval row matched on a Task title the
    caller cannot read, the search applied after the LIMIT (short pages), and
    the caller's wildcards taken as wildcards;
  - the seen mark (owner ruling E455): a mark stored for a key the caller
    cannot see (widening), another principal's mark counted (not per caller),
    the bell counting seen items, and a mark that ignores the occurrence (a new
    occurrence stays seen).

The source tree is never edited: its bytes are fingerprinted before and after.

Every run (the baseline and each control) starts on the SAME fresh database: a
template is built once by loading the base schema and running every migration
into a new, empty database, and before each run the named database is dropped
and recreated from it. A suite run writes rows other Accounts can see, so
without this a later control would page through every earlier run's rows and
redden for that reason, not for its mutation. The template is never a copy of
the named database: in the full tier the named database is the job's, holding
every earlier step's rows, and with an arm's scope withdrawn a reader would
page through those rows too. The named database is copied aside first and
restored from that copy at the end, so the job's later steps see it unchanged.

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \\
    python3 scripts/notifications-timeline-mutations.py --output-dir /tmp/notifications-timeline-drill
  python3 scripts/notifications-timeline-mutations.py --describe   # checks every anchor, no database
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
SUITE = 'src/__tests__/notificationsTimelineLive.test.ts'
TIMELINE = 'backend/src/services/TimelineService.ts'
VISIBILITY = 'backend/src/services/ReportVisibility.ts'
ACTIONS = 'backend/src/services/NotificationActionsService.ts'
ELEMENTS = 'backend/src/services/TaskElementService.ts'
TASKS = 'backend/src/services/TaskManagerDB.ts'
PHASE_ROUTES = 'backend/src/routes/phases.ts'

# Tests, by title.
LEAK = ("A's Timeline holds none of B's Task, Report (promoted, outpost, deleted), Phase, Project, Skill draft or "
        "approval rows, on any page")
B_OWN = ("B's own Timeline lists its Task, Report, promoted and outpost Report, Phase, Project, returned skill version "
         "and approval (the negative control)")
ACTIONS_LEAK = "A's action list holds none of B's items, and B's holds its own Decision"
BEARER_TASKS = "a bearer holding only tasks:read reads its Account's task rows"
BEARER = 'a bearer holding only tasks:read sees no {} row'
BEARER_APPROVALS = "a bearer never reads approval rows, even its own request's"
OUTPOST = 'an Account that reads the source Task reads the promoted Report and never the assigned-only outpost Report'
CATALOGUE = "A never sees the catalogue row of B's unpublished Skill"
NEVER_SHORT = 'pages are never short: every page before the last holds exactly the limit'
ANCHOR = ("the outside anchor: every task, report, phase and project row A's Timeline names is readable at its own point "
          "route")
PARITY = 'the report list-scope builder and filterVisibleReports return the same id set for A and for B'
SKILL_VERSION = "a non-administrator skills:write holder never sees another owner's returned version of an unpublished Skill"
WITHHELD = 'a requester filtering by the decider learns nothing: the withheld actor never matches (R2-B3)'
DECISION = "Decision: B decides its own Connector's mint request while it is pending, and it leaves when decided"
UNDECIDABLE = 'a pending item this session cannot decide is not a Decision: a grant request waits on an administrator'
VERIFY = 'Verify: a Task in Review whose Verifier is the caller is listed, and leaves when it is no longer in Review'
NO_VERIFIER = 'Verify (no Verifier) reaches the account owner, and leaves when a usable Verifier is set'
STUCK = "Stuck follows the sweep's activity clock: a status, an announced episode, and a linked Report that re-arms it"
SKILL_REVIEW = ('Skill review: a human administrator who did not write the version lists it, never as a Decision, until '
                'it is published')
NO_BEARER = "Decisions and Skill reviews never reach a bearer, even its own Account's"
BELL = "the bell's count is the actions total: every item counted once, by kind"
PAGING = 'no feed row repeats or goes missing across pages while rows are written between page reads'
WINDOWS = 'each approval and skill-version row is on exactly one page, past a feed row older than the next page (R2-B1)'
LATE = 'a row committed after page 1 inside a window already served appears after a refresh, never mid-scroll'
CAPPED = 'capped mode: a type filter of approvals only pages that arm on its own keyset, capped at the page size (R2-N1)'
CAPPED_SKILLS = ('capped mode: a type filter of skill versions only pages that arm on its own keyset, capped at the page '
                 'size (R2-N1)')
CENSUS = 'records the acting principal: {}'
FILTER_PAGING = 'filters combine with paging: a project filter paged three at a time equals the unpaged filtered set'
PAYLOAD = 'a task.updated payload carries field names, sorted, and never a value'
APPEND = 'a public authored non-restricted append yields exactly one feed row naming the entry type'
RESTRICTED = 'an append referencing an assigned-only entry yields none'
SEEN = "POST moves only the caller's own mark, clamped to the head and never backwards; a GET writes nothing"
# The fix-forward after the full tier: plans, bounds and the Timeline transaction.
CUT = 'a window holds at most a page of each windowed source, and paging on below a cut lists every row once'
PLANS = 'every filter reads its index on a realistic board, and no page reads the feed sequentially'
WINDOW_FAST = 'the 30-to-20-minutes window returns quickly past a dense last half hour and 90 days of earlier rows'
NO_JIT = 'compiles nothing: a Timeline read runs read-only with JIT off'
CEILING = 'a runaway statement is cancelled at the ceiling'
# Owner rulings E453 (the text search) and E455 (the seen mark).
Q_LEAK = "the text search never matches an object the caller cannot see: B's titles find nothing for A, and B's own rows for B"
Q_APPROVAL = "an approval row whose Task the caller cannot read never matches that Task's title"
Q_MATCH = "the text search matches titles and labels in any case, and takes the caller's wildcards literally"
Q_SHORT = 'a searched page is never short: the search is in the query, before the limit, never after it'
Q_BOARD = 'the text search on a realistic board: bounded, never a sequential feed read, and a hidden title matches nothing'
SEEN_STAYS = 'a seen item stays listed, shown as seen, until it is resolved, and the bell counts only the unseen ones'
SEEN_NEW = 'a new occurrence of the same item reads as unseen again'
SEEN_HIDDEN = ('a key the caller cannot see is ignored without a trace: nothing is stored, and the answer is that of a key '
               'that never existed')
SEEN_PER_CALLER = 'the mark is per caller: one administrator marking a Decision seen leaves it unseen for another'

# (name, [(file, anchor, replacement), ...], the exact set of tests that must fail).
CONTROLS = [
    ('the task arm is not narrowed by the task list scope',
     [(TIMELINE, 'WHERE ${task.id} = fe.object_id AND ${p.scope(task)}))`);',
       'WHERE ${task.id} = fe.object_id AND (${p.scope(task)} OR TRUE)))`);')],
     # The seen clamp is the caller's own head, so a task row the caller
     # cannot read (B's, written last) must stay above it. E453: a search
     # then finds B's Task rows too, on the drill board and the realistic one.
     {LEAK, ANCHOR, SEEN, Q_LEAK, Q_BOARD}),
    ('the report arm ignores the reports:read ceiling',
     [(TIMELINE, '    if (viewer.ceilings.reports) {', '    if (viewer.ceilings.reports || viewer.principalId.length > 0) {')],
     {BEARER.format('report')}),
    ('the phase arm ignores the phases:read ceiling',
     [(TIMELINE, '    if (viewer.ceilings.phases) {', '    if (viewer.ceilings.phases || viewer.principalId.length > 0) {')],
     {BEARER.format('phase')}),
    ('the project arm ignores the projects:read ceiling',
     [(TIMELINE, '    if (viewer.ceilings.projects) {\n      const project', '    if (viewer.ceilings.projects || viewer.principalId.length > 0) {\n      const project')],
     {BEARER.format('project')}),
    ('the skill arm ignores the skills:read ceiling',
     [(TIMELINE, '    if (viewer.ceilings.skills) {', '    if (viewer.ceilings.skills || viewer.principalId.length > 0) {')],
     {BEARER.format('skill')}),
    ('the report arm drops the report conjuncts',
     [(TIMELINE, 'WHERE ${report.id} = fe.object_id AND ${narrowing} AND ${visibility}))`);',
       'WHERE ${report.id} = fe.object_id AND ${narrowing} AND (${visibility} OR TRUE)))`);')],
     {LEAK, B_OWN, OUTPOST, ANCHOR, Q_LEAK}),
    ('narrowing 2 is gone: a promoted Report outlives its concealed source Task',
     [(VISIBILITY, 'OR ${sourceTaskVisible})', 'OR ${sourceTaskVisible} OR TRUE)')],
     {LEAK, ANCHOR, PARITY, Q_LEAK}),
    ('narrowing 3 is gone: an assigned-only outpost Report reaches any reader of its Task',
     [(VISIBILITY, '        OR ${assigned}))`;', '        OR ${assigned} OR TRUE))`;')],
     {OUTPOST, PARITY}),
    ('a soft-deleted Report is listed',
     [(VISIBILITY, '  return `(${report}.deleted_at IS NULL', '  return `(TRUE')],
     {LEAK, B_OWN, OUTPOST, ANCHOR, PARITY, Q_LEAK}),
    ("the skill arm drops the catalogue rule (an unpublished Skill's drafts)",
     [(TIMELINE, 'AND (s.current_published_version_id IS NOT NULL OR ${draftVisibilitySql(viewer.skillViewer, account, false)})))`);',
       'AND (s.current_published_version_id IS NOT NULL OR ${draftVisibilitySql(viewer.skillViewer, account, false)} OR TRUE)))`);')],
     {CATALOGUE, LEAK}),
    ('the skill-version arm drops the R2-B2 draft rule',
     [(TIMELINE, '             OR ${draftVisibilitySql(viewer.skillViewer, account, true)})`,',
       '             OR ${draftVisibilitySql(viewer.skillViewer, account, true)} OR TRUE)`,')],
     {LEAK, SKILL_VERSION}),
    ('the skill-version arm ignores the skills:read ceiling',
     [(TIMELINE, "    if (!viewer.ceilings.skills || !wantedTypes(query).has('skill-version')",
       "    if ((!viewer.ceilings.skills && viewer.principalId.length < 0) || !wantedTypes(query).has('skill-version')")],
     {BEARER.format('skill-version')}),
    ('a bearer reads approval rows',
     [(TIMELINE, "    if (!viewer.isSession || !wantedTypes(query).has('approval')) return null;",
       "    if (!wantedTypes(query).has('approval')) return null;")],
     {BEARER_APPROVALS}),
    ('approval rows are not narrowed by the approvals self-scope',
     [(TIMELINE, "    const clauses: string[] = [scope ?? 'TRUE'];", "    const clauses: string[] = [scope ? `(${scope} OR TRUE)` : 'TRUE'];")],
     {LEAK}),
    ('a withheld approval actor matches a person filter (R2-B3)',
     [(TIMELINE, ' AND (${APPROVAL_ACTOR_HANDLE}) IS NOT NULL`);', '`);')],
     {WITHHELD}),
    ('a pending item the session cannot decide is listed as a Decision',
     [(ACTIONS, " && item.status === 'pending' && item.decidable !== false)", " && item.status === 'pending')")],
     {UNDECIDABLE}),
    ('skill reviews are counted as Decisions too',
     [(ACTIONS, '!NOT_DECISIONS.has(String(item.kind)) && ',
       "(!NOT_DECISIONS.has(String(item.kind)) || String(item.kind) === 'skill-publish') && ")],
     {SKILL_REVIEW}),
    ('the unusable-Verifier arm is gone',
     [(ACTIONS, "(vt.status = 'review' AND ${verifierUnusableSql('vt', usableParam)}",
       "(vt.status = 'review' AND (${verifierUnusableSql('vt', usableParam)} AND FALSE)")],
     # E455: the hidden-key test reads B's no-Verifier item as its owner's own.
     {NO_VERIFIER, SEEN_HIDDEN}),
    ("Stuck ignores the sweep's activity clock",
     [(ACTIONS, "${stuckEpisodeAnnouncedSql('st.id', stuckActivityAtSql('st'))}",
       "${stuckEpisodeAnnouncedSql('st.id', stuckActivityAtSql('st') && \"'-infinity'::timestamptz\")}")],
     {STUCK}),
    ('the feed keyset admits the row it ended on',
     [(TIMELINE, 'clauses.push(`fe.cursor < ${p.add(options.before)}::bigint`);',
       'clauses.push(`fe.cursor <= ${p.add(options.before)}::bigint`);')],
     {WINDOWS, FILTER_PAGING, PAGING, Q_SHORT}),
    ("the capped arm's (time, id) tuple compare admits the row it ended on",
     [(TIMELINE, 'clauses.push(`(ae.occurred_at, ae.id) < (${p.add(window.key[0])}',
       'clauses.push(`(ae.occurred_at, ae.id) <= (${p.add(window.key[0])}')],
     # A windowed page continues below a cut on the same key, so the window tests redden too.
     {CAPPED, CUT, WINDOWS}),
    ("the skill-version capped arm's (time, id) tuple compare admits the row it ended on",
     [(TIMELINE, 'clauses.push(`(e.created_at, e.id) < (${p.add(window.key[0])}',
       'clauses.push(`(e.created_at, e.id) <= (${p.add(window.key[0])}')],
     {CAPPED_SKILLS, WINDOWS}),
    ('the window floor rises past the token (R2-B1)',
     [(TIMELINE, '        return before !== null && before < oldest ? before : oldest;', '        return before === null ? oldest : oldest;')],
     {WINDOWS, CUT}),
    ('the date window loses its exact cursor bounds (the predicate the full tier caught)',
     # The `inside` text goes too: an unused binding would not compile, and a
     # control must fail at an assertion, never at the compiler.
     [(TIMELINE, "      const inside = window.map((bound) => `window_row.${bound}`).join(' AND ');\n"
                 "      const windowCursors = `(SELECT window_row.cursor FROM feed_events window_row WHERE ${inside} OFFSET 0) window_rows`;\n"
                 "      clauses.push(`fe.cursor >= (SELECT min(window_rows.cursor) FROM ${windowCursors})`);\n"
                 "      clauses.push(`fe.cursor <= (SELECT max(window_rows.cursor) FROM ${windowCursors})`);\n",
       '')],
     {PLANS, WINDOW_FAST}),
    ('a window hands over more than a page of approval rows',
     [(TIMELINE, '      approvalRows = approvals.slice(0, limit);\n      skillRows = skills.slice(0, limit);\n      const carry',
       '      approvalRows = approvals;\n      skillRows = skills.slice(0, limit);\n      const carry')],
     {CUT}),
    ('the Timeline transaction applies none of its settings (JIT on, no statement ceiling)',
     [(TIMELINE, '      for (const setting of TIMELINE_TRANSACTION_SETTINGS) await client.query(setting);\n', '')],
     {NO_JIT, CEILING}),
    ('a public authored append announces nothing',
     [(ELEMENTS, '      if (await this.streamEntryAnnounceable(client, result.entry)) {',
       '      if (result.entry === null && await this.streamEntryAnnounceable(client, result.entry)) {')],
     {APPEND}),
    ('an entry referencing an assigned-only entry is announced',
     [(ELEMENTS, '    return restricted.rows.length === 0;', '    return restricted.rows.length >= 0;')],
     {RESTRICTED}),
    ('a task.updated payload carries values',
     [(TASKS, '          fields: appliedFieldNames(updates),\n', '          fields: appliedFieldNames(updates),\n          values: updates,\n')],
     {PAYLOAD}),
    ('a Phase created through the route records no acting principal (the round 1 blocker)',
     [(PHASE_ROUTES, 'projectId: res.locals.authorizedProjectId }, phaseActor(req));',
       'projectId: res.locals.authorizedProjectId }, {});')],
     {CENSUS.format('POST /phases'), CENSUS.format('MCP relayhall_phase_create')}),
    # Owner ruling E453: the text search.
    ('the text search admits a title outside the arms (an OR beside the scope, not a conjunct inside it)',
     [(TIMELINE, "    clauses.push(`(${arms.join('\\n            OR ')})`);",
       "    clauses.push(`(${arms.join('\\n            OR ')}${query.q ? ` OR (fe.object_type, fe.object_id) IN (SELECT 'task'::text, leak.id FROM tasks leak WHERE leak.title ILIKE ${p.add(timelineSearchPattern(query.q))})` : ''})`);")],
     {Q_LEAK, Q_BOARD}),
    ("the approval arm matches a Task title the caller cannot read",
     [(TIMELINE, "      clauses.push(`EXISTS (SELECT 1 FROM ${searched.from} WHERE ${searched.id} = atk.id AND ${p.scope(searched)}\n"
                 "                 AND ${ilike(`${searched.id.split('.')[0]}.title`, pattern)})`);",
       "      clauses.push(`(${ilike('atk.title', pattern)} OR ${searched.id.length < 0})`);")],
     {Q_APPROVAL}),
    ('the text search is applied after the LIMIT (a post-filter), so a searched page runs short',
     [(TIMELINE, "    if (query.q) {\n      // E453: the text search, a conjunct of this statement (before the LIMIT).",
       "    if (query.q && query.limit < 0) {\n      // E453: the text search, a conjunct of this statement (before the LIMIT)."),
      (TIMELINE, '    const items = await this.describe(db, viewer, feedPage, approvalRows, skillRows);',
       "    const items = (await this.describe(db, viewer, feedPage, approvalRows, skillRows)).filter((item) => !query.q\n"
       "      || `${item.object.title ?? ''} ${item.label}`.toLowerCase().includes(query.q.toLowerCase()));")],
     {Q_SHORT, Q_BOARD}),
    ("the search pattern takes the caller's wildcards as wildcards",
     [(TIMELINE, "  return `%${q.replace(/[\\\\%_]/g, (match) => `\\\\${match}`)}%`;", "  return `%${q}%`;")],
     {Q_MATCH}),
    # Owner ruling E455: the seen mark.
    ('a seen mark is stored for a key the caller cannot see (the mark widens)',
     [(ACTIONS, '      : answer.items.filter((item) => request.keys.includes(item.key));',
       '      : request.keys.map((key) => ({ key, since: new Date().toISOString() }));')],
     # Every requested key is stored, the hidden one included; and a mark no
     # longer carries the item's own since, so no mark names an occurrence.
     {SEEN_HIDDEN, SEEN_NEW, SEEN_STAYS, SEEN_PER_CALLER}),
    ("another principal's seen mark counts (the mark is not per caller)",
     [(ACTIONS, '        WHERE principal_id = $1::uuid AND item_key = ANY($2::text[])`,',
       '        WHERE (principal_id = $1::uuid OR TRUE) AND item_key = ANY($2::text[])`,')],
     {SEEN_PER_CALLER}),
    ('the bell counts seen items too',
     [(ACTIONS, '      unseen: items.filter((item) => !item.seen).length,', '      unseen: items.length,')],
     {SEEN_STAYS}),
    ('a seen mark ignores the occurrence: a new occurrence stays seen',
     [(ACTIONS, '    for (const item of items) item.seen = marks.get(item.key) === Date.parse(item.since);',
       '    for (const item of items) item.seen = marks.has(item.key) || Date.parse(item.since) < 0;')],
     {SEEN_NEW}),
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


FRESH_DATABASE_JS = r"""
const { Client } = require(process.argv[1]);
const [url, statements] = [new URL(process.argv[2]), JSON.parse(process.argv[3])];
url.pathname = '/postgres';
(async () => {
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try { for (const statement of statements) await client.query(statement); } finally { await client.end(); }
})().catch((error) => { console.error(String(error && error.message)); process.exit(1); });
"""


def database_names():
    name = unquote(urlparse(os.environ['RELAYHALL_TEST_DB_URL']).path.lstrip('/'))
    if not re.fullmatch(r'[a-z0-9_]+', name):
        raise SystemExit('the test database name must be lower-case letters, digits and underscores')
    return name, f'{name}_ntdrill_template'


def database_statements(statements):
    """Run maintenance statements against the server of RELAYHALL_TEST_DB_URL (never through a shell)."""
    pg = str(ROOT / 'backend/node_modules/pg')
    result = subprocess.run(['node', '-e', FRESH_DATABASE_JS, pg, os.environ['RELAYHALL_TEST_DB_URL'], json.dumps(statements)],
                            capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        raise SystemExit(f'database maintenance failed: {result.stderr.strip()[:300]}')


def migrate_fresh(database):
    """Load the base schema and run every migration into `database`, through the
    repository's own scripts, with the server and credentials of RELAYHALL_TEST_DB_URL."""
    url = urlparse(os.environ['RELAYHALL_TEST_DB_URL'])
    env = {**os.environ, 'DB_HOST': url.hostname or '', 'DB_PORT': str(url.port or 5432), 'DB_NAME': database,
           'DB_USER': unquote(url.username or ''), 'DB_PASSWORD': unquote(url.password or '')}
    for command in (['node', 'scripts/load-base-schema.js'], ['npm', 'run', '-s', 'migrate']):
        result = subprocess.run(command, cwd=ROOT / 'backend', env=env, capture_output=True, text=True, timeout=900)
        if result.returncode != 0:
            raise SystemExit(f'migrating the fresh template failed at {command[-1]}: {result.stderr.strip()[-300:]}')


def fresh_database():
    name, template = database_names()
    database_statements([f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)', f'CREATE DATABASE "{name}" TEMPLATE "{template}"'])


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


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--describe', action='store_true')
    parser.add_argument('--discover', action='store_true',
                        help='report what each control reddens and continue (for writing the must-fail sets)')
    args = parser.parse_args()

    for _, edits, _ in CONTROLS:
        texts = {}
        for path, anchor, replacement in edits:
            texts[path] = once(texts.get(path, (ROOT / path).read_text()), anchor, replacement)
    if not args.discover:
        sets = [frozenset(c[2] or ()) for c in CONTROLS]
        if len(set(sets)) != len(sets) or any(not s for s in sets):
            raise SystemExit('every control must declare a non-empty must-fail set that no other control shares')
    if args.describe:
        print(json.dumps([{'control': c[0], 'files': sorted({e[0] for e in c[1]}),
                           'mustFail': sorted(c[2] or ())} for c in CONTROLS], indent=2))
        return

    require_disposable_database()
    if not args.output_dir:
        raise SystemExit('--output-dir is required')
    out = args.output_dir.resolve()
    if out == ROOT or ROOT in out.parents:
        raise SystemExit('--output-dir must lie outside the repository')
    out.mkdir(parents=True, exist_ok=False)

    before = fingerprints(ROOT)
    copy = Path(tempfile.mkdtemp(prefix='notifications-timeline-drill-'))
    receipts = []
    database, template = database_names()
    original = f'{database}_ntdrill_original'
    # The named database is copied aside (restored at the end); the template is
    # a fresh database, migrated here, never a copy of the named one.
    database_statements([f'DROP DATABASE IF EXISTS "{template}" WITH (FORCE)',
                         f'DROP DATABASE IF EXISTS "{original}" WITH (FORCE)',
                         f'CREATE DATABASE "{original}" TEMPLATE "{database}"',
                         f'CREATE DATABASE "{template}"'])
    try:
        migrate_fresh(template)
        shutil.copytree(ROOT, copy, dirs_exist_ok=True, ignore=shutil.ignore_patterns(*IGNORED, '*.log'))
        (copy / 'backend/node_modules').symlink_to((ROOT / 'backend/node_modules').resolve(), target_is_directory=True)

        fresh_database()
        code, tests, _ = run_suite(copy, out, 'baseline')
        titles = [t['title'] for t in tests]
        if code != 0 or not tests or any(t['status'] != 'passed' for t in tests):
            raise SystemExit('baseline is not green')
        if len(set(titles)) != len(titles):
            raise SystemExit('two tests share a title, so a declared title would not name one test')
        for _, _, must_fail in CONTROLS:
            if must_fail and not set(must_fail) <= set(titles):
                raise SystemExit(f'a declared test is absent from the suite: {sorted(set(must_fail) - set(titles))}')

        for index, (name, edits, must_fail) in enumerate(CONTROLS, start=1):
            originals = apply(copy, edits)
            try:
                fresh_database()
                code, tests, suite_messages = run_suite(copy, out, f'control-{index}')
            finally:
                for path, text in originals.items():
                    (copy / path).write_text(text)
            failed = {t['title'] for t in tests if t['status'] == 'failed'}
            messages = re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(
                m for t in tests if t['status'] == 'failed' for m in t.get('failureMessages', [])))
            semantic = code != 0 and [t['title'] for t in tests] == titles and failed == set(must_fail or ()) \
                and all('expect(' in '\n'.join(t.get('failureMessages', [])) for t in tests if t['status'] == 'failed') \
                and not re.search(r'TS\d{4}|SyntaxError|Test suite failed to run|Exceeded timeout|ECONNREFUSED',
                                  messages + suite_messages)
            receipts.append({'control': name, 'files': sorted(originals), 'mustFail': sorted(must_fail or ()),
                             'failed': sorted(failed), 'red': semantic})
            (out / 'receipts.json').write_text(json.dumps(receipts, indent=2))
            print(f"{'RED ' if semantic else 'MISS'} {name} -> {sorted(failed)}", flush=True)
            if not semantic and not args.discover:
                raise SystemExit(f'control did not fail at its declared assertions: {name}')
    finally:
        shutil.rmtree(copy, ignore_errors=True)
        database_statements([f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)',
                             f'CREATE DATABASE "{database}" TEMPLATE "{original}"',
                             f'DROP DATABASE IF EXISTS "{original}" WITH (FORCE)',
                             f'DROP DATABASE IF EXISTS "{template}" WITH (FORCE)'])
        after = fingerprints(ROOT)
        (out / 'closure.json').write_text(json.dumps({
            'sourceUnchanged': before == after, 'copyRemoved': not copy.exists(), 'controls': len(receipts),
        }, indent=2))
    if before != fingerprints(ROOT):
        raise SystemExit('the source tree changed during the drill')
    red = sum(1 for receipt in receipts if receipt['red'])
    if args.discover:
        print(f'discover: {red} of {len(receipts)} controls red at their declared assertions; source unchanged')
    else:
        print(f'all {len(receipts)} controls red at their declared assertions; source unchanged')


if __name__ == '__main__':
    main()
