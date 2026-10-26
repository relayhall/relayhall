-- 164_subtask_structure_retry.sql — the MCP Subtask structure verbs (card
-- 2bc7b303, owner ruling E374). Reserved in backend/src/migrations/RESERVED in
-- the same commit (ruling 0464ad54 section 2); 162 and 163 are held there for
-- the parallel lanes that claimed them.
--
-- One change, one implicit transaction, no COMMIT, replay-safe: re-running this
-- file against a database that already has it changes nothing. No table, row
-- or column changes: Subtasks keep living in `subtasks`, and a new Subtask's
-- stable id comes from its existing id sequence.
--
-- ── The retry contract gains the three Subtask structure acts ──
--
-- `POST /tasks/:id/subtasks` (create), `POST /tasks/:id/subtasks/reorder` and
-- `PATCH /tasks/:id/subtasks/by-id/:subtaskId/text` mount the shared retry
-- middleware (middleware/idempotency.ts) as `task.subtask.create`,
-- `task.subtask.reorder` and `task.subtask.text`, CREDENTIAL-scoped by ruling
-- 3's default for an operation added after the closed set, with replay
-- `return`: the stored answer is the Task with its Subtasks and, for a create,
-- the new Subtask's stable id.
--
-- The two named CHECKs are the closed SQL binding of the declaration table;
-- they are redefined here verbatim from 157 plus the three operations, the
-- forward-amend precedent of 133, 138, 147, 156 and 157. Each redefinition
-- replaces the whole CHECK, so this one carries every operation 157 holds.
-- The operations are new, so no existing row is affected. DROP ... IF EXISTS
-- keeps a replay of this file a no-op.
ALTER TABLE operation_idempotency_records
  DROP CONSTRAINT IF EXISTS operation_idempotency_operation_policy;
ALTER TABLE operation_idempotency_records
  ADD CONSTRAINT operation_idempotency_operation_policy
  CHECK (
    (operation IN ('task.create', 'task.stream.append', 'task.reference.create',
                   'task.note.append', 'task.patch', 'report.create',
                   'project.create', 'project.resource.create', 'phase.create',
                   'knowledge.note.commit', 'project.groupowned.create',
                   'knowledge.sharedwriter.add', 'knowledge.sharedwriter.remove',
                   'task.subtask.create', 'task.subtask.reorder', 'task.subtask.text')
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
                   'knowledge.sharedwriter.add', 'knowledge.sharedwriter.remove',
                   'task.subtask.create', 'task.subtask.reorder', 'task.subtask.text')
     AND split_part(scope, ':', 1) IN ('cred', 'user'))
    OR
    (operation IN ('task.reference.create', 'task.note.append', 'report.create',
                   'project.create', 'project.resource.create')
     AND split_part(scope, ':', 1) IN ('prin', 'user'))
  );
