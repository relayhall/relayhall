#!/usr/bin/env python3
"""Mutation drill for owner rulings E407 item 2 (the grant writer), E413 (the
bulk revoke) and E418(b) (the single grant DELETE).

Each control below edits literal anchors in a disposable copy of the tree,
runs `backend/src/__tests__/grantsBulkRevokeLive.test.ts` against a REAL
disposable PostgreSQL through the production router and MCP ingress, and
requires the suite to go red at EXACTLY the predeclared set of tests, for an
assertion (not a compile error, a timeout or a crashed fixture). No two
controls share a must-fail set.

The controls withdraw, one at a time, what the rulings bind:
  - the writer's engine check (every creation grant written again), its
    delegation question (the inventory the warrant, assignment and mint
    ceilings read) and that question's administrator bypass;
  - each engine arm the writer's skip rests on, in the ENGINE itself (the
    administrator arm and the type-wide grant): the writer's decision follows
    each, which is what "decided by the same authorization predicate, not a
    copy" means;
  - the bulk revoke's live re-check, its read-back, its rollback, its
    session-only door, its single-use step-up and its 500-id cap;
  - the single DELETE's session-only door and its step-up.
The source tree is never edited: its bytes are fingerprinted before and after.

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \\
    python3 scripts/grants-bulk-revoke-mutations.py --output-dir /tmp/grants-bulk-revoke-drill
  python3 scripts/grants-bulk-revoke-mutations.py --describe   # checks every anchor, no database
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
SUITE = 'src/__tests__/grantsBulkRevokeLive.test.ts'
EFFECT = 'backend/src/services/GrantEffectService.ts'
BULK = 'backend/src/services/GrantBulkRevokeService.ts'
GRANT = 'backend/src/services/GrantService.ts'
AUTHZ = 'backend/src/services/AuthorizationService.ts'
ROUTE = 'backend/src/routes/grants.ts'

# The tests, by title (assertionResults[].title), as the suite declares them.
W_ADMIN = 'W admin: no grant is written for an administrator on a private Report of another Account'
W_TYPE_WIDE = 'W type-wide: no exact Task grant is written for a holder of the type-wide grant'
W_OWNER = 'W owner: the owning Account keeps its grant, its only source for the warrant ceiling it may set on the Task'
W_CONNECTOR = 'W Connector: a Connector keeps its grant, its only source for the assignment cap (R3) it is checked against'
W_OPERATOR = 'W operator: an operator keeps its grant, because no root session lets its warrants past the ceiling check'
W_ADDS = 'W adds access: the grant is written when it adds access, and the grantee then reads through the router'
W_DESCENDANT = 'W descendants: a read grant is written for a Task initiator, whose Connectors would gain it'
W_ROUTES = ("W through the routes: an administrator's creations write no creator or sponsor grant, its Connector's "
            'write only the Connector pair, and access is unchanged')
B_REFUSED = ('B refusals: a root Account bearer is refused SESSION_ONLY and audited; a root Connector, a non-root session '
             'and MCP are refused, and nothing is written')
B_DRY = 'B the dry run answers a verdict per id and writes nothing'
B_CAP = 'B more than 500 ids are refused by name; exactly 500 are admitted'
B_INPUT = 'B a duplicate or malformed id and an unknown field are refused by name'
B_NO_STEP_UP = 'B a real run without a step-up is refused STEP_UP_REQUIRED, audited, and removes nothing'
B_REUSED = 'B a real run with a spent step-up is refused and removes nothing'
B_OTHER_SET = 'B a step-up bound to another id set or another act is refused and removes nothing'
B_REAL = 'B the real run removes only the ids still redundant, each through the revoke path, with one summary row'
B_RECHECK = 'B a grant that became effective after the dry run is skipped by the live re-check'
B_JOINT = 'B the dry run takes the same read-back: an injected difference answers wouldRollBack and writes nothing'
B_HOOK = 'B an injected read-back difference rolls the whole batch back'
B_ASSIGNMENT = 'B assignment grants are refused and plugin grants are unevaluable, in the dry run and the real run'
D_BEARER = ('D a root Account bearer and a root Connector are refused by name and the bearer refusal is audited '
            'as denied')
D_STEP_UP = ('D a session without a step-up, or with one bound to another act or grant, is refused STEP_UP_REQUIRED '
             'and audited')
D_ALLOWED = 'D a step-up bound to (grant.revoke, id) revokes the grant once and the token is spent'
P_PARITY = 'P authorizedIdsByAction equals authorizedIds and selectorCoveredIds for every action and identity'

# (name, [(file, anchor, replacement), ...], the exact set of tests that must fail)
CONTROLS = [
    ('E407 item 2: the writer writes every creation grant again (no engine check)', [
        (GRANT, "    const result = await grantEffectService.writeUnlessHeld(tuple, client,\n"
                "      () => this.create(tuple, audit, client));\n"
                "    return result.written;\n",
         "    void grantEffectService;\n"
         "    return this.create(tuple, audit, client);\n"),
    ], {W_ADMIN, W_TYPE_WIDE, W_ROUTES}),
    ('E407 item 2: the delegation question is dropped (only the engine is asked)', [
        (EFFECT, "    if (questions.containment.bypassed) {",
         "    if (questions.containment.bypassed || questions.containment.rule.verbs.length > 0) {"),
    # The administrator's Connector keeps its pair for the same reason, so the route test follows it.
    ], {W_OWNER, W_CONNECTOR, W_OPERATOR, W_ROUTES}),
    ('E407 item 2: the delegation bypass no longer needs a role that derives root (an operator passes)', [
        (EFFECT, "      && ADMINISTRATOR_ROLES.has(role.toLowerCase()) && scopesForRole(role).includes('root');",
         "      && ADMINISTRATOR_ROLES.has(role.toLowerCase()) && (scopesForRole(role).includes('root') || role.length > 0);"),
    ], {W_OPERATOR}),
    ('engine arm: the administrator arm is withdrawn, and the writer writes for an administrator', [
        (AUTHZ, "      && !chain && ADMINISTRATOR_ROLES.has(String(actor.role || '').toLowerCase())) {",
         "      && !chain && ADMINISTRATOR_ROLES.has(String(actor.role || '').toLowerCase()) && actor.role === 'never') {"),
    # The bulk revoke asks the same engine: the administrator-held rows it
    # calls redundant become effective too.
    ], {W_ADMIN, B_DRY, B_REUSED, B_REAL, B_RECHECK}),
    ('engine arm: the type-wide grant is withdrawn, and the writer writes for its holder', [
        (GRANT, "            + `OR (g.resource_id IS NULL AND g.resource_type <> 'surface')) `) +",
         "            + `OR (g.resource_id IS NULL AND FALSE)) `) +"),
    # The bulk revoke's type-wide holder rows follow it.
    ], {W_TYPE_WIDE, B_REAL, B_RECHECK}),
    ('E413: the live re-check is dropped (the real run removes every row it cannot exclude by column)', [
        (BULK, "        const check = await grantEffectService.checkExisting(tuple, client);",
         "        const check = dryRun ? await grantEffectService.checkExisting(tuple, client) : {\n"
         "          verdict: 'redundant' as const, reason: 'not re-checked', questions: await grantEffectService.questionsFor(tuple, client),\n"
         "          before: await grantEffectService.answers(await grantEffectService.questionsFor(tuple, client), client),\n"
         "        };"),
    ], {B_REAL, B_RECHECK, B_ASSIGNMENT}),
    ('E413: the read-back is dropped', [
        (BULK, "        ? await this.readBack(redundant.map((item) => item.questions), baseline, client)",
         "        ? { checks: Object.keys(baseline).length * 0, differences: 0 }"),
    ], {B_DRY, B_REAL, B_JOINT, B_HOOK}),
    ('E413: a read-back difference no longer rolls the batch back', [
        (BULK, "      const keep = !dryRun && !differs;", "      const keep = !dryRun;"),
    ], {B_HOOK}),
    ('E413: the bulk route accepts a bearer', [
        (ROUTE, "  if (!(await requireEditSession(req, res, 'grant', {\n    action: 'grant.bulk_revoke',",
         "  if (String(req.authMethod) === 'never' && !(await requireEditSession(req, res, 'grant', {\n    action: 'grant.bulk_revoke',"),
    ], {B_REFUSED}),
    ('E413: a spent step-up is accepted again', [
        (BULK, "        stepUp = await stepUpService.consume(client, {",
         "        await client.query('UPDATE step_up_tokens SET consumed_at = NULL WHERE principal_id = $1 AND action = $2',\n"
         "          [input.principalId, BULK_REVOKE_STEP_UP_ACTION]);\n"
         "        stepUp = await stepUpService.consume(client, {"),
    ], {B_REUSED}),
    ('E413: the 500-id cap is raised', [
        (BULK, "export const BULK_REVOKE_MAX_IDS = 500;", "export const BULK_REVOKE_MAX_IDS = 501;"),
    ], {B_CAP}),
    ('E418(b): the single DELETE accepts a bearer', [
        (ROUTE, "  if (!(await requireEditSession(req, res, 'grant', {\n    action: 'grant.revoke',",
         "  if (String(req.authMethod) === 'never' && !(await requireEditSession(req, res, 'grant', {\n    action: 'grant.revoke',"),
    ], {D_BEARER}),
    ('E418(b): the single DELETE drops the step-up check', [
        (ROUTE, "    if (!token) {\n      throw await stepUpRequiredError(",
         "    if (!token && token === 'never') {\n      throw await stepUpRequiredError("),
        (ROUTE, "      const stepUp = await stepUpService.consume(client, {\n"
                "        token, principalId: String(req.principal!.id), action: REVOKE_STEP_UP_ACTION, targetId: id,\n"
                "      });\n",
         "      const stepUp = { tokenId: String(token), method: stepUpService ? 'password' : 'password' };\n"),
    ], {D_STEP_UP, D_ALLOWED}),
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
        code = subprocess.run(command, cwd=copy / 'backend', stdout=log, stderr=subprocess.STDOUT, timeout=1200).returncode
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
    parser.add_argument('--only', type=int, action='append', help='run only the control with this 1-based index')
    parser.add_argument('--observe', action='store_true', help='record every control and continue past a miss (never a gate)')
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
    copy = Path(tempfile.mkdtemp(prefix='grants-bulk-revoke-drill-'))
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
            if args.only and index not in args.only:
                continue
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
            if not semantic and not args.observe:
                raise SystemExit(f'control did not fail at its declared assertions: {name}')
    finally:
        shutil.rmtree(copy, ignore_errors=True)
        after = fingerprints(ROOT)
        (out / 'closure.json').write_text(json.dumps({
            'sourceUnchanged': before == after, 'copyRemoved': not copy.exists(), 'controls': len(receipts),
        }, indent=2))
    if before != fingerprints(ROOT):
        raise SystemExit('the source tree changed during the drill')
    reds = sum(1 for r in receipts if r['red'])
    if args.observe:
        print(f'observe: {reds} of {len(receipts)} controls red at their declared assertions; source unchanged')
        return
    print(f'all {len(receipts)} controls red at their declared assertions; source unchanged')


if __name__ == '__main__':
    main()
