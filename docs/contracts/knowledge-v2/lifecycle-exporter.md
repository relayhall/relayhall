# Lifecycle snapshot exporter

The opt-in core exporter renews a complete source-scoped signed provisioning snapshot every 15 seconds. It does not change Service visibility, source selection, A21 admission or content ACLs. A principal may have a provisioned Compartment while core search/get still denies the Service. Every read continues through existing core admission and current source authorization.

Set RELAYHALL_KNOWLEDGE_LIFECYCLE_CONFIG to a deployment-owned absolute JSON file. Configuration and dedicated Ed25519 key must be root-owned mode 0600 or 0640 (the latter only with the core runtime primary GID), with root-owned, non-writable, symlink-free ancestor directories. They must not live in an agent-writable workspace. Runtime output and generation files share a protected directory owned by root or the core process; no group/other write or symlink ancestors are allowed. Do not use the assertion signing key.

Configuration fields: optional accountSelection (explicit|all-human) and projectSelection (explicit|all-projects), enabled, sourceId (Service UUID), sourceConfigVersion (pinned string), expectedServiceRevision (UUID), issuer (same as assertions), actorRef, accountIds, projectIds, projectGrants [{projectId,grants:[{subject_type:user|group,subject_id,operation:read|write,consent_ref}]}], personalConsents [{owner_id,reader_id,consent_ref}], keyRef (file:absolute-path), kid, outputPath and generationPath. Duplicate JSON keys, duplicate grants and malformed bounds are rejected.

An operator must seed generationPath as {generation:0,lastIat:0} only for a newly commissioned identity. Missing state never automatically resets. For an existing identity, restore its durable monotonic state or complete an explicit reviewed reseed with the consumer. Each renewal reserves and fsyncs the next generation before signing, then atomically replaces and fsyncs the snapshot. Crashes may skip generations. A PostgreSQL session advisory lock keyed by Service UUID serializes generation reservation through output replacement. Abrupt process exit releases the database connection and lock; there is no persistent filesystem lock to remove. Clock rollback over ten seconds refuses renewal.

Each renewal reads a consistent database snapshot. The Service must remain published, its descriptor nonretired and knowledge-capable, its revision exactly pinned, and its identity mode asserted. Accounts, projects and minimised stable group IDs come from current database entities intersected with trusted owner eligibility. Disabled accounts and archived projects are emitted inactive; missing entities disappear from the complete snapshot. No future household privileges are inferred. No A21 grants are written.

JWT header: alg EdDSA, typ rb-lifecycle-snapshot+jwt, dedicated kid. Payload: schema_version 1, iss, aud=Service UUID, iat, exp=iat+60, generation, complete true, source_config_version, accounts [{id,assertion_sub,label,active}], groups [{id,assertion_grp,active}], projects [{id,label,active,grants}], personal_consents, shared_writers, actor_ref. Pairwise subjects reuse the exact current assertion derivation. Limits: 10,000 total entities, 100,000 grants/consents, 10,000 shared-writer rows, 8 MiB JSON, 12 MiB token.

Mount output read-only into the source. Pin its public key, issuer, audience and config version. The consumer must deny managed authority after expiration plus ten seconds, including when renewal fails. Stop the exporter by removing its opt-in environment setting and restart core; stale authority then expires. No content ingestion, ownership rewrites or production deployment is part of enabling this code.

Selection modes default to explicit when omitted. Required accountIds/projectIds arrays must be empty for the corresponding dynamic mode; mixed dynamic and explicit IDs, nulls and unknown modes reject configuration. Only a deployment owner may opt into all-human/all-projects. Every scheduled renewal discovers current entities in the same consistent transaction, with each query bounded to 10,001 rows and the combined snapshot bounded to 10,000. Overflow refuses the whole generation before publication. New personal owners receive their own read/write access; a new project receives no inferred grant. Structurally valid policy references to missing, inactive or unselected entities are omitted; explicit mode still rejects references outside configured ID eligibility. Reactivation restores only current explicit policy. These modes do not grant outer A21 visibility or household privileges.

## shared_writers (16 October 2026)

Additive under `schema_version` 1: a consumer that reads only the named keys it knows is unaffected, and the version does not change. The element is always present:

`shared_writers: [{scope: "organisation", accounts: [<account id>, ...]}]`

`accounts` are the Accounts on this source's organisation-wide shared-area writer list (the core table `knowledge_shared_writers`, governed by root or an administrator login session with step-up; see `docs/authorization.md`), read in the same consistent transaction as the rest of the snapshot, without rows whose expiry has passed, sorted and unique. The core emits ONLY ids that are also exported, active, human Accounts in the same payload's `accounts` array: a listed Account outside the export selection, or one disabled since, is simply absent and never makes the snapshot invalid. An empty `accounts` array means nobody writes the shared area. More than 10,000 writer rows refuses the whole generation before publication.

Freshness: the exporter renews the snapshot every 15 seconds and the source refreshes it every 5 seconds, so a change to the list reaches the source's next write verb in about 20 seconds. A consumer that verifies this element strictly must treat a malformed element as a malformed snapshot, which denies reads as well as writes; the core's filtering above is what keeps a valid list from ever producing one.

## The core tables

Project compartment grants and personal consents are core tables
(`knowledge_compartment_grants`, `knowledge_personal_consents`, migration 158),
not configuration. Each renewal reads them, unexpired, in the same consistent
transaction as the rest of the snapshot and emits them as `projects[].grants`
and `personal_consents`, in a canonical order (subject type, subject id,
operation; owner, reader), through the same filter as before: only exported,
active, human Accounts and relevant Groups are emitted, and a row for any other
subject is filtered, never shipped. More than 100,000 compartment rows refuses
the whole generation.

**The carry-over.** On the first renewal for a source, the configuration's
`projectGrants` become compartment rows with their `consent_ref` preserved, no
approval and `added_by` `system` (a Project the board does not hold is
skipped), and its `personalConsents` become consent rows, in their own
committed transaction. That generation is then built from the tables and
compared, element by element and in the canonical order, with the snapshot the
configuration alone would have produced: anything but an exact match refuses
`LIFECYCLE_EXPORT_REFUSED` and nothing is published. A match is recorded once,
after the snapshot is written, as the audit row `knowledge.lifecycle.import
{generation, rowCount, digest, sourceConfigVersion, selection}`, where
`selection` is the configuration's `accountSelection` and `projectSelection`
with the number of ids each names. From then on the tables govern and the
configuration fields are carry-over input only; a later release removes them.

**Change requests.** A `knowledge.compartment` or `knowledge.shared_writer`
change approved on `/approvals` writes its core row at decide. The first
generation that carries the row records `approval.applied {generation}` on the
request, once; a row no generation carried within 20 generations (about five
minutes) of its decide is marked `export: stalled` with
`approval.export_stalled`. The request door refuses a subject or Project
outside the live export selection (`KNOWLEDGE_NOT_EXPORTED`), which this process
records each time it writes a generation; a process that exports nothing
refuses every knowledge change.
