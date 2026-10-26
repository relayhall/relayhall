/**
 * OtlpGrpcIngress — the OTLP/gRPC receivers (RH-TW1b slice 2, card `dac2ca71`;
 * absorbed estate card `928586a6`; TELEMETRY-DESIGN `7d5c0cdc` §3.1 item 1).
 *
 *   TraceService/Export    opentelemetry.proto.collector.trace.v1
 *   LogsService/Export     opentelemetry.proto.collector.logs.v1
 *   MetricsService/Export  opentelemetry.proto.collector.metrics.v1
 *
 * A SECOND LISTENER. gRPC needs HTTP/2 end to end, and the Express app is an
 * HTTP/1.1 server behind an HTTP/1.1 proxy, so the receiver is an `http2`
 * server on its own port (`RELAYHALL_OTLP_GRPC_PORT`; unset = not started).
 *
 * ONE PATH TO THE STORE, BY CONSTRUCTION. The listener terminates gRPC — the
 * length prefix, compression, the size bound — and then dispatches the
 * request message IN PROCESS, as an `application/x-protobuf` POST, through the
 * PRODUCTION telemetry router to `/telemetry/otlp/<version>/<signal>`: the very
 * route handler an OTLP/HTTP producer reaches. So the gRPC receiver has, and
 * can have, no behaviour of its own between authentication and the answer:
 *
 *   - authentication: `acceptPrincipalKey`, the ONE `rh_` acceptance path
 *     REST and MCP share (revocation, expiry, rotation grace, delegation-chain
 *     and bound-task liveness, the transport pin). Like the MCP ingress it
 *     accepts `rh_` principal credentials ONLY — no legacy service key, no
 *     dashboard JWT, no session cookie — carried as the standard
 *     `authorization: Bearer rh_…` call metadata. No new credential kind;
 *   - the shared authorization ceiling (`sharedAuthorizationMiddleware`, so
 *     `telemetry:write`), mounted exactly as the REST funnel mounts it;
 *   - the API-wide per-source limit (`apiRateLimit`, the same limiter
 *     instance, so REST and gRPC share one budget per source) and the
 *     receiver limit on the SIGNAL's surface inside the route (one accepted
 *     export per signal per interval per principal, whichever transport);
 *   - the principal derivation, the decoder, the translations, the envelope
 *     store, the dedupe identity, the quarantine and adapter health — all the
 *     route's own.
 *
 * The transport stamp is `api` (REST's): an OTLP/gRPC call is a direct network
 * ingress, and the `mcp` stamp belongs to the in-process MCP handler alone, so
 * an `mcp`-pinned credential is refused here exactly as it is on REST.
 *
 * THE ANSWER. The route answers in protobuf: on success an
 * `Export<Signal>ServiceResponse` (with `partial_success` when records were
 * refused) — delivered as the gRPC response message, status OK — and on
 * failure a `google.rpc.Status` whose code the route already chose, delivered
 * as the call's status. Refusals written before the route (authentication,
 * authorization, the source limit) are JSON and are mapped by HTTP status
 * (`grpcCodeForHttpStatus`). Every refusal carries the accepted-version
 * advertisement in trailers, and a `Retry-After` becomes a `google.rpc.
 * RetryInfo` in `grpc-status-details-bin`, which is what makes an OTLP/gRPC
 * exporter treat RESOURCE_EXHAUSTED as retryable.
 */
import http2 from 'http2';
import { IncomingMessage, ServerResponse } from 'http';
import { Duplex } from 'stream';
import express, { type Express, type NextFunction, type Response } from 'express';

import { PROTECTED_ROUTE_REGISTRATIONS } from '../../routeRegistry';
import { acceptPrincipalKey, REST_TRANSPORT_STAMP, type AuthRequest } from '../../middleware/auth';
import { sharedAuthorizationMiddleware } from '../../middleware/sharedAuthorization';
import { apiRateLimit } from '../../middleware/apiRateLimit';
import { apiErrorHandler } from '../../utils/apiErrors';
import { logCaughtFailure, logCaughtWarning } from '../../utils/secretSafeLog';
import type { TransportClass } from '../../utils/transportMap';
import { otlpAdvertisement } from '../../routes/telemetryOtlp';
import { OTLP_PROTOBUF_TYPE } from '../../utils/otlp/otlpHttp';
import {
  GRPC_STATUS,
  OTLP_GRPC_ACCEPTED_ENCODINGS,
  OTLP_GRPC_ADVERTISEMENT_METADATA,
  OTLP_GRPC_CODE_METADATA,
  OTLP_GRPC_INGRESS,
  OTLP_GRPC_MAX_MESSAGE_BYTES,
  OTLP_GRPC_MAX_WIRE_BYTES,
  OTLP_GRPC_METHOD_PATHS,
  OTLP_REFUSAL_CODE_LOCAL,
  boundedGrpcMessage,
  encodeGrpcMessage,
  grpcCodeForHttpStatus,
  grpcFrame,
  grpcStatusDetails,
  isGrpcProtobufContentType,
  otlpGrpcEncodingAccepted,
  parseOtlpGrpcPath,
  readGrpcUnaryMessage,
  readRpcStatus,
  safeRefusalCode,
  setOtlpGrpcListening,
} from '../../utils/otlp/otlpGrpc';

/** The one protected registration this ingress mounts. */
export const OTLP_GRPC_MOUNT = '/telemetry';

/** Server-derived provenance of every call through this ingress (see the header). */
export const OTLP_GRPC_TRANSPORT_STAMP: TransportClass = REST_TRANSPORT_STAMP;

/** Concurrent calls per HTTP/2 connection. An exporter sends one export at a time per signal. */
export const OTLP_GRPC_MAX_CONCURRENT_STREAMS = 32;

/** A request message that has not fully arrived after this long of silence is refused. */
export const OTLP_GRPC_READ_TIMEOUT_MS = 30_000;

/** Grace for in-flight calls when the listener closes, before connections are destroyed. */
const CLOSE_GRACE_MS = 5_000;

const NOT_A_PRINCIPAL_CREDENTIAL = {
  error: 'Unauthorized',
  message: 'The OTLP/gRPC receiver accepts a RelayHall principal credential only: send the call metadata authorization: Bearer rh_<env>_<keyId>.<secret>',
} as const;

/**
 * Authenticate one dispatched call. The SAME `acceptPrincipalKey` REST and MCP
 * call, evaluated against the route the call is dispatched to.
 */
export const otlpGrpcAuthMiddleware = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const mountedPath = `${req.baseUrl || ''}${req.path}`;
    const outcome = await acceptPrincipalKey(req, req.headers.authorization, mountedPath, OTLP_GRPC_TRANSPORT_STAMP);
    if (outcome.kind === 'ok') { next(); return; }
    if (outcome.kind === 'denied') { res.status(outcome.status).json(outcome.body); return; }
    res.status(401).json(NOT_A_PRINCIPAL_CREDENTIAL);
  } catch (err) {
    const errorId = logCaughtFailure('[OTLP gRPC] authentication failed:', err);
    res.status(500).json({ error: 'Internal Server Error', code: 'AUTH_FAILED', message: 'Authentication failed', errorId });
  }
};

/**
 * The internal app the listener dispatches into: the API-wide source limit,
 * then the telemetry registration from `routeRegistry` — the same router
 * object REST mounts — behind this ingress's authentication and the shared
 * authorization middleware, then the API error envelope. Nothing else is
 * mounted, and the listener only ever dispatches to `/telemetry/otlp/…`.
 */
export function buildOtlpGrpcApp(): Express {
  const registrations = PROTECTED_ROUTE_REGISTRATIONS.filter((registration) => registration.path === OTLP_GRPC_MOUNT);
  if (registrations.length !== 1) {
    throw new Error(`the OTLP/gRPC ingress expects exactly one ${OTLP_GRPC_MOUNT} registration in routeRegistry; found ${registrations.length}`);
  }
  const app = express();
  app.use(apiRateLimit);
  app.use(OTLP_GRPC_MOUNT, otlpGrpcAuthMiddleware, sharedAuthorizationMiddleware, registrations[0].router);
  app.use(apiErrorHandler);
  return app;
}

// ───────────────────────────── in-process dispatch ──────────────────────────

/** A never-connected socket, so `IncomingMessage`/`ServerResponse` have their usual shape. */
class DetachedSocket extends Duplex {
  readonly remoteFamily: string;
  readonly encrypted = false;
  constructor(readonly remoteAddress: string) {
    super();
    this.remoteFamily = remoteAddress.includes(':') ? 'IPv6' : 'IPv4';
  }
  _read(): void { /* nothing is ever pushed from the far side */ }
  _write(_chunk: unknown, _encoding: unknown, callback: (error?: Error | null) => void): void { callback(); }
}

export interface OtlpGrpcDispatch {
  /** `/telemetry/otlp/<version>/<signal>`, built from a parsed method path. */
  path: string;
  /** The call's `authorization` metadata, verbatim, or undefined. */
  authorization: string | undefined;
  /** The decompressed request message. */
  message: Buffer;
  /** The HTTP/2 peer address — the key the API-wide source limit counts on. */
  peer: string;
}

export interface OtlpHttpAnswer {
  status: number;
  contentType: string;
  body: Buffer;
  retryAfter: string | null;
  /** The route's own refusal code, when it set one. */
  refusalCode: unknown;
}

/** Run one export through the internal app and capture the HTTP answer, bytes intact. */
export function dispatchOtlpExport(app: Express, input: OtlpGrpcDispatch): Promise<OtlpHttpAnswer> {
  const socket = new DetachedSocket(input.peer);
  const req = new IncomingMessage(socket as never);
  req.method = 'POST';
  req.url = input.path;
  req.httpVersion = '1.1';
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;
  req.headers = {
    host: 'in-process.otlp-grpc.invalid',
    'content-type': OTLP_PROTOBUF_TYPE,
    'content-length': String(input.message.length),
    ...(input.authorization !== undefined ? { authorization: input.authorization } : {}),
  };
  // The server-side ingress stamp (see `OTLP_GRPC_INGRESS`): a symbol key, so
  // nothing a client sends can produce it.
  (req as unknown as Record<symbol, unknown>)[OTLP_GRPC_INGRESS] = true;
  req.push(input.message);
  req.push(null);

  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];

  return new Promise<OtlpHttpAnswer>((resolve, reject) => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (!res.headersSent) res.writeHead(res.statusCode);
      const type = res.getHeader('content-type');
      const retryAfter = res.getHeader('retry-after');
      const locals = (res as unknown as { locals?: Record<string, unknown> }).locals;
      resolve({
        status: res.statusCode,
        contentType: typeof type === 'string' ? type : '',
        body: Buffer.concat(chunks),
        retryAfter: retryAfter === undefined ? null : String(retryAfter),
        refusalCode: locals?.[OTLP_REFUSAL_CODE_LOCAL],
      });
    };
    const collect = (chunk: unknown, encoding?: unknown): void => {
      if (chunk === undefined || chunk === null || typeof chunk === 'function') return;
      const enc = typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8';
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), enc));
    };
    // Own properties: they survive express's `setPrototypeOf(res, app.response)`
    // and capture the answer before it would reach the detached socket.
    (res as unknown as Record<string, unknown>).write = (chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
      collect(chunk, encoding);
      const done = typeof encoding === 'function' ? encoding : callback;
      if (typeof done === 'function') (done as () => void)();
      return true;
    };
    (res as unknown as Record<string, unknown>).end = (chunk?: unknown, encoding?: unknown, callback?: unknown): ServerResponse => {
      collect(chunk, encoding);
      const done = [chunk, encoding, callback].find((candidate) => typeof candidate === 'function');
      if (typeof done === 'function') (done as () => void)();
      settle();
      return res;
    };
    try {
      app(req as never, res as never, (error?: unknown) => {
        if (error) { reject(error instanceof Error ? error : new Error(String(error))); return; }
        if (!settled) {
          settled = true;
          resolve({ status: 404, contentType: 'application/json', body: Buffer.from('{"error":"No such route"}'), retryAfter: null, refusalCode: null });
        }
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

// ───────────────────────────── the answer ───────────────────────────────────

export interface OtlpGrpcOutcome {
  code: number;
  message: string;
  /** The response message, for OK only. */
  response: Buffer | null;
  refusalCode: string | null;
  retryAfterSeconds: number | null;
}

/** The gRPC outcome of the route's HTTP answer (see the header for the rules). */
export function grpcOutcomeFor(answer: OtlpHttpAnswer): OtlpGrpcOutcome {
  const media = answer.contentType.split(';')[0].trim().toLowerCase();
  const protobuf = media === OTLP_PROTOBUF_TYPE;
  const retryAfterSeconds = answer.retryAfter !== null && /^\d{1,6}$/.test(answer.retryAfter.trim())
    ? Number(answer.retryAfter.trim()) : null;
  if (answer.status === 200) {
    if (!protobuf) {
      return { code: GRPC_STATUS.INTERNAL, message: 'the receiver produced no protobuf response', response: null, refusalCode: null, retryAfterSeconds: null };
    }
    return { code: GRPC_STATUS.OK, message: '', response: answer.body, refusalCode: null, retryAfterSeconds: null };
  }
  if (protobuf) {
    const status = readRpcStatus(answer.body);
    if (status && status.code !== GRPC_STATUS.OK) {
      return { code: status.code, message: status.message, response: null, refusalCode: safeRefusalCode(answer.refusalCode), retryAfterSeconds };
    }
  }
  let json: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(answer.body.toString('utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
  } catch { /* not JSON: the status alone decides */ }
  const message = typeof json?.message === 'string' ? json.message
    : typeof json?.error === 'string' ? json.error : `the receiver refused the export (HTTP ${answer.status})`;
  return {
    code: grpcCodeForHttpStatus(answer.status),
    message,
    response: null,
    refusalCode: safeRefusalCode(answer.refusalCode) ?? safeRefusalCode(json?.code),
    retryAfterSeconds,
  };
}

// ───────────────────────────── the listener ─────────────────────────────────

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function advertisementTrailers(): Record<string, string> {
  const advertisement = otlpAdvertisement() as {
    schemaFamily: string; acceptedMajors: readonly number[]; acceptedOtlpVersions: readonly string[]; acceptedOtlpSignals: readonly string[];
  };
  return {
    [OTLP_GRPC_ADVERTISEMENT_METADATA.schemaFamily]: advertisement.schemaFamily,
    [OTLP_GRPC_ADVERTISEMENT_METADATA.acceptedMajors]: advertisement.acceptedMajors.join(','),
    [OTLP_GRPC_ADVERTISEMENT_METADATA.acceptedOtlpVersions]: advertisement.acceptedOtlpVersions.join(','),
    [OTLP_GRPC_ADVERTISEMENT_METADATA.acceptedOtlpSignals]: advertisement.acceptedOtlpSignals.join(','),
  };
}

function writable(stream: http2.ServerHttp2Stream): boolean {
  return !stream.destroyed && !stream.closed && !stream.headersSent;
}

interface StatusOptions {
  refusalCode?: string | null;
  retryAfterSeconds?: number | null;
  /** True when the request body may still be arriving: stop it (RST_STREAM NO_ERROR). */
  early?: boolean;
}

/** A Trailers-Only response: HTTP 200, the status and its metadata in one HEADERS frame. */
function respondStatus(stream: http2.ServerHttp2Stream, code: number, message: string, options: StatusOptions = {}): void {
  if (!writable(stream)) return;
  const text = boundedGrpcMessage(message);
  const headers: http2.OutgoingHttpHeaders = {
    ':status': 200,
    'content-type': 'application/grpc',
    'grpc-accept-encoding': OTLP_GRPC_ACCEPTED_ENCODINGS.join(','),
    'grpc-status': String(code),
    'grpc-message': encodeGrpcMessage(text),
    ...advertisementTrailers(),
  };
  if (options.refusalCode) headers[OTLP_GRPC_CODE_METADATA] = options.refusalCode;
  if (options.retryAfterSeconds && options.retryAfterSeconds > 0) {
    headers['grpc-status-details-bin'] = grpcStatusDetails(code, text, options.retryAfterSeconds).toString('base64');
  }
  stream.respond(headers, { endStream: true });
  if (options.early) stream.close(http2.constants.NGHTTP2_NO_ERROR);
}

function respondMessage(stream: http2.ServerHttp2Stream, message: Buffer): void {
  if (!writable(stream)) return;
  stream.respond({
    ':status': 200,
    'content-type': 'application/grpc',
    'grpc-accept-encoding': OTLP_GRPC_ACCEPTED_ENCODINGS.join(','),
    'grpc-encoding': 'identity',
  }, { waitForTrailers: true });
  stream.once('wantTrailers', () => { stream.sendTrailers({ 'grpc-status': String(GRPC_STATUS.OK) }); });
  stream.end(grpcFrame(message));
}

type BodyRead =
  | { kind: 'body'; body: Buffer }
  | { kind: 'refused'; code: number; message: string }
  | { kind: 'aborted' };

/** Buffer the request body up to the wire bound, or refuse as soon as it is passed. */
function readBody(stream: http2.ServerHttp2Stream): Promise<BodyRead> {
  return new Promise<BodyRead>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (result: BodyRead): void => {
      if (done) return;
      done = true;
      stream.setTimeout(0);
      stream.off('data', onData);
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > OTLP_GRPC_MAX_WIRE_BYTES) {
        finish({ kind: 'refused', code: GRPC_STATUS.RESOURCE_EXHAUSTED, message: `the request message is larger than the ${OTLP_GRPC_MAX_MESSAGE_BYTES}-byte limit` });
        return;
      }
      chunks.push(chunk);
    };
    stream.setTimeout(OTLP_GRPC_READ_TIMEOUT_MS, () => {
      finish({ kind: 'refused', code: GRPC_STATUS.DEADLINE_EXCEEDED, message: 'the request message did not arrive in time' });
    });
    stream.on('data', onData);
    stream.once('end', () => finish({ kind: 'body', body: Buffer.concat(chunks) }));
    stream.once('close', () => finish({ kind: 'aborted' }));
  });
}

async function handleStream(app: Express, stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders): Promise<void> {
  // A client that resets its call is not a server fault; nothing to log.
  stream.on('error', () => undefined);
  try {
    // PROTOCOL-HTTP2: a request that is not gRPC is answered at the HTTP layer.
    if (headers[':method'] !== 'POST') {
      if (writable(stream)) stream.respond({ ':status': 405 }, { endStream: true });
      return;
    }
    if (!isGrpcProtobufContentType(single(headers['content-type']))) {
      if (writable(stream)) stream.respond({ ':status': 415 }, { endStream: true });
      return;
    }
    const call = parseOtlpGrpcPath(String(headers[':path'] ?? ''));
    if (!call) {
      respondStatus(stream, GRPC_STATUS.UNIMPLEMENTED,
        `this receiver serves the OTLP export methods ${OTLP_GRPC_METHOD_PATHS.join(', ')}`, { early: true });
      return;
    }
    const encoding = single(headers['grpc-encoding']);
    if (!otlpGrpcEncodingAccepted(encoding)) {
      respondStatus(stream, GRPC_STATUS.UNIMPLEMENTED,
        `grpc-encoding is accepted as ${OTLP_GRPC_ACCEPTED_ENCODINGS.join(', ')}`, { early: true });
      return;
    }

    const read = await readBody(stream);
    if (read.kind === 'aborted') return;
    if (read.kind === 'refused') { respondStatus(stream, read.code, read.message, { early: true }); return; }
    const unary = readGrpcUnaryMessage(read.body, encoding);
    if (!unary.ok) { respondStatus(stream, unary.code, unary.message); return; }

    const answer = await dispatchOtlpExport(app, {
      path: `${OTLP_GRPC_MOUNT}/otlp/${call.version}/${call.signalSegment}`,
      authorization: single(headers.authorization),
      message: unary.message,
      peer: stream.session?.socket?.remoteAddress ?? 'unknown',
    });
    const outcome = grpcOutcomeFor(answer);
    if (outcome.code === GRPC_STATUS.OK && outcome.response) {
      respondMessage(stream, outcome.response);
      return;
    }
    respondStatus(stream, outcome.code, outcome.message, {
      refusalCode: outcome.refusalCode,
      retryAfterSeconds: outcome.retryAfterSeconds,
    });
  } catch (err) {
    const errorId = logCaughtFailure('[OTLP gRPC] export call failed:', err);
    respondStatus(stream, GRPC_STATUS.UNAVAILABLE, `Failed to ingest the OTLP export (error ${errorId})`, {
      refusalCode: 'TELEMETRY_INGEST_FAILED',
    });
  }
}

export interface OtlpGrpcIngressOptions {
  port: number;
  /** Interface to bind; omitted = every interface (the container case). */
  host?: string;
  /** Test seam: the app calls are dispatched into. Production builds its own. */
  app?: Express;
}

export interface OtlpGrpcIngressHandle {
  /** The bound port (the real one when `port: 0` was asked for). */
  readonly port: number;
  close(): Promise<void>;
}

/** Bind the OTLP/gRPC listener. Resolves once it is listening; rejects on a bind error. */
export async function startOtlpGrpcIngress(options: OtlpGrpcIngressOptions): Promise<OtlpGrpcIngressHandle> {
  const app = options.app ?? buildOtlpGrpcApp();
  const server = http2.createServer({
    settings: { maxConcurrentStreams: OTLP_GRPC_MAX_CONCURRENT_STREAMS },
  });
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => { sessions.delete(session); });
    session.on('error', () => undefined);
  });
  server.on('stream', (stream, headers) => { void handleStream(app, stream, headers); });
  server.on('sessionError', (err) => { logCaughtWarning('[OTLP gRPC] connection failed:', err); });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => { reject(err); };
    server.once('error', onError);
    const onListening = (): void => { server.off('error', onError); resolve(); };
    if (options.host) server.listen(options.port, options.host, onListening);
    else server.listen(options.port, onListening);
  });
  server.on('error', (err) => { logCaughtFailure('[OTLP gRPC] listener error:', err); });
  setOtlpGrpcListening(true);

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  let closing: Promise<void> | null = null;
  return {
    port,
    close(): Promise<void> {
      if (closing) return closing;
      setOtlpGrpcListening(false);
      closing = new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const session of sessions) session.close();
        const force = setTimeout(() => { for (const session of sessions) session.destroy(); }, CLOSE_GRACE_MS);
        force.unref();
      });
      return closing;
    },
  };
}
