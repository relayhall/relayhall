# Task Orchestration

This document describes the real task lifecycle used by RelayHall today, including the automated Verifier handoff that now exists in the live backend and CLI.

## Status flow

Tasks move through these task-level states:

- `ideas` — rough notes or future work
- `todo` — ready to be picked up
- `in-progress` — an agent or human is actively working
- `review` — work is finished enough for Verifier/orchestrator checks
- `stuck` — blocked or waiting on human input
- `completed` — accepted and done
- `archived` — hidden historical record

Subtasks use a separate lifecycle:

- `empty`
- `in-progress`
- `review`
- `stuck`
- `skipped`
- `completed`

## Review-aware task fields

Automated review depends on these task fields:

- `successCriteria` — explicit acceptance checks for the automated Verifier
- `definitionOfDone` — extra completion notes for humans/orchestrators
- `constraints` — scope, safety, or execution boundaries
- `maxRetries` — retry budget before escalating to a human
- `attemptCount` — current number of Verifier attempts
- `reviewHistory` — structured pass/reject/escalate audit trail
- `needsReview` — set when the task needs human attention after review

## Normal agent workflow

1. A human or orchestrator creates a task.
2. The task should include concise instructions plus any linked reports for deep context.
3. If automated review is desired, set `successCriteria` and optionally `maxRetries`.
4. The implementation agent works the task and marks each subtask with `start-subtask` / `complete-subtask`.
5. The implementation agent hands off with `relayhall review <task-id>` when the work is ready for checking.
6. A separate Verifier/orchestrator run gathers independent evidence and records findings.
7. The orchestrator or human decides the final next action based on the Verifier outcome.

## Role separation: implementation vs QA

RelayHall should not rely on a subagent to self-certify its own work as the final acceptance signal. Use these roles deliberately:

- **Assignee** (the implementation subagent): writes code/config/docs, runs local checks, and hands the task to review. The stored identifier for this role is `claimant`/`owner_principal_id`; Assignee is its label.
- **Verifier** (with orchestrator authority): verifies the result independently, writes a review report, and chooses `pass`, `reject`, or `escalate`. The server refuses self-review: the Assignee can never be the Verifier.
- **Shepherd**: shepherds exceptions rather than doing the work — force-release, reassignment, parking, and the escalations raised by rejected reviews or stuck tasks. In the ratified model every Task names one, inherited from its Phase at planning time and falling back to the creator; nothing enforces this today — the mechanism ships with the Phase-2 authorisation work (RH-P3.1).
- **Human owner**: remains the approval boundary for ambiguous, risky, or high-impact changes and for escalations. Owner is the deployment's human authority, never a task role.

If a QA run finds issues, it may spawn or steer follow-up implementation work, but that follow-up must come back through review again before approval.

## Task creation requirements for trustworthy review

Tasks intended for automated QA should include enough context for an independent Verifier, not just the implementing agent. Prefer to include:

- explicit `successCriteria` written as observable checks
- `definitionOfDone` and `constraints` that distinguish must-have behavior from optional polish
- links to reports/specs/mockups/issues so the Verifier can compare implementation against the intended outcome
- environment notes when verification needs authenticated UI access, external services, or browser checks

When browser/auth validation is expected, task instructions should explicitly allow the Verifier to use the shared QA browser and runtime password-vault retrieval rather than assuming the implementing agent's own claims are sufficient.

## CLI commands

Use the CLI, never raw API calls.

```bash
relayhall start-subtask <task-id> <index>
relayhall complete-subtask <task-id> <index>
relayhall review <task-id>
relayhall review <task-id> --run-reviewer
relayhall reject <task-id> --reason "Missing evidence"
```

## What `relayhall review` means

`relayhall review <task-id>` is the normal handoff command.

- It moves the task into `review`
- It does not mark the task completed
- It signals that the agent is done and the review gate should take over

`relayhall review <task-id> --run-reviewer` does more:

- ensures the task is in `review`
- executes the backend Verifier service
- gathers evidence from task metadata, reports, sessions, and workspace/test signals
- persists a structured `reviewHistory` entry
- updates `attemptCount`
- returns one of: `pass`, `reject`, or `escalate`

## Verifier outcomes

### Pass

Typical result:
- reviewed subtasks become `completed`
- the task becomes `completed` only when every subtask is now `completed` or `skipped`; otherwise it returns to `todo`
- review history gets a `pass` entry
- evidence shows what was checked

### Reject

Typical result:
- task moves back to `todo`
- findings explain what is missing or failing
- `attemptCount` increases
- the next worker should address the explicit review findings

### Escalate

Typical result:
- task moves to `stuck` for human attention
- `needsReview` is set or preserved
- retry budget has been exhausted or the Verifier found something that needs judgment

## Retry budget and escalation

- `maxRetries` defaults to `3`
- each reject/escalate attempt increments `attemptCount`
- once the retry budget is exhausted, automation should stop bouncing the task indefinitely
- exhausted or ambiguous reviews should be surfaced for a human

## Frontend expectations

The dashboard should make these states legible:

- board columns are `Ideas`, `To Do`, `In Progress`, `Review`, `Stuck`, `Completed`, and `Archived`
- `Review` and `Stuck` are separate workflow states, never a combined bucket
- subtask labels are `Not started`, `In progress`, `To be reviewed`, `Completed`, `Stuck`, and `Skipped`

- create/edit forms expose `successCriteria`, `definitionOfDone`, `constraints`, and `maxRetries`
- task detail shows Verifier status, attempt count, review history, and the durable task/session timeline
- board/task cards visually distinguish:
  - review in progress
  - needs human review
  - stuck work
- Sessions should show truthful empty states for `runtime missing` and `transcript unavailable` instead of implying every `active` session is still starting

## Durable task/session timeline

Task detail treats reported session history as an audit trail, not as proof that
the board can see a live runtime.

`GET /tasks/{id}/timeline` merges four sources into one deterministic order
(`at` DESC, then source, then id DESC), with `filter=all|handover|system`,
keyset pagination (`before` cursor + `limit`, default 50, max 200), and
per-source degradation (`sourcesUnavailable[]` — a failed source is
distinguishable from an empty one):

- `task_stream_entries` — the ledger of record, including every pre-086
  `task_history` and `task_timeline_events` row backfilled as
  `provenance='legacy'`. Stream visibility tiers and redaction apply exactly
  as `GET /tasks/{id}/stream` applies them.
- `task_history` — only rows **not** already represented in the stream
  (excluded where `legacy_source='task_history'` and `legacy_source_id`
  matches), i.e. post-086 field changes.
- `reviewHistory` — synthesized Verifier events with stable `review-{id}` ids.
- legacy `sessionRefs` — synthesized with stable timestamps
  (`startedAt`/`created`, never `updated`).

`task_timeline_events` is **not** an independent source: it is frozen (no
writers since P1.3) and fully contained in the stream's legacy rows.

Event-type → source → filter-view mapping (C1, design 3cdf6e65 §3.6):

| eventType (produced) | Source | View |
|---|---|---|
| `task.status_changed`, `task.priority_changed`, `task.notes_updated`, `task.created`, `task.field_changed` | history | System & ownership |
| `task.arm`, `task.park` (autoStart changes) | history | System & ownership |
| stream `provenance='system'` types (claims, releases, `task.transitioned`) | stream | System & ownership |
| `handover.finish`, `report.*` (stream system) | stream | Handovers & reports |
| stream `provenance='authored'` (notes, comments, handover working area) | stream | Handovers & reports |
| stream `provenance='reported'` known telemetry (`outpost.*`, `session.*`, `telemetry.*`, `progress.*`, `safety.*`) | stream | System & ownership |
| `report.*` / `handover.*` from ANY stream provenance (created/linked/auto-promoted, atomic handback) | stream | Handovers & reports |
| stream `provenance='legacy'` (086 backfill) known field-change vocabulary | stream | System & ownership |
| `review.pass` / `review.reject` / `review.escalate` / `review.running` / `review.unknown` | review | Handovers & reports |
| `session.reference` | session | System & ownership |
| unknown / future / plugin types (every provenance, incl. reported/system) | any | `filter=all` only (fallback lane) |

Envelope deviations from the design sketch, recorded per §4.3: `actor` stays a
display **string** (the pre-C3 modal renders it directly), and the structured
per-source-nullable record is the new `actorDetail` field; `description`
(legacy name) carries what the sketch called `detail`. The reports-family
query params are snake_case (`project_id`, `updated_since`) — a recorded
nonconformance; the new `taskId` filter on `GET /reports` is camelCase per the
dominant API convention and matches `task_ids` containment or
`task_references` rows with `kind='report'`. That list post-filters
authorization and cannot promise `hasMore`; task-linked report counts are
small, so callers iterate until a short page.

This matters because task linkage only describes the latest state reported to
the board. The timeline keeps prior reported sessions linkable without claiming
that core observed the underlying process.

## Reporter truth model

The Sessions page distinguishes reporter truth from task linkage truth.

Core does not inspect a harness process, workspace, transcript, or runtime
database. A nearby outpost reports coarse status and session metadata through
the reporter contract. Without a fresh report, runtime state is `unknown`.

Important cases:

- linked task + fresh reporter heartbeat: show the reporter's coarse state;
- linked task + no reporter: show `unknown`, not `starting` or `active`;
- historical session: show the last reported terminal state and timestamp;
- transcript unavailable: link to an appropriate plugin/outpost rather than
  reading a harness file from core.

`active` task linkage alone is never proof that a runtime is still attached.

## Orchestrator policy

Recommended orchestration policy:

1. agents never mark a task completed directly
2. agents only hand off with `relayhall review <task-id>`
3. the backend Verifier heartbeat polls `review` tasks automatically and runs the Verifier without waiting for a manual CLI call
4. only an independent Verifier may approve subtask completion; an accepted review completes the task only when every subtask is completed or skipped
5. rejected tasks go back to work with explicit feedback, not silent status churn
6. escalated tasks move to `stuck`, set `needsReview=true`, and should be triaged by a human

## Verifier heartbeat + safety rails

The backend now starts a Verifier heartbeat service on boot.

- poll interval: `REVIEWER_HEARTBEAT_INTERVAL_MS` (default `15000`)
- per-review timeout: `TASK_REVIEW_TIMEOUT_MS` (default `300000` / 5 minutes)
- state file: `REVIEWER_HEARTBEAT_STATE_FILE` (default `/data/reviewer-heartbeat-state.json`)
- dedupe: the heartbeat fingerprints each review task and only re-runs when the review payload changes
- escalation side effects:
  - status moves to `stuck`
  - `needsReview` becomes `true`
  - a `reviewHistory` entry is recorded
  - the task thread gets a stuck lifecycle message when Discord thread wiring exists
- `relayhall review --run-reviewer --dry-run` is intended for non-mutating Verifier inspection; this now has dedicated regression coverage in `TaskReviewerService.test.ts` and `scripts/e2e-reviewer-smoke.sh`

## Minimum evidence standard

A Verifier run is only useful if it cites real signals such as:

- success criteria checked
- linked reports used as requirements context
- session references
- test or command evidence recorded in a linked report
- external verifier reports when a task depends on repository, browser, or
  login-gated evidence
- clear findings with severity

Privileged QA runs outside core. It may use its own browser or vault access and
then file a report. If that independent path is unavailable, prefer `reject` or
`escalate` over trusting the implementing agent's own validation claims.

If the Verifier cannot gather enough evidence, prefer `escalate` over a vague pass.
