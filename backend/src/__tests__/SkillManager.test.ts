import { SkillManager } from '../services/SkillManager';

const mockQuery = jest.fn();
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
