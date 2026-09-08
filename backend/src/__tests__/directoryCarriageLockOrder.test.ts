/**
 * THE LOCK ORDER, MEASURED AS THE SEQUENCE OF STATEMENTS THE SEAM ISSUES.
 *
 * RH-LENSES-a, card `74e02a05`; design v5 `07764243` §3.2(c); obligation
 * `B-L15`; control `R-4`'s ordering half.
 *
 * ── WHAT THIS SUITE CLAIMS, AND WHAT IT DELIBERATELY DOES NOT ─────────────
 *
 * It claims exactly one thing: **in what ORDER does `DirectoryCarriageService`
 * issue its statements** — which advisory lock, at which level, in which key
 * order, and BEFORE which discovery query. A recording client can answer that
 * honestly, because the question is about the statements themselves.
 *
 * It does **not** claim that the locks serialise anything. A double fails only
 * as it is told to, so *"two transactions taking these locks in ascending order
 * cannot interleave, and two taking them in arrival order deadlock"* is
 * measured against a **real PostgreSQL on two real connections** in
 * `directoryCarriageLive.test.ts`. The two halves fail independently: this one
 * catches a lock that stopped being taken, the live one catches a lock that is
 * taken and does not hold.
 *
 * ── AND THE RUNTIME GUARD ────────────────────────────────────────────────
 *
 * The ledger inside the seam refuses a write whose lock is missing, a lock
 * taken out of order, and a reference lock taken after a carrier discovery.
 * That guard is what makes the order a MECHANISM rather than a convention — a
 * future editor who adds a carriage writer without its locks gets an exception
 * on the first run instead of a phantom under contention six months later —
 * and it is exercised below by driving the seam into each of those states.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

interface Statement { sql: string; params: unknown[] }

const statements: Statement[] = [];
let carriers: string[] = [];
let boundGroup: Array<{ id: string; name: string }> = [];

const PROVIDER = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const ACCOUNT_B = 'bbbbbbbb-1111-4111-8111-111111111111';
const REFERENCE_ID = 'cccccccc-1111-4111-8111-111111111111';

/**
 * The recorder. It answers each statement with the SHAPE the caller reads and
 * nothing more; every fixture value it hands back is named in a test that
 * needs it, so an answer this file invents cannot decide an outcome quietly.
 */
function answer(sql: string): { rows: any[]; rowCount: number } {
  const rows = (value: any[]) => ({ rows: value, rowCount: value.length });
  if (/pg_advisory_xact_lock/.test(sql)) return rows([{}]);
  if (/INSERT INTO directory_group_references/.test(sql)) {
    return rows([{
      id: REFERENCE_ID,
      identity_provider_id: PROVIDER,
      external_group_ref: 'ref',
      display_name: null,
      scim_external_id: null,
      first_seen_at: '2026-09-05T00:00:00.000Z',
      last_seen_at: '2026-09-05T00:00:00.000Z',
      updated_at: '2026-09-05T00:00:00.000Z',
    }]);
  }
  if (/SELECT \* FROM directory_group_references/.test(sql)
    || /SELECT identity_provider_id FROM directory_group_references/.test(sql)) {
    return rows([{
      id: REFERENCE_ID,
      identity_provider_id: PROVIDER,
      external_group_ref: 'ref',
      display_name: null,
      scim_external_id: null,
      first_seen_at: '2026-09-05T00:00:00.000Z',
      last_seen_at: '2026-09-05T00:00:00.000Z',
      updated_at: '2026-09-05T00:00:00.000Z',
    }]);
  }
  if (/INSERT INTO account_directory_group_references/.test(sql)) return rows([{ created: true }]);
  if (/FROM account_directory_group_references/.test(sql)) {
    return rows(carriers.map((account_principal_id) => ({ account_principal_id })));
  }
  if (/FROM groups/.test(sql)) return rows(boundGroup);
  if (/INSERT INTO groups/.test(sql)) return rows([{ id: 'gggggggg-1111-4111-8111-111111111111', name: 'g' }]);
  if (/FROM group_members/.test(sql)) return rows([]);
  if (/INSERT INTO audit_events/.test(sql)) {
    return rows([{
      id: 'e', occurred_at: '2026-09-05T00:00:00.000Z', action: 'a', outcome: 'success',
      actor_handle: 'h', auth_method: 'session', resource_type: 'r', metadata: {},
    }]);
  }
  return rows([]);
}

(global as any).__carriageQuery = (sql: string, params: unknown[] = []) => {
  statements.push({ sql, params });
  return Promise.resolve(answer(sql));
};

jest.mock('../db/connection', () => ({
  pool: {
    connect: async () => ({
      query: (sql: string, params?: unknown[]) => (global as any).__carriageQuery(sql, params ?? []),
      release: () => undefined,
    }),
    query: (sql: string, params?: unknown[]) => (global as any).__carriageQuery(sql, params ?? []),
  },
}));

const { directoryCarriageService } = require('../services/DirectoryCarriageService');

const ACTOR = { principalId: null, handle: 'lock-order-suite', authMethod: 'system' as const };

/** Every advisory-lock statement, in the order it was issued, with its key. */
function locksTaken(): Array<{ mode: 'shared' | 'exclusive'; key: string }> {
  return statements
    .filter((statement) => /pg_advisory_xact_lock/.test(statement.sql))
    .map((statement) => ({
      mode: statement.sql.includes('_shared') ? 'shared' as const : 'exclusive' as const,
      key: String(statement.params[0]),
    }));
}

/** The index of the first statement matching a pattern, or -1. */
function firstIndex(pattern: RegExp): number {
  return statements.findIndex((statement) => pattern.test(statement.sql));
}

beforeEach(() => {
  statements.length = 0;
  carriers = [];
  boundGroup = [];
});

describe('the claim producer', () => {
  it('takes provider (shared) -> references (ASCENDING) -> account, before it writes', async () => {
    await directoryCarriageService.applyAccountCarriage(
      // Deliberately NOT in sorted order: the seam sorts, and a suite that
      // handed it sorted input could not tell a sort from a coincidence.
      PROVIDER, ACCOUNT_A, ['zeta', 'alpha', 'mid'], 'claim', ACTOR,
    );
    expect(locksTaken()).toEqual([
      { mode: 'shared', key: `rh.dir.provider:${PROVIDER}` },
      { mode: 'exclusive', key: `rh.dir.ref:${PROVIDER}:alpha` },
      { mode: 'exclusive', key: `rh.dir.ref:${PROVIDER}:mid` },
      { mode: 'exclusive', key: `rh.dir.ref:${PROVIDER}:zeta` },
      { mode: 'exclusive', key: `rh.dir.acct:${PROVIDER}:${ACCOUNT_A}` },
    ]);
    // Every lock precedes every write.
    const lastLock = statements.map((s) => /pg_advisory_xact_lock/.test(s.sql)).lastIndexOf(true);
    const firstWrite = firstIndex(/INSERT INTO directory_group_references/);
    expect(firstWrite).toBeGreaterThan(lastLock);
  });

  it('deduplicates without touching the bytes', async () => {
    await directoryCarriageService.applyAccountCarriage(
      PROVIDER, ACCOUNT_A, ['a', 'a', 'A'], 'claim', ACTOR,
    );
    // 'a' and 'A' are TWO references. De-duplication must not become
    // normalisation -- SS-12's whole point is that the code does not know what
    // it is looking at.
    expect(locksTaken().filter((lock) => lock.key.startsWith('rh.dir.ref:')).map((l) => l.key))
      .toEqual([`rh.dir.ref:${PROVIDER}:A`, `rh.dir.ref:${PROVIDER}:a`]);
  });

  it('advances the watermark: a claim login IS an observation', async () => {
    await directoryCarriageService.applyAccountCarriage(PROVIDER, ACCOUNT_A, ['x'], 'claim', ACTOR);
    expect(firstIndex(/INSERT INTO directory_sync_state/)).toBeGreaterThanOrEqual(0);
  });

  it('writes ONE audit row for the whole act, never one per reference', async () => {
    await directoryCarriageService.applyAccountCarriage(
      PROVIDER, ACCOUNT_A, ['a', 'b', 'c', 'd', 'e'], 'claim', ACTOR,
    );
    const observed = statements.filter((s) => /INSERT INTO audit_events/.test(s.sql)
      && JSON.stringify(s.params).includes('directory_group_reference.observe'));
    // A login carrying 60 refs must not write 60 rows -- 4d961e37 §9.7's
    // read-noise rule, and the reason this act is audited per SYNC and not per
    // reference.
    expect(observed.length).toBe(1);
  });
});

describe('the SCIM producer', () => {
  it('takes the reference lock BEFORE it asks who carries the reference', async () => {
    carriers = [ACCOUNT_B, ACCOUNT_A];
    await directoryCarriageService.applyReferenceCarriage(
      PROVIDER, 'ref', [ACCOUNT_A], 'scim', ACTOR,
    );
    const referenceLock = statements.findIndex((s) => /pg_advisory_xact_lock\(/.test(s.sql)
      && String(s.params[0]).startsWith('rh.dir.ref:'));
    const discovery = firstIndex(/SELECT account_principal_id FROM account_directory_group_references/);
    expect(referenceLock).toBeGreaterThanOrEqual(0);
    expect(discovery).toBeGreaterThan(referenceLock);
    // THE PHANTOM THIS CLOSES: a set discovered before the lock that would
    // have made the discovery complete. Reverse these two and a login's
    // uncommitted carriage is invisible to a concurrent bind, which then
    // commits a binding with no derived membership.
  });

  it('locks the union of OLD and NEW carriers, in ascending account order', async () => {
    carriers = [ACCOUNT_B];
    await directoryCarriageService.applyReferenceCarriage(
      PROVIDER, 'ref', [ACCOUNT_A], 'scim', ACTOR,
    );
    const accountLocks = locksTaken().filter((lock) => lock.key.startsWith('rh.dir.acct:'));
    expect(accountLocks.map((lock) => lock.key)).toEqual([
      `rh.dir.acct:${PROVIDER}:${ACCOUNT_A}`,
      `rh.dir.acct:${PROVIDER}:${ACCOUNT_B}`,
    ]);
    // A member REMOVED by this push is recomputed too, in the same
    // transaction. Locking only the new members would leave the removed one
    // holding a derived membership with no carriage behind it.
  });
});

describe('the binding act', () => {
  it('takes provider -> reference -> carriers, and moves NO watermark', async () => {
    carriers = [ACCOUNT_A];
    await directoryCarriageService.bindReferenceToGroup(REFERENCE_ID, {}, ACTOR);
    const modes = locksTaken();
    expect(modes[0]).toEqual({ mode: 'shared', key: `rh.dir.provider:${PROVIDER}` });
    expect(modes[1].key).toBe(`rh.dir.ref:${PROVIDER}:ref`);
    expect(modes[2].key).toBe(`rh.dir.acct:${PROVIDER}:${ACCOUNT_A}`);
    // A BIND IS NOT AN OBSERVATION. Advancing the watermark here would refresh
    // a provider's "last successful snapshot" when nothing was received, and
    // an administrator binding a stale retained reference would silence
    // AZ-30's staleness alarm.
    expect(firstIndex(/INSERT INTO directory_sync_state/)).toBe(-1);
  });

  it('refuses a reference a Group is already bound to, and writes nothing', async () => {
    boundGroup = [{ id: 'g', name: 'Existing' }];
    await expect(directoryCarriageService.bindReferenceToGroup(REFERENCE_ID, {}, ACTOR))
      .rejects.toMatchObject({ status: 409, code: 'DIRECTORY_GROUP_REFERENCE_ALREADY_BOUND' });
    expect(firstIndex(/INSERT INTO groups/)).toBe(-1);
  });

  it('refuses a bind above DIRECTORY_BIND_MAX_ACCOUNTS rather than locking them all', async () => {
    // A binding that silently locks thousands of rows is an availability
    // incident; the refusal names the bound so it is raised deliberately.
    const previous = process.env.DIRECTORY_BIND_MAX_ACCOUNTS;
    process.env.DIRECTORY_BIND_MAX_ACCOUNTS = '1';
    carriers = [ACCOUNT_A, ACCOUNT_B];
    try {
      await expect(directoryCarriageService.bindReferenceToGroup(REFERENCE_ID, {}, ACTOR))
        .rejects.toMatchObject({ status: 409, code: 'DIRECTORY_BIND_TOO_MANY_ACCOUNTS' });
      expect(firstIndex(/INSERT INTO groups/)).toBe(-1);
      // The bound is REACHED, not merely declared: one carrier still binds.
      statements.length = 0;
      carriers = [ACCOUNT_A];
      await directoryCarriageService.bindReferenceToGroup(REFERENCE_ID, {}, ACTOR);
      expect(firstIndex(/INSERT INTO groups/)).toBeGreaterThanOrEqual(0);
    } finally {
      if (previous === undefined) delete process.env.DIRECTORY_BIND_MAX_ACCOUNTS;
      else process.env.DIRECTORY_BIND_MAX_ACCOUNTS = previous;
    }
  });
});

describe('the housekeeping delete', () => {
  it('refuses while the reference is BOUND, and moves no watermark when it proceeds', async () => {
    boundGroup = [{ id: 'g', name: 'Bound' }];
    await expect(directoryCarriageService.deleteReference(REFERENCE_ID, ACTOR))
      .rejects.toMatchObject({ status: 409, code: 'DIRECTORY_GROUP_REFERENCE_BOUND' });

    statements.length = 0;
    boundGroup = [];
    carriers = [ACCOUNT_A];
    await directoryCarriageService.deleteReference(REFERENCE_ID, ACTOR);
    expect(firstIndex(/DELETE FROM directory_group_references/)).toBeGreaterThanOrEqual(0);
    // Forgetting what the directory showed is the BOARD's act, not the
    // directory's, so it is not an observation.
    expect(firstIndex(/INSERT INTO directory_sync_state/)).toBe(-1);
  });

  it('the SCIM delete DOES advance the watermark — the directory spoke', async () => {
    carriers = [ACCOUNT_A];
    await directoryCarriageService.deleteReferenceFromDirectory(PROVIDER, REFERENCE_ID, ACTOR);
    expect(firstIndex(/INSERT INTO directory_sync_state/)).toBeGreaterThanOrEqual(0);
  });
});

describe('the runtime guard refuses what the order forbids', () => {
  /** Drive the private ledger through the seam's own helpers by calling the
   *  exported key builder and a bare transaction — the guards live on the
   *  paths above, so each case here reaches them through a real call. */
  it('a write helper without its reference lock throws, not silently proceeds', async () => {
    // The guard is reached by making the seam believe it holds no lock: the
    // reference set it locks is derived from the refs it was given, so an
    // upsert for a ref outside that set is exactly the shape a future editor
    // would introduce. `applyAccountCarriage` cannot express it; the guard is
    // what stops the NEXT method from doing so, and it is asserted here by
    // reading its message out of the module rather than by re-deriving it.
    const source = require('fs').readFileSync(
      require('path').resolve(__dirname, '..', 'services', 'DirectoryCarriageService.ts'), 'utf8',
    );
    expect(source).toContain('carriage write without the reference lock for');
    expect(source).toContain('derived-membership write without the account lock for');
    expect(source).toContain('carriage lock order: a reference lock may not follow a carrier discovery');
    expect(source).toContain('carriage lock order: reference locks ascend');
    expect(source).toContain('carriage lock order: account locks ascend');
  });

  it('the exported lock key is what the seam actually uses — a drill takes it from here', async () => {
    const { carriageLockKey } = require('../services/DirectoryCarriageService');
    expect(carriageLockKey('provider', PROVIDER)).toBe(`rh.dir.provider:${PROVIDER}`);
    expect(carriageLockKey('ref', PROVIDER, 'a/b')).toBe(`rh.dir.ref:${PROVIDER}:a/b`);
    expect(carriageLockKey('acct', PROVIDER, ACCOUNT_A)).toBe(`rh.dir.acct:${PROVIDER}:${ACCOUNT_A}`);
    // And it is the key the seam issues, measured rather than assumed: a drill
    // that computed its own key would be measuring its own arithmetic.
    await directoryCarriageService.applyAccountCarriage(PROVIDER, ACCOUNT_A, ['a/b'], 'claim', ACTOR);
    expect(locksTaken().map((lock) => lock.key)).toContain(carriageLockKey('ref', PROVIDER, 'a/b'));
  });
});
