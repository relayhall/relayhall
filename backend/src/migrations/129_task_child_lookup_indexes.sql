-- 129_task_child_lookup_indexes.sql — card 590e88cc
--
-- TWO INDEXES THE BASELINE LOST.
--
-- `database/migrations/020_tasks_redesign.sql` created both of these when it
-- created the tables:
--
--     CREATE INDEX idx_task_links_task_id ON task_links(task_id);
--     CREATE INDEX idx_task_dependencies_depends_on ON task_dependencies(depends_on_task_id);
--
-- Neither survived into `database/init.sql`, the baseline every fresh install
-- and every CI run loads. What init.sql carries for those two tables is
-- `task_links_pkey` on `id` alone and `task_dependencies_pkey` on
-- `(task_id, depends_on_task_id)` — and a composite primary key cannot serve a
-- lookup on its SECOND column. So on a fresh estate:
--
--   * `hydrateTasks`'s  `... FROM task_links WHERE task_id = ANY($1::uuid[])`
--     is a sequential scan of the whole link table, on EVERY Task read;
--   * `getDependentTasks`'s `... WHERE depends_on_task_id = $1` is a
--     sequential scan of the whole dependency table.
--
-- Measured on the 5,200-Task fixture before this migration: the task_links
-- lookup plans as `Seq Scan ... Rows Removed by Filter: 5184`, 71 shared
-- buffers, ~1.7ms — per call, and the read paths make that call once per
-- hydrated row set.
--
-- The names are 020's names on purpose. A database that DID run 020 before the
-- baseline was cut already holds both, and `IF NOT EXISTS` then makes this file
-- a no-op there rather than a duplicate under a second name. That is what makes
-- it a repair of the drift rather than another copy of it.
--
-- Idempotent: re-running changes nothing.

CREATE INDEX IF NOT EXISTS idx_task_links_task_id
    ON public.task_links (task_id);

CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on
    ON public.task_dependencies (depends_on_task_id);

COMMENT ON INDEX public.idx_task_links_task_id IS
    'Card 590e88cc: hydrateTasks reads task_links by task_id on every Task read; without this the read is a sequential scan. Present in migration 020, absent from the init.sql baseline.';

COMMENT ON INDEX public.idx_task_dependencies_depends_on IS
    'Card 590e88cc: the dependents direction of the dependency read filters on depends_on_task_id, which the composite primary key cannot serve. Present in migration 020, absent from the init.sql baseline.';
