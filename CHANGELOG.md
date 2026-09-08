# Changelog

All notable changes to RelayHall.

RelayHall is a fresh product: it evolved out of an earlier internal dashboard,
but this repository's history begins with the RelayHall Phase 1 rebuild.
`v1.0.0-beta.1` is the first public release; the entries under it are the
private milestones that roll up into it.

## [v1.0.0-beta.1] — release candidate

The first public beta candidate. It includes clean first-run administrator
setup, local Account passwords with visible save outcomes, and guidance for
choosing Account roles. The features below are integrated. Known limitations
are listed at the end of this entry and in the README.

### Board and projects

- **Tasks** — Subtasks with verifier-owned completion, dependencies,
  priorities, Assignees, typed References, an ordered activity stream, and an
  explicit review/stuck lifecycle.
- **Projects** — a Charter as the project's authority index, Phases grouping
  Tasks under one outcome, and typed Resources (repository, environment,
  workspace, reference) with atomic replacement, revision and If-Match
  concurrency.
- **Reports** — durable handovers and evidence, with archive semantics and an
  optional structured handover object.
- **Visibility** — a Task inherits its Project's visibility, anchored so the
  inheritance follows a live Project rather than a stale reference.

### Identity, authority and governance

- **First run** — while a deployment has no administrator, the sign-in screen
  offers to create the first administrator Account; the act is audited and the
  step disappears once an administrator exists. The dashboard password set at
  install remains as audited break-glass.
- **Accounts and credentials** — Accounts are **keyless**: a person acts
  through a login session and a service Account through its Connectors, and the
  scoped, revocable `rh_` credentials belong to the Connector and Agent layers,
  listed, issued, rotated and revoked on the owner plane.
- **Scopes** — `<objects>:<verb>` with `read / write / use / invoke / admin`
  verbs, the `root` sentinel, fail-closed mapping for unmapped routes, and
  management gates on every registry mutation.
- **Object-level grants and Access profiles** — `(grantee, resource, verb)`
  authority evaluated by one shared predicate, administered on the owner plane.
- **Settings governance** — deployment settings carry their own authority and
  audit trail rather than being edited as free configuration.
- **Single sign-on** — OpenID Connect login and SCIM provisioning against an
  external identity provider, both optional.

### Surfaces

- Dashboard GUI, the bundled `relayhall` CLI, REST with OpenAPI, an
  authenticated WebSocket feed, a cursor event feed and signed webhook
  delivery.
- An authenticated MCP server served in-process, over Streamable HTTP at `/mcp`
  and over stdio, both generated from a single registry of MCP Tools so the two
  transports cannot drift.
- **Idempotency for mutating MCP Tools** — once a call is recorded, an exact
  retry under the same key returns the original result; the same key with a
  different request is always refused; and Agent minting refuses a repeated key
  rather than replaying, because the one-time pack is never stored. Each
  record's scope — credential or principal — is declared per operation and
  enforced at the write. When the record cannot be written the call fails closed
  and names that: the act may have landed while the token did not, so the caller
  is told to re-read and retry with a new token.

### Registries

- **Skills** — the instruction registry with curated starter seeds.
- **Personalities** — five built-in defaults plus board-managed rows;
  board-native, with external collections imported by review.
- **Services** — registered external systems, Connectors, and versioned
  capability descriptors.

### Telemetry and reporting

- A telemetry envelope with a Tier-0 policy engine, ingest derivation and
  descriptor governance, a deployment-wide rate gate, single- and batch-event
  ingest, a governed raw store written by the same statement as the event,
  quarantine with an owner and a quota, and declared retention.
- Sessions and Stats are always-on surfaces that render the presence
  projection built from ingested telemetry. No reporter ships in core and
  the board never reads harness state, so both pages render their
  documented empty state until a reporter feeds them.

### Blueprints

- **Blueprints** — portable, versioned plans in a registry with a draft →
  review → published lifecycle, import and export, an instantiation contract
  with its own ledger, and a separate Warrant-bound setup step. Reachable from
  REST, the CLI and MCP.
- **Phase capture and one-form use** — save a Phase as a Blueprint, carry
  placeholder toggles into the task editor, browse a tile registry, use a
  Blueprint from a single form, follow portable references with access
  warnings, and set up a Blueprint's workflow immediately after creating it. An
  empty plan is refused rather than instantiated.
- **Personality versions** — Personalities carry immutable versions, so a
  Blueprint reference keeps meaning the same instructions it was written
  against.

### The living Map

- One continuous, size-truthful plane carrying Projects, Phases, tasks and
  their dependencies, with persistent Project and Phase backgrounds,
  directional dependency ports, transverse Report attachments, and connected
  Organic territories that keep exact Phase identity.
- Three organizations — Horizontal, Vertical and Organic — on the same plane,
  with a fit-all zoom floor and one level-of-detail model. The earlier Radial
  organization is retired, with a migration for saved state.

### Settings

- **One Settings destination.** Deployment administration and personal
  preferences live together, with concealment decided inside the route element
  by the same match the router uses, and the root check after the session
  check.

### Authorization defects found and closed

Each of these was a real defect in a shipped path, and each now carries a
permanent gate that runs against a real database in CI.

- The board's post-read narrowing loop iterated the wrong shape and had never
  executed, so private tasks were visible on the board page and in its counts.
  The narrowing now rides inside the board query as a required authorization
  scope. (`08f42f36`)
- `/dashboard/summary` and `/activity` ignored the caller and could return task
  titles and counts across Accounts. The dashboard and four sibling read paths
  now take the shared authorization scope as a required parameter. (`72258a60`)
- A role-carrying session could mint an Agent bound to a task it could not
  read. (`45e7110a`)
- Report link and own-Report arms compared the wrong column, so an author could
  not link their own Report and a null value did not fail closed. (`aad1894b`,
  `91af25a6`)
- Task creation and movement did not authorize the target Project, and an
  absent task and an unreadable one gave different answers. (`9c177e6a`,
  `f9b7febe`)
- Two selector-form readers failed **open** on a form they did not recognise.
  (`95572530`)
- The day-one connection wizard could not succeed for the person who created
  the deployment: reachable scopes and delegable scopes are now separated and
  answered per authentication kind. (`6e25ae48`)
- An unthrottled per-request session write could exhaust the connection pool
  and answer a server error on the authorization path; it is now one bounded
  single-flight writer with a ceiling and shedding. (`8491557e`)
- Telemetry projection reads and knowledge board reads take the authorization
  scope as a required parameter rather than filtering afterwards.
  (`50e74c1d`, `0b4b779b`)
- A grant on a Project reaches its tasks and Phases through one inheritance
  rule, anchored to the live Project.

### Identity and first run

- **One Create identity wizard** for Human, Service and Agent identities, with
  the credential shown exactly once, a purpose field for Service identities,
  and *My connections* opening the same component.
- **First run** — while a deployment has no administrator, the sign-in screen
  offers to create the first administrator Account, transactionally and
  audited; a second attempt is refused. The install password remains as audited
  break-glass, with a banner.

### Knowledge broker

- Owner-plane knowledge configuration with a shipped outbound address policy,
  an assertion signer, published verification keys that carry no private
  material, and sealed knowledge handles. Carriers are refused, never decoded.
  The federated fan-out query that consumes them is not in this release.

### Continuous integration

- CI runs in two tiers. The fast tier runs on every push and covers the
  repository and deployment contract, type checking, the mocked suites, the
  frontend build and the accessibility smoke set. The full tier runs on demand
  and covers every gate that needs a real PostgreSQL, every mutation drill and
  every red-proof control. A shape gate requires each gate step to appear
  exactly once across the two workflows, so a gate cannot be dropped or quietly
  duplicated. See [docs/ci.md](docs/ci.md).

### Appearance

- Three built-in Themes — Relay Dark (default), Relay Light and High Contrast —
  with a deployment default and a per-user override, and a WCAG 2.2 AA package
  checked in CI.
- Deployment Appearance: upload-only, metadata-stripped, database-stored brand
  assets behind one validated route, with preview, versions and revert.

### Operations

- A deterministic migration ledger with baseline manifests and fresh-install
  replay proofs, a hardened side-effect-free boot check
  (`RELAYHALL_BOOT_CHECK=1`), release-manifest provenance labels, backup and
  restore helpers, and a self-contained Docker Compose deployment.

### Quality gates

- Terminology gate with an in-CI self-proof; design-token, contrast, theme
  parity, type-scale and brand-asset gates, each with their own self-proof;
  a publication allowlist manifest; residue scanning that fails closed on what
  it cannot decode, with deployment patterns supplied by configuration rather
  than embedded in the published scanner; deployment-safety and publish-gate
  test scripts.

### Verification

- Non-author clean-room verification: the stack deploys from documentation
  alone in a fresh Docker context, migrates to the current ledger tip, and
  passes its hardened boot check.
- Every integrated change carries a cross-family non-author review at its exact
  commit, and the evidence for it.

### Known limitations

Each item carries the identifier of the board item that tracks it.

- Behaviour that appears only under concurrent load has open hardening items:
  connection-pool pressure answering an authorization read with a server error
  (`180030de`), and a task list that returns the whole deployment in one
  response instead of paging (`7104b5c2`).
- The Map's organic layout at large scale is an open area with its own items.
  (`c87d8adf`, `c1f1f7d0`, `943bc78a`, `d7f23707`, `db62e216`, `232dc7b3`)
- Review rounds are owed on parts of the Blueprint engine (`3e36bb05`) and on
  Personality versions (`99ebd2f4`); they close before the release candidate,
  not before this tag.
- Telemetry is received, governed and retained, and the presence projection
  fills Sessions and Stats — but frames are not exported onward to an external
  observability system (`3793117c`) and OpenTelemetry is not received directly
  (`dac2ca71`).
- The knowledge broker ships configuration, outbound policy, signing and sealed
  handles; the federated fan-out query that uses them is not in this release,
  and an owner question on the signing rule is open. (`0b4b779b`, `e21163fc`)
- Groups, grants and Access profiles are administered by the deployment's own
  authority, and directory groups arrive over SCIM with a remote-group
  catalogue. The member, manager and admin lenses — delegated group stewardship
  — are deferred. (`4e159741`, `21a682ca`)
- Non-escalation — that an administrator cannot grant authority they do not
  hold — is enforced by the owner plane and by review; the automatic enforced
  arm on grants, groups and Access profiles is post-v1. (`3e76cfcc`)
- The Audit ledger is real and reachable, and the Audit page is bound to it;
  live accessibility checks still find violations the committed gates miss, all
  of them tracked. (`85f554ef`, `aaee6a54`)
- The *Sessions* label is unqualified vocabulary in a deployment that carries
  both agent sessions and login sessions. (`5045492a`)
- A set of open items records a gate or test that could pass while the property
  it guards is broken — a census a determined author could step around, an
  assertion that measures less than it claims. These are control strength
  rather than known product defects, and they are the substance of the
  hardening walkthrough that gates the release candidate. (`b5d265c3`)
- Known-but-integrated control defects, accepted with the defect named:
  a defeatable settings seed census (`71108f97`), parity coverage that does not
  yet span every board lifecycle status (`c880e757`), a route-family census
  that drops a nested router prefix (`2c000125`), one flat non-object segment
  list (`7a6666d8`), a lexically bypassable authentication-method census
  withdrawn rather than patched again (`d9663db6`), a role-atomicity double
  that proves statement order rather than rollback durability (`1ff5f133`), and
  a brand-gate title rule that is a literal substring test rather than the
  accessible name (`a7923589`).
- After Project-level access, an archived Project still confers visibility on
  its Phases but no longer on its tasks — an open owner decision. (`9f9df4e0`)
- The login session is carried by a `Secure` cookie, so signing in as an
  Account needs HTTPS or `localhost`. Over plain HTTP at a LAN address the
  first-run administrator is created but cannot sign in, and only the
  deployment password works. (`c052915b`)
- No formal external accessibility audit has been performed; the AA package and
  its automated checks are what stand behind the accessibility claim. This one
  is a ratified scope decision rather than an open item (design record
  `9f01ba4b` §10, decision D22).
## [Phase 1] — private

The pre-release milestones, kept for provenance.

### Product

- **Board core** — Tasks (with Subtasks, dependencies, references, an explicit
  review/stuck lifecycle and verifier-owned Subtask completion), Projects with
  typed Resources (repository, environment, workspace, reference — atomic
  replacement, revision + If-Match concurrency, provenance-led migration),
  Reports with archive semantics, Skills (the instruction registry, curated
  starter seeds), Personalities (five built-in defaults plus board-managed
  rows; board-native — external collections are imported by review, and the
  earlier repository-sync surface was removed), Principals and scoped,
  revocable Credentials (`rh_` keys), and an audit-friendly identity model.
- **Authority model** — scopes as `<objects>:<verb>` with `read / write / use /
  invoke / admin` verbs, the `root` sentinel, fail-closed scope mapping for
  unmapped routes, and management gates on every registry mutation.
- **Surfaces** — dashboard GUI, `relayhall` CLI, REST with OpenAPI, and a
  stdio MCP server, kept in deliberate parity.
- **Operations** — deterministic migration ledger with baseline manifests and
  fresh-install replay proofs, a hardened side-effect-free boot check
  (`RELAYHALL_BOOT_CHECK=1`), release-manifest provenance labels, and a
  self-contained Docker Compose deployment.

### Quality gates

- Terminology gate with an in-CI self-proof; design-token existence gate with
  an in-CI self-proof; publication allowlist manifest; residue scanning with
  deployment patterns supplied by configuration rather than embedded in the
  published scanner; deployment-safety and publish-gate test scripts.

### Verification

- Non-author clean-room verification: the stack deploys from documentation
  alone in a fresh Docker context, migrates to the current ledger tip, and
  passes its hardened boot check; documentation gaps found by that exercise
  are tracked and repaired before the first public release.
