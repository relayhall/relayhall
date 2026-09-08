/**
 * Regression pins for the defects the CB-2 independent review confirmed.
 * Each block names the finding it locks down so a later refactor cannot
 * silently reintroduce it.
 */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const SECRET = 'review-regression-secret';
const API_KEY = 'global-service-secret';
const PRINCIPAL_ID = '55555555-5555-4555-8555-555555555555';

const queryMock = jest.fn();
jest.mock('../db/connection', () => ({ pool: { query: (...args: unknown[]) => queryMock(...args) } }));

beforeEach(() => {
  jest.resetModules();
  queryMock.mockReset();
  process.env.JWT_SECRET = SECRET;
  process.env.RELAYHALL_API_KEY = API_KEY;
  process.env.RELAYHALL_REPORTS_READ_API_KEY = 'reports-read-secret';
  delete process.env.RELAYHALL_AUTH_REQUIRE_PRINCIPAL;
  delete process.env.RELAYHALL_SESSIONS;
});

interface InvokeResult { status: number; body: unknown; next: boolean; userId?: string }

async function invoke(headers: Record<string, unknown>, path: string, baseUrl: string, method = 'GET'): Promise<InvokeResult> {
  const { authMiddleware } = await import('../middleware/auth');
  const req: any = { baseUrl, path, method, headers };
  let status = 200;
  let body: unknown;
  let next = false;
  const res: any = {
    status: (code: number) => { status = code; return res; },
    json: (payload: unknown) => { body = payload; return res; },
  };
  await authMiddleware(req, res, () => { next = true; });
  return { status, body, next, userId: req.userId };
}

// ── Finding: 'Bearer rh_*' pre-empted the media cookie (flags-off breach) ────
// The Content Engine media-cookie branch this finding policed left core with
// the CE plugin (P1.3 ruling A5). What stays pinned is the inversion: the
// cookie that used to outrank a bearer on the artifact route now
// authenticates NOTHING, on that route or any other — a pass here proves the
// branch has not grown back — plus the malformed-rh_ bearer behaviour the
// original finding documented.
describe('the retired media cookie is not an identity anywhere', () => {
  const ARTIFACT = '/v1/daily-reports/report-x/artifacts/image.png';

  it('401s a signature-valid identity JWT presented via the retired cookie on its old route', async () => {
    queryMock.mockRejectedValue(Object.assign(new Error('no relation'), { code: '42P01' }));
    const mediaToken = (jwt.sign as any)({ userId: 'dashboard_user' }, SECRET, { expiresIn: '1h' });
    const result = await invoke(
      { cookie: `nim_content_engine_media=${mediaToken}` },
      ARTIFACT,
      '/content-engine'
    );
    expect(result.status).toBe(401);
    expect(result.next).toBe(false);
    expect(result.userId).toBeUndefined();
  });

  it('the cookie no longer pre-empts a rh_ bearer: the bearer is evaluated and rejected', async () => {
    queryMock.mockRejectedValue(Object.assign(new Error('no relation'), { code: '42P01' }));
    const mediaToken = (jwt.sign as any)({ userId: 'dashboard_user' }, SECRET, { expiresIn: '1h' });
    const result = await invoke(
      { cookie: `nim_content_engine_media=${mediaToken}`, authorization: 'Bearer rh_dev_somekeyid123.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG' },
      ARTIFACT,
      '/content-engine'
    );
    expect(result.next).toBe(false);
    expect(result.status).toBe(401);
  });

  it('still rejects a rh_ bearer when no media cookie applies', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const result = await invoke(
      { authorization: 'Bearer rh_dev_somekeyid123.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG' },
      '/',
      '/tasks'
    );
    expect(result.next).toBe(false);
    expect(result.status).toBe(401);
  });
});

// ── Finding: DB blips polluted the unknown-handle feed gating the CB-8 flip ──
describe('unknown-handle telemetry separates a confirmed miss from an outage', () => {
  async function runWithDb(behaviour: 'miss' | 'error') {
    if (behaviour === 'error') {
      queryMock.mockRejectedValue(Object.assign(new Error('db down'), { code: 'ECONNREFUSED' }));
    } else {
      queryMock.mockResolvedValue({ rows: [] });
    }
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const token = (jwt.sign as any)({ userId: 'dashboard_user' }, SECRET, { expiresIn: '1h' });
    const result = await invoke({ authorization: `Bearer ${token}` }, '/', '/tasks');
    const unknownHandleLines = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('unknown-handle-jwt'));
    warn.mockRestore();
    return { result, unknownHandleLines };
  }

  it('logs the gate line for a genuine miss', async () => {
    const { result, unknownHandleLines } = await runWithDb('miss');
    expect(result.next).toBe(true);
    expect(unknownHandleLines).toHaveLength(1);
  });

  it('does NOT log the gate line when the lookup itself failed', async () => {
    const { result, unknownHandleLines } = await runWithDb('error');
    expect(result.next).toBe(true); // degrade keeps authenticating
    expect(unknownHandleLines).toHaveLength(0);
  });
});

// ── Finding: boot sync resurrected an explicitly revoked legacy env row ──────
describe('syncLegacyEnvCredentials never resurrects a revoked credential', () => {
  function scriptSync(options: { revoked: boolean }) {
    const inserts: string[] = [];
    queryMock.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes('FROM principals WHERE handle')) {
        return Promise.resolve({ rows: [{
          id: PRINCIPAL_ID, kind: 'service', handle: 'reports_reader', display_name: null,
          status: 'active', role: null, source_tag: null, harness: null,
          personality_id: null, parent_principal_id: null, metadata: {},
        }] });
      }
      if (text.includes('SELECT revoked_at FROM principal_credentials')) {
        return Promise.resolve({ rows: [options.revoked ? { revoked_at: new Date().toISOString() } : {}] });
      }
      if (text.includes('INSERT INTO principal_credentials')) {
        inserts.push(text);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      return Promise.resolve({ rows: [] });
    });
    return inserts;
  }

  it('skips the upsert when the newest row for the key is revoked', async () => {
    const inserts = scriptSync({ revoked: true });
    const { principalService } = await import('../services/PrincipalService');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await principalService.syncLegacyEnvCredentials();
    const warned = warn.mock.calls.map((c) => String(c[0])).some((line) => line.includes('REVOKED'));
    warn.mockRestore();
    expect(inserts).toHaveLength(0);
    expect(warned).toBe(true);
  });

  it('still upserts telemetry rows when nothing is revoked', async () => {
    const inserts = scriptSync({ revoked: false });
    const { principalService } = await import('../services/PrincipalService');
    await principalService.syncLegacyEnvCredentials();
    expect(inserts.length).toBeGreaterThan(0);
  });

  it('hides compatibility principals again when their environment key is removed', async () => {
    delete process.env.RELAYHALL_API_KEY;
    delete process.env.RELAYHALL_REPORTS_READ_API_KEY;
    const hidden: string[] = [];
    queryMock.mockImplementation((sql: string, params?: unknown[]) => {
      if (String(sql).includes('hidden_until_configured')) hidden.push(String(params?.[0]));
      return Promise.resolve({ rows: [{ id: PRINCIPAL_ID }] });
    });
    const { principalService } = await import('../services/PrincipalService');
    await principalService.syncLegacyEnvCredentials();
    expect(hidden).toEqual(['service_account', 'reports_reader']);
  });
});

// ── Finding: v2 JWT whose sub no longer resolves (unscriptable before) ──────
describe('v2 JWT with an unresolvable sub', () => {
  it('authenticates flags-off, using the payload handle', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const token = (jwt.sign as any)(
      { v: 2, sub: PRINCIPAL_ID, handle: 'dashboard_user', kind: 'human' }, SECRET, { expiresIn: '1h' }
    );
    const result = await invoke({ authorization: `Bearer ${token}` }, '/', '/tasks');
    expect(result.next).toBe(true);
    expect(result.userId).toBe('dashboard_user');
  });

  it('401s when RELAYHALL_AUTH_REQUIRE_PRINCIPAL is on', async () => {
    process.env.RELAYHALL_AUTH_REQUIRE_PRINCIPAL = 'on';
    queryMock.mockResolvedValue({ rows: [] });
    const token = (jwt.sign as any)(
      { v: 2, sub: PRINCIPAL_ID, handle: 'dashboard_user', kind: 'human' }, SECRET, { expiresIn: '1h' }
    );
    const result = await invoke({ authorization: `Bearer ${token}` }, '/', '/tasks');
    expect(result.next).toBe(false);
    expect(result.status).toBe(401);
  });
});

// ── Finding: dormant session-cookie step had zero coverage ──────────────────
describe('dormant session cookie (RELAYHALL_SESSIONS)', () => {
  const SESSION_TOKEN = 'opaque-session-token';

  function scriptSession(row: Record<string, unknown> | null, principalStatus = 'active') {
    queryMock.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes('FROM auth_sessions')) return Promise.resolve({ rows: row ? [row] : [] });
      if (text.includes('FROM principals WHERE id')) {
        return Promise.resolve({ rows: [{
          id: PRINCIPAL_ID, kind: 'human', handle: 'dashboard_user', display_name: null,
          status: principalStatus, role: 'orchestrator', source_tag: null, harness: null,
          personality_id: null, parent_principal_id: null, metadata: {},
        }] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  it('is inert while the flag is off — the cookie cannot authenticate', async () => {
    scriptSession({ session_id: 'sess-1', role_snapshot: 'operator', principal_id: PRINCIPAL_ID });
    const result = await invoke({ cookie: `relayhall_session=${SESSION_TOKEN}` }, '/', '/tasks');
    expect(result.next).toBe(false);
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'Unauthorized', message: 'No token provided' });
  });

  it('authenticates a live session row when the flag is on', async () => {
    process.env.RELAYHALL_SESSIONS = 'on';
    scriptSession({ session_id: 'sess-1', role_snapshot: 'operator', principal_id: PRINCIPAL_ID });
    const result = await invoke({ cookie: `relayhall_session=${SESSION_TOKEN}` }, '/', '/tasks');
    expect(result.next).toBe(true);
    expect(result.userId).toBe('dashboard_user');
  });

  it('hashes the token rather than querying it raw', async () => {
    process.env.RELAYHALL_SESSIONS = 'on';
    scriptSession({ session_id: 'sess-1', role_snapshot: null, principal_id: PRINCIPAL_ID });
    await invoke({ cookie: `relayhall_session=${SESSION_TOKEN}` }, '/', '/tasks');
    const sessionCall = queryMock.mock.calls.find((call) => String(call[0]).includes('FROM auth_sessions'));
    const expectedHash = crypto.createHash('sha256').update(SESSION_TOKEN).digest('hex');
    // Parameter 1 is the digest; parameter 2 is SS-W1's idle-window cutoff.
    expect(sessionCall?.[1]?.[0]).toEqual(expectedHash);
    expect(sessionCall?.[1]).not.toContain(SESSION_TOKEN);
    expect(JSON.stringify(sessionCall?.[1])).not.toContain(SESSION_TOKEN);
  });

  it('falls through to 401 for an expired/revoked/missing row', async () => {
    process.env.RELAYHALL_SESSIONS = 'on';
    scriptSession(null);
    const result = await invoke({ cookie: `relayhall_session=${SESSION_TOKEN}` }, '/', '/tasks');
    expect(result.next).toBe(false);
    expect(result.status).toBe(401);
  });

  it('refuses a session belonging to a disabled principal', async () => {
    process.env.RELAYHALL_SESSIONS = 'on';
    scriptSession({ session_id: 'sess-1', role_snapshot: 'operator', principal_id: PRINCIPAL_ID }, 'disabled');
    const result = await invoke({ cookie: `relayhall_session=${SESSION_TOKEN}` }, '/', '/tasks');
    expect(result.next).toBe(false);
    expect(result.status).toBe(401);
  });
});

