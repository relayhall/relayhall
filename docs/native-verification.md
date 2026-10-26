# Native verification protocol 1

Native verification is a separate purpose on the existing Task. It does not claim, arm, replace its owner, or change its implementation execution profile. A published Connector Service advertises `nativeReview: { protocolVersion: 1, sourceProduct: "claude-code" }` only after its installed executable supports this protocol. Its telemetry descriptor must declare the same product at presence or full tier. Publishing a descriptor is a separate governed operation; the migration enables no Connector.

## Request and execution

The current independent Verifier or authorized Shepherd first reads `GET /tasks/:id/native-reviews/inputs`. The response fixes the criteria, visible linked Report IDs and an input digest. The server explicitly selects Task-final, middle subtask slice, or terminal slice plus whole-Task scope as detailed below. Whole-Task criteria come from its definition of done, or complete description fallback. Model output cannot select additional criteria, commands or evidence paths.

`POST /tasks/:id/native-reviews` accepts exactly `serviceId`, `descriptorVersion`, UUID `requestKey`, and `expectedInputDigest`. The Task must be in Review, its Verifier must differ from its owner, and the Service principal must be that Verifier. Current Task and Service authority are required. An exact request retry returns the original request; a changed payload conflicts. A pending request expires after 24 hours.

The Connector pulls `GET /services/:id/review-requests`; notifications are hints, never the queue. Before consuming a provider it verifies both transport identities and current permissions, reads the exact evidence, and leases via `POST /tasks/:id/native-reviews/:reviewId/lease` with a client-generated 32-byte hex `leaseToken`. Only its hash is stored by the server. A lease lasts ten minutes; an expired or uncertain launch is never automatically leased again.

On the actual native session initialization, the same Connector calls the `attest` endpoint with its lease token and `correlation: { session_id, conversation_id? }`. The account and Connector come from authenticated delegation. The session reference uses the existing telemetry pepper and session HMAC domain, with conversation ID taking precedence exactly as in telemetry ingestion. Raw provider session identifiers are not stored in this relation. Changing the session or pepper generation on an existing attestation conflicts.

The `verdict` endpoint accepts `leaseToken`, the original `inputDigest`, and a verdict containing `summary` and every fixed criterion exactly once. Each criterion has `id`, `decision` (`pass` or `reject`), nonempty `rationale`, and nonempty `evidence` drawn only from bound Report IDs. The server derives the overall decision. A process exit alone is never a verdict.

## Conditional application and authority

The verdict transaction locks the Task, current Service/descriptor and exact review request. It takes the shared review evidence barrier exclusively, locks current subtasks, references, dependency state and Reports, then recomputes the complete input digest. Migration 135 coordinates child inserts, updates and deletes with this barrier; migration 134 already coordinates associated Report writes. Any changed criterion, evidence content, reference, dependency or Task row refuses application.

Dependency Tasks are share-locked without waiting, so evidence never queues behind another holder. A dashboard `GET /tasks/{id}` holds a Task row for the few statements of its `reportMaintenanceAccess` projection, so a refused dependency lock is rolled back to a savepoint and retried once after 250 ms. A second refusal answers `409 NATIVE_REVIEW_EVIDENCE_BUSY`; retry the call.

Current identity, credential, parent ceiling, Task verification and Service invocation authority are re-resolved at each decision. These checks are decision-time snapshots: the protocol does not claim globally serialized grant or credential revocation. Report read and write scopes remain required. A private or expired session is never made visible by Task access alone.

The existing review-attempt ledger applies the verdict in the same transaction. Rejection follows its retry/rework policy. The authenticated actor's TaskHistory entry, output Report, feed event and native request result commit together. The output Report is created after input verification, so it does not invalidate its own review. Exact verdict replay returns the original result; a changed submission conflicts. Retired Task runtime metadata is not retrofitted: the UI shows the authenticated completion event actor from TaskHistory.

## Uncertainty, reconciliation and privacy

The Connector journals launch, lease, attestation and verdict intentions before their writes. Lost outcomes are read back; they are never blindly reposted or relaunched. `uncertain` records a launch that cannot be proved complete. The assigned Verifier or authorized Shepherd can call `reconcile` with the original `inputDigest` and an `evidenceReportId` after inspecting exact worker/provider termination. That Report must be linked to the Task and authored by the acting principal. This closes the request as `cancelled` without changing Task status or issuing a verdict. A successor requires a new explicit request with fresh inputs. The API records an operator attestation, not independent proof of process termination.

Task session links expose the complete `(connectorId, sourceProduct, sessionRef)` only if the caller has the existing services read scope, the telemetry Account/root narrowing permits it, the retained link is live, and the real projection exists. The link expires with the configured telemetry event retention (90 days by default). The retention sweep deletes expired links and records its own removal receipt; request/verdict audit history may remain without a session link. The Sessions UI uses all three identifiers, including for a session outside its recent list.

Restriction comes first. A caller that may read the Task but not its session (no services read scope, no telemetry read scope, or another Account than the link's) is answered `{ "state": "restricted" }` before the link's expiry is evaluated: for an expired and a live link alike, with no expiry, no triple, no product and no count, through REST and MCP. `npm run test:native-review` reads the matrix as current principals, and `scripts/native-review-privacy-mutations.py` proves it goes red when the expiry is evaluated first, or when a restricted session carries the triple or a count.

## Acceptance boundaries

Database/HTTP tests qualify transaction, permission, digest, retry, rework, uncertainty and projection contracts. Adapter tests with a fake provider qualify orchestration only. Neither qualifies an installed native runtime. Release acceptance must separately demonstrate a published executable-backed Service request, real native session initialization and telemetry, visible full-triple Task linkage, successful and rejected reviews, and uncertain-launch recovery. Ordinary implementation dispatch/progress, other Connector implementations, and the wider workflow coordinator remain separate requirements.


## Explicit scope and recovery

Inputs run in a repeatable-read, read-only transaction; they take no Task,
child-row or evidence-barrier write locks. Request/lease/verdict recheck under
the exclusive writer barrier. Reference rows and dependency status are bound;
only Report reference targets are content-bound. Arbitrary URI/file targets are
not dereferenced, locked or claimed as immutable evidence.

The server derives and stores `reviewScope` before a provider may start:
- `task_final`: flat Task or every subtask already completed/skipped; judge whole
  Task DoD (description fallback). It does not create or skip subtasks.
- `subtask_slice`: one contiguous Review slice after a terminal prefix; judge
  exact slice criteria. Pass resolves that slice and returns Task to Todo.
- `terminal_slice_and_task`: that slice is the last unfinished work; judged
  criteria include each exact subtask and explicit whole-Task DoD. Only the
  combined pass completes the Task. Gapped/active/unready shapes return 409.

Native attempts use ledger slice schema v3; legacy v0/v1/v2 callers retain their
semantics. Output Report and UI show scope and actual resulting Task status.
No completion attribution or history is inferred from a provider exit.

An authorized current Verifier/Shepherd can POST `cancel` with `inputDigest` for
never-leased pending/expired requests. Cancel and lease are serialized; a leased
request requires the existing authored-Report reconciliation instead. Exact
request-key retries return the original under current authority even if the
Service descriptor has since changed; changed payloads conflict.

The private Windows adapter assigns the provider while suspended to an owned
kill-on-close Job Object before it can execute. Cleanup verifies zero active
Job processes; guardian death closes the job. Reconciliation checks worker and
actual provider PID plus creation identity. A confirmed stopped execution may
release connector serialization while its Task verdict remains unresolved;
this is never Task acceptance or permission to replay that request.

The ten-minute lease is not renewable. Provider execution is bounded to at most
540 seconds after leasing, with the remaining margin for cleanup/publication.
Expiry refuses verdict and requires reconciliation, not a second provider run.
Terminal private raw evidence is retained seven days then replaced with an
exact-request tombstone and file hashes after process absence and outbox checks.
Delivered telemetry older than seven days is removed; pending/rejected telemetry
and uncertain runs are retained for explicit reconciliation. This local policy
does not change server telemetry retention or claim cleanup of legacy archives.
