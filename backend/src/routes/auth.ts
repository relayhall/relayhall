import { logCaughtFailure } from '../utils/secretSafeLog';
import { stepUpService } from '../services/StepUpService';
import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../config/secrets';
import { verifyActiveDashboardToken } from '../utils/dashboardToken';
import { loginThrottle, loginClientKey } from '../middleware/loginRateLimit';
import { principalService, Principal } from '../services/PrincipalService';
import { auditService } from '../services/AuditService';
import { accountPasswordService } from '../services/AccountPasswordService';
import {
  SESSION_COOKIE_NAME,
  loginSessionService,
  sessionAbsoluteMs,
} from '../services/LoginSessionService';
import { DEFAULT_LOCAL_ADMINISTRATOR_HANDLE, localAdministratorHandle } from '../config/localAdministrator';
import { isFlagOn, FLAG_SESSIONS } from '../utils/featureFlags';
import { firstRunService, FirstRunError } from '../services/FirstRunService';
import { validateNewHandle } from '../utils/credentialAuthority';
import { readCookie } from '../utils/cookies';
import { createSsoRouter } from './sso';

const router = Router();


const JWT_SECRET = getJwtSecret();
const PASSWORD_HASH = process.env.DASHBOARD_PASSWORD_HASH || '';
const TOKEN_EXPIRY: string = process.env.TOKEN_EXPIRY || '30d'; // 30d dashboard session; automation should use RELAYHALL_API_KEY
/** Upper bound on the principal lookup during login — see the call site. */
const LOGIN_PRINCIPAL_LOOKUP_TIMEOUT_MS = 1500;

/**
 * Capability cookie for browser subresource loads. An <iframe src> or <img src>
 * cannot carry an Authorization header, so plugin frames and dashboard media
 * need a cookie — but it must not be the dashboard JWT. This token carries no
 * userId and authorises nothing except those specific read routes.
 *
 * Path is '/' because the public API prefix differs per environment (/api in
 * production, /api/dev in dev) and the backend cannot observe it — nginx strips
 * it. A broad path is safe precisely because the token confers no authority
 * anywhere else. SameSite=Lax keeps it on same-origin iframe loads.
 */
const BROWSER_ACCESS_COOKIE = 'nim_browser_access';
const BROWSER_ACCESS_SCOPE = 'browser-access';
const BROWSER_ACCESS_EXPIRY = '12h';
const BROWSER_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 12 * 60 * 60 * 1000,
};

/**
 * Clearing a cookie must not repeat its `maxAge`: Express deprecates that
 * combination and ignores the option anyway, so the clear carries only the
 * attributes a browser matches on.
 */
const CLEAR_BROWSER_COOKIE_OPTIONS = {
  httpOnly: BROWSER_COOKIE_OPTIONS.httpOnly,
  secure: BROWSER_COOKIE_OPTIONS.secure,
  sameSite: BROWSER_COOKIE_OPTIONS.sameSite,
  path: BROWSER_COOKIE_OPTIONS.path,
};

/**
 * The login-session cookie (SS-W1). httpOnly so no script can read it,
 * SameSite=Lax so a cross-site form post cannot carry it into a state-changing
 * route, and `secure` on the same terms as the capability cookie beside it.
 */
const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
};

/**
 * The cookie now names the principal that minted it (`sub`). It still confers
 * no authority — the scope claim keeps it out of the identity paths — but an
 * identity-free capability could not be revoked: disabling a principal left
 * this cookie serving the plugin proxy and dashboard media for its full 12h,
 * and that is the branch a browser actually takes (<img>/<iframe> cannot send
 * an Authorization header). Naming the principal makes the kill switch reach
 * it.
 *
 * A sub-less cookie is no longer just a historical artefact OR the normal
 * legacy case: the verifier resolves the principal for legacy {userId}
 * payloads too, so a cookie carries a sub whenever the principal is
 * resolvable at all. It is omitted only when the lookup finds nothing or
 * times out — and those cookies, like genuinely pre-change ones, stay
 * accepted until they expire, the same 12h bound as before.
 */
function issueBrowserAccessCookie(res: Response, principalId?: string | null): void {
  const token = (jwt.sign as any)(
    principalId
      ? { scope: BROWSER_ACCESS_SCOPE, sub: principalId }
      : { scope: BROWSER_ACCESS_SCOPE },
    JWT_SECRET,
    { expiresIn: BROWSER_ACCESS_EXPIRY }
  );
  res.cookie(BROWSER_ACCESS_COOKIE, token, BROWSER_COOKIE_OPTIONS);
}

if (!PASSWORD_HASH) {
  console.warn('⚠️  WARNING: DASHBOARD_PASSWORD_HASH not set in environment variables!');
}

/**
 * Who is calling one of the authenticated `/auth` routes.
 *
 * The `/auth` mount is public, so `authMiddleware` never runs here and every
 * handler that touches a person's authority resolves the identity itself —
 * the pattern `POST /auth/step-up` and C6's consent endpoints already use.
 * A login session is preferred; a dashboard JWT still counts because it is
 * the break-glass door's credential. An `rh_` bearer credential is refused
 * outright: session acts are session acts (AZ-18).
 */
interface CallingAccount {
  principal: Principal;
  /** The live session's id when the caller arrived through one. */
  sessionId: string | null;
}

async function resolveCallingAccount(req: Request): Promise<CallingAccount | null> {
  if (isFlagOn(FLAG_SESSIONS)) {
    const sessionToken = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
    if (sessionToken) {
      const session = await loginSessionService.resolve(sessionToken);
      if (session) {
        const principal = await principalService.getPrincipalById(session.principalId);
        if (principal && principal.status === 'active') {
          return { principal, sessionId: session.sessionId };
        }
      }
    }
  }
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ') && !header.startsWith('Bearer rh_')) {
    try {
      const decoded = await verifyActiveDashboardToken(header.substring(7));
      const principal = decoded.principalId
        ? await principalService.getPrincipalById(decoded.principalId)
        : await principalService.getPrincipalByHandle(decoded.userId);
      if (principal && principal.status === 'active') {
        return { principal, sessionId: null };
      }
    } catch {
      return null;
    }
  }
  return null;
}

// POST /api/auth/login — the stable local-administrator break-glass path.
// It deliberately has no OIDC dependency. A successful invocation is written
// to the indefinite audit ledger before the credential is returned.
//
// SS-W1 narrows WHO it authenticates — the named local administrator Account
// (design d95136d7 §8.5) — and changes nothing else: same body, same throttle
// before bcrypt, same audit action before the credential is returned, same
// response contract. It is the lockout escape hatch, so it deliberately does
// NOT depend on the session substrate or on a credential row.
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  try {
    const { password } = req.body;

    // Throttle BEFORE bcrypt: the compare runs on the libuv threadpool, so an
    // unthrottled flood starves every other filesystem read in the process.
    const clientKey = loginClientKey(req);
    const decision = loginThrottle.check(clientKey);
    if (!decision.allowed) {
      console.warn(`Login throttled for ${clientKey}; retry in ${decision.retryAfterSeconds}s`);
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      res.status(429).json({
        error: 'Too Many Requests',
        message: `Too many failed attempts. Retry in ${decision.retryAfterSeconds}s.`,
      });
      return;
    }

    if (!password) {
      res.status(400).json({ error: 'Bad Request', message: 'Password is required' });
      return;
    }

    // Verify password against bcrypt hash
    const isValid = await bcrypt.compare(password, PASSWORD_HASH);

    if (!isValid) {
      loginThrottle.recordFailure(clientKey);
      console.warn(`Failed login attempt from ${clientKey}`);
      res.status(401).json({ error: 'Unauthorized', message: 'Invalid password' });
      return;
    }

    loginThrottle.recordSuccess(clientKey);

    // Generate JWT token. v2 payload names the principal (spec b48bb799
    // §2.2); the response contract and TOKEN_EXPIRY are unchanged, and old
    // tokens verify via the legacy branch until natural expiry. If the
    // principal cannot be resolved (pre-migration DB, lookup error) mint the
    // legacy shape — login must never depend on the identity substrate.
    //
    // The timeout matters as much as the error handling (R11): login was
    // DB-free before this lookup existed, and a DB that accepts connections
    // but never answers — lock pileup, half-open socket — would otherwise hang
    // the owner's only way in. Errors and timeouts both fall through to the
    // legacy mint.
    const configured = localAdministratorHandle();
    const resolved = await Promise.race([
      principalService.getPrincipalByHandle(configured),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), LOGIN_PRINCIPAL_LOOKUP_TIMEOUT_MS).unref()),
    ]);
    // A configured handle is honoured only when it names an ACTIVE Account.
    // A typo passes the shape check but resolves to nothing, and minting for
    // an unknown handle hands the owner a token that `resolveActorRole` maps
    // to `agent` and `scopesForRole` gives no scopes at all — a token that
    // authenticates and authorises nothing, which is a lockout wearing a
    // 200. Falling back to the seed also covers the outage case: when the
    // substrate cannot be read nothing resolves, and the seeded handle is the
    // one the handle switch still grants authority to without its row.
    const principal = resolved && resolved.status === 'active' ? resolved : undefined;
    const administrator = principal ? configured : DEFAULT_LOCAL_ADMINISTRATOR_HANDLE;

    // Owner ruling 60307311 §1.1: the password login is BREAK-GLASS, and a
    // break-glass door used on a deployment that has a real administrator is
    // worth saying out loud — in the ledger, and on the dashboard the token
    // opens. Under the SAME timeout and the SAME swallow as the principal
    // lookup above, and for the same reason (R11): this door must not acquire
    // a dependency on the identity substrate. Every failure arm answers
    // `false`, which announces nothing rather than announcing wrongly.
    const administratorExists = await Promise.race([
      firstRunService.administratorExists().catch(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), LOGIN_PRINCIPAL_LOOKUP_TIMEOUT_MS).unref()),
    ]);
    const payload = principal
      ? { v: 2, sub: principal.id, handle: principal.handle, kind: principal.kind }
      : { userId: administrator };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token = (jwt.sign as any)(
      payload,
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRY }
    );

    try {
      await auditService.record({
        action: 'auth.break_glass.login',
        actor: {
          principalId: principal?.id ?? null,
          handle: administrator,
          authMethod: 'local_admin',
        },
        resourceType: 'principal',
        resourceId: principal?.id ?? null,
        // `administratorExists` is what turns this row from "the owner signed
        // in" into "the break-glass door was used while an ordinary
        // administrator path existed". The ACT keeps its established spelling
        // (`auth.break_glass.login`, the ledger's only name for this event
        // since SS-W1) rather than gaining a second one for the same door:
        // one act with a discriminating field stays one query.
        metadata: { tokenExpiry: TOKEN_EXPIRY, administratorExists },
      });
    } catch {
      // Never mint an unaudited break-glass session. The local path is
      // independent of OIDC, but the control-plane database/audit ledger is a
      // deliberate fail-closed dependency.
      res.status(503).json({
        error: 'Service Unavailable',
        message: 'Local administrator login could not be recorded in the audit ledger',
      });
      return;
    }

    issueBrowserAccessCookie(res, principal?.id ?? null);
    res.json({
      success: true,
      token,
      expiresIn: TOKEN_EXPIRY,
      // The dashboard cannot otherwise tell WHICH door it came through: the
      // token is opaque to it. These two fields are what the break-glass
      // banner is rendered from, and they disclose nothing a caller holding a
      // valid deployment password does not already have.
      breakGlass: true,
      administratorExists,
    });
  } catch (error) {
    const errorId = logCaughtFailure('Login error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      code: 'LOGIN_FAILED',
      message: 'Login failed',
      errorId
    });
  }
});

/**
 * Compare a re-entered password against THIS Account's own credential.
 *
 * An Account with a password credential is checked against it. The named
 * local administrator, which may hold no credential row at all, falls back to
 * the deployment hash — the same secret its break-glass login uses — so
 * step-up keeps working on a deployment that has not yet issued per-Account
 * passwords. Every arm costs one bcrypt compare.
 */
async function passwordMatchesAccount(principal: Principal, password: string): Promise<boolean> {
  const verified = await accountPasswordService.verify(principal.handle, password);
  if (verified) return verified.principal.id === principal.id;
  if (principal.handle === localAdministratorHandle() && PASSWORD_HASH) {
    return bcrypt.compare(password, PASSWORD_HASH);
  }
  return false;
}

/** Every session route answers this while the substrate stays dormant. */
function sessionsDisabled(res: Response): void {
  res.status(404).json({
    error: 'Not Found',
    code: 'SESSIONS_DISABLED',
    message: 'Per-Account login sessions are not enabled on this deployment',
  });
}

// POST /api/auth/session — per-Account login (SS-16, design d95136d7 §8.1).
//
// The account field is what makes multi-human real: two people on one board
// hold two Accounts, two sessions and two different authorities. The response
// carries NO token — the session is delivered only as an httpOnly cookie, so
// it can never become an `Authorization: Bearer` value (AZ-18/A17.1).
router.post('/session', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!isFlagOn(FLAG_SESSIONS)) { sessionsDisabled(res); return; }
    const { account, password } = (req.body ?? {}) as Record<string, unknown>;

    // Throttled before bcrypt for the same reason the break-glass path is.
    const clientKey = loginClientKey(req);
    const decision = loginThrottle.check(clientKey);
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      res.status(429).json({
        error: 'Too Many Requests',
        message: `Too many failed attempts. Retry in ${decision.retryAfterSeconds}s.`,
      });
      return;
    }

    if (typeof account !== 'string' || !account.trim() || typeof password !== 'string' || !password) {
      res.status(400).json({ error: 'Bad Request', message: 'Account and password are required' });
      return;
    }

    const verified = await accountPasswordService.verify(account, password);
    if (!verified) {
      loginThrottle.recordFailure(clientKey);
      // One body for every failure arm: unknown Account, Account without a
      // password, and wrong password are indistinguishable to the caller.
      await auditService.record({
        action: 'auth.session.login', outcome: 'denied',
        actor: { principalId: null, handle: account.trim().toLowerCase(), authMethod: 'session' },
        resourceType: 'principal', resourceId: null,
        metadata: { refusal: 'INVALID_CREDENTIALS' },
      }).catch(() => undefined);
      res.status(401).json({ error: 'Unauthorized', message: 'Invalid account or password' });
      return;
    }

    loginThrottle.recordSuccess(clientKey);

    const minted = await loginSessionService.mint({
      principalId: verified.principal.id,
      credentialId: verified.credentialId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    try {
      await auditService.record({
        action: 'auth.session.login',
        actor: {
          principalId: verified.principal.id,
          handle: verified.principal.handle,
          authMethod: 'session',
          credentialId: verified.credentialId,
        },
        resourceType: 'principal',
        resourceId: verified.principal.id,
        metadata: { sessionId: minted.sessionId },
      });
    } catch {
      // A session that reached no ledger is revoked rather than returned —
      // the same fail-closed rule the break-glass path applies.
      await loginSessionService.revoke(minted.sessionId, 'admin').catch(() => undefined);
      res.status(503).json({
        error: 'Service Unavailable',
        message: 'Login could not be recorded in the audit ledger',
      });
      return;
    }

    res.cookie(SESSION_COOKIE_NAME, minted.token, {
      ...SESSION_COOKIE_OPTIONS,
      maxAge: sessionAbsoluteMs(),
    });
    // The dashboard's <img>/<iframe> loads need the capability cookie too;
    // without it a session login would render a board with no media.
    issueBrowserAccessCookie(res, verified.principal.id);
    res.json({
      success: true,
      expiresAt: minted.expiresAt.toISOString(),
      principal: {
        handle: verified.principal.handle,
        displayName: verified.principal.displayName ?? null,
      },
    });
  } catch (error) {
    const errorId = logCaughtFailure('[Auth API] session login failed:', error);
    res.status(500).json({ error: 'Internal Server Error', code: 'SESSION_LOGIN_FAILED', message: 'Login failed', errorId });
  }
});

/**
 * POST /api/auth/first-run — create the FIRST local administrator Account
 * (owner ruling `60307311` §1.1; card `27322abb`).
 *
 * Public by necessity: it is the act for a deployment where nobody can
 * authenticate as an administrator yet, so there is no credential it could
 * ask for. Four things stand in for one:
 *
 *  1. THE STATE. It is admissible only while no administrator Account exists.
 *     The check here is the cheap one; the binding one is inside
 *     `createFirstAdministrator`, under an advisory lock in the same
 *     transaction as the INSERT, so a second caller racing the first gets a
 *     409 rather than a second administrator.
 *  2. THE THROTTLE. The same per-client throttle the two login doors use, on
 *     the same key, so a flood of first-run attempts cannot outpace them or
 *     each other.
 *  3. THE SESSION SUBSTRATE. With `RELAYHALL_SESSIONS` off there is no
 *     per-Account login door, so an Account created here could never sign in;
 *     the route answers exactly as the other session routes do.
 *  4. THE HANDLE VOCABULARY. `validateNewHandle` — the same function
 *     `POST /principals` uses — which reserves `dashboard_user` and the
 *     `agent:` prefix, so the first administrator can never shadow the
 *     break-glass identity or a spawn principal.
 *
 * On success it returns a LOGIN SESSION as an httpOnly cookie and no token, on
 * the SS-16 contract: the first administrator is signed in the moment they are
 * created, and the credential that signs them in can never become an
 * `Authorization: Bearer` value.
 */
router.post('/first-run', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!isFlagOn(FLAG_SESSIONS)) { sessionsDisabled(res); return; }

    const clientKey = loginClientKey(req);
    const decision = loginThrottle.check(clientKey);
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      res.status(429).json({
        error: 'Too Many Requests',
        message: `Too many attempts. Retry in ${decision.retryAfterSeconds}s.`,
      });
      return;
    }

    // Fail CLOSED on an unreadable substrate: a deployment whose state cannot
    // be established is not a deployment that gets a free administrator.
    let administratorExists: boolean;
    try {
      administratorExists = await firstRunService.administratorExists();
    } catch (err) {
      const errorId = logCaughtFailure('[Auth API] first-run state could not be read:', err);
      res.status(503).json({
        error: 'Service Unavailable', code: 'FIRST_RUN_UNAVAILABLE',
        message: 'The first-run state could not be established', errorId,
      });
      return;
    }
    if (administratorExists) {
      loginThrottle.recordFailure(clientKey);
      res.status(409).json({
        error: 'Conflict', code: 'FIRST_RUN_CLOSED',
        message: 'This deployment already has an administrator Account; the first-run step is closed.',
      });
      return;
    }

    const { handle, displayName, password } = (req.body ?? {}) as Record<string, unknown>;
    const handleCheck = validateNewHandle(handle);
    if (!handleCheck.ok) {
      res.status(400).json({ error: 'Bad Request', code: 'INVALID_HANDLE', message: handleCheck.error });
      return;
    }
    const name = typeof displayName === 'string' ? displayName.trim() : '';
    if (name.length > 255) {
      res.status(400).json({
        error: 'Bad Request', code: 'INVALID_DISPLAY_NAME',
        message: 'displayName must be at most 255 characters',
      });
      return;
    }

    const created = await firstRunService.createFirstAdministrator({
      handle: handleCheck.handle,
      displayName: name || null,
      password: typeof password === 'string' ? password : '',
      ip: req.ip,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    });

    const minted = await loginSessionService.mint({
      principalId: created.principal.id,
      credentialId: created.credentialId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    try {
      await auditService.record({
        action: 'auth.session.login',
        actor: {
          principalId: created.principal.id,
          handle: created.principal.handle,
          authMethod: 'session',
          credentialId: created.credentialId,
        },
        resourceType: 'principal',
        resourceId: created.principal.id,
        metadata: { sessionId: minted.sessionId, firstRun: true },
      });
    } catch {
      // Same fail-closed rule as `POST /auth/session`: a session that reached
      // no ledger is revoked rather than returned. The ADMINISTRATOR is
      // already created and already audited — that half committed
      // transactionally — so the message says so rather than implying the act
      // failed.
      await loginSessionService.revoke(minted.sessionId, 'admin').catch(() => undefined);
      res.status(503).json({
        error: 'Service Unavailable', code: 'FIRST_RUN_SESSION_UNAUDITED',
        message: 'The administrator was created, but the sign-in could not be recorded in the audit ledger. Sign in with the credentials you just set.',
      });
      return;
    }

    res.cookie(SESSION_COOKIE_NAME, minted.token, {
      ...SESSION_COOKIE_OPTIONS,
      maxAge: sessionAbsoluteMs(),
    });
    issueBrowserAccessCookie(res, created.principal.id);
    res.status(201).json({
      success: true,
      expiresAt: minted.expiresAt.toISOString(),
      principal: {
        handle: created.principal.handle,
        displayName: created.principal.displayName ?? null,
        role: created.principal.role,
      },
    });
  } catch (err) {
    if (err instanceof FirstRunError) {
      loginThrottle.recordFailure(loginClientKey(req));
      res.status(err.status).json({
        error: err.status >= 500 ? 'Service Unavailable' : err.status === 409 ? 'Conflict' : 'Unprocessable Entity',
        code: err.code,
        message: err.message,
      });
      return;
    }
    const errorId = logCaughtFailure('[Auth API] first-run failed:', err);
    res.status(500).json({
      error: 'Internal Server Error', code: 'FIRST_RUN_FAILED',
      message: 'The first administrator could not be created', errorId,
    });
  }
});

// DELETE /api/auth/session — end the calling session (local logout, §8.2).
router.delete('/session', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!isFlagOn(FLAG_SESSIONS)) { sessionsDisabled(res); return; }
    const caller = await resolveCallingAccount(req);
    if (!caller || !caller.sessionId) {
      res.status(401).json({ error: 'Unauthorized', message: 'No login session' });
      return;
    }
    await loginSessionService.revoke(caller.sessionId, 'logout');
    await auditService.record({
      action: 'auth.session.logout',
      actor: { principalId: caller.principal.id, handle: caller.principal.handle, authMethod: 'session' },
      resourceType: 'principal', resourceId: caller.principal.id,
      metadata: { sessionId: caller.sessionId, scope: 'current' },
    }).catch(() => undefined);
    res.clearCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
    res.clearCookie(BROWSER_ACCESS_COOKIE, CLEAR_BROWSER_COOKIE_OPTIONS);
    res.status(204).send();
  } catch (error) {
    const errorId = logCaughtFailure('[Auth API] logout failed:', error);
    res.status(500).json({ error: 'Internal Server Error', code: 'SESSION_LOGOUT_FAILED', message: 'Logout failed', errorId });
  }
});

// GET /api/auth/sessions — the caller's OWN live sessions, never anybody
// else's. No new scope family is minted for this (vocabulary A23.6): holding
// a session is the whole authorisation.
router.get('/sessions', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!isFlagOn(FLAG_SESSIONS)) { sessionsDisabled(res); return; }
    const caller = await resolveCallingAccount(req);
    if (!caller) {
      res.status(401).json({ error: 'Unauthorized', message: 'No login session' });
      return;
    }
    const sessions = await loginSessionService.list(caller.principal.id);
    res.json({
      sessions: sessions.map((session) => ({
        id: session.id,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        ip: session.ip,
        userAgent: session.userAgent,
        current: session.id === caller.sessionId,
      })),
    });
  } catch (error) {
    const errorId = logCaughtFailure('[Auth API] session list failed:', error);
    res.status(500).json({ error: 'Internal Server Error', code: 'SESSION_LIST_FAILED', message: 'Could not list sessions', errorId });
  }
});

// DELETE /api/auth/sessions — sign out everywhere, this session included.
router.delete('/sessions', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!isFlagOn(FLAG_SESSIONS)) { sessionsDisabled(res); return; }
    const caller = await resolveCallingAccount(req);
    if (!caller) {
      res.status(401).json({ error: 'Unauthorized', message: 'No login session' });
      return;
    }
    const revoked = await loginSessionService.revokeAllForPrincipal(caller.principal.id, 'logout');
    await auditService.record({
      action: 'auth.session.logout',
      actor: { principalId: caller.principal.id, handle: caller.principal.handle, authMethod: 'session' },
      resourceType: 'principal', resourceId: caller.principal.id,
      metadata: { scope: 'all', revoked },
    }).catch(() => undefined);
    res.clearCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
    res.clearCookie(BROWSER_ACCESS_COOKIE, CLEAR_BROWSER_COOKIE_OPTIONS);
    res.json({ success: true, revoked });
  } catch (error) {
    const errorId = logCaughtFailure('[Auth API] bulk session revoke failed:', error);
    res.status(500).json({ error: 'Internal Server Error', code: 'SESSION_REVOKE_FAILED', message: 'Could not revoke sessions', errorId });
  }
});

// DELETE /api/auth/sessions/:id — revoke ONE of the caller's own sessions.
// Ownership is checked server-side; a session id belonging to anyone else is
// answered exactly as a session id that does not exist.
router.delete('/sessions/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!isFlagOn(FLAG_SESSIONS)) { sessionsDisabled(res); return; }
    const caller = await resolveCallingAccount(req);
    if (!caller) {
      res.status(401).json({ error: 'Unauthorized', message: 'No login session' });
      return;
    }
    const owns = await loginSessionService.ownsSession(caller.principal.id, req.params.id);
    if (!owns) {
      res.status(404).json({ error: 'Not Found', message: 'No such session' });
      return;
    }
    const revoked = await loginSessionService.revoke(req.params.id, 'admin');
    await auditService.record({
      action: 'auth.session.revoke',
      actor: { principalId: caller.principal.id, handle: caller.principal.handle, authMethod: 'session' },
      resourceType: 'principal', resourceId: caller.principal.id,
      metadata: { sessionId: req.params.id, revoked },
    }).catch(() => undefined);
    if (req.params.id === caller.sessionId) {
      res.clearCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
      res.clearCookie(BROWSER_ACCESS_COOKIE, CLEAR_BROWSER_COOKIE_OPTIONS);
    }
    res.status(204).send();
  } catch (error) {
    const errorId = logCaughtFailure('[Auth API] session revoke failed:', error);
    res.status(500).json({ error: 'Internal Server Error', code: 'SESSION_REVOKE_FAILED', message: 'Could not revoke the session', errorId });
  }
});

// The Content Engine media-cookie mint (/media-session) left core with the CE
// plugin (P1.3 ruling A5); the plugin mints its own capability cookie.

// Issue the browser capability cookie for a session that authenticated before
// this cookie existed, so an already-logged-in dashboard need not log in again.
//
// SS-W1: a LOGIN SESSION mints it too. A session user holds no bearer token,
// so this route answered 401 for them — and `authenticatedFetch` turns any
// 401 into "clear credentials and reload", which ejected them to the login
// page the moment a plugin frame or a dashboard image asked for the cookie.
// The capability cookie is minted at session login as well; this route is
// what an ALREADY-open tab calls, so it has to know both doors.
router.post('/browser-session', async (req: Request, res: Response): Promise<void> => {
  try {
    const authorization = req.headers.authorization || '';
    if (authorization.startsWith('Bearer ')) {
      // Identity only: a capability token must not be able to mint another
      // capability, or the 12h bound renews itself indefinitely.
      const identity = await verifyActiveDashboardToken(authorization.slice(7));
      issueBrowserAccessCookie(res, identity.principalId ?? null);
      res.status(204).send();
      return;
    }
    const caller = await resolveCallingAccount(req);
    if (caller?.sessionId) {
      issueBrowserAccessCookie(res, caller.principal.id);
      res.status(204).send();
      return;
    }
    res.status(401).json({ error: 'Unauthorized', message: 'No token provided' });
  } catch {
    res.status(401).json({ error: 'Unauthorized', message: 'Invalid token' });
  }
});


// POST /auth/step-up — mint a SINGLE-USE elevation token (AZ-S3, design
// 4d961e37 §7.6, AZ-23): bound to ONE named action + target id, minted
// only after password re-entry, ~5-minute TTL, burned by the consuming
// endpoint. Step-up authorizes the ACT — it never widens any ceiling.
//
// SS-W1: the re-entered password is now the CALLING ACCOUNT's own, not a
// deployment-wide secret, so a second human's step-up proves that second
// human. The named local administrator keeps the deployment hash as its
// fallback until a per-Account password is issued to it.
router.post('/step-up', async (req: Request, res: Response): Promise<void> => {
  try {
    const { password, action, targetId } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof action !== 'string' || !action.trim() || typeof targetId !== 'string' || !targetId.trim()) {
      res.status(400).json({ error: 'Bad Request', message: 'action and targetId are required' });
      return;
    }
    if (typeof password !== 'string' || !password) {
      res.status(400).json({ error: 'Bad Request', message: 'Password re-entry is required (§7.6)' });
      return;
    }
    // Identify the calling session: the auth middleware does not run on the
    // public /auth mount, so resolve the identity here explicitly.
    const caller = await resolveCallingAccount(req);
    if (!caller) {
      res.status(401).json({ error: 'Unauthorized', message: 'Step-up is a login-session act (AZ-18): bearer credentials do not step up' });
      return;
    }
    const isValid = await passwordMatchesAccount(caller.principal, password);
    if (!isValid) {
      res.status(401).json({ error: 'Unauthorized', message: 'Invalid password' });
      return;
    }
    const minted = await stepUpService.mint(caller.principal.id, action.trim(), targetId.trim(), 'password');
    res.json({ success: true, stepUpToken: minted.token, expiresAt: minted.expiresAt });
  } catch (err) {
    const errorId = logCaughtFailure('[Auth API] step-up failed:', err);
    res.status(500).json({ error: 'Internal Server Error', code: 'STEP_UP_FAILED', message: 'Failed to mint the step-up token', errorId });
  }
});

/**
 * SS-1: the relying-party leg mounts UNDER the existing public `/auth` mount,
 * so `PUBLIC_ROUTE_MOUNTS` does not grow — growing it is documented in the tree
 * as "a security-significant code-review event", and four new routes under an
 * existing public mount is not that event.
 *
 * The trade is that the AST MOUNT census cannot see these routes, which is
 * exactly the visibility SS-2's route-level census restores.
 *
 * The capability-cookie mint is passed in rather than imported by the child:
 * this module mounts that router, so an import back would be circular.
 */
router.use('/sso', createSsoRouter({ issueBrowserAccessCookie }));

export default router;
