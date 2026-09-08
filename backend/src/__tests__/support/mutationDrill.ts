/**
 * RH-AZ.PROJ-a — the mutation drill, resident in the repository.
 *
 * A mutation drill is the red proof for a control: it edits ONE coordinate,
 * runs the controls, and records which assertions went red. Its whole value
 * rests on the classifier being honest about what it just saw, and that is
 * exactly where the previous, session-local version of this drill was found
 * defective (review `a8e380f1` finding 2): it treated a compile-broken suite
 * as "did not run" ONLY when no assertion had failed, so a mutation that broke
 * one file and reddened an unrelated assertion reported the assertion and
 * swallowed the breakage; and a runner failure that emitted neither token was
 * reported as a clean green.
 *
 * The fix is not another heuristic. `classifyJestRun` below refuses to call a
 * run RED unless every one of these holds, and `mutationDrill.test.ts` feeds it
 * the exact outputs that fooled the old one:
 *
 *   - jest emitted a parseable summary and actually ran tests;
 *   - no suite FAILED TO RUN (jest's own marker for a compile/import failure —
 *     a mutation that does not compile proves nothing);
 *   - the exit code agrees with the assertion count;
 *   - the number of red assertion lines equals the number jest reported failed,
 *     so no failure is left unattributed.
 *
 * Anything else is INVALID — never GREEN and never RED. An invalid drill is a
 * drill that has to be rewritten, not a control that passed.
 *
 * Run it:  cd backend && npx tsx scripts/az-proj-mutation-drill.ts
 * Every file it touches is restored, including on failure.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/** `backend/`, from `backend/src/__tests__/support/`. */
export const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');

export interface Mutation {
  /** Short label, printed in the report. */
  id: string;
  /** What defect this mutation reintroduces, and where it came from. */
  reintroduces: string;
  /** Path relative to `backend/`. */
  file: string;
  /** The exact text to replace. MUST occur exactly once. */
  find: string;
  /** What to put in its place. Must still COMPILE — see the header. */
  replace: string;
  /**
   * Substrings of the assertion titles this mutation reddens — the COMPLETE
   * set, not a sample (round-1 review F2).
   *
   * It used to be read one way only: an expectation no red satisfied failed the
   * drill, but a red no expectation named passed silently. So a mutation could
   * redden five assertions, name one, and still print `DRILL OK` — while the
   * runner's own header promised "each mutation reddened exactly what the drill
   * table says". Collateral reds are how one over-sensitive assertion stands in
   * for an independently broken control, which is the whole thing a drill is
   * supposed to rule out. Both directions are now enforced.
   *
   * A mutation that legitimately reddens several assertions lists them all;
   * that list is then a claim about coupling, and a reader can see it.
   */
  expects: string[];
}

export const DRILL_SUITES = [
  'src/__tests__/taskProjectVisibilityInheritance.test.ts',
  'src/__tests__/taskRestrictedAccessContract.test.ts',
  'src/__tests__/taskAccessWriter.test.ts',
  'src/__tests__/sharedAuthorization.test.ts',
  'src/__tests__/phaseRestrictedAccessContract.test.ts',
  // RH-AZ.PROJ-b (card 95572530) — the fourth selector form.
  'src/__tests__/projectBoundedSelectorForm.test.ts',
];

const SERVICE = 'src/services/AuthorizationService.ts';
const REPOSITORY = 'src/services/AuthorizationRepository.ts';
const MIDDLEWARE = 'src/middleware/sharedAuthorization.ts';
const WRITER = 'src/services/TaskAccessService.ts';
// RH-AZ.PROJ-b coordinates.
const PROFILES = 'src/services/AccessProfileService.ts';
const VEHICLE = 'src/services/AccessVehicleService.ts';
const CONTAINMENT = 'src/utils/authorityContainment.ts';

const OWN_ARM_COPY = [
  "        if (action === 'read') {",
  '          if (resource.visibility) {',
  '            accountParts.push(`${resource.visibility}'
    + " IN ('public', 'shared', 'default')`);",
  '          }',
  '        }',
  '',
].join('\n');

const SHARED_ARMS = [
  "        if (action === 'read') {",
  '          accountParts.push(...this.visibilityArms(resource));',
  '        }',
  '',
].join('\n');

export const MUTATIONS: Mutation[] = [
  {
    id: 'M1',
    reintroduces: 'site A loses the inherited-visibility arm entirely',
    file: SERVICE,
    find: '      if (!resource.restrictedAccess && visibleToAuthenticated(resource.inheritedVisibility)) {',
    replace: '      if (false && !resource.restrictedAccess && visibleToAuthenticated(resource.inheritedVisibility)) {',
    expects: ['a private Task in a SHARED project', 'a private Task in a PUBLIC project',
      'a Task under an ordinary Phase', 'leaves the pre-117 Phase behaviour'],
  },
  {
    id: 'M2',
    reintroduces: 'the shared Task shape loses its inheritance anchor, at BOTH SQL planes',
    file: REPOSITORY,
    find: '            inheritanceAnchor: "t.project_id IS NOT NULL AND p.status = \'active\'",\n',
    replace: '',
    // The last entry is a coupling this mutation always had and never
    // declared, surfaced when round-1 review F2 made `expects` the complete
    // set: removing the anchor changes the Task shape, and the own()-cap
    // assertion reads that same shape. Declared rather than silenced.
    expects: ['pins every column the Task predicate reads', 'emits BOTH union arms for a Task',
      'anchors the inherited arm on a LIVE', 'emits BOTH union arms on the Account side',
      'carries the visibility arms IDENTICALLY',
      'keeps the inherited arm CAPPED by the delegated own() expression'],
  },
  {
    id: 'M3',
    reintroduces: 'site C drifts from site B: an own-visibility arm only on the chain Account side',
    file: SERVICE,
    find: SHARED_ARMS,
    replace: OWN_ARM_COPY,
    expects: ['emits BOTH union arms on the Account side', 'carries the visibility arms IDENTICALLY',
      'keeps the inherited arm CAPPED'],
  },
  {
    id: 'M4',
    reintroduces: 'review 66281121 F1, SQL half — an archived Project confers visibility again',
    file: REPOSITORY,
    find: '            inheritanceAnchor: "t.project_id IS NOT NULL AND p.status = \'active\'",',
    replace: "            inheritanceAnchor: 't.project_id IS NOT NULL',",
    expects: ['pins every column the Task predicate reads', 'anchors the inherited arm on a LIVE'],
  },
  {
    id: 'M5',
    reintroduces: 'review 66281121 F1, mapping half — the same defect, at site A',
    file: REPOSITORY,
    find: '      inheritedVisibility: inheritedProjectId',
    replace: '      inheritedVisibility: row.project_id',
    expects: ['an ARCHIVED Project is not a live source', 'UNKNOWN future status',
      'reads Project liveness from the row'],
  },
  {
    id: 'M6',
    reintroduces: 'review 66281121 F2 — the object stage stops folding the route spelling',
    file: MIDDLEWARE,
    find: '  const routeWords = segments.map((segment) => segment.toLowerCase());',
    replace: '  const routeWords = segments.map((segment) => segment);',
    expects: ['classifies every spelling of the same handler identically',
      'closes the same hole on the ratified Phase policy surface',
      'folds every other route word too', 'recognises a COLLECTION word at every spelling'],
  },
  {
    id: 'M7',
    reintroduces: 'review cf04a642 F1 — the collection-word test goes back to the raw segment',
    file: MIDDLEWARE,
    find: '  if (!identifier || NON_OBJECT_SEGMENTS.has(routeWords[identifierIndex])) return null;',
    replace: '  if (!identifier || NON_OBJECT_SEGMENTS.has(identifier)) return null;',
    expects: ['recognises a COLLECTION word at every spelling'],
  },
  {
    id: 'M8',
    reintroduces: 'review cf04a642 F2 — the ACL writer mutates an ARCHIVED Task again',
    file: WRITER,
    // Compares the id instead of the status: always false, and it still
    // COMPILES. Deleting the block instead would leave ARCHIVED_STATUS unused,
    // the file would stop compiling, and the run would prove nothing.
    find: '      if (String(found.rows[0].status) === ARCHIVED_STATUS) {',
    replace: '      if (String(found.rows[0].id) === ARCHIVED_STATUS) {',
    expects: ['refuses an ARCHIVED Task'],
  },
  {
    id: 'M9',
    reintroduces: 'review cf04a642 F3 — the point SELECT loses its Project projection',
    file: REPOSITORY,
    find: '                       t.project_id, t.restricted_access,\n',
    replace: '',
    expects: ['selects every column the Task mapping reads'],
  },
  {
    id: 'M10',
    reintroduces: "review cf04a642 F4 — a Task's OWN visibility is read from the PROJECT column",
    file: REPOSITORY,
    find: "            creator: 't.creator_principal_id', visibility: 't.visibility',",
    replace: "            creator: 't.creator_principal_id', visibility: 'p.visibility',",
    expects: ['pins every column the Task predicate reads'],
  },

  // -- RH-AZ.PROJ-b (card 95572530): the fourth selector form --------------
  //
  // Six mutations, six DIFFERENT assertions. Two of them (M11, M15)
  // reintroduce the exact defect this card was built to avoid: a trailing
  // `else` that means `all-except`, reading a rule pinned to one Project as
  // "everything except these ids". Every one still COMPILES, which is the
  // point -- a mutation that fails to compile proves nothing.
  {
    id: 'M11',
    reintroduces: "the own() AND-cap reads the project-bounded form as `all-except` (the catch-all `else`)",
    file: SERVICE,
    find: '            parts.push(`(${resource.project} IS NOT NULL AND ${resource.project} '
      + '= ANY(${nextParam(rule.selectorIds)}::uuid[]))`);',
    replace: '            parts.push(`NOT (${resource.id} = ANY(${nextParam(rule.selectorIds)}::uuid[]))`);',
    expects: ['emits the bounded arm on a shape that HAS a project coordinate'],
  },
  {
    id: 'M12',
    reintroduces: 'the own() cap emits a project arm for a shape that HAS no project column',
    file: SERVICE,
    find: '          if (resource.project) {',
    replace: '          if (!resource.project) {',
    // Inverting the guard swaps the two cases, so BOTH own()-cap assertions go
    // red — the shape that should emit the arm stops, and the shape that should
    // emit nothing starts. Declared, because a mutation that reddens two
    // assertions and names one is how a control looks measured when it is not.
    expects: ['contributes NOTHING on a shape with no project coordinate',
      'emits the bounded arm on a shape that HAS a project coordinate'],
  },
  {
    id: 'M13',
    reintroduces: 'the seam honours a project-bounded rule on a type with no project perimeter',
    file: PROFILES,
    find: '      + ` AND ${projectColumn} = ANY(apr.selector_ids))`\n'
      + "    : 'FALSE';",
    replace: '      + ` AND ${projectColumn} = ANY(apr.selector_ids))`\n'
      + "    : `(apr.selector_form = 'all-in-project')`;",
    // The cap assertion also reads the rendered seam for the report shape, so
    // it sees this too. Two assertions, two different halves of the same claim,
    // both declared.
    expects: ['a shape with NO project coordinate renders the arm as the literal FALSE',
      'contributes NOTHING on a shape with no project coordinate'],
  },
  {
    id: 'M14',
    reintroduces: 'the admissibility table admits the form for a type that carries no project',
    file: PROFILES,
    find: "  report: { forms: ['exact', 'all-of-type', 'all-except'], "
      + "because: 'a Report carries no project coordinate' },",
    replace: "  report: { forms: ['exact', 'all-of-type', 'all-except', 'all-in-project'], "
      + "because: 'a Report carries no project coordinate' },",
    // The SQL assertion is NOT here any more, and that is the point of the
    // round-1 F2 repair: it used to derive its expected type list from this
    // very table, so mutating the SERVICE reddened the SQL control and the
    // receipt could not show the two halves failing apart. M18 now reddens the
    // SQL assertion, and only that one, by editing only SQL.
    expects: ['admits the project-bounded form for task and phase ALONE',
      'validateRules REFUSES the project-bounded form on every type with no project coordinate',
      'holds for every grantable resource type'],
  },
  {
    id: 'M15',
    reintroduces: 'the assignment coupling reads the project-bounded form as `all-except`',
    file: VEHICLE,
    find: '    return false;\n  });\n}',
    replace: '    return !rule.selectorIds.includes(taskId);\n  });\n}',
    expects: ['reads a project-bounded own() rule as UNPROVEN'],
  },
  {
    id: 'M16',
    reintroduces: 'the containment algebra lets a project-bounded source cover a request it cannot prove',
    file: CONTAINMENT,
    find: "      return rule.selectorForm === 'all-in-project'\n"
      + '        && rule.selectorIds.every((id) => source.selectorIds.includes(id));',
    replace: '      return rule.selectorIds.every((id) => source.selectorIds.includes(id));',
    expects: ['a project-bounded source does NOT cover a wider perimeter'],
  },
  {
    id: 'M17',
    reintroduces: 'round-1 review F1 — containment admits an UNKNOWN requested form under full width',
    file: CONTAINMENT,
    // NOT a deletion: removing the line leaves `SELECTOR_FORMS` unused and the
    // file stops compiling, and a mutation that does not compile proves
    // nothing. This leaves the guard in place and makes it test something that
    // is always true — the shape a guard actually rots into, and the shape a
    // reader skims past.
    find: '  if (!(SELECTOR_FORMS as readonly string[]).includes(rule.selectorForm)) return false;',
    replace: "  if (!(SELECTOR_FORMS as readonly string[]).includes('exact')) return false;",
    expects: ['an unrecognised REQUEST form is covered by nothing'],
  },
  {
    id: 'M18',
    reintroduces: 'the SQL half alone admits the form for a type with no project coordinate',
    // The migration, not the service. Round-1 review F2 was that no mutation
    // could redden the SQL assertion WITHOUT also mutating the table it read
    // its expectation from; this one edits only SQL, and only the SQL
    // assertion goes red.
    file: 'src/migrations/125_project_bounded_selector_form.sql',
    find: "  CHECK (selector_form <> 'all-in-project' OR resource_type IN ('task', 'phase'));",
    replace: "  CHECK (selector_form <> 'all-in-project' OR resource_type IN ('task', 'phase', 'report'));",
    expects: ['refuses the form in SQL for every type with no project coordinate'],
  },
];

export type DrillStatus = 'GREEN' | 'RED' | 'INVALID';

export interface JestRun {
  exitCode: number | null;
  output: string;
}

export interface Classification {
  status: DrillStatus;
  /** The assertion titles that went red. Empty unless status is RED. */
  reds: string[];
  /** Why the run was classified this way. Always populated. */
  reason: string;
}

/** Built from the escape character itself, so the pattern cannot match
 *  ordinary text that merely looks like a colour code. */
const ANSI = new RegExp(String.fromCharCode(27) + '\[[0-9;]*m', 'g');
/** Only jest's own failure glyphs. A bare `x` would match ordinary prose. */
const RED_LINE = /^\s*[✕×]\s+(.+?)(?:\s+\(\d+\s*m?s\))?\s*$/;
const SUITE_FAILED_TO_RUN = /●\s+Test suite failed to run/;
const TESTS_SUMMARY = /^Tests:\s+(.*)$/m;
const SUITES_SUMMARY = /^Test Suites:\s+(.*)$/m;

function countIn(summary: string, word: string): number {
  const match = new RegExp('(\\d+)\\s+' + word).exec(summary);
  return match ? Number(match[1]) : 0;
}

/**
 * Decide what a jest run MEANS. It never guesses: every path returns a reason,
 * and anything the four invariants in the header do not cover is INVALID.
 */
export function classifyJestRun(run: JestRun): Classification {
  const { exitCode } = run;
  const output = run.output.replace(ANSI, '');
  const reds: string[] = [];
  for (const line of output.split('\n')) {
    const match = RED_LINE.exec(line);
    if (match) reds.push(match[1].trim());
  }

  if (SUITE_FAILED_TO_RUN.test(output)) {
    return {
      status: 'INVALID',
      reds: [],
      reason: 'a suite FAILED TO RUN — the mutation broke compilation or an import, '
        + 'so nothing about the controls was measured',
    };
  }

  const testsSummary = TESTS_SUMMARY.exec(output);
  const suitesSummary = SUITES_SUMMARY.exec(output);
  if (!testsSummary || !suitesSummary) {
    return {
      status: 'INVALID',
      reds: [],
      reason: 'jest printed no run summary (exit ' + String(exitCode) + ') — the runner itself failed',
    };
  }

  const total = countIn(testsSummary[1], 'total');
  const failed = countIn(testsSummary[1], 'failed');
  const failedSuites = countIn(suitesSummary[1], 'failed');

  if (total === 0) {
    return { status: 'INVALID', reds: [], reason: 'jest ran ZERO tests — nothing was measured' };
  }
  if (exitCode === 0 && (failed > 0 || reds.length > 0)) {
    return {
      status: 'INVALID',
      reds: [],
      reason: 'exit 0 contradicts ' + failed + ' failed test(s) and ' + reds.length + ' red line(s)',
    };
  }
  if (exitCode === 0) {
    return { status: 'GREEN', reds: [], reason: total + ' tests, all passing' };
  }
  if (failed === 0) {
    return {
      status: 'INVALID',
      reds: [],
      reason: 'jest exited ' + String(exitCode) + ' with ' + failedSuites + ' failed suite(s) but '
        + 'ZERO failed tests — the failure is infrastructural, not an assertion',
    };
  }
  if (reds.length !== failed) {
    return {
      status: 'INVALID',
      reds: [],
      reason: 'jest reported ' + failed + ' failed test(s) but ' + reds.length + ' red assertion '
        + 'line(s) were parsed — a failure would go unattributed. Run with --verbose.',
    };
  }
  return { status: 'RED', reds, reason: failed + ' of ' + total + ' assertions reddened' };
}

/**
 * Run the control suites and hand back BOTH streams and the exit status.
 *
 * `spawnSync`, not `execFileSync`: jest writes its run summary to STDERR,
 * and execFileSync returns only stdout on success — so a GREEN run arrived
 * at the classifier with no summary in it at all. The classifier caught that
 * (INVALID, "no run summary") instead of reporting a false green, which is
 * the whole point of it; the fix is one code path for both outcomes rather
 * than a try/catch that assembled the streams differently on each.
 */
export function runSuites(): JestRun {
  const result = spawnSync('npx', ['jest', '--runInBand', '--verbose', ...DRILL_SUITES], {
    cwd: BACKEND_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    return { exitCode: null, output: String(result.error.message) };
  }
  // Both streams, in order: jest puts its per-assertion lines on stdout and
  // its run summary on stderr, and the classifier needs to see both.
  const streams = [result.stdout ?? '', result.stderr ?? ''];
  return { exitCode: result.status, output: streams.join(String.fromCharCode(10)) };
}

export interface MutationResult {
  mutation: Mutation;
  classification: Classification;
  /** Expectations from the table that no red line satisfied. */
  unmet: string[];
  /** Red assertions no expectation named — collateral (round-1 review F2). */
  unexpected: string[];
}

/** Apply one mutation, run the DEFAULT suites, and ALWAYS put the file back. */
export function drillOne(mutation: Mutation): MutationResult {
  return drillWith(mutation, runSuites);
}

/**
 * The same drill against a runner the caller supplies.
 *
 * The dashboard-authorization drill (card 72258a60) reddens a gate that needs
 * a real PostgreSQL and its own jest invocation, and a second copy of the
 * apply/restore logic is exactly the kind of duplicate a control should not
 * grow: the `finally` that puts the file back is the part that must never
 * differ between drills.
 */
export function drillWith(mutation: Mutation, run: () => JestRun): MutationResult {
  const target = path.join(BACKEND_ROOT, mutation.file);
  const original = fs.readFileSync(target, 'utf8');
  const occurrences = original.split(mutation.find).length - 1;
  if (occurrences !== 1) {
    return {
      mutation,
      classification: {
        status: 'INVALID',
        reds: [],
        reason: "the mutation's anchor occurs " + occurrences + ' times in ' + mutation.file
          + ' — the drill table has drifted from the tree and measures nothing',
      },
      unmet: mutation.expects,
      unexpected: [],
    };
  }
  try {
    fs.writeFileSync(target, original.replace(mutation.find, mutation.replace));
    const classification = classifyJestRun(run());
    const unmet = mutation.expects.filter(
      (expected) => !classification.reds.some((red) => red.includes(expected)),
    );
    const unexpected = classification.reds.filter(
      (red) => !mutation.expects.some((expected) => red.includes(expected)),
    );
    return { mutation, classification, unmet, unexpected };
  } finally {
    fs.writeFileSync(target, original);
  }
}
