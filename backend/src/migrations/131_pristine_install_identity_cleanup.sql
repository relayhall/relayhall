-- Remove historical installation placeholders only before an installation
-- has acquired any user data, credentials, or operational history. Historical
-- migrations stay immutable. Established installations keep their identities,
-- grants and remediation records; disabled/hidden alone never proves unused.
DO $$
DECLARE
  relation RECORD;
  referenced BOOLEAN;
  reader_id UUID;
  owner_id UUID;
  retired_ids UUID[];
BEGIN
  -- The reserved request-less actor is not an Account awaiting owner review.
  -- Do not relabel a credentialled or legacy-shaped actor on an upgrade.
  UPDATE principals p SET purpose = 'Request-less RelayHall internal automation'
   WHERE p.handle = 'system' AND p.kind = 'service'
     AND p.parent_principal_id IS NULL AND NOT p.legacy_identity
     AND p.metadata @> '{"internal":true,"no_credentials":true}'::jsonb
     AND p.purpose = 'LEGACY - pending owner review'
     AND NOT EXISTS (SELECT 1 FROM principal_credentials c WHERE c.principal_id = p.id);

  IF EXISTS (SELECT 1 FROM principals WHERE handle NOT IN (
    'dashboard_user', 'system', 'service_account', 'journal_publisher',
    'reports_reader', 'hermes_task_agent', 'clawbeat_qa', 'clawbeat_reviewer',
    'hermes_qa', 'hermes_qa_reviewer')) THEN RETURN; END IF;

  -- These are the only tables populated by the shipped seed chain. Scan all
  -- other public tables, including non-FK actor-handle history, rather than
  -- maintaining an incomplete list of activities that might reference actors.
  -- Unknown future tables fail closed: a nonempty one preserves the records.
  FOR relation IN
    SELECT schemaname, tablename FROM pg_tables WHERE schemaname = 'public'
      AND tablename <> ALL (ARRAY[
        'schema_migrations','principals','resource_grants','grants',
        'bot_status','personalities','personality_versions','skills',
        'skill_versions','skill_version_events','relayhall_installation',
        'services','service_descriptor_versions','access_surfaces',
        'access_profiles','access_profile_versions','access_profile_rules',
        'access_profile_events','access_bundles','access_bundle_members'])
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I)', relation.schemaname, relation.tablename)
      INTO referenced;
    IF referenced THEN RETURN; END IF;
  END LOOP;

  IF (SELECT count(*) FROM bot_status) > 1
    OR EXISTS (SELECT 1 FROM bot_status WHERE (
      mood = 'neutral' AND status_text = 'Ready for work' AND avatar_url IS NULL
      AND author = 'system' AND author_harness = 'unknown' AND run_type = 'legacy'
      AND source_receipts = '[]'::jsonb AND idempotency_key IS NULL
      AND cadence_window_start IS NULL AND cadence_window_end IS NULL
      AND scheduler_tick_id IS NULL AND failure IS NULL) IS NOT TRUE)
    OR EXISTS (SELECT 1 FROM access_profile_events WHERE actor_handle IS DISTINCT FROM 'system'
      OR metadata->>'migration' IS DISTINCT FROM '109' OR actor_principal_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM services WHERE slug <> 'board'
      OR created_by_principal_id IS NOT NULL OR updated_by_principal_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM service_descriptor_versions WHERE created_by_principal_id IS NOT NULL)
  THEN RETURN; END IF;

  SELECT array_agg(id) INTO retired_ids FROM principals
   WHERE handle IN ('service_account','journal_publisher','reports_reader',
     'hermes_task_agent','clawbeat_qa','clawbeat_reviewer','hermes_qa','hermes_qa_reviewer')
     AND status = 'disabled' AND last_seen_at IS NULL
     AND parent_principal_id IS NULL AND source_tag IS NULL
     AND bound_task_id IS NULL AND personality_id IS NULL
     AND legacy_identity = (kind = 'agent')
     AND purpose IS NOT DISTINCT FROM CASE WHEN kind = 'service' THEN 'LEGACY - pending owner review' END
     AND own_expression IS NULL AND terminated_at IS NULL
     AND metadata = '{"compatibility":true,"hidden_until_configured":true}'::jsonb;
  IF EXISTS (
    SELECT 1 FROM principals p JOIN (VALUES
  ('service', 'service_account',    'Legacy shared API key',                      'agent',        NULL),
  ('service', 'journal_publisher',  'Journal publish pipeline',                   NULL,           NULL),
  ('service', 'reports_reader',     'Knowledge-fabric reports reader',            NULL,           NULL),
  ('agent',   'hermes_task_agent',  'Hermes spawned task agents (legacy shared)', 'agent',        'hermes'),
  ('agent',   'clawbeat_qa',        'Clawbeat QA',                                'qa',           'openclaw'),
  ('agent',   'clawbeat_reviewer',  'Clawbeat reviewer',                          'reviewer',     'openclaw'),
  ('agent',   'hermes_qa',          'Hermes QA',                                  'qa',           'hermes'),
  ('agent',   'hermes_qa_reviewer', 'Hermes QA reviewer',                         'reviewer',     'hermes')
    ) AS seed(kind, handle, display_name, role, harness) ON seed.handle = p.handle
    WHERE p.id = ANY(retired_ids) AND (
      p.kind IS DISTINCT FROM seed.kind OR p.display_name IS DISTINCT FROM seed.display_name
      OR p.role IS DISTINCT FROM seed.role OR p.harness IS DISTINCT FROM seed.harness))
  THEN RETURN; END IF;
  -- All eight must still be untouched placeholders. Partial matches preserve
  -- the entire installation, including its pre-grants.
  IF cardinality(retired_ids) IS DISTINCT FROM 8 THEN RETURN; END IF;
  SELECT id INTO reader_id FROM principals WHERE handle = 'reports_reader';
  SELECT id INTO owner_id FROM principals WHERE handle = 'dashboard_user';

  -- Only the exact 064/078 report-reader pre-grants may be discarded. Any
  -- additional authority is evidence of configuration, including polymorphic
  -- grantee references which intentionally have no database foreign key.
  IF (SELECT count(*) FROM resource_grants) <> 1
    OR (SELECT count(*) FROM grants) <> 1
    OR EXISTS (SELECT 1 FROM resource_grants WHERE (
      resource_type = 'report' AND resource_id = '*' AND permission = 'read'
      AND grantee_principal_id = reader_id AND granted_by_principal_id = owner_id
      AND expires_at IS NULL) IS NOT TRUE)
    OR EXISTS (SELECT 1 FROM grants WHERE (
      grantee_type = 'principal' AND grantee_id = reader_id
      AND resource_type = 'report' AND resource_id IS NULL AND verb = 'read'
      AND granted_by_principal_id = owner_id AND expires_at IS NULL AND provenance IS NULL) IS NOT TRUE)
  THEN RETURN; END IF;

  -- Also protect references from seed-capable tables (including CASCADE and
  -- SET NULL FKs), not merely references that would make DELETE fail.
  FOR relation IN
    SELECT n.nspname, t.relname, a.attname
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
     WHERE c.contype = 'f' AND c.confrelid = 'public.principals'::regclass
       AND c.conrelid <> 'public.resource_grants'::regclass
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE %I = ANY($1))',
      relation.nspname, relation.relname, relation.attname) INTO referenced USING retired_ids;
    IF referenced THEN RETURN; END IF;
  END LOOP;

  DELETE FROM grants WHERE grantee_type = 'principal' AND grantee_id = reader_id
    AND resource_type = 'report' AND resource_id IS NULL AND verb = 'read'
    AND granted_by_principal_id = owner_id AND expires_at IS NULL AND provenance IS NULL;
  DELETE FROM resource_grants WHERE grantee_principal_id = reader_id
    AND resource_type = 'report' AND resource_id = '*' AND permission = 'read'
    AND granted_by_principal_id = owner_id AND expires_at IS NULL;
  DELETE FROM principals WHERE id = ANY(retired_ids);
  -- The retired status-voice singleton is also a seed, not user content.
  -- The pristine-value guard above protects every modified status row.
  DELETE FROM bot_status;
END $$;
