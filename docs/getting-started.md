# Getting started with RelayHall

This guide installs the complete RelayHall core on one Linux host. It assumes a
fresh clone and no deployment-specific overlay.

## Prerequisites

- Git
- Docker Engine 24 or newer
- Docker Compose v2.20 or newer (`docker compose`, not legacy
  `docker-compose`)
- OpenSSL
- 2 GB RAM, one CPU core, and roughly 4 GB free disk for a small installation
- outbound access to fetch container images and npm packages during the first
  build

Verify them:

```bash
git --version
docker --version
docker compose version
openssl version
```

Run Docker as a user authorised for the local Docker daemon. Docker access is
host-root-equivalent; do not grant it casually.

## 1. Clone

```bash
git clone https://github.com/relayhall/relayhall.git
cd relayhall
```

## 2. Configure

### Interactive setup (recommended)

```bash
./setup.sh
```

The script:

1. verifies Docker, Compose, and OpenSSL;
2. copies `.env.example` to the gitignored `.env`;
3. creates `relayhall.config.json` from its example;
4. generates a database password and JWT signing secret;
5. hashes the dashboard password without writing its plaintext to disk;
6. creates local data and backup directories.

Review the generated files before starting:

```bash
docker compose config --quiet
```

Never commit `.env`, `relayhall.config.json`, database dumps, or `data/`.

### Manual setup

```bash
install -m 600 .env.example .env
cp relayhall.config.example.json relayhall.config.json
```

Edit `.env` and replace all three placeholders:

- `POSTGRES_PASSWORD` — a random database password;
- `JWT_SECRET` — at least 64 random bytes, for example
  `openssl rand -hex 64`;
- `DASHBOARD_PASSWORD_HASH` — a bcrypt hash. Dollar signs in a Compose env file
  must be doubled (`$` becomes `$$`). Running `./setup.sh` is the supported way
  to generate it safely.

The internal backend port is fixed at `3001`. `BACKEND_PORT`, `FRONTEND_PORT`,
and `POSTGRES_HOST_PORT` configure loopback host bindings. Change them if a
local port is already occupied.

`VITE_API_BASE_URL` should remain `/api` for the standard same-origin frontend.

## 3. Build and start

```bash
docker compose up -d --build --wait
```

First startup can take several minutes. PostgreSQL loads the fresh baseline,
then the backend applies active forward migrations **before** opening its
listener. A migration error therefore fails the backend closed.

Inspect status and bounded logs:

```bash
docker compose ps
docker compose logs --tail=100 relayhall-db relayhall-backend relayhall-frontend
```

Expected: all three services are running and healthy.

## 4. Verify the installed path

```bash
curl --fail http://localhost:8082/health
curl --fail http://localhost:8082/api/health
```

The first response proves the frontend container is serving. The second travels
through nginx's same-origin `/api` proxy and proves the browser-to-backend path.

Open <http://localhost:8082/dashboard/> in a browser on the Docker host.
For access from another machine, configure an HTTPS reverse proxy and set
`CORS_ORIGIN` to that exact HTTPS origin first; see
[Ingress and TLS](../DEPLOYMENT.md#ingress-and-tls). Use HTTPS for both
first-run setup and later Account sign-ins. A plain HTTP LAN address or
hostname does not support the Secure session cookie, even when health checks
pass. If first run already created an Account there, keep the database and sign
in with that Account's credentials after HTTPS is ready.

A deployment with no administrator yet meets the **first-run step**: it asks for
an account name, a display name and a password, creates that person as the local
administrator, and signs them in. That is the account to use from then on. The
step disappears the moment it succeeds, and a second attempt is refused.

The dashboard password you entered during setup remains as **break-glass**: a
permanent way in that no configuration can disable, for the day single sign-on
breaks or an administrator locks themselves out. It is not an everyday login.
Using it while an administrator account exists is recorded in the audit ledger
and announced on the dashboard.

## 5. Create a first backup

```bash
./database/backup.sh
```

The compressed dump is written to `./backups` by default and is not stored in
the database volume. Copy production backups to separate durable storage.

Test restores on a disposable deployment before declaring a recovery process:

```bash
./database/restore.sh ./backups/relayhall_YYYYMMDD_HHMMSS.sql.gz
```

The restore helper takes a safety backup, stops the API, restores with
`ON_ERROR_STOP`, and restarts the API so forward migrations run again.

## Stop, reset, or use a second local stack

```bash
docker compose down              # preserve PostgreSQL volume
docker compose down --volumes    # destructive reset
```

Compose resources are project-scoped. To run another disposable copy, set a
unique project name and unused host ports in its `.env`:

```dotenv
COMPOSE_PROJECT_NAME=relayhall-test
POSTGRES_HOST_PORT=55432
BACKEND_PORT=53001
FRONTEND_PORT=58082
```

## Production ingress

The shipped stack binds host ports to `127.0.0.1`. RelayHall does not ship a
reverse proxy or TLS automation. Put your deployment's nginx, Caddy, Traefik,
load balancer, or tunnel in front of the frontend port and preserve
`/dashboard/`, `/api/`, and `/ws` routing.

Read [DEPLOYMENT.md](../DEPLOYMENT.md) and [seams.md](seams.md) before exposing a
host.

## Troubleshooting

### Required variable error

Run `docker compose config --quiet`. If it reports a required value, rerun
`./setup.sh` or correct `.env`.

### A port is already allocated

Change the relevant host port in `.env`, then rerun `docker compose up -d`.
Internal container ports do not change.

### Backend is unhealthy

```bash
docker compose logs --tail=200 relayhall-backend
docker compose ps
```

Migration, database authentication, and missing mounted configuration errors are
shown before the listener opens.

### Start over from an empty database

Only on a disposable or fully backed-up installation:

```bash
docker compose down --volumes
docker compose up -d --build --wait
```

## Next steps

- [Deployment and upgrades](../DEPLOYMENT.md)
- [Architecture](PROJECT-OVERVIEW.md)
- [API](api.md)
- [Terminology](terminology.md)
- [Plugin boundary](plugin-development.md)
- [Observability boundary](observability.md)
- [Database operations](../database/README.md)
