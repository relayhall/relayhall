-- 165_principal_map_reports_mode.sql — the Map's Reports display mode
-- (card 742fae98, epic 5854f0d6). Reserved in backend/src/migrations/RESERVED
-- in the same commit (ruling 0464ad54 section 2).
--
-- The Map's toolbar gains "Reports: Collapsed | Expanded", remembered per user
-- across reloads. That is a presentation preference of the principal's own,
-- which is exactly what `principal_preferences` holds (080: "Per-principal
-- presentation preferences"), so the choice is one more column on that row
-- rather than new storage. The row stays keyed on the principal alone and the
-- API still derives the principal from the session, so a caller can read and
-- write only its own choice (080's IDOR argument is unchanged).
--
-- NOT NULL DEFAULT 'collapsed': Collapsed is the owner's stated default, and
-- unlike `theme` there is no resolution chain behind this value that an
-- absence would have to reach. Every existing row reads Collapsed.
--
-- A CHECK constraint, not an enum type, for the same reason 080 gives. The two
-- strings are the value space the service (MAP_REPORTS_MODE_VALUES) and the
-- dashboard (utils/theme.ts) declare; principalPreferences.test.ts compares
-- this CHECK with the service's list.
--
-- One change, one implicit transaction, no COMMIT, replay-safe: ADD COLUMN IF
-- NOT EXISTS and DROP CONSTRAINT IF EXISTS make a second run a no-op.
ALTER TABLE principal_preferences
  ADD COLUMN IF NOT EXISTS map_reports_mode VARCHAR(16) NOT NULL DEFAULT 'collapsed';

ALTER TABLE principal_preferences
  DROP CONSTRAINT IF EXISTS principal_preferences_map_reports_mode_check;
ALTER TABLE principal_preferences
  ADD CONSTRAINT principal_preferences_map_reports_mode_check
  CHECK (map_reports_mode IN ('collapsed','expanded'));

COMMENT ON COLUMN principal_preferences.map_reports_mode IS
  'How the Map draws a task''s Reports: collapsed = one "Reports · N" node per task (default); expanded = every Report node in a report area.';
