# Design history: the removed board-side observation stack (P1.3)

Strategy §2.6.5/F11 ratified that **the board never observes — connectors
report**. This wave removed the observation machinery the ClawBoard core
carried: every path by which the board reached into a harness's local state
to find out what agents were doing. Session telemetry now enters only through
the reporter-ingest seam (`docs/seams.md` §5, `docs/observability.md`).

## Removed modules (backend)

- **GatewayConnector.ts** (864) — WebSocket client to the OpenClaw gateway
  (`CLAWDBOT_GATEWAY_WS_URL`, password from env or the harness config file):
  message-queue monitoring, `agent:stream` events, `session:ended` → DB
  completion, config RPC (`config.get`/`config.patch`), and the
  `/tools/invoke` HTTP bridge the Discord gateway transport used.
- **SessionIngester.ts** (1259) — `fs.watch` on `sessions.json` and the
  transcripts directory; lock files as liveness ground truth; upserted
  `sessions` rows; emitted the sessions WS live-state events.
- **TranscriptIngester.ts / BackfillService.ts / RetentionService.ts** —
  already disabled dead code (the `session_messages` pipeline).
- **CanonicalSessionRepository.ts / OpenClawCanonicalAdapter.ts /
  SessionMessageRepository.ts** — the canonical session identity/attempt
  pipeline. `OpenClawCanonicalAdapter` was the board-side *reference
  implementation* of the canonical ingest contract; the contract itself
  (`backend/src/types/CanonicalSession.ts`) is **kept** — Phase-3 reporters
  speak it from the other side. The adapter-health read survives as the
  re-homed `GET /sessions/pipeline-health` (`routes/reporterHealth.ts`).
- **modelStatus.ts (service) + routes/modelStatus.ts** — read harness
  config/sessions files and broadcast `model:status` over WS.
- **workMonitor.ts** (418) — polled transcripts and fuzzy-matched activity to
  tasks; auto-completed subtasks and auto-moved tasks to stuck from
  transcript scraping. Its companion **TaskAutoUpdater.ts** (the
  "current task" auto-detector) went with it; `GET /tasks/current` keeps its
  shape but reports no current task.
- **AuditService.ts** (527) — derived the audit/stats feeds by scanning JSONL
  transcripts in the transcripts dir. The Audit page is now an empty-state
  core surface until the Phase-2 board-action audit source is wired (§2.12).
- **AgentHistoryService.ts** + the legacy fs-based **TaskManager.ts**
  (`tasks.json` chokidar watcher, `ARCHIVE_DIR` file archives) — harness-local
  file readers behind task timelines/summaries. TaskTimelineService,
  ContextService, `/projects/:id/sessions`, `/dashboard/active`, autoArchive,
  taskAnalyzer, and ProjectStatsService are DB-sourced only now.

## Removed routes

- `routes/sessionsApi.ts` (list/stats/detail/transcript/messages + pg-archive
  overlays) — except `GET /sessions/pipeline-health`, re-homed.
- `routes/gateway.ts` (queue/history/media + long-dead `session_messages`
  query endpoints and 301 stubs).
- `routes/status.ts` (sessions.json + lock files + a python3 subprocess
  querying the Hermes `state.db`).
- `routes/models.ts` — trimmed to `GET /models/available` only; removed the
  Hermes probes (`hermes version` / `hermes status` execs), the OpenClaw
  config/auth-profile readers, `GET /models/status`,
  `POST /models/set-default`, `POST /models/switch`, and the
  transcript-reading session-tools endpoint.
- `routes/agents.ts`, `routes/rateLimits.ts`, `routes/memory.ts`
  (`/clawdbot/memory/*.md`, `HEARTBEAT.md`), `routes/workspace.ts` +
  `workspaceWatcher.ts`, `routes/audit.ts`.

## Removed frontend surfaces

The 2,300-line Sessions transcript viewer and Stats' scraped analytics left
in the preceding wave (empty-state rebuild). This wave removed their feeds'
remaining consumers: ModelStatusCard, MessageQueueCard, ModelStatusBadge +
ModelSwitchContext, HeartbeatWidget + heartbeatParser, WorkspaceFiles,
AgentDetailCard, useRealtimeStatus, FileViewerContext (the workspace file
viewer), and the Sidebar's usage-limit bars / harness runtime cards / live
agent list. The StatusOrb stays (push-based bot-status is F11-compatible);
its live divide/merge feed returns with reporter presence frames (Phase 4).

## Removed env/compose surface

Observation mounts (`/clawdbot/sessions`, `/clawdbot-home`, `/workspace`,
`/clawdbot/media`) and their env family (`CLAWDBOT_SESSIONS_PATH`,
`CLAWDBOT_TRANSCRIPTS_DIR`, `CLAWDBOT_CONFIG_PATH`, `CLAWDBOT_MODELS_PATH`,
`AUTH_PROFILES_PATH`, `CLAWDBOT_GATEWAY_WS_URL`/`OPENCLAW_GATEWAY_URL`,
`WORKSPACE_PATH`, `OPENCLAW_DIR`, `OPENCLAW_WORKSPACE`) left compose and
`.env.example`. The Hermes probe vars are gone with the probes (see the
correction note in `removed-spawn-runtime.md`). Config schema dropped
`paths.openclawDir`, `paths.sessionsDir`, `services.openclawGatewayWs`,
`services.openclawApiUrl`, and the dead `sessions` retention block.
`CLAWBOARD_DISCORD_FALLBACK_TRANSPORT` went with the gateway Discord
transport. Estate-coded scripts (`hermes_operational_status.py`,
`hermes_status_avatar.py`, `update_usage_stats.py`, `run-backfill.sh`,
`test-model-switch.sh`) and their root python tests rode along.

## What deliberately stays

- `types/CanonicalSession.ts` — the reporter-ingest contract.
- `GET /sessions/pipeline-health` — the reporter-ingest health seed (A18).
- `/bot-status` + `/nim-status` — push-based self-reported status (A11).
- `GET /models/available` — interim read-only catalog (A10, seams §4).
- `GET /tasks/:id/session-status` + CanonicalRuntimeSignalService — pull-side
  DB evidence contract; the natural landing zone for Phase-3 ingest.
- The `sessions` + canonical DB tables — dormant, kept for reporter ingest
  (schema disposition A13: fresh-target-schema cut happens in RH-P2).

## Anti-widening notes

The observer stack was the last place where board behavior depended on files
an agent runtime owns. Anything execution- or observation-adjacent proposed
in the future should be checked against F11's rule first: if the board has
to reach into a runtime's filesystem, socket, or config to make a feature
work, the feature belongs in a reporter/outpost plugin, not in core.
