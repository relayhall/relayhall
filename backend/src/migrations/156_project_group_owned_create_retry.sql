-- 156_project_group_owned_create_retry.sql — AZ-A12 build 3, the Group
-- ownership transfer act (card 311229fd; amendment AZ-A12 clause 10(b),
-- ratified 2026-10-10, ruling E72). Reserved in backend/src/migrations/RESERVED
-- in the same commit (ruling 0464ad54 section 2).
--
-- One change, one implicit transaction, no COMMIT, replay-safe: re-running this
-- file against a database that already has it changes nothing.
--
-- ── The retry contract gains `project.groupowned.create` ──
--
-- `POST /projects` carrying the three clause 10(b) Group owner keys of the
-- create form's selector reads the caller's session and credential: the
-- clause 9(e) standing test and the step-up bound to them. It is therefore its
-- OWN retry operation, credential-scoped by ruling 3's default and replay
-- `return` (the stored answer is the created Project, exactly as
-- `project.create` stores it). Under `project.create`'s principal scope a
-- second credential of the same principal would be served the stored
-- Group-owned create without meeting the standing test itself. The plain
-- create keeps `project.create` in the principal group, unchanged.
--
-- 147's two named CHECKs are the closed SQL binding of the declaration table
-- (middleware/idempotency.ts); they are redefined here verbatim plus the new
-- operation, the forward-amend precedent of 133, 138 and 147. The operation is
-- new, so no existing row is affected. DROP ... IF EXISTS keeps a replay of
-- this file a no-op.
ALTER TABLE operation_idempotency_records
  DROP CONSTRAINT IF EXISTS operation_idempotency_operation_policy;
ALTER TABLE operation_idempotency_records
  ADD CONSTRAINT operation_idempotency_operation_policy
  CHECK (
    (operation IN ('task.create', 'task.stream.append', 'task.reference.create',
                   'task.note.append', 'task.patch', 'report.create',
                   'project.create', 'project.resource.create', 'phase.create',
                   'knowledge.note.commit', 'project.groupowned.create')
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
                   'knowledge.note.commit', 'project.groupowned.create')
     AND split_part(scope, ':', 1) IN ('cred', 'user'))
    OR
    (operation IN ('task.reference.create', 'task.note.append', 'report.create',
                   'project.create', 'project.resource.create')
     AND split_part(scope, ':', 1) IN ('prin', 'user'))
  );
