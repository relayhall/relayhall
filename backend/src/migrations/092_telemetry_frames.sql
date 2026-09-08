-- 092_telemetry_frames.sql
-- RH-P3.C7 (strategy 4e40f06f §2.6.5, the C5/F11 trim): the presence/telemetry
-- ingest ledger — pushed status frames from reporter agents, trimmed to
-- heartbeat + coarse status for v1.
--
-- DESIGN RULES (all ratified):
-- - ZERO SERVER-SIDE EFFECT: a frame changes NOTHING but this table. Lease
--   renewal happens only through the explicit claim-renew operation;
--   task.stuck derives from lease expiry or status staleness on the board's
--   own clock, never from frame contents. "Telemetry is displayed, never
--   authority" holds literally.
-- - EACH SERVICE WRITES ONLY ITS OWN STATUS: the frame's owner is the
--   authenticated calling principal, recorded server-side — a reporter
--   cannot file frames as anyone else.
-- - SHORT RETENTION: telemetry is observability, the Report remains the
--   durable record. Rows expire after TELEMETRY_RETENTION_HOURS (default 24)
--   and are pruned opportunistically at ingest. This table is deliberately
--   NOT append-only-protected — expiry-by-deletion is its contract, unlike
--   the 087/091 ledgers.
-- - COARSE STATUS ONLY (C5/F11 trim): the pushed vocabulary is the existing
--   canonical liveness words ('active' | 'idle'); 'stale' is DERIVED by the
--   server clock from frame age, never pushed. No new state vocabulary is
--   minted.
--
-- The ingest surface itself sits behind the `root` sentinel until the owner
-- ratifies the status-scope home (A12.2 declared `status:write` an
-- unratified retention "expiring at the Phase-3 session-ingest contract";
-- the naming decision is queued for the AUTHZ-DESIGN sitting 0fbb7266,
-- following the A12.7 unratified-route-family precedent).

CREATE TABLE telemetry_frames (
  id BIGSERIAL PRIMARY KEY,
  -- The authenticated reporter. Frames die with their principal.
  principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  -- Optional Task the frame reports on; frames die with the Task.
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('heartbeat', 'status')),
  -- Coarse status, required exactly when kind = 'status'. Existing canonical
  -- liveness words only.
  status TEXT CHECK (status IN ('active', 'idle')),
  CONSTRAINT telemetry_frames_status_shape CHECK (
    (kind = 'status' AND status IS NOT NULL) OR (kind = 'heartbeat' AND status IS NULL)
  ),
  -- Size-limited at ingest (TELEMETRY_MAX_PAYLOAD_BYTES); free-form reporter
  -- extras. Never consulted by any server-side decision.
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The two reads: latest frame per Task (the liveness chip) and per-principal
-- recency (rate limiting / self-status). Retention pruning walks received_at.
CREATE INDEX ix_telemetry_frames_task ON telemetry_frames (task_id, received_at DESC) WHERE task_id IS NOT NULL;
CREATE INDEX ix_telemetry_frames_principal ON telemetry_frames (principal_id, received_at DESC);
CREATE INDEX ix_telemetry_frames_received ON telemetry_frames (received_at);

COMMENT ON TABLE telemetry_frames IS
  'RH-P3.C7 presence/telemetry frames (strategy §2.6.5, C5/F11 trim: heartbeat + coarse status only). Zero server-side effect; short retention (pruned at ingest); each principal writes only its own frames; liveness is derived server-side from frame age.';
