/**
 * httpRoute — the board's `/mcp` Streamable HTTP endpoint (MCP spec de73f9f8
 * §1.3/§1.4/§4.5; AUTHZ design 4d961e37 §7.5; owner decision D1).
 *
 * STATELESS BY CONSTRUCTION: a fresh `Server` and a fresh transport are built
 * for EVERY request, with `sessionIdGenerator: undefined` and
 * `enableJsonResponse: true`. Nothing survives a request, so there is no
 * `Mcp-Session-Id`-bound state to delete when the 2026-07-28 rev deletes the
 * header. Identity rides exclusively on the per-request `Authorization`
 * header, as §1.3 requires.
 *
 * SDK v2 (card `bec87735`, KS-7): the transport is the web-standard
 * `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/server`
 * — v2 ships no Node `(req, res)` transport — bridged from Express by
 * `mcp/webBridge`. `enableJsonResponse: true` is what keeps the answer
 * `application/json`: without it the same transport frames every reply as a
 * `text/event-stream`, which is what v1 did too, and the wire suite carries a
 * negative control that proves the option is what the framing rests on. The
 * rebinding options (`enableDnsRebindingProtection`, `allowedHosts`,
 * `allowedOrigins`) are `@deprecated` in v2 in favour of middleware; they are
 * kept until a middleware form is designed, so the env-driven behaviour
 * documented in `docs/mcp.md` is unchanged by the migration.
 *
 * NO BROWSER FORWARD-AUTH (§1.4): this route authenticates at the application
 * layer and answers `401 + WWW-Authenticate` — a redirect-to-login would
 * break every stock MCP client.
 *
 * RH-P3.C6: THE OAUTH SEAM IS NOW CLOSED. C4 advertised no protected-resource
 * metadata because no authorization server existed to complete the dance (the
 * Claude Code #59467 edge). C6 releases one, so the 401 challenge now carries
 * the RFC 9728 `resource_metadata` pointer — rendered by `mcpChallengeFor`,
 * from the same constants the two metadata documents are rendered from. The
 * route is otherwise unchanged: identity still rides exclusively on the
 * per-request `Authorization` header, and an OAuth-issued access token is an
 * ordinary `rh_` reference credential (ruling TS-12) that this ingress
 * accepts through the same `acceptPrincipalKey` as any other.
 *
 * WHY THIS ROUTE IS NOT A `protectedRouter` MOUNT: `protectedRouter` installs
 * `authMiddleware`, which stamps `api`. This ingress must stamp `mcp`, and it
 * does so AFTER transport termination — inside the tool dispatch, in
 * `mcp/provenance`. Mounting it the ordinary way would have classified every
 * MCP call as REST and made the §7.5 pin meaningless.
 */
import { Router, type Request, type Response } from 'express';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

import { buildMcpServer } from './server';
import { sendWebResponse, toWebRequest } from './webBridge';
import { acceptPrincipalKey, type AuthRequest } from '../middleware/auth';
import { MCP_TRANSPORT_STAMP, mcpChallengeFor, MCP_ROUTE_PATH } from './provenance';
import { logCaughtFailure } from '../utils/secretSafeLog';

/** The mounted path, and the transport class it declares in `transportMap`.
 * Defined in `mcp/provenance` (see the note there) and re-exported here, which
 * is where the rest of the codebase has always imported it from. */
export { MCP_ROUTE_PATH };

/**
 * §4.5 Origin validation / DNS rebinding. A deployment declares the origins
 * its browser callers may use; requests with no `Origin` (normal for every
 * non-browser MCP client) pass through to authentication. Empty configuration
 * means no browser origin is expected at all, which is the estate's case.
 */
function allowedOrigins(): string[] {
  return (process.env.RELAYHALL_MCP_ALLOWED_ORIGINS || '')
    .split(',').map((value) => value.trim()).filter(Boolean);
}

function allowedHosts(): string[] {
  return (process.env.RELAYHALL_MCP_ALLOWED_HOSTS || '')
    .split(',').map((value) => value.trim()).filter(Boolean);
}

const router = Router();

async function handle(req: Request, res: Response): Promise<void> {
  const authorization = req.headers.authorization;

  // Authenticate ONCE at the ingress so an unauthenticated call gets the
  // spec-required 401 with a challenge rather than a JSON-RPC tool error.
  // Every dispatched board route re-authenticates and re-evaluates the pin
  // against the route it actually composes (mcp/provenance) — this check is
  // the door, not the authority.
  if (!authorization || !authorization.startsWith('Bearer rh_')) {
    res.setHeader('WWW-Authenticate', mcpChallengeFor(req));
    res.status(401).json({
      error: 'Unauthorized',
      message: 'The MCP endpoint accepts a RelayHall principal credential only: send Authorization: Bearer rh_<env>_<keyId>.<secret>',
    });
    return;
  }
  const probe = {} as AuthRequest;
  const outcome = await acceptPrincipalKey(probe, authorization, MCP_ROUTE_PATH, MCP_TRANSPORT_STAMP);
  if (outcome.kind !== 'ok') {
    const status = outcome.kind === 'denied' ? outcome.status : 401;
    const body = outcome.kind === 'denied'
      ? outcome.body
      : { error: 'Unauthorized', message: 'Invalid token' };
    if (status === 401) res.setHeader('WWW-Authenticate', mcpChallengeFor(req));
    res.status(status).json(body);
    return;
  }

  const server = buildMcpServer((toolName) => ({ authorization, toolName }));
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: no MCP session id is generated, none is expected, and no
    // state is keyed on one anywhere in this process.
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    ...(allowedOrigins().length > 0 || allowedHosts().length > 0
      ? {
        enableDnsRebindingProtection: true,
        ...(allowedOrigins().length > 0 ? { allowedOrigins: allowedOrigins() } : {}),
        ...(allowedHosts().length > 0 ? { allowedHosts: allowedHosts() } : {}),
      }
      : {}),
  });

  res.on('close', () => {
    transport.close().catch(() => undefined);
    server.close().catch(() => undefined);
  });

  try {
    await server.connect(transport);
    const answer = await transport.handleRequest(toWebRequest(req), { parsedBody: req.body });
    await sendWebResponse(answer, res);
  } catch (error) {
    const errorId = logCaughtFailure('[MCP] request failed:', error);
    if (!res.headersSent) {
      // The board's own error envelope, not a JSON-RPC one: this branch fires
      // only when the TRANSPORT itself failed, so no JSON-RPC exchange was
      // ever established for a JSON-RPC error to belong to. A client sees an
      // HTTP-level failure, which is what it is — and the envelope carries the
      // fixed code and correlating errorId every 500 in this codebase owes.
      res.status(500).json({
        error: 'Internal Server Error',
        code: 'MCP_TRANSPORT_FAILED',
        message: 'The MCP endpoint could not complete this request',
        errorId,
      });
    }
  }
}

router.post('/', handle);
// The spec's GET (server-initiated stream) and DELETE (MCP session teardown)
// are answered by the transport itself, exactly as they were on v1: this
// server needs neither — every tool is request/response and there is no MCP
// session to tear down. A GET opens the spec's standalone event stream, which
// carries nothing, because no tool ever sends a server-initiated message on
// it (posture item 6); DELETE is acknowledged with no session to delete.
router.get('/', handle);
router.delete('/', handle);

export default router;
