# RelayHall database operations

RelayHall uses PostgreSQL 16. The shipped Compose stack owns the database
lifecycle; core clients do not read or write database files directly.

## Schema sources

- `init.sql` is the authoritative fresh-install baseline.
- `backend/src/migrations/BASELINE` lists immutable migrations represented by
  that baseline.
- `backend/src/migrations/RETIRED` lists preserved history that is accounted for
  but not executed in the extracted core.
- Active forward migrations live under `backend/src/migrations/`.

Backend container startup runs the migration command with `&&` before starting
the API. A migration failure therefore prevents the listener from opening.
Historical migration files are immutable. Every schema change needs a new
forward migration and the equivalent final shape in `init.sql`.

## First installation

Follow [the getting-started guide](../docs/getting-started.md):

```bash
docker compose up -d --build --wait
docker compose ps
curl --fail http://localhost:8082/api/health
```

PostgreSQL loads `init.sql` only when its data volume is empty. The backend then
stamps baseline/retired history and executes active migrations.

## Backup

From the repository root:

```bash
./database/backup.sh
```

The helper:

- addresses the current Compose project's `relayhall-db` service;
- creates `./backups` with mode `0700`;
- writes a temporary mode-`0600` gzip stream;
- validates gzip integrity and atomically renames it to
  `relayhall_YYYYMMDD_HHMMSS.sql.gz` only after `pg_dump` succeeds;
- removes partial output on any failure;
- retains the newest `KEEP_BACKUPS` successful dumps.

Configuration is read without sourcing `.env` as shell code:

```dotenv
BACKUP_DIR=./backups
KEEP_BACKUPS=7
```

A database volume is not a backup. Copy production dumps to separate durable
storage and monitor backup freshness.

## Restore

Name a dump explicitly:

```bash
./database/restore.sh ./backups/relayhall_YYYYMMDD_HHMMSS.sql.gz
```

Or run without an argument for an interactive numbered menu:

```bash
./database/restore.sh
```

The helper validates the selected gzip stream, creates an atomically published
mode-`0600` safety dump, stops the backend, restores with `psql ON_ERROR_STOP`,
and restarts the backend. If restore fails, it applies the safety dump before
returning failure.

For an intentionally non-interactive disposable recovery drill:

```bash
./database/restore.sh --yes ./backups/relayhall_YYYYMMDD_HHMMSS.sql.gz
```

Test this process on a disposable stack. Do not make the first restore attempt
during an incident.

## Manual access

Use the current Compose project rather than a global container name:

```bash
docker compose exec relayhall-db psql -U relayhall -d relayhall
docker compose exec -T relayhall-db \
  psql -U relayhall -d relayhall -c 'SELECT COUNT(*) FROM tasks;'
docker compose exec -T relayhall-db \
  pg_dump -U relayhall -d relayhall --schema-only > schema.sql
```

The database and role may differ if `POSTGRES_DB` or `POSTGRES_USER` were changed
in `.env`.

## Upgrade

Before changing images or code:

```bash
./database/backup.sh
docker compose build --pull
docker compose up -d --wait
curl --fail http://localhost:8082/api/health
```

Migrations are forward-only. Starting an older image against a newer schema is
unsupported unless release-specific recovery notes explicitly allow it.

## Developing a migration

1. Add the next numbered SQL file under `backend/src/migrations/`.
2. Make it safe for the supported source schema and fail on unexpected state.
3. Update `database/init.sql` to the same final schema for fresh installs.
4. Extend `backend/src/__tests__/migrationChain.test.ts` or focused migration
   coverage.
5. Test both an empty-volume install and upgrade from the previous release.
6. Never edit an already published historical migration.

## Disposable database reset

This permanently removes the current Compose project's PostgreSQL volume:

```bash
docker compose down --volumes
docker compose up -d --build --wait
```

Run it only on a disposable installation or after a verified backup.

## Troubleshooting

### Backend fails before listening

```bash
docker compose logs --tail=200 relayhall-backend
docker compose logs --tail=100 relayhall-db
```

Migration and database-authentication errors appear before the API opens.

### Backup helper says the database is not running

```bash
docker compose ps
docker compose up -d relayhall-db
```

Run scripts from the same repository and Compose project as the target stack.

### Restore input is rejected

Confirm the path exists and that `gzip -t <file>` succeeds. A failed backup is
never published under the selectable `relayhall_*.sql.gz` pattern.
