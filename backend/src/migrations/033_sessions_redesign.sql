-- =============================================================================
-- Migration 033: Sessions table redesign (Phase 1)
-- =============================================================================
--
-- WHAT THIS DOES
-- --------------
-- Drops the old sessions + session_messages tables and all dependent
-- views / materialized views, then creates a new, clean sessions table
-- that maps 1:1 to what OpenClaw actually stores in sessions.json and
-- the JSONL transcript files.
--
-- WHY
-- ---
-- The old schema had two problems:
--   1. sessions used a synthetic UUID `id` as the PK instead of the natural
--      `session_key` that OpenClaw uses everywhere.
--   2. session_messages stored individual messages in Postgres when we only
--      ever need aggregate stats for the list view; full transcript detail is
--      read directly from the JSONL file on-demand.
--
-- =============================================================================
-- DESIGN DECISIONS (read before modifying this schema)
-- =============================================================================
--
-- 1. session_key is PRIMARY KEY
--    The session_key (e.g. 'agent:main:main', 'agent:main:cron:<uuid>') is the
--    stable, human-readable identifier that OpenClaw uses as the key in
--    sessions.json and throughout its internals. It is unique and never changes
--    for the lifetime of a session thread. Making it the PK avoids the need for
--    a surrogate UUID and makes joins / lookups natural.
--
-- 2. session_id UUID UNIQUE (not the PK)
--    sessions.json value.sessionId is the UUID that maps to the JSONL filename
--    on disk (e.g. /sessions/<uuid>.jsonl). It is stored separately so we can
--    quickly locate the transcript file without any string manipulation.
--    It has a UNIQUE constraint because each JSONL file belongs to exactly one
--    session thread.
--
-- 3. kind is derived from session_key pattern — never guessed from content
--    Derivation rules (checked in order):
--      ':heartbeat'          → heartbeat
--      ':cron:'              → cron
--      ':subagent:'          → subagent
--      ':discord:'           → discord
--      ':acp:'               → acp
--      ends with ':main'     → main
--      anything else         → unknown
--    This is deterministic and stable; it does not depend on what the session
--    happened to talk about.
--
-- 4. channel comes from sessions.json value.origin.provider
--    Examples: 'discord', 'telegram', 'heartbeat', 'cron'.
--    It describes the messaging surface, not the session type.
--
-- 5. status: active / completed / unknown
--    'active'    — session_key still present in sessions.json (live thread)
--    'completed' — key was removed from sessions.json (historical)
--    'unknown'   — ingested from JSONL only, no sessions.json record
--
-- 6. spawn_info JSONB consolidates parent relationship + delivery context
--    Replaces old parent_session_id FK + scattered metadata JSONB.
--    Shape: { spawnedBy: "agent:main:main", spawnDepth: 1,
--             deliveryContext: { channel: "discord", to: "...", accountId: "..." } }
--    Using JSONB here avoids a FK that requires sessions to exist before
--    sub-agents are inserted, and matches the data model in sessions.json.
--
-- 7. No session_messages table
--    Individual messages are read directly from JSONL when detail is needed.
--    The aggregate columns (message_count, tool_call_count, *_tokens, cost)
--    are sufficient for list views and dashboard stats.
--    Storing individual messages was expensive to maintain and rarely queried.
--
-- 8. Dropped old columns and their reasons:
--    - id (UUID surrogate PK)   → session_key is the PK now
--    - parent_session_id FK     → moved into spawn_info.spawnedBy (session_key)
--    - task_id FK               → removed; sessions aren't always tied to tasks
--                                 and the association was unreliable
--    - backfilled, backfilled_at           → no session_messages to backfill
--    - messages_purged, messages_purged_at → no session_messages to purge
--    - retention_summary                   → no session_messages retention policy
--    - metadata JSONB (catch-all)          → replaced by typed spawn_info JSONB
--
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Step 1: Drop views / materialized views that depend on old tables
-- ---------------------------------------------------------------------------

-- Materialized view (must be dropped before session_messages / sessions)
DROP MATERIALIZED VIEW IF EXISTS session_summary_stats CASCADE;

-- Regular views
DROP VIEW IF EXISTS session_aggregate_stats CASCADE;
DROP VIEW IF EXISTS session_messages_row_count CASCADE;

-- ---------------------------------------------------------------------------
-- Step 2: Drop old tables
--   session_messages first (FK → sessions.id), then sessions
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS session_messages CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;

-- ---------------------------------------------------------------------------
-- Step 3: Create new sessions table
-- ---------------------------------------------------------------------------

CREATE TABLE sessions (
    -- ── Primary identity ──────────────────────────────────────────────────
    -- Natural key: the stable string OpenClaw uses as the lookup key.
    -- Examples:
    --   'agent:main:main'
    --   'agent:main:heartbeat'
    --   'agent:main:cron:3a419d09-48eb-4621-b7c9-a5b1ab78446f'
    --   'agent:main:subagent:26ff5830-b41e-4b73-8cae-9c2136869216'
    --   'agent:main:discord:channel:222222222222222222'
    session_key         VARCHAR(500) PRIMARY KEY,

    -- UUID from sessions.json value.sessionId — used to locate the JSONL file
    -- on disk as /sessions/<session_id>.jsonl.
    -- NOT unique: cron jobs have both cron:JOB_ID and cron:JOB_ID:run:RUN_ID
    -- entries that share the same session_id (same transcript file).
    session_id          UUID NOT NULL,

    -- ── Classification ────────────────────────────────────────────────────
    -- Derived from session_key pattern (see comment §3 above).
    -- 'main'      — the primary interactive session (agent:main:main)
    -- 'heartbeat' — periodic heartbeat poll session
    -- 'cron'      — scheduled cron job session
    -- 'subagent'  — spawned sub-agent session
    -- 'discord'   — per-channel Discord session
    -- 'acp'       — ACP harness session (Claude Code / Codex)
    -- 'unknown'   — unrecognised pattern
    kind                VARCHAR(50) NOT NULL DEFAULT 'unknown'
                            CHECK (kind IN ('main', 'heartbeat', 'cron', 'subagent',
                                            'discord', 'acp', 'unknown')),

    -- Messaging surface (from sessions.json origin.provider).
    -- Examples: 'discord', 'telegram', 'heartbeat', 'cron', null for sub-agents.
    channel             VARCHAR(100),

    -- ── Display ───────────────────────────────────────────────────────────
    -- Human-readable label, sourced (in priority order) from:
    --   1. sessions.json value.label
    --   2. First 'gateway' type event in the JSONL (label field)
    --   3. First meaningful user message text (truncated to 255 chars)
    --   4. NULL if none of the above are available
    label               VARCHAR(500),

    -- The AI model used for most messages in this session.
    -- Sourced from sessions.json value.model or the last model_change JSONL event.
    model               VARCHAR(200),

    -- ── Status ────────────────────────────────────────────────────────────
    -- 'active'    — session_key currently present in sessions.json
    -- 'completed' — session_key was removed from sessions.json (archival)
    -- 'unknown'   — ingested from JSONL only; no sessions.json record available
    status              VARCHAR(50) NOT NULL DEFAULT 'unknown'
                            CHECK (status IN ('active', 'completed', 'unknown')),

    -- ── Spawn / delivery context ──────────────────────────────────────────
    -- JSONB bag for parent session relationship and delivery context.
    -- Avoids a FK constraint that would require the parent to exist first.
    -- Expected shape (all keys optional):
    --   {
    --     "spawnedBy": "agent:main:main",      -- parent session_key
    --     "spawnDepth": 1,                     -- nesting depth (0 = top-level)
    --     "deliveryContext": {                  -- from sessions.json
    --       "channel": "discord",
    --       "to": "channel:...",
    --       "accountId": "default"
    --     }
    --   }
    spawn_info          JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- ── Aggregated stats (computed from JSONL on ingest) ──────────────────
    message_count       INTEGER NOT NULL DEFAULT 0,
    tool_call_count     INTEGER NOT NULL DEFAULT 0,
    input_tokens        BIGINT NOT NULL DEFAULT 0,
    output_tokens       BIGINT NOT NULL DEFAULT 0,
    thinking_tokens     BIGINT NOT NULL DEFAULT 0,
    cache_read_tokens   BIGINT NOT NULL DEFAULT 0,
    -- Summed cost from all assistant message usage.cost.total blocks in JSONL.
    total_cost_usd      NUMERIC(12, 6) NOT NULL DEFAULT 0,

    -- ── Timestamps ────────────────────────────────────────────────────────
    -- All three sourced from JSONL entry timestamps.
    -- started_at      — timestamp of the first JSONL entry (type='session' event)
    -- ended_at        — timestamp of the last JSONL entry (null if still active)
    -- last_activity_at — timestamp of the most recent JSONL entry
    started_at          TIMESTAMPTZ,
    ended_at            TIMESTAMPTZ,
    last_activity_at    TIMESTAMPTZ,

    -- ── File metadata ─────────────────────────────────────────────────────
    -- Byte size of the JSONL file at last ingest. NULL if file not found.
    file_size           BIGINT,

    -- Absolute path to the JSONL transcript file.
    -- Example: '~/.openclaw/agents/main/sessions/<uuid>.jsonl'
    transcript_path     VARCHAR(1000),

    -- ── Housekeeping ──────────────────────────────────────────────────────
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE sessions IS
    'Session metadata indexed from sessions.json + JSONL transcripts. '
    'One row per session_key (OpenClaw''s natural session identifier). '
    'Individual messages are NOT stored here — read the JSONL file directly '
    'when full transcript detail is needed.';

COMMENT ON COLUMN sessions.session_key    IS 'OpenClaw natural key (primary lookup). E.g. agent:main:main, agent:main:cron:<uuid>.';
COMMENT ON COLUMN sessions.session_id     IS 'UUID from sessions.json. Maps to JSONL filename: <session_id>.jsonl';
COMMENT ON COLUMN sessions.kind           IS 'Derived from session_key pattern. main/heartbeat/cron/subagent/discord/acp/unknown.';
COMMENT ON COLUMN sessions.channel        IS 'Messaging surface from sessions.json origin.provider. E.g. discord, telegram.';
COMMENT ON COLUMN sessions.label          IS 'Human-readable label: from sessions.json, JSONL gateway event, or first user message.';
COMMENT ON COLUMN sessions.status         IS 'active=in sessions.json, completed=archived, unknown=JSONL-only ingest.';
COMMENT ON COLUMN sessions.spawn_info     IS 'JSONB: {spawnedBy, spawnDepth, deliveryContext}. Parent session_key, not UUID FK.';
COMMENT ON COLUMN sessions.file_size      IS 'JSONL file byte size at last ingest. NULL if file missing.';
COMMENT ON COLUMN sessions.transcript_path IS 'Absolute path to JSONL file. Used to locate transcript without sessions.json lookup.';

-- ---------------------------------------------------------------------------
-- Step 4: Indexes
-- ---------------------------------------------------------------------------

-- session_key is already indexed as PRIMARY KEY.
-- session_id is already indexed via its UNIQUE constraint (auto-creates
-- sessions_session_id_key) — no separate CREATE UNIQUE INDEX needed.

-- Common filter columns.
CREATE INDEX idx_sessions_kind               ON sessions (kind);
CREATE INDEX idx_sessions_status             ON sessions (status);
CREATE INDEX idx_sessions_channel            ON sessions (channel);
CREATE INDEX idx_sessions_model              ON sessions (model);

-- Time-based sorting (most list views want newest activity first).
CREATE INDEX idx_sessions_last_activity_at   ON sessions (last_activity_at DESC NULLS LAST);
CREATE INDEX idx_sessions_started_at         ON sessions (started_at DESC NULLS LAST);

-- Text search on label (used by the sessions list search filter).
CREATE INDEX idx_sessions_label_text         ON sessions USING gin (to_tsvector('english', coalesce(label, '')));

-- Spawn parent lookup: find all children of a given parent session_key.
CREATE INDEX idx_sessions_spawned_by         ON sessions ((spawn_info->>'spawnedBy'));

-- ---------------------------------------------------------------------------
-- Step 5: Auto-update updated_at trigger
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_sessions_updated_at
    BEFORE UPDATE ON sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

COMMIT;
