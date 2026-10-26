# Task activity contract v1

Truthful task activity on the Tasks board and Task details.
The activity a person sees is an attributed observation the server received,
never the Task's lifecycle status, a planned model or a scheduled heartbeat.
Two producers write task-attributed frames today: the MCP server's Task link
(a caller holding a Task in progress) and a worker adapter
posting `POST /telemetry/frames` itself. The observation of a real worker going
from active to stale on both views is a deployment check, not a source test.

`POST /telemetry/frames` keeps heartbeat/status, active/idle, optional taskId,
and object payload, and admits exactly what it admitted before (telemetry:write,
the shared five-second cadence, an unknown taskId refused). Telemetry writes
never renew leases or mutate task lifecycle.

Attribution is decided by the receiver in the same database statement as the
cadence gate. A task-bearing frame is stamped with the server's assignment
epoch only when its writer is the Task's current Assignee, the Task is
in-progress, and - when the Task names an assigned connector Service - the
writer is that Service's principal. Every other frame is stored unstamped.
The receiver always removes the caller's own payload._taskAssignmentEpoch, so
a caller cannot choose the stamp. Activity reads count only frames whose writer
is still the current Assignee (and assigned Service principal, if any) of the
in-progress Task under the same epoch. Historical unstamped frames never prove
task activity. Reassigning away and back to the same principal cannot revive
old data. The stamp is private storage metadata, not a native session or
attempt link.

A fresh authorized status frame presents active or idle; heartbeat presents
active. Age >= nine minutes derives stale against the server clock. No matching
frame means unknown task activity. A failed authorized read means unavailable,
never idle. Return only coarse state, kind and receivedAt on activity surfaces;
do not expose raw payload or infer worker identity from legacy session fields.
The existing session-status response remains a separate legacy compatibility
surface and still includes canonical runtime evidence; its fallback is not
proof of current task-attributed activity.

The UI work must supply bounded batch/detail reads with shared refresh, hidden
page pause, cancellation, authority-loss and reassignment clearing, consistent
labels and last-observed time. It must not turn lifecycle into liveness. The
adapter must independently check real worker process identity and current task
assignment before emitting; receiver authorization cannot prove a process runs.
The actual worker active-to-stopped/stale proof is observed on a deployment.

## Bounded read surface

GET /tasks/activity?ids=<comma-separated UUIDs> uses the existing tasks:read
ceiling and shared batched task read predicate. Raw input accepts at most 100
ids (duplicates count toward that ceiling), then normalizes UUID case and
removes duplicates. Unknown query fields, repeated ids query arguments and
invalid UUIDs refuse with 400 INVALID_ACTIVITY_IDS. Unauthorized ids are omitted,
not named as denied. Cache-Control: no-store prevents shared response caching.
The same collection supports one task on detail; no new telemetry:read grant.

Response: success, observedAt (server clock), staleAfterMs (540000), activity.
Each authorized item contains taskId, state (active/idle/stale/unknown),
receivedAt (server-received observation or null), kind (heartbeat/status/null).
No raw frame payload, principal, native session, model or usage is returned.
A failed read returns 503 TASK_ACTIVITY_UNAVAILABLE with a fixed safe error.
Activity rows use one query for the bounded authorized set; no per-task loop.

## Visible freshness expiry

The UI subtracts server observation age from the nine-minute freshness window
and anchors the remainder to browser monotonic time at request start. Full
request transit is conservatively charged. A separate local timer changes
active/idle to stale at expiry while a network refresh is pending. Repeated
reads of an identical receivedAt cannot extend its original local deadline.
Client wall-clock changes do not renew freshness. Visibility pause cancels both
refresh and expiry timers and clears the display until a new authorized read.

Each surface refresh has a 20-second deadline. Abort is raced explicitly, so
a transport that ignores AbortSignal cannot park the refresh loop forever or
publish a timed-out late result. Timeout presents unavailable; the next bounded
refresh follows after 30 seconds.

## Board scope, keying and clock skew

The board reads activity only for its visible In Progress cards and shows the
badge only on them. Outside In Progress no worker holds the Task, so nothing is
read and no badge or activity style is shown; hiding presents nothing, which is
not inferring liveness. Task details still reads its one Task.

A surface keys its read on the viewer, the visible id set and each Task's
assignment: the Assignee, the assigned Service, the descriptor version and the
execution profile, the fields that move the server's assignment epoch. A board
update to a card's other fields (status, title, updated time) neither restarts
the read nor clears a row. A row stays shown, with its own local deadline,
until the viewer or that Task's assignment changes or a newer read replaces it;
a Task joining the set starts without a row.

receivedAt comes from the database clock and observedAt from the API process
clock. A receivedAt up to 5 seconds after observedAt is clock skew: it counts
as age zero and never adds lifetime. A row further in the future still refuses
the whole batch.

The badge is a plain element without a role, so it carries no aria-label. Its
words name it: a visually hidden "Task activity: <state>" phrase, and the short
visible word hidden from assistive technology so the state is read once.
