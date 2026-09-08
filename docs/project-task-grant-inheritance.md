# Exact Project Grants on Tasks

Owner-approved contract: report `0e6f09a0-4b15-4f2b-a05f-ed5e11d93d36`,
authorization recorded in `6b8ac081-4524-4930-b9b4-9e841d5e7445`.

A live Grant on one Project supplies resource authority on its unrestricted
Tasks. The Task must name that Project in its own `project_id`, and the Project
must still exist with status `active`.

| Project Grant | Task authority supplied |
| --- | --- |
| `read` | Ordinary Task read |
| `write` | The existing Task write Grant mapping, including read |
| `admin` | The Task read/write subset only |

Task or referenced Phase restriction disables this new source. Existing exact
Task Grants, Task roles and visibility sources keep their semantics. Project
wildcard Grants, Project Access Profiles, Project ownership and Phase Grants
do not become Task authority sources.

The existing Grant evaluator checks direct Grants, current Group membership and
expiry. Revocation, removal of membership and principal liveness changes apply
on later requests. No Task Grant is copied or materialized; Task ownership is
unchanged. Tasks created or moved later use their current Project coordinate.

The canonical authorization service composes this source inside each principal's
authority expression. Route scopes, role/action ceilings, delegation link object
limits and the final Agent bound-Task write limit still apply. No Task admin,
Shepherd or Verifier authority is inherited. Arming and other ordinary writes
still require the existing workflow and execution checks.

Point checks and SQL list scopes use the same predicate. SQL filtering therefore
precedes pagination and aggregation. The selector-only boundary used by knowledge
consumers also retains the exact Grant source while removing its separately
governed visibility and administrator shortcuts.

This does not change credential issuance. Its conservative containment algebra
still requires explicit evidence for requested Task selectors and verbs. An
Agent's existing bound-Task context read is an independent authority source and
must not be mistaken for residual Project inheritance after revocation.

No Phase, Report, Skill or Service inheritance is introduced. Project creation
defaults and Blueprint behavior are governed separately; this authorization
change creates no Grants and assigns no roles.

## Verification

`npm run test:project-task-inheritance` in `backend` is a mandatory real-PostgreSQL
gate. It fails when `RELAYHALL_TEST_DB_URL` is missing or does not name an explicit
local disposable database. The only non-local exception is the existing
`postgres` CI service with `CI=true` and database `relayhall_ci`. It runs
unconditionally in the full CI tier (`ci-full.yml`, job `live_gates`, on both
forges) and is excluded from database-free Jest. It carries no `if:`: nothing
in the full tier does.

The suite uses production authentication and protected routes with synthetic
Accounts, issued Connector credentials and ordinary Agent mint operations.
Step-up tokens are provisioned through the canonical service; this is automated
authority verification, not human password-entry acceptance. Schema and issuer
constraints stay enabled.

`python3 scripts/project-task-inheritance-mutations.py --describe` lists the
named production-source controls without opening a database. With an explicit
disposable URL, pass `--output-dir` outside the repository to execute baseline,
semantic failures and restored controls. The driver modifies only its own copied
source, fingerprints all copied runtime inputs, rejects unrelated failures and
removes the copy. It never starts or stops PostgreSQL.
