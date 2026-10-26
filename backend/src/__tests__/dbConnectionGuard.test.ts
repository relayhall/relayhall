/**
 * D11 containment guard — `backend/src/db/connection.ts` (incident 2026-09-18,
 * ClawBoard card 47718b8f).
 *
 * The defect: RelayHall review sessions spawned inside the `clawboard-backend`
 * container inherited DB_HOST=clawboard-db / DB_NAME=clawboard, and
 * `database: process.env.DB_NAME || 'relayhall_dev'` accepted that silently.
 *
 * This suite is PURE: no database, no network, nothing mocked DB-side. The
 * refusing cases throw during `require`, before `new Pool(...)` is reached at
 * all; the passing cases construct a real `pg.Pool`, which opens nothing
 * because `pg` connects lazily. It therefore runs anywhere, including on a
 * machine with no PostgreSQL — which is what tier-1 CI is.
 *
 * It measures the guard on BOTH sides of the seam: the exported predicate
 * directly, and the module-load path that production code actually takes
 * (every importer of `db/connection` gets the pool built at load). The last
 * describe measures the jest-config default that keeps tier-1 CI green, and
 * pins that the default cannot overwrite an inherited refused value.
 */

const ENV_KEYS = [
  'DB_NAME',
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'RELAYHALL_ALLOW_DB_NAME',
  'RELAYHALL_BOOT_CHECK',
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  jest.resetModules();
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key] as string;
  }
  jest.resetModules();
});

/** Load `db/connection` exactly as an importer does, in isolation. */
function loadConnection(): any {
  let loaded: any;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    loaded = require('../db/connection');
  });
  return loaded;
}

/** Load only the predicate, from a module state that is allowed to load. */
function loadGuard(): (env?: NodeJS.ProcessEnv) => void {
  process.env.DB_NAME = 'relayhall_guard_probe';
  const mod = loadConnection();
  delete process.env.DB_NAME;
  return mod.assertDatabaseTargetAllowed;
}

describe('D11 guard — the predicate', () => {
  it('refuses an unset DB_NAME', () => {
    const assertAllowed = loadGuard();
    expect(() => assertAllowed({})).toThrow(/DB_NAME is unset/);
  });

  it('refuses DB_NAME=clawboard and names the refused target', () => {
    const assertAllowed = loadGuard();
    expect(() => assertAllowed({ DB_NAME: 'clawboard' })).toThrow(/refused database \(clawboard\)/);
  });

  // The dev stack is a second live pair: docker-compose.dev.yml:10,44 give
  // clawboard_dev / clawboard-dev-db, and clawboard-dev-backend spawns
  // sessions through the same environment spread as production.
  it('refuses DB_NAME=clawboard_dev', () => {
    const assertAllowed = loadGuard();
    expect(() => assertAllowed({ DB_NAME: 'clawboard_dev' }))
      .toThrow(/refused database \(clawboard_dev\)/);
  });

  it('refuses DB_HOST=clawboard-db even when DB_NAME looks like a RelayHall database', () => {
    const assertAllowed = loadGuard();
    expect(() => assertAllowed({ DB_NAME: 'relayhall_w2_r4_review', DB_HOST: 'clawboard-db' }))
      .toThrow(/refused database server \(clawboard-db\)/);
  });

  it('refuses DB_HOST=clawboard-dev-db likewise', () => {
    const assertAllowed = loadGuard();
    expect(() => assertAllowed({ DB_NAME: 'relayhall_scratch', DB_HOST: 'clawboard-dev-db' }))
      .toThrow(/refused database server \(clawboard-dev-db\)/);
  });

  it('allows an ordinary RelayHall database', () => {
    const assertAllowed = loadGuard();
    expect(() => assertAllowed({ DB_NAME: 'relayhall_dev', DB_HOST: 'localhost' })).not.toThrow();
  });

  it('allows a refused NAME only when the opt-in names it exactly', () => {
    const assertAllowed = loadGuard();
    expect(() => assertAllowed({ DB_NAME: 'clawboard', RELAYHALL_ALLOW_DB_NAME: 'clawboard' }))
      .not.toThrow();
    // Negative control: a NEAR-miss opt-in must not release the refusal.
    expect(() => assertAllowed({ DB_NAME: 'clawboard', RELAYHALL_ALLOW_DB_NAME: 'clawboard_copy' }))
      .toThrow(/refused database \(clawboard\)/);
    // Negative control: the opt-in cannot re-open the unset case.
    expect(() => assertAllowed({ RELAYHALL_ALLOW_DB_NAME: 'clawboard' })).toThrow(/DB_NAME is unset/);
  });

  // The host rule sits ABOVE the opt-in and nothing releases it. Before this
  // repair, the two environment variables below rebuilt the exact incident
  // configuration - DB_NAME=clawboard on DB_HOST=clawboard-db - and the guard
  // returned without a word.
  it('refuses a refused HOST even when the opt-in names the database exactly', () => {
    const assertAllowed = loadGuard();
    expect(() => assertAllowed({
      DB_NAME: 'clawboard',
      DB_HOST: 'clawboard-db',
      RELAYHALL_ALLOW_DB_NAME: 'clawboard',
    })).toThrow(/refused database server \(clawboard-db\)/);
    // And the same for a sibling database on that server, which is the shape
    // the incident's own `relayhall_w2_r4_review` had.
    expect(() => assertAllowed({
      DB_NAME: 'relayhall_w2_r4_review',
      DB_HOST: 'clawboard-db',
      RELAYHALL_ALLOW_DB_NAME: 'relayhall_w2_r4_review',
    })).toThrow(/refused database server \(clawboard-db\)/);
  });

  it('never puts a credential in the refusal message', () => {
    const assertAllowed = loadGuard();
    expect(() => assertAllowed({ DB_NAME: 'clawboard', DB_PASSWORD: 'fixture' }))
      .toThrow(/refused database \(clawboard\)/);
    try {
      assertAllowed({ DB_NAME: 'clawboard', DB_PASSWORD: 'fixture', DB_USER: 'clawboard_user' });
      throw new Error('guard did not refuse');
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('fixture');
      expect(String((err as Error).message)).not.toContain('clawboard_user');
    }
  });
});

describe('D11 guard — the module-load seam every importer crosses', () => {
  it('refuses to load with no database environment at all', () => {
    expect(() => loadConnection()).toThrow(/DB_NAME is unset/);
  });

  // The host is deliberately NEUTRAL here: with DB_HOST=clawboard-db this
  // assertion would be satisfied by the host rule alone, and a drill that
  // empties REFUSED_DB_NAMES would leave it green (measured, 2026-09-18).
  it('refuses to load against the ClawBoard production database name', () => {
    process.env.DB_NAME = 'clawboard';
    process.env.DB_HOST = '127.0.0.1';
    expect(() => loadConnection()).toThrow(/refused database \(clawboard\)/);
  });

  it('refuses to load against the ClawBoard dev database name', () => {
    process.env.DB_NAME = 'clawboard_dev';
    process.env.DB_HOST = '127.0.0.1';
    expect(() => loadConnection()).toThrow(/refused database \(clawboard_dev\)/);
  });

  it('refuses to load against the ClawBoard database server under any other name', () => {
    process.env.DB_NAME = 'relayhall_w2_r4_review';
    process.env.DB_HOST = 'clawboard-db';
    expect(() => loadConnection()).toThrow(/clawboard-db/);
  });

  it('loads, and builds the pool, for an ordinary RelayHall database', () => {
    process.env.DB_NAME = 'relayhall_dev';
    process.env.DB_HOST = '127.0.0.1';
    const mod = loadConnection();
    expect(mod.pool.options.database).toBe('relayhall_dev');
    expect(mod.pool.options.host).toBe('127.0.0.1');
  });

  it('loads against a refused name when the opt-in names it exactly and the host is not refused', () => {
    process.env.DB_NAME = 'clawboard';
    process.env.DB_HOST = '127.0.0.1';
    process.env.RELAYHALL_ALLOW_DB_NAME = 'clawboard';
    const mod = loadConnection();
    expect(mod.pool.options.database).toBe('clawboard');
  });

  // The inverse of the line above, and the one that matters: the opt-in must
  // NOT be able to reassemble the incident configuration.
  it('refuses to load onto the ClawBoard server however the opt-in is set', () => {
    process.env.DB_NAME = 'clawboard';
    process.env.DB_HOST = 'clawboard-db';
    process.env.RELAYHALL_ALLOW_DB_NAME = 'clawboard';
    expect(() => loadConnection()).toThrow(/refused database server \(clawboard-db\)/);
  });
});

/**
 * The guard refuses an unset DB_NAME, and tier-1 CI (.github/workflows/ci.yml
 * job `backend`) runs `npx jest` with no `env:` block. `backend/jest.config.js`
 * therefore names a database at config load, in the parent process, before any
 * worker is spawned — the same mechanism it already uses for NODE_ENV.
 *
 * These cases re-execute that file, which is the code under test.
 */
describe('D11 — the jest-config default that keeps a database-less run green', () => {
  function loadJestConfig(): void {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../../jest.config.js');
    });
  }

  it('names an unreachable database when nothing in the environment names one', () => {
    loadJestConfig();
    expect(process.env.DB_NAME).toBe('relayhall_test_unreachable');
    expect(process.env.DB_HOST).toBe('127.0.0.1');
    // And what it chose must itself satisfy the guard, or tier-1 still reds.
    expect(() => loadConnection()).not.toThrow();
  });

  it('does NOT overwrite an inherited refused value — the incident pair survives and is refused', () => {
    process.env.DB_NAME = 'clawboard';
    process.env.DB_HOST = 'clawboard-db';
    loadJestConfig();
    expect(process.env.DB_NAME).toBe('clawboard');
    expect(process.env.DB_HOST).toBe('clawboard-db');
    expect(() => loadConnection()).toThrow(/refused database server \(clawboard-db\)/);
  });

  it('does not overwrite a legitimate inherited database either (CI sets relayhall_ci)', () => {
    process.env.DB_NAME = 'relayhall_ci';
    process.env.DB_HOST = 'postgres';
    loadJestConfig();
    expect(process.env.DB_NAME).toBe('relayhall_ci');
    expect(process.env.DB_HOST).toBe('postgres');
  });
});
