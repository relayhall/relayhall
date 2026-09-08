# Task elements

RelayHall keeps the Task core small and composes current assignment, execution profile, review state, observability, one ordered stream, Subtasks, and typed References around it.

The assignment side record carries claimant, Shepherd, Verifier, current active lease, and the explicit armed/parked state. A Task can be claimed only when it is armed and every dependency is semantically complete; a legacy Task archived with the `completed` disposition satisfies that dependency just like a completed Task.

## Stream and views

Every entry is ordered and server-stamped with one provenance class:

- `system`: an event the RelayHall server observed.
- `authored`: text a principal wrote. Handover is the authored slice written by the current claimant, Shepherd, or Verifier.
- `reported`: an Outpost report. Reads require both Task access and the Outpost visibility tier.
- `legacy`: a byte-preserving import from the older History or Timeline ledger. It is never promoted to an observed fact.

History is the `system` view, Handover is the role-filtered `authored` view, and Timeline is the complete authorized stream.

Entries are append-only. Oversized text (more than 8192 characters) is filed as a caller-authored Report and linked from a short stream entry. If promotion capacity is exhausted, RelayHall quarantines the full content and still accepts the append.

## Atomic finish

`POST /tasks/{id}/finish` is the handback boundary. It appends the Handover, creates or links a Report, and moves the Task from In Progress to Review in one database transaction. The call fails without committing any part if the Task or a Subtask is not ready.

CLI example:

```bash
relayhall finish TASK_ID \
  --handover-file handover.md \
  --report-title "Implementation evidence" \
  --report-file evidence.md
```

All mutating Task-element CLI and MCP operations support dry-run validation where the input schema exposes `dryRun`.

## Subtasks and References

Use a Subtask's stable `id` for mutation. The older index routes remain for one compatibility release and emit deprecation headers; index is display order only.

```bash
relayhall set-subtask TASK_ID SUBTASK_ID review
```

Task References are a sibling contract with base kinds `repository`, `environment`, `workspace`, `reference`, `report`, `task`, `skill`, `phase`, and `session`. Namespaced plugin kinds are retained as inert typed rows when their plugin is absent. Dependencies remain their own blocking relation and are never inferred from References.

## Secret handling and redaction

Inbound masking is on by default and covers only unambiguous shapes such as private-key blocks, known key prefixes, AWS access-key identifiers, and JWT triplets. It deliberately does not use entropy or generic hexadecimal heuristics.

The project-level masking toggle is human-only in the admin appearance/configuration surface. Agents, CLI, and MCP receive no mutation surface for it.

Redaction is the only licensed stream mutation and requires root authority. It supports span replacement, whole-entry tombstone, and author erasure. Each mutation records who performed it, time, reason category, and a keyed-HMAC fingerprint of destroyed bytes. Redaction cascades to the associated Report only when the Report was automatically promoted from that entry.

## Execution secrets

Secret-typed connector parameters contain only reference names declared and pinned by the immutable descriptor version. RelayHall never accepts secret bytes for those fields. Retired descriptor pins fail closed and re-pinning runs full validation.
