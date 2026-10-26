#!/usr/bin/env python3
"""Mutation drill for LENSES-c build c1-B, the owner-only gates and the manager
lens (card b5c83682; design delta LENSES-C steward tier, ratified by E98:
clauses C.4 to C.8, the census controls LC-C3 and LC-C5 of its test plan G.1,
and G.2 drill 11: every control ships a mutation proven to redden it alone).

Each control below edits literal anchors in a disposable copy of the tree -
the TypeScript of a gate, its route, its scope rule or the lens - and runs
four suites, the live one against a REAL disposable PostgreSQL through the
production router:

  backend/src/__tests__/lensesGatesLive.test.ts          (drills 3, 4, 5, 6, 7, 8, 10, U)
  backend/src/__tests__/lensesGatesRegisters.test.ts     (LC-C3, C.4 to C.8 as source properties)
  backend/src/__tests__/administratorSessionSeam.test.ts (LC-C5, the one classification)
  backend/src/__tests__/lensesContract.test.ts           (A-L51 and A-L53, the derivation)

A control is RED only when the suites fail at EXACTLY its declared set of
tests, each for an assertion (never a compile error, a timeout or a crashed
fixture). Every control declares a different set, so no two controls can be
satisfied by one assertion, and a mutation that reddens nothing fails the
drill. The source tree is never edited: its bytes are fingerprinted before and
after, and a closing baseline proves the copy was restored.

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \\
    python3 scripts/lenses-gates-mutations.py --output-dir /tmp/lenses-gates-drill [--only ID,ID]
  python3 scripts/lenses-gates-mutations.py --describe   # checks every anchor, no database
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
    'src/__tests__/lensesGatesLive.test.ts',
    'src/__tests__/lensesGatesRegisters.test.ts',
    'src/__tests__/administratorSessionSeam.test.ts',
    'src/__tests__/lensesContract.test.ts',
]
SCOPES = 'backend/src/utils/scopeMap.ts'
STEWARDS = 'backend/src/services/GroupStewardService.ts'
CHARTER = 'backend/src/services/CharterService.ts'
PROJECT_ROUTES = 'backend/src/routes/projects.ts'
TRANSFER = 'backend/src/services/GroupOwnerStewardTransfer.ts'
PROJECT_ACT = 'backend/src/services/ProjectOwnershipService.ts'
TASK_ACT = 'backend/src/services/TaskAccountOwnershipService.ts'
LENSES = 'backend/src/utils/lenses.ts'
FRAGMENT = 'backend/src/utils/liveStewardCondition.ts'

# ── the tests, by title (assertionResults[].title) ──
# lensesGatesLive.test.ts, (4) gate (iii)
A_OK = ('admitted: a live owner (an editor) appoints a member as manager with a step-up; a live manager row '
        'appointed by the owner; audited standing group-owner with stepUpTokenId; the token is spent')
A_NOT_OWNER = ('a manager caller, an owner of another Group, a plain member and an admin or operator session holding '
               'no owner row are refused GROUP_MANAGER_APPOINT_REQUIRES_OWNER, the token live')
A_INERT = ('an inert owner (left the Group) is refused GROUP_MANAGER_APPOINT_REQUIRES_OWNER; back in the Group, '
           'the same owner appoints')
A_NONMEMBER = ('an appointee who is not an active member - an outsider, a disabled member, an absent principal - '
               'is MANAGER_NOT_A_GROUP_MEMBER, the token live')
A_INELIGIBLE = ('an ineligible member appointee - a legacy identity, an operator - is STEWARD_INELIGIBLE with its '
                'reason; a service Account member is admitted')
A_TOKENS = ('a missing, replayed, other-Group or removal-bound token is STEP_UP_REQUIRED with the SU-14 challenge, '
            'and nothing is written')
A_SURVIVES = ('no refusal spends the token: ONE token survives a body refusal, a non-member, an already-steward and '
              'an ineligible appointee, then appoints')
A_ORDER = ('a step-up is answered after the appointee: an absent appointee with no token is '
           'MANAGER_NOT_A_GROUP_MEMBER, never STEP_UP_REQUIRED')
A_UPPER = ('an uppercase Group id appoints with a token minted for the lowercase id; a non-UUID Group id is 400 '
           'before anything')
A_BEARER = ("a bearer credential holding root and the owner's own Connector are refused "
            'GROUP_MANAGER_APPOINT_REQUIRES_SESSION, audited, nothing written, the token live')
A_ROLE_KEY = ('a body role key is refused UNKNOWN_FIELD and audited, so the route never writes an owner; the token '
              'stays live')
A_ALREADY = ('an appointee who already holds a role - a manager, another owner, the caller - is ALREADY_A_STEWARD '
             'naming the role')
A_RACE = ('two concurrent appointments of one Account never answer a raw 500: the one that commits second is '
          'ALREADY_A_STEWARD naming the role, audited, its token live')
# (5) gate (i)
C_OK = ('admitted: an owner-role holder (an editor) approves the Charter of a Group-owned project with a step-up; '
        'audited standing group-owner with owningGroupId and stepUpTokenId; the token is spent')
C_TOKENS = ('without a step-up, or with one bound to another project or another act, the owner-role holder is '
            'STEP_UP_REQUIRED with the SU-14 challenge; nothing written; audited denied with the refusal')
C_MANAGER = 'a manager is CHARTER_APPROVAL_FORBIDDEN, and a presented token stays live'
C_DISABLED = ('an owner under a disabled Group principal holding write another way is CHARTER_APPROVAL_FORBIDDEN, '
              'and a presented token stays live')
C_ADMIN = ('an administrator approves a Group-owned project without a step-up, unchanged, and its audit row carries '
           'no group-owner standing')
C_AUDIT_ARM = ("the arm's own refusals - a manager, an inert owner, a disabled Group - are audited denied with the "
               "refusal, owningGroupId and the group-owner standing; a person-owned refusal keeps today's row")
C_AUDIT_AFTER = ("a refusal after the arm admitted (no If-Match on an existing Charter) is still the arm's denied row, "
                 'with the refusal and the standing; the token stays live')
# (6) gate (ii)
O_PROJECT = ('admitted: a live owner moves a Group-owned project to an active member with a step-up; audited '
             'deciderStanding group-owner; grants preserved; the token is spent')
O_TASK = ('admitted for a task: a NULL-explicit task inheriting the Group owner is moved to a member, who is pinned '
          'as the explicit owner')
O_NONMEMBER = 'a target who is not a member of the Group is TARGET_NOT_A_GROUP_MEMBER, audited, the token live'
O_NOT_OWNER = ('a manager caller, an inert owner and an owner of a disabled Group (both holding write another way) '
               'are refused GROUP_OWNER_ROLE_REQUIRED, the token live')
O_BEARER = ("the owner's own Connector and a Main-appointed Connector are refused GROUP_OWNER_SESSION_ONLY, "
            'the token live')
O_ADMIN_ROUTE = ('the existing administrator route still serves root and administrators: an operator session moves '
                 'the project back into the Group through PUT /projects/:id/owner')
O_NOT_ADMIN = ('the steward route is not the administrator route: an editor owner-role holder is refused '
               'PUT /projects/:id/owner, and the steward route admits the same act')
O_TOKENS = 'a missing or foreign-object step-up is STEP_UP_REQUIRED with the challenge; the owner is unchanged'
O_SHAPES = 'a person-to-person move, a Group-to-Group move and a clear are STEWARD_TRANSFER_SHAPE_REFUSED'
O_REVISION = 'a stale If-Match revision is refused before the step-up is spent'
O_AUDIT_PROJECT = ("every refusal of the project steward route is audited denied with its code and the group-owner "
                   "standing - the route's query and body, the act's target, revision and person-target checks - and "
                   'no token is spent')
O_AUDIT_TASK = ("every refusal of the task steward route is audited denied with its code and the group-owner standing - "
                "the route's body, the act's malformed change, person-target and state checks - and no token is spent")
I_DISABLED = 'a disabled Group as target is INVALID_OWNER, the token live'
C_INERT = ('an inert owner (left the Group) holding write another way is CHARTER_APPROVAL_FORBIDDEN, and a presented '
           'token stays live')
# (7) DD-5
I_PROJECT = ('admitted: the person owner of a project, holding the owner role in G, moves it into G with a step-up; '
             'audited deciderStanding group-owner')
I_TASK = 'admitted for a task: the effective person owner moves a task into G'
I_NOT_CURRENT = 'a caller who is not the current owner is NOT_THE_CURRENT_OWNER, the token live'
I_MANAGER = 'a manager of G and an owner of another Group are GROUP_OWNER_ROLE_REQUIRED, the token live'
# (8) the lens
L_ARM = ('A-L51: a live owner and a live manager get the manager arm with their stewarded Groups, owners first, '
         'with the active memberCount, featured and role')
L_REMOVE = 'A-L51: removing the row removes the arm on the next request, with no cache to invalidate'
L_ADMIN = ('A-L51 admin negative: an admin session that stewards no Group gets no manager arm, so the arm is not '
           'derived from principals.role')
L_INERT = 'A-L51 inert negative: an inert row (the holder left the Group) gives no arm; back in the Group, it returns'
L_PLAIN = 'A-L53: a caller with no live row still gets exactly { lenses: [member], admin: false } and no manager key'
# (3), (10), (U)
PROMOTE = ('promotion: an operator session promotes a live owner to operator; gate (iii), both steward routes and '
           'gate (i) refuse and no manager key; demoted to editor, each returns')
PROMOTE_ROOT = ('promotion to admin or orchestrator by an admin session: gate (iii) and both steward routes refuse, '
                'and no manager key; SR-2 then answers that holder through the root arm, not the steward arm')
W_OWNER = ('no owner appoints an owner: the appointed row is always a manager row, and POST /groups/:id/stewards '
           'stops an owner session at the root ceiling')
U_APPOINT = "gate (iii) holds the appointee's member row: removeMember waits until the appointment's checks commit"
U_OUT = "gate (ii) holds the owner's and the target's member rows: a concurrent removal of the target waits"
# lensesGatesRegisters.test.ts
R_POST_CEILING = 'c1-B route ceiling: POST /groups/0b7a5ff6-3c1d-4c21-9a4f-1f1f1f1f1f1f/managers resolves to authenticated'
R_PROJECT_CEILING = ('c1-B route ceiling: PUT /projects/7c0e4a3e-1f2b-4c3d-8e9f-0a1b2c3d4e5f/owner/steward resolves '
                     'to projects:write')
R_MANAGERS_ORDER = 'the managers POST rule is listed BEFORE the /groups rules (first match wins)'
R_TASK_ORDER = 'the task steward rule is listed BEFORE the /tasks family rules (CC-8)'
R_PROJECT_ORDER = 'the project steward rule is listed BEFORE the project owner rule and the /projects family rules'
R_APPOINT_ORDER = 'the appointment runs the standing, then the appointee, then the ONE step-up, then the manager INSERT'
R_APPOINT_CODES = 'the appointment uses its own codes and never writes an owner'
R_APPOINTEE = 'the appointee check takes the member row FOR SHARE and reads the holder rules before any write'
R_CHARTER_ARM = ('the arm requires an ACTIVE Group owner, the live owner fragment with its locks, and consumes '
                 '(charter.approve, project id)')
R_CHARTER_ROUTE = 'the approve route admits the stepUpToken key and threads it through the approval actor'
R_REVISION = 'the project act checks the If-Match revision before the step-up'
R_SHAPES = 'the standing admits exactly the two shapes, on the live owner fragment with its locks'
R_ADMIN_VERB = 'the gate modules and acts name no admin action and no *:admin scope'
R_LENS_FRAGMENT = 'the stewarded Groups come from the fragment with both roles, owners first'
R_LENS_ROUTE = 'the route hands the rows to the derivation, which emits the arm only when there is at least one'
# administratorSessionSeam.test.ts
SEAM_TRANSFER = 'services/GroupOwnerStewardTransfer.ts imports and calls the seam'
# lensesContract.test.ts
U_NO_MANAGER = 'no caller of any kind is handed the manager lens without a live steward row, an EMPTY row list included'
U_MEMBER = 'a non-admin caller gets exactly { lenses: [member], admin: false } and NO manager key'
U_ADMIN = 'an admin caller gets exactly { lenses: [member, admin], admin: true } and NO manager key'
U_NO_ROOT = 'a login session without root is a member and nothing more'
U_KIND = ('the arm does not depend on the session kind or on root: a bearer holding rows gets it, an admin session '
          'holding none does not')

MANAGERS_POST = "  { pattern: /^\\/groups\\/[^/]+\\/managers$/, methods: ['POST'], scope: 'authenticated' },\n"
GROUPS_ROOT = "  { pattern: /^\\/groups(\\/|$)/, scope: 'root' },\n"
TASK_RULE = "  { pattern: /^\\/tasks\\/[^/]+\\/account-owner\\/steward$/, methods: ['PUT'], scope: 'tasks:write' },\n"
TASKS_WRITE = "  { pattern: /^\\/tasks(\\/|$)/, scope: 'tasks:write' },\n"
PROJECT_RULE = "  { pattern: /^\\/projects\\/[^/]+\\/owner\\/steward$/, methods: ['PUT'], scope: 'projects:write' },\n"
APPOINT_CONSUME = (
    "      try {\n"
    "        const evidence = await stepUpService.consume(client, {\n"
    "          token: stepUpToken,\n"
    "          principalId: ownerId,\n"
    "          action: GROUP_MANAGER_APPOINT_ACT,\n"
    "          targetId: id,\n"
    "        });\n"
    "        stepUpTokenId = evidence.tokenId;\n"
    "      } catch (e) {\n"
    "        if (e instanceof StepUpError) throw GroupError.fromStepUp(e);\n"
    "        throw e;\n"
    "      }\n"
)
APPOINTEE_CHECK = "      await this.requireEligibleManagerAppointee(client, id, accountPrincipalId);\n"

# (id, control, what it reintroduces, [(file, anchor, replacement), ...], the exact set of tests that must fail)
CONTROLS = [
    # ── LC-C3: the route register ──
    ('R1', 'LC-C3', 'the managers POST rule is moved after the /groups rules, so the root rule answers the owner first',
     [(SCOPES, MANAGERS_POST, ''), (SCOPES, GROUPS_ROOT, GROUPS_ROOT + MANAGERS_POST)],
     {R_POST_CEILING, R_MANAGERS_ORDER, A_OK, A_BEARER, A_NOT_OWNER, A_INERT, A_NONMEMBER, A_ALREADY, A_INELIGIBLE,
      A_ROLE_KEY, A_TOKENS, A_SURVIVES, A_ORDER, A_UPPER, W_OWNER, PROMOTE, A_RACE}),
    ('R2', 'LC-C3', 'the task steward rule is moved after the /tasks family rules (CC-8: it is then never the rule that answers)',
     [(SCOPES, TASK_RULE, ''), (SCOPES, TASKS_WRITE, TASKS_WRITE + TASK_RULE)],
     {R_TASK_ORDER}),
    ('R3', 'C.7', "the project steward route's ceiling is widened to projects:admin: the gate goes through the admin verb",
     [(SCOPES, PROJECT_RULE, PROJECT_RULE.replace("scope: 'projects:write'", "scope: 'projects:admin'"))],
     {R_PROJECT_CEILING, R_PROJECT_ORDER, O_PROJECT, O_NONMEMBER, O_NOT_OWNER, O_SHAPES, O_BEARER, O_TOKENS,
      O_REVISION, O_ADMIN_ROUTE, O_NOT_ADMIN, I_PROJECT, I_NOT_CURRENT, I_MANAGER, I_DISABLED, O_AUDIT_PROJECT}),
    # ── C.4: gate (iii) ──
    ('A1', 'C.4', 'the step-up is consumed before the appointee check (step 5 before step 4)',
     [(STEWARDS, APPOINTEE_CHECK + APPOINT_CONSUME, APPOINT_CONSUME + APPOINTEE_CHECK)],
     {A_ORDER, A_INELIGIBLE, R_APPOINT_ORDER}),
    ('A2', 'C.4', 'the appointee need not be an active member: an outsider becomes a manager',
     [(STEWARDS, "    if (member.rows.length === 0) {\n      throw err(422, 'MANAGER_NOT_A_GROUP_MEMBER',",
       "    if (member.rows.length < 0) {\n      throw err(422, 'MANAGER_NOT_A_GROUP_MEMBER',")],
     {A_NONMEMBER, A_SURVIVES, A_ORDER}),
    ('A3', 'C.4', 'the appointment writes an OWNER row: an owner appoints an owner',
     [(STEWARDS, "VALUES ($1, $2, 'manager', $3)`,", "VALUES ($1, $2, 'owner', $3)`,")],
     {A_OK, A_INELIGIBLE, A_UPPER, W_OWNER, R_APPOINT_ORDER, R_APPOINT_CODES, A_RACE}),
    ('A4', 'C.4', 'the appointment consumes a step-up bound to the REMOVAL act',
     [(STEWARDS, "          action: GROUP_MANAGER_APPOINT_ACT,\n          targetId: id,\n",
       "          action: GROUP_MANAGER_REMOVE_ACT,\n          targetId: id,\n")],
     {A_OK, A_INERT, A_INELIGIBLE, A_TOKENS, A_SURVIVES, A_UPPER, W_OWNER, PROMOTE, R_APPOINT_ORDER, A_RACE}),
    ('A5', 'C.4', 'the holder rules are skipped at appointment: a legacy member is appointed (the trigger still refuses an operator)',
     [(STEWARDS, "    const reason = stewardIneligibility(member.rows[0]);\n    if (reason) {\n      throw err(422, 'STEWARD_INELIGIBLE',",
       "    const reason = stewardIneligibility(member.rows[0]);\n    if (reason && reason !== 'legacy') {\n      throw err(422, 'STEWARD_INELIGIBLE',")],
     {A_INELIGIBLE}),
    ('A6', 'C.3', 'a concurrent appointment that meets the primary key answers a raw database error (500), not ALREADY_A_STEWARD',
     [(STEWARDS, "      if (raced) throw raced;\n", "      if (raced && raced.status < 0) throw raced;\n")],
     {A_RACE}),
    ('U1', 'C.2', "the appointee's member row is read without FOR SHARE: a concurrent removal slips in",
     [(STEWARDS, "        FOR SHARE OF appointee_member, appointee`,", "`,")],
     {U_APPOINT, R_APPOINTEE}),
    # ── C.5: gate (i) ──
    ('C1', 'C.5', "a manager row satisfies the Charter gate (the owner-only arm reads both roles)",
     [(CHARTER, "    liveStewardRows({ group: '$1', account: '$2', roles: \"ARRAY['owner']::text[]\", lock: true }),\n    [owner.id, actorId],",
       "    liveStewardRows({ group: '$1', account: '$2', roles: \"ARRAY['owner', 'manager']::text[]\", lock: true }),\n    [owner.id, actorId],")],
     {C_MANAGER, R_CHARTER_ARM, C_AUDIT_ARM}),
    ('C2', 'C.5', 'a DISABLED owning Group still admits its owners to the Charter gate',
     [(CHARTER, "  if (!owner || owner.kind !== 'group' || owner.status !== 'active') throw refuse();",
       "  if (!owner || owner.kind !== 'group') throw refuse();")],
     {C_DISABLED, R_CHARTER_ARM, C_AUDIT_ARM}),
    ('C3', 'C.5', 'the Group-owner arm approves without consuming a step-up',
     [(CHARTER, "    const evidence = await stepUpService.consume(executor, {\n      token: stepUpToken ?? '',",
       "    const evidence = await Promise.resolve({ tokenId: 'none', method: 'none' }) ?? await stepUpService.consume(executor, {\n      token: stepUpToken ?? '',")],
     {C_OK, C_TOKENS}),
    ('C4', 'C.5', 'the approve route drops the stepUpToken key from its body allowlist',
     [(PROJECT_ROUTES, "    const allowed = ['content', 'stepUpToken'];\n", "    const allowed = ['content'];\n")],
     {C_OK, C_TOKENS, C_MANAGER, C_INERT, C_DISABLED, PROMOTE, R_CHARTER_ROUTE, C_AUDIT_ARM, C_AUDIT_AFTER}),
    ('C5', 'C.5', 'the Group-owner arm runs BEFORE the administrator test: an administrator then needs a step-up on a Group-owned Project',
     [(CHARTER, "  if (administrator) return null;\n  return await charterGroupOwnerArm(",
       "  if (administrator && owners.rows.length < 0) return null;\n  return await charterGroupOwnerArm(")],
     {C_ADMIN}),
    ('C6', 'C.5', "the arm's CHARTER_APPROVAL_FORBIDDEN drops its audit fields: the denied row names no refusal",
     [(CHARTER, "    if (owner?.kind !== 'group') return base;\n", "    if (owner?.kind !== 'group' || base.status > 0) return base;\n")],
     {C_AUDIT_ARM}),
    ('C7', 'C.5', "a refusal after the arm admitted is recorded without the arm's refusal and standing",
     [(CHARTER, "      if (e instanceof CharterError && !e.auditMetadata && groupOwner) {\n",
       "      if (e instanceof CharterError && !e.auditMetadata && groupOwner && e.status < 0) {\n")],
     {C_AUDIT_AFTER}),
    # ── C.6: gate (ii) and DD-5 ──
    ('T1', 'C.6', 'the OUT shape skips the membership test: a non-member becomes the owner',
     [(TRANSFER, "    if (member.rows.length === 0) {\n      return refuse(input, 422, 'TARGET_NOT_A_GROUP_MEMBER',",
       "    if (member.rows.length < 0) {\n      return refuse(input, 422, 'TARGET_NOT_A_GROUP_MEMBER',")],
     {O_NONMEMBER}),
    ('T2', 'C.6', 'a manager row is a transfer standing (the owner-only standing reads both roles)',
     [(TRANSFER, "    liveStewardRows({ group: '$1', account: '$2', roles: \"ARRAY['owner']::text[]\", lock: true }),\n    [groupId, callerId],",
       "    liveStewardRows({ group: '$1', account: '$2', roles: \"ARRAY['owner', 'manager']::text[]\", lock: true }),\n    [groupId, callerId],")],
     {O_NOT_OWNER, I_MANAGER, R_SHAPES}),
    ('T3', 'C.6', 'DD-5 skips the current-owner test: anyone who can write the object moves it into their Group',
     [(TRANSFER, "    if (!input.currentOwnerId || input.currentOwnerId.toLowerCase() !== callerId.toLowerCase()) {",
       "    if (!input.currentOwnerId || input.currentOwnerId.length < 0) {")],
     {I_NOT_CURRENT}),
    ('T4', 'C.6', 'a DISABLED source Group still admits its owners to move its objects out',
     [(TRANSFER, "    if (current.status !== 'active' || !(await liveOwner(groupId))) return notOwner(kinds);",
       "    if (!(await liveOwner(groupId))) return notOwner(kinds);")],
     {O_NOT_OWNER}),
    ('T5', 'LC-C5', 'the steward transfers skip the login-session test: a bearer reaches the standing',
     [(TRANSFER, "  if (!isLoginSessionKind(input.caller.authMethod)) {\n    return refuse(input, 403, GROUP_OWNER_SESSION_ONLY,",
       "  if (!isLoginSessionKind(input.caller.authMethod) && input.objectId.length < 0) {\n    return refuse(input, 403, GROUP_OWNER_SESSION_ONLY,")],
     {O_BEARER, SEAM_TRANSFER}),
    ('T6', 'C.6', 'the project act spends the step-up before the If-Match revision check',
     [(PROJECT_ACT,
       "      if (!revision) throw new ResourceContractError(400, 'REVISION_REQUIRED', 'The last observed Project revision is required');\n"
       "      if (revision !== project.revision) {\n"
       "        throw new ResourceContractError(412, 'REVISION_MISMATCH', 'The Project changed; reload and retry');\n"
       "      }\n"
       "      const evidence = await consumeStewardTransferStepUp(client, input, standing, actor.stepUpToken);\n",
       "      const evidence = await consumeStewardTransferStepUp(client, input, standing, actor.stepUpToken);\n"
       "      if (!revision) throw new ResourceContractError(400, 'REVISION_REQUIRED', 'The last observed Project revision is required');\n"
       "      if (revision !== project.revision) {\n"
       "        throw new ResourceContractError(412, 'REVISION_MISMATCH', 'The Project changed; reload and retry');\n"
       "      }\n")],
     {R_REVISION}),
    ('T7', 'C.6', 'the step-up target is a constant, not the object: one token moves any object',
     [(TRANSFER, "      action: OWNERSHIP_TRANSFER_STEP_UP_ACTION,\n      targetId: input.objectId,\n",
       "      action: OWNERSHIP_TRANSFER_STEP_UP_ACTION,\n      targetId: standing.groupId,\n")],
     {O_PROJECT, O_TASK, O_NOT_ADMIN, O_ADMIN_ROUTE, I_PROJECT, I_TASK, O_TOKENS, R_SHAPES}),
    ('U2', 'C.2', "the OUT target's member row is read without FOR SHARE: a concurrent removal slips in",
     [(TRANSFER, "        FOR SHARE OF target_member`,", "`,")],
     {U_OUT}),
    ('T8', 'C.7', 'the steward standing asks the admin verb of the Project (a second, administrator path)',
     [(TRANSFER, "  if (!authorizationService.authorizeRoute(sessionActor, input.writeScope).allowed\n",
       "  if (!authorizationService.authorizeRoute(sessionActor, input.writeScope.replace('write', 'admin') as 'projects:write').allowed\n")],
     {O_PROJECT, O_TASK, O_NONMEMBER, O_SHAPES, O_NOT_ADMIN, O_ADMIN_ROUTE, O_TOKENS, O_REVISION, I_PROJECT, I_TASK,
      I_NOT_CURRENT, I_DISABLED, U_OUT, R_ADMIN_VERB, O_AUDIT_PROJECT, O_AUDIT_TASK}),
    ('T9', 'C.6', "the project act's catch no longer audits its refusals: only the route's own are recorded",
     [(PROJECT_ACT, "      if (!committed) await auditStewardTransferRefusal(refusal, error);\n",
       "      if (!committed && refusal.objectId.length < 0) await auditStewardTransferRefusal(refusal, error);\n")],
     {O_AUDIT_PROJECT, O_NONMEMBER, O_NOT_OWNER, O_BEARER}),
    ('T10', 'C.6', "the task act's catch no longer audits its refusals (the person-target and state checks go unrecorded)",
     [(TASK_ACT, "      await auditStewardTransferRefusal(refusal, error);\n      throw error;\n    } finally { client.release(); }",
       "      if (refusal.objectId.length < 0) await auditStewardTransferRefusal(refusal, error);\n      throw error;\n    } finally { client.release(); }")],
     {O_AUDIT_TASK}),
    ('T11', 'C.6', "the project route's query and body refusals are answered but never recorded",
     [(PROJECT_ROUTES, "    await recordStewardTransferRefusal({\n      objectType: 'project',",
       "    if (req.params.id.length < 0) await recordStewardTransferRefusal({\n      objectType: 'project',")],
     {O_AUDIT_PROJECT}),
    # ── C.8: the manager lens ──
    ('L1', 'C.8', 'the lens reads raw steward rows, not the live fragment: an inert row gives the arm',
     [(STEWARDS, "         FROM (${liveStewardRows({ group: null, account: '$1', roles: \"ARRAY['owner', 'manager']::text[]\" })}) live\n",
       "         FROM (SELECT steward_row.group_id, steward_row.role FROM group_stewards steward_row WHERE steward_row.account_principal_id = $1) live\n")],
     {L_INERT, PROMOTE, R_LENS_FRAGMENT, PROMOTE_ROOT}),
    ('L2', 'A-L53', 'the payload ships the manager arm EMPTY for a caller with no live row',
     [(LENSES, "  if (stewardedGroups.length > 0) return { lenses, admin, manager: { stewardedGroups } };\n",
       "  if (stewardedGroups.length >= 0) return { lenses, admin, manager: { stewardedGroups } };\n")],
     {L_REMOVE, L_ADMIN, L_INERT, L_PLAIN, PROMOTE, U_NO_MANAGER, U_MEMBER, U_ADMIN, U_NO_ROOT, U_KIND, PROMOTE_ROOT}),
    ('L3', 'A-L51', "the arm is derived from the caller's admin standing as well as the rows",
     [(LENSES, "  if (stewardedGroups.length > 0) {\n    lenses.push('manager');\n",
       "  if (stewardedGroups.length > 0 || admin) {\n    lenses.push('manager');\n")],
     {L_ADMIN, U_NO_MANAGER, U_ADMIN, U_KIND, R_LENS_ROUTE, PROMOTE_ROOT}),
    ('L4', 'A-L51', 'the stewarded Groups lose their owners-first order',
     [(STEWARDS, "        ORDER BY CASE live.role WHEN 'owner' THEN 0 ELSE 1 END, lower(stewarded.name), stewarded.id`,",
       "        ORDER BY lower(stewarded.name), stewarded.id`,")],
     {L_ARM, R_LENS_FRAGMENT}),
    ('L5', 'A-L51', 'the memberCount counts disabled members too',
     [(STEWARDS, "                 JOIN principals counted_member ON counted_member.id = counted.account_principal_id\n                  AND counted_member.status = 'active'\n",
       "                 JOIN principals counted_member ON counted_member.id = counted.account_principal_id\n")],
     {L_ARM}),
    # ── drill 3: promotion by an admin session ──
    ('L6', 'C.2', 'the fragment counts only operator as elevated: a holder promoted to admin or orchestrator keeps a live owner row',
     [(FRAGMENT, "steward_holder.role NOT IN (${elevatedRoleSqlList()})", "steward_holder.role NOT IN ('operator')")],
     {PROMOTE_ROOT}),
]

IGNORED = ('.git', 'graphify-out', 'node_modules', 'dist', 'coverage', '__pycache__', '.pytest_cache')


def once(text, anchor, replacement):
    count = text.count(anchor)
    if count != 1:
        raise SystemExit(f'anchor matched {count} times, expected 1: {anchor[:100]!r}')
    return text.replace(anchor, replacement, 1)


def apply(edits, read):
    """Apply a control's edits to the texts `read` returns; answers {path: new text}."""
    texts = {}
    for path, anchor, replacement in edits:
        texts[path] = once(texts.get(path, read(path)), anchor, replacement)
    return texts


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

    for control in CONTROLS:
        apply(control[3], lambda path: (ROOT / path).read_text())
    ids = [c[0] for c in CONTROLS]
    sets = [frozenset(c[4]) for c in CONTROLS]
    if len(set(ids)) != len(ids):
        raise SystemExit('two controls share an id')
    if len(set(sets)) != len(sets) or any(not s for s in sets):
        raise SystemExit('every control must declare a non-empty must-fail set that no other control shares')
    for name in ('LC-C3', 'LC-C5', 'C.2', 'C.4', 'C.5', 'C.6', 'C.7', 'C.8', 'A-L51', 'A-L53'):
        if not any(c[1] == name for c in CONTROLS):
            raise SystemExit(f'control {name} has no red mutation')
    selected = CONTROLS
    if args.only:
        wanted = set(args.only.split(','))
        unknown = wanted - set(ids)
        if unknown:
            raise SystemExit(f'unknown control ids: {sorted(unknown)}')
        selected = [c for c in CONTROLS if c[0] in wanted]
    if args.describe:
        print(json.dumps([{'id': c[0], 'control': c[1], 'reintroduces': c[2], 'files': sorted({e[0] for e in c[3]}),
                           'mustFail': sorted(c[4])} for c in selected], indent=2))
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
    copy = Path(tempfile.mkdtemp(prefix='lenses-gates-drill-'))
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
            if not set(control[4]) <= set(titles):
                raise SystemExit(f'{control[0]}: a declared test is absent from the suites: {sorted(set(control[4]) - set(titles))}')
        print(f'baseline green: {len(titles)} tests', flush=True)

        for control_id, control, reintroduces, edits, must_fail in selected:
            originals = {path: (copy / path).read_text() for path in {e[0] for e in edits}}
            for path, text in apply(edits, lambda p: originals[p]).items():
                (copy / path).write_text(text)
            try:
                code, tests, suite_messages = run_suites(copy, out, f'control-{control_id}')
            finally:
                for path, text in originals.items():
                    (copy / path).write_text(text)
            failed = {t['title'] for t in tests if t['status'] == 'failed'}
            messages = re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(
                m for t in tests if t['status'] == 'failed' for m in t.get('failureMessages', [])))
            semantic = code != 0 and sorted(t['title'] for t in tests) == sorted(titles) and failed == set(must_fail) \
                and all('expect(' in '\n'.join(t.get('failureMessages', [])) for t in tests if t['status'] == 'failed') \
                and not re.search(r'TS\d{4}|SyntaxError|Test suite failed to run|Exceeded timeout|ECONNREFUSED',
                                  messages + suite_messages)
            receipts.append({'control': control_id, 'controlName': control, 'reintroduces': reintroduces,
                             'files': sorted(originals), 'mustFail': sorted(must_fail), 'failed': sorted(failed),
                             'red': semantic})
            (out / 'receipts.json').write_text(json.dumps(receipts, indent=2))
            print(f"{'RED ' if semantic else 'MISS'} {control_id} [{control}] {reintroduces} -> {len(failed)} failed", flush=True)
            if not semantic:
                print(f'   expected {sorted(must_fail)}\n   failed   {sorted(failed)}', flush=True)

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
