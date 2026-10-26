# Grants

A **grant** is object-level authority: it says a grantee may perform a
**verb** on a **resource**. Grants complement credential scopes — scopes say
*what kind of thing* a credential may do board-wide; a grant narrows or
widens that to *specific objects*.

```
(grantee, resource_type, resource_id | *, verb, expires?)
```

- **grantee** — a **principal** or a **Group** (`grantee_type`). A group
  grant reaches its member Accounts by a membership join **at query time**
  — nothing is materialized per member, so membership changes apply on the
  very next request, and a member whose Account is not `active` gets
  nothing from its groups. Deleting a group deletes its grant rows in the
  same transaction. (Groups arrived with AZ-S1; see
  [groups](api.md).) A Group is also a principal of kind `group` (AZ-A12),
  but `grantee_type = 'group'` is its **one** representation as a grantee:
  `POST /grants` with `granteeType: 'principal'` and a Group's id is refused
  `422 GROUP_PRINCIPAL_NOT_A_GRANTEE`, and so is a principal profile
  assignment naming one.
- **resource_type** — one of `task`, `phase`, `project`, `report`, `skill`,
  `personality`, `service`, `plugin`. (`phase` and `plugin` are accepted by
  the schema ahead of their objects landing.)
- **resource_id** — a specific object's UUID, or **omitted/null** for the
  type-wide **wildcard** (every object of that type).
- **verb** — one of `read`, `write`, `use`, `invoke`, `admin` (the five
  ratified authority verbs).
- **expires** — an optional future timestamp; an expired grant stops
  applying.

## Behaviour

- **Created rows name their identities.** `POST /grants` returns the same
  resolved `grantee` and `grantedBy` summaries as a `GET /grants` row. The
  Access grants page names the appended row immediately, without a refresh.
  A genuinely missing principal, or an absent granter, resolves to `null`.
- **Revocation is deletion.** A grant is live authority configuration, not
  history; removing it deletes the row. There is no "revoked" state to
  resurrect — which is deliberate, because a revoked-but-present row is
  exactly the kind of thing an accidental re-create can silently lift.
- **Duplicates are refused.** The same `(grantee, resource, verb)` — with
  the wildcard counting as one specific target — cannot be granted twice
  (`409 GRANT_EXISTS`).
- **Assignment rows expire (AZ-A10 clauses 1–14).** Execution, Verifier and
  Shepherd assignment grants land on the role holder's principal. An Agent's
  stored bound-task role chooses its rows and those rows follow the credential
  expiry; a role grant on an Account is not inherited by sibling Connectors.
  The read grants an execution assignment writes carry `provenance`, and expire
  three months after the assignment unless the assigning act sets
  `roleGrantExpiresAt`: any earlier or later future date, set by whoever
  performs the act, or `'unlimited'`. A row several assigned Tasks share is
  dated at the latest of their dates (none, if one of them is unlimited) and is
  recomputed when a Task lets go of it. An owner-made row an assignment links is
  never re-dated, and every row is still removed at the Task's terminal state.
  An Account-landed row from before AZ-A10 that the upgrade could not replace
  (an administrator holder, or an assigner it could not attribute) is still
  revoked when its Task stops referencing the object; nothing is added to it.
  See the [API usage notes](api.md#assignment-grant-expiry-az-a10-clause-6).
- **Inherited Verifiers write the same rows.** A Verifier a
  new Task inherits from its Phase's or Project's default is assigned through
  the same role writer, in the creating transaction, capped by the creator as
  assigner; its rows are dated and reaped exactly like an assigned Verifier's.
  See [Authorization](authorization.md#default-verifier).
- **Grants are enforced** by the shared authorization predicate (RH-P2.5)
  on every identity path: point decisions and list narrowing compose the
  same SQL seam, so a grant — principal- or group-addressed — applies
  identically to both.
- **Creation writes a grant only when it adds access.** Creating a Task, a
  Report or a Project used to write the creator (and, for a Connector or Agent
  creator, its human sponsor) a read and a write grant on the new object. Each
  of those rows is now written only when the authorization engine says it
  changes somebody's access: in the creating transaction, the engine is asked
  every question the row could influence (the grantee, and the widest identity
  that could ever sit below it, on every action the verb confers) before and
  after the row, and an unchanged answer rolls the row back. The questions
  include what the row lets its holder **delegate**: a non-root warrant
  creator's ceiling, an assigner's cap (R3) and the Agent mint ceiling are
  checked against the holder's own grants and profile rules, not against the
  engine's owner arm or a Connector's own() cap, so a row that is its holder's
  only source for that object stays written. In this build no row is written for
  an administrator whose role derives `root` (`admin`, `orchestrator`), or for a
  holder whose type-wide grant or profile rule already contains it; the
  owning Account, an author, an operator and a Connector keep their rows, as
  the sources those three checks read. The policy's audit row
  (`task.creator_access` and the others) is still written, with
  `grantId: null` and `alreadyHeld: true` when no row was needed.
  Assignment grants, approved requests and grants made on the Access page
  are unchanged.

## Cleaning up grants that change nobody's access

`POST /grants/bulk-revoke` revokes, in one audited batch, the grants that
change nobody's access. It is a **signed-in board act**: the `root` ceiling of
every `/grants` route, and session-only, so every bearer (a root Connector
included) and every MCP call is refused `SESSION_ONLY`; there is no MCP tool
for it. On the Access page it is **Clean up redundant grants**, beside the
list's paging.

- **Body.** `{ ids, dryRun, stepUpToken }`: at most **500** grant ids
  (`400 BULK_REVOKE_TOO_MANY` above that; a repeated or malformed id is
  refused by name), `dryRun` defaults to `true`, and `stepUpToken` is
  required when `dryRun` is `false`.
- **The check is the authorization engine's own.** For each id the engine
  answers, with and without that grant, every question it could influence:
  the grantee and the widest identity that could ever sit below it, every
  action the verb confers, on the granted object (every object of the type
  for a wildcard) and, for a Project or Phase grant, its Tasks; and whether
  the grant is its holder's only source for delegating that object (the
  warrant, assignment and mint ceilings above). The verdict
  per id is `redundant` (nothing changes), `effective`, `unevaluable` (a
  Group grantee, `plugin` and `surface` grants, anything the engine cannot
  evaluate), `assignment` (an assignment-carried row: never removed here),
  `missing` or `expired`.
- **A dry run writes nothing.** It answers the verdicts, the counts in
  `skipped`, and a simulated read-back (`readBack`, `wouldRollBack`), so the
  real run's outcome is known first. Every answer carries `idSetHash` and
  `redundantIdSetHash`.
- **A real run** needs a single-use step-up bound to
  `('grant.bulk_revoke', idSetHash)`: the sha256 of the lower-cased ids,
  sorted and joined by commas, prefixed `grant-ids-v1:`. A missing, spent or
  differently bound token is refused `STEP_UP_REQUIRED` and audited. The run
  is ONE transaction that holds the grants table against other writers:
  every id is re-checked live, only the ids still `redundant` are removed,
  each through the ordinary revoke path (its own `grant.revoke` audit row and
  `acl_changed` event), then every question the removed grants could
  influence is asked again, and **any** difference rolls the whole batch
  back (`rolledBack: true`). One `grant.bulk_revoke` summary audit row is
  written per real call (the counts, the id-set hash and the actor, rolled
  back or not), and the step-up is spent either way. Nothing is retried
  automatically; a busy table answers `409 GRANTS_BUSY` with nothing
  revoked.
- **One call is one request** for the rate limit.

The Access page reads the ids the current filter shows one list page at a
time, dry-runs them at most 500 per call, shows the counts by verdict and a
sample, and then runs each batch of redundant grants after its own step-up,
showing what each batch removed, kept or rolled back.

## Listing grants: pages, filters and where a grant came from

Settings → Access grants (`/settings/access`) reads the list **one page at a
time**. It opens on **hand-made
grants only**; system-made rows and rows of unknown origin are one filter away
(**Origin**), and the page says how many the current view hides. Filters:
Origin, resource type, permission, expiry (none, not expired, expired, expiring
within 14 days), resource state (live, archived, not found, every resource of a
type), a search over the identity, the granter, the resource title and the ids,
and a sort. **Load more grants** reads the next page. Each row has **Edit** and
**Revoke** as one pair of equal controls.

`GET /grants` takes every one of these as an **additive** query parameter:

| Parameter | Values |
|---|---|
| `limit` | 1–200 (default 50 once paging is asked for) |
| `cursor` | a previous `pagination.nextCursor`, with the same `sort` |
| `sort` | `-created` (default for a page), `created`, `grantee`, `-grantee`, `resource`, `-resource`, `verb`, `-verb`, `expires`, `-expires` |
| `made` | `hand`, `system`, `unknown`, `all` (default) |
| `granteeId`, `resourceType`, `verb` | exact match |
| `expiry` | `any` (default), `none`, `live`, `expired`, `expiring` (a live expiry within 14 days) |
| `target` | `any` (default), `live`, `archived`, `missing`, `wildcard` |
| `q` | case-insensitive search, at most 200 characters; `%` and `_` match literally |

Without `limit` and `cursor` the answer is unchanged in shape: every matching
grant, in creation order. With either, the answer adds `pagination`
(`limit`, `sort`, `returned`, `total`, `hasMore`, `nextCursor`) and, on the
first page, `madeCounts` (`hand`, `system`, `unknown` under every filter except
`made`). Paging is a **keyset** over the sort key and the grant id, so a row
present for the whole walk is returned exactly once, even while other rows are
created or revoked between pages; a row whose sort key is edited mid-walk can
move. A cursor is bound to its sort: reusing it with another sort is refused
`400 INVALID_QUERY_VALUE`, as is every malformed value.

A cursor carries the last row's sort key. Text sort keys (`grantee`,
`resource`, `verb`) are cut to their first 512 characters inside the
statement, because a Phase or Group name has no length limit; rows whose keys
agree that far are ordered by grant id, so the walk still returns each row
once. Every cursor the list issues is therefore accepted back, whatever the
titles hold (500-character Task and Report titles, any script). A cursor the
list could not have issued (longer than the largest it can issue, a key past
its sort's bound, or a key that is not a timestamp under a timestamp sort) is
refused `400 INVALID_QUERY_VALUE` with `details.field` = `cursor`.

Every filter is part of the one SQL statement, before its `LIMIT`. The read
keeps its `root` route ceiling, unchanged: an Account or a credential without
`root` is refused, paged or not, exactly as before.

### Where a grant came from (`madeBy`)

Each listed row carries `madeBy` = `{ class, via, evidence }`, derived **only**
from data the board already keeps, in this order:

1. **The grants row's own columns** (`evidence: column`):
   `provenance` `assignment:grant` or `assignment:warrant` is **system-made**
   (`via: assignment` or `warrant`: an execution, Verifier or Shepherd
   assignment's access); `origin` `creation-default` is **system-made**
   (`via: project-default`, a Project's creation default for its home Group);
   `origin` `steward` is system-made (`via: steward`, dormant).
2. **The creation policy's audit row** (`evidence: audit`): the Task, Report
   and Project creation policies write `task.creator_access`,
   `task.sponsor_access`, `report.creator_access`, `report.sponsor_access` or
   `project.creator_access` **in the same transaction** as the grant, naming it
   by `metadata.grantId`. Such a row makes the grant **system-made**, with
   `via` the policy (`task-creator`, `task-sponsor`, `report-creator`,
   `report-sponsor`, `project-creator`).
3. **An approval** (`evidence: column`): a row with `approval_id` was written
   when a person approved an access request or a change request: **hand-made**,
   `via: approval`.
4. **The grant's own `grant.create` audit row** (`evidence: audit`): with
   `metadata.automatic: true` it is **system-made** (`via: automatic`);
   otherwise, with no marker above, it is **hand-made** (`via: direct`: the
   Access page, the CLI or the REST API).
5. **Nothing** (`evidence: none`): no marker and no `grant.create` row, which
   is a row older than the audit ledger or one a migration seeded. It is
   **unknown**, never guessed into either class.

The writer is the row's `grantedBy` (the identity whose act wrote it, for
example the Connector that created the Task); the page shows it beside the
origin. The classification is presentation only: it grants and withholds
nothing. A row also carries `target` (`label`: the title or name of a Task,
Report, Project or Phase; `status`; `state`: `live`, `archived`, `missing`,
`wildcard`, or `unchecked` for the other types) and, for a Group grantee,
`granteeGroup` (`id`, `name`).

## Authority

**Grant mutation is owner-plane.** Creating, widening and revoking grants
sit behind the `root` sentinel — grant management stays out of the agent
plane, because a prompt-injected agent that could grant itself authority
would defeat the whole model. A principal may **introspect its own** grants
with `principals:read`; reading another principal's grants requires the
management gate (the same split as credentials).

Internal server-side writers that are not request principals — the
credential-less `system` principal and the synthetic task-Verifier actor —
are outside the grants domain; grants address principals.

## A Group's grants, as its stewards see them (SR-2)

`GET /groups/{id}/grants` lists the grants whose grantee is that Group. A root
login session sees the full rows. A **live owner or manager** of the Group
(LENSES-c c1-A), on a login session, sees the same rows **without
`grantedByPrincipalId`**. Everyone else — a bearer, a non-steward, an inert
steward, a steward of another Group — receives `200` and an empty list. It is a
read: stewards **write no grants** in this build. The `origin = 'steward'` value
of a grant row stays **dormant**, with no writer; the steward grant act waits
for its own ratification (LENSES-c c2).

## Grant and credential requests (AZ-A9)

The agent plane cannot mutate grants, but it can **ask** for them (AUTHZ
amendment AZ-A9, ratified 2026-10-10). An Agent or Connector files a **grant
request** with `relayhall_access_request` or `POST /delegation/access-requests`;
root or an administrator decides it on the board after step-up and may only
narrow it. Approval writes ordinary principal grant rows on the requester's
chain-root Account, with three marks of where they came from:

In Access manager → Pending approvals and the Approvals hub, the decider sees
the requested rows and expiry before choosing which rows, verbs, and exact
objects to keep. An all-of-type selector may be narrowed to a list of exact
object IDs, and the expiry may be shortened with a UTC date and time. The review disables approval for
an empty or invalid draft; the server checks the edited rules and expiry again
after step-up. Denial and approval as requested remain available.

- `approval_id` names the request that wrote the row (origin `manual`, no
  provenance);
- `expires_at` is always set — the approved expiry, at most 90 days out;
- the rows are **revoked** when the request's related task (or, for a
  request naming only a phase, the phase) is completed or archived, and
  reopening restores nothing. A row another task's assignment links is handed
  over to that assignment instead of revoked.

A Connector can likewise file a **credential request** for one new credential
carrying scopes it lacks; that writes no grant rows. Its credential is issued
when the Connector collects the approved request, and revoked at the same
terminals. The routes, bodies and refusals are in [the API
reference](api.md) under "Access requests"; the tool is described in [the
MCP reference](mcp.md) under "Asking for authority you lack".

A Connector that lacks scopes on its OWN credential files an `authority-edit`
request instead (AZ-A13). Its decider chooses how long the widening lasts:
**Until a date** (or **Until this task ends, or a date**, when the request
names a related task) or **Keep (until narrowed)**. A dated or task-bound
widening is reverted automatically, as an audited narrowing, at the date or
the task's terminal, whichever comes first; the credential's own expiry is not
changed. See [the API reference](api.md) under "The agent's door".

## Manage grants

```bash
relayhall grant list
relayhall grant list --grantee <principal-uuid> --resource-type task
relayhall grant list --limit 50 --made hand            # one page; prints the next cursor
relayhall grant list --limit 50 --cursor <next-cursor>  # the page after it
relayhall grant add <principal-uuid> report read
relayhall grant add <principal-uuid> task read --resource <task-uuid> --expires-at <iso>
relayhall principal grants <principal>
```

`grant add` with no `--resource` creates the type-wide wildcard and needs a
`root` credential. **Revoking is a signed-in act:**
`relayhall grant remove` is refused `SESSION_ONLY` for every bearer; revoke a
grant, or clean up redundant ones, on the Access page, which asks you to
confirm it is you.

REST:

- `GET /grants` (+`?granteeId=`, `?resourceType=`, and the additive paging, filter, sort and search parameters above) — owner plane
- `POST /grants` — owner plane; grantees are principals or Groups (a Group only as `granteeType: 'group'`)
- `DELETE /grants/{id}` — owner plane, a login session with a step-up bound to `('grant.revoke', id)` in the body `{ stepUpToken }`; a bearer is refused `SESSION_ONLY`, a missing or foreign step-up `STEP_UP_REQUIRED`, both audited
- `POST /grants/bulk-revoke` — owner plane, login session only, step-up per real batch (above)
- `GET /principals/{id}/grants` — own grants at `principals:read`, others behind the manage gate
