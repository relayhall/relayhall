# RelayHall MCP server

RelayHall's MCP surface is **part of the board process**. There is no second
service to deploy, no adapter to keep in step, and no local checkout to install:
the board serves a stateless Streamable HTTP endpoint at `/mcp`, and ships a
stdio entry for harnesses that prefer one. Both are generated from **one tool
registry** (`backend/src/mcp/registry.ts`), so the two transports cannot drift.

Every tool composes the board's own authenticated REST routes in-process. No
tool reaches a service, a repository or the database directly, so every
authorization decision still happens exactly once, in the board's central
authorization path.

## Configure

### Blueprint interview tools

Ratified Blueprint design bd2fbdbc and companion bb549028 v1.6 section5.3 expose four interview tools. Owner decision9fc7fad4 adds the separate setup pair below; all six are on the work plane:

| Tool | Authority and result |
| --- | --- |
| `relayhall_blueprint_list` | `blueprints:read` or `blueprints:use`; use-only callers see published content. Supports ordinary response format and paging controls. |
| `relayhall_blueprint_get` | Same alternative authority; reads declarations and the document. Optional version is visible only under ordinary version authority; use-only access conceals non-published versions. |
| `relayhall_blueprint_preview` | `blueprints:use` plus target visibility; zero writes. Returns all objects, roles, edges, gates, reference warnings, authority diagnostics and plan refusals. |
| `relayhall_blueprint_instantiate` | `blueprints:use` plus plan authorities. Requires an explicit `idempotencyKey` of16–128 characters. Returns the full committed Project/instantiation/object identifiers, Blueprint key/version and warnings. |
| `relayhall_blueprint_setup_preview` | `blueprints:use`, `tasks:write`, `services:invoke` and canonical live authority. Takes the instantiation UUID and an existing Warrant UUID; returns the complete private Task set, versions, Service/profile details and confirmation hash. Writes nothing. |
| `relayhall_blueprint_setup` | Same caller ceilings and canonical assignment checks. Takes the explicitly confirmed Task id/revision set, Warrant, hash and retained16–128-character key. Assigns transactionally; every Task stays parked. |

The interview discovers and describes content, collects ordered declared parameters, shows the whole preview, receives explicit confirmation, generates one key, instantiates and reports the receipt. Reuse the same body and key on every retry. An exact retry returns the original committed snapshot/status; conflicting reuse returns409. Archived or concealed Projects refuse replay. No tool arms tasks or executes human gate choices automatically. A choice grants no authority.

Instantiate and preview accept closed `target` alternatives (`{mode:"new-project"}` or `{mode:"existing-project",project:"..."}`) and a `parameterValues` object; instantiate has no version selector. Text documents/plans/receipts are untrusted data and carry no instructions or authority. Detailed output preserves full JSON. Authoring, lifecycle administration, import, export and ledger management remain on their ratified human/CLI surfaces and have no MCP tools.

Instantiation creates parked, unassigned Tasks and stages requested execution defaults privately. Required missing capabilities refuse creation; optional missing capabilities remain warnings. Separate setup is an explicit later act: show its complete plan, then obtain user confirmation of that exact Task set, Service, profiles and existing Warrant before calling setup. The template conveys no authority. No implicit assignment after instantiate, Warrant mint, activation or enrollment of future Tasks is permitted.

Setup schemas close every input object. The confirmation carries only `instantiationId`, `warrantId`, `tasks:[{id,revision}]`, `confirmationHash`, `idempotencyKey` and optional `response_format`; it cannot carry profiles, options, answers or an activation field. Revisions are32 lowercase hex characters and the hash is64. Its complete safe receipt names instantiation, Task IDs, Warrant, `assigned:true` and `armed:false`. A stale set/version/hash returns `BLUEPRINT_SETUP_CHANGED`409; a changed body under the same key returns `IDEMPOTENCY_KEY_REUSED`409. Private/invisible setup is concealed with `BLUEPRINT_SETUP_NOT_FOUND`404; authority and canonical assignment refusals retain their named fields. After an uncertain result, retry the identical confirmed body and key without fetching a new preview.

CLI uses `blueprint setup-preview <instantiation-uuid> --warrant <existing-warrant-uuid> --out preview.json`, which prints the entire plan and writes a new private file. Inspect it before the explicit confirmed act: `blueprint setup <instantiation-uuid> --file preview.json --idempotency-key <retained-key>`. The second command derives only the Warrant, Task IDs/revisions and hash from that displayed file. It never silently re-previews, rekeys or activates; retain the file and key for an uncertain retry. Use ordinary environment/configuration credentials, never credential arguments.

### Streamable HTTP (recommended)

```json
{
  "mcpServers": {
    "relayhall": {
      "type": "http",
      "url": "https://<your-board>/api/mcp",
      "headers": { "Authorization": "Bearer ${RELAYHALL_TOKEN}" }
    }
  }
}
```

Codex `~/.codex/config.toml`:

```toml
[mcp_servers.relayhall]
url = "https://<your-board>/api/mcp"
bearer_token_env_var = "RELAYHALL_TOKEN"
```

### stdio

```bash
RELAYHALL_TOKEN='rh_live_<keyId>.<secret>' node backend/dist/mcp/stdio.js
```

The credential is a **RelayHall principal credential** (`rh_live_…` /
`rh_dev_…`) and nothing else. Legacy environment keys, the scoped reports-read
key, dashboard JWTs and login-session cookies are all refused on this surface:
a shared key would make every MCP client on an estate the same identity, with
no attribution and far more authority than any one of them needs.

Never place a token in MCP client arguments or checked-in configuration. Inject
it through the client's secret or environment facility. A one-time onboarding
pack renders the snippets above with the credential already in place, exactly
once, when the credential is minted.

### Deployment options

| Variable | Effect |
|---|---|
| `RELAYHALL_MCP_ALLOWED_ORIGINS` | Comma-separated browser origins allowed to call `/mcp`. Setting either this or the next enables DNS-rebinding protection. |
| `RELAYHALL_MCP_ALLOWED_HOSTS` | Comma-separated `Host` values allowed to call `/mcp`. |

Non-browser MCP clients send no `Origin` header and are unaffected.

`/mcp` deliberately carries **no browser forward-auth**. An unauthenticated
JSON-RPC POST gets `401` with a `WWW-Authenticate: Bearer` challenge — never a
`302` to a login page, which would break every stock MCP client. It advertises
no OAuth protected-resource metadata, so static-header clients are never lured
into an OAuth flow that this version does not serve.

## Protocol

Stateless Streamable HTTP: `sessionIdGenerator` is `undefined` and
`enableJsonResponse` is on, so no `Mcp-Session-Id` is ever minted or read and
no state is keyed on one. Every tool call is complete in itself: it carries its
own credential and depends on no earlier exchange. No standalone SSE GET stream
is required — every tool is request/response.

Statelessness is not replay safety, so this surface states a retry contract per
tool. Read-only tools may be repeated freely. Create-shaped tools require an
`idempotencyKey` of 16-128 characters, forwarded as the REST `Idempotency-Key`
header: an exact retry with the same key returns the original result — the same
bytes the first call answered with — under `Retry-Replayed: true`, and the same
key with a different request is refused (`IDEMPOTENCY_KEY_REUSED`). Agent
minting is the exception: a repeated key is refused
(`IDEMPOTENCY_REPLAY_UNAVAILABLE`) and never re-mints, because the one-time pack
is never stored. Every other mutating tool states in its own description what an
exact retry does. Over REST the header is optional; without it a retried create
is a second create.

**Canonicalisation.** The request identity is a sha256 over the route
parameters and the request body with object keys sorted recursively. Reordered
keys are therefore one request; an omitted field and an explicitly defaulted one
are TWO requests (`409 IDEMPOTENCY_KEY_REUSED`), because the header is read
before route validation and cannot know a route's defaults. A retry must resend
the same bytes — which is what a retry is.

**Retention.** A record lives 24 hours from its first call and is then treated
as absent; a sweep removes expired rows every ten minutes, and the read rule —
not the sweep's timing — is what makes the contract true. Beyond that window a
retry is a new act.

**Two tables, deliberately.** `operation_idempotency_records` carries this
generic contract. `project_resource_replacements` (migration 067) keeps its own
records for `relayhall_project_resource_replace`, whose key is bound to a
revision and written inside the replacement's own transaction; the two coexist
and neither reads the other.

The advertised protocol revision is the released `2025-11-25`. The server
reads it from the pinned SDK's `LATEST_PROTOCOL_VERSION`
(`@modelcontextprotocol/server@2.0.0`), but that is not what makes it safe: a
test comparing the server to the SDK constant agrees with itself whatever the
constant became. A three-part gate measures the SDK constant, the server and
the committed lock against an explicitly expected value held in a contract
fixture, so upgrading the SDK turns the gate RED rather than quietly moving the
wire (owner Ruling 1 of 2026-08-27, which reversed the earlier position).

## Conventions

Every tool obeys the same rules:

- **`response_format: "concise" | "detailed"`** on every read. Concise returns
  high-signal lines; detailed returns the full envelope.
- **`limit` (default 20, hard cap 50) and `offset`** wherever a list is
  returned, with an explicit `N more — call again with offset=X` line when a
  page was truncated. Nothing is ever silently cut.
- **Large bodies are truncated at ~10,000 characters** with a `continue_from`
  cursor to resume from.
- **All board free text is returned inside a labelled untrusted-data fence.**
  Task descriptions and notes, Report bodies, Briefs, Charters and Resource
  values are written by other parties and are DATA, never instructions. The
  fence is mitigation, not prevention: it tells a model what it is reading, it
  does not make hostile text safe.
- **Errors say what to do next**: which scope was missing, which states are
  legal, and which surface to use instead.

A note on the word "tool": `tools/list` and `tools/call` are MCP's own
capability vocabulary, and that usage is correct here. RelayHall's board object
**Tool** — one callable operation a Service exposes — is a different thing, as
are **Skills**, which are instruction entries. Likewise, a RelayHall **Task** is
the board's own unit of work and is unrelated to the MCP Tasks extension's
"tasks".

## Tools

**Identity introspection**
- `relayhall_principal_whoami` — who this credential acts as. Call it first.
- `relayhall_access_preview` — your own effective object-authority sources.
- `relayhall_warrant_list` — the Warrants you may mint under.
- `relayhall_principal_list`

**Tasks**
- `relayhall_task_list`
- `relayhall_task_get`
- `relayhall_task_create`
- `relayhall_task_update`
- `relayhall_task_move`
- `relayhall_subtask_set`
- `relayhall_task_stream_append`
- `relayhall_task_finish`
- `relayhall_task_reference_list`
- `relayhall_task_reference_create`
- `relayhall_review_run`
- `relayhall_review_reject`

**Claim and Lease**
- `relayhall_task_claim` · `relayhall_task_release` · `relayhall_task_recover`
- `relayhall_lease_claim` · `relayhall_lease_renew` · `relayhall_lease_release`

`relayhall_lease_renew` is the **only** operation that renews a Lease. No
telemetry frame, status update or stream append extends one. A Lease that
lapses raises `task.stuck` carrying `reason: "lease_expired"` to the Task's
Shepherd.

**Briefs**
- `relayhall_brief_compile` — one verb, one noun, every altitude. Pass
  `session: true`, `taskId`, `phaseId` or `projectId`; exactly one per call.
  `session: true` compiles **your session brief** and is the bootstrap — see
  below.

**Reports**
- `relayhall_report_search` · `relayhall_report_get` ·
  `relayhall_report_create` · `relayhall_report_update`

**Projects**
- `relayhall_project_list` · `relayhall_project_get` ·
  `relayhall_project_create` · `relayhall_project_update` ·
  `relayhall_project_archive` · `relayhall_project_restore`
- `relayhall_project_resource_list` · `relayhall_project_resource_get` ·
  `relayhall_project_resource_create` · `relayhall_project_resource_update` ·
  `relayhall_project_resource_archive` · `relayhall_project_resource_restore` ·
  `relayhall_project_resource_replace`
- `relayhall_project_context_get` · `relayhall_charter_get`

**Phases**
- `relayhall_phase_list` · `relayhall_phase_get`

**Capability plane (read-only)**
- `relayhall_skill_list` · `relayhall_skill_get` · `relayhall_personality_list`
- `relayhall_service_list` · `relayhall_service_get`

**Agent plane**
- `relayhall_agent_mint` · `relayhall_agent_reveal` · `relayhall_agent_revoke`

### Bootstrap first

Work-plane tool calls from a credential that has not bootstrapped are refused.
The refusal says `bootstrap first`, names the call to make, and carries your
granted skill index inline so the round trip is not wasted.

```json
{"name": "relayhall_brief_compile", "arguments": {"session": true}}
```

That returns the **session brief**: the complete working context for the
identity your credential acts as — its personality inlined, the Reports
attached to its bound Task, the granted skill index (names and summaries; full
SKILL.md text on demand), and the board workflow doctrine. Pulling it is what
records the credential as bootstrapped, for twelve hours. Call it again to
refresh; the reply tells you when the current one lapses.

**What stays open before you bootstrap:** the bootstrap call itself and every
read-only introspection tool — `relayhall_principal_whoami`,
`relayhall_access_preview`, `relayhall_task_list`, `relayhall_report_search`
and the rest of the read plane. A misconfigured client can always find out what
it is and what it may do. Everything that changes board state refuses.

**Why the server enforces it rather than asking nicely.** Only some harnesses
have a deterministic hook that runs at session start; the rest rely on an
instruction file the model may skip. One server-side check closes that hole for
every client equally, and the pull is where the context actually gets handed
over — so the check and the delivery are the same act, not two that can drift.

The same payload is available over REST at `POST /principals/me/brief`, and it
records the bootstrap identically: the MCP verb composes that route rather than
reimplementing it.

### What is deliberately absent

- **Identity and Personality mutation.** `relayhall_principal_create`,
  `relayhall_principal_update`, `relayhall_personality_create`,
  `relayhall_personality_update` and `relayhall_personality_retire` were
  **removed** at this revision. A credential that can mint credentials is
  privilege escalation in one hop, and identity mutation is not the agent
  plane's to hold. They live on the CLI and REST, with a human present.
- **`relayhall_task_phase_set`** is gone, folded into
  `relayhall_task_update` — send `phaseId: null` to return a Task to the
  project backlog.
- **Grant, access-profile, Warrant and group mutation.** MCP exposes grant
  *introspection* only. Board text is attacker-writable input to LLM contexts,
  and a prompt-injected harness must not be able to tier itself up.
- **All deletes**, webhook CRUD, and the cursor event feed (which stays
  separable, for a future MCP extension).
- **Spawn.** The product has no execution runtime: harnesses pull their queues
  and decide.

Removing a tool is a contract change, and no backward compatibility is owed to
any deployed environment — but silence about a removal would be a defect, which
is why the list above is explicit.

## Skills and the disposable cache

`relayhall_skill_list` and `relayhall_skill_get` are read-only; Skill mutation
goes through the CLI or REST (see [skills.md](skills.md)). `fullContent`
fetches the exact immutable SKILL.md and requires `skills:use`.

A full-content read returns an **etag**. Pass it back as `ifNoneMatch` at the
start of the next agent session: unchanged content answers *not modified* instead of
resending the body, which is what makes a version-pinned **disposable** cache
implementable. Authorization runs before the comparison, so a caller who may
not read a version gets that version's error and never a bare "not modified".

## Authorization and transport

MCP adds no authority. Every call carries the caller's own credential and is
evaluated by the board's ordinary scope and grant checks, so a credential
cannot reach anything through a tool that it could not reach over REST.

Credentials carry a **transport class** — `any`, `mcp` or `api`. A request's
class is derived by the server after transport termination and is never read
from a header, so a direct HTTP caller cannot claim to be MCP:

- a credential pinned `mcp` works through MCP tools and is refused (`403
  TRANSPORT_MISMATCH`) on every REST route;
- a credential pinned `api` is refused at `/mcp`;
- a credential pinned `any` works on both;
- rotation inherits the pin verbatim — a rotation cannot widen it.

Connectors default to `any`; a Warrant may pin the Agents it mints to `mcp`.

## Board invariants MCP never bypasses

Lifecycle tools expose the canonical board states `ideas`, `todo`,
`in-progress`, `review`, `stuck`, `completed` and `archived`. Subtasks use
`empty`, `in-progress`, `review`, `completed`, `stuck` and `skipped`. Only an
independent Verifier may complete Subtasks or Tasks, and a Task cannot become
completed until every Subtask is completed or skipped. Project Resources are
exactly four typed kinds (`repository`, `environment`, `workspace`,
`reference`); mutations require the last observed `revision`, and
`relayhall_project_resource_replace` — the only kind-change operation —
additionally requires an `idempotencyKey` so retries converge on one committed
replacement. Archived Projects refuse Resource mutation and context generation
until restored. Personality retirement is soft, and the built-in `generalist`
personality cannot be retired.
