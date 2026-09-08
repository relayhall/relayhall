/**
 * RH-P5.SSO.W4 candidate C · SS-22 LIFTED — exactly as far as the producer
 * exists (card `c91d009b`; packet `aa36da97` §2 C; migration 108).
 *
 * > SS-22: "Until §7.4's rung supplies that producer, `directory` mode cannot
 * > be enabled, refused at configuration time with a named error rather than
 * > silently binding by whatever the sync happened to write."
 *
 * The producer for an Identity provider exists when THAT Identity provider
 * has a SCIM client (migration 106). So `directory` mode is enableable where
 * the client is named and refused — by the SAME name — where it is not, and
 * the client of an enabled directory-mode Identity provider cannot be
 * cleared. The naive lift (delete the check, delete the branch) is the
 * defect the brief warns against; each arm here is the assertion that would
 * go red under it.
 *
 * The REAL service over an armed pool; every assertion about what was
 * WRITTEN reads the SQL the service issued.
 */
jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import { pool } from '../db/connection';
import { identityProviderService, IdentityProviderError } from '../services/identity/IdentityProviderService';

const PROVIDER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONNECTOR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ACTOR = { principalId: null, handle: 'owner', authMethod: 'session' as const };

let status: 'active' | 'disabled';
let mode: 'invited' | 'jit' | 'directory';
let scimClient: string | null;
let statements: Array<{ sql: string; params: unknown[] }>;

function providerRow(): Record<string, unknown> {
  return {
    id: PROVIDER_ID, name: 'Estate directory', status, issuer: 'https://issuer.example/',
    discovery_url: 'https://issuer.example/.well-known/openid-configuration', client_id: 'rh',
    client_auth_method: 'none', has_client_secret: false, has_client_private_key: false,
    scopes_requested: 'openid', extra_authorize_params: {}, additional_endpoint_origins: [],
    handle_claim: 'preferred_username', display_name_claim: 'name', email_claim: 'email', groups_claim: null,
    required_claims: {}, subject_immutable: true, provisioning_mode: mode, group_binding_mode: 'off',
    scim_client_principal_id: scimClient, scim_heartbeat_interval_hours: null,
    login_group_whitelist_enabled: false, allow_private_issuer_address: false, allow_claim_matching: false,
    retain_id_token: false, provider_owns_profile: false, clock_skew_seconds: 60, session_ttl_seconds: null,
    authentication_request_ttl_seconds: 600, backchannel_logout_enabled: false,
    last_discovery_at: null, last_discovery_error_present: false, jwks_refreshed_at: null,
    created_at: new Date(), updated_at: new Date(),
  };
}

function armPool(): void {
  const query = async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    statements.push({ sql, params });
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (sql.startsWith('SELECT id FROM identity_providers WHERE status')) return { rows: [] }; // no OTHER active one
    if (sql.startsWith('UPDATE identity_providers SET scim_client_principal_id')) {
      scimClient = params[1] as string | null;
      return { rows: [providerRow()], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE identity_providers SET')) {
      status = params[2] as 'active' | 'disabled';
      mode = params[20] as typeof mode;
      return { rows: [providerRow()], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO identity_providers')) {
      return { rows: [providerRow()], rowCount: 1 };
    }
    if (sql.includes('FROM identity_providers')) return { rows: [providerRow()] };
    if (sql.startsWith('SELECT kind, status, legacy_identity, parent_principal_id FROM principals')) {
      return { rows: [{ kind: 'service', status: 'active', legacy_identity: false, parent_principal_id: null }] };
    }
    if (sql.includes("sv.kind = 'connector'")) return { rows: [{ id: CONNECTOR_ID }] };
    if (sql.includes('directory_sync_state')) return { rows: [], rowCount: 1 };
    if (sql.startsWith('INSERT INTO audit_events')) {
      return { rows: [{ id: 'a', action: params[0], outcome: params[1], actor_handle: params[3], auth_method: params[4], resource_type: params[6], occurred_at: new Date(), metadata: {} }] };
    }
    throw new Error(`unexpected sql: ${sql.slice(0, 120)}`);
  };
  (pool.query as jest.Mock).mockImplementation(query);
  (pool.connect as jest.Mock).mockResolvedValue({ query, release: jest.fn() });
}

const providerWrites = () => statements.filter((s) => s.sql.startsWith('UPDATE identity_providers SET') && !s.sql.includes('scim_client_principal_id = $2'));
const refusal = (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof IdentityProviderError ? e : null));

beforeEach(() => {
  status = 'active';
  mode = 'jit';
  scimClient = null;
  statements = [];
  armPool();
});

describe('directory mode is enableable exactly where the SCIM client is named', () => {
  it('REFUSES, by the SS-22 name, enabling directory mode with no SCIM client — and writes nothing', async () => {
    const error = await refusal(identityProviderService.update(PROVIDER_ID, { provisioningMode: 'directory' }, ACTOR));
    expect(error?.code).toBe('PROVIDER_DIRECTORY_MODE_UNAVAILABLE');
    expect(error?.message).toMatch(/SCIM client/);
    expect(error?.message).toMatch(/SS-22/);
    expect(providerWrites()).toEqual([]);
  });

  it('ENABLES directory mode once the SCIM client is named (the lift)', async () => {
    scimClient = ACCOUNT_ID;
    const updated = await identityProviderService.update(PROVIDER_ID, { provisioningMode: 'directory' }, ACTOR);
    expect(updated.provisioningMode).toBe('directory');
    expect(updated.status).toBe('active');
    expect(providerWrites().length).toBe(1);
    expect(providerWrites()[0].params[20]).toBe('directory');
  });

  it('a DISABLED Identity provider may hold directory mode without a client (activation is the gate)', async () => {
    status = 'disabled';
    const updated = await identityProviderService.update(PROVIDER_ID, { provisioningMode: 'directory' }, ACTOR);
    expect(updated.provisioningMode).toBe('directory');
    expect(providerWrites().length).toBe(1);
  });

  it('activating a disabled directory-mode Identity provider without a client is refused by the same name', async () => {
    status = 'disabled';
    mode = 'directory';
    const error = await refusal(identityProviderService.update(PROVIDER_ID, { status: 'active' }, ACTOR));
    expect(error?.code).toBe('PROVIDER_DIRECTORY_MODE_UNAVAILABLE');
    expect(providerWrites()).toEqual([]);
  });

  it('creating an Identity provider ENABLED in directory mode is refused: the client is named after creation', async () => {
    const error = await refusal(identityProviderService.create({
      name: 'n', issuer: 'https://issuer.example/', clientId: 'rh', subjectImmutable: true,
      status: 'active', provisioningMode: 'directory',
    }, ACTOR));
    expect(error?.code).toBe('PROVIDER_DIRECTORY_MODE_UNAVAILABLE');
    expect(statements.some((s) => s.sql.startsWith('INSERT INTO identity_providers'))).toBe(false);
  });

  it('CONTROL: invited and jit are untouched by the lift', async () => {
    for (const next of ['invited', 'jit'] as const) {
      statements = [];
      const updated = await identityProviderService.update(PROVIDER_ID, { provisioningMode: next }, ACTOR);
      expect(updated.provisioningMode).toBe(next);
    }
  });
});

describe('the producer of an ENABLED directory-mode Identity provider cannot be cleared', () => {
  it('refuses clearing the SCIM client, by the SS-22 name, and writes nothing', async () => {
    mode = 'directory';
    scimClient = ACCOUNT_ID;
    const error = await refusal(identityProviderService.setScimClient(PROVIDER_ID, null, ACTOR));
    expect(error?.code).toBe('PROVIDER_DIRECTORY_MODE_UNAVAILABLE');
    expect(error?.message).toMatch(/clearing the SCIM client/);
    expect(statements.some((s) => s.sql.startsWith('UPDATE identity_providers'))).toBe(false);
  });

  it('CONTROL: the client of a jit Identity provider clears as before', async () => {
    scimClient = ACCOUNT_ID;
    const updated = await identityProviderService.setScimClient(PROVIDER_ID, null, ACTOR);
    expect(updated.scimClientPrincipalId).toBeNull();
  });

  it('CONTROL: the client of a DISABLED directory-mode Identity provider clears (nothing is enabled and unable)', async () => {
    status = 'disabled';
    mode = 'directory';
    scimClient = ACCOUNT_ID;
    const updated = await identityProviderService.setScimClient(PROVIDER_ID, null, ACTOR);
    expect(updated.scimClientPrincipalId).toBeNull();
  });

  it('migration 108 is the floor: the CHECK violation past the service check becomes the same named refusal', async () => {
    scimClient = ACCOUNT_ID;
    (pool.query as jest.Mock).mockImplementation(async (text: string, params: unknown[] = []) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      statements.push({ sql, params });
      if (sql.startsWith('UPDATE identity_providers SET scim_client_principal_id')) {
        throw Object.assign(new Error('violates check constraint'), { code: '23514' });
      }
      if (sql.includes('FROM identity_providers')) return { rows: [providerRow()] };
      throw new Error(`unexpected sql: ${sql.slice(0, 80)}`);
    });
    const error = await refusal(identityProviderService.setScimClient(PROVIDER_ID, null, ACTOR));
    expect(error?.code).toBe('PROVIDER_DIRECTORY_MODE_UNAVAILABLE');
  });
});
