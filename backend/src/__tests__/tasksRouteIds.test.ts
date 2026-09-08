import { rejectInvalidTaskIdParam } from '../utils/taskIds';

describe('tasks route id validation', () => {
  function makeResponse() {
    const res: any = {
      status: jest.fn(function status() { return res; }),
      json: jest.fn(function json() { return res; }),
    };
    return res;
  }

  test('rejects short id prefixes with a 400 json error before hitting the database', () => {
    const res = makeResponse();

    const rejected = rejectInvalidTaskIdParam('589206ec', res);

    expect(rejected).toBe(true);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Invalid task id',
      code: 'INVALID_TASK_ID',
    });
  });

  test('rejects malformed task ids with a 400 json error', () => {
    const res = makeResponse();

    const rejected = rejectInvalidTaskIdParam('not-a-valid-id', res);

    expect(rejected).toBe(true);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Invalid task id',
      code: 'INVALID_TASK_ID',
    });
  });

  test('accepts full UUID task ids', () => {
    const res = makeResponse();

    const rejected = rejectInvalidTaskIdParam('98481dc1-38e0-408f-a7b9-1b8b45f18558', res);

    expect(rejected).toBe(false);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});
