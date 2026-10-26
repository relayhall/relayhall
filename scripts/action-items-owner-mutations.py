#!/usr/bin/env python3
"""Mutation drill for the Action Center queue for agents (owner ruling E467).

Each control edits literal anchors in a DISPOSABLE COPY of the tree, runs the
live suite (src/__tests__/actionItemsOwnerLive.test.ts) against a REAL
disposable PostgreSQL through the production router, the MCP ingress and the
CLI, and requires that suite to go red at EXACTLY the predeclared set of tests,
for an assertion (not a compile error, a timeout or a crashed fixture). Every
control reddens a different set, so no two controls can be satisfied by one
assertion.

The controls withdraw, one at a time, what the ruling promises:
  - the owning-Account resolution: widened from a person's Account to a service
    Account, so its Connector would read an administrator's Decisions;
  - the read check: the object's readability taken from the PERSON's reach
    instead of the caller's, a title kept on an item the caller cannot read, a
    Skill review shown without the caller's Skill read, a Decision's detail
    (the requester) or approval kind (its reasons) kept for a caller whose
    approval point read is refused, a Project name shown without the caller's
    Project read;
  - one source: the owner path drifting from the Action Center's list (a kind
    dropped from the Account's list, as a copied predicate would), the merged
    cap, the person's seen state replaced by the caller's;
  - read only: the owner path writing a seen mark;
  - the surfaces: the MCP tool's kind filter and its concise line printing a
    title for a concealed item, the CLI's kind filter and its table doing the
    same.

The source tree is never edited: its bytes are fingerprinted before and after.

Every run (the baseline and each control) starts on the SAME fresh database: a
template is built once by loading the base schema and running every migration
into a new, empty database, and before each run the named database is dropped
and recreated from it. The named database is copied aside first and restored
from that copy at the end, so the job's later steps see it unchanged.

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \\
    python3 scripts/action-items-owner-mutations.py --output-dir /tmp/action-items-owner-drill
  python3 scripts/action-items-owner-mutations.py --describe   # checks every anchor, no database
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
SUITE = 'src/__tests__/actionItemsOwnerLive.test.ts'
ACTIONS = 'backend/src/services/NotificationActionsService.ts'
ROUTE = 'backend/src/routes/notifications.ts'
REGISTRY = 'backend/src/mcp/registry.ts'
CLI = 'cli/relayhall_actions.py'

# Tests, by title.
LISTS = "lists every kind waiting on the Account, and the caller's own, with the person's seen state"
AGENT = 'an Agent under that Connector reads the same queue'
OTHER = "another person's Connector sees none of P's items, and its own person's item (the negative control)"
SERVICE = "a Connector of a service Account is not a person's: it gets its own list, never the administrator Decisions"
TASKS = 'a Task the caller cannot read is kind, id, wait and link only, and its point route refuses'
DECISION = 'a Decision is readable only where its Task is: the one about a hidden Task is kind and id only'
DECISION_KIND = "a Decision's approval kind is kept only where the caller's own approval point read answers 200"
SKILL = 'a Skill review is readable only where its Skill is: kind and id without skills:read, the name with it'
PROJECT = 'a Project name appears only to a caller that reads the Project'
WIDEN = 'never widens: for every caller, an item is readable exactly when its object reads at its own point route'
SAME = "the owner queue equals the Account's own Action Center list, item for item"
PLAIN = 'a caller with no owning Account gets exactly its own plain list'
CAPS = "the caps are the Action Center's: the same 200, oldest first, capped flagged"
LEAVES = 'an item leaves the queue when its condition ends, and returns as unseen when it begins again'
NO_WRITE = 'reading the queue over REST, MCP and the CLI marks nothing seen, decides nothing and changes no Task'
GET_ONLY = 'only a GET reaches the route: every write method is refused and writes nothing'
OWN_MARK = "the Connector's own seen mark is its own: it never writes the person's"
BLIND = 'a credential without tasks:read is refused at the route ceiling, over REST and over MCP'
MCP_PLANE = 'the tool is read only, on the introspection plane: it answers before the credential has bootstrapped'
MCP_DETAIL = "the tool's detailed items equal the service's, and its kind filter narrows"
MCP_CONCISE = ("the tool's concise lines hold ids, readable titles and the concealed marker only, and refuse any "
               'argument that could write')
CLI_JSON = "the CLI prints the service's envelope under --json, and --kind narrows"
CLI_TABLE = 'the CLI table holds readable titles and the concealed marker only, and no verb decides, marks or changes'

# (name, [(file, anchor, replacement), ...], the exact set of tests that must fail).
CONTROLS = [
    ("the owning-Account resolution is widened to a service Account (an administrator's Decisions reach its Connector)",
     [(ROUTE, "  if (top.kind !== 'human' || top.parentPrincipalId) return null;", '  if (top.parentPrincipalId) return null;'),
      (ROUTE, "account.status !== 'active' || account.kind !== 'human' || account.parentPrincipalId", "account.status !== 'active' || account.parentPrincipalId")],
     {SERVICE}),
    ("the read check takes the PERSON's reach, not the caller's",
     [(ACTIONS, 'await this.readableIds(caller.taskScope, wanted.task)', 'await this.readableIds(account.taskScope, wanted.task)')],
     {TASKS, DECISION, WIDEN, MCP_CONCISE, CLI_TABLE}),
    ('an item the caller cannot read keeps its title',
     [(ACTIONS, '            object: { type: item.object.type, id: item.object.id, title: null },',
       '            object: { type: item.object.type, id: item.object.id, title: item.object.title },')],
     {TASKS, DECISION, SKILL, WIDEN}),
    ("a Skill review is shown without the caller's Skill read",
     [(ACTIONS, 'Boolean(target?.skill && readableSkills.has(target.skill))', 'Boolean(target?.skill && (readableSkills.has(target.skill) || true))')],
     {SKILL, WIDEN}),
    ("a Decision's and a Skill review's detail (the requester) is kept",
     [(ACTIONS, "detail: item.kind === 'verify' || item.kind === 'stuck' || (item.kind === 'decision' && approvalOpen) ? item.detail : {},", 'detail: item.detail,')],
     {DECISION, SKILL, WIDEN}),
    ("a Decision's detail is kept for a caller whose approval point read is refused",
     [(ACTIONS, "|| (item.kind === 'decision' && approvalOpen) ? item.detail : {},", "|| item.kind === 'decision' ? item.detail : {},")],
     {DECISION, WIDEN}),
    ("a Decision's approval kind (reasons) is kept for a caller whose approval point read is refused",
     [(ACTIONS, 'reasons: approvalOpen ? item.reasons : [],', 'reasons: item.reasons,')],
     {DECISION_KIND, WIDEN, SAME}),
    ("a Project name is shown without the caller's Project read",
     [(ACTIONS, 'project: item.project && projectNames.has(item.project.id) ? { id: item.project.id, name: projectNames.get(item.project.id)! } : null,', 'project: item.project && (projectNames.has(item.project.id) || true) ? { id: item.project.id, name: item.project.name } : null,')],
     {PROJECT}),
    ("a copied predicate drifts: the Account's Stuck items are dropped from the queue",
     [(ACTIONS, '      for (const item of theirs.answer.items) {', "      for (const item of theirs.answer.items.filter((candidate) => candidate.kind !== 'stuck')) {")],
     {TASKS, AGENT, LISTS, OWN_MARK, SAME}),
    ("the merged cap is not the Action Center's",
     [(ACTIONS, '      items.push(...ofKind.slice(0, ACTIONS_KIND_CAP));', '      items.push(...ofKind.slice(0, 100));')],
     {CAPS}),
    ("the caller's seen mark replaces the person's on an item on both lists",
     [(ACTIONS, "        held.waitingOn = 'both';", "        held.waitingOn = 'both';\n        held.seen = item.seen;")],
     {LISTS, SAME}),
    ('the owner path writes a seen mark',
     [(ACTIONS, "    return { scope: account ? 'owning-account' : 'own', items, counts, capped, asOf: now.toISOString() };",
       "    await this.markSeen(caller, { all: true });\n    return { scope: account ? 'owning-account' : 'own', items, counts, capped, asOf: now.toISOString() };")],
     {NO_WRITE, OWN_MARK}),
    ("the MCP tool's kind filter is dropped",
     [(REGISTRY, '.filter((item) => args.kind === undefined || item.kind === args.kind)', '.filter(() => true)')],
     {MCP_DETAIL, MCP_CONCISE}),
    ('the MCP concise line prints a title for an item the caller cannot read',
     [(REGISTRY, "item.readable === true ? `\"${String(object.title ?? '(untitled)')}\"`", "true ? `\"${String(object.title ?? '(untitled)')}\"`")],
     {MCP_CONCISE}),
    ("the CLI's kind filter is dropped",
     [(CLI, "if kind is None or item.get('kind') == kind]", ']')],
     {CLI_JSON}),
    ('the CLI table prints a title for an item the caller cannot read',
     [(CLI, "if item.get('readable') else '(not readable by you: kind and id only)'", 'if True else None')],
     {CLI_TABLE}),
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
    return name, f'{name}_oqdrill_template'


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
    copy = Path(tempfile.mkdtemp(prefix='action-items-owner-drill-'))
    receipts = []
    database, template = database_names()
    original = f'{database}_oqdrill_original'
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
