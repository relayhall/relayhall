-- 050: approval-bound new-entry publication with operation-aware retained-ledger integrity.
-- Existing duplicate published source dates fail closed; no keeper is selected silently.
ALTER TABLE journal_run_publications ADD COLUMN IF NOT EXISTS source_date DATE;
ALTER TABLE journal_run_publications ADD COLUMN IF NOT EXISTS response_snapshot JSONB;

-- Existing 045-048 ledgers predate response_snapshot. Backfill only the stable,
-- public identity contract from trusted ledger columns; never copy media receipts,
-- reflection text, approval fingerprints, provenance, or private song metadata.
UPDATE journal_run_publications
SET response_snapshot = jsonb_strip_nulls(jsonb_build_object(
  'publication_id', idempotency_key,
  'idempotency_key', idempotency_key,
  'entry_id', entry_id,
  'operation', operation,
  'state', state,
  'source_date', source_date
))
WHERE response_snapshot IS NULL;

ALTER TABLE journal_run_publications
  ALTER COLUMN response_snapshot SET NOT NULL;

-- Replace only the discovered entry_id -> journal_entries(id) foreign keys. Historical
-- publication rows retain the same guarantee through deferred constraint triggers, while
-- a rolled-back new_entry ledger may intentionally retain its now-deleted entry UUID.
DO $$
DECLARE constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT c.conrelid::regclass AS table_name, c.conname
    FROM pg_constraint c
    JOIN pg_attribute source_column
      ON source_column.attrelid = c.conrelid AND source_column.attnum = ANY(c.conkey)
    JOIN pg_attribute target_column
      ON target_column.attrelid = c.confrelid AND target_column.attnum = ANY(c.confkey)
    WHERE c.contype = 'f'
      AND c.conrelid IN ('journal_publication_approvals'::regclass, 'journal_run_publications'::regclass)
      AND c.confrelid = 'journal_entries'::regclass
      AND source_column.attname = 'entry_id'
      AND target_column.attname = 'id'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', constraint_row.table_name, constraint_row.conname);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION enforce_journal_publication_entry_integrity()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM journal_publication_approvals approval
    WHERE COALESCE(approval.approved_request->>'operation', '') <> 'new_entry'
      AND NOT EXISTS (SELECT 1 FROM journal_entries entry WHERE entry.id = approval.entry_id)
  ) THEN
    RAISE EXCEPTION 'historical journal publication approval must reference an existing entry';
  END IF;

  IF EXISTS (
    SELECT 1 FROM journal_run_publications publication
    WHERE NOT EXISTS (SELECT 1 FROM journal_entries entry WHERE entry.id = publication.entry_id)
      AND NOT (publication.operation = 'new_entry' AND publication.state = 'rolled_back')
  ) THEN
    RAISE EXCEPTION 'active or historical journal publication must reference an existing entry';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS journal_approval_entry_integrity ON journal_publication_approvals;
CREATE CONSTRAINT TRIGGER journal_approval_entry_integrity
AFTER INSERT OR UPDATE OF entry_id, approved_request ON journal_publication_approvals
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION enforce_journal_publication_entry_integrity();

DROP TRIGGER IF EXISTS journal_publication_entry_integrity ON journal_run_publications;
CREATE CONSTRAINT TRIGGER journal_publication_entry_integrity
AFTER INSERT OR UPDATE OF entry_id, operation, state ON journal_run_publications
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION enforce_journal_publication_entry_integrity();

DROP TRIGGER IF EXISTS journal_entry_reference_integrity ON journal_entries;
CREATE CONSTRAINT TRIGGER journal_entry_reference_integrity
AFTER DELETE OR UPDATE OF id ON journal_entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION enforce_journal_publication_entry_integrity();

CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_published_new_entry_source_date
  ON journal_run_publications(source_date)
  WHERE state='published' AND operation='new_entry';
