-- Add Phase creation to the immutable retry operation set. Migration 110 is
-- already deployed; amend its named constraints forward without changing it.
-- The operation returns its first receipt and binds it to the credential.

ALTER TABLE operation_idempotency_records
  DROP CONSTRAINT operation_idempotency_operation_policy;
ALTER TABLE operation_idempotency_records
  ADD CONSTRAINT operation_idempotency_operation_policy
  CHECK (
    (operation IN ('task.create', 'task.stream.append', 'task.reference.create',
                   'task.note.append', 'task.patch', 'report.create',
                   'project.create', 'project.resource.create', 'phase.create')
     AND replay_policy = 'return')
    OR
    (operation IN ('agent.mint.request', 'agent.mint.collect')
     AND replay_policy = 'refuse')
  );

ALTER TABLE operation_idempotency_records
  DROP CONSTRAINT operation_idempotency_operation_scope;
ALTER TABLE operation_idempotency_records
  ADD CONSTRAINT operation_idempotency_operation_scope
  CHECK (
    (operation IN ('task.create', 'task.patch', 'task.stream.append',
                   'agent.mint.request', 'agent.mint.collect', 'phase.create')
     AND split_part(scope, ':', 1) IN ('cred', 'user'))
    OR
    (operation IN ('task.reference.create', 'task.note.append', 'report.create',
                   'project.create', 'project.resource.create')
     AND split_part(scope, ':', 1) IN ('prin', 'user'))
  );
