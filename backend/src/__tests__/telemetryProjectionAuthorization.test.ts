/**
 * RH-TW1c (card `50e74c1d`) — WHAT A CALLER SEES OF THE TELEMETRY PROJECTION
 * IS WHAT ITS OWN ACCOUNT REPORTED, AND A REPLAY MOVES NOTHING.
 *
 * ── THE PROPERTY, AND ITS OUTSIDE ANCHOR ──
 *
 * Two Accounts, each with its own Connector, each pushing envelopes for its
 * own product through the PRODUCTION ingest route. Then every projection
 * surface is read by three callers — Account A, Account B, and a root session
 * — through the PRODUCTION router, with the production authentication and
 * shared-authorization chain in front of it.
 *
 * The expected set is never computed from the narrowing rule. For each caller
 * it is READ BACK FROM THE POINT ROUTE: a session appears in that caller's
 * `GET /telemetry/sessions` if and only if `GET /telemetry/sessions/:ref`
 * answers 200 for the same caller. Both sides are measured, so a test that had
 * been edited into agreement with a broken predicate would still fail — the
 * lesson of card `45e7110a`, applied to a different surface.
 *
 * Four further properties, because closing a leak can open others:
 *
 *   INDISTINGUISHABILITY — another Account's session reference and a reference
 *   that names nothing answer with the same status, code and message,
 *   byte-for-byte. A point route that distinguished them would be an existence
 *   oracle over another Account's sessions.
 *
 *   NON-VACUITY — every caller still sees its OWN rows, with real counts. A
 *   projection that returned nothing to everyone satisfies every containment
 *   assertion above and is the repair this suite must reject as firmly as the
 *   leak.
 *
 *   ROOT SEES BOTH — the A12.1 sentinel is the only arm that crosses Accounts,
 *   and it is exercised rather than assumed.
 *
 *   IDEMPOTENCY UNDER REPLAY — the whole batch is sent AGAIN through the same
 *   route, and every surface is compared to the snapshot taken before. The
 *   write path dedupes on `session_events.idempotency_key`, so a replayed
 *   envelope must insert no row and the derived projection must not move. This
 *   is the property that makes "derived, no projection table" a claim rather
 *   than a preference.
 *
 * ── WHY IT IS NOT IN THE DEFAULT JEST RUN ──
 *
 * It connects to `RELAYHALL_TEST_DB_URL` and FAILS — never skips — when the
 * variable is unset. The narrowing under test is a SQL conjunct over stored
 * rows, and the aggregates are `SUM`s PostgreSQL computes; every DB-shaped
 * suite in the default run mocks the pool, and a mocked pool can only replay
 * the rule this gate exists to measure. Excluded by `testPathIgnorePatterns`,
 * run by `npm run test:telemetry-projection` on the VM gate chain and
 * UNCONDITIONALLY in CI against the `services: postgres` block.
 *
 * ── THE DESTRUCTIVE CONTRACT, STATED ──
 *
 * This suite WRITES to principals, principal_credentials, services,
 * service_descriptor_versions, session_events and telemetry_raw_blobs. It
 * refuses any URL naming a deployment database (`relayhall_dev`,
 * `relayhall_tst`, `relayhall_prod`, `relayhall`). Bring the database up with
 * `database/init.sql` and `npm run migrate`, and throw it away afterwards.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

// ─────────────────────────── the database contract ───────────────────────────

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error(
    'RELAYHALL_TEST_DB_URL is not set. This gate measures which telemetry rows a caller may read, and '
    + 'whether a replayed batch moves the projection, against a REAL PostgreSQL. It refuses to skip: the '
    + 'narrowing is a SQL conjunct and the rollups are SQL aggregates. Create a disposable database, load '
    + 'database/init.sql, run npm run migrate, and set RELAYHALL_TEST_DB_URL to it.',
  );
}

const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = parsed.pathname.replace(/^\//, '');
const FORBIDDEN_DATABASES = ['relayhall_dev', 'relayhall_tst', 'relayhall_prod', 'relayhall'];
if (FORBIDDEN_DATABASES.includes(TEST_DB_NAME)) {
  throw new Error(`RELAYHALL_TEST_DB_URL names a deployment database (${TEST_DB_NAME}). This suite writes; point it at a disposable database.`);
}

process.env.DB_HOST = parsed.hostname;
process.env.DB_PORT = parsed.port || '5432';
process.env.DB_NAME = TEST_DB_NAME;
process.env.DB_USER = decodeURIComponent(parsed.username);
process.env.DB_PASSWORD = decodeURIComponent(parsed.password);
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'telemetry-projection-suite-0123456789abcdef';
process.env.RELAYHALL_SESSIONS = 'on';
// A deterministic TEST pepper, in the shape the credential keyset uses. The
// pseudonyms this produces are stable for the run, which is what lets a session
// reference be read back out of a list and handed to the point route.
process.env.RELAYHALL_TELEMETRY_PEPPERS = process.env.RELAYHALL_TELEMETRY_PEPPERS
  || JSON.stringify({ testpepper: Buffer.alloc(32, 11).toString('base64') });
process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER = process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER || 'testpepper';

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

/** The batch interval, taken from the limiter itself and never copied. */
const TELEMETRY_BATCH_INTERVAL_MS: number = TELEMETRY_MIN_INTERVAL_MS.events_batch;

jest.setTimeout(300_000);

// ──────────────────────────────── the app ────────────────────────────────────

let server: http.Server;
let origin: string;

function buildApp(): any {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  return app;
}

interface Answer { status: number; json: any; raw: string }

interface Caller {
  label: string;
  principalId: string;
  headers: Record<string, string>;
}

async function send(
  who: Caller, method: string, routePath: string, contentType: string, body?: string,
): Promise<Answer> {
  const response = await fetch(`${origin}${routePath}`, {
    method,
    headers: { 'Content-Type': contentType, ...who.headers },
    body,
  });
  const raw = await response.text();
  let json: any = null;
  try { json = JSON.parse(raw); } catch { json = null; }
  return { status: response.status, json, raw };
}

async function call(who: Caller, method: string, routePath: string, body?: unknown): Promise<Answer> {
  return send(who, method, routePath, 'application/json',
    body === undefined ? undefined : JSON.stringify(body));
}

// ────────────────────────────── the fixtures ─────────────────────────────────

const SYSTEM_ACTOR = { handle: 'telemetry-projection-suite', authMethod: 'system' as const };
const tag = (): string => crypto.randomBytes(6).toString('hex');

interface Tenant {
  label: string;
  product: string;
  /** The human Account at the head of the chain — and the reader. */
  reader: Caller;
  accountId: string;
  /** The Connector credential that pushes envelopes. */
  reporter: Caller;
  connectorId: string;
  /** The `correlation.session_id` values this tenant reported. */
  sessionSeeds: string[];
}

let A: Tenant;
let B: Tenant;
let ROOT: Caller;
/**
 * A SECOND Connector inside Account A, reporting A's product and re-using one
 * of A's session seeds. `session_ref` is HMAC(domain, product|seed), so it
 * lands on the SAME pseudonym as A's first reporter — which is the collision
 * the point route's key must survive.
 */
let COLLIDER: { caller: Caller; connectorId: string };
let COLLIDING_REF: string;

/**
 * A Connector that REPORTED, then MOVED — the round-2 blocker, as a fixture.
 *
 * It pushes under Account `from`, is re-parented to Account `to`, and pushes
 * again under the SAME product and the SAME session seed, so both halves land
 * on ONE advertised triple whose stored rows carry two different `account_id`
 * values. Grouping the list by the Account split that triple into two rows
 * root could not tell apart, only the newer of which the point route could
 * reach, while `stats.totals.sessions` counted the triple once.
 */
interface Migrant {
  product: string;
  connectorId: string;
  sessionRef: string;
  from: { accountId: string; reader: Caller; events: number };
  to: { accountId: string; reader: Caller; events: number };
}
let MIGRANT: Migrant;

/**
 * A Connector TWO HOPS below its Account, which is what separates the chain
 * head from `parent_principal_id`.
 *
 * Migration 096's chain-shape trigger requires a Connector's parent to be a
 * PARENTLESS Account at the moment the Connector is written, and it fires
 * `BEFORE INSERT OR UPDATE OF parent_principal_id, kind` on THAT row — so it
 * never revalidates the Connector when its parent later gains a parent of its
 * own. This fixture walks exactly that path: a parentless service Account, a
 * Connector under it, and then an Account above the pair. Write attribution
 * takes the head of the authenticated chain, so the Connector's events are
 * attributed to the TOP, while its `parent_principal_id` still names the
 * middle. The frame arm has to agree with attribution, not with one hop.
 */
interface DeepChain {
  product: string;
  connectorId: string;
  middleId: string;
  headId: string;
  reader: Caller;
}
let DEEP: DeepChain;

async function makeHuman(role: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, 'telemetry projection suite account', 'active', $2) RETURNING id`,
    [`tel-human-${tag()}`, role],
  );
  return String(result.rows[0].id);
}

async function sessionCallerFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

/**
 * A Connector in the shape the ingest contract admits: parented under the
 * Account so `resolveChain` produces `Connector -> Account`, named by a
 * `kind = 'connector'` registry row (which is what
 * `connectorRegistry.isRegistryConnector` asks about), and carrying a current
 * descriptor version that DECLARES a telemetry tier and its product allowlist.
 * Every one of those is load-bearing: drop any and ingest refuses, which is
 * the D3 deny-by-default this suite depends on being satisfied honestly.
 */
async function makeReporter(accountId: string, product: string): Promise<{ caller: Caller; connectorId: string }> {
  const connector = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, 'telemetry projection suite connector', 'active', $2, $3, $4::jsonb) RETURNING id`,
    [`tel-connector-${tag()}`, accountId, 'telemetry projection suite connector',
      JSON.stringify({ scopes: 'parent', objects: 'parent' })],
  );
  const connectorId = String(connector.rows[0].id);

  const descriptor = { telemetry: { tier: 'presence', products: [product] } };
  const service = await pool.query(
    `INSERT INTO services (slug, name, description, kind, status, principal_id, current_descriptor_version)
     VALUES ($1, 'telemetry projection suite connector', 'telemetry projection suite', 'connector', 'published', $2, 1)
     RETURNING id`,
    [`tel-conn-${tag()}`, connectorId],
  );
  await pool.query(
    `INSERT INTO service_descriptor_versions (service_id, version, descriptor, content_hash, created_by_principal_id)
     VALUES ($1, 1, $2::jsonb, $3, NULL)`,
    [
      String(service.rows[0].id),
      JSON.stringify(descriptor),
      crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex'),
    ],
  );

  const issued = await principalService.issueCredential(
    { principalId: connectorId, scopes: ['telemetry:write'], transport: 'any' }, SYSTEM_ACTOR);
  return {
    connectorId,
    caller: {
      label: `reporter for ${product}`,
      principalId: connectorId,
      headers: { Authorization: `Bearer ${issued.fullKey}` },
    },
  };
}

/** One well-formed `rh.ai.telemetry/1.0` record. Tier-0 safe throughout. */
function envelope(product: string, sessionSeed: string, index: number): Record<string, unknown> {
  return {
    schema_version: 'rh.ai.telemetry/1.0',
    // A STABLE event id: the §4.3 identity key is a function of it and the
    // connector, so replaying this exact record must be a duplicate.
    event_id: `evt-${product}-${sessionSeed}-${index}`,
    occurred_at: new Date(Date.now() - (index + 1) * 1000).toISOString(),
    source: {
      product,
      adapter: `${product}-adapter`,
      adapter_version: '1.2.3',
      mechanism: 'push',
      support_level: 'tested',
    },
    correlation: { session_id: sessionSeed },
    kind: 'model_call',
    phase: index === 0 ? 'completed' : 'running',
    model: { provider: 'anthropic', resolved: 'claude-opus-5', operation: 'chat' },
    usage: {
      input_tokens: 100 + index,
      output_tokens: 20 + index,
      requests: 1,
      cost: { amount: 0.25, currency: 'USD', basis: 'estimated' },
    },
    timing: { duration_ms: 1200 + index },
    outcome: { status: 'ok' },
  };
}

async function makeTenant(label: string, product: string, sessionSeeds: string[]): Promise<Tenant> {
  const accountId = await makeHuman('user');
  const reader = await sessionCallerFor(`${label} reader`, accountId);
  const { caller: reporter, connectorId } = await makeReporter(accountId, product);
  return { label, product, reader, accountId, reporter, connectorId, sessionSeeds };
}

/**
 * The tenant's whole batch, as ONE spool upload through the PRODUCTION route.
 *
 * `POST /telemetry/events/batch` rather than four singles, because the
 * DEPLOYMENT-WIDE receiver limit (owner decision D6) admits one accepted event
 * per second per principal and one BATCH per ten — so a reporter with a spool
 * uses the spool endpoint, and a fixture that hammered the single endpoint
 * would be testing the limiter, not the projection. The limit is real product
 * behaviour and this suite conforms to it rather than disabling it.
 */
async function pushBatch(tenant: Tenant): Promise<void> {
  const lines = tenant.sessionSeeds
    .flatMap((seed) => [0, 1].map((index) => JSON.stringify(envelope(tenant.product, seed, index))))
    .join('\n');
  const answer = await send(
    tenant.reporter, 'POST', '/telemetry/events/batch', 'application/x-ndjson', lines);
  // The ingest contract is not what this suite measures, so a refusal here is
  // a broken FIXTURE, not a finding - and it must fail loudly rather than
  // leave the projection empty and every containment assertion vacuously true.
  if (answer.status !== 200 || answer.json?.refused !== 0) {
    throw new Error(`${tenant.label} ingest fixture refused: ${answer.status} ${answer.raw}`);
  }
}

/**
 * One spool upload for a caller that is not a `Tenant` — the migrant and the
 * deep chain. Same production route, same loud failure on a refused fixture.
 */
async function pushEvents(
  who: Caller, product: string, seed: string, indices: number[], label: string,
): Promise<void> {
  const lines = indices.map((index) => JSON.stringify(envelope(product, seed, index))).join('\n');
  const answer = await send(who, 'POST', '/telemetry/events/batch', 'application/x-ndjson', lines);
  if (answer.status !== 200 || answer.json?.refused !== 0) {
    throw new Error(`${label} ingest fixture refused: ${answer.status} ${answer.raw}`);
  }
}

/** The single pseudonym a Connector's stored rows carry. */
async function soleSessionRefOf(connectorId: string): Promise<string> {
  const result = await pool.query(
    `SELECT DISTINCT session_ref FROM session_events
      WHERE schema_version IS NOT NULL AND connector_id = $1`,
    [connectorId],
  );
  if (result.rows.length !== 1) {
    throw new Error(`expected one pseudonym for ${connectorId}, found ${result.rows.length}`);
  }
  return String(result.rows[0].session_ref);
}

/** The receiver admits one BATCH per interval per principal; wait it out. */
async function waitOutTheBatchInterval(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, TELEMETRY_BATCH_INTERVAL_MS + 1_000); });
}

/** The same batch again. Waits out the batch interval rather than evading it. */
async function replayBatch(tenant: Tenant): Promise<Answer> {
  const lines = tenant.sessionSeeds
    .flatMap((seed) => [0, 1].map((index) => JSON.stringify(envelope(tenant.product, seed, index))))
    .join('\n');
  await new Promise((resolve) => { setTimeout(resolve, TELEMETRY_BATCH_INTERVAL_MS + 1_000); });
  return send(tenant.reporter, 'POST', '/telemetry/events/batch', 'application/x-ndjson', lines);
}

beforeAll(async () => {
  resetTelemetryPepperCache();
  const app = buildApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  A = await makeTenant('A', `tel-a-${tag()}`, [`sess-a-${tag()}`, `sess-a-${tag()}`]);
  B = await makeTenant('B', `tel-b-${tag()}`, [`sess-b-${tag()}`]);

  const rootId = await makeHuman('admin');
  ROOT = await sessionCallerFor('root session', rootId);

  await pushBatch(A);
  await pushBatch(B);

  // The collider: same Account, same product, same seed as A's FIRST session,
  // and a different Connector. Three events rather than two, so the two groups
  // are distinguishable by their counts alone.
  COLLIDER = await makeReporter(A.accountId, A.product);
  const collidingSeed = A.sessionSeeds[0];
  const colliderLines = [0, 1, 2]
    .map((index) => JSON.stringify({
      ...envelope(A.product, collidingSeed, index),
      // A DIFFERENT event id, or the §4.3 identity would make these duplicates
      // of A's own rows rather than a second session.
      event_id: `collider-${A.product}-${collidingSeed}-${index}`,
    }))
    .join('\n');
  const colliderAnswer = await send(
    COLLIDER.caller, 'POST', '/telemetry/events/batch', 'application/x-ndjson', colliderLines);
  if (colliderAnswer.status !== 200 || colliderAnswer.json?.refused !== 0) {
    throw new Error(`collider ingest fixture refused: ${colliderAnswer.status} ${colliderAnswer.raw}`);
  }
  const collidingRow = await pool.query(
    `SELECT DISTINCT session_ref FROM session_events
      WHERE schema_version IS NOT NULL AND connector_id = $1`,
    [COLLIDER.connectorId],
  );
  COLLIDING_REF = String(collidingRow.rows[0].session_ref);
  // The fixture is only a fixture if the collision actually happened.
  const shared = await pool.query(
    `SELECT COUNT(DISTINCT connector_id)::int AS n FROM session_events
      WHERE schema_version IS NOT NULL AND session_ref = $1`,
    [COLLIDING_REF],
  );
  if (shared.rows[0].n !== 2) {
    throw new Error(`the collision fixture did not collide: ${shared.rows[0].n} connector(s) share the pseudonym`);
  }

  // ── THE MIGRANT: one Connector, one triple, two Accounts ─────────────────
  const migrantProduct = `tel-m-${tag()}`;
  const migrantSeed = `sess-m-${tag()}`;
  const movedFrom = await makeHuman('user');
  const movedTo = await makeHuman('user');
  const migrant = await makeReporter(movedFrom, migrantProduct);
  await pushEvents(migrant.caller, migrantProduct, migrantSeed, [0, 1], 'migrant (before the move)');
  // The move itself: nothing else about the Connector changes — same
  // credential, same registry row, same descriptor, same product.
  await pool.query(
    'UPDATE principals SET parent_principal_id = $1 WHERE id = $2', [movedTo, migrant.connectorId]);
  await waitOutTheBatchInterval();
  await pushEvents(migrant.caller, migrantProduct, migrantSeed, [2, 3, 4], 'migrant (after the move)');
  MIGRANT = {
    product: migrantProduct,
    connectorId: migrant.connectorId,
    sessionRef: await soleSessionRefOf(migrant.connectorId),
    from: { accountId: movedFrom, reader: await sessionCallerFor('moved-from reader', movedFrom), events: 2 },
    to: { accountId: movedTo, reader: await sessionCallerFor('moved-to reader', movedTo), events: 3 },
  };
  // The fixture is only a fixture if the move actually split the stored rows
  // across two Accounts under ONE advertised triple.
  const moved = await pool.query(
    `SELECT COUNT(DISTINCT account_id)::int AS accounts, COUNT(DISTINCT session_ref)::int AS refs
       FROM session_events WHERE schema_version IS NOT NULL AND connector_id = $1`,
    [migrant.connectorId],
  );
  if (moved.rows[0].accounts !== 2 || moved.rows[0].refs !== 1) {
    throw new Error(
      `the migrant fixture did not move: ${moved.rows[0].accounts} account(s), ${moved.rows[0].refs} pseudonym(s)`);
  }

  // ── THE DEEP CHAIN: a Connector two hops below its Account ───────────────
  const deepProduct = `tel-d-${tag()}`;
  // A parentless SERVICE Account — the shape §5.2 rule 6 admits as a
  // Connector's parent, and the one that can later gain a parent of its own
  // (a human cannot: the trigger refuses to give one a parent).
  const middle = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, purpose, own_expression)
     VALUES ('service', $1, 'telemetry projection suite service account', 'active', $2, $3::jsonb) RETURNING id`,
    [`tel-middle-${tag()}`, 'telemetry projection suite service account',
      JSON.stringify({ scopes: 'parent', objects: 'parent' })],
  );
  const middleId = String(middle.rows[0].id);
  // Written while the middle is still parentless, which is when the
  // chain-shape trigger looks at this row — and the last time it ever does.
  const deep = await makeReporter(middleId, deepProduct);
  const deepHead = await makeHuman('user');
  await pool.query(
    'UPDATE principals SET parent_principal_id = $1 WHERE id = $2', [deepHead, middleId]);
  // The middle is now a DELEGATED link, and §5.1 liveness requires every
  // delegated link to hold a live credential of its own.
  await principalService.issueCredential(
    { principalId: middleId, scopes: ['telemetry:write'], transport: 'any' }, SYSTEM_ACTOR);
  await pushEvents(deep.caller, deepProduct, `sess-d-${tag()}`, [0, 1], 'deep chain');
  const deepFrame = await call(deep.caller, 'POST', '/telemetry/frames', { kind: 'heartbeat' });
  if (deepFrame.status !== 200) {
    throw new Error(`the deep-chain frame fixture refused: ${deepFrame.status} ${deepFrame.raw}`);
  }
  DEEP = {
    product: deepProduct,
    connectorId: deep.connectorId,
    middleId,
    headId: deepHead,
    reader: await sessionCallerFor('deep chain head reader', deepHead),
  };
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ───────────────────────── helpers over the surfaces ─────────────────────────

/**
 * `query` exists for the ROOT reads only, and for one reason worth stating.
 *
 * The list carries a row cap (50 by default, 200 maximum). An assertion that a
 * root list contains EXACTLY ONE row for some identity is an assertion about
 * the cap as much as about the projection, and the mutation drill runs this
 * suite fourteen times against ONE disposable database — by the last run the
 * estate holds far more than fifty sessions, and a row cut by the cap would
 * redden a control for a reason that has nothing to do with the mutation. So
 * the root reads that count exact rows ask for the ceiling, and the ones that
 * cannot (`toBeGreaterThanOrEqual`, the biconditional over whatever root
 * lists) stay as they are.
 */
async function sessionsOf(who: Caller, query = ''): Promise<any[]> {
  const answer = await call(who, 'GET', `/telemetry/sessions${query}`);
  expect(answer.status).toBe(200);
  return answer.json.sessions as any[];
}

async function sourcesOf(who: Caller, query = ''): Promise<any[]> {
  const answer = await call(who, 'GET', `/telemetry/presence${query}`);
  expect(answer.status).toBe(200);
  return answer.json.sources as any[];
}

/** The row ceiling, so a root read that counts exact rows is not counting the cap. */
const WIDEST = '?limit=200';

/** The point route, addressed by the TRIPLE the row itself carries. */
function pointPath(row: { sessionRef: string; connectorId: string; sourceProduct: string }): string {
  const query = new URLSearchParams({
    connectorId: row.connectorId, sourceProduct: row.sourceProduct,
  });
  return `/telemetry/sessions/${encodeURIComponent(row.sessionRef)}?${query.toString()}`;
}

async function statsOf(who: Caller): Promise<any> {
  const answer = await call(who, 'GET', '/telemetry/stats');
  expect(answer.status).toBe(200);
  return answer.json;
}

// ───────────────────── the ceiling, read back from the point ─────────────────

describe('what a caller sees is what its own Account reported', () => {
  test('NON-VACUITY: each Account sees its own sources and sessions, with real counts', async () => {
    const aSources = await sourcesOf(A.reader);
    const aSessions = await sessionsOf(A.reader);
    // Two SOURCES now: A's own reporter and the collider, both on A's product,
    // and they are separate sources because a source is (connector, product).
    expect(new Set(aSources.map((s) => s.sourceProduct))).toEqual(new Set([A.product]));
    expect(aSources).toHaveLength(2);
    // Three sessions: A's two, plus the collider's — which shares a pseudonym
    // with one of them and is nonetheless its own row.
    expect(aSessions).toHaveLength(A.sessionSeeds.length + 1);
    // The numbers are the ones that were pushed, not zeroes.
    for (const session of aSessions.filter((s) => s.connectorId === A.connectorId)) {
      expect(session.eventCount).toBe(2);
      expect(session.inputTokens).toBe(201);
      expect(session.outputTokens).toBe(41);
      expect(session.models).toEqual(['claude-opus-5']);
      expect(session.sourceProduct).toBe(A.product);
    }

    const bSources = await sourcesOf(B.reader);
    const bSessions = await sessionsOf(B.reader);
    expect(bSources.map((s) => s.sourceProduct)).toEqual([B.product]);
    expect(bSessions).toHaveLength(B.sessionSeeds.length);
  });

  test('CONTAINMENT: neither Account sees a trace of the other', async () => {
    const aSessions = await sessionsOf(A.reader);
    const bSessions = await sessionsOf(B.reader);
    const aRefs = new Set(aSessions.map((s) => s.sessionRef));
    const bRefs = new Set(bSessions.map((s) => s.sessionRef));
    for (const ref of bRefs) expect(aRefs.has(ref)).toBe(false);
    for (const ref of aRefs) expect(bRefs.has(ref)).toBe(false);

    // Concealment, not merely refusal: the other Account's product name does
    // not appear anywhere in the answer, coverage view included.
    const aStats = await statsOf(A.reader);
    expect(JSON.stringify(aStats)).not.toContain(B.product);
    expect(JSON.stringify(aStats)).not.toContain(B.connectorId);
    const bStats = await statsOf(B.reader);
    expect(JSON.stringify(bStats)).not.toContain(A.product);
    expect(JSON.stringify(bStats)).not.toContain(A.connectorId);
  });

  test('THE EXPECTED SET IS READ BACK FROM THE POINT ROUTE, for every caller', async () => {
    // The universe is the SESSIONS root can see, keyed by the whole triple —
    // a pseudonym alone is not a session (round-1 review `f4c56960`), and a
    // matrix that ranged over pseudonyms would ask a question the route no
    // longer answers.
    const everySession = await sessionsOf(ROOT);
    const identity = (row: any): string => `${row.connectorId}|${row.sourceProduct}|${row.sessionRef}`;
    // If root's list were empty the biconditional below would be vacuous.
    expect(everySession.length).toBeGreaterThanOrEqual(4);

    for (const who of [A.reader, B.reader, ROOT]) {
      const listed = new Set((await sessionsOf(who)).map(identity));
      for (const row of everySession) {
        const point = await call(who, 'GET', pointPath(row));
        const allowed = point.status === 200;
        const key = identity(row);
        expect({ caller: who.label, key, listed: listed.has(key), allowed })
          .toEqual({ caller: who.label, key, listed: listed.has(key), allowed: listed.has(key) });
        if (allowed) {
          expect(point.json.session.sessionRef).toBe(row.sessionRef);
          expect(point.json.session.connectorId).toBe(row.connectorId);
          expect(Array.isArray(point.json.events)).toBe(true);
          expect(point.json.events.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test('a session is the TRIPLE: one pseudonym, two Connectors, two separate sessions', async () => {
    // THE ROUND-1 SECOND BLOCKER, as a measurement. `session_ref` is
    // HMAC(domain, product|seed) — namespaced by the product but NOT by the
    // Connector — so COLLIDER reports the same product and the same source
    // session id as A's first reporter and lands on the SAME pseudonym.
    const rows = (await sessionsOf(A.reader)).filter((s) => s.sessionRef === COLLIDING_REF);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.connectorId)).size).toBe(2);

    // Each point route returns ITS OWN session and only its own events. Before
    // the repair the route picked one group arbitrarily and returned both
    // groups' events under it.
    for (const row of rows) {
      const point = await call(A.reader, 'GET', pointPath(row));
      expect(point.status).toBe(200);
      expect(point.json.session.connectorId).toBe(row.connectorId);
      expect(point.json.session.eventCount).toBe(row.eventCount);
      expect(point.json.events).toHaveLength(row.eventCount);
    }

    // And the estate-wide total counts them as TWO, not one: the totals
    // count the composite grain, so the page cannot contradict itself.
    const listedForA = await sessionsOf(A.reader);
    const statsForA = await statsOf(A.reader);
    expect(statsForA.totals.sessions).toBe(listedForA.length);
  });

  test('an INCOMPLETE or MALFORMED key is refused before any row is read', async () => {
    const row = (await sessionsOf(A.reader))[0];
    for (const path of [
      `/telemetry/sessions/${row.sessionRef}`,
      `/telemetry/sessions/${row.sessionRef}?connectorId=${row.connectorId}`,
      `/telemetry/sessions/${row.sessionRef}?sourceProduct=${row.sourceProduct}`,
      `/telemetry/sessions/${row.sessionRef}?connectorId=not-a-uuid&sourceProduct=${row.sourceProduct}`,
      // Review `a4a748d5` (MINOR): a product key ingest could never have
      // stored used to reach the service, while the route's own comment
      // claimed malformed keys were refused before any row was read. The
      // grammar is now the INGEST grammar, imported rather than restated.
      `/telemetry/sessions/${row.sessionRef}?connectorId=${row.connectorId}`
        + `&sourceProduct=${encodeURIComponent('not a product!')}`,
      `/telemetry/sessions/${row.sessionRef}?connectorId=${row.connectorId}`
        + `&sourceProduct=${encodeURIComponent('x'.repeat(65))}`,
    ]) {
      const answer = await call(A.reader, 'GET', path);
      expect({ path, status: answer.status, code: answer.json?.code })
        .toEqual({ path, status: 400, code: 'INCOMPLETE_SESSION_KEY' });
    }
  });

  test('a WRONG but well-formed key answers exactly as a nonexistent one', async () => {
    // Guessing the other two members of the triple discloses nothing either:
    // a right pseudonym with the wrong Connector lands on the same 404 as a
    // pseudonym that names nothing at all.
    const row = (await sessionsOf(A.reader))[0];
    const wrongConnector = await call(A.reader, 'GET', pointPath({
      ...row, connectorId: crypto.randomUUID(),
    }));
    const wrongProduct = await call(A.reader, 'GET', pointPath({
      ...row, sourceProduct: `absent-${tag()}`,
    }));
    const absent = await call(A.reader, 'GET', pointPath({
      ...row, sessionRef: `rhp_${crypto.randomBytes(24).toString('base64url').slice(0, 27)}`,
    }));
    expect(absent.status).toBe(404);
    expect(wrongConnector.raw).toBe(absent.raw);
    expect(wrongProduct.raw).toBe(absent.raw);
  });

  test('ROOT crosses Accounts — the sentinel arm is exercised, not assumed', async () => {
    const rootSources = await sourcesOf(ROOT);
    const products = rootSources.map((s) => s.sourceProduct);
    expect(products).toEqual(expect.arrayContaining([A.product, B.product]));
    const rootStats = await statsOf(ROOT);
    expect(rootStats.scope).toBe('root');
    expect(rootStats.totals.sources).toBeGreaterThanOrEqual(3);
  });

  test('INDISTINGUISHABILITY: a foreign session and a nonexistent one answer identically', async () => {
    // The foreign row is addressed with ITS OWN complete key — the strongest
    // form of the question, because the caller is not merely guessing.
    const foreign = await call(A.reader, 'GET', pointPath((await sessionsOf(B.reader))[0]));
    const absent = await call(A.reader, 'GET', pointPath({
      sessionRef: `rhp_${crypto.randomBytes(24).toString('base64url').slice(0, 27)}`,
      connectorId: crypto.randomUUID(),
      sourceProduct: `absent-${tag()}`,
    }));
    expect(foreign.status).toBe(404);
    // Byte-for-byte. Two refusals that merely LOOK alike are how they drift.
    expect(foreign.status).toBe(absent.status);
    expect(foreign.raw).toBe(absent.raw);
  });

  test('a malformed reference is refused by SHAPE, before any query', async () => {
    const answer = await call(A.reader, 'GET', '/telemetry/sessions/not-a-pseudonym');
    expect(answer.status).toBe(400);
    expect(answer.json.code).toBe('INVALID_SESSION_REF');
  });
});

// ────────── the Account narrows a read; it never keys an identity ────────────

describe('the Account narrows a read; it never keys an identity', () => {
  const identity = (row: any): string => `${row.connectorId}|${row.sourceProduct}|${row.sessionRef}`;
  const migrantRows = (rows: any[]): any[] => rows.filter((r) => r.connectorId === MIGRANT.connectorId);

  test('a RE-PARENTED Connector is ONE row, addressable, and agrees with the totals', async () => {
    // ROUND-2 BLOCKER 2, as a measurement. Grouping the list by `account_id`
    // split this one advertised triple into an old-Account row and a
    // new-Account row. Every public identity — the row shape, the point
    // route, the react-query key, the React key, the DOM id — is the triple,
    // so root received two rows nothing could tell apart, only the newer of
    // which the point route could reach, while `stats.totals.sessions`
    // counted the triple once.
    const rootSessions = await sessionsOf(ROOT, WIDEST);
    const rootRows = migrantRows(rootSessions);
    expect(rootRows).toHaveLength(1);
    expect(rootRows[0].sessionRef).toBe(MIGRANT.sessionRef);
    expect(rootRows[0].eventCount).toBe(MIGRANT.from.events + MIGRANT.to.events);

    // No two rows in root's list share an identity — which is the defect
    // stated without reference to any count: two rows the triple cannot tell
    // apart, sharing a cache entry, a DOM id and a point lookup.
    expect(new Set(rootSessions.map(identity)).size).toBe(rootSessions.length);

    // Each Account sees its OWN half of the triple, addressable, with its own
    // counts — the narrowing doing exactly the work the group key was doing
    // wrong.
    for (const side of [MIGRANT.from, MIGRANT.to]) {
      const listed = await sessionsOf(side.reader);
      const rows = migrantRows(listed);
      expect(rows).toHaveLength(1);
      expect(rows[0].eventCount).toBe(side.events);
      const point = await call(side.reader, 'GET', pointPath(rows[0]));
      expect(point.status).toBe(200);
      expect(point.json.session.eventCount).toBe(side.events);
      expect(point.json.events).toHaveLength(side.events);
      expect((await statsOf(side.reader)).totals.sessions).toBe(listed.length);
    }

    // And root reaches the WHOLE triple through the same point route — the
    // older half is not merely listed, it is readable.
    const rootPoint = await call(ROOT, 'GET', pointPath(rootRows[0]));
    expect(rootPoint.status).toBe(200);
    expect(rootPoint.json.events).toHaveLength(MIGRANT.from.events + MIGRANT.to.events);
  });

  test('presence is ONE source per (connector, product), with the Account DERIVED', async () => {
    const rootSource = (await sourcesOf(ROOT, WIDEST)).filter((s) => s.connectorId === MIGRANT.connectorId);
    expect(rootSource).toHaveLength(1);
    // The Account reaches the caller as the NEWEST row's — an attribute of
    // the source, not a member of its key.
    expect(rootSource[0].accountId).toBe(MIGRANT.to.accountId);
    expect(rootSource[0].eventCount).toBe(MIGRANT.from.events + MIGRANT.to.events);
    expect(rootSource[0].sessionCount).toBe(1);

    for (const side of [MIGRANT.from, MIGRANT.to]) {
      const own = (await sourcesOf(side.reader)).filter((s) => s.connectorId === MIGRANT.connectorId);
      expect(own).toHaveLength(1);
      expect(own[0].accountId).toBe(side.accountId);
      expect(own[0].eventCount).toBe(side.events);
    }
  });

  test('the frame arm follows the CHAIN HEAD, not the Connector parent', async () => {
    // ROUND-2 BLOCKER 1, as a measurement, and it needs a chain deeper than
    // one hop to be measurable at all — which is why the fixture builds one.
    //
    // The fixture is only a fixture if the Connector really is two hops down,
    // so that is read from the substrate rather than assumed.
    const parent = await pool.query(
      'SELECT parent_principal_id FROM principals WHERE id = $1', [DEEP.connectorId]);
    expect(String(parent.rows[0].parent_principal_id)).toBe(DEEP.middleId);
    expect(DEEP.middleId).not.toBe(DEEP.headId);

    const rows = (await sourcesOf(DEEP.reader)).filter((s) => s.connectorId === DEEP.connectorId);
    expect(rows).toHaveLength(1);
    // Write attribution took the chain HEAD, so this Account owns the rows.
    expect(rows[0].accountId).toBe(DEEP.headId);
    // And it owns the reporter's frame. Under the one-hop test this is null,
    // because `parent_principal_id` names the MIDDLE — a live reporter's frame
    // withheld from the Account its own events are attributed to.
    expect(rows[0].connectorFrame).not.toBeNull();
    expect(rows[0].connectorFrame.kind).toBe('heartbeat');

    // The other direction stays closed: an Account that owns none of this
    // reporter's rows sees no source for it, and so no frame either.
    expect((await sourcesOf(A.reader)).filter((s) => s.connectorId === DEEP.connectorId)).toHaveLength(0);
  });
});

// ─────────────────────── the projection is Tier-0 metadata ───────────────────

describe('nothing but Tier-0 metadata leaves these routes', () => {
  test('no session reference is a source identifier — it is a pseudonym', async () => {
    const sessions = await sessionsOf(A.reader);
    for (const session of sessions) {
      expect(session.sessionRef).toMatch(/^rhp_[A-Za-z0-9_-]{27}$/);
      // The seed the reporter actually sent never appears in the answer.
      for (const seed of A.sessionSeeds) expect(session.sessionRef).not.toContain(seed);
    }
    const body = JSON.stringify(sessions);
    for (const seed of A.sessionSeeds) expect(body).not.toContain(seed);
  });

  test('the timeline carries no content field of any kind', async () => {
    const point = await call(A.reader, 'GET', pointPath((await sessionsOf(A.reader))[0]));
    expect(point.status).toBe(200);
    const body = JSON.stringify(point.json);
    for (const forbidden of ['prompt', 'response', 'tool_input', 'tool_output', 'promptRef', 'responseRef']) {
      expect(body).not.toContain(forbidden);
    }
  });

  test('cost carries its BASIS, and the amount survives as a string', async () => {
    const stats = await statsOf(A.reader);
    expect(stats.cost.length).toBeGreaterThan(0);
    for (const row of stats.cost) {
      expect(['provider', 'estimated']).toContain(row.basis);
      expect(typeof row.amount).toBe('string');
      expect(row.currency).toBe('USD');
    }
    // Every fixture event carries the same 0.25, so the total is the event
    // total times that — read back from the projection rather than restated as
    // a literal, which would have to be edited every time the fixture grows.
    expect(Number(stats.cost[0].amount)).toBeCloseTo(0.25 * stats.totals.events, 6);
    expect(stats.cost[0].events).toBe(stats.totals.events);
  });
});

// ──────────────────────── idempotency under replay ───────────────────────────

describe('a replayed batch moves nothing', () => {
  test('every surface is byte-identical after the whole batch is sent again', async () => {
    /** `windowStart` is a function of the wall clock and is expected to move. */
    const normalize = (value: any): string => {
      const clone = JSON.parse(JSON.stringify(value));
      delete clone.windowStart;
      return JSON.stringify(clone);
    };

    const beforeSources = normalize(await sourcesOf(A.reader));
    const beforeSessions = normalize(await sessionsOf(A.reader));
    const beforeStats = normalize(await statsOf(A.reader));
    const beforeRoot = normalize(await statsOf(ROOT));

    // The SAME records, through the SAME production route. Every one is
    // accepted and reported as a DUPLICATE: the route does not refuse a
    // replay, it recognizes it - which is the property the projection's
    // idempotency actually rests on.
    const replay = await replayBatch(A);
    expect(replay.status).toBe(200);
    expect(replay.json.refused).toBe(0);
    expect(replay.json.accepted).toBe(0);
    expect(replay.json.duplicates).toBe(A.sessionSeeds.length * 2);

    expect(normalize(await sourcesOf(A.reader))).toBe(beforeSources);
    expect(normalize(await sessionsOf(A.reader))).toBe(beforeSessions);
    expect(normalize(await statsOf(A.reader))).toBe(beforeStats);
    // And the estate-wide view too, so a replay cannot move a total that no
    // single Account's view would have shown.
    expect(normalize(await statsOf(ROOT))).toBe(beforeRoot);
  });

  test('the replay wrote NO rows — measured at the table, not inferred from the answer', async () => {
    const countOf = async (): Promise<number> => {
      const result = await pool.query(
        `SELECT COUNT(*)::int AS n FROM session_events
          WHERE schema_version IS NOT NULL AND account_id = $1`,
        [A.accountId],
      );
      return result.rows[0].n as number;
    };
    const before = await countOf();
    // A's own reporter wrote two per seed; the collider wrote three more, all
    // under the same Account.
    expect(before).toBe(A.sessionSeeds.length * 2 + 3);
    await replayBatch(A);
    expect(await countOf()).toBe(before);
  });
});
