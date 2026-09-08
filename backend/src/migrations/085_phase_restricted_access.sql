-- RH-P2.5 owner ruling 44ee41f2: Project visibility is inherited by default.
-- Restriction is an explicit exceptional Phase policy, never a side effect of
-- adding an exact grant. Every change is attributed and append-only.

ALTER TABLE phases
  ADD COLUMN IF NOT EXISTS restricted_access BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS phase_access_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phase_id UUID NOT NULL REFERENCES phases(id) ON DELETE RESTRICT,
  actor_principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  previous_restricted BOOLEAN NOT NULL,
  restricted BOOLEAN NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (previous_restricted <> restricted)
);

CREATE INDEX IF NOT EXISTS ix_phase_access_events_phase_time
  ON phase_access_events(phase_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION ledger_phase_access_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor_id UUID;
  change_reason TEXT;
BEGIN
  IF NEW.restricted_access IS NOT DISTINCT FROM OLD.restricted_access THEN
    RETURN NEW;
  END IF;
  actor_id := NULLIF(current_setting('relayhall.phase_access_actor', TRUE), '')::UUID;
  change_reason := NULLIF(current_setting('relayhall.phase_access_reason', TRUE), '');
  IF actor_id IS NULL OR change_reason IS NULL THEN
    RAISE EXCEPTION 'Phase restricted-access changes require attributed audit context';
  END IF;
  INSERT INTO phase_access_events
    (phase_id, actor_principal_id, previous_restricted, restricted, reason)
  VALUES (NEW.id, actor_id, OLD.restricted_access, NEW.restricted_access, change_reason);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS phases_restricted_access_ledger ON phases;
CREATE TRIGGER phases_restricted_access_ledger
BEFORE UPDATE OF restricted_access ON phases
FOR EACH ROW EXECUTE FUNCTION ledger_phase_access_change();

CREATE OR REPLACE FUNCTION reject_phase_access_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'phase_access_events is append-only';
END $$;

DROP TRIGGER IF EXISTS phase_access_events_append_only ON phase_access_events;
CREATE TRIGGER phase_access_events_append_only
BEFORE UPDATE OR DELETE ON phase_access_events
FOR EACH ROW EXECUTE FUNCTION reject_phase_access_event_mutation();

COMMENT ON COLUMN phases.restricted_access IS
  'Explicit exceptional confidentiality/blind-test mode. FALSE inherits Project visibility. Grants are always additive and never toggle this field.';
COMMENT ON TABLE phases IS
  'Grouping object between Project and Task. Project visibility is inherited by default; grants are additive. Exceptional confidentiality/blind-test restriction is explicit and audited (owner ruling 44ee41f2).';
COMMENT ON TABLE phase_access_events IS
  'Append-only attribution ledger for privileged Phase restricted-access changes (owner ruling 44ee41f2).';
