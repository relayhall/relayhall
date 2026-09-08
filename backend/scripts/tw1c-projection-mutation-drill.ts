/**
 * RH-TW1c (card `50e74c1d`) — the RED PROOF for the projection's controls.
 *
 * THIRTEEN mutations, each reintroducing a DIFFERENT defect this card's
 * controls exist to catch, and each required to redden the assertion NAMED FOR
 * IT. A control that stays green under the defect it was written for is
 * decoration, and the only way to know which of the two it is, is to break the
 * product on purpose and watch.
 *
 * WHAT THAT IS AND IS NOT. Each mutation names the assertions it must redden,
 * and the run fails if any of them stays green. It does NOT require that those
 * are the ONLY reds: a real defect usually breaks more than the assertion
 * written for it, and demanding isolation would push this table towards
 * mutations too small to be worth reintroducing. Review `5b4b197c` (MINOR)
 * found the earlier runner discarding those collateral reds entirely, so a
 * mutation declaring one and reddening six printed a receipt indistinguishable
 * from one that reddened exactly its own. They are now printed and counted.
 *
 * M10-M13 are round 2's four findings (`a4a748d5`), one mutation each:
 *
 *   M10  the frame arm back to one hop            -> the chain-head assertions
 *   M11  `account_id` back into the session key   -> the re-parented-Connector row
 *   M12  a read written OUTSIDE `envelopeRead`    -> the one-read structural control
 *   M13  the route stops asking the product grammar -> the malformed-key refusal
 *
 * M8 and M9 were RE-ANCHORED for the repair, and how they had to change is
 * itself the measurement. M8 used to delete `AND e.account_id = g.account_id`
 * from the presence LATERAL; that line no longer exists to delete, because
 * there is now one place a read of `session_events` can be written and it
 * cannot render without the narrowing. The defect is still expressible — hand
 * the helper a root narrowing — so the mutation still exists, but it has to go
 * through the one door, which is the point.
 *
 * It reuses `__tests__/support/mutationDrill.ts` rather than growing a second
 * apply/restore: the `finally` that puts the file back is the part that must
 * never differ between drills, and `drillWith` exists precisely so a drill with
 * its own runner does not have to copy it (the dashboard-authorization drill
 * set that precedent).
 *
 * BOTH GATES RUN. The narrowing is measured twice — as SQL text in the unit
 * suite, and as rows a second Account cannot see in the real-PostgreSQL gate —
 * and several of these mutations are only visible to one of the two. A drill
 * that ran only the fast suite would report GREEN for a mutation that leaks
 * another Account's rows without changing a single statement's text.
 *
 *   cd backend && RELAYHALL_TEST_DB_URL=postgres://... \
 *     npx tsx scripts/tw1c-projection-mutation-drill.ts
 *
 * Without `RELAYHALL_TEST_DB_URL` the real-PostgreSQL gate throws at import
 * and the classifier reports INVALID — a suite that failed to run proves
 * nothing — so the drill refuses rather than quietly measuring half of itself.
 */
import { spawnSync } from 'child_process';
import {
  BACKEND_ROOT,
  classifyJestRun,
  drillWith,
  type JestRun,
  type Mutation,
} from '../src/__tests__/support/mutationDrill';

const SUITES = [
  'src/__tests__/telemetryProjectionContract.test.ts',
  'src/__tests__/telemetryProjectionAuthorization.test.ts',
];

const SCOPE = 'src/services/TelemetryReadScope.ts';
const PROJECTION = 'src/services/TelemetryProjectionService.ts';
const ROUTE = 'src/routes/telemetry.ts';

function runSuites(): JestRun {
  const result = spawnSync(
    'npx',
    ['jest', '--runInBand', '--verbose', '--testPathIgnorePatterns=/node_modules/', '--runTestsByPath', ...SUITES],
    { cwd: BACKEND_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) return { exitCode: null, output: String(result.error.message) };
  return { exitCode: result.status, output: [result.stdout ?? '', result.stderr ?? ''].join('\n') };
}

const MUTATIONS: Mutation[] = [
  {
    id: 'M1-narrowing-withdrawn',
    reintroduces:
      'the Account arm renders TRUE — every caller reads every source, which is the '
      + 'whole defect this card exists to prevent',
    file: SCOPE,
    find: "  return { sql: `${column} = $${paramOffset}`, params: [scope.accountId] };",
    replace: "  return { sql: `${column} = ${column} AND ${paramOffset > 0}`, params: [] };",
    expects: [
      'rendering: root is TRUE with no parameter',
      'CONTAINMENT: neither Account sees a trace of the other',
    ],
  },
  {
    id: 'M2-root-by-role',
    reintroduces:
      'root decided by ROLE rather than by the A12.1 sentinel — the flat estate-wide '
      + 'arm owner ruling 623632b0 removed for disclosure-shaped reads',
    file: SCOPE,
    find: "  if (actor.scopes?.includes('root')) return { kind: 'root' };",
    replace:
      "  if (actor.scopes?.includes('root')) return { kind: 'root' };\n"
      + "  if (String(actor.role || '').toLowerCase() === 'admin') return { kind: 'root' };",
    expects: [
      'an ADMINISTRATOR is narrowed to its own Account',
      'the union has no member that means',
    ],
  },
  {
    id: 'M3-timeline-unnarrowed',
    reintroduces:
      'the point route narrows its HEAD but not its TIMELINE — a session that answers '
      + '404 on its own row still hands back another Account’s events',
    file: PROJECTION,
    find: "    const eventNarrowing = renderTelemetryScopeSql(scope, 'e.account_id', eventParams.length + 1);",
    replace: "    const eventNarrowing = renderTelemetryScopeSql({ kind: 'root' }, 'e.account_id', eventParams.length + 1);",
    expects: ['the point route asks the SAME narrowed question'],
  },
  {
    id: 'M4-phase-outranks-age',
    reintroduces:
      'presence testing the last reported phase BEFORE age — a source that died '
      + 'mid-run stays painted active forever',
    file: PROJECTION,
    find:
      "  if (nowMs - lastSeenAtMs >= staleMs) return 'stale';\n"
      + "  if (phase !== null && IDLE_PHASES.has(phase)) return 'idle';\n"
      + "  return 'active';",
    replace:
      "  if (phase !== null && IDLE_PHASES.has(phase)) return 'idle';\n"
      + "  if (nowMs - lastSeenAtMs >= staleMs) return 'stale';\n"
      + "  return 'active';",
    expects: ['presence: age outranks the last thing a source said'],
  },
  {
    id: 'M5-finished-rots-into-stale',
    reintroduces:
      'age tested before the terminal phase — every completed session is relabelled '
      + 'stale nine minutes later and the distinction the timeline exists to show is lost',
    file: PROJECTION,
    find:
      "  if (phase !== null && TERMINAL_PHASES.has(phase)) return 'finished';\n"
      + '  return derivePresenceState(nowMs, lastSeenAtMs, phase, staleMs);',
    replace:
      "  if (nowMs - lastSeenAtMs >= staleMs) return 'stale';\n"
      + "  if (phase !== null && TERMINAL_PHASES.has(phase)) return 'finished';\n"
      + '  return derivePresenceState(nowMs, lastSeenAtMs, phase, staleMs);',
    expects: ['session: a terminal phase outranks age'],
  },
  {
    id: 'M6-clamp-widens',
    reintroduces:
      'the clamp taking a MAXIMUM instead of a minimum — a query string widens the '
      + 'bound the ceiling exists to impose',
    file: PROJECTION,
    find: '  return Math.min(Math.floor(value), max);',
    replace: '  return Math.max(Math.floor(value), max);',
    expects: [
      'clampBound lowers and never raises',
      'an over-wide request is clamped in the STATEMENT',
    ],
  },
  {
    id: 'M8-lateral-unscoped',
    reintroduces:
      'the presence LATERAL correlated on the Connector and the product but NOT the '
      + 'Account — round-1 blocker 1, where a schema-valid row owned by another '
      + 'Account supplied the phase and the coverage labels of this one',
    file: PROJECTION,
    find:
      "             ${envelopeRead(narrowing, 'e.connector_id = g.connector_id',"
      + " 'e.source_product = g.source_product')}",
    replace:
      "             ${envelopeRead({ sql: 'TRUE', params: [] }, 'e.connector_id = g.connector_id',"
      + " 'e.source_product = g.source_product')}",
    expects: ['EVERY read carries the narrowing as its FIRST conjunct'],
  },
  {
    id: 'M9-point-key-collapsed',
    reintroduces:
      'the point route fetching a timeline by the PSEUDONYM alone — round-1 blocker '
      + '2, where two Connectors sharing one pseudonym had their events merged under '
      + 'one session header',
    file: PROJECTION,
    find:
      '         ${envelopeRead(eventNarrowing,\n'
      + "    'e.session_ref = $1',\n"
      + "    'e.connector_id = $2',\n"
      + "    'e.source_product = $3')}",
    replace:
      '         ${envelopeRead(eventNarrowing,\n'
      + "    'e.session_ref = $1',\n"
      + "    '$2 IS NOT NULL',\n"
      + "    '$3 IS NOT NULL')}",
    expects: [
      'a session is the TRIPLE: one pseudonym, two Connectors, two separate sessions',
      'the point route binds all THREE members of the key',
    ],
  },
  {
    id: 'M7-existence-oracle',
    reintroduces:
      'a not-found that names what was asked for — another Account’s session and an '
      + 'id that names nothing stop answering identically, and the point route becomes '
      + 'an existence oracle',
    file: ROUTE,
    find: "      res.status(404).json({ success: false, code: 'TELEMETRY_SESSION_NOT_FOUND', error: 'No such session' });",
    replace: "      res.status(404).json({ success: false, code: 'TELEMETRY_SESSION_NOT_FOUND', error: `No such session: ${req.path}` });",
    expects: ['INDISTINGUISHABILITY: a foreign session and a nonexistent one'],
  },
  {
    id: 'M10-frame-arm-one-hop',
    reintroduces:
      'the frame ownership test back to the Connector’s IMMEDIATE PARENT — round-2 '
      + 'blocker 1, where a chain deeper than one hop showed a live reporter’s frame '
      + 'to an Account whose attribution the reporter had left',
    file: PROJECTION,
    find:
      "    const frameOwner = renderTelemetryScopeSql(scope, 'connector_head.head_principal_id', scopeParam);",
    replace:
      "    const frameOwner = { sql: 'p.parent_principal_id = latest.account_id', params: [] };",
    expects: [
      'the frame arm follows the CHAIN HEAD, not the Connector parent',
      'the frame arm asks about the Connector CHAIN HEAD, at the ratified depth',
    ],
  },
  {
    id: 'M11-account-back-in-the-session-key',
    reintroduces:
      'the Account back in the sessions GROUP BY — round-2 blocker 2, where a '
      + 're-parented Connector’s ONE advertised triple became two list rows nothing '
      + 'public could tell apart and the totals counted it once',
    file: PROJECTION,
    find:
      '          GROUP BY e.session_ref, e.connector_id, e.source_product\n'
      + '          ORDER BY MAX(e.observed_at) DESC',
    replace:
      '          GROUP BY e.session_ref, e.connector_id, e.account_id, e.source_product\n'
      + '          ORDER BY MAX(e.observed_at) DESC',
    expects: [
      'a RE-PARENTED Connector is ONE row, addressable, and agrees with the totals',
      'the Account is in no GROUP BY of any statement',
    ],
  },
  {
    id: 'M12-read-outside-the-one-door',
    reintroduces:
      'a read of session_events written BY HAND instead of through `envelopeRead` — '
      + 'round-2’s MAJOR, where a control that counted narrowings per statement was '
      + 'satisfied by moving them between reads. The structural control asks a '
      + 'different question: how many places in this module read the table at all',
    file: PROJECTION,
    find:
      '         ${envelopeRead(eventNarrowing,\n'
      + "    'e.session_ref = $1',\n"
      + "    'e.connector_id = $2',\n"
      + "    'e.source_product = $3')}",
    replace:
      '         FROM session_events e\n'
      + '        WHERE ${ENVELOPE}\n'
      + '          AND e.session_ref = $1\n'
      + '          AND e.connector_id = $2\n'
      + '          AND e.source_product = $3',
    expects: ['there is exactly ONE read of session_events in the whole module'],
  },
  {
    id: 'M13-product-grammar-withdrawn',
    reintroduces:
      'the product test WIDENED back to the 256-character ceiling — round-2’s MINOR, '
      + 'where a product key ingest could never have stored reached the service while '
      + 'the route’s own comment claimed otherwise',
    file: ROUTE,
    // Written as a widening rather than a deletion ON PURPOSE. Deleting the
    // call leaves `PRODUCT_RE` imported and unused, `noUnusedLocals` refuses
    // to compile, and the drill reports INVALID — a mutation that does not
    // build measures nothing about the controls.
    find: '  if (!connectorId || !isValidTaskId(connectorId) || !sourceProduct || !PRODUCT_RE.test(sourceProduct)) {',
    replace:
      '  if (!connectorId || !isValidTaskId(connectorId) || !sourceProduct'
      + ' || !(PRODUCT_RE.test(sourceProduct) || sourceProduct.length <= 256)) {',
    expects: ['an INCOMPLETE or MALFORMED key is refused before any row is read'],
  },
];

function main(): number {
  if (!process.env.RELAYHALL_TEST_DB_URL) {
    process.stdout.write(
      'RELAYHALL_TEST_DB_URL is not set. This drill runs BOTH gates, and the '
      + 'real-PostgreSQL one throws at import without it — half a drill measures nothing.\n',
    );
    return 1;
  }

  const wanted = process.argv.slice(2);
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
    const { classification, unmet, unexpected } = drillWith(mutation, runSuites);
    process.stdout.write('=== ' + mutation.id + ' · ' + mutation.reintroduces + '\n');
    process.stdout.write('    ' + classification.status + ' — ' + classification.reason + '\n');
    for (const red of classification.reds) process.stdout.write('    RED  ' + red + '\n');
    // COLLATERAL, REPORTED RATHER THAN DISCARDED. Review `5b4b197c` (MINOR)
    // found this runner throwing `unexpected` away, so a mutation declaring one
    // expected red while reddening six printed the same DRILL OK as one that
    // reddened exactly its own. Extra reds are not a failure — a real defect
    // usually breaks more than the assertion written for it, and demanding
    // isolation would push the drill towards mutations too small to matter —
    // but a receipt that does not name them overstates what was measured.
    for (const red of unexpected) process.stdout.write('    RED  (collateral, not declared)  ' + red + '\n');
    if (classification.status !== 'RED') {
      process.stdout.write('    !!! the control did not measure this mutation\n');
      failures += 1;
    } else if (unmet.length > 0) {
      process.stdout.write('    !!! expected reds never appeared: ' + JSON.stringify(unmet) + '\n');
      failures += 1;
    } else {
      process.stdout.write(
        '    declared=' + mutation.expects.length + ' collateral=' + unexpected.length + '\n');
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
