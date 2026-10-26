/**
 * Card e220be94 (owner ruling E353): the definitions of the bridge's board
 * metrics, measured without a database. The live suite
 * (boardMetricsLive.test.ts, npm run test:board-metrics) proves the SQL over
 * real rows through the production router; scripts/board-metrics-mutations.py
 * names the tests here that each control must turn red.
 */
import {
  accountWideReach, BoardMetricsService, BOARD_METRICS_FRESHNESS_SECONDS, BOARD_METRICS_SCHEMA,
  shapeBoardMetrics, THROUGHPUT_WINDOW_SECONDS,
} from '../services/BoardMetricsService';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CONNECTOR = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const link = (principalId: string, parent: string | null, extra: Record<string, unknown> = {}) => ({
  principalId, kind: parent ? 'service' : 'human', role: null, parentPrincipalId: parent, boundTaskId: null,
  legacyIdentity: false, ownExpression: parent ? { scopes: 'parent', objects: 'parent' } : null, ...extra,
}) as any;

describe('board metrics shape (card e220be94)', () => {
  const now = Date.parse('2026-10-19T03:00:00.000Z');

  test('reported values: queue in jobs, throughput as jobs/minute over the rolling hour with its integer count', () => {
    const shaped = shapeBoardMetrics({ count: 4, observedAtMs: now }, { count: 30, observedAtMs: now }, now);
    expect(shaped.schemaVersion).toBe(BOARD_METRICS_SCHEMA);
    expect(shaped.queue).toMatchObject({ status: 'reported', value: 4, unit: 'jobs' });
    expect(THROUGHPUT_WINDOW_SECONDS).toBe(3600);
    expect(shaped.throughput).toMatchObject({ status: 'reported', value: 0.5, unit: 'jobs/minute', windowSeconds: 3600, count: 30 });
    expect(shaped.source).toEqual({ kind: 'core', producer: 'board' });
  });

  test('an unknown measurement is unknown with a null value and a reason, never 0', () => {
    const shaped = shapeBoardMetrics({ unknown: 'unavailable' }, { unknown: 'caller-reach' }, now);
    expect(shaped.queue).toEqual({ status: 'unknown', value: null, unit: 'jobs', reason: 'unavailable', source: shaped.source });
    expect(shaped.throughput).toMatchObject({ status: 'unknown', value: null, unit: 'jobs/minute', reason: 'caller-reach' });
    expect(shaped.throughput).not.toHaveProperty('count');
    expect(shaped.observedAt).toBeNull();
    expect(shaped.stale).toBe(true);
  });

  test('freshness: every reported metric carries observedAt, and is stale past 90 seconds', () => {
    expect(BOARD_METRICS_FRESHNESS_SECONDS).toBe(90);
    const fresh = shapeBoardMetrics({ count: 1, observedAtMs: now - 90_000 }, { count: 0, observedAtMs: now - 1000 }, now);
    expect(fresh.queue).toMatchObject({ observedAt: new Date(now - 90_000).toISOString(), stale: false });
    expect(fresh.throughput).toMatchObject({ observedAt: new Date(now - 1000).toISOString(), stale: false });
    expect(fresh.observedAt).toBe(new Date(now - 90_000).toISOString());
    expect(fresh.freshnessSeconds).toBe(90);
    expect(fresh.stale).toBe(false);
    const old = shapeBoardMetrics({ count: 1, observedAtMs: now - 90_001 }, { unknown: 'unavailable' }, now);
    expect(old.queue).toMatchObject({ observedAt: new Date(now - 90_001).toISOString(), stale: true });
    expect(old.stale).toBe(true);
  });

  test('a measured zero is a reported 0, distinct from unknown', () => {
    const shaped = shapeBoardMetrics({ count: 0, observedAtMs: now }, { count: 0, observedAtMs: now }, now);
    expect(shaped.queue).toMatchObject({ status: 'reported', value: 0 });
    expect(shaped.throughput).toMatchObject({ status: 'reported', value: 0, count: 0 });
  });
});

describe('board metrics caller reach (card e220be94)', () => {
  test('the Account itself, and a chain that inherits its parent objects, reach the Account', () => {
    expect(accountWideReach(ACCOUNT, ACCOUNT, null)).toBe(true);
    expect(accountWideReach(ACCOUNT, ACCOUNT, [link(ACCOUNT, null)])).toBe(true);
    expect(accountWideReach(ACCOUNT, CONNECTOR, [link(CONNECTOR, ACCOUNT), link(ACCOUNT, null)])).toBe(true);
  });

  test('an explicit object selector, a bound Agent, a missing expression or another Account do not', () => {
    expect(accountWideReach(ACCOUNT, CONNECTOR, null)).toBe(false);
    expect(accountWideReach(ACCOUNT, CONNECTOR, [
      link(CONNECTOR, ACCOUNT, { ownExpression: { scopes: 'parent', objects: [] } }), link(ACCOUNT, null)])).toBe(false);
    expect(accountWideReach(ACCOUNT, AGENT, [
      link(AGENT, CONNECTOR, { kind: 'agent', boundTaskId: '44444444-4444-4444-8444-444444444444' }),
      link(CONNECTOR, ACCOUNT), link(ACCOUNT, null)])).toBe(false);
    expect(accountWideReach(ACCOUNT, CONNECTOR, [link(CONNECTOR, ACCOUNT, { ownExpression: null }), link(ACCOUNT, null)])).toBe(false);
    expect(accountWideReach(ACCOUNT, CONNECTOR, [link(CONNECTOR, CONNECTOR), link(CONNECTOR, null)])).toBe(false);
  });
});

describe('board metrics service failure paths (card e220be94)', () => {
  test('a caller without Account-wide reach is answered unknown without a database read', async () => {
    const connect = jest.fn();
    const shaped = await new BoardMetricsService({ connect } as any).read(ACCOUNT, false);
    expect(connect).not.toHaveBeenCalled();
    expect(shaped.queue).toMatchObject({ status: 'unknown', value: null, reason: 'caller-reach' });
    expect(shaped.throughput).toMatchObject({ status: 'unknown', value: null, reason: 'caller-reach' });
  });

  test('a failed connection or statement is unknown, never 0, and the read does not throw', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const down = await new BoardMetricsService({ connect: async () => { throw new Error('down'); } } as any).read(ACCOUNT, true);
      expect(down.queue).toMatchObject({ status: 'unknown', value: null, reason: 'unavailable' });
      expect(down.throughput).toMatchObject({ status: 'unknown', value: null, reason: 'unavailable' });
      const release = jest.fn();
      const client = { release, query: jest.fn(async (sql: string) => {
        if (/COUNT\(\*\)/.test(sql)) throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
        return { rows: [] };
      }) };
      const failed = await new BoardMetricsService({ connect: async () => client } as any).read(ACCOUNT, true);
      expect(failed.queue).toMatchObject({ status: 'unknown', value: null, reason: 'unavailable' });
      expect(failed.throughput).toMatchObject({ status: 'unknown', value: null, reason: 'unavailable' });
      expect(release).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });

  test('a broken connection is destroyed with its error, never pooled; a statement error returns a usable client', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const terminated = new Error('Connection terminated unexpectedly');
      const brokenRelease = jest.fn();
      const brokenQuery = jest.fn(async (sql: string) => {
        if (/COUNT\(\*\)/.test(sql)) throw terminated;
        if (sql === 'ROLLBACK') throw new Error('Client was closed and is not queryable');
        return { rows: [] };
      });
      const broken = await new BoardMetricsService({ connect: async () => ({ release: brokenRelease, query: brokenQuery }) } as any)
        .read(ACCOUNT, true);
      expect(broken.queue).toMatchObject({ status: 'unknown', value: null, reason: 'unavailable' });
      expect(broken.throughput).toMatchObject({ status: 'unknown', value: null, reason: 'unavailable' });
      expect(brokenRelease).toHaveBeenCalledTimes(1);
      expect(brokenRelease).toHaveBeenCalledWith(terminated);
      expect(brokenQuery.mock.calls.filter(([sql]) => /COUNT\(\*\)/.test(sql))).toHaveLength(1);

      const release = jest.fn();
      let counts = 0;
      const query = jest.fn(async (sql: string) => {
        if (/COUNT\(\*\)/.test(sql)) {
          counts += 1;
          if (counts === 1) throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
          return { rows: [{ value: '3', observed_ms: String(Date.now()) }] };
        }
        return { rows: [] };
      });
      const timedOut = await new BoardMetricsService({ connect: async () => ({ release, query }) } as any).read(ACCOUNT, true);
      expect(timedOut.queue).toMatchObject({ status: 'unknown', value: null, reason: 'unavailable' });
      expect(timedOut.throughput).toMatchObject({ status: 'reported', count: 3 });
      expect(release).toHaveBeenCalledTimes(1);
      expect(release.mock.calls[0][0]).toBeUndefined();
    } finally { spy.mockRestore(); }
  });
});
