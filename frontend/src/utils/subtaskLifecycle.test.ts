import { describe, expect, test } from 'vitest';
import { buildSubtaskLifecycleRequest } from './subtaskLifecycle';

const base = '/api';
const task = 'task-id';

describe('buildSubtaskLifecycleRequest', () => {
  test('routes implementation transitions through the dedicated status endpoint', () => {
    expect(buildSubtaskLifecycleRequest(base, task, 2, 'empty', 'in-progress')).toEqual({
      path: '/api/tasks/task-id/subtasks/2/status',
      method: 'PATCH',
      body: { status: 'in-progress', reviewNote: undefined, blockedReason: undefined },
    });
    expect(buildSubtaskLifecycleRequest(base, task, 2, 'in-progress', 'review')).toEqual({
      path: '/api/tasks/task-id/subtasks/2/status',
      method: 'PATCH',
      body: { status: 'review', reviewNote: undefined, blockedReason: undefined },
    });
  });

  test('routes Verifier approval through the canonical approve endpoint', () => {
    expect(buildSubtaskLifecycleRequest(base, task, 0, 'review', 'completed')).toEqual({
      path: '/api/tasks/task-id/subtasks/0/approve',
      method: 'POST',
      body: {},
    });
  });

  test('routes rejection with a visible review note', () => {
    expect(buildSubtaskLifecycleRequest(base, task, 1, 'review', 'empty', { reviewNote: 'Needs more proof' })).toEqual({
      path: '/api/tasks/task-id/subtasks/1/reject',
      method: 'POST',
      body: { note: 'Needs more proof' },
    });
  });

  test('routes stuck and skip through their canonical endpoints', () => {
    expect(buildSubtaskLifecycleRequest(base, task, 3, 'in-progress', 'stuck', { blockedReason: 'Waiting for hardware' })).toEqual({
      path: '/api/tasks/task-id/subtasks/3/status',
      method: 'PATCH',
      body: { status: 'stuck', reviewNote: undefined, blockedReason: 'Waiting for hardware' },
    });
    expect(buildSubtaskLifecycleRequest(base, task, 3, 'stuck', 'skipped')).toEqual({
      path: '/api/tasks/task-id/subtasks/3/skip',
      method: 'POST',
      body: {},
    });
  });

  test('rejects an invalid subtask index before issuing a request', () => {
    expect(() => buildSubtaskLifecycleRequest(base, task, -1, 'empty', 'in-progress')).toThrow(/valid subtask index/i);
  });
});
