/**
 * LANE FIX-C — the liveness-bookkeeping bound mutation drill (card `8491557e`).
 *
 * A control is only evidence if it can go red. Each mutation below removes ONE
 * of the bounds (or one of the guards that keeps a bound from becoming a bug),
 * runs both controls, and records which assertions reddened. The scoring is not
 * re-implemented here: it reuses `classifyJestRun` and `drillWith` from
 * `support/mutationDrill`, so this drill cannot report an assertion while
 * swallowing a suite that never compiled, and cannot call a runner failure a
 * clean green.
 *
 * Every mutation must still COMPILE — a mutation that does not compile proves
 * nothing — so the bounds are neutralised with comparisons that can never hold
 * (`< 0`, `>= Number.MAX_SAFE_INTEGER`) rather than deleted: a deleted branch
 * leaves its field unread, `noUnusedLocals` refuses the file, and the run
 * measures nothing.
 *
 * WHAT THE MUTATION SCORE DOES AND DOES NOT COVER (round-1 review C3). Each
 * mutation aims at a DIFFERENT assertion, and the table below names which. It
 * does NOT follow that every assertion in the controls is mutation-covered:
 * the mutations target the DECISIONS — the bounds, the guards, the refusals —
 * and the remaining assertions are BASELINE INVARIANTS (counter partitions,
 * default values, one key not suppressing another, a census that is not
 * empty). Those are worth asserting and are not claimed as mutation-verified.
 *
 * That is the point of the table:
 * a drill where every mutation reddens the same assertion has measured one
 * control many times and the rest not at all. M2 is the VACUITY control and is
 * aimed at the assertion the others cannot reach — "the write still happens".
 * Removing the write entirely satisfies every availability assertion in the
 * burst gate perfectly, and silently idles active sessions out; the gate must
 * reject that repair as firmly as it rejects the unbounded one.
 *
 * Run it:
 *   cd backend
 *   RELAYHALL_TEST_DB_URL=postgres://…/disposable npx tsx scripts/presence-write-bound-mutation-drill.ts
 *
 * The DATABASE is written to and must be disposable — same contract as the gate
 * it drives (`src/__tests__/sessionTouchBurst.test.ts`). Every file it touches
 * is restored, including on failure. Developer tool, not a CI step: never point
 * it at a tree with uncommitted work you care about.
 */
import { spawnSync } from 'child_process';
import {
  BACKEND_ROOT,
  JestRun,
  Mutation,
  MutationResult,
  classifyJestRun,
  drillWith,
} from '../src/__tests__/support/mutationDrill';

const WRITER = 'src/db/boundedPresenceWrites.ts';
const SESSIONS = 'src/services/LoginSessionService.ts';
const PASSWORDS = 'src/services/AccountPasswordService.ts';

/** Both controls: the unit suite that measures the decisions, and the gate that
 *  measures the behaviour against a real PostgreSQL. */
const SUITES = [
  'src/__tests__/boundedPresenceWrites.test.ts',
  'src/__tests__/sessionTouchBurst.test.ts',
  // Round-1 review P1/C1: the census is the only control that can see a write
  // in a file nobody thought to look at, so it belongs in the drill that
  // claims the class is closed.
  'src/__tests__/livenessWriteCensus.test.ts',
];

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  console.error(
    'RELAYHALL_TEST_DB_URL is not set. This drill drives a gate that measures pool behaviour against a\n'
    + 'REAL PostgreSQL. Create a disposable database, load database/init.sql, run npm run migrate, and\n'
    + 'set RELAYHALL_TEST_DB_URL to it.',
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

const MUTATIONS: Mutation[] = [
  {
    id: 'M1-unbounded-touch',
    reintroduces:
      'the reported defect itself: an unawaited, unthrottled per-request UPDATE of the same '
      + 'auth_sessions row, which convoys on a tuple lock and spends the pool',
    file: SESSIONS,
    find: `    return presenceWriter.submit(
      \`session:\${sessionId}\`,
      () => pool.query('UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1', [sessionId]),
      sessionTouchThrottleMs(),
    );`,
    replace: `    void sessionTouchThrottleMs();
    void presenceWriter;
    pool
      .query('UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1', [sessionId])
      .catch(() => undefined);
    return true;`,
    expects: ['never exceeds the shipped bound'],
  },
  {
    id: 'M8-unbounded-touch-on-a-busy-database',
    reintroduces:
      'the SAME unbounded write, on a database where that write is not instant. The card '
      + 'observed the convoy holding connections long enough for unrelated requests to time out '
      + 'and answer 503 AUTHORIZATION_UNAVAILABLE. At this suite fixture size an INSTANT write '
      + 'convoys and disperses well inside the 2s acquisition timeout, so M1 reddens every '
      + 'occupancy assertion without ever reaching the refusal. Supplying the missing condition '
      + 'here — rather than growing the burst until it starves — shows the 503 assertion has '
      + 'teeth while keeping the gate a contention test rather than a load test. THE DELAY WAS '
      + 'MEASURED, not guessed: at 0.2s the refusal appeared in 2 runs of 3, which is a flaky '
      + 'control and worth no more than no control at all; at 0.6s it appeared in 4 of 4. A red '
      + 'proof that only sometimes goes red proves only that it sometimes goes red',
    file: SESSIONS,
    find: `    return presenceWriter.submit(
      \`session:\${sessionId}\`,
      () => pool.query('UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1', [sessionId]),
      sessionTouchThrottleMs(),
    );`,
    replace: `    void sessionTouchThrottleMs();
    void presenceWriter;
    pool
      .query('UPDATE auth_sessions SET last_seen_at = (SELECT now() FROM pg_sleep(0.6)) WHERE id = $1', [sessionId])
      .catch(() => undefined);
    return true;`,
    expects: ['answers every request'],
  },
  {
    id: 'M9-a-fourth-write-goes-direct-to-the-pool',
    reintroduces:
      'round-1 review finding P1 exactly as it stood: the successful-password credential bump '
      + 'writes its own unawaited statement on the shared pool instead of going through the '
      + 'bounded writer. Every other control in this drill stays green while it does — which is '
      + 'why the census exists, and this mutation is the proof that the census can see it',
    file: PASSWORDS,
    find: '    principalService.bumpCredentialLastUsed(String(row.id));',
    replace: `    void principalService;
    pool
      .query('UPDATE principal_credentials SET last_used_at = now() WHERE id = $1', [row.id])
      .catch(() => undefined);`,
    expects: ['finds no liveness write in a file the register does not name'],
  },
  {
    id: 'M2-touch-writes-nothing',
    reintroduces:
      'the VACUITY repair: bounding the write by removing it. Every availability assertion '
      + 'passes and every active session silently idles out',
    file: SESSIONS,
    find: `    return presenceWriter.submit(
      \`session:\${sessionId}\`,
      () => pool.query('UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1', [sessionId]),
      sessionTouchThrottleMs(),
    );`,
    replace: `    void sessionTouchThrottleMs();
    void presenceWriter;
    void pool;
    void sessionId;
    return false;`,
    expects: ['still advances last_seen_at'],
  },
  {
    id: 'M3-concurrency-bound-never-binds',
    reintroduces:
      'a writer that coalesces but never bounds concurrency — the state a per-key throttle '
      + 'alone would have left, where distinct keys still convoy onto the pool',
    file: WRITER,
    find: '    if (this.inFlightCount >= this.options.maxInFlight) {',
    replace: '    if (this.inFlightCount >= Number.MAX_SAFE_INTEGER && this.options.maxInFlight > 0) {',
    expects: ['holds at most maxInFlight writes at once'],
  },
  {
    id: 'M4-shed-stamps-the-throttle',
    reintroduces:
      'a shed write recorded as though it had happened — the one way this bound becomes a '
      + 'liveness BUG, holding last_seen_at still for a whole window under load alone',
    file: WRITER,
    find: `      // Shed WITHOUT stamping the throttle: the next request retries.
      this.shedCount += 1;
      return false;`,
    replace: `      this.rememberKey(key, now);
      this.shedCount += 1;
      return false;`,
    expects: ['does NOT stamp the throttle for a shed write'],
  },
  {
    id: 'M5-single-flight-dropped',
    reintroduces:
      'two concurrent writers of ONE row — the smallest instance of the tuple-lock convoy, '
      + 'which a global concurrency bound alone would still admit',
    file: WRITER,
    find: '    if (this.inFlightKeys.has(key)) {',
    replace: '    if (this.inFlightKeys.has(key) && this.inFlightCount < 0) {',
    expects: ['never runs two writes of the same row at once'],
  },
  {
    id: 'M6-touch-window-ignores-the-idle-window',
    reintroduces:
      'a flat 60s coalescing window on a session whose idle timeout an operator has set to '
      + 'one minute — the throttle then outlives the session it is keeping alive',
    file: SESSIONS,
    find: '  return Math.max(1_000, Math.min(PRESENCE_THROTTLE_MS, Math.floor(sessionIdleMs() / 4)));',
    replace: '  void sessionIdleMs();\n  return PRESENCE_THROTTLE_MS;',
    expects: ['tightens when an operator shortens the idle window'],
  },
  {
    id: 'M7-coalescing-dropped',
    reintroduces:
      'a writer with no coalescing at all: every request reaches the database, and the write '
      + 'amplification the card names is back even though the pool is still bounded',
    file: WRITER,
    find: '    if (now - (this.lastStartedAt.get(key) ?? 0) < window) {',
    replace: '    if (now - (this.lastStartedAt.get(key) ?? 0) < window && window < 0) {',
    expects: ['starts ONE write for a hundred submissions'],
  },
];

function report(results: MutationResult[], baseline: ReturnType<typeof classifyJestRun>): void {
  const LF = String.fromCharCode(10);
  const lines: string[] = [];
  lines.push('# Liveness-bookkeeping bound mutation drill — card 8491557e');
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
  console.error('baseline: running both controls on the unmutated tree…');
  const baseline = classifyJestRun(runSuites());
  if (baseline.status !== 'GREEN') {
    console.error(`baseline is ${baseline.status} — ${baseline.reason}`);
    console.error('A drill measured against a tree that is not green measures nothing. Stopping.');
    process.exit(1);
  }

  const results: MutationResult[] = [];
  for (const mutation of MUTATIONS) {
    console.error(`mutating: ${mutation.id}…`);
    results.push(drillWith(mutation, runSuites));
  }
  report(results, baseline);

  const failures = results.filter(
    (r) => r.classification.status !== 'RED' || r.unmet.length > 0,
  );
  if (failures.length) {
    console.error(`${failures.length} mutation(s) did not redden what they must.`);
    process.exit(1);
  }
  console.error(`all ${results.length} mutations reddened their target assertion.`);
}

main();
