import type { SubtaskStatus, SubtaskTransitionDetails } from '../types/task';

export interface SubtaskLifecycleRequest {
  path: string;
  method: 'PATCH' | 'POST';
  body: Record<string, unknown>;
}

/**
 * Map one explicit UI lifecycle transition to the canonical backend endpoint.
 * Existing subtasks are never sent through the generic whole-task update path.
 */
export const buildSubtaskLifecycleRequest = (
  apiBaseUrl: string,
  taskId: string,
  subtaskIndex: number,
  currentStatus: SubtaskStatus,
  nextStatus: SubtaskStatus,
  details?: SubtaskTransitionDetails,
): SubtaskLifecycleRequest => {
  if (!taskId) throw new Error('A task id is required for a subtask transition.');
  if (!Number.isInteger(subtaskIndex) || subtaskIndex < 0) {
    throw new Error('A valid subtask index is required for a lifecycle transition.');
  }

  const root = `${apiBaseUrl}/tasks/${encodeURIComponent(taskId)}/subtasks/${subtaskIndex}`;

  if (nextStatus === 'completed') {
    return { path: `${root}/approve`, method: 'POST', body: {} };
  }
  if (currentStatus === 'review' && nextStatus === 'empty') {
    return {
      path: `${root}/reject`,
      method: 'POST',
      body: { note: details?.reviewNote },
    };
  }
  if (nextStatus === 'skipped') {
    return { path: `${root}/skip`, method: 'POST', body: {} };
  }

  return {
    path: `${root}/status`,
    method: 'PATCH',
    body: {
      status: nextStatus,
      reviewNote: details?.reviewNote,
      blockedReason: details?.blockedReason,
    },
  };
};
