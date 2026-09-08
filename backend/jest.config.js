// The literal gate command is `npx jest` with no environment preamble; an
// inherited NODE_ENV=production would flip environment-sensitive suites
// (review d2ed1775 B4). Pin the test environment at config load, before any
// worker spawns, so the gate is deterministic under any caller.
process.env.NODE_ENV = 'test';
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
    // C9 live Blueprint contract fails closed without its disposable PostgreSQL.
    '<rootDir>/src/__tests__/blueprintLiveContract.test.ts',
    '<rootDir>/src/__tests__/blueprintGateAuthorityLive.test.ts',
    '<rootDir>/src/__tests__/blueprintExamplesLive.test.ts',
    '<rootDir>/src/__tests__/blueprintDescriptorLive.test.ts',
    '<rootDir>/src/__tests__/blueprintSetupLive.test.ts',
    '/node_modules/',
    // Exact Project inheritance is a mandatory real-PostgreSQL gate.
    '<rootDir>/src/__tests__/projectTaskGrantInheritanceLive.test.ts',
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
    '<rootDir>/src/__tests__/kw1KnowledgeBoardAuthorization.test.ts',
    // Card 50e74c1d: the telemetry projection gate measures which rows a
    // caller may READ - a SQL conjunct over stored rows - and whether a
    // replayed batch moves a derived aggregate. Both are properties of a real
    // PostgreSQL, so it fails, never skips, without one, and runs from
    // 'npm run test:telemetry-projection' on the VM gate chain and
    // unconditionally in CI against the same 'services: postgres' block.
    '<rootDir>/src/__tests__/telemetryProjectionAuthorization.test.ts',
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
  ],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // No module mapping for the MCP SDK: `@modelcontextprotocol/server` (v2,
  // card bec87735) publishes real `require` exports (`dist/index.cjs`), so
  // jest's resolver and the runtime `require()` reach the same CJS build
  // without help. The v1-era mapping onto `sdk/dist/cjs/*` was dead once the
  // v1 package left the tree, and is gone (owner decision D7).
};
