/**
 * provenance — the `mcp` transport stamp (RH-P3.C4; AUTHZ design 4d961e37
 * §7.5, AZ-14/AZ-34, threat rows T15/T26/T28).
 *
 * THE STAMP IS A CONSTANT IN THIS FILE. `MCP_TRANSPORT_STAMP` is not a
 * parameter, is not derived from a header, a JSON-RPC field, a tool argument
 * or any other caller-controllable input, and is exported only so tests can
 * assert its value. The only way to be stamped `mcp` is to arrive through the
 * in-process MCP endpoint handler, after transport termination — a direct
 * HTTP caller reaches `middleware/auth` instead and is stamped `api`, however
 * it decorates its request.
 *
 * The credential acceptance itself is NOT reimplemented here: it is the same
 * `acceptPrincipalKey` the REST ingress calls, so revocation, expiry,
 * rotation grace, delegation-chain liveness, bound-task death and the
 * transport pin are evaluated identically on both ingresses. The two differ
 * in one argument.
 *
 * WHAT THIS INGRESS DELIBERATELY DOES NOT ACCEPT (de73f9f8 §2.1/§2.4):
 * the legacy `x-api-key` service key, the scoped reports-read key, dashboard
 * JWTs and login-session cookies. MCP identity is a per-principal `rh_`
 * credential and nothing else — "every MCP client on the estate would then be
 * service_account: zero attribution, full unscoped write access handed to
 * LLM clients that ingest attacker-writable task text".
 */
import type { Request, Response, NextFunction } from 'express';

import { acceptPrincipalKey, type AuthRequest } from '../middleware/auth';
import type { TransportClass } from '../utils/transportMap';
import { mcpWwwAuthenticate } from '../utils/oauthMetadata';
import { boardEndpointFor } from '../utils/onboardingPack';

/** The server-derived provenance every request through this ingress carries. */
export const MCP_TRANSPORT_STAMP: TransportClass = 'mcp';

/**
 * The path this ingress is mounted at, and the path every credential check on
 * it evaluates the transport pin against.
 *
 * It lives HERE rather than in `mcp/httpRoute` because two other modules need
 * it and one of them — `mcp/bootstrapGate` — is imported BY the server that
 * `httpRoute` imports. Defining it in `httpRoute` would close that loop into an
 * import cycle. `httpRoute` re-exports it, so every existing importer is
 * unaffected.
 */
export const MCP_ROUTE_PATH = '/mcp';

/**
 * The `WWW-Authenticate` challenge the spec requires on a 401 (§1.4),
 * WITHOUT a discovery pointer.
 *
 * RH-P3.C4 shipped exactly this string and nothing else, deliberately: with no
 * authorization server released, pointing a client at protected-resource
 * metadata would have lured a static-header client into a flow the board could
 * not serve. RH-P3.C6 releases the server, so `mcpChallengeFor` below adds the
 * pointer that is now true. This constant remains the honest floor for a
 * challenge emitted with no request in hand.
 */
export const MCP_WWW_AUTHENTICATE = 'Bearer realm="relayhall-mcp", error="invalid_token"';

/**
 * The challenge for a real request: the floor above plus the RFC 9728
 * `resource_metadata` pointer at THIS deployment's protected-resource
 * document. Rendered by `utils/oauthMetadata` so the challenge, the two
 * metadata documents and the published support matrix cannot disagree.
 *
 * THIS IS THE MECHANISM THAT FLIPS THE TIER-B ROW. `docs/harness-support.md`
 * said the MCP endpoint "deliberately advertises no OAuth protected-resource
 * metadata today ... when the authorization server ships, this row flips and
 * that release is what flips it — not this page." This function is that
 * release's half of the sentence.
 */
export function mcpChallengeFor(req: Request): string {
  return mcpWwwAuthenticate(boardEndpointFor(req));
}

const UNAUTHORIZED = {
  error: 'Unauthorized',
  message: 'The MCP endpoint accepts a RelayHall principal credential only: send Authorization: Bearer rh_<env>_<keyId>.<secret>',
} as const;

/**
 * Authenticate one in-process MCP call and stamp its provenance.
 *
 * Runs per dispatched board route, exactly as `authMiddleware` does, so the
 * transport pin is evaluated against the route the tool actually composes
 * rather than against `/mcp` alone.
 */
export const mcpAuthMiddleware = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const mountedPath = `${req.baseUrl || ''}${req.path}`;
  const outcome = await acceptPrincipalKey(
    req, req.headers.authorization, mountedPath, MCP_TRANSPORT_STAMP,
  );
  if (outcome.kind === 'ok') { next(); return; }
  if (outcome.kind === 'denied') {
    if (outcome.status === 401) res.setHeader('WWW-Authenticate', mcpChallengeFor(req));
    res.status(outcome.status).json(outcome.body);
    return;
  }
  res.setHeader('WWW-Authenticate', mcpChallengeFor(req));
  res.status(401).json(UNAUTHORIZED);
};
