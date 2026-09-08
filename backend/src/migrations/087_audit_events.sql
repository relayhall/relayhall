-- 087_audit_events.sql
-- RH-P2.7: indefinite, append-only control-plane audit ledger. There is no
-- retention window and deliberately no purge/delete path in v1.

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  action TEXT NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.]{2,127}$'),
  outcome TEXT NOT NULL DEFAULT 'success' CHECK (outcome IN ('success', 'denied')),
  actor_principal_id UUID REFERENCES principals(id) ON DELETE SET NULL,
  actor_handle TEXT NOT NULL,
  auth_method TEXT NOT NULL CHECK (auth_method IN (
    'local_admin', 'dashboard_jwt', 'principal_api_key', 'legacy_api_key',
    'reports_read_key', 'session', 'system', 'unknown'
  )),
  credential_id UUID REFERENCES principal_credentials(id) ON DELETE SET NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX ix_audit_events_order ON audit_events (occurred_at DESC, id DESC);
CREATE INDEX ix_audit_events_action_order ON audit_events (action, occurred_at DESC, id DESC);
CREATE INDEX ix_audit_events_actor_order ON audit_events (actor_principal_id, occurred_at DESC, id DESC);
CREATE INDEX ix_audit_events_resource_order ON audit_events (resource_type, resource_id, occurred_at DESC, id DESC);

CREATE OR REPLACE FUNCTION reject_audit_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_events_no_update_delete ON audit_events;
CREATE TRIGGER trg_audit_events_no_update_delete
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();

DROP TRIGGER IF EXISTS trg_audit_events_no_truncate ON audit_events;
CREATE TRIGGER trg_audit_events_no_truncate
BEFORE TRUNCATE ON audit_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_event_mutation();

ALTER TABLE audit_events ENABLE ALWAYS TRIGGER trg_audit_events_no_update_delete;
ALTER TABLE audit_events ENABLE ALWAYS TRIGGER trg_audit_events_no_truncate;

COMMENT ON TABLE audit_events IS
  'RH-P2.7 indefinite append-only audit ledger. No v1 purge job or deletion API.';
