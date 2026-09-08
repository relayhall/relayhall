/**
 * scale-read-load-mutation-drill.ts — the RED PROOF for card 590e88cc.
 *
 * A gate that has never been seen to fail is a claim, not a control. This
 * script reintroduces each defect the candidate repaired, one at a time, and
 * requires `npm run test:scale-load` to go RED — and requires each mutation to
 * redden a DIFFERENT assertion, because a drill whose mutations all trip the
 * same line proves one control, not six.
 *
 * Every mutation is applied to a COPY of the tree under a temporary directory
 * and reverted by deleting it; the working tree is never edited.
 *
 * DESTRUCTIVE against the database it is pointed at: each run executes the full
 * gate, which seeds thousands of rows and archives completed Tasks. Point
 * RELAYHALL_TEST_DB_URL at a disposable local database only.
 *
 *   RELAYHALL_TEST_DB_URL=postgres://scale:scale@127.0.0.1:15701/relayhall_scale \
 *     node ./node_modules/.bin/tsx scripts/scale-read-load-mutation-drill.ts
 */
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const BACKEND = path.resolve(__dirname, '..');

interface Mutation {
  id: string;
  what: string;
  /** The assertion this mutation must redden — checked in the output, so two
   * mutations that trip the same line are reported as the defect they are. */
  reddens: string;
  /** A source edit, or a schema edit expressed as SQL. */
  file?: string;
  find?: string;
  replace?: string;
  sql?: string;
  /** A SECOND edit in the same file, for a mutation that must remove more than
   * one mechanism to be visible at all. */
  also?: { find: string; replace: string };
  /** Extra environment for THIS run only. A configuration can be the
   * mutation: a gate whose non-vacuity an environment variable can switch off
   * is a gate with a hole, and the only way to prove the hole is closed is to
   * try the value. */
  env?: Record<string, string>;
  /** `compensated` marks a mutation the candidate is EXPECTED to survive
   * because another mechanism covers it. A drill that reported those as
   * failures would be reporting defence in depth as a defect; one that stayed
   * silent about them would be hiding which of two mechanisms is load-bearing.
   */
  expect?: 'red' | 'compensated';
}

const MUTATIONS: Mutation[] = [
  {
    id: 'M1',
    what: 'restore the per-row dependency fan-out in GET /tasks (the reported defect, verbatim)',
    reddens: 'pool acquisitions per GET /tasks are invariant',
    file: 'src/routes/tasks.ts',
    // The WHOLE batched block is replaced, not just its tail: leaving the
    // set read in place would leave `summarize` unused, and `noUnusedLocals`
    // would turn the mutation into a COMPILE error. A suite that never runs
    // reddens nothing, and a drill cannot then say which control caught what.
    find: `    const edges = await taskManager.getDependencyEdgesForTasks(tasks.map((task: any) => task.id));
    const blockingFor = (taskId: string) =>
      (edges.blocking.get(taskId) ?? []).filter((edge) => dependencyBlocks(edge.status, edge.archiveDisposition));
    const relatedIds = [...new Set([
      ...tasks.flatMap((task: any) => blockingFor(task.id).map((edge) => edge.id)),
      ...tasks.flatMap((task: any) => (edges.dependents.get(task.id) ?? []).map((edge) => edge.id)),
    ])];
    const readableRelated = new Set((await filterAuthorizedResources(
      req as AuthRequest,
      'read',
      relatedIds,
      (id) => ({ type: 'task', id }),
    )));
    const summarize = (list: { id: string; title: string }[]) =>
      list.filter((edge) => readableRelated.has(edge.id)).map((edge) => ({ id: edge.id, title: edge.title }));
    const tasksWithDeps = tasks.map((task: any) => {
      const blocking = blockingFor(task.id);
      return {
        ...task,
        blocked: blocking.length > 0,
        blockingTasks: summarize(blocking),
        dependentTasks: summarize(edges.dependents.get(task.id) ?? []),
      };
    });`,
    replace: `    void dependencyBlocks;
    const tasksWithDeps = await Promise.all(tasks.map(async (task: any) => {
      const blockingTasks = await filterAuthorizedResources(
        req as AuthRequest, 'read', await taskManager.getBlockingTasks(task.id),
        (related: any) => ({ type: 'task', id: related.id }));
      const dependentTasks = await filterAuthorizedResources(
        req as AuthRequest, 'read', await taskManager.getDependentTasks(task.id),
        (related: any) => ({ type: 'task', id: related.id }));
      return {
        ...task,
        blocked: await taskManager.isTaskBlocked(task.id),
        blockingTasks: blockingTasks.map((t: any) => ({ id: t.id, title: t.title })),
        dependentTasks: dependentTasks.map((t: any) => ({ id: t.id, title: t.title })),
      };
    }));`,
  },
  {
    id: 'M2',
    what: 'drop the task_links(task_id) index migration 129 restored',
    reddens: 'task_links and task_dependencies can be looked up',
    sql: 'DROP INDEX IF EXISTS public.idx_task_links_task_id',
  },
  {
    id: 'M3',
    what: 'drop the task_dependencies(depends_on_task_id) index migration 129 restored',
    reddens: 'task_links and task_dependencies can be looked up',
    sql: 'DROP INDEX IF EXISTS public.idx_task_dependencies_depends_on',
  },
  {
    id: 'M4',
    what: 'narrow `blocked` by the caller — the plausible tidying that would tell a caller an unreadable blocker does not exist',
    reddens: 'an unreadable blocker is hidden from the summary and still makes the holder blocked',
    file: 'src/routes/tasks.ts',
    find: '        blocked: blocking.length > 0,',
    replace: '        blocked: summarize(blocking).length > 0,',
  },
  {
    id: 'M5',
    what: 'drop the narrowing on the dependency summaries — the batched read leaks every related Task',
    reddens: 'an unreadable blocker is hidden from the summary and still makes the holder blocked',
    file: 'src/routes/tasks.ts',
    // `|| true` rather than deleting the filter: `noUnusedLocals` would turn a
    // deletion into a COMPILE error, and a suite that never runs reddens
    // nothing. The leak is the same leak.
    find: '      list.filter((edge) => readableRelated.has(edge.id)).map((edge) => ({ id: edge.id, title: edge.title }));',
    replace: '      list.filter((edge) => readableRelated.has(edge.id) || true).map((edge) => ({ id: edge.id, title: edge.title }));',
  },
  {
    id: 'M6',
    what: 'invert the `dependencyBlocks` filter — a satisfied dependency would report its holder as blocked and a real blocker would vanish',
    reddens: 'blocked, blockingTasks and dependentTasks agree with the point forms',
    file: 'src/routes/tasks.ts',
    find: '      (edges.blocking.get(taskId) ?? []).filter((edge) => dependencyBlocks(edge.status, edge.archiveDisposition));',
    replace: '      (edges.blocking.get(taskId) ?? []).filter((edge) => !dependencyBlocks(edge.status, edge.archiveDisposition));',
  },
  {
    id: 'M7',
    what: 'remove the AutoArchive cycle ceiling CHECK (expected COMPENSATED: the batch LIMIT clamps to the same bound)',
    reddens: 'a cycle stops at its ceiling and the next cycle takes the remainder',
    expect: 'compensated',
    file: 'src/services/autoArchive.ts',
    find: '        if (archived >= this.maxPerCycle) { capped = true; break; }',
    replace: '        if (false) { capped = true; break; }',
  },
  {
    id: 'M7b',
    what: 'remove BOTH the ceiling check and the LIMIT clamp — the cycle becomes unbounded',
    reddens: 'a cycle stops at its ceiling and the next cycle takes the remainder',
    file: 'src/services/autoArchive.ts',
    find: `        if (archived >= this.maxPerCycle) { capped = true; break; }`,
    replace: `        if (false) { capped = true; break; }
        void this.maxPerCycle;`,
    also: {
      find: '          [cutoff.toISOString(), Math.min(this.batchSize, this.maxPerCycle - archived)],',
      replace: '          [cutoff.toISOString(), this.batchSize],',
    },
  },
  {
    id: 'M9',
    what: 'restore the 2,000ms connection acquisition deadline',
    // The DETERMINISTIC control is the one named here. Restoring 2,000ms also
    // reddens the five-path battery, and sometimes the focused one — but only
    // when the machine stalls the loop enough, which is precisely why the
    // deterministic control exists.
    reddens: 'acquisitions queued behind a full pool are not failed by a stall the product produces',
    file: 'src/db/connection.ts',
    find: '        connectionTimeoutMillis: 15000,',
    replace: '        connectionTimeoutMillis: 2000,',
  },
  {
    id: 'M10',
    what: 'restore the fail-open guard in the seed script: read the ENVIRONMENT rather than what the pool resolves to',
    reddens: 'an absent DB_NAME is refused, because the pool resolves it to a deployment database',
    file: 'scripts/seed-scale-fixture.ts',
    find: `  const { databasePoolConfig } = require('../src/db/connection');
  const dbName = String(databasePoolConfig.database ?? '');
  const dbHost = String(databasePoolConfig.host ?? '');`,
    replace: `  const dbName = process.env.DB_NAME || '';
  const dbHost = process.env.DB_HOST || 'localhost';`,
    // R2 follow-up: leaving the empty-name refusal in place made this only
    // a refusal-message mutation. Remove it too so the old unsafe acceptance
    // is restored and the control must fail on accepted=true.
    also: {
      find: `  if (!dbName) {
    throw new Error('The pool resolves to no database name at all. Refusing to write.');
  }
`,
      replace: '',
    },
  },
  {
    id: 'M11',
    what: 'CONFIGURATION AS THE MUTATION: run the unmutated gate with SCALE_LOAD_CONCURRENCY=0 — it must REFUSE rather than measure nothing',
    reddens: '<suite failed to run — no assertion was reached>',
    env: { SCALE_LOAD_CONCURRENCY: '0' },
  },
  {
    id: 'M8',
    what: 'CONTROL ON THE CONTROL: make both invariance measurements the same size, so the comparison is between a number and itself',
    reddens: 'the two measurements were taken over genuinely different populations',
    file: 'src/__tests__/scaleReadLoad.test.ts',
    find: 'const SMALL_TASKS = 300;',
    replace: 'const SMALL_TASKS = SCALE_TASKS - 1;',
  },
];

function freshDatabase(): void {
  execFileSync('docker', ['exec', 'rh-scale-pg', 'psql', '-U', 'scale', '-d', 'postgres', '-q', '-c',
    'DROP DATABASE IF EXISTS relayhall_scale WITH (FORCE)', '-c', 'CREATE DATABASE relayhall_scale OWNER scale'],
    { stdio: 'inherit' });
  execFileSync('node', ['scripts/load-base-schema.js'], { cwd: BACKEND, stdio: 'ignore', env: process.env });
  execFileSync('npm', ['run', 'migrate'], { cwd: BACKEND, stdio: 'ignore', env: process.env });
}

function runGate(cwd: string, extraEnv: Record<string, string> = {}): { passed: boolean; output: string } {
  const result = spawnSync('npx', ['jest', '--runInBand', '--testPathIgnorePatterns=/node_modules/',
    '--runTestsByPath', 'src/__tests__/scaleReadLoad.test.ts'], {
    cwd, encoding: 'utf8', env: { ...process.env, ...extraEnv }, timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { passed: result.status === 0, output };
}

/** The assertion names jest reports as FAILING, taken from its own output. */
function failingTests(output: string): string[] {
  const named = [...output.matchAll(/✕\s+(.+?)(?:\s+\(\d+\s*m?s\))?$/gm)].map((m) => m[1].trim());
  // A suite that fails to RUN — a compile error, or a throw in `beforeAll` —
  // prints no ✕ line at all. Reporting that as "reddened nothing" would let a
  // mutation that merely broke the build pass for the wrong reason.
  if (named.length === 0 && /Test suite failed to run|beforeAll/.test(output)) {
    return ['<suite failed to run — no assertion was reached>'];
  }
  return named;
}

/** The source LINES jest points at, so two mutations reddening the same test
 * can still be told apart by which assertion inside it they tripped. */
function failingLines(output: string): string[] {
  return [...new Set([...output.matchAll(/scaleReadLoad\.test\.ts:(\d+):\d+/g)].map((m) => m[1]))];
}

function main(): void {
  if (!process.env.RELAYHALL_TEST_DB_URL) {
    console.error('RELAYHALL_TEST_DB_URL is not set; the drill runs the real-PostgreSQL gate.');
    process.exit(1);
  }

  const results: Array<{ id: string; red: boolean; failing: string[]; lines: string[] }> = [];
  // Every run's full jest output is kept, so a claim about which assertion
  // reddened can be checked rather than taken on this script's word.
  const logDir = process.env.SCALE_DRILL_LOGS || path.join(BACKEND, '..', 'tmp', 'scale-drill');
  fs.mkdirSync(logDir, { recursive: true });
  const onlyIndex = process.argv.indexOf('--only');
  const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : null;

  console.log('=== BASELINE: the unmutated candidate must be GREEN ===');
  freshDatabase();
  const baseline = runGate(BACKEND);
  fs.writeFileSync(path.join(logDir, 'baseline.log'), baseline.output);
  console.log(baseline.passed ? 'baseline GREEN' : 'baseline RED — the drill proves nothing until it is green');
  if (!baseline.passed) {
    console.log(baseline.output.slice(-4000));
    process.exit(1);
  }

  for (const mutation of MUTATIONS) {
    if (only && mutation.id !== only) continue;
    console.log(`\n=== ${mutation.id}: ${mutation.what} ===`);
    freshDatabase();

    let workdir = BACKEND;
    let temp: string | null = null;
    if (mutation.file) {
      temp = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-drill-'));
      // A copy of the backend, minus node_modules, symlinked back so the run
      // costs a copy of the source rather than of the dependency tree.
      execFileSync('rsync', ['-a', '--exclude', 'node_modules', '--exclude', 'dist', `${BACKEND}/`, `${temp}/`]);
      fs.symlinkSync(path.join(BACKEND, 'node_modules'), path.join(temp, 'node_modules'));
      const target = path.join(temp, mutation.file);
      const source = fs.readFileSync(target, 'utf8');
      const occurrences = source.split(mutation.find as string).length - 1;
      if (occurrences !== 1) {
        console.log(`  SKIP-FAIL: the mutation anchor appears ${occurrences} times; a drill that cannot apply its mutation proves nothing`);
        results.push({ id: mutation.id, red: false, failing: [], lines: [] });
        fs.rmSync(temp, { recursive: true, force: true });
        continue;
      }
      let mutated = source.replace(mutation.find as string, mutation.replace as string);
      if (mutation.also) {
        if (mutated.split(mutation.also.find).length - 1 !== 1) {
          console.log('  SKIP-FAIL: the second mutation anchor did not appear exactly once');
          results.push({ id: mutation.id, red: false, failing: [], lines: [] });
          fs.rmSync(temp, { recursive: true, force: true });
          continue;
        }
        mutated = mutated.replace(mutation.also.find, mutation.also.replace);
      }
      fs.writeFileSync(target, mutated);
      workdir = temp;
    }
    if (mutation.sql) {
      execFileSync('docker', ['exec', 'rh-scale-pg', 'psql', '-U', 'scale', '-d', 'relayhall_scale', '-q', '-c', mutation.sql],
        { stdio: 'inherit' });
    }

    const run = runGate(workdir, mutation.env ?? {});
    fs.writeFileSync(path.join(logDir, `${mutation.id}.log`), run.output);
    const failing = failingTests(run.output);
    const lines = failingLines(run.output);
    console.log(`  gate ${run.passed ? 'GREEN (mutation SURVIVED)' : 'RED'}`);
    for (const name of failing) console.log(`    reddened: ${name}`);
    if (lines.length) console.log(`    at assertion line(s): ${lines.join(', ')}`);
    results.push({ id: mutation.id, red: !run.passed, failing, lines });
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  }

  console.log('\n=== SUMMARY ===');
  let ok = true;
  for (const result of results) {
    const mutation = MUTATIONS.find((m) => m.id === result.id) as Mutation;
    const hit = result.failing.some((name) => name.includes(mutation.reddens));
    let verdict: string;
    if (mutation.expect === 'compensated') {
      // A compensated mutation must SURVIVE, and its surviving is the claim:
      // the mechanism it removed is not the only thing holding the property.
      verdict = result.red ? 'RED — expected COMPENSATED, so the second mechanism is not there' : 'COMPENSATED (survived, as expected)';
      if (result.red) ok = false;
    } else {
      verdict = result.red && hit ? 'RED (as named)' : result.red ? 'RED, but not the named assertion' : 'SURVIVED';
      if (!result.red || !hit) ok = false;
    }
    console.log(`${result.id}  ${verdict}  at line(s) ${result.lines.join(', ') || '—'}  — expected: ${mutation.reddens}`);
  }
  // Two mutations may name the same TEST — M4 and M5 both attack the
  // authorization property — but they must not trip the same LINE, or one of
  // them is proving nothing the other did not already prove.
  const lineSets = results.filter((r) => r.red).map((r) => r.lines.join(','));
  const duplicateLines = lineSets.filter((set, index) => set && lineSets.indexOf(set) !== index);
  console.log(`\ndistinct reddened assertion sets: ${new Set(lineSets).size} of ${lineSets.length} red mutations`);
  if (duplicateLines.length) {
    console.log(`WARNING: mutations reddening an identical assertion set: ${[...new Set(duplicateLines)].join(' | ')}`);
  }
  console.log(ok ? 'DRILL PASSED' : 'DRILL FAILED');
  process.exit(ok ? 0 : 1);
}

main();
