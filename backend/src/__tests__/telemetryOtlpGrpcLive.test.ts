/**
 * RH-TW1b slice 2 (card `dac2ca71`, estate card `928586a6`) — THE OTLP/gRPC
 * RECEIVERS AGAINST A REAL POSTGRESQL, THROUGH THE PRODUCTION INGRESS APP,
 * AUTHENTICATION, AUTHORIZATION AND MIGRATIONS, DRIVEN BY A REAL gRPC CLIENT.
 *
 *   ONE IDENTITY ACROSS TRANSPORTS — every committed capture is exported over
 *   OTLP/HTTP by a real Connector credential, then exported AGAIN over gRPC by
 *   the same credential: not one row is added, because every gRPC record's
 *   content-hash identity equals the row HTTP stored and
 *   `session_events.idempotency_key` is UNIQUE. A second Connector exports the
 *   captures over gRPC ONLY, and its stored payloads equal the first
 *   Connector's, field for field, apart from the per-Connector and per-instant
 *   columns (measured in the database, not in a double).
 *
 *   THE SAME AUTHENTICATION — the `rh_` credential in the call metadata is
 *   accepted by `acceptPrincipalKey`; an unknown credential and a missing one
 *   are UNAUTHENTICATED; a credential without `telemetry:write` is refused by
 *   the shared authorization ceiling (PERMISSION_DENIED); an `mcp`-pinned
 *   credential is refused by the transport pin (TRANSPORT_MISMATCH).
 *
 *   THE SAME RECEIVER LIMIT — an export over HTTP spends the signal's surface
 *   for gRPC too (RESOURCE_EXHAUSTED with RetryInfo), in `telemetry_rate_limits`.
 *
 *   SURFACED ON ADAPTER HEALTH — the Connector's `otlp-grpc` row carries the
 *   counts and the advertisement, and an unknown OTLP version is counted there.
 *
 * It connects to `RELAYHALL_TEST_DB_URL` and FAILS — never skips — when the
 * variable is unset. Excluded from the default jest run; run by
 * `npm run test:telemetry-otlp` (beside the HTTP suite) and so unconditionally
 * by the full CI tier.
 *
 * THE DESTRUCTIVE CONTRACT: it WRITES principals, principal_credentials,
 * services, service_descriptor_versions, session_events, telemetry_raw_blobs,
 * telemetry_rate_limits and session_adapter_health, and refuses a URL naming a
 * deployment database. Bring the database up with `database/init.sql` and
 * `npm run migrate`, and throw it away afterwards.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
import http from 'http';
import crypto from 'crypto';
import * as grpc from '@grpc/grpc-js';
import { loadOtlpFixtures, encodeOtlpJsonAsProtobuf, type OtlpFixture } from './support/otlpFixtures';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error(
    'RELAYHALL_TEST_DB_URL is not set. This gate measures what the OTLP/gRPC receivers store, dedupe and refuse '
    + 'against a REAL PostgreSQL, and refuses to skip. Create a disposable database, load database/init.sql, '
    + 'run npm run migrate, and set RELAYHALL_TEST_DB_URL to it.',
  );
}
const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = parsed.pathname.replace(/^\//, '');
if (['relayhall_dev', 'relayhall_tst', 'relayhall_prod', 'relayhall'].includes(TEST_DB_NAME)) {
  throw new Error(`RELAYHALL_TEST_DB_URL names a deployment database (${TEST_DB_NAME}). This suite writes; point it at a disposable database.`);
}
process.env.DB_HOST = parsed.hostname;
process.env.DB_PORT = parsed.port || '5432';
process.env.DB_NAME = TEST_DB_NAME;
process.env.DB_USER = decodeURIComponent(parsed.username);
process.env.DB_PASSWORD = decodeURIComponent(parsed.password);
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'telemetry-otlp-grpc-suite-0123456789abcdef';
process.env.RELAYHALL_SESSIONS = 'on';
process.env.RELAYHALL_TELEMETRY_PEPPERS = process.env.RELAYHALL_TELEMETRY_PEPPERS
  || JSON.stringify({ otlppepper: Buffer.alloc(32, 13).toString('base64') });
process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER = process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER || 'otlppepper';

const express = require('express');
const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { principalService } = require('../services/PrincipalService');
const { resetTelemetryPepperCache } = require('../utils/telemetryPepper');
const { TELEMETRY_MIN_INTERVAL_MS } = require('../services/TelemetryRateLimitService');
const { startOtlpGrpcIngress } = require('../services/otlp/OtlpGrpcIngress');
const { GRPC_STATUS, otlpGrpcMethodPath } = require('../utils/otlp/otlpGrpc');

jest.setTimeout(300_000);

let server: http.Server;
let origin: string;
let ingress: { port: number; close(): Promise<void> };
let client: grpc.Client;
const tag = (): string => crypto.randomBytes(6).toString('hex');
const SYSTEM_ACTOR = { handle: 'telemetry-otlp-grpc-suite', authMethod: 'system' as const };

interface Reporter { connectorId: string; bearer: string }
let accountId: string;
let httpThenGrpc: Reporter;
let grpcOnly: Reporter;
let noTelemetryScopeBearer: string;
let mcpPinnedBearer: string;

const fixtures: OtlpFixture[] = loadOtlpFixtures();
const OTLP_INTERVAL_MS = Math.max(
  TELEMETRY_MIN_INTERVAL_MS.otlp_traces, TELEMETRY_MIN_INTERVAL_MS.otlp_logs, TELEMETRY_MIN_INTERVAL_MS.otlp_metrics);
const protobufOf = (f: OtlpFixture): Buffer => (f.json ? encodeOtlpJsonAsProtobuf(f.signal, f.json) : f.body);
const pause = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, OTLP_INTERVAL_MS + 150); });

interface GrpcAnswer { code: number; details: string; response: Buffer | null; trailers: Record<string, string>; statusDetails: Buffer | null }

function exportGrpc(path: string, message: Buffer, bearer: string | null): Promise<GrpcAnswer> {
  return new Promise((resolve) => {
    const md = new grpc.Metadata();
    if (bearer !== null) md.set('authorization', `Bearer ${bearer}`);
    let response: Buffer | null = null;
    const call = client.makeUnaryRequest<Buffer, Buffer>(
      path, (b: Buffer) => b, (b: Buffer) => b, message, md, {},
      (err, value) => { response = err ? null : (value ?? null); },
    );
    call.on('status', (status: grpc.StatusObject) => {
      const trailers: Record<string, string> = {};
      for (const [key, value] of Object.entries(status.metadata.getMap())) if (typeof value === 'string') trailers[key] = value;
      const bin = status.metadata.get('grpc-status-details-bin')[0];
      setImmediate(() => resolve({ code: status.code, details: status.details, response, trailers, statusDetails: Buffer.isBuffer(bin) ? bin : null }));
    });
  });
}

/** Rejected count from a protobuf partial-success response. */
function rejectedIn(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  let pos = 0;
  const varint = (b: Buffer): number => { let r = 0; let m = 1; for (;;) { const x = b[pos++]; r += (x & 0x7f) * m; if ((x & 0x80) === 0) return r; m *= 128; } };
  pos = 1; const innerLength = varint(bytes); const inner = bytes.subarray(pos, pos + innerLength);
  pos = 0; if (inner[pos++] !== 0x08) return 0;
  return varint(inner);
}

async function exportAllOverHttp(reporter: Reporter): Promise<void> {
  for (const f of fixtures) {
    await pause();
    const response = await fetch(`${origin}/telemetry/otlp/v1/${f.signal}`, {
      method: 'POST', headers: { 'Content-Type': f.contentType, Authorization: `Bearer ${reporter.bearer}` }, body: f.body,
    });
    if (response.status !== 200) throw new Error(`${f.name} over HTTP was refused: ${response.status}`);
  }
}

async function exportAllOverGrpc(reporter: Reporter): Promise<{ rejected: number }> {
  let rejected = 0;
  for (const f of fixtures) {
    await pause();
    const answer = await exportGrpc(otlpGrpcMethodPath(f.signal), protobufOf(f), reporter.bearer);
    if (answer.code !== GRPC_STATUS.OK) throw new Error(`${f.name} over gRPC was refused: ${answer.code} ${answer.details}`);
    rejected += rejectedIn(answer.response ?? Buffer.alloc(0));
  }
  return { rejected };
}

async function otlpRows(connectorId: string): Promise<number> {
  const result = await pool.query(
    `SELECT count(*)::int AS n FROM session_events WHERE connector_id = $1 AND source LIKE 'otlp.%'`, [connectorId]);
  return result.rows[0].n;
}

async function makeConnector(): Promise<string> {
  const connector = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, 'otlp grpc suite connector', 'active', $2, 'otlp grpc suite connector', $3::jsonb) RETURNING id`,
    [`otlp-grpc-connector-${tag()}`, accountId, JSON.stringify({ scopes: 'parent', objects: 'parent' })]);
  const connectorId = String(connector.rows[0].id);
  const descriptor = { telemetry: { tier: 'full', products: ['claude-code', 'otel-python-sample'] } };
  const service = await pool.query(
    `INSERT INTO services (slug, name, description, kind, status, principal_id, current_descriptor_version)
     VALUES ($1, 'otlp grpc suite connector', 'otlp grpc suite', 'connector', 'published', $2, 1) RETURNING id`,
    [`otlp-grpc-conn-${tag()}`, connectorId]);
  await pool.query(
    `INSERT INTO service_descriptor_versions (service_id, version, descriptor, content_hash, created_by_principal_id)
     VALUES ($1, 1, $2::jsonb, $3, NULL)`,
    [String(service.rows[0].id), JSON.stringify(descriptor),
      crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex')]);
  return connectorId;
}

async function credential(principalId: string, scopes: string[], transport = 'any'): Promise<string> {
  const issued = await principalService.issueCredential({ principalId, scopes, transport }, SYSTEM_ACTOR);
  return issued.fullKey;
}

let rowsAfterHttp: number;
let grpcReplay: { rejected: number };

beforeAll(async () => {
  resetTelemetryPepperCache();
  const app = express();
  app.use(express.json(jsonBodyOptions));
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // The PRODUCTION ingress app: no `app` seam is passed.
  ingress = await startOtlpGrpcIngress({ port: 0, host: '127.0.0.1' });
  client = new grpc.Client(`127.0.0.1:${ingress.port}`, grpc.credentials.createInsecure());

  const human = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, 'otlp grpc suite account', 'active', 'user') RETURNING id`, [`otlp-grpc-human-${tag()}`]);
  accountId = String(human.rows[0].id);

  const first = await makeConnector();
  httpThenGrpc = { connectorId: first, bearer: await credential(first, ['telemetry:write']) };
  const second = await makeConnector();
  grpcOnly = { connectorId: second, bearer: await credential(second, ['telemetry:write']) };
  const third = await makeConnector();
  noTelemetryScopeBearer = await credential(third, ['tasks:read']);
  mcpPinnedBearer = await credential(third, ['telemetry:write'], 'mcp');

  await exportAllOverHttp(httpThenGrpc);
  rowsAfterHttp = await otlpRows(httpThenGrpc.connectorId);
  grpcReplay = await exportAllOverGrpc(httpThenGrpc);
  await exportAllOverGrpc(grpcOnly);
});

afterAll(async () => {
  client?.close();
  if (ingress) await ingress.close();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

test('every capture exported again over gRPC adds NO row: one content-hash identity across transports', async () => {
  expect(rowsAfterHttp).toBeGreaterThan(30);
  expect(grpcReplay.rejected).toBeGreaterThan(0);
  expect(await otlpRows(httpThenGrpc.connectorId)).toBe(rowsAfterHttp);
});

test('a Connector that only ever used gRPC stored the same payloads, apart from per-Connector and per-instant fields', async () => {
  expect(await otlpRows(grpcOnly.connectorId)).toBe(rowsAfterHttp);
  // ONLY the receipt instant and the per-Connector raw-blob reference may
  // differ: every translated fact, measurement, identifier and the policy
  // outcome must be the same whichever transport carried the export.
  const read = async (connectorId: string): Promise<string[]> => {
    const result = await pool.query(
      `SELECT source, event_kind, source_event_id, source_occurred_at, source_product, policy_tier, schema_version,
              redaction_policy_version, payload
         FROM session_events WHERE connector_id = $1 AND source LIKE 'otlp.%'`, [connectorId]);
    return result.rows.map((row: any) => {
      const { observed_at: _observedAt, source, ...facts } = row.payload;
      const { raw_ref: _rawRef, ...sourceFacts } = source ?? {};
      return JSON.stringify({ ...row, payload: { ...facts, source: sourceFacts } });
    }).sort();
  };
  const viaHttp = await read(httpThenGrpc.connectorId);
  const viaGrpc = await read(grpcOnly.connectorId);
  expect(viaGrpc).toHaveLength(rowsAfterHttp);
  expect(new Set(viaGrpc).size).toBeGreaterThan(rowsAfterHttp / 2);
  expect(viaGrpc).toEqual(viaHttp);
});

test('the otlp-grpc adapter-health row carries the counts and the advertisement', async () => {
  const row = await pool.query(
    `SELECT status, safe_details FROM session_adapter_health WHERE source = 'otlp-grpc' AND source_instance = $1`,
    [httpThenGrpc.connectorId]);
  expect(row.rows).toHaveLength(1);
  const details = row.rows[0].safe_details;
  expect(details).toMatchObject({ schemaFamily: 'rh.ai.telemetry', acceptedMajors: [1], acceptedOtlpVersions: ['v1'], lastEncoding: 'protobuf' });
  // The replay was entirely duplicates of what HTTP stored.
  expect(Number(details.counts['records.duplicate'])).toBe(rowsAfterHttp);
  expect(Number(details.counts['records.accepted'] ?? 0)).toBe(0);
  expect(Number(details.counts.requests)).toBe(fixtures.length);
  expect(Number(details.counts['attributes.carried']) + Number(details.counts['attributes.dropped']))
    .toBe(Number(details.counts['attributes.entries']));
  // HTTP kept its own row.
  const http = await pool.query(
    `SELECT count(*)::int AS n FROM session_adapter_health WHERE source = 'otlp-http' AND source_instance = $1`,
    [httpThenGrpc.connectorId]);
  expect(http.rows[0].n).toBe(1);
});

test('authentication is the rh_ acceptance path: missing and unknown credentials are UNAUTHENTICATED', async () => {
  const body = fixtures[0].body;
  const path = otlpGrpcMethodPath(fixtures[0].signal);
  expect((await exportGrpc(path, body, null)).code).toBe(GRPC_STATUS.UNAUTHENTICATED);
  const [prefix] = httpThenGrpc.bearer.split('.');
  expect((await exportGrpc(path, body, `${prefix}.${'0'.repeat(43)}`)).code).toBe(GRPC_STATUS.UNAUTHENTICATED);
});

test('authorization is the shared ceiling and the transport pin', async () => {
  const f = fixtures.find((x) => x.signal === 'logs')!;
  const path = otlpGrpcMethodPath('logs');
  const noScope = await exportGrpc(path, protobufOf(f), noTelemetryScopeBearer);
  expect(noScope.code).toBe(GRPC_STATUS.PERMISSION_DENIED);
  const pinned = await exportGrpc(path, protobufOf(f), mcpPinnedBearer);
  expect(pinned.code).toBe(GRPC_STATUS.PERMISSION_DENIED);
  expect(pinned.trailers['relayhall-code']).toBe('TRANSPORT_MISMATCH');
});

test('the receiver limit is one budget per signal across HTTP and gRPC, in telemetry_rate_limits', async () => {
  const f = fixtures.find((x) => x.signal === 'metrics' && !x.json)!;
  await pause();
  const response = await fetch(`${origin}/telemetry/otlp/v1/metrics`, {
    method: 'POST', headers: { 'Content-Type': f.contentType, Authorization: `Bearer ${grpcOnly.bearer}` }, body: f.body,
  });
  expect(response.status).toBe(200);
  const answer = await exportGrpc(otlpGrpcMethodPath('metrics'), f.body, grpcOnly.bearer);
  expect(answer.code).toBe(GRPC_STATUS.RESOURCE_EXHAUSTED);
  expect(answer.trailers['relayhall-code']).toBe('RATE_LIMITED');
  expect(answer.statusDetails?.toString('latin1')).toContain('type.googleapis.com/google.rpc.RetryInfo');
  const surfaces = await pool.query(
    `SELECT surface FROM telemetry_rate_limits WHERE principal_id = $1 ORDER BY surface`, [grpcOnly.connectorId]);
  expect(surfaces.rows.map((row: any) => row.surface)).toEqual(['otlp_logs', 'otlp_metrics', 'otlp_traces']);
});

test('an unknown OTLP version over gRPC is NOT_FOUND with the advertisement and counted on the otlp-grpc row', async () => {
  const before = await pool.query(
    `SELECT safe_details FROM session_adapter_health WHERE source = 'otlp-grpc' AND source_instance = $1`, [grpcOnly.connectorId]);
  const answer = await exportGrpc('/opentelemetry.proto.collector.logs.v9.LogsService/Export', Buffer.alloc(0), grpcOnly.bearer);
  expect(answer.code).toBe(GRPC_STATUS.NOT_FOUND);
  expect(answer.trailers).toMatchObject({
    'relayhall-code': 'OTLP_VERSION_NOT_ACCEPTED', 'relayhall-accepted-otlp-versions': 'v1', 'relayhall-accepted-majors': '1',
  });
  const after = await pool.query(
    `SELECT status, reason_code, safe_details FROM session_adapter_health WHERE source = 'otlp-grpc' AND source_instance = $1`,
    [grpcOnly.connectorId]);
  expect(after.rows[0]).toMatchObject({ status: 'degraded', reason_code: 'OTLP_VERSION_NOT_ACCEPTED' });
  expect(Number(after.rows[0].safe_details.counts['unsupported.version'])).toBe(1);
  expect(Number(after.rows[0].safe_details.counts.requests)).toBe(Number(before.rows[0].safe_details.counts.requests) + 1);
});
