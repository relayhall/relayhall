-- 044: outbound webhooks for task change notifications (task 3c7da35b)
CREATE TABLE IF NOT EXISTS webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url TEXT NOT NULL,
  secret TEXT,
  events TEXT[] NOT NULL DEFAULT ARRAY['task.created','task.updated','task.deleted','task.archived'],
  active BOOLEAN NOT NULL DEFAULT true,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_delivery_at TIMESTAMPTZ,
  last_delivery_status INTEGER,
  last_delivery_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks(active) WHERE active;
