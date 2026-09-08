# ACP Integration Design — ClawBoard

> **Status: HISTORICAL — design history, not living documentation.**
> The ACP spawn/steer runtime described below was removed in RH-P1.2 (see
> [removed-spawn-runtime.md](removed-spawn-runtime.md)). The board no longer
> spawns, steers, or aborts agent sessions; it only compiles Briefs
> (`POST /tasks/:id/brief`, renamed from the `/prompt` spelling this document
> was written against) for an external orchestrator to execute.
> Endpoints, services, env vars, and compose files named in this document may
> no longer exist. Retained for the record of why the integration was shaped
> the way it was.

**Status:** Implemented 2026-03-05; runtime removed in RH-P1.2 (2026-07)
**Author:** Phase 1 (auto-generated from task spec), updated during wiring
**Date:** 2026-03-04 (original), 2026-03-05 (wiring + testing)

---

## Overview

Integrate OpenClaw ACP (Agent Control Protocol) with ClawBoard task orchestration.
Combine ClawBoard's structured task management (subtasks, dependencies, review gates, project context)
with ACP's interactive agent control (steer, cancel, real-time output, thread-bound sessions).

**Goal:** Spawn task agents you can interact with mid-flight.

---

## Architecture

### Standard Flow (cron-based, fire-and-forget)
```
CLI spawn --run
  → POST /tasks/:id/spawn-agent
    → gatewayConnector.sendGatewayRequest('cron.add', {
        deleteAfterRun: true,
        ...
      })
      → cron session key: cron:<uuid>
        → agent runs, posts back result
```

### Interactive Flow (persistent session, steerable)
```
CLI spawn --run --interactive
  → POST /tasks/:id/spawn-agent  { interactive: true }
    → gatewayConnector.spawnInteractiveSession({...})
      → cron.add with deleteAfterRun: false
        → cron session key: cron:<uuid> (stored as acp_session_key)
          → agent runs, can be steered via chat.send
          → Discord thread created in #general
          → Live output streamed to dashboard + thread
```

> **Implementation Note (2026-03-05):** The gateway does not expose a `sessions.spawn`
> RPC method. Interactive sessions use `cron.add` with `deleteAfterRun: false` instead,
> creating persistent cron sessions that support steering via `chat.send` and cancellation
> via `chat.abort`. Session keys follow the `cron:<uuid>` pattern for both modes.
> No `acp.defaultAgent` or `acp.allowedAgents` config is required.

---

## Data Model Changes

### New field: `acp_session_key` on tasks table

```sql
-- Migration 031_acp_session_key.sql
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS acp_session_key VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_tasks_acp_session_key ON tasks(acp_session_key)
  WHERE acp_session_key IS NOT NULL;
```

### New field: `discord_thread_id` on tasks table

```sql
-- Migration 032_discord_thread_id.sql
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS discord_thread_id VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_tasks_discord_thread_id ON tasks(discord_thread_id)
  WHERE discord_thread_id IS NOT NULL;
```

### Updated `executionMode` values
- `'main'` — runs in main session
- `'subagent'` — cron-based isolated agent (deleteAfterRun=true)
- `'interactive'` — persistent cron session (deleteAfterRun=false, steerable)

---

## API Endpoints

### Modified: POST /tasks/:id/spawn-agent
**New request body field:** `interactive: boolean`

When `interactive: true`:
1. Calls `gatewayConnector.spawnInteractiveSession()` (cron.add with deleteAfterRun=false)
2. Registers session key with GatewayConnector's task session tracking
3. Stores session key as `acp_session_key` on the task
4. Sets `executionMode: 'interactive'`
5. Triggers `discordThreadService.createThreadForTask()` asynchronously
6. Returns `{ acpSessionKey, interactive: true, discordThreadId }` in response

### POST /tasks/:id/steer
Send a steering message to a linked interactive session.

```
Body: { message: string }
Response: { success: boolean, sent: boolean }
```

Uses `gatewayConnector.steerSession()` → gateway RPC `chat.send` with `idempotencyKey`.

### POST /tasks/:id/cancel
Kill the linked interactive session.

```
Body: (empty)
Response: { success: boolean, killed: boolean }
```

Uses `gatewayConnector.abortSession()` → gateway RPC `chat.abort`.

### GET /tasks/:id/session-status
Return session state from the gateway's queue snapshot.

```
Response: { success: boolean, sessionKey: string, state: string, interactive: boolean }
```

---

## CLI Commands

### spawn command
```bash
clawboard spawn <id> --run --interactive    # spawn interactive session
clawboard spawn <id> --run --interactive -i # short flag
clawboard spawn <id> --run                  # standard cron spawn (default)
```

### Steering and lifecycle
```bash
clawboard steer <id> '<message>'           # steer running session
clawboard cancel <id>                      # kill session
clawboard session-status <id>              # show session state
```

---

## Service Wiring (server.ts)

All services are initialized at startup in `backend/src/server.ts`:

```typescript
// Imports
import { subAgentTaskUpdater } from './services/SubAgentTaskUpdater';
import { discordThreadService } from './services/DiscordThreadService';
import { GatewayConnector } from './services/GatewayConnector';

// Wiring (before routes)
const gatewayConnector = new GatewayConnector(wsService);
setTasksGatewayConnector(gatewayConnector);
subAgentTaskUpdater.setGatewayConnector(gatewayConnector);
discordThreadService.setGatewayConnector(gatewayConnector);  // Auto-subscribes to agent:stream

// Startup
subAgentTaskUpdater.start();
gatewayConnector.start();
```

**Note:** DiscordThreadService doesn't need an explicit `start()` call — it auto-subscribes
to `agent:stream` events when `setGatewayConnector()` is called.

---

## WebSocket Event Flow

```
Gateway WS → GatewayConnector.handleEvent()
  ├── Emits 'agent:stream' EventEmitter event
  │     └── DiscordThreadService handles → batches text → posts to Discord thread
  └── Broadcasts 'session:output' via wsService (if isTaskSession)
        └── Frontend LiveSessionPanel subscribes via useWebSocket
```

The `isTaskSession()` check ensures only registered task sessions trigger dashboard
broadcasts. Sessions are registered via `registerTaskSession()` immediately after spawning.

---

## Discord Thread Integration (Phase 3)

### DiscordThreadService

- **Channel:** `DISCORD_TASK_THREAD_CHANNEL_ID` env var (e.g. `#general` channel id)
- **Must be a standard text channel** (type 0) — announcements/forum channels don't support thread-create
- **Authorized steer users:** `DISCORD_ALLOWED_STEER_USERS` env var (comma-separated user ids)

### Thread Lifecycle
1. **Created** when interactive task is spawned → `thread-create` in target channel
2. **Streaming** — agent output batched (7s window) and posted to thread
3. **Polling** — thread replies from authorized users forwarded as steer commands (15s interval)
4. **Archived** on task completion

### Gateway Response Parsing

The gateway's `/tools/invoke` endpoint wraps results in an AI content-array envelope:
```json
{
  "ok": true,
  "result": {
    "content": [{ "type": "text", "text": "{\"ok\": true, \"thread\": {\"id\": \"...\"}}" }]
  }
}
```

`invokeMessageTool()` in DiscordThreadService unwraps this envelope and parses the inner
JSON string before returning to callers. Thread ID is extracted from `result.thread.id`.

---

## SubAgentTaskUpdater Changes

The updater handles both session types with different completion semantics:

1. **Standard sessions** (`executionMode='subagent'`): Auto-complete when session disappears from gateway
2. **Interactive sessions** (`executionMode='interactive'`):
   - Don't auto-complete on idle — sessions are meant to stay alive for steering
   - Only mark complete when session is no longer in gateway queue AND minimum run time exceeded
   - Timeout to 'stuck' only after extended silence (ERROR_THRESHOLD)

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_TASK_THREAD_CHANNEL_ID` | `<channel-id>` | Discord channel for task threads |
| `DISCORD_ALLOWED_STEER_USERS` | `<user-id>` | User IDs that can steer via thread |
| `SPAWN_AGENT_ANNOUNCE_TO` | `user:<user-id>` | Where to announce agent spawns |
| `SPAWN_AGENT_ANNOUNCE_CHANNEL` | `discord` | Channel for spawn announcements |

Set in `docker-compose.prod.yml` and `docker-compose.dev.yml`.

---

## Troubleshooting

### Discord thread creation fails with 500

**Symptom:** `tools/invoke thread-create failed: 500`

**Common causes:**
1. **Wrong channel type** — Target channel must be type 0 (text), not type 5 (announcements) or type 15 (forum). Use `#general` or create a dedicated text channel.
2. **Bot permissions** — Bot needs `CREATE_PUBLIC_THREADS` permission in the target channel.
3. **Channel doesn't exist** — Verify `DISCORD_TASK_THREAD_CHANNEL_ID` is correct.

### Steer command fails with "idempotencyKey required"

**Fixed in wiring (2026-03-05).** `GatewayConnector.steerSession()` now generates a unique
`idempotencyKey` for each `chat.send` request.

### Thread ID not extracted from response

**Fixed in wiring (2026-03-05).** The gateway wraps tool results in a content-array envelope.
`invokeMessageTool()` now unwraps `result.content[0].text` and parses the inner JSON.
Thread ID is extracted from `result.thread.id`.

### Dev backend GatewayConnector ECONNREFUSED

**Symptom:** `GatewayConnector: WebSocket error: connect ECONNREFUSED 172.17.0.1:18789`

**Cause:** The dev backend container resolves `host.docker.internal` to the Docker bridge IP,
but the OpenClaw gateway listens on loopback only (127.0.0.1:18789). The iptables DNAT rule
only bridges the prod Docker network.

**Workaround:** Test interactive features against the prod backend (port 3001) which connects
to `ws://<gateway-host>:18789` directly.

### Session key format

Both standard and interactive sessions use `cron:<uuid>` keys. The `acp_session_key` field
on the task distinguishes interactive sessions. There is no separate ACP session key format.

### Sessions don't appear in sessions.list

Cron sessions (`cron:*`) don't appear in `sessions.list`. GatewayConnector creates synthetic
entries via `registerTaskSession()` so they appear in the dashboard sidebar immediately.

---

## Files Changed During Wiring (2026-03-05)

| File | Change |
|------|--------|
| `backend/src/services/DiscordThreadService.ts` | Fixed `invokeMessageTool()` to unwrap gateway content-array envelope; added `result.thread.id` extraction; changed default channel to #general |
| `backend/src/services/GatewayConnector.ts` | Added `idempotencyKey` to `steerSession()` `chat.send` call |
| `docker-compose.prod.yml` | Added `DISCORD_TASK_THREAD_CHANNEL_ID` and `DISCORD_ALLOWED_STEER_USERS` env vars |
| `docker-compose.dev.yml` | Added `DISCORD_TASK_THREAD_CHANNEL_ID` and `DISCORD_ALLOWED_STEER_USERS` env vars |

### Migrations Run

- `031_acp_session_key.sql` — Run on dev (port 5435) and prod (port 5433) databases
- `032_discord_thread_id.sql` — Run on dev (port 5435) and prod (port 5433) databases

---

## Future Work

- **True ACP integration:** When the gateway adds `sessions.spawn` RPC, switch from `cron.add`
  to `sessions.spawn` with `runtime: 'acp'`. This would provide native thread-bound sessions,
  proper ACP session keys, and require `acp.defaultAgent` config.
- **Dedicated task channel:** Create a private `#task-threads` channel instead of using `#general`.
- **Frontend steer UI:** The LiveSessionPanel already has a steer input field; needs testing
  with a running interactive session.
- **Completion detection:** Improve SubAgentTaskUpdater to detect cron session completion
  more reliably (currently relies on session disappearing from gateway queue).
