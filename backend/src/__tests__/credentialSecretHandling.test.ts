/**
 * Show-once secret handling (CB-5 subtask [6], spec §3.3).
 *
 * The full key exists in exactly one response and nowhere else. These tests
 * assert the negative directly — that the secret does not reach any console
 * sink and cannot be read back — because a leak here is silent: everything
 * keeps working, the key is just recoverable from a log file forever.
 */
import crypto from 'crypto';

const queryMock = jest.fn();
jest.mock('../db/connection', () => ({
  pool: {
    query: (...args: unknown[]) => queryMock(...args),
    connect: jest.fn(async () => ({ query: (...args: unknown[]) => queryMock(...args), release: jest.fn() })),
  },
}));
jest.mock('../services/AuditService', () => ({ auditService: { record: jest.fn() } }));

const PRINCIPAL_ID = '88888888-8888-4888-8888-888888888888';

describe('issued secrets never reach a log sink', () => {
  let captured: string[] = [];
  const sinks: Array<[keyof Console, jest.SpyInstance]> = [];

  beforeEach(() => {
    jest.resetModules();
    queryMock.mockReset();
    captured = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      sinks.push([level, jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        captured.push(args.map(String).join(' '));
      })]);
    }
  });

  afterEach(() => {
    for (const [, spy] of sinks) spy.mockRestore();
    sinks.length = 0;
  });

  it('does not log the full key when issuing', async () => {
    queryMock.mockImplementation((_sql: string) =>
      /SELECT kind, status, legacy_identity, parent_principal_id FROM principals/.test(_sql)
        ? Promise.resolve({ rows: [{ kind: 'service', status: 'active', legacy_identity: false, parent_principal_id: '99999999-9999-4999-8999-999999999999' }] })
        : Promise.resolve({ rows: [{ id: 'cred-1' }] }));
    const { principalService } = await import('../services/PrincipalService');

    const issued = await principalService.issueCredential({
      principalId: PRINCIPAL_ID,
      scopes: ['tasks:read'],
      label: 'log-probe',
    });

    const secret = issued.fullKey.split('.')[1];
    expect(secret.length).toBeGreaterThan(20);
    const haystack = captured.join('\n');
    expect(haystack).not.toContain(issued.fullKey);
    expect(haystack).not.toContain(secret);
  });

  it('stores only the sha256 of the secret, never the secret', async () => {
    const inserts: unknown[][] = [];
    queryMock.mockImplementation((_sql: string, params?: unknown[]) => {
      if (/SELECT kind, status, legacy_identity, parent_principal_id FROM principals/.test(_sql)) {
        return Promise.resolve({ rows: [{ kind: 'service', status: 'active', legacy_identity: false, parent_principal_id: '99999999-9999-4999-8999-999999999999' }] });
      }
      if (params && /INSERT INTO principal_credentials/.test(_sql)) inserts.push(params);
      return Promise.resolve({ rows: [{ id: 'cred-2' }] });
    });
    const { principalService } = await import('../services/PrincipalService');

    const issued = await principalService.issueCredential({
      principalId: PRINCIPAL_ID,
      scopes: ['tasks:read'],
    });
    const secret = issued.fullKey.split('.')[1];
    const expectedHash = crypto.createHash('sha256').update(issued.fullKey).digest('hex');

    const params = inserts[0].map(String);
    // The hash is stored; the secret and the assembled key are not.
    expect(params).toContain(expectedHash);
    expect(params.some((p) => p.includes(secret))).toBe(false);
    expect(params.some((p) => p.includes(issued.fullKey))).toBe(false);
  });

  it('never returns a secret from a credential listing', async () => {
    queryMock.mockResolvedValue({
      rows: [{
        id: 'cred-3', key_id: 'abc123', label: 'x', scopes: ['tasks:read'],
        credential_type: 'api_key', created_at: new Date(), expires_at: null,
        revoked_at: null, last_used_at: null,
        // Present in the row the query selects — must not survive into the API shape.
        secret_hash: 'deadbeef',
      }],
    });
    const { principalService } = await import('../services/PrincipalService');

    const rows = await principalService.listCredentials(PRINCIPAL_ID);
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain('secret');
    expect(serialised).not.toContain('deadbeef');
    expect(rows[0]).toHaveProperty('keyId', 'abc123');
  });

  it('generates a fresh secret each time, so two keys never collide', async () => {
    queryMock.mockImplementation((_sql: string) =>
      /SELECT kind, status, legacy_identity, parent_principal_id FROM principals/.test(_sql)
        ? Promise.resolve({ rows: [{ kind: 'service', status: 'active', legacy_identity: false, parent_principal_id: '99999999-9999-4999-8999-999999999999' }] })
        : Promise.resolve({ rows: [{ id: 'cred-4' }] }));
    const { principalService } = await import('../services/PrincipalService');

    const a = await principalService.issueCredential({ principalId: PRINCIPAL_ID, scopes: ['tasks:read'] });
    const b = await principalService.issueCredential({ principalId: PRINCIPAL_ID, scopes: ['tasks:read'] });

    expect(a.fullKey).not.toBe(b.fullKey);
    expect(a.keyId).not.toBe(b.keyId);
    // 32 random bytes, base64url — enough that guessing is not a strategy.
    expect(a.fullKey.split('.')[1].length).toBeGreaterThanOrEqual(40);
  });

  it('mints keys under the environment prefix so a cross-env replay is visibly invalid', async () => {
    queryMock.mockImplementation((_sql: string) =>
      /SELECT kind, status, legacy_identity, parent_principal_id FROM principals/.test(_sql)
        ? Promise.resolve({ rows: [{ kind: 'service', status: 'active', legacy_identity: false, parent_principal_id: '99999999-9999-4999-8999-999999999999' }] })
        : Promise.resolve({ rows: [{ id: 'cred-5' }] }));
    const { principalService, expectedKeyEnv } = await import('../services/PrincipalService');

    const issued = await principalService.issueCredential({ principalId: PRINCIPAL_ID, scopes: ['tasks:read'] });
    expect(issued.fullKey.startsWith(`rh_${expectedKeyEnv()}_`)).toBe(true);
  });
});
