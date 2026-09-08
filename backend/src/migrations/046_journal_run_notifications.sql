CREATE TABLE IF NOT EXISTS journal_run_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_key CHAR(32) NOT NULL,
  event_fingerprint CHAR(64) NOT NULL,
  event_state TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sent','failed','suppressed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  discord_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  last_error_code TEXT,
  UNIQUE (run_key,event_fingerprint,channel_id)
);
CREATE INDEX IF NOT EXISTS idx_journal_run_notifications_retry ON journal_run_notifications(status,next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_journal_run_notifications_sent ON journal_run_notifications(channel_id,sent_at DESC);
