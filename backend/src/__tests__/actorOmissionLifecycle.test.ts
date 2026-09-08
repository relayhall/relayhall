import { TaskManagerDB } from '../services/TaskManagerDB';
import fs from 'fs';
import path from 'path';

const reviewer = { principalId: null, handle: 'reviewer-test', role: 'reviewer' };

function managerHarness() {
  const pool = {
    connect: jest.fn(async () => { throw new Error('DB_REACHED'); }),
  } as any;
  return { manager: new TaskManagerDB(pool), pool };
}

describe('completion actor omission fails closed before SQL', () => {
  test('createTask rejects an actorless completed subtask', async () => {
    const { manager, pool } = managerHarness();
    await expect(manager.createTask({ title: 'x', subtasks: [{ id: 's1', text: 's', status: 'completed' }] }, undefined, async () => null))
      .rejects.toThrow('independent Verifier');
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('createTask rejects an actorless completed parent', async () => {
    const { manager, pool } = managerHarness();
    await expect(manager.createTask({ title: 'x', status: 'completed', subtasks: [] }, undefined, async () => null))
      .rejects.toThrow('independent Verifier');
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('updateTask rejects actorless completed subtasks', async () => {
    const { manager, pool } = managerHarness();
    await expect(manager.updateTask('task-1', { subtasks: [{ id: 's1', text: 's', status: 'completed' }] }))
      .rejects.toThrow('independent Verifier');
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('updateTask and moveTask reject actorless parent completion', async () => {
    const first = managerHarness();
    await expect(first.manager.updateTask('task-1', { status: 'completed' }))
      .rejects.toThrow('independent Verifier');
    expect(first.pool.connect).not.toHaveBeenCalled();

    const second = managerHarness();
    await expect(second.manager.moveTask('task-1', 'completed'))
      .rejects.toThrow('independent Verifier');
    expect(second.pool.connect).not.toHaveBeenCalled();
  });

  test('an explicit Verifier identity reaches the SQL path', async () => {
    const { manager, pool } = managerHarness();
    await expect(manager.updateTask('task-1', { status: 'completed' }, reviewer))
      .rejects.toThrow('DB_REACHED');
    expect(pool.connect).toHaveBeenCalledTimes(1);
  });

  test('the production reviewer service passes an explicit internal Verifier actor', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/services/TaskReviewerService.ts'), 'utf8');
    expect(source).toContain("handle: 'task-reviewer-service'");
    expect(source).toContain("role: 'reviewer'");
    expect(source).toContain('updateTask(taskId, updates, INTERNAL_REVIEWER_ACTOR)');
  });
});
