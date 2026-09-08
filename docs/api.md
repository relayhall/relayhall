# RelayHall API — usage notes

_Last updated: 2026-08-03. Machine-readable spec: `GET /openapi.json` (auth required)._

## Basics

- Public base: `https://<your-domain>/api` (nginx strips `/api`; backend routes have no prefix). Direct backend: `http://localhost:3001/`. Dev stack: `/api/dev`.
- Auth: `Authorization: Bearer <JWT>` on everything except `/health`. Principal API keys (`rh_live_…`/`rh_dev_…`) ride the same header; the env prefix must match the stack.
- Task ids in URLs must be **full UUIDs** — 8-char prefixes are resolved client-side by the CLI only (`INVALID_TASK_ID` otherwise).

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

## Identity & assignment (Phase 1, board reference 60558599)

Task work separates three server-controlled roles: the Assignee (claimant),
the Shepherd and the independent Verifier. `POST /tasks/{id}/claim` and
`/release` own Assignee changes. `PATCH /tasks/{id}/roles`
`{shepherdPrincipalId?, verifierPrincipalId?}` is the only generic role
assignment surface; ordinary Task create/update rejects these identifiers.
The caller must be the Task's Shepherd or an administrator. The Verifier must
differ from the Assignee, and assigning a Service Principal as Shepherd also
requires `services:invoke` (or `root`).

- `GET /principals` — identity anchor rows (id, kind, handle, role, …; metadata never exposed). `503` until migrations 062/063 apply.
- `GET /principals/me` — the caller's resolved principal + scopes; `404` until a principal resolves for the identity (expected for legacy JWTs pre-migration).
- `GET /tasks?owner=<handle>|mine=true|unassigned=true` — Assignee filters on `tasks.owner_principal_id` (the identifiers keep their historical names). `mine=true` returns `[]` when the caller has no principal; all three answer `503` pre-migration.
- `POST /tasks/{id}/claim` / `POST /tasks/{id}/release` — Assignee-set writes. Claim is idempotent for the current Assignee, `409` when another principal is already the Assignee; release requires being the Assignee (orchestrator role may force).
- `POST /principals` `{handle, kind, displayName?, purpose?}` — create an **Account**: a parentless human or service principal (A17.1). `purpose` is **required** for service Accounts (`422 PURPOSE_REQUIRED`); `kind=agent` is refused (`422 AGENT_MINT_ONLY` — Agent identities arrive only through the delegation machinery). Reserved seed handles and anything starting `agent:` are refused (a hand-made `agent:` handle would collide with a spawn principal and capture that task's attribution).
- `PATCH /principals/{id}` — display name and `status`. **Disabling is the kill switch**, without touching the credential rows: the principal's `rh_` keys stop authenticating on the next request, and its dashboard JWTs stop working too — including on the WebSocket stream, the plugin proxy and the capability-cookie mints. Two caveats worth knowing: the legacy shared env keys (`RELAYHALL_API_KEY` and friends) are *not* affected, because they authenticate by env comparison rather than by principal; and a status change made directly in the database rather than through this endpoint can take up to 60 seconds to bite, because principals are cached for that long. The owner identity (`dashboard_user`) and `system` cannot be disabled through the API at all.
- `GET /principals/{id}/credentials` — listing; secrets are never included.
- `POST /principals/{id}/credentials` `{label, scopes[], expiresAt?, transport?}` → `201 {keyId, secretOnce}`. **`secretOnce` appears in this response and is never logged.** Since AZ-S3 the secret is also stored encrypted at rest and can be RE-REVEALED under the lineage/step-up rules of `POST /credentials/{id}/reveal` — see the delegation section. Targets must be Connector/Agent layers: Accounts are keyless (`ACCOUNTS_ARE_KEYLESS`).
- `POST /credentials/{id}/revoke` — effective on the very next request; idempotent.
- `POST /credentials/{id}/rotate` `{graceHours?}` → a replacement key with the same label and scopes. The old key's expiry becomes the **earlier** of its current expiry and now+grace, so rotating can only ever shorten a credential's life. Rotating a revoked credential is refused.

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
presence/telemetry ingest verb — AUTHZ design 4d961e37 A17.7, the `status:write`
successor, minted at AZ-S6) · `root` (the global sentinel: satisfies
every check). The remaining ratified scopes (`tools:read`, `tools:invoke`,
`blueprints:*`, `personalities:use`) ship in the vocabulary but cannot be
minted until their objects land — the Tool object surface and the Blueprint
object do not exist yet.

Charter reads (`GET /projects/{id}/charter` and its version routes) are
ordinary project disclosure under `projects:read`. Charter WRITES
(`PUT /projects/{id}/charter`) are owner-plane: they sit behind the `root`
sentinel, deliberately not the mintable `projects:write` — agents propose
Charter changes through Reports, the owner applies them. See
[charter.md](charter.md).

Compiling a phase brief (`POST /phases/{id}/brief`) requires `phases:read`
**and** `tasks:read`: the route family rule covers the phase, and the extra
requirement is checked in the handler because the output discloses task
content. See [phases.md](phases.md).

Compiling a Brief is a disclosure act: `POST /tasks/{id}/brief` requires
`tasks:read` (the former `tasks:prompt` scope retired into it; migration 070
rewrites stored keys). The Brief family is one verb, one noun and four
altitudes — `POST /tasks/{id}/brief`, `POST /phases/{id}/brief`,
`POST /projects/{id}/brief` and `POST /principals/me/brief` (the session
brief, which is also what marks a credential bootstrapped). RH-P3.C4 retired
the pre-A7 `/tasks/{id}/prompt` and `/projects/{id}/generate-brief` spellings
and the `prompt` response key; none of them is aliased. The session brief
requires `principals:read`. No Brief route executes an agent. Hard removal is
the `admin` verb: `DELETE /tasks/{id}` and `DELETE /reports/{id}` require
`tasks:admin` / `reports:admin` rather than the routine write plane.

Telemetry ingest (`POST /telemetry/frames`) requires `telemetry:write`
(AUTHZ design 4d961e37, A17.7 / §9.1): each service writes only its own
frames — the frame's owner is always the calling principal, recorded
server-side, and the body cannot name one. Telemetry reads stay `tasks:read`
on their existing task-read surfaces; there is no `telemetry:read` scope
until a dedicated read surface exists, and every `/telemetry` path other
than the ingest route is unmapped and fails closed to `root`.

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

### Groups (AZ-S1, design 4d961e37 §3)

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

### Directory group references (RH-LENSES-a, design 07764243 §3–§5)

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
session** sees every row; **every other caller, bearer or session, receives
`200` and an empty list**. A 403 on a list route would disclose that the surface
exists and is populated. A reference outside your projection answers **404**,
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

### Access profiles (AZ-S2, design 4d961e37 §4)

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
listings ride `principals:read`. Previews: `GET /principals/me/effective-access` (self,
`principals:read`) and `GET /access-profiles/what-if?principalId=` (another
principal's authority — `root`). Provenance lives in append-only
`access_profile_events` (`GET /access-profiles/{id}/events`, `root`) plus
the board audit ledger.

### Delegation, credentials and transport (AZ-S3, design 4d961e37 §5/§7)

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
Non-escalation: `root` is never delegable and no new bearer credential can
carry it; `*:admin` scopes never reach the Agent layer; an Agent's
write-class authority never leaves its bound task. Evaluator failure fails
the whole request with 503 — never a partial list.

Credentials: secrets are **encrypted at rest** under an envelope keyset from
`RELAYHALL_CREDENTIAL_KEYS`/`RELAYHALL_CREDENTIAL_ACTIVE_KEY` (a deployment
without a keyset cannot mint); a startup + periodic canary verifies
decrypt-vs-hash and fails loudly. `POST /credentials/{id}/reveal` re-reveals
under lineage (bearer) or step-up (session) rules; `POST /auth/step-up`
mints the single-use elevation token. Rotation (`POST /credentials/{id}/rotate`)
is an **exact copy** — scope/transport changes are refused; the predecessor
gets a live-evaluated grace window (default 24h, 0–7d), graced tokens are
never revealable, and a new rotation revokes the prior graced ancestor.
Agents never rotate. Credentials carry a `transport` pin (`any|mcp|api`)
compared against **server-derived** request provenance only.
`POST /principals/{id}/terminate` is irreversible offboarding (A17.10).

Pre-096 rows an invariant outlaws are marked `legacy_identity`: they keep
their Phase-2 behavior (audited with a legacy marker), sit in the
remediation queue, and are frozen out of all new machinery until the
Phase-5 estate transition.

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
```

Or via the CLI: `relayhall whoami`, `relayhall principals`, `relayhall principal create`, `relayhall credential issue|list|rotate|revoke`.

### Task notes

`POST /tasks/{id}/notes` `{text}` appends a timestamped, attributed line server-side. Notes are a single TEXT column, so read-modify-write appends from concurrent clients silently overwrite each other; this does the append in one statement.

**Creating a task with notes.** `POST /tasks` accepts `notes` and stores it verbatim, exactly as `PATCH /tasks/{id}` does — one validator serves both, so the two surfaces cannot disagree about the field: a string is stored, `null` leaves the column empty, and anything else answers `400 INVALID_TASK_NOTES` naming the field. It did not always: until card 9c3a1aa4 a `notes` value in a create body was accepted with `201` and silently dropped, and a caller that wanted notes on a new task had to follow every create with a `PATCH`. The create path leaves the same `task_history` row with `field=notes` that every other write to the column leaves.

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
  do, past three digits, until the round-2 review of card 7d38a6e0 measured it.

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

## Error envelope

New-style errors (validation, webhooks, batch, uncaught-500s) return:

```json
{ "success": false, "error": "…", "code": "VALIDATION_FAILED", "message": "…",
  "suggestion": "what to do about it", "details": [{ "field": "title", "problem": "is required" }] }
```

`error` mirrors `message` for backward compatibility with older `{success,error,code}` consumers. Older routes migrate to `sendApiError` opportunistically — codes are stable either way.

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
field. Any other bounded column is caught by a shared fallback that maps the
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
choice of whose authority to use (AUTHZ design `4d961e37` §5.2, ruling
`ccd53781`).

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
`phase.acl_changed`, `project.acl_changed`, `report.created`, `report.updated`,
`report.deleted`, `report.acl_changed`, `skill.created`, `skill.updated`,
`skill.deleted`, `skill.acl_changed`, `personality.created`,
`personality.updated`, `personality.deleted`, `personality.acl_changed`.
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

## OpenAPI coverage

`/openapi.json` documents the endpoints agents and integrations actually use:
tasks, batch, subtasks, the task stream and references; Brief compile at all
four altitudes; projects, phases, project resources and Charters; reports;
skills; services and capability descriptors; principals, credentials, grants,
groups, warrants, delegation and approvals; access profiles; audit;
notification endpoints; telemetry ingest; models; subscriptions; and health.
Routes not listed there are internal/unstable — read the source before relying
on them. The cursor event feed (`GET /events`) is one of those: it is not in
the spec, and `backend/src/routes/events.ts` is its contract.


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


## Blueprint capture and workflow setup

`POST /blueprints/capture` accepts `{phaseId, projectId?, name?, key?}` with full UUIDs. It requires `blueprints:write` and caller-filtered Project/Phase/Task reads, without requiring Project write. HTTP 201 returns `{success:true, blueprint:{id,key,version:1,status:"draft",contentSha256,identitySha256}}`. Hidden work returns a concealed 404; nonportable content returns a typed 422 without a partial draft. The Blueprint route family avoids classifying capture as a Project write.

Submitting an empty plan returns `BLUEPRINT_EMPTY_PLAN` (422, field `tasks`). Independent publication review remains mandatory.

Preview names unavailable references through `requiredAccess`, `reason` and `plan.refusals` (`BLUEPRINT_REFERENCE_ACCESS_REQUIRED`). Captured documents with `target.allowExisting:true` also admit an existing-Project target.

`POST /instantiations/:id/setup/preview` accepts either `{warrantId}` or `{createWarrant:{holderPrincipalId,ceilingProfileId,expiresAt}}`. New-Warrant setup is human-session-only. Its preview shows the Warrant, exact profile assignments, Task revisions and confirmation hash. Apply via `POST /instantiations/:id/setup` with the confirmed input, `tasks`, `confirmationHash`, and a step-up token bound to `warrant.create` and the holder. Retain the Idempotency-Key for retries. The step-up token is excluded from the idempotency digest and never stored in the receipt. Existing-Warrant request hashes remain compatible.

See [Blueprint authoring and use](blueprints/README.md) for CLI/UI instructions and portability restrictions. MCP has no Blueprint authoring plane.
