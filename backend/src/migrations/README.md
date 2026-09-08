# RelayHall migrations — the truthful story (task 475a54c9)

## How migrations work now

1. **`database/init.sql` is the authoritative fresh-install baseline.** It is a
   cleaned `pg_dump --schema-only` of the real schema **through migration 042**
   (plus the preserved seed-data section). Fresh installs apply it first.
2. **`BASELINE`** (in this directory) lists every migration file that is already
   contained in that baseline (006 → 042).
   **`RETIRED`** lists immutable post-baseline migrations for extracted plugin
   subsystems. They remain on disk for history but are stamped rather than run.
3. **`src/db/migrate.ts`** stamps every `BASELINE`-listed file into
   `schema_migrations` **without executing it**:
   - on a fresh DB (after init.sql) it stamps BASELINE and RETIRED entries, then
     applies only active post-baseline files (043+);
   - on an existing DB it stamps any baseline entry missing from the ledger.
     This repairs ledgers where migrations were applied out-of-band (prod's
     ledger claimed 026+ never ran; they did). Baseline files are **never**
     re-executed.
   - Safety: stamping refuses to run if the `tasks` table is absent — that
     means init.sql was never applied.
4. **New migrations start at 043** and are executed normally. (043 is reserved
   as of 2026-07-04.)
5. **Boot check:** `runStartupChecks()` (called from `server.ts`) compares the
   ledger against this directory and `to_regclass`-checks critical tables
   (`tasks`, `sessions`, `task_timeline_events`, `schema_migrations`). Drift
   logs a loud warning; it never crashes the server.

## Historical quirks (do NOT "fix" by renumbering)

- **001–005 never existed.** The chain starts at 006; the base schema always
  came from `database/init.sql` (originally consolidated from legacy
  `database/migrations/004`–`010`).
- **018–022 are missing here.** They live in the legacy `database/migrations/`
  directory (020_tasks_redesign, 021_sessions_table, 022_subtask_lifecycle,
  plus Python data scripts) and were applied **out-of-band** — `migrate.ts`
  never read that directory. The legacy sessions/session_messages tables that
  026/027/029/030 reference came from that chain. Kept for archaeology only.
- **038 is a gap.** `038_task_reviewer_fields.sql` / `038_tasks_review_status.sql`
  existed at some point (they appear in old ledgers) but were renamed/absorbed;
  no file with prefix 038 exists today. Do not reuse the number.
- **035 is duplicated**: `035_cleanup_empty_run_sessions.sql` and
  `035_task_execution_profile.sql` are two different migrations sharing a
  number. Both ran, both are in BASELINE, both stay. Filenames (not numbers)
  are the ledger key, so this is safe — just ugly.
- **Ledger phantoms**: dev/prod ledgers contain entries for renamed or deleted
  files (e.g. `036_task_reviewer.sql`, `037_subtask_blocked_reason.sql`,
  `038_tasks_review_status.sql`). Harmless; the boot check reports them as
  drift warnings for visibility.

## Repairs made for from-scratch replay (archaeology)

These files were broken when replayed on a fresh PG16 database and were fixed
**in place** (they are baseline-stamped in normal operation, never executed):

- **015** — `ADD CONSTRAINT ... UNIQUE` collided with init.sql's final shape;
  now guarded by a `pg_constraint` existence check.
- **026, 029, 030** — referenced the legacy `sessions`/`session_messages`
  tables that a from-scratch replay doesn't have until 033; now wrapped in
  conditional DO blocks that no-op when the targets are absent. 030 also lost
  its explicit `BEGIN/COMMIT` (each migration file already runs as one
  implicit transaction; `COMMIT` is illegal inside a DO block).
- **027** — used `MIN(uuid)`, which PostgreSQL has no aggregate for; replaced
  with `(ARRAY_AGG(id ORDER BY created_at, id))[1]` and guarded like 026.

## Rules going forward

- Never renumber or delete existing migration files. Extracted-subsystem
  migrations move to `RETIRED`; they do not disappear.
- Never edit a `BASELINE`-listed file's *behavior* expecting it to run — it
  won't. Schema changes go in a new 043+ file.
- When cutting a new baseline: regenerate `database/init.sql` from the live
  schema (`pg_dump --schema-only --no-owner --no-privileges`, strip
  `\restrict`/`\unrestrict`, the `set_config('search_path', ...)` line and
  extension comments, keep the seed-data section) and append the absorbed
  filenames to `BASELINE`.
- CI exists: identical workflows at `.github/workflows/ci.yml` and
  `.gitea/workflows/ci.yml` run the backend jest suite (`npx jest
  --runInBand`), which includes the migration-chain tests
  (`backend/src/__tests__/migrationChain.test.ts`). Still run the full
  replay check locally before merging schema changes: apply
  `database/init.sql` to a fresh postgres:16, run `npm run migrate`, and
  spot-check critical tables. If your migration breaks that, fix the
  migration.

## Running migrations — which command where

- **Normal operation: none.** The backend runs every pending migration
  automatically at startup; a fresh `docker compose up` reaches the current
  ledger tip on its own.
- **Inside the production container** (manual re-run or troubleshooting):
  `node dist/db/migrate.js`. The image ships compiled output only —
  `npm run migrate` does NOT work there (`ts-node` is a devDependency and
  `src/` is not in the image).
- **From a source checkout** (development): install dependencies first, then
  run the source runner with your database settings:

  ```bash
  cd backend && npm ci
  DB_HOST=localhost DB_PORT=5433 DB_NAME=relayhall DB_USER=relayhall \
    DB_PASSWORD=yourpassword npm run migrate
  ```
