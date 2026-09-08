# Automated task Verifier

RelayHall includes a deterministic backend preflight — the automated task
Verifier — for tasks handed to `review`. It validates the **shape and minimum
evidence package** before a human or independent Verifier signs off. It does not run code, inspect a workspace,
use an LLM, or semantically decide that every acceptance criterion is true.

## Trigger path

1. An implementer hands off with `relayhall review <task-id>`.
2. The task enters `review`.
3. `ReviewerHeartbeatService` polls at
   `REVIEWER_HEARTBEAT_INTERVAL_MS` (default 15 seconds).
4. A changed review fingerprint invokes `TaskReviewerService.runReview()`.
5. The result and evidence snapshot are appended to review history.

A deterministic `pass` means **preflight passed**, not final acceptance.
Human/orchestrator or separately equipped QA remains the completion boundary.

## Pass contract

The preflight requires:

- the task is in `review`;
- review subtasks form a contiguous slice after a completed/skipped prefix;
- explicit `successCriteria` (or legacy `definitionOfDone`) exist;
- at least one linked review report exists—session references alone do not
  prove an implementation attempt;
- linked evidence contains no unresolved failing test/build signal;
- when criteria mention testing, build, compile, lint, or type checking, a
  positive signal is present in a linked report.

Signal extraction is deliberately conservative and line-oriented. It is not a
semantic criteria-to-evidence matcher. Ambiguous or mixed evidence should be
rejected or escalated to a Verifier rather than “explained” into a pass.

## Outcomes

- `pass` — structural/evidence preflight passed; work remains in `review`.
- `reject` — return to `in-progress` and increment `attemptCount`.
- `escalate` — move to `stuck`, set `needsReview=true`, record history, and emit
  the configured stuck notification.

`maxRetries` defaults to 3. The backend review timeout defaults to five minutes
via `TASK_REVIEW_TIMEOUT_MS`.

## CLI

- `relayhall review <task-id>` — hand off only.
- `relayhall review <task-id> --run-reviewer` — force the deterministic
  preflight through the API.
- `relayhall reject <task-id> --reason "..."` — structured rejection with
  attempt tracking.

## Evidence expectations

A linked report should identify the exact candidate, address each criterion,
state commands and observed results, identify unresolved limitations, and point
to externally stored artifacts by reference. Do not write “passed” when a test
is failing or omit a known negative signal.

When acceptance depends on a browser, repository checkout, secret-backed
integration, hardware, or another privileged system, run an **independent
external Verifier** with the required tools. That Verifier files the durable
report; the core preflight only validates the board-resident package.

## Regression coverage

Backend tests cover:

- valid report-backed preflight pass;
- review-slice readiness rejection;
- session-only evidence rejection;
- unresolved failing-test rejection;
- test-required criteria without a positive signal;
- missing-criteria escalation;
- heartbeat deduplication and reject/fix/pass flow;
- bounded retry escalation;
- concurrent-attempt verdict authority.

## Deployment notes

Heartbeat state is stored at `REVIEWER_HEARTBEAT_STATE_FILE` (default
`/data/reviewer-heartbeat-state.json`). A task that remains in `review`
after preflight pass is not reprocessed until its fingerprint changes.

The Verifier must never receive host workspace, runtime-home, transcript, vault,
or browser mounts in core. Privileged verification belongs in a separately
controlled worker identity.
