# Changelog

All notable changes to RelayHall.

## [v1.0.0-beta.102] — public beta

### About and the sign-in page: the product links are live in every build

- The licence, source, documentation, Blueprint authoring and use guide and
  report-a-problem links on About, the GitHub link in its footer, the licence
  and source links on the sign-in page and the Blueprint guide link on the
  Blueprints page are links in every build. The `VITE_PUBLIC_BUILD` build
  variable that kept them as plain text ("Private working repo", "GitHub:
  linked once published") until the public repository existed is retired from
  the dashboard, the image build and `.env.example`. A leftover line in an
  older `.env` is ignored. The source link is labelled "Source".

### First install: the public address, an honest sign-in screen, named refusals and the upgrade path

- An onboarding pack names the address the browser used, port and scheme
  included. The frontend's nginx forwarded the host without its port and its
  own `http` scheme, so an install on `:8082` handed out
  `http://localhost/api`, and one behind a TLS proxy `http://` on an https
  port. It now forwards the `Host` header as it arrived and the scheme an
  outer proxy declares (`https` or `http` only). `RELAYHALL_PUBLIC_API_URL`
  and `TRUST_PROXY_HOPS` are documented and passed on by
  `docker-compose.yml`; left unset, nothing changes.
- `./setup.sh` asks for the public address (host name, scheme and port; by
  default `localhost`, `http` and the frontend port), writes `CORS_ORIGIN`
  from it, and for `https` also `RELAYHALL_PUBLIC_API_URL`. `DOMAIN`, which
  nothing read, is gone. An answer script for the previous questions still
  works. Keeping `.env` (the upgrade path) now ends with
  `docker compose build --pull` and `docker compose up -d --wait`, instead of
  a bare `up -d` that restarted the old images without migrating.
- An install from this tree builds the public presentation
  (`VITE_PUBLIC_BUILD=true` in `.env.example`): the sign-in page and About
  link the source, licence and documentation instead of showing "Private
  working repo". A build that does not read `.env` keeps its default.
- The sign-in and first-run screens say plainly, before anything is sent,
  when the browser reports an insecure origin: Account sign-in needs HTTPS
  or `localhost`, and an administrator created there could not sign in from
  that address.
- A board without a credential key set answers the first connection with
  `503 CREDENTIAL_KEYS_NOT_CONFIGURED` and tells the operator what to run,
  instead of a 500; Connect your agent says the same in its own words.
- The backend refuses to start with the `.env.example` placeholders for
  `JWT_SECRET` or `POSTGRES_PASSWORD`, naming the variable and the fix.
- `relayhall --version` prints the checkout's version. `/favicon.ico` is
  served instead of logging an error.
- `DEPLOYMENT.md`: a Domain and TLS section with a Caddy site and an nginx
  server block; the ordinary upgrade by tag, with the port from `.env`, the
  release build arguments, a comparison of `.env` with `.env.example` and a
  backup of the key sets wherever they live; the tested rollback for a
  schema-changing release; a restore drill into a scratch database; and
  removing the data directory under rootless Docker. The old development
  records under `docs/design-history/` and `.env.dev.example` are no longer
  in the tree.

### A fresh install provisions its key sets; the config file is readable by the backend; a second stack on one host is documented

- `setup.sh` generates the backend's four key sets once, with random values,
  into `relayhall.keys.env` (mode 600, ignored by git): the credential envelope
  keys, the telemetry pepper, the knowledge handle keys (32 bytes each, base64)
  and the knowledge assertion key (Ed25519, PKCS#8 DER in base64), each as a
  JSON object with its active id. A fresh install no longer answers its first
  credential issue with an error, and telemetry, MCP session records and
  knowledge search work from the start. No value is printed.
- A key is never regenerated or overwritten. Before it generates a set,
  `setup.sh` asks `docker compose config` what the backend would receive, so a
  value supplied another way (an override file, the shell, an operator's own
  `env_file`) is kept; a complete pair set by hand in `.env` is copied into the
  keys file unchanged; half a pair, or a value an override blanks, is refused.
  Re-running `setup.sh` on an install that has keys leaves them byte-identical;
  on an install from before this release (answer `no` to reconfigure) it adds
  them.
- `docker-compose.yml` passes the file to the backend as an optional
  `env_file`. Without the file the backend environment is exactly what it was,
  and an operator's own values still win. This needs Docker Compose 2.24 or
  newer (the README's requirement moves from 2.20).
- `setup.sh` makes `relayhall.config.json` readable by the backend's runtime
  user (mode 644; the file holds no secrets). It was written 600, so the
  backend silently ran on built-in defaults; a re-run repairs an existing file.
- `DEPLOYMENT.md`, the README and the getting-started guide document the key
  sets (install, backup apart from the dumps, upgrade) and running a second
  stack on one Docker host (`COMPOSE_PROJECT_NAME`, `POSTGRES_HOST_PORT`,
  `BACKEND_PORT`, `FRONTEND_PORT`, `CORS_ORIGIN`).
- `scripts/configure-github-repository.sh --protect` requires the four main
  fast-tier jobs by their current names (the retired `Backend build and tests`
  context could never report): `Repository and deployment contract`,
  `Backend type check and mocked tests`, `Frontend build and tests` and
  `CLI tests`. The Frontend unit-test shards and `Changed areas` are not
  required: a skipped matrix job reports under an unexpanded name that no run
  satisfies. `scripts/test-github-config.sh` derives the non-matrix jobs from
  `.github/workflows/ci.yml` and fails when the list differs, and refuses a
  list with a shard added or a main job dropped. `docs/publishing.md` and
  `docs/ci.md` say why.
- New contract steps run `scripts/test-first-install.py`: `setup.sh`
  non-interactively in a temporary directory against the real
  `docker compose config`, and nine mutants that must each turn it red.

### A body length limit counts characters, not UTF-16 units; the current-page test fails on the highlight itself

- A text field with a `maxLen` rule in a request body (the Report `title`,
  `summary` and `author`, and every other route that uses the shared body
  validator) is now measured in characters, the way the database columns and
  the Task routes measure them. A 500-character Report title made of emoji was
  refused with "must be at most 500 characters" because each emoji counted as
  two. Nothing that was accepted before is refused now, and the 501st
  character is still refused whatever its width.
- The sidebar's current-page test checks the highlighted entries before the
  announced page, so the earlier two-highlight bug fails on the highlight
  itself; the UI mutation drill gains a second control that restores the
  per-link character-prefix rule, which lights two entries.

### Universal change requests: the object targets (owners, default Verifiers, Charter, goal, roles, access and visibility on Projects, Phases, Tasks and Reports)

- Eleven more change-request targets, filed on both doors and over MCP, each
  about ONE object named by `targetId`: `project.owner`, `task.account_owner`,
  `report.account_owner`, `project.default_verifier`, `phase.default_verifier`,
  `charter.revision`, `phase.goal`, `task.roles`, `task.access`,
  `phase.access` and `report.visibility` (opening a closed Report only). Root,
  an administrator or the object's owner files them; `task.account_owner` is
  root's or an administrator's alone. Each is approved as filed or denied.
- The decision applies each one through the executor of its direct act, with
  the DECIDER as the acting principal: the Project and Task ownership acts on
  the decider's own session (a move into or out of a Group by root or an
  administrator, taking the decision's one step-up as its evidence), a new
  executor for a Report's account owner, the default-Verifier seam both
  direct routes now share, the Charter approval act (content and approval in
  one act, the decider the approver; a Group owner through the Group-owner
  arm with the decision's step-up), the Phase and roles writers, and the two
  access writers. Restricted access and Report visibility gain their first
  audit rows (`task.access.set`, `phase.access.set`, `report.visibility.set`).
- Authority never widens: before applying, the decider's own live reach on
  the object is checked at the action its direct door asks
  (`403 DECIDER_CEILING_EXCEEDED`, the step-up unspent); the principal a change
  puts on the object never decides it; the object's state and owner are
  re-read under its row lock at decide, and any difference lapses the request
  `TARGET_CHANGED`. The preview answers the object targets for a Project,
  Phase, Task or Report. The decide form names each target in words.
- The full tier's `test:change-request-targets` now runs the new object-target
  suite beside the identity one, and its mutation drill gains their controls.

### Agents can read the owner's Action Center queue: a read-only MCP tool and CLI command

- New read-only MCP tool `relayhall_action_items_list` (introspection plane, so
  it answers before bootstrap like the other reads) and CLI command
  `relayhall actions [list] [--kind] [--json]`, over the new
  `GET /notifications/actions/owner`. For a person's own Connector, or an Agent
  under it, they list the Decision, Verify, Stuck and Skill-review items that
  wait on the person's Account, as well as the caller's own, with the person's
  seen state, so the person can review and discuss them with any agent. The
  Account's items come from the Action Center's own code (one source: the same
  predicates and caps, not a copy).
- Each item gives its kind, the Task or approval id, how long it has waited and
  the board link. Its title, Project name and reasons appear only where the
  caller can read the Task (or Skill) it points at; otherwise the item is kind
  and id only. A Decision gives just its Task's title: the approval's kind and
  requester are kept only for a caller that can open the approval itself, which
  a Connector or Agent cannot. The queue never widens what the caller can read.
  An item's seen state is the person's mark for the Account's items and the
  caller's own mark for items only the caller holds.
- Read only: no decide, no mark-seen, no write of any kind over MCP or the CLI;
  acting on an item stays on the board, with step-up where the act needs it.
  Any other credential is answered with its own list, as before. New full-tier
  live suite `npm run test:action-items-owner` and its mutation drill
  `scripts/action-items-owner-mutations.py`.

### Phone toolbars: icon-only Search and a visible label for every icon-only button

- On a phone, a native tooltip never shows, so the icon-only buttons of the
  Tasks header and the Map toolbar had no visible name. Press and HOLD any of
  them (about half a second) and a small label appears next to it: Board and
  Map, Search, More, New task, and on the Map zoom out, zoom in, fit, Re-pack
  layout, Show as list and Map and list. The label goes when you let go, when
  the pointer leaves, when focus moves away, on Escape or when anything scrolls.
  The long press itself does nothing else: it does not press the button, and
  the browser's own text selection and long-press menu are suppressed. A mouse
  resting on a button at phone width, and keyboard focus, show the same label.
  It is one shared component (`LabelTip`): a `role="tooltip"` bubble that points
  at its button with `aria-describedby` only while it is shown (and only when
  it adds words the accessible name does not already say, so a screen reader
  never hears a name twice), kept inside the screen (centred above the button,
  below it when there is no room, clamped at the edges), in the theme colours
  at 4.5:1 or better in all three themes, and it never moves anything.
- Search is now icon-only on a phone (its name, "Search and filter", is kept
  for screen readers and shown by the long-press label), so the Tasks header
  line no longer reaches under its edge fade: at 375 px it was 11 px too wide,
  and at 320 px 24 px too wide, which left More partly hidden at rest. The
  hamburger's indent now belongs to the title only, so the row of controls that
  wraps under the title may use the full width.
- Wider than 768 px nothing changes: the label, the icon-only Search and the
  indent are all phone rules, and the native tooltips stay as they were. Checked
  pixel for pixel against the previous release at 1280, 1024 and 769 px in the
  relay-dark, relay-light and high-contrast themes.
- The phone census (`scripts/mobile-overflow-census.mjs`) now also reads every
  control of the Tasks header clear of the fade at rest, Search icon-only with
  its name, and a real long press (touch input) on every icon-only button of
  both rows at 375 px and 320 px: the label shown, inside the screen, nothing
  moved, no click fired, gone on release, shown by a resting mouse and by
  keyboard focus, and the label read in all three themes (contrast and axe).
  Frontend only, no migration.

### Fast tier: the Frontend unit tests run as three parallel shards

- The fast tier's critical path was one serial step: `npm run test:unit`, a single
  vitest worker over every unit-test file, 628 s on 22 October 2026 and 852 s on
  24 October inside a Frontend job of about 1250 s. The same files now run as
  three jobs of the new matrix `frontend-unit` (`Frontend unit tests (shard 1 of
  3)` to `(shard 3 of 3)`), in parallel with the `frontend` job, which keeps the
  type check, the build, the boot-hash pin, the axe smoke set, the Blueprint and
  feature-area proofs and the timezone control. Each shard keeps the command
  shape of the serial step (`NODE_ENV=test`, forks, one worker). Measured on one
  build host: 349.8 s for the serial step; 120.4 s, 124.9 s and 125.0 s for the
  three shards (232 files, 3,416 tests in both, the same files and the same
  counts); the unit tests now cost the slowest shard, not the sum.
- Nothing is tested differently, and that is proved rather than assumed.
  `scripts/frontend-test-shard.py check` (a step of the `frontend` job) takes the
  file list from vitest's own Node API, with the exclusions read out of the
  `test:unit` script, and requires every file to be in exactly one shard: a gap,
  an overlap, a foreign path and an empty shard are each refused, and then it
  asks vitest what each shard's filters actually select (a filter is a substring
  match, so `a.test.ts` would also select `a.test.tsx`) and requires that to
  equal the assignment. Each shard repeats that selection proof for itself before
  it runs. The assignment is computed, not listed: a new test file is placed the
  moment it exists. `scripts/frontend-test-shards.json` holds only a measured
  cost per file, used to balance the shards, regenerated by
  `frontend-test-shard.py weights --report <vitest json report> --write`;
  missing or stale costs affect balance only and print a note.
- `scripts/test-frontend-test-shard-gate.py` (a step of
  `repository-contract`, no node needed) is the control: one defective plan per
  failure class, each required to go red in its own class, and a correct plan
  required to pass. Rule 10 of `scripts/check-workflow-shape.py`, with its own
  cases in `scripts/test-workflow-shape-gate.py`, holds the workflow side: the
  matrix is exactly the declared shard list with no `include` or `exclude`,
  `fail-fast: false`, the shards have the same `needs` and `if` as `frontend`, the
  shard step is the one command cut for the declared count, and no job still runs
  `npm run test:unit` serially. Three gate names joined `scripts/ci-gate-steps.txt`;
  the two workflow copies stay byte-identical; the Frontend job keeps its name.
  `docs/ci.md` describes the shards, how to rebalance and how to change their
  number.

### My connections: the credential actions say what they touch

- On a connection's Advanced tab the red button used to read "Disable" and, with
  one press, revoked only the credential picked in "Credential to edit" - while
  it read like a switch for the whole connection. It now reads "Revoke this
  credential", and one press only opens an in-page confirmation that names the
  credential (label, key id, transport and full id) and says: calls using it
  will be refused, the connection's other credentials are unchanged and the
  connector stays enabled. A second, explicit press ("Yes, revoke this
  credential") revokes it; Cancel and Escape back out and post nothing. Focus
  moves into the confirmation when it opens and returns to the button when it
  closes. The word "disable" no longer describes a single credential anywhere
  on the tab; disabling a whole connector is unchanged where it lives (People).
- A connection that holds more than one credential now starts the picker on
  "Choose a credential..." instead of guessing the first live one, and Revoke,
  Regenerate and the permissions entry stay unavailable until one is picked.
  A connection with exactly one credential stays preselected. A pick that later
  vanishes still never silently switches to another credential. Setup keeps
  showing its instructions without a pick.
- "Regenerate credential" now says, under the buttons and in the notice after
  it, that it replaces the secret of the picked credential only, that the old
  secret keeps working for 24 hours (the request now sends that window
  explicitly; it is the board's default), and that it is not a revoke. The
  notice names the NEW key id the one-time secret belongs to and the key id it
  replaces, and the button is available only for a live credential (a replaced
  or revoked one is refused by the board anyway).
- The confirmation's "Yes, revoke this credential" button is locked while the
  row is busy, like the button that opened it. When a picked credential has
  vanished after a refresh, the scopes section says to choose another one
  instead of claiming no credential exists.
- Frontend only: no route, scope, migration or backend change. The audit reason
  stored on a revoke now reads "revoked by its owner from My connections".

### The connector's ring: wake, catch-up, local policy and unattended runs

- `relayhall connector run` becomes the connector's long-running daemon when
  the connector's folder holds an enabled `ring.json`. It holds the board's
  wake socket (`?wake=2`) with its own token in the header, acknowledges each
  wake at once and reports what it did on the same socket (`wake.outcome`:
  started, finished, refused or notified, with a reason code). On every
  reconnect and every five minutes it catches up from the event feed
  (`task.ready`) and from its Verify and Stuck action items; work found that
  way is reported as a `connector.trigger` telemetry event.
- The local policy fails closed: the kinds it acts on, at most four runs at
  once, the working folder each Project maps to, a local hold, and a guard
  that never lets the connector verify work its own service or Agents did.
  `stuck` only ever notifies.
- An `implement` run (and a `verify` run for a service Verifier) mints a
  task-bounded Agent under the connector's Warrant, with the role's scopes and
  never more than the connector holds, claims the Task as that Agent, starts
  Claude Code (`-p --output-format stream-json --strict-mcp-config`) or Codex
  CLI (`exec --json --ignore-user-config`) with a configuration that holds only
  the run's own proxy, supervises it (deadline, whole process tree ended,
  named exit outcomes), writes the run's summary to the Task with credentials
  redacted, and revokes the Agent. The Agent's credential lives only in a
  private run folder that is removed when the run ends. Without a Warrant the
  mint becomes a pending Approval and the person is told once.
- The minted implementer Agent claiming a Task assigned to its parent connector
  is now proven on a disposable board (`npm run test:bound-agent-claim`), as is
  why the alternative (the connector claims, the Agent works) cannot hand back.
- Windows toasts name only the Task's short id, the kind and the board link.
- `check` now validates `ring.json`, reads the wake status frame and says when
  the registered task still has the old fifteen-minute limit; `status` shows
  the ring. The per-user task no longer has an execution limit (a run lives in
  the daemon); the one-cycle run ends itself after fifteen minutes instead.

### Antigravity in the local connector, a wider harness token, and a read boundary for new connectors

- **The harness token has sixteen scopes.** The Claude Code, Codex, VS Code
  and Antigravity templates of Connect your agent now also mint
  `knowledge-contents:read` (research through the board's knowledge sources),
  `personalities:read`, `blueprints:use`, `projects:write` and `phases:write`.
  `blueprints:use` is not read-only: it previews and instantiates a published
  Blueprint, which creates Tasks. It is not `blueprints:read` (no version
  history or ledger). Instantiating also needs `projects:write`, and
  `phases:write` for a Blueprint with Phases, so a new harness token
  instantiates a Blueprint, Phases included, and does not only preview it.
  Those two are the ordinary write verbs of Projects and Phases, not
  Blueprint-only: object grants decide which ones the connector may write.
  Still never `root`, an `:admin` scope or `services:write`. The local
  connector's `check` asks for the same sixteen; a connection made earlier
  keeps its credential unchanged until it is widened on the Credentials page.
- **`relayhall connector install --harness antigravity` writes Antigravity's
  MCP config.** One stdio server entry, `relayhall`, in
  `~/.gemini/config/mcp_config.json`, recognised by its marker field
  `env.RELAYHALL_CONNECTOR`. Before changing an existing file the installer
  copies it, byte for byte, beside it (`mcp_config.json.relayhall-backup-<UTC
  timestamp>`, owner-only where the platform allows), unless the file holds
  another credential, which is never copied: the installer then writes its
  entry without a backup and says so. That holds whatever the credential's
  field is called, including a long name such as
  `mcpServers.context7.env.CONTEXT7_API_KEY`. A second run changes
  nothing and makes no second copy; other servers and keys keep their values and
  order; a file with comments, trailing commas or a key given twice is refused
  before anything is written; `uninstall` removes only the `relayhall` entry
  (and puts back an entry it replaced). The entry starts the local proxy and
  holds no token.
- **`relayhall connection-skill install --harness antigravity`** writes the
  connection skill to `~/.gemini/antigravity/skills/relayhall-connection/`,
  Antigravity's global skills folder; `connector install` does the same.
- **New connectors read the board and their own folders only.** The bootstrap
  prompt gains one line, and the reviewed source of the
  `relayhall-connector-bootstrap` Skill the same sentence as a ground rule:
  read the board through MCP and the connector's own folders (its MCP entry,
  its local connection skill and its state folder); never the owner's private
  working set, other sessions' scratchpads or other hosts. When the local
  connection skill is missing, the Skill asks the person to install it and
  reports the gap instead of looking for a checkout. The
  Skill's new text reaches connectors once an administrator publishes it as the
  next Version (see docs/connector-onboarding.md). No migration.

### Phone toolbars: icon-only Map buttons, the task count first, New task never cut off

- On a phone, the Map view's Re-pack layout, Show as list and Map and list are
  now icon-only buttons (the same icons as before, 44 px squares). Their words
  stay as the accessible name, so a screen reader still hears "Re-pack layout",
  "Show as list" (or "Show as map" while the list is shown) and "Map and list",
  and each button carries a tooltip with the same words. The scrolling line is
  about a quarter shorter (908 px instead of 1198 px of controls), and the "N tasks in view" count now stands at the
  start of the line, so it is seen without scrolling at 375 px and 320 px
  instead of at the far end of a line about three screens long.
- On the Tasks page, New task was cut about 7 px under the edge fade at 375 px
  until you scrolled the header line. It now stands BESIDE the scrolling line,
  at the end of the header, and is never part of it: it is fully visible at
  375 px and at 320 px, clear of the fade. The view switch, Search and More
  still scroll as one line next to it, and the tab order is unchanged (New task
  is still last).
- The edge fade of the header line is now clipped to its padding box, as the
  Map toolbar's is, and the 44 px touch size now holds for both rows up to
  768 px (the segmented options and the compact buttons were 36 px at exactly
  768 px).
- Wider than 768 px nothing changes: the new header wrapper has no box of its
  own there, and every new rule sits in the narrow-screen block. Checked pixel
  for pixel against the previous release at 1280, 1024 and 769 px in the
  relay-dark, relay-light and high-contrast themes.
- The phone census (`scripts/mobile-overflow-census.mjs`) now also reads the
  rows at rest: New task fully visible and clear of the fade, the count seen
  without scrolling, the three buttons icon-only with a real accessible name
  and a tooltip, the touch floor (also at 768 px) and an axe-core pass. Frontend
  only, no migration.
### Verification modes per Task: human, service or none

- Each Task now reads a verification mode. `human` and `service` follow from
  the Verifier (a person, or a `service` principal or an Agent named as
  Verifier) and are never stored. `none` is the one stored choice (migration
  170): the Task has no Verifier, and its finish completes it straight away, so
  the next Task in a chain can read the Report and carry on. Only the final
  result of a long automated chain then needs a person to verify it.
- Who may set `none`: the Task's Shepherd, an administrator or the Account,
  never an Agent and never a principal of the implementing chain. It is set at
  creation (`POST /tasks` and `relayhall_task_create` take
  `verificationNone: true`; an inherited default Verifier is displaced and the
  displacement is audited) or with `PATCH /tasks/{id}/roles`
  `{"verificationNone": true}` while the Task is To Do and has never started.
  Assigning a Verifier clears it, and once cleared it cannot be set again.
  Every set and clear is an audit row and a Timeline entry.
- `POST /tasks/{id}/finish` on a `none` Task completes it in the same
  transaction, completes Subtasks waiting in Review, and makes dependent Tasks
  ready, which also rings their connector. A setter that shares the
  implementing chain is refused at finish (`VERIFICATION_NONE_SELF_SET`). A
  move to Review on a `none` Task is refused. An assigned connector can claim a
  `none` Task with no Verifier. A `none` Task is never listed as "without a
  usable Verifier".
- A `service` Verifier can verify through a task-bounded `verifier` Agent
  minted under its own live Warrant. The chain guard means a connector, or one
  of its Agents, never judges work its own chain did. The guard covers the
  execution connector, everyone who ever claimed or handed back the Task, and
  every implementer Agent, together with their chains. A person who is the
  Verifier is never refused.
- The dashboard shows a "No verification" badge on the Task card and the Task
  page, and the mode beside the Verifier. The Blueprint preview flags each
  `none` Task and warns when no Task in the chain is verified. A Blueprint
  Task may carry `"verification": "none"`.
- The connector wake: a connector is never rung to verify a Task in its own
  chain (the same guard). A connector with any wake=2 socket open is rung for
  verify and stuck. A native-review verify wake is rung once per review.

### The Map view's controls are one sideways-scrolling line on a phone

- On a phone the Map view's control area wrapped onto five rows and took about
  half the screen above the map: zoom out, zoom in and fit, Re-pack layout,
  Horizontal and Vertical, the Reports Collapsed and Expanded switch, Show as
  list, Map and list, and the task count. At 768 px and below they are now ONE
  line that scrolls sideways inside itself, the same way the Action Center
  tabs do. The page never scrolls sideways, every control keeps its label and
  its place in the tab order, a soft edge fade shows on the side where more
  controls are hidden, and the count sits at the end of the line. Every control
  stands at the 44 px touch size and on one shared top edge.
- A control that takes focus (keyboard, switch or screen reader) is scrolled
  fully into view. A browser leaves a control that is half hidden at the edge
  half hidden; the toolbar rows now bring it in, moving only the row (never the
  page).
- The same fault was checked on the Tasks page at 375 px and 320 px: the view
  switch, Search, More and New task wrapped, with New task dropping onto a row
  of its own. They are now one line that scrolls inside itself as well, and the
  More menu still opens in full under its button instead of being clipped by the
  scrolling line. The board's status tabs already scrolled; they now share the
  focus-into-view behaviour.
- On screens wider than 768 px nothing changes: every desktop rule is untouched
  (the phone rules sit in their own narrow-screen block), checked pixel for
  pixel against the previous release at 1280, 1024 and 769 px in the relay-dark,
  relay-light and high-contrast themes.
- `scripts/mobile-overflow-census.mjs` now reads the Tasks page in Board and
  Map view (with the Map's recorded graph) and fails when a named control row
  wraps, is clipped without scrolling, or leaves a control out of reach. Frontend
  only, no migration.

### The local connector: `relayhall connector install | check | status | uninstall` on Windows

- **One install line now does the install.** `relayhall connector install
  --harness <claude-code|codex|vscode|antigravity> --board <origin>` asks for
  the connector's token once at a hidden prompt (or one line on stdin with
  `--token-stdin`), never from the command line or the environment, checks it
  against the board (whoami and an MCP `initialize`, HTTPS only), and stores it
  with Windows DPAPI in the CurrentUser scope under
  `%LOCALAPPDATA%\RelayHall\connector\<name>\`. It refuses the global `--token`
  and ignores `RELAYHALL_TOKEN`.
- **The client never holds the token.** Install writes the client's MCP entry
  (Claude Code `.claude.json`, Codex `config.toml` in a marked block, VS Code
  `mcp.json`) to start `relayhall connector mcp --name <name>`, a stdio MCP proxy
  that reads the token from custody and forwards each message unchanged to the
  board's `/api/mcp` with the bearer. The proxy never follows a redirect and
  never writes the token to disk, stdout or stderr. Antigravity's configuration
  is not edited yet; the entry is printed instead. An earlier entry under the
  same name is kept alone (never a copy of the whole file) and put back on
  uninstall; an earlier entry that carries a credential (an `Authorization`
  header, a bearer, an environment token, anything shaped like a secret) is
  never replaced: install names the file, entry and field, never the value,
  and says plainly when it is the very token being installed (do not revoke
  it). A file that cannot be rewritten safely is refused before anything is
  stored, and a connector keeps the `--alias` it was installed with until it is
  uninstalled. On a loopback board the connector never uses an environment
  proxy, and a reply cut off on the wire still gets a JSON-RPC error.
- **A per-user sign-in task.** Install registers `RelayHall Connector <name>`
  in Task Scheduler for the signed-in user only, least privilege, no
  administrator rights, restarted on failure. In this version the task's
  `relayhall connector run` confirms custody and exits; the usage collector and
  the wake receiver come in later releases.
- **`check`, `status`, `uninstall`.** `check` verifies custody, the board, the
  principal, the harness scope set and an MCP round trip through the real
  proxy, and exits 0 only if all pass. `status` prints names, ids and states.
  `uninstall` removes exactly what install recorded and nothing else.
- **macOS and Linux** are refused with a clear message (exit 3), by every
  verb, until their keystores are supported; set those clients up by hand.
- **Dashboard.** Under the install line the manual configuration blocks now
  fold into one closed "Set up by hand instead" disclosure that says they put
  the token in the client's configuration, and the install copy says what the
  installer does and where it runs. A session that cannot delegate part of the
  harness set is told which scopes the token will lack, by name, and the
  authority sentence counts against the whole set.
- No migration, no backend change.

### One connector per harness: the Connect your agent wizard makes one token and a published connector

- **Four harness templates.** Claude Code, Codex, VS Code and the new
  **Antigravity** each make one connector with one token. The token is pinned
  `any` (it works on the REST routes and on MCP) and carries the agent working
  set plus `telemetry:write`, `services:read` and `principals:read`, so one
  credential can serve MCP, report presence and usage quotas, and mint
  task-bounded Agents. It never carries `root`, an `:admin` scope or
  `services:write`, and the wizard offers that set and nothing above it. Generic
  MCP client, API script and the messaging gateway are unchanged.
- **Published on creation.** The wizard registers the connector with its first
  descriptor (telemetry tier and product: `full` for Claude Code and Codex,
  `presence` for VS Code and Antigravity) and publishes it in the same call. The
  wake needs exactly one published service per connector and quota reports need
  the declared product, so a harness connection no longer starts as an
  unpublished draft that has to be repaired by hand. Registration, descriptor and
  token commit together or not at all.
- **One install line.** The last wizard step leads with
  `relayhall connector install --harness <harness> --board <origin>` and shows
  the token once, in its own block, for the installer's hidden prompt. The
  install line never contains the token. The manual configuration blocks stay
  below it and now say they put the token in the client's own configuration.
  The `relayhall connector` command itself arrives with the local connector
  entry above; My connections re-shows the install line for connections made
  from a harness template.
- **API.** `POST /services` accepts `descriptor` for a connector registration
  (validated, published as version 1, service moves to `published`, all in the
  registration's transaction; `telemetryTier` defaults to the declared tier). A
  descriptor on a non-connector registration is refused. No migration.
- Docs: new "One connector per harness" section in
  `docs/connector-onboarding.md`, a pointer in `docs/harness-support.md`, and
  `docs/services.md` describes the one-call registration.

### The Action Center no longer scrolls sideways on a phone; the same fault is fixed on three other pages

- At phone width the Action Center page stayed put only until you looked at it:
  its five tabs are wider than a 375 px screen, and the page frame turned that
  into a sideways scroll of the whole page (the title cut to "ion Center", the
  tabs cut to "ons"). The tab row now scrolls **inside its own row**; the page
  and its title stay fixed. The tabs keep their natural width, the selected tab
  is scrolled into view when the page opens and whenever you change tab (only
  the row moves, never the page), and a soft edge fade shows on the side where
  more tabs are hidden. The arrow keys, Home and End and the single tab stop are
  unchanged.
- The fix is in the shared segmented-control recipe, so every control built on
  it (the Board and Map switch, the Timeline filter, the Connections bootstrap
  switch, the task timeline switch) is now capped at its column and scrolls
  inside itself instead of widening the page, on screens 768 px wide and
  below. On wider screens the controls are exactly as before (checked pixel for
  pixel at 1280 px in all three themes).
- A real-browser census at 375 px and 320 px of every dashboard route found
  four more places that pushed the page sideways, all repaired the same way (let
  the box shrink, wrap the long word): a long unbroken word in a Timeline row,
  the two-column system status card on the Dashboard at 320 px, the title row of
  the Personalities page, and the file chooser of the knowledge source
  registration on the Services page at 320 px.
- New `scripts/mobile-overflow-census.mjs` serves the built dashboard against a
  stubbed API in headless Chromium and fails when any route scrolls sideways at
  375 or 320 px (it reads the shell containers too, because the page frame hides
  overflow from the document itself). It needs Chromium and Playwright, so it is
  a manual drill and not part of CI. Component tests and stylesheet pins for the
  control and for each repair run in the frontend job. Frontend only; no
  migration.

### Sidebar widgets can be drawn as a sidebar section

- A plugin sidebar widget can opt in with `ui.sidebar_widget.frame: "section"`.
  The dashboard then draws it as one more section of the sidebar instead of a
  boxed block: a folding heading in the style of the navigation group headings,
  and the widget's frame directly under it at the full sidebar width. The
  border, background, rounded corners and inner padding are gone, so the rows
  inside gain the width the padding took.
- Folding, its remembered state, the heading as the disclosure control and the
  compact rail (which hides widgets) are unchanged. The option is per widget:
  the identity widget and every widget that does not declare it render exactly
  as before.
- The field is the exact string `section`; absence keeps the boxed block and
  any other value refuses the installation with `PLUGIN_SIDEBAR_WIDGET_INVALID`
  (as for `grow`). The declared height is still bounded to 48..240. The plugin
  registry carries `frame: "section"` only when declared. No migration.

### The Action Center: one place for what needs you, the Timeline and Agent sessions

- The notification centre is now the **Action Center**, at
  `/dashboard/action-center`, with a left-menu entry right under Dashboard.
  Its tabs are Notifications (Needs your action), Timeline, Approvals, My
  requests and **Agent sessions**, which moves here from the left menu. The
  old addresses keep working: `/notifications` and `/sessions` open the
  Action Center (the Agent sessions tab for `/sessions`), with every link
  parameter kept, so a bookmarked approval or session link still opens what it
  named.
- The Timeline's filters fold into one compact line: a search box, a chip for
  each filter that is applied (each removable on its own) and a **Filters**
  button. Unfolded, they are grouped: scope, type, project and phase, person,
  dates, access changes.
- **Timeline search.** `GET /notifications/timeline` takes `q`: rows whose
  object title or label holds the text, in any case. It searches only what you
  can already see, inside the same query as every other filter, so a page is
  never short and nothing you cannot read ever matches.
- **Mark as seen.** Each item under Needs your action can be marked seen, one
  at a time or with **Mark all seen** (in the list and in the bell's popover).
  A seen item stays listed until it is resolved; the bell counts only unseen
  items, and an item that comes back (a Task in Review again, a new stuck
  episode) is unseen again. New `POST /notifications/actions/seen` (session
  and bearer, `tasks:read`); `GET /notifications/actions` gains `seen` on each
  item and `counts.unseen`. A mark is per person and can name only your own
  items.
- Migration `169_notification_action_seen.sql` adds the per-person seen
  marks. Nothing else in the schema changes.

### Step-up waits out a reused sign-in and asks again by itself

- When your identity provider reuses a recent sign-in instead of asking you
  again, the "Confirm it's you" dialog no longer shows a red refusal with a
  "Try again" button. It counts down to the earliest moment a fresh
  confirmation can pass and then asks your identity provider again by itself,
  in the same sign-in window. Step-up still happens once per act and once per
  bulk revoke batch.
- The provider does not yet say how long it reuses a sign-in, so the dialog
  waits a cautious 35 seconds and says so. When a refusal carries the reused
  sign-in's time or the provider's window, it waits only as long as needed.
- Cancel always stops the countdown. The dialog asks again by itself at most
  twice; a third reuse shows the usual message about who can change how the
  provider is asked. Every other refusal is unchanged. The countdown is
  announced to screen readers when it starts and when it ends, not every
  second, and keyboard focus stays in the dialog.
- The kept sign-in window moves itself back to your identity provider when the
  dialog asks, so the automatic retry works even though the board's
  cross-origin opener policy cuts that window off from the dialog. It only
  goes to the provider the board named for that request, and it closes itself
  when you cancel, close the dialog, or after ten minutes. If the browser
  blocks the sign-in window from reopening by itself, the dialog asks for one
  click instead of refusing.
- One reused sign-in is counted once even when it is reported twice, so the
  dialog really asks again by itself twice. After the second automatic retry
  the message no longer suggests waiting and trying again.
- Needs your action lists a kind of item this dashboard does not know yet
  under "Other", so the bell never counts an item it does not show. The
  Timeline's "Load more" keeps keyboard focus while a page loads, and a link
  with `?type=access` turns on the Access changes switch.
- Frontend only. No backend change and no migration.

### Security: Node.js patched for CVE-2026-111497

- CVE-2026-111497 is a flaw in the Node.js Brotli decoder that can allow
  remote code execution where a process decompresses attacker-controlled
  Brotli data. It is fixed in Node.js 22.23.4, 24.22.1 and 26.12.1.
- Every Node image RelayHall builds on or runs is now Node.js 22.23.4,
  pinned by digest: the backend image (build and runtime stages), the
  frontend build stage, both development images, the example plugin, the
  setup script's password-hash helper and the full-tier CI job container.
  Before, they were floating tags (`node:22-bookworm-slim`, `node:20-alpine`,
  `node:22-alpine`, `node:22-bookworm`), so the Node that ran depended on what
  the build host had cached.
- The images that used Node 20 move to the patched 22 line. Node 20 is past
  its end of life and receives no security fixes, so pinning a fixed 20
  release would freeze an unpatched runtime.
- The example plugin's image is Debian-based now; its non-root user is created
  with `groupadd`/`useradd` (same name, UID and GID 1002).
- A new repository gate, `scripts/check-node-base-images.py`, fails CI when a
  Dockerfile `FROM`, a workflow or compose image, or a shell script names a
  Node image without a digest, without an exact release, on a line with no
  patched minimum, or below that minimum. Its control is
  `scripts/test-node-base-image-gate.py`. Both run in the fast tier's
  repository contract job.
- No application code change and no migration. A running deployment is
  patched only once its images are rebuilt from this release; check with
  `docker exec <container> node -v`.

### Needs your action and the Timeline, the dashboard

- The Notifications tab is now "Needs your action": only the open items that
  wait on you, grouped as Decisions, Verify, Stuck and Skill reviews, with the
  longest-waiting item first in each group. Each row says why it waits on you
  and for how long, and links to where you act on it. There is no read state:
  an item leaves when it is resolved. A group that reached its cap of 200 says
  so.
- The bell's number is the count of those items and nothing else. Its popover
  lists them under a pinned header and footer; only the list scrolls. The
  footer links "All notifications", "Timeline" and "Approvals".
- The Timeline tab lists every change you can see, newest first and grouped
  by day. The next page loads as you reach the end of the list, and a "Load
  more" button does the same from the keyboard. You can filter by type
  (several at once), project, current phase, person, from and to day, and My
  work; access changes are hidden unless you turn them on. The filters are in
  the link. A divider marks what is new since your last visit, and while the
  tab is open it checks every 30 seconds and offers "N new — Show".
- The Timeline says when a read took too long (`503 TIMELINE_READ_TIMEOUT`)
  and suggests narrowing the filters. When a page brings approval or skill
  decision rows that belong higher up the list, it places them by time and
  says so.
- The dashboard card is now "Needs your action" (the first six items), and
  the Activity widget shows the newest eight Timeline rows. Before, it never
  rendered.
- The dashboard no longer calls `GET /tasks/notifications*` or
  `GET /dashboard/activity`. The routes stay unchanged until the retirement
  release. The old page note that some link filters were not applied is gone.
  No backend change and no migration.

### Sidebar widgets can grow to fit their content

- A plugin sidebar widget can opt in with `ui.sidebar_widget.grow: true`. It
  starts at its declared height and then takes the content height its own
  frame reports, up to a host ceiling of 1600 px, so a long list shows in
  full with no scroll bar inside the widget and the sidebar scrolls as a
  whole. A report above the ceiling is clamped, never trusted.
- The field is a boolean and defaults to false; any other value refuses the
  installation with `PLUGIN_SIDEBAR_WIDGET_INVALID`. The declared height is
  still bounded to 48..240, and a widget without the field is sized exactly
  as before. The plugin registry carries `grow: true` only when declared.

### Grants: no redundant creator grants, a checked bulk revoke, and step-up on every revoke

- Creating a Task, a Report or a Project writes the creator's (and a
  Connector's or Agent's human sponsor's) read and write grants only when the
  authorization engine says they add somebody's access or what the holder
  may delegate (warrant, assignment and mint ceilings read the holder's own
  grants). An administrator whose role derives root and a holder of a
  covering type-wide grant or profile rule get no row; an owning Account, an
  author, an operator and a Connector keep theirs as their delegation
  source. The policy audit row is still written and says when no grant was
  needed.
- `POST /grants/bulk-revoke` (signed-in, root, not on MCP): at most 500 grant
  ids per call, a dry run by default that writes nothing, and a verdict per
  id from the authorization engine itself. A real run needs a step-up bound
  to the exact id set, re-checks every id live, removes only those that still
  change nobody's access (each with its own audit row), reads every affected
  grantee's access back and rolls the whole batch back on any difference, and
  writes one summary audit row. Assignment grants are never removed here;
  plugin grants and anything the engine cannot evaluate are kept.
- Settings → Access grants: **Clean up redundant grants**, beside the paging.
  It checks every grant the current filter shows, shows the counts by verdict
  and a sample, then runs each batch after its own step-up and shows what it
  removed, kept or rolled back. No automatic retries.
- `DELETE /grants/{id}` now needs a login session and a step-up bound to
  `('grant.revoke', id)`, like editing a grant; bearer credentials are
  refused `SESSION_ONLY`. The Access page's Revoke asks you to confirm it is
  you. `relayhall grant remove` is refused for every bearer: revoke on the
  Access page.
- No migration.

### Knowledge sources register from their installer's bundle

- Settings → **Services** is new. Root or an administrator, signed in to the
  dashboard, uploads a knowledge source installer's registration bundle (its
  endpoint, a version 2 knowledge descriptor and the sha256 fingerprint of its
  TLS certificate), compares the fingerprint with the installer's console,
  ticks that it matches and confirms it is them. The board creates and
  publishes the Service, records the endpoint, the allowed networks of a
  private endpoint and the channel credential reference name, and records the
  fingerprint as confirmed, in one act with one audit row
  (`knowledge.source.register`).
- The page offers a **return bundle** for the installer: the Service id, the
  issuer, the board's assertion public keys and the lifecycle public key. It
  holds no secret.
- The page shows each registered source's state honestly: until the operator
  places the channel bearer under the reference name in
  `RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS` and restarts the core, searches of
  the source answer `unavailable:transport`. The operator's step is shown by
  name, never with a value. Once the reference resolves the card says
  "Channel credential in place", not "connected": the board still dials only
  through its default trust store, so the source's certificate must chain to a
  public certificate authority; the fingerprint is not pinned.
- A registration whose channel credential reference name is already in use is
  refused `REGISTRATION_CREDENTIAL_REFERENCE_TAKEN` before anything is written
  or the step-up is spent: a name that already resolves, an entry of
  `RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS` that is the same name once case,
  Unicode forms, invisible characters, whitespace and separators are folded,
  or a name any Service (retired included) records. A new endpoint can no
  longer inherit a bearer placed for something else.
- The read grant the source's readers need is made on Access grants by root,
  or an admin or orchestrator signed in; the page links there. The return
  bundle carries Ed25519 public keys only and refuses any other key type by
  name rather than cutting it down.
- `GET|POST /knowledge-source-registrations`,
  `GET /knowledge-source-registrations/{id}` and `.../return-bundle`: login
  sessions only (every bearer, a root bearer included, is refused), not
  offered over MCP; the registration burns a step-up bound to
  `knowledge.source.register` and the fingerprint. Duplicate endpoints,
  fingerprints and slugs, invalid bundles and an unconfirmed fingerprint are
  refused by name.
- Every refused registration is audited as denied BEFORE the refusal
  answers, so the denied row exists by the time the caller reads the answer.
  A failed audit write never changes the answer; it is logged as a warning.
- Migration 168 adds `knowledge_source_registrations`. See "Registering a
  knowledge source from an installer bundle" in docs/services.md.

### The Timeline stays fast on a large board

- A Timeline read runs in one read-only transaction with PostgreSQL's JIT
  compiler turned off. The Timeline's queries carry the access check for each
  kind of object, and on a large board their estimated cost passed the JIT
  thresholds: compiling one statement took about seven seconds, for a read
  that takes milliseconds. Pages now answer in tens of milliseconds on a
  board of 100,000 feed rows.
- Each Timeline statement has a five-second ceiling. A statement that reaches
  it fails only that request, with `503 TIMELINE_READ_TIMEOUT`.
- A date filter is read through the date index and bounded by the first and
  last row inside the window, so a narrow window with few rows you can see no
  longer walks the rest of the feed.
- Approval and Skill-version rows are read at most one page at a time per
  page of the Timeline. A long stretch of them continues on the next page;
  each row still appears exactly once.
- Authorization is unchanged: it still runs inside the query. No migration.

### Knowledge search console and side-panel reader

- The Knowledge page is now a search console over the sources you may read.
  The scope selector lists each source with its compartments; results are
  grouped by source in the source's own order, and each names its source and
  score.
- **Why this matched** opens an explain view for a result, built only from
  what the answer already carries: source, score and position, the words of
  your query found in the title or snippet, kind, category and the categories
  searched, compartment, update time, archive and whether it is a section of
  a larger item. It sends no request.
- Selecting a result opens it in a shared side-panel reader through the
  governed get route: the text in a quoted frame that names its source, never
  rendered as markup, with Expand, Next byte window, the digest and the
  provenance, including a v1 answer's compartment.
- One map of every code the knowledge routes answer with, shared by the
  reader and the search console. An access refusal is one sentence that names
  no cause, with its audit reference. A source that is unavailable for now
  (unavailable, timed out, transport, rate-limited) says so and offers Retry;
  a source answer the core could not read says so and offers Retry; a link
  that is no longer valid (a malformed, tampered or retired handle, a bad
  continuation) says to search again; a refused search shows the core's words
  for its own input; an unknown code is a generic failure with Retry, never
  the access sentence. Audit references are kept in both forms the core mints.
- The coverage panel gives a verdict (complete, partial, no source answered,
  nothing searched) and names each degraded source: unavailable (transport or
  rate-limited, with the wait), timed out, refused by the source or by
  policy, partial, not searched. An empty list says which kind of empty it is.
  A source list that fails to load offers Retry, and an unreachable service
  is said so.
- No new route, field or authority: the page calls `GET /knowledge-sources`,
  `POST /knowledge-queries` and `GET /knowledge-contents`, the routes the MCP
  knowledge tools use, and the core filters every answer. A new live suite
  (`npm run test:knowledge-console`) proves with two Accounts that a caller
  without access to a source sees nothing from it, and a seventeen-control drill
  (`scripts/knowledge-console-mutations.py`) runs in the full tier.
- See docs/knowledge-search.md. No migration.

### Needs your action and the Timeline, the backend

- New `GET /notifications/actions` ("Needs your action"): the open Decisions,
  Verify requests (including a Task in Review that has no usable Verifier,
  sent to its account owner), Stuck Tasks and Skill reviews that wait on you.
  Each item is derived from current state and leaves when it is resolved. The
  bell's number is its total. Decisions and Skill reviews reach login sessions
  only.
- New `GET /notifications/timeline`: every change you can see, newest first,
  filterable by type, Project, Phase, person, date and My work, and paged so
  that no row repeats or goes missing. Each kind of object needs its own read
  scope, and the check runs inside the query, so a `tasks:read`-only bearer
  sees Task rows and nothing else. Access changes are hidden unless you ask for
  them.
- New `POST /notifications/timeline/seen`: records your own "last seen"
  position. It never moves backwards, and it never goes past the newest row
  you can see.
- Migration 167 adds four indexes (feed type, date and person; approval time).
  Nothing else changes in the schema.
- Feed rows now say what changed: a Task update lists the field names (never
  the values), and a public stream entry or a handover is announced. Report,
  Phase, Skill and Task writes, and access changes, record who did them, so the
  person filter finds them. This includes a Phase or Report created through the
  API or MCP, the Subtask approve, reject and skip routes, a Task breakdown and
  a Verifier's manual rejection.
- The legacy file notifier is removed. Nothing read it.
- The notification history routes and `GET /dashboard/activity` are unchanged.
  They retire one release after the dashboard moves to the new routes. No MCP
  tool reads the new routes.

### Access grants: paged, hand-made by default, origin on every row

- Settings → Access grants reads one page of 50 at a time instead of every
  grant at once, with **Load more grants**. It opens on hand-made grants only
  and says how many system-made and unknown-origin grants the view hides.
- Each row shows its origin: **Hand-made** (the Access page, the CLI, the API
  or an approved request), **System-made** (a Task, Report or Project creation
  policy, an assignment, a Warrant or a Project creation default) or **Unknown
  origin** (no creation record), with the identity that wrote it. The origin
  is derived from the grants row and the audit ledger; see "Where a grant came
  from" in docs/grants.md.
- Filters for origin, resource type, permission, expiry (including expiring
  within 14 days) and resource state (live, archived, not found, every
  resource of a type), a search and a sort. Rows name the Task, Report,
  Project or Phase title, and a Group grantee by its name.
- Edit and Revoke are one inline pair of equal controls at every width, and
  are disabled together while a save or a revoke runs. A grant made on the
  page is placed at the top only when the view shows it; otherwise the first
  page is read again, with the resource title and the origin counts.
- Paging works across long titles: a text sort key is cut to 512 characters,
  so every cursor the list issues is accepted back and Load more reaches the
  end under every sort, 500-character titles included.
- `GET /grants` takes `limit`, `cursor`, `sort`, `made`, `verb`, `expiry`,
  `target` and `q`, all additive: without `limit` and `cursor` the answer is
  the same unpaged list as before. Its `root` ceiling is unchanged.
- `relayhall grant list` takes `--limit`, `--cursor`, `--made`, `--verb`,
  `--expiry`, `--target`, `--q` and `--sort`, and prints the next cursor.
- Settings → Identities folds each kind's disabled and terminated identities
  into a collapsed **Non-active** section with a count, and adds Status and
  Sort (handle, or last seen) controls. Settings → My connections folds
  connections that can no longer act (disabled, or a revoked, expired or
  replaced credential) the same way. Nothing is deleted.
- No migration.

### Group owners' acts and the manager lens

- A Group **owner** (a person holding a live owner role in the Group) can now
  do four things that only an administrator could before, each on a login
  session with a fresh step-up, never with an API key, a Connector or MCP:
  - appoint a **manager** from the Group's active members:
    `POST /groups/{id}/managers` (owners are still assigned by root only);
  - approve the **Charter** of a Project the Group owns, through the existing
    `POST /projects/{id}/charter/approve` with a `stepUpToken` (managers
    cannot; administrators and person owners approve as before);
  - move a Project or Task the Group owns to one of its active members, and
    move their own Project or Task into a Group they own:
    `PUT /projects/{id}/owner/steward` and `PUT /tasks/{id}/account-owner/steward`.
- Every refusal is named and audited before the step-up is spent; a holder who
  leaves the Group, is disabled or becomes an administrator loses these acts
  on the next request.
- `GET /principals/me/lenses` now answers the **manager** lens, with the Groups
  the caller stewards (owners first, with role, member count and featured), for
  anyone holding a live owner or manager role. Callers without one still get no
  `manager` key.
- No migration; no new MCP tool.

### One current page in the navigation

- The sidebar marked an entry as the current page when the address merely
  began with the same letters, so on **Advanced** (`/settings/access-manager`)
  the **Access** entry (`/settings/access`) was highlighted as well. An entry
  now matches only its own page and the pages below it, and when two entries
  match (a nested page) the longer one wins, so exactly one entry is
  highlighted and announced to screen readers as the current page.
- The same rule decides the sidebar's plugin entries, the mobile menu and the
  Settings section list; the dashboard entry is current only on the dashboard.

### Board filters: the selection leads each list, and every filter clears on its own

- In each list filter of the Tasks board - Priority, Status, Tags, Project
  and Phase, which the Map shares - the selected items now lead the list
  under a "Selected" heading, in list order, so a choice in a long list of
  Projects or Phases is found again at once. The filter's search box narrows
  the selected items and the rest alike. In the Phase filter the backlog and
  the selected Phases join the Selected group; the rest stay grouped by
  Project. The order is taken when the list opens: ticking or unticking an
  item in the open list leaves it where it is (so it never jumps away from
  the pointer or loses keyboard focus), and the next opening sorts it again.
- While a filter has a selection, a small x sits beside its button and a
  "Clear" action at the top of its dropdown. Either one empties that filter
  only, leaving exactly the state unticking each of its items would (the
  address bar, the remembered filters and the request the Board or the Map
  sends). "Clear All" still clears every filter.
- Each clear control is named for its filter for assistive technology
  ("Clear Project filter"), works from the keyboard, and is a separate control
  beside the filter button rather than inside it, so the button still opens
  its dropdown. The Selected group is announced as a group named "Selected".
  After the x, focus moves to the filter's button; after the in-dropdown
  Clear, the dropdown stays open and focus moves to its search box, or to its
  first item where the filter has no search. The Tags and Project search
  boxes now have accessible names ("Search tags", "Search projects").
- The five filters render through one shared dropdown component, so they
  cannot drift apart. The UI refinement mutation drill gains two controls:
  the Selected group drawn after the rest, and a filter's own clear reaching
  every filter.

### Lenses and per-lens navigation

- New `GET /principals/me/lenses` (`authenticated`): which dashboard sections
  the caller is offered. Every caller has the `member` lens; a request that
  would pass a `root` ceiling on a login session (the board session or the
  break-glass dashboard token) also has `admin`. A bearer credential never
  does, whatever it holds. The answer carries no `manager` key in this release.
- A lens grants nothing: it is recomputed per request, never stored or put in
  a token, read by no other route, and not audited. Every section it leads to
  keeps its own ceiling.
- The sidebar shows an **Administration** group to the admin lens only:
  Directory, Groups, People, Access and Advanced. People, Access and Advanced
  appear only when Settings would show them too. If the lens answer fails, the
  member sections are shown.
- New Directory page: Identity providers, directory sync health and the
  remote-group catalog, with *Use this group* (one step creates a bound group
  with its members). New Groups page: every group, its members, its directory
  binding and the featured switch. Both have empty states for a deployment
  with no Identity provider and no groups yet. Every request is still decided
  by its route.
- No MCP tool reads the lens.

### The Map's list beside the map, linked hover, one edge per relationship

- New toolbar control "Map and list": the list opens below the map instead of
  replacing it, divided by a separator. Drag the separator, or focus it and use
  ArrowUp/ArrowDown (PageUp/PageDown for larger steps, Home/End for the
  smallest and largest list), to trade map area for list area. Neither pane can
  be made smaller than a floor (the list keeps 120px and the map 200px, both
  shrinking in proportion on a short screen). Whether the split is open and the
  list's height are remembered for the browser tab, like the Map's view; this
  is a screen preference, not layout: resizing changes only how much of the
  plane the canvas shows, and every card and area keeps its place.
  "Show as list" is unchanged and still replaces the map; leaving it returns to
  the split when the split was open.
- Hover linking in the split: pointing at or focusing a list row marks its card
  on the map with a ring in the map's hover colour, and pointing at or focusing
  a card on the map marks its list row, scrolling the list (never the page) to
  it when it is out of sight. A list hover re-renders nothing on the plane, and
  neither direction changes the chain selection; a card the selection dims is
  still marked.
- A relationship the Task graph read lists more than once (several `task`
  References between the same two Tasks) is drawn once. Every drawn edge has a
  key built from its kind and both ends as a tuple, so two edges can no longer
  share a React key or a route.
- The project ground beneath the phase areas is now pinned by tests: each
  project ground is painted first, contains its phases, overlaps no other
  project, and is the quieter fill with the heavier outline.

### The Access Explorer read model

- New read-only API, `GET /access-explorer/objects/{type}/{id}`,
  `/access-explorer/groups/{id}` and `/access-explorer/principals/{id}`
  (`principals:read`): who can do what on an object and why, an object's owner
  (person or Group), a Group's members with their tier and role, an Account's
  Connectors, and a Connector's own() cap, grants, profiles and warrants. Every
  action it states is the server's own authorization predicate evaluated now,
  with the arms that held; it grants and changes nothing.
- An object the caller cannot read answers `404`, as an absent one. Another
  principal's authority is shown to root only; anyone else sees ownership,
  Groups, membership and its own access (a login session also its own
  Connectors and Agents).
- New `GET /groups/{id}/members/{principalId}/access`: only what
  reaches one member through one Group, for root and the Group's live owners
  and managers on a login session; everyone else gets an empty answer.
- Nothing the Explorer shows goes beyond what the caller can already read.
  To a caller that may not see a principal's authority, the principal and its
  children are the `GET /principals` records, with that list's filter for
  hidden principals, so no bound Task, Warrant or hidden principal is named. A
  bound Task is shown only to a reader of it, warrant data only where the
  warrant registry shows it, and an Agent's verdict only where its authority
  may be seen. A steward of a disabled Group gets the same empty answer, and an
  owned object is listed only to a reader of it.
- The dashboard page and the owner selector come later; no MCP
  tool reads this family.

### A Task Brief conceals a Phase its caller cannot read

- A compiled Task Brief shows the Task's Phase name, goal and description only
  to a caller who may read that Phase, the same Phase read decision the Phase
  lists, the Map and a Warrant's linkage already apply. Before, a caller who
  held only the Task read a restricted Phase's name, goal and description
  through its Brief. Any other caller's Goals block now carries the Phase's
  `id` with `"restricted": true` and one fixed sentence saying the Task sits in
  a restricted Phase; a grant on the Phase is how that context is given.
- Covered: `POST /tasks/{id}/brief` (markdown and AGENTS.md), the MCP
  `relayhall_brief_compile` task altitude (both formats), the Agent-mint pack's
  Brief, and `POST /projects/{id}/brief` with a `taskId` (reading the Project
  proves nothing about a restricted Phase in it). The session and phase
  altitudes already carried nothing of an unreadable Phase.
- One resolver (`backend/src/utils/briefPhase.ts`) serves both altitudes. A
  Brief compiled with no actor conceals the Phase, and a failed read decision
  refuses the compile with `503 PHASE_LOOKUP_FAILED`, as a failed Phase read
  already did. An Agent bound to the Task keeps reading its Phase through its
  bound-task context, as `GET /phases/{id}` answers it.
- Tests: `listPointParity` measures every altitude and transport against
  `GET /phases/{id}` for the same caller (a Task-only Account, Connector and
  rule-holding Agent, a Project reader, and the Phase grantee, the bound Agent
  and root as controls); `charterPromptFailClosed` pins the three compiler
  outcomes; `project-task-inheritance-mutations.py` gains three controls (the
  decision ignored, and each altitude deciding as root). No migration.

### Task detail page redesign

- Presentation only: no backend change, no new request, and every control
  keeps its accessible name. The page keeps its shape, header on top and then
  Details | Work | Timeline, with one surface language: dashed frames are edit
  affordances, solid-hairline cards are list items, tinted blocks with a
  stripe are notes.
- Timeline: the Implementation sessions and Native verification panels share
  one "Sessions and verification" disclosure under the Timeline title, closed
  by default in every status, so the events lead the panel. An expanded system event
  reads in plain words ("Status: — → Todo", "Priority: Normal → High"); other
  metadata is a short key: value list. Notes and handovers show their own text
  as plain, inert text with a three-line preview, and no longer sit inside a
  quoted-content fence. System events are compact rows, the filter fits on one
  row and the audit caption moved to the end.
- The Timeline column can be resized from 1280px up, by dragging its edge or
  with the arrow, Home and End keys on the separator, and expanded to the full
  layout width (the button or Escape restores it). The width is remembered
  only in this browser.
- Account ownership moved into the Details rail's Advanced section. The Review
  banner follows the People list, Dates & counters is a two-column grid, rail
  frames are quieter and groups are separated by space.
- Lists in Description and Notes are indented inside the field's frame, as
  Definition of done already was.
- Subtasks: each subtask is a card with a state stripe, its state selector
  sits above the text so the text has the full width, review notes and stuck
  reasons sit on their own tinted block, row actions no longer leave gaps and
  show on hover, focus and touch, and the progress counts carry words for
  screen readers.
- Header: long titles wrap to two lines (three on narrow screens) with the full
  title as a tooltip; the title no longer opens with a focus box; controls are
  grouped State | Lifecycle | Utilities with the Arm and Claim reason on its own
  caption line; the duplicate narrow-screen Timeline button is gone.

### The Map fits what is shown

- Phase and project areas on the Map are sized to the cards currently shown
  and nothing else, in every organization. Turning "show archived" on and off
  again returns every card, area, Organic or Radial region and the archive
  core to the rectangle it had before, also when a live task depends on an
  archived one in its own phase (showing the archive moves that task a column
  right; hiding it moves the task back). It used to leave every phase grown,
  because the plane kept reserved geometry (lane heights, column widths, row
  heights, shelf depths, region homes) that only ever grew. A task that leaves
  gives its ground back: a phase keeps no empty column or row, and its
  remaining cards close up in the order they stood.
- A phase with no shown task is not displayed — a declared phase that holds
  no task yet, and a phase whose every task is archived while archived work
  is hidden. A project with nothing shown takes no ground.
- No layout geometry survives a reload. The Map no longer writes its layout
  record to the browser, never reads one, and removes every copy an earlier
  release stored (`relayhall_map_plane_anchors_v2` and its per-organization
  and v1 forms) when it loads, without reading it. The camera (the tab's view
  state) and the Reports display preference are unchanged.
- Within a session the Map keeps ORDER, not ground: lanes stack in the order
  they were first seen, phases keep their declared place in the flow, and
  every shown card keeps its place in its phase's sequence (fixed when it
  first appears), so a board update that does not change what is shown moves
  nothing, an edit to a task re-sorts nothing, and an arrival moves no card
  already standing in its phase. No coordinate is kept: each phase's lattice
  is rebuilt from that order and the dependencies shown now, which is what
  makes the archive round trip exact. Lanes no longer reserve headroom below
  their content. A finished phase that is declared first (shown by the
  archive, say) takes its declared place instead of trailing the lane.
- New toolbar control "Re-pack layout": discards the session's order
  for the current organization and lays the plane out afresh from what is
  shown now, then fits the view. Its accessible description says so.
- Organic and Radial fit what is shown like the others: every project region,
  phase cluster and the archive core are placed from what is shown, so the
  core is as big as the archive that is shown, and hiding archived work
  shrinks the core and the regions back exactly. They keep no home, cell or
  angle from one layout to the next, so a region moves when what is shown
  around it changes.
- The Map's density migration (which upgraded a layout record a released Map
  had stored) is removed with its membership read: no record is stored or
  read any more. No backend change; no migration.

### Group ownership: the hub class order, owner fields and feed fan-out

- The approvals hub decides the `group` class from the project's OWNER
  first: a project owned by a Group lists under that Group (`basis: owner`,
  shown as "Owned by …"), and a live Group grant is the fallback for a project
  with a person owner or none (`basis: grant`, "Shared with …"). `shared`,
  `private` and `board` are unchanged. Each item's `ownership` gains `basis`
  and `ownerKind`, and each listed Group its `basis`; the owning Group comes
  first. The decider view of `GET /approvals/:id` orders its project
  class the same way and gains `ownershipBasis`, `ownerKind` and
  `ownerDisplayName`.
- The Project record (`GET /projects/:id`, `GET /projects`) and the Task
  account-owner read (`GET /tasks/:id/account-owner`, for the effective owner)
  carry `ownerKind` (`human` or `group`) and `ownerDisplayName`, joined on the
  server, so a client names a Group owner without listing Group principals.
  The OpenAPI Project schema requires both fields.
- Feed: a content-free transition event (`*.acl_changed`, `*.deleted`) whose
  recorded owner is a Group reaches the Group's active members through the
  same membership fragment the owner arm uses; a disabled Group reaches
  nobody. The owner-change socket hint after a Project transfer reaches the
  active members of a Group that owned or now owns it.
- The bell's "My work" counts a Task owned by a Group only for that Group's
  managers and owners (the edit tier); a plain member finds it under
  "Everything I can see".
- The skill owner column was already delivered by
  migration 162; no code changes for it. Its missing control
  is added: the tier drill for a Group-owned Skill (a member reads and uses,
  a manager or owner-role holder writes and submits, nobody publishes, a
  non-member gets nothing, a viewer manager never writes). No migration.

### Route census carries a nested router's prefix

- The protected route census (`utils/routeFamilies`) now composes a nested
  router's own mount prefix into every family it contributes, at any depth:
  a sub-router mounted at `/otlp/v1` inside `/telemetry` is censused as
  `POST /telemetry/otlp/v1/traces`, exactly as the same route mounted flat.
  It used to be censused without the prefix — a path the app does not serve,
  which resolved to root and made the Access-surface census refuse the boot.
- The prefix is decoded from the compiled Express layer and accepted only if
  Express's own path compiler recompiles it to the identical pattern; plain
  segments, parameters and optional parameters are carried. A nested router
  mounted at a RegExp, an array of paths or any other prefix that cannot be
  proved is named as an Access-surface census finding (the boot refuses with
  that sentence), never guessed or skipped.
- No change to today's tree: none of the 45 protected registrations contains
  a nested router, and the derived family set is identical (398 families).

### Identities: open an identity and change its role there

- Every row on the Identities page opens the identity's own page
  (`/settings/principals?identity=<id>`, inside the same guarded settings
  entry). It shows, read-only, the directory facts (kind, role with its
  catalogue entry, status, the identity it belongs to, harness, provenance,
  last seen, id), the Connectors or Agents under it with their credentials,
  scopes, transport and state, its own credentials, the grant rows that name
  it, the Warrants it holds and the newest ten audit rows about it or by it,
  with a link into the filtered audit log.
- Every fact is read through an existing route (`GET /principals`,
  `GET /principals/{id}/credentials`, `GET /principals/{id}/grants`,
  `GET /warrants`, `GET /audit`); a refused read says so in its own section.
  There is no single-identity read, and a principal's creation time, a
  service's purpose and Group- or profile-derived authority have no read here,
  so the page does not show them.
- For an administrator the role change is an action on that page: the same
  targets, the same confirmation with the role catalogue entry and the same
  `POST /principals/{id}/role` as the Access manager's Roles section, which
  stays the bulk view. Both now share one implementation, which asks for a
  step-up through the existing dialog only if the board answers with the
  step-up challenge for that identity (it does not today). No backend change;
  no migration.

### OTLP/gRPC receivers

- The OTLP receivers now also speak OTLP/gRPC: the standard
  `TraceService`, `LogsService` and `MetricsService` `Export` methods
  (`opentelemetry.proto.collector.*.v1`) on a second listener,
  `RELAYHALL_OTLP_GRPC_PORT` (unset: off; not a port: the boot refuses). It
  binds after the Access-surface census and dispatches each request message
  in process through the production telemetry router to the OTLP/HTTP
  handler, so the translations, envelopes, store and dedupe identity are the
  same — the same export over either transport stores byte-identical rows.
- Authentication is the call metadata `authorization: Bearer rh_…` through
  the same acceptance code as REST and MCP (principal credentials only; no new
  credential kind), behind the shared authorization ceiling. Size and rate
  limits are the HTTP receivers' (4 MiB after decompression, 1000 records,
  one receiver budget per signal per principal across both transports, the
  API-wide per-source limiter). Refusals are gRPC statuses with OTLP's
  partial-success rules, `RetryInfo` on retryable throttling and outages, and
  the accepted-version advertisement in trailers; an unknown OTLP version or
  signal is counted on the Connector's new `otlp-grpc` adapter-health row.
- `GET /telemetry/discovery`: `surfaces.otlp.grpc` is now an object
  (`enabled`, `methods`, `maxBytes`, `maxRecords`, `compression`) instead of
  `false`.
- Compose: the base file forwards `RELAYHALL_OTLP_GRPC_PORT` empty-safe and
  publishes nothing new; the opt-in overlay `docker-compose.otlp-grpc.yml`
  turns the receiver on at container port 4317 and publishes it on loopback by
  default. No migration; no runtime dependency (the server is Node's `http2`
  module; `@grpc/grpc-js` is a pinned development dependency, the suites'
  real gRPC client).

### Access manager: every role explained from one catalogue

- New read-only route `GET /principals/roles` (`principals:read`) serves the
  role catalogue: for each of the nine Account roles, a one-line purpose, the
  identity kinds it is meant for, and its scope ceiling as derived from the
  role-to-scope mapping (what it may reach, what it never reaches, which roles
  share its ceiling), whether it is elevated, and which administrator roles may
  assign it. Only the purpose and the kinds are written by hand; a role without
  a description fails the build (type check and suite).
- The dashboard renders the same entry under every role selector: the Access
  manager's Roles section (the role list and the chosen role), a new
  confirmation before a role change, and Create identity. Create identity now
  offers the catalogue roles meant for the chosen kind that the session may
  assign, so an elevated role is never offered for a service. The
  hand-written role descriptions in the dashboard are gone.
- `docs/roles.md` is generated from the catalogue
  (`npm --prefix backend run docs:roles`) and a backend suite fails when the
  page, or the dashboard tests' copy of the catalogue, differs from it.
  `docs/authorization.md` links it instead of keeping its own table.
- The Identities page and `docs/principals.md` say when to use Create identity
  and when to use My connections; the Agent choice points to My connections for
  your own agents. No behaviour change there.

### Plugin availability and host-stored plugin settings

- Administrators set each installed `rh.plugin/1` plugin to `required`,
  `default_on` (the default, today's behaviour), `available` or `disabled`
  in Settings > Plugin settings, with no restart. Availability only narrows
  what the installation file already allows: it is ANDed into the bridge, the
  registry, `GET /plugins/:name` and the proxy (reads and writes), and an
  explicit capability grant never bypasses it. Each person turns `default_on`
  and `available` plugins on or off for themselves under My plugins.
- A plugin may declare `ui.settings_schema` (closed type set, at most 64
  settings, `deployment`, `account` or `account_overridable` scope,
  `deliver: backend` for values that never reach the browser). The host
  stores, validates, renders and resolves them (the person's own value, then
  the administrators' value, then the default; administrators may lock a key),
  delivers them in the bridge (`availability`, `settings`) and to the plugin
  backend through `GET /plugin-host/:name/settings/effective`, confined by a
  `jti` the core now adds to every plugin assertion. Credential-shaped values
  are refused; the host stores no secrets. Saving My plugins keeps a person's
  own `deliver: backend` value, which their own read never shows; "Remove my
  saved value" (a key sent as `null`) clears it.
- New routes `/plugin-host/choices`, `/plugin-host/:name/choice`,
  `/plugin-host/:name/settings` and `/settings/account`, and `/plugin-admin`
  (an admin or operator login session, a step-up per write, root bearers
  refused). Every PUT needs `If-Match`; every write honours `Idempotency-Key`
  and is audited without values. Not exposed over MCP.
- Migration 166 adds `plugin_policies`, `plugin_settings` (one deployment row
  per plugin) and `plugin_account_choices`, and the five retry operations.
- At load, an invalid settings schema refuses the plugin
  (`PLUGIN_SETTINGS_SCHEMA_INVALID`), two installations sharing an assertion
  key name or value are both refused (`PLUGIN_ASSERTION_KEY_SHARED`), and an
  invalid installation name is refused on its own log line while the others
  still load.

### Map: Reports display, Collapsed or Expanded

- The Map's toolbar gains "Reports: Collapsed | Expanded" beside
  Horizontal | Vertical. The choice is the signed-in user's own preference,
  stored with the Theme (`GET`/`PUT /preferences`, new field
  `mapReportsMode`), so it is remembered across reloads and devices.
- Collapsed (the default) draws ONE "Reports · N" node per task in place of
  its individual Report nodes. N is drawn at every zoom its task is drawn at;
  above ten Reports the node takes the warning tint. Hovering or focusing it
  previews the five newest Report titles; activating it opens the task, where
  every Report is listed. A task with no readable Report has no node.
- Expanded draws every Report node inside a report area in the Report colour
  family, sized by the task's Report count, with the task card beside it.
  Zoomed out, the area shows the count. The Report nodes and their area stay
  drawn while panning with the task card off-screen.
- N and the area count only the Reports the viewer may read: they are counted
  from the Map's graph read, which the server narrows Report by Report.
- Migration 165 adds `principal_preferences.map_reports_mode` (`collapsed` or
  `expanded`, default `collapsed`). No other table changes.
- A real-PostgreSQL suite (`npm run test:map-reports`, in the full tier)
  proves the per-Account counts with two Accounts against each Account's
  Report point reads, and the stored per-principal mode.

### Plugin settings say per entry whether your Account can change them

- `GET /api/plugins` adds `readOnly: boolean` to every listed settings entry of
  an installed `rh.plugin/1` plugin, computed per request from the compiled
  proxy rules: an entry is writable only when a POST, PUT, PATCH or DELETE
  request to its own path selects (with the proxy's precedence) a rule whose
  non-view capability the Account holds explicitly, and the caller has
  `services:write` or `root`. The deployment view default never makes an entry
  writable, and a manifest-supplied `readOnly` is replaced.
- The Settings hub (`/settings/plugins`) states for each entry, in the list and
  on its page, whether this Account can change it, instead of only describing
  the plugin's connection as a whole. Responses without the flag keep the
  previous plugin-level wording.
- A refused plugin installation now names its reason in the backend log with a
  fixed code (`[PluginLoader] plugin load failed reason=PLUGIN_MIN_VERSION_UNSATISFIED`,
  `PLUGIN_MIN_VERSION_MALFORMED`, `PLUGIN_ALLOW_PATH_NOT_CANONICAL`, …;
  `PLUGIN_LOAD_UNCLASSIFIED` for other load failures). The line never carries
  the refusal text or manifest values.
- New tests pin the host proxy's handling of an upstream error or idle timeout
  after headers, each of the two upstream-abort listeners separately, and a
  `Range` request without `If-Range`. The full-tier
  `scripts/plugin-view-default-mutations.py` gains an eighth control: the
  per-entry flag must never consult the view default.
- `docs/contracts/plugin-host-v1.md` documents the flag, the refusal reason
  codes and frame sizing: full-page plugin frames fill their route, and a
  received `iframeResize` height is honoured by the sidebar widget only.

### OTLP/HTTP receivers with GenAI, OpenInference and Claude Code translation

- `POST /telemetry/otlp/v1/{traces,logs,metrics}` accepts OTLP/HTTP in
  protobuf and JSON from a Connector credential with `telemetry:write`, and
  stores every translated record through the same validator, Tier-0 policy,
  raw store, quarantine and dedupe as the native endpoints.
- Three translations: Claude Code's log events (model calls with exact tokens,
  cost and duration, tool calls, errors, turns, tool decisions, connection
  health), OpenInference spans, and GenAI semantic-convention spans plus the
  delta token-usage histogram. Claude Code's spans and metric points are
  refused by name so no request is counted twice; anything untranslatable is
  refused by name and counted.
- Measurements are stored exactly or the record is refused by name; a
  translated record is keyed on a digest of the record as stored, so a replayed
  export stores nothing new and a value the translation drops cannot change an
  identity; dropped attributes are the decoder's raw count minus what was
  stored.
- Unknown OTLP versions and signals are refused with the accepted-version
  advertisement; `GET /telemetry/discovery` returns it up front; OTLP and native
  requests are counted on the Connector's adapter-health rows
  (`/sessions/pipeline-health`), unknown versions and majors included.
- Migration 163 adds the `otlp_traces`, `otlp_logs` and `otlp_metrics` receiver
  limit surfaces, replacing migration 112's CHECK only when it matches exactly
  and raising otherwise.
- Validated against replayed captures from Claude Code (protobuf and JSON) and
  the OpenTelemetry Python SDK; a real-PostgreSQL suite
  (`npm run test:telemetry-otlp`) and the migration drill
  (`npm run test:migrations:telemetry-otlp-surfaces`) run in the full tier.
  The OTLP/gRPC receiver follows (see "OTLP/gRPC receivers" above).

### Every step-up asks the board which proof applies, and never offers a password alone by default

- The step-up dialog ("Confirm it's you") showed its Password form until the
  board answered which proofs the Account can give, and kept it whenever that
  answer did not arrive. An Identity-provider-only Account could therefore be
  asked for a password it does not have: on a second step-up on the same
  Access manager page without a reload, single sign-on was not offered.
- Every binding the dialog is handed is now a fresh question to
  `GET /auth/step-up/methods`, read past the browser cache. Nothing is offered
  until it answers ("Checking how your account confirms it is you").
- When that read fails (a refused, rate-limited or unreadable answer, or no
  answer within ten seconds) the dialog says so, offers "Check again", and
  offers the proofs the `403 STEP_UP_REQUIRED` challenge named for that act
  (its `methods` member), or both proofs when there is no challenge. The board
  still decides which proof it accepts.
- A mounted dialog handed a new action or target carries nothing from the
  previous one: no refusal, reuse count, pending re-authentication or typed
  password. No server, API or migration change.

### MCP tools add, reorder and rename Subtasks

- `relayhall_subtask_create` adds one Subtask to a Task at a 1-based
  `position` (default: append) with an optional initial `status` (default
  `empty`, one of the six states `relayhall_subtask_set` accepts) and returns
  its new stable `subtaskId`. `relayhall_subtask_reorder` takes every current
  Subtask id exactly once and changes no id, state or text; any other list is
  refused with `SUBTASK_ORDER_MISMATCH` and nothing moves.
  `relayhall_subtask_update_text` replaces one Subtask's text by stable id, as
  the dashboard's Subtask edit does. Each requires an `idempotencyKey`; an
  exact retry returns the original receipt.
- REST gains the routes they call, in the stable-id Subtask family:
  `POST /tasks/{id}/subtasks`, `POST /tasks/{id}/subtasks/reorder` and
  `PATCH /tasks/{id}/subtasks/by-id/{subtaskId}/text`, documented in
  `docs/api.md` and `/openapi.json`. Their authority is exactly the Subtask
  status verb's (`tasks:write` and Task `write`), and a state other than
  `empty` on create meets the rule the status verb applies from `empty`. Each
  emits one `task.updated` event and records the same owner or appointed Main
  connector disposition.
- The CLI gains `add-subtask`, `reorder-subtasks` and `rename-subtask`.
- Migration 164 adds the three retry operations (`task.subtask.create`,
  `task.subtask.reorder`, `task.subtask.text`) to the retry contract's closed
  operation set. No table or column changes.
- A real-PostgreSQL suite drives the tools through the MCP route and the
  router (`npm run test:subtask-structure`, in the full tier): stable ids and
  positions, permutation-only reorder, retry receipts, the state rule, one
  feed event per write, and refusal exactly where `relayhall_subtask_set` is
  refused.

### `relayhall_lease_claim` takes the claim route's fields

- The MCP tool sent only `leaseSeconds` to `POST /tasks/orchestration/{id}/claim`,
  which requires `snapshotUpdatedAt`, `harness` and `resourceKey`, so no call
  through it could take a Lease. Its schema now carries those three fields,
  and `leaseSeconds` reaches the route as `ttlSeconds` instead of being
  dropped. An exact retry says it returned the held Lease (`acquired=false`).
- Who may claim is unchanged: the route still refuses an identity whose
  Task-lifecycle role is `agent`, and the Task's own Verifier. The tool
  description and `docs/mcp.md` now state the set it admits: a principal whose
  Task-lifecycle role is `reviewer`, `qa` or `orchestrator`. Over MCP that is a
  Connector or Agent an administrator gave the `reviewer` or `qa` role, or one
  with no role whose handle the legacy handle mapping resolves to either; a
  Connector or Agent with neither resolves to `agent` and is refused with `403`.
- A `leaseSeconds` that is not a whole number of at least 1 is refused by the
  tool with `LEASE_SECONDS_INVALID` before the board is called.
- A real-PostgreSQL suite drives the tool through the MCP route
  (`npm run test:mcp-lease-claim`, in the full tier): claim, exact retry,
  renew and release for admitted Connectors, a claim by a `reviewer`-role
  Agent, and each refusal by name, a role-less Connector and Agent included.
  No migration; no route changed.

### The MCP action log suite removes the credential-shaped retry record it wrote

- The live action-log suite sends a credential-shaped marker through a
  keyed `relayhall_task_stream_append`, and the retry contract keeps that
  answer for a day. The full tier runs the retry-contract suite later on the
  same job database, so its scan for credential material found the
  marker and went red. The suite now deletes exactly the retry records its own
  marker calls created, by scope, operation and key, and fails if any record
  still carries the marker. Neither assertion changed; test-only, no
  migration.

### CLI parity with the REST and MCP contract

- New verbs, each composing the route its MCP tool composes: `task-stream`,
  `task-timeline`, `task-graph`, `task-success-criteria`, `task-arm`,
  `task-park`, `task-release`, `task-recover`, `lease claim|renew|release`,
  `bulk-archive`, `session-brief`, `warrants`,
  `access-request preview|file|status|withdraw|collect`, `native-execution`,
  `native-review`, `knowledge propose|preview|commit`,
  `service review-requests`, `credential reveal` and
  `principal remediation-queue`.
- Write verbs take `--idempotency-key` (16-128 characters) and send it as the
  `Idempotency-Key` header: `create`, `update`, `move`, `task-append`,
  `task-reference add`, `report create`, `project create`, `phase create` and
  `project resource add-*`; `task-arm`, `task-park` and `knowledge commit`
  require it.
- `move --notes` appends the reason as an attributed Task note
  (`POST /tasks/{id}/notes`) before the status change, as `relayhall_task_move`
  does; it used to send `notes` on the PATCH, which replaced the Task's notes.
- `create`/`update` take `--warrant` and `--role-grant-expires-at`
  (`--role-grant-zone` for a local wall clock). `list` takes `--tag`, `--query`
  and `--include-archived`; `report list|search` page with `--offset` and
  filter by `--status`, `--updated-since`, `--sort` and `--order`;
  `task-append` takes `--referenced-entry`; `task-reference add` takes
  `--metadata`.
- A refused call prints the board's stable refusal code after the message.
- `--project` on `create`, `update` and `list` accepts a Project id as well as
  a name, as the route does (found by the live drill).
- `native-generation` and `finish --native-generation-file` no longer fail
  with a missing `Path` import.
- `identity-provider create|update --scim-heartbeat-interval-hours` (`none`
  clears it) and `identity-provider list` renders the interval.
- The embedded self-test (`relayhall --test`) checks the subtask icon table it
  documents (review is the yellow marker) and runs in the CLI suite.
  `docs/cli.md` maps every verb to its route and tool. No server change, no
  migration.

### Truthful task activity on the board and Task details

- Task cards and Task details show one activity badge: *Active*, *Idle*,
  *Stale*, *Unknown* or *Unavailable*, with the time of the last actual
  observation when there is one. It comes only from task-attributed telemetry
  frames; the lifecycle status, a claim, a planned model or a scheduled
  heartbeat never present a Task as running. The card's former *Running* /
  *Idle* / *Waiting for Input* session label, which was derived from the
  lifecycle, is gone.
- `GET /tasks/activity?ids=` reads up to 100 Tasks in one bounded request,
  authorized per Task by the shared read predicate; ids the caller may not
  read are omitted. The board reads its visible cards (the open column at
  narrow width) in one batch every 30 seconds, Task details its one Task;
  both pause in a hidden tab, discard obsolete or timed-out reads (20 s) and
  clear on a change of viewer, assignment or access. Freshness counts down on
  the browser's monotonic clock, so an active badge turns stale on time even
  while a refresh hangs.
- A frame with a `taskId` (posted to `POST /telemetry/frames`, or the MCP
  server's Task link) counts as task activity only when it comes from the
  Task's current Assignee, on an in-progress Task, and from the assigned
  connector Service's principal when one is named; the receiver stamps it with
  the assignment epoch, so a reassignment retires earlier observations. What
  the receiver accepts is unchanged.
- Task details hide cached content and activity when a background re-read is
  refused (401, 403, 404), and show them again when read access returns.
- The full tier runs the live suite (`npm run test:task-activity`) and a
  six-control mutation drill (`scripts/task-activity-mutations.py`).

### A finish dry run answers what the finish answers

- `POST /tasks/{id}/finish` with `dryRun: true`, and `relayhall_task_finish`
  with it, used to answer valid after checking only the request's shape, so
  the assigned Verifier, a principal with no Task role, a Task that was not In
  Progress and a Task with an open Subtask were told "valid" while the same
  real call was refused. The dry run now takes the same Task lock and makes
  every refusal the real finish makes, in the same order - including an
  unlinkable or foreign Task Report, an oversized Handover that would be
  quarantined, and the native-generation gate (which gains a dry-run mode that
  reads its own deadline predicate instead of writing) - and then rolls back.
  The real finish is unchanged.
- The MCP answer to a dry run says it is one and that nothing moved; it no
  longer prints "finished to Review".
- Finish takes no idempotency key, so a dry run reserves none; after a finish
  a dry run is refused `TASK_NOT_FINISHABLE` exactly as a retry is.
- New real-PostgreSQL suite `npm run test:finish-dryrun-parity`, run by the
  full tier: every case pairs the dry run with the real call for the same
  actor and state, through REST and MCP, and proves the dry run wrote nothing.
  The OpenAPI summary for finish now names the dry run's parity and corrects
  its 403 line (the Verifier may never finish). No migration.

### Universal change requests: the identity targets

- Eight more change-request target types file on both doors and apply at
  decide with the decider as the standing principal: `identity.role` (through
  the role-change seam the direct act now shares; an ordinary user asks for
  its own Account's role, up to an editor-class role; an elevated role only
  from an `admin` decider), `identity.create` and `identity.status` (a root
  session decides), `credential.revoke` of another principal's credential,
  and `warrant.create`, `warrant.edit`, `warrant.revoke` and
  `warrant.resume`. The principal a change is about, a revoked credential's
  holder and a warrant's holder never decide it, nor an Account above them.
- One account-status seam for both doors: `PATCH /principals/{id}` with
  `status: disabled` now also revokes the principal's stored login sessions
  and lapses the pending requests naming it as grantee, in the same
  transaction (a declared tightening of the reversible disable).
- MCP: `relayhall_access_request` names the identity targets; the registry's
  path ban gains `/warrants` (the read tool keeps `/delegation/warrants`).
- A new full-tier live suite (`npm run test:change-request-targets`) and its
  mutation drill (`scripts/change-request-target-mutations.py`).

### Skills have an owner, and drafts show to their owner

- Migration 162 adds `skills.owner_principal_id`: a person Account
  or a Group principal, refused by a trigger for any other kind. It assigns the
  first owners by an explicit list of Skill ids (27 imported drafts to the
  Account they belong to, every other Skill to the first Account), only where
  those Accounts exist; elsewhere every Skill stays unowned.
- A new Skill is owned by the creating chain's person Account, so its author can
  draft Versions, submit and revise through the owner rule. Group owners get the
  Group tiers (members read and use, live owners and managers edit).
  Publication is unchanged: `skills:admin`, human-only, never the Version's
  creator (`INDEPENDENT_REVIEW_REQUIRED`).
- `GET /skills`, the Skill reads by id, the MCP `relayhall_skill_list` /
  `relayhall_skill_get` and the bootstrap's inline index show a Skill's drafts
  only to its owner, members of an owning Group, while it is unowned, and to
  registry administrators for the review queue; `GET /skills?owner=all` (root or
  `skills:admin`) lists every owner's drafts. The session brief's skill index
  adds `yourDrafts`. Every Skill carries `owner_principal_id`, `owner_kind` and
  `owner_display_name`.
- `PUT /skills/{id}/owner` assigns the owner (`skills:admin`, revision-bound,
  audited `skill.owner.change`); a move involving a Group is a Group-ownership
  act (login session, root or administrator, step-up). CLI `relayhall
  skill owner` and `skill list --all-owners`; the dashboard's Skill modal shows
  the owner and, for administrators, an Owner panel and an "Every owner's
  drafts" view. Deleting a Group that owns Skills is refused
  (`GROUP_OWNS_OBJECTS`, `owned.skills`).
- A real-PostgreSQL suite (`npm run test:skill-ownership`, full tier) proves it
  with two Accounts.

### Universal change requests: the surfaces for the first use

- `relayhall_access_request` files a change over MCP (`kind: "change"`, with
  `targetType`, `targetId`, `change`, `granteePrincipalId` and `granteeType`)
  and answers "what may I request here" with `action: "preview"`, which writes
  nothing and stays behind the bootstrap gate. `status` lists every kind, the
  caller's agent-mint requests included, with `kind` and `status` filters. No
  tool, noun or path is added; deciding stays a login session's act, and the
  registry composes no `/approvals` path (now a pinned ban).
- `GET /delegation/access-requests?kind=agent-mint` lists the caller's own mint
  requests with their task and scopes; without `kind` the list is unchanged.
- The notification history no longer names the decider to the requester: on
  an approval row of an item the viewer (or an identity under it) filed,
  `actorHandle` is set only for the viewer's own acts, for every kind.
- The dashboard: a change request on the approvals hub renders a generic
  decide form by its target type, with a *Before and after* region (the field
  table and, for a decider, the relationship table with its summary) and the
  narrowing controls of its type (an all-of-type grant row narrows to exact
  ids); one step-up sends only what was narrowed. A grant.edit or
  grant.revoke change is decided by a root session only, as the MCP tool
  description and docs/mcp.md now say.
  "Request a change" on a Project's *Access & capabilities* tab and on the
  Knowledge page files from what the preview admits; from the Knowledge page
  each ticked Project is previewed and a refused one is named before filing.
  *My requests*, a new tab of the notification centre, lists the session's
  own change requests with their field diff and withdraws a pending one.
- Documentation and comments made true: the kinds the
  queue, the hub and the bearer list filter by; the hub's status words apart
  from the list's; the deny summary; MCP filing needs no `principals:read`;
  the Project owner column written at creation; the quota shared by every
  kind; the restricted-access ledger no route reads; an Account-wide session
  revocation no route reaches yet. No migration.
- Deferred to a later release, with the change revert sweep: the
  decide-time lifetime choice (keep, until a task ends, or until a date) and
  the MCP filing's `lifetime` field. This release's decision offers an approved
  expiry date only, and the server derives a filed lifetime from
  `change.expiresAt`.

### Plugins: a deployment view default for every Account

- An installed plugin's `access` block in `relayhall.plugins.json` takes an
  optional `default`: absent, `[]` or exactly `["view"]`. With `["view"]` every
  active Account sees the plugin: the registry lists it, its `view` settings
  entries show, the host bridge serves it, and GET/HEAD requests behind a
  `view` allow rule pass the host proxy, with the assertion naming the
  caller's own Account.
- The default grants `view` only. Every other capability (such as `generate`
  or `manage`), every settings entry behind one, and every write through the
  host proxy still need that capability in the Account's own `accounts` entry;
  the proxy's write path and `hostProxyAccess.writeCapable` read the explicit
  entries alone. A request without an active Account gets nothing.
- Any other `default` value (another capability, a string, a duplicate) refuses
  that installation at load, so it is not served. The per-Account list keeps
  working: it adds capabilities to the default, and without a default it is
  exact as before.
- `docs/plugin-development.md` documents the block and
  `relayhall.plugins.example.json` carries a disabled example entry. A new
  full-tier drill, `scripts/plugin-view-default-mutations.py`, holds seven
  controls, each red at exactly its declared tests. No migration.

### The per-session MCP action log

- Every admitted MCP tool call made inside a live MCP-derived session is
  recorded in that session's action log: the tool, the one object it named (a
  Task, Report, Phase, Project or Skill id taken only from that tool's
  allowlisted argument), ok or error with one closed error code, the handler's
  duration and the time. Arguments, error messages and results are never
  recorded; the new table `mcp_action_log` (migration 161) has no column that
  could hold them.
- The Agent sessions page shows the log in an `mcp` session's expanded
  timeline under "MCP tool calls", with an empty state and the statement that
  REST and CLI calls are not shown. It rides the session's existing point read
  (`actions`, `actionsTruncated`) and is visible exactly to the session's
  readers; no route, scope or visibility rule was added.
- The write never fails or slows the tool: it is fire-and-forget after the
  tool answered, bounded to eight outstanding writes with a two-second query
  timeout, and a failure logs a secret-free warning only.
- Retention: swept hourly with a receipt as class `mcp_action_log` at the
  telemetry event bound (90 days by default).
- An MCP tool error raised from a board refusal now carries the board's HTTP
  status as a structured field, which the log maps to its closed code; the
  error text a client reads is unchanged.

### The grant and credential request drill says when a run measured nothing

- The full-tier step "Grant and credential request mutation controls" printed
  `MISS <control> -> []` for the ALREADY_HELD control on 1.0.0-beta.51.
  The same control on the same commit reddens exactly its three declared tests
  whenever its suite runs (the credential-request ALREADY_HELD refusal is
  unchanged), and that line is also what the drill printed when the suite
  reported no tests at all: a compile error or a killed test process read as
  "no test reddened".
- `scripts/access-request-mutations.py` now gives each run the three verdicts
  the mint-ceiling drill already gives: RED, MISS (every test ran
  and the failed set is wrong, with the count) or INCONCLUSIVE (the suite never
  reached its assertions: no JSON, other tests than the baseline's, a timeout,
  a compile error, an unloaded suite, an unreachable database or a thrown
  error, naming the exit status or the signal). INCONCLUSIVE still fails the
  step (exit status 3). What counts as RED is unchanged, and no control,
  anchor or declared test changed.
- No migration, no API shape change, no workflow change.

### Plugin bridge board metrics: queue and throughput for the caller's Account

- `GET /plugin-host/{name}/bridge` gains an additive `boardMetrics` field
  (`rh.plugin.board-metrics/1`) for `telemetry.sessions` plugins: the core's
  own count of the caller's Account's board work. `queue` (jobs) is its armed
  `todo` Tasks; `throughput` is its `handover.finish` handbacks in the
  rolling hour: `throughput.count` is the number of handbacks in that hour
  (the figure to show as handbacks per hour), and `value` is the same rate
  in jobs/minute (`count / 60`, 3600 s window) for parity with
  `rh.plugin.metrics/1`.
  A Task is the Account's by its effective Account owner; nothing is global.
- Each reported metric carries `observedAt` and `stale` (90 seconds). What
  cannot be computed is `status: "unknown"` with `value: null` and a reason
  (`unavailable`, or `caller-reach` for a caller without `tasks:read` or a
  Connector or Agent whose object reach is narrower than its Account), never 0.
- `metrics`, `metricsSources` and the rest of `rh.plugin.bridge/1` are
  unchanged; no migration. The definitions are in
  `docs/contracts/plugin-host-v1.md`. A live suite (`npm run test:board-metrics`)
  and an eight-control mutation drill (`scripts/board-metrics-mutations.py`)
  join the full tier.

### Native verification session privacy: the live matrix and its mutation controls

- Tests only, no source change: `npm run test:native-review` now reads the session privacy matrix through REST and MCP as current principals (an allowed, a scope-denied and a foreign reader; scope narrowed after an available read; expired links; a private Task read by a revocable grant), and `scripts/native-review-privacy-mutations.py` (full tier) proves three controls red at their declared tests: the link expiry evaluated before the restriction, the native triple on a restricted session, and a count on it.

### Universal change requests: standing, deciders and the hub

- A person files a change request as its own Account on a new session door,
  `POST /approvals/requests`, and withdraws it with `POST /approvals/{id}/withdraw`;
  the bearer door is unchanged. Migration 159 adds these routes and the two
  previews to the Access manager surface's route families; nothing else in the
  schema changes.
- Standing to ask is computed live. Beside root and administrator sessions, the
  owner of EVERY object a request names (a Project's person owner, a Task's own
  account owner, a Report's account owner or author, a Group owner or manager)
  may ask for any Account or Group; a write grant, a role or visibility confers
  no such standing (`REQUEST_STANDING_NONE`), and a set spanning owners is
  `TARGET_OUT_OF_SCOPE` with a hint to file one request per Project. A
  Connector or Agent is cut to its own credential: a root or administrator
  Account's Connector names another grantee only for rows its own authority
  covers (`OWN_CAP_EXCEEDED`).
- "What may I request here": `GET /approvals/requests/preview` and
  `GET /delegation/access-requests/preview` answer what is requestable on an
  object, for whom, within what bound and decided by which standing, and write
  nothing: no audit row of any action, approval, approval event or quota count.
- Who decides is one ordered predicate: a login session; a live, non-legacy
  Account (now for every kind: `DECIDER_NO_LONGER_ADMITTED`); no
  self-approval; root, an administrator session (a root session alone for grant
  edits and revocations), or the owner of every object the request names
  (`owner`, `group-owner`, or `group-manager` for grant rows only); one step-up,
  which the applying executor re-checks before it writes anything.
- The approvals hub shows the owner of a request's objects that request (and
  its notification), and 404-conceals it from everyone else; a request
  spanning two owners is visible to neither. Each item says who decides it,
  whether this session may, and why not when it may not, in the decide route's
  own order: a session no longer live and the request's own requester are told
  `decidable: false` with the code the decide answers
  (`DECIDER_NO_LONGER_ADMITTED`, `SELF_DECISION_REFUSED`), for every kind.
- Every decision shows its decider and stores a before/after view: the field
  diff, the relationship edges added, removed or kept, and a one-line summary;
  the hub computes the same for the older kinds. A credential scope change also
  shows what it reaches: the Connector's effective scopes before and after, and
  each live Agent under it, read by the same projection as an edit request's
  decision; a new credential shows what it could exercise, as a credential
  request's decision does.
- The requester reads its own request with the field diff only: no
  relationship edges, no decider id or standing, and no decision metadata in
  its events, on `GET /approvals/{id}`, its queue row and its hub item alike,
  as on the bearer status read.

### The full tier is routed to a runner labelled `relayhall-full`

- All nine jobs of `ci-full.yml` (both forge copies, byte-identical) now declare
  `runs-on: relayhall-full` instead of `ubuntu-latest`, so the full tier runs only
  on the runner that carries that label. The fast tier (`ci.yml`) is unchanged and
  stays on `ubuntu-latest`.
- `docs/ci.md` says what a fork without such a runner does: label one runner or
  revert the line.
- No migration, no API shape change, no file added.

### Universal change requests: the model and the first targets

- A new Approval kind, `change` (migration 158), asks for
  ONE change for any Account or Group the filer may name, through a typed
  target and one before/requested spec; the four older kinds, their routes,
  tools and checks are unchanged. Each object of a request is one row of
  `approval_change_objects`, carrying the owner value the evaluator reads and
  the one-pending-request key.
- Filed on the bearer door (`POST /delegation/access-requests`, `kind:
  "change"`) for `grant.rows` (an Account or a Group), `grant.edit`,
  `grant.revoke`, `credential.scopes` on any Connector credential in reach,
  `credential.issue` for another existing Connector (collected by that
  Connector's own credential), `knowledge.compartment` and
  `knowledge.shared_writer`. Every other target is refused by name, naming
  the work that builds it or the rule that keeps it out.
- Every object a filing names is read through the filer's own live authority,
  and one it cannot read is answered exactly as an absent one
  (`TARGET_NOT_FOUND`, or `GRANTEE_NOT_FOUND` for a grantee); outside its own
  Account subtree a filer needs `principals:read` to name an Account, Group,
  Connector or credential. `grant.rows` files on an object the filer cannot
  read exactly as on an absent one and discloses nothing about it.
- Decided on `/approvals` with ONE step-up by root or an administrator login
  session (a root session alone for grant edits and revocations), narrowed
  only, never by the requester's Account or a principal the change names
  (`SELF_DECISION_REFUSED`); a target that changed after filing lapses the
  request (`EDIT_STALE`). The decision applies the change through the existing
  executor and stamps `applied_at`; a revocation's `grant.revoke` audit row
  carries the decision (approval, decider standing, step-up, before, after and
  the requester chain).
- The lifecycle exporter now reads Project compartment grants and personal
  consents from core tables. Its first generation carries the configuration's
  rows over and publishes only if the result equals the configuration
  byte for byte, recorded as `knowledge.lifecycle.import`; approved knowledge
  changes are stamped `approval.applied` by the generation that first carries
  them.
- New full-tier step: `npm run test:change-requests` and
  `scripts/change-request-mutations.py` (eleven controls).

### A first knowledge search answers rows inside the caller's budget, and a deadline says whose it was

- A v2 knowledge source was never told how long the core would wait, so the
  knowledge source cut every first search for a new text at its own 2.5 s
  store deadline (inside a fixed 3 s) while its broker needed about 6 s:
  `partial`/`deadline` with no rows even at `timeoutMs` 8000, and only the
  repeat answered. The core now sends each v2 search `budget_ms`, the source's
  dial budget less a 300 ms return margin (`KNOWLEDGE_SOURCE_BUDGET_MARGIN_MS`).
- A source may name the budget behind a `deadline` reason (`deadline_fired`:
  `caller_deadline` or `source_deadline`); the core carries it into
  `coverage.partialSources[].deadlineFired`. A malformed one is
  `unavailable: transport`. The core's own per-source deadline still lands in
  `timedOut`.
- Selector amendment v1.3 (`docs/contracts/knowledge-v2/selector-amendment-v1.3.md`):
  two optional wire properties, the schema pin moves with it. A source that
  ignores them is unaffected. The source side ships as its own image;
  either side may release first.
- The default `timeoutMs` is now 8000, the maximum (it was 3000), for a
  `POST /knowledge-queries` that sends none, the MCP tool
  `relayhall_knowledge_source_search` included; the dashboard's Knowledge page
  and `relayhall knowledge search` send 8000. With 3000 a first search against
  a store that needs about 6 s still answered `partial` (`caller_deadline`)
  with no rows. The allowed range stays 500..8000.
- No migration, no new route or MCP tool, no Governor write path change.

### A Verifier verdict that overlaps another on a shared target retries instead of answering 409

- Two Tasks whose assignments share one access target (the same assignee's
  grant) verified at the same moment could refuse the second verdict
  `ASSIGNMENT_REFERENCE_BUSY` (409, "roll back and retry"), because the vehicle
  takes its reference locks without waiting. `POST /tasks/reviewer/{id}/run`
  (and `relayhall_review_run`, the CLI `review` command and the Verifier
  heartbeat) now roll the refused verdict back and re-run it whole, at most
  three more times with a small jittered pause, only on that code; both Tasks
  complete and the shared target is reaped exactly once. Sustained contention
  still answers the typed 409 and consumes no retry budget.
- A caller that supplies its own transaction (the native verdict) keeps owning
  the rollback and retry; the vehicle service still never retries.
- `taskReportAcceptanceLive` gains a deterministic case (a second connection
  holds the shared target's reference key; red on the base with the 409) and
  the grant-request mutation drill gains the matching control.
- No migration and no API shape change.

### A Warrant's linkage conceals a Project its viewer cannot read

- `GET /warrants/{id}/linkage` rendered the name and status of a Project anchor
  to a viewer who may read the Warrant but not that Project. A Project anchor
  now asks the Project read decision the Project lists ask: type and id stay,
  name and status are concealed, as they already were for Task and Phase anchors.
- The Map graph's Phase identities go through the same Phase read decision
  helper the Phase lists use (no behaviour change).
- `docs/authorization.md` states which Phase surfaces `listPointParity`
  measures and names the two that still return a Phase name without the Phase
  read decision: the Task-altitude Brief (still to be decided) and the raw
  `GET /approvals` list's `relatedPhaseName`.
- `listPointParity` gains the Project-anchor case (red on the base) and positive
  cases for an exact Phase grantee and a Project owner on
  `GET /projects/{id}/phases`; the inheritance drill gains the matching control.
- No migration and no API shape change.

### A Project's Phase list honours restricted Phases

- `GET /projects/{id}/phases` (the dashboard's Phases page and Phase picker)
  listed every Phase of a readable Project, including one marked restricted,
  so a Project reader saw the name, goal and description of a Phase that
  `GET /phases/{id}` concealed from them. The list now passes each row through
  the same Phase read decision `GET /phases` uses, after the Project's own
  concealment; a restricted Phase appears only to the callers that may read it.
- `GET /warrants/{id}/linkage` conceals the name and status of a Phase anchor
  the viewer may not read, as it already did for Task anchors.
- No migration and no API shape change. A credential with `projects:read` and
  no `phases:read` still lists the Project's unrestricted Phases.

### Default Verifier: the Phase route refuses a reader by name

- `PUT /phases/{id}/default-verifier` now answers a caller who can read the
  Phase but is not root, an administrator or the person owner of its Project
  with `403 DEFAULT_VERIFIER_REQUIRES_OWNER`, audited `denied`, the same answer
  the Project route gives. Reading the Phase means read on
  it, or read on its Project unless the Phase is restricted. Before, a Project
  grantee got a concealed `404` and a Phase reader a generic `403 FORBIDDEN`.
- A caller who cannot read the Phase still gets the concealed
  `404 RESOURCE_NOT_FOUND`, with no audit row. Nobody can set a default they
  could not set before.

### Shared-area writer list

- A knowledge source's organisation-wide shared area is readable by everyone
  the source admits and writable only by the Accounts on its writer list. The
  list now lives in RelayHall (migration 157, `knowledge_shared_writers`)
  instead of the source's deployment configuration, and reaches the source in
  the signed lifecycle snapshot as `shared_writers` (still schema version 1).
- Root and administrators (`admin`, `operator`, `orchestrator`) change it in a
  login session, with a reason and a step-up every time: the Access manager's
  new **Shared-area writers** panel, `relayhall shared-writers add|remove`, or
  `POST /knowledge-shared-writers[/remove]`. Bearer credentials and API keys are
  refused `SHARED_WRITER_REQUIRES_SESSION`; only people's Accounts can be
  listed. Every change is audited with the list before and after and noticed to
  the enabled notification endpoints; no Access profile reaches it.
- Anyone with `services:read` reads the list (`GET /knowledge-shared-writers`,
  `relayhall shared-writers list`, and the new MCP read tool
  `relayhall_knowledge_shared_writers_list`), including whether their own
  Account may write. There is no MCP write path.
- A row added with an expiry is dropped from the list and the snapshot when it
  passes, and the 60-second sweep removes it, audited as actor `system`.
- The snapshot names only listed Accounts it also exports as active people, so
  a listed Account outside the export selection never invalidates it. Changes
  reach the source in about 20 seconds.
- The audit page accepts its text filters from a link
  (`/audit?actionPrefix=knowledge.shared_writer`), which the panel uses.

### Group ownership transfer

- A Project's owner or a Task's account owner can now be moved **into, out of
  or between Groups** by root or an administrator (an `operator` session) on a
  signed-in session, with a step-up confirmation bound to the object. Bearer
  credentials, an appointed Main connector and MCP are refused
  `GROUP_OWNER_SESSION_ONLY`; other sessions `GROUP_OWNER_REQUIRES_ADMINISTRATOR`;
  a missing or foreign step-up `STEP_UP_REQUIRED`. Refusals never spend the
  token and are audited even though the transfer rolls back.
- `PUT /projects/{id}/owner` and `PUT /tasks/{id}/account-owner` accept
  `stepUpToken`. The audit row records the owner kinds, the Group's member
  count, the step-up token and whether root or an administrator decided.
- An administrator can undo their own move; a Task returned from a Group keeps
  the person as its explicit account owner. A disabled Group cannot receive
  ownership. Grants are untouched.
- The Project **Access** tab's owner selector and the **create form** offer
  enabled Groups (featured first) to root and administrator sessions, and ask
  for the step-up first. `owner-candidates` gains `groups[]`; creating with a
  Group owner is one transaction.
- A create with a Group owner sent with `Idempotency-Key` is retried under its
  own operation, `project.groupowned.create`, scoped to the credential (or
  login) that sent it: a second credential of the same principal repeating the
  key is decided afresh, never handed the stored Project. The plain create keeps
  `project.create`, scoped to the principal. Migration 156 adds the operation
  to the retry table's closed set.
- Transfers between persons are unchanged.

### Metrics scrape no longer JIT-compiles

- `GET /metrics` for a collector narrowed to explicit objects could answer
  `503 METRICS_UNAVAILABLE` once a board held enough Tasks: PostgreSQL JIT
  spent seconds compiling the scrape's authorization predicate, which overran
  the scrape's 5 s statement budget. The scrape now turns JIT off for its own
  read-only transaction, as the authority preview already does. The budget,
  the numbers and who may read them are unchanged.

### Default Verifier per Project and Phase

- A Project, and each of its Phases, can name a **default Verifier**. New
  tasks inherit it: a Verifier named at creation, else the default of the
  Phase the task lands in, else the Project's. Each task records where its
  Verifier came from (`verifierSource`). Changing or disabling a default never
  changes an existing task, and nothing is backfilled. Migration 155.
- The default is set on the owner plane only: `PUT /projects/{id}/default-verifier`
  and `PUT /phases/{id}/default-verifier`, from a login session of root, an
  administrator or the person who owns the Project (only root or an
  administrator on a Group-owned Project). Groups and Agents are refused.
  Dashboard: a picker on the Project overview and in the Phase form. CLI:
  `relayhall project set-default-verifier` and `relayhall phase set-default-verifier`.
- One usable-Verifier check (active, live chain, `tasks:write`, not the
  Assignee) drives a new **warning** when a task reaches Review without a
  usable Verifier: the move, `finish` and the MCP tools say why and are never
  refused. The dashboard shows a banner on such a Review card.
- **Census.** `verifierUnusable=true` on the task reads, "Without a usable
  Verifier" on the board filter, `relayhall tasks --without-usable-verifier`,
  and `verifierUnusable` on `relayhall_task_list` and `relayhall_task_graph`.
- `relayhall_task_create` and `POST /tasks` accept `verifierPrincipalId` only
  when it equals a Project or Phase default (`VERIFIER_NOT_ALLOWED`
  otherwise). Role writes on existing tasks stay off MCP.

### Full-tier PostgreSQL services start on a busy disk

- CI only: the full tier's `relayhall_ci` PostgreSQL services set
  `PGCTLTIMEOUT: '300'` and `POSTGRES_INITDB_ARGS: --no-sync`, so a slow
  runner disk no longer makes the service exit during its own initialisation.

### Authority-edit approvals: the chosen lifetime is recorded and enforced

- The Approvals hub now offers every authority-edit request both lifetimes:
  **Until a date** (or **Until this task ends, or a
  date**, when the request names a related task) with a UTC revert date, and
  **Keep (until narrowed)**. Before, a request with no related task offered
  only "Keep", so the shortest lifetime on offer stored no revert at all.
- The approval records the chosen lifetime and its revert date, and the
  decided item shows them. At that time (within a minute) the board's sweep
  removes exactly the scopes the approval added, audited, once; the
  credential's own expiry does not change. Keep stands until someone narrows
  it.

### Group ownership by tier

- A Project, Task or Report owned by a **Group** now gives its members access by
  tier: every active member reads and uses it; a member holding a live
  **owner** or **manager** role also writes, claims, finishes and releases it.
  No tier gives `admin`, Shepherd or Verifier authority, and the role ceiling
  still decides first (a viewer only reads).
- A Group-owned Project reaches its Phases and Tasks: Tasks with no explicit
  account owner follow the Project, and Tasks someone else owns are still read
  by members and get the ordinary Task write subset from owners and managers,
  while the Project is active. A restricted Phase or Task is hidden from plain
  members and stays editable by owners and managers.
- Disabling a Group principal, a member leaving or being disabled, and an
  inert role row each take effect on the next request. Connectors and Agents
  reach Group-owned objects only through their Account, inside their own()
  limits, and the Agent-mint ceiling follows the same rule.
- Charter approval of a Group-owned Project stays with administrators in this
  release (the owner-role gate arrives later; see "Group owners' acts and the
  manager lens" above).
- No migration. One shared SQL fragment serves point checks, lists, the
  authority preview and the mint ceiling.

### Step-up riders

- A step-up refusal whose audit row cannot be written now fails the callback
  (`500 SSO_STEP_UP_FAILED`, or the refused landing with that code) instead of
  answering the named refusal; the request still stays refused and
  uncollectable.
- `403 STEP_UP_REQUIRED` carries the `stepUp` challenge on every path: a
  credential reveal sent with no token, the Group ownership-status act and an
  owner removing a Group manager no longer drop it.
- The challenge gains `methods`: the proofs the caller's own Account can give,
  the same set `GET /auth/step-up/methods` answers.
- The Access manager's warrant create and edit, the Grants page edit, the
  connection permissions editor and workflow setup with a new Warrant now ask
  for one more confirmation when the board answers the challenge, and send the
  same request once more.

### Grant request review narrowing

- Access manager and the Approvals hub now let a human decider remove requested
  grant rows or verbs, keep fewer exact objects, replace all-of-type with exact
  IDs, and shorten the expiry before step-up. Invalid or empty edits cannot be
  approved; approving as requested and denying still work.

### Group roles: owners and managers

- A Group can now record its **owners** and **managers**. A root login session
  appoints and removes them (`POST` and `DELETE /groups/{id}/stewards`), and
  `GET /groups/{id}/stewards` lists them, owners first, each flagged **live**
  or **inert** with the reason (`principal_inactive`, `elevated_role`,
  `not_a_member`). Only parentless human or service Accounts without an
  elevated role can hold a role; rows are never edited.
- A Group owner can remove a **manager** in their own Group with a step-up
  (`DELETE /groups/{id}/managers/{principalId}`). Owner rows are removed by root
  only, and no route lets an owner appoint anybody yet.
- A live owner or manager sees the directory group catalog's **steward rows**
  (counts over their Groups' members, never identities) and their Group's grants
  without the grantor (`GET /groups/{id}/grants`).
- Deleting a Group with role rows is refused `GROUP_HAS_STEWARDS` (a count).
  Terminating an Account leaves its role rows in place, inert.
- Roles granted no edit right in that release; the "Group ownership by tier"
  entry (above) gives live owners and managers the edit tier. No MCP tool reads
  or changes a Group role. Migration 152 creates the relation.
- `relayhall group steward list|add|remove` lists, appoints and removes Group
  roles from the CLI (root login session; exact UUIDs; no step-up).
- The Access manager has a **Group roles** panel: pick a Group to see its
  owners and managers, live or inert with the reason. A root session can
  appoint and remove there.

### Step-up re-authentication that names its cause

- An Identity provider can carry a root-only `stepUpPolicy` (migration 153)
  choosing which standard question a step-up asks it: `prompt_login`
  (default true), `max_age` (default 0; `null`, 0 or 10-300 seconds) and
  `sso_step_up` (`enabled`/`disabled`). No policy is the previous request
  byte for byte, and a step-up never inherits a `prompt` or `max_age` from
  `extraAuthorizeParams`. The acceptance is unchanged: `auth_time` must be no
  earlier than the request, with no skew, under every policy. A provider that
  ignores `max_age=0` but honours a positive `max_age` stops needing a
  sign-out and a double sign-in once root sets
  `{"prompt_login": false, "max_age": 30}` for it, in the Access manager's
  Identity provider panel or with `PATCH /identity-providers/:id`.
- The step-up callback names its causes: `SSO_STEP_UP_NOT_FRESH` (the
  provider reused an earlier sign-in) and `SSO_STEP_UP_PROVIDER_DECLINED`;
  the login callback keeps `SSO_ID_TOKEN_REFUSED`. Every refused step-up now
  writes `auth.step_up.refused` with its reason (a stale `auth_time` used to
  leave no audit row), and both it and `auth.step_up.reauthenticated` record
  how far `auth_time` was from the request and what the provider was asked.
- `403 STEP_UP_REQUIRED` carries `stepUp: { error:
  "insufficient_user_authentication", action, targetId, max_age: 0 }`; an
  approval decision that meets it reopens the confirmation once.
- The step-up dialog says why a confirmation did not count, offers one
  "Try again" (always a new request), stops offering it after a second
  reused sign-in, and never suggests signing out.

### Knowledge write door — shared compartment answers

- A source may answer a note proposal with a `base` target compartment (its
  shared area) beside `personal` and `project`; the core relays, previews and
  commits it unchanged. The source still decides writability; no tool, scope
  or authorization changes. Any other compartment kind remains
  `source_protocol_error`.
- A source refusal `reserved_name` (403: the rendered note name is reserved
  for curator files; choose another title) now passes through the write door
  unchanged with `refusedBy: source`, like the other source refusals, instead
  of becoming `source_protocol_error`.

### Retire writer-less Task runtime fields

- Retired `completed_by`, `active_agent`, `acp_session_key`, `session_refs`,
  `last_checked` and `auto_created` in one migration. Task contracts and UI no
  longer expose these fields. Verifier evidence now comes from canonical
  implementation-session records and Task links; historical receipts stay
  immutable. Session existence or Task status alone never proves live work.
- A `POST /tasks` or `PATCH /tasks/{id}` that still sends one of the six
  retired keys has it silently dropped; this release adds no `FIELD_RETIRED`
  refusal for them. Migration 151 destroys the six columns' values (no copy);
  the release backup is the only preservation. It does not touch the metrics
  tables. Reserved migration 150 (metrics events) lands in a later release.

### My connections credential selection

- Setup and Advanced now let an owner choose the exact credential on a
  connection that has several. The permissions editor, step-up and credential
  details follow the chosen ID, so an API credential cannot be mistaken for the
  MCP credential in use. Switching discards unsaved edits; a missing credential
  after refresh requires a new explicit choice.

### MCP free-text trust boundary

- All MCP tool responses now mark every JSON string leaf as untrusted data or
  fence the complete plain-text, scalar, array or error body. The shared HTTP
  and stdio result path preserves existing JSON fields and refuses a root
  marker collision, covering new tools and fields alongside the existing ones.

### Current authority visibility

- Self REST/MCP/CLI and owner what-if previews show bounded live object actions
  and evaluator sources for task roles, Agent context, assigned claim and chain
  authority. The Access manager selects a credential and pages object types.
- Current credential/chain/terminal/lease limits remain; previews grant nothing.
  Agent mint audit records transaction-time context coordinates and basis.

### Warrant-carried Task unassignment

- A plain Task writer can fully unassign a Warrant-carried Task with
  `PATCH /tasks/{id}` and `executionProfile: null`. The assignment and Warrant
  pointer clear together, and the Task's Warrant-derived access is revoked.

### MCP Task history readers

- Added read-only Task stream and merged timeline tools over the existing
  guarded REST routes. Stream pages and timeline cursors expose only history
  visible to the caller; redacted content stays suppressed. Both formats mark
  board text untrusted and provide bounded continuation for long pages.

### Stored Task role grants

- Execution, Verifier, Shepherd and bound Agent roles now carry bounded Task
  and context grants on their own principals. The role and Agent bound-task
  role are stored, with a backfill for live assignments. Verifier and Shepherd
  access is read-only except for the Verifier's own verdict act; an implementer
  may write its Task. Role grants are reaped on terminal state, role departure,
  disable and credential revoke, and Agent link dates follow lease renewal.
- Agent mint session, approval and warrant paths now preserve the requested
  role. A warrant must cover the role's derived grant set as well as requested
  authority. Phase descriptions are available over REST, MCP and Brief.
- An Account-landed assignment link from before this release that the upgrade
  could not replace (an administrator holder, or an assigner it could not
  attribute) still loses a reference the Task stops making: the row is revoked
  under the usual shared-row rules. Nothing new is ever added to such a link.
- A Verifier or Shepherd change on a completed or archived Task is recorded
  without creating role rows; rows are materialized for live Tasks only.
- An Agent's role rows follow its live credentials: an undated live credential
  leaves them undated, and only an Agent with no live credential is refused.

### Task archive MCP parity

- Dedicated single-Task and completed-only bulk archive tools now use the
  existing REST authority and return its archive warnings and per-Task results.
  An appointed Main connector can restore through the existing MCP tool;
  `task_move` continues to accept archived status. Archive retry behavior is
  documented explicitly.
- The MCP/REST archive parity drill (`npm run test:archive-mcp-live`) runs on
  every full-tier CI run as the last step of `assignment_coupling_controls`,
  after its own compiled build.

### Account-bound metrics — first core step

- A dedicated `metrics:read` collector can scrape current readable project
  and task gauges with bounded, opaque labels. Unimplemented source families
  are marked unavailable. This first step leaves the remaining metrics,
  plugin and Governor deliverables open; deployment setup and authorization
  rehearsal retain their normal gates.
- Tests: the live metrics suite asserts totals as deltas over a baseline scrape, so it holds on a shared database.

### Account-bound metrics — completion events

- Task completions are recorded once per Task in Account-bound events with
  an opaque lifetime dedupe key, so reopening and completing again does not
  count twice and pruning detail rows never resets cumulative totals. The
  collector exposes completion totals, a UTC-day count and a rolling 24-hour
  count; Account deletion removes readable data and keeps only the opaque key.
- Upgrade order: a database that already applied migration 151 applies 150
  alone afterwards (pending migrations run in filename order). Migration 150
  creates only metrics tables and functions plus two AFTER triggers on Tasks
  that read the status, completion time and Account owner; it reads none of
  the columns 151 retired.

### Built-in workflow guidance

- Task and Phase Briefs and individual MCP Task/Phase reads now include the
  existing built-in guidance even without project customizations. Detailed MCP
  reads keep parseable entity JSON with a top-level `workflowGuidance` string;
  REST entity responses stay unchanged. The Task Brief distinguishes native
  finish from external worker tracking and Shepherd handover.
- MCP initialization and the session Brief now include the same product-owned
  guidance for worker Task and Report tracking, independent verification,
  bounded orchestrator discovery and narrow escalation at a real blocker. It
  distinguishes native claim/lease work from external work already assigned to
  a Task, and keeps board free text untrusted. No new endpoint or authority is
  granted by the guidance.

### Verifier-owned task success criteria

- Normal task create/update refuses `successCriteria` and `success_criteria`
  with `400 SERVER_WRITTEN_FIELD`. Blueprint instantiation preserves its
  server-side criteria seed. The assigned Verifier or account owner or appointed
  Main connector writes through one audited route, also available as
  `relayhall_task_success_criteria_set`. Task pages display criteria read-only
  to implementers and offer lawful Verifier edits.
- The schema-wide live contract now covers criteria refusal, authority,
  audit rollback and MCP parity; a persisted-column mutation control reproduces
  the implementer rewrite on the former ordinary PATCH path.
### Charter approval audit

- The existing human Project Charter approval now records one metadata-only
  `charter.approve` event in the approval transaction, including unchanged
  content. Authenticated refusals record a denied receipt. Audit or commit
  failure rolls approved Charter changes back; no pending Approval state or
  authority change is introduced.
- The audit pin, disposable-router gate and four mutation controls cover
  successful and refused receipts, transaction coupling and metadata privacy.
### Grant creation identity labels

- Creating an access grant now returns its resolved identity summaries, so
  the appended row names its holder immediately without a page refresh.
### Task guidance editing

- Removed the unsupported Agent instructions editor, which could appear to
  save edits without storing them. Task details now direct operational
  guidance to Notes and hard limits to Constraints, preserving both existing
  fields and their save behavior.
### MCP Task creation input contract

- Task creation now refuses undeclared MCP arguments by name before any REST
  operation. Its advertised schema also forbids additional properties;
  supported fields and retry headers keep their existing behavior.
### Blueprint retry bounds

- Blueprint Task retry defaults and retry placeholder bounds now accept only
  integers from 1 through 10, matching Task storage. Validation and fresh
  instantiation refuse invalid documents by name before creating workflow
  records; committed retries retain their original receipt.
### Knowledge write door — governor ceilings

- Record the knowledge source's v0 write-door defaults for open proposals per
  Account, daily commits per Account and open proposals globally, including
  their refusal statuses and `open_ceiling` reason. These are adjustable
  governor settings; changing them requires preflight and a quiet-window source
  recreation, not a code release.

### Skill and Account management audit coverage

- Skill registry creation, versioning, review decisions, retirement, audience
  changes, deletion and Project pins now commit one safe audit row with each
  write. Actor-aware refusals are audited separately without Skill prose.
- Account creation and field/status edits now commit their audit rows with
  the Account change. Audit-write failure rolls back the change and preserves
  read caches; free-text display names and purposes are omitted.

### Edit forms and approvals for authority changes

- My connections now opens an in-place permissions editor from Setup. It shows
  delegable scopes, a widening lifetime and step-up, the live Agents under the
  connection, per-Agent Revoke and a narrow-all option. The warrant registry
  and grants page offer Edit beside their existing actions, with the applicable
  lifetime and dependent-task controls. The Approvals hub shows an edit's
  object kind, field changes and chosen lifetime, and asks for a lifetime when
  approving an agent-filed edit.
- A rejected approval decision that changes no state leaves its step-up token
  available for a corrected attempt. Direct one-act edits by a signed-in
  person do not count against agents' pending or daily request quotas.

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
- **Inbox phase** — a Project can name one inbox phase; a Task created without
  an explicit phase on any surface (dashboard, REST, MCP, CLI) lands there
  with status Ideas, an explicit phase or status still wins, and the default
  is suspended while that Phase is archived or restricted (card b13e5ac9,
  migration 141; no Project is seeded).

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
- **Grant requests** — an Agent or Connector that lacks authority asks for it
  with `relayhall_access_request` or `POST /delegation/access-requests`, naming
  the objects, the verbs, a reason, an expiry of at most 90 days and the task
  or phase it is for. Filing changes nothing until root or an administrator
  approves it on the board after step-up; approval writes expiring grant rows
  on the requester's Account, revoked when the related task (or, for a
  phase-only request, the phase) is completed or archived. The approvals queue
  shows the request's kind, rows, reason and links, and a requester's own view
  says what became of each row. Amendment AZ-A9, ratified 2026-10-10 (E43);
  administrators now decide agent-mint requests too, beside the owning
  Account and root. (`785e1eed`)
- **Credential requests** — a Connector that lacks a scope asks for ONE new
  credential on itself carrying it, with `relayhall_access_request` (kind
  `credential`) or the same REST route: the scopes (never root or `*:admin`),
  an optional transport pin and label, a reason, an expiry of at most 90 days
  and the task or phase it is for. Scopes its live credentials already carry
  are refused by name. Root or an administrator decides it on the board after
  step-up, seeing the credentials the Connector holds and which scopes are
  new, and may untick scopes, shorten the expiry or narrow the pin. The same
  credential that asked then collects the new one within 24 hours and
  receives its key once; the board stores the key nowhere, and the
  Connector's current credential stays live. The credential is issued
  through the board's one issuance core, capped by the decider's authority,
  and revoked when the related task or phase is completed or archived.
  Migration 145. (`785e1eed`)
- **Edit in place** — a Connector credential's scopes and transport pin, a
  warrant's ceiling, scope ceiling, caps, expiry and pin, and a grant's verb,
  expiry and object are now changed on the existing object, which keeps its id
  (and a credential its key and secret), instead of being re-created:
  `PATCH /credentials/{id}`, `PATCH /warrants/{id}` and `PATCH /grants/{id}`,
  from a signed-in session only. The server decides whether an edit narrows or
  widens. Narrowing saves at once, for root, an administrator or the owning
  Account, and can narrow every live Agent under the connection or warrant to
  the new scopes in the same act. Widening is one approved act with a step-up,
  recorded as an Approval of the new kind `authority-edit`, and its decider
  chooses whether it stays or ends with a task (reverted automatically,
  field by field, removing only what it added; an edit no revert could undo
  by narrowing cannot end with a task, and a revert that cannot remove
  everything the widening added stays due for a person instead of being
  closed); an owning Account that is not an
  administrator widens only within the access it holds itself. An agent that
  lacks scopes on its own credential asks with `relayhall_access_request` kind
  `authority-edit`, and a person approves it on the board; the scopes are
  added to the credential it already holds. Every edit is audited with the
  value before and after, and every refused edit, a concealed one included,
  with the refusal. Credential issuance and editing now share one
  policy check (`assertCredentialPolicy`). AUTHZ amendment AZ-A13, ratified
  2026-10-11 (E95). Migration 148; the dashboard forms follow separately.
  (`1a38270d`)
- **Edit in place: the residual a revert keeps is named** (owner ruling E148,
  card `1a38270d`) — when a widening approved "until this task ends" was
  narrowed by a later edit to a value that still exceeds the one before it (a
  credential transport `mcp` → `any` tightened to `api` by its owning Account,
  a warrant pin likewise, a grant selector moved from every object to another
  object), the revert keeps that residual, as it always did, and now names it:
  the closing `approval.revoked` record carries `residual: [{field, before,
  approved, now}]` and a reason naming each field instead of "nothing the
  widening added is still present", and a revert that also took something
  back names it in its own audit row. The naming covers every edited field,
  so the closing reason is always true. No change to what a revert writes.
- **Edit in place: E2 binds edits too** (owner ruling E149, card
  `1a38270d`) — `knowledge-contents:write` reaches an Agent credential only
  through a mint that requests it explicitly; adding it to an Agent
  credential by edit is refused `422 AGENT_SCOPE_MINT_ONLY` (ahead of
  `AGENT_CREDENTIAL_NOT_EDITABLE`), root included, on `PATCH
  /credentials/{id}`, the decide on `/approvals` and the agent's door (`POST
  /delegation/access-requests`, `relayhall_access_request`), each with a
  durable denied audit row. Connector credentials are unaffected.
- **Assignment grant expiry** — the read grants an execution assignment writes
  on the assignee's Account now expire three months after the assignment by
  default. The assigning act may set `roleGrantExpiresAt` on `POST /tasks`,
  `PATCH /tasks/{id}`, `POST /tasks/{id}/recover` and the matching MCP tools:
  any earlier or later future date, set by whoever makes the assignment, or
  `'unlimited'`; a past date is refused `INVALID_EXPIRY`. No other request
  field dates the rows. A row several Tasks share is dated at the latest of
  their dates, an owner-made row is never re-dated, every date change is
  audited as `grant.expiry_change` with the date before and after, and the
  Task's Assignment access panel shows when each row ends. Existing
  assignments keep their rows until the Task ends.
  Built from ratified amendment AZ-A10 clause 6 (E43, E62); the AZ-A10 role
  rows are not built yet. Migration 143. (`785e1eed`)
- **Warrant ceiling rules on the form** — the Access manager's New warrant
  form takes a warrant's ceiling as rules as well as an existing published
  Access profile: one row per resource type with its selector form, ids and
  verbs, or a JSON array of rules pasted in and checked before any row is
  filled. The form refuses what the server would refuse before step-up is
  asked for, the profile selector and the rules exclude each other, and the
  server publishes the rules as the warrant's own Access profile in the same
  act and pins that version. A refusal is shown inside the form as the server
  sent it, and a warrant's details list the rules its pinned version carries.
  Dashboard only: the route, the API and the database are unchanged.
  (`785e1eed`)
- **Skill publication audit** — publishing a Skill Version, from the Skills
  page, the approvals queue's skill-publish item, the CLI or REST, writes one
  `skill.publish` row to the audit log against the Skill: who published and
  how they signed in, the Version and its number, the status it left, the
  Version it replaced and its content digest. The publish note is never
  recorded. The row is written in the publication's own transaction, so a
  refused or failed publication leaves none. Code only, no migration.
  (`eb7c0271`)
- **A Group is also a principal** (AZ-A12 build 1) — every Group now has a
  principal of kind `group` with the same id and the handle `group:<id>`,
  created with the Group and renamed with it; migration 146 gives existing
  Groups theirs and infers no ownership. A Group principal never acts: it has
  no credential, login session, Identity link or home group, is never a Group
  member, a parent, a Task role holder, a Report author or a principal grantee,
  and a token naming one is `401`; each is refused by name where a route
  reaches it and by a database backstop everywhere else. Every
  `/principals/{id}` change refuses it (`GROUP_PRINCIPAL_MANAGED_BY_GROUPS`,
  audited) and `GET /principals` leaves it out unless asked for `kind=group`.
  New: `PUT /groups/{id}/ownership-status`, a root login-session act with
  step-up, audited; Group delete refuses `GROUP_OWNS_OBJECTS` (counts only)
  and terminates the Group principal. Plumbing for Group ownership: nothing
  reads Group ownership yet and nothing is visible in the dashboard
  (card 20f40e40).
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
- **Decisions and notifications reach the person** — the dashboard says
  "N decisions need you" from the self-scoped pending approval queue, and a
  count it cannot read is an error with Retry, never zero; a bell in the sidebar
  account row (and in the closed mobile bar) counts
  unread notifications plus pending decisions and opens a panel of the newest,
  with mark read; `/dashboard/approvals` lists every approval through the same
  queue the Access manager mounts and shows each item's own ledger in a drawer
  (`?approval=<id>`); `/dashboard/notifications` lists notification history
  with type and unread filters, and its Timeline tab says what the timeline
  will show. Both pages are reached by link only: no menu entry was added, and
  nothing changed on the server (card b1e3b16d, lane L1).
- **Approvals are a tab of the notification centre** —
  `/dashboard/notifications` has three tabs, Notifications, Timeline and
  Approvals, addressed by `?tab=` and switched with the keyboard (Left and
  Right arrows, Home, End); the browser tab's title names the open one. The
  Approvals tab is the approvals hub itself: the same grouped list, drawers,
  step-up and filters as `/dashboard/approvals`, rendered by one component,
  and `?tab=approvals&approval=<id>` opens that item's drawer. The bell's
  "Needs your decision" row, its approval rows (and the approval rows of the
  notification history and the dashboard's notifications card) and the
  dashboard's "Review decisions" link now open the tab, and the bell's panel
  links it beside See all and Timeline. `/dashboard/approvals`, its
  `?approval=<id>` link and the Access manager's "Open in approvals hub" link
  are unchanged. Frontend only (card e2dd52b8 Part A, owner E84).
- **The Tasks board Phase filter follows the Project filter** — with Projects
  selected, the Phase dropdown lists only their Phases; with none selected it
  lists every Phase grouped under its Project's name. A selected Phase outside
  the chosen Projects is cleared, both when the Project selection changes and
  when a link or stored filter state arrives with one, and the filter bar says
  which Phase it cleared, so a Phase of another Project can no longer narrow
  the board to nothing. The dropdown gains a "Search phases" box matching a
  Phase's name or number (`10` or `#10`), with the Project search's keyboard
  behaviour and an explicit accessible name. Frontend only: the board reads the
  existing `GET /phases` and `GET /projects` lists (card 096fda30, owner E67).
- **Notification history with read state per Account, and one review page
  for every pending decision** (MIGRATION release: 144 adds the read state) —
  the bell and `/dashboard/notifications` now read the full history the board
  already keeps: status moves, stuck notices, verification requests, approval
  decisions and skill version decisions. The history filters by type, "My
  work" (the default) or everything you can see, and unread, and pages with
  Load more. Marking a row read marks it read for you only, "Mark all read"
  reaches only the rows under your filters, and the first deploy marks old
  history read. The stuck notice still reaches only the task's shepherd (else
  creator, else owner). `/dashboard/approvals` groups every pending request,
  including skill versions waiting for review that you may publish, into
  sections: one per Group, then Shared, Private, and Board-level. Each request
  says who asked, what exactly, when, and who decides it, and requests are
  decided through the existing flows only. Native verification requests still
  waiting on a task's verifier are listed there too, read-only, on tasks you
  can read: who asked, which task, when, and the verifier. Nothing decides them
  on the page, and they are counted as "waiting on a verifier", never as a
  decision. The dashboard notice, the bell and the hub count only the
  decisions you may make. Approval drawer and request
  links use the dashboard link ink with hover and focus states, the drawer's
  history names every ledger action including revoked, and each sidebar
  widget's frame is named by its visible label ("Activity Status", not the
  plugin id). Routes: `GET /tasks/notifications` gains `who`, `type`, `before`
  and `limit`, its two POST routes act on the caller's own state, and
  `GET /approvals` gains an opt-in `?view=hub` (kinds `agent-mint`, `grant`,
  `credential`, `skill-publish` and `native-review`). No decision route was
  added (card b1e3b16d, the L2 and review-page lanes; cards 6dc53ea0 and E64).
- **The Access grants form keeps what you entered** — after a grant is
  created, the form keeps the identity, resource type, permission, specific
  resource ID and expiry, so the next grant differs only in what you change.
  Before, a successful create put Resource type back to `project` and
  Permission back to `read` and cleared the resource ID and the expiry, so a
  second grant in a row could land as `project` on every resource with no
  expiry. The status line now names the grant it created (permission,
  resource type, the resource or every resource of the type, expiry and
  identity) and says the form kept those values, and a grant with a blank
  resource ID, which covers every resource of its type, asks for confirmation
  first. Frontend only; the grants API is unchanged (card 21787b03).
- **Agent sessions hides short sessions, and gains a reporter filter and paging**
  — the Sessions list no longer fills with empty sessions: a session with at
  most 3 events, lasting under 2 minutes, and with no model and no tokens is
  hidden by default, on the server before the 50-row limit, and counted. "Show
  N short sessions" lists them, and the page says what "short" means. Reporter
  and Product selects narrow the list on the server, "Load more" pages through
  it, and the 20-second poll refreshes every loaded page without resetting the
  filter, the toggle or an open timeline. A short session's deep link still
  opens it, and the plugin bridge still receives every session. Stats keep
  counting every session and event and now say how many are short under the
  Sessions and Events figures. `GET /telemetry/sessions` gains `includeShort`,
  `connectorId`, `sourceProduct` and `offset`, answers with `hiddenCount`,
  `shortCount`, `total` and `nextOffset`, and refuses a malformed filter with
  `INVALID_SESSION_FILTER`; `GET /telemetry/stats` gains
  `totals.shortSessions` and `totals.shortSessionEvents`. Retention is
  unchanged. Code only, no migration (card 0ac41d40, owner E89 (b)).

### Registries

- **A Skill name in the path is refused, not a server error** — every
  `/skills/{id}` route answered `500 INTERNAL_ERROR` when the path carried a
  Skill's name in place of its id, such as
  `GET /skills/relayhall-release-review`: authorization resolves a Skill by
  name, so the name reached the handler, which passed it to a uuid-typed
  read. Once authorization admits the request, each route now refuses an id
  that is not a full UUID with `400 INVALID_SKILL_ID` before it reads
  anything, and a Version reference that is neither a Version UUID nor a
  Version number from 0 to 2147483647 with `400 INVALID_SKILL_VERSION_ID`;
  `relayhall_skill_get` returns the same refusals. An unknown UUID still
  answers `404`. The same defect on `GET /principals/{id}/credentials` and
  `POST /principals/{id}/terminate` (any non-UUID id) now answers
  `400 INVALID_PRINCIPAL_ID` after the route's authority check. Code only,
  no migration (card 9cdc6b27).
- **A path id that is not a full UUID is refused on every family, not a
  server error** — the census of the same class, driven through every
  mounted route with a path parameter, found it on eleven more families, and
  each now refuses such an id by name with `400` before anything reads it.
  Projects (owner ruling E159, "refuse names"): a Project's name in the path
  passed authorization, which resolves names, and answered `500` on about
  twenty handlers and `503` on the owner paths; any `/projects/{id}` route now
  answers `400 INVALID_PROJECT_ID` for an id that is not a full UUID (a
  caller the route ceiling refuses keeps its `403`), and a malformed Resource
  or pinned Skill id `400 INVALID_RESOURCE_ID` / `400 INVALID_SKILL_ID`; no
  name is resolved to an id. Tasks: authorization resolves an 8-character Task
  id prefix, and about twenty handlers answered `500` or `503` for one (and
  `POST /tasks/{id}/brief` never answered at all); every Task route now
  answers `400 INVALID_TASK_ID`, and a malformed Lease id
  `400 INVALID_LEASE_ID`. `PATCH` and `DELETE /personalities/{id}` take the
  Personality id (`400 INVALID_PERSONALITY_ID` for every non-UUID name before
  lookup, after root authority; unknown UUIDs retain `404`; `GET` still reads
  by slug). Identity-provider routes answer `400 INVALID_IDENTITY_PROVIDER_ID`,
  `INVALID_IDENTITY_LINK_ID` or `INVALID_GROUP_ID`; credential reveal, revoke
  and rotate `400 INVALID_CREDENTIAL_ID` after their authority check;
  `DELETE /notification-endpoints/{id}` `400 INVALID_NOTIFICATION_ENDPOINT_ID`;
  `GET /appearance/asset-versions/{id}` `400 INVALID_APPEARANCE_ASSET_ID`;
  `DELETE /auth/sessions/{id}` `400 INVALID_SESSION_ID`; the OAuth consent
  read and decision `400 invalid_request` with code
  `INVALID_AUTHORIZATION_REQUEST_ID`. A Version number past 2147483647 (an
  integer column) answers `400 INVALID_QUERY_VALUE` on a Charter or
  descriptor Version and `400 INVALID_VERSION` on an Appearance revert. The
  account-owner arm of authorization no longer reads an identifier that is
  not a full UUID, so the admin-action Task, Phase and Report routes answer
  the caller's ordinary refusal instead of `503`. The MCP tools that compose
  these routes return the same refusals. A full UUID, in either case, answers
  exactly as before. Pre-read Version and Personality refusals match Express's
  case-insensitive fixed words and optional trailing slash while preserving
  identifier spelling.
  The pinned endpoint probe puts its tsx sockets in short per-run temporary
  directories, independent of clone path length. A mocked
  per-file route census complements the real-PostgreSQL census. Code only,
  no migration (card bc847bd0).
- **Sidebar account row** — the pinned row shows only a small avatar, the
  signed-in account name and the notification bell; the Settings link sits
  immediately above Logout, where the less frequent actions live; the identity
  widget's fold is labelled "Activity Status" instead of the legacy "NIM ORB".
  The left menu itself is unchanged.
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
- **MCP-derived sessions** — a Connector that declared a telemetry tier and
  works through the board's MCP server now appears on Agent sessions from its
  own tool calls, as an `mcp` source under its display name: a session row
  when its credential bootstraps, a heartbeat bounded to one a minute per
  session, `stale` after the shipped nine-minute window, `finished` when the
  credential bootstraps again or its bootstrap lapses, and a link on the
  Task's liveness chip while it holds that Task in progress — with several
  held, the one it last named in a `taskId` brief, a claim or a move, which
  the link keeps while that Task is held. The rows are the
  caller's own Tier-0 telemetry, written through the reporters' write paths
  under its own authenticated chain; nothing outside the telemetry tables
  changes, no argument can name another owner, and a Connector that declared
  no tier is never shown. The Sessions table gains a Reporter column, and
  Sessions and Stats name a reporter by its display name. No migration.
  (`35b73092`)

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
- The session brief, which is the bootstrap, demanded `principals:read`, so an
  Agent minted with only task and Report scopes could never bootstrap and every
  work-plane tool refused it. Any credential now compiles its own session
  brief; its Task, Report and Skill content still requires `tasks:read` (or
  `principals:read`) and the caller's grants, and reading other principals
  still requires `principals:read`. (`1118fefa`)
- An Agent minted with no object rule, which is what the approval path, the
  session mint form and `relayhall_agent_mint` produce when no rule is
  requested, bootstrapped and was then refused at the claim of its own bound
  task, so it could do nothing. An empty rule list now reads as read and write
  on the bound task only, within what the parent Connector and Account may do
  there; rules that are named, including a read-only narrowing, are read as
  stored. (`c334177b`)
- The Agent mint ceiling compared a request with grant rows, matching verbs
  exactly, so it was narrower than the check that decides every act. An Account
  that owned the Task's Project, or held only a write grant or a Project grant,
  was refused authority it uses every day. The ceiling was also not checked when
  a request was filed, so a request no one could approve stayed pending. The
  ceiling is now the live check itself, never wider and never narrower, and it
  runs when the request is filed, naming the failing rule. (`785e1eed`)
- `PATCH /tasks/{id}` accepted the internal `executionServiceId` and
  `executionDescriptorVersion` keys and wrote them as the Task's execution
  assignment, so a caller with plain Task write and no `services:invoke` could
  reassign a Task to another Connector, whose Account then gained read access
  through the swapped vehicle, or pin a descriptor version the Connector never
  published, with no descriptor validation and no Warrant check. Both keys are
  now refused by name (`400 SERVER_WRITTEN_FIELD`) on `POST /tasks` and
  `PATCH /tasks/{id}`; the assignment is written only from an
  `executionProfile`. (`7c77fcf3`)
- `PATCH /tasks/{id}` passed the whole request body to the Task write, so a
  caller with plain Task write could set fields only the server should write:
  the Verifier's retry budget (`attemptCount`, `maxRetries`), the review flag
  and history (`needsReview`, `reviewHistory`), the review evidence
  (`completedBy`, `sessionRefs`) and the runtime linkage (`activeAgent`,
  `acpSessionKey`, `discordThreadId`, `lastChecked`, `thinkingAutoEstimated`,
  `autoCreated`). `POST /tasks` also stored five of these keys. Every column of
  a Task is now classified as a request field or as server-written, and a
  live gate reads the table's columns from the database and fails until a new
  column is classified. Both routes refuse any key that names a server-written
  column with `400 SERVER_WRITTEN_FIELD`, and that includes keys the server
  used to drop without saying so, such as `id`, `created` and the lifecycle
  timestamps. `PATCH` passes only request fields to the write. Unknown keys
  are still ignored. (`c3880767`)
- `PATCH /tasks/{id}` with `executionWarrantId: null` and no
  `executionProfile`, on a Task whose execution assignment a Warrant carried,
  dropped the Warrant and carried the assignment on an auto-grant under the
  editor's authority, with no `services:invoke` check. Owner ruling E100
  (option (a)): this is an execution reassignment like any other, so a caller
  without `services:invoke` is now refused `403 WARRANT_DROP_INVOKE_REQUIRED`
  before any write, with a denied audit row, and the Warrant stays. A holder
  of `services:invoke` still swaps the Warrant for an auto-grant, and on a
  Task no Warrant carries the null changes nothing. (`69943b61`)

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
- **Knowledge writes through the door** (RB-11 Governor v0) — a new scope,
  `knowledge-contents:write`, and three MCP tools with REST twins:
  `relayhall_knowledge_note_propose`, `_preview` and `_commit`
  (`POST /knowledge-writes/{propose,preview,commit}`). They relay a note to a
  registered source's own write surface with a signed write assertion
  (`rh-knowledge-write-assertion+jwt`) that carries the Account, the verb and
  the Task context the core verified, and return the source's answers unchanged
  — the commit's ref sealed into a handle. RelayHall stores no note content.
  An Agent holds the scope only when its mint names it, inside the parent's
  grants. Every act writes a fail-closed audit row before and after the dial
  (migration 147, `knowledge_write_audit`); the source's refusals pass through
  by name. Owner plane: `knowledgeWriteEndpoint`, with a descriptor `write`
  block. The scope is role-derived like every non-admin scope, so ordinary
  login sessions carry it. Nothing is live until an owner configures a
  write-capable source (card b796067e).
- **Default search scope** (owner ruling E127 (5), card 40e0e542) — a
  knowledge search covers current knowledge by default. A source may declare
  some categories as its archive (`knowledgeSource.archiveCategories`, a
  subset of its declared categories); the core subtracts them from the
  categories it asks that source to search unless the caller opts in with
  `includeArchive` — a REST field, an MCP argument, `knowledge search
  --include-archive` on the CLI and an "Include archive" checkbox on the
  Knowledge page, remembered per Account in the browser. The flag is never
  sent to a source and grants nothing. The coverage record names
  `searchedCategories` and `archive.included`, every MCP answer opens with
  one sentence saying what was searched, and handles from a default search
  cannot open an archive document. Selector contract amendment v1.2 (schema
  sha256 pinned in the core); `POST /knowledge-queries` is now in the OpenAPI
  document and the API reference.
- **Default search scope, review rider** (card 40e0e542) — the scope sentence
  is true in each situation: it says when no consulted source declares an
  archive, and when every source that declares one refused the opt-in. The
  coverage record names those sources in `archive.declaredBy`, the search
  ledger records the opt-in on each fan-out entry, and an "Include archive"
  tick made before the Knowledge page knows the Account is kept and
  remembered.

### Continuous integration

- CI runs in two tiers. The fast tier runs on every push and covers the
  repository and deployment contract, type checking, the mocked suites, the
  frontend build and the accessibility smoke set. The full tier runs on demand
  and covers every gate that needs a real PostgreSQL, every mutation drill and
  every red-proof control. A shape gate requires each gate step to appear
  exactly once across the two workflows, so a gate cannot be dropped or quietly
  duplicated. See [docs/ci.md](docs/ci.md).
- Budgets for a loaded runner. The Task details page suite carries file-wide
  test, hook and wait budgets measured on a one-core starvation drill, and the
  FEAT-A drill that runs it as a baseline allows one run 30 minutes; the
  Agent mint-ceiling parity matrix builds under its own hook budget; the
  mint-ceiling mutation drill reports a run that never reached its declared
  assertions (a hook timeout, a compile error, an unreachable database) as
  INCONCLUSIVE rather than MISS; and the Blueprint examples drill gives each
  fixture migration 900 seconds and names the failure that preceded an
  incomplete cleanup. No assertion changed. (`696f3bb8`)
- Full-tier job budgets. The runner caps a job at 150 minutes (was 75) and the
  six long full-tier jobs declare the same; the document-controls job already
  took 63 minutes on an idle runner and was killed twice when lanes shared the
  host. No gate changed. (dispatcher, 11 Oct 2026)
- Release tags do not run CI. The fast tier's push trigger is now every branch
  except `ci-full/**` and every tag except `v*` (`tags-ignore: ['v*']`), with
  pull requests unchanged; a release tag is placed only after a full-tier green
  on its exact SHA and a green readback, so a run on the tag re-tested a
  deployed commit and took a runner slot. No gate changed. (`2108b6cf`)

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
- **Build identity on About** (card 6d549392) — About shows the deployed
  frontend and backend builds side by side: version, commit, dirty flag,
  build context and build time, each read from the record the image wrote at
  build time and each shown as Unavailable on its own when missing. A
  `builtAt` with an offset and microseconds (as the release tooling stamps
  it) no longer blanks the panel, a dirty build shows `dirty=true`, differing
  frontend and backend identities are named, and Retry fetches every source
  again. The backend's record is served in the `build` object of `GET /api/`.
  Version and API version are the release version passed at build time as
  `RELAYHALL_RELEASE_VERSION` (`1.0.0-beta.<N>` for release batch N); a build
  without one reads `<package version>+unreleased`. Both images write their
  manifest with one committed writer that fails the build on a malformed
  version. See [docs/build-identity.md](docs/build-identity.md).

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
