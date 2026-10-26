/**
 * RH-TW1b slice 1 (card `dac2ca71`) — THE OTLP/HTTP RECEIVERS AGAINST A REAL
 * POSTGRESQL, THROUGH THE PRODUCTION ROUTER, AUTHENTICATION AND MIGRATIONS.
 *
 * Every committed capture — Claude Code over protobuf and JSON, and the
 * OpenTelemetry Python SDK over protobuf — is replayed by a real Connector
 * credential to `POST /telemetry/otlp/v1/<signal>` exactly as its producer sent
 * it. Then, measured in the database rather than in a double:
 *
 *   STORED AS TRANSLATED — one `session_events` row per record the receiver
 *   answered as accepted, with the producer's measurements EXACT after a
 *   round trip through PostgreSQL's `jsonb` (X1-R3 across the seam).
 *
 *   IDEMPOTENT UNDER REPLAY — the whole set is sent again; no row is added,
 *   because the content-hash identity is derived from the stored record and
 *   `session_events.idempotency_key` is UNIQUE (B2-R3's shape, measured where
 *   the dedupe actually happens).
 *
 *   NOTHING THE TRANSLATION DROPS IS ANYWHERE — a SCHEMA-WIDE absence scan
 *   over every text-bearing column of every base table, derived from
 *   `information_schema` at query time, for the content the captures carry
 *   (prompt and response markers, exception messages, span input/output,
 *   addresses, account ids). Its own positive control must find what WAS
 *   stored, so an empty write cannot pass it.
 *
 *   THE SURFACES EXIST — migration 163 is applied: the OTLP rate surfaces are
 *   rows in `telemetry_rate_limits` under its CHECK.
 *
 *   SURFACED ON ADAPTER HEALTH — the Connector's `otlp-http` row carries the
 *   counts and the accepted-version advertisement, and an unknown OTLP version
 *   is counted there.
 *
 *   RENDERED — the Claude Code session the receiver stored is listed by
 *   `GET /telemetry/sessions` for the Connector's own Account (TW1c).
 *
 * It connects to `RELAYHALL_TEST_DB_URL` and FAILS — never skips — when the
 * variable is unset. Excluded from the default jest run; run by
 * `npm run test:telemetry-otlp` and unconditionally by the full CI tier.
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
import { loadOtlpFixtures, type OtlpFixture } from './support/otlpFixtures';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error(
    'RELAYHALL_TEST_DB_URL is not set. This gate measures what the OTLP receivers store, dedupe and refuse '
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
process.env.JWT_SECRET = process.env.JWT_SECRET || 'telemetry-otlp-suite-0123456789abcdef';
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
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { resetTelemetryPepperCache } = require('../utils/telemetryPepper');
const { TELEMETRY_MIN_INTERVAL_MS } = require('../services/TelemetryRateLimitService');
const { decodeOtlpJson, decodeOtlpProtobuf } = require('../utils/otlp/otlpDecode');

jest.setTimeout(300_000);

let server: http.Server;
let origin: string;
const tag = (): string => crypto.randomBytes(6).toString('hex');
const SYSTEM_ACTOR = { handle: 'telemetry-otlp-suite', authMethod: 'system' as const };

let accountId: string;
let connectorId: string;
let reporterHeaders: Record<string, string>;
let readerHeaders: Record<string, string>;

const fixtures: OtlpFixture[] = loadOtlpFixtures();
/** The OTLP interval per signal, from the limiter itself and never copied. */
const OTLP_INTERVAL_MS = Math.max(
  TELEMETRY_MIN_INTERVAL_MS.otlp_traces, TELEMETRY_MIN_INTERVAL_MS.otlp_logs, TELEMETRY_MIN_INTERVAL_MS.otlp_metrics);

interface Exported { status: number; body: Buffer; type: string }

async function exportFixture(fixture: OtlpFixture): Promise<Exported> {
  const response = await fetch(`${origin}/telemetry/otlp/v1/${fixture.signal}`, {
    method: 'POST',
    headers: { 'Content-Type': fixture.contentType, ...reporterHeaders },
    body: fixture.body,
  });
  return { status: response.status, body: Buffer.from(await response.arrayBuffer()), type: response.headers.get('content-type') ?? '' };
}

/** Rejected count from either encoding's partial-success response. */
function rejectedIn(answer: Exported, fixture: OtlpFixture): number {
  if (fixture.contentType === 'application/json') {
    const json = JSON.parse(answer.body.toString('utf8'));
    const partial = json.partialSuccess ?? {};
    return Number(partial.rejectedSpans ?? partial.rejectedLogRecords ?? partial.rejectedDataPoints ?? 0);
  }
  if (answer.body.length === 0) return 0;
  // field 1 (partial_success) → field 1 (rejected count, varint)
  let pos = 0;
  const varint = (bytes: Buffer): number => { let r = 0; let m = 1; for (;;) { const b = bytes[pos++]; r += (b & 0x7f) * m; if ((b & 0x80) === 0) return r; m *= 128; } };
  pos = 1; const innerLength = varint(answer.body); const inner = answer.body.subarray(pos, pos + innerLength);
  pos = 0; if (inner[pos++] !== 0x08) return 0;
  return varint(inner);
}

async function replayAll(): Promise<{ records: number; rejected: number }> {
  let records = 0;
  let rejected = 0;
  for (const fixture of fixtures) {
    // The receiver admits one export per signal per interval per principal;
    // this suite conforms to the limit rather than disabling it.
    await new Promise((resolve) => { setTimeout(resolve, OTLP_INTERVAL_MS + 150); });
    const answer = await exportFixture(fixture);
    if (answer.status !== 200) throw new Error(`${fixture.name} was refused: ${answer.status} ${answer.body.toString('utf8')}`);
    const decoded = fixture.json ? decodeOtlpJson(fixture.signal, fixture.json) : decodeOtlpProtobuf(fixture.signal, fixture.body);
    records += decoded.items.length;
    rejected += rejectedIn(answer, fixture);
  }
  return { records, rejected };
}

async function otlpRowCount(): Promise<number> {
  const result = await pool.query(
    `SELECT count(*)::int AS n FROM session_events WHERE connector_id = $1 AND source LIKE 'otlp.%'`, [connectorId]);
  return result.rows[0].n;
}

/** Content and identifiers the captures carry that no translation may store. */
function absenceMarkers(): string[] {
  const markers = [
    '<REDACTED>', '@sample.invalid', 'secret prompt text', 'Rate limit reached', 'Too many requests',
    'What is the weather', 'Sunny.', 'api.example.invalid', 'alice@example.invalid', 'cache miss for user',
    'RunnableSequence', 'invoke_agent planner', 'claude_code.api_request', 'mingw64',
  ];
  for (const fixture of fixtures.filter((f) => f.producer === 'claude-code')) {
    const decoded = fixture.json ? decodeOtlpJson(fixture.signal, fixture.json) : decodeOtlpProtobuf(fixture.signal, fixture.body);
    for (const item of decoded.items.slice(0, 1)) {
      for (const key of ['user.account_uuid', 'user.account_id', 'organization.id', 'session.id']) {
        const value = item.attributes.get(key)?.value;
        if (value?.kind === 'string') markers.push(value.value);
      }
    }
  }
  return [...new Set(markers)];
}

const CONTROLS = ['otlp.claude-code', 'otlp.openinference'];

/** Hits per marker over every text-bearing column of every base table, derived at query time. */
async function scanAll(): Promise<Map<string, number>> {
  const columns = await pool.query(
    `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
        AND c.data_type IN ('text', 'character varying', 'jsonb', 'json')`);
  if (columns.rows.length < 100) throw new Error(`the schema scan found only ${columns.rows.length} text columns`);
  const hits = new Map<string, number>();
  for (const marker of [...absenceMarkers(), ...CONTROLS]) {
    let total = 0;
    for (const { table_name: table, column_name: column } of columns.rows) {
      const result = await pool.query(
        `SELECT count(*)::int AS n FROM "${table}" WHERE strpos("${column}"::text, $1) > 0`, [marker]);
      total += result.rows[0].n;
    }
    hits.set(marker, total);
  }
  return hits;
}

let baseline: Map<string, number>;
let firstPass: { records: number; rejected: number };
let rowsAfterFirstPass: number;

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

  const human = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, 'otlp suite account', 'active', 'user') RETURNING id`, [`otlp-human-${tag()}`]);
  accountId = String(human.rows[0].id);
  const minted = await loginSessionService.mint({ principalId: accountId });
  readerHeaders = { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` };

  const connector = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, 'otlp suite connector', 'active', $2, 'otlp suite connector', $3::jsonb) RETURNING id`,
    [`otlp-connector-${tag()}`, accountId, JSON.stringify({ scopes: 'parent', objects: 'parent' })]);
  connectorId = String(connector.rows[0].id);
  const descriptor = { telemetry: { tier: 'full', products: ['claude-code', 'otel-python-sample'] } };
  const service = await pool.query(
    `INSERT INTO services (slug, name, description, kind, status, principal_id, current_descriptor_version)
     VALUES ($1, 'otlp suite connector', 'otlp suite', 'connector', 'published', $2, 1) RETURNING id`,
    [`otlp-conn-${tag()}`, connectorId]);
  await pool.query(
    `INSERT INTO service_descriptor_versions (service_id, version, descriptor, content_hash, created_by_principal_id)
     VALUES ($1, 1, $2::jsonb, $3, NULL)`,
    [String(service.rows[0].id), JSON.stringify(descriptor),
      crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex')]);
  const issued = await principalService.issueCredential(
    { principalId: connectorId, scopes: ['telemetry:write'], transport: 'any' }, SYSTEM_ACTOR);
  reporterHeaders = { Authorization: `Bearer ${issued.fullKey}` };

  baseline = await scanAll();
  firstPass = await replayAll();
  rowsAfterFirstPass = await otlpRowCount();
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

test('every accepted record is one stored row, and the receiver both accepted and refused something', async () => {
  expect(firstPass.records).toBeGreaterThan(40);
  expect(firstPass.rejected).toBeGreaterThan(0);
  expect(rowsAfterFirstPass).toBe(firstPass.records - firstPass.rejected);
  const sources = await pool.query(
    `SELECT source, count(*)::int AS n FROM session_events WHERE connector_id = $1 GROUP BY source ORDER BY source`, [connectorId]);
  expect(sources.rows.map((row: any) => row.source)).toEqual(['otlp.claude-code', 'otlp.genai', 'otlp.openinference']);
});

test('the measurements are EXACT after a round trip through jsonb (X1-R3 across the seam)', async () => {
  const stored = await pool.query(
    `SELECT payload->'usage'->'cost'->>'amount' AS amount, (payload->'usage'->>'input_tokens') AS input
       FROM session_events WHERE connector_id = $1 AND source = 'otlp.claude-code' AND event_kind = 'model_call'`, [connectorId]);
  const capture = new Set<number>();
  for (const fixture of fixtures.filter((f) => f.producer === 'claude-code' && f.signal === 'logs')) {
    const decoded = fixture.json ? decodeOtlpJson('logs', fixture.json) : decodeOtlpProtobuf('logs', fixture.body);
    for (const item of decoded.items) {
      const cost = item.attributes.get('cost_usd')?.value;
      if (cost?.kind === 'double') capture.add(cost.value);
    }
  }
  expect(stored.rows.length).toBe(capture.size);
  for (const row of stored.rows) expect(capture.has(Number(row.amount))).toBe(true);
});

test('a REPLAY of every capture adds no row (content-hash identity on the UNIQUE key)', async () => {
  const second = await replayAll();
  expect(second.rejected).toBe(firstPass.rejected);
  expect(await otlpRowCount()).toBe(rowsAfterFirstPass);
});

test('nothing the translation drops is stored ANYWHERE in the schema', async () => {
  // The scan is schema-wide and the CI database is shared with other suites, so
  // it compares hit counts BEFORE and AFTER this suite's exports: a marker this
  // suite stored anywhere moves its count; another suite's rows do not.
  const after = await scanAll();
  // The control: what WAS stored is found, so an empty write cannot pass.
  expect(after.get('otlp.claude-code')).toBeGreaterThan(baseline.get('otlp.claude-code') ?? 0);
  expect(after.get('otlp.openinference')).toBeGreaterThan(baseline.get('otlp.openinference') ?? 0);
  for (const marker of absenceMarkers()) {
    expect({ marker, hits: after.get(marker) }).toEqual({ marker, hits: baseline.get(marker) });
  }
});

test('migration 163 is applied: the OTLP surfaces are rows under the widened CHECK', async () => {
  const surfaces = await pool.query(
    `SELECT surface FROM telemetry_rate_limits WHERE principal_id = $1 ORDER BY surface`, [connectorId]);
  expect(surfaces.rows.map((row: any) => row.surface)).toEqual(['otlp_logs', 'otlp_metrics', 'otlp_traces']);
  await expect(pool.query(
    `INSERT INTO telemetry_rate_limits (principal_id, surface, last_accepted_at) VALUES ($1, 'otlp_profiles', now())`,
    [connectorId])).rejects.toThrow(/check constraint/);
});

test('surfaced on adapter health, with the advertisement; an unknown version is counted there', async () => {
  const before = await pool.query(
    `SELECT safe_details FROM session_adapter_health WHERE source = 'otlp-http' AND source_instance = $1`, [connectorId]);
  expect(before.rows).toHaveLength(1);
  const details = before.rows[0].safe_details;
  expect(details).toMatchObject({ schemaFamily: 'rh.ai.telemetry', acceptedMajors: [1], acceptedOtlpVersions: ['v1'] });
  expect(Number(details.counts['records.accepted']) + Number(details.counts['records.duplicate'])).toBe(2 * rowsAfterFirstPass);
  expect(Number(details.counts['attributes.carried']) + Number(details.counts['attributes.dropped']))
    .toBe(Number(details.counts['attributes.entries']));

  const response = await fetch(`${origin}/telemetry/otlp/v9/logs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...reporterHeaders }, body: '{}',
  });
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ rhCode: 'OTLP_VERSION_NOT_ACCEPTED', acceptedOtlpVersions: ['v1'] });
  const after = await pool.query(
    `SELECT status, reason_code, safe_details FROM session_adapter_health WHERE source = 'otlp-http' AND source_instance = $1`, [connectorId]);
  expect(after.rows[0]).toMatchObject({ status: 'degraded', reason_code: 'OTLP_VERSION_NOT_ACCEPTED' });
  expect(Number(after.rows[0].safe_details.counts['unsupported.version'])).toBe(1);
  // The counters ACCUMULATE: the earlier totals are still there.
  expect(Number(after.rows[0].safe_details.counts.requests)).toBe(Number(details.counts.requests) + 1);
});

test('the stored Claude Code session renders on the Sessions list for its own Account', async () => {
  const response = await fetch(`${origin}/telemetry/sessions?includeShort=true&sourceProduct=claude-code`, { headers: readerHeaders });
  expect(response.status).toBe(200);
  const body = await response.json() as any;
  const mine = (body.sessions ?? []).filter((session: any) => session.connectorId === connectorId);
  expect(mine.length).toBeGreaterThan(0);
});
