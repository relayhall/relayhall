import { logCaughtFailure } from '../utils/secretSafeLog';
import { idempotent } from '../middleware/idempotency';
// reports.ts - API endpoints for reports/notes management
import { Router, Request, Response } from 'express';
import { filterVisiblePromotions, filterVisibleReports } from '../services/ReportVisibility';
import type { AuthRequest } from '../middleware/auth';
import { reportManager, REPORT_TEXT_LIMITS } from '../services/ReportManager';
import { rejectInvalidReportIdParam } from '../utils/reportIds';
import { validateBody, BodySchema } from '../middleware/validate';
import { isStringTooLongError, sendStringTooLongError } from '../utils/apiErrors';
import {
  normalizeReportHandover,
  ReportHandover,
  ReportHandoverValidationError,
} from '../types/ReportHandover';

interface AuthedRequest extends AuthRequest {
  userId?: string;
}

const router = Router();

// The three narrowings that decide which Reports a caller may see moved into
// `services/ReportVisibility` (card 72258a60), because the dashboard's
// `reportCount` needs the SAME answer and a second copy of a rule is the way
// two surfaces come to disagree about a row.

/**
 * Length limits mirror the varchar widths in the reports table, so an
 * over-long field fails validation naming the field instead of reaching
 * Postgres and surfacing as a bare 500.
 * allowUnknown is kept on so this stays a length guard, not a field allowlist.
 */
const reportBodySchema: BodySchema = {
  title: { type: 'string', maxLen: REPORT_TEXT_LIMITS.title },
  summary: { type: 'string', maxLen: REPORT_TEXT_LIMITS.summary },
  author: { type: 'string', maxLen: REPORT_TEXT_LIMITS.author },
};
const validateReportBody = validateBody(reportBodySchema, { allowUnknown: true });

/**
 * author_actor_id is verified provenance (recorded from the authenticated
 * identity) — a client-supplied value is always an impersonation attempt.
 * Returns true (and responds 400) when the body tries to set it.
 */
const ORIGIN_RE = /^[a-z0-9_-]{1,32}$/;
const VISIBILITY_RE = /^[a-z0-9_-]{1,32}$/;

type ParsedHandover =
  | { ok: true; present: false }
  | { ok: true; present: true; value: ReportHandover | null }
  | { ok: false };

function parseHandoverBody(req: Request, res: Response): ParsedHandover {
  if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, 'handover')) {
    return { ok: true, present: false };
  }
  try {
    return { ok: true, present: true, value: normalizeReportHandover(req.body.handover) };
  } catch (error) {
    if (error instanceof ReportHandoverValidationError) {
      res.status(400).json({ success: false, error: error.message, code: error.code });
      return { ok: false };
    }
    throw error;
  }
}

/**
 * Validate an optional visibility body value (migration 061 — plumbing only,
 * no enforcement here). Returns true (and responds 400) when malformed.
 */
function rejectBadVisibility(req: Request, res: Response): boolean {
  const value = req.body?.visibility;
  if (value === undefined) return false;
  if (typeof value !== 'string' || !VISIBILITY_RE.test(value)) {
    res.status(400).json({
      success: false,
      error: 'visibility must match [a-z0-9_-]{1,32} (e.g. default, private, team)',
      code: 'INVALID_VISIBILITY',
    });
    return true;
  }
  return false;
}

/**
 * Resolve the creating surface from the optional X-RelayHall-Origin header
 * ('api' | 'cli' | 'dashboard' | ...). Returns null (after responding 400)
 * on a malformed value; defaults to 'api' when the header is absent.
 */
function resolveOrigin(req: Request, res: Response): string | null {
  const header = req.headers['x-relayhall-origin'];
  if (header === undefined) return 'api';
  const value = String(Array.isArray(header) ? header[0] : header).trim().toLowerCase();
  if (!ORIGIN_RE.test(value)) {
    res.status(400).json({
      success: false,
      error: 'X-RelayHall-Origin must match [a-z0-9_-]{1,32} (e.g. api, cli, dashboard)',
      code: 'INVALID_ORIGIN',
    });
    return null;
  }
  return value;
}

function rejectBodyActorId(req: Request, res: Response): boolean {
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'author_actor_id')) {
    res.status(400).json({
      success: false,
      error: 'author_actor_id is set from the authenticated identity and cannot be supplied in the body (use author for a display label)',
      code: 'AUTHOR_ACTOR_ID_FORBIDDEN',
    });
    return true;
  }
  return false;
}

/**
 * GET /reports
 * List reports with pagination, filtering, and search
 * Query params: q, tags (comma-separated), project_id, pinned, limit, offset,
 *               updated_since (ISO8601, inclusive), sort (updated_at|created_at), order (asc|desc)
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const q = req.query.q as string | undefined;
    const tagsParam = req.query.tags as string | undefined;
    const tags = tagsParam ? tagsParam.split(',').map(t => t.trim()).filter(Boolean) : undefined;
    const project_id = req.query.project_id as string | undefined;
    const pinnedParam = req.query.pinned as string | undefined;
    const pinned = pinnedParam !== undefined ? pinnedParam === 'true' : undefined;
    const limit = parseInt(req.query.limit as string, 10) || 10;
    const offset = parseInt(req.query.offset as string, 10) || 0;

    const updated_since = req.query.updated_since as string | undefined;
    if (updated_since !== undefined && Number.isNaN(Date.parse(updated_since))) {
      res.status(400).json({
        success: false,
        error: 'updated_since must be an ISO8601 timestamp (e.g. 2026-07-21T00:00:00Z)',
        code: 'INVALID_UPDATED_SINCE',
      });
      return;
    }

    const sort = req.query.sort as string | undefined;
    if (sort !== undefined && sort !== 'updated_at' && sort !== 'created_at') {
      res.status(400).json({
        success: false,
        error: "sort must be 'updated_at' or 'created_at'",
        code: 'INVALID_SORT',
      });
      return;
    }

    const order = req.query.order as string | undefined;
    if (order !== undefined && order !== 'asc' && order !== 'desc') {
      res.status(400).json({
        success: false,
        error: "order must be 'asc' or 'desc'",
        code: 'INVALID_ORDER',
      });
      return;
    }

    const include_deleted = req.query.include_deleted === 'true';

    const status = req.query.status as string | undefined;
    if (status !== undefined && status !== 'active' && status !== 'archived') {
      res.status(400).json({
        success: false,
        error: "status must be 'active' or 'archived'",
        code: 'INVALID_STATUS',
      });
      return;
    }
    const include_archived = req.query.include_archived === 'true';

    const taskId = req.query.taskId as string | undefined;
    if (taskId !== undefined && !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(taskId)) {
      res.status(400).json({
        success: false,
        error: 'taskId must be a full task UUID',
        code: 'INVALID_TASK_ID',
      });
      return;
    }

    const result = await reportManager.list({
      q, tags, project_id, pinned, limit, offset, taskId,
      updated_since,
      sort: sort as 'updated_at' | 'created_at' | undefined,
      order: order as 'asc' | 'desc' | undefined,
      include_deleted,
      status: status as 'active' | 'archived' | undefined,
      include_archived,
    });
    const reports = await filterVisibleReports(req as AuthRequest, result.reports);

    res.json({
      success: true,
      reports,
      total: reports.length,
      // Filtering after a bounded source page cannot honestly claim the
      // caller has another visible page. A future SQL adapter may restore
      // cursor pagination without leaking hidden-row counts.
      hasMore: false,
    });
  } catch (err) {
    const errorId = logCaughtFailure('[Reports API] Error listing reports:', err);
    res.status(500).json({
      success: false,
      error: 'Reports could not be read',
      code: 'REPORTS_READ_FAILED',
      errorId,
    });
  }
});

/**
 * GET /reports/:id
 * Get a single report by ID
 */
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  if (rejectInvalidReportIdParam(req.params.id, res)) return;
  try {
    const report = await reportManager.getById(req.params.id, {
      includeDeleted: req.query.include_deleted === 'true',
    });
    if (!report) {
      res.status(404).json({ success: false, error: 'Report not found' });
      return;
    }
    // Point authorization has already been decided by the shared middleware;
    // what remains is the promotion pair.
    const visible = await filterVisiblePromotions(req as AuthRequest, [report]);
    if (visible.length === 0) {
      res.status(404).json({ success: false, error: 'Report not found' });
      return;
    }
    res.json({ success: true, report: visible[0] });
  } catch (err) {
    const errorId = logCaughtFailure('[Reports API] Error getting report:', err);
    res.status(500).json({
      success: false,
      error: 'The report could not be read',
      code: 'REPORT_READ_FAILED',
      errorId,
    });
  }
});

/**
 * POST /reports
 * Create a new report
 * Body: { title, content, summary?, tags?, project_id?, task_ids?, author?, handover?, pinned? }
 * author is a free-form display label (recorded unverified); author_actor_id is
 * always taken from the authenticated identity and rejected if supplied.
 */
router.post('/', idempotent('report.create'), validateReportBody, async (req: Request, res: Response): Promise<void> => {
  if (rejectBodyActorId(req, res)) return;
  if (rejectBadVisibility(req, res)) return;
  const parsedHandover = parseHandoverBody(req, res);
  if (!parsedHandover.ok) return;
  const origin = resolveOrigin(req, res);
  if (origin === null) return;
  try {
    const { title, content, summary, tags, project_id, task_ids, author, visibility, pinned } = req.body;

    if (!title || !content) {
      res.status(400).json({ success: false, error: 'Title and content are required' });
      return;
    }

    const report = await reportManager.create({
      title,
      content,
      summary,
      tags,
      project_id,
      task_ids,
      author,
      author_actor_id: (req as AuthedRequest).userId ?? null,
      author_principal_id: (req as AuthedRequest).principal?.id ?? null,
      origin,
      visibility,
      handover: parsedHandover.present ? parsedHandover.value : undefined,
      pinned,
    });

    res.status(201).json({ success: true, report });
  } catch (err) {
    if (isStringTooLongError(err)) { sendStringTooLongError(res, 'report', err); return; }
    const errorId = logCaughtFailure('[Reports API] Error creating report:', err);
    res.status(500).json({
      success: false,
      error: 'The report could not be created',
      code: 'REPORT_CREATE_FAILED',
      errorId,
    });
  }
});

/**
 * PATCH /reports/:id
 * Partial update of a report
 */
router.patch('/:id', validateReportBody, async (req: Request, res: Response): Promise<void> => {
  if (rejectInvalidReportIdParam(req.params.id, res)) return;
  if (rejectBodyActorId(req, res)) return;
  if (rejectBadVisibility(req, res)) return;
  const parsedHandover = parseHandoverBody(req, res);
  if (!parsedHandover.ok) return;
  try {
    const updates = { ...req.body };
    delete updates.id;
    delete updates.created_at;
    delete updates.author_unverified; // response-only alias of author
    if (parsedHandover.present) updates.handover = parsedHandover.value;

    const report = await reportManager.update(req.params.id, updates);
    if (!report) {
      res.status(404).json({ success: false, error: 'Report not found' });
      return;
    }

    res.json({ success: true, report });
  } catch (err) {
    if (err instanceof Error && err.message === 'REPORT_ARCHIVED') {
      res.status(409).json({
        success: false,
        error: 'Report is archived and read-only; unarchive it first',
        code: 'REPORT_ARCHIVED',
      });
      return;
    }
    if (isStringTooLongError(err)) { sendStringTooLongError(res, 'report', err); return; }
    const errorId = logCaughtFailure('[Reports API] Error updating report:', err);
    res.status(500).json({
      success: false,
      error: 'The report could not be updated',
      code: 'REPORT_UPDATE_FAILED',
      errorId,
    });
  }
});

/**
 * POST /reports/:id/archive
 * Archive: finished and filed (§4.4). Read-only while archived, excluded
 * from default lists, still readable and linkable. Reversible.
 */
router.post('/:id/archive', async (req: Request, res: Response): Promise<void> => {
  if (rejectInvalidReportIdParam(req.params.id, res)) return;
  try {
    const report = await reportManager.archive(req.params.id);
    if (!report) {
      res.status(404).json({ success: false, error: 'Report not found or not active' });
      return;
    }
    res.json({ success: true, report });
  } catch (err) {
    const errorId = logCaughtFailure('[Reports API] Error archiving report:', err);
    res.status(500).json({
      success: false,
      error: 'The report could not be archived',
      code: 'REPORT_ARCHIVE_FAILED',
      errorId,
    });
  }
});

/**
 * POST /reports/:id/unarchive
 * Return an archived report to active.
 */
router.post('/:id/unarchive', async (req: Request, res: Response): Promise<void> => {
  if (rejectInvalidReportIdParam(req.params.id, res)) return;
  try {
    const report = await reportManager.unarchive(req.params.id);
    if (!report) {
      res.status(404).json({ success: false, error: 'Report not found or not archived' });
      return;
    }
    res.json({ success: true, report });
  } catch (err) {
    const errorId = logCaughtFailure('[Reports API] Error unarchiving report:', err);
    res.status(500).json({
      success: false,
      error: 'The report could not be restored',
      code: 'REPORT_RESTORE_FAILED',
      errorId,
    });
  }
});

/**
 * DELETE /reports/:id
 * Soft delete (tombstone) by default. ?hard=true destroys the row and is
 * restricted to the dashboard_user identity.
 */
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  if (rejectInvalidReportIdParam(req.params.id, res)) return;
  try {
    const hard = req.query.hard === 'true';
    if (hard && (req as AuthedRequest).userId !== 'dashboard_user') {
      res.status(403).json({
        success: false,
        error: 'hard delete is restricted to the dashboard user; omit ?hard=true for a soft delete',
        code: 'HARD_DELETE_FORBIDDEN',
      });
      return;
    }

    const deleted = hard
      ? await reportManager.hardDelete(req.params.id)
      : await reportManager.softDelete(req.params.id);
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Report not found' });
      return;
    }
    res.json({ success: true, mode: hard ? 'hard' : 'soft' });
  } catch (err) {
    const errorId = logCaughtFailure('[Reports API] Error deleting report:', err);
    res.status(500).json({
      success: false,
      error: 'The report could not be deleted',
      code: 'REPORT_DELETE_FAILED',
      errorId,
    });
  }
});

export default router;
