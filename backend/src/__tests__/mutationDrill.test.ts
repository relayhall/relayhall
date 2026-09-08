/**
 * RH-AZ.PROJ-a — the control ON the mutation drill.
 *
 * Three review rounds each found a defect in the control written for the
 * previous round, and round 3 (`a8e380f1`) found the last one in the DRILL
 * ITSELF: its red detector could report an unrelated assertion while swallowing
 * a suite that never compiled, and could call an infrastructure failure a clean
 * green. A drill that misreports is worse than no drill, because every other
 * control's red proof rests on it.
 *
 * This file is where that regress stops. The classifier is a pure function, and
 * the cases below are the exact outputs that fooled the old detector — fed to
 * it directly, so the honesty of every other red proof in this candidate is
 * itself measured by an assertion rather than asserted in prose.
 *
 * It also checks that the drill TABLE still matches the tree: an anchor that no
 * longer occurs, or occurs twice, means the drill is measuring nothing, and
 * that is caught here rather than discovered in a review.
 */
import fs from 'fs';
import path from 'path';
import {
  BACKEND_ROOT,
  DRILL_SUITES,
  MUTATIONS,
  classifyJestRun,
} from './support/mutationDrill';

const CLEAN = [
  'PASS src/__tests__/taskAccessWriter.test.ts',
  '  TaskAccessService — the attributed writer',
  '    ✓ refuses an ARCHIVED Task, as 085 refuses an archived Phase (2 ms)',
  '',
  'Test Suites: 5 passed, 5 total',
  'Tests:       52 passed, 52 total',
].join('\n');

const ONE_RED = [
  'FAIL src/__tests__/taskAccessWriter.test.ts',
  '  TaskAccessService — the attributed writer',
  '    ✕ refuses an ARCHIVED Task, as 085 refuses an archived Phase (3 ms)',
  '',
  'Test Suites: 1 failed, 4 passed, 5 total',
  'Tests:       1 failed, 51 passed, 52 total',
].join('\n');

/** A suite that never compiled. Jest names it exactly this way. */
const COMPILE_BROKEN = [
  'FAIL src/__tests__/taskAccessWriter.test.ts',
  '  ● Test suite failed to run',
  '',
  "    error TS6133: 'ARCHIVED_STATUS' is declared but its value is never read.",
  '',
  'Test Suites: 1 failed, 4 passed, 5 total',
  'Tests:       45 passed, 45 total',
].join('\n');

/** The case that fooled the old detector: a breakage AND an unrelated red. */
const MIXED = [
  'FAIL src/__tests__/taskAccessWriter.test.ts',
  '  ● Test suite failed to run',
  '',
  "    error TS6133: 'ARCHIVED_STATUS' is declared but its value is never read.",
  '',
  'FAIL src/__tests__/sharedAuthorization.test.ts',
  '  pointAuthorizationTarget',
  '    ✕ recognises a COLLECTION word at every spelling too (4 ms)',
  '',
  'Test Suites: 2 failed, 3 passed, 5 total',
  'Tests:       1 failed, 44 passed, 45 total',
].join('\n');

/** A runner that died before jest said anything. */
const RUNNER_DIED = 'npm ERR! could not determine executable to run';

describe('the mutation drill classifier (review a8e380f1 finding 2)', () => {
  it('calls a clean run GREEN, and only a clean run', () => {
    const verdict = classifyJestRun({ exitCode: 0, output: CLEAN });
    expect(verdict.status).toBe('GREEN');
    expect(verdict.reds).toEqual([]);
  });

  it('calls a single failed assertion RED and names it', () => {
    const verdict = classifyJestRun({ exitCode: 1, output: ONE_RED });
    expect(verdict.status).toBe('RED');
    expect(verdict.reds).toEqual(['refuses an ARCHIVED Task, as 085 refuses an archived Phase']);
  });

  it('refuses to score a mutation that broke COMPILATION', () => {
    const verdict = classifyJestRun({ exitCode: 1, output: COMPILE_BROKEN });
    expect(verdict.status).toBe('INVALID');
    expect(verdict.reason).toContain('FAILED TO RUN');
  });

  it('does NOT let an unrelated red hide a suite that failed to run', () => {
    // THE round-3 defect, verbatim. The old detector reported the collection
    // -word assertion and said nothing about the broken suite.
    const verdict = classifyJestRun({ exitCode: 1, output: MIXED });
    expect(verdict.status).toBe('INVALID');
    expect(verdict.reds).toEqual([]);
    expect(verdict.reason).toContain('FAILED TO RUN');
  });

  it('refuses a run with no summary at all', () => {
    const verdict = classifyJestRun({ exitCode: 1, output: RUNNER_DIED });
    expect(verdict.status).toBe('INVALID');
    expect(verdict.reason).toContain('no run summary');
  });

  it('refuses a run that executed ZERO tests', () => {
    const verdict = classifyJestRun({
      exitCode: 1,
      output: 'Test Suites: 0 total\nTests:       0 total',
    });
    expect(verdict.status).toBe('INVALID');
    expect(verdict.reason).toContain('ZERO tests');
  });

  it('refuses a non-zero exit that reddened no assertion', () => {
    const verdict = classifyJestRun({
      exitCode: 1,
      output: 'Test Suites: 1 failed, 4 passed, 5 total\nTests:       52 passed, 52 total',
    });
    expect(verdict.status).toBe('INVALID');
    expect(verdict.reason).toContain('infrastructural');
  });

  it('refuses a run whose failure count and red lines disagree', () => {
    // Without --verbose jest prints no per-assertion lines, so a caller who
    // dropped the flag would otherwise get a silent, empty RED.
    const verdict = classifyJestRun({
      exitCode: 1,
      output: 'Test Suites: 1 failed, 4 passed, 5 total\nTests:       3 failed, 49 passed, 52 total',
    });
    expect(verdict.status).toBe('INVALID');
    expect(verdict.reason).toContain('unattributed');
  });

  it('refuses an exit code that contradicts the summary', () => {
    const verdict = classifyJestRun({ exitCode: 0, output: ONE_RED });
    expect(verdict.status).toBe('INVALID');
    expect(verdict.reason).toContain('contradicts');
  });

  it('reads jest output that carries colour codes', () => {
    const esc = String.fromCharCode(27);
    const coloured = ONE_RED.replace(
      '    ✕ refuses',
      '    ' + esc + '[31m✕' + esc + '[0m refuses',
    );
    expect(classifyJestRun({ exitCode: 1, output: coloured }).reds).toHaveLength(1);
  });
});

describe('the mutation drill table still matches the tree', () => {
  it('anchors every mutation at exactly one place in its target file', () => {
    const drifted: string[] = [];
    for (const mutation of MUTATIONS) {
      const target = path.join(BACKEND_ROOT, mutation.file);
      const source = fs.readFileSync(target, 'utf8');
      const occurrences = source.split(mutation.find).length - 1;
      if (occurrences !== 1) {
        drifted.push(mutation.id + ' -> ' + occurrences + ' matches in ' + mutation.file);
      }
    }
    expect(drifted).toEqual([]);
  });

  it('changes something: no mutation is a no-op', () => {
    for (const mutation of MUTATIONS) {
      expect(mutation.replace).not.toBe(mutation.find);
      expect(mutation.expects.length).toBeGreaterThan(0);
    }
  });

  it('runs the suites that actually hold the controls', () => {
    for (const suite of DRILL_SUITES) {
      expect(fs.existsSync(path.join(BACKEND_ROOT, suite))).toBe(true);
    }
  });
});
