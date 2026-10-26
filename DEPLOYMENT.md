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

The Compose project is named `relayhall`, and its services, network and
volume carry RelayHall names.

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
PORT=$(sed -n 's/^FRONTEND_PORT=//p' .env); PORT=${PORT:-8082}
curl --fail "http://localhost:$PORT/health"
curl --fail "http://localhost:$PORT/api/health"
```

`./setup.sh` asks for the public address: the host name, scheme and port
people's browsers use. The defaults (`localhost`, `http`, the frontend port)
are right for a browser on the Docker host. Behind a TLS reverse proxy, answer
the proxy's host name, `https` and its port: setup writes `CORS_ORIGIN` and
`RELAYHALL_PUBLIC_API_URL` from them (see [Domain and TLS](#domain-and-tls)).

Before creating the first administrator, use the browser on the Docker host at
`http://localhost:<FRONTEND_PORT>/dashboard/`, or set up the TLS proxy first. A
plain HTTP LAN address or host name can serve health checks while Account
sign-in fails: browsers do not keep the required `Secure` session cookie there.
The sign-in and first-run screens say so when the browser reports such an
origin. Use the same HTTPS origin for first-run setup and later sign-ins.

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
| `CORS_ORIGIN` | The exact browser origin: scheme, host and port (a scheme's default port left out) | `http://localhost:8082` |
| `RELAYHALL_PUBLIC_API_URL` | The API's public URL, ending in `/api`. Every onboarding pack names it, and single sign-on needs it. Empty = derived from each request | empty |
| `TRUST_PROXY_HOPS` | Proxies in front of the backend it trusts for the client address and scheme; `2` behind one more reverse proxy | `1` |
| `DATA_DIR` | Core-owned bind-mounted data | `./data` |
| `VITE_API_BASE_URL` | Browser API base | `/api` |
| `LITELLM_ADMIN_API_URL` | Optional read-only model catalogue endpoint | empty |
| `LITELLM_MASTER_KEY` | Optional catalogue credential | empty |

The backend refuses to start while `JWT_SECRET` or `POSTGRES_PASSWORD` is still
the `.env.example` placeholder, and says which one. `./setup.sh` generates both.

Keep `VITE_API_BASE_URL=/api` unless building a deliberately split-origin
frontend. The standard image uses nginx to proxy `/api/` and `/ws` to the
backend service, so a deployment hostname is not baked into browser assets.

### Key sets

The backend keeps four key sets outside the database. `./setup.sh` generates
them once, with random values, into `relayhall.keys.env` (mode `600`, ignored by
git), and `docker-compose.yml` passes that file to the backend as an optional
`env_file`. `.env.example` documents each variable and its format.

| Variables | What they protect | Without them |
|---|---|---|
| `RELAYHALL_CREDENTIAL_KEYS`, `RELAYHALL_CREDENTIAL_ACTIVE_KEY` | credential secrets (AES-256-GCM, 32-byte keys) | credentials cannot be issued, so connecting an agent fails |
| `RELAYHALL_TELEMETRY_PEPPERS`, `RELAYHALL_TELEMETRY_ACTIVE_PEPPER` | telemetry pseudonyms (32-byte peppers) | telemetry and OTLP ingest are refused; MCP sessions are not recorded; the native session protocols refuse |
| `RELAYHALL_KNOWLEDGE_HANDLE_KEYS`, `RELAYHALL_KNOWLEDGE_HANDLE_ACTIVE_KEY` | knowledge result links (32-byte keys) | a knowledge search that finds results fails |
| `RELAYHALL_KNOWLEDGE_ASSERTION_KEYS`, `RELAYHALL_KNOWLEDGE_ASSERTION_ACTIVE_KEY` | the board's caller assertions (Ed25519, PKCS#8 DER in base64) | a source that checks caller assertions is left out of every search |

Each set is a JSON object `{"<key id>": "<base64 key>"}` and the id of its
active key. `./setup.sh` never changes a key that exists, and it generates a set
only when Compose would pass the backend no value for it: a value you supply
another way (an `environment:` entry in an override file, the shell, or your own
`env_file`) is left alone and keeps winning. Values are never printed.

**Back up `relayhall.keys.env` with the database, and store that copy apart from
the dumps.** A dump alone reveals no credential secret; a dump restored without
its keys cannot read its own credential secrets, and once encrypted secrets or
pseudonymized telemetry exist the backend refuses to start without the key
they were written under. Do not rotate or replace a key casually.

### Running a second stack on one Docker host

Every Compose resource is scoped by the project name, and the shipped file sets
it to `relayhall`. Two checkouts that keep that name share one set of containers
and one database volume, and two stacks that keep the default ports collide on
the host. Give the second checkout its own project name and its own loopback
ports in its `.env` before its first `docker compose up` (`COMPOSE_PROJECT_NAME`
in `.env` overrides the name in the file):

```dotenv
COMPOSE_PROJECT_NAME=relayhall-second
POSTGRES_HOST_PORT=5434
BACKEND_PORT=3002
FRONTEND_PORT=8083
CORS_ORIGIN=http://localhost:8083
```

`./setup.sh` asks for the frontend port and the public address and writes
`CORS_ORIGIN` from them; set the project name and the other two ports by hand. With the OTLP/gRPC
overlay, also set `OTLP_GRPC_HOST_PORT`. Each checkout keeps its own `.env`,
`relayhall.keys.env`, `data/` and `backups/`; `database/backup.sh` and
`restore.sh` act on the stack of the directory they run in. Check the result
with `docker compose config --quiet` and `docker compose ps`.

## Domain and TLS

The stack's published ports bind to `127.0.0.1`, so it is reachable from the
Docker host only. There, `http://localhost:<FRONTEND_PORT>` is a secure origin
and needs nothing else. Every other browser reaches it through a reverse proxy
you run, which terminates TLS and forwards one public origin to the frontend.
Attach the proxy in one of two ways:

- **on the Docker host:** the proxy forwards to `http://127.0.0.1:<FRONTEND_PORT>`;
- **as a container on the stack's network:** the proxy joins the Compose network
  (`<project>_relayhall-network`, by default `relayhall_relayhall-network`:
  `docker run --network relayhall_relayhall-network ...`, or an `external`
  network in the proxy's own Compose file) and forwards to
  `relayhall-frontend:80`. Publish only the proxy's own port.

Do not rebind the stack's own ports to `0.0.0.0` instead: over plain HTTP at a
LAN address or host name the health checks answer, but Account sign-in fails,
because the browser drops the `Secure` session cookie.

The proxy must:

- keep the `Host` header as the browser sent it, port included (`$http_host` in
  nginx; nginx's `$host` drops the port);
- send `X-Forwarded-Proto` with the browser's scheme;
- allow WebSocket upgrades on `/ws`, `/api/ws` and `/api/events/ws`;
- pass `/dashboard/`, `/api/` and `/ws` through unchanged.

A Caddy site (Caddy obtains the certificate, keeps `Host` and sets
`X-Forwarded-Proto` and the upgrade headers itself):

```caddyfile
board.example.com {
	reverse_proxy 127.0.0.1:8082
}
```

As a container on the stack's network, the upstream is `relayhall-frontend:80`.

An nginx server block, with your certificate:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ""      close;
}

server {
    listen 443 ssl;
    server_name board.example.com;
    ssl_certificate     /etc/ssl/board.example.com/fullchain.pem;
    ssl_certificate_key /etc/ssl/board.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8082;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 86400s;
    }
}
```

Then tell RelayHall its public address. On a first install, answer
`./setup.sh`'s public-address question with the proxy's host name, `https` and
its port. On an existing install, set these in `.env` and run
`docker compose up -d --wait`:

```dotenv
CORS_ORIGIN=https://board.example.com
RELAYHALL_PUBLIC_API_URL=https://board.example.com/api
TRUST_PROXY_HOPS=2
```

- `CORS_ORIGIN` is the exact origin, with a port only when it is not the
  scheme's default (`https://board.example.com:8443`).
- `RELAYHALL_PUBLIC_API_URL` (ending in `/api`) is the address every onboarding
  pack names: the board endpoint, the bootstrap line and the MCP and CLI lines.
  Left empty, the backend derives it from each request, which the shipped
  frontend forwards with its scheme, host and port; declaring it is the
  dependable choice, and single sign-on requires it.
- `TRUST_PROXY_HOPS=2` lets the backend see the real client address behind your
  proxy and the frontend's own nginx, so per-client sign-in throttling does not
  treat every visitor as the proxy. Set it only when every browser request
  passes through that proxy.

Check it: `curl --fail https://board.example.com/api/health` answers, and a new
connection's setup pack (Connect your agent) names `https://board.example.com/api`.

Do not expose PostgreSQL publicly. Direct backend exposure is unnecessary for
the standard browser path; automation may reach it only through an intentional,
authenticated route.

## Persistent state

- PostgreSQL uses the project-scoped `postgres_data` named volume.
- `${DATA_DIR}` is a bind mount for RelayHall-owned runtime data.
- `relayhall.config.json` and `relayhall.plugins.json` are mounted read-only.
  The backend runs as an unprivileged user (`PUID`, default `1002`) that does
  not own them, so they must be readable by all: `./setup.sh` sets
  `relayhall.config.json` to mode `644`. It holds operational settings, never a
  secret; an unreadable file makes the backend run on built-in defaults.
- `relayhall.keys.env` holds the key sets; Compose reads it, the backend never
  mounts it. Back it up with the database (see [Key sets](#key-sets)).
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

The dumps do not contain the key sets. Keep a copy of `relayhall.keys.env`
beside your backups, stored apart from the dumps: a restored database needs the
keys its secrets were written under.

### Restore drill into a scratch database

`./database/restore.sh` restores into the running stack's own database and
replaces what is there. To prove a dump restores, without touching the stack,
restore it into a throwaway PostgreSQL container and compare the counts:

```bash
DUMP=./backups/relayhall_YYYYMMDD_HHMMSS.sql.gz
U=$(sed -n 's/^POSTGRES_USER=//p' .env); U=${U:-relayhall}
docker run -d --name relayhall-restore-drill -e POSTGRES_USER="$U" \
  -e POSTGRES_DB=scratch -e POSTGRES_PASSWORD=restore-drill-only postgres:16-alpine
until docker exec relayhall-restore-drill pg_isready -h 127.0.0.1 -U "$U" -d scratch; do sleep 1; done
gunzip -c "$DUMP" | docker exec -i relayhall-restore-drill \
  psql -U "$U" -d scratch -v ON_ERROR_STOP=1 -q
for q in "select count(*) from information_schema.tables where table_schema = 'public'" \
         "select count(*) from schema_migrations" "select count(*) from tasks"; do
  echo "$q: scratch=$(docker exec relayhall-restore-drill psql -U "$U" -d scratch -Atc "$q")" \
       "live=$(docker compose exec -T relayhall-db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"' sh "$q")"
done
docker rm -fv relayhall-restore-drill
```

The restore must finish without an error, and each scratch count must equal the
live one for a dump taken just before (the live database moves on after it).
`pg_isready -h 127.0.0.1` waits for the container's real server, not the
temporary one its first start runs.

## Upgrade contract

This public beta is published for fresh installs: install it on an empty
database. Upgrading an install of an earlier public version is not supported
for this beta. The steps below describe how upgrades between releases work.

The backend image contains the baseline/retired manifests and active SQL
migrations. Container startup runs the migration command with `&&` before the
API process; failure prevents the listener from opening.

### An ordinary upgrade

Read the release's notes in [CHANGELOG.md](CHANGELOG.md) first: a release that
needs more than these steps says so there.

```bash
# 1. Back up the database, and copy the key sets and .env somewhere apart from
#    the dumps. If your key sets are supplied from .env or an override file
#    instead of relayhall.keys.env, those files hold them: copy them too.
./database/backup.sh
install -d -m 700 ../relayhall-keys-copy
cp -p relayhall.keys.env .env ../relayhall-keys-copy/   # and any docker-compose.override.yml
docker compose exec -T relayhall-db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from schema_migrations"'
#    (note the count: a rollback is checked against it)

# 2. Check out the release by its tag, and compare the commit with the one the
#    release names. (Tracking main instead: git pull --ff-only origin main.)
git fetch --tags origin
git checkout v1.0.0-beta.N                    # the release you upgrade to
git rev-parse HEAD

# 3. Compare .env with the new .env.example. A line marked ">" is a setting the
#    new release adds; add the ones you want (a missing optional setting keeps
#    its default).
diff <(grep -oE '^[A-Z_]+=' .env | sort -u) \
     <(grep -oE '^#? ?[A-Z_]+=' .env.example | tr -d '# ' | sort -u)

# 4. Keep .env, add any missing key set (nothing else changes).
./setup.sh                                    # answer "no"

# 5. Build with the release's identity, then start; the backend migrates
#    before it opens its listener.
RELEASE_SHA=$(git rev-parse HEAD) \
RELEASE_DIRTY=$(test -z "$(git status --porcelain)" && echo false || echo true) \
RELEASE_BUILD_CONTEXT=$(basename "$(git rev-parse --show-toplevel)") \
RELEASE_BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
RELAYHALL_RELEASE_VERSION=1.0.0-beta.N \
docker compose build --pull
docker compose up -d --wait

# 6. Check.
docker compose ps
PORT=$(sed -n 's/^FRONTEND_PORT=//p' .env); PORT=${PORT:-8082}
curl --fail "http://localhost:$PORT/api/health"
```

Without the build arguments in step 5 the upgrade still works, and About shows
`<version>+unreleased` with an unknown commit instead of the release. Never run
`docker compose up -d` alone after checking out a new release: it restarts the
images already built, the old ones, and nothing migrates.

**Key sets on upgrade.** Keep the keys you have: never regenerate or replace
them. An install that has key sets keeps every value byte for byte when
`./setup.sh` runs again. An install that never had them (installed before
`relayhall.keys.env` existed) gets them generated by re-running `./setup.sh`
and answering `no`; that is safe, because nothing was stored under keys that
did not exist. If you already supply them another way (an override file, the
shell, your own `env_file`), `./setup.sh` sees that through
`docker compose config` and leaves them alone; a complete pair you put in `.env`
is copied into `relayhall.keys.env` unchanged. Then back up
`relayhall.keys.env`, and `.env` and any override file if your keys are supplied
from there.

Migrations are forward-only. Do not edit or replay historical migration files.

### Rolling back a schema-changing release

Roll the images and the data back together. The new backend migrates the
database whenever it starts, and `./database/restore.sh` restarts whichever
backend container exists, so put the previous release in place before you
restore. **Everything written after the upgrade is lost**: you return to the
pre-upgrade dump, including any credential issued since.

1. Run `./database/backup.sh` to keep the current state as well, and copy
   `relayhall.keys.env` and `.env` aside.
2. Check out the previous release (its tag, or `git checkout f9c65e4` for the
   first public beta, which has no tag), then run `docker compose build`.
   `relayhall.keys.env` stays behind as an untracked file: keep it, and do not
   `git clean`, `git stash -u` or commit it. The next upgrade needs it unchanged.
3. Run `docker compose stop relayhall-frontend relayhall-backend`, then
   `docker compose up -d --no-start relayhall-backend relayhall-frontend`, so both
   containers come from the previous images.
4. Empty the database, so that no table from the new migrations is left behind.
   This deletes the upgraded data; step 1's dump is its only copy:
   `docker compose exec -T relayhall-db sh -c 'dropdb -U "$POSTGRES_USER" --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'`.
5. Run `./database/restore.sh --yes <pre-upgrade dump>`. It restarts the backend
   itself, now the previous image, and must end with `Restore complete`. Then
   run `docker compose up -d --wait`.
6. Check: `docker compose ps` shows every service healthy,
   `curl --fail http://localhost:<FRONTEND_PORT>/api/health` answers, About shows
   the previous version, and
   `docker compose exec -T relayhall-db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from schema_migrations"'`
   returns the count you noted before the upgrade.

If `restore.sh` says `Requested restore failed; safety backup restored and
backend restarted`, the database was not emptied: the restore could not drop
the newer schema, and its safety backup put the upgraded schema back under the
previous image. That backend refuses to serve (`Access-surface census FAILED —
refusing to serve`) and restarts in a loop; nothing is damaged. Run
`docker compose stop relayhall-backend` first (otherwise the restarting backend
reconnects to the newly created empty database), then repeat steps 4 and 5.

On its first start the previous image may import the sidebar title from
`relayhall.config.json` into Appearance: one new row, harmless.

Until you deliberately upgrade again, do not start the new image against the
restored database, and never start the previous image against a migrated one.

### Installs from before the Compose project was named `relayhall`

Skip this section if your current `docker-compose.yml` begins with
`name: relayhall` (`head -n1 docker-compose.yml`); every public release does. It
applies only to an install made from a development checkout whose project had
another name: its database volume belongs to the old project, named
`<old project>_postgres_data`, while the renamed project creates and mounts
`relayhall_postgres_data`. **Starting the upgraded stack without re-attaching
brings up an EMPTY database**: the old volume is not deleted, but it is no
longer mounted.

Run steps 1 to 3 **while the old stack is still running**, BEFORE checking out
the new release. Database credentials expand INSIDE the container, where
PostgreSQL already has them.

```bash
# 1. Find the old stack's database container, its project and its data volume.
docker ps --filter label=com.docker.compose.project \
  --format '{{.ID}}  {{.Label "com.docker.compose.project"}}  {{.Label "com.docker.compose.service"}}  {{.Image}}'
OLD_DB=<the ID of the old stack's PostgreSQL container, from the list above>
OLD_PROJECT=$(docker inspect "$OLD_DB" --format '{{index .Config.Labels "com.docker.compose.project"}}')
OLD_VOLUME=$(docker inspect "$OLD_DB" --format \
  '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}')
echo "old project=$OLD_PROJECT container=$OLD_DB volume=$OLD_VOLUME"   # all three set? then go on

# 2. Logical backup FROM THE RUNNING OLD DATABASE (single quotes are
#    deliberate), then verify it
docker exec "$OLD_DB" sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > pre-rename-backup.dump
docker exec -i "$OLD_DB" pg_restore --list < pre-rename-backup.dump > /dev/null \
  && echo "backup verified"

# 3. STOP the old stack before touching the volume: a physical copy of a
#    running PostgreSQL data directory is not consistent
docker compose -p "$OLD_PROJECT" down

# 4. Now check out the reviewed release, then copy the old volume into the new
#    project-scoped name (a cold copy)
docker volume create relayhall_postgres_data
docker run --rm -v "$OLD_VOLUME":/from -v relayhall_postgres_data:/to \
  alpine sh -c 'cd /from && cp -a . /to'
# Instead of the copy you can keep using the old volume through an override file:
#   volumes: { postgres_data: { external: true, name: "<OLD_VOLUME>" } }
# The old stack must stay down either way.

# 5. Start the renamed stack and check the data arrived
docker compose up -d --wait
docker compose exec relayhall-db sh -c \
  'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) FROM tasks;"'
```

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
- [ ] `relayhall.keys.env` is mode `600`, excluded from version control, and
      backed up apart from the database dumps.
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
      RELAYHALL_RELEASE_VERSION=1.0.0-beta.102 \
      docker compose build --no-cache
      ```

      `RELAYHALL_RELEASE_VERSION` is the release version both images record
      and About shows; leave it unset for a build that is not a release, which
      then reads `<package version>+unreleased`. A malformed value fails the
      build. `RELEASE_BUILT_AT` is RFC 3339; the `Z` form above is preferred.
      The backend serves its record in the `build` object of `GET /api/`. The
      full contract is in [docs/build-identity.md](docs/build-identity.md).

      Repeated builds without `--no-cache` (or with mutable base tags) can
      produce different image IDs from the same source; when an exact image
      receipt matters, build once with `--no-cache` and record the manifest.

## Removal

```bash
docker compose down              # preserve database
docker compose down --volumes    # permanently remove database volume
```

Remove `${DATA_DIR}` and backup files separately only after confirming their
retention requirements. After the first start, `${DATA_DIR}` belongs to the
backend's runtime user (uid `1002` in the container); under rootless Docker
that maps to a host uid your own account cannot remove, so remove it through a
container:

```bash
docker run --rm -v "$PWD":/w alpine rm -rf /w/data    # your DATA_DIR, if not ./data
```
