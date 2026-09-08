/**
 * WHAT THE AUDIT READ ACTUALLY ASKS POSTGRESQL — card 96aeacb7.
 *
 * `auditContract.test.ts` measures the ROUTE with the service mocked away, so
 * it can say which arguments a query produces and nothing about the SQL those
 * arguments become. The four filters this card adds are exactly where that
 * gap matters: a prefix filter is one careless `LIKE` away from matching more
 * rows than it names, and a time window is one inclusive bound away from
 * reporting an event twice.
 *
 * So this file drives the REAL `AuditService` with the connection pool
 * replaced, and reads the statement it emits.
 */
jest.mock('../db/connection', () => ({ pool: { query: jest.fn() } }));

import { pool } from '../db/connection';
import { AuditService } from '../services/AuditService';

const query = pool.query as unknown as jest.Mock;
const service = new AuditService();

/** The one statement the service issued, whitespace-collapsed. */
function lastStatement(): { sql: string; params: unknown[] } {
  expect(query).toHaveBeenCalledTimes(1);
  const [sql, params] = query.mock.calls[0];
  return { sql: String(sql).replace(/\s+/g, ' ').trim(), params: params as unknown[] };
}

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});

describe('GET /audit narrowing, as SQL', () => {
  it('asks for everything when nothing is asked of it', async () => {
    await service.list({ limit: 10 });
    const { sql, params } = lastStatement();
    expect(sql).not.toContain('WHERE');
    // The over-fetch by one is how `nextCursor` is decided; it must survive.
    expect(params).toEqual([11]);
  });

  it('contributes no clause for a filter that arrived empty', async () => {
    // A query string may carry `?actionPrefix=` — a control the page rendered
    // with nothing typed into it. The service decides absence by a falsy test,
    // so an empty filter must narrow nothing rather than match nothing.
    await service.list({
      limit: 10, action: '', actionPrefix: '', since: '', until: '',
      actorPrincipalId: '', resourceType: '', resourceId: '', before: '',
    });
    const { sql, params } = lastStatement();
    expect(sql).not.toContain('WHERE');
    expect(params).toEqual([11]);
  });

  it('matches an action PREFIX with left(), never with LIKE', async () => {
    await service.list({ limit: 10, actionPrefix: 'credential.' });
    const { sql, params } = lastStatement();
    expect(sql).toContain('left(action, length($1)) = $1');
    expect(params[0]).toBe('credential.');
    expect(sql).not.toMatch(/\bLIKE\b/i);
    expect(sql).not.toMatch(/\bSIMILAR TO\b/i);
    expect(sql).not.toContain('~');
  });

  it('treats an underscore in a prefix as a letter, because LIKE would not', async () => {
    // `task_arm` under LIKE matches `taskXarm`: `_` is a single-character
    // wildcard and migration 087's action alphabet contains it. The parameter
    // therefore reaches the database VERBATIM — no escaping, because there is
    // no pattern language for it to be escaped against.
    await service.list({ limit: 10, actionPrefix: 'task_' });
    const { sql, params } = lastStatement();
    expect(params[0]).toBe('task_');
    expect(sql).not.toMatch(/\bLIKE\b/i);
    expect(sql).not.toContain('ESCAPE');
  });

  it('narrows by outcome, the ledger own two-value enum', async () => {
    await service.list({ limit: 10, outcome: 'denied' });
    const { sql, params } = lastStatement();
    expect(sql).toContain('outcome = $1');
    expect(params[0]).toBe('denied');
  });

  it('reads a time window as half-open [since, until)', async () => {
    await service.list({
      limit: 10,
      since: '2026-09-01T00:00:00.000Z',
      until: '2026-09-02T00:00:00.000Z',
    });
    const { sql, params } = lastStatement();
    // Inclusive lower, EXCLUSIVE upper: adjacent windows must tile the ledger
    // exactly once, and `occurred_at` has sub-second precision.
    expect(sql).toContain('occurred_at >= $1::timestamptz');
    expect(sql).toContain('occurred_at < $2::timestamptz');
    expect(sql).not.toContain('occurred_at <= ');
    expect(params.slice(0, 2)).toEqual(['2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z']);
  });

  it('composes every filter with AND, in bind order, over one statement', async () => {
    await service.list({
      limit: 25,
      action: 'grant.create',
      actionPrefix: 'grant.',
      outcome: 'success',
      since: '2026-09-01T00:00:00.000Z',
      until: '2026-09-02T00:00:00.000Z',
      actorPrincipalId: '11111111-1111-4111-8111-111111111111',
      resourceType: 'zzresourcetype',
      resourceId: 'zzresourceid',
    });
    const { sql, params } = lastStatement();
    expect(query).toHaveBeenCalledTimes(1);
    expect(sql).toContain('WHERE');
    expect(sql.match(/ AND /g)?.length).toBe(7);
    expect(params).toEqual([
      'grant.create',
      'grant.',
      'success',
      '2026-09-01T00:00:00.000Z',
      '2026-09-02T00:00:00.000Z',
      '11111111-1111-4111-8111-111111111111',
      'zzresourcetype',
      'zzresourceid',
      26,
    ]);
    expect(sql).toContain('ORDER BY occurred_at DESC, id DESC');
  });

  it('never interpolates a caller value into the statement text', async () => {
    // The control that matters most and the cheapest one to lose: every filter
    // above must arrive as a bind parameter. A value appearing in the SQL
    // STRING is a value the database parses.
    const values = {
      action: 'zzactionexact',
      actionPrefix: 'zzactionprefix',
      outcome: 'denied' as const,
      since: '2026-09-01T00:00:00.000Z',
      until: '2026-09-02T00:00:00.000Z',
      actorPrincipalId: '22222222-2222-4222-8222-222222222222',
      resourceType: 'zzresourcetype',
      resourceId: 'zzresourceid',
      before: '33333333-3333-4333-8333-333333333333',
    };
    await service.list({ limit: 10, ...values });
    const { sql, params } = lastStatement();
    const interpolated = Object.values(values).filter((value) => sql.includes(value));
    expect(interpolated).toEqual([]);
    for (const value of Object.values(values)) {
      expect(params).toContain(value);
    }
  });

  it('still reports a next cursor from the over-fetched row, unfiltered or not', async () => {
    const row = (id: string) => ({
      id, occurred_at: new Date('2026-09-01T00:00:00.000Z'), action: 'grant.create',
      outcome: 'success', actor_principal_id: null, actor_handle: 'owner',
      auth_method: 'session', credential_id: null, resource_type: 'grant',
      resource_id: null, metadata: {},
    });
    query.mockResolvedValue({ rows: [row('a'), row('b'), row('c')] });
    const result = await service.list({ limit: 2, actionPrefix: 'grant.' });
    expect(result.events.map((event) => event.id)).toEqual(['a', 'b']);
    expect(result.nextCursor).toBe('b');
  });
});
