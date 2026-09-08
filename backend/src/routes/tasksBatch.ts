import { Router, Request, Response } from 'express';
import { logCaughtFailure } from '../utils/secretSafeLog';
import { taskManagerDB as taskManager } from '../services/TaskManagerDB';
import { sendApiError } from '../utils/apiErrors';
import { validateBody, UUID_RE } from '../middleware/validate';
import type { AuthRequest } from '../middleware/auth';
import { authorizedProjectTarget, filterAuthorizedResources } from '../middleware/sharedAuthorization';
import { resolveTaskLifecycleRole } from '../utils/taskAutomationRole';
import { normalizeTaskNotesWrite, sendTaskFieldRefusal } from '../utils/taskWriteFields';

/**
 * Batch task updates: PATCH /tasks/batch (task 3c7da35b).
 * Mounted BEFORE the main tasks router so /batch wins over /:id.
 * Applies the same per-task update path (lifecycle gates included);
 * returns per-id results — partial success is expected behavior.
 */

const router = Router();

const ALLOWED_FIELDS = ['status', 'priority', 'project', 'autoStart', 'tags', 'notes', 'blockedReason'] as const;

const batchSchema = {
  ids: { type: 'array' as const, required: true, itemsType: 'string' as const },
  updates: { type: 'object' as const, required: true },
};

router.patch('/batch', validateBody(batchSchema), async (req: Request, res: Response) => {
  const { ids, updates } = req.body as { ids: string[]; updates: Record<string, unknown> };

  if (ids.length === 0 || ids.length > 100) {
    sendApiError(res, 400, 'BATCH_SIZE', 'ids must contain between 1 and 100 task ids'); return;
  }
  const badIds = ids.filter(id => !UUID_RE.test(id));
  if (badIds.length) {
    sendApiError(res, 400, 'INVALID_TASK_ID', `Not UUIDs: ${badIds.slice(0, 5).join(', ')}${badIds.length > 5 ? '…' : ''}`,
      'Batch requires full task UUIDs (the CLI resolves short prefixes client-side).');
    return;
  }
  const unknownFields = Object.keys(updates).filter(k => !(ALLOWED_FIELDS as readonly string[]).includes(k));
  if (unknownFields.length) {
    sendApiError(res, 400, 'UNSUPPORTED_BATCH_FIELD', `Not batch-updatable: ${unknownFields.join(', ')}`,
      `Batch supports: ${ALLOWED_FIELDS.join(', ')}. Use PATCH /tasks/:id for anything else.`);
    return;
  }
  if (Object.keys(updates).length === 0) {
    sendApiError(res, 400, 'EMPTY_UPDATES', 'updates must set at least one field'); return;
  }
  // Card 9c3a1aa4. Three surfaces write this column; one function decides what
  // a value in it may be. A batch refusal is answered ONCE, before any task is
  // touched, because a body that is wrong is wrong for every id in it.
  try {
    if ('notes' in updates) updates.notes = normalizeTaskNotesWrite(updates.notes);
  } catch (err) {
    if (sendTaskFieldRefusal(res, err)) return;
    throw err;
  }

  // Same operation as a single-task PATCH, so it must attribute identically —
  // otherwise history says 'user' for a batch edit and names the principal for
  // the individual one.
  const authReq = req as AuthRequest;
  const actor = {
    principalId: authReq.principal?.id ?? null,
    handle: authReq.userId || 'user',
    role: resolveTaskLifecycleRole({
      handle: authReq.userId || '',
      principalRole: authReq.principal?.role ?? null,
      sessionRole: authReq.sessionRole ?? null,
    }),
  };

  // Card 9c177e6a. `project` is a batch-updatable field, so this route is a
  // MOVE surface: without a target decision a caller could move a hundred
  // Tasks it owns INTO a Project it cannot read, one PATCH at a time. Built
  // ONCE for the request rather than per id - it closes over the actor, and
  // rebuilding it per row would suggest the decision differs per row.
  const projectTarget = authorizedProjectTarget(authReq);

  const results: Array<{ id: string; success: boolean; error?: string; errorId?: string }> = [];
  const existingTasks = (await Promise.all(ids.map((id) => taskManager.getTask(id))))
    .filter((task): task is NonNullable<typeof task> => Boolean(task));
  const authorizedTasks = await filterAuthorizedResources(
    authReq,
    'write',
    existingTasks,
    (task) => ({ type: 'task', id: task.id }),
  );
  // Card f9b7febe, the same rule per ROW. This loop reported TASK_NOT_FOUND for
  // an absent id and FORBIDDEN for an existing one the caller could not write,
  // which made the batch an id oracle a hundred ids at a time - the very shape
  // the point route was answering 403 in. A row the caller cannot READ is
  // reported exactly as an absent one; a row it can read and cannot write
  // keeps FORBIDDEN, because that caller already knows the row is there.
  const readableTasks = await filterAuthorizedResources(
    authReq,
    'read',
    existingTasks,
    (task) => ({ type: 'task', id: task.id }),
  );
  const existingIds = new Set(existingTasks.map((task) => task.id));
  const authorizedIds = new Set(authorizedTasks.map((task) => task.id));
  const readableIds = new Set(readableTasks.map((task) => task.id));
  for (const id of ids) {
    if (!existingIds.has(id) || !readableIds.has(id)) {
      results.push({ id, success: false, error: 'TASK_NOT_FOUND' });
      continue;
    }
    if (!authorizedIds.has(id)) {
      results.push({ id, success: false, error: 'FORBIDDEN' });
      continue;
    }
    try {
      const updated = await taskManager.updateTask(id, updates as never, actor, projectTarget);
      results.push(updated ? { id, success: true } : { id, success: false, error: 'TASK_NOT_FOUND' });
    } catch (err) {
      const errorId = logCaughtFailure('[Tasks API] Batch update failed for a task:', err);
      results.push({ id, success: false, error: 'TASK_UPDATE_FAILED', errorId });
    }
  }
  const succeeded = results.filter(r => r.success).length;
  res.status(succeeded ? 200 : 422).json({ success: succeeded > 0, total: ids.length, succeeded, results });
});

export default router;
