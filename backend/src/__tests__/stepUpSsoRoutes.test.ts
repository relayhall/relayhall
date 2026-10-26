/**
 * Card a3e76724 · the `/auth/step-up` route contract for an Account whose
 * proof is its Identity provider.
 *
 * Scope of THIS suite: the HTTP contract of the production `/auth` router —
 * which arm a body takes, which Account a step-up is bound to, what each
 * refusal answers, and that no arm ever answers 401 to a signed-in caller for
 * anything but a missing session (the dashboard signs a person out on any
 * 401). Its collaborators are doubled.
 *
 * The BEHAVIOURAL proofs — a real pending row, a really signed ID token whose
 * `auth_time` and subject decide the proof, the single-winner collection, the
 * token burned by `stepUpService.consume` exactly as a password one is — run
 * against a real migrated PostgreSQL in `stepUpSsoLive.test.ts`
 * (`npm run test:step-up-sso`). Neither suite is asked to prove the other's
 * claim.
 */
import express from 'express';
import http from 'http';
import bcrypt from 'bcrypt';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const PROVIDER_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const BREAK_GLASS = 'break-glass-password';

const sessionProvider: { id: string | null } = { id: PROVIDER_ID };
const poolQuery = jest.fn(async (text: string, _params?: unknown) => {
  if (/FROM auth_sessions/.test(text)) return { rows: [{ identity_provider_id: sessionProvider.id }] };
  return { rows: [] };
});
jest.mock('../db/connection', () => ({
  pool: { query: (text: string, params?: unknown) => poolQuery(text, params), connect: jest.fn() },
}));

const getPrincipalById = jest.fn();
jest.mock('../services/PrincipalService', () => ({
  principalService: {
    getPrincipalByHandle: jest.fn(),
    getPrincipalById: (...args: unknown[]) => getPrincipalById(...args),
    getPrincipalByIdStrict: (...args: unknown[]) => getPrincipalById(...args),
  },
}));
const auditRecord = jest.fn();
jest.mock('../services/AuditService', () => ({
  auditService: { record: (...args: unknown[]) => auditRecord(...args) },
}));
const passwordVerify = jest.fn();
const passwordHas = jest.fn();
jest.mock('../services/AccountPasswordService', () => ({
  accountPasswordService: {
    verify: (...args: unknown[]) => passwordVerify(...args),
    has: (...args: unknown[]) => passwordHas(...args),
  },
}));
const sessionResolve = jest.fn();
jest.mock('../services/LoginSessionService', () => ({
  SESSION_COOKIE_NAME: 'relayhall_session',
  sessionAbsoluteMs: () => 3_600_000,
  loginSessionService: { resolve: (...args: unknown[]) => sessionResolve(...args) },
}));
const stepUpMint = jest.fn();
jest.mock('../services/StepUpService', () => ({
  stepUpService: { mint: (...args: unknown[]) => stepUpMint(...args) },
}));
const startStepUp = jest.fn();
const stepUpProviderFor = jest.fn();
jest.mock('../services/identity/SsoAuthenticationService', () => {
  const actual = jest.requireActual('../services/identity/SsoAuthenticationService');
  return {
    ...actual,
    ssoAuthenticationService: {
      startStepUp: (...args: unknown[]) => startStepUp(...args),
      stepUpProviderFor: (...args: unknown[]) => stepUpProviderFor(...args),
    },
  };
});
const collectStepUp = jest.fn();
jest.mock('../services/identity/SsoAuthenticationRequestService', () => {
  const actual = jest.requireActual('../services/identity/SsoAuthenticationRequestService');
  return {
    ...actual,
    ssoAuthenticationRequestService: { collectStepUp: (...args: unknown[]) => collectStepUp(...args) },
  };
});

import { SsoAuthenticationError } from '../services/identity/SsoAuthenticationService';

interface Reply { status: number; body: any; headers: http.IncomingHttpHeaders }

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: ACCOUNT_ID, kind: 'human', handle: 'river-sso', displayName: 'Owner',
    status: 'active', role: 'orchestrator', legacyIdentity: false, metadata: {},
    ...overrides,
  };
}

let server: http.Server | undefined;
let origin = '';

// ONE router for the whole suite, loaded after the environment it reads at
// import (the JWT secret and the deployment hash). No module reset: the typed
// refusal classes thrown by the doubles must be the classes the router's
// `instanceof` arms test against.
beforeAll(async () => {
  process.env.JWT_SECRET = 'step-up-sso-routes-secret';
  process.env.RELAYHALL_SESSIONS = 'on';
  process.env.DASHBOARD_PASSWORD_HASH = await bcrypt.hash(BREAK_GLASS, 4);
  const authRouter = (await import('../routes/auth')).default;
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  const address = server!.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
});

async function startApp(): Promise<string> {
  return origin;
}

function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(`${base}${path}`, {
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let parsed: unknown = undefined;
        try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
        resolve({ status: response.statusCode ?? 0, body: parsed, headers: response.headers });
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

const SESSION = { cookie: 'relayhall_session=opaque-session' };

afterEach(() => {
  jest.clearAllMocks();
  sessionProvider.id = PROVIDER_ID;
  delete process.env.RELAYHALL_LOCAL_ADMIN_HANDLE;
});

beforeEach(() => {
  sessionResolve.mockResolvedValue({ sessionId: 'sess-1', principalId: ACCOUNT_ID, roleSnapshot: null });
  getPrincipalById.mockResolvedValue(account());
  passwordHas.mockResolvedValue(false);
  stepUpProviderFor.mockResolvedValue({ id: PROVIDER_ID, status: 'active' });
  stepUpMint.mockResolvedValue({ token: 'rhsu_from_sso', tokenId: 'token-row-1', expiresAt: '2026-10-08T20:05:00.000Z' });
  auditRecord.mockResolvedValue({});
});

describe('GET /auth/step-up/methods — the dialog asks for the proof this Account can give', () => {
  it('an Identity-provider session with no password credential is offered SSO, and only SSO', async () => {
    const base = await startApp();
    const reply = await call(base, 'GET', '/auth/step-up/methods', undefined, SESSION);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ success: true, methods: ['sso'], preferred: 'sso' });
    expect(stepUpProviderFor).toHaveBeenCalledWith(ACCOUNT_ID, PROVIDER_ID);
  });

  it('an Account with a password credential keeps password as the preferred method', async () => {
    passwordHas.mockResolvedValue(true);
    const base = await startApp();
    const reply = await call(base, 'GET', '/auth/step-up/methods', undefined, SESSION);
    expect(reply.body).toEqual({ success: true, methods: ['password', 'sso'], preferred: 'password' });
  });

  it('a local password session without any Identity link is offered password only', async () => {
    sessionProvider.id = null;
    passwordHas.mockResolvedValue(true);
    stepUpProviderFor.mockResolvedValue(null);
    const base = await startApp();
    const reply = await call(base, 'GET', '/auth/step-up/methods', undefined, SESSION);
    expect(reply.body).toEqual({ success: true, methods: ['password'], preferred: 'password' });
    expect(stepUpProviderFor).toHaveBeenCalledWith(ACCOUNT_ID, null);
  });

  it('the named local administrator keeps the deployment-hash fallback as a password method', async () => {
    sessionProvider.id = null;
    getPrincipalById.mockResolvedValue(account({ handle: 'dashboard_user' }));
    stepUpProviderFor.mockResolvedValue(null);
    const base = await startApp();
    const reply = await call(base, 'GET', '/auth/step-up/methods', undefined, SESSION);
    expect(reply.body).toEqual({ success: true, methods: ['password'], preferred: 'password' });
  });

  it('an Account with neither proof is told so rather than asked for a password', async () => {
    stepUpProviderFor.mockResolvedValue(null);
    const base = await startApp();
    const reply = await call(base, 'GET', '/auth/step-up/methods', undefined, SESSION);
    expect(reply.body).toEqual({ success: true, methods: [], preferred: null });
  });

  it('a caller with no session is refused with the AZ-18 message', async () => {
    const base = await startApp();
    const reply = await call(base, 'GET', '/auth/step-up/methods');
    expect(reply.status).toBe(401);
    expect(String(reply.body.message)).toContain('AZ-18');
  });
});

describe('POST /auth/step-up { method: "sso" } — begin a re-authentication bound to THIS Account', () => {
  it('binds the request to the SESSION Account, the trimmed action and target, and sets the browser binding cookie', async () => {
    startStepUp.mockResolvedValue({
      authorizeUrl: 'https://idp.test/authorize?prompt=login&max_age=0',
      stateCookieValue: 'state-value',
      pendingRequestId: REQUEST_ID,
      expiresAt: new Date(Date.now() + 600_000),
    });
    const base = await startApp();
    const reply = await call(base, 'POST', '/auth/step-up',
      { method: 'sso', action: ' approval.decide ', targetId: ' f655be10 ', principalId: 'someone-else' }, SESSION);
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ success: true, method: 'sso', requestId: REQUEST_ID });
    expect(reply.body.authorizeUrl).toContain('prompt=login');
    // No token leaves this arm: the proof is not complete yet.
    expect(reply.body.stepUpToken).toBeUndefined();
    expect(stepUpMint).not.toHaveBeenCalled();
    // The caller cannot name a different Account: `principalId` in the body is ignored.
    expect(startStepUp).toHaveBeenCalledWith({
      principalId: ACCOUNT_ID, action: 'approval.decide', targetId: 'f655be10', sessionIdentityProviderId: PROVIDER_ID,
    });
    const cookies = ([] as string[]).concat(reply.headers['set-cookie'] ?? []);
    const state = cookies.find((cookie) => cookie.startsWith('rh_sso_state='));
    expect(state).toBeDefined();
    expect(state).toMatch(/HttpOnly/i);
    expect(state).toMatch(/Secure/i);
    expect(state).toMatch(/SameSite=Lax/i);
    expect(passwordVerify).not.toHaveBeenCalled();
  });

  it('an Account with no proven Identity link gets the named refusal, not a password prompt', async () => {
    startStepUp.mockRejectedValue(new SsoAuthenticationError('SSO_STEP_UP_UNAVAILABLE', 'this Account holds no proven Identity link at an enabled Identity provider'));
    const base = await startApp();
    const reply = await call(base, 'POST', '/auth/step-up', { method: 'sso', action: 'approval.decide', targetId: 'x' }, SESSION);
    expect(reply.status).toBe(400);
    expect(reply.body.code).toBe('SSO_STEP_UP_UNAVAILABLE');
  });

  it('refuses a caller it cannot identify with the AZ-18 message, and an oversized binding before anything else', async () => {
    const base = await startApp();
    const anonymous = await call(base, 'POST', '/auth/step-up', { method: 'sso', action: 'approval.decide', targetId: 'x' });
    expect(anonymous.status).toBe(401);
    expect(String(anonymous.body.message)).toContain('AZ-18');
    const oversized = await call(base, 'POST', '/auth/step-up', { method: 'sso', action: 'a'.repeat(129), targetId: 'x' }, SESSION);
    expect(oversized.status).toBe(400);
    expect(oversized.body.code).toBe('STEP_UP_BINDING_INVALID');
    expect(startStepUp).not.toHaveBeenCalled();
  });

  it('a body without `method` keeps the password arm exactly as before', async () => {
    passwordVerify.mockResolvedValue({ principal: account(), credentialId: 'cred-1' });
    const base = await startApp();
    const reply = await call(base, 'POST', '/auth/step-up',
      { password: 'own-password', action: 'credential.reveal', targetId: 'cred-9' }, SESSION);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ success: true, stepUpToken: 'rhsu_from_sso', expiresAt: '2026-10-08T20:05:00.000Z' });
    expect(stepUpMint).toHaveBeenCalledWith(ACCOUNT_ID, 'credential.reveal', 'cred-9', 'password');
    expect(startStepUp).not.toHaveBeenCalled();
    const missing = await call(base, 'POST', '/auth/step-up', { action: 'credential.reveal', targetId: 'cred-9' }, SESSION);
    expect(missing.status).toBe(400);
    expect(missing.body.message).toBe('Password re-entry is required (§7.6)');
  });
});

describe('POST /auth/step-up/collect — exchange a proven re-authentication for the single-use token', () => {
  it('mints for the CALLER with the bound action and target, method oidc, and audits the method', async () => {
    collectStepUp.mockResolvedValue({
      status: 'collected', requestId: REQUEST_ID, identityProviderId: PROVIDER_ID,
      binding: { principalId: ACCOUNT_ID, action: 'approval.decide', targetId: 'f655be10' },
    });
    const base = await startApp();
    const reply = await call(base, 'POST', '/auth/step-up/collect', { requestId: REQUEST_ID }, SESSION);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      success: true, method: 'sso', stepUpToken: 'rhsu_from_sso', expiresAt: '2026-10-08T20:05:00.000Z',
      action: 'approval.decide', targetId: 'f655be10',
    });
    expect(collectStepUp).toHaveBeenCalledWith(REQUEST_ID, ACCOUNT_ID);
    expect(stepUpMint).toHaveBeenCalledWith(ACCOUNT_ID, 'approval.decide', 'f655be10', 'oidc');
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
      action: 'auth.step_up.mint',
      actor: expect.objectContaining({ principalId: ACCOUNT_ID, authMethod: 'session' }),
      metadata: expect.objectContaining({ method: 'oidc', action: 'approval.decide', target_id: 'f655be10', token_id: 'token-row-1' }),
    }));
  });

  it.each([
    ['unknown', 404, 'STEP_UP_REQUEST_UNKNOWN'],
    ['pending', 409, 'STEP_UP_PENDING'],
    ['refused', 400, 'STEP_UP_REFUSED'],
    ['already_collected', 409, 'STEP_UP_ALREADY_COLLECTED'],
    ['expired', 400, 'STEP_UP_EXPIRED'],
  ])('a %s proof is refused %i %s and mints nothing', async (status, http, code) => {
    collectStepUp.mockResolvedValue({ status });
    const base = await startApp();
    const reply = await call(base, 'POST', '/auth/step-up/collect', { requestId: REQUEST_ID }, SESSION);
    expect(reply.status).toBe(http);
    expect(reply.body.code).toBe(code);
    expect(reply.status).not.toBe(401);
    expect(stepUpMint).not.toHaveBeenCalled();
  });

  it('refuses a malformed request id and an unidentified caller before reading anything', async () => {
    const base = await startApp();
    const malformed = await call(base, 'POST', '/auth/step-up/collect', { requestId: 'not-a-uuid' }, SESSION);
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe('STEP_UP_REQUEST_INVALID');
    const anonymous = await call(base, 'POST', '/auth/step-up/collect', { requestId: REQUEST_ID });
    expect(anonymous.status).toBe(401);
    expect(collectStepUp).not.toHaveBeenCalled();
  });
});
