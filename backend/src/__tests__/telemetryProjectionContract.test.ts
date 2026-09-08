/**
 * RH-TW1c (card `50e74c1d`) — THE PROJECTION IS NARROWED, BOUNDED, AND SPEAKS
 * ONLY THE SHIPPED VOCABULARY.
 *
 * This suite measures the parts that are decidable without a database: the
 * narrowing a caller gets, the SQL every projection method issues, the bounds
 * it cannot be argued out of, and the two pure state derivations. The parts
 * that are NOT decidable here — whether the narrowing actually withholds
 * another Account's rows, and whether a replayed batch moves the numbers —
 * are measured against a real PostgreSQL through the production router in
 * `telemetryProjectionAuthorization.test.ts`, which fails rather than skips
 * without one. Neither suite can stand in for the other and both are gates.
 *
 * ── THE FOUR CLAIMS ──
 *
 * 1. WHO SEES WHAT. `root` — the A12.1 sentinel, and only the sentinel — reads
 *    every source. Everyone else, ADMINISTRATORS INCLUDED, reads their own
 *    Account subtree. The administrator case has its own assertion because it
 *    is the one a reader is most likely to assume goes the other way: the
 *    work plane does give administrators a blanket arm
 *    (`AuthorizationService.sqlCondition`), and this surface deliberately does
 *    not, following owner ruling `623632b0` option (a) for disclosure-shaped
 *    reads.
 *
 * 2. THE NARROWING REACHES THE SQL. It is not enough that a scope exists: it
 *    has to appear in every statement. So the methods are run against a
 *    recording pool and EVERY statement they issue is inspected — not a
 *    sampled one — for the narrowing conjunct and its bound parameter. If a
 *    fifth query is added later without the narrowing, this goes red because
 *    it examines the statements the run actually produced.
 *
 * 3. THE BOUNDS ARE NARROW-ONLY. A request may ask for less and can never ask
 *    for more, because the ceiling is a module constant `clampBound` takes a
 *    minimum against.
 *
 * 4. THE VOCABULARY IS THE SHIPPED ONE. The chip words are the C7 words, the
 *    staleness window is the SHIPPED constant by IDENTITY rather than by an
 *    equal-looking copy, and the session vocabulary is a subset of the labels
 *    the UI already paints.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { MAX_CHAIN_DEPTH } from '../services/DelegationService';
import {
  TELEMETRY_PROJECTION_DEFAULT_ROWS,
  TELEMETRY_PROJECTION_DEFAULT_WINDOW_DAYS,
  TELEMETRY_PROJECTION_MAX_ROWS,
  TELEMETRY_PROJECTION_MAX_WINDOW_DAYS,
  TELEMETRY_PRESENCE_STATES,
  TELEMETRY_SESSION_STATES,
  TELEMETRY_TIMELINE_MAX_EVENTS,
  TelemetryProjectionService,
  clampBound,
  derivePresenceState,
  deriveSessionState,
} from '../services/TelemetryProjectionService';
import {
  describeTelemetryReadScope,
  renderTelemetryScopeSql,
  telemetryReadScopeFor,
  type TelemetryReadScope,
} from '../services/TelemetryReadScope';
import { TELEMETRY_COARSE_STATUSES, TELEMETRY_STALE_MS } from '../services/TelemetryService';
import { ALL_SCOPES, requiredScopeFor } from '../utils/scopeMap';
import { isTelemetryPseudonym, TELEMETRY_PSEUDONYM_PREFIX } from '../utils/telemetryPepper';
import type { AuthorizationActor } from '../services/AuthorizationService';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CONNECTOR = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';

function link(principalId: string, kind: string, extra: Record<string, unknown> = {}): any {
  return {
    principalId, kind, role: null, parentPrincipalId: null, boundTaskId: null,
    legacyIdentity: false, ownExpression: null, ...extra,
  };
}

function actor(over: Partial<AuthorizationActor> = {}): AuthorizationActor {
  return {
    principalId: ACCOUNT, handle: 'someone', role: 'user', scopes: ['services:read'],
    authenticated: true, delegation: null, ...over,
  } as AuthorizationActor;
}

// ─────────────────────── a pool that only records ───────────────────────────

interface Statement { text: string; params: unknown[] }

function recordingPool(rowsFor: (text: string) => Record<string, unknown>[] = () => []) {
  const statements: Statement[] = [];
  const pool = {
    async query(text: string, params: unknown[] = []) {
      statements.push({ text, params });
      return { rows: rowsFor(text) };
    },
  };
  return { statements, service: new TelemetryProjectionService(pool as never) };
}

const PRODUCT = 'claude-code';

/**
 * The ONE marker every read of `session_events` carries, because
 * `envelopeRead` is the only place the clause is written. Splitting a rendered
 * statement on it turns "every read" from a count into a list of reads that
 * can each be asked its own question.
 */
const READ_MARKER = 'FROM session_events e';

function readsOf(sql: string): string[] {
  return sql.split(READ_MARKER).slice(1);
}

/** The point route's key is a TRIPLE; a partial one does not type-check. */
function key(sessionRef: string) {
  return { sessionRef, connectorId: CONNECTOR, sourceProduct: PRODUCT };
}

const ROOT: TelemetryReadScope = { kind: 'root' };
const OWN: TelemetryReadScope = { kind: 'account', accountId: ACCOUNT };

// ────────────────────────────── claim 1 ─────────────────────────────────────

describe('who sees what — the scope a caller is given', () => {
  test('the root SENTINEL, and nothing else, reads every source', () => {
    expect(telemetryReadScopeFor(actor({ scopes: ['root'] }))).toEqual({ kind: 'root' });
    // The sentinel is read from `scopes`, exactly where
    // AuthorizationService.sqlCondition reads it. A handle spelled 'root' is
    // not the sentinel.
    expect(telemetryReadScopeFor(actor({ handle: 'root', scopes: ['services:read'] })))
      .toEqual({ kind: 'account', accountId: ACCOUNT });
  });

  test('an ADMINISTRATOR is narrowed to its own Account, not given the estate', () => {
    for (const role of ['admin', 'administrator', 'operator', 'orchestrator', 'owner']) {
      expect(telemetryReadScopeFor(actor({ role, scopes: ['services:read'] })))
        .toEqual({ kind: 'account', accountId: ACCOUNT });
    }
  });

  test('an Account-plane caller is its own Account; a delegated one takes the head of its chain', () => {
    expect(telemetryReadScopeFor(actor())).toEqual({ kind: 'account', accountId: ACCOUNT });
    expect(telemetryReadScopeFor(actor({
      principalId: AGENT,
      delegation: { links: [link(AGENT, 'agent'), link(CONNECTOR, 'service'), link(ACCOUNT, 'human')] },
    }))).toEqual({ kind: 'account', accountId: ACCOUNT });
  });

  test('a legacy identity takes its own id, never a chain head it was never resolved against', () => {
    expect(telemetryReadScopeFor(actor({
      principalId: CONNECTOR,
      delegation: { links: [link(CONNECTOR, 'service', { legacyIdentity: true }), link(ACCOUNT, 'human')] },
    }))).toEqual({ kind: 'account', accountId: CONNECTOR });
  });

  test('REFUSES rather than widens: unauthenticated, or authenticated with no Account', () => {
    expect(telemetryReadScopeFor(actor({ authenticated: false, scopes: ['root'] }))).toBeNull();
    expect(telemetryReadScopeFor(actor({ principalId: null }))).toBeNull();
  });

  test('the union has no member that means "everything I could not narrow"', () => {
    // The widest value is `root`, and only the sentinel produces it. Over a
    // matrix of callers that are NOT the sentinel, no input yields one.
    const nonSentinel: AuthorizationActor[] = [
      actor(),
      actor({ role: 'admin' }),
      actor({ scopes: [] }),
      actor({ scopes: null }),
      actor({ scopes: ['services:read', 'tasks:read', 'audit:read'] }),
      actor({ principalId: AGENT, delegation: { links: [link(AGENT, 'agent'), link(ACCOUNT, 'human')] } }),
    ];
    for (const who of nonSentinel) {
      expect(telemetryReadScopeFor(who)).not.toEqual({ kind: 'root' });
    }
  });

  test('the loggable label never carries an Account id for the root arm', () => {
    expect(describeTelemetryReadScope(ROOT)).toBe('root');
    expect(describeTelemetryReadScope(OWN)).toBe(`account:${ACCOUNT}`);
  });
});

// ────────────────────────────── claim 2 ─────────────────────────────────────

describe('the narrowing reaches the SQL — every statement, not a sample', () => {
  test('rendering: root is TRUE with no parameter; an Account binds exactly one', () => {
    expect(renderTelemetryScopeSql(ROOT, 'e.account_id', 7)).toEqual({ sql: 'TRUE', params: [] });
    expect(renderTelemetryScopeSql(OWN, 'e.account_id', 7))
      .toEqual({ sql: 'e.account_id = $7', params: [ACCOUNT] });
  });

  test('EVERY statement of EVERY surface carries the conjunct and binds the Account', async () => {
    const { statements, service } = recordingPool();
    await service.presence(OWN);
    await service.sessions(OWN);
    await service.session(OWN, key(`${TELEMETRY_PSEUDONYM_PREFIX}${'a'.repeat(27)}`));
    await service.stats(OWN);

    // Non-vacuity: the run must actually have issued statements, or an
    // assertion over an empty list would pass by saying nothing.
    expect(statements.length).toBeGreaterThanOrEqual(4);
    for (const statement of statements) {
      expect(statement.text).toMatch(/e\.account_id = \$\d+/);
      expect(statement.params).toContain(ACCOUNT);
      // And the envelope discriminator, so a projection can never read the
      // migration-055 hermes rows that carry no principal binding at all.
      expect(statement.text).toContain('e.schema_version IS NOT NULL');
    }
  });

  test('there is exactly ONE read of session_events in the whole module, and it narrows', () => {
    // THE CONTROL THAT STOPS THE REGRESS, and the reason it is a fact about
    // the SOURCE rather than a count over rendered SQL.
    //
    // Round 1 asked whether each STATEMENT contained the conjunct somewhere; a
    // narrowed outer group with an unnarrowed LATERAL satisfied it, and review
    // `f4c56960` found exactly that. Round 2's replacement counted reads
    // against narrowings per statement; review `a4a748d5` (MAJOR) broke it by
    // moving both narrowings onto one read — the counts still balanced. Each
    // control was a census of the reads, and each round found a hole in the
    // census rather than in the product. A third census would have been the
    // third of those.
    //
    // So the census is off the assertion path. `FROM session_events` is
    // written ONCE, inside `envelopeRead`, which cannot render without the
    // envelope discriminator and the caller's narrowing. Redistribution has
    // nothing left to redistribute: there is one WHERE clause for the whole
    // module. Comments are stripped first, because this file's own prose names
    // the table and would otherwise make the assertion unwritable.
    const source = readFileSync(
      path.join(__dirname, '..', 'services', 'TelemetryProjectionService.ts'), 'utf8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|--)/.test(line))
      .join('\n');
    const occurrences = code.match(/session_events/g) ?? [];
    expect({ occurrences: occurrences.length, marker: code.includes("'FROM session_events e',") })
      .toEqual({ occurrences: 1, marker: true });
    // Non-vacuity: the stripper must not have eaten the module. If it had, the
    // count above would be 0 and this catches the direction where it is 1
    // because everything else vanished.
    expect(code).toContain('export class TelemetryProjectionService');
  });

  test('EVERY read carries the narrowing as its FIRST conjunct — measured per read', async () => {
    // The rendered half of the same claim, and positional rather than counted.
    // Each statement is split at the ONE read marker; every fragment after the
    // first is one read, and each must OPEN with the discriminator and the
    // narrowing. A predicate duplicated onto a neighbouring read cannot help
    // here, because a read is judged by what its own WHERE clause starts with.
    const { statements, service } = recordingPool();
    await service.presence(OWN);
    await service.sessions(OWN);
    await service.session(OWN, key(`${TELEMETRY_PSEUDONYM_PREFIX}${'f'.repeat(27)}`));
    await service.stats(OWN);
    expect(statements.length).toBeGreaterThanOrEqual(4);
    for (const statement of statements) {
      const reads = readsOf(statement.text);
      // Non-vacuity: a statement that read the table zero times would satisfy
      // a loop over its reads by saying nothing.
      expect({ sql: statement.text.slice(0, 60), reads: reads.length > 0 })
        .toEqual({ sql: statement.text.slice(0, 60), reads: true });
      for (const [index, read] of reads.entries()) {
        expect({
          statement: statement.text.slice(0, 60),
          read: index,
          opens: /^\s*WHERE e\.schema_version IS NOT NULL\s+AND e\.account_id = \$\d+/.test(read),
        }).toEqual({ statement: statement.text.slice(0, 60), read: index, opens: true });
      }
    }
  });

  test('a correlated read carries the WHOLE group key — asked of EACH read, not the statement', async () => {
    // The second half of the round-1 blocker: a LATERAL correlated on the
    // Connector but not the product (or on the pseudonym but not the
    // Connector) reads a neighbouring group's rows even inside one Account.
    //
    // Round 2 (`a4a748d5`, MAJOR) showed the previous form of this asked the
    // WHOLE statement for two occurrences of each member, which all four
    // predicates duplicated into ONE lateral satisfy. It is now asked of each
    // correlated read separately.
    const { statements, service } = recordingPool();
    await service.sessions(OWN);
    const [sessions] = statements;
    const correlated = readsOf(sessions.text).slice(1);
    // The phase pick and the model set. If a lateral were dropped this drops
    // to one and the assertion notices.
    expect(correlated).toHaveLength(2);
    for (const [index, read] of correlated.entries()) {
      const carries = ['e.session_ref = g.session_ref', 'e.connector_id = g.connector_id',
        'e.source_product = g.source_product']
        .filter((member) => read.includes(member));
      expect({ read: index, carries: carries.length }).toEqual({ read: index, carries: 3 });
    }
  });

  test('the Account is in no GROUP BY of any statement — it narrows, it does not key', async () => {
    // Review `a4a748d5`, both BLOCKERs, as one assertion. Putting `account_id`
    // in the grouping key split a re-parented Connector's single advertised
    // identity into rows nothing public could tell apart, and made
    // `stats.totals` disagree with the list it sits above.
    const { statements, service } = recordingPool();
    await service.presence(OWN);
    await service.sessions(OWN);
    await service.session(OWN, key(`${TELEMETRY_PSEUDONYM_PREFIX}${'b'.repeat(27)}`));
    await service.stats(OWN);
    const grouped = statements.flatMap((statement) => statement.text.match(/GROUP BY [^\n]*/g) ?? []);
    // Non-vacuity: there ARE grouping clauses to inspect.
    expect(grouped.length).toBeGreaterThanOrEqual(3);
    for (const clause of grouped) expect(clause).not.toContain('account_id');
  });

  test('the frame arm asks about the Connector CHAIN HEAD, at the ratified depth', async () => {
    // Review `a4a748d5` (BLOCKER): the arm joined on `p.parent_principal_id =
    // g.account_id`, which is the chain head only for a one-hop chain, while
    // write attribution takes the head of the authenticated chain. The arm is
    // now the caller's OWN narrowing rendered against the head of a recursive
    // walk, and the walk's depth is the resolver's constant BY IDENTITY.
    /** The frame arm's ON clause, whatever it is, read out of the statement. */
    const frameArm = (sql: string): string => (sql.match(/\) fr ON ([^\n]*)/) ?? [, ''])[1].trim();

    const own = recordingPool();
    await own.service.presence(OWN);
    const [scoped] = own.statements;
    // EQUALS, not contains: the old one-hop test is gone rather than joined by
    // something better, and this is the assertion that says so.
    expect(frameArm(scoped.text)).toBe('connector_head.head_principal_id = $2');
    expect(scoped.text).toContain(`WHERE c.depth < ${MAX_CHAIN_DEPTH}`);
    expect(scoped.text).not.toContain('= g.account_id');

    // And root's arm is the same rendering of the same scope: TRUE.
    const root = recordingPool();
    await root.service.presence(ROOT);
    expect(frameArm(root.statements[0].text)).toBe('TRUE');
  });

  test('the point route binds all THREE members of the key, in both statements', async () => {
    const ref = `${TELEMETRY_PSEUDONYM_PREFIX}${'g'.repeat(27)}`;
    const head = {
      session_ref: ref, connector_id: CONNECTOR, account_id: ACCOUNT, source_product: PRODUCT,
      started_at: new Date(), last_seen_at: new Date(), event_count: 1, error_count: 0,
      input_tokens: 0, output_tokens: 0, requests: 0, models: [], connector_handle: 'c', last_phase: 'running',
    };
    const { statements, service } = recordingPool((text) => (/WITH grouped/.test(text) ? [head] : []));
    await service.session(OWN, key(ref));
    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      expect(statement.params.slice(0, 3)).toEqual([ref, CONNECTOR, PRODUCT]);
      expect(statement.text).toContain('e.connector_id = $2');
      expect(statement.text).toContain('e.source_product = $3');
    }
  });

  test('the model set is WINDOWED and ORDERED before it is capped', async () => {
    // Unwindowed, a caller that narrowed to one day still received model names
    // from older rows; unordered, a session past the cap returned a
    // planner-dependent subset that could differ between two identical calls.
    const { statements, service } = recordingPool();
    await service.sessions(OWN);
    // The subquery is isolated by its own SELECT and its own closing alias,
    // not by splitting on a phrase that also appears in the outer select list.
    const MODELS_SUBQUERY = /SELECT e\.payload->'model'->>'resolved' AS model([\s\S]*?)\) m/;
    const between = MODELS_SUBQUERY.exec(statements[0].text);
    expect(between).not.toBeNull();
    const models = between![1];
    expect(models).toContain('e.observed_at >= $1');
    expect(models).toMatch(/ORDER BY e\.observed_at DESC, e\.event_id DESC\s+LIMIT \d+/);
  });

  test('the estate-wide totals count the COMPOSITE grain, not the pseudonym', async () => {
    const { statements, service } = recordingPool();
    await service.stats(OWN);
    const totals = statements.find((statement) => /AS sessions/.test(statement.text))!;
    expect(totals.text).toContain('COUNT(DISTINCT (e.connector_id, e.source_product, e.session_ref))');
    expect(totals.text).toContain('COUNT(DISTINCT (e.connector_id, e.source_product))');
    // And the defect it replaces is gone rather than merely joined: a bare
    // pseudonym count would collapse two Connectors' sessions into one.
    expect(totals.text).not.toMatch(/COUNT\(DISTINCT e\.session_ref\)/);
  });

  test('under root the Account id is bound NOWHERE, and the conjunct is the literal TRUE', async () => {
    const { statements, service } = recordingPool();
    await service.presence(ROOT);
    await service.sessions(ROOT);
    await service.stats(ROOT);
    expect(statements.length).toBeGreaterThanOrEqual(3);
    for (const statement of statements) {
      expect(statement.params).not.toContain(ACCOUNT);
      expect(statement.text).not.toMatch(/e\.account_id = \$\d+/);
      expect(statement.text).toContain('AND TRUE');
    }
  });

  test('the point route asks the SAME narrowed question of the head and of the timeline', async () => {
    // A head that narrows and a timeline that does not would leak another
    // Account's events through a session reference that answered 404 on its
    // own row. Both statements are inspected, and both must narrow.
    const ref = `${TELEMETRY_PSEUDONYM_PREFIX}${'b'.repeat(27)}`;
    const { statements, service } = recordingPool((text) => (
      /WITH grouped/.test(text)
        ? [{
          session_ref: ref, connector_id: CONNECTOR, source_product: 'claude-code',
          started_at: new Date(), last_seen_at: new Date(), event_count: 1, error_count: 0,
          input_tokens: 0, output_tokens: 0, requests: 0, models: [], connector_handle: 'c', last_phase: 'running',
        }]
        : []
    ));
    const detail = await service.session(OWN, key(ref));
    expect(detail).not.toBeNull();
    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      expect(statement.text).toMatch(/e\.account_id = \$\d+/);
      expect(statement.params).toEqual(expect.arrayContaining([ref, ACCOUNT]));
    }
  });

  test('a session outside the scope and one that does not exist are the SAME answer: null', async () => {
    const { service } = recordingPool(() => []);
    await expect(service.session(OWN, key(`${TELEMETRY_PSEUDONYM_PREFIX}${'c'.repeat(27)}`))).resolves.toBeNull();
  });
});

// ────────────────────────────── claim 3 ─────────────────────────────────────

describe('the bounds are narrow-only', () => {
  test('clampBound lowers and never raises', () => {
    expect(clampBound(10, 50, 200)).toBe(10);
    expect(clampBound(5000, 50, 200)).toBe(200);
    expect(clampBound(undefined, 50, 200)).toBe(50);
    expect(clampBound('nonsense', 50, 200)).toBe(50);
    expect(clampBound(-1, 50, 200)).toBe(50);
    expect(clampBound(0, 50, 200)).toBe(50);
    expect(clampBound(Number.POSITIVE_INFINITY, 50, 200)).toBe(50);
    expect(clampBound(Number.NaN, 50, 200)).toBe(50);
  });

  test('the defaults sit under their ceilings, so a default is never itself an escape', () => {
    expect(TELEMETRY_PROJECTION_DEFAULT_ROWS).toBeLessThanOrEqual(TELEMETRY_PROJECTION_MAX_ROWS);
    expect(TELEMETRY_PROJECTION_DEFAULT_WINDOW_DAYS).toBeLessThanOrEqual(TELEMETRY_PROJECTION_MAX_WINDOW_DAYS);
  });

  test('an over-wide request is clamped in the STATEMENT, not merely in a variable', async () => {
    const { statements, service } = recordingPool();
    await service.presence(OWN, { limit: 10_000, windowDays: 10_000 });
    const grouped = statements[0];
    expect(grouped.params).toContain(TELEMETRY_PROJECTION_MAX_ROWS);
    const windowStart = grouped.params[0] as Date;
    const days = Math.round((Date.now() - windowStart.getTime()) / 86_400_000);
    expect(days).toBe(TELEMETRY_PROJECTION_MAX_WINDOW_DAYS);
  });

  test('every statement is window-bounded, and every ROW-RETURNING one is row-bounded too', async () => {
    const { statements, service } = recordingPool();
    await service.presence(OWN);
    await service.sessions(OWN);
    await service.stats(OWN);
    expect(statements.length).toBeGreaterThanOrEqual(3);
    for (const statement of statements) {
      // The window applies to all of them, aggregates included.
      expect(statement.text).toContain('e.observed_at >= $1');
      // A LIMIT belongs on a statement that returns ROWS. The totals query
      // returns exactly one aggregate row, and capping it would not bound the
      // scan — it would make the total WRONG, which is a worse failure than an
      // unbounded one. Its bounds are the window and the narrowing, and they
      // are asserted above. Everything that returns a row SET is capped.
      // Classified by what the statement RETURNS, not by a string that
      // happened to appear only in the aggregate. Round-1 review `f4c56960`
      // Q7 caught the previous version excluding any statement containing
      // `COUNT(DISTINCT e.session_ref)` — which silently exempted `presence`,
      // a genuinely row-returning surface, from the LIMIT requirement. The
      // marker is now the row cap's own placeholder, which only a statement
      // that returns a row SET is given.
      const returnsRowSet = /GROUP BY/.test(statement.text) && !/^\s*SELECT COUNT\(\*\)/m.test(statement.text);
      if (returnsRowSet) expect(statement.text).toMatch(/LIMIT/);
    }
    // Non-vacuity: at least one statement WAS classified as row-returning, so
    // the branch above is not silently skipped for every input.
    expect(statements.some((s) => /GROUP BY/.test(s.text) && /LIMIT/.test(s.text))).toBe(true);
  });

  test('the timeline is capped and the cap is reported rather than silently applied', async () => {
    const ref = `${TELEMETRY_PSEUDONYM_PREFIX}${'d'.repeat(27)}`;
    const head = {
      session_ref: ref, connector_id: CONNECTOR, source_product: 'claude-code',
      started_at: new Date(), last_seen_at: new Date(), event_count: 9_999, error_count: 0,
      input_tokens: 0, output_tokens: 0, requests: 0, models: [], connector_handle: 'c', last_phase: 'running',
    };
    // One more row than the limit: the service must trim to the limit AND say
    // it trimmed, because a silently short timeline reads as a complete one.
    const events = Array.from({ length: 4 }, (_, i) => ({
      event_id: String(i), observed_at: new Date(), source_occurred_at: null, event_kind: 'turn',
    }));
    const { service } = recordingPool((text) => (/WITH grouped/.test(text) ? [head] : events));
    const detail = await service.session(OWN, key(ref), { events: 3 });
    expect(detail!.events).toHaveLength(3);
    expect(detail!.truncated).toBe(true);
    expect(TELEMETRY_TIMELINE_MAX_EVENTS).toBeGreaterThan(0);
  });
});

// ────────────────────────────── claim 4 ─────────────────────────────────────

describe('the vocabulary is the shipped one', () => {
  test('the presence words ARE the shipped C7 words plus the derived one', () => {
    // The pushed half is the shipped constant itself, not a copy that happens
    // to read the same.
    for (const pushed of TELEMETRY_COARSE_STATUSES) {
      expect(TELEMETRY_PRESENCE_STATES).toContain(pushed);
    }
    expect([...TELEMETRY_PRESENCE_STATES]).toEqual(['active', 'idle', 'stale']);
    // No chip-vocabulary extension is smuggled in: design §10.1 makes that a
    // declared C7 revision with its own review, and this card declares none.
    expect(TELEMETRY_PRESENCE_STATES).toHaveLength(3);
  });

  test('the session words are a SUBSET of the labels the shipped UI already paints', () => {
    const painted = ['active', 'idle', 'stale', 'orphan', 'finished', 'unknown', 'none'];
    for (const state of TELEMETRY_SESSION_STATES) expect(painted).toContain(state);
    expect([...TELEMETRY_SESSION_STATES]).toEqual(['active', 'idle', 'stale', 'finished']);
  });

  test('presence: age outranks the last thing a source said', () => {
    const now = 1_000_000_000;
    // Fresh.
    expect(derivePresenceState(now, now - 1_000, 'running')).toBe('active');
    expect(derivePresenceState(now, now - 1_000, 'waiting')).toBe('idle');
    expect(derivePresenceState(now, now - 1_000, null)).toBe('active');
    // Silent: every phase collapses to stale, including a `running` one — a
    // source that died mid-run is not active, and that is the whole purpose
    // of a derived window.
    for (const phase of ['running', 'waiting', 'started', null]) {
      expect(derivePresenceState(now, now - TELEMETRY_STALE_MS, phase)).toBe('stale');
    }
    // The boundary is inclusive, exactly as `livenessForTask` computes it.
    expect(derivePresenceState(now, now - TELEMETRY_STALE_MS + 1, 'running')).toBe('active');
  });

  test('the staleness window is the SHIPPED constant, by identity', () => {
    // Not "equals 540000": that would pass against a private copy that had
    // drifted to the same number by luck. The default parameter IS the import.
    const now = 1_000_000_000;
    expect(derivePresenceState(now, now - TELEMETRY_STALE_MS, 'running')).toBe('stale');
    expect(derivePresenceState(now, now - TELEMETRY_STALE_MS + 1, 'running')).not.toBe('stale');
    expect(TELEMETRY_STALE_MS).toBe(9 * 60_000);
  });

  test('session: a terminal phase outranks age, so a finished session never rots into stale', () => {
    const now = 1_000_000_000;
    for (const phase of ['completed', 'failed', 'cancelled']) {
      expect(deriveSessionState(now, now - 1_000, phase)).toBe('finished');
      expect(deriveSessionState(now, now - 10 * TELEMETRY_STALE_MS, phase)).toBe('finished');
    }
    expect(deriveSessionState(now, now - 10 * TELEMETRY_STALE_MS, 'running')).toBe('stale');
    expect(deriveSessionState(now, now - 1_000, 'waiting')).toBe('idle');
    expect(deriveSessionState(now, now - 1_000, 'running')).toBe('active');
  });
});

// ───────────────────── the ceiling, and what did not change ─────────────────

describe('the scope-map ceiling', () => {
  test('the four read routes ride services:read — an EXISTING scope', () => {
    expect(requiredScopeFor('GET', '/telemetry/presence')).toBe('services:read');
    expect(requiredScopeFor('GET', '/telemetry/sessions')).toBe('services:read');
    expect(requiredScopeFor('GET', `/telemetry/sessions/${TELEMETRY_PSEUDONYM_PREFIX}${'e'.repeat(27)}`))
      .toBe('services:read');
    expect(requiredScopeFor('GET', '/telemetry/stats')).toBe('services:read');
    // Spelling-immune, like every other rule in the table.
    expect(requiredScopeFor('GET', '/telemetry/PRESENCE')).toBe('services:read');
    expect(requiredScopeFor('GET', '/telemetry/stats/')).toBe('services:read');
  });

  test('NO telemetry:read was minted, and the ingest family is untouched', () => {
    expect((ALL_SCOPES as string[]).includes('telemetry:read')).toBe(false);
    expect(requiredScopeFor('POST', '/telemetry/frames')).toBe('telemetry:write');
    expect(requiredScopeFor('POST', '/telemetry/events')).toBe('telemetry:write');
  });

  test('everything else in the family still fails closed to root, WRITES to the new paths included', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(requiredScopeFor(method, '/telemetry/presence')).toBe('root');
      expect(requiredScopeFor(method, '/telemetry/sessions')).toBe('root');
      expect(requiredScopeFor(method, '/telemetry/stats')).toBe('root');
    }
    expect(requiredScopeFor('GET', '/telemetry')).toBe('root');
    expect(requiredScopeFor('GET', '/telemetry/frames')).toBe('root');
    // One segment deeper than the point route is not the point route.
    expect(requiredScopeFor('GET', '/telemetry/sessions/abc/events')).toBe('root');
  });
});

describe('the session reference is refused by SHAPE before it reaches a query', () => {
  test('exactly the pseudonym shape, and one predicate decides it', () => {
    expect(isTelemetryPseudonym(`${TELEMETRY_PSEUDONYM_PREFIX}${'A'.repeat(27)}`)).toBe(true);
    expect(isTelemetryPseudonym(`${TELEMETRY_PSEUDONYM_PREFIX}${'A'.repeat(26)}`)).toBe(false);
    expect(isTelemetryPseudonym(`${TELEMETRY_PSEUDONYM_PREFIX}${'A'.repeat(28)}`)).toBe(false);
    expect(isTelemetryPseudonym(`x_${'A'.repeat(27)}`)).toBe(false);
    expect(isTelemetryPseudonym(`${TELEMETRY_PSEUDONYM_PREFIX}${'A'.repeat(26)}/`)).toBe(false);
    expect(isTelemetryPseudonym(`${TELEMETRY_PSEUDONYM_PREFIX}${'A'.repeat(26)}'`)).toBe(false);
    expect(isTelemetryPseudonym(null)).toBe(false);
    expect(isTelemetryPseudonym(12345)).toBe(false);
  });
});
