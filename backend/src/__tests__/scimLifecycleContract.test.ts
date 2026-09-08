/**
 * RH-P5.SSO.W4 candidate B · the `expected`-link PRODUCER, the LIFECYCLE rung
 * and the push HEARTBEAT, inside the SCIM surface.
 *
 * The companion to `scimProvisioningContract.test.ts` (candidate A's
 * handler behaviour) and `scimOwnerBindingCrossLayer.test.ts` (the actor
 * rule): this file proves the four candidate-B items of packet `aa36da97`
 * §2 against the sentences that govern them —
 *
 *   1. `expected` links: subject := externalId, REQUIRED in directory mode,
 *      refused by name when absent, never `userName` or an email (owner
 *      ruling `6bdcc16c` §1; SS-20; SS-22), written in the SAME transaction
 *      as the Account (SS-24 at the write);
 *   2. promotion: the login path's `directory` arm refuses a subject no
 *      expectation names (the live promotion vectors are in
 *      `scripts/test-w4-scim-lifecycle-live.js`, against migration 104's
 *      trigger on a real database);
 *   3. auto-disable — AZ-A4 clause 2 as amended 2026-09-01: the status is
 *      written through `PrincipalService.updatePrincipal` and NOTHING else,
 *      so the cached principal row is refreshed in the same act; reversible
 *      disable, never terminate; the flag raised; group membership untouched
 *      (SS-13); the reverse signal honoured only where the directory's own
 *      signal disabled the Account;
 *   4. heartbeat — SSO-R8 / ruling `6bdcc16c` §2: every authenticated act
 *      writes "last push received" under `scim:<id>` with the interval of
 *      that Identity provider as the threshold, and NOTHING when the
 *      interval is NULL (claim-sync semantics).
 *
 * ── HOW THIS DRIVES THE PRODUCTION CODE ──
 *
 * The REAL router over the REAL services, with only the pool armed, exactly
 * as the candidate-A contract suite does. Every assertion about what was
 * WRITTEN reads the SQL and parameters the production code issued. The
 * cache-refresh proof is BEHAVIOURAL: the real `PrincipalService` cache is
 * warmed before the act and read after it, so a status write that skips the
 * cache — the bulk-deprovision shape brief §2.6 names — is answered with the
 * stale row and goes red here, not merely in a comment.
 */
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import { pool } from '../db/connection';
import scimRouter, { SCIM_ROUTE_CENSUS } from '../routes/scim';
import { principalService } from '../services/PrincipalService';
import {
  DEPROVISION_SIGNALS,
  SCIM_PATCH_OP_SCHEMA,
  scimHeartbeatKey,
} from '../services/identity/ScimProvisioningService';

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROVIDER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_PROVIDER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CONNECTOR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NEW_ACCOUNT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const FOREIGN_ACCOUNT_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const LINK_ID = '11111111-1111-4111-8111-111111111111';

let server: http.Server;
let baseUrl: string;

/** Test state the armed pool answers from. */
let provisioningMode: 'invited' | 'jit' | 'directory';
let heartbeatIntervalHours: number | null;
let provisioned: Array<Record<string, unknown>>;
/** The board's own view of each Account: status and the flag. */
let principalStatus: Record<string, 'active' | 'disabled' | 'terminated'>;
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
    provisioning_mode: provisioningMode, group_binding_mode: 'off',
    scim_client_principal_id: ACCOUNT_ID,
    scim_heartbeat_interval_hours: heartbeatIntervalHours,
    login_group_whitelist_enabled: false, allow_private_issuer_address: false,
    allow_claim_matching: false, retain_id_token: false, provider_owns_profile: false,
    clock_skew_seconds: 60, session_ttl_seconds: null,
    authentication_request_ttl_seconds: 600, backchannel_logout_enabled: false,
    last_discovery_at: null, last_discovery_error_present: false, jwks_refreshed_at: null,
    created_at: new Date('2026-09-01T00:00:00Z'), updated_at: new Date('2026-09-01T00:00:00Z'),
  };
}

function principalRow(id: string, status: string, displayName = 'Ada'): Record<string, unknown> {
  return {
    id, kind: 'human', handle: 'ada', display_name: displayName, role: 'user', purpose: null,
    status, legacy_identity: false, parent_principal_id: null, metadata: {}, source_tag: null,
    harness: null, personality_id: null, bound_task_id: null, own_expression: null, last_seen_at: null,
  };
}

function armPool(): void {
  const query = async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    statements.push({ sql, params });
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (sql.includes("sv.kind = 'connector'")) return { rows: [{ is_connector: true }] };
    if (sql.includes('FROM identity_providers')) return { rows: [providerRow()] };
    if (sql.startsWith('INSERT INTO directory_sync_state')) return { rows: [], rowCount: 1 };
    if (sql.startsWith('INSERT INTO principals')) {
      principalStatus[NEW_ACCOUNT_ID] = 'active';
      return { rows: [{ ...principalRow(NEW_ACCOUNT_ID, 'active', String(params[2])), handle: params[1], role: params[3] }] };
    }
    if (sql.startsWith('SELECT * FROM principals WHERE id = $1')) {
      const id = String(params[0]);
      return { rows: principalStatus[id] ? [principalRow(id, principalStatus[id])] : [] };
    }
    if (sql.startsWith('UPDATE principals SET status')) {
      // PrincipalService.updatePrincipal's own statement shape.
      const id = String(params[0]);
      principalStatus[id] = params[1] as 'active' | 'disabled';
      return { rows: [principalRow(id, principalStatus[id])], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE principals SET display_name')) {
      return { rows: [principalRow(String(params[0]), principalStatus[String(params[0])], String(params[1]))], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE principals')) return { rows: [], rowCount: 1 };
    if (sql.startsWith('UPDATE auth_sessions')) return { rows: [], rowCount: 2 };
    if (sql.startsWith('INSERT INTO identity_links')) {
      return {
        rows: [{
          id: LINK_ID, account_principal_id: params[0], link_kind: 'sso', state: 'expected',
          identity_provider_id: params[1], subject: params[2], established_at: new Date(),
          promoted_at: null, last_seen_at: null, revoked_at: null, revoke_reason: null,
        }],
      };
    }
    if (sql.startsWith('INSERT INTO directory_provisioned_accounts')) {
      provisioned.push({
        id: params[0], identity_provider_id: params[1], external_id: params[2],
        user_name: params[3], deprovision_signal: null, display_name: 'Ada', metadata: {},
        created_at: new Date('2026-09-01T10:00:00Z'), updated_at: new Date('2026-09-01T10:00:00Z'),
      });
      return { rows: [] };
    }
    if (sql.startsWith('UPDATE directory_provisioned_accounts SET deprovision_signal')) {
      const row = provisioned.find((r) => r.id === params[0] && r.identity_provider_id === params[1]);
      if (row) row.deprovision_signal = sql.includes('deprovision_signal = NULL') ? null : params[2];
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith('UPDATE directory_provisioned_accounts')) return { rows: [], rowCount: 1 };
    if (sql.startsWith('INSERT INTO audit_events')) {
      return {
        rows: [{
          id: 'audit', action: params[0], outcome: params[1], actor_handle: params[3],
          auth_method: params[4], resource_type: params[6], occurred_at: new Date(), metadata: {},
        }],
      };
    }
    if (sql.includes('COUNT(*)::int AS total FROM directory_provisioned_accounts')) {
      return { rows: [{ total: rowsFor(sql, params).length }] };
    }
    if (sql.includes('FROM directory_provisioned_accounts d JOIN principals p')) {
      return { rows: rowsFor(sql, params).map((row) => ({ ...row, status: principalStatus[String(row.id)] ?? 'active' })) };
    }
    throw new Error(`unexpected sql: ${sql.slice(0, 140)}`);
  };
  (pool.query as jest.Mock).mockImplementation(query);
  (pool.connect as jest.Mock).mockResolvedValue({ query, release: jest.fn() });
}

function rowsFor(sql: string, params: unknown[]): Array<Record<string, unknown>> {
  const byId = sql.includes('d.account_principal_id = $1 AND d.identity_provider_id = $2');
  const providerId = byId ? params[1] : params[0];
  const scoped = provisioned.filter((row) => row.identity_provider_id === providerId);
  if (byId) return scoped.filter((row) => row.id === params[0]);
  return scoped;
}

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** One provisioned, active Account under the bound Identity provider. */
function seedAda(externalId: string | null = 'ext-ada'): void {
  provisioned.push({
    id: NEW_ACCOUNT_ID, identity_provider_id: PROVIDER_ID, external_id: externalId, user_name: 'ada',
    deprovision_signal: null, display_name: 'Ada', metadata: { email: 'ada@example.test' },
    created_at: new Date('2026-09-01T10:00:00Z'), updated_at: new Date('2026-09-01T10:00:00Z'),
  });
  principalStatus[NEW_ACCOUNT_ID] = 'active';
}

const statusWrites = () => statements.filter((s) => s.sql.startsWith('UPDATE principals SET status'));
const patchOps = (...operations: Array<Record<string, unknown>>) => ({ schemas: [SCIM_PATCH_OP_SCHEMA], Operations: operations });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).principal = { id: CONNECTOR_ID, handle: 'estate-directory-connector' };
    (req as any).userId = 'estate-directory-connector';
    (req as any).authMethod = 'principal_api_key';
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
  provisioningMode = 'directory';
  heartbeatIntervalHours = null;
  provisioned = [];
  principalStatus = {};
  statements = [];
  principalService.clearCacheForTests();
  armPool();
});

// ───────────────────────── the route census grows by exactly the lifecycle ──

describe('the lifecycle rung is in the census, and the protocol says so', () => {
  it('names PUT, PATCH and DELETE on /v2/Users/:id and nothing else new', () => {
    expect([...SCIM_ROUTE_CENSUS]).toEqual(expect.arrayContaining(['PUT /v2/Users/:id', 'PATCH /v2/Users/:id', 'DELETE /v2/Users/:id']));
    // A LITERAL TOTAL used to stand here. It is falsified by any correct
    // new rung -- RH-LENSES-a's six Groups routes are one -- while saying
    // nothing at all about a Users route that skipped the census, which is
    // the thing this row exists to catch. Narrowed to its own subject and
    // ENUMERATED, it is strictly stronger here and silent about rungs it
    // does not own. Whole-census agreement with the router is
    // `scimProvisioningContract`'s job, and it carries no total either.
    expect([...SCIM_ROUTE_CENSUS].filter((entry) => entry.includes('/v2/Users')).sort()).toEqual([
      'DELETE /v2/Users/:id',
      'GET /v2/Users',
      'GET /v2/Users/:id',
      'PATCH /v2/Users/:id',
      'POST /v2/Users',
      'PUT /v2/Users/:id',
    ]);
  });

  it('ServiceProviderConfig declares PATCH supported, because it now is', async () => {
    const response = await call('GET', '/scim/v2/ServiceProviderConfig');
    expect(response.status).toBe(200);
    expect(response.body.patch.supported).toBe(true);
  });
});

// ───────────────────────── 1. the `expected` link producer ─────────────────

describe('the expected Identity link (ruling 6bdcc16c §1; SS-20; SS-22; SS-24)', () => {
  it('directory mode REFUSES a push without externalId, BY NAME, before any write', async () => {
    const response = await call('POST', '/scim/v2/Users', { userName: 'ada', emails: [{ value: 'ada@example.test' }] });
    expect(response.status).toBe(400);
    expect(response.body.scimType).toBe('invalidValue');
    expect(response.body.detail).toContain('externalId');
    expect(statements.some((s) => s.sql.startsWith('INSERT INTO principals'))).toBe(false);
    expect(statements.some((s) => s.sql.startsWith('INSERT INTO identity_links'))).toBe(false);
  });

  it('writes the expectation with subject := externalId, state expected, no promoted_at', async () => {
    const response = await call('POST', '/scim/v2/Users', {
      userName: 'ada', externalId: 'sub-7f3a', emails: [{ value: 'ada@example.test', primary: true }],
    });
    expect(response.status).toBe(201);
    const link = statements.find((s) => s.sql.startsWith('INSERT INTO identity_links'));
    expect(link).toBeDefined();
    expect(link!.sql).toContain("'expected'");
    // The INSERT names no promoted_at, so it is NULL by construction (104's
    // CHECK pairs it with the state); RETURNING reads it back, which is fine.
    expect(link!.sql.split('RETURNING')[0]).not.toContain('promoted_at');
    const [accountId, providerId, subject, establishedBy] = link!.params;
    expect(accountId).toBe(NEW_ACCOUNT_ID);
    expect(providerId).toBe(PROVIDER_ID);
    expect(subject).toBe('sub-7f3a');
    expect(establishedBy).toBe(CONNECTOR_ID);
  });

  it('the subject is NEVER the userName and NEVER the email (SS-20)', async () => {
    await call('POST', '/scim/v2/Users', {
      userName: 'ada.lovelace', externalId: 'sub-7f3a', emails: [{ value: 'ada@example.test', primary: true }],
    });
    const link = statements.find((s) => s.sql.startsWith('INSERT INTO identity_links'))!;
    expect(link.params[2]).not.toBe('ada.lovelace');
    expect(link.params[2]).not.toBe('ada@example.test');
    expect(link.params[2]).toBe('sub-7f3a');
  });

  it('commits the expectation INSIDE the Account transaction, after the provenance row', async () => {
    await call('POST', '/scim/v2/Users', { userName: 'ada', externalId: 'sub-7f3a' });
    const order = statements.map((s) => s.sql);
    const begin = order.indexOf('BEGIN');
    const provenance = order.findIndex((s) => s.startsWith('INSERT INTO directory_provisioned_accounts'));
    const link = order.findIndex((s) => s.startsWith('INSERT INTO identity_links'));
    const audit = order.findIndex((s) => s.startsWith('INSERT INTO audit_events'));
    const commit = order.indexOf('COMMIT');
    expect(begin).toBeLessThan(provenance);
    expect(provenance).toBeLessThan(link);
    expect(link).toBeLessThan(audit);
    expect(audit).toBeLessThan(commit);
  });

  it('the audit row names the expectation it wrote', async () => {
    await call('POST', '/scim/v2/Users', { userName: 'ada', externalId: 'sub-7f3a' });
    const audit = statements.find((s) => s.sql.startsWith('INSERT INTO audit_events'))!;
    const metadata = JSON.parse(String(audit.params[8]));
    expect(metadata.expected_link_id).toBe(LINK_ID);
    expect(metadata.provisioning_mode).toBe('directory');
  });

  it.each(['jit', 'invited'] as const)('under %s mode no expectation is written and externalId stays optional', async (mode) => {
    provisioningMode = mode;
    const response = await call('POST', '/scim/v2/Users', { userName: 'ada' });
    expect(response.status).toBe(201);
    expect(statements.some((s) => s.sql.startsWith('INSERT INTO identity_links'))).toBe(false);
  });
});

// ───────────────────────── 3. auto-disable (AZ-A4 clause 2, amended) ───────

describe('auto-disable on active=false — AZ-A4 clause 2 as amended 2026-09-01', () => {
  beforeEach(() => seedAda());

  it('writes the status ONLY through PrincipalService.updatePrincipal, and the cache is refreshed in the same act', async () => {
    // Warm the real cache with the ACTIVE row, as a login-JWT request would.
    const warm = await principalService.getPrincipalById(NEW_ACCOUNT_ID);
    expect(warm?.status).toBe('active');
    const selectsBefore = statements.filter((s) => s.sql.startsWith('SELECT * FROM principals WHERE id')).length;

    const spy = jest.spyOn(principalService, 'updatePrincipal');
    const response = await call('PUT', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, { userName: 'ada', active: false });
    expect(response.status).toBe(200);
    expect(response.body.active).toBe(false);
    expect(spy).toHaveBeenCalledWith(NEW_ACCOUNT_ID, { status: 'disabled' });
    spy.mockRestore();

    // The NEXT read — with no further SELECT — sees the disabled row. A bare
    // UPDATE that skipped the helper would leave the warm row in place and
    // answer 'active' here for up to CACHE_TTL_MS.
    const next = await principalService.getPrincipalById(NEW_ACCOUNT_ID);
    expect(next?.status).toBe('disabled');
    const selectsAfter = statements.filter((s) => s.sql.startsWith('SELECT * FROM principals WHERE id')).length;
    expect(selectsAfter).toBe(selectsBefore);
    // ...and exactly one status statement was issued, in the helper's shape.
    expect(statusWrites().length).toBe(1);
    expect(statusWrites()[0].params).toEqual([NEW_ACCOUNT_ID, 'disabled']);
  });

  it('this file issues no status statement of its own (the bulk-deprovision shape, refused at the source)', () => {
    // Comment lines are dropped first: the file's own doc block NAMES the
    // refused shape, and a mention is not a statement.
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'identity', 'ScimProvisioningService.ts'), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    const statusWrite = /UPDATE\s+principals\s+SET[^;]{0,200}\bstatus\b/;
    expect(statusWrite.test(source)).toBe(false);
    // NON-VACUITY: the pattern does see the helper's own statement.
    expect(statusWrite.test('await pool.query(`UPDATE principals SET status = $2 WHERE id = $1`)')).toBe(true);
  });

  it('revokes the open login sessions with disabled_user, so the retained ID token dies with them (SSO-R16)', async () => {
    await call('PUT', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, { userName: 'ada', active: false });
    const revoke = statements.find((s) => s.sql.startsWith('UPDATE auth_sessions'));
    expect(revoke).toBeDefined();
    expect(revoke!.sql).toContain('id_token_ct = NULL');
    expect(revoke!.params).toEqual([NEW_ACCOUNT_ID, 'disabled_user', null]);
  });

  it('NEVER terminates: no statement and no parameter names the terminated state', async () => {
    await call('PUT', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, { userName: 'ada', active: false });
    await call('DELETE', `/scim/v2/Users/${NEW_ACCOUNT_ID}`);
    for (const statement of statements) {
      expect(statement.sql).not.toMatch(/terminat/i);
      expect(statement.params.map(String)).not.toContain('terminated');
    }
    expect(principalStatus[NEW_ACCOUNT_ID]).toBe('disabled');
  });

  it('raises the deprovision-detected flag (inactive) and audits the signal', async () => {
    await call('PUT', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, { userName: 'ada', active: false });
    const flag = statements.find((s) => s.sql.startsWith('UPDATE directory_provisioned_accounts SET deprovision_signal'))!;
    expect(flag.params).toEqual([NEW_ACCOUNT_ID, PROVIDER_ID, 'inactive']);
    expect(flag.sql).toContain('deprovisioned_at = now()');
    const audit = statements.find((s) => s.sql.startsWith('INSERT INTO audit_events') && s.params[0] === 'directory.account.deprovision')!;
    const metadata = JSON.parse(String(audit.params[8]));
    expect(metadata.signal).toBe('inactive');
    expect(metadata.status_after).toBe('disabled');
    expect(metadata.login_sessions_revoked).toBe(2);
  });

  it('DELETE is the second signal: removal from scope disables with flag `removed`, and the resource STAYS readable', async () => {
    const response = await call('DELETE', `/scim/v2/Users/${NEW_ACCOUNT_ID}`);
    expect(response.status).toBe(204);
    expect(statusWrites()[0].params).toEqual([NEW_ACCOUNT_ID, 'disabled']);
    const flag = statements.find((s) => s.sql.startsWith('UPDATE directory_provisioned_accounts SET deprovision_signal'))!;
    expect(flag.params[2]).toBe('removed');
    const read = await call('GET', `/scim/v2/Users/${NEW_ACCOUNT_ID}`);
    expect(read.status).toBe(200);
    expect(read.body.active).toBe(false);
  });

  it('the two signals are the ratified two and no third', () => {
    expect([...DEPROVISION_SIGNALS]).toEqual(['inactive', 'removed']);
  });

  it('a repeated inactive signal on a flagged, disabled Account writes nothing (idempotent)', async () => {
    await call('PUT', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, { userName: 'ada', active: false });
    statements = [];
    await call('PUT', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, { userName: 'ada', active: false });
    expect(statusWrites().length).toBe(0);
    expect(statements.some((s) => s.sql.startsWith('UPDATE directory_provisioned_accounts'))).toBe(false);
  });

  it('an inactive signal on an Account disabled on the board raises the flag WITHOUT a status write', async () => {
    principalStatus[NEW_ACCOUNT_ID] = 'disabled';
    const response = await call('PUT', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, { userName: 'ada', active: false });
    expect(response.status).toBe(200);
    expect(statusWrites().length).toBe(0);
    const flag = statements.find((s) => s.sql.startsWith('UPDATE directory_provisioned_accounts SET deprovision_signal'))!;
    expect(flag.params[2]).toBe('inactive');
  });

  it('SS-13: no lifecycle act touches group membership', async () => {
    await call('PUT', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, { userName: 'ada', active: false });
    await call('PATCH', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, patchOps({ op: 'replace', path: 'active', value: true }));
    await call('DELETE', `/scim/v2/Users/${NEW_ACCOUNT_ID}`);
    expect(statements.some((s) => /group_members|identity_provider_login_groups/i.test(s.sql))).toBe(false);
  });
});

describe('the reverse signal — reversible disable, and who may reverse it', () => {
  beforeEach(() => seedAda());

  it('active=true re-enables an Account the DIRECTORY disabled, and clears the flag', async () => {
    await call('PUT', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, { userName: 'ada', active: false });
    statements = [];
    const response = await call('PUT', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, { userName: 'ada', active: true });
    expect(response.status).toBe(200);
    expect(response.body.active).toBe(true);
    expect(statusWrites()[0].params).toEqual([NEW_ACCOUNT_ID, 'active']);
    const clear = statements.find((s) => s.sql.startsWith('UPDATE directory_provisioned_accounts SET deprovision_signal'))!;
    expect(clear.sql).toContain('deprovision_signal = NULL');
    const audit = statements.find((s) => s.sql.startsWith('INSERT INTO audit_events') && s.params[0] === 'directory.account.reactivate');
    expect(audit).toBeDefined();
  });

  it('active=true is REFUSED for an Account disabled on the board (no flag): AZ-30, flag and human acts', async () => {
    principalStatus[NEW_ACCOUNT_ID] = 'disabled';
    const response = await call('PUT', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, { userName: 'ada', active: true });
    expect(response.status).toBe(400);
    expect(response.body.scimType).toBe('mutability');
    expect(statusWrites().length).toBe(0);
    expect(principalStatus[NEW_ACCOUNT_ID]).toBe('disabled');
  });

  it('a terminated Account reads as inactive and cannot be re-enabled by provisioning (A17.10)', async () => {
    principalStatus[NEW_ACCOUNT_ID] = 'terminated';
    const read = await call('GET', `/scim/v2/Users/${NEW_ACCOUNT_ID}`);
    expect(read.body.active).toBe(false);
    const response = await call('PUT', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, { userName: 'ada', active: true });
    expect(response.status).toBe(400);
    expect(response.body.scimType).toBe('mutability');
    expect(statusWrites().length).toBe(0);
    // ...and an inactive signal against it writes nothing either.
    const inactive = await call('PUT', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, { userName: 'ada', active: false });
    expect(inactive.status).toBe(200);
    expect(statusWrites().length).toBe(0);
  });
});

// ───────────────────────── PATCH and the immutable pair ────────────────────

describe('PATCH (RFC 7644 §3.5.2) over the enumerated paths', () => {
  beforeEach(() => seedAda());

  it.each([
    ['boolean', false],
    ['a text boolean, as some clients send it', 'False'],
  ])('replace active with %s disables through the helper', async (_label, value) => {
    const response = await call('PATCH', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, patchOps({ op: 'Replace', path: 'active', value }));
    expect(response.status).toBe(200);
    expect(response.body.active).toBe(false);
    expect(statusWrites()[0].params).toEqual([NEW_ACCOUNT_ID, 'disabled']);
  });

  it('accepts the schema-prefixed path and a path-less object value', async () => {
    const prefixed = await call('PATCH', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, patchOps({ op: 'replace', path: 'urn:ietf:params:scim:schemas:core:2.0:User:active', value: false }));
    expect(prefixed.status).toBe(200);
    statements = [];
    await call('PUT', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, { userName: 'ada', active: true });
    statements = [];
    const pathless = await call('PATCH', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, patchOps({ op: 'replace', value: { active: false, displayName: 'Ada L.' } }));
    expect(pathless.status).toBe(200);
    expect(statusWrites()[0].params).toEqual([NEW_ACCOUNT_ID, 'disabled']);
    expect(statements.some((s) => s.sql.startsWith('UPDATE principals SET display_name') && s.params[1] === 'Ada L.')).toBe(true);
  });

  it('refuses a body without the PatchOp schema, an empty operation list, and `remove`', async () => {
    expect((await call('PATCH', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, { Operations: [{ op: 'replace', path: 'active', value: false }] })).status).toBe(400);
    expect((await call('PATCH', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, patchOps())).status).toBe(400);
    const remove = await call('PATCH', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, patchOps({ op: 'remove', path: 'active' }));
    expect(remove.status).toBe(400);
    expect(remove.body.detail).toContain('DELETE');
    expect(statusWrites().length).toBe(0);
  });

  it('refuses an unknown path with invalidPath, and an authority attribute by path with invalidValue', async () => {
    const unknown = await call('PATCH', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, patchOps({ op: 'replace', path: 'title', value: 'Countess' }));
    expect(unknown.status).toBe(400);
    expect(unknown.body.scimType).toBe('invalidPath');
    const roles = await call('PATCH', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, patchOps({ op: 'add', path: 'roles', value: [{ value: 'admin' }] }));
    expect(roles.status).toBe(400);
    expect(roles.body.scimType).toBe('invalidValue');
    expect(roles.body.detail).toContain('roles');
  });

  it('a non-boolean active is refused rather than coerced', async () => {
    const response = await call('PATCH', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, patchOps({ op: 'replace', path: 'active', value: 'maybe' }));
    expect(response.status).toBe(400);
    expect(statusWrites().length).toBe(0);
  });
});

describe('userName and externalId are held to EQUALITY (mutability)', () => {
  beforeEach(() => seedAda());

  it('PUT with a changed userName is refused and writes nothing', async () => {
    const response = await call('PUT', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, { userName: 'ada.renamed', active: false });
    expect(response.status).toBe(400);
    expect(response.body.scimType).toBe('mutability');
    expect(statements.some((s) => s.sql.startsWith('UPDATE'))).toBe(false);
  });

  it('PUT with a changed externalId is refused — it is the expected link\'s subject (SS-4)', async () => {
    const response = await call('PUT', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, { userName: 'ada', externalId: 'someone-else', active: false });
    expect(response.status).toBe(400);
    expect(response.body.scimType).toBe('mutability');
    expect(statusWrites().length).toBe(0);
  });

  it('the same values re-sent are not a change', async () => {
    const response = await call('PUT', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, { userName: 'ada', externalId: 'ext-ada', displayName: 'Ada', emails: [{ value: 'ada@example.test' }] });
    expect(response.status).toBe(200);
    expect(statements.some((s) => s.sql.startsWith('UPDATE'))).toBe(false);
  });

  it('PUT tolerates the readOnly id and meta the client read back (RFC 7644 §3.5.1) — the estate push carries them', async () => {
    const response = await call('PUT', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      id: NEW_ACCOUNT_ID,
      meta: { resourceType: 'User', location: `/scim/v2/Users/${NEW_ACCOUNT_ID}` },
      userName: 'ada', externalId: 'ext-ada', active: false,
    });
    expect(response.status).toBe(200);
    expect(statusWrites()[0].params).toEqual([NEW_ACCOUNT_ID, 'disabled']);
  });

  it('PUT with an id naming ANOTHER resource is refused as mutability, and writes nothing', async () => {
    const response = await call('PUT', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, { id: FOREIGN_ACCOUNT_ID, userName: 'ada', active: false });
    expect(response.status).toBe(400);
    expect(response.body.scimType).toBe('mutability');
    expect(statusWrites().length).toBe(0);
  });

  it('PUT still refuses authority attributes', async () => {
    const response = await call('PUT', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, { userName: 'ada', roles: [{ value: 'admin' }] });
    expect(response.status).toBe(400);
    expect(response.body.detail).toContain('roles');
  });

  it('the lifecycle rung cannot reach an Account another Identity provider provisioned', async () => {
    provisioned.push({
      id: FOREIGN_ACCOUNT_ID, identity_provider_id: OTHER_PROVIDER_ID, external_id: 'ext-2', user_name: 'grace',
      deprovision_signal: null, display_name: 'Grace', metadata: {}, created_at: new Date(), updated_at: new Date(),
    });
    principalStatus[FOREIGN_ACCOUNT_ID] = 'active';
    expect((await call('PUT', `/scim/v2/Users/${FOREIGN_ACCOUNT_ID}`, { userName: 'grace', active: false })).status).toBe(404);
    expect((await call('DELETE', `/scim/v2/Users/${FOREIGN_ACCOUNT_ID}`)).status).toBe(404);
    expect(statusWrites().length).toBe(0);
    expect(principalStatus[FOREIGN_ACCOUNT_ID]).toBe('active');
  });
});

// ───────────────────────── 4. the heartbeat (SSO-R8) ───────────────────────

describe('the push heartbeat — "last push received" under scim:<id> (ruling 6bdcc16c §2)', () => {
  const heartbeats = () => statements.filter((s) => s.sql.startsWith('INSERT INTO directory_sync_state'));

  it('every authenticated act, reads included, watermarks the Identity provider with ITS interval as the threshold', async () => {
    heartbeatIntervalHours = 6;
    seedAda();
    await call('GET', '/scim/v2/Users');
    await call('GET', `/scim/v2/Users/${NEW_ACCOUNT_ID}`);
    await call('POST', '/scim/v2/Users', { userName: 'grace', externalId: 'ext-grace' });
    await call('PUT', `/scim/v2/Users/${NEW_ACCOUNT_ID}`, { userName: 'ada', active: false });
    expect(heartbeats().length).toBe(4);
    for (const beat of heartbeats()) {
      expect(beat.params).toEqual([scimHeartbeatKey(PROVIDER_ID), 6]);
      expect(beat.sql).toContain('last_success_at = now()');
      expect(beat.sql).toContain('staleness_threshold_hours = EXCLUDED.staleness_threshold_hours');
    }
  });

  it('the key is prefixed, so the claim-sync row keyed by the bare id keeps its meaning', () => {
    expect(scimHeartbeatKey(PROVIDER_ID)).toBe(`scim:${PROVIDER_ID}`);
    expect(scimHeartbeatKey(PROVIDER_ID)).not.toBe(PROVIDER_ID);
  });

  it('writes NOTHING when the interval is NULL — claim-sync semantics are untouched', async () => {
    heartbeatIntervalHours = null;
    seedAda();
    await call('GET', '/scim/v2/Users');
    await call('POST', '/scim/v2/Users', { userName: 'grace', externalId: 'ext-grace' });
    expect(heartbeats().length).toBe(0);
    expect(statements.some((s) => /directory_sync_state/.test(s.sql))).toBe(false);
  });
});
