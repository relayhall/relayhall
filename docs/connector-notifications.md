# Connector event notifications

Connectors may subscribe to `wss://<board>/api/events/ws?cursor=<saved cursor>`
with their own principal credential in the `Authorization: Bearer ...` header.
The backend path is `/events/ws`; the dashboard's `/ws` is a separate surface.
Cookies, dashboard JWTs and URL tokens are not accepted here. Use a WebSocket
client that can set headers. Never put a credential in a URL or command argument.

This is an optional latency optimization over authoritative `GET /events`.
It does not change a Connector's delivery mode, assign work, extend a Lease,
claim a Task or execute instructions. A consumer still reads the current Task
and follows ordinary claim, lease and lifecycle operations. A notification
does not grant authority to its named object.

The API transport stamp and canonical principal/delegation acceptance apply.
Credentials need the same `tasks:read` route scope as `GET /events`, and an
`api` or `any` transport pin. Every batch uses `FeedEventService.listSince`,
including its current object-grant, delegation and tombstone rules.
Authentication is rechecked before each batch and again after its read.
Revoked credentials, expired delegation and missing scope close the stream.
No socket joins the unfiltered dashboard broadcast bus.

The server checks the feed every second, at most 200 ledger rows per read,
and sends a JSON frame:

```json
{"type":"events","events":[],"nextCursor":"123"}
```

Event objects have the same content-free shape as `GET /events`.
An empty frame can advance the cursor past events concealed from this caller.
Persist `nextCursor` only after processing the complete frame. Dedupe events
by their cursor: reconnects can redeliver a frame whose processing completed
before the saved cursor was committed. The cursor is a nonnegative PostgreSQL
bigint expressed as a decimal string; omission starts at zero. The stream is
receive-only, except that an enabled wake socket (below) may send `wake.ack`
frames and, on protocol 2, `wake.outcome` frames, and nothing else. Reconnect
to change a cursor or credential.

On disconnect, reconnect with bounded exponential backoff and jitter, using
the last successfully processed cursor. Keep a periodic authoritative
`GET /events?cursor=...` polling reconciliation loop; use polling when the
proxy/client cannot upgrade or the stream is unavailable. Both transports
share one processing/checkpoint sequence, so an old socket frame must never
move a checkpoint backward. Do not reset the cursor to zero on a transient
failure, and do not treat receipt of an event as completion of work.

Each server process permits at most 128 connected/pending sockets, 16 pending
authentications, and four open sockets per principal. Frames and outgoing
queues are bounded; slow clients or oversized batches close with 1013 and
should resume through polling (with a smaller page if necessary). Policy
refusals close with 1008; a feed failure closes with 1011. No internal error
or credential is included in those reasons. The reverse proxy disables access
logging on this endpoint and forwards the Authorization header. Infrastructure
outside that proxy must also avoid logging authorization headers.

## Wake

A Connector that wants to be woken when work is assigned to it subscribes
with `?wake=1` or `?wake=2` (the only accepted values; `cursor` may be
combined with either). Protocol 1 is described first and is unchanged;
protocol 2 adds the `verify` and `stuck` kinds and the `wake.outcome` frame
([Wake protocol 2](#wake-protocol-2-verify-stuck-and-the-outcome)):

```
wss://<board>/api/events/ws?cursor=<saved cursor>&wake=1
```

The socket is a wake endpoint only when its credential's principal is the
principal of exactly one **published** Connector in the service registry. The
board says which, once, right after the upgrade:

```json
{"type":"wake.status","enabled":true}
{"type":"wake.status","enabled":false,"reason":"NOT_A_PUBLISHED_CONNECTOR"}
```

Other reasons are `AMBIGUOUS_CONNECTOR`, `WAKE_CAPACITY` and
`WAKE_UNAVAILABLE`. Until the board has sent `"enabled":true`, a `wake=1`
socket is receive-only like any other: it keeps its ordinary `events` frames,
and any frame it sends, `wake.ack` included, closes it with 1008 (`This stream
is receive-only`). That holds for a socket the board refused and for one whose
`wake.status` has not arrived yet, so send nothing before it.

When a Task assigned to the Connector (`tasks.execution_service_id`) becomes
ready (`task.ready`: assigned, `todo`, armed, dependencies satisfied), the
board sends an identifier-only frame on every open wake socket of that
Connector:

```json
{"type":"wake","wakeId":"<uuid>","taskId":"<uuid>","cursor":"<task.ready cursor>","attempt":1}
```

The ready event is read through the Connector's own authority and the
`GET /events` route ceiling, so a wake is only ever sent for a Task the
Connector could already pull. A new endpoint starts at the feed head: the
board never wakes a Connector for readiness that happened before it first
subscribed. A wake is a hint. It assigns, claims and extends nothing; read the
Task and claim it through the ordinary verbs.

Acknowledge on the same socket, with the wake id the board sent:

```json
{"type":"wake.ack","wakeId":"<uuid>","telemetry":{"schema_version":"rh.ai.telemetry/1.0","kind":"session","phase":"started","source":{"product":"<declared product>","adapter":"<adapter>"},"model":{"provider":"<provider>","requested":"<model asked for>","resolved":"<model the provider's response named>"}}}
```

`telemetry` is optional. When present it is one `rh.ai.telemetry/1.0`
envelope and the whole frame must fit in 8 KiB. It is ingested exactly as
`POST /telemetry/events` would ingest it for the same credential: the
envelope validator, the `telemetry:write` route scope, the owning Connector's
declared telemetry tier and product list, the per-principal receiver limit,
then the one envelope store. Put the model the **provider's own response**
named in `model.resolved`; put the model you asked for in `model.requested`.
A frame that is not a well-formed `wake.ack` closes the socket with 1008.
The board processes acknowledgements one at a time, in arrival order, and
re-derives the credential for each. At most 64 may wait on one socket (the
board's limit of in-flight wakes per Connector); one more closes the socket
with 1008. An acknowledgement that names an unknown, already-settled or
never-sent wake settles nothing; more than 16 of them close the socket with
1008. Keep the socket open after acknowledging: an acknowledgement the board
has not yet handed over when the socket closes is discarded, and the wake
keeps its retry schedule, so a Connector that reconnects inside that window
is woken again on its new socket.

**Retry.** An unacknowledged wake is re-sent after 1 s, 2 s and 4 s, and
settles 8 s after the fourth attempt: four attempts, about 15 s. An attempt
that finds no open socket sends nothing but still counts, so a Connector that
reconnects inside that window is woken on its new socket. A settled wake is
never re-sent.

**Receipt.** Every settled wake writes, in one transaction, an audit row with
action `connector.wake.<outcome>` on the Task (`resourceType: task`) and a
`system` Task stream entry with event type `connector.wake`. Both carry the
same receipt: `wakeId`, `outcome`, `serviceId`, `connectorPrincipalId`,
`taskId`, `feedCursor`, `attempts`, `sends`, `firstSentAt`,
`acknowledgedAt`, `latencyMs`, `settledAt`, `fallback`, `taskStatus`,
`modelIdentity`, `reported` and `telemetry`.

| Outcome | When | Audit actor | Telemetry |
|---|---|---|---|
| `acknowledged` | a matching `wake.ack` arrived | the Connector's credential | the acknowledgement's envelope, if any |
| `unanswered` | sent at least once, never acknowledged | `system` | none |
| `offline` | no open wake socket at any attempt | `system` | none |
| `superseded` | the Task stopped being this Connector's ready work first | `system` | none |

`reported` is copied from the acknowledgement's validated envelope and from
nowhere else. `modelIdentity` is `provider-reported` only when
`model.resolved` is present, `requested-only` when the Connector named only
the model it asked for, and `not-reported` otherwise. The board never fills a
model in from a descriptor, an execution profile or a default.
`telemetry.stored` says whether the envelope was stored, and
`telemetry.eventId` names the stored row; when it was not stored, `stage` and
`code` say why (for example `scope` / `TELEMETRY_SCOPE_REQUIRED`). A negative
outcome always carries `reported: null`, `modelIdentity: "not-reported"` and
`telemetry: {"stored": false, "code": "NOT_ACKNOWLEDGED"}`.

**Fallback.** `unanswered`, `offline` and `superseded` leave the Task exactly
as it was, and the receipt says `fallback: "polling"`: the Connector finds
the work through its `GET /events` reconciliation loop and its registry
delivery mode, or on reconnect from its saved cursor. The wake changes
nothing about polling, which stays mandatory.

**Scope.** Wake state lives in the backend process. An endpoint is learned
from a live `wake=1` subscription and remembered for 24 hours after its last
socket closes, which is what lets wakes for an offline Connector be recorded
as `offline`. A restart forgets endpoints and drops in-flight wakes without a
receipt, and a Connector that has not subscribed since the restart is not
woken. RelayHall runs one backend process; a deployment with several would
record `offline` from a process that does not hold the socket, and needs
sticky routing for this endpoint first.

### Wake protocol 2: verify, stuck and the outcome

`?wake=2` registers the socket exactly as `?wake=1` does (the same
`wake.status` answer and reasons, the same receive-only rule until
`"enabled":true`). Every wake frame then carries a `kind`:

```json
{"type":"wake","wakeId":"<uuid>","taskId":"<uuid>","kind":"verify","cursor":"<feed cursor>","attempt":1}
```

| Kind | Rings when | For |
|---|---|---|
| `implement` | the Task becomes ready (`task.ready`) and is assigned to this Connector: the protocol-1 wake, unchanged | the assigned Connector |
| `verify` | a Verify item opens for this Connector: the Task is in Review and its Verifier is the Connector or one of its Agents (its principal subtree), or an active native review names that subtree as Verifier | the Verifier |
| `stuck` | a Stuck item opens for this Connector: it is the item's exact addressee, the Shepherd, else the creator, else the Assignee | the addressee |

`verify` and `stuck` are the items the Connector's own
`GET /notifications/actions` lists (scope `tasks:read`; a Connector bearer
gets these two kinds), read through the same queries, for the one Task a feed
event names. The events evaluated are those that can open such an item: a
move to `review` or `stuck`, a Verifier change, `task.review_requested` and
`task.stuck`. The Verify item addressed to an Account owner because a Task
has no usable Verifier never rings a Connector. A Connector is never rung to
verify a Task it is the execution Connector of, or whose Assignee is the
Connector or one of its Agents. Frames are identifiers only, every frame is
sent only while the Connector could pull the item at that moment (it is re-read
under the Connector's current credential before each send), and a wake is
still a hint.

One wake is in flight per Task, kind and Connector, and an item already rung
is not rung again while it stays open; a new occurrence (the Task leaves
Review and returns, a new Stuck episode, a new Verifier) rings again. Each
kind has its own withdrawal rule, and a withdrawn wake settles `superseded`
before its next send: `implement` as in protocol 1; `verify` when the Task
leaves Review, its Verifier changes, or the item stops being this Connector's
to see; `stuck` when the item closes. On a Connector with both kinds of
socket, `verify` and `stuck` frames go to its protocol-2 sockets only, and
`implement` frames go to every socket, each in its own protocol's shape. The
kinds ring only while the Connector's most recent subscription is protocol 2.
Receipts carry `kind` beside the fields above, and their stream text names
the kind.

**The acknowledgement means "the Connector has it".** On protocol 2 a
`wake.ack` says that the Connector's always-running process received and
accepted the wake, which takes milliseconds; it does not say that a harness
started, so the same retry schedule (about 15 s) applies to every kind. Only a
protocol-2 acknowledgement settles a `verify` or `stuck` wake. An `implement`
wake may be acknowledged on either kind of socket.

**What the Connector did** is reported afterwards on the SAME socket that
acknowledged the wake:

```json
{"type":"wake.outcome","wakeId":"<uuid>","outcome":"started","reason":null}
```

`outcome` is one of `started`, `refused`, `notified` and `finished`. `reason`
is a code (an upper-case identifier of at most 64 characters, such as
`HARNESS_CONFIG_NOT_ISOLATED`) or null; a `refused` outcome must carry one.
The frame is a closed object, held to the same 8 KiB, queue and unmatched
limits as `wake.ack`, and anything else closes the socket with 1008 (`Only
wake.ack and wake.outcome frames are accepted`); a `wake=1` socket still
accepts `wake.ack` only. Outcomes are taken in order: `started` first, then
`finished`; `refused`, `notified` and `finished` end the wake, and nothing is
taken after that. Each accepted outcome writes, in one transaction, an audit
row `connector.trigger.<outcome>` on the Task, attributed to the Connector's
credential, and a `system` Task stream entry with event type
`connector.trigger` carrying `wakeId`, `kind`, `outcome`, `reason`,
`serviceId`, `connectorPrincipalId`, `taskId` and `reportedAt`. The entry
appears in the Task Timeline's System view. An outcome for a wake this socket
did not acknowledge, out of order, from another principal, or for a Task the
Connector can no longer read writes nothing and counts toward the unmatched
cap.

**Restarts and missed wakes.** Nothing new is stored: the board remembers
which wakes may still report an outcome only in process memory, at most 64
per socket, forgotten when the socket closes or the backend restarts. A
Connector therefore pulls on every (re)connect and on a reconcile poll every
5 minutes: `GET /events` from its saved cursor for its ready work, and
`GET /notifications/actions` for its Verify and Stuck items. A wake lost in a
restart is found by the next pull; only its receipt is lost. An outcome that
cannot be reported on the socket that acknowledged the wake is not written to
the Task stream.

## Live wake drill (runbook)

After the release that carries this change, run one disposable Task and the
Connector under test (your own Connector).

1. Confirm the Connector's registry row is `published`, and that its
   bridge subscribes with `?wake=1` using its own credential. The bridge log,
   or a one-off client holding the same credential, must show
   `{"type":"wake.status","enabled":true}`. Anything else stops the drill:
   the reason names the fix.
2. Create one disposable Task in a drill Project, assign it to the
   Connector and arm it. Note the Task id and the time.
3. Expect, within a few seconds, a `wake` frame on the bridge, the bridge
   starting a session, and a `wake.ack` carrying its session-start envelope.
   Read the receipt with
   `GET /api/audit?action=connector.wake.acknowledged&resourceType=task&resourceId=<task id>`
   (needs `audit:read`) and `GET /api/tasks/<task id>/stream` (the
   `connector.wake` entry). Pass: `outcome: "acknowledged"`,
   `modelIdentity: "provider-reported"`, `reported.model.resolved` equal to
   the model in the provider's own response metadata for that session, and
   `telemetry.stored: true`. A `requested-only` or `not-reported` identity
   is a truthful result, but it does not pass the model criterion.
4. Negative control: stop the bridge so it holds no open socket, assign and
   arm a second disposable Task to the Connector, and wait about 20 seconds. Expect
   `connector.wake.offline` with `sends: 0`, `fallback: "polling"`,
   `reported: null` and no telemetry. Start the bridge again: it must find
   the Task through `GET /events` polling or by reconnecting from its saved
   cursor, and claim it normally.
5. Park or archive both drill Tasks. The receipts stay in the audit log and
   the Task stream.

## Verification

The default mocked suite covers socket framing, bounds and refusal behavior.
The full CI tier also runs `npm run test:connector-notifications` against its
migrated disposable PostgreSQL. That gate exercises real credential issuance,
delegation, private-account feed separation, reconnect recovery, transport and
scope ceilings, grant removal and live credential revocation. The same gate
proves the wake receipt rows (audit, stream entry, telemetry envelope) for
every outcome, and boots the real server process to drive the wake path and
the offline negative control end to end with a stand-in Connector. Wake
protocol 2 (`connectorWakeKindsDb.integration.test.ts`) is proven there too:
the `verify` and `stuck` predicates, their withdrawal and dedupe, a Connector
that may not see the Task, the protocol-1 gate, and the outcome entries; and
`scripts/connector-wake-kinds-mutations.py` withdraws each of those guards in
a copy of the tree and requires that suite to go red at exactly the tests the
guard owns. It fails
without an explicitly disposable `RELAYHALL_TEST_DB_URL`; it never silently
skips.
