/**
 * Boot-check mode contract (task 97cb6261).
 *
 * The boot gate archived 47 live tasks when a QA container inherited
 * production DB credentials (review 9a9c285c), and both `npx tsx` and direct
 * `tsx` invocations of the old timeout-based gate leaked orphaned node
 * children that squatted the port. RELAYHALL_BOOT_CHECK=1 is the repair: a
 * server-side mode that provably cannot reach a database, dispatches no
 * webhooks, starts no background jobs, and self-terminates deterministically.
 *
 * This suite pins both layers:
 *  1. unit — the pool is pinned to an unreachable endpoint at construction,
 *     regardless of live-looking DB_* values in the environment;
 *  2. integration — a real spawned server in boot-check mode, with DB_*
 *     pointing at a local recorder, exits 0 after bind with ZERO connection
 *     attempts observed, and exits 1 deterministically when the port is taken.
 */

import { spawn } from 'child_process';
import net from 'net';
import path from 'path';

import { withPinnedBootCheckRecorder } from './support/pinnedBootCheckEndpoint';

jest.setTimeout(90_000);

const BACKEND_DIR = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(BACKEND_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runServer(env: Record<string, string>, killAfterMs = 60_000): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, 'src/server.ts'], {
      cwd: BACKEND_DIR,
      env: {
        PATH: process.env.PATH ?? '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    // The test must never itself leak the orphan it exists to prevent.
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`boot-check child did not exit within ${killAfterMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, killAfterMs);
    child.on('exit', (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(killer);
      reject(err);
    });
  });
}

function listenEphemeral(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve(address.port);
      } else {
        reject(new Error('no address'));
      }
    });
  });
}

describe('boot-check mode — pool construction (unit)', () => {
  const LIVE_LOOKING_ENV = {
    DB_HOST: 'db.example.internal',
    DB_PORT: '5432',
    DB_NAME: 'relayhall',
    DB_USER: 'relayhall',
    DB_PASSWORD: 'live-looking-secret',
  } as const;

  // D11 (card 47718b8f): DB_NAME and DB_HOST are RESTORED, not deleted. The
  // guard in db/connection.ts refuses an unset DB_NAME, and process.env is
  // shared by every test file in this worker - deleting the two here would
  // leave a later file's `jest.resetModules()` + `require('../db/connection')`
  // throwing, for a reason that has nothing to do with that file. These are the
  // values jest.config.js sets at config load; restoring them puts the worker
  // back the way it was found. The other three are not read by the guard and
  // are still cleared.
  // Read back from the config rather than restating its literals: two copies of
  // a value can be edited into agreement, and this one must track the config.
  // Requiring it is idempotent - it assigns with `||`, so it never overwrites
  // what the caller (or CI) already set, and after it both values are non-empty.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../../jest.config.js');
  const JEST_CONFIG_DEFAULTS: Record<string, string> = {
    DB_NAME: String(process.env.DB_NAME), DB_HOST: String(process.env.DB_HOST),
  };

  afterEach(() => {
    delete process.env.RELAYHALL_BOOT_CHECK;
    for (const key of Object.keys(LIVE_LOOKING_ENV)) {
      if (key in JEST_CONFIG_DEFAULTS) continue;
      delete process.env[key];
    }
    Object.assign(process.env, JEST_CONFIG_DEFAULTS);
    jest.resetModules();
  });

  it('pins the pool to an unreachable endpoint even when live credentials are in the environment', () => {
    Object.assign(process.env, LIVE_LOOKING_ENV, { RELAYHALL_BOOT_CHECK: '1' });
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { pool, BOOT_CHECK_MODE } = require('../db/connection');
      expect(BOOT_CHECK_MODE).toBe(true);
      expect(pool.options.host).toBe('127.0.0.1');
      expect(pool.options.port).toBe(59998);
      expect(pool.options.user).toBe('none');
      expect(pool.options.database).toBe('relayhall_boot_check_none');
    });
  });

  it('respects the environment when boot-check mode is off', () => {
    Object.assign(process.env, LIVE_LOOKING_ENV);
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { pool, BOOT_CHECK_MODE } = require('../db/connection');
      expect(BOOT_CHECK_MODE).toBe(false);
      expect(pool.options.host).toBe('db.example.internal');
    });
  });

  it('only the exact value 1 enables the mode', () => {
    process.env.RELAYHALL_BOOT_CHECK = 'true';
    // D11 (card 47718b8f): with boot-check mode OFF this case really builds the
    // pool, and the guard in db/connection.ts refuses an unset DB_NAME. The
    // afterEach above deletes DB_NAME, so name the same unreachable database
    // jest.config.js defaults to. It is not reachable and nothing connects.
    process.env.DB_NAME = 'relayhall_test_unreachable';
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { BOOT_CHECK_MODE } = require('../db/connection');
      expect(BOOT_CHECK_MODE).toBe(false);
    });
  });
});

describe('boot-check mode — spawned server (integration)', () => {
  it('exits 0 after bind with zero database connection attempts on BOTH the env endpoint and the pinned endpoint', async () => {
    // Two recorders close the two distinct escape hatches:
    //  - envRecorder sits where the live-looking DB_* env points, proving the
    //    environment is ignored;
    //  - the pinned recorder sits on the endpoint the pinned pool actually
    //    targets — proving no code path issues a query AT ALL in boot-check
    //    mode (a caught startup query would otherwise connect there and go
    //    unnoticed; review 9a7be8fd finding 2).
    // That second endpoint is ONE exclusive resource, shared with
    // orchestrationConfigurationReachability.test.ts, and its port belongs to
    // production. So it is taken through the house holder, which reads the
    // port out of src/db/connection.ts and serialises access to it across
    // processes, rather than bound here from a literal (card 7e66a6c2).
    let envAttempts = 0;
    const envRecorder = net.createServer((socket) => {
      envAttempts += 1;
      socket.destroy();
    });
    const envPort = await listenEphemeral(envRecorder);

    try {
      await withPinnedBootCheckRecorder(async (pinned) => {
        const result = await runServer({
          RELAYHALL_BOOT_CHECK: '1',
          DB_HOST: '127.0.0.1',
          DB_PORT: String(envPort),
          DB_NAME: 'relayhall',
          DB_USER: 'relayhall',
          DB_PASSWORD: 'reachable-live-secret',
          NODE_ENV: 'development',
          JWT_SECRET: 'qa-boot-only',
          DATA_DIR: './qa-boot-data',
          PORT: '0',
        });

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('BOOT CHECK OK');
        expect(result.stdout).not.toContain('Database connected');
        expect(envAttempts).toBe(0);
        expect(pinned.attempts()).toBe(0);
      });
    } finally {
      envRecorder.close();
    }
  });

  it('the pinned-endpoint recorder DOES observe a query attempt when one is forced (the zero above is meaningful)', async () => {
    // Sensitivity check for the previous test: drive the same pinned pool
    // config through a one-off pg client and prove the recorder trips. This
    // guards against the recorder silently watching the wrong endpoint.
    await withPinnedBootCheckRecorder(async (pinned) => {
      // Issue one query through the boot-check pool via tsx; the pinned
      // recorder must see the connection attempt.
      const result = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, [TSX_CLI, '-e',
          "process.env.RELAYHALL_BOOT_CHECK='1'; const { pool } = require('./src/db/connection'); pool.query('SELECT 1').catch(() => {}).finally(() => process.exit(0));",
        ], { cwd: BACKEND_DIR, env: { PATH: process.env.PATH ?? '' }, stdio: 'ignore' });
        const killer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('probe hung')); }, 30_000);
        child.on('exit', (code) => { clearTimeout(killer); resolve(code); });
        child.on('error', (e) => { clearTimeout(killer); reject(e); });
      });
      expect(result).toBe(0);
      expect(pinned.attempts()).toBeGreaterThan(0);
    });
  });

  it('exits 1 deterministically when the port is already taken', async () => {
    const squatter = net.createServer();
    const takenPort = await listenEphemeral(squatter);

    try {
      const result = await runServer({
        RELAYHALL_BOOT_CHECK: '1',
        NODE_ENV: 'development',
        JWT_SECRET: 'qa-boot-only',
        DATA_DIR: './qa-boot-data',
        PORT: String(takenPort),
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('BOOT CHECK FAILED (listen error)');
    } finally {
      squatter.close();
    }
  });
});
