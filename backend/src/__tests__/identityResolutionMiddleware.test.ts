/**
 * Identity resolution pipeline (CB-2 [1][2][16], spec b48bb799 §2.1).
 *
 * Exercises the new middleware steps against a scriptable DB mock:
 *  - rh_ bearer keys (step 4): happy path, wrong env, unknown, revoked-by-
 *    absence, bad secret — every failure is the exact legacy 401 body
 *  - JWT v2 + legacy fallback (step 5): principal attach, unknown-handle
 *    passthrough, RELAYHALL_AUTH_REQUIRE_PRINCIPAL flip
 *  - degrade semantics (subtask [16]): a broken DB must never change the
 *    legacy auth surface, and only a successfully-read revoked_at may
 *    fail-close a legacy env key
 */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const SECRET = 'resolution-test-secret';
const REPORTS_KEY = 'reports-read-secret';
const API_KEY = 'global-service-secret';
const PRINCIPAL_ID = '33333333-3333-4333-8333-333333333333';
const CRED_ID = '44444444-4444-4444-8444-444444444444';

// Scriptable pool: each test assigns an implementation keyed on SQL text.
const queryMock = jest.fn();
jest.mock('../db/connection', () => ({ pool: { query: (...args: unknown[]) => queryMock(...args) } }));

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

function principalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PRINCIPAL_ID,
    kind: 'agent',
    handle: 'agent:hermes:deadbeef',
    display_name: 'Test agent',
    status: 'active',
    role: 'agent',
    source_tag: 'tool-task-deadbeef',
    harness: 'hermes',
    personality_id: null,
    parent_principal_id: null,
    metadata: {},
    ...overrides,
  };
}

/** DB behaviour: resolves credential/principal lookups, rejects everything else. */
function scriptDb(options: {
  credentialSecret?: string;
  credentialExpired?: boolean;
  credentialTransport?: string;
  principalStatus?: string;
  knownHandles?: string[];
  legacyRevoked?: boolean;
  sessionRole?: string;
  broken?: boolean;
}) {
  queryMock.mockImplementation((sql: string, params?: unknown[]) => {
    if (options.broken) {
      return Promise.reject(Object.assign(new Error('db down'), { code: 'ECONNREFUSED' }));
    }
    const text = String(sql);
    if (text.includes('FROM auth_sessions s')) {
      return Promise.resolve({
        rows: options.sessionRole ? [{ session_id: 'session-1', role_snapshot: options.sessionRole, principal_id: PRINCIPAL_ID }] : [],
      });
    }
    if (text.includes('FROM principal_credentials c')) {
      if (!options.credentialSecret) return Promise.resolve({ rows: [] });
      return Promise.resolve({
        rows: [{
          credential_id: CRED_ID,
          principal_id: PRINCIPAL_ID,
          credential_type: 'api_key',
          key_id: params?.[0],
          secret_hash: sha256("rh_dev_" + String(params?.[0]) + "." + options.credentialSecret),
          scopes: ['tasks:read', 'tasks:write'],
          expires_at: options.credentialExpired
            ? new Date(Date.now() - 60_000).toISOString()
            : new Date(Date.now() + 60_000).toISOString(),
          revoked_at: null,
          transport: options.credentialTransport ?? 'any',
          grace_until: null,
          credential_metadata: { task_id: 'task-1' },
          ...principalRow({ status: options.principalStatus ?? 'active' }),
        }],
      });
    }
    if (text.includes("credential_type = 'legacy_env'") && text.includes('revoked_at')) {
      if (text.startsWith('UPDATE')) return Promise.resolve({ rows: [], rowCount: 1 });
      return Promise.resolve({ rows: options.legacyRevoked ? [{ revoked_at: new Date().toISOString() }] : [] });
    }
    if (text.includes('FROM principals WHERE handle')) {
      const handle = String(params?.[0]);
      const known = options.knownHandles ?? [];
      return Promise.resolve({
        rows: known.includes(handle)
          ? [principalRow({
            handle,
            kind: handle === 'dashboard_user' ? 'human' : 'agent',
            role: handle === 'dashboard_user' ? 'orchestrator' : 'agent',
          })]
          : [],
      });
    }
    if (text.includes('FROM principals WHERE id')) {
      return Promise.resolve({ rows: [principalRow()] });
    }
    if (text.startsWith('UPDATE')) return Promise.resolve({ rows: [], rowCount: 1 });
    return Promise.resolve({ rows: [] });
  });
}

interface InvokeResult {
  status: number;
  body: unknown;
  next: boolean;
  userId?: string;
  principalHandle?: string;
  scopes?: string[] | null;
  credentialId?: string;
}

async function invoke(headers: Record<string, unknown>, path = '/', baseUrl = '/tasks'): Promise<InvokeResult> {
  const { authMiddleware } = await import('../middleware/auth');
  const req: any = { baseUrl, path, method: 'GET', headers };
  let status = 200;
  let body: unknown;
  let next = false;
  const res: any = {
    status: (code: number) => { status = code; return res; },
    json: (payload: unknown) => { body = payload; return res; },
  };
  await authMiddleware(req, res, () => { next = true; });
  return {
    status, body, next,
    userId: req.userId,
    principalHandle: req.principal?.handle,
    scopes: req.scopes,
    credentialId: req.credentialId,
  };
}

beforeEach(() => {
  jest.resetModules();
  queryMock.mockReset();
  process.env.JWT_SECRET = SECRET;
  process.env.RELAYHALL_REPORTS_READ_API_KEY = REPORTS_KEY;
  process.env.RELAYHALL_API_KEY = API_KEY;
  delete process.env.RELAYHALL_AUTH_REQUIRE_PRINCIPAL;
  delete process.env.RELAYHALL_SESSIONS;
});

const KEY_ID = 'k7Jd93hQpLmA';
const CB_SECRET = crypto.randomBytes(32).toString('base64url');
const CB_KEY = `rh_dev_${KEY_ID}.${CB_SECRET}`; // NODE_ENV=test ⇒ expected env prefix is dev

describe('step 4: rh_ principal API keys', () => {
  it('authenticates a valid dev key: principal, handle-as-userId, scopes, credentialId', async () => {
    scriptDb({ credentialSecret: CB_SECRET });
    const result = await invoke({ authorization: `Bearer ${CB_KEY}` });
    expect(result.next).toBe(true);
    expect(result.userId).toBe('agent:hermes:deadbeef');
    expect(result.principalHandle).toBe('agent:hermes:deadbeef');
    expect(result.scopes).toEqual(['tasks:read', 'tasks:write']);
    expect(result.credentialId).toBe(CRED_ID);
  });

  it.each([
    ['wrong env prefix', `rh_live_${KEY_ID}.${CB_SECRET}`, { credentialSecret: CB_SECRET }],
    ['unknown key id', CB_KEY, {}],
    ['bad secret', `rh_dev_${KEY_ID}.${'A'.repeat(43)}`, { credentialSecret: CB_SECRET }],
    ['expired credential', CB_KEY, { credentialSecret: CB_SECRET, credentialExpired: true }],
    ['disabled principal', CB_KEY, { credentialSecret: CB_SECRET, principalStatus: 'disabled' }],
    ['structurally invalid', 'rh_dev_short', {}],
  ])('%s → the exact legacy 401 body', async (_label, token, db) => {
    scriptDb(db as Parameters<typeof scriptDb>[0]);
    const result = await invoke({ authorization: `Bearer ${token}` });
    expect(result.next).toBe(false);
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'Unauthorized', message: 'Invalid token' });
  });

  it('rejects rh_ keys with 401 when the substrate tables are missing (pre-migration)', async () => {
    queryMock.mockRejectedValue(Object.assign(new Error('no relation'), { code: '42P01' }));
    const result = await invoke({ authorization: `Bearer ${CB_KEY}` });
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'Unauthorized', message: 'Invalid token' });
  });

  it('does not reinterpret a scoped rh_ credential placed in x-api-key as a principal key', async () => {
    scriptDb({ credentialSecret: CB_SECRET });
    const result = await invoke({ 'x-api-key': CB_KEY });
    expect(result.next).toBe(false);
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'Unauthorized', message: 'No token provided' });
  });
});

describe('step 5: JWT resolution', () => {
  it('legacy payload with a known handle attaches the principal, userId unchanged', async () => {
    scriptDb({ knownHandles: ['dashboard_user'] });
    const token = jwt.sign({ userId: 'dashboard_user' }, SECRET, { expiresIn: '1h' });
    const result = await invoke({ authorization: `Bearer ${token}` });
    expect(result.next).toBe(true);
    expect(result.userId).toBe('dashboard_user');
    expect(result.principalHandle).toBe('dashboard_user');
    expect(result.scopes).toEqual(['root']);
  });

  it('legacy payload with an unknown handle keeps authenticating (telemetry path)', async () => {
    scriptDb({ knownHandles: [] });
    const token = jwt.sign({ userId: 'out_of_band_identity' }, SECRET, { expiresIn: '1h' });
    const result = await invoke({ authorization: `Bearer ${token}` });
    expect(result.next).toBe(true);
    expect(result.userId).toBe('out_of_band_identity');
    expect(result.principalHandle).toBeUndefined();
    expect(result.scopes).toEqual(expect.arrayContaining(['tasks:read', 'tasks:write']));
  });

  it('RELAYHALL_AUTH_REQUIRE_PRINCIPAL=on turns unknown handles into 401', async () => {
    process.env.RELAYHALL_AUTH_REQUIRE_PRINCIPAL = 'on';
    scriptDb({ knownHandles: [] });
    const token = jwt.sign({ userId: 'out_of_band_identity' }, SECRET, { expiresIn: '1h' });
    const result = await invoke({ authorization: `Bearer ${token}` });
    expect(result.next).toBe(false);
    expect(result.status).toBe(401);
  });

  it('v2 payload resolves the principal by id and uses its handle', async () => {
    scriptDb({});
    const token = jwt.sign({ v: 2, sub: PRINCIPAL_ID, handle: 'agent:hermes:deadbeef', kind: 'agent' }, SECRET, { expiresIn: '1h' });
    const result = await invoke({ authorization: `Bearer ${token}` });
    expect(result.next).toBe(true);
    expect(result.userId).toBe('agent:hermes:deadbeef');
    expect(result.principalHandle).toBe('agent:hermes:deadbeef');
    expect(result.scopes).toEqual(expect.arrayContaining(['tasks:read', 'tasks:write']));
  });

  it('a broken DB never blocks JWT auth (degrade to legacy)', async () => {
    scriptDb({ broken: true });
    const token = jwt.sign({ userId: 'dashboard_user' }, SECRET, { expiresIn: '1h' });
    const result = await invoke({ authorization: `Bearer ${token}` });
    expect(result.next).toBe(true);
    expect(result.userId).toBe('dashboard_user');
    expect(result.scopes).toEqual(['root']);
  });

  it('a live session receives scopes from role_snapshot, not the principal role', async () => {
    process.env.RELAYHALL_SESSIONS = 'on';
    scriptDb({ sessionRole: 'viewer' });
    const result = await invoke({ cookie: 'relayhall_session=session-token' });
    expect(result.next).toBe(true);
    expect(result.userId).toBe('agent:hermes:deadbeef');
    expect(result.scopes).toEqual(expect.arrayContaining(['tasks:read', 'reports:read']));
    expect(result.scopes).not.toContain('tasks:write');
    expect(result.scopes).not.toContain('root');
  });
});

describe('legacy env key revocation semantics (locked by spec §2.3)', () => {
  // These two pins moved from the journal publish key to the reports read key
  // when the journal branch left core with the Journal plugin (P1.3 ruling
  // A7) — the revocation semantics are a property of every legacy env key.
  it('a successfully-read revoked_at fail-closes the reports key', async () => {
    scriptDb({ legacyRevoked: true });
    const result = await invoke({ 'x-reports-read-key': REPORTS_KEY }, '/', '/reports');
    expect(result.next).toBe(false);
    expect(result.status).toBe(403);
  });

  it('a revocation-read ERROR degrades to env-compare-only — key keeps working', async () => {
    scriptDb({ broken: true });
    const result = await invoke({ 'x-reports-read-key': REPORTS_KEY }, '/', '/reports');
    expect(result.next).toBe(true);
    expect(result.userId).toBe('reports_reader');
  });

  it('a revoked master key falls through to the JWT branch, preserving the response shape', async () => {
    scriptDb({ legacyRevoked: true });
    const result = await invoke({ 'x-api-key': API_KEY });
    expect(result.next).toBe(false);
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'Unauthorized', message: 'No token provided' });
  });

  it('an unrevoked master key receives explicit service scopes without owner elevation', async () => {
    scriptDb({ knownHandles: ['service_account'] });
    const result = await invoke({ 'x-api-key': API_KEY });
    expect(result.next).toBe(true);
    expect(result.userId).toBe('service_account');
    expect(result.scopes).toEqual(expect.arrayContaining(['tasks:read', 'tasks:write']));
    expect(result.scopes).not.toContain('root');
    expect(result.scopes?.some((scope) => scope.endsWith(':admin'))).toBe(false);
  });
});


describe('AZ-S3 §7.5 transport enforcement (T15/T26) through authMiddleware', () => {
  const rhKey = `rh_dev_${KEY_ID}.${CB_SECRET}`;

  it('an mcp-pinned credential over REST is refused 403 TRANSPORT_MISMATCH', async () => {
    scriptDb({ credentialSecret: CB_SECRET, credentialTransport: 'mcp' });
    const result = await invoke({ authorization: `Bearer ${rhKey}` }, '/', '/tasks');
    expect(result.next).toBe(false);
    expect(result.status).toBe(403);
    expect((result.body as { code?: string }).code).toBe('TRANSPORT_MISMATCH');
  });

  it('an api-pinned credential on a classified REST route continues', async () => {
    scriptDb({ credentialSecret: CB_SECRET, credentialTransport: 'api' });
    const result = await invoke({ authorization: `Bearer ${rhKey}` }, '/', '/tasks');
    expect(result.next).toBe(true);
    expect(result.credentialId).toBeDefined();
  });

  it('an any-pinned credential continues on any classified route', async () => {
    scriptDb({ credentialSecret: CB_SECRET, credentialTransport: 'any' });
    const result = await invoke({ authorization: `Bearer ${rhKey}` }, '/', '/tasks');
    expect(result.next).toBe(true);
  });

  it('a forged x-transport header cannot make a REST request read as mcp', async () => {
    scriptDb({ credentialSecret: CB_SECRET, credentialTransport: 'mcp' });
    const result = await invoke(
      { authorization: `Bearer ${rhKey}`, 'x-transport': 'mcp', 'x-transport-class': 'mcp' },
      '/', '/tasks',
    );
    // The server stamp stays 'api' regardless of caller headers → still refused.
    expect(result.next).toBe(false);
    expect(result.status).toBe(403);
    expect((result.body as { code?: string }).code).toBe('TRANSPORT_MISMATCH');
  });

  it('a non-any pin on an UNCLASSIFIED route fails closed (T26)', async () => {
    scriptDb({ credentialSecret: CB_SECRET, credentialTransport: 'api' });
    const result = await invoke({ authorization: `Bearer ${rhKey}` }, '/', '/some-unclassified-surface');
    expect(result.next).toBe(false);
    expect(result.status).toBe(403);
    expect((result.body as { code?: string }).code).toBe('TRANSPORT_MISMATCH');
  });
});
