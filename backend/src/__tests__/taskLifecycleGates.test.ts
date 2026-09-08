import * as fs from 'fs';
import * as path from 'path';
import { resolveCreateAutoStart, hasDefinitionOfDone, dodWarningForStatusChange } from '../utils/taskLifecycle';
import { TaskManagerDB } from '../services/TaskManagerDB';

jest.mock('../db/connection', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

describe('resolveCreateAutoStart (create-time lifecycle gate)', () => {
  test('defaults to false when not provided', () => {
    expect(resolveCreateAutoStart(undefined)).toBe(false);
    expect(resolveCreateAutoStart(null)).toBe(false);
  });

  test('only explicit true opts in', () => {
    expect(resolveCreateAutoStart(true)).toBe(true);
    expect(resolveCreateAutoStart('true')).toBe(true);
  });

  test('false, truthy junk and non-boolean values stay false', () => {
    expect(resolveCreateAutoStart(false)).toBe(false);
    expect(resolveCreateAutoStart('false')).toBe(false);
    expect(resolveCreateAutoStart(1)).toBe(false);
    expect(resolveCreateAutoStart('yes')).toBe(false);
    expect(resolveCreateAutoStart({})).toBe(false);
  });
});

describe('definition-of-done warning on ideas -> todo', () => {
  test('hasDefinitionOfDone detects meaningful values', () => {
    expect(hasDefinitionOfDone('ship it')).toBe(true);
    expect(hasDefinitionOfDone(['a', 'b'])).toBe(true);
    expect(hasDefinitionOfDone('')).toBe(false);
    expect(hasDefinitionOfDone('   ')).toBe(false);
    expect(hasDefinitionOfDone([])).toBe(false);
    expect(hasDefinitionOfDone(['', '  '])).toBe(false);
    expect(hasDefinitionOfDone(undefined)).toBe(false);
    expect(hasDefinitionOfDone(null)).toBe(false);
  });

  test('warns on ideas -> todo without DoD', () => {
    const warning = dodWarningForStatusChange('ideas', 'todo', undefined);
    expect(warning).toBeDefined();
    expect(warning).toContain('definitionOfDone');
  });

  test('does not warn when DoD present or transition differs', () => {
    expect(dodWarningForStatusChange('ideas', 'todo', ['done criteria'])).toBeUndefined();
    expect(dodWarningForStatusChange('ideas', 'todo', 'done when green')).toBeUndefined();
    expect(dodWarningForStatusChange('todo', 'in-progress', undefined)).toBeUndefined();
    expect(dodWarningForStatusChange('ideas', 'in-progress', undefined)).toBeUndefined();
    expect(dodWarningForStatusChange(undefined, 'todo', undefined)).toBeUndefined();
  });
});

describe('tasks route registration order (static routes before /:id)', () => {
  // Express matches routes in registration order. '/next', '/current' and
  // '/notifications' are reserved literal segments: if '/:id' is registered
  // first it swallows them and rejectInvalidTaskIdParam() replies
  // 400 INVALID_TASK_ID (the exact regression that broke `relayhall next`).
  // supertest is not available in this repo, so we assert on source order.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'tasks.ts'),
    'utf8'
  );

  const wildcardIndex = source.indexOf("router.get('/:id'");

  test.each(['/next', '/current', '/notifications'])(
    "GET '%s' is registered before GET '/:id'",
    (route) => {
      const literalIndex = source.indexOf(`router.get('${route}'`);
      expect(literalIndex).toBeGreaterThan(-1);
      expect(wildcardIndex).toBeGreaterThan(-1);
      expect(literalIndex).toBeLessThan(wildcardIndex);
    }
  );

  test("GET '/:id/timeline' remains after the literal routes", () => {
    const timelineIndex = source.indexOf("router.get('/:id/timeline'");
    expect(timelineIndex).toBeGreaterThan(source.indexOf("router.get('/next'"));
  });
});

describe('TaskManagerDB.getAutoStartQueue', () => {
  const makeTask = (over: Partial<any>): any => ({
    id: `${Math.random().toString(16).slice(2)}`,
    title: 'task',
    status: 'todo',
    priority: 'normal',
    autoStart: true,
    created: '2026-07-01T00:00:00.000Z',
    ...over,
  });

  let manager: TaskManagerDB;

  beforeEach(() => {
    manager = new TaskManagerDB();
  });

  test('queries only todo status and keeps only autoStart === true, unblocked tasks', async () => {
    const eligible = makeTask({ id: 'aaa', autoStart: true });
    const optedOut = makeTask({ id: 'bbb', autoStart: false });
    const legacyTruthy = makeTask({ id: 'ccc', autoStart: 1 }); // not strictly true
    const blocked = makeTask({ id: 'ddd', autoStart: true });

    const querySpy = jest
      .spyOn(manager, 'queryTasks')
      .mockResolvedValue([eligible, optedOut, legacyTruthy, blocked]);
    jest
      .spyOn(manager, 'isTaskBlocked')
      .mockImplementation(async (id: string) => id === 'ddd');

    const queue = await manager.getAutoStartQueue();

    expect(querySpy).toHaveBeenCalledWith({ status: 'todo' });
    expect(queue.map(t => t.id)).toEqual(['aaa']);
  });

  test('sorts by priority then creation time, and getNextTask returns the head', async () => {
    const older = makeTask({ id: 'old-normal', priority: 'normal', created: '2026-06-01T00:00:00.000Z' });
    const newer = makeTask({ id: 'new-normal', priority: 'normal', created: '2026-06-20T00:00:00.000Z' });
    const urgent = makeTask({ id: 'urgent', priority: 'urgent', created: '2026-06-30T00:00:00.000Z' });

    jest.spyOn(manager, 'queryTasks').mockResolvedValue([newer, older, urgent]);
    jest.spyOn(manager, 'isTaskBlocked').mockResolvedValue(false);

    const queue = await manager.getAutoStartQueue();
    expect(queue.map(t => t.id)).toEqual(['urgent', 'old-normal', 'new-normal']);

    const next = await manager.getNextTask();
    expect(next?.id).toBe('urgent');
  });

  test('returns empty queue / null next when nothing is eligible', async () => {
    jest.spyOn(manager, 'queryTasks').mockResolvedValue([
      makeTask({ autoStart: false }),
    ]);
    jest.spyOn(manager, 'isTaskBlocked').mockResolvedValue(false);

    expect(await manager.getAutoStartQueue()).toEqual([]);
    expect(await manager.getNextTask()).toBeNull();
  });
});
