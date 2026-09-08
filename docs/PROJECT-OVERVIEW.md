# RelayHall architecture overview

RelayHall is a self-hosted, governed system of record for a mixed human and AI
workforce. Humans and external agent harnesses share tasks, projects,
reports, identities, credentials, skills, project charters, and review
evidence through one permissioned blackboard.

## Product boundary

RelayHall is deliberately **pull-only**:

- it stores and serves work;
- it compiles complete task Briefs;
- it records lifecycle, attribution, dependencies, review history, and reports;
- it never launches, steers, kills, or inspects an agent runtime;
- it never mounts harness sessions, transcripts, config, memory, or workspace
  directories.

Agents use the REST/OpenAPI surface or the `relayhall` CLI. Optional reporter
outposts run next to a harness and push telemetry into the reporting seam — an
outpost runs beside the harness, a plugin installs into the board (`b94dd86e`,
D-14). Until a reporter is connected, Sessions and Stats show a documented
empty state.

## Runtime components

```text
Browser / CLI / external agent
              |
              v
      reverse proxy + TLS
              |
       +------+------+
       |             |
       v             v
 React frontend   Express backend ---- optional plugins
       |             |
       +------ PostgreSQL 16
```

- **Frontend:** React, TypeScript, Vite, nginx.
- **Backend:** Express, TypeScript, JWT and principal credentials, REST,
  OpenAPI, authenticated WebSocket task updates, and the plugin proxy.
- **Database:** PostgreSQL stores the authoritative board, identities,
  credentials, reports, configuration records, and audit history.
- **Plugins:** separate containers with explicit manifests and their own data
  mounts. Core does not inherit a plugin's private runtime access.

## Core surfaces

- Dashboard
- Tasks (Kanban, subtasks, dependencies, Assignees, review gates)
- Projects and links
- Reports
- Personalities
- Skills registry
- Principals and scoped credentials
- Audit of board actions
- Sessions and Stats reporter empty states
- Plugin registry and proxy
- Push-based bot/presence status

Personal Journal, Content Engine, image generation, and knowledge-fabric UI
features are not core; they belong behind plugin boundaries.

## Identity and authority

Browser users authenticate through the configured dashboard identity path.
Automation should use principal-bound `rh_` credentials with narrow scopes.
Unmapped scoped-key routes fail closed to `root`. Task and report attribution
is stored server-side; mutable note text is advisory rather than a ledger.

## Execution and review

A task may describe a preferred harness and access profile, but those fields are
instructions for an external orchestrator. RelayHall itself only compiles the
Brief and records reported evidence. Implementers hand work to an independent
Verifier; owner-gated actions stay blocked until explicit approval.

## Deployment seams

A deployment supplies:

- secrets and identity integration;
- ingress, TLS, and external hostname;
- optional plugins and reporter outposts;
- report-backed Verifier evidence with no workspace mounts;
- the external agent/orchestrator that pulls work.

See [seams.md](seams.md), [observability.md](observability.md), and
[plugin-development.md](plugin-development.md) for the detailed contracts.
