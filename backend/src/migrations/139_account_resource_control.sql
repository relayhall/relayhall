-- Account ownership is distinct from Task assignment and Report authorship.
-- No historical ownership is inferred during migration.
ALTER TABLE principals ADD COLUMN IF NOT EXISTS owner_control_account_id uuid REFERENCES principals(id);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS account_owner_principal_id uuid REFERENCES principals(id);
ALTER TABLE reports ADD COLUMN IF NOT EXISTS account_owner_principal_id uuid REFERENCES principals(id);
CREATE INDEX IF NOT EXISTS tasks_account_owner_idx ON tasks(account_owner_principal_id);
CREATE INDEX IF NOT EXISTS reports_account_owner_idx ON reports(account_owner_principal_id);
