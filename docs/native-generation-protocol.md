# Native generation coordination protocol 2

This opt-in protocol stores ordinary generation coordination in PostgreSQL. It does not migrate an adapter, launch a process, import an actual local store, or qualify a deployment. Legacy Tasks without generation records retain the existing native and finish protocol. A Task with generation records cannot use legacy authorize-launch or omit its generation at finish.

The server must have a stable `RELAYHALL_DEPLOYMENT_ID` UUID. Versioned operations refuse an unbound or different deployment. Migration 137 is independent of the separate task-report workflow migration. Apply it with the maintained migration runner before serving this source.

## Ordered transition

1. While the Task is armed and todo, reserve a schemaVersion 2 intent with the current assignmentEpoch, Service/descriptor, requestKey, workerInstanceId, 32-byte workerToken, sourceSha256/inputSha256, original 30–600 second budget and exact predecessorExecutionId/reviewAttemptId pair (both null only for a first generation with no native history). This permanently burns the reservation. Reservation grants no launch authority. Identity, ancestor/object permissions, published capability, dependency state and unresolved native/import fences are checked under the Task lock.
2. Use the supported Task claim. Its transaction records the original reservation's claim epoch. A null-owner claim must advance exactly one epoch; a same-owner rework claim must retain the epoch. Direct assignments and intervening ABA changes cannot manufacture this witness. Moving the claimed Task in progress uses the existing supported lifecycle.
3. Open an implementation execution with the current post-claim epoch. Consume the reservation using exact instance/token/execution/launchKey. Task and generation/execution row locks serialize the conditional transition. The native deadline is clamped to the original reservation deadline. One committed response has freshConsume=true. All replays and reads are evidence only (freshConsume=false on consume replay; launchPermit=false on all metadata). Identical Idempotency-Key headers do not cache a fresh winner.
4. Retain actual native evidence and close with the exact caller-authored Task Report. Register the immutable publication intent, then finish using nativeGeneration={schemaVersion:2,generationId,executionId,publicationKey,requestSha256}. Current identity, epoch, Service, original deadline and own Report read/content authority are rechecked. Generation finished, Report/reference/handover and Task Review commit in one existing finish transaction, or all roll back.
5. A successor requires the latest native execution closed/completed, its finished mapped generation, exact Report bytes and finish handover, and the current authoritative rejected review attempt. Unknown, unresolved, unmapped or unfinished ancestry refuses. The accepted predecessor and rejection cannot be reused by another successor.

A lost consume reply never permits another process launch: read the committed evidence and HOLD. The server proves one conditional logical consume, not exactly-once physical process creation. Two honest instances use distinct instance IDs and secret tokens. A copied identity/secret is indistinguishable to the server; actual process custody, host source verification, stop/absence and original monotonic deadline enforcement remain mandatory adapter/operator responsibilities. Source/input hashes are immutable caller evidence, not server verification of host files. Grant revocation is a fresh decision-time snapshot, not an assertion of atomicity with every grant writer or a distributed PostgreSQL writer/failover qualification.

## Routes and clients

All paths below are beneath `/tasks/:id/native-executions`:

- POST `/generations`: reserve.
- GET `/generations/:generationId`: exact evidence-only read.
- POST `/generations/:generationId/consume`: conditional consume.
- POST `/generations/:generationId/publication-intent`: exact immutable native/Report intent.
- POST `/quarantine/dry-run`, POST `/quarantine`, GET `/quarantine/:quarantineId`: privileged owner-plane evidence migration.

MCP `relayhall_task_native_generation` has only reserve/read/consume/publication-intent/quarantine-dry-run/quarantine/quarantine-read. It preserves the actual caller and supported fixed paths. CLI `native-generation` takes explicit `--action`, `--generation-id`/`--quarantine-id` and bounded JSON `--payload-file`; `task-finish --native-generation-file` supplies the exact finish tuple. No client retry, search adoption, scope issuance or new authentication mechanism is introduced. Privileged quarantine uses existing authenticated owner authority; root cannot be delegated to a newly issued bearer credential.

Publication requestSha256 is reviewDigest({taskId,generationId,executionId,publicationKey,reportId,contentSha256,outcome:'completed'}). The intent's actor, assignment epoch and source/input pins come from the actual current server generation. The existing Report producer is reused; generation code does not create another Report or allow a foreign author.

## Quarantined legacy evidence

SchemaVersion 1 imports exact deployment/store/Task/snapshot identity plus original legacyReservation six fields, ordered bindRows nine fields, consumeRows three fields, jobs, outbox and artifact references. The validator preserves original strings/values, historical timestamps, body text and burned tips; it refuses contradictory chronology, orphan/cyclic/duplicate references and malformed types. The database retains the entire manifest and immutable digest. All corresponding native work is fenced. Dry-run writes nothing; readback grants no authority. There is no cutover, mapping adoption, row deletion or reservation reset endpoint.

Artifact paths/hashes are references only: artifactPresenceVerified=false and backendIngestionVerified=false. In particular, a local accepted outbox row is inert historical evidence and does not prove backend telemetry ingestion. Actual encrypted bytes, file custody and current backend/native reconciliation must be independently verified before any separately designed migration. Historical expiry does not reject legitimate retained evidence and never renews current authority.

## Verification and remaining qualification

Use an owned disposable database named relayhall_native_review_test with the maintained init.sql and migrations. Set the test database URL and stable deployment UUID, then run `npm run test:native-execution`; it exercises real REST/auth/PostgreSQL, two independent service pools, duplicate keys, lost reply readback, claim/epoch/scope/deadline refusal, atomic finish and actual server rejection followed by a second generation. Native completion fixtures are explicitly protocol evidence, not provider execution. Cheap import/MCP/CLI tests and TypeScript checking supplement the real transactions.

Adapter migration, actual local-store import/artifact custody, live provider/process qualification, managed PostgreSQL TLS/writer/failover operation, and combined integration with the separately reviewed task-report workflow remain required later. This source does not enable dispatch or close ordinary commissioning.


Correction of the first independent review (protocol shape unchanged)

Reservation and every current native authority boundary use one semantic dependency predicate: completed, or archived with archive_disposition completed. An abandoned or null archived disposition blocks open, fresh consume, publication intent and joint finish; an archive timestamp alone proves no completion. Evidence-only consumed replay still grants no fresh authority.

The locked joint finish checks import quarantine before its no-generation compatibility return. Both inline-Report and existing-Report generic finish are held on quarantined Tasks, and their tentative Report/stream/reference effects roll back. Nonquarantined legacy finish remains supported. REST, MCP and CLI all use this same finish boundary; none adds a bypass or retries a quarantine refusal.

Public Compose passes the operator-provisioned `RELAYHALL_DEPLOYMENT_ID` unchanged. Provision a different persistent UUID for each environment, retain it across restarts, and never generate an identity at process startup. The examples leave it empty: legacy operations remain available while versioned coordination refuses unbound deployment identity. Full-tier CI explicitly supplies a fixed disposable-test-only identity; that fixture value must never be installed in DEV/TST/PROD.
## Explicit delegated native caps

Preclaim reservation and current native mutation authority apply the same explicit Task WRITE ceiling to both the trusted request chain and freshly resolved chain after the Task row lock. The ceiling supports exact, all-of-type, all-except and all-in-project selectors and every delegated ancestor. `own.scopes=parent` inherits; an explicit scope array must contain `tasks:write` (a literal delegated `root` entry is not an inheritance wildcard). This only narrows authority: it does not require a new positive parent Task WRITE grant or change legacy claimant roles. Service invocation, identity, source/epoch, dependency and original deadline checks still apply.

Owner cancel/reconcile uses the same WRITE ceiling; the existing independent Shepherd custody path remains distinct. Exact already-burned/consumed and closed readbacks remain evidence-only with no fresh launch/lease transition. Task READ recovery is not native WRITE authority. The after-lock credential snapshot intersects the presented scopes with current stored credential scopes and checks revocation, expiry and grace using `clock_timestamp()`, rather than transaction-start time. Physical process custody remains external exact-owned PID/creation/tree evidence; these caps do not establish exactly-once OS process creation.
