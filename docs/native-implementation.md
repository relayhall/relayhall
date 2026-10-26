# Ordinary implementation session correlation

This protocol records a current implementation owner's participation in actual
native sessions. It does not claim a Task, start a provider, verify work, complete
a Task, or infer links for historical activity. Verification remains the separate
native-review protocol from migration 135.

## Authority and registration

A published Connector Service may declare
`nativeExecution: { protocolVersion: 1, sourceProduct: "claude-code" }` only when
its installed executable implements this protocol. The product must also be in
that descriptor's telemetry products. Metadata alone is not runtime evidence.

Opening and advancing a run require the exact current implementation owner,
distinct from the Verifier, on a nonarchived In Progress Task whose dependencies
are satisfied. The Service, current descriptor version and Task profile must
remain pinned. A Connector or task-bound child Agent derives its Account and
nearest registered Connector through current server authorization; the caller
cannot supply those identities. Both the request credential ceiling and current
delegation chain must allow Task write and Service invoke. Attestation additionally
requires telemetry write. A parent or sibling cannot impersonate an Agent owner.
These are fresh decision-time permission checks, not an atomic serialization
guarantee against every grant writer.

## Supported operations

`GET /api/tasks/:id/native-executions` returns the assignment epoch and visible
participation records. `POST` to the same path opens a run. Actions use
`POST /api/tasks/:id/native-executions/:executionId/:action`. The MCP tool
`relayhall_task_native_execution` exposes these same operations, with Task read
for list and Task write for mutations; handler authority is still enforced.

| Action | Exact input | Meaning |
| --- | --- | --- |
| open | dispatchKey, assignmentEpoch, serviceId, descriptorVersion, leaseToken, budgetSeconds | Allocate a once-only run; budget 30–3600 seconds |
| authorize-launch | leaseToken, launchKey | Durable permission to issue one local provider launch |
| heartbeat | leaseToken | Extend the lease up to 120 seconds, never past its hard deadline |
| attest | leaseToken, slotId, relationship, optional parentSlotId, correlation | Bind a real native session init, never an invented attempt UUID |
| close | leaseToken, outcome, optional reportId | Record process outcome; an attached Report must be caller-authored and associated with the Task |
| cancel | empty object | Cancel a run for which launch was never authorized |
| reconcile | launchKey, intentDigest, processIdentityDigest, treeAbsent: true, stoppedAt | Record authenticated stopped-tree custody evidence, with no work verdict |

The lease token is 32 random bytes encoded as 64 lowercase hex characters; only
its digest is stored server-side. Dispatch and launch keys are UUIDs. Exact
dispatch retries return the original record, including after assignment change;
changed payloads conflict. Closed retries require the original close body.
Uncertain writes require readback/reconciliation, never a new nonce or automatic
provider replay. An expired lease does not prove that a process stopped.

Migration 136 serializes Task assignment changes with run operations. Owner,
Service, descriptor, profile and warrant changes advance a monotonic epoch;
changing away and back cannot resurrect a lease. An ownership-lost run remains
an unresolved launch fence until cancellation or explicit stopped reconciliation.
The database permits only one active/unresolved run per Task. Current owner or
current Shepherd authority is required for recovery, independently of Service
availability. Recovery never silently restores a lease or returns a work verdict.

The existing Task recovery endpoint now includes exact execution profile and
descriptor equality in its retry decision. Same Service/warrant alone does not
make a changed profile an exact replay.

## Native identity, privacy and retention

An execution supports at most 16 explicitly declared primary, resumed or child
slots. Child slots name an existing parent slot. The caller sends actual native
`session_id` and optional `conversation_id`, using the existing bounded telemetry
identifier grammar. The shared telemetry HMAC function uses conversation identity
first when present. Raw identifiers are not stored in correlation tables or
returned by this API. A resumed session can participate in more than one run;
session-wide activity must not be labeled exclusive Task usage.

The displayed identity triple is **connectorId + sourceProduct + sessionRef**.
Account identity controls access; it is not a component of that triple. Readers
need Task visibility, Service read and the existing telemetry Account/root scope.
Outside the permitted telemetry scope, the session projection is only
`{ state: "restricted" }`, with no slot count, product or reference. In-scope
attestations have no session link until the telemetry projection actually exists.
Expired links disappear before retention cleanup. Retention deletes correlation
slots with the existing TS-9 deletion receipt pattern and never writes canonical
session attempts or changes historical events.

Pepper rotation adds an explicit segment after verifying the prior actual seed;
it preserves the original expiry. Exact current-key retries do not need a retired
historical key. A new segment whose preceding key is unavailable conflicts; it
does not authorize a replacement provider. No global session-to-Task uniqueness
or legacy backfill is implied.

## Client and UI obligations

A non-owner Shepherd cannot reconcile another actor's live, unchanged execution
lease. Ownership loss or lease/hard-deadline expiry permits that recovery path;
the exact current owner can still submit custody evidence. Stopped timestamps
allow up to 120 seconds of client clock skew around server bounds. This tolerance
does not prove process absence: the authenticated caller remains responsible for
the retained exact process-tree evidence, and reconciliation supplies no verdict.

Clients must persist open, launch and result publication intents before writes,
stop the exact owned process tree on timeout or lost authority, and retain
unknown outcomes for explicit reconciliation. Provider init identity and resolved
model must be checked before accepting output. Child stdout and provider output
are untrusted data. Report association precedes correlation close; normal Task
finish then requests independent review. Neither process exit nor this panel
supplies a verification verdict.

Task details show ordinary participation separately from verification, with the
authenticated actor, process outcome and visible result Report. Refresh,
authority changes, reconnect and expiry hide stale links while rechecking. UI
history remains actual TaskHistory; no legacy completion actor or session is
manufactured.

The private Claude adapter successor is a separate deployment artifact and is
not installed by this source change. Codex and Hermes still require their own
actual init/resume handling, custody, registration and installed acceptance. Source
and disposable HTTP/UI tests are not evidence of any installed provider dispatch.
