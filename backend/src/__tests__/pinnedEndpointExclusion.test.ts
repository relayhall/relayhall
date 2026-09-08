/**
 * Card 7e66a6c2 — the control for the turn-taking that stands in for "bind port
 * 0" on the one endpoint that cannot move.
 *
 * The collision this repairs happened BETWEEN jest workers, which are separate
 * processes. A control that took the endpoint twice inside this process would
 * serialise on the event loop whether the mechanism worked or not — it could
 * not fail — so it would prove nothing. This one spawns three separate
 * processes that all reach for the same endpoint at once through the real
 * helper, and measures the windows in which each of them actually held it.
 *
 * Overlapping windows are exactly the EADDRINUSE condition, observed one layer
 * earlier and without depending on the kernel refusing the second bind.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  WAIT_CEILING_MS,
  bindableEndpoint,
  pinnedBootCheckEndpoint,
  withPinnedBootCheckRecorder,
} from './support/pinnedBootCheckEndpoint';

jest.setTimeout(120_000);

const BACKEND_DIR = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(BACKEND_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PROBE = path.join(__dirname, 'support', 'exclusiveEndpointProbe.ts');

const PROBES = 3;
const HOLD_MS = 400;
const PROBE_KILL_MS = 90_000;

/**
 * Each child gets its OWN temporary directory: tsx puts its IPC socket in
 * $TMPDIR, so children sharing one collide there instead — a collision in the
 * harness, which would say nothing about the endpoint.
 *
 * The probe root differs from this process's os.tmpdir(), which is how the earlier
 * marker-file design was caught splitting one endpoint across two mutexes. The
 * present design has nothing that reads TMPDIR, and this arrangement keeps it
 * that way by making the difference the normal case rather than one the control
 * happens to avoid.
 */
const PROBE_TMP_ROOT = process.env.RELAYHALL_TEST_PROBE_TMP_ROOT
  || path.join(BACKEND_DIR, 'node_modules', '.cache', 'fixg-probe-tmp');

function probeTmpdir(index: number): string {
  return path.join(PROBE_TMP_ROOT, `probe-${index}`);
}

interface ProbeResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runProbe(index: number): Promise<ProbeResult> {
  const tmpdir = probeTmpdir(index);
  fs.mkdirSync(tmpdir, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, PROBE], {
      cwd: BACKEND_DIR,
      env: {
        PATH: process.env.PATH ?? '',
        // The probe is a plain process, so boot-check mode must be in the
        // environment BEFORE it loads the production connection module. It is
        // also what keeps this control away from any database.
        RELAYHALL_BOOT_CHECK: '1',
        PROBE_HOLD_MS: String(HOLD_MS),
        TMPDIR: tmpdir,
        TMP: tmpdir,
        TEMP: tmpdir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`exclusion probe did not exit\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, PROBE_KILL_MS);
    child.on('exit', (code) => { clearTimeout(killer); resolve({ code, stdout, stderr }); });
    child.on('error', (err) => { clearTimeout(killer); reject(err); });
  });
}

interface HoldWindow {
  from: number;
  to: number;
  endpoint: string;
}

function transcript(result: ProbeResult): string {
  return `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

function readWindow(result: ProbeResult): HoldWindow {
  const held = /^HELD (\d+) (\S+)$/m.exec(result.stdout);
  const releasing = /^RELEASING (\d+)$/m.exec(result.stdout);
  if (!held || !releasing) {
    throw new Error(`a probe did not report a hold window (exit ${String(result.code)})\n${transcript(result)}`);
  }
  return { from: Number(held[1]), to: Number(releasing[1]), endpoint: held[2] };
}

/** The index of the `)` closing the parenthesis at `open`, or -1. */
function closingParen(content: string, open: number): number {
  let depth = 0;
  for (let i = open; i < content.length; i += 1) {
    if (content[i] === '(') {
      depth += 1;
    } else if (content[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * The per-test timeouts a file declares: the trailing numeric argument of an
 * `it(...)` / `test(...)` call, including the `it.each(table)(...)` form where
 * the timeout belongs to the SECOND parenthesis.
 *
 * A regex on `}, 30_000);` cannot do this — that is also the shape of an
 * ordinary `setTimeout` callback, and reading one as a test ceiling makes this
 * control fail on a file that is perfectly correct. The argument list is
 * therefore matched by balanced parentheses and only its last top-level
 * argument is read.
 */
function perTestTimeouts(content: string): number[] {
  const found: number[] = [];
  const calls = /\b(?:it|test)(?:\.\w+)*\s*\(/g;
  let call = calls.exec(content);
  while (call !== null) {
    let open = call.index + call[0].length - 1;
    let close = closingParen(content, open);
    if (close !== -1) {
      // `it.each(table)(name, fn, timeout)` — the arguments are in the next
      // parenthesis, not this one.
      const next = content.slice(close + 1).search(/\S/);
      if (next !== -1 && content[close + 1 + next] === '(') {
        open = close + 1 + next;
        close = closingParen(content, open);
      }
    }
    if (close !== -1) {
      const args = content.slice(open + 1, close);
      const trailing = /,\s*(\d[\d_]*)\s*$/.exec(args);
      if (trailing) {
        found.push(Number(trailing[1].replace(/_/g, '')));
      }
    }
    call = calls.exec(content);
  }
  return found;
}

describe('the pinned boot-check endpoint is held by one process at a time', () => {
  afterAll(() => {
    // Post-clean as well as pre-clean: a successful run used to leave three
    // directories behind in the checkout (review round 1 finding F8).
    fs.rmSync(PROBE_TMP_ROOT, { recursive: true, force: true });
  });

  it('three processes reaching for it at once take turns, and none of their hold windows overlap', async () => {
    const expected = pinnedBootCheckEndpoint();
    // A leftover socket from an earlier run under the same pid is a harness
    // collision that has nothing to say about the endpoint.
    fs.rmSync(PROBE_TMP_ROOT, { recursive: true, force: true });
    const startedAt = Date.now();
    const results = await Promise.all(Array.from({ length: PROBES }, (_unused, i) => runProbe(i)));
    const elapsed = Date.now() - startedAt;

    // Each child ran with a temporary directory of its own, none of them this
    // process's: nothing in the mechanism may depend on that agreeing.
    for (let i = 0; i < PROBES; i += 1) {
      expect(probeTmpdir(i).startsWith(os.tmpdir())).toBe(false);
    }

    for (const result of results) {
      // The whole child transcript rides along on a failure: a probe that dies
      // for a reason this control did not anticipate must say so, not reduce to
      // a bare exit code.
      expect({
        code: result.code,
        transcript: result.code === 0 ? null : transcript(result),
      }).toEqual({ code: 0, transcript: null });
    }

    const windows = results.map(readWindow).sort((a, b) => a.from - b.from);

    // Each process watched the endpoint production pins, not one of its own.
    for (const window of windows) {
      expect(window.endpoint).toBe(`${expected.host}:${expected.port}`);
      expect(window.to).toBeGreaterThanOrEqual(window.from + HOLD_MS);
    }

    // The property under test: pairwise disjoint hold windows.
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i].from).toBeGreaterThanOrEqual(windows[i - 1].to);
    }

    // Two of the three had to WAIT rather than fail, which is the half of the
    // contract disjointness alone does not carry: a mechanism that refused the
    // endpoint outright instead of waiting would also produce no overlap, by
    // producing two dead children.
    expect(elapsed).toBeGreaterThanOrEqual(HOLD_MS * PROBES);
  });

  it('reports a recorder that fails AFTER it is bound instead of swallowing it', async () => {
    // Review round 1 finding F6: the one-shot bind-error listener was retained
    // after a successful listen, so the NEXT server error resolved an
    // already-settled promise and vanished. A recorder that is no longer
    // listening observes nothing, and its zero would have read as proof.
    const observed: number[] = [];
    await expect(withPinnedBootCheckRecorder(async (recorder) => {
      recorder.server.emit('error', new Error('synthetic post-bind failure'));
      observed.push(recorder.attempts());
    })).rejects.toThrow(/failed AFTER it was bound/);

    // The body ran to completion and its count looked perfectly clean; that is
    // exactly why the failure has to be raised on the way out.
    expect(observed).toEqual([0]);
  });

  it('reports a recorder that stopped listening during the body', async () => {
    // Review round 2 finding R2-F4, and the reviewer's own input: exposing the
    // server so a control could provoke a post-bind error also put close()
    // within reach of a body. The call used to resolve cleanly, with attempts()
    // at zero — which is exactly the value the calling suites assert.
    let counted: number | undefined;
    await expect(withPinnedBootCheckRecorder(async (recorder) => {
      recorder.server.close();
      await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
      counted = recorder.attempts();
    })).rejects.toThrow(/stopped listening BEFORE its turn was over/);

    expect(counted).toBe(0);
  });

  it('lets a body that provokes nothing finish normally', async () => {
    // The negative control for the assertion above: the raise is conditional on
    // a real post-bind error, not on the way out of every call.
    const seen = await withPinnedBootCheckRecorder(async (recorder) => recorder.attempts());
    expect(seen).toBe(0);
  });

  it('refuses an endpoint no recorder could bind', () => {
    // Review round 1 finding F7. Measured directly on the validator, because
    // the production constant is in range and an assertion that only ever sees
    // a good value cannot show where the boundary is.
    const good = bindableEndpoint('127.0.0.1', 59998);
    expect(good).toEqual({ host: '127.0.0.1', port: 59998 });
    expect(bindableEndpoint('127.0.0.1', 1)).toEqual({ host: '127.0.0.1', port: 1 });
    expect(bindableEndpoint('127.0.0.1', 65535)).toEqual({ host: '127.0.0.1', port: 65535 });

    for (const port of [0, -1, 65536, 70000, 1.5, Number.NaN, '59998', null, undefined]) {
      expect(() => bindableEndpoint('127.0.0.1', port))
        .toThrow(/not pinned to a usable host:port/);
    }
    for (const host of ['', null, undefined, 127]) {
      expect(() => bindableEndpoint(host, 59998))
        .toThrow(/not pinned to a usable host:port/);
    }
  });

  it('gives up waiting before any caller of it does, so the reason reaches the reader', () => {
    // Review round 1 finding F2: the helper's ceiling sat ABOVE the jest
    // timeouts of the suites that call it, so a generic "test timed out" always
    // fired first and the helper's message — the one that names the endpoint
    // and says a process outside the tree is holding it — never reached anyone.
    //
    // The ceilings are READ OUT of the calling files rather than copied here,
    // so raising one of them cannot silently invert the ordering.
    const callers = fs.readdirSync(__dirname, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.test\.ts$/.test(entry.name))
      .map((entry) => {
        const holder = entry as unknown as { parentPath?: string; path?: string };
        return path.join(holder.parentPath ?? holder.path ?? __dirname, entry.name);
      })
      .map((full) => ({ full, content: fs.readFileSync(full, 'utf8') }))
      // An IMPORT of the helper, not a mention of it: the census control names
      // the same file in an assertion without ever calling it. Quote-agnostic
      // and path-agnostic, and `require` too — review round 2 finding R2-F1 was
      // an exact single-quoted spelling that a caller could trivially not use.
      .filter(({ content }) => /(?:from|require\s*\()\s*['"][^'"]*\bpinnedBootCheckEndpoint['"]/.test(content));

    const ceilings = callers.map(({ full, content }) => {
      const file = path.relative(__dirname, full);
      // EVERY declared ceiling in the file, not the first: R2-F1 also covered a
      // file-level 120s alongside a 30s per-test timeout, where only the
      // smaller one decides whether the helper's message ever arrives.
      const declared = [
        ...[...content.matchAll(/jest\.setTimeout\(\s*([\d_]+)\s*\)/g)]
          .map((m) => Number(m[1].replace(/_/g, ''))),
        ...perTestTimeouts(content),
      ];
      if (declared.length === 0) {
        throw new Error(`${file} calls the helper but declares no timeout at all`);
      }
      return { file, ms: Math.min(...declared) };
    });

    // The set is not empty, so the comparison below is not vacuous.
    expect(ceilings.length).toBeGreaterThanOrEqual(3);
    for (const ceiling of ceilings) {
      expect({ file: ceiling.file, ceilingBeatsWait: WAIT_CEILING_MS < ceiling.ms })
        .toEqual({ file: ceiling.file, ceilingBeatsWait: true });
    }

    // And below the deadline this control imposes on its own children, which is
    // not a jest timeout and so is not in the set above.
    expect(WAIT_CEILING_MS).toBeLessThan(PROBE_KILL_MS);

    // Nothing may hand the helper a different ceiling. The parameter is gone —
    // an arity of one is what says so, and it is what makes every comparison
    // above a statement about the wait that actually happens.
    expect(withPinnedBootCheckRecorder.length).toBe(1);
  });
});
