# Assigned Connector claim admission

An authenticated published Connector can claim its exact assigned Task without
an additional positive Account Task WRITE grant. This is a claim-only role:
assignment vehicles remain READ-only, and this role does not authorize Arm,
planning edits, lifecycle writes, service invocation, or native execution.

The Task must be armed, unowned, Todo, and have an active independent Verifier.
Every prerequisite must be semantically completed (Completed, or Archived with
completed disposition). An unknown archived disposition is unsatisfied.
The stored execution Service, descriptor version and normalized profile must
agree; the Connector and pinned descriptor must remain published/live.
The actual authenticated principal must be the Service's Connector, rather
than a descendant, a caller-supplied ID, or a scheduler acting for it.

The ordinary scope/bootstrap gates remain. Every explicit delegated own()
object selector and scope is still a final cap. Parent inheritance skips only
the missing positive Account object WRITE source. Missing expressions, empty
objects, READ-only rules, exclusions and final Agent Task bounds still refuse.
There is no standalone negative Grant, inferred Task WRITE, or automatic Arm.

Read `Task.lifecycleAccess.claim.expectedAssignmentEpoch`, then POST
`/tasks/:id/claim` with `{ "expectedAssignmentEpoch": "1" }`. The MCP tool
`relayhall_task_claim` accepts the same field. CLI `task-claim ID
--expected-assignment-epoch EPOCH` and the Task detail Claim control use it.
Epochs are decimal strings from migration136, not a parallel version counter.

After acquiring the Task row lock, the writer re-resolves the presented
credential, current delegation scopes/role/liveness, object caps, assignment
and epoch. Assignment/owner ABA changes refuse. A retry by the same current
owner accepts its original preclaim epoch or current epoch without another
write, event, readiness change, or generation witness. Release/reassignment
invalidates the old request. Legacy authorized claims without the optional
epoch retain their existing status and event contract. Native invocation
continues to require its own independent authorization.

Real PostgreSQL coverage runs in `npm run test:task-creator-access` alongside
the existing creator tests. The new suite is excluded from the mocked default
and enforced by the same unconditional full-tier CI command. It requires an
explicit disposable database; it never skips or targets a deployment.
