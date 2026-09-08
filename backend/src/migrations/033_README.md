# Migration 033 — Sessions Redesign

**Phase:** 1 of 2  
**File:** `033_sessions_redesign.sql`

## What changed

Dropped the old `sessions` + `session_messages` tables (and all related views/matviews), then created a new, lean `sessions` table that maps 1:1 to what OpenClaw actually stores.

### Tables / views dropped

| Object | Type | Why dropped |
|--------|------|-------------|
| `session_summary_stats` | MATERIALIZED VIEW | Depended on session_messages; no longer needed |
| `session_aggregate_stats` | VIEW | Simple stats now computed inline |
| `session_messages_row_count` | VIEW | Partition-readiness view for session_messages |
| `session_messages` | TABLE | Storing individual messages in Postgres was expensive and rarely used for read queries |
| `sessions` | TABLE | Replaced with new clean schema |

### New `sessions` table

| Column | Type | Source |
|--------|------|--------|
| `session_key` | VARCHAR PK | Key from `sessions.json` (e.g. `agent:main:main`) |
| `session_id` | UUID UNIQUE | `value.sessionId` from `sessions.json` → JSONL filename |
| `kind` | VARCHAR | Derived from `session_key` pattern (see rules below) |
| `channel` | VARCHAR | `value.origin.provider` from `sessions.json` |
| `label` | VARCHAR | `value.label`, or first JSONL gateway event, or first user message |
| `model` | VARCHAR | `value.model` from `sessions.json` or last `model_change` JSONL event |
| `status` | VARCHAR | `active`/`completed`/`unknown` |
| `spawn_info` | JSONB | `{ spawnedBy, spawnDepth, deliveryContext }` |
| `message_count` | INTEGER | Aggregated from JSONL |
| `tool_call_count` | INTEGER | Aggregated from JSONL |
| `input_tokens` | BIGINT | Sum of `usage.input` in JSONL |
| `output_tokens` | BIGINT | Sum of `usage.output` in JSONL |
| `thinking_tokens` | BIGINT | Sum of `usage.thinking` in JSONL |
| `cache_read_tokens` | BIGINT | Sum of `usage.cacheRead` in JSONL |
| `total_cost_usd` | NUMERIC(12,6) | Sum of `usage.cost.total` in JSONL |
| `started_at` | TIMESTAMPTZ | Timestamp of first JSONL entry |
| `ended_at` | TIMESTAMPTZ | Timestamp of last JSONL entry (null if active) |
| `last_activity_at` | TIMESTAMPTZ | Timestamp of most recent JSONL entry |
| `file_size` | BIGINT | JSONL file size in bytes at last ingest |
| `transcript_path` | VARCHAR | Absolute path to JSONL file |
| `created_at` | TIMESTAMPTZ | Row insert time |
| `updated_at` | TIMESTAMPTZ | Row last update time (auto-maintained by trigger) |

### Kind derivation rules (checked in order)

```
session_key contains ':heartbeat'     → heartbeat
session_key contains ':cron:'         → cron
session_key contains ':subagent:'     → subagent
session_key contains ':discord:'      → discord
session_key contains ':acp:'          → acp
session_key ends with ':main'         → main
anything else                         → unknown
```

### Status meanings

- `active` — session_key is currently present in `sessions.json`
- `completed` — session_key was removed from `sessions.json` (historical)
- `unknown` — ingested from JSONL only; no `sessions.json` record

### spawn_info JSONB shape

```json
{
  "spawnedBy": "agent:main:main",
  "spawnDepth": 1,
  "deliveryContext": {
    "channel": "discord",
    "to": "channel:222222222222222222",
    "accountId": "default"
  }
}
```

Parent lookup uses the `idx_sessions_spawned_by` index:
```sql
WHERE spawn_info->>'spawnedBy' = 'agent:main:main'
```

## What Phase 2 needs to build

Phase 2 (`Session` ingester service) needs to:

1. Read `sessions.json` on startup and on every file-change event
2. For each key/value in `sessions.json`:
   - Derive `kind` from the session_key pattern above
   - Set `status = 'active'`
   - Build `spawn_info` JSONB from `spawnedBy`, `spawnDepth`, `deliveryContext`
   - Parse the JSONL file to aggregate token counts, message_count, timestamps, file_size
3. UPSERT into `sessions` on conflict (session_key) — update all mutable fields
4. For JSONL files that have no matching `sessions.json` entry (historical):
   - Set `status = 'unknown'`
   - Derive session_key from JSONL `type=session` events or filename fallback
5. Mark sessions as `completed` when their key disappears from `sessions.json`

### API compatibility notes

The old `sessions` table had a UUID `id` PK. The `sessions.ts` route currently
queries `WHERE id = $1` for single-session lookup. In Phase 2, this must be
updated to use `session_key` as the lookup. The route parameter can accept either:
- the full `session_key` string
- the `session_id` UUID (for backwards compatibility with existing links)

The `backfill` and `retention` endpoints can be removed or repurposed once the
new ingester is live.
