/**
 * Card 590c638a, ruling 4 - the reachability check.
 *
 * RH-P3.C3 found the claim/lease surface answering ORCHESTRATION_DISABLED on
 * every deployment: the compose file never forwarded the switch. Suites
 * proved the code worked; nothing proved a value handed to the PROCESS was
 * the value the process ran with. This suite pins the three pieces that
 * close that gap:
 *  1. the handler answers from the configured service (not the environment);
 *  2. the boot-check probe admits an enumerated set of paths, nothing else;
 *  3. a REAL spawned server in boot-check mode with the probe set answers
 *     the bound it was handed - and "unlimited" when handed nothing - on the
 *     single BOOT CHECK PROBE line, with zero database activity.
 */
import { spawn } from 'child_process';
import { randomInt } from 'crypto';
import path from 'path';

import { taskOrchestrationService } from '../services/TaskOrchestrationService';
import { orchestrationConfigurationHandler } from '../routes/health';
import { BOOT_CHECK_PROBE_PATHS, bootCheckProbePath, formatBootCheckProbeLine } from '../config/bootCheckProbe';
import { withPinnedBootCheckRecorder } from './support/pinnedBootCheckEndpoint';

jest.setTimeout(120_000);

const BACKEND_DIR = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(BACKEND_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  return res;
}

describe('GET /health/orchestration handler', () => {
  afterEach(() => {
    taskOrchestrationService.configure({ maxActiveGlobal: null, maxActivePerProject: null, leaseTtlSeconds: 900 });
  });

  it('answers the configured bounds from the service', () => {
    taskOrchestrationService.configure({ maxActiveGlobal: 7, maxActivePerProject: 3, leaseTtlSeconds: 120 });
    const res = fakeRes();
    orchestrationConfigurationHandler({} as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'configured',
      source: 'process',
      orchestration: { claimSurface: 'always-on', maxActiveGlobal: 7, maxActivePerProject: 3, leaseTtlSeconds: 120 },
    });
  });

  it('answers "unlimited" (the literal word, not null, not a number) when no bound is configured', () => {
    taskOrchestrationService.configure({ maxActiveGlobal: null, maxActivePerProject: null, leaseTtlSeconds: 900 });
    const res = fakeRes();
    orchestrationConfigurationHandler({} as any, res);
    expect(res.body.orchestration.maxActiveGlobal).toBe('unlimited');
    expect(res.body.orchestration.maxActivePerProject).toBe('unlimited');
  });

  it('does not re-read the environment: a value set after configure() is not what it answers', () => {
    taskOrchestrationService.configure({ maxActiveGlobal: 2, maxActivePerProject: 2, leaseTtlSeconds: 900 });
    const before = process.env.CLAWBEAT_MAX_ACTIVE_GLOBAL;
    process.env.CLAWBEAT_MAX_ACTIVE_GLOBAL = '40';
    try {
      const res = fakeRes();
      orchestrationConfigurationHandler({} as any, res);
      expect(res.body.orchestration.maxActiveGlobal).toBe(2);
    } finally {
      if (before === undefined) delete process.env.CLAWBEAT_MAX_ACTIVE_GLOBAL; else process.env.CLAWBEAT_MAX_ACTIVE_GLOBAL = before;
    }
  });
});

describe('boot-check probe path', () => {
  it('is an enumerated set holding exactly the DB-free health answer', () => {
    expect([...BOOT_CHECK_PROBE_PATHS]).toEqual(['/health/orchestration']);
  });

  it('unset or empty means no probe', () => {
    expect(bootCheckProbePath({})).toBeNull();
    expect(bootCheckProbePath({ RELAYHALL_BOOT_CHECK_PROBE: '' })).toBeNull();
  });

  it('refuses any path outside the set - including the DB-touching /health', () => {
    expect(() => bootCheckProbePath({ RELAYHALL_BOOT_CHECK_PROBE: '/health' })).toThrow(/must be one of/);
    expect(() => bootCheckProbePath({ RELAYHALL_BOOT_CHECK_PROBE: '/health/orchestration/' })).toThrow(/must be one of/);
    expect(() => bootCheckProbePath({ RELAYHALL_BOOT_CHECK_PROBE: '/tasks' })).toThrow(/must be one of/);
  });

  it('formats one line with the body flattened', () => {
    expect(formatBootCheckProbeLine({ path: '/health/orchestration', status: 200, body: '{\n "a": 1 }\n' }))
      .toBe('BOOT CHECK PROBE /health/orchestration 200 { "a": 1 }');
  });
});

interface SpawnResult { code: number | null; stdout: string; stderr: string }

function runServer(env: Record<string, string>, killAfterMs = 60_000): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, 'src/server.ts'], {
      cwd: BACKEND_DIR,
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`boot-check child did not exit within ${killAfterMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, killAfterMs);
    child.on('exit', (code) => { clearTimeout(killer); resolve({ code, stdout, stderr }); });
    child.on('error', (err) => { clearTimeout(killer); reject(err); });
  });
}

function probeLine(stdout: string): { status: number; body: any } {
  const line = stdout.split('\n').find((l) => l.startsWith('BOOT CHECK PROBE /health/orchestration '));
  if (!line) throw new Error(`no probe line in stdout:\n${stdout}`);
  const rest = line.slice('BOOT CHECK PROBE /health/orchestration '.length);
  const space = rest.indexOf(' ');
  return { status: Number(rest.slice(0, space)), body: JSON.parse(rest.slice(space + 1)) };
}

const BOOT_ENV = {
  RELAYHALL_BOOT_CHECK: '1',
  RELAYHALL_BOOT_CHECK_PROBE: '/health/orchestration',
  NODE_ENV: 'development',
  JWT_SECRET: 'qa-boot-only',
  DATA_DIR: './qa-boot-data',
  PORT: '0',
};

// Review R1 (8669c2ad B1): one fixed pair let a wiring that substitutes that
// exact constant pass. Review R2 (89f319b0 B1): interior samples let a clamp
// at the accepted upper boundary pass. So the process is handed the ACCEPTED
// BOUNDARIES (1/1, 64/64), two interior pairs, one pair drawn when this file
// loads (a value no source can know), and the two one-sided configurations.
// What sampling cannot cover is a mutation that corrupts one interior value
// only; the boundaries, the draw and the one-sided arms are the deterministic
// coverage.
const drawnGlobal = randomInt(2, 65);
const drawnPerProject = randomInt(1, drawnGlobal + 1);
type Handed = number | 'unlimited';
const HANDED: Array<[Handed, Handed, string]> = [
  [1, 1, 'lower boundary'],
  [64, 64, 'upper boundary'],
  [7, 3, 'interior'],
  [5, 2, 'interior'],
  [drawnGlobal, drawnPerProject, 'drawn at runtime'],
  [64, 'unlimited', 'global only'],
  ['unlimited', 64, 'per-project only'],
];

describe('boot-check probe - spawned server (integration)', () => {
  it.each(HANDED)('handed %s/%s (%s): the endpoint answers exactly that, with zero database attempts', async (global, perProject) => {
    // The pinned boot-check endpoint is ONE exclusive resource, shared with
    // bootCheckMode.test.ts, and its port is a production constant. Taking it
    // through the house holder is what stops two jest workers binding it at
    // the same moment (card 7e66a6c2).
    await withPinnedBootCheckRecorder(async (pinned) => {
      const env: Record<string, string> = { ...BOOT_ENV };
      if (global !== 'unlimited') env.CLAWBEAT_MAX_ACTIVE_GLOBAL = String(global);
      if (perProject !== 'unlimited') env.CLAWBEAT_MAX_ACTIVE_PER_PROJECT = String(perProject);
      const result = await runServer(env);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('BOOT CHECK OK');
      const answer = probeLine(result.stdout);
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({
        status: 'configured', source: 'process',
        orchestration: { claimSurface: 'always-on', maxActiveGlobal: global, maxActivePerProject: perProject, leaseTtlSeconds: 900 },
      });
      expect(pinned.attempts()).toBe(0);
    });
  });

  it('nothing handed to the process answers "unlimited" on both bounds', async () => {
    const result = await runServer({ ...BOOT_ENV });
    expect(result.code).toBe(0);
    const answer = probeLine(result.stdout);
    expect(answer.body.orchestration.maxActiveGlobal).toBe('unlimited');
    expect(answer.body.orchestration.maxActivePerProject).toBe('unlimited');
    expect(answer.body.orchestration.claimSurface).toBe('always-on');
  });

  it('a probe path outside the set fails the gate before bind (exit 1, no BOOT CHECK OK)', async () => {
    const result = await runServer({ ...BOOT_ENV, RELAYHALL_BOOT_CHECK_PROBE: '/health' });
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('BOOT CHECK OK');
  });
});
