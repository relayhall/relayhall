# Observability: the reporter model

RelayHall's observability rests on one rule (strategy F11):

> **The board never observes. Connectors report.**

The board holds no connection into any agent runtime. It does not read
sessions files, watch transcript directories, probe harness binaries, or
scrape local state. Everything the Sessions and Stats pages show arrives
because a **reporter** chose to send it.

## The pieces

### Outposts (the reporters)

A reporter — an **outpost** — runs *next to* an agent runtime and pushes
session activity to the board over the typed ingest contract. An outpost is not
a plugin: a plugin installs into the board deployment, an outpost runs beside
someone else's runtime, and that difference is the trust boundary (`b94dd86e`,
D-14). The board is a passive recipient: it stores what reporters send,
verifies idempotency and cursor ordering, and renders it.

No reporters installed means the Sessions and Stats pages render their
documented empty state. That is the zero-config default, not an error.

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
nothing else on the board. The batch contract file is kept in core so
reporters and a future ingest surface are built against the same types. The
retired reference implementation (`OpenClawCanonicalAdapter`, a board-side
adapter from the pre-F11 architecture) is recorded in `docs/design-history/`.

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
Migration 055's own quarantine rows are never touched by this policy.

## The projection: presence, Sessions and Stats

Reporters push; the board projects. Once envelope events exist, the Sessions
and Stats pages stop being empty and start rendering a **derived, bounded,
Tier-0 read model** of what was reported. RH-TW1c (card `50e74c1d`) is that
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
| `GET /telemetry/sessions` | one row per session, Tier-0 metadata only |
| `GET /telemetry/sessions/:sessionRef?connectorId=&sourceProduct=` | that session plus its bounded timeline |
| `GET /telemetry/stats` | usage / model / cost rollups and adapter coverage |

**Scope ceiling.** They ride `services:read`, an existing read scope. Design
`7d5c0cdc` §5.3 is explicit that "Tier 0/1 events and rollups ride existing read
scopes", and the object these surfaces are about IS a services-registry row: a
Connector is a `services` row with `kind = 'connector'`. There is still **no
`telemetry:read`** — A17.7's condition was that none exists until a dedicated
read surface does, and a surface existing is leave to ask the sitting for the
scope, not licence to mint one.

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
and the rows on the page cannot disagree.

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

### Gates

| Gate | What it measures |
| --- | --- |
| `src/__tests__/telemetryProjectionContract.test.ts` | one read of `session_events` in the whole module, and each rendered read opens with the narrowing; the Account is in no `GROUP BY`; the frame arm is the chain head at the ratified depth; the bounds are narrow-only; the vocabulary is the shipped one |
| `npm run test:telemetry-projection` | Accounts through the production router against a real PostgreSQL: containment, the expected set read back from the point route, indistinguishability, root, replay idempotency, a **re-parented** Connector's one triple, and a Connector **two hops** below its Account |
| `npx tsx scripts/tw1c-projection-mutation-drill.ts` | thirteen mutations, each required to redden the assertion named for it — one per round-1 blocker and one per round-2 finding. Collateral reds are printed and counted, not required to be absent |
| `python3 scripts/check-workflow-shape.py` (+ its control) | every workflow parses, has no duplicate keys, declares an `on:` trigger that NAMES EVENTS (a string, a list of them, or a mapping keyed by them — truthiness is not the test), and every step carries exactly one of `run`/`uses` as a non-empty string — the CI-silence class, for every lane |
| `src/pages/telemetryProjectionPages.test.tsx` | loading / error / empty never conflated; `<time>` via `utils/dateFormat`; axe-core with zero violations |

## What was removed, and why the pages are empty

RH-P1.3 removed the board-side observation stack: the gateway WebSocket
client, sessions-file/transcript ingesters and watchers, harness status
probes, transcript-scraping analytics, and the board-side model-switching
endpoints. The Sessions and Stats pages remain core, always-on surfaces that
render an empty state pointing at this document until reporters feed them —
and, since RH-TW1c, render the projection described above once reporters do.
The empty state is still the zero-config default and still means exactly what
it says: no reporter is installed. A read a caller is not authorized for is
rendered as a refusal, never as the empty state.

The DB tables the canonical pipeline writes to (`sessions`, the canonical
attempt/event/health tables) stay in the schema, dormant — they are the
landing zone for Phase-3 reporter ingest.

## Related

- `docs/seams.md` — the deployment seams, including the telemetry /
  reporter-ingest seam.
- `docs/design-history/` — retired architectures, including the board-side
  observation stack this model replaced.
