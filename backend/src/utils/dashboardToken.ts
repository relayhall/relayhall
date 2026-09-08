import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../config/secrets';

/**
 * Scope carried by the browser capability cookie (plugin frames, dashboard
 * media). It is deliberately NOT an API identity.
 */
export const BROWSER_ACCESS_SCOPE = 'browser-access';

export interface DashboardIdentity {
  userId: string;
  /** Present on v2 payloads only: the principal row id (`sub`). */
  principalId?: string;
  /** Present on v2 payloads only. */
  kind?: string;
}

/**
 * Verify a token as a dashboard IDENTITY.
 *
 * Signature validity alone is not identity. Every JWT this system mints is
 * signed with the same secret, so a scoped capability token — which carries no
 * userId — would otherwise authenticate the whole API simply by being
 * well-formed. Two rules make the separation real rather than documentary:
 *
 *  - a token carrying a `scope` claim is a capability, never an identity
 *  - an identity must actually name one
 *
 * Two identity payload shapes verify (spec b48bb799 §2.2):
 *  - legacy `{userId}` — every token minted before the v2 switch; accepted
 *    until natural expiry so nobody is force-logged-out
 *  - v2 `{v:2, sub:<principalId>, handle, kind}` — userId is the handle, so
 *    every downstream `req.userId` consumer behaves byte-identically
 *
 * Throws exactly like jwt.verify so existing catch blocks are unchanged.
 *
 * NOTE: this proves only that WE minted the token. It says nothing about
 * whether that identity has since been disabled — use
 * `verifyActiveDashboardToken` unless you resolve the principal yourself.
 */
export function verifyDashboardToken(token: string): DashboardIdentity {
  const decoded = jwt.verify(token, getJwtSecret()) as Record<string, unknown>;
  if (decoded && 'scope' in decoded) {
    throw new jwt.JsonWebTokenError('capability token is not an identity');
  }
  if (decoded?.v === 2) {
    const handle = decoded.handle;
    const sub = decoded.sub;
    if (typeof handle !== 'string' || handle.length === 0 || typeof sub !== 'string' || sub.length === 0) {
      throw new jwt.JsonWebTokenError('token carries no identity');
    }
    return {
      userId: handle,
      principalId: sub,
      kind: typeof decoded.kind === 'string' ? decoded.kind : undefined,
    };
  }
  const userId = decoded?.userId;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new jwt.JsonWebTokenError('token carries no identity');
  }
  return { userId };
}

/**
 * Verify a token AND confirm the identity it names is still active.
 *
 * `verifyDashboardToken` only proves we minted the token. Disabling was
 * enforced in authMiddleware alone, so a disabled principal's JWT kept
 * working on every OTHER entry point that honours the same token — the
 * WebSocket stream, the plugin proxy, and the capability-
 * cookie mints. Rather than patching each site (and missing the next one),
 * this is the checked entry point they all use; the raw verifier stays for
 * authMiddleware, which resolves and attaches the principal itself.
 *
 * A lookup FAILURE resolves to allow: the standing contract is that a
 * database outage must not lock anyone out, and these paths have no
 * enforcement flag of their own to fail closed behind. Only a successfully
 * read non-active status rejects.
 *
 * The lookup is also time-bounded. "Fails" and "never answers" are different
 * outages: a database that accepts connections but never returns would
 * otherwise hang every socket upgrade and cookie mint indefinitely, which is
 * a lock-out by another name.
 */
const STATUS_LOOKUP_TIMEOUT_MS = 1500;

/**
 * Look up a principal with the same bound the identity paths use. Exported so
 * the capability-cookie verifiers share it rather than each adding their own
 * unbounded await — the hang this bound exists to prevent came back twice
 * that way.
 */
export async function lookupPrincipalBounded(
  by: { principalId?: string; handle?: string }
): Promise<{ id: string; status: string } | undefined> {
  const { principalService } = await import('../services/PrincipalService');
  const lookup = by.principalId
    ? principalService.getPrincipalById(by.principalId)
    : by.handle
      ? principalService.resolveHandle(by.handle).then((r) => r.principal)
      : Promise.resolve(undefined);

  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    lookup,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), STATUS_LOOKUP_TIMEOUT_MS);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); }) as Promise<{ id: string; status: string } | undefined>;
}

export async function verifyActiveDashboardToken(token: string): Promise<DashboardIdentity> {
  const identity = verifyDashboardToken(token);
  const bounded = await lookupPrincipalBounded(
    identity.principalId ? { principalId: identity.principalId } : { handle: identity.userId }
  );

  if (bounded && bounded.status !== 'active') {
    throw new jwt.JsonWebTokenError('identity is disabled');
  }
  // Hand back the id we already resolved. Legacy {userId} payloads carry no
  // sub, so a caller reading identity.principalId alone would mint an
  // unrevocable capability cookie for exactly those tokens — which is what
  // hermes and the login fallback issue.
  return bounded ? { ...identity, principalId: bounded.id } : identity;
}
