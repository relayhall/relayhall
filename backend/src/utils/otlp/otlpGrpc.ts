/**
 * otlpGrpc — the OTLP/gRPC wire contract (opentelemetry-proto
 * `docs/specification.md`, "OTLP/gRPC"; gRPC `PROTOCOL-HTTP2.md`; RH-TW1b slice
 * 2, card `dac2ca71`, absorbed estate card `928586a6`).
 *
 * WHY THERE IS NO gRPC LIBRARY ON THE SERVER. An OTLP/gRPC export is a unary
 * call whose request message is byte-for-byte the protobuf body an OTLP/HTTP
 * producer POSTs, and whose response is byte-for-byte the protobuf body the
 * HTTP receiver answers. The HTTP/2 transport is Node's own `http2` module; the
 * gRPC layer on top of it for a unary call is a five-byte length prefix, an
 * optional per-message compression, and a status carried in trailers. All of
 * that is in this file, with no generated code and no `.proto` files, exactly
 * as slice 1 decoded protobuf without them — so the receiver adds no runtime
 * dependency, and the request message reaches THE SAME decoder, translations
 * and envelope store the HTTP receivers use (no second write path). The test
 * suites drive it with a real gRPC client library, which is the interop proof.
 *
 * Everything here is pure: framing, paths, status and metadata encoding, and
 * the mapping from the HTTP route's answer to a gRPC status. The listener and
 * the in-process dispatch live in `services/otlp/OtlpGrpcIngress`.
 */
import zlib from 'zlib';
import type { OtlpSignal } from './otlpDecode';
import { OTLP_SIGNALS } from './otlpDecode';
import { OTLP_PROTOBUF_MAX_BYTES } from './otlpHttp';

// ───────────────────────────── status codes ─────────────────────────────────

/** The gRPC status codes this receiver answers with (grpc `doc/statuscodes.md`). */
export const GRPC_STATUS = {
  OK: 0,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
} as const;

// ───────────────────────────── services ─────────────────────────────────────

interface OtlpGrpcService { readonly packageSignal: string; readonly service: string }

/** The three standard OTLP collector services, by the HTTP receiver's signal name. */
export const OTLP_GRPC_SERVICES: Readonly<Record<OtlpSignal, OtlpGrpcService>> = {
  traces: { packageSignal: 'trace', service: 'TraceService' },
  logs: { packageSignal: 'logs', service: 'LogsService' },
  metrics: { packageSignal: 'metrics', service: 'MetricsService' },
};

/** The OTLP protocol version whose services this receiver serves. */
export const OTLP_GRPC_SERVED_VERSION = 'v1';

/** `/opentelemetry.proto.collector.<signal>.<version>.<Service>/Export` */
export function otlpGrpcMethodPath(signal: OtlpSignal, version = OTLP_GRPC_SERVED_VERSION): string {
  const { packageSignal, service } = OTLP_GRPC_SERVICES[signal];
  return `/opentelemetry.proto.collector.${packageSignal}.${version}.${service}/Export`;
}

/** The three method paths a v1 producer calls. */
export const OTLP_GRPC_METHOD_PATHS: readonly string[] = OTLP_SIGNALS.map((signal) => otlpGrpcMethodPath(signal));

/**
 * One OTLP export call, resolved to the HTTP receiver's path segments. The
 * tokens are restricted to `[A-Za-z0-9_]`, so they are safe as path segments
 * and can never introduce a `/`, a `..` or a query.
 */
export interface OtlpGrpcCall {
  /** The HTTP receiver's signal segment: `traces`, `logs`, `metrics`, or an unknown signal's own token. */
  readonly signalSegment: string;
  /** The OTLP version segment, e.g. `v1`; any other version is refused by the route with the advertisement. */
  readonly version: string;
}

const OTLP_GRPC_PATH_RE = /^\/opentelemetry\.proto\.collector\.([a-z][a-z0-9_]{0,31})\.([A-Za-z0-9_]{1,32})\.([A-Z][A-Za-z0-9_]{0,63})\/Export$/;

/**
 * Resolve a gRPC `:path` to an OTLP export call, or null for a method this
 * receiver does not recognise at all.
 *
 *   - a known signal package must name ITS service (`trace` → `TraceService`);
 *     `…trace.v1.LogsService/Export` is not an OTLP method and is null;
 *   - an unknown version of a known signal resolves (the route refuses it with
 *     OTLP_VERSION_NOT_ACCEPTED and counts it on adapter health, exactly as it
 *     does `/telemetry/otlp/v9/logs` over HTTP);
 *   - an unknown signal package resolves to its own token when its service is
 *     named `<Token>Service` (e.g. `profiles` → `ProfilesService`), so the route
 *     refuses it with OTLP_SIGNAL_NOT_ACCEPTED like `/telemetry/otlp/v1/profiles`.
 */
export function parseOtlpGrpcPath(path: string): OtlpGrpcCall | null {
  const match = OTLP_GRPC_PATH_RE.exec(path);
  if (!match) return null;
  const [, packageSignal, version, service] = match;
  const known = OTLP_SIGNALS.find((signal) => OTLP_GRPC_SERVICES[signal].packageSignal === packageSignal);
  if (known) {
    return service === OTLP_GRPC_SERVICES[known].service ? { signalSegment: known, version } : null;
  }
  // `traces` is the HTTP spelling of the `trace` package: never an unknown signal.
  if (OTLP_SIGNALS.includes(packageSignal as OtlpSignal)) return null;
  const expectedService = `${packageSignal.charAt(0).toUpperCase()}${packageSignal.slice(1)}Service`;
  return service === expectedService ? { signalSegment: packageSignal, version } : null;
}

// ───────────────────────────── framing ──────────────────────────────────────

/** Compressed-flag byte + four-byte big-endian length. */
export const GRPC_FRAME_HEADER_BYTES = 5;

/** The per-message encodings this receiver decompresses, in the order it advertises them. */
export const OTLP_GRPC_ACCEPTED_ENCODINGS: readonly string[] = ['identity', 'gzip', 'deflate'];

/**
 * The largest request MESSAGE (after decompression) the receiver reads: the
 * same bound as the OTLP/HTTP protobuf body, from the same constant.
 */
export const OTLP_GRPC_MAX_MESSAGE_BYTES = OTLP_PROTOBUF_MAX_BYTES;

/**
 * The largest request BODY the listener buffers before it refuses: one frame
 * header plus one message at the bound. A COMPRESSED message larger than the
 * bound is refused as well — a compressed OTLP export is never meaningfully
 * larger than the export itself, so nothing legitimate is lost.
 */
export const OTLP_GRPC_MAX_WIRE_BYTES = GRPC_FRAME_HEADER_BYTES + OTLP_GRPC_MAX_MESSAGE_BYTES;

/** One message as a length-prefixed, uncompressed gRPC frame. */
export function grpcFrame(message: Buffer): Buffer {
  const header = Buffer.alloc(GRPC_FRAME_HEADER_BYTES);
  header.writeUInt8(0, 0);
  header.writeUInt32BE(message.length, 1);
  return Buffer.concat([header, message]);
}

export type GrpcUnaryRead =
  | { ok: true; message: Buffer }
  | { ok: false; code: number; message: string };

const refusal = (code: number, message: string): GrpcUnaryRead => ({ ok: false, code, message });

/**
 * The ONE request message of a unary call, decompressed and bounded.
 *
 * `encoding` is the request's `grpc-encoding` header (absent = identity). The
 * caller has already refused an encoding outside `OTLP_GRPC_ACCEPTED_ENCODINGS`
 * (that refusal must name the accepted set in a response header).
 */
export function readGrpcUnaryMessage(body: Buffer, encoding: string | undefined): GrpcUnaryRead {
  if (body.length === 0) {
    return refusal(GRPC_STATUS.INVALID_ARGUMENT, 'an OTLP export call carries exactly one request message; none arrived');
  }
  if (body.length < GRPC_FRAME_HEADER_BYTES) return refusal(GRPC_STATUS.INTERNAL, 'the request message frame is truncated');
  const flag = body.readUInt8(0);
  const length = body.readUInt32BE(1);
  if (flag !== 0 && flag !== 1) return refusal(GRPC_STATUS.INTERNAL, 'the request message frame has an unknown flag');
  if (length > OTLP_GRPC_MAX_MESSAGE_BYTES) {
    return refusal(GRPC_STATUS.RESOURCE_EXHAUSTED,
      `the request message is larger than the ${OTLP_GRPC_MAX_MESSAGE_BYTES}-byte limit`);
  }
  const end = GRPC_FRAME_HEADER_BYTES + length;
  if (body.length < end) return refusal(GRPC_STATUS.INTERNAL, 'the request message frame is truncated');
  if (body.length > end) {
    return refusal(GRPC_STATUS.INVALID_ARGUMENT, 'an OTLP export call carries exactly one request message; more arrived');
  }
  const payload = body.subarray(GRPC_FRAME_HEADER_BYTES, end);
  if (flag === 0) return { ok: true, message: payload };

  const named = (encoding ?? 'identity').trim().toLowerCase();
  if (named === 'identity') {
    // PROTOCOL-HTTP2: a compressed message without a message encoding is INTERNAL.
    return refusal(GRPC_STATUS.INTERNAL, 'the request message is flagged compressed but no grpc-encoding was declared');
  }
  try {
    // `maxOutputLength` bounds the INFLATED size: a small compressed message
    // cannot expand past the limit, which is the decompression-bomb case.
    const options = { maxOutputLength: OTLP_GRPC_MAX_MESSAGE_BYTES };
    const message = named === 'gzip' ? zlib.gunzipSync(payload, options) : zlib.inflateSync(payload, options);
    return { ok: true, message };
  } catch (err) {
    if (err instanceof RangeError || (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      return refusal(GRPC_STATUS.RESOURCE_EXHAUSTED,
        `the decompressed request message is larger than the ${OTLP_GRPC_MAX_MESSAGE_BYTES}-byte limit`);
    }
    return refusal(GRPC_STATUS.INTERNAL, `the request message could not be decompressed as ${named}`);
  }
}

/** True when `grpc-encoding` names an encoding this receiver can read (absent = identity). */
export function otlpGrpcEncodingAccepted(encoding: string | undefined): boolean {
  return OTLP_GRPC_ACCEPTED_ENCODINGS.includes((encoding ?? 'identity').trim().toLowerCase());
}

/**
 * gRPC carries protobuf in `application/grpc` and `application/grpc+proto`
 * (parameters allowed). Any other subtype (`+json`) is not a codec this
 * receiver speaks.
 */
export function isGrpcProtobufContentType(contentType: string | undefined): boolean {
  const media = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return media === 'application/grpc' || media === 'application/grpc+proto';
}

// ───────────────────────────── status encoding ──────────────────────────────

/** Bound a message so a status can never become a channel for a large string. */
export function boundedGrpcMessage(message: string): string {
  return message.length > 1024 ? `${message.slice(0, 1021)}...` : message;
}

/**
 * `grpc-message` is percent-encoded (PROTOCOL-HTTP2 "Status-Message"): every
 * UTF-8 byte outside 0x20–0x7E, and `%` itself, becomes `%XX`.
 */
export function encodeGrpcMessage(message: string): string {
  let out = '';
  for (const byte of Buffer.from(message, 'utf8')) {
    out += byte >= 0x20 && byte <= 0x7e && byte !== 0x25
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function varint(value: number | bigint): number[] {
  let v = BigInt(value);
  if (v < 0n) v = BigInt.asUintN(64, v);
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return out;
}
const lengthDelimited = (field: number, payload: Buffer): Buffer =>
  Buffer.concat([Buffer.from([...varint(field * 8 + 2), ...varint(payload.length)]), payload]);
const varintField = (field: number, value: number | bigint): Buffer => Buffer.from([...varint(field * 8), ...varint(value)]);

export const GRPC_RETRY_INFO_TYPE_URL = 'type.googleapis.com/google.rpc.RetryInfo';

/**
 * `grpc-status-details-bin`: a `google.rpc.Status { code, message, details }`
 * whose one detail, when the refusal is retryable after a delay, is a
 * `google.rpc.RetryInfo { retry_delay: Duration { seconds } }`. The OTLP/gRPC
 * specification makes RESOURCE_EXHAUSTED retryable ONLY when RetryInfo is
 * present, so this is what tells an exporter that a receiver-limit refusal is
 * a "wait and resend", as `Retry-After` does on HTTP.
 */
export function grpcStatusDetails(code: number, message: string, retryAfterSeconds: number | null): Buffer {
  const parts: Buffer[] = [varintField(1, code), lengthDelimited(2, Buffer.from(boundedGrpcMessage(message), 'utf8'))];
  if (retryAfterSeconds !== null && retryAfterSeconds > 0) {
    const duration = varintField(1, Math.ceil(retryAfterSeconds));
    const retryInfo = lengthDelimited(1, duration);
    const any = Buffer.concat([
      lengthDelimited(1, Buffer.from(GRPC_RETRY_INFO_TYPE_URL, 'utf8')),
      lengthDelimited(2, retryInfo),
    ]);
    parts.push(lengthDelimited(3, any));
  }
  return Buffer.concat(parts);
}

/**
 * Read `google.rpc.Status { code = 1; message = 2 }` from a protobuf body — the
 * failure body the OTLP/HTTP route writes. Null for anything that is not one
 * (a malformed body is never guessed at).
 */
export function readRpcStatus(body: Buffer): { code: number; message: string } | null {
  let pos = 0;
  let code: number | null = null;
  let message = '';
  const readVarint = (): bigint | null => {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i += 1) {
      if (pos >= body.length) return null;
      const byte = body[pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
    return null;
  };
  while (pos < body.length) {
    const tag = readVarint();
    if (tag === null) return null;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === 0) {
      const value = readVarint();
      if (value === null) return null;
      if (field === 1) code = Number(BigInt.asIntN(32, value));
    } else if (wire === 2) {
      const length = readVarint();
      if (length === null || pos + Number(length) > body.length) return null;
      const bytes = body.subarray(pos, pos + Number(length));
      pos += Number(length);
      if (field === 2) message = bytes.toString('utf8');
    } else if (wire === 1) {
      if (pos + 8 > body.length) return null;
      pos += 8;
    } else if (wire === 5) {
      if (pos + 4 > body.length) return null;
      pos += 4;
    } else {
      return null;
    }
  }
  return code === null ? null : { code, message };
}

/**
 * The gRPC status for an HTTP answer whose body is NOT a `google.rpc.Status` —
 * the refusals written before the OTLP route runs (authentication, the shared
 * authorization ceiling, the API-wide source limit, the error envelope). A
 * Status body the route wrote is delivered with its own code, never this map.
 */
export function grpcCodeForHttpStatus(status: number): number {
  switch (status) {
    case 400: return GRPC_STATUS.INVALID_ARGUMENT;
    case 401: return GRPC_STATUS.UNAUTHENTICATED;
    case 403: return GRPC_STATUS.PERMISSION_DENIED;
    case 404: return GRPC_STATUS.NOT_FOUND;
    case 413: return GRPC_STATUS.RESOURCE_EXHAUSTED;
    case 415: return GRPC_STATUS.INVALID_ARGUMENT;
    case 429: return GRPC_STATUS.RESOURCE_EXHAUSTED;
    default:
      // A server fault is transient from the producer's side: UNAVAILABLE is
      // the retryable code, which is the answer the OTLP route itself gives
      // its own failures (google.rpc.Status UNAVAILABLE on its 500 and 503).
      return status >= 500 ? GRPC_STATUS.UNAVAILABLE : GRPC_STATUS.UNKNOWN;
  }
}

// ───────────────────────────── metadata ─────────────────────────────────────

/** Trailer carrying the receiver's own refusal code (e.g. `RATE_LIMITED`), when it has one. */
export const OTLP_GRPC_CODE_METADATA = 'relayhall-code';
/** Trailers carrying the accepted-version advertisement on every refusal. */
export const OTLP_GRPC_ADVERTISEMENT_METADATA = {
  schemaFamily: 'relayhall-schema-family',
  acceptedMajors: 'relayhall-accepted-majors',
  acceptedOtlpVersions: 'relayhall-accepted-otlp-versions',
  acceptedOtlpSignals: 'relayhall-accepted-otlp-signals',
} as const;

const REFUSAL_CODE_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

/** A refusal code fit for a trailer, or null — never a free-form string. */
export function safeRefusalCode(value: unknown): string | null {
  return typeof value === 'string' && REFUSAL_CODE_RE.test(value) ? value : null;
}

// ───────────────────── the route ↔ ingress handshake ────────────────────────

/**
 * Set on a request object by the OTLP/gRPC ingress, AFTER transport
 * termination, before it is dispatched through the telemetry router. A symbol
 * property cannot be written by anything a client sends — no header, path,
 * query or body parser produces a symbol key — so the route can trust it to
 * choose the adapter-health source (`otlp-grpc` rather than `otlp-http`), the
 * same way the MCP ingress's transport stamp is a server-side constant.
 */
export const OTLP_GRPC_INGRESS: unique symbol = Symbol('relayhall.otlp.grpc-ingress');

/** `res.locals` key under which the OTLP route records its refusal code for the gRPC ingress. */
export const OTLP_REFUSAL_CODE_LOCAL = 'otlpRefusalCode';

// ───────────────────────────── configuration ────────────────────────────────

/** The container port the deployment files publish the receiver on (the OTLP/gRPC default). */
export const OTLP_GRPC_DEFAULT_CONTAINER_PORT = 4317;

/**
 * `RELAYHALL_OTLP_GRPC_PORT`: unset or empty = the listener is NOT started.
 * Anything else must be a whole TCP port, or the boot refuses — a typo must
 * never silently become "no receiver".
 */
export function otlpGrpcPortFromEnv(value: string | undefined): number | null {
  const raw = (value ?? '').trim();
  if (raw === '') return null;
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(port >= 1 && port <= 65535)) {
    throw new Error('RELAYHALL_OTLP_GRPC_PORT must be a TCP port number (1-65535), or empty to disable the OTLP/gRPC receiver');
  }
  return port;
}

let listening = false;

/** Recorded by the ingress when its listener binds and when it closes; read by discovery. */
export function setOtlpGrpcListening(value: boolean): void {
  listening = value;
}

/** Whether this process is serving OTLP/gRPC right now. */
export function otlpGrpcListening(): boolean {
  return listening;
}
