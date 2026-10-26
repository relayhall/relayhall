/**
 * Server fail-closed identity (card 7f0c84f0, owner ruling D33) - the parts
 * that need no database.
 *
 *  1. condition 1 (the handle is well formed) agrees with
 *     `localAdministratorHandle()` on every value, so the two can never
 *     disagree about what a handle is;
 *  2. conditions 2-5 against a recorded queryable: one read, one parameter,
 *     every refusal code, and the 062 seed rows as an OUTSIDE anchor - the
 *     shipped seed must resolve, and no other seed may;
 *  3. the refusal line is one line and carries no secret and no raw value;
 *  4. a REAL spawned server in boot-check mode refuses a malformed handle
 *     before it binds, and still boots exactly as CI's boot check does when
 *     the handle is unset.
 *
 * The real-PostgreSQL half (a compiled boot against a migrated database) is
 * `deploymentIdentityBootLive.test.ts`, run by `npm run test:deployment-identity`.
 */
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { localAdministratorHandle } from '../config/localAdministrator';
import {
  DEPLOYMENT_IDENTITY_LOG_TAG,
  DEPLOYMENT_IDENTITY_SQL,
  DeploymentIdentityQueryable,
  deploymentIdentityConfiguration,
  formatDeploymentIdentityRefusal,
  formatDeploymentIdentityResolved,
  resolveDeploymentIdentity,
} from '../config/deploymentIdentity';

jest.setTimeout(120_000);

const BACKEND_DIR = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(BACKEND_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const ORIGINAL_HANDLE = process.env.RELAYHALL_LOCAL_ADMIN_HANDLE;

function setHandle(value: string | undefined): void {
  if (value === undefined) delete process.env.RELAYHALL_LOCAL_ADMIN_HANDLE;
  else process.env.RELAYHALL_LOCAL_ADMIN_HANDLE = value;
}

afterEach(() => setHandle(ORIGINAL_HANDLE));

function recordingDb(rows: Array<Record<string, unknown>>) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const db: DeploymentIdentityQueryable = {
    async query(text: string, params?: unknown[]) {
      calls.push({ text, params });
      return { rows };
    },
  };
  return { db, calls };
}

const ACTIVE_OWNER = { id: '00000000-0000-4000-8000-000000000001', kind: 'human', status: 'active', role: 'orchestrator', parent_principal_id: null };

describe('condition 1 - the configured handle', () => {
  const VALUES: Array<string | undefined> = [
    undefined, '', '   ', 'dashboard_user', ' Dashboard_User ', 'owner.two', 'ab', 'a', 'Not A Handle!',
    '-leading-dash', 'x'.repeat(64), 'x'.repeat(65), 'casey', 'ÜNICODE', 'semi;colon',
  ];

  test.each(VALUES.map((value) => [JSON.stringify(value), value]))('%s agrees with localAdministratorHandle()', (_label, value) => {
    setHandle(value);
    const outcome = deploymentIdentityConfiguration();
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    // Derived from the function the login path calls, not from a second copy
    // of its pattern: well formed means "the login path would use THIS value".
    const accepted = normalized === '' || localAdministratorHandle() === normalized;
    expect(outcome.ok).toBe(accepted);
    if (outcome.ok) {
      expect(outcome.handle).toBe(localAdministratorHandle());
      expect(outcome.source).toBe(normalized === '' ? 'seed' : 'configured');
    } else {
      expect(outcome.code).toBe('LOCAL_ADMIN_HANDLE_MALFORMED');
    }
  });

  test('the malformed refusal never quotes the configured value', () => {
    const raw = `Pasted Secret ${crypto.randomBytes(12).toString('hex')}!`;
    setHandle(raw);
    const outcome = deploymentIdentityConfiguration();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const line = formatDeploymentIdentityRefusal(outcome);
    expect(line).not.toContain(raw);
    expect(line.toLowerCase()).not.toContain(raw.trim().toLowerCase());
    expect(line).toContain('RELAYHALL_LOCAL_ADMIN_HANDLE');
  });
});

describe('conditions 2-5 - the local administrator Account', () => {
  test('one read, by handle, with the module query', async () => {
    setHandle(undefined);
    const { db, calls } = recordingDb([ACTIVE_OWNER]);
    const outcome = await resolveDeploymentIdentity(db);
    expect(outcome).toEqual({ ok: true, handle: 'dashboard_user', source: 'seed', principalId: ACTIVE_OWNER.id, role: 'orchestrator' });
    expect(calls).toEqual([{ text: DEPLOYMENT_IDENTITY_SQL, params: ['dashboard_user'] }]);
    expect(DEPLOYMENT_IDENTITY_SQL).toMatch(/^SELECT .* FROM principals WHERE handle = \$1$/);
  });

  test('a malformed handle refuses before any read', async () => {
    setHandle('Not A Handle!');
    const { db, calls } = recordingDb([ACTIVE_OWNER]);
    const outcome = await resolveDeploymentIdentity(db);
    expect(outcome).toMatchObject({ ok: false, code: 'LOCAL_ADMIN_HANDLE_MALFORMED' });
    expect(calls).toHaveLength(0);
  });

  test('a configured handle is the one read, and is named as configured', async () => {
    setHandle('Owner.Two');
    const { db, calls } = recordingDb([]);
    const outcome = await resolveDeploymentIdentity(db);
    expect(calls[0].params).toEqual(['owner.two']);
    expect(outcome).toMatchObject({ ok: false, code: 'LOCAL_ADMINISTRATOR_ACCOUNT_MISSING' });
    if (outcome.ok) return;
    expect(outcome.reason).toContain("'owner.two' (RELAYHALL_LOCAL_ADMIN_HANDLE)");
  });

  const CASES: Array<[string, Array<Record<string, unknown>>, string | null]> = [
    ['no row', [], 'LOCAL_ADMINISTRATOR_ACCOUNT_MISSING'],
    ['disabled', [{ ...ACTIVE_OWNER, status: 'disabled' }], 'LOCAL_ADMINISTRATOR_ACCOUNT_NOT_ACTIVE'],
    ['terminated', [{ ...ACTIVE_OWNER, status: 'terminated' }], 'LOCAL_ADMINISTRATOR_ACCOUNT_NOT_ACTIVE'],
    ['a service Account', [{ ...ACTIVE_OWNER, kind: 'service' }], 'LOCAL_ADMINISTRATOR_NOT_A_PERSON'],
    ['an agent Account', [{ ...ACTIVE_OWNER, kind: 'agent' }], 'LOCAL_ADMINISTRATOR_NOT_A_PERSON'],
    ['a human with a parent', [{ ...ACTIVE_OWNER, parent_principal_id: '00000000-0000-4000-8000-000000000002' }], 'LOCAL_ADMINISTRATOR_NOT_A_PERSON'],
    ['operator', [{ ...ACTIVE_OWNER, role: 'operator' }], 'LOCAL_ADMINISTRATOR_LACKS_ROOT'],
    ['viewer', [{ ...ACTIVE_OWNER, role: 'viewer' }], 'LOCAL_ADMINISTRATOR_LACKS_ROOT'],
    ['an unknown role', [{ ...ACTIVE_OWNER, role: 'superuser' }], 'LOCAL_ADMINISTRATOR_LACKS_ROOT'],
    ['admin', [{ ...ACTIVE_OWNER, role: 'admin' }], null],
    ['orchestrator', [ACTIVE_OWNER], null],
    // NULL role on the SEED handle: the handle switch derives orchestrator,
    // exactly as middleware/auth.ts does for the same row.
    ['NULL role on the seed', [{ ...ACTIVE_OWNER, role: null }], null],
  ];

  test.each(CASES)('seed handle, %s', async (_label, rows, code) => {
    setHandle(undefined);
    const outcome = await resolveDeploymentIdentity(recordingDb(rows).db);
    if (code === null) expect(outcome.ok).toBe(true);
    else expect(outcome).toMatchObject({ ok: false, code });
  });

  test('NULL role on a CONFIGURED handle derives agent and lacks root', async () => {
    setHandle('owner.two');
    const outcome = await resolveDeploymentIdentity(recordingDb([{ ...ACTIVE_OWNER, role: null }]).db);
    expect(outcome).toMatchObject({ ok: false, code: 'LOCAL_ADMINISTRATOR_LACKS_ROOT' });
  });

  test('a read failure is thrown, never reported as a missing Account', async () => {
    setHandle(undefined);
    const db: DeploymentIdentityQueryable = { query: async () => { throw new Error('relation "principals" does not exist'); } };
    await expect(resolveDeploymentIdentity(db)).rejects.toThrow('principals');
  });
});

describe('outside anchor - the shipped 062 seed rows', () => {
  // Read from the migration that seeds them, not restated here: the shipped
  // owner row must resolve, and every other shipped seed must be refused.
  const sql = fs.readFileSync(path.join(BACKEND_DIR, 'src', 'migrations', '062_identity_substrate.sql'), 'utf8');
  const seeds = [...sql.matchAll(/^\s*\('(human|service|agent)',\s*'([a-z_]+)',\s*'[^']*',\s*(NULL|'[a-z]+'),/gm)]
    .map((m) => ({ kind: m[1], handle: m[2], role: m[3] === 'NULL' ? null : m[3].slice(1, -1) }));

  test('the seed list was read', () => {
    expect(seeds.map((s) => s.handle)).toContain('dashboard_user');
    expect(seeds.length).toBeGreaterThanOrEqual(10);
  });

  test('only dashboard_user, as seeded, resolves', async () => {
    const resolved: string[] = [];
    for (const seed of seeds) {
      setHandle(seed.handle);
      const row = { id: crypto.randomUUID(), kind: seed.kind, status: 'active', role: seed.role, parent_principal_id: null };
      const outcome = await resolveDeploymentIdentity(recordingDb([row]).db);
      if (outcome.ok) resolved.push(seed.handle);
    }
    expect(resolved).toEqual(['dashboard_user']);
  });
});

describe('the log lines', () => {
  const SECRETS = {
    DASHBOARD_PASSWORD_HASH: `$2b$10$${crypto.randomBytes(20).toString('hex')}`,
    JWT_SECRET: crypto.randomBytes(24).toString('hex'),
    DB_PASSWORD: crypto.randomBytes(16).toString('hex'),
  };

  test.each([
    ['no row', []],
    ['disabled', [{ ...ACTIVE_OWNER, status: 'disabled' }]],
    ['service', [{ ...ACTIVE_OWNER, kind: 'service', parent_principal_id: 'p' }]],
    ['viewer', [{ ...ACTIVE_OWNER, role: 'viewer' }]],
  ] as Array<[string, Array<Record<string, unknown>>]>)('refusal (%s) is one tagged line with no secret', async (_label, rows) => {
    const saved = { ...process.env };
    Object.assign(process.env, SECRETS);
    try {
      setHandle(undefined);
      const outcome = await resolveDeploymentIdentity(recordingDb(rows).db);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      const line = formatDeploymentIdentityRefusal(outcome);
      expect(line.split('\n')).toHaveLength(1);
      expect(line).toContain(DEPLOYMENT_IDENTITY_LOG_TAG);
      expect(line).toContain(outcome.code);
      for (const secret of Object.values(SECRETS)) expect(line).not.toContain(secret);
    } finally {
      for (const key of Object.keys(SECRETS)) {
        if (key in saved) process.env[key] = saved[key]; else delete process.env[key];
      }
    }
  });

  test('the resolved line names the handle and its source', () => {
    const line = formatDeploymentIdentityResolved({ ok: true, handle: 'dashboard_user', source: 'seed', principalId: 'x', role: 'orchestrator' });
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain(DEPLOYMENT_IDENTITY_LOG_TAG);
    expect(line).toContain("'dashboard_user'");
  });
});

interface SpawnResult { code: number | null; output: string }

function bootCheck(env: Record<string, string>): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, 'src/server.ts'], {
      cwd: BACKEND_DIR,
      env: {
        PATH: process.env.PATH ?? '',
        RELAYHALL_BOOT_CHECK: '1',
        NODE_ENV: 'production',
        PORT: '0',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => { output += String(d); });
    child.stderr.on('data', (d) => { output += String(d); });
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`boot-check child did not exit within 90s\n${output}`));
    }, 90_000);
    child.on('exit', (code) => { clearTimeout(killer); resolve({ code, output }); });
    child.on('error', (err) => { clearTimeout(killer); reject(err); });
  });
}

describe('a real spawned server in boot-check mode', () => {
  const secrets = {
    JWT_SECRET: crypto.randomBytes(24).toString('hex'),
    DASHBOARD_PASSWORD_HASH: `$2b$10$${crypto.randomBytes(20).toString('hex')}`,
    DB_PASSWORD: crypto.randomBytes(16).toString('hex'),
  };

  test('a malformed RELAYHALL_LOCAL_ADMIN_HANDLE exits 1 before binding, with one named line and no secret', async () => {
    const raw = `Not A Handle ${crypto.randomBytes(6).toString('hex')}!`;
    const run = await bootCheck({ ...secrets, RELAYHALL_LOCAL_ADMIN_HANDLE: raw });
    expect(run.code).toBe(1);
    const tagged = run.output.split('\n').filter((l) => l.includes(DEPLOYMENT_IDENTITY_LOG_TAG));
    expect(tagged).toHaveLength(1);
    expect(tagged[0]).toContain('refusing to serve');
    expect(tagged[0]).toContain('LOCAL_ADMIN_HANDLE_MALFORMED');
    expect(tagged[0]).toContain('RELAYHALL_LOCAL_ADMIN_HANDLE');
    // Before the listener: neither the bind banner nor the boot-check report.
    expect(run.output).not.toContain('RelayHall API');
    expect(run.output).not.toContain('BOOT CHECK OK');
    expect(run.output).not.toContain(raw);
    for (const secret of Object.values(secrets)) expect(run.output).not.toContain(secret);
  });

  test('CI shape (handle unset) still binds and exits 0, as the compiled boot check does', async () => {
    const run = await bootCheck({ JWT_SECRET: secrets.JWT_SECRET });
    expect(run.code).toBe(0);
    expect(run.output).toContain('BOOT CHECK OK');
    expect(run.output).not.toContain(DEPLOYMENT_IDENTITY_LOG_TAG);
  });
});
