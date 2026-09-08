/**
 * Orchestration-configuration reachability drill (card 590c638a, ruling 4).
 *
 * The lesson this drill keeps: suites proved the claim/lease code worked and
 * nothing proved a configured value REACHED the running process - the
 * compose file never forwarded the switch, and every deployment answered
 * ORCHESTRATION_DISABLED. So this drill starts the REAL COMPILED server (the
 * artefact the container runs), hands it a bound, and requires the live
 * endpoint to answer that bound; then hands it nothing and requires the
 * literal "unlimited". The oracles' controls (`node --test
 * scripts/orchestration-config-drill-oracles.test.mjs`) prove a dropped
 * field, a wrong number, a wrong type or a missing answer each go red.
 *
 * Arms (DRILL_ARM):
 *   spawn (default)  spawn `node backend/dist/server.js` in boot-check mode
 *                    with RELAYHALL_BOOT_CHECK_PROBE=/health/orchestration
 *                    once per handed configuration, then once unset. The
 *                    handed set is the ACCEPTED BOUNDARIES 1/1 and 64/64
 *                    (review R2 89f319b0 B1: a clamp at 63 survived interior
 *                    samples), the interior pairs 7/3 and 5/2, ONE DRAWN AT
 *                    RUNTIME (review R1 8669c2ad B1: a single fixed pair let
 *                    a substituted constant pass), and the two ONE-SIDED
 *                    configurations (global only, per-project only). What
 *                    sampling cannot cover: a mutation that corrupts one
 *                    interior value only; the boundaries, the draw and the
 *                    one-sided arms are the deterministic coverage. No database,
 *                    no network beyond 127.0.0.1, exits deterministically.
 *                    Run `npm run build` in backend first. Runs in CI after
 *                    the compiled boot check.
 *   live             GET ${DRILL_BASE_URL}/api/health/orchestration on a
 *                    deployed environment and judge it against
 *                    DRILL_EXPECT_GLOBAL / DRILL_EXPECT_PER_PROJECT (an integer
 *                    or "unlimited"; unset = "unlimited"). This is the
 *                    estate-side half: the value in the env-file must be the
 *                    value the container's process answers.
 *
 * No secrets are read or printed by either arm.
 */
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedBoundFromEnv, judgeEffectiveConfiguration, parseProbeLine, PROBE_PATH } from './orchestration-config-drill-oracles.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(HERE, '..', 'backend');
const DIST_SERVER = path.join(BACKEND_DIR, 'dist', 'server.js');
const ARM = process.env.DRILL_ARM || 'spawn';

const results = [];
const record = (name, verdict, detail = {}) => {
  results.push({ name, ok: verdict.ok, reason: verdict.reason, ...detail });
  console.log(`  ${verdict.ok ? 'PASS' : 'FAIL'} ${name}: ${verdict.reason}`);
};

function runCompiledServer(env, killAfterMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DIST_SERVER], {
      cwd: BACKEND_DIR,
      env: {
        PATH: process.env.PATH ?? '',
        RELAYHALL_BOOT_CHECK: '1',
        RELAYHALL_BOOT_CHECK_PROBE: PROBE_PATH,
        NODE_ENV: 'development',
        JWT_SECRET: 'drill-boot-only-not-a-secret-0123456789',
        DATA_DIR: './qa-boot-data',
        PORT: '0',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    const killer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`compiled server did not exit within ${killAfterMs}ms`)); }, killAfterMs);
    child.on('exit', (code) => { clearTimeout(killer); resolve({ code, stdout, stderr }); });
    child.on('error', (err) => { clearTimeout(killer); reject(err); });
  });
}

if (ARM === 'spawn') {
  if (!existsSync(DIST_SERVER)) throw new Error(`${DIST_SERVER} is missing - run \`npm run build\` in backend first; this drill runs the COMPILED server on purpose`);
  console.log(`spawn arm: ${DIST_SERVER}`);

  // The accepted boundaries, two interior pairs, one drawn now
  // (1 <= per-project <= global <= 64), and the two one-sided configurations.
  const drawnGlobal = randomInt(2, 65);
  const drawnPerProject = randomInt(1, drawnGlobal + 1);
  const handed = [
    [1, 1, 'lower boundary'],
    [64, 64, 'upper boundary'],
    [7, 3, 'interior'],
    [5, 2, 'interior'],
    [drawnGlobal, drawnPerProject, 'drawn at runtime'],
    [64, 'unlimited', 'global only'],
    ['unlimited', 64, 'per-project only'],
  ];
  const answers = [];
  for (const [g, p, label] of handed) {
    const env = {};
    if (g !== 'unlimited') env.CLAWBEAT_MAX_ACTIVE_GLOBAL = String(g);
    if (p !== 'unlimited') env.CLAWBEAT_MAX_ACTIVE_PER_PROJECT = String(p);
    const run = await runCompiledServer(env);
    const answer = run.code === 0 ? parseProbeLine(run.stdout) : null;
    answers.push(answer);
    record(`handed ${g}/${p} (${label}) reaches the compiled process`,
      run.code === 0
        ? judgeEffectiveConfiguration(answer, { maxActiveGlobal: g, maxActivePerProject: p })
        : { ok: false, reason: `compiled server exited ${run.code}: ${run.stderr.slice(-300)}` },
      { exit: run.code, handed: [g, p] });
  }
  const bounded = { code: 0, stdout: '', answer: answers[2] };

  const unset = await runCompiledServer({});
  record('nothing handed answers "unlimited" on both bounds',
    unset.code === 0
      ? judgeEffectiveConfiguration(parseProbeLine(unset.stdout), { maxActiveGlobal: 'unlimited', maxActivePerProject: 'unlimited' })
      : { ok: false, reason: `compiled server exited ${unset.code}: ${unset.stderr.slice(-300)}` },
    { exit: unset.code });

  // Sensitivity: the oracle must tell the arms apart, or a process that
  // ignored its environment would pass them all.
  const crossed = judgeEffectiveConfiguration(bounded.answer, { maxActiveGlobal: 'unlimited', maxActivePerProject: 'unlimited' });
  record('sensitivity: the 7/3 answer judged against "unlimited" is RED', { ok: crossed.ok === false, reason: crossed.ok === false ? `red as required (${crossed.reason})` : 'the oracle could not tell 7/3 from unlimited' });
  const crossedPairs = judgeEffectiveConfiguration(answers[2], { maxActiveGlobal: 5, maxActivePerProject: 2 });
  record('sensitivity: the 7/3 answer judged against 5/2 is RED', { ok: crossedPairs.ok === false, reason: crossedPairs.ok === false ? `red as required (${crossedPairs.reason})` : 'the oracle could not tell 7/3 from 5/2' });
} else if (ARM === 'live') {
  const base = process.env.DRILL_BASE_URL;
  if (!base) throw new Error('DRILL_BASE_URL must be set for the live arm');
  const expected = {
    maxActiveGlobal: expectedBoundFromEnv(process.env.DRILL_EXPECT_GLOBAL),
    maxActivePerProject: expectedBoundFromEnv(process.env.DRILL_EXPECT_PER_PROJECT),
  };
  const url = `${base.replace(/\/$/, '')}/api${PROBE_PATH}`;
  console.log(`live arm: GET ${url} expecting ${JSON.stringify(expected)}`);
  let answer = null;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    answer = { status: res.status, body };
  } catch (e) {
    answer = null;
    console.log(`  request failed: ${String(e).slice(0, 200)}`);
  }
  record(`live ${url}`, judgeEffectiveConfiguration(answer, expected), { answer: answer?.body?.orchestration ?? null });
} else {
  throw new Error(`DRILL_ARM must be "spawn" or "live", got ${JSON.stringify(ARM)}`);
}

const ok = results.every((r) => r.ok);
console.log('RESULT ' + JSON.stringify({ ok, arm: ARM, results }));
process.exit(ok ? 0 : 1);
