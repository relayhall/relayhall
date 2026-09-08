const TASK_BOARD_ORIGIN_KEY = 'relayhall-task-board-origin';

interface TaskBoardOrigin {
  taskId: string;
  /** Full originating board URL (pathname + query) so the details page's
   *  return surfaces restore view + filters (986be411 §3) — query-only state
   *  like ?view=, ?archived= and the Assignee params lives nowhere else. */
  boardUrl?: string;
  boardScrollLeft: number;
  windowScrollY: number;
}

/** One-shot Task-opening parameters. A captured return URL must never carry
 *  them: returning to `/tasks?focus={id}` would resolve the deep link again
 *  and bounce straight back to the Task (review 52a37007 B1). View and filter
 *  parameters are preserved untouched. */
const TASK_OPENING_PARAMS = ['focus', 'id', 'open', 'task'] as const;

function sanitizeBoardUrl(boardUrl: string): string {
  const [path, query = ''] = boardUrl.split('?');
  const params = new URLSearchParams(query);
  for (const key of TASK_OPENING_PARAMS) params.delete(key);
  const remaining = params.toString();
  return remaining ? `${path}?${remaining}` : path;
}

export function captureTaskBoardOrigin(taskId: string, boardUrl?: string): void {
  if (typeof sessionStorage === 'undefined') return;
  const board = document.querySelector<HTMLElement>('.tasks-page-board-inner');
  const origin: TaskBoardOrigin = {
    taskId,
    boardUrl: boardUrl ? sanitizeBoardUrl(boardUrl) : undefined,
    boardScrollLeft: board?.scrollLeft ?? 0,
    windowScrollY: window.scrollY,
  };
  sessionStorage.setItem(TASK_BOARD_ORIGIN_KEY, JSON.stringify(origin));
}

export function getTaskBoardOriginTaskId(): string | null {
  if (typeof sessionStorage === 'undefined') return null;
  const raw = sessionStorage.getItem(TASK_BOARD_ORIGIN_KEY);
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as TaskBoardOrigin).taskId || null;
  } catch {
    return null;
  }
}

/** The captured board URL, released only to the Task the origin belongs to —
 *  a stale origin from an earlier visit must never hijack an unrelated
 *  details page — and only when it is a board-local path. */
export function getTaskBoardOriginBoardUrl(taskId: string): string | null {
  if (typeof sessionStorage === 'undefined') return null;
  const raw = sessionStorage.getItem(TASK_BOARD_ORIGIN_KEY);
  if (!raw) return null;
  try {
    const origin = JSON.parse(raw) as TaskBoardOrigin;
    if (origin.taskId !== taskId) return null;
    if (!origin.boardUrl || !origin.boardUrl.startsWith('/tasks')) return null;
    return origin.boardUrl;
  } catch {
    return null;
  }
}

export function restoreTaskBoardOrigin(): boolean {
  if (typeof sessionStorage === 'undefined') return false;
  const raw = sessionStorage.getItem(TASK_BOARD_ORIGIN_KEY);
  if (!raw) return false;
  try {
    const origin = JSON.parse(raw) as TaskBoardOrigin;
    // The Task can be returned to on EITHER surface. The board opener and the
    // Map opener are different controls; requiring the board one meant a Map
    // return silently restored nothing and left the one-shot record behind
    // (review 7fc68646 B2).
    const opener = document.querySelector<HTMLButtonElement>(
      `.task-card-open-button[data-task-id="${origin.taskId}"]`,
    ) ?? document.querySelector<HTMLButtonElement>(
      `.task-card-map-open[data-task-id="${origin.taskId}"]`,
    );
    if (!opener) return false;
    // Only the board has a horizontal scroll container; the Map restores its
    // own pan and zoom from its persisted view state, so its absence is not a
    // failure to restore.
    const board = document.querySelector<HTMLElement>('.tasks-page-board-inner');
    if (board) board.scrollLeft = origin.boardScrollLeft;
    window.scrollTo({ top: origin.windowScrollY, behavior: 'auto' });
    opener.focus();
    sessionStorage.removeItem(TASK_BOARD_ORIGIN_KEY);
    return true;
  } catch {
    sessionStorage.removeItem(TASK_BOARD_ORIGIN_KEY);
    return false;
  }
}
