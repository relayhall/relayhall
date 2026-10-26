/**
 * The OTLP/gRPC wire contract, as pure functions (RH-TW1b slice 2, card
 * `dac2ca71`): method paths, the unary frame, compression and its bounds, the
 * status encodings, and the map from the HTTP route's answer to a gRPC status.
 *
 * The oracles here are written independently of `utils/otlp/otlpGrpc`: frames
 * are built by hand, compressed with zlib directly, and the status details are
 * read back with a reader of their own.
 */
import zlib from 'zlib';
import {
  GRPC_STATUS,
  OTLP_GRPC_MAX_MESSAGE_BYTES,
  OTLP_GRPC_MAX_WIRE_BYTES,
  OTLP_GRPC_METHOD_PATHS,
  encodeGrpcMessage,
  grpcCodeForHttpStatus,
  grpcFrame,
  grpcStatusDetails,
  isGrpcProtobufContentType,
  otlpGrpcEncodingAccepted,
  otlpGrpcPortFromEnv,
  parseOtlpGrpcPath,
  readGrpcUnaryMessage,
  readRpcStatus,
  safeRefusalCode,
} from '../utils/otlp/otlpGrpc';
import { OTLP_PROTOBUF_MAX_BYTES, otlpStatusBody } from '../utils/otlp/otlpHttp';

const frame = (flag: number, payload: Buffer, declared = payload.length): Buffer => {
  const header = Buffer.alloc(5);
  header[0] = flag;
  header.writeUInt32BE(declared, 1);
  return Buffer.concat([header, payload]);
};

describe('method paths', () => {
  it('serves exactly the three standard v1 collector services', () => {
    expect(OTLP_GRPC_METHOD_PATHS).toEqual([
      '/opentelemetry.proto.collector.trace.v1.TraceService/Export',
      '/opentelemetry.proto.collector.logs.v1.LogsService/Export',
      '/opentelemetry.proto.collector.metrics.v1.MetricsService/Export',
    ]);
    expect(OTLP_GRPC_METHOD_PATHS.map(parseOtlpGrpcPath)).toEqual([
      { signalSegment: 'traces', version: 'v1' },
      { signalSegment: 'logs', version: 'v1' },
      { signalSegment: 'metrics', version: 'v1' },
    ]);
  });

  it('resolves an unknown VERSION of a known signal, so the route can refuse it with the advertisement', () => {
    expect(parseOtlpGrpcPath('/opentelemetry.proto.collector.logs.v9.LogsService/Export'))
      .toEqual({ signalSegment: 'logs', version: 'v9' });
  });

  it('resolves an unknown SIGNAL by its own service name, like /telemetry/otlp/v1/profiles', () => {
    expect(parseOtlpGrpcPath('/opentelemetry.proto.collector.profiles.v1development.ProfilesService/Export'))
      .toEqual({ signalSegment: 'profiles', version: 'v1development' });
  });

  it.each([
    '/opentelemetry.proto.collector.trace.v1.LogsService/Export',
    '/opentelemetry.proto.collector.traces.v1.TracesService/Export',
    '/opentelemetry.proto.collector.trace.v1.TraceService/Exports',
    '/opentelemetry.proto.collector.trace.v1.TraceService/Export/extra',
    '/opentelemetry.proto.collector.trace.v1.TraceService',
    '/opentelemetry.proto.collector.trace.v1/TraceService/Export',
    '/opentelemetry.proto.collector.trace..TraceService/Export',
    '/opentelemetry.proto.collector.tr%2Face.v1.TraceService/Export',
    '/opentelemetry.proto.collector.trace.v1..%2F.TraceService/Export',
    '/grpc.health.v1.Health/Check',
    '/telemetry/otlp/v1/traces',
    '',
  ])('refuses %j as a method it does not serve', (path) => {
    expect(parseOtlpGrpcPath(path)).toBeNull();
  });

  it('never yields a segment that could leave /telemetry/otlp/<version>/<signal>', () => {
    for (const path of [
      '/opentelemetry.proto.collector.logs.v1.LogsService/Export',
      '/opentelemetry.proto.collector.abc_def.V_9.Abc_defService/Export',
    ]) {
      const call = parseOtlpGrpcPath(path);
      expect(call).not.toBeNull();
      expect(`${call!.version}/${call!.signalSegment}`).toMatch(/^[A-Za-z0-9_]+\/[A-Za-z0-9_]+$/);
    }
  });
});

describe('the unary request frame', () => {
  const message = Buffer.from('an export request');

  it('reads one uncompressed message', () => {
    expect(readGrpcUnaryMessage(frame(0, message), undefined)).toEqual({ ok: true, message });
  });

  it('reads gzip and deflate messages', () => {
    expect(readGrpcUnaryMessage(frame(1, zlib.gzipSync(message)), 'gzip')).toEqual({ ok: true, message });
    expect(readGrpcUnaryMessage(frame(1, zlib.deflateSync(message)), 'deflate')).toEqual({ ok: true, message });
  });

  it('reads an EMPTY message (an export with no resource) as an empty buffer', () => {
    expect(readGrpcUnaryMessage(frame(0, Buffer.alloc(0)), undefined)).toEqual({ ok: true, message: Buffer.alloc(0) });
  });

  it('refuses no message, a truncated frame, two messages and an unknown flag', () => {
    expect(readGrpcUnaryMessage(Buffer.alloc(0), undefined)).toMatchObject({ ok: false, code: GRPC_STATUS.INVALID_ARGUMENT });
    expect(readGrpcUnaryMessage(Buffer.from([0, 0, 0]), undefined)).toMatchObject({ ok: false, code: GRPC_STATUS.INTERNAL });
    expect(readGrpcUnaryMessage(frame(0, message, message.length + 3), undefined)).toMatchObject({ ok: false, code: GRPC_STATUS.INTERNAL });
    expect(readGrpcUnaryMessage(Buffer.concat([frame(0, message), frame(0, message)]), undefined))
      .toMatchObject({ ok: false, code: GRPC_STATUS.INVALID_ARGUMENT });
    expect(readGrpcUnaryMessage(frame(2, message), undefined)).toMatchObject({ ok: false, code: GRPC_STATUS.INTERNAL });
  });

  it('refuses a compressed flag without a declared encoding as INTERNAL (PROTOCOL-HTTP2)', () => {
    expect(readGrpcUnaryMessage(frame(1, zlib.gzipSync(message)), undefined)).toMatchObject({ ok: false, code: GRPC_STATUS.INTERNAL });
    expect(readGrpcUnaryMessage(frame(1, zlib.gzipSync(message)), 'identity')).toMatchObject({ ok: false, code: GRPC_STATUS.INTERNAL });
  });

  it('refuses bytes that do not decompress', () => {
    expect(readGrpcUnaryMessage(frame(1, Buffer.from('not gzip')), 'gzip')).toMatchObject({ ok: false, code: GRPC_STATUS.INTERNAL });
  });

  it('bounds the message at the OTLP/HTTP protobuf limit, from the same constant', () => {
    expect(OTLP_GRPC_MAX_MESSAGE_BYTES).toBe(OTLP_PROTOBUF_MAX_BYTES);
    expect(OTLP_GRPC_MAX_WIRE_BYTES).toBe(OTLP_PROTOBUF_MAX_BYTES + 5);
    // A declared length past the bound is refused before anything is read.
    expect(readGrpcUnaryMessage(frame(0, Buffer.alloc(0), OTLP_GRPC_MAX_MESSAGE_BYTES + 1), undefined))
      .toMatchObject({ ok: false, code: GRPC_STATUS.RESOURCE_EXHAUSTED });
    // A message exactly at the bound is read.
    const atBound = Buffer.alloc(OTLP_GRPC_MAX_MESSAGE_BYTES, 1);
    expect(readGrpcUnaryMessage(frame(0, atBound), undefined)).toMatchObject({ ok: true });
  });

  it('bounds the DECOMPRESSED size: a small gzip bomb is refused, the bound itself is read', () => {
    const bomb = zlib.gzipSync(Buffer.alloc(OTLP_GRPC_MAX_MESSAGE_BYTES + 1));
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(readGrpcUnaryMessage(frame(1, bomb), 'gzip')).toMatchObject({ ok: false, code: GRPC_STATUS.RESOURCE_EXHAUSTED });
    const exact = zlib.deflateSync(Buffer.alloc(OTLP_GRPC_MAX_MESSAGE_BYTES));
    const read = readGrpcUnaryMessage(frame(1, exact), 'deflate');
    expect(read.ok && read.message.length).toBe(OTLP_GRPC_MAX_MESSAGE_BYTES);
  });

  it('frames a response message with a zero flag and its big-endian length', () => {
    expect(grpcFrame(Buffer.from([7, 8, 9]))).toEqual(Buffer.from([0, 0, 0, 0, 3, 7, 8, 9]));
    expect(grpcFrame(Buffer.alloc(0))).toEqual(Buffer.from([0, 0, 0, 0, 0]));
  });
});

describe('headers', () => {
  it('speaks the protobuf gRPC content types only', () => {
    for (const type of ['application/grpc', 'application/grpc+proto', 'Application/GRPC; charset=utf-8']) {
      expect(isGrpcProtobufContentType(type)).toBe(true);
    }
    for (const type of ['application/grpc+json', 'application/x-protobuf', 'application/grpcx', '', undefined]) {
      expect(isGrpcProtobufContentType(type)).toBe(false);
    }
  });

  it('accepts identity, gzip and deflate message encodings only', () => {
    for (const encoding of [undefined, 'identity', 'gzip', 'deflate', ' GZIP ']) expect(otlpGrpcEncodingAccepted(encoding)).toBe(true);
    for (const encoding of ['snappy', 'br', 'zstd', '']) expect(otlpGrpcEncodingAccepted(encoding)).toBe(false);
  });

  it('percent-encodes grpc-message exactly as PROTOCOL-HTTP2 asks', () => {
    expect(encodeGrpcMessage('plain text, 100 ok')).toBe('plain text, 100 ok');
    expect(encodeGrpcMessage('50% done')).toBe('50%25 done');
    expect(encodeGrpcMessage('line\nbreak')).toBe('line%0Abreak');
    expect(encodeGrpcMessage('é')).toBe('%C3%A9');
    expect(decodeURIComponent(encodeGrpcMessage('mixed é % \t end'))).toBe('mixed é % \t end');
  });

  it('carries only code-shaped refusal codes into a trailer', () => {
    expect(safeRefusalCode('RATE_LIMITED')).toBe('RATE_LIMITED');
    for (const value of ['rate_limited', 'X', 'BAD CODE', 'A\nB', 42, null, undefined, {}]) expect(safeRefusalCode(value)).toBeNull();
  });
});

describe('statuses', () => {
  /** An independent reader for google.rpc.Status { code, message, details[] }. */
  function fields(bytes: Buffer): Array<{ field: number; value: bigint | Buffer }> {
    const out: Array<{ field: number; value: bigint | Buffer }> = [];
    let pos = 0;
    const varint = (): bigint => {
      let result = 0n; let shift = 0n;
      for (;;) { const b = bytes[pos++]; result |= BigInt(b & 0x7f) << shift; if ((b & 0x80) === 0) return result; shift += 7n; }
    };
    while (pos < bytes.length) {
      const tag = Number(varint());
      if ((tag & 7) === 0) out.push({ field: tag >> 3, value: varint() });
      else { const n = Number(varint()); out.push({ field: tag >> 3, value: bytes.subarray(pos, pos + n) }); pos += n; }
    }
    return out;
  }

  it('encodes RetryInfo with the delay in whole seconds when a refusal is retryable', () => {
    const details = fields(grpcStatusDetails(GRPC_STATUS.RESOURCE_EXHAUSTED, 'slow down', 2));
    expect(details[0]).toEqual({ field: 1, value: 8n });
    expect((details[1].value as Buffer).toString()).toBe('slow down');
    const any = fields(details[2].value as Buffer);
    expect((any[0].value as Buffer).toString()).toBe('type.googleapis.com/google.rpc.RetryInfo');
    const retryInfo = fields(any[1].value as Buffer);
    const duration = fields(retryInfo[0].value as Buffer);
    expect(duration).toEqual([{ field: 1, value: 2n }]);
  });

  it('carries no detail when there is no delay', () => {
    expect(fields(grpcStatusDetails(GRPC_STATUS.UNAVAILABLE, 'down', null)).map((f) => f.field)).toEqual([1, 2]);
  });

  it('reads back the google.rpc.Status the HTTP route writes, and nothing that is not one', () => {
    const body = otlpStatusBody('protobuf', 8, 'OTLP logs ingest rate limit') as Buffer;
    expect(readRpcStatus(body)).toEqual({ code: 8, message: 'OTLP logs ingest rate limit' });
    expect(readRpcStatus(Buffer.from('{"code":8}'))).toBeNull();
    expect(readRpcStatus(Buffer.from([0x08]))).toBeNull();
    expect(readRpcStatus(Buffer.alloc(0))).toBeNull();
  });

  it('maps a pre-route HTTP refusal to the gRPC status a producer acts on', () => {
    expect([400, 401, 403, 404, 413, 415, 429, 500, 502, 503, 409].map(grpcCodeForHttpStatus)).toEqual([
      GRPC_STATUS.INVALID_ARGUMENT, GRPC_STATUS.UNAUTHENTICATED, GRPC_STATUS.PERMISSION_DENIED, GRPC_STATUS.NOT_FOUND,
      GRPC_STATUS.RESOURCE_EXHAUSTED, GRPC_STATUS.INVALID_ARGUMENT, GRPC_STATUS.RESOURCE_EXHAUSTED,
      GRPC_STATUS.UNAVAILABLE, GRPC_STATUS.UNAVAILABLE, GRPC_STATUS.UNAVAILABLE, GRPC_STATUS.UNKNOWN,
    ]);
  });
});

describe('RELAYHALL_OTLP_GRPC_PORT', () => {
  it('unset or empty means no listener', () => {
    expect(otlpGrpcPortFromEnv(undefined)).toBeNull();
    expect(otlpGrpcPortFromEnv('')).toBeNull();
    expect(otlpGrpcPortFromEnv('  ')).toBeNull();
  });

  it('a port is a port', () => {
    expect(otlpGrpcPortFromEnv('4317')).toBe(4317);
    expect(otlpGrpcPortFromEnv(' 1 ')).toBe(1);
    expect(otlpGrpcPortFromEnv('65535')).toBe(65535);
  });

  it.each(['0', '65536', '-1', '4317x', '43.17', 'yes', '0x10DD', '999999'])('refuses %j rather than run without a receiver', (value) => {
    expect(() => otlpGrpcPortFromEnv(value)).toThrow(/RELAYHALL_OTLP_GRPC_PORT/);
  });
});
