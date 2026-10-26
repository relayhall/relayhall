#!/usr/bin/env python3
"""Mutation drill for AZ-A12 build 5 (card a9b1e69c; amendment AZ-A12 clauses
12 and 13, and D-16): the hub ownership class order, the owner fields and the
feed fan-out.

Each control below edits literal anchors in a DISPOSABLE COPY of the tree, runs
the live suite src/__tests__/groupOwnerHubLive.test.ts against a REAL
disposable PostgreSQL through the production router, and requires that suite to
go red at EXACTLY the predeclared set of tests, for an assertion (not a compile
error, a timeout or a crashed fixture). Every control reddens a different set,
so no two controls can be satisfied by one assertion (G.2 drill 11).

The controls withdraw, one at a time, what the build promises:
  - the hub: the owner column decides `group` first, the owning Group listed
    first; a live Group grant is the fallback; the owner kind is read;
  - the AZ-A9 decider view: the same order (D-16);
  - the owner fields: ownerKind and ownerDisplayName on the Project record and
    the Task account-owner read, the name joined server-side, and the OpenAPI;
  - the feed: a Group owner's transition event reaches its members through the
    use-tier fragment, which a disabled Group fails;
  - the owner-change socket hint: fanned out to the active members only, and
    still both owners;
  - the bell: My work counts Group ownership at the edit tier only;
  - build 4 (card 1942926f, M-c): the skill shape's owner, and a Group
    member's use-tier view of a Group-owned Skill's drafts (G.2 drill 1's
    skill rows).

The source tree is never edited: its bytes are fingerprinted before and after.

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \\
    python3 scripts/group-owner-hub-mutations.py --output-dir /tmp/group-owner-hub-drill
  python3 scripts/group-owner-hub-mutations.py --describe   # checks every anchor, no database
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
SUITE = 'src/__tests__/groupOwnerHubLive.test.ts'
HUB = 'backend/src/services/ApprovalHubService.ts'
APPROVALS = 'backend/src/services/ApprovalService.ts'
PROJECTS = 'backend/src/services/ProjectService.ts'
TASK_OWNER = 'backend/src/services/TaskAccountOwnershipService.ts'
OWNER_FACTS = 'backend/src/utils/ownerFacts.ts'
SPEC = 'backend/src/openapi/spec.ts'
FEED = 'backend/src/services/FeedEventService.ts'
TRANSFER = 'backend/src/services/ProjectOwnershipService.ts'
HISTORY = 'backend/src/services/NotificationHistoryService.ts'

# Tests, by title.
H_OWNED = 'a Group-owned project lists under its owning Group, marked owner, before any granted Group'
H_GRANTED = 'a person-owned project with a live Group grant is group by the fallback, marked grant'
H_UNCHANGED = 'shared, private and board are unchanged, each carrying the owner kind'
H_FILTER = 'the group filter by the owning Group id finds the Group-owned item and no other'
D_OWNED = 'a Group-owned project with no Group grant on it is group by its owner'
D_GRANTED = 'a person-owned project with a live exact-id Group grant is group by the fallback'
D_PRIVATE = 'a person-owned project with neither is private'
P_POINT = ('GET /projects/:id names a Group owner by kind and name, a person by kind and display name, '
           'and no owner by nulls')
P_LIST = 'the project list carries the same owner fields'
T_READ = 'the Task account-owner read names the effective owner: a Group through its Project, a person explicitly'
P_OPENAPI = ('the OpenAPI Project schema and the account-owner read require ownerKind and ownerDisplayName, '
             'and a Project answer has exactly the schema keys')
F_MEMBERS = "a Group-owner transition event reaches the Group's members and managers, never a non-member"
F_DISABLED = 'a disabled Group principal reaches nobody through its recorded ownership'
S_FANOUT = 'the owner-change socket hint fans out to the active members of the prior owning Group'
S_INACTIVE = 'an inactive member of the prior owning Group is not told'
S_PERSONS = 'a transfer between persons tells exactly the two owners'
B_MANAGER = 'My work lists a status move on a Group-owned Task to its manager'
B_MEMBER = "a plain member's My work leaves it out"
B_ALL = 'the member still sees it under Everything I can see, and a non-member nowhere'
B_UNREAD = 'the unread count follows My work: the manager counts it, the member does not'

K_MEMBER = 'drill 1 (skill rows): a member reads the Group-owned Skill and uses its draft content, but writes no Version'
K_MANAGER = 'drill 1 (skill rows): a manager writes a Version and submits it for review, but never publishes'
K_OWNER_ROLE = 'drill 1 (skill rows): an owner-role holder gets exactly the manager tier, and the admin acts stay refused'
K_OTHERS = ('drill 1 (skill rows): a non-member gets nothing of the draft, and a viewer holding a manager row '
            'never writes')
REPOSITORY = 'backend/src/services/AuthorizationRepository.ts'
SKILLS = 'backend/src/services/SkillManager.ts'

MY_WORK_ARM ="         OR ${groupOwnerCondition({ owner: MY_WORK_GROUP_OWNER, account: me, tier: 'edit' })}"

# (name, [(file, anchor, replacement), ...], the exact set of tests that must fail)
CONTROLS = [
    ('the hub does not read the owner column', [
        (HUB, "  if (ownerKind === 'group' && project.ownerPrincipalId) {",
         "  if (ownerKind === 'group' && project.ownerPrincipalId === 'never') {")],
     {H_OWNED, H_FILTER}),
    ('the hub drops the Group grant fallback', [
        (HUB, '  if (granted.length > 0) {', '  if (granted.length < 0) {')],
     {H_GRANTED}),
    ('the hub lists the owning Group after the granted Groups', [
        (HUB, '      groups: disclose ? [owner, ...granted.filter((entry) => entry.id !== owner.id)] : [],',
         '      groups: disclose ? [...granted.filter((entry) => entry.id !== owner.id), owner] : [],')],
     {H_OWNED}),
    ("the hub loses a person owner's kind", [
        (HUB, '      ownerKind: row.owner_id ? ownerKindOf(row.owner_kind) : null,',
         "      ownerKind: row.owner_id ? ownerKindOf(row.owner_kind === 'human' ? null : row.owner_kind) : null,")],
     {H_GRANTED, H_UNCHANGED}),
    ('the decider view does not read the owner column (D-16)', [
        (APPROVALS, "        const ownedByGroup = facts.ownerKind === 'group' && ownerPrincipalId !== null;",
         "        const ownedByGroup = facts.ownerKind === 'group' && ownerPrincipalId !== null && ownerPrincipalId.length < 0;")],
     {D_OWNED}),
    ('the decider view drops the Group grant fallback (D-16)', [
        (APPROVALS, "          ownershipClass: listed.length > 0 ? 'group' : 'private',",
         "          ownershipClass: ownedByGroup ? 'group' : 'private',")],
     {D_GRANTED}),
    ('the Project record states no owner kind or name', [
        (PROJECTS, '      ...ownerFactsOf(row, row.owner_principal_id ?? null),', '      ...ownerFactsOf(row, null),')],
     {P_POINT, P_LIST}),
    ('the Task account-owner read names the explicit owner, not the effective one', [
        (TASK_OWNER, '      ...ownerFactsOf(row, row.effective_owner ?? null) };',
         '      ...ownerFactsOf(row, row.account_owner_principal_id ?? null) };')],
     {T_READ}),
    ('the owner name is the handle, not the Group or display name', [
        (OWNER_FACTS, 'COALESCE(${group}.name, ${alias}.display_name, ${alias}.handle)', 'COALESCE(${alias}.handle)')],
     {P_POINT, P_LIST, T_READ, D_OWNED, D_GRANTED}),
    ('the OpenAPI Project schema does not require the owner fields', [
        (SPEC, "'ownerPrincipalId', 'ownerKind', 'ownerDisplayName', 'inboxPhaseId'", "'ownerPrincipalId', 'inboxPhaseId'")],
     {P_OPENAPI}),
    ("the feed's Group-owner basis is dropped", [
        (FEED, '      if (row.owner_principal_id && groupOwnerAllowed.has(String(row.owner_principal_id))) return true;\n', '')],
     {F_MEMBERS}),
    ("the feed's Group-owner basis skips the use-tier fragment", [
        (FEED, "          WHERE ${groupOwnerCondition({ owner: 'recorded.owner_id', account: '$2', tier: 'use' })}`,",
         "          WHERE EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = recorded.owner_id "
         "AND gm.account_principal_id = $2::uuid) "
         "OR (FALSE AND ${groupOwnerCondition({ owner: 'recorded.owner_id', account: '$2', tier: 'use' })})`,")],
     {F_DISABLED}),
    ('the owner-change hint is not fanned out', [
        (TRANSFER, '      recipients = await ownerChangeRecipients(pool, [priorOwnerId, newOwnerId]);',
         '      void ownerChangeRecipients;')],
     {S_FANOUT}),
    ('the owner-change hint tells an inactive member', [
        (TRANSFER, "       JOIN principals member ON member.id = membership.account_principal_id AND member.status = 'active'",
         '       JOIN principals member ON member.id = membership.account_principal_id')],
     {S_INACTIVE}),
    ('the owner-change hint drops the prior owner', [
        (TRANSFER, '  return [...new Set([...owners, ...(members?.rows', '  return [...new Set([...owners.slice(1), ...(members?.rows')],
     {S_FANOUT, S_PERSONS}),
    ('My work does not count Group ownership', [
        (HISTORY, MY_WORK_ARM, MY_WORK_ARM.replace('OR ${', 'OR (FALSE AND ${') + ')')],
     {B_MANAGER, B_UNREAD}),
    ('My work counts Group ownership at the use tier', [
        (HISTORY, MY_WORK_ARM, MY_WORK_ARM.replace("tier: 'edit'", "tier: 'use'"))],
     {B_MEMBER, B_UNREAD}),
    # Build 4 (card 1942926f, M-c): drill 1's skill rows.
    ('the skill shape declares no owner (M-c)', [
        (REPOSITORY, "owner: 's.owner_principal_id', visibility: \"'shared'\" } };",
         "owner: 'NULL::uuid', visibility: \"'shared'\" } };")],
     {K_MANAGER, K_OWNER_ROLE, K_OTHERS}),
    ("a Group-owned Skill's drafts need the edit tier to be seen", [
        (SKILLS, "    arms.push(groupOwnerCondition({ owner: 's.owner_principal_id', account: param, tier: 'use' }));",
         "    arms.push(groupOwnerCondition({ owner: 's.owner_principal_id', account: param, tier: 'edit' }));")],
     {K_MEMBER}),
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
    copy = Path(tempfile.mkdtemp(prefix='group-owner-hub-drill-'))
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
            receipts.append({'control': name, 'files': sorted(originals), 'mustFail': sorted(must_fail),
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
