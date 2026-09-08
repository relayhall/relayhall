-- 065_clean_install_registries.sql
-- Make fresh RelayHall installs self-contained and remove estate-specific
-- identities from the default directory without destroying historical rows.

ALTER TABLE agent_types DROP CONSTRAINT IF EXISTS agent_types_source_check;
ALTER TABLE agent_types ADD CONSTRAINT agent_types_source_check
  CHECK (source IN ('built-in', 'managed', 'git', 'legacy-db'));

INSERT INTO agent_types
  (slug, name, description, category, color, content, source_file, is_custom, source)
VALUES
  ('generalist', 'Generalist', 'A balanced default for ordinary work items.', 'core', 'blue',
   E'# Generalist\n\nHandle ordinary work carefully, ask when requirements are genuinely ambiguous, and leave verifiable evidence.', NULL, false, 'built-in'),
  ('planner', 'Planner', 'Turns goals into bounded plans, dependencies, and acceptance criteria.', 'core', 'violet',
   E'# Planner\n\nClarify outcomes, identify dependencies and risks, and produce an executable plan with acceptance criteria.', NULL, false, 'built-in'),
  ('implementer', 'Implementer', 'Builds and tests changes against an agreed plan.', 'core', 'green',
   E'# Implementer\n\nImplement the requested change, preserve compatibility, test the result, and report concrete evidence.', NULL, false, 'built-in'),
  ('reviewer', 'Reviewer', 'Independently challenges correctness, security, and product contracts.', 'core', 'amber',
   E'# Reviewer\n\nReview independently. Seek counterexamples, security failures, regressions, and unsupported claims before issuing a verdict.', NULL, false, 'built-in'),
  ('researcher', 'Researcher', 'Collects evidence and distinguishes facts, assumptions, and open questions.', 'core', 'cyan',
   E'# Researcher\n\nUse primary sources, cite evidence, distinguish observation from inference, and state unresolved uncertainty.', NULL, false, 'built-in')
ON CONFLICT (slug) DO NOTHING;

-- Migration 062 preserved exact private-estate identity strings to make its
-- attribution rollout safe. They are compatibility rows, not configured actors
-- on a new RelayHall installation. Keep them for foreign-key/history safety but
-- hide and disable them until a matching integration explicitly activates one.
UPDATE principals
   SET status = 'disabled',
       metadata = metadata || '{"compatibility":true,"hidden_until_configured":true}'::jsonb,
       updated_at = now()
 WHERE handle IN (
   'service_account', 'journal_publisher', 'reports_reader',
   'hermes_task_agent', 'clawbeat_qa', 'clawbeat_reviewer',
   'hermes_qa', 'hermes_qa_reviewer'
 );

UPDATE principals
   SET display_name = 'RelayHall internal automation',
       metadata = metadata || '{"internal":true}'::jsonb,
       updated_at = now()
 WHERE handle = 'system';

UPDATE principals
   SET metadata = metadata || '{"bootstrap":true}'::jsonb,
       updated_at = now()
 WHERE handle = 'dashboard_user';

UPDATE tools SET
  description = CASE name
    WHEN 'task-management' THEN 'Manage work items through the RelayHall API or CLI.'
    WHEN 'api-access' THEN 'Drive RelayHall through its authenticated REST and OpenAPI surfaces.'
    WHEN 'tool-management' THEN 'Manage the RelayHall tools registry.'
    ELSE description END,
  usage_instructions = replace(replace(usage_instructions, '`clawboard ', '`relayhall '), 'ClawBoard', 'RelayHall'),
  updated_at = now()
WHERE name IN ('task-management', 'project-management', 'api-access', 'tool-management');
