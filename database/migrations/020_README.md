# Historical migration 020: relational task schema

**Status:** immutable migration history
**Date:** 2026-02-15

This directory records the one-time move from the legacy `tasks.json` document
to PostgreSQL tables. It is retained for audit and old-install upgrade history;
it is **not** the current fresh-install procedure. New installations use
`database/init.sql` and the backend migration runner described in
[../README.md](../README.md).

## Files

- `020_tasks_redesign.sql` — creates the relational schema.
- The one-time Python importers (`020_migrate_tasks_data.py`, `021_index_sessions.py`) were removed from the tree 2026-08-09: they were single-use estate tooling with hard-coded predecessor connection defaults, never part of a fresh install. The SQL files remain the immutable schema history.
- `020_README.md` — this historical note.

## Identifiers

RelayHall calls the board entity a **task**, and the migration and API
identifiers carry the same word:

- source file: `tasks.json`;
- main table: `tasks`;
- related tables: `subtasks`, `task_tags`, `task_dependencies`, `task_links`;
- foreign key: `task_id`;
- API prefix: `/tasks`;
- legacy environment variable: `TASKS_JSON_PATH`.

These identifiers are published migration history and must remain byte-stable.

## Schema outline

`tasks`
: UUID identity, title/description, status/priority, optional project,
  orchestration metadata, timestamps, session references, and parent relation.

`subtasks`
: Ordered child rows linked by `task_id`.

`task_tags`
: Normalised many-to-many labels.

`task_dependencies`
: Directed dependency edges with self-reference protection.

`task_links`
: External URI references.

The migration preserves valid UUIDs, maps project names to project IDs,
normalises tags and dependencies, and imports links/subtasks transactionally.

## Historical field mapping

| Legacy `tasks.json` field | PostgreSQL destination |
|---|---|
| `id`, `title`, `description` | `tasks` |
| `status`, `priority` | `tasks` |
| `project` | `tasks.project_id` |
| `tags[]` | `task_tags` |
| `subtasks[]` | `subtasks` |
| `blockedBy[]`, `dependsOn[]` | `task_dependencies` |
| `links[]` | `task_links` |
| `sessionRefs[]` | `tasks.session_refs` |
| execution/attempt fields | corresponding `tasks` columns |

## Historical import contract

The Python importer reads connection settings from `DB_HOST`, `DB_PORT`,
`DB_NAME`, `DB_USER`, and `DB_PASSWORD`; `TASKS_JSON_PATH` names the legacy
source. It performs a transaction and rolls back on import failure.

Before using this old upgrade path, an operator was required to make an
out-of-band copy of the real `tasks.json`, test the import against a disposable
database, verify row counts/relationships/index use, and retain a database
rollback artifact.

Current operators should not invoke these files manually against a modern
RelayHall database. Container startup owns migration ordering, and historical
SQL must remain byte-stable once published.
