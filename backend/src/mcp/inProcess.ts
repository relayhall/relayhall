import { jsonBodyOptions } from '../utils/jsonBodyTypes';
/**
 * inProcess — the board's IN-PROCESS MCP ingress (RH-P3.C4; AUTHZ design
 * 4d961e37 §7.5; MCP spec de73f9f8 §1.3/§2.1; run packet 3e6ec75a D1).
 *
 * ── The trust boundary, stated once ──
 *
 * §7.5: "requests entering through the board's IN-PROCESS MCP endpoint
 * handler are stamped `mcp` by the server AFTER transport termination; REST
 * routes are stamped `api`; the attribute is never read from headers or any
 * caller-controllable input."
 *
 * That is literally what this module is. `dispatchInProcess` is reached only
 * from a tool handler, which is reached only after the Streamable-HTTP or
 * stdio transport has been terminated and a JSON-RPC `tools/call` parsed. The
 * `mcp` stamp is a compile-time constant HERE — there is no parameter, no
 * header, no argument a caller could steer. A direct HTTP caller cannot reach
 * this function at all: it reaches `middleware/auth`, which stamps `api`.
 *
 * ── Why it dispatches through the real routers ──
 *
 * D1 puts the surface in-process and de73f9f8 §1.1 requires that "every
 * authorization decision therefore happens exactly once, in the backend's
 * central authz helper". Both hold here: the internal app mounts the SAME
 * routers from the SAME ordered list as the REST ingress (`routeRegistry`),
 * behind the SAME `sharedAuthorizationMiddleware` ceiling, and differs from
 * the REST ingress in exactly one respect — the transport class its
 * authentication stamps. There is no second implementation of any tool's
 * behaviour to drift, which is what the alternative (tools calling services
 * directly) would have created.
 *
 * The request is a real `http.IncomingMessage` carrying a real body stream
 * through the real `express.json()` parser, and the response is a real
 * `http.ServerResponse`. Route handlers cannot tell the difference, which is
 * the point: "resembles production" is the failure mode AZ-S3 verdict
 * 87fec3e2 B1 was written about.
 */
import express, { type Express, type RequestHandler, type Router } from 'express';
import { IncomingMessage, ServerResponse } from 'http';
import { Duplex } from 'stream';

import { registerProtectedRoutes } from '../routeRegistry';
import { sharedAuthorizationMiddleware } from '../middleware/sharedAuthorization';
import { apiErrorHandler } from '../utils/apiErrors';
import { mcpAuthMiddleware } from './provenance';

/** A socket that is never connected: it exists so `IncomingMessage` and
 * `ServerResponse` have the object shape they were written against. Nothing
 * is ever written to it — the response is captured before it would be. */
class DetachedSocket extends Duplex {
  readonly remoteAddress = '127.0.0.1';
  readonly remoteFamily = 'IPv4';
  readonly encrypted = false;
  _read(): void { /* nothing is ever pushed from the far side */ }
  _write(_chunk: unknown, _enc: unknown, callback: (error?: Error | null) => void): void {
    callback();
  }
}

export interface InProcessRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Mounted path WITHOUT query string, e.g. `/tasks/<id>/claim`. */
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** Extra request headers (If-Match, Idempotency-Key, If-None-Match, …). */
  headers?: Record<string, string>;
  /** The caller's `Authorization` header, forwarded verbatim (§2.1). */
  authorization: string;
}

export interface InProcessResponse {
  status: number;
  body: unknown;
  /** As Node reports them: a header value may be a number (Content-Length). */
  headers: Record<string, string | number | string[] | undefined>;
}

let internalApp: Express | undefined;

/**
 * The internal app. Built once, lazily, so importing this module never has a
 * side effect on the REST server's own construction order.
 *
 * Deliberately absent versus the REST ingress: helmet, cors and morgan (this
 * is not a network ingress — the real one is the `/mcp` route on the main
 * app, which has all three in front of it) and `apiRateLimit` (the same: the
 * `/mcp` request was already counted once; counting each tool call again
 * would throttle a bootstrap Brief against its own index).
 */
export function getInternalApp(): Express {
  if (internalApp) return internalApp;
  const app = express();
  // Share the actual REST parser configuration so its Blueprint cap
  // derivation and this in-process ingress track the same body limit.
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  registerProtectedRoutes((path: string, ...handlers: Array<RequestHandler | Router>) => {
    app.use(path, mcpAuthMiddleware, sharedAuthorizationMiddleware, ...(handlers as RequestHandler[]));
  });
  app.use(apiErrorHandler);
  internalApp = app;
  return app;
}

/** Test seam: drop the memoised app so a suite can rebuild it. */
export function resetInternalApp(): void {
  internalApp = undefined;
}

function buildUrl(path: string, query?: Record<string, string | undefined>): string {
  const entries = Object.entries(query ?? {}).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  if (entries.length === 0) return path;
  const search = new URLSearchParams(entries).toString();
  return `${path}?${search}`;
}

/**
 * Run one request through the internal app and return its outcome.
 *
 * Never rejects for an application-level failure: a 4xx/5xx comes back as a
 * value, exactly as the Python adapter surfaced REST failures, so a tool can
 * turn it into an instructive MCP error rather than a protocol error
 * (de73f9f8 §2.1, SEP-1303 semantics).
 */
export function dispatchInProcess(input: InProcessRequest): Promise<InProcessResponse> {
  const app = getInternalApp();
  const payload = input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body), 'utf8');

  const socket = new DetachedSocket();
  const req = new IncomingMessage(socket as never);
  req.method = input.method;
  req.url = buildUrl(input.path, input.query);
  req.httpVersion = '1.1';
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;
  // ORDER IS THE CONTROL. Tool-supplied headers go in FIRST; identity and the
  // framing headers are written over them. A tool that (now or later) put a
  // caller-steerable value under `authorization` could otherwise swap the
  // credential this whole path exists to carry faithfully — and it would look
  // like an ordinary header map while doing it.
  req.headers = {
    ...Object.fromEntries(
      Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    ),
    host: 'in-process.mcp.invalid',
    authorization: input.authorization,
    ...(payload
      ? { 'content-type': 'application/json', 'content-length': String(payload.byteLength) }
      : {}),
  };
  if (payload) req.push(payload);
  req.push(null);

  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];

  return new Promise<InProcessResponse>((resolve, reject) => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      // Flip `headersSent` through the public API before anything downstream
      // (finalhandler, apiErrorHandler) asks whether the response is already
      // committed. Storing headers touches no socket; nothing is written.
      if (!res.headersSent) res.writeHead(res.statusCode);
      const text = Buffer.concat(chunks).toString('utf8');
      let body: unknown = text;
      if (text.length > 0) {
        try { body = JSON.parse(text); } catch { body = text; }
      } else {
        body = undefined;
      }
      resolve({ status: res.statusCode, body, headers: res.getHeaders() });
    };

    const collect = (chunk: unknown, encoding?: unknown): void => {
      if (chunk === undefined || chunk === null) return;
      const enc = typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8';
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), enc));
    };

    // Own properties: they survive express's `setPrototypeOf(res, app.response)`
    // and intercept the write before it reaches the detached socket.
    (res as unknown as Record<string, unknown>).write = (
      chunk: unknown, encoding?: unknown, callback?: unknown,
    ): boolean => {
      collect(chunk, encoding);
      const done = typeof encoding === 'function' ? encoding : callback;
      if (typeof done === 'function') (done as () => void)();
      return true;
    };
    (res as unknown as Record<string, unknown>).end = (
      chunk?: unknown, encoding?: unknown, callback?: unknown,
    ): ServerResponse => {
      if (typeof chunk !== 'function') collect(chunk, encoding);
      const done = [chunk, encoding, callback].find((candidate) => typeof candidate === 'function');
      if (typeof done === 'function') (done as () => void)();
      settle();
      return res;
    };

    try {
      app(req as never, res as never, (error?: unknown) => {
        // Nothing matched, or an error escaped every handler. Both are
        // programming errors on this path (the registry only names routes
        // that exist), so they surface loudly rather than as a silent 200.
        if (error) { reject(error instanceof Error ? error : new Error(String(error))); return; }
        if (!settled) {
          settled = true;
          resolve({ status: 404, body: { success: false, error: 'No such board route', code: 'ROUTE_NOT_FOUND' }, headers: {} });
        }
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
