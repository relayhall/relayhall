# Design history: the removed spawn/execution runtime (P1.2 wave 2)

Strategy §2.8 ratified that **the product never executes agents** — agents pull
work from RelayHall; RelayHall never launches, binds to, steers, or kills an
agent process. This wave removed the execution runtime the ClawBoard core
carried. This page records what existed, so the design knowledge is not lost
with the code (per §2.8: machinery "recorded as design history").

## Removed modules (backend/src/services)

- **HermesRuntime.ts** — launched local CLI-harness worker turns as detached
  child processes (`launchHermesTurn`), resolved provisional launches to real
  session rows by source-tag/time-window/log scan, polled a harness-owned
  SQLite state DB for per-session runtime state, and signalled PIDs
  (`killProcess`). Also owned the respawn gate (`shouldBlockHermesRespawn`)
  and the launch marker (`markAgentLaunched`/`didAgentLaunch`) that decided
  whether a failed spawn's freshly minted credential was safe to revoke.
- **TaskExecutors.ts** — the harness-neutral executor boundary
  (`spawn/steer/cancel/getSessionStatus`) with two implementations: gateway
  cron-job execution (one-shot and persistent interactive sessions) and local
  process execution. Enforced session↔harness ownership before any signal.
- **GatewayConnector.ts (execution methods only)** — `spawnInteractiveSession`
  (cron.add + immediate force-run), `steerSession` (chat.send injection) and
  `abortSession` (chat.abort). The connector itself survives as a passive
  observer: streaming live-state for the dashboard, plus config RPC.
- **TaskSpawnGuard.ts** — per-task spawn serialization (promise-chained mutex)
  plus `classifyOpenClawRespawnState`, the conservative respawn classifier.
- **SubAgentTaskUpdater.ts** — the watcher that bound provisional spawns to
  real sessions, auto-completed/stuck tasks from session terminal states,
  stamped persona ids at bind time, and revoked a task's spawn credentials at
  completion.
- **TaskRuntimeAdapterService.ts** — normalized live runtime evidence
  (process aliveness, message/tool counts, staleness windows) across both
  harnesses for respawn/steer decisions.
- **HermesCanonicalAdapter.ts** — canonical-event ingestion from the CLI
  harness's live state DB (its credential-redaction helper was kept and moved
  to the surviving transcript adapter).
- **SteeringAttachmentService.ts** — materialized user attachments into agent
  workspaces for steer turns.
- **controlService.ts** (+ `routes/control.ts`) — the dashboard kill switch
  (removed in the P1.2 review pass completing this cut). Read the gateway
  session registry, then opened a one-shot gateway WebSocket and sent
  `chat.abort` to stop the main session, a named sub-agent, or everything at
  once. §2.8 applies squarely: session-kill via gateway `chat.abort` is
  execution-side signalling — the product signalling a runtime it does not
  own. The Phase-3 shepherd meltdown-recovery operation is the designed
  successor for "stop everything now".
- **AttachmentCollector.ts / AttachmentWriter.ts** — collected project context
  files for agent spawns and materialised attachment bytes into agent
  workspaces. Spawn-support left fully orphaned by the wave-2 cut (zero
  importers); removed in the same review pass.
- **Discord steer allow-list plumbing** — `allowedSteerUserIds` threading
  through the transport config and `DiscordThreadService`. The steer surface
  it authorized was removed in wave 2; the dangling allowlist (and its env
  parsing, below) went in the review pass.

## Removed routes

- `POST /tasks/:id/spawn`, `POST /tasks/:id/spawn-agent` — prompt compile +
  launch + task mutation to in-progress with an `activeAgent` binding.
- `POST /tasks/:id/steer`, `POST /tasks/:id/cancel` — turn injection into and
  signalling of the bound runtime.
- `POST /sessions/:key/steer`, `GET /sessions/attachment-limits`.
- `POST /gateway/session/:id/abort`.
- `GET /tasks/:id/session-status` was retained but now serves only the
  canonical task-attempt evidence contract (pull-side DB reads) — no live
  runtime inspection.
- `POST /tasks/:id/spawn-prompt` was renamed to `POST /tasks/:id/prompt`
  (generation without execution — the §2.3 compile seed) with the old path
  kept as a deprecation alias. *(Superseded: the alias went in RH-P3.C5, and
  RH-P3.C4 renamed the route itself to `POST /tasks/:id/brief`. Neither older
  spelling resolves today.)*
- `POST /control/stop-main`, `POST /control/stop-agent/:key`,
  `POST /control/stop-all`, `GET /control/agents` — the kill-switch routes
  (with their admin scope rule and the frontend Ctrl+Shift+X / Escape
  handlers that invoked them).

## Removed flags / env configuration

- `CLAWBOARD_SPAWN_CREDENTIALS` (feature flag: per-spawn credential minting).
- `SPAWN_AGENT_ANNOUNCE_TO`, `SPAWN_AGENT_ANNOUNCE_CHANNEL` (spawn delivery).
- `CLAWBOARD_DISCORD_ALLOWED_STEER_USERS` / `DISCORD_ALLOWED_STEER_USERS`
  (steer-authorization allowlist; thread-reply steering removed).
- CLI-harness runtime configuration consumed only by the launcher:
  `HERMES_RUN_LOG_DIR`, `HERMES_TASK_MAX_TURNS`.
  (**Correction, updated in P1.3:** the remaining harness-specific status and
  workspace path variables left with the observer stack. Reviewer evidence
  was removed entirely when review evidence became report-backed; core no
  longer resolves a workspace path.
- Per-spawn identity primitives in the credential service:
  `SPAWN_CREDENTIAL_SCOPES`, `SPAWN_CREDENTIAL_TTL_MS`, `principalForSpawn`,
  `revokeCredentialsForTask`.

## Anti-widening properties the spawn preconditions protected

The removed machinery was, in large part, a set of refusals, and those are the
part worth remembering. Spawning was serialized per task and re-read state
after each predecessor persisted, so two concurrent requests could not both
observe a pre-spawn snapshot and launch duplicate runtimes; an *unverifiable*
existing runtime (adapter degraded, state unknown) refused the respawn rather
than treating ignorance as permission. Only terminal runtime states permitted
a respawn. Steering and cancellation verified that the target session actually
belonged to the harness bound to the task before injecting or signalling
anything, and a cancellation that the runtime did not acknowledge never
cleared task ownership. Per-spawn credentials were scoped (deliberately
excluding the spawn scope itself, so a spawned agent's key could never start
further agents), expired, died with the work, and were revoked on launch
failure only when a launch marker proved the process never started — revoking
after a real start would strand a live agent. Spawn identity was
fail-open-to-legacy but never fail-blocking: identity substrate outages
degraded attribution, not execution safety. The pull model replaces the
launch/steer half of this outright; any future execution-adjacent surface
should be checked against this list before it ships.
