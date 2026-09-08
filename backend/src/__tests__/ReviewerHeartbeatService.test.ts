import type { Task } from '../services/TaskManagerDB';
import { ReviewerHeartbeatService } from '../services/ReviewerHeartbeatService';
import { TaskReviewerService, type ReviewerDependencies } from '../services/TaskReviewerService';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'heartbeat-task-1',
    title: 'Heartbeat Verifier task',
    description: 'Run automated Verifier from heartbeat',
    status: 'review',
    priority: 'normal',
    subtasks: [{ id: 'sub-1', text: 'Ship feature', status: 'review' }],
    links: [],
    sessionRefs: ['sess-1'],
    autoCreated: false,
    autoStart: true,
    blockedBy: [],
    tags: ['qa'],
    created: '2026-04-21T10:00:00.000Z',
    updated: '2026-04-21T10:00:00.000Z',
    attemptCount: 0,
    successCriteria: ['All checks pass'],
    ...overrides,
  };
}

function createTaskStore(initialTask: Task) {
  let task = { ...initialTask } as Task;
  const reports: Array<{ id: string; title: string; summary: string | null; content: string }> = [
    {
      id: 'report-1',
      title: 'DEV proof',
      summary: 'vitest passed',
      content: 'vitest passed\nreview evidence attached',
    },
  ];

  const deps: ReviewerDependencies = {
    getTask: jest.fn(async (taskId: string) => (taskId === task.id ? task : undefined)),
    updateTask: jest.fn(async (_taskId: string, updates: Partial<Task>) => {
      task = {
        ...task,
        ...updates,
        reviewHistory: updates.reviewHistory as any,
      } as Task;
      if (!updates.updated) {
        task.updated = new Date(new Date(task.updated).getTime() + 1000).toISOString();
      }
      return task;
    }),
    getReportsForTask: jest.fn(async () => reports),
    notifyEscalation: jest.fn(async () => undefined),
  };

  return {
    deps,
    getTask: () => task,
    setTask: (nextTask: Task) => {
      task = nextTask;
    },
  };
}

describe('ReviewerHeartbeatService', () => {
  test('runs the automated Verifier once per fingerprint and skips duplicate polls', async () => {
    const reviewTask = makeTask();
    const runReview = jest.fn(async () => ({ decision: 'pass' as const }));
    const state = { tasks: {}, updatedAt: new Date('2026-04-21T10:00:00.000Z').toISOString() };
    const heartbeat = new ReviewerHeartbeatService(1000, {
      listReviewTasks: jest.fn(async () => [reviewTask]),
      runReview,
      readState: jest.fn(async () => state),
      writeState: jest.fn(async (nextState: typeof state) => {
        Object.assign(state, nextState);
      }),
    });

    await heartbeat.tick();
    await heartbeat.tick();

    expect(runReview).toHaveBeenCalledTimes(1);
    expect(Object.keys(state.tasks)).toContain(reviewTask.id);
  });

  test('provides an end-to-end reject then pass cycle for review tasks', async () => {
    const store = createTaskStore(makeTask({
      subtasks: [{ id: 'sub-1', text: 'Ship feature', status: 'in-progress' }],
      successCriteria: ['All subtasks reviewed'],
    }));
    const reviewer = new TaskReviewerService(store.deps);
    const state = { tasks: {}, updatedAt: new Date('2026-04-21T10:00:00.000Z').toISOString() };
    const heartbeat = new ReviewerHeartbeatService(1000, {
      listReviewTasks: jest.fn(async () => (store.getTask().status === 'review' ? [store.getTask()] : [])),
      runReview: (taskId: string) => reviewer.runReview(taskId, { triggeredBy: 'system' }),
      readState: jest.fn(async () => state),
      writeState: jest.fn(async (nextState: typeof state) => {
        Object.assign(state, nextState);
      }),
    });

    await heartbeat.tick();
    expect(store.getTask().status).toBe('todo');
    expect(store.getTask().attemptCount).toBe(1);
    expect(store.getTask().reviewHistory?.[0]?.decision).toBe('reject');

    store.setTask({
      ...store.getTask(),
      status: 'review',
      subtasks: [{ id: 'sub-1', text: 'Ship feature', status: 'review' }],
      updated: '2026-04-21T10:05:00.000Z',
    });

    await heartbeat.tick();
    expect(store.getTask().status).toBe('completed');
    expect(store.getTask().subtasks?.[0]?.status).toBe('completed');
    expect(store.getTask().attemptCount).toBe(1);
    expect(store.getTask().reviewHistory?.map((entry) => entry.decision)).toEqual(['reject', 'pass']);
  });

  test('escalates after retry budget exhaustion and marks the task for human review', async () => {
    const store = createTaskStore(makeTask({
      subtasks: [{ id: 'sub-1', text: 'Ship feature', status: 'in-progress' }],
      successCriteria: ['All subtasks reviewed'],
      attemptCount: 1,
      maxRetries: 2,
    }));
    const reviewer = new TaskReviewerService(store.deps);
    const heartbeat = new ReviewerHeartbeatService(1000, {
      listReviewTasks: jest.fn(async () => [store.getTask()]),
      runReview: (taskId: string) => reviewer.runReview(taskId, { triggeredBy: 'system' }),
      readState: jest.fn(async () => ({ tasks: {}, updatedAt: new Date().toISOString() })),
      writeState: jest.fn(async () => undefined),
    });

    await heartbeat.tick();

    expect(store.getTask().status).toBe('stuck');
    expect(store.getTask().needsReview).toBe(true);
    expect(store.getTask().reviewHistory?.[store.getTask().reviewHistory!.length - 1]?.decision).toBe('escalate');
  });
});
