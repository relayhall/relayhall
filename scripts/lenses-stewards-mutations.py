#!/usr/bin/env python3
"""Mutation drill for LENSES-c slice c1-A, the Group roles relation (card
46cfbd1d; design delta LENSES-C steward tier, ratified by E98; controls LC-C1
to LC-C7 of the delta's test plan G.1, and the brief's mutation list).

Each control below edits ONE literal anchor in a disposable copy of the tree -
the TypeScript of a steward act, gate, read or register, or migration 152
itself - and runs three suites against a REAL disposable PostgreSQL through the
production router:

  backend/src/__tests__/groupStewardsLive.test.ts       (drills 1, 2, 3, 9, 10, O, U, M)
  backend/src/__tests__/groupStewardsRegisters.test.ts  (LC-C1, LC-C2, LC-C3, LC-C7)
  backend/src/__tests__/administratorSessionSeam.test.ts (LC-C5, the one classification)

The live suite's first test re-applies migration 152 FROM THE COPY, so a
migration mutation lands in the database before the tests that measure it; the
next control's run re-applies the original file and restores it (152 is
idempotent: the CHECK is dropped and re-added by name, the functions are
CREATE OR REPLACE, the triggers DROP IF EXISTS first). A closing baseline run
proves the restore.

A control is RED only when the suites fail at EXACTLY its declared set of
tests, each for an assertion (never a compile error, a timeout or a crashed
fixture). Every control declares a different set, so no two controls can be
satisfied by one assertion, and a mutation that reddens nothing fails the
drill. The source tree is never edited: its bytes are fingerprinted before and
after.

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \\
    python3 scripts/lenses-stewards-mutations.py --output-dir /tmp/lenses-stewards-drill [--only ID,ID]
  python3 scripts/lenses-stewards-mutations.py --describe   # checks every anchor, no database
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
SUITES = [
    'src/__tests__/groupStewardsLive.test.ts',
    'src/__tests__/groupStewardsRegisters.test.ts',
    'src/__tests__/administratorSessionSeam.test.ts',
]
MIGRATION = 'backend/src/migrations/152_lenses_c_group_stewards.sql'
FRAGMENT = 'backend/src/utils/liveStewardCondition.ts'
STEWARDS = 'backend/src/services/GroupStewardService.ts'
GROUPS = 'backend/src/services/GroupService.ts'
GROUP_ROUTES = 'backend/src/routes/groups.ts'
CATALOG_ROUTES = 'backend/src/routes/directoryGroupReferences.ts'
CARRIAGE = 'backend/src/services/DirectoryCarriageService.ts'
SCOPES = 'backend/src/utils/scopeMap.ts'
TERMINATE = 'backend/src/services/CredentialLifecycleService.ts'

# ── the tests, by title (assertionResults[].title) ──
PIN_TRIGGERS = 'pinning: both triggers are present by name, BEFORE INSERT and BEFORE UPDATE'
CHECK = 'the role CHECK refuses any value but owner and manager; both are admitted'
KINDS = 'the holder trigger refuses group and agent kinds by its allowlist rule; human and service Accounts are admitted'
HOLDER = 'the holder trigger refuses parented, legacy and elevated-role holders, each by its rule'
UPDATE = 'every UPDATE of a steward row is refused'
HAS_STEWARDS = 'deleting a Group with a steward row answers GROUP_HAS_STEWARDS with a count and no ids; after the root removal it deletes'
HAS_ORDER = 'GROUP_HAS_STEWARDS answers after GROUP_OWNS_OBJECTS and before the grants delete'
BEARER = 'a legacy root bearer is refused REQUIRES_LOGIN_SESSION on appoint and remove, audited, nothing written'
PROMOTE = 'promotion: an operator session promotes a live owner to operator; inert elevated_role everywhere; demoted to editor, each returns'
TERM_BEARER = 'termination by a legacy root bearer leaves the row in place and inert, writes no steward removal, and GROUP_HAS_STEWARDS holds until root removes it'
TERM_SESSION = 'termination by a root login session: the same - the row stays, inert, and no steward removal is written'
O_ADMITTED = 'admitted: a live owner on a login session with a step-up removes a manager row; audited standing group-owner with stepUpTokenId; the token is spent'
O_INERT_TARGET = 'an inert manager row (the manager left the Group) is removable by the owner'
O_BEARER = 'a bearer credential holding root is refused GROUP_MANAGER_REMOVE_REQUIRES_SESSION, audited, and spends nothing'
O_CONNECTOR = "the owner's own Connector is refused GROUP_MANAGER_REMOVE_REQUIRES_SESSION"
O_NOT_OWNER = 'a manager caller, an owner of another Group and a root session holding no owner row are refused GROUP_MANAGER_REMOVE_REQUIRES_OWNER'
O_INERT_OWNER = 'an inert owner (left the Group) and an operator-promoted owner are refused GROUP_MANAGER_REMOVE_REQUIRES_OWNER'
O_OWNER_ROW = "an owner row is STEWARD_OWNER_ROW_ROOT_ONLY, the caller's own included; an absent row is STEWARD_NOT_FOUND"
O_TOKENS = 'a missing, replayed, other-Group or appointment-bound token is STEP_UP_REQUIRED'
O_TARGET_FIRST = ('a missing or invalid step-up is answered after the target: an owner row is '
                  'STEWARD_OWNER_ROW_ROOT_ONLY and an absent row STEWARD_NOT_FOUND, never STEP_UP_REQUIRED')
O_SURVIVES = 'no refusal spends the token: ONE token survives a body refusal, an owner-row refusal and an absent row, then removes'
O_UPPER = 'an uppercase Group id removes with a token minted for the lowercase id; a non-UUID id is 400 before anything'
# Added by card 72b8fb97 (step-up challenge methods); it drives the same managers
# route, so R1 (the route rule moved) reddens it too and declares it.
O_CHALLENGE = 'card 72b8fb97: the challenge names the methods of the OWNER acting, here a password credential'
# Card b5c83682 (LENSES-c c1-B) made POST /groups/:id/managers gate (iii)'s route.
NO_APPOINT = ('no owner appoints an owner: POST /groups/:id/stewards stops an owner session at the root ceiling, '
              'and POST /groups/:id/managers writes nothing without its gate')
STEWARD_BEARER_CATALOG = 'a bearer credential held by a live steward Account ITSELF gets [] from the catalog'
STEWARD_BEARER_SR2 = 'a bearer credential held by a live steward Account ITSELF gets [] from SR-2'
CARRIER_DISABLED = ('a disabled member carrier leaves the steward projection: what it alone carries is hidden, '
                    'and counts exclude it; re-enabled, it returns')
C1_LINES = 'every INSERT into and DELETE from group_stewards is registered, line by line'
C1_TERMINATION = 'termination is not a writer: neither terminate path names group_stewards (D-9)'
C2_LINES = 'every non-comment line naming group_stewards is classified, and no entry outlives its line'
C2_FRAGMENT = 'the catalog and SR-2 reach steward rows only through the fragment'
C3_ORDER = 'the managers rule is listed BEFORE the /groups rules (first match wins)'
C3_CEILING_DELETE = 'route ceiling: DELETE /groups/0b7a5ff6-3c1d-4c21-9a4f-1f1f1f1f1f1f/managers/7c0e4a3e-1f2b-4c3d-8e9f-0a1b2c3d4e5f resolves to authenticated'
C3_ROOT_ACTS = 'the root acts test the login session, then root, before the service'
C3_OWNER_ORDER = 'the owner removal runs the standing, then the target refusals, then the step-up, in one transaction'
C7_FRAGMENT = 'the fragment builds its role condition from ELEVATED_ROLES, both directions'
C7_TRIGGER = "migration 152's holder trigger refuses exactly ELEVATED_ROLES, both directions"
C7_ALLOWLIST = "the trigger's kind test is a POSITIVE allowlist: human and service, nothing else"
SEAM_CENSUS = 'no source outside the seam compares authMethod to a credential-kind literal'
C5_GROUPS = 'routes/groups.ts imports and calls the seam'

# X1 swaps two blocks of GroupStewardService.removeRow, so it names them once
# each here instead of spelling both out twice (anchor and replacement). Card
# 72b8fb97 rewrote the step-up's catch arm (aefb4d91) and the duplicated text
# stopped matching; one named block per side cannot drift apart again.
X1_TARGET = (
    "    // A WRITER read (LC-C2): the target row, locked for the delete.\n"
    "    const target = await client.query(\n"
    "      'SELECT role, appointed_by_principal_id FROM group_stewards WHERE group_id = $1 AND account_principal_id = $2 FOR UPDATE',\n"
    "      [groupId, accountPrincipalId],\n"
    "    );\n"
    "    if (target.rows.length === 0) {\n"
    "      throw err(404, 'STEWARD_NOT_FOUND', 'That Account holds no role in this group');\n"
    "    }\n"
    "    const role = target.rows[0].role as GroupStewardRole;\n"
    "    if (options.managerOnly && role === 'owner') {\n"
    "      throw err(403, 'STEWARD_OWNER_ROW_ROOT_ONLY',\n"
    "        'An owner row is removed only by a root login session (DELETE /groups/{id}/stewards/{principalId})');\n"
    "    }\n"
)
X1_STEP_UP = (
    "    let stepUpTokenId: string | undefined;\n"
    "    if (options.stepUp) {\n"
    "      try {\n"
    "        const evidence = await stepUpService.consume(client, {\n"
    "          token: options.stepUp.token,\n"
    "          principalId: options.stepUp.principalId,\n"
    "          action: GROUP_MANAGER_REMOVE_ACT,\n"
    "          targetId: groupId,\n"
    "        });\n"
    "        stepUpTokenId = evidence.tokenId;\n"
    "      } catch (e) {\n"
    "        // Card 72b8fb97 (found 15 Oct): keep the SU-14 challenge.\n"
    "        if (e instanceof StepUpError) throw GroupError.fromStepUp(e);\n"
    "        throw e;\n"
    "      }\n"
    "    }\n"
)

# (id, control, what it reintroduces, file, anchor, replacement, the exact set of tests that must fail, cleanup SQL or None)
CONTROLS = [
    # ── LC-C4 / drill 1: migration 152 ──
    ('T1', 'LC-C4', 'the holder trigger is dropped: any principal may hold a Group role', MIGRATION,
     'CREATE TRIGGER enforce_group_steward_holder\n  BEFORE INSERT ON group_stewards\n  FOR EACH ROW EXECUTE FUNCTION enforce_group_steward_holder();\n',
     '', {PIN_TRIGGERS, KINDS, HOLDER}, None),
    ('T2', 'LC-C4', 'the UPDATE trigger is dropped: a steward row can be edited in place', MIGRATION,
     'CREATE TRIGGER enforce_group_steward_no_update\n  BEFORE UPDATE ON group_stewards\n  FOR EACH ROW EXECUTE FUNCTION enforce_group_steward_no_update();\n',
     '', {PIN_TRIGGERS, UPDATE}, None),
    ('T3', 'LC-C7', 'the kind test admits by negation (v5\'s "not agent"), so a Group principal holds a role', MIGRATION,
     "  IF holder_kind NOT IN ('human', 'service') THEN\n",
     "  IF holder_kind = 'agent' THEN\n", {KINDS, C7_ALLOWLIST}, None),
    ('T4', 'LC-C7', "the trigger's elevated refusal drops operator", MIGRATION,
     "  IF holder_role IN ('admin', 'operator', 'orchestrator') THEN\n",
     "  IF holder_role IN ('admin', 'orchestrator') THEN\n", {HOLDER, C7_TRIGGER}, None),
    # ── LC-C7 / C.2: the fragment ──
    ('F1', 'LC-C7', "'operator' is dropped from the fragment: a holder promoted to operator keeps a live row", FRAGMENT,
     '  return [...ELEVATED_ROLES].sort().map(',
     "  return [...ELEVATED_ROLES].filter((role) => role !== 'operator').sort().map(",
     {PROMOTE, O_INERT_OWNER, C7_FRAGMENT}, None),
    # ── LC-C2: a raw authority read outside the fragment ──
    ('F2', 'LC-C2', 'the catalog projection asks group_stewards directly instead of the fragment (inert rows grant the projection)', CARRIAGE,
     "      `SELECT 1 FROM (${liveStewardRows({ group: null, account: '$1', roles: '$2::text[]' })}) live_role LIMIT 1`,",
     "      `SELECT 1 FROM (SELECT group_id FROM group_stewards WHERE account_principal_id = $1 AND role = ANY($2::text[])) live_role LIMIT 1`,",
     {C2_LINES, C2_FRAGMENT}, None),
    # ── LC-C1: a steward-row write wired into termination ──
    ('W1', 'LC-C1', 'termination removes the subtree\'s steward rows (a bearer-reachable Group-role removal, D-9)', TERMINATE,
     "      const homePointersCleared = await clearHomePointersForPrincipals(\n        client, ids, actor, 'principal.terminate');\n",
     "      await client.query('DELETE FROM group_stewards WHERE account_principal_id = ANY($1::uuid[])', [ids]);\n"
     "      const homePointersCleared = await clearHomePointersForPrincipals(\n        client, ids, actor, 'principal.terminate');\n",
     {C1_LINES, C1_TERMINATION, TERM_BEARER, TERM_SESSION}, None),
    # ── LC-C3: the route register ──
    ('R1', 'LC-C3', 'the managers scope rule is moved after the /groups rules, so the root rule answers first', SCOPES,
     "  { pattern: /^\\/groups\\/[^/]+\\/managers\\/[^/]+$/, methods: ['DELETE'], scope: 'authenticated' },\n"
     "  { pattern: /^\\/groups\\/directory-sync$/, scope: 'root' },\n"
     "  { pattern: /^\\/groups(\\/|$)/, methods: ['GET'], scope: 'principals:read' },\n"
     "  { pattern: /^\\/groups(\\/|$)/, scope: 'root' },\n",
     "  { pattern: /^\\/groups\\/directory-sync$/, scope: 'root' },\n"
     "  { pattern: /^\\/groups(\\/|$)/, methods: ['GET'], scope: 'principals:read' },\n"
     "  { pattern: /^\\/groups(\\/|$)/, scope: 'root' },\n"
     "  { pattern: /^\\/groups\\/[^/]+\\/managers\\/[^/]+$/, methods: ['DELETE'], scope: 'authenticated' },\n",
     {C3_ORDER, C3_CEILING_DELETE, O_ADMITTED, O_INERT_TARGET, O_CONNECTOR, O_NOT_OWNER, O_INERT_OWNER, O_OWNER_ROW,
      O_TOKENS, O_SURVIVES, O_UPPER, O_TARGET_FIRST, PROMOTE, O_CHALLENGE}, None),
    ('R2', 'LC-C3', 'the in-handler login-session test is skipped: a bearer holding root appoints and removes', GROUP_ROUTES,
     '  const session = classifyLoginSession(req.authMethod, act);\n  if (!session.ok) return session;\n',
     '  const session = classifyLoginSession(req.authMethod, act);\n  if (!session.ok && act.length < 0) return session;\n',
     {BEARER, TERM_BEARER}, None),
    # Card b5c83682 (c1-B): gate (iii)'s appointment calls the same standing, so
    # the anchor also names the removal's own first code line.
    ('R3', 'LC-C3', 'the step-up is consumed before the standing (step 3), outside the act\'s transaction', STEWARDS,
     '      const ownerId = await this.requireGroupOwnerStanding(client, id, caller, {\n        requiresSession: GROUP_MANAGER_REMOVE_REQUIRES_SESSION,\n',
     '      await stepUpService.consume(pool, { token: stepUpToken, principalId: String(caller.principalId), action: GROUP_MANAGER_REMOVE_ACT, targetId: id }).catch(() => undefined);\n'
     '      const ownerId = await this.requireGroupOwnerStanding(client, id, caller, {\n        requiresSession: GROUP_MANAGER_REMOVE_REQUIRES_SESSION,\n',
     # Not the Connector case: the Connector presents its owner's token, and an
     # early consume bound to the CALLER (the Connector) finds nothing to burn.
     {C3_OWNER_ORDER, O_ADMITTED, O_INERT_TARGET, O_BEARER, O_NOT_OWNER, O_INERT_OWNER, O_OWNER_ROW, O_TOKENS,
      O_SURVIVES, O_UPPER, PROMOTE}, None),
    ('R4', 'LC-C3', 'the owner-row refusal is removed: an owner removes an owner row, their own included', STEWARDS,
     "    if (options.managerOnly && role === 'owner') {\n",
     "    if (options.managerOnly && role === 'owner' && groupId.length < 0) {\n",
     {O_OWNER_ROW, O_SURVIVES, O_TARGET_FIRST}, None),
    # Review r1 R2 (its mutation X1): the step-up is consumed INSIDE the
    # transaction but before the target row (step 4). A valid token is rolled
    # back by the later refusal, so only a missing or invalid one shows it.
    ('X1', 'LC-C3', 'the step-up is consumed before the target refusals (step 5 before step 4), inside the transaction', STEWARDS,
     X1_TARGET + X1_STEP_UP, X1_STEP_UP + X1_TARGET,
     {O_TARGET_FIRST, C3_OWNER_ORDER}, None),
    # ── C.9: the bearer branch of the catalog and of SR-2 ──
    ('K1', 'C.9', "the catalog's steward row is opened to a bearer", CATALOG_ROUTES,
     '    stewardSessionPrincipalId: session ? req.principal?.id ?? null : null,\n',
     '    stewardSessionPrincipalId: req.principal?.id ?? null,\n',
     {STEWARD_BEARER_CATALOG}, None),
    ('K2', 'C.9', "SR-2's steward row is opened to a bearer", GROUP_ROUTES,
     '      sessionPrincipalId: session ? req.principal?.id ?? null : null,\n',
     '      sessionPrincipalId: req.principal?.id ?? null,\n',
     {STEWARD_BEARER_SR2}, None),
    # Review r1 R1 (its mutation X5): the projection's ACTIVE-carrier test is
    # load-bearing; without it a disabled member still carries references into
    # a steward's catalog and counts.
    ('X5', 'C.9', "the catalog's steward projection drops the active-carrier test: a disabled member still carries", CARRIAGE,
     "      JOIN principals carrier ON carrier.id = member.account_principal_id AND carrier.status = 'active'\n",
     "      JOIN principals carrier ON carrier.id = member.account_principal_id\n",
     {CARRIER_DISABLED}, None),
    # ── C.3: GROUP_HAS_STEWARDS ──
    ('G1', 'C.3', 'GROUP_HAS_STEWARDS is removed: deleting a Group with steward rows hits the RESTRICT key as a 500', GROUPS,
     '      if (stewardRows > 0) {\n', '      if (stewardRows < 0) {\n',
     {HAS_STEWARDS, HAS_ORDER, TERM_BEARER}, None),
    # ── LC-C5: one session classification ──
    ('S1', 'LC-C5', 'the root acts re-implement the session classification inline', GROUP_ROUTES,
     '  const session = classifyLoginSession(req.authMethod, act);\n  if (!session.ok) return session;\n',
     "  void classifyLoginSession;\n  if (req.authMethod !== 'session' && req.authMethod !== 'dashboard_jwt') {\n"
     "    return { status: 403, code: 'REQUIRES_LOGIN_SESSION', message: `${act} is a login-session act (AZ-18): bearer credentials never perform it.` };\n"
     "  }\n",
     {SEAM_CENSUS, C5_GROUPS, C3_ROOT_ACTS}, None),
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
    return url


def run_sql(copy, sql):
    script = ("const { Client } = require('pg');"
              "const c = new Client({ connectionString: process.env.RELAYHALL_TEST_DB_URL });"
              "c.connect().then(() => c.query(process.argv[1])).then(() => c.end()).catch((e) => { console.error(e.message); process.exit(1); });")
    subprocess.run(['node', '-e', script, sql], cwd=copy / 'backend', check=True, timeout=120)


def run_suites(copy, out, label):
    report = out / f'{label}.json'
    command = ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--testPathIgnorePatterns=/node_modules/',
               '--runTestsByPath', *SUITES, '--json', f'--outputFile={report}']
    with (out / f'{label}.log').open('w') as log:
        code = subprocess.run(command, cwd=copy / 'backend', stdout=log, stderr=subprocess.STDOUT, timeout=1800).returncode
    result = json.loads(report.read_text()) if report.exists() else {}
    tests = [a for f in result.get('testResults', []) for a in f.get('assertionResults', [])]
    suite_messages = ' '.join(str(f.get('message', '')) for f in result.get('testResults', []))
    return code, tests, re.sub(r'\x1b\[[0-9;]*m', '', suite_messages)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--describe', action='store_true')
    parser.add_argument('--only', help='comma-separated control ids to run (the full table is still checked)')
    args = parser.parse_args()

    for _, _, _, path, anchor, replacement, _, _ in CONTROLS:
        once((ROOT / path).read_text(), anchor, replacement)
    ids = [c[0] for c in CONTROLS]
    sets = [frozenset(c[6]) for c in CONTROLS]
    if len(set(ids)) != len(ids):
        raise SystemExit('two controls share an id')
    if len(set(sets)) != len(sets) or any(not s for s in sets):
        raise SystemExit('every control must declare a non-empty must-fail set that no other control shares')
    for control in ('LC-C1', 'LC-C2', 'LC-C3', 'LC-C4', 'LC-C5', 'LC-C7'):
        if not any(c[1] == control for c in CONTROLS):
            raise SystemExit(f'control {control} has no red mutation')
    selected = CONTROLS
    if args.only:
        wanted = set(args.only.split(','))
        unknown = wanted - set(ids)
        if unknown:
            raise SystemExit(f'unknown control ids: {sorted(unknown)}')
        selected = [c for c in CONTROLS if c[0] in wanted]
    if args.describe:
        print(json.dumps([{'id': c[0], 'control': c[1], 'reintroduces': c[2], 'file': c[3], 'mustFail': sorted(c[6])}
                          for c in selected], indent=2))
        print(f'{len(selected)} controls, every anchor found exactly once, every must-fail set distinct')
        return

    require_disposable_database()
    if not args.output_dir:
        raise SystemExit('--output-dir is required')
    out = args.output_dir.resolve()
    if out == ROOT or ROOT in out.parents:
        raise SystemExit('--output-dir must lie outside the repository')
    out.mkdir(parents=True, exist_ok=False)

    before = fingerprints(ROOT)
    copy = Path(tempfile.mkdtemp(prefix='lenses-stewards-drill-'))
    receipts = []
    closure_green = False
    try:
        shutil.copytree(ROOT, copy, dirs_exist_ok=True, ignore=shutil.ignore_patterns(*IGNORED, '*.log'))
        (copy / 'backend/node_modules').symlink_to((ROOT / 'backend/node_modules').resolve(), target_is_directory=True)

        code, tests, _ = run_suites(copy, out, 'baseline')
        titles = [t['title'] for t in tests]
        if code != 0 or not tests or any(t['status'] != 'passed' for t in tests):
            raise SystemExit('baseline is not green')
        if len(set(titles)) != len(titles):
            raise SystemExit('two tests share a title, so a declared title would not name one test')
        for control in CONTROLS:
            if not set(control[6]) <= set(titles):
                raise SystemExit(f'{control[0]}: a declared test is absent from the suites: {sorted(set(control[6]) - set(titles))}')
        print(f'baseline green: {len(titles)} tests', flush=True)

        for control_id, control, reintroduces, path, anchor, replacement, must_fail, cleanup in selected:
            target = copy / path
            original = target.read_text()
            target.write_text(once(original, anchor, replacement))
            try:
                code, tests, suite_messages = run_suites(copy, out, f'control-{control_id}')
            finally:
                target.write_text(original)
                if cleanup:
                    run_sql(copy, cleanup)
            failed = {t['title'] for t in tests if t['status'] == 'failed'}
            messages = re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(
                m for t in tests if t['status'] == 'failed' for m in t.get('failureMessages', [])))
            semantic = code != 0 and sorted(t['title'] for t in tests) == sorted(titles) and failed == set(must_fail) \
                and all('expect(' in '\n'.join(t.get('failureMessages', [])) for t in tests if t['status'] == 'failed') \
                and not re.search(r'TS\d{4}|SyntaxError|Test suite failed to run|Exceeded timeout|ECONNREFUSED',
                                  messages + suite_messages)
            receipts.append({'control': control_id, 'controlName': control, 'reintroduces': reintroduces, 'file': path,
                             'mustFail': sorted(must_fail), 'failed': sorted(failed), 'red': semantic})
            (out / 'receipts.json').write_text(json.dumps(receipts, indent=2))
            print(f"{'RED ' if semantic else 'MISS'} {control_id} [{control}] {reintroduces} -> {len(failed)} failed", flush=True)
            if not semantic:
                print(f'   expected {sorted(must_fail)}\n   failed   {sorted(failed)}', flush=True)

        # The closing run re-applies the ORIGINAL migration and proves the restore.
        code, tests, _ = run_suites(copy, out, 'closure')
        closure_green = code == 0 and all(t['status'] == 'passed' for t in tests) and sorted(t['title'] for t in tests) == sorted(titles)
        print(f"closure baseline {'green' if closure_green else 'NOT GREEN'}", flush=True)
    finally:
        shutil.rmtree(copy, ignore_errors=True)
        after = fingerprints(ROOT)
        (out / 'source-closure.json').write_text(json.dumps({
            'sourceUnchanged': before == after, 'copyRemoved': not copy.exists(), 'controls': len(receipts),
        }, indent=2))
    if before != fingerprints(ROOT):
        raise SystemExit('the source tree changed during the drill')
    misses = [r['control'] for r in receipts if not r['red']]
    if misses or not closure_green:
        raise SystemExit(f'controls that did not fail at their declared assertions: {misses}; closure green: {closure_green}')
    print(f'all {len(receipts)} controls red at their declared assertions; closure green; source unchanged')


if __name__ == '__main__':
    main()
