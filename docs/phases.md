# Phases

A **Phase** is the grouping object between a Project and a Task. It groups tasks under one
outcome, is ordered within its project, and **may overlap** with other phases — a falsification
gate that deliberately runs alongside the work it checks is a phase, not a scheduling error.

A task's phase is **optional**. Unphased tasks are the project backlog: a normal state, not a
missing value.

## The goal

A phase carries a **goal**: the outcome statement for that group of work. So does a project. A goal
is a **property** of the object you are already looking at — it is never its own object, page or
table.

| Altitude | Field | What it is for |
|---|---|---|
| Project | `goal` | The big picture, so an orchestrator understands what it is building. |
| Phase | `goal` | The current focus, tight enough to steer a harness. |

A task has **no goal of its own**: it inherits its phase's. Both goals are rendered into compiled
briefs, as quoted data.

## Lifecycle

`todo` · `in-progress` · `completed` · `archived`

`archive` is the routine, reversible way a phase leaves the board — archived phases are excluded
from default listings, still readable, and restored with `unarchive`. Setting the status directly
accepts `todo`, `in-progress` and `completed` only; archiving has its own verb so it can never
happen as a side effect of an ordinary edit.

**Delete is the restricted path**, requires `phases:admin`, and the database refuses it while any
task still points at the phase. Archive instead.

## Authority

| Surface | Scope |
|---|---|
| Read a phase or list phases | `phases:read` |
| Create, update, archive, unarchive | `phases:write` |
| Delete | `phases:admin` |
| **List a phase's tasks** | `phases:read` **and** `tasks:read` |
| **Compile a phase brief** | `phases:read` **and** `tasks:read` |

The last two need both because their output discloses task content, and brief compilation is a
`tasks:read` act. The extra requirement is checked before anything is looked up, so a refusal tells
a caller nothing about which phases exist. `relayhall phase get` degrades honestly when the
credential lacks `tasks:read`: it prints the phase and says the task list is not shown, rather than
printing an empty one.

Phases are grantable resources: by default a phase's visibility derives from its project, and
explicit grants add access. They never narrow inherited visibility or switch
policy modes. Exceptional confidentiality or blind testing uses the separate,
privileged and audited restricted-access operation.
Enforcement itself arrives with the shared authorization predicate — see [Seams](#seams).

## REST

```
GET    /api/phases?projectId=&status=&includeArchived=
POST   /api/phases                      { projectId, name, goal?, status?, position? }
GET    /api/phases/{id}
GET    /api/phases/{id}/tasks
PATCH  /api/phases/{id}                 { revision, name?, goal?, status?, position? }
POST   /api/phases/{id}/archive         { revision }
POST   /api/phases/{id}/unarchive       { revision }
DELETE /api/phases/{id}
POST   /api/phases/{id}/brief
GET    /api/projects/{id}/phases        (the same rows, reached through the project)
```

`revision` is the If-Match guard: a stale value answers `409 REVISION_MISMATCH`. Absence and
denial are the same concealed `404 PHASE_NOT_FOUND`.

Deleting a phase that still holds tasks answers `409 PHASE_IN_USE` and names the count — the phase
is untouched. Archive is the routine path; the Phases page offers delete behind an explicit
confirmation and keeps the row in place when the refusal comes back.

Tasks carry `phaseId`. It is writable on `POST /api/tasks` and `PATCH /api/tasks/{id}` under
`tasks:write`, and filterable on `GET /api/tasks?phaseId=` (`phaseId=null` selects the backlog).

**A phase must belong to the task's own project.** That is a database constraint, not a
convention: a write that would pair a task with a phase from another project is refused with
`409 PHASE_PROJECT_MISMATCH`. It is never silently repaired — moving a task between projects means
clearing or re-setting its phase in the same request.

## CLI

```bash
relayhall phase list --project relayhall
relayhall phases --project relayhall --include-archived
relayhall phase create "Substrate in target shape" --project relayhall --goal "Every API path authorised through one predicate"
relayhall phase get <phase-uuid>
relayhall phase update <phase-uuid> --status in-progress
relayhall phase update <phase-uuid> --clear-goal
relayhall phase brief <phase-uuid>
relayhall phase archive <phase-uuid>
relayhall phase unarchive <phase-uuid>
relayhall phase delete <phase-uuid>
```

`relayhall phases` is the bare-plural alias for `relayhall phase list`. Update, archive and
unarchive read the current revision automatically; pass `--revision` to enforce a strict
optimistic-concurrency check instead.

Task membership:

```bash
relayhall create "Wire the predicate" --project relayhall --phase <phase-uuid>
relayhall update <task-id> --phase <phase-uuid>
relayhall update <task-id> --clear-phase
relayhall list --phase <phase-uuid>
```

Creating a sequential set in one command:

```bash
relayhall create-multiphase "Release" --project relayhall --tag release --phases "Build;Verify;Publish"
```

The helper creates one real Phase per semicolon-separated name, in the supplied order, and one
seed task bound to each Phase through `phaseId`. The tasks form a dependency chain. The first is
created in `todo` with automatic pickup enabled; later seeds remain parked in `ideas` with automatic
pickup disabled. Every task receives the shared `--tag` value; the command creates
no master task, tracker file, `multi-phase`/`master` tags, or `phase-N` tags. The Phase records are
the grouping and tracking surface.

And the project goal:

```bash
relayhall project update <project> --revision <revision> --goal "One permissioned surface for a mixed workforce"
```

## MCP

`relayhall_phase_list` and `relayhall_phase_get` are read-only: phase mutation stays on the CLI and
REST behind `phases:write` and `phases:admin`.

Task membership moves through `relayhall_task_update` (`phaseId: null` returns the Task to the
backlog); `relayhall_task_create` also accepts an optional `phaseId`. The Phase-3 MCP re-scope
answered the deferred question and folded the former scoped `relayhall_task_phase_set` into that
one general verb, limited to the fields `PATCH /tasks/:id` already accepts with the server-side
role gates untouched.

## The phase brief

`POST /api/phases/{id}/brief` compiles a portable briefing over the phase: the project's Charter,
the project and phase goals, and the phase's tasks. It is a **reading artifact** — member tasks
render as id, title and status only, and an agent working a task pulls that task's own brief.

Goals and task titles are board data written by callers, so they are emitted inside a delimited
quoted-JSON block and never in instruction position.

**Every brief fails closed on a lookup it cannot establish.** A failure is not confirmed absence: a
Charter lookup failure answers `503 CHARTER_LOOKUP_FAILED`, a project-goal failure
`503 GOAL_LOOKUP_FAILED`, and a failure to read the phase a task is *bound to*
`503 PHASE_LOOKUP_FAILED`. A task with no phase is confirmed absence and compiles normally — the
backlog is a real state, not a missing value. The refusal envelopes and their log lines are fixed
text: nothing derived from the underlying error reaches either.

## Seams

Named here so their absence is a decision rather than an oversight:

- **Gates.** A phase may carry a gate. No ratified text defines what a gate does yet, so no gate
  field exists; inventing one would be a local invention.
- **Arming.** "Arm the chain" is a phase operation, and arming, `task.ready`, leases and the
  delivery worker arrive together with the pickup protocol. Nothing here presumes their shape.
- **Shepherd inheritance.** Every task names a shepherd inherited from its phase. The task-role
  fields do not exist yet; a phase-level default with nothing to inherit into would be dead schema.
- **Grant enforcement.** Phases are grantable and the grants store accepts them, but no enforcement
  flip happens here: the shared authorization predicate owns every one of those.

## Not to be confused with

- **`tasks.parent_id`** — the live parent/child link the board still uses. Existing trees keep
  working; nothing here rewrites them.
