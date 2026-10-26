import { Request, Response, NextFunction } from 'express';
import { isFullUuid } from '../middleware/validate';

const TASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidTaskId(id: string): boolean {
  return TASK_ID_RE.test(id);
}

function sendInvalidTaskId(res: Response): void {
  res.status(400).json({
    success: false,
    error: 'Invalid task id',
    code: 'INVALID_TASK_ID',
  });
}

export function rejectInvalidTaskIdParam(id: string, res: Response): boolean {
  if (isValidTaskId(id)) {
    return false;
  }

  sendInvalidTaskId(res);
  return true;
}

/**
 * Card bc847bd0: the Task router's `router.param` guard for every path Task
 * id. The authorization stage resolves a Task id PREFIX, so an 8-character
 * prefix of a readable Task passed it and reached the handlers that do not
 * call `rejectInvalidTaskIdParam` - about twenty of them, which read it as a
 * uuid and answered 500 or 503, and `POST /tasks/:id/brief` never answered.
 * The guard refuses anything that is not a full UUID, with the family's
 * existing refusal, before any handler runs. It is the loose UUID shape (any
 * version, any variant): a handler that already applies the strict one keeps
 * doing so, so no UUID that answered before answers differently now.
 */
export function taskIdParam(_req: Request, res: Response, next: NextFunction, id: string): void {
  if (!isFullUuid(id)) {
    sendInvalidTaskId(res);
    return;
  }
  next();
}

/** Stable Subtask ids use PostgreSQL integer storage. Keep the existing unsigned
 * decimal spelling (including zero and leading zeros); unknown in-range values
 * are still resolved as 404, rather than inventing a positive-id constraint.
 * The same pattern is published by MCP and used before any mutation query.
 */
export const SUBTASK_ID_PATTERN = '^0*(?:[0-9]{1,9}|1[0-9]{9}|20[0-9]{8}|21[0-3][0-9]{7}|214[0-6][0-9]{6}|2147[0-3][0-9]{5}|21474[0-7][0-9]{4}|214748[0-2][0-9]{3}|2147483[0-5][0-9]{2}|21474836[0-3][0-9]|214748364[0-7])(?![\\s\\S])';
const SUBTASK_ID_RE = new RegExp(SUBTASK_ID_PATTERN);
export const SUBTASK_ID_ERROR = 'subtaskId must be an unsigned decimal integer from 0 to 2147483647';
export function isValidSubtaskId(id: unknown): id is string {
  return typeof id === 'string' && SUBTASK_ID_RE.test(id);
}
