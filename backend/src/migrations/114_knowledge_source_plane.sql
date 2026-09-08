-- 114_knowledge_source_plane.sql
-- RH-KW1 candidate A (card 0b4b779b) — the owner-plane knowledge configuration
-- of ratified KNOWLEDGE-DESIGN v1.4 (`94747de9` §4.2), built to run packet
-- `9dbb9fa3` and breakdown record `abc71ffb` v4 §1 candidate A.
--
-- Migration number 114 is RESERVED to `rh-0b4b779b-kw1` in
-- `backend/src/migrations/RESERVED` (owner ruling PARALLEL-WRITERS `0464ad54`
-- §2). The head is never read live; 115 and 116 stay reserved for candidates
-- B–D of the same card.
--
-- ── NO NEW KIND, NO NEW TABLE ──
--
-- §4.1: "A knowledge source is `kind='service'` ... Capability, not identity,
-- carries it." So the seven fields join the EXISTING `services` row and the
-- EXISTING owner-plane seat (`PATCH /services/:id/owner-plane`, already routed
-- to the root sentinel by `utils/scopeMap.ts`). No new owner-plane route, no
-- new grant resource type (S-A7 item 2), no new registration surface.
--
-- ── WHY THE THREE CHECKS ARE IN THE SCHEMA AND NOT ONLY IN THE SERVICE ──
--
-- §4.2 is explicit that "no half-configured state can exist" (sol R1-1/R1-3).
-- The service layer gives the operator a NAMED refusal naming the exact field;
-- these CHECKs make the same states unrepresentable to any writer, including a
-- future one that forgets the service layer. Both halves are deliberate: the
-- named error is the usable half, the constraint is the true half.
--
--   1. `knowledge_source_credential_required` — §4.2: the core credential
--      reference is "REQUIRED for every external source in BOTH claims modes
--      (sol R1-2) ... a source with no core-credential arrangement cannot be
--      registered at all". An external source is exactly one with a query
--      endpoint; the reserved `board` pseudo-source of §9 has none and is
--      therefore admitted by this CHECK with every knowledge column at its
--      default, which is what §9's DECLARED exception needs.
--   2. `knowledge_source_get_needs_query` — §4.2: the get endpoint "defaults
--      to query endpoint". A get endpoint with no query endpoint is a
--      configuration that can never be dialed and never be reached by the
--      capability predicate: a half-configured state by definition.
--   3. `knowledge_source_https_only` — §4.2's outbound policy, "`https` only
--      (stricter than the shipped descriptor URL validator, which accepts
--      http)", enforced "at SET time AND at DIAL time". This is the SET-time
--      backstop; `KnowledgeDialClient` carries the same rule at dial time and
--      `KnowledgeSourceService` carries the named refusal in between.
--      Acceptance item 5 clause 1 drills the named refusal; this CHECK is why
--      no other writer can bypass it.
--
-- The DESCRIPTOR half of the capability predicate (a `knowledgeSource` block
-- with a non-empty compartment list) lives in `service_descriptor_versions`,
-- a different table, so it cannot be a CHECK here. It is enforced at the
-- owner-plane act in `ServiceRegistry.updateOwnerPlane` and re-evaluated on
-- every read by the ONE capability predicate in `KnowledgeSourceService`.
--
-- ── DEFAULTS ARE THE RULED DEFAULTS ──
--
-- `knowledge_claims_mode` defaults to 'asserted' and `knowledge_subject_mode`
-- to 'pairwise' (§4.2: "default `pairwise`" — "Pairwise removes the
-- cross-source join at zero stateful cost"). `knowledge_relevant_groups` and
-- `knowledge_allowed_networks` default to the EMPTY array, and empty means
-- what §4.2 says it means: no releasable group context, and public addresses
-- only. Neither is nullable, so "unset" and "empty" are the same state and no
-- reader has to decide which a NULL meant.

ALTER TABLE services
  -- The URLs core dials. NULL = not knowledge-configured on the owner plane.
  ADD COLUMN IF NOT EXISTS knowledge_query_endpoint TEXT,
  ADD COLUMN IF NOT EXISTS knowledge_get_endpoint TEXT,
  -- A Bitwarden-style reference NAME, never a secret on the board (§4.2). It
  -- is the arrangement by which CORE authenticates ITSELF to this source;
  -- resolution to bytes happens in the deployment secret store at dial time.
  ADD COLUMN IF NOT EXISTS knowledge_core_credential_ref TEXT,
  ADD COLUMN IF NOT EXISTS knowledge_claims_mode TEXT NOT NULL DEFAULT 'asserted'
    CHECK (knowledge_claims_mode IN ('asserted', 'none')),
  ADD COLUMN IF NOT EXISTS knowledge_subject_mode TEXT NOT NULL DEFAULT 'pairwise'
    CHECK (knowledge_subject_mode IN ('pairwise', 'direct')),
  ADD COLUMN IF NOT EXISTS knowledge_relevant_groups TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS knowledge_allowed_networks TEXT[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_source_credential_required'
  ) THEN
    ALTER TABLE services ADD CONSTRAINT knowledge_source_credential_required
      CHECK (knowledge_query_endpoint IS NULL OR knowledge_core_credential_ref IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_source_get_needs_query'
  ) THEN
    ALTER TABLE services ADD CONSTRAINT knowledge_source_get_needs_query
      CHECK (knowledge_get_endpoint IS NULL OR knowledge_query_endpoint IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_source_https_only'
  ) THEN
    ALTER TABLE services ADD CONSTRAINT knowledge_source_https_only
      CHECK (
        (knowledge_query_endpoint IS NULL OR knowledge_query_endpoint LIKE 'https://%')
        AND (knowledge_get_endpoint IS NULL OR knowledge_get_endpoint LIKE 'https://%')
      );
  END IF;
END $$;

-- The fan-out executor (candidate C) selects over knowledge-capable rows on
-- every query. A partial index keeps that selection off a full scan of the
-- registry as it grows, and indexes only the rows the predicate can admit.
CREATE INDEX IF NOT EXISTS idx_services_knowledge_configured
  ON services (id) WHERE knowledge_query_endpoint IS NOT NULL;

COMMENT ON COLUMN services.knowledge_query_endpoint IS
  'KNOWLEDGE-DESIGN 94747de9 §4.2 — owner-plane only (root sentinel). https, set-time and dial-time SSRF policy.';
COMMENT ON COLUMN services.knowledge_core_credential_ref IS
  'KNOWLEDGE-DESIGN 94747de9 §4.2 — reference NAME core resolves to authenticate ITSELF to this source. Never a secret.';
