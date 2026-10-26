/**
 * POST /telemetry/otlp/v1/{traces,logs,metrics} — the OTLP/HTTP receivers,
 * driven over a real socket through the PRODUCTION telemetry router (card
 * `dac2ca71`, slice 1). Only the pool and the audit sink are doubles.
 *
 * What the wire contract owes a producer, and what the plane owes an operator:
 *   - protobuf in, protobuf out; JSON in, JSON out; the OTLP partial-success
 *     shape with the rejected count and the refusal codes;
 *   - 415 / 400 / 413 for a body the receiver cannot read, as google.rpc.Status;
 *   - 429 with Retry-After on the SIGNAL's own surface — a producer exporting
 *     logs and metrics on their own schedules does not refuse itself;
 *   - a DEPLOYMENT fault refuses the WHOLE export (503) and stops the loop, so
 *     an SDK retries the batch intact rather than reading 200 as delivered;
 *   - an unknown OTLP version or signal is refused WITH the accepted-version
 *     advertisement, and counted on the Connector's adapter-health row;
 *   - the native endpoint's unknown-major rejection is counted there too.
 */
import express from 'express';
import type { AddressInfo } from 'net';

const db = {
  connectors: new Set<string>(),
  descriptor: null as null | { tier: string; products?: string[] },
  rateLimits: new Map<string, number>(),
  keys: new Set<string>(),
  inserts: [] as Array<{ key: string; payload: any }>,
  health: [] as Array<{ source: string; instance: string; status: string; reason: string | null; details: any }>,
  /** Throw on the Nth session_events insert (1-based), modelling a database that goes away mid-export. */
  failInsertAt: 0,
};

jest.mock('../db/connection', () => ({
  pool: {
    query: jest.fn(async (text: string, params?: unknown[]) => {
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
        if (db.failInsertAt > 0 && db.inserts.length + 1 === db.failInsertAt) throw new Error('the database went away');
        const key = String(p[19]);
        db.inserts.push({ key, payload: JSON.parse(String(p[16])) });
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const telemetryRouter = require('../routes/telemetry').default;
// eslint-disable-next-line import/first
import { loadOtlpFixtures, jsonLogsExport, encodeOtlpJsonAsProtobuf, s, i } from './support/otlpFixtures';
import { resetTelemetryPepperCache } from '../utils/telemetryPepper';
import { decodeOtlpJson, decodeOtlpProtobuf } from '../utils/otlp/otlpDecode';

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
const fixture = (name: string) => {
  const found = fixtures.find((f) => f.name === name);
  if (!found) throw new Error(`no fixture ${name}`);
  return found;
};

let server: ReturnType<typeof express.application.listen>;
let base: string;

beforeAll((done) => {
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
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});
afterAll((done) => { server.close(() => done()); });
beforeEach(() => {
  process.env.RELAYHALL_TELEMETRY_PEPPERS = JSON.stringify({ t: Buffer.alloc(32, 5).toString('base64') });
  process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER = 't';
  resetTelemetryPepperCache();
  db.rateLimits.clear(); db.keys.clear(); db.inserts.length = 0; db.health.length = 0; db.failInsertAt = 0;
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

async function post(path: string, contentType: string, body: Buffer | string) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': contentType }, body });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, type: response.headers.get('content-type') ?? '', retryAfter: response.headers.get('retry-after'), bytes };
}

/** A minimal protobuf reader for the RESPONSE messages, independent of the receiver's writer. */
function readFields(bytes: Buffer): Map<number, Array<bigint | Buffer>> {
  const out = new Map<number, Array<bigint | Buffer>>();
  let pos = 0;
  const varint = (): bigint => {
    let result = 0n; let shift = 0n;
    for (;;) { const b = bytes[pos++]; result |= BigInt(b & 0x7f) << shift; if ((b & 0x80) === 0) return result; shift += 7n; }
  };
  while (pos < bytes.length) {
    const tag = Number(varint());
    const field = tag >> 3; const wire = tag & 7;
    const value = wire === 0 ? varint() : (() => { const n = Number(varint()); const v = bytes.subarray(pos, pos + n); pos += n; return v; })();
    out.set(field, [...(out.get(field) ?? []), value]);
  }
  return out;
}
function partialSuccess(bytes: Buffer): { rejected: number; message: string } {
  if (bytes.length === 0) return { rejected: 0, message: '' };
  const inner = readFields(readFields(bytes).get(1)?.[0] as Buffer);
  return { rejected: Number(inner.get(1)?.[0] ?? 0n), message: (inner.get(2)?.[0] as Buffer | undefined)?.toString('utf8') ?? '' };
}
function rpcStatus(bytes: Buffer): { code: number; message: string } {
  const fields = readFields(bytes);
  return { code: Number(fields.get(1)?.[0] ?? 0n), message: (fields.get(2)?.[0] as Buffer).toString('utf8') };
}

describe('accepting real exports', () => {
  it('protobuf in, protobuf out: a GenAI span from the Python SDK is stored and answered with the empty response', async () => {
    const f = fixture('otel-python-protobuf/001-traces.json');
    const res = await post('/telemetry/otlp/v1/traces', f.contentType, f.body);
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/application\/x-protobuf/);
    expect(res.bytes.length).toBe(0);
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].payload).toMatchObject({ kind: 'model_call', source: { adapter: 'otlp.genai', product: 'otel-python-sample' } });
  });

  it('JSON in, JSON out: Claude Code log events are stored and answered with {}', async () => {
    const f = fixture('claude-code-json/004-logs.json');
    const res = await post('/telemetry/otlp/v1/logs', f.contentType, f.body);
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/application\/json/);
    expect(JSON.parse(res.bytes.toString('utf8'))).toEqual({});
    expect(db.inserts.map((row) => row.payload.kind).sort()).toEqual(['audit', 'model_call', 'tool_call']);
  });

  it('answers partial success with the rejected count and the codes, in protobuf', async () => {
    const f = fixture('claude-code-protobuf/005-metrics.json');
    const points = decodeOtlpProtobuf('metrics', f.body).items.length;
    const res = await post('/telemetry/otlp/v1/metrics', f.contentType, f.body);
    expect(res.status).toBe(200);
    expect(partialSuccess(res.bytes)).toEqual({ rejected: points, message: `${points} OTLP_CHANNEL_NOT_TRANSLATED` });
    expect(db.inserts).toHaveLength(0);
  });

  it('answers partial success in JSON with the signal\'s own field name', async () => {
    const f = fixture('claude-code-json/003-metrics.json');
    const points = decodeOtlpJson('metrics', f.json).items.length;
    const res = await post('/telemetry/otlp/v1/metrics', f.contentType, f.body);
    expect(JSON.parse(res.bytes.toString('utf8'))).toEqual({
      partialSuccess: { rejectedDataPoints: String(points), errorMessage: `${points} OTLP_CHANNEL_NOT_TRANSLATED` },
    });
  });

  it('refuses records whose product the Connector did not declare, per record, never the export', async () => {
    db.descriptor = { tier: 'full', products: ['some-other-product'] };
    const f = fixture('otel-python-protobuf/001-traces.json');
    const res = await post('/telemetry/otlp/v1/traces', f.contentType, f.body);
    expect(res.status).toBe(200);
    expect(partialSuccess(res.bytes)).toEqual({ rejected: 1, message: '1 OTLP_PRODUCT_NOT_DECLARED' });
  });

  it('a replayed export stores nothing new: every record is a duplicate of itself', async () => {
    const f = fixture('claude-code-protobuf/006-logs.json');
    await post('/telemetry/otlp/v1/logs', f.contentType, f.body);
    db.rateLimits.clear();
    await post('/telemetry/otlp/v1/logs', f.contentType, f.body);
    const keys = db.inserts.map((row) => row.key);
    expect(keys.length).toBe(2 * new Set(keys).size);
  });
});

describe('bodies the receiver cannot read', () => {
  it('415 for a media type it does not speak, naming what it does', async () => {
    const res = await post('/telemetry/otlp/v1/traces', 'text/plain', 'hello');
    expect(res.status).toBe(415);
    expect(JSON.parse(res.bytes.toString('utf8'))).toMatchObject({
      code: 3, rhCode: 'UNSUPPORTED_MEDIA_TYPE', acceptedTypes: ['application/x-protobuf', 'application/json'],
    });
  });

  it('400 with a google.rpc.Status for bytes that are not the message', async () => {
    const res = await post('/telemetry/otlp/v1/traces', 'application/x-protobuf', Buffer.from('definitely not protobuf, just prose'));
    expect(res.status).toBe(400);
    expect(rpcStatus(res.bytes).code).toBe(3);
  });

  it('413 for an export with more records than the receiver takes', async () => {
    const body = jsonLogsExport([{ key: 'event.name', value: s('user_prompt') }]);
    const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];
    body.resourceLogs[0].scopeLogs[0].logRecords = Array.from({ length: 1001 }, () => record);
    // Protobuf: 1001 records in OTLP/JSON would exceed the deployment's 100 KiB
    // JSON body ceiling before the receiver ever saw them.
    const res = await post('/telemetry/otlp/v1/logs', 'application/x-protobuf', encodeOtlpJsonAsProtobuf('logs', body));
    expect(res.status).toBe(413);
    expect(rpcStatus(res.bytes)).toEqual({ code: 3, message: expect.stringMatching(/at most 1000 records/) });
    expect(db.inserts).toHaveLength(0);
  });
});

describe('the receiver limit, per signal', () => {
  it('429 with Retry-After on a second export of the SAME signal inside the interval', async () => {
    const f = fixture('claude-code-protobuf/001-logs.json');
    expect((await post('/telemetry/otlp/v1/logs', f.contentType, f.body)).status).toBe(200);
    const second = await post('/telemetry/otlp/v1/logs', f.contentType, f.body);
    expect(second.status).toBe(429);
    expect(Number(second.retryAfter)).toBeGreaterThanOrEqual(1);
    expect(rpcStatus(second.bytes).code).toBe(8);
  });

  it('a DIFFERENT signal in the same instant is not refused by the first', async () => {
    const logs = fixture('claude-code-protobuf/001-logs.json');
    const metrics = fixture('claude-code-protobuf/002-metrics.json');
    expect((await post('/telemetry/otlp/v1/logs', logs.contentType, logs.body)).status).toBe(200);
    expect((await post('/telemetry/otlp/v1/metrics', metrics.contentType, metrics.body)).status).toBe(200);
  });
});

describe('principal refusals (§5.1)', () => {
  it('refuses a direct Account→Agent presenter, audited, before reading the body', async () => {
    identity.principalId = AGENT;
    identity.links = CHAIN.directAccountAgent;
    const f = fixture('otel-python-protobuf/001-traces.json');
    const res = await post('/telemetry/otlp/v1/traces', f.contentType, f.body);
    expect(res.status).toBe(403);
    expect(rpcStatus(res.bytes).code).toBe(7);
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
      action: 'telemetry.envelope.refused',
      metadata: expect.objectContaining({ code: 'TELEMETRY_PRINCIPAL_NO_CONNECTOR', surface: 'otlp_traces' }),
    }));
    expect(db.inserts).toHaveLength(0);
  });
});

describe('a deployment fault refuses the WHOLE export (candidate A round 1, B1)', () => {
  it('503 with Retry-After when the pepper is not configured, and nothing is stored', async () => {
    delete process.env.RELAYHALL_TELEMETRY_PEPPERS;
    delete process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER;
    resetTelemetryPepperCache();
    const f = fixture('claude-code-json/004-logs.json');
    const res = await post('/telemetry/otlp/v1/logs', f.contentType, f.body);
    expect(res.status).toBe(503);
    expect(res.retryAfter).toBe('30');
    expect(JSON.parse(res.bytes.toString('utf8'))).toMatchObject({ code: 14, rhCode: 'TELEMETRY_INGEST_UNAVAILABLE' });
    expect(db.inserts).toHaveLength(0);
  });

  it('stops at the fault even after a record was stored, and the retry dedupes what landed', async () => {
    const f = fixture('claude-code-json/004-logs.json');
    db.failInsertAt = 2;
    const first = await post('/telemetry/otlp/v1/logs', f.contentType, f.body);
    expect(first.status).toBe(503);
    expect(db.inserts).toHaveLength(1);
    db.failInsertAt = 0;
    db.rateLimits.clear();
    const retry = await post('/telemetry/otlp/v1/logs', f.contentType, f.body);
    expect(retry.status).toBe(200);
    expect(db.inserts[1].key).toBe(db.inserts[0].key);
    expect(db.keys.size).toBe(3);
  });
});

describe('version advertisement (§3.1, §4.8)', () => {
  it('refuses an unknown OTLP version with the advertisement, and counts it on adapter health', async () => {
    const res = await post('/telemetry/otlp/v2/traces', 'application/json', '{}');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.bytes.toString('utf8'))).toMatchObject({
      rhCode: 'OTLP_VERSION_NOT_ACCEPTED',
      acceptedOtlpVersions: ['v1'],
      schemaFamily: 'rh.ai.telemetry',
      acceptedMajors: [1],
    });
    expect(db.health).toEqual([expect.objectContaining({
      source: 'otlp-http', instance: CONNECTOR, status: 'degraded', reason: 'OTLP_VERSION_NOT_ACCEPTED',
      details: expect.objectContaining({ acceptedMajors: [1], acceptedOtlpVersions: ['v1'], counts: { requests: 1, 'unsupported.version': 1 } }),
    })]);
  });

  it('refuses an unknown signal under v1 with its own code', async () => {
    const res = await post('/telemetry/otlp/v1/profiles', 'application/x-protobuf', Buffer.alloc(0));
    expect(res.status).toBe(404);
    expect(rpcStatus(res.bytes).message).toMatch(/traces, logs, metrics/);
  });

  it('discovery says what is accepted before anything is sent', async () => {
    const response = await fetch(`${base}/telemetry/discovery`);
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      schemaFamily: 'rh.ai.telemetry', acceptedMajors: [1], acceptedOtlpVersions: ['v1'],
      surfaces: {
        otlp: {
          paths: ['/telemetry/otlp/v1/traces', '/telemetry/otlp/v1/logs', '/telemetry/otlp/v1/metrics'],
          // Slice 2: no OTLP/gRPC listener is bound in this process, and discovery says so.
          grpc: expect.objectContaining({ enabled: false }),
        },
      },
    });
  });

  it('the native endpoint counts an unknown-major rejection on its adapter-health row', async () => {
    const response = await fetch(`${base}/telemetry/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schema_version: 'rh.ai.telemetry/2.0', event_id: 'e-1', kind: 'model_call', source: { product: 'claude-code', adapter: 'x' } }),
    });
    expect(response.status).toBe(400);
    expect((await response.json() as any).acceptedMajors).toEqual([1]);
    expect(db.health).toEqual([expect.objectContaining({
      source: 'native-envelope', instance: CONNECTOR, status: 'degraded', reason: 'UNSUPPORTED_SCHEMA_MAJOR',
      details: expect.objectContaining({
        counts: { requests: 1, 'records.rejected': 1, 'unsupported.major': 1, 'rejected.UNSUPPORTED_SCHEMA_MAJOR': 1 },
      }),
    })]);
  });
});

describe('adapter health for an accepted export (§8.3)', () => {
  it('records counts, the dropped-attribute subtraction and clock skew, metadata only', async () => {
    const body = jsonLogsExport([
      { key: 'event.name', value: s('api_request') },
      { key: 'input_tokens', value: i(10) },
      { key: 'input_tokens', value: i(10) },
      { key: 'prompt', value: s('a secret prompt') },
    ]);
    const res = await post('/telemetry/otlp/v1/logs', 'application/json', JSON.stringify(body));
    expect(res.status).toBe(200);
    expect(db.health).toHaveLength(1);
    const row = db.health[0];
    expect(row).toMatchObject({ source: 'otlp-http', instance: CONNECTOR, status: 'healthy' });
    expect(row.details.counts).toMatchObject({
      requests: 1, 'signal.logs': 1, 'records.accepted': 1, 'translation.otlp.claude-code': 1,
      'attributes.entries': 5, 'attributes.carried': 3, 'attributes.dropped': 2,
    });
    expect(row.details).toMatchObject({ lastSignal: 'logs', lastEncoding: 'json' });
    expect(typeof row.details.lastClockSkewMs).toBe('number');
    expect(JSON.stringify(row)).not.toContain('secret');
  });
});
