# Observability: the reporter model

RelayHall's observability rests on one rule (strategy F11):

> **The board never observes. Connectors report.**

The board holds no connection into any agent runtime. It does not read
sessions files, watch transcript directories, probe harness binaries, or
scrape local state. Everything the Sessions and Stats pages show arrives
because a **reporter** chose to send it — with one narrow exception, stated
here so it cannot grow quietly.

**The board records the calls made to its own MCP server.** A Connector
that declared a telemetry tier and works through the board's MCP server
appears on the Agent sessions page from those tool calls
([MCP-derived sessions](#mcp-derived-sessions)). That is
the board noting traffic on its OWN surface — which tool was called, by
which credential, when — and nothing else: no harness state, no files, no
transcripts, no prompt or tool content, and nothing at all for a Connector
whose descriptor declares no tier.

## The pieces

### Outposts (the reporters)

A reporter — an **outpost** — runs *next to* an agent runtime and pushes
session activity to the board over the typed ingest contract. An outpost is not
a plugin: a plugin installs into the board deployment, an outpost runs beside
someone else's runtime, and that difference is the trust boundary. The board is
a passive recipient: it stores what reporters send, verifies idempotency and
cursor ordering, and renders it.

No reporters installed, and no telemetry-declaring Connector working over
MCP, means the Sessions and Stats pages render their documented empty state.
That is the zero-config default, not an error.

### The ingest contract — `backend/src/types/CanonicalSession.ts`

The typed contract a reporter speaks is already specified in
[`backend/src/types/CanonicalSession.ts`](../backend/src/types/CanonicalSession.ts):

- `CanonicalIngestionBatchInput` — cursor-based batches (`cursorPosition`,
  `cursorValue`, `sourceChecksum`) of `CanonicalEventInput` events, each with
  an `idempotencyKey`, an `eventKind`
  (`message | tool_call | tool_result | usage | lifecycle | control | error | other`),
  and a `redactionPolicyVersion`. Replays are detected, not duplicated.
- `CanonicalAdapterHealthInput` — reporter-side health self-reports
  (`healthy | degraded | unavailable | unauthorized | unknown`), with
  non-secret `safeDetails` only.
- `ResolveAttemptInput` / alias inputs — how a reporter asserts session
  identity, with explicit authority and confidence grades.

No HTTP endpoint fronts this batch contract yet. What Phase 3 shipped instead
is the trimmed presence surface (RH-P3.C7 — strategy §2.6.5 as cut by C5/F11):
`POST /telemetry/frames` accepts heartbeat and coarse `active | idle` status
frames under `telemetry:write`, each with an optional JSON `payload` capped at
4096 bytes; an accepted frame is written to `telemetry_frames` and changes
nothing else on the board. A frame that names a Task counts as that Task's
activity only when it comes from the Task's current Assignee (through its
assigned connector, if one is named) under the current assignment; the board
and Task details read it through `GET /tasks/activity`
(`docs/contracts/task-activity-v1.md`).
The batch contract file is kept in core so
reporters and a future ingest surface are built against the same types. The
retired reference implementation (`OpenClawCanonicalAdapter`, a board-side
adapter from an earlier architecture) is no longer in the tree.

### The telemetry envelope — `rh.ai.telemetry/1.0`

Alongside the canonical-session contract above, an outpost may push **envelope
events**: the frozen `rh.ai.telemetry/1.0` record defined in
[`backend/src/types/TelemetryEnvelope.ts`](../backend/src/types/TelemetryEnvelope.ts).
The envelope is the reporter-facing shape of the telemetry plane; presence
frames (`POST /telemetry/frames`) remain a separate, cheaper channel whose
contract is unchanged.

Three properties are worth knowing before writing a reporter:

1. **Identity is derived, never asserted.** The board reads the owning
   Connector, the Account, and — only for a Connector-descended Agent
   credential — the Agent, out of the authenticated credential chain. An
   `identity` block inside the payload is *advisory*: it is never used for
   authorization or attribution, and at Tier 0 only a keyed-HMAC pseudonym of
   `identity.user_id` survives storage.
2. **Event identity is connector-namespaced.** Dedupe keys on
   `(connector_id, source.product, event_id)`, or on
   `(connector_id, source.product, stream_generation, source_sequence)` for a
   source with no stable event id — one of the two is REQUIRED. Dedupe never
   merges events across connectors.
3. **The schema major is advertised.** An unknown *major* is rejected with the
   accepted-majors advertisement; v1.x additions are additive-only.

### Policy tiers, and what Tier 0 stores

Every source has a **policy tier**, and the board enforces it at ingest by
rebuilding the stored record from an allowlist rather than by removing fields
from what arrived. **RelayHall accepts Tier 0 only today** — the Tier 1 and
Tier 2 arms refuse, loudly, rather than degrading silently.

Tier 0 keeps operational metadata: model, token counts, latency, phase, tool
name, outcome, correlation identifiers, and an error *type*. It keeps
**no prompts, responses, file paths, command arguments, or raw exception
messages**, and it stores no content references at all. Anything a reporter
sends outside that surface — including every `attributes` entry, because
attributes are denied by default — is dropped and *counted*, so the loss is
visible rather than silent.

Identifiers fall into two groups, and the difference matters:

- **The W3C trace triple** — `trace_id`, `span_id`, `parent_span_id` — is kept
  verbatim. It is hex by specification, so it cannot carry content, and an
  external OTLP consumer needs it unchanged.
- **Everything else is pseudonymized**: the source-side session identifiers
  (`conversation_id`, `session_id`, `attempt_id`), the reconciliation
  identifiers (`request_id`, `tool_call_id`), the reporter's `instance_id`, and
  any payload-borne human identifier. Each is a keyed-HMAC pseudonym under a
  deployment pepper. An identifier that *is* an address folds case, because an
  address is case-insensitive by contract; one that merely *contains* an
  address does not, because `acct:Member@…:A` and `acct:member@…:a` may be two
  different accounts.

Pseudonymizing the reconciliation identifiers costs nothing: **if both the
telemetry feed and the accounting feed pseudonymize under the same domain and
pepper, equality is preserved**, so reconciliation still matches — without
either feed's raw identifier ever being stored. (A pull connector that compares
a raw provider id against a stored pseudonym will match nothing; that is a
requirement on the accounting side, not an option.)

Pseudonyms are computed in **separate governed domains**, so a person, a
session, an instance, a request and a tool call never collide even for the same
input string. Only a value that IS, in its entirety, an address folds case and
Unicode form, because only an address is case-insensitive by contract. A value
that merely CONTAINS one is byte-exact, so `MemberABC` and `memberabc` stay two
accounts, and so do full-width and ASCII forms of the same characters.
The same identifier always yields the same pseudonym under one pepper, so
grouping works without the board holding the identifier. **There is no reversal
path**: no mapping is stored and no reveal capability exists.

<!-- WITHDRAWN-NARRATIVE: error_fingerprint, error_frames -->

**There is no error fingerprint at TW1a.** A reporter sends `outcome.error_type` — a validated
exception class name, which is Tier-0 operational metadata and is stored — and that is all.
`outcome.error_fingerprint` and `outcome.error_frames` are **refused**, with the reason, so no
reporter can believe a fingerprint is being kept when none is.

This is a **declared narrowing of design §6.1**, ruled by the owner on 2026-09-03 in the same
shape as the pseudonym-reversal narrowing. §6.1 defines the fingerprint as "a hash over
exception type + stack-frame signature, containing no message-derived bytes" — a definition that
presumes a *trusted* capture path. TW1a has none: the board never observes, so every input at
this seam is chosen by the reporter, and three successive mechanisms (store the reporter's
digest; re-key it under the pepper; compute it receiver-side from reporter-supplied frames) were
each shown to carry reporter-chosen message bytes into the stored value. Syntax cannot establish
provenance — no grammar can prove a string is a real function name rather than message text.

The fingerprint returns in **TW2**, where the first-party OpenClaw/Hermes runtime can supply
exception structure the reporter did not choose. Nothing in TW1a's acceptance depends on it: the
chip, the timeline, the rollups and the coverage view never read one.

### What shape can and cannot close

Tier 0 rebuilds the stored record from an allowlist, and every field with a
shape is held to it: versions must be versions, dates dates, currencies ISO
codes, and phase, status, mechanism, support level, model operation and finish
reason are closed vocabularies.

Three things stay free-form because their contract makes them so, and no
pattern can tell an opaque identifier from content that merely looks like one:
`source.product` / `source.adapter`, the model names, and the `event_id` /
`stream_generation` identity fields. They are bounded and whitespace-free, and
`source.product` is additionally checked against the Connector descriptor's
declared product list at ingest — the allowlist, not the shape, is the control
there.

So: **an adapter that mis-maps content into one of those fields defeats Tier 0
for that field.** That is what adapter certification exists for, it is visible
in the redaction counts whenever a value fails its class, and it is stated here
rather than papered over.

The pepper is a deployment environment value, never a database row:

| variable | meaning |
|---|---|
| `RELAYHALL_TELEMETRY_PEPPERS` | JSON object `{ pepperId: base64(32 bytes) }` |
| `RELAYHALL_TELEMETRY_ACTIVE_PEPPER` | the pepper id new pseudonyms are computed under |

Rotation adds a new id and retires the old one once no row references it. A
startup canary proves the configured pepper actually reaches the running
process; a deployment that already holds pseudonymized rows and has lost its
pepper refuses to start rather than writing inconsistent pseudonyms.

### Where envelope events land

Envelope events extend the migration-055 canonical foundation **in place**
(migration `111_telemetry_envelope_foundation.sql`); there is no parallel
session database. Two consequences are worth stating:

- Envelope rows are **attempt-less**: they carry `attempt_id = NULL`, because a
  reporter usually cannot know a board attempt at ingest. They are first-class
  in that state, and correlation may attach them later.
- Because they are attempt-less, they **cannot move a Task's canonical
  progress count**, which is scoped to a bound attempt. Envelope traffic is
  displayed, never authority — the same rule the presence frames follow.

Accounting that arrives without session correlation lands in
`session_accounting_receipts`, grained by account and connector, at org-or-key
scope, by day — alongside the attempt-grained `session_usage_receipts`. There is
deliberately no product column on that table; `session_events.source_product`
is a different thing and is unaffected. A later receipt
*supersedes* an earlier one and never mutates it, so drift stays computable.
The table is content-free **by construction**: every column is a UUID, a date, a number, a
value from a closed vocabulary, or a receiver-derived digest pinned to a fixed shape. There is
deliberately no detail column, no unconstrained text column, and **no reporter-shaped product
key** — a bounded key class cannot tell a product name from a raw customer identifier, so the
product column was withdrawn rather than the claim narrowed. Product-grained accounting arrives
with the provider connectors, together with the registry binding that makes a product key
governed.

### The health surface — `GET /api/sessions/pipeline-health`

The board serves one observability health endpoint today:

```
GET /api/sessions/pipeline-health
→ { "success": true, "status": "unknown", "adapters": [] }
```

- `status` is `unknown` with no adapters, `healthy` when every reporting
  adapter is healthy, `degraded` otherwise.
- `adapters` lists the per-reporter health rows
  (`CanonicalAdapterHealth`) that reporters will maintain via health
  self-reports.

This endpoint is the seed of the Phase-3 reporter-ingest health contract
(`backend/src/routes/reporterHealth.ts`); it reads the canonical
adapter-health table and reports `unknown`/empty until reporters exist.

### Batch ingest — `POST /api/telemetry/events/batch`

The batch surface is the ratified home of canonical batch ingest, and its wire
format is JSONL: **one full `rh.ai.telemetry/1.0` record per line**, sent as
`application/x-ndjson` (or `application/jsonl`). Integrity rides the
authenticated transport at upload — there is deliberately **no separate payload
signature in v1**.

```
POST /api/telemetry/events/batch
Content-Type: application/x-ndjson

{"schema_version":"rh.ai.telemetry/1.0","event_id":"evt-1","kind":"model_call","source":{"product":"claude-code","adapter":"otlp"}}
{"schema_version":"rh.ai.telemetry/1.0","event_id":"evt-2","kind":"tool_call","source":{"product":"claude-code","adapter":"otlp"}}
```

- **At most 500 records and 1 MiB per batch.** The byte limit is enforced by the
  body parser: an oversized upload is never fully buffered, never parsed, and
  never reaches the handler. (With a chunked upload the parser must read until
  it can tell the limit is exceeded; the guarantee is bounded buffering, not
  unread bytes.)
- **Partial success is normal.** Every record is validated, redacted and stored
  on its own merits; the response carries a per-record result alongside
  `accepted`, `duplicates` and `refused` counts. One bad line does not discard
  the good ones — a spool that had to be all-or-nothing would retry the whole
  file forever.
- **One rate charge per batch**, on the `events_batch` surface, not per record.
- A record whose `schema_version` names an unknown major is refused and the
  response carries the accepted-majors advertisement, so a sender can park its
  spool instead of pouring it into quarantine.

### OTLP/HTTP ingest — `POST /api/telemetry/otlp/v1/{traces,logs,metrics}`

A tool that already speaks OpenTelemetry needs no outpost: point its OTLP/HTTP
exporter at the board with a Connector credential, and every record it sends is
translated into an `rh.ai.telemetry/1.0` envelope and stored through **the same
pipeline as the native endpoints** — the same validator, the same Tier-0
policy, the same governed raw store, quarantine and dedupe. There is no second
write path.

```
OTEL_EXPORTER_OTLP_ENDPOINT=https://<your-board>/api/telemetry/otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf          # or http/json
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <the Connector's rh_ credential>
```

For Claude Code, also set `CLAUDE_CODE_ENABLE_TELEMETRY=1` and
`OTEL_LOGS_EXPORTER=otlp`. The credential needs `telemetry:write`, and its
Connector's descriptor must declare the producer's `service.name` as a product
(`claude-code` for Claude Code): a record whose product is not declared is
refused, and counted.

**What is translated.** Three translations, chosen per record, most specific
first; each is `experimental` on the certification ladder:

| translation | applies to | becomes |
|---|---|---|
| `otlp.claude-code` | Claude Code's log events (`service.name = claude-code`) | `api_request` → `model_call` with tokens, cost and duration; `tool_result` → `tool_call`; `api_error` → `error`; `user_prompt`, `assistant_response` → `turn`; `tool_decision` → `audit`; `mcp_server_connection` → `health` |
| `otlp.openinference` | spans with `openinference.span.kind` | `LLM`, `EMBEDDING`, `RERANKER` → `model_call`; `TOOL` → `tool_call`; `AGENT`, `CHAIN`, `RETRIEVER`, `GUARDRAIL`, `EVALUATOR` → `agent_step` |
| `otlp.genai` | spans with GenAI semantic-convention attributes (`gen_ai.*`), and the DELTA `gen_ai.client.token.usage` histogram | `chat` and friends → `model_call`; `execute_tool` → `tool_call`; `invoke_agent` → `agent_step`; token-usage points → `usage` |

Claude Code reports each model request three times — as a log event, as an
`llm_request` span and inside its token and cost metric points. Only the log
event is translated; its spans and metric points are refused by name
(`OTLP_CHANNEL_NOT_TRANSLATED`), because storing all three would triple every
token and cost the Stats rollups sum. Anything with no translation is refused
by name (`OTLP_NO_TRANSLATION`, `OTLP_METRIC_NOT_TRANSLATED`, ...), never
silently dropped.

**What is never stored.** Span names, status messages, log bodies, prompts,
responses, tool arguments, exception messages, addresses and organization ids
are read past and never kept. A user identifier is kept only as a pseudonym;
session, request and tool-call ids are pseudonymized as on the native path; W3C
trace and span ids are kept as sent.

**Measurements are exact or refused.** A token count, cost or duration is
stored as the exact number the producer sent. A value that cannot be stored
exactly — `NaN`, an infinity, a 64-bit integer beyond 2^53, a decimal string
that does not read back to itself — refuses the record by name
(`OTLP_MEASUREMENT_NOT_EXACT`); it is never rounded to something close.

**Identity and replay.** OTLP log records and metric points carry no stable
event id, so a translated record is keyed on a digest of the record **as
stored** (design §4.3's content-hash arm), within its Connector. A re-sent
export stores nothing new. The caveat §4.3 names applies: two records identical
in every stored field — including their source timestamp — are stored once and
the second counted as a duplicate. Spans never collide in practice: their trace
and span ids are part of the stored record.

**The answer.** OTLP/HTTP's own contract, in the request's encoding: `200`
with an empty `Export<Signal>ServiceResponse`, or with `partial_success`
carrying the rejected count and the refusal codes when some records were
refused. `415` for another media type, `400` for a body that is not the
message, `413` for more than 1000 records, `429` with `Retry-After` when the
receiver limit refuses, and `503` with `Retry-After` when the ingest pipeline
itself is unavailable — the whole export is refused then, so the producer
retries it intact; records stored before the fault deduplicate on the retry.

**Bounds.** Protobuf bodies up to 4 MiB after decompression; OTLP/JSON bodies
are held to the deployment's JSON body ceiling (100 KiB), so prefer
`http/protobuf` for busy producers. One accepted export per signal per second
per principal (`otlp_traces`, `otlp_logs`, `otlp_metrics` are separate
surfaces, added by migration 163), so a producer exporting logs and metrics on
its own schedule does not refuse itself.

**Versions.** The receiver speaks OTLP `v1`. A request to any other version or
signal (`/api/telemetry/otlp/v2/traces`, `/api/telemetry/otlp/v1/profiles`) is
refused with `404` and the advertisement — `acceptedOtlpVersions`,
`acceptedOtlpSignals`, and the envelope's `schemaFamily` and `acceptedMajors` —
and counted on the Connector's adapter-health row, so a producer pinned to a
version this deployment does not speak is visible to the operator. An outpost
that gets this answer should park its spool rather than retry it.
`GET /api/telemetry/discovery` returns the same advertisement, the surfaces and
their bounds before anything is sent.

**Adapter health.** Every OTLP request updates the Connector's `otlp-http` row
on `GET /api/sessions/pipeline-health` (and every native request its
`native-envelope` row): accepted, duplicate and refused records, refusals by
code, records per translation, the producer attributes seen, carried and
dropped (`attributes.dropped` is the decoder's raw count of attribute entries
minus the entries actually stored), unknown versions and majors, clock skew,
and the accepted-version advertisement. Counts and codes only — never a payload
byte.

### OTLP/gRPC ingest — `TraceService`, `LogsService`, `MetricsService` `/Export`

The same receivers over OTLP/gRPC, for exporters configured with
`OTEL_EXPORTER_OTLP_PROTOCOL=grpc` (the OpenTelemetry Collector's `otlp`
exporter, most SDKs' default):

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://<your-board-host>:<published gRPC port>
OTEL_EXPORTER_OTLP_PROTOCOL=grpc
OTEL_EXPORTER_OTLP_INSECURE=true                   # plaintext h2c; see TLS below
OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer <the Connector's rh_ credential>
```

**Turning it on.** gRPC needs HTTP/2 end to end, which the frontend's HTTP/1.1
proxy does not carry, so the backend opens a **second listener** on
`RELAYHALL_OTLP_GRPC_PORT` (unset or empty: no listener; anything that is not a
port refuses the boot). The listener binds only after the boot-time
Access-surface census has passed. With the bundled Compose file, add the opt-in
overlay:

```
docker compose -f docker-compose.yml -f docker-compose.otlp-grpc.yml up -d
```

which starts the receiver at container port 4317 and publishes it on
`OTLP_GRPC_BIND_ADDRESS:OTLP_GRPC_HOST_PORT` (`127.0.0.1:4317` by default).
Without the overlay, setting `RELAYHALL_OTLP_GRPC_PORT` serves it on the
Compose network only — for a collector running beside the backend. The
listener speaks plaintext HTTP/2: beyond loopback or a trusted network, put a
TLS-terminating proxy that supports gRPC in front of it. The board does not
know the published port; `GET /api/telemetry/discovery` says whether this
process is serving gRPC (`surfaces.otlp.grpc.enabled`) and which methods.

**One path, not two.** The listener terminates gRPC — the length prefix,
`identity`/`gzip`/`deflate` message compression, the size bound — and
dispatches the request message, in process, as an `application/x-protobuf`
POST through the production telemetry router to the OTLP/HTTP handler itself.
Everything this page says about OTLP/HTTP holds unchanged: the same
translations, envelopes, store, dedupe identity and quarantine. The same
export sent over either transport stores byte-identical rows, and a re-send
over the other transport deduplicates onto the first.

**Authentication** is the call metadata `authorization: Bearer rh_…` — a
principal credential only, accepted by the same code as REST and MCP
(revocation, expiry, delegation-chain liveness, the transport pin); legacy
service keys, dashboard tokens and session cookies are not accepted. The shared
authorization ceiling applies (`telemetry:write`). The ingress is stamped
`api`, like REST: an `mcp`-pinned credential is refused.

**The answer**, in gRPC's terms with OTLP's partial-success rules:

| outcome | gRPC status |
|---|---|
| accepted, possibly with records refused | `OK`, the `Export<Signal>ServiceResponse` carrying `partial_success` (the same bytes OTLP/HTTP answers) |
| missing or unknown credential | `UNAUTHENTICATED` |
| no `telemetry:write`, a principal refusal (§5.1), a transport pin | `PERMISSION_DENIED` |
| not the export message, more than 1000 records, two messages on the call | `INVALID_ARGUMENT` |
| the receiver limit, or the API-wide per-source limit | `RESOURCE_EXHAUSTED` with a `google.rpc.RetryInfo` delay — retryable |
| a message over 4 MiB after decompression | `RESOURCE_EXHAUSTED` without a delay — not retryable |
| the ingest pipeline unavailable (the whole export refused) | `UNAVAILABLE` with a 30 s `RetryInfo` |
| another OTLP version or signal | `NOT_FOUND`, with the advertisement |
| any other method, or an unsupported `grpc-encoding` | `UNIMPLEMENTED` |

Every refusal carries the receiver's refusal code in the `relayhall-code`
trailer and the advertisement in `relayhall-schema-family`,
`relayhall-accepted-majors`, `relayhall-accepted-otlp-versions` and
`relayhall-accepted-otlp-signals`. The limits are the HTTP receivers' own:
4 MiB per message after decompression, 1000 records, and ONE receiver budget
per signal per principal across both transports — an export over HTTP spends
the same `otlp_logs` surface a gRPC export would.

**Adapter health.** gRPC requests count on the Connector's own `otlp-grpc`
row, beside its `otlp-http` row, with the same counters — including an unknown
OTLP version (`…logs.v9.LogsService/Export`), counted as `unsupported.version`.

### The governed raw store

Raw payloads pass the source's policy tier **before** content-addressing. Every
source is Tier 0 today, so `telemetry_raw_blobs` holds the **redacted** record
and nothing else; the fidelity loss is deliberate and visible, because the
redaction counts travel with the blob.

- **Blob keys are connector-namespaced** — `rhraw/1:<connector>:<sha256>` — and
  the namespace is enforced by a database CHECK that derives the key from the
  row's own owner. A key naming another connector's blob cannot be written, so
  per-source deletion is well defined.
- The blob and its event are written by **one statement**, so an event can never
  point at a blob that was not written, and a blob is never orphaned by an event
  that failed.
- `source.raw_ref` is **receiver-assigned**. A reporter that supplies one is
  refused outright.
- The address covers the **reported** payload: the receiver's own clock and
  policy stamp are stripped first, so two identical reports collapse to one
  blob however far apart they arrived.

### Quarantine

Input the validator refuses is quarantined; input the **policy tier** or the
**descriptor** refuses is not — that is well-formed traffic a deployment
declined, and storing it would let a deployment's own rules fill the plane.

Quarantined rows are Tier-0-stripped **before** persistence. What is kept is a
refusal code, a SHA-256 of the payload so repeats collapse, a SHA-256 of the
source key, and a small object of shapes and sizes. No byte of the payload is
stored, logged, or echoed back to the sender.

- **A per-connector quota per window**, decided in the same statement as the
  write, so a refused budget stores nothing at all.
- **Drop-and-count past the quota**: the refused write is counted, and that
  count is lifetime — a window roll restores the budget but never erases the
  evidence of a flood.
- **A per-connector quarantine-rate alarm**, whose numerator includes the
  dropped attempts — counting stored-only would go quiet exactly when a
  connector is flooding. The server evaluates it every five minutes and logs a
  bounded operational line on **transitions**: raised, cleared, and a
  re-notification every six hours while a flood continues. An every-tick line
  is one an operator filters out, and a filtered alarm is not an alarm.

  Two limits, stated rather than implied. The transition state is per-process
  and in memory, so a restart re-raises a continuing flood once. And there is
  **no governed health surface** — no route, no scope — because a telemetry
  read surface takes a read scope with it, and TW1a does not mint one as a side
  effect of an alarm.

### The platform audit plane — stated, not changed

The audit plane is **metadata-only by rule**: identities, scopes, verbs,
timestamps and object IDs — **never request or response bodies, and never
tool-call arguments**. Any boundary payload retained beyond metadata falls under
the policy tiers and the content gate instead.

The telemetry plane **does not change the audit ledger**. It writes one audit
record of its own — the refusal of a caller who may not report (a direct
`Account → Agent` credential presenting `telemetry:write`) — and that record
carries the refusal code and the identifiers, never the submitted body. There is
an executable control for this: `telemetryAuditNoPayloadBytes.test.ts` plants a
marker in every reporter-controlled position of a request and asserts it reaches
no audit argument, with a positive control that the audit happened at all.

- **Retention:** the audit plane keeps its own policy, which this plane does not
  set and does not shorten. Telemetry's own retention is below and applies to
  the telemetry tables only.
- **Access:** through the existing audit surfaces and their scopes
  (`audit:read` or root). Telemetry adds no audit read path of its own.

### Retention, and how to change it

| what | default | environment variable |
|---|---|---|
| identity-bound Tier 0/1 metadata, at event grain | **90 days** | `RELAYHALL_TELEMETRY_RETENTION_DAYS` |
| governed raw blobs | the same bound, applied at write | *(follows the above)* |
| quarantine rows | **7 days** | `RELAYHALL_TELEMETRY_QUARANTINE_RETENTION_DAYS` |
| the MCP action log (`mcp_action_log`) | the event bound, **90 days** | *(follows the event bound)* |

Both are whole numbers of days, plain digits, between 1 and 3650. **A value the
server cannot honour stops the boot** rather than falling back to the default:
a deployment that believes it set 30 days must never quietly keep 90. A blank
variable is not a misconfiguration — it selects the documented default. The
quarantine bound may not exceed the event bound, because a quarantine that
outlives the accepted plane would be a side channel around it.

An hourly sweep expires each class and writes a **retention receipt** for each
one — including when nothing was due, so an auditor can tell "nothing expired"
from "the sweep did not run". Each receipt records how many rows were examined,
how many were removed, and a SHA-256 over the identifiers of the rows that went,
which is reproducible from those rows if they are ever recovered. Events are
swept before blobs, so an expiring event takes its governed payload with it.
Migration 055's own quarantine rows are never touched by this policy. The MCP
action log is its own receipted class, `mcp_action_log`, swept at the event
bound so a session's log never outlives the session it belongs to (MCP-derived
session data keeps the 90-day retention).

## The projection: presence, Sessions and Stats

Reporters push; the board projects. Once envelope events exist, the Sessions
and Stats pages stop being empty and start rendering a **derived, bounded,
Tier-0 read model** of what was reported. RH-TW1c is that
read model, and this section is its contract.

### Derived, with no projection table

There is no projection table, no materialized view and no background projector.
Every figure on those pages is a `SELECT` over `session_events`, riding the two
partial indexes migration 111 created for exactly this purpose
(`idx_session_events_envelope_grouping`, `idx_session_events_envelope_presence`,
both partial on `schema_version IS NOT NULL`, so the migration-055 hermes rows
never enter them). TW1c therefore adds **no migration of its own**; its reserved
number stays reserved and unwritten in `backend/src/migrations/RESERVED`.

Being derived buys one property outright: **replaying a batch moves nothing.**
The write path dedupes on `session_events.idempotency_key`, so a replayed
envelope inserts no row, so nothing downstream can drift. That is measured, not
asserted — `telemetryProjectionAuthorization.test.ts` snapshots every surface,
replays the whole spool through the production route, and compares.

### The four routes, and who may read them

| Route | Answers |
| --- | --- |
| `GET /telemetry/presence` | one row per telemetry source, with its state |
| `GET /telemetry/sessions?includeShort=&connectorId=&sourceProduct=&limit=&offset=&windowDays=` | one page of sessions, Tier-0 metadata only; short sessions hidden and counted unless `includeShort=true` (see [Short sessions, filters and paging](#short-sessions-filters-and-paging)) |
| `GET /telemetry/sessions/:sessionRef?connectorId=&sourceProduct=` | that session plus its bounded timeline |
| `GET /telemetry/stats` | usage / model / cost rollups and adapter coverage |

**Scope ceiling.** They ride `services:read`, an existing read scope. The
telemetry design (§5.3) is explicit that "Tier 0/1 events and rollups ride
existing read scopes", and the object these surfaces are about IS a
services-registry row: a Connector is a `services` row with
`kind = 'connector'`. There is still **no `telemetry:read`** — A17.7's condition
was that none exists until a dedicated read surface does, and a surface existing
is leave to ask for the scope, not licence to mint one.

**Row narrowing.** The ceiling is not the whole answer. `TelemetryReadScope`
narrows every read to a subtree:

- `root` — the A12.1 sentinel — reads every source;
- every other caller reads only sources whose `account_id` is the Account at
  the head of its own authenticated chain.

The scope is a **required first parameter** of every projection method. There
is no unscoped overload and no `{ kind: 'all' }` member, so an unnarrowed read
is not expressible; a caller the derivation cannot place gets `null`, which the
route turns into a 403 rather than a wide read.

**A session is a TRIPLE, and the point route takes all three.**
`session_ref` is `HMAC(domain, product|seed)` — namespaced by the product but
**not** by the Connector — so two Connectors under one Account reporting the
same product and the same source-side session id share a pseudonym. The
identity is therefore `(connectorId, sourceProduct, sessionRef)`, all three
required; an incomplete key, or a `sourceProduct` outside the **ingest product
grammar** (imported from the envelope validator, not restated), is refused with
`INCOMPLETE_SESSION_KEY` before any row is read. The estate-wide session and
source totals count that composite grain with a row constructor, so the totals
and the rows on the page cannot disagree: `stats.totals.sessions` equals the
Sessions list's `total` with short sessions shown, and `stats.totals.shortSessions`
equals its `shortCount` (both are asserted live).

**The Account NARROWS a read; it never KEYS an identity.** A source is
`(connector, product)` and a session is that triple — the Account is not a
member of either. It appears in the `WHERE` clause of every read and in no
`GROUP BY`, and reaches the caller as a derived attribute of a source (the
newest row's). This matters for a Connector that is **re-parented**: its stored
rows then carry two `account_id` values under one advertised identity. Grouping
by the Account split that identity into rows nothing public could tell apart —
the row shape, the point route, the cache key and the DOM id are all the triple
— left the older one unaddressable, and made the totals disagree with the list
they sit above. Narrowing gives each Account its own half and root the whole,
with one row either way.

**Every read is narrowed, and there is only one read to narrow.**
`FROM session_events` is written **once** in the projection, inside a helper
that takes the rendered narrowing as a required first parameter and emits it
before any caller-supplied predicate. An unnarrowed read is therefore not
expressible rather than merely absent, and the gate asserts a fact about the
source — one occurrence — instead of counting narrowings against reads. That
count is what two earlier controls did, and each was satisfied by moving
predicates between reads while one stayed open.

**Reporter-frame ownership follows the CHAIN HEAD.** A Connector's frame is
shown to the Account at the head of its current chain — a recursive walk of
`parent_principal_id` at the ratified depth, which is the resolution write
attribution uses. One hop is not that walk: migration 096's chain-shape trigger
validates a Connector when the Connector is written and never revalidates it
when its parent later gains a parent, so a Connector can sit two hops below its
Account with `parent_principal_id` naming an intermediate.

**A point route is not an existence oracle.** A `sessionRef` belonging to
another Account, a well-formed key naming no row, and a right pseudonym with
the wrong Connector or product all answer identically — same status, same code,
same message.

### The states

Presence speaks the **shipped C7 chip vocabulary** and does not extend it:

- `stale` — nothing observed inside `TELEMETRY_STALE_MS` (nine minutes, the
  shipped constant, imported rather than copied);
- `idle` — the newest event reported the `waiting` phase;
- `active` — anything else that is fresh.

Age is tested **first**. A source that stopped mid-`running` is stale, never
active: silence outranks the last thing it said, which is the entire point of a
derived window. For sources that emit no C7 frames at all, this synthesis is
what keeps them from being permanently stale (§10.1).

A session row adds a fourth word, `finished`, and tests it **before** age: a
session the source reported `completed` an hour ago is finished, not stale.
`active | idle | stale | finished` are four of the seven labels the shipped UI
already paints. The other three are unreachable here and say so: `orphan` is a
lease conclusion and a reporter session holds no lease; `unknown` and `none`
describe the absence of a session, and a row exists only because events were
stored under it.

### What is beside the state, and not folded into it

A Connector's own C7 frame is shown next to its sources as **reporter-process**
liveness. It is deliberately not merged into the source state: a frame carries
no `source.product`, so it proves the reporting process is alive and cannot say
*which* source is. Folding it in would let one live reporter paint every product
it ever reported as active, including one that died an hour ago.

### Bounds

Every read carries a time window (7 days by default, 90 maximum), a row limit
(50 by default, 200 maximum) and — for the timeline — an event limit (200 by
default, 500 maximum). A request may narrow any of them and can widen none: the
clamp takes a minimum against a module constant. A truncated timeline says so
rather than looking complete.

### Short sessions, filters and paging

The Sessions list
shows fifty rows by default, newest first. When the task bridge's MCP sessions
arrived at about sixty an hour, each a bootstrap, one heartbeat and a
completion with nothing else, those fifty rows held under an hour and the
reporter sessions fell off the page. The list therefore hides **short**
sessions by default, on the server, and says how many it hid.

**What "short" means.** A session is short when ALL of these hold over its
events inside the requested window and filters (the same events its row's
columns count):

- at most **3** events (`TELEMETRY_SHORT_SESSION_MAX_EVENTS`);
- last seen **less than 2 minutes** after it started, on the receiver clock
  (`TELEMETRY_SHORT_SESSION_MIN_DURATION_MS`); exactly two minutes is not short;
- **no model**: no `model_call` event and no event naming a model provider,
  requested model or resolved model. The Models column reads the resolved
  model from any event kind, so a session that shows a model is never short;
- **no tokens**: input tokens and output tokens both sum to zero. Both, rather
  than their sum, because the Tier-0 engine admits negative numbers.

So a session with a model, with tokens, with a fourth event, or lasting two
minutes or more is always listed. Classification uses in-window events only, so
a long session whose earlier events fell outside the window can classify as
short; the window is not widened to avoid that.

**Hidden before the row limit, counted exactly.** The rule is written once, as
the `grouped` and `classified` CTEs that both the list and the Stats split use.
The list's `page` CTE drops short sessions **before** its `ORDER BY`, `LIMIT`
and `OFFSET`, so a page is always the newest shown rows and never what was left
after a cut. A `tally` CTE in the same statement counts the uncut classified
set, so the counts describe exactly the set the page was cut from. The answer
carries:

| Field | Meaning |
| --- | --- |
| `sessions` | this page's rows |
| `hiddenCount` | short sessions withheld from this list (`shortCount`, or 0 with `includeShort=true`) |
| `shortCount` | short sessions in the window and filters, shown or not |
| `total` | rows the list holds under the current filters and toggle, across every page |
| `offset`, `limit`, `nextOffset` | this page, and the next page's offset (`null` on the last page) |
| `windowDays`, `windowStart`, `includeShort` | what was asked |
| `shortSession` | `{ maxEvents, minDurationMs }`: the rule as applied, which the page states in words |

`includeShort=true` (exactly that word) lists short sessions too. Nothing is
deleted or relabelled: retention is unchanged (MCP-derived rows keep their 90
days), and a short session's **deep link** still opens it,
because the point route has no short filter.

**Filters.** `connectorId` (a UUID) narrows to one reporting Connector and
`sourceProduct` (the ingest product grammar) to one product: the names the
point route uses for the same two members. A malformed filter is refused with
`INVALID_SESSION_FILTER` before anything is read. A well-formed filter is one
more predicate on the one grouping read, **after** the caller's narrowing, so
it can only narrow what the caller could already read: a filter naming another
Account's Connector reads nothing and answers exactly as one naming no
Connector at all.

**Paging.** `limit` (50 by default, 200 at most) and `offset` (rows to skip,
rounded down; anything that is not a positive number reads the first page).
The order is total, last seen first, then the Connector, the product and the
session reference ascending, byte-wise (`COLLATE "C"`), so an offset page
cannot repeat or skip a row that tied on its last-seen time. The offset has no
ceiling of its own because it widens nothing: the window and the narrowing
bound the scan and the limit bounds the page.

**Stats count every session, and say how many are short.** Stats is the
accounting surface and has no toggle, so its totals stay what they were: every
session and every event received in the window, short ones included.
`totals.shortSessions` and `totals.shortSessionEvents` give the short share from
the same classified set, and the page labels the Sessions and Events figures
with it ("Includes N short sessions ..., which the Sessions page hides by
default"), also when it is zero. Tokens, the model mix and cost cannot differ
either way: a short session has no model and no tokens by definition. The
Reporting-sources cards and the Adapter coverage table count every session too;
presence is unchanged.

**The plugin bridge is unchanged.** `rh.plugin.bridge/1`'s `telemetry.sessions`
still carries an array of every session (up to 200), short ones included: the
default hiding is a view of the Sessions page, and changing what a plugin
receives would be a contract revision.

### Tier 0, and no transcripts

Nothing on these routes is content. Tier 0 stores none — §6.3 is "default OFF
per source" and the policy engine nulls all four content references — so the
Sessions page has no transcript pane and nothing on it opens into one. Session
grouping travels as `session_ref`, a keyed-HMAC pseudonym; the reporter's own
conversation identifier never leaves the ingest path. Cost is reported with its
**basis** in visible text (`provider` or `estimated`, never `reconciled`, which
only a reconciliation receipt can produce), and coverage labels the reporter did
not send read `unstated` rather than being guessed at.

The transcript surface, the `telemetry-contents:read` selector and its per-read
audit are TW5 scope. Nothing here anticipates them.

### Live updates are a poll, on purpose

The pages re-read on an interval with the query client the app already ships.
They do not subscribe. The ratified §2.6.5 rule is that ingest "writes
`telemetry_frames` and nothing else — no task writes, no lease renewal ..., no
feed emission", and a WebSocket push for presence would have to be emitted from
exactly the path that rule forbids. So presence is pulled, and the ingest
contract is untouched.

**The poll refreshes the loaded window**. With "Load more" the
Sessions list holds several pages. Every 20 seconds it re-reads every loaded
page, in order from the first, taking each next offset from the page just
re-read. The page therefore shows the newest (pages × 50) rows under the
current filter and toggle, keeps the number of loaded pages (fewer only when
the list itself shrank), and shows each session once, by its triple. A poll
never changes the Reporter or Product choice, the toggle, or an open timeline;
only the reader changing the filter or the toggle starts again from the first
page. A row that moves between two pages while they are re-read appears in its
new place on the next poll. The filter is page state, not part of the URL:
`connectorId` and `sourceProduct` in the URL are the deep link to one session.

### Gates

| Gate | What it measures |
| --- | --- |
| `src/__tests__/telemetryProjectionContract.test.ts` | one read of `session_events` in the whole module, and each rendered read opens with the narrowing; the Account is in no `GROUP BY`; the frame arm is the chain head at the ratified depth; the bounds are narrow-only; the vocabulary is the shipped one; the short filter sits in the page ahead of its `ORDER BY`, `LIMIT` and `OFFSET`, the counts read the uncut set, the rule is written once, the filters bind as parameters after the narrowing, and the order is total |
| `npm run test:telemetry-projection` | Accounts through the production router against a real PostgreSQL: containment, the expected set read back from the point route, indistinguishability, root, replay idempotency, a **re-parented** Connector's one triple, a Connector **two hops** below its Account, and nine shaped short/long fixtures: hidden by default with an exact `hiddenCount`, the four boundaries (a model, tokens, a fourth event, exactly two minutes), a page smaller than the hidden rows, `includeShort`, the filter, the offset walk, the deep link, concealment, root, the malformed-filter refusal and the Stats split |
| `npx tsx scripts/tw1c-projection-mutation-drill.ts` | twenty-one mutations, each required to redden the assertion named for it — one per round-1 blocker, one per round-2 finding, and one per way the short-session list can go wrong (M14-M21). Collateral reds are printed and counted, not required to be absent |
| `python3 scripts/check-workflow-shape.py` (+ its control) | every workflow parses, has no duplicate keys, declares an `on:` trigger that NAMES EVENTS (a string, a list of them, or a mapping keyed by them — truthiness is not the test), and every step carries exactly one of `run`/`uses` as a non-empty string — the CI-silence class, for every lane |
| `src/pages/telemetryProjectionPages.test.tsx` | loading / error / empty never conflated; `<time>` via `utils/dateFormat`; axe-core with zero violations; the toggle, the filter and "Load more" send what they mean, a poll keeps the filter, the toggle, the pages and an open row, and Stats label the short share |
| `npm run test:mcp-derived-sessions` | MCP-derived sessions through the production MCP server and router against a real PostgreSQL: one row per bootstrap for the caller only, one heartbeat per bucket (under concurrency too), the Task link set and cleared under the CALLER's principal, a taskId brief linking a held Task inside one bucket, a brief-named switch between two held Tasks that survives the following reconciles, stale / finished by clock, two Accounts' Connectors kept apart, A17.7 unchanged, a whole-schema diff that moves only the telemetry tables, and nothing for a tier-`none` or unregistered caller |
| `src/__tests__/mcpSessionTelemetry.test.ts` | the cadence against the shipped windows, every built record through the real validator and Tier-0 engine with no credential surviving, the chain short-cut equal to the ratified derivation's refusals, and the start / heartbeat / end / link decision table (including the switch between held Tasks) |
| `src/__tests__/mcpActionLog.test.ts` | the action log at unit scope: the per-tool target allowlist against the real registry (every unlisted tool records no target with a UUID in every argument), the closed error codes from class and status only, no argument or message in a row or a log line, the in-flight bound, the session wiring, the per-row narrowing of the read, and the code's vocabularies equal migration 161's CHECKs |
| `npm run test:mcp-action-log` | the action log through the production MCP server and router against a real PostgreSQL: one row per call under the caller's session, the closed code, a secret marker in the arguments found elsewhere and never in the table, no target for an unlisted tool, the owner's read on the point route, the same 404 for another Account, the per-row narrowing, the sweep at the bound with its receipt, nothing for a tier-`none` caller or a refused call, and a failed log write that never fails the tool |
| `python3 scripts/mcp-action-log-mutations.py` | five controls, each red at exactly its declared tests: arguments stored, a non-allowlisted target accepted, an allowlisted tool reading another argument, the visibility check dropped, and a sweep that ignores its bound |

## MCP-derived sessions

Most agent work on a board arrives over MCP, from harnesses that run no
reporter — a hosted connector cannot run one at all without a second
credential. So the MCP server records each admitted tool call as the
**caller's own** Tier-0 session activity, written through
the same two write paths the reporters use, into the same tables. Nothing new
is read by the pages: the rows are ordinary envelope rows and C7 frames.

### What is recorded

| When | What is stored | What the page shows |
| --- | --- | --- |
| `relayhall_brief_compile` with `session: true` succeeds | one `kind: session`, `phase: started` envelope for the new bootstrap epoch | a new row, `active` |
| any other admitted tool call inside a live epoch | one `phase: running` envelope per heartbeat bucket | the row stays `active`; "Last seen" moves |
| no call for nine minutes (`TELEMETRY_STALE_MS`) | nothing — the state is derived | `stale` |
| the same credential bootstraps again, or its bootstrap has lapsed and it calls again | one `phase: completed` envelope for the previous epoch | the old row `finished` |
| the caller holds a Task in progress | an `active` C7 status frame naming that Task, under the caller's principal | the Task's liveness chip reads Active |
| the caller stops holding it (release, finish, a move out of In Progress) | one `idle` frame for that Task | the chip reads Idle, then Stale |

Every row carries `source.product = mcp`, adapter `relayhall-mcp`, and the
Connector's display name on the page. The Sessions table now has a
**Reporter** column for exactly that reason: without it, two Connectors' MCP
sessions would be indistinguishable rows. A row's `adapter_version` is the
version the board reports, verbatim, where the telemetry version grammar
admits it; an unreleased build's `<version>+unreleased` with a prerelease
does not fit that grammar, so the field is left out rather than rewritten.

**There is no time-derived idle.** The page's `idle` is still the explicit
`waiting` signal, and an MCP session never sends one. A session that goes
quiet reads `stale` after the shipped window, and one that ended reads
`finished`. The derivation is the shipped one, unchanged; nothing runs in the
background to flip a state.

### What a session is

The MCP surface is stateless and keys nothing on a protocol session
identifier, so an MCP-derived session is a **bootstrap epoch**: from the
moment a credential pulls its session brief to the moment it pulls the next
one (or its twelve-hour bootstrap lapses). The seed is the credential plus
that moment, and it is stored only as the keyed-HMAC `session_ref` — no
credential identifier lands in any row. Several harness sessions sharing one
credential therefore share one epoch: each new bootstrap finishes the
previous row, and their heartbeats land on the newest.

**Many MCP sessions are short, and the Sessions list hides them by default.**
An epoch that did nothing but bootstrap, heartbeat once and end at the next
bootstrap is three events, no model and no tokens; when that next bootstrap
comes within two minutes it is a [short session](#short-sessions-filters-and-paging),
counted and hidden until "Show N short sessions" is pressed. Two consequences,
stated rather than hidden: an epoch followed by a gap of two minutes or more
before the next bootstrap is NOT short (its completion is stamped at that next
bootstrap) and stays listed; and a session that has only just bootstrapped
counts as short until its fourth event or its second minute. Retention is
unchanged.

### The heartbeat bound

At most one heartbeat per session per **sixty-second bucket**. The bucket is
the `source_sequence` of the envelope's `(stream_generation, source_sequence)`
identity, so every further call in the same bucket collides with the
migration-055 UNIQUE `idempotency_key` and stores nothing — atomically,
deployment-wide, with no limiter row and no migration. Buckets are fixed, not
sliding: two heartbeats can land seconds apart across a bucket edge, never
two inside one bucket. Sixty seconds is chosen against the shipped windows,
and the unit suite asserts it against the imported constants: the worst gap
between stored heartbeats (just under two buckets) is well inside the
nine-minute staleness window, the bucket is above the five-second frame gate,
and it caps a session that never stops at 1,440 heartbeat rows a day under
the 90-day retention.

### Who is shown, and as whom

- **Identity is the caller's chain.** The binding comes from
  `TelemetryPrincipalService.derive` over the calling credential's
  authenticated chain — the ingest derivation, reused unchanged — and a link
  frame's owner is the acting principal. No tool argument is read for
  identity, and A17.7 is untouched: the ingest route still refuses any frame
  that names an owner.
- **Consent is the descriptor tier.** A Connector whose current descriptor
  declares tier `none`, or no tier, is refused by that derivation and nothing
  is written for it — no row, no frame, no audit record (the audited refusal
  belongs to the ingest route, where a reporter asked to write). The same goes
  for an Account-plane credential, a direct `Account → Agent` chain and a
  legacy parentless Connector. Declaring a tier is publishing a descriptor
  version, as it is for reporters.
- **`telemetry:write` is not required.** That scope gates *ingest* of
  reporter-supplied data. Here nothing is supplied: the board writes what it
  observed of its own surface, under consent the descriptor already carries.
  Requiring the scope would ask an MCP-only client for a second credential.
- **The product allowlist is not consulted for `mcp`.** The descriptor's
  product list bounds what a REPORTER may assert at ingest; the `mcp` key is
  written by the server. One consequence, stated rather than hidden: a
  reporter that itself declares `mcp` in its own product list can send
  envelopes into its own `(Connector, mcp)` source. It can only ever reach its
  own rows.

### The Task link

The link is the existing C7 Task-to-telemetry linkage — `telemetry_frames.task_id`,
read by the Task's liveness chip. **Which Tasks may be linked** is derived
from board state on every reconcile: the Tasks the caller holds as Assignee
with status In Progress. A brief for a Task the caller does not hold links
nothing, so browsing many Tasks paints none of them. **Which one is linked**
is, in order:

1. the Task the current call names, when the caller holds it;
2. otherwise the link already shown — the caller's own most recently set
   `active` link frame — while the caller still holds that Task;
3. otherwise the held Task updated most recently.

`relayhall_brief_compile` with a `taskId`, `relayhall_task_claim`,
`relayhall_task_release`, `relayhall_task_move`, `relayhall_task_finish`,
`relayhall_lease_claim` and `relayhall_lease_release` name a Task and
reconcile at once; every new heartbeat bucket reconciles too. So a taskId
brief for a held Task links it immediately, without waiting for the next
bucket, and with several Tasks held the link follows the one the session last
named: a taskId brief (or a claim or move) naming another held Task moves the
link there, and it **stays** there while that Task is held, whatever
`updated_at` says — a brief does not touch `updated_at`. The shown link is
the only preference carried from one call to the next, and the frame that set
it carries it; there is no other state.

Each reconcile writes at most one frame, because the shared five-second frame
gate admits one per interval, in this order: a shown Task the caller no
longer holds is cleared with one `idle` frame; a desired Task that is not
shown is set `active`; a held Task that is shown but no longer desired is
cleared with `idle`; the desired link is refreshed once per bucket. A switch
between two held Tasks therefore sets the new link first and clears the old
one at the next reconcile, so for up to one bucket both chips read Active —
both Tasks are held In Progress, so neither reading is false.

A clear or a set that the frame gate refuses is retried at the next
reconcile, because both follow from board state. A **switch** the gate
refuses is not: nothing but its frame would have remembered which held Task
was named, so the link stays where it was until the brief is compiled again
more than five seconds after the previous frame. The live suite pins all
three: the immediate link, the switch that survives, and the refused switch
that waits for the next brief.

The Sessions page shows no linked-Task column: that would put Task identity
on a `services:read` surface.

A link frame is a frame of the caller's principal, so for a Connector it also
appears as the "Reporter process" line beside that Connector's other sources
(see above) — while the Connector is linked, that line is live.

### What it changes, and what it costs

Only the telemetry tables: `session_events` and `telemetry_raw_blobs` (through
`TelemetryEnvelopeStore.store`), `telemetry_frames` and `telemetry_rate_limits`
(through `TelemetryService.ingest`), and `mcp_action_log` (through
`McpActionLog`, see [the action log](#the-action-log)). No Task write, no lease renewal, no feed
event, no audit row. The live suite diffs the whole schema around a call to
prove it. The observation never throws, never changes a tool's result, holds
no transaction across the tool, and logs only a bounded secret-free warning to
stderr. Each call costs a few small reads (the caller's chain, the registry
and descriptor, the bootstrap record) and one insert that is usually a
duplicate; link reads happen only on a linking call or a new bucket, and
read the caller's own Tasks In Progress and its own link frames (newest per
Task, inside the frame retention window).

Stats counts these sources and their session events in its totals and
coverage, like any other source; MCP-derived rows carry no model, tokens or
cost.

### The action log

The board keeps a per-session **action log** of MCP board calls —
"tool, target, outcome, time; never arguments" — as Telemetry scope. Every
admitted `tools/call` made inside a live MCP-derived session adds one row to
`mcp_action_log` (migration 161):

| column | what it holds |
|---|---|
| `session_ref`, `connector_id`, `account_id`, `agent_id` | the session and its owner, exactly as the session's envelope rows carry them (derived from the caller's chain, never from an argument) |
| `tool_name` | the registry name of the tool; the writer admits only names the registry holds |
| `target_type`, `target_id` | one of `task`, `report`, `phase`, `project`, `skill`, read ONLY from that tool's allowlisted argument (`MCP_ACTION_TARGET_ARGUMENTS` in `services/McpActionLog.ts`) and only when it is a complete UUID; otherwise none |
| `outcome`, `error_code` | `ok`, or `error` with one closed code: `tool_refused` (the tool refused before or without the board), `bad_request`, `unauthenticated`, `forbidden`, `not_found`, `conflict`, `rate_limited`, `rejected`, `unavailable`, `server_error`, `internal` — from the error's class and the board's HTTP status, never its message |
| `duration_ms`, `observed_at` | the handler's duration and when the board recorded the call |

There is no column for arguments or free text, so nothing needs redacting: an
argument value, an argument name, an error message or a tool result never
reaches the row builder. The write is **fire-and-forget**: it happens after the
tool answered, at most eight writes are outstanding at once (a further row is
dropped and counted), each insert carries a two-second query timeout, and a
failed write logs one rate-limited warning that names a category, class and
code only. A failed or dropped write never fails or slows the tool call.

**What is not recorded.** REST and CLI calls made with the same credential do
not pass through the MCP server and are not logged; the page says so. A call
outside a live session records nothing: a Connector that declared no telemetry
tier, an Account-plane credential, a call the bootstrap gate refused, and an
introspection call after the bootstrap lapsed. Full transcripts stay parked.

**Who sees it.** The rows ride the session's own point read,
`GET /telemetry/sessions/:sessionRef?connectorId=…&sourceProduct=mcp`, as
`actions` (newest first, cut at the timeline's event limit, with
`actionsTruncated`). They are read only after the session itself resolved under
the caller's narrowing — a session another Account owns answers the same 404
with nothing in it — and every row is narrowed again by its own `account_id`,
so a Connector that changed Accounts mid-session shows each Account only the
rows written under it. No route, scope or visibility rule was added. On the
Agent sessions page an `mcp` session's expanded timeline lists them under
"MCP tool calls", with an empty state when there are none.

**Retention.** Swept hourly as class `mcp_action_log`, with a receipt, at the
event bound (`RELAYHALL_TELEMETRY_RETENTION_DAYS`, 90 days by default).

## What was removed, and why the pages are empty

RH-P1.3 removed the board-side observation stack: the gateway WebSocket
client, sessions-file/transcript ingesters and watchers, harness status
probes, transcript-scraping analytics, and the board-side model-switching
endpoints. The Sessions and Stats pages remain core, always-on surfaces that
render an empty state pointing at this document until reporters feed them —
and, since RH-TW1c, render the projection described above once reporters do.
The empty state is still the zero-config default and still means exactly what
it says: no reporter is installed, and no Connector that declared a telemetry
tier has worked through the board's MCP server inside the window. A read a caller is not authorized for is
rendered as a refusal, never as the empty state.

The DB tables the canonical pipeline writes to (`sessions`, the canonical
attempt/event/health tables) stay in the schema, dormant — they are the
landing zone for Phase-3 reporter ingest.

## Related

- `docs/seams.md` — the deployment seams, including the telemetry /
  reporter-ingest seam.
