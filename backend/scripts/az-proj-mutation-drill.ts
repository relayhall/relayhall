/**
 * RH-AZ.PROJ-a — run the mutation drill.
 *
 *   cd backend && npx tsx scripts/az-proj-mutation-drill.ts
 *   cd backend && npx tsx scripts/az-proj-mutation-drill.ts M4 M7   # a subset
 *
 * It EDITS files under `backend/src` one at a time and restores each one
 * immediately, including on failure. It is therefore a developer tool, never a
 * CI step: never point it at a tree with uncommitted work you care about, and
 * never run two copies against the same worktree.
 *
 * Exit code 0 only when every mutation reddened EXACTLY what the drill table
 * says it should — every expectation met AND no red left unnamed — and the
 * unmutated tree is green. Anything else exits 1 and says which: a mutation
 * that reddened nothing, one that reddened the wrong assertion, one that
 * reddened MORE than it declared (round-1 review F2: collateral reds are how a
 * control that was never independently broken looks measured), or a run the
 * classifier could not honestly score.
 */
import { MUTATIONS, classifyJestRun, drillOne, runSuites } from '../src/__tests__/support/mutationDrill';

function main(): number {
  const wanted = process.argv.slice(2).filter((argument) => !argument.startsWith('-'));
  const selected = wanted.length > 0
    ? MUTATIONS.filter((mutation) => wanted.includes(mutation.id))
    : MUTATIONS;

  if (selected.length === 0) {
    process.stdout.write('no mutation matched ' + JSON.stringify(wanted) + '\n');
    return 1;
  }

  process.stdout.write('=== baseline: the unmutated tree must be GREEN\n');
  const baseline = classifyJestRun(runSuites());
  process.stdout.write('    ' + baseline.status + ' — ' + baseline.reason + '\n\n');

  let failures = baseline.status === 'GREEN' ? 0 : 1;

  for (const mutation of selected) {
    const result = drillOne(mutation);
    const { classification, unmet, unexpected } = result;
    process.stdout.write('=== ' + mutation.id + ' · ' + mutation.reintroduces + '\n');
    process.stdout.write('    ' + classification.status + ' — ' + classification.reason + '\n');
    for (const red of classification.reds) {
      process.stdout.write('    RED  ' + red + '\n');
    }
    if (classification.status !== 'RED') {
      process.stdout.write('    !!! the control did not measure this mutation\n');
      failures += 1;
    } else if (unmet.length > 0) {
      process.stdout.write('    !!! expected reds never appeared: ' + JSON.stringify(unmet) + '\n');
      failures += 1;
    } else if (unexpected.length > 0) {
      // Round-1 review F2: a red nobody named is a coupling nobody declared,
      // and it is exactly how one over-sensitive assertion stands in for a
      // control that was never independently broken. Declare it in `expects`
      // or decouple the assertion; do not let the receipt round it off.
      process.stdout.write('    !!! COLLATERAL reds no expectation named: '
        + JSON.stringify(unexpected) + '\n');
      failures += 1;
    }
    process.stdout.write('\n');
  }

  process.stdout.write(
    failures === 0
      ? 'DRILL OK — ' + selected.length + ' mutations, each reddening what it claims\n'
      : 'DRILL FAILED — ' + failures + ' problem(s) above\n',
  );
  return failures === 0 ? 0 : 1;
}

process.exitCode = main();
