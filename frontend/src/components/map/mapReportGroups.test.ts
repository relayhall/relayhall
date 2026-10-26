// Card 742fae98: the Map's Reports display mode, as pure data.
//
// Collapsed draws ONE "Reports · N" node per task and Expanded draws every
// Report node; both count only what the graph read lists, and the graph read
// lists only the Reports the viewer may read (the server narrows `reports`
// Report by Report; mapReportsLive.test.ts proves that over PostgreSQL). So
// the count is a pure function of the list, and nothing here may add to it.
import { describe, expect, test } from 'vitest';

import type { MapGraph, MapReport } from './mapGraphModel';
import {
  REPORT_GROUP_WARN_ABOVE,
  REPORT_PREVIEW_LIMIT,
  collapseReports,
  groupReportsByTask,
  graphForReportsMode,
  isHeavyReportGroup,
  reportGroupId,
  reportGroupTitle,
  taskOfReportGroup,
} from './mapReportGroups';

const node = (id: string) => ({ id, title: `Task ${id}`, status: 'todo', priority: 'normal', project: 'P' }) as any;
const report = (id: string, taskId: string, title = `Report ${id}`): MapReport => ({ id, taskId, title });

const graph = (reports: MapReport[]): MapGraph => ({
  nodes: [node('a'), node('b'), node('quiet')], edges: [], phases: [], reports,
});

describe('groupReportsByTask', () => {
  test('counts one per (Report, Task) pair, in the order the server listed them', () => {
    const groups = groupReportsByTask([
      report('r3', 'a'), report('r1', 'a'), report('r2', 'b'), report('r1', 'b'), report('r9', 'a'),
    ]);
    expect(groups.get('a')).toEqual({ taskId: 'a', count: 3, reports: [report('r3', 'a'), report('r1', 'a'), report('r9', 'a')] });
    expect(groups.get('b')?.count).toBe(2);
    expect(groups.has('quiet')).toBe(false);
  });

  test('a pair listed twice (a delta merged over a full read) is counted once', () => {
    const groups = groupReportsByTask([report('r1', 'a'), report('r1', 'a'), report('r2', 'a')]);
    expect(groups.get('a')?.count).toBe(2);
  });

  test('nothing listed is nothing counted: no list, an empty list', () => {
    expect(groupReportsByTask(undefined).size).toBe(0);
    expect(groupReportsByTask([]).size).toBe(0);
  });
});

describe('the Collapsed node', () => {
  test('is titled "Reports · N" with the middle dot the owner named', () => {
    expect(reportGroupTitle(1)).toBe('Reports · 1');
    expect(reportGroupTitle(12)).toBe('Reports · 12');
  });

  test('takes the warning tint above the threshold of about ten, and not at it', () => {
    expect(REPORT_GROUP_WARN_ABOVE).toBe(10);
    expect(isHeavyReportGroup(10)).toBe(false);
    expect(isHeavyReportGroup(11)).toBe(true);
  });

  test('previews at most five Reports', () => {
    expect(REPORT_PREVIEW_LIMIT).toBe(5);
  });

  test('has one stable id per task that names the task and nothing else', () => {
    expect(reportGroupId('a')).not.toBe(reportGroupId('b'));
    expect(taskOfReportGroup(reportGroupId('a'))).toBe('a');
    expect(taskOfReportGroup('r1')).toBeNull();
  });
});

describe('collapseReports', () => {
  test('replaces every task\'s Reports with ONE entry carrying that task\'s count', () => {
    const source = graph([report('r1', 'a'), report('r2', 'a'), report('r3', 'b')]);
    const collapsed = collapseReports(source, groupReportsByTask(source.reports));
    expect(collapsed.reports).toEqual([
      { id: reportGroupId('a'), taskId: 'a', title: reportGroupTitle(2) },
      { id: reportGroupId('b'), taskId: 'b', title: reportGroupTitle(1) },
    ]);
    // Tasks, edges and phases are the same objects: only the Report layer changes.
    expect(collapsed.nodes).toBe(source.nodes);
    expect(collapsed.edges).toBe(source.edges);
    expect(collapsed.phases).toBe(source.phases);
  });

  test('a task with no readable Report gets no node', () => {
    const source = graph([report('r1', 'a')]);
    const collapsed = collapseReports(source, groupReportsByTask(source.reports));
    expect(collapsed.reports?.map(entry => entry.taskId)).toEqual(['a']);
  });

  test('the group id does not change when the count does, so the node keeps its place', () => {
    const before = collapseReports(graph([report('r1', 'a')]), groupReportsByTask([report('r1', 'a')]));
    const after = collapseReports(graph([report('r1', 'a'), report('r2', 'a')]),
      groupReportsByTask([report('r1', 'a'), report('r2', 'a')]));
    expect(after.reports?.[0].id).toBe(before.reports?.[0].id);
    expect(after.reports?.[0].title).toBe(reportGroupTitle(2));
  });
});

describe('graphForReportsMode', () => {
  test('Expanded is the graph exactly as read; Collapsed is the grouped one', () => {
    const source = graph([report('r1', 'a'), report('r2', 'a')]);
    const groups = groupReportsByTask(source.reports);
    expect(graphForReportsMode(source, 'expanded', groups)).toBe(source);
    expect(graphForReportsMode(source, 'collapsed', groups).reports).toHaveLength(1);
  });
});
