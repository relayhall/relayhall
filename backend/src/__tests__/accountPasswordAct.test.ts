/**
 * THE PASSWORD ACT (card bc5cd9f0).
 *
 * BETA-SMOKE created a second human Account on a fresh install with SSO off and
 * found no shipped way to let that person sign in: the Identities row offered
 * only "Disable", the CLI had no verb, `relayhall invitation mint` needs an
 * Identity provider a fresh install does not have, and the one-time first-run
 * act closes after the first administrator. `PUT /principals/:id/password`
 * existed and worked; nothing called it.
 *
 * ── WHAT THIS SUITE MEASURES ──
 *
 * Not "the route answers 200". The thing that was missing is a PERSON GETTING
 * IN, so the acceptance arm sets a password through the production router and
 * then SIGNS THAT ACCOUNT IN at `POST /auth/session`, on a second caller shape,
 * and reads their own identity back. Every step is the shipped code path.
 *
 * The rest of the file measures the authority the surface put in front of that
 * route, because a way in is exactly the thing that must not be reachable by
 * the wrong caller: non-escalation in BOTH directions (a refusal alone would
 * pass on a route that refuses everybody), a bearer credential refused even
 * when it carries the sentinel, the break-glass identity refused, and the
 * promise the response makes about existing sessions actually kept.
 *
 * ── THE DESTRUCTIVE CONTRACT, STATED ──
 *
 * This suite WRITES to principals, principal_credentials, auth_sessions and
 * audit_events. It refuses any URL naming a deployment database and any
 * non-local host. Bring a disposable database up with `database/init.sql` and
 * `npm run migrate`, and throw it away afterwards.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error(
    'RELAYHALL_TEST_DB_URL is not set. This gate measures whether a person can actually SIGN IN after an '
    + 'administrator sets their password, and who may perform that act. Both are properties of stored rows and of '
    + 'the login path, and it refuses to skip. Create a disposable database, load database/init.sql, run '
    + 'npm run migrate, and point RELAYHALL_TEST_DB_URL at it.',
  );
}

const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = parsed.pathname.replace(/^\//, '');
const FORBIDDEN_DATABASES = ['relayhall_dev', 'relayhall_tst', 'relayhall_prod', 'relayhall'];
if (FORBIDDEN_DATABASES.includes(TEST_DB_NAME)) {
  throw new Error(`RELAYHALL_TEST_DB_URL names a deployment database (${TEST_DB_NAME}). This suite writes; point it at a disposable database.`);
}

process.env.DB_HOST = parsed.hostname;
process.env.DB_PORT = parsed.port || '5432';
process.env.DB_NAME = TEST_DB_NAME;
process.env.DB_USER = decodeURIComponent(parsed.username);
process.env.DB_PASSWORD = decodeURIComponent(parsed.password);
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'password-act-suite-secret-0123456789abcdef';
// The per-Account login lives behind the session plane flag. It is a deployment
// switch, so the suite turns it on for itself rather than depending on how the
// machine that runs it happens to be configured.
process.env.RELAYHALL_SESSIONS = 'on';

const express = require('express');

const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { principalService } = require('../services/PrincipalService');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { loginThrottle } = require('../middleware/loginRateLimit');
const { MIN_PASSWORD_LENGTH } = require('../services/AccountPasswordService');
const { administratorSessionOf, PASSWORD_ACT } = require('../utils/administratorSession');
const { resolveActorRole } = require('../utils/taskAutomationRole');
const authRoutes = require('../routes/auth').default;

jest.setTimeout(180_000);

let server: http.Server;
let origin: string;

/**
 * The app `server.ts` builds, for the two mounts this suite needs: `/auth` is
 * public by construction (it is how a session is obtained at all) and
 * everything else rides the guard chain.
 */
function buildApp(): any {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  app.use('/auth', authRoutes);
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  return app;
}

interface Answer { status: number; json: any; setCookie: string | null }
interface Caller { label: string; principalId: string; headers: Record<string, string> }

async function call(who: Caller | null, method: string, routePath: string, body?: unknown): Promise<Answer> {
  const response = await fetch(`${origin}${routePath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(who?.headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, setCookie: response.headers.get('set-cookie') };
}

/**
 * SIGN IN, WITHOUT RACING THIS SUITE'S OWN FAILED ATTEMPTS.
 *
 * `loginThrottle` is a module singleton keyed on the socket address, and every
 * request here arrives from the loopback address — so the suite's DELIBERATE
 * 401s (the wrong-password control, the Member whose password was never set)
 * accumulate in the same bucket as the sign-ins that must SUCCEED. Run slowly
 * the gap hid it; run fast the backoff fires, and `and the password it tried to
 * clear is still there` collects a 429 where it expects a 200. A suite whose
 * result depends on how fast the machine is is a suite that reports a different
 * answer every run.
 *
 * That is this file's fragility and not the product's: throttling repeated
 * failed logins from one address is precisely what that middleware is for, and
 * nothing here should weaken it. So the bucket is cleared through the throttle's
 * OWN public method before each attempt — not by widening the window, not by
 * mocking the clock, and not by adding a test-only export to a production
 * module. Every key the loopback can present is cleared, because which of the
 * three `req.socket.remoteAddress` reports depends on how the stack bound.
 */
const LOOPBACK_KEYS = ['127.0.0.1', '::ffff:127.0.0.1', '::1'];

async function signIn(account: string, password: string): Promise<Answer> {
  for (const key of LOOPBACK_KEYS) loginThrottle.recordSuccess(key);
  return call(null, 'POST', '/auth/session', { account, password });
}

const tag = (): string => crypto.randomBytes(5).toString('hex');
/** Long enough to satisfy the policy the SERVER owns, read from the server. */
const goodPassword = (): string => `Fixb-${crypto.randomBytes(12).toString('hex')}`;

async function makeAccount(role: string | null, options: { handle?: string } = {}): Promise<{ id: string; handle: string }> {
  const handle = options.handle ?? `pw-${role ?? 'none'}-${tag()}`;
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $2, 'active', $3) RETURNING id`,
    [handle, `password act ${handle}`, role],
  );
  return { id: String(result.rows[0].id), handle };
}

async function sessionFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

/**
 * A BEARER CREDENTIAL THAT REACHES THE HANDLER.
 *
 * It holds `principals:admin` — the scope the route itself is mapped to — under
 * an Account whose role derives `root`, so it passes authentication and passes
 * the route's scope gate and arrives at the act's own guard. That is the only
 * arrangement in which "this act refuses bearer credentials" is observable: a
 * credential refused earlier proves the scope map works, not this.
 *
 * IT DOES NOT CARRY `root`, AND NO BEARER CREDENTIAL ON THIS BUILD CAN —
 * measured, not assumed, in the arm at the bottom of this block. That matters
 * for how the change beside it is described: replacing `requireManageAuthority`
 * with the administrator-session predicate closes no hole a caller can walk
 * through today, because the gate it replaced demanded a scope no bearer can
 * present. What it does is stop the act depending on that being true. The rule
 * AZ-18 states is about the KIND of credential, and a gate that expresses it as
 * "must hold root" is a gate that silently reopens the moment root becomes
 * mintable, delegable or legacy-reachable again.
 */
async function bearerReachingTheHandler(): Promise<Caller> {
  const accountId = (await makeAccount('admin')).id;
  const handle = `pw-connector-${tag()}`;
  const principal = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, $2, 'active', $3, $4, $5::jsonb) RETURNING id`,
    [handle, 'password act connector', accountId, 'password act connector',
      JSON.stringify({ scopes: 'parent', objects: 'parent' })],
  );
  const principalId = String(principal.rows[0].id);
  const issued = await principalService.issueCredential(
    { principalId, scopes: ['principals:read', 'principals:admin'], transport: 'any' },
    { handle: 'password-act-suite', authMethod: 'system' },
  );
  return { label: 'bearer credential', principalId, headers: { Authorization: `Bearer ${issued.fullKey}` } };
}

async function deniedPasswordRows(): Promise<any[]> {
  const result = await pool.query(
    `SELECT metadata FROM audit_events
      WHERE action = 'credential.password.set' AND outcome = 'denied'
      ORDER BY occurred_at DESC LIMIT 30`,
  );
  return result.rows;
}

let ADMIN: Caller;
let OPERATOR: Caller;
let MEMBER: Caller;

beforeAll(async () => {
  await new Promise<void>((resolve) => { server = buildApp().listen(0, resolve); });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  ADMIN = await sessionFor('admin session', (await makeAccount('admin')).id);
  OPERATOR = await sessionFor('operator session', (await makeAccount('operator')).id);
  MEMBER = await sessionFor('member session', (await makeAccount('user')).id);
});

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('THE ACCEPTANCE — a second person can be let in (card bc5cd9f0)', () => {
  it('an administrator sets a password and that Account signs in with it', async () => {
    const grace = await makeAccount('user');
    const password = goodPassword();

    const set = await call(ADMIN, 'PUT', `/principals/${grace.id}/password`, { password });
    expect(set.status).toBe(200);
    expect(set.json.success).toBe(true);

    // The whole point of the card: this person can now get in. Measured through
    // the shipped login path, not by re-reading the row that was written.
    const signedIn = await signIn(grace.handle, password);
    expect(signedIn.status).toBe(200);
    expect(signedIn.setCookie).toContain(SESSION_COOKIE_NAME);

    const cookie = String(signedIn.setCookie).split(';')[0];
    const asGrace: Caller = { label: 'grace', principalId: grace.id, headers: { Cookie: cookie } };
    const me = await call(asGrace, 'GET', '/principals/me');
    expect(me.status).toBe(200);
    expect(me.json.principal.handle).toBe(grace.handle);
  });

  it('NEGATIVE CONTROL: the wrong password does not sign in', async () => {
    // Without this, the arm above is satisfied by a login route that admits
    // anybody — the sign-in would succeed for the wrong reason and prove
    // nothing about the password that was set.
    const grace = await makeAccount('user');
    await call(ADMIN, 'PUT', `/principals/${grace.id}/password`, { password: goodPassword() });
    const refused = await signIn(grace.handle, goodPassword());
    expect(refused.status).toBe(401);
  });

  it('the board still owns the password policy, and refuses by name', async () => {
    // The surfaces state no policy of their own (there is no length check in
    // the panel or the CLI) precisely because this refusal exists and says what
    // is wrong. If it stopped saying so, those surfaces would go silent.
    const grace = await makeAccount('user');
    const answer = await call(ADMIN, 'PUT', `/principals/${grace.id}/password`, { password: 'a'.repeat(MIN_PASSWORD_LENGTH - 1) });
    expect(answer.status).toBe(422);
    expect(answer.json.code).toBe('PASSWORD_TOO_SHORT');
  });
});

describe('NON-ESCALATION — an issuer reaches no further than its own authority', () => {
  it('an operator may set a Member password but not an administrator one', async () => {
    const member = await makeAccount('user');
    const allowed = await call(OPERATOR, 'PUT', `/principals/${member.id}/password`, { password: goodPassword() });
    expect(allowed.status).toBe(200);

    const elevated = await makeAccount('admin');
    const refused = await call(OPERATOR, 'PUT', `/principals/${elevated.id}/password`, { password: goodPassword() });
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe('PASSWORD_ABOVE_YOUR_AUTHORITY');
  });

  it('MIRROR: an administrator may do the thing the operator was refused', async () => {
    // The pair is the measurement. A refusal on its own is satisfied by a route
    // that refuses everyone, which is the failure mode a "cannot escalate" test
    // is most likely to hide.
    const elevated = await makeAccount('admin');
    const allowed = await call(ADMIN, 'PUT', `/principals/${elevated.id}/password`, { password: goodPassword() });
    expect(allowed.status).toBe(200);
  });

  it('an ordinary Member reaches nobody, and nothing is written', async () => {
    // The refusal arrives from the SCOPE MAP, before the act's own guard: this
    // route is mapped to `principals:admin`, and `scopesForRole` withholds every
    // `*:admin` family from `user`. So the assertion is on the OUTCOME rather
    // than on a code the caller never gets far enough to receive — and the
    // outcome is the one that matters: no password was set.
    const someone = await makeAccount('user');
    const password = goodPassword();
    const refused = await call(MEMBER, 'PUT', `/principals/${someone.id}/password`, { password });
    expect(refused.status).toBe(403);
    const signedIn = await signIn(someone.handle, password);
    expect(signedIn.status).toBe(401);
  });

  it('and where the act’s OWN administrator refusal is reachable, it is named', async () => {
    // Every session that clears the scope gate above is already an
    // administrator, so `PASSWORD_ACT_REQUIRES_ADMINISTRATOR` cannot be
    // provoked through the route on this build. That is a property of today's
    // scope map, not of the act, and the act must still carry its own name for
    // the day the map changes. Measured at the predicate, which is where this
    // particular fact lives; the SEAM's behaviour is measured above and
    // throughout, so this is not a direct-module probe standing in for one.
    const outcome = administratorSessionOf(
      { authMethod: 'session', handle: 'someone', principalRole: 'viewer', sessionRole: null },
      resolveActorRole, PASSWORD_ACT,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('PASSWORD_ACT_REQUIRES_ADMINISTRATOR');
    expect(outcome.message).toContain("Setting another Account's password requires an administrator session");
  });

  it('the break-glass local administrator is refused, so the way back in stays', async () => {
    const local = await makeAccount('admin', { handle: 'dashboard_user' })
      .catch(async () => {
        const row = await pool.query(`SELECT id FROM principals WHERE handle = 'dashboard_user'`);
        return { id: String(row.rows[0].id), handle: 'dashboard_user' };
      });
    const refused = await call(ADMIN, 'PUT', `/principals/${local.id}/password`, { password: goodPassword() });
    expect(refused.status).toBe(422);
    expect(refused.json.code).toBe('LOCAL_ADMINISTRATOR_PASSWORD_FIXED');
  });

  it('every refusal leaves a durable denied ledger row naming the seam', async () => {
    const elevated = await makeAccount('admin');
    await call(OPERATOR, 'PUT', `/principals/${elevated.id}/password`, { password: goodPassword() });
    const rows = await deniedPasswordRows();
    const mine = rows.filter((row) => row.metadata?.refusal === 'PASSWORD_ABOVE_YOUR_AUTHORITY');
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0].metadata.seam).toBe('principals/:id/password');
  });
});

describe('NEVER A BEARER CREDENTIAL — on either verb (AZ-18)', () => {
  let machine: Caller;
  let victim: { id: string; handle: string };

  beforeAll(async () => {
    machine = await bearerReachingTheHandler();
    victim = await makeAccount('user');
  });

  it('NEGATIVE CONTROL: the credential is live and holds the route’s own scope', async () => {
    // Without this, every refusal below is satisfied by a credential that
    // simply does not authenticate or is stopped by the scope map, and the
    // claim "the ACT is refused" would be measuring something else entirely.
    const me = await call(machine, 'GET', '/principals/me');
    expect(me.status).toBe(200);
    expect(me.json.scopes).toContain('principals:admin');
  });

  it('setting a password is refused BY NAME, not by a generic gate', async () => {
    const refused = await call(machine, 'PUT', `/principals/${victim.id}/password`, { password: goodPassword() });
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe('PASSWORD_ACT_REQUIRES_SESSION');
    // The distinction is the whole repair: before, this caller collected an
    // unnamed FORBIDDEN from a gate asking about SCOPES, and the ledger learned
    // nothing. The act now refuses it for what it is.
    expect(refused.json.code).not.toBe('FORBIDDEN');
  });

  it('CLEARING a password is refused by the same rule', async () => {
    // The verb that would have been left behind is the bigger hole: a machine
    // credential unable to set a password but able to clear every one of them
    // could lock every human out of a board it cannot itself sign in to.
    const refused = await call(machine, 'DELETE', `/principals/${victim.id}/password`);
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe('PASSWORD_ACT_REQUIRES_SESSION');
  });

  it('and the password it tried to clear is still there', async () => {
    // The refusal is measured by its EFFECT, not only by its status line.
    const password = goodPassword();
    await call(ADMIN, 'PUT', `/principals/${victim.id}/password`, { password });
    await call(machine, 'DELETE', `/principals/${victim.id}/password`);
    const stillWorks = await signIn(victim.handle, password);
    expect(stillWorks.status).toBe(200);
  });

  it('the refusal is audited, so a machine trying this is not invisible', async () => {
    await call(machine, 'PUT', `/principals/${victim.id}/password`, { password: goodPassword() });
    const rows = await deniedPasswordRows();
    expect(rows.some((row) => row.metadata?.refusal === 'PASSWORD_ACT_REQUIRES_SESSION')).toBe(true);
  });

  it('a PARENTED chain never presents `root`, whatever its credential row says', async () => {
    // WHAT THIS PROVES, AND WHAT IT DOES NOT (round-1 verdict `7cce6577`).
    //
    // It proves one arm: `DelegationService.effectiveScopes` deletes `root` from
    // every PARENTED chain (rule 2), so writing the sentinel onto a Connector's
    // credential row changes nothing about what it presents.
    //
    // An earlier version of this test claimed the universal — that NO bearer on
    // this build can present `root`, and therefore that replacing
    // `resolveIssuerAuthority` closed nothing a caller could walk through. That
    // claim was wrong and the review was right to say so. AUTHZ §10 keeps
    // pre-096 legacy identities working: `PrincipalService` authenticates them
    // by a SUFFIX hash, `middleware/auth` preserves their stored scopes, and
    // `DelegationService.effectiveScopes` returns a parentless or legacy chain's
    // scopes UNCHANGED — while migration `070` mapped old `admin` scopes onto
    // `root` and `096` marked pre-existing key-bearing parentless principals as
    // legacy. A true pre-096 root bearer is a shape that contract still admits,
    // and the probe that appeared to rule it out had only converted a
    // full-token-hashed credential, so its 401 came from the hash-algorithm
    // switch rather than from the shape being unreachable.
    //
    // Which makes the guard on the password act MORE important, not less: a gate
    // spelled "must hold root" would admit exactly that caller, and the
    // administrator-session predicate refuses it for what it is.
    const forced = await pool.query(
      `UPDATE principal_credentials pc SET scopes = '["root"]'::jsonb
        WHERE pc.principal_id = $1 AND pc.revoked_at IS NULL RETURNING pc.id`,
      [machine.principalId],
    );
    expect(forced.rowCount).toBeGreaterThan(0);
    const me = await call(machine, 'GET', '/principals/me');
    expect(me.status).toBe(200);
    // Written on the credential row; stripped on the way out of the chain.
    expect(me.json.scopes).not.toContain('root');
    expect(me.json.scopes).toEqual([]);
    // And with nothing left to reach with, nothing left to delegate either —
    // the B3 rule, seen from the other side.
    expect(me.json.delegableScopes).toEqual([]);
  });
});

describe('WHAT IT DOES NOT DO — existing sessions', () => {
  it('says sessions are not revoked, and they are not', async () => {
    // `auth_sessions` enumerates its revoke reasons in migration 062:70 and
    // none of them means "the password changed", so this act does not revoke.
    // The response says so; this measures that the sentence is true, because a
    // promise about security behaviour that nothing checks is just a sentence.
    const grace = await makeAccount('user');
    const before = await sessionFor('grace before', grace.id);
    expect((await call(before, 'GET', '/principals/me')).status).toBe(200);

    const set = await call(ADMIN, 'PUT', `/principals/${grace.id}/password`, { password: goodPassword() });
    expect(set.json.sessionsRevoked).toBe(false);
    expect(String(set.json.note)).toMatch(/stay signed in/);

    expect((await call(before, 'GET', '/principals/me')).status).toBe(200);
  });
});
