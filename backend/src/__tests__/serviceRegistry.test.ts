/**
 * ServiceRegistry semantics (RH-P2.1).
 *
 * Load-bearing claims: registration defaults are the safe ones (kind
 * service, direct mode, assigned-only tier via schema default, telemetry
 * none, status draft); brokered mode is refused at v1 (C5); mutation is
 * revision-bound; a service cannot publish before its first descriptor
 * version; descriptor publishing validates, deduplicates by canonical
 * content hash, and appends immutably; owner-plane (subscription-class)
 * fields have their own method with delivery-shape validation; retirement
 * is irreversible and version retirement refuses double-retire.
 */

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));
jest.mock('../services/AuditService', () => ({ auditService: { record: jest.fn() } }));

import { pool } from '../db/connection';
import {
  ServiceRegistry,
  ServiceRegistryError,
} from '../services/ServiceRegistry';
import { DescriptorError } from '../utils/serviceDescriptor';
import { CLAUDE_CODE_DESCRIPTOR } from './fixtures/serviceDescriptors';

const SERVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REVISION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface FakeState {
  head: any | null;
  versions: any[];
  mutations: string[];
}

let state: FakeState;
const registry = new ServiceRegistry();

function headRow(overrides: Record<string, any> = {}): any {
  return {
    id: SERVICE_ID,
    slug: 'claude-code',
    name: 'Claude Code',
    description: '',
    kind: 'connector',
    runtime_mode: 'direct',
    status: 'draft',
    visibility_tier: 'assigned-only',
    delivery_mode: 'none',
    delivery_endpoint: null,
    delivery_poll_interval_seconds: null,
    telemetry_tier: 'none',
    current_descriptor_version: null,
    revision: REVISION,
    created_by_principal_id: 'owner',
    updated_by_principal_id: 'owner',
    created_at: 'now',
    updated_at: 'now',
    retired_at: null,
    ...overrides,
  };
}

function armPool(): void {
  const query = async (text: string, params: any[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      state.mutations.push(sql);
      return { rows: [] };
    }
    if (sql.startsWith('SELECT * FROM services WHERE id = $1 FOR UPDATE')) {
      return { rows: state.head && params[0] === state.head.id ? [state.head] : [] };
    }
    if (sql.startsWith('SELECT * FROM services WHERE id = $1')) {
      return { rows: state.head && params[0] === state.head.id ? [state.head] : [] };
    }
    if (sql.startsWith('SELECT * FROM services WHERE slug = $1')) {
      return { rows: state.head && params[0] === state.head.slug ? [state.head] : [] };
    }
    if (sql.startsWith('SELECT * FROM services')) {
      return { rows: state.head ? [state.head] : [] };
    }
    if (sql.startsWith('INSERT INTO services')) {
      if (state.head && state.head.slug === params[0]) {
        throw new Error('duplicate key value violates unique constraint "services_slug_key"');
      }
      state.mutations.push('INSERT service');
      state.head = headRow({
        slug: params[0], name: params[1], description: params[2],
        kind: params[3], runtime_mode: params[4], telemetry_tier: params[5],
        principal_id: params[6], created_by_principal_id: params[7], updated_by_principal_id: params[7],
      });
      return { rows: [state.head] };
    }
    if (sql.startsWith('UPDATE services')) {
      state.mutations.push('UPDATE service');
      // The service layer only asserts on returned rows' mapped fields the
      // tests inspect; reflect status/retired transitions coarsely.
      if (sql.includes("status = 'retired'")) {
        state.head = headRow({ ...state.head, status: 'retired', retired_at: 'now', revision: 'rotated' });
      } else if (sql.includes('current_descriptor_version = $2')) {
        state.head = headRow({ ...state.head, current_descriptor_version: params[1], revision: 'rotated' });
      } else {
        state.head = headRow({ ...state.head, revision: 'rotated' });
      }
      return { rows: [state.head] };
    }
    if (sql.startsWith('SELECT content_hash FROM service_descriptor_versions')) {
      const found = state.versions.find(
        (v) => v.service_id === params[0] && v.version === params[1],
      );
      return { rows: found ? [{ content_hash: found.content_hash }] : [] };
    }
    if (sql.startsWith('SELECT COALESCE(MAX(version), 0) + 1')) {
      const max = state.versions.filter((v) => v.service_id === params[0])
        .reduce((m, v) => Math.max(m, v.version), 0);
      return { rows: [{ next: max + 1 }] };
    }
    if (sql.startsWith('INSERT INTO service_descriptor_versions')) {
      state.mutations.push('INSERT version');
      const row = {
        id: `version-${params[1]}`, service_id: params[0], version: params[1],
        descriptor: JSON.parse(params[2]), content_hash: params[3],
        created_by_principal_id: params[4], created_at: 'now', retired_at: null,
      };
      state.versions.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith('SELECT * FROM service_descriptor_versions WHERE service_id = $1 AND version = $2 FOR UPDATE')) {
      const found = state.versions.find((v) => v.service_id === params[0] && v.version === params[1]);
      return { rows: found ? [found] : [] };
    }
    if (sql.startsWith('UPDATE service_descriptor_versions SET retired_at')) {
      const found = state.versions.find((v) => v.service_id === params[0] && v.version === params[1]);
      if (found) found.retired_at = 'now';
      state.mutations.push('RETIRE version');
      return { rows: found ? [found] : [] };
    }
    if (sql.startsWith('SELECT version, descriptor, content_hash')) {
      const found = state.versions.find((v) => v.service_id === params[0] && v.version === params[1]);
      return { rows: found ? [found] : [] };
    }
    if (sql.startsWith('SELECT version, content_hash')) {
      return { rows: state.versions.filter((v) => v.service_id === params[0]) };
    }
    if (sql.startsWith('DELETE FROM services')) {
      if (state.head && params[0] === state.head.id) {
        state.head = null;
        return { rows: [{ id: params[0] }] };
      }
      return { rows: [] };
    }
    if (/SELECT id, kind, status, parent_principal_id, legacy_identity FROM principals/.test(sql)) {
      return { rows: [{ id: params?.[0], kind: 'human', status: 'active', parent_principal_id: null, legacy_identity: false }] };
    }
    if (/INSERT INTO principals /.test(sql)) {
      return { rows: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }] };
    }
    throw new Error(`unexpected sql: ${sql.slice(0, 90)}`);
  };
  (pool.query as jest.Mock).mockImplementation(query);
  (pool.connect as jest.Mock).mockResolvedValue({ query, release: jest.fn() });
}

async function expectError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  try {
    await promise;
    throw new Error(`expected ServiceRegistryError ${code}, got success`);
  } catch (e) {
    if (e instanceof ServiceRegistryError) {
      expect(e.status).toBe(status);
      expect(e.code).toBe(code);
      return;
    }
    throw e;
  }
}

beforeEach(() => {
  state = { head: null, versions: [], mutations: [] };
  armPool();
});

describe('registration', () => {
  it('registers with the safe defaults and server-written attribution', async () => {
    const service = await registry.register(
      { slug: 'claude-code', name: 'Claude Code', kind: 'connector' },
      'principal-1',
    );
    expect(service.kind).toBe('connector');
    expect(service.runtimeMode).toBe('direct');
    expect(service.status).toBe('draft');
    expect(service.visibilityTier).toBe('assigned-only');
    expect(service.deliveryMode).toBe('none');
    expect(service.telemetryTier).toBe('none');
    expect(service.currentDescriptorVersion).toBeNull();
    expect(service.createdByPrincipalId).toBe('principal-1');
  });

  it("refuses runtime mode 'brokered' at v1 (C5 cut) with the deferral named", async () => {
    await expectError(
      registry.register({ slug: 's', name: 'S', runtimeMode: 'brokered' }, 'p'),
      422,
      'BROKERED_MODE_NOT_AVAILABLE',
    );
  });

  it('refuses a malformed slug, naming the accepted form', async () => {
    await expectError(
      registry.register({ slug: 'Not A Slug', name: 'S' }, 'p'),
      422,
      'INVALID_SERVICE_VALUE',
    );
  });

  it('maps a duplicate slug onto 409', async () => {
    await registry.register({ slug: 'claude-code', name: 'Claude Code' }, 'p');
    await expectError(
      registry.register({ slug: 'claude-code', name: 'Again' }, 'p'),
      409,
      'SERVICE_SLUG_TAKEN',
    );
  });

  it('does not accept subscription-class fields at registration', async () => {
    // The route allowlist rejects them before the service is reached; the
    // service input type carries no delivery/visibility members at all —
    // this pin documents the shape rather than a runtime branch.
    const service = await registry.register({ slug: 's1', name: 'S1' }, 'p');
    expect(service.deliveryMode).toBe('none');
    expect(service.visibilityTier).toBe('assigned-only');
  });
});

describe('metadata update', () => {
  beforeEach(async () => {
    await registry.register({ slug: 'claude-code', name: 'Claude Code' }, 'p');
  });

  it('requires the observed revision (If-Match) and rejects a stale one', async () => {
    await expectError(registry.update(SERVICE_ID, { name: 'X' }, undefined, 'p'), 400, 'REVISION_REQUIRED');
    await expectError(registry.update(SERVICE_ID, { name: 'X' }, 'stale', 'p'), 412, 'REVISION_MISMATCH');
  });

  it('refuses publishing a service that has no descriptor version', async () => {
    await expectError(
      registry.update(SERVICE_ID, { status: 'published' }, REVISION, 'p'),
      409,
      'SERVICE_HAS_NO_DESCRIPTOR',
    );
  });

  it("routes status 'retired' to the admin retire surface, not a metadata update", async () => {
    await expectError(
      registry.update(SERVICE_ID, { status: 'retired' }, REVISION, 'p'),
      422,
      'INVALID_SERVICE_VALUE',
    );
  });

  it('refuses updates on a retired service', async () => {
    state.head = headRow({ status: 'retired', retired_at: 'now' });
    await expectError(registry.update(SERVICE_ID, { name: 'X' }, REVISION, 'p'), 409, 'SERVICE_RETIRED');
  });
});

describe('descriptor publishing', () => {
  beforeEach(async () => {
    await registry.register({ slug: 'claude-code', name: 'Claude Code', kind: 'connector' }, 'p');
  });

  it('publishes version 1, bumps the head pointer, and returns the validated descriptor', async () => {
    const result = await registry.publishDescriptor(SERVICE_ID, CLAUDE_CODE_DESCRIPTOR, REVISION, 'p');
    expect(result.descriptorVersion.version).toBe(1);
    expect(result.service.currentDescriptorVersion).toBe(1);
    expect(state.mutations).toContain('INSERT version');
  });

  it('refuses a byte-identical re-publish instead of silently bumping the version', async () => {
    await registry.publishDescriptor(SERVICE_ID, CLAUDE_CODE_DESCRIPTOR, REVISION, 'p');
    await expectError(
      registry.publishDescriptor(SERVICE_ID, CLAUDE_CODE_DESCRIPTOR, 'rotated', 'p'),
      409,
      'DESCRIPTOR_UNCHANGED',
    );
  });

  it('a changed parameter schema is a NEW version — pinning covers parameters (E-17 obligation 4)', async () => {
    await registry.publishDescriptor(SERVICE_ID, CLAUDE_CODE_DESCRIPTOR, REVISION, 'p');
    const amended = {
      options: [
        ...CLAUDE_CODE_DESCRIPTOR.options,
        { key: 'workflow', type: 'enum', values: [{ value: 'w1' }], parameters: [{ key: 'p1', type: 'string' }] },
      ],
    };
    const result = await registry.publishDescriptor(SERVICE_ID, amended, 'rotated', 'p');
    expect(result.descriptorVersion.version).toBe(2);
  });

  it('rejects an invalid descriptor with the DescriptorError field intact', async () => {
    await expect(
      registry.publishDescriptor(SERVICE_ID, { options: [], extra: 1 }, REVISION, 'p'),
    ).rejects.toBeInstanceOf(DescriptorError);
    expect(state.mutations).not.toContain('INSERT version');
  });
});

describe('owner-plane (subscription-class) fields', () => {
  beforeEach(async () => {
    await registry.register({ slug: 'claude-code', name: 'Claude Code' }, 'p');
  });

  it("delivery mode 'webhook' requires an http(s) endpoint AND a signing secret", async () => {
    await expectError(
      registry.updateOwnerPlane(SERVICE_ID, { deliveryMode: 'webhook' }, REVISION, 'p'),
      422,
      'INVALID_SERVICE_VALUE',
    );
    await expectError(
      registry.updateOwnerPlane(
        SERVICE_ID,
        { deliveryMode: 'webhook', deliveryEndpoint: 'ftp://x.test/hook', deliverySecret: 's3cret' },
        REVISION,
        'p',
      ),
      422,
      'INVALID_SERVICE_VALUE',
    );
    // Ruling ccd53781 R1: the registry row is the single source of truth for
    // delivery, and unsigned delivery is not representable — an endpoint
    // without a secret is refused here as well as by the 101 CHECK.
    await expectError(
      registry.updateOwnerPlane(
        SERVICE_ID,
        { deliveryMode: 'webhook', deliveryEndpoint: 'https://runner.test/hook' },
        REVISION,
        'p',
      ),
      422,
      'INVALID_SERVICE_VALUE',
    );
    const ok = await registry.updateOwnerPlane(
      SERVICE_ID,
      { deliveryMode: 'webhook', deliveryEndpoint: 'https://runner.test/hook', deliverySecret: 's3cret' },
      REVISION,
      'p',
    );
    expect(state.mutations).toContain('UPDATE service');
    expect(ok.revision).toBe('rotated');
  });

  it('clears the delivery secret with the endpoint when the mode leaves webhook', async () => {
    // A mode flip must never leave a live signing secret addressed at
    // nothing: poll and none clear both halves together.
    await registry.updateOwnerPlane(SERVICE_ID, { deliveryMode: 'none' }, REVISION, 'p');
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '../services/ServiceRegistry.ts'), 'utf8',
    );
    const block = source.slice(source.indexOf('const deliveryTouched'), source.indexOf("push('delivery_mode'"));
    expect(block).toMatch(/endpoint = null;\s*\n\s*secret = null;/);
  });

  it('never round-trips the delivery secret through a read', async () => {
    const record = await registry.updateOwnerPlane(
      SERVICE_ID,
      { deliveryMode: 'webhook', deliveryEndpoint: 'https://runner.test/hook', deliverySecret: 's3cret' },
      REVISION,
      'p',
    );
    expect(record).not.toHaveProperty('deliverySecret');
    expect(JSON.stringify(record)).not.toContain('s3cret');
    expect(record).toHaveProperty('deliveryHasSecret');
  });

  it("delivery mode 'poll' requires a bounded integer interval", async () => {
    await expectError(
      registry.updateOwnerPlane(
        SERVICE_ID,
        { deliveryMode: 'poll', deliveryPollIntervalSeconds: 5 },
        REVISION,
        'p',
      ),
      422,
      'INVALID_SERVICE_VALUE',
    );
  });

  it('refuses brokered runtime mode here too (C5)', async () => {
    await expectError(
      registry.updateOwnerPlane(SERVICE_ID, { runtimeMode: 'brokered' }, REVISION, 'p'),
      422,
      'BROKERED_MODE_NOT_AVAILABLE',
    );
  });

  it('is revision-bound like every mutation', async () => {
    await expectError(
      registry.updateOwnerPlane(SERVICE_ID, { visibilityTier: 'unrestricted' }, 'stale', 'p'),
      412,
      'REVISION_MISMATCH',
    );
  });
});

describe('retirement and deletion', () => {
  beforeEach(async () => {
    await registry.register({ slug: 'claude-code', name: 'Claude Code' }, 'p');
  });

  it('retires a service irreversibly (§4.4): a second retire is refused', async () => {
    const retired = await registry.retireService(SERVICE_ID, REVISION, 'p');
    expect(retired.status).toBe('retired');
    await expectError(registry.retireService(SERVICE_ID, 'rotated', 'p'), 409, 'SERVICE_RETIRED');
  });

  it('retires one descriptor version and refuses a double retire', async () => {
    await registry.publishDescriptor(SERVICE_ID, CLAUDE_CODE_DESCRIPTOR, REVISION, 'p');
    const meta = await registry.retireDescriptorVersion(SERVICE_ID, 1, 'p');
    expect(meta.retiredAt).not.toBeNull();
    await expectError(registry.retireDescriptorVersion(SERVICE_ID, 1, 'p'), 409, 'DESCRIPTOR_VERSION_RETIRED');
  });

  it('404s a retire of a version that does not exist', async () => {
    await expectError(registry.retireDescriptorVersion(SERVICE_ID, 7, 'p'), 404, 'DESCRIPTOR_VERSION_NOT_FOUND');
  });

  it('hard delete 404s an absent service', async () => {
    await registry.delete(SERVICE_ID);
    await expectError(registry.delete(SERVICE_ID), 404, 'SERVICE_NOT_FOUND');
  });
});

describe('dry-run (E-11)', () => {
  it('a dry-run register runs the full validation transaction and rolls back', async () => {
    await registry.register({ slug: 'rehearsal', name: 'Rehearsal' }, 'p', { dryRun: true });
    expect(state.mutations).toContain('ROLLBACK');
    expect(state.mutations).not.toContain('COMMIT');
  });

  it('a dry-run publish still refuses an invalid descriptor', async () => {
    await registry.register({ slug: 'claude-code', name: 'Claude Code' }, 'p');
    await expect(
      registry.publishDescriptor(SERVICE_ID, { options: [], extra: 1 }, REVISION, 'p', { dryRun: true }),
    ).rejects.toBeInstanceOf(DescriptorError);
  });

  it('a live mutation commits', async () => {
    await registry.register({ slug: 'real', name: 'Real' }, 'p');
    expect(state.mutations).toContain('COMMIT');
  });
});

describe('resolution', () => {
  it('resolves by slug and by UUID identically', async () => {
    await registry.register({ slug: 'claude-code', name: 'Claude Code' }, 'p');
    const bySlug = await registry.getByIdOrSlug('claude-code');
    const byId = await registry.getByIdOrSlug(SERVICE_ID);
    expect(bySlug.id).toBe(byId.id);
  });

  it('404s an unknown service', async () => {
    await expectError(registry.getByIdOrSlug('missing'), 404, 'SERVICE_NOT_FOUND');
  });
});
