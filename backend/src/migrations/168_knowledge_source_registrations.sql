-- 168_knowledge_source_registrations.sql — two-way registration of a
-- knowledge source, the core half (card 08792425, member N6; the default-store
-- design's choice C7). Reserved in backend/src/migrations/RESERVED in the same
-- commit; 167 is held there for a parallel lane.
--
-- One table and one index, one implicit transaction, no COMMIT. Replay-safe:
-- re-running this file against a database that already has it changes
-- nothing. database/init.sql is untouched.
--
-- ── knowledge_source_registrations ──
--
-- One row per Service an administrator registered from an installer's bundle
-- on the Services page. The Service row keeps what the dial reads (the
-- endpoints, the allowed networks, the credential reference NAME); this row
-- keeps what only the registration act knows:
--
--   certificate_sha256        the sha256 fingerprint of the endpoint's TLS
--                             certificate, as the bundle carried it and the
--                             administrator confirmed it against the
--                             installer's console. An upload-time check only:
--                             the core dials through Node's default trust store
--                             and never pins it.
--   fingerprint_confirmation  how the administrator confirmed it: 'checked'
--                             (ticked against the displayed value) or 'typed'.
--   confirmed_by              the Account that confirmed it and registered.
--   bundle_sha256             the sha256 of the bundle as uploaded.
--   step_up_token_id          the single-use step-up spent on the act.
--
-- The channel bearer is never here and never on the board: the operator
-- places it in the core's environment under the Service row's reference name.
-- Deleting the Service deletes its registration row.
CREATE TABLE IF NOT EXISTS knowledge_source_registrations (
  service_id UUID PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
  certificate_sha256 TEXT NOT NULL
    CONSTRAINT knowledge_source_registrations_fingerprint
    CHECK (certificate_sha256 ~ '^[0-9a-f]{64}$'),
  fingerprint_confirmation TEXT NOT NULL
    CONSTRAINT knowledge_source_registrations_confirmation
    CHECK (fingerprint_confirmation IN ('checked', 'typed')),
  confirmed_by UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  bundle_sha256 TEXT NOT NULL
    CONSTRAINT knowledge_source_registrations_bundle
    CHECK (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  step_up_token_id UUID NOT NULL
);

-- The duplicate-fingerprint refusal reads this index under the act's lock.
CREATE INDEX IF NOT EXISTS ix_knowledge_source_registrations_fingerprint
  ON knowledge_source_registrations (certificate_sha256);
