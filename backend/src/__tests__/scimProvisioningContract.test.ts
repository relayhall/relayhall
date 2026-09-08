/**
 * RH-P5.SSO.W4 candidate A · what happens INSIDE the SCIM surface.
 *
 * The companion to `scimScopeSurface.test.ts`: that file proves who may reach
 * the door, this one proves what the handlers do once through it. Both are
 * needed because A24's guarantees are half route-ceiling and half handler —
 * "creating parentless HUMAN Accounts at the fixed minimal role" is not a
 * property any scope string can carry.
 *
 * ── HOW THIS DRIVES THE PRODUCTION CODE ──
 *
 * The REAL router, mounted on a real HTTP server, over the REAL service — only
 * the pool is armed, the way `charterRestParity` drives the charter surface.
 * Nothing here mocks the thing under test, and the assertions about what was
 * WRITTEN read the SQL parameters the production code actually issued, rather
 * than a summary of them. That attribution matters: a test that asserted "role
 * was not `admin`" by reading the response would pass for a handler that wrote
 * `admin` and rendered something else.
 *
 * ── THE ORDER OF REFUSALS IS ITSELF A CLAIM ──
 *
 * An unbound caller is refused BEFORE its body is parsed. That is asserted with
 * a body that would otherwise produce a different, more specific refusal: if
 * the Identity provider resolution ever moved after validation, it goes red
 * with a 400 where it expects a 403.
 */
import express from 'express';
import http from 'http';

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import { pool } from '../db/connection';
import scimRouter, { SCIM_ROUTE_CENSUS } from '../routes/scim';
import { SCIM_USER_ATTRIBUTE_POLICY } from '../services/identity/ScimProvisioningService';
import { FIXED_MINIMAL_ACCOUNT_ROLE } from '../services/identity/accountProvisioning';
import { JSON_BODY_TYPES, jsonBodyOptions } from '../utils/jsonBodyTypes';
import fs from 'fs';
import path from 'path';

// The bound principal is the parentless service ACCOUNT, because that is
// what `setScimClient` accepts (A17.2/A24) — the Connector under it is what
// authenticates. The first cut of this file bound the CONNECTOR id, a state
// the owner plane refuses to create, and that fiction is what let review
// d4c0b5e2 B1 through this suite. `scimOwnerBindingCrossLayer.test.ts` now
// drives the real binding method and the real auth middleware end to end;
// this file keeps its focus on handler behaviour, with an honest caller.
const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROVIDER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_PROVIDER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CONNECTOR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NEW_ACCOUNT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const FOREIGN_ACCOUNT_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

let server: http.Server;
let baseUrl: string;

/** Test state the armed pool answers from. */
let boundProvider: boolean;
let handleTaken: boolean;
let provisioned: Array<Record<string, unknown>>;
/** Every statement the production code issued, with its parameters. */
let statements: Array<{ sql: string; params: unknown[] }>;

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
    scim_client_principal_id: ACCOUNT_ID,
    login_group_whitelist_enabled: false, allow_private_issuer_address: false,
    allow_claim_matching: false, retain_id_token: false, provider_owns_profile: false,
    clock_skew_seconds: 60, session_ttl_seconds: null,
    authentication_request_ttl_seconds: 600, backchannel_logout_enabled: false,
    last_discovery_at: null, last_discovery_error_present: false, jwks_refreshed_at: null,
    created_at: new Date('2026-09-01T00:00:00Z'), updated_at: new Date('2026-09-01T00:00:00Z'),
  };
}

function armPool(): void {
  const query = async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    statements.push({ sql, params });
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };

    // Ruling 4ae7ce53: the actor rule asks the REGISTRY whether the acting
    // principal is a Connector. This suite's caller is one; the registry
    // side of the rule is attacked in scimOwnerBindingCrossLayer.
    if (sql.includes("sv.kind = 'connector'")) {
      return { rows: [{ is_connector: true }] };
    }
    if (sql.includes('FROM identity_providers')) {
      return { rows: boundProvider ? [providerRow()] : [] };
    }
    if (sql.startsWith('INSERT INTO principals')) {
      if (handleTaken) return { rows: [] }; // ON CONFLICT (handle) DO NOTHING
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
    if (sql.startsWith('INSERT INTO directory_provisioned_accounts')) {
      provisioned.push({
        id: params[0], identity_provider_id: params[1], external_id: params[2],
        user_name: params[3], display_name: null, status: 'active', metadata: {},
        created_at: new Date('2026-09-01T10:00:00Z'), updated_at: new Date('2026-09-01T10:00:00Z'),
      });
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO audit_events')) {
      return {
        rows: [{
          id: 'audit', action: params[0], outcome: params[1],
          actor_handle: params[3], auth_method: params[4], resource_type: params[6],
          occurred_at: new Date('2026-09-01T10:00:00Z'), metadata: {},
        }],
      };
    }
    if (sql.includes('COUNT(*)::int AS total FROM directory_provisioned_accounts')) {
      return { rows: [{ total: rowsFor(sql, params).length }] };
    }
    if (sql.includes('FROM directory_provisioned_accounts d JOIN principals p')) {
      return { rows: rowsFor(sql, params) };
    }
    throw new Error(`unexpected sql: ${sql.slice(0, 120)}`);
  };
  (pool.query as jest.Mock).mockImplementation(query);
  (pool.connect as jest.Mock).mockResolvedValue({ query, release: jest.fn() });
}

/**
 * The armed store, filtered by reading the production predicate out of the SQL
 * the production code issued — not by re-deciding the question here. If the
 * handler ever stopped naming its Identity provider in the WHERE clause, this arm would
 * stop filtering by it and the read-boundary assertions would go red.
 */
function rowsFor(sql: string, params: unknown[]): Array<Record<string, unknown>> {
  const byId = sql.includes('d.account_principal_id = $1 AND d.identity_provider_id = $2');
  const providerId = byId ? params[1] : params[0];
  const scoped = provisioned.filter((row) => row.identity_provider_id === providerId);
  if (byId) return scoped.filter((row) => row.id === params[0]);
  if (sql.includes('d.user_name = $2')) return scoped.filter((row) => row.user_name === params[1]);
  if (sql.includes('d.external_id = $2')) return scoped.filter((row) => row.external_id === params[1]);
  return scoped;
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: text ? JSON.parse(text) : null,
  };
}

beforeAll(async () => {
  const app = express();
  // The parser EXACTLY as server.ts mounts it (card 127556e1, candidate C):
  // the same options object, so the content-type case below proves the
  // production configuration and not a parser this file chose.
  app.use(express.json(jsonBodyOptions));
  // The authentication the real ingress performs, reduced to what this router
  // reads: a resolved principal. The route CEILING is proved separately, in
  // scimScopeSurface.test.ts, against the real AuthorizationService.
  app.use((req, _res, next) => {
    (req as any).principal = { id: CONNECTOR_ID, handle: 'estate-directory-connector' };
    (req as any).userId = 'estate-directory-connector';
    (req as any).authMethod = 'principal_api_key';
    // The chain the REAL middleware resolves for a Connector: acting link
    // first, the parentless Account last. The endpoint reads the ROOT.
    (req as any).delegationLinks = [
      { principalId: CONNECTOR_ID, kind: 'service', role: null, parentPrincipalId: ACCOUNT_ID, boundTaskId: null, legacyIdentity: false, ownExpression: { scopes: 'parent', objects: 'parent' } },
      { principalId: ACCOUNT_ID, kind: 'service', role: 'agent', parentPrincipalId: null, boundTaskId: null, legacyIdentity: false, ownExpression: null },
    ];
    next();
  });
  app.use('/scim', scimRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  boundProvider = true;
  handleTaken = false;
  provisioned = [];
  statements = [];
  delete process.env.RELAYHALL_PUBLIC_API_URL;
  armPool();
});

// ───────────────────────── the route census (SS-2's instrument) ─────────────

describe('the SCIM route census', () => {
  /** Ask the ROUTER what it serves. One implementation, used by the red proof. */
  function routesOf(router: any): string[] {
    const found: string[] = [];
    for (const layer of router.stack) {
      if (!layer.route) continue;
      for (const [method, enabled] of Object.entries(layer.route.methods as Record<string, boolean>)) {
        if (enabled) found.push(`${method.toUpperCase()} ${layer.route.path}`);
      }
    }
    return found.sort();
  }

  it('names exactly the routes the router serves', () => {
    expect(routesOf(scimRouter)).toEqual([...SCIM_ROUTE_CENSUS].sort());
  });

  it('RED PROOF: an unlisted route makes the census disagree', () => {
    const shadow = express.Router();
    for (const entry of SCIM_ROUTE_CENSUS) {
      const [method, routePath] = entry.split(' ');
      (shadow as any)[method.toLowerCase()](routePath, (_r: any, s: any) => s.end());
    }
    (shadow as any).post('/v2/Users/:id/promote', (_r: any, s: any) => s.end());
    expect(routesOf(shadow)).not.toEqual([...SCIM_ROUTE_CENSUS].sort());
  });
});

// ───────────────────────── the binding is the boundary ─────────────────────

describe('the Identity provider is resolved from the credential', () => {
  it('refuses a caller that is no enabled Identity provider’s SCIM client', async () => {
    boundProvider = false;
    const response = await call('POST', '/scim/v2/Users', { userName: 'ada' });
    expect(response.status).toBe(403);
    expect(response.body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
    expect(response.body.status).toBe('403');
    // Nothing was created, and nothing was even attempted.
    expect(statements.some((s) => s.sql.startsWith('INSERT INTO principals'))).toBe(false);
  });

  it('refuses the unbound caller BEFORE validating its body', async () => {
    boundProvider = false;
    // This body carries a refused authority attribute AND no userName; a
    // handler that validated first would answer 400. It must answer 403.
    const response = await call('POST', '/scim/v2/Users', { roles: [{ value: 'admin' }] });
    expect(response.status).toBe(403);
  });

  it('scopes the resolution query to an ACTIVE Identity provider', async () => {
    await call('GET', '/scim/v2/Users');
    const resolution = statements.find((s) => s.sql.includes('FROM identity_providers'));
    expect(resolution).toBeDefined();
    expect(resolution!.sql).toContain("status = 'active'");
    // The ACCOUNT, not the Connector that presented the credential — the
    // distinction review d4c0b5e2 B1 turned on.
    expect(resolution!.params).toEqual([ACCOUNT_ID]);
    expect(resolution!.params).not.toEqual([CONNECTOR_ID]);
  });
});

// ───────────────────────── parentless minimal-role creation ────────────────

describe('AZ-A4 clause 3 — parentless human Accounts at the fixed minimal role', () => {
  it('creates the Account with the role and kind the clause fixes', async () => {
    const response = await call('POST', '/scim/v2/Users', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'Ada.Lovelace',
      externalId: 'ext-1',
      name: { formatted: 'Ada Lovelace' },
      emails: [{ value: 'ada@example.test', primary: true }],
      active: true,
    });
    expect(response.status).toBe(201);
    expect(response.contentType).toContain('application/scim+json');

    // Read what the production code WROTE, not what it rendered back.
    const insert = statements.find((s) => s.sql.startsWith('INSERT INTO principals'));
    expect(insert).toBeDefined();
    const [kind, handle, displayName, role] = insert!.params as string[];
    expect(kind).toBe('human');
    expect(role).toBe(FIXED_MINIMAL_ACCOUNT_ROLE);
    expect(role).toBe('user');
    expect(handle).toBe('ada.lovelace'); // normalised, never suffixed
    expect(displayName).toBe('Ada Lovelace');
    // The INSERT names no parent column at all, so the row is parentless by
    // construction; migration 096's principals_human_parentless is the floor.
    expect(insert!.sql).not.toContain('parent_principal_id');

    const provenance = statements.find((s) => s.sql.startsWith('INSERT INTO directory_provisioned_accounts'));
    expect(provenance!.params).toEqual([NEW_ACCOUNT_ID, PROVIDER_ID, 'ext-1', 'Ada.Lovelace', CONNECTOR_ID]);
  });

  it('commits the Account and its provenance in ONE transaction', async () => {
    await call('POST', '/scim/v2/Users', { userName: 'ada' });
    const order = statements.map((s) => s.sql.split(' ').slice(0, 3).join(' '));
    const begin = order.indexOf('BEGIN');
    const principals = order.findIndex((s) => s.startsWith('INSERT INTO principals'));
    const provenance = order.findIndex((s) => s.startsWith('INSERT INTO directory_provisioned_accounts'));
    const audit = order.findIndex((s) => s.startsWith('INSERT INTO audit_events'));
    const commit = order.indexOf('COMMIT');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(begin).toBeLessThan(principals);
    expect(principals).toBeLessThan(provenance);
    // A24's ledger row is INSIDE the same transaction, not after it.
    expect(provenance).toBeLessThan(audit);
    expect(audit).toBeLessThan(commit);
  });

  it('audits the provisioning act (A24: every act is audited)', async () => {
    await call('POST', '/scim/v2/Users', { userName: 'ada' });
    const audit = statements.find((s) => s.sql.startsWith('INSERT INTO audit_events'));
    expect(audit).toBeDefined();
    expect(audit!.params[0]).toBe('directory.account.provision');
    expect(audit!.params[1]).toBe('success');
  });
});

// ───────────────────────── refusals A24 requires ───────────────────────────

describe('authority attributes are REFUSED, not ignored', () => {
  it.each([...SCIM_USER_ATTRIBUTE_POLICY.refused])('refuses a body carrying %s', async (attribute) => {
    const response = await call('POST', '/scim/v2/Users', { userName: 'ada', [attribute]: ['anything'] });
    expect(response.status).toBe(400);
    expect(response.body.scimType).toBe('invalidValue');
    expect(response.body.detail).toContain(attribute);
    expect(statements.some((s) => s.sql.startsWith('INSERT INTO principals'))).toBe(false);
  });

  it('refuses a directory-asserted board role BY NAME, not by consulting the policy list', async () => {
    // The case above iterates the list under test, so deleting an entry from
    // it deletes that entry's own case rather than failing one. This case
    // names the attribute itself, so the mutation that matters — dropping
    // `roles` from the policy — breaks BEHAVIOUR here and not only the
    // list's contents. SS-9: no external claim derives a board role in v1.
    const response = await call('POST', '/scim/v2/Users', {
      userName: 'ada',
      roles: [{ value: 'admin', primary: true }],
    });
    expect(response.status).toBe(400);
    expect(response.body.scimType).toBe('invalidValue');
    expect(statements.some((s) => s.sql.startsWith('INSERT INTO principals'))).toBe(false);
  });

  it('refuses a supplied resource id BY NAME, so a client cannot choose an identity', async () => {
    const response = await call('POST', '/scim/v2/Users', { userName: 'ada', id: NEW_ACCOUNT_ID });
    expect(response.status).toBe(400);
    expect(statements.some((s) => s.sql.startsWith('INSERT INTO principals'))).toBe(false);
  });

  it('the refused set actually contains the attributes that would confer authority', () => {
    // A policy list that had drifted to `[]` would make every case above
    // vacuous — `it.each([])` runs nothing and reports success.
    expect(SCIM_USER_ATTRIBUTE_POLICY.refused).toEqual(
      expect.arrayContaining(['roles', 'entitlements', 'groups', 'password', 'id']),
    );
  });

  it('ignores an unmapped attribute rather than refusing it (RFC 7644 §3.3)', async () => {
    const response = await call('POST', '/scim/v2/Users', { userName: 'ada', preferredLanguage: 'en', title: 'Countess' });
    expect(response.status).toBe(201);
    // ...and does not echo it back, so a client sees exactly what was honoured.
    expect(response.body.title).toBeUndefined();
    expect(response.body.preferredLanguage).toBeUndefined();
  });

  it('refuses creating an already-inactive Account (the lifecycle rung owns `active`)', async () => {
    const response = await call('POST', '/scim/v2/Users', { userName: 'ada', active: false });
    expect(response.status).toBe(400);
    expect(response.body.scimType).toBe('invalidValue');
  });

  it('refuses a userName that survives folding as nothing', async () => {
    const response = await call('POST', '/scim/v2/Users', { userName: '   ' });
    expect(response.status).toBe(400);
  });

  it('refuses a handle collision rather than suffixing it, and rolls back', async () => {
    handleTaken = true;
    const response = await call('POST', '/scim/v2/Users', { userName: 'ada' });
    expect(response.status).toBe(409);
    expect(response.body.scimType).toBe('uniqueness');
    expect(statements.some((s) => s.sql === 'ROLLBACK')).toBe(true);
    expect(statements.some((s) => s.sql === 'COMMIT')).toBe(false);
    // No second attempt under another handle — the whole point of the refusal.
    expect(statements.filter((s) => s.sql.startsWith('INSERT INTO principals')).length).toBe(1);
    // And the refusal is audited as a denied act.
    const audit = statements.find((s) => s.sql.startsWith('INSERT INTO audit_events'));
    expect(audit!.params[1]).toBe('denied');
  });
});

// ───────────────────────── the read boundary ───────────────────────────────

describe('A24 — no read beyond provisioning reconciliation', () => {
  beforeEach(() => {
    provisioned = [
      { id: NEW_ACCOUNT_ID, identity_provider_id: PROVIDER_ID, external_id: 'ext-1', user_name: 'ada', display_name: 'Ada', status: 'active', metadata: {}, created_at: new Date(), updated_at: new Date() },
      { id: FOREIGN_ACCOUNT_ID, identity_provider_id: OTHER_PROVIDER_ID, external_id: 'ext-2', user_name: 'grace', display_name: 'Grace', status: 'active', metadata: {}, created_at: new Date(), updated_at: new Date() },
    ];
  });

  it('reads back its OWN provisioned Account', async () => {
    const response = await call('GET', `/scim/v2/Users/${NEW_ACCOUNT_ID}`);
    expect(response.status).toBe(200);
    expect(response.body.id).toBe(NEW_ACCOUNT_ID);
  });

  it('cannot read an Account another Identity provider provisioned, and cannot tell it exists', async () => {
    const response = await call('GET', `/scim/v2/Users/${FOREIGN_ACCOUNT_ID}`);
    expect(response.status).toBe(404);
    const missing = await call('GET', '/scim/v2/Users/11111111-1111-4111-8111-111111111111');
    // Indistinguishable from a resource that never existed.
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual(response.body);
  });

  it('lists only its own, and the predicate is in the QUERY not a post-filter', async () => {
    const response = await call('GET', '/scim/v2/Users');
    expect(response.status).toBe(200);
    expect(response.body.Resources.map((r: any) => r.id)).toEqual([NEW_ACCOUNT_ID]);
    const page = statements.find((s) => s.sql.includes('FROM directory_provisioned_accounts d JOIN principals p'));
    expect(page!.sql).toContain('d.identity_provider_id = $1');
    expect(page!.params[0]).toBe(PROVIDER_ID);
  });

  it('answers the two enumerated filters and refuses every other expression', async () => {
    const byName = await call('GET', '/scim/v2/Users?filter=' + encodeURIComponent('userName eq "ada"'));
    expect(byName.status).toBe(200);
    expect(byName.body.totalResults).toBe(1);

    const byExternal = await call('GET', '/scim/v2/Users?filter=' + encodeURIComponent('externalId eq "ext-1"'));
    expect(byExternal.status).toBe(200);

    for (const expression of ['emails.value co "a"', 'userName sw "a"', 'userName eq "ada" and active eq true', 'active pr']) {
      const refused = await call('GET', '/scim/v2/Users?filter=' + encodeURIComponent(expression));
      expect(refused.status).toBe(400);
      expect(refused.body.scimType).toBe('invalidFilter');
    }
  });

  it('answers count=0 with the total and no resources (RFC 7644 §3.4.2.4)', async () => {
    // Review d4c0b5e2 B2: one helper served both parameters, so `count=0` —
    // the ordinary "how many are there?" reconciliation request — was
    // refused as though it were an invalid `startIndex`.
    const response = await call('GET', '/scim/v2/Users?count=0');
    expect(response.status).toBe(200);
    expect(response.body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:ListResponse']);
    expect(response.body.totalResults).toBe(1);
    expect(response.body.itemsPerPage).toBe(0);
    expect(response.body.Resources).toEqual([]);
    // ...and no page query was issued at all: there is no page to fetch.
    expect(statements.some((s) => s.sql.includes('FROM directory_provisioned_accounts d JOIN principals p'))).toBe(false);
  });

  it('count=0 still respects the Identity provider scope in its total', async () => {
    // The total must be THIS Identity provider's count, not the table's.
    const response = await call('GET', '/scim/v2/Users?count=0');
    expect(response.body.totalResults).toBe(1);
    const total = statements.find((s) => s.sql.includes('COUNT(*)::int AS total'));
    expect(total!.params[0]).toBe(PROVIDER_ID);
  });

  it('keeps the DIFFERENT floors the two paging parameters have', async () => {
    // `startIndex` is 1-based and `count` is non-negative. A single shared
    // bound is the defect; asserting both floors is what stops it returning.
    expect((await call('GET', '/scim/v2/Users?startIndex=0')).status).toBe(400);
    expect((await call('GET', '/scim/v2/Users?count=-1')).status).toBe(400);
    expect((await call('GET', '/scim/v2/Users?count=0')).status).toBe(200);
    expect((await call('GET', '/scim/v2/Users?startIndex=1')).status).toBe(200);
  });

  it('a filter cannot reach another Identity provider’s row', async () => {
    const response = await call('GET', '/scim/v2/Users?filter=' + encodeURIComponent('userName eq "grace"'));
    expect(response.status).toBe(200);
    expect(response.body.totalResults).toBe(0);
    expect(response.body.Resources).toEqual([]);
  });
});

// ───────────────────────── the protocol's own content type ─────────────────

describe("RFC 7644 §3.1: a body sent as application/scim+json is PARSED (card 127556e1)", () => {
  it('provisions from a scim+json body exactly as from a JSON one', async () => {
    const response = await fetch(`${baseUrl}/scim/v2/Users`, {
      method: 'POST',
      headers: { 'content-type': 'application/scim+json' },
      body: JSON.stringify({ userName: 'ada', externalId: 'ext-1' }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as Record<string, unknown>;
    expect(body.userName).toBe('ada');
    expect(statements.some((s) => s.sql.startsWith('INSERT INTO principals'))).toBe(true);
  });

  it('the shared type list names both types, and server.ts mounts the parser with it', () => {
    expect([...JSON_BODY_TYPES]).toEqual(['application/json', 'application/scim+json']);
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8');
    // The production mount passes the shared options; a bare `express.json()`
    // is the defect (the default type list), so it must not be there.
    expect(source).toContain('express.json(jsonBodyOptions)');
    expect(/express\.json\(\)/.test(source)).toBe(false);
  });
});

// ───────────────────────── protocol shape ──────────────────────────────────

describe('protocol surface', () => {
  it('declares only what this candidate really supports', async () => {
    const response = await call('GET', '/scim/v2/ServiceProviderConfig');
    expect(response.status).toBe(200);
    // PATCH, PUT and DELETE arrived with the lifecycle rung (candidate B), and
    // the census says so; bulk stays unsupported, and saying otherwise would
    // have a conforming client choose a verb that 404s.
    expect(response.body.patch.supported).toBe(true);
    expect(response.body.bulk.supported).toBe(false);
    expect(response.body.filter.supported).toBe(true);
    const censusMethods = SCIM_ROUTE_CENSUS.map((entry) => entry.split(' ')[0]);
    expect(censusMethods).toContain('PATCH');
    expect(censusMethods).toContain('PUT');
    expect(censusMethods).toContain('DELETE');
  });

  it('builds meta.location from the DECLARED origin, never from the Host header', async () => {
    process.env.RELAYHALL_PUBLIC_API_URL = 'https://board.example';
    const response = await call('POST', '/scim/v2/Users', { userName: 'ada' }, { host: 'attacker.example' });
    expect(response.status).toBe(201);
    expect(response.body.meta.location).toBe(`https://board.example/scim/v2/Users/${NEW_ACCOUNT_ID}`);
    expect(response.body.meta.location).not.toContain('attacker');
  });

  it('omits meta.location entirely when no origin is declared, rather than guessing one', async () => {
    const response = await call('POST', '/scim/v2/Users', { userName: 'ada' }, { host: 'attacker.example' });
    expect(response.status).toBe(201);
    expect(response.body.meta.location).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('attacker');
  });
});
