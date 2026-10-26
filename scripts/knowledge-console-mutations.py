#!/usr/bin/env python3
"""Mutation drill for the Knowledge search console (card 1fd5de08, line 1, owner
ruling E428).

Each control below edits ONE literal anchor in a disposable copy of the tree and
runs the console's suites, the live one against a REAL disposable PostgreSQL
through the production router and the MCP ingress:

  backend/src/__tests__/knowledgeConsoleLive.test.ts           (two Accounts, router + MCP + stub source)
  frontend/src/pages/KnowledgePage.console.test.tsx             (the console page, vitest)
  frontend/src/components/knowledge/KnowledgeReader.test.tsx    (the shared reader, vitest)

The first three controls remove a core arm the console relies on: the selector
limb of the source list, the selector limb of the search fan-out, and the
selector arm of the get route. Each must redden the live tests that show a
caller without access to a source seeing nothing from it. The next four break
the page or the reader: filter results on the client, drop a fact from the
explain view, drop a degraded source from the coverage lines, and render source
bytes as markup.

The rest hold the ONE failure map the reader and the console share
(knowledgeModel.ts classifyKnowledgeFailure), one control per class of code the
knowledge routes answer with. Two keep the access concealment: an access
refusal shown as a generic failure, and an access refusal that names its cause.
Six send a class to the wrong state: a transient code, an unreadable source
answer, a link that is no longer valid, content that changed, the caller's own
search input, and an unknown code each shown as the access sentence. One drops
the read receipt's UUID form of the audit reference, and one drops a v1
answer's compartment from the reader.

Each run gets one of three verdicts:
  RED           every test ran, and exactly the declared tests failed, each at
                an assertion.
  MISS          every test ran to an assertion, and the failed set is not the
                declared set (none failed, or others did).
  INCONCLUSIVE  the suites did not reach the declared assertions (a timeout, a
                compile error, a suite that did not load, an unreachable
                database, a test that failed by a thrown error). No verdict on
                the control; the drill still fails (exit status 3).
A jest failure is at an assertion when its message carries `expect(`; a vitest
failure when every message is an assertion's own (`expected ...`, or a jest-dom
matcher's `expect(element)...`) or a Testing Library query that found nothing
(`Unable to find ...`), because the vitest JSON report carries the message
without the error's name. Every control declares a
different set, so no two can be satisfied by one assertion. The source tree is
never edited: its bytes are fingerprinted before and after.

Every run (the baseline and each control) starts on the SAME fresh database:
a template is built once by loading the base schema and running every
migration into a new, empty database, and before each run the named database
is dropped and recreated from it. With the selector limb withdrawn the
fan-out selects every visible knowledge source, so on the full tier's job
database, which holds every source the earlier steps registered (the default
search scope drill among them), the search was refused as too broad and tests
outside the control's declared set went red for that reason, not for the
mutation. The template is never a copy of the named database; the named
database is copied aside first and restored from that copy at the end, so the
job's later steps see it unchanged.

The backend and frontend dependencies must both be installed (`npm ci` in
backend/ and frontend/); the copy links both node_modules directories.

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \\
    python3 scripts/knowledge-console-mutations.py --output-dir /tmp/knowledge-console-drill
  python3 scripts/knowledge-console-mutations.py --describe   # checks every anchor, no database
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
SUITES = ['src/__tests__/knowledgeConsoleLive.test.ts']
FRONTEND_SUITES = ['src/pages/KnowledgePage.console.test.tsx', 'src/components/knowledge/KnowledgeReader.test.tsx']
ROUTE = 'backend/src/routes/knowledge.ts'
EXECUTOR = 'backend/src/services/KnowledgeFanoutExecutor.ts'
ARMS = 'backend/src/services/KnowledgeArmEvaluator.ts'
PAGE = 'frontend/src/pages/KnowledgePage.tsx'
MODEL = 'frontend/src/components/knowledge/knowledgeModel.ts'
READER = 'frontend/src/components/knowledge/KnowledgeReader.tsx'

L_LIST = ('(1) the queryable set the console lists each Account lists only the sources its selector covers, and the '
          'other source is absent from the bytes')
L_HOLDER = '(2) a caller without access to a source sees no results from it the holder gets results from both sources through the console body'
L_OUTSIDER = ('(2) a caller without access to a source sees no results from it the outsider gets SHARED only: PRIVATE '
              'is never consulted, never dialed, and named nowhere in the answer')
L_READ = ("(4) the reader opens a result only for a caller who may read it the holder's PRIVATE handle, presented by "
          'the outsider, is refused like a forged handle and never dialed; the holder opens it')
L_WITHDRAWN = ('(5) access withdrawn takes effect on the next search and the next read once the holder loses PRIVATE, '
               'the next search has no PRIVATE result and an earlier handle is refused')
P_ROWS = ('results: every row the core returned, with its source and score, in the core order both rows render in '
          'order, each naming its source and score; nothing is dropped or reordered on the client')
P_NONE = ('the explain view says so when none of the words are in the snippet, and names a section of a larger item')
P_EXPLAIN = 'the explain view is built from the fields the answer carries and makes no further request'
P_PARTIAL = ('honest states a source that answered nothing complete is named with what happened, and the verdict says '
             'partial')
R_SAME = ('refusals and failures an access refusal reads as the ONE access sentence that names no cause, with its '
          'audit reference, no content and no Retry')
R_TRANSIENT = ('refusals and failures a source that is unavailable for now says so and offers Retry, never the access '
               'sentence')
R_INVALID = ('refusals and failures a source answer that could not be read says so and offers Retry, never the access '
             'sentence')
R_STALE = ('refusals and failures a link that is no longer valid sends the reader back to search, never the access '
           'sentence')
R_UNKNOWN = 'refusals and failures an unknown refusal is a generic failure with Retry, never the access sentence'
R_V1 = 'reading a legacy (v1) answer shows its compartment'
P_REFUSED = 'honest states a refused search shows the core message and its audit reference, and no results'
P_AUDIT = 'honest states a refused search keeps its audit reference in either form the core mints'
P_TRANSIENT = 'honest states a search the service cannot answer now says so and offers Retry, which searches again'
P_ACCESS = 'honest states a search refused for access shows the one access sentence and no Retry'
P_UNKNOWN = 'honest states an unknown search failure is a generic failure with Retry, never the access sentence'
P_LIST_RETRY = 'honest states a source list that fails to load offers Retry, which reads the list again'
R_CHANGED = 'refusals and failures content that changed between windows has its own words'
R_READS = ('reading reads the sealed handle through GET /knowledge-contents only, and shows the bytes as quoted plain '
           'text')
R_RETRY = 'refusals and failures an unreachable service offers Retry, which reads again'
R_PANEL = ('the panel closes on its button, on Escape and on the scrim, never on a click inside; Expand is a toggle '
           'that keeps its name')

# (name, file, anchor, replacement, the exact set of tests that must fail)
CONTROLS = [
    # The source list without limb (c): every visible source is listed.
    ('list every visible source', ROUTE,
     '    res.json({ success: true, sources: visible.filter((source) => covered.has(source.id)) });',
     '    res.json({ success: true, sources: visible.filter((source) => covered.has(source.id) || source.id.length > 0) });',
     {L_LIST}),
    # The fan-out without limb (c) at selection: every visible knowledge
    # source is selected. An asserted source is still stopped by its own arm
    # evaluation before the dial, so PRIVATE stays dark; the board's in-process
    # source, which no selector in this suite covers, is consulted for both
    # Accounts, and the three tests that pin the consulted set go red.
    ('drop the selector limb from the search fan-out', EXECUTOR,
     '    if (!visible.has(source.row.id) || !covered.has(source.row.id)) continue;\n'
     '    if (narrowing && !narrowing.has(source.row.id)) continue;\n\n'
     '    // ── LIMB (d)',
     '    if (!visible.has(source.row.id)) continue;\n'
     '    if (narrowing && !narrowing.has(source.row.id)) continue;\n\n'
     '    // ── LIMB (d)',
     {L_HOLDER, L_OUTSIDER, L_WITHDRAWN}),
    # The get route without the selector arm: a borrowed handle opens.
    ('drop the selector arm from the get route', ARMS,
     "    if (!covered.has(row.id)) return null;\n",
     "    if (!covered.has(row.id) && row.id.length < 0) return null;\n",
     {L_READ, L_WITHDRAWN}),
    # The page filters results on the client.
    ('filter results on the client', PAGE,
     '{g.results.map((h,i)=>{',
     '{g.results.filter(h=>(h.score??0)>=0.5).map((h,i)=>{',
     {P_ROWS, P_NONE}),
    # The explain view drops the score row.
    ('drop the score from the explain view', MODEL,
     "  rows.push({\n    term: 'Score',",
     "  if (rows.length < 0) rows.push({\n    term: 'Score',",
     {P_EXPLAIN}),
    # The coverage lines forget an unavailable source.
    ('drop unavailable sources from the coverage lines', MODEL,
     "  for (const entry of coverage.unavailable) states.push(",
     "  for (const entry of coverage.unavailable.slice(coverage.unavailable.length)) states.push(",
     {P_PARTIAL}),
    # The reader renders source bytes as markup.
    ('render source bytes as markup', READER,
     "<pre className={`knowledge-reader-text${decoded.binary ? ' knowledge-reader-text--binary' : ''}`}>{decoded.text}</pre>",
     "<pre className={`knowledge-reader-text${decoded.binary ? ' knowledge-reader-text--binary' : ''}`} dangerouslySetInnerHTML={{ __html: decoded.text }} />",
     {R_READS, R_RETRY, R_PANEL}),
    # -- THE SHARED FAILURE MAP, one control per class --
    # An access refusal (the v2 collapsed `refused`) shown as a generic failure.
    ('show an access refusal as a failure', MODEL,
     "  'refused', 'not_authorized', 'source_refused', 'FORBIDDEN',",
     "  'not_authorized', 'source_refused', 'FORBIDDEN',",
     {R_SAME}),
    # An access refusal that names its cause.
    ('name the cause of an access refusal', MODEL,
     "    if (ACCESS_CODES.has(code)) return make('access', ACCESS_TEXT[surface], false);",
     "    if (ACCESS_CODES.has(code)) return make('access', `${ACCESS_TEXT[surface]} (${code})`, false);",
     {R_SAME, P_ACCESS}),
    # The round-1 defect: a source that is down told its access may have changed.
    ('show a transient code as the access sentence', MODEL,
     "    if (TRANSIENT_CODES.has(code)) return make('unavailable', UNAVAILABLE_TEXT[surface], true);",
     "    if (TRANSIENT_CODES.has(code)) return make('access', ACCESS_TEXT[surface], false);",
     {R_TRANSIENT, P_TRANSIENT}),
    ('show an unreadable source answer as the access sentence', MODEL,
     "    if (INVALID_ANSWER_CODES.has(code)) return make('invalidAnswer', INVALID_ANSWER_TEXT, true);",
     "    if (INVALID_ANSWER_CODES.has(code)) return make('access', ACCESS_TEXT[surface], false);",
     {R_INVALID}),
    ('show a link that is no longer valid as the access sentence', MODEL,
     "    if (STALE_LINK_CODES.has(code)) return make('staleLink', STALE_LINK_TEXT, false);",
     "    if (STALE_LINK_CODES.has(code)) return make('access', ACCESS_TEXT[surface], false);",
     {R_STALE}),
    ('show changed content as the access sentence', MODEL,
     "    if (code === 'content_changed') return make('changed', CHANGED_TEXT, false);",
     "    if (code === 'content_changed') return make('access', ACCESS_TEXT[surface], false);",
     {R_CHANGED}),
    ("show the caller's own search input as the access sentence", MODEL,
     "    if (REQUEST_CODES.has(code)) return make('request', requestText(record), false);",
     "    if (REQUEST_CODES.has(code)) return make('access', ACCESS_TEXT[surface], false);",
     {P_REFUSED, P_AUDIT}),
    ('show an unknown code as the access sentence', MODEL,
     "  return make('failed', FAILED_TEXT, true);\n}",
     "  return make('access', ACCESS_TEXT[surface], false);\n}",
     {R_UNKNOWN, P_UNKNOWN, P_LIST_RETRY}),
    # The audit reference of a read refusal is a UUID; a search's is ka_.
    ('drop the UUID form of the audit reference', MODEL,
     '|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;',
     ')$/i;',
     {R_SAME, P_AUDIT}),
    ("drop a v1 answer's compartment from the reader", READER,
     '  const compartment = provenance?.compartment ?? content?.compartment;',
     '  const compartment = provenance?.compartment;',
     {R_V1}),
]

IGNORED = ('.git', 'graphify-out', 'node_modules', 'dist', 'coverage', '__pycache__', '.pytest_cache')
NOT_MEASURED = (
    ('a hook or test outlived its budget', r'Exceeded timeout|Test timed out|Hook timed out'),
    ('a frontend module did not load', r'Failed to load url|Failed to resolve import|Transform failed'),
    ('the source did not compile', r'TS\d{4}'),
    ('a syntax error', r'SyntaxError'),
    ('the suite did not load', r'Test suite failed to run'),
    ('the database was unreachable', r'ECONNREFUSED'),
)
SUITE_RUN_TIMEOUT_SECONDS = 1200
INCONCLUSIVE_EXIT = 3


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
    return name, f'{name}_kcdrill_template', f'{name}_kcdrill_original'


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


def run_runner(name, command, cwd, report, log_path, env=None):
    timed_out = False
    with log_path.open('w') as log:
        try:
            code = subprocess.run(command, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, env=env,
                                  timeout=SUITE_RUN_TIMEOUT_SECONDS).returncode
        except subprocess.TimeoutExpired:
            code, timed_out = None, True
    result = json.loads(report.read_text()) if report.exists() else {}
    tests = [dict(a, runner=name, fullName=a['fullName'].strip())
             for f in result.get('testResults', []) for a in f.get('assertionResults', [])]
    suite_messages = ' '.join(str(f.get('message', '')) for f in result.get('testResults', []))
    return code, tests, suite_messages, timed_out


def run_suites(copy, out, label):
    backend = run_runner(
        'jest',
        ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--testPathIgnorePatterns=/node_modules/',
         '--runTestsByPath', *SUITES, '--json', f'--outputFile={out / f"{label}.json"}'],
        copy / 'backend', out / f'{label}.json', out / f'{label}.log')
    frontend = run_runner(
        'vitest',
        ['node', 'node_modules/vitest/vitest.mjs', 'run', '--pool=forks', '--maxWorkers=1', '--minWorkers=1',
         *FRONTEND_SUITES, '--reporter=json', f'--outputFile={out / f"{label}.frontend.json"}'],
        copy / 'frontend', out / f'{label}.frontend.json', out / f'{label}.frontend.log',
        env=dict(os.environ, NODE_ENV='test'))
    codes = [backend[0], frontend[0]]
    code = None if None in codes else max(codes)
    suite_messages = re.sub(r'\x1b\[[0-9;]*m', '', backend[2] + ' ' + frontend[2])
    return code, backend[1] + frontend[1], suite_messages, backend[3] or frontend[3]


def at_assertion(test):
    messages = [re.sub(r'\x1b\[[0-9;]*m', '', m) for m in test.get('failureMessages', [])]
    if test['runner'] == 'vitest':
        return bool(messages) and all(re.match(r'(TestingLibraryElementError: )?(expected |Unable to find |expect\()', m) for m in messages)
    return 'expect(' in '\n'.join(messages)


def verdict(code, tests, names, must_fail, suite_messages, timed_out):
    failing = [t for t in tests if t['status'] == 'failed']
    messages = re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(m for t in failing for m in t.get('failureMessages', [])))
    if timed_out:
        return 'INCONCLUSIVE', f'the runner exceeded {SUITE_RUN_TIMEOUT_SECONDS} s'
    if not tests:
        return 'INCONCLUSIVE', 'no structured assertions: the suites wrote no JSON'
    if {t['fullName'] for t in tests} != names:
        return 'INCONCLUSIVE', 'the suites did not run the tests the baseline ran'
    for reason, pattern in NOT_MEASURED:
        if re.search(pattern, messages + suite_messages):
            return 'INCONCLUSIVE', reason
    thrown = [t for t in failing if not at_assertion(t)]
    if thrown:
        return 'INCONCLUSIVE', f'{len(thrown)} test(s) failed by a thrown error, not an assertion: ' + \
            '; '.join(t['fullName'] for t in thrown)
    failed = {t['fullName'] for t in failing}
    if code != 0 and failed == must_fail:
        return 'RED', 'exactly the declared tests failed, each at an assertion'
    if not failed:
        return 'MISS', 'no test failed'
    return 'MISS', f'{len(failed & must_fail)} of {len(must_fail)} declared and {len(failed - must_fail)} undeclared tests failed'


def inconclusive(what, reason):
    print(f'INCONCLUSIVE {what}: {reason}. The suites never reached their declared assertions, so this run is '
          f'no verdict; re-run the drill.', flush=True)
    raise SystemExit(INCONCLUSIVE_EXIT)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--describe', action='store_true')
    args = parser.parse_args()

    for _, path, anchor, replacement, _ in CONTROLS:
        once((ROOT / path).read_text(encoding='utf-8'), anchor, replacement)
    sets = [frozenset(c[4]) for c in CONTROLS]
    if len(set(sets)) != len(sets):
        raise SystemExit('two controls declare the same set of tests')
    if args.describe:
        print(json.dumps([{'control': c[0], 'file': c[1], 'mustFail': sorted(c[4])} for c in CONTROLS], indent=2))
        return

    require_disposable_database()
    for side in ('backend', 'frontend'):
        if not (ROOT / side / 'node_modules').is_dir():
            raise SystemExit(f'{side}/node_modules is missing: run npm ci in {side}/ first')
    if not args.output_dir:
        raise SystemExit('--output-dir is required')
    out = args.output_dir.resolve()
    if out == ROOT or ROOT in out.parents:
        raise SystemExit('--output-dir must lie outside the repository')
    out.mkdir(parents=True, exist_ok=False)

    before = fingerprints(ROOT)
    copy = Path(tempfile.mkdtemp(prefix='knowledge-console-drill-'))
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
        (copy / 'frontend/node_modules').symlink_to((ROOT / 'frontend/node_modules').resolve(), target_is_directory=True)

        fresh_database()
        code, tests, suite_messages, timed_out = run_suites(copy, out, 'baseline')
        names = {t['fullName'] for t in tests}
        state, reason = verdict(code, tests, names, set(), suite_messages, timed_out)
        if state == 'INCONCLUSIVE':
            inconclusive('baseline', reason)
        if code != 0 or not tests or any(t['status'] != 'passed' for t in tests):
            raise SystemExit('baseline is not green')
        for _, _, _, _, must_fail in CONTROLS:
            if not must_fail <= names:
                raise SystemExit(f'a declared test is absent from the suites: {sorted(must_fail - names)}')

        for index, (name, path, anchor, replacement, must_fail) in enumerate(CONTROLS, start=1):
            target = copy / path
            source_text = target.read_text(encoding='utf-8')
            target.write_text(once(source_text, anchor, replacement), encoding='utf-8')
            try:
                fresh_database()
                code, tests, suite_messages, timed_out = run_suites(copy, out, f'control-{index}')
            finally:
                target.write_text(source_text, encoding='utf-8')
            failed = {t['fullName'] for t in tests if t['status'] == 'failed'}
            state, reason = verdict(code, tests, names, must_fail, suite_messages, timed_out)
            receipts.append({'control': name, 'file': path, 'mustFail': sorted(must_fail),
                             'failed': sorted(failed), 'red': state == 'RED', 'verdict': state, 'reason': reason})
            (out / 'receipts.json').write_text(json.dumps(receipts, indent=2))
            print(f"{'RED ' if state == 'RED' else state} {name} -> {len(failed)} failed ({reason})", flush=True)
            if state == 'INCONCLUSIVE':
                inconclusive(f'control {index} ({name})', reason)
            if state != 'RED':
                for title in sorted(failed ^ must_fail):
                    print(f"   {'undeclared' if title in failed else 'missing'}: {title}", flush=True)
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
