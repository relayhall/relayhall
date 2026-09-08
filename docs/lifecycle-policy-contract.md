# Lifecycle-policy evaluator contract

RelayHall owns the mutation semantics, transaction boundary, authorization,
and append-only decision evidence. An installed evaluator package owns only a
deterministic decision over an immutable, bounded input.

This Phase 2 contract deliberately installs no deployment-specific rule package and no
production gate. RelayHall starts in `off` mode. Later environments may choose
`observe` or `enforce` without changing the service contract.

## Boundary

The service layer invokes the evaluator after authentication and resource
locking, and before the governed mutation commits. Authorization remains a
separate earlier decision; policy cannot grant access or widen a scope.

Inputs contain:

- a stable action and subject kind/id/revision;
- JSON-serializable current and proposed state needed by the rule;
- environment, mode, policy id/version; and
- an optional bounded exception with owner, expiry and covered controls.

The combined JSON snapshots are bounded to 64 KiB before evaluator invocation.

The evaluator returns `allow`, `warn`, or `deny`, stable control/reason IDs,
optional remediation, and small scalar metadata. It receives a deeply frozen
copy. It must not use the network, read secrets, mutate state, authorize a
caller, or emit credentials or object snapshots.

## Modes and failure

- `off`: do not invoke the evaluator and do not write decision evidence.
- `observe`: record the evaluator decision in the caller transaction but allow
  the mutation.
- `enforce`: allow/warn evidence commits atomically with the mutation. A deny,
  timeout, exception, or malformed result fails closed.

An enforced denial is recorded independently in the append-only decision
ledger before the typed denial is raised. The caller then rolls back the
object transaction, leaving both facts true: no object change committed, and
the denial remains auditable. Inputs/current/proposed state are never stored.

An exception applies only while unexpired and only when it covers every
denying control. Expired, partial, or irrelevant exceptions are evidence but
never convert a denial to an allow.

## Phase 2 governed boundaries

The closed manifest in `backend/src/utils/lifecyclePolicyCoverage.ts` binds
the seam to canonical Project, Project Resource, Phase, Task, Skill Version,
and Service/Descriptor creation, transition, promotion, retirement, restore,
replacement, and destructive methods. A source-level ratchet fails whenever
one of those methods loses its service-layer invocation.

Authentication, authorization, grants, history/event appends, notifications,
and ordinary UI state are intentionally outside this policy decision. Adding
one of those domains later requires a new explicit coverage decision; an
evaluator package cannot silently absorb it.

## Versioning and replacement

Every record binds evaluator id/version and policy id/version. Future policy
packages are additive deployable inputs to this seam. Replacing the contract,
changing action meanings, or adding network/secret dependencies requires a
new contract review; ordinary rule changes do not require a RelayHall schema
redesign.
