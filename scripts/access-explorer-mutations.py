#!/usr/bin/env python3
"""Mutation drill for AZ-A12 build 6 (card 1e56dbef; amendment AZ-A12 clause 12
and E45 (3)): the Access Explorer read model.

Each control below edits literal anchors in a DISPOSABLE COPY of the tree, runs
ONE suite - the live suite src/__tests__/accessExplorerLive.test.ts against a
REAL disposable PostgreSQL through the production router, or the fast census
suite src/__tests__/accessExplorerCensus.test.ts - and requires that suite to go
red at EXACTLY the predeclared set of tests, for an assertion (not a compile
error, a timeout or a crashed fixture). No two controls share a must-fail set,
so no two can be satisfied by one assertion (G.2 drill 11).

The controls withdraw, one at a time, what the build promises:
  - the verdict is the evaluator's: the actor an Account and a delegated
    identity present, the sources the same predicate names, and a Group
    principal never an actor (G.2 drill 8's parity, reused);
  - nomination: every grant holder, Group member and shape coordinate the
    evaluator admits is listed (the completeness half of the matrix);
  - concealment: an object the caller cannot read answers as an absent one;
  - the projections: another principal's authority only to root, its own and
    its login-session subtree; the board-wide read class; grant liveness;
  - the Group hop's tier through the clause-6 fragment;
  - SR-3: only through the Group, only to root and a live steward's session;
  - the r1 concealment class (review LEAK A and LEAK B): a principal the caller
    may not see the authority of is the GET /principals record under that
    list's filter; a bound Task only to its reader; warrant data only where the
    registry shows it; an Agent's verdict only where its authority may be seen;
    a disabled Group has no steward; an owned object only to its reader; and
    the Project owner only to a Project reader, the actor's liveness;
  - the census controls E-1 to E-4 of the fast suite.

The source tree is never edited: its bytes are fingerprinted before and after.

Every live run (the baseline and each live control) starts on the SAME fresh
database: a template is built once by loading the base schema and running
every migration into a new, empty database, and before each live run the named
database is dropped and recreated from it. The live suite generates its estate
and measures over every principal and grant on the board, so on a shared
database each run read every earlier run's estate as well as every earlier
step's rows: the runs grew slower one after another (in the full tier the
twenty-one live runs outgrew the job's time budget) and what a run measured
depended on what ran before it. The template is never a copy of the named
database; the named database is copied aside first and restored from that copy
at the end, so the job's later steps see it unchanged.

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \\
    python3 scripts/access-explorer-mutations.py --output-dir /tmp/access-explorer-drill
  python3 scripts/access-explorer-mutations.py --describe   # checks every anchor, no database
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
LIVE = 'src/__tests__/accessExplorerLive.test.ts'
CENSUS = 'src/__tests__/accessExplorerCensus.test.ts'
SERVICE = 'backend/src/services/AccessExplorerService.ts'
SCOPES = 'backend/src/utils/scopeMap.ts'

# Live tests, by title.
M_PARITY = "the read model's verdict equals the point decision for every principal, object and action"
M_GROUP = 'a Group principal is never an actor and never a holder'
M_LISTED = 'the HTTP object hop (root) lists every principal admitted beyond the board-wide classes, with exactly its verdict'
C_CONCEAL = 'an object the caller cannot read answers exactly as an absent one'
P_MEMBER = "a member reads ownership, the owning Group and its own verdict, never another principal's authority"
P_PATH_B = 'a Task on clause 7 path (b) names its explicit owner, and its Project owner only to a Project reader'
P_ROOT = 'root sees every grant holder and the grant rows naming the object, live and expired'
P_MEMBERS = "root lists a granted Group's members as holders through that Group"
G_TIERS = 'lists members with the tier the clause-6 fragment gives, their source and role, and flags inert role rows'
G_OBJECT = "with an object, root sees each member's verdict and a member only its own"
A_SUBTREE = ("an Account's Connectors are listed to anyone; their authority only to root, itself and its Account's "
             "session")
A_WARRANT = "root sees a Connector's warrants and its Agent minted under one, with their verdicts on an object"
S_THROUGH = 'root and a live steward on a login session see only what reaches the member through the Group'
S_EMPTY = 'a plain member, a bearer and a stranger get the empty answer'
# Review r1 (LEAK A, LEAK B) and the folded nice-to-haves.
M_LIVENESS = 'a dead delegated identity gets an unauthenticated actor, as the middleware refuses it'
P_PATH_B_HIDDEN = "a Task's Project owner is hidden from a Task reader who cannot read the Project"
A_DIRECTORY = ('a principal whose authority the caller may not see is shown exactly as GET /principals shows it: '
               'no bound Task, no Warrant')
A_HIDDEN = 'a hidden principal is filtered as GET /principals filters it, and answered as an absent one'
A_BOUND = "a login session's own subtree shows an Agent's bound Task only where the session reads that Task"
A_BEARER_WARRANT = 'a bearer reading itself sees no warrant registry data, which no bearer surface shows'
A_BEARER_CHILD = "a bearer reading itself sees no Agent's verdict: an Agent's authority is not its parent Connector's to see"
S_DISABLED = 'a live steward of a disabled Group gets the empty answer, and none of the objects that Group owns'
S_READABLE = "an owned object is listed to a non-root viewer only where that viewer's own point read admits it"

# Census tests, by title.
E1_KEYS = 'every key AuthorizationSqlResource declares is in exactly one list'
E2_BASES = 'the census finds the bases sqlCondition emits, and the two lists partition them'
E3_EVALUATOR = 'renders sqlCondition with its sources, and the Group tier through the shared fragment'
E4_CEILING = 'GET is principals:read and every other method is root'

# (name, suite, [(file, anchor, replacement), ...], the exact set of tests that must fail)
CONTROLS = [
    ('an Account is evaluated with no role scope', LIVE, [
        (SERVICE, '        principalId, handle: String(row.handle), role, scopes: scopesForRole(role),',
         "        principalId, handle: String(row.handle), role: 'viewer', scopes: scopesForRole('viewer'),")],
     {M_PARITY, M_LISTED, P_ROOT, S_THROUGH, G_OBJECT}),
    ('a delegated identity is evaluated without its chain', LIVE, [
        (SERVICE, '    if (!acting.parentPrincipalId || acting.legacyIdentity) {',
         "    if (acting.kind !== 'group' || !acting.parentPrincipalId || acting.legacyIdentity) {")],
     {M_PARITY, M_LISTED, A_WARRANT, M_LIVENESS}),
    ('a Group principal is given an actor', LIVE, [
        (SERVICE, "    if (!row || row.kind === 'group') return null;", '    if (!row) return null;')],
     {M_GROUP}),
    ('the verdict names no source', LIVE, [
        (SERVICE, '      sources: [...new Set(entry.sources.filter((source) => row[source.column] === true).map((source) => source.basis))],',
         '      sources: [],')],
     {P_MEMBER, P_PATH_B, S_THROUGH, P_ROOT, P_MEMBERS}),
    ('nomination drops the grant holders', LIVE, [
        (SERVICE, "      else nominate(grant.grantee_id, 'grant', grant.id);", '      else void grant;')],
     {M_LISTED, P_ROOT}),
    ('nomination drops the members of a granted or owning Group', LIVE, [
        (SERVICE, "      for (const accountId of accountIds) nominate(accountId, 'group-member', groupId);",
         '      void accountIds; void groupId;')],
     {M_LISTED, P_MEMBERS}),
    ('the object read gate is skipped', LIVE, [
        (SERVICE, "    if (!point.allowed) throw new AccessExplorerError(404, 'RESOURCE_NOT_FOUND', 'Resource not found');",
         '    void point;')],
     {C_CONCEAL}),
    ("another principal's authority is shown to a non-root reader", LIVE, [
        (SERVICE, '    if (!viewer.root) {\n      const self = viewer.actor.principalId;',
         '    if (viewer.root && !viewer.root) {\n      const self = viewer.actor.principalId;')],
     {P_MEMBER, P_PATH_B, P_PATH_B_HIDDEN}),
    ('an expired grant reads as live', LIVE, [
        (SERVICE, '              (g.expires_at IS NULL OR g.expires_at > NOW()) AS live,',
         '              TRUE AS live,')],
     {P_ROOT}),
    ("the Group hop's tier ignores the role row", LIVE, [
        (SERVICE, "      tierOf.set(String(row.account_id), row.edit_tier === true ? 'edit' : row.use_tier === true ? 'use' : 'none');",
         "      tierOf.set(String(row.account_id), row.use_tier === true ? 'use' : 'none');")],
     {G_TIERS}),
    ("a principal's authority is shown to every reader", LIVE, [
        (SERVICE, '    if (self === principalId) return true;\n    return viewer.loginSession && credentialLifecycleService.isDescendant(self, principalId);',
         '    void credentialLifecycleService;\n    return Boolean(principalId);')],
     {A_SUBTREE, A_DIRECTORY, A_HIDDEN, A_BEARER_CHILD}),
    ('SR-3 answers every caller', LIVE, [
        (SERVICE, '    if (!rootSession && !steward) return empty;', '    void steward;')],
     {S_EMPTY, S_DISABLED}),
    ("SR-3 counts the member's other sources", LIVE, [
        (SERVICE, '          .map((entry) => ({ action: entry.action, sources: entry.sources.filter((source) => through.has(source)) })),',
         '          .map((entry) => ({ action: entry.action, sources: entry.sources })),')],
     {S_THROUGH}),
    # Review r1 LEAK A: the principal hop's directory projection.
    ('LEAK A: the directory projection carries the raw principal record (bound Task, Warrant, metadata)', LIVE, [
        (SERVICE, '        children: children.slice(0, EXPLORER_LIST_LIMIT).map((child) => directoryRecord(child)),',
         '        children: children.slice(0, EXPLORER_LIST_LIMIT),')],
     {A_DIRECTORY}),
    ('LEAK A: the directory projection lists hidden principals without manage authority', LIVE, [
        (SERVICE, '      const includeHidden = viewer.manage === true;', '      const includeHidden = true;')],
     {A_HIDDEN}),
    ("the class: a Task is named to a viewer whose point read refuses it (bound Task, SR-3's owned rows)", LIVE, [
        (SERVICE, '      if (point.allowed) kept.push(row);', '      if (point.allowed || row) kept.push(row);')],
     {A_BOUND, S_READABLE}),
    ('the class: warrant registry data reaches a caller the registry refuses', LIVE, [
        (SERVICE, '    if (!viewer.loginSession || !self) return false;', '    if (!self) return false;')],
     {A_BEARER_WARRANT}),
    ("the class: a child's verdict is shown where its authority may not be seen", LIVE, [
        (SERVICE, '        if (!(await this.mayDisclose(viewer, child.principalId))) continue;', '')],
     {A_BEARER_CHILD}),
    # Review r1 LEAK B: SR-3's steward audience reads the owner-tier fragment.
    ('LEAK B: a steward of a disabled Group is answered as a live steward', LIVE, [
        (SERVICE, '      && await this.holdsEditTier(groupId, viewer.actor.principalId);',
         "      && (await groupStewardService.isLive(pool, groupId, viewer.actor.principalId, ['owner', 'manager'])"
         " || !this.holdsEditTier);")],
     {S_DISABLED}),
    # Folded nice-to-haves.
    ("P_PATH_B's negative: the Project owner is shown to a Task reader who cannot read the Project", LIVE, [
        (SERVICE, '      if (projectRead.allowed) {', '      if (projectRead.allowed || factsRow.project_id) {')],
     {P_PATH_B_HIDDEN}),
    ("actorFor's liveness: a dead delegated identity is evaluated as authenticated", LIVE, [
        (SERVICE, '      principalId, handle: String(row.handle), role, scopes: [], authenticated: alive,',
         '      principalId, handle: String(row.handle), role, scopes: [], authenticated: true || alive,')],
     {M_LIVENESS, M_PARITY, M_LISTED}),
    # The fast census suite (E-1 to E-4).
    ('E-1: a principal coordinate of the shape is left unclassified', CENSUS, [
        (SERVICE, "  'owner', 'accountOwner', 'creator', 'spawnedBy', 'claimant', 'shepherd', 'verifier', 'projectOwner',",
         "  'owner', 'accountOwner', 'creator', 'claimant', 'shepherd', 'verifier', 'projectOwner',")],
     {E1_KEYS}),
    ('E-2: an evaluator basis is neither nominated nor board-wide', CENSUS, [
        (SERVICE, "  'role-grant', 'assigned-connector-claim', 'delegation-chain', 'account-owner', 'account-group-owner',",
         "  'assigned-connector-claim', 'delegation-chain', 'account-owner', 'account-group-owner',")],
     {E2_BASES}),
    ('E-3: the verdict asks the evaluator without its sources', CENSUS, [
        (SERVICE, '      const decision = authorizationService.sqlCondition(actor, action, resource, params.length + 1, { includeSources: true });',
         '      const decision = authorizationService.sqlCondition(actor, action, resource, params.length + 1, { includeSources: false });')],
     {E3_EVALUATOR}),
    ('E-4: the family loses its principals:read GET ceiling', CENSUS, [
        (SCOPES, "  { pattern: /^\\/access-explorer(\\/|$)/, methods: ['GET'], scope: 'principals:read' },\n", '')],
     {E4_CEILING}),
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
    return name, f'{name}_aedrill_template', f'{name}_aedrill_original'


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
    name, template, _ = database_names()
    database_statements([f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)', f'CREATE DATABASE "{name}" TEMPLATE "{template}"'])


def run_suite(copy, out, label, suite):
    if suite == LIVE:
        fresh_database()
    report = out / f'{label}.json'
    command = ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--testPathIgnorePatterns=/node_modules/',
               '--runTestsByPath', suite, '--json', f'--outputFile={report}']
    with (out / f'{label}.log').open('w') as log:
        code = subprocess.run(command, cwd=copy / 'backend', stdout=log, stderr=subprocess.STDOUT, timeout=1500).returncode
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
        print(json.dumps([{'control': c[0], 'suite': c[1], 'files': sorted({e[0] for e in c[2]}), 'mustFail': sorted(c[3])}
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
    copy = Path(tempfile.mkdtemp(prefix='access-explorer-drill-'))
    receipts = []
    database, template, original = database_names()
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

        baseline_titles = {}
        for suite in (LIVE, CENSUS):
            code, tests, _ = run_suite(copy, out, f'baseline-{Path(suite).stem}', suite)
            titles = [t['title'] for t in tests]
            if code != 0 or not tests or any(t['status'] != 'passed' for t in tests):
                raise SystemExit(f'baseline is not green: {suite}')
            if len(set(titles)) != len(titles):
                raise SystemExit(f'two tests share a title in {suite}, so a declared title would not name one test')
            baseline_titles[suite] = titles
        for _, suite, _, must_fail in CONTROLS:
            if not set(must_fail) <= set(baseline_titles[suite]):
                raise SystemExit(f'a declared test is absent from {suite}: {sorted(set(must_fail) - set(baseline_titles[suite]))}')

        for index, (name, suite, edits, must_fail) in enumerate(CONTROLS, start=1):
            sources = apply(copy, edits)
            try:
                code, tests, suite_messages = run_suite(copy, out, f'control-{index}', suite)
            finally:
                for path, text in sources.items():
                    (copy / path).write_text(text)
            failed = {t['title'] for t in tests if t['status'] == 'failed'}
            messages = re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(
                m for t in tests if t['status'] == 'failed' for m in t.get('failureMessages', [])))
            semantic = code != 0 and [t['title'] for t in tests] == baseline_titles[suite] and failed == set(must_fail) \
                and all('expect(' in '\n'.join(t.get('failureMessages', [])) for t in tests if t['status'] == 'failed') \
                and not re.search(r'TS\d{4}|SyntaxError|Test suite failed to run|Exceeded timeout|ECONNREFUSED',
                                  messages + suite_messages)
            receipts.append({'control': name, 'suite': suite, 'files': sorted(sources), 'mustFail': sorted(must_fail),
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
    print(f'all {len(receipts)} controls red at their declared assertions; source unchanged')


if __name__ == '__main__':
    main()
