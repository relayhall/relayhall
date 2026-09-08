-- 112_telemetry_receiver_limits.sql
-- RH-TW1a candidate B (card beac9c79) — the DEPLOYMENT-WIDE receiver limit that
-- hardening card 329dba46 asks for, whose DoD design 7d5c0cdc Appendix C
-- imports into TW1a verbatim:
--
--   "Hardening 329dba46 (frame throttling deployment-wide) — Its DoD text is
--    imported into TW1a's DoD verbatim; the card closes on TW1a acceptance
--    (single consistent mechanic, stated identically in 3.1 and here)."
--
-- WHY A TABLE AND NOT A MAP. The shipped gate is
-- `private lastAcceptedAt = new Map<string, number>()` in TelemetryService:
-- per-process, so two workers accept two frames in the same interval, and
-- never evicted, so it grows without bound. There is no Redis anywhere in this
-- tree and `middleware/apiRateLimit.ts` declares the backend single-process, so
-- "deployment-wide" can only mean database-backed. The map is REMOVED by this
-- candidate, not merely bounded.
--
-- THE ATOMICITY IS IN THE STATEMENT, NOT IN THE CALLER. The gate is one
-- INSERT ... ON CONFLICT DO UPDATE whose WHERE clause carries the interval
-- test, and it RETURNS a row only when it actually won. A read-then-write
-- pair — even inside a transaction — lets two clients both read "last accepted
-- long ago" and both write; only a conditional upsert decides a winner in one
-- round trip under the default isolation level.
--
-- Bounded with defined cleanup: rows are per (principal, surface), so the table
-- is bounded by the number of principals that have ever reported, and rows
-- untouched for longer than the retention window are pruned by the same
-- opportunistic sweep the frames use.

CREATE TABLE IF NOT EXISTS telemetry_rate_limits (
  principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  -- Which ingest surface the interval governs. Frames and envelopes are
  -- separately budgeted: a reporter pushing presence must not starve its own
  -- envelope stream, and the two have different natural rates.
  surface TEXT NOT NULL CHECK (surface IN ('frames', 'events', 'events_batch')),
  last_accepted_at TIMESTAMPTZ NOT NULL,
  -- Observability for the operator, and the evidence that the gate is doing
  -- something: how many attempts this principal has had refused on this
  -- surface since the row was created.
  refused_count BIGINT NOT NULL DEFAULT 0 CHECK (refused_count >= 0),
  accepted_count BIGINT NOT NULL DEFAULT 1 CHECK (accepted_count >= 0),
  PRIMARY KEY (principal_id, surface)
);

CREATE INDEX IF NOT EXISTS idx_telemetry_rate_limits_sweep
  ON telemetry_rate_limits (last_accepted_at);

COMMENT ON TABLE telemetry_rate_limits IS
  'Deployment-wide per-principal ingest interval gate (hardening 329dba46, DoD imported into TW1a by design 7d5c0cdc Appendix C). One conditional upsert decides each attempt, so the limit holds across workers; the in-memory per-process map it replaces could not.';
COMMENT ON COLUMN telemetry_rate_limits.surface IS
  'Frames and envelope events are budgeted separately: one stream must not starve the other, and their natural rates differ.';
COMMENT ON COLUMN telemetry_rate_limits.refused_count IS
  'Attempts refused since this row was created — the operator-visible evidence that the gate is live, and the signal a reporter is misconfigured.';
