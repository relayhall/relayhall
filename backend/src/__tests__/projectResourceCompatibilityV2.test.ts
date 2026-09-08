const queryMock = jest.fn();

jest.mock('../db/connection', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));

import { ProjectResourceService } from '../services/ProjectResourceService';

describe('ProjectResourceService compatibility v2 accounting', () => {
  beforeEach(() => queryMock.mockReset());

  it('counts only unsuperseded provenance while retaining the v2 receipt version', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: '11111111-1111-4111-8111-111111111111' }] })
      .mockResolvedValueOnce({
        rows: [
          { source_surface: 'projects.resources', disposition: 'mapped', count: 2 },
          { source_surface: 'projects.resources', disposition: 'held', count: 4 },
          { source_surface: 'project_links', disposition: 'held', count: 1 },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ version: 2 }] });

    const service = new ProjectResourceService();
    await expect(service.compatibility('11111111-1111-4111-8111-111111111111')).resolves.toEqual({
      mapped: 2,
      held: 5,
      bySurface: {
        'projects.resources': { mapped: 2, held: 4 },
        project_links: { mapped: 0, held: 1 },
      },
      migrationVersion: 2,
    });

    expect(queryMock.mock.calls[1][0]).toContain('superseded_by_migration_version IS NULL');
    expect(queryMock.mock.calls[2][0]).toContain('project_resource_migration_runs');
    expect(queryMock.mock.calls[2][0]).toContain('MAX(migration_version)');
  });

  it('reports a v2 receipt even when the repair had no delta items', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: '22222222-2222-4222-8222-222222222222' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ version: 2 }] });

    const service = new ProjectResourceService();
    await expect(service.compatibility('22222222-2222-4222-8222-222222222222')).resolves.toEqual({
      mapped: 0,
      held: 0,
      bySurface: {},
      migrationVersion: 2,
    });
  });
});
