-- 163_telemetry_otlp_rate_surfaces.sql — the OTLP/HTTP receivers' own surfaces
-- in the deployment-wide telemetry receiver limit (RH-TW1b slice 1, card
-- dac2ca71). Reserved in backend/src/migrations/RESERVED as slot 163 in the
-- same commit as this file (ruling 0464ad54 section 2).
--
-- Migration 112 created telemetry_rate_limits with a column CHECK naming three
-- surfaces: frames, events, events_batch. The OTLP receivers budget each signal
-- separately (otlp_traces, otlp_logs, otlp_metrics), so the vocabulary widens
-- to six. Nothing else changes: no column, no row, no other constraint.
--
-- THE PREDECESSOR IS MATCHED EXACTLY, OR THE MIGRATION RAISES (the third
-- terminating shape of evidence aec6ab9f section 14). TW1b candidate A's
-- migration 118 inferred which constraint to drop three times and was wrong
-- three times — by generated NAME (a renamed predecessor survived beside the
-- new one), by definition SUBSTRING (a CHECK on another column could match),
-- and by column DEPENDENCY (every single-column CHECK on the column, including
-- an operator's independent policy check, was dropped). Each was a migration
-- reporting success while removing or missing someone's invariant.
--
-- So nothing is inferred here. The ONE constraint replaced is the one whose
-- pg_get_constraintdef is EXACTLY the text migration 112 produces, whatever it
-- is named. Zero such constraints, or more than one, is an estate this
-- migration does not recognise, and it RAISES with a message an operator reads
-- rather than guessing. Every other constraint on the table — a renamed copy
-- with a different definition, an independent check on `surface`, anything — is
-- untouched, because it is never selected.
--
-- REPLAY-SAFE: once applied, the predecessor text is gone and the successor
-- text is present exactly once; that state — and only that state — is a no-op.
--
-- One DO block, one implicit transaction, no COMMIT. database/init.sql is
-- untouched (telemetry_rate_limits is created by forward migration 112).
DO $$
DECLARE
  predecessor CONSTANT text :=
    'CHECK ((surface = ANY (ARRAY[''frames''::text, ''events''::text, ''events_batch''::text])))';
  successor CONSTANT text :=
    'CHECK ((surface = ANY (ARRAY[''frames''::text, ''events''::text, ''events_batch''::text, '
    || '''otlp_traces''::text, ''otlp_logs''::text, ''otlp_metrics''::text])))';
  matches text[];
  successors integer;
BEGIN
  SELECT array_agg(c.conname::text ORDER BY c.conname)
    INTO matches
    FROM pg_constraint c
   WHERE c.conrelid = 'telemetry_rate_limits'::regclass
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) = predecessor;

  SELECT count(*)::integer
    INTO successors
    FROM pg_constraint c
   WHERE c.conrelid = 'telemetry_rate_limits'::regclass
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) = successor;

  IF COALESCE(array_length(matches, 1), 0) = 0 AND successors = 1 THEN
    RAISE NOTICE '163: telemetry_rate_limits already carries the six-surface CHECK; nothing to do';
    RETURN;
  END IF;

  IF COALESCE(array_length(matches, 1), 0) <> 1 OR successors <> 0 THEN
    RAISE EXCEPTION
      '163: expected exactly one CHECK on telemetry_rate_limits equal to the migration-112 surface vocabulary and none equal to its successor; found % and %',
      COALESCE(array_length(matches, 1), 0), successors
      USING HINT = 'This estate''s telemetry_rate_limits constraints differ from what migration 112 creates. '
        || 'Compare pg_get_constraintdef for its CHECK constraints with the text in this file and reconcile them by hand; '
        || 'the migration deliberately drops nothing it cannot identify exactly.';
  END IF;

  EXECUTE format('ALTER TABLE telemetry_rate_limits DROP CONSTRAINT %I', matches[1]);
  ALTER TABLE telemetry_rate_limits
    ADD CONSTRAINT telemetry_rate_limits_surface_check
    CHECK (surface IN ('frames', 'events', 'events_batch', 'otlp_traces', 'otlp_logs', 'otlp_metrics'));
END $$;
