import { logCaughtFailure } from '../utils/secretSafeLog';
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../db/connection';
import {
  getApiKey,
  getReportsReadKey,
  equalSecret,
} from '../config/secrets';
import { verifyDashboardToken } from '../utils/dashboardToken';
import { principalService, parsePrincipalKey, Principal } from '../services/PrincipalService';
import type { AuthorizationActor } from '../services/AuthorizationService';
import type { AuditAuthMethod } from '../services/AuditService';
import { isFlagOn, FLAG_AUTH_REQUIRE_PRINCIPAL, FLAG_SESSIONS } from '../utils/featureFlags';
import { LEGACY_SERVICE_SCOPES, scopesForRole } from '../utils/identityScopes';
import { resolveActorRole } from '../utils/taskAutomationRole';
import { delegationService, DelegationEvaluatorError } from '../services/DelegationService';
import { SESSION_COOKIE_NAME, loginSessionService } from '../services/LoginSessionService';
import { readCookie } from '../utils/cookies';
import { evaluateTransportPin } from '../utils/credentialAcceptance';
import type { TransportClass } from '../utils/transportMap';
import { auditService } from '../services/AuditService';
import type { DelegationActorLink } from '../services/AuthorizationService';

// §10: every legacy authentication carries an audited legacy marker,
// throttled per credential-hour so the ledger records presence, not volume.
const legacyAuditWindows = new Map<string, number>();
const LEGACY_AUDIT_WINDOW_MS = 60 * 60 * 1000;

function shouldAuditLegacy(key: string): boolean {
  const now = Date.now();
  const last = legacyAuditWindows.get(key) ?? 0;
  if (now - last < LEGACY_AUDIT_WINDOW_MS) return false;
  legacyAuditWindows.set(key, now);
  return true;
}

const API_KEY = getApiKey();
const REPORTS_READ_KEY = getReportsReadKey();

export interface AuthRequest extends Request {
  userId?: string;
  /** AZ-S3: middleware-resolved delegation chain (acting first). */
  delegationLinks?: DelegationActorLink[] | null;
  /** Resolved identity row; undefined for pre-substrate/unknown identities. */
  principal?: Principal;
  /** Explicit route scopes. Missing/null is an invalid fail-closed state. */
  scopes?: string[] | null;
  credentialId?: string;
  /** auth_sessions.role_snapshot — only set when RELAYHALL_SESSIONS is on. */
  sessionRole?: string | null;
  /** The live login session this request arrived on, when it did (SS-W1). */
  sessionId?: string;
  /** Populated by the shared authorization middleware after its route ceiling. */
  authorizationActor?: AuthorizationActor;
  /** Server-derived authentication mechanism for audit attribution. */
  authMethod?: AuditAuthMethod;
}

/**
 * Resolve a principal for a legacy identity string and attach it. Tolerant by
 * contract: attachment is additive telemetry until enforcement flips — any
 * failure leaves the request exactly as the pre-identity code built it.
 */
async function attachPrincipalByHandle(req: AuthRequest, handle: string): Promise<void> {
  const principal = await principalService.getPrincipalByHandle(handle);
  if (principal) {
    req.principal = principal;
  }
}

export const authMiddleware = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    // 1 (retired). The journal publish key branch (`x-journal-publish-key` →
    // journal_publisher + ['journal:publish']) left core with the Journal
    // plugin (P1.3 ruling A7). The header is no longer an authority source
    // here; the publish pipeline's external contract lives with the plugin.
    // Step numbering below follows spec b48bb799 §2.1 and is deliberately
    // NOT compacted.

    // 2. Scoped read-only key: GET-only access to reports (knowledge-fabric
    // connector). The journal:read half of this grant was trimmed with the
    // Journal extraction (P1.3 ruling A7) — journal paths now fail closed.
    const reportsReadKey = req.headers['x-reports-read-key'] as string;
    if (reportsReadKey) {
      const mountedPath = `${req.baseUrl || ''}${req.path}`;
      const scopedPath = /^\/reports(\/[0-9a-f-]{36})?\/?$/.test(mountedPath);
      const scopedMethod = req.method === 'GET';
      const revoked = equalSecret(reportsReadKey, REPORTS_READ_KEY)
        ? await principalService.isLegacyEnvKeyRevoked('RELAYHALL_REPORTS_READ_API_KEY')
        : false;
      if (!scopedPath || !scopedMethod || revoked || !equalSecret(reportsReadKey, REPORTS_READ_KEY)) {
        res.status(403).json({ error: 'Forbidden', message: 'Reports read key is invalid or out of scope' });
        return;
      }
      req.userId = 'reports_reader';
      req.scopes = ['reports:read'];
      req.authMethod = 'reports_read_key';
      principalService.bumpCredentialLastUsed('RELAYHALL_REPORTS_READ_API_KEY');
      await attachPrincipalByHandle(req, 'reports_reader');
      next();
      return;
    }
    // 3. Check for API key (non-expiring, for service accounts / automation).
    // A wrong value falls through to the bearer branch exactly as before; a
    // successfully-read revocation marker makes a matching value fall through
    // too (fail-close without changing the response shape).
    const apiKey = req.headers['x-api-key'];
    if (equalSecret(apiKey, API_KEY) && !(await principalService.isLegacyEnvKeyRevoked('RELAYHALL_API_KEY'))) {
      req.userId = 'service_account';
      req.scopes = [...LEGACY_SERVICE_SCOPES];
      req.authMethod = 'legacy_api_key';
      principalService.bumpCredentialLastUsed('RELAYHALL_API_KEY');
      await attachPrincipalByHandle(req, 'service_account');
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    const mountedPath = `${req.baseUrl || ''}${req.path}`;

    // NOTE: the Content Engine media cookie (`nim_content_engine_media`) and
    // its artifact-route override left core with the CE plugin (P1.3 ruling
    // A5) — cookies are never an identity source here. The plugin mints and
    // verifies its own capability cookie.

    // 4. Principal API keys (`rh_…`, spec §3.1). New contract with nothing
    // legacy to preserve; every failure returns the exact 401 body a
    // malformed bearer produced before this branch existed.
    //
    // C4: the acceptance itself moved to `acceptPrincipalKey` below, which the
    // board's in-process MCP ingress calls with its own transport stamp. The
    // behaviour on this path is unchanged in every respect — same order, same
    // bodies, same codes — and the two ingresses can no longer drift apart in
    // what a credential is allowed to do, only in where it came from.
    if (authHeader && authHeader.startsWith('Bearer rh_')) {
      const outcome = await acceptPrincipalKey(req, authHeader, mountedPath, REST_TRANSPORT_STAMP);
      if (outcome.kind === 'ok') { next(); return; }
      if (outcome.kind === 'denied') { res.status(outcome.status).json(outcome.body); return; }
      // Unreachable under the guard above; fail closed rather than fall
      // through into the JWT arm with an rh_ token in hand.
      res.status(401).json({ error: 'Unauthorized', message: 'Invalid token' });
      return;
    }

    // 5. Bearer JWT (standard auth)
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // 6. Server-side session cookie — inert until RELAYHALL_SESSIONS=on,
      // which SS-W1 is the wave that flips. Sits in the would-have-401'd slot
      // so every bearer-carrying request stays byte-identical.
      if (isFlagOn(FLAG_SESSIONS)) {
        const sessionToken = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
        if (sessionToken && (await attachSessionPrincipal(req, sessionToken))) {
          next();
          return;
        }
      }
      res.status(401).json({ error: 'Unauthorized', message: 'No token provided' });
      return;
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    // Verify token as an IDENTITY. A signature-valid capability token (the
    // browser cookie) carries no userId and must not authenticate the API.
    const decoded = verifyDashboardToken(token);

    if (decoded.principalId) {
      // v2 payload: principal id is authoritative, handle is the userId.
      req.userId = decoded.userId;
      const principal = await principalService.getPrincipalById(decoded.principalId);
      // Disabling a principal is documented as the kill switch, and it was
      // only ever enforced on the rh_ branch — a disabled principal's JWT
      // kept full access. A disabled identity is disabled on every path.
      if (principal && principal.status !== 'active') {
        res.status(401).json({ error: 'Unauthorized', message: 'Invalid token' });
        return;
      }
      if (principal) {
        req.principal = principal;
        req.userId = principal.handle;
      } else if (isFlagOn(FLAG_AUTH_REQUIRE_PRINCIPAL)) {
        res.status(401).json({ error: 'Unauthorized', message: 'Invalid token' });
        return;
      }
    } else {
      // Legacy payload: resolve by handle; an unknown handle keeps today's
      // behaviour and feeds the telemetry that gates the CB-8 flag flip.
      const { principal, degraded } = await principalService.resolveHandle(decoded.userId);
      if (principal && principal.status !== 'active') {
        res.status(401).json({ error: 'Unauthorized', message: 'Invalid token' });
        return;
      }
      if (principal) {
        req.principal = principal;
        req.userId = principal.handle;
      } else {
        req.userId = decoded.userId;
        if (degraded) {
          // Substrate unreadable — NOT evidence that this handle lacks a
          // principal. Kept out of the CB-8 gate feed; the throttled
          // PrincipalService warning already records the outage itself.
          if (isFlagOn(FLAG_AUTH_REQUIRE_PRINCIPAL)) {
            res.status(401).json({ error: 'Unauthorized', message: 'Invalid token' });
            return;
          }
        } else {
          console.warn(`[auth] unknown-handle-jwt handle=${decoded.userId} path=${mountedPath}`);
          if (isFlagOn(FLAG_AUTH_REQUIRE_PRINCIPAL)) {
            res.status(401).json({ error: 'Unauthorized', message: 'Invalid token' });
            return;
          }
        }
      }
    }
    req.scopes = scopesForRole(resolveActorRole({
      handle: req.userId ?? '',
      principalRole: req.principal?.role,
    }));
    req.authMethod = 'dashboard_jwt';

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'Unauthorized', message: 'Token expired' });
      return;
    }

    if (error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ error: 'Unauthorized', message: 'Invalid token' });
      return;
    }

    const errorId = logCaughtFailure('[Auth] authentication failed:', error);
    res.status(500).json({ error: 'Internal Server Error', code: 'AUTH_FAILED', message: 'Authentication failed', errorId });
  }
};

/**
 * Session-cookie resolution (spec §2.1 step 6). Returns true only when a
 * live, unexpired, un-idled, unrevoked session row resolves to an active
 * principal; every other outcome falls through to the JWT branch.
 *
 * The row lookup and both expiry predicates live in `LoginSessionService`,
 * which is also where the session was minted — so the door that issues a
 * session and the door that accepts one can never disagree about when it
 * stops being live.
 *
 * `role_snapshot` is read but never written here, and SS-W1 mints it NULL
 * (SS-9). NULL and empty/unknown are deliberately DIFFERENT: with NULL,
 * `resolveActorRole` falls through to `principals.role`; with an empty or
 * unknown string it returns that string and `scopesForRole` fails it closed
 * to `[]`. Both behaviours are pinned by
 * `__tests__/sessionRoleSnapshot.test.ts`.
 */
async function attachSessionPrincipal(req: AuthRequest, sessionToken: string): Promise<boolean> {
  try {
    const session = await loginSessionService.resolve(sessionToken);
    if (!session) return false;
    const principal = await principalService.getPrincipalById(session.principalId);
    if (!principal || principal.status !== 'active') return false;
    loginSessionService.touch(session.sessionId);
    req.principal = principal;
    req.userId = principal.handle;
    req.sessionId = session.sessionId;
    req.sessionRole = session.roleSnapshot;
    req.scopes = scopesForRole(resolveActorRole({
      handle: req.userId,
      principalRole: principal.role,
      sessionRole: req.sessionRole,
    }));
    req.authMethod = 'session';
    return true;
  } catch {
    return false;
  }
}

/** REST ingress provenance: stamped after transport termination, never read
 * from a header, so a forged provenance header still classifies `api` (T15). */
export const REST_TRANSPORT_STAMP: TransportClass = 'api';

export type PrincipalKeyOutcome =
  | { kind: 'ok' }
  | { kind: 'not-principal-key' }
  | { kind: 'denied'; status: number; body: Record<string, unknown> };

/**
 * The ONE `rh_` principal-credential acceptance path (AUTHZ design 4d961e37
 * §5.1/§7.3/§7.5).
 *
 * Extracted at RH-P3.C4 so the REST ingress (`authMiddleware`, stamping
 * `api`) and the board's in-process MCP endpoint handler (`mcp/provenance`,
 * stamping `mcp`) run the SAME sequence: token parse, timing-safe
 * authentication, transport pin against SERVER-DERIVED provenance, legacy
 * audit marker, live delegation-chain and bound-task liveness, effective
 * scopes. `stamped` is supplied by the ingress and by nothing else.
 *
 * On success the request carries principal, scopes, credential id, auth
 * method and delegation links, exactly as before. On failure it returns the
 * status and body the ingress should send — this function never writes to a
 * response, so both ingresses keep their own error envelope duties (the MCP
 * one adds `WWW-Authenticate`).
 */
export async function acceptPrincipalKey(
  req: AuthRequest,
  authHeader: string | undefined,
  mountedPath: string,
  stamped: TransportClass,
): Promise<PrincipalKeyOutcome> {
  if (!authHeader || !authHeader.startsWith('Bearer rh_')) return { kind: 'not-principal-key' };

  const parts = parsePrincipalKey(authHeader.substring(7));
  const authenticated = parts ? await principalService.authenticatePrincipalKey(parts) : undefined;
  if (!authenticated) {
    return { kind: 'denied', status: 401, body: { error: 'Unauthorized', message: 'Invalid token' } };
  }
  // ── AZ-S3 §7.5: transport pin vs SERVER-DERIVED provenance ──────
  // The stamp is never read from headers, so forged provenance headers still
  // classify as the ingress's own class (T15). An UNCLASSIFIED route rejects
  // every non-'any' pin (T26, fail closed).
  //
  // C2 (review r2, B2): the pin is evaluated by the ONE shared predicate in
  // utils/credentialAcceptance, which the webhook delivery worker calls as
  // well — so a PUSH path can never be more permissive than this ingress.
  const transportDecision = evaluateTransportPin(
    authenticated.credential.transport, mountedPath, stamped,
  );
  if (!transportDecision.allowed) {
    return {
      kind: 'denied',
      status: 403,
      body: { error: 'Forbidden', code: 'TRANSPORT_MISMATCH', message: 'This credential is pinned to a different transport class (design 4d961e37 §7.5)' },
    };
  }

  req.principal = authenticated.principal;
  req.userId = authenticated.principal.handle;
  req.scopes = authenticated.credential.scopes;
  req.credentialId = authenticated.credential.id;
  req.authMethod = 'principal_api_key';

  if (authenticated.principal.legacyIdentity) {
    // §10 compatibility arm: legacy rows evaluate under the unchanged
    // Phase-2 arms; the authentication carries an audited legacy marker
    // (throttled per credential-hour).
    if (shouldAuditLegacy(authenticated.credential.id)) {
      auditService.record({
        action: 'legacy.authenticated',
        actor: { principalId: authenticated.principal.id, handle: authenticated.principal.handle, authMethod: 'principal_api_key', credentialId: authenticated.credential.id },
        resourceType: 'credential',
        resourceId: authenticated.credential.id,
        metadata: { legacy: true, throttled: 'per-credential-hour' },
      }).catch(() => undefined);
    }
  } else if (authenticated.principal.parentPrincipalId) {
    // ── AZ-S3 §5.1: chain liveness + effective scopes, evaluated LIVE.
    // Any evaluator failure fails the WHOLE request (503) — never a
    // partial or empty-success list (AZ-34, T29).
    let chain;
    let boundTaskDead = false;
    try {
      chain = await delegationService.resolveChain(authenticated.principal.id);
      if (chain.alive) {
        const acting = chain.links[0];
        if (acting.kind === 'agent' && acting.boundTaskId) {
          // §7.3/T6: bound-task terminal status and lease expiry are
          // evaluated LIVE — a between-sweep replay dies here.
          const taskState = await pool.query(
            `SELECT t.status,
                    EXISTS (SELECT 1 FROM task_execution_leases l
                             WHERE l.task_id = t.id AND l.status = 'active' AND l.expires_at <= NOW()) AS lease_expired
               FROM tasks t WHERE t.id = $1`,
            [acting.boundTaskId],
          );
          const taskRow = taskState.rows[0];
          if (!taskRow || ['completed', 'archived'].includes(String(taskRow.status)) || taskRow.lease_expired === true) {
            boundTaskDead = true;
          }
        }
      }
    } catch (err) {
      const errorId = logCaughtFailure('[Auth] delegation evaluator failed:', err);
      if (err instanceof DelegationEvaluatorError) {
        return { kind: 'denied', status: 503, body: { error: 'Service Unavailable', code: 'DELEGATION_EVALUATOR_FAILED', message: 'Delegation chain evaluation failed — the request fails closed (AZ-34)', errorId } };
      }
      return { kind: 'denied', status: 503, body: { error: 'Service Unavailable', code: 'DELEGATION_EVALUATOR_FAILED', message: 'Delegation liveness evaluation failed — the request fails closed (AZ-34)', errorId } };
    }
    if (!chain.alive || boundTaskDead) {
      return { kind: 'denied', status: 401, body: { error: 'Unauthorized', message: 'Invalid token' } };
    }
    const account = chain.links[chain.links.length - 1];
    const accountScopes = scopesForRole(account.role);
    req.scopes = delegationService.effectiveScopes(chain, authenticated.credential.scopes, accountScopes);
    req.delegationLinks = chain.links.map((link) => ({
      principalId: link.principalId,
      kind: link.kind,
      role: link.role,
      parentPrincipalId: link.parentPrincipalId,
      boundTaskId: link.boundTaskId,
      legacyIdentity: link.legacyIdentity,
      ownExpression: link.ownExpression,
    }));
  }

  principalService.bumpLastSeen(authenticated.principal.id);
  return { kind: 'ok' };
}
