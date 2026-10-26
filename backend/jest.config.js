// The literal gate command is `npx jest` with no environment preamble; an
// inherited NODE_ENV=production would flip environment-sensitive suites
// (review d2ed1775 B4). Pin the test environment at config load, before any
// worker spawns, so the gate is deterministic under any caller.
process.env.NODE_ENV = 'test';
// D11 (card 47718b8f, incident 2026-09-18). `src/db/connection.ts` refuses an
// UNSET DB_NAME, because an absent variable is exactly how a spawned review
// session resolved the pool onto the production ClawBoard database. Tier-1 CI
// (.github/workflows/ci.yml job `backend`, and its byte-identical Gitea twin)
// runs `npx jest` with no `env:` block and no PostgreSQL by design, and 251
// files import that module — so the default run must NAME a database or every
// push reds at `require`. This names one that resolves to nothing: the mocked
// suite connects to no database, and a suite that did would fail to connect
// rather than reach a real server.
//
// `||` fills an UNSET value only. An inherited DB_NAME=clawboard /
// DB_HOST=clawboard-db pair — the incident configuration — is left exactly as
// it arrived and is still refused by the guard. Pinned by
// src/__tests__/dbConnectionGuard.test.ts.
process.env.DB_NAME = process.env.DB_NAME || 'relayhall_test_unreachable';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
// AZ-S3 (design 4d961e37 par.7.2): a deterministic TEST keyset so credential
// encryption is exercised in unit tests; production keysets come from the
// deployment environment, never from here.
process.env.RELAYHALL_CREDENTIAL_KEYS = process.env.RELAYHALL_CREDENTIAL_KEYS
  || JSON.stringify({ testkey: Buffer.alloc(32, 7).toString('base64') });
process.env.RELAYHALL_CREDENTIAL_ACTIVE_KEY = process.env.RELAYHALL_CREDENTIAL_ACTIVE_KEY || 'testkey';

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  // Card fb06c930: the retry contract is measured against a REAL PostgreSQL and
  // FAILS — never skips — without one, so it cannot ride the default `npx jest`
  // run, which passes with no database at all. It runs from its own script
  // (`npm run test:idempotency`), on the VM gate chain and UNCONDITIONALLY in
  // CI against a `services: postgres` (owner ruling 94ecf329 item 4).
  // Card 08f42f36: the list/point parity gate measures a SQL predicate against a
  // real PostgreSQL and fails - never skips - without one, for the same reason
  // the retry contract does. It runs from `npm run test:list-parity`, on the VM
  // gate chain and unconditionally in CI against the same `services: postgres`.
  // Card 0b4b779b (RH-KW1 candidate C): the knowledge fan-out set and the board
  // adapter are SQL predicates measured against a REAL PostgreSQL, and the suite
  // FAILS - never skips - without one, for the same reason the two above do. It
  // runs from `npm run test:knowledge-board`, on the VM gate chain and
  // unconditionally in CI against the same `services: postgres`.
  testPathIgnorePatterns: [
    '<rootDir>/src/__tests__/productMetricsLive.test.ts',
    // Card b595b3b0: task activity attribution and reads need migrated PostgreSQL; ci-full runs it by name.
    '<rootDir>/src/__tests__/taskActivityLive.test.ts',
    // Card bedf50cc: plugin availability and settings are measured on stored rows; ci-full runs it by name.
    '<rootDir>/src/__tests__/pluginAvailabilityLive.test.ts',
    // Card 08792425: knowledge source registration is measured on stored rows; ci-full runs it by name.
    '<rootDir>/src/__tests__/knowledgeSourceRegistrationLive.test.ts',
    '<rootDir>/src/__tests__/charterApprovalAuditLive.test.ts',
    // P2-C Task history readers require migrated PostgreSQL; ci-full runs this exact suite.
    'mcpTaskHistoryLive\\.test\\.ts$',
    '<rootDir>/src/__tests__/accountControlLive.test.ts',
    '<rootDir>/src/__tests__/taskAccountOwnershipLive.test.ts',
    // Explicit disposable-PG acquisition race suite; never silently skip.
    '<rootDir>/src/__tests__/idempotencyTakeoverRace.test.ts|ssoRetryConvergence.test.ts',
    // Task9522: exact Unicode persistence requires owned disposable PostgreSQL.
    '<rootDir>/src/__tests__/unicodeImportPersistence.test.ts',
    // Standalone Report atomicity requires the explicit disposable database script.
    '<rootDir>/src/__tests__/standaloneReportAtomicLive.test.ts',
    '<rootDir>/src/__tests__/lifecycleEntrySchedulerLive.test.ts',
    '<rootDir>/src/__tests__/mixedCompletionCleanupLive.test.ts',
    '<rootDir>/src/__tests__/completionReferenceLifecycleLive.test.ts',
    '<rootDir>/src/__tests__/completionReferenceFencingLive.test.ts',
    // Native verification exercises real transactional evidence and authority.
    '<rootDir>/src/__tests__/nativeReviewLive.test.ts',
    '<rootDir>/src/__tests__/nativeExecutionLive.test.ts',
    '<rootDir>/src/__tests__/taskCreatorAccessLive.test.ts',
    // Card ff410dc4 (E407 item 1): the paged grants list against a REAL
    // PostgreSQL; it runs from `npm run test:grants-list` in the full tier.
    '<rootDir>/src/__tests__/grantsListLive.test.ts',
    // Owner rulings E407 item 2, E413 and E418(b): the grant writer, the bulk
    // revoke and the single delete against a REAL PostgreSQL; it runs from
    // `npm run test:grants-bulk-revoke` in the full tier.
    '<rootDir>/src/__tests__/grantsBulkRevokeLive.test.ts',
    '<rootDir>/src/__tests__/assignedClaimLive.test.ts',
    // Card 3fc32dd1: the human claim and progress Report path (real PG).
    '<rootDir>/src/__tests__/humanClaimReportLive.test.ts',
    // Card 41e24358: the default Verifier (inheritance, the usable predicate,
    // the Review warning, the MCP create field and the default write's gates)
    // is measured on a disposable PostgreSQL: npm run test:default-verifier.
    '<rootDir>/src/__tests__/defaultVerifierLive.test.ts',
    // Card 19dd180c: a finish dry run paired with the real finish for the same
    // actor and state, through REST and MCP, on a disposable PostgreSQL:
    // npm run test:finish-dryrun-parity.
    '<rootDir>/src/__tests__/finishDryRunParityLive.test.ts',
    // Card e5240c73: the bounded Task-read lock wait, the native evidence retry
    // and the Report save replay refusal are measured against real row locks.
    '<rootDir>/src/__tests__/taskReadLockLive.test.ts',
    // Dependency concurrency/disclosure requires an explicit disposable PostgreSQL.
    '<rootDir>/src/__tests__/dependencyPlanningLive.test.ts',
    // Scoped connector sockets require the explicit disposable-PostgreSQL full-tier gate.
    '<rootDir>/src/__tests__/connectorNotificationsDb.integration.test.ts',
    // Card 6dea3cca: the wake receipt rows and the spawned-server wake drill
    // ride the same disposable-PostgreSQL gate (npm run test:connector-notifications).
    '<rootDir>/src/__tests__/connectorWakeDb.integration.test.ts',
    '<rootDir>/src/__tests__/connectorWakeProcess.integration.test.ts',
    // Owner ruling E462: wake protocol 2 (verify, stuck, wake.outcome) rides the same gate.
    '<rootDir>/src/__tests__/connectorWakeKindsDb.integration.test.ts',
    // Owner ruling E462 S4b: verification modes (section 6.8) need their disposable PostgreSQL.
    '<rootDir>/src/__tests__/verificationModesLive.test.ts',
    // C9 live Blueprint contract fails closed without its disposable PostgreSQL.
    '<rootDir>/src/__tests__/blueprintLiveContract.test.ts',
    '<rootDir>/src/__tests__/blueprintGateAuthorityLive.test.ts',
    '<rootDir>/src/__tests__/blueprintExamplesLive.test.ts',
    '<rootDir>/src/__tests__/blueprintDescriptorLive.test.ts',
    '<rootDir>/src/__tests__/blueprintSetupLive.test.ts',
    '/node_modules/',
    // Exact Project inheritance is a mandatory real-PostgreSQL gate.
    '<rootDir>/src/__tests__/projectTaskGrantInheritanceLive.test.ts',
    // Explicit Project owner authority/atomicity requires disposable PostgreSQL.
    '<rootDir>/src/__tests__/projectOwnershipLive.test.ts',
    // Immutable versions require a disposable PostgreSQL; the explicit CI gate never skips.
    '<rootDir>/src/__tests__/personalityVersionLive.test.ts',
    '<rootDir>/src/__tests__/idempotencyContract.test.ts',
    '<rootDir>/src/__tests__/listPointParity.test.ts',
    // Card 95572530: which ROWS a project-bounded selector reaches is a
    // property of SQL over real rows. It fails - never skips - without a
    // real PostgreSQL, and runs from `npm run test:project-bounded` on the
    // VM gate chain and unconditionally in CI.
    '<rootDir>/src/__tests__/projectBoundedSelectorLive.test.ts',
    // Cards 6e25ae48 / 3f145fa3: the day-one connection acceptance measures
    // what a REFUSED connection leaves in the database and whether an issued
    // credential authenticates. Both are properties of stored rows, so it
    // fails — never skips — without a real PostgreSQL, and runs from
    // `npm run test:day-one-connection` on the VM gate chain and
    // unconditionally in CI against the same `services: postgres` block.
    '<rootDir>/src/__tests__/dayOneConnectionAcceptance.test.ts',
    // Card bc5cd9f0: the password act measures whether a person can actually
    // SIGN IN after an administrator sets their password, and who may perform
    // that act. Both are properties of the login path over stored rows, so it
    // fails - never skips - without a real PostgreSQL, and runs from
    // `npm run test:password-act` on the VM gate chain and unconditionally in
    // CI against the same `services: postgres` block.
    '<rootDir>/src/__tests__/accountPasswordAct.test.ts',
    // Card a3e76724: step-up for an Identity-provider-only Account is a pending
    // row, a proof, a single-winner collection and a burned token - all stored
    // rows. It fails - never skips - without a real PostgreSQL, and runs from
    // 'npm run test:step-up-sso' and unconditionally in CI against the same
    // 'services: postgres' block.
    '<rootDir>/src/__tests__/stepUpSsoLive.test.ts',
    // Card 8491557e: the touch-burst gate measures POOL behaviour under
    // contention - a tuple lock and a connection ceiling, neither of which a
    // mocked pool has - so it fails, never skips, without a real PostgreSQL,
    // and runs from 'npm run test:touch-burst' on the VM gate chain and
    // unconditionally in CI against the same 'services: postgres' block.
    '<rootDir>/src/__tests__/sessionTouchBurst.test.ts',
    // Card 45e7110a: the mint-target gate reads its expected set back from the
    // POINT ROUTE over real rows, and measures what a refusal discloses. Both
    // are properties of stored rows and a SQL predicate, so it fails - never
    // skips - without a real PostgreSQL, and runs from 'npm run test:mint-target'
    // on the VM gate chain and unconditionally in CI against the same
    // 'services: postgres' block.
    '<rootDir>/src/__tests__/mintTargetAuthorization.test.ts',
    // Cards aad1894b / 91af25a6: who may link a Report to a Task is decided by
    // a SQL predicate over two principals whose identifiers COLLIDE, and only
    // PostgreSQL can resolve that collision - a mocked pool hands back a row
    // already chosen. So it fails, never skips, without a real PostgreSQL, and
    // runs from 'npm run test:report-link' on the VM gate chain and
    // unconditionally in CI against the same 'services: postgres' block.
    '<rootDir>/src/__tests__/reportLinkAuthorization.test.ts',
    '<rootDir>/src/__tests__/taskReportAcceptanceLive.test.ts',
    // Card 50b5e9c4 slice 3: which Reports two principals are COUNTED for one
    // Task is the shared READ predicate over real rows, read back from the
    // point route. Same gate, same script, same CI step.
    '<rootDir>/src/__tests__/taskReportContextLive.test.ts',
    // Card 7f0c84f0: the fail-closed deployment identity is measured by
    // booting the COMPILED server against a REAL migrated PostgreSQL. It
    // fails - never skips - without one or without a current build, and runs
    // from 'npm run test:deployment-identity', which builds first.
    '<rootDir>/src/__tests__/deploymentIdentityBootLive.test.ts',
    '<rootDir>/src/__tests__/kw1KnowledgeBoardAuthorization.test.ts',
    // Card 50e74c1d: the telemetry projection gate measures which rows a
    // caller may READ - a SQL conjunct over stored rows - and whether a
    // replayed batch moves a derived aggregate. Both are properties of a real
    // PostgreSQL, so it fails, never skips, without one, and runs from
    // 'npm run test:telemetry-projection' on the VM gate chain and
    // unconditionally in CI against the same 'services: postgres' block.
    '<rootDir>/src/__tests__/telemetryProjectionAuthorization.test.ts',
    // Card dac2ca71 (RH-TW1b slice 1): the OTLP receivers measured against a
    // REAL PostgreSQL through the production router; fails, never skips, without
    // one. Runs from `npm run test:telemetry-otlp` and in the full CI tier.
    '<rootDir>/src/__tests__/telemetryOtlpReceiverLive.test.ts',
    // Card dac2ca71 (RH-TW1b slice 2): the OTLP/gRPC receivers, the same way,
    // through the production gRPC ingress app; the same script runs both.
    '<rootDir>/src/__tests__/telemetryOtlpGrpcLive.test.ts',
    // Card 35b73092: MCP-derived sessions are telemetry ROWS a Connector's own
    // tool calls leave behind, read back through the production router as each
    // Account, plus a whole-schema diff proving nothing else moved. A mocked
    // pool has no unique key to bound a heartbeat and no schema to diff, so it
    // fails - never skips - without a real PostgreSQL, and runs from
    // 'npm run test:mcp-derived-sessions' on the VM gate chain and
    // unconditionally in CI against the same 'services: postgres' block.
    '<rootDir>/src/__tests__/mcpDerivedSessionsLive.test.ts',
    // Card 9c177e6a: whether a create lands where its author may reach is
    // decided by the shared SQL predicate over real Project and grant rows,
    // and its expected set is READ BACK from the Project point route. It
    // fails - never skips - without a real PostgreSQL, and runs from
    // 'npm run test:project-target' on the VM gate chain and unconditionally
    // in CI against the same 'services: postgres' block.
    '<rootDir>/src/__tests__/taskProjectTargetAuthorization.test.ts',
    // Card f9b7febe: whether every Task point route answers absent and
    // unreadable identically is measured by DRIVING every route the
    // production classifier calls a Task point route, over real rows, and the
    // partition between the route ceiling and the point stage is read off the
    // answers rather than predicted. It fails - never skips - without a real
    // PostgreSQL, and runs from 'npm run test:point-refusal' on the VM gate
    // chain and unconditionally in CI against the same 'services: postgres'
    // block.
    '<rootDir>/src/__tests__/taskPointRefusalShape.test.ts',
    // RH-LENSES-a (card 74e02a05): the carriage seam is a claim about ROWS
    // under LOCKS inside TRANSACTIONS. A mocked pool has no advisory locks,
    // no deadlock detector and no CHECK constraints, so the suite fails -
    // never skips - without a real PostgreSQL, and runs from
    // 'npm run test:carriage' on the VM gate chain and unconditionally in CI
    // against the same 'services: postgres' block.
    '<rootDir>/src/__tests__/directoryCarriageLive.test.ts',
    // Card 590e88cc: the scale-load gate measures how many connections a
    // request takes out of the POOL and what the pool's waiting queue does
    // under concurrent load at estate scale. A mocked pool acquires nothing
    // and has no planner to be wrong, so it fails - never skips - without a
    // real PostgreSQL, and runs from 'npm run test:scale-load' on the VM gate
    // chain and unconditionally in CI against the same 'services: postgres'
    // block.
    '<rootDir>/src/__tests__/scaleReadLoad.test.ts',
    // Cards 9c3a1aa4 / 7d38a6e0: the Task write-field contract measures what
    // POST /tasks actually STORES, compared against what PATCH /tasks/:id
    // stores, and who may read or alter the stored value. The defect it
    // exists for was a column missing from an INSERT, which a mocked pool
    // replays without complaint, so it fails - never skips - without a real
    // PostgreSQL, and runs from 'npm run test:task-write-fields' on the VM
    // gate chain and unconditionally in CI against the same
    // 'services: postgres' block.
    '<rootDir>/src/__tests__/taskWriteFieldContract.test.ts',
    // Card 4287af8a (RH-LENSES-b): whether `SELECT ... FOR SHARE` on the Group
    // row actually BLOCKS a concurrent PATCH, whether a clause flipped while
    // the act waits on that lock is the value the act decides on, and whether a
    // failed second grant insert takes the project row with it are all
    // properties of a real transaction. A mocked pool has no locks, no
    // transactions and no constraints, so the drill fails - never skips -
    // without a real PostgreSQL, and runs from 'npm run test:lenses-home-group'
    // on the VM gate chain and unconditionally in CI against the same
    // 'services: postgres' block.
    '<rootDir>/src/__tests__/lensesCreationDefaultLive.test.ts',
    // Card f87776ad: which provenance a Skill Version's creator may record is
    // decided by migration 083's insert trigger over the creator's stored
    // Principal row, driven here through the production router with a real
    // login session and a real bearer credential. A mocked pool has neither the
    // trigger nor the row, so the suite fails - never skips - without a real
    // PostgreSQL, and runs from 'npm run test:skill-provenance' on the VM gate
    // chain and unconditionally in CI against the same 'services: postgres'
    // block.
    '<rootDir>/src/__tests__/skillDraftProvenanceLive.test.ts',
    // Card d67e6990: Skill ownership and owner-scoped drafts are decided by
    // migration 162's column and trigger and by the owner rows two real
    // Accounts write through the production router. A mocked pool has neither,
    // so the suite fails - never skips - without a real PostgreSQL, and runs
    // from 'npm run test:skill-ownership' and unconditionally in CI against the
    // same 'services: postgres' block.
    '<rootDir>/src/__tests__/skillOwnershipLive.test.ts',
    // Card 1118fefa: whether an ordinary task-scoped Agent can BOOTSTRAP is a
    // property of the credential the approval path stores, the bootstrap row
    // the session route writes and the claim, Report and Review rows the work
    // that follows leaves behind - all over the production router and the MCP
    // ingress. A mocked pool has none of them, so the drill fails - never
    // skips - without a real PostgreSQL, and runs from
    // 'npm run test:session-bootstrap' on the VM gate chain and
    // unconditionally in CI against the same 'services: postgres' block.
    '<rootDir>/src/__tests__/sessionBootstrapScopeLive.test.ts',
    // Card 785e1eed P1-B (AZ-A9): whether a grant request files, is decided by
    // root or an administrator session, writes expiring grant rows the live
    // predicate then reads, and is revoked at task-terminal by both terminal
    // writers is a property of stored approval, grant, audit and task rows over
    // the production router. A mocked pool has none of them, so the drill
    // fails - never skips - without a real PostgreSQL, and runs from
    // 'npm run test:access-requests' on the VM gate chain and unconditionally
    // in CI against the same 'services: postgres' block.
    '<rootDir>/src/__tests__/accessRequestsGrantLive.test.ts',
    // Card 785e1eed P1-B-2 (AZ-A9 clause 13): whether a Connector's credential
    // request files, is decided and narrowed, is collected once by the same
    // credential, yields a key that WORKS, and is revoked at task- and
    // phase-terminal is a property of stored approval, credential, audit and
    // task rows over the production router and the MCP ingress. A mocked pool
    // has none of them, so the drill fails - never skips - without a real
    // PostgreSQL, and runs from 'npm run test:access-requests' beside the grant
    // drill, in the local gate chain and unconditionally in CI.
    '<rootDir>/src/__tests__/accessRequestsCredentialLive.test.ts',
    // Card 7c77fcf3: whether a body carrying the internal execution keys
    // (executionServiceId, executionDescriptorVersion) can move a Task's
    // assignment, descriptor pin, access vehicle or assignment epoch is a
    // property of stored task, vehicle, grant and epoch rows over the
    // production router and the MCP ingress. A mocked pool has none of them,
    // so the drill fails - never skips - without a real PostgreSQL, and runs
    // from 'npm run test:raw-execution-keys' on the local gate chain and
    // unconditionally in CI against the same 'services: postgres' block.
    '<rootDir>/src/__tests__/rawExecutionKeysLive.test.ts',
    // Card c3880767: whether a body carrying a key that names a server-written
    // column of `tasks` can change it, and whether every column of the live
    // table is classified, are properties of stored task rows and of
    // information_schema over the production router and the MCP ingress. A
    // mocked pool has neither, so the drill fails - never skips - without a
    // real PostgreSQL, and runs from npm run test:task-server-written-columns
    // on the local gate chain and unconditionally in CI against the same
    // services: postgres block.
    '<rootDir>/src/__tests__/taskServerWrittenColumnsLive.test.ts',
    // Physical column retirement and canonical evidence require disposable PG.
    '<rootDir>/src/__tests__/taskColumnRetirementLive.test.ts',
    // Card b1e3b16d (hub lane L2): whether a notification is read FOR ONE
    // principal and unread for another, whether mark-all stays inside the
    // caller's filter and visibility, and whether the stuck notice stays
    // addressed are properties of feed, approval, skill and read-state rows over
    // the production router. A mocked pool has none of them, so the drill fails
    // - never skips - without a real PostgreSQL, and runs from
    // 'npm run test:notification-read-state' on the VM gate chain and
    // unconditionally in CI against the same 'services: postgres' block.
    '<rootDir>/src/__tests__/notificationReadStateLive.test.ts',
    // Card 5854f0d6 (Notifications and Timeline, E394): two Accounts, the
    // in-query arms, keyset windows, EXPLAIN on a seeded feed and the payload
    // emits, over the production router. Real PostgreSQL only: it fails, never
    // skips, without one, and runs from 'npm run test:notifications-timeline'.
    '<rootDir>/src/__tests__/notificationsTimelineLive.test.ts',
    // Owner ruling E467 (the Action Center queue for agents): a person's own
    // Connector and an Agent under it list the items waiting on the person's
    // Account, titles only where the caller can read the object, over the
    // production router, the MCP ingress and the CLI. Real PostgreSQL only: it
    // fails, never skips, without one, and runs from 'npm run test:action-items-owner'.
    '<rootDir>/src/__tests__/actionItemsOwnerLive.test.ts',
    // Card b1e3b16d (the approvals hub view): the grouping, the reference
    // titles, the skill-review adapter, the verification requests waiting on a
    // verifier and the decidable flag are read from approval, grant, group,
    // project, task, skill and native review rows over the production router,
    // and `decidable` is checked against the decide route itself. A
    // mocked pool has none of them, so the drill fails - never skips - without
    // a real PostgreSQL, and runs from 'npm run test:approvals-hub' on the VM
    // gate chain and unconditionally in CI against the same
    // 'services: postgres' block.
    '<rootDir>/src/__tests__/approvalsHubLive.test.ts',
    // Card 785e1eed P2-B (AZ-A10 clause 6): the date an assigning act sets on
    // the grant rows its assignment writes, the shared row's maximum over its
    // links, the audit before and after, and the unchanged terminal reapers are
    // properties of stored grant, link, audit and task rows over the production
    // router and the MCP ingress. A mocked pool has none of them, so the drill
    // fails - never skips - without a real PostgreSQL, and runs from
    // 'npm run test:role-grant-expiry' on the VM gate chain and unconditionally
    // in CI against the same 'services: postgres' block.
    '<rootDir>/src/__tests__/roleGrantExpiryLive.test.ts',
    // P2-D live source/evaluator/router parity; mandatory disposable-PG gate.
    '<rootDir>/src/__tests__/authorityPreviewLive.test.ts',
    // Card c334177b: whether an Agent minted with NO object rule can work its
    // bound Task is a property of the approval, credential and own() rows the
    // real approval path stores and of the claim, Report and Review rows the
    // work leaves behind - over the production router and the MCP ingress. A
    // mocked pool has none of them, so the drill fails - never skips - without
    // a real PostgreSQL, and runs from 'npm run test:bound-agent-claim' on the
    // VM gate chain and unconditionally in CI against the same
    // 'services: postgres' block.
    '<rootDir>/src/__tests__/boundAgentClaimLive.test.ts',
    // Owner ruling E462 S5 (N14): whether a task-bounded implementer Agent can
    // claim and finish a Task assigned to its parent Connector is a property of
    // the stored assignment, Warrant, mint, claim and Report rows over the
    // production router. It runs from the same 'npm run test:bound-agent-claim'
    // and fails - never skips - without a disposable PostgreSQL.
    '<rootDir>/src/__tests__/connectorRunClaimLive.test.ts',
    // Card b13e5ac9: where a new Task lands - the Project's inbox phase with
    // status Ideas when no phase is named - is decided inside the creating
    // transaction over the stored project and phase rows, and is proven over
    // the production router, the MCP ingress and the real CLI program for all
    // four creation surfaces. A mocked pool has none of those rows or
    // constraints, so the drill fails - never skips - without a real
    // PostgreSQL, and runs from 'npm run test:inbox-defaults' on the VM gate
    // chain and unconditionally in CI against the same 'services: postgres'
    // block.
    '<rootDir>/src/__tests__/projectInboxDefaultLive.test.ts',
    // Card 785e1eed P1-C: whether the Agent mint ceiling equals the live
    // predicate is measured against Agents the production mint writer stores
    // and acts they then take through the production router and the MCP
    // ingress, over real grant, profile, Project and Task rows. A mocked pool
    // has none of them, so the drill fails - never skips - without a real
    // PostgreSQL, and runs from 'npm run test:mint-ceiling' on the VM gate
    // chain and unconditionally in CI against the same 'services: postgres'
    // block.
    '<rootDir>/src/__tests__/mintCeilingParityLive.test.ts',
    // Card 20f40e40 (AZ-A12 build 1): whether a Group principal is born with
    // its Group, refused as a credential holder, session, member, chain
    // parent, grantee, task role holder or author, guarded on every
    // /principals/:id mutation, left out of the directory, refused deletion
    // while it owns objects, terminated on delete and switched only by a root
    // login session with step-up is a property of stored principal, group,
    // grant, task, report, step-up and audit rows and of migration 146 itself
    // over the production router and the MCP ingress. A mocked pool has none
    // of them, so the drill fails - never skips - without a real PostgreSQL,
    // and runs from 'npm run test:group-principal' on the VM gate chain and
    // unconditionally in CI against the same 'services: postgres' block.
    '<rootDir>/src/__tests__/groupPrincipalLive.test.ts',
    // Card 46cfbd1d (LENSES-c c1-A): whether a Group role row is refused by
    // its holder rules, never edited, live only while its holder is active,
    // a member and not elevated, appointed and removed only by a root login
    // session (or, for a manager row, by a live owner with step-up), counted
    // by GROUP_HAS_STEWARDS, and projected into the catalog and the team-grants
    // read is a property of stored steward, member, grant, step-up and audit
    // rows and of migration 152 itself over the production router. A mocked
    // pool has none of them, so the drill fails - never skips - without a real
    // PostgreSQL, and runs from 'npm run test:lenses-stewards' on the VM gate
    // chain and unconditionally in CI against the same 'services: postgres'
    // block.
    '<rootDir>/src/__tests__/groupStewardsLive.test.ts',
    // Card ee81ee0f (AZ-A12 build 2): whether the owner arm resolves a Group
    // owner by tier (member: read/use/invoke; live owner or manager: the write
    // subset; never admin, shepherd or verify), reaches a Group-owned
    // Project's Phases and Tasks by clause 7's paths and restriction rules,
    // stays on the Account side of the chain and keeps point/list parity is a
    // property of stored principal, member, role, owner and grant rows read by
    // the production predicate. A mocked pool has none of them, so the drill
    // fails - never skips - without a real PostgreSQL, and runs from
    // 'npm run test:group-owner-arm' on the VM gate chain and unconditionally
    // in CI against the same 'services: postgres' block.
    '<rootDir>/src/__tests__/groupOwnerArmLive.test.ts',
    // AZ-A12 build 3 (card 311229fd): the Group ownership transfer act. Its
    // standing test, the step-up it spends, the refusal audit written outside
    // a rolled-back transaction and the creation transaction are properties of
    // stored owners, tokens and audit rows read through the production router
    // and the MCP ingress, so it fails - never skips - without a real
    // PostgreSQL, and runs from 'npm run test:group-ownership-transfer' on the
    // VM gate chain and in the full CI tier.
    '<rootDir>/src/__tests__/groupOwnershipTransferLive.test.ts',
    // Card a9b1e69c (AZ-A12 build 5, clauses 12-13): the hub class order, the
    // owner fields and the feed fan-out are properties of stored owners,
    // grants, steward rows and feed rows read through the production router,
    // so it fails - never skips - without a real PostgreSQL, and runs from
    // 'npm run test:group-owner-hub' and in the full CI tier.
    '<rootDir>/src/__tests__/groupOwnerHubLive.test.ts',
    // Card 1e56dbef (AZ-A12 build 6, clause 12): the Access Explorer read
    // model is compared with the enforcing evaluator over stored principals,
    // credentials, grants, profiles, warrants and owned objects through the
    // production router, so it fails - never skips - without a real
    // PostgreSQL, and runs from 'npm run test:access-explorer' and in the full
    // CI tier.
    '<rootDir>/src/__tests__/accessExplorerLive.test.ts',
    // Card 4e159741 (RH-LENSES-d): the lens contract. Whether a bearer holding
    // root is refused the admin lens while the same Account's login session
    // and dashboard token receive it, and whether every outcome and body of the
    // touched route families and the dashboard family is identical with the
    // lens surface removed (control R-8-v1), are facts about real requests
    // through the production router over stored rows, so it fails - never
    // skips - without a real PostgreSQL, and runs from
    // 'npm run test:lenses-contract' and in the full CI tier.
    '<rootDir>/src/__tests__/lensesContractLive.test.ts',
    // Card b5c83682 (LENSES-c c1-B): the owner-only gates and the manager
    // lens. Whether a live owner-role holder appoints a manager, approves a
    // Group-owned Project's Charter and moves an object out of or into the
    // Group with a step-up - and whether each refusal comes before the token
    // is spent - are properties of stored steward, member, owner, Charter,
    // step-up and audit rows through the production router, so it fails -
    // never skips - without a real PostgreSQL, and runs from
    // 'npm run test:lenses-gates' and in the full CI tier.
    '<rootDir>/src/__tests__/lensesGatesLive.test.ts',
    // RB-11 Governor v0 (card b796067e): the knowledge write door. The
    // fail-closed audit table, the route ceiling that names the write scope,
    // the proposal binding and the schema-wide no-content scan are properties
    // of a real PostgreSQL, the production router, the MCP ingress and a real
    // TLS dial to a stub source. A mocked pool has none of them, so the suite
    // fails - never skips - without a database, and runs from
    // 'npm run test:knowledge-write' on the VM gate chain and unconditionally
    // in CI against the same 'services: postgres' block.
    '<rootDir>/src/__tests__/knowledgeWriteDoorLive.test.ts',
    // Card 1a38270d (AZ-A13 stage 2): editing a Connector credential, a warrant
    // and a grant in place, and the authority-edit Approval kind, are
    // properties of stored credential, warrant, grant, approval, ledger and
    // audit rows and of migration 148 itself, used with the same token through
    // the production router and the MCP ingress. A mocked pool has none of
    // them, so the drill fails - never skips - without a real PostgreSQL, and
    // runs from 'npm run test:authority-edit' on the VM gate chain and
    // unconditionally in CI against the same 'services: postgres' block.
    '<rootDir>/src/__tests__/authorityEditLive.test.ts',
    // Card 1a38270d follow-ups (owner rulings E148 and E149): the residual a
    // revert keeps and the closing record that names it, and the edit routes
    // refusing to add knowledge-contents:write to an Agent credential, are
    // properties of stored credential, warrant, grant, approval, ledger and
    // audit rows, measured through the production router and the MCP ingress.
    // A mocked pool has none of them, so the suite fails - never skips -
    // without a real PostgreSQL, and runs from 'npm run test:authority-edit'
    // beside the stage 2 suite, and unconditionally in CI.
    '<rootDir>/src/__tests__/authorityEditFollowupsLive.test.ts',
    // Card 40e0e542 (owner ruling E127 (5)): the default search scope. Which
    // categories each source is asked to search, what the coverage record says
    // and what a sealed handle opens are measured through the production router
    // and the MCP ingress over real source, descriptor and grant rows and a real
    // TLS dial to a stub source. A mocked pool has none of them, so the suite
    // fails - never skips - without a database, and runs from
    // 'npm run test:knowledge-default-scope' on the VM gate chain and
    // unconditionally in CI against the same 'services: postgres' block.
    '<rootDir>/src/__tests__/knowledgeDefaultScopeLive.test.ts',
    // Card bc847bd0 (owner ruling E159): whether a path id that is not a full
    // UUID is refused by name before anything reads it is measured by driving
    // every route with a path parameter through the production routers and
    // the MCP ingress over stored rows - the defect was PostgreSQL's own cast
    // failure, which a mocked pool does not have. It fails - never skips -
    // without a real PostgreSQL, and runs from 'npm run test:non-uuid-path-ids'
    // on the VM gate chain and unconditionally in CI against the same
    // 'services: postgres' block.
    '<rootDir>/src/__tests__/nonUuidPathIdLive.test.ts',
    // Card 549cc51f (owner rulings E298, E299, E310): the shared-area writer
    // list. Its gate, its step-up, its audit rows, its expiry sweep and the
    // snapshot element are measured through the production router and the MCP
    // ingress over stored writer, step-up and audit rows. A mocked pool has
    // none of them, so the suite fails - never skips - without a database, and
    // runs from 'npm run test:shared-writers' on the VM gate chain and
    // unconditionally in CI against the same 'services: postgres' block.
    '<rootDir>/src/__tests__/knowledgeSharedWritersLive.test.ts',
    // Card 1fd5de08, line 1 (E428): the Knowledge search console's door with two
    // Accounts over real source, descriptor and grant rows and a stub source;
    // it fails - never skips - without a database, and runs from
    // 'npm run test:knowledge-console' unconditionally in the CI full tier.
    '<rootDir>/src/__tests__/knowledgeConsoleLive.test.ts',
    // Card 502fb19e (the universal change request, E325, migration 158): the
    // change kind is filed, decided and applied on stored approval, grant,
    // compartment, writer-list and audit rows, and the lifecycle exporter's
    // carry-over and read-back are measured on the core tables. It fails -
    // never skips - without a disposable PostgreSQL, and runs from
    // 'npm run test:change-requests' in the full tier.
    '<rootDir>/src/__tests__/changeRequestsLive.test.ts',
    // Card 9ce0b0b0 (train T2 of the universal change request, E325): the
    // identity targets - a role through the lifted role-change seam, a new
    // Account, an Account's status on both doors with its cascade, another
    // principal's credential revoked, and the four warrant acts - filed,
    // decided and applied on stored principal, session, credential, warrant
    // and audit rows. It fails - never skips - without a disposable
    // PostgreSQL, and runs from 'npm run test:change-request-targets' in the
    // full tier.
    '<rootDir>/src/__tests__/changeRequestTargetsLive.test.ts',
    // Card 9ce0b0b0 (train T2 slice S5 of the universal change request, E325):
    // the object targets - a Project's owner, a Task's and a Report's account
    // owner, the default Verifiers through the lifted seam, a Charter revision,
    // a Phase goal, a Task's roles, restricted access and a Report's opening
    // visibility - filed, decided and applied on stored rows with the decider
    // as the acting principal. It fails - never skips - without a disposable
    // PostgreSQL, and runs beside the identity section from
    // 'npm run test:change-request-targets' in the full tier.
    '<rootDir>/src/__tests__/changeRequestObjectTargetsLive.test.ts',
    // Card ab8f78e9 (owner ruling E91): the per-session MCP action log through
    // the production MCP server and router - one row per admitted call, the
    // closed error code, no argument stored, the retention sweep, and who may
    // read it. It fails - never skips - without a disposable PostgreSQL, and
    // runs from 'npm run test:mcp-action-log' in the full tier.
    '<rootDir>/src/__tests__/mcpActionLogLive.test.ts',
    // Card e220be94 (owner ruling E353): the plugin bridge's board metrics
    // (queue and throughput for the caller's own Account) are counted over
    // stored task and stream rows through the production router with real
    // session and bearer authentication. It fails - never skips - without a
    // disposable PostgreSQL, and runs from 'npm run test:board-metrics' in
    // the full tier.
    '<rootDir>/src/__tests__/boardMetricsLive.test.ts',
    // Card 76369965: relayhall_lease_claim through the production MCP route
    // and router - claim, exact retry, renew and release for the admitted
    // Connectors, and each route refusal by name. It fails - never skips -
    // without a disposable PostgreSQL, and runs from
    // 'npm run test:mcp-lease-claim' in the full tier.
    '<rootDir>/src/__tests__/mcpLeaseClaimLive.test.ts',
    // Card 2bc7b303 (owner ruling E374): the Subtask structure verbs
    // (relayhall_subtask_create, _reorder, _update_text) through the
    // production MCP route and router - stable ids, positions, permutation
    // refusals, retry receipts and authorization parity with
    // relayhall_subtask_set. It fails - never skips - without a disposable
    // PostgreSQL, and runs from 'npm run test:subtask-structure' in the full
    // tier.
    '<rootDir>/src/__tests__/subtaskStructureLive.test.ts',
    // Card 742fae98: the Map's Reports display mode - per-task Report counts
    // from GET /tasks/graph as two Accounts read them, anchored on each
    // Account's Report point reads, and the Collapsed | Expanded preference
    // stored per principal (migration 165). It fails - never skips - without
    // a disposable PostgreSQL, and runs from 'npm run test:map-reports' in the
    // full tier.
    '<rootDir>/src/__tests__/mapReportsLive.test.ts',
  ],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // No module mapping for the MCP SDK: `@modelcontextprotocol/server` (v2,
  // card bec87735) publishes real `require` exports (`dist/index.cjs`), so
  // jest's resolver and the runtime `require()` reach the same CJS build
  // without help. The v1-era mapping onto `sdk/dist/cjs/*` was dead once the
  // v1 package left the tree, and is gone (owner decision D7).
};
