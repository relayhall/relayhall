/**
 * Server fail-closed identity (card 7f0c84f0, owner ruling D33), measured by
 * booting the COMPILED server - `node dist/server.js`, the artefact the
 * container runs - against a REAL migrated PostgreSQL.
 *
 * tsx hoists imports and `dist/server.js` does not, so a gate that only works
 * under tsx is not a gate. Every boot here is the compiled one.
 *
 *   production-shaped   handle unset, the 062 seed present -> the identity
 *                       resolves BEFORE the listener (its line precedes the
 *                       bind banner) and the server answers /health, as today;
 *   configured          RELAYHALL_LOCAL_ADMIN_HANDLE names an active human
 *                       admin -> the same;
 *   unresolvable        the handle names nothing, the seed itself is missing,
 *                       the Account is disabled, is a service, lacks the root
 *                       sentinel, or the handle is malformed -> exit 1 with
 *                       ONE `[DeploymentIdentity]` line naming the code, the
 *                       port never accepts a connection, and no secret from
 *                       the environment appears anywhere in the output.
 *
 * Red proof: on a build whose server.ts lacks the gate, every unresolvable
 * case binds and answers /health, and its assertions fail.
 *
 * It FAILS - never skips - without `RELAYHALL_TEST_DB_URL` or without a
 * current build (`npm run test:deployment-identity` builds first). It inserts
 * principals with the `identity-drill-` handle prefix and renames the seed for
 * one case; both are undone when it ends.
 */
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import bcrypt from 'bcrypt';
import { Client } from 'pg';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error(
    'RELAYHALL_TEST_DB_URL is not set. The fail-closed identity gate boots the compiled server against a REAL '
    + 'PostgreSQL and refuses to skip. Create a disposable database, load database/init.sql, run npm run migrate, '
    + 'and set RELAYHALL_TEST_DB_URL to it.',
  );
}
const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = decodeURIComponent(parsed.pathname.slice(1));
const localFixture = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  && /test|contract|fixture/i.test(TEST_DB_NAME) && !/^clawboard(?:_|$)/i.test(TEST_DB_NAME);
const ciFixture = process.env.CI === 'true' && parsed.hostname === 'postgres' && TEST_DB_NAME === 'relayhall_ci';
if (!localFixture && !ciFixture) {
  throw new Error('The fail-closed identity gate writes principals: point RELAYHALL_TEST_DB_URL at a local disposable test database or the CI service database.');
}

jest.setTimeout(120_000);

const BACKEND_DIR = path.resolve(__dirname, '..', '..');
const DIST_SERVER = path.join(BACKEND_DIR, 'dist', 'server.js');
const TAG = '[DeploymentIdentity]';
const BANNER = 'RelayHall API';
const SEED = 'dashboard_user';
const DRILL = `identity-drill-${crypto.randomBytes(3).toString('hex')}`;

const DB_USER = decodeURIComponent(parsed.username);
const DB_PASSWORD = decodeURIComponent(parsed.password);

// Production-shaped secrets, fresh per run, so "nothing secret printed" is
// checked against values that exist nowhere else.
const SECRET_PASSWORD = crypto.randomBytes(18).toString('base64url');
const SECRETS: Record<string, string> = {
  JWT_SECRET: crypto.randomBytes(32).toString('hex'),
  DASHBOARD_PASSWORD_HASH: bcrypt.hashSync(SECRET_PASSWORD, 4),
};
// The credential keyset jest.config.js pins for the suite, passed through so a
// shared CI database's existing envelopes still decrypt at the keyset gate.
const KEYSET = {
  RELAYHALL_CREDENTIAL_KEYS: String(process.env.RELAYHALL_CREDENTIAL_KEYS),
  RELAYHALL_CREDENTIAL_ACTIVE_KEY: String(process.env.RELAYHALL_CREDENTIAL_ACTIVE_KEY),
};
const MUST_NOT_APPEAR = [
  ...Object.values(SECRETS),
  SECRET_PASSWORD,
  // A DB password that doubles as the database or role name (the CI fixture)
  // is printed legitimately; only a distinct one is a secret here.
  ...(DB_PASSWORD.length >= 12 && DB_PASSWORD !== TEST_DB_NAME && DB_PASSWORD !== DB_USER ? [DB_PASSWORD] : []),
];

let db: Client;
let seedMovedTo: string | null = null;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

function healthy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2_000 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.once('timeout', () => { request.destroy(); resolve(false); });
    request.once('error', () => resolve(false));
  });
}

interface Boot {
  code: number | null;
  output: string;
  /** Any TCP connection to the port succeeded while the process lived. */
  connected: boolean;
  /** /health answered 200 (the boot was then stopped with SIGTERM). */
  served: boolean;
}

async function boot(extra: Record<string, string> = {}): Promise<Boot> {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-identity-boot-'));
  const child = spawn(process.execPath, [DIST_SERVER], {
    cwd: BACKEND_DIR,
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'production',
      PORT: String(port),
      DB_HOST: parsed.hostname,
      DB_PORT: parsed.port || '5432',
      DB_NAME: TEST_DB_NAME,
      DB_USER,
      DB_PASSWORD,
      DATA_DIR: dataDir,
      ...SECRETS,
      ...KEYSET,
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += String(d); });
  child.stderr.on('data', (d) => { output += String(d); });
  let exited = false;
  let connected = false;
  let served = false;
  const exit = new Promise<number | null>((resolve) => child.on('exit', (code) => { exited = true; resolve(code); }));
  const deadline = Date.now() + 60_000;
  try {
    while (!exited && Date.now() < deadline) {
      if (await canConnect(port)) {
        connected = true;
        if (await healthy(port)) {
          served = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!exited) {
      child.kill('SIGTERM');
      const killer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await exit;
      clearTimeout(killer);
    }
    return { code: await exit, output, connected, served };
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function expectRefused(run: Boot, code: string, mention: string): void {
  const tagged = run.output.split('\n').filter((line) => line.includes(TAG));
  if (run.code !== 1 || tagged.length !== 1) {
    throw new Error(`expected exit 1 with ONE ${TAG} line naming ${code}; got exit ${run.code}, ${tagged.length} tagged line(s)\n${run.output}`);
  }
  expect(tagged[0]).toContain('refusing to serve');
  expect(tagged[0]).toContain(code);
  expect(tagged[0]).toContain(mention);
  // Before the listener: no bind banner, and nothing ever accepted a connection.
  expect(run.output).not.toContain(BANNER);
  expect(run.connected).toBe(false);
  expect(run.served).toBe(false);
  for (const secret of MUST_NOT_APPEAR) expect(run.output).not.toContain(secret);
}

function expectServed(run: Boot, handleNamed: string): void {
  if (!run.served) throw new Error(`expected the server to answer /health\n${run.output}`);
  const resolvedAt = run.output.indexOf(`${TAG} resolved: local administrator '${handleNamed}'`);
  const bannerAt = run.output.indexOf(BANNER);
  expect(resolvedAt).toBeGreaterThanOrEqual(0);
  expect(bannerAt).toBeGreaterThan(resolvedAt);
  expect(run.output).not.toContain('refusing to serve');
  for (const secret of MUST_NOT_APPEAR) expect(run.output).not.toContain(secret);
}

async function insertAccount(suffix: string, kind: string, role: string | null, status = 'active'): Promise<string> {
  const handle = `${DRILL}-${suffix}`;
  await db.query(
    `INSERT INTO principals (kind, handle, display_name, role, status, purpose)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [kind, handle, `Identity drill ${suffix}`, role, status, kind === 'service' ? 'Identity drill fixture' : null],
  );
  return handle;
}

beforeAll(async () => {
  if (!fs.existsSync(DIST_SERVER)) {
    throw new Error(`${DIST_SERVER} is missing: run \`npm run build\` (npm run test:deployment-identity does).`);
  }
  // A stale build would measure yesterday's server.
  const built = fs.statSync(DIST_SERVER).mtimeMs;
  for (const source of ['src/server.ts', 'src/config/deploymentIdentity.ts']) {
    const file = path.join(BACKEND_DIR, source);
    if (fs.existsSync(file) && fs.statSync(file).mtimeMs > built) {
      throw new Error(`${source} is newer than dist/server.js: run \`npm run build\` first.`);
    }
  }
  db = new Client({ connectionString: TEST_DB_URL });
  await db.connect();
  const seed = await db.query('SELECT kind, status, role, parent_principal_id FROM principals WHERE handle = $1', [SEED]);
  // The production shape this suite starts from: the migrated seed as shipped.
  expect(seed.rows).toEqual([{ kind: 'human', status: 'active', role: 'orchestrator', parent_principal_id: null }]);
});

afterAll(async () => {
  if (!db) return;
  try {
    if (seedMovedTo) await db.query('UPDATE principals SET handle = $1 WHERE handle = $2', [SEED, seedMovedTo]);
    await db.query('DELETE FROM principals WHERE handle LIKE $1', [`${DRILL}-%`]);
  } finally {
    await db.end();
  }
});

describe('production-shaped configuration starts as today', () => {
  test('handle unset, seed present: resolves before the listener, then serves', async () => {
    expectServed(await boot(), SEED);
  });

  test('RELAYHALL_LOCAL_ADMIN_HANDLE naming an active human admin: the same', async () => {
    const handle = await insertAccount('admin', 'human', 'admin');
    expectServed(await boot({ RELAYHALL_LOCAL_ADMIN_HANDLE: handle }), handle);
  });
});

describe('an unresolvable identity exits 1 before the listener opens', () => {
  test('the configured handle names no Account', async () => {
    const handle = `${DRILL}-absent`;
    expectRefused(await boot({ RELAYHALL_LOCAL_ADMIN_HANDLE: handle }), 'LOCAL_ADMINISTRATOR_ACCOUNT_MISSING', `'${handle}' (RELAYHALL_LOCAL_ADMIN_HANDLE)`);
  });

  test('the handle is unset and the seeded Account is gone', async () => {
    seedMovedTo = `${DRILL}-moved-seed`;
    await db.query('UPDATE principals SET handle = $1 WHERE handle = $2', [seedMovedTo, SEED]);
    try {
      expectRefused(await boot(), 'LOCAL_ADMINISTRATOR_ACCOUNT_MISSING', `'${SEED}' (the seeded default; RELAYHALL_LOCAL_ADMIN_HANDLE is unset)`);
    } finally {
      await db.query('UPDATE principals SET handle = $1 WHERE handle = $2', [SEED, seedMovedTo]);
      seedMovedTo = null;
    }
  });

  test('the Account is disabled', async () => {
    const handle = await insertAccount('disabled', 'human', 'admin', 'disabled');
    expectRefused(await boot({ RELAYHALL_LOCAL_ADMIN_HANDLE: handle }), 'LOCAL_ADMINISTRATOR_ACCOUNT_NOT_ACTIVE', 'is disabled');
  });

  test('the Account is a service, not a person', async () => {
    const handle = await insertAccount('service', 'service', 'agent');
    expectRefused(await boot({ RELAYHALL_LOCAL_ADMIN_HANDLE: handle }), 'LOCAL_ADMINISTRATOR_NOT_A_PERSON', 'kind service');
  });

  test('the Account does not carry the root sentinel', async () => {
    const handle = await insertAccount('viewer', 'human', 'viewer');
    expectRefused(await boot({ RELAYHALL_LOCAL_ADMIN_HANDLE: handle }), 'LOCAL_ADMINISTRATOR_LACKS_ROOT', "role 'viewer'");
  });

  test('the configured handle is malformed (its value is never printed)', async () => {
    const raw = `Not A Handle ${crypto.randomBytes(6).toString('hex')}!`;
    const run = await boot({ RELAYHALL_LOCAL_ADMIN_HANDLE: raw });
    expectRefused(run, 'LOCAL_ADMIN_HANDLE_MALFORMED', 'RELAYHALL_LOCAL_ADMIN_HANDLE');
    expect(run.output).not.toContain(raw);
  });

  test('the seed is back and the production shape serves again', async () => {
    expectServed(await boot(), SEED);
  });
});
