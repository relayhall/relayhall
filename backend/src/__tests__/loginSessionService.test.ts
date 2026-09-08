/**
 * SS-W1 · `LoginSessionService` — the contracts a database cannot show.
 *
 * Row-level behaviour (a session really expiring, a revoked row really
 * refusing) is proven against a real migrated PostgreSQL in
 * `backend/scripts/test-w1-sessions-live.js`. What lives here is what a live
 * run cannot observe: that the raw token never leaves the process, that the
 * two expiry windows are read from configuration at call time and bounded,
 * and that the mint takes no role-snapshot input.
 */
const queryMock = jest.fn();
jest.mock('../db/connection', () => ({ pool: { query: (...args: unknown[]) => queryMock(...args) } }));

import {
  hashSessionToken,
  loginSessionService,
  sessionAbsoluteMs,
  sessionIdleMs,
  REVOKE_REASONS,
} from '../services/LoginSessionService';

beforeEach(() => {
  queryMock.mockReset();
  delete process.env.RELAYHALL_SESSION_IDLE_MINUTES;
  delete process.env.RELAYHALL_SESSION_ABSOLUTE_HOURS;
});

describe('the raw session token never reaches the database', () => {
  it('stores only the digest, and returns the token exactly once', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: 'sess-1' }] });
    const minted = await loginSessionService.mint({ principalId: 'p-1' });
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(String(sql)).toContain('INSERT INTO auth_sessions');
    expect(params).toContain(hashSessionToken(minted.token));
    expect(params).not.toContain(minted.token);
    expect(JSON.stringify(params)).not.toContain(minted.token);
  });

  it('mints a distinct token every time', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: 'sess-1' }] });
    const tokens = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      tokens.add((await loginSessionService.mint({ principalId: 'p-1' })).token);
    }
    expect(tokens.size).toBe(25);
  });

  it('looks a presented token up by digest', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await loginSessionService.resolve('presented-token');
    const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe(hashSessionToken('presented-token'));
    expect(JSON.stringify(params)).not.toContain('presented-token');
  });
});

describe('the two expiry windows', () => {
  it('defaults to a 12-hour idle window and a 30-day absolute cap', () => {
    expect(sessionIdleMs()).toBe(12 * 60 * 60_000);
    expect(sessionAbsoluteMs()).toBe(30 * 24 * 60 * 60_000);
  });

  it('honours deployment configuration, read at call time', () => {
    process.env.RELAYHALL_SESSION_IDLE_MINUTES = '30';
    process.env.RELAYHALL_SESSION_ABSOLUTE_HOURS = '8';
    expect(sessionIdleMs()).toBe(30 * 60_000);
    expect(sessionAbsoluteMs()).toBe(8 * 3_600_000);
  });

  it.each(['0', '-5', 'soon', '1.5', '', '999999999'])(
    'falls back to the default rather than accepting %p',
    (value) => {
      process.env.RELAYHALL_SESSION_IDLE_MINUTES = value;
      process.env.RELAYHALL_SESSION_ABSOLUTE_HOURS = value;
      expect(sessionIdleMs()).toBe(12 * 60 * 60_000);
      expect(sessionAbsoluteMs()).toBe(30 * 24 * 60 * 60_000);
    },
  );

  it('stamps the absolute cap on the row and enforces the idle window on the read', async () => {
    process.env.RELAYHALL_SESSION_ABSOLUTE_HOURS = '2';
    process.env.RELAYHALL_SESSION_IDLE_MINUTES = '15';
    queryMock.mockResolvedValue({ rows: [{ id: 'sess-1' }] });
    const before = Date.now();
    const minted = await loginSessionService.mint({ principalId: 'p-1' });
    expect(minted.expiresAt.getTime() - before).toBeGreaterThanOrEqual(2 * 3_600_000 - 1_000);
    expect(minted.expiresAt.getTime() - before).toBeLessThanOrEqual(2 * 3_600_000 + 1_000);

    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [] });
    const atResolve = Date.now();
    await loginSessionService.resolve('t');
    const [, params] = queryMock.mock.calls[0] as [string, Date[]];
    const cutoff = params[1] as Date;
    expect(atResolve - cutoff.getTime()).toBeGreaterThanOrEqual(15 * 60_000 - 1_000);
    expect(atResolve - cutoff.getTime()).toBeLessThanOrEqual(15 * 60_000 + 1_000);
  });
});

describe('the mint cannot be given a role snapshot', () => {
  it('names no snapshot column and passes no snapshot value', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: 'sess-1' }] });
    await loginSessionService.mint({ principalId: 'p-1', credentialId: 'c-1', ip: '203.0.113.9', userAgent: 'Firefox' });
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(String(sql)).not.toContain('role_snapshot');
    expect(params).not.toContain('orchestrator');
    expect(params).not.toContain('admin');
  });

  it('drops an ip that is not an address, so the INET column cannot be poisoned', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: 'sess-1' }] });
    await loginSessionService.mint({ principalId: 'p-1', ip: 'not-an-address' });
    const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params[3]).toBeNull();
  });
});

describe('revocation vocabulary', () => {
  it('is exactly what migration 062 enumerates', () => {
    expect([...REVOKE_REASONS]).toEqual(['logout', 'idp_backchannel', 'disabled_user', 'admin', 'expired_sweep']);
  });

  it('never revokes an already-revoked row twice', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await loginSessionService.revoke('sess-1', 'logout')).toBe(false);
    const [sql] = queryMock.mock.calls[0] as [string];
    expect(String(sql)).toContain('revoked_at IS NULL');
  });
});
