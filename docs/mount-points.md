# RelayHall Mount Points

This document describes the directories mounted into the RelayHall containers.

## Overview

The stack is self-contained: database + backend + frontend. Since P1.3
(strategy F11) the board mounts **no harness directories** — it never reads
an agent runtime's sessions, transcripts, config, workspace, or media.
Session telemetry arrives only through reporter plugins
(see [observability.md](observability.md)).

## Mounts

### 1. Data directory (read-write)

**Purpose:** RelayHall's own persistent files

- **Host:** `${DATA_DIR}` (default: `./data/`)
- **Container:** `/data/`
- **Access:** Read-write (`rw`)

**Example:**
```yaml
volumes:
  - ${DATA_DIR:-./data}:/data:rw
```

### 2. Database init script (read-only)

**Purpose:** Fresh-install schema baseline for PostgreSQL

- **Host:** `./database/init.sql`
- **Container:** `/docker-entrypoint-initdb.d/init.sql`
- **Access:** Read-only (`ro`)

### 3. PostgreSQL data volume

**Purpose:** Database storage — a project-scoped named Docker volume (normally
`relayhall_postgres_data`; a custom Compose project name changes the prefix),
not a bind mount.

## Plugin mounts

Plugins are separate containers and own their mounts. A reporter plugin that
reads a harness's local state mounts that state into *its* container — never
into core. See [plugin-development.md](plugin-development.md).

## SELinux note

On SELinux hosts (Fedora, RHEL), append `:z` or `:Z` to bind-mount options if
the container cannot read a mounted path, e.g. `./data:/data:rw,z`.

## History

Earlier versions mounted one harness's session/config/workspace/media
directories read-only so the board could observe it. Those mounts were retired
with the observer stack — see
[design-history/removed-observer-stack.md](design-history/removed-observer-stack.md).
