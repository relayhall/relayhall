import { loginSessionService, type ResolvedLoginSession } from './LoginSessionService';
import { principalService, type Principal } from './PrincipalService';

/** A lookup failed, so the presented cookie's validity is unknown. */
export class SessionAuthenticationUnavailableError extends Error {
  constructor(
    public readonly operation: 'session' | 'principal',
    public readonly cause: unknown,
  ) {
    super('Session authentication is temporarily unavailable');
    this.name = 'SessionAuthenticationUnavailableError';
  }
}

export async function resolveLoginSession(token: string): Promise<ResolvedLoginSession | undefined> {
  try {
    return await loginSessionService.resolve(token);
  } catch (cause) {
    throw new SessionAuthenticationUnavailableError('session', cause);
  }
}

/** Return undefined only for a confirmed invalid session or inactive Account. */
export async function resolveActiveLoginSession(token: string): Promise<{
  session: ResolvedLoginSession;
  principal: Principal;
} | undefined> {
  const session = await resolveLoginSession(token);
  if (!session) return undefined;
  let principal: Principal | undefined;
  try {
    principal = await principalService.getPrincipalByIdStrict(session.principalId);
  } catch (cause) {
    throw new SessionAuthenticationUnavailableError('principal', cause);
  }
  if (!principal || principal.status !== 'active') return undefined;
  return { session, principal };
}
