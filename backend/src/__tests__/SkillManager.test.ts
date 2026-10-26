import { SkillManager, SkillContractError } from '../services/SkillManager';
import { pool } from '../db/connection';

const mockQuery = jest.fn();
jest.mock('../services/AuditService', () => ({ auditService: { record: jest.fn(async () => ({})) } }));
jest.mock('../db/connection', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args), connect: jest.fn() },
}));

describe('SkillManager immutable effective resolution', () => {
  beforeEach(() => mockQuery.mockReset());

  it('maps exact global/project selections with immutable provenance', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{
      id: 'version-1', skill_id: 'skill-1', name: 'task-management',
      category: 'workflow', description: 'Task management', skill_md: '---\nname: task-management\ndescription: Task management\n---\n\nUse the CLI.',
      is_global: true, project_pin: false, version: 3, content_sha256: 'abc',
      provenance: 'human-authored', status: 'published',
    }] });
    const result = await new SkillManager().getEffectiveSkillsForProject('project-1');
    expect(result).toEqual([expect.objectContaining({
      name: 'task-management', skill_version_id: 'version-1', version: 3,
      content_sha256: 'abc', provenance: 'human-authored', status: 'published',
      instructions: expect.stringContaining('Use the CLI.'), has_override: false,
    })]);
    expect(mockQuery.mock.calls[0][0]).toContain('project_skills');
    expect(mockQuery.mock.calls[0][0]).toContain('current_published_version_id');
  });

  it('returns an empty context when no global or exact Project pin resolves', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(new SkillManager().getEffectiveSkillsForProject('project-1')).resolves.toEqual([]);
  });
});

// Card f87776ad: provenance attests the creator Principal's kind. A mismatch is
// refused by name, on the write transaction, before any row is inserted.
describe('SkillManager provenance must match the creator kind', () => {
  const REVISION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  function client(kind: string | null) {
    const query = jest.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('FROM principals')) return { rows: kind ? [{ kind }] : [] };
      if (sql.includes('FROM skills WHERE id = $1 FOR UPDATE')) return { rows: [{ name: 'provenance-probe', revision: REVISION }] };
      return { rows: [] };
    });
    const release = jest.fn();
    (pool.connect as jest.Mock).mockResolvedValue({ query, release });
    return { query, release };
  }
  const statements = (query: jest.Mock) => query.mock.calls.map(call => String(call[0]));

  it.each([
    ['human', 'agent-drafted', ['human-authored', 'imported']],
    ['service', 'human-authored', ['agent-drafted', 'imported']],
    ['agent', 'human-authored', ['agent-drafted', 'imported']],
  ] as const)('refuses a %s creator recording %s, naming the field, before any insert', async (kind, provenance, allowed) => {
    for (const act of ['create', 'update'] as const) {
      const { query, release } = client(kind);
      const manager = new SkillManager();
      const attempt = act === 'create'
        ? manager.create({ name: 'provenance-probe', description: 'Probe', provenance }, 'principal-1')
        : manager.update('skill-1', { description: 'Probe', provenance }, REVISION, 'principal-1');
      const error = await attempt.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SkillContractError);
      expect(error).toMatchObject({
        status: 422, code: 'INVALID_SKILL_VALUE',
        details: { field: 'provenance', provenance, principalKind: kind, allowed: [...allowed] },
      });
      expect((error as Error).message).toContain(`provenance '${provenance}' cannot be recorded by a ${kind} Principal`);
      expect(statements(query).some(sql => sql.includes('INSERT INTO'))).toBe(false);
      expect(statements(query)).toContain('ROLLBACK');
      expect(release).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    ['human', 'human-authored'], ['human', 'imported'], ['service', 'agent-drafted'], ['agent', 'imported'],
  ] as const)('lets a %s creator record %s through to the insert', async (kind, provenance) => {
    const { query } = client(kind);
    const input = { name: 'provenance-probe', description: 'Probe', provenance,
      ...(provenance === 'imported' ? { source_uri: 'https://example.invalid/skill.md' } : {}) };
    await new SkillManager().create(input, 'principal-1').catch(() => undefined);
    const insert = query.mock.calls.find(call => String(call[0]).includes('INSERT INTO skill_versions'));
    expect(insert?.[1]).toEqual(expect.arrayContaining([provenance, 'principal-1']));
  });

  it('leaves an unknown creator to the database guard, as before', async () => {
    const { query } = client(null);
    await new SkillManager().create({ name: 'provenance-probe', description: 'Probe', provenance: 'agent-drafted' }, 'ghost')
      .catch(() => undefined);
    expect(statements(query).some(sql => sql.includes('INSERT INTO skill_versions'))).toBe(true);
  });
});
