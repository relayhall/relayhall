import { TaskManagerDB } from '../services/TaskManagerDB';

const mockQuery = jest.fn();

jest.mock('../db/connection', () => ({
  pool: {
    query: (...args: any[]) => mockQuery(...args),
    connect: jest.fn(),
  },
}));

const baseRow = {
  id: '1ad5375c-2f1d-4768-a71c-864f6edfeee7',
  title: 'Dependency picker fix',
  description: 'Fix dependency search',
  status: 'todo',
  priority: 'high',
  project_id: null,
  thinking_budget: 'high',
  thinking_auto_estimated: false,
  model: null,
  execution_mode: 'interactive',
  auto_created: false,
  auto_start: true,
  blocked_reason: null,
  status_reason: null,
  active_agent: null,
  completed_by: null,
  attempt_count: 0,
  session_refs: [],
  parent_id: null,
  personality_id: null,
  created_at: '2026-04-10T00:00:00.000Z',
  updated_at: '2026-04-10T00:00:00.000Z',
  started_at: null,
  completed_at: null,
  archived_at: null,
  at_slug: null,
  at_name: null,
  at_color: null,
  at_category: null,
};

describe('dependency search ordering', () => {
  let taskManager: TaskManagerDB;

  beforeEach(() => {
    taskManager = new TaskManagerDB();
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [baseRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
  });

  test('adds exact id and title ranking branches to the SQL order clause', async () => {
    await taskManager.queryTasks({ q: 'Dependency picker fix', limit: 10 });

    const [query] = mockQuery.mock.calls[0];
    expect(query).toContain('ORDER BY');
    expect(query).toContain('LOWER(t.id::text) =');
    expect(query).toContain('REPLACE(LOWER(t.id::text), \'-\', \'\') =');
    expect(query).toContain('LEFT(REPLACE(LOWER(t.id::text), \'-\', \'\'), 8) =');
    expect(query).toContain('LOWER(t.title) =');
    expect(query).toContain('LOWER(t.title) LIKE');
    expect(query).toContain('LOWER(COALESCE(p.name, \'\')) LIKE');
  });
});
