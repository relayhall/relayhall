#!/usr/bin/env python3
"""Mutation drill for RH-LENSES-d, the lens contract (card 4e159741; design
record v7.1 `96f0bd3d` obligations B-L9d, B-L10d, B-L18 and B-L21; ANNEX
`d6637a92` controls R-8-v1 and R-14 and acceptance rows A-L30, A-L52, A-L53).

The design record names NO red mutations: whether a mutation reddens a control
is a runtime property, so obligation B-L10d makes the build write them and
PROVE them. This is that proof. Each mutation edits literal anchors in a
disposable copy of the tree and runs the suites of its side.

--suite backend (the default) runs three, the live one against a REAL
disposable PostgreSQL through the production router:

  backend/src/__tests__/lensesContract.test.ts           (B-L9d, A-L30, A-L53, I-L2's importer register; no database)
  backend/src/__tests__/administratorSessionSeam.test.ts (R-14 / A-L52, the one classification)
  backend/src/__tests__/lensesContractLive.test.ts       (R-8-v1, A-L30, A-L53, B-L9d over real requests)

--suite frontend needs no database and runs the dashboard's lens controls:
the navigation is drawn from the SERVER's lens answer and never derived, a
lens is necessary and never sufficient, and the two admin pages offer their
acts to the admin lens only.

A mutation is RED only when the suites fail at EXACTLY its declared set of
tests, each for an assertion (never a compile error, a timeout or a crashed
fixture). Every mutation declares a different set, so no two can be satisfied
by one assertion, and a mutation that reddens nothing fails the drill. Every
control the card names carries at least one mutation, and R-8-v1's are
OBSERVABLE BY THE COMPARISON IT MAKES: each makes a route outside the lens
surface consult the lens, which then answers differently once the lens surface
is removed; the third is a load-time copy that removal cannot reach, which the
importer register catches. The source tree is never edited: its bytes are
fingerprinted before and after, and a closing baseline proves the copy was
restored.

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \\
    python3 scripts/lenses-d-mutations.py --output-dir /tmp/lenses-d-drill [--only ID,ID]
  python3 scripts/lenses-d-mutations.py --suite frontend --output-dir /tmp/lenses-d-frontend-drill
  python3 scripts/lenses-d-mutations.py [--suite frontend] --describe   # checks every anchor, no database
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
SUITES = {
    'backend': [
        'src/__tests__/lensesContract.test.ts',
        'src/__tests__/administratorSessionSeam.test.ts',
        'src/__tests__/lensesContractLive.test.ts',
    ],
    'frontend': [
        'src/config/navigation.lenses.test.ts',
        'src/components/Sidebar.lenses.test.tsx',
        'src/pages/DirectoryPage.test.tsx',
        'src/pages/GroupsPage.test.tsx',
    ],
}
LENSES = 'backend/src/utils/lenses.ts'
SCOPES = 'backend/src/utils/scopeMap.ts'
PRINCIPALS = 'backend/src/routes/principals.ts'
DASHBOARD = 'backend/src/routes/dashboard.ts'
ROLES = 'backend/src/utils/roleCatalogue.ts'
CATALOG = 'backend/src/routes/directoryGroupReferences.ts'

# ── the tests, by title (assertionResults[].title) ──
# lensesContract.test.ts
U_RESOLVES = 'GET /principals/me/lenses resolves to the authenticated ceiling, in every spelling the resolver admits'
U_ORDER = 'the rule sits ABOVE both /principals family rules'
U_SPACE = 'over every authentication kind and both root answers, admin iff root AND a login session'
U_BEARER = 'a bearer credential HOLDING root is refused the lens, so root alone is not the test'
U_JWT = 'the break-glass dashboard token receives it, so the session cookie alone is not the test either'
U_NO_ROOT = 'a login session without root is a member and nothing more'
U_MEMBER = 'a non-admin caller gets exactly { lenses: [member], admin: false } and NO manager key'
U_ADMIN = 'an admin caller gets exactly { lenses: [member, admin], admin: true } and NO manager key'
# Card b5c83682 (LENSES-c c1-B) renamed this row: it also covers an EMPTY row list now,
# and added U_KIND, whose admin session with no rows the M1 mutation also hands an arm.
U_NO_MANAGER = 'no caller of any kind is handed the manager lens without a live steward row, an EMPTY row list included'
U_KIND = ('the arm does not depend on the session kind or on root: a bearer holding rows gets it, an admin session '
          'holding none does not')
U_IMPORTERS = 'no module but the route that serves the lens imports the lens module'
# administratorSessionSeam.test.ts
S_CENSUS = 'no source outside the seam compares authMethod to a credential-kind literal'
S_LENS = 'utils/lenses.ts is a registered lens importer'
S_ROUTE = 'routes/principals.ts is a registered lens importer'
S_VALUES = 'the lens derivation admits no credential-kind value of its own'
# lensesContractLive.test.ts
L_BEARER = 'the bearer holding root gets admin: false'
L_SESSION = 'the same Account on a login session gets admin: true'
L_JWT = 'the same Account on the break-glass dashboard token gets admin: true'
L_RECOMPUTE = 'recomputed per request: the Account loses root and the next request has no admin arm; restored, it returns'
L_MEMBER = 'an ordinary member gets exactly { lenses: [member], admin: false }, with no manager key in the body at all'
L_NO_MANAGER = 'no caller in the matrix is handed a manager key'
L_BARE = 'an Account holding no scope at all reads its own lenses (below the /principals family it would be refused)'
L_CONNECTOR = 'a delegated Connector reads its own lenses and is a member and nothing more'
L_DASHBOARD = 'the dashboard family (summary, activity, active, the Reports count) answers identically'
L_FAMILIES = 'every route family the lens touches answers identically'

LENS_RULE = "  { pattern: /^\\/principals\\/me\\/lenses$/, methods: ['GET'], scope: 'authenticated' },\n"
FAMILY_REST = "  { pattern: /^\\/principals(\\/|$)/, scope: 'principals:admin' },\n"
ADMIN_LINE = '  const admin = input.rootAuthorized && isLoginSessionKind(input.authMethod);\n'
SEAM_IMPORT = "import { isLoginSessionKind } from './administratorSession';\n"

# (id, control, what it reintroduces, [(file, anchor, replacement), ...], the exact set of tests that must fail)
CONTROLS = [
    # ── B-L9d: the route's ceiling depends on the rule sitting above the family ──
    ('B1', 'B-L9d', 'the lens rule is placed BELOW the /principals family fallbacks, so GET silently becomes principals:read',
     [(SCOPES, LENS_RULE, ''), (SCOPES, FAMILY_REST, FAMILY_REST + LENS_RULE)],
     {U_RESOLVES, U_ORDER, L_BARE, L_NO_MANAGER}),
    # ── A-L30, both directions ──
    ('A1', 'A-L30', 'root alone decides the admin lens: a bearer holding root receives it',
     [(LENSES, ADMIN_LINE, '  void isLoginSessionKind;\n  const admin = input.rootAuthorized;\n')],
     # Card b5c83682: U_KIND hands a bearer holding root and rows the manager arm, so A1 reddens it too.
     {U_SPACE, U_BEARER, U_KIND, L_BEARER, S_LENS}),
    ('A2', 'A-L30', 'the session COOKIE alone decides it: the break-glass dashboard token is refused the admin lens',
     [(LENSES, SEAM_IMPORT, "import { isStoredLoginSessionKind } from './administratorSession';\n"),
      (LENSES, ADMIN_LINE, '  const admin = input.rootAuthorized && isStoredLoginSessionKind(input.authMethod);\n')],
     {U_SPACE, U_JWT, L_JWT, S_LENS}),
    # ── A-L53 / B-L21: no manager key in v1 ──
    ('M1', 'A-L53', 'the v1 payload ships the manager arm EMPTY, asserting a projection v1 does not compute',
     [(LENSES, '  return { lenses, admin };\n', '  return { lenses, admin, manager: { stewardedGroups: [] } };\n')],
     {U_NO_ROOT, U_MEMBER, U_ADMIN, U_NO_MANAGER, U_KIND, L_BEARER, L_SESSION, L_JWT, L_RECOMPUTE, L_MEMBER, L_NO_MANAGER,
      L_BARE, L_CONNECTOR}),
    # ── R-14 / A-L52: one classification, the lens an importer ──
    ('R1', 'R-14', 'the lens re-implements the classification inline, in the spelling the census reads',
     [(LENSES, ADMIN_LINE,
       "  void isLoginSessionKind;\n"
       "  const admin = input.rootAuthorized && (input.authMethod === 'session' || input.authMethod === 'dashboard_jwt');\n")],
     {S_CENSUS, S_LENS, S_VALUES}),
    ('R2', 'R-14', 'the lens re-implements it in a spelling the census cannot read: the register still sees it',
     [(LENSES, ADMIN_LINE,
       "  void isLoginSessionKind;\n"
       "  const admin = input.rootAuthorized && ['session', 'dashboard_jwt'].includes(input.authMethod ?? '');\n")],
     {S_LENS, S_VALUES}),
    ('R3', 'R-14', 'the route handler classifies before the derivation, a second site beside the lens',
     [(PRINCIPALS, '    res.json(lensesFor({ authMethod: req.authMethod, rootAuthorized, stewardedGroups }));\n',
       "    res.json(lensesFor({ authMethod: isLoginSessionKind(req.authMethod) ? 'session' : 'principal_api_key', rootAuthorized, stewardedGroups }));\n")],
     {S_ROUTE}),
    # ── R-8-v1: a lens becomes an input to a route outside the lens surface ──
    ('G1', 'R-8-v1', 'the dashboard\'s in-progress list skips its narrowing for whoever holds the member lens',
     [(DASHBOARD,
       '    const inProgressTasks = await filterAuthorizedResources(\n',
       "    const inProgressTasks = require('../utils/lenses').lensesFor({ authMethod: req.authMethod, rootAuthorized: false })"
       ".lenses.includes('member') ? queried : await filterAuthorizedResources(\n")],
     {U_IMPORTERS, L_DASHBOARD}),
    ('G2', 'R-8-v1', "the catalog's root projection is decided by the admin lens instead of the request",
     [(CATALOG,
       "    rootSession: session && Boolean(req.scopes?.includes('root')),\n",
       "    rootSession: Boolean(session) && require('../utils/lenses').lensesFor({ authMethod: req.authMethod, "
       "rootAuthorized: Boolean(req.scopes?.includes('root')) }).admin,\n")],
     {U_IMPORTERS, L_FAMILIES}),
    # The static half: a module that copies a lens function at LOAD time is
    # out of the live removal's reach, so the importer register catches it.
    ('G3', 'R-8-v1', 'a second module imports the lens module, holding a copy the live removal cannot reach',
     [(ROLES, "import { ROLE_ACT_ISSUER_ROLES } from './administratorSession';\n",
       "import { ROLE_ACT_ISSUER_ROLES } from './administratorSession';\n"
       "import { lensesFor as lensFacts } from './lenses';\nvoid lensFacts;\n")],
     {U_IMPORTERS}),
]

# ── the dashboard side ──
SIDEBAR = 'frontend/src/components/Sidebar.tsx'
NAVIGATION = 'frontend/src/config/navigation.ts'
LENS_TYPES = 'frontend/src/types/lenses.ts'
DIRECTORY_PAGE = 'frontend/src/pages/DirectoryPage.tsx'
GROUPS_PAGE = 'frontend/src/pages/GroupsPage.tsx'

# navigation.lenses.test.ts
N_MEMBER_ABSENT = 'a member is offered no Administration group at all - absent, not empty'
N_UNION = 'the union is shown: the admin lens ADDS sections and removes none'
N_CONCEAL = 'a Settings page the Access-surface arm conceals is not offered, even to the admin lens'
N_SETTINGS_ALONE = 'Settings visibility alone never offers an admin section to a member'
N_BOTH_FIELDS = 'admin holds only when the body says so in both fields'
# Card b5c83682 (the manager lens): F4 also offers the admin sections to a manager.
N_MANAGER_NO_ADMIN = 'the manager lens adds My team and nothing else, and never an Administration section'
# Sidebar.lenses.test.tsx
SB_ROOT_MEMBER = 'root scopes with a member answer draw a member: the server decides, not the scope set'
SB_FALLBACKS = [f'{label} draws the member sections and no Administration group' for label in (
    'a refused read', 'a board without the route', 'a network failure', 'an unreadable body')]
SB_ONE_FIELD = 'a body that claims admin in one field only draws the member sections and no Administration group'
SB_CONCEAL = 'a Settings page the Access-surface arm conceals is not offered, even with the admin lens'
# DirectoryPage.test.tsx / GroupsPage.test.tsx
D_NOT_OFFERED = 'without the admin lens the act is not offered; the rows the server answered are still shown as they are'
G_NOT_OFFERED = 'without the admin lens the switch is not offered; the state is read-only text'

FRONTEND_CONTROLS = [
    ('F1', 'derived-nothing', 'the sidebar derives the admin lens from the session\'s scopes instead of the server\'s answer',
     [(SIDEBAR, '  const { lenses } = useMyLenses();\n',
       '  const { lenses: served } = useMyLenses();\n'
       "  const lenses = Array.isArray(scopes) && scopes.includes('root')\n"
       "    ? { lenses: ['member', 'admin'] as Array<'member' | 'admin'>, admin: true } : served;\n")],
     {SB_ROOT_MEMBER, *SB_FALLBACKS, SB_ONE_FIELD}),
    ('F2', 'never-sufficient', 'the lens alone offers a Settings page the Access-surface arm conceals',
     [(NAVIGATION,
       '  if (item.settingsEntry) {\n'
       '    const entry = settingsNavEntries.find((candidate) => candidate.id === item.settingsEntry);\n'
       '    if (!entry || !settingsEntryVisible(entry, audience.settings)) return false;\n'
       '  }\n', '')],
     {N_CONCEAL, SB_CONCEAL}),
    ('F3', 'server-answer', "the body's admin field alone is believed, without the admin lens in the list",
     [(LENS_TYPES, "  const admin = record.admin === true && lenses.includes('admin');\n", '  const admin = record.admin === true;\n')],
     {N_BOTH_FIELDS, SB_ONE_FIELD}),
    ('F4', 'necessary', 'the lens test is dropped: a member is offered the admin sections',
     [(NAVIGATION, "  if ((item.lens ?? 'member') === 'admin' && !audience.lenses.admin) return false;\n", '')],
     {N_MEMBER_ABSENT, N_UNION, N_SETTINGS_ALONE, N_MANAGER_NO_ADMIN, SB_ROOT_MEMBER, *SB_FALLBACKS, SB_ONE_FIELD}),
    ('F5', 'catalog-act', 'Use this group is offered to every session, not only to the admin lens',
     [(DIRECTORY_PAGE, '                      : lenses.admin\n', '                      : true\n')],
     {D_NOT_OFFERED}),
    ('F6', 'featured-act', 'the featured switch is offered to every session, not only to the admin lens',
     [(GROUPS_PAGE, '                    {lenses.admin\n', '                    {true\n')],
     {G_NOT_OFFERED}),
]

REQUIRED_CONTROLS = {
    'backend': ('B-L9d', 'A-L30', 'A-L53', 'R-14', 'R-8-v1'),
    'frontend': ('derived-nothing', 'never-sufficient', 'server-answer', 'necessary', 'catalog-act', 'featured-act'),
}
IGNORED = ('.git', 'graphify-out', 'node_modules', 'dist', 'coverage', '__pycache__', '.pytest_cache')


def once(text, anchor, replacement):
    count = text.count(anchor)
    if count != 1:
        raise SystemExit(f'anchor matched {count} times, expected 1: {anchor[:100]!r}')
    return text.replace(anchor, replacement, 1)


def apply(texts, edits):
    """Apply a control's edits in order to {path: text}; every anchor must match exactly once when it is applied."""
    out = dict(texts)
    for path, anchor, replacement in edits:
        out[path] = once(out[path], anchor, replacement)
    return out


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


def run_suites(copy, out, label, suite):
    report = out / f'{label}.json'
    if suite == 'backend':
        command = ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--testPathIgnorePatterns=/node_modules/',
                   '--runTestsByPath', *SUITES[suite], '--json', f'--outputFile={report}']
    else:
        command = ['node', 'node_modules/vitest/vitest.mjs', 'run', '--pool=forks', '--maxWorkers=1', '--minWorkers=1',
                   *SUITES[suite], '--reporter=json', f'--outputFile={report}']
    env = {**os.environ, 'NODE_ENV': 'test'}
    with (out / f'{label}.log').open('w') as log:
        code = subprocess.run(command, cwd=copy / suite, stdout=log, stderr=subprocess.STDOUT, timeout=1800,
                              env=env).returncode
    result = json.loads(report.read_text()) if report.exists() else {}
    tests = [a for f in result.get('testResults', []) for a in f.get('assertionResults', [])]
    suite_messages = ' '.join(str(f.get('message', '')) for f in result.get('testResults', []))
    return code, tests, re.sub(r'\x1b\[[0-9;]*m', '', suite_messages)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--describe', action='store_true')
    parser.add_argument('--only', help='comma-separated control ids to run (the full table is still checked)')
    parser.add_argument('--suite', choices=sorted(SUITES), default='backend')
    args = parser.parse_args()
    suite = args.suite
    controls = CONTROLS if suite == 'backend' else FRONTEND_CONTROLS

    originals = {}
    for control in controls:
        for path, _, _ in control[3]:
            originals.setdefault(path, (ROOT / path).read_text())
        apply(originals, control[3])
    ids = [c[0] for c in controls]
    sets = [frozenset(c[4]) for c in controls]
    if len(set(ids)) != len(ids):
        raise SystemExit('two mutations share an id')
    if len(set(sets)) != len(sets) or any(not s for s in sets):
        raise SystemExit('every mutation must declare a non-empty must-fail set that no other mutation shares')
    for control in REQUIRED_CONTROLS[suite]:
        if not any(c[1] == control for c in controls):
            raise SystemExit(f'control {control} has no red mutation')
    selected = controls
    if args.only:
        wanted = set(args.only.split(','))
        unknown = wanted - set(ids)
        if unknown:
            raise SystemExit(f'unknown mutation ids: {sorted(unknown)}')
        selected = [c for c in controls if c[0] in wanted]
    if args.describe:
        print(json.dumps([{'id': c[0], 'control': c[1], 'reintroduces': c[2], 'files': sorted({e[0] for e in c[3]}),
                           'mustFail': sorted(c[4])} for c in selected], indent=2))
        print(f'{len(selected)} mutations, every anchor found exactly once, every must-fail set distinct, '
              f'every control ({", ".join(REQUIRED_CONTROLS[suite])}) covered')
        return

    if suite == 'backend':
        require_disposable_database()
    if not args.output_dir:
        raise SystemExit('--output-dir is required')
    out = args.output_dir.resolve()
    if out == ROOT or ROOT in out.parents:
        raise SystemExit('--output-dir must lie outside the repository')
    out.mkdir(parents=True, exist_ok=False)

    before = fingerprints(ROOT)
    copy = Path(tempfile.mkdtemp(prefix='lenses-d-drill-'))
    receipts = []
    closure_green = False
    try:
        shutil.copytree(ROOT, copy, dirs_exist_ok=True, ignore=shutil.ignore_patterns(*IGNORED, '*.log'))
        (copy / suite / 'node_modules').symlink_to((ROOT / suite / 'node_modules').resolve(), target_is_directory=True)

        code, tests, _ = run_suites(copy, out, 'baseline', suite)
        titles = [t['title'] for t in tests]
        if code != 0 or not tests or any(t['status'] != 'passed' for t in tests):
            raise SystemExit('baseline is not green')
        if len(set(titles)) != len(titles):
            raise SystemExit('two tests share a title, so a declared title would not name one test')
        for control in controls:
            if not set(control[4]) <= set(titles):
                raise SystemExit(f'{control[0]}: a declared test is absent from the suites: {sorted(set(control[4]) - set(titles))}')
        print(f'baseline green: {len(titles)} tests', flush=True)

        for control_id, control, reintroduces, edits, must_fail in selected:
            touched = sorted({path for path, _, _ in edits})
            saved = {path: (copy / path).read_text() for path in touched}
            mutated = apply(saved, edits)
            for path in touched:
                (copy / path).write_text(mutated[path])
            try:
                code, tests, suite_messages = run_suites(copy, out, f'control-{control_id}', suite)
            finally:
                for path in touched:
                    (copy / path).write_text(saved[path])
            failed = {t['title'] for t in tests if t['status'] == 'failed'}
            messages = re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(
                m for t in tests if t['status'] == 'failed' for m in t.get('failureMessages', [])))
            # An ASSERTION failed: jest names `expect(`; vitest names the matcher
            # (`expect(...)`), states the chai expectation (`expected ... to`),
            # or the Testing Library query that found nothing it required.
            asserted = re.compile(r'expect\(' if suite == 'backend'
                                  else r'expect\(|\bexpected .* to |AssertionError|Unable to find')
            semantic = code != 0 and sorted(t['title'] for t in tests) == sorted(titles) and failed == set(must_fail) \
                and all(asserted.search('\n'.join(t.get('failureMessages', []))) for t in tests if t['status'] == 'failed') \
                and not re.search(r'TS\d{4}|SyntaxError|Test suite failed to run|Exceeded timeout|ECONNREFUSED|Transform failed',
                                  messages + suite_messages)
            receipts.append({'mutation': control_id, 'control': control, 'reintroduces': reintroduces, 'files': touched,
                             'mustFail': sorted(must_fail), 'failed': sorted(failed), 'red': semantic})
            (out / 'receipts.json').write_text(json.dumps(receipts, indent=2))
            print(f"{'RED ' if semantic else 'MISS'} {control_id} [{control}] {reintroduces} -> {len(failed)} failed", flush=True)
            if not semantic:
                print(f'   expected {sorted(must_fail)}\n   failed   {sorted(failed)}', flush=True)

        code, tests, _ = run_suites(copy, out, 'closure', suite)
        closure_green = code == 0 and all(t['status'] == 'passed' for t in tests) and sorted(t['title'] for t in tests) == sorted(titles)
        print(f"closure baseline {'green' if closure_green else 'NOT GREEN'}", flush=True)
    finally:
        shutil.rmtree(copy, ignore_errors=True)
        after = fingerprints(ROOT)
        (out / 'source-closure.json').write_text(json.dumps({
            'sourceUnchanged': before == after, 'copyRemoved': not copy.exists(), 'mutations': len(receipts),
        }, indent=2))
    if before != fingerprints(ROOT):
        raise SystemExit('the source tree changed during the drill')
    misses = [r['mutation'] for r in receipts if not r['red']]
    if misses or not closure_green:
        raise SystemExit(f'mutations that did not fail at their declared assertions: {misses}; closure green: {closure_green}')
    print(f'all {len(receipts)} mutations red at their declared assertions; closure green; source unchanged')


if __name__ == '__main__':
    main()
