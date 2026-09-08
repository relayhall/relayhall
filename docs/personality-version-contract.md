# Personality immutable content versions

Owner-approved prerequisite50493968 supplies real current-version identity for Blueprint minimum-version references. Migration130 was reserved on main under the owner's explicit reservation-only exception. This document describes the implemented contract; release readiness still requires the linked test, review and CI receipts.

## Stored identity and adoption

`personalities.current_version` is a positive PostgreSQL integer. `personality_versions` has composite identity `(personality_id, version)`, immutable `snapshot` JSONB and a recording timestamp. The parent pointer references a version of the same parent. Snapshot keys are exactly slug, name, description, category, color, content, source_file, is_custom and source. Null and empty text remain distinct; IDs and creation/retirement metadata remain outside the content snapshot.

Migration130 locks the parent table during adoption and records each existing row's actual current bytes as version1, including retired, built-in and imported rows. It does not reconstruct history before adoption. Reapplying the migration preserves existing versions and timestamps. Earlier migration files remain unchanged.

Parent row triggers append history and advance the pointer on any snapshot-field change. The ordinary PostgreSQL row lock serializes competing updates. Identical writes and lifecycle-only retirement do not advance the content version. The positive integer sequence refuses overflow. Direct pointer/identity manipulation, history UPDATE/DELETE/TRUNCATE, direct history INSERT outside the parent trigger and parent deletion that would erase history are refused. A database owner able to disable triggers or alter schema is outside this DML guarantee, as for the existing immutable profile/feed substrates.

## Writes and current reads

PersonalityService returns the actual numeric `version` on current detail and summary DTOs. Detail validates the pointer, parent, snapshot identity and all nine exact field values; absence or drift fails closed with fixed error text. Summary SQL selects version identity without loading snapshot/content. Internal SQL aliases and history JSON are removed from the DTO.

Create/update/retire validate transaction-visible history before their existing same-client feed emission and commit. An invariant, snapshot append or feed failure rolls back the operation. Creation must return actual version1. Existing same-value PATCH feed behavior remains; events do not gain full-content payloads. Existing REST/CLI administration checks and read-only MCP behavior are preserved. MCP JSON list responses inherit the additive version field; compact text remains a catalogue summary.

No new route, permission, owner/grant policy, publication lifecycle or historical execution pin is introduced. Built-in/imported read-only behavior, retirement, legacy IDs and brief compilation remain. The verifier-rename upgrade fixture now retains its earlier managed row under a different slug, allowing the collision proof to preserve history instead of deleting it.

## Blueprint composition

C9 joins `personality_versions pv ON pv.personality_id=pe.id AND pv.version=pe.current_version` within its existing canonical visibility predicate and compares the actual current committed immutable version to the requested floor. Required/optional and hidden/absent/retired behavior stays explicit. Stored Blueprint receipts preserve the version resolved at creation; fresh work re-resolves.

A minimum version is not an exact execution pin: ordinary Tasks continue to store personality_id. Executing historical snapshot content would need a separate contract. Versioning does not confer template or instance authority.

## Verification surfaces

The default suite covers strict DTO identity/shape and transaction ordering with mocked rows. `npm run test:personality-versions` fails unless an explicitly admitted disposable PostgreSQL is supplied; it drives real SQL and the production router, and measures actual `pg_stat_activity` lock waits. It covers every snapshot field, no-op/retirement behavior, immutable DML and retention, concurrent writes, feed/snapshot failure rollback, repeated migration, integer exhaustion and current API behavior for two authenticated principals.

`scripts/personality-live-mutations.py` runs semantic source/SQL removals in private tracked-source and PostgreSQL template copies. It refuses deployment databases, never terminates connections to make a baseline cloneable, and leaves the baseline unchanged. Separate source-identity and cleanup receipts distinguish initial failed fixture attempts from corrected proof. The Graphify report is a structural aid; SQL semantics and browser behavior require direct evidence.
