/**
 * LANE FIX-C — the mint-target authorization mutation drill (card `45e7110a`).
 *
 * A control is only evidence if it can go red. Each mutation below reintroduces
 * ONE half of the defect — the read-authorization bypass on the session
 * dispatch, or the existence oracle on either dispatch — runs the gate, and
 * records which assertions reddened. The scoring reuses `classifyJestRun` and
 * `drillWith` from `support/mutationDrill`, so this drill cannot report an
 * assertion while swallowing a suite that never compiled.
 *
 * Every mutation must still COMPILE. The authorization call is therefore
 * neutralised by widening what counts as authorized rather than by deleting the
 * call: a deleted call leaves `filterAuthorizedResources` unimported and
 * `noUnusedLocals` refuses the file, and the run measures nothing.
 *
 * WHAT THE MUTATION SCORE DOES AND DOES NOT COVER (round-1 review C3). Each
 * mutation aims at a DIFFERENT assertion, and the table below names which. It
 * does NOT follow that every assertion in the controls is mutation-covered:
 * the mutations target the DECISIONS — the bounds, the guards, the refusals —
 * and the remaining assertions are BASELINE INVARIANTS (counter partitions,
 * default values, one key not suppressing another, a census that is not
 * empty). Those are worth asserting and are not claimed as mutation-verified.
 *
 * N2 is the VACUITY control and is
 * aimed at the assertion the others cannot reach: a target check that refuses
 * EVERY caller satisfies the ceiling, the indistinguishability and the
 * no-disclosure assertions perfectly, and breaks the feature. N3 is the DRIFT
 * control — the two refusals stop matching without either becoming wrong on its
 * own, which is exactly how the original oracle was written.
 *
 * Run it:
 *   cd backend
 *   RELAYHALL_TEST_DB_URL=postgres://…/disposable npx tsx scripts/mint-target-authorization-mutation-drill.ts
 *
 * The DATABASE is written to and must be disposable — same contract as the gate
 * it drives (`src/__tests__/mintTargetAuthorization.test.ts`). Every file it
 * touches is restored, including on failure. Developer tool, not a CI step.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  BACKEND_ROOT,
  JestRun,
  Mutation,
  MutationResult,
  classifyJestRun,
  drillWith,
} from '../src/__tests__/support/mutationDrill';

const ROUTE = 'src/routes/delegation.ts';
const APPROVALS = 'src/services/ApprovalService.ts';
const SUITES = ['src/__tests__/mintTargetAuthorization.test.ts'];

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  console.error(
    'RELAYHALL_TEST_DB_URL is not set. This drill drives a gate that measures an authorization\n'
    + 'predicate against a REAL PostgreSQL. Create a disposable database, load database/init.sql,\n'
    + 'run npm run migrate, and set RELAYHALL_TEST_DB_URL to it.',
  );
  process.exit(2);
}

function runSuites(): JestRun {
  const result = spawnSync(
    'npx',
    ['jest', '--runInBand', '--verbose', '--testPathIgnorePatterns=/node_modules/', '--runTestsByPath', ...SUITES],
    {
      cwd: BACKEND_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, RELAYHALL_TEST_DB_URL: TEST_DB_URL },
    },
  );
  if (result.error) return { exitCode: null, output: String(result.error.message) };
  return {
    exitCode: result.status,
    output: [result.stdout ?? '', result.stderr ?? ''].join(String.fromCharCode(10)),
  };
}

/** A mutation that must be applied to a SECOND file at the same time. */
interface MutationWithSecond extends Mutation {
  also?: { file: string; find: string; replace: string };
}

/**
 * Run the suites with one more file mutated, restoring it whatever happens.
 *
 * The outer `drillWith` still owns the first file, so neither restore is
 * written twice — the duplicated `finally` is precisely the thing a drill
 * must not grow.
 */
function runnerAlsoMutating(second: { file: string; find: string; replace: string }): () => JestRun {
  return () => {
    const target = path.join(BACKEND_ROOT, second.file);
    const original = fs.readFileSync(target, 'utf8');
    if (original.split(second.find).length - 1 !== 1) {
      return { exitCode: null, output: `the second-file anchor for ${second.file} does not occur exactly once` };
    }
    try {
      fs.writeFileSync(target, original.replace(second.find, second.replace));
      return runSuites();
    } finally {
      fs.writeFileSync(target, original);
    }
  };
}

function reportCompensated(results: MutationResult[]): void {
  const LF = String.fromCharCode(10);
  const lines: string[] = ['## COMPENSATED — mutations that must leave the controls GREEN', ''];
  lines.push('| mutation | status | stayed green | reddened |');
  lines.push('|---|---|---|---|');
  for (const r of results) {
    lines.push(
      `| \`${r.mutation.id}\` | ${r.classification.status} `
      + `| ${r.classification.status === 'GREEN' ? 'yes' : 'NO'} | ${r.classification.reds.length} |`,
    );
  }
  lines.push('');
  for (const r of results) {
    lines.push(`### ${r.mutation.id}`);
    lines.push(`Removes: ${r.mutation.reintroduces}`);
    lines.push(`Classification: ${r.classification.status} — ${r.classification.reason}`);
    if (r.classification.reds.length) {
      lines.push('Reddened (it should not have):');
      for (const red of r.classification.reds) lines.push(`  - ${red}`);
    }
    lines.push('');
  }
  console.log(lines.join(LF));
}

const MUTATIONS: Mutation[] = [
  {
    id: 'N1-both-target-checks-removed',
    reintroduces:
      'the bypass itself: NEITHER the route nor the mint transaction consults the shared '
      + 'predicate about the target, so an Account mints against — and receives the compiled '
      + 'Brief of — a Task GET /tasks/:id refuses it. It takes BOTH because the repair is '
      + 'defence in depth after round-1 finding P2; see COMPENSATED below, which proves that '
      + 'rather than asserting it',
    file: ROUTE,
    find: '        if (readable.length === 0) {',
    replace: '        if (readable.length === 0 && readable.length > 0) {',
    also: {
      file: APPROVALS,
      find: '      if (!authorizedTargets.has(String(input.targetTaskId))) {',
      replace: '      if (!authorizedTargets.has(String(input.targetTaskId)) && authorizedTargets.size < 0) {',
    },
    expects: ['the mint succeeds exactly when GET /tasks/:id answers 200'],
  },
  {
    id: 'N2-target-check-refuses-everyone',
    reintroduces:
      'the VACUITY repair: a target check that admits nobody. Every disclosure assertion '
      + 'passes and the feature is gone',
    file: ROUTE,
    find: '        if (readable.length === 0) {',
    replace: '        if (readable.length >= 0) {',
    expects: ['mints for the holder and carries its Task title in the Brief'],
  },
  {
    id: 'N3-absence-answered-before-authorization',
    reintroduces:
      'the SHAPE of the original oracle rather than its exact text: absence is answered by a '
      + 'check of its own, ahead of the authorization branch, so the two refusals stop sharing '
      + 'a code path and drift apart in wording. Each is defensible alone, and any id can be '
      + 'tested for existence by the difference. This is the control for the refactor the '
      + 'repair is actually exposed to — the single branch is what makes the two answers '
      + 'identical, and nothing but this assertion notices when it is split',
    file: ROUTE,
    find: '      if (UUID_PATTERN.test(targetTaskId)) {',
    replace: `      if (!(await taskManagerDB.getTask(targetTaskId))) {
        res.status(404).json({ error: 'Refused', code: 'TASK_NOT_FOUND', message: 'no such task' });
        return;
      }
      if (UUID_PATTERN.test(targetTaskId)) {`,
    expects: ['answers an unreadable Task and an absent id identically'],
  },
  {
    id: 'N4-bearer-absence-answers-404-again',
    reintroduces:
      "the card's own entry: on the bearer dispatch an absent target answers TASK_NOT_FOUND "
      + 'while an existing uncontained one answers NO_CONTAINING_WARRANT',
    file: ROUTE,
    find: `            throw new WarrantError(409, 'NO_CONTAINING_WARRANT',
              'no live warrant of this holder contains the target task (§6.3)');`,
    replace: `            res.status(404).json(TASK_ABSENT);
            return;`,
    expects: ['answers an existing uncontained Task and an absent id identically'],
  },
  {
    id: 'N5-the-durable-act-stops-re-deciding',
    reintroduces:
      'round-1 review finding P2: the mint transaction accepts the decision the route reached '
      + 'on another connection, before the Task read and the Brief compile, so an authority '
      + 'change landing in that window is minted straight through. The route-level refusal stays '
      + 'in place, so every sequential assertion in the gate remains green — only the staged '
      + 'window notices',
    file: APPROVALS,
    find: '      if (!authorizedTargets.has(String(input.targetTaskId))) {',
    replace: '      if (!authorizedTargets.has(String(input.targetTaskId)) && authorizedTargets.size < 0) {',
    expects: ['refuses, and creates nothing, when the authority is withdrawn after the route decided'],
  },
];

/**
 * A mutation that must leave the controls GREEN.
 *
 * The repair is defence in depth: the route refuses an unauthorized target
 * before the Brief compiles, and the mint transaction refuses it again on its
 * own connection immediately before anything durable is created. Removing
 * EITHER one alone must therefore change nothing an outside caller can see —
 * that is what "in depth" means, and it is a claim, so it is measured.
 *
 * These entries invert the usual scoring: GREEN is the pass. A RED here would
 * mean the two checks are not actually redundant, and a GREEN on `N1` above
 * would mean neither of them does anything.
 *
 * THE REDUNDANCY IS ASYMMETRIC, and only one direction belongs here. The route
 * check is fully compensated: remove it and the transaction still refuses, so
 * nothing an outside caller can see changes. The reverse is NOT true, and it
 * was measured rather than assumed — removing the transaction check alone
 * reddens exactly one assertion, the staged authority window, because that is
 * the only control reaching the durable act after the route has already
 * decided. That measurement is `N5`, where it belongs, not a second entry here.
 */
const COMPENSATED: Mutation[] = [
  {
    id: 'C1-route-check-alone-removed',
    reintroduces:
      'the route-level target refusal only. The mint transaction must still refuse, so the '
      + 'gate stays green and no Brief, credential or Agent reaches the caller',
    file: ROUTE,
    find: '        if (readable.length === 0) {',
    replace: '        if (readable.length === 0 && readable.length > 0) {',
    expects: [],
  },
];

function report(results: MutationResult[], baseline: ReturnType<typeof classifyJestRun>): void {
  const LF = String.fromCharCode(10);
  const lines: string[] = [];
  lines.push('# Mint-target authorization mutation drill — card 45e7110a');
  lines.push('');
  lines.push(`Baseline (unmutated tree): **${baseline.status}** — ${baseline.reason}`);
  lines.push('');
  lines.push('| mutation | status | expected red | met | reddened |');
  lines.push('|---|---|---|---|---|');
  for (const r of results) {
    const met = r.classification.status === 'RED' && r.unmet.length === 0;
    lines.push(
      `| \`${r.mutation.id}\` | ${r.classification.status} | ${r.mutation.expects.join('; ')} `
      + `| ${met ? 'yes' : 'NO'} | ${r.classification.reds.length} |`,
    );
  }
  lines.push('');
  for (const r of results) {
    lines.push(`## ${r.mutation.id}`);
    lines.push(`Reintroduces: ${r.mutation.reintroduces}`);
    lines.push(`Classification: ${r.classification.status} — ${r.classification.reason}`);
    if (r.unmet.length) lines.push(`UNMET expectations: ${r.unmet.join('; ')}`);
    if (r.classification.reds.length) {
      lines.push('Reddened:');
      for (const red of r.classification.reds) lines.push(`  - ${red}`);
    }
    lines.push('');
  }
  console.log(lines.join(LF));
}

function main(): void {
  console.error('baseline: running the gate on the unmutated tree…');
  const baseline = classifyJestRun(runSuites());
  if (baseline.status !== 'GREEN') {
    console.error(`baseline is ${baseline.status} — ${baseline.reason}`);
    console.error('A drill measured against a tree that is not green measures nothing. Stopping.');
    process.exit(1);
  }

  const results: MutationResult[] = [];
  for (const mutation of MUTATIONS) {
    console.error(`mutating: ${mutation.id}…`);
    const second = (mutation as MutationWithSecond).also;
    // `drillWith` owns the apply/restore of ONE file, and that `finally` is the
    // part that must never be duplicated. A mutation needing a second file
    // wraps the runner instead, so the restore of both still happens there.
    results.push(drillWith(mutation, second ? runnerAlsoMutating(second) : runSuites));
  }
  report(results, baseline);

  const compensated: MutationResult[] = [];
  for (const mutation of COMPENSATED) {
    console.error(`mutating (must stay green): ${mutation.id}…`);
    compensated.push(drillWith(mutation, runSuites));
  }
  reportCompensated(compensated);

  const failures = results.filter((r) => r.classification.status !== 'RED' || r.unmet.length > 0);
  const notCompensated = compensated.filter((r) => r.classification.status !== 'GREEN');
  if (failures.length || notCompensated.length) {
    if (failures.length) console.error(`${failures.length} mutation(s) did not redden what they must.`);
    for (const r of notCompensated) {
      console.error(`${r.mutation.id} was ${r.classification.status}: the two checks are not redundant.`);
    }
    process.exit(1);
  }
  console.error(
    `all ${results.length} mutations reddened their target assertion; `
    + `all ${compensated.length} compensated mutations stayed green.`,
  );
}

main();
