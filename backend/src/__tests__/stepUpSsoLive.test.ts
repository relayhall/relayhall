/**
 * Card a3e76724 — STEP-UP FOR AN ACCOUNT WHOSE ONLY PROOF IS ITS IDENTITY
 * PROVIDER, measured against a REAL PostgreSQL.
 *
 * The owner signs in through the Identity provider and holds no password
 * credential, so `POST /auth/step-up` asked for a proof the Account cannot
 * give and every step-up-gated act was out of its reach. This suite drives the
 * repair through the PRODUCTION `/auth` router and the PRODUCTION protected
 * routes, over real rows:
 *
 *   start   `POST /auth/step-up {method:'sso'}` → a pending relying-party row
 *           bound to the session's Account, action and target; `prompt=login`
 *           and `max_age=0` on the authorize URL;
 *   prove   `GET /auth/sso/callback` with a REALLY SIGNED ID token from the
 *           provider double (`conformance/providerDouble`, the relying party's
 *           one outbound seam) → proven only for a fresh `auth_time` and the
 *           SAME Account's subject; no login session minted;
 *   collect `POST /auth/step-up/collect` → one `step_up_tokens` row, method
 *           `oidc`, for exactly the bound action and target;
 *   burn    `POST /approvals/:id/deny` → `stepUpService.consume`, the consumer
 *           every step-up-gated act uses; the decision records method `oidc`.
 *
 * And the refusals: a replayed callback, a stale `auth_time`, another
 * Account's subject, an unlinked subject, a tampered state, a foreign
 * browser, another Account collecting, a second collection, a stale proof,
 * a replayed token, and the login entry refusing a step-up row. The password
 * arm is driven too, so "unchanged" is measured rather than assumed.
 *
 * Card 7a99d63e (step-up re-authentication on the open standards) adds: the
 * named step-up refusals (`SSO_STEP_UP_NOT_FRESH`,
 * `SSO_STEP_UP_PROVIDER_DECLINED`) and their `auth.step_up.refused` audit
 * rows; the refusal -> relaunch path; the Identity provider's `stepUpPolicy`
 * (which standard question a step-up asks, written only by root, validated
 * at write) and its effect on the authorize URL, with `max_age_requested`
 * held at 0 and a stale `auth_time` refused under every policy; and the
 * `stepUp` challenge on `403 STEP_UP_REQUIRED`.
 *
 * It FAILS — never skips — without `RELAYHALL_TEST_DB_URL`
 * (`npm run test:step-up-sso`). It writes principals, projects, tasks,
 * approvals, Identity providers and links, login sessions, pending
 * relying-party rows, step-up tokens and audit rows, and removes its Identity
 * providers (and their links) by issuer prefix when it ends.
 */
import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error(
    'RELAYHALL_TEST_DB_URL is not set. The SSO step-up gate measures pending rows, proofs and burned tokens '
    + 'against a REAL PostgreSQL and refuses to skip. Create a disposable database, load database/init.sql, '
    + 'run npm run migrate, and set RELAYHALL_TEST_DB_URL to it.',
  );
}
const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = decodeURIComponent(parsed.pathname.slice(1));
const localFixture = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  && /test|contract|fixture/i.test(TEST_DB_NAME) && !/^clawboard(?:_|$)/i.test(TEST_DB_NAME);
const ciFixture = process.env.CI === 'true' && parsed.hostname === 'postgres' && TEST_DB_NAME === 'relayhall_ci';
if (!localFixture && !ciFixture) {
  throw new Error('The SSO step-up gate writes: point RELAYHALL_TEST_DB_URL at a local disposable test database or the CI service database.');
}

Object.assign(process.env, {
  DB_HOST: parsed.hostname,
  DB_PORT: parsed.port || '5432',
  DB_NAME: TEST_DB_NAME,
  DB_USER: decodeURIComponent(parsed.username),
  DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test',
  RELAYHALL_SESSIONS: 'on',
  JWT_SECRET: crypto.randomBytes(48).toString('hex'),
  RELAYHALL_PUBLIC_API_URL: 'https://board.step-up.test/api',
});
delete process.env.BOOT_CHECK;

const express = require('express');
const { pool } = require('../db/connection');
const authRouter = require('../routes/auth').default;
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { stepUpService } = require('../services/StepUpService');
const { accountPasswordService } = require('../services/AccountPasswordService');
const { identityProviderService } = require('../services/identity/IdentityProviderService');
const { identityLinkService } = require('../services/identity/IdentityLinkService');
const { SsoDiscoveryService } = require('../services/identity/SsoDiscoveryService');
const { ssoAuthenticationService } = require('../services/identity/SsoAuthenticationService');
const { ProviderDouble } = require('./conformance/providerDouble');
const { resetProvidersByIssuerPrefix } = require('./acceptance/resetProviders');

jest.setTimeout(120_000);

const HOST = 'https://idp.step-up.test';
const RUN = crypto.randomBytes(4).toString('hex');
const ISSUER = `${HOST}/${RUN}`;
const CLIENT_ID = `step-up-client-${RUN}`;
const SYSTEM_ACTOR = { principalId: null, handle: 'step-up-sso-suite', authMethod: 'system' };

// The relying party's ONE outbound seam is replaced by the provider double,
// on the production singleton the production router uses. Everything else —
// discovery parsing, JWKS resolution, the twelve refusals, the pending row —
// is the production code path.
const double = new ProviderDouble();
Object.assign(ssoAuthenticationService as object, { discovery: new SsoDiscoveryService(double), transport: double });

let server: http.Server;
let origin = '';
let provider: { id: string; issuer: string; clientId: string };

interface Caller { principalId: string; handle: string; cookie: string; subject: string | null }
let OWNER: Caller;
let OTHER: Caller;
let PASSWORD_HOLDER: Caller;
let ROOT_COOKIE = '';

const tag = (): string => crypto.randomBytes(5).toString('hex');

async function makeAccount(prefix: string, role: string): Promise<{ id: string; handle: string }> {
  const handle = `${prefix}-${tag()}`;
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role) VALUES ('human', $1, $1, 'active', $2) RETURNING id`,
    [handle, role],
  );
  return { id: String(result.rows[0].id), handle };
}

/** An Account linked at the provider, signed in THROUGH it — the owner's shape. */
async function federatedCaller(prefix: string): Promise<Caller> {
  const account = await makeAccount(prefix, 'user');
  const subject = `subject-${prefix}-${tag()}`;
  const link = await identityLinkService.establishProven({
    accountPrincipalId: account.id, identityProviderId: provider.id, subject,
  });
  const session = await loginSessionService.mint({
    principalId: account.id, identityProviderId: provider.id, identityLinkId: link.id,
  });
  return { principalId: account.id, handle: account.handle, cookie: `${SESSION_COOKIE_NAME}=${session.token}`, subject };
}

interface Answer { status: number; json: any; location: string | null; setCookies: string[] }

async function send(method: string, path: string, options: { cookie?: string; body?: unknown; accept?: string } = {}): Promise<Answer> {
  const response = await fetch(`${origin}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      Accept: options.accept ?? 'application/json',
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const raw = await response.text();
  let json: any = null;
  try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }
  return {
    status: response.status,
    json,
    location: response.headers.get('location'),
    setCookies: (response.headers as unknown as { getSetCookie(): string[] }).getSetCookie(),
  };
}

function stateCookieFrom(answer: Answer): string {
  const raw = answer.setCookies.find((cookie) => cookie.startsWith('rh_sso_state='));
  if (!raw) throw new Error('the step-up start set no state cookie');
  return raw.split(';')[0];
}

interface Started { requestId: string; state: string; nonce: string; stateCookie: string; authorizeUrl: URL }

async function startStepUp(who: Caller, action: string, targetId: string): Promise<Started> {
  const answer = await send('POST', '/auth/step-up', { cookie: who.cookie, body: { method: 'sso', action, targetId } });
  expect(answer.status).toBe(200);
  const authorizeUrl = new URL(answer.json.authorizeUrl);
  return {
    requestId: answer.json.requestId,
    state: authorizeUrl.searchParams.get('state') ?? '',
    nonce: authorizeUrl.searchParams.get('nonce') ?? '',
    stateCookie: stateCookieFrom(answer),
    authorizeUrl,
  };
}

async function requestedAtSeconds(requestId: string): Promise<number> {
  const row = await pool.query('SELECT requested_at FROM sso_authentication_requests WHERE id = $1', [requestId]);
  return new Date(row.rows[0].requested_at).getTime() / 1000;
}

/** The Identity provider's answer: a really signed ID token behind a code. */
async function providerAnswers(started: Started, subject: string, authTime?: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const fresh = Math.ceil(await requestedAtSeconds(started.requestId)) + 1;
  return double.issueCode(ISSUER, {
    iss: ISSUER, sub: subject, aud: CLIENT_ID, exp: now + 300, iat: now - 5,
    nonce: started.nonce, auth_time: authTime ?? fresh,
  });
}

function callbackPath(state: string, code: string): string {
  return `/auth/sso/callback?${new URLSearchParams({ state, code, iss: ISSUER }).toString()}`;
}

/** The Identity provider declining: an `error` on the callback, no code. */
function errorCallbackPath(state: string, error: string): string {
  return `/auth/sso/callback?${new URLSearchParams({ state, error, iss: ISSUER }).toString()}`;
}

/** The audit rows a step-up request left, oldest first. */
async function stepUpAudit(action: string, requestId: string): Promise<Array<{ outcome: string; metadata: any }>> {
  const result = await pool.query(
    `SELECT outcome, metadata FROM audit_events WHERE action = $1 AND metadata->>'request_id' = $2 ORDER BY occurred_at`,
    [action, requestId],
  );
  return result.rows;
}

/** Card 7a99d63e: set the provider's step-up policy as root would, or clear it. */
async function setPolicy(stepUpPolicy: unknown, extraAuthorizeParams: Record<string, string> = {}): Promise<void> {
  await identityProviderService.update(provider.id, { stepUpPolicy, extraAuthorizeParams } as never, SYSTEM_ACTOR);
}

async function makeApproval(requester: string): Promise<string> {
  const project = await pool.query(
    `INSERT INTO projects (name, status, visibility, owner_principal_id) VALUES ($1, 'active', 'private', $2) RETURNING id`,
    [`step-up project ${tag()}`, requester],
  );
  const task = await pool.query(
    `INSERT INTO tasks (title, status, visibility, project_id, owner_principal_id, creator_principal_id, shepherd_principal_id)
     VALUES ($1, 'todo', 'private', $2, $3, $3, $3) RETURNING id`,
    [`step-up drill task ${tag()}`, project.rows[0].id, requester],
  );
  const approval = await pool.query(
    `INSERT INTO approvals (status, requester_principal_id, session_evidence, target_task_id, requested_scopes, pending_expires_at)
     VALUES ('pending', $1, '{"kind":"step-up-suite"}'::jsonb, $2, '["tasks:read"]'::jsonb, now() + interval '1 day')
     RETURNING id`,
    [requester, task.rows[0].id],
  );
  return String(approval.rows[0].id);
}

async function tokensFor(principalId: string, action: string, targetId: string): Promise<Array<{ method: string; consumed_at: Date | null }>> {
  const result = await pool.query(
    'SELECT method, consumed_at FROM step_up_tokens WHERE principal_id = $1 AND action = $2 AND target_id = $3 ORDER BY created_at',
    [principalId, action, targetId],
  );
  return result.rows;
}

beforeAll(async () => {
  double.register({ issuer: ISSUER, clientId: CLIENT_ID });
  await resetProvidersByIssuerPrefix(`${HOST}%`);
  // SS-14a: exactly one enabled Identity provider. This suite owns the slot
  // for its run, as the W2 binding vectors do.
  await pool.query("UPDATE identity_providers SET status = 'disabled' WHERE status = 'active'");
  provider = await identityProviderService.create({
    name: `Step-up ${RUN}`, issuer: ISSUER, clientId: CLIENT_ID, clientSecret: 'step-up-secret',
    subjectImmutable: true, status: 'active', provisioningMode: 'invited',
  } as never, SYSTEM_ACTOR);

  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use('/auth', authRouter);
  registerProtectedRoutes((mount: string, ...handlers: any[]) => app.use(mount, authMiddleware, sharedAuthorizationMiddleware, ...handlers));
  app.use(apiErrorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;

  OWNER = await federatedCaller('owner');
  OTHER = await federatedCaller('other');
  const holder = await makeAccount('password-holder', 'user');
  await accountPasswordService.set(holder.id, 'correct horse battery staple', SYSTEM_ACTOR);
  const holderSession = await loginSessionService.mint({ principalId: holder.id });
  PASSWORD_HOLDER = { principalId: holder.id, handle: holder.handle, cookie: `${SESSION_COOKIE_NAME}=${holderSession.token}`, subject: null };
  const root = await makeAccount('step-up-root', 'admin');
  ROOT_COOKIE = `${SESSION_COOKIE_NAME}=${(await loginSessionService.mint({ principalId: root.id })).token}`;
});

afterEach(async () => {
  // Card 7a99d63e: every vector starts from the default request.
  if (provider) await setPolicy(null).catch(() => undefined);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await resetProvidersByIssuerPrefix(`${HOST}%`).catch(() => undefined);
  await pool.end();
});

describe('the owner — an Identity-provider-only Account — steps up and decides', () => {
  it('is offered SSO, and only SSO, by the methods route', async () => {
    const answer = await send('GET', '/auth/step-up/methods', { cookie: OWNER.cookie });
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual({ success: true, methods: ['sso'], preferred: 'sso' });
  });

  it('start → prove → collect → burn, with method oidc recorded at the mint and at the act', async () => {
    const approvalId = await makeApproval(OWNER.principalId);
    const started = await startStepUp(OWNER, 'approval.decide', approvalId);
    expect(started.authorizeUrl.searchParams.get('prompt')).toBe('login');
    expect(started.authorizeUrl.searchParams.get('max_age')).toBe('0');
    const pending = await pool.query(
      'SELECT step_up_principal_id, step_up_action, step_up_target_id, max_age_requested FROM sso_authentication_requests WHERE id = $1',
      [started.requestId],
    );
    expect(pending.rows[0]).toEqual({
      step_up_principal_id: OWNER.principalId, step_up_action: 'approval.decide', step_up_target_id: approvalId, max_age_requested: 0,
    });

    const sessionsBefore = await pool.query('SELECT count(*)::int AS n FROM auth_sessions WHERE principal_id = $1', [OWNER.principalId]);
    const code = await providerAnswers(started, OWNER.subject!);
    const landed = await send('GET', callbackPath(started.state, code), { cookie: started.stateCookie, accept: 'text/html' });
    expect(landed.status).toBe(302);
    expect(landed.location).toBe(`/dashboard/?step_up=complete&request=${started.requestId}`);
    // A step-up is not a login: no session cookie, no new session row.
    expect(landed.setCookies.some((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`))).toBe(false);
    const sessionsAfter = await pool.query('SELECT count(*)::int AS n FROM auth_sessions WHERE principal_id = $1', [OWNER.principalId]);
    expect(sessionsAfter.rows[0].n).toBe(sessionsBefore.rows[0].n);
    // Nothing is minted until the Account collects.
    expect(await tokensFor(OWNER.principalId, 'approval.decide', approvalId)).toEqual([]);

    const collected = await send('POST', '/auth/step-up/collect', { cookie: OWNER.cookie, body: { requestId: started.requestId } });
    expect(collected.status).toBe(200);
    expect(collected.json).toMatchObject({ success: true, method: 'sso', action: 'approval.decide', targetId: approvalId });
    expect(String(collected.json.stepUpToken)).toMatch(/^rhsu_/);
    expect(await tokensFor(OWNER.principalId, 'approval.decide', approvalId)).toEqual([{ method: 'oidc', consumed_at: null }]);
    const minted = await pool.query(
      `SELECT metadata FROM audit_events WHERE action = 'auth.step_up.mint' AND actor_principal_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [OWNER.principalId],
    );
    expect(minted.rows[0].metadata).toMatchObject({ method: 'oidc', action: 'approval.decide', target_id: approvalId });
    // Card 7a99d63e (SU-11): the proof records how fresh it was and which
    // question the provider was asked (no policy: the default pair).
    const reauthenticated = await stepUpAudit('auth.step_up.reauthenticated', started.requestId);
    expect(reauthenticated).toHaveLength(1);
    expect(reauthenticated[0].metadata).toMatchObject({
      strength: 'fresh_only', step_up_request: { prompt_login: true, max_age: 0 },
    });
    expect(reauthenticated[0].metadata.auth_time_delta_seconds).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(reauthenticated[0].metadata)).not.toContain(started.state);
    expect(JSON.stringify(reauthenticated[0].metadata)).not.toContain(started.nonce);

    // The burn, through the production consumer.
    const denied = await send('POST', `/approvals/${approvalId}/deny`, {
      cookie: OWNER.cookie, body: { stepUpToken: collected.json.stepUpToken, reason: 'step-up suite' },
    });
    expect(denied.status).toBe(200);
    const decision = await pool.query('SELECT status, decided_by_principal_id, decision_step_up FROM approvals WHERE id = $1', [approvalId]);
    expect(decision.rows[0].status).toBe('denied');
    expect(decision.rows[0].decided_by_principal_id).toBe(OWNER.principalId);
    expect(decision.rows[0].decision_step_up.method).toBe('oidc');
    const consumed = await tokensFor(OWNER.principalId, 'approval.decide', approvalId);
    expect(consumed).toHaveLength(1);
    expect(consumed[0].consumed_at).not.toBeNull();

    // Replays: the collection, the callback and the token are each refused by name.
    const recollect = await send('POST', '/auth/step-up/collect', { cookie: OWNER.cookie, body: { requestId: started.requestId } });
    expect(recollect.status).toBe(409);
    expect(recollect.json.code).toBe('STEP_UP_ALREADY_COLLECTED');
    const recallback = await send('GET', callbackPath(started.state, code), { cookie: started.stateCookie });
    expect(recallback.status).toBe(400);
    expect(recallback.json.code).toBe('SSO_STATE_UNKNOWN');
    const second = await makeApproval(OWNER.principalId);
    const replayed = await send('POST', `/approvals/${second}/deny`, {
      cookie: OWNER.cookie, body: { stepUpToken: collected.json.stepUpToken },
    });
    expect(replayed.status).toBe(403);
    expect(replayed.json.code).toBe('STEP_UP_REQUIRED');
    // Card 7a99d63e (SU-14): the refusal says what to step up FOR, and
    // carries no capability: the binding the act tried, freshness 0.
    // Card 72b8fb97 (SU-14 "methods"): and which proofs THIS caller can give,
    // the methods route's set: the owner holds only an Identity link.
    expect(replayed.json.stepUp).toEqual({
      error: 'insufficient_user_authentication', action: 'approval.decide', targetId: second, max_age: 0, methods: ['sso'],
    });
    expect((await pool.query('SELECT status FROM approvals WHERE id = $1', [second])).rows[0].status).toBe('pending');
  });

  it('two concurrent collections of one proof mint exactly one token', async () => {
    const target = crypto.randomUUID();
    const started = await startStepUp(OWNER, 'credential.reveal', target);
    const code = await providerAnswers(started, OWNER.subject!);
    expect((await send('GET', callbackPath(started.state, code), { cookie: started.stateCookie })).status).toBe(302);
    const answers = await Promise.all([1, 2, 3].map(() =>
      send('POST', '/auth/step-up/collect', { cookie: OWNER.cookie, body: { requestId: started.requestId } })));
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409, 409]);
    expect(await tokensFor(OWNER.principalId, 'credential.reveal', target)).toHaveLength(1);
  });
});

describe('the refusals — each typed, none mints a token', () => {
  it('a stale auth_time (an Identity provider that ignored max_age=0) is refused, and the proof reads refused', async () => {
    const target = crypto.randomUUID();
    const started = await startStepUp(OWNER, 'warrant.create', target);
    const stale = Math.floor(await requestedAtSeconds(started.requestId)) - 120;
    const code = await providerAnswers(started, OWNER.subject!, stale);
    const answer = await send('GET', callbackPath(started.state, code), { cookie: started.stateCookie });
    expect(answer.status).toBe(400);
    // Card 7a99d63e (SU-10): repaired BY NAME. The step-up arm names the
    // cause; the login arm keeps SSO_ID_TOKEN_REFUSED (vector below).
    expect(answer.json.code).toBe('SSO_STEP_UP_NOT_FRESH');
    const browser = await startStepUp(OWNER, 'warrant.create', target);
    const browserCode = await providerAnswers(browser, OWNER.subject!, stale);
    const landed = await send('GET', callbackPath(browser.state, browserCode), { cookie: browser.stateCookie, accept: 'text/html' });
    expect(landed.location).toBe(`/dashboard/?step_up=refused&request=${browser.requestId}&code=SSO_STEP_UP_NOT_FRESH`);
    // SU-11 (finding B.7-F1 repaired): the stale refusal is in the ledger,
    // with how far before the request the reused sign-in was.
    for (const requestId of [started.requestId, browser.requestId]) {
      const refused = await stepUpAudit('auth.step_up.refused', requestId);
      expect(refused).toHaveLength(1);
      expect(refused[0].outcome).toBe('denied');
      expect(refused[0].metadata).toMatchObject({
        method: 'oidc', reason: 'auth_time_stale', refusal_code: 'AUTH_TIME_STALE', auth_time: stale,
        action: 'warrant.create', target_id: target, step_up_request: { prompt_login: true, max_age: 0 },
      });
      expect(refused[0].metadata.auth_time_delta_seconds).toBeLessThan(-100);
    }
    const collect = await send('POST', '/auth/step-up/collect', { cookie: OWNER.cookie, body: { requestId: started.requestId } });
    expect(collect.status).toBe(400);
    expect(collect.json.code).toBe('STEP_UP_REFUSED');
    expect(await tokensFor(OWNER.principalId, 'warrant.create', target)).toEqual([]);
  });

  it("another Account's subject at the Identity provider cannot prove the owner's step-up, and the refusal is audited", async () => {
    const approvalId = await makeApproval(OWNER.principalId);
    const started = await startStepUp(OWNER, 'approval.decide', approvalId);
    const code = await providerAnswers(started, OTHER.subject!);
    const answer = await send('GET', callbackPath(started.state, code), { cookie: started.stateCookie });
    expect(answer.status).toBe(400);
    expect(answer.json.code).toBe('SSO_STEP_UP_SUBJECT_MISMATCH');
    const audited = await pool.query(
      `SELECT outcome, metadata FROM audit_events WHERE action = 'auth.step_up.refused' AND metadata->>'request_id' = $1`,
      [started.requestId],
    );
    expect(audited.rows).toHaveLength(1);
    expect(audited.rows[0].outcome).toBe('denied');
    expect(audited.rows[0].metadata).toMatchObject({ method: 'oidc', reason: 'subject_mismatch', subject: OTHER.subject });
    const collect = await send('POST', '/auth/step-up/collect', { cookie: OWNER.cookie, body: { requestId: started.requestId } });
    expect(collect.json.code).toBe('STEP_UP_REFUSED');
    expect(await tokensFor(OWNER.principalId, 'approval.decide', approvalId)).toEqual([]);
    expect(await tokensFor(OTHER.principalId, 'approval.decide', approvalId)).toEqual([]);
  });

  it('an unlinked subject is refused and provisions nothing', async () => {
    const target = crypto.randomUUID();
    const started = await startStepUp(OWNER, 'credential.reveal', target);
    const linksBefore = await pool.query('SELECT count(*)::int AS n FROM identity_links WHERE identity_provider_id = $1', [provider.id]);
    const principalsBefore = await pool.query('SELECT count(*)::int AS n FROM principals');
    const code = await providerAnswers(started, `stranger-${tag()}`);
    const answer = await send('GET', callbackPath(started.state, code), { cookie: started.stateCookie });
    expect(answer.json.code).toBe('SSO_STEP_UP_SUBJECT_MISMATCH');
    expect((await pool.query('SELECT count(*)::int AS n FROM identity_links WHERE identity_provider_id = $1', [provider.id])).rows[0].n)
      .toBe(linksBefore.rows[0].n);
    expect((await pool.query('SELECT count(*)::int AS n FROM principals')).rows[0].n).toBe(principalsBefore.rows[0].n);
  });

  it('a tampered state finds no row (the request stays pending); a foreign browser is refused and the attempt is spent', async () => {
    const target = crypto.randomUUID();
    const started = await startStepUp(OWNER, 'credential.reveal', target);
    const code = await providerAnswers(started, OWNER.subject!);
    const tampered = `${started.state.slice(0, -2)}xx`;
    const tamperedAnswer = await send('GET', callbackPath(tampered, code), { cookie: `rh_sso_state=${tampered}` });
    expect(tamperedAnswer.status).toBe(400);
    expect(tamperedAnswer.json.code).toBe('SSO_STATE_UNKNOWN');
    const stillPending = await send('POST', '/auth/step-up/collect', { cookie: OWNER.cookie, body: { requestId: started.requestId } });
    expect(stillPending.status).toBe(409);
    expect(stillPending.json.code).toBe('STEP_UP_PENDING');

    const foreign = await send('GET', callbackPath(started.state, code), { cookie: 'rh_sso_state=another-browser' });
    expect(foreign.status).toBe(400);
    expect(foreign.json.code).toBe('SSO_COOKIE_MISMATCH');
    const spent = await send('POST', '/auth/step-up/collect', { cookie: OWNER.cookie, body: { requestId: started.requestId } });
    expect(spent.json.code).toBe('STEP_UP_REFUSED');
    expect(await tokensFor(OWNER.principalId, 'credential.reveal', target)).toEqual([]);
  });

  it("another Account cannot collect the owner's proof, and a stale proof expires", async () => {
    const target = crypto.randomUUID();
    const started = await startStepUp(OWNER, 'credential.reveal', target);
    const code = await providerAnswers(started, OWNER.subject!);
    expect((await send('GET', callbackPath(started.state, code), { cookie: started.stateCookie })).status).toBe(302);
    const foreign = await send('POST', '/auth/step-up/collect', { cookie: OTHER.cookie, body: { requestId: started.requestId } });
    expect(foreign.status).toBe(404);
    expect(foreign.json.code).toBe('STEP_UP_REQUEST_UNKNOWN');
    await pool.query(
      "UPDATE sso_authentication_requests SET step_up_proven_at = now() - interval '10 minutes' WHERE id = $1",
      [started.requestId],
    );
    const stale = await send('POST', '/auth/step-up/collect', { cookie: OWNER.cookie, body: { requestId: started.requestId } });
    expect(stale.status).toBe(400);
    expect(stale.json.code).toBe('STEP_UP_EXPIRED');
    expect(await tokensFor(OWNER.principalId, 'credential.reveal', target)).toEqual([]);
    expect(await tokensFor(OTHER.principalId, 'credential.reveal', target)).toEqual([]);
  });

  it("a non-owner who steps up as THEMSELF still cannot decide the owner's approval, and the owner's token is theirs alone", async () => {
    const approvalId = await makeApproval(OWNER.principalId);
    const started = await startStepUp(OTHER, 'approval.decide', approvalId);
    const code = await providerAnswers(started, OTHER.subject!);
    expect((await send('GET', callbackPath(started.state, code), { cookie: started.stateCookie })).status).toBe(302);
    const collected = await send('POST', '/auth/step-up/collect', { cookie: OTHER.cookie, body: { requestId: started.requestId } });
    expect(collected.status).toBe(200);
    const attempt = await send('POST', `/approvals/${approvalId}/deny`, {
      cookie: OTHER.cookie, body: { stepUpToken: collected.json.stepUpToken },
    });
    expect(attempt.status).toBe(404);
    expect((await pool.query('SELECT status FROM approvals WHERE id = $1', [approvalId])).rows[0].status).toBe('pending');

    // The owner's token, presented under another principal, does not burn.
    const ownerStart = await startStepUp(OWNER, 'approval.decide', approvalId);
    const ownerCode = await providerAnswers(ownerStart, OWNER.subject!);
    await send('GET', callbackPath(ownerStart.state, ownerCode), { cookie: ownerStart.stateCookie });
    const ownerToken = (await send('POST', '/auth/step-up/collect', { cookie: OWNER.cookie, body: { requestId: ownerStart.requestId } })).json.stepUpToken;
    await expect(stepUpService.consume(pool, {
      token: ownerToken, principalId: OTHER.principalId, action: 'approval.decide', targetId: approvalId,
    })).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  it('the login entry never admits a step-up row: no session is minted from it', async () => {
    const started = await startStepUp(OWNER, 'credential.reveal', crypto.randomUUID());
    const code = await providerAnswers(started, OWNER.subject!);
    const sessionsBefore = await pool.query('SELECT count(*)::int AS n FROM auth_sessions WHERE principal_id = $1', [OWNER.principalId]);
    await expect(ssoAuthenticationService.completeAuthentication({
      state: started.state, code, iss: ISSUER, cookieState: started.state,
    })).rejects.toMatchObject({ name: 'SsoStepUpCallbackError' });
    const sessionsAfter = await pool.query('SELECT count(*)::int AS n FROM auth_sessions WHERE principal_id = $1', [OWNER.principalId]);
    expect(sessionsAfter.rows[0].n).toBe(sessionsBefore.rows[0].n);
    const row = await pool.query('SELECT step_up_proven_at, consumed_outcome FROM sso_authentication_requests WHERE id = $1', [started.requestId]);
    expect(row.rows[0].step_up_proven_at).toBeNull();
    expect(row.rows[0].consumed_outcome).toBe('step_up_not_admitted');
  });

  it('an Account with no Identity link is told SSO is unavailable rather than started', async () => {
    const answer = await send('POST', '/auth/step-up', {
      cookie: PASSWORD_HOLDER.cookie, body: { method: 'sso', action: 'credential.reveal', targetId: 'x' },
    });
    expect(answer.status).toBe(400);
    expect(answer.json.code).toBe('SSO_STEP_UP_UNAVAILABLE');
  });
});

describe('card 7a99d63e: the named step-up refusals, audited, and the relaunch', () => {
  it('an ID token with no auth_time is SSO_STEP_UP_NOT_FRESH on the step-up arm', async () => {
    const started = await startStepUp(OWNER, 'credential.reveal', crypto.randomUUID());
    const now = Math.floor(Date.now() / 1000);
    const code = await double.issueCode(ISSUER, {
      iss: ISSUER, sub: OWNER.subject!, aud: CLIENT_ID, exp: now + 300, iat: now - 5, nonce: started.nonce,
    });
    const answer = await send('GET', callbackPath(started.state, code), { cookie: started.stateCookie });
    expect(answer.json.code).toBe('SSO_STEP_UP_NOT_FRESH');
    const refused = await stepUpAudit('auth.step_up.refused', started.requestId);
    expect(refused).toHaveLength(1);
    expect(refused[0].metadata).toMatchObject({ reason: 'auth_time_stale', auth_time: null, auth_time_delta_seconds: null });
  });

  it('another ID-token refusal keeps SSO_ID_TOKEN_REFUSED on the step-up arm, audited other_id_token', async () => {
    const started = await startStepUp(OWNER, 'credential.reveal', crypto.randomUUID());
    const fresh = Math.ceil(await requestedAtSeconds(started.requestId)) + 1;
    const now = Math.floor(Date.now() / 1000);
    const code = await double.issueCode(ISSUER, {
      iss: ISSUER, sub: OWNER.subject!, aud: 'another-client', exp: now + 300, iat: now - 5, nonce: started.nonce, auth_time: fresh,
    });
    const answer = await send('GET', callbackPath(started.state, code), { cookie: started.stateCookie });
    expect(answer.json.code).toBe('SSO_ID_TOKEN_REFUSED');
    const refused = await stepUpAudit('auth.step_up.refused', started.requestId);
    expect(refused).toHaveLength(1);
    expect(refused[0].metadata).toMatchObject({ reason: 'other_id_token', refusal_code: 'AUDIENCE_MISMATCH' });
  });

  it.each(['login_required', 'unmet_authentication_requirements', 'interaction_required', 'access_denied'])(
    'the provider declining with %s is SSO_STEP_UP_PROVIDER_DECLINED, audited provider_declined',
    async (providerError) => {
      const started = await startStepUp(OWNER, 'credential.reveal', crypto.randomUUID());
      const answer = await send('GET', errorCallbackPath(started.state, providerError), { cookie: started.stateCookie });
      expect(answer.status).toBe(400);
      expect(answer.json.code).toBe('SSO_STEP_UP_PROVIDER_DECLINED');
      const browser = await startStepUp(OWNER, 'credential.reveal', crypto.randomUUID());
      const landed = await send('GET', errorCallbackPath(browser.state, providerError), { cookie: browser.stateCookie, accept: 'text/html' });
      expect(landed.location).toBe(`/dashboard/?step_up=refused&request=${browser.requestId}&code=SSO_STEP_UP_PROVIDER_DECLINED`);
      const refused = await stepUpAudit('auth.step_up.refused', started.requestId);
      expect(refused).toHaveLength(1);
      expect(refused[0].metadata).toMatchObject({ reason: 'provider_declined', refusal_code: 'SSO_STEP_UP_PROVIDER_DECLINED' });
    },
  );

  it('any other provider error stays SSO_PROVIDER_ERROR, and is still audited', async () => {
    const started = await startStepUp(OWNER, 'credential.reveal', crypto.randomUUID());
    const answer = await send('GET', errorCallbackPath(started.state, 'server_error'), { cookie: started.stateCookie });
    expect(answer.json.code).toBe('SSO_PROVIDER_ERROR');
    const refused = await stepUpAudit('auth.step_up.refused', started.requestId);
    expect(refused).toHaveLength(1);
    expect(refused[0].metadata).toMatchObject({ reason: 'callback_refused', refusal_code: 'SSO_PROVIDER_ERROR' });
  });

  it('a foreign browser is audited callback_refused; a subject mismatch is audited exactly once', async () => {
    const foreign = await startStepUp(OWNER, 'credential.reveal', crypto.randomUUID());
    const code = await providerAnswers(foreign, OWNER.subject!);
    await send('GET', callbackPath(foreign.state, code), { cookie: 'rh_sso_state=another-browser' });
    expect((await stepUpAudit('auth.step_up.refused', foreign.requestId)).map((row) => row.metadata.reason)).toEqual(['callback_refused']);
    const mismatch = await startStepUp(OWNER, 'credential.reveal', crypto.randomUUID());
    const otherCode = await providerAnswers(mismatch, OTHER.subject!);
    await send('GET', callbackPath(mismatch.state, otherCode), { cookie: mismatch.stateCookie });
    expect((await stepUpAudit('auth.step_up.refused', mismatch.requestId)).map((row) => row.metadata.reason)).toEqual(['subject_mismatch']);
  });

  it('the login arm keeps SSO_ID_TOKEN_REFUSED for a stale auth_time (a step-up LOGIN, not a step-up row)', async () => {
    const started = await send('POST', '/auth/sso/start', { body: { stepUp: true } });
    expect(started.status).toBe(200);
    const authorizeUrl = new URL(started.json.authorizeUrl);
    const state = authorizeUrl.searchParams.get('state') ?? '';
    const pending = await pool.query(
      'SELECT id, requested_at FROM sso_authentication_requests WHERE identity_provider_id = $1 AND step_up_principal_id IS NULL ORDER BY requested_at DESC LIMIT 1',
      [provider.id],
    );
    const stale = Math.floor(new Date(pending.rows[0].requested_at).getTime() / 1000) - 120;
    const now = Math.floor(Date.now() / 1000);
    const code = await double.issueCode(ISSUER, {
      iss: ISSUER, sub: OWNER.subject!, aud: CLIENT_ID, exp: now + 300, iat: now - 5,
      nonce: authorizeUrl.searchParams.get('nonce') ?? '', auth_time: stale,
    });
    const answer = await send('GET', callbackPath(state, code), { cookie: stateCookieFrom(started) });
    expect(answer.status).toBe(400);
    expect(answer.json.code).toBe('SSO_ID_TOKEN_REFUSED');
  });

  it('refusal -> relaunch: the refused row stays unprovable, a NEW request proves and collects, exactly one token', async () => {
    const approvalId = await makeApproval(OWNER.principalId);
    const refusedStart = await startStepUp(OWNER, 'approval.decide', approvalId);
    const stale = Math.floor(await requestedAtSeconds(refusedStart.requestId)) - 60;
    const staleCode = await providerAnswers(refusedStart, OWNER.subject!, stale);
    expect((await send('GET', callbackPath(refusedStart.state, staleCode), { cookie: refusedStart.stateCookie })).json.code)
      .toBe('SSO_STEP_UP_NOT_FRESH');

    // The relaunch is a new row: new request id, state, nonce, requested_at.
    const relaunch = await startStepUp(OWNER, 'approval.decide', approvalId);
    expect(relaunch.requestId).not.toBe(refusedStart.requestId);
    expect(relaunch.state).not.toBe(refusedStart.state);
    expect(relaunch.nonce).not.toBe(refusedStart.nonce);
    const freshCode = await providerAnswers(relaunch, OWNER.subject!);
    expect((await send('GET', callbackPath(relaunch.state, freshCode), { cookie: relaunch.stateCookie })).status).toBe(302);

    // The refused row can never be proven or collected later.
    const replayOnRefused = await send('GET', callbackPath(refusedStart.state, freshCode), { cookie: refusedStart.stateCookie });
    expect(replayOnRefused.json.code).toBe('SSO_STATE_UNKNOWN');
    const refusedCollect = await send('POST', '/auth/step-up/collect', { cookie: OWNER.cookie, body: { requestId: refusedStart.requestId } });
    expect(refusedCollect.json.code).toBe('STEP_UP_REFUSED');
    const collected = await send('POST', '/auth/step-up/collect', { cookie: OWNER.cookie, body: { requestId: relaunch.requestId } });
    expect(collected.status).toBe(200);
    expect(await tokensFor(OWNER.principalId, 'approval.decide', approvalId)).toEqual([{ method: 'oidc', consumed_at: null }]);
    const rows = await pool.query(
      'SELECT id, consumed_outcome, step_up_proven_at FROM sso_authentication_requests WHERE id = ANY($1::uuid[])',
      [[refusedStart.requestId, relaunch.requestId]],
    );
    const byId = new Map(rows.rows.map((row: any) => [String(row.id), row]));
    expect(byId.get(refusedStart.requestId)).toMatchObject({ consumed_outcome: 'step_up_refused', step_up_proven_at: null });
    expect(byId.get(relaunch.requestId)).toMatchObject({ consumed_outcome: 'step_up_collected' });
  });
});

describe('card 7a99d63e: the Identity provider step-up policy', () => {
  it('no policy sends the default request byte for byte; an extra prompt or max_age never rides a step-up', async () => {
    const plain = await startStepUp(OWNER, 'credential.reveal', crypto.randomUUID());
    expect(plain.authorizeUrl.searchParams.getAll('prompt')).toEqual(['login']);
    expect(plain.authorizeUrl.searchParams.getAll('max_age')).toEqual(['0']);

    await setPolicy(null, { prompt: 'none', max_age: '999', ui_locales: 'en' });
    const smuggled = await startStepUp(OWNER, 'credential.reveal', crypto.randomUUID());
    expect(smuggled.authorizeUrl.searchParams.getAll('prompt')).toEqual(['login']);
    expect(smuggled.authorizeUrl.searchParams.getAll('max_age')).toEqual(['0']);
    expect(smuggled.authorizeUrl.searchParams.get('ui_locales')).toBe('en');
    // The login request still carries the extra parameters as configured.
    const login = await send('POST', '/auth/sso/start', { body: {} });
    expect(new URL(login.json.authorizeUrl).searchParams.get('prompt')).toBe('none');
  });

  it('{prompt_login: false, max_age: 30} sends exactly max_age=30 and no prompt, even over an extra prompt=none', async () => {
    await setPolicy({ prompt_login: false, max_age: 30 }, { prompt: 'none', max_age: '999' });
    const started = await startStepUp(OWNER, 'credential.reveal', crypto.randomUUID());
    expect(started.authorizeUrl.searchParams.getAll('prompt')).toEqual([]);
    expect(started.authorizeUrl.searchParams.getAll('max_age')).toEqual(['30']);
    // The 140 binding holds: the row records the freshness ENFORCED, 0.
    const row = await pool.query('SELECT max_age_requested FROM sso_authentication_requests WHERE id = $1', [started.requestId]);
    expect(row.rows[0].max_age_requested).toBe(0);
    const code = await providerAnswers(started, OWNER.subject!);
    expect((await send('GET', callbackPath(started.state, code), { cookie: started.stateCookie })).status).toBe(302);
    const proven = await stepUpAudit('auth.step_up.reauthenticated', started.requestId);
    expect(proven[0].metadata).toMatchObject({ step_up_request: { prompt_login: false, max_age: 30 } });
    expect(proven[0].metadata.auth_time_delta_seconds).toBeGreaterThan(0);
  });

  it.each([
    [{ prompt_login: false, max_age: 30 }, null, '30'],
    [{ prompt_login: true, max_age: null }, 'login', null],
    [{ max_age: 300 }, 'login', '300'],
  ])('under policy %j a stale auth_time is still refused SSO_STEP_UP_NOT_FRESH and max_age_requested stays 0', async (policy, prompt, maxAge) => {
    await setPolicy(policy);
    const started = await startStepUp(OWNER, 'credential.reveal', crypto.randomUUID());
    expect(started.authorizeUrl.searchParams.get('prompt')).toBe(prompt);
    expect(started.authorizeUrl.searchParams.get('max_age')).toBe(maxAge);
    const row = await pool.query('SELECT max_age_requested FROM sso_authentication_requests WHERE id = $1', [started.requestId]);
    expect(row.rows[0].max_age_requested).toBe(0);
    const stale = Math.floor(await requestedAtSeconds(started.requestId)) - 1;
    const code = await providerAnswers(started, OWNER.subject!, stale);
    const answer = await send('GET', callbackPath(started.state, code), { cookie: started.stateCookie });
    expect(answer.json.code).toBe('SSO_STEP_UP_NOT_FRESH');
    const collect = await send('POST', '/auth/step-up/collect', { cookie: OWNER.cookie, body: { requestId: started.requestId } });
    expect(collect.json.code).toBe('STEP_UP_REFUSED');
  });

  it('sso_step_up: disabled takes SSO out of the methods and refuses the start by name', async () => {
    await setPolicy({ sso_step_up: 'disabled' });
    const methods = await send('GET', '/auth/step-up/methods', { cookie: OWNER.cookie });
    expect(methods.json).toEqual({ success: true, methods: [], preferred: null });
    const start = await send('POST', '/auth/step-up', { cookie: OWNER.cookie, body: { method: 'sso', action: 'credential.reveal', targetId: 'x' } });
    expect(start.status).toBe(400);
    expect(start.json.code).toBe('SSO_STEP_UP_UNAVAILABLE');
  });

  it('root writes and reads the policy through PATCH /identity-providers/:id, audited before and after', async () => {
    const written = await send('PATCH', `/identity-providers/${provider.id}`, {
      cookie: ROOT_COOKIE, body: { stepUpPolicy: { prompt_login: false, max_age: 30 } },
    });
    expect(written.status).toBe(200);
    expect(written.json.identityProvider.stepUpPolicy).toEqual({ prompt_login: false, max_age: 30 });
    const readBack = await send('GET', `/identity-providers/${provider.id}`, { cookie: ROOT_COOKIE });
    expect(readBack.json.identityProvider.stepUpPolicy).toEqual({ prompt_login: false, max_age: 30 });
    const stored = await pool.query('SELECT step_up_policy FROM identity_providers WHERE id = $1', [provider.id]);
    expect(stored.rows[0].step_up_policy).toEqual({ prompt_login: false, max_age: 30 });
    const audited = await pool.query(
      `SELECT metadata FROM audit_events WHERE action = 'identity_provider.update' AND resource_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [provider.id],
    );
    expect(audited.rows[0].metadata).toMatchObject({ step_up_policy_before: null, step_up_policy_after: { prompt_login: false, max_age: 30 } });
    const cleared = await send('PATCH', `/identity-providers/${provider.id}`, { cookie: ROOT_COOKIE, body: { stepUpPolicy: null } });
    expect(cleared.json.identityProvider.stepUpPolicy).toBeNull();
    // A PATCH that does not mention the policy leaves it alone.
    await send('PATCH', `/identity-providers/${provider.id}`, { cookie: ROOT_COOKIE, body: { stepUpPolicy: { max_age: 60 } } });
    const untouched = await send('PATCH', `/identity-providers/${provider.id}`, { cookie: ROOT_COOKIE, body: { name: `Step-up ${RUN}` } });
    expect(untouched.json.identityProvider.stepUpPolicy).toEqual({ max_age: 60 });
  });

  it.each([
    [{ max_age: 1 }, 'PROVIDER_STEP_UP_MAX_AGE_INVALID'],
    [{ max_age: 9 }, 'PROVIDER_STEP_UP_MAX_AGE_INVALID'],
    [{ max_age: 301 }, 'PROVIDER_STEP_UP_MAX_AGE_INVALID'],
    [{ max_age: 30.5 }, 'PROVIDER_STEP_UP_MAX_AGE_INVALID'],
    [{ prompt_login: false, max_age: null }, 'PROVIDER_STEP_UP_ASKS_NOTHING'],
    [{ prompt_login: 'no' }, 'PROVIDER_STEP_UP_POLICY_INVALID'],
    [{ acr_values: ['x'] }, 'PROVIDER_STEP_UP_POLICY_INVALID'],
    [{ prompt: 'none' }, 'PROVIDER_STEP_UP_POLICY_INVALID'],
    [['max_age', 30], 'PROVIDER_STEP_UP_POLICY_INVALID'],
  ])('root writing %j is refused %s and nothing is stored', async (stepUpPolicy, code) => {
    const answer = await send('PATCH', `/identity-providers/${provider.id}`, { cookie: ROOT_COOKIE, body: { stepUpPolicy } });
    expect(answer.status).toBe(400);
    expect(answer.json.code).toBe(code);
    const stored = await pool.query('SELECT step_up_policy FROM identity_providers WHERE id = $1', [provider.id]);
    expect(stored.rows[0].step_up_policy).toBeNull();
  });

  it('a non-root Account cannot write the policy: the root ceiling refuses before the handler', async () => {
    const answer = await send('PATCH', `/identity-providers/${provider.id}`, {
      cookie: OWNER.cookie, body: { stepUpPolicy: { prompt_login: false, max_age: 30 } },
    });
    expect(answer.status).toBe(403);
    const stored = await pool.query('SELECT step_up_policy FROM identity_providers WHERE id = $1', [provider.id]);
    expect(stored.rows[0].step_up_policy).toBeNull();
  });

  it('the column itself refuses a non-object (the floor under the validator)', async () => {
    await expect(pool.query(`UPDATE identity_providers SET step_up_policy = '[1]'::jsonb WHERE id = $1`, [provider.id]))
      .rejects.toMatchObject({ code: '23514' });
  });
});

describe('card 72b8fb97: a refusal that cannot be recorded fails the callback', () => {
  /**
   * A REAL failed insert: a trigger on `audit_events` that raises for the
   * `auth.step_up.refused` row of ONE request id (the one under test), so no
   * other row in this run, or in any other suite, is affected. Removed when
   * the vector ends, pass or fail.
   */
  async function withRefusalAuditBroken<T>(requestIds: string[], body: () => Promise<T>): Promise<T> {
    const name = `rh_test_break_refusal_audit_${RUN}`;
    const ids = requestIds.map((id) => `'${id.replace(/[^0-9a-f-]/gi, '')}'`).join(', ');
    await pool.query(`CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.action = 'auth.step_up.refused' AND NEW.metadata->>'request_id' IN (${ids}) THEN
          RAISE EXCEPTION 'refusal audit insert broken by the 72b8fb97 vector';
        END IF;
        RETURN NEW;
      END $fn$`);
    await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try {
      return await body();
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${name} ON audit_events`);
      await pool.query(`DROP FUNCTION IF EXISTS ${name}()`);
    }
  }

  it('a stale auth_time whose refusal row cannot be written: the callback FAILS (500 / refused landing), the row stays refused, nothing is collectable', async () => {
    const target = crypto.randomUUID();
    const started = await startStepUp(OWNER, 'warrant.create', target);
    const browser = await startStepUp(OWNER, 'warrant.create', target);
    const stale = Math.floor(await requestedAtSeconds(started.requestId)) - 120;
    const code = await providerAnswers(started, OWNER.subject!, stale);
    const browserCode = await providerAnswers(browser, OWNER.subject!, stale);
    // Review r1 change 1: what the server logs for this failure, captured.
    const logged: string[] = [];
    const errorSpy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    let answer: Answer;
    let landed: Answer;
    try {
      [answer, landed] = await withRefusalAuditBroken([started.requestId, browser.requestId], async () => [
        await send('GET', callbackPath(started.state, code), { cookie: started.stateCookie }),
        await send('GET', callbackPath(browser.state, browserCode), { cookie: browser.stateCookie, accept: 'text/html' }),
      ]);
    } finally {
      errorSpy.mockRestore();
    }
    // The act fails: not the named refusal (which would claim an audited
    // refusal), but the generic step-up failure with an error id.
    expect(answer.status).toBe(500);
    expect(answer.json.code).toBe('SSO_STEP_UP_FAILED');
    expect(typeof answer.json.errorId).toBe('string');
    // Card 72b8fb97, review r1 change 1: the insert's own failure (not the
    // wrapper) and the original refusal are both logged under the ONE id
    // the 500 returned, so an operator holding the answer finds both.
    const underId = logged.filter((line) => line.includes(`id=${answer.json.errorId}]`));
    expect(underId).toHaveLength(2);
    const [insertLine, refusalLine] = underId;
    expect(insertLine.startsWith('[SSO] step-up refusal could not be recorded:')).toBe(true);
    expect(insertLine).not.toContain('class=StepUpRefusalAuditError');
    expect(insertLine).not.toContain('class=SsoStepUpCallbackError');
    expect(refusalLine.startsWith('[SSO] the unrecorded step-up refusal was:')).toBe(true);
    expect(refusalLine).toContain('class=IdTokenError');
    expect(landed.status).toBe(302);
    expect(landed.location).toBe(`/dashboard/?step_up=refused&request=${browser.requestId}&code=SSO_STEP_UP_FAILED`);
    for (const requestId of [started.requestId, browser.requestId]) {
      expect(await stepUpAudit('auth.step_up.refused', requestId)).toEqual([]);
      expect(await stepUpAudit('auth.step_up.reauthenticated', requestId)).toEqual([]);
      const row = await pool.query('SELECT consumed_outcome, step_up_proven_at FROM sso_authentication_requests WHERE id = $1', [requestId]);
      expect(row.rows[0]).toEqual({ consumed_outcome: 'step_up_refused', step_up_proven_at: null });
      // The refusal still fails closed: the row can never be collected.
      const collect = await send('POST', '/auth/step-up/collect', { cookie: OWNER.cookie, body: { requestId } });
      expect([collect.status, collect.json.code]).toEqual([400, 'STEP_UP_REFUSED']);
    }
    expect(await tokensFor(OWNER.principalId, 'warrant.create', target)).toEqual([]);
  });

  it('a provider decline whose refusal row cannot be written fails the callback the same way', async () => {
    const started = await startStepUp(OWNER, 'credential.reveal', crypto.randomUUID());
    const answer = await withRefusalAuditBroken([started.requestId], () =>
      send('GET', errorCallbackPath(started.state, 'login_required'), { cookie: started.stateCookie }));
    expect([answer.status, answer.json.code]).toEqual([500, 'SSO_STEP_UP_FAILED']);
    expect(await stepUpAudit('auth.step_up.refused', started.requestId)).toEqual([]);
    const collect = await send('POST', '/auth/step-up/collect', { cookie: OWNER.cookie, body: { requestId: started.requestId } });
    expect(collect.json.code).toBe('STEP_UP_REFUSED');
  });

  it('with the audit table healthy again, the same refusal is the named one and is recorded (the control)', async () => {
    const started = await startStepUp(OWNER, 'credential.reveal', crypto.randomUUID());
    const answer = await send('GET', errorCallbackPath(started.state, 'login_required'), { cookie: started.stateCookie });
    expect([answer.status, answer.json.code]).toEqual([400, 'SSO_STEP_UP_PROVIDER_DECLINED']);
    expect(await stepUpAudit('auth.step_up.refused', started.requestId)).toHaveLength(1);
  });
});

describe('card 72b8fb97: credential reveal without a token answers the challenge', () => {
  /** A Connector under `owner` with one api_key credential: the reveal target. */
  async function credentialUnder(owner: Caller): Promise<string> {
    const connector = await pool.query(
      `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id) VALUES ('service', $1, $1, 'active', $2) RETURNING id`,
      [`reveal-target-${tag()}`, owner.principalId],
    );
    const credential = await pool.query(
      `INSERT INTO principal_credentials (principal_id, credential_type, secret_hash, scopes) VALUES ($1, 'api_key', $2, '["tasks:read"]'::jsonb) RETURNING id`,
      [connector.rows[0].id, crypto.randomBytes(32).toString('hex')],
    );
    return String(credential.rows[0].id);
  }

  it.each([
    ['the Identity-provider-only owner', () => OWNER, ['sso']],
    ['an Account with a password credential', () => PASSWORD_HOLDER, ['password']],
  ])('%s: 403 STEP_UP_REQUIRED carries stepUp for (credential.reveal, the id) and the caller\'s own methods', async (_label, who, methods) => {
    const caller = (who as () => Caller)();
    const credentialId = await credentialUnder(caller);
    const answer = await send('POST', `/credentials/${credentialId}/reveal`, { cookie: caller.cookie, body: {} });
    expect([answer.status, answer.json.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    expect(answer.json.stepUp).toEqual({
      error: 'insufficient_user_authentication', action: 'credential.reveal', targetId: credentialId, max_age: 0, methods,
    });
    // Nothing was revealed, and the refusal is in the ledger.
    expect((await pool.query('SELECT reveal_count FROM principal_credentials WHERE id = $1', [credentialId])).rows[0].reveal_count).toBe(0);
    const denied = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events WHERE action = 'credential.reveal' AND outcome = 'denied' AND resource_id = $1`,
      [credentialId],
    );
    expect(denied.rows[0].n).toBe(1);
  });

  it('a credential outside the caller\'s subtree stays concealed: 404, no challenge', async () => {
    const foreign = await credentialUnder(OTHER);
    const answer = await send('POST', `/credentials/${foreign}/reveal`, { cookie: OWNER.cookie, body: {} });
    expect([answer.status, answer.json.code]).toEqual([404, 'CREDENTIAL_NOT_FOUND']);
    expect(answer.json.stepUp).toBeUndefined();
  });
});

describe('the password arm is unchanged', () => {
  it('an Account with a password credential steps up by password, method password, and is offered password', async () => {
    const methods = await send('GET', '/auth/step-up/methods', { cookie: PASSWORD_HOLDER.cookie });
    expect(methods.json).toEqual({ success: true, methods: ['password'], preferred: 'password' });
    const target = crypto.randomUUID();
    const answer = await send('POST', '/auth/step-up', {
      cookie: PASSWORD_HOLDER.cookie, body: { password: 'correct horse battery staple', action: 'credential.reveal', targetId: target },
    });
    expect(answer.status).toBe(200);
    expect(Object.keys(answer.json).sort()).toEqual(['expiresAt', 'stepUpToken', 'success']);
    expect(await tokensFor(PASSWORD_HOLDER.principalId, 'credential.reveal', target)).toEqual([{ method: 'password', consumed_at: null }]);
    const wrong = await send('POST', '/auth/step-up', {
      cookie: PASSWORD_HOLDER.cookie, body: { password: 'not the password', action: 'credential.reveal', targetId: target },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.json.message).toBe('Invalid password');
  });
});
