/**
 * otlpHttp — the OTLP/HTTP wire contract the receivers answer in
 * (opentelemetry-proto `docs/specification.md`, "OTLP/HTTP"; RH-TW1b slice 1,
 * card `dac2ca71`).
 *
 * A response is written in the encoding the request was sent in. Success is
 * `200` with an `Export<Signal>ServiceResponse` whose `partial_success` carries
 * the rejected count and a message; an empty message (nothing rejected) is the
 * empty protobuf body or `{}`. Failures carry a `google.rpc.Status`. Every
 * message here is hand-encoded with the same five field numbers the OTLP
 * protos fix, so no generated code is needed.
 */
import type { OtlpSignal } from './otlpDecode';

export type OtlpEncoding = 'protobuf' | 'json';

export const OTLP_PROTOBUF_TYPE = 'application/x-protobuf';
export const OTLP_JSON_TYPE = 'application/json';

/** The largest OTLP/HTTP protobuf body (after decompression) the receivers read. */
export const OTLP_PROTOBUF_MAX_BYTES = 4 * 1024 * 1024;

/** `express.raw()` options for the protobuf receivers, in ONE place. */
export const otlpProtobufBodyOptions = { type: OTLP_PROTOBUF_TYPE, limit: OTLP_PROTOBUF_MAX_BYTES };

/** The request's encoding from its media type, or null for one the receivers do not speak. */
export function otlpEncodingOf(contentType: string | undefined): OtlpEncoding | null {
  const media = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (media === OTLP_PROTOBUF_TYPE) return 'protobuf';
  if (media === OTLP_JSON_TYPE) return 'json';
  return null;
}

/** The JSON name of `partial_success`'s rejected-count field, per signal. */
const REJECTED_FIELD: Readonly<Record<OtlpSignal, string>> = {
  traces: 'rejectedSpans',
  logs: 'rejectedLogRecords',
  metrics: 'rejectedDataPoints',
};

function varint(value: bigint | number): number[] {
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

function lengthDelimited(field: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([...varint(field * 8 + 2), ...varint(payload.length)]), payload]);
}

function varintField(field: number, value: bigint | number): Buffer {
  return Buffer.from([...varint(field * 8), ...varint(value)]);
}

/** Bound a message so a response can never become a channel for a large string. */
function bounded(message: string): string {
  return message.length > 1024 ? `${message.slice(0, 1021)}...` : message;
}

/** The success body: `Export<Signal>ServiceResponse { partial_success }`. */
export function otlpSuccessBody(
  encoding: OtlpEncoding, signal: OtlpSignal, rejected: number, message: string,
): Buffer | Record<string, unknown> {
  const text = bounded(message);
  if (encoding === 'json') {
    if (rejected === 0 && text.length === 0) return {};
    return { partialSuccess: { [REJECTED_FIELD[signal]]: String(rejected), errorMessage: text } };
  }
  if (rejected === 0 && text.length === 0) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  if (rejected > 0) parts.push(varintField(1, rejected));
  if (text.length > 0) parts.push(lengthDelimited(2, Buffer.from(text, 'utf8')));
  return lengthDelimited(1, Buffer.concat(parts));
}

/** gRPC status codes a google.rpc.Status names; only the ones these receivers send. */
export const OTLP_STATUS = {
  INVALID_ARGUMENT: 3,
  NOT_FOUND: 5,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
} as const;

/**
 * A failure body: `google.rpc.Status { code, message }`. In JSON the
 * receiver's own refusal code and any advertisement ride beside it — JSON
 * receivers ignore unknown keys, so a conforming client loses nothing.
 */
export function otlpStatusBody(
  encoding: OtlpEncoding, grpcCode: number, message: string, extra: Record<string, unknown> = {},
): Buffer | Record<string, unknown> {
  const text = bounded(message);
  if (encoding === 'json') return { code: grpcCode, message: text, ...extra };
  return Buffer.concat([varintField(1, grpcCode), lengthDelimited(2, Buffer.from(text, 'utf8'))]);
}

/** The partial-success message: refusal codes and their counts, most frequent first. */
export function otlpRejectionSummary(rejectedBy: Record<string, number>): string {
  return Object.entries(rejectedBy)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, count]) => `${count} ${code}`)
    .join('; ');
}
