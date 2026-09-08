-- 080_principal_preferences.sql
-- RH-UI.2 (task 07113036): a principal's own presentation preferences.
-- Ratified contract: RH-DESIGN.6 §5.1 (report 9f01ba4b), vocabulary A16.
--
-- Slot 080 is the next free number behind 079 (RH-DESIGN.5 R2: migration
-- numbers are taken at implementation, never reserved ahead of the work).
--
-- WHY A NEW TABLE AND NOT `user_preferences`. The existing table is a global
-- key/value store with no owner column — it holds deployment-wide UI state,
-- not per-identity state, and bolting a principal column onto it would make
-- every existing row ambiguous. §5.1 says it stays untouched; this is the
-- per-principal object.
--
-- WHY THE TABLE IS KEYED ON THE PRINCIPAL AND NOTHING ELSE. Exactly one row
-- per principal, so `principal_id` IS the primary key. There is no surrogate
-- id to guess, no row a caller could name, and consequently nothing for a
-- path or body parameter to address: the API derives the principal from the
-- authenticated session and can only ever read or write that one row
-- (§5.1 "IDOR-proof by construction", review S-F11). The cross-principal
-- probe is an acceptance case, not a hope.
--
-- WHY `theme` IS NULLABLE. §5.5's resolution chain is
--   principal preference -> deployment default Theme -> relay-dark.
-- A principal who has expressed no preference is a real, common state, and
-- it is the ONLY thing that makes the middle link reachable. A DEFAULT here
-- would pin every new principal to a Theme and quietly delete the
-- deployment's ability to choose one (that surface arrives with Appearance
-- in RH-UI.4). NULL means "I have no preference"; it is an absence, not a
-- fourth value, so the declared value space stays exactly the three Themes
-- plus the `system` directive.
--
-- WHY `reduced_motion` IS A TRI-STATE AND NOT A BOOLEAN. §5.1 asks for
-- "system-default, overridable". A boolean cannot distinguish "follow my
-- operating system" from "force motion on", and those are different answers
-- for anyone whose OS setting is wrong for this one application. `system`
-- (the default) removes the attribute entirely and leaves the
-- prefers-reduced-motion media query in charge.
--
-- CHECK constraints, not enum types: the value space is small, and an ALTER
-- TYPE for a fourth Theme is a lock this project does not need to take.
-- These four strings are one of FOUR copies of the value space, and
-- scripts/check-theme-parity.py proves all four agree.

CREATE TABLE IF NOT EXISTS principal_preferences (
  principal_id    UUID PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  theme           VARCHAR(32)
                    CHECK (theme IN ('relay-dark','relay-light','high-contrast','system')),
  reduced_motion  VARCHAR(32) NOT NULL DEFAULT 'system'
                    CHECK (reduced_motion IN ('system','reduce','no-preference')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE principal_preferences IS
  'Per-principal presentation preferences (RH-DESIGN.6 §5.1). One row per principal, keyed on the principal itself so no request can address another identity''s row.';
COMMENT ON COLUMN principal_preferences.theme IS
  'NULL = no preference; fall through to the deployment default Theme, then relay-dark.';
COMMENT ON COLUMN principal_preferences.reduced_motion IS
  'system = follow prefers-reduced-motion (default); reduce/no-preference override it.';
