-- Card 7d38a6e0 (lane FEAT-A) — a Task can name when it is due.
--
-- The Task object had no due date, so a timeline, a presentation or any
-- deadline-driven view had nothing to render and every caller that needed one
-- kept it somewhere else. This adds the field the product was missing.
--
-- WHY timestamptz AND NOT date. A due date that is a calendar date has to be
-- interpreted in SOME timezone before anything can decide whether it has
-- passed, and the server would be inventing that timezone on the reader's
-- behalf. A timestamptz names the instant the caller chose; the interface
-- renders it in the reader's own zone, and "overdue" is a comparison rather
-- than a convention.
--
-- WHY NULL AND NOT A DEFAULT. Most Tasks have no deadline and that is not a
-- missing value — it is the ordinary state. NULL says so, and it is what every
-- Task that exists on every deployment today already has, so the column
-- arrives on TST and PROD without touching a single row.
--
-- `tasks` is a HOT table (5s updater). Migration 063 prescribes the shape:
-- add the column BARE, and express any constraint as NOT VALID + VALIDATE.
-- A nullable timestamptz with no default is a CATALOGUE-ONLY change on
-- PostgreSQL 11+: no table rewrite, and the lock it takes is held for the
-- duration of a catalogue update rather than of a scan.
--
-- ROUND-1 REVIEW F3. This file also created a partial index on `due_at`, for
-- a "what is due, soonest first" query THAT DOES NOT EXIST YET: the list has
-- no sort surface, and building that surface is deferred by design. A plain
-- CREATE INDEX takes a SHARE lock and blocks every INSERT, UPDATE and DELETE
-- on `tasks` until the build finishes, and CONCURRENTLY is not available
-- here because db/migrate.ts executes each file as one multi-statement query.
-- Paying a write outage on the hottest table in the product for an index
-- nothing reads is the wrong trade, so the index goes with the surface that
-- needs it, under its own reserved number and whatever runner support a
-- concurrent build turns out to require.
--
-- Every statement is IF NOT EXISTS / OR REPLACE: `npm run migrate` is run
-- against databases at every stage of the chain, and a re-run of this file
-- must be a no-op rather than an error.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN tasks.due_at IS
  'When this Task is due, as an instant. NULL means no deadline, which is the ordinary state and not a missing value. The board is not a calendar: a past instant is accepted, because a deadline already missed is a thing worth recording (card 7d38a6e0).';
