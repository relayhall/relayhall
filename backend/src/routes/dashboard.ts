// dashboard.ts - API endpoints for the redesigned dashboard
//
// ── CARD 72258a60: THE FIRST SCREEN WAS THE LEAKIEST ONE ────────────────────
//
// Every route in this file used to take the request as `_req` and never ask
// who was calling. A first-time operator signed in as a second Account, whose
// `GET /api/tasks` correctly answered `[]`, landed on a home page reporting
// IDEAS 1 / TODO 2 and an activity feed carrying the task ids, the full task
// TITLES and the acting handle of work she had deliberately not been granted.
//
// The repair is the one card 08f42f36 established for the board: the shared
// authorization scope is a REQUIRED parameter of the query, so a surface that
// reports a COUNT counts the caller\'s own population and a caller that forgets
// the scope fails to compile. Counts are disclosures; there is no narrowing
// that can be applied to a number after it has been counted.
import { Router, Response } from 'express';
import type { AuthRequest } from '../middleware/auth';
import { authorizedListScope, filterAuthorizedResources } from '../middleware/sharedAuthorization';
import { taskManagerDB } from '../services/TaskManagerDB';
import { taskHistoryService } from '../services/TaskHistoryService';
import { countVisibleReports } from '../services/ReportVisibility';
import { logCaughtFailure } from '../utils/secretSafeLog';

const router = Router();

/**
 * GET /dashboard/summary
 * Aggregated stats for the dashboard cards, over the caller\'s own population.
 */
router.get('/summary', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const summary = await taskManagerDB.getDashboardSummary(
      authorizedListScope(req, 'task', 'read'),
    );

    // Report count (gracefully handle if the table doesn't exist yet). The
    // `catch` leaves the count at 0 — the fail-CLOSED answer: a surface that
    // cannot decide what this caller may see reports nothing rather than
    // everything.
    let reportCount = 0;
    try {
      reportCount = await countVisibleReports(req);
    } catch {
      // Table may not exist yet — that's fine
    }

    res.json({ success: true, summary: { ...summary, reportCount } });
  } catch (err) {
    const errorId = logCaughtFailure('[Dashboard API] Error getting summary:', err);
    res.status(500).json({
      error: 'The dashboard summary could not be read',
      code: 'DASHBOARD_SUMMARY_READ_FAILED',
      errorId,
    });
  }
});

/**
 * GET /dashboard/active
 * In-progress tasks with subtask breakdown, narrowed to the caller.
 */
router.get('/active', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // DB-backed (P1.3 A19: the fs-based legacy TaskManager was retired).
    const queried = await taskManagerDB.queryTasks({ status: 'in-progress' });

    // This surface reports NO total and NO page, so the post-read narrowing
    // `GET /tasks` uses is honest here and is deliberately the same one: two
    // Task lists that answer in ROWS should refuse through one function. The
    // COUNT surfaces in this file carry the scope in their query instead,
    // because a count narrowed afterwards is not narrowed at all.
    const inProgressTasks = await filterAuthorizedResources(
      req,
      'read',
      queried,
      (task) => ({ type: 'task', id: task.id }),
    );

    // Sort by updatedAt desc
    inProgressTasks.sort((a, b) =>
      new Date(b.updated).getTime() - new Date(a.updated).getTime()
    );

    // 6a351638 (R19): queryTasks already hydrated every subtask row above, so
    // the per-task getSubtaskSummaryAsync round-trip re-read the same rows the
    // response was about to serialize anyway — one extra query per in-progress
    // task, hundreds at seeded scale, all on the startup path. Counting the
    // hydrated rows is the same summary with zero additional queries.
    const tasks = inProgressTasks.map(task => {
      const subtasks = task.subtasks || [];
      const countOf = (status: string) => subtasks.filter(s => s.status === status).length;
      return {
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        project: task.project || null,
        subtasks,
        subtaskProgress: {
          total: subtasks.length,
          completed: countOf('completed'),
          skipped: countOf('skipped'),
          review: countOf('review'),
          inProgress: countOf('in-progress'),
          stuck: countOf('stuck'),
          empty: countOf('empty'),
        },
        updatedAt: task.updated,
      };
    });

    res.json({ tasks });
  } catch (err) {
    const errorId = logCaughtFailure('[Dashboard API] Error getting active tasks:', err);
    res.status(500).json({ error: 'Active Tasks could not be read', code: 'ACTIVE_TASKS_FAILED', errorId });
  }
});

/**
 * GET /dashboard/activity?limit=10
 * Recent changes to the Tasks the caller may read, newest first.
 */
router.get('/activity', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 10, 1), 100);
    // The scope rides into the query, not around the result: `ORDER BY … LIMIT`
    // over the whole estate followed by a filter would hand this caller the
    // BOARD\'s newest events and then show her the few she may read.
    const events = await taskHistoryService.getRecentActivity(
      limit,
      authorizedListScope(req, 'task', 'read'),
    );
    res.json({ events });
  } catch (err) {
    const errorId = logCaughtFailure('[Dashboard API] Error getting activity:', err);
    res.status(500).json({
      error: 'The activity feed could not be read',
      code: 'ACTIVITY_READ_FAILED',
      errorId,
    });
  }
});

export default router;
