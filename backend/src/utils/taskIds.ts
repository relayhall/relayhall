import { Response } from 'express';

const TASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidTaskId(id: string): boolean {
  return TASK_ID_RE.test(id);
}

export function rejectInvalidTaskIdParam(id: string, res: Response): boolean {
  if (isValidTaskId(id)) {
    return false;
  }

  res.status(400).json({
    success: false,
    error: 'Invalid task id',
    code: 'INVALID_TASK_ID',
  });
  return true;
}
