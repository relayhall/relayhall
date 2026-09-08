/**
 * ProjectResourceService transaction semantics (task 47ef04a2).
 *
 * The flagship regression here is review 20f6068c blocker 1: the atomic
 * kind-replacement transaction must enforce the archived-Project gate
 * BEFORE the idempotency-replay lookup, so a replacement committed while
 * the Project was active can never be replayed successfully after the
 * Project is archived — and no mutation of any kind may occur on that path.
 *
 * The fake pool below simulates the exact statements the service issues and
 * records every mutating statement so the no-mutation claims are assertions,
 * not hopes.
 */

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import { pool } from '../db/connection';
import {
  ProjectResourceService,
  ResourceContractError,
} from '../services/ProjectResourceService';

const PROJECT_ID = '47ef04a2-0000-4000-8000-000000000001';
const RESOURCE_ID = '47ef04a2-0000-4000-8000-000000000002';
const REVISION = '47ef04a2-0000-4000-8000-00000000rev1';

interface FakeState {
  projectStatus: string;
  resources: Map<string, any>;
  replacements: Map<string, any>;
  mutations: string[];
  txDepth: number;
}

function makeResourceRow(overrides: Record<string, any> = {}): any {
  return {
    id: RESOURCE_ID,
    project_id: PROJECT_ID,
    kind: 'reference',
    name: 'docs',
    normalized_name: 'docs',
    description: null,
    state: 'active',
    agent_visibility: 'hidden',
    export_policy: 'installation-only',
    details: { url: 'https://example.test/docs', category: 'documentation' },
    revision: REVISION,
    migration_provenance: null,
    archived_at: null,
    created_at: '2026-08-08T00:00:00Z',
    updated_at: '2026-08-08T00:00:00Z',
    ...overrides,
  };
}

function makeFakeDb(initial: Partial<FakeState> = {}): FakeState {
  const state: FakeState = {
    projectStatus: 'active',
    resources: new Map([[RESOURCE_ID, makeResourceRow()]]),
    replacements: new Map(),
    mutations: [],
    txDepth: 0,
    ...initial,
  };

  const query = async (text: string, params: any[] = []): Promise<any> => {
    const sql = text.replace(/\s+/g, ' ').trim();

    if (sql === 'BEGIN') { state.txDepth += 1; return { rows: [] }; }
    if (sql === 'COMMIT' || sql === 'ROLLBACK') { state.txDepth -= 1; return { rows: [] }; }

    if (sql.startsWith('SELECT id, status FROM projects')) {
      return { rows: [{ id: PROJECT_ID, status: state.projectStatus }] };
    }
    if (sql.startsWith('SELECT id, name, status FROM projects')) {
      return { rows: [{ id: PROJECT_ID, name: 'Fixture', status: state.projectStatus }] };
    }
    if (sql.startsWith('SELECT id FROM projects')) {
      return { rows: [{ id: PROJECT_ID }] };
    }
    if (sql.startsWith('SELECT * FROM project_resource_replacements')) {
      const [caller, projectId, key] = params;
      const record = state.replacements.get(`${caller}:${projectId}:${key}`);
      return { rows: record ? [record] : [] };
    }
    if (sql.startsWith('SELECT * FROM project_resources WHERE id = $1 AND project_id = $2')) {
      const row = state.resources.get(params[0]);
      return { rows: row && row.project_id === params[1] ? [row] : [] };
    }
    if (sql.startsWith('SELECT * FROM project_resources WHERE id = ANY($1)')) {
      const rows = (params[0] as string[])
        .map((id) => state.resources.get(id))
        .filter((r) => r && r.project_id === params[1]);
      return { rows };
    }
    if (sql.startsWith('SELECT * FROM project_resources WHERE project_id = $1')) {
      return { rows: Array.from(state.resources.values()).filter((r) => r.project_id === params[0]) };
    }
    if (sql.startsWith(`UPDATE project_resources SET state = 'archived'`)) {
      state.mutations.push('archive-resource');
      const row = state.resources.get(params[0]);
      if (!row) return { rows: [] };
      const updated = { ...row, state: 'archived', archived_at: '2026-08-08T01:00:00Z', revision: `rev-${state.mutations.length}` };
      state.resources.set(row.id, updated);
      return { rows: [updated] };
    }
    if (sql.startsWith(`UPDATE project_resources SET state = 'active'`)) {
      state.mutations.push('restore-resource');
      const row = state.resources.get(params[0]);
      if (!row) return { rows: [] };
      const updated = { ...row, state: 'active', archived_at: null, revision: `rev-${state.mutations.length}` };
      state.resources.set(row.id, updated);
      return { rows: [updated] };
    }
    if (sql.startsWith('UPDATE project_resources SET name =')) {
      state.mutations.push('patch-resource');
      const row = state.resources.get(params[6]);
      if (!row) return { rows: [] };
      const updated = {
        ...row,
        name: params[0], normalized_name: params[1], description: params[2],
        agent_visibility: params[3], export_policy: params[4],
        details: JSON.parse(params[5]), revision: `rev-${state.mutations.length}`,
      };
      state.resources.set(row.id, updated);
      return { rows: [updated] };
    }
    if (sql.startsWith('INSERT INTO project_resources')) {
      state.mutations.push('insert-resource');
      const row = makeResourceRow({
        id: params[0], project_id: params[1], kind: params[2], name: params[3],
        normalized_name: params[4], description: params[5], agent_visibility: params[6],
        export_policy: params[7], details: JSON.parse(params[8]), revision: `rev-${state.mutations.length}`,
      });
      state.resources.set(row.id, row);
      return { rows: [row] };
    }
    if (sql.startsWith('INSERT INTO project_resource_replacements')) {
      state.mutations.push('insert-replacement-record');
      const [caller, projectId, key, requestHash, replacedId, replacementId, snapshot, requestId] = params;
      state.replacements.set(`${caller}:${projectId}:${key}`, {
        caller, project_id: projectId, idempotency_key: key, request_hash: requestHash,
        replaced_resource_id: replacedId, replacement_resource_id: replacementId,
        response_snapshot: snapshot, request_id: requestId,
      });
      return { rows: [] };
    }
    throw new Error(`fake db has no handler for: ${sql.slice(0, 100)}`);
  };

  (pool.query as jest.Mock).mockImplementation(query);
  (pool.connect as jest.Mock).mockResolvedValue({ query, release: jest.fn() });
  return state;
}

const service = new ProjectResourceService();
const IDEMPOTENCY_KEY = 'replace-key-0123456789abcdef'; // gitleaks:allow — synthetic idempotency fixture
const CALLER = 'principal-a';

const replacementInput = {
  kind: 'environment' as const,
  name: 'docs',
  details: { url: 'https://env.example.test', stage: 'development' },
};

async function expectContractError(promise: Promise<unknown>, code: string, status?: number): Promise<ResourceContractError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(ResourceContractError);
    const contractError = e as ResourceContractError;
    expect(contractError.code).toBe(code);
    if (status !== undefined) expect(contractError.status).toBe(status);
    return contractError;
  }
  throw new Error(`expected ${code} but the call succeeded`);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('replace — the archived-Project gate precedes idempotency replay (20f6068c #1)', () => {
  it('commits a replacement while the Project is active, then refuses the SAME-KEY replay after archive with PROJECT_ARCHIVED and zero mutation', async () => {
    const state = makeFakeDb();

    const first = await service.replace(PROJECT_ID, RESOURCE_ID, REVISION, IDEMPOTENCY_KEY, CALLER, replacementInput);
    expect(first.replacement.kind).toBe('environment');
    expect(first.replaced.state).toBe('archived');
    const mutationsAfterCommit = state.mutations.length;
    expect(mutationsAfterCommit).toBeGreaterThan(0);

    // The Project is archived AFTER the successful replacement.
    state.projectStatus = 'archived';

    const replayError = await expectContractError(
      service.replace(PROJECT_ID, RESOURCE_ID, REVISION, IDEMPOTENCY_KEY, CALLER, replacementInput),
      'PROJECT_ARCHIVED', 409,
    );
    expect(replayError.status).toBe(409);
    // No mutation of any kind happened on the refused replay path.
    expect(state.mutations.length).toBe(mutationsAfterCommit);
    expect(state.txDepth).toBe(0);
  });

  it('refuses a FRESH replace against an archived Project before touching the idempotency store', async () => {
    const state = makeFakeDb({ projectStatus: 'archived' });
    await expectContractError(
      service.replace(PROJECT_ID, RESOURCE_ID, REVISION, 'fresh-key-0123456789abcdef', CALLER, replacementInput),
      'PROJECT_ARCHIVED', 409,
    );
    expect(state.mutations).toHaveLength(0);
  });

  it('replays the original committed pair for the same caller/key/request while the Project remains active', async () => {
    const state = makeFakeDb();
    const first = await service.replace(PROJECT_ID, RESOURCE_ID, REVISION, IDEMPOTENCY_KEY, CALLER, replacementInput);
    const mutationsAfterCommit = state.mutations.length;

    const replay = await service.replace(PROJECT_ID, RESOURCE_ID, REVISION, IDEMPOTENCY_KEY, CALLER, replacementInput);
    expect(replay.requestId).toBe(first.requestId);
    expect(replay.replacement.id).toBe(first.replacement.id);
    expect(replay.replaced.id).toBe(first.replaced.id);
    // Replay created and archived nothing again.
    expect(state.mutations.length).toBe(mutationsAfterCommit);
  });

  it('replays for reordered keys and explicit values equivalent to materialised defaults', async () => {
    const state = makeFakeDb();
    const first = await service.replace(
      PROJECT_ID,
      RESOURCE_ID,
      REVISION,
      IDEMPOTENCY_KEY,
      CALLER,
      replacementInput,
    );
    const mutationsAfterCommit = state.mutations.length;

    const replay = await service.replace(
      PROJECT_ID,
      RESOURCE_ID,
      REVISION,
      IDEMPOTENCY_KEY,
      CALLER,
      {
        details: { stage: 'development', url: 'https://env.example.test' },
        exportPolicy: 'installation-only',
        agentVisibility: 'hidden',
        description: '',
        name: 'docs',
        kind: 'environment',
      },
    );

    expect(replay.requestId).toBe(first.requestId);
    expect(replay.replacement.id).toBe(first.replacement.id);
    expect(replay.replaced.id).toBe(first.replaced.id);
    expect(state.mutations.length).toBe(mutationsAfterCommit);
  });

  it('validates a reused-key request before comparing its canonical hash', async () => {
    const state = makeFakeDb();
    await service.replace(PROJECT_ID, RESOURCE_ID, REVISION, IDEMPOTENCY_KEY, CALLER, replacementInput);
    const mutationsAfterCommit = state.mutations.length;

    await expectContractError(
      service.replace(PROJECT_ID, RESOURCE_ID, REVISION, IDEMPOTENCY_KEY, CALLER, {
        ...replacementInput,
        details: { url: 'https://env.example.test', stage: 'not-a-stage' },
      }),
      'INVALID_RESOURCE_VALUE', 422,
    );
    expect(state.mutations.length).toBe(mutationsAfterCommit);
  });

  it('rejects reuse of the key with a different canonical request without mutation', async () => {
    const state = makeFakeDb();
    await service.replace(PROJECT_ID, RESOURCE_ID, REVISION, IDEMPOTENCY_KEY, CALLER, replacementInput);
    const mutationsAfterCommit = state.mutations.length;

    await expectContractError(
      service.replace(PROJECT_ID, RESOURCE_ID, REVISION, IDEMPOTENCY_KEY, CALLER, {
        ...replacementInput,
        name: 'different-name',
      }),
      'IDEMPOTENCY_KEY_REUSED', 409,
    );
    expect(state.mutations.length).toBe(mutationsAfterCommit);
  });

  it('replays the ORIGINAL committed pair even after the replacement row was later mutated (666f69f2 #1)', async () => {
    const state = makeFakeDb();
    const first = await service.replace(PROJECT_ID, RESOURCE_ID, REVISION, IDEMPOTENCY_KEY, CALLER, replacementInput);

    // Mutate the replacement row after commit (as a later PATCH would).
    const replacementRow = state.resources.get(first.replacement.id)!;
    state.resources.set(first.replacement.id, { ...replacementRow, name: 'mutated-later', revision: 'rev-later' });

    const replay = await service.replace(PROJECT_ID, RESOURCE_ID, REVISION, IDEMPOTENCY_KEY, CALLER, replacementInput);
    expect(replay.requestId).toBe(first.requestId);
    // The replay is the immutable snapshot, not the mutated current row.
    expect(replay.replacement.name).toBe(first.replacement.name);
    expect(replay.replacement.revision).toBe(first.replacement.revision);
  });

  it('conceals a foreign resource id under an ARCHIVED project as 404, before any lifecycle disclosure (666f69f2 #2)', async () => {
    const state = makeFakeDb({ projectStatus: 'archived' });
    const foreignId = '47ef04a2-0000-4000-8000-0000000ff0f0';
    await expectContractError(
      service.replace(PROJECT_ID, foreignId, REVISION, 'conceal-key-0123456789abc', CALLER, replacementInput),
      'RESOURCE_NOT_FOUND', 404,
    );
    await expectContractError(service.patch(PROJECT_ID, foreignId, REVISION, { name: 'x' }), 'RESOURCE_NOT_FOUND', 404);
    await expectContractError(service.archive(PROJECT_ID, foreignId, REVISION), 'RESOURCE_NOT_FOUND', 404);
    await expectContractError(service.restore(PROJECT_ID, foreignId, REVISION), 'RESOURCE_NOT_FOUND', 404);
    expect(state.mutations).toHaveLength(0);
  });

  it('requires a bounded idempotency key', async () => {
    makeFakeDb();
    await expectContractError(
      service.replace(PROJECT_ID, RESOURCE_ID, REVISION, 'short', CALLER, replacementInput),
      'IDEMPOTENCY_KEY_REQUIRED', 400,
    );
  });

  it('rejects a same-kind replacement', async () => {
    const state = makeFakeDb();
    await expectContractError(
      service.replace(PROJECT_ID, RESOURCE_ID, REVISION, IDEMPOTENCY_KEY, CALLER, {
        kind: 'reference',
        name: 'docs',
        details: { url: 'https://example.test/docs', category: 'documentation' },
      }),
      'RESOURCE_REPLACEMENT_KIND_UNCHANGED', 409,
    );
    expect(state.mutations).toHaveLength(0);
  });

  it('rejects a stale revision without mutation', async () => {
    const state = makeFakeDb();
    await expectContractError(
      service.replace(PROJECT_ID, RESOURCE_ID, 'stale-revision', IDEMPOTENCY_KEY, CALLER, replacementInput),
      'REVISION_MISMATCH', 412,
    );
    expect(state.mutations).toHaveLength(0);
  });
});

describe('mutations against an archived Project fail with PROJECT_ARCHIVED', () => {
  const cases: Array<[string, () => Promise<unknown>]> = [
    ['create', () => service.create(PROJECT_ID, {
      kind: 'reference', name: 'x', details: { url: 'https://example.test', category: 'other' },
    })],
    ['patch', () => service.patch(PROJECT_ID, RESOURCE_ID, REVISION, { name: 'y' })],
    ['archive', () => service.archive(PROJECT_ID, RESOURCE_ID, REVISION)],
    ['restore', () => service.restore(PROJECT_ID, RESOURCE_ID, REVISION)],
  ];
  for (const [label, run] of cases) {
    it(`${label} -> PROJECT_ARCHIVED, no mutation`, async () => {
      const state = makeFakeDb({ projectStatus: 'archived' });
      await expectContractError(run(), 'PROJECT_ARCHIVED', 409);
      expect(state.mutations).toHaveLength(0);
    });
  }
});

describe('revision binding on ordinary mutations', () => {
  it('patch rejects a stale revision', async () => {
    const state = makeFakeDb();
    await expectContractError(service.patch(PROJECT_ID, RESOURCE_ID, 'nope', { name: 'z' }), 'REVISION_MISMATCH', 412);
    expect(state.mutations).toHaveLength(0);
  });

  it('patch requires a revision', async () => {
    makeFakeDb();
    await expectContractError(service.patch(PROJECT_ID, RESOURCE_ID, '', { name: 'z' }), 'REVISION_REQUIRED', 400);
  });

  it('archive is an idempotent no-op only under the matching revision', async () => {
    const state = makeFakeDb();
    const archived = await service.archive(PROJECT_ID, RESOURCE_ID, REVISION);
    expect(archived.state).toBe('archived');
    const mutationsAfter = state.mutations.length;

    // Same call with the OLD revision is now stale, not a silent no-op.
    await expectContractError(service.archive(PROJECT_ID, RESOURCE_ID, REVISION), 'REVISION_MISMATCH', 412);
    // With the fresh revision it is an idempotent no-op.
    const fresh = state.resources.get(RESOURCE_ID)!;
    const again = await service.archive(PROJECT_ID, RESOURCE_ID, fresh.revision);
    expect(again.state).toBe('archived');
    expect(state.mutations.length).toBe(mutationsAfter);
  });
});

describe('child binding conceals cross-project resources', () => {
  it('a resource under a different project is RESOURCE_NOT_FOUND', async () => {
    const state = makeFakeDb();
    const foreign = makeResourceRow({ id: '47ef04a2-0000-4000-8000-00000000f0f0', project_id: '47ef04a2-9999-4999-8999-999999999999' });
    state.resources.set(foreign.id, foreign);
    await expectContractError(service.patch(PROJECT_ID, foreign.id, REVISION, { name: 'x' }), 'RESOURCE_NOT_FOUND', 404);
    expect(state.mutations).toHaveLength(0);
  });
});
