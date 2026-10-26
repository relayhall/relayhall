#!/usr/bin/env python3
"""Mutation drill for AUTHZ amendment AZ-A13, edit in place (card 1a38270d,
stage 2).

Each control below edits ONE literal anchor in a disposable copy of the tree,
runs its suite and requires the suite to go red at EXACTLY the predeclared set
of tests, for an assertion (not a compile error, a timeout or a crashed
fixture). No two controls of a suite share a set, so no two controls can be
satisfied by one assertion. The source tree is never edited: its bytes are
fingerprinted before and after.

  --suite live (the default)  backend/src/__tests__/authorityEditLive.test.ts,
      against a REAL disposable PostgreSQL through the production router and the
      MCP ingress. The controls withdraw, one at a time, what the amendment's
      clauses say must hold: the server-side direction (R-1), the edit audit
      (R-2), the session-only edit route (R-3), the secret kept out of every
      record (R-4), the graced predecessor (9f), the owning Account's own-access
      cap (4b, E94), the Account cap with its root sentinel and the own() cap
      (8a), the transport standing (9d), the step-up binding (D-10a), the stale
      check (6e), the decider's narrowing (6d), the lifetime (6j: required, the
      terminal revert, only-what-it-added, the date sweep, the acknowledged
      warrant revert, the labels), the narrow-all act (9h: intersect, revoke,
      one transaction), the warrant validators (8b, 10c, 10d, O-1), the grant
      rules (11c, 11d, 11e, 11f), the agent's door (6c), the decider standing
      (AZ-A9 clause 6), collect and decide by kind (clause 7 P-4), the
      terminal's reference reading (6a), the AZ-31c exclusion of an approved
      edit, per-agent revoke (N-1) and the one credential policy (drill 8);
      and, from review round 1, the revert field by field (B1: the door's
      revertibility check, the ceiling's residual and direction check, a
      residual that never discards the rest nor closes the record, the
      selector, transport, emptied-set, scope-ceiling and unpinned-ceiling
      shapes) and the warrant route's own audited refusals (B2: standing,
      WARRANT_AUTHORITY_IMMUTABLE, a missing id).
  --suite census  backend/src/__tests__/authorityEditCensus.test.ts (no
      database): the writer register (C-1), the reader register (C-2) and the
      method-specific MCP ban (clause 15b).
  --suite credential  backend/src/__tests__/accessRequestsCredentialLive.test.ts
      with drill 8's ONE mutation in PrincipalService.assertCredentialPolicy,
      proving the issuance kind and the edit share one policy (clause 7, E73).
  --suite followups  backend/src/__tests__/authorityEditFollowupsLive.test.ts,
      the owner rulings of 12 Oct 2026 against the same disposable database:
      E148 (the residual a revert keeps is named: by field, on the ceiling,
      on the scope ceiling, with a true closing reason, in the revert audit
      row and in the closing record) and E149 (an edit never adds
      knowledge-contents:write to an Agent credential: the session door, the
      decide path, the rule itself, the agent door, and the scope set).

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \\
    python3 scripts/authority-edit-mutations.py [--suite census|credential|followups] --output-dir /tmp/authority-edit-drill
  python3 scripts/authority-edit-mutations.py [--suite ...] --describe   # checks every anchor, no database
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
LIVE_SUITE = 'src/__tests__/authorityEditLive.test.ts'
CENSUS_SUITE = 'src/__tests__/authorityEditCensus.test.ts'
CREDENTIAL_SUITE = 'src/__tests__/accessRequestsCredentialLive.test.ts'
FOLLOWUPS_SUITE = 'src/__tests__/authorityEditFollowupsLive.test.ts'
EXECUTOR = 'backend/src/services/AuthorityEditExecutor.ts'
APPROVAL = 'backend/src/services/ApprovalService.ts'
PRINCIPAL = 'backend/src/services/PrincipalService.ts'
ROUTE = 'backend/src/routes/authorityEditRoute.ts'
CREDENTIALS = 'backend/src/routes/credentials.ts'
TERMINAL = 'backend/src/utils/accessRequestTerminal.ts'
INVALIDATION = 'backend/src/utils/approvalInvalidation.ts'
DECIDERS = 'backend/src/services/ApprovalHubService.ts'
LIFECYCLE = 'backend/src/services/CredentialLifecycleService.ts'
REGISTRY = 'backend/src/mcp/registry.ts'
WARRANTS = 'backend/src/routes/warrants.ts'

# The live suite's tests, by title (assertionResults[].title).
M1 = 'M-1: the kind CHECK admits authority-edit, and the shape refuses an edit row with both bindings, with neither, or with a requested expiry'
E95 = ('drill 1 / E95 acceptance: root adds phases:read and phases:write in place with step-up; the SAME token then creates a phase '
       'through MCP; the id, key_id, secret and Main appointment are unchanged')
R2C = ('R-2 (credential): a narrowing by the owning Account saves at once with ONE audit row carrying before, after and the chain, '
       'and the next call with the same token is refused the removed scope')
F9 = 'clause 9f: a narrowing revokes the graced predecessor in the same transaction; a widening leaves it alone'
R1A = ('R-1 (a): a root widening with no step-up, or one bound to another act or object, is STEP_UP_REQUIRED; the row is unchanged '
       'and no Approval exists')
R1B_IN = ('R-1 (b), E94: the owning editor Account widens WITHIN its own access with step-up: applied at once, deciderStanding '
          'owning-account, an approved authority-edit, no pending item')
R1B_OUT = ('R-1 (b), E94: beyond its own access the owning Account is refused EXCEEDS_ACCOUNT_AUTHORITY: the row unchanged, no '
           'Approval filed, and without a step-up STEP_UP_REQUIRED')
D2 = ('drill 2: transport - root loosens mcp to any with step-up and REST works; the owner tightens any to mcp and REST is '
      'TRANSPORT_MISMATCH; the owner loosening is AUTHORITY_EDIT_REQUIRES_ADMINISTRATOR; mcp to api is a widening')
D3A = ('drill 3a: the Account cap and the root sentinel - *:admin under an editor Account is EXCEEDS_ACCOUNT_AUTHORITY, while a '
       'widening under an admin Account passes the Account cap')
D3B = 'drill 3b: EXCEEDS_CONNECTOR_OWN when the Connector own() is a list, and ROOT_NOT_MINTABLE from the one credential policy'
E9 = ('clause 9e: an Agent, an OAuth, a legacy and a revoked credential are refused by name, and EDIT_FIELD_NOT_EDITABLE and '
      'EDIT_NO_CHANGE')
D7 = ('drill 7, D-10/D-10a: an operator narrows and widens a FOREIGN Connector (a credential.edit token serves, an approval.decide '
      'token does not); an editor session on a foreign Connector is refused')
R3 = ('R-3: a Connector calling for itself gets 403 SESSION_ONLY on PATCH /credentials, /warrants and /approvals/approve, and the '
      '/grants ceiling; rows unchanged; a durable denied audit each')
R1C = 'R-1 (c): an agent files addScopes: pending, the row unchanged, and its next MCP call is still refused naming the scope'
C6 = ('clause 6c: the filing refusals by name - an Agent, a warrant or grant object, another credential, a transport, root, '
      '*:admin, ALREADY_HELD, EDIT_PENDING')
R1D = 'R-1 (d): a non-administrator owner deciding is APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR without spending its step-up'
D1A = ("drill 1 (agent door): the owner approves by deep link with step-up and keep; the same Connector's next call creates a "
       'phase; one approved row, edit_approved recorded')
R1E = 'R-1 (e): the object changed between filing and decide: EDIT_STALE, the request lapsed TARGET_CHANGED, nothing applied'
R1F = 'R-1 (f): approving a subset applies only that subset; approving more than requested is EDIT_ONLY_NARROWS'
L4 = ('L-4: an approve without a lifetime, or until-task with neither a task nor a future date, is EDIT_LIFETIME_REQUIRED and '
      'applies nothing')
HUB_STEPUP = 'hub defect: a refused 422 decision leaves the same step-up available for a corrected approval'
N14 = 'N14: a direct human one-act widening is visible but does not use filed-request quota'
D6 = ('drill 6: GET /approvals?kind=authority-edit lists it; the item view carries the diff and the decider context; the shared '
      'quota; a rotation lapses the pending request')
L1 = 'L-1: "keep" stands after the related task completes'
A6 = 'clause 6a: a PENDING edit request is not lapsed when its related task ends - the related task is a reference only'
L2 = ('L-2: "until this task ends": completing the related task reverts ONLY what the widening added; a later narrowing is '
      'preserved; live Agents are not narrowed by the revert')
L2B = 'L-2: archiving the related task reverts too, and a hard delete of the task reverts before the record is detached'
L3 = 'L-3: a revert at its date, by the sweep'
# Card 0e07c0c7: the hub's lifetime options on a filed request, one live case
# per option. Each one catches the controls whose rule it reads (re-declared
# from a discovery run on the slice's head: every other red set unchanged).
L7_SHORTEST = ('card 0e07c0c7 L-7 shortest (a date, no related task): the request records edit_revert_at; the sweep removes '
               'exactly the added scope at that instant, audited, once')
L7_MIDDLE = ('card 0e07c0c7 L-7 middle (the related task, no date): the request records the task and no date; the task '
             'terminal reverts it')
L7_KEEP = 'card 0e07c0c7 L-7 keep: "Keep (until narrowed)" records keep with no date, and no sweep reverts it'
L5 = 'L-5: a warrant-ceiling revert while tasks ride the warrant waits, shown as due, until a person acknowledges it'
L6 = 'L-6: every authority-edit item the API returns names the object kind and, once decided, the lifetime chosen'
N1 = 'N-1: per-agent Revoke still works'
N2 = ('N-2: the narrow-all act intersects each live Agent in the same transaction, one audit row per Agent, and an empty '
      'intersection REVOKES that Agent')
N3 = "N-3: a narrowed Agent's next call is refused naming the removed scope"
N4 = 'N-4: a failed Agent write rolls the whole narrowing back'
R2W = ('R-2 (warrant): the owning Account narrows the caps: one audit row and one warrant.amended event; the next mint above the '
       'new cap is WARRANT_CAP_EXHAUSTED')
W10B = ('clause 10b: a root widening given as ceilingRules publishes a NEW profile and pins it; the old version is unchanged; '
        'republishing the old profile does not widen the warrant')
W10C = ('clause 10c / Q2: a ceiling edit while tasks ride is WARRANT_HAS_DEPENDENT_TASKS without acknowledgement, and releases '
        'them with it')
W10D = ('clause 10d: a suspended warrant may be edited and stays suspended; a revoked one is WARRANT_NOT_EDITABLE; holder, '
        'anchors, agentMaxAgeHours and status stay WARRANT_AUTHORITY_IMMUTABLE')
W8B = "clause 8b: a widening above a non-administrator creator's authority is CEILING_EXCEEDS_CREATOR"
O1 = ("O-1: a Group member gives its agent's warrant a project it reaches through the Group (allowed, with step-up) and one it "
      'cannot reach (EXCEEDS_ACCOUNT_AUTHORITY)')
R2G = 'R-2 (grant): root narrows write to read at once; the row keeps its id; the next write through it is refused'
G11F = 'clause 11b/11f: a grant widening needs a step-up bound to grant.edit; moving the selector emits acl_changed for both objects'
G11E = 'clause 11e: GRANT_EXISTS names the live twin, and an expired identical row is replaced in the same act'
G11C = 'clause 11c: an assignment-carried row and a creation-default row are refused by name'
G11D = ("clause 11d: an approval-made row keeps an expiry capped at 90 days, and is still revoked at its task's terminal; an "
        'operator is refused at the root ceiling; the surface closure re-applies')
# Review 1a38270d round 1: B1 (clause 6j, the revert field by field) and B2
# (clause 13, the warrant route's own refusals audited).
B1A = ('clause 6j (r1 B1 a): a warrant ceiling moved to one not comparable with the old, with maxTotal 5 -> 10, is refused '
       '"until this task ends" EDIT_LIFETIME_REQUIRED naming the ceiling, nothing applied and the step-up unspent; keep applies it')
B1AR = ('clause 6j (r1 B1 a, at the revert): a record whose widening moved the ceiling A -> B and maxTotal 5 -> 10 takes maxTotal '
        'back at the task terminal, keeps B, and stays due and visible; a revoke then closes it')
B1B = ('clause 6j (r1 B1 b): a grant selector moved X -> Y is refused "until this task ends" EDIT_LIFETIME_REQUIRED naming '
       'resourceId, nothing applied; keep moves it')
B1C = ('clause 6j (r1 B1 c): a credential transport moved mcp -> api is refused "until this task ends" EDIT_LIFETIME_REQUIRED '
       'naming transport, nothing applied; mcp -> any until the task ends comes back to mcp')
B1D = ('clause 6j (r1 B1 d): added scopes a later narrowing left alone in the set stay, and the record stays due and visible at '
       'the terminal, until a person takes them away; an edit replacing the whole set is refused "until this task ends"')
B1PF = ('clause 6j (r1 B1, per field): a widening that narrows the ceiling and raises maxTotal, until the task ends, takes '
        'maxTotal back at the terminal and leaves the narrower ceiling; the record is reverted')
B1SC = ('clause 6j (r1 B1, scope ceiling): the scopes a warrant widening added to its scope ceiling are removed at the terminal, '
        '[tasks:read, projects:read] -> [tasks:read, phases:read] coming back to [tasks:read]')
B1UP = ('clause 6j (r1 B1, unpinned ceiling): a warrant ceiling with no pinned version is unrepresentable (migration 100), and a '
        'revert plan over a record naming none keeps the ceiling as a residual while maxTotal goes back')
B2I = ("clause 13 (r1 B2 i): a stranger's narrowing, and its widening carrying a valid warrant.edit step-up, on PATCH "
       '/warrants/:id are answered 404 and each writes a denied warrant.edit row with the chain; the step-up is unspent')
B2II = ('clause 13 (r1 B2 ii): WARRANT_AUTHORITY_IMMUTABLE carries rule, subject and clause and writes a denied warrant.edit '
        "row with the chain; a stranger's attempt is answered 404 and audited too")
B2NF = 'clause 13 (r1 B2): an edit of a warrant id that does not exist is answered 404 and writes a denied warrant.edit row'
R4 = ('R-4: no token and no secret suffix in any audit, approval or warrant event metadata, any approvals JSON column, the server '
      'log or an edit response; an edited credential reveals the same token')

# The census suite's tests, by title.
C1_REGISTER = 'writer register: services/CredentialLifecycleService.ts is classified line by line'
C1_SEMANTIC = 'no UPDATE outside the executor writes an edited column, and the executor is the only AUTHORITY_EDIT writer'
C1_OTHER = 'every UPDATE_OTHER really writes no edited column (the SET clause is read)'
C2_NO_CACHE = 'the bearer auth path selects the credential row on every call and names no cache'
MCP_BAN = 'the MCP registry composes no PATCH on an authority object, and no /grants, /warrants or /credentials/:id path but reveal and revoke'
# The credential-request suite's test that issues an mcp-pinned credential.
CREDENTIAL_MCP = 'file \u2192 status \u2192 (approved by root) \u2192 collect returns the credential once; withdraw lapses another'

# The follow-ups suite's tests (owner rulings E148 and E149), by title. Its two
# unchanged-case tests are declared by no control: every control must leave
# them green.
FU_TRANSPORT = ('E148 transport: root widens a credential mcp -> any with phases:read until the task ends; its owning Account '
                'narrows the pin to api; at the end phases:read is removed, api is KEPT (REST works, MCP is refused), and the '
                'revert audit row and the closing record name the residual')
FU_PIN = ('E148 pin: root widens a warrant transport pin mcp -> any until the task ends; its owning Account narrows it to api; at '
          'the end api is KEPT (the next Agent is minted api-pinned) and the closing record names the residual with a true reason')
FU_SELECTOR = ('E148 selector: root widens a grant from one task to every task until the task ends, then narrows it to another '
               'task; at the end that task is KEPT, still readable through the grant, and the closing record names the residual '
               'with a true reason')
FU_OTHER = ('E148 every other field: a warrant widened on its ceiling, maxTotal and maxConcurrent until the task ends, then '
            'narrowed on the ceiling and maxTotal to values still above the ones before; at the end maxConcurrent goes back, the '
            'ceiling and maxTotal are KEPT, and the revert audit row and the closing record name both')
FU_CAP = ('E148 scope ceiling: a warrant scope cap lifted until the task ends and then capped above the one before, and a cap '
          'widened until the task ends and then lifted by a later edit, are each KEPT and named with a true reason')
FU_SESSION = ('E149 session door: root, an administrator and the owning Account adding knowledge-contents:write to an Agent '
              'credential are each refused AGENT_SCOPE_MINT_ONLY with a durable denied credential.edit row, the row unchanged, '
              'the step-up unspent and no Approval; an Agent whose mint requested it cannot get it back by edit once a narrowing '
              'removed it')
FU_DECIDE = ("E149 the decide path: a filed widening that names an Agent credential (the agent's door never files one; written "
             'directly) is refused AGENT_SCOPE_MINT_ONLY at decide, nothing applied, the request still pending, a denied '
             'approval.decide row')
FU_MCP = ('E149 the MCP twin: an Agent asking for knowledge-contents:write over relayhall_access_request, and over its REST route, '
          'is refused AGENT_SCOPE_MINT_ONLY each time with a denied approval.request row, and nothing is filed')

# What each control must turn red, exactly. Read from a discovery run
# (--discover) and declared here by hand: a strict run fails when a control's
# red set changes, so a declaration cannot drift from what the drill measures.
DECLARED = {
    'stage3': {
        'hub lifetime: validation refusal does not spend step-up': {HUB_STEPUP},
        'N14: a one-act widening is excluded from the quota preview': {N14},
    },
    'live': {
    'R-1 (clause 3): every edit is classified as narrowing': {B1A, B1AR, B1B, B1C, B1D, B1PF, B1SC, D2, D3A, D3B, D7, E95, F9, G11F, L2, L2B, L3, L4, L5, L6, L7_SHORTEST, O1, R1A, R1B_IN, R1B_OUT, W8B},
    'R-2 (clause 14): the edit writes no audit row': {B1AR, D1A, D7, L2, L7_SHORTEST, N2, O1, R1B_IN, R2C, R2G, R2W},
    'R-3 (clause 4c): PATCH /credentials/:id does not refuse a bearer caller': {R3},
    'R-4 (clause 14): a bearer refusal writes its Authorization header into the audit metadata': {R4},
    'clause 9f: a narrowing leaves the graced predecessor live': {F9},
    "clause 8a: the chain-root Account's role set does not cap a widening": {D3A},
    "clause 8a: the Connector's own() does not cap a widening": {D3B},
    'clause 9d: a non-administrator loosens a transport pin': {D2},
    'D-10a: the one-act door accepts a step-up bound to approval.decide': {B1A, B1AR, B1B, B1C, B1D, B1PF, B1SC, D2, D3A, D7, E95, F9, G11D, G11E, G11F, L2, L2B, L3, L5, L6, O1, R1A, R1B_IN, R4, W10B},
    'clause 6e: a stale request applies': {R1E},
    'clause 6d: the decider approves a scope never requested': {R1F},
    'clause 6j: a widening without a lifetime is kept': {L4},
    "clause 6j: the related task's terminal reverts nothing": {B1AR, B1C, B1PF, B1SC, L2, L2B, L7_MIDDLE},
    'clause 6j: a revert restores the state before instead of removing only what was added': {B1D, L2},
    'clause 6j: the sweep never reverts at a date': {L3, L7_SHORTEST},
    'clause 6j with 10c: a ceiling revert does not wait for riding tasks': {L5},
    'clause 6h: the item does not name the object kind in words': {D6, L6},
    'clause 9h (E113): an Agent whose intersection is empty is narrowed to nothing instead of revoked': {N2},
    'clause 9h: the narrow-all act is never run': {N2, N3, N4},
    'clause 9h: the narrow-all act writes the Agent scopes unchanged': {N2, N3},
    'N-4: a failed Agent write is swallowed and the narrowing commits': {N4},
    'clause 10c: a ceiling edit releases riding tasks without acknowledgement': {W10C},
    "clause 8b: a widening is not held within its creator's current authority": {W8B},
    'clause 8b (E94, O-1): the owning Account widens a warrant beyond its own reach': {O1},
    'clause 10d: a revoked warrant is edited': {B1AR, W10D},
    'clause 11e: an edited grant tuple equal to a live row overwrites it': {G11E},
    'clause 11c: an assignment-carried grant is edited': {G11C},
    'clause 11d (E15): an approval-made grant is extended past 90 days': {G11D},
    'clause 11f: acl_changed is emitted for the new object only': {G11F},
    'clause 6c: an agent files an edit of another credential': {C6},
    'AZ-A9 clause 6: a non-administrator owning Account decides an edit request': {R1D},
    'clause 7 P-4: collect refuses only a grant request': {D1A},
    'clause 7 P-4: an edit request is decided by the grant and credential arm': {D1A, L1, L4, L7_KEEP, L7_MIDDLE, L7_SHORTEST, R1E, R1F},
    "clause 6a: a pending edit request lapses at its related task's terminal": {A6},
    'clause 6f with AZ-31c: rotating the bound credential tries to lapse an approved edit': {L1},
    'N-1: a Connector cannot revoke the Agents it minted': {N1},
    'drill 8 (clause 7, E73): the one credential policy refuses an mcp pin': {B1C, D2, E95},
    'clause 4b (E94): the owning Account is not capped by the access it holds itself': {R1B_OUT},
    # Review 1a38270d round 1, B1 and B2.
    'clause 6j (r1 B1): the door accepts "until this task ends" for an edit its revert cannot narrow': {B1A, B1B, B1C, B1D},
    'clause 6j (r1 B1 a): a ceiling not comparable with the one before leaves no residual': {B1A, B1AR},
    'clause 6j (r1 B1, per field): the ceiling goes back without a direction check': {B1PF},
    'clause 6j (r1 B1 a): a residual discards the whole revert': {B1AR},
    'clause 6j (r1 B1): a record is closed as reverted while a residual remains': {B1AR, B1D},
    'clause 6j (r1 B1 b): a grant selector not comparable with the one before leaves no residual': {B1B},
    'clause 6j (r1 B1 c): a transport not comparable with the one before leaves no residual': {B1C},
    'clause 6j (r1 B1 d): a removal that empties a scope set leaves no residual': {B1D},
    'clause 6j (r1 B1, scope ceiling): the scopes a warrant widening added to its scope ceiling stay': {B1SC},
    'clause 6j (r1 B1, unpinned ceiling): a ceiling with no version pinned before leaves no residual': {B1UP},
    'clause 13 (r1 B2 i): a warrant edit refused for standing writes no audit row': {B2I},
    'clause 13 (r1 B2 ii): WARRANT_AUTHORITY_IMMUTABLE writes no audit row': {B2II},
    'clause 13 (r1 B2): an edit of a missing warrant writes no audit row': {B2NF},
    },
    'census': {
        'C-1: an unregistered UPDATE writes a credential scope set': {C1_REGISTER, C1_SEMANTIC, C1_OTHER},
        'C-2: a cache in front of the bearer auth path': {C2_NO_CACHE},
        'clause 15b: the registry composes a PATCH on a credential': {MCP_BAN},
    },
    'credential': {
        'drill 8 (clause 7, E73): the one credential policy refuses an mcp pin': {CREDENTIAL_MCP},
    },
    'followups': {
        'E148: a field a later edit moved is never named as a residual': {FU_TRANSPORT, FU_PIN, FU_SELECTOR, FU_OTHER},
        'E148: a ceiling a later edit re-pinned is never named as a residual': {FU_OTHER},
        'E148: a scope ceiling a later edit capped or lifted is never named as a residual': {FU_CAP},
        'E148: the closing reason says nothing the widening added is still present while a residual is kept': {FU_PIN, FU_SELECTOR, FU_CAP},
        'E148: the revert audit row does not name the residual it keeps': {FU_TRANSPORT, FU_OTHER},
        'E148: the closing record does not name the residual it keeps': {FU_TRANSPORT, FU_PIN, FU_SELECTOR, FU_OTHER, FU_CAP},
        'E149: the session door reads no added scope': {FU_SESSION},
        'E149: the decide path reads no added scope': {FU_DECIDE},
        'E149: the edit target check never binds a mint-only scope': {FU_SESSION, FU_DECIDE},
        "E149: the agent's door never binds a mint-only scope": {FU_MCP},
        'E149: no scope is mint-only for an Agent': {FU_SESSION, FU_DECIDE, FU_MCP},
    },
}

# (name, file, anchor, replacement)
LIVE_CONTROLS = [
    ('R-1 (clause 3): every edit is classified as narrowing', EXECUTOR,
     "  return { direction: widening ? 'widening' : 'narrowing', changed, moves };",
     "  return { direction: widening && changed.length < 0 ? 'widening' : 'narrowing', changed, moves };"),
    ('R-2 (clause 14): the edit writes no audit row', EXECUTOR,
     """    const audit = await auditService.record({
      action: EDIT_STEP_UP_ACTIONS[object.type], actor, resourceType: object.type, resourceId: object.id,""",
     """    const audit = await (async (..._unwritten: unknown[]) => ({ id: '' }))({
      action: EDIT_STEP_UP_ACTIONS[object.type], actor, resourceType: object.type, resourceId: object.id,"""),
    ('R-3 (clause 4c): PATCH /credentials/:id does not refuse a bearer caller', CREDENTIALS,
     "  if (!(await requireEditSession(req, res, 'credential'))) return;\n",
     "  if (!req.principal?.id || !requireEditSession) return;\n"),
    ('R-4 (clause 14): a bearer refusal writes its Authorization header into the audit metadata', ROUTE,
     "        refusal: 'SESSION_ONLY', authMethod: req.authMethod ?? 'unknown', clause: 'AZ-A13 clause 4c',",
     "        refusal: 'SESSION_ONLY', authMethod: String(req.headers.authorization ?? req.authMethod), clause: 'AZ-A13 clause 4c',"),
    ('clause 9f: a narrowing leaves the graced predecessor live', EXECUTOR,
     "    if (input.classification.direction === 'narrowing' && object.type === 'credential') {",
     "    if (input.classification.direction === 'narrowing' && object.type === 'credential' && object.id.length < 0) {"),
    ("clause 4b (E94): the owning Account is not capped by the access it holds itself", EXECUTOR,
     "        const beyond = added.filter((scope) => !own.includes(scope)\n          || (!roleSet.includes('root') && !roleSet.includes(scope)));",
     "        const beyond = added.filter((scope) => scope.length < 0 && !own.includes(scope) && !roleSet.includes(scope));"),
    ("clause 8a: the chain-root Account's role set does not cap a widening", EXECUTOR,
     "      if (!accountScopes.includes('root')) {",
     "      if (!accountScopes.includes('root') && accountScopes.length < 0) {"),
    ("clause 8a: the Connector's own() does not cap a widening", EXECUTOR,
     "      if (!own || (own.scopes !== 'parent' && added.some((scope) => !(own.scopes as string[]).includes(scope)))) {",
     "      if (!own || (own.scopes !== 'parent' && added.some((scope) => !(own.scopes as string[]).includes(scope)) && added.length < 0)) {"),
    ('clause 9d: a non-administrator loosens a transport pin', EXECUTOR,
     "    if (!field || classification.moves[field] !== 'up') return;",
     "    if (!field || classification.moves[field] !== 'up' || field.length > 0) return;"),
    ('D-10a: the one-act door accepts a step-up bound to approval.decide', EXECUTOR,
     "          action: EDIT_STEP_UP_ACTIONS[object.type],\n          targetId: object.id,",
     "          action: 'approval.decide',\n          targetId: object.id,"),
    ('clause 6e: a stale request applies', EXECUTOR,
     "    if (!statesEqual(type, object.state as unknown as Record<string, unknown>, before)) return stale('its editable fields differ from the snapshot');",
     "    if (!statesEqual(type, object.state as unknown as Record<string, unknown>, before) && type.length < 0) return stale('its editable fields differ from the snapshot');"),
    ('clause 6d: the decider approves a scope never requested', EXECUTOR,
     "      if (extra.length > 0) throw narrows(`${extra.join(', ')} was never requested`, { exceeding: extra });",
     "      if (extra.length < 0) throw narrows(`${extra.join(', ')} was never requested`, { exceeding: extra });"),
    ('clause 6j: a widening without a lifetime is kept', EXECUTOR,
     "      throw required('a widening needs its lifetime: lifetime {choice: \"keep\"} or {choice: \"until-task\", taskId and/or revertAt}');",
     "      return { choice: 'keep', taskId: null, revertAt: null };"),
    ("clause 6j: the related task's terminal reverts nothing", TERMINAL,
     "    result.revertedEditApprovalIds = await authorityEditExecutor.revertAtTaskTerminal(client, subject.id, actor);",
     "    result.revertedEditApprovalIds = authorityEditExecutor ? [] : [];"),
    ('clause 6j: a revert restores the state before instead of removing only what was added', EXECUTOR,
     "      removeAdded('scopes', current.scopes as string[], added);",
     "      void added; next.scopes = parseJson<string[]>(before.scopes, []);"),
    ('clause 6j: the sweep never reverts at a date', EXECUTOR,
     "          AND ((a.edit_revert_at IS NOT NULL AND a.edit_revert_at <= NOW())",
     "          AND ((a.edit_revert_at IS NOT NULL AND a.edit_revert_at <= NOW() - INTERVAL '1 day')"),
    ('clause 6j with 10c: a ceiling revert does not wait for riding tasks', EXECUTOR,
     "        if (dependents.length > 0) return 'awaiting-acknowledgement';",
     "        if (dependents.length < 0) return 'awaiting-acknowledgement';"),
    ('clause 6h: the item does not name the object kind in words', EXECUTOR,
     "  credential: 'Connector configuration',",
     "  credential: 'credential',"),
    ('clause 9h (E113): an Agent whose intersection is empty is narrowed to nothing instead of revoked', EXECUTOR,
     "      if (kept.length === 0) {",
     "      if (kept.length < 0) {"),
    ('clause 9h: the narrow-all act is never run', EXECUTOR,
     "    if (input.narrowAgents) {",
     "    if (input.narrowAgents && input.path.length < 0) {"),
    ('clause 9h: the narrow-all act writes the Agent scopes unchanged', EXECUTOR,
     "          [credentialId, JSON.stringify(kept)]);",
     "          [credentialId, JSON.stringify(held)]);"),
    ('N-4: a failed Agent write is swallowed and the narrowing commits', EXECUTOR,
     """        await client.query(
          `UPDATE principal_credentials SET scopes = $2::jsonb WHERE id = $1 AND revoked_at IS NULL`,
          [credentialId, JSON.stringify(kept)]);""",
     """        await client.query('SAVEPOINT az13_drill');
        await client.query(
          `UPDATE principal_credentials SET scopes = $2::jsonb WHERE id = $1 AND revoked_at IS NULL`,
          [credentialId, JSON.stringify(kept)]).then(() => client.query('RELEASE SAVEPOINT az13_drill'), () => client.query('ROLLBACK TO SAVEPOINT az13_drill'));"""),
    ('clause 10c: a ceiling edit releases riding tasks without acknowledgement', EXECUTOR,
     "        if (dependents.length > 0 && !input.acknowledgeDependents) {",
     "        if (dependents.length > 0 && !input.acknowledgeDependents && dependents.length < 0) {"),
    ("clause 8b: a widening is not held within its creator's current authority", EXECUTOR,
     "      if (creatorProblem) {",
     "      if (creatorProblem && creatorProblem.length < 0) {"),
    ("clause 8b (E94, O-1): the owning Account widens a warrant beyond its own reach", EXECUTOR,
     "        if (problem) {\n          throw refuse(403, 'EXCEEDS_ACCOUNT_AUTHORITY',\n            `you can give a warrant",
     "        if (problem && problem.exceedingScopes.length < 0) {\n          throw refuse(403, 'EXCEEDS_ACCOUNT_AUTHORITY',\n            `you can give a warrant"),
    ('clause 10d: a revoked warrant is edited', EXECUTOR,
     "      if (['revoked', 'expired'].includes(String(object.row.status))) {",
     "      if (['revoked', 'expired'].includes(String(object.row.status)) && object.id.length < 0) {"),
    ('clause 11e: an edited grant tuple equal to a live row overwrites it', EXECUTOR,
     "        if (live) {\n          throw refuse(409, 'GRANT_EXISTS',",
     "        if (live && clash.id.length < 0) {\n          throw refuse(409, 'GRANT_EXISTS',"),
    ('clause 11c: an assignment-carried grant is edited', EXECUTOR,
     "    if (object.row.provenance) {",
     "    if (object.row.provenance && object.id.length < 0) {"),
    ('clause 11d (E15): an approval-made grant is extended past 90 days', EXECUTOR,
     "        && expiryMove(before.expiresAt, validated.expiresAt) === 'up') {",
     "        && expiryMove(before.expiresAt, validated.expiresAt) === 'up' && object.id.length < 0) {"),
    ('clause 11f: acl_changed is emitted for the new object only', EXECUTOR,
     "      const ids = [...new Set([(object.state as GrantState).resourceId, (finalState as unknown as GrantState).resourceId]",
     "      const ids = [...new Set([(finalState as unknown as GrantState).resourceId]"),
    ("clause 6c: an agent files an edit of another credential", APPROVAL,
     "        && (typeof namedId !== 'string' || namedId.toLowerCase() !== credentialId)) {",
     "        && (typeof namedId !== 'string') && credentialId.length < 0) {"),
    ('AZ-A9 clause 6: a non-administrator owning Account decides an edit request', DECIDERS,
     "  return viewer.administratorOk ? 'administrator' : null;",
     "  return viewer.administratorOk || kind === 'authority-edit' ? 'administrator' : null;"),
    ('clause 7 P-4: collect refuses only a grant request', APPROVAL,
     "      if (kind !== 'credential') {\n        // AZ-A13 clause 7 P-4",
     "      if (kind === 'grant') {\n        // AZ-A13 clause 7 P-4"),
    ('clause 7 P-4: an edit request is decided by the grant and credential arm', APPROVAL,
     "    if (kind === 'authority-edit') return this.decideAuthorityEdit(client, row, input, actor);\n",
     "    if (kind === 'authority-edit' && kind.length < 0) return this.decideAuthorityEdit(client, row, input, actor);\n"),
    ("clause 6a: a pending edit request lapses at its related task's terminal", TERMINAL,
     "  const waiting = related.rows.filter((row) => row.kind !== 'authority-edit' && (row.status === 'pending'",
     "  const waiting = related.rows.filter((row) => row.kind.length > 0 && (row.status === 'pending'"),
    ('clause 6f with AZ-31c: rotating the bound credential tries to lapse an approved edit', INVALIDATION,
     "        AND NOT (kind = 'authority-edit' AND status = 'approved')\n",
     ""),
    ('N-1: a Connector cannot revoke the Agents it minted', CREDENTIALS,
     "    const selfServiceCaller = isBearerCredentialKind(req.authMethod)\n      || isLoginSessionKind(req.authMethod);",
     "    const selfServiceCaller = isBearerCredentialKind(req.authMethod) && req.method === 'GET'\n      || isLoginSessionKind(req.authMethod);"),
    ('drill 8 (clause 7, E73): the one credential policy refuses an mcp pin', PRINCIPAL,
     "    if (!['any', 'mcp', 'api'].includes(transport)) {",
     "    if (!['any', 'api'].includes(transport)) {"),
    # Review 1a38270d round 1, B1: the revert, field by field (clause 6j).
    ('clause 6j (r1 B1): the door accepts "until this task ends" for an edit its revert cannot narrow', EXECUTOR,
     "      await this.assertRevertible(object, after, lifetime);\n      await this.assertCaps(client, object, after, classification, input.editor, actor);",
     "      await this.assertCaps(client, object, after, classification, input.editor, actor);"),
    ('clause 6j (r1 B1 a): a ceiling not comparable with the one before leaves no residual', EXECUTOR,
     "          if (backNarrows && !addedNothing) next.ceilingProfileVersionId = priorVersion;\n          else if (!addedNothing) residual.push('ceiling');",
     "          if (backNarrows && !addedNothing) next.ceilingProfileVersionId = priorVersion;\n          else if (!addedNothing && priorRules.length < 0) residual.push('ceiling');"),
    ('clause 6j (r1 B1, per field): the ceiling goes back without a direction check', EXECUTOR,
     "          if (backNarrows && !addedNothing) next.ceilingProfileVersionId = priorVersion;",
     "          if (backNarrows !== addedNothing) next.ceilingProfileVersionId = priorVersion;"),
    ('clause 6j (r1 B1 a): a residual discards the whole revert', EXECUTOR,
     "    if (plan.next) {\n      const next = plan.next;",
     "    if (plan.next && plan.residual.length === 0) {\n      const next = plan.next;"),
    ('clause 6j (r1 B1): a record is closed as reverted while a residual remains', EXECUTOR,
     "    if (plan.residual.length > 0) {\n      // Never closed as reverted",
     "    if (plan.residual.length < 0) {\n      // Never closed as reverted"),
    ('clause 6j (r1 B1 b): a grant selector not comparable with the one before leaves no residual', EXECUTOR,
     "    field('resourceId', selectorMove);",
     "    field('resourceId', (a: any, b: any) => (selectorMove(a, b) === 'up' && selectorMove(b, a) === 'up' ? 'same' : selectorMove(a, b)));"),
    ('clause 6j (r1 B1 c): a transport not comparable with the one before leaves no residual', EXECUTOR,
     "      field('transport', transportMove);",
     "      field('transport', (a: Transport, b: Transport) => (a !== 'any' && b !== 'any' ? 'same' : transportMove(a, b)));"),
    ('clause 6j (r1 B1 d): a removal that empties a scope set leaves no residual', EXECUTOR,
     "      if (kept.length > 0) next[name] = kept;\n      else residual.push(name);",
     "      if (kept.length > 0) next[name] = kept;"),
    ('clause 6j (r1 B1, scope ceiling): the scopes a warrant widening added to its scope ceiling stay', EXECUTOR,
     "        removeAdded('ceilingScopes', currentCap, approvedCap.filter((s) => !priorCap.includes(s)));",
     "        removeAdded('ceilingScopes', currentCap, approvedCap.filter((s) => s.length < 0 && !priorCap.includes(s)));"),
    ('clause 6j (r1 B1, unpinned ceiling): a ceiling with no version pinned before leaves no residual', EXECUTOR,
     "          // there is nothing to go back to.\n          residual.push('ceiling');",
     "          // there is nothing to go back to.\n"),
    # Review 1a38270d round 1, B2: the warrant route's own refusals (clause 13).
    ('clause 13 (r1 B2 i): a warrant edit refused for standing writes no audit row', WARRANTS,
     "        await refuseStanding(req, res, 'warrant', id, { concealAs: 'WARRANT_NOT_FOUND' });",
     "        void refuseStanding; res.status(404).json({ error: 'Refused', code: 'WARRANT_NOT_FOUND', message: 'No such warrant' });"),
    ('clause 13 (r1 B2 ii): WARRANT_AUTHORITY_IMMUTABLE writes no audit row', WARRANTS,
     "      await auditRouteRefusal(req, 'warrant', id, 'WARRANT_AUTHORITY_IMMUTABLE', refusal);\n",
     ""),
    ('clause 13 (r1 B2): an edit of a missing warrant writes no audit row', WARRANTS,
     "      if (editAct && e instanceof WarrantError && e.code === 'WARRANT_NOT_FOUND') {",
     "      if (editAct && e instanceof WarrantError && e.code === 'WARRANT_NOT_FOUND' && id.length < 0) {"),
]

CENSUS_CONTROLS = [
    ('C-1: an unregistered UPDATE writes a credential scope set', LIFECYCLE,
     "await client.query('UPDATE principal_credentials SET reveal_count = reveal_count + 1 WHERE id = $1', [credentialId]);",
     "await client.query('UPDATE principal_credentials SET reveal_count = reveal_count + 1, scopes = scopes WHERE id = $1', [credentialId]);"),
    ('C-2: a cache in front of the bearer auth path', PRINCIPAL,
     "  async authenticatePrincipalKey(parts: PrincipalKeyParts): Promise<{ principal: Principal; credential: PrincipalCredential } | undefined> {",
     "  async authenticatePrincipalKey(parts: PrincipalKeyParts): Promise<{ principal: Principal; credential: PrincipalCredential } | undefined> {\n    const credentialCache = new Map(); void credentialCache;"),
    ('clause 15b: the registry composes a PATCH on a credential', REGISTRY,
     "      return json(await board(ctx, { method: 'POST', path: `/credentials/${encodeURIComponent(credentialId)}/reveal`, body: {} }));",
     "      return json(await board(ctx, { method: 'PATCH', path: `/credentials/${encodeURIComponent(credentialId)}`, body: {} }));"),
]

CREDENTIAL_CONTROLS = [c for c in LIVE_CONTROLS if c[0].startswith('drill 8')]

# Owner rulings E148 and E149 (12 Oct 2026), each control withdrawing ONE rule.
FOLLOWUPS_CONTROLS = [
    ('E148: a field a later edit moved is never named as a residual', EXECUTOR,
     "        if (move(prior, appr) === 'up' && move(prior, cur) === 'up') kept.push({ field: name, before: prior, approved: appr, now: cur });",
     "        if (move(prior, appr) === 'up' && move(prior, cur) === 'up' && name.length < 0) kept.push({ field: name, before: prior, approved: appr, now: cur });"),
    ('E148: a ceiling a later edit re-pinned is never named as a residual', EXECUTOR,
     "        if (widened && beyond) kept.push({ field: 'ceiling', before: priorVersion, approved: approvedVersion, now: currentVersion });",
     "        if (widened && beyond && priorRules.length < 0) kept.push({ field: 'ceiling', before: priorVersion, approved: approvedVersion, now: currentVersion });"),
    ('E148: a scope ceiling a later edit capped or lifted is never named as a residual', EXECUTOR,
     "      if (capMovedLater && scopeCeilingMove(priorCap, approvedCap) === 'up' && scopeCeilingMove(priorCap, currentCap) === 'up') {",
     "      if (capMovedLater && scopeCeilingMove(priorCap, approvedCap) === 'up' && scopeCeilingMove(priorCap, currentCap) === 'up' && kept.length < 0) {"),
    ('E148: the closing reason says nothing the widening added is still present while a residual is kept', EXECUTOR,
     "      await stamp('nothing', { reason: plan.kept.length > 0 ? residualReason(plan.kept) : NOTHING_REMAINS, ...named });",
     "      await stamp('nothing', { reason: NOTHING_REMAINS, ...named });"),
    ('E148: the revert audit row does not name the residual it keeps', EXECUTOR,
     "        ...(input.residual && input.residual.length > 0 ? { residual: input.residual } : {}),",
     "        ...(input.residual && input.residual.length < 0 ? { residual: input.residual } : {}),"),
    ('E148: the closing record does not name the residual it keeps', EXECUTOR,
     "    const named = plan.kept.length > 0 ? { residual: plan.kept } : {};",
     "    const named = plan.kept.length < 0 ? { residual: plan.kept } : {};"),
    ('E149: the session door reads no added scope', EXECUTOR,
     "      const problem = await this.editableProblem(client, object, this.scopesAdded(object, input.fields.scopes));",
     "      const problem = await this.editableProblem(client, object);"),
    ('E149: the decide path reads no added scope', EXECUTOR,
     "    const problem = await this.editableProblem(client, object, this.scopesAdded(object, requested.scopes));",
     "    const problem = await this.editableProblem(client, object);"),
    ('E149: the edit target check never binds a mint-only scope', EXECUTOR,
     "      const mintOnly = agentMintOnlyRefusal(principal.kind, adding, 'target');\n      if (mintOnly) return mintOnly;\n",
     "      void adding;\n"),
    ("E149: the agent's door never binds a mint-only scope", APPROVAL,
     "      const mintOnly = agentMintOnlyRefusal(requester.kind, input.addScopes, 'requester');\n      if (mintOnly) throw asApprovalEditRefusal(mintOnly);\n",
     "      void agentMintOnlyRefusal;\n"),
    ('E149: no scope is mint-only for an Agent', EXECUTOR,
     "export const AGENT_MINT_ONLY_SCOPES: ReadonlySet<Scope> = new Set<Scope>(['knowledge-contents:write']);",
     "export const AGENT_MINT_ONLY_SCOPES: ReadonlySet<Scope> = new Set<Scope>([]);"),
]

STAGE3_CONTROLS = [
    ('hub lifetime: validation refusal does not spend step-up', APPROVAL,
     'stepUp: await stepUpService.consume(client, {',
     'stepUp: await stepUpService.consume(pool, {'),
    ('N14: a one-act widening is excluded from the quota preview', APPROVAL,
     "AND NOT (kind = 'authority-edit' AND COALESCE(session_evidence->>'door', '') = 'one-act')`,\n      [record.requesterPrincipalId],",
     'AND TRUE`,\n      [record.requesterPrincipalId],'),
]

SUITES = {
    'live': (LIVE_SUITE, LIVE_CONTROLS, True, '^(?!.*(?:hub defect:|N14:))'),
    'census': (CENSUS_SUITE, CENSUS_CONTROLS, False, None),
    'credential': (CREDENTIAL_SUITE, CREDENTIAL_CONTROLS, True, None),
    'followups': (FOLLOWUPS_SUITE, FOLLOWUPS_CONTROLS, True, None),
    'stage3': (LIVE_SUITE, STAGE3_CONTROLS, True, 'hub defect:|N14:'),
}

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


def run_suite(copy, out, label, suite, needs_db, title_pattern=None):
    report = out / f'{label}.json'
    command = ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--runTestsByPath', suite, '--json', f'--outputFile={report}']
    if needs_db:
        command.insert(3, '--testPathIgnorePatterns=/node_modules/')
    if title_pattern:
        command.extend(['--testNamePattern', title_pattern])
    env = dict(os.environ)
    if not needs_db:
        env.pop('RELAYHALL_TEST_DB_URL', None)
    with (out / f'{label}.log').open('w') as log:
        code = subprocess.run(command, cwd=copy / 'backend', stdout=log, stderr=subprocess.STDOUT, timeout=1500, env=env).returncode
    result = json.loads(report.read_text()) if report.exists() else {}
    tests = [a for f in result.get('testResults', []) for a in f.get('assertionResults', [])
             if a.get('status') != 'pending']
    suite_messages = ' '.join(str(f.get('message', '')) for f in result.get('testResults', []))
    return code, tests, re.sub(r'\x1b\[[0-9;]*m', '', suite_messages)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--describe', action='store_true')
    parser.add_argument('--discover', action='store_true',
                        help='record each control\'s red set instead of checking it (writes discovered.json in --output-dir)')
    parser.add_argument('--suite', choices=sorted(SUITES), default='live')
    parser.add_argument('--control', action='append', help='with --discover: only the controls whose name starts with this')
    args = parser.parse_args()
    suite, controls, needs_db, title_pattern = SUITES[args.suite]
    if args.control:
        if not args.discover:
            raise SystemExit('--control selects controls for --discover only; a strict run runs every control')
        controls = [c for c in controls if any(c[0].startswith(prefix) for prefix in args.control)]
    declared = DECLARED[args.suite]

    for _, path, anchor, replacement in controls:
        once((ROOT / path).read_text(), anchor, replacement)
    if not args.discover:
        sets = [frozenset(declared.get(c[0], [])) for c in controls]
        if any(not s for s in sets) or len(set(sets)) != len(sets):
            raise SystemExit('every control must declare a non-empty must-fail set that no other control shares')
    if args.describe:
        print(json.dumps([{'control': c[0], 'file': c[1], 'mustFail': sorted(declared.get(c[0], []))} for c in controls], indent=2))
        return

    if needs_db:
        require_disposable_database()
    if not args.output_dir:
        raise SystemExit('--output-dir is required')
    out = args.output_dir.resolve()
    if out == ROOT or ROOT in out.parents:
        raise SystemExit('--output-dir must lie outside the repository')
    out.mkdir(parents=True, exist_ok=False)

    before = fingerprints(ROOT)
    copy = Path(tempfile.mkdtemp(prefix='authority-edit-drill-'))
    receipts = []
    discovered = {}
    try:
        shutil.copytree(ROOT, copy, dirs_exist_ok=True, ignore=shutil.ignore_patterns(*IGNORED, '*.log'))
        modules_link = copy / 'backend/node_modules'
        modules_target = (ROOT / 'backend/node_modules').resolve()
        if os.name == 'nt':
            # Windows without Developer Mode cannot create a directory symlink.
            # A task-local junction is equivalent for Node's module resolver.
            subprocess.run(['cmd', '/c', 'mklink', '/J', str(modules_link), str(modules_target)],
                           check=True, stdout=subprocess.DEVNULL)
        else:
            modules_link.symlink_to(modules_target, target_is_directory=True)

        code, tests, suite_messages = run_suite(copy, out, 'baseline', suite, needs_db, title_pattern)
        titles = [t['title'] for t in tests]
        if code != 0 or not tests or any(t['status'] != 'passed' for t in tests):
            # The baseline log lives in the drill copy, which is removed below:
            # name what failed here, or the job log carries no assertion.
            for t in tests:
                if t['status'] != 'passed':
                    message = re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(t.get('failureMessages', [])))
                    message = re.sub(r'rh_[A-Za-z0-9_.-]+', 'rh_<redacted>', message)
                    print(f"baseline {t['status']}: {t['title']}\n  " + '\n  '.join(message.splitlines()[:12]), flush=True)
            if not tests:
                print('baseline ran no tests (exit ' + str(code) + '): '
                      + re.sub(r'rh_[A-Za-z0-9_.-]+', 'rh_<redacted>', suite_messages)[:1500], flush=True)
            raise SystemExit('baseline is not green')
        if len(set(titles)) != len(titles):
            raise SystemExit('two tests share a title, so a declared title would not name one test')
        if not args.discover:
            for name, _, _, _ in controls:
                if not set(declared[name]) <= set(titles):
                    raise SystemExit(f'a declared test is absent from the suite: {sorted(set(declared[name]) - set(titles))}')

        for index, (name, path, anchor, replacement) in enumerate(controls, start=1):
            target = copy / path
            original = target.read_text()
            target.write_text(once(original, anchor, replacement))
            try:
                code, tests, suite_messages = run_suite(copy, out, f'control-{index}', suite, needs_db, title_pattern)
            finally:
                target.write_text(original)
            failed = {t['title'] for t in tests if t['status'] == 'failed'}
            messages = re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(
                m for t in tests if t['status'] == 'failed' for m in t.get('failureMessages', [])))
            clean = code != 0 and [t['title'] for t in tests] == titles \
                and all('expect(' in '\n'.join(t.get('failureMessages', [])) or 'Expected' in '\n'.join(t.get('failureMessages', []))
                        for t in tests if t['status'] == 'failed') \
                and not re.search(r'TS\d{4}|SyntaxError|Test suite failed to run|Exceeded timeout|ECONNREFUSED',
                                  messages + suite_messages)
            if args.discover:
                discovered[name] = sorted(failed)
                (out / 'discovered.json').write_text(json.dumps(discovered, indent=2))
                print(f"{'RED ' if clean and failed else 'MISS'} {name} -> {len(failed)}: {sorted(failed)}", flush=True)
                continue
            must_fail = set(declared[name])
            semantic = clean and failed == must_fail
            receipts.append({'control': name, 'file': path, 'mustFail': sorted(must_fail), 'failed': sorted(failed), 'red': semantic})
            (out / 'receipts.json').write_text(json.dumps(receipts, indent=2))
            print(f"{'RED ' if semantic else 'MISS'} {name} -> {sorted(failed)}", flush=True)
            if not semantic:
                raise SystemExit(f'control did not fail at its declared assertions: {name}')
    finally:
        if os.name == 'nt' and (copy / 'backend/node_modules').exists():
            os.rmdir(copy / 'backend/node_modules')
        shutil.rmtree(copy, ignore_errors=True)
        after = fingerprints(ROOT)
        (out / 'closure.json').write_text(json.dumps({
            'sourceUnchanged': before == after, 'copyRemoved': not copy.exists(),
            'controls': len(receipts) if not args.discover else len(discovered),
        }, indent=2))
    if before != fingerprints(ROOT):
        raise SystemExit('the source tree changed during the drill')
    if args.discover:
        print(f'discovered {len(discovered)} controls; review discovered.json before declaring it')
        return
    print(f'all {len(receipts)} controls red at their declared assertions; source unchanged')


if __name__ == '__main__':
    main()
