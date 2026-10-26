Completion reference lifecycle contract

Logical target tuples use transaction TRY advisory locks before lookup/removal.
Every writer takes Task FOR UPDATE NOWAIT before discovery/materialization;
releaseWarrant rechecks carried membership after that lock. Existing Task,
warrant and feed locks stay owned by the caller until its transaction ends.
Every mutation locks an existing target FOR UPDATE NOWAIT and versions it with
an id=id update (no semantic field change): this is an MVCC fence for shared
reference count changes as well as final deletion. REPEATABLE READ whole-plan
snapshots are retained. Stale target/refcount snapshots refuse the whole owner.
READ COMMITTED queries after acquisition see current committed state.

ASSIGNMENT_REFERENCE_BUSY is a typed RequestFaultError, status 409. Logical
contention, target version serialization refusal and nonblocking Task/target
row conflicts require whole-transaction rollback, discard afterCommit effects,
and explicit caller retry. No internal blind retry. Native uses the same request;
ordinary review reuses its separately committed running attempt. Sweep retains
per-warrant rollback and reports retryable warrant ids without incrementing
success for a busy warrant. No privileges, manual grants or authority changes.

The ordinary verdict is the one owner that retries for its caller: when
TaskReviewAttemptService.recordVerdict opens its own transaction
(`POST /tasks/reviewer/{id}/run`, relayhall_review_run, the CLI `review` command
and the Verifier heartbeat), a verdict refused ASSIGNMENT_REFERENCE_BUSY has
already rolled back and released its connection; the owner re-runs it whole on a
fresh transaction up to VERDICT_REFERENCE_BUSY_RETRIES (3) more times with a
small jittered pause, and only for that code. Two Tasks of one assignee verified
at the same moment therefore both complete and the shared target is reaped once.
Sustained contention still answers the 409 and consumes no retry budget. A
supplied transaction (the native verdict, test callers) stays its owner's to
roll back and retry; AccessVehicleService itself never retries.

The maintained test:completion-reference-lifecycle entry requires an explicit
owned fixture marker, matching PG*/DB_* fields and loopback/CI postgres URL.
The unchanged mixed_cleanup_test fixture bytes therefore require that database
prefix; the dedicated full-tier job provisions that name, not a deployment DB.
Default mocked Jest excludes all four owned PG suites. Notifications are stubbed BEFORE
service imports. One worker and heap1024. No HTTP, provider or native launch.

The entry runs four owned real-PostgreSQL suites: mixedCompletionCleanupLive,
completionReferenceLifecycleLive, lifecycleEntrySchedulerLive and
completionReferenceFencingLive. The last pins one rule each:

1. Task NOWAIT before discovery, measured against the Task lock that
   GET /tasks/{id} takes for reportMaintenanceAccess: a warrant revoked or
   expired while that display read holds the Task refuses at once and whole
   (warrant row, events, audit, Task, link and pointer unchanged), reaps on
   retry, and the dead warrant can never carry the assignment again
   (WARRANT_NOT_LIVE).
2. releaseWarrant re-decides each carried Task after its Task lock: a Task
   completed between discovery and that lock keeps its executor record, loses
   only the dead warrant pointer and gets no automatic unassign.
3. Only the terminal verdict is fenced. Under the same reference contention a
   refused terminal verdict leaves its attempt running and attempt_count
   unchanged, while counted rework and escalation apply once each and keep
   access; the later uncontended terminal verdict reaps once.
4. One scheduled sweep tick isolates a busy warrant: the free warrant expires
   and reaps in that tick, the busy one is reported once as retryable and left
   whole, the next tick consumes it, and a third tick changes nothing.
5. An ordinary terminal completion already holds its Task, so it waits behind
   the display lock and then reaps; a bare reference writer under the same
   lock refuses without a wait edge.

Red proofs, each mutation applied alone and then restored: a Task lock without
NOWAIT fails rules 1 and 5; reusing the discovery row instead of the recheck
fails rule 2; removing the terminal-verdict reap fails rule 3; letting a busy
warrant abort the whole sweep fails rule 4.
