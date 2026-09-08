-- Migration 041: tasks.notes column (task 7d2a60a6 - unify archive policy)
--
-- Task.notes has existed in the API type for a long time (hydrateTask reads
-- row.notes) but no column ever backed it, so the field was always undefined.
-- The unified archive policy persists optional archive reasons to task notes
-- ("Archived (<disposition>): <reason>"), which requires the column for real.
--
-- Idempotent and safe on databases where the column was added manually.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS notes TEXT;
