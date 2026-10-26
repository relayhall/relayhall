#!/usr/bin/env python3
"""Mutation drill for the universal change request, train T2: slice S4's
identity targets and slice S5's object targets (card 9ce0b0b0; design
ratified by owner ruling E325).

Each control below edits ONE literal anchor in a disposable copy of the tree,
runs its section's suite - `backend/src/__tests__/changeRequestTargetsLive.test.ts`
(S4) or `backend/src/__tests__/changeRequestObjectTargetsLive.test.ts` (S5) -
against a REAL disposable PostgreSQL through the production router (and, for
S4, the MCP ingress), and requires that suite to go red at EXACTLY the
predeclared set of tests, for an assertion (not a compile error, a timeout or
a crashed fixture). Every control reddens a different set, so no two controls
can be satisfied by one assertion.

The controls withdraw, one at a time, what the design binds S4 to:
  1. section 5.5 (c): the principal whose role or status changes no longer
     counts as the target principal, so its own Account decides it;
  2. section 5.5 (c): the holder of a revoked credential no longer counts;
  3. section 5.5 (d): a warrant's holder no longer counts, so the Account it
     sits under decides the warrant;
  4. section 5.1 (5): the decider's own role is no longer the issuer of an
     elevated role (an operator gives admin);
  5. section 3 / Q31 (a): a disable no longer revokes the stored login sessions;
  6. section 3 / 7.4: a disable no longer lapses the requests naming the
     Account as grantee;
  7. section 3 / Q31 (a): the direct door stays shallow (the cascade runs on
     the request door only), so the two doors are not one seam;
  8. section 5.1 (4): identity.create and identity.status are decided by an
     administrator, not by a root session alone;
  9. section 6: the stale check no longer reads a principal's role;
 10. section 6: the stale check no longer reads a warrant's status;
 11. section 5.4: a role narrows sideways (same class, another role);
 12. section 5.4: a warrant cap widens at decide;
 13. section 3 (AZ-A13 clause 9d): a warrant pin is loosened through a request;
 14. section 4.1 row 4: an ordinary user asks for a role on another principal
     of its own subtree;
 15. section 3: the decided role is not published to the read caches after
     COMMIT, so it does not bite on the next request;
 16. section 5.3: the warrant a decision creates no longer carries the
     decision's step-up as its evidence;
 17. section 7.1: the principal.create row of a decided identity.create loses
     the decision ledger.
The S5 controls withdraw, one at a time, what the design binds S5 to (each
"decider standing dropped" or "evidence forged" is a control on its executor):
 18. section 5.5 (d): the principal an object change puts on the object (a
     default Verifier, a Shepherd) is not named, so it decides the change;
 19-24. section 5.1 (5): the decider's own reach on the object is not checked
     for phase.goal, task.roles, task.access, project.default_verifier,
     report.visibility and report.account_owner (its entry dropped), so a
     person owner whose role cannot act on the object applies it;
 25. section 5.1: an object change is applied without the deciding session's
     own facts, under a stand-in authority;
 26. section 5.2: a person owner decides a Project's move into a Group;
 27. section 5.3: the Group transfer seam accepts forged decision evidence;
 28. section 5.3: the Charter gate (i) accepts forged decision evidence;
 29. section 4.1 row 3: task.account_owner reaches the owner tier;
 30. section 3: a task-bound Report's account owner is filed;
 31. section 3: task.roles holders are not re-checked at decide;
 32. section 3: the access apply loses its audit_events row;
 33. section 3: a closed-to-closed Report label is requested;
 34. section 6: the stale check no longer compares the object's state;
 35. section 6: the stale check no longer re-derives the object's owner;
 36. E311: the Phase default-Verifier route conceals a caller who reads the
     Phase instead of answering it by name;
 37. E311: the Project default-Verifier route refuses a write-grantee at the
     point stage instead of by name;
 38. section 5.2: a Group owner decides a Group-owned Project's move;
 39-40. section 5.3: the Group transfer seam and the Charter gate (i) take
     another decider's consumed decision token as evidence;
 41-43. section 3: the new Report executor moves a Report to a Connector, moves
     a task-bound Report, and moves a Report whose owner moved after the decision
     read it;
 44. section 4.1 row 3: an ordinary user files an object target on an object it
     reads but does not own (the same guard keeps task.account_owner off the
     owner tier, so its own Task's owner and the preview redden with it);
 45. section 2.1: an object target carries a grantee;
 46-48. section 5.1 (5): the decider's own reach on the object is not checked
     for phase.default_verifier, phase.access and charter.revision (its entry
     dropped); for charter.revision the Charter act's own gate still refuses
     the decider by its own code, so the control pins that the reach check
     runs first.
The source tree is never edited: its bytes are fingerprinted before and after.

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \\
    python3 scripts/change-request-target-mutations.py --output-dir /tmp/change-request-target-drill
  python3 scripts/change-request-target-mutations.py --describe   # checks every anchor, no database
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
SUITE = 'src/__tests__/changeRequestTargetsLive.test.ts'
OBJECT_SUITE = 'src/__tests__/changeRequestObjectTargetsLive.test.ts'
SERVICE = 'backend/src/services/ChangeRequestService.ts'
TARGETS = 'backend/src/utils/changeTargets.ts'
PRINCIPALS = 'backend/src/services/PrincipalService.ts'
APPROVALS = 'backend/src/services/ApprovalService.ts'
TRANSFER = 'backend/src/services/GroupOwnershipTransfer.ts'
CHARTER = 'backend/src/services/CharterService.ts'
REPORT_OWNER = 'backend/src/services/ReportAccountOwnershipService.ts'
POINT = 'backend/src/middleware/sharedAuthorization.ts'

# The tests each control must turn red, by title (assertionResults[].title).
I1 = ('I1: a viewer asks for its own role on the session door; an administrator decides with one step-up and the role bites on the'
      ' next request')
I2 = "I2: an ordinary user asks for its own Account's role only, within ceiling class 2; every refusal is named and files nothing"
I3 = ('I3: an elevated role is decided only by an admin issuer: an operator is refused DECIDER_CEILING_EXCEEDED without spending its'
      ' step-up; root applies it')
I4 = 'I4: the decider narrows a role to a lower one, never a higher or a sideways one'
I5 = "I5: the target principal's own Account never decides its role (section 5.5 (c)), root not exempt; another root does"
I6 = 'I6: a role changed after filing lapses the request TARGET_CHANGED and applies nothing'
I7 = 'I7: identity.create is filed by an administrator and created by a root session only, with the decision on principal.create'
I8 = ('I8: identity.status on the direct door: a disable revokes the stored login sessions in the same act, and an enable leaves them'
      ' revoked')
I9 = 'I9: identity.status on the request door: an administrator files, a root session alone decides, and the same seam cascades'
I10 = ("I10: credential.revoke: an administrator revokes another principal's credential by request; the holder's Account never"
       " decides it")
I11 = ('I11: identity.status on the direct door: a disable lapses the PENDING requests naming the Account as grantee, and nothing'
       ' else')
W1 = ('W1: warrant.create filed over MCP writes no warrant (R9:187: MCP files, never mutates /warrants); the decider creates it with'
      ' the decision step-up')
W2 = ("W2: a warrant on a holder under the decider's Account is never decided by it (section 5.5 (d)); a holder outside the"
      " filer's subtree is answered as absent")
W3 = 'W3: warrant.edit is narrowed (a lower cap, never a higher one) and applied in place'
W5 = 'W5: a warrant whose status changed after filing lapses the request TARGET_CHANGED'
W6 = 'W6: a warrant pin is never loosened through a request, and a warrant edit names only the editable fields'
P1 = 'P1: the preview names the identity targets, who may decide them, and writes nothing'

# Slice S5, changeRequestObjectTargetsLive.test.ts.
O3 = "O3: a move into a Group is decided by root or an administrator only; the Group transfer takes the decision's ONE step-up as its evidence"
O4 = "O4: forged evidence is refused by the Group transfer seam: an unconsumed token, or another decider's, answers STEP_UP_REQUIRED"
O5 = 'O5: task.account_owner is filed and decided by root or an administrator; an ordinary user, even its owner, has no standing to ask'
O6 = 'O6: report.account_owner moves a standalone Report through the new executor; a task-bound Report and a Connector owner are refused at filing'
V2A = "V2a: E311's 403 binds the Project default-Verifier route for a non-owner write-grantee, through the lifted seam"
V2B = "V2b: E311's 403 binds the Phase default-Verifier route for a caller who reads the Phase; a Group value is refused at filing"
V4 = 'V4: task.roles re-checks its holders at decide: a Verifier disabled after filing is refused and nothing is applied'
G2 = "G2: on a Group-owned Project the Group's owner approves the Charter through gate (i) with the decision's step-up; forged evidence is refused"
A1 = 'A1: task.access is applied by an administrator with its first audit_events row beside the trigger ledger'
A2 = 'A2: phase.access is applied by an administrator with its first audit_events row'
A3 = 'A3: report.visibility requests only the opening transition; a closed Report opened by request is read by every authenticated principal'
CEILING = " a person owner whose role cannot act on the object at the direct door's action is refused DECIDER_CEILING_EXCEEDED, its step-up unspent"
R1, R2, R3, R4, R5, R6, R13, R14, R15 = (f'{name}:{CEILING}' for name in (
    'R1 phase.goal', 'R2 task.roles', 'R3 task.access', 'R4 project.default_verifier', 'R5 report.visibility', 'R6 report.account_owner',
    'R13 phase.default_verifier', 'R14 phase.access', 'R15 charter.revision'))
R7 = "R7: a decision that does not carry the deciding session's own facts applies nothing"
R8 = 'R8: the principal a change puts on the object never decides it (section 5.5 (d)): a named default Verifier, a named Shepherd'
R9 = 'R9: a stale preview never applies: an object whose state moved after filing lapses the request TARGET_CHANGED'
R10 = 'R10: a stale preview never applies: an object whose OWNER moved after filing lapses the request, so a former owner never decides it'
O4B = ("O4b: the Group transfer seam takes evidence only for its own decider: another person's consumed decision token answers"
       ' STEP_UP_REQUIRED')
O7 = 'O7: a Group-owned Project moved to a person is decided by root or an administrator; its Group owner has no tier here'
O8A = 'O8a: the Report executor moves a Report to an active human Account only'
O8B = 'O8b: the Report executor never moves a task-bound Report'
O8C = 'O8c: the Report executor refuses a move whose current owner is not the one the decision approved against'
G2B = ("G2b: the Charter gate (i) takes evidence only for its own decider: another person's consumed decision token answers"
       ' STEP_UP_REQUIRED')
R11 = 'R11: an ordinary user who reads an object but does not own it has no standing to ask for its object targets'
R12 = 'R12: an object target names its object and no grantee'
P1O = ('P1: the preview names the object targets for each object, who may decide them, and writes nothing; an unreadable object answers as'
       ' an absent one')

# (name, file, anchor, replacement, the exact set of tests that must fail)
CONTROLS = [
    ('section 5.5 (c): the principal whose role or status changes is not the target principal', SERVICE,
     "      : targetType === 'credential.issue' || (PRINCIPAL_TARGETS as readonly string[]).includes(targetType) ? row.target_id\n",
     "      : targetType === 'credential.issue' || ((PRINCIPAL_TARGETS as readonly string[]).includes(targetType) && targetType.length < 0)"
     " ? row.target_id\n",
     {I1, I5}),
    ("section 5.5 (c): a revoked credential's holder is not the target principal", SERVICE,
     "    const holder = targetType === 'credential.scopes' || targetType === 'credential.revoke' ? before.holderPrincipalId\n",
     "    const holder = targetType === 'credential.scopes' ? before.holderPrincipalId\n",
     {I10}),
    ("section 5.5 (d): a warrant's holder is not named by the change", SERVICE,
     "      if (warrantHolderRoot) named.push({ id: warrantHolderRoot, case: 'd' });\n",
     "      if (warrantHolderRoot && warrantHolderRoot.length < 0) named.push({ id: warrantHolderRoot, case: 'd' });\n",
     {W1, W2}),
    ("section 5.1 (5): the decider's own role is not the issuer of the role it gives", SERVICE,
     "    const deciderRole = resolveActorRole({ handle: String(deciderRow?.handle ?? ''), principalRole: deciderRow?.role ?? null });\n",
     "    const deciderRole = String('admin') || resolveActorRole({ handle: String(deciderRow?.handle ?? ''), principalRole: deciderRow?.role ?? null });\n",
     {I1, I3}),
    ('section 3, Q31 (a): a disable no longer revokes the stored login sessions', PRINCIPALS,
     "        sessionsRevoked = await loginSessionService.revokeAllForPrincipal(principal.id, 'disabled_user', null, client);\n",
     "        sessionsRevoked = 0; void loginSessionService;\n",
     {I8, I9}),
    ('sections 3 and 7.4: a disable no longer lapses the requests naming the Account as grantee', PRINCIPALS,
     "        lapsedApprovalIds = await lapseApprovalsForDisabledGrantee(client, principal.id, input.actor);\n",
     "        lapsedApprovalIds = []; void lapseApprovalsForDisabledGrantee;\n",
     {I9, I11}),
    ('section 3, Q31 (a): the direct door stays shallow, so the two doors are not one seam', PRINCIPALS,
     "      const disabledNow = changedFields.includes('status') && principal.status === 'disabled';\n",
     "      const disabledNow = changedFields.includes('status') && principal.status === 'disabled' && input.metadata !== undefined;\n",
     {I8, I11}),
    ('section 5.1 (4): identity.create and identity.status are decided by an administrator', TARGETS,
     "  'profile.assignment', 'identity.create', 'identity.status',\n",
     "  'profile.assignment',\n",
     {I7, I9, P1}),
    ("section 6: the stale check no longer reads a principal's role", SERVICE,
     "      if ((now.role ?? null) !== (before.role === undefined ? (now.role ?? null) : before.role)) return 'its role changed';\n",
     "",
     {I6}),
    ("section 6: the stale check no longer reads a warrant's status", SERVICE,
     "      if (String(locked.row.status) !== String(before.status)) return 'its status changed';\n",
     "",
     {W5}),
    ('section 5.4: a role narrows sideways', SERVICE,
     "      if (role !== requested.role && roleRank(role) >= roleRank(requested.role)) {\n",
     "      if (role !== requested.role && roleRank(role) > roleRank(requested.role)) {\n",
     {I4}),
    ('section 5.4: a warrant cap widens at decide', SERVICE,
     "        if (ceiling !== null && value > Number(ceiling)) throw narrows(",
     "        if (ceiling !== null && value < 0) throw narrows(",
     {W3}),
    ('section 3, AZ-A13 clause 9d: a warrant pin is loosened through a request', SERVICE,
     "      if (target.classification.moves.transportPin === 'up') {\n",
     "      if (target.classification.moves.transportPin === 'down') {\n",
     {W6}),
    ('section 4.1 row 4: an ordinary user asks for a role on another principal of its own subtree', SERVICE,
     "    if (ctx.tier === 'user' && lower(String(row.id)) !== lower(ctx.accountId)) {\n",
     "    if (ctx.tier === 'user' && lower(String(row.id)) === 'never') {\n",
     {I2}),
    ('section 3: the decided role is not published to the read caches after COMMIT', APPROVALS,
     "      if (typeof afterCommit === 'function') afterCommit();\n",
     "      void afterCommit;\n",
     {I1}),
    ("section 5.3: the warrant a decision creates loses the decision's step-up as its evidence", SERVICE,
     "        stepUp: input.stepUp, auditMetadata: ledger,\n",
     "        stepUp: null, auditMetadata: ledger,\n",
     {W1}),
    ('section 7.1: the principal.create row of a decided identity.create loses the decision ledger', SERVICE,
     "        metadata: { ...ledger, requestKind: 'change', kind: created.kind, handle: created.handle, role: created.role },\n",
     "        metadata: { requestKind: 'change', kind: created.kind, handle: created.handle, role: created.role },\n",
     {I7}),
]

# Slice S5: (name, file, anchor, replacement, the exact set of tests of OBJECT_SUITE that must fail)
OBJECT_CONTROLS = [
    ('section 5.5 (d): the principal an object change puts on the object is not named by it', SERVICE,
     "        if (typeof value === 'string' && UUID_PATTERN.test(value)) { named.push({ id: value, case: 'd' }); groups.push(value); }\n",
     "        if (typeof value === 'string' && UUID_PATTERN.test(value) && value.length < 0) { named.push({ id: value, case: 'd' }); groups.push(value); }\n",
     {R8}),
    ("section 5.1 (5): the decider's reach on a Phase goal is not checked", TARGETS,
     "  'phase.goal': 'write',\n", "", {R1}),
    ("section 5.1 (5): the decider's reach on a Task's roles is not checked", TARGETS,
     "  'task.roles': 'shepherd',\n", "", {R2}),
    ("section 5.1 (5): the decider's reach on a Task's access is not checked", TARGETS,
     "  'task.access': 'admin',\n", "", {R3}),
    ("section 5.1 (5): the decider's reach on a Project's default Verifier is not checked", TARGETS,
     "  'project.default_verifier': 'write',\n", "", {R4}),
    ("section 5.1 (5): the decider's reach on a Report's visibility is not checked", TARGETS,
     "  'report.visibility': 'write',\n", "", {R5}),
    ("section 5.1 (5): the decider's reach on a Report's account owner is not checked", TARGETS,
     "  'report.account_owner': 'write',\n", "", {R6}),
    ("section 5.1: an object change is applied without the deciding session's own facts, under a stand-in authority", SERVICE,
     "    const request = input.deciderRequest;\n",
     "    const request: ChangeDeciderRequest | undefined = input.deciderRequest ?? {\n"
     "      authorization: { authenticated: true, principalId: input.deciderPrincipalId, handle: actor.handle, role: 'admin', scopes: ['root'] },\n"
     "      principalId: input.deciderPrincipalId, handle: actor.handle, authMethod: 'session', principalRole: 'admin', sessionRole: null,\n"
     "      scopes: ['root'], sessionId: null, credentialId: null,\n"
     "    } as ChangeDeciderRequest;\n",
     {R7}),
    ("section 5.2: a person owner decides a Project's move into a Group", SERVICE,
     "      if (spec.requested?.ownerKind === 'group') {\n",
     "      if (spec.requested?.ownerKind === 'never') {\n",
     {O3}),
    ("section 5.2: a Group owner decides a Group-owned Project's move", TARGETS,
     "  'project.default_verifier', 'phase.default_verifier', 'task.access', 'phase.access', 'project.owner',\n",
     "  'project.default_verifier', 'phase.default_verifier', 'task.access', 'phase.access',\n",
     {O7}),
    ('section 5.3: the Group transfer seam accepts another decider\'s evidence', TRANSFER,
     "      if (String(decision.deciderPrincipalId).toLowerCase() !== String(principalId).toLowerCase()) {\n",
     "      if (String(decision.deciderPrincipalId).toLowerCase() === 'never') {\n",
     {O4B}),
    ('section 5.3: the Charter gate (i) accepts another decider\'s evidence', CHARTER,
     "      if (String(decisionEvidence.deciderPrincipalId).toLowerCase() !== String(actorId).toLowerCase()) {\n",
     "      if (String(decisionEvidence.deciderPrincipalId).toLowerCase() === 'never') {\n",
     {G2B}),
    ('section 3: the Report executor moves a Report to a Connector', REPORT_OWNER,
     "    const problem = reportOwnerProblem(target);\n",
     "    const problem = target?.kind === 'never' ? reportOwnerProblem(target) : null;\n",
     {O8A}),
    ('section 3: the Report executor moves a task-bound Report', REPORT_OWNER,
     "    if (report.origin === 'task-report' || report.source_task_id) {\n",
     "    if ((report.origin === 'task-report' || report.source_task_id) && report.id === 'never') {\n",
     {O8B}),
    ('section 3: the Report executor moves a Report whose owner moved', REPORT_OWNER,
     "    if (previous !== expected) {\n",
     "    if (previous !== expected && expected === 'never') {\n",
     {O8C}),
    ('section 4.1 row 3: an ordinary user files an object target on an object it does not own', SERVICE,
     "    const needsOwner = objectTarget || !selfGrantee || (target.targetType === 'knowledge.compartment' && target.operation === 'write');\n",
     "    const needsOwner = !selfGrantee || (target.targetType === 'knowledge.compartment' && target.operation === 'write');\n",
     {R11, O5, P1O}),
    ('section 2.1: an object target carries a grantee', SERVICE,
     "      || S4_TARGET_TYPES.includes(targetType) || S5_TARGET_TYPES.includes(targetType);\n",
     "      || S4_TARGET_TYPES.includes(targetType);\n",
     {R12}),
    ('section 5.3: the Group transfer seam accepts forged decision evidence', TRANSFER,
     "      await assertDecisionEvidence(client, decision);\n", "      void assertDecisionEvidence;\n", {O4}),
    ('section 5.3: the Charter gate (i) accepts forged decision evidence', CHARTER,
     "      await assertDecisionEvidence(executor, decisionEvidence);\n", "      void assertDecisionEvidence;\n", {G2}),
    ('section 4.1 row 3: task.account_owner reaches the owner tier', TARGETS,
     "  'report.visibility', 'report.account_owner', 'group.steward', 'project.owner',\n",
     "  'report.visibility', 'report.account_owner', 'group.steward', 'project.owner', 'task.account_owner',\n",
     {O5, P1O}),
    ("section 3: a task-bound Report's account owner is filed", SERVICE,
     "        if (report?.origin === 'task-report' || report?.source_task_id) {\n"
     "          throw refuse(422, 'REPORT_TASK_BOUND', 'a task-bound Report is never account-owned: it belongs to its Task', 'target', '3',\n",
     "        if ((report?.origin === 'task-report' || report?.source_task_id) && report === null) {\n"
     "          throw refuse(422, 'REPORT_TASK_BOUND', 'a task-bound Report is never account-owned: it belongs to its Task', 'target', '3',\n",
     {O6}),
    ('section 3: task.roles holders are not re-checked at decide', SERVICE,
     "      if (problem) throw refuse(problem.status, problem.code, problem.message, 'target', '7.1', 'the roles route admits the holders at decide');\n",
     "      void problem;\n",
     {V4}),
    ('section 3: the access apply loses its audit_events row', SERVICE,
     "        action: `${type}.access.set`, actor, resourceType: type, resourceId: targetId,\n",
     "        action: `${type}.access.unset`, actor, resourceType: type, resourceId: targetId,\n",
     {A1, A2}),
    ('section 3: a closed-to-closed Report label is requested', SERVICE,
     "      if (!OPEN_REPORT_VISIBILITY.includes(change.visibility) || OPEN_REPORT_VISIBILITY.includes(String(before.visibility))) {\n",
     "      if (OPEN_REPORT_VISIBILITY.includes(String(before.visibility))) {\n",
     {A3}),
    ("section 6: the stale check no longer compares the object's state", SERVICE,
     "      if (stableJson(now) !== stableJson(before)) return 'its state differs from the one the request was filed against';\n",
     "", {R9}),
    ("section 6: the stale check no longer re-derives the object's owner", SERVICE,
     "      if (JSON.stringify(located.objects.map((o) => o.ownerIds)) !== JSON.stringify(filedOwners)) return \"the object's owner changed\";\n",
     "      void located;\n", {R10}),
    ('E311: the Phase default-Verifier route conceals a caller who reads the Phase', POINT,
     "      res.locals[DEFAULT_VERIFIER_POINT_REFUSED] = true;\n      next();\n      return;\n",
     "      void DEFAULT_VERIFIER_POINT_REFUSED;\n",
     {V2B}),
    ('E311: the Project default-Verifier route refuses a write-grantee at the point stage', POINT,
     "    && tail.length === 1 && tail[0] === 'default-verifier') action = 'write';\n",
     "    && tail.length === 1 && tail[0] === 'default-verifier') action = 'admin';\n",
     {V2A}),
    ("section 5.1 (5): the decider's reach on a Phase's default Verifier is not checked", TARGETS,
     "  'phase.default_verifier': 'write',\n", "", {R13}),
    ("section 5.1 (5): the decider's reach on a Phase's access is not checked", TARGETS,
     "  'phase.access': 'admin',\n", "", {R14}),
    ("section 5.1 (5): the decider's reach on a Charter revision is checked first", TARGETS,
     "  'charter.revision': 'write',\n", "", {R15}),
]

# Every control with the suite it is measured on.
SECTIONS = [(SUITE, CONTROLS), (OBJECT_SUITE, OBJECT_CONTROLS)]
ALL_CONTROLS = [(suite, *control) for suite, controls in SECTIONS for control in controls]

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


def run_suite(copy, out, label, suite):
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

    for _, _, path, anchor, replacement, _ in ALL_CONTROLS:
        once((ROOT / path).read_text(), anchor, replacement)
    sets = [(c[0], frozenset(c[5])) for c in ALL_CONTROLS]
    if len(set(sets)) != len(sets) or any(not s for _, s in sets):
        raise SystemExit('every control must declare a non-empty must-fail set that no other control shares')
    if args.describe:
        print(json.dumps([{'control': c[1], 'suite': c[0], 'file': c[2], 'mustFail': sorted(c[5])} for c in ALL_CONTROLS], indent=2))
        print(f'{len(ALL_CONTROLS)} controls, every anchor found exactly once, every must-fail set distinct')
        return

    require_disposable_database()
    if not args.output_dir:
        raise SystemExit('--output-dir is required')
    out = args.output_dir.resolve()
    if out == ROOT or ROOT in out.parents:
        raise SystemExit('--output-dir must lie outside the repository')
    out.mkdir(parents=True, exist_ok=False)

    before = fingerprints(ROOT)
    copy = Path(tempfile.mkdtemp(prefix='change-request-target-drill-'))
    receipts = []
    try:
        shutil.copytree(ROOT, copy, dirs_exist_ok=True, ignore=shutil.ignore_patterns(*IGNORED, '*.log'))
        (copy / 'backend/node_modules').symlink_to((ROOT / 'backend/node_modules').resolve(), target_is_directory=True)

        baseline = {}
        for number, (suite, controls) in enumerate(SECTIONS, start=1):
            code, tests, _ = run_suite(copy, out, f'baseline-{number}', suite)
            titles = [t['title'] for t in tests]
            if code != 0 or not tests or any(t['status'] != 'passed' for t in tests):
                raise SystemExit(f'baseline is not green: {suite}')
            if len(set(titles)) != len(titles):
                raise SystemExit('two tests share a title, so a declared title would not name one test')
            for _, _, _, _, must_fail in controls:
                if not set(must_fail) <= set(titles):
                    raise SystemExit(f'a declared test is absent from the suite: {sorted(set(must_fail) - set(titles))}')
            baseline[suite] = titles

        for index, (suite, name, path, anchor, replacement, must_fail) in enumerate(ALL_CONTROLS, start=1):
            titles = baseline[suite]
            target = copy / path
            original = target.read_text()
            target.write_text(once(original, anchor, replacement))
            try:
                code, tests, suite_messages = run_suite(copy, out, f'control-{index}', suite)
            finally:
                target.write_text(original)
            failed = {t['title'] for t in tests if t['status'] == 'failed'}
            messages = re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(
                m for t in tests if t['status'] == 'failed' for m in t.get('failureMessages', [])))
            semantic = code != 0 and [t['title'] for t in tests] == titles and failed == set(must_fail) \
                and all('expect(' in '\n'.join(t.get('failureMessages', [])) for t in tests if t['status'] == 'failed') \
                and not re.search(r'TS\d{4}|SyntaxError|Test suite failed to run|Exceeded timeout|ECONNREFUSED',
                                  messages + suite_messages)
            receipts.append({'control': name, 'suite': suite, 'file': path, 'mustFail': sorted(must_fail),
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
