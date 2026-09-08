/**
 * Canonical Resource validation contract (task 47ef04a2; schema 28b76f54).
 *
 * Every value is untrusted data and every failure must be a stable-coded
 * ResourceContractError that never echoes the offending value. These tests
 * cover the discriminated per-kind schemas, the hostile-input rejections
 * (embedded credentials, traversal, control characters, unknown fields,
 * cross-kind keys) and the defaults.
 */

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import { pool } from '../db/connection';
import {
  ProjectResourceService,
  ResourceContractError,
  validateDetails,
  normalizeResourceName,
} from '../services/ProjectResourceService';

function expectThrows(fn: () => unknown, code: string): ResourceContractError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ResourceContractError);
    expect((e as ResourceContractError).code).toBe(code);
    return e as ResourceContractError;
  }
  throw new Error(`expected ${code}`);
}

describe('repository details', () => {
  it('accepts https, ssh and SCP-like URLs', () => {
    expect(validateDetails('repository', { url: 'https://git.example.test/o/r.git' }).role).toBe('additional');
    expect(validateDetails('repository', { url: 'ssh://git@example.test/o/r.git', role: 'primary' }).role).toBe('primary');
    expect(validateDetails('repository', { url: 'git@example.test:o/r.git' }).url).toBe('git@example.test:o/r.git');
  });

  it('rejects embedded credentials in https URLs', () => {
    expectThrows(() => validateDetails('repository', { url: 'https://user:token@example.test/r.git' }), 'EMBEDDED_CREDENTIAL_FORBIDDEN');
  });

  it('rejects non-git schemes', () => {
    expectThrows(() => validateDetails('repository', { url: 'ftp://example.test/r.git' }), 'UNSUPPORTED_SCHEME');
  });

  it('rejects unknown keys and cross-kind keys', () => {
    expectThrows(() => validateDetails('repository', { url: 'https://x.test/r.git', path: '/tmp' }), 'UNKNOWN_FIELD');
    expectThrows(() => validateDetails('repository', { url: 'https://x.test/r.git', anything: 1 }), 'UNKNOWN_FIELD');
  });

  it('error for a rejected URL does not echo the URL', () => {
    const e = expectThrows(() => validateDetails('repository', { url: 'https://user:supersecret@example.test/r.git' }), 'EMBEDDED_CREDENTIAL_FORBIDDEN');
    expect(e.message).not.toContain('supersecret');
  });
});

describe('environment details', () => {
  it('accepts http(s) URLs with a recognized stage', () => {
    const details = validateDetails('environment', { url: 'https://dev.example.test', stage: 'development' });
    expect(details.stage).toBe('development');
  });

  it('rejects user-info, bad schemes and unknown stages', () => {
    expectThrows(() => validateDetails('environment', { url: 'https://admin:pw@dev.example.test', stage: 'development' }), 'EMBEDDED_CREDENTIAL_FORBIDDEN');
    expectThrows(() => validateDetails('environment', { url: 'gopher://dev.example.test', stage: 'development' }), 'UNSUPPORTED_SCHEME');
    expectThrows(() => validateDetails('environment', { url: 'https://dev.example.test', stage: 'prod' }), 'INVALID_RESOURCE_VALUE');
  });

  it('requires the stage', () => {
    expectThrows(() => validateDetails('environment', { url: 'https://dev.example.test' }), 'INVALID_RESOURCE_VALUE');
  });
});

describe('workspace details', () => {
  it('accepts absolute paths with a recognized purpose', () => {
    const details = validateDetails('workspace', { path: '/srv/projects/x', purpose: 'source' });
    expect(details.path).toBe('/srv/projects/x');
  });

  it('rejects relative paths, traversal and NUL', () => {
    expectThrows(() => validateDetails('workspace', { path: 'srv/x', purpose: 'source' }), 'INVALID_RESOURCE_VALUE');
    expectThrows(() => validateDetails('workspace', { path: '/srv/../etc/passwd', purpose: 'source' }), 'INVALID_RESOURCE_VALUE');
    expectThrows(() => validateDetails('workspace', { path: '/srv/x' + String.fromCharCode(0) + 'y', purpose: 'source' }), 'INVALID_RESOURCE_VALUE');
  });
});

describe('reference details', () => {
  it('accepts documentation/research/tool/other categories', () => {
    for (const category of ['documentation', 'research', 'tool', 'other']) {
      expect(validateDetails('reference', { url: 'https://docs.example.test', category }).category).toBe(category);
    }
  });

  it('rejects filesystem paths (those belong to workspace)', () => {
    expectThrows(() => validateDetails('reference', { url: '/srv/docs', category: 'documentation' }), 'INVALID_RESOURCE_VALUE');
  });
});

describe('name normalization', () => {
  it('is trimmed and Unicode case-folded', () => {
    expect(normalizeResourceName('  Main Repo ')).toBe('main repo');
    expect(normalizeResourceName('STRASSE')).toBe('strasse');
    // NFKC folds compatibility forms: fullwidth latin letters fold to ASCII.
    expect(normalizeResourceName('ＡＢＣ')).toBe('abc');
  });
});

describe('common fields through create()', () => {
  const service = new ProjectResourceService();

  function armPool(): string[] {
    const mutations: string[] = [];
    const query = async (text: string, params: any[] = []) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.startsWith('SELECT id, status FROM projects')) {
        return { rows: [{ id: params[0], status: 'active' }] };
      }
      if (sql.startsWith('INSERT INTO project_resources')) {
        mutations.push('insert');
        return {
          rows: [{
            id: params[0], project_id: params[1], kind: params[2], name: params[3],
            normalized_name: params[4], description: params[5], agent_visibility: params[6],
            export_policy: params[7], details: JSON.parse(params[8]), state: 'active',
            revision: 'r1', archived_at: null, created_at: 'now', updated_at: 'now',
          }],
        };
      }
      throw new Error(`unexpected: ${sql.slice(0, 60)}`);
    };
    (pool.query as jest.Mock).mockImplementation(query);
    (pool.connect as jest.Mock).mockResolvedValue({ query, release: jest.fn() });
    return mutations;
  }

  beforeEach(() => jest.clearAllMocks());

  it('defaults to hidden and installation-only', async () => {
    armPool();
    const resource = await service.create('p1', {
      kind: 'reference', name: 'Docs', details: { url: 'https://d.example.test', category: 'documentation' },
    });
    expect(resource.agentVisibility).toBe('hidden');
    expect(resource.exportPolicy).toBe('installation-only');
  });

  it('workspace can never be portable', async () => {
    const mutations = armPool();
    await expect(service.create('p1', {
      kind: 'workspace', name: 'Build', exportPolicy: 'portable',
      details: { path: '/srv/build', purpose: 'build' },
    })).rejects.toMatchObject({ code: 'WORKSPACE_MUST_BE_INSTALLATION_ONLY' });
    expect(mutations).toHaveLength(0);
  });

  it('bounds the name at 120 and the description at 1000 characters', async () => {
    const mutations = armPool();
    await expect(service.create('p1', {
      kind: 'reference', name: 'x'.repeat(121),
      details: { url: 'https://d.example.test', category: 'other' },
    })).rejects.toMatchObject({ code: 'INVALID_RESOURCE_VALUE' });
    await expect(service.create('p1', {
      kind: 'reference', name: 'ok', description: 'd'.repeat(1001),
      details: { url: 'https://d.example.test', category: 'other' },
    })).rejects.toMatchObject({ code: 'INVALID_RESOURCE_VALUE' });
    expect(mutations).toHaveLength(0);
  });

  it('rejects control characters in names', async () => {
    const mutations = armPool();
    await expect(service.create('p1', {
      kind: 'reference', name: 'bad' + String.fromCharCode(7) + 'name',
      details: { url: 'https://d.example.test', category: 'other' },
    })).rejects.toMatchObject({ code: 'INVALID_RESOURCE_VALUE' });
    expect(mutations).toHaveLength(0);
  });

  it('rejects an unknown kind', async () => {
    const mutations = armPool();
    await expect(service.create('p1', {
      kind: 'notebook' as any, name: 'n', details: {},
    })).rejects.toMatchObject({ code: 'INVALID_RESOURCE_VALUE' });
    expect(mutations).toHaveLength(0);
  });
});
