/**
 * SS-W1 · the `/auth` route contracts.
 *
 * Scope of THIS suite: the HTTP contract of the production route handlers —
 * status codes, bodies, cookie flags, audit calls, the throttle order, and
 * the break-glass narrowing. Its collaborators (the password vehicle, the
 * session store, the audit ledger) are doubled so those contracts can be
 * exercised without a database.
 *
 * The BEHAVIOURAL proofs — that a session row really is minted with a NULL
 * `role_snapshot`, that two Accounts really do carry different authority on
 * one board, that idle and absolute expiry really stop a session — run
 * against a real migrated PostgreSQL through the production services in
 * `backend/scripts/test-w1-sessions-live.js`. Neither suite is asked to
 * prove the other's claim.
 */
import express from 'express';
import http from 'http';
import bcrypt from 'bcrypt';

const PRINCIPAL_ID = '66666666-6666-4666-8666-666666666666';
const ADMIN_ID = '77777777-7777-4777-8777-777777777777';
const PASSWORD = 'break-glass-password';

const getPrincipalByHandle = jest.fn();
const getPrincipalById = jest.fn();
const auditRecord = jest.fn();
const passwordVerify = jest.fn();
const sessionMint = jest.fn();
const sessionResolve = jest.fn();
const sessionRevoke = jest.fn();
const sessionRevokeAll = jest.fn();
const sessionList = jest.fn();
const sessionOwns = jest.fn();

jest.mock('../services/PrincipalService', () => ({
  principalService: {
    getPrincipalByHandle: (...args: unknown[]) => getPrincipalByHandle(...args),
    getPrincipalById: (...args: unknown[]) => getPrincipalById(...args),
  },
}));
jest.mock('../services/AuditService', () => ({
  auditService: { record: (...args: unknown[]) => auditRecord(...args) },
}));
jest.mock('../services/AccountPasswordService', () => ({
  accountPasswordService: {
    verify: (...args: unknown[]) => passwordVerify(...args),
    has: jest.fn().mockResolvedValue(false),
  },
}));
jest.mock('../services/LoginSessionService', () => ({
  SESSION_COOKIE_NAME: 'relayhall_session',
  sessionAbsoluteMs: () => 3_600_000,
  loginSessionService: {
    mint: (...args: unknown[]) => sessionMint(...args),
    resolve: (...args: unknown[]) => sessionResolve(...args),
    revoke: (...args: unknown[]) => sessionRevoke(...args),
    revokeAllForPrincipal: (...args: unknown[]) => sessionRevokeAll(...args),
    list: (...args: unknown[]) => sessionList(...args),
    ownsSession: (...args: unknown[]) => sessionOwns(...args),
  },
}));
jest.mock('../services/StepUpService', () => ({
  stepUpService: { mint: jest.fn().mockResolvedValue({ token: 'step-up', expiresAt: new Date().toISOString() }) },
}));

interface Reply { status: number; body: any; headers: http.IncomingHttpHeaders }

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: PRINCIPAL_ID, kind: 'human', handle: 'ada', displayName: 'Ada',
    status: 'active', role: 'editor', legacyIdentity: false, metadata: {},
    ...overrides,
  };
}

let server: http.Server | undefined;

async function startApp(): Promise<string> {
  jest.resetModules();
  process.env.JWT_SECRET = 'w1-auth-routes-secret';
  process.env.DASHBOARD_PASSWORD_HASH = await bcrypt.hash(PASSWORD, 4);
  const authRouter = (await import('../routes/auth')).default;
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  const address = server!.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

function call(
  base: string, method: string, path: string,
  body?: unknown, headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(
      `${base}${path}`,
      {
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (response) => {
        let text = '';
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => {
          let parsed: unknown = undefined;
          try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
          resolve({ status: response.statusCode ?? 0, body: parsed, headers: response.headers });
        });
      },
    );
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  auditRecord.mockResolvedValue(undefined);
  getPrincipalByHandle.mockResolvedValue(undefined);
  getPrincipalById.mockResolvedValue(undefined);
  passwordVerify.mockResolvedValue(undefined);
  delete process.env.RELAYHALL_SESSIONS;
  delete process.env.RELAYHALL_LOCAL_ADMIN_HANDLE;
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

// ── §8.5 · the break-glass path, narrowed but otherwise unchanged ───────────
describe('POST /auth/login — permanent break-glass, narrowed to a named Account', () => {
  it('still takes a password-only body and returns the same success contract', async () => {
    getPrincipalByHandle.mockResolvedValue(account({ id: ADMIN_ID, handle: 'dashboard_user', role: 'orchestrator' }));
    const base = await startApp();
    const reply = await call(base, 'POST', '/auth/login', { password: PASSWORD });
    expect(reply.status).toBe(200);
    expect(reply.body.success).toBe(true);
    expect(typeof reply.body.token).toBe('string');
    expect(reply.body.expiresIn).toBe('30d');
  });

  it('authenticates the CONFIGURED local administrator Account, not a hard-coded handle', async () => {
    process.env.RELAYHALL_LOCAL_ADMIN_HANDLE = 'owner.ada';
    getPrincipalByHandle.mockResolvedValue(account({ id: ADMIN_ID, handle: 'owner.ada', role: 'admin' }));
    const base = await startApp();
    const reply = await call(base, 'POST', '/auth/login', { password: PASSWORD });
    expect(reply.status).toBe(200);
    expect(getPrincipalByHandle).toHaveBeenCalledWith('owner.ada');
    const audited = auditRecord.mock.calls.find(([write]: any[]) => write.action === 'auth.break_glass.login');
    expect(audited?.[0].actor.handle).toBe('owner.ada');
    expect(audited?.[0].actor.authMethod).toBe('local_admin');
  });

  it('falls back to the seeded handle when the configured one is malformed', async () => {
    process.env.RELAYHALL_LOCAL_ADMIN_HANDLE = 'Not A Handle!';
    getPrincipalByHandle.mockResolvedValue(account({ id: ADMIN_ID, handle: 'dashboard_user', role: 'orchestrator' }));
    const base = await startApp();
    const reply = await call(base, 'POST', '/auth/login', { password: PASSWORD });
    expect(reply.status).toBe(200);
    expect(getPrincipalByHandle).toHaveBeenCalledWith('dashboard_user');
  });

  it('a valid-but-NONEXISTENT configured handle falls back to the seed, not to a useless token', async () => {
    // Review verdict 77046845: 'missing-admin' passes the shape check, so the
    // fallback never fired and login minted a token for a handle that resolves
    // to no Account — `resolveActorRole` maps it to `agent` and `scopesForRole`
    // gives it nothing. A 200 that authorises nothing is a lockout.
    process.env.RELAYHALL_LOCAL_ADMIN_HANDLE = 'missing-admin';
    getPrincipalByHandle.mockResolvedValue(undefined);
    const base = await startApp();
    const reply = await call(base, 'POST', '/auth/login', { password: PASSWORD });
    expect(reply.status).toBe(200);
    expect(getPrincipalByHandle).toHaveBeenCalledWith('missing-admin');
    const audited = auditRecord.mock.calls.find(([write]: any[]) => write.action === 'auth.break_glass.login');
    // The seed, which the handle switch still grants authority to.
    expect(audited?.[0].actor.handle).toBe('dashboard_user');
  });

  it('a configured handle whose Account is DISABLED falls back to the seed', async () => {
    process.env.RELAYHALL_LOCAL_ADMIN_HANDLE = 'owner.ada';
    getPrincipalByHandle.mockResolvedValue(account({ id: ADMIN_ID, handle: 'owner.ada', status: 'disabled' }));
    const base = await startApp();
    const reply = await call(base, 'POST', '/auth/login', { password: PASSWORD });
    expect(reply.status).toBe(200);
    const audited = auditRecord.mock.calls.find(([write]: any[]) => write.action === 'auth.break_glass.login');
    expect(audited?.[0].actor.handle).toBe('dashboard_user');
    expect(audited?.[0].actor.principalId).toBeNull();
  });

  it('the fallback is not blanket — a resolvable ACTIVE handle is still honoured', async () => {
    // Non-vacuity: a repair that always fell back to the seed would satisfy
    // both tests above while silently discarding the narrowing this wave adds.
    process.env.RELAYHALL_LOCAL_ADMIN_HANDLE = 'owner.ada';
    getPrincipalByHandle.mockResolvedValue(account({ id: ADMIN_ID, handle: 'owner.ada', role: 'admin' }));
    const base = await startApp();
    const reply = await call(base, 'POST', '/auth/login', { password: PASSWORD });
    expect(reply.status).toBe(200);
    const audited = auditRecord.mock.calls.find(([write]: any[]) => write.action === 'auth.break_glass.login');
    expect(audited?.[0].actor.handle).toBe('owner.ada');
    expect(audited?.[0].actor.principalId).toBe(ADMIN_ID);
  });

  it('T-SS16 · succeeds with the session substrate switched off entirely', async () => {
    // "A disabled or unreachable provider never blocks local authentication."
    // In W1 the nearest equivalent is: the break-glass door does not consult
    // the session substrate at all, so it works with sessions off.
    getPrincipalByHandle.mockResolvedValue(account({ id: ADMIN_ID, handle: 'dashboard_user' }));
    const base = await startApp();
    const reply = await call(base, 'POST', '/auth/login', { password: PASSWORD });
    expect(reply.status).toBe(200);
    expect(sessionResolve).not.toHaveBeenCalled();
    expect(sessionMint).not.toHaveBeenCalled();
  });

  it('T-SS16 · succeeds when the identity substrate is unreadable', async () => {
    // How an unreadable substrate actually reaches this handler: the lookup
    // swallows DB errors and resolves undefined. The legacy-shape mint is the
    // documented fallback — login must never depend on the substrate.
    getPrincipalByHandle.mockResolvedValue(undefined);
    const base = await startApp();
    const reply = await call(base, 'POST', '/auth/login', { password: PASSWORD });
    expect(reply.status).toBe(200);
    expect(reply.body.success).toBe(true);
  });

  it('T-SS16 · succeeds when the identity substrate never answers (R11 timeout)', async () => {
    process.env.RELAYHALL_LOCAL_ADMIN_HANDLE = 'owner.ada';
    // A database that accepts connections and never replies is the outage the
    // 1.5s bound exists for; the narrowing must not have removed it.
    getPrincipalByHandle.mockReturnValue(new Promise(() => undefined));
    const base = await startApp();
    const started = Date.now();
    const reply = await call(base, 'POST', '/auth/login', { password: PASSWORD });
    expect(reply.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(6_000);
    const audited = auditRecord.mock.calls.find(([write]: any[]) => write.action === 'auth.break_glass.login');
    // Attributed to the SEED, not to the configured handle. Under an outage
    // nothing resolves, and an unknown handle would mint a token that
    // `resolveActorRole` maps to `agent` with no scopes — a lockout wearing a
    // 200. The seeded handle is the one the handle switch still grants
    // authority to without its row, so it is the only answer that keeps
    // break-glass a way back IN (review verdict `77046845`).
    expect(audited?.[0].actor.handle).toBe('dashboard_user');
    expect(audited?.[0].actor.principalId).toBeNull();
  }, 15_000);

  it('refuses a wrong password with the unchanged 401 body', async () => {
    const base = await startApp();
    const reply = await call(base, 'POST', '/auth/login', { password: 'wrong' });
    expect(reply.status).toBe(401);
    expect(reply.body).toEqual({ error: 'Unauthorized', message: 'Invalid password' });
  });

  it('refuses to mint an unaudited break-glass session', async () => {
    getPrincipalByHandle.mockResolvedValue(account({ id: ADMIN_ID, handle: 'dashboard_user' }));
    auditRecord.mockRejectedValue(new Error('ledger down'));
    const base = await startApp();
    const reply = await call(base, 'POST', '/auth/login', { password: PASSWORD });
    expect(reply.status).toBe(503);
  });
});

// ── SS-16 · the per-Account login session ──────────────────────────────────
describe('POST /auth/session — per-Account login', () => {
  it('is absent while RELAYHALL_SESSIONS is off', async () => {
    const base = await startApp();
    const reply = await call(base, 'POST', '/auth/session', { account: 'ada', password: 'x' });
    expect(reply.status).toBe(404);
    expect(reply.body.code).toBe('SESSIONS_DISABLED');
    expect(passwordVerify).not.toHaveBeenCalled();
  });

  it('sets an httpOnly, SameSite=Lax session cookie and returns NO token', async () => {
    process.env.RELAYHALL_SESSIONS = 'on';
    passwordVerify.mockResolvedValue({ principal: account(), credentialId: 'cred-1' });
    sessionMint.mockResolvedValue({ token: 'opaque-session', sessionId: 'sess-1', expiresAt: new Date('2030-01-01T00:00:00Z') });
    const base = await startApp();
    const reply = await call(base, 'POST', '/auth/session', { account: 'ada', password: 'correct-horse' });

    expect(reply.status).toBe(200);
    expect(reply.body.success).toBe(true);
    expect(reply.body.principal).toEqual({ handle: 'ada', displayName: 'Ada' });
    // AZ-18/A17.1: the session is a cookie, never a bearer value.
    expect(JSON.stringify(reply.body)).not.toContain('opaque-session');
    const cookies = ([] as string[]).concat(reply.headers['set-cookie'] ?? []);
    const session = cookies.find((value) => value.startsWith('relayhall_session='));
    expect(session).toBeDefined();
    expect(session).toContain('HttpOnly');
    expect(session).toContain('Secure');
    expect(session).toContain('SameSite=Lax');
    // The dashboard's <img>/<iframe> loads need the capability cookie too.
    expect(cookies.some((value) => value.startsWith('nim_browser_access='))).toBe(true);
  });

  it('gives one indistinguishable refusal for every failure arm', async () => {
    process.env.RELAYHALL_SESSIONS = 'on';
    const base = await startApp();
    const reply = await call(base, 'POST', '/auth/session', { account: 'nobody', password: 'whatever' });
    expect(reply.status).toBe(401);
    expect(reply.body).toEqual({ error: 'Unauthorized', message: 'Invalid account or password' });
    expect(reply.headers['set-cookie']).toBeUndefined();
  });

  it('throttles before the password is ever compared', async () => {
    process.env.RELAYHALL_SESSIONS = 'on';
    const base = await startApp();
    // First failure is free; the second trips the backoff.
    await call(base, 'POST', '/auth/session', { account: 'ada', password: 'no' });
    await call(base, 'POST', '/auth/session', { account: 'ada', password: 'no' });
    passwordVerify.mockClear();
    const throttled = await call(base, 'POST', '/auth/session', { account: 'ada', password: 'no' });
    expect(throttled.status).toBe(429);
    expect(throttled.headers['retry-after']).toBeDefined();
    expect(passwordVerify).not.toHaveBeenCalled();
  });

  it('revokes a session it could not audit rather than returning it', async () => {
    process.env.RELAYHALL_SESSIONS = 'on';
    passwordVerify.mockResolvedValue({ principal: account(), credentialId: 'cred-1' });
    sessionMint.mockResolvedValue({ token: 'opaque-session', sessionId: 'sess-1', expiresAt: new Date('2030-01-01T00:00:00Z') });
    sessionRevoke.mockResolvedValue(true);
    auditRecord.mockRejectedValue(new Error('ledger down'));
    const base = await startApp();
    const reply = await call(base, 'POST', '/auth/session', { account: 'ada', password: 'correct-horse' });
    expect(reply.status).toBe(503);
    expect(sessionRevoke).toHaveBeenCalledWith('sess-1', 'admin');
    expect(reply.headers['set-cookie']).toBeUndefined();
  });
});

describe('session listing and revocation are the caller own sessions only', () => {
  const liveCookie = { cookie: 'relayhall_session=opaque-session' };

  function signedIn() {
    sessionResolve.mockResolvedValue({ sessionId: 'sess-1', principalId: PRINCIPAL_ID, roleSnapshot: null });
    getPrincipalById.mockResolvedValue(account());
  }

  it('401s without a live session', async () => {
    process.env.RELAYHALL_SESSIONS = 'on';
    sessionResolve.mockResolvedValue(undefined);
    const base = await startApp();
    const reply = await call(base, 'GET', '/auth/sessions', undefined, liveCookie);
    expect(reply.status).toBe(401);
  });

  it('lists the caller own sessions and marks the current one', async () => {
    process.env.RELAYHALL_SESSIONS = 'on';
    signedIn();
    sessionList.mockResolvedValue([
      { id: 'sess-1', createdAt: new Date(), lastSeenAt: new Date(), expiresAt: new Date(), ip: null, userAgent: 'Firefox' },
      { id: 'sess-2', createdAt: new Date(), lastSeenAt: new Date(), expiresAt: new Date(), ip: null, userAgent: 'curl' },
    ]);
    const base = await startApp();
    const reply = await call(base, 'GET', '/auth/sessions', undefined, liveCookie);
    expect(reply.status).toBe(200);
    expect(sessionList).toHaveBeenCalledWith(PRINCIPAL_ID);
    expect(reply.body.sessions.map((s: any) => [s.id, s.current])).toEqual([['sess-1', true], ['sess-2', false]]);
  });

  it('answers a session id belonging to someone else exactly as a missing one', async () => {
    process.env.RELAYHALL_SESSIONS = 'on';
    signedIn();
    sessionOwns.mockResolvedValue(false);
    const base = await startApp();
    const reply = await call(base, 'DELETE', '/auth/sessions/sess-other', undefined, liveCookie);
    expect(reply.status).toBe(404);
    expect(sessionRevoke).not.toHaveBeenCalled();
  });

  it('revokes one of the caller own sessions', async () => {
    process.env.RELAYHALL_SESSIONS = 'on';
    signedIn();
    sessionOwns.mockResolvedValue(true);
    sessionRevoke.mockResolvedValue(true);
    const base = await startApp();
    const reply = await call(base, 'DELETE', '/auth/sessions/sess-2', undefined, liveCookie);
    expect(reply.status).toBe(204);
    expect(sessionRevoke).toHaveBeenCalledWith('sess-2', 'admin');
  });

  it('logs out the current session and clears both cookies', async () => {
    process.env.RELAYHALL_SESSIONS = 'on';
    signedIn();
    sessionRevoke.mockResolvedValue(true);
    const base = await startApp();
    const reply = await call(base, 'DELETE', '/auth/session', undefined, liveCookie);
    expect(reply.status).toBe(204);
    expect(sessionRevoke).toHaveBeenCalledWith('sess-1', 'logout');
    const cookies = ([] as string[]).concat(reply.headers['set-cookie'] ?? []);
    expect(cookies.some((value) => value.startsWith('relayhall_session=;'))).toBe(true);
    expect(cookies.some((value) => value.startsWith('nim_browser_access=;'))).toBe(true);
  });

  it('signs out everywhere', async () => {
    process.env.RELAYHALL_SESSIONS = 'on';
    signedIn();
    sessionRevokeAll.mockResolvedValue(3);
    const base = await startApp();
    const reply = await call(base, 'DELETE', '/auth/sessions', undefined, liveCookie);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ success: true, revoked: 3 });
    expect(sessionRevokeAll).toHaveBeenCalledWith(PRINCIPAL_ID, 'logout');
  });

  it('refuses an rh_ bearer credential outright (AZ-18)', async () => {
    process.env.RELAYHALL_SESSIONS = 'on';
    sessionResolve.mockResolvedValue(undefined);
    const base = await startApp();
    const reply = await call(base, 'GET', '/auth/sessions', undefined, { Authorization: 'Bearer rh_dev_abc.def' });
    expect(reply.status).toBe(401);
  });
});

// ── the capability cookie both doors need ──────────────────────────────────
describe('POST /auth/browser-session', () => {
  it('mints the capability cookie for a login session, which holds no bearer token', async () => {
    // The defect this pins: a session user sent no Authorization header, this
    // route answered 401, and `authenticatedFetch` turns a 401 into "clear
    // credentials and reload" — so the first plugin frame or dashboard image
    // ejected them to the login page. Only a live drill found it.
    process.env.RELAYHALL_SESSIONS = 'on';
    sessionResolve.mockResolvedValue({ sessionId: 'sess-1', principalId: PRINCIPAL_ID, roleSnapshot: null });
    getPrincipalById.mockResolvedValue(account());
    const base = await startApp();
    const reply = await call(base, 'POST', '/auth/browser-session', undefined,
      { cookie: 'relayhall_session=opaque-session' });
    expect(reply.status).toBe(204);
    const cookies = ([] as string[]).concat(reply.headers['set-cookie'] ?? []);
    expect(cookies.some((value) => value.startsWith('nim_browser_access='))).toBe(true);
  });

  it('still refuses a caller carrying nothing, with the unchanged body', async () => {
    process.env.RELAYHALL_SESSIONS = 'on';
    sessionResolve.mockResolvedValue(undefined);
    const base = await startApp();
    const reply = await call(base, 'POST', '/auth/browser-session');
    expect(reply.status).toBe(401);
    expect(reply.body).toEqual({ error: 'Unauthorized', message: 'No token provided' });
  });

  it('still refuses an rh_ bearer credential', async () => {
    process.env.RELAYHALL_SESSIONS = 'on';
    sessionResolve.mockResolvedValue(undefined);
    const base = await startApp();
    const reply = await call(base, 'POST', '/auth/browser-session', undefined,
      { Authorization: 'Bearer rh_dev_abc.def' });
    expect(reply.status).toBe(401);
  });
});

// ── §7.6 · step-up re-entry is now per-Account ─────────────────────────────
describe('POST /auth/step-up', () => {
  it('accepts the calling Account own password', async () => {
    process.env.RELAYHALL_SESSIONS = 'on';
    sessionResolve.mockResolvedValue({ sessionId: 'sess-1', principalId: PRINCIPAL_ID, roleSnapshot: null });
    getPrincipalById.mockResolvedValue(account());
    passwordVerify.mockResolvedValue({ principal: account(), credentialId: 'cred-1' });
    const base = await startApp();
    const reply = await call(base, 'POST', '/auth/step-up',
      { password: 'ada-own-password', action: 'credential.reveal', targetId: 'cred-9' },
      { cookie: 'relayhall_session=opaque-session' });
    expect(reply.status).toBe(200);
    expect(reply.body.stepUpToken).toBe('step-up');
    expect(passwordVerify).toHaveBeenCalledWith('ada', 'ada-own-password');
  });

  it('refuses another Account password even when it is valid somewhere', async () => {
    process.env.RELAYHALL_SESSIONS = 'on';
    sessionResolve.mockResolvedValue({ sessionId: 'sess-1', principalId: PRINCIPAL_ID, roleSnapshot: null });
    getPrincipalById.mockResolvedValue(account());
    // The password verifies — but to a DIFFERENT Account.
    passwordVerify.mockResolvedValue({ principal: account({ id: ADMIN_ID, handle: 'bob' }), credentialId: 'cred-2' });
    const base = await startApp();
    const reply = await call(base, 'POST', '/auth/step-up',
      { password: 'bobs-password', action: 'credential.reveal', targetId: 'cred-9' },
      { cookie: 'relayhall_session=opaque-session' });
    expect(reply.status).toBe(401);
  });

  it('keeps the deployment hash as the named local administrator fallback', async () => {
    process.env.RELAYHALL_SESSIONS = 'on';
    sessionResolve.mockResolvedValue({ sessionId: 'sess-1', principalId: ADMIN_ID, roleSnapshot: null });
    getPrincipalById.mockResolvedValue(account({ id: ADMIN_ID, handle: 'dashboard_user', role: 'orchestrator' }));
    passwordVerify.mockResolvedValue(undefined);
    const base = await startApp();
    const reply = await call(base, 'POST', '/auth/step-up',
      { password: PASSWORD, action: 'credential.reveal', targetId: 'cred-9' },
      { cookie: 'relayhall_session=opaque-session' });
    expect(reply.status).toBe(200);
  });

  it('still refuses a caller it cannot identify, with the AZ-18 message', async () => {
    const base = await startApp();
    const reply = await call(base, 'POST', '/auth/step-up', { password: PASSWORD, action: 'a', targetId: 'b' });
    expect(reply.status).toBe(401);
    expect(String(reply.body.message)).toContain('AZ-18');
  });
});
