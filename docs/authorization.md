## Account owner control (7 October 2026 amendment)

Account ownership is distinct from Task assignment and Report authorship. Newly
created ordinary Projects bind their verified human account as Project owner;
Tasks and Reports store account_owner_principal_id from the authenticated
creation transaction. A Task without that explicit coordinate inherits its
Project owner. No historical records are automatically assigned by migration.

The human owner uses My connections to explicitly appoint a direct Service
connector as Main. The server stores the owning account ID, not a display-name
match. Disabled accounts, revoked credentials, reparented connectors, task-bound
agents and connectors without this appointment cannot use owner-control
lifecycle actions. Credential scopes, selectors and delegation intersections
continue to constrain Main.

Owners and appointed Main connectors may explicitly dispose of their owned
subtasks and complete their Tasks. Every subtask must still be completed or
skipped before parent completion. No child is silently accepted. Administrative
disposition is recorded as task.account_disposition with
independentVerification=false; it neither assigns a Verifier nor invents a
review verdict. The independent Verifier path remains separate.

Human writers may administer an exact resource they own without receiving a
global administrator role. This applies only to Task, Project, Phase and Report
resource checks; identity management and other accounts remain outside it.

Existing ownership gaps require a supported, audited reconciliation of exact
records and an explicit owning account. An old read/write grant or a connector's
current ancestor is not sufficient proof to silently transfer historical data.

# Authorization

Every protected RelayHall API route passes through one shared authorization predicate after authentication. Route-family scopes are ceilings; object authority is then evaluated consistently for point reads, mutations, and lists.

## Account roles

Choose the least powerful role that fits the Account's work. A role limits the
actions an identity can perform; it does not automatically give every Account
access to every object. Ownership, grants, visibility, Task assignments,
credential scopes and delegation restrictions also apply.

Every role's purpose, scope ceiling (what it may reach and what it never
reaches), the identity kinds it is meant for and who may assign it are listed
in [roles.md](roles.md). That page is generated from the role catalogue the
board serves at `GET /principals/roles`, and the dashboard shows the same text
under every role selector, so there is one description per role and no second
list to fall out of step.

The editor, user, `reviewer`, qa and agent roles share the same general working ceiling.
Their names describe intended use; they are not five ascending privilege levels.
The `reviewer` and qa roles retain a compatibility exception for verifying older Tasks
without an assigned Verifier. Once a Verifier is assigned, that identity is
required; the Assignee cannot also be the Verifier. Workflow checks still apply.

An Account role is separate from both its identity kind and its role on an
individual Task. Selecting agent here does not create a delegated Agent or
assign a Task. Assignee, Shepherd and Verifier are Task assignments, described
below.

### Changing a role

In **Access manager → Roles**, select an Account and a new role. The selector
offers only roles your login session may assign. Admin can assign all nine;
operator and orchestrator can assign all except admin and orchestrator.
The server requires an administrator login session and audits the change.
You cannot change your own role through this control, or change the reserved
system and dashboard_user identities.

Current login sessions follow the Account's stored role on the next request,
so an Account does not need to sign in again after a role change. Credential
scopes remain a separate restriction. The first-run administrator has the
admin role; the deployment break-glass identity dashboard_user carries
orchestrator and is separate from that named administrator.

## Group principals

Since AZ-A12 a Group is also a principal of kind `group` (same id). It is not an
Account, a Connector or an Agent, and it never acts: a token that resolves to
one is `401`, it holds no credential or login session, it is never a Task role
holder or Report author, never a member of a Group and never a
`granteeType: 'principal'` grantee — a Group's grants stay `granteeType:
'group'`. A Group's grants work exactly as before, whether its principal is
enabled or disabled. What owning an object gives a Group's members is the
Group ownership rule below.

## Group roles (LENSES-c c1-A)

An Account can hold one Group role per Group, `owner` or `manager`
(`group_stewards`, migration 152). Roles are appointed and removed by a **root
login session** only (`POST` and `DELETE /groups/{id}/stewards`), with one
exception: a live **owner** may remove a **manager** row in that Group, on a
login session with a step-up bound to `(group.manager_remove, group id)`
(`DELETE /groups/{id}/managers/{principalId}`). That removal is a
declared, act-scoped exception to §5.2 rule 4, which otherwise keeps Group-role
appointment and removal root-only; it removes a tier the owner also holds, only
in the owner's own Group, and never touches an owner row. No administrator,
operator or bearer reaches either act: the root routes test the login session
in the handler, and an elevated Account cannot hold a role.

**Inert rows.** A role row is live only while its holder is active, a member of
the Group by any source, and not `admin`, `operator` or `orchestrator`. All
three are read at use through one shared SQL fragment
(`utils/liveStewardCondition.ts`); an inert row confers nothing. Promotion to
an elevated role therefore makes a row inert at once, and termination leaves
the row in place, inert, rather than removing it (a removal inside termination
would be a Group-role removal reachable by a bearer).

**The edit tier.** A live owner or manager row is what the Group ownership rule
below reads for the edit tier, through the same shared fragment. Beside that, a
role row gives the catalog's steward rows, the team-grants read
(`GET /groups/{id}/grants`) and the manager lens.

**The owner-only gates (LENSES-c c1-B).** A live
**owner** row confers exactly four named acts beyond the shared tier, and a
manager row none of them. Each is a **login session** of a human Account acting
as itself, plus a **live owner row** on the Group concerned (read with row
locks inside the act), plus a **single-use step-up** bound to the act and the
object, and none of them goes through the `admin` verb:

| act | route | step-up |
| --- | --- | --- |
| (iii) appoint a **manager** (an active member) in that Group; remove a manager row | `POST /groups/{id}/managers`; `DELETE /groups/{id}/managers/{principalId}` | `group.manager_appoint` / `group.manager_remove`, Group id |
| (i) approve the Charter of a Project the active Group owns, only after the administrator check refused | `POST /projects/{id}/charter/approve` | `charter.approve`, Project id |
| (ii) move an object the Group owns to an active member | `PUT /projects/{id}/owner/steward`, `PUT /tasks/{id}/account-owner/steward` | `ownership.transfer`, object id |
| (DD-5) move one's own object into a Group one owns | the same two routes | `ownership.transfer`, object id |

They are declared, act-scoped exceptions to §5.2 rule 4 (Group-role
appointment and ownership transfer otherwise stay root and administrator acts).
No owner appoints or removes an **owner**; no gate reaches a Skill, a Report or
a Service; no bearer, Connector, appointed Main or MCP call passes; and no
administrator or operator does either, since an elevated Account holds no live
row (promotion to `operator`, `admin` or `orchestrator` makes a row inert on the
next request). Every refusal is named and audited before the token is spent,
the gates' own input and precondition checks included; a refusal that a
concurrent write causes after the checks (two appointments of one Account) is
the same named refusal, and its rollback returns the token.

## Group ownership (AZ-A12 build 2)

A Project's owner, a Task's or a Report's account owner may name a Group. The
owner rule then reads the Group by **tier**, on the acting Account:

| tier | who | actions |
| --- | --- | --- |
| use | an active member of the Group, by any source | `read`, `use`, `invoke` |
| edit | a member holding a **live** `owner` or `manager` row | `read`, `write`, `claim`, `finish`, `release`, `use`, `invoke` |

- **Never `admin`, `shepherd` or `verify`.** No tier admits them; Task roles
  stay on their named holders. This is narrower than a person owner, whose
  owner rule admits any action. The `owner` role confers exactly the manager's
  tier.
- **The role ceiling decides first.** A `viewer` member, or a `viewer` holding a
  manager row, only reads.
- **Liveness is read at use.** The Group principal must be `active` (disabling
  it through `PUT /groups/{id}/ownership-status` suspends every tier on the next
  request and leaves its grants working), the member must be `active` and still
  a member, and a role row must be live (see Inert rows).
- **A Group-owned Project reaches its Phases and Tasks.** A Phase reads its
  Project's owner. A Task with no explicit account owner reads its Project's
  owner (path a), so moving such a Project into a Group moves those Tasks with
  it. A Task whose explicit account owner is someone else is still reached by
  the Project's owning Group (path b): members read it, live owners and
  managers get the ordinary Task write subset (`read`, `write`, `claim`,
  `finish`, `release`), never `use`, `invoke`, `admin`, Shepherd or Verifier.
  Path b needs the Project to exist and be `active`. A person Project owner
  gains no path b: a Task someone else owns stays theirs.
- **Restriction.** A restricted Phase, a restricted Task and a Task under a
  restricted Phase are hidden from plain members (the use tier is suppressed);
  the Group's live owners and managers keep the edit tier on them. Restriction
  suppresses path b for every tier.
- **Account side only.** The rule is evaluated for the Account itself. A
  Connector or Agent under a member Account reaches a Group-owned object only
  through its Account, inside every own() limit of its chain, and an Agent's
  writes stay on its bound Task. Because the Agent-mint ceiling asks the same
  rule, a manager's Connector may request an Agent over rows inside the
  Group-owned Project and is refused rows outside it.
- **Charter approval** of a Group-owned Project asks for `admin`, which no tier
  gives: an administrator approves it as before, and a live **owner** of the
  owning Group approves it through gate (i) with a step-up (see "The owner-only
  gates"); a manager does not. A person owner still approves their own
  Project's Charter.

Point checks, SQL list scopes, the authority preview and the mint ceiling all
read one shared SQL fragment (`utils/groupOwnerCondition.ts`), so a list and a
point decision cannot disagree.

**Skills (AZ-A12 build 4, M-c).** A Skill's owner,
`skills.owner_principal_id` (migration 162), may name a person Account or a
Group. A person owner holds the owner rule on that Skill like a Project's
person owner; a Group owner's members get the use tier (`read`, `use`) and its
live owners and managers the edit tier (`write`: draft Versions, submit for
review, return to draft). Neither reaches publication, retirement, audience or
deletion past their own ceilings: those routes stay `skills:admin`, and
publication stays human-only and independent of the Version's creator. An
unowned Skill (`NULL`) confers nothing. The registry's draft visibility (who
sees unpublished Versions) reads the same owner value and the same fragment;
see "Skill ownership" in [api.md](api.md). Assigning the owner is
`PUT /skills/{id}/owner` (`skills:admin`, point action `admin`), and a move
into, out of or between Groups is the transfer act below.

## Transferring ownership to, from or between Groups (AZ-A12 build 3)

Moving a Project's owner, a Task's account owner or a Skill's owner **into, out
of or between Groups** is its own act. It covers `PUT /skills/{id}/owner`
(audited `skill.owner.change`), `PUT /projects/{id}/owner` (clearing a
Group-owned Project included), `PUT /tasks/{id}/account-owner` (the Task's
effective owner counts, so a Task that takes its Group owner from its Project is
a Group source) and the create form's Group owner selector. Inside the act's
transaction, after its row lock and before its usual owner checks, the server
tests the caller, in this order:

1. **A login session** (a board session or the dashboard JWT). A bearer
   credential is refused `GROUP_OWNER_SESSION_ONLY`: that includes an appointed
   Main Connector holding `projects:admin`, every other `rh_` credential and the
   MCP tool `relayhall_task_account_owner_change`.
2. **Root, or an administrator.** Root is a session holding the `root` scope (an
   `admin` or `orchestrator` Account, or the break-glass dashboard JWT). An
   administrator is an `operator` session, admitted by the same check the role
   and approval acts use. Anyone else is refused
   `GROUP_OWNER_REQUIRES_ADMINISTRATOR`. (Over HTTP the routes' `projects:admin`
   and `tasks:admin` ceilings already stop every other role; creation, whose
   ceiling is `projects:write`, reaches this refusal.)
3. **A single-use step-up** bound to `(ownership.transfer, object id)`, sent as
   `stepUpToken`; else `STEP_UP_REQUIRED` with the `stepUp` challenge naming
   that binding.

Steps 1 and 2 refuse before the token is spent, and any later refusal rolls the
spending back with the rest of the transaction, so a refused caller's token
stays live. Every refusal is audited as a `denied` row of the act's own action
(`project.owner.change`, `task.account_owner.change`) written outside the
rolled-back transaction, naming the refusal and the owner kinds.

Once admitted, the act's usual checks run unchanged, except that the appointed
Main never decides a transfer involving a Group. The break-glass dashboard JWT
therefore moves a Project but not a Task: the Task act admits a stored login
session only. A Group target must be an **enabled** Group principal; a disabled
one is refused `INVALID_OWNER` (Project) or `INVALID_ACCOUNT_OWNER` (Task).
Grants are untouched. The success audit row gains `oldOwnerKind`,
`newOwnerKind`, `groupMemberCountAtTransfer` (the active members of the Group
gaining ownership, else of the Group losing it), `stepUpTokenId`,
`stepUpMethod`, `deciderStanding` (`root` or `administrator`) and the acting
`chain`.

**Undo.** An administrator can undo their own move: back to the person, or a
Project's clear. A Task act always names a target, so undoing a Task's move into
a Group writes the person as the Task's **explicit** account owner, and the Task
no longer follows its Project's owner afterwards.

**Owner selector.** `GET /projects/{id}/owner-candidates` adds `groups[]`, the
enabled Groups with featured Groups first, for a root or administrator login
session; everyone else gets an empty list. The Project's **Access** tab offers
them under *Groups* and asks for the step-up before it sends the transfer. The
create form offers the same choice to the same sessions: the Project is created
and moved to the Group in **one** transaction, with a step-up bound to the id
the form allocates for the new Project. Creation without a Group is unchanged.

Transfers between persons are unchanged: no step-up, the same deciders, the
appointed Main included. The act is session-only; no MCP tool performs it.

#### §5.2 rule 4 and Group transfers

Authority mutation is a closed list of acts (role change, enable, disable and
terminate, grant, profile, warrant and Group mutation, credential issuance and
reveal) that only a root login session performs. Since AZ-A12 the list also
names **transfer of ownership to, from or between Groups**, **Group-role
appointment and removal** and **Group-principal enable and disable**. The last
two stay root login-session acts. The transfer is the one act-scoped exception:
an **administrator** login session with step-up performs it beside root, as
described above. No other act on the list gains an administrator path.

## The Access Explorer (AZ-A12 build 6)

The Access Explorer answers "who can do what on this object, and why" from the
**same predicate** the server enforces with. It is a read model: nothing in it
is a second rule set, a cache or a permission. Its first hop is uniform: an
object, its owner (a person or a Group) and the holders of authority on it;
then a Group's members with their tier, an Account's Connectors, and a
Connector's own() cap, grants, Access profiles and warrants
([api.md](api.md), "The Access Explorer").

**What it shows to whom** (design section 5.3, as AZ-A12 amends it):

- Ownership, Groups, membership and Group roles are directory data: any caller
  holding `principals:read` reads them.
- The object hop answers only a caller that can **read** the object; any other
  caller gets the `404` an absent object gets.
- Another principal's authority (its verdict on an object, its grants,
  profiles, own() cap and warrants) is the what-if disclosure and stays with a
  `root` caller. Anyone else sees its own, and a login session also its
  descendants' (the self-service subtree the credential and warrant reads use).
- A Group's live owners and managers, on a login session, see what reaches one
  member **through** their Group (SR-3), and nothing else of that member. A
  steward of a disabled Group holds no tier, and sees nothing here.
- Nothing in any hop goes beyond what the caller's own read surfaces show. A
  principal whose authority the caller may not see is shown as `GET
  /principals` shows it (that record, that list's filter for hidden
  principals). A bound Task is named only to a reader of that Task; warrant
  data only where the warrant registry would show it (a login session over the
  holder's subtree, or root); a child's verdict only where its own authority
  may be seen; an owned object only to a reader of it; a Task's Project owner
  only to a reader of the Project.

**What a verdict means.** It is the object predicate now: scope ceilings,
transport pins, task state, step-up and handler conditions still gate each
real act, as in the authority preview. Board-wide authority (root, the
administrator roles and authenticated-read visibility) is stated as a class
rather than listed per principal. A listed principal with no actions holds
nothing at the moment (an expired grant, a disabled Account, an inert role
row, a dead chain).

## Lenses (RH-LENSES-d)

A lens decides which dashboard sections a person is **offered**, and nothing
else. `GET /principals/me/lenses` ([api.md](api.md), "Lenses") answers
`member` for every authenticated caller and `admin` for a request that would
pass a `root` ceiling on a **login session**; it reads the same session
classification every login-session act reads, so a bearer credential holding
`root` is never an administrator here, and the break-glass dashboard token is.
It answers `manager`, with the Groups concerned, for a caller holding a **live**
Group role row (LENSES-c c1-B), read through the same shared fragment as the
edit tier; an inert row gives no arm.

Lenses are not an authorization input. No route reads a lens, nothing stores
one, and a token never carries one: every page a lens leads to is decided by
the same scope, role, object and Access-surface checks as before, so a lens is
necessary to be shown a section and never sufficient to use it. A person who
opens an administration page without the admin lens sees what that page's
routes answer them, which for the root-only reads is nothing.

## Evaluation order

Authorization is evaluated in this order:

1. authentication and credential scope ceiling;
2. Principal role ceiling;
3. administrator or object-owner authority (a Group owner by tier, see Group ownership);
4. Task roles: Assignee (`claimant`), Shepherd, and Verifier;
5. initiator read access from server-written provenance;
6. exact and typed-wildcard grants, excluding expired grants;
7. authenticated-read visibility (`shared`, `public`, and Report `default`).

A deny on a point read is concealed as not found. A denied mutation returns a stable forbidden error. If the server cannot evaluate object authority, it fails closed instead of allowing the request or returning exception detail.

### Explicit Project ownership

Project creation records the creator as the Project's owner, beside the
creator's separately recorded, revocable Grants; the create form can make a
Group the owner instead (see the section above). A human
Project administrator can assign, transfer or clear ownership in the Project's
**Access** tab. The server requires a current human login session (cookie or
dashboard JWT), current `projects:admin` scope and Project administration,
and the last observed Project revision (`If-Match`). An `rh_` bearer credential,
an ordinary Account holding an admin Grant, and an archived Project cannot use
this act. The selected owner must be an active, parentless human Account whose
current role can read and write Projects, or an enabled Group under the Group
transfer rules above; the selected Account need not already hold an admin
Grant. The Access tab explains a role or scope ceiling rather
than presenting an ineffective Grant as owner-management authority.

Ownership supplies existing bounded Project and Phase object authority to the
Account and eligible descendants through the normal predicate. It never lifts
a role or credential scope ceiling. It does not supply Task Assignee,
Shepherd, Verifier or Project-derived Task authority. Transferring or clearing
ownership removes only the old owner arm; independent Grants and Task roles
remain until changed through their own controls. The owner and Project
revision change in one transaction with audit and content-free Project/Phase
access-change feed records. A targeted dashboard hint asks the old/new owner
to reload — and, where either owner is a Group, the Group's active members
(AZ-A12 clause 13); every subsequent API request checks current authority even if a
socket hint is missed. Existing delegated children may need focus/reconnect
or another authoritative refresh after a transfer. The feed never tries to
reconstruct which children had historical access. A content-free
access-change or deletion event whose recorded owner is a Group reaches that
Group's active members through the same membership fragment the owner rule
reads (the use tier); a disabled Group reaches nobody.

The Project record and the Task account-owner read carry `ownerKind` (`human`
or `group`) and `ownerDisplayName` beside the owner id, joined on the server
(clause 12), so a client names a Group owner without listing Group principals
in the person directory.

`root` is the global scope sentinel. Every identity path carries an explicit scope set: principal credentials retain their minted scopes, the legacy service key receives working-plane service scopes without admin/root, and JWT/session identities receive scopes from the trusted role source. Orchestrator/admin identities receive root; operators receive live object-family scopes without root; working roles receive live read/write/use/invoke scopes without admin; viewers receive read scopes only. Missing scopes and unknown session roles fail closed.

The dashboard JWT remains an identity token rather than a capability token: it does not accept a caller-supplied scope claim. After signature and Principal resolution, the server derives its explicit scopes from the Principal role. Current login sessions leave `role_snapshot` null and follow the stored Principal role. The resolver also supports a non-null server-written snapshot as a role ceiling, but current login paths do not mint one.

## Task roles

Task-role identifiers are server-written:

- `ownerPrincipalId` is the `claimant` identifier, labelled **Assignee** in the UI. The Assignee can read, work, finish, and release the Task.
- `shepherdPrincipalId` is the **Shepherd**. The Shepherd can read, release, and use the dedicated role-assignment surface. Every Task names one.
- `verifierPrincipalId` is the **Verifier**. The Verifier can judge completion but cannot do the Assignee's work.

Ordinary authenticated Task creation records revocable, exact read/write Grants
for the actual creator in the creating transaction. When that creator is a
nonlegacy Connector or Agent whose authenticated delegation chain terminates
at an active parentless human Account, the same transaction also grants that
authenticated **human sponsor** exact
read/write access to the new Task. The server revalidates the authenticated
chain under principal locks and the current credential's scope and expiry after
waiting. Caller-supplied sponsor identities are never accepted.

This deliberately replaces the former creator-only creation policy. The
acting Connector or Agent remains the actual creator and Shepherd: sponsorship
appoints no
Assignee or Verifier and grants no admin authority. Scope, role, explicit object
caps and ordinary lifecycle rules still apply. Exact Task grants do not grant
Project access or reveal unrelated restricted Tasks. Only the human Account
receives the additional grants, not intermediate
Connectors. Task-bound Agents still cannot work outside their bound Task.
Service Account parents, system creation and Blueprint creation infer no
human sponsor.

The indefinite append-only `task.sponsor_access` audit records the original
creator, human sponsor, authenticated chain, credential reference and exact
grant IDs. It is provenance, not an authorization fallback. Ordinary grants
remain the only new authority: revocation is honored; reads and idempotent
creation retries never restore it. WRITE implies READ under the existing grant
contract, so revoke both grants to remove sponsor-derived reading and writing.
Connector retirement does not erase the human entitlement, and reparenting
does not transfer old Tasks. No current-parent lookup grants access on reads.

Existing Tasks are never automatically backfilled. A separately reviewed
present-day repair may use the existing owner-plane grants API for exact
Task/human/verb tuples after establishing historical sponsorship and inspecting
prior revocations. The repair evidence binds immutable grant audit events and
returned grant IDs; it must not manufacture creation-time sponsor provenance.
Task details expose caller-scoped lifecycle decisions; mutations recheck authority.

The database and claim operation both refuse an Assignee who is also the Verifier. Tasks created before assignable Verifiers have a bounded compatibility window: a legacy Verifier-capable identity may judge them only while `verifierPrincipalId` is null. Once a Verifier is assigned, exact Principal identity is required.

Generic Task update rejects every Task-role Principal-id field, and generic Task creation rejects every one except `verifierPrincipalId`, which it admits only as a Project or Phase default (see [Default Verifier](#default-verifier) below). A Shepherd or administrator uses:

```http
PATCH /tasks/{task-id}/roles
Content-Type: application/json

{
  "shepherdPrincipalId": "...",
  "verifierPrincipalId": "..."
}
```

The Verifier may be cleared with `null`; the Shepherd may not be cleared. Every assigned identity must be an active Principal. Assigning a Service Principal as Shepherd additionally requires `services:invoke` or `root` for scoped credentials.

### Verification modes and the chain guard

Universal harness connector design, section 6.8 (choice C10 = B). Each Task shows a **verification mode**:

- `human`: the Verifier is a person. Derived from the Verifier, never stored.
- `service`: the Verifier is a `service` principal or an appointed Agent.
  Derived, never stored.
- `none`: no verification. Stored as `tasks.verification_none` (migration 170),
  which a CHECK keeps apart from a Verifier. `unassigned` is a Task with
  neither.

**Who may set `none`.** Only the Task's Shepherd or an administrator-class actor
(the roles act's own `shepherd` predicate), or the Account-control path for the
Task. Never an Agent, and never a principal of the guarded set G(Task) below,
on any basis: G is checked before the Account-control path, so a Main
connector that executes or implements the Task is refused
`VERIFICATION_NONE_CHAIN_GUARDED` even though it holds that path. A human
Account is never in G and keeps the Account-control path.
It is set at creation (`POST /tasks` with `"verificationNone": true`, which
displaces and audits an inherited Phase or Project default; refused beside
`verifierPrincipalId`), in the status the create lands the Task in, To Do or
Ideas (an explicit `ideas`, or the inbox-phase default when no status is
given), or on `PATCH /tasks/{id}/roles` with
`{"verificationNone": true}` on its own, while the Task is To Do and has never
started: `started_at` is unset and there is no `task.claimed` or
`handover.finish` entry and no execution lease. A current Verifier is cleared
in the same transaction and audited as displaced. A Project or Phase default
never sets it. A Blueprint Task may carry `"verification": "none"`; it takes
effect only when the instantiating caller is one of these actors.

**Clearing.** Assigning a Verifier clears `none` in the same UPDATE;
`{"verificationNone": false}` clears it too. Once cleared, it can never be set
again on that Task. Every set and clear writes one audit row
(`task.verification_none.set` / `.clear`: who, when, the basis and any
displaced default) and a `task.verification_mode` system entry in the Timeline.

**Finish.** `POST /tasks/{id}/finish` on a `none` Task completes it in the same
transaction, with the terminal effects of any move to `completed`: Subtasks in
Review are completed with the reason `verification: none`, the access vehicle
is detached, access requests are reaped, the lifecycle policy is asked and the
dependents receive `task.ready` (and the Connector `implement` ring). The
setter is re-checked first: when the stored setter shares a chain with the
finishing actor, the claimer or the execution connector and did not act on
the Account-control path, finish refuses `VERIFICATION_NONE_SELF_SET`. A move
to `review` on a `none` Task is refused `VERIFICATION_NONE_NO_REVIEW`, the
assigned-connector claim admits a `none` Task without a Verifier, and the
legacy unassigned-Verifier compatibility arm and the "no usable Verifier" machinery never apply to
it.

**The chain guard G(Task).** The execution connector's principal; every
principal that has ever claimed the Task (the `task.claimed` entry's
`metadata.assigneePrincipalId`) or authored a `handover.finish` on it, and the
current Assignee; every Agent ever bound to the Task as `implementer`, revoked
ones included; and the ancestors (stopping below the human Account) and
descendants of each of these. A human Account is never in G. The `verify` arm
of the exact Verifier refuses when the Verifier is not a person and is in G;
a human Account Verifier is never refused. The same predicate decides the
completion check, the reject/run gate, native review and the Connector wake's
`verify` ring.

**The `verifier-agent` arm.** A bounded exception to AZ-26, ratified through
C10 = B: an active, non-legacy Agent bound to the Task as `verifier`, whose
parent is the Task's `service` Verifier, minted under an active, unexpired
Warrant held by that parent, with neither the Agent nor the Verifier in G,
holds `read` and `verify` on that Task. It is a Task-role arm on the acting
identity in both evaluators, not a grant, and not capped by own() rules. An
Approval-minted Agent has no Warrant and never takes it.

### Default Verifier

A Project, and each of its
Phases, may name a **default Verifier** that new Tasks inherit.

- **Inheritance at creation.** Inside the creating transaction, after the
  inbox-phase decision and the Shepherd stamp: an explicit
  `verifierPrincipalId`, then the default of the Phase the Task lands in, then
  the Project default, then none. The role rows are written through the same
  role writer as `PATCH /tasks/{id}/roles`, capped by the creator as assigner
  (AZ-A10 clauses 1(c) and 5), and `verifierSource` records where the value came
  from: `explicit`, `inherited-phase`, `inherited-project`, or `assigned` (the
  roles route or a Blueprint). Clearing the Verifier clears the source. Tasks
  created before migration 155 carry `null` (unknown); nothing is backfilled.
- **Explicit at creation.** `POST /tasks` (and so `relayhall_task_create`)
  accepts `verifierPrincipalId` only when it equals the Project default or the
  default of a non-archived Phase of the same Project and that principal is
  usable; anything else is refused `422 VERIFIER_NOT_ALLOWED` and no Task is
  created. No other role field is accepted on creation.
- **Never a refusal for an inherited default.** A default that is not usable
  when the Task is created is left unset; the create answers `201` with a
  `DEFAULT_VERIFIER_UNUSABLE` warning naming the failed arm.
- **Never a reassignment.** Changing a default, or disabling, terminating or
  revoking the principal it names, never touches an existing Task. The usable
  predicate reports it instead.
- **Who sets a default.** `PUT /projects/{id}/default-verifier` and
  `PUT /phases/{id}/default-verifier`, never the generic `PATCH`, which the
  MCP plane reaches. A login session only (a bearer is refused `SESSION_ONLY`,
  audited), of root, an administrator, or the person who owns the Project (a
  Phase resolves to its Project's owner). The route ceiling is `authenticated`
  and the point stage asks `write`; the handler is the gate. Both routes
  answer a caller who can read the object but is not root, an administrator
  or the person owner with `403 DEFAULT_VERIFIER_REQUIRES_OWNER`, audited
  `denied`. On the Phase route that caller
  holds read on the Phase or read on its Project; a restricted Phase takes
  nothing from its Project, as for every read. The point stage still refuses
  such a request and hands it to the handler marked refused, so the handler
  can only refuse it: nobody gains an act. A caller who cannot read the object
  gets the concealed `404 RESOURCE_NOT_FOUND` on both routes, with no audit
  row. On a Group-owned
  Project only root or an administrator set it in v1 (AZ-A12 clause 6). A Group
  and a non-legacy Agent are refused as values by name, and the principal must
  pass arms 1-3 below at write time (`422 DEFAULT_VERIFIER_UNUSABLE` names the
  arm). Every write is audited `project.default_verifier.set` or
  `phase.default_verifier.set` with the previous and next value, the standing
  and the session; every refusal is audited `denied` with its code.

**The usable predicate** (`services/VerifierUsability.ts`) decides whether a
Task's Verifier can judge it. All four arms must hold: **principal** (set,
`active`, not a Group); **chain** (the delegation chain is alive: every link
active and, for a delegated principal, a live credential; legacy identities are
exempt as the evaluator exempts them); **scope** (`tasks:write` survives the
chain intersection on at least one live credential, one credential at a time,
never a union; an Account answers with its role-derived set); **independence**
(the Verifier is not the Assignee). There is no "paused" principal state:
pausing a Connector means disabling it or revoking its credentials, and the
chain arm fails. The same function answers the Review warning, the create
warning, the default write, the `verifierUnusable` list filter and the morning
census (that filter over To-Do and Review).

**Review without a usable Verifier is warned about, never refused**. A move into
Review (`PATCH /tasks/{id}`, `relayhall_task_move`), `POST /tasks/{id}/finish`
and a create directly in Review answer as before, plus `warnings[]` with
`VERIFIER_NOT_USABLE` and the failed arm; the text is folded into the existing
`warning` string. Each warning is audited `task.review.verifier_warning`.

**Consequences to know.** Because the Verifier must differ from the Assignee,
a Project's default Verifier cannot claim a new Task of that Project
(`self_review`) until a Shepherd or administrator changes that Task's
Verifier; a session that is both the worker and the default Verifier has its
claims refused. **Reopening** a completed Task does not re-resolve the default
and keeps `verifierSource`; the Verifier arm still grants `read` and `verify`
by identity. The AZ-A10 clause 7 role rows for the current holders are not
re-created on reopen today, for inherited Verifiers exactly as for assigned
ones; the repair of that gap covers both.

## Visibility and grants

Exact-id grants are evaluated before type-wide grants. `admin` implies all object actions and `write` implies `read`; `use` and `invoke` are separate capability verbs and never imply disclosure or mutation.

Point decisions and collection narrowing are two adapters over this same
order. The list adapter generates one SQL condition for the candidate ids and
composes the grants substrate's active-grant condition, including exact-id,
typed-wildcard and expiry semantics. It does not perform one authorization
query per row. Skills, Personalities and Services are shared registries for
authenticated readers; mutations still require their write/admin authority.

A Phase inherits its Project visibility by default. Exact and type-wide Phase
grants are additive: adding a grant never suppresses inherited access and never
changes policy mode. Confidentiality and deliberate blind-testing exceptions
use the explicit `PATCH /phases/{id}/access` admin operation with
`{ revision, restricted, reason }`. Restricted mode suppresses ordinary
inherited visibility, while applicable explicit grants still authorize access.
Project owners, administrators, and orchestrators retain oversight. Every mode
change is attributed in the append-only `phase_access_events` ledger; ordinary
Phase edits cannot change the mode.

Because a restricted Phase suppresses what its Project lends, reading a Project
never reads a restricted Phase in it. These surfaces ask the Phase read decision
for each Phase row, not the Project's: `GET /phases`, `GET /projects/{id}/phases`
(after the Project's own concealment, archived rows included only on
`includeArchived=true`), the Phase anchors of `GET /warrants/{id}/linkage`
(type and id stay, name and status are concealed), the Map's Phase identities
(`GET /tasks/graph`), project-altitude Briefs and the approvals hub view's Phase
names. A Project anchor of the same linkage asks the Project read decision the
Project lists ask and is concealed the same way. `listPointParity` measures
against PostgreSQL that both Phase lists answer exactly what `GET /phases/{id}`
answers for a Project reader with and without `phases:read`, an exact Phase
grantee and a Project owner; that the linkage names a Phase or Project anchor
only when its point route reads it; and that the Map carries no restricted Phase
of a readable Task.

A compiled Brief asks the same Phase read decision for the Task's Phase: the
task altitude (`POST /tasks/{id}/brief`, both formats, and
`relayhall_brief_compile` with a `taskId`) and the project altitude with a
`taskId` (`POST /projects/{id}/brief`). A caller the decision refuses (a caller
who holds the Task but not its Phase, a reader of the Project included) gets the
Phase's id, `"restricted": true` and one fixed sentence saying the Task sits in
a restricted Phase, and nothing of its name, goal or description. A grant on the
Phase is how that context is given. The decision is the shared one, unchanged:
an Agent's read defaults to its bound Task's context (the Task, its Phase and
its Project, on the acting identity), so an Agent bound to the Task reads that
Phase and its Brief shows it, exactly as `GET /phases/{id}` answers it. No actor
compiles fail-closed (the Phase is concealed), and a failed decision refuses the
compile (`503 PHASE_LOOKUP_FAILED`). `listPointParity` measures each altitude
and transport against `GET /phases/{id}` for the same caller.

One surface still returns a Phase's name without asking the Phase read
decision: the raw `GET /approvals` list (without `view`) returns an access
request's `relatedPhaseName` as read with the row, to the principals that list
already shows the request to (the requester and the principals it hangs from,
administrators for the kinds they decide, and root).

## Route coverage

The server has one protected-router registration funnel. A structural test fails if a protected mount bypasses the shared predicate or if the public allowlist grows without an explicit manifest edit. The deliberate public entries are the API root, health, authentication, pre-login configuration, the plugin proxy, and the public plugin Theme stylesheet.

Tasks, Projects, Phases, Reports, Skills, Personalities, and Services use point and list object authorization. The current Plugin registry is route-ceiling-only: it is keyed by manifest names while the grant store uses UUID object identifiers. The Phase-4 Plugin object conversion owns closing that declared seam.


## Knowledge writes (RB-11 Governor v0)

`knowledge-contents:write` is the knowledge plane's write verb, a separate
grant beside `knowledge-contents:read`: neither satisfies the other, and only
the three `POST /knowledge-writes/{propose,preview,commit}` routes require it.
It is role-derived like every mintable non-admin scope, so login sessions of
ordinary roles carry it, exactly as they carry the read scope.

**Agents (answer E2).** An Agent holds it only when its mint names it
explicitly, inside the requesting Connector's own effective set (the T2
ceiling, `MINT_EXCEEDS_REQUESTER`). It is not in the Agent-layer exclusion set
that keeps `knowledge-contents:read` off Agents, and it is never inherited: an
Agent minted without it is refused at the route. An Agent always writes in its
bound Task's context. **E2 binds edits too:** no edit in place adds the
scope to an Agent credential — root included — on the session door, the
decide of a filed request or the agent's door; each is refused
`AGENT_SCOPE_MINT_ONLY` with a denied audit row, and an Agent that needs the
scope is a fresh mint that asks for it. A Connector credential may still gain
it by edit in place.

**The write arm set**, evaluated per act before anything is signed: the caller
principal is active and resolves to an Account; a credential or a live login
session is present; the write scope is held; the source is live and
knowledge-capable; the source is visible to the caller and inside the caller's
`service` selector (the read rule, administrators included, `root` excepted);
and the source is write-capable (an owner-plane write endpoint, claims mode
`asserted`, and a descriptor write block). Every failure but the last is one
uniform `refused`; a source the caller can read that accepts no writes is
`source_not_write_capable`.

**What the core attests.** The signed write assertion names the Account (by
pairwise subject), the verb, and the Task context the core verified itself. The
source decides which compartments that Account may write and who will read the
note; the core enforces who is asking, never where the note may go.

**Fail closed.** The write audit is the opposite of the read audit: a row that
cannot be written fails the act, and the source is not dialed. Preview and
commit are bound to the principal that proposed, by the core's own audit row.

## Shared-area writer list

A knowledge source's organisation-wide **shared area** is readable by everyone
the source admits; only the Accounts on its **writer list** can write it. The
list is a governed core object, one per knowledge source and scope (today only
`organisation`), and the core delivers it to the source inside the signed
lifecycle snapshot (`shared_writers`). An empty list means nobody writes the
shared area.

**Who may read it.** `GET /knowledge-shared-writers` is a `services:read`
disclosure: every human role holds the scope, and a Connector or Agent holds it
only when granted. It answers the source, the scope, each listed Account's id
and label, and `youCanWrite` for the caller's own Account (the chain-root
Account of a Connector or Agent). The provenance of each row (who added it,
when, the reason, the expiry) is the administration view, answered only to the
sessions that may change the list.

**Who may change it.** Adding or removing an Account is a **login-session act
for root or an administrator** (`admin`, `operator`, `orchestrator`): the route
ceiling is `authenticated` and the handler decides, because the gate is the
authentication kind plus a role, which a scope string cannot say, and because an
`operator` holds no `root`. A bearer credential or an API key is refused
`SHARED_WRITER_REQUIRES_SESSION`; any other session
`SHARED_WRITER_REQUIRES_ADMINISTRATOR`. Both refusals are audited. **No Access
profile reaches it:** its Access surface, "Shared-area writers"
(`settings.shared-writers`), is registered `always-self` like the Access
manager, so the Access-surface arm is never consulted for it and no Access
bundle names it. It is not `locked`, because a locked surface is root-only and
the ruling admits an administrator.

**Every change** names an Account (a parentless, active human; a Connector, an
Agent, a Group or a service identity is refused `SHARED_WRITER_NOT_AN_ACCOUNT`,
and a database trigger refuses them too), carries a reason of 20 to 2,000
characters, and burns a **step-up** bound to `knowledge.shared-writer.add` or
`knowledge.shared-writer.remove` and that Account, in the same transaction as
the write. Every refusal runs before the step-up is spent. Each change writes
one `audit_events` row (`knowledge.shared_writer.add` or `.remove`) with the
list before and after, the reason and the step-up token id, and sends an id-only
notice to the enabled notification endpoints.

**Expiry.** A row added directly never expires unless the administrator sets
`expiresAt`. A row past its expiry is gone from the list
and the snapshot at once; the 60-second sweep removes it and audits the removal
as actor `system` (`knowledge.shared_writer.expire`).

**What the source receives.** The snapshot names only Accounts that are also
exported, active, human Accounts in the same snapshot, so a listed Account the
export does not carry, or one disabled since, is simply absent and never makes
the source refuse the snapshot. The exporter renews the snapshot every 15
seconds and the source reads it every 5 seconds, so a change takes effect in
about 20 seconds, at the next write verb after that.

**Over MCP** an agent can only read the list
(`relayhall_knowledge_shared_writers_list`); no tool changes it. **Asking to be
added** is a change request of target type `knowledge.shared_writer`: a
Connector files it on `POST /delegation/access-requests`, root or an
administrator approves it with one step-up, and the row it adds names its
approval and always expires. The MCP filing action is `relayhall_access_request`
with kind `change`.

## Change requests (the universal change request)

Every authority change a person can make in Settings is also requestable as
an Approval of kind `change`, for any Account or Group the filer may name
(design ratified; migration 158; the first targets are `grant.rows`,
`grant.edit`, `grant.revoke`, `credential.scopes`, `credential.issue`,
`knowledge.compartment` and `knowledge.shared_writer`). Filing changes no
authority.

**Standing to ask** is computed live from the filer's chain-root Account: root
and an administrator (`operator`) may name any grantee and any target; an
ordinary user names its own Account, within its role's ceiling, for the
targets open to it (rows on objects, credentials of its own Connectors, a
compartment read on a Project it can read). A Connector or Agent files within
its Account's tier. The owner tier (a Project person owner or a Group owner)
decides and files within its scope.

**What a filing may name.** Every object a change filing names is read through
the filer's own live authority, and one it cannot read is answered exactly as
an absent one (the point-stage rule above): a compartment's Projects, a
grant's resource object and a knowledge source by the object read decision; a
principal-plane object (an Account or Group grantee, a credential's holder, a
target Connector, a grant's grantee) as its own inside the filer's Account
subtree and otherwise by the directory read (`principals:read`, never for an
ordinary user). The refusal is `TARGET_NOT_FOUND` for a target and
`GRANTEE_NOT_FOUND` for a grantee, with the same body either way. `grant.rows`
names objects the filer may not yet read, since that is what it asks for: it
files on an unreadable object exactly as on an absent one, and the held-row
check and the `before` rows read only the objects the filer reads.

**Who decides.** A login session only (`SESSION_ONLY` for a bearer), with one
step-up bound to (`approval.decide`, id): root or an administrator login
session, and a ROOT session alone for `grant.edit` and `grant.revoke` (the
`/grants` surface keeps `root` on every method). The decider must still be an
active, non-legacy Account acting as itself, and is refused
`SELF_DECISION_REFUSED` when its Account or a principal under it is the
requester's Account, the grantee or a member (by any source) or steward of a
Group grantee, the target principal, or a principal the approved change
names; root is not exempt. The decision applies the change through the
executor of the direct act with the decider as the standing principal; that
executor accepts the decision's own consumed step-up as its evidence and never
consumes a second token.

## Human archive and restoration

A current active parentless human Account may file a Task with its canonical
Task WRITE authority and a live login session. Archive is not independent
approval: ordinary `user` Accounts retain their existing automation role and
cannot complete new work. The manager checks session expiry/revocation and
snapshot ceilings, the current Account role, and exact object authority after
locking the Task. Viewer, unknown, retired, Agent, Connector and service
identities receive no human exception. No grant or role is created by filing.

The exception accepts only an archive status and optional archive reason;
mixed assignment, arming, child or completion edits retain their usual guards.
Single archive, bulk archive and status PATCH share the transactional writer.
Denied bulk entries remain concealed and unchanged. Completed-only bulk archive
rechecks that source state under the same write lock; a concurrent move back to
Review or To Do returns `NOT_COMPLETED` without filing the now-ineligible Task.
The single archive operation retains its supported any-status behavior.

Supported undo derives the prior state from server-written archive history
under the same lock. It does not accept a client-selected target or restore
marker. Restoring a prior canonical Completed state preserves its original
completion timestamp (including a legacy null), review history and child
history; it does not manufacture or demand a new verdict. The completed archive
disposition must agree, but a disposition inferred only from finished children
is not proof of prior whole-Task completion. Missing or contradictory history
returns `TASK_RESTORE_PROVENANCE_REQUIRED` without writing. Active archive
metadata is cleared on undo, while attributed history is retained. Ordinary
new completion remains subject to the independent Verifier checks.

Restoration uses the unique newest status-history transition, which must enter
Archived. It never skips a later status change to reuse an earlier archive cycle.
Missing, tied or undated latest status evidence causes a typed refusal, including
when archive disposition was inferred from completed children. This compares
history within its database clock; it does not equate application and database
timestamps or invent a new completion verdict for legacy work.
