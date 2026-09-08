/**
 * webBridge — Node/Express `(req, res)` ⇄ web-standard `Request`/`Response`.
 *
 * SDK v2 (`@modelcontextprotocol/server`, card `bec87735`, KS-7) ships no
 * Node-flavoured Streamable HTTP transport: `WebStandardStreamableHTTPServerTransport`
 * takes a web-standard `Request` and returns a `Response`. The board mounts
 * `/mcp` on its existing Express app (MCP design `de73f9f8` §1.4 — the door
 * must answer `401 + WWW-Authenticate` from the application layer), so this
 * file is the ~30 lines that carry one HTTP exchange across that seam and
 * nothing else.
 *
 * It is deliberately NOT `@modelcontextprotocol/express` (owner decision D4):
 * the ratified dependency budget is "SDK + zod + undici only" (§1.2, read as
 * ruled at KS-6), and a hand-written bridge is smaller than the review it
 * would take to admit a framework adapter.
 *
 * Nothing here is remembered between calls. Every function takes the exchange
 * it is handed and returns; there is no module-level binding of any kind
 * (posture gate, S-A6 §1.3 items 2–3).
 */
import { Readable } from 'stream';
import type { Request, Response } from 'express';

/**
 * The web-standard view of one incoming Express request: same method, the
 * request's own absolute URL, every header the client sent (so the SDK's
 * `Host`/`Origin` validation sees exactly what the socket carried), and — for
 * methods that carry one — the already-parsed JSON body re-serialised.
 *
 * `req.body` is what `express.json()` produced upstream; the route also hands
 * it to the transport as `parsedBody`, so the SDK never re-reads the stream.
 */
export function toWebRequest(req: Request): globalThis.Request {
  const origin = `${req.protocol}://${req.get('host') ?? 'localhost'}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const each of value) headers.append(name, each);
    } else {
      headers.set(name, value);
    }
  }
  const carriesBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined;
  return new globalThis.Request(new URL(req.originalUrl || req.url, origin), {
    method: req.method,
    headers,
    body: carriesBody ? JSON.stringify(req.body) : undefined,
  });
}

/**
 * Write a web-standard `Response` back through the Express response: status,
 * every header, then the body streamed to completion. A JSON answer is one
 * chunk; a held-open event stream (the spec's GET) flows until either side
 * closes, at which point the route's own `res.on('close')` teardown runs.
 */
export async function sendWebResponse(response: globalThis.Response, res: Response): Promise<void> {
  res.status(response.status);
  response.headers.forEach((value, name) => { res.setHeader(name, value); });
  if (!response.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(response.body as never);
  await new Promise<void>((resolve, reject) => {
    body.once('error', reject);
    res.once('close', () => { body.destroy(); resolve(); });
    res.once('finish', resolve);
    body.pipe(res);
  });
}
