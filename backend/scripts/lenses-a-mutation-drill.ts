/**
 * RH-LENSES-a (card `74e02a05`) — THE RED-PROOF DRILL, obligation `B-L10a`.
 *
 *   > Run annex controls R-1, R-2, R-3, R-4, R-10 and R-12 as permanent drills
 *   > against a real migrated PostgreSQL and a real compiled process. EACH
 *   > CONTROL SHIPS WITH AT LEAST ONE RED MUTATION, written by the build and
 *   > PROVEN AT BUILD TIME to redden that control while every other control in
 *   > the drill stays green. A MUTATION THAT REDDENS NOTHING IS A BUILD
 *   > FAILURE, and mutation independence is a drill step.
 *
 * It reuses `src/__tests__/support/mutationDrill.ts` — the resident harness
 * card AZ.PROJ-a wrote and review `a8e380f1` hardened — rather than growing a
 * second copy of the apply/restore logic. The `finally` that puts a mutated
 * file back is the part that must never differ between drills.
 *
 * Run it:  cd backend && RELAYHALL_TEST_DB_URL=… npx tsx scripts/lenses-a-mutation-drill.ts
 *
 * Every file it touches is restored, including on failure and on Ctrl-C.
 */
import { spawnSync } from 'child_process';
import { Client } from 'pg';

import {
  BACKEND_ROOT,
  classifyJestRun,
  drillWith,
  type JestRun,
} from '../src/__tests__/support/mutationDrill';
import {
  LENSES_A_CONTROLS,
  LENSES_A_DRILL_SUITES,
  LENSES_A_MUTATIONS,
} from '../src/__tests__/support/lensesAMutations';

if (!process.env.RELAYHALL_TEST_DB_URL) {
  console.error(
    'RELAYHALL_TEST_DB_URL is not set. Three of the six controls are properties of ROWS UNDER '
    + 'LOCKS and their suite fails closed without a real PostgreSQL, so a drill run without one '
    + 'would report every mutation as reddening nothing — which is a build failure that says '
    + 'nothing about the mutations. Create a disposable database, load database/init.sql, run '
    + 'npm run migrate, and set the variable.',
  );
  process.exit(2);
}

/**
 * One jest invocation over BOTH planes.
 *
 * `--runInBand` because the reviewer harness dies under jest's default fan-out
 * on a 32-core host, and because the live suite takes advisory locks that two
 * workers would contend for. `--verbose` because the classifier reads
 * per-assertion lines and refuses to call a run RED without them.
 * `--testPathIgnorePatterns=/node_modules/` because the live suite is excluded
 * from the default run by `jest.config.js` and this drill needs it.
 */
/**
 * A CLEAN DATABASE before every run, and this is not tidiness.
 *
 * The suite's oracle is deliberately SCHEMA-WIDE: it compares every
 * `group_members(source='directory')` row in the database against the image
 * of every carriage row under every binding. That is its strength -- a row
 * the suite never created still has to satisfy it -- and it is exactly why a
 * drill cannot reuse a database a previous mutation damaged: the rows one
 * mutation left behind make the NEXT mutation look like it reddened controls
 * it never touched, and the independence claim becomes unmeasurable.
 *
 * The first version of this drill did reuse one, and its receipt showed a
 * mutation to the CATALOG READ reddening the claim producer, the opacity
 * draw and every barrier schedule. None of that was coupling; all of it was
 * residue.
 */
async function resetCarriageState(): Promise<void> {
  const url = new URL(String(process.env.RELAYHALL_TEST_DB_URL));
  const client = new Client({
    host: url.hostname,
    port: Number(url.port || 5432),
    database: url.pathname.replace(/^\//, ''),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  });
  await client.connect();
  try {
    await client.query(
      'TRUNCATE account_directory_group_references, directory_group_references, '
      + 'group_members, groups, directory_sync_state CASCADE',
    );
  } finally {
    await client.end();
  }
}

function runSuites(): JestRun {
  const result = spawnSync(
    'npx',
    [
      'jest', '--runInBand', '--verbose',
      '--testPathIgnorePatterns=/node_modules/',
      '--runTestsByPath', ...LENSES_A_DRILL_SUITES,
    ],
    { cwd: BACKEND_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) return { exitCode: null, output: String(result.error.message) };
  // Both streams, in order: jest puts its per-assertion lines on stdout and its
  // run summary on stderr, and the classifier needs to see both.
  const streams = [result.stdout ?? '', result.stderr ?? ''];
  return { exitCode: result.status, output: streams.join('\n') };
}

async function main(): Promise<void> {
  console.log('RH-LENSES-a red-proof drill (B-L10a)\n');

  // ── Every control must be CLAIMED ────────────────────────────────────────
  //
  // Without this a control ships with no red proof simply by being left out of
  // the table, which is the quietest way for this obligation to fail.
  const claimed = new Set(LENSES_A_MUTATIONS.map((mutation) => mutation.control));
  const unclaimed = LENSES_A_CONTROLS.filter((control) => !claimed.has(control));
  if (unclaimed.length > 0) {
    console.error(`FAIL: no mutation claims ${unclaimed.join(', ')} — every control ships a red proof.`);
    process.exit(1);
  }

  // ── The BASELINE must be green ───────────────────────────────────────────
  //
  // A red measured against a red baseline is not a red proof; it is noise. The
  // drill refuses to interpret a single mutation until the unmutated tree
  // passes.
  process.stdout.write('baseline (no mutation): ');
  await resetCarriageState();
  const baseline = classifyJestRun(runSuites());
  console.log(`${baseline.status} — ${baseline.reason}`);
  if (baseline.status !== 'GREEN') {
    console.error('FAIL: the baseline is not green, so no mutation below can prove anything.');
    process.exit(1);
  }

  let failed = 0;
  for (const mutation of LENSES_A_MUTATIONS) {
    await resetCarriageState();
    const outcome = drillWith(mutation, runSuites);
    const { classification, unmet, unexpected } = outcome;
    console.log(`\n${mutation.id} [${mutation.control}] ${classification.status} — ${classification.reason}`);
    console.log(`   reintroduces: ${mutation.reintroduces}`);
    for (const red of classification.reds) console.log(`   RED  ${red}`);

    if (classification.status !== 'RED') {
      console.error(`   FAIL: ${mutation.id} reddened nothing, or the run could not be classified.`);
      failed += 1;
      continue;
    }
    if (unmet.length > 0) {
      console.error(`   FAIL: expected reds no assertion satisfied: ${unmet.join(' | ')}`);
      failed += 1;
    }
    if (unexpected.length > 0) {
      // COLLATERAL. A mutation that reddens five assertions and names one is
      // how a control looks measured when it is not, and it is also how one
      // over-sensitive assertion stands in for an independently broken
      // control — the thing a drill exists to rule out.
      console.error(`   FAIL: reds no expectation named: ${unexpected.join(' | ')}`);
      failed += 1;
    }
  }

  console.log('');
  if (failed > 0) {
    console.error(`DRILL FAILED: ${failed} problem(s) above.`);
    process.exit(1);
  }
  console.log(`DRILL OK — ${LENSES_A_MUTATIONS.length} mutations, each reddening exactly what the table says.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
