-- 022_subtask_lifecycle.sql
-- Expand subtask status from 3-state (new, in_review, completed) 
-- to 6-state (empty, in_progress, review, blocked, skipped, completed)
-- 
-- Status meanings:
--   empty       - Not started (was: new)
--   in_progress - Agent is working on it
--   review      - Awaiting orchestrator review (was: in_review)  
--   blocked     - Cannot proceed, needs intervention
--   skipped     - Intentionally skipped (counts as "done")
--   completed   - Approved by orchestrator
--
-- Permission model:
--   Agent (CLAWBOARD_AGENT=1):
--     - CAN set: in_progress, review
--     - CANNOT set: completed, skipped, blocked, empty
--   Orchestrator (default):
--     - CAN set: any status

-- Step 1: Drop the old check constraint
ALTER TABLE subtasks DROP CONSTRAINT IF EXISTS subtasks_status_check;

-- Step 2: Add new check constraint with expanded statuses
ALTER TABLE subtasks ADD CONSTRAINT subtasks_status_check 
  CHECK (status IN ('empty', 'in_progress', 'review', 'blocked', 'skipped', 'completed'));

-- Step 3: Migrate existing data
-- 'new' → 'empty'
UPDATE subtasks SET status = 'empty' WHERE status = 'new';
-- 'in_review' → 'review'  
UPDATE subtasks SET status = 'review' WHERE status = 'in_review';

-- Step 4: Add blocked_reason column for subtask-level blocking notes
ALTER TABLE subtasks ADD COLUMN IF NOT EXISTS blocked_reason TEXT;

-- Step 5: Update default value
ALTER TABLE subtasks ALTER COLUMN status SET DEFAULT 'empty';

-- Done! The subtask lifecycle is now:
-- Agent workflow:   empty → in_progress → review → (orchestrator approves) → completed
-- Orchestrator can: set any status, including blocked/skipped
