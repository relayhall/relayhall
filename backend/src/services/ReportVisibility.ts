/**
 * WHICH REPORTS THIS CALLER MAY SEE — one definition, every consumer.
 *
 * Three narrowings stand between the reports table and a response, and until
 * card 72258a60 only ONE surface ran all three. `GET /reports` composed them
 * inline; `GET /dashboard/summary` answered `reportCount` from
 * `SELECT COUNT(*) FROM reports`, over every Account's Reports, for every
 * caller. A count is a disclosure, so the two surfaces were not merely
 * inconsistent — the cheaper one was wrong.
 *
 * The repair is not a second copy of the three narrowings for the count. It is
 * this module: the list and the count call the SAME function, so they cannot
 * drift, and a fourth consumer gets the whole rule by importing one name.
 *
 * The three narrowings, in order:
 *
 *   1. the shared authorization predicate over `report` rows — the same
 *      `sqlCondition` `GET /reports/:id` runs;
 *   2. auto-promoted Reports whose SOURCE TASK the caller may not read (a
 *      promotion must not carry Task content across the boundary that
 *      conceals the Task);
 *   3. the `assigned-only` outpost tier, which additionally demands
 *      assignment membership (`TaskElementService.filterPromotedReports`).
 */
import type { AuthRequest } from '../middleware/auth';
import { filterAuthorizedResources } from '../middleware/sharedAuthorization';
import { scopesSatisfy } from '../utils/scopeMap';
import { taskElementService } from './TaskElementService';
import { reportManager } from './ReportManager';

/** The columns every narrowing above reads. Deliberately the SMALLEST shape
 * that answers the question, so the count can ask for it without paying for
 * report content. */
export interface ReportVisibilityRow {
  id: string;
  auto_promoted?: boolean;
  source_task_id?: string | null;
  source_outpost_visibility_tier?: string | null;
}

/** The actor shape the promoted-report tier check takes. An unresolved caller
 * gets a principal id that matches no row rather than a wildcard. */
export function promotedReportActor(req: AuthRequest): { principalId: string; handle: string; root: boolean } {
  if (!req.principal) {
    return {
      principalId: '00000000-0000-4000-8000-000000000000',
      handle: 'unresolved',
      root: false,
    };
  }
  return {
    principalId: req.principal.id,
    handle: req.principal.handle,
    root: scopesSatisfy(req.scopes, 'root'),
  };
}

/** Narrowing 2: a promotion is only as visible as the Task it was promoted
 * from. */
async function filterTaskScopedPromotions<T extends ReportVisibilityRow>(
  req: AuthRequest,
  reports: T[],
): Promise<T[]> {
  const sourceTaskIds = [...new Set(
    reports
      .filter((report) => report.auto_promoted && report.source_task_id)
      .map((report) => report.source_task_id as string),
  )];
  if (sourceTaskIds.length === 0) return reports;
  const visibleTaskIds = new Set(await filterAuthorizedResources(
    req,
    'read',
    sourceTaskIds,
    (taskId) => ({ type: 'task', id: taskId }),
  ));
  return reports.filter((report) =>
    !report.auto_promoted
    || (report.source_task_id ? visibleTaskIds.has(report.source_task_id) : false),
  );
}

/** Narrowings 2 and 3, for a caller whose POINT authorization the shared
 * middleware has already decided (`GET /reports/:id`). */
export async function filterVisiblePromotions<T extends ReportVisibilityRow>(
  req: AuthRequest,
  reports: T[],
): Promise<T[]> {
  const taskScoped = await filterTaskScopedPromotions(req, reports);
  return taskElementService.filterPromotedReports(taskScoped, promotedReportActor(req));
}

/** All three narrowings, for a collection. */
export async function filterVisibleReports<T extends ReportVisibilityRow>(
  req: AuthRequest,
  reports: T[],
): Promise<T[]> {
  const authorized = await filterAuthorizedResources(
    req,
    'read',
    reports,
    (report) => ({ type: 'report', id: report.id }),
  );
  return filterVisiblePromotions(req, authorized);
}

/**
 * How many Reports this caller may see.
 *
 * It reads the id-and-provenance columns of every live Report and runs the
 * SAME three narrowings the list runs, rather than a COUNT with a predicate
 * hand-written to mean the same thing. Narrowings 2 and 3 are not expressible
 * as one conjunct without restating them in SQL, and a restatement is the
 * defect this module exists to prevent — so the count pays one bounded read
 * for the guarantee that it can never claim a Report the list would withhold.
 */
export async function countVisibleReports(req: AuthRequest): Promise<number> {
  const rows = await reportManager.listVisibilityRows();
  const visible = await filterVisibleReports(req, rows);
  return visible.length;
}
