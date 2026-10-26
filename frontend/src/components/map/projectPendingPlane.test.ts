import { expect, test } from 'vitest';
import { computeMapPlane } from './computeMapPlane';
import { projectPendingPlane } from './projectPendingPlane';
import { EMPTY_PLANE_ANCHORS } from './mapPlaneModel';
import type { MapGraph, MapOrganization } from './mapGraphModel';

function graph(): MapGraph {
  return { nodes: ['a','b','c'].map((id, i) => ({ id, title: id, project: i === 2 ? 'Other' : 'Project',
    phaseId: i === 2 ? 'phase2' : 'phase1', status: 'todo', priority: 'normal', updated: '2026-10-07' })),
  phases: [{ id: 'phase1', name: 'Phase one', goal: 'Original goal', projectId: 'p1', position: 0 },
    { id: 'phase2', name: 'Phase two', goal: null, projectId: 'p2', position: 0 }],
  edges: [{ from: 'a', to: 'b', kind: 'dependency' }, { from: 'a', to: 'c', kind: 'knowledge' }],
  reports: [{ id: 'report', taskId: 'a', title: 'Evidence' }] };
}
function layout(source: MapGraph, organization: MapOrganization) {
  return computeMapPlane({ graph: source, sizes: {}, organization,
    anchors: structuredClone(EMPTY_PLANE_ANCHORS) });
}

test.each(['horizontal','vertical','organic','radial'] as MapOrganization[])('%s pending metadata updates preserve positions and inputs', organization => {
  const prior = graph(), accepted = layout(prior, organization), before = structuredClone(accepted);
  const current = structuredClone(prior);
  current.nodes[0] = { ...current.nodes[0], title: 'New title', agent: 'Current worker', progress: { done: 1, total: 2 } };
  current.phases[0] = { ...current.phases[0], name: 'Current phase', goal: 'Current goal' };
  current.reports![0].title = 'Current evidence';
  const raw = structuredClone(current), pending = projectPendingPlane(accepted, prior, current);
  expect(pending.pendingTaskCount).toBe(0);
  expect(pending.layout.elements.map(({ id, kind, x, y, w, h }) => ({ id, kind, x, y, w, h })))
    .toEqual(accepted.elements.map(({ id, kind, x, y, w, h }) => ({ id, kind, x, y, w, h })));
  expect(pending.graph.nodes.find(n => n.id === 'a')).toMatchObject({ title: 'New title', agent: 'Current worker' });
  expect(pending.graph.reports?.[0].title).toBe('Current evidence');
  const tile = pending.layout.elements.find(e => e.id === 'a');
  expect(tile?.kind === 'tile' && tile.node.title).toBe('New title');
  expect(pending.layout.elements.filter(e => e.kind === 'band' || e.kind === 'chip').some(e => 'label' in e && e.label === 'Current phase')).toBe(true);
  expect(accepted).toEqual(before); expect(current).toEqual(raw); expect(pending.layout.anchors).toBe(accepted.anchors);
});

test.each(['horizontal','vertical','organic','radial'] as MapOrganization[])('%s removals and reparenting prune every displayed membership', organization => {
  const prior = graph(), accepted = layout(prior, organization), current = structuredClone(prior);
  current.nodes = current.nodes.filter(n => n.id !== 'b');
  current.nodes[1] = { ...current.nodes[1], project: 'Moved', phaseId: 'phase3' };
  current.nodes.push({ ...current.nodes[0], id: 'new', title: 'Pending arrival' });
  current.reports![0].taskId = 'c';
  const pending = projectPendingPlane(accepted, prior, current);
  expect(pending.graph.nodes.map(n => n.id)).toEqual(['a']);
  expect(pending.graph.edges).toEqual([]); expect(pending.graph.reports).toEqual([]);
  expect(pending.graph.phases.map(p => p.id)).toEqual(['phase1']);
  expect(pending.pendingTaskCount).toBe(2);
  expect(pending.layout.elements.filter(e => e.kind === 'tile').map(e => e.id)).toEqual(['a']);
  expect(pending.layout.elements.filter(e => e.kind === 'pill')).toEqual([]);
  for (const element of pending.layout.elements) {
    if (element.kind === 'container') { expect(element.taskIds).toEqual(['a']); expect(element.facts.taskCount).toBe(1); }
    if (element.kind === 'lane') expect(element.taskCount).toBe(1);
  }
  expect(pending.layout.organicRegions?.some(r => r.laneId === 'Other')).not.toBe(true);
});

test.each(['archive','restore'] as const)('%s status waits for its spatial transition without hiding metadata', direction => {
  const prior = graph(); if (direction === 'restore') prior.nodes[0].status = 'archived';
  const accepted = layout(prior, 'organic'), current = structuredClone(prior);
  current.nodes[0] = { ...current.nodes[0], status: direction === 'archive' ? 'archived' : 'todo', title: 'Current title' };
  const pending = projectPendingPlane(accepted, prior, current);
  expect(pending.pendingTaskCount).toBe(1);
  expect(pending.graph.nodes.find(n => n.id === 'a')).toMatchObject({ status: prior.nodes[0].status, title: 'Current title' });
  const completed = projectPendingPlane(layout(current, 'organic'), current, current);
  expect(completed.pendingTaskCount).toBe(0);
  expect(completed.graph.nodes.find(n => n.id === 'a')?.status).toBe(current.nodes[0].status);
});

test('removed phase metadata cannot linger through an accepted caption', () => {
  const prior = graph(), accepted = layout(prior, 'horizontal'), current = structuredClone(prior);
  current.phases = [];
  const pending = projectPendingPlane(accepted, prior, current);
  expect(pending.graph.phases).toEqual([]);
  expect(pending.layout.elements.some(e => 'label' in e && e.label === 'Phase one')).toBe(false);
  expect(pending.layout.elements.some(e => 'goal' in e && e.goal === 'Original goal')).toBe(false);
});

test('same-phase extensions and connector clusters keep geometry without guessed facts', () => {
  const prior = graph(), accepted = layout(prior, 'organic'), current = structuredClone(prior);
  const region = accepted.organicRegions!.find(r => !r.core)!;
  region.clusters = [
    { x: 1, y: 2, w: 3, h: 4, phaseId: 'phase1', facts: { taskCount: 99 } as never },
    { x: 5, y: 6, w: 7, h: 8, phaseId: 'phase1', facts: { taskCount: 42 } as never },
    { x: 9, y: 10, w: 11, h: 12, facts: { taskCount: 7 } as never },
  ];
  current.nodes[0].agent = 'Current worker';
  const pending = projectPendingPlane(accepted, prior, current);
  const projected = pending.layout.organicRegions!.find(r => r.laneId === region.laneId)!;
  expect(projected.clusters).toHaveLength(3);
  expect(projected.clusters.map(c => [c.x,c.y,c.w,c.h])).toEqual(region.clusters.map(c => [c.x,c.y,c.w,c.h]));
  expect(projected.clusters.every(c => c.facts === undefined)).toBe(true);
});

test('partial project deletion suppresses every derived branch and union until recomputed', () => {
  const prior = graph(), accepted = layout(prior, 'organic'), current = structuredClone(prior);
  current.nodes = current.nodes.filter(n => n.id !== 'b');
  const pending = projectPendingPlane(accepted, prior, current);
  const region = pending.layout.organicRegions!.find(r => r.laneId === 'Project')!;
  expect(region).toBeDefined(); expect(region.clusters).toEqual([]); expect(region.branches).toEqual([]);
  expect(region.outline).toBeUndefined(); expect(region.routedBranches).toBeUndefined();
  expect(region.blockedRoutes).toBeUndefined(); expect(region.blockedBranches).toBeUndefined();
  expect(pending.graph.nodes.some(n => n.id === 'a')).toBe(true);
});

test.each(['arrival','reassignment'])('report-only %s is explicitly pending', change => {
  const prior = graph(), accepted = layout(prior, 'horizontal'), current = structuredClone(prior);
  if(change === 'arrival') current.reports!.push({ id: 'new-report', taskId: 'b', title: 'New report' });
  else current.reports![0].taskId = 'b';
  const pending = projectPendingPlane(accepted, prior, current);
  expect(pending.pendingTaskCount).toBe(0); expect(pending.pendingReportCount).toBe(1);
  expect(pending.graph.reports?.some(r => r.taskId === 'b')).toBe(false);
});

test('radial archived tasks retain original phase membership and receive current captions', () => {
  const prior = graph(); prior.nodes.forEach(node => { node.status = 'archived'; });
  const accepted = layout(prior, 'radial'), current = structuredClone(prior);
  current.phases.forEach(phase => { phase.name = 'Changed original ' + phase.id; phase.goal = 'New original goal'; });
  current.nodes.forEach(node => { node.title = 'Current ' + node.id; });
  const pending = projectPendingPlane(accepted, prior, current);
  const captions = (elements: typeof accepted.elements) => elements.filter(e => e.kind === 'band' || e.kind === 'chip' || e.kind === 'hull')
    .map(e => ({ id: e.id, label: 'label' in e ? e.label : undefined, goal: 'goal' in e ? e.goal : undefined }));
  expect(pending.graph.nodes.map(n => n.title)).toEqual(expect.arrayContaining(['Current a', 'Current b', 'Current c']));
  expect(captions(pending.layout.elements)).toHaveLength(4);
  expect(captions(pending.layout.elements).every(e => e.label?.startsWith('Changed original ') && e.goal === 'New original goal')).toBe(true);
});

test('accepted archive-specific bands never inherit members original phase captions', () => {
  const prior = graph(); prior.nodes.forEach(node => { node.status = 'archived'; });
  const accepted = layout(prior, 'organic');
  // Current Organic omits archive bands. Exercise a supplied accepted spatial
  // band explicitly so this contract is not vacuously tested on an empty list.
  const bandId = 'band:archive:history', laneId = 'archive';
  accepted.elements = accepted.elements.filter(e => e.kind === 'tile').map(e => ({ ...e, bandId, laneId }));
  accepted.elements.push({ kind: 'band', id: bandId, laneId, label: 'Archived history', goal: null, x: 0, y: 0, w: 100, h: 100 },
    { kind: 'chip', id: 'chip:' + bandId, bandId, label: 'Archived history', goal: null, x: 0, y: 0, w: 100, h: 20 });
  const current = structuredClone(prior); current.phases.forEach(p => { p.name = 'Changed ' + p.id; });
  const pending = projectPendingPlane(accepted, prior, current);
  const captions = pending.layout.elements.filter(e => e.kind === 'band' || e.kind === 'chip');
  expect(captions).toHaveLength(2); expect(captions.every(e => e.label === 'Archived history' && e.goal === null)).toBe(true);
  expect(pending.graph.nodes).toHaveLength(3);
});
