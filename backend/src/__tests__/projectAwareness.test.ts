jest.mock('../db/connection', () => ({ pool: { query: jest.fn() } }));
jest.mock('../middleware/sharedAuthorization', () => ({
  filterAuthorizedResources: jest.fn(async (_req, _action, rows) => rows),
  authorizedListScope: jest.fn((_req, type) => ({
    id: 'allowed.id', from: type + ' allowed', render: () => ({ sql: 'allowed.visible = $2', params: [true] }),
  })),
}));
jest.mock('../services/ProjectService', () => ({ projectService: { getById: jest.fn() } }));
jest.mock('../services/ProjectResourceService', () => ({
  ...jest.requireActual('../services/ProjectResourceService'),
  projectResourceService: { awarenessContext: jest.fn() },
}));
jest.mock('../services/CharterService', () => ({ charterService: { find: jest.fn() } }));
jest.mock('../services/ReportVisibility', () => ({ filterVisibleReports: jest.fn(async (_req, rows) => rows) }));
import { pool } from '../db/connection';
import { filterAuthorizedResources } from '../middleware/sharedAuthorization';
import { projectService } from '../services/ProjectService';
import { projectResourceService } from '../services/ProjectResourceService';
import { charterService } from '../services/CharterService';
import { filterVisibleReports } from '../services/ReportVisibility';
import { projectAwarenessService, PROJECT_AWARENESS_LIMITS } from '../services/ProjectAwarenessService';
import type { AuthRequest } from '../middleware/auth';
const req = { scopes: ['projects:read', 'tasks:read', 'phases:read', 'reports:read'] } as AuthRequest;
const parsed = (brief: string) => JSON.parse(brief.slice(brief.indexOf('{'), brief.lastIndexOf('}') + 1));
beforeEach(() => {
  jest.clearAllMocks();
  (filterAuthorizedResources as jest.Mock).mockImplementation(async (_req, _action, rows) => rows);
  (filterVisibleReports as jest.Mock).mockImplementation(async (_req, rows) => rows.filter((row: any) => row.id !== 'concealed-promotion'));
  (projectService.getById as jest.Mock).mockResolvedValue({ id: 'p1', name: 'Project', description: 'Purpose', goal: 'Outcome', status: 'active', revision: 'rev' });
  (projectResourceService.awarenessContext as jest.Mock).mockResolvedValue({ resources: [{ id: 'resource1', kind: 'repository', name: 'Code', description: 'Main source repository', details: { url: 'https://example.com/repo' } }], availableTotal: 1 });
  (charterService.find as jest.Mock).mockResolvedValue({ content: 'Owner constraints', version: 2 });
  (pool.query as jest.Mock).mockImplementation(async (sql: string) => {
    if (sql.includes('awareness-task-counts')) return { rows: [{ status: 'completed', count: 10 }, { status: 'stuck', count: 2 }] };
    if (sql.includes('awareness-task-summaries')) return { rows: [{ id: 't1', title: 'Repair', status: 'stuck', description: 'Needs review' }] };
    if (sql.includes('awareness-phase-count')) return { rows: [{ count: 1 }] };
    if (sql.includes('awareness-phases')) return { rows: [{ id: 'ph1', name: 'Current', status: 'in-progress' }] };
    if (sql.includes('awareness-phase-progress')) return { rows: [{ phase_id: 'ph1', status: 'completed', count: 10 }] };
    if (sql.includes('awareness-reports')) return { rows: [{ id: 'r1', title: 'Decision', summary: 'Purpose snippet' }, { id: 'concealed-promotion', title: 'PRIVATE', auto_promoted: true, source_task_id: 'secret' }] };
    throw new Error('Unexpected query');
  });
});
test('orientation includes purpose, constraints, resource descriptions, visible progress and drilldown', async () => {
  const result = await projectAwarenessService.compile(req, 'p1');
  const data = parsed(result.brief);
  expect(data.project.purpose).toBe('Purpose');
  expect(data.constraints.excerpt).toBe('Owner constraints');
  expect(data.resources[0].description).toBe('Main source repository');
  expect(data.resources[0].read).toBe('GET /projects/p1/resources/resource1');
  expect(data.tasks.visibleTotal).toBe(12);
  expect(data.tasks.omittedVisibleUnfinished).toBe(1);
  expect(data.phases.entries[0].visibleTaskCounts).toEqual([{ status: 'completed', count: 10 }]);
  expect(data.reports.entries).toHaveLength(1);
  expect(result.brief).not.toContain('PRIVATE');
  expect(data.tasks.entries[0].brief).toBe('relayhall brief t1');
  expect(result.brief.length).toBeLessThanOrEqual(PROJECT_AWARENESS_LIMITS.briefCharacters);
  expect(result.tokenEstimate).toBe(Math.ceil(result.brief.length / 4));
  for (const [sql, params] of (pool.query as jest.Mock).mock.calls) {
    expect(sql).toContain('allowed.visible = $2');
    expect(params.slice(0, 2)).toEqual(['p1', true]);
    expect(sql).toContain('item.project_id = $1');
  }
});
test('missing optional scopes skip reads without disclosing counts', async () => {
  const result = await projectAwarenessService.compile({ scopes: ['projects:read', 'tasks:read'] } as AuthRequest, 'p1');
  const data = parsed(result.brief);
  expect(data.phases.visibleTotal).toBeNull();
  expect(data.reports.entries).toEqual([]);
  expect(filterVisibleReports).not.toHaveBeenCalled();
  expect((pool.query as jest.Mock).mock.calls).toHaveLength(2);
});
test('project denial and missing required scopes precede child reads', async () => {
  await expect(projectAwarenessService.compile({ scopes: ['tasks:read'] } as AuthRequest, 'p1')).rejects.toMatchObject({ status: 403 });
  expect(projectService.getById).not.toHaveBeenCalled();
  (filterAuthorizedResources as jest.Mock).mockResolvedValue([]);
  await expect(projectAwarenessService.compile(req, 'p1')).rejects.toMatchObject({ status: 404 });
  expect(pool.query).not.toHaveBeenCalled();
});
test('Charter failure refuses the entire brief', async () => {
  (charterService.find as jest.Mock).mockRejectedValueOnce(new Error('lookup failed'));
  await expect(projectAwarenessService.compile(req, 'p1')).rejects.toThrow('lookup failed');
  expect(pool.query).not.toHaveBeenCalled();
});
test('untrusted fences and long project text remain quoted and bounded', async () => {
  (projectService.getById as jest.Mock).mockResolvedValue({ id: 'p1', name: String.fromCharCode(96).repeat(3), description: 'A'.repeat(50000), status: 'active', revision: 'rev' });
  const result = await projectAwarenessService.compile(req, 'p1');
  expect(parsed(result.brief).project.purpose).toContain('[shortened;');
  expect(result.brief.length).toBeLessThanOrEqual(PROJECT_AWARENESS_LIMITS.briefCharacters);
  expect(result.brief).toContain(String.fromCharCode(96).repeat(4) + 'json');
});

test('token estimate uses the same Unicode scalar heuristic as the frontend', async () => {
  (projectService.getById as jest.Mock).mockResolvedValue({ id: 'p1', name: String.fromCodePoint(0x1F680).repeat(100), description: '', status: 'active', revision: 'rev' });
  const result = await projectAwarenessService.compile(req, 'p1');
  expect(result.tokenEstimate).toBe(Math.ceil(Array.from(result.brief).length / 4));
});

test('global budget drops entries with explicit visible omissions instead of cutting locators', async () => {
  (projectResourceService.awarenessContext as jest.Mock).mockResolvedValue({ resources: [
    { id: 'large', kind: 'reference', name: 'Large', description: '', details: { url: 'https://example.com/' + 'x'.repeat(50000) } },
  ], availableTotal: 1 });
  const result = await projectAwarenessService.compile(req, 'p1');
  const data = parsed(result.brief);
  expect(result.brief.length).toBeLessThanOrEqual(PROJECT_AWARENESS_LIMITS.briefCharacters);
  expect(data.resources).toEqual([]);
  expect(data.budgetOmissions.resources).toBe(1);
  expect(data.resourceOmissions.additionalAvailable).toBe(1);
  expect(result.brief).not.toContain('https://example.com');
});

// Card fbeb86f1 (owner ruling D6): the refusal keeps its status, code and text
// and now says which scope(s) as data (`details.requiredScopes` on the wire, via
// routes/projects.ts), so the MCP text names a scope the board stated rather
// than the tool's declared one.
describe('project awareness names the scopes it found missing', () => {
  const refusal = async (scopes: string[] | null): Promise<any> => {
    try {
      await projectAwarenessService.compile({ scopes } as unknown as AuthRequest, 'p1');
    } catch (error) {
      return error;
    }
    throw new Error('expected a refusal');
  };

  test('a credential with tasks:read only is told projects:read, and not what it holds', async () => {
    const error = await refusal(['tasks:read']);
    expect(error).toMatchObject({
      status: 403, code: 'INSUFFICIENT_SCOPE',
      message: 'Project awareness requires projects:read and tasks:read',
    });
    expect(error.requiredScopes).toEqual(['projects:read']);
  });

  test('a credential with projects:read only is told tasks:read', async () => {
    expect((await refusal(['projects:read', 'reports:read'])).requiredScopes).toEqual(['tasks:read']);
  });

  test('a credential with neither, or with no scope set at all, is told both', async () => {
    expect((await refusal(['principals:read'])).requiredScopes).toEqual(['projects:read', 'tasks:read']);
    expect((await refusal([])).requiredScopes).toEqual(['projects:read', 'tasks:read']);
    expect((await refusal(null)).requiredScopes).toEqual(['projects:read', 'tasks:read']);
  });

  test('never names a held scope, and reads nothing before refusing', async () => {
    const error = await refusal(['tasks:read', 'reports:read', 'phases:read']);
    expect(JSON.stringify(error.requiredScopes)).not.toMatch(/tasks:read|reports:read|phases:read/);
    expect(filterAuthorizedResources).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('root satisfies both, so no refusal and no scope is named', async () => {
    const result = await projectAwarenessService.compile({ scopes: ['root'] } as AuthRequest, 'p1');
    expect(result.scope).toBeDefined();
  });
});
