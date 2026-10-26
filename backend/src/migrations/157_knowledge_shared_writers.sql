-- 157_knowledge_shared_writers.sql — the shared-area writer list (card
-- 549cc51f; design ratified by owner ruling E298, its F1 repair by E299, its
-- scope narrowed by E310). Reserved in backend/src/migrations/RESERVED as slot
-- 157 before this file existed (ruling 0464ad54 section 2).
--
-- A knowledge source's organisation-wide SHARED AREA is readable by everyone
-- the source admits; only the Accounts on its WRITER LIST may write it. Until
-- now that list was a value in the source's own deployment configuration. This
-- migration makes it a governed core object: one list per (knowledge source,
-- scope), changed only by root or an administrator in a login session with a
-- step-up on every change, every change audited, delivered to the source inside
-- the signed lifecycle snapshot the core already exports.
--
-- Four changes, one implicit transaction, no COMMIT. Every statement is
-- replay-safe: re-running this file against a database that already has it
-- changes nothing. database/init.sql is untouched. Nothing here widens an
-- approval kind, an approval CHECK or the access-request kinds (E310): the
-- request path comes with the universal change-request model (card e97e65ea).
--
-- ── 1. knowledge_shared_writers ──
--
-- One row = one Account on one source's writer list for one scope.
--
--   source_id   the knowledge source (a `services` row). The list goes with
--               its source: a hard-deleted Service takes its list with it.
--   scope       'organisation' only. A later card (per-group shared areas)
--               widens the CHECK to name a Group scope; nothing else changes.
--   account_id  an ACCOUNT: a parentless human principal, enforced by the
--               trigger below as well as by the handler. A Connector, an
--               Agent, a Group or a service identity is never a writer:
--               the source sees the Account, never the connection it used.
--   added_by    the principal whose act added the row (NULL once that
--               principal row is gone; the audit ledger keeps the act).
--   reason      the human's reason, 20-2,000 characters, as for every other
--               request reason on this board. Untrusted text.
--   approval_id NULL. The column exists for the universal change-request
--               model; nothing in this release writes it.
--   expires_at  NULL = never (owner ruling E298 Q5 (a): a direct add does not
--               expire by default). When set, the 60-second sweep removes the
--               row after it passes, audited as actor `system`, and the
--               snapshot stops naming it at once.
--
-- There is no updated_at: a row is inserted or deleted, never edited, and the
-- audit ledger holds the history (before and after membership on every act).
CREATE TABLE IF NOT EXISTS knowledge_shared_writers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  account_id UUID NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  added_by UUID REFERENCES principals(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT NOT NULL,
  approval_id UUID REFERENCES approvals(id),
  expires_at TIMESTAMPTZ,
  CONSTRAINT knowledge_shared_writers_scope_check CHECK (scope = 'organisation'),
  CONSTRAINT knowledge_shared_writers_reason_length CHECK (char_length(reason) BETWEEN 20 AND 2000),
  CONSTRAINT knowledge_shared_writers_expiry_after_add CHECK (expires_at IS NULL OR expires_at > added_at),
  CONSTRAINT knowledge_shared_writers_one_row UNIQUE (source_id, scope, account_id)
);

-- The sweep's read: rows whose expiry is set.
CREATE INDEX IF NOT EXISTS idx_knowledge_shared_writers_expiry
  ON knowledge_shared_writers (expires_at) WHERE expires_at IS NOT NULL;
-- The account's own rows (youCanWrite, and a principal's deletion).
CREATE INDEX IF NOT EXISTS idx_knowledge_shared_writers_account
  ON knowledge_shared_writers (account_id);

COMMENT ON TABLE knowledge_shared_writers IS
  'Card 549cc51f (E298, E299, E310): the shared-area writer list of a knowledge source, per scope. Rows are Accounts (parentless humans). Changed only by root or an administrator login session with step-up; every change audited; delivered to the source in the signed lifecycle snapshot (shared_writers).';
COMMENT ON COLUMN knowledge_shared_writers.approval_id IS
  'NULL in this release: reserved for the universal change-request model (card e97e65ea). Nothing writes it.';
COMMENT ON COLUMN knowledge_shared_writers.expires_at IS
  'NULL = never (E298 Q5 (a)). When set, the 60-second sweep removes the row after it passes, audited as actor system.';

-- ── 2. Accounts only (E298 Q1 (a)) ──
--
-- The handler refuses a Connector, an Agent, a Group and a service identity by
-- name before anything is written; this trigger is the floor under it, so a
-- writer that skipped the handler still cannot store a row the snapshot could
-- never deliver. It writes nothing (the 094/146 member-trigger shape).
CREATE OR REPLACE FUNCTION enforce_knowledge_shared_writer_is_account() RETURNS trigger AS $$
DECLARE
  writer_kind TEXT;
  writer_parented BOOLEAN;
BEGIN
  SELECT kind, parent_principal_id IS NOT NULL
    INTO writer_kind, writer_parented
    FROM principals WHERE id = NEW.account_id;
  IF writer_kind IS NULL THEN
    RAISE EXCEPTION 'shared-area writer % names no principal', NEW.account_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF writer_kind <> 'human' THEN
    RAISE EXCEPTION 'shared-area writers are Accounts (E298 Q1 (a)): a principal of kind % is never a writer', writer_kind
      USING ERRCODE = 'check_violation';
  END IF;
  IF writer_parented THEN
    RAISE EXCEPTION 'shared-area writers are parentless Accounts (E298 Q1 (a)): a parented identity is never a writer'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_knowledge_shared_writer_is_account ON knowledge_shared_writers;
CREATE TRIGGER trg_knowledge_shared_writer_is_account
  BEFORE INSERT OR UPDATE OF account_id ON knowledge_shared_writers
  FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_shared_writer_is_account();

-- ── 3. The retry contract gains the two writer-list acts ──
--
-- `POST /knowledge-shared-writers` and `POST /knowledge-shared-writers/remove`
-- mount the shared retry middleware (middleware/idempotency.ts) as
-- `knowledge.sharedwriter.add` and `knowledge.sharedwriter.remove`,
-- CREDENTIAL-scoped (the handler decides standing from the login session and
-- burns a step-up, which the guard chain does not) with replay `return`: the
-- stored answer is the before and after membership, never a secret.
--
-- The two named CHECKs are the closed SQL binding of the declaration table;
-- they are redefined here verbatim from 147 plus 156's
-- `project.groupowned.create` (AZ-A12 build 3, card 311229fd, in the same
-- groups 156 put it: replay `return`, credential scope) plus the two
-- operations, the forward-amend precedent of 133, 138, 147 and 156. Each
-- redefinition replaces the whole CHECK, so this one must carry every
-- operation 156 added or applying 157 after 156 would drop it. DROP ... IF
-- EXISTS keeps a replay of this file a no-op.
ALTER TABLE operation_idempotency_records
  DROP CONSTRAINT IF EXISTS operation_idempotency_operation_policy;
ALTER TABLE operation_idempotency_records
  ADD CONSTRAINT operation_idempotency_operation_policy
  CHECK (
    (operation IN ('task.create', 'task.stream.append', 'task.reference.create',
                   'task.note.append', 'task.patch', 'report.create',
                   'project.create', 'project.resource.create', 'phase.create',
                   'knowledge.note.commit', 'project.groupowned.create',
                   'knowledge.sharedwriter.add', 'knowledge.sharedwriter.remove')
     AND replay_policy = 'return')
    OR
    (operation IN ('agent.mint.request', 'agent.mint.collect', 'task.report.save')
     AND replay_policy = 'refuse')
  );

ALTER TABLE operation_idempotency_records
  DROP CONSTRAINT IF EXISTS operation_idempotency_operation_scope;
ALTER TABLE operation_idempotency_records
  ADD CONSTRAINT operation_idempotency_operation_scope
  CHECK (
    (operation IN ('task.create', 'task.patch', 'task.stream.append',
                   'agent.mint.request', 'agent.mint.collect', 'phase.create', 'task.report.save',
                   'knowledge.note.commit', 'project.groupowned.create',
                   'knowledge.sharedwriter.add', 'knowledge.sharedwriter.remove')
     AND split_part(scope, ':', 1) IN ('cred', 'user'))
    OR
    (operation IN ('task.reference.create', 'task.note.append', 'report.create',
                   'project.create', 'project.resource.create')
     AND split_part(scope, ':', 1) IN ('prin', 'user'))
  );

-- ── 4. The "Shared-area writers" Access surface (E299, the F1 repair) ──
--
-- Registered the way 109 registers `settings.access-manager`: governance
-- `always-self`, so the Access-surface arm is never consulted for it and NO
-- Access bundle or profile can reach it. It is deliberately NOT `locked`:
-- a locked surface is root-only, and the ruling admits an administrator login
-- session too. The handlers decide: a root login session or an administrator
-- login session (administratorSessionOf), with a step-up on every change.
--
-- The read family is `services:read` (design section 4) and the two write
-- families are `authenticated` in the scope map, each with that in-handler
-- gate, so the boot census's clause (i) (root-gated families) does not apply
-- and clause (iii) (governable surfaces) does not either.
--
-- menu_path stays NULL on purpose: the Settings menu shows an always-self
-- surface WITH a menu path to every login session, and non-administrators must
-- see nothing. The panel lives inside the Access manager page instead, which
-- shows it to administrator sessions only.
--
-- No access_bundle_members row is written, here or anywhere: no bundle names
-- this surface. ON CONFLICT keeps a replay a no-op, and a catalogue that was
-- never seeded (109's guard) gains only this row.
INSERT INTO access_surfaces
  (key, label, governance, locked_reference, read_families, write_families, excluded_families, menu_path, origin)
VALUES
  ('settings.shared-writers', 'Shared-area writers', 'always-self', NULL,
   ARRAY['GET /knowledge-shared-writers'],
   ARRAY['POST /knowledge-shared-writers', 'POST /knowledge-shared-writers/remove'],
   '[]'::jsonb, NULL, 'core')
ON CONFLICT (key) DO NOTHING;
