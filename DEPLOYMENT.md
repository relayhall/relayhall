# RelayHall deployment guide

This guide covers the shipped single-host Compose stack. Deployment-specific
DNS, TLS, SSO, monitoring, secret delivery, and plugin services belong in an
overlay or the surrounding infrastructure—not in the RelayHall core repository.

> If a checkout is managed by a release wrapper, use that wrapper rather than
> running Compose manually. Preserve its exact-candidate and rollback controls.

## Shipped stack

`docker-compose.yml` contains:

| Service | Purpose | Default host binding |
|---|---|---|
| `relayhall-db` | PostgreSQL 16 persistent store | `127.0.0.1:5433` |
| `relayhall-backend` | REST/OpenAPI, WebSocket, migrations | `127.0.0.1:3001` |
| `relayhall-frontend` | Static UI and same-origin API/WS proxy | `127.0.0.1:8082` |

The Compose project, service, network, and volume identifiers are all
RelayHall-native as of the estate vocabulary purge (amendment A13).

The stack includes health checks, project-scoped networks and volumes,
fail-closed forward migrations, and a frontend that waits for a healthy backend.
It does not include an ingress, certificate manager, model gateway, harness,
artifact store, knowledge system, or optional plugin.

## First deployment

Follow [docs/getting-started.md](docs/getting-started.md). The complete path is:

```bash
./setup.sh
docker compose config --quiet
docker compose up -d --build --wait
docker compose ps
curl --fail http://localhost:8082/health
curl --fail http://localhost:8082/api/health
```

Before creating the first administrator, use the browser on the Docker host at
`http://localhost:8082/dashboard/`, or configure the HTTPS ingress described
below. A plain HTTP LAN address or hostname can serve health checks while
Account sign-in fails: browsers do not retain the required Secure session cookie
there. Configure TLS and the exact HTTPS `CORS_ORIGIN` before remote first-run
setup; use that same HTTPS origin for subsequent sign-ins.

If an Account was already created over a plain HTTP LAN origin, preserve it.
Complete the HTTPS setup and sign in with the Account name and password you
already chose. Do not rerun first-run setup or reset the database to recover
the session.

## Configuration

Important `.env` settings:

| Variable | Meaning | Default |
|---|---|---|
| `POSTGRES_DB` | Database name | `relayhall` |
| `POSTGRES_USER` | Database role | `relayhall` |
| `POSTGRES_PASSWORD` | Required database password | none |
| `JWT_SECRET` | Required signing secret | none |
| `DASHBOARD_PASSWORD_HASH` | Required bcrypt login hash | none |
| `TOKEN_EXPIRY` | Human session lifetime | `30d` |
| `RELAYHALL_SESSIONS` | Named Account login and first-administrator setup; `off` deliberately disables both | `on` |
| `POSTGRES_HOST_PORT` | Loopback database host port | `5433` |
| `BACKEND_PORT` | Loopback backend host port | `3001` |
| `FRONTEND_PORT` | Loopback frontend host port | `8082` |
| `CORS_ORIGIN` | Allowed browser origin | `http://localhost:8082` |
| `DATA_DIR` | Core-owned bind-mounted data | `./data` |
| `VITE_API_BASE_URL` | Browser API base | `/api` |
| `LITELLM_ADMIN_API_URL` | Optional read-only model catalogue endpoint | empty |
| `LITELLM_MASTER_KEY` | Optional catalogue credential | empty |

Keep `VITE_API_BASE_URL=/api` unless building a deliberately split-origin
frontend. The standard image uses nginx to proxy `/api/` and `/ws` to the
backend service, so a deployment hostname is not baked into browser assets.

`COMPOSE_PROJECT_NAME` can isolate a second stack. Compose project scoping also
prevents disposable tests from sharing the production database volume or
network.

## Ingress and TLS

RelayHall's published ports bind to loopback. Bring an ingress controlled by the
deployment and route one public origin to the frontend host port.

Required behaviour:

- preserve `/dashboard/` (the UI base path);
- forward `/api/` to the frontend, which relays it to the backend;
- allow WebSocket upgrades on `/ws` and `/api/ws`;
- preserve normal forwarding headers;
- terminate TLS before exposing login or API traffic;
- set `CORS_ORIGIN` to the exact public browser origin.

Do not expose PostgreSQL publicly. Direct backend exposure is unnecessary for
the standard browser path; automation may reach it only through an intentional,
authenticated route.

## Persistent state

- PostgreSQL uses the project-scoped `postgres_data` named volume.
- `${DATA_DIR}` is a bind mount for RelayHall-owned runtime data.
- `relayhall.config.json` and `relayhall.plugins.json` are mounted read-only.
- Core has no harness, transcript, workspace, or external project mount.

See [docs/mount-points.md](docs/mount-points.md).

## Backup and restore

Create a compressed logical dump:

```bash
./database/backup.sh
```

Restore interactively or name a dump:

```bash
./database/restore.sh ./backups/relayhall_YYYYMMDD_HHMMSS.sql.gz
```

A database volume is not a backup. Store dumps on separate durable media, define
an RPO/RTO for production, and perform a restore drill.

## Upgrade contract

The backend image contains the baseline/retired manifests and active SQL
migrations. Container startup runs the migration command with `&&` before the
API process; failure prevents the listener from opening.

**Upgrading across the A13 Compose rename (pre-A13 installs only).** The
Compose project name changed from the estate-era name to `relayhall`, and named
volumes are project-scoped: your existing database volume belongs to the OLD
project (typically `clawboard_postgres_data`), while the renamed project
creates and mounts `relayhall_postgres_data`. **Starting the upgraded stack
without re-attaching brings up an EMPTY database** — the old volume is not
deleted, but it is no longer mounted.

Run steps 1–3 **while the old stack is still running**, BEFORE checking out
the new release. Discovery goes through the running container's Compose
labels, so a non-default `COMPOSE_PROJECT_NAME` stored only in `.env` is
found without exporting anything; database credentials expand INSIDE the
container, where PostgreSQL already has them.

```bash
# 1. Discover the old database container, its project, and its data volume
#    (label-based: works whatever project name the old .env configured)
OLD_DB=$(docker ps -q --filter label=com.docker.compose.service=clawboard-db | head -n1)
test -n "$OLD_DB" || { echo "old database container not found"; exit 1; }
OLD_PROJECT=$(docker inspect "$OLD_DB" --format '{{index .Config.Labels "com.docker.compose.project"}}')
OLD_VOLUME=$(docker inspect "$OLD_DB" --format \
  '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}')
echo "old project=$OLD_PROJECT container=$OLD_DB volume=$OLD_VOLUME"

# 2. Logical backup FROM THE RUNNING OLD DATABASE, credentials expanded
#    inside the container (single quotes are deliberate), then verify it
docker exec "$OLD_DB" sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > pre-a13-backup.dump
docker exec -i "$OLD_DB" pg_restore --list < pre-a13-backup.dump > /dev/null \
  && echo "backup verified"

# 3. STOP the old stack before touching the volume — a physical copy of a
#    running PostgreSQL data directory is not consistent
docker compose -p "$OLD_PROJECT" down

# 4. Now check out the reviewed release, then re-attach the discovered volume
#    (cold copy into the new project-scoped name)
docker volume create relayhall_postgres_data
docker run --rm -v "$OLD_VOLUME":/from -v relayhall_postgres_data:/to \
  alpine sh -c 'cd /from && cp -a . /to'
# Alternative to the copy: keep using the old volume via an override file —
#   volumes: { postgres_data: { external: true, name: "<OLD_VOLUME>" } }
# The old stack must remain down either way.

# 5. Start the renamed stack and verify the data arrived (credentials again
#    expand inside the container)
docker compose up -d --wait
docker compose exec relayhall-db sh -c \
  'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) FROM tasks;"'
```

For an ordinary upgrade:

```bash
./database/backup.sh
git fetch --all --tags
# Check out the reviewed release or exact approved commit.
docker compose build --pull
docker compose up -d --wait
docker compose ps
curl --fail http://localhost:8082/api/health
```

Migrations are forward-only. Do not edit or replay historical migration files.
Application rollback after a schema-changing release must follow that release's
notes and a tested database recovery plan; blindly starting an older image
against a newer schema is unsupported.

## Monitoring

At minimum monitor:

- container health and restart count;
- frontend `/health`;
- proxied backend `/api/health`;
- database capacity and backup freshness;
- certificate and ingress health in deployment infrastructure.

Operational ownership and alert delivery are deployment decisions.

## Security checklist

- [ ] `.env` is mode-restricted and excluded from version control.
- [ ] JWT and database secrets are unique to this deployment.
- [ ] The dashboard password hash is bcrypt and its plaintext is not stored.
- [ ] Host ports remain on loopback or behind an intentional firewall/ingress.
- [ ] TLS protects all non-loopback traffic.
- [ ] Each automated principal has its own narrow credential.
- [ ] Plugin images, credentials, mounts, and egress were reviewed separately.
- [ ] Backups are copied off-host and a restore was exercised.
- [ ] Exact deployed commit/image provenance is recorded. Builds self-identify
      when you pass the provenance build arguments — with them, every image
      carries `/release-manifest.json` (also served by the frontend at
      `/release-manifest.json`) naming the exact commit instead of `unknown`:

      ```bash
      RELEASE_SHA=$(git rev-parse HEAD) \
      RELEASE_DIRTY=$(test -z "$(git status --porcelain)" && echo false || echo true) \
      RELEASE_BUILD_CONTEXT=$(basename "$(git rev-parse --show-toplevel)") \
      RELEASE_BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
      docker compose build --no-cache
      ```

      Repeated builds without `--no-cache` (or with mutable base tags) can
      produce different image IDs from the same source; when an exact image
      receipt matters, build once with `--no-cache` and record the manifest.

## Removal

```bash
docker compose down              # preserve database
docker compose down --volumes    # permanently remove database volume
```

Remove `${DATA_DIR}` and backup files separately only after confirming their
retention requirements.
