/**
 * Card 653be44f · `GET /principals/me/connectors` — the own-chain read model
 * behind the day-one connection flow (owner design record 99d6b0ad §3.1).
 *
 * What these tests are for, stated so a later reader does not have to guess:
 *
 *  1. CONCEALMENT IS STRUCTURAL. The route takes no id. The claim under test
 *     is that the SQL the route issues is anchored on the CALLER's own
 *     principal id — so the two-principal test does not merely check that Bob
 *     gets a 404 on Alice's row (there is no row parameter to try), it checks
 *     that the query Bob's request produces asks for BOB's subtree. A second
 *     identity that received Alice's rows would be a substrate defect the
 *     status code could never show.
 *  2. NO SECRET LEAVES. Asserted twice and from opposite ends: the response
 *     body carries no credential-shaped string, and the SQL never NAMES a
 *     secret column except as the `IS NOT NULL` revealability test.
 *  3. The re-showable instructions are rendered by the §7.4 composer with a
 *     placeholder where the token was — so they cannot drift from the pack,
 *     and re-opening them hands out nothing.
 *
 * The REAL route over an armed pool; assertions read the SQL issued and the
 * body rendered. No database is contacted.
 */
import express from 'express';
import http from 'http';

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import { pool } from '../db/connection';
import principalsRouter from '../routes/principals';
import { credentialState } from '../services/OwnConnectorsService';

const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONNECTOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const AGENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

let server: http.Server;
let baseUrl: string;
let statements: Array<{ sql: string; params: unknown[] }>;
/** Whose session the next request runs as. */
let actingPrincipalId: string;
/** Rows the armed pool hands back for the connector query. */
let connectorRows: Array<Record<string, unknown>>;

const CONNECTOR_ROW = {
  id: CONNECTOR,
  handle: 'connector-laptop',
  display_name: 'Laptop',
  status: 'active',
  last_seen_at: new Date('2026-09-04T09:00:00Z'),
  purpose: 'Connector for service laptop',
  service_id: '99999999-9999-4999-8999-999999999999',
  slug: 'laptop',
  name: 'Laptop',
  description: 'Claude Code',
  service_status: 'draft',
  runtime_mode: 'direct',
  service_created_at: new Date('2026-09-04T08:00:00Z'),
};

const AGENT_ROW = {
  id: AGENT,
  handle: 'agent-task-1',
  display_name: null,
  status: 'active',
  last_seen_at: null,
  parent_principal_id: CONNECTOR,
  bound_task_id: '77777777-7777-4777-8777-777777777777',
  minted_under_warrant_id: null,
  terminated_at: null,
};

const LIVE_CREDENTIAL = {
  id: '11111111-1111-4111-8111-111111111111',
  principal_id: CONNECTOR,
  key_id: 'rh_dev_abcde',
  label: 'Laptop',
  scopes: ['tasks:read', 'tasks:write'],
  created_at: new Date('2026-09-04T08:00:00Z'),
  expires_at: null,
  revoked_at: null,
  last_used_at: new Date('2026-09-04T09:30:00Z'),
  reveal_count: 0,
  grace_until: null,
  transport: 'any',
  revealable: true,
};

const REVOKED_CREDENTIAL = {
  ...LIVE_CREDENTIAL,
  id: '22222222-2222-4222-8222-222222222222',
  key_id: 'rh_dev_fghij',
  revoked_at: new Date('2026-09-04T09:00:00Z'),
  revealable: true,
};

const AGENT_CREDENTIAL = {
  ...LIVE_CREDENTIAL,
  id: '33333333-3333-4333-8333-333333333333',
  principal_id: AGENT,
  key_id: 'rh_dev_klmno',
  label: null,
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).principal = { id: actingPrincipalId, handle: 'someone', kind: 'human', role: 'user' };
    (req as any).scopes = ['tasks:read', 'principals:read', 'services:write'];
    (req as any).authMethod = 'session';
    next();
  });
  app.use('/principals', principalsRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  statements = [];
  actingPrincipalId = ALICE;
  connectorRows = [CONNECTOR_ROW];
  (pool.query as jest.Mock).mockImplementation(async (text: string, params: unknown[]) => {
    const sql = String(text).replace(/\s+/g, ' ').trim();
    statements.push({ sql, params });
    if (sql.includes('JOIN services s ON s.principal_id = p.id')) return { rows: connectorRows };
    if (sql.includes("kind = 'agent'")) return { rows: [AGENT_ROW] };
    if (sql.includes('FROM principal_credentials')) {
      return { rows: [LIVE_CREDENTIAL, REVOKED_CREDENTIAL, AGENT_CREDENTIAL] };
    }
    throw new Error(`unexpected sql: ${sql.slice(0, 120)}`);
  });
});

const get = () => fetch(`${baseUrl}/principals/me/connectors`);

describe('GET /principals/me/connectors — the caller own chain', () => {
  it('returns the Connector, its credentials and the Agents minted beneath it', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.connectors).toHaveLength(1);
    const connector = body.connectors[0];
    expect(connector.principalId).toBe(CONNECTOR);
    expect(connector.service.slug).toBe('laptop');
    expect(connector.service.description).toBe('Claude Code');
    expect(connector.credentials.map((c: any) => c.state)).toEqual(['live', 'revoked']);
    expect(connector.agents).toHaveLength(1);
    expect(connector.agents[0].id).toBe(AGENT);
    expect(connector.agents[0].boundTaskId).toBe('77777777-7777-4777-8777-777777777777');
    // The Agent's own credential rides under the Agent, never under the
    // Connector: the chain the page draws is the chain the read model built.
    expect(connector.agents[0].credentials.map((c: any) => c.id)).toEqual([AGENT_CREDENTIAL.id]);
    expect(connector.credentials.map((c: any) => c.id)).not.toContain(AGENT_CREDENTIAL.id);
  });

  it('anchors the query on the CALLER own principal id — the concealment is in the WHERE, not a post-filter', async () => {
    await get();
    const connectorQuery = statements.find((s) => s.sql.includes('JOIN services s ON s.principal_id = p.id'))!;
    expect(connectorQuery.sql).toContain('WHERE p.parent_principal_id = $1');
    expect(connectorQuery.params[0]).toBe(ALICE);
  });

  it('TWO PRINCIPALS: a second session asks for its OWN subtree, never the first one', async () => {
    await get();
    statements = [];
    actingPrincipalId = BOB;
    connectorRows = [];
    const response = await get();
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.connectors).toEqual([]);
    const connectorQuery = statements.find((s) => s.sql.includes('JOIN services s ON s.principal_id = p.id'))!;
    expect(connectorQuery.params[0]).toBe(BOB);
    expect(connectorQuery.params).not.toContain(ALICE);
    // An empty chain short-circuits: no credential or agent query is issued
    // with an empty id list, so an empty array can never be read as "every row".
    expect(statements.filter((s) => s.sql.includes('FROM principal_credentials'))).toHaveLength(0);
  });

  it('NO SECRET LEAVES — the body carries no credential-shaped string', async () => {
    const body = await (await get()).text();
    expect(body).not.toMatch(/secretOnce/);
    expect(body).not.toMatch(/secret_hash/);
    expect(body).not.toMatch(/secret_ciphertext/);
    // The PUBLIC key id is expected — it names a credential without being one.
    expect(body).toContain('rh_dev_abcde');
    // The leak control uses the grammar the board actually mints,
    // `rh_<env>_<keyId>.<secret>` (PrincipalService.parsePrincipalKey), with a
    // DOT before the secret. A live QA probe written with an underscore there
    // matched nothing at all, so its "no credential leaked" answer was true by
    // construction — which is why the pattern is proved able to FIRE here
    // before it is trusted to stay silent.
    const TOKEN = /rh_(live|dev)_[A-Za-z0-9]{6,64}\.[A-Za-z0-9_-]{20,128}/;
    expect(TOKEN.test('rh_dev_ab12cd34ef56.SECRETVALUE0000000000')).toBe(true);
    expect(TOKEN.test('rh_dev_abcde')).toBe(false);
    expect(body).not.toMatch(TOKEN);
  });

  it('NO SECRET LEAVES — the SQL names a secret column only as the revealability test', async () => {
    await get();
    const credentialQuery = statements.find((s) => s.sql.includes('FROM principal_credentials'))!;
    expect(credentialQuery.sql).toContain('secret_ciphertext IS NOT NULL AS revealable');
    expect(credentialQuery.sql).not.toContain('secret_hash');
    expect(credentialQuery.sql.match(/secret_ciphertext/g)).toHaveLength(1);
    expect(credentialQuery.sql).toContain("credential_type <> 'password'");
  });

  it('re-showable instructions carry the PLACEHOLDER where the one-time token was', async () => {
    const body = await (await get()).json() as any;
    const placeholder = body.instructions.credentialPlaceholder;
    expect(placeholder).toBe('<paste your connection credential here>');
    expect(body.instructions.bootstrapLine).toContain(body.instructions.boardEndpoint);
    expect(JSON.stringify(body.instructions.mcpConfig)).toContain(placeholder);
    expect(body.instructions.cliEnv.join('\n')).toContain(placeholder);
    // The placeholder must not be mistakable for a credential: the auth
    // middleware parses `rh_<env>_<id>_<secret>`, and this parses as nothing.
    expect(placeholder).not.toMatch(/^rh_/);
  });

  it('answers 404 when the session resolves no principal, exactly as /principals/me does', async () => {
    const app = express();
    app.use((req, _res, next) => { (req as any).scopes = ['principals:read']; next(); });
    app.use('/principals', principalsRouter);
    const local = http.createServer(app);
    await new Promise<void>((resolve) => local.listen(0, resolve));
    const port = (local.address() as any).port;
    const response = await fetch(`http://127.0.0.1:${port}/principals/me/connectors`);
    expect(response.status).toBe(404);
    await new Promise<void>((resolve) => local.close(() => resolve()));
  });

  it('answers 503, not 500, while the identity substrate is unmigrated', async () => {
    (pool.query as jest.Mock).mockImplementation(async () => {
      const error: any = new Error('relation "services" does not exist');
      error.code = '42P01';
      throw error;
    });
    const response = await get();
    expect(response.status).toBe(503);
  });
});

/**
 * The state derivation, at its BOUNDARIES. A test that samples the interior
 * of an ordering is satisfied by a constant; these fix the exact instants
 * where one word must become another, and the precedence between two
 * conditions that are true at once.
 */
describe('credentialState', () => {
  const now = Date.parse('2026-09-04T12:00:00.000Z');

  it('is live when nothing has ended', () => {
    expect(credentialState({ revokedAt: null, graceUntil: null, expiresAt: null }, now)).toBe('live');
  });

  it('expires at the instant expiry is reached, not one millisecond later', () => {
    expect(credentialState({ revokedAt: null, graceUntil: null, expiresAt: '2026-09-04T12:00:00.000Z' }, now)).toBe('expired');
    expect(credentialState({ revokedAt: null, graceUntil: null, expiresAt: '2026-09-04T12:00:00.001Z' }, now)).toBe('live');
  });

  it('revocation outranks a grace window and an expiry that are also set', () => {
    expect(credentialState({
      revokedAt: '2026-09-04T11:00:00.000Z',
      graceUntil: '2026-09-05T00:00:00.000Z',
      expiresAt: '2026-09-04T00:00:00.000Z',
    }, now)).toBe('revoked');
  });

  it('a grace window that has ELAPSED is never reported as still working (review finding P2)', () => {
    // `utils/credentialAcceptance.ts` answers CREDENTIAL_GRACE_ELAPSED at
    // `graceUntil <= now`. Reporting a non-null grace_until as `graced` told a
    // person their credential was "replaced, still working" after the door had
    // already stopped accepting it. Before / AT / after, like the expiry pin.
    const before = credentialState({ revokedAt: null, graceUntil: '2026-09-04T12:00:00.001Z', expiresAt: null }, now);
    const at = credentialState({ revokedAt: null, graceUntil: '2026-09-04T12:00:00.000Z', expiresAt: null }, now);
    const after = credentialState({ revokedAt: null, graceUntil: '2026-09-04T11:59:59.999Z', expiresAt: null }, now);
    expect(before).toBe('graced');
    expect(at).toBe('replaced');
    expect(after).toBe('replaced');
  });

  it('expiry is decided BEFORE grace, exactly as the acceptance predicate orders them', () => {
    // credentialAcceptance checks revoked -> expired -> grace. A row that is
    // both expired and inside a live grace window must read `expired`, or the
    // screen and the door disagree about why it stopped working.
    expect(credentialState({
      revokedAt: null,
      graceUntil: '2026-09-05T00:00:00.000Z',
      expiresAt: '2026-09-04T00:00:00.000Z',
    }, now)).toBe('expired');
  });

  it('a graced predecessor reads as graced even though its expiry has not passed', () => {
    expect(credentialState({
      revokedAt: null, graceUntil: '2026-09-05T00:00:00.000Z', expiresAt: '2026-09-06T00:00:00.000Z',
    }, now)).toBe('graced');
  });
});
