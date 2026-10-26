-- Flat Tasks have a real Task-level review attempt, not a synthetic subtask.
-- Keep v0 legacy and v1 reviewed-subtask meanings unchanged; v2 is a
-- singleton, content-bound Task-level evidence marker.
CREATE OR REPLACE FUNCTION task_review_slice_matches_version(slice_version SMALLINT, slice JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN jsonb_typeof(slice) <> 'array' OR jsonb_array_length(slice) = 0 THEN FALSE
    WHEN slice_version = 0 THEN COALESCE(bool_and(
      item ?& ARRAY['kind','attempt_id','task_id','attempt_no','task_snapshot_updated_at']
      AND item->>'kind' = 'legacy_review_attempt'
    ), FALSE)
    WHEN slice_version = 1 THEN COALESCE(bool_and(
      item ?& ARRAY['subtaskId','index','title','status','updatedAt','evidenceReceipt']
      AND jsonb_typeof(item->'index') = 'number'
    ), FALSE)
    WHEN slice_version = 2 THEN jsonb_array_length(slice) = 1 AND COALESCE(bool_and(
      item ?& ARRAY['kind','taskId','taskSnapshotUpdatedAt','evidenceReceipt','reportDigest']
      AND item->>'kind' = 'flat_task_review'
      AND (item->>'evidenceReceipt') ~ '^[0-9a-f]{64}$'
      AND (item->>'reportDigest') ~ '^[0-9a-f]{64}$'
    ), FALSE)
    ELSE FALSE
  END
  FROM jsonb_array_elements(slice) AS elements(item)
$$;

ALTER TABLE task_review_attempts
  DROP CONSTRAINT IF EXISTS task_review_attempts_review_slice_version_check;
ALTER TABLE task_review_attempts
  ADD CONSTRAINT task_review_attempts_review_slice_version_check
    CHECK (review_slice_version IN (0, 1, 2)) NOT VALID;
ALTER TABLE task_review_attempts
  DROP CONSTRAINT IF EXISTS task_review_attempts_review_slice_version_supported;
ALTER TABLE task_review_attempts
  ADD CONSTRAINT task_review_attempts_review_slice_version_supported
    CHECK (review_slice_version IN (0, 1, 2)) NOT VALID;
ALTER TABLE task_review_attempts
  VALIDATE CONSTRAINT task_review_attempts_review_slice_version_check,
  VALIDATE CONSTRAINT task_review_attempts_review_slice_version_supported,
  VALIDATE CONSTRAINT task_review_attempts_review_slice_schema;

COMMENT ON COLUMN task_review_attempts.review_slice_version IS
  'Review-slice schema identity: v0 legacy marker, v1 reviewed subtasks, v2 singleton flat-Task evidence marker.';

-- A Report may link a Task through an array, without a foreign key or Task
-- touch. Shared no-wait locks let independent Report writers proceed while an
-- exclusive verdict conflicts with all digest-affecting Report writes.
-- Report writers already hold Report or Task row locks;
-- never wait for another Task row here or introduce a row-lock cycle.
CREATE OR REPLACE FUNCTION lock_linked_tasks_for_report_review()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_ids UUID[];
  linked_id UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    linked_ids := COALESCE(NEW.task_ids, '{}'::UUID[]);
  ELSIF TG_OP = 'DELETE' THEN
    linked_ids := COALESCE(OLD.task_ids, '{}'::UUID[]);
  ELSE
    linked_ids := COALESCE(OLD.task_ids, '{}'::UUID[]) || COALESCE(NEW.task_ids, '{}'::UUID[]);
  END IF;

  FOR linked_id IN SELECT DISTINCT unnest(linked_ids) ORDER BY 1 LOOP
    IF NOT pg_try_advisory_xact_lock_shared(1397653301, hashtext(linked_id::text)) THEN
      RAISE EXCEPTION 'Flat Task review evidence is busy' USING ERRCODE = 'PZ001';
    END IF;
  END LOOP;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lock_linked_tasks_for_report_review ON reports;
CREATE TRIGGER lock_linked_tasks_for_report_review
  BEFORE INSERT OR UPDATE OF title, summary, content, task_ids, deleted_at OR DELETE
  ON reports FOR EACH ROW EXECUTE FUNCTION lock_linked_tasks_for_report_review();
