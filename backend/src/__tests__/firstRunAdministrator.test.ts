/**
 * THE FIRST-RUN ADMINISTRATOR ACT (owner ruling `60307311` §1.1; card `27322abb`).
 *
 * The route and the service are the PRODUCTION ones — `routes/auth` mounted as
 * `server.ts` mounts it, `FirstRunService`, `PrincipalService.createPrincipal`,
 * `AuditService.record` and `validateNewHandle` all real. Only PostgreSQL and
 * the session store are doubles.
 *
 * WHY THE DATABASE IS A RECORDING DOUBLE RATHER THAN A STUBBED SERVICE. The
 * act's central claim is that the Account, its password credential and its
 * audit row commit TOGETHER: a crash between them leaves a deployment holding
 * an administrator nobody can log in as, and the first-run step closed behind
 * them. That claim is about WHICH CONNECTION each statement went down and in
 * what order, so the double records exactly that and the assertions read it
 * back. Stubbing `createFirstAdministrator` would have deleted the claim and
 * kept the test.
 *
 * The one thing this suite cannot prove is that the advisory lock actually
 * serialises two concurrent callers — no double can fail like a real lock
 * manager. That is drilled against a real migrated PostgreSQL on the lane
 * portal, with two concurrent requests and exactly one 201, and this suite does
 * not pretend otherwise.
 */
import express from 'express';
import bcrypt from 'bcrypt';
import type { AddressInfo } from 'net';

const JWT_SECRET = 'first-run-suite-secret-0123456789';
process.env.JWT_SECRET = JWT_SECRET;
process.env.RELAYHALL_SESSIONS = 'on';
const DEPLOYMENT_PASSWORD = 'the-deployment-password';

/** What the doubled database currently holds. */
const db = {
  administratorExists: false,
  /** Every statement, in order, with the connection object it went down. */
  log: [] as Array<{ sql: string; params: unknown[]; on: 'pool' | 'client' }>,
  /** Set when the handle INSERT should behave as a unique-index conflict. */
  handleTaken: false,
};

const CREATED_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function answer(sql: string, params: unknown[]): { rows: any[]; rowCount: number } {
  const text = sql.replace(/\s+/g, ' ').trim();
  if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(text)) return { rows: [], rowCount: 0 };
  if (text.includes('pg_advisory_xact_lock')) return { rows: [{ pg_advisory_xact_lock: '' }], rowCount: 1 };
  if (text.includes('FROM principals') && text.includes('role = ANY')) {
    return db.administratorExists ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (text.startsWith('INSERT INTO principals')) {
    if (db.handleTaken) return { rows: [], rowCount: 0 };
    const [kind, handle, displayName, role] = params as string[];
    return {
      rows: [{
        id: CREATED_ID, kind, handle, display_name: displayName, status: 'active', role,
        parent_principal_id: null, bound_task_id: null, purpose: null, legacy_identity: false,
        own_expression: null, source_tag: null, harness: null, personality_id: null,
        last_seen_at: null, metadata: {},
      }],
      rowCount: 1,
    };
  }
  if (text.startsWith('INSERT INTO principal_credentials')) {
    return { rows: [{ id: 'credential-1' }], rowCount: 1 };
  }
  if (text.startsWith('INSERT INTO audit_events')) {
    return {
      rows: [{
        id: 'audit-1', occurred_at: new Date(), action: params[0], outcome: params[1],
        actor_principal_id: params[2], actor_handle: params[3], auth_method: params[4],
        credential_id: params[5], resource_type: params[6], resource_id: params[7], metadata: {},
      }],
      rowCount: 1,
    };
  }
  if (text.startsWith('SELECT * FROM principals WHERE handle')) {
    return { rows: [], rowCount: 0 };
  }
  return { rows: [], rowCount: 0 };
}

const client = {
  query: jest.fn(async (sql: string, params: unknown[] = []) => {
    db.log.push({ sql: sql.replace(/\s+/g, ' ').trim(), params, on: 'client' });
    return answer(sql, params);
  }),
  release: jest.fn(),
};

jest.mock('../db/connection', () => ({
  pool: {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      db.log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params, on: 'pool' });
      return answer(String(sql), params);
    }),
    connect: jest.fn(async () => client),
  },
  BOOT_CHECK_MODE: false,
}));

const sessionMint = jest.fn(async () => ({
  sessionId: 'session-1', token: 'session-token-1', expiresAt: new Date(Date.now() + 3_600_000),
}));
const sessionRevoke = jest.fn(async () => 1);

jest.mock('../services/LoginSessionService', () => ({
  SESSION_COOKIE_NAME: 'relayhall_session',
  sessionAbsoluteMs: () => 3_600_000,
  loginSessionService: {
    mint: (...args: unknown[]) => sessionMint(...(args as [])),
    revoke: (...args: unknown[]) => sessionRevoke(...(args as [])),
    resolve: jest.fn(async () => undefined),
    list: jest.fn(async () => []),
    revokeAllForPrincipal: jest.fn(async () => 0),
    ownsSession: jest.fn(async () => false),
    touch: jest.fn(),
  },
}));

let server: ReturnType<typeof express.application.listen>;
let base: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let firstRunService: any;

beforeAll(async () => {
  process.env.DASHBOARD_PASSWORD_HASH = await bcrypt.hash(DEPLOYMENT_PASSWORD, 4);
  const authRouter = (await import('../routes/auth')).default;
  firstRunService = (await import('../services/FirstRunService')).firstRunService;
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll((done) => { server.close(() => done()); });

beforeEach(() => {
  db.administratorExists = false;
  db.handleTaken = false;
  db.log.length = 0;
  sessionMint.mockClear();
  sessionRevoke.mockClear();
  firstRunService.resetForTests();
  // The throttle is REAL and shared with both login doors, and this suite
  // deliberately drives refusal after refusal — every one of which records a
  // failure, exactly as it should in production. Clearing the bucket between
  // cases keeps the suite measuring the act rather than the backoff curve
  // (which loginRateLimit.test.ts measures on its own).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { loginThrottle } = require('../middleware/loginRateLimit');
  for (const key of ['::ffff:127.0.0.1', '127.0.0.1', '::1']) loginThrottle.recordSuccess(key);
  // The principal read caches outlive a test otherwise, and a negative entry
  // for a handle created in one case would answer the next one.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../services/PrincipalService').principalService.invalidateHandles(['ada', 'dashboard_user']);
});

async function post(path: string, body: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers };
}

const GOOD = { handle: 'ada', displayName: 'Ada Lovelace', password: 'a-long-enough-password' };

describe('the first-run act', () => {
  it('creates the administrator, signs them in, and says what it made', async () => {
    const { status, body, headers } = await post('/auth/first-run', GOOD);
    expect(status).toBe(201);
    expect(body.principal).toEqual({ handle: 'ada', displayName: 'Ada Lovelace', role: 'admin' });
    // The session is delivered ONLY as an httpOnly cookie — never as a token
    // a script could read or replay as a bearer value (SS-16 / AZ-18).
    expect(body.token).toBeUndefined();
    const cookies = String(headers.get('set-cookie') ?? '');
    expect(cookies).toContain('relayhall_session=session-token-1');
    expect(cookies.toLowerCase()).toContain('httponly');
  });

  it('commits the Account, its password and its audit row on ONE connection, in order', async () => {
    await post('/auth/first-run', GOOD);
    const onClient = db.log.filter((entry) => entry.on === 'client').map((entry) => entry.sql);
    const shape = onClient.map((sql) => {
      if (/^BEGIN$/i.test(sql)) return 'BEGIN';
      if (/^COMMIT$/i.test(sql)) return 'COMMIT';
      if (sql.includes('pg_advisory_xact_lock')) return 'LOCK';
      if (sql.includes('FROM principals') && sql.includes('role = ANY')) return 'CHECK';
      if (sql.startsWith('INSERT INTO principals')) return 'PRINCIPAL';
      if (sql.startsWith('INSERT INTO principal_credentials')) return 'PASSWORD';
      if (sql.startsWith('INSERT INTO audit_events')) return 'AUDIT';
      return sql;
    });
    expect(shape).toEqual(['BEGIN', 'LOCK', 'CHECK', 'PRINCIPAL', 'PASSWORD', 'AUDIT', 'COMMIT']);
    // None of the ACT'S OWN writes touched the pool: a statement outside the
    // transaction could survive its rollback, and that is the whole claim.
    // (The session-login ledger line that follows the COMMIT is deliberately
    // on the pool — it records a session minted from an Account that already
    // exists, and `POST /auth/session` writes it the same way.)
    const escaped = db.log.filter((entry) => entry.on === 'pool' && (
      entry.sql.startsWith('INSERT INTO principals')
      || entry.sql.startsWith('INSERT INTO principal_credentials')
      || (entry.sql.startsWith('INSERT INTO audit_events') && entry.params[0] === 'first_run.administrator_created')
    ));
    expect(escaped).toEqual([]);
  });

  it('audits `first_run.administrator_created` against the new Account', async () => {
    await post('/auth/first-run', GOOD);
    const audit = db.log.find((entry) => entry.sql.startsWith('INSERT INTO audit_events'));
    expect(audit).toBeDefined();
    expect(audit!.params[0]).toBe('first_run.administrator_created');
    expect(audit!.params[7]).toBe(CREATED_ID);
    expect(audit!.on).toBe('client');
  });

  it('the created Account is a parentless HUMAN Account with the admin role', async () => {
    await post('/auth/first-run', GOOD);
    const insert = db.log.find((entry) => entry.sql.startsWith('INSERT INTO principals'));
    expect(insert!.params.slice(0, 4)).toEqual(['human', 'ada', 'Ada Lovelace', 'admin']);
  });

  it('the password is stored as a `password` credential with a NULL key_id', async () => {
    await post('/auth/first-run', GOOD);
    const insert = db.log.find((entry) => entry.sql.startsWith('INSERT INTO principal_credentials'));
    expect(insert!.sql).toContain("'password'");
    expect(insert!.sql).not.toContain('key_id');
    // Stored hashed, never in the clear.
    expect(String(insert!.params[1])).not.toContain(GOOD.password);
    expect(String(insert!.params[1]).startsWith('$2')).toBe(true);
  });
});

describe('the act is admissible only while no administrator exists', () => {
  it('a SECOND first-run attempt is refused 409 and writes nothing', async () => {
    const first = await post('/auth/first-run', GOOD);
    expect(first.status).toBe(201);
    db.log.length = 0;
    // The service has now SEEN an administrator; the substrate agrees.
    db.administratorExists = true;
    const second = await post('/auth/first-run', { ...GOOD, handle: 'bob' });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('FIRST_RUN_CLOSED');
    expect(db.log.filter((entry) => /^INSERT/i.test(entry.sql))).toEqual([]);
  });

  it('the TRANSACTIONAL re-check refuses on its own, with the outer one passing', async () => {
    // The outer check and the in-transaction one are two gates on the same
    // state, and the outer one fires first — so removing it reddens nothing
    // (the drill's M9 measured exactly that). This case reaches the INNER gate
    // by letting the outer see no administrator and the transaction see one,
    // which is also the real race: an administrator created between the two.
    const originalQuery = client.query;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).query = jest.fn(async (sql: string, params: unknown[] = []) => {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      db.log.push({ sql: text, params, on: 'client' });
      if (text.includes('FROM principals') && text.includes('role = ANY')) {
        return { rows: [{ '?column?': 1 }], rowCount: 1 };
      }
      return answer(String(sql), params);
    });
    try {
      const { status, body } = await post('/auth/first-run', GOOD);
      expect(status).toBe(409);
      expect(body.code).toBe('FIRST_RUN_CLOSED');
      const sqls = db.log.map((entry) => entry.sql);
      // It got as far as the lock and then rolled back: no row was written.
      expect(sqls.some((sql) => sql.includes('pg_advisory_xact_lock'))).toBe(true);
      expect(sqls.some((sql) => sql.startsWith('INSERT INTO principals'))).toBe(false);
      expect(sqls.some((sql) => /^ROLLBACK$/i.test(sql))).toBe(true);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).query = originalQuery;
    }
  });

  it('a deployment that already had an administrator never sees the step at all', async () => {
    db.administratorExists = true;
    const { status, body } = await post('/auth/first-run', GOOD);
    expect(status).toBe(409);
    expect(body.code).toBe('FIRST_RUN_CLOSED');
  });

  it('an unreadable substrate refuses rather than granting a free administrator', async () => {
    const connection = require('../db/connection');
    const original = connection.pool.query;
    connection.pool.query = jest.fn(async () => { throw new Error('substrate down'); });
    try {
      const { status, body } = await post('/auth/first-run', GOOD);
      expect(status).toBe(503);
      expect(body.code).toBe('FIRST_RUN_UNAVAILABLE');
    } finally {
      connection.pool.query = original;
    }
  });
});

describe('what the act refuses to be given', () => {
  it('refuses the reserved break-glass handle', async () => {
    const { status, body } = await post('/auth/first-run', { ...GOOD, handle: 'dashboard_user' });
    expect(status).toBe(400);
    expect(body.code).toBe('INVALID_HANDLE');
    expect(db.log.filter((entry) => /^INSERT/i.test(entry.sql))).toEqual([]);
  });

  it('refuses a spawn-prefixed handle', async () => {
    const { status, body } = await post('/auth/first-run', { ...GOOD, handle: 'agent:sneaky' });
    expect(status).toBe(400);
    expect(body.code).toBe('INVALID_HANDLE');
  });

  it('refuses a password below the shared policy minimum', async () => {
    const { status, body } = await post('/auth/first-run', { ...GOOD, password: 'short' });
    expect(status).toBe(422);
    expect(body.code).toBe('PASSWORD_TOO_SHORT');
    expect(db.log.filter((entry) => /^INSERT/i.test(entry.sql))).toEqual([]);
  });

  it('refuses a password bcrypt would silently truncate', async () => {
    const { status, body } = await post('/auth/first-run', { ...GOOD, password: 'x'.repeat(73) });
    expect(status).toBe(422);
    expect(body.code).toBe('PASSWORD_TOO_LONG');
  });

  it('answers a handle collision as a conflict, not a 500', async () => {
    db.handleTaken = true;
    const { status, body } = await post('/auth/first-run', GOOD);
    expect(status).toBe(409);
    expect(body.code).toBe('HANDLE_TAKEN');
  });

  it('rolls back rather than leaving half an administrator when the audit write fails', async () => {
    const originalQuery = client.query;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).query = jest.fn(async (sql: string, params: unknown[] = []) => {
      db.log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params, on: 'client' });
      if (String(sql).replace(/\s+/g, ' ').trim().startsWith('INSERT INTO audit_events')) {
        throw new Error('ledger down');
      }
      return answer(String(sql), params);
    });
    try {
      const { status } = await post('/auth/first-run', GOOD);
      expect(status).toBe(500);
      const sqls = db.log.map((entry) => entry.sql);
      expect(sqls.some((sql) => /^ROLLBACK$/i.test(sql))).toBe(true);
      expect(sqls.some((sql) => /^COMMIT$/i.test(sql))).toBe(false);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).query = originalQuery;
    }
  });
});

describe('the session substrate gates the step', () => {
  it('with RELAYHALL_SESSIONS off the step is not offered at all', async () => {
    process.env.RELAYHALL_SESSIONS = '';
    try {
      const { status, body } = await post('/auth/first-run', GOOD);
      expect(status).toBe(404);
      expect(body.code).toBe('SESSIONS_DISABLED');
      expect(await firstRunService.firstRunAvailable()).toBe(false);
    } finally {
      process.env.RELAYHALL_SESSIONS = 'on';
    }
  });
});

describe('the no-administrator state itself', () => {
  it('offers the step while no administrator exists, and withholds it once one does', async () => {
    expect(await firstRunService.firstRunAvailable()).toBe(true);
    db.administratorExists = true;
    firstRunService.resetForTests();
  // The throttle is REAL and shared with both login doors, and this suite
  // deliberately drives refusal after refusal — every one of which records a
  // failure, exactly as it should in production. Clearing the bucket between
  // cases keeps the suite measuring the act rather than the backoff curve
  // (which loginRateLimit.test.ts measures on its own).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { loginThrottle } = require('../middleware/loginRateLimit');
  for (const key of ['::ffff:127.0.0.1', '127.0.0.1', '::1']) loginThrottle.recordSuccess(key);
    expect(await firstRunService.firstRunAvailable()).toBe(false);
  });

  it('caches only the POSITIVE answer — a negative one is re-read every time', async () => {
    // The asymmetry IS the control: a cached negative would hold the step open
    // after somebody walked through it.
    //
    // The FIRST pair is what a cache-everything defect fails on. An earlier
    // version of this case only changed the substrate between calls, and a
    // service that cached BOTH answers passed it — the mutation drill said so
    // (M11 reddened eight unrelated assertions and neither of these). Asking
    // the same question twice with NOTHING changed is the question that
    // distinguishes them: a cached negative would come back as `true` on the
    // second call, because the flag was set on the first.
    expect(await firstRunService.administratorExists()).toBe(false);
    expect(await firstRunService.administratorExists()).toBe(false);
    // Two queries, not one served from a cache.
    expect(db.log.filter((entry) => entry.sql.includes('role = ANY')).length).toBe(2);

    db.administratorExists = true;
    expect(await firstRunService.administratorExists()).toBe(true);
    // ...and now the positive answer sticks even if the substrate says otherwise.
    db.administratorExists = false;
    expect(await firstRunService.administratorExists()).toBe(true);
  });

  it('an unreadable substrate withholds the step rather than advertising it', async () => {
    const connection = require('../db/connection');
    const original = connection.pool.query;
    connection.pool.query = jest.fn(async () => { throw new Error('substrate down'); });
    try {
      expect(await firstRunService.firstRunAvailable()).toBe(false);
    } finally {
      connection.pool.query = original;
    }
  });

  it('asks about ACTIVE PARENTLESS HUMAN Accounts holding admin or operator', async () => {
    await firstRunService.administratorExists();
    const probe = db.log.find((entry) => entry.sql.includes('FROM principals') && entry.sql.includes('role = ANY'));
    expect(probe).toBeDefined();
    expect(probe!.sql).toContain("kind = 'human'");
    expect(probe!.sql).toContain("status = 'active'");
    expect(probe!.sql).toContain('parent_principal_id IS NULL');
    expect(probe!.params[0]).toEqual(['admin', 'operator']);
  });
});

describe('the break-glass announcement', () => {
  it('says so when an administrator Account exists', async () => {
    db.administratorExists = true;
    const { status, body } = await post('/auth/login', { password: DEPLOYMENT_PASSWORD });
    expect(status).toBe(200);
    expect(body.breakGlass).toBe(true);
    expect(body.administratorExists).toBe(true);
    const audit = db.log.find((entry) => entry.sql.startsWith('INSERT INTO audit_events'));
    expect(audit!.params[0]).toBe('auth.break_glass.login');
    expect(JSON.parse(String(audit!.params[8]))).toMatchObject({ administratorExists: true });
  });

  it('stays quiet on a deployment where the password door is the only door', async () => {
    db.administratorExists = false;
    const { body } = await post('/auth/login', { password: DEPLOYMENT_PASSWORD });
    expect(body.administratorExists).toBe(false);
    const audit = db.log.find((entry) => entry.sql.startsWith('INSERT INTO audit_events'));
    expect(JSON.parse(String(audit!.params[8]))).toMatchObject({ administratorExists: false });
  });

  it('an unreadable substrate never blocks the break-glass door', async () => {
    // R11: this door must not acquire a dependency on the identity substrate.
    const connection = require('../db/connection');
    const original = connection.pool.query;
    let calls = 0;
    connection.pool.query = jest.fn(async (sql: string, params: unknown[] = []) => {
      calls += 1;
      // Everything the login path reads fails EXCEPT the audit write, which is
      // the one dependency the door is documented to keep (fail-closed).
      if (!String(sql).trim().startsWith('INSERT INTO audit_events')) throw new Error('substrate down');
      db.log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params, on: 'pool' });
      return answer(String(sql), params);
    });
    try {
      const { status, body } = await post('/auth/login', { password: DEPLOYMENT_PASSWORD });
      expect(status).toBe(200);
      expect(body.administratorExists).toBe(false);
      expect(calls).toBeGreaterThan(0);
    } finally {
      connection.pool.query = original;
    }
  });
});
