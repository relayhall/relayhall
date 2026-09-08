# Deployment seams

The product ships as a self-contained core: database + backend API + frontend,
wired by the generic `docker-compose.yml`. Everything environment-specific is a
**seam** — a boundary where a deployment plugs in its own infrastructure. There
are five. The core never embeds a particular vendor on any of them.

## 1. Identity / OIDC provider

**Today.** The core authenticates with its own primitives:

- Humans: dashboard login against a bcrypt hash (`DASHBOARD_PASSWORD_HASH`),
  yielding a bearer JWT signed with `JWT_SECRET`.
- Agents and services: `rh_` API credentials bound to principals, with scoped
  authority (a credential can never mint a more powerful one — see
  `backend/src/utils/credentialAuthority.ts`).
- Role precedence is a single function (`backend/src/utils/taskAutomationRole.ts`):
  live session `role_snapshot` → `principals.role` → legacy handle mapping.
- Client-asserted identity is never an authority source: headers such as
  `x-user-id`, `x-forwarded-user`, or `x-oidc-username` are ignored no matter
  what injects them (`backend/src/__tests__/authHostileHeaders.test.ts`).

**The seam.** Human single sign-on binds to **any spec-compliant OIDC
provider** — configured by issuer URL (for example
`https://sso.example.com`), never by vendor. The
binding is Phase-2 work and will land in the currently dormant server-side
session path (`backend/src/middleware/auth.ts`, behind the
`RELAYHALL_SESSIONS` flag): the provider's group claims are snapshotted into
`auth_sessions.role_snapshot` at session mint, which then drives role
precedence. Agents and services keep `rh_` credentials; OIDC is for humans.

## 2. Secret store

Secrets are **referenced, never stored**. The repository and database hold no
secret values; a deployment injects them at runtime as environment variables
(`.env` consumed by `docker-compose.yml`): `POSTGRES_PASSWORD`, `JWT_SECRET`,
`DASHBOARD_PASSWORD_HASH`, plus optional integration keys. Where UI or docs
mention a credential, they point at the deployment's secret-store item — the
value itself never appears.

Which secret store backs those variables (a password manager, Ansible Vault, a
cloud secret manager, plain `.env` on a single-user host) is the deployment's
choice. Verified for this tree: a case-insensitive grep for specific
secret-store vendor names returns zero matches.

## 3. Ingress / TLS

Ingress is deployment infrastructure, not product. The core serves **plain
HTTP**; a deployment brings its own reverse proxy and terminates TLS there.

- The generic compose stack publishes the frontend on `${FRONTEND_PORT}`
  (default 8082) and the backend on `${BACKEND_PORT}` (default 3001); the
  database is bound to localhost only.
- The frontend image runs an **internal** web server (`frontend/nginx.conf`).
  It serves the built UI at `/dashboard/`, relays `/api/` and `/ws` to the
  backend service on the compose network, and answers `/health`. It does *not*
  terminate TLS, obtain certificates, or route to anything outside the compose
  network — it is the image's static-file server plus a single-origin relay,
  so one upstream (the frontend port) is all a reverse proxy needs.
- Current binding note: the backend calls `server.listen(PORT)` without a host
  argument, so inside its container it listens on all interfaces; actual
  exposure is governed by the compose port mapping. Making the bind interface
  configurable is later-phase hardening, recorded here rather than patched now.

See `DEPLOYMENT.md` for what a reverse proxy needs to know (preserve the
`/dashboard/` prefix, pass WebSocket upgrade headers, set `X-Forwarded-*`).

## 4. Execution

There is **no execution runtime in the product**. Agents pull work from the
board; the core never launches, binds to, steers, or kills an agent process.
The spawn/steer/cancel machinery the codebase once carried was removed, and
its design knowledge is recorded in
[`docs/design-history/removed-spawn-runtime.md`](design-history/removed-spawn-runtime.md).

**And no observation runtime either — this claim is now TRUE end to end
(P1.3, strategy §2.6.5/F11).** The board never connects to a gateway, watches
sessions files, reads transcripts, probes harness binaries, or reads
harness-local memory/workspace files. The gateway connector, session
ingesters, Hermes status probes, transcript-scraping audit/stats feeds, and
the memory/workspace/agents observation routes were all retired in P1.3
(recorded in
[`docs/design-history/removed-observer-stack.md`](design-history/removed-observer-stack.md)).
What remains is evidence-based: tasks record attempts and sessions that
agents report through the API, and session telemetry arrives only through
the reporter-ingest seam (§5).

**Claim/lease surface and its policy bounds (card 590c638a, ruled
2026-08-30).** Agents claim work through `POST /tasks/orchestration/:id/claim`
and hold it under a lease. That surface is **always on**: there is no switch,
because a board that cannot hand out work is not a product mode and a
deployment must not be able to be born with the surface off. Capacity is the
harnesses' concern under the pull-only doctrine; leases bound squatting and
rate limits bound API abuse. Two **optional** estate-wide policy bounds
remain, both unset by default (unset or empty = unlimited):

- `CLAWBEAT_MAX_ACTIVE_GLOBAL` - at most this many active leases across the
  whole board (integer 1-64);
- `CLAWBEAT_MAX_ACTIVE_PER_PROJECT` - at most this many active leases per
  project (integer 1-64; may not exceed the global bound when both are set).

A claim refused by a bound answers `409` with `GLOBAL_CAPACITY_EXHAUSTED` or
`PROJECT_CAPACITY_EXHAUSTED`. The **effective** configuration of a running
process - the value that actually reached it, not the value an operator
believes they set - is answered unauthenticated at `GET /api/health/orchestration`
(`orchestration.maxActiveGlobal` and `.maxActivePerProject` are each an
integer or the literal `"unlimited"`; `claimSurface` is `"always-on"`).
`scripts/orchestration-config-reachability-drill.mjs` reads it from the
compiled server in CI (handing the accepted boundaries 1/1 and 64/64, two
interior pairs, one pair drawn at runtime, and each bound alone, so a
substituted constant or a clamp cannot pass) and, in its `live` arm, from a
deployed environment.
In boot-check mode (`RELAYHALL_BOOT_CHECK=1`) the same answer is printed on
one `BOOT CHECK PROBE` line when `RELAYHALL_BOOT_CHECK_PROBE=/health/orchestration`
is set; the admissible probe paths are an enumerated set.

**Known interim couplings and open dispositions:**

- `GET /models/available` keeps a read-only, LiteLLM-backed model catalog
  (`backend/src/services/modelCatalog.ts`) feeding the task
  execution-profile pickers — an interim coupling to the LiteLLM env until
  Phase-2 model descriptors replace it (P1.3 ruling A10). The board-side
  model *commanding* endpoints (`/models/set-default`, `/models/switch`)
  are gone.
- Task↔Discord threading (`DiscordThreadService`) now uses only the direct
  `relayhall-bot` REST transport (or is disabled); its gateway dependency is
  gone. Whether Discord threading ships in the product at all or retires to
  an estate adapter is a **named open disposition**, decided at Phase 2/5
  (P1.3 ruling A14).
- Review evidence is board-resident: criteria, task/session metadata, and
  linked reports. Privileged verification runs outside core and files a report.

## 5. Telemetry / reporter ingest

Observability data enters the board through **reporters** — **outposts** that
run next to an agent runtime and push session activity in; the board never
fetches it. An outpost is not a plugin: a plugin installs into the board
deployment, an outpost runs beside someone else's runtime (`b94dd86e`, D-14).
This is a seam because each deployment chooses which reporters to run, per
harness.

- The typed ingest contract is `backend/src/types/CanonicalSession.ts`
  (idempotency-keyed events, cursor-based batches, adapter health
  self-reports). No HTTP endpoint fronts that batch contract yet; Phase 3
  shipped the trimmed presence surface `POST /telemetry/frames` instead
  (RH-P3.C7 — heartbeat and coarse status only).
- The health surface is `GET /sessions/pipeline-health`
  (`backend/src/routes/reporterHealth.ts`) — `unknown`/empty with no
  reporters, per-adapter rows once reporters self-report health.
- The Sessions and Stats pages are always-on core surfaces that render a
  documented empty state until reporters feed them.

See [`docs/observability.md`](observability.md) for the full model.
