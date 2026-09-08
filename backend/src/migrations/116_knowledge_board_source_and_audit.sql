-- 116_knowledge_board_source_and_audit.sql
-- RH-KW1 candidate C (card 0b4b779b) — the reserved board pseudo-source row
-- and the §7.7 knowledge audit ledger of ratified KNOWLEDGE-DESIGN v1.4
-- (`94747de9`), built to run packet `9dbb9fa3` and breakdown record
-- `abc71ffb` v4 §1 candidate C.
--
-- Migration number 116 is RESERVED to `rh-0b4b779b-kw1` in
-- `backend/src/migrations/RESERVED` (owner ruling PARALLEL-WRITERS `0464ad54`
-- §2). 114 shipped the source plane and 115 the emitted-jti set; this file
-- depends on 114's columns existing but on nothing outside the lane.
--
-- ── PART 1 · THE RESERVED BOARD ROW (§9) ──
--
-- §9: "The board is a RESERVED knowledge source with a real registry
-- identity: an owner-plane-created Service row, fixed slug `board`, no
-- external endpoints, no core credential, and `claims_mode` inapplicable (it
-- is answered IN-PROCESS — no channel, no assertion, no SSRF surface), with a
-- CORE-AUTHORED `knowledgeSource` declaration (fixed classes covering
-- reports/tasks/skills, fixed NON-EMPTY compartment vocabulary)."
--
-- WHY A MIGRATION AND NOT A REGISTRATION ACT. `076_service_registry.sql`
-- says "No seed rows: registries start empty and estate services are
-- registered element-by-element at cutover, never via repo migrations (the
-- A14.4 precedent)". That sentence is about ESTATE services — external
-- systems an operator registers. The board row is not one: it names core
-- itself, it dials nothing, its descriptor is CORE-AUTHORED, and every
-- deployment must have exactly one. Seeding core's own rows in the chain is
-- the shipped pattern for exactly that case (062 seeds `principals`, 065
-- seeds `agent_types`, 067 seeds the installation singleton). Writing it here
-- also makes the row present before any request can be served, which a lazy
-- "ensure on first search" could not promise without turning a read path into
-- a writer.
--
-- WHAT PROTECTS THE SLUG. Candidate A shipped `RESERVED_SERVICE_SLUGS`
-- (`services/KnowledgeSourcePolicy.ts`) and enforces it at the registration
-- surface (`services/ServiceRegistry.ts`), so no agent-plane registration can
-- claim `board`. This INSERT is therefore the only writer of that slug, and
-- `ON CONFLICT (slug) DO NOTHING` keeps a re-run and an upgrade database
-- honest (breakdown finding F8: the reservation and the row are both
-- candidate C's; the reservation half landed early, with the predicate that
-- needs it).
--
-- WHAT THE ROW DELIBERATELY DOES NOT CARRY. No `knowledge_query_endpoint`,
-- no `knowledge_get_endpoint`, no `knowledge_core_credential_ref`, and
-- `knowledge_allowed_networks` empty: §9's "no external endpoints, no core
-- credential". 114's `knowledge_source_credential_required` CHECK admits the
-- row for exactly that reason — an external source is one WITH a query
-- endpoint. `knowledge_claims_mode` keeps its column default because §9 says
-- claims mode is INAPPLICABLE here and the in-process branch never reads it;
-- a third enum value meaning "inapplicable" would put a state in the column
-- that every other reader would have to learn.

INSERT INTO services (slug, name, description, kind, status, runtime_mode)
VALUES (
  'board',
  'RelayHall board',
  'The RelayHall board itself: reports, tasks and skills, answered in-process from core rows under the caller''s own authorization. Reserved (KNOWLEDGE-DESIGN 94747de9 §9).',
  'service',
  'published',
  'direct'
)
ON CONFLICT (slug) DO NOTHING;

-- The CORE-AUTHORED descriptor, version 1.
--
-- `content_hash` is `sha256Hex(canonicalJson(descriptor))` — the exact
-- convention `ServiceRegistry.publishDescriptor` uses, computed over the
-- canonical form of the JSON below. `kw1KnowledgeBoardSource.test.ts`
-- RECOMPUTES it from the stored row rather than trusting this literal, so a
-- future edit to the descriptor that forgets the hash fails a test instead of
-- shipping a row whose hash means nothing.
INSERT INTO service_descriptor_versions (service_id, version, descriptor, content_hash, created_by_principal_id)
SELECT s.id, 1,
  '{"options":[],"knowledgeSource":{"classes":[{"key":"reports","label":"Reports","content":"docs"},{"key":"tasks","label":"Tasks","content":"docs"},{"key":"skills","label":"Skills","content":"code"}],"compartments":["reports","tasks","skills"]}}'::jsonb,
  'cfdd780b2cf23f6321865e4245fe6fa0d91287bf0fe34c49aea396b408958f11',
  NULL
FROM services s
WHERE s.slug = 'board'
  AND NOT EXISTS (
    SELECT 1 FROM service_descriptor_versions v WHERE v.service_id = s.id AND v.version = 1
  );

UPDATE services
   SET current_descriptor_version = 1
 WHERE slug = 'board' AND current_descriptor_version IS NULL;

-- ── PART 2 · THE §7.7 AUDIT LEDGER ──
--
-- §7.7 is explicit about what each row carries and why, and the two rows are
-- deliberately DIFFERENT shapes because they defend different things.
--
-- THE SEARCH ROW stores "caller, credential, the full fan-out set with
-- per-source outcomes, and the FULL QUERY TEXT (the field an exfiltration
-- rides — a hash defends nothing and destroys the evidence)". `q` is the
-- first caller-supplied text RelayHall transmits OUTWARD, so the forensic
-- question this table answers is "what text went where", and it can only be
-- answered by a row holding the text and the destinations together.
--
-- THE GET ROW stores "source, compartment, and a sha256 CORE computes over
-- the decoded raw ref (raw refs are source paths — sensitive; core hashes
-- rather than stores them)". There is deliberately NO column that could hold
-- a raw ref, so a future writer cannot put one here by accident.
--
-- Reading these rows is owner-plane/root authority (§7.7). No REST surface
-- reads them in KW1: the acceptance drills read them directly. A read route
-- without a ratified shape would be a disclosure surface this design never
-- sized.
--
-- APPEND-ONLY, like `audit_events` (087), and for the same reason: a forensic
-- record that can be edited after the fact is not evidence. The trigger
-- function is named for these tables so it never collides with 087's.
--
-- ── WHY THE CALLER COLUMNS ARE IDS AND NOT FOREIGN KEYS ──
--
-- They were `REFERENCES … ON DELETE SET NULL` in the first version of this
-- file, and that could not coexist with the append-only trigger: PostgreSQL
-- implements `SET NULL` by UPDATING the referencing row, the trigger refuses
-- every update, and so an audited Service could not be hard-deleted through
-- `ServiceRegistry`'s delete path at all. Two true-sounding statements, one
-- of which had to go.
--
-- The one that goes is the reference. A forensic row must not lose its answer
-- because the subject was deleted afterwards — "who did this" is exactly what
-- the row exists to preserve — so the columns keep the id as a VALUE. They
-- are ids, not names or addresses: an id whose row is gone still tells an
-- operator which id it was, and nothing else about it.

CREATE TABLE IF NOT EXISTS knowledge_search_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The `auditRef` the response returns (§7.3). Opaque to the caller and
  -- useless without owner-plane read authority, but it lets an operator tie a
  -- complaint to a row without a timestamp hunt.
  audit_ref TEXT NOT NULL UNIQUE CHECK (length(audit_ref) BETWEEN 8 AND 128),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- WHO. The account principal, and the credential the act was presented
  -- with. Stored as ids rather than references — see the note above.
  caller_principal_id UUID,
  caller_credential_id UUID,
  -- WHAT WENT OUT. The full query text. §7.1 caps `q` at 1024 characters at
  -- the request boundary; the CHECK restates that bound so a future
  -- request-side change cannot silently widen the row.
  query_text TEXT NOT NULL CHECK (length(query_text) <= 1024),
  -- The request's routing arms, as core resolved them.
  kinds TEXT[] NOT NULL DEFAULT '{}',
  -- WHERE IT WENT. The full fan-out set with per-source outcomes:
  -- [{ "sourceId", "sourceSlug", "outcome", "assertionJti"?, "resultCount"? }].
  -- JSONB rather than a child table because the row is read as one document
  -- by a human answering one question, and a child table would let a partial
  -- delete leave a half-answer.
  fanout JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(fanout) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_knowledge_search_audit_order
  ON knowledge_search_audit (occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_search_audit_caller
  ON knowledge_search_audit (caller_principal_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_get_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  caller_principal_id UUID,
  caller_credential_id UUID,
  source_id UUID,
  -- The compartment the handle was sealed with — a core-validated declared
  -- name (§6.1), never a source-authored byte.
  compartment TEXT NOT NULL CHECK (length(compartment) BETWEEN 1 AND 128),
  -- sha256 CORE computes over the DECODED raw ref. Sixty-four lowercase hex
  -- characters, and the CHECK is what stops a raw ref being written here.
  ref_sha256 TEXT NOT NULL CHECK (ref_sha256 ~ '^[0-9a-f]{64}$'),
  -- The core-authored outcome token, so a refusal is as auditable as a read.
  outcome TEXT NOT NULL CHECK (length(outcome) BETWEEN 1 AND 64)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_get_audit_order
  ON knowledge_get_audit (occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_get_audit_source
  ON knowledge_get_audit (source_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION reject_knowledge_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'knowledge audit rows are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_knowledge_search_audit_no_update_delete ON knowledge_search_audit;
CREATE TRIGGER trg_knowledge_search_audit_no_update_delete
BEFORE UPDATE OR DELETE ON knowledge_search_audit
FOR EACH ROW EXECUTE FUNCTION reject_knowledge_audit_mutation();

DROP TRIGGER IF EXISTS trg_knowledge_get_audit_no_update_delete ON knowledge_get_audit;
CREATE TRIGGER trg_knowledge_get_audit_no_update_delete
BEFORE UPDATE OR DELETE ON knowledge_get_audit
FOR EACH ROW EXECUTE FUNCTION reject_knowledge_audit_mutation();

ALTER TABLE knowledge_search_audit ENABLE ALWAYS TRIGGER trg_knowledge_search_audit_no_update_delete;
ALTER TABLE knowledge_get_audit ENABLE ALWAYS TRIGGER trg_knowledge_get_audit_no_update_delete;

COMMENT ON TABLE knowledge_search_audit IS
  'KNOWLEDGE-DESIGN 94747de9 §7.7 — append-only forensic record of one knowledge search: caller, credential, FULL query text, and the fan-out set with per-source outcomes. Reading is owner-plane/root authority.';
COMMENT ON TABLE knowledge_get_audit IS
  'KNOWLEDGE-DESIGN 94747de9 §7.7 — append-only forensic record of one knowledge get: source, compartment, and a core-computed sha256 over the decoded raw ref. Raw refs are never stored.';
