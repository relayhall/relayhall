/**
 * RH-P5.SSO.W4 candidate A · the OWNER-PLANE BINDING and the SCIM CALLER, in
 * one test that crosses every seam between them.
 *
 * ── WHY THIS FILE EXISTS ──
 *
 * Review `d4c0b5e2` B1. The first cut of this candidate resolved the Identity
 * provider from `req.principal.id`, and the owner-plane surface bound the
 * parentless service ACCOUNT. Those are different principals — A17.1 makes an
 * Account keyless and A17.2 puts the credential on its Connector — so the
 * named caller could never resolve an Identity provider, and the whole
 * surface was unreachable by the only client it exists for.
 *
 * Both existing suites passed. `scimProvisioningContract` seeded
 * `scim_client_principal_id` with the CONNECTOR's id directly, which is a
 * state the owner-plane service refuses to create; and `scimScopeSurface`
 * modelled the caller correctly but never touched the binding. Each was right
 * about its own half, and the defect lived exactly in the seam between them —
 * "a direct-call test proves nothing about the seam that feeds it".
 *
 * So this file refuses to model either side:
 *
 *   * the binding is written by the REAL `identityProviderService.setScimClient`
 *     — through its REAL route where the case is the route's — so a value the
 *     owner plane cannot produce cannot appear here;
 *   * the caller is authenticated by the REAL `acceptPrincipalKey` middleware,
 *     which stamps `req.principal` and resolves the delegation chain exactly as
 *     the server does — no hand-built request shape;
 *   * the id the binding STORED and the id the endpoint LOOKS UP are compared
 *     by driving a real SCIM act, never by reading either one.
 *
 * ── THE ACTOR RULE, AFTER THE OWNER RULING ──
 *
 * Owner ruling `4ae7ce53` (escalation `3226b0be`): who may act as the SCIM
 * client is decided by the REGISTRY — a `services` row with kind='connector'
 * naming the acting principal (A17.2, migration 097) — and the
 * `kind === 'service'` and direct-child conditions are WITHDRAWN. The
 * registry is therefore armed here as a SET OF PRINCIPAL IDS named by
 * connector-kind rows, and the pool answers the registry predicate by
 * READING THE SQL the production code issued — a predicate that stops naming
 * the principal it asks about gets a different answer, not a helpful one.
 *
 * Only the pool is armed. Every principal, credential and chain row it answers
 * with is the shape migration 062/096 permits; the depth-3 all-service chain
 * the round-2 fixture manufactured is gone with the condition it served.
 */
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import { pool } from '../db/connection';
import scimRouter, { scimActingChainFor } from '../routes/scim';
import identityProvidersRouter from '../routes/identityProviders';
import { acceptPrincipalKey, type AuthRequest } from '../middleware/auth';
import { identityProviderService, IdentityProviderError } from '../services/identity/IdentityProviderService';
import { SubscriberActorService } from '../services/SubscriberActorService';
import { connectorRegistryPredicateSql } from '../utils/connectorRegistry';

const PROVIDER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONNECTOR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_ACCOUNT_ID = '99999999-9999-4999-8999-999999999999';
const OTHER_CONNECTOR_ID = '88888888-8888-4888-8888-888888888888';
const NEW_ACCOUNT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const KEY_ID = 'w4akey01';
const SECRET = 'w4a_secret_value_0123456789';
const TOKEN = `rh_dev_${KEY_ID}.${SECRET}`;
const OTHER_KEY_ID = 'w4akey02';
const OTHER_TOKEN = `rh_dev_${OTHER_KEY_ID}.${SECRET}`;

let server: http.Server;
let baseUrl: string;
/** The binding as the OWNER PLANE wrote it — never seeded by hand. */
let boundScimClientPrincipalId: string | null;
/** The REGISTRY: principal ids named by a connector-kind `services` row. */
let registry: Set<string>;
let statements: Array<{ sql: string; params: unknown[] }>;

function principalRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: ACCOUNT_ID, kind: 'service', handle: 'estate-directory', display_name: 'Estate directory',
    status: 'active', role: 'agent', source_tag: null, harness: null, personality_id: null,
    parent_principal_id: null, bound_task_id: null, purpose: null, legacy_identity: false,
    own_expression: null, last_seen_at: null, metadata: {}, ...over,
  };
}

const ACCOUNT_ROW = principalRow({});
const CONNECTOR_ROW = principalRow({
  id: CONNECTOR_ID, handle: 'estate-directory-connector', parent_principal_id: ACCOUNT_ID,
  role: null, own_expression: { scopes: 'parent', objects: 'parent' },
});
const OTHER_ACCOUNT_ROW = principalRow({ id: OTHER_ACCOUNT_ID, handle: 'other-service' });
const OTHER_CONNECTOR_ROW = principalRow({
  id: OTHER_CONNECTOR_ID, handle: 'other-connector', parent_principal_id: OTHER_ACCOUNT_ID,
  role: null, own_expression: { scopes: 'parent', objects: 'parent' },
});
const HUMAN_ROW = principalRow({ id: '77777777-7777-4777-8777-777777777777', kind: 'human', handle: 'ada', role: 'user' });
// Review 84456731 B1: the THIRD delegation layer. An Agent beneath the bound
// Account's Connector is a live, ordinary chain the evaluator supports — and
// it provisioned successfully before the round-2 repair. `principals_agent_shape`
// (migration 096) requires a parented agent to carry a bound task, so this
// row is the shape the database actually permits.
const AGENT_ID = '66666666-6666-4666-8666-666666666666';
const AGENT_ROW = principalRow({
  id: AGENT_ID, kind: 'agent', handle: 'directory-agent', parent_principal_id: CONNECTOR_ID,
  role: 'agent', bound_task_id: '55555555-5555-4555-8555-555555555555',
  own_expression: { scopes: 'parent', objects: 'parent' },
});
// An Agent that is a DIRECT child of the Account — the chain shape a human
// Account's Agent has, and one the registry refuses without help from a kind
// column.
const DIRECT_AGENT_ID = '44444444-4444-4444-8444-444444444444';
const DIRECT_AGENT_ROW = principalRow({
  id: DIRECT_AGENT_ID, kind: 'agent', handle: 'direct-agent', parent_principal_id: ACCOUNT_ID,
  role: 'agent', bound_task_id: '33333333-3333-4333-8333-333333333333',
  own_expression: { scopes: 'parent', objects: 'parent' },
});
// Review a96c3788 (the round-3 REGRESS, ruled in 4ae7ce53): a parented
// `service` PRINCIPAL under the bound Account with NO registry row. Migration
// 096 admits the row — its trigger classifies every parented service principal
// structurally — and the four-condition rule provisioned it. It is not a
// Connector, because nothing in the registry says so.
const UNREGISTERED_ID = '22222222-2222-4222-8222-222222222222';
const UNREGISTERED_ROW = principalRow({
  id: UNREGISTERED_ID, handle: 'unregistered-service', parent_principal_id: ACCOUNT_ID,
  role: null, own_expression: { scopes: 'parent', objects: 'parent' },
});
// The same shape, but a connector-kind registry row EXISTS — naming somebody
// else. A predicate that checks "some connector row exists" instead of "a
// connector row names THIS principal" admits it.
const MISPAIRED_ID = '11111111-1111-4111-8111-111111111111';
const MISPAIRED_ROW = principalRow({
  id: MISPAIRED_ID, handle: 'mispaired-service', parent_principal_id: ACCOUNT_ID,
  role: null, own_expression: { scopes: 'parent', objects: 'parent' },
});
const STRANGER_ID = '00000000-0000-4000-8000-000000000000';
// A parentless service Account of the right SHAPE with no registry Connector
// beneath it — what the binding surface must now refuse by name.
const UNPAIRED_ACCOUNT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const UNPAIRED_ACCOUNT_ROW = principalRow({ id: UNPAIRED_ACCOUNT_ID, handle: 'unpaired-service' });
const MISSING_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const AGENT_KEY_ID = 'w4akey03';
const AGENT_TOKEN = `rh_dev_${AGENT_KEY_ID}.${SECRET}`;
const DIRECT_AGENT_KEY_ID = 'w4akey04';
const DIRECT_AGENT_TOKEN = `rh_dev_${DIRECT_AGENT_KEY_ID}.${SECRET}`;
const UNREGISTERED_KEY_ID = 'w4akey05';
const UNREGISTERED_TOKEN = `rh_dev_${UNREGISTERED_KEY_ID}.${SECRET}`;
const MISPAIRED_KEY_ID = 'w4akey06';
const MISPAIRED_TOKEN = `rh_dev_${MISPAIRED_KEY_ID}.${SECRET}`;

const PRINCIPALS: Record<string, Record<string, unknown>> = {
  [ACCOUNT_ID]: ACCOUNT_ROW,
  [CONNECTOR_ID]: CONNECTOR_ROW,
  [OTHER_ACCOUNT_ID]: OTHER_ACCOUNT_ROW,
  [OTHER_CONNECTOR_ID]: OTHER_CONNECTOR_ROW,
  [HUMAN_ROW.id as string]: HUMAN_ROW,
  [AGENT_ID]: AGENT_ROW,
  [DIRECT_AGENT_ID]: DIRECT_AGENT_ROW,
  [UNREGISTERED_ID]: UNREGISTERED_ROW,
  [MISPAIRED_ID]: MISPAIRED_ROW,
  [UNPAIRED_ACCOUNT_ID]: UNPAIRED_ACCOUNT_ROW,
};

// A17.1 makes an Account KEYLESS, so this credential is a shape the estate
// cannot mint. The pool hands it in anyway: if an Account ever did present a
// credential of its own, it would arrive with a ONE-link chain, acting and
// root the same principal — and it must still not be a Connector by the
// registry. This is the shape a permissive "no chain / own principal" arm
// would wave through.
const ACCOUNT_KEY_ID = 'w4akey07';
const ACCOUNT_TOKEN = `rh_dev_${ACCOUNT_KEY_ID}.${SECRET}`;

const CREDENTIALS: Record<string, string> = {
  [KEY_ID]: CONNECTOR_ID,
  [ACCOUNT_KEY_ID]: ACCOUNT_ID,
  [OTHER_KEY_ID]: OTHER_CONNECTOR_ID,
  [AGENT_KEY_ID]: AGENT_ID,
  [DIRECT_AGENT_KEY_ID]: DIRECT_AGENT_ID,
  [UNREGISTERED_KEY_ID]: UNREGISTERED_ID,
  [MISPAIRED_KEY_ID]: MISPAIRED_ID,
};

function providerRow(): Record<string, unknown> {
  return {
    id: PROVIDER_ID, name: 'Estate directory', status: 'active',
    issuer: 'https://issuer.example/', discovery_url: 'https://issuer.example/.well-known/openid-configuration',
    client_id: 'rh', client_auth_method: 'client_secret_basic',
    has_client_secret: true, has_client_private_key: false,
    scopes_requested: 'openid profile email', extra_authorize_params: {}, additional_endpoint_origins: [],
    handle_claim: 'preferred_username', display_name_claim: 'name', email_claim: 'email',
    groups_claim: null, required_claims: {}, subject_immutable: true,
    provisioning_mode: 'jit', group_binding_mode: 'off',
    scim_client_principal_id: boundScimClientPrincipalId,
    login_group_whitelist_enabled: false, allow_private_issuer_address: false,
    allow_claim_matching: false, retain_id_token: false, provider_owns_profile: false,
    clock_skew_seconds: 60, session_ttl_seconds: null,
    authentication_request_ttl_seconds: 600, backchannel_logout_enabled: false,
    last_discovery_at: null, last_discovery_error_present: false, jwks_refreshed_at: null,
    created_at: new Date('2026-09-01T00:00:00Z'), updated_at: new Date('2026-09-01T00:00:00Z'),
  };
}

/**
 * The registry predicate, answered from the SQL the production code ISSUED.
 * `namesPrincipal` is the text a conforming predicate carries — "a connector
 * row names THIS principal". A predicate that dropped that clause is answered
 * as PostgreSQL would answer it: is there ANY connector row at all.
 */
function registryAnswer(sql: string, principalRef: string, principalId: string): boolean {
  const namesPrincipal = sql.includes(`sv.principal_id = ${principalRef}`);
  return namesPrincipal ? registry.has(principalId) : registry.size > 0;
}

function armPool(): void {
  const query = async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    statements.push({ sql, params });
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };

    // ── the auth seam: credential lookup ──
    if (sql.includes('FROM principal_credentials c JOIN principals p')) {
      const principalId = CREDENTIALS[String(params[0])];
      if (!principalId) return { rows: [] };
      return {
        rows: [{
          credential_id: `cred-${params[0]}`, principal_id: principalId, credential_type: 'api_key',
          key_id: params[0], secret_hash: crypto.createHash('sha256')
            .update(`rh_dev_${params[0]}.${SECRET}`).digest('hex'),
          scopes: ['directory-provisioning:write'], expires_at: null, revoked_at: null,
          transport: 'any', grace_until: null, credential_metadata: {},
          ...PRINCIPALS[principalId],
        }],
      };
    }
    // ── the auth seam: the delegation chain, depth-ordered ──
    if (sql.startsWith('WITH RECURSIVE chain AS')) {
      const start = PRINCIPALS[String(params[0])];
      const chain: Array<Record<string, unknown>> = [];
      let cursor: Record<string, unknown> | undefined = start;
      while (cursor) {
        chain.push({ ...cursor, live_credential_count: cursor.parent_principal_id ? 1 : 0 });
        cursor = cursor.parent_principal_id
          ? PRINCIPALS[String(cursor.parent_principal_id)]
          : undefined;
      }
      return { rows: chain };
    }
    // The bound-task liveness probe the middleware runs for an AGENT acting
    // link (auth.ts §7.3/T6). It answers ALIVE deliberately: a dead task would
    // 401 the request, and a refusal that came from task death would prove
    // nothing about who may provision.
    if (sql.includes('FROM tasks t WHERE t.id = ')) {
      return { rows: [{ status: 'in-progress', lease_expired: false }] };
    }
    if (sql.startsWith('UPDATE principal_credentials')) return { rows: [] };

    // ── the REGISTRY (ruling 4ae7ce53) ──
    // The binding surface's question: which registry Connectors sit BENEATH
    // this Account?
    if (sql.startsWith('SELECT c.id FROM principals c WHERE c.parent_principal_id = $1')) {
      const rows = Object.values(PRINCIPALS)
        .filter((row) => row.parent_principal_id === String(params[0]))
        .filter((row) => registryAnswer(sql, 'c.id', String(row.id)))
        .map((row) => ({ id: row.id }));
      return { rows };
    }
    // The act-time question: is the acting principal a Connector by the registry?
    if (sql.includes("sv.kind = 'connector'") && sql.includes('AS is_connector')) {
      return { rows: [{ is_connector: registryAnswer(sql, '$1', String(params[0])) }] };
    }

    // ── the owner plane ──
    if (sql.includes('FROM identity_providers')) {
      if (sql.includes('scim_client_principal_id = $1')) {
        return {
          rows: boundScimClientPrincipalId === String(params[0]) ? [providerRow()] : [],
        };
      }
      return { rows: [providerRow()] };
    }
    if (sql.startsWith('SELECT kind, status, legacy_identity, parent_principal_id FROM principals')) {
      const row = PRINCIPALS[String(params[0])];
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith('UPDATE identity_providers SET scim_client_principal_id')) {
      boundScimClientPrincipalId = params[1] === null ? null : String(params[1]);
      return { rows: [providerRow()] };
    }

    // ── the SCIM act ──
    if (sql.startsWith('INSERT INTO principals')) {
      return {
        rows: [{
          id: NEW_ACCOUNT_ID, kind: params[0], handle: params[1], display_name: params[2],
          role: params[3], purpose: params[4], status: 'active', legacy_identity: false,
          parent_principal_id: null, metadata: {}, source_tag: null, harness: null,
          personality_id: null, bound_task_id: null, own_expression: null, last_seen_at: null,
        }],
      };
    }
    if (sql.startsWith('UPDATE principals')) return { rows: [] };
    if (sql.startsWith('INSERT INTO directory_provisioned_accounts')) return { rows: [] };
    if (sql.startsWith('INSERT INTO audit_events')) {
      return {
        rows: [{
          id: 'audit', action: params[0], outcome: params[1], actor_handle: params[3],
          auth_method: params[4], resource_type: params[6],
          occurred_at: new Date('2026-09-01T10:00:00Z'), metadata: {},
        }],
      };
    }
    if (sql.includes('FROM directory_provisioned_accounts d JOIN principals p')) {
      return {
        rows: [{
          id: NEW_ACCOUNT_ID, external_id: null, user_name: 'ada',
          created_at: new Date('2026-09-01T10:00:00Z'), updated_at: new Date('2026-09-01T10:00:00Z'),
          display_name: 'ada', status: 'active', metadata: {},
        }],
      };
    }
    if (sql.includes('COUNT(*)::int AS total FROM directory_provisioned_accounts')) {
      return { rows: [{ total: 0 }] };
    }
    throw new Error(`unexpected sql: ${sql.slice(0, 120)}`);
  };
  (pool.query as jest.Mock).mockImplementation(query);
  (pool.connect as jest.Mock).mockResolvedValue({ query, release: jest.fn() });
}

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const provisioned = () => statements.some((s) => s.sql.startsWith('INSERT INTO principals'));
const registryAskedOf = () => statements
  .filter((s) => s.sql.includes('AS is_connector'))
  .map((s) => String(s.params[0]));

const OWNER = { principalId: 'owner', handle: 'wadera', authMethod: 'session' as const };

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // THE REAL credential acceptance the REST ingress runs — it stamps
  // req.principal, req.scopes and req.delegationLinks itself. Nothing about the
  // caller's shape is invented by this file.
  app.use('/scim', async (req, res, next) => {
    const outcome = await acceptPrincipalKey(
      req as AuthRequest,
      req.headers.authorization,
      `/scim${req.path}`,
      'api',
    );
    if (outcome.kind === 'denied') {
      res.status(outcome.status).json(outcome.body);
      return;
    }
    if (outcome.kind === 'not-principal-key') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  }, scimRouter);
  // The owner plane, through its REAL router. The caller is the owner's login
  // session, stamped here as the funnel would stamp it: `root` at this family
  // is the shared authorization middleware's ceiling and is proved where that
  // middleware is proved, not re-proved by this file.
  app.use('/identity-providers', (req, _res, next) => {
    const owner = req as AuthRequest;
    owner.principal = { id: 'owner', handle: 'wadera' } as AuthRequest['principal'];
    owner.userId = 'wadera';
    owner.authMethod = 'session';
    next();
  }, identityProvidersRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  boundScimClientPrincipalId = null;
  registry = new Set([CONNECTOR_ID, OTHER_CONNECTOR_ID, STRANGER_ID]);
  statements = [];
  process.env.NODE_ENV = 'test';
  armPool();
});

describe('the owner plane binds the Account and the Connector can then provision', () => {
  it('B1 REGRESSION: a Connector under the bound Account provisions successfully', async () => {
    // 1 · the owner names the parentless service ACCOUNT, through the real service.
    const updated = await identityProviderService.setScimClient(PROVIDER_ID, ACCOUNT_ID, OWNER);
    expect(updated.scimClientPrincipalId).toBe(ACCOUNT_ID);

    // 2 · its CONNECTOR presents the credential, through the real middleware.
    const response = await call(TOKEN, 'POST', '/scim/v2/Users', { userName: 'ada' });

    // 3 · the act succeeds. Before the B1 repair this was 403: the endpoint
    //     compared the Connector id against the stored Account id.
    expect(response.status).toBe(201);
    expect(response.body.id).toBe(NEW_ACCOUNT_ID);

    // And the two ids really were different, so the test is not passing because
    // the fixture collapsed them into one principal.
    expect(CONNECTOR_ID).not.toBe(ACCOUNT_ID);
    expect(boundScimClientPrincipalId).toBe(ACCOUNT_ID);
  });

  it('a Connector under a DIFFERENT Account is refused', async () => {
    await identityProviderService.setScimClient(PROVIDER_ID, ACCOUNT_ID, OWNER);
    const response = await call(OTHER_TOKEN, 'POST', '/scim/v2/Users', { userName: 'mallory' });
    expect(response.status).toBe(403);
    expect(provisioned()).toBe(false);
  });

  it('no binding at all means no provisioning, for the same Connector', async () => {
    const response = await call(TOKEN, 'POST', '/scim/v2/Users', { userName: 'ada' });
    expect(response.status).toBe(403);
  });

  it('clearing the binding stops the Connector that worked a moment ago', async () => {
    await identityProviderService.setScimClient(PROVIDER_ID, ACCOUNT_ID, OWNER);
    expect((await call(TOKEN, 'POST', '/scim/v2/Users', { userName: 'ada' })).status).toBe(201);
    await identityProviderService.setScimClient(PROVIDER_ID, null, OWNER);
    expect((await call(TOKEN, 'POST', '/scim/v2/Users', { userName: 'grace' })).status).toBe(403);
  });
});

describe('only a Connector BY THE REGISTRY may act (ruling 4ae7ce53 §1.2)', () => {
  beforeEach(async () => {
    await identityProviderService.setScimClient(PROVIDER_ID, ACCOUNT_ID, OWNER);
    statements = [];
  });

  it('refuses a parented service principal that NO registry row names — the round-3 probe', async () => {
    // a96c3788: this shape satisfied all four principal-column conditions and
    // provisioned. Nothing about its columns has changed; the registry says
    // it is not a Connector, and that is now the question being asked.
    const response = await call(UNREGISTERED_TOKEN, 'POST', '/scim/v2/Users', { userName: 'mallory' });
    expect(response.status).toBe(403);
    expect(provisioned()).toBe(false);
  });

  it('refuses a parented service principal when a registry row exists but names SOMEBODY ELSE', async () => {
    // The registry holds a connector row (for STRANGER); none names MISPAIRED.
    // A predicate reduced to "some connector row exists" admits this caller —
    // and the pool answers exactly that if the issued SQL stops naming the
    // principal it asks about.
    const response = await call(MISPAIRED_TOKEN, 'POST', '/scim/v2/Users', { userName: 'mallory' });
    expect(response.status).toBe(403);
    expect(provisioned()).toBe(false);
  });

  it('asks the registry about the ACTING principal, by id — not the Account, not the credential', async () => {
    await call(TOKEN, 'POST', '/scim/v2/Users', { userName: 'ada' });
    // The question the production code put to the registry, with the id it
    // put in. A rule that asked about the chain root would pass the positive
    // case for the wrong reason if the Account were ever registered too.
    expect(registryAskedOf()).toEqual([CONNECTOR_ID]);
    expect(statements.some((s) => s.sql.includes(`${connectorRegistryPredicateSql('$1')} AS is_connector`))).toBe(true);
  });

  it('refuses the bound Account ITSELF presenting a credential — one link, acting is root, not a Connector', async () => {
    const response = await call(ACCOUNT_TOKEN, 'POST', '/scim/v2/Users', { userName: 'mallory' });
    expect(response.status).toBe(403);
    expect(provisioned()).toBe(false);
    // The registry was asked about the Account and said no; the binding
    // naming it did not stand in for that answer.
    expect(registryAskedOf()).toEqual([ACCOUNT_ID]);
  });

  it('refuses an Agent BENEATH the bound Account’s Connector (the three-link chain)', async () => {
    // Review 84456731's reproduction, in the permanent suite: this returned 201
    // and inserted an Account before the round-2 repair. The registry refuses
    // it without a kind column: no connector row names an Agent.
    const response = await call(AGENT_TOKEN, 'POST', '/scim/v2/Users', { userName: 'mallory' });
    expect(response.status).toBe(403);
    expect(provisioned()).toBe(false);
  });

  it('refuses an Agent that is a DIRECT child of the bound Account', async () => {
    const response = await call(DIRECT_AGENT_TOKEN, 'POST', '/scim/v2/Users', { userName: 'mallory' });
    expect(response.status).toBe(403);
    expect(provisioned()).toBe(false);
  });

  it('NON-VACUITY: the registry Connector itself still provisions', async () => {
    // Without this, every refusal above would pass for a rule that refused
    // everyone — which is exactly the round-1 defect.
    const response = await call(TOKEN, 'POST', '/scim/v2/Users', { userName: 'ada' });
    expect(response.status).toBe(201);
  });

  it('the refused chains are LIVE and hold the scope, so the refusals are the ACTOR rule', async () => {
    // If a chain were dead the middleware would 401, and the refusals above
    // would be about liveness rather than about who may provision. Proved at
    // the middleware itself rather than through a route, so no route's own
    // behaviour can stand in for it.
    for (const [token, acting, chain] of [
      [AGENT_TOKEN, AGENT_ID, [AGENT_ID, CONNECTOR_ID, ACCOUNT_ID]],
      [UNREGISTERED_TOKEN, UNREGISTERED_ID, [UNREGISTERED_ID, ACCOUNT_ID]],
      [MISPAIRED_TOKEN, MISPAIRED_ID, [MISPAIRED_ID, ACCOUNT_ID]],
    ] as Array<[string, string, string[]]>) {
      const req = { headers: {} } as unknown as AuthRequest;
      const outcome = await acceptPrincipalKey(req, `Bearer ${token}`, '/scim/v2/Users', 'api');
      expect(outcome.kind).toBe('ok');
      expect(req.principal?.id).toBe(acting);
      expect(req.delegationLinks?.map((l) => l.principalId)).toEqual(chain);
      // §5.2 rule 3 strips only `*:admin` at the Agent layer, which is why
      // this bound had to be stated in the actor rule rather than inherited
      // from the model.
      expect(req.scopes).toContain('directory-provisioning:write');
    }
  });

  it('the discovery documents obey the same binding rule as the rest of the family', async () => {
    // Found by this suite, not by a reviewer: they resolved no binding at all.
    for (const path of ['/scim/v2/ServiceProviderConfig', '/scim/v2/ResourceTypes', '/scim/v2/Schemas']) {
      expect((await call(UNREGISTERED_TOKEN, 'GET', path)).status).toBe(403);
      expect((await call(TOKEN, 'GET', path)).status).toBe(200);
    }
  });
});

describe('the binding REQUIRES the registry pairing, through the owner-plane ROUTE (ruling 4ae7ce53 §1.4)', () => {
  // Card 6620b3cc's definition of done: a parentless service Account plus its
  // child Connector, bound through PUT, authenticating through production
  // middleware; the intended Connector provisions; binding the Connector
  // itself or any non-eligible principal is refused.
  it('PRODUCTION PATH: PUT binds the paired Account and its Connector then provisions', async () => {
    const bound = await call(null, 'PUT', `/identity-providers/${PROVIDER_ID}/scim-client`, { principalId: ACCOUNT_ID });
    expect(bound.status).toBe(200);
    expect(bound.body.identityProvider.scimClientPrincipalId).toBe(ACCOUNT_ID);
    // The route asked the registry which Connectors sit beneath the Account.
    expect(statements.some((s) => s.sql.startsWith('SELECT c.id FROM principals c WHERE c.parent_principal_id = $1')
      && s.params[0] === ACCOUNT_ID)).toBe(true);

    const response = await call(TOKEN, 'POST', '/scim/v2/Users', { userName: 'ada' });
    expect(response.status).toBe(201);
  });

  it('refuses, BY NAME, a parentless service Account paired with no registry Connector', async () => {
    // Right kind, right status, parentless, non-legacy — every column the
    // round-3 rule looked at. The registry has nothing beneath it.
    const refused = await call(null, 'PUT', `/identity-providers/${PROVIDER_ID}/scim-client`, { principalId: UNPAIRED_ACCOUNT_ID });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('PROVIDER_SCIM_CLIENT_UNPAIRED');
    expect(boundScimClientPrincipalId).toBeNull();
  });

  it('the pairing is asked through the SAME predicate the act uses', async () => {
    await call(null, 'PUT', `/identity-providers/${PROVIDER_ID}/scim-client`, { principalId: ACCOUNT_ID });
    const pairing = statements.find((s) => s.sql.startsWith('SELECT c.id FROM principals c'));
    expect(pairing?.sql).toContain(connectorRegistryPredicateSql('c.id'));
  });

  it('refuses the Connector ITSELF — the credential holder is not the Account', async () => {
    const refused = await call(null, 'PUT', `/identity-providers/${PROVIDER_ID}/scim-client`, { principalId: CONNECTOR_ID });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('PROVIDER_SCIM_CLIENT_INVALID');
    expect(boundScimClientPrincipalId).toBeNull();
  });

  it('refuses a HUMAN Account — which is what keeps the broad route ceiling harmless', async () => {
    const refused = await call(null, 'PUT', `/identity-providers/${PROVIDER_ID}/scim-client`, { principalId: HUMAN_ROW.id });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('PROVIDER_SCIM_CLIENT_INVALID');
    expect(boundScimClientPrincipalId).toBeNull();
  });

  it('refuses a principal that does not exist, as 404', async () => {
    const refused = await call(null, 'PUT', `/identity-providers/${PROVIDER_ID}/scim-client`, { principalId: MISSING_ID });
    expect(refused.status).toBe(404);
    expect(refused.body.code).toBe('PROVIDER_SCIM_CLIENT_NOT_FOUND');
    expect(boundScimClientPrincipalId).toBeNull();
  });

  it('DELETE clears the binding and the Connector that worked a moment ago is refused', async () => {
    await call(null, 'PUT', `/identity-providers/${PROVIDER_ID}/scim-client`, { principalId: ACCOUNT_ID });
    expect((await call(TOKEN, 'POST', '/scim/v2/Users', { userName: 'ada' })).status).toBe(201);
    const cleared = await call(null, 'DELETE', `/identity-providers/${PROVIDER_ID}/scim-client`);
    expect(cleared.status).toBe(200);
    expect(boundScimClientPrincipalId).toBeNull();
    expect((await call(TOKEN, 'POST', '/scim/v2/Users', { userName: 'grace' })).status).toBe(403);
  });

  it('the SERVICE refuses the same shapes when called directly', async () => {
    // Review d4c0b5e2's ninth mutation removed the parented-Connector refusal
    // and both older suites stayed green, because neither drove the method.
    for (const [principalId, code] of [
      [CONNECTOR_ID, 'PROVIDER_SCIM_CLIENT_INVALID'],
      [HUMAN_ROW.id as string, 'PROVIDER_SCIM_CLIENT_INVALID'],
      [UNPAIRED_ACCOUNT_ID, 'PROVIDER_SCIM_CLIENT_UNPAIRED'],
      [MISSING_ID, 'PROVIDER_SCIM_CLIENT_NOT_FOUND'],
    ] as Array<[string, string]>) {
      await expect(identityProviderService.setScimClient(PROVIDER_ID, principalId, OWNER))
        .rejects.toMatchObject({ code });
      expect(boundScimClientPrincipalId).toBeNull();
    }
    await expect(identityProviderService.setScimClient(PROVIDER_ID, CONNECTOR_ID, OWNER))
      .rejects.toBeInstanceOf(IdentityProviderError);
  });
});

describe('the two conditions decided by the chain SHAPE (ruling 4ae7ce53 §1.2, conditions 1 and 3)', () => {
  // `scimActingChainFor` is a pure function of what the middleware stamped,
  // and the real middleware always stamps a consistent chain — so these two
  // conditions cannot be reddened through a route. They are drilled here
  // directly, on the shapes only a broken or bypassed middleware could hand
  // in, so that neither is a guard whose removal costs nothing.
  const link = (principalId: string, parentPrincipalId: string | null, kind = 'service') => ({
    principalId, kind, role: null, parentPrincipalId, boundTaskId: null, legacyIdentity: false, ownExpression: null,
  });
  const request = (principalId: string, links: ReturnType<typeof link>[] | undefined) =>
    ({ principal: { id: principalId, parentPrincipalId: null }, delegationLinks: links } as unknown as AuthRequest);

  it('condition 1: the acting link must BE the authenticated principal', () => {
    // A chain resolved for somebody other than the credential's principal.
    expect(scimActingChainFor(request(OTHER_CONNECTOR_ID, [link(CONNECTOR_ID, ACCOUNT_ID), link(ACCOUNT_ID, null)])))
      .toBeNull();
    expect(scimActingChainFor(request(CONNECTOR_ID, [link(CONNECTOR_ID, ACCOUNT_ID), link(ACCOUNT_ID, null)])))
      .toEqual({ actingPrincipalId: CONNECTOR_ID, accountPrincipalId: ACCOUNT_ID });
  });

  it('condition 3: the chain root must be PARENTLESS — a legacy top can still arrive here', () => {
    // `resolveChain` refuses a non-terminating chain only for NON-legacy tops.
    expect(scimActingChainFor(request(CONNECTOR_ID, [link(CONNECTOR_ID, ACCOUNT_ID), link(ACCOUNT_ID, STRANGER_ID)])))
      .toBeNull();
  });

  it('a caller with NO chain is its own acting principal and its own root', () => {
    // No special arm: it is handed to the same registry and binding questions.
    expect(scimActingChainFor(request(ACCOUNT_ID, undefined)))
      .toEqual({ actingPrincipalId: ACCOUNT_ID, accountPrincipalId: ACCOUNT_ID });
    expect(scimActingChainFor({ principal: undefined } as unknown as AuthRequest)).toBeNull();
  });
});

describe('ONE registry predicate, three users', () => {
  it('SubscriberActorService issues the very fragment the SCIM rule and the binding issue', async () => {
    // The ruling's reuse instruction as a control: if the subscriber path ever
    // grew its own copy of "is a Connector", this reddens even though every
    // behavioural test above would still pass.
    const issued: string[] = [];
    const fakePool = {
      query: jest.fn(async (sql: string) => {
        issued.push(sql.replace(/\s+/g, ' ').trim());
        return { rows: [], rowCount: 0 };
      }),
    } as any;
    await new SubscriberActorService(fakePool).actorFor(CONNECTOR_ID, 'credential-1');
    const subscriberSelect = issued.find((sql) => sql.includes('FROM principals p'));
    expect(subscriberSelect).toContain(connectorRegistryPredicateSql('p.id'));
  });

  it('the predicate literal lives in ONE source file', () => {
    // The behavioural control above cannot see a byte-identical private copy
    // — the drill proved it (M19 stayed green). A copy that is identical today
    // is the copy that drifts tomorrow, so this is the review-time backstop
    // made permanent: the registry clause is spelled in exactly one file, and
    // every other user imports it.
    const root = path.resolve(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full);
        } else if (entry.name.endsWith('.ts') && fs.readFileSync(full, 'utf8').includes("sv.kind = 'connector'")) {
          files.push(path.relative(root, full).split(path.sep).join('/'));
        }
      }
    };
    walk(root);
    expect(files).toEqual(['utils/connectorRegistry.ts']);
  });
});
