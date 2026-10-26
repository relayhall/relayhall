# RelayHall API — usage notes

_Last updated: 2026-08-03. Machine-readable spec: `GET /openapi.json` (auth required)._

## Basics

- Public base: `https://<your-domain>/api` (nginx strips `/api`; backend routes have no prefix). Direct backend: `http://localhost:3001/`. Dev stack: `/api/dev`.
- Auth: `Authorization: Bearer <JWT>` on everything except `/health`. Principal API keys (`rh_live_…`/`rh_dev_…`) ride the same header; the env prefix must match the stack.
- Task ids in URLs must be **full UUIDs** — 8-char prefixes are resolved client-side by the CLI only (`INVALID_TASK_ID` otherwise).
- Skill ids in URLs must be full UUIDs too, and a Skill Version reference a Version UUID or a Version number, so once authorization admits the request a Skill name in place of its id answers `400 INVALID_SKILL_ID` (`400 INVALID_SKILL_VERSION_ID` for a malformed Version reference) instead of a `500`, an id that names no Skill you can read still answers `404`, and `GET /principals/{id}/credentials` and `POST /principals/{id}/terminate` refuse a non-UUID id with `400 INVALID_PRINCIPAL_ID` after their authority check.
- Project ids in URLs must be full UUIDs: a Project name, or any other id that is not a full UUID, answers `400 INVALID_PROJECT_ID` on every `/projects/{id}` route before anything reads it (a caller the route ceiling refuses keeps its `403`; no name is resolved to an id), and a malformed Resource or pinned Skill id under a Project answers `400 INVALID_RESOURCE_ID` / `400 INVALID_SKILL_ID`.
- On every Task route an 8-character Task id prefix (or a malformed `dependencies/{depTaskId}`) answers `400 INVALID_TASK_ID`, and a malformed Lease id `400 INVALID_LEASE_ID`.
- `PATCH` and `DELETE /personalities/{id}` take the Personality id and answer `400 INVALID_PERSONALITY_ID` for every non-UUID name before object lookup, after the root authority check; fixed route words are case-insensitive and an optional trailing slash is accepted without folding the identifier, unknown UUIDs retain `404`, and `GET /personalities/{id}` still reads by id or slug.
- Identity-provider routes answer `400 INVALID_IDENTITY_PROVIDER_ID`, `INVALID_IDENTITY_LINK_ID` or `INVALID_GROUP_ID` for a malformed provider, link or login-group id.
- Credential reveal, revoke and rotate answer `400 INVALID_CREDENTIAL_ID` for an id that is not a full UUID, after their authority check.
- `DELETE /notification-endpoints/{id}` answers `400 INVALID_NOTIFICATION_ENDPOINT_ID` for an id that is not a full UUID.
- `GET /appearance/asset-versions/{id}` answers `400 INVALID_APPEARANCE_ASSET_ID` for an id that is not a full UUID, and an Appearance revert Version number past 2147483647 `400 INVALID_VERSION`.
- `DELETE /auth/sessions/{id}` answers `400 INVALID_SESSION_ID` for an id that is not a full UUID.
- The OAuth consent read and decision answer `400 invalid_request` with `code: INVALID_AUTHORIZATION_REQUEST_ID` for a request id that is not a full UUID.
- A Charter or service descriptor Version number past 2147483647 (an integer column) answers `400 INVALID_QUERY_VALUE`; a service descriptor Version is checked after the route scope ceiling and before the Service point lookup, including case variants of fixed route words and an optional trailing slash.

## Local administrator recovery and audit

- `POST /auth/login` is the stable local-administrator break-glass path. It
  depends on the configured local password hash and the RelayHall database,
  never on OIDC or an external identity provider. A successful invocation is
  written to the audit ledger before the JWT is returned; if that write cannot
  complete, login fails closed with `503` rather than minting an unaudited
  session.
- `GET /audit` requires `audit:read` (or `root`). It is keyset-paginated:
  `limit` is 1–200 and a response `nextCursor` is supplied as the next
  request's `before`. Exact filters: `action`, `actorPrincipalId`,
  `resourceType`, `resourceId`, and `outcome` (`success` or `denied`).
  `actionPrefix` matches the head of an action, so one family can be read at
  once — it is a literal prefix and never a pattern, so an underscore in it
  matches an underscore. `since` and `until` are UTC ISO-8601 instants
  bounding a **half-open** window `[since, until)`, so adjacent windows tile
  the ledger exactly once. A malformed value, a date the calendar does not
  have (`2026-02-30`, `2026-02-29`, `2026-04-31`), or a window whose `since`
  is not earlier than its `until`, is refused with `400` rather than answered
  with an empty page: an unanswerable question and an empty ledger must not
  look alike on an audit surface. Note that a date is validated by comparing
  every component back against the parsed instant, because `Date.parse` does
  not reject an impossible calendar date — it rolls it forward, which would
  answer a question about a different day than the one asked. The Audit log
  page in the dashboard reads this route and no other.
- Audit retention is **indefinite** in v1. The table rejects update, delete and
  truncate operations; the API has no audit mutation or purge route and no
  purge job ships. Use `relayhall audit export --output audit.ndjson` for a
  durable NDJSON export (existing files are not replaced without `--force`).
- Successful local-admin logins, grant changes, webhook-subscription CRUD,
  subscription-class Service configuration, task arming, credential
  mint/rotation/revocation, and administrative task lifecycle overrides are
  recorded. Secrets and webhook endpoint values are excluded from audit
  metadata.
- Every Skill Version publication is recorded as `skill.publish` against the
  Skill (`resourceType: "skill"`, `resourceId` the Skill id), with metadata
  `{ skillVersionId, version, previousStatus, status, previousPublishedVersionId,
  contentSha256 }`: the Version published, the status it left, the Version it
  replaced as the published one (`null` for a first publication) and its
  content digest. The publish note is never recorded. The row is written in
  the publication's own transaction, so a refused or failed publication
  leaves no row.
- Every Skill owner assignment (`PUT /skills/{id}/owner`) is recorded as
  `skill.owner.change` against the Skill, with metadata `{ oldOwnerPrincipalId,
  newOwnerPrincipalId, reason }`, plus the Group transfer fields
  (`oldOwnerKind`, `newOwnerKind`, `groupMemberCountAtTransfer`,
  `stepUpTokenId`, `stepUpMethod`, `deciderStanding`, `chain`) when a Group is
  involved. The row commits with the write; a refused assignment is recorded
  as a `denied` row of the same action.

## Identity & assignment (Phase 1, board reference 60558599)

Task work separates three server-controlled roles: the Assignee (claimant),
the Shepherd and the independent Verifier. `POST /tasks/{id}/claim` and
`/release` own Assignee changes. `PATCH /tasks/{id}/roles`
`{shepherdPrincipalId?, verifierPrincipalId?}` is the only generic role
assignment surface; ordinary Task create/update rejects these identifiers.
The caller must be the Task's Shepherd or an administrator. The Verifier must
differ from the Assignee, and assigning a Service Principal as Shepherd also
requires `services:invoke` (or `root`).

The execution assignment follows the same rule. `executionServiceId` and
`executionDescriptorVersion` are fields a Task read reports (the Connector the
Task is assigned to, and the descriptor version it is pinned to); they are
never request fields. They are written only from an `executionProfile`, after
the `services:invoke` check and validation against the Connector's pinned
descriptor (see [execution profiles](execution-profiles.md)). `POST /tasks` and
`PATCH /tasks/{id}` refuse a body carrying either key with
`400 SERVER_WRITTEN_FIELD`, naming the key in `details.field`, which is the
refusal the role identifiers get; `PATCH /tasks/batch` refuses them as
`400 UNSUPPORTED_BATCH_FIELD`; and `POST /tasks/{id}/recover` reads only its
named fields, so either key there has no effect. Over MCP,
`relayhall_task_create`, `relayhall_task_update` and `relayhall_task_recover`
refuse them as unknown arguments before dispatching to REST.

The same refusal now covers every server-written column of a Task, not only
these: see [Task create and edit fields](#task-create-and-edit-fields).

- `GET /principals` — identity anchor rows (id, kind, handle, role, …; metadata never exposed). `503` until migrations 062/063 apply. **Group principals are left out** (AZ-A12): pass `?kind=group` to list them. `?kind=` takes `human`, `agent`, `service` or `group`; any other value is `400 INVALID_PRINCIPAL_KIND`. `includeHidden=true` never adds Groups.
- `GET /principals/me` — the caller's resolved principal + scopes; `404` until a principal resolves for the identity (expected for legacy JWTs pre-migration).
- `GET /tasks?owner=<handle>|mine=true|unassigned=true` — Assignee filters on `tasks.owner_principal_id` (the identifiers keep their historical names). `mine=true` returns `[]` when the caller has no principal; all three answer `503` pre-migration.
- `POST /tasks/{id}/claim` / `POST /tasks/{id}/release` — Assignee-set writes. Claim is idempotent for the current Assignee, `409` when another principal is already the Assignee; release requires being the Assignee (orchestrator role may force). A claim's `200` carries `claim.outcome` (`claimed`, or `already_assignee` for the accepted retry); every refusal carries `details.reason` in the vocabulary of the Task's `lifecycleAccess.claim.reason` (`409 TASK_ALREADY_ASSIGNED` when another principal holds it) and writes a Refused `task.claim` audit row. See [who the claimant is](TASK-REPORT-WORKFLOW.md#who-the-claimant-is).
- `POST /principals` `{handle, kind, displayName?, purpose?}` — create an **Account**: a parentless human or service principal (A17.1). `kind=group` is refused like any other kind outside `human`/`service`/`agent`, and a handle starting `group:` is refused by name (`400`, "The group: prefix is reserved for Group principals"): Group principals are created only with their Group. `purpose` is **required** for service Accounts (`422 PURPOSE_REQUIRED`); `kind=agent` is refused (`422 AGENT_MINT_ONLY` — Agent identities arrive only through the delegation machinery). Reserved seed handles and anything starting `agent:` are refused (a hand-made `agent:` handle would collide with a spawn principal and capture that task's attribution).
- **A Group principal is managed only through `/groups`.** Every `/principals/{id}` mutation below — `PATCH /principals/{id}`, `POST /principals/{id}/role`, `POST /principals/{id}/credentials`, `PUT` and `DELETE /principals/{id}/password`, `POST /principals/{id}/terminate` and `PUT /principals/{id}/home-group` — refuses a Group principal with `422 GROUP_PRINCIPAL_MANAGED_BY_GROUPS` before any other check, and records the refusal as a `principal.mutation_refused` audit row (`outcome: denied`, metadata `{refusal, route, targetPrincipalId}`). A person or service id answers exactly as before. The kind is resolved by the id in SQL, so an uppercase id is refused too.
- `PATCH /principals/{id}` — display name and `status`. **Disabling is the kill switch**, without touching the credential rows: the principal's `rh_` keys stop authenticating on the next request, and its dashboard JWTs stop working too — including on the WebSocket stream, the plugin proxy and the capability-cookie mints. Two caveats worth knowing: the legacy shared env keys (`RELAYHALL_API_KEY` and friends) are *not* affected, because they authenticate by env comparison rather than by principal; and a status change made directly in the database rather than through this endpoint can take up to 60 seconds to bite, because principals are cached for that long. The owner identity (`dashboard_user`) and `system` cannot be disabled through the API at all. A disable also revokes every stored login session of the principal (`disabled_user`) and lapses every pending request naming it as grantee (`GRANTEE_DISABLED`) in the same act, and the `principal.update` row records `sessionsRevoked` and `lapsedApprovalIds`; an approved `identity.status` change request runs the same seam (see *Change requests*).
- `GET /principals/{id}/credentials` — listing; secrets are never included.
- `POST /principals/{id}/credentials` `{label, scopes[], expiresAt?, transport?}` → `201 {keyId, secretOnce}`. **`secretOnce` appears in this response and is never logged.** Since AZ-S3 the secret is also stored encrypted at rest and can be RE-REVEALED under the lineage/step-up rules of `POST /credentials/{id}/reveal` — see the delegation section. Targets must be Connector/Agent layers: Accounts are keyless (`ACCOUNTS_ARE_KEYLESS`).
- `PATCH /credentials/{id}` `{scopes?, transport?, stepUpToken?, lifetime?, reason?, narrowAgents?}` — **edit a Connector credential in place** (AZ-A13). The row keeps its id, key and secret, and the very next request with the same token carries the new authority, so nothing changes on the client. Removing access saves at once; adding access needs a step-up. See [Editing in place](#editing-in-place-az-a13).
- `POST /credentials/{id}/revoke` — effective on the very next request; idempotent.
- `POST /credentials/{id}/rotate` `{graceHours?}` → a replacement key with the same label and scopes. The old key's expiry becomes the **earlier** of its current expiry and now+grace, so rotating can only ever shorten a credential's life. Rotating a revoked credential is refused. Rotation stays an exact copy: change the scopes or the transport pin with `PATCH /credentials/{id}`.

### Scopes

Scopes are `<plural-object>:<verb>`; the five verbs are grouped by kind of
consequence (vocabulary §5.1): `read` is disclosure, `write` changes board
state, `use` fetches capability text into a context, `invoke` causes execution
outside the board, `admin` is delete/grant/force. **Mintable today** (each has
a live surface): `tasks:read` · `tasks:write` · `tasks:admin` ·
`projects:read` · `projects:write` · `projects:admin` · `reports:read` ·
`reports:write` · `reports:admin` · `personalities:read` ·
`personalities:write` · `personalities:admin` · `principals:read` ·
`principals:admin` · `skills:read` · `skills:write` · `skills:admin`
(the Skills surface, A14.1: `read` for GET, `write` for POST/PUT, `admin` for
DELETE) · `phases:read` · `phases:write` · `phases:admin` (the Phase object:
`read` for GET, `write` for create/update/archive/unarchive, `admin` for
DELETE — see [phases.md](phases.md)) · `skills:use` (exact full SKILL.md
fetches) · `services:read` · `services:invoke` · `services:write` ·
`services:admin` (the Service/Connector registry, RH-P2.1/P2.2) ·
`audit:read` (the append-only ledger, RH-P2.7) · `telemetry:write` (the
presence/telemetry ingest verb — AUTHZ A17.7, the `status:write` successor,
minted at AZ-S6) · `knowledge-contents:read` (the knowledge plane's disclosure
verb, A21: the queryable set, search and get; excluded from Agent-layer mints by
default) · `knowledge-contents:write` (RB-11 Governor v0: propose, preview and
commit a note through the door — a separate grant that the read scope never
satisfies, mintable onto an Agent only when the mint names it explicitly, inside
the parent's own grants, and never added to an Agent credential by an edit
(`AGENT_SCOPE_MINT_ONLY`); see [Knowledge
writes](#knowledge-writes-rb-11-governor-v0)) · `root` (the global sentinel:
satisfies every check). The remaining ratified scopes (`tools:read`,
`tools:invoke`, `blueprints:*`, `personalities:use`) ship in the vocabulary but
cannot be minted until their objects land — the Tool object surface and the
Blueprint object do not exist yet.

Charter reads (`GET /projects/{id}/charter` and its version routes) are
ordinary project disclosure under `projects:read`. Charter WRITES
(`PUT /projects/{id}/charter`) are owner-plane: they sit behind the `root`
sentinel, deliberately not the mintable `projects:write` — agents propose
Charter changes through Reports, the owner applies them. See
[charter.md](charter.md).

`POST /projects/{id}/charter/approve` is the existing named human Project
owner/admin act under `projects:write` and its current authority checks. Every
successful approval (including unchanged content) atomically records one
`charter.approve` event: authenticated actor, Project resource and metadata
`{charterVersion, sha, previousVersion}` only. `sha` identifies the stored
Charter content; text is never included. First approval has a null previous
version. Refusals with an authenticated actor record outcome `denied` with
all three metadata fields null; the existing response and no-write result
remain. Audit insert or approval commit failure cannot leave approved Charter
state without its successful receipt. This adds no pending Approval state or
authority. See [Charter behavior](charter.md#behaviour).

**The Group-owner arm (LENSES-c gate (i)).** On a Project whose
owner is an **active Group**, an Account holding a **live owner** row in that
Group also approves, on a login session, with a step-up minted through
`POST /auth/step-up` for `action: "charter.approve"` and the Project id, sent
as the body's optional `stepUpToken`. This arm runs only after the
administrator check has refused, so administrators and the person owner approve
exactly as before, without a step-up. Without a valid token the owner is
refused `403 STEP_UP_REQUIRED` with the `stepUp` challenge. A manager, an owner
whose row is inert, and an owner of a disabled Group are refused
`403 CHARTER_APPROVAL_FORBIDDEN`. The arm's `charter.approve` row adds
`{projectId, owningGroupId, standing: "group-owner", stepUpTokenId}`. Every
refusal on a Group-owned Project that reached the arm adds
`{refusal, projectId, owningGroupId, standing}` to its `denied` row: the
arm's `CHARTER_APPROVAL_FORBIDDEN` (a manager, an inert owner, a disabled
Group), its `STEP_UP_REQUIRED`, and a refusal after the arm admitted (the
content or the `If-Match` revision), whose rollback returns the token. A
refusal on any other Project keeps the three null fields.

Compiling a phase brief (`POST /phases/{id}/brief`) requires `phases:read`
**and** `tasks:read`: the route family rule covers the phase, and the extra
requirement is checked in the handler because the output discloses task
content. See [phases.md](phases.md).

Phase create (`POST /phases`) and update (`PATCH /phases/{id}`) accept an
optional `description`: text of at most 20,000 characters, or `null` to clear
it. Omit it on update to preserve the current value. Phase get and list return
the field under the existing `phases:read` gate. Task Briefs quote it beside
the Phase goal in the Goals block; the Phase brief also quotes it as data.
A Task Brief (and a project brief with a `taskId`) shows the Task's Phase only
to a caller who may read that Phase: for any other caller
the Goals block carries the Phase's `id` with `"restricted": true` and one
sentence saying the Task sits in a restricted Phase, and omits its name, goal
and description. See [authorization.md](authorization.md).

Compiling a Brief is a disclosure act: `POST /tasks/{id}/brief` requires
`tasks:read` (the former `tasks:prompt` scope retired into it; migration 070
rewrites stored keys). The Brief family is one verb, one noun and four
altitudes — `POST /tasks/{id}/brief`, `POST /phases/{id}/brief`,
`POST /projects/{id}/brief` and `POST /principals/me/brief` (the session
brief, which is also what marks a credential bootstrapped). RH-P3.C4 retired
the pre-A7 `/tasks/{id}/prompt` and `/projects/{id}/generate-brief` spellings
and the `prompt` response key; none of them is aliased. The session brief is
a self-identity read: any authenticated credential compiles its OWN, with no
scope, because that call is the bootstrap. The Task, Personality, Report and
skill-index content it encloses requires `tasks:read` (or `principals:read`) as
well as the caller's grants on each piece; a credential with neither receives
its identity and the doctrine only. Reading other principals stays behind
`principals:read`. No Brief route executes an agent. Hard removal is
the `admin` verb: `DELETE /tasks/{id}` and `DELETE /reports/{id}` require
`tasks:admin` / `reports:admin` rather than the routine write plane.

MCP initialization instructions, session, Task and Phase Briefs, and individual
MCP Task/Phase reads include the same built-in workflow guidance. The concise
MCP reads place it outside quoted board data; detailed reads retain their JSON
entity envelope and add a top-level `workflowGuidance` string. REST entity GET
responses are unchanged. It tells workers to keep progress and evidence on their
finite Task and linked Report, use claim and lease operations only for native
assignments, and hand completed work to an independent Verifier. It tells
orchestrators to discover bounded work from current Task, dependency and Report
records, and to stop only the action affected by a missing credential or
unresolvable dependency. The guidance does not grant scopes or replace current
owner decisions; board free text remains untrusted data.

Telemetry ingest (`POST /telemetry/frames`) requires `telemetry:write`
(AUTHZ A17.7 / §9.1): each service writes only its own
frames — the frame's owner is always the calling principal, recorded
server-side, and the body cannot name one. MCP-derived sessions keep that rule:
the MCP server records a caller's session and Task-link frames under the
caller's own chain, never under a principal any argument names, and only for a
Connector whose descriptor declared a telemetry tier; it is not ingest, so it
does not ask for `telemetry:write`. Telemetry reads stay `tasks:read` on their
existing task-read surfaces; there is no `telemetry:read` scope until a
dedicated read surface exists, and every `/telemetry` path other than the ingest
route is unmapped and fails closed to `root`.

A frame that names a `taskId` counts as that Task's activity only when its
writer is the Task's current Assignee, the Task is `in-progress` and, when the
Task names an assigned connector Service, the writer is that Service's
principal. The receiver stamps such a frame with the current assignment epoch
(any stamp the caller sent is removed) and stores every other frame unstamped,
so a reassignment (even away and back) retires every earlier observation.
`GET /tasks/activity?ids=<up to 100 Task UUIDs>` is the read surface the board
and Task details use: `tasks:read`, the shared batched Task read predicate
(ids the caller may not read are omitted, never named), `Cache-Control:
no-store`, and per Task only `taskId`, `state` (`active | idle | stale |
unknown`), `kind` and `receivedAt`. `stale` derives from server-clock age of
nine minutes; `unknown` means no current attributed observation; a failed read
is `503 TASK_ACTIVITY_UNAVAILABLE`, which the dashboard shows as
*Unavailable*. See `docs/contracts/task-activity-v1.md`.

**Re-issue runbook (070 cutover).** Keys issued before the re-cut are
rewritten in place (`admin`→`root`, `tasks:prompt`→`tasks:read`,
`sessions:read`→`tasks:read`), but keys that relied on the retired bundles
need re-issuing with the precise new scopes: a key that read `/personalities`
via `tasks:read` now needs `personalities:read`; a key that listed principals
via `tasks:read` now needs `principals:read`; delete-capable automation needs
the `:admin` verb of its object.

`GET /openapi.json` requires authentication but no particular credential scope,
so every authenticated principal can discover the API contract.

Enforcement: **every identity path is scope-checked on every request.** A route with no scope mapping requires `root` — the map fails closed, so a gap shows up as a 403 on that route rather than as silent over-permission. Paths are normalised (case, trailing and duplicate slashes, query string) before matching, because Express treats `/steer`, `/steer/` and `/STEER` as the same route and a spelling-sensitive rule would let the others fall through to a weaker one. Principal keys retain their minted scopes; the legacy service key receives explicit working-plane service scopes without admin/root; JWT and session identities receive explicit scopes from their trusted Principal role or session role snapshot. Missing/null scopes fail closed.

Who may manage: any identity with explicit `root`. Dashboard JWT/session identities gain it only from the trusted `orchestrator` or `admin` role source; caller-supplied JWT scope claims are not accepted. A non-root key cannot mint a more powerful key. Role is bounded too: only an `admin`-role issuer may create a principal with the `admin` or `orchestrator` role, since role decides authority just as directly as scope does.

**What note attribution does and does not guarantee.** `notes` is a single mutable TEXT column. Treat its contents as advisory display, never as evidence.

- `POST /tasks/{id}/notes` appends a server-written `[timestamp] handle:` header and indents your text beneath it. The indentation is a *display* convention: it stops an appended note from looking like a separate attributed entry in the dashboard, which renders with `white-space: pre-wrap` (only LF and CR break a line there). It is not a security control.
- The text is **not** tamper-proof. Any `tasks:write` caller can set or rewrite the whole column via `POST /tasks`, `PATCH /tasks/{id}`, `PATCH /tasks/batch`, or by supplying an `archiveReason`; the CLI's own `create --notes` and `update --notes` use the first two. A caller can therefore forge a header, or erase earlier entries.
- What *is* recorded: every one of those paths writes a `task_history` row with `field=notes` carrying `actor_principal_id`, taken from the authenticated request and not settable from the body or a header. So the text can be forged, but a change cannot be made silently.
- Caveat worth knowing: that history write is best-effort and outside the task's transaction, so a database failure can drop the row without failing the request. It is an audit trail, not a ledger.

Attribution that *is* server-controlled lives in `task_history.actor_principal_id` and the stream's `author_principal_id` (surfaced as `actorDetail` on `GET /tasks/{id}/timeline`). Read those, not the note text, when the actor matters.

### Listing grants

`GET /grants` takes the additive paging and filter parameters `limit`, `cursor`, `sort`, `made`, `verb`, `expiry`, `target` and `q` and, when paged, answers with `pagination` and `madeCounts`; without `limit` and `cursor` it is the unpaged list as before. The parameters, the paging guarantee and how each row's origin is derived are in [grants.md](grants.md#listing-grants-pages-filters-and-where-a-grant-came-from).

### Revoking grants: one at a time, or in a checked batch

- `DELETE /grants/{id}` takes the same login-session and step-up requirement as `PATCH /grants/{id}`: body `{ stepUpToken }`, a single-use step-up bound to `('grant.revoke', id)`. A bearer, a root Connector included, is refused `403 SESSION_ONLY`; a session without a live token bound to that act and grant is refused `403 STEP_UP_REQUIRED` with the step-up challenge. Both refusals are audited as denied `grant.revoke` rows, and a refused revoke never spends the token.
- `POST /grants/bulk-revoke` (login session only, root; not on MCP) takes `{ ids (at most 500), dryRun (default true), stepUpToken }` and answers a verdict per id from the authorization engine itself (`redundant`, `effective`, `unevaluable`, `assignment`, `missing`, `expired`). A dry run writes nothing; a real run needs a step-up bound to `('grant.bulk_revoke', idSetHash)`, re-checks every id live, removes only the ids still redundant through the ordinary revoke path, reads every affected grantee's access back and rolls the whole batch back on any difference. The body, the hash and the answer are in [grants.md](grants.md#cleaning-up-grants-that-change-nobodys-access).
- Creating a Task, Report or Project writes its creator and sponsor grants only when they add access or a delegation source; see [grants.md](grants.md#behaviour).

### Groups (AZ-S1, §3)

A **Group** is a board-minted, immutable-id member set whose members are
**Accounts only** (human and service principals, parentless; agent-kind
and parented identities are refused — A17.6). Group **mutation is
owner-plane**: `POST/PATCH/DELETE /groups`, `POST /groups/{id}/members`
and `DELETE /groups/{id}/members/{principalId}` all require `root`, so an
agent credential cannot add itself to a group (T13). **Listings ride
`principals:read`**: `GET /groups`, `GET /groups/{id}` and
`GET /groups/{id}/members` (members come kind-differentiated with live
status). `GET /groups/directory-sync` (root) reports the per-provider sync
watermark and staleness verdict.

A grant with `granteeType: 'group'` reaches members by membership join at
query time — see [grants.md](grants.md). Membership rows carry a
`source`: `local` rows are board-authored and survive directory sync;
`directory` rows belong to the sync snapshot and are dropped when the
directory no longer lists the member. A failed sync keeps the last
snapshot and raises staleness past the threshold (default 24h). The
directory provider binding itself is Phase 5.

#### A Group is also a principal (AZ-A12 build 1)

Since migration 146 every Group is also a **principal of kind `group` with the
same id** (`principals.id = groups.id`). Its handle is `group:<id>` (the
lowercase id), its display name follows the Group's name, its role is empty
and it has no parent. `POST /groups` and *Use this group* create it in the same
statement as the Group; a rename updates its display name in the same
transaction. Existing Groups were given theirs by the migration; no ownership
was inferred.

A Group principal **never acts**. It has no credential, no login session, no
Identity link and no home group; it is never a Group member (no nested
Groups), never a Connector's or Agent's parent, never an Assignee, Shepherd,
Verifier, creator or Report author, and never a `granteeType: 'principal'`
grantee or a principal profile assignee — a Group is granted to, and assigned
profiles, as `granteeType: 'group'` / `assigneeType: 'group'`. Each of these is
refused by name where a route reaches it (`MEMBER_NOT_ACCOUNT`,
`CONNECTOR_NEEDS_ACCOUNT`, `TASK_ROLE_GROUP_PRINCIPAL`,
`GROUP_PRINCIPAL_NOT_A_GRANTEE`) and by a database backstop everywhere else.
A token that resolves to a Group principal is answered `401`.

`GET /groups` and `GET /groups/{id}` carry **`ownershipStatus`** — the Group
principal's status, `active` or `disabled` (`terminated` only on the record a
delete returns).

**`PUT /groups/{id}/ownership-status`** `{enabled, reason, stepUpToken}` (all
required) enables or disables the Group principal. It is a **root login-session
act with step-up** and nothing else: the `/groups` ceiling is `root`, so an
operator session is refused `403 FORBIDDEN` there; a bearer credential is
refused `403 REQUIRES_LOGIN_SESSION`; a session without `root` is refused
`403 ROOT_SESSION_REQUIRED`. `reason` is 1–500 characters after trimming. The
step-up is minted through `POST /auth/step-up` with `action:
"group.ownership_status"` and the Group's **lowercase** id as `targetId`; the
path id may be spelled in either case. Asking for the status the Group already
has is `409 GROUP_OWNERSHIP_STATUS_UNCHANGED`, and that refusal — like every
refusal before it — leaves the step-up unspent. Success is audited
`group.principal_disable` or `group.principal_enable` with `{groupId, from, to,
reason, stepUpTokenId}`; every refusal is audited under the same action with
`outcome: denied` and the refusal code (`group.ownership_status` when the body
does not say which direction). Disabling **suspends ownership only**: membership
and the Group's grants are untouched, and its members keep everything the
Group's grants give them. Disabling suspends every ownership tier the Group
confers on the next request (see the Group ownership section of
[authorization](authorization.md)).

**Deleting a Group** keeps its existing refusals, in this order:
`GROUP_NOT_EMPTY`, `GROUP_GATES_LOGIN`, `GROUP_IS_A_HOME_GROUP`, then
**`409 GROUP_OWNS_OBJECTS`** (and, since LENSES-c c1-A,
**`409 GROUP_HAS_STEWARDS`** after it, below) while any Project owner, Task account owner,
Report account owner or Skill owner names the Group. That refusal carries
`details.owned: {projects, tasks, reports, skills}` — counts, never ids. A delete that
passes removes the Group's grant rows and the Group row, and marks the Group
principal `terminated` (with `terminated_at`) in the same transaction; the
principal row is kept for provenance, and the `group.delete` audit row says
`principalTerminated: true`.

None of this is visible in the dashboard yet (the Group roles below have a
panel in the Access manager): there is no Group view, and the
pickers that list principals still offer people and Connectors only.

#### Group roles: owners and managers (LENSES-c c1-A)

Since migration 152 an Account can hold one **Group role** in a Group: `owner`
or `manager`, one row per Account per Group (`group_stewards`). Roles are
**manual appointments only**; nothing derives them from a directory group, a
claim or SCIM. A role is held only by a **parentless, non-legacy human or
service Account that holds no elevated role** (`admin`, `operator`,
`orchestrator`): a Connector, an Agent, a Group principal, a legacy identity
and an administrator are refused, by the service and by a database trigger.
A row is **never edited**: changing a role is a removal and then an
appointment.

**Live and inert.** A role row is **live** only while its holder is `active`,
is a **member** of the Group (any source) and holds **no elevated role**. These
are read on every request: leaving the Group, being disabled or terminated, or
being promoted to `admin`, `operator` or `orchestrator` makes the row **inert**
from that moment, and an inert row confers nothing. Rejoining, re-enabling or a
demotion makes it live again (termination is final). No cleanup runs; the row
stays and is flagged.

- **`GET /groups/{id}/stewards`** (`principals:read`) lists the roles, owners
  first: `{accountPrincipalId, handle, kind, status, role, appointedByPrincipalId,
  appointedAt, live, inertReason}`. `inertReason` is `null` for a live row, else
  the first of `principal_inactive`, `elevated_role`, `not_a_member` that applies.
- **`POST /groups/{id}/stewards`** `{accountPrincipalId, role}` (both required)
  appoints. It is a **root login-session act**: the `/groups` ceiling is `root`
  (an operator or editor session, or any other session without `root`, is
  refused `403 FORBIDDEN` there), and a bearer credential holding `root` is
  refused `403 REQUIRES_LOGIN_SESSION` by the handler. The handler also checks
  for `root` itself and would answer `403 ROOT_SESSION_REQUIRED`, but only as
  defence in depth: the ceiling stops a session without `root` first, so that
  code is not reachable today. There is no step-up.
  Membership is **not** required: an outsider is appointed inert
  (`not_a_member`) and becomes live when the directory or root adds them.
  Refusals: `404 GROUP_NOT_FOUND`; `422 INVALID_GROUP_VALUE` (a missing field,
  a role other than `owner` or `manager`); `422 STEWARD_NOT_FOUND` (no such
  principal); `422 STEWARD_INELIGIBLE` with `details.reason` one of `kind`,
  `parented`, `legacy`, `elevated_role`; `409 ALREADY_A_STEWARD` with
  `details.role`; `400 UNKNOWN_FIELD`.
- **`DELETE /groups/{id}/stewards/{principalId}`** removes any role row, owner
  or manager, live or inert. The same root login-session tests apply.
  `404 STEWARD_NOT_FOUND` when the Account holds no role there.
- **`DELETE /groups/{id}/managers/{principalId}`** `{stepUpToken?}` lets a Group
  **owner** remove a **manager** row in that Group. The route's
  ceiling is `authenticated`; the act checks, in this order and in one
  transaction: a **login session** (else `403
  GROUP_MANAGER_REMOVE_REQUIRES_SESSION` — bearers, Connectors and Agents never
  pass); a **human Account acting as itself** and a **live owner row** on this
  Group (else `403 GROUP_MANAGER_REMOVE_REQUIRES_OWNER`, which is also the
  answer for a Group that does not exist); the target row (`404
  STEWARD_NOT_FOUND` when absent; `403 STEWARD_OWNER_ROW_ROOT_ONLY` for an owner
  row, the caller's own included); and only then the **step-up**, minted
  through `POST /auth/step-up` with `action: "group.manager_remove"` and the
  Group's **lowercase** id (else `403 STEP_UP_REQUIRED`). The body may omit the
  token; an absent or invalid token is answered only after the earlier steps
  pass, so a missing token against an owner row is still
  `STEWARD_OWNER_ROW_ROOT_ONLY` and against an absent row `STEWARD_NOT_FOUND`.
  No refusal spends the token. A manager row is removed whether it is live or inert. Root,
  administrators and operators never pass the owner test — they hold no live
  owner row — and remove through the root route above.
- **`POST /groups/{id}/managers`** `{accountPrincipalId, stepUpToken?}` lets a
  Group **owner** appoint a **manager** in that Group (LENSES-c gate (iii)). The
  ceiling is `authenticated`; the act checks, in this order and in one
  transaction: a **login session** (else
  `403 GROUP_MANAGER_APPOINT_REQUIRES_SESSION`); a **human Account acting as
  itself** and a **live owner row** on this Group (else
  `403 GROUP_MANAGER_APPOINT_REQUIRES_OWNER`, also for a Group that does not
  exist); the appointee: an **active member** of the Group by any source (else
  `422 MANAGER_NOT_A_GROUP_MEMBER`), holding no role there yet (else
  `409 ALREADY_A_STEWARD` with `details.role`; the owner's own row makes
  self-appointment this refusal), and admitted by the holder rules (else
  `422 STEWARD_INELIGIBLE` with `details.reason`); and only then the
  **step-up**, `action: "group.manager_appoint"` and the Group's **lowercase**
  id (else `403 STEP_UP_REQUIRED` with the `stepUp` challenge). No refusal
  spends the token. The role is always `manager`: a `role` key in the body is
  refused `400 UNKNOWN_FIELD`, and no owner appoints or removes an owner —
  owners are appointed through the root route above. Answers
  `201 {steward, stepUpTokenId}`. Two concurrent appointments of the same
  Account are never a database error: the one that commits second is the same
  `409 ALREADY_A_STEWARD` (with `details.role`), and its token stays live. Root,
  administrators and operators hold no live owner row and never pass.
- **Steward transfers (LENSES-c gate (ii) and DD-5).**
  `PUT /projects/{id}/owner/steward` (`projects:write`, `If-Match`)
  `{ownerPrincipalId, stepUpToken?}` and `PUT /tasks/{id}/account-owner/steward`
  (`tasks:write`) `{accountOwnerPrincipalId, expectedAccountOwnerPrincipalId,
  expectedUpdatedAt, reason, stepUpToken?}` admit exactly two moves, each by a
  person on a login session holding a **live owner** row in the Group concerned:
  **out** — an object owned by an active Group moves to an **active member** of
  it (a Task with no explicit owner gets the member as its explicit owner); and
  **in** — the caller's own object (for a Task, the effective owner) moves into
  an active Group they own. Anything else (person to person, Group to Group, a
  clear) is `422 STEWARD_TRANSFER_SHAPE_REFUSED` and stays with the
  administrator routes. Refusals, before the step-up is spent and audited:
  `403 GROUP_OWNER_SESSION_ONLY` (a bearer, a Connector, an appointed Main),
  `403 GROUP_OWNER_ROLE_REQUIRED` (no live owner row, a manager, a disabled
  source Group), `403 NOT_THE_CURRENT_OWNER`, `422 TARGET_NOT_A_GROUP_MEMBER`,
  `422 INVALID_OWNER` (a disabled Group target), then the revision or
  preconditions, then `403 STEP_UP_REQUIRED` for `action: "ownership.transfer"`
  and the object id. These routes never consult the administrator decider or
  the appointed Main; the audit row says `deciderStanding: "group-owner"`.
  **Every** refusal the handler or the act makes is audited as a `denied`
  `project.owner.change` or `task.account_owner.change` row with `{refusal,
  clause, standing: "group-owner", oldOwnerPrincipalId, newOwnerPrincipalId,
  oldOwnerKind, newOwnerKind}` — the query and body checks
  (`UNKNOWN_FIELD`, `INVALID_OWNER`, `INVALID_ACCOUNT_OWNER_CHANGE`), the
  standing's, the person-target checks (`INVALID_OWNER`, `INEFFECTIVE_OWNER`,
  `INVALID_ACCOUNT_OWNER`), an archived object, `REVISION_REQUIRED`,
  `REVISION_MISMATCH`, `ACCOUNT_OWNER_STATE_CHANGED` and `STEP_UP_REQUIRED`. The
  scope ceiling, the point stage and a malformed path id answer before the
  handler and are not audited under these actions.
- **`GET /groups/{id}/grants`** (`principals:read`) is the team-grants read. A
  **root login session** sees the Group's grant rows in full; a **live owner or
  manager** of the Group, on a login session, sees them **without
  `grantedByPrincipalId`**; every other caller — a bearer, a non-steward, an
  inert steward, a steward of another Group — receives `200` and an empty list.
- **Audit.** `group.steward_appoint` and `group.steward_remove`, on success and
  on every refusal the handler or the service makes (`outcome: denied`, with
  the refusal code). The ceiling-stage `403 FORBIDDEN` is answered by the scope
  middleware before the handler runs, so it is **not** audited under these
  actions. Metadata:
  `{groupId, accountPrincipalId, role, appointedBy, standing, liveAtWrite, via,
  chain}`, with `standing` `root` or `group-owner` and, for an owner's removal,
  `stepUpTokenId`.
- **Deleting a Group** gains **`409 GROUP_HAS_STEWARDS`** after
  `GROUP_OWNS_OBJECTS`: role rows, live or inert, remain. `details.stewards` is
  a count and never ids; see `GET /groups/{id}/stewards`, and remove the rows
  first.
- **Termination leaves role rows in place, inert.** Terminating an Account
  writes nothing to `group_stewards` and is not refused over it; the row reads
  `principal_inactive` from then on, never becomes live again, and is removed
  only by the root route.

**What a role gives.** A live `owner` or `manager` row gives the **edit tier**
on objects the Group owns (`read`, `write`, `claim`, `finish`, `release`,
`use`, `invoke`; never `admin`, Shepherd or Verifier), where a plain member
gets the use tier (`read`, `use`, `invoke`). See the Group ownership section of
[authorization](authorization.md) for paths, restriction and the chain. A live
role also gives the catalog's steward rows (below), the team-grants read, and,
for an owner, the removal of a manager row. No MCP tool reads or changes a
Group role.

**CLI and dashboard.** `relayhall group steward list <group-id>`,
`relayhall group steward add <group-id> <account-id> --role owner|manager` and
`relayhall group steward remove <group-id> <account-id>` call the three root
routes above. The targets are exact UUIDs (a name, handle or prefix is a usage
error, exit 2, before any request); a refusal is printed with its message and
code; there is no step-up, and `remove` asks for confirmation unless the global
`--yes` flag is given, placed before the subcommand
(`relayhall --yes group steward remove <group-id> <account-id>`; there is no
per-verb flag). Sign in with `relayhall login` first: a bearer credential is refused
`REQUIRES_LOGIN_SESSION`. In the dashboard, the Access manager's **Group roles**
panel lists a chosen Group's roles with the holder and the live or inert flag
and its reason, to any session holding `principals:read`; appoint and remove
are offered to a root session only. The candidate list the panel offers is a
convenience: the server's `STEWARD_INELIGIBLE` answer is the authority for
eligibility, and an Account the panel offers may still be refused. There is no
owner control in either surface yet.

#### Ownership transfer involving a Group (AZ-A12 build 3)

`PUT /projects/{id}/owner` and `PUT /tasks/{id}/account-owner` each accept one
more body key, **`stepUpToken`**. It is read only when the current owner (for a
Task, the effective owner: its own account owner, else its Project's) or the
target is a Group principal. Such a transfer is a login-session act of root or
an administrator (`admin`, `operator`, `orchestrator`) with a single-use step-up
minted by `POST /auth/step-up` with `action: "ownership.transfer"` and the
object's id as `targetId`. The refusals, in order, all `403` and all audited as
`denied` rows outside the rolled-back transaction:
`GROUP_OWNER_SESSION_ONLY` (a bearer credential, an appointed Main, the MCP
tool), `GROUP_OWNER_REQUIRES_ADMINISTRATOR`, then `STEP_UP_REQUIRED` with the
`stepUp` challenge `{error: "insufficient_user_authentication", action:
"ownership.transfer", targetId, max_age: 0, methods}`. The first two never spend
the token. A disabled Group target is `422 INVALID_OWNER` / `422
INVALID_ACCOUNT_OWNER`. The success audit adds `oldOwnerKind`, `newOwnerKind`,
`groupMemberCountAtTransfer`, `stepUpTokenId`, `stepUpMethod`,
`deciderStanding` and `chain`. A transfer between persons is unchanged and needs
no token.

`GET /projects/{id}/owner-candidates` answers `{success, candidates, groups}`:
`groups` lists `{id, name, featured}` for every enabled Group, featured first
and then by name, to a root or administrator login session, and is empty for
every other caller.

`POST /projects` accepts three more keys, all or none: `ownerPrincipalId` (a
Group), `projectId` (a version-4 UUID the caller allocates) and `stepUpToken`
(bound to `ownership.transfer` and that `projectId`). The Project is created and
moved to the Group in one transaction under the same rules; a refusal leaves no
Project. A person `ownerPrincipalId` is `422 OWNER_AT_CREATE_GROUP_ONLY`, and a
partial set of the three keys is `422 INVALID_OWNER`.

A body carrying any of the three keys is its own retry operation. With
`Idempotency-Key` it is recorded as `project.groupowned.create`, scoped to the
credential (or, for a login, the signed-in account) that sent it, because the
act reads the caller's session and step-up: a second credential of the same
principal sending the same body and key meets the standing test itself and is
never served the stored answer. Any other body is the plain create,
`project.create`, scoped to the principal as before.

| Request to `POST /projects` | Retry operation | Retry scope |
| --- | --- | --- |
| no owner keys | `project.create` | principal |
| `ownerPrincipalId`, `projectId`, `stepUpToken` (any of them) | `project.groupowned.create` | credential (a login: the account) |

#### The Access Explorer (AZ-A12 build 6)

A read-only model of who can do what on an object, and why, derived at read
time. Every verdict it states is the **same predicate the server enforces
with** (the object predicate behind every point and list decision), evaluated
now, and its `sources` are the arms of that predicate that held; a Group tier
is read through the same shared fragment as the owner rule. It confers nothing
and changes nothing. The routes are `GET` only, under `principals:read`; there
is no MCP tool. The dashboard page is not part of this release.

- **`GET /access-explorer/objects/{type}/{id}`**, `type` one of `task`,
  `phase`, `project`, `report`, `skill`, `personality`, `service`. Answers
  `{success, explorer}` with `object`, `projection`, `owner` and (for a Task)
  `projectOwner` as `{principalId, kind, displayName}`, `boardWide`
  (`readableByEveryAuthenticatedPrincipal`, `administratorRoles`,
  `rootSentinel`), `groups` (the owning Groups; for root also the Groups a
  grant or profile names, with `relations`), `holders`, `grants`,
  `evaluatedAt` and `semantics`. Each holder is a principal summary with `via`
  (why it was listed) and `actions: [{action, sources}]`; a holder listed with
  no actions holds nothing now (an expired grant, a disabled Account, a dead
  chain). An object the caller cannot read is `404 RESOURCE_NOT_FOUND`, exactly
  as an absent one.
  - **`projection: "root"`** (a caller holding `root`): every principal the
    object's coordinates, grants (exact, typed wildcard and, for a Task, its
    Project's), published profile rules, Group members and bound Agents name,
    evaluated as itself (an Account as its own login session, a Connector or
    Agent as its live chain); `grants` with `selector` (`exact`, `wildcard`,
    `project`), `live` and `origin`. A profile assignee is listed as a holder
    (`via` names the profile); whether the rule covers this object is its
    verdict, and the rules themselves are on the principal hop.
    Board-wide authority (root, `admin`, `operator`, `orchestrator`, and
    authenticated-read visibility) is stated in `boardWide`, not listed per
    principal. At most 200 holders (`holdersTruncated`).
  - **`projection: "self"`** (anyone else): the owner, the owning Groups and
    the caller's own verdict; `grants` is `null`. For a Task, `projectOwner`
    is shown only to a caller that can read the Project.
  - Holders are kept in source order before the limit: the object's own
    coordinates (owner, Task roles, evidence readers), then grant holders,
    bound Agents, Group members, and profile assignees last.
- **`GET /access-explorer/groups/{id}`** answers the Group (`ownershipStatus`,
  `memberCount`) and its members, each with `source` (`local` or `directory`),
  `role` (`owner`, `manager` or `member`), `roleLive` (`null` for a plain member),
  and `tier` (`edit`, `use`
  or `none`, from the owner rule's fragment: a disabled Group gives `none`), and
  `inertRoles` (role rows that confer nothing, with `inertReason` and whether
  the holder is a member). A member's `displayName` follows `GET /principals`:
  a hidden principal's name only to a caller with principal management
  authority. With `objectType` and `objectId` (an object the caller can read,
  else `404`), a root caller gets each member's `actions` on it and anyone
  else only its own.
- **`GET /access-explorer/principals/{id}`** answers the principal and its
  `children` (an Account's Connectors, a Connector's Agents). Its `authority`
  (chain liveness, the own() cap, grants with `live`, Access profile
  assignments, Group memberships and the warrants it holds, with their
  anchors) is shown to root, to the principal itself and to a login session of
  an ancestor (`projection` `root` or `self`). There, a summary's
  `boundTaskId` is shown only when the caller can read that Task, and its
  `mintedUnderWarrantId`, like the `warrants` list, only to a login session
  the warrant registry would show the Warrant to (root, or the holder's own
  subtree); a bearer gets `warrants: null`. With `objectType` and `objectId`,
  the principal's `actions` on that object, and each child's where the caller
  may see that child's authority (a bearer sees its own, never its Agents').
  - **`projection: "directory"`** (anyone else): the principal and its
    children exactly as `GET /principals` lists them (the same record and the
    same filter), with `authority: null`. A hidden principal is listed only to
    a caller with principal management authority, and is otherwise
    `404 PRINCIPAL_NOT_FOUND`, exactly as an absent id.

  A Group principal is `422 GROUP_PRINCIPAL_USE_GROUP_VIEW`; use the Group hop.
- **`GET /groups/{id}/members/{principalId}/access`** (SR-3) answers only the
  authority reaching that member **through that Group**: the Group's grants
  (each with `live` and `reachesMember`) and the Projects, Tasks, Reports and
  Skills whose owner value names the Group, each with the actions the owner
  rule's Group arms give the member, and the member's `tier`. Never the
  member's own grants, its Connectors or another Group's reach. A root login
  session sees it, and on a login session an owner or manager whose role row
  gives it the Group's edit tier (the Group active, the steward an active
  member with a live role row); a non-root viewer sees an owned object only
  when it can read that object. Every other caller, a steward of a disabled
  Group included, receives `200` with `member: null` and empty lists.

Refusals: `400 INVALID_EXPLORER_TYPE`, `INVALID_EXPLORER_OBJECT_ID`,
`INVALID_EXPLORER_QUERY` (`objectType` and `objectId` come together),
`INVALID_GROUP_ID`, `INVALID_PRINCIPAL_ID`; `404 GROUP_NOT_FOUND`,
`PRINCIPAL_NOT_FOUND`; `503 ACCESS_EXPLORER_FAILED` when the evaluation cannot
complete (the read fails closed, never partial).

### Directory group references (RH-LENSES-a, §3–§5)

A **directory group reference** is an external group value the board has
**observed** at an Identity provider — from an OIDC login claim, from a SCIM
push, or both — together with the **carriage** that records which Accounts were
seen carrying it. Neither holds authority. The estate keeps exactly one path
from a directory to authority — a bound Group, its `group_members` rows, and
the predicates that read them — and this is a *reference* store beside it, read
by no authorization predicate.

`GET /directory-group-references` and `GET /directory-group-references/{id}`
ride `principals:read`, for the reason `GET /groups` does. The in-handler
projection narrows further and is not the ceiling: an administrator on a **login
session** sees every row; a **non-root login session holding a live Group role**
(owner or manager) sees the **steward rows** — the references carried by at
least one active member of a Group it live-stewards, with `memberCount` and
`sources` computed over those members only, and no identities at any depth;
**every other caller, bearer or session, receives `200` and an empty list**. A
bearer never sees steward rows, even one held by the steward's own Account. A
403 on a list route would disclose that the surface exists and is populated. A reference outside your projection answers **404**,
byte-identical in status, code and body to the answer for an id that does not
exist, produced from one branch.

Each row carries a member **count** and never an identity list. There is
deliberately no `/directory-group-references/{id}/members` route. A person's own
references are on their own profile, at
`GET /principals/me/directory-group-references` (`authenticated`, no identifier
in the path).

`POST /directory-group-references/{id}/use` is *Use this group*: **one click,
one transaction** (root). It creates a board Group bound to the reference and
populates it from the reference's carriage, or it does none of it — creating and
binding a Group are owner-plane acts. Before it existed an administrator typed
the provider's opaque string by hand and members arrived at their next login.

`DELETE /directory-group-references/{id}` (root) **forgets** a retained
reference. A reference whose carriage falls to zero is kept, not deleted: a
catalog that forgot a group the moment its last member left could not answer
"is this the group I bound last month?". The delete is refused while a Group is
bound to the reference — remove the binding first.

Inbound **SCIM `/Groups`** (RFC 7643 §4.2) writes carriage for the Identity
provider that owns the credential. A SCIM Group resource here **is** a directory
group reference: it creates no `groups` row and can create none, because Group
creation is an owner-plane act. Nested groups are refused; a member naming an
Account another provider provisioned is refused; an oversized membership is
refused rather than truncated, because a truncated membership is a silent access
change. Which pushed attribute becomes the reference — `externalId` or
`displayName` — is declared per Identity provider and taken verbatim.

### Lenses (RH-LENSES-d)

`GET /principals/me/lenses` (`authenticated`, no identifier in the path) says
which dashboard sections the caller is **offered**:

```json
{ "lenses": ["member"], "admin": false }
{ "lenses": ["member", "admin"], "admin": true }
```

`member` is always present. `admin` is present exactly when the request would
pass a `root` ceiling **and** arrived on a login session: the board session
cookie or the break-glass dashboard token. A bearer credential never receives
the admin lens, whatever it holds.

**A lens grants nothing.** It is recomputed on every request from how the
request authenticated, it is never stored, cached or written to a token, no
other route reads it, and every section it leads to keeps its own ceiling. The
read is not audited.

**The manager arm (LENSES-c c1-B).** A caller holding at least
one **live** Group role row (owner or manager; see "Group roles") also gets the
`manager` lens and the Groups it stewards, owners first, then by name:

```json
{ "lenses": ["member", "manager"], "admin": false,
  "manager": { "stewardedGroups": [
    { "id": "<group id>", "name": "Platform", "memberCount": 12, "featured": true, "role": "owner" } ] } }
```

`memberCount` counts the Group's active members. An inert row gives no arm,
and a caller with no live row gets **no** `manager` key at all (not an empty
one); an administrator who stewards no Group has none either. The arm grants
nothing, like every lens.

The dashboard draws its navigation from this answer and from nothing else.
The admin lens adds an **Administration** group: Directory (Identity
providers, their sync health and the remote-group catalog with *Use this
group*), Groups (each Group's members, its directory binding and the featured
flag), People, Access and Advanced. The last three are Settings pages and are
offered only when the Settings shell would show them too. A failed or absent
answer draws the member sections only.

### Access profiles (AZ-S2, §4)

An **Access profile** is a named, **versioned**, reusable bundle of object
authority — rules of `selector → verbs` per resource type (A17.4). Selector
forms: `exact` (pinned ids), `all-of-type`, `all-except` and `all-in-project`
(all three **future-inclusive**: objects created later are covered; exclusions
stay pinned). The `all-` prefix marks the future-inclusive forms.
`all-in-project` is the **project-bounded** form: `selectorIds` names **Project**
ids rather than ids of the rule's own resource type, and the rule covers every
object of that type inside those Projects, including ones created there later.
It is admitted for `task` and `phase` only — the types that carry a project
coordinate. `project` is excluded because a Project is its own project
coordinate, which would make the form a second spelling of `exact`; `surface`
remains `exact`-only (AZ-A5 clause 3). Versions are **immutable**; exactly one **published** version per
profile. Assignments (to Accounts, Groups, Connectors and Agents — the
delegated layers joined at AZ-S3) store only the profile id — the evaluator joins through the
published pointer at query time, so a republish retargets every assignment
atomically and revoking an assignment is one delete, effective immediately.
An unpublished profile yields empty authority and cannot be assigned;
legacy identities are frozen out of assignment (T37).
Rollback republishes prior content as a **new** version; the published
pointer never moves backwards.

Since AZ-S3, **Connectors and Agents are valid profile assignees** — their
effective authority stays `own ∩ parent`, so assignment can never escalate
past the parent chain. Profile **mutation is owner-plane** (`root`);
listings ride `principals:read`. [Current authority previews](authority-preview.md):
`GET /principals/me/effective-access` (self, `authenticated`) and
`GET /access-profiles/what-if?principalId=&credentialId=` (another
principal's authority — `root`). Provenance lives in append-only
`access_profile_events` (`GET /access-profiles/{id}/events`, `root`) plus
the board audit ledger.

### Delegation, credentials and transport (AZ-S3, §5/§7)

Identity has THREE LAYERS on one principals table: **Accounts** (parentless
human/service principals — keyless, session-authenticated; service Accounts
declare a `purpose` at creation), **Connectors** (Account-owned delegated
service identities; a connector-kind registry row and its principal are
created and revoked together), and **Agents** (task-bounded, short-lived,
minted through the delegation machinery — `POST /principals` refuses
`kind=agent`). `effective(identity) = own(identity) ∩ effective(parent)`,
evaluated **live** on every request: narrowing an `own()` expression,
disabling an ancestor, or revoking a Connector's last live credential takes
effect on the very next request. A delegated principal without an explicit
`own()` expression has **empty authority** — inheritance is never implicit.
One reading is fixed: an Agent whose `own()` object list is
**empty** — minted with no `requestedRules`, or approved with none, on any of
the three mint paths — holds exactly one rule, `exact` read+write on its bound
task. It is applied when authority is evaluated and never written back, so it
covers every Agent so minted; it sits inside the intersection, so the
Connector's `own()` and the Account's authority still bind it; it names only
the bound task; and a non-empty list, including one narrowed to read-only, is
read exactly as stored. `tasks:write` on the credential is still required for
every write-class act.
Non-escalation: `root` is never delegable and no new bearer credential can
carry it; `*:admin` scopes never reach the Agent layer; an Agent's
write-class authority never leaves its bound task. Evaluator failure fails
the whole request with 503 — never a partial list.

The mint ceiling. A mint's `requestedScopes` must lie within the
requesting credential's current effective scopes. Each `requestedRules` entry
must lie within what the requester may do live. An `exact` rule is decided by
the shared predicate itself, for every named object and every action the rule's
verbs allow (`write` allows read, write, claim, finish and release). It is
evaluated against the requester's chain: its `own()` caps and its Account's
role, ownership (the Task's account owner, else its Project's owner), grants,
group grants, Access profile rules, exact Project Grants and read visibility.
Task roles (Assignee, Shepherd, Verifier, creator) never count, because they
belong to the acting identity and do not pass down a chain. A rule whose
selector reaches objects not created yet (`all-of-type`, `all-except`,
`all-in-project`) is proven from the Account's grant and profile rules and the
chain's `own()` caps, with `write` covering `read`. `POST
/delegation/agent-mints` applies the ceiling when a request is filed, and the
decide, collect, session-mint and warrant-mint paths apply it again. A request
outside it answers `403 MINT_EXCEEDS_REQUESTER`, and the message names the
failing rule as `{resourceType, selectorForm, selectorIds, verbs}` (or the
scopes outside the set); a refused filing creates no Approval.

Credentials: secrets are **encrypted at rest** under an envelope keyset from
`RELAYHALL_CREDENTIAL_KEYS`/`RELAYHALL_CREDENTIAL_ACTIVE_KEY` (a deployment
without a keyset cannot mint); a startup + periodic canary verifies
decrypt-vs-hash and fails loudly. `POST /credentials/{id}/reveal` re-reveals
under lineage (bearer) or step-up (session) rules; `POST /auth/step-up`
mints the single-use elevation token. Rotation (`POST /credentials/{id}/rotate`)
is an **exact copy** — scope/transport changes are refused (they are made in
place with `PATCH /credentials/{id}`, AZ-A13); the predecessor
gets a live-evaluated grace window (default 24h, 0–7d), graced tokens are
never revealable, and a new rotation revokes the prior graced ancestor.
Agents never rotate. Credentials carry a `transport` pin (`any|mcp|api`)
compared against **server-derived** request provenance only.
`POST /principals/{id}/terminate` is irreversible offboarding (A17.10).

Pre-096 rows an invariant outlaws are marked `legacy_identity`: they keep
their Phase-2 behavior (audited with a legacy marker), sit in the
remediation queue, and are frozen out of all new machinery until the
Phase-5 estate transition.

### Step-up (re-proving it is you)

Some acts need a **single-use step-up token** on top of a login session:
approving or denying an agent-mint request (`approval.decide`), creating
or resuming a Warrant (`warrant.create`, `warrant.resume`), re-revealing a
credential (`credential.reveal`), the session Agent mint (`agent.mint`), and
adding or removing a shared-area writer (`knowledge.shared-writer.add`,
`knowledge.shared-writer.remove`, bound to the Account id). A token is bound to ONE action and ONE target id, lives about five minutes,
belongs to the Account that minted it, and is burned by the act that
consumes it. A bearer credential never steps up (AZ-18); every route below
answers `401` without a login session.

There are two ways to mint one, and `GET /auth/step-up/methods` says which
this Account can use: `{ methods: ["password" | "sso", ...], preferred }`.

- **Password** — `POST /auth/step-up` `{ password, action, targetId }` →
  `{ success, stepUpToken, expiresAt }`. The password is the calling
  Account's own credential, or, for the named local administrator only, the
  deployment break-glass secret. Unchanged by the SSO arm: any body without
  `method: "sso"` takes this arm.
- **Identity provider** — for an Account that signs in
  through its Identity provider and holds no password. `preferred` is `sso`
  when the session came from the Identity provider and the Account has no
  password credential.
  1. `POST /auth/step-up` `{ method: "sso", action, targetId }` →
     `{ success, method: "sso", authorizeUrl, requestId, expiresAt }`, and a
     short-lived browser-binding cookie. The request is bound server-side to
     the session's Account, the action and the target; the authorize URL
     carries `prompt=login` and `max_age=0`, or the standard parameters the
     provider's step-up policy names (below). `400 SSO_STEP_UP_UNAVAILABLE`
     when the Account holds no proven Identity link at an enabled Identity
     provider, or that provider's policy says `sso_step_up: "disabled"`.
  2. The person signs in again at the Identity provider, which returns to
     `GET /auth/sso/callback`. The callback proves the step-up only when the
     ID token's `auth_time` is no older than the request and its subject
     resolves to the SAME Account through a proven Identity link. It mints no
     login session and no token, and lands the window on
     `/dashboard/?step_up=complete&request=<id>` (or
     `?step_up=refused&request=<id>&code=<CODE>`); a JSON caller gets the
     typed `400` instead: `SSO_STATE_UNKNOWN` (tampered, expired or replayed
     state), `SSO_COOKIE_MISMATCH` (another browser),
     `SSO_STEP_UP_NOT_FRESH` (the provider reused an earlier sign-in: the ID
     token's `auth_time` predates the request, or is absent),
     `SSO_STEP_UP_PROVIDER_DECLINED` (the provider answered `login_required`,
     `interaction_required`, `unmet_authentication_requirements` or
     `access_denied`), `SSO_ID_TOKEN_REFUSED` (any other ID-token refusal),
     `SSO_STEP_UP_SUBJECT_MISMATCH` (another Account, or an unlinked subject
     — nothing is provisioned). The two named causes are step-up answers
     only: a step-up starts from the Account's own login
     session, so naming the cause tells that person about their own
     provider session. The login callback keeps the single
     `SSO_ID_TOKEN_REFUSED` for every ID-token refusal, stale or not.
     On a `SSO_STEP_UP_NOT_FRESH` landing the dashboard keeps that window
     open, and its step-up dialog counts down and then starts a NEW step-up
     in the same window by itself, at most twice in one dialog. The landing
     names no timing today, so the dialog waits a cautious 35 seconds and says
     so. Because the board's responses carry a cross-origin opener policy, the
     window usually cannot be reached by the dialog after the provider hop, so
     the kept landing listens on the dashboard's own broadcast channel and moves
     itself to the new request's authorize URL. It accepts that only for its own
     request id, only an https URL, and only on the provider origin the board
     returned for that request; a release message (Cancel, a closed dialog, a
     new binding) or a ten-minute bound closes it. If neither the landing nor
     the window can be reached and the browser blocks a new window, the dialog
     asks for one click.
  3. `POST /auth/step-up/collect` `{ requestId }` →
     `{ success, method: "sso", stepUpToken, expiresAt, action, targetId }`,
     once, within two minutes of the proof, for the same Account only.
     Refusals: `404 STEP_UP_REQUEST_UNKNOWN` (no such request for this
     Account), `409 STEP_UP_PENDING` (not finished yet), `400
     STEP_UP_REFUSED`, `409 STEP_UP_ALREADY_COLLECTED`, `400
     STEP_UP_EXPIRED`.

Either way the token is the same object, consumed the same way. Its
`method` (`password` or `oidc`) is recorded on the token row and in the
consuming act's audit evidence; the Identity-provider arm also writes
`auth.step_up.reauthenticated`, `auth.step_up.refused` and
`auth.step_up.mint` audit events. Every refused callback of a step-up
request writes `auth.step_up.refused` with a `reason` (`auth_time_stale`,
`provider_declined`, `subject_mismatch`, `other_id_token` or
`callback_refused`) and its `refusal_code`; where the ID token was read,
both it and `auth.step_up.reauthenticated` record `auth_time`,
`requested_at`, `auth_time_delta_seconds` (`auth_time` minus the request:
negative when the provider reused an older sign-in), `acr` and `amr` as the
provider sent them, and `step_up_request` (the `prompt_login` / `max_age`
the provider's policy asks with). No audit row carries the ID token, the
code, the state or the nonce. A refusal whose `auth.step_up.refused` row
cannot be written fails the callback instead of answering its named code:
`500 SSO_STEP_UP_FAILED` with an `errorId` (a browser lands
on `step_up=refused` with `code=SSO_STEP_UP_FAILED`); the request is still
refused and can never be collected.

**When an act refuses for want of a step-up.** A consumer that finds no
live token for the act answers `403 STEP_UP_REQUIRED` (never `401`) with a
challenge in the vocabulary of RFC 9470 (vocabulary only: no
`WWW-Authenticate` header is sent on a session):
`{ error, code: "STEP_UP_REQUIRED", message, stepUp: { error:
"insufficient_user_authentication", action, targetId, max_age: 0, methods } }`.
`action` and `targetId` are the binding the act just tried; `max_age: 0` is
the freshness every step-up is held to; `methods` is which proofs the
CALLER's own Account can give (`password`, `sso`, or none), the same set
`GET /auth/step-up/methods` answers, and is absent only if that lookup
failed. It carries no capability: step up for that action and target, then
repeat the act with the token. Every step-up consumer answers it, including
a credential reveal sent with no token at all, `PUT
/groups/{id}/ownership-status` and `DELETE /groups/{id}/managers/{principalId}`.
The dashboard's warrant, grant, connection-permission,
workflow-setup and approval acts read it and retry once with a new token.
The dashboard's step-up dialog asks `GET /auth/step-up/methods` afresh, past
the browser cache, for every step-up it opens and offers nothing until it
answers; when that read fails it offers the challenge's `methods` (or both
proofs when it has no challenge) with a way to check again, and the board
still decides which proof it accepts.

**How a step-up asks the Identity provider**. Identity
providers disagree about which standard question produces a fresh
authentication: some ignore `max_age=0`, or honour `prompt=login` only once
per provider session, while honouring a positive `max_age` every time. The
Identity provider row therefore carries an optional `stepUpPolicy`, written
only through the root-gated `/identity-providers` family (`POST`, `PATCH
/identity-providers/:id`) and returned on its reads:

| Key | Default (no policy) | Allowed | Sends |
|---|---|---|---|
| `prompt_login` | `true` | `true` / `false` | `prompt=login` when true |
| `max_age` | `0` | `null` (not sent), `0`, or a whole number of seconds from 10 to 300 | `max_age=<n>` unless null |
| `sso_step_up` | `"enabled"` | `"enabled"` / `"disabled"` | a disabled provider is not offered for step-up |

`stepUpPolicy: null` restores the default request (`prompt=login` and
`max_age=0`, byte for byte). The policy is validated at write and refused
by name: `PROVIDER_STEP_UP_POLICY_INVALID` (not an object, an unknown key, a
wrong type, or a strength key a later release adds), `PROVIDER_STEP_UP_MAX_AGE_INVALID`
(`max_age` 1-9, which makes a provider loop, or above 300), and
`PROVIDER_STEP_UP_ASKS_NOTHING` (`prompt_login: false` with `max_age: null`).
Whatever the policy sends, a step-up request never inherits a `prompt` or
`max_age` from `extraAuthorizeParams`, and the ANSWER is judged exactly as
before: the ID token's `auth_time` must be no earlier than the request, with
no clock-skew allowance, so a provider that reuses its session is refused
`SSO_STEP_UP_NOT_FRESH` under every policy. For example, a provider that
honours a positive `max_age` but not `max_age=0` is asked
`{"prompt_login": false, "max_age": 30}`: a step-up more than 30 seconds
after the person's last sign-in there is asked once, and one started
sooner is refused stale and simply tried again.

### Access requests (AZ-A9 grant and credential requests, ratified 2026-10-10)

An Agent or Connector asks for authority it lacks by filing a request, and a
person decides it. A **grant request** asks for grant rows on the requester's
Account; a **credential request** asks for ONE new credential on the
requesting Connector itself, carrying scopes it lacks. Each is an Approval of
`kind` `grant` or `credential` in the same queue as mint requests; every older
Approval is kind `agent-mint` and behaves exactly as before.

**Filing — the agent plane, bearer-only.** A login session calling any of
these routes is refused `403 AGENT_PLANE_ONLY`.

| Route | What it does |
|---|---|
| `POST /delegation/access-requests` | File a request. `202 { approval }`. |
| `GET /delegation/access-requests` | List your own requests (`?status=`, `?kind=`). Without `kind`, every kind but `agent-mint`; `kind=agent-mint` lists your own mint requests with their task and scopes. |
| `GET /delegation/access-requests/{approvalId}` | Read one of your own requests. |
| `POST /delegation/access-requests/{approvalId}/withdraw` | Lapse your own pending request (`WITHDRAWN`). |
| `POST /delegation/access-requests/{approvalId}/collect` | Collect an approved credential request: `201` with the new key, once. A grant request answers `409 NOT_COLLECTABLE`. |

Every filing carries `kind`, a `reason`, `relatedTaskId` and/or
`relatedPhaseId`, and an optional `requestedExpiresAt`:

- `kind` is `grant`, `credential`, `authority-edit` (see *Editing in place*)
  or `change` (see *Change requests*); `agent-mint` is refused
  `KIND_NOT_FILABLE_HERE` (mints use `POST /delegation/agent-mints`).
- `reason` is 20 to 2,000 characters, stored as written and shown to the
  decider as untrusted text.
- `relatedTaskId` and/or `relatedPhaseId` is required and must be readable by
  the caller; an unreadable one answers `404` exactly as an absent one.
- `requestedExpiresAt` defaults to 14 days and may be at most 90.

A **grant** filing adds `{ requestedRules, granteePrincipalId? }`:

- `requestedRules` holds one rule per resource type, `selectorForm` `exact`
  or `all-of-type`, verbs from `read`, `write`, `use`, `invoke`. `admin` and
  the `surface` type are refused by name.
- The grantee is always the caller's chain-root Account. A delegated
  `granteePrincipalId` is refused `GRANTEE_INERT`.
- A rule the grantee Account already holds is refused `409 ALREADY_HELD`,
  naming the covering source.

A **credential** filing adds `{ requestedScopes, requestedTransport?, label?,
targetPrincipalId? }`. Only a Connector files one; an Agent is refused
`CREDENTIAL_REQUESTER_NOT_CONNECTOR` (its credential is its Connector's mint).

- `requestedScopes` never holds `root` (`ROOT_NOT_MINTABLE`) or a `*:admin`
  scope (`ADMIN_SCOPE_NOT_ADMISSIBLE`); a scope outside the mintable
  vocabulary is refused `INVALID_SCOPES`.
- If one of the Connector's live credentials already carries every requested
  scope under a compatible pin, the request is refused `409 ALREADY_HELD`,
  naming that credential by id, label and key id. Ask only for what you lack.
- `requestedTransport` is `any`, `mcp` or `api`; it defaults to the pin of
  the credential you file with.
- `label` (optional, 1 to 100 characters) labels the new credential; the
  board names it `access request <id>` otherwise.
- The credential is always for the requesting Connector. A different
  `targetPrincipalId` is refused `TARGET_NOT_AVAILABLE`; a credential for
  another existing Connector or a new one is declared by AZ-A9 clause 13 and
  not built yet.
- Grant rows bundled into a credential request are refused
  `BUNDLED_ROWS_NOT_AVAILABLE`; file a separate grant request.

Filing changes no authority table. Every request counts against the quota
mint requests use (5 pending, 20 per day per requester, every kind together)
and lapses after 7 days pending, or once its own requested expiry passes.
An owner-plane, one-act widening made directly by a signed-in person is not a
filed agent request and does not consume either request quota (AZ-A13 N14).
Every refusal body is `{ code, message, rule, subject:
requester|grantee|decider, clause }`, and every refusal is audited. The
requester's views never carry the decider's identity or step-up evidence, and
never a secret. They say what became of the authority: `revokedAt` once
clause 12a revoked it, each created grant row with its state (`live`,
`expired`, `revoked`, `handed-over`), and a credential request's
`issuedCredential` with its own `revokedAt`.

**Deciding — the human plane.** Requests are decided on the existing
`/approvals` routes by **root or an administrator login session** with a
single-use step-up token bound to `approval.decide`. An administrator
session decides items of every kind, `agent-mint` included, beside the
owning Account and root, and the decision audit records which of the three
decided. A non-administrator Account still lists its own subtree's requests,
and its decide on a grant or credential request is refused `403
APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR` before its step-up is spent. Bearer
callers are refused `SESSION_ONLY`.

- `GET /approvals?kind=credential` filters the queue by kind (`agent-mint`,
  `grant`, `credential`, `authority-edit`, `change`) beside `?status=`. Every item carries `kind`; a grant
  or credential item carries `accessRequest` (grantee, reason, requested and
  approved expiry, related task, phase and project, created grant ids, each
  row as the decider reads it, and for a credential the requested and
  approved pin, the label and the issued credential id). The answer also
  carries `viewer { isRoot, isAdministrator }`, so a surface offers decide
  controls only to a session that may use them.
- `GET /approvals/{id}` for a decider adds `decision`: the requester's chain
  and its credential's label, scopes and pin, the grantee Account and every
  identity under it whose `own()` admits the rows, the object titles, the
  grantee's current holdings, the related task, phase and project with the
  project's ownership class (`group` or `private`: a project whose owner is a
  Group is `group` by its owner first; a live exact-id Group grant is the
  fallback for a person-owned or unowned project; AZ-A12 clause 12, D-16) with
  `ownershipBasis` (`owner`, `grant` or null), `ownerKind`, `ownerDisplayName`
  and `groups` (the owning Group first, each with its `basis`), the precomputed ceiling
  check, the quota counters and the pending-TTL countdown. For a credential
  request `decision.credential` adds the Connector's live credentials (label,
  key id, scopes, pin, expiry — never a secret), each requested scope held or
  new, the scopes the Connector could actually exercise after issue (its
  Account's role and chain bound every credential; anything else would be
  carried and unusable), what this session may put on a credential, and the
  `ALREADY_HELD` preview. `events` is the request's audit trail.
- `POST /approvals/{id}/approve` for a grant takes `{ stepUpToken,
  editedRules?, editedExpiresAt? }`: drop rows or verbs, replace
  `all-of-type` with exact ids, shorten the expiry. For a credential it takes
  `{ stepUpToken, editedScopes?, editedExpiresAt?, editedTransport? }`: untick
  scopes (never all of them: `APPROVAL_WRITES_NOTHING`), shorten the expiry,
  narrow the pin from `any` to `mcp` or `api`. Anything wider — a scope or
  rule never requested, a later expiry, a wider pin, a different grantee,
  target or kind — is refused `EDIT_ONLY_NARROWS`.
- A grant approval writes each approved (rule, verb) as a grant on the
  grantee Account in the decide transaction: `expires_at` is the approved
  expiry, `origin` is `manual`, and the row's `approval_id` names the request.
  An expired identical row is replaced; a live one is refused `ALREADY_HELD`
  by name. Any failure rolls the whole approval back and the request stays
  pending.
- A credential approval records the authorization only: the approved scopes,
  pin and expiry, and a 24-hour collect window. The approved scopes must lie
  within what the deciding session may put on a credential (the rule the
  Connector wizard already applies: every mintable scope but `root` for a
  root session, the scopes it holds for any other), else
  `DECIDER_CEILING_EXCEEDED`. Nothing is issued until the Connector collects.

**Collecting a credential request.** `POST
/delegation/access-requests/{approvalId}/collect`, by the SAME credential that
filed the request (any other credential, even of the same Connector, is
answered `404` as an absent id), within 24 hours of approval. Collect re-runs
every check. A requester no longer live, a disabled grantee or a terminal
related task or phase LAPSES the request with its reason (`CREDENTIAL_ROTATED`,
`REQUESTER_CHAIN_DEAD`, `GRANTEE_DISABLED`, `TASK_TERMINAL`,
`PHASE_TERMINAL`), as do a passed collect window (`COLLECT_TTL_EXPIRED`) and a
passed approved expiry (`PENDING_EXPIRED`). A decider that has lost its
standing (`DECIDER_NO_LONGER_ADMITTED`), the scope closures and
`ALREADY_HELD` refuse without consuming the approval. The credential is then
issued through the same issuance core as `POST /principals/{id}/credentials`,
capped by the decider's authority, on the Connector with the approved scopes,
pin and expiry, and recorded on the approval (`issued_credential_id`). The
`201` answer is `{ approval, credential, secretOnce, onboarding, warning }`:
the key renders once and the board stores it nowhere — not in the approval,
its events, the audit log or a log line. The route is not retry-keyed: a
repeat answers `409 APPROVAL_NOT_COLLECTABLE`; a key whose response was lost
can be revealed by the Account's owner with step-up (`POST
/credentials/{id}/reveal`). The Connector's previous credential stays live:
AZ-A9 issues one credential and keeps rotation a human act.

Approval is a person's act on the board; collect only consumes it. AZ-A9
clause 2 calls collecting a credential request credential issuance, and the
authority act behind it is the decider's step-up approval, which fixes the
scopes, pin and expiry. Collect chooses nothing, exactly as the agent-mint
collect does.

**Revocation.** When the related task reaches `completed` or `archived`, by a
status change, archive or auto-archive, or by the verifier's verdict, the
request's grant rows are revoked (`grant.revoke`, reason `TASK_TERMINAL`), a
credential the request issued is revoked through the credential revoke
(`credential.revoke`, the same reason), and a still-pending or
approved-uncollected related request lapses. Reopening the task restores
nothing. For a request naming only a phase, the phase reaching `completed` or
`archived` does the same, with reason `PHASE_TERMINAL` (ratified).

### Editing in place (AZ-A13)

AUTHZ amendment AZ-A13 (ratified 2026-10-11) makes a Connector credential, a
warrant and a grant **editable in place**: the object keeps its id, a credential
keeps its key and secret, and its history gains one entry per edit with the
value before and after. Re-creating stays available; it is no longer the only
way.

| object | route | editable | never changed by an edit |
|---|---|---|---|
| Connector credential | `PATCH /credentials/{id}` | `scopes`, `transport` | key, secret, label, expiry, the principal |
| Warrant | `PATCH /warrants/{id}` | `ceilingProfileId` or `ceilingRules`, `ceilingScopes`, `maxConcurrent`, `maxTotal`, `expiresAt`, `transportPin` | holder, anchors, `agentMaxAgeHours`, status (`422 WARRANT_AUTHORITY_IMMUTABLE`, with `rule`, `subject`, `clause` and `fields`) |
| Grant | `PATCH /grants/{id}` | `verb`, `expiresAt`, `resourceId` | grantee, resource type, origin |

**Every edit route is a login-session act.** A bearer credential is refused
`403 SESSION_ONLY` and the refusal is audited; an agent asks instead (below).
Every refusal writes a denied audit row with the caller's chain, including the
`404 WARRANT_NOT_FOUND` a warrant edit answers to a session without standing
(the row records the real refusal).
`/grants` keeps its `root` route ceiling, so only a root session edits a grant.

**Narrowing or widening is decided by the server** from the stored state, field
by field: fewer scopes, `any` to `mcp` or `api`, a lower cap, an earlier
expiry, a narrower verb or one object instead of every object is narrowing;
anything that moves a field up, or to a value not comparable with the old
(`mcp` to `api`, one object to another), is widening.

- **A narrowing saves at once**, with no step-up, by root, an administrator
  session, or the owning Account (the Connector or the warrant holder lies in
  its own subtree). A narrowed credential's graced predecessor is revoked in the
  same act. `narrowAgents: true` also narrows every live Agent minted under the
  Connector (or the warrant, to its new `ceilingScopes`) to the new scopes in
  the same transaction; an Agent left with nothing is revoked, and each Agent
  gets its own audit row.
- **A widening is one act with a step-up** bound to (`credential.edit`,
  `warrant.edit` or `grant.edit`, the object id) — a token bound to
  `approval.decide` does not serve. It needs `lifetime`: `{"choice":"keep"}`
  (it stands until someone narrows it) or `{"choice":"until-task","taskId":…,
  "revertAt":…}` (it is reverted when the task is completed or archived, or at
  the date, whichever comes first); otherwise `422 EDIT_LIFETIME_REQUIRED`.
  "Until this task ends" is also `422 EDIT_LIFETIME_REQUIRED`, naming the
  fields in `unrevertible`, for an edit no revert could undo by narrowing: one
  that moves a field to a value not comparable with the old (a warrant ceiling
  that is neither wider nor narrower, `mcp` to `api`, one grant object to
  another), or that replaces a whole scope set. Choose `keep`, or make it two
  edits: a narrowing, then a widening. The
  act writes one Approval of kind `authority-edit`, already approved, and
  applies the edit in the same transaction. Root and administrators are capped
  by what they may delegate, by the Connector's Account role set and by its
  `own()` (`EXCEEDS_ACCOUNT_AUTHORITY`, `EXCEEDS_CONNECTOR_OWN`). An owning
  Account that is not an administrator widens only within the access it holds
  itself; anything beyond is refused `403 EXCEEDS_ACCOUNT_AUTHORITY` and nothing
  is filed. Only root or an administrator loosens a transport pin.
- **A revert removes only what its widening added** and is still present, and
  never widens, field by field: the scopes it added are removed (from a
  credential's scopes and a warrant's `ceilingScopes`), and each other field
  that still holds the approved value goes back, the ceiling to the version
  pinned before, when going back narrows; a field a later edit moved is left
  alone. A revert does not narrow live Agents. A warrant-ceiling revert while
  tasks ride the warrant waits, shown as due, until a person sends
  `PATCH /warrants/{id}` `{applyRevert: <approvalId>, acknowledgeDependents:
  true}`. When something the widening added is still present and no narrowing
  removes it (a later narrowing left only added scopes in the set), the rest
  goes back and the record is **not closed**: it stays due on `/approvals`
  until a person narrows or revokes what remains, and the next sweep closes it.
- **A residual a later narrowing leaves is kept and named** (extending the rule
  "the scopes it added are removed" to the transport, the pin and the selector).
  When a widened credential `transport`, warrant `transportPin` or grant
  selector (`resourceId`) was legitimately narrowed between the widening and the
  task's end — the owning Account tightening `mcp` → `any` down to `api`, or
  root narrowing a grant moved from one object to every object down to another
  object — what remains at the end still exceeds the value before the widening,
  and no narrowing takes it back to that value. That value is a **residual**:
  the revert keeps it (a revert only narrows, and leaves a field a later edit
  moved as it is), closes the record, and names it. The closing
  `approval.revoked` ledger row carries
  `residual: [{field, before, approved, now}]` and, when the revert wrote
  nothing, a `reason` naming each field ("kept as a residual: …") instead of
  "nothing the widening added is still present"; when the revert also took
  something back, its own edit audit row (`path: "revert"`) carries the same
  `residual`. The naming covers every field a later edit moved while it still
  exceeds its value before the widening (the ceiling, the scope ceiling, the
  caps, the expiry and the verb too), so the closing reason is always true;
  "nothing the widening added is still present" is written only when nothing is.
- **Warrants**: an edit re-pins the ceiling (`ceilingRules` publish a new
  profile; the old version is unchanged), never changes the status (a suspended
  warrant stays suspended until `POST /warrants/{id}/resume`), keeps a widened
  ceiling within its creator's current authority (`403
  CEILING_EXCEEDS_CREATOR`), and releases the tasks riding it only with
  `acknowledgeDependents` (`409 WARRANT_HAS_DEPENDENT_TASKS`).
- **Grants**: an assignment-carried row (`GRANT_CARRIES_ASSIGNMENT`) and a
  creation-default or steward row (`GRANT_ORIGIN_NOT_EDITABLE`) are refused; an
  edited tuple equal to a live row is `409 GRANT_EXISTS`, and an expired twin is
  replaced; a row an approval made keeps an expiry at most 90 days out.
- **Not editable**: an Agent's credential (`AGENT_CREDENTIAL_NOT_EDITABLE`), a
  connection made by OAuth sign-in (`OAUTH_CREDENTIAL_RECONSENT`: re-authorize
  it), a legacy credential (`LEGACY_FROZEN`), and a revoked, graced or expired
  one (`CREDENTIAL_NOT_LIVE`). A field outside the table is
  `EDIT_FIELD_NOT_EDITABLE`; a body that changes nothing is `EDIT_NO_CHANGE`.
- **E2 binds edits too**. `knowledge-contents:write`
  reaches an Agent credential only when the Agent's mint requests it
  explicitly, inside the parent's own grants (answer E2); no edit adds it.
  Adding it to an Agent credential is refused `422 AGENT_SCOPE_MINT_ONLY`
  (with `mintOnly` naming the scope, clause 9e), ahead of
  `AGENT_CREDENTIAL_NOT_EDITABLE`, whoever edits — root included, as E2 binds
  root at mint — on every door: `PATCH /credentials/{id}`, the decide of a
  filed request on `/approvals`, and the agent's door (`POST
  /delegation/access-requests` and `relayhall_access_request`). Each refusal
  writes a durable denied audit row (`credential.edit`, `approval.decide` or
  `approval.request`). The record E2 requires is the mint itself: an Agent
  that needs the scope is a fresh mint that asks for it. A Connector
  credential is unaffected: root, an administrator or the owning Account
  within its own access may add the scope by edit in place, and a Connector
  may file for it.

**The agent's door.** A Connector that lacks scopes on its own credential files
`POST /delegation/access-requests` `{kind: "authority-edit", object: {type:
"credential"}, addScopes, reason, relatedTaskId?, relatedPhaseId?}` (or
`relayhall_access_request`). Root or an administrator approves it on
`/approvals` with step-up and a `lifetime`, possibly approving only some of the
scopes (`editedScopes`, the full approved set). The scopes are added to the
credential the agent already holds; nothing is collected. If the credential
changed after filing, the request lapses `TARGET_CHANGED` and the decider sees
`409 EDIT_STALE`. An Agent filing is refused `AGENT_CREDENTIAL_NOT_EDITABLE`,
and `AGENT_SCOPE_MINT_ONLY` first when it asks for `knowledge-contents:write`.
The Approvals hub shows the proposed edit field by field and names its object
kind. Approving requires an explicit lifetime, and the hub offers both on every
request (clause 6j): **Until a date** (or, when the request names a related
task, **Until this task ends, or a date**, whichever comes first) with a UTC
"Revert at" date, required when no task is related; or **Keep (until
narrowed)**. The hub sends `{"choice":"until-task","taskId"?,"revertAt"?}` or
`{"choice":"keep"}`. The request records the choice (`edit_lifetime`, the
related task, `edit_revert_at`; `authorityEdit.lifetime` in the API), and the
decided item shows the revert date. The edited credential, warrant or grant
keeps its own expiry: an until-task widening ends by its revert, which the
board's one-minute sweep (or the related task's terminal) applies as an
audited narrowing removing only what the widening added, once. A decision
refused before any state change, including a missing lifetime, leaves the
single-use step-up token usable for a corrected decision.

Every edit writes one `credential.edit`, `warrant.edit` or `grant.edit` audit
row with `{direction, path, changed, before, after, deciderStanding, stepUp,
lifetime, approvalId, follows, chain}`; a warrant edit also writes
`warrant.amended`, and a revert that keeps a residual adds `residual`.
No secret is ever read, recorded or returned.

### Change requests (kind `change`)

A **change request** asks for ONE change to authority or configuration, for
any Account or Group the filer may name, and a person decides it. It is an
Approval of `kind` `change` in the same queue, carrying a typed target
(`targetType`, and `targetId` or the objects inside `change`) and one
`change_spec` (`before`, `requested`, `approved`, `diff`). The four older kinds
are unchanged. Filing changes no authority; the decision applies the change in
its own transaction through the executor of the direct act, with the decider
as the standing principal, and records `appliedAt`.

**Filing** has two doors, one pipeline. A Connector or Agent files on the
bearer door, `POST /delegation/access-requests` `{kind: "change", targetType,
targetId?, change, granteePrincipalId?, granteeType?, reason, relatedTaskId?,
relatedPhaseId?}`; a person files as its own Account on the session door,
`POST /approvals/requests` with the same fields (`kind` may be omitted), and
withdraws its own pending request with `POST /approvals/{id}/withdraw`. Who
may be named is the filer's **standing**, computed live (see *Standing,
deciders and the hub* below): root and an administrator may name any Account
or Group; the owner of every object a target names may name any Account or
Group for it; an ordinary user otherwise names its own Account only, within
its role's ceiling (a `viewer` asks `read` only, `EXCEEDS_ROLE_CEILING`
otherwise).

Every object a filing names is read through the caller's own live authority
with the same predicates its reads use, and an object the caller cannot read
is answered exactly as an absent one, with the same body, and audited as
denied:

| Named object | Read as | Refusal (absent or unreadable alike) |
|---|---|---|
| a Project of `knowledge.compartment`; a grant's resource object (`grant.edit`, `grant.revoke`); a knowledge source | the object read decision (the one `GET` of that object answers) | `404 TARGET_NOT_FOUND` |
| a credential's holder (`credential.scopes`); the target Connector (`credential.issue`); a grant's grantee | in the caller's own Account subtree: its own; outside it, the directory read (`principals:read`), never for an ordinary user | `404 TARGET_NOT_FOUND` |
| an Account or Group grantee | the caller's own Account: its own; any other, the directory read (`principals:read`) | `404 GRANTEE_NOT_FOUND` |
| `relatedTaskId`, `relatedPhaseId` | the object read decision | `404 TASK_NOT_FOUND`, `404 PHASE_NOT_FOUND` |

`grant.rows` is the one target whose objects are what is asked for, so it
files on an object the caller cannot read exactly as on an absent one: the
held-row check (`ALREADY_HELD`) and the request's `before` rows cover only the
objects the caller reads, and the decider is told `409 OBJECT_NOT_FOUND` for
an absent one.

| `targetType` | Target | `change` | Decided by |
|---|---|---|---|
| `grant.rows` | the objects in the rules | `{rules, expiresAt?}` (rules as a grant request's; never `admin`, never `surface`) | root, an administrator, or the owner of every object (a person, a Group owner or a Group manager) |
| `grant.edit` | `targetId` = a grant | `{verb?, expiresAt?, resourceId?}` | a root session only |
| `grant.revoke` | `targetId` = a grant | `{}` | a root session only |
| `credential.scopes` | `targetId` = any Connector credential in reach | `{scopes}` (the full set; never `root` or `*:admin`; no `transport`) | root or an administrator |
| `credential.issue` | `targetId` = another existing Connector | `{scopes, transport?, label?, expiresAt?}` | root or an administrator |
| `knowledge.compartment` | the Projects in `change` | `{sourceId, operation?, projectIds, expiresAt?}` | root, an administrator, or the owner of every Project (a person or a Group owner) |
| `knowledge.shared_writer` | `targetId` = `<source>:organisation` | `{sourceId?, expiresAt?}` | root or an administrator |
| `identity.role`, `identity.create`, `identity.status`, `credential.revoke`, `warrant.create`, `warrant.edit`, `warrant.revoke`, `warrant.resume` | see *Identity targets* below | | |
| `project.owner`, `task.account_owner`, `report.account_owner`, `project.default_verifier`, `phase.default_verifier`, `charter.revision`, `phase.goal`, `task.roles`, `task.access`, `phase.access`, `report.visibility` | see *Object targets* below | | |

Every other target type the design declares requestable is refused
`TARGET_NOT_AVAILABLE`, naming the slice that builds it; a type declared out
of scope is refused `TARGET_NOT_REQUESTABLE` with its rule (a transport pin,
for one); an unknown one `TARGET_TYPE_UNKNOWN`. A Connector or Agent grantee
is refused `GRANTEE_INERT`; a row the grantee already holds `ALREADY_HELD`; a
knowledge subject Account or Project outside the lifecycle exporter's live
selection `409 KNOWLEDGE_NOT_EXPORTED` (with `account` and `project` naming
them); a Group subject the source does not treat as relevant
`GROUP_NOT_RELEVANT`. One pending change per object, grantee and requester
Account: a repeated filing answers `409 CHANGE_PENDING` with the caller's own
`approvalId`, and never blocks another filer. Request-made rows always expire
(default 14 days, at most 90). Every refusal is audited as denied with
`{code, rule, subject, clause}`.

**Deciding** is `POST /approvals/{id}/approve|deny` with ONE step-up bound to
(`approval.decide`, id); the body may narrow the change with `editedChange`
(untick rows, verbs, scopes or Projects, shorten `expiresAt`, `write` to
`read`, `any` to `mcp`/`api`), never widen it (`EDIT_ONLY_NARROWS`). The
executor that applies it accepts the decision's consumed token as its
evidence and spends no second one. A decider whose Account, or a principal
under it, is the requester's Account, the grantee or a member or steward of a
Group grantee, the target principal, or named by the approved change is
refused `403 SELF_DECISION_REFUSED` (root included). A target that changed
after filing lapses the request `TARGET_CHANGED` and answers `409
EDIT_STALE`; a knowledge change is re-checked against the export selection at
decide. Every refusal leaves the step-up token unspent.

**Collect.** An approved `credential.issue` is collected by the TARGET
Connector's own live credential on `POST
/delegation/access-requests/{id}/collect`, once, within 24 hours: `201` with
the new key, once. The requester and every other caller are answered `404`.

**Plugin state.** An approved `knowledge.compartment` or
`knowledge.shared_writer` change writes a core row at decide; the lifecycle
exporter carries it in its next generation and records `approval.applied
{generation}` on the request, once. A row no generation carried within 20
generations is marked `export: stalled` with `approval.export_stalled`.

#### Standing, deciders and the hub

**Standing to ask** is read from the live predicate at filing, never stored:

| Filer | May name | For |
|---|---|---|
| a root session | any Account or Group | every built target |
| an administrator login session (`operator`, and the root roles' sessions) | any Account or Group | every built target |
| the **owner tier**: a person whose live predicate reaches EVERY object of the target through an owner source alone — a Project's person owner (and its Phases and Tasks), a Task's own account owner, a Report's account owner or author, a Group owner or manager of a Group-owned object | any Account or Group | `grant.rows` on those objects, `knowledge.compartment` on those Projects (and `write` there, for itself too) |
| an ordinary user | its own Account | `grant.rows` within its role's ceiling, `credential.*` on its own Connectors, `knowledge.compartment` `read` on Projects it reads |
| a Connector or Agent | what its chain-root Account's tier may name, cut to its own credential: the owner tier is read through the delegation chain (every `own()` binds it, and the credential carries the type's `write` scope); a root or administrator Account's bearer names another grantee only for rows its own authority covers | the same targets |

A write grant, an Access profile, a role grant, a Task role or visibility
confers NO standing to name another grantee: `403 REQUEST_STANDING_NONE`
(`{tier, rule}`). A target some of whose objects lie outside the owner scope
is `403 TARGET_OUT_OF_SCOPE` (`{objects: n, hint: "split-by-project"}`): file
one request per Project. A bearer naming another grantee beyond its own
authority is `403 OWN_CAP_EXCEEDED`. A session-filed row binds
`session_evidence {door: "request", authMethod, standing}` and no credential.
Neither door is retry-keyed: a repeat converges on `409 CHANGE_PENDING`.

**"What may I request here"** is `GET /approvals/requests/preview` (session)
or `GET /delegation/access-requests/preview` (bearer), with
`?targetType=&targetId=` or `?objectType=&targetId=` (and optionally
`granteePrincipalId`, `granteeType`, `sourceId`). It runs the same standing and
validators and writes nothing — no audit row of any action, no approval, no
approval event or child row, no quota count — and answers `{requestable: [{targetType, grantees: "self"|"any"|"none", fields,
bound, deciders: [{standing, rule}], before}], refused: [{targetType, code,
hint?}]}`. An object the caller cannot read answers exactly as an absent one
and shows no owner standing; a compartment is previewed only for the knowledge
source named (the registry is never enumerated). The dry run is not wrapped in
a `READ ONLY` transaction: its validators read through the shared pool, not
one client.

**Who decides** is one ordered predicate, run on the locked row before
anything is applied (every refusal leaves the step-up unspent):

1. a login session (a bearer is `SESSION_ONLY`; a target whose executor needs
   a stored session refuses the break-glass session `DECIDER_SESSION_KIND`);
2. the decider is an active, non-legacy Account acting as itself, for EVERY
   kind (`403 DECIDER_NO_LONGER_ADMITTED`);
3. self-approval is refused (`SELF_DECISION_REFUSED`, `cases` (a)-(d): the
   requester's Account, the grantee or a member or steward of a Group grantee,
   the target principal's Account, an Account the approved change names; over
   the decider's whole subtree; root not exempt);
4. the first standing that admits, recorded as `deciderStanding`: `root`;
   `administrator` (not for `grant.edit` and `grant.revoke`, which a root
   session alone decides); the owner tier — `owner` when every object's stored
   owner value names the decider, `group-owner` when it names a Group in which
   the decider holds a live owner row, `group-manager` for `grant.rows` alone
   through a live manager row; else `403 APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR`
   with the reason;
5. the approved change lies within the decider's own authority;
6. ONE step-up; the executor re-checks that the consumed token is this
   decider's `approval.decide` for this approval before it applies anything
   (`STEP_UP_REQUIRED` otherwise).

**The hub** (`GET /approvals`, `?view=hub`, `GET /approvals/{id}` and the
notification history) shows a scoped decider a `change` item only when EVERY
object it names has a stored owner value naming the viewer or a Group in which
the viewer holds a live owner or manager row; any other item is
`404`-concealed. An item spanning two owners is visible to neither (root and
administrators decide it). Each hub item carries its own `deciders.rule`,
`decidable` and, where the viewer sees it but does not decide it,
`decisionRefusal {code, message}`. Both come from the decide route's own
order: the session kind (`DECIDER_SESSION_KIND`), liveness
(`DECIDER_NO_LONGER_ADMITTED`), self-approval (`SELF_DECISION_REFUSED`), then
the standing arm, so the hub and `POST /approvals/{id}/approve` answer the
same code. A `change` item also names the requester's chain-root Account
(`requesterAccountId`), never the chain beyond it.

**Before and after.** `GET /approvals/{id}` answers a decider's read of a
`change` item with `decision {view: "decider", change {fields, relationships,
summary, decided}, deciders, decidable, standing, refusal}`: the field diff,
the relationship edges `{principal, object, action, before, after, via,
state: added|removed|kept}` and one line ("1 principal gains read on 2
objects; nothing is removed"), computed from the stored before-state and the
approved (or, while pending, the requested) change. A `credential.scopes`
change also carries what it reaches, read by the projection the edit
request's decision block reads: the Connector's effective scopes before and
after (`via: "effectiveAfterEdit"`) and one `reached` edge per live Agent
under the Connector (`via: "identitiesReached"`); the summary then ends "the
change reaches 1 identity". A `credential.issue` change carries what the new
credential could exercise (`via: "effectiveAfterIssue"`), as the credential
request's decision block shows it, and no identity. The decision stores the
same as `change_spec.diff`. A decider's
hub item carries `relationships {edges, summary}`, the older kinds read
through the projection (a grant request as `grant.rows` for its Account, a
credential request as `credential.issue`, an edit request as
`credential.scopes`, a mint as the new Agent), and a `change` item also
`fieldDiff` and `view`.

**The requester's view.** The requester's own reads carry the field diff
only, never the relationship diff and never the decider. The requester side is
self-approval case (a): the viewer's Account, or a principal under it, is the
requester's chain-root Account, so it never decides the item (root included).
On the session door, `GET /approvals/{id}` answers it `decision {view:
"requester", change {fields, decided}, deciders, decidable: false, standing:
null, refusal}`, its `approval` with `decidedByPrincipalId` and
`change.deciderStanding` null and `change.spec.diff` cut to `{fields}` (null
until decided), and
its `events` with every action and time but the actor and metadata of its
own acts only. Its queue row (`GET /approvals`) and its hub item carry the
same record, and its hub item has `relationships: null`, `fieldDiff` and
`view: "requester"`. A non-deciding viewer of an older kind's hub item gets
`relationships: null` too. On the bearer door, `GET
/delegation/access-requests/{id}` carries `diff {fields}` and no decider.

The notification history (`GET /tasks/notifications`) follows the same rule
for every kind: on an approval row of an item whose requester is the viewer
or lies under it, `actorHandle` names only the viewer's own identities' acts
(its filing, its withdrawal); the decision, a lapse and a revert are listed
with their action and time and `actorHandle: null`. A decider-side viewer
(root, an administrator, a scoped decider) reads every actor, as before.

#### The surfaces for the first use

**Over MCP.** `relayhall_access_request` files a change (`action: "file"`,
`kind: "change"` with `targetType`, `targetId`, `change`,
`granteePrincipalId`, `granteeType`, `reason`, `relatedTaskId`,
`relatedPhaseId`), previews (`action: "preview"` with the query of `GET
/delegation/access-requests/preview`), reads and lists (`action: "status"`:
without an `approvalId`, every kind, the agent-mint requests read from
`GET /delegation/access-requests?kind=agent-mint` beside the default list,
with `kind` and `status` filters) and withdraws, all on the bearer-only
`/delegation/access-requests` routes above. Nothing on MCP decides: the
registry composes no `/approvals` path. The preview is a work-plane action
behind the bootstrap gate. See [docs/mcp.md](mcp.md#asking-for-authority-you-lack).

**In the dashboard.** "Request a change" on a Project's *Access &
capabilities* tab and on the Knowledge page opens one dialog that reads the
preview for the object, offers what it answers requestable (grant rows on the
Project within the bounded verbs, for yourself or, with the owner's standing,
for another Account; a knowledge compartment on chosen Projects, each ticked
Project previewed for the chosen source and a refused one named by its code
before anything is filed; with no knowledge source readable, the read grant
on a knowledge Service by its id) and files on `POST /approvals/requests`. A decider's hub item of kind
`change` renders the *Before and after* region (the field table and the
relationship table, with its one-line summary) above the narrowing controls
of its target type: untick rows, verbs or objects, narrow an all-of-type row
to exact ids (`selectorForm: "exact"`) and shorten the expiry for
`grant.rows`; untick scopes for `credential.scopes`; untick scopes, narrow
the pin and shorten the expiry for `credential.issue`; drop Projects, narrow
`write` to `read` and shorten the expiry for `knowledge.compartment`; shorten
the expiry for `knowledge.shared_writer`; approve or deny `grant.edit` and
`grant.revoke` as filed. The decision sends only what was narrowed, as
`editedChange`, with ONE step-up. An item the session sees but does not
decide shows why (`decisionRefusal`). *My requests*, a tab of the
notification centre beside *Approvals*, lists the session's own change
requests with their status and field diff, and withdraws a pending one its
own Account filed.

**Not in this release.** The decision offers an approved expiry date only: the
lifetime choice of design section 5.4 (keep, until a task ends, or until a
date, with the preselection rule of the authority-edit form) and the MCP
filing's `lifetime` field come with the change revert sweep in a later release.
Until then a filed lifetime is not offered and the server derives
it from `change.expiresAt`.

#### Identity targets

Eight more target types are filable on both doors. Each names its object by
`targetId` and no grantee (`granteePrincipalId` is refused
`GRANTEE_NOT_ADMISSIBLE`):

| `targetType` | `targetId` | `change` | Filed by | Decided by | Applied by |
|---|---|---|---|---|---|
| `identity.role` | the principal | `{role}` (one of the assignable roles) | root or an administrator for any principal they read; an ordinary user for its OWN Account only, up to an editor-class role (`EXCEEDS_ROLE_CEILING` for an elevated one) | root or an administrator; an `admin` or `orchestrator` role only by an `admin` decider (`403 DECIDER_CEILING_EXCEEDED`) | the role-change seam `POST /principals/{id}/role` uses, with the decider as the issuer; `principal.role.changed` |
| `identity.create` | omitted, or `handle:<handle>` | `{kind, handle, displayName?, role?, purpose?}` (`kind` is `human` or `service`; a service needs `purpose`; an Agent is `AGENT_MINT_ONLY`) | root or an administrator | a root session only | `principal.create` with the decision beside it; a new Connector's first credential stays a direct act |
| `identity.status` | the principal | `{status}` (`active` or `disabled`) | root or an administrator | a root session only | the account-status seam `PATCH /principals/{id}` uses (below); `principal.update` |
| `credential.revoke` | another principal's credential | `{}` | any principal within its standing (the credential you present is revoked directly: `KIND_NOT_FILABLE_HERE`) | root or an administrator | `credential.revoke`, the bound requests lapsing as on the direct door |
| `warrant.create` | the holder (or `change.holderPrincipalId`) | the `POST /warrants` body without `stepUpToken` | any principal within its standing: root or an administrator for a holder they read, an ordinary user for a holder in its own Account subtree; an anchor the filer cannot read is `ANCHOR_NOT_FOUND` | root or an administrator; the ceiling must lie within the decider's authority (`CEILING_EXCEEDS_CREATOR`) | `WarrantService.create` with the decider as creator; the decision's step-up is the act's |
| `warrant.edit` | the warrant | the editable fields of `PATCH /warrants/{id}`; a pin is never loosened (`TRANSPORT_NOT_REQUESTABLE`) | as `warrant.create` | root or an administrator | the in-place edit, `warrant.edit` with the approval id |
| `warrant.revoke` | the warrant | `{}` | as `warrant.create` | root or an administrator | `warrant.revoke` |
| `warrant.resume` | a suspended warrant | `{}` | as `warrant.create` | root or an administrator | `warrant.resume` (the creator live-cap re-proved) |

The principal a change is about never decides it, nor an Account it sits
under: the principal whose role or status changes and a revoked credential's
holder are the *target principal* (`SELF_DECISION_REFUSED` case `c`), a
warrant's holder is named by the change (case `d`); root is not exempt. The
decider narrows a role to a LOWER one only (by the scope class it derives:
admin and orchestrator, operator, the writer roles, viewer; a sideways move
within a class is `EDIT_ONLY_NARROWS`), and a warrant to a narrower scope
ceiling, lower caps, an earlier expiry or a narrower pin; the other identity
targets are approved or denied as filed. The stale check reads the
principal's role and status, the handle's freedom, the credential's liveness
and the warrant's status, editable fields and riding tasks: the tasks a
ceiling edit or a revoke would release are counted at filing, approving
acknowledges that count, and a different count at decide lapses the request
`TARGET_CHANGED`. The role, status or Account a decision changed is
published to the read caches after the decision commits, so it bites on the
next request. Every apply writes the target's own audit row with
`{approvalId, kind: "change", targetType, deciderStanding, stepUp, chain}`
(on `principal.create`, `kind` stays the principal's kind and the request
kind is `requestKind`).

**One status seam for both doors.** `PATCH /principals/{id}` and an approved
`identity.status` change run the same function: it writes the status and
its `principal.update` row and, when the status moves to `disabled`, revokes
every stored login session of the principal (`revoke_reason: disabled_user`)
and lapses every PENDING request naming it as grantee (`GRANTEE_DISABLED`),
in the same transaction; the row's metadata carries `sessionsRevoked` and
`lapsedApprovalIds`. An enable writes the status only; a revoked session
stays revoked.

**Over MCP** the identity targets are FILED only: the registry composes no
`/warrants`, `/grants`, `/groups`, `/access-profiles` or `/approvals` path,
a pinned ban, and the read tool keeps `/delegation/warrants`.

**Not in this release.** A role granted "until a date" with its revert waits
for the change revert sweep (a later release); a role request is kept as filed
until another request or the direct act changes it.

#### Object targets

Eleven more target types are filable on both doors. Each names ONE Project,
Phase, Task or Report by `targetId` and no grantee (`granteePrincipalId` is
refused `GRANTEE_NOT_ADMISSIBLE`); an object the filer cannot read is refused
`404 TARGET_NOT_FOUND` exactly as an absent one, and an archived one
`409 <TYPE>_ARCHIVED`. Root and an administrator file every one of them; an
ordinary user (or its Connector or Agent) files them only as the object's
OWNER (the person owner, a standalone Report's account owner or author, or a
Group owner), else `403 REQUEST_STANDING_NONE`. Each is approved with the
value it names or denied: nothing narrows.

| `targetType` | `targetId` | `change` | Filed by | Decided by | Applied by |
|---|---|---|---|---|---|
| `project.owner` | a Project | `{ownerPrincipalId}`: an active human Account that reads and writes Projects (`INEFFECTIVE_OWNER` otherwise), or an active Group | root, an administrator, or its owner | root, an administrator, or its PERSON owner for a move to another person; into, out of or between Groups root or an administrator only | the transfer act of `PUT /projects/{id}/owner` on the decider's session (the person owner's stored session, or an object administrator); a Group transfer takes the decision's step-up as its evidence; `project.owner.change` |
| `task.account_owner` | a Task | `{accountOwnerPrincipalId}`: an active human Account that reads and writes Tasks, or an active Group | root or an administrator | root or an administrator, on a STORED login session (`DECIDER_SESSION_KIND` for the break-glass session) | the act of `PUT /tasks/{id}/account-owner` on the decider's session; `task.account_owner.change` |
| `report.account_owner` | a standalone Report (`REPORT_TASK_BOUND` for a task-bound one) | `{accountOwnerPrincipalId}`: an active human Account that reads and writes Reports | root, an administrator, or its account owner or author | root, an administrator, or its account owner or author | the one writer of the column, new in this release; `report.account_owner.change` |
| `project.default_verifier`, `phase.default_verifier` | a Project or Phase | `{defaultVerifierPrincipalId}`: a person or Connector passing the usable predicate (`DEFAULT_VERIFIER_GROUP_PRINCIPAL`, `DEFAULT_VERIFIER_UNUSABLE`), or `null` to clear | root, an administrator, or the Project's owner | root, an administrator, or the Project's PERSON owner | the seam both `PUT .../default-verifier` routes run, with the decider's standing; `<type>.default_verifier.set` |
| `charter.revision` | a Project | `{content}` (as `POST /projects/{id}/charter/approve`); the request stores its sha256 | root, an administrator, or its owner | root, an administrator, or its owner (a person, or a Group owner through the Group-owner arm) | the Charter approval act: content and approval in one act, the decider the approver; `charter.approve` with the version and sha |
| `phase.goal` | a Phase | `{goal}` (`null` clears it) | root, an administrator, or the Project's owner | root, an administrator, or the Project's owner | `PATCH /phases/{id}`'s writer |
| `task.roles` | a Task | `{shepherdPrincipalId?, verifierPrincipalId?}` (a Verifier `null` clears it), checked as `PATCH /tasks/{id}/roles` checks them, at filing and again at decide | root, an administrator, or its owner | root, an administrator, or its owner | the roles writer with the decider as the assigner; `task.lifecycle_override.roles` |
| `task.access`, `phase.access` | a Task or Phase | `{restricted}` | root, an administrator, or its owner | root, an administrator, or its PERSON owner | the attributed access writer (its trigger ledger), and a new `audit_events` row `task.access.set` / `phase.access.set` |
| `report.visibility` | a standalone Report | `{visibility}`: `shared`, `public` or `default`, opening a CLOSED Report only (`VISIBILITY_NOT_OPENING` for any other label change, which stays a content write) | root, an administrator, or its account owner or author | root, an administrator, or its account owner or author | `PATCH /reports/{id}`'s writer, and a new `audit_events` row `report.visibility.set` |

**Authority never widens.** Every object target is applied in the decide
transaction with the DECIDER as the acting principal: the executor runs its
own direct predicate on the deciding session's own facts, and before it the
decider's own live reach on the object is checked at the action its direct
door asks (write; the Shepherd action for `task.roles`; admin for
`task.access` and `phase.access`), so an approval never applies what its
decider could not do directly (`403 DECIDER_CEILING_EXCEEDED`, the step-up
unspent). A person owner whose role cannot reach the admin action (an
ordinary user) therefore sees an access request it may decide by standing
and is refused at decide by that ceiling. The principal a change puts on the
object (the new owner, the default Verifier, the Shepherd, the Verifier)
never decides it, nor an Account it sits under (`SELF_DECISION_REFUSED` case
`d`; a Group value through its members and stewards). A stale preview never
applies: the object's state and its stored owner are re-read under the row
lock at decide, and any difference from what the request was filed against
lapses it `TARGET_CHANGED` (`409 EDIT_STALE`). Every apply writes the
target's own audit row with `{approvalId, kind: "change", targetType,
deciderStanding, stepUp, requesterChain}` beside the act's own fields, which
it never overrides.

### The approvals hub view (`GET /approvals?view=hub`)

The approvals hub (`/dashboard/approvals`) reads one opt-in view of the same
queue. Without `view` the answer is exactly the list described above; no
route was added, and the only mutating routes on `/approvals` remain
`approve` and `deny`. Login sessions only, like the rest of `/approvals`.

| Query | Values |
|---|---|
| `view` | `hub` (anything else is `400 APPROVAL_FILTER_INVALID`) |
| `status` | `pending` (default), `decided` (every state but pending) or `all` |
| `kind` | `agent-mint`, `grant`, `credential`, `authority-edit`, `change`, `skill-publish` or `native-review` |
| `group` | `shared`, `private`, `board`, or a Group id (items any of whose Groups is that Group) |

A value outside a grammar is a `400`, never a wider list. The view lists:

- every Approval the session may see, under the same self-scope as the
  default list (requester subtree; administrator sessions also every item
  of every kind, `agent-mint` included; root everything);
- **skill versions waiting for review** (`kind: "skill-publish"`), read from
  the existing review queue: a version whose newest event is `review`, listed
  only to a session that may publish it, which means a human principal
  holding `skills:admin` with write on the Skill who did not write the
  version. The item's `id` is the version id, and it carries
  `skill { id, name, version, description, provenance }`. There is no second
  pending state: the version is published or returned on the existing routes
  (`POST /skills/{id}/versions/{v}/publish|reject`), which take no step-up;
  a publication is audited as `skill.publish`, whose `skillVersionId` is the
  item's `id` (there is no Approval record, so the row names no approval);
- **verification requests waiting on a verifier** (`kind: "native-review"`),
  READ-ONLY: a native verification request (`task_native_reviews`, filed with
  `POST /tasks/{id}/native-reviews`) that is still active, meaning pending and
  not past its request expiry, or leased or attested and not past its lease
  (the states `GET /tasks/{id}/native-reviews` reports as `pending`, `leased`
  and `attested`). It is listed only on a task the session may read. The
  item's `id` is the request id, `requesterPrincipalId` is who filed it,
  `requestedAt` is when, `targetTaskId` is the task, and it carries
  `verification { state, serviceId, serviceName, descriptorVersion,
  verifierPrincipalId, verifierHandle, requestExpiresAt, leaseExpiresAt }`.
  `serviceName` is `null` where the session may not read the Service. The
  task's assigned verifier leases it and records the verdict on the task's
  own routes, so nobody decides it here: it is never `decidable`, its
  `decideVia` is `{}`, and its `deciders.rule` names the verifier. Only
  active requests are listed, so `status=decided` lists none of them and a
  finished request stays in the task's own review history.

Charter revisions and phase goals have no pending state on the board (a
Charter is approved by a direct write), so the view lists none of them.

Every item adds, read-only:

- `refs { task, phase, project }`: each `{ id, title }`. The id is always
  present. The title is present only when the session may read the object, or
  when it decides the grant or credential request (AZ-A9 clause 7); otherwise
  `null`. The item's own title fields follow the same rule in this view.
- `ownership { class, groups, basis, ownerKind, ownerHandle, ownerIsViewer }`
  (class order AZ-A12 clause 12): `group` when the
  project's OWNER is a Group (`basis: "owner"`, the page says "Owned by"), or
  failing that when the project has a live Group grant (unexpired, exact
  project; `basis: "grant"`, "Shared with"); `shared` when the project is
  shared or public with neither, `private` otherwise, `board` when there is no
  project (`basis` is null for these). `groups` lists the owning Group first,
  then the project's granted Groups with the creation-default Group first,
  then by name, each with its `basis`. The page lists the item once, under the
  first. `ownerKind` is the project owner's kind (`human`, `group` or null).
  `ownerHandle` names the owner of a private project where the session may see
  it.
- `deciders { rule, stepUp }`: who decides, as a sentence, and whether
  deciding takes step-up.
- `decidable`: whether THIS session may decide it now. It is computed by the
  same function `POST /approvals/{id}/approve|deny` decides with
  (`approvalDeciderStanding`): root decides every kind, an agent-mint item is
  decided by the Account whose subtree holds the requester or an
  administrator session (both see it), and a grant or
  credential item needs an administrator login session. For every kind, a
  session whose Account is not active, non-legacy and acting as itself
  decides nothing (`decidable: false`), as the decide route refuses it
  `DECIDER_NO_LONGER_ADMITTED`; a `change` item reads the change request's
  own ordered predicate (see "Standing, deciders and the hub"). A skill-publish item
  is listed only where it is decidable. A native-review item is never
  decidable.
- `decideVia`: the existing routes that decide it (`approve` and `deny` with
  step-up action `approval.decide`, or the Skill's `publish` and `reject`).
  For a native-review item it is `{}`: no route decides it from the hub, and
  `POST /approvals/{id}/approve|deny` answers `404` for its id.

The dashboard notice, the bell and the hub's "waiting on you" count the
pending items whose `decidable` is not `false`. The hub counts native-review
items separately, as "waiting on a verifier".

### Issuing a credential (runbook — the AZ-S3 shape)

Accounts are keyless: automation authenticates through a **Connector**
under its owning Account. The working path is Account → Connector
registration → Connector credential:

```bash
AUTH_HEADER='Authorization: Bearer REPLACE_WITH_RELAYHALL_TOKEN'

# 1. Create the service Account (purpose is REQUIRED — A17.1)
curl -s -X POST -H "$AUTH_HEADER" -H 'Content-Type: application/json' \
     -d '{"handle":"my_service","kind":"service","displayName":"My service","purpose":"What this automation is for"}' \
     $API/principals

# 2. Register the Connector — the registry row and its delegated identity
#    are created together; the Connector's parent is YOUR Account
curl -s -X POST -H "$AUTH_HEADER" -H 'Content-Type: application/json' \
     -d '{"slug":"my-service","name":"My service connector","kind":"connector"}' \
     $API/services

# 3. Issue the Connector credential — capture secretOnce from the response
#    (re-reveal later needs the lineage or a step-up token; see above)
curl -s -X POST -H "$AUTH_HEADER" -H 'Content-Type: application/json' \
     -d '{"label":"my-service prod","scopes":["tasks:read","reports:write"]}' \
     $API/principals/<connector-principal-id>/credentials | jq -r '.secretOnce'

# 4. Use it exactly like a JWT
curl -s -H 'Authorization: Bearer rh_…' $API/tasks

# 5. Rotate (exact copy; predecessor lives for the grace window, default
#    24h) / revoke (immediate)
curl -s -X POST -H "$AUTH_HEADER" -H 'Content-Type: application/json' \
     -d '{"graceHours":24}' $API/credentials/<credential-id>/rotate
curl -s -X POST -H "$AUTH_HEADER" $API/credentials/<credential-id>/revoke

# 6. Change its scopes in place (AZ-A13): same id, same key, nothing to
#    reinstall. A login session only; removing scopes saves at once, adding
#    them needs a step-up bound to (credential.edit, <credential-id>).
curl -s -X PATCH -b "$SESSION_COOKIE" -H 'Content-Type: application/json' \
     -d '{"scopes":["tasks:read","reports:write","phases:read"],"lifetime":{"choice":"keep"},"stepUpToken":"<rhsu_ token>"}' \
     $API/credentials/<credential-id>
```

Or via the CLI: `relayhall whoami`, `relayhall principals`, `relayhall principal create`, `relayhall credential issue|list|rotate|revoke`.

### Task create and edit fields

`successCriteria` and `success_criteria` are server-written. Ordinary
`POST /tasks` and `PATCH /tasks/{id}` refuse either spelling with
`400 SERVER_WRITTEN_FIELD` and `details.field`; no partial write occurs.
Blueprint instantiation still seeds criteria from its validated server-side
document. Review machinery reads the stored criteria (with its existing
legacy `definitionOfDone` fallback).

**Verifier edit:** `PATCH /tasks/{id}/success-criteria` accepts exactly
`{"successCriteria":["Observable acceptance check"]}`. The value may be a
string of at most 100000 characters or at most 200 strings of at most 10000
characters each. An empty string or array clears criteria; null, other fields
and invalid values return `422 INVALID_SUCCESS_CRITERIA`. Only the Task's
currently assigned Verifier or its actual account owner/appointed Main may
write. A broad verify grant, legacy Verifier-capable role, ordinary Connector,
Shepherd or implementer does not confer appointment (`403 TASK_VERIFIER_REQUIRED`
after readable object authorization). Unreadable Tasks retain concealment;
archived Tasks refuse `409 TASK_ARCHIVED`. Authority is rechecked under the
Task row lock. Criteria, the metadata-only `task.success_criteria.change`
audit and `task.updated` feed event commit together; sink failure rolls back
the write and returns `503 SUCCESS_CRITERIA_CHANGE_UNAVAILABLE`.
`GET /tasks/{id}` carries `successCriteriaAccess.allowed` as a display hint;
the writer always rechecks. The task page offers this editor only when the
hint allows it and otherwise displays criteria read-only.

Every column of the `tasks` table is either a **public** request field or
**server-written**, and the classification covers the whole table
(`backend/src/utils/taskColumnContract.ts`). A live suite reads the column list
from the database and fails until a column that a later migration adds is
classified, so a new column never becomes a request field by default.

**What a body may carry.** `POST /tasks` and `PATCH /tasks/{id}` accept
`title`, `description`, `status`, `priority`, `tags`, `project`, `phaseId`,
`autoStart`, `blockedReason`, `links`, `subtasks`, `dependsOn`,
`personalityId`, `thinking`, `model`, `executionProfile`,
`executionWarrantId`, `roleGrantExpiresAt`, `parentId`,
`definitionOfDone`, `constraints`, `notes` and `dueAt`, and `archiveReason`
on a `PATCH` that archives. Each keeps its own rules: the lifecycle gates on
`status`; `services:invoke` and descriptor validation on `executionProfile`;
the Warrant and grant-expiry rules beside it; and the notes and due-date
validators. `executionMode` is retired and still answers `400 FIELD_RETIRED`.
The six Task fields retired by migration 151 (`completedBy`, `activeAgent`,
`acpSessionKey`, `sessionRefs`, `lastChecked`, `autoCreated`, and their
snake_case column names) are no longer server-written columns: a `POST` or
`PATCH` that still sends one has that key silently dropped, like any other
undocumented key. This release adds no `FIELD_RETIRED` refusal for them.

**Dropping or switching a Warrant needs `services:invoke`**.
`executionWarrantId` names the Warrant that carries a Task's execution
assignment. Switching to another Warrant is sent beside the `executionProfile`
that makes the assignment, so it takes that field's `services:invoke` gate
(`403 PROFILE_INVOKE_REQUIRED`); a Warrant id without a profile answers
`422 WARRANT_WITHOUT_ASSIGNMENT`. `executionWarrantId: null` on its own, on a
Task whose assignment a Warrant carries, drops the Warrant and carries the same
assignment on an auto-grant instead, which is also an execution reassignment. A
caller without `services:invoke` (or `root`) is refused
`403 WARRANT_DROP_INVOKE_REQUIRED`, naming `executionWarrantId` in `field`; the
refusal writes a denied audit row and nothing else. On a Task no Warrant
carries, the null changes nothing. The gate does not apply to
`executionProfile: null`, which fully unassigns even a Warrant-carried Task,
revokes its Warrant-derived access, and needs only `tasks:write`. Over MCP,
`relayhall_task_update` does not take `executionWarrantId` and refuses it as an
unknown argument.

**What is refused by name.** A key that names a server-written column is
refused with `400 SERVER_WRITTEN_FIELD`, naming the key in `details.field`,
and nothing is written. The role identifiers and the execution keys above
already got this refusal. A key names a column when it is the column's Task
READ name or the column's own snake_case name:

- the retry budget and review state: `attemptCount`, `maxRetries`,
  `needsReview`, `reviewHistory`, `reviewStatus`, `reviewerSessionKey`,
  `reviewerLastRunAt`, `reviewerTimeoutSeconds`, `lastReviewedAt`;
- review/runtime metadata: `discordThreadId`, `thinkingAutoEstimated`, `statusReason`;
- identity, timestamps and disposition: `id`, `created`/`createdAt`,
  `updated`/`updatedAt`, `startedAt`, `completed`/`completedAt`, `archivedAt`,
  `archiveDisposition`;
- roles, ownership and access, each written by its own route:
  `ownerPrincipalId`, `creatorPrincipalId`, `shepherdPrincipalId`,
  `verifierPrincipalId`, `accountOwnerPrincipalId`, `visibility`,
  `restrictedAccess`;
- the execution assignment: `executionServiceId`,
  `executionDescriptorVersion`, `execution_mode`;
- Blueprint provenance: `blueprintKey`, `blueprintVersion`,
  `blueprintContentSha256`, `blueprintIdentitySha256`, `instantiationId`.

The server writes these columns itself. The Verifier records attempts,
verdicts and the review flag. A Blueprint's task defaults set `maxRetries`.
Lifecycle transitions write the timestamps and the archive disposition. The
role, access, account-owner and assignment routes write their own columns.

**Other keys are ignored.** A key that is neither public nor server-written
is dropped before the write, as it always was. Older Task detail clients sent
`agentInstructions`; that key was never stored, and the unsupported editor has
been removed. The CLI sends `role` and `blockedBy`. None of them is a field.

**The other surfaces.** `PATCH /tasks/batch` accepts its own, narrower list
(see [Batch updates](#batch-updates)) and refuses any other key as
`400 UNSUPPORTED_BATCH_FIELD`. Over MCP, `relayhall_task_update` and
`relayhall_task_recover` refuse a server-written key as an unknown argument.
`relayhall_task_create` likewise refuses every undeclared key as
`Unknown arguments: <keys>. Allowed: <keys>.` before any REST operation;
supported fields retain their existing relay to `POST /tasks`.

### Task notes

Use **Notes** for task-specific operational guidance and **Constraints** for
hard limits. Both are existing persisted Task fields with their own editors;
editing one preserves the other. Notes remain advisory, and accountability
comes from History. Reusable Agent instructions remain in Skills.

`POST /tasks/{id}/notes` `{text}` appends a timestamped, attributed line server-side. Notes are a single TEXT column, so read-modify-write appends from concurrent clients silently overwrite each other; this does the append in one statement.

**Creating a task with notes.** `POST /tasks` accepts `notes` and stores it verbatim, exactly as `PATCH /tasks/{id}` does — one validator serves both, so the two surfaces cannot disagree about the field: a string is stored, `null` leaves the column empty, and anything else answers `400 INVALID_TASK_NOTES` naming the field. It did not always: earlier, a `notes` value in a create body was accepted with `201` and silently dropped, and a caller that wanted notes on a new task had to follow every create with a `PATCH`. The create path leaves the same `task_history` row with `field=notes` that every other write to the column leaves.

### Subtask structure: add, reorder and edit text

Three routes in the stable-id Subtask family change a Task's Subtask structure
without replacing the whole list. They carry exactly the authorization of the
Subtask status verb (`PATCH /tasks/{id}/subtasks/by-id/{subtaskId}/status`):
`tasks:write` at the route ceiling and Task `write` at the point stage, so an
identity that may not set a Subtask's state on a Task may not add, reorder or
rename one there either; an unreadable Task answers `404`. Each locks the Task
row and its Subtask rows, records the same account-control disposition the
status verb records for an owner/Main caller, bumps the Task and emits one
`task.updated` event. Each accepts the optional `Idempotency-Key` header
(operations `task.subtask.create`, `task.subtask.reorder`, `task.subtask.text`,
credential-scoped, replay `return`).

- `POST /tasks/{id}/subtasks` `{text, position?, status?}` adds one Subtask.
  `text` is 1-1000 characters after trimming; `position` is 1-based (default:
  append), and Subtasks at or after it move down one; `status` defaults to
  `empty` and takes the six Subtask states. A state other than `empty` meets
  the rule the status verb applies from `empty`: an implementation caller may
  start a Subtask `in-progress`, `review` or `stuck`; `completed` needs actual
  account-owner or appointed Main authority (a Verifier is refused
  `409 SUBTASK_COMPLETE_FROM_REVIEW`: completion is a verdict from review). A
  completed Task refuses an unfinished Subtask (`409 TASK_REOPEN_REQUIRED`).
  Answers `201 {success, task, subtaskId, position, subtask}`; the new
  Subtask's stable id comes from the same sequence as every other Subtask's.
  Refusals: `400 INVALID_SUBTASK_TEXT`, `INVALID_SUBTASK_POSITION` (also a
  position past the end), `INVALID_SUBTASK_STATUS`, `UNKNOWN_FIELD`.
- `POST /tasks/{id}/subtasks/reorder` `{order}` puts the Subtasks in a new
  order. `order` lists every current Subtask id of the Task exactly once; ids,
  states and text never change. A malformed or repeated id is
  `400 INVALID_SUBTASK_ORDER`; a list that is not exactly the Task's current
  ids is `409 SUBTASK_ORDER_MISMATCH` and nothing moves. Answers
  `{success, task, order}`.
- `PATCH /tasks/{id}/subtasks/by-id/{subtaskId}/text` `{text}` replaces one
  Subtask's text, as the dashboard's Subtask edit does; its id, position and
  state are unchanged. Answers `{success, task, subtaskId}`; an unknown id is
  `404 SUBTASK_NOT_FOUND`.

The MCP tools `relayhall_subtask_create`, `relayhall_subtask_reorder` and
`relayhall_subtask_update_text`, and the CLI verbs `add-subtask`,
`reorder-subtasks` and `rename-subtask`, call these routes. The dashboard keeps
editing Subtasks through the whole-Task `PATCH /tasks/{id}` `subtasks` array,
which is unchanged.

### Task due dates

A Task may name **when it is due**: `dueAt`, an ISO-8601 instant, accepted by
`POST /tasks` and `PATCH /tasks/{id}` and returned by every CANONICAL Task
response — the point route, the list and the board, all of which hydrate the
whole Task. The deliberately compact projections do not carry it: the
`/tasks/graph` and `/tasks/aggregates` node shapes name their own small field
set and are not Task documents, so a consumer that needs a deadline reads a
Task rather than a node. `null` (or omitting it) means **no
deadline**, which is the ordinary state of most Tasks and not a missing value.

Three things are deliberate, and each was the alternative to something worse:

- **It is an instant, not a calendar date.** `2026-09-07` and
  `2026-09-07T00:00:00Z` are different moments for every reader east or west of
  UTC, so accepting a bare date would mean the server picking a timezone the
  caller never named. A value that does not name an instant answers
  `400 INVALID_DUE_AT`.
- **A past instant is accepted.** The board records deadlines; it does not
  police them. An import, a backfill and a deadline already missed are all
  ordinary, and a board that refuses to store a date that has passed cannot
  represent its own history.
- **What you send is normalised to UTC on read.** Two callers who named the
  same moment — one with `Z`, one with `+01:00` — read back the same string, so
  a client can compare deadlines without re-parsing them first.
- **The precision is microseconds, and it is stated rather than assumed.** The
  column is a `timestamptz`, which PostgreSQL keeps to six fractional-second
  digits, and the canonical form always carries all six:
  `2026-09-07T17:00:00Z` reads back as `2026-09-07T17:00:00.000000Z`, so one
  instant has one spelling. One to six digits are accepted and round-trip
  exactly; **seven or more answer `400 INVALID_DUE_AT_PRECISION`**. A finer
  instant is one this column cannot hold, and the API refuses it by name rather
  than storing a rounded one and reporting success — which is what it used to
  do, past three digits, until a review measured it.

- **The range is 0001-01-01T00:00:00Z to 9999-12-31T23:59:59.999999Z**, and a
  value carried past either end by its own timezone offset — say
  `9999-12-31T23:59:59-00:01` — answers `400 INVALID_DUE_AT_RANGE`. It is
  refused rather than stored as a year the column cannot spell, which is what
  used to happen.

#### A wall clock and a zone

`dueAt` also accepts a second form, and the dashboard's deadline control uses
it:

```json
{ "dueAt": { "local": "2026-09-07T19:00:00", "zone": "Europe/Warsaw" } }
```

`local` is a wall clock with NO zone designator — the time exactly as a person
wrote it — and `zone` is an IANA timezone name, the thing a browser reports as
`Intl.DateTimeFormat().resolvedOptions().timeZone`.

**The client does not convert it, and neither does the API process.** A local
time is not a moment: at the spring-forward jump a wall clock names none, at
the autumn fall-back it names two, and in a historical zone the offset between
them carries SECONDS (Europe/Paris was `+00:09:21` in 1900). Deciding any of
that needs a real timezone database, so the value is resolved by PostgreSQL —
the same database the column is stored in — and the answer is then PROVED by
rendering it back into that zone and comparing it with the clock that was sent.
A conversion that cannot be proved is refused, never stored.

Three things follow, and each is answered by name:

- **A local time that does not exist is refused.** `2026-03-29T02:30:00` in
  `Europe/Warsaw` is inside the hour the clocks jump over, and
  `2011-12-30T12:00:00` in `Pacific/Apia` is on a day Samoa skipped entirely
  when it crossed the date line. Both answer
  `400 INVALID_DUE_AT_LOCAL_TIME`, and the message NAMES THE ZONE that made it
  impossible.
- **An ambiguous local time uses PostgreSQL’s deterministic `AT TIME ZONE` policy:**
  the offset after a backward clock change. Every zoned write reports the policy and actual offset,
  as a sibling of `task`:

  ```json
  { "success": true, "task": { "dueAt": "2026-10-25T01:30:00.000000Z" },
    "dueAtResolution": { "zone": "Europe/Warsaw", "local": "2026-10-25T02:30:00.000000",
      "instant": "2026-10-25T01:30:00.000000Z", "offset": "+01:00",
      "offsetSeconds": 3600, "chosen": "postgresql" } }
  ```

  See [PostgreSQL’s timestamp policy](https://www.postgresql.org/docs/16/datetime-invalid-input.html).
  A caller who means the other occurrence says so with the instant form, which
  states an offset and therefore names exactly one moment.
- **A zone this server does not know answers `400 INVALID_DUE_AT_ZONE`**, and
  the name it was sent is not echoed back into the message.

`dueAtResolution` appears only for this form, on `POST /tasks` and
`PATCH /tasks/{id}`. The stored value is always a UTC instant; the resolution
is a receipt for a decision, not a second representation of the deadline.

**The interface renders it** as a distance ("Due in 2 d", "Overdue by 3 h") on
the board card and as the full instant on the Task's own page, and it shows the
absolute UTC instant beside the deadline control — because two different
moments render as the same local clock on a fall-back day, and a reader needs
to be able to tell them apart. The CLI sets it with `relayhall create --due`
and `relayhall update --due`, which send the instant form, and `--due ""`
clears it.

### Assignment grant expiry (AZ-A10 clause 6)

When a Task is assigned to a Connector without a Warrant, the assignment writes
read and write grants on that Connector's principal for the Task and read grants
for its Phase, one-hop dependencies, linked Reports and referenced Skills.
The Task's Verifier and Shepherd receive read grants for that same bounded set;
an Agent receives grants for its stored bound-task role. These role links are
removed when the Task finishes, the holder leaves the role, or its credential
or principal is revoked or disabled. A Verifier or Shepherd change on a
completed or archived Task is recorded and creates no role rows. Role grants on
an Account are not inherited by its sibling Connectors. Amendment AZ-A10
(ratified 2026-10-10) dates the rows and records their role and holder.

`roleGrantExpiresAt` is an optional field of the **assigning act**: send it
beside the `executionProfile` that makes the assignment, on `POST /tasks`,
`PATCH /tasks/{id}` and `POST /tasks/{id}/recover`, or beside a Verifier or
Shepherd change on `PATCH /tasks/{id}/roles`. It is the only field read as the
date: an unrelated Task write cannot move a role holder's expiry. An Agent's
role links instead follow its live credentials and their lease renewal: they
take the latest date among them, and no date when a live credential has none.
An act that would give role rows to an Agent with no live credential is
refused `409 ROLE_AGENT_EXPIRY_MISSING`.

- **Omitted: the default, three months after the assignment.** PostgreSQL
  computes it from the assignment transaction's own time, in UTC.
- **Any earlier or later future instant is admitted**, with no floor and no
  ceiling, and the date is stored exactly. Whoever performs
  the assigning act may set it. No extra role is asked for; the act's own gate
  applies: `tasks:write`, write on the Task (or Shepherd authority for a
  reassignment or a recovery), and `services:invoke` for the profile.
- **`'unlimited'`** stores no date: the rows last until the Task or the
  assignment ends.
- The value is an ISO-8601 instant with `Z` or an offset, or
  `{ local, zone }`, resolved by the server exactly as [`dueAt`](#task-due-dates)
  is. A bare date names no instant and is refused.

| Refusal | When |
|---|---|
| `422 ROLE_GRANT_EXPIRY_WITHOUT_ASSIGNMENT` | The field without an `executionProfile` on the Task write, or without a Verifier or Shepherd assigning act on the roles write. The date cannot be changed on its own. |
| `422 ROLE_GRANT_EXPIRY_WITH_WARRANT` | The field beside `executionWarrantId`, or on a Task whose assignment a Warrant carries. A Warrant writes no grant rows and follows its own expiry. |
| `422 INVALID_EXPIRY` | An instant that is not in the future (D-11). Nothing is written. |
| `409 ROLE_GRANT_EXPIRY_TASK_TERMINAL` | The Task is, or becomes in the same write, completed or archived; it holds no rows to date. |
| `400 INVALID_ROLE_GRANT_EXPIRY` | A bare date, `null`, a capitalized literal or any other non-instant. |
| `400 INVALID_ROLE_GRANT_EXPIRY_PRECISION`, `_RANGE`, `_ZONE`, `_LOCAL_TIME` | The deadline refusals, renamed: more than six fractional digits, out of range, an unknown zone, a wall clock inside a spring-forward gap. |

A refusal rolls the whole write back, so a refused create leaves no Task.

**The write response** carries `roleGrantExpiresAt`: the date the assignment's
rows now carry, as a canonical UTC instant with six fractional digits, or
`'unlimited'`. For a `{ local, zone }` value it also carries
`roleGrantExpiryResolution`, in the `dueAtResolution` shape.

**Re-dating an assignment.** Sending the `executionProfile` the Task already
carries, with a new `roleGrantExpiresAt`, re-dates that assignment's rows in
place: nothing is removed or created, and the assignee must still be able to
read the Task afterwards. A recovery to the same Connector does the same, and a
recovery retry is answered `replayed` only when the rows already carry the
date it names.

**Shared rows.** One grant row can serve several assigned Tasks: two Tasks that
reference the same Report share one read row on the same assignee principal. Each
Task's link keeps the date its own assignment set, and the row's `expires_at`
is the **latest** of those dates. If any link has no end date, the row has
none. When a Task's link goes (the Task finishes, is unassigned, or stops
referencing the object), the row is recomputed from the links that remain. An
expired row found again by a new assignment takes the new date. A row the
assignment did not create (one an owner granted, or one an approved access
request wrote) is linked but **never re-dated**.

**Reaping.** Dated and unlimited rows alike are removed when the
Task reaches `completed` or `archived` (by PATCH or by the verifier's verdict),
when it is deleted, unassigned or reassigned. A reopened Task gets new rows at
the default; removed rows are never revived. Between those events the
authorization check ignores a row past its date, so the assignee stops reading
at that instant. Expired rows are not swept; they stay until the Task's
terminal state removes them. An Account-landed link from before AZ-A10 that the
upgrade could not replace (an administrator holder, or an assigner it could not
attribute) still loses an object the Task stops referencing, under the same
shared-row rules; a link edit never adds anything to it.

**Where the date shows.** `GET /tasks/{id}/assignment-access` gives each link
`roleGrantExpiresAt` (the date this Task's assignment set; `null` = until the
Task ends, and always `null` for a Warrant), `expiresAt` (the row's effective
date) and `expired` (decided by the database clock). The Task page's
Assignment access panel shows them, and the grant rows appear with their
expiry wherever grants are listed.

**Audit.** `grant.create` names `expiresAt` and `assigneePrincipalId`.
`task.execution_assign` carries `roleGrantExpiresAt: { requested, applied,
source }`, where `source` is `default` or `assigner`; a re-date adds
`reasserted: true` and `before`. Every change to a row's date writes
`grant.expiry_change` with `{ automatic, before, after, taskId, reason }`.

### New-card placement: the project inbox phase

A Project may
name one **inbox phase**: `inboxPhaseId` on the Project record, set with
`PATCH /projects/{id}` under the usual `If-Match` and cleared with `null`. It
must be a Phase of that Project that is neither archived nor restricted:

| Refusal | When |
| --- | --- |
| `422 INVALID_PROJECT_VALUE` | the value is neither a UUID nor `null` |
| `422 INBOX_PHASE_NOT_IN_PROJECT` | no such Phase, or a Phase of another Project (one answer for both) |
| `409 PHASE_ARCHIVED` | the Phase is archived |
| `409 INBOX_PHASE_RESTRICTED` | the Phase is restricted; cards filed there would be hidden from the Project |

The database binds the value to its own Project with the composite key
`projects_inbox_phase_fk` (migration 141). No migration names an inbox: every
Project starts without one, and creation behaves as it always has until an
owner sets it.

**The default.** `POST /tasks` decides placement field by field, and an
explicit value wins for its own field:

| Request | Lands in | Status |
| --- | --- | --- |
| no `phaseId`, no `status`, the Project names an inbox | the inbox phase | `ideas` |
| no `phaseId`, a `status` | the inbox phase | that status |
| a `phaseId`, no `status` | that Phase | `ideas` if it is the inbox phase, otherwise `todo` |
| `phaseId: null` | the unphased backlog | the given status, otherwise `todo` |
| the Project names no inbox, or there is no Project | unphased, as before | the given status, otherwise `todo` |

Only an ABSENT `phaseId` triggers the default; `null` is an explicit choice of
the backlog and is honoured as one. This is how an authorised follow-up or a
release blocker goes straight to To-Do in its active Phase: name the Phase and
the status. The rule is decided once, inside the creating transaction, so every
surface gets the same answer: the dashboard's New task form (which preselects
the inbox phase and Ideas while nothing is chosen) and its Project Work-tab
quick create, `relayhall_task_create` and `relayhall create`. The `201` body's
`task.phaseId` and `task.status` say where the Task landed. Existing Tasks are
never moved: naming or changing the inbox decides only where new Tasks land.

**Suspended, never redirected.** While the inbox phase is archived or
restricted the default does not apply, and a Task created without a phase stays
unphased with status `todo`; restoring the Phase resumes it. A Phase that a
Project names as its inbox cannot be deleted: `DELETE /phases/{id}` answers
`409 PHASE_IS_INBOX` until the inbox is cleared or changed.

The compiled Task Brief's **Project Context** names the inbox phase in an
`### Inbox phase` section (quoted JSON: its id, name, state and the default
status), and the project-awareness Brief (`POST /projects/{id}/brief {}`)
carries `project.inboxPhaseId`.


### Verification modes

Universal harness connector design, section 6.8. A Task read
carries `verificationMode` (`human`, `service`, `none` or `unassigned`),
`verificationNone`, and, for `none`, `verificationNoneSetByPrincipalId`,
`verificationNoneBasis` (`account-control` or `role-authority`),
`verificationNoneSetAt` and `verificationNoneClearedAt`.

- `POST /tasks` with `"verificationNone": true` creates a Task with no
  verification, in To Do or Ideas (an explicit `ideas`, or the inbox-phase
  default when no status is given). An inherited default Verifier is
  displaced and audited. Refused `VERIFICATION_NONE_WITH_VERIFIER` beside
  `verifierPrincipalId`.
- `PATCH /tasks/{id}/roles` with `{"verificationNone": true}` (on its own, else
  `VERIFICATION_NONE_EXCLUSIVE`) sets it on a To-Do Task that has never
  started (`VERIFICATION_NONE_TASK_STARTED` otherwise); `false` clears it.
  Assigning a Verifier clears it as well, and once cleared it cannot be set
  again (`VERIFICATION_NONE_CLEARED`). An Agent is refused
  `VERIFICATION_NONE_AGENT`, a principal of the implementing chain
  `VERIFICATION_NONE_CHAIN_GUARDED`, also when it holds the Account-control
  path (a human Account never shares the chain).
- `POST /tasks/{id}/finish` on a `none` Task answers `status: "completed"`
  (a dry run reports `targetStatus: "completed"`), completes Subtasks in Review
  and makes dependents ready. It refuses `VERIFICATION_NONE_SELF_SET` when the
  setter shares the implementing chain (see
  [Authorization](authorization.md#verification-modes-and-the-chain-guard)).
- A move to `review` on a `none` Task is refused `VERIFICATION_NONE_NO_REVIEW`.
- A Blueprint Task may carry `"verification": "none"` (never beside
  `roles.verifier`, only for a Task created in To Do). The preview shows it per
  Task and warns `BLUEPRINT_CHAIN_UNVERIFIED` when no Task in the chain is
  verified.

### The default Verifier

A Project and each Phase carry
`defaultVerifierPrincipalId` (`null` = none). New Tasks inherit it: an explicit
`verifierPrincipalId` on `POST /tasks`, else the default of the Phase the Task
lands in (after the inbox decision above), else the Project's, else none. The
Task records `verifierSource` (`explicit`, `inherited-phase`,
`inherited-project`, `assigned`, or `null`). Authority, the usable predicate and
the reopening behaviour are in [Authorization](authorization.md#default-verifier).

```http
PUT /projects/{project-id}/default-verifier
If-Match: <project revision>
Content-Type: application/json

{ "principalId": "<person or Connector principal id>" }
```

`PUT /phases/{phase-id}/default-verifier` takes the same body with the Phase
revision. `null` clears. A login session of root, an administrator or the
person owner of the Project; the answer is
`{ success, project | phase: { id, defaultVerifierPrincipalId, revision }, previousDefaultVerifierPrincipalId }`.

| Refusal | When |
| --- | --- |
| `403 SESSION_ONLY` | a bearer credential (audited) |
| `403 DEFAULT_VERIFIER_REQUIRES_OWNER` | a caller who can read the object but is not root, an administrator or the person owner; on a Group-owned Project anyone but root or an administrator. On the Phase route, read on the Phase or on its Project (not for a restricted Phase) counts as reading it. Audited `denied` |
| `404 RESOURCE_NOT_FOUND` | the caller cannot read the object (concealment), on both routes; nothing is audited |
| `400 REVISION_REQUIRED` / `412` (Project) or `409` (Phase) `REVISION_MISMATCH` | the `If-Match` revision is missing or stale |
| `409 PROJECT_ARCHIVED` / `409 PHASE_ARCHIVED` | the object is archived |
| `422 DEFAULT_VERIFIER_GROUP_PRINCIPAL` / `422 DEFAULT_VERIFIER_AGENT_PRINCIPAL` | a Group, or a non-legacy Agent |
| `422 DEFAULT_VERIFIER_UNUSABLE` | the principal cannot judge Tasks now; `details.failedArm` names the arm |

`GET /projects/{id}/default-verifier/candidates` lists the principals a picker
may offer: active people and Connectors that pass the predicate now (it needs
`principals:read` beside read on the Project).

**Create.** An explicit `verifierPrincipalId` that is not a default of the
target Project, or that cannot judge the Task, is refused
`422 VERIFIER_NOT_ALLOWED` and nothing is created. An inherited default that
cannot judge the Task is left unset and the `201` carries:

```json
{ "warnings": [ { "code": "DEFAULT_VERIFIER_UNUSABLE", "source": "inherited-project",
                  "principalId": "...", "failedArm": "chain", "message": "..." } ] }
```

`failedArm` is `none`, `principal`, `chain`, `scope` or `independence`, or
`assignment` when the role write itself was refused (named, never a `503`).

**Review.** A move into `review`, `POST /tasks/{id}/finish` and a create in
`review` without a usable Verifier answer `200`/`201` as before, plus
`warnings: [{ code: "VERIFIER_NOT_USABLE", failedArm, verifierPrincipalId, message }]`,
and the message is folded into `warning`. Nothing is refused. `GET /tasks/{id}`
carries the live `verifierUsability` `{ usable, failedArm?, principalId }`.

**The census filter.** `verifierUnusable=true` on `GET /tasks`, `/tasks/board`,
`/tasks/ids`, `/tasks/aggregates` and `/tasks/graph` keeps only Tasks without a
usable Verifier; on `GET /tasks` each row then carries `verifierUsability`. Over
To-Do and Review it is the morning census:
`GET /tasks?statuses=todo,review&verifierUnusable=true`.

## Knowledge search

Three routes read the knowledge plane under `knowledge-contents:read`
(vocabulary amendment A21). The request and source wire are specified in
[selector-amendment-v1.1](contracts/knowledge-v2/selector-amendment-v1.1.md),
[v1.2](contracts/knowledge-v2/selector-amendment-v1.2.md) and
[v1.3](contracts/knowledge-v2/selector-amendment-v1.3.md), against
[selector-v2.schema.json](contracts/knowledge-v2/selector-v2.schema.json).

- **`GET /knowledge-sources`** — the sources you may query: knowledge-configured,
  visible to you and inside your `knowledge-contents:read` selector. A source
  failing any of the three is absent with no marker, so an empty list and an
  empty registry look the same.
- **`POST /knowledge-queries`** — one search across that set. Body:
  `{protocol_version?: 2, q, sources?, kinds?, categories?, limitPerSource?, timeoutMs?, includeArchive?}`.
  `q` is 1–1024 characters. `sources` narrows to at most 16 source ids; ids you
  cannot query are ignored silently. `kinds` (`code`, `docs`, `data`) defaults
  to all three. `limitPerSource` is 1–25 (default 8) and `timeoutMs` 500–8000
  (default 8000, the maximum). `categories` and `includeArchive` need `protocol_version: 2`,
  which also refuses any other key.
- **`GET /knowledge-contents?handle=…`** — opens a cited result by its sealed
  handle under your current authority; `continuation` and `ifNoneMatch` are
  optional. A handle grants nothing by itself.

**The default scope.** A search covers
current knowledge. A source may declare some of its categories as its archive
(`knowledgeSource.archiveCategories` in its descriptor); unless you send
`includeArchive: true`, the core subtracts those categories from what it asks
that source to search, and a source left with nothing else is skipped with
reason `categories`. The flag never reaches a source and grants nothing: it
only stops the subtraction, and the source still answers only what you may
read. Handles from a default search carry the narrowed filter, so they cannot
open an archive document.

**The answer** is `200 {success, protocol_version?, coverage, groups, auditRef}`
whatever the sources do; a failed source never fails the search. `coverage`
comes first:

| Field | Meaning |
|---|---|
| `consulted` | the sources this search reached; the next five partition it |
| `answered`, `timedOut`, `refusedBySource`, `refusedByPolicy` | one outcome per consulted source |
| `unavailable` | `[{id, reason: transport \| rate-limited, retryAfterSeconds?}]` |
| `truncatedResults`, `invalidResults` | answered sources whose results were cut or partly dropped |
| `partialSources` | `[{id, reasons, deadlineFired?}]`, answered sources that said their answer is partial (v2); `deadlineFired` is `caller_deadline` or `source_deadline` when the source named the budget behind `deadline` |
| `skipped` | `[{id, reason: kinds \| categories \| unsupported-selector, selector?}]`, never in `consulted` |
| `searchedCategories` | `[{id, categories}]` for every consulted source: the categories it was asked to search, or `"all"` when no category filter was sent |
| `archive` | `{included, declaredBy}`: whether you opted in to the declared archive categories, and which consulted sources declare an archive (always within `consulted`) |

`groups` holds each source's results in that source's own order, each with a
sealed `handle`.

**The time budget** (amendment v1.3). Each v2 source is told
how long the core will wait for it: `budget_ms`, the source's dial budget
(`min(timeoutMs, what is left of the whole-request deadline)`) less a 300 ms
return margin. A source that honours it bounds its whole search by your budget,
so a slow first search that fits `timeoutMs` answers rows. When time runs out
the answer stays truthful: the source answers `partial` with reason `deadline`
and `deadlineFired` says whose budget it was (`caller_deadline` for the budget
the core sent, `source_deadline` for the source's own default); a source the
core stopped waiting for is in `timedOut`. A store's first search for a new
text can take about 6 s, so the default `timeoutMs` is the maximum, 8000: a
caller that sends none (the MCP tool forwards none) gives that search the whole
budget, and the dashboard and the CLI send 8000. A smaller `timeoutMs` answers
sooner and may answer `partial`.

**Refusals.** `422` names your own input: `KNOWLEDGE_QUERY_INVALID`,
`KNOWLEDGE_KINDS_INVALID`, `KNOWLEDGE_SOURCES_INVALID`, `KNOWLEDGE_LIMIT_INVALID`,
`KNOWLEDGE_TIMEOUT_INVALID`. `400 INVALID_SELECTOR` is a v2 selector your
visible sources cannot serve or a malformed one: an unknown key, a category no
visible source declares, a non-boolean `includeArchive`, or `categories` or
`includeArchive` without `protocol_version: 2`. `422 SOURCE_SELECTION_TOO_BROAD`
(with `auditRef` only) means more than 16 eligible v2 sources; narrow with
`sources`, `kinds` or `categories`.

## Knowledge writes (RB-11 Governor v0)

`POST /knowledge-writes/propose`, `/preview` and `/commit` relay a note to a
registered knowledge source's own write surface. They require
`knowledge-contents:write`; any other path or method under `/knowledge-writes`
requires `root`. The board writes no object of its own for them and stores no
note content. The wire the core dials is specified in
[write-door-v1](contracts/knowledge-v2/write-door-v1.md).

- **propose** `{title, content, source?, noteType?, tags?, target?, taskId?, basis?, revisionOf?, expectedRevision?}`
  → `200 {success, source, auditRef, result}`, where `result` is the source's
  proposal unchanged: `proposal_id`, `preview_digest`, `expires_at`, the exact
  bytes it would write (`content_base64`, `content_sha256`, `byte_length`), the
  target compartment and the resolved `audience`. `target` is `"default"`,
  `"personal"` or `{compartmentId}`; the default is the Task's Project with a
  Task context and your personal notes without one. `basis` and `revisionOf`
  are sealed handles; `expectedRevision` is `"absent"` for a new note and the
  sha256 you read for an update (`revisionOf` required). Omitting `source`
  picks the one write-capable source your grants admit; zero or several answer
  `400 source_required`.
- **preview** `{proposalId, source?}` → the same shape, re-resolved against the
  source's current grants.
- **commit** `{proposalId, previewDigest, expectedRevision, source?}` →
  `200 {success, source, auditRef, result: {protocol_version, status:
  "committed", handle, compartment, sha256, committed_at}}`. The source's ref
  is sealed into `handle`; read it back with `GET /knowledge-contents`. Commit
  accepts the retry header (`Idempotency-Key`, credential scope): a same-key
  retry within 24 hours returns the stored receipt without reaching the source.

**Task context.** An Agent always writes in its bound Task: a different `taskId`
is `422 task_context_mismatch`. Anyone else may name a Task they can read; an
unreadable or unknown one is the uniform `403 refused`. A Task with no Project
gives no Task context.

**Only the principal that proposed** may preview or commit a proposal; anyone
else meets the uniform `403 refused`.

**Refusals** carry `code`, `status: "refused"`, `refusedBy` (`core` or
`source`) and, once the act has begun, `auditRef`:

| Status | Code | Meaning |
|---|---|---|
| 400 | `content_invalid` (with `field`) | your input broke a bound: title 1–200 characters on one line, content at most 32768 bytes of UTF-8 and not opening with `---`, `noteType`, at most 16 tags, at most 25 basis items, the whole request at most 64 KiB, an unknown field |
| 400 | `handle_malformed`, `handle_tampered`, `handle_key_retired`, `handle_key_unknown`, `handle_version_unsupported` | a basis or `revisionOf` handle is not usable |
| 400 | `revision_of_invalid` | `revisionOf` names another source, or `target` is not its compartment |
| 400 | `source_required` | `source` omitted and not exactly one write-capable source admits you |
| 403 | `refused` | uniform: the source or Task is not yours to use, or the proposal is not yours — no reason is given; it is in the audit row |
| 403 | `source_not_write_capable` | a source you can read accepts no writes |
| 403 | (route ceiling) | `knowledge-contents:write` missing; `details.requiredScopes` names it |
| 422 | `task_context_mismatch` | an Agent named a Task other than its bound one |
| 502 | `source_protocol_error` | the source answered outside the contract |
| 503 | `unavailable` | the audit row could not be written; nothing was sent (or, after the dial, the outcome could not be recorded) |
| 503 / 504 | `source_unavailable` / `source_timed_out` | the source could not be reached in time |

The source's own refusals pass through with their status and `refusedBy:
"source"`: `target_not_writable`, `no_private_scope`, `audience_exceeds_basis`,
`basis_unreadable`, `not_own_note`, `content_secret_suspect`, `egress_blocked`,
`reserved_name`, `assertion_invalid` (403), `content_invalid` (400), `audience_changed`,
`preview_mismatch`, `revision_conflict` (409), `proposal_expired` (410),
`daily_cap` (429), `internal_error` (500), `commit_unverified` (502, with a
`handle` for the flagged revision) and `unavailable` (503).

**Audit.** Every act writes an append-only `knowledge_write_audit` row before
the dial and another after it; if either cannot be written the act fails. Rows
hold ids, digests and outcome tokens only — never content. Reading them is
owner-plane authority.

## Shared-area writer list

A knowledge source's organisation-wide shared area is readable by everyone the
source admits and writable only by the Accounts on its writer list. The list is
delivered to the source in the signed lifecycle snapshot (`shared_writers`, see
[lifecycle-exporter](contracts/knowledge-v2/lifecycle-exporter.md)); who may
change it is in [authorization](authorization.md#shared-area-writer-list).

- `GET /knowledge-shared-writers[?source=<id>][&view=administration]`
  (`services:read`) → `200 {success, source: {id, slug, name}, scope:
  "organisation", writers: [{accountId, label}], youCanWrite}`. `source` is a
  knowledge source id; omitted, it is the one source that accepts writes.
  `youCanWrite` says whether your own Account is on the list, active and
  unexpired. `view=administration` adds, per row, `active`, `addedBy {id,
  label}`, `addedAt`, `reason`, `expiresAt`, `approvalId` and `origin`
  (`direct` in this release); it is answered to a root or an administrator
  login session only.
- `POST /knowledge-shared-writers` `{accountId, reason, expiresAt?, source?,
  stepUpToken}` → `200 {success, action: "add", source, scope, accountId,
  before, after, auditId, expiresAt}`. A login-session act for root or an
  administrator. The step-up is minted with `action:
  "knowledge.shared-writer.add"` and `targetId` = the Account id. `reason` is
  20-2000 characters; `expiresAt` is ISO-8601 in the future (omitted = never).
- `POST /knowledge-shared-writers/remove` `{accountId, reason, source?,
  stepUpToken}` → the same shape with `action: "remove"`; the step-up action is
  `knowledge.shared-writer.remove`.

Both POSTs accept the retry header (`Idempotency-Key`, credential scope; a
login session scopes to its own Account): a same-key retry within 24 hours
returns the stored answer. Each change writes one `audit_events` row
(`knowledge.shared_writer.add`, `.remove`; the expiry sweep writes `.expire` as
actor `system`) with the list before and after, the reason and the step-up
token id, and the source applies it at its next snapshot (about 20 seconds).

| Status | Code | Meaning |
|---|---|---|
| 400 | `SHARED_WRITER_INVALID` (with `field`) | `accountId`, `reason`, `expiresAt`, `source` or `view` is malformed |
| 400 | `SHARED_WRITER_SOURCE_REQUIRED` | `source` omitted and more than one knowledge source accepts writes |
| 403 | `SHARED_WRITER_REQUIRES_SESSION` | a bearer credential or an API key: the change is a login-session act |
| 403 | `SHARED_WRITER_REQUIRES_ADMINISTRATOR` | a login session that is neither root nor an administrator |
| 403 | `STEP_UP_REQUIRED` (with `stepUp`) | no live step-up bound to this act and this Account |
| 403 | (route ceiling) | `services:read` missing on the list |
| 404 | `SHARED_WRITER_SOURCE_NOT_FOUND` | no such knowledge source, or none accepts writes |
| 404 | `SHARED_WRITER_ACCOUNT_NOT_FOUND` / `SHARED_WRITER_NOT_LISTED` | the add names no principal / the remove names an Account not on the list |
| 409 | `SHARED_WRITER_ALREADY_LISTED` | the Account is already on the list |
| 422 | `SHARED_WRITER_NOT_AN_ACCOUNT` | a Connector, an Agent, a Group or a service identity |
| 422 | `SHARED_WRITER_ACCOUNT_INACTIVE` | the Account is disabled or terminated |

Every refusal is answered before the step-up is spent.

## Error envelope

New-style errors (validation, webhooks, batch, uncaught-500s) return:

```json
{ "success": false, "error": "…", "code": "VALIDATION_FAILED", "message": "…",
  "suggestion": "what to do about it", "details": [{ "field": "title", "problem": "is required" }] }
```

`error` mirrors `message` for backward compatibility with older `{success,error,code}` consumers. Older routes migrate to `sendApiError` opportunistically — codes are stable either way.

A `403 FORBIDDEN` from the route scope ceiling keeps its code and text. When the cause is that the credential carries neither the route's scope nor `root`, it also carries `details: { "requiredScopes": ["principals:read"] }`: the scope the route requires, never the scopes the credential holds. The field is absent for every other cause (role ceiling, object authority, routes gated on `root`), so its presence means a scope is what is missing.

Two refusals a handler makes itself, after the ceiling has let the request in, carry the same field under the same rule: `403 SCOPE_REQUIRED` from the Blueprint endpoints (`"details": { "requiredScopes": ["blueprints:use"] }`, the scope that check needed) and `403 INSUFFICIENT_SCOPE` from `POST /projects/{id}/brief` without a `taskId` (project awareness needs `projects:read` and `tasks:read`; the field lists the ones the credential lacks). Their status, code and text are unchanged, the field is what the check requires and the credential lacks, never what it holds, and a role-ceiling or unauthenticated refusal from the same check names nothing.

## Validation

`POST`/`PATCH` bodies on the new endpoints are validated field-by-field
(`src/middleware/validate.ts`) — expect `400 VALIDATION_FAILED` with a
`details` array naming each offending field.

### Size limits

Several columns are bounded `varchar`. Exceeding one returns `400`, never a 500:

| Resource | Field | Limit |
|---|---|---:|
| report | `title`, `summary` | 500 |
| report | `author` | 100 |
| task | `title` | 500 |
| task | `model` | 100 |
| project | `name` | 255 |

Reports validate these up front and answer `400 VALIDATION_FAILED` naming the
field. A limit counts characters (code points), as the column does, not UTF-16
units: a 500-character title of emoji is accepted, a 501-character one is not. Any other bounded column is caught by a shared fallback that maps the
Postgres `22001` truncation error to `400 VALUE_TOO_LONG`.

`summary` is optional on `POST /reports`; when omitted the server generates one
from the content and always trims it to fit.

**Request body size:** the API uses the express default of **100 KB** for JSON
bodies. A larger body (e.g. a report with inline base64 images) is rejected by
express before routing, so it surfaces as a generic error rather than the
envelope above — keep report content under ~95 KB or upload media separately.

## Batch updates

`PATCH /tasks/batch` — `{ "ids": [<uuid>…max 100], "updates": { … } }`.
Allowed fields: `status`, `priority`, `project`, `autoStart`, `tags`, `notes`,
`blockedReason`. Per-id results; HTTP 200 if ≥1 succeeded, 422 if all failed.
Lifecycle gates apply per task exactly as in single PATCH.

## Webhooks (outbound)

Subscription CRUD is **owner-plane**: the whole `/webhooks` family resolves to
the `root` sentinel and every mutation is audited. A subscription names an
identity to observe as, so a delegated identity able to create one would have a
choice of whose authority to use (AUTHZ §5.2).

Register: `POST /webhooks`

```json
{
  "events": ["task.updated"],
  "description": "…",
  "active": true,
  "subscriberPrincipalId": "<principal uuid>",
  "subscriberCredentialId": "<credential uuid>",
  "deliveryCursor": "0"
}
```

A subscription carries **no URL and no secret of its own**. The endpoint, the
delivery mode and the signing secret are read from the subscriber Connector's
registry row (`services.delivery_endpoint` / `delivery_mode` /
`delivery_secret`) at dispatch time — one endpoint, one secret, one source of
truth. An active subscription therefore requires both `subscriberPrincipalId`
(a registered Connector principal) and `subscriberCredentialId` (a live
credential belonging to it): deliveries are authorized from that credential's
own scopes, so a subscriber is only ever sent what it could have pulled.
`deliveryCursor` is opt-in replay — omitted, a new subscription starts at the
current feed head; `"0"` replays the whole retained feed.

Events: any feed name that is not a go signal — `task.created`,
`task.updated`, `task.deleted`, `task.archived`, `task.stuck`,
`task.acl_changed`, `phase.created`, `phase.updated`, `phase.deleted`,
`phase.acl_changed`, `project.updated`, `project.acl_changed`, `report.created`, `report.updated`,
`report.deleted`, `report.acl_changed`, `skill.created`, `skill.updated`,
`skill.deleted`, `skill.acl_changed`, `personality.created`,
`personality.updated`, `personality.deleted`, `personality.acl_changed`.
`project.updated` is emitted by the default-Verifier write only
(`PUT /projects/{id}/default-verifier`); no other Project change emits it yet.
Omitting `events` defaults to `task.created`, `task.updated`, `task.deleted`,
`task.archived`. `task.ready` is the only go signal and is **refused** here
(`GO_SIGNAL_NOT_OBSERVABLE`): go signals are delivered per-assignee by the work
plane, from each Connector's own registry descriptor.

Delivery is **identifier-only** — cursor, event name, object type, object id
and occurrence time, never titles, statuses, projects or tags. Authority
travels in the pull: a subscriber learns that something happened and fetches
the object under its own grants to learn what.

```json
{
  "plane": "observation",
  "channelId": "<the subscription id; the Connector's services.id on the work plane>",
  "deliveredAt": "<ISO 8601>",
  "cursor": "<highest cursor in this batch>",
  "events": [
    {
      "cursor": "…",
      "name": "task.updated",
      "objectType": "task",
      "objectId": "…",
      "occurredAt": "<ISO 8601>"
    }
  ]
}
```

Headers: `X-RelayHall-Plane`, `X-RelayHall-Channel-Id`, `X-RelayHall-Cursor`
and `X-RelayHall-Signature: sha256=<hmac-sha256(body)>`. Signing is
**mandatory**, not conditional — a webhook-mode Connector cannot exist without
a delivery secret, so an unsigned delivery is not representable. Verify by
recomputing the HMAC over the raw received bytes, and check that the signed
body's `plane` is the one you expect: the discriminator is inside the signed
bytes precisely so an observation can never be replayed as a go signal.

Delivery is **at-least-once, in cursor order, per channel**, so `cursor` is the
idempotency key. Each pass makes two attempts with a 5s timeout, then backs off
durably (15s, doubling, capped at 1h); `GET /webhooks` shows `last_delivery_*`,
`consecutiveFailures` and `nextAttemptAt`. The webhook is a **hint**; the feed
is the **truth** — recover a dropped delivery with `GET /events?cursor=<cursor>`.
n8n tip: register the n8n instance as a webhook-mode Connector, then subscribe;
its Webhook node plus the signature check covers most automation flows.

## Connector wake (WebSocket)

A Connector can also be woken over the connector event socket instead of a
webhook: it subscribes to `GET /events/ws?wake=1` with its own credential and
acknowledges each identifier-only `wake` frame with a `wake.ack` frame, which
may carry one `rh.ai.telemetry/1.0` envelope. `?wake=2` adds the wake kinds
`verify` (a Verify item opened for the Connector) and `stuck` (a Stuck item
addressed to it) beside `implement`, a `kind` field on every frame, and a
`wake.outcome` frame that reports what the Connector did with a wake it
acknowledged; the board writes each outcome as a `system` stream entry
`connector.trigger` and an audit row `connector.trigger.<outcome>`. The socket stays receive-only
until the board answers with `wake.status` `enabled: true`; any earlier frame
closes it. The protocol, the retry
schedule and the limits are in
[connector-notifications.md](connector-notifications.md#wake).

Every settled wake leaves a **receipt**: an audit row with action
`connector.wake.acknowledged`, `connector.wake.unanswered`,
`connector.wake.offline` or `connector.wake.superseded` on the Task
(`GET /audit?actionPrefix=connector.wake.&resourceType=task&resourceId=<task id>`,
`audit:read`), and a `system` Task stream entry with event type
`connector.wake` carrying the same receipt object (`GET /tasks/{id}/stream`).
Only an acknowledgement records telemetry, and only the envelope the
Connector sent, ingested under the same rules as `POST /telemetry/events`.
The receipt's `reported.model` comes from that envelope alone, and
`modelIdentity` is `provider-reported` only when the envelope names the model
the provider's response returned (`model.resolved`). A Connector that is
offline or does not answer within about 15 seconds gets an `offline` or
`unanswered` receipt with `fallback: "polling"`; the Task is unchanged and
the Connector's `GET /events` polling still finds it.

## Notifications (the history)

No dashboard surface reads these routes any more: since Slice B of the
Notifications and Timeline design the bell, the dashboard's
"Needs your action" card and the Notifications tab read
`GET /notifications/actions`, and the Timeline tab and the dashboard's
Activity widget read `GET /notifications/timeline` (next section). The
history routes stay, unchanged, for any remaining API reader until the
retirement release one release after Slice B. They are served from the
ledgers the board already keeps, with read state per principal
(migration 144). Nothing is stored as a notification. These routes are
internal (see OpenAPI coverage below), and this section is their contract.

`GET /tasks/notifications` (route ceiling `tasks:read`; an identity with no
resolved principal is refused `403 PRINCIPAL_REQUIRED`):

| Query | Meaning |
|---|---|
| `who` | `mine` (default) or `all` ("everything I can see") |
| `type` | one of, or a comma-separated list of: `status`, `stuck`, `review`, `approval`, `skill` (default every type) |
| `unread` | `true` lists only rows this principal has not read |
| `before` | the `cursor` of the last row of the previous page |
| `limit` | 1 to 100, default 50 |

A value outside a grammar is a `400` (`INVALID_NOTIFICATION_FILTER`,
`INVALID_NOTIFICATION_CURSOR`, `INVALID_NOTIFICATION_LIMIT`).

The rows, newest first:

- `status`: a task's status moved (feed `task.updated` with a status
  change). `event: "status_changed"`, `from`, `to`.
- `stuck`: a task was found stuck (feed `task.stuck`). `event: "exception"`,
  `exception { name: "task.stuck", reason }`. This notice is ADDRESSED. Only
  the task's shepherd, else its creator, else its owner, or root, sees it,
  under every filter (strategy section 2.6.4; RH-P3.C8).
- `review`: native verification was requested for a task (feed
  `task.review_requested`). `event: "review_requested"`.
- `approval`: a row of an approval's ledger (`approval_events`).
  `event: "approval"`, `approvalId`, `approvalKind`, `approvalAction`
  (`approval.requested`, `.approved`, `.denied`, `.collected`, `.lapsed`,
  `.revoked`), `approvalStatus` and the acting handle. Login sessions only, and
  only for approvals inside the session's approvals self-scope (the predicate
  `GET /approvals` lists with). A bearer credential never reads these rows.
- `skill`: a skill version moved to `review`, `published`, `retired`, or back
  to `draft` after review (`skill_version_events`). `event: "skill"`,
  `skillId`, `skillName`, `skillVersion`, `from`, `to`. Needs `skills:read`.
  Transitions of an unpublished version also need the manage scopes that
  `GET /skills/{id}/versions` requires.

Every task row is narrowed in the query by the shared task predicate, so a
page is never short, and a task the caller cannot read yields no row and no
title. There is no mention data on the board, so there is no mention row.

**My work** (`who=mine`) keeps a task row when the task's owner, Account
owner, creator, claimant, shepherd or verifier is the caller or an identity
under the caller (its connectors and their agents), or when the task's
effective account owner (its own, else its Project's) is a Group in which the
caller holds a live manager or owner row — Group ownership counts at the edit
tier only (AZ-A12 clause 13), so a plain member of a large Group finds those
rows under `who=all`, not in My work or its unread count. It keeps an approval row
when one of the caller's identities filed the request or the caller acted on
it, and a skill row when one of the caller's identities wrote the version or
acted on it.

Each row carries `id` (its item key: `feed:<cursor>`,
`approval-event:<uuid>` or `skill-event:<uuid>`), `taskId` and `taskTitle`
(`null` when there is no task or it is unreadable), `timestamp`, `read`,
`actorHandle` and `cursor`. The envelope is `{ success, notifications, count,
unreadCount, unreadCountCapped, nextCursor, hasMore, who, types }`.
`unreadCount` counts the unread rows under the same `who` and `type` and is
bounded at 999 (`unreadCountCapped: true` past it).

**What is unread.** A row is read when this principal marked it read, when
this principal's read mark covers it, or when this principal did it. A
request being filed (`approval.requested`, or a skill version submitted for
review) is listed but never unread: while it waits it is counted once, under
"Needs your decision". The first deploy gives every existing principal a read
mark at the feed head and the deploy time, so old history is listed but not
unread. A principal created later reads as unread only what happened after it
was created.

`POST /tasks/notifications/{key}/read` marks one row read for the caller.
A key the caller cannot see is answered `404 NOTIFICATION_NOT_FOUND`,
exactly like an absent or malformed key.

`POST /tasks/notifications/read-all` (the same `who` and `type`, default
`who=mine`) marks rows read for the caller, within those filters:

- with a filter, it writes one read row for each visible unread item under
  it;
- unfiltered (`who=all`, every type), it moves the caller's read mark to the
  current feed head and time, so everything before now reads as read,
  including rows on objects the caller is granted later.

It never writes a row the caller cannot see, and it never changes another
principal's state. Both routes need `tasks:write`.

## Needs your action and the Timeline

Notifications and Timeline, Slice A (the backend). Two reads and two writes
under their own prefix, `/notifications`, with the route ceiling
`tasks:read`. Every other path or method under the prefix falls to `root`.
No MCP tool reads this family. Slice B (the dashboard) moved every
dashboard reader here: the bell's number is `counts.unseen` of
`GET /notifications/actions`, its popover, the
Notifications tab and the dashboard card list those items, and the Timeline
tab and the Activity widget read `GET /notifications/timeline`. The
dashboard shows this family as the **Action Center**,
at `/action-center`, with a left-menu entry under Dashboard; its tabs are
Notifications, Timeline, Approvals, My requests and Agent sessions. The
dashboard paths `/notifications` and `/sessions` are aliases of it (they
keep their query, so every published deep link still opens). The tab marks the last-seen
position with `POST /notifications/timeline/seen` after it reads the first
page of the unfiltered Timeline. The history routes above
(`/tasks/notifications*`) and `GET /dashboard/activity` have no dashboard
reader now and stay unchanged until they retire, one release after Slice B;
`GET /notifications/timeline` replaces `GET /dashboard/activity`.

**`GET /notifications/actions`: "Needs your action".** These are the open
items that wait on the caller. Each one is derived from current board state
when it is read. An item leaves when its condition ends. There is no dismiss
and no snooze. The one stored state is the caller's own seen mark (below): a
seen item stays listed, shown as seen.

| Kind | Open while | Reaches |
|---|---|---|
| `decision` | a pending approvals-hub item this session may decide (`decidable`), except skill reviews and native reviews | login sessions only |
| `verify` | a Task in Review whose Verifier is the caller or an identity under it; or an active native review that names one of them; or a Task in Review with no usable Verifier, which goes to the Task's account owner. There is one item per Task, and its `reasons` say why. | every caller |
| `stuck` | the Task's status is `stuck`; or it is in progress and the stuck sweep announced an episode that is still open on the sweep's own activity clock (new linked-Report activity ends the episode). It goes to the shepherd, else the creator, else the Assignee. | every caller |
| `skill` | a Skill version waits for review, and this human `skills:admin` session may publish it and did not write it | login sessions only |

The answer is `{ success, items, counts { decision, verify, stuck, skill,
total, unseen }, capped }`. Items are grouped by kind, oldest first within a
kind. Each item is `{ key, kind, seen, reasons, since, object { type, id,
title }, project { id, name } | null, href, detail }`. Each kind is capped at
200 items, with a `capped` flag. The list is not paged. `seen` is true while
the caller's own seen mark names this occurrence of the item (its `since`);
`counts.unseen` counts the items that are not seen, and the bell counts
`counts.unseen`. Every Task item is narrowed by the shared task predicate in
the query.

**`POST /notifications/actions/seen` `{ keys }` or `{ all: true }`** marks
the caller's own items seen: the named keys, or every
item the caller's list holds now ("Mark all seen"). The list is read first
through the same predicates as the GET, and only keys on it are marked. Any
other key (another principal's item, an object the caller cannot read, a
resolved item, a key that never existed) is ignored alike: nothing is stored
for it, and the answer says nothing about it. A mark records the item's
`since`, so a new occurrence of the same key (the Task went back to Review, a
new stuck episode) is unseen again. A seen item is never dismissed; it stays
listed until it is resolved. A mark is per caller (one administrator's mark
leaves the item unseen for another) and, like the Timeline's read marks, is
a row of the caller's own with the time it was written. Session and bearer
alike, at `tasks:read`. The answer is the list as it now reads, with
`marked`: how many of the caller's own items this call marked. A body
outside that grammar is a `400` (`INVALID_ACTIONS_SEEN`).

**`GET /notifications/actions/owner`: the Action Center queue for agents, read
only.** For a person's own Connector, or an Agent under it (a live delegation
chain that ends at an active human Account), the answer lists the items waiting
on the owning Account as well as the caller's own. The Account's items are its
own login-session list, compiled by the same code as
`GET /notifications/actions` (the same predicates, the same caps, that Account's
seen marks), not a copy of it; the caller's own items are what its plain list
holds. An item on both lists is listed once. Any other caller (an Account
itself, a session, a legacy key, a Connector of a service Account) is answered
with exactly its own list. The answer is
`{ success, scope (owning-account | own), items, counts, capped, asOf }`. Each
item is the list's item plus `readable`, `waitingOn` (`account`, `caller` or
`both`) and `waitedSeconds`. It never widens what the caller can read: an item's
`title`, its Project name, `reasons` and `detail` appear only where the caller's
own read scope reaches the object the item points at (the Task, or for a Skill
review the Skill), the decision a point read makes; every other item is `kind`,
the id in `object.id`, `since`, `waitedSeconds` and `href`, with `title` null
and `readable` false. A Decision is readable where its Task is, and then its
title is that Task's title and nothing more: its `reasons` (the approval's kind)
and `detail` (the requester) are kept only for a caller that passes the approval
point read, `GET /approvals/{id}`, which is a login-session act, so a bearer
credential (a Connector or an Agent) always gets `reasons: []` and `detail: {}`
for a Decision. `seen` is the owning Account's own mark for an item on its list
(`waitingOn` `account` or `both`) and the caller's own mark for an item only the
caller holds (`waitingOn` `caller`): the person's mark does not exist for an
item that is not on the person's list. The merged list is capped at 200 per
kind, oldest first, with the `capped` flags. Route ceiling `tasks:read`. Nothing
is marked seen and nothing is decided: the route has no write method, and acting
on an item stays on the board (with step-up where the act needs it). The MCP
tool `relayhall_action_items_list` and `relayhall actions` read it.

**`GET /notifications/timeline`: every change you can see, newest first.**

| Query | Meaning |
|---|---|
| `type` | one type, or a comma-separated list: `task` (created or archived), `status` (status moved), `update` (other Task changes), `stuck`, `review` (review requested), `report`, `phase`, `project`, `skill`, `skill-version` (published, returned, retired), `approval`, `access`. The default is every type except `access`. |
| `acl` | `true` adds access changes (they are hidden by default) |
| `project`, `phase` | a Project id. A Phase id matches the Phase itself and the Tasks currently in it. Skill-version rows carry no project, so either filter leaves them out. |
| `person` | the acting principal. Rows the board wrote itself never match. An approval row matches only when its actor is shown to you. |
| `since`, `until` | ISO dates or times, applied to each row's own time |
| `scope` | `all` (the default: everything you can see) or `mine` (My work, the history's rule) |
| `q` | a text search: rows whose object title or own label holds the text, in any case. `%`, `_` and `\` are matched as themselves. Trimmed; at most 100 characters. |
| `before`, `limit` | the previous page's `nextCursor` (opaque), and 1 to 100 rows (default 50) |

A value outside a grammar is a `400` (`INVALID_TIMELINE_FILTER`,
`INVALID_TIMELINE_CURSOR`, `INVALID_TIMELINE_LIMIT`). Each read runs in one
read-only transaction, and each statement in it has a five-second ceiling: a
read that reaches it is a `503` (`TIMELINE_READ_TIMEOUT`, with an `errorId`),
and the same request can be retried or narrowed. The answer is
`{ success, items, nextCursor, hasMore, headCursor { feed, approvals, skills },
lastSeen }`. Each item is `{ key, at, kind, label, object { type, id, title },
project { id, name } | null, actor { handle }, detail }`.
`detail.fields` names the Task fields a change touched. It never carries a
value. `detail.stream` names the type of a stream entry. A Report row says
whether the Report carries a handover. A project's name is shown only to a
caller who can read that Project.

The rows come from the board's feed. The feed shows a whitelist of names: it
never shows `task.ready` or a deletion. Two more sources are added: approval
ledger rows, for login sessions within the approvals self-scope (a requester
never learns who decided), and Skill version decisions. Every source is
narrowed in the query by its own read scope and the shared predicate, so a
page is never short. A Report row also follows the Report list's three rules:
no soft-deleted Report, no promoted Report whose source Task you cannot read,
and no `assigned-only` outpost Report unless you are on its assignment. A
Skill's draft rows follow the registry's draft rule. The feed pages by its
commit-ordered cursor. Approval and Skill-version rows page by time windows
that the token carries. A page holds at most `limit` rows of each of these two
sources; when a window holds more, the next page continues below the last one
shown. So no row repeats or goes missing across pages, and a row that arrives
after you started paging shows up when you refresh. A `since`/`until` window
is read through the date index and bounded by the first and last feed row
inside it.
`headCursor` names the newest visible row of each source under the same
filters, so a client can say how many rows are new.

The text search `q` is part of the same query, before the limit, so a
searched page is never short. It only narrows: every row is still admitted by
its own source's read scope, so a title matches only on an object you may
already read. An approval row's only title is its Task's, and it matches only
when you can read that Task, exactly as the title is shown. Each object table
is read once for the search, never once per feed row.

**`POST /notifications/timeline/seen` `{ cursor }`** records the caller's own
last-seen feed cursor, for "new since your last visit". The cursor is clamped
to the newest feed row the caller may see (never the board-wide head, so the
echoed value discloses nothing the caller cannot read) and never moves
backwards. Only this route writes it; a GET never does.

**What the feed now says.** A `task.updated` row carries `fields`: the sorted
names of the fields the change set, and never their values. A public, authored
stream entry is announced by one `task.updated` row with `stream { entryType }`,
unless it is `assigned-only` or refers to an entry that is. `finish` adds
`stream` to its status move instead of writing a second row. Report, Phase,
Skill and Task writes record the acting principal where the writer has one.

## Skill ownership

Every Skill carries an owner (`owner_principal_id`, with `owner_kind` `human`
or `group` and `owner_display_name` joined by the server), or none
(`null`, an unowned Skill). Migration 162 adds the column (AZ-A12 M-c) and
makes the first assignment by an explicit list of Skill ids; a new Skill is
owned by the creating chain's person Account.

**What a list and a read show.** A published Version is shared registry
content: every `skills:read` caller sees it, as before. An unpublished Version
(draft or review) is the owner's working copy. A registry manager
(`skills:write`, `skills:admin` or `root`) sees it only when the Skill is
unowned, owned by the caller's Account (a Connector or Agent acts for its
Account), or owned by a Group that Account is an active member of. A registry
administrator (`root` or `skills:admin`) also sees, on `GET /skills`, every
Skill whose newest Version is waiting in review, and on a read by id
(`GET /skills/{id}`, `/versions`, `/versions/{version}`, `/content`) any
Skill's drafts. Anyone else sees the published Version of such a Skill, and a
Skill with no published Version is neither listed nor found (`404`).

- `GET /skills?owner=all`: every owner's drafts, for `root` or `skills:admin`
  only (`403 SKILLS_ADMIN_REQUIRED` otherwise; any other value is
  `400 INVALID_QUERY_VALUE`).
- The session brief's granted skill index lists the caller's own unpublished
  Skills under `yourDrafts` (owned by its Account or one of its Groups; only for
  a registry manager), beside the published index, which is unchanged.

**Assigning an owner.** `PUT /skills/{id}/owner` with `If-Match: <revision>`
and `{ ownerPrincipalId, reason, stepUpToken? }`. The route ceiling is
`skills:admin` and the Skill's point check asks `admin`, which an administrator
holds (and the person owner, through the owner rule). The target is an active,
parentless, non-legacy human Account (`422 INVALID_SKILL_OWNER` otherwise). A
move into, out of or between Groups is the AZ-A12 clause 9(e) act: a login
session (`GROUP_OWNER_SESSION_ONLY`), root or an administrator
(`GROUP_OWNER_REQUIRES_ADMINISTRATOR`) and a step-up bound to
`(ownership.transfer, skill id)` (`STEP_UP_REQUIRED` with the `stepUp`
challenge). The answer is `{ success, changed, skill }`; assigning the current
owner answers `changed: false` and writes nothing. The revision rotates on a
change. MCP has no owner mutation.

**What ownership gives.** The Skill's owner rule: a person owner may act on the
Skill (read, version, submit for review, return to draft) within their
credential's scopes and role, and a Group owner's members read and use it and
its live owners and managers edit it. Publication is unchanged: it stays
`skills:admin`, human-only, and independent of the Version's creator
(`INDEPENDENT_REVIEW_REQUIRED`), whoever owns the Skill.

## OpenAPI coverage

`/openapi.json` documents the endpoints agents and integrations actually use:
tasks, batch, subtasks, the task stream and references; Brief compile at all
four altitudes; projects, phases, project resources and Charters; reports;
skills; services and capability descriptors; principals, credentials, grants,
groups, warrants, delegation and approvals; access profiles; audit;
notification endpoints; telemetry ingest; models; subscriptions; and health.
Routes not listed there are internal/unstable — read the source before relying
on them. The cursor event feed (`GET /events`) is one of those: it is not in
the spec, and `backend/src/routes/events.ts` is its contract. The notification
history routes (`/tasks/notifications`) are another; their section above is
theirs. "Needs your action" and the Timeline (`/notifications/*`) are in the
spec.


#### Due-date control receipts

`npm run test:task-write-fields` in `backend/` exercises the production router
against a disposable PostgreSQL, including random wall times and zones,
fixed gap/fold and historical-offset cases, endpoint years, and exact column
and point-route read-back. `npm run test:unit:tz` in `frontend/` verifies the
wall-time payload and unchanged-instant behavior under Europe/Warsaw.

From the repository root, `python3 scripts/feata-mutation-drill.py` runs green
baselines followed by individual red mutations, restoring source bytes after
each one. It requires the same disposable database environment and both npm
dependency installations. `--suite backend` and `--suite frontend` split the
work across CI jobs. Logs and JSON assertion receipts default to the ignored
`tmp/feata-red-proofs/` directory; `RELAYHALL_FEATA_DRILL_OUT` overrides it.
The ICU property oracle samples offsets independently; it is not an exhaustive
proof of all past or future timezone databases. PostgreSQL’s native policy
performs production resolution without a sampled candidate search.


MCP `relayhall_task_create` and `relayhall_task_update` share one deadline
schema: string, exactly `{local: string, zone: string}`, or null. The schema
describes the structural alternatives; REST validates actual calendar values,
zones and precision. For a successful zoned write, both tools append a JSON
section containing the complete server `dueAtResolution` object (local wall
clock, zone, microsecond instant, offset including historical seconds,
offsetSeconds and `chosen: "postgresql"`). PostgreSQL uses the post-transition
offset for backward clock changes. ISO/null/omitted writes do not invent a
resolution receipt. The existing success message and update warning remain.

`mcpTaskDueAtContract.test.ts` measures the registered handlers against server
envelopes and validates both advertised shapes with a JSON Schema validator.
The real PostgreSQL Task write suite additionally invokes both MCP handlers
with an ordinary MCP-pinned Connector credential, compares the returned
receipt with independent point reads, and checks gap refusal and ISO writes.
`python3 scripts/feata-mcp-mutations.py` runs seven copied-source controls for
receipt omission, malformed object admission and contradictory fold wording;
it requires no database and restores each copy before the green rerun. CI
runs it explicitly. Receipts default to ignored `tmp/feata-mcp-red-proofs/`;
`RELAYHALL_FEATA_MCP_DRILL_OUT` can select another evidence directory.


## Listing Blueprints

`GET /blueprints` takes no query parameters (an unexpected one is refused with `BLUEPRINT_INPUT_INVALID`, 422) and answers `{success:true, blueprints:[...]}`: every Blueprint the caller can see, sorted by key and unpaged, like `GET /projects`, `GET /skills`, `GET /phases`, `GET /personalities` and `GET /services`. A use-only caller sees published content only. The CLI `blueprint list` prints this body unchanged.

The MCP tool `relayhall_blueprint_list` pages this list the way every MCP list pages a list the board returns whole: `limit` (default 20, cap 50) and `offset` select rows of it, and the detailed answer is this envelope with `blueprints` cut to that page, in this order, plus an MCP-only `pagination` object (`limit`, `offset`, `total`, `returned`, `hasMore`; `total` counts the rows above). The MCP page is additive: it carries REST rows and nothing else. Paging REST itself was considered and not adopted, because the REST metadata lists above are unpaged and only the Task and Report lists are paged by the board (see [Task Report context](#task-report-context)); a Blueprint REST page would need a dashboard pager and a CLI flag for no caller that needs one today. The real-PostgreSQL live contract `npm run test:blueprints` (case D-15/D-20) holds both halves of this.

## Blueprint capture and workflow setup

`POST /blueprints/capture` accepts `{phaseId, projectId?, name?, key?}` with full UUIDs. It requires `blueprints:write` and caller-filtered Project/Phase/Task reads, without requiring Project write. HTTP 201 returns `{success:true, blueprint:{id,key,version:1,status:"draft",contentSha256,identitySha256}}`. Hidden work returns a concealed 404; nonportable content returns a typed 422 without a partial draft. The Blueprint route family avoids classifying capture as a Project write.

Submitting an empty plan returns `BLUEPRINT_EMPTY_PLAN` (422, field `tasks`). Independent publication review remains mandatory.

Preview names unavailable references through `requiredAccess`, `reason` and `plan.refusals` (`BLUEPRINT_REFERENCE_ACCESS_REQUIRED`). Captured documents with `target.allowExisting:true` also admit an existing-Project target.

`POST /instantiations/:id/setup/preview` accepts either `{warrantId}` or `{createWarrant:{holderPrincipalId,ceilingProfileId,expiresAt}}`. New-Warrant setup is human-session-only. Its preview shows the Warrant, exact profile assignments, Task revisions and confirmation hash. Apply via `POST /instantiations/:id/setup` with the confirmed input, `tasks`, `confirmationHash`, and a step-up token bound to `warrant.create` and the holder. Retain the Idempotency-Key for retries. The step-up token is excluded from the idempotency digest and never stored in the receipt. Existing-Warrant request hashes remain compatible.

See [Blueprint authoring and use](blueprints/README.md) for CLI/UI instructions and portability restrictions. MCP has no Blueprint authoring plane.

## Task Report context

A Task's Reports are read as **bounded summaries, never bodies**. One
contract serves three routes.

`GET /tasks/{id}/reports` accepts these query parameters:

- `scope`: `linked` (default) or `progress`. `linked` covers every Report
  associated with the Task, through the Report's `task_ids` or a Task
  Reference of kind `report`. `progress` covers only server-bound task
  progress Reports.
- `limit`: 1–50, default 5.
- `cursor` (a previous `pagination.nextCursor`) or `offset`, not both.
- `pinned=true` lists only pinned Reports.

It answers:

```json
{
  "success": true,
  "taskId": "…",
  "scope": "linked",
  "pinnedOnly": false,
  "reports": [{"id": "…", "title": "…", "status": "active", "relevance": "linked",
               "pinned": false, "origin": "api", "createdAt": "…", "updatedAt": "…",
               "summary": "…", "authorPrincipalId": "…", "hasStructuredHandover": false,
               "contentHash": null}],
  "pinned": {"reports": [], "total": 0, "returned": 0, "hasMore": false},
  "pagination": {"limit": 5, "offset": 0, "total": 60, "returned": 5, "hasMore": true,
                 "nextCursor": "rc1.…"},
  "retrieval": "55 more authorized Report summaries: …"
}
```

- `reports` holds the newest-created Reports first, with ties broken by id.
- `pinned.reports` holds at most three pinned Reports that are not already in
  `reports`.
- `contentHash` is the sha256 of the body for this Task's own task-bound
  progress Reports, the `expectedContentHash` an edit needs. It is `null` for
  every other Report. It is a hash, never the body.
- `pagination.total` counts only Reports the caller may read: the shared READ
  predicate plus the two promotion narrowings that `GET /reports/{id}` applies.
- `retrieval` is one line naming the next-page call for MCP, REST and CLI, and
  `GET /reports/{id}` for bodies. When one of this Task's progress Reports is
  in view (`scope=progress`, or a listed summary carries a `contentHash`), it
  also names `GET /tasks/{id}/reports/{reportId}`.
- The cursor is a keyset position (creation instant in microseconds, plus id),
  so Reports created later never shift a later page.

A malformed request answers `400` with `INVALID_REPORT_CURSOR`,
`INVALID_REPORT_PAGE` or `INVALID_REPORT_SCOPE`, and names the field in
`details.field`.

`GET /tasks/{id}` adds `task.reportContext`: the default page of the same
envelope, without `success`.

`GET /tasks/{id}/reports/{reportId}` returns one of this Task's task-bound
progress Reports in full, as `{success, taskId, report}`. `report` is the row
the save answers with, so it includes `content` and `content_hash`. The current
claimant continues its progress Report from it: an edit sends `content_hash` as
`expectedContentHash`. Like the full-row list before it, the route needs Task
read authority (`tasks:read`), not `reports:read`. It serves only
progress Reports of this Task that the caller may read, through the same READ
predicate and promotion narrowings the context counts with. Any other id
answers `404 TASK_REPORT_NOT_FOUND`, and a malformed one answers
`400 INVALID_REPORT_ID`. Any other Report's body comes from `GET /reports/{id}`,
which needs `reports:read`.

`POST /tasks/{id}/brief` (and `POST /principals/me/brief` for a bound Task)
renders the same default page as quoted JSON: `total`, `returned`, `hasMore`,
`nextCursor`, `recent` and `pinned`, plus the `retrieval` line. Two bounds
hold however many Reports the Task has:

- the section holds at most eight summaries;
- `inlineReports: true` inlines bodies only for the Reports listed there,
  within `tokenBudget`.

A Report the caller cannot read is neither listed nor counted. The former
`unreadableByYourGrants` id list is removed.

Compatibility: `GET /tasks/{id}/reports` used to return full progress-Report
rows, bodies included, unpaged. Callers that need the old set pass
`scope=progress`. Each summary there carries `contentHash`, and
`GET /tasks/{id}/reports/{reportId}` returns the full row under the same
`tasks:read` the old list needed. The dashboard's progress-report editor does
exactly that. The CLI keeps `relayhall task-reports ID` and adds `--scope`,
`--limit`, `--cursor`, `--pinned`, `--all` and `--report`. `--all` follows
`nextCursor` through every page. `--report REPORT_ID` reads one progress Report
in full.

## Task Report maintenance display contract

`GET /tasks/{id}` includes optional `task.reportMaintenanceAccess` with
`{allowed: boolean, reason: string | null}`. This read-only, caller-scoped
projection shares the current locked Report-save policy, not `lifecycleAccess.arm`:
current independent claimant, in-progress Task, live identity/delegation,
credential/session validity, trusted and fresh Task WRITE authority and explicit
delegated Task action caps. Service INVOKE does not imply Task claimant authority.
A missing decision or failed lookup must close maintenance controls. Typical
denials are `TASK_CLAIMANT_REQUIRED`, `TASK_REPORT_FROZEN`,
`TASK_REPORT_AUTHORITY_REVOKED` and `TASK_REPORT_ACCESS_UNAVAILABLE`.
The projection is not persisted, a grant, or an authorization token. Every save
continues to check current policy under the Task lock; Report source, author and
content-hash predicates remain mandatory. REST save/reconcile, CLI and MCP input,
retry and reconciliation contracts are unchanged.

The projection reads the Task under the same row lock a save takes, and waits
for that lock at most 2 s (a statement-level `lock_timeout`). If
another transaction holds the Task longer, `GET /tasks/{id}` answers
`409 TASK_READ_BUSY` with `Retry-After: 1` and `details.lockTimeoutMs: 2000`.
Nothing was read or changed; retry the read. A holder that finishes inside the
bound is waited for, and the read answers 200 as before. MCP `relayhall_task_get`
composes this route, so it carries the same bound and the same code.

A same-key replay of `POST /tasks/{id}/reports` is refused, never replayed:
`409 IDEMPOTENCY_REPLAY_UNAVAILABLE`, still one Report row and no second 201.
The message names the exact recovery route,
`GET /tasks/{id}/report-operations/{key}?requestHash=...`, filled in with this
save's Task, key and logical request hash, and `details.recovery` carries the
same `{method, path, requestHash, mcpTool: "relayhall_task_report_reconcile"}`.
Agent minting keeps its own refusal text.

The dashboard keeps draft evidence and exact pending operations scoped to the
actual authenticated actor plus Task, across eligibility refreshes. A query-only
Report switch selects the exact owned active Report only when clean; dirty or
pending drafts refuse the switch and restore the current canonical URL. Refusal
does not discard evidence or replace a pending operation key/body/hash.

Retired writer-less Task runtime fields are absent from Task responses and the
column contract (see CHANGELOG). New Verifier receipts source their session
evidence from canonical implementation-attempt records and Task links, never
Task JSON or reported stream text. Historical review receipts remain immutable.
