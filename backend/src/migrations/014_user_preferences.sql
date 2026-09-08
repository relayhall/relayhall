-- User preferences table for dashboard settings
CREATE TABLE IF NOT EXISTS user_preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Set default model preference to whatever is currently in OpenClaw config
-- (will be set via API on first use)
