import type { MapReportsMode } from '../../utils/theme';
import type { MapGraph, MapReport } from './mapGraphModel';

/**
 * The Map's Reports display mode (card 742fae98, epic 5854f0d6), as data.
 *
 * Collapsed draws ONE "Reports · N" node per task; Expanded draws every Report
 * node in a report area. Both count exactly what the graph read lists, one per
 * (Report, Task) pair, and nothing else: `GET /tasks/graph` narrows `reports`
 * Report by Report on the server (a Report carries its own grants), so a
 * viewer who may not read some of a task's Reports is sent a shorter list and
 * sees a smaller N. Nothing here may widen that list or count a Report twice.
 *
 * Collapsed is a REPORT-LAYER substitution, not a second renderer: each task's
 * Reports are replaced by one entry before the plane is laid out, so the
 * engine reserves one cell for the node exactly as it reserves cells for
 * Report pills, and everything that already follows a pill (culling by its
 * own box, the chain dim, the archive motion, the local edge) follows it.
 */

/** Above this many Reports a Collapsed node takes the warning tint (owner: "about ten"). */
export const REPORT_GROUP_WARN_ABOVE = 10;
/** The hover and focus preview names at most this many Reports, newest first. */
export const REPORT_PREVIEW_LIMIT = 5;

const GROUP_PREFIX = 'reports-of:';

export interface ReportGroup {
  taskId: string;
  /** Distinct (Report, Task) pairs the graph read listed for this task. */
  count: number;
  /** Those Reports, in the order the graph read listed them (newest first). */
  reports: readonly MapReport[];
}

export const reportGroupTitle = (count: number): string => `Reports · ${count}`;
export const isHeavyReportGroup = (count: number): boolean => count > REPORT_GROUP_WARN_ABOVE;

/** One id per task: it names the task and does not change with N, so the node keeps its cell. */
export const reportGroupId = (taskId: string): string => `${GROUP_PREFIX}${taskId}`;
export const taskOfReportGroup = (id: string): string | null =>
  id.startsWith(GROUP_PREFIX) ? id.slice(GROUP_PREFIX.length) : null;

/** The graph read's Reports by task, one per (Report, Task) pair, order kept. */
export function groupReportsByTask(reports: readonly MapReport[] | undefined): Map<string, ReportGroup> {
  const groups = new Map<string, { taskId: string; reports: MapReport[] }>();
  const seen = new Set<string>();
  for (const report of reports ?? []) {
    const pair = `${report.id}\u0000${report.taskId}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    const group = groups.get(report.taskId);
    if (group) group.reports.push(report);
    else groups.set(report.taskId, { taskId: report.taskId, reports: [report] });
  }
  return new Map([...groups].map(([taskId, group]) =>
    [taskId, { taskId, count: group.reports.length, reports: group.reports }]));
}

/** Collapsed: every task's Reports become ONE entry carrying its count. */
export function collapseReports(graph: MapGraph, groups: ReadonlyMap<string, ReportGroup>): MapGraph {
  return {
    ...graph,
    reports: [...groups.values()].map(group => ({
      id: reportGroupId(group.taskId), taskId: group.taskId, title: reportGroupTitle(group.count),
    })),
  };
}

/** Expanded is the graph exactly as read; Collapsed is the grouped one. */
export function graphForReportsMode(
  graph: MapGraph, mode: MapReportsMode, groups: ReadonlyMap<string, ReportGroup>,
): MapGraph {
  return mode === 'collapsed' ? collapseReports(graph, groups) : graph;
}
