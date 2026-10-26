// Print the unit-test files vitest itself would run, as one JSON array of
// paths relative to the frontend directory.
//
//   cd frontend && node ../scripts/frontend-vitest-files.mjs \
//       [--exclude <glob> ...] [-- <filter> ...]
//
// WHY THIS EXISTS. The Frontend unit tests are split across parallel CI jobs
// by `scripts/frontend-test-shard.py`. A split is only as honest as the list it
// is cut from, so that list is not a glob the splitter wrote for itself: it is
// vitest's own answer, produced by the same configuration, the same `include`
// and the same exclusions that `npm run test:unit` uses. vitest 1.x has no
// `list` command, so this asks the Node API (`globTestFiles`) the question the
// command line would have asked.
//
// The filters after `--` go through the same substring matching `vitest run
// <filter>` applies, which is what makes it possible to prove that the paths a
// shard hands to vitest select exactly the files that shard was assigned and
// not a neighbour whose path merely contains them (`a.test.ts` is a prefix of
// `a.test.tsx`).
//
// vitest is resolved from the CURRENT directory's node_modules, not from this
// script's location, so the script can live outside `frontend/`.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

process.env.NODE_ENV = 'test';

const args = process.argv.slice(2);
const exclude = [];
const filters = [];
let afterSeparator = false;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (afterSeparator) {
    filters.push(arg);
  } else if (arg === '--') {
    afterSeparator = true;
  } else if (arg === '--exclude') {
    i += 1;
    if (i >= args.length) {
      console.error('--exclude needs a glob');
      process.exit(2);
    }
    exclude.push(args[i]);
  } else {
    console.error(`unknown argument: ${arg}`);
    process.exit(2);
  }
}

const cwd = process.cwd();
const requireFromHere = createRequire(path.join(cwd, 'package.json'));
const { createVitest } = await import(
  pathToFileURL(requireFromHere.resolve('vitest/node')).href
);

const cliOptions = { run: true, watch: false };
if (exclude.length > 0) {
  // `cliExclude`, not `exclude`: the command line's `--exclude` is parsed into
  // `cliExclude`, which vitest 1.x pushes onto the configured exclude list,
  // whereas `exclude` would replace that list (node_modules and the rest).
  cliOptions.cliExclude = exclude;
}
const ctx = await createVitest('test', cliOptions);
let files;
try {
  const found = await ctx.globTestFiles(filters);
  files = found.map((entry) => (Array.isArray(entry) ? entry[1] : entry));
} finally {
  await ctx.close();
}

const relative = files
  .map((file) => path.relative(cwd, file).split(path.sep).join('/'))
  .sort();
// The list goes out on ONE line behind a fixed marker, so a reader can find it whatever else vitest
// writes to stdout while it starts or closes, and the process exits only after that write has
// drained (an exit right after a large write to a pipe can cut it short).
process.stdout.write(`RELAYHALL_VITEST_FILES ${JSON.stringify(relative)}\n`, () => process.exit(0));
