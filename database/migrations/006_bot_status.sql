-- Bot Status Table
-- Stores avatar and status updates for the dashboard

CREATE TABLE IF NOT EXISTS bot_status (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mood VARCHAR(100) NOT NULL,
    status_text TEXT NOT NULL,
    avatar_url TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create index for quick retrieval of latest status
CREATE INDEX IF NOT EXISTS idx_bot_status_updated_at ON bot_status(updated_at DESC);

-- Insert default status
INSERT INTO bot_status (mood, status_text, avatar_url) 
VALUES ('neutral', 'Ready to explore and create', NULL);

-- Add comment for documentation
COMMENT ON TABLE bot_status IS 'Bot avatar and status updates, displayed on dashboard';
