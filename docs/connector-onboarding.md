# Connector onboarding

A new connection needs three things: an MCP server entry in the client, a
credential kept somewhere safe, and a way for a fresh session to find out what
it may do. The one-time onboarding pack covers all three. Next to the
per-client configuration blocks it carries **one bootstrap prompt** and a few
lines of **secure configuration guidance**. A session that receives the prompt
needs no other operator knowledge: it loads the published
`relayhall-connector-bootstrap` Skill from the registry and follows it.

## The bootstrap prompt

For a board at `https://<your-board>/api` the prompt reads:

```text
Connect to the RelayHall MCP server "relayhall" at https://<your-board>/api/mcp with the credential from your secure store; never paste the credential into this chat.
Read only the board, through this MCP server, and this connector's own folders (its MCP entry, its local connection skill and its state folder); never the owner's private working set, other sessions' scratchpads or other hosts.
Call relayhall_brief_compile with {"session": true} to get your session brief.
Find the published Skill relayhall-connector-bootstrap with relayhall_skill_list, load it with relayhall_skill_get (fullContent: true) and run the onboarding it describes, using only what this harness supports.
Finish with a readiness matrix: measured results with real ids, then the remaining gaps. Do not arm or claim unrelated work.
```

The board renders it from the MCP endpoint alone; the function that writes it
is never handed the credential, so the prompt is the same before and after a
credential exists and is safe to keep, share and re-run. Its second line bounds
what a new connector reads: the board, through MCP, and the connector's own
folders, never anything else on the machine or another host. The line itself
names those folders (the client's MCP entry, the local connection skill and
the connector's state folder), so a client opened inside some other folder
cannot count that folder as its own before the Skill loads.
The registry Skill repeats that sentence word for word as a ground rule. The block above is
checked against that renderer by the backend test suite, so it cannot drift
from what the board serves.

Where it appears:

| Surface | Where |
| --- | --- |
| Dashboard | Connect your agent (step 3), Create identity (last step), My connections > Setup, and the agent pack in the Access manager |
| CLI | `relayhall credential issue <connector> ...` and `relayhall agent mint ...` print it after the one-time secret |
| REST | `onboarding.bootstrapPrompt` and `onboarding.configurationGuidance` on every pack; `instructions.bootstrapPrompt` on `GET /principals/me/connectors` |

A connection pinned to the `api` transport is refused on the MCP endpoint, so
the dashboard says the prompt does not apply instead of offering it.

## One connector per harness

A harness is a client that works tasks from the board: Claude Code, Codex,
VS Code or Antigravity. Each harness on a machine gets **one connector** and
that connector holds **one token**. The Connect your agent wizard offers these
four as templates, next to Generic MCP client, API script and the (not yet
available) messaging gateway, which are unchanged.

**The token.** One credential, pinned to the `any` transport so the same token
works on the REST routes and on the MCP endpoint. Its sixteen scopes are the
agent working set, the three the connector's other jobs need, and five for the
work a connected harness does on the board:

| Scopes | Why |
| --- | --- |
| `tasks:read`, `tasks:write`, `reports:read`, `reports:write`, `projects:read`, `phases:read`, `skills:read`, `skills:use` | the agent working set |
| `telemetry:write` | presence and usage-quota reports |
| `services:read` | the connector reads its own descriptor |
| `principals:read` | the session brief and the Agent mint read the caller's principal |
| `knowledge-contents:read` | research: search and read the board's knowledge sources |
| `personalities:read` | read the Personalities the board offers and a Task names |
| `blueprints:use` | preview and instantiate a published Blueprint (see below) |
| `projects:write` | instantiate a Blueprint: every instantiation writes into, or creates, its target Project |
| `phases:write` | instantiate a Blueprint that has Phases: the instantiation creates them |

**`blueprints:use` is not read-only.** It lets the connector preview a
published Blueprint and instantiate it, and instantiating creates Tasks (which
`tasks:write` already allows) and, for a Blueprint that has them, Phases and
Reports. It is not `blueprints:read`: the connector sees a Blueprint's use-only
view (name, parameters, plan), never its version history or instantiation
ledger. Instantiating also needs `projects:write`, and `phases:write` for a
Blueprint with Phases; the harness set carries both, so a connector can preview
a Blueprint and instantiate it, Phases included. Object grants still apply on
top of every scope: the Blueprint and the target Project must be ones the
connector may use and write.

**`projects:write` and `phases:write` are not Blueprint-only.** They are the
ordinary write verbs of those objects, so the connector can also create
Projects and change, archive and restore the Projects and Phases it may write
(a Project's Resources included); object grants decide which. Deleting a Phase
stays `phases:admin` and writing a Charter stays with the owner, and the set
carries neither.

A connection made before the set had sixteen scopes keeps the credential it
has: nothing widens it on its own. To widen it, edit its scopes on the
Credentials page; until then `relayhall connector check` names the scopes it
lacks.

It never carries `root`, an `:admin` scope or `services:write`: a connector
reads its descriptor, it does not rewrite it. The wizard offers this set and
nothing above it, cut down to what the signed-in person may delegate (a person
who cannot delegate a scope simply does not get it). Every other template keeps
the rule that a new connection starts with everything its owner may delegate.

**What the wizard registers.** In the same call that mints the token, the
connector's service is registered with its first descriptor and published, so
the board can use it at once:

| Template | Telemetry tier | Product it reports under |
| --- | --- | --- |
| Claude Code | `full` | `claude-code` |
| Codex | `full` | `openai-codex` |
| VS Code | `presence` | `vscode` |
| Antigravity | `presence` | `antigravity` |

The product matters because quota reports are accepted only for a product the
connector declared, and the tier matters because session telemetry is refused
for a connector that declares none. The published service matters because the
wake socket resolves a connector principal to **exactly one** published
service. That is why each harness gets its own connector instead of one
connector fronting several: a principal that fronted two published services
could not be rung. Registration, descriptor and token commit together or not
at all (see [services.md](services.md)).

**The install line.** On the last wizard step the first thing shown is one
line to run on the machine where the harness lives, in place of a
configuration snippet:

```text
relayhall connector install --harness <claude-code|codex|vscode|antigravity> --board https://<your-board>
```

It names the harness and the board's origin and nothing else. The installer
asks for the token at a hidden prompt, so the token never appears on a command
line, in a shell history or in a process list; the wizard shows the token once,
in its own block, to paste there. Under the install line the per-client
configuration blocks are folded into one closed **Set up by hand instead**
disclosure, which says what they cost: they put the token in the client's own
configuration or environment. They stay for the platforms the installer does
not run on yet (macOS and Linux).

If the person making the connection cannot delegate part of the harness set,
the wizard names the scopes the token will lack (for example
`telemetry:write`), and counts what it issues against the whole set of
sixteen, so a cut-down token never reads as complete.

## The local connector

`relayhall connector` is the one local component a person installs once per
harness per machine. It is part of the `relayhall` CLI (`cli/relayhall`,
standard-library Python 3.10 or newer, nothing to install). It runs on the
person's machine and only dials out to the board over HTTPS: it opens no port
and needs no SSH. In this version it runs on **Windows**; on macOS and Linux
every verb says so and stops (exit 3) before it asks for or reads anything, and
those clients are set up by hand.

| Verb | What it does |
| --- | --- |
| `install --harness <h> --board <origin> [--name N] [--alias A] [--token-stdin]` | Takes the token once (hidden prompt, or one line on stdin), checks it with `GET /api/principals/me` and an MCP `initialize`, stores it, writes the client's MCP entry, installs the connection skill where the client has one, and registers the sign-in task. |
| `check [--name N]` | Custody, the board over HTTPS, whoami (the principal install recorded), the harness scope set, and an MCP round trip (`relayhall_principal_whoami`) through the real proxy. Exit 0 only if all pass. |
| `status [--name N]` | Names, ids and states only, from local state: no network, no secret. |
| `uninstall [--name N]` | Removes exactly what install recorded it created, and nothing else. |
| `mcp --name N` | The stdio MCP proxy the client starts. Not for interactive use. |
| `mcp --run FOLDER` | A harness run's proxy, written into that run's configuration by the ring: it serves the run's Agent credential, never the connector's token. Not for interactive use. |
| `run --name N` | What the task runs: it confirms custody and, when the collector is configured, runs one collector cycle. With the ring enabled it is the long-running daemon instead: see [The ring](#the-ring-wake-catch-up-and-runs). |
| `collect --once\|--check [--name N]` | The usage-quota collector: see [The usage-quota collector](#the-usage-quota-collector). |

**Where the token lives.** Encrypted with Windows DPAPI in the CurrentUser
scope (`CryptProtectData`, no machine-wide flag, bound to the connector's name)
at `%LOCALAPPDATA%\RelayHall\connector\<name>\token.dpapi`. Only the same Windows
user on the same machine can decrypt it. That is not a boundary against another
program running as the same user, which can ask Windows to decrypt it too. The
token is never put on a command line, in an environment variable, in a log, in
the client's configuration or in the connector's own record
(`connector.json` beside the blob holds names, ids and paths only). The
installer ignores `RELAYHALL_TOKEN` and refuses the global `--token` flag; when
`RELAYHALL_TOKEN` is set it suggests removing it from the persistent user
environment too, once `check` passes.

**The client's MCP entry.** The client starts the connector's stdio proxy
instead of holding the token. The proxy reads the token from custody at start,
forwards each JSON-RPC message unchanged to `<board>/api/mcp` with
`Authorization: Bearer ...`, carries the negotiated `MCP-Protocol-Version`
header, never follows a redirect, never sends a board on this machine's
loopback through an environment proxy, and answers a request the board could
not serve (unreachable, a reply cut off or malformed on the wire, anything that
is not JSON-RPC) with a JSON-RPC error instead of silence.

| Client | File | Entry |
| --- | --- | --- |
| Claude Code | `.claude.json` in the user's home (or `$CLAUDE_CONFIG_DIR`) | `mcpServers.relayhall`, `type: stdio` |
| Codex | `config.toml` in `~/.codex` (or `$CODEX_HOME`) | `[mcp_servers.relayhall]`, between `# >>> relayhall connector <name>` markers |
| VS Code | `mcp.json` in the user's VS Code folder | `servers.relayhall`, `type: stdio` |
| Antigravity | `~/.gemini/config/mcp_config.json` | `mcpServers.relayhall`, marked by `env.RELAYHALL_CONNECTOR` |

Install writes nothing when the entry is already there, and refuses a file it
cannot rewrite safely (JSON with comments or trailing commas, a key given
twice, invalid TOML, an entry written as an inline table) before it stores the
token.

**Antigravity.** Its MCP config is plain JSON, which has no comments, so the
installer's managed block is one server entry, recognised by a marker field in
the entry's `env` map:

```json
{
  "mcpServers": {
    "relayhall": {
      "command": "<python>",
      "args": ["<cli>/relayhall", "connector", "mcp", "--name", "<name>"],
      "env": {"RELAYHALL_CONNECTOR": "<name>"}
    }
  }
}
```

The marker holds the connector's name and nothing secret. An entry without it
(for example one added by hand that starts the same proxy) is not the
installer's: install keeps it in the connector's folder, replaces it, and
`uninstall` puts it back. Before install changes an existing file it copies the
whole file, byte for byte, beside it as
`mcp_config.json.relayhall-backup-<UTC timestamp>` (readable by the owner only
where the platform allows), and says where. When the file holds another
credential (another server's, or under any other key) it makes no such copy and
says so, naming the field unless the field's own name looks like a secret,
because a copy would put that credential on disk a second time. It then writes
its entry without a backup rather than refusing: never copying a credential
outranks the backup. A second run that changes
nothing makes no second copy. Every other server and key in the file keeps its
value and order (and a byte-order mark, if the file had one); `uninstall`
removes only the `relayhall` entry and leaves the copy for the person to
delete. If an earlier entry under the same
name was there, install keeps that entry alone (never a copy of the whole file,
which can hold other credentials) in the connector's folder, replaces it, and
`uninstall` puts it back. **An earlier entry that carries a credential is never
replaced**: an `Authorization` header, a bearer or an environment token with a
value, or anything else shaped like a secret (a reference such as
`${RELAYHALL_TOKEN}` is not one). Keeping it would put that credential on disk
outside custody, so install stops, names the file, the entry and the field
(never the value), and asks for that entry to be removed by hand or for another
`--alias`. When that credential is the token being installed, it says so: do
not revoke it, the connector keeps it. A connector keeps the `--alias` it was
installed with; to change it, uninstall first. Restart the client after
installing, then run `relayhall connector check`.

**The task.** A per-user Task Scheduler task, `RelayHall Connector
<name>`, triggered at the user's own sign-in and every five minutes after,
running as that user with least privilege (no administrator rights), restarted
up to three times on failure, never two at once. It runs `relayhall connector
run --name <name>`. Task Scheduler does not stop it (no execution limit): with
the ring enabled it is the long-running daemon, and a harness run lives inside
it. Without the ring each run is one collector cycle, which ends itself after
fifteen minutes at most. A connector installed before the collector or the
ring existed gets the five-minute trigger and the lifted limit when `install`
is run again (`check` says so).

**Connections made earlier** keep the credential they have. This release
changes only what the wizard creates. Moving an existing connection to the one
token is an edit of that credential in My connections (it asks for step-up
when it widens), followed by revoking the credential it replaces.

## The usage-quota collector

`relayhall connector collect` reads the plan quotas of the harness's accounts
and posts them to the board's Usage Limits, with the connector's one token from
custody: there is no second token, and no file the collector reads one from.

| Harness | What it reads | Provider |
| --- | --- | --- |
| Claude Code | the installed Claude Code answers its own `get_usage` control request; no prompt, so no turn runs | `claude-code` |
| Codex | one `codex app-server` session: `account/read`, `account/rateLimits/read`, `account/read` | `openai` |
| VS Code, Antigravity | no known source: a configured account posts `status: unsupported` | — |

Each reading is an `rh.usage-quota/1` snapshot posted to
`POST /api/telemetry/quotas` and read back exactly with
`GET /api/telemetry/quotas`; posts are spaced 1.5 s apart and a 429 is retried
up to three times. The account in each Claude Code configuration folder, and
the ChatGPT account Codex answers for, must match the account's pin before and
after the read (`ACCOUNT_CHANGED_*` discards the reading). An account folder
with no sign-in yet posts an honest `not-reported` row with
`errorCode: auth-required`.

**Configuration.** `collector.json` in the connector's folder, beside
`connector.json`, names the accounts. It holds labels, opaque account ids and
sha256 pins, never an e-mail address or a credential:

```json
{
  "schemaVersion": "rh.connector-collector/1",
  "harness": "claude-code",
  "claudeBinary": null,
  "registrations": [
    {"registrationId": "laptop-a", "provider": "claude-code", "sourceProduct": "claude-code",
     "providerAccountId": "anthropic-0123456789abcdef", "label": "Claude · personal",
     "discoveredAt": "2026-10-24T09:00:00.000Z", "configDir": null,
     "accountPin": "<sha256 of the oauthAccount.accountUuid in that folder's .claude.json>"}
  ]
}
```

`configDir` is the account's Claude Code configuration folder
(`CLAUDE_CONFIG_DIR`; `null` is the user's own) or, for Codex, its `CODEX_HOME`.
A Codex `accountPin` is the sha256 of `chatgpt:` followed by the account's
lower-cased e-mail address. `claudeBinary` defaults to the npm-installed
`%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`. Up to
eight accounts.

| Command | What it does |
| --- | --- |
| `collect --once [--name N]` | One cycle: trust check, then every account read and posted. Exit 0 when every account was read and posted, 1 otherwise, 75 when another cycle holds the lock. |
| `collect --check [--name N]` | The trust check and a dry read of every account; posts nothing. |
| `check` | Also runs `collect --check` when `collector.json` is present: `harness binary trust` and `quota dry read`. |
| `run` | What the task runs: one `collect --once` when `collector.json` is present. |
| `status` | The last cycle: accounts read, codes, the trusted version. |

**Trust before any read.** The harness binary runs only after it passes
the trust policy for its product on this operating system: by verified
publisher and package identity, never by one exact version. Every new version
that verifies is accepted automatically, recorded once in the connector's
append-only, hash-chained `trust-ledger-v1.jsonl` (version, signer, hashes) and
reported afterwards as the telemetry event `connector.trust.accepted`; no
person acts per version. A mismatch refuses that binary with a named code
(`connector.trust.refused.<CODE>`), nothing is run, and each account's row says
`errorCode: untrusted-binary` instead of going stale. On Windows:

- **Codex** (the Microsoft Store package `OpenAI.Codex`): the package
  registration (name, publisher, the publisher id derived from it,
  architecture, Store signature kind, not a development registration); Windows'
  own Authenticode verification, status Valid, of the package's `codex.exe` and
  of `AppxSignature.p7x`; for each, the signer subject, the required EKUs, and an
  offline chain whose issuing CA matches a pinned subject pattern and whose
  remaining certificates are a pinned policy CA and root, by thumbprint; the
  package manifest's identity; and the per-user copy the app runs from is
  byte-identical to the verified package binary.
- **Claude Code** (the npm package `@anthropic-ai/claude-code`, which ships a
  native `bin/claude.exe`): Authenticode status Valid on `claude.exe`; the
  signer subject is Anthropic, PBC's extended-validation subject; the
  code-signing EKU; an offline chain through the pinned DigiCert G4
  code-signing CA to a pinned DigiCert root, by thumbprint (either of the two
  paths Windows builds); and the binary sits at `bin/claude.exe` of a package
  whose `package.json` names `@anthropic-ai/claude-code`. The version is read
  from that `package.json`, which is not signed: it is recorded and checked
  against the minimum and the deny list, but the cryptographic fact is the
  signature over the exact `claude.exe` bytes, whose sha256 the ledger records
  and which are hashed again before every read and after it.
- Leaf certificates are recorded, never pinned; revocation is not checked (an
  offline chain). npm registry provenance and macOS signing are later releases.

**The policy, and the board's override.** The policy ships inside each
connector release (`cli/connector_trust_policy.json`, pinned by its sha256) and
is the CEILING. The board serves an override at
`GET /api/connectors/trust-policy` (route ceiling `services:read`) that can
only narrow it: raise `minimumVersion`, add `denyVersions`, remove a publisher.
The connector applies the intersection and ignores, and reports as
`connector.trust.override_rejected.<CODE>`, any entry that would widen it; the
board already refuses such an entry before serving and names it in `rejected`.
A new publisher or issuing chain arrives only in a connector release. When the
board cannot be reached, the last override it served still applies; a board
without the route means the release policy alone. In this release the override
is the deployment's `connectorTrustPolicy` in `relayhall.config.json`:

```json
"connectorTrustPolicy": {
  "schemaVersion": "rh.connector-trust-override/1",
  "products": {"codex": {"windows": {"minimumVersion": "26.1021.0.0", "denyVersions": ["26.1021.1.0"]}}}
}
```

**Reliable reads.** Every read is a child process the connector owns,
with a hard deadline (40 s for Claude Code, 20 s for Codex), and its whole
process tree is ended on every path: a Windows Job Object that kills every
process in it, and `taskkill /T` as a second net. Nothing waits for a pipe
without a deadline, so a grandchild holding the provider's output can no longer
hold the collector. A transient failure (`PROVIDER_TIMEOUT`, `PROVIDER_EXITED`,
`PROVIDER_START_FAILED`, `PROVIDER_PROTOCOL`, `PROVIDER_INIT_REFUSED`,
`PROVIDER_USAGE_REFUSED`, `PROVIDER_RESPONSE`, `PROVIDER_OUTPUT_LIMIT`) is
retried up to three times with 2 s and 5 s backoff, inside one 240 s cycle; an
account mismatch, a provider that started a turn (`PROVIDER_TURN_STARTED`) and
a trust refusal are never retried. The run lock is an operating-system byte
lock, released on every exit path and by the system if the process ends; a
watchdog ends a run that overruns its cycle by a minute, and the task's
fifteen-minute limit is the outer net. A child the connector could not end is
recorded, and new reads wait (`OWNED_CHILD_CLEANUP_UNRESOLVED`) until it is
gone. A read that still fails is reported to the board BY NAME: the account's
row keeps its last reading with a later `checkedAt` and an `errorCode`
(`timeout`, `unavailable`, `auth-required`, `untrusted-binary`), and the event
`connector.collector.refused.<CODE>` carries the exact cause.

**What it records.** `collector\last-attempt.json` holds codes, counts,
versions and timestamps only: never a token, an e-mail address or provider
output. Uninstall removes the collector's own runtime folder and leaves
`collector.json` and the trust ledger, which install did not write.

## The ring: wake, catch-up and runs

With a valid `ring.json` in the connector's folder and `"enabled": true`,
`relayhall connector run` is a long-running daemon (one per connector; a second
one stands down with exit 75). It dials out only: one WebSocket to
`<board>/api/events/ws?wake=2` with the connector's token in the
`Authorization` header (never in the URL), described in
[connector-notifications.md](connector-notifications.md#wake). Nothing listens
on the machine.

```json
{
  "schemaVersion": "rh.connector-ring/1",
  "enabled": true,
  "kinds": {"implement": "run", "verify": "run", "stuck": "notify"},
  "maxConcurrentRuns": 1,
  "runTimeoutMinutes": 60,
  "workdirs": [{"path": "C:\\work\\project-a", "projects": ["<Project id>"]},
               {"path": "C:\\work\\scratch"}],
  "serviceId": "<this connector's service id, optional>",
  "hold": false,
  "notify": true,
  "claude": {"permissionMode": "acceptEdits", "allowedTools": ["mcp__relayhall"]},
  "codex": {"sandbox": "workspace-write"}
}
```

The policy fails closed: an unknown field, a value out of range or a missing
file stops the ring (`check` names the field; the daemon then runs one
collector cycle as before). `kinds` takes `run`, `notify` or `ignore` per kind;
`stuck` takes `notify` or `ignore` only. `maxConcurrentRuns` is 1 to 4,
`runTimeoutMinutes` 5 to 240. A Task runs in the first `workdirs` entry that
names its Project (read through the Task's Phase), else in the first entry
that names none; a Task no entry covers is refused `WORKDIR_NOT_CONFIGURED` and
the person is told. `hold: true` starts nothing (`USAGE_HOLD`) and keeps the
work for later. `serviceId` lets the local own-work guard work before the first
implement wake has taught the ring its own service.

**What it does with a wake.** It acknowledges at once (`wake.ack`: the daemon
has it), re-reads the Task under its own token, applies the policy and reports
what it did on the same socket as `wake.outcome`: `started` then `finished`,
or `refused` or `notified`, each with a reason code. Work found without a live
wake is reported as a telemetry event `connector.trigger.<outcome>`.

**Catch-up.** On every (re)connect and every five minutes the ring pulls, on
its own thread: the work it still holds for later; `GET /api/notifications/actions`
for its Verify and Stuck items; the Tasks waiting for it
(`GET /api/tasks?status=todo&unassigned=true`, armed and assigned to its
service: the list has no assignee-service filter, so the ring filters the rows.
The list is newest first and a pass reads at most three pages of 100: the next
pass goes on where the last one stopped and, after the last page, starts again
at the top, so a waiting Task behind any number of newer rows is reached within
a bounded number of passes; the place in the list is kept in memory, so a
restart begins a new sweep at the top);
and `GET /api/events` from its saved cursor for `task.ready` events. Each
candidate is re-read before anything is decided. The cursor only moves forward.
Work refused for a passing reason (`AT_CAPACITY`, `USAGE_HOLD`, a mint waiting
for approval) is retried there.

**First start, and pacing.** A connector with no saved cursor starts at the
feed's head: it never replays the board's history (the head is measured with
about 2 x log2(head) one-row reads of `GET /api/events`, before the socket
opens), and work that was already waiting is found by the two reads above.
One pass queues at most 50 candidates; the rest wait for the next pass, and the
feed cursor stops at the first event not yet taken. Every board call the ring
makes under the connector's token passes one rate gate, 60 a minute with a
burst of 20, a fifth of the board's per-address limit (300 a minute), which the
person's own interactive connections from the same machine share. A wake is
always decided before pulled work.

**A run.** For `implement` (a Task assigned to this connector, armed and
ready), and for `verify` when this connector is the Task's service Verifier:

1. the harness binary passes publisher trust (as for the collector), and for
   Codex the build must document `--ignore-user-config`;
2. a task-bounded Agent is minted under the connector's Warrant
   (`POST /api/delegation/agent-mints`): role `implementer` with the working
   scopes plus `telemetry:write`, or role `verifier`; never more than the
   connector holds, never `root` or an `:admin` scope, and a pack holding any
   scope the run did not ask for is revoked unused (`AGENT_MINT_REFUSED`). The
   implement mint names no Warrant: the board picks the one that contains the
   Task (the live suite drives that exact body). Without a Warrant an
   implementer mint becomes a pending Approval and the person is told once; the
   approved mint is collected on a later pass. A verifier is minted under a
   Warrant only (`NO_WARRANT` otherwise);
3. for `implement`, the Agent claims the Task (an empty claim body). This is
   the path the board admits: proven on a disposable board by
   `backend/src/__tests__/connectorRunClaimLive.test.ts`, which also shows that
   the alternative (the connector claims, the Agent works) cannot hand the Task
   back, because only the claimant saves the Task Report and finishes;
4. the harness starts in the working folder with a configuration that holds
   ONLY the run's proxy: Claude Code with `-p --output-format stream-json
   --verbose --strict-mcp-config --mcp-config <run folder>\mcp.json`, Codex with
   `exec --json --ignore-user-config -c mcp_servers.relayhall={...}`. Both were
   checked against the real CLIs with a stand-in provider: without
   `--strict-mcp-config` (Claude Code) or `--ignore-user-config` (Codex) the
   user's own MCP entries start as well; with them only the run's entry does.
   For Codex that covers a project's own `.codex/config.toml` in the working
   folder as well (codex-cli 0.164.0, the folder trusted: loaded without the
   flag, not with it; `cli/test_connector_ring.py` runs that check against a
   real binary named by `RH_TEST_CODEX_BINARY`). A `-c mcp_servers...` override
   alone is merged into the user's configuration, so it is not isolation; a
   fresh `CODEX_HOME` would isolate but carries no sign-in;
5. the Agent's credential is in the run folder (`%TEMP%\rh-run-*`), encrypted
   with DPAPI for this user and bound to the run; the run's proxy
   (`relayhall connector mcp --run <folder>`) reads it there. It is never on a
   command line, in an environment, in a log or a Report. The harness's
   environment drops anything shaped like a credential;
6. the run is supervised: a hard deadline, the whole process tree ended on
   every exit path, the outcome named (`RUN_EXIT_NONZERO`, `RUN_TIMEOUT`,
   `RUN_START_FAILED`, `RUN_OUTPUT_LIMIT`, `RUN_BINARY_CHANGED`,
   `RUN_REPORT_FAILED`, or none);
7. the MCP servers the run actually started are read back from the harness
   itself: Claude Code's stream names them in its `system`/`init` event (every
   one counts); Codex's JSON events do not, so a Codex run gets
   `RUST_LOG=off,codex_otel.log_only=info` and the ring reads the
   `codex.conversation_starts ... mcp_servers="..."` line Codex writes to
   stderr at each session start (nothing else on stderr is read or kept). Any
   server other than the run's own entry makes the outcome `RUN_UNISOLATED`; no
   record at all makes it `RUN_MCP_UNVERIFIED` (a run that also failed keeps
   its failure's code, such as `RUN_EXIT_NONZERO` or `RUN_TIMEOUT`). The
   person is told on either verdict (a notification naming the outcome, or the
   verdict when a failure's code won; the run's Report or note says it too), and
   on either verdict the run's output is not passed on as evidence, whatever the
   outcome code: it may hold what another server returned;
8. the run's summary (outcome, exit code, the MCP servers the harness reported,
   the bounded last output with credentials redacted, unless withheld above)
   goes to the Task under the Agent: a Report while the Task is still in
   progress, a stream note once it was handed back. Then the Agent is revoked
   and the run folder removed, whatever failed while reporting (the outcome is
   still sent, named). A revocation that fails is retried every pass; a run
   the daemon did not see end (a crash) is cleaned up the same way at the next
   start.

**Never.** It never runs under the connector's own token, never verifies a Task
its own service, itself or an Agent it minted implemented
(`OWN_SUBTREE_IMPLEMENTED`; unknown counts as own: `OWN_SERVICE_UNKNOWN`),
never starts a run for `stuck`, and never acts on text in the Task.

**Notifications.** A Windows toast (it stays in the Windows Action Center) with
the Task's short id, the wake kind, a reason code where there is one, and the
board link; never the Task's title or other text. One per item occurrence. The
item itself is listed in the board's Action Center.

**Not in this release.** The loopback OTLP relay for run telemetry, macOS and
Linux, and a board-reported usage hold (only the local `hold` exists).
Same-user custody is not a boundary against a hostile run that deliberately
reads this user's keystore (design gap 7).

## Editing a connection with multiple credentials

In **My connections**, open **Setup** or **Advanced** and choose the credential
by its label, transport, state and ID. **Edit permissions** from Setup opens the
Advanced editor for that exact credential. Check the displayed ID and scopes
before saving: an API credential and an MCP credential on the same connection
can have different permissions. Widening asks for step-up on the chosen ID.
Changing the choice discards unsaved edits; the choice is held while a save or
step-up is in progress. If the chosen credential disappears on refresh, choose
another explicitly. The selector shows identifiers, never credential secrets.

## Secure configuration

The guidance shown beside the prompt says the same thing on every surface:

- register the MCP server as `relayhall` with the block for your client;
- keep the credential in the client's secret store or the `RELAYHALL_TOKEN`
  environment variable, never in a prompt, a Skill, a Report or a repository
  (Claude Code reads `${RELAYHALL_TOKEN}` inside `.mcp.json` headers, so the
  literal value need not sit in that file);
- paste the bootstrap prompt into a fresh session;
- optionally record a local pointer with the installer below.

## The registry Skill

The reviewed source of the Skill the prompt names is
[skills/relayhall-connector-bootstrap/SKILL.md](../skills/relayhall-connector-bootstrap/SKILL.md).
It tells a session to measure identity, transport, scopes, expiry and object
permissions through the real tools; to classify every capability as listed,
granted, configured or tested; to load role guidance only when it needs it;
and to finish with a readiness matrix of real ids and remaining gaps. It never
arms or claims existing work.

The registry has no seed files: a Skill enters it through the ordinary
[Skill lifecycle](skills.md), and publication is a human administrator act
that the Version's author cannot perform. Updating the published Skill from
this source is therefore an operator step:

```bash
relayhall skill update relayhall-connector-bootstrap \
  --skill-md-file skills/relayhall-connector-bootstrap/SKILL.md   # next draft Version
relayhall skill versions relayhall-connector-bootstrap            # note the new number
relayhall skill submit-review relayhall-connector-bootstrap <version> --note "ready"
relayhall skill publish relayhall-connector-bootstrap <version> --note "approved"   # skills:admin
```

On a board that has no such Skill yet, start with
`relayhall skill create --name relayhall-connector-bootstrap --category workflow --skill-md-file skills/relayhall-connector-bootstrap/SKILL.md`.
`--skill-md-file` sends the file's exact bytes, so the digest the registry
records is the SHA-256 of that file (`sha256sum` reproduces it). The Connectors
that should follow the prompt need read access to the Skill: a grant, or the
separate global-audience action after publication.

## The local connection skill

A harness that keeps local skills can hold a short pointer to its connection.
From a RelayHall checkout:

```bash
relayhall connection-skill install --harness claude-code
relayhall connection-skill install --harness codex
relayhall connection-skill install --harness antigravity
```

| Harness | File written |
| --- | --- |
| Claude Code | `$CLAUDE_CONFIG_DIR/skills/relayhall-connection/SKILL.md`, else `~/.claude/skills/relayhall-connection/SKILL.md` |
| Codex | `$CODEX_HOME/skills/relayhall-connection/SKILL.md`, else `~/.codex/skills/relayhall-connection/SKILL.md` |
| Antigravity | `~/.gemini/antigravity/skills/relayhall-connection/SKILL.md`, Antigravity's global skills folder (not `~/.gemini/skills`, which is Gemini CLI's) |

`relayhall connector install` writes the same pointer for these three
harnesses, naming the connector's custody as where the credential is kept.

The file holds only the MCP server alias and origin, the registry Skill's id,
version and SHA-256 digest, refresh and discovery steps, and where the
credential is kept. It never holds the credential: a credential-shaped value
in any option, or the credential the CLI itself is using, is refused before
anything is written.

- **Idempotent.** A second run with the same inputs compares bytes and writes
  nothing. A newer published Version is a change, and is recorded.
- **Preserving.** Only the text between the `relayhall-connection:begin` and
  `relayhall-connection:end` markers is replaced. Anything written around it,
  and every other skill, stays as it was. Damaged markers are refused.
- **Honest about support.** Any other `--harness` value prints manual
  instructions, writes nothing and exits with status 3.

The registry identity comes from `GET /skills` with the CLI's own credential
(`skills:read`). `--skill-id`, `--skill-version` and `--skill-sha256` together
supply it without a lookup. Other options: `--alias` (default `relayhall`),
`--origin` (default: the CLI's API URL followed by `/mcp`), `--credential-ref`
(default: the `RELAYHALL_TOKEN` environment variable) and `--dry-run`.

| Exit status | Meaning |
| --- | --- |
| 0 | written, already current, or dry run |
| 1 | refused; nothing was written |
| 3 | unsupported harness; manual instructions printed, nothing written |

To remove the pointer, delete the `relayhall-connection` directory; nothing
else was created.

## What onboarding does not do

The prompt and the Skill measure and report. They do not configure telemetry
reporters, notification delivery or knowledge sources, and they do not run a
lifecycle fixture on their own authority: those need their own adapters and an
explicit grant, and a missing surface is reported as unavailable. Accepting
the whole flow from fresh Claude Code and Codex profiles is a separate,
independent check.
