const query = jest.fn();
const release = jest.fn();
const evaluate = jest.fn();

jest.mock('../db/connection', () => ({
  databasePoolConfig: {},
  pool: {
    connect: jest.fn(async () => ({ query, release })),
    query: jest.fn(),
  },
}));

jest.mock('../services/LifecyclePolicyService', () => {
  const actual = jest.requireActual('../services/LifecyclePolicyService');
  return {
    ...actual,
    lifecyclePolicyService: { evaluate },
  };
});

import { ProjectService } from '../services/ProjectService';
import { LifecyclePolicyDeniedError } from '../services/LifecyclePolicyService';

describe('governed mutation rollback', () => {
  beforeEach(() => {
    query.mockReset();
    release.mockReset();
    evaluate.mockReset();
  });

  it('rolls back the object transaction and never reaches the mutation after an enforced denial', async () => {
    const denied = new LifecyclePolicyDeniedError(
      'project.archive',
      { kind: 'project', id: '11111111-1111-4111-8111-111111111111', revision: '22222222-2222-4222-8222-222222222222' },
      ['change.freeze'],
      ['window.closed'],
      'Wait for the approved window',
    );
    query.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT * FROM projects')) {
        return {
          rows: [{
            id: '11111111-1111-4111-8111-111111111111',
            revision: '22222222-2222-4222-8222-222222222222',
            status: 'active',
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected SQL after denial: ${sql}`);
    });
    evaluate.mockRejectedValue(denied);

    await expect(new ProjectService().archive(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    )).rejects.toBe(denied);

    expect(evaluate).toHaveBeenCalledWith(expect.anything(), {
      action: 'project.archive',
      subject: {
        kind: 'project',
        id: '11111111-1111-4111-8111-111111111111',
        revision: '22222222-2222-4222-8222-222222222222',
      },
      current: { status: 'active' },
      proposed: { status: 'archived' },
    });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'SELECT * FROM projects WHERE id = $1 FOR UPDATE',
      'ROLLBACK',
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
