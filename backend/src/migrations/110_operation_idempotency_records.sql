-- 110_operation_idempotency_records.sql
--
-- Card fb06c930 — the mutating-tool retry contract (design record bf8928ee v5
-- + ANNEX A dd3aaa9e, owner rulings 94ecf329 Batch 1 and 1d8dcd5c).
--
-- Migration number 110 is RESERVED for this lane by owner ruling 0464ad54
-- (PARALLEL-WRITERS §2); the record's own text says 109, which was reserved
-- for the settings-governance candidate on another branch.
--
-- The bad states are made unrepresentable at the WRITE rather than promised by
-- the code that writes them: a refuse-replay operation cannot carry a stored
-- response, and a completed return-replay row cannot lack one.

CREATE TABLE IF NOT EXISTS operation_idempotency_records (
  scope                 TEXT        NOT NULL,   -- 'cred:<uuid>' | 'prin:<uuid>' | 'user:<id>'
  operation             TEXT        NOT NULL,   -- closed set, design §3.3
  idempotency_key       TEXT        NOT NULL,
  request_hash          TEXT        NOT NULL,   -- sha256 hex of the canonical request (§3.4)
  state                 TEXT        NOT NULL,   -- 'in_flight' | 'completed'
  replay_policy         TEXT        NOT NULL,   -- 'return' | 'refuse'  (written from the declaration, §3.3)
  response_status       INTEGER,                -- 'return' + completed only
  response_body         TEXT,                   -- 'return' + completed only: the EXACT bytes the first answer sent (§3.2 step 6)
  response_content_type TEXT,                   -- 'return' + completed only: the header those bytes were sent with
  request_id            UUID        NOT NULL DEFAULT gen_random_uuid(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL,   -- created_at + retention (§3.6): stored, not derived (102's reasoning)
  PRIMARY KEY (scope, operation, idempotency_key),

  CONSTRAINT operation_idempotency_key_length
    CHECK (char_length(idempotency_key) BETWEEN 16 AND 128),
  CONSTRAINT operation_idempotency_state
    CHECK (state IN ('in_flight', 'completed')),
  CONSTRAINT operation_idempotency_replay_policy
    CHECK (replay_policy IN ('return', 'refuse')),
  CONSTRAINT operation_idempotency_scope_prefix
    CHECK (split_part(scope, ':', 1) IN ('cred', 'prin', 'user') AND char_length(split_part(scope, ':', 2)) > 0),

  -- Ruling 2, enforced by the database rather than by the code that writes it:
  -- a refuse-replay operation CANNOT have a stored response.
  CONSTRAINT operation_idempotency_refuse_stores_nothing
    CHECK (replay_policy <> 'refuse'
           OR (response_status IS NULL AND response_body IS NULL AND response_content_type IS NULL)),

  -- …and the operation is BOUND to its policy, which is what actually makes the
  -- mint's pack unrepresentable (review r1 finding B1).
  --
  -- The constraint above predicates only on `replay_policy`, a value the WRITER
  -- supplies. On its own it forbids a stored response for a row that SAYS
  -- 'refuse' — and says nothing about a row that names a mint operation and
  -- claims 'return'. That row satisfied every other constraint and could carry
  -- the one-time pack, so design §3.1's promise ("the secret-bearing mint has
  -- no representable row that could carry its pack") was false as first built:
  -- it rested on the middleware writing the declared policy, which is exactly
  -- the kind of rule §3.1 says a future edit can forget.
  --
  -- §3.3's set is CLOSED, so it is closed here too: an operation outside it is
  -- not representable, and each one is pinned to the policy it was ratified
  -- with. The declaration table in `middleware/idempotency.ts` and this
  -- enumeration are asserted equal, by value, by the retry-contract suite, so
  -- the two cannot drift apart in silence — adding an operation is a deliberate
  -- act that touches both.
  CONSTRAINT operation_idempotency_operation_policy
    CHECK (
      (operation IN ('task.create', 'task.stream.append', 'task.reference.create',
                     'task.note.append', 'task.patch', 'report.create',
                     'project.create', 'project.resource.create')
       AND replay_policy = 'return')
      OR
      (operation IN ('agent.mint.request', 'agent.mint.collect')
       AND replay_policy = 'refuse')
    ),

  -- …and the operation is bound to its SCOPE KIND as well as to its policy.
  --
  -- DECLARED AMENDMENT to design §3.5 / ruling 3 (dispatcher ruling 623632b0,
  -- on review round 3 finding B1/B2): `task.create`, `task.patch` and
  -- `task.stream.append` are CREDENTIAL-scoped, because their handlers apply a
  -- FIELD-level authority check the guard chain does not — `services:invoke` on
  -- a Service-targeting executionProfile, `services:write` on a reported stream
  -- append. Under principal scope a second credential of the same principal
  -- could be served a stored answer the handler would have refused it.
  --
  -- The scope PREFIX already tells the two kinds apart (`cred:` / `prin:`), so
  -- binding the operation to its prefix makes the wrong-scope row unwritable
  -- rather than merely undeclared: a `task.create` row scoped `prin:` cannot
  -- exist, whatever the middleware believes. `user:` is legal for either kind —
  -- it is §3.5's fallback when a login session is the binding.
  CONSTRAINT operation_idempotency_operation_scope
    CHECK (
      (operation IN ('task.create', 'task.patch', 'task.stream.append',
                     'agent.mint.request', 'agent.mint.collect')
       AND split_part(scope, ':', 1) IN ('cred', 'user'))
      OR
      (operation IN ('task.reference.create', 'task.note.append', 'report.create',
                     'project.create', 'project.resource.create')
       AND split_part(scope, ':', 1) IN ('prin', 'user'))
    ),

  -- …and the other direction: a completed 'return' row that has nothing to
  -- return is not representable either, so a replay can never serve an empty body.
  CONSTRAINT operation_idempotency_return_completes_with_a_body
    CHECK (state <> 'completed' OR replay_policy = 'refuse'
           OR (response_status IS NOT NULL AND response_body IS NOT NULL AND response_content_type IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ix_operation_idempotency_expires
  ON operation_idempotency_records (expires_at);

COMMENT ON TABLE operation_idempotency_records IS
  'Caller/operation-scoped retry records for the closed operation set of card fb06c930 (de73f9f8 s1.3 item 7). A row past expires_at is treated exactly as an absent row. These are the state item 2 permits: they cannot bypass current authorization (a replay is served only after the same guard chain admitted the same scope) and cross-contaminate nothing (the primary key carries the scope). response_body holds the exact serialized bytes of the first answer, not a re-parsed value, so a replay is byte-identical by construction. Rows for refuse-replay operations store no response at all.';
