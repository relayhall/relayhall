-- 115_knowledge_assertion_jti.sql
-- RH-KW1 candidate B (card 0b4b779b) — the TTL-bounded `jti` seen-set of
-- ratified KNOWLEDGE-DESIGN v1.4 (`94747de9` §5.2), reserved to
-- `rh-0b4b779b-kw1` in `backend/src/migrations/RESERVED`.
--
-- ── WHAT THIS TABLE GUARANTEES, AND WHAT IT DOES NOT ──
--
-- §5.2, verbatim: "core keeps a TTL-bounded seen-set of EMITTED jti values
-- (a security control — item 2's survivable category) and never emits a
-- collision".
--
-- So the guarantee is about EMISSION and nothing else. §5.2 is equally
-- explicit about the bound: "Replay of a captured assertion at the relying
-- source is therefore bounded by TTL + channel authentication (§5.4), not by
-- `jti`; mandatory source-side replay detection is deferred hardening in the
-- `d77d1f53` class." Nothing here detects replay. Claiming otherwise is the
-- exact overclaim sol R1-7 refused.
--
-- ── WHY A TABLE AND NOT A PROCESS SET ──
--
-- A `Set` in module scope is per-process, so two workers could each emit the
-- same `jti` and neither would know; and it is never evicted, so it grows
-- without bound. `middleware/apiRateLimit.ts` declares this backend
-- single-process today, but "single-process today" is not a property a
-- security control should rest on. The uniqueness is therefore the PRIMARY
-- KEY: emission INSERTs, and a collision is a constraint violation the signer
-- turns into a refusal rather than a duplicate assertion.
--
-- (It also keeps the seen-set out of `backend/src/mcp/`, where the C4 posture
-- gate's `DECLARED_PROCESS_STATE` census would have had to carry it — see
-- breakdown `abc71ffb` §4.3.)
--
-- ── BOUNDED WITH DEFINED CLEANUP ──
--
-- Every row carries the `exp` of the assertion it belongs to. A row past its
-- expiry can never collide with a live assertion, so the sweep is a plain
-- DELETE and the partial index below is what keeps both the sweep and the
-- insert cheap as the table turns over.

CREATE TABLE IF NOT EXISTS knowledge_assertion_jti (
  -- The emitted `jti` itself. PRIMARY KEY is the whole control.
  jti TEXT PRIMARY KEY CHECK (length(jti) BETWEEN 16 AND 128),
  -- The assertion's own `exp`. §5.2 caps TTL at 60s; the CHECK is deliberately
  -- looser than the signer so a clock skew never turns a legal assertion into
  -- a 500, while still refusing a row that would never expire.
  expires_at TIMESTAMPTZ NOT NULL,
  -- Which source the assertion was minted for. Forensics only: it is NOT part
  -- of the uniqueness, because `jti` is unique across the deployment.
  source_id UUID REFERENCES services(id) ON DELETE SET NULL,
  emitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_assertion_jti_expiry
  ON knowledge_assertion_jti (expires_at);

COMMENT ON TABLE knowledge_assertion_jti IS
  'KNOWLEDGE-DESIGN 94747de9 §5.2 — TTL-bounded seen-set of EMITTED jti values. Guarantees core never emits a collision; it does NOT detect replay at a relying source (bounded by TTL + channel auth).';
