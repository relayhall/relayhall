/**
 * LANE FIX-A — the dashboard authorization mutation drill (card `72258a60`).
 *
 * A control is only evidence if it can go red. Each mutation below reintroduces
 * ONE half of the reported defect, runs the controls, and records which
 * assertions reddened. The scoring is not re-implemented here: it reuses
 * `classifyJestRun` and `drillWith` from `support/mutationDrill`, so this drill
 * cannot report an assertion while swallowing a suite that never compiled, and
 * cannot call a runner failure a clean green.
 *
 * Every mutation must still COMPILE — a mutation that does not compile proves
 * nothing — which is why the narrowings are neutralised with `TRUE OR …` and a
 * never-taken ternary rather than deleted: a deleted call leaves its import
 * unused, `noUnusedLocals` refuses the file, and the run measures nothing.
 *
 * M12 is the VACUITY control and is deliberately aimed at the same assertion as
 * M1, from the other side. "The caller sees nothing" satisfies a narrowing
 * assertion as readily as a correct narrowing does; M1 opens the summary to the
 * whole estate and M12 closes it to nobody, and the assertion must reject both.
 *
 * Run it:
 *   cd backend
 *   RELAYHALL_TEST_DB_URL=postgres://…/disposable npx tsx scripts/dashboard-authorization-mutation-drill.ts
 *
 * The DATABASE is written to and must be disposable — same contract as the gate
 * it drives (`src/__tests__/listPointParity.test.ts`). Every file it touches is
 * restored, including on failure. Developer tool, not a CI step: never point it
 * at a tree with uncommitted work you care about.
 */
import { spawnSync } from 'child_process';
import { Client } from 'pg';
import {
  BACKEND_ROOT,
  JestRun,
  Mutation,
  MutationResult,
  classifyJestRun,
  drillWith,
} from '../src/__tests__/support/mutationDrill';

const SUMMARY = 'src/services/TaskManagerDB.ts';
const HISTORY = 'src/services/TaskHistoryService.ts';
const ROUTE = 'src/routes/dashboard.ts';
const REPORTS = 'src/services/ReportVisibility.ts';
const STATS = 'src/services/ProjectStatsService.ts';
const PROJECTS = 'src/routes/projects.ts';
const MANAGER = 'src/services/ReportManager.ts';
const GRANTS = 'src/routes/grants.ts';
const WARRANTS = 'src/routes/warrants.ts';
const WARRANT_SERVICE = 'src/services/WarrantService.ts';

/** A narrowing that narrows nothing, still typed. Reassigning the parameter
 * keeps every call site and every type intact, so the mutation COMPILES and
 * the only thing that changed is whether the rule ran. */
/** A single newline, spelled without an escape so this table can be edited
 * safely by tooling that mangles backslashes. */
const LF = String.fromCharCode(10);

const PASSTHROUGH = "\n    visible = (async (rows) => rows) as AuthorizedTaskNarrowing;";

/** The controls this lane ships for card 72258a60. */
const SUITES = [
  'src/__tests__/listPointParity.test.ts',
  'src/__tests__/DashboardSummary.test.ts',
  'src/__tests__/reportsAuthorActor.test.ts',
  'src/__tests__/grantsGranteeIdentity.test.ts',
];

export const MUTATIONS: Mutation[] = [
  {
    id: 'M1',
    reintroduces: 'the reported defect itself — /dashboard/summary counts the whole estate again',
    file: SUMMARY,
    find: '      FROM ${authorization.from}\n      WHERE ${predicate.sql}',
    replace: '      FROM ${authorization.from}\n      WHERE TRUE OR ${predicate.sql}',
    expects: ['counts the population belonging to the caller'],
  },
  {
    id: 'M2',
    reintroduces: 'the activity feed stops narrowing — task ids, TITLES and the acting handle again',
    file: HISTORY,
    find: '      const authorizedTaskIds = `lower(th.task_id::text) IN (',
    replace: '      const authorizedTaskIds = `TRUE OR lower(th.task_id::text) IN (',
    expects: [
      'GET /dashboard/activity discloses exactly the point-allowed set',
      'GET /dashboard/activity discloses no concealed TITLE',
    ],
  },
  {
    id: 'M3',
    reintroduces: '/dashboard/active hands back every in-progress Task, as it did before',
    file: ROUTE,
    find: '    const inProgressTasks = await filterAuthorizedResources(',
    replace: '    const inProgressTasks = queried.length >= 0 ? queried : await filterAuthorizedResources(',
    expects: ['GET /dashboard/active discloses exactly the point-allowed in-progress set'],
  },
  {
    id: 'M4',
    reintroduces: 'reportCount goes back to a total over every Report in the estate',
    file: REPORTS,
    find: '  const visible = await filterVisibleReports(req, rows);\n  return visible.length;',
    replace: '  const visible = await filterVisibleReports(req, rows);\n'
      + '  return visible.length + (rows.length - visible.length);',
    expects: ['reportCount counts the Reports this caller may read'],
  },
  {
    id: 'M5',
    reintroduces: 'the predicate is rendered into the SQL but its PARAMETERS are not bound',
    file: SUMMARY,
    find: '    `, predicate.params);',
    replace: '    `, predicate.params.slice(0, 0));',
    expects: [
      'binds the scoped predicate AND its parameters',
      'counts the population belonging to the caller',
    ],
  },
  {
    id: 'M7',
    reintroduces: 'project statistics count every Task in the Project again (the census arm)',
    file: STATS,
    find: '  async getStatsByName(visible: AuthorizedTaskNarrowing, projectName: string): Promise<ProjectStats> {',
    replace: '  async getStatsByName(visible: AuthorizedTaskNarrowing, projectName: string): Promise<ProjectStats> {'
      + PASSTHROUGH,
    expects: ['GET /projects/{id}/stats counts exactly the point-allowed Tasks of that Project'],
  },
  {
    id: 'M8',
    reintroduces: 'the task distribution names every Project in the estate again',
    file: STATS,
    find: '  async getTaskDistribution(visible: AuthorizedTaskNarrowing): Promise<Array<{ project_name: string; task_count: number }>> {',
    replace: '  async getTaskDistribution(visible: AuthorizedTaskNarrowing): Promise<Array<{ project_name: string; task_count: number }>> {'
      + PASSTHROUGH,
    expects: ['GET /projects/stats/distribution never counts a Project the caller reads nothing in'],
  },
  {
    id: 'M9',
    reintroduces: '/projects/{id}/sessions hands back the id and TITLE of every Task in the Project',
    file: PROJECTS,
    find: '      rows: await filterAuthorizedResources<any>(',
    replace: '      rows: projectTasks.rows.length >= 0 ? projectTasks.rows : await filterAuthorizedResources<any>(',
    expects: ['GET /projects/{id}/sessions discloses exactly the point-allowed set'],
  },
  {
    id: 'M10',
    reintroduces: 'card 91599cd2 - the unverified, caller-supplied label wins the attribution again',
    file: MANAGER,
    // The fallback chain gains the unverified label at its head, so a Report
    // whose caller supplied `author` renders that instead of the identity the
    // server resolved. It compiles, and it is exactly the reported defect.
    find: '        ? (row.author_actor_display_name',
    replace: '        ? (row.author',
    expects: [
      'renders the DISPLAY NAME of the identity author_actor_id names',
      'resolves a UUID-shaped author_actor_id to a NAME, never to the raw id',
    ],
  },
  {
    id: 'M11',
    reintroduces: 'card f03d459e — a grants row stops naming its own grantee',
    file: GRANTS,
    find: "    grantee: grant.granteeType === 'principal' ? await identitySummary(grant.granteeId) : null,",
    replace: '    grantee: null,',
    expects: [
      'names the HIDDEN compatibility grantee the directory listing omits',
      'says the grant is held by a dormant BUILT-IN identity, not merely by a name',
      'resolves EVERY row, not just the first',
    ],
  },
  {
    id: 'M13',
    reintroduces: 'review 302a338f B1 - the POINT read resolves the handle spelling only',
    file: MANAGER,
    // Both read queries carry the uuid arm, so the anchor names the one the
    // point read owns: `WHERE r.id = $1`. Dropping it there is enough - the
    // control asserts BOTH queries carry it, and the UUID-resolution
    // assertion reads through `getById`.
    find: '       LEFT JOIN principals api ON api.id::text = lower(r.author_actor_id)' + LF
      + '       WHERE r.id = $1',
    replace: '       WHERE r.id = $1',
    // ONE expectation, because only one control can see this. The
    // UUID-resolution assertions drive `mapRow` through a mocked pool that
    // returns the resolved columns whatever the SQL said, so they cannot
    // notice a join disappearing; the SQL-shape control is what can. Naming
    // the second one here would be claiming more than the evidence covers.
    expects: ['BOTH read queries join the identity, so the list and the detail agree'],
  },
  {
    id: 'M14',
    reintroduces: 'review 302a338f B3 - a new Report is owned by nobody again',
    file: MANAGER,
    find: '          data.author_principal_id || null,',
    replace: '          null,',
    expects: ['create records author_principal_id'],
  },
  {
    id: 'M15',
    reintroduces: 'review 302a338f B2 - the warrant linkage renders every Task title again',
    file: WARRANTS,
    find: '    const carriedTasks = await filterAuthorizedResources(',
    replace: '    const carriedTasks = carried.rows.length >= 0'
      + LF + '      ? carried.rows.map((row) => ({ id: String(row.id), title: String(row.title), status: String(row.status) }))'
      + LF + '      : await filterAuthorizedResources(',
    expects: ['GET /warrants/{id}/linkage renders no concealed id, title or status'],
  },
  {
    id: 'M16',
    reintroduces: 'review 302a338f B2 - the dependent-task warning renders every Task title again',
    file: WARRANTS,
    find: '    const tasks = await filterAuthorizedResources(',
    replace: '    const tasks = dependents.length >= 0 ? dependents : await filterAuthorizedResources(',
    expects: ['GET /warrants/{id}/dependent-tasks discloses no concealed TITLE'],
  },
  {
    id: 'M17',
    reintroduces: 'review 302a338f B2 - the revoke refusal enumerates titles the caller may not read',
    file: WARRANT_SERVICE,
    find: '        const readable = await visible(dependents, (task) => task.id);',
    replace: '        const readable = dependents.length >= 0 ? dependents : await visible(dependents, (task) => task.id);',
    expects: ['the revoke refusal counts every dependent and names only the readable ones'],
  },
  {
    id: 'M18',
    reintroduces: 'review f0c51a8e B1 - the HANDLE arm wins a collision again, naming the wrong principal',
    file: MANAGER,
    // Both read queries carry the precedence, so the anchor names the point
    // one by its own `WHERE r.id = $1`. ONE expectation, for the same reason
    // M13 has one: the row-level collision test drives `mapRow` through a
    // mocked pool that hands back an already-coalesced row, so it cannot see
    // which alias PostgreSQL would have preferred. The SQL-shape control can,
    // and it checks BOTH queries, so mutating either reddens it.
    find: 'COALESCE(api.display_name, ap.display_name) AS author_actor_display_name,' + LF
      + '              COALESCE(api.handle, ap.handle) AS author_actor_handle' + LF
      + '       FROM reports r' + LF
      + '       LEFT JOIN projects p ON r.project_id = p.id' + LF
      + '       LEFT JOIN principals ap ON ap.handle = r.author_actor_id' + LF
      + '       LEFT JOIN principals api ON api.id::text = lower(r.author_actor_id)' + LF
      + '       WHERE r.id = $1',
    replace: 'COALESCE(ap.display_name, api.display_name) AS author_actor_display_name,' + LF
      + '              COALESCE(ap.handle, api.handle) AS author_actor_handle' + LF
      + '       FROM reports r' + LF
      + '       LEFT JOIN projects p ON r.project_id = p.id' + LF
      + '       LEFT JOIN principals ap ON ap.handle = r.author_actor_id' + LF
      + '       LEFT JOIN principals api ON api.id::text = lower(r.author_actor_id)' + LF
      + '       WHERE r.id = $1',
    expects: ['the SQL prefers api over ap in both read queries'],
  },
  {
    id: 'M12',
    reintroduces: 'THE VACUITY CONTROL — the summary is closed to everyone, including its owner',
    file: SUMMARY,
    find: '      FROM ${authorization.from}\n      WHERE ${predicate.sql}',
    replace: '      FROM ${authorization.from}\n      WHERE FALSE AND ${predicate.sql}',
    expects: ['counts the population belonging to the caller'],
  },
];

/**
 * Rebuild the disposable database from scratch: drop, create, base schema,
 * migrations - the same three steps CI runs before this gate.
 *
 * Not tidiness. The gate's count assertions are DELTAS, which survive
 * leftovers, but the suite WRITES on every run, and a database carrying a dozen
 * runs of fixtures eventually answers a request with a connection-timeout 503
 * that jest reports as a red assertion. A red the drill did not cause is worse
 * than no drill: it would let a mutation that changed nothing be recorded as
 * proof. So every measurement starts from a database this drill just built, and
 * the BASELINE below proves that database green before any mutation is applied.
 */
async function resetDatabase(): Promise<void> {
  const url = new URL(String(process.env.RELAYHALL_TEST_DB_URL));
  const database = url.pathname.replace(/^\//, '');
  const admin = new Client({
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: 'postgres',
  });
  await admin.connect();
  try {
    await admin.query('DROP DATABASE IF EXISTS ' + JSON.stringify(database) + ' WITH (FORCE)');
    await admin.query('CREATE DATABASE ' + JSON.stringify(database));
  } finally {
    await admin.end();
  }
  const env = {
    ...process.env,
    DB_HOST: url.hostname,
    DB_PORT: url.port || '5432',
    DB_NAME: database,
    DB_USER: decodeURIComponent(url.username),
    DB_PASSWORD: decodeURIComponent(url.password),
  };
  const steps: Array<[string, string[]]> = [
    ['node', ['scripts/load-base-schema.js']],
    ['npm', ['run', 'migrate']],
  ];
  for (const [command, args] of steps) {
    const result = spawnSync(command, args, {
      cwd: BACKEND_ROOT, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw new Error(command + ' ' + args.join(' ') + ' failed: ' + String(result.stderr || result.stdout || ''));
    }
  }
}

/**
 * WHY THE FRONTEND REPAIR IS NOT DRILLED HERE.
 *
 * The other half of review f0c51a8e B2 - the Access-manager revoke dialog -
 * is covered by a VITEST suite (`frontend/src/pages/revokeDialogCounts.test.tsx`).
 * `classifyJestRun` reads jest's run summary, and vitest does not emit it, so
 * a mutation run through this drill came back INVALID: "jest printed no run
 * summary". That classification is CORRECT and it is the whole point of that
 * classifier - it refuses to call a run red or green when it cannot see what
 * happened.
 *
 * Two ways out were available and both were declined. Teaching the classifier
 * a second runner's format means editing a control three review rounds
 * hardened, hours before a freeze, for one mutation. Normalising vitest output
 * into jest's shape means synthesising the very lines the classifier exists to
 * read, which is worse.
 *
 * So the frontend red proof is the suite's own two-directional assertion - it
 * asserts that the dialog never reports "nothing" while anything is concealed
 * AND that it still reports it when the total is genuinely zero, so a repair
 * that simply never says "nothing" fails too - together with the mutation run
 * by hand and recorded in the review evidence. A drill entry that cannot be
 * classified is not evidence, and pretending otherwise is the failure this
 * file is built to avoid.
 */

function runSuites(): JestRun {
  const result = spawnSync(
    'npx',
    ['jest', '--runInBand', '--verbose', '--testPathIgnorePatterns=/node_modules/',
      '--runTestsByPath', ...SUITES],
    { cwd: BACKEND_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) return { exitCode: null, output: String(result.error.message) };
  return { exitCode: result.status, output: [result.stdout ?? '', result.stderr ?? ''].join('\n') };
}

async function main(): Promise<void> {
  if (!process.env.RELAYHALL_TEST_DB_URL) {
    console.error(
      'RELAYHALL_TEST_DB_URL is not set. This drill reddens a gate that measures SQL against a '
      + 'REAL PostgreSQL and refuses to run without one - a drill against a mocked pool would '
      + 'only replay the rule under test.',
    );
    process.exit(2);
  }

  console.log('-- BASELINE: the unmutated tree, on a database built for this drill');
  await resetDatabase();
  const baseline = classifyJestRun(runSuites());
  console.log('   ' + baseline.status + ' -- ' + baseline.reason);
  if (baseline.status !== 'GREEN') {
    for (const red of baseline.reds) console.log('   FAILED ' + red);
    console.log(
      'BASELINE IS NOT GREEN -- every mutation below would be measured against a tree that was '
      + 'already red, so nothing this drill printed would be attributable to a mutation.',
    );
    process.exit(1);
  }

  const results: MutationResult[] = [];
  for (const mutation of MUTATIONS) {
    console.log('');
    console.log('-- ' + mutation.id + ': ' + mutation.reintroduces);
    await resetDatabase();
    const result = drillWith(mutation, runSuites);
    results.push(result);
    console.log('   ' + result.classification.status + ' -- ' + result.classification.reason);
    for (const red of result.classification.reds) console.log('   RED ' + red);
    for (const unmet of result.unmet) console.log('   UNMET: ' + unmet);
  }

  const bad = results.filter(
    (result) => result.classification.status !== 'RED' || result.unmet.length > 0,
  );
  console.log('');
  console.log((results.length - bad.length) + '/' + results.length + ' mutations reddened their controls');
  if (bad.length > 0) {
    for (const result of bad) {
      console.log(
        'FAILED ' + result.mutation.id + ': ' + result.classification.status + ' -- '
        + result.classification.reason
        + (result.unmet.length > 0 ? ' -- unmet: ' + result.unmet.join('; ') : ''),
      );
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
