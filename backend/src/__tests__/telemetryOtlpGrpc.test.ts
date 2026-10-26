/**
 * The OTLP/gRPC receivers (card `dac2ca71`, slice 2; estate card `928586a6`),
 * driven by a REAL gRPC client (`@grpc/grpc-js`) over a real HTTP/2 socket
 * into the real listener, which dispatches into the PRODUCTION telemetry
 * router. Only the pool and the audit sink are doubles.
 *
 *   - ONE PATH: every committed capture (26: Claude Code over protobuf and
 *     JSON, the OpenTelemetry Python SDK over protobuf) exported over gRPC
 *     stores BYTE-IDENTICAL `session_events` rows — every insert parameter,
 *     payload text, payload hash, idempotency key and raw blob included — to the
 *     same capture POSTed over OTLP/HTTP, under a frozen clock; the answer is
 *     the same partial success;
 *   - the same refusals, as gRPC statuses with the OTLP partial-success rules:
 *     per-record refusals stay inside an OK; the receiver limit is
 *     RESOURCE_EXHAUSTED with RetryInfo and is ONE budget across both
 *     transports; a deployment fault is UNAVAILABLE with RetryInfo; an unknown
 *     version or signal is NOT_FOUND with the advertisement and is counted on
 *     the Connector's `otlp-grpc` adapter-health row;
 *   - the same size bound, after decompression, and the gRPC framing rules;
 *   - the production ingress app authenticates `rh_` principal credentials
 *     only, and the API-wide source limit is the REST limiter itself.
 */
// A legacy service key IS configured in this process, before any module reads
// it, so the "rh_ only" case below is a real refusal of a key REST would accept.
const LEGACY_SERVICE_KEY = 'legacy-service-key-configured-for-the-grpc-suite';
process.env.RELAYHALL_API_KEY = LEGACY_SERVICE_KEY;
import express from 'express';
import http2 from 'http2';
import zlib from 'zlib';
import type { AddressInfo } from 'net';
import * as grpc from '@grpc/grpc-js';

const db = {
  connectors: new Set<string>(),
  descriptor: null as null | { tier: string; products?: string[] },
  rateLimits: new Map<string, number>(),
  keys: new Set<string>(),
  inserts: [] as Array<{ key: string; params: string }>,
  health: [] as Array<{ source: string; instance: string; status: string; reason: string | null; details: any }>,
  queries: 0,
};

jest.mock('../db/connection', () => ({
  pool: {
    query: jest.fn(async (text: string, params?: unknown[]) => {
      db.queries += 1;
      const p = (params ?? []) as any[];
      if (text.includes('AS is_connector')) return { rows: [{ is_connector: db.connectors.has(String(p[0])) }] };
      if (text.includes('service_descriptor_versions')) {
        return db.descriptor ? { rows: [{ descriptor: { options: [], telemetry: db.descriptor }, version: 3 }] } : { rows: [] };
      }
      if (/INSERT INTO telemetry_rate_limits/.test(text)) {
        const [principalId, surface, nowIso, intervalMs] = p as string[];
        const key = `${principalId}|${surface}`;
        const now = new Date(nowIso).getTime();
        const last = db.rateLimits.get(key);
        if (last !== undefined && now - last < Number(intervalMs)) return { rows: [], rowCount: 0 };
        db.rateLimits.set(key, now);
        return { rows: [{ won: 1 }], rowCount: 1 };
      }
      if (/UPDATE telemetry_rate_limits/.test(text)) {
        const last = db.rateLimits.get(`${p[0]}|${p[1]}`);
        return { rows: last === undefined ? [] : [{ last_accepted_at: new Date(last).toISOString() }] };
      }
      if (/INSERT INTO session_events/.test(text)) {
        const key = String(p[19]);
        // EVERY parameter, serialised exactly: the byte-identity oracle.
        db.inserts.push({ key, params: JSON.stringify(p) });
        if (db.keys.has(key)) return { rows: [{ event_id: null, raw_ref: null }], rowCount: 1 };
        db.keys.add(key);
        return { rows: [{ event_id: `evt-${db.keys.size}`, raw_ref: `blob-${db.keys.size}` }], rowCount: 1 };
      }
      if (/INSERT INTO session_adapter_health/.test(text)) {
        db.health.push({ source: p[0], instance: p[1], status: p[3], reason: p[4], details: JSON.parse(p[9]) });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  },
}));

const auditRecord = jest.fn(async (..._args: any[]) => ({ id: 'audit-1' } as any));
jest.mock('../services/AuditService', () => ({
  auditService: { record: (...args: unknown[]) => auditRecord(...(args as [])) },
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const telemetryRouter = require('../routes/telemetry').default;
const { startOtlpGrpcIngress, buildOtlpGrpcApp } = require('../services/otlp/OtlpGrpcIngress');
/* eslint-enable @typescript-eslint/no-var-requires */
// eslint-disable-next-line import/first
import { loadOtlpFixtures, jsonLogsExport, encodeOtlpJsonAsProtobuf, s, type OtlpFixture } from './support/otlpFixtures';
import { resetTelemetryPepperCache } from '../utils/telemetryPepper';
import { decodeOtlpJson, decodeOtlpProtobuf, type OtlpSignal } from '../utils/otlp/otlpDecode';
import { OTLP_PROTOBUF_MAX_BYTES } from '../utils/otlp/otlpHttp';
import { GRPC_STATUS, OTLP_GRPC_METHOD_PATHS, otlpGrpcMethodPath } from '../utils/otlp/otlpGrpc';

const ACCOUNT = '00000000-0000-4000-8000-00000000acc7';
const CONNECTOR = '00000000-0000-4000-8000-0000000c0nn3';
const AGENT = '00000000-0000-4000-8000-00000000a63n';
const link = (principalId: string, kind: string, parent: string | null) => ({
  principalId, kind, role: null, parentPrincipalId: parent, boundTaskId: null, legacyIdentity: false, ownExpression: null,
});
const CHAIN = {
  connector: [link(CONNECTOR, 'service', ACCOUNT), link(ACCOUNT, 'human', null)],
  directAccountAgent: [link(AGENT, 'agent', ACCOUNT), link(ACCOUNT, 'human', null)],
};
const identity = { principalId: CONNECTOR, links: CHAIN.connector as ReturnType<typeof link>[] };

const fixtures = loadOtlpFixtures();
const fixture = (name: string): OtlpFixture => {
  const found = fixtures.find((f) => f.name === name);
  if (!found) throw new Error(`no fixture ${name}`);
  return found;
};
/** The protobuf a producer would put in the gRPC request message for this capture. */
const protobufOf = (f: OtlpFixture): Buffer => (f.json ? encodeOtlpJsonAsProtobuf(f.signal, f.json) : f.body);

// THE CLOCK IS FROZEN — only `Date`; every timer and the event loop stay real
// — so `observed_at` and the raw-blob timestamps are the same instant on both
// transports and a whole insert can be compared byte for byte.
const FROZEN = new Date('2026-10-20T06:00:00.000Z');

let httpServer: ReturnType<typeof express.application.listen>;
let base: string;
let ingress: { port: number; close(): Promise<void> };
let client: grpc.Client;
let gzipClient: grpc.Client;

beforeAll(async () => {
  jest.useFakeTimers({
    now: FROZEN,
    doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
      'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance'],
  });
  // ONE app serves both transports, so the identity a request carries is the
  // same object either way and the comparison isolates the transport.
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).principal = { id: identity.principalId, handle: 'outpost-1' };
    (req as any).delegationLinks = identity.links;
    (req as any).authMethod = 'principal_api_key';
    (req as any).credentialId = 'cred-1';
    (req as any).scopes = ['telemetry:write'];
    next();
  });
  app.use('/telemetry', telemetryRouter);
  await new Promise<void>((resolve) => { httpServer = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  ingress = await startOtlpGrpcIngress({ port: 0, host: '127.0.0.1', app });
  client = new grpc.Client(`127.0.0.1:${ingress.port}`, grpc.credentials.createInsecure());
  gzipClient = new grpc.Client(`127.0.0.1:${ingress.port}`, grpc.credentials.createInsecure(), {
    'grpc.default_compression_algorithm': 2, // gzip
  });
});
afterAll(async () => {
  client?.close();
  gzipClient?.close();
  await ingress?.close();
  await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
  jest.useRealTimers();
});
function reset(): void {
  db.rateLimits.clear(); db.keys.clear(); db.inserts.length = 0; db.health.length = 0; db.queries = 0;
}
beforeEach(() => {
  process.env.RELAYHALL_TELEMETRY_PEPPERS = JSON.stringify({ t: Buffer.alloc(32, 5).toString('base64') });
  process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER = 't';
  resetTelemetryPepperCache();
  reset();
  db.connectors = new Set([CONNECTOR]);
  db.descriptor = { tier: 'full', products: ['claude-code', 'otel-python-sample'] };
  identity.principalId = CONNECTOR;
  identity.links = CHAIN.connector;
  auditRecord.mockClear();
});
afterEach(() => {
  delete process.env.RELAYHALL_TELEMETRY_PEPPERS;
  delete process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER;
});

interface GrpcAnswer {
  code: number;
  details: string;
  response: Buffer | null;
  trailers: Record<string, string>;
  statusDetails: Buffer | null;
}

function exportOver(via: grpc.Client, path: string, message: Buffer, metadata: Record<string, string> = {}): Promise<GrpcAnswer> {
  return new Promise((resolve) => {
    const md = new grpc.Metadata();
    for (const [key, value] of Object.entries(metadata)) md.set(key, value);
    let response: Buffer | null = null;
    const call = via.makeUnaryRequest<Buffer, Buffer>(
      path, (b: Buffer) => b, (b: Buffer) => b, message, md, {},
      (err, value) => { response = err ? null : (value ?? null); },
    );
    call.on('status', (status: grpc.StatusObject) => {
      const trailers: Record<string, string> = {};
      for (const [key, value] of Object.entries(status.metadata.getMap())) {
        if (typeof value === 'string') trailers[key] = value;
      }
      const bin = status.metadata.get('grpc-status-details-bin')[0];
      // `setImmediate`: the callback above runs before or with 'status'.
      setImmediate(() => resolve({
        code: status.code, details: status.details, response, trailers,
        statusDetails: Buffer.isBuffer(bin) ? bin : null,
      }));
    });
  });
}
const exportGrpc = (signal: OtlpSignal, message: Buffer, metadata?: Record<string, string>) =>
  exportOver(client, otlpGrpcMethodPath(signal), message, metadata);

async function post(path: string, contentType: string, body: Buffer | string) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': contentType }, body });
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
}

/** Rejected count from a partial-success response in either encoding. */
function rejectedIn(bytes: Buffer, json: boolean): number {
  if (json) {
    const partial = JSON.parse(bytes.toString('utf8')).partialSuccess ?? {};
    return Number(partial.rejectedSpans ?? partial.rejectedLogRecords ?? partial.rejectedDataPoints ?? 0);
  }
  if (bytes.length === 0) return 0;
  let pos = 0;
  const varint = (b: Buffer): number => { let r = 0; let m = 1; for (;;) { const x = b[pos++]; r += (x & 0x7f) * m; if ((x & 0x80) === 0) return r; m *= 128; } };
  pos = 1; const innerLength = varint(bytes); const inner = bytes.subarray(pos, pos + innerLength);
  pos = 0; if (inner[pos++] !== 0x08) return 0;
  return varint(inner);
}

/** Fields of one protobuf message: an independent reader for the status details. */
function protoFields(bytes: Buffer): Map<number, Array<bigint | Buffer>> {
  const out = new Map<number, Array<bigint | Buffer>>();
  let pos = 0;
  const varint = (): bigint => {
    let result = 0n; let shift = 0n;
    for (;;) { const b = bytes[pos++]; result |= BigInt(b & 0x7f) << shift; if ((b & 0x80) === 0) return result; shift += 7n; }
  };
  while (pos < bytes.length) {
    const tag = Number(varint());
    const value = (tag & 7) === 0 ? varint() : (() => { const n = Number(varint()); const v = bytes.subarray(pos, pos + n); pos += n; return v; })();
    out.set(tag >> 3, [...(out.get(tag >> 3) ?? []), value]);
  }
  return out;
}

/** RetryInfo delay seconds from grpc-status-details-bin: Status.details[] → Any → RetryInfo → Duration. */
function retryDelaySeconds(details: Buffer | null): number | null {
  if (!details) return null;
  for (const any of (protoFields(details).get(3) ?? []) as Buffer[]) {
    const fields = protoFields(any);
    if ((fields.get(1)?.[0] as Buffer).toString('utf8') !== 'type.googleapis.com/google.rpc.RetryInfo') continue;
    const duration = protoFields(protoFields(fields.get(2)?.[0] as Buffer).get(1)?.[0] as Buffer);
    return Number(duration.get(1)?.[0] ?? 0n);
  }
  return null;
}

describe('one path to the store: the 26 committed captures over gRPC', () => {
  it('store byte-identical rows to the same capture over OTLP/HTTP, and answer the same partial success', async () => {
    expect(fixtures).toHaveLength(26);
    let stored = 0;
    let refused = 0;
    for (const f of fixtures) {
      reset();
      const viaHttp = await post(`/telemetry/otlp/v1/${f.signal}`, f.contentType, f.body);
      expect({ fixture: f.name, status: viaHttp.status }).toEqual({ fixture: f.name, status: 200 });
      const httpRows = db.inserts.map((row) => row.params);
      const httpHealth = db.health.map((row) => row.details.counts);

      reset();
      const viaGrpc = await exportGrpc(f.signal, protobufOf(f));
      expect({ fixture: f.name, code: viaGrpc.code }).toEqual({ fixture: f.name, code: GRPC_STATUS.OK });
      const grpcRows = db.inserts.map((row) => row.params);

      expect({ fixture: f.name, rows: grpcRows }).toEqual({ fixture: f.name, rows: httpRows });
      // The same records refused for the same reasons; protobuf answers are the same bytes.
      expect(rejectedIn(viaGrpc.response!, false)).toBe(rejectedIn(viaHttp.bytes, Boolean(f.json)));
      if (!f.json) expect(viaGrpc.response).toEqual(viaHttp.bytes);
      // And the same accounting, on the transport's own adapter-health row.
      expect(db.health.map((row) => row.source)).toEqual(['otlp-grpc']);
      expect(db.health.map((row) => row.details.counts)).toEqual(httpHealth);

      stored += grpcRows.length;
      refused += rejectedIn(viaGrpc.response!, false);
    }
    // Not a vacuous comparison: records were stored AND records were refused.
    expect(stored).toBeGreaterThan(30);
    expect(refused).toBeGreaterThan(0);
    expect(stored + refused).toBeGreaterThan(40);
  });

  it('a gzip-compressed export stores the same rows as the identity one', async () => {
    const f = fixture('claude-code-protobuf/006-logs.json');
    await exportGrpc('logs', f.body);
    const identityRows = db.inserts.map((row) => row.params);
    reset();
    const compressed = await exportOver(gzipClient, otlpGrpcMethodPath('logs'), f.body);
    expect(compressed.code).toBe(GRPC_STATUS.OK);
    expect(db.inserts.map((row) => row.params)).toEqual(identityRows);
    expect(identityRows.length).toBeGreaterThan(0);
  });

  it('a replayed export over gRPC dedupes onto what HTTP stored (one content-hash identity)', async () => {
    const f = fixture('claude-code-protobuf/006-logs.json');
    await post('/telemetry/otlp/v1/logs', f.contentType, f.body);
    db.rateLimits.clear();
    await exportGrpc('logs', f.body);
    const keys = db.inserts.map((row) => row.key);
    expect(keys.length).toBe(2 * new Set(keys).size);
    expect(db.keys.size).toBe(keys.length / 2);
  });
});

describe('the OTLP partial-success rules, as gRPC statuses', () => {
  it('per-record refusals are an OK whose response carries partial_success, never an error', async () => {
    db.descriptor = { tier: 'full', products: ['some-other-product'] };
    const f = fixture('otel-python-protobuf/001-traces.json');
    const answer = await exportGrpc('traces', f.body);
    expect(answer.code).toBe(GRPC_STATUS.OK);
    expect(rejectedIn(answer.response!, false)).toBe(1);
    expect(answer.response!.toString('utf8')).toContain('OTLP_PRODUCT_NOT_DECLARED');
  });

  it('the receiver limit is RESOURCE_EXHAUSTED with RetryInfo, and ONE budget across HTTP and gRPC', async () => {
    const f = fixture('claude-code-protobuf/001-logs.json');
    expect((await exportGrpc('logs', f.body)).code).toBe(GRPC_STATUS.OK);
    const second = await exportGrpc('logs', f.body);
    expect(second.code).toBe(GRPC_STATUS.RESOURCE_EXHAUSTED);
    expect(second.trailers['relayhall-code']).toBe('RATE_LIMITED');
    expect(retryDelaySeconds(second.statusDetails)).toBeGreaterThanOrEqual(1);

    reset();
    expect((await post('/telemetry/otlp/v1/logs', f.contentType, f.body)).status).toBe(200);
    const afterHttp = await exportGrpc('logs', f.body);
    expect(afterHttp.code).toBe(GRPC_STATUS.RESOURCE_EXHAUSTED);
    // A different signal is its own surface.
    expect((await exportGrpc('metrics', fixture('claude-code-protobuf/002-metrics.json').body)).code).toBe(GRPC_STATUS.OK);
  });

  it('a deployment fault refuses the WHOLE export as UNAVAILABLE with RetryInfo, and nothing is stored', async () => {
    delete process.env.RELAYHALL_TELEMETRY_PEPPERS;
    delete process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER;
    resetTelemetryPepperCache();
    const answer = await exportGrpc('logs', protobufOf(fixture('claude-code-json/004-logs.json')));
    expect(answer.code).toBe(GRPC_STATUS.UNAVAILABLE);
    expect(answer.trailers['relayhall-code']).toBe('TELEMETRY_INGEST_UNAVAILABLE');
    expect(retryDelaySeconds(answer.statusDetails)).toBe(30);
    expect(db.inserts).toHaveLength(0);
  });

  it('a message that is not the export request is INVALID_ARGUMENT, by name', async () => {
    const answer = await exportGrpc('traces', Buffer.from('definitely not protobuf, just prose'));
    expect(answer.code).toBe(GRPC_STATUS.INVALID_ARGUMENT);
    expect(answer.trailers['relayhall-code']).toBe('OTLP_UNDECODABLE');
    expect(retryDelaySeconds(answer.statusDetails)).toBeNull();
  });

  it('more records than the receiver takes is INVALID_ARGUMENT (not retryable), nothing stored', async () => {
    const body = jsonLogsExport([{ key: 'event.name', value: s('user_prompt') }]);
    const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];
    body.resourceLogs[0].scopeLogs[0].logRecords = Array.from({ length: 1001 }, () => record);
    const answer = await exportGrpc('logs', encodeOtlpJsonAsProtobuf('logs', body));
    expect(answer.code).toBe(GRPC_STATUS.INVALID_ARGUMENT);
    expect(answer.details).toMatch(/at most 1000 records/);
    expect(db.inserts).toHaveLength(0);
  });

  it('a principal refusal is PERMISSION_DENIED, audited, before the message is read', async () => {
    identity.principalId = AGENT;
    identity.links = CHAIN.directAccountAgent;
    const answer = await exportGrpc('traces', fixture('otel-python-protobuf/001-traces.json').body);
    expect(answer.code).toBe(GRPC_STATUS.PERMISSION_DENIED);
    expect(answer.trailers['relayhall-code']).toBe('TELEMETRY_PRINCIPAL_NO_CONNECTOR');
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
      action: 'telemetry.envelope.refused',
      metadata: expect.objectContaining({ code: 'TELEMETRY_PRINCIPAL_NO_CONNECTOR', surface: 'otlp_traces' }),
    }));
    expect(db.inserts).toHaveLength(0);
  });
});

describe('version advertisement over gRPC (§3.1, §4.8)', () => {
  it('an unknown OTLP version is NOT_FOUND with the advertisement, counted on the otlp-grpc row', async () => {
    const answer = await exportOver(client, '/opentelemetry.proto.collector.logs.v9.LogsService/Export', Buffer.alloc(0));
    expect(answer.code).toBe(GRPC_STATUS.NOT_FOUND);
    expect(answer.details).toMatch(/accepts OTLP v1; park the export rather than retry it/);
    expect(answer.trailers).toMatchObject({
      'relayhall-code': 'OTLP_VERSION_NOT_ACCEPTED',
      'relayhall-schema-family': 'rh.ai.telemetry',
      'relayhall-accepted-majors': '1',
      'relayhall-accepted-otlp-versions': 'v1',
      'relayhall-accepted-otlp-signals': 'traces,logs,metrics',
    });
    expect(db.health).toEqual([expect.objectContaining({
      source: 'otlp-grpc', instance: CONNECTOR, status: 'degraded', reason: 'OTLP_VERSION_NOT_ACCEPTED',
      details: expect.objectContaining({ acceptedMajors: [1], acceptedOtlpVersions: ['v1'], counts: { requests: 1, 'unsupported.version': 1 } }),
    })]);
  });

  it('an unknown signal under v1 is NOT_FOUND with its own code', async () => {
    const answer = await exportOver(client, '/opentelemetry.proto.collector.profiles.v1.ProfilesService/Export', Buffer.alloc(0));
    expect(answer.code).toBe(GRPC_STATUS.NOT_FOUND);
    expect(answer.trailers['relayhall-code']).toBe('OTLP_SIGNAL_NOT_ACCEPTED');
    expect(answer.details).toMatch(/traces, logs, metrics/);
  });

  it('a method that is not an OTLP export is UNIMPLEMENTED, and nothing is dispatched', async () => {
    const answer = await exportOver(client, '/grpc.health.v1.Health/Check', Buffer.alloc(0));
    expect(answer.code).toBe(GRPC_STATUS.UNIMPLEMENTED);
    expect(answer.details).toContain(OTLP_GRPC_METHOD_PATHS[0]);
    expect(db.queries).toBe(0);
  });

  it('discovery says the gRPC receiver is being served, and what it serves', async () => {
    const response = await fetch(`${base}/telemetry/discovery`);
    const body = await response.json() as any;
    expect(body.surfaces.otlp.grpc).toEqual({
      enabled: true,
      methods: OTLP_GRPC_METHOD_PATHS,
      maxBytes: OTLP_PROTOBUF_MAX_BYTES,
      maxRecords: 1000,
      compression: ['identity', 'gzip', 'deflate'],
    });
  });
});

describe('the size bound and the gRPC framing rules', () => {
  /** A raw HTTP/2 call, for what no conforming client library will send. */
  function rawCall(headers: http2.OutgoingHttpHeaders, body: Buffer): Promise<{ status: number; headers: http2.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const session = http2.connect(`http://127.0.0.1:${ingress.port}`);
      session.on('error', reject);
      const request = session.request({ ':method': 'POST', ':path': OTLP_GRPC_METHOD_PATHS[1], 'content-type': 'application/grpc', te: 'trailers', ...headers });
      let responseHeaders: http2.IncomingHttpHeaders = {};
      let trailers: http2.IncomingHttpHeaders = {};
      request.on('response', (h) => { responseHeaders = h; });
      request.on('trailers', (t) => { trailers = t; });
      request.on('data', () => undefined);
      request.on('error', () => undefined);
      request.on('close', () => {
        session.close();
        resolve({ status: Number(responseHeaders[':status']), headers: { ...responseHeaders, ...trailers } });
      });
      request.end(body);
    });
  }
  const framed = (flag: number, payload: Buffer): Buffer => {
    const header = Buffer.alloc(5); header[0] = flag; header.writeUInt32BE(payload.length, 1);
    return Buffer.concat([header, payload]);
  };

  it('a message past the 4 MiB bound is RESOURCE_EXHAUSTED, and nothing is decoded or stored', async () => {
    const answer = await exportGrpc('logs', Buffer.alloc(OTLP_PROTOBUF_MAX_BYTES + 1, 0x0a));
    expect(answer.code).toBe(GRPC_STATUS.RESOURCE_EXHAUSTED);
    expect(db.queries).toBe(0);
  });

  it('a small compressed message that inflates past the bound is RESOURCE_EXHAUSTED', async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(OTLP_PROTOBUF_MAX_BYTES + 1));
    const answer = await rawCall({ 'grpc-encoding': 'gzip' }, framed(1, bomb));
    expect(answer.headers['grpc-status']).toBe(String(GRPC_STATUS.RESOURCE_EXHAUSTED));
    expect(db.queries).toBe(0);
  });

  it('a gzip and a deflate message, framed by hand, store the same rows as the identity one', async () => {
    const f = fixture('claude-code-protobuf/006-logs.json');
    expect((await rawCall({}, framed(0, f.body))).headers['grpc-status']).toBe('0');
    const identityRows = db.inserts.map((row) => row.params);
    expect(identityRows.length).toBeGreaterThan(0);
    reset();
    expect((await rawCall({ 'grpc-encoding': 'gzip' }, framed(1, zlib.gzipSync(f.body)))).headers['grpc-status']).toBe('0');
    expect(db.inserts.map((row) => row.params)).toEqual(identityRows);
    reset();
    expect((await rawCall({ 'grpc-encoding': 'deflate' }, framed(1, zlib.deflateSync(f.body)))).headers['grpc-status']).toBe('0');
    expect(db.inserts.map((row) => row.params)).toEqual(identityRows);
  });

  it('an unsupported message encoding is UNIMPLEMENTED and names the accepted ones', async () => {
    const answer = await rawCall({ 'grpc-encoding': 'snappy' }, framed(1, Buffer.from('x')));
    expect(answer.headers['grpc-status']).toBe(String(GRPC_STATUS.UNIMPLEMENTED));
    expect(answer.headers['grpc-accept-encoding']).toBe('identity,gzip,deflate');
  });

  it('two messages on a unary call are INVALID_ARGUMENT; a compressed flag with no encoding is INTERNAL', async () => {
    const one = framed(0, protobufOf(fixture('claude-code-json/004-logs.json')));
    expect((await rawCall({}, Buffer.concat([one, one]))).headers['grpc-status']).toBe(String(GRPC_STATUS.INVALID_ARGUMENT));
    expect((await rawCall({}, framed(1, zlib.gzipSync(Buffer.from('x'))))).headers['grpc-status']).toBe(String(GRPC_STATUS.INTERNAL));
    expect(db.inserts).toHaveLength(0);
  });

  it('a request that is not gRPC is answered at the HTTP layer (415 / 405)', async () => {
    expect((await rawCall({ 'content-type': 'application/x-protobuf' }, Buffer.alloc(0))).status).toBe(415);
    expect((await rawCall({ 'content-type': 'application/grpc+json' }, Buffer.alloc(0))).status).toBe(415);
    expect((await rawCall({ ':method': 'PUT' }, Buffer.alloc(0))).status).toBe(405);
  });
});

describe('the production ingress app: rh_ principal credentials only, the REST source limit', () => {
  let production: { port: number; close(): Promise<void> };
  let productionClient: grpc.Client;
  beforeAll(async () => {
    production = await startOtlpGrpcIngress({ port: 0, host: '127.0.0.1', app: buildOtlpGrpcApp() });
    productionClient = new grpc.Client(`127.0.0.1:${production.port}`, grpc.credentials.createInsecure());
  });
  afterAll(async () => {
    productionClient.close();
    await production.close();
  });
  const call = (metadata: Record<string, string>) =>
    exportOver(productionClient, otlpGrpcMethodPath('logs'), fixture('claude-code-protobuf/001-logs.json').body, metadata);

  it.each([
    ['no authorization metadata', {}],
    ['a dashboard-style bearer', { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.c2lnbmF0dXJl' }],
    ['an rh_ credential the board does not know', { authorization: 'Bearer rh_live_0123456789abcdef.notarealsecret0123456789' }],
    // REST would accept this key; the ingress forwards only `authorization`, and accepts only rh_ there.
    ['the configured legacy service key in the call metadata', { 'x-api-key': LEGACY_SERVICE_KEY }],
  ])('%s is UNAUTHENTICATED and nothing is stored', async (_label, metadata) => {
    const answer = await call(metadata as Record<string, string>);
    expect(answer.code).toBe(GRPC_STATUS.UNAUTHENTICATED);
    expect(db.inserts).toHaveLength(0);
    expect(db.health).toHaveLength(0);
  });

  it('the API-wide per-source limit is the REST limiter itself: the 301st call in a minute is RESOURCE_EXHAUSTED', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { API_RATE_LIMIT_MAX_REQUESTS } = require('../middleware/apiRateLimit');
    let lastCode = -1;
    let unauthenticated = 0;
    for (let i = 0; i < API_RATE_LIMIT_MAX_REQUESTS; i += 50) {
      const batch = await Promise.all(Array.from({ length: Math.min(50, API_RATE_LIMIT_MAX_REQUESTS - i) }, () => call({})));
      unauthenticated += batch.filter((answer) => answer.code === GRPC_STATUS.UNAUTHENTICATED).length;
    }
    // Earlier calls in this describe used part of the same window.
    expect(unauthenticated).toBeGreaterThan(API_RATE_LIMIT_MAX_REQUESTS - 10);
    const over = await call({});
    lastCode = over.code;
    expect(lastCode).toBe(GRPC_STATUS.RESOURCE_EXHAUSTED);
    expect(over.trailers['relayhall-code']).toBe('RATE_LIMITED');
    expect(retryDelaySeconds(over.statusDetails)).toBeGreaterThanOrEqual(1);
  });
});

describe('decoder parity the comparison relies on', () => {
  it('each JSON capture re-encoded as protobuf decodes to the same records', () => {
    for (const f of fixtures.filter((x) => x.json)) {
      const fromJson = decodeOtlpJson(f.signal, f.json);
      const fromProtobuf = decodeOtlpProtobuf(f.signal, protobufOf(f));
      expect(fromProtobuf.items.length).toBe(fromJson.items.length);
      expect(fromProtobuf.attributeEntries).toBe(fromJson.attributeEntries);
    }
  });
});
