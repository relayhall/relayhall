# Authorization

Every protected RelayHall API route passes through one shared authorization predicate after authentication. Route-family scopes are ceilings; object authority is then evaluated consistently for point reads, mutations, and lists.

## Account roles

Choose the least powerful role that fits the Account's work. A role limits the
actions an identity can perform; it does not automatically give every Account
access to every object. Ownership, grants, visibility, Task assignments,
credential scopes and delegation restrictions also apply.

| Role | What to use it for | Important limit |
| --- | --- | --- |
| **admin** | Human administration, including credential management and assigning any role. | Elevated access; reserve it for trusted administrators. |
| **operator** | Administering product objects and managing ordinary Accounts. | Cannot assign admin or orchestrator, or use root-only settings and credential issuance. |
| **editor** | Creating and changing objects the Account is permitted to work on. | Same working permission ceiling as user; object authority is still required. |
| **user** | Everyday work on permitted objects. | Same working permission ceiling as editor; the name is not an additional access tier. |
| **viewer** | Reading permitted objects without editing them. | Read-only object scope; grants do not turn it into a writer. |
| **orchestrator** | Elevated automation and coordination requiring root-level scope. | Only an admin can assign this role. An orchestrator cannot assign admin or orchestrator roles. |
| `reviewer` | Reviewing work and recording evidence. | Working permission ceiling; the role alone does not make the Account every Task's Verifier. |
| `qa` | Quality checks and test evidence. | Same working permission ceiling as `reviewer`; verification follows the same Task rules. |
| **agent** | Automation that performs assigned work. | Working permission ceiling; credential and delegation limits still apply. |

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

## Evaluation order

Authorization is evaluated in this order:

1. authentication and credential scope ceiling;
2. Principal role ceiling;
3. administrator or object-owner authority;
4. Task roles: Assignee (`claimant`), Shepherd, and Verifier;
5. initiator read access from server-written provenance;
6. exact and typed-wildcard grants, excluding expired grants;
7. authenticated-read visibility (`shared`, `public`, and Report `default`).

A deny on a point read is concealed as not found. A denied mutation returns a stable forbidden error. If the server cannot evaluate object authority, it fails closed instead of allowing the request or returning exception detail.

`root` is the global scope sentinel. Every identity path carries an explicit scope set: principal credentials retain their minted scopes, the legacy service key receives working-plane service scopes without admin/root, and JWT/session identities receive scopes from the trusted role source. Orchestrator/admin identities receive root; operators receive live object-family scopes without root; working roles receive live read/write/use/invoke scopes without admin; viewers receive read scopes only. Missing scopes and unknown session roles fail closed.

The dashboard JWT remains an identity token rather than a capability token: it does not accept a caller-supplied scope claim. After signature and Principal resolution, the server derives its explicit scopes from the Principal role. Current login sessions leave `role_snapshot` null and follow the stored Principal role. The resolver also supports a non-null server-written snapshot as a role ceiling, but current login paths do not mint one.

## Task roles

Task-role identifiers are server-written:

- `ownerPrincipalId` is the `claimant` identifier, labelled **Assignee** in the UI. The Assignee can read, work, finish, and release the Task.
- `shepherdPrincipalId` is the **Shepherd**. The Shepherd can read, release, and use the dedicated role-assignment surface. Every Task names one.
- `verifierPrincipalId` is the **Verifier**. The Verifier can judge completion but cannot do the Assignee's work.

The database and claim operation both refuse an Assignee who is also the Verifier. Tasks created before assignable Verifiers have a bounded compatibility window: a legacy Verifier-capable identity may judge them only while `verifierPrincipalId` is null. Once a Verifier is assigned, exact Principal identity is required.

Generic Task creation and update reject all Task-role Principal-id fields. A Shepherd or administrator uses:

```http
PATCH /tasks/{task-id}/roles
Content-Type: application/json

{
  "shepherdPrincipalId": "...",
  "verifierPrincipalId": "..."
}
```

The Verifier may be cleared with `null`; the Shepherd may not be cleared. Every assigned identity must be an active Principal. Assigning a Service Principal as Shepherd additionally requires `services:invoke` or `root` for scoped credentials.

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

## Route coverage

The server has one protected-router registration funnel. A structural test fails if a protected mount bypasses the shared predicate or if the public allowlist grows without an explicit manifest edit. The deliberate public entries are the API root, health, authentication, pre-login configuration, the plugin proxy, and the public plugin Theme stylesheet.

Tasks, Projects, Phases, Reports, Skills, Personalities, and Services use point and list object authorization. The current Plugin registry is route-ceiling-only: it is keyed by manifest names while the grant store uses UUID object identifiers. The Phase-4 Plugin object conversion owns closing that declared seam.
